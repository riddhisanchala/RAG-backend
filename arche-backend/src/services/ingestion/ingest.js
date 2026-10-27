// Ingestion orchestrator: file → text/rows → chunks (+ ACL) → embeddings → FAISS + MongoDB.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import KbDocument from '../../models/Document.js';
import KbChunk from '../../models/Chunk.js';
import { env, BACKEND_ROOT } from '../../config/env.js';
import { ROLE_DEPARTMENTS } from '../../config/roles.js';
import { buildAcl, normUser } from '../../security/acl.js';
import { embed, getDefaults } from '../llm/index.js';
import { vectorStore } from '../vector/faissStore.js';
import { HttpError } from '../../utils/http.js';
import { chunkText } from './chunker.js';
import { extractPdfPages } from './pdf.js';
import { ocrImage } from './ocr.js';
import { readRows, rowToText, tableSummaryText } from './records.js';

export const UPLOAD_DIR = path.join(env.dataDir, 'uploads');
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.webp']);
const TEXT_EXT = new Set(['.txt', '.md']);
export const ALLOWED_EXT = new Set(['.pdf', '.csv', '.json', ...IMAGE_EXT, ...TEXT_EXT]);

export function kindFromExt(ext) {
  if (ext === '.pdf') return 'pdf';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === '.csv' || ext === '.json') return 'records';
  if (TEXT_EXT.has(ext)) return 'text';
  return null;
}

export const embedTextFor = (src, text) =>
  src.kind === 'record' ? text : `${src.title}${src.page ? ` — page ${src.page}` : ''}\n${text}`;

const rolesForDepartment = (dept) => Object.keys(ROLE_DEPARTMENTS).filter((r) => ROLE_DEPARTMENTS[r].includes(dept));

async function assertEmbeddingReady() {
  const d = await getDefaults();
  if (!d.embeddingProvider || !d.embeddingModel) {
    throw new HttpError(400, 'Configure an embedding model first: Settings → LLM Providers → Default models.');
  }
  return d;
}

/** Turn an extracted file into [{ text, source, acl }] units. */
async function extractUnits({ kind, filePath, ext, title, filename, baseAcl, fields, doc }) {
  const units = [];
  if (kind === 'pdf') {
    const pages = await extractPdfPages(filePath);
    doc.stats.pages = pages.length;
    doc.stats.emptyPages = pages.filter((p) => !p.text).length;
    for (const p of pages) {
      for (const c of chunkText(p.text)) {
        units.push({ text: c.text, acl: baseAcl, source: { kind: 'pdf', filename, title, page: p.page, charStart: c.charStart, charEnd: c.charEnd } });
      }
    }
    if (!units.length) throw new HttpError(422, 'No extractable text found. If this is a scanned PDF, upload its pages as images so OCR can read them.');
  } else if (kind === 'image') {
    const { text, confidence } = await ocrImage(filePath);
    doc.stats.ocrConfidence = confidence;
    doc.stats.pages = 1;
    for (const c of chunkText(text)) {
      units.push({ text: c.text, acl: baseAcl, source: { kind: 'image', filename, title, page: 1, charStart: c.charStart, charEnd: c.charEnd, ocrConfidence: confidence } });
    }
    if (!units.length) throw new HttpError(422, 'OCR found no readable text in this image.');
  } else if (kind === 'text') {
    const raw = fs.readFileSync(filePath, 'utf8');
    const pageText = raw.replace(/\s+/g, ' ').trim();
    doc.stats.pages = 1;
    for (const c of chunkText(pageText)) {
      units.push({ text: c.text, acl: baseAcl, source: { kind: 'text', filename, title, page: 1, charStart: c.charStart, charEnd: c.charEnd } });
    }
    if (!units.length) throw new HttpError(422, 'The file is empty.');
  } else if (kind === 'records') {
    let rows;
    try {
      rows = readRows(filePath, ext);
    } catch (e) {
      throw new HttpError(422, `Could not read records: ${e.message}`);
    }
    if (!rows.length) throw new HttpError(422, 'No rows found.');
    if (rows.length > 5000) throw new HttpError(422, 'Too many rows (max 5000 per file).');
    const table = (fields.tableName || path.basename(filename, ext)).trim() || 'records';
    const columns = Object.keys(rows[0]);
    // match the owner column ignoring case/spaces ("Employee_Username " still works)
    const ownerCol = fields.ownerColumn?.trim() ? columns.find((c) => c.toLowerCase() === fields.ownerColumn.trim().toLowerCase()) : undefined;
    if (fields.ownerColumn?.trim() && !ownerCol) throw new HttpError(422, `Owner column "${fields.ownerColumn.trim()}" not found. Columns: ${columns.join(', ')}`);
    doc.stats.rows = rows.length;
    doc.tableName = table;
    doc.ownerColumn = ownerCol || undefined;
    const keyCol = columns[0];
    // table overview chunk (same access rules as the table itself, minus per-row owners)
    units.push({ text: tableSummaryText(table, rows), acl: baseAcl, source: { kind: 'record', filename, title, table, rowIndex: 0, rowKey: 'overview' } });
    rows.forEach((row, i) => {
      const rowIndex = i + 1;
      // Row-level ACL: the row's owner (e.g. employee_username) may always read their own row.
      const acl = { ...baseAcl, allowedUsers: [...baseAcl.allowedUsers] };
      if (ownerCol && fields.access !== 'private') {
        const owner = normUser(row[ownerCol]);
        if (owner) acl.allowedUsers.push(owner);
        // keep department staff able to read all rows unless the uploader chose specific roles
        if (fields.access === 'department') acl.allowedRoles = rolesForDepartment(baseAcl.department);
      }
      units.push({
        text: rowToText(table, rowIndex, row),
        acl,
        source: { kind: 'record', filename, title, table, rowIndex, rowKey: String(row[keyCol] ?? '') },
      });
    });
  }
  return units;
}

/**
 * Ingest a file that is ALREADY on disk inside UPLOAD_DIR.
 * fields: { department, access, allowedRoles, ownerColumn, tableName }
 */
export async function ingestFile({ principal, filePath, originalName, mimeType, size, fields }) {
  const ext = path.extname(originalName).toLowerCase();
  const kind = kindFromExt(ext);
  if (!kind) throw new HttpError(415, `Unsupported file type "${ext}".`);

  const { acl: baseAcl, label } = buildAcl(principal, {
    department: fields.department || 'GENERAL',
    access: fields.access || 'department',
    allowedRoles: fields.allowedRoles || [],
  });
  const defaults = await assertEmbeddingReady();

  const title = path.basename(originalName, ext);
  const doc = await KbDocument.create({
    title,
    filename: originalName,
    kind,
    mimeType,
    size,
    storedPath: path.relative(BACKEND_ROOT, filePath),
    acl: baseAcl,
    accessLabel: label,
    uploadedBy: principal.username,
    status: 'processing',
    stats: {},
  });

  try {
    const units = await extractUnits({ kind, filePath, ext, title, filename: originalName, baseAcl, fields: { ...fields, access: fields.access || 'department' }, doc });

    const { vectors, model, dim } = await embed(units.map((u) => embedTextFor(u.source, u.text)), 'document');

    const chunkDocs = await KbChunk.insertMany(
      units.map((u) => ({ documentId: doc._id, text: u.text, acl: u.acl, source: u.source }))
    );
    await vectorStore.add(
      chunkDocs.map((c, i) => ({ chunkId: c._id, documentId: doc._id, acl: units[i].acl, vector: vectors[i] })),
      { dim, model }
    );

    doc.stats.chunks = chunkDocs.length;
    doc.embeddingModel = model;
    doc.status = 'ready';
    await doc.save();
    return doc;
  } catch (e) {
    // roll back everything this ingestion created
    await vectorStore.removeDocument(doc._id).catch(() => {});
    await KbChunk.deleteMany({ documentId: doc._id });
    doc.status = 'failed';
    doc.error = e.message?.slice(0, 500);
    await doc.save().catch(() => {});
    throw e;
  }
}

export async function deleteDocument(doc) {
  await vectorStore.removeDocument(doc._id);
  await KbChunk.deleteMany({ documentId: doc._id });
  if (doc.storedPath) fs.rmSync(path.join(BACKEND_ROOT, doc.storedPath), { force: true });
  await doc.deleteOne();
}

/** Re-embed every stored chunk with the CURRENT embedding model and rebuild all FAISS partitions. */
export async function reindexAll() {
  await assertEmbeddingReady();
  await vectorStore.reset();
  const BATCH = 128;
  let total = 0;
  let model = '';
  const cursor = KbChunk.find({}).sort({ _id: 1 }).lean().cursor();
  let batch = [];

  const flush = async () => {
    if (!batch.length) return;
    const emb = await embed(batch.map((c) => embedTextFor(c.source, c.text)), 'document');
    model = emb.model;
    await vectorStore.add(
      batch.map((c, i) => ({ chunkId: c._id, documentId: c.documentId, acl: c.acl, vector: emb.vectors[i] })),
      { dim: emb.dim, model: emb.model }
    );
    total += batch.length;
    batch = [];
  };

  for await (const c of cursor) {
    batch.push(c);
    if (batch.length >= BATCH) await flush();
  }
  await flush();
  if (model) await KbDocument.updateMany({ status: 'ready' }, { embeddingModel: model });
  return { chunks: total, model };
}

export function newStoredName(originalName) {
  const safe = path.basename(originalName).replace(/[^\w.\- ]+/g, '_');
  return `${crypto.randomBytes(8).toString('hex')}-${safe}`;
}

// ── sample data ────────────────────────────────────────────────────────────────
const SAMPLE_DIR = path.join(BACKEND_ROOT, 'sample-data');
const SAMPLES = [
  { file: 'company_handbook.pdf', mime: 'application/pdf', fields: { department: 'GENERAL', access: 'department' } },
  { file: 'office_notice.png', mime: 'image/png', fields: { department: 'GENERAL', access: 'department' } },
  { file: 'hr_confidential_policy.pdf', mime: 'application/pdf', fields: { department: 'HR', access: 'department' } },
  { file: 'employees.csv', mime: 'text/csv', fields: { department: 'HR', access: 'department', ownerColumn: 'employee_username', tableName: 'employees' } },
  { file: 'payroll.csv', mime: 'text/csv', fields: { department: 'HR', access: 'department', ownerColumn: 'employee_username', tableName: 'payroll' } },
];

export async function loadSampleData(principal, onProgress = () => {}) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const results = [];
  for (const s of SAMPLES) {
    const existing = await KbDocument.findOne({ filename: s.file, uploadedBy: principal.username, status: 'ready' });
    if (existing) {
      results.push({ file: s.file, status: 'skipped (already loaded)' });
      continue;
    }
    const src = path.join(SAMPLE_DIR, s.file);
    const dest = path.join(UPLOAD_DIR, newStoredName(s.file));
    fs.copyFileSync(src, dest);
    try {
      onProgress(s.file);
      const doc = await ingestFile({ principal, filePath: dest, originalName: s.file, mimeType: s.mime, size: fs.statSync(dest).size, fields: s.fields });
      results.push({ file: s.file, status: 'loaded', chunks: doc.stats.chunks });
    } catch (e) {
      fs.rmSync(dest, { force: true });
      results.push({ file: s.file, status: 'failed', error: e.message });
      if (e.status === 400 || e.status === 401 || e.status === 409) break; // config problems affect every file
    }
  }
  return results;
}
