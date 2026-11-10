// Builds public/data/cards.json and public/data/fingerprints.bin from
// Scryfall's bulk data. Needs internet access to api.scryfall.com,
// data.scryfall.io and cards.scryfall.io.
//
//   npm run data                 full build (reuses fingerprints from the previous build where the image is unchanged)
//   npm run data -- --limit 500  quick test build with the first 500 printings
//
// Scryfall asks API users to send a descriptive User-Agent and to keep API
// requests to ~10/s. Only one API request is made (the bulk-data listing);
// card images come from their CDN, fetched a few at a time.
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { createGunzip } from 'node:zlib';
import sharp from 'sharp';
import { streamArray } from './stream-json.ts';
import { fingerprint, FP_WORDS } from '../src/core/fingerprint.ts';
import { decodeFingerprints, encodeFingerprints, type CardRow, type CardsFile } from '../src/core/carddb.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'data');
// Vercel keeps node_modules between builds, so fingerprints cached there are reused on the next deploy
// (as long as the install step is `npm install`; `npm ci` deletes node_modules first).
const cacheDir = process.env.MTGDB_CACHE_DIR ?? (process.env.VERCEL ? join(root, 'node_modules', '.cache', 'mtgdb') : join(root, 'data-cache'));
const UA = 'MTGDB-binder-scanner/0.1 (personal collection tool)';

/** Non-English printings by language, as indices into the card list (Scryfall lists a printing in another language when that art or card wasn't printed in English). */
function nonEnglish(langs: string[]): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  langs.forEach((l, i) => {
    if (l && l !== 'en') (out[l] ??= []).push(i);
  });
  return out;
}
const args = process.argv.slice(2);
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
const CONCURRENCY = 8;

interface ScryCard {
  id: string;
  name: string;
  set: string;
  set_name: string;
  collector_number: string;
  rarity: string;
  lang: string;
  layout: string;
  digital: boolean;
  oversized: boolean;
  games: string[];
  finishes: string[];
  image_status: string;
  border_color: string;
  set_type: string;
  promo: boolean;
  image_uris?: { small: string };
  card_faces?: { name: string; image_uris?: { small: string } }[];
  prices: { usd: string | null; usd_foil: string | null; usd_etched: string | null };
}

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

function price(v: string | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const BORDER_CODE: Record<string, string> = { black: 'b', white: 'w', borderless: 'x', silver: 's', gold: 'g', yellow: 'y' };
const SPECIAL_SET_TYPES = new Set(['promo', 'memorabilia', 'funny', 'token', 'minigame', 'vanguard']);

/** 0 = regular printing, 1 = The List reprint, 2 = promo / collectible variant. Used to break visual ties. */
function printingPriority(c: ScryCard): number {
  if (c.promo || SPECIAL_SET_TYPES.has(c.set_type)) return 2;
  if (c.set === 'plst') return 1;
  return 0;
}

function smallImage(c: ScryCard): string | null {
  return c.image_uris?.small ?? c.card_faces?.[0]?.image_uris?.small ?? null;
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  console.log('Fetching bulk data listing…');
  type BulkEntry = { type: string; download_uri?: string; jsonl_download_uri?: string; updated_at: string };
  const bulk = await getJSON<{ data: BulkEntry[] }>('https://api.scryfall.com/bulk-data');
  const entry = bulk.data.find((d) => d.type === 'default_cards');
  // Scryfall now publishes gzipped JSON Lines (jsonl_download_uri); older listings had a plain JSON array (download_uri).
  const uri = entry?.jsonl_download_uri ?? entry?.download_uri;
  if (!entry || !uri) throw new Error('default_cards bulk file not listed');
  const bulkPath = join(tmpdir(), 'mtgdb-default-cards.json');
  console.log(`Downloading ${uri} (updated ${entry.updated_at})…`);
  const res = await fetch(uri, { headers: { 'User-Agent': UA } });
  if (!res.ok || !res.body) throw new Error(`bulk download failed: HTTP ${res.status}`);
  const gzipped = /\.gz($|\?)/.test(uri) || /gzip/.test(res.headers.get('content-type') ?? '');
  const body = Readable.fromWeb(res.body as any);
  if (gzipped) await pipeline(body, createGunzip(), createWriteStream(bulkPath));
  else await pipeline(body, createWriteStream(bulkPath));

  const rows: CardRow[] = [];
  const images: string[] = [];
  const langs: string[] = [];
  const sets: Record<string, string> = {};
  for await (const raw of streamArray(bulkPath)) {
    const c = raw as ScryCard;
    // Physical cards that fit in a binder pocket and have a real image.
    if (!c.games?.includes('paper') || c.digital || c.oversized) continue;
    if (c.image_status === 'missing' || c.image_status === 'placeholder') continue;
    const img = smallImage(c);
    if (!img) continue;
    const fin = (c.finishes.includes('nonfoil') ? 1 : 0) | (c.finishes.includes('foil') ? 2 : 0) | (c.finishes.includes('etched') ? 4 : 0);
    rows.push([c.id, c.name, c.set, c.collector_number, c.rarity, fin, price(c.prices.usd), price(c.prices.usd_foil), price(c.prices.usd_etched), BORDER_CODE[c.border_color] ?? '', printingPriority(c)]);
    images.push(img);
    langs.push(c.lang);
    sets[c.set] = c.set_name;
    if (rows.length >= limit) break;
  }
  console.log(`${rows.length} printings`);

  // Reuse fingerprints from the previous build where the image URL (which carries a version stamp) is unchanged.
  const prevMapPath = join(cacheDir, 'fingerprint-sources.json');
  const prev = new Map<string, Uint32Array>();
  // The previous build's output, from the cache (CI / Vercel) or from public/data (local).
  const prevDir = existsSync(join(cacheDir, 'fingerprints.bin')) ? cacheDir : outDir;
  if (existsSync(prevMapPath) && existsSync(join(prevDir, 'fingerprints.bin')) && existsSync(join(prevDir, 'cards.json'))) {
    const srcs: Record<string, string> = JSON.parse(readFileSync(prevMapPath, 'utf8'));
    const old = JSON.parse(readFileSync(join(prevDir, 'cards.json'), 'utf8')) as CardsFile;
    const buf = readFileSync(join(prevDir, 'fingerprints.bin'));
    const fps = decodeFingerprints(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    old.cards.forEach((r, i) => {
      const src = srcs[r[0]];
      if (src) prev.set(`${r[0]}|${src}`, fps.data.slice(i * FP_WORDS, (i + 1) * FP_WORDS));
    });
  }

  const fps = new Uint32Array(rows.length * FP_WORDS);
  const ok = new Uint8Array(rows.length);
  let done = 0, reused = 0, failed = 0;
  let next = 0;
  const t0 = Date.now();
  async function work() {
    while (next < rows.length) {
      const i = next++;
      const key = `${rows[i][0]}|${images[i]}`;
      const cached = prev.get(key);
      if (cached) {
        fps.set(cached, i * FP_WORDS);
        ok[i] = 1;
        reused++;
      } else {
        for (let attempt = 0; attempt < 3 && !ok[i]; attempt++) {
          try {
            const r = await fetch(images[i], { headers: { 'User-Agent': UA } });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const { data, info } = await sharp(Buffer.from(await r.arrayBuffer())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
            const img = { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) };
            fps.set(fingerprint(img), i * FP_WORDS);
            ok[i] = 1;
          } catch (e) {
            if (attempt === 2) { failed++; console.warn(`  ${rows[i][1]} (${rows[i][2]} ${rows[i][3]}): ${(e as Error).message}`); }
            else await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
          }
        }
      }
      if (++done % 1000 === 0) {
        const rate = done / ((Date.now() - t0) / 1000);
        console.log(`  ${done}/${rows.length} (${reused} reused, ${failed} failed) ~${Math.round((rows.length - done) / rate)}s left`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, work));

  // Drop printings whose image could not be fingerprinted.
  const keep = rows.map((_, i) => i).filter((i) => ok[i]);
  const outRows = keep.map((i) => rows[i]);
  const outFps = new Uint32Array(keep.length * FP_WORDS);
  keep.forEach((i, j) => outFps.set(fps.subarray(i * FP_WORDS, (i + 1) * FP_WORDS), j * FP_WORDS));
  // The standard Magic card back, so the app can tell a sleeve showing a card back from a card.
  let back: number[] | undefined;
  try {
    const r = await fetch('https://backs.scryfall.io/normal/0/a/0aeebaf5-8c7d-4636-9e82-8c27447861f7.jpg', { headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { data, info } = await sharp(Buffer.from(await r.arrayBuffer())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    back = Array.from(fingerprint({ width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) }));
  } catch (e) {
    console.warn(`card back not fingerprinted: ${(e as Error).message}`);
  }
  const file: CardsFile = {
    v: 1,
    built: new Date().toISOString(),
    source: `Scryfall default_cards ${entry.updated_at}`,
    sets,
    cards: outRows,
    back,
    langs: nonEnglish(keep.map((i) => langs[i])),
  };
  writeFileSync(join(outDir, 'cards.json'), JSON.stringify(file));
  writeFileSync(join(outDir, 'fingerprints.bin'), encodeFingerprints(outFps, keep.length));
  writeFileSync(prevMapPath, JSON.stringify(Object.fromEntries(keep.map((i) => [rows[i][0], images[i]]))));
  copyFileSync(join(outDir, 'cards.json'), join(cacheDir, 'cards.json'));
  copyFileSync(join(outDir, 'fingerprints.bin'), join(cacheDir, 'fingerprints.bin'));
  console.log(`Wrote ${keep.length} cards (${failed} failed) to public/data/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
