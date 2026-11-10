// Page tracking on real card images: with the outline already exactly on the pages, does the tracker
// leave it alone, and does following it across spreads drift? Corner moves in % of a pocket's width.
import { readdirSync } from 'node:fs';
import sharp from 'sharp';
import { alignCalibration, DEFAULT_ALIGN, NARROW_ALIGN } from '../src/core/align.ts';
import type { Calibration } from '../src/core/geometry.ts';
import type { RGBAImage } from '../src/core/image.ts';
import { renderSpread, type RenderOptions } from '../tests/synth.ts';

const scans = readdirSync('data-cache/scans').filter((f) => f.endsWith('.jpg'));
const load = async (f: string): Promise<RGBAImage> => {
  const { data, info } = await sharp(`data-cache/scans/${f}`).resize(488, 680, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) };
};
const SPREADS = 8;
const cards = await Promise.all(scans.slice(0, SPREADS * 18).map(load));
const moved = (a: Calibration, b: Calibration, W: number, H: number) => {
  let worst = 0;
  a.pages.forEach((q, p) => q.forEach((c, i) => {
    const pocketW = (Math.hypot((q[1].x - q[0].x) * W, (q[1].y - q[0].y) * H)) / 3;
    worst = Math.max(worst, (Math.hypot((c.x - b.pages[p][i].x) * W, (c.y - b.pages[p][i].y) * H) / pocketW) * 100);
  }));
  return worst;
};
const conditions: [string, Partial<RenderOptions>][] = [
  ['sharp', {}],
  ['glare + haze', { glare: 0.5, haze: 0.18 }],
  ['defocus 1%', { defocus: 1 }],
  ['defocus 2%', { defocus: 2 }],
  ['defocus 3%', { defocus: 3 }],
  ['cards loose in pockets (4%)', { jitter: 0.04 }],
];
for (const [W, H] of [[3840, 2160], [1920, 1080]]) {
  const cardPx = (W * 0.41) / 3;
  for (const [name, o] of conditions) {
    const first: number[] = [], drift: number[] = [];
    let tracked: Calibration | undefined;
    for (let s = 0; s < SPREADS; s++) {
      const opts: RenderOptions = { width: W, height: H, seed: 40 + s, noise: 3, blur: true, haze: 0.08, jitter: 0.012, ...o, defocus: o.defocus ? (o.defocus / 100) * cardPx : 0 };
      const scene = renderSpread(cards.slice(s * 18, s * 18 + 18), opts);
      const truth = scene.calibration;
      first.push(moved(alignCalibration(scene.frame, truth, DEFAULT_ALIGN).calibration, truth, W, H));
      // Following the pages from spread to spread, as a run does (the scene's pages don't move here).
      tracked = alignCalibration(scene.frame, tracked ?? truth, tracked ? NARROW_ALIGN : DEFAULT_ALIGN).calibration;
      drift.push(moved(tracked, truth, W, H));
    }
    const fmt = (xs: number[]) => `median ${xs.sort((a, b) => a - b)[xs.length >> 1].toFixed(1)}%, worst ${Math.max(...xs).toFixed(1)}%`;
    console.log(`${W}x${H} ${name.padEnd(28)} outline moved from the right place: ${fmt(first)} | after following ${SPREADS} spreads: ${drift[drift.length - 1].toFixed(1)}% (worst along the way ${Math.max(...drift).toFixed(1)}%)`);
  }
}
