// Perspective geometry: homographies, quad warping, and the binder grid layout.
import { createRGBA, type RGBAImage } from './image.ts';

export interface Pt {
  x: number;
  y: number;
}

/** Corners in order: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Pt, Pt, Pt, Pt];

/** 3x3 row-major homography. */
export type Homography = Float64Array;

/** Solves A x = b in place with partial pivoting. */
function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-12) throw new Error('degenerate quad');
    [A[c], A[piv]] = [A[piv], A[c]];
    [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x;
}

/** Homography mapping each src[i] to dst[i]. */
export function homography(src: Quad, dst: Quad): Homography {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solveLinear(A, b);
  return Float64Array.from([...h, 1]);
}

export function applyH(H: Homography, x: number, y: number): Pt {
  const w = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
}

export const UNIT_QUAD: Quad = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

/** Maps a point in the unit square onto a quad (perspective-correct). */
export function quadPoint(q: Quad, u: number, v: number): Pt {
  return applyH(homography(UNIT_QUAD, q), u, v);
}

/** The sub-quad of `q` covering unit-square coords [u0,u1] x [v0,v1]. */
export function subQuad(q: Quad, u0: number, v0: number, u1: number, v1: number): Quad {
  const H = homography(UNIT_QUAD, q);
  return [applyH(H, u0, v0), applyH(H, u1, v0), applyH(H, u1, v1), applyH(H, u0, v1)];
}

export function scaleQuad(q: Quad, sx: number, sy: number): Quad {
  return q.map((p) => ({ x: p.x * sx, y: p.y * sy })) as Quad;
}

function dist(a: Pt, b: Pt) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Warps the region of `img` inside `quad` (pixel coords) to an outW x outH
 * rectangle. Supersamples when the source region is much larger than the
 * output, so 4K frames shrink without aliasing.
 */
export function warpQuad(img: RGBAImage, quad: Quad, outW: number, outH: number): RGBAImage {
  const out = createRGBA(outW, outH);
  const dstRect: Quad = [
    { x: 0, y: 0 },
    { x: outW, y: 0 },
    { x: outW, y: outH },
    { x: 0, y: outH },
  ];
  const H = homography(dstRect, quad);
  const srcW = Math.max(dist(quad[0], quad[1]), dist(quad[3], quad[2]));
  const srcH = Math.max(dist(quad[0], quad[3]), dist(quad[1], quad[2]));
  const ss = Math.max(1, Math.min(4, Math.round(Math.max(srcW / outW, srcH / outH))));
  const { width: W, height: Hh, data: d } = img;
  const o = out.data;
  const inv = 1 / (ss * ss);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss;
          const py = y + (sy + 0.5) / ss;
          const den = H[6] * px + H[7] * py + H[8];
          let fx = (H[0] * px + H[1] * py + H[2]) / den - 0.5;
          let fy = (H[3] * px + H[4] * py + H[5]) / den - 0.5;
          fx = Math.min(W - 1.001, Math.max(0, fx));
          fy = Math.min(Hh - 1.001, Math.max(0, fy));
          const x0 = fx | 0;
          const y0 = fy | 0;
          const ax = fx - x0;
          const ay = fy - y0;
          const p00 = (y0 * W + x0) * 4;
          const p10 = p00 + 4;
          const p01 = p00 + W * 4;
          const p11 = p01 + 4;
          const w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay), w01 = (1 - ax) * ay, w11 = ax * ay;
          r += d[p00] * w00 + d[p10] * w10 + d[p01] * w01 + d[p11] * w11;
          g += d[p00 + 1] * w00 + d[p10 + 1] * w10 + d[p01 + 1] * w01 + d[p11 + 1] * w11;
          b += d[p00 + 2] * w00 + d[p10 + 2] * w10 + d[p01 + 2] * w01 + d[p11 + 2] * w11;
        }
      }
      const q = (y * outW + x) * 4;
      o[q] = r * inv;
      o[q + 1] = g * inv;
      o[q + 2] = b * inv;
      o[q + 3] = 255;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Binder layout
// ---------------------------------------------------------------------------

/** Card aspect ratio (width / height) of a standard 63 x 88 mm card. */
export const CARD_ASPECT = 63 / 88;

export interface Calibration {
  /** One quad per binder page, in normalised frame coords (0..1). Left page first. */
  pages: Quad[];
  rows: number;
  cols: number;
}

export type Rotation = 0 | 90 | 180 | 270;

/**
 * A starting layout: two 3x3 pages side by side, filling most of the frame.
 * `rotation` is how far the binder appears rotated (clockwise) in the image,
 * e.g. 90 when the phone streams portrait video but the binder lies across
 * the long side. Corners stay in card order (top-left first), so the warped
 * pockets come out upright whatever the rotation.
 */
export function defaultCalibration(frameW = 16, frameH = 9, rotation: Rotation = 0, pages = 2): Calibration {
  const pageAspect = (3 * 66) / (3 * 92); // pocket pitch incl. seams
  const gap = 0.06; // spine gap, in page heights
  const spreadW = pages * pageAspect + (pages - 1) * gap; // in page heights
  const rotated = rotation === 90 || rotation === 270;
  const availW = rotated ? frameH : frameW;
  const availH = rotated ? frameW : frameH;
  const ph = Math.min(availH * 0.86, (availW * 0.92) / spreadW); // page height in px
  const pw = ph * pageAspect;
  const total = spreadW * ph;
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.round(Math.cos(rad)), sin = Math.round(Math.sin(rad));
  const toFrame = (u: number, v: number): Pt => ({
    // (u, v) are pixel offsets from the frame centre in the binder's own (upright) orientation.
    x: (frameW / 2 + u * cos - v * sin) / frameW,
    y: (frameH / 2 + u * sin + v * cos) / frameH,
  });
  const quads: Quad[] = [];
  for (let p = 0; p < pages; p++) {
    const x0 = -total / 2 + p * (pw + gap * ph);
    const y0 = -ph / 2;
    quads.push([toFrame(x0, y0), toFrame(x0 + pw, y0), toFrame(x0 + pw, y0 + ph), toFrame(x0, y0 + ph)]);
  }
  return { pages: quads, rows: 3, cols: 3 };
}

/**
 * Quads (in pixel coords of a frame `fw` x `fh`) for each pocket, page by page,
 * row by row. `expand` grows each pocket by that fraction of its size on every
 * side, so a card that has slid inside its pocket is still fully captured.
 */
export function pocketQuads(cal: Calibration, fw: number, fh: number, expand = 0.06): Quad[][] {
  return cal.pages.map((page) => {
    const pq = scaleQuad(page, fw, fh);
    const out: Quad[] = [];
    for (let r = 0; r < cal.rows; r++) {
      for (let c = 0; c < cal.cols; c++) {
        const du = expand / cal.cols;
        const dv = expand / cal.rows;
        out.push(subQuad(pq, c / cal.cols - du, r / cal.rows - dv, (c + 1) / cal.cols + du, (r + 1) / cal.rows + dv));
      }
    }
    return out;
  });
}

/** Axis-aligned bounding box of all page quads, in normalised coords, clamped to the frame. */
export function calibrationBounds(cal: Calibration): { x0: number; y0: number; x1: number; y1: number } {
  const pts = cal.pages.flat();
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return {
    x0: Math.max(0, Math.min(...xs)),
    y0: Math.max(0, Math.min(...ys)),
    x1: Math.min(1, Math.max(...xs)),
    y1: Math.min(1, Math.max(...ys)),
  };
}
