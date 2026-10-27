import { httpJson, ProviderError } from './http.js';

const base = (c) => (c.baseUrl || 'https://api.anthropic.com/v1').replace(/\/+$/, '');
const headers = (c) => ({ 'x-api-key': c.apiKey, 'anthropic-version': '2023-06-01' });

export default {
  id: 'anthropic',
  name: 'Anthropic (Claude)',
  capabilities: { chat: true, embeddings: false },
  defaultBaseUrl: 'https://api.anthropic.com/v1',
  keyHint: 'sk-ant-…',
  docsUrl: 'https://console.anthropic.com/settings/keys',
  suggestedChatModels: ['claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'claude-opus-5-5'],
  suggestedEmbeddingModels: [],

  async chat(c, { model, system, user, maxTokens = 1500 }) {
    const data = await httpJson(`${base(c)}/messages`, {
      headers: headers(c),
      body: { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] },
    });
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (!text) throw new ProviderError('Anthropic returned an empty response.');
    return text;
  },

  async listModels(c) {
    const data = await httpJson(`${base(c)}/models?limit=100`, { method: 'GET', headers: headers(c) });
    return { chat: (data.data || []).map((m) => m.id), embedding: [] };
  },
};
