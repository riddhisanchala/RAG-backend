// LLM gateway: loads provider credentials from MongoDB (decrypting the key server-side only)
// and exposes chat() / embed() to the rest of the app.
import ProviderConfig from '../../models/ProviderConfig.js';
import Setting from '../../models/Setting.js';
import { decryptSecret } from '../../utils/crypto.js';
import { HttpError } from '../../utils/http.js';
import { ProviderError } from './http.js';
import openai from './openai.js';
import anthropic from './anthropic.js';
import gemini from './gemini.js';
import voyage from './voyage.js';

export const ADAPTERS = { openai, anthropic, gemini, voyage };
export const PROVIDER_IDS = Object.keys(ADAPTERS);
const OPENAI_EMBED_BATCH = 96;

export function adapterOrThrow(id) {
  const a = ADAPTERS[id];
  if (!a) throw new HttpError(404, `Unknown provider "${id}".`);
  return a;
}

export async function getCredentials(providerId) {
  adapterOrThrow(providerId);
  const cfg = await ProviderConfig.findOne({ provider: providerId });
  if (!cfg || !cfg.apiKeyEnc) throw new HttpError(400, `No API key saved for ${ADAPTERS[providerId].name}. Add one in Settings → LLM Providers.`);
  if (!cfg.enabled) throw new HttpError(400, `${ADAPTERS[providerId].name} is disabled in Settings → LLM Providers.`);
  let apiKey;
  try {
    apiKey = decryptSecret(cfg.apiKeyEnc);
  } catch {
    throw new HttpError(500, `The saved ${ADAPTERS[providerId].name} key can't be decrypted (ENCRYPTION_KEY changed?). Please re-enter it.`);
  }
  return { apiKey, baseUrl: cfg.baseUrl || '', config: cfg };
}

export async function getDefaults() {
  const s = await Setting.findOne({ key: 'llm' });
  return {
    chatProvider: '',
    chatModel: '',
    embeddingProvider: '',
    embeddingModel: '',
    ...(s?.value || {}),
  };
}

export async function saveDefaults(patch) {
  const current = await getDefaults();
  const value = { ...current, ...patch };
  await Setting.findOneAndUpdate({ key: 'llm' }, { value }, { upsert: true, new: true });
  return value;
}

/** Chat completion. provider/model fall back to the saved defaults. */
export async function chat({ provider, model, system, user, maxTokens, json }) {
  const d = await getDefaults();
  const p = provider || d.chatProvider;
  const m = model || d.chatModel;
  if (!p || !m) throw new HttpError(400, 'No chat model is configured. An admin must set one in Settings → LLM Providers.');
  const adapter = adapterOrThrow(p);
  if (!adapter.capabilities.chat) throw new HttpError(400, `${adapter.name} does not support chat.`);
  const creds = await getCredentials(p);
  const text = await adapter.chat(creds, { model: m, system, user, maxTokens, json });
  return { text, provider: p, model: m };
}

/** Embeddings with the saved default embedding provider/model. Returns normalised vectors. */
export async function embed(texts, inputType = 'document') {
  const d = await getDefaults();
  if (!d.embeddingProvider || !d.embeddingModel) {
    throw new HttpError(400, 'No embedding model is configured. An admin must set one in Settings → LLM Providers.');
  }
  const adapter = adapterOrThrow(d.embeddingProvider);
  if (!adapter.capabilities.embeddings) throw new HttpError(400, `${adapter.name} does not support embeddings.`);
  const creds = await getCredentials(d.embeddingProvider);
  const out = [];
  const step = adapter.id === 'openai' ? OPENAI_EMBED_BATCH : 100;
  for (let i = 0; i < texts.length; i += step) {
    const vecs = await adapter.embed(creds, { model: d.embeddingModel, texts: texts.slice(i, i + step), inputType });
    out.push(...vecs);
  }
  return { vectors: out, model: `${d.embeddingProvider}:${d.embeddingModel}`, dim: out[0]?.length || 0 };
}

export async function testProvider(providerId) {
  const adapter = adapterOrThrow(providerId);
  const creds = await getCredentials(providerId);
  const cfg = creds.config;
  const checks = [];
  if (adapter.capabilities.chat) {
    const model = cfg.chatModels[0] || adapter.suggestedChatModels[0];
    const text = await adapter.chat(creds, { model, system: 'Reply with the single word: ok', user: 'ping', maxTokens: 16 });
    checks.push(`chat (${model}) ✓ "${text.trim().slice(0, 30)}"`);
  }
  if (adapter.capabilities.embeddings) {
    const model = cfg.embeddingModel || adapter.suggestedEmbeddingModels[0];
    const v = await adapter.embed(creds, { model, texts: ['ping'], inputType: 'query' });
    checks.push(`embeddings (${model}) ✓ ${v[0].length} dims`);
  }
  return checks.join(' · ');
}

export { ProviderError };
