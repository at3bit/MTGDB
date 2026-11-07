// Picks the printing once the card's name is known.
//
// Many cards have several printings that look nearly identical from the
// front, and their prices can differ a lot (Beta vs. Collectors' Edition,
// an original vs. a white-bordered reprint, a set card vs. its promo).
// The resolver combines:
//   - the visual distance of each printing to the photographed card,
//   - the printed border colour measured in the photo vs. Scryfall's
//     border_color (black vs. white/gold/silver),
//   - a mild preference for regular printings over promos and The List,
// and reports when the remaining look-alikes differ enough in price that the
// collector should confirm which one it is.
import { fpDistance } from './fingerprint.ts';
import type { CardDB, CardInfo } from './carddb.ts';

export interface PrintingConfig {
  /** Added to a printing's distance when its border colour contradicts the photo. */
  borderPenalty: number;
  /** Added per priority level (0 regular, 1 The List, 2 promo/collectible). */
  priorityStep: number;
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

/** A printing's reference price: regular, else foil, else etched. */
export function referencePrice(info: CardInfo): number | null {
  return info.prices.nonfoil ?? info.prices.foil ?? info.prices.etched ?? null;
}

/** Printings of a name, best guess first. */
export function rankPrintings(db: CardDB, nameIdx: number, query?: Uint32Array, borderLuma?: number, cfg: PrintingConfig = DEFAULT_PRINTING): RankedPrinting[] {
  const measured = measuredBorder(borderLuma, cfg);
  return db.printings[nameIdx]
    .map((card) => {
      const info = db.info(card);
      const d = query ? fpDistance(query, db.fps, card) : 0;
      const cls = borderClass(info);
      const borderConflict = !!(measured && cls && measured !== cls);
      return { card, d, borderConflict, score: d + (borderConflict ? cfg.borderPenalty : 0) + info.priority * cfg.priorityStep };
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
  const ties = ranked.filter((r) => r.score - best.score <= cfg.tieDistance);
  const bestPrice = referencePrice(db.info(best.card)) ?? 0;
  const ambiguous = ties.some((t) => {
    if (t.card === best.card) return false;
    const p = referencePrice(db.info(t.card)) ?? 0;
    const hi = Math.max(p, bestPrice), lo = Math.min(p, bestPrice);
    return hi - lo >= cfg.priceGap && hi >= lo * cfg.priceRatio;
  });
  return { card: best.card, ambiguous, ties, ranked };
}
