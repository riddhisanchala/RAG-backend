// answerQuestion(): retrieve (authorized) → generate (grounded JSON) → verify → cite.
import { chat } from '../llm/index.js';
import { retrieve } from './retriever.js';
import { SYSTEM_PROMPT, buildUserPrompt, parseModelJson } from './prompt.js';
import { verifyAnswer } from './grounding.js';
import { vectorStore } from '../vector/faissStore.js';
import { audit } from '../../utils/audit.js';
import { HttpError } from '../../utils/http.js';

export const NOT_FOUND_MESSAGE =
  "I couldn't find an answer to that in the documents you have access to. Try rephrasing, or ask an admin if the information should be added.";

export async function answerQuestion({ principal, question, history = [], provider, model }) {
  const t0 = Date.now();

  // Short follow-ups ("and for HR?") retrieve better with the previous user question for context.
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  const retrievalQuery = lastUser && question.split(/\s+/).length <= 8 ? `${lastUser.content}\n${question}` : question;

  // Say WHY there is no answer when the knowledge base itself is empty, instead of a generic "not found".
  if (vectorStore.size() === 0) {
    throw new HttpError(409, 'The knowledge base is empty. An admin must upload documents (or load the sample data) on the Knowledge page first.');
  }

  const { sources, stats } = await retrieve(principal, retrievalQuery);

  const finish = async (payload, extra = {}) => {
    const { dropped, ...publicExtra } = extra; // rejected statements go to the audit log only
    const meta = {
      latencyMs: Date.now() - t0,
      retrieved: sources.length,
      ...publicExtra,
    };
    await audit(principal, 'query', {
      query: question.slice(0, 500),
      retrievedChunkIds: sources.map((s) => s.chunkId),
      detail: { ...meta, ...stats, dropped },
    });
    return { ...payload, meta };
  };

  // Nothing authorized & relevant → don't call the LLM at all (nothing to ground on, nothing to leak).
  if (!sources.length) {
    return finish({ content: NOT_FOUND_MESSAGE, statements: [], citations: [] }, { grounded: false });
  }

  const user = buildUserPrompt({ question, sources, history: history.slice(-6) });
  let reply = await chat({ provider, model, system: SYSTEM_PROMPT, user, maxTokens: 2500, json: true });
  let parsed = parseModelJson(reply.text);
  if (!parsed) {
    // one repair attempt
    reply = await chat({
      provider: reply.provider,
      model: reply.model,
      system: SYSTEM_PROMPT,
      user: `${user}\n\nYour previous reply was not valid JSON. Reply again with ONLY the JSON object.`,
      maxTokens: 2500,
      json: true,
    });
    parsed = parseModelJson(reply.text);
  }
  if (!parsed) throw new HttpError(502, 'The model returned an answer in an unreadable format. Please try again or pick another model.');

  const { verified, dropped } = verifyAnswer(parsed, sources);
  const llmInfo = { provider: reply.provider, model: reply.model };

  if (!verified.length) {
    return finish(
      { content: NOT_FOUND_MESSAGE, statements: [], citations: [] },
      { ...llmInfo, grounded: false, droppedStatements: dropped.length, dropped }
    );
  }

  // Number citations in order of first use.
  const order = new Map();
  const citationList = [];
  const statements = verified.map((v) => ({
    text: v.text,
    cites: v.citations.map((c) => {
      if (!order.has(c.sid)) {
        const src = sources.find((s) => s.sid === c.sid);
        const n = order.size + 1;
        order.set(c.sid, n);
        citationList.push({
          n,
          sid: c.sid,
          chunkId: src.chunkId,
          documentId: src.documentId,
          kind: src.source.kind,
          title: src.source.title,
          filename: src.source.filename,
          page: src.source.page,
          table: src.source.table,
          rowIndex: src.source.rowIndex,
          rowKey: src.source.rowKey,
          ocrConfidence: src.source.ocrConfidence,
          pageCharStart: src.source.charStart != null ? src.source.charStart + c.quoteStart : undefined,
          pageCharEnd: src.source.charStart != null ? src.source.charStart + c.quoteEnd : undefined,
          passage: src.text,
          quote: c.quote,
          quoteStart: c.quoteStart,
          quoteEnd: c.quoteEnd,
          verification: c.verification,
          score: src.score,
        });
      }
      return order.get(c.sid);
    }),
  }));

  const content = statements.map((s) => `${s.text} ${s.cites.map((n) => `[${n}]`).join('')}`).join(' ');
  return finish(
    { content, statements, citations: citationList },
    { ...llmInfo, grounded: true, droppedStatements: dropped.length, dropped }
  );
}
