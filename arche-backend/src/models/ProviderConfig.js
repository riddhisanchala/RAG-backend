// One document per LLM provider. The API key is stored ENCRYPTED and is never sent to the browser.
import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    provider: { type: String, required: true, unique: true }, // openai | anthropic | gemini | voyage
    enabled: { type: Boolean, default: true },
    apiKeyEnc: { type: String, default: '' },
    apiKeyLast4: { type: String, default: '' },
    baseUrl: { type: String, default: '' }, // optional override (proxy / compatible gateway)
    chatModels: { type: [String], default: [] }, // models shown in the chat model picker
    embeddingModel: { type: String, default: '' },
    lastTest: {
      ok: Boolean,
      message: String,
      at: Date,
    },
    updatedBy: { type: String, default: '' },
  },
  { timestamps: true, collection: 'llm_providers' }
);

export default mongoose.model('ProviderConfig', schema);
