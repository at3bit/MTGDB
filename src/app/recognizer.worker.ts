/// <reference lib="webworker" />
// Runs recognition off the UI thread so the camera preview stays smooth.
import type { MatchIndex } from '../core/recognize.ts';
import { isJunkReading, recognizeTrackedSpread } from '../core/scan.ts';
import type { Calibration } from '../core/geometry.ts';
import type { RGBAImage } from '../core/image.ts';
import type { WorkerRequest, WorkerResponse, WirePocket } from './protocol.ts';

let index: MatchIndex | null = null;
/** Where the pages were on the last spread of the current run. */
let tracking: { runId: number; calibration: Calibration } | null = null;

const post = (msg: WorkerResponse, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

/**
 * Review photos as JPEG files, encoded here off the main thread: about 30 KB each instead of
 * 460 KB of pixels (or a long data-URL string) per pocket on the phone. Null where unsupported.
 */
async function jpeg(img: { width: number; height: number; data: Uint8ClampedArray }): Promise<Blob | null> {
  if (typeof OffscreenCanvas === 'undefined') return null;
  try {
    const c = new OffscreenCanvas(img.width, img.height);
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    return await c.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
  } catch {
    return null;
  }
}

// One message at a time, so spreads come back in the order they were sent (photo encoding is async).
let queue: Promise<void> = Promise.resolve();
self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  queue = queue.then(() => handle(ev));
};

async function handle(ev: MessageEvent<WorkerRequest>) {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      index = { fps: msg.fps, count: msg.count, nameOf: msg.nameOf, back: msg.back };
      post({ type: 'ready' });
      return;
    }
    if (msg.type === 'spread') {
      if (!index) throw new Error('recognizer not initialised');
      const t0 = performance.now();
      const frames: RGBAImage[] = msg.frames.map((f) => ({ width: f.width, height: f.height, data: new Uint8ClampedArray(f.buffer) }));
      const prev = tracking?.runId === msg.runId ? tracking.calibration : undefined;
      const tracked = recognizeTrackedSpread(frames, msg.calibration, prev, index);
      if (msg.tentative && isJunkReading(tracked.pockets)) {
        // Caught the page mid-turn: keep tracking from the last good spread.
        post({ type: 'spread', job: msg.job, pockets: [], ms: performance.now() - t0, calibration: tracked.calibration, retried: [], discarded: true });
        return;
      }
      tracking = { runId: msg.runId, calibration: tracked.calibration };
      const results = tracked.pockets;
      const thumbs = await Promise.all(results.map((r) => jpeg(r.thumb)));
      const transfer: Transferable[] = [];
      const pockets: WirePocket[] = results.map((r, i) => {
        const thumbJpeg = thumbs[i] ?? undefined;
        if (!thumbJpeg) transfer.push(r.thumb.data.buffer);
        if (r.nameCrop) transfer.push(r.nameCrop.data.buffer);
        if (r.symbolCrop) transfer.push(r.symbolCrop.data.buffer);
        return {
          page: r.page,
          slot: r.slot,
          status: r.status,
          matches: r.matches,
          otherNameDistance: Number.isFinite(r.otherNameDistance) ? r.otherNameDistance : 999,
          sharpness: r.sharpness,
          glare: r.glare,
          thumb: thumbJpeg ? undefined : { width: r.thumb.width, height: r.thumb.height, buffer: r.thumb.data.buffer as ArrayBuffer },
          thumbJpeg,
          nameCrop: r.nameCrop ? { width: r.nameCrop.width, height: r.nameCrop.height, buffer: r.nameCrop.data.buffer as ArrayBuffer } : undefined,
          query: r.query ? Array.from(r.query) : undefined,
          borderLuma: r.borderLuma,
          cardBack: r.cardBack,
          blurry: r.blurry,
          contrast: r.contrast,
          symbolCrop: r.symbolCrop ? { width: r.symbolCrop.width, height: r.symbolCrop.height, buffer: r.symbolCrop.data.buffer as ArrayBuffer } : undefined,
        };
      });
      post({ type: 'spread', job: msg.job, pockets, ms: performance.now() - t0, calibration: tracked.calibration, retried: tracked.retried }, transfer);
    }
  } catch (e) {
    post({ type: 'error', job: 'job' in msg ? msg.job : undefined, message: (e as Error).message });
  }
}
