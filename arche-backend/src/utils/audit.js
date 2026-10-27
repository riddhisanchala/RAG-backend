import AuditLog from '../models/AuditLog.js';

export async function audit(user, action, fields = {}) {
  try {
    await AuditLog.create({
      userId: user?.id,
      username: user?.username,
      role: user?.role,
      action,
      ...fields,
    });
  } catch (e) {
    console.error('audit log failed:', e.message);
  }
}
