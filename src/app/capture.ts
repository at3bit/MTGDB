// Frame sources: the live camera, or a video recorded with the iPhone Camera
// app and uploaded. Both are read through an HTMLVideoElement.
import type { GrayImage } from '../core/image.ts';
import { focusScore, pageFocus, type FocusPatch } from '../core/focus.ts';
import type { WireImage } from './protocol.ts';

export interface FrameSource {
  readonly kind: 'camera' | 'file' | 'photos';
  /** What frames are read from: the video element, or the photo being shown. */
  readonly media: HTMLVideoElement | HTMLImageElement;
  readonly width: number;
  readonly height: number;
  /** Photos: the one showing (0-based) and how many there are. */
  readonly index?: number;
  readonly count?: number;
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
    media: video,
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
    media: video,
    get width() { return video.videoWidth; },
    get height() { return video.videoHeight; },
    async next() {
      if (stopped) return false;
      t += step;
      if (t >= duration - 0.01) return false;
      // Safari now and then drops a seek (no 'seeked' event); ask again rather than wait forever.
      for (let attempt = 0; attempt < 3; attempt++) {
        const seeked = waitEvent(video, 'seeked', 5_000);
        video.currentTime = t + attempt * 0.001;
        try {
          await seeked;
          return !stopped;
        } catch {
          if (stopped) return false;
        }
      }
      throw new Error(`The video stopped responding at ${t.toFixed(1)} s.`);
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

/**
 * Photos taken with the Camera app (one per page or spread), shown one at a time in `img`.
 * Each is properly focused and full resolution, unlike a video frame. The first photo is
 * shown straight away for lining up the outline; next() moves through them in order.
 */
export async function openPhotos(img: HTMLImageElement, files: File[]): Promise<FrameSource> {
  if (!files.length) throw new Error('No photos selected.');
  let url: string | null = null;
  let i = -1;
  let stopped = false;
  const show = async (k: number) => {
    const next = URL.createObjectURL(files[k]);
    img.src = next;
    try {
      await img.decode();
    } catch {
      URL.revokeObjectURL(next);
      throw new Error(`Couldn’t open photo ${k + 1} (${files[k].name}). If it’s HEIC, share it as JPEG (Most Compatible) and try again.`);
    }
    if (url) URL.revokeObjectURL(url);
    url = next;
  };
  await show(0);
  return {
    kind: 'photos',
    media: img,
    get width() { return img.naturalWidth; },
    get height() { return img.naturalHeight; },
    get index() { return Math.max(0, i); },
    count: files.length,
    async next() {
      if (stopped || i + 1 >= files.length) return false;
      i++;
      if (i > 0) await show(i);
      return !stopped;
    },
    progress: () => Math.max(0, i + 1) / files.length,
    time: () => Math.max(0, i),
    stop() {
      stopped = true;
      if (url) URL.revokeObjectURL(url);
      img.removeAttribute('src');
    },
  };
}

/** A 2D context, or a clear error (iOS refuses new canvases when its canvas memory is used up). */
function context(c: HTMLCanvasElement, readBack: boolean): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', readBack ? { willReadFrequently: true } : undefined);
  if (!ctx) throw new Error('The phone ran out of graphics memory. Close other apps and tabs, then try again.');
  return ctx;
}

/** Resizes only when needed: setting a canvas's size, even to the same value, reallocates it. */
function sized(c: HTMLCanvasElement, w: number, h: number) {
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  return c;
}

/** Reusable canvases for reading pixels out of the video element. */
export class FrameReader {
  private thumbCanvas = document.createElement('canvas');
  private focusCanvas = document.createElement('canvas');
  /** Frames kept for sending, one slot per page (see core/capture.ts). */
  private slots: HTMLCanvasElement[] = [];

  /** Gray thumbnail of a normalised region of the current frame (used for page-turn detection). */
  thumb(src: FrameSource, region: { x0: number; y0: number; x1: number; y1: number }, w = 96, h = 54): GrayImage {
    const ctx = context(sized(this.thumbCanvas, w, h), true);
    const vw = src.width, vh = src.height;
    ctx.drawImage(src.media, region.x0 * vw, region.y0 * vh, (region.x1 - region.x0) * vw, (region.y1 - region.y0) * vh, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const g = new Float32Array(w * h);
    for (let i = 0; i < g.length; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    return { width: w, height: h, data: g };
  }

  /** Focus score of each page of the current frame, from small full-resolution patches. */
  focus(src: FrameSource, patches: FocusPatch[], pages: number): number[] {
    if (!patches.length) return new Array(pages).fill(0);
    const total = patches.reduce((a, p) => a + p.size, 0);
    const tall = Math.max(...patches.map((p) => p.size));
    const ctx = context(sized(this.focusCanvas, total, tall), true);
    let x = 0;
    for (const p of patches) {
      ctx.drawImage(src.media, p.x, p.y, p.size, p.size, x, 0, p.size, p.size);
      x += p.size;
    }
    const d = ctx.getImageData(0, 0, total, tall).data;
    x = 0;
    const scores = patches.map((p) => {
      const g = new Float32Array(p.size * p.size);
      for (let yy = 0; yy < p.size; yy++) {
        for (let xx = 0; xx < p.size; xx++) {
          const i = (yy * total + x + xx) * 4;
          g[yy * p.size + xx] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        }
      }
      x += p.size;
      return focusScore({ width: p.size, height: p.size, data: g });
    });
    return pageFocus(patches, scores, pages);
  }

  /** Keeps a copy of the current frame in a slot. Only a canvas copy: the 4K pixels (33 MB) are read out by read(). */
  keep(src: FrameSource, slot: number) {
    const c = (this.slots[slot] ??= document.createElement('canvas'));
    context(sized(c, src.width, src.height), false).drawImage(src.media, 0, 0, src.width, src.height);
  }

  /** Full-resolution pixels of kept frames. */
  read(slots: number[]): WireImage[] {
    return slots.map((s) => {
      const c = this.slots[s];
      const img = context(c, false).getImageData(0, 0, c.width, c.height);
      return { width: c.width, height: c.height, buffer: img.data.buffer as ArrayBuffer };
    });
  }

  /** The canvas holding a kept frame (for saving a diagnostics copy). */
  slotCanvas(slot: number): HTMLCanvasElement | undefined {
    return this.slots[slot];
  }
}

const dataUrlCanvas = typeof document === 'undefined' ? null : document.createElement('canvas');

/** RGBA buffer -> JPEG data URL (for thumbnails in the review screen). One shared canvas: iOS is slow to free canvases. */
export function imageToDataURL(img: WireImage, quality = 0.85): string {
  const c = sized(dataUrlCanvas!, img.width, img.height);
  context(c, false).putImageData(new ImageData(new Uint8ClampedArray(img.buffer), img.width, img.height), 0, 0);
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
