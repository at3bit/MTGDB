// How much of each pocket's card area is flat and bright (a blank filler card), on the real photos.

import { join } from 'node:path';
import sharp from 'sharp';
import type { Calibration, Quad } from '../src/core/geometry.ts';
import { resampleGray, type RGBAImage } from '../src/core/image.ts';
import { DEFAULT_RECOGNIZE, extractPockets, nominalWindow } from '../src/core/recognize.ts';
import { blankFraction } from '../src/core/recognize.ts';

const dir = process.argv[2];
const corners: Record<string, [number, number][]> = {
  page1: [[178, 328], [1128, 345], [1117, 1650], [175, 1652]],
  page2: [[178, 340], [1112, 348], [1108, 1652], [172, 1648]],
  page3: [[225, 345], [1152, 350], [1145, 1655], [210, 1650]],
  page4: [[180, 348], [1112, 355], [1108, 1662], [178, 1660]],
};
// Image positions (row-major from the photo's top-left) holding blank filler cards.
const blanks: Record<string, number[]> = { page1: [1, 2, 3], page2: [5, 6], page3: [0, 1, 2, 3, 4, 6], page4: [6, 8] };
const real: number[] = [], blank: number[] = [];
for (const [name, cs] of Object.entries(corners)) {
  const { data, info } = await sharp(join(dir, `${name}.jpg`)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const frame: RGBAImage = { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) };
  const [tl, tr, br, bl] = cs.map(([x, y]) => ({ x: x / 1500, y: y / 2000 }));
  const cal: Calibration = { pages: [[br, bl, tl, tr] as Quad], rows: 3, cols: 3 };
  for (const pc of extractPockets([frame], cal)) {
    const imagePos = (2 - Math.floor(pc.slot / 3)) * 3 + (2 - (pc.slot % 3));
    const f = blankFraction(resampleGray(pc.gray, nominalWindow(DEFAULT_RECOGNIZE), 48, 67));
    (blanks[name].includes(imagePos) ? blank : real).push(f);
  }
}
const fmt = (xs: number[]) => xs.sort((a, b) => a - b).map((x) => x.toFixed(2)).join(' ');
console.log(`blank filler cards (${blank.length}): ${fmt(blank)}`);
console.log(`real cards (${real.length}):          ${fmt(real)}`);
