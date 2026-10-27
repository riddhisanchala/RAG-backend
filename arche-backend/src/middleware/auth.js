import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { env } from '../config/env.js';
import { toPrincipal } from '../security/acl.js';
import { asyncHandler } from '../utils/http.js';

// New random id on every server start. Tokens carry it, so restarting the backend signs everyone out
// and the next run of the project always asks for a login again.
export const BOOT_ID = crypto.randomBytes(8).toString('hex');

export function signToken(user) {
  return jwt.sign({ sub: String(user._id), username: user.username, role: user.role, boot: BOOT_ID }, env.jwtSecret, { expiresIn: env.jwtExpiresIn });
}

// Verifies the JWT, then loads the user FROM THE DATABASE. Role/department used for authorization
// always come from the database record, never from token claims.
export const requireAuth = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });
  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch {
    return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
  if (payload.boot !== BOOT_ID) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  const user = await User.findById(payload.sub);
  if (!user || !user.isActive) return res.status(401).json({ error: 'Account not found or disabled.' });
  req.user = toPrincipal(user);
  next();
});

export const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user?.role) ? next() : res.status(403).json({ error: 'You do not have permission to do that.' });
