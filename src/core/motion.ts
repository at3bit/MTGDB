// Page-turn detection for a "run" through a binder.
//
// The camera is fixed on a tripod, so the only thing that moves is the page
// (and your hand). We sample small thumbnails of the binder area a few times a
// second and track how much each differs from the previous one:
//
//   moving  -> difference stays below `stillThreshold` for `stillFrames`
//              samples -> "settled"
//   settled -> compare with the last captured spread; if it looks different
//              it's a new spread and should be captured, otherwise (e.g. your
//              hand passed over without turning the page) it's ignored.
//
// Fast page turning leaves pauses too short to "settle". So while the page is
// nearly still, the stillest moment so far is kept as a candidate
// ('candidate': grab this frame), and if the next turn starts before the page
// settled, that candidate is captured instead ('brief').
import { meanAbsDiff, normalizedDiff, type GrayImage } from './image.ts';

export interface MotionConfig {
  /** Mean abs difference (0..255) between consecutive samples that counts as motion. */
  moveThreshold: number;
  /** Below this the scene counts as still. */
  stillThreshold: number;
  /** Consecutive still samples needed to call the page settled. */
  stillFrames: number;
  /** Normalised difference from the last captured spread above which a settled view is a new spread. */
  newSpreadThreshold: number;
  /** A pause too short to settle is still captured if the page got at least this still (between still and move). */
  briefThreshold: number;
}

export const DEFAULT_MOTION: MotionConfig = {
  moveThreshold: 4,
  stillThreshold: 2,
  stillFrames: 2,
  // Low on purpose: any settled view that differs at all is captured, and
  // repeat captures of the same spread are merged later by card name (keeping
  // the better reading of each pocket, e.g. once a resting hand has lifted).
  newSpreadThreshold: 0.08,
  briefThreshold: 2.5,
};

/**
 * Rescales a thumbnail to a fixed mean and contrast, so the camera's
 * auto-exposure settling after a page turn doesn't count as movement.
 */
export function normalizeBrightness(g: GrayImage): GrayImage {
  let s = 0, s2 = 0;
  for (const v of g.data) { s += v; s2 += v * v; }
  const n = g.data.length;
  const mean = s / n;
  const std = Math.sqrt(Math.max(0, s2 / n - mean * mean));
  const k = std > 1 ? 50 / std : 1;
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = 128 + (g.data[i] - mean) * k;
  return { width: g.width, height: g.height, data };
}

export type MotionEvent =
  | { type: 'moving'; diff: number }
  | { type: 'settled'; newSpread: boolean; changeFromLast: number }
  /** The stillest moment of this pause so far: keep the current frame in case the page never settles. */
  | { type: 'candidate'; diff: number }
  /** The page was turned again before settling: capture the candidate frame (if newSpread). */
  | { type: 'brief'; newSpread: boolean; changeFromLast: number };

export class SpreadWatcher {
  private prev: GrayImage | null = null;
  private lastCaptured: GrayImage | null = null;
  private stillCount = 0;
  /** Stillest moment of the current pause, if it hasn't settled (yet). */
  private candidate: { diff: number; thumb: GrayImage } | null = null;
  state: 'moving' | 'settled' = 'moving';
  lastDiff = 0;

  constructor(private cfg: MotionConfig = DEFAULT_MOTION) {}

  /** Feed one thumbnail (same size every time). Returns an event on state changes. */
  push(raw: GrayImage): MotionEvent | null {
    const thumb = normalizeBrightness(raw);
    const prev = this.prev;
    this.prev = thumb;
    if (!prev) return null;
    const diff = meanAbsDiff(prev, thumb);
    this.lastDiff = diff;
    if (diff >= this.cfg.moveThreshold) {
      this.stillCount = 0;
      const brief = this.candidate;
      this.candidate = null;
      if (brief) {
        // Turned again before settling: the stillest moment of that pause is the best view of the spread.
        const change = this.lastCaptured ? normalizedDiff(this.lastCaptured, brief.thumb) : Infinity;
        const newSpread = change >= this.cfg.newSpreadThreshold;
        if (newSpread) this.lastCaptured = brief.thumb;
        this.state = 'moving';
        return { type: 'brief', newSpread, changeFromLast: change };
      }
      if (this.state !== 'moving') {
        this.state = 'moving';
        return { type: 'moving', diff };
      }
      return null;
    }
    if (this.state === 'moving') {
      if (diff < this.cfg.stillThreshold) this.stillCount++;
      else this.stillCount = 0;
      if (this.stillCount >= this.cfg.stillFrames) {
        this.state = 'settled';
        this.candidate = null;
        const change = this.lastCaptured ? normalizedDiff(this.lastCaptured, thumb) : Infinity;
        return { type: 'settled', newSpread: change >= this.cfg.newSpreadThreshold, changeFromLast: change };
      }
      // Only re-grab when clearly stiller than the kept frame (grabbing a 4K frame isn't free on a phone).
      if (diff <= this.cfg.briefThreshold && (!this.candidate || diff < this.candidate.diff * 0.7)) {
        this.candidate = { diff, thumb };
        return { type: 'candidate', diff };
      }
    }
    return null;
  }

  /** How different a view is from the last captured spread (Infinity if nothing was captured yet). */
  changeFrom(raw: GrayImage): number {
    return this.lastCaptured ? normalizedDiff(this.lastCaptured, normalizeBrightness(raw)) : Infinity;
  }

  /** Record the thumbnail of the spread that was just captured. */
  markCaptured(raw: GrayImage) {
    this.lastCaptured = normalizeBrightness(raw);
  }

  reset() {
    this.prev = null;
    this.lastCaptured = null;
    this.candidate = null;
    this.stillCount = 0;
    this.state = 'moving';
  }
}
