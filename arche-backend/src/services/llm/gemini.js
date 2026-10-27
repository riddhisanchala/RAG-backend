import { httpJson, l2normalize, ProviderError } from './http.js';

const base = (c) => (c.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
const headers = (c) => ({ 'x-goog-api-key': c.apiKey });
const EMBED_DIMS = 768; // gemini-embedding models support reduced output size; we normalise ourselves.

export default {
  id: 'gemini',
  name: 'Google Gemini',
  capabilities: { chat: true, embeddings: true },
  defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  keyHint: 'AIza…',
  docsUrl: 'https://aistudio.google.com/app/apikey',
  suggestedChatModels: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite'],
  suggestedEmbeddingModels: ['gemini-embedding-001'],
  
  async chat(c, { model, system, user, maxTokens = 1500, json = false }) {
    // Backward compatibility for invalid model IDs that may already be saved in MongoDB.
    // Gemini 3.8 Flash-Lite is a TTS model, not a text-generation model.
    // Route old/invalid saved IDs to a supported text-generation model.
    if (model === 'gemini-3.8-flash-lite' || model === 'gemini-3.8-pro') {
      model = 'gemini-3.8-flash';
    }
    // Gemini 2.5/3 are "thinking" models: hidden reasoning tokens count against maxOutputTokens, so a
    // small budget can leave NO visible text (empty/cut-off JSON → the app looked like it never answered).
    const generationConfig = { maxOutputTokens: Math.max(maxTokens, 8192) };
    if (json) generationConfig.responseMimeType = 'application/json';
    // 2.5 Flash / Flash-Lite allow thinking to be switched off; that is faster and plenty for grounded Q&A.
    const canDisableThinking = /^gemini-2\.5-flash/.test(model);
    const call = (cfg) =>
      httpJson(`${base(c)}/models/${encodeURIComponent(model)}:generateContent`, {
        headers: headers(c),
        body: {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: cfg,
        },
      });
    let data;
    try {
      data = await call(canDisableThinking ? { ...generationConfig, thinkingConfig: { thinkingBudget: 0 } } : generationConfig);
    } catch (e) {
      if (canDisableThinking && e.isProviderError && /thinking/i.test(e.message)) data = await call(generationConfig);
      else throw e;
    }
    const cand = data?.candidates?.[0];
    // skip "thought" parts, keep only the visible answer
    const text = (cand?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
    if (!text) throw new ProviderError(`Gemini returned no text (${cand?.finishReason || data?.promptFeedback?.blockReason || 'unknown reason'}). Try another model in Settings → LLM Providers.`);
    return text;
  },

  async embed(c, { model, texts, inputType = 'document' }) {
    const out = [];
    for (let i = 0; i < texts.length; i += 100) {
      const slice = texts.slice(i, i + 100);
      const data = await httpJson(`${base(c)}/models/${encodeURIComponent(model)}:batchEmbedContents`, {
        headers: headers(c),
        body: {
          requests: slice.map((t) => ({
            model: `models/${model}`,
            content: { parts: [{ text: t }] },
            taskType: inputType === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
            outputDimensionality: EMBED_DIMS,
          })),
        },
      });
      const vals = (data.embeddings || []).map((e) => e.values);
      if (vals.length !== slice.length) throw new ProviderError('Embedding count mismatch from Gemini.');
      out.push(...vals.map(l2normalize));
    }
    return out;
  },

  async listModels(c) {
    const data = await httpJson(`${base(c)}/models?pageSize=200`, { method: 'GET', headers: headers(c) });
    const models = data.models || [];
    const short = (m) => m.name.replace(/^models\//, '');
    return {
      chat: models.filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map(short),
      embedding: models.filter((m) => (m.supportedGenerationMethods || []).some((x) => /embed/i.test(x))).map(short),
    };
  },
};
