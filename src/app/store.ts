// On-device persistence (IndexedDB). Everything stays on the phone.
import { get, set } from 'idb-keyval';
import type { Calibration, Rotation } from '../core/geometry.ts';
import type { CardDB, Finish } from '../core/carddb.ts';
import type { Baseline } from '../core/baselines.ts';
import { cardPrice, type LivePrices } from './session.ts';

export interface SavedCalibration {
  calibration: Calibration;
  rotation: Rotation;
  frameW: number;
  frameH: number;
}

export interface OwnedCard {
  id: string;
  finish: Finish;
  page: number;
  slot: number;
}

export interface Binder {
  name: string;
  updatedAt: string;
  cards: OwnedCard[];
}

export interface Collection {
  binders: Binder[];
}

/** Daily price points per card id: [yyyy-mm-dd, price][] for the finish you own. */
export type PriceHistory = Record<string, [string, number][]>;

const K = {
  calibration: 'calibration-v1',
  collection: 'collection-v1',
  history: 'price-history-v1',
  live: 'live-prices-v1',
};

async function safeGet<T>(key: string, fallback: T): Promise<T> {
  try {
    return ((await get(key)) as T | undefined) ?? fallback;
  } catch {
    return fallback;
  }
}

export const loadCalibration = () => safeGet<SavedCalibration | null>(K.calibration, null);
export const saveCalibration = (c: SavedCalibration) => set(K.calibration, c);
export const loadCollection = () => safeGet<Collection>(K.collection, { binders: [] });
export const saveCollection = (c: Collection) => set(K.collection, c);
export const loadHistory = () => safeGet<PriceHistory>(K.history, {});
export const loadLivePrices = () => safeGet<LivePrices>(K.live, {});
export const saveLivePrices = (l: LivePrices) => set(K.live, l);

const historyKey = (id: string, finish: Finish) => `${id}:${finish}`;

/** Records today's price for every owned card (once per day). Builds the baseline that sell signals compare against. */
export async function recordPrices(db: CardDB, col: Collection, live: LivePrices): Promise<PriceHistory> {
  const hist = await loadHistory();
  const today = new Date().toISOString().slice(0, 10);
  let changed = false;
  for (const b of col.binders) for (const c of b.cards) {
    const idx = db.indexOfId(c.id);
    if (idx < 0) continue;
    const price = cardPrice(db, idx, c.finish, live);
    if (price == null) continue;
    const key = historyKey(c.id, c.finish);
    const list = (hist[key] ??= []);
    if (list.length && list[list.length - 1][0] === today) {
      if (list[list.length - 1][1] !== price) { list[list.length - 1][1] = price; changed = true; }
    } else {
      list.push([today, price]);
      changed = true;
    }
    if (list.length > 400) list.splice(0, list.length - 400);
  }
  if (changed) await set(K.history, hist);
  return hist;
}

export interface Trend {
  /** Current price vs average of the previous 30 days, e.g. 0.25 = 25% above. */
  vsAvg: number;
  avg: number;
  days: number;
  source: 'market' | 'local';
}

/**
 * Price trend for one owned card. Uses the market-wide 30-day baseline (from
 * MTGJSON's TCGplayer history) when there is one, otherwise the daily prices
 * this phone has recorded since the card was scanned.
 */
export function trendFor(hist: PriceHistory, id: string, finish: Finish, current: number | null, baseline?: Baseline | null): Trend | null {
  if (baseline && baseline.avg30 > 0) {
    // Scryfall's USD price and MTGJSON's TCGplayer history are the same series (they agree to within 1% for
    // 95% of cards), so today's price, refreshed on the phone, can be compared with the 30-day average.
    const now = current ?? baseline.latest;
    return { vsAvg: now / baseline.avg30 - 1, avg: baseline.avg30, days: 30, source: 'market' };
  }
  const list = hist[historyKey(id, finish)];
  if (!list || current == null) return null;
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const prior = list.filter(([d]) => d < today && d >= cutoff);
  if (prior.length < 3) return null;
  const avg = prior.reduce((s, [, p]) => s + p, 0) / prior.length;
  if (avg <= 0) return null;
  return { vsAvg: current / avg - 1, avg, days: prior.length, source: 'local' };
}
