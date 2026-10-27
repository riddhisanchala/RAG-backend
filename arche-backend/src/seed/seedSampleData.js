// Run with: npm run seed:sample   (needs an embedding provider configured first — Settings → LLM Providers)
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import User from '../models/User.js';
import { toPrincipal } from '../security/acl.js';
import { vectorStore } from '../services/vector/faissStore.js';
import { loadSampleData } from '../services/ingestion/ingest.js';
import { shutdownOcr } from '../services/ingestion/ocr.js';

await connectDB();
vectorStore.init();
const admin = await User.findOne({ username: 'admin' });
if (!admin) {
  console.error('No admin user. Run: npm run seed:users');
  process.exit(1);
}
const results = await loadSampleData(toPrincipal(admin), (f) => console.log('→ ingesting', f));
console.table(results);
await shutdownOcr();
await mongoose.disconnect();
