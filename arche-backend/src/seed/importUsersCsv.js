// Run with: npm run import:users -- path/to/users.csv
// Works even when nobody can log in yet (talks to MongoDB directly).
import fs from 'node:fs';
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import { importUsersFromCsv } from '../services/accounts/importUsers.js';

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('Usage: npm run import:users -- path/to/users.csv');
  process.exit(1);
}
await connectDB();
const r = await importUsersFromCsv(fs.readFileSync(file, 'utf8'));
console.log(`✅ created ${r.created.length}, skipped ${r.skipped.length}, failed ${r.failed.length}`);
r.skipped.forEach((x) => console.log(`  skipped line ${x.line} (${x.username}): ${x.reason}`));
r.failed.forEach((x) => console.log(`  FAILED  line ${x.line}: ${x.reason}`));
await mongoose.disconnect();
