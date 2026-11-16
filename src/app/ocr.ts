// Reads the printed card name when the image match is not conclusive.
// Uses Tesseract (WASM) served from /vendor, so nothing goes to a third party.
import { createWorker, PSM, type Worker as TesseractWorker } from 'tesseract.js';
import type { WireImage } from './protocol.ts';

let workerPromise: Promise<TesseractWorker> | null = null;
/** Page segmentation the worker is set to: one line for names, a block for the collector line. */
let mode: PSM | null = null;
async function setMode(w: TesseractWorker, m: PSM) {
  if (mode === m) return;
  await w.setParameters({ tessedit_pageseg_mode: m });
  mode = m;
}
/** Names read by the current worker, and reads in progress. */
let used = 0;
let busy = 0;
/**
 * Tesseract's memory (a WebAssembly heap) only ever grows, and a big binder means a thousand or more reads:
 * start a fresh worker every so often so the phone doesn't run out of memory part-way through.
 */
const RECYCLE_AFTER = 120;

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
    mode = PSM.SINGLE_LINE;
    return w;
  })();
  return workerPromise;
}

/** Grayscale + contrast stretch, optionally inverted (for white-on-dark title bars), optionally scaled up. */
function prepare(img: WireImage, invert: boolean, scale = 1): HTMLCanvasElement {
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
  if (scale === 1) return c;
  const big = document.createElement('canvas');
  big.width = Math.round(img.width * scale);
  big.height = Math.round(img.height * scale);
  const ctx = big.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(c, 0, 0, big.width, big.height);
  c.width = c.height = 0;
  return big;
}

/** Pixels of a name crop that arrived as a JPEG. */
async function pixels(img: WireImage | Blob): Promise<WireImage> {
  if (!(img instanceof Blob)) return img;
  const bmp = await createImageBitmap(img);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const data = ctx.getImageData(0, 0, c.width, c.height);
  c.width = c.height = 0;
  return { width: data.width, height: data.height, buffer: data.data.buffer as ArrayBuffer };
}

export async function readCardName(crop: WireImage | Blob): Promise<{ text: string; confidence: number }> {
  return recycling(() => readName(crop));
}

/**
 * Reads the collector line at the bottom of a card ("079/249 U" over "MM2 • EN", or a copyright line
 * ending "61/145"): small print, so scaled up 2x and read as a block of lines.
 */
export async function readCollectorLine(crop: WireImage | Blob): Promise<string> {
  return recycling(async () => {
    const img = await pixels(crop);
    const w = await getWorker();
    await setMode(w, PSM.SINGLE_BLOCK);
    const c = prepare(img, false, 2);
    used++;
    try {
      return (await w.recognize(c)).data.text.replace(/\s+/g, ' ').trim();
    } finally {
      c.width = c.height = 0;
    }
  });
}

async function recycling<T>(fn: () => Promise<T>): Promise<T> {
  busy++;
  try {
    return await fn();
  } finally {
    busy--;
    if (used >= RECYCLE_AFTER && busy === 0 && workerPromise) {
      const old = workerPromise;
      workerPromise = null;
      mode = null;
      used = 0;
      void old.then((w) => w.terminate()).catch(() => {});
    }
  }
}

async function readName(crop: WireImage | Blob): Promise<{ text: string; confidence: number }> {
  const img = await pixels(crop);
  const w = await getWorker();
  await setMode(w, PSM.SINGLE_LINE);
  // Free each canvas as soon as it's read: iOS counts canvases against a memory limit until they're collected.
  const read = async (invert: boolean) => {
    const c = prepare(img, invert);
    used++;
    try {
      return (await w.recognize(c)).data;
    } finally {
      c.width = c.height = 0;
    }
  };
  const a = await read(false);
  let best = { text: a.text.trim(), confidence: a.confidence };
  if (best.confidence < 70) {
    const b = await read(true);
    if (b.confidence > best.confidence) best = { text: b.text.trim(), confidence: b.confidence };
  }
  return best;
}
