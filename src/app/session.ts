// The results of one binder run, as shown in the review screen.
import type { Match } from '../core/fingerprint.ts';
import { resolvePrinting, rankPrintings as rankPrintingsCore, type RankedPrinting } from '../core/printing.ts';
import { DEFAULT_RECOGNIZE, type PocketStatus } from '../core/recognize.ts';
import type { CardDB, Finish } from '../core/carddb.ts';
import type { WireImage, WirePocket } from './protocol.ts';
import { imageToDataURL } from './capture.ts';

export interface PocketView {
  page: number;
  slot: number;
  status: PocketStatus;
  matches: Match[];
  otherNameDistance: number;
  thumbUrl: string;
  query?: Uint32Array;
  nameCrop?: WireImage;
  /** Chosen card (index into the CardDB), or null for empty / unidentified. */
  chosen: number | null;
  finish: Finish;
  /** How the current choice was made. */
  via: 'image' | 'text' | 'manual' | null;
  ocrText?: string;
  glare: number;
  /** Brightness of the card's printed border in the photo. */
  borderLuma?: number;
  /** Focus and contrast of the card in the photo; see-through cards are softer and flatter than their page. */
  sharpness?: number;
  contrast?: number;
  /** Look-alike printings with different prices: the user should confirm which one. */
  printingCheck?: boolean;
  /** The look-alike printings (card indices) when printingCheck is set. */
  ties?: number[];
  /** Sharp crop of the photo's set-symbol area (data URL), shown when choosing between look-alike printings. */
  symbolUrl?: string;
  /** The sleeve shows the back of a card (in the sleeve's other side): treated as empty. */
  cardBack?: boolean;
  /** Identified from a blurry photo (too little fine detail): worth re-scanning that page. */
  blurry?: boolean;
  /**
   * The card was seen through an empty sleeve: it's really on a neighbouring
   * sheet, where it's recorded. Not counted or saved here. Recomputed after
   * every capture (see markGhosts).
   */
  ghost?: boolean;
  /**
   * Much softer and flatter than the other cards on its page, as a card seen
   * through an empty sleeve is, but no copy was found on a neighbouring sheet.
   * Shown for checking rather than as identified. Recomputed with `ghost`.
   */
  seeThrough?: boolean;
}

export interface Spread {
  id: number;
  /** Seconds into the run when it was captured. */
  time: number;
  pockets: PocketView[];
}

/** Object URLs of review photos, released when a scan is discarded or replaced (releasePhotos). */
const photoUrls: string[] = [];
function photoUrl(blob: Blob): string {
  const url = URL.createObjectURL(blob);
  photoUrls.push(url);
  return url;
}

/** Frees the review photos of the current scan (call when starting a new scan or leaving the review). */
export function releasePhotos() {
  for (const url of photoUrls.splice(0)) URL.revokeObjectURL(url);
}

export function toPocketView(p: WirePocket, db: CardDB): PocketView {
  const chosen = p.status === 'empty' || !p.matches.length || p.status === 'unknown' ? null : p.matches[0].card;
  return settlePrinting(
    {
      page: p.page,
      slot: p.slot,
      status: p.status,
      matches: p.matches,
      otherNameDistance: p.otherNameDistance,
      thumbUrl: p.thumbJpeg ? photoUrl(p.thumbJpeg) : p.thumb ? imageToDataURL(p.thumb) : '',
      query: p.query ? Uint32Array.from(p.query) : undefined,
      nameCrop: p.nameCrop,
      chosen,
      finish: 'nonfoil',
      via: chosen === null ? null : 'image',
      glare: p.glare,
      borderLuma: p.borderLuma,
      cardBack: p.cardBack,
      blurry: p.blurry,
      sharpness: p.sharpness,
      contrast: p.contrast,
      symbolUrl: p.symbolCrop ? imageToDataURL(p.symbolCrop, 0.9) : undefined,
    },
    db,
  );
}

/**
 * Once the name is settled, picks the most likely printing (border colour,
 * regular over promo) and flags look-alike printings that differ in price.
 */
export function settlePrinting(p: PocketView, db: CardDB): PocketView {
  if (p.chosen === null || p.via === 'manual') return p;
  const choice = resolvePrinting(db, db.nameOf[p.chosen], p.query, p.borderLuma);
  const status: PocketStatus = choice.ambiguous && p.status === 'matched' ? 'uncertain' : p.status;
  return { ...p, chosen: choice.card, status, printingCheck: choice.ambiguous, ties: choice.ambiguous ? choice.ties.map((t) => t.card) : undefined };
}

/** One capture of a spread, as it arrives from the recognizer. */
export interface Reading {
  pockets: PocketView[];
  time: number;
  /** How different the view looked from the previous capture (thumbnail difference; Infinity for the first). */
  change: number;
  /** Captured with the Snap button rather than automatically. */
  manual: boolean;
}

export interface SessionConfig {
  /** A view this different from the last capture means the page was turned (repeat captures measure ~0.1-0.25). */
  turnChange: number;
  /** A page whose identified cards agree less than this with the last capture has changed. */
  pageAgreement: number;
  /** How many spreads ahead/behind to look for a card seen through an empty sleeve. */
  ghostReach: number;
  /** A card this much softer AND flatter than its page's typical card is probably behind an empty sleeve. */
  seeThroughSharpness: number;
  seeThroughContrast: number;
}

export const DEFAULT_SESSION: SessionConfig = { turnChange: 0.35, pageAgreement: 0.5, ghostReach: 3, seeThroughSharpness: 0.45, seeThroughContrast: 0.85 };

/** Pockets the user should look at: unsure readings, look-alike printings, and suspected see-through cards. */
export function needsCheck(p: PocketView): boolean {
  if (p.ghost || p.cardBack || p.status === 'empty') return false;
  return p.status !== 'matched' || !!p.printingCheck || !!p.seeThrough;
}

const nameAt = (p: PocketView | undefined, db: CardDB) => (p && p.chosen !== null && !p.ghost ? db.nameOf[p.chosen] : -1);

/** Per page: how many pockets were identified in both captures, and how many of those agree on the card. */
function pageAgreement(a: PocketView[], b: PocketView[], page: number, db: CardDB) {
  let both = 0, agree = 0;
  for (const pa of a) {
    if (pa.page !== page) continue;
    const pb = b.find((p) => p.page === page && p.slot === pa.slot);
    const na = nameAt(pa, db), nb = nameAt(pb, db);
    if (na < 0 || nb < 0) continue;
    both++;
    if (na === nb) agree++;
  }
  return { both, agree };
}

/**
 * Is this capture the same spread as the last one (a hand passed over, rested
 * on the page, or Snap pressed twice) rather than a new page?
 *
 * Judged per page, because cards seen through empty sleeves can make the
 * right-hand page look partly unchanged after a turn; the left-hand page
 * always changes completely when a page is turned.
 */
export function isRepeat(last: Spread, reading: Reading, pagesPerSpread: number, db: CardDB, cfg: SessionConfig = DEFAULT_SESSION): boolean {
  const pages = Array.from({ length: pagesPerSpread }, (_, p) => pageAgreement(last.pockets, reading.pockets, p, db));
  const disagrees = pages.some((a) => a.both >= 3 && a.agree / a.both < cfg.pageAgreement);
  if (disagrees) return false;
  if (reading.change < cfg.turnChange) return true;
  // The view changed a lot, but every page's cards agree strongly (e.g. a big hand in the first shot).
  return pages.every((a) => a.both >= 3 && a.agree / a.both >= 0.8);
}

/**
 * Marks cards seen through empty sleeves. Physically, the right-hand page has
 * the rest of the binder under it, so a card seen through one of its empty
 * sleeves is on a later sheet and shows up in the same slot of a later
 * spread. The left-hand page has the pages already turned under it, so its
 * see-through cards appeared in the same slot of an earlier spread. The copy
 * that isn't in its real place is marked as a ghost.
 */
const BASIC_LAND = /^(Snow-Covered )?(Plains|Island|Swamp|Mountain|Forest|Wastes)$/;

export function markGhosts(spreads: Spread[], pagesPerSpread: number, db: CardDB, cfg: SessionConfig = DEFAULT_SESSION): Spread[] {
  const rightPage = pagesPerSpread - 1; // with one page per spread, that page has the binder under it too
  const nameOf = (p: PocketView) => (p.chosen !== null ? db.nameOf[p.chosen] : -1);
  const dist = (p: PocketView) => p.matches[0]?.d ?? 99;
  /** Close runners-up only: candidates within a few points of the best match. */
  const shortlist = (p: PocketView) => new Set(p.matches.slice(0, 6).filter((m) => m.d <= dist(p) + 6).map((m) => db.nameOf[m.card]));
  /** Are `ghost` (seen through a sleeve) and `real` two readings of the same physical card? */
  const linked = (ghost: PocketView, real: PocketView): 'same' | 'shortlist' | null => {
    const ng = nameOf(ghost), nr = nameOf(real);
    if (ng < 0 || nr < 0) return null;
    // Same card in the same slot of a neighbouring sheet: see-through (quantities aren't tracked, and the two
    // readings often settle on different printings). Basic lands are the exception: whole pages of them are
    // common, so there it takes the same printing or a clearly hazier copy.
    if (ng === nr) {
      if (!BASIC_LAND.test(db.names[ng])) return 'same';
      return ghost.chosen === real.chosen || dist(ghost) >= dist(real) + 3 ? 'same' : null;
    }
    // One of the two readings is unsure and has the other as a close runner-up. (Two confident, different
    // readings are two different cards.)
    const unsure = (p: PocketView) => p.status !== 'matched' || !!p.printingCheck;
    if ((unsure(real) && shortlist(real).has(ng)) || (unsure(ghost) && shortlist(ghost).has(nr))) return 'shortlist';
    return null;
  };
  const out: Spread[] = spreads.map((s) => ({ ...s, pockets: s.pockets.map((p) => ({ ...p, ghost: false, seeThrough: false })) }));
  const find = (s: Spread | undefined, page: number, slot: number) => s?.pockets.find((p) => p.page === page && p.slot === slot);
  out.forEach((s, i) => {
    for (const p of s.pockets) {
      if (nameOf(p) < 0 || p.via === 'manual') continue;
      // The real copy is on a later sheet (right page) or an earlier one (left page), in the same slot.
      const later = p.page === rightPage;
      for (let d = 1; d <= cfg.ghostReach; d++) {
        const real = find(out[later ? i + d : i - d], p.page, p.slot);
        if (!real) continue;
        const link = linked(p, real);
        if (!link) continue;
        p.ghost = true;
        // If the real copy was misread but the see-through one is among its candidates, use that identity.
        if (link === 'shortlist' && real.via !== 'manual' && real.status !== 'matched' && shortlist(real).has(nameOf(p))) {
          real.chosen = resolvePrinting(db, nameOf(p), real.query, real.borderLuma).card;
        }
        break;
      }
    }
  });
  // Unlinked cards that look like they're behind extra plastic: much softer and flatter than their page.
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  for (const s of out) {
    const cards = s.pockets.filter((p) => p.status !== 'empty' && !p.cardBack && p.sharpness && p.contrast);
    if (cards.length < 4) continue;
    const mSharp = median(cards.map((p) => p.sharpness!)), mContrast = median(cards.map((p) => p.contrast!));
    for (const p of cards) {
      if (p.ghost || p.via === 'manual' || p.chosen === null) continue;
      p.seeThrough = p.sharpness! < cfg.seeThroughSharpness * mSharp && p.contrast! < cfg.seeThroughContrast * mContrast;
    }
  }
  // Keep the original objects where nothing changed (cheaper re-renders).
  return out.map((s, i) => {
    const orig = spreads[i];
    const same = s.pockets.every((p, k) => {
      const o = orig.pockets[k];
      return !!p.ghost === !!o.ghost && !!p.seeThrough === !!o.seeThrough && p.chosen === o.chosen;
    });
    return same ? orig : s;
  });
}

/** Adds a capture to the run: merged into the last spread if it's a repeat, otherwise a new spread. */
export function addReading(spreads: Spread[], reading: Reading, pagesPerSpread: number, db: CardDB, cfg: SessionConfig = DEFAULT_SESSION): Spread[] {
  const last = spreads[spreads.length - 1];
  const next =
    last && isRepeat(last, reading, pagesPerSpread, db, cfg)
      ? [...spreads.slice(0, -1), { ...last, pockets: mergeInto(last.pockets, reading.pockets) }]
      : [...spreads, { id: (last?.id ?? 0) + 1, time: reading.time, pockets: reading.pockets }];
  return markGhosts(next, pagesPerSpread, db, cfg);
}

export interface BinderEntry {
  /** Shown orange/red at save time (unsure, look-alike printing or suspected see-through). */
  flagged: boolean;
  spreadId: number;
  /** 0-based spread position in the run. */
  spreadIndex: number;
  page: number;
  slot: number;
  card: number;
  finish: Finish;
  status: PocketStatus;
}

/**
 * What saving the run stores: one entry per printing and finish (quantities
 * aren't tracked), at the first place it was seen, leaving out empty sleeves,
 * card backs, unidentified pockets and cards seen through empty sleeves.
 */
export function binderEntries(spreads: Spread[], _pagesPerSpread: number, db: CardDB): BinderEntry[] {
  const seen = new Set<string>();
  const out: BinderEntry[] = [];
  spreads.forEach((s, si) => {
    for (const p of [...s.pockets].sort((a, b) => a.page - b.page || a.slot - b.slot)) {
      if (p.chosen === null || p.ghost || p.cardBack) continue;
      const key = `${db.info(p.chosen).id}:${p.finish}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ flagged: needsCheck(p), spreadId: s.id, spreadIndex: si, page: p.page, slot: p.slot, card: p.chosen, finish: p.finish, status: p.status });
    }
  });
  return out;
}

const RANK: Record<PocketStatus, number> = { matched: 3, uncertain: 2, unknown: 1, empty: 0 };

/** Merges a duplicate capture into an existing spread, keeping the better result per pocket. */
export function mergeInto(a: PocketView[], b: PocketView[]): PocketView[] {
  return a.map((pa) => {
    if (pa.via === 'manual') return pa;
    // ghost flags are recomputed after merging
    const pb = b.find((p) => p.page === pa.page && p.slot === pa.slot);
    if (!pb) return pa;
    if (RANK[pb.status] !== RANK[pa.status]) return RANK[pb.status] > RANK[pa.status] ? pb : pa;
    return (pb.matches[0]?.d ?? Infinity) < (pa.matches[0]?.d ?? Infinity) ? pb : pa;
  });
}

/** Printings of a name, most likely for this photo first. */
export function rankPrintings(db: CardDB, nameIdx: number, pocket?: Pick<PocketView, 'query' | 'borderLuma'>): RankedPrinting[] {
  return rankPrintingsCore(db, nameIdx, pocket?.query, pocket?.borderLuma);
}

/** Applies an OCR reading of the title line to a pocket. */
export function applyOcr(p: PocketView, text: string, db: CardDB): PocketView {
  const hits = db.fuzzyNames(text, 3);
  const top = hits[0];
  if (!top || top.score < 0.45) return { ...p, ocrText: text };
  const choice = resolvePrinting(db, top.name, p.query, p.borderLuma);
  // The text agrees with one of the image candidates, or is a clean read on its own.
  const agreesWithImage = p.matches.some((m) => db.nameOf[m.card] === top.name);
  const strongRead = top.score >= 0.75 && (hits[1]?.score ?? 0) < top.score - 0.15;
  const status: PocketStatus = (agreesWithImage || strongRead) && !choice.ambiguous ? 'matched' : 'uncertain';
  return { ...p, ocrText: text, chosen: choice.card, status, via: 'text', printingCheck: choice.ambiguous, ties: choice.ambiguous ? choice.ties.map((t) => t.card) : undefined };
}

export function needsOcr(p: PocketView): boolean {
  return !!p.nameCrop && p.via !== 'manual' && (p.status === 'uncertain' || p.status === 'unknown');
}

export function pocketPrice(db: CardDB, p: { chosen: number | null; finish: Finish; ghost?: boolean; cardBack?: boolean }, live?: LivePrices): number | null {
  if (p.chosen === null || p.ghost || p.cardBack) return null;
  return cardPrice(db, p.chosen, p.finish, live);
}

export type LivePrices = Record<string, { nonfoil: number | null; foil: number | null; etched: number | null; at: string }>;

export function cardPrice(db: CardDB, card: number, finish: Finish, live?: LivePrices): number | null {
  const info = db.info(card);
  const l = live?.[info.id];
  if (l && l.at > db.file.built) return l[finish] ?? null;
  return info.prices[finish] ?? null;
}

export function spreadTotal(db: CardDB, s: Spread, live?: LivePrices): number {
  return s.pockets.reduce((t, p) => t + (pocketPrice(db, p, live) ?? 0), 0);
}

export const ACCEPT = DEFAULT_RECOGNIZE;
