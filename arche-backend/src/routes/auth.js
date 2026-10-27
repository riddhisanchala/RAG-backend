import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import User from '../models/User.js';
import { requireAuth, signToken } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../utils/http.js';
import { audit } from '../utils/audit.js';
import { toPrincipal } from '../security/acl.js';
import crypto from 'node:crypto';
import { ROLES, SELF_SIGNUP_ROLES, APPROVAL_REQUIRED, ACCOUNT_STATUS } from '../config/roles.js';
import { env } from '../config/env.js';

const router = Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 50, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Try again in a few minutes.' } });

const publicUser = (u) => ({ id: String(u._id), username: u.username, email: u.email || '', name: u.name, role: u.role, department: u.department, status: u.status || 'ACTIVE' });
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);


// Explains why a (correctly authenticated) account may not sign in yet. Shared by password and Google sign-in.
async function assertCanSignIn(user, identifier, req) {
  const deny = async (reason, status, message) => {
    await audit(toPrincipal(user), 'login_failed', { detail: { identifier, ip: req.ip, reason } });
    throw new HttpError(status, message);
  };
  if (user.status === ACCOUNT_STATUS.PENDING) await deny('pending_approval', 403, 'Your account is waiting for approval. You will be able to sign in once it is approved.');
  if (user.status === ACCOUNT_STATUS.REJECTED) await deny('rejected', 403, 'Your sign-up request was declined. Please contact your administrator.');
  if (!user.isActive) await deny('inactive', 403, 'This account is disabled. Please contact your administrator.');
}

const DEPARTMENT_FOR = { EMPLOYEE: 'General', HR: 'HR' };
const approverText = (role) => (role === ROLES.EMPLOYEE ? 'HR or an administrator' : 'an administrator');
const pendingMessage = (role) => `Request received. Your ${role} account will be active once ${approverText(role)} approves it.`;

async function uniqueUsername(email) {
  let username = email.split('@')[0].replace(/[^a-z0-9._-]/g, '').slice(0, 30) || 'user';
  if (await User.findOne({ username })) username = `${username}${Math.floor(1000 + Math.random() * 9000)}`;
  return username;
}

router.post('/login', limiter, asyncHandler(async (req, res) => {
  const identifier = String(req.body.identifier ?? req.body.username ?? req.body.email ?? '').trim().toLowerCase();
  const password = String(req.body.password ?? '');
  if (!identifier || !password) throw new HttpError(400, 'Enter your username/email and password.');

  // Two plain lookups (username first, then email) instead of one $or query: simpler for MongoDB to
  // run and it still works if one of the indexes is missing or old. A database failure is reported as
  // 503, not as a misleading "wrong password".
  let user;
  try {
    user = await User.findOne({ username: identifier });
    if (!user && identifier.includes('@')) user = await User.findOne({ email: identifier });
  } catch (e) {
    console.error('❌ Login lookup failed:', e.message);
    throw new HttpError(503, 'The database is not reachable right now. Please try again in a moment.');
  }
  const ok = await bcrypt.compare(password, user?.passwordHash || DUMMY_HASH); // constant-ish time
  if (!user || !ok) {
    await audit(user ? toPrincipal(user) : { username: identifier }, 'login_failed', { detail: { identifier, ip: req.ip } });
    throw new HttpError(401, 'Invalid username/email or password.');
  }

  await assertCanSignIn(user, identifier, req);

  // Optional "sign in as" portal (Employee / HR / Admin): it must match the account's real role.
  // It only guards against logging into the wrong dashboard by mistake; it never grants anything.
  const portal = String(req.body.portal || '').toUpperCase();
  if (portal && portal !== user.role) {
    await audit(toPrincipal(user), 'login_failed', { detail: { identifier, ip: req.ip, reason: 'wrong_portal', portal } });
    throw new HttpError(403, `This account is not registered as ${portal}. Choose the correct sign-in type.`);
  }

  await audit(toPrincipal(user), 'login', { detail: { ip: req.ip } });
  res.json({ token: signToken(user), user: publicUser(user) });
}));

// Self sign-up. The visitor picks Employee or HR. None of these is granted automatically:
//   EMPLOYEE        → PENDING until an HR user or an admin approves
//   HR              → PENDING until an admin approves
//   ADMIN           → cannot be requested here at all (an admin creates those accounts)
router.post('/signup', limiter, asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const accountType = String(req.body.accountType || '').toUpperCase();
  if (!accountType) throw new HttpError(400, 'Choose an account type: Employee or HR.');
  if (name.length < 2) throw new HttpError(400, 'Please enter your name.');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  if (!SELF_SIGNUP_ROLES.includes(accountType)) throw new HttpError(403, 'That account type cannot be created from the sign-up page.');
  if (await User.findOne({ email })) throw new HttpError(409, 'An account with this email already exists.');

  const needsApproval = APPROVAL_REQUIRED.includes(accountType);
  const user = await User.create({
    username: await uniqueUsername(email), email, name,
    passwordHash: await bcrypt.hash(password, 10),
    role: accountType,
    department: DEPARTMENT_FOR[accountType],
    status: needsApproval ? ACCOUNT_STATUS.PENDING : ACCOUNT_STATUS.ACTIVE,
    isActive: !needsApproval,
  });
  await audit(toPrincipal(user), 'signup', { detail: { email, requestedRole: accountType, pending: needsApproval } });

  if (needsApproval) {
    // No token: the account cannot be used until it is approved.
    return res.status(202).json({ pending: true, message: pendingMessage(accountType) });
  }
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
}));

// ── Sign in / sign up with Google ────────────────────────────────────────────
// The browser gets a Google ID token (Google Identity Services) and sends it here. We never trust the client:
// the token is verified with Google, must be issued for OUR client id, and the email must be verified.
//   • existing account  → signed in (same approval / disabled rules as a password login)
//   • no account yet    → only created when the visitor came from the Sign-up tab and chose a role
//                         (Employee / HR); it then waits for approval exactly like a password sign-up.
async function verifyGoogleToken(idToken) {
  let info;
  try {
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!r.ok) throw new Error(`status ${r.status}`);
    info = await r.json();
  } catch (e) {
    throw new HttpError(401, 'Google sign-in could not be verified. Please try again.');
  }
  const issuerOk = ['accounts.google.com', 'https://accounts.google.com'].includes(info.iss);
  if (info.aud !== env.googleClientId || !issuerOk || String(info.email_verified) !== 'true' || !info.email || Number(info.exp) * 1000 < Date.now()) {
    throw new HttpError(401, 'Google sign-in could not be verified. Please try again.');
  }
  return { email: String(info.email).toLowerCase(), name: String(info.name || '').trim() || String(info.email).split('@')[0] };
}

router.get('/google/config', (req, res) => res.json({ enabled: !!env.googleClientId, clientId: env.googleClientId || null }));

router.post('/google', limiter, asyncHandler(async (req, res) => {
  if (!env.googleClientId) throw new HttpError(501, 'Google sign-in is not configured on this server (GOOGLE_CLIENT_ID is missing).');
  const credential = String(req.body.credential || '');
  if (!credential) throw new HttpError(400, 'Missing Google credential.');
  const accountType = String(req.body.accountType || '').toUpperCase(); // only sent from the Sign-up tab
  const { email, name } = await verifyGoogleToken(credential);

  let user = await User.findOne({ email });
  if (user) {
    await assertCanSignIn(user, email, req);
    await audit(toPrincipal(user), 'login', { detail: { ip: req.ip, via: 'google' } });
    return res.json({ token: signToken(user), user: publicUser(user) });
  }

  if (!accountType) throw new HttpError(404, 'No Arche account exists for this Google email yet. Open the Sign up tab, choose Employee or HR, and continue with Google.');
  if (!SELF_SIGNUP_ROLES.includes(accountType)) throw new HttpError(403, 'That account type cannot be created from the sign-up page.');

  user = await User.create({
    username: await uniqueUsername(email), email, name,
    // Google accounts have no password; this random hash can never be guessed or used to sign in.
    passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
    role: accountType,
    department: DEPARTMENT_FOR[accountType],
    status: ACCOUNT_STATUS.PENDING,
    isActive: false,
  });
  await audit(toPrincipal(user), 'signup', { detail: { email, requestedRole: accountType, pending: true, via: 'google' } });
  res.status(202).json({ pending: true, message: pendingMessage(accountType) });
}));

router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);
  res.json({ user: publicUser(user) });
}));

router.post('/change-password', requireAuth, asyncHandler(async (req, res) => {
  const { currentPassword = '', newPassword = '' } = req.body;
  if (String(newPassword).length < 8) throw new HttpError(400, 'New password must be at least 8 characters.');
  const user = await User.findById(req.user.id);
  if (!(await bcrypt.compare(String(currentPassword), user.passwordHash))) throw new HttpError(401, 'Current password is incorrect.');
  user.passwordHash = await bcrypt.hash(String(newPassword), 10);
  await user.save();
  res.json({ ok: true });
}));

export default router;
