import type { Calibration } from '../core/geometry.ts';
import type { Match } from '../core/fingerprint.ts';
import type { PocketStatus } from '../core/recognize.ts';

export interface WireImage {
  width: number;
  height: number;
  buffer: ArrayBuffer;
}

export type WorkerRequest =
  | { type: 'init'; fps: Uint32Array; count: number; nameOf: Int32Array; back?: Uint32Array }
  /** `runId` groups the spreads of one run so the worker can follow the pages from one spread to the next. */
  /** `tentative`: taken from a pause too short to settle; dropped (`discarded`) if it reads as junk. */
  | { type: 'spread'; job: number; runId: number; frames: WireImage[]; calibration: Calibration; tentative?: boolean };

export interface WirePocket {
  page: number;
  slot: number;
  status: PocketStatus;
  matches: Match[];
  otherNameDistance: number;
  sharpness: number;
  glare: number;
  thumb: WireImage;
  nameCrop?: WireImage;
  query?: number[];
  borderLuma?: number;
  cardBack?: boolean;
  contrast?: number;
  symbolCrop?: WireImage;
  blurry?: boolean;
}

export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'spread'; job: number; pockets: WirePocket[]; ms: number; calibration: Calibration; retried: number[]; discarded?: boolean }
  | { type: 'error'; job?: number; message: string };
