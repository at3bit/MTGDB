import { describe, expect, it } from 'vitest';
import { copies, rowValue, totals } from '../src/app/store.ts';

describe('quantities', () => {
  it('counts a card with no quantity as one copy', () => {
    expect(copies({})).toBe(1);
    expect(copies({ qty: 4 })).toBe(4);
  });

  it('never counts fewer than one copy, or a fraction', () => {
    expect(copies({ qty: 0 })).toBe(1);
    expect(copies({ qty: -3 })).toBe(1);
    expect(copies({ qty: NaN })).toBe(1);
    expect(copies({ qty: 2.6 })).toBe(3);
  });

  it('values a card at price × copies, and an unpriced card at 0', () => {
    expect(rowValue({ price: 2.5, qty: 4 })).toBe(10);
    expect(rowValue({ price: 2.5 })).toBe(2.5);
    expect(rowValue({ price: null, qty: 4 })).toBe(0);
  });

  it('totals value and copies across cards', () => {
    const t = totals([
      { price: 1, qty: 3 },
      { price: 10 },
      { price: null, qty: 2 },
    ]);
    expect(t.value).toBe(13);
    expect(t.count).toBe(6);
    expect(totals([])).toEqual({ value: 0, count: 0 });
  });
});
