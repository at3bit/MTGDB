// Rules added for accuracy: English-only matching, the name cross-check, unsure names not saved,
// one outline for both pages, and the outline staying where the user put it.
import { describe, expect, it } from 'vitest';
import { CardDB, decodeFingerprints, encodeFingerprints, type CardRow, type CardsFile } from '../src/core/carddb.ts';
import { FP_WORDS, fingerprint } from '../src/core/fingerprint.ts';
import { defaultCalibration, outlineOf, withOutline, type Quad } from '../src/core/geometry.ts';
import { recognizeSpread, type MatchIndex } from '../src/core/recognize.ts';
import { recognizeTrackedSpread } from '../src/core/scan.ts';
import { addReading, applyOcr, binderEntries, nameUnsure, type PocketView } from '../src/app/session.ts';
import { makeCard, renderSpread, rng, toReferenceSize } from './synth.ts';

const names = ['Lightning Bolt', 'Counterspell', 'Llanowar Elves', 'Serra Angel', 'Dark Ritual'];
// Lightning Bolt also has a Japanese printing with the same art (index 5).
const rows: CardRow[] = [...names.map((n, i) => [`id-${i}`, n, 'tst', String(i), 'common', 1, 1, null, null] as CardRow), ['id-ja', 'Lightning Bolt', 'jpn', '1', 'common', 1, 9, null, null]];
const file: CardsFile = { v: 1, built: '2026-01-01', source: 'test', sets: { tst: 'Test', jpn: 'Japanese' }, cards: rows, langs: { ja: [5] } };
const fps = new Uint32Array(rows.length * FP_WORDS);
for (let i = 0; i < names.length; i++) fps.set(fingerprint(toReferenceSize(makeCard(300 + i))), i * FP_WORDS);
fps.set(fps.subarray(0, FP_WORDS), 5 * FP_WORDS); // same art as the English Lightning Bolt
const db = new CardDB(file, decodeFingerprints(encodeFingerprints(fps, rows.length).buffer as ArrayBuffer));

function pocket(card: number | null, status: PocketView['status'] = 'matched'): PocketView {
  return { page: 0, slot: 0, status, matches: card === null ? [] : [{ card, d: 10 }], otherNameDistance: 50, thumbUrl: '', chosen: card, finish: 'nonfoil', via: card === null ? null : 'image', glare: 0 };
}

describe('English only', () => {
  it('leaves foreign printings out of matching and printing choices', () => {
    db.setEnglishOnly(false);
    expect(db.printingsOf(0)).toEqual([0, 5]);
    db.setEnglishOnly(true);
    expect(db.printingsOf(0)).toEqual([0]);
    expect(db.foreign[5]).toBe(1);
    // The image matcher can't return the Japanese printing any more.
    const scene = renderSpread([makeCard(300), ...Array(17).fill(null)], { width: 1920, height: 1080, seed: 1, noise: 2, blur: true });
    const idx: MatchIndex = { fps: db.fps, count: db.count, nameOf: db.nameOf, allowed: db.allowed };
    const got = recognizeSpread([scene.frame], scene.calibration, idx).find((p) => p.page === 0 && p.slot === 0)!;
    expect(got.matches.map((m) => m.card)).not.toContain(5);
  });
});

describe('name cross-check', () => {
  it('confirms a match whose printed name agrees', () => {
    expect(applyOcr(pocket(0), 'Lightning Bo1t', db)).toMatchObject({ nameCheck: 'agrees', status: 'matched' });
  });
  it('flags a match whose printed name clearly reads as another card, and does not save it', () => {
    const p = applyOcr(pocket(0), 'Counterspell', db);
    expect(p).toMatchObject({ nameCheck: 'differs', status: 'uncertain', readName: db.nameOf[1] });
    expect(nameUnsure(p)).toBe(true);
    const spreads = addReading([], { pockets: [p], time: 0, change: Infinity, manual: false }, 1, db);
    expect(binderEntries(spreads, 1, db)).toHaveLength(0);
  });
  it('leaves an unreadable name alone', () => {
    expect(applyOcr(pocket(0), '~~', db)).toMatchObject({ nameCheck: 'unread', status: 'matched', chosen: 0 });
  });
  it('a weak read of an unidentified card is only a suggestion', () => {
    const p = applyOcr(pocket(null, 'unknown'), 'Serra Angle xx', db);
    expect(p.chosen).toBeNull();
    expect(p.readName).toBe(db.nameOf[3]);
  });
  it('a clean read identifies an unidentified card', () => {
    expect(applyOcr(pocket(null, 'unknown'), 'Llanowar Elves', db)).toMatchObject({ chosen: 2, status: 'matched', via: 'text' });
  });
});

describe('one outline', () => {
  it('derives both pages from one outline and a spine gap, and back', () => {
    const cal = defaultCalibration(1920, 1080, 0, 2);
    const { quad, gap } = outlineOf(cal);
    expect(gap).toBeGreaterThan(0);
    const again = withOutline(cal, quad, gap);
    again.pages.forEach((q, p) => q.forEach((c, i) => {
      expect(c.x).toBeCloseTo(cal.pages[p][i].x, 6);
      expect(c.y).toBeCloseTo(cal.pages[p][i].y, 6);
    }));
    const wider = withOutline(cal, quad, gap + 0.1);
    expect(wider.pages[0][1].x).toBeLessThan(cal.pages[0][1].x);
    expect(wider.pages[1][0].x).toBeGreaterThan(cal.pages[1][0].x);
  });
  it('one page is just the outline', () => {
    const cal = defaultCalibration(1080, 1920, 0, 1);
    expect(outlineOf(cal).quad).toEqual(cal.pages[0]);
  });
});

describe('the outline stays put', () => {
  it('reads with the outline as given when the cards are where it says', () => {
    const r = rng(4);
    const n = 60;
    const cards = Array.from({ length: n }, (_, i) => makeCard(900 + i));
    const f = new Uint32Array(n * FP_WORDS);
    cards.forEach((c, i) => f.set(fingerprint(toReferenceSize(c)), i * FP_WORDS));
    const idx: MatchIndex = { fps: f, count: n, nameOf: Int32Array.from({ length: n }, (_, i) => i) };
    const scene = renderSpread(Array.from({ length: 18 }, () => cards[Math.floor(r() * n)]), { width: 1920, height: 1080, seed: 9, noise: 2, blur: true });
    const tracked = recognizeTrackedSpread([scene.frame], scene.calibration, undefined, idx);
    expect(tracked.retried).toEqual([]);
    expect(tracked.calibration.pages).toEqual(scene.calibration.pages as Quad[]);
  });
});
