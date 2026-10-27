// PDF text extraction, page by page (so citations can name the page).
import fs from 'node:fs';
import { normalizeText } from './chunker.js';

export async function extractPdfPages(filePath) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(filePath));
  const task = pdfjs.getDocument({ data, useSystemFonts: true, disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  const pages = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const raw = content.items.map((it) => (it.str ?? '') + (it.hasEOL ? '\n' : ' ')).join('');
      pages.push({ page: p, text: normalizeText(raw) });
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return pages;
}
