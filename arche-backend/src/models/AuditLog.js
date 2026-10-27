// Immutable-ish record of every question asked and what the retrieval layer returned/denied.
import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    userId: mongoose.Schema.Types.ObjectId,
    username: String,
    role: String,
    action: String, // query | upload | delete | reindex | provider_update | login ...
    query: String,
    retrievedChunkIds: [String],
    detail: mongoose.Schema.Types.Mixed,
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'audit_logs' }
);

export default mongoose.model('AuditLog', schema);
