// Employee dashboard API. Everything here is scoped to the signed-in person.
// EMPLOYEE (and ADMIN/HR, for convenience) may call it.
import { Router } from 'express';
import Conversation from '../models/Conversation.js';
import KbDocument from '../models/Document.js';
import User from '../models/User.js';
import { ROLES } from '../config/roles.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { canAccess } from '../security/acl.js';
import { asyncHandler } from '../utils/http.js';

const router = Router();
router.use(requireAuth, requireRole(ROLES.EMPLOYEE, ROLES.HR, ROLES.ADMIN));

router.get('/overview', asyncHandler(async (req, res) => {
  const [me, chats, recent, docs] = await Promise.all([
    User.findById(req.user.id).select('name username email department createdAt').lean(),
    Conversation.countDocuments({ userId: req.user.id }),
    Conversation.find({ userId: req.user.id }).select('title updatedAt').sort({ updatedAt: -1 }).limit(5).lean(),
    KbDocument.find().select('title filename kind accessLabel uploadedBy status acl createdAt').sort({ createdAt: -1 }).lean(),
  ]);
  const readable = docs.filter((d) => canAccess(req.user, d.acl)); // same ACL as retrieval: you only see what you may read
  const mine = readable.filter((d) => d.uploadedBy === req.user.username);
  res.json({
    profile: { name: me.name, username: me.username, email: me.email, department: me.department, joined: me.createdAt },
    stats: { chats, readableDocuments: readable.length, myUploads: mine.length },
    recentChats: recent.map((c) => ({ id: String(c._id), title: c.title, updatedAt: c.updatedAt })),
    documents: readable.slice(0, 8).map((d) => ({ id: String(d._id), title: d.title, kind: d.kind, accessLabel: d.accessLabel, createdAt: d.createdAt })),
  });
}));

export default router;
