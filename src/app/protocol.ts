import type { Calibration } from '../core/geometry.ts';
import type { Match } from '../core/fingerprint.ts';
import type { PocketStatus } from '../core/recognize.ts';

/** A frame on its way to the worker. */
export type Frame = WireImage | ImageBitmap;

export interface WireImage {
  width: number;
  height: number;
  buffer: ArrayBuffer;
}

export type WorkerRequest =
  | { type: 'init'; fps: Uint32Array; count: number; nameOf: Int32Array; back?: Uint32Array; allowed?: Uint8Array | null; preferred?: Uint8Array | null }
  /** Which printings matching may return (null = all), and which it prefers (the binder's colours; null = no preference). */
  | { type: 'allowed'; allowed: Uint8Array | null; preferred: Uint8Array | null }
  /** `runId` groups the spreads of one run so the worker can follow the pages from one spread to the next. */
  /** `tentative`: taken from a pause too short to settle; dropped (`discarded`) if it reads as junk. */
  /** Frames as pixels, or as ImageBitmaps (the worker reads their pixels itself, off the page's thread). */
  | { type: 'spread'; job: number; runId: number; frames: Frame[]; calibration: Calibration; tentative?: boolean };

export interface WirePocket {
  page: number;
  slot: number;
  status: PocketStatus;
  matches: Match[];
  otherNameDistance: number;
  sharpness: number;
  glare: number;
  /** Review photo: a JPEG file when the worker could encode one, else raw pixels. */
  thumb?: WireImage;
  thumbJpeg?: Blob;
  nameCrop?: WireImage;
  /** The title-line crop as a JPEG (when the worker could encode one; then nameCrop is left out). */
  nameJpeg?: Blob;
  query?: number[];
  borderLuma?: number;
  cardBack?: boolean;
  contrast?: number;
  symbolCrop?: WireImage;
  blurry?: boolean;
  blank?: boolean;
  offCategory?: boolean;
}

export type WorkerResponse =
  /** `bitmaps`: the worker can take frames as ImageBitmaps. */
  | { type: 'ready'; bitmaps?: boolean }
  | { type: 'spread'; job: number; pockets: WirePocket[]; ms: number; calibration: Calibration; retried: number[]; discarded?: boolean; turns?: number[] }
  | { type: 'error'; job?: number; message: string };
