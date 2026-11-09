// Re-finds the binder pages in each captured frame.
//
// The outline is lined up once, on the first spread, but over a long run the
// pages move: the page stacks change height as you turn (the left page gets
// closer to the camera and bigger, the right one smaller), and the binder gets
// nudged. Cards in a 3x3 page make a regular pattern of edges, so for each
// page we look at the edge strength along its rows and columns and find the
// offset and size of the 3x3 grid that best fits them.
import { applyH, homography, scaleQuad, subQuad, warpQuad, type Calibration, type Quad } from './geometry.ts';
import { toGray, type GrayImage, type RGBAImage } from './image.ts';

export interface AlignConfig {
  /** How far around the expected page to look, as a fraction of the page size. */
  margin: number;
  /** Largest shift searched, fraction of page size. */
  maxShift: number;
  /** Size range searched (1 = unchanged). */
  minScale: number;
  maxScale: number;
  /** Gap between a card and its pocket edge, fraction of a pocket (same as RecognizeConfig.inset). */
  inset: number;
  /** A new placement must improve the fit (sum of the two axes' scores) by at least this much to be used. */
  minGain: number;
}

/** From one spread to the next the pages only move a little: search close to where they were. */
export const NARROW_ALIGN_OVERRIDES = { maxShift: 0.06, minScale: 0.94, maxScale: 1.06 };

export const DEFAULT_ALIGN: AlignConfig = {
  margin: 0.2,
  maxShift: 0.16,
  minScale: 0.86,
  maxScale: 1.16,
  inset: 0.02,
  minGain: 0.05,
};

const RECT_W = 300; // rectified page width in pixels

/**
 * Average edge strength across a card (left to right) and down a card (top to
 * bottom), in 64 steps, measured from 288 random Scryfall scans: peaks at the
 * border/frame edges, the name bar, the type line and the bottom edge. Matching
 * this whole pattern locates cards far better than looking for their outlines,
 * which are often faint (black border on a dark binder page).
 */
const CARD_EDGES_X = [0.056,0.099,1.607,2.066,2.583,1.364,1.098,1.197,1.063,1.069,1.067,1.053,1.051,1.068,1.041,1.027,1.025,1.006,1.005,1.01,1.005,1.017,1.022,1.031,1.017,1.017,1.018,1.014,1.018,1.025,1.005,0.997,0.97,0.964,0.961,0.932,0.901,0.865,0.872,0.877,0.87,0.852,0.833,0.823,0.824,0.808,0.813,0.798,0.778,0.787,0.809,0.772,0.748,0.791,0.778,0.749,0.8,0.785,1.022,2.078,1.644,2.211,0.179,0.066];
const CARD_EDGES_Y = [0.046,0.863,2.265,2.238,1.197,1.287,2.091,1.503,0.532,0.573,0.609,0.628,0.65,0.685,0.679,0.691,0.698,0.687,0.698,0.703,0.708,0.697,0.706,0.702,0.718,0.716,0.707,0.703,0.7,0.727,0.715,0.709,0.667,0.68,0.724,1.335,1.968,1.088,1.132,2.323,1.618,0.653,0.998,1.041,1.162,1.141,1.137,1.181,1.108,1.093,1.07,1.112,1.178,1.127,1.093,0.992,0.885,1.146,1.074,2.28,1.14,1.665,0.387,0.023];

interface AxisFit {
  start: number;
  len: number;
  score: number;
  baseScore: number;
}

/** The strong, consistent features of the card edge pattern: bins at least 1.5x the average. */
function peaksOf(card: number[]): { pos: number; weight: number }[] {
  return card.map((v, i) => ({ pos: (i + 0.5) / card.length, weight: v })).filter((p) => p.weight >= 1.5);
}
const PEAKS_X = peaksOf(CARD_EDGES_X);
const PEAKS_Y = peaksOf(CARD_EDGES_Y);

/**
 * Best placement of a row of 3 cards along one axis: the offset and size at
 * which the strong features of the card pattern (border/frame edges, name bar,
 * type line) land on strong edges in the measured profile. Every candidate is
 * scored on the same number of points, so stretching the grid over unrelated
 * edges beyond the page gains nothing.
 */
export function fitAxis(prof: Float32Array, start0: number, len0: number, peaks: { pos: number; weight: number }[], cfg: AlignConfig): AxisFit {
  const n = prof.length;
  // Normalise by the profile's average inside the expected page, so scores from different fits are comparable.
  let mean = 0;
  for (let x = Math.max(0, Math.floor(start0)); x < Math.min(n, start0 + len0); x++) mean += prof[x];
  mean = mean / Math.max(1, len0) || 1;
  const at = (x: number) => {
    const i = Math.round(x);
    if (i < 1 || i >= n - 1) return 0;
    return Math.max(prof[i - 1], prof[i], prof[i + 1]) / mean;
  };
  let wsum = 0;
  for (const p of peaks) wsum += p.weight;
  const score = (start: number, len: number) => {
    const c = len / 3;
    const w = c * (1 - 2 * cfg.inset);
    let s = 0;
    for (let j = 0; j < 3; j++) {
      const cardStart = start + j * c + cfg.inset * c;
      for (const p of peaks) s += p.weight * at(cardStart + p.pos * w);
    }
    return s / (3 * wsum);
  };
  const baseScore = score(start0, len0);
  let best = { start: start0, len: len0, score: baseScore };
  const maxShift = cfg.maxShift * len0;
  for (let sc = cfg.minScale; sc <= cfg.maxScale + 1e-9; sc += 0.004) {
    const len = len0 * sc;
    const centre0 = start0 + len0 / 2;
    for (let d = -maxShift; d <= maxShift; d += 1) {
      const start = centre0 + d - len / 2;
      const s = score(start, len);
      if (s > best.score) best = { start, len, score: s };
    }
  }
  return { ...best, baseScore };
}

function profiles(g: GrayImage, x0: number, x1: number, y0: number, y1: number) {
  const { width: W, height: H, data: d } = g;
  const col = new Float32Array(W);
  const row = new Float32Array(H);
  const ya = Math.max(1, Math.round(y0)), yb = Math.min(H - 1, Math.round(y1));
  const xa = Math.max(1, Math.round(x0)), xb = Math.min(W - 1, Math.round(x1));
  for (let y = ya; y < yb; y++) for (let x = 1; x < W - 1; x++) col[x] += Math.abs(d[y * W + x + 1] - d[y * W + x - 1]);
  for (let x = xa; x < xb; x++) for (let y = 1; y < H - 1; y++) row[y] += Math.abs(d[(y + 1) * W + x] - d[(y - 1) * W + x]);
  const smooth = (p: Float32Array) => {
    const o = new Float32Array(p.length);
    for (let i = 1; i < p.length - 1; i++) o[i] = (p[i - 1] + 2 * p[i] + p[i + 1]) / 4;
    return o;
  };
  return { col: smooth(col), row: smooth(row) };
}

export interface PageAlignment {
  quad: Quad;
  /** How well the placement fits the card edge pattern (sum of the two axes' scores; ~2 = average edges). */
  score: number;
  /** How much the new placement improved the fit (0 = not at all). */
  gain: number;
  /** Largest corner movement, as a fraction of the page width. */
  moved: number;
}

/** Re-fits one page quad (pixel coords) to the cards in the frame. */
export function alignPage(frame: RGBAImage, page: Quad, cfg: AlignConfig = DEFAULT_ALIGN): PageAlignment {
  const m = cfg.margin;
  const outer = subQuad(page, -m, -m, 1 + m, 1 + m);
  const pw = Math.hypot(page[1].x - page[0].x, page[1].y - page[0].y);
  const ph = Math.hypot(page[3].x - page[0].x, page[3].y - page[0].y);
  const rw = Math.round(RECT_W * (1 + 2 * m));
  const rh = Math.round(RECT_W * (ph / pw) * (1 + 2 * m));
  const g = toGray(warpQuad(frame, outer, rw, rh));
  const px0 = RECT_W * m, pw0 = RECT_W;
  const ph0 = RECT_W * (ph / pw), py0 = ph0 * m;
  const { col, row } = profiles(g, px0 + 0.1 * pw0, px0 + 0.9 * pw0, py0 + 0.1 * ph0, py0 + 0.9 * ph0);
  const fx = fitAxis(col, px0, pw0, PEAKS_X, cfg);
  const fy = fitAxis(row, py0, ph0, PEAKS_Y, cfg);
  const gain = fx.score + fy.score - (fx.baseScore + fy.baseScore);
  if (gain < cfg.minGain) return { quad: page, score: fx.baseScore + fy.baseScore, gain, moved: 0 };
  const H = homography([{ x: 0, y: 0 }, { x: rw, y: 0 }, { x: rw, y: rh }, { x: 0, y: rh }], outer);
  const quad: Quad = [
    applyH(H, fx.start, fy.start),
    applyH(H, fx.start + fx.len, fy.start),
    applyH(H, fx.start + fx.len, fy.start + fy.len),
    applyH(H, fx.start, fy.start + fy.len),
  ];
  const moved = Math.max(...quad.map((p, i) => Math.hypot(p.x - page[i].x, p.y - page[i].y))) / pw;
  return { quad, score: fx.score + fy.score, gain, moved };
}

/**
 * Re-fits every page of a calibration (normalised coords) to the frame.
 * Returns the new calibration and, per page, how much it moved.
 */
export function alignCalibration(frame: RGBAImage, cal: Calibration, cfg: AlignConfig = DEFAULT_ALIGN): { calibration: Calibration; pages: PageAlignment[] } {
  const W = frame.width, H = frame.height;
  const pages = cal.pages.map((p) => alignPage(frame, scaleQuad(p, W, H), cfg));
  return {
    calibration: { ...cal, pages: pages.map((a) => scaleQuad(a.quad, 1 / W, 1 / H)) },
    pages,
  };
}


export const NARROW_ALIGN: AlignConfig = { ...DEFAULT_ALIGN, ...NARROW_ALIGN_OVERRIDES };
