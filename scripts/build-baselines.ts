// Builds public/data/baselines.bin: for every printing in cards.json, its
// latest TCGplayer price and its 30- and 90-day averages, per finish, from
// MTGJSON's 90-day price history. This lets the app flag cards trading well
// above their normal level from day one, before it has its own history.
//
// Needs internet access to mtgjson.com. Run after `npm run data`. The download is retried; if it still
// fails (it once broke off mid-transfer on Vercel: "Response body length does not match content-length"),
// the last good baselines, kept in the build cache, are carried over (remapped to today's cards by id),
// so a deploy doesn't lose price history over a network hiccup.
//
// File format: see src/core/baselines.ts (version 2: latest, 30- and 90-day
// averages and the price 30 days ago, per finish).
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream';
import { pipeline as pipelineAsync } from 'node:stream/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { streamObjectEntries } from './stream-json.ts';
import { encodeBaselines, BASELINE_FIELDS, PER_FINISH } from '../src/core/baselines.ts';
import type { CardsFile } from '../src/core/carddb.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'MTGDB-binder-scanner/0.1 (personal collection tool)';
const BASE = process.env.MTGJSON_BASE ?? 'https://mtgjson.com/api/v5';

/**
 * Downloads a gzipped file to disk, then streams it unzipped. Parsing the 150 MB price file as it
 * arrived took long enough on Vercel that the server cut the transfer off; downloading first is quick.
 * Errors travel down the pipeline (a broken download used to crash the script instead of being retried).
 */
async function gunzipStream(url: string) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  // In the temp folder, not the build cache (which Vercel uploads after every build).
  const file = join(tmpdir(), `mtgdb-${url.split('/').pop()}`);
  await pipelineAsync(Readable.fromWeb(res.body as any), createWriteStream(file));
  const gz = createGunzip();
  pipeline(createReadStream(file), gz, () => {});
  gz.setEncoding('utf8');
  return gz;
}

const cards = (JSON.parse(readFileSync(join(root, 'public/data/cards.json'), 'utf8')) as CardsFile).cards;
const indexOf = new Map(cards.map((r, i) => [r[0], i]));
console.log(`${cards.length.toLocaleString()} printings in cards.json`);
// Same cache as build-data.ts (kept between Vercel builds in node_modules).
const cacheDir = process.env.MTGDB_CACHE_DIR ?? (process.env.VERCEL ? join(root, 'node_modules', '.cache', 'mtgdb') : join(root, 'data-cache'));
const outPath = join(root, 'public/data/baselines.bin');

async function build(): Promise<{ data: Float32Array; asOf: string; used: number }> {

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
  return { data, asOf, used };
}

let built: Awaited<ReturnType<typeof build>> | null = null;
for (let attempt = 1; attempt <= 3 && !built; attempt++) {
  try {
    built = await build();
  } catch (e) {
    console.warn(`Attempt ${attempt} failed: ${(e as Error).message}${(e as Error).cause ? ` (${String((e as Error).cause)})` : ''}`);
    if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 5000));
  }
}
const prevBin = join(cacheDir, 'baselines-prev.bin');
const prevIds = join(cacheDir, 'baselines-prev-ids.json');
if (built) {
  const { data, asOf, used } = built;
  const withData = Array.from({ length: cards.length }, (_, i) => i).filter((i) => Number.isFinite(data[i * BASELINE_FIELDS + 1]) || Number.isFinite(data[i * BASELINE_FIELDS + PER_FINISH + 1])).length;
  const bin = encodeBaselines(data, cards.length, asOf);
  writeFileSync(outPath, bin);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(prevBin, bin);
  writeFileSync(prevIds, JSON.stringify(cards.map((r) => r[0])));
  console.log(`Wrote baselines.bin: ${withData.toLocaleString()} printings with a 30-day baseline (prices as of ${asOf}, ${used.toLocaleString()} series)`);
} else if (existsSync(prevBin) && existsSync(prevIds)) {
  // The last good baselines, remapped to today's cards (new printings get none).
  const buf = readFileSync(prevBin);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const prevCount = dv.getUint32(8, true);
  const d = String(dv.getUint32(12, true));
  const prev = new Float32Array(buf.buffer.slice(buf.byteOffset + 16, buf.byteOffset + 16 + prevCount * BASELINE_FIELDS * 4));
  const ids = JSON.parse(readFileSync(prevIds, 'utf8')) as string[];
  const data = new Float32Array(cards.length * BASELINE_FIELDS).fill(NaN);
  let kept = 0;
  ids.forEach((id, j) => {
    const i = indexOf.get(id);
    if (i === undefined) return;
    data.set(prev.subarray(j * BASELINE_FIELDS, (j + 1) * BASELINE_FIELDS), i * BASELINE_FIELDS);
    kept++;
  });
  const asOf = d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : '';
  writeFileSync(outPath, encodeBaselines(data, cards.length, asOf));
  console.log(`MTGJSON unavailable: carried over the last baselines (prices as of ${asOf}) for ${kept.toLocaleString()} printings`);
} else {
  console.error('MTGJSON unavailable and no earlier baselines to carry over');
  process.exit(1);
}
