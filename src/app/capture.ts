// Frame sources: the live camera, or a video recorded with the iPhone Camera
// app and uploaded. Both are read through an HTMLVideoElement.
import type { GrayImage } from '../core/image.ts';
import type { WireImage } from './protocol.ts';

export interface FrameSource {
  readonly kind: 'camera' | 'file';
  readonly video: HTMLVideoElement;
  readonly width: number;
  readonly height: number;
  /** Advance to the next sample. Resolves false when the source has ended. */
  next(): Promise<boolean>;
  /** 0..1 for files; NaN for the camera. */
  progress(): number;
  /** Current position in seconds (files) or elapsed time (camera). */
  time(): number;
  stop(): void;
}

function waitEvent(el: EventTarget, name: string, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      el.removeEventListener(name, on);
      reject(new Error(`timed out waiting for ${name}`));
    }, timeoutMs);
    const on = () => {
      clearTimeout(t);
      el.removeEventListener(name, on);
      resolve();
    };
    el.addEventListener(name, on);
  });
}

export async function openCamera(video: HTMLVideoElement, sampleFps = 15): Promise<FrameSource> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser does not allow camera access here. Open the app over https in Safari.');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      // Ask for 4K; the browser picks the closest it supports.
      width: { ideal: 3840 },
      height: { ideal: 2160 },
      frameRate: { ideal: 30 },
    },
  });
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();
  if (!video.videoWidth) await waitEvent(video, 'loadedmetadata');
  const started = performance.now();
  let stopped = false;
  // Only sample frames the camera has actually delivered: in dim light it can run slower than we
  // sample, and reading the same frame twice mid-turn would look like a (very short) pause.
  let presented = 0, sampled = -1;
  const rvfc = (video as any).requestVideoFrameCallback?.bind(video) as ((cb: (now: number, meta: { presentedFrames: number }) => void) => number) | undefined;
  if (rvfc) {
    const onFrame = (_now: number, meta: { presentedFrames: number }) => {
      presented = meta.presentedFrames;
      if (!stopped) rvfc(onFrame);
    };
    rvfc(onFrame);
  }
  return {
    kind: 'camera',
    video,
    get width() { return video.videoWidth; },
    get height() { return video.videoHeight; },
    async next() {
      if (stopped) return false;
      await new Promise((r) => setTimeout(r, 1000 / sampleFps));
      if (rvfc && presented > 0) {
        const deadline = performance.now() + 250;
        while (presented === sampled && !stopped && performance.now() < deadline) await new Promise((r) => setTimeout(r, 8));
        sampled = presented;
      }
      return !stopped;
    },
    progress: () => NaN,
    time: () => (performance.now() - started) / 1000,
    stop() {
      stopped = true;
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
  };
}

export async function openVideoFile(video: HTMLVideoElement, file: Blob, sampleFps = 15, onStep?: (step: string) => void): Promise<FrameSource> {
  const url = URL.createObjectURL(file);
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  onStep?.('Reading the video…');
  video.src = url;
  if (video.readyState < 1) {
    await waitEvent(video, 'loadedmetadata', 30_000).catch(() => {
      throw new Error('This video couldn’t be opened (no response after 30 s). Try recording it again with the Camera app, or a shorter clip.');
    });
  }
  // iOS Safari won't paint a video's frames to a canvas until it has played once. But with some files
  // play() never settles, so don't wait for it for more than a moment; pause() also settles it.
  onStep?.('Preparing frames…');
  try {
    await Promise.race([video.play(), new Promise((r) => setTimeout(r, 1500))]);
  } catch {
    /* autoplay refused: frames are usually still readable */
  }
  video.pause();
  if (!video.videoWidth) await waitEvent(video, 'loadeddata', 10_000).catch(() => {});
  const duration = video.duration;
  if (!video.videoWidth || !Number.isFinite(duration) || duration <= 0) {
    throw new Error('Couldn’t read this video’s size or length. Try recording it again with the Camera app.');
  }
  const step = 1 / sampleFps;
  // Sample a little after frame boundaries (5 ms is inside a frame at 24-60 fps), so a seek never
  // rounds onto the frame it read last time: a repeated frame mid-turn would look like a pause.
  let t = 0.005 - step;
  let stopped = false;
  return {
    kind: 'file',
    video,
    get width() { return video.videoWidth; },
    get height() { return video.videoHeight; },
    async next() {
      if (stopped) return false;
      t += step;
      if (t >= duration - 0.01) return false;
      const seeked = waitEvent(video, 'seeked', 15_000);
      video.currentTime = t;
      await seeked;
      return !stopped;
    },
    progress: () => Math.min(1, Math.max(0, t / duration)),
    time: () => Math.max(0, t),
    stop() {
      stopped = true;
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    },
  };
}

/** Reusable canvases for reading pixels out of the video element. */
export class FrameReader {
  private thumbCanvas = document.createElement('canvas');
  private fullCanvas = document.createElement('canvas');

  /** Gray thumbnail of a normalised region of the current frame (used for page-turn detection). */
  thumb(video: HTMLVideoElement, region: { x0: number; y0: number; x1: number; y1: number }, w = 96, h = 54): GrayImage {
    const c = this.thumbCanvas;
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    const vw = video.videoWidth, vh = video.videoHeight;
    ctx.drawImage(video, region.x0 * vw, region.y0 * vh, (region.x1 - region.x0) * vw, (region.y1 - region.y0) * vh, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const g = new Float32Array(w * h);
    for (let i = 0; i < g.length; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    return { width: w, height: h, data: g };
  }

  /** Full-resolution copy of the current frame. */
  full(video: HTMLVideoElement): WireImage {
    const c = this.fullCanvas;
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(video, 0, 0);
    const img = ctx.getImageData(0, 0, c.width, c.height);
    return { width: c.width, height: c.height, buffer: img.data.buffer as ArrayBuffer };
  }
}

/** RGBA buffer -> JPEG data URL (for thumbnails in the review screen). */
export function imageToDataURL(img: WireImage, quality = 0.85): string {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.buffer), img.width, img.height), 0, 0);
  return c.toDataURL('image/jpeg', quality);
}

/** Keeps the screen awake during a run (Safari 16.4+). */
export async function keepAwake(): Promise<() => void> {
  try {
    const lock = await (navigator as any).wakeLock?.request('screen');
    return () => lock?.release?.();
  } catch {
    return () => {};
  }
}
