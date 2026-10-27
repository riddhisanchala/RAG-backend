// A tiny OpenAI-compatible server for tests: deterministic embeddings + an "extractive" chat model.
// It records every prompt it receives so tests can prove restricted text never reached the LLM.
import http from 'node:http';

export const received = { prompts: [], embedInputs: [] };

const DIM = 512;
const STOP = new Set('the and was what when who how for with this that are you your from have has will can does did not any all per'.split(' '));
const tok = (s) => (String(s).toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => t.length > 2 && !STOP.has(t));
function hash(t) {
  let h = 2166136261;
  for (const c of t) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return Math.abs(h) % DIM;
}
function embedding(text) {
  const v = new Array(DIM).fill(0);
  for (const t of tok(text)) v[hash(t)] += 1;
  return v;
}

function mockChat(userPrompt) {
  const q = userPrompt.split('QUESTION:')[1]?.split('Return the JSON')[0]?.trim() || '';
  if (/HALLUCINATE/.test(q)) {
    return JSON.stringify({ answerable: true, statements: [{ text: 'The CEO salary is 99 crore per year.', citations: [{ source: 'S1', quote: 'The CEO salary is 99 crore per year.' }] }] });
  }
  const sources = [...userPrompt.matchAll(/\[(S\d+)\] \(([^)]*)\)\n"""\n([\s\S]*?)\n"""/g)].map((m) => ({ sid: m[1], text: m[3] }));
  const qt = new Set(tok(q));
  const scored = [];
  for (const s of sources) {
    for (const sent of s.text.split(/(?<=[.!?])\s+/)) {
      const score = tok(sent).filter((t) => qt.has(t)).length;
      if (score > 1) scored.push({ sid: s.sid, sent, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 2);
  if (!top.length) return JSON.stringify({ answerable: false, statements: [] });
  return JSON.stringify({ answerable: true, statements: top.map((t) => ({ text: t.sent, citations: [{ source: t.sid, quote: t.sent.slice(0, 160) }] })) });
}

export function startMock(port) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      res.setHeader('Content-Type', 'application/json');
      if (!req.headers.authorization?.startsWith('Bearer ')) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
      }
      if (req.url.endsWith('/embeddings')) {
        received.embedInputs.push(...json.input);
        return res.end(JSON.stringify({ data: json.input.map((t, index) => ({ index, embedding: embedding(t) })) }));
      }
      if (req.url.endsWith('/chat/completions')) {
        const user = json.messages.find((m) => m.role === 'user').content;
        received.prompts.push(user);
        const isPing = /ping/.test(user) && !user.includes('SOURCES');
        return res.end(JSON.stringify({ choices: [{ message: { content: isPing ? 'ok' : mockChat(user) } }] }));
      }
      if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'gpt-mock' }, { id: 'text-embedding-mock' }] }));
      res.statusCode = 404;
      res.end('{}');
    });
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}
