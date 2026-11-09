import { describe, expect, it } from 'vitest';
import { CapturePolicy, DEFAULT_CAPTURE, type CaptureSend } from '../src/core/capture.ts';
import { focusPatches, focusScore, pageFocus } from '../src/core/focus.ts';
import { defaultCalibration } from '../src/core/geometry.ts';
import { createGray, createRGBA, resampleGray, toGray } from '../src/core/image.ts';
import { defocusBlur, rng } from './synth.ts';

const view = (seed: number) => {
  const g = createGray(64, 36);
  g.data.forEach((_, i) => (g.data[i] = 40 + ((i * (7 + seed)) % 50)));
  return g;
};
// (the pattern repeats every 50 seeds; these never coincide with views 1 and 2)
const turning = (k: number) => view(13 + k);
const DT = 1 / 15;

/** Drives a policy like the run controller does; slots hold labels instead of frames. */
function driver(policy: CapturePolicy) {
  const slots: string[] = [];
  const sends: (CaptureSend & { frames: string[] })[] = [];
  let t = 0;
  const feed = (label: string, thumb: ReturnType<typeof view>, focus: number[]) => {
    const r = policy.sample(thumb, focus, t);
    t += DT;
    for (const s of r.keep) slots[s] = label;
    if (r.send) sends.push({ ...r.send, frames: r.send.slots.map((s) => slots[s]) });
    return r;
  };
  return { feed, sends, flush: () => policy.flush() };
}

describe('capture policy', () => {
  it('uploaded video: sends the sharpest frame of each page when the next turn starts', () => {
    const d = driver(new CapturePolicy(2));
    for (let i = 0; i < 3; i++) d.feed(`turn${i}`, turning(i), [1, 1]);
    // The page lands and the camera refocuses: page 0 is sharpest at a2, page 1 at a3.
    [[0.2, 0.2], [0.5, 0.4], [0.9, 0.3], [0.8, 0.95], [0.7, 0.6], [0.7, 0.6]].forEach((f, i) => d.feed(`a${i}`, view(1), f));
    expect(d.sends).toHaveLength(0); // nothing sent while the page is still held
    d.feed('turn3', turning(3), [1, 1]);
    expect(d.sends).toHaveLength(1);
    expect(d.sends[0]).toMatchObject({ frames: ['a2', 'a3'], manual: false, brief: false });
  });

  it('live camera: sends once focus stops improving, without waiting for the next turn', () => {
    const d = driver(new CapturePolicy(1, { ...DEFAULT_CAPTURE, live: true }));
    for (let i = 0; i < 3; i++) d.feed(`turn${i}`, turning(i), [1]);
    const focus = [0.2, 0.5, 0.8, 0.95, 0.96, 0.95, 0.96, 0.95, 0.94, 0.95, 0.95, 0.95];
    focus.forEach((f, i) => d.feed(`a${i}`, view(1), [f]));
    expect(d.sends).toHaveLength(1);
    expect(d.sends[0].frames).toEqual(['a4']);
  });

  it('a pause too short to settle sends its sharpest frame as tentative', () => {
    const d = driver(new CapturePolicy(1));
    for (let i = 0; i < 4; i++) d.feed(`a${i}`, view(1), [0.9]); // spread A settles
    for (let i = 0; i < 3; i++) d.feed(`turn${i}`, turning(i), [1]);
    d.feed('b0', view(2), [0.3]); // lands
    d.feed('b1', view(2), [0.6]); // one still sample, then turned again
    for (let i = 3; i < 6; i++) d.feed(`turn${i}`, turning(i), [1]);
    expect(d.sends.map((s) => [s.frames[0], s.brief])).toEqual([['a0', false], ['b1', true]]);
  });

  it('a hand passing over a held spread is not a new capture', () => {
    const d = driver(new CapturePolicy(1));
    for (let i = 0; i < 4; i++) d.feed(`a${i}`, view(1), [0.9]);
    d.feed('hand', turning(9), [1]);
    for (let i = 0; i < 4; i++) d.feed(`again${i}`, view(1), [0.9]);
    d.feed('turn', turning(10), [1]);
    expect(d.sends).toHaveLength(1);
    expect(d.flush()).toBeNull();
  });

  it('Snap (manual mode) sends the sharpest of the next few samples', () => {
    const policy = new CapturePolicy(1);
    policy.mode = 'manual';
    const d = driver(policy);
    for (let i = 0; i < 4; i++) d.feed(`a${i}`, view(1), [0.5]);
    expect(d.sends).toHaveLength(0);
    policy.snap();
    [0.4, 0.8, 0.6, 0.7, 0.9].forEach((f, i) => d.feed(`s${i}`, view(1), [f]));
    expect(d.sends).toHaveLength(1);
    expect(d.sends[0]).toMatchObject({ frames: ['s1'], manual: true });
  });

  it('flushes a held spread at the end of the video', () => {
    const d = driver(new CapturePolicy(1));
    for (let i = 0; i < 5; i++) d.feed(`a${i}`, view(1), [0.5 + i / 10]);
    expect(d.sends).toHaveLength(0);
    expect(d.flush()?.slots).toEqual([0]);
  });
});

describe('focus measure', () => {
  it('drops steadily with defocus, whatever the exposure', () => {
    // A printed-looking texture: fine strokes over larger shapes.
    const r = rng(5);
    const card = createRGBA(400, 560);
    for (let y = 0; y < 560; y++) for (let x = 0; x < 400; x++) {
      const v = 120 + 50 * Math.sin(x / 9) * Math.cos(y / 13) + (((x >> 2) + (y >> 3)) % 3 === 0 ? 40 : 0) + (r() - 0.5) * 20;
      card.data.set([v, v * 0.9, v * 0.8, 255], (y * 400 + x) * 4);
    }
    const scores = [0, 1, 2, 4, 8].map((sigma) => {
      const img = defocusBlur({ ...card, data: new Uint8ClampedArray(card.data) }, sigma);
      return focusScore(resampleGray(toGray(img), { x: 120, y: 160, w: 160, h: 160 }, 160, 160));
    });
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeLessThan(scores[i - 1]);
    const dim = toGray(card);
    dim.data.forEach((v, i) => (dim.data[i] = v * 0.6)); // the camera's exposure is a gain
    const a = focusScore(resampleGray(toGray(card), { x: 120, y: 160, w: 160, h: 160 }, 160, 160));
    const b = focusScore(resampleGray(dim, { x: 120, y: 160, w: 160, h: 160 }, 160, 160));
    expect(Math.abs(a - b) / a).toBeLessThan(0.05);
  });

  it('measures three patches per page inside the frame', () => {
    const patches = focusPatches(defaultCalibration(3840, 2160), 3840, 2160);
    expect(patches).toHaveLength(6);
    for (const p of patches) {
      expect(p.size).toBe(160);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x + p.size).toBeLessThanOrEqual(3840);
    }
    expect(pageFocus(patches, [1, 2, 3, 4, 5, 6], 2)).toEqual([2, 5]);
  });
});
