// End-to-end recognition on synthetic binder spreads.
import { describe, expect, it } from 'vitest';
import { FP_WORDS, fingerprint } from '../src/core/fingerprint.ts';
import { recognizeSpread, type MatchIndex } from '../src/core/recognize.ts';
import { makeCard, renderSpread, rng, toReferenceSize } from './synth.ts';

const N_CARDS = 400;
const cards = Array.from({ length: N_CARDS }, (_, i) => makeCard(5000 + i));
const fps = new Uint32Array(N_CARDS * FP_WORDS);
cards.forEach((c, i) => fps.set(fingerprint(toReferenceSize(c)), i * FP_WORDS));
const index: MatchIndex = { fps, count: N_CARDS, nameOf: Int32Array.from({ length: N_CARDS }, (_, i) => i) };

function layout(seed: number, empties: number[]) {
  const r = rng(seed);
  const ids = Array.from({ length: 18 }, () => Math.floor(r() * N_CARDS));
  return ids.map((id, i) => (empties.includes(i) ? -1 : id));
}

function score(ids: number[], results: ReturnType<typeof recognizeSpread>) {
  let correct = 0, emptyOk = 0, wrong: string[] = [];
  results.forEach((p) => {
    const want = ids[p.page * 9 + p.slot];
    if (want < 0) {
      if (p.status === 'empty') emptyOk++;
      else wrong.push(`p${p.page}s${p.slot}: expected empty, got ${p.status}`);
      return;
    }
    if (p.status === 'matched' && p.matches[0].card === want) correct++;
    else wrong.push(`p${p.page}s${p.slot}: want ${want} got ${p.matches[0]?.card} d=${p.matches[0]?.d} other=${p.otherNameDistance} ${p.status}`);
  });
  return { correct, emptyOk, wrong };
}

describe('spread recognition (synthetic)', () => {
  const cases = [
    { name: 'clean 1080p', opts: { width: 1920, height: 1080, seed: 1, noise: 2, blur: true } },
    { name: '1080p with glare, colour cast, card jitter and calibration error', opts: { width: 1920, height: 1080, seed: 2, noise: 5, blur: true, glare: 0.45, cast: [1.08, 1, 0.88] as [number, number, number], exposure: 0.85, jitter: 0.02, calibError: 0.004 } },
    { name: '720p (low resolution)', opts: { width: 1280, height: 720, seed: 3, noise: 4, blur: true } },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const ids = layout(c.opts.seed, [4, 13]);
      const scene = renderSpread(ids.map((id) => (id >= 0 ? cards[id] : null)), c.opts);
      const t0 = performance.now();
      const res = recognizeSpread([scene.frame], scene.calibration, index);
      const ms = performance.now() - t0;
      const s = score(ids, res);
      console.log(`${c.name}: ${s.correct}/16 matched, ${s.emptyOk}/2 empty, ${ms.toFixed(0)} ms`, s.wrong);
      expect(res).toHaveLength(18);
      expect(s.emptyOk).toBe(2);
      expect(s.correct).toBeGreaterThanOrEqual(15);
    });
  }

  it('scales to a 100k-entry index', () => {
    // Pad the index with random fingerprints to approximate the full Scryfall catalogue.
    const total = 100_000;
    const big = new Uint32Array(total * FP_WORDS);
    big.set(fps);
    const r = rng(99);
    for (let i = N_CARDS * FP_WORDS; i < big.length; i++) big[i] = (r() * 0x100000000) >>> 0;
    const bigIndex: MatchIndex = { fps: big, count: total, nameOf: Int32Array.from({ length: total }, (_, i) => i) };
    const ids = layout(7, []);
    const scene = renderSpread(ids.map((id) => cards[id]), { width: 1920, height: 1080, seed: 7, noise: 3, blur: true });
    const t0 = performance.now();
    const res = recognizeSpread([scene.frame], scene.calibration, bigIndex);
    const ms = performance.now() - t0;
    const s = score(ids, res);
    console.log(`100k index: ${s.correct}/18 in ${ms.toFixed(0)} ms`, s.wrong);
    expect(s.correct).toBeGreaterThanOrEqual(17);
  });
});
