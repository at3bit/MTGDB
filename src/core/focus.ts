// How sharp the current frame is, page by page.
//
// The camera refocuses after every page turn (a hand passing close to the
// lens, or the page height changing), and an open binder's two page stacks
// sit at different heights, so one page can be sharp while the other isn't.
// The page-turn detector can't see this: a refocus looks like a still page.
// So focus is measured on small full-resolution patches at the centres of
// each page's middle column of pockets, and captures keep the sharpest frame.
import { pocketQuads, type Calibration } from './geometry.ts';
import { laplacianVariance, meanStd, type GrayImage } from './image.ts';

/** A square of frame pixels where focus is measured. */
export interface FocusPatch {
  page: number;
  x: number;
  y: number;
  size: number;
}

/** Patches at the centres of each page's middle-column pockets (at most 160 px, about 40% of a pocket). */
export function focusPatches(cal: Calibration, frameW: number, frameH: number): FocusPatch[] {
  const out: FocusPatch[] = [];
  pocketQuads(cal, frameW, frameH, 0).forEach((quads, page) => {
    for (let row = 0; row < cal.rows; row++) {
      const q = quads[row * cal.cols + Math.floor(cal.cols / 2)];
      if (!q) continue;
      const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
      const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
      const w = Math.min(Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y), Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y));
      const size = Math.max(24, Math.min(160, Math.round(w * 0.4)));
      const x = Math.round(Math.min(frameW - size, Math.max(0, cx - size / 2)));
      const y = Math.round(Math.min(frameH - size, Math.max(0, cy - size / 2)));
      out.push({ page, x, y, size });
    }
  });
  return out;
}

/**
 * Sharpness of a patch: Laplacian energy relative to the patch's brightness,
 * so the camera's exposure changes (a gain) don't count, only blur (focus or
 * motion). Only comparable between frames of the same view.
 */
export function focusScore(g: GrayImage): number {
  const { mean } = meanStd(g);
  return (1000 * laplacianVariance(g)) / (mean * mean + 1);
}

/** Mean patch score per page. */
export function pageFocus(patches: FocusPatch[], scores: number[], pages: number): number[] {
  const sum = new Array(pages).fill(0), n = new Array(pages).fill(0);
  patches.forEach((p, i) => {
    if (p.page >= pages) return;
    sum[p.page] += scores[i];
    n[p.page]++;
  });
  return sum.map((s, i) => (n[i] ? s / n[i] : 0));
}
