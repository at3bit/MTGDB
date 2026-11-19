// Turns captured frames of an open binder into per-pocket card matches.
import { CARD_ASPECT, homography, applyH, pocketQuads, warpQuad, type Calibration, type Quad } from './geometry.ts';
import { glareFraction, laplacianVariance, meanStd, resampleGray, toGray, type GrayImage, type RGBAImage, type Rect } from './image.ts';
import { fingerprint, fpDistance, REGION, type Match } from './fingerprint.ts';
import { SYMBOL_H, SYMBOL_REGION, SYMBOL_W } from './symbol.ts';

/** Pocket crops are warped to this size (card aspect, including the expansion margin). */
export const POCKET_W = 264;
export const POCKET_H = Math.round(POCKET_W / CARD_ASPECT);
/** Review photo of each pocket: cut straight from the frame, at most this size (never upscaled past the frame's own pixels). */
export const THUMB_W = 288;
export const THUMB_H = 402;
/** OCR crop of the title line. */
export const NAME_W = 480;
export const NAME_H = 52;
export const INFO_W = 960;
export const INFO_H = 92;

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
  /**
   * A low-detail pocket is only taken for an empty sleeve if it also doesn't confidently match a card:
   * blur lowers detail as much as an empty sleeve does (at 2% defocus the detail test alone missed ~60% of cards).
   * False reproduces the old detail-only test (for comparisons).
   */
  matchLowDetail: boolean;
  /** Cut the title-line crop (for reading the name) for every card, not only those the image match didn't settle. */
  nameCropAll?: boolean;
  /** Also crop the collector line (REGION.info) of each identified card, for reading its printing. */
  infoCrop?: boolean;
  /**
   * How many of the candidate placements build the shortlist against the whole index (the rest only re-rank
   * it); all of them by default. With only the 2 likeliest, cards sitting a little off in their pocket (or an
   * outline a little off) were missed although they matched well: on real photos 3 of 23 cards.
   */
  coarseWindows?: number;
  /** A pocket whose card area is at least this flat and bright holds a blank filler card: empty (see blankFraction). */
  blankFraction: number;
  /** A card outside the binder's colours beats one in them only if it matches better by more than this. */
  categoryLeeway: number;
  /**
   * When a card isn't matched confidently, look again with smaller, shifted card windows (see wideWindows).
   * Pages whose pockets are roomier than the cards leave the card smaller than the outline and resting low
   * in its pocket: on a real binder the first look matched none of 10 such cards; the wider look matched all
   * 10, each by a clear margin, without a colour filter.
   */
  widerSearch: boolean;
  /** ...and its unsure result replaces the first look's only if it's closer by at least this much. */
  widerGain: number;
}

export const DEFAULT_RECOGNIZE: RecognizeConfig = {
  expand: 0.06,
  inset: 0.02,
  acceptDistance: 44,
  acceptMargin: 6,
  maybeDistance: 58,
  emptyDetail: 150,
  matchLowDetail: true,
  // Blank filler cards measured 0.68-0.75 on real photos, real cards at most 0.07; of 3,400 Scryfall
  // images only Scryfall's blank substitute cards (0.40-0.47) come near.
  blankFraction: 0.45,
  categoryLeeway: 6,
  widerSearch: true,
  widerGain: 8,
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
  /** The collector line at the bottom of the card (see REGION.info), when asked for. */
  infoCrop?: RGBAImage;
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
  /** Identified although the photo of it is blurry (too little fine detail): worth a re-snap. */
  blurry?: boolean;
  /** Empty: the sleeve holds a blank filler card. */
  blank?: boolean;
  /** Best match is outside the colours/types the binder was said to hold. */
  offCategory?: boolean;
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
  /** Only these printings may be returned (1 = allowed); e.g. English only. */
  allowed?: Uint8Array | null;
  /** Printings in the binder's colours/types (1 = preferred); see CardDB.setCategories. */
  preferred?: Uint8Array | null;
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

/**
 * Share of a card window (gray, ~48x67) that is flat and bright: a blank filler card in an empty
 * sleeve. Real cards have texture almost everywhere (art, text, frame); glare is small and saturated.
 */
export function blankFraction(g: GrayImage): number {
  const { width: w, height: h, data: d } = g;
  let flat = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      let s = 0, s2 = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const v = d[i + dy * w + dx];
        s += v;
        s2 += v * v;
      }
      const mean = s / 9;
      const std = Math.sqrt(Math.max(0, s2 / 9 - mean * mean));
      if (mean > 150 && mean < 250 && std < 3) flat++;
      n++;
    }
  }
  return n ? flat / n : 0;
}

/**
 * The binder's colours/types first: a card in them wins unless one outside them matches better by more
 * than `leeway`; then it's `offCategory`. Without a preference the order is unchanged.
 */
export function rankByCategory(matches: Match[], preferred: Uint8Array | null | undefined, leeway: number): { matches: Match[]; offCategory: boolean } {
  if (!preferred || !matches.length) return { matches, offCategory: false };
  const inCat = matches.filter((m) => preferred[m.card]);
  const outCat = matches.filter((m) => !preferred[m.card]);
  if (inCat.length && (!outCat.length || inCat[0].d <= outCat[0].d + leeway)) return { matches: [...inCat, ...outCat], offCategory: false };
  return { matches, offCategory: true };
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

/**
 * The second look (see RecognizeConfig.widerSearch): the card at 94%, 90% and 86% of the nominal window,
 * nudged 4% left or right and 3% up or 1.5% or 6% down. 27 windows.
 */
export function wideWindows(cfg: RecognizeConfig): Rect[] {
  const n = nominalWindow(cfg);
  const out: Rect[] = [];
  for (const s of [0.94, 0.9, 0.86]) {
    for (const dx of [-0.04, 0, 0.04]) {
      for (const dy of [-0.03, 0.015, 0.06]) {
        const w = n.w * s, h = n.h * s;
        out.push({ x: n.x + (n.w - w) / 2 + dx * n.w, y: n.y + (n.h - h) / 2 + dy * n.h, w, h });
      }
    }
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
  const allowed = idx.allowed;
  for (let j = 0; j < n; j++) {
    const i = subset ? subset[j] : j;
    if (allowed && !allowed[i]) continue;
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
  // Pocket-crop coordinates -> frame coordinates, for crops taken straight from the full-resolution frame.
  const H = homography(
    [{ x: 0, y: 0 }, { x: POCKET_W, y: 0 }, { x: POCKET_W, y: POCKET_H }, { x: 0, y: POCKET_H }],
    pc.quad,
  );
  const thumbOf = (r: Rect) => {
    const q = mapRect(H, r);
    const native = Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y);
    const w = Math.max(96, Math.min(THUMB_W, Math.round(native)));
    return warpQuad(pc.frame, q, w, Math.round((w * THUMB_H) / THUMB_W));
  };
  const lowDetail = detail < cfg.emptyDetail;
  const empty = (): PocketResult => ({ page: pc.page, slot: pc.slot, status: 'empty', matches: [], otherNameDistance: Infinity, sharpness: pc.sharpness, glare: pc.glare, thumb: thumbOf(nominal) });
  if (lowDetail && !cfg.matchLowDetail) return empty();
  // A blank filler card in an empty sleeve (the card behind may show at its edges).
  if (blankFraction(grayRect(pc.gray, nominal, 48, 67)) >= cfg.blankFraction) return { ...empty(), blank: true };
  const windows = candidateWindows(pc.gray, cfg);
  const fps = windows.map((w) => fingerprint(pc.crop, w, pc.gray));
  const pref = idx.preferred;
  /** Shortlist against the whole index with the first `coarseN` windows, then rank it with all of them. */
  const search = (ws: Rect[], qs: Uint32Array[], coarseN: number) => {
    // Stage 1: placements against the whole index, for a shortlist.
    const coarse = nearestIn(qs.slice(0, coarseN), idx, 300);
    // Stage 2: all placements against the shortlist; remember which window won.
    const subset = Int32Array.from(coarse.map((m) => m.card));
    const ranked = rankByCategory(nearestIn(qs, idx, 40, subset), pref, cfg.categoryLeeway);
    let bestWindow = nominal;
    let bestK = 0;
    if (ranked.matches.length) {
      let bd = Infinity;
      ws.forEach((w, k) => {
        const d = fpDistance(qs[k], idx.fps, ranked.matches[0].card);
        if (d < bd) { bd = d; bestWindow = w; bestK = k; }
      });
    }
    const best = ranked.matches[0];
    // How sure: the gap to the next different card (of the binder's colours, when it's one of them).
    const rivals = pref && best && pref[best.card] ? ranked.matches.filter((m) => pref[m.card]) : ranked.matches;
    const other = best ? rivals.find((m) => idx.nameOf[m.card] !== idx.nameOf[best.card]) : undefined;
    const otherD = other ? other.d : best ? best.d + 30 : Infinity;
    const confident = !!best && best.d <= cfg.acceptDistance && otherD - best.d >= cfg.acceptMargin;
    let status: PocketStatus = 'unknown';
    if (confident) status = 'matched';
    else if (best && best.d <= cfg.maybeDistance) status = 'uncertain';
    // Not one of the binder's colours: worth a look (misfiled, or the colours were set wrong).
    if (ranked.offCategory && status === 'matched') status = 'uncertain';
    return { matches: ranked.matches, offCategory: ranked.offCategory, bestWindow, bestK, otherD, confident, status, qs };
  };
  let found = search(windows, fps, cfg.coarseWindows ?? fps.length);
  if (idx.back) {
    // An empty sleeve whose other side holds a card shows that card's back.
    const best = found.matches[0];
    const dBack = Math.min(...fps.map((q) => fpDistance(q, idx.back!, 0)));
    if (dBack <= cfg.acceptDistance && (!best || dBack < best.d)) {
      return { page: pc.page, slot: pc.slot, status: 'empty', cardBack: true, matches: [], otherNameDistance: Infinity, sharpness: pc.sharpness, glare: pc.glare, thumb: thumbOf(nominal) };
    }
  }
  // Not sure: look again with the card smaller and shifted in its window (not for a blank-looking pocket,
  // which is most likely an empty sleeve, to keep scanning quick).
  if (cfg.widerSearch && found.status !== 'matched' && !lowDetail) {
    const wide = wideWindows(cfg);
    const ws = [...windows, ...wide];
    const qs = [...fps, ...wide.map((w) => fingerprint(pc.crop, w, pc.gray))];
    const again = search(ws, qs, qs.length);
    const rank = { matched: 3, uncertain: 2, unknown: 1, empty: 0 } as const;
    const d = (f: typeof found) => f.matches[0]?.d ?? Infinity;
    // More windows also let a wrong card fit a little better by chance (a real Chill Haunting, right but
    // unsure at 36, lost to Sick and Tired at 32): the second look counts only when it's clearly better.
    if (again.status === 'matched' || (rank[again.status] >= rank[found.status] && d(again) <= d(found) - cfg.widerGain)) found = again;
  }
  const { matches, offCategory, bestWindow, bestK, otherD } = found;
  if (lowDetail && !found.confident) return empty();
  const status = found.status;

  // Crops from the full-resolution frame (sharper than the pocket crop): the title line for OCR, the set symbol for printings.
  const regionOf = (r: readonly [number, number, number, number]): Rect => ({ x: bestWindow.x + bestWindow.w * r[0], y: bestWindow.y + bestWindow.h * r[1], w: bestWindow.w * (r[2] - r[0]), h: bestWindow.h * (r[3] - r[1]) });
  let nameCrop: RGBAImage | undefined;
  if (status !== 'matched' || cfg.nameCropAll) nameCrop = warpQuad(pc.frame, mapRect(H, regionOf(REGION.name)), NAME_W, NAME_H);
  const symbolCrop = status !== 'unknown' ? warpQuad(pc.frame, mapRect(H, regionOf(SYMBOL_REGION)), SYMBOL_W, SYMBOL_H) : undefined;
  const infoCrop = cfg.infoCrop && status !== 'unknown' ? warpQuad(pc.frame, mapRect(H, regionOf(REGION.info)), INFO_W, INFO_H) : undefined;
  return {
    page: pc.page,
    slot: pc.slot,
    status,
    blurry: lowDetail || undefined,
    offCategory: offCategory || undefined,
    matches,
    otherNameDistance: otherD,
    sharpness: pc.sharpness,
    glare: pc.glare,
    thumb: thumbOf(bestWindow),
    nameCrop,
    infoCrop,
    symbolCrop,
    contrast: meanStd(grayRect(pc.gray, bestWindow, 48, 67)).std,
    query: found.qs[bestK],
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
