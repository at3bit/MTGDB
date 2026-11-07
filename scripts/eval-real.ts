// Recognition accuracy on REAL card images in SIMULATED binder photos.
//
// Picks random printings from the built database (half of them worth $5+),
// downloads Scryfall's full-size scans, renders them into open-binder frames
// with perspective, blur, sensor noise, glare, sleeve haze, colour cast and
// JPEG compression, then runs the app's recognizer (image match, then OCR on
// the title line when the image match is not conclusive) against the full
// fingerprint index.
//
// It is still simulated photography, so treat the numbers as an upper bound
// until real footage confirms them.
//
//   npm run eval -- --spreads 6 --seed 1
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createWorker, PSM } from 'tesseract.js';
import { CardDB, decodeFingerprints, type CardsFile } from '../src/core/carddb.ts';
import { recognizeSpread, type PocketResult } from '../src/core/recognize.ts';
import { applyOcr, settlePrinting, type PocketView } from '../src/app/session.ts';
import type { RGBAImage } from '../src/core/image.ts';
import { fpDistance } from '../src/core/fingerprint.ts';
import { renderSpread, rng, type RenderOptions } from '../tests/synth.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'test-results', 'eval');
mkdirSync(out, { recursive: true });
const arg = (name: string, def: number) => (process.argv.includes(name) ? Number(process.argv[process.argv.indexOf(name) + 1]) : def);
const SPREADS = arg('--spreads', 6);
const SEED = arg('--seed', 1);
const UA = 'MTGDB-binder-scanner/0.1 (accuracy evaluation)';

// ---- database
const file = JSON.parse(readFileSync(join(root, 'public/data/cards.json'), 'utf8')) as CardsFile;
const fpBuf = readFileSync(join(root, 'public/data/fingerprints.bin'));
const db = new CardDB(file, decodeFingerprints(fpBuf.buffer.slice(fpBuf.byteOffset, fpBuf.byteOffset + fpBuf.byteLength) as ArrayBuffer));
const fpDistanceOf = (q: Uint32Array, i: number) => fpDistance(q, db.fps, i);
console.log(`index: ${db.count.toLocaleString()} printings, ${db.names.length.toLocaleString()} names`);

// ---- sample cards: half uniform, half worth >= $5
const r = rng(SEED);
const valuable = Array.from({ length: db.count }, (_, i) => i).filter((i) => (file.cards[i][6] ?? 0) >= 5);
const picks: number[] = [];
while (picks.length < SPREADS * 18) {
  const pool = picks.length % 2 === 0 ? null : valuable;
  const i = pool ? pool[Math.floor(r() * pool.length)] : Math.floor(r() * db.count);
  if (!picks.includes(i)) picks.push(i);
}

async function download(i: number): Promise<RGBAImage> {
  const id = file.cards[i][0];
  const url = `https://cards.scryfall.io/normal/front/${id[0]}/${id[1]}/${id}.jpg`;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { data, info } = await sharp(Buffer.from(await res.arrayBuffer())).resize(488, 680, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) };
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((res) => setTimeout(res, 1000));
    }
  }
}
console.log(`downloading ${picks.length} card scans…`);
const images: RGBAImage[] = new Array(picks.length);
let next = 0;
await Promise.all(Array.from({ length: 6 }, async () => { while (next < picks.length) { const k = next++; images[k] = await download(picks[k]); } }));

// ---- OCR (same preprocessing as the app)
const ocr = await createWorker('eng', 1, { langPath: join(root, 'node_modules/@tesseract.js-data/eng/4.0.0_best_int'), cachePath: join(root, 'data-cache') });
await ocr.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
async function readName(img: RGBAImage): Promise<string> {
  const run = async (invert: boolean) => {
    const g = new Uint8Array(img.width * img.height);
    let lo = 255, hi = 0;
    for (let i = 0; i < g.length; i++) { const v = 0.299 * img.data[i * 4] + 0.587 * img.data[i * 4 + 1] + 0.114 * img.data[i * 4 + 2]; g[i] = v; lo = Math.min(lo, v); hi = Math.max(hi, v); }
    for (let i = 0; i < g.length; i++) { const v = ((g[i] - lo) / Math.max(1, hi - lo)) * 255; g[i] = invert ? 255 - v : v; }
    const png = await sharp(Buffer.from(g), { raw: { width: img.width, height: img.height, channels: 1 } }).png().toBuffer();
    const res = await ocr.recognize(png);
    return { text: res.data.text.trim(), conf: res.data.confidence };
  };
  let best = await run(false);
  if (best.conf < 70) { const b = await run(true); if (b.conf > best.conf) best = b; }
  return best.text;
}

// ---- conditions
const conditions: { name: string; opts: Omit<RenderOptions, 'seed'> }[] = [
  { name: '4K video, even lighting', opts: { width: 3840, height: 2160, noise: 3, blur: true, haze: 0.08, jitter: 0.015, calibError: 0.002 } },
  { name: '4K video, glare + hazy sleeves + warm light', opts: { width: 3840, height: 2160, noise: 4, blur: true, haze: 0.18, glare: 0.5, cast: [1.07, 1, 0.88], exposure: 0.9, jitter: 0.02, calibError: 0.003 } },
  { name: '1080p live camera, even lighting', opts: { width: 1920, height: 1080, noise: 3, blur: true, haze: 0.1, jitter: 0.015, calibError: 0.002 } },
];

interface Tally { toReview: number; flagged: number; hiddenError: number; valueError: number; printingMisses: { text: string; price: number }[]; pockets: number; imgMatched: number; imgMatchedWrongName: number; uncertain: number; unknown: number; nameRight: number; printingRight: number; confidentWrong: number; trueValue: number; foundValue: number; failures: string[] }
const results: Record<string, Tally> = {};
const label = (i: number) => `${file.cards[i][1]} (${file.cards[i][2].toUpperCase()} #${file.cards[i][3]})`;

for (const cond of conditions) {
  const t: Tally = { toReview: 0, flagged: 0, hiddenError: 0, valueError: 0, printingMisses: [], pockets: 0, imgMatched: 0, imgMatchedWrongName: 0, uncertain: 0, unknown: 0, nameRight: 0, printingRight: 0, confidentWrong: 0, trueValue: 0, foundValue: 0, failures: [] };
  const t0 = Date.now();
  for (let s = 0; s < SPREADS; s++) {
    const ids = picks.slice(s * 18, s * 18 + 18);
    const scene = renderSpread(ids.map((_, k) => images[s * 18 + k]), { ...cond.opts, seed: SEED * 1000 + s });
    // JPEG round trip, as in a real video frame.
    const jpg = await sharp(Buffer.from(scene.frame.data.buffer), { raw: { width: scene.frame.width, height: scene.frame.height, channels: 4 } }).jpeg({ quality: 82 }).toBuffer();
    const dec = await sharp(jpg).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const frame: RGBAImage = { width: dec.info.width, height: dec.info.height, data: new Uint8ClampedArray(dec.data.buffer, dec.data.byteOffset, dec.data.byteLength) };
    const res: PocketResult[] = recognizeSpread([frame], scene.calibration, { fps: db.fps, count: db.count, nameOf: db.nameOf });
    for (const p of res) {
      const truth = ids[p.page * 9 + p.slot];
      t.pockets++;
      t.trueValue += file.cards[truth][6] ?? 0;
      if (p.status === 'matched') { t.imgMatched++; if (db.nameOf[p.matches[0].card] !== db.nameOf[truth]) t.imgMatchedWrongName++; }
      if (p.status === 'uncertain') t.uncertain++;
      if (p.status === 'unknown') t.unknown++;
      // Full pipeline: OCR for anything the image match didn't settle.
      let view: PocketView = { page: p.page, slot: p.slot, status: p.status, matches: p.matches, otherNameDistance: p.otherNameDistance, thumbUrl: '', query: p.query, nameCrop: undefined, chosen: p.status === 'matched' || p.status === 'uncertain' ? p.matches[0]?.card ?? null : null, finish: 'nonfoil', via: 'image', glare: p.glare, borderLuma: p.borderLuma };
      if (p.status !== 'matched' && p.status !== 'empty' && p.nameCrop) view = applyOcr(view, await readName(p.nameCrop), db);
      else view = settlePrinting(view, db);
      const got = view.chosen;
      if (view.status !== 'matched') t.toReview++;
      if (view.printingCheck) t.flagged++;
      // Error left after review: pockets shown as identified (green) that are wrong. Orange/red ones get checked by the user.
      if (view.status === 'matched') t.hiddenError += Math.abs((file.cards[truth][6] ?? 0) - (got === null ? 0 : file.cards[got][6] ?? 0));
      const nameOk = got !== null && db.nameOf[got] === db.nameOf[truth];
      if (nameOk) t.nameRight++;
      if (got === truth) t.printingRight++;
      if (view.status === 'matched' && !nameOk) t.confidentWrong++;
      if (view.status === 'matched' && got !== null) t.foundValue += file.cards[got][6] ?? 0;
      const truePrice = file.cards[truth][6] ?? 0;
      const gotPrice = got === null ? 0 : file.cards[got][6] ?? 0;
      t.valueError += Math.abs(truePrice - gotPrice);
      if (nameOk && got !== truth) {
        const dTrue = p.query ? fpDistanceOf(p.query, truth) : NaN;
        const rank = p.matches.findIndex((m) => m.card === truth);
        t.printingMisses.push({
          price: Math.max(truePrice, gotPrice),
          text: `${label(truth)} $${truePrice.toFixed(2)} -> ${label(got!)} $${gotPrice.toFixed(2)} [d chosen=${p.matches.find((m) => m.card === got)?.d ?? '?'} true=${dTrue}, true rank ${rank}, ${db.printings[db.nameOf[truth]].length} printings]`,
        });
      }
      if (!nameOk) t.failures.push(`${label(truth)} -> ${got === null ? 'nothing' : label(got)} [${p.status}${view.via === 'text' ? ' +ocr' : ''}, d=${p.matches[0]?.d ?? '-'}, glare=${p.glare.toFixed(2)}]`);
    }
  }
  results[cond.name] = t;
  const pct = (n: number) => `${((100 * n) / t.pockets).toFixed(1)}%`;
  console.log(`\n== ${cond.name} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  console.log(`  image match alone: ${pct(t.imgMatched)} confident (${t.imgMatchedWrongName} of those wrong), ${pct(t.uncertain)} uncertain, ${pct(t.unknown)} unknown`);
  console.log(`  after name reading: correct card name ${pct(t.nameRight)}, exact printing ${pct(t.printingRight)}, confidently wrong ${t.confidentWrong}`);
  console.log(`  value: true $${t.trueValue.toFixed(2)}, counted as confident $${t.foundValue.toFixed(2)}`);
  t.failures.slice(0, 12).forEach((f) => console.log(`   ✗ ${f}`));
  console.log(`  value error (sum of |price picked - true price|): $${t.valueError.toFixed(2)} before review; $${t.hiddenError.toFixed(2)} hidden in pockets shown as identified`);
  console.log(`  pockets to check: ${t.toReview} of ${t.pockets} (${t.flagged} for "which printing?")`);
  t.printingMisses.sort((a, b) => b.price - a.price);
  t.printingMisses.slice(0, 15).forEach((f) => console.log(`   ~ ${f.text}`));
}
await ocr.terminate();
writeFileSync(join(out, `results-seed${SEED}.json`), JSON.stringify({ spreads: SPREADS, seed: SEED, indexSize: db.count, results }, null, 1));
console.log(`\nwrote test-results/eval/results-seed${SEED}.json`);
