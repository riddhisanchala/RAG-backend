// HR dashboard API. HR and ADMIN only.
// What HR may do:   see employee accounts, approve/reject EMPLOYEE sign-ups, enable/disable employees, set an employee's department.
// What HR may NOT:  change anyone's role, touch ADMIN / HR accounts, read other people's chats, see passwords,
//                   (document access is still decided by the ACL layer).
import { Router } from 'express';
import User from '../models/User.js';
import Conversation from '../models/Conversation.js';
import KbDocument from '../models/Document.js';
import AuditLog from '../models/AuditLog.js';
import { ROLES, ACCOUNT_STATUS } from '../config/roles.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { canAccess } from '../security/acl.js';
import { asyncHandler, HttpError } from '../utils/http.js';
import { audit } from '../utils/audit.js';
import { decide, listPending } from '../services/accounts/approvals.js';

const router = Router();
router.use(requireAuth, requireRole(ROLES.HR, ROLES.ADMIN));

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

router.get('/overview', asyncHandler(async (req, res) => {
  const [employees, active, pending, docs] = await Promise.all([
    User.countDocuments({ role: ROLES.EMPLOYEE, status: { $ne: ACCOUNT_STATUS.PENDING } }),
    User.countDocuments({ role: ROLES.EMPLOYEE, isActive: true }),
    User.countDocuments({ role: ROLES.EMPLOYEE, status: ACCOUNT_STATUS.PENDING }),
    KbDocument.find().select('acl').lean(),
  ]);
  const visibleDocs = docs.filter((d) => canAccess(req.user, d.acl)).length;
  res.json({ employees, activeEmployees: active, pendingRequests: pending, visibleDocuments: visibleDocs });
}));

router.get('/pending', asyncHandler(async (req, res) => {
  res.json({ requests: await listPending(req.user) });
}));
router.post('/pending/:id/approve', asyncHandler(async (req, res) => { await decide(req.user, req.params.id, true); res.json({ ok: true }); }));
router.post('/pending/:id/reject', asyncHandler(async (req, res) => { await decide(req.user, req.params.id, false); res.json({ ok: true }); }));

// Employee directory: EMPLOYEE accounts only, no secrets, no chat content.
router.get('/employees', asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const filter = { role: ROLES.EMPLOYEE, status: { $ne: ACCOUNT_STATUS.PENDING } };
  if (q) filter.$or = ['username', 'email', 'name', 'department'].map((f) => ({ [f]: new RegExp(esc(q), 'i') }));
  const users = await User.find(filter).select('name username email department isActive status createdAt').sort({ name: 1 }).lean();
  const logins = await AuditLog.aggregate([{ $match: { action: 'login', userId: { $in: users.map((u) => u._id) } } }, { $group: { _id: '$userId', last: { $max: '$createdAt' } } }]);
  const last = Object.fromEntries(logins.map((l) => [String(l._id), l.last]));
  res.json({ employees: users.map((u) => ({ id: String(u._id), name: u.name, username: u.username, email: u.email, department: u.department, isActive: u.isActive, status: u.status, joined: u.createdAt, lastLogin: last[u._id] || null })) });
}));

router.patch('/employees/:id', asyncHandler(async (req, res) => {
  const u = await User.findOne({ _id: req.params.id, role: ROLES.EMPLOYEE }).catch(() => null);
  if (!u) throw new HttpError(404, 'Employee not found.'); // HR cannot even discover other roles through this route
  const { isActive, department } = req.body; // role and password are deliberately NOT editable here
  const changes = {};
  if (isActive !== undefined) { u.isActive = !!isActive; changes.isActive = !!isActive; }
  if (department) { u.department = String(department).trim().slice(0, 60); changes.department = u.department; }
  await u.save();
  await audit(req.user, 'hr_employee_update', { detail: { target: u.username, ...changes } });
  res.json({ ok: true });
}));

// Documents HR can actually read (ACL applied); no cross-department leakage.
router.get('/documents', asyncHandler(async (req, res) => {
  const docs = await KbDocument.find().select('title filename kind accessLabel uploadedBy status acl createdAt').sort({ createdAt: -1 }).lean();
  res.json({ documents: docs.filter((d) => canAccess(req.user, d.acl)).map((d) => ({ id: String(d._id), title: d.title, filename: d.filename, kind: d.kind, department: d.acl.department, accessLabel: d.accessLabel, uploadedBy: d.uploadedBy, status: d.status, createdAt: d.createdAt })) });
}));

router.get('/my-activity', asyncHandler(async (req, res) => {
  const chats = await Conversation.countDocuments({ userId: req.user.id });
  res.json({ chats });
}));

export default router;
