// Per-printing price baselines from MTGJSON's 90-day history (see scripts/build-baselines.ts).
//
// baselines.bin (little endian)
//   "MTGB" | u32 version | u32 count | u32 asOf (yyyymmdd) | count * fields * f32
//   version 2: 12 fields per card, 4 per finish (nonfoil, foil, etched):
//              [latest, 30-day average, 90-day average, price 30 days ago]
//   version 1: 9 fields per card, 3 per finish (no "30 days ago")
//   NaN = no data. Entry i belongs to cards.json cards[i].
import type { Finish } from './carddb.ts';

export const PER_FINISH = 4;
export const BASELINE_FIELDS = 3 * PER_FINISH;
const MAGIC = 0x4247544d; // "MTGB"
const FINISH_INDEX: Record<Finish, number> = { nonfoil: 0, foil: 1, etched: 2 };

export function encodeBaselines(data: Float32Array, count: number, asOf: string): Uint8Array {
  const buf = new ArrayBuffer(16 + count * BASELINE_FIELDS * 4);
  const dv = new DataView(buf);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, count, true);
  dv.setUint32(12, asOf ? Number(asOf.replace(/-/g, '')) : 0, true);
  new Float32Array(buf, 16, count * BASELINE_FIELDS).set(data.subarray(0, count * BASELINE_FIELDS));
  return new Uint8Array(buf);
}

export interface Baseline {
  latest: number;
  avg30: number;
  avg90: number;
  /** Price about 30 days before `latest` (NaN if unknown). */
  ago30: number;
}

export class Baselines {
  readonly count: number;
  /** yyyy-mm-dd of the latest price in the history. */
  readonly asOf: string;
  private data: Float32Array;
  private perFinish: number;

  constructor(buf: ArrayBuffer) {
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== MAGIC) throw new Error('baselines.bin: bad magic');
    const version = dv.getUint32(4, true);
    if (version !== 1 && version !== 2) throw new Error('baselines.bin: unsupported version');
    this.perFinish = version === 1 ? 3 : PER_FINISH;
    this.count = dv.getUint32(8, true);
    const d = String(dv.getUint32(12, true));
    this.asOf = d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : '';
    this.data = new Float32Array(buf.slice(16, 16 + this.count * this.perFinish * 3 * 4));
  }

  get(card: number, finish: Finish): Baseline | null {
    if (card < 0 || card >= this.count) return null;
    const o = card * this.perFinish * 3 + FINISH_INDEX[finish] * this.perFinish;
    const latest = this.data[o], avg30 = this.data[o + 1], avg90 = this.data[o + 2];
    if (!Number.isFinite(latest) || !Number.isFinite(avg30)) return null;
    return { latest, avg30, avg90, ago30: this.perFinish > 3 ? this.data[o + 3] : NaN };
  }
}
