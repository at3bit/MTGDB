// Simulates scanning a big binder, end to end, with real card scans, and
// reports where cards get lost. Mirrors the app's pipeline: the page-turn
// watcher on calibration-area thumbnails, the capture rule, recognition, and
// the by-name merging of repeat captures.
//
// What a long real run has that the earlier tests didn't:
//   - the page stacks change height as you turn pages (left grows, right
//     shrinks), so the pages change size and position in the frame,
//   - the binder gets nudged a little on every turn,
//   - auto-exposure re-adjusts after each turn,
//   - a hand sometimes rests on the page for a moment after turning,
//   - turns at a natural, uneven pace.
//
//   npm run sim -- --spreads 16 --stack 0.08 --nudge 0.004
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { CardDB, decodeFingerprints, type CardsFile } from '../src/core/carddb.ts';
import { calibrationBounds, type Calibration, type Quad } from '../src/core/geometry.ts';
import { createRGBA, resampleGray, toGray, type GrayImage, type RGBAImage } from '../src/core/image.ts';
import { SpreadWatcher } from '../src/core/motion.ts';
import { recognizeSpread } from '../src/core/recognize.ts';
import { mergeInto, settlePrinting, type PocketView } from '../src/app/session.ts';
import { recognizeTrackedSpread } from '../src/core/scan.ts';
import { renderSpread, rng, SCENE_PAGES } from '../tests/synth.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name: string, def: number) => (process.argv.includes(name) ? Number(process.argv[process.argv.indexOf(name) + 1]) : def);
const SPREADS = arg('--spreads', 16);
const STACK = arg('--stack', 0.08); // page size change from one end of the binder to the other (0.08 = 8%)
const NUDGE = arg('--nudge', 0.004); // random binder shift per page turn, fraction of frame
const HOLD_MIN = arg('--hold-min', 0.9); // seconds the page is held still after each turn
const HOLD_MAX = arg('--hold-max', 1.7);
const SEED = arg('--seed', 3);
const TRACK = !process.argv.includes('--no-track'); // re-find the pages on each spread (the app does)
const FPS = 10; // the app samples video at 10 fps
const W = 1920, H = 1080;
const r = rng(SEED);

// ---- data
const file = JSON.parse(readFileSync(join(root, 'public/data/cards.json'), 'utf8')) as CardsFile;
const fpBuf = readFileSync(join(root, 'public/data/fingerprints.bin'));
const db = new CardDB(file, decodeFingerprints(fpBuf.buffer.slice(fpBuf.byteOffset, fpBuf.byteOffset + fpBuf.byteLength) as ArrayBuffer));
const picks: number[] = [];
while (picks.length < SPREADS * 18) {
  const i = Math.floor(r() * db.count);
  if (!picks.includes(i)) picks.push(i);
}
const scanDir = join(root, 'data-cache', 'scans');
mkdirSync(scanDir, { recursive: true });
async function scan(i: number): Promise<RGBAImage> {
  const id = file.cards[i][0];
  const path = join(scanDir, `${id}.jpg`);
  if (!existsSync(path)) {
    const res = await fetch(`https://cards.scryfall.io/normal/front/${id[0]}/${id[1]}/${id}.jpg`, { headers: { 'User-Agent': 'MTGDB-binder-scanner/0.1 (simulation)' } });
    if (!res.ok) throw new Error(`scan ${id}: HTTP ${res.status}`);
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  }
  const { data, info } = await sharp(path).resize(488, 680, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) };
}
console.log(`downloading ${picks.length} card scans (cached after the first run)…`);
const scans: RGBAImage[] = [];
for (let i = 0; i < picks.length; i += 12) scans.push(...(await Promise.all(picks.slice(i, i + 12).map(scan))));

// ---- geometry of each spread
function transformQuad(q: Quad, scale: number, dx: number, dy: number, rot: number): Quad {
  // Scale about the image centre (closer = bigger, and pushed outward), then rotate/shift the binder.
  const c = Math.cos(rot), s = Math.sin(rot);
  return q.map((p) => {
    let x = 0.5 + (p.x - 0.5) * scale, y = 0.5 + (p.y - 0.5) * scale;
    const ax = (x - 0.5) * (W / H), ay = y - 0.5; // rotate in pixel-aspect space
    x = 0.5 + (ax * c - ay * s) / (W / H);
    y = 0.5 + ax * s + ay * c;
    return { x: x + dx, y: y + dy };
  }) as Quad;
}
let ndx = 0, ndy = 0, nrot = 0;
const geometry: Quad[][] = [];
for (let k = 0; k < SPREADS; k++) {
  if (k > 0) { ndx += (r() * 2 - 1) * NUDGE; ndy += (r() * 2 - 1) * NUDGE; nrot += (r() * 2 - 1) * NUDGE * 0.6; }
  const f = SPREADS > 1 ? k / (SPREADS - 1) : 0;
  geometry.push([
    transformQuad(SCENE_PAGES[0], 1 + STACK * f, ndx, ndy, nrot),
    transformQuad(SCENE_PAGES[1], 1 + STACK * (1 - f), ndx, ndy, nrot),
  ]);
}
// The user lines up the outline once, on the first spread.
const calibration: Calibration = { pages: geometry[0], rows: 3, cols: 3 };
const shift = (a: Quad, b: Quad) => Math.max(...a.map((p, i) => Math.hypot((p.x - b[i].x) * W, (p.y - b[i].y) * H)));
const cardW = (SCENE_PAGES[0][1].x - SCENE_PAGES[0][0].x) * W / 3;
console.log(`page drift by the last spread: ${(shift(geometry[SPREADS - 1][0], geometry[0][0]) / cardW * 100).toFixed(0)}% of a card width (left page), ${(shift(geometry[SPREADS - 1][1], geometry[0][1]) / cardW * 100).toFixed(0)}% (right)`);

// ---- render each spread once, then composite per sample (exposure, hand, noise)
console.log('rendering spreads…');
const base = geometry.map((pages, k) => renderSpread(scans.slice(k * 18, k * 18 + 18), { width: W, height: H, seed: 500 + k, pages, noise: 0, blur: true, haze: 0.08, jitter: 0.012 }).frame);
interface Seg { kind: 'hold' | 'flip'; k: number; t0: number; t1: number; handRest?: number }
const timeline: Seg[] = [];
let t = 0;
for (let k = 0; k < SPREADS; k++) {
  const hold = HOLD_MIN + r() * (HOLD_MAX - HOLD_MIN);
  timeline.push({ kind: 'hold', k, t0: t, t1: t + hold, handRest: r() < 0.3 ? 0.35 + r() * 0.3 : undefined });
  t += hold;
  if (k < SPREADS - 1) { const flip = 0.5 + r() * 0.4; timeline.push({ kind: 'flip', k, t0: t, t1: t + flip }); t += flip; }
}
const exposure = Array.from({ length: SPREADS }, () => 0.85 + r() * 0.3);
const nr = rng(SEED + 99);
function frameAt(time: number): RGBAImage {
  const seg = timeline.find((s) => time >= s.t0 && time < s.t1) ?? timeline[timeline.length - 1];
  const out = createRGBA(W, H);
  let a = base[seg.k], b = a, mix = 0, expo = exposure[seg.k];
  let hand: { x: number; y: number } | null = null;
  if (seg.kind === 'flip') {
    const u = (time - seg.t0) / (seg.t1 - seg.t0);
    b = base[seg.k + 1]; mix = u;
    expo = exposure[seg.k];
    hand = { x: 1.1 - 1.4 * u, y: 0.55 };
  } else {
    const since = time - seg.t0;
    // auto-exposure eases to the new level over ~0.7 s after the turn
    const prev = seg.k > 0 ? exposure[seg.k - 1] : exposure[seg.k];
    const ease = Math.min(1, since / 0.7);
    expo = prev + (exposure[seg.k] - prev) * (1 - (1 - ease) ** 2);
    if (seg.handRest !== undefined) {
      const restEnd = (seg.t1 - seg.t0) * seg.handRest;
      if (since < restEnd) hand = { x: 0.9, y: 0.9 }; // fingertips resting on the bottom-right corner
      else if (since < restEnd + 0.3) hand = { x: 0.9 + (since - restEnd) * 1.5, y: 0.9 + (since - restEnd) };
    }
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = (y * W + x) * 4;
    let isHand = false;
    if (hand) { const dx = (x / W - hand.x) / 0.16, dy = (y / H - hand.y) / 0.3; isHand = dx * dx + dy * dy <= 1; }
    for (let c = 0; c < 3; c++) {
      const v = isHand ? [196, 150, 120][c] : (a.data[p + c] * (1 - mix) + b.data[p + c] * mix) * expo;
      out.data[p + c] = v + (nr() + nr() + nr() - 1.5) * 6;
    }
    out.data[p + 3] = 255;
  }
  return out;
}

// ---- the app's pipeline
const bounds = calibrationBounds(calibration);
const boundsRect = { x: bounds.x0 * W, y: bounds.y0 * H, w: (bounds.x1 - bounds.x0) * W, h: (bounds.y1 - bounds.y0) * H };
const thumbOf = (g: GrayImage) => resampleGray(g, boundsRect, 96, 54);
const watcher = new SpreadWatcher();
interface Captured { time: number; frames: RGBAImage[]; truthSpread: number }
const captures: Captured[] = [];
const log: string[] = [];
let pending: Captured | null = null;
const truthAt = (time: number) => { const s = timeline.find((x) => time >= x.t0 && time < x.t1); return s?.kind === 'hold' ? s.k : -1; };
const total = timeline[timeline.length - 1].t1;
console.log(`simulating a ${total.toFixed(0)} s run (${SPREADS} spreads, ${SPREADS * 18} cards) at ${FPS} samples/s…`);
for (let time = 0; time < total; time += 1 / FPS) {
  const frame = frameAt(time);
  const thumb = thumbOf(toGray(frame));
  const ev = watcher.push(thumb);
  if (pending) {
    if (watcher.state === 'settled' && !ev) pending.frames.push(frame);
    captures.push(pending);
    pending = null;
  }
  if (ev?.type === 'settled') {
    const tk = truthAt(time);
    log.push(`${time.toFixed(1)}s settled on ${tk >= 0 ? `spread ${tk + 1}` : 'a page turn'}: change from last capture ${Number.isFinite(ev.changeFromLast) ? ev.changeFromLast.toFixed(2) : '—'} -> ${ev.newSpread ? 'CAPTURE' : 'skipped as same spread'}`);
    if (ev.newSpread) { watcher.markCaptured(thumb); pending = { time, frames: [frame], truthSpread: tk }; }
  }
}
if (pending) captures.push(pending);
const settledSpreads = new Set(log.filter((l) => l.includes('settled on spread')).map((l) => l.match(/spread (\d+)/)![1]));

// recognition + the review screen's merge of repeat captures
interface SpreadResult { truth: number; pockets: PocketView[] }
const spreads: SpreadResult[] = [];
let tracked: Calibration | undefined;
for (const c of captures) {
  const idx = { fps: db.fps, count: db.count, nameOf: db.nameOf };
  let res;
  if (TRACK) {
    const t = recognizeTrackedSpread(c.frames, calibration, tracked, idx);
    tracked = t.calibration;
    res = t.pockets;
    log.push(`capture at ${c.time.toFixed(1)}s: pages found ${t.calibration.pages.map((q, i) => `${(shift(q, calibration.pages[i]) / cardW * 100).toFixed(0)}%`).join(' / ')} of a card width from the outline${t.retried.length ? ` (re-read page ${t.retried.map((p) => p + 1).join(', ')})` : ''}`);
  } else {
    res = recognizeSpread(c.frames, calibration, idx);
  }
  const pockets = res.map((p) =>
    settlePrinting({ page: p.page, slot: p.slot, status: p.status, matches: p.matches, otherNameDistance: p.otherNameDistance, thumbUrl: '', query: p.query, chosen: p.status === 'matched' || p.status === 'uncertain' ? p.matches[0]?.card ?? null : null, finish: 'nonfoil', via: 'image', glare: p.glare, borderLuma: p.borderLuma }, db),
  );
  const last = spreads[spreads.length - 1];
  let both = 0, agree = 0;
  if (last) for (const pa of last.pockets) { const pb = pockets.find((p) => p.page === pa.page && p.slot === pa.slot)!; if (pa.chosen === null || pb.chosen === null) continue; both++; if (db.nameOf[pa.chosen] === db.nameOf[pb.chosen]) agree++; }
  if (last && both >= 3 && agree / both >= 0.5) {
    log.push(`capture at ${c.time.toFixed(1)}s merged into previous spread as a repeat`);
    last.pockets = mergeInto(last.pockets, pockets);
    continue;
  }
  spreads.push({ truth: c.truthSpread, pockets });
}

// ---- report
let saved = 0, right = 0, unknown = 0, empty = 0, wrongGreen = 0;
const wrongDetail: string[] = [];
const perSpread: string[] = [];
for (const s of spreads) {
  let ok = 0, unk = 0;
  for (const p of s.pockets) {
    const truth = s.truth >= 0 ? picks[s.truth * 18 + p.page * 9 + p.slot] : -1;
    if (p.chosen !== null) {
      saved++;
      if (truth >= 0 && db.nameOf[p.chosen] === db.nameOf[truth]) { right++; ok++; }
      else {
        if (p.status === 'matched') wrongGreen++;
        wrongDetail.push(`  spread ${s.truth + 1} page ${p.page + 1} slot ${p.slot + 1}: ${truth >= 0 ? db.info(truth).name : '?'} -> ${db.info(p.chosen).name} [${p.status}, d=${p.matches[0]?.d}, next name d=${p.otherNameDistance}]`);
      }
    }
    else if (p.status === 'empty') empty++;
    else { unknown++; unk++; }
  }
  perSpread.push(`  spread ${s.truth + 1}: ${ok}/18 right${unk ? `, ${unk} unreadable` : ''}`);
}
const uniqueTruth = new Set(spreads.map((s) => s.truth));
console.log('\n' + log.join('\n'));
console.log(`\nspreads in the binder: ${SPREADS}; settled on: ${settledSpreads.size}; captured: ${captures.length}; kept after merging repeats: ${spreads.length} (${uniqueTruth.size} distinct)`);
console.log(perSpread.join('\n'));
console.log(`\ncards in the binder: ${SPREADS * 18}`);
console.log(`cards that would be saved: ${saved} (${right} with the right name), unreadable: ${unknown}, called empty: ${empty}`);
console.log(`saved with the wrong name: ${saved - right} (${wrongGreen} shown green as identified, the rest orange/red for checking)`);
console.log(wrongDetail.slice(0, 12).join('\n'));
console.log(`RESULT ${((100 * right) / (SPREADS * 18)).toFixed(0)}% of the binder captured correctly`);
