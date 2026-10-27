// LLM providers & API keys. Admin-only management; any signed-in user can list usable chat models.
import { Router } from 'express';
import ProviderConfig from '../models/ProviderConfig.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../utils/http.js';
import { encryptSecret } from '../utils/crypto.js';
import { audit } from '../utils/audit.js';
import { ADAPTERS, adapterOrThrow, getCredentials, getDefaults, saveDefaults, testProvider } from '../services/llm/index.js';
import { vectorStore } from '../services/vector/faissStore.js';

const router = Router();
router.use(requireAuth);

const mask = (last4) => (last4 ? `••••••••${last4}` : '');

function describe(adapter, cfg) {
  return {
    id: adapter.id,
    name: adapter.name,
    capabilities: adapter.capabilities,
    defaultBaseUrl: adapter.defaultBaseUrl,
    keyHint: adapter.keyHint,
    docsUrl: adapter.docsUrl,
    suggestedChatModels: adapter.suggestedChatModels,
    suggestedEmbeddingModels: adapter.suggestedEmbeddingModels,
    configured: !!cfg?.apiKeyEnc,
    enabled: cfg ? cfg.enabled : true,
    apiKeyMasked: mask(cfg?.apiKeyLast4),
    baseUrl: cfg?.baseUrl || '',
    chatModels: cfg?.chatModels || [],
    embeddingModel: cfg?.embeddingModel || '',
    lastTest: cfg?.lastTest || null,
    updatedAt: cfg?.updatedAt || null,
  };
}

/** Chat models any signed-in user may choose from (admin-approved list only). */
export async function allowedChatOptions() {
  const [cfgs, d] = await Promise.all([ProviderConfig.find({ enabled: true, apiKeyEnc: { $ne: '' } }), getDefaults()]);
  const options = [];
  for (const cfg of cfgs) {
    const a = ADAPTERS[cfg.provider];
    if (!a?.capabilities.chat) continue;
    const models = new Set(cfg.chatModels);
    if (d.chatProvider === cfg.provider && d.chatModel) models.add(d.chatModel);
    for (const model of models) options.push({ provider: cfg.provider, providerName: a.name, model });
  }
  return { options, default: d.chatProvider && d.chatModel ? { provider: d.chatProvider, model: d.chatModel } : null, embeddingConfigured: !!(d.embeddingProvider && d.embeddingModel) };
}

router.get('/available', asyncHandler(async (req, res) => res.json(await allowedChatOptions())));

// ---- admin only below ----
router.use(requireRole('ADMIN'));

router.get('/', asyncHandler(async (req, res) => {
  const cfgs = await ProviderConfig.find();
  const byId = new Map(cfgs.map((c) => [c.provider, c]));
  res.json({
    providers: Object.values(ADAPTERS).map((a) => describe(a, byId.get(a.id))),
    defaults: await getDefaults(),
    index: vectorStore.status(),
  });
}));

router.put('/defaults/models', asyncHandler(async (req, res) => {
  const { chatProvider = '', chatModel = '', embeddingProvider = '', embeddingModel = '' } = req.body;
  const patch = {};
  const check = async (providerId, cap) => {
    const a = adapterOrThrow(providerId);
    if (!a.capabilities[cap]) throw new HttpError(400, `${a.name} does not support ${cap === 'chat' ? 'chat' : 'embeddings'}.`);
    await getCredentials(providerId); // must have a saved key and be enabled
  };
  if (chatProvider || chatModel) {
    if (!chatProvider || !String(chatModel).trim()) throw new HttpError(400, 'Choose both a chat provider and a model.');
    await check(chatProvider, 'chat');
    Object.assign(patch, { chatProvider, chatModel: String(chatModel).trim() });
  }
  if (embeddingProvider || embeddingModel) {
    if (!embeddingProvider || !String(embeddingModel).trim()) throw new HttpError(400, 'Choose both an embedding provider and a model.');
    await check(embeddingProvider, 'embeddings');
    Object.assign(patch, { embeddingProvider, embeddingModel: String(embeddingModel).trim() });
  }
  const saved = await saveDefaults(patch);
  const sig = vectorStore.signature();
  const newModel = patch.embeddingProvider ? `${patch.embeddingProvider}:${patch.embeddingModel}` : null;
  await audit(req.user, 'defaults_update', { detail: patch });
  res.json({ defaults: saved, reindexRequired: !!(sig && newModel && sig.model !== newModel) });
}));

router.put('/:provider', asyncHandler(async (req, res) => {
  const adapter = adapterOrThrow(req.params.provider);
  const { apiKey, baseUrl = '', enabled = true, chatModels = [], embeddingModel = '' } = req.body;

  let cfg = await ProviderConfig.findOne({ provider: adapter.id });
  if (!cfg) cfg = new ProviderConfig({ provider: adapter.id });

  if (typeof apiKey === 'string' && apiKey.trim()) {
    const k = apiKey.trim();
    if (k.length < 8 || /\s/.test(k)) throw new HttpError(400, 'That does not look like a valid API key.');
    cfg.apiKeyEnc = encryptSecret(k);
    cfg.apiKeyLast4 = k.slice(-4);
  }
  if (baseUrl) {
    try {
      const u = new URL(baseUrl);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
    } catch {
      throw new HttpError(400, 'Base URL must be a valid http(s) URL.');
    }
  }
  cfg.baseUrl = baseUrl.trim();
  cfg.enabled = !!enabled;
  cfg.chatModels = adapter.capabilities.chat ? [...new Set(chatModels.map((m) => String(m).trim()).filter(Boolean))].slice(0, 30) : [];
  cfg.embeddingModel = adapter.capabilities.embeddings ? String(embeddingModel).trim() : '';
  cfg.updatedBy = req.user.username;
  cfg.lastTest = undefined; // settings changed → previous test result is stale
  await cfg.save();

  // Convenience: first configured provider becomes the default automatically.
  const d = await getDefaults();
  const patch = {};
  if (cfg.apiKeyEnc && cfg.enabled) {
    if (!d.chatProvider && adapter.capabilities.chat && cfg.chatModels[0]) Object.assign(patch, { chatProvider: adapter.id, chatModel: cfg.chatModels[0] });
    if (!d.embeddingProvider && adapter.capabilities.embeddings && cfg.embeddingModel) Object.assign(patch, { embeddingProvider: adapter.id, embeddingModel: cfg.embeddingModel });
  }
  if (Object.keys(patch).length) await saveDefaults(patch);

  await audit(req.user, 'provider_update', { detail: { provider: adapter.id, keyChanged: !!apiKey, enabled: cfg.enabled } });
  res.json({ provider: describe(adapter, cfg), defaults: await getDefaults() });
}));

router.delete('/:provider/key', asyncHandler(async (req, res) => {
  const adapter = adapterOrThrow(req.params.provider);
  const cfg = await ProviderConfig.findOne({ provider: adapter.id });
  if (cfg) {
    cfg.apiKeyEnc = '';
    cfg.apiKeyLast4 = '';
    cfg.lastTest = undefined;
    await cfg.save();
  }
  const d = await getDefaults();
  const patch = {};
  if (d.chatProvider === adapter.id) Object.assign(patch, { chatProvider: '', chatModel: '' });
  if (d.embeddingProvider === adapter.id) Object.assign(patch, { embeddingProvider: '', embeddingModel: '' });
  if (Object.keys(patch).length) await saveDefaults(patch);
  await audit(req.user, 'provider_key_removed', { detail: { provider: adapter.id } });
  res.json({ provider: describe(adapter, cfg), defaults: await getDefaults() });
}));

router.post('/:provider/test', asyncHandler(async (req, res) => {
  const adapter = adapterOrThrow(req.params.provider);
  const cfg = await ProviderConfig.findOne({ provider: adapter.id });
  let ok = true;
  let message;
  try {
    message = await testProvider(adapter.id);
  } catch (e) {
    ok = false;
    message = e.message;
  }
  if (cfg) {
    cfg.lastTest = { ok, message: String(message).slice(0, 400), at: new Date() };
    await cfg.save();
  }
  res.json({ ok, message, provider: describe(adapter, cfg) });
}));

router.post('/:provider/models', asyncHandler(async (req, res) => {
  const adapter = adapterOrThrow(req.params.provider);
  const creds = await getCredentials(adapter.id);
  res.json(await adapter.listModels(creds));
}));

export default router;
