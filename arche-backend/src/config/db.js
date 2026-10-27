// db.js handles connecting to MongoDB.
import dns from 'node:dns';
import mongoose from 'mongoose';
import { env } from './env.js';
import User from '../models/User.js';

// Some networks block the SRV DNS lookup Atlas (mongodb+srv://) needs.
// Only in that case, use Google's public DNS servers.
if (env.mongoUri.startsWith('mongodb+srv://')) {
  dns.setServers(['8.8.8.8', '8.8.4.4']);
}

export async function connectDB() {
  try {
    await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 15000 });
    console.log('✅ MongoDB connected:', mongoose.connection.name);
    await repairUserIndexes();
    await migrateLegacyUsers();
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error.message);
    process.exit(1);
  }
}

// The old general "USER" role no longer exists: those accounts become EMPLOYEE accounts.
async function migrateLegacyUsers() {
  try {
    const r = await User.collection.updateMany({ role: 'USER' }, { $set: { role: 'EMPLOYEE', department: 'General' } });
    if (r.modifiedCount) console.log(`🔧 Converted ${r.modifiedCount} legacy USER account(s) to EMPLOYEE.`);
    // The FINANCE role/department was removed: its accounts become EMPLOYEE.
    const f = await User.collection.updateMany({ role: 'FINANCE' }, { $set: { role: 'EMPLOYEE', department: 'General' } });
    if (f.modifiedCount) console.log(`🔧 Converted ${f.modifiedCount} legacy FINANCE account(s) to EMPLOYEE.`);
  } catch (error) {
    console.warn('⚠️  Could not migrate legacy USER accounts:', error.message);
  }
}

// Databases created by older versions have a non-partial unique index on `email`. Replace it so users
// without an email (the default admin/hr01/... accounts) can all exist.
async function repairUserIndexes() {
  try {
    const coll = User.collection;
    const indexes = await coll.indexes().catch(() => []);
    const old = indexes.find((i) => i.name === 'email_1' && !i.partialFilterExpression);
    if (old) {
      await coll.dropIndex('email_1');
      console.log('🔧 Dropped old email index (replaced by a partial unique index).');
    }
    await User.syncIndexes();
  } catch (error) {
    // Never block start-up on index housekeeping.
    console.warn('⚠️  Could not repair user indexes:', error.message);
  }
}
