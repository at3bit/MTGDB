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
}

export const DEFAULT_TRACK: TrackOptions = { retryBelow: 1, minGain: 2 };

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
  const start = opts.follow ? (usable ? alignCalibration(ref, usable, NARROW_ALIGN).calibration : alignCalibration(ref, base, DEFAULT_ALIGN).calibration) : base;
  let pockets = recognizeSpread(frames, start, idx, cfg);
  const pages: Quad[] = [...start.pages];
  const retried: number[] = [];
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
  return { pockets, calibration: { ...base, pages }, retried };
}
