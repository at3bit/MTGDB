import { describe, expect, it } from 'vitest';
import { Baselines, encodeBaselines, BASELINE_FIELDS } from '../src/core/baselines.ts';
import { trendFor } from '../src/app/store.ts';

describe('price baselines', () => {
  const data = new Float32Array(2 * BASELINE_FIELDS).fill(NaN);
  data.set([12, 10, 9], 0); // card 0 nonfoil: latest 12, avg30 10, avg90 9
  data.set([3, 4, 4.5], BASELINE_FIELDS + 3); // card 1 foil
  const enc = encodeBaselines(data, 2, '2026-11-07');
  const b = new Baselines(enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.byteLength) as ArrayBuffer);

  it('round-trips and reports missing data as null', () => {
    expect(b.count).toBe(2);
    expect(b.asOf).toBe('2026-11-07');
    expect(b.get(0, 'nonfoil')).toEqual({ latest: 12, avg30: 10, avg90: 9 });
    expect(b.get(0, 'foil')).toBeNull();
    expect(b.get(1, 'foil')?.avg30).toBe(4);
    expect(b.get(5, 'nonfoil')).toBeNull();
  });

  it('market baseline drives the trend; local history is the fallback', () => {
    const t = trendFor({}, 'x', 'nonfoil', 12.5, b.get(0, 'nonfoil'))!;
    expect(t.source).toBe('market');
    expect(t.vsAvg).toBeCloseTo(0.25); // today's price 12.5 vs 30-day average 10
    expect(trendFor({}, 'x', 'nonfoil', null, b.get(0, 'nonfoil'))!.vsAvg).toBeCloseTo(0.2); // falls back to the baseline's latest
    expect(t.avg).toBe(10);
    const day = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
    const local = trendFor({ 'x:nonfoil': [[day(3), 4], [day(2), 4], [day(1), 4]] }, 'x', 'nonfoil', 5, null)!;
    expect(local.source).toBe('local');
    expect(local.vsAvg).toBeCloseTo(0.25);
  });
});
