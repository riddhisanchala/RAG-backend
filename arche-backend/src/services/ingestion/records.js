// Structured records (CSV / JSON rows) → one retrievable chunk per row, with row-level ACL.
import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import { normalizeText } from './chunker.js';

/** Read a text file whatever Excel/Notepad saved it as: UTF-8 (±BOM), UTF-16 LE/BE, or Windows-1252. */
export function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(buf); // "Save as CSV" in older Excel
  }
}

/** Pick the delimiter (comma, semicolon, tab, pipe) that the header line uses most. */
export function detectDelimiter(text) {
  const head = text.split(/\r?\n/).find((l) => l.trim()) || '';
  const ranked = [',', ';', '\t', '|'].map((d) => [d, head.split(d).length - 1]).sort((x, y) => y[1] - x[1]);
  return ranked[0][1] > 0 ? ranked[0][0] : ',';
}

export function readRows(filePath, ext) {
  const raw = decodeText(fs.readFileSync(filePath));
  if (ext === '.csv') {
    const rows = parse(raw, {
      columns: (header) => {
        const seen = new Map();
        return header.map((h, i) => {
          let name = String(h ?? '').trim() || `column_${i + 1}`;
          const n = (seen.get(name) || 0) + 1; // duplicate headers would silently overwrite each other
          seen.set(name, n);
          return n > 1 ? `${name}_${n}` : name;
        });
      },
      delimiter: detectDelimiter(raw),
      skip_empty_lines: true,
      skip_records_with_empty_values: true,
      bom: true,
      trim: true,
      relax_column_count: true,
      relax_quotes: true,
    });
    return rows;
  }
  const json = JSON.parse(raw);
  const list = Array.isArray(json) ? json : Array.isArray(json?.rows) ? json.rows : Array.isArray(json?.records) ? json.records : null;
  if (!list) throw new Error('JSON must be an array of objects (or {"rows":[…]}).');
  return list.filter((r) => r && typeof r === 'object' && !Array.isArray(r));
}

export function rowToText(table, rowIndex, row) {
  const fields = Object.entries(row)
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('; ');
  return normalizeText(`Record from table "${table}", row ${rowIndex}. ${fields}`);
}

/** One extra chunk describing the whole table, so "how many…", "which columns…", "list all…" can be answered. */
export function tableSummaryText(table, rows) {
  const cols = Object.keys(rows[0]);
  let text = `Table "${table}" overview. It has ${rows.length} rows and ${cols.length} columns: ${cols.join(', ')}.`;
  const first = cols[0];
  const keys = rows.map((r) => String(r[first] ?? '').trim()).filter(Boolean);
  if (keys.length) text += ` Values of "${first}": ${keys.join(', ')}`;
  return normalizeText(text.slice(0, 1800));
}
