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

export async function openCamera(video: HTMLVideoElement, sampleFps = 10): Promise<FrameSource> {
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
  return {
    kind: 'camera',
    video,
    get width() { return video.videoWidth; },
    get height() { return video.videoHeight; },
    async next() {
      if (stopped) return false;
      await new Promise((r) => setTimeout(r, 1000 / sampleFps));
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

export async function openVideoFile(video: HTMLVideoElement, file: Blob, sampleFps = 10): Promise<FrameSource> {
  const url = URL.createObjectURL(file);
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  await waitEvent(video, 'loadedmetadata', 30_000);
  // iOS Safari won't paint a video's frames to a canvas until it has played once.
  try {
    await video.play();
    video.pause();
  } catch {
    /* autoplay of muted video is allowed; ignore if not */
  }
  const duration = video.duration;
  let t = -1 / sampleFps;
  let stopped = false;
  const step = 1 / sampleFps;
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
