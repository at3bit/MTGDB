// Which printings does the matcher return for crops that aren't a clean card (misaligned, blurry, empty)?
// If a few odd printings win for all of them, bad crops will show up as those cards.
import { createReadStream, readFileSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import sharp from 'sharp';
import { CardDB, decodeFingerprints, type CardsFile } from '../src/core/carddb.ts';
import { fingerprint, fpDistance } from '../src/core/fingerprint.ts';
import { createRGBA, type RGBAImage } from '../src/core/image.ts';
import { defocusBlur, rng } from '../tests/synth.ts';

const file = JSON.parse(readFileSync('public/data/cards.json', 'utf8')) as CardsFile;
const fpBuf = readFileSync('public/data/fingerprints.bin');
const db = new CardDB(file, decodeFingerprints(fpBuf.buffer.slice(fpBuf.byteOffset, fpBuf.byteOffset + fpBuf.byteLength) as ArrayBuffer));
const lang = new Map<string, string>();
const bulk = process.argv[2] ?? '/tmp/mtgdb-default-cards.json';
for await (const line of createInterface({ input: createReadStream(bulk) })) {
  const l = line.trim().replace(/,$/, '');
  if (!l.startsWith('{')) continue;
  const m = /"id":"([^"]+)".*?"lang":"([^"]+)"/.exec(l);
  if (m) lang.set(m[1], m[2]);
}
const nearest = (q: Uint32Array) => {
  let best = Infinity, bi = -1;
  for (let i = 0; i < db.count; i++) { const d = fpDistance(q, db.fps, i); if (d < best) { best = d; bi = i; } }
  return { card: bi, d: best };
};
const scans = readdirSync('data-cache/scans').filter((f) => f.endsWith('.jpg')).slice(0, 60);
const load = async (f: string): Promise<RGBAImage> => {
  const { data, info } = await sharp(`data-cache/scans/${f}`).resize(488, 680, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) };
};
const cards = await Promise.all(scans.map(load));
const r = rng(3);
// Bad crops: two half-cards side by side (outline off by half a pocket), heavy blur, an empty dark sleeve, the table.
const queries: { kind: string; img: RGBAImage }[] = [];
for (let i = 0; i + 1 < cards.length; i += 2) {
  const a = cards[i], b = cards[i + 1], img = createRGBA(488, 680);
  for (let y = 0; y < 680; y++) for (let x = 0; x < 488; x++) {
    const src = x < 244 ? a : b, sx = x < 244 ? x + 244 : x - 244;
    for (let c = 0; c < 4; c++) img.data[(y * 488 + x) * 4 + c] = src.data[(y * 488 + sx) * 4 + c];
  }
  queries.push({ kind: 'half-card shift', img });
  queries.push({ kind: 'heavy blur', img: defocusBlur({ ...a, data: new Uint8ClampedArray(a.data) }, 30) });
}
for (let i = 0; i < 30; i++) {
  const img = createRGBA(488, 680);
  const base = [20 + r() * 30, 20 + r() * 30, 25 + r() * 30];
  for (let p = 0; p < img.data.length; p += 4) { const n = (r() - 0.5) * 12; img.data[p] = base[0] + n; img.data[p + 1] = base[1] + n; img.data[p + 2] = base[2] + n; img.data[p + 3] = 255; }
  queries.push({ kind: 'empty dark sleeve', img });
}
// The app's accept rule: best within acceptDistance and a margin over the best different name.
const top = (q: Uint32Array) => {
  const all: { card: number; d: number }[] = [];
  for (let i = 0; i < db.count; i++) all.push({ card: i, d: fpDistance(q, db.fps, i) });
  all.sort((a, b) => a.d - b.d);
  const best = all[0];
  const other = all.find((m) => db.nameOf[m.card] !== db.nameOf[best.card])!;
  return { best, margin: other.d - best.d, status: best.d <= 44 && other.d - best.d >= 6 ? 'matched' : best.d <= 58 ? 'uncertain' : 'unknown' };
};
const tally = new Map<number, number>();
const byKind = new Map<string, { n: number; nonEn: number; accepted: number }>();
for (const q of queries) {
  const m = nearest(fingerprint(q.img));
  tally.set(m.card, (tally.get(m.card) ?? 0) + 1);
  const k = byKind.get(q.kind) ?? { n: 0, nonEn: 0, accepted: 0 };
  k.n++;
  if (lang.get(file.cards[m.card][0]) !== 'en') k.nonEn++;
  if (top(fingerprint(q.img)).status === 'matched') k.accepted++;
  byKind.set(q.kind, k);
}
for (const [kind, k] of byKind) console.log(`${kind}: ${k.n} crops -> nearest printing non-English in ${k.nonEn} (${Math.round((100 * k.nonEn) / k.n)}%), shown as identified (green) in ${k.accepted}`);
console.log('most returned printings:');
[...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([card, n]) => {
  const c = file.cards[card];
  console.log(`  ${n}x ${c[1]} (${c[2].toUpperCase()} #${c[3]}, ${lang.get(c[0])})`);
});
