// Drives a "run": samples the video 15 times a second, detects page turns,
// keeps the sharpest frame of each pause (see core/capture.ts) and hands it to
// the recognizer worker. The run can be paused (to re-line-up the outline as
// the page stacks shift), and pages can be captured on demand with snap().
import { CapturePolicy, DEFAULT_CAPTURE, type CaptureSend } from '../core/capture.ts';
import { focusPatches, type FocusPatch } from '../core/focus.ts';
import { calibrationBounds, type Calibration } from '../core/geometry.ts';
import { FrameReader, type FrameSource } from './capture.ts';
import type { Recognizer, SpreadReading } from './data.ts';
import type { Frame } from './protocol.ts';

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
  /** The original files, for photos (no need to re-encode those). */
  files?: Blob[];
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
  /**
   * Photos: the run is waiting for the outline to be lined up on photo `index` (resume() to use it, skip() to
   * leave it out): because the user paused, because every photo is lined up, or because this one is a different shape.
   */
  lineUp?(index: number, count: number, reason: 'paused' | 'each' | 'shape'): void;
  /** `photo`: which photo of a batch it came from; a photo read again (after Pause & adjust) replaces its earlier reading. */
  spread(r: SpreadReading & { time: number; change: number; manual: boolean; photo?: number }): void;
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
  /** Photos: stop on every photo to line up the outline (off: the outline from the start is used until a pause). */
  lineUpEach = false;
  /** Photos: the photo to go back to after a pause (the one on screen when Pause was tapped). */
  private rewindTo: number | null = null;
  /** Captures handed to the recognizer and not read yet. */
  private reading = 0;
  /** Captures are handed over in order (turning a frame into an ImageBitmap is async). */
  private sendChain: Promise<void> = Promise.resolve();
  private lastStatus = { at: 0, phase: '' };
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
    // Photos: go back to the one on screen when the user tapped, so it's read again with the adjusted outline.
    if (this.src.kind === 'photos' && this.rewindTo === null) this.rewindTo = this.src.index ?? null;
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
      if (this.src.kind === 'file') while (this.running && !this.paused && this.reading >= 2) await sleep(50);
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

  /**
   * Photos: each one is a capture, read one at a time with the outline set at the start. Pause stops at
   * once and goes back to the photo on screen; after the outline is adjusted that photo is read again
   * (replacing its earlier reading) and the batch carries on from there.
   */
  private async runPhotos() {
    const count = this.src.count ?? 0;
    const shape = this.src.width / this.src.height;
    const wait = async () => {
      this.status('paused');
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    };
    let next = 0;
    while (this.running) {
      if (this.paused && this.rewindTo !== null) next = Math.min(next, this.rewindTo);
      this.rewindTo = null;
      if (next >= count) break;
      try {
        await this.src.show!(next);
      } catch (e) {
        this.endedEarly = e instanceof Error ? e : new Error(String(e));
        this.on.error(this.endedEarly);
        break;
      }
      if (this.paused && this.rewindTo !== null && this.rewindTo < next) continue; // paused while it loaded
      // A photo of a different shape (portrait vs landscape) needs its own outline.
      const reshaped = Math.abs(this.src.width / this.src.height - shape) > 0.02;
      const userPaused = this.paused;
      if (userPaused || ((this.lineUpEach || reshaped) && next > 0)) {
        this.paused = true;
        this.rewindTo = null;
        this.on.lineUp?.(next, count, reshaped ? 'shape' : userPaused && !this.lineUpEach ? 'paused' : 'each');
        await wait();
        this.rewindTo = null;
        if (!this.running) break;
      }
      if (this.skipping) {
        this.skipping = false;
        next++;
        continue;
      }
      try {
        this.layout();
        this.reader.keep(this.src, 0);
        this.send({ slots: [0], time: next, change: Infinity, manual: true, brief: false, focus: [] }, this.src.file?.(next));
        this.status('settled');
      } catch (e) {
        this.on.error(e instanceof Error ? e : new Error(String(e)));
      }
      next++;
      // One photo at a time, so a pause catches the photo on screen rather than a queue of them.
      while (this.running && !this.paused && this.reading > 0) await sleep(30);
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

  private send(s: CaptureSend | null, file?: Blob) {
    if (!s || !s.slots.length) return;
    const canvases = s.slots.map((slot) => this.reader.slotCanvas(slot)!);
    this.on.sent?.({ canvases: file ? [] : canvases, files: file ? [file] : undefined, time: s.time, focus: s.focus, manual: s.manual, brief: s.brief });
    // Hand the frames over as ImageBitmaps where the worker can read them: copying a 12 MP photo's pixels out
    // of a canvas here would hold up the page (and taps on Pause) for a noticeable moment. The bitmaps are
    // snapshots taken now, so the canvases can be reused straight away.
    const frames: Promise<Frame[]> =
      this.rec.acceptsBitmaps && typeof createImageBitmap === 'function'
        ? Promise.all(canvases.map((c) => createImageBitmap(c)))
        : Promise.resolve(this.reader.read(s.slots));
    // A Snap clicked when tapped; a quick-pause capture clicks once it's known to show a page.
    if (!s.manual && !s.brief) this.on.captured?.('auto');
    this.captured++;
    this.reading++;
    const photo = this.src.kind === 'photos' ? s.time : undefined;
    const job = (this.sendChain = this.sendChain.then(async () => {
      try {
        const r = await this.rec.recognize(await frames, this.cal, this.runId, s.brief);
        if (r.discarded) {
          this.captured--;
          return;
        }
        if (s.brief) this.on.captured?.('auto');
        this.on.spread({ ...r, time: s.time, change: s.change, manual: s.manual, photo });
      } catch (e) {
        this.captured--;
        this.on.error(e instanceof Error ? e : new Error(String(e)));
      } finally {
        this.reading--;
      }
    }));
    this.jobs.push(job);
  }

  /** Progress for the screen; at most 5 times a second unless the phase changes (re-rendering costs the page time). */
  private status(phase: RunStatus['phase']) {
    const now = performance.now();
    if (phase === this.lastStatus.phase && now - this.lastStatus.at < 200) return;
    this.lastStatus = { at: now, phase };
    this.on.status({
      phase,
      motion: this.policy.watcher.lastDiff,
      progress: this.src.progress(),
      captured: this.captured,
      processing: this.reading,
    });
  }
}
