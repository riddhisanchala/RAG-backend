// Bulk-create user accounts from a CSV file.
// Columns (header row required, any order): name, email, password, role, department, username
//   required: name, password (min 8 chars)   • email OR username must be present
//   optional: role (default EMPLOYEE), department (default "General"), username (default: part of email before @)
// Existing usernames/emails are skipped, never overwritten.
import bcrypt from 'bcryptjs';
import { parse } from 'csv-parse/sync';
import User from '../../models/User.js';
import { ROLES } from '../../config/roles.js';

export const TEMPLATE = 'name,email,username,password,role,department\nJane Doe,jane@example.com,jane,ChangeMe123,EMPLOYEE,General\n';

export async function importUsersFromCsv(raw) {
  let rows;
  try {
    rows = parse(raw, { columns: (h) => h.map((x) => String(x).trim().toLowerCase()), skip_empty_lines: true, bom: true, trim: true, relax_column_count: true });
  } catch (e) {
    throw Object.assign(new Error(`Could not read the CSV: ${e.message}`), { status: 422 });
  }
  if (!rows.length) throw Object.assign(new Error('The CSV has no rows.'), { status: 422 });
  if (rows.length > 1000) throw Object.assign(new Error('Too many rows (max 1000 per file).'), { status: 422 });

  const result = { created: [], skipped: [], failed: [] };
  for (const [i, r] of rows.entries()) {
    const line = i + 2; // header is line 1
    try {
      const name = String(r.name || '').trim();
      const email = String(r.email || '').trim().toLowerCase();
      const password = String(r.password || '');
      const role = String(r.role || ROLES.EMPLOYEE).trim().toUpperCase();
      const department = String(r.department || 'General').trim();
      let username = String(r.username || '').trim().toLowerCase() || email.split('@')[0].replace(/[^a-z0-9._-]/g, '').slice(0, 30);

      if (name.length < 2) throw new Error('name is missing');
      if (!username) throw new Error('username or email is required');
      if (email && !/^\S+@\S+\.\S+$/.test(email)) throw new Error('invalid email');
      if (password.length < 8) throw new Error('password must be at least 8 characters');
      if (!Object.values(ROLES).includes(role)) throw new Error(`invalid role "${role}"`);

      const clash = await User.findOne(email ? { $or: [{ username }, { email }] } : { username }).lean();
      if (clash) { result.skipped.push({ line, username, reason: 'already exists' }); continue; }

      const user = await User.create({ username, ...(email ? { email } : {}), name, passwordHash: await bcrypt.hash(password, 10), role, department, status: 'ACTIVE', isActive: true });
      result.created.push({ line, username: user.username, role });
    } catch (e) {
      result.failed.push({ line, reason: e.message });
    }
  }
  return result;
}
