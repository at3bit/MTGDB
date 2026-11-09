// Simulates scanning a big binder, end to end, with real card scans, and
// reports where cards get lost. Mirrors the app's pipeline: the page-turn
// watcher on calibration-area thumbnails, the capture rule, recognition with
// page tracking, the review screen's handling of repeat captures and
// see-through cards, and what saving the binder would store.
//
// The binder is modelled as double-sided 9-pocket sheets. Spread k shows the
// back of sheet k on the left and the front of sheet k+1 on the right. With
// --empty, some sleeves are empty, and an empty sleeve shows whatever is
// behind it: the back of a card in the sleeve's other side, or (both sides
// empty) the card on the next sheet down, hazier through the extra plastic.
//
// Other things a real run has:
//   - the page stacks change height as you turn pages (left grows, right
//     shrinks), so the pages change size and position in the frame,
//   - the binder gets nudged a little on every turn,
//   - auto-exposure re-adjusts after each turn,
//   - a hand sometimes rests on the page for a moment after turning,
//   - turns at a natural, uneven pace.
//
//   npm run sim -- --spreads 16 --stack 0.08 --nudge 0.004 --empty 0.3
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { CardDB, decodeFingerprints, type CardsFile } from '../src/core/carddb.ts';
import { calibrationBounds, type Calibration, type Quad } from '../src/core/geometry.ts';
import { createRGBA, resampleGray, toGray, type GrayImage, type RGBAImage } from '../src/core/image.ts';
import { DEFAULT_MOTION, SpreadWatcher } from '../src/core/motion.ts';
import { isJunkReading, recognizeTrackedSpread } from '../src/core/scan.ts';
import { addReading, binderEntries, mergeInto, settlePrinting, type BinderEntry, type PocketView, type Spread } from '../src/app/session.ts';
import { renderSpread, rng, SCENE_PAGES } from '../tests/synth.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name: string, def: number) => (process.argv.includes(name) ? Number(process.argv[process.argv.indexOf(name) + 1]) : def);
const SPREADS = arg('--spreads', 16);
const STACK = arg('--stack', 0.08); // page size change from one end of the binder to the other (0.08 = 8%)
const NUDGE = arg('--nudge', 0.004); // random binder shift per page turn, fraction of frame
const HOLD_MIN = arg('--hold-min', 0.9); // seconds the page is held still after each turn
const HOLD_MAX = arg('--hold-max', 1.7);
const FLIP_MIN = arg('--flip-min', 0.5); // seconds a page turn takes
const FLIP_MAX = arg('--flip-max', 0.9);
const EMPTY = arg('--empty', 0); // fraction of sleeves that are empty
const SEED = arg('--seed', 3);
// --legacy: the app's behaviour before empty-sleeve handling (whole-spread repeat check, no see-through/card-back handling, no de-duplication)
const LEGACY = process.argv.includes('--legacy');
const FPS = arg('--fps', 15); // the app samples video at 15 fps
const W = 1920, H = 1080;
const r = rng(SEED);

// ---- the binder: sheets 0..SPREADS, each with a front and a back grid of 9 (as seen when that side faces up)
const file = JSON.parse(readFileSync(join(root, 'public/data/cards.json'), 'utf8')) as CardsFile;
const fpBuf = readFileSync(join(root, 'public/data/fingerprints.bin'));
const db = new CardDB(file, decodeFingerprints(fpBuf.buffer.slice(fpBuf.byteOffset, fpBuf.byteOffset + fpBuf.byteLength) as ArrayBuffer));
const used = new Set<number>();
const pick = () => {
  for (;;) {
    const i = Math.floor(r() * db.count);
    if (!used.has(i) && !used.has(-db.nameOf[i] - 1)) { used.add(i); used.add(-db.nameOf[i] - 1); return i; }
  }
};
type Grid = (number | null)[];
const sheets: { front: Grid; back: Grid }[] = [];
for (let j = 0; j <= SPREADS; j++) {
  const fill = (visible: boolean): Grid => Array.from({ length: 9 }, () => (visible && r() >= EMPTY ? pick() : null));
  // Sheet 0's front and the last sheet's back are never shown.
  sheets.push({ front: fill(j > 0), back: fill(j < SPREADS) });
}
/** The same physical sleeve seen from the other side is mirrored left-right. */
const mirror = (s: number) => Math.floor(s / 3) * 3 + (2 - (s % 3));
type Seen = { kind: 'card'; card: number; depth: number } | { kind: 'back'; depth: number } | null;
/** What you see in a slot of the right page (sheet j on top of the right stack) or the left page (sheet j on top of the left stack). */
function seen(side: 'left' | 'right', j: number, slot: number): Seen {
  for (let d = 0; d <= 2; d++) {
    const sheet = sheets[side === 'right' ? j + d : j - d];
    if (!sheet) return null;
    const near = side === 'right' ? sheet.front[slot] : sheet.back[slot];
    if (near !== null) return { kind: 'card', card: near, depth: d };
    const far = side === 'right' ? sheet.back[mirror(slot)] : sheet.front[mirror(slot)];
    if (far !== null) return { kind: 'back', depth: d };
  }
  return null;
}
/** The card truly in each slot of spread k (null = empty sleeve). */
const truth = (k: number, page: number, slot: number) => (page === 0 ? sheets[k].back[slot] : sheets[k + 1].front[slot]);
const realCards = new Set<number>();
for (let k = 0; k < SPREADS; k++) for (let p = 0; p < 2; p++) for (let s = 0; s < 9; s++) { const t = truth(k, p, s); if (t !== null) realCards.add(t); }

// ---- images
const scanDir = join(root, 'data-cache', 'scans');
mkdirSync(scanDir, { recursive: true });
async function loadImage(url: string, path: string): Promise<RGBAImage> {
  if (!existsSync(path)) {
    const res = await fetch(url, { headers: { 'User-Agent': 'MTGDB-binder-scanner/0.1 (simulation)' } });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  }
  const { data, info } = await sharp(path).resize(488, 680, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) };
}
const scanOf = new Map<number, RGBAImage>();
const ids = [...used].filter((i) => i >= 0);
console.log(`downloading ${ids.length} card scans (cached after the first run)…`);
for (let i = 0; i < ids.length; i += 12) {
  const batch = ids.slice(i, i + 12);
  const imgs = await Promise.all(batch.map((c) => { const id = file.cards[c][0]; return loadImage(`https://cards.scryfall.io/normal/front/${id[0]}/${id[1]}/${id}.jpg`, join(scanDir, `${id}.jpg`)); }));
  batch.forEach((c, k) => scanOf.set(c, imgs[k]));
}
const cardBack = EMPTY > 0 ? await loadImage('https://backs.scryfall.io/normal/0/a/0aeebaf5-8c7d-4636-9e82-8c27447861f7.jpg', join(root, 'data-cache', 'card-back.jpg')) : null;
/** A card seen through extra sleeve layers: hazier and softer. */
function throughPlastic(img: RGBAImage, layers: number): RGBAImage {
  if (layers <= 0) return img;
  const out = createRGBA(img.width, img.height);
  const haze = 0.18 * layers;
  const { width: w, height: h, data: d } = img;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
    let s = 0, n = 0;
    for (let dy = -layers; dy <= layers; dy++) for (let dx = -layers; dx <= layers; dx++) {
      const yy = Math.min(h - 1, Math.max(0, y + dy)), xx = Math.min(w - 1, Math.max(0, x + dx));
      s += d[(yy * w + xx) * 4 + c]; n++;
    }
    out.data[(y * w + x) * 4 + c] = (s / n) * (1 - haze) + 215 * haze;
  }
  for (let i = 3; i < out.data.length; i += 4) out.data[i] = 255;
  return out;
}
const hazed = new Map<string, RGBAImage>();
function imageFor(v: Seen): RGBAImage | null {
  if (!v) return null;
  const key = v.kind === 'card' ? `${v.card}:${v.depth}` : `back:${v.depth}`;
  let img = hazed.get(key);
  if (!img) {
    // A card back is always seen through at least the middle layer of its own sleeve.
    img = v.kind === 'card' ? throughPlastic(scanOf.get(v.card)!, v.depth) : throughPlastic(cardBack!, v.depth + 1);
    hazed.set(key, img);
  }
  return img;
}
let ghostsShown = 0, backsShown = 0;
const spreadImages = Array.from({ length: SPREADS }, (_, k) =>
  [0, 1].flatMap((page) =>
    Array.from({ length: 9 }, (_, s) => {
      const v = page === 0 ? seen('left', k, s) : seen('right', k + 1, s);
      if (v?.kind === 'card' && v.depth > 0) ghostsShown++;
      if (v?.kind === 'back') backsShown++;
      return imageFor(v);
    }),
  ),
);
console.log(`binder: ${SPREADS} spreads, ${realCards.size} cards${EMPTY > 0 ? `; empty sleeves show ${ghostsShown} cards from other sheets and ${backsShown} card backs` : ''}`);

// ---- geometry of each spread
function transformQuad(q: Quad, scale: number, dx: number, dy: number, rot: number): Quad {
  // Scale about the image centre (closer = bigger, and pushed outward), then rotate/shift the binder.
  const c = Math.cos(rot), s = Math.sin(rot);
  return q.map((p) => {
    let x = 0.5 + (p.x - 0.5) * scale, y = 0.5 + (p.y - 0.5) * scale;
    const ax = (x - 0.5) * (W / H), ay = y - 0.5;
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
  geometry.push([transformQuad(SCENE_PAGES[0], 1 + STACK * f, ndx, ndy, nrot), transformQuad(SCENE_PAGES[1], 1 + STACK * (1 - f), ndx, ndy, nrot)]);
}
const calibration: Calibration = { pages: geometry[0], rows: 3, cols: 3 };

// ---- render each spread once, then composite per sample (exposure, hand, noise)
console.log('rendering spreads…');
const base = geometry.map((pages, k) => renderSpread(spreadImages[k], { width: W, height: H, seed: 500 + k, pages, noise: 0, blur: true, haze: 0.08, jitter: 0.012 }).frame);
interface Seg { kind: 'hold' | 'flip'; k: number; t0: number; t1: number; handRest?: number }
const timeline: Seg[] = [];
let t = 0;
for (let k = 0; k < SPREADS; k++) {
  const hold = HOLD_MIN + r() * (HOLD_MAX - HOLD_MIN);
  timeline.push({ kind: 'hold', k, t0: t, t1: t + hold, handRest: r() < 0.3 ? 0.35 + r() * 0.3 : undefined });
  t += hold;
  if (k < SPREADS - 1) { const flip = FLIP_MIN + r() * (FLIP_MAX - FLIP_MIN); timeline.push({ kind: 'flip', k, t0: t, t1: t + flip }); t += flip; }
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
    hand = { x: 1.1 - 1.4 * u, y: 0.55 };
  } else {
    const since = time - seg.t0;
    const prev = seg.k > 0 ? exposure[seg.k - 1] : exposure[seg.k];
    const ease = Math.min(1, since / 0.7);
    expo = prev + (exposure[seg.k] - prev) * (1 - (1 - ease) ** 2);
    if (seg.handRest !== undefined) {
      const restEnd = (seg.t1 - seg.t0) * seg.handRest;
      if (since < restEnd) hand = { x: 0.9, y: 0.9 };
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

// ---- the app's capture loop
const bounds = calibrationBounds(calibration);
const boundsRect = { x: bounds.x0 * W, y: bounds.y0 * H, w: (bounds.x1 - bounds.x0) * W, h: (bounds.y1 - bounds.y0) * H };
const thumbOf = (g: GrayImage) => resampleGray(g, boundsRect, 96, 54);
const watcher = new SpreadWatcher(process.argv.includes('--no-brief') ? { ...DEFAULT_MOTION, briefThreshold: -1 } : DEFAULT_MOTION);
interface Captured { time: number; frames: RGBAImage[]; truthSpread: number; change: number; brief?: boolean }
const captures: Captured[] = [];
const log: string[] = [];
let pending: Captured | null = null;
let candidate: { frame: RGBAImage; time: number; truth: number } | null = null;
/** Which spread a frame mostly shows: the held spread, or during a turn whichever page dominates the frame. */
const truthAt = (time: number) => {
  const s = timeline.find((x) => time >= x.t0 && time < x.t1);
  if (!s) return -1;
  return s.kind === 'hold' ? s.k : (time - s.t0) / (s.t1 - s.t0) >= 0.5 ? s.k + 1 : s.k;
};
const total = timeline[timeline.length - 1].t1;
console.log(`simulating a ${total.toFixed(0)} s run at ${FPS} samples/s…`);
for (let time = 0; time < total; time += 1 / FPS) {
  const frame = frameAt(time);
  const thumb = thumbOf(toGray(frame));
  const ev = watcher.push(thumb);
  if (pending) {
    if (watcher.state === 'settled' && !ev) pending.frames.push(frame);
    captures.push(pending);
    pending = null;
  }
  if (ev?.type === 'candidate') candidate = { frame, time, truth: truthAt(time) };
  if (ev?.type === 'brief') {
    if (ev.newSpread && candidate) {
      if (pending) { captures.push(pending); pending = null; }
      log.push(`${candidate.time.toFixed(1)}s brief pause on ${candidate.truth >= 0 ? `spread ${candidate.truth + 1}` : 'a page turn'}: change ${Number.isFinite(ev.changeFromLast) ? ev.changeFromLast.toFixed(2) : '—'} (captured the stillest moment)`);
      captures.push({ time: candidate.time, frames: [candidate.frame], truthSpread: candidate.truth, change: ev.changeFromLast, brief: true });
    }
    candidate = null;
  }
  if (ev?.type === 'settled') {
    candidate = null;
    const tk = truthAt(time);
    log.push(`${time.toFixed(1)}s settled on ${tk >= 0 ? `spread ${tk + 1}` : 'a page turn'}: change ${Number.isFinite(ev.changeFromLast) ? ev.changeFromLast.toFixed(2) : '—'}${ev.newSpread ? '' : ' (skipped)'}`);
    if (ev.newSpread) { watcher.markCaptured(thumb); pending = { time, frames: [frame], truthSpread: tk, change: ev.changeFromLast }; }
  }
}
if (pending) captures.push(pending);

// ---- recognition and the review screen's bookkeeping (the same functions the app uses)
let spreads: Spread[] = [];
const truthOfSpread = new Map<number, number>();
let tracked: Calibration | undefined;
const idx = { fps: db.fps, count: db.count, nameOf: db.nameOf, back: LEGACY ? undefined : db.back };
if (!LEGACY && !db.back) console.warn('card data has no card-back fingerprint; run npm run data');
for (const c of captures) {
  const tr = recognizeTrackedSpread(c.frames, calibration, tracked, idx);
  if (c.brief && isJunkReading(tr.pockets)) {
    log.push(`brief capture at ${c.time.toFixed(1)}s read as junk (${c.truthSpread >= 0 ? `spread ${c.truthSpread + 1}` : 'a page turn'}): dropped`);
    continue;
  }
  tracked = tr.calibration;
  const pockets: PocketView[] = tr.pockets.map((p) =>
    settlePrinting({ page: p.page, slot: p.slot, status: p.status, matches: p.matches, otherNameDistance: p.otherNameDistance, thumbUrl: '', query: p.query, chosen: p.status === 'matched' || p.status === 'uncertain' ? p.matches[0]?.card ?? null : null, finish: 'nonfoil', via: 'image', glare: p.glare, borderLuma: p.borderLuma, cardBack: p.cardBack, sharpness: p.sharpness, contrast: p.contrast }, db),
  );
  const before = spreads.length;
  if (LEGACY) {
    const last = spreads[spreads.length - 1];
    let both = 0, agree = 0;
    if (last) for (const pa of last.pockets) { const pb = pockets.find((p) => p.page === pa.page && p.slot === pa.slot)!; if (pa.chosen === null || pb.chosen === null) continue; both++; if (db.nameOf[pa.chosen] === db.nameOf[pb.chosen]) agree++; }
    spreads = last && both >= 3 && agree / both >= 0.5 ? [...spreads.slice(0, -1), { ...last, pockets: mergeInto(last.pockets, pockets) }] : [...spreads, { id: (last?.id ?? 0) + 1, time: c.time, pockets }];
  } else spreads = addReading(spreads, { pockets, time: c.time, change: c.change, manual: false }, 2, db);
  if (spreads.length > before) truthOfSpread.set(spreads[spreads.length - 1].id, c.truthSpread);
  else log.push(`capture at ${c.time.toFixed(1)}s merged into the previous spread as a repeat`);
}

// ---- diagnostics: do see-through cards look different from the cards around them?
{
  const rows: { kind: string; sharp: number; contrast: number }[] = [];
  for (const s of spreads) {
    const tk = truthOfSpread.get(s.id) ?? -1;
    if (tk < 0) continue;
    const cards = s.pockets.filter((p) => p.status !== 'empty');
    const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 1;
    const mSharp = med(cards.map((p) => p.sharpness ?? 0)), mContrast = med(cards.map((p) => p.contrast ?? 0));
    for (const p of cards) {
      const v = p.page === 0 ? seen('left', tk, p.slot) : seen('right', tk + 1, p.slot);
      const kind = v?.kind === 'card' ? (v.depth > 0 ? 'see-through' : 'real') : 'other';
      rows.push({ kind, sharp: (p.sharpness ?? 0) / mSharp, contrast: (p.contrast ?? 0) / mContrast });
    }
  }
  for (const kind of ['real', 'see-through']) {
    const xs = rows.filter((r) => r.kind === kind);
    const q = (arr: number[], f: number) => [...arr].sort((a, b) => a - b)[Math.floor(f * (arr.length - 1))]?.toFixed(2);
    if (xs.length) console.log(`${kind} (${xs.length}): sharpness vs page median p10 ${q(xs.map((r) => r.sharp), 0.1)} p50 ${q(xs.map((r) => r.sharp), 0.5)} p90 ${q(xs.map((r) => r.sharp), 0.9)}; contrast p10 ${q(xs.map((r) => r.contrast), 0.1)} p50 ${q(xs.map((r) => r.contrast), 0.5)} p90 ${q(xs.map((r) => r.contrast), 0.9)}`);
  }
}

// ---- report: what saving the binder would store
const entries: BinderEntry[] = LEGACY
  ? spreads.flatMap((s, si) => s.pockets.filter((p) => p.chosen !== null).map((p) => ({ flagged: p.status !== 'matched' || !!p.printingCheck, spreadId: s.id, spreadIndex: si, page: p.page, slot: p.slot, card: p.chosen!, finish: p.finish, status: p.status })))
  : binderEntries(spreads, 2, db);
const spreadIndex = new Map(spreads.map((s, i) => [s.id, i]));
let rightPlace = 0, wrongPlace = 0, notInBinder = 0, greenWrong = 0;
const problems: string[] = [];
const savedNames = new Map<number, number>();
for (const e of entries) {
  const sIdx = spreadIndex.get(e.spreadId)!;
  const tk = truthOfSpread.get(e.spreadId) ?? -1;
  const want = tk >= 0 ? truth(tk, e.page, e.slot) : null;
  const name = db.nameOf[e.card];
  savedNames.set(name, (savedNames.get(name) ?? 0) + 1);
  if (want !== null && db.nameOf[want] === name) rightPlace++;
  else if ([...realCards].some((c) => db.nameOf[c] === name)) {
    if (process.argv.includes('--trace')) {
      const around = [-3, -2, -1, 0, 1, 2, 3].map((d) => {
        const sp = spreads[sIdx + d];
        if (!sp) return null;
        const q = sp.pockets.find((x) => x.page === e.page && x.slot === e.slot)!;
        const tk2 = truthOfSpread.get(sp.id) ?? -1;
        const v = tk2 >= 0 ? (e.page === 0 ? seen('left', tk2, e.slot) : seen('right', tk2 + 1, e.slot)) : null;
        const vis = v?.kind === 'card' ? `${db.info(v.card).name}${v.depth ? ` (depth ${v.depth})` : ''}` : v?.kind ?? 'nothing';
        return `      ${d >= 0 ? '+' : ''}${d}: shows ${vis}; read ${q.chosen !== null ? db.info(q.chosen).name : '—'} [${q.status}${q.ghost ? ', ghost' : ''}${q.seeThrough ? ', see-through?' : ''}${q.cardBack ? ', card back' : ''} d=${q.matches[0]?.d ?? '-'}]`;
      }).filter(Boolean).join('\n');
      console.log(`  TRACE ${db.info(e.card).name} at spread ${sIdx + 1} ${e.page ? 'right' : 'left'} slot ${e.slot + 1}:\n${around}`);
    }
    wrongPlace++; if (!e.flagged) greenWrong++; problems.push(`  ${db.info(e.card).name}: saved at spread ${sIdx + 1} ${e.page ? 'right' : 'left'} slot ${e.slot + 1}, but it isn't there (seen through an empty sleeve?) [${e.flagged ? 'flagged' : 'GREEN'}]`); }
  else { notInBinder++; if (!e.flagged) greenWrong++; problems.push(`  ${db.info(e.card).name}: saved at spread ${sIdx + 1} ${e.page ? 'right' : 'left'} slot ${e.slot + 1}; not in the binder [${e.flagged ? 'flagged' : 'GREEN'}]`); }
}
let falseBacks = 0, trueBacks = 0, backsSeen = 0;
for (const sp of spreads) {
  const tk = truthOfSpread.get(sp.id) ?? -1;
  if (tk < 0) continue;
  for (const p of sp.pockets) {
    const v = p.page === 0 ? seen('left', tk, p.slot) : seen('right', tk + 1, p.slot);
    if (v?.kind === 'back') backsSeen++;
    if (p.cardBack) { if (v?.kind === 'back') trueBacks++; else falseBacks++; }
  }
}
console.log(`card backs: ${trueBacks} of ${backsSeen} recognised; ${falseBacks} cards wrongly taken for a card back`);
const dupes = [...savedNames.values()].filter((n) => n > 1).reduce((a, n) => a + n - 1, 0);
const found = new Set([...realCards].filter((c) => savedNames.has(db.nameOf[c])));
const missed = [...realCards].filter((c) => !found.has(c));
const flagged = entries.filter((e) => e.flagged).length;
console.log('\n' + log.join('\n'));
console.log(`\nspreads in the binder: ${SPREADS}; captures: ${captures.length}; spreads after merging repeats: ${spreads.length}`);
console.log(`cards in the binder: ${realCards.size}; saved entries: ${entries.length} (${flagged} flagged orange/red to check)`);
console.log(`  right card, right place: ${rightPlace}`);
console.log(`  real card, wrong place: ${wrongPlace}`);
console.log(`  not in the binder at all: ${notInBinder}`);
console.log(`  duplicate entries: ${dupes}`);
console.log(`  cards missed: ${missed.length}${missed.length ? ' (' + missed.slice(0, 6).map((c) => db.info(c).name).join(', ') + (missed.length > 6 ? ', …' : '') + ')' : ''}`);
console.log(`  wrong entries shown green (not flagged for checking): ${greenWrong}`);
console.log(problems.slice(0, 12).join('\n'));
console.log(`RESULT ${((100 * found.size) / realCards.size).toFixed(0)}% of cards found; ${((100 * rightPlace) / Math.max(1, entries.length)).toFixed(0)}% of saved entries exactly right`);
