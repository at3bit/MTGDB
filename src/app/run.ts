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

/** 'auto': capture whenever the page settles after a turn. 'manual': only when snap() is called. */
export type CaptureMode = 'auto' | 'manual';

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

  constructor(
    private src: FrameSource,
    private cal: Calibration,
    private rec: Recognizer,
    private on: RunEvents,
    mode: CaptureMode = 'auto',
  ) {
    this.policy = this.newPolicy(mode);
  }

  get mode(): CaptureMode {
    return this.policy.mode;
  }

  set mode(m: CaptureMode) {
    this.policy.mode = m;
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

  private newPolicy(mode: CaptureMode) {
    const policy = new CapturePolicy(this.cal.pages.length, { ...DEFAULT_CAPTURE, live: this.src.kind === 'camera' });
    policy.mode = mode;
    return policy;
  }

  /** Where to look: the outline's bounds for page turns, pocket centres for focus. */
  private layout() {
    this.bounds = calibrationBounds(this.cal);
    this.patches = focusPatches(this.cal, this.src.video.videoWidth, this.src.video.videoHeight);
  }

  /** One sample of the video: page-turn detection, focus, and captures. */
  private sample() {
    const video = this.src.video;
    const thumb = this.reader.thumb(video, this.bounds);
    const focus = this.reader.focus(video, this.patches, this.cal.pages.length);
    const step = this.policy.sample(thumb, focus, this.src.time());
    for (const slot of step.keep) this.reader.keep(video, slot);
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
