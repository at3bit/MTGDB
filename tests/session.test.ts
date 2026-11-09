// Review-screen bookkeeping: repeat captures, cards seen through empty sleeves, one entry per printing.
import { describe, expect, it } from 'vitest';
import { CardDB, decodeFingerprints, encodeFingerprints, type CardRow, type CardsFile } from '../src/core/carddb.ts';
import { FP_WORDS } from '../src/core/fingerprint.ts';
import { addReading, binderEntries, isRepeat, markGhosts, type PocketView, type Spread } from '../src/app/session.ts';
import type { PocketStatus } from '../src/core/recognize.ts';

const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet', 'Kilo', 'Lima', 'Mike', 'November', 'Oscar', 'Papa', 'Quebec', 'Romeo', 'Sierra', 'Tango', 'Forest'];
// One printing per name, plus a second printing of "Delta" and of "Forest".
const rows: CardRow[] = [...names.map((n, i) => [`id-${i}`, n, 'tst', String(i), 'common', 1, 1, null, null] as CardRow), ['id-delta-2', 'Delta', 'xyz', '9', 'rare', 1, 5, null, null], ['id-forest-2', 'Forest', 'xyz', '10', 'common', 1, 0.1, null, null]];
const file: CardsFile = { v: 1, built: '2026-01-01', source: 'test', sets: { tst: 'Test', xyz: 'Other' }, cards: rows };
const buf = encodeFingerprints(new Uint32Array(rows.length * FP_WORDS), rows.length);
const db = new CardDB(file, decodeFingerprints(buf.buffer as ArrayBuffer));
const idx = (name: string) => names.indexOf(name);
const DELTA_2 = names.length, FOREST_2 = names.length + 1;

function pocket(page: number, slot: number, card: number | null, status: PocketStatus = card === null ? 'empty' : 'matched', d = 10): PocketView {
  return { page, slot, status, matches: card === null ? [] : [{ card, d }], otherNameDistance: 50, thumbUrl: '', chosen: card, finish: 'nonfoil', via: card === null ? null : 'image', glare: 0 };
}
/** A spread: 9 cards per page given as card indices (or null). */
function spread(id: number, left: (number | null)[], right: (number | null)[]): Spread {
  return { id, time: id, pockets: [...left.map((c, s) => pocket(0, s, c)), ...right.map((c, s) => pocket(1, s, c))] };
}
const nine = (from: number) => Array.from({ length: 9 }, (_, i) => (from + i) % names.length);

describe('repeat captures', () => {
  const a = spread(1, nine(0), nine(9));
  it('same cards and a small view change: a repeat', () => {
    expect(isRepeat(a, { pockets: spread(2, nine(0), nine(9)).pockets, time: 2, change: 0.15, manual: false }, 2, db)).toBe(true);
  });
  it('a big view change with different cards: a new page', () => {
    expect(isRepeat(a, { pockets: spread(2, nine(3), nine(12)).pockets, time: 2, change: 0.6, manual: false }, 2, db)).toBe(false);
  });
  it('right page looks unchanged through empty sleeves, but the left page changed: a new page', () => {
    // After the turn, the right page shows cards that were already visible through its empty sleeves.
    const b = spread(2, nine(5), nine(9));
    expect(isRepeat(a, { pockets: b.pockets, time: 2, change: 0.2, manual: false }, 2, db)).toBe(false);
  });
});

describe('cards seen through empty sleeves', () => {
  it('right page: the earlier copy is the see-through one', () => {
    const empty = Array(9).fill(null);
    const s1 = spread(1, empty, [idx('Alpha'), null, null, null, null, null, null, null, null]);
    const s2 = spread(2, empty, [idx('Alpha'), null, null, null, null, null, null, null, null]);
    const [m1, m2] = markGhosts([s1, s2], 2, db);
    expect(m1.pockets[9].ghost).toBe(true);
    expect(m2.pockets[9].ghost).toBeFalsy();
  });

  it('left page: the later copy is the see-through one', () => {
    const empty = Array(9).fill(null);
    const s1 = spread(1, [idx('Bravo'), ...Array(8).fill(null)], empty);
    const s2 = spread(2, [idx('Bravo'), ...Array(8).fill(null)], empty);
    const [m1, m2] = markGhosts([s1, s2], 2, db);
    expect(m1.pockets[0].ghost).toBeFalsy();
    expect(m2.pockets[0].ghost).toBe(true);
  });

  it('links two readings of one card that settled on different printings', () => {
    const empty = Array(9).fill(null);
    const s1 = spread(1, empty, [idx('Delta'), ...Array(8).fill(null)]);
    const s2 = spread(2, empty, [DELTA_2, ...Array(8).fill(null)]);
    expect(markGhosts([s1, s2], 2, db)[0].pockets[9].ghost).toBe(true);
  });

  it('does not link different printings of a basic land unless the earlier one looks hazier', () => {
    const empty = Array(9).fill(null);
    const s1 = spread(1, empty, [idx('Forest'), ...Array(8).fill(null)]);
    const s2 = spread(2, empty, [FOREST_2, ...Array(8).fill(null)]);
    expect(markGhosts([s1, s2], 2, db)[0].pockets[9].ghost).toBeFalsy();
    s1.pockets[9] = { ...s1.pockets[9], matches: [{ card: idx('Forest'), d: 20 }] };
    expect(markGhosts([s1, s2], 2, db)[0].pockets[9].ghost).toBe(true);
  });

  it('fixes a misread real copy using the see-through reading', () => {
    const empty = Array(9).fill(null);
    const s1 = spread(1, empty, [idx('Echo'), ...Array(8).fill(null)]);
    const s2 = spread(2, empty, [idx('Golf'), ...Array(8).fill(null)]);
    // The real copy (later, right page) was misread as Golf, with Echo as its runner-up.
    s2.pockets[9] = { ...s2.pockets[9], status: "uncertain", matches: [{ card: idx("Golf"), d: 30 }, { card: idx("Echo"), d: 31 }] };
    const [m1, m2] = markGhosts([s1, s2], 2, db);
    expect(m1.pockets[9].ghost).toBe(true);
    expect(m2.pockets[9].chosen).toBe(idx('Echo'));
  });
});

describe('saving', () => {
  it('keeps one entry per printing and leaves out see-through cards', () => {
    let spreads: Spread[] = [];
    const empty = Array(9).fill(null);
    spreads = addReading(spreads, { pockets: spread(0, [idx('Alpha'), idx('Alpha'), null, null, null, null, null, null, null], [idx('Hotel'), ...Array(8).fill(null)]).pockets, time: 1, change: Infinity, manual: false }, 2, db);
    spreads = addReading(spreads, { pockets: spread(0, [idx('India'), ...Array(8).fill(null)], [idx('Hotel'), ...Array(8).fill(null)]).pockets, time: 2, change: 0.6, manual: false }, 2, db);
    expect(spreads).toHaveLength(2);
    const entries = binderEntries(spreads, 2, db);
    const got = entries.map((e) => `${e.spreadIndex}:${e.page}:${e.slot}:${db.names[db.nameOf[e.card]]}`);
    // Alpha twice on one page -> once; Hotel seen through the right page of spread 1 -> only at spread 2.
    expect(got).toEqual(['0:0:0:Alpha', '1:0:0:India', '1:1:0:Hotel']);
    void empty;
  });
});
