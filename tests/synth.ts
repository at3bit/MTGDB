// Synthetic test fixtures: procedurally generated card-like images rendered
// into a fake binder spread. These exercise the geometry, page-turn and
// matching code end to end. They are NOT real cards and say nothing about
// accuracy on real Magic cards (that needs the Scryfall-built index).
import { createRGBA, resampleRGBA, fullRect, type RGBAImage } from '../src/core/image.ts';
import { homography, applyH, subQuad, type Quad, type Calibration } from '../src/core/geometry.ts';

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type RGB = [number, number, number];

function fillRect(img: RGBAImage, x0: number, y0: number, x1: number, y1: number, c: RGB) {
  for (let y = Math.max(0, Math.round(y0)); y < Math.min(img.height, Math.round(y1)); y++) {
    for (let x = Math.max(0, Math.round(x0)); x < Math.min(img.width, Math.round(x1)); x++) {
      const p = (y * img.width + x) * 4;
      img.data[p] = c[0];
      img.data[p + 1] = c[1];
      img.data[p + 2] = c[2];
      img.data[p + 3] = 255;
    }
  }
}

function hsl(h: number, s: number, l: number): RGB {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/** A card-like image: black border, coloured frame, title bar, art box with random shapes, text box. */
export function makeCard(seed: number, w = 488, h = 680): RGBAImage {
  const r = rng(seed);
  const img = createRGBA(w, h);
  fillRect(img, 0, 0, w, h, [12, 12, 14]);
  const frame = hsl(r(), 0.35 + r() * 0.4, 0.35 + r() * 0.3);
  fillRect(img, w * 0.045, h * 0.032, w * 0.955, h * 0.968, frame);
  const bar: RGB = [225 + r() * 25, 220 + r() * 25, 200 + r() * 30] as RGB;
  const textMarks = (x0: number, y0: number, x1: number, y1: number) => {
    let x = x0;
    while (x < x1) {
      const lw = (0.006 + r() * 0.02) * w;
      if (r() > 0.18) fillRect(img, x, y0, Math.min(x1, x + lw), y1, [25, 22, 20]);
      x += lw + 0.004 * w;
    }
  };
  // Title bar with "name" marks of random length.
  fillRect(img, w * 0.06, h * 0.038, w * 0.94, h * 0.098, bar);
  textMarks(w * 0.08, h * 0.05, w * (0.3 + r() * 0.45), h * 0.085);
  // Art: gradient + ellipses.
  const ax0 = w * 0.08, ay0 = h * 0.112, ax1 = w * 0.92, ay1 = h * 0.552;
  const c1 = hsl(r(), 0.3 + r() * 0.6, 0.2 + r() * 0.6);
  const c2 = hsl(r(), 0.3 + r() * 0.6, 0.2 + r() * 0.6);
  for (let y = Math.round(ay0); y < ay1; y++) {
    const t = (y - ay0) / (ay1 - ay0);
    fillRect(img, ax0, y, ax1, y + 1, [c1[0] * (1 - t) + c2[0] * t, c1[1] * (1 - t) + c2[1] * t, c1[2] * (1 - t) + c2[2] * t] as RGB);
  }
  const shapes = 5 + Math.floor(r() * 8);
  for (let s = 0; s < shapes; s++) {
    const cx = ax0 + r() * (ax1 - ax0), cy = ay0 + r() * (ay1 - ay0);
    const rx = (0.05 + r() * 0.25) * w, ry = (0.03 + r() * 0.15) * h;
    const c = hsl(r(), 0.2 + r() * 0.8, 0.1 + r() * 0.8);
    for (let y = Math.max(Math.round(ay0), Math.round(cy - ry)); y < Math.min(ay1, cy + ry); y++) {
      for (let x = Math.max(Math.round(ax0), Math.round(cx - rx)); x < Math.min(ax1, cx + rx); x++) {
        const dx = (x - cx) / rx, dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1) fillRect(img, x, y, x + 1, y + 1, c);
      }
    }
  }
  // Type line and rules text.
  fillRect(img, w * 0.06, h * 0.56, w * 0.94, h * 0.615, bar);
  textMarks(w * 0.08, h * 0.572, w * (0.3 + r() * 0.4), h * 0.6);
  fillRect(img, w * 0.075, h * 0.625, w * 0.925, h * 0.9, [238, 232, 218]);
  const lines = 2 + Math.floor(r() * 5);
  for (let l = 0; l < lines; l++) {
    const y = h * (0.64 + l * 0.045);
    textMarks(w * 0.09, y, w * (0.5 + r() * 0.4), y + h * 0.022);
  }
  return img;
}

/** Scryfall "small" images are 146x204; fingerprints in the real index come from those. */
export function toReferenceSize(card: RGBAImage): RGBAImage {
  return resampleRGBA(card, fullRect(card), 146, 204);
}

export interface SpreadScene {
  /** Page quads in normalised coords, as a user would calibrate them (outer corners of the corner cards' pockets). */
  calibration: Calibration;
  frame: RGBAImage;
}

export interface RenderOptions {
  width: number;
  height: number;
  seed: number;
  noise?: number;
  blur?: boolean;
  glare?: number;
  /** Max random shift of each card inside its pocket, fraction of card size. */
  jitter?: number;
  exposure?: number;
  cast?: RGB;
  /** Calibration error: random offset applied to the calibration corners (normalised). */
  calibError?: number;
  /** Seed for per-frame sensor noise only (layout stays the same). Defaults to `seed`. */
  noiseSeed?: number;
  /** Optional occluder (e.g. a hand) as a dark ellipse in normalised coords. */
  occluder?: { x: number; y: number; rx: number; ry: number };
}

export const SCENE_PAGES: Quad[] = [
  [{ x: 0.075, y: 0.075 }, { x: 0.485, y: 0.07 }, { x: 0.488, y: 0.935 }, { x: 0.068, y: 0.925 }],
  [{ x: 0.515, y: 0.07 }, { x: 0.925, y: 0.078 }, { x: 0.932, y: 0.928 }, { x: 0.512, y: 0.935 }],
];

function drawQuad(dst: RGBAImage, src: RGBAImage, quad: Quad) {
  const Hm = homography(quad, [{ x: 0, y: 0 }, { x: src.width, y: 0 }, { x: src.width, y: src.height }, { x: 0, y: src.height }]);
  const xs = quad.map((p) => p.x), ys = quad.map((p) => p.y);
  for (let y = Math.max(0, Math.floor(Math.min(...ys))); y < Math.min(dst.height, Math.ceil(Math.max(...ys))); y++) {
    for (let x = Math.max(0, Math.floor(Math.min(...xs))); x < Math.min(dst.width, Math.ceil(Math.max(...xs))); x++) {
      const s = applyH(Hm, x + 0.5, y + 0.5);
      if (s.x < 0 || s.y < 0 || s.x >= src.width || s.y >= src.height) continue;
      const sp = ((s.y | 0) * src.width + (s.x | 0)) * 4;
      const dp = (y * dst.width + x) * 4;
      dst.data[dp] = src.data[sp];
      dst.data[dp + 1] = src.data[sp + 1];
      dst.data[dp + 2] = src.data[sp + 2];
      dst.data[dp + 3] = 255;
    }
  }
}

/** Renders an open binder (two 3x3 pages) holding `cards` (null = empty pocket). */
export function renderSpread(cards: (RGBAImage | null)[], o: RenderOptions): SpreadScene {
  const r = rng(o.seed);
  const W = o.width, H = o.height;
  const frame = createRGBA(W, H);
  fillRect(frame, 0, 0, W, H, [118, 86, 60]); // table
  const px = (q: Quad): Quad => q.map((p) => ({ x: p.x * W, y: p.y * H })) as Quad;
  for (const page of SCENE_PAGES) {
    const outer = subQuad(px(page), -0.03, -0.025, 1.03, 1.025);
    drawQuad(frame, (() => { const i = createRGBA(4, 4); fillRect(i, 0, 0, 4, 4, [28, 28, 32]); return i; })(), outer);
  }
  const jitter = o.jitter ?? 0.015;
  SCENE_PAGES.forEach((page, pi) => {
    for (let s = 0; s < 9; s++) {
      const card = cards[pi * 9 + s];
      if (!card) continue;
      const row = Math.floor(s / 3), col = s % 3;
      const inset = 0.02;
      const jx = (r() * 2 - 1) * jitter, jy = (r() * 2 - 1) * jitter;
      const q = subQuad(px(page), (col + inset + jx) / 3, (row + inset + jy) / 3, (col + 1 - inset + jx) / 3, (row + 1 - inset + jy) / 3);
      drawQuad(frame, card, q);
    }
  });
  // Optional occluder (hand).
  if (o.occluder) {
    const { x, y, rx, ry } = o.occluder;
    for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) {
      const dx = (xx / W - x) / rx, dy = (yy / H - y) / ry;
      if (dx * dx + dy * dy <= 1) fillRect(frame, xx, yy, xx + 1, yy + 1, [196, 150, 120]);
    }
  }
  // Blur (3x3 box) to mimic optics.
  if (o.blur) {
    const src = new Uint8ClampedArray(frame.data);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += src[((y + dy) * W + x + dx) * 4 + c];
      frame.data[(y * W + x) * 4 + c] = s / 9;
    }
  }
  const exposure = o.exposure ?? 1;
  const cast = o.cast ?? [1, 1, 1];
  const noise = o.noise ?? 0;
  const glare = o.glare ?? 0;
  const gx = 0.3 + r() * 0.4, gy = 0.3 + r() * 0.4, gr = 0.08;
  const nr = o.noiseSeed === undefined ? r : rng(o.noiseSeed);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = (y * W + x) * 4;
    const dx = x / W - gx, dy = (y / H - gy) * (H / W);
    const gl = glare * Math.exp(-(dx * dx + dy * dy) / (gr * gr));
    for (let c = 0; c < 3; c++) {
      const n = noise ? (nr() + nr() + nr() - 1.5) * 2 * noise : 0;
      const v = frame.data[p + c] * exposure * cast[c] + n;
      frame.data[p + c] = v + (255 - v) * gl;
    }
  }
  const err = o.calibError ?? 0;
  const calPages = SCENE_PAGES.map((q) => q.map((p) => ({ x: p.x + (r() * 2 - 1) * err, y: p.y + (r() * 2 - 1) * err })) as Quad);
  return { frame, calibration: { pages: calPages, rows: 3, cols: 3 } };
}
