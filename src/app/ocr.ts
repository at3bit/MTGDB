// Reads the printed card name when the image match is not conclusive.
// Uses Tesseract (WASM) served from /vendor, so nothing goes to a third party.
import { createWorker, PSM, type Worker as TesseractWorker } from 'tesseract.js';
import type { WireImage } from './protocol.ts';

let workerPromise: Promise<TesseractWorker> | null = null;

function vendor(path: string) {
  return new URL(`vendor/tesseract/${path}`, new URL(import.meta.env.BASE_URL, location.href)).href;
}

function getWorker() {
  workerPromise ??= (async () => {
    const w = await createWorker('eng', 1, {
      workerPath: vendor('worker.min.js'),
      corePath: vendor('core'),
      langPath: vendor('lang'),
      workerBlobURL: false,
    });
    await w.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, preserve_interword_spaces: '1' });
    return w;
  })();
  return workerPromise;
}

/** Grayscale + contrast stretch, optionally inverted (for white-on-dark title bars). */
function prepare(img: WireImage, invert: boolean): HTMLCanvasElement {
  const src = new Uint8ClampedArray(img.buffer.slice(0));
  let lo = 255, hi = 0;
  const g = new Float32Array(img.width * img.height);
  for (let i = 0; i < g.length; i++) {
    const v = 0.299 * src[i * 4] + 0.587 * src[i * 4 + 1] + 0.114 * src[i * 4 + 2];
    g[i] = v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < g.length; i++) {
    let v = ((g[i] - lo) / span) * 255;
    if (invert) v = 255 - v;
    src[i * 4] = src[i * 4 + 1] = src[i * 4 + 2] = v;
    src[i * 4 + 3] = 255;
  }
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(new ImageData(src, img.width, img.height), 0, 0);
  return c;
}

export async function readCardName(img: WireImage): Promise<{ text: string; confidence: number }> {
  const w = await getWorker();
  const a = await w.recognize(prepare(img, false));
  let best = { text: a.data.text.trim(), confidence: a.data.confidence };
  if (best.confidence < 70) {
    const b = await w.recognize(prepare(img, true));
    if (b.data.confidence > best.confidence) best = { text: b.data.text.trim(), confidence: b.data.confidence };
  }
  return best;
}
