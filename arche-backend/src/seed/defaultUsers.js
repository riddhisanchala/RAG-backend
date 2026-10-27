// Default accounts. ⚠️ Development defaults — change/remove them before any real deployment.
import bcrypt from 'bcryptjs';
import User from '../models/User.js';

export const DEFAULT_USERS = [
  { username: 'admin', name: 'Riddhi Admin', role: 'ADMIN', department: 'Management', password: 'admin' },
  { username: 'hr01', name: 'Harry HR', role: 'HR', department: 'HR', password: 'Demo@123' },
  { username: 'employee01', name: 'Eric Employee', role: 'EMPLOYEE', department: 'General', password: 'Demo@123' },
];

/** reset=false → only create missing users. reset=true → also reset password/role of existing ones. */
export async function ensureDefaultUsers({ reset = false } = {}) {
  const out = [];
  for (const u of DEFAULT_USERS) {
    const { password, ...rest } = u;
    try {
      const existing = await User.findOne({ username: u.username });
      if (!existing) {
        await User.create({ ...rest, passwordHash: await bcrypt.hash(password, 10) });
        out.push(`${u.username} (created)`);
      } else if (reset) {
        Object.assign(existing, rest, { passwordHash: await bcrypt.hash(password, 10), isActive: true, status: 'ACTIVE' });
        await existing.save();
        out.push(`${u.username} (reset)`);
      }
    } catch (e) {
      // one bad account must not stop the others
      out.push(`${u.username} (FAILED: ${e.message})`);
      console.error(`⚠️  Default user ${u.username}:`, e.message);
    }
  }
  return out;
}
