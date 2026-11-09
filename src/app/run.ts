// Drives a "run": samples the video 10 times a second, detects page turns,
// grabs full-resolution frames of each settled spread and hands them to the
// recognizer worker. The run can be paused (to re-line-up the outline as the
// page stacks shift), and pages can be captured on demand with snap().
import { SpreadWatcher } from '../core/motion.ts';
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

export interface RunEvents {
  status(s: RunStatus): void;
  /** A spread was captured (before it's read): for a click sound / flash. */
  captured?(how: 'auto' | 'manual'): void;
  spread(r: SpreadReading & { time: number; change: number; manual: boolean }): void;
  error(e: Error): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class RunController {
  private watcher = new SpreadWatcher();
  private reader = new FrameReader();
  private running = false;
  private captured = 0;
  private paused = false;
  private wake: (() => void) | null = null;
  private snapRequested = false;
  /** Changes when the outline is re-lined-up, so page tracking restarts from it. */
  private runId = Date.now();

  constructor(
    private src: FrameSource,
    private cal: Calibration,
    private rec: Recognizer,
    private on: RunEvents,
    public mode: CaptureMode = 'auto',
  ) {}

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
      this.watcher.reset();
    }
    this.paused = false;
    this.wake?.();
  }

  /** Capture the current view as a page now. */
  snap() {
    this.snapRequested = true;
  }

  get isPaused() {
    return this.paused;
  }

  async run(): Promise<void> {
    this.running = true;
    let bounds = calibrationBounds(this.cal);
    const jobs: Promise<void>[] = [];
    let pending: { frames: WireImage[]; time: number; change: number; manual: boolean } | null = null;

    const dispatch = () => {
      if (!pending) return;
      const p = pending;
      pending = null;
      this.captured++;
      jobs.push(
        this.rec
          .recognize(p.frames, this.cal, this.runId)
          .then((r) => this.on.spread({ ...r, time: p.time, change: p.change, manual: p.manual }))
          .catch((e) => this.on.error(e)),
      );
    };
    const status = (phase: RunStatus['phase']) =>
      this.on.status({
        phase,
        motion: this.watcher.lastDiff,
        progress: this.src.progress(),
        captured: this.captured,
        processing: this.rec.inFlight + (pending ? 1 : 0),
      });

    while (this.running) {
      if (this.paused) {
        dispatch();
        status('paused');
        await new Promise<void>((resolve) => (this.wake = resolve));
        this.wake = null;
        bounds = calibrationBounds(this.cal);
        continue;
      }
      if (!(await this.src.next())) break;
      const thumb = this.reader.thumb(this.src.video, bounds);
      const ev = this.watcher.push(thumb);
      if (pending) {
        // A second frame of the same settled view lets the recognizer pick the sharper crop per pocket.
        if (this.watcher.state === 'settled' && !ev) pending.frames.push(this.reader.full(this.src.video));
        dispatch();
      }
      if (this.snapRequested) {
        this.snapRequested = false;
        const change = this.watcher.changeFrom(thumb);
        this.watcher.markCaptured(thumb);
        pending = { frames: [this.reader.full(this.src.video)], time: this.src.time(), change, manual: true };
        this.on.captured?.('manual');
        dispatch();
      } else if (this.mode === 'auto' && ev?.type === 'settled' && ev.newSpread) {
        this.watcher.markCaptured(thumb);
        pending = { frames: [this.reader.full(this.src.video)], time: this.src.time(), change: ev.changeFromLast, manual: false };
        this.on.captured?.('auto');
        // If the recognizer is behind, one frame is enough.
        if (this.rec.inFlight >= 2) dispatch();
      }
      status(this.watcher.state === 'moving' ? 'moving' : ev?.type === 'settled' ? 'settled' : 'watching');
      // Uploaded videos can wait for the recognizer; a live camera can't.
      if (this.src.kind === 'file') while (this.rec.inFlight >= 2) await sleep(50);
    }
    dispatch();
    status('finishing');
    await Promise.all(jobs);
    status('done');
  }
}
