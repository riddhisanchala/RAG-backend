// Run with: npm run seed:users
// Creates (or RESETS) the default accounts:
//   admin / admin        → ADMIN   (can see everything, manages providers)
//   hr01 / Demo@123      → HR
//   employee01 / Demo@123→ EMPLOYEE
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import { DEFAULT_USERS, ensureDefaultUsers } from './defaultUsers.js';

await connectDB();
const done = await ensureDefaultUsers({ reset: true });
console.log('✅ Users:', done.join(', '));
DEFAULT_USERS.forEach((u) => console.log(`   ${u.username.padEnd(11)} / ${u.password.padEnd(9)} → ${u.role}`));
await mongoose.disconnect();
