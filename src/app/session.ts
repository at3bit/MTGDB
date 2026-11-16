// The results of one binder run, as shown in the review screen.
import type { Match } from '../core/fingerprint.ts';
import { isTwin, lookalikeSets, originSet, parseCollectorLine, printingFromCollector, printingInSet, resolvePrinting, rankPrintings as rankPrintingsCore, type RankedPrinting } from '../core/printing.ts';
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
  /** Title-line crop for reading the name (pixels, or a JPEG). Dropped once a matched card's name is read. */
  nameCrop?: WireImage | Blob;
  /** The collector line (a JPEG), read once to tell look-alike printings apart; dropped after. */
  infoCrop?: Blob;
  /** What was read from the collector line. */
  infoText?: string;
  /** The printing was read off the collector line: page context leaves it alone. */
  printingRead?: boolean;
  /** The review photo itself (thumbUrl points at it), kept so an unfinished scan can be saved (see draft.ts). */
  photo?: Blob;
  /** Stable id of this pocket reading, for the saved draft. */
  pid?: string;
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
  /** Empty: the sleeve holds a blank filler card. */
  blank?: boolean;
  /** The best match isn't one of the colours/types the binder was said to hold. */
  offCategory?: boolean;
  /**
   * The card's printed name, read with OCR, against the image match: 'agrees' confirms it, 'differs' means
   * the name clearly reads as another card (readName) so the pocket is flagged, 'unread' means no clean read.
   */
  nameCheck?: 'agrees' | 'differs' | 'unread';
  /** Card name (index into CardDB.names) read from the card when it differs from the match, or a weak read offered as a suggestion. */
  readName?: number;
  /** Checked by the user in the card-by-card approval step. */
  approved?: boolean;
  /** The printing was picked from look-alikes because most cards on its page are from this set. */
  pageSet?: string;
  /** What the app had chosen before the card check changed it (for the scan report, see report.ts). */
  firstGuess?: { card: number | null; status: PocketStatus; via: PocketView['via'] };
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
  /** The photo of a batch it was read from (a photo read again replaces this spread's reading). */
  photo?: number;
}

const MAX_MATCHES = 12;
let pidCount = 0;
const pidRun = Date.now().toString(36);
/** A new stable pocket-reading id. */
export function newPid(): string {
  return `${pidRun}-${(pidCount++).toString(36)}`;
}

/** Object URLs of review photos, released when a scan is discarded or replaced (releasePhotos). */
const photoUrls: string[] = [];
export function photoUrl(blob: Blob): string {
  const url = URL.createObjectURL(blob);
  photoUrls.push(url);
  return url;
}

/** Frees the review photos of the current scan (call when starting a new scan or leaving the review). */
export function releasePhotos() {
  for (const url of photoUrls.splice(0)) URL.revokeObjectURL(url);
}

/**
 * A card the app isn't sure of whose closest match isn't one of the binder's colours: the closest one
 * that is comes first. Unsure off-colour guesses were all wrong on a real black binder (a green Ooze for
 * Grim Return, a Plains for Stitch Together). A confident off-colour match (a misfiled card) stays.
 */
function inColourFirst(p: WirePocket, db: CardDB): Match[] {
  const pref = db.preferred;
  const best = p.matches[0];
  if (!pref || !best || p.status !== 'uncertain' || !p.offCategory) return p.matches;
  const confident = best.d <= ACCEPT.acceptDistance && p.otherNameDistance - best.d >= ACCEPT.acceptMargin;
  const i = p.matches.findIndex((m) => pref[m.card]);
  if (confident || i <= 0) return p.matches;
  return [p.matches[i], ...p.matches.filter((_, k) => k !== i)];
}

export function toPocketView(w: WirePocket, db: CardDB): PocketView {
  const reordered = inColourFirst(w, db);
  const p = reordered === w.matches ? w : { ...w, matches: reordered, offCategory: false };
  const chosen = p.status === 'empty' || !p.matches.length || p.status === 'unknown' ? null : p.matches[0].card;
  return settlePrinting(
    {
      page: p.page,
      slot: p.slot,
      status: p.status,
      // The best few candidates are all the review uses (a big binder holds hundreds of pockets).
      matches: p.matches.slice(0, MAX_MATCHES),
      otherNameDistance: p.otherNameDistance,
      thumbUrl: p.thumbJpeg ? photoUrl(p.thumbJpeg) : p.thumb ? imageToDataURL(p.thumb) : '',
      photo: p.thumbJpeg,
      pid: newPid(),
      query: p.query ? Uint32Array.from(p.query) : undefined,
      nameCrop: p.nameJpeg ?? p.nameCrop,
      infoCrop: p.infoJpeg,
      chosen,
      finish: 'nonfoil',
      via: chosen === null ? null : 'image',
      glare: p.glare,
      borderLuma: p.borderLuma,
      cardBack: p.cardBack,
      blurry: p.blurry,
      blank: p.blank,
      offCategory: p.offCategory,
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
  // The name stays as sure as it was; an ambiguous printing is flagged separately (printingCheck).
  return { ...p, chosen: choice.card, finish: finishFor(db, choice.card, p.finish), printingCheck: choice.ambiguous, ties: choice.ambiguous ? choice.ties.map((t) => t.card) : undefined };
}

/**
 * Binders are usually sorted by set. A page's set is the one the most cards on it could be from, judging
 * by the look of their printings (lookalikeSets): the app's own picks can scatter over reprints (a page
 * of Magic 2010 cards read as 10th Edition, Duel Deck and Fifth Dawn reprints), but most of the cards
 * have a look-alike in Magic 2010. If one set covers at least 2 of the other cards on the page, and 40% of
 * them, each card the app identified takes its look-alike printing from that set (printingInSet).
 * Cards the user picked count with the set they picked and aren't changed.
 */
export function preferPageSets(spread: Spread, db: CardDB): Spread {
  const counted = (p: PocketView) => p.chosen !== null && p.status === 'matched' && !p.ghost && !p.cardBack;
  const setsOf = new Map<PocketView, Set<string>>();
  for (const p of spread.pockets) {
    if (counted(p)) setsOf.set(p, p.via === 'manual' || p.printingRead ? new Set([originSet(db.info(p.chosen!))]) : lookalikeSets(db, p.chosen!));
  }
  let changed = false;
  const pockets = spread.pockets.map((p) => {
    if (!counted(p) || p.via === 'manual' || p.printingRead) return p;
    // How many of the other cards on this page each set covers.
    const cover = new Map<string, number>();
    let others = 0;
    for (const [q, sets] of setsOf) {
      if (q === p || q.page !== p.page) continue;
      others++;
      for (const s of sets) cover.set(s, (cover.get(s) ?? 0) + 1);
    }
    let top: string | null = null, n = 0, tied = false;
    for (const [s, k] of cover) {
      if (k > n) [top, n, tied] = [s, k, false];
      else if (k === n) tied = true;
    }
    if (!top || tied || n < 2 || n < 0.4 * others) return p;
    const info = db.info(p.chosen!);
    if (originSet(info) === top && !isTwin(info)) return p;
    const pick = printingInSet(db, p.chosen!, top, p.query);
    if (pick === null || pick === p.chosen) return p;
    changed = true;
    return { ...p, chosen: pick, finish: finishFor(db, pick, p.finish), pageSet: db.info(pick).set };
  });
  return changed ? { ...spread, pockets } : spread;
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
  /** Look for cards seen through empty sleeves at all (off when empty sleeves hold blank filler cards). */
  seeThrough: boolean;
}

export const DEFAULT_SESSION: SessionConfig = { turnChange: 0.35, pageAgreement: 0.5, ghostReach: 3, seeThroughSharpness: 0.45, seeThroughContrast: 0.85, seeThrough: true };

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
      // A see-through copy is behind extra plastic: it matches clearly worse than the real one.
      const hazier = dist(ghost) >= dist(real) + 3;
      // Two different printings, each read confidently and neither hazier: two real cards (a binder can hold
      // several printings of a card, and they're worth different amounts).
      const sure = (p: PocketView) => p.status === 'matched' && !p.printingCheck;
      if (ghost.chosen !== real.chosen && sure(ghost) && sure(real) && !hazier) return null;
      if (!BASIC_LAND.test(db.names[ng])) return 'same';
      return ghost.chosen === real.chosen || hazier ? 'same' : null;
    }
    // One of the two readings is unsure and has the other as a close runner-up. (Two confident, different
    // readings are two different cards.)
    const unsure = (p: PocketView) => p.status !== 'matched' || !!p.printingCheck;
    if ((unsure(real) && shortlist(real).has(ng)) || (unsure(ghost) && shortlist(ghost).has(nr))) return 'shortlist';
    return null;
  };
  const out: Spread[] = spreads.map((s) => ({ ...s, pockets: s.pockets.map((p) => ({ ...p, ghost: false, seeThrough: false })) }));
  if (!cfg.seeThrough) return keepUnchanged(spreads, out);
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
  return keepUnchanged(spreads, out);
}

/** The original spreads where nothing changed (cheaper re-renders). */
function keepUnchanged(spreads: Spread[], out: Spread[]): Spread[] {
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
  next[next.length - 1] = preferPageSets(next[next.length - 1], db);
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
      if (p.chosen === null || p.ghost || p.cardBack || nameUnsure(p)) continue;
      const key = `${db.info(p.chosen).id}:${finishFor(db, p.chosen, p.finish)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ flagged: needsCheck(p), spreadId: s.id, spreadIndex: si, page: p.page, slot: p.slot, card: p.chosen, finish: finishFor(db, p.chosen, p.finish), status: p.status });
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

/** A read this good is shown as the first guess for a card the picture didn't settle (see applyOcr). */
const FAIR_READ = 0.65;

/**
 * Uses the card's printed name, read with OCR. For a card the image match identified, it's a cross-check:
 * agreeing confirms it, a clean read of a different name flags it. For one it didn't, the name identifies
 * the card only when the read is clean or agrees with an image candidate; a weak read is only a suggestion,
 * so a misread never turns into a confident wrong card.
 */
export function applyOcr(p: PocketView, text: string, db: CardDB): PocketView {
  const hits = db.readName(text, 3);
  const top = hits[0];
  const strongRead = !!top && top.score >= 0.75 && (hits[1]?.score ?? 0) < top.score - 0.15;
  if (p.status === 'matched' && p.via === 'image' && p.chosen !== null) {
    const imageName = db.nameOf[p.chosen];
    if (top && top.score >= 0.45 && top.name === imageName) return { ...p, ocrText: text, nameCheck: 'agrees', nameCrop: undefined };
    if (strongRead && top.name !== imageName) return { ...p, ocrText: text, nameCheck: 'differs', readName: top.name, status: 'uncertain' };
    // The image match stands; the crop isn't needed again (memory adds up over a big binder).
    return { ...p, ocrText: text, nameCheck: 'unread', nameCrop: undefined };
  }
  if (!top || top.score < 0.45) return { ...p, ocrText: text, nameCheck: 'unread' };
  // The text agrees with one of the image candidates, or is a clean read on its own.
  const agreesWithImage = p.matches.some((m) => db.nameOf[m.card] === top.name);
  if (!agreesWithImage && !strongRead) {
    // A fair read (right 3 times in 4 on a real binder) beats an unsure picture match (right about half
    // the time): it's shown first, still marked unsure, so the user confirms it.
    if (top.score >= FAIR_READ) {
      const guess = resolvePrinting(db, top.name, p.query, p.borderLuma).card;
      return { ...p, ocrText: text, nameCheck: 'unread', readName: top.name, chosen: guess, finish: finishFor(db, guess, p.finish), via: 'text', status: 'uncertain', printingCheck: false, ties: undefined };
    }
    return { ...p, ocrText: text, nameCheck: 'unread', readName: top.name };
  }
  const choice = resolvePrinting(db, top.name, p.query, p.borderLuma);
  return { ...p, ocrText: text, nameCheck: 'agrees', chosen: choice.card, status: 'matched', via: 'text', printingCheck: choice.ambiguous, ties: choice.ambiguous ? choice.ties.map((t) => t.card) : undefined };
}

/**
 * The collector line is read for cards whose name has more than one printing (to tell them apart),
 * and for cards the app isn't sure of (it can name the card outright).
 */
export function needsInfoOcr(p: PocketView, db: CardDB): boolean {
  if (!p.infoCrop || p.via === 'manual' || p.cardBack || p.status === 'empty' || p.infoText !== undefined || p.chosen === null) return false;
  return p.status !== 'matched' || db.printingsOf(db.nameOf[p.chosen]).length > 1;
}

/**
 * Applies a read of the collector line (see parseCollectorLine). If it names a printing of the card,
 * that's the printing, and page context leaves it alone. For a card the app wasn't sure of, a set code
 * and number naming another card make that card the first guess (still to be checked) when something
 * else backs it: the picture had it among its candidates, or the name read points to it. Otherwise it is
 * offered among the options. (On real pages such reads were right 8 times in 9, but a misread number
 * once replaced a right but unsure guess; on cards already identified a misread digit can name another
 * card, so there the line only picks among the card's own printings.)
 */
export function applyInfoRead(p: PocketView, text: string, db: CardDB): PocketView {
  const base: PocketView = { ...p, infoText: text, infoCrop: undefined };
  if (p.chosen === null || p.via === 'manual') return base;
  const read = parseCollectorLine(text, (c) => db.hasSet(c));
  const own = printingFromCollector(db, read, db.nameOf[p.chosen]);
  if (own !== null) {
    return { ...base, chosen: own, finish: finishFor(db, own, p.finish), printingRead: true, printingCheck: false, ties: undefined, pageSet: undefined };
  }
  if (p.status !== 'matched' && read.set && read.number !== undefined) {
    const other = db.byCollector(read.set, read.number);
    if (other !== null && (!db.allowed || db.allowed[other])) {
      const name = db.nameOf[other];
      const backed =
        p.matches.some((m) => db.nameOf[m.card] === name) ||
        p.readName === name ||
        (!!p.ocrText && db.readName(p.ocrText, 3).some((h) => h.name === name && h.score >= 0.45));
      if (backed) return { ...base, chosen: other, finish: finishFor(db, other, p.finish), via: 'text', status: 'uncertain', printingRead: true, printingCheck: false, ties: undefined, pageSet: undefined };
      if (p.readName === undefined) return { ...base, readName: name };
    }
  }
  return base;
}

/** Every card's name is read once, as a cross-check (see applyOcr). */
export function needsOcr(p: PocketView): boolean {
  return !!p.nameCrop && p.via !== 'manual' && !p.cardBack && p.status !== 'empty' && p.nameCheck === undefined;
}

/** The card's name isn't settled: shown as a question, and not saved or counted until confirmed. */
export function nameUnsure(p: PocketView): boolean {
  return p.status === 'uncertain' && p.via !== 'manual';
}

export function pocketPrice(db: CardDB, p: { chosen: number | null; finish: Finish; ghost?: boolean; cardBack?: boolean }, live?: LivePrices): number | null {
  if (p.chosen === null || p.ghost || p.cardBack) return null;
  return cardPrice(db, p.chosen, p.finish, live);
}

export type LivePrices = Record<string, { nonfoil: number | null; foil: number | null; etched: number | null; at: string }>;

/** The finish asked for if the printing exists in it, else the printing's own (e.g. a foil-only promo). */
export function finishFor(db: CardDB, card: number, wanted: Finish): Finish {
  const fins = db.info(card).finishes;
  return fins.includes(wanted) || !fins.length ? wanted : fins[0];
}

export function cardPrice(db: CardDB, card: number, finish: Finish, live?: LivePrices): number | null {
  const info = db.info(card);
  const f = finishFor(db, card, finish);
  const l = live?.[info.id];
  if (l && l.at > db.file.built) return l[f] ?? null;
  return info.prices[f] ?? null;
}

export function spreadTotal(db: CardDB, s: Spread, live?: LivePrices): number {
  return s.pockets.reduce((t, p) => t + (pocketPrice(db, p, live) ?? 0), 0);
}

export const ACCEPT = DEFAULT_RECOGNIZE;

/** A pocket's address in the scan. */
export interface PocketKey {
  spread: number;
  page: number;
  slot: number;
}

/**
 * The cards to check one by one, in binder order: every pocket that holds a card (not empty sleeves,
 * card backs, or cards seen through a sleeve, which are recorded on their own page). `onlyToCheck`
 * keeps just the ones the app wasn't sure of.
 */
export function checkList(spreads: Spread[], onlyToCheck = false): PocketKey[] {
  const out: PocketKey[] = [];
  for (const s of spreads) {
    for (const p of [...s.pockets].sort((a, b) => a.page - b.page || a.slot - b.slot)) {
      if (p.ghost || p.cardBack || p.status === 'empty') continue;
      if (onlyToCheck && !needsCheck(p)) continue;
      out.push({ spread: s.id, page: p.page, slot: p.slot });
    }
  }
  return out;
}

export function findPocket(spreads: Spread[], k: PocketKey): PocketView | undefined {
  return spreads.find((s) => s.id === k.spread)?.pockets.find((p) => p.page === k.page && p.slot === k.slot);
}

/** At most this many printings of one name are offered to swipe through (most alike first). */
const MAX_PRINTINGS = 30;

/**
 * Options to swipe through for a pocket, best first: its current pick, the other printings of that name
 * (the most alike to the photo first), the name read from the card, then the other cards it looks like.
 * With `nameIdx` (a searched name): that name's printings only.
 */
export function cardOptions(db: CardDB, p: PocketView, nameIdx?: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const add = (c: number | undefined) => {
    if (c === undefined || c < 0 || seen.has(c) || (db.allowed && !db.allowed[c] && c !== p.chosen)) return;
    seen.add(c);
    out.push(c);
  };
  const printingsOf = (n: number) => rankPrintings(db, n, p).slice(0, MAX_PRINTINGS).map((r) => r.card);
  if (nameIdx !== undefined) {
    printingsOf(nameIdx).forEach(add);
    return out;
  }
  if (p.chosen !== null) add(p.chosen);
  const name = p.chosen !== null ? db.nameOf[p.chosen] : p.matches[0] ? db.nameOf[p.matches[0].card] : -1;
  if (name >= 0) printingsOf(name).forEach(add);
  if (p.readName !== undefined && p.readName !== name) add(printingsOf(p.readName)[0]);
  const names = new Set(out.map((c) => db.nameOf[c]));
  for (const m of p.matches) {
    const n = db.nameOf[m.card];
    if (names.has(n)) continue;
    names.add(n);
    add(printingsOf(n)[0] ?? m.card);
  }
  return out;
}

/** The user checked this pocket: it holds `card` (in `finish`). Their word is final. */
export function approvePocket(p: PocketView, card: number, finish: Finish): PocketView {
  return { ...p, firstGuess: firstGuessOf(p), chosen: card, finish, status: 'matched', via: 'manual', approved: true, printingCheck: false, seeThrough: false, ghost: false, cardBack: false };
}

const firstGuessOf = (p: PocketView): PocketView['firstGuess'] => p.firstGuess ?? { card: p.status === 'empty' || p.ghost || p.cardBack ? null : p.chosen, status: p.status, via: p.via };

/** The user says this sleeve is empty. */
export function approveEmpty(p: PocketView): PocketView {
  return { ...p, firstGuess: firstGuessOf(p), chosen: null, status: 'empty', via: 'manual', approved: true, printingCheck: false, seeThrough: false };
}
