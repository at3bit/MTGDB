// When to capture a spread, and which frame to use. Shared by the app's run
// controller and the binder simulator, so the simulator measures the real rules.
//
// Per sample the caller passes the page-turn thumbnail and the focus score of
// each page (see core/focus.ts). While the view is still, the sharpest frame
// for each page so far is kept (the caller copies the frame into that page's
// slot). A spread is sent:
//   - uploaded video: when the next page turn starts, so the whole pause is
//     searched for the sharpest frame (time doesn't matter there);
//   - live camera: once focus stops improving (or after maxHoldS), because
//     the user waits for the click before turning the page;
//   - a pause too short to settle ('brief'): when the next turn starts, using
//     the sharpest frame of that pause (tentative: dropped if it reads as junk);
//   - Snap: after a few more samples, the sharpest of this pause and those.
import type { GrayImage } from './image.ts';
import { DEFAULT_MOTION, SpreadWatcher, type MotionConfig, type MotionEvent } from './motion.ts';

export interface CaptureConfig {
  /** Live camera (send once focus settles) rather than an uploaded video (send when the pause ends). */
  live: boolean;
  /** Live: after the page settles, wait at least this long for autofocus before sending… */
  minHoldS: number;
  /** …and no longer than this. */
  maxHoldS: number;
  /** Focus counts as still improving while a sample beats the best so far by this fraction… */
  plateauGain: number;
  /** …and as settled after this many samples without such a gain. */
  plateauSamples: number;
  /** A Snap keeps the sharpest frame of this many samples (from the tap). */
  snapSamples: number;
}

export const DEFAULT_CAPTURE: CaptureConfig = {
  live: false,
  minHoldS: 0.25,
  maxHoldS: 1.5,
  plateauGain: 0.03,
  plateauSamples: 4,
  snapSamples: 4,
};

export interface CaptureSend {
  /** Slots holding the frames to send (distinct frames only; one per page at most). */
  slots: number[];
  /** Video time of the (first) frame sent. */
  time: number;
  /** How different the view is from the previous capture (Infinity for the first). */
  change: number;
  manual: boolean;
  /** From a pause too short to settle: may have caught the page mid-turn. */
  brief: boolean;
  /** Focus score of each page in the frames sent. */
  focus: number[];
}

export interface CaptureStep {
  /** Copy the current frame into these slots (do this before sending). */
  keep: number[];
  send: CaptureSend | null;
  event: MotionEvent | null;
}

interface Hold {
  /** Best focus per page so far, the sample it came from, and that sample's time. */
  best: number[];
  sample: number[];
  time: number[];
  /** Last sample that improved some page's focus noticeably. */
  lastGain: number;
  /** Waiting to be sent. */
  armed: boolean;
  /** Already sent: keep nothing more from this pause. */
  spent: boolean;
  settledAt: number;
  change: number;
  manual: boolean;
  /** Last sample of a Snap. */
  deadline: number;
}

export class CapturePolicy {
  readonly watcher: SpreadWatcher;
  mode: 'auto' | 'manual' = 'auto';
  private hold: Hold | null = null;
  private n = 0;
  private snapRequested = false;

  constructor(
    private pages: number,
    private cfg: CaptureConfig = DEFAULT_CAPTURE,
    private motion: MotionConfig = DEFAULT_MOTION,
  ) {
    this.watcher = new SpreadWatcher(motion);
  }

  /** Capture the current view now (from the next sample on). */
  snap() {
    this.snapRequested = true;
  }

  /** 'moving' while the page turns, 'settled' while it's held still. */
  get state() {
    return this.watcher.state;
  }

  sample(thumb: GrayImage, focus: number[], time: number): CaptureStep {
    const n = ++this.n;
    const event = this.watcher.push(thumb);
    const diff = this.watcher.lastDiff;
    const out: CaptureStep = { keep: [], send: null, event };

    if (this.snapRequested) {
      this.snapRequested = false;
      const h = (this.hold ??= this.newHold());
      h.change = this.watcher.changeFrom(thumb);
      this.watcher.markCaptured(thumb);
      Object.assign(h, { armed: true, spent: false, manual: true, settledAt: time, deadline: n + this.cfg.snapSamples - 1 });
    }

    let h = this.hold;
    const moving = event?.type === 'moving' || event?.type === 'brief' || diff >= this.motion.moveThreshold;
    if (h && moving && !h.manual) {
      // The page is turning again: this pause is over.
      if (h.armed) out.send = this.finish(h, false, h.change);
      else if (event?.type === 'brief' && event.newSpread && this.mode === 'auto' && h.sample.some((s) => s >= 0)) out.send = this.finish(h, true, event.changeFromLast);
      this.hold = h = null;
    }

    const stillish = !moving && (diff <= this.motion.briefThreshold || this.watcher.state === 'settled');
    if ((stillish || h?.manual) && !(h?.spent)) {
      h = this.hold ??= this.newHold();
      for (let p = 0; p < this.pages; p++) {
        const f = focus[p] ?? 0;
        if (h.sample[p] >= 0 && f <= h.best[p]) continue;
        if (h.sample[p] < 0 || f > h.best[p] * (1 + this.cfg.plateauGain)) h.lastGain = n;
        h.best[p] = f;
        h.sample[p] = n;
        h.time[p] = time;
        out.keep.push(p);
      }
    }

    if (event?.type === 'settled' && event.newSpread && this.mode === 'auto' && h && !h.armed && !h.spent) {
      Object.assign(h, { armed: true, settledAt: time, change: event.changeFromLast });
      this.watcher.markCaptured(thumb);
    }

    if (h?.armed && !out.send) {
      const held = time - h.settledAt;
      const due = h.manual
        ? n >= h.deadline
        : this.cfg.live && (held >= this.cfg.maxHoldS || (held >= this.cfg.minHoldS && n - h.lastGain >= this.cfg.plateauSamples));
      if (due) out.send = this.finish(h, false, h.change);
    }
    return out;
  }

  /** Sends a spread that's waiting (on pause, stop, or the end of the video). */
  flush(): CaptureSend | null {
    const h = this.hold;
    this.hold = null;
    return h?.armed ? this.finish(h, false, h.change) : null;
  }

  /** Start over (the outline was re-lined-up). */
  reset() {
    this.watcher.reset();
    this.hold = null;
    this.snapRequested = false;
  }

  private newHold(): Hold {
    return {
      best: new Array(this.pages).fill(0),
      sample: new Array(this.pages).fill(-1),
      time: new Array(this.pages).fill(0),
      lastGain: this.n,
      armed: false,
      spent: false,
      settledAt: 0,
      change: Infinity,
      manual: false,
      deadline: 0,
    };
  }

  private finish(h: Hold, brief: boolean, change: number): CaptureSend {
    const slots: number[] = [];
    const seen = new Set<number>();
    for (let p = 0; p < this.pages; p++) {
      if (h.sample[p] < 0 || seen.has(h.sample[p])) continue;
      seen.add(h.sample[p]);
      slots.push(p);
    }
    const send: CaptureSend = { slots, time: h.time[slots[0] ?? 0], change, manual: h.manual, brief, focus: [...h.best] };
    h.armed = false;
    h.manual = false;
    h.spent = true;
    return send;
  }
}
