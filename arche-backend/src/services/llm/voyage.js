import { httpJson, l2normalize, ProviderError } from './http.js';

const base = (c) => (c.baseUrl || 'https://api.voyageai.com/v1').replace(/\/+$/, '');

// Voyage AI is Anthropic's recommended embeddings partner — useful if you only chat with Claude.
export default {
  id: 'voyage',
  name: 'Voyage AI (embeddings)',
  capabilities: { chat: false, embeddings: true },
  defaultBaseUrl: 'https://api.voyageai.com/v1',
  keyHint: 'pa-…',
  docsUrl: 'https://dash.voyageai.com/api-keys',
  suggestedChatModels: [],
  suggestedEmbeddingModels: ['voyage-3.5', 'voyage-3.5-lite', 'voyage-3-large'],

  async embed(c, { model, texts, inputType = 'document' }) {
    const out = [];
    for (let i = 0; i < texts.length; i += 64) {
      const slice = texts.slice(i, i + 64);
      const data = await httpJson(`${base(c)}/embeddings`, {
        headers: { Authorization: `Bearer ${c.apiKey}` },
        body: { model, input: slice, input_type: inputType === 'query' ? 'query' : 'document' },
      });
      const rows = [...(data.data || [])].sort((a, b) => a.index - b.index);
      if (rows.length !== slice.length) throw new ProviderError('Embedding count mismatch from Voyage.');
      out.push(...rows.map((r) => l2normalize(r.embedding)));
    }
    return out;
  },

  async listModels() {
    return { chat: [], embedding: this.suggestedEmbeddingModels };
  },
};
