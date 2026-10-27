// Approving / rejecting sign-up requests. Shared by the Admin and HR routes so the rules live in one place.
//   • EMPLOYEE requests: HR or ADMIN may decide
//   • HR requests:       ADMIN only
//   • Nobody can decide on their own account
import User from '../../models/User.js';
import { ACCOUNT_STATUS, APPROVERS } from '../../config/roles.js';
import { HttpError } from '../../utils/http.js';
import { audit } from '../../utils/audit.js';

export const canDecide = (actor, target) => (APPROVERS[target.role] || []).includes(actor.role);

export async function listPending(actor) {
  const roles = Object.keys(APPROVERS).filter((r) => APPROVERS[r].includes(actor.role));
  if (!roles.length) return [];
  const users = await User.find({ status: ACCOUNT_STATUS.PENDING, role: { $in: roles } }).select('-passwordHash').sort({ createdAt: 1 }).lean();
  return users.map((u) => ({ id: String(u._id), name: u.name, email: u.email, username: u.username, requestedRole: u.role, department: u.department, requestedAt: u.createdAt }));
}

export async function decide(actor, userId, approve) {
  const target = await User.findById(userId).catch(() => null);
  if (!target || target.status !== ACCOUNT_STATUS.PENDING) throw new HttpError(404, 'No pending request found.');
  if (String(target._id) === String(actor.id)) throw new HttpError(400, "You can't decide on your own request.");
  if (!canDecide(actor, target)) throw new HttpError(403, `Only ${APPROVERS[target.role]?.join(' / ') || 'an administrator'} can decide ${target.role} requests.`);

  target.status = approve ? ACCOUNT_STATUS.ACTIVE : ACCOUNT_STATUS.REJECTED;
  target.isActive = approve;
  target.decidedBy = actor.username;
  await target.save();
  await audit(actor, approve ? 'signup_approved' : 'signup_rejected', { detail: { target: target.username, role: target.role } });
}
