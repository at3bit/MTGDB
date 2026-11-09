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

const better = (a: PageQuality, b: PageQuality) => a.matched > b.matched || (a.matched === b.matched && a.meanDistance < b.meanDistance - 0.5);

export interface TrackedSpread {
  pockets: PocketResult[];
  /** Where the pages were found in this spread; pass it as `prev` for the next one. */
  calibration: Calibration;
  /** Pages that read badly and were re-read from a different placement. */
  retried: number[];
}

/**
 * Reads one spread. Pages are searched for near where they were on the
 * previous spread (`prev`), since they drift only a little per page turn, or
 * around the user's outline (`base`) for the first spread. A page where most
 * cards don't match well is re-read from other placements (the previous
 * spread's, wide searches around it and around the outline, and the outline
 * itself), keeping whichever reads best, so one bad fit doesn't
 * cost a page or derail the tracking.
 */
export function recognizeTrackedSpread(
  frames: RGBAImage[],
  base: Calibration,
  prev: Calibration | undefined,
  idx: MatchIndex,
  cfg: RecognizeConfig = DEFAULT_RECOGNIZE,
): TrackedSpread {
  const ref = frames[0];
  const usable = prev && prev.pages.length === base.pages.length ? prev : undefined;
  const first = usable ? alignCalibration(ref, usable, NARROW_ALIGN).calibration : alignCalibration(ref, base, DEFAULT_ALIGN).calibration;
  let pockets = recognizeSpread(frames, first, idx, cfg);
  const pages: Quad[] = [...first.pages];
  const retried: number[] = [];
  let wideFromBase: Calibration | undefined;
  let wideFromPrev: Calibration | undefined;
  for (let p = 0; p < pages.length; p++) {
    const mine = pockets.filter((x) => x.page === p);
    const q = quality(mine);
    if (q.nonEmpty < 3 || q.matched >= q.nonEmpty * 0.6) continue;
    wideFromBase ??= alignCalibration(ref, base, DEFAULT_ALIGN).calibration;
    const candidates = [wideFromBase.pages[p], base.pages[p]];
    if (usable) {
      // Late in a thick binder the pages can be beyond reach of the outline; try around the last good position too.
      wideFromPrev ??= alignCalibration(ref, usable, DEFAULT_ALIGN).calibration;
      candidates.unshift(usable.pages[p], wideFromPrev.pages[p]);
    }
    let best = { pockets: mine, q, quad: pages[p] };
    for (const quad of candidates) {
      const single: Calibration = { ...base, pages: [quad] };
      const res = recognizeSpread(frames, single, idx, cfg).map((r) => ({ ...r, page: p }));
      const rq = quality(res);
      if (better(rq, best.q)) best = { pockets: res, q: rq, quad };
    }
    if (best.quad !== pages[p]) {
      pages[p] = best.quad;
      pockets = [...pockets.filter((x) => x.page !== p), ...best.pockets].sort((a, b) => a.page - b.page || a.slot - b.slot);
      retried.push(p);
    }
  }
  return { pockets, calibration: { ...base, pages }, retried };
}
