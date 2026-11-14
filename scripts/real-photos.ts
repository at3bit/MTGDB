// Runs the app's recognizer on real binder photos (one 3x3 page each) and prints what it reads per pocket.
//   npx tsx scripts/real-photos.ts <dir> [--upright]
// Corners are given per photo in image order (top-left, top-right, bottom-right, bottom-left of the card grid,
// as they appear in the image, normalised). Unless --upright, the cards are upside down in the photo.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { CardDB, CATEGORY, decodeFingerprints, type CardsFile } from '../src/core/carddb.ts';
import type { Calibration, Quad } from '../src/core/geometry.ts';
import type { RGBAImage } from '../src/core/image.ts';
import { DEFAULT_RECOGNIZE, recognizeSpread } from '../src/core/recognize.ts';
import { recognizeTrackedSpread } from '../src/core/scan.ts';

const dir = process.argv[2];
const upright = process.argv.includes('--upright');
// --auto: give the outline the wrong way up (as drawn without Rotate) and let the app find the orientation.
const auto = process.argv.includes('--auto');
const COARSE = process.argv.includes('--coarse') ? Number(process.argv[process.argv.indexOf('--coarse') + 1]) : undefined;
const file = JSON.parse(readFileSync('public/data/cards.json', 'utf8')) as CardsFile;
const fpBuf = readFileSync('public/data/fingerprints.bin');
const db = new CardDB(file, decodeFingerprints(fpBuf.buffer.slice(fpBuf.byteOffset, fpBuf.byteOffset + fpBuf.byteLength) as ArrayBuffer));
db.setEnglishOnly(true);
// --cats B,U,...: what the binder holds (see CATEGORY).
if (process.argv.includes('--cats')) {
  const names = process.argv[process.argv.indexOf('--cats') + 1].split(',') as (keyof typeof CATEGORY)[];
  db.setCategories(names.reduce((m, n) => m | CATEGORY[n], 0));
}
const idx = { fps: db.fps, count: db.count, nameOf: db.nameOf, back: db.back, allowed: db.allowed, preferred: db.preferred };

// Card grid corners as seen in each photo (from the 1500x2000 preview), normalised.
const corners: Record<string, [number, number][]> = {
  page1: [[178, 328], [1128, 345], [1117, 1650], [175, 1652]],
  page2: [[178, 340], [1112, 348], [1108, 1652], [172, 1648]],
  page3: [[225, 345], [1152, 350], [1145, 1655], [210, 1650]],
  page4: [[180, 348], [1112, 355], [1108, 1662], [178, 1660]],
};
for (const [name, cs] of Object.entries(corners)) {
  const { data, info } = await sharp(join(dir, `${name}.jpg`)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const frame: RGBAImage = { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) };
  const [tl, tr, br, bl] = cs.map(([x, y]) => ({ x: x / 1500, y: y / 2000 }));
  // The page quad in card order (top-left of the cards first). Upside-down cards: the cards' top-left is the image's bottom-right.
  const quad: Quad = upright || auto ? [tl, tr, br, bl] : [br, bl, tl, tr];
  const cal: Calibration = { pages: [quad], rows: 3, cols: 3 };
  let res = recognizeSpread([frame], cal, idx, { ...DEFAULT_RECOGNIZE, coarseWindows: COARSE });
  let turn = 0;
  const t0 = Date.now();
  if (auto || process.argv.includes('--tracked')) {
    const tracked = recognizeTrackedSpread([frame], cal, undefined, idx);
    res = tracked.pockets;
    turn = tracked.turns[0];
  }
  const grid: string[][] = [[], [], []];
  for (const p of res) {
    const r = Math.floor(p.slot / 3), c = p.slot % 3;
    const flipped = auto ? turn === 2 : !upright;
    const [ir, ic] = flipped ? [2 - r, 2 - c] : [r, c]; // where it is in the image
    const m = p.matches[0];
    const label = p.status === 'empty' ? 'EMPTY' : `${m ? db.names[db.nameOf[m.card]] : '?'} [${p.status}${m ? ` d=${m.d}` : ''}${p.blurry ? ' blurry' : ''}]`;
    grid[ir][ic] = label;
  }
  console.log(`${name} (${info.width}x${info.height}, ${Date.now() - t0} ms, ${auto ? `outline not rotated; the app turned the page ${turn * 90}°` : upright ? 'read upright' : 'read upside down = correct'}):`);
  grid.forEach((row) => console.log('   ' + row.map((s) => s.padEnd(44)).join(' | ')));
}
