import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyAnswer } from '../src/services/rag/grounding.js';
import { chunkText } from '../src/services/ingestion/chunker.js';
import { parseModelJson } from '../src/services/rag/prompt.js';

const sources = [
  { sid: 'S1', text: 'Leave policy: Every full-time employee receives 24 days of paid annual leave, 10 days of sick leave and 8 public holidays per calendar year. Unused annual leave up to 10 days can be carried forward to the next year.' },
  { sid: 'S2', text: 'Q3 FY2026 revenue was INR 48.2 crore, an increase of 12 percent compared with Q2. Operating expenses were INR 36.5 crore, giving an operating profit of INR 11.7 crore.' },
];
const mk = (text, source, quote) => ({ answerable: true, statements: [{ text, citations: [{ source, quote }] }] });

test('accepts faithful paraphrases and keeps exact quotes', () => {
  const r = verifyAnswer(mk('Full-time employees get 24 days of paid annual leave each year.', 'S1', 'receives 24 days of paid annual leave'), sources);
  assert.equal(r.verified.length, 1);
  assert.equal(r.verified[0].citations[0].verification, 'exact');
  assert.ok(sources[0].text.includes(r.verified[0].citations[0].quote));

  const r2 = verifyAnswer(mk('Up to 10 unused days of annual leave can be carried over to the following year.', 'S1', 'Unused annual leave up to 10 days can be carried forward'), sources);
  assert.equal(r2.verified.length, 1);
});

test('rejects wrong numbers, unsupported claims, bad source ids', () => {
  assert.equal(verifyAnswer(mk('Employees receive 30 days of paid annual leave.', 'S1', 'receives 24 days'), sources).verified.length, 0, 'wrong number');
  assert.equal(verifyAnswer(mk('Operating profit was INR 15 crore.', 'S2', 'operating profit of INR 11.7 crore'), sources).verified.length, 0, 'wrong figure');
  assert.equal(verifyAnswer(mk('The company offers free lunch and a gym membership to staff.', 'S1', 'free lunch'), sources).verified.length, 0, 'unsupported');
  assert.equal(verifyAnswer(mk('Revenue grew 12 percent.', 'S9', 'x'), sources).verified.length, 0, 'unknown source id');
  assert.equal(verifyAnswer({ answerable: true, statements: [{ text: 'Revenue grew 12 percent.', citations: [] }] }, sources).verified.length, 0, 'no citations');
});

test('fabricated quote is replaced by the closest REAL sentence', () => {
  const r = verifyAnswer(mk('Revenue in Q3 FY2026 was INR 48.2 crore.', 'S2', 'this quote does not exist anywhere'), sources);
  assert.equal(r.verified.length, 1);
  const c = r.verified[0].citations[0];
  assert.equal(c.verification, 'closest-match');
  assert.ok(sources[1].text.includes(c.quote));
  assert.ok(c.quote.includes('48.2'));
});

test('number formats: 1,200,000 vs 1200000', () => {
  const s = [{ sid: 'S1', text: 'base_salary_inr_per_year: 1200000; pay_grade: G5' }];
  assert.equal(verifyAnswer(mk('The base salary is 1,200,000 INR per year.', 'S1', 'base_salary_inr_per_year: 1200000'), s).verified.length, 1);
});

test('chunker keeps exact offsets, never exceeds size, and is lossless', () => {
  const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} talks about topic ${i}.`).join(' ');
  const chunks = chunkText(text);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.equal(text.slice(c.charStart, c.charEnd), c.text);
    assert.ok(c.text.length <= 900);
  }
  assert.equal(chunks[0].charStart, 0);
  assert.equal(chunks.at(-1).charEnd, text.length);
  const long = 'x'.repeat(3000);
  assert.ok(chunkText(long).every((c) => c.text.length <= 900));
});

test('parseModelJson tolerates fences and chatter', () => {
  assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseModelJson('Sure! Here you go: {"a":1} hope that helps'), { a: 1 });
  assert.equal(parseModelJson('no json here'), null);
});
