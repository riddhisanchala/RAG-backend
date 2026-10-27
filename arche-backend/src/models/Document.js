// A source document that was ingested (PDF, image, structured records, text).
import mongoose from 'mongoose';

const aclSchema = new mongoose.Schema(
  {
    department: { type: String, required: true },
    allowedRoles: { type: [String], default: [] },
    allowedUsers: { type: [String], default: [] },
  },
  { _id: false }
);

const schema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    filename: { type: String, required: true },
    kind: { type: String, enum: ['pdf', 'image', 'records', 'text'], required: true },
    mimeType: String,
    size: Number,
    storedPath: String,
    acl: { type: aclSchema, required: true },
    accessLabel: String, // human friendly: "Department", "Roles: HR", "Only uploader"
    uploadedBy: { type: String, required: true }, // username
    status: { type: String, enum: ['processing', 'ready', 'failed'], default: 'processing' },
    error: String,
    stats: {
      pages: Number,
      chunks: Number,
      rows: Number,
      ocrConfidence: Number,
      emptyPages: Number,
    },
    tableName: String,
    ownerColumn: String,
    embeddingModel: String,
  },
  { timestamps: true, collection: 'kb_documents' }
);

export default mongoose.model('KbDocument', schema);
