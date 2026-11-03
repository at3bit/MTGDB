// Minimal image primitives shared by the browser app, the Web Worker, the data
// build script and the tests. Pure TypeScript, no DOM access.

export interface RGBAImage {
  width: number;
  height: number;
  /** Row-major RGBA, 4 bytes per pixel. */
  data: Uint8ClampedArray;
}

export interface GrayImage {
  width: number;
  height: number;
  /** Row-major luminance, 0..255. */
  data: Float32Array;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function createRGBA(width: number, height: number): RGBAImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function createGray(width: number, height: number): GrayImage {
  return { width, height, data: new Float32Array(width * height) };
}

/** Rec. 601 luma. */
export function toGray(img: RGBAImage): GrayImage {
  const out = createGray(img.width, img.height);
  const d = img.data;
  const o = out.data;
  for (let i = 0, p = 0; i < o.length; i++, p += 4) {
    o[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
  }
  return out;
}

/**
 * Builds the resampling weights for one axis. When shrinking, each output
 * sample averages the source pixels its footprint covers (area averaging, so
 * no aliasing). When enlarging, it falls back to linear interpolation.
 */
function axisWeights(srcStart: number, srcLen: number, outLen: number, srcLimit: number) {
  const idx: number[][] = [];
  const wts: number[][] = [];
  const scale = srcLen / outLen;
  for (let o = 0; o < outLen; o++) {
    const a = srcStart + o * scale;
    const b = a + scale;
    const ii: number[] = [];
    const ww: number[] = [];
    if (scale >= 1) {
      let s = Math.floor(a);
      let total = 0;
      for (; s < b; s++) {
        const lo = Math.max(a, s);
        const hi = Math.min(b, s + 1);
        const w = hi - lo;
        if (w <= 0) continue;
        ii.push(Math.min(srcLimit - 1, Math.max(0, s)));
        ww.push(w);
        total += w;
      }
      for (let k = 0; k < ww.length; k++) ww[k] /= total;
    } else {
      const c = a + scale / 2 - 0.5;
      const s0 = Math.floor(c);
      const f = c - s0;
      ii.push(Math.min(srcLimit - 1, Math.max(0, s0)), Math.min(srcLimit - 1, Math.max(0, s0 + 1)));
      ww.push(1 - f, f);
    }
    idx.push(ii);
    wts.push(ww);
  }
  return { idx, wts };
}

/** Resamples a rectangular region of a gray image to outW x outH. */
export function resampleGray(img: GrayImage, region: Rect, outW: number, outH: number): GrayImage {
  const xs = axisWeights(region.x, region.w, outW, img.width);
  const ys = axisWeights(region.y, region.h, outH, img.height);
  // Horizontal pass over only the rows we need.
  const rowsNeeded = new Set<number>();
  for (const r of ys.idx) for (const y of r) rowsNeeded.add(y);
  const tmp = new Map<number, Float32Array>();
  for (const y of rowsNeeded) {
    const row = new Float32Array(outW);
    const base = y * img.width;
    for (let o = 0; o < outW; o++) {
      const ii = xs.idx[o];
      const ww = xs.wts[o];
      let s = 0;
      for (let k = 0; k < ii.length; k++) s += img.data[base + ii[k]] * ww[k];
      row[o] = s;
    }
    tmp.set(y, row);
  }
  const out = createGray(outW, outH);
  for (let oy = 0; oy < outH; oy++) {
    const ii = ys.idx[oy];
    const ww = ys.wts[oy];
    const base = oy * outW;
    for (let ox = 0; ox < outW; ox++) {
      let s = 0;
      for (let k = 0; k < ii.length; k++) s += tmp.get(ii[k])![ox] * ww[k];
      out.data[base + ox] = s;
    }
  }
  return out;
}

/** Resamples a rectangular region of an RGBA image to outW x outH (per channel area averaging). */
export function resampleRGBA(img: RGBAImage, region: Rect, outW: number, outH: number): RGBAImage {
  const xs = axisWeights(region.x, region.w, outW, img.width);
  const ys = axisWeights(region.y, region.h, outH, img.height);
  const out = createRGBA(outW, outH);
  const rowCache = new Map<number, Float32Array>();
  const getRow = (y: number) => {
    let row = rowCache.get(y);
    if (row) return row;
    row = new Float32Array(outW * 4);
    const base = y * img.width * 4;
    for (let o = 0; o < outW; o++) {
      const ii = xs.idx[o];
      const ww = xs.wts[o];
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < ii.length; k++) {
        const p = base + ii[k] * 4;
        const w = ww[k];
        r += img.data[p] * w;
        g += img.data[p + 1] * w;
        b += img.data[p + 2] * w;
        a += img.data[p + 3] * w;
      }
      row[o * 4] = r;
      row[o * 4 + 1] = g;
      row[o * 4 + 2] = b;
      row[o * 4 + 3] = a;
    }
    rowCache.set(y, row);
    return row;
  };
  for (let oy = 0; oy < outH; oy++) {
    const ii = ys.idx[oy];
    const ww = ys.wts[oy];
    const rows = ii.map(getRow);
    const base = oy * outW * 4;
    for (let x = 0; x < outW * 4; x++) {
      let s = 0;
      for (let k = 0; k < rows.length; k++) s += rows[k][x] * ww[k];
      out.data[base + x] = s;
    }
  }
  return out;
}

export function fullRect(img: { width: number; height: number }): Rect {
  return { x: 0, y: 0, w: img.width, h: img.height };
}

/** Fractional sub-rectangle: fractions are relative to `r`. */
export function subRect(r: Rect, fx0: number, fy0: number, fx1: number, fy1: number): Rect {
  return { x: r.x + r.w * fx0, y: r.y + r.h * fy0, w: r.w * (fx1 - fx0), h: r.h * (fy1 - fy0) };
}

export function meanStd(img: GrayImage): { mean: number; std: number } {
  let s = 0;
  let s2 = 0;
  const d = img.data;
  for (let i = 0; i < d.length; i++) {
    s += d[i];
    s2 += d[i] * d[i];
  }
  const mean = s / d.length;
  return { mean, std: Math.sqrt(Math.max(0, s2 / d.length - mean * mean)) };
}

/** Focus measure: variance of the 4-neighbour Laplacian. Higher is sharper. */
export function laplacianVariance(img: GrayImage): number {
  const { width: w, height: h, data: d } = img;
  let s = 0;
  let s2 = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = d[i - 1] + d[i + 1] + d[i - w] + d[i + w] - 4 * d[i];
      s += l;
      s2 += l * l;
      n++;
    }
  }
  if (!n) return 0;
  const m = s / n;
  return s2 / n - m * m;
}

/** Fraction of pixels that are blown out (likely glare off a binder sleeve). */
export function glareFraction(img: GrayImage, threshold = 245): number {
  let c = 0;
  for (let i = 0; i < img.data.length; i++) if (img.data[i] >= threshold) c++;
  return c / img.data.length;
}

/** Mean absolute difference between two same-sized gray images, after normalising each to zero mean / unit std. */
export function normalizedDiff(a: GrayImage, b: GrayImage): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error('size mismatch');
  const ma = meanStd(a);
  const mb = meanStd(b);
  const sa = ma.std || 1;
  const sb = mb.std || 1;
  let s = 0;
  for (let i = 0; i < a.data.length; i++) {
    s += Math.abs((a.data[i] - ma.mean) / sa - (b.data[i] - mb.mean) / sb);
  }
  return s / a.data.length;
}

/** Plain mean absolute difference (0..255). */
export function meanAbsDiff(a: GrayImage, b: GrayImage): number {
  let s = 0;
  for (let i = 0; i < a.data.length; i++) s += Math.abs(a.data[i] - b.data[i]);
  return s / a.data.length;
}
