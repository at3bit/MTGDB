// One spread of a run: find the pages, read the pockets, and double-check any
// page that reads badly.
import { alignCalibration, DEFAULT_ALIGN, NARROW_ALIGN } from './align.ts';
import type { Calibration, Quad } from './geometry.ts';
import type { RGBAImage } from './image.ts';
import { DEFAULT_RECOGNIZE, recognizeSpread, type MatchIndex, type PocketResult, type RecognizeConfig } from './recognize.ts';

interface PageQuality {
  nonEmpty: number;
  matched: number;
  meanDistance: number;
}

function quality(pockets: PocketResult[]): PageQuality {
  const nonEmpty = pockets.filter((p) => p.status !== 'empty');
  const d = nonEmpty.map((p) => p.matches[0]?.d ?? 99);
  return {
    nonEmpty: nonEmpty.length,
    matched: nonEmpty.filter((p) => p.status === 'matched').length,
    meanDistance: d.length ? d.reduce((a, b) => a + b, 0) / d.length : 99,
  };
}

/**
 * A capture taken mid-turn (from a pause too short to settle) can catch the
 * page in motion. Such a reading matches almost nothing: drop it rather than
 * add a spread of unknown cards.
 */
export function isJunkReading(pockets: Pick<PocketResult, 'status'>[]): boolean {
  const nonEmpty = pockets.filter((p) => p.status !== 'empty').length;
  const matched = pockets.filter((p) => p.status === 'matched').length;
  return matched === 0 || (nonEmpty >= 3 && matched < 0.4 * nonEmpty);
}

const better = (a: PageQuality, b: PageQuality) => a.matched > b.matched || (a.matched === b.matched && a.meanDistance < b.meanDistance - 0.5);

export interface TrackedSpread {
  pockets: PocketResult[];
  /** Where the pages were found in this spread; pass it as `prev` for the next one. */
  calibration: Calibration;
  /** Pages that read badly and were re-read from a different placement. */
  retried: number[];
  /** Quarter turns of each page relative to the outline (2 = the cards are upside down); pass on as TrackOptions.turns. */
  turns: number[];
}

/** A page quad turned by `k` quarter turns: its corners start `k` places later, so the cards are read that much turned. */
export function turnQuad(q: Quad, k: number): Quad {
  return [0, 1, 2, 3].map((i) => q[(i + k) % 4]) as Quad;
}

/**
 * Reads one spread with the user's outline as it is: it's where the user put
 * it, and moving it automatically did more harm than good on real binders
 * (the page finder nudges even a correct outline, and sleeve seams, glare and
 * binder rings can pull it a whole pocket off). Only a page that reads badly
 * (most of its cards unidentified) is tried at other placements: found near
 * the outline, near where that page read well last time (`prev`; pages can
 * drift in a thick binder), and wider around both. A placement is used only
 * if it identifies clearly more cards (at least 2 more). The calibration
 * returned is where each page was read from; `retried` lists the pages that
 * had to be moved, a sign the outline needs re-lining-up.
 */
export interface TrackOptions {
  /** Try other placements for a page when fewer than this fraction of its cards were identified. */
  retryBelow: number;
  /** A different placement is used only if it identifies at least this many more cards. */
  minGain: number;
  /** The old behaviour, for comparison: re-find the pages on every spread and follow them. */
  follow?: boolean;
  /** Quarter turns per page found on the previous spread (see TrackedSpread.turns). */
  turns?: number[];
}

/** A page is turned if its cards come this much closer (mean fingerprint distance) another way up… */
const TURN_CLOSER = 3.5;
/** …and that way they are close enough to be real cards (the wrong way up averaged 36-41). */
const TURN_MAX_MEAN = 37;

// Retrying placements only when 2+ cards of a page are unidentified read the same as on any miss (simulated drifting binders) and costs less.
export const DEFAULT_TRACK: TrackOptions = { retryBelow: 0.85, minGain: 2 };

export function recognizeTrackedSpread(
  frames: RGBAImage[],
  base: Calibration,
  prev: Calibration | undefined,
  idx: MatchIndex,
  cfg: RecognizeConfig = DEFAULT_RECOGNIZE,
  opts: TrackOptions = DEFAULT_TRACK,
): TrackedSpread {
  const ref = frames[0];
  const usable = prev && prev.pages.length === base.pages.length ? prev : undefined;
  // The outline in card order: turned as the cards were found on the previous spread.
  const turns = base.pages.map((_, p) => opts.turns?.[p] ?? 0);
  const outline = base;
  base = { ...outline, pages: outline.pages.map((q, p) => turnQuad(q, turns[p])) };
  const start = opts.follow ? (usable ? alignCalibration(ref, usable, NARROW_ALIGN).calibration : alignCalibration(ref, base, DEFAULT_ALIGN).calibration) : base;
  let pockets = recognizeSpread(frames, start, idx, cfg);
  const pages: Quad[] = [...start.pages];
  const retried: number[] = [];
  // A page that reads badly may be the wrong way round: the cards upside down (the binder facing the other
  // way) or sideways relative to the outline. Read upside down, every card on a real page came back wrong.
  for (let p = 0; p < pages.length; p++) {
    const mine = pockets.filter((x) => x.page === p);
    const q = quality(mine);
    if (q.nonEmpty < 3 || q.matched >= q.nonEmpty * 0.6) continue;
    let best = { pockets: mine, q, turn: turns[p] };
    for (const k of [2, 1, 3]) {
      const turn = (turns[p] + k) % 4;
      const quad = turnQuad(outline.pages[p], turn);
      const res = recognizeSpread(frames, { ...base, pages: [quad] }, idx, cfg).map((r) => ({ ...r, page: p }));
      const rq = quality(res);
      // Clearly more cards identified, or cards clearly closer to real ones: read the wrong way up, cards
      // match nothing in particular (mean distance 36-41 on 30 real pages), while the right way, even before
      // the outline is fitted, came 4-20 closer on 29 of them. Counting confident matches alone got 3 of
      // those pages backwards: a wrong way up can turn up a couple of chance "matches".
      const closer = rq.meanDistance <= best.q.meanDistance - TURN_CLOSER && rq.meanDistance <= TURN_MAX_MEAN;
      if (rq.matched >= best.q.matched + opts.minGain || closer) best = { pockets: res, q: rq, turn };
    }
    if (best.turn !== turns[p]) {
      turns[p] = best.turn;
      pages[p] = turnQuad(outline.pages[p], best.turn);
      base = { ...base, pages: base.pages.map((b, i) => (i === p ? pages[p] : b)) };
      pockets = [...pockets.filter((x) => x.page !== p), ...best.pockets].sort((a, b) => a.page - b.page || a.slot - b.slot);
      continue;
    }
    // Before the outline is fitted to the cards, the page can read poorly either way up: on real photos of an
    // upside-down page, the right way read 3 of 9 cards unfitted (the wrong way 2) but 8 of 9 once fitted. So
    // fit it both ways (the fit follows the cards' name bar and type line, so each way needs its own) and turn
    // the page only if upside down then reads clearly better.
    const readAt = (quad: Quad) => {
      const res = recognizeSpread(frames, { ...base, pages: [quad] }, idx, cfg).map((r) => ({ ...r, page: p }));
      return { pockets: res, q: quality(res), quad };
    };
    const fitted = (quad: Quad) => [NARROW_ALIGN, DEFAULT_ALIGN].map((a) => alignCalibration(ref, { ...base, pages: [quad] }, a).calibration.pages[0]);
    const most = <T extends { q: PageQuality }>(xs: T[]) => xs.reduce((a, b) => (b.q.matched > a.q.matched ? b : a));
    const here = most([{ pockets: mine, q, quad: pages[p] }, ...fitted(pages[p]).map(readAt)]);
    if (here.q.matched >= q.nonEmpty * 0.6) continue; // fitted the way it is, the page reads well
    const flip = turnQuad(outline.pages[p], (turns[p] + 2) % 4);
    const flipped = most(fitted(flip).map(readAt));
    if (flipped.q.matched >= here.q.matched + opts.minGain) {
      turns[p] = (turns[p] + 2) % 4;
      pages[p] = flipped.quad;
      base = { ...base, pages: base.pages.map((b, i) => (i === p ? flip : b)) };
      pockets = [...pockets.filter((x) => x.page !== p), ...flipped.pockets].sort((a, b) => a.page - b.page || a.slot - b.slot);
    }
  }
  let narrowFromBase: Calibration | undefined;
  let wideFromBase: Calibration | undefined;
  let narrowFromPrev: Calibration | undefined;
  for (let p = 0; p < pages.length; p++) {
    const mine = pockets.filter((x) => x.page === p);
    const q = quality(mine);
    if (q.nonEmpty < 3 || q.matched >= q.nonEmpty * Math.min(opts.retryBelow, opts.follow ? 0.6 : 1) - 1e-9) continue;
    narrowFromBase ??= alignCalibration(ref, base, NARROW_ALIGN).calibration;
    wideFromBase ??= alignCalibration(ref, base, DEFAULT_ALIGN).calibration;
    const candidates = [narrowFromBase.pages[p], wideFromBase.pages[p]];
    if (usable) {
      narrowFromPrev ??= alignCalibration(ref, usable, NARROW_ALIGN).calibration;
      candidates.push(usable.pages[p], narrowFromPrev.pages[p]);
    }
    let best = { pockets: mine, q, quad: pages[p] };
    for (const quad of candidates) {
      const single: Calibration = { ...base, pages: [quad] };
      const res = recognizeSpread(frames, single, idx, cfg).map((r) => ({ ...r, page: p }));
      const rq = quality(res);
      const gain = opts.follow ? 1 : opts.minGain;
      if (rq.matched >= best.q.matched + gain || (best.quad !== pages[p] && better(rq, best.q))) best = { pockets: res, q: rq, quad };
    }
    if (best.quad !== pages[p]) {
      pages[p] = best.quad;
      pockets = [...pockets.filter((x) => x.page !== p), ...best.pockets].sort((a, b) => a.page - b.page || a.slot - b.slot);
      retried.push(p);
    }
  }
  return { pockets, calibration: { rows: outline.rows, cols: outline.cols, pages }, retried, turns };
}
