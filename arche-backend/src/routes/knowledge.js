// Knowledge base: upload / list / delete / download documents, re-index, load sample data.
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import KbDocument from '../models/Document.js';
import KbChunk from '../models/Chunk.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../utils/http.js';
import { audit } from '../utils/audit.js';
import { env, BACKEND_ROOT } from '../config/env.js';
import { canAccess } from '../security/acl.js';
import { vectorStore } from '../services/vector/faissStore.js';
import { getDefaults } from '../services/llm/index.js';
import { ALLOWED_EXT, UPLOAD_DIR, deleteDocument, ingestFile, loadSampleData, newStoredName, reindexAll } from '../services/ingestion/ingest.js';

const router = Router();
router.use(requireAuth);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, newStoredName(Buffer.from(file.originalname, 'latin1').toString('utf8'))),
  }),
  limits: { fileSize: env.maxUploadMb * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const ext = path.extname(name).toLowerCase();
    ALLOWED_EXT.has(ext) ? cb(null, true) : cb(new HttpError(415, `Unsupported file type "${ext || 'unknown'}". Allowed: ${[...ALLOWED_EXT].join(', ')}`));
  },
});

const present = (d, principal) => ({
  id: String(d._id),
  title: d.title,
  filename: d.filename,
  kind: d.kind,
  size: d.size,
  department: d.acl.department,
  accessLabel: d.accessLabel,
  uploadedBy: d.uploadedBy,
  status: d.status,
  error: d.error,
  stats: d.stats,
  tableName: d.tableName,
  ownerColumn: d.ownerColumn,
  embeddingModel: d.embeddingModel,
  createdAt: d.createdAt,
  canDelete: principal.role === 'ADMIN' || d.uploadedBy === principal.username,
  canDownload: canAccess(principal, d.acl),
});

function parseRoles(v) {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  try {
    const j = JSON.parse(v);
    if (Array.isArray(j)) return j;
  } catch { /* fall through */ }
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

// Only documents the caller is authorised to see are listed.
router.get('/documents', asyncHandler(async (req, res) => {
  const docs = await KbDocument.find().sort({ createdAt: -1 });
  res.json({ documents: docs.filter((d) => canAccess(req.user, d.acl)).map((d) => present(d, req.user)) });
}));

router.post('/upload', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) return next(new HttpError(400, err.code === 'LIMIT_FILE_SIZE' ? `File is larger than ${env.maxUploadMb} MB.` : err.message));
    next(err);
  });
}, asyncHandler(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Choose a file to upload.');
  const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  try {
    const doc = await ingestFile({
      principal: req.user,
      filePath: req.file.path,
      originalName,
      mimeType: req.file.mimetype,
      size: req.file.size,
      fields: {
        department: req.body.department,
        access: req.body.access,
        allowedRoles: parseRoles(req.body.allowedRoles),
        ownerColumn: req.body.ownerColumn,
        tableName: req.body.tableName,
      },
    });
    await audit(req.user, 'upload', { detail: { id: String(doc._id), filename: originalName, acl: doc.acl, chunks: doc.stats.chunks } });
    res.status(201).json({ document: present(doc, req.user) });
  } catch (e) {
    // Remove the stored file if ingestion failed (a failed Document row is kept so the user can see why).
    fs.rmSync(req.file.path, { force: true });
    throw e;
  }
}));

router.delete('/documents/:id', asyncHandler(async (req, res) => {
  const doc = await KbDocument.findById(req.params.id).catch(() => null);
  if (!doc || !canAccess(req.user, doc.acl) && doc.uploadedBy !== req.user.username) throw new HttpError(404, 'Document not found.');
  if (req.user.role !== 'ADMIN' && doc.uploadedBy !== req.user.username) throw new HttpError(403, 'Only the uploader or an admin can delete this document.');
  await deleteDocument(doc);
  await audit(req.user, 'delete', { detail: { id: req.params.id, filename: doc.filename } });
  res.json({ ok: true });
}));

// Original file (e.g. to open a cited PDF). Whole-file access requires document-level access.
router.get('/documents/:id/file', asyncHandler(async (req, res) => {
  const doc = await KbDocument.findById(req.params.id).catch(() => null);
  if (!doc || !canAccess(req.user, doc.acl)) throw new HttpError(404, 'Document not found.');
  const full = path.join(BACKEND_ROOT, doc.storedPath || '');
  if (!doc.storedPath || !fs.existsSync(full)) throw new HttpError(404, 'The original file is no longer available.');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.filename)}"`);
  if (doc.mimeType) res.type(doc.mimeType);
  fs.createReadStream(full).pipe(res);
}));

router.get('/status', asyncHandler(async (req, res) => {
  const docs = (await KbDocument.find({ status: 'ready' })).filter((d) => canAccess(req.user, d.acl));
  const out = {
    documents: docs.length,
    chunks: docs.reduce((n, d) => n + (d.stats?.chunks || 0), 0),
    byKind: docs.reduce((m, d) => ((m[d.kind] = (m[d.kind] || 0) + 1), m), {}),
  };
  if (req.user.role === 'ADMIN') {
    const d = await getDefaults();
    const sig = vectorStore.signature();
    const active = d.embeddingProvider ? `${d.embeddingProvider}:${d.embeddingModel}` : null;
    out.index = { ...vectorStore.status(), activeEmbeddingModel: active, stale: !!(sig && active && sig.model !== active) };
  }
  res.json(out);
}));

router.post('/reindex', requireRole('ADMIN'), asyncHandler(async (req, res) => {
  const result = await reindexAll();
  await audit(req.user, 'reindex', { detail: result });
  res.json(result);
}));

router.post('/sample-data', requireRole('ADMIN'), asyncHandler(async (req, res) => {
  const results = await loadSampleData(req.user);
  await audit(req.user, 'sample_data', { detail: results });
  res.json({ results });
}));

export default router;
