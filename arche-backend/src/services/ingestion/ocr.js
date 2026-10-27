// OCR for images using Tesseract.js. The English language data ships in node_modules
// (@tesseract.js-data/eng) so OCR works offline — no downloads at runtime.
import path from 'node:path';
import { createRequire } from 'node:module';
import { createWorker } from 'tesseract.js';
import { env } from '../../config/env.js';
import { normalizeText } from './chunker.js';

const require = createRequire(import.meta.url);
let workerPromise = null;

function getWorker() {
  if (!workerPromise) {
    const langPath = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');
    workerPromise = createWorker('eng', 1, {
      langPath,
      gzip: true,
      cachePath: path.join(env.dataDir, 'tesseract-cache'),
    }).catch((e) => {
      workerPromise = null;
      throw e;
    });
  }
  return workerPromise;
}

export async function ocrImage(filePath) {
  const worker = await getWorker();
  const { data } = await worker.recognize(filePath);
  return { text: normalizeText(data.text), confidence: Math.round(data.confidence || 0) };
}

export async function shutdownOcr() {
  if (workerPromise) {
    const w = await workerPromise.catch(() => null);
    await w?.terminate();
    workerPromise = null;
  }
}
