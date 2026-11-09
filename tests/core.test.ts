import { describe, expect, it } from 'vitest';
import { homography, applyH, warpQuad, defaultCalibration, pocketQuads, type Quad } from '../src/core/geometry.ts';
import { createGray, fullRect, resampleGray, toGray } from '../src/core/image.ts';
import { fingerprint, fpDistance, phash, popcount32, FP_WORDS } from '../src/core/fingerprint.ts';
import { CardDB, decodeFingerprints, encodeFingerprints, normalizeName, type CardsFile } from '../src/core/carddb.ts';
import { SpreadWatcher } from '../src/core/motion.ts';
import { isJunkReading } from '../src/core/scan.ts';
import { makeCard, toReferenceSize } from './synth.ts';

describe('geometry', () => {
  it('homography maps corners exactly', () => {
    const src: Quad = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 20 }, { x: 0, y: 20 }];
    const dst: Quad = [{ x: 3, y: 5 }, { x: 40, y: 2 }, { x: 45, y: 60 }, { x: 1, y: 55 }];
    const H = homography(src, dst);
    src.forEach((p, i) => {
      const q = applyH(H, p.x, p.y);
      expect(q.x).toBeCloseTo(dst[i].x, 6);
      expect(q.y).toBeCloseTo(dst[i].y, 6);
    });
  });

  it('warping a quad back out recovers the original image', () => {
    const card = makeCard(7, 122, 170);
    const out = warpQuad(card, [{ x: 0, y: 0 }, { x: 122, y: 0 }, { x: 122, y: 170 }, { x: 0, y: 170 }], 122, 170);
    let diff = 0;
    for (let i = 0; i < out.data.length; i += 4) diff += Math.abs(out.data[i] - card.data[i]);
    expect(diff / (122 * 170)).toBeLessThan(3);
  });

  it('default calibration yields 2 pages x 9 pockets inside the frame', () => {
    const pages = pocketQuads(defaultCalibration(1920, 1080), 1920, 1080, 0);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toHaveLength(9);
    for (const q of pages.flat()) for (const p of q) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1920);
    }
  });
});

describe('fingerprints', () => {
  it('popcount', () => {
    expect(popcount32(0)).toBe(0);
    expect(popcount32(0xffffffff)).toBe(32);
    expect(popcount32(0x80000001)).toBe(2);
  });

  it('phash is stable under brightness/contrast changes', () => {
    const g = toGray(makeCard(3));
    const small = resampleGray(g, fullRect(g), 32, 32);
    const brighter = createGray(32, 32);
    small.data.forEach((v, i) => (brighter.data[i] = v * 0.7 + 40));
    expect(phash(small)).toEqual(phash(brighter));
  });

  it('same card at reference size and photo size is near; different cards are far', () => {
    const fps = new Uint32Array(FP_WORDS * 50);
    for (let i = 0; i < 50; i++) fps.set(fingerprint(toReferenceSize(makeCard(1000 + i))), i * FP_WORDS);
    const q = fingerprint(makeCard(1000 + 17, 300, 418));
    const dists = Array.from({ length: 50 }, (_, i) => fpDistance(q, fps, i));
    const best = dists.indexOf(Math.min(...dists));
    expect(best).toBe(17);
    expect(dists[17]).toBeLessThan(20);
    const others = dists.filter((_, i) => i !== 17);
    expect(Math.min(...others)).toBeGreaterThan(40);
  });
});

describe('card database', () => {
  const file: CardsFile = {
    v: 1,
    built: '2026-01-01',
    source: 'test',
    sets: { tst: 'Test Set' },
    cards: [
      ['a', 'Lightning Bolt', 'tst', '1', 'common', 3, 1.5, 4, null],
      ['b', 'Lightning Bolt', 'tst', '2', 'common', 1, 2.5, null, null],
      ['c', 'Llanowar Elves', 'tst', '3', 'common', 1, 0.25, null, null],
      ['d', 'Fable of the Mirror-Breaker // Reflection of Kiki-Jiki', 'tst', '4', 'rare', 1, 20, null, null],
    ],
  };
  const fps = decodeFingerprints(encodeFingerprints(new Uint32Array(4 * FP_WORDS), 4).buffer as ArrayBuffer);
  const db = new CardDB(file, fps);

  it('groups printings by name', () => {
    expect(db.names).toHaveLength(3);
    expect(db.printings[db.nameOf[0]]).toEqual([0, 1]);
    expect(db.info(0).finishes).toEqual(['nonfoil', 'foil']);
  });

  it('fuzzy-matches noisy OCR text', () => {
    expect(db.names[db.fuzzyNames('Lightnirg Bo1t')[0].name]).toBe('Lightning Bolt');
    expect(db.names[db.fuzzyNames('Fable of the Mirror-Breaker')[0].name]).toContain('Fable');
    expect(db.names[db.fuzzyNames('LLANOWAR ELVES')[0].name]).toBe('Llanowar Elves');
  });

  it('normalises names', () => {
    expect(normalizeName('Lim-Dûl the Necromancer')).toBe('lim dul the necromancer');
  });
});

describe('page-turn detection', () => {
  const thumb = (v: number, pattern = 0) => {
    const g = createGray(64, 36);
    g.data.forEach((_, i) => (g.data[i] = v + ((i * (7 + pattern)) % 23)));
    return g;
  };

  it('fires one capture per settled spread and ignores a pass-over without a page turn', () => {
    const w = new SpreadWatcher();
    const events: string[] = [];
    const feed = (g: ReturnType<typeof thumb>) => {
      const e = w.push(g);
      if (e?.type === 'settled') {
        events.push(e.newSpread ? 'capture' : 'same');
        if (e.newSpread) w.markCaptured(g);
      }
    };
    // spread A settles
    for (let i = 0; i < 5; i++) feed(thumb(50, 0));
    // page turning: big changes
    for (let i = 0; i < 4; i++) feed(thumb(20 + i * 30, i));
    // spread B settles
    for (let i = 0; i < 5; i++) feed(thumb(60, 5));
    // a hand passes over (motion) but the page is unchanged afterwards
    feed(thumb(150, 9));
    feed(thumb(60, 5));
    for (let i = 0; i < 5; i++) feed(thumb(60, 5));
    expect(events).toEqual(['capture', 'capture', 'same']);
  });
});

describe('rotated layouts', () => {
  it('keeps the top-left corner of each page at the cards\' top-left for every rotation', () => {
    for (const rot of [0, 90, 180, 270] as const) {
      const cal = defaultCalibration(1080, 1920, rot);
      for (const q of cal.pages) for (const p of q) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(1);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(1);
      }
      const [tl, tr] = cal.pages[0];
      const dir = { 0: [1, 0], 90: [0, 1], 180: [-1, 0], 270: [0, -1] }[rot];
      // top edge runs along the rotated x axis
      expect(Math.sign(Math.round((tr.x - tl.x) * 1000))).toBe(dir[0]);
      expect(Math.sign(Math.round((tr.y - tl.y) * 1000))).toBe(dir[1]);
    }
  });
});

describe('fast page turning', () => {
  const view = (seed: number, noise = 0) => {
    const g = createGray(64, 36);
    g.data.forEach((_, i) => (g.data[i] = 40 + ((i * (7 + seed)) % 50) + (noise ? ((i * 13 + noise) % 3) : 0)));
    return g;
  };
  const turning = (k: number) => view(100 + k);

  it('captures a pause too short to settle, using its stillest moment', () => {
    const w = new SpreadWatcher();
    const events: string[] = [];
    const feed = (g: ReturnType<typeof view>) => {
      const e = w.push(g);
      if (!e || e.type === 'moving') return;
      if (e.type === 'settled' && e.newSpread) { events.push('settled'); w.markCaptured(g); }
      if (e.type === 'brief' && e.newSpread) events.push('brief');
    };
    for (let i = 0; i < 4; i++) feed(view(1)); // spread A, held: settles
    for (let i = 0; i < 3; i++) feed(turning(i));
    feed(view(2)); feed(view(2, 1)); // spread B for only two samples
    for (let i = 3; i < 6; i++) feed(turning(i));
    for (let i = 0; i < 4; i++) feed(view(3)); // spread C, held
    // (a fallback frame is also kept at the start of every pause; only captures are listed here)
    expect(events).toEqual(['settled', 'brief', 'settled']);
  });

  it('drops a quick-pause capture that caught the page mid-turn', () => {
    const r = (m: number, u: number, e: number) => [
      ...Array.from({ length: m }, () => ({ status: 'matched' as const })),
      ...Array.from({ length: u }, () => ({ status: 'unknown' as const })),
      ...Array.from({ length: e }, () => ({ status: 'empty' as const })),
    ];
    expect(isJunkReading(r(1, 12, 5))).toBe(true); // a blur of two pages
    expect(isJunkReading(r(0, 0, 18))).toBe(true); // nothing readable at all
    expect(isJunkReading(r(14, 4, 0))).toBe(false); // a real spread with a few hard cards
    expect(isJunkReading(r(2, 0, 16))).toBe(false); // a mostly empty spread
  });
});
