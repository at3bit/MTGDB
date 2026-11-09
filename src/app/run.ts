// Drives a "run": samples the video 15 times a second, detects page turns,
// grabs full-resolution frames of each settled spread (or, if the page is
// turned again before it settles, of the stillest moment of that pause) and
// hands them to the recognizer worker. The run can be paused (to re-line-up the outline as the
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
  /** Why the run stopped before the end, if it did (the video stopped responding, frames couldn't be read). */
  endedEarly: Error | null = null;

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

  /** A capture waiting to be sent to the recognizer (a second frame may still be added). `brief`: from a pause too short to settle. */
  private pending: { frames: WireImage[]; time: number; change: number; manual: boolean; brief?: boolean } | null = null;
  /** Set while the reader keeps the stillest frame of a pause, in case the page is turned again before it settles. */
  private candidate: { time: number } | null = null;
  private jobs: Promise<void>[] = [];

  async run(): Promise<void> {
    this.running = true;
    let bounds = calibrationBounds(this.cal);
    let failures = 0;
    const endEarly = (e: unknown) => {
      this.endedEarly = e instanceof Error ? e : new Error(String(e));
      this.on.error(this.endedEarly);
    };

    while (this.running) {
      if (this.paused) {
        this.dispatch();
        this.dropCandidate();
        this.status('paused');
        await new Promise<void>((resolve) => (this.wake = resolve));
        this.wake = null;
        bounds = calibrationBounds(this.cal);
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
        this.sample(bounds);
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
    this.dispatch();
    this.dropCandidate();
    this.status('finishing');
    await Promise.all(this.jobs);
    this.status('done');
  }

  /** One sample of the video: page-turn detection and captures. */
  private sample(bounds: ReturnType<typeof calibrationBounds>) {
    const video = this.src.video;
    const thumb = this.reader.thumb(video, bounds);
    const ev = this.watcher.push(thumb);
    if (this.pending) {
      // A second frame of the same settled view lets the recognizer pick the sharper crop per pocket.
      if (this.watcher.state === 'settled' && !ev) this.pending.frames.push(this.reader.full(video));
      this.dispatch();
    }
    const auto = this.mode === 'auto';
    if (this.snapRequested) {
      this.snapRequested = false;
      const change = this.watcher.changeFrom(thumb);
      this.watcher.markCaptured(thumb);
      this.pending = { frames: [this.reader.full(video)], time: this.src.time(), change, manual: true };
      this.on.captured?.('manual');
      this.dispatch();
    } else if (auto && ev?.type === 'settled' && ev.newSpread) {
      this.dropCandidate();
      this.watcher.markCaptured(thumb);
      this.pending = { frames: [this.reader.full(video)], time: this.src.time(), change: ev.changeFromLast, manual: false };
      this.on.captured?.('auto');
      // If the recognizer is behind, one frame is enough.
      if (this.rec.inFlight >= 2) this.dispatch();
    } else if (auto && ev?.type === 'candidate') {
      this.reader.keep(video);
      this.candidate = { time: this.src.time() };
    } else if (ev?.type === 'brief') {
      // A quick turn: the page never settled, so use the stillest moment of the pause.
      const kept = this.candidate;
      const frame = auto && ev.newSpread && kept ? this.reader.kept() : null;
      if (frame && kept) {
        this.dispatch();
        this.pending = { frames: [frame], time: kept.time, change: ev.changeFromLast, manual: false, brief: true };
        this.dispatch();
      }
      this.dropCandidate();
    }
    if (ev?.type === 'settled') this.dropCandidate();
    this.status(this.watcher.state === 'moving' ? 'moving' : ev?.type === 'settled' ? 'settled' : 'watching');
  }

  private dropCandidate() {
    this.candidate = null;
    this.reader.dropKept();
  }

  private dispatch() {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    this.captured++;
    this.jobs.push(
      this.rec
        .recognize(p.frames, this.cal, this.runId, p.brief)
        .then((r) => {
          if (r.discarded) {
            this.captured--;
            return;
          }
          // A quick-pause capture only clicks once it's known to show a page.
          if (p.brief) this.on.captured?.('auto');
          this.on.spread({ ...r, time: p.time, change: p.change, manual: p.manual });
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
      motion: this.watcher.lastDiff,
      progress: this.src.progress(),
      captured: this.captured,
      processing: this.rec.inFlight + (this.pending ? 1 : 0),
    });
  }
}
