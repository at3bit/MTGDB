// Turns captured frames of an open binder into per-pocket card matches.
import { CARD_ASPECT, homography, applyH, pocketQuads, warpQuad, type Calibration, type Quad } from './geometry.ts';
import { glareFraction, laplacianVariance, meanStd, resampleGray, resampleRGBA, toGray, type GrayImage, type RGBAImage, type Rect } from './image.ts';
import { fingerprint, fpDistance, REGION, type Match } from './fingerprint.ts';
import { SYMBOL_H, SYMBOL_REGION, SYMBOL_W } from './symbol.ts';

/** Pocket crops are warped to this size (card aspect, including the expansion margin). */
export const POCKET_W = 264;
export const POCKET_H = Math.round(POCKET_W / CARD_ASPECT);
export const THUMB_W = 146;
export const THUMB_H = 204;
/** OCR crop of the title line. */
export const NAME_W = 480;
export const NAME_H = 52;

export interface RecognizeConfig {
  /** Each pocket is cropped this fraction larger on every side, so a card that slid inside its sleeve is still in view. */
  expand: number;
  /** The card is assumed to fill the pocket minus this fraction per side (seams between pockets). */
  inset: number;
  /** Distance at or below which a match is accepted (0..144, unrelated cards average ~72). */
  acceptDistance: number;
  /** Required gap between the best match and the best match with a different name. */
  acceptMargin: number;
  /** Above this the pocket is "unknown" rather than "uncertain". */
  maybeDistance: number;
  /** A pocket is empty when its fine detail (Laplacian variance at 48x67) is below this. Glare is smooth, so it doesn't count as detail. */
  emptyDetail: number;
}

export const DEFAULT_RECOGNIZE: RecognizeConfig = {
  expand: 0.06,
  inset: 0.02,
  acceptDistance: 44,
  acceptMargin: 6,
  maybeDistance: 58,
  emptyDetail: 150,
};

export type PocketStatus = 'empty' | 'matched' | 'uncertain' | 'unknown';

export interface PocketResult {
  page: number;
  slot: number;
  status: PocketStatus;
  /** Best candidates, nearest first. */
  matches: Match[];
  /** Distance to the nearest candidate with a different name than the best. */
  otherNameDistance: number;
  sharpness: number;
  glare: number;
  thumb: RGBAImage;
  /** Title-line crop for OCR (only for uncertain / unknown pockets). */
  nameCrop?: RGBAImage;
  /** Fingerprint of the best card placement, for re-ranking printings later (e.g. after OCR). */
  query?: Uint32Array;
  /** Mean brightness (0..255) of the card's printed border; tells black-bordered printings from white/gold ones. */
  borderLuma?: number;
  /** The sleeve shows a card back (a card in the sleeve's other side). Status is 'empty'. */
  cardBack?: boolean;
  /** Contrast (std-dev of brightness) of the card; cards seen through extra sleeve layers are flatter. */
  contrast?: number;
  /** Sharp crop of the set-symbol area, for settling look-alike printings (see core/symbol.ts). */
  symbolCrop?: RGBAImage;
}

/** Brightness of the printed border: median of four thin strips just inside the card's edges. */
export function borderLuma(g: GrayImage, w: Rect): number {
  const strip = (fx0: number, fy0: number, fx1: number, fy1: number) => {
    const r = resampleGray(g, { x: w.x + w.w * fx0, y: w.y + w.h * fy0, w: w.w * (fx1 - fx0), h: w.h * (fy1 - fy0) }, 4, 4);
    return r.data.reduce((a, b) => a + b, 0) / r.data.length;
  };
  const sides = [
    strip(0.008, 0.12, 0.03, 0.88),
    strip(0.97, 0.12, 0.992, 0.88),
    strip(0.12, 0.006, 0.88, 0.022),
    strip(0.12, 0.978, 0.88, 0.994),
  ].sort((a, b) => a - b);
  return (sides[1] + sides[2]) / 2;
}

export interface MatchIndex {
  fps: Uint32Array;
  count: number;
  nameOf: Int32Array;
  /** Fingerprint of the Magic card back: a sleeve showing it holds no card on this side. */
  back?: Uint32Array;
}

interface PocketCrop {
  page: number;
  slot: number;
  quad: Quad;
  frame: RGBAImage;
  crop: RGBAImage;
  gray: GrayImage;
  sharpness: number;
  glare: number;
}

function grayRect(g: GrayImage, r: Rect, w: number, h: number) {
  return resampleGray(g, r, w, h);
}

/** Card window inside a pocket crop where the card sits if perfectly centred. */
export function nominalWindow(cfg: RecognizeConfig): Rect {
  const scale = 1 + 2 * cfg.expand;
  const x = ((cfg.expand + cfg.inset) / scale) * POCKET_W;
  const y = ((cfg.expand + cfg.inset) / scale) * POCKET_H;
  return { x, y, w: POCKET_W - 2 * x, h: POCKET_H - 2 * y };
}

/** Looks for the card's outer edges with gradient projections; falls back to null. */
export function edgeWindow(g: GrayImage, nominal: Rect): Rect | null {
  const { width: W, height: H, data: d } = g;
  const colProfile = new Float32Array(W);
  const rowProfile = new Float32Array(H);
  const y0 = Math.round(H * 0.25), y1 = Math.round(H * 0.75);
  const x0 = Math.round(W * 0.25), x1 = Math.round(W * 0.75);
  for (let y = y0; y < y1; y++) for (let x = 1; x < W - 1; x++) colProfile[x] += Math.abs(d[y * W + x + 1] - d[y * W + x - 1]);
  for (let x = x0; x < x1; x++) for (let y = 1; y < H - 1; y++) rowProfile[y] += Math.abs(d[(y + 1) * W + x] - d[(y - 1) * W + x]);
  const argmax = (p: Float32Array, a: number, b: number) => {
    let best = -1, bi = -1;
    for (let i = Math.max(1, Math.round(a)); i <= Math.min(p.length - 2, Math.round(b)); i++) if (p[i] > best) { best = p[i]; bi = i; }
    return bi;
  };
  const sx = W * 0.06, sy = H * 0.06;
  const l = argmax(colProfile, nominal.x - sx, nominal.x + sx);
  const r = argmax(colProfile, nominal.x + nominal.w - sx, nominal.x + nominal.w + sx);
  const t = argmax(rowProfile, nominal.y - sy, nominal.y + sy);
  const b = argmax(rowProfile, nominal.y + nominal.h - sy, nominal.y + nominal.h + sy);
  if (l < 0 || r < 0 || t < 0 || b < 0) return null;
  const w = r - l, h = b - t;
  if (w < nominal.w * 0.88 || w > nominal.w * 1.08 || h < nominal.h * 0.88 || h > nominal.h * 1.08) return null;
  const aspect = w / h / (nominal.w / nominal.h);
  if (aspect < 0.94 || aspect > 1.06) return null;
  return { x: l, y: t, w, h };
}

/** Candidate placements of the card inside its pocket crop. */
export function candidateWindows(g: GrayImage, cfg: RecognizeConfig): Rect[] {
  const n = nominalWindow(cfg);
  const out: Rect[] = [n];
  const edge = edgeWindow(g, n);
  if (edge) out.push(edge);
  const dx = n.w * 0.03, dy = n.h * 0.03;
  for (const [sx, sy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) {
    out.push({ x: n.x + sx * dx, y: n.y + sy * dy, w: n.w, h: n.h });
  }
  for (const s of [0.97, 1.03]) {
    out.push({ x: n.x + (n.w * (1 - s)) / 2, y: n.y + (n.h * (1 - s)) / 2, w: n.w * s, h: n.h * s });
  }
  return out;
}

/** Warps every pocket from every frame and keeps the sharpest, least glary crop of each. */
export function extractPockets(frames: RGBAImage[], cal: Calibration, cfg: RecognizeConfig = DEFAULT_RECOGNIZE): PocketCrop[] {
  const best = new Map<string, PocketCrop>();
  for (const frame of frames) {
    const pages = pocketQuads(cal, frame.width, frame.height, cfg.expand);
    pages.forEach((quads, page) => {
      quads.forEach((quad, slot) => {
        const crop = warpQuad(frame, quad, POCKET_W, POCKET_H);
        const gray = toGray(crop);
        const center = grayRect(gray, nominalWindow(cfg), 96, 134);
        const sharpness = laplacianVariance(center);
        const glare = glareFraction(center);
        const score = sharpness * (1 - Math.min(0.9, glare * 4));
        const key = `${page}:${slot}`;
        const prev = best.get(key);
        const prevScore = prev ? prev.sharpness * (1 - Math.min(0.9, prev.glare * 4)) : -1;
        if (score > prevScore) best.set(key, { page, slot, quad, frame, crop, gray, sharpness, glare });
      });
    });
  }
  return [...best.values()].sort((a, b) => a.page - b.page || a.slot - b.slot);
}

/** Nearest neighbours; when `subset` is given only those entries are scored. */
function nearestIn(queries: Uint32Array[], idx: MatchIndex, k: number, subset?: Int32Array): Match[] {
  const bestD = new Float32Array(k).fill(Infinity);
  const bestI = new Int32Array(k).fill(-1);
  const n = subset ? subset.length : idx.count;
  for (let j = 0; j < n; j++) {
    const i = subset ? subset[j] : j;
    let d = Infinity;
    for (const q of queries) {
      const dq = fpDistance(q, idx.fps, i);
      if (dq < d) d = dq;
    }
    if (d >= bestD[k - 1]) continue;
    let p = k - 1;
    while (p > 0 && bestD[p - 1] > d) {
      bestD[p] = bestD[p - 1];
      bestI[p] = bestI[p - 1];
      p--;
    }
    bestD[p] = d;
    bestI[p] = i;
  }
  const out: Match[] = [];
  for (let p = 0; p < k; p++) if (bestI[p] >= 0) out.push({ card: bestI[p], d: bestD[p] });
  return out;
}

function mapRect(H: Float64Array, r: Rect): Quad {
  return [applyH(H, r.x, r.y), applyH(H, r.x + r.w, r.y), applyH(H, r.x + r.w, r.y + r.h), applyH(H, r.x, r.y + r.h)];
}

export function recognizePocket(pc: PocketCrop, idx: MatchIndex, cfg: RecognizeConfig = DEFAULT_RECOGNIZE): PocketResult {
  const nominal = nominalWindow(cfg);
  const detail = laplacianVariance(grayRect(pc.gray, nominal, 48, 67));
  const thumbOf = (r: Rect) => resampleRGBA(pc.crop, r, THUMB_W, THUMB_H);
  if (detail < cfg.emptyDetail) {
    return { page: pc.page, slot: pc.slot, status: 'empty', matches: [], otherNameDistance: Infinity, sharpness: pc.sharpness, glare: pc.glare, thumb: thumbOf(nominal) };
  }
  const windows = candidateWindows(pc.gray, cfg);
  const fps = windows.map((w) => fingerprint(pc.crop, w, pc.gray));
  // Stage 1: the two most likely placements against the whole index.
  const coarse = nearestIn(fps.slice(0, 2), idx, 300);
  // Stage 2: all placements against the shortlist; remember which window won.
  const subset = Int32Array.from(coarse.map((m) => m.card));
  const matches = nearestIn(fps, idx, 40, subset);
  let bestWindow = nominal;
  let bestK = 0;
  if (matches.length) {
    let bd = Infinity;
    windows.forEach((w, k) => {
      const d = fpDistance(fps[k], idx.fps, matches[0].card);
      if (d < bd) { bd = d; bestWindow = w; bestK = k; }
    });
  }
  const best = matches[0];
  if (idx.back) {
    // An empty sleeve whose other side holds a card shows that card's back.
    const dBack = Math.min(...fps.map((q) => fpDistance(q, idx.back!, 0)));
    if (dBack <= cfg.acceptDistance && (!best || dBack < best.d)) {
      return { page: pc.page, slot: pc.slot, status: 'empty', cardBack: true, matches: [], otherNameDistance: Infinity, sharpness: pc.sharpness, glare: pc.glare, thumb: thumbOf(nominal) };
    }
  }
  const other = best ? matches.find((m) => idx.nameOf[m.card] !== idx.nameOf[best.card]) : undefined;
  const otherD = other ? other.d : best ? best.d + 30 : Infinity;
  let status: PocketStatus = 'unknown';
  if (best && best.d <= cfg.acceptDistance && otherD - best.d >= cfg.acceptMargin) status = 'matched';
  else if (best && best.d <= cfg.maybeDistance) status = 'uncertain';

  // Crops from the full-resolution frame (sharper than the pocket crop): the title line for OCR, the set symbol for printings.
  const H = homography(
    [{ x: 0, y: 0 }, { x: POCKET_W, y: 0 }, { x: POCKET_W, y: POCKET_H }, { x: 0, y: POCKET_H }],
    pc.quad,
  );
  const regionOf = (r: readonly [number, number, number, number]): Rect => ({ x: bestWindow.x + bestWindow.w * r[0], y: bestWindow.y + bestWindow.h * r[1], w: bestWindow.w * (r[2] - r[0]), h: bestWindow.h * (r[3] - r[1]) });
  let nameCrop: RGBAImage | undefined;
  if (status !== 'matched') nameCrop = warpQuad(pc.frame, mapRect(H, regionOf(REGION.name)), NAME_W, NAME_H);
  const symbolCrop = status !== 'unknown' ? warpQuad(pc.frame, mapRect(H, regionOf(SYMBOL_REGION)), SYMBOL_W, SYMBOL_H) : undefined;
  return {
    page: pc.page,
    slot: pc.slot,
    status,
    matches,
    otherNameDistance: otherD,
    sharpness: pc.sharpness,
    glare: pc.glare,
    thumb: thumbOf(bestWindow),
    nameCrop,
    symbolCrop,
    contrast: meanStd(grayRect(pc.gray, bestWindow, 48, 67)).std,
    query: fps[bestK],
    borderLuma: borderLuma(pc.gray, bestWindow),
  };
}

export function recognizeSpread(frames: RGBAImage[], cal: Calibration, idx: MatchIndex, cfg: RecognizeConfig = DEFAULT_RECOGNIZE): PocketResult[] {
  return extractPockets(frames, cal, cfg).map((pc) => recognizePocket(pc, idx, cfg));
}

/**
 * Same-spread check used to merge duplicate captures (e.g. a hand rested on
 * the page, then lifted). True when most pockets matched in both agree.
 */
export function sameSpread(a: PocketResult[], b: PocketResult[], nameOf: Int32Array): boolean {
  let both = 0, agree = 0;
  for (const pa of a) {
    const pb = b.find((p) => p.page === pa.page && p.slot === pa.slot);
    if (!pb || !pa.matches.length || !pb.matches.length) continue;
    if (pa.status === 'empty' || pb.status === 'empty') continue;
    both++;
    if (nameOf[pa.matches[0].card] === nameOf[pb.matches[0].card]) agree++;
  }
  return both >= 3 && agree / both >= 0.5;
}

/** Keeps the better result per pocket from two captures of the same spread. */
export function mergeSpreads(a: PocketResult[], b: PocketResult[]): PocketResult[] {
  const rank = (p: PocketResult) => ({ matched: 3, uncertain: 2, unknown: 1, empty: 0 })[p.status];
  return a.map((pa) => {
    const pb = b.find((p) => p.page === pa.page && p.slot === pa.slot);
    if (!pb) return pa;
    if (rank(pb) !== rank(pa)) return rank(pb) > rank(pa) ? pb : pa;
    const da = pa.matches[0]?.d ?? Infinity;
    const db = pb.matches[0]?.d ?? Infinity;
    return db < da ? pb : pa;
  });
}
