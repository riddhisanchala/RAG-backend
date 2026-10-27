// Hallucination control. After the LLM answers we do NOT trust it: each statement must
//   (a) cite a source that was actually retrieved for this user,
//   (b) be supported by the cited text (content-word + number coverage), and
//   (c) carry a quote that really occurs in the cited passage (otherwise we substitute the
//       closest real sentence from that passage).
// Statements that fail are dropped from the answer.

const STOP = new Set(
  `a an and are as at be been being by can could did do does for from had has have he her his how i if in into is it its may might more most must no not of on or our shall she should so such than that the their them then there these they this those to was we were what when where which who whom why will with would you your per also any all each other only own same than too very about after before between both during over under up down out off again further once here`.split(/\s+/)
);

export const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

const stem = (t) => (t.length > 4 ? t.replace(/(ing|ed|es|s)$/, '') : t);
const isNum = (t) => /\d/.test(t);

export function contentTokens(s) {
  const raw = norm(s).match(/[a-z0-9]+(?:[.,][0-9]+)*/g) || [];
  return raw
    .map((t) => t.replace(/(\d),(\d)/g, '$1$2'))
    .filter((t) => !STOP.has(t) && (t.length > 2 || isNum(t)));
}

function supportCoverage(statement, sourceTexts) {
  const toks = contentTokens(statement);
  if (!toks.length) return { coverage: 0, numbersOk: true, toks };
  const pool = new Set();
  for (const txt of sourceTexts) for (const t of contentTokens(txt)) pool.add(stem(t)), pool.add(t);
  const hit = toks.filter((t) => pool.has(t) || pool.has(stem(t)));
  const nums = toks.filter(isNum);
  const numbersOk = nums.every((n) => pool.has(n));
  return { coverage: hit.length / toks.length, numbersOk, toks };
}

function bestSentence(statement, passage) {
  const bounds = [0];
  for (const m of passage.matchAll(/(?<=[.!?;])\s+/g)) bounds.push(m.index + m[0].length);
  bounds.push(passage.length);
  const qs = new Set(contentTokens(statement).map(stem));
  let best = { score: -1, start: 0, end: Math.min(passage.length, 250) };
  for (let i = 0; i < bounds.length - 1; i++) {
    const seg = passage.slice(bounds[i], bounds[i + 1]);
    const st = contentTokens(seg).map(stem);
    const score = st.filter((t) => qs.has(t)).length;
    if (score > best.score) best = { score, start: bounds[i], end: bounds[i + 1] };
  }
  // trim to ≤ 300 chars, keep inside the passage
  let { start, end } = best;
  while (start < end && /\s/.test(passage[start])) start++;
  while (end > start && /\s/.test(passage[end - 1])) end--;
  if (end - start > 300) end = start + 300;
  return { start, end };
}

/** Locate `quote` inside `passage` (case/whitespace-insensitive). Returns [start,end] in passage or null. */
function locate(passage, quote) {
  const q = norm(quote);
  if (q.length < 6) return null;
  const idx = norm(passage).indexOf(q);
  if (idx === -1) return null;
  // Passages are stored already whitespace-normalised, so offsets line up 1:1.
  return { start: idx, end: idx + q.length };
}

const MIN_COVERAGE = 0.5;

export function verifyAnswer(parsed, sources) {
  const bySid = new Map(sources.map((s) => [s.sid, s]));
  const verified = [];
  const dropped = [];

  if (!parsed || parsed.answerable === false || !Array.isArray(parsed.statements)) {
    return { verified, dropped, answerable: false };
  }

  for (const st of parsed.statements) {
    const text = String(st?.text || '').replace(/\[\s*S\d+\s*\]/gi, '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const cites = Array.isArray(st.citations) ? st.citations : [];
    const valid = cites.map((c) => ({ ...c, src: bySid.get(String(c?.source || '').trim().toUpperCase()) })).filter((c) => c.src);
    if (!valid.length) {
      dropped.push({ text, reason: 'no valid citation' });
      continue;
    }
    const uniqueSrc = [...new Map(valid.map((c) => [c.src.sid, c])).values()];
    const { coverage, numbersOk } = supportCoverage(text, uniqueSrc.map((c) => c.src.text));
    if (!numbersOk) {
      dropped.push({ text, reason: 'figure not found in cited source' });
      continue;
    }
    if (coverage < MIN_COVERAGE) {
      dropped.push({ text, reason: `not supported by cited source (${Math.round(coverage * 100)}% overlap)` });
      continue;
    }

    const citations = uniqueSrc.map((c) => {
      const passage = c.src.text;
      const exact = c.quote ? locate(passage, c.quote) : null;
      let span;
      let verification;
      if (exact) {
        span = exact;
        verification = 'exact';
      } else {
        span = bestSentence(text, passage);
        verification = 'closest-match';
      }
      return {
        sid: c.src.sid,
        quote: passage.slice(span.start, span.end),
        quoteStart: span.start,
        quoteEnd: span.end,
        verification,
      };
    });
    verified.push({ text, citations, coverage: Number(coverage.toFixed(2)) });
  }
  return { verified, dropped, answerable: true };
}
