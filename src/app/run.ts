// Drives a "run": samples the video 15 times a second, detects page turns,
// keeps the sharpest frame of each pause (see core/capture.ts) and hands it to
// the recognizer worker. The run can be paused (to re-line-up the outline as
// the page stacks shift), and pages can be captured on demand with snap().
import { CapturePolicy, DEFAULT_CAPTURE, type CaptureSend } from '../core/capture.ts';
import { focusPatches, type FocusPatch } from '../core/focus.ts';
import { calibrationBounds, type Calibration } from '../core/geometry.ts';
import { FrameReader, type FrameSource } from './capture.ts';
import type { Recognizer, SpreadReading } from './data.ts';
import type { WireImage } from './protocol.ts';

/**
 * 'auto': capture whenever the page settles after a turn. 'manual': only when snap() is called.
 * 'timed': the scan screen calls snap() on a countdown (every few seconds), so the user turns the page after each shot.
 */
export type CaptureMode = 'auto' | 'manual' | 'timed';

export interface RunStatus {
  phase: 'watching' | 'moving' | 'settled' | 'paused' | 'finishing' | 'done';
  /** Latest frame-to-frame change (0..255); useful for tuning. */
  motion: number;
  /** 0..1 for uploaded videos. */
  progress: number;
  captured: number;
  processing: number;
}

/** A spread on its way to the recognizer. */
export interface SentFrames {
  /** Canvases holding the frames (read them synchronously; they're reused). */
  canvases: HTMLCanvasElement[];
  time: number;
  /** Focus score per page of the frames sent. */
  focus: number[];
  manual: boolean;
  brief: boolean;
}

export interface RunEvents {
  status(s: RunStatus): void;
  /** A spread was captured (before it's read): for a click sound / flash. */
  captured?(how: 'auto' | 'manual'): void;
  /** The frames of a capture, just before they're sent to be read (for diagnostics). */
  sent?(f: SentFrames): void;
  /** Photos: the run is waiting for the outline to be lined up on photo `index` (resume() to use it, skip() to leave it out). */
  lineUp?(index: number, count: number, reason: 'each' | 'shape'): void;
  spread(r: SpreadReading & { time: number; change: number; manual: boolean }): void;
  error(e: Error): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class RunController {
  private reader = new FrameReader();
  private policy: CapturePolicy;
  private running = false;
  private captured = 0;
  private paused = false;
  private wake: (() => void) | null = null;
  /** Changes when the outline is re-lined-up, so page tracking restarts from it. */
  private runId = Date.now();
  /** Why the run stopped before the end, if it did (the video stopped responding, frames couldn't be read). */
  endedEarly: Error | null = null;
  private jobs: Promise<void>[] = [];
  private bounds = { x0: 0, y0: 0, x1: 1, y1: 1 };
  private patches: FocusPatch[] = [];
  /** Photos: wait for the user to line up the outline on every photo, not just the first. */
  lineUpEach = false;
  private skipping = false;
  private mode_: CaptureMode;

  constructor(
    private src: FrameSource,
    private cal: Calibration,
    private rec: Recognizer,
    private on: RunEvents,
    mode: CaptureMode = 'auto',
  ) {
    this.mode_ = mode;
    this.policy = this.newPolicy(mode);
  }

  get mode(): CaptureMode {
    return this.mode_;
  }

  set mode(m: CaptureMode) {
    this.mode_ = m;
    this.policy.mode = m === 'auto' ? 'auto' : 'manual';
  }

  stop() {
    this.running = false;
    this.wake?.();
  }

  /** Stops sampling (an uploaded video stays on its current frame) until resume(). */
  pause() {
    this.paused = true;
  }

  /** Continues; with a new outline, page tracking starts again from it. */
  resume(calibration?: Calibration) {
    if (calibration) {
      this.cal = calibration;
      this.runId = Date.now();
      this.policy = this.newPolicy(this.policy.mode);
    }
    this.paused = false;
    this.wake?.();
  }

  /** Photos: leave out the photo waiting to be lined up. */
  skip() {
    this.skipping = true;
    this.resume();
  }

  /** Capture the current view as a page now (the sharpest of the next few samples). */
  snap() {
    this.policy.snap();
    this.on.captured?.('manual');
  }

  get isPaused() {
    return this.paused;
  }

  async run(): Promise<void> {
    this.running = true;
    if (this.src.kind === 'photos') return this.runPhotos();
    this.layout();
    let failures = 0;
    const endEarly = (e: unknown) => {
      this.endedEarly = e instanceof Error ? e : new Error(String(e));
      this.on.error(this.endedEarly);
    };

    while (this.running) {
      if (this.paused) {
        this.send(this.policy.flush());
        this.status('paused');
        await new Promise<void>((resolve) => (this.wake = resolve));
        this.wake = null;
        this.layout();
        continue;
      }
      let more: boolean;
      try {
        more = await this.src.next();
      } catch (e) {
        endEarly(e);
        break;
      }
      if (!more) break;
      try {
        this.sample();
        failures = 0;
      } catch (e) {
        // A frame that can't be read is skipped; if it keeps happening, stop and keep what was captured.
        console.warn('frame skipped', e);
        if (++failures >= 5) {
          endEarly(e);
          break;
        }
      }
      // Uploaded videos can wait for the recognizer (a live camera can't); pausing or stopping doesn't wait.
      if (this.src.kind === 'file') while (this.running && !this.paused && this.rec.inFlight >= 2) await sleep(50);
    }
    try {
      this.send(this.policy.flush());
    } catch (e) {
      endEarly(e);
    }
    this.status('finishing');
    await Promise.all(this.jobs);
    this.status('done');
  }

  /** Photos: each one is a capture. The outline from the first photo is used for all, or lined up on each. */
  private async runPhotos() {
    const shape = this.src.width / this.src.height;
    const wait = async () => {
      this.status('paused');
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    };
    while (this.running) {
      try {
        if (!(await this.src.next())) break;
      } catch (e) {
        this.endedEarly = e instanceof Error ? e : new Error(String(e));
        this.on.error(this.endedEarly);
        break;
      }
      const index = this.src.index ?? 0;
      // A photo of a different shape (portrait vs landscape) needs its own outline.
      const reshaped = Math.abs(this.src.width / this.src.height - shape) > 0.02;
      if (this.paused || ((this.lineUpEach || reshaped) && index > 0)) {
        this.paused = true;
        this.on.lineUp?.(index, this.src.count ?? 1, reshaped ? 'shape' : 'each');
        await wait();
        if (!this.running) break;
      }
      if (this.skipping) {
        this.skipping = false;
        continue;
      }
      try {
        this.layout();
        this.reader.keep(this.src, 0);
        this.send({ slots: [0], time: index, change: Infinity, manual: true, brief: false, focus: [] });
        this.status('settled');
      } catch (e) {
        this.on.error(e instanceof Error ? e : new Error(String(e)));
      }
      while (this.running && this.rec.inFlight >= 2) await sleep(50);
    }
    this.status('finishing');
    await Promise.all(this.jobs);
    this.status('done');
  }

  private newPolicy(mode: CaptureMode) {
    const policy = new CapturePolicy(this.cal.pages.length, { ...DEFAULT_CAPTURE, live: this.src.kind === 'camera' });
    policy.mode = mode === 'auto' ? 'auto' : 'manual';
    return policy;
  }

  /** Where to look: the outline's bounds for page turns, pocket centres for focus. */
  private layout() {
    this.bounds = calibrationBounds(this.cal);
    this.patches = focusPatches(this.cal, this.src.width, this.src.height);
  }

  /** One sample of the video: page-turn detection, focus, and captures. */
  private sample() {
    const thumb = this.reader.thumb(this.src, this.bounds);
    const focus = this.reader.focus(this.src, this.patches, this.cal.pages.length);
    const step = this.policy.sample(thumb, focus, this.src.time());
    for (const slot of step.keep) this.reader.keep(this.src, slot);
    this.send(step.send);
    this.status(this.policy.state === 'moving' ? 'moving' : step.send ? 'settled' : 'watching');
  }

  private send(s: CaptureSend | null) {
    if (!s || !s.slots.length) return;
    this.on.sent?.({ canvases: s.slots.map((slot) => this.reader.slotCanvas(slot)!), time: s.time, focus: s.focus, manual: s.manual, brief: s.brief });
    const frames = this.reader.read(s.slots);
    // A Snap clicked when tapped; a quick-pause capture clicks once it's known to show a page.
    if (!s.manual && !s.brief) this.on.captured?.('auto');
    this.dispatch(frames, s);
  }

  private dispatch(frames: WireImage[], s: CaptureSend) {
    this.captured++;
    this.jobs.push(
      this.rec
        .recognize(frames, this.cal, this.runId, s.brief)
        .then((r) => {
          if (r.discarded) {
            this.captured--;
            return;
          }
          if (s.brief) this.on.captured?.('auto');
          this.on.spread({ ...r, time: s.time, change: s.change, manual: s.manual });
        })
        .catch((e) => {
          this.captured--;
          this.on.error(e);
        }),
    );
  }

  private status(phase: RunStatus['phase']) {
    this.on.status({
      phase,
      motion: this.policy.watcher.lastDiff,
      progress: this.src.progress(),
      captured: this.captured,
      processing: this.rec.inFlight,
    });
  }
}
