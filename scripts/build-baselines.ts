// Builds public/data/baselines.bin: for every printing in cards.json, its
// latest TCGplayer price and its 30- and 90-day averages, per finish, from
// MTGJSON's 90-day price history. This lets the app flag cards trading well
// above their normal level from day one, before it has its own history.
//
// Needs internet access to mtgjson.com. Run after `npm run data`.
//
// File format: see src/core/baselines.ts (version 2: latest, 30- and 90-day
// averages and the price 30 days ago, per finish).
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { streamObjectEntries } from './stream-json.ts';
import { encodeBaselines, BASELINE_FIELDS, PER_FINISH } from '../src/core/baselines.ts';
import type { CardsFile } from '../src/core/carddb.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'MTGDB-binder-scanner/0.1 (personal collection tool)';
const BASE = 'https://mtgjson.com/api/v5';

async function gunzipStream(url: string) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const s = Readable.fromWeb(res.body as any).pipe(createGunzip());
  s.setEncoding('utf8');
  return s;
}

const cards = (JSON.parse(readFileSync(join(root, 'public/data/cards.json'), 'utf8')) as CardsFile).cards;
const indexOf = new Map(cards.map((r, i) => [r[0], i]));
console.log(`${cards.length.toLocaleString()} printings in cards.json`);

console.log('Downloading MTGJSON card identifiers…');
const uuidToIndex = new Map<string, number>();
for await (const line of createInterface({ input: await gunzipStream(`${BASE}/csv/cardIdentifiers.csv.gz`) })) {
  const comma1 = line.indexOf(',');
  const comma2 = line.indexOf(',', comma1 + 1);
  const uuid = line.slice(0, comma1);
  const scryfallId = line.slice(comma1 + 1, comma2 < 0 ? undefined : comma2);
  const idx = indexOf.get(scryfallId);
  if (idx !== undefined) uuidToIndex.set(uuid, idx);
}
console.log(`  ${uuidToIndex.size.toLocaleString()} MTGJSON printings map to our cards`);

console.log('Streaming MTGJSON 90-day price history…');
const data = new Float32Array(cards.length * BASELINE_FIELDS).fill(NaN);
let asOf = '';
let seen = 0, used = 0;
const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86400_000;
type Series = Record<string, number>;
for await (const [uuid, value] of streamObjectEntries(await gunzipStream(`${BASE}/AllPrices.json.gz`))) {
  seen++;
  const idx = uuidToIndex.get(uuid);
  if (idx === undefined) continue;
  const retail = (value as { paper?: { tcgplayer?: { retail?: Record<string, Series> } } }).paper?.tcgplayer?.retail;
  if (!retail) continue;
  (['normal', 'foil', 'etched'] as const).forEach((finish, f) => {
    const series = retail[finish];
    if (!series) return;
    const pts = Object.entries(series).filter(([, p]) => Number.isFinite(p) && p > 0).sort(([a], [b]) => (a < b ? -1 : 1));
    if (!pts.length) return;
    const [lastDate, latest] = pts[pts.length - 1];
    if (lastDate > asOf) asOf = lastDate;
    const end = day(lastDate);
    const avg = (days: number) => {
      // Average of the days before the latest one, so a spike today stands out against it.
      const window = pts.filter(([d]) => day(d) < end && day(d) >= end - days).map(([, p]) => p);
      return window.length >= Math.min(5, days / 6) ? window.reduce((a, b) => a + b, 0) / window.length : NaN;
    };
    // The price about 30 days before the latest: the closest day within 25-35 days back.
    let ago30 = NaN, bestGap = Infinity;
    for (const [d, p] of pts) {
      const gap = Math.abs(end - 30 - day(d));
      if (gap <= 5 && gap < bestGap) { bestGap = gap; ago30 = p; }
    }
    const o = idx * BASELINE_FIELDS + f * PER_FINISH;
    // Several MTGJSON entries can map to one Scryfall printing; keep the one with the most history.
    if (Number.isFinite(data[o + 2]) && !Number.isFinite(avg(90))) return;
    data[o] = latest;
    data[o + 1] = avg(30);
    data[o + 2] = avg(90);
    data[o + 3] = ago30;
    used++;
  });
  if (seen % 20000 === 0) console.log(`  ${seen.toLocaleString()} entries read`);
}
const withData = Array.from({ length: cards.length }, (_, i) => i).filter((i) => Number.isFinite(data[i * BASELINE_FIELDS + 1]) || Number.isFinite(data[i * BASELINE_FIELDS + PER_FINISH + 1])).length;
writeFileSync(join(root, 'public/data/baselines.bin'), encodeBaselines(data, cards.length, asOf));
console.log(`Wrote baselines.bin: ${withData.toLocaleString()} printings with a 30-day baseline (prices as of ${asOf}, ${used.toLocaleString()} series)`);
