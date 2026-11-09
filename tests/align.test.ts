// Page tracking: the outline is set on the first spread; later spreads have drifted.
import { describe, expect, it } from 'vitest';
import { alignCalibration, DEFAULT_ALIGN, NARROW_ALIGN } from '../src/core/align.ts';
import type { Calibration, Quad } from '../src/core/geometry.ts';
import { makeCard, renderSpread, SCENE_PAGES } from './synth.ts';

const W = 1920, H = 1080;
const cards = Array.from({ length: 18 }, (_, i) => makeCard(700 + i));
const base: Calibration = { pages: SCENE_PAGES, rows: 3, cols: 3 };

function drift(q: Quad, scale: number, dx: number, dy: number): Quad {
  return q.map((p) => ({ x: 0.5 + (p.x - 0.5) * scale + dx, y: 0.5 + (p.y - 0.5) * scale + dy })) as Quad;
}
/** Largest corner error, as a fraction of a card width. */
function error(a: Quad, b: Quad) {
  const cardW = ((SCENE_PAGES[0][1].x - SCENE_PAGES[0][0].x) * W) / 3;
  return Math.max(...a.map((p, i) => Math.hypot((p.x - b[i].x) * W, (p.y - b[i].y) * H))) / cardW;
}

describe('page tracking', () => {
  it('leaves an accurate outline alone', () => {
    const scene = renderSpread(cards, { width: W, height: H, seed: 1, blur: true, noise: 3 });
    const { calibration } = alignCalibration(scene.frame, base);
    calibration.pages.forEach((q, i) => expect(error(q, SCENE_PAGES[i])).toBeLessThan(0.05));
  });

  it('finds pages that grew, shrank and shifted (thick binder, nudged)', () => {
    const truth: Quad[] = [drift(SCENE_PAGES[0], 1.07, 0.012, -0.01), drift(SCENE_PAGES[1], 0.95, 0.012, -0.01)];
    const scene = renderSpread(cards, { width: W, height: H, seed: 2, blur: true, noise: 3, pages: truth });
    const before = truth.map((q, i) => error(SCENE_PAGES[i], q));
    const { calibration } = alignCalibration(scene.frame, base);
    const after = truth.map((q, i) => error(calibration.pages[i], q));
    console.log(`outline error, card widths: before ${before.map((e) => e.toFixed(2))}, after ${after.map((e) => e.toFixed(2))}`);
    before.forEach((e) => expect(e).toBeGreaterThan(0.15));
    after.forEach((e) => expect(e).toBeLessThan(0.06));
  });

  it('follows drift beyond the search range by starting from the previous spread', () => {
    let tracked: Calibration | undefined;
    let last: Quad[] = SCENE_PAGES;
    for (let k = 1; k <= 6; k++) {
      last = [drift(SCENE_PAGES[0], 1 + 0.03 * k, 0.006 * k, 0), drift(SCENE_PAGES[1], 1 - 0.015 * k, 0.006 * k, 0)];
      const scene = renderSpread(cards, { width: W, height: H, seed: 10 + k, blur: true, noise: 3, pages: last });
      tracked = alignCalibration(scene.frame, tracked ?? base, tracked ? NARROW_ALIGN : DEFAULT_ALIGN).calibration;
    }
    const err = last.map((q, i) => error(tracked!.pages[i], q));
    console.log(`after 6 spreads of drift (${last.map((q, i) => error(SCENE_PAGES[i], q).toFixed(2))} card widths), tracking error ${err.map((e) => e.toFixed(2))}`);
    err.forEach((e) => expect(e).toBeLessThan(0.06));
  });
});
