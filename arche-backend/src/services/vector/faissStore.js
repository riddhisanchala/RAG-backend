// ─────────────────────────────────────────────────────────────────────────────
// faissStore.js — vector index built on FAISS (faiss-node), with authorization
// enforced INSIDE the retrieval layer.
//
// Layout
//   • One exact inner-product index (IndexFlatIP) per department partition.
//     Vectors are L2-normalised, so inner product == cosine similarity.
//   • Next to each index file there is a manifest: position i in the index
//     ⇄ manifest.entries[i] = { chunkId, documentId, acl }.
//     So the ACL travels with every vector, and search() can authorize hits
//     without trusting the caller.
//
// Why this is "retrieval-layer" authZ, not app-layer filtering:
//   • search() REQUIRES a principal. There is no code path that returns hits
//     without evaluating `canAccess` on every candidate.
//   • Partitions the user cannot reach are never searched at all.
//   • Inside a reachable partition, candidates are over-fetched (k grows ×4
//     until enough *authorized* hits are found or the index is exhausted) and
//     unauthorized candidates are discarded before leaving this module.
//   • Callers get only chunk ids + scores of authorized chunks.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import faiss from 'faiss-node'; // CommonJS module → default import

const { IndexFlatIP } = faiss;
import { env } from '../../config/env.js';
import { DEPARTMENTS } from '../../config/roles.js';
import { canAccess, departmentsByRole } from '../../security/acl.js';

const DIR = path.join(env.dataDir, 'faiss');

class Partition {
  constructor(name, dim, model) {
    this.name = name;
    this.dim = dim;
    this.model = model;
    this.index = new IndexFlatIP(dim);
    this.entries = [];
    this.namedUsers = new Set(); // usernames that appear in any entry's allowedUsers
  }
  rebuildNamedUsers() {
    this.namedUsers = new Set(this.entries.flatMap((e) => e.acl.allowedUsers || []));
  }
  get indexPath() {
    return path.join(DIR, `${this.name}.index`);
  }
  get metaPath() {
    return path.join(DIR, `${this.name}.meta.json`);
  }
  persist() {
    fs.mkdirSync(DIR, { recursive: true });
    this.index.write(this.indexPath);
    const tmp = this.metaPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ dim: this.dim, model: this.model, entries: this.entries }));
    fs.renameSync(tmp, this.metaPath);
  }
}

export class FaissVectorStore {
  constructor() {
    this.partitions = new Map();
    this.problems = [];
    this._lock = Promise.resolve();
  }

  // Serialise writers so index file + manifest never diverge.
  _withLock(fn) {
    const run = this._lock.then(fn, fn);
    this._lock = run.catch(() => {});
    return run;
  }

  init() {
    fs.mkdirSync(DIR, { recursive: true });
    this.partitions.clear();
    this.problems = [];
    for (const name of DEPARTMENTS) {
      const meta = path.join(DIR, `${name}.meta.json`);
      const idx = path.join(DIR, `${name}.index`);
      if (!fs.existsSync(meta) || !fs.existsSync(idx)) continue;
      try {
        const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
        const p = new Partition(name, m.dim, m.model);
        p.index = IndexFlatIP.read(idx);
        p.entries = m.entries;
        if (p.index.ntotal() !== p.entries.length) {
          this.problems.push(`${name}: index has ${p.index.ntotal()} vectors but manifest has ${p.entries.length}. Run Re-index.`);
          continue; // fail closed: do not serve a partition whose manifest is inconsistent
        }
        p.rebuildNamedUsers();
        this.partitions.set(name, p);
      } catch (e) {
        this.problems.push(`${name}: failed to load (${e.message}). Run Re-index.`);
      }
    }
    return this;
  }

  /** Embedding model + dimension currently stored (null if the store is empty). */
  signature() {
    for (const p of this.partitions.values()) if (p.entries.length) return { model: p.model, dim: p.dim };
    return null;
  }

  size() {
    let n = 0;
    for (const p of this.partitions.values()) n += p.entries.length;
    return n;
  }

  /** items: [{ chunkId, documentId, acl, vector:number[] }] — all share one partition = acl.department */
  add(items, { dim, model }) {
    return this._withLock(async () => {
      const byPart = new Map();
      for (const it of items) {
        const key = it.acl.department;
        if (!DEPARTMENTS.includes(key)) throw new Error(`Unknown partition ${key}`);
        if (it.vector.length !== dim) throw new Error(`Vector has ${it.vector.length} dims, expected ${dim}`);
        if (!byPart.has(key)) byPart.set(key, []);
        byPart.get(key).push(it);
      }
      const sig = this.signature();
      if (sig && (sig.model !== model || sig.dim !== dim)) {
        throw Object.assign(
          new Error(`The index was built with "${sig.model}" (${sig.dim} dims) but the active embedding model is "${model}" (${dim} dims). Run Re-index in the Knowledge Base page.`),
          { status: 409 }
        );
      }
      for (const [name, list] of byPart) {
        let p = this.partitions.get(name);
        if (!p) {
          p = new Partition(name, dim, model);
          this.partitions.set(name, p);
        }
        p.index.add(list.flatMap((l) => l.vector));
        for (const l of list) {
          p.entries.push({ chunkId: String(l.chunkId), documentId: String(l.documentId), acl: l.acl });
        }
        p.rebuildNamedUsers();
        p.persist();
      }
    });
  }

  /** Remove every vector that belongs to a document. */
  removeDocument(documentId) {
    return this._withLock(async () => {
      const id = String(documentId);
      let removed = 0;
      for (const p of this.partitions.values()) {
        const positions = [];
        p.entries.forEach((e, i) => e.documentId === id && positions.push(i));
        if (!positions.length) continue;
        p.index.removeIds(positions); // flat index compacts and keeps order
        p.entries = p.entries.filter((e) => e.documentId !== id);
        p.rebuildNamedUsers();
        p.persist();
        removed += positions.length;
      }
      return removed;
    });
  }

  /** Drop everything (used by Re-index). */
  reset() {
    return this._withLock(async () => {
      for (const p of this.partitions.values()) {
        fs.rmSync(p.indexPath, { force: true });
        fs.rmSync(p.metaPath, { force: true });
      }
      this.partitions.clear();
      this.problems = [];
    });
  }

  /**
   * AUTHORIZED nearest-neighbour search.
   * @param principal  {username, role, ...} — mandatory
   * @param query      number[] (L2-normalised)
   * @returns { hits:[{chunkId, documentId, score, partition}], stats:{partitionsSearched, candidates, denied} }
   */
  search(principal, query, topK = 6) {
    if (!principal || !principal.username || !principal.role) {
      throw new Error('search() requires an authenticated principal');
    }
    const roleDepts = new Set(departmentsByRole(principal));
    const stats = { partitionsSearched: 0, candidates: 0, denied: 0 };
    const merged = [];

    for (const p of this.partitions.values()) {
      // Partition pruning: skip partitions the user can't possibly read from.
      const reachable = roleDepts.has(p.name) || p.namedUsers.has(principal.username) || principal.role === 'ADMIN';
      if (!reachable || p.entries.length === 0) continue;
      if (query.length !== p.dim) {
        throw Object.assign(new Error('Query embedding dimension does not match the index. Run Re-index.'), { status: 409 });
      }
      stats.partitionsSearched++;

      const n = p.entries.length;
      let k = Math.min(n, Math.max(topK * 4, 16));
      let authorized = [];
      for (;;) {
        const { distances, labels } = p.index.search(query, k);
        authorized = [];
        let seen = 0;
        let denied = 0;
        for (let i = 0; i < labels.length; i++) {
          const pos = labels[i];
          if (pos < 0) continue;
          seen++;
          const entry = p.entries[pos];
          if (canAccess(principal, entry.acl)) {
            authorized.push({ chunkId: entry.chunkId, documentId: entry.documentId, score: distances[i], partition: p.name });
          } else {
            denied++;
          }
        }
        if (authorized.length >= topK || k >= n) {
          stats.candidates += seen;
          stats.denied += denied;
          break;
        }
        k = Math.min(n, k * 4); // not enough authorized hits yet → widen the net
      }
      merged.push(...authorized.slice(0, topK));
    }

    merged.sort((a, b) => b.score - a.score);
    return { hits: merged.slice(0, topK), stats };
  }

  status() {
    return {
      total: this.size(),
      signature: this.signature(),
      problems: this.problems,
      partitions: [...this.partitions.values()].map((p) => ({ name: p.name, vectors: p.entries.length, dim: p.dim, model: p.model })),
    };
  }
}

export const vectorStore = new FaissVectorStore();
