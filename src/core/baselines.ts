// Per-printing price baselines from MTGJSON's 90-day history (see scripts/build-baselines.ts).
import type { Finish } from './carddb.ts';

export const BASELINE_FIELDS = 9;
const MAGIC = 0x4247544d; // "MTGB"
const FINISH_INDEX: Record<Finish, number> = { nonfoil: 0, foil: 1, etched: 2 };

export function encodeBaselines(data: Float32Array, count: number, asOf: string): Uint8Array {
  const buf = new ArrayBuffer(16 + count * BASELINE_FIELDS * 4);
  const dv = new DataView(buf);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, 1, true);
  dv.setUint32(8, count, true);
  dv.setUint32(12, asOf ? Number(asOf.replace(/-/g, '')) : 0, true);
  new Float32Array(buf, 16, count * BASELINE_FIELDS).set(data.subarray(0, count * BASELINE_FIELDS));
  return new Uint8Array(buf);
}

export interface Baseline {
  latest: number;
  avg30: number;
  avg90: number;
}

export class Baselines {
  readonly count: number;
  /** yyyy-mm-dd of the latest price in the history. */
  readonly asOf: string;
  private data: Float32Array;

  constructor(buf: ArrayBuffer) {
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== MAGIC) throw new Error('baselines.bin: bad magic');
    if (dv.getUint32(4, true) !== 1) throw new Error('baselines.bin: unsupported version');
    this.count = dv.getUint32(8, true);
    const d = String(dv.getUint32(12, true));
    this.asOf = d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : '';
    this.data = new Float32Array(buf.slice(16, 16 + this.count * BASELINE_FIELDS * 4));
  }

  get(card: number, finish: Finish): Baseline | null {
    if (card < 0 || card >= this.count) return null;
    const o = card * BASELINE_FIELDS + FINISH_INDEX[finish] * 3;
    const latest = this.data[o], avg30 = this.data[o + 1], avg90 = this.data[o + 2];
    if (!Number.isFinite(latest) || !Number.isFinite(avg30)) return null;
    return { latest, avg30, avg90 };
  }
}
