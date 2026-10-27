// Retrieval = embed the query → FAISS search UNDER THE USER'S PRINCIPAL → load passages.
// Authorization happens inside vectorStore.search(); we re-check each loaded chunk against the
// ACL stored in MongoDB as a second, independent line of defence.
import KbChunk from '../../models/Chunk.js';
import { embed } from '../llm/index.js';
import { vectorStore } from '../vector/faissStore.js';
import { canAccess } from '../../security/acl.js';
import { HttpError } from '../../utils/http.js';
import { env } from '../../config/env.js';
import { ROLES } from '../../config/roles.js';
import { departmentsByRole } from '../../security/acl.js';
import { contentTokens } from './grounding.js';

// Embeddings are weak on tabular rows (every row looks like "Record from table X, row N. a: b; c: d"),
// so CSV/JSON questions ("Eric's salary", "who is jdoe's manager") often miss on vectors alone.
// This keyword (BM25-style) pass runs over ONLY the chunks the user is allowed to read and is merged in.
const ROW_FIELD_RE = /[^a-z0-9]+/g;

async function lexicalSearch(principal, question, limit) {
  const qTokens = [...new Set(contentTokens(question))];
  if (!qTokens.length) return [];
  const filter =
    principal.role === ROLES.ADMIN
      ? {}
      : {
          $or: [
            { 'acl.allowedUsers': principal.username },
            { 'acl.allowedRoles': principal.role },
            { 'acl.allowedRoles': { $size: 0 }, 'acl.allowedUsers': { $size: 0 }, 'acl.department': { $in: departmentsByRole(principal) } },
          ],
        };
  const rows = await KbChunk.find(filter).select('text acl source documentId').lean();
  const docs = rows.filter((c) => canAccess(principal, c.acl));
  if (!docs.length) return [];
  const toks = docs.map((c) => new Set(c.text.toLowerCase().replace(ROW_FIELD_RE, ' ').split(' ').filter(Boolean)));
  const df = new Map();
  for (const t of qTokens) df.set(t, toks.reduce((n, set) => n + (set.has(t) ? 1 : 0), 0));
  const N = docs.length;
  const scored = [];
  docs.forEach((c, i) => {
    let score = 0;
    let matched = 0;
    for (const t of qTokens) {
      if (!toks[i].has(t)) continue;
      matched++;
      score += Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5)); // rare words weigh more
    }
    if (matched) scored.push({ c, score, matched });
  });
  const max = Math.max(...scored.map((x) => x.score), 1);
  return scored
    .map((x) => ({ c: x.c, lex: x.score / max, matched: x.matched / qTokens.length }))
    .sort((a, b) => b.lex - a.lex)
    .slice(0, limit);
}

export async function retrieve(principal, question, { topK = env.topK, minScore = env.minScore } = {}) {
  if (vectorStore.size() === 0) return { sources: [], stats: { partitionsSearched: 0, candidates: 0, denied: 0 } };

  const { vectors, model } = await embed([question], 'query');
  const sig = vectorStore.signature();
  if (sig && sig.model !== model) {
    throw new HttpError(409, `The index was built with "${sig.model}" but the active embedding model is "${model}". An admin must run Re-index (Knowledge Base page).`);
  }

  // Over-fetch a little, then lightly re-rank with lexical overlap (helps exact IDs / names / numbers).
  const { hits, stats } = vectorStore.search(principal, vectors[0], topK * 3);
  const rows = await KbChunk.find({ _id: { $in: hits.map((h) => h.chunkId) } }).lean();
  const byId = new Map(rows.map((r) => [String(r._id), r]));

  const lexHits = await lexicalSearch(principal, question, topK * 3);
  const lexById = new Map(lexHits.map((x) => [String(x.c._id), x]));
  const candidates = new Map(); // chunkId → { h, c }
  for (const h of hits) {
    const c = byId.get(h.chunkId);
    if (!c) continue;
    if (!canAccess(principal, c.acl)) {
      stats.denied++; // second check disagreed with the index manifest → drop
      continue;
    }
    candidates.set(String(c._id), { h, c });
  }
  // keyword-only matches (vector search missed them) join with a neutral vector score
  for (const x of lexHits) {
    const id = String(x.c._id);
    if (!candidates.has(id)) candidates.set(id, { h: { score: minScore, chunkId: id }, c: x.c });
  }
  const scored = [];
  for (const [id, { h, c }] of candidates) {
    const lx = lexById.get(id);
    const lex = lx ? lx.lex : 0;
    // keep a hit if the vector score is OK, OR the keywords clearly match (rows, IDs, names, numbers)
    if (h.score < minScore && !(lx && lx.matched >= 0.34)) continue;
    scored.push({ h, c, rank: h.score + 0.5 * lex });
  }
  scored.sort((a, b) => b.rank - a.rank);

  const sources = scored.slice(0, topK).map(({ h, c }, i) => ({
    sid: `S${i + 1}`,
    chunkId: String(c._id),
    documentId: String(c.documentId),
    text: c.text,
    score: Number(h.score.toFixed(4)),
    source: c.source,
  }));
  return { sources, stats };
}
