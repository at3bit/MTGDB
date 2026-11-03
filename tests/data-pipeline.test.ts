// Checks the parts of the data build that don't need network access.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { streamArray } from '../scripts/stream-json.ts';
import { fingerprint, fpDistance } from '../src/core/fingerprint.ts';
import { makeCard, toReferenceSize } from './synth.ts';

describe('data build', () => {
  it('streams a large JSON array, including braces and quotes inside strings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mtgdb-'));
    const items = Array.from({ length: 3000 }, (_, i) => ({ id: i, name: `Card {weird} "quote" \\ ${i}`, nested: { a: [1, { b: '}' }] } }));
    writeFileSync(join(dir, 'arr.json'), '[\n' + items.map((x) => JSON.stringify(x)).join(',\n') + '\n]');
    const got: unknown[] = [];
    for await (const o of streamArray(join(dir, 'arr.json'))) got.push(o);
    expect(got).toEqual(items);
  });

  it('JPEG-compressed reference images fingerprint like the originals', async () => {
    const card = toReferenceSize(makeCard(42));
    const jpg = await sharp(Buffer.from(card.data.buffer), { raw: { width: 146, height: 204, channels: 4 } }).jpeg({ quality: 80 }).toBuffer();
    const { data, info } = await sharp(jpg).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const fp = fingerprint({ width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) });
    expect(fpDistance(fp, fingerprint(card), 0)).toBeLessThan(8);
  });
});
