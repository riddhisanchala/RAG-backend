// Admin panel API: stats, users, chat monitoring, documents, audit trail. ADMIN only.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import AuditLog from '../models/AuditLog.js';
import User from '../models/User.js';
import Conversation from '../models/Conversation.js';
import Document from '../models/Document.js';
import KbChunk from '../models/Chunk.js';
import fs from 'node:fs';
import multer from 'multer';
import { importUsersFromCsv, TEMPLATE } from '../services/accounts/importUsers.js';
import path from 'node:path';
import { BACKEND_ROOT } from '../config/env.js';
import { deleteDocument } from '../services/ingestion/ingest.js';
import { ROLES } from '../config/roles.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../utils/http.js';
import { audit } from '../utils/audit.js';
import { decide, listPending } from '../services/accounts/approvals.js';

const router = Router();
router.use(requireAuth, requireRole('ADMIN'));

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const page = (req, max = 100) => ({ limit: Math.min(Number(req.query.limit) || 25, max), skip: Math.max(Number(req.query.skip) || 0, 0) });

router.get('/stats', asyncHandler(async (req, res) => {
  const day = new Date(Date.now() - 864e5);
  const week = new Date(Date.now() - 7 * 864e5);
  const [users, active, docs, chats, msgs, queries24, logins24, failed24, byAction, perDay, byRole, pendingCount] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ isActive: true }),
    Document.countDocuments(),
    Conversation.countDocuments(),
    Conversation.aggregate([{ $project: { n: { $size: '$messages' } } }, { $group: { _id: null, n: { $sum: '$n' } } }]),
    AuditLog.countDocuments({ action: 'query', createdAt: { $gte: day } }),
    AuditLog.countDocuments({ action: 'login', createdAt: { $gte: day } }),
    AuditLog.countDocuments({ action: 'login_failed', createdAt: { $gte: day } }),
    AuditLog.aggregate([{ $group: { _id: '$action', n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
    AuditLog.aggregate([
      { $match: { createdAt: { $gte: week } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, n: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    User.aggregate([{ $group: { _id: '$role', n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
    User.countDocuments({ status: 'PENDING' }),
  ]);
  res.json({ users, activeUsers: active, documents: docs, chats, messages: msgs[0]?.n || 0, queries24, logins24, failed24, byAction, perDay, byRole, pendingCount });
}));

// Sign-up requests (HR + EMPLOYEE). Admin can decide both kinds.
router.get('/pending', asyncHandler(async (req, res) => res.json({ requests: await listPending(req.user) })));
router.post('/pending/:id/approve', asyncHandler(async (req, res) => { await decide(req.user, req.params.id, true); res.json({ ok: true }); }));
router.post('/pending/:id/reject', asyncHandler(async (req, res) => { await decide(req.user, req.params.id, false); res.json({ ok: true }); }));

router.get('/users', asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const filter = q ? { $or: ['username', 'email', 'name'].map((f) => ({ [f]: new RegExp(esc(q), 'i') })) } : {};
  const users = await User.find(filter).select('-passwordHash').sort({ createdAt: -1 }).lean();
  const [chatCounts, lastLogins] = await Promise.all([
    Conversation.aggregate([{ $group: { _id: '$userId', chats: { $sum: 1 }, messages: { $sum: { $size: '$messages' } } } }]),
    AuditLog.aggregate([{ $match: { action: 'login' } }, { $group: { _id: '$userId', last: { $max: '$createdAt' } } }]),
  ]);
  const c = Object.fromEntries(chatCounts.map((x) => [String(x._id), x]));
  const l = Object.fromEntries(lastLogins.map((x) => [String(x._id), x.last]));
  res.json({ users: users.map((u) => ({ ...u, id: String(u._id), chats: c[u._id]?.chats || 0, messages: c[u._id]?.messages || 0, lastLogin: l[u._id] || null })) });
}));

router.post('/users', asyncHandler(async (req, res) => {
  const { name = '', email = '', password = '', role = 'EMPLOYEE', department = 'General' } = req.body; // admin-created accounts are active immediately
  if (String(name).trim().length < 2) throw new HttpError(400, 'Enter a name.');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'Enter a valid email.');
  if (String(password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  if (!Object.values(ROLES).includes(role)) throw new HttpError(400, 'Invalid role.');
  const e = String(email).trim().toLowerCase();
  if (await User.findOne({ email: e })) throw new HttpError(409, 'Email already in use.');
  let username = e.split('@')[0].replace(/[^a-z0-9._-]/g, '').slice(0, 30) || 'user';
  if (await User.findOne({ username })) username += Math.floor(1000 + Math.random() * 9000);
  const u = await User.create({ username, email: e, name: String(name).trim(), passwordHash: await bcrypt.hash(String(password), 10), role, department });
  await audit(req.user, 'admin_user_create', { detail: { target: u.username, role } });
  res.status(201).json({ id: String(u._id) });
}));

// Bulk create accounts from a CSV (multipart field "file"). See services/accounts/importUsers.js for columns.
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
router.get('/users/import-template', (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="users-template.csv"');
  res.send(TEMPLATE);
});
router.post('/users/import', (req, res, next) => csvUpload.single('file')(req, res, (e) => (e ? next(new HttpError(400, e.message)) : next())), asyncHandler(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Choose a CSV file.');
  if (!/\.csv$/i.test(req.file.originalname)) throw new HttpError(415, 'Only .csv files are accepted.');
  const result = await importUsersFromCsv(req.file.buffer.toString('utf8'));
  await audit(req.user, 'admin_user_import', { detail: { created: result.created.length, skipped: result.skipped.length, failed: result.failed.length } });
  res.json(result);
}));

router.patch('/users/:id', asyncHandler(async (req, res) => {
  const u = await User.findById(req.params.id);
  if (!u) throw new HttpError(404, 'User not found.');
  const self = String(u._id) === String(req.user.id);
  const { role, isActive, department, password } = req.body;
  if (self && (isActive === false || (role && role !== 'ADMIN'))) throw new HttpError(400, "You can't demote or disable yourself.");
  const changes = {};
  if (role !== undefined) { if (!Object.values(ROLES).includes(role)) throw new HttpError(400, 'Invalid role.'); u.role = role; changes.role = role; }
  if (isActive !== undefined) { u.isActive = !!isActive; if (u.isActive) u.status = 'ACTIVE'; changes.isActive = !!isActive; }
  if (department) { u.department = String(department); changes.department = u.department; }
  if (password) { if (String(password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters.'); u.passwordHash = await bcrypt.hash(String(password), 10); changes.passwordReset = true; }
  await u.save();
  await audit(req.user, 'admin_user_update', { detail: { target: u.username, ...changes } });
  res.json({ ok: true });
}));

router.get('/chats', asyncHandler(async (req, res) => {
  const { limit, skip } = page(req);
  const filter = {};
  if (req.query.userId) filter.userId = req.query.userId;
  if (req.query.q) filter['messages.content'] = new RegExp(esc(req.query.q), 'i');
  const [rows, total] = await Promise.all([
    Conversation.find(filter).select('title userId updatedAt createdAt messages.role').populate('userId', 'username name').sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
    Conversation.countDocuments(filter),
  ]);
  res.json({ total, chats: rows.map((c) => ({ id: String(c._id), title: c.title, user: c.userId, messages: c.messages.length, updatedAt: c.updatedAt, createdAt: c.createdAt })) });
}));

router.get('/chats/:id', asyncHandler(async (req, res) => {
  const c = await Conversation.findById(req.params.id).populate('userId', 'username name').lean();
  if (!c) throw new HttpError(404, 'Chat not found.');
  await audit(req.user, 'admin_view_chat', { detail: { chatId: req.params.id, owner: c.userId?.username } });
  res.json({ chat: { id: String(c._id), title: c.title, user: c.userId, messages: c.messages.map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt, citations: m.citations?.length || 0 })) } });
}));

router.delete('/chats/:id', asyncHandler(async (req, res) => {
  const c = await Conversation.findByIdAndDelete(req.params.id);
  if (!c) throw new HttpError(404, 'Chat not found.');
  await audit(req.user, 'admin_delete_chat', { detail: { chatId: req.params.id, title: c.title } });
  res.json({ ok: true });
}));

// ── All uploaded data, whoever uploaded it (employees, HR, users, admins) ──────────────────────────
// Admin is allowed to read everything, including other people's private uploads. Opening a file or its
// contents is written to the audit log ("admin_view_document") so access stays traceable.
router.get('/documents', asyncHandler(async (req, res) => {
  const f = {};
  if (req.query.department) f['acl.department'] = String(req.query.department);
  if (req.query.kind) f.kind = String(req.query.kind);
  if (req.query.uploader) f.uploadedBy = String(req.query.uploader).toLowerCase();
  if (req.query.q) f.$or = ['title', 'filename'].map((k) => ({ [k]: new RegExp(esc(req.query.q), 'i') }));
  const docs = await Document.find(f).select('title filename kind size accessLabel uploadedBy status error stats acl tableName createdAt').sort({ createdAt: -1 }).lean();
  const people = await User.find({ username: { $in: [...new Set(docs.map((d) => d.uploadedBy))] } }).select('username name role').lean();
  const by = Object.fromEntries(people.map((u) => [u.username, u]));
  let rows = docs.map((d) => ({
    ...d,
    id: String(d._id),
    department: d.acl?.department,
    private: (d.acl?.allowedUsers?.length || 0) > 0 && !(d.acl?.allowedRoles?.length),
    uploaderName: by[d.uploadedBy]?.name || d.uploadedBy,
    uploaderRole: by[d.uploadedBy]?.role || '—',
  }));
  if (req.query.role) rows = rows.filter((r) => r.uploaderRole === String(req.query.role).toUpperCase());
  const uploaders = [...new Set(docs.map((d) => d.uploadedBy))].sort();
  res.json({ documents: rows, uploaders });
}));

// Open the original file (PDF / image / csv ...).
router.get('/documents/:id/file', asyncHandler(async (req, res) => {
  const doc = await Document.findById(req.params.id).catch(() => null);
  if (!doc) throw new HttpError(404, 'Document not found.');
  const full = path.join(BACKEND_ROOT, doc.storedPath || '');
  if (!doc.storedPath || !fs.existsSync(full)) throw new HttpError(404, 'The original file is no longer available.');
  await audit(req.user, 'admin_view_document', { detail: { id: String(doc._id), filename: doc.filename, owner: doc.uploadedBy, mode: 'file' } });
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.filename)}"`);
  if (doc.mimeType) res.type(doc.mimeType);
  fs.createReadStream(full).pipe(res);
}));

// Extracted text of the document (PDF passages, OCR text, table rows), paged.
router.get('/documents/:id/content', asyncHandler(async (req, res) => {
  const doc = await Document.findById(req.params.id).catch(() => null);
  if (!doc) throw new HttpError(404, 'Document not found.');
  const { limit, skip } = page(req, 200);
  const [chunks, total] = await Promise.all([
    KbChunk.find({ documentId: doc._id }).sort({ 'source.page': 1, 'source.rowIndex': 1, _id: 1 }).skip(skip).limit(limit).lean(),
    KbChunk.countDocuments({ documentId: doc._id }),
  ]);
  await audit(req.user, 'admin_view_document', { detail: { id: String(doc._id), filename: doc.filename, owner: doc.uploadedBy, mode: 'content', skip } });
  res.json({
    document: { id: String(doc._id), title: doc.title, filename: doc.filename, uploadedBy: doc.uploadedBy, accessLabel: doc.accessLabel, acl: doc.acl },
    total,
    chunks: chunks.map((c) => ({ id: String(c._id), text: c.text, page: c.source?.page, table: c.source?.table, row: c.source?.rowIndex, confidence: c.source?.ocrConfidence, acl: c.acl })),
  });
}));

router.delete('/documents/:id', asyncHandler(async (req, res) => {
  const doc = await Document.findById(req.params.id).catch(() => null);
  if (!doc) throw new HttpError(404, 'Document not found.');
  await deleteDocument(doc);
  await audit(req.user, 'admin_delete_document', { detail: { id: req.params.id, filename: doc.filename, owner: doc.uploadedBy } });
  res.json({ ok: true });
}));

router.get('/audit', asyncHandler(async (req, res) => {
  const { limit, skip } = page(req, 500);
  const f = {};
  if (req.query.action) f.action = String(req.query.action);
  if (req.query.username) f.username = new RegExp(esc(req.query.username), 'i');
  if (req.query.q) f.query = new RegExp(esc(req.query.q), 'i');
  if (req.query.from || req.query.to) f.createdAt = { ...(req.query.from && { $gte: new Date(req.query.from) }), ...(req.query.to && { $lte: new Date(req.query.to) }) };
  const [logs, total] = await Promise.all([AuditLog.find(f).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(), AuditLog.countDocuments(f)]);
  res.json({ total, logs });
}));

export default router;
