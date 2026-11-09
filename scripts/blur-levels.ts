// Renders one real card at 4K binder scale with increasing defocus and reports what the recognizer makes of it.
// Uses card scans cached in data-cache/scans (npm run eval -- --symbol fills it).  npx tsx scripts/blur-levels.ts out.png
import sharp from 'sharp';
import { readdirSync, readFileSync } from 'node:fs';
import { renderSpread } from '../tests/synth.ts';
import { recognizeSpread, DEFAULT_RECOGNIZE } from '../src/core/recognize.ts';
import { CardDB, decodeFingerprints, type CardsFile } from '../src/core/carddb.ts';
import type { RGBAImage } from '../src/core/image.ts';
const root = '/home/user/MTGDB';
const out = process.argv[2];
const file = JSON.parse(readFileSync(`${root}/public/data/cards.json`, 'utf8')) as CardsFile;
const fpBuf = readFileSync(`${root}/public/data/fingerprints.bin`);
const db = new CardDB(file, decodeFingerprints(fpBuf.buffer.slice(fpBuf.byteOffset, fpBuf.byteOffset + fpBuf.byteLength) as ArrayBuffer));
const byId = new Map(file.cards.map((c, i) => [c[0], i]));
const scans = readdirSync(`${root}/data-cache/scans`).filter((f) => f.endsWith('.jpg') && byId.has(f.slice(0, -4)) && (file.cards[byId.get(f.slice(0, -4))!][6] ?? 0) > 3).slice(0, 18);
const load = async (f: string): Promise<RGBAImage> => {
  const { data, info } = await sharp(`${root}/data-cache/scans/${f}`).resize(488, 680, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) };
};
const cards = await Promise.all(scans.map(load));
const W = 3840, H = 2160, cardPx = (W * 0.41) / 3;
const tiles: Buffer[] = [];
const labels: string[] = [];
for (const pct of [0, 1, 2, 3]) {
  const scene = renderSpread(cards, { width: W, height: H, seed: 7, noise: 3, blur: true, haze: 0.08, jitter: 0.01, defocus: (pct / 100) * cardPx });
  const res = recognizeSpread([scene.frame], scene.calibration, { fps: db.fps, count: db.count, nameOf: db.nameOf, back: db.back }, DEFAULT_RECOGNIZE);
  const p = res[4];
  const truth = byId.get(scans[4].slice(0, -4))!;
  const verdict = p.status === 'empty' ? 'EMPTY SLEEVE' : `${p.status}: ${db.names[db.nameOf[p.matches[0].card]]}${db.nameOf[p.matches[0].card] === db.nameOf[truth] ? ' (right)' : ' (WRONG)'}`;
  const sum = (s: string) => res.filter((r) => r.status === s).length;
  labels.push(`${pct}% defocus: middle card -> ${verdict}; whole page: ${sum('matched')} matched, ${sum('empty')} empty of 18`);
  // Crop the middle pocket of the left page from the frame at native 4K pixels.
  const q = scene.calibration.pages[0];
  const x0 = (q[0].x + (q[1].x - q[0].x) / 3) * W, y0 = (q[0].y + (q[3].y - q[0].y) / 3) * H;
  const w = ((q[1].x - q[0].x) / 3) * W, h = ((q[3].y - q[0].y) / 3) * H;
  const crop = await sharp(Buffer.from(scene.frame.data.buffer), { raw: { width: W, height: H, channels: 4 } }).extract({ left: Math.round(x0), top: Math.round(y0), width: Math.round(w), height: Math.round(h) }).resize(300).png().toBuffer();
  tiles.push(crop);
}
const meta = await sharp(tiles[0]).metadata();
const tw = meta.width!, th = meta.height!;
const svg = (t: string) => Buffer.from(`<svg width="${tw}" height="44" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111"/><text x="8" y="28" font-family="sans-serif" font-size="22" fill="#fff">${t}</text></svg>`);
await sharp({ create: { width: tw * 4 + 30, height: th + 44, channels: 4, background: '#111' } })
  .composite(tiles.flatMap((t, i) => [{ input: t, left: i * (tw + 10), top: 44 }, { input: svg(`${i}% defocus`), left: i * (tw + 10), top: 0 }]))
  .png().toFile(out);
console.log(labels.join('\n'));
