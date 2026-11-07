/// <reference lib="webworker" />
// Runs recognition off the UI thread so the camera preview stays smooth.
import { recognizeSpread, type MatchIndex } from '../core/recognize.ts';
import type { Calibration } from '../core/geometry.ts';
import type { RGBAImage } from '../core/image.ts';
import type { WorkerRequest, WorkerResponse, WirePocket } from './protocol.ts';

let index: MatchIndex | null = null;

const post = (msg: WorkerResponse, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      index = { fps: msg.fps, count: msg.count, nameOf: msg.nameOf };
      post({ type: 'ready' });
      return;
    }
    if (msg.type === 'spread') {
      if (!index) throw new Error('recognizer not initialised');
      const t0 = performance.now();
      const frames: RGBAImage[] = msg.frames.map((f) => ({ width: f.width, height: f.height, data: new Uint8ClampedArray(f.buffer) }));
      const cal: Calibration = msg.calibration;
      const results = recognizeSpread(frames, cal, index);
      const transfer: Transferable[] = [];
      const pockets: WirePocket[] = results.map((r) => {
        transfer.push(r.thumb.data.buffer);
        if (r.nameCrop) transfer.push(r.nameCrop.data.buffer);
        return {
          page: r.page,
          slot: r.slot,
          status: r.status,
          matches: r.matches,
          otherNameDistance: Number.isFinite(r.otherNameDistance) ? r.otherNameDistance : 999,
          sharpness: r.sharpness,
          glare: r.glare,
          thumb: { width: r.thumb.width, height: r.thumb.height, buffer: r.thumb.data.buffer as ArrayBuffer },
          nameCrop: r.nameCrop ? { width: r.nameCrop.width, height: r.nameCrop.height, buffer: r.nameCrop.data.buffer as ArrayBuffer } : undefined,
          query: r.query ? Array.from(r.query) : undefined,
          borderLuma: r.borderLuma,
        };
      });
      post({ type: 'spread', job: msg.job, pockets, ms: performance.now() - t0 }, transfer);
    }
  } catch (e) {
    post({ type: 'error', job: 'job' in msg ? msg.job : undefined, message: (e as Error).message });
  }
};
