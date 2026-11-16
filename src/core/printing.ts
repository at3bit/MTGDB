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

/**
 * Printings whose reference fingerprints are this close can look the same in a photo. Reprints differ
 * from the original in small ways (the border, the copyright line, the set symbol): in a real binder the
 * app's wrong printings were 2.5-24 bits from the right one, most of them 7.5-12.5, closer than photo
 * noise can tell apart.
 */
export const LOOKALIKE_BITS = 14;
/** A page's set may pick a printing that fits the photo up to this much worse than the best fit (on a real binder's 206 cards: 4 -> 163 printings right, 8 -> 165, 12 -> 167). */
export const PAGE_SLACK = 8;

const refOf = (db: CardDB, c: number) => db.fps.subarray(c * FP_WORDS, (c + 1) * FP_WORDS);

/** The sets a card could be from, judging by the look of its printing: its own, and those of look-alikes. */
export function lookalikeSets(db: CardDB, card: number): Set<string> {
  const info = db.info(card);
  const out = new Set([info.set, originSet(info)]);
  const ref = refOf(db, card);
  for (const c of db.printingsOf(db.nameOf[card])) {
    if (c !== card && fpDistance(ref, db.fps, c) <= LOOKALIKE_BITS) out.add(originSet(db.info(c)));
  }
  return out;
}

/**
 * The printing of `card`'s name from `set` that looks like it and fits the photo (`query`) nearly as well
 * (within PAGE_SLACK), or null. Exact twins (List reprints, foil-only ★ printings) give way as usual.
 */
export function printingInSet(db: CardDB, card: number, set: string, query?: Uint32Array, cfg: PrintingConfig = DEFAULT_PRINTING): number | null {
  const ref = refOf(db, card);
  const base = query ? fpDistance(query, db.fps, card) : 0;
  let pick: number | null = null, pickScore = Infinity;
  for (const c of db.printingsOf(db.nameOf[card])) {
    const info = db.info(c);
    if (originSet(info) !== set || (c !== card && fpDistance(ref, db.fps, c) > LOOKALIKE_BITS)) continue;
    const d = query ? fpDistance(query, db.fps, c) : 0;
    if (d > base + PAGE_SLACK) continue;
    const score = d + (isTwin(info) ? cfg.twinPenalty : info.priority * cfg.priorityStep);
    if (score < pickScore) [pick, pickScore] = [c, score];
  }
  return pick;
}

/** What a card's collector line says: set code, collector number, and (older cards) cards in the set. */
export interface CollectorRead {
  set?: string;
  number?: number;
  total?: number;
}

const digitsOf = (s: string) => Number(s.replace(/[OoQD]/g, '0').replace(/[Il|]/g, '1'));

/**
 * Parses an OCR read of a card's bottom strip. Since 2015 cards print "079/249 U" over "MM2 • EN" (the
 * bullet reads as », «, *, + or =), since 2023 "M 0169" over "DFT • EN"; older cards end the copyright
 * line with "61/145" (collector number / cards in the set).
 */
export function parseCollectorLine(text: string, knownSets?: (code: string) => boolean): CollectorRead {
  const out: CollectorRead = {};
  const slash = /(?<![0-9A-Za-z])([0-9OQD]{1,4})\s*\/\s*([0-9OQDIl|]{2,4})(?![0-9])/.exec(text);
  if (slash) {
    out.number = digitsOf(slash[1]);
    out.total = digitsOf(slash[2]);
  } else {
    const plain = /(?<![0-9A-Za-z])[CURMLSPT]\s+([0-9OQ]{3,4})(?![0-9])/.exec(text);
    if (plain) out.number = digitsOf(plain[1]);
  }
  for (const m of text.matchAll(/(?<![A-Za-z0-9])([A-Z0-9]{3,5})\s*[»«*+•·.=,:;]?\s*E[NM](?![A-Za-z])/g)) {
    const code = m[1].toLowerCase();
    if (!knownSets || knownSets(code)) {
      out.set = code;
      break;
    }
  }
  return out;
}

/**
 * The printing of a card name that its collector line names: by set code (and number), or for older
 * cards by collector number (and the set's size). Null when the read doesn't single one out.
 */
export function printingFromCollector(db: CardDB, read: CollectorRead, nameIdx: number): number | null {
  const printings = db.printingsOf(nameIdx);
  const num = (c: number) => parseInt(db.info(c).cn, 10);
  if (read.set) {
    const inSet = printings.filter((c) => db.info(c).set === read.set);
    const exact = read.number !== undefined ? inSet.filter((c) => num(c) === read.number) : [];
    if (exact.length === 1) return exact[0];
    // The set alone: its regular printing (a set can hold a showcase or ★ copy too).
    const regular = inSet.filter((c) => !isTwin(db.info(c)) && db.info(c).priority === 0);
    if (regular.length === 1) return regular[0];
    if (inSet.length === 1) return inSet[0];
  }
  if (read.number !== undefined && !read.set) {
    const same = printings.filter((c) => num(c) === read.number && !isTwin(db.info(c)));
    if (same.length === 1) return same[0];
    if (same.length > 1 && read.total) {
      // Older cards print the set's size: the set whose numbers run up to it.
      const fits = same.filter((c) => Math.abs(db.setSize(db.info(c).set) - read.total!) <= 1);
      if (fits.length === 1) return fits[0];
    }
  }
  return null;
}
