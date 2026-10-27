import { Router } from 'express';
import Conversation from '../models/Conversation.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../utils/http.js';
import { answerQuestion } from '../services/rag/answer.js';
import { allowedChatOptions } from './providers.js';

const router = Router();
router.use(requireAuth);

const summary = (c) => ({ id: String(c._id), title: c.title, updatedAt: c.updatedAt, createdAt: c.createdAt });
const msg = (m) => ({ id: String(m._id), role: m.role, content: m.content, statements: m.statements, citations: m.citations, meta: m.meta, createdAt: m.createdAt });

async function mine(req) {
  const c = await Conversation.findOne({ _id: req.params.id, userId: req.user.id }).catch(() => null);
  if (!c) throw new HttpError(404, 'Chat not found.');
  return c;
}

router.get('/', asyncHandler(async (req, res) => {
  const list = await Conversation.find({ userId: req.user.id }).select('title updatedAt createdAt').sort({ updatedAt: -1 }).limit(200);
  res.json({ chats: list.map(summary) });
}));

router.post('/', asyncHandler(async (req, res) => {
  const c = await Conversation.create({ userId: req.user.id, title: String(req.body.title || 'New chat').slice(0, 80) });
  res.status(201).json({ chat: summary(c) });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const c = await mine(req);
  res.json({ chat: summary(c), messages: c.messages.map(msg) });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const c = await mine(req);
  const title = String(req.body.title || '').trim().slice(0, 80);
  if (!title) throw new HttpError(400, 'Title cannot be empty.');
  c.title = title;
  await c.save();
  res.json({ chat: summary(c) });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const c = await mine(req);
  await c.deleteOne();
  res.json({ ok: true });
}));

router.post('/:id/messages', asyncHandler(async (req, res) => {
  const c = await mine(req);
  const content = String(req.body.content || '').trim();
  if (!content) throw new HttpError(400, 'Type a question first.');
  if (content.length > 2000) throw new HttpError(400, 'Question is too long (max 2000 characters).');

  // Users may only pick models the admin approved.
  let provider;
  let model;
  if (req.body.provider || req.body.model) {
    const { options } = await allowedChatOptions();
    if (!options.some((o) => o.provider === req.body.provider && o.model === req.body.model)) {
      throw new HttpError(400, 'That model is not available. Pick one from the list.');
    }
    provider = req.body.provider;
    model = req.body.model;
  }

  const history = c.messages.map((m) => ({ role: m.role, content: m.content }));
  const result = await answerQuestion({ principal: req.user, question: content, history, provider, model });

  c.messages.push({ role: 'user', content });
  c.messages.push({ role: 'assistant', content: result.content, statements: result.statements, citations: result.citations, meta: result.meta });
  if (c.title === 'New chat') c.title = content.length > 48 ? `${content.slice(0, 48)}…` : content;
  await c.save();

  const n = c.messages.length;
  res.json({ chat: summary(c), userMessage: msg(c.messages[n - 2]), assistantMessage: msg(c.messages[n - 1]) });
}));

export default router;
