// Does the page-turn detector notice the camera refocusing? Compares the detector's
// frame-to-frame score between a sharp frame and defocused copies of the same spread.
import { readdirSync } from 'node:fs';
import sharp from 'sharp';
import { renderSpread } from '../tests/synth.ts';
import { calibrationBounds } from '../src/core/geometry.ts';
import { resampleGray, toGray, type RGBAImage } from '../src/core/image.ts';
import { DEFAULT_MOTION, SpreadWatcher } from '../src/core/motion.ts';
import { meanAbsDiff } from '../src/core/image.ts';
import { normalizeBrightness } from '../src/core/motion.ts';

const scans = readdirSync('data-cache/scans').filter((f) => f.endsWith('.jpg')).slice(0, 18);
const cards = await Promise.all(scans.map(async (f) => {
  const { data, info } = await sharp(`data-cache/scans/${f}`).resize(488, 680, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) } as RGBAImage;
}));
const W = 1920, H = 1080, cardPx = (W * 0.41) / 3;
const thumbs = [0, 0.5, 1, 2, 3].map((pct) => {
  const scene = renderSpread(cards, { width: W, height: H, seed: 7, noise: 3, blur: true, haze: 0.08, defocus: (pct / 100) * cardPx, noiseSeed: 11 + pct * 10 });
  const b = calibrationBounds(scene.calibration);
  return { pct, thumb: resampleGray(toGray(scene.frame), { x: b.x0 * W, y: b.y0 * H, w: (b.x1 - b.x0) * W, h: (b.y1 - b.y0) * H }, 96, 54) };
});
console.log(`detector: moving at >= ${DEFAULT_MOTION.moveThreshold}, still below ${DEFAULT_MOTION.stillThreshold}`);
for (const a of thumbs) {
  const row = thumbs.map((b) => meanAbsDiff(normalizeBrightness(a.thumb), normalizeBrightness(b.thumb)).toFixed(2));
  console.log(`defocus ${a.pct}%: score vs [0%, 0.5%, 1%, 2%, 3%] = ${row.join('  ')}`);
}
// A refocus from 3% to sharp over 6 samples, with the page still: what does the watcher do?
const w = new SpreadWatcher();
const seq = [3, 3, 2, 2, 1, 1, 0.5, 0, 0, 0].map((p) => thumbs.find((t) => t.pct === p)!.thumb);
const events = seq.map((t, i) => { const e = w.push(t); return e ? `${i}:${e.type}` : null; }).filter(Boolean);
console.log(`refocusing 3% -> sharp while the page is still: ${events.join(', ') || 'no events'}`);
