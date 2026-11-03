// Card database: the compact catalogue built from Scryfall bulk data
// (scripts/build-data.ts) plus the packed fingerprint index.
//
// cards.json
//   { v: 1, built: ISO date, source: string, sets: { code: name },
//     cards: [ [id, name, set, collectorNumber, rarity, finishBits, usd, usdFoil, usdEtched], ... ] }
//   finishBits: 1 = nonfoil, 2 = foil, 4 = etched. Prices are numbers or null.
//
// fingerprints.bin (little endian)
//   "MTGF" | u32 version (1) | u32 count | u32 wordsPerEntry (5) | count * 5 * u32
//   Entry i belongs to cards[i].
import { FP_WORDS } from './fingerprint.ts';

export type CardRow = [string, string, string, string, string, number, number | null, number | null, number | null];

export interface CardsFile {
  v: 1;
  built: string;
  source: string;
  sets: Record<string, string>;
  cards: CardRow[];
}

export type Finish = 'nonfoil' | 'foil' | 'etched';

export const FINISH_BITS: Record<Finish, number> = { nonfoil: 1, foil: 2, etched: 4 };

export interface CardInfo {
  index: number;
  id: string;
  name: string;
  set: string;
  setName: string;
  cn: string;
  rarity: string;
  finishes: Finish[];
  prices: Record<Finish, number | null>;
}

const MAGIC = 0x4647544d; // "MTGF" read as little-endian u32

export function encodeFingerprints(fps: Uint32Array, count: number): Uint8Array {
  const buf = new ArrayBuffer(16 + count * FP_WORDS * 4);
  const dv = new DataView(buf);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, 1, true);
  dv.setUint32(8, count, true);
  dv.setUint32(12, FP_WORDS, true);
  const body = new Uint32Array(buf, 16, count * FP_WORDS);
  body.set(fps.subarray(0, count * FP_WORDS));
  return new Uint8Array(buf);
}

export function decodeFingerprints(buf: ArrayBuffer): { count: number; data: Uint32Array } {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('fingerprints.bin: bad magic');
  if (dv.getUint32(4, true) !== 1) throw new Error('fingerprints.bin: unsupported version');
  const count = dv.getUint32(8, true);
  const words = dv.getUint32(12, true);
  if (words !== FP_WORDS) throw new Error(`fingerprints.bin: expected ${FP_WORDS} words per entry, got ${words}`);
  // Copy so the array is aligned regardless of how the buffer was obtained.
  const data = new Uint32Array(count * FP_WORDS);
  data.set(new Uint32Array(buf.slice(16, 16 + count * FP_WORDS * 4)));
  return { count, data };
}

/** Lowercase, strip accents and punctuation, collapse spaces. */
export function normalizeName(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function trigrams(s: string): string[] {
  const p = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= p.length; i++) out.add(p.slice(i, i + 3));
  return [...out];
}

export class CardDB {
  readonly file: CardsFile;
  readonly fps: Uint32Array;
  readonly count: number;
  /** Unique card names (front face names for multi-face cards). */
  readonly names: string[] = [];
  /** cards index -> names index */
  readonly nameOf: Int32Array;
  /** names index -> card indices (printings) */
  readonly printings: number[][] = [];
  private readonly normNames: string[] = [];
  private readonly gramIndex = new Map<string, number[]>();

  constructor(file: CardsFile, fps: { count: number; data: Uint32Array }) {
    if (fps.count !== file.cards.length) {
      throw new Error(`card data mismatch: ${file.cards.length} cards but ${fps.count} fingerprints`);
    }
    this.file = file;
    this.fps = fps.data;
    this.count = fps.count;
    this.nameOf = new Int32Array(this.count);
    const byName = new Map<string, number>();
    file.cards.forEach((row, i) => {
      const name = row[1];
      let n = byName.get(name);
      if (n === undefined) {
        n = this.names.length;
        byName.set(name, n);
        this.names.push(name);
        this.printings.push([]);
        // Index the front face name separately too, since that's what's printed on the card.
        this.normNames.push(normalizeName(name.split(' // ')[0]));
      }
      this.nameOf[i] = n;
      this.printings[n].push(i);
    });
    this.normNames.forEach((nn, n) => {
      for (const g of trigrams(nn)) {
        let list = this.gramIndex.get(g);
        if (!list) this.gramIndex.set(g, (list = []));
        list.push(n);
      }
    });
  }

  info(i: number): CardInfo {
    const r = this.file.cards[i];
    const finishes = (['nonfoil', 'foil', 'etched'] as Finish[]).filter((f) => r[5] & FINISH_BITS[f]);
    return {
      index: i,
      id: r[0],
      name: r[1],
      set: r[2],
      setName: this.file.sets[r[2]] ?? r[2].toUpperCase(),
      cn: r[3],
      rarity: r[4],
      finishes: finishes.length ? finishes : ['nonfoil'],
      prices: { nonfoil: r[6], foil: r[7], etched: r[8] },
    };
  }

  indexOfId(id: string): number {
    if (!this.idMap) {
      this.idMap = new Map();
      this.file.cards.forEach((r, i) => this.idMap!.set(r[0], i));
    }
    return this.idMap.get(id) ?? -1;
  }
  private idMap?: Map<string, number>;

  /**
   * Fuzzy name lookup for noisy OCR text. Returns name indices with a 0..1
   * similarity (Dice coefficient over character trigrams).
   */
  fuzzyNames(text: string, limit = 5): { name: number; score: number }[] {
    const q = normalizeName(text);
    if (q.length < 2) return [];
    const grams = trigrams(q);
    const hits = new Map<number, number>();
    for (const g of grams) {
      const list = this.gramIndex.get(g);
      if (!list || list.length > 4000) continue; // skip ultra-common grams like "  t"
      for (const n of list) hits.set(n, (hits.get(n) ?? 0) + 1);
    }
    const scored: { name: number; score: number }[] = [];
    for (const [n, common] of hits) {
      const total = grams.length + trigrams(this.normNames[n]).length;
      scored.push({ name: n, score: (2 * common) / total });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /** Typed search for the manual picker: prefix matches first, then substring matches. */
  searchNames(text: string, limit = 20): number[] {
    const q = normalizeName(text);
    if (!q) return [];
    const prefix: number[] = [];
    const sub: number[] = [];
    for (let n = 0; n < this.normNames.length; n++) {
      const nn = this.normNames[n];
      if (nn.startsWith(q)) prefix.push(n);
      else if (nn.includes(q)) sub.push(n);
      if (prefix.length >= limit) break;
    }
    return [...prefix, ...sub].slice(0, limit);
  }
}

export function priceFor(info: CardInfo, finish: Finish): number | null {
  return info.prices[finish] ?? null;
}

export function formatUSD(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—';
  return v >= 1000 ? `$${Math.round(v).toLocaleString('en-US')}` : `$${v.toFixed(2)}`;
}
