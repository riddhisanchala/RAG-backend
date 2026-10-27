import { httpJson, l2normalize, ProviderError } from './http.js';

const base = (c) => (c.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
const auth = (c) => ({ Authorization: `Bearer ${c.apiKey}` });

export default {
  id: 'openai',
  name: 'OpenAI',
  capabilities: { chat: true, embeddings: true },
  defaultBaseUrl: 'https://api.openai.com/v1',
  keyHint: 'sk-…',
  docsUrl: 'https://platform.openai.com/api-keys',
  suggestedChatModels: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1','gpt-4.1-mini'],
  suggestedEmbeddingModels: ['text-embedding-3-small', 'text-embedding-3-large'],

  async chat(c, { model, system, user, maxTokens = 1500, json = false }) {
    const body = {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_completion_tokens: maxTokens,
    };
    if (json) body.response_format = { type: 'json_object' };
    const call = (b) => httpJson(`${base(c)}/chat/completions`, { headers: auth(c), body: b });
    let data;
    try {
      data = await call(body);
    } catch (e) {
      // Some OpenAI-compatible gateways don't know these params → retry in the most compatible form.
      if (e.isProviderError && /response_format|max_completion_tokens/i.test(e.message)) {
        const b2 = { ...body };
        delete b2.response_format;
        delete b2.max_completion_tokens;
        b2.max_tokens = maxTokens;
        data = await call(b2);
      } else throw e;
    }
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new ProviderError('OpenAI returned an empty response.');
    return text;
  },

  async embed(c, { model, texts }) {
    const data = await httpJson(`${base(c)}/embeddings`, { headers: auth(c), body: { model, input: texts } });
    const rows = [...(data.data || [])].sort((a, b) => a.index - b.index);
    if (rows.length !== texts.length) throw new ProviderError('Embedding count mismatch from OpenAI.');
    return rows.map((r) => l2normalize(r.embedding));
  },

  async listModels(c) {
    const data = await httpJson(`${base(c)}/models`, { method: 'GET', headers: auth(c) });
    const ids = (data.data || []).map((m) => m.id).sort();
    return {
      chat: ids.filter((i) => /^(gpt|o\d|chatgpt)/i.test(i) && !/embedding|whisper|tts|dall|image|audio|realtime|transcribe|moderation/i.test(i)),
      embedding: ids.filter((i) => /embedding/i.test(i)),
    };
  },
};
