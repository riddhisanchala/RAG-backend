import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  { key: { type: String, unique: true, required: true }, value: mongoose.Schema.Types.Mixed },
  { timestamps: true, collection: 'app_settings' }
);

export default mongoose.model('Setting', schema);
