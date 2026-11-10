// How well can card names be read at the resolutions the app sees? Real Scryfall scans ("large", 672 px)
// rendered as binder photos at increasing size; every card's title line is read with the app's OCR
// settings and fuzzy-matched to card names. Also: how often image match and name reading agree.
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import sharp from 'sharp';
import { createWorker, PSM } from 'tesseract.js';
import { CardDB, decodeFingerprints, type CardsFile } from '../src/core/carddb.ts';
import { DEFAULT_RECOGNIZE, recognizeSpread } from '../src/core/recognize.ts';
import type { RGBAImage } from '../src/core/image.ts';
import { renderSpread, rng } from '../tests/synth.ts';

const UA = 'MTGDB-binder-scanner/0.1 (accuracy evaluation)';
const file = JSON.parse(readFileSync('public/data/cards.json', 'utf8')) as CardsFile;
const fpBuf = readFileSync('public/data/fingerprints.bin');
const db = new CardDB(file, decodeFingerprints(fpBuf.buffer.slice(fpBuf.byteOffset, fpBuf.byteOffset + fpBuf.byteLength) as ArrayBuffer));
const lang = new Map<string, string>();
for await (const line of createInterface({ input: createReadStream('/tmp/mtgdb-default-cards.json') })) {
  const m = /"id":"([^"]+)".*?"lang":"([^"]+)"/.exec(line);
  if (m) lang.set(m[1], m[2]);
}
const r = rng(Number(process.argv[2] ?? 7));
const picks: number[] = [];
while (picks.length < 54) {
  const i = Math.floor(r() * db.count);
  const c = file.cards[i];
  if (lang.get(c[0]) === 'en' && !c[1].includes('//') && !picks.includes(i)) picks.push(i);
}
const dir = 'data-cache/scans-large';
mkdirSync(dir, { recursive: true });
const load = async (i: number): Promise<RGBAImage> => {
  const id = file.cards[i][0], path = join(dir, `${id}.jpg`);
  if (!existsSync(path)) {
    const res = await fetch(`https://cards.scryfall.io/large/front/${id[0]}/${id[1]}/${id}.jpg`, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
    await new Promise((res) => setTimeout(res, 80));
  }
  const { data, info } = await sharp(path).resize(672, 936, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) };
};
const images: RGBAImage[] = [];
for (const i of picks) images.push(await load(i));

const ocr = await createWorker('eng', 1, { langPath: 'node_modules/@tesseract.js-data/eng/4.0.0_best_int', cachePath: 'data-cache' });
await ocr.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
async function readName(img: RGBAImage) {
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

// Card width in the frame for each case: pages are ~41% of the frame width in the test scene.
const cases: [string, number][] = [
  ['1080p video, open binder (card ~210 px)', 1920],
  ['4K video, open binder (card ~420 px)', 3840],
  ['4K video, one page fills the frame (card ~650 px)', 4760],
  ['12 MP photo, one page fills the frame (card ~900 px)', 6600],
];
for (const [label, W] of cases) {
  const H = Math.round((W * 9) / 16);
  let img = 0, read = 0, agree = 0, agreeRight = 0, either = 0;
  const t0 = Date.now();
  for (let s = 0; s < 3; s++) {
    const ids = picks.slice(s * 18, s * 18 + 18);
    const scene = renderSpread(ids.map((_, k) => images[s * 18 + k]), { width: W, height: H, seed: 900 + s, noise: 3, blur: true, haze: 0.08, jitter: 0.012, calibError: 0.002 });
    const jpg = await sharp(Buffer.from(scene.frame.data.buffer), { raw: { width: W, height: H, channels: 4 } }).jpeg({ quality: 85 }).toBuffer();
    const dec = await sharp(jpg).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const frame: RGBAImage = { width: W, height: H, data: new Uint8ClampedArray(dec.data.buffer, dec.data.byteOffset, dec.data.byteLength) };
    const res = recognizeSpread([frame], scene.calibration, { fps: db.fps, count: db.count, nameOf: db.nameOf, back: db.back }, { ...DEFAULT_RECOGNIZE, nameCropAll: true });
    for (const p of res) {
      const truthName = db.nameOf[ids[p.page * 9 + p.slot]];
      const imgName = p.matches[0] ? db.nameOf[p.matches[0].card] : -1;
      const imgOk = p.status === 'matched' && imgName === truthName;
      if (imgOk) img++;
      const text = p.nameCrop ? await readName(p.nameCrop) : '';
      const fz = text.length >= 3 ? db.fuzzyNames(text)[0] : undefined;
      const ocrName = fz ? fz.name : -1;
      if (ocrName === truthName) read++;
      if (ocrName === imgName && ocrName >= 0) { agree++; if (ocrName === truthName) agreeRight++; }
      if (imgOk || ocrName === truthName) either++;
    }
  }
  const n = 54, pct = (x: number) => `${Math.round((100 * x) / n)}%`;
  console.log(`${label}: image match ${pct(img)} | name read right ${pct(read)} | both agree ${pct(agree)} (all ${agreeRight === agree ? 'right' : `${agreeRight} right`}) | at least one right ${pct(either)} [${((Date.now() - t0) / 1000).toFixed(0)} s]`);
}
await ocr.terminate();
