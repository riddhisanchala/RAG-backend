// A retrievable passage. The text + provenance live here; the vector lives in FAISS.
// The ACL is stored on every chunk, so authorization is decided per passage / per row.
import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    documentId: { type: mongoose.Schema.Types.ObjectId, ref: 'KbDocument', index: true, required: true },
    text: { type: String, required: true },
    acl: {
      department: { type: String, required: true },
      allowedRoles: { type: [String], default: [] },
      allowedUsers: { type: [String], default: [] },
    },
    source: {
      kind: String, // pdf | image | record | text
      filename: String,
      title: String,
      page: Number,
      charStart: Number, // offsets inside the normalized page text
      charEnd: Number,
      table: String,
      rowIndex: Number,
      rowKey: String,
      ocrConfidence: Number,
    },
  },
  { timestamps: true, collection: 'kb_chunks' }
);

export default mongoose.model('KbChunk', schema);
