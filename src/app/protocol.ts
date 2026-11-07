import type { Calibration } from '../core/geometry.ts';
import type { Match } from '../core/fingerprint.ts';
import type { PocketStatus } from '../core/recognize.ts';

export interface WireImage {
  width: number;
  height: number;
  buffer: ArrayBuffer;
}

export type WorkerRequest =
  | { type: 'init'; fps: Uint32Array; count: number; nameOf: Int32Array }
  | { type: 'spread'; job: number; frames: WireImage[]; calibration: Calibration };

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
}

export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'spread'; job: number; pockets: WirePocket[]; ms: number }
  | { type: 'error'; job?: number; message: string };
