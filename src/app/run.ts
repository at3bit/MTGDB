// Drives a "run": samples the video a few times a second, detects page turns,
// grabs full-resolution frames of each settled spread and hands them to the
// recognizer worker.
import { SpreadWatcher } from '../core/motion.ts';
import { calibrationBounds, type Calibration } from '../core/geometry.ts';
import { FrameReader, type FrameSource } from './capture.ts';
import type { Recognizer } from './data.ts';
import type { WireImage, WirePocket } from './protocol.ts';

export interface RunStatus {
  phase: 'watching' | 'moving' | 'settled' | 'finishing' | 'done';
  /** Latest frame-to-frame change (0..255); useful for tuning. */
  motion: number;
  /** 0..1 for uploaded videos. */
  progress: number;
  captured: number;
  processing: number;
}

export interface RunEvents {
  status(s: RunStatus): void;
  spread(r: { pockets: WirePocket[]; ms: number; time: number }): void;
  error(e: Error): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class RunController {
  private watcher = new SpreadWatcher();
  private reader = new FrameReader();
  private running = false;
  private captured = 0;

  constructor(
    private src: FrameSource,
    private cal: Calibration,
    private rec: Recognizer,
    private on: RunEvents,
  ) {}

  stop() {
    this.running = false;
  }

  async run(): Promise<void> {
    this.running = true;
    const bounds = calibrationBounds(this.cal);
    const jobs: Promise<void>[] = [];
    let pending: { frames: WireImage[]; time: number } | null = null;

    const dispatch = () => {
      if (!pending) return;
      const p = pending;
      pending = null;
      this.captured++;
      jobs.push(
        this.rec
          .recognize(p.frames, this.cal)
          .then((r) => this.on.spread({ ...r, time: p.time }))
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

    while (this.running && (await this.src.next())) {
      const thumb = this.reader.thumb(this.src.video, bounds);
      const ev = this.watcher.push(thumb);
      if (pending) {
        // A second frame of the same settled view lets the recognizer pick the sharper crop per pocket.
        if (this.watcher.state === 'settled' && !ev) pending.frames.push(this.reader.full(this.src.video));
        dispatch();
      }
      if (ev?.type === 'settled' && ev.newSpread) {
        this.watcher.markCaptured(thumb);
        pending = { frames: [this.reader.full(this.src.video)], time: this.src.time() };
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
