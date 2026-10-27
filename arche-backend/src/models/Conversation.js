import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
    // assistant only: structured, verified answer
    statements: { type: mongoose.Schema.Types.Mixed },
    citations: { type: mongoose.Schema.Types.Mixed },
    meta: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

const schema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, required: true },
    title: { type: String, default: 'New chat' },
    messages: { type: [messageSchema], default: [] },
  },
  { timestamps: true, collection: 'conversations' }
);

export default mongoose.model('Conversation', schema);
