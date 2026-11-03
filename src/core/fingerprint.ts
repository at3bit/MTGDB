// Visual fingerprints for card identification.
//
// A fingerprint is 160 bits (5 x uint32):
//   words 0-1  DCT perceptual hash of the whole card (inside the border)
//   words 2-3  DCT perceptual hash of the art box
//   word  4    colour layout: 2 bits per cell of a 4x4 grid, relative to the
//              card's own average colour (so a warm or cool light cast mostly
//              cancels out)
//
// The same function fingerprints Scryfall's reference scans (at data build
// time) and camera crops (on the phone), which is what makes them comparable.
import { fullRect, resampleGray, resampleRGBA, subRect, toGray, type GrayImage, type RGBAImage, type Rect } from './image.ts';

export const FP_WORDS = 5;

/** Regions as fractions of the full card (edge to edge). Tuned to the modern (2015+) frame; older frames overlap closely enough. */
export const REGION = {
  interior: [0.045, 0.035, 0.955, 0.965] as const,
  art: [0.08, 0.115, 0.92, 0.55] as const,
  /** Title line, used for OCR. Stops before most mana costs. */
  name: [0.065, 0.038, 0.84, 0.098] as const,
};

const N = 32;
const K = 8;
// cos table: COS[u][x] = cos((2x+1) u pi / 2N)
const COS: Float64Array[] = Array.from({ length: K }, (_, u) => {
  const row = new Float64Array(N);
  for (let x = 0; x < N; x++) row[x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
  return row;
});

/** 64-bit pHash (as two uint32) of a 32x32 gray image: low-frequency 8x8 DCT block vs its median, DC excluded. */
export function phash(g: GrayImage): [number, number] {
  if (g.width !== N || g.height !== N) throw new Error('phash expects 32x32');
  // Row transform: R[y][u]
  const R = new Float64Array(N * K);
  for (let y = 0; y < N; y++) {
    for (let u = 0; u < K; u++) {
      let s = 0;
      const c = COS[u];
      const base = y * N;
      for (let x = 0; x < N; x++) s += g.data[base + x] * c[x];
      R[y * K + u] = s;
    }
  }
  const coef: number[] = [];
  for (let v = 0; v < K; v++) {
    for (let u = 0; u < K; u++) {
      if (u === 0 && v === 0) continue;
      let s = 0;
      const c = COS[v];
      for (let y = 0; y < N; y++) s += R[y * K + u] * c[y];
      coef.push(s);
    }
  }
  const sorted = [...coef].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  let hi = 0;
  let lo = 0;
  for (let i = 0; i < coef.length; i++) {
    if (coef[i] > median) {
      if (i < 32) hi |= 1 << i;
      else lo |= 1 << (i - 32);
    }
  }
  return [hi >>> 0, lo >>> 0];
}

function regionRect(card: Rect, r: readonly [number, number, number, number]): Rect {
  return subRect(card, r[0], r[1], r[2], r[3]);
}

function colorLayout(img: RGBAImage, region: Rect): number {
  const small = resampleRGBA(img, region, 4, 4);
  const rg: number[] = [];
  const by: number[] = [];
  for (let i = 0; i < 16; i++) {
    const r = small.data[i * 4], g = small.data[i * 4 + 1], b = small.data[i * 4 + 2];
    rg.push(r - g);
    by.push(b - (r + g) / 2);
  }
  const mrg = rg.reduce((a, b) => a + b, 0) / 16;
  const mby = by.reduce((a, b) => a + b, 0) / 16;
  let w = 0;
  for (let i = 0; i < 16; i++) {
    if (rg[i] > mrg) w |= 1 << (2 * i);
    if (by[i] > mby) w |= 1 << (2 * i + 1);
  }
  return w >>> 0;
}

/**
 * Fingerprint of the card occupying `card` (pixel rect) inside `img`.
 * `gray` may be passed if the caller already has the gray version.
 */
export function fingerprint(img: RGBAImage, card: Rect = fullRect(img), gray?: GrayImage): Uint32Array {
  const g = gray ?? toGray(img);
  const whole = phash(resampleGray(g, regionRect(card, REGION.interior), N, N));
  const art = phash(resampleGray(g, regionRect(card, REGION.art), N, N));
  const col = colorLayout(img, regionRect(card, REGION.interior));
  return Uint32Array.from([whole[0], whole[1], art[0], art[1], col]);
}

export function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24) & 0xff;
}

/** Weighted Hamming distance between query `q` and entry `i` of a packed index. Range 0..144; unrelated cards average ~72. */
export function fpDistance(q: Uint32Array, idx: Uint32Array, i: number): number {
  const o = i * FP_WORDS;
  return (
    popcount32(q[0] ^ idx[o]) +
    popcount32(q[1] ^ idx[o + 1]) +
    popcount32(q[2] ^ idx[o + 2]) +
    popcount32(q[3] ^ idx[o + 3]) +
    0.5 * popcount32(q[4] ^ idx[o + 4])
  );
}

export interface Match {
  card: number;
  d: number;
}

/**
 * Nearest entries to any of the query fingerprints (several crops of the same
 * pocket). Returns the best `k` cards by their minimum distance.
 */
export function nearest(queries: Uint32Array[], idx: Uint32Array, count: number, k: number): Match[] {
  const bestD = new Float32Array(k).fill(Infinity);
  const bestI = new Int32Array(k).fill(-1);
  let worst = Infinity; // bestD[k-1]
  for (let i = 0; i < count; i++) {
    let d = Infinity;
    for (const q of queries) {
      const dq = fpDistance(q, idx, i);
      if (dq < d) d = dq;
    }
    if (d >= worst) continue;
    // insertion into sorted top-k
    let j = k - 1;
    while (j > 0 && bestD[j - 1] > d) {
      bestD[j] = bestD[j - 1];
      bestI[j] = bestI[j - 1];
      j--;
    }
    bestD[j] = d;
    bestI[j] = i;
    worst = bestD[k - 1];
  }
  const out: Match[] = [];
  for (let j = 0; j < k; j++) if (bestI[j] >= 0) out.push({ card: bestI[j], d: bestD[j] });
  return out;
}
