// Sentence-aware chunking that keeps exact character offsets into the (normalised) page text,
// so every citation can point at "page N, chars A–B".

export const MAX_CHARS = 900;
const OVERLAP_MAX = 200;

/** Collapse all whitespace so quoting / offsets are unambiguous. */
export function normalizeText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function segments(text) {
  // Lossless split after sentence punctuation + whitespace.
  const bounds = [0];
  for (const m of text.matchAll(/(?<=[.!?])\s+/g)) bounds.push(m.index + m[0].length);
  bounds.push(text.length);
  const segs = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    let start = bounds[i];
    const end = bounds[i + 1];
    // hard-split overly long "sentences" (tables, run-on text) at spaces
    while (end - start > MAX_CHARS) {
      let cut = text.lastIndexOf(' ', start + MAX_CHARS);
      if (cut <= start + MAX_CHARS * 0.5) cut = start + MAX_CHARS;
      segs.push([start, cut]);
      start = cut;
    }
    if (end > start) segs.push([start, end]);
  }
  return segs;
}

/** @returns [{ text, charStart, charEnd }] — text === pageText.slice(charStart, charEnd) */
export function chunkText(pageText, maxChars = MAX_CHARS) {
  const text = pageText;
  if (!text.trim()) return [];
  const segs = segments(text);
  const chunks = [];
  let i = 0;
  while (i < segs.length) {
    let j = i;
    let start = segs[i][0];
    let end = segs[i][1];
    while (j + 1 < segs.length && segs[j + 1][1] - start <= maxChars) {
      j++;
      end = segs[j][1];
    }
    // trim whitespace but keep offsets exact
    let s = start;
    let e = end;
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (e > s) chunks.push({ text: text.slice(s, e), charStart: s, charEnd: e });
    if (j + 1 >= segs.length) break;
    // overlap: re-start from the last segment if it's short
    const last = segs[j];
    i = last[1] - last[0] <= OVERLAP_MAX && j > i ? j : j + 1;
  }
  return chunks;
}
