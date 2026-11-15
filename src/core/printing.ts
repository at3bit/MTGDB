// Picks the printing once the card's name is known.
//
// Many cards have several printings that look nearly identical from the
// front, and their prices can differ a lot (Beta vs. Collectors' Edition,
// an original vs. a white-bordered reprint, a set card vs. its promo).
// The resolver combines:
//   - the visual distance of each printing to the photographed card,
//   - the printed border colour measured in the photo vs. Scryfall's
//     border_color (black vs. white/gold/silver),
//   - a preference for regular printings over promos, and a clear one over
//     their exact twins: The List reprints (the original card with a tiny
//     planeswalker mark) and foil-only "★" printings, which a photo can't tell
//     apart from the regular card,
//   - in a binder sorted by set, the set of the other cards on the page (see
//     pageSetChoice),
// and reports when the remaining look-alikes differ enough in price that the
// collector should confirm which one it is.
import { FP_WORDS, fpDistance } from './fingerprint.ts';
import type { CardDB, CardInfo } from './carddb.ts';

export interface PrintingConfig {
  /** Added to a printing's distance when its border colour contradicts the photo. */
  borderPenalty: number;
  /** Added per priority level (0 regular, 1 The List, 2 promo/collectible). */
  priorityStep: number;
  /**
   * Added to an exact twin of a regular printing: The List reprints and foil-only ★ printings. Real
   * collections hold far more originals; in a scanned binder, 9 of 34 cards with a List twin came out
   * as the List reprint when the penalty was a fraction of a point (photo noise decides a dead heat).
   */
  twinPenalty: number;
  /** Printings scoring within this of the best are treated as visually tied. */
  tieDistance: number;
  /** Tied printings whose prices differ by at least this ratio AND gap are flagged for the user to confirm. */
  priceRatio: number;
  priceGap: number;
  /** Border brightness below this reads as black, above `lightAbove` as white/gold/silver. */
  darkBelow: number;
  lightAbove: number;
}

export const DEFAULT_PRINTING: PrintingConfig = {
  borderPenalty: 8,
  priorityStep: 0.75,
  twinPenalty: 5,
  tieDistance: 3,
  priceRatio: 1.5,
  priceGap: 3,
  darkBelow: 95,
  lightAbove: 140,
};

export interface RankedPrinting {
  card: number;
  /** Visual distance to the photo. */
  d: number;
  /** d plus border and priority adjustments; lower is better. */
  score: number;
  borderConflict: boolean;
}

export function measuredBorder(luma: number | undefined | null, cfg: PrintingConfig = DEFAULT_PRINTING): 'dark' | 'light' | null {
  if (luma == null || !Number.isFinite(luma)) return null;
  return luma < cfg.darkBelow ? 'dark' : luma > cfg.lightAbove ? 'light' : null;
}

function borderClass(info: CardInfo): 'dark' | 'light' | null {
  if (info.border === 'black') return 'dark';
  if (info.border === 'white' || info.border === 'silver' || info.border === 'gold' || info.border === 'yellow') return 'light';
  return null;
}

/** The List reprint or a foil-only ★ printing: the same card as a regular printing. */
export function isTwin(info: CardInfo): boolean {
  return info.priority === 1 || info.set === 'plst' || info.cn.endsWith('★');
}

/** The set a printing comes from (a List reprint's collector number names it, e.g. "LGN-62"). */
export function originSet(info: CardInfo): string {
  return info.set === 'plst' && /^[A-Z0-9]{2,6}-/.test(info.cn) ? info.cn.split('-')[0].toLowerCase() : info.set;
}

/** A printing's reference price: regular, else foil, else etched. */
export function referencePrice(info: CardInfo): number | null {
  return info.prices.nonfoil ?? info.prices.foil ?? info.prices.etched ?? null;
}

/** Printings of a name, best guess first. */
export function rankPrintings(db: CardDB, nameIdx: number, query?: Uint32Array, borderLuma?: number, cfg: PrintingConfig = DEFAULT_PRINTING): RankedPrinting[] {
  const measured = measuredBorder(borderLuma, cfg);
  return db.printingsOf(nameIdx)
    .map((card) => {
      const info = db.info(card);
      const d = query ? fpDistance(query, db.fps, card) : 0;
      const cls = borderClass(info);
      const borderConflict = !!(measured && cls && measured !== cls);
      const preference = isTwin(info) ? cfg.twinPenalty : info.priority * cfg.priorityStep;
      return { card, d, borderConflict, score: d + (borderConflict ? cfg.borderPenalty : 0) + preference };
    })
    .sort((a, b) => a.score - b.score);
}

export interface PrintingChoice {
  card: number;
  /** True when visually tied printings differ materially in price, so the user should confirm. */
  ambiguous: boolean;
  /** Printings considered tied with the choice (including it). */
  ties: RankedPrinting[];
  ranked: RankedPrinting[];
}

export function resolvePrinting(db: CardDB, nameIdx: number, query?: Uint32Array, borderLuma?: number, cfg: PrintingConfig = DEFAULT_PRINTING): PrintingChoice {
  const ranked = rankPrintings(db, nameIdx, query, borderLuma, cfg);
  const best = ranked[0];
  // Tied: as close to the photo as the choice (preferences aside), so the user is asked if the price differs.
  const ties = ranked.filter((r) => r.card === best.card || (r.d - best.d <= cfg.tieDistance && !r.borderConflict));
  const bestPrice = referencePrice(db.info(best.card)) ?? 0;
  const ambiguous = ties.some((t) => {
    if (t.card === best.card) return false;
    const p = referencePrice(db.info(t.card)) ?? 0;
    const hi = Math.max(p, bestPrice), lo = Math.min(p, bestPrice);
    return hi - lo >= cfg.priceGap && hi >= lo * cfg.priceRatio;
  });
  return { card: best.card, ambiguous, ties, ranked };
}

/** Printings whose reference fingerprints are this close look the same in a photo. */
export const LOOKALIKE_BITS = 8;

/**
 * Binders are usually sorted by set, so the other cards on a page say which of several identical-looking
 * printings a card is. `pageSets` counts the (origin) sets of the other cards identified on the page; if
 * one set clearly leads and the card has a look-alike printing in it, that printing is returned.
 */
export function pageSetChoice(db: CardDB, card: number, pageSets: Map<string, number>, query?: Uint32Array): number | null {
  let top: string | null = null, n = 0, others = 0;
  for (const [set, k] of pageSets) {
    others += k;
    if (k > n) [top, n] = [set, k];
  }
  // At least 2 of the other cards, and at least 40% of them, are from that set.
  if (!top || n < 2 || n < 0.4 * others) return null;
  const info = db.info(card);
  if (info.set === top) return null;
  const ref = db.fps.subarray(card * FP_WORDS, (card + 1) * FP_WORDS);
  let pick: number | null = null, pickD = Infinity;
  for (const c of db.printingsOf(db.nameOf[card])) {
    if (c === card || db.info(c).set !== top || fpDistance(ref, db.fps, c) > LOOKALIKE_BITS) continue;
    const d = query ? fpDistance(query, db.fps, c) : 0;
    if (d < pickD) [pick, pickD] = [c, d];
  }
  return pick;
}
