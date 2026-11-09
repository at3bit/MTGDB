// End-to-end test in headless Chromium with synthetic data:
//   1. builds a small synthetic card index (procedural "cards", not real ones),
//   2. renders a binder-run video: 3 spreads, page turns, and a hand passing
//      over a spread without turning the page,
//   3. uploads it to the built app, processes it, checks the review screen,
//      saves the binder and checks the binder screen.
// Run with: npm run e2e   (after npm run build)
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FP_WORDS, fingerprint } from '../src/core/fingerprint.ts';
import { encodeFingerprints, type CardsFile } from '../src/core/carddb.ts';
import { makeCard, renderSpread, rng, toReferenceSize, SCENE_PAGES } from '../tests/synth.ts';
import type { RGBAImage } from '../src/core/image.ts';
import { writeDataVersion } from './data-version.ts';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const out = join(root, 'test-results');
const W = 1280, H = 720, FPS = 15;
mkdirSync(out, { recursive: true });
if (!existsSync(join(dist, 'index.html'))) throw new Error('Run `npm run build` first');

// 1. Synthetic index
const N = 300;
const cards = Array.from({ length: N }, (_, i) => makeCard(9000 + i));
const r = rng(4);
const file: CardsFile = {
  v: 1,
  built: new Date().toISOString(),
  source: 'Synthetic test data',
  sets: { tst: 'Synthetic Test Set' },
  cards: cards.map((_, i) => [`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, `Synthetic Card ${String(i).padStart(3, '0')}`, 'tst', String(i + 1), 'common', 3, Math.round(r() * 5000) / 100, null, null]),
};
const fps = new Uint32Array(N * FP_WORDS);
cards.forEach((c, i) => fps.set(fingerprint(toReferenceSize(c)), i * FP_WORDS));
mkdirSync(join(dist, 'test-data'), { recursive: true });
writeFileSync(join(dist, 'test-data', 'cards.json'), JSON.stringify(file));
writeFileSync(join(dist, 'test-data', 'fingerprints.bin'), encodeFingerprints(fps, N));
writeDataVersion(join(dist, 'test-data'));

// 2. Video
const spreadIds = [0, 1, 2].map((s) => Array.from({ length: 18 }, (_, i) => (s === 1 && i === 8 ? -1 : (s * 18 + i * 7 + 3) % N)));
const renderVariant = (s: number, v: number) =>
  renderSpread(spreadIds[s].map((id) => (id >= 0 ? cards[id] : null)), { width: W, height: H, seed: 100 + s, noiseSeed: 500 + v, noise: 2.5, blur: true, jitter: 0.012 }).frame;
console.log('rendering frames…');
const still = spreadIds.map((_, s) => [0, 1, 2].map((v) => renderVariant(s, v)));
const blend = (a: RGBAImage, b: RGBAImage, t: number, handX: number): Uint8Array => {
  const o = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = (y * W + x) * 4, q = (y * W + x) * 3;
    const dx = (x / W - handX) / 0.18, dy = (y / H - 0.55) / 0.35;
    const hand = dx * dx + dy * dy <= 1;
    for (let c = 0; c < 3; c++) o[q + c] = hand ? [196, 150, 120][c] : a.data[p + c] * (1 - t) + b.data[p + c] * t;
  }
  return o;
};
const rgb = (img: RGBAImage) => {
  const o = new Uint8Array(W * H * 3);
  for (let i = 0, j = 0; i < img.data.length; i += 4, j += 3) { o[j] = img.data[i]; o[j + 1] = img.data[i + 1]; o[j + 2] = img.data[i + 2]; }
  return o;
};
const frames: Uint8Array[] = [];
const hold = (s: number, seconds: number) => { for (let i = 0; i < seconds * FPS; i++) frames.push(rgb(still[s][i % 3])); };
const turn = (a: number, b: number, seconds: number) => {
  const n = Math.round(seconds * FPS);
  for (let i = 0; i < n; i++) frames.push(blend(still[a][0], still[b][0], i / (n - 1), 1.1 - (1.4 * i) / (n - 1)));
};
const passOver = (s: number, seconds: number) => {
  const n = Math.round(seconds * FPS);
  for (let i = 0; i < n; i++) frames.push(blend(still[s][0], still[s][0], 0, 1.1 - (1.4 * i) / (n - 1)));
};
hold(0, 1.6);
turn(0, 1, 0.8);
hold(1, 1.6);
passOver(1, 0.6); // hand passes over without turning the page
hold(1, 1.4);
turn(1, 2, 0.8);
hold(2, 1.6);
const videoPath = join(out, 'run.webm');
await new Promise<void>((resolve, reject) => {
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-', '-c:v', 'libvpx-vp9', '-b:v', '6M', '-deadline', 'realtime', '-cpu-used', '8', '-g', '15', videoPath]);
  ff.on('error', reject);
  ff.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  for (const f of frames) ff.stdin.write(f);
  ff.stdin.end();
});
console.log(`video: ${frames.length} frames, ${(statSync(videoPath).size / 1e6).toFixed(1)} MB`);
// A second video with quick flips: spread 2 is on screen, still, for only a moment before the next turn.
const fastPath = join(out, 'fast.webm');
{
  const fast: Uint8Array[] = [];
  for (let i = 0; i < 1.2 * FPS; i++) fast.push(rgb(still[0][i % 3]));
  const flip = (a: number, b: number, n: number) => { for (let i = 0; i < n; i++) fast.push(blend(still[a][0], still[b][0], i / (n - 1), 1.1 - (1.4 * i) / (n - 1))); };
  // Spread 2 lands on the last frame of one flip and the next flip starts on the following frame:
  // still for about 2 frames (0.13 s), too short to settle.
  flip(0, 1, 7);
  flip(1, 2, 7);
  for (let i = 0; i < 1.2 * FPS; i++) fast.push(rgb(still[2][i % 3]));
  await new Promise<void>((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-', '-c:v', 'libvpx-vp9', '-b:v', '6M', '-deadline', 'realtime', '-cpu-used', '8', '-g', '15', fastPath]);
    ff.on('error', reject);
    ff.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
    for (const f of fast) ff.stdin.write(f);
    ff.stdin.end();
  });
}

// 3. Serve dist and drive the app
const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.bin': 'application/octet-stream', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.gz': 'application/gzip' };
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  let p = join(dist, decodeURIComponent(url.pathname));
  if (!existsSync(p) || statSync(p).isDirectory()) p = join(dist, 'index.html');
  res.writeHead(200, { 'Content-Type': types[extname(p)] ?? 'application/octet-stream' });
  res.end(readFileSync(p));
});
await new Promise<void>((r) => server.listen(4173, r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
const logs: string[] = [];
page.on('console', (m: any) => logs.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e: Error) => logs.push(`pageerror: ${e.message}`));
page.on('dialog', (d: any) => d.accept()); // "Discard this scan?"
// Lets a phase drop video seeks the way Safari sometimes does (no 'seeked' event): window.__seeks = { n, drop: [k…], deadFrom }.
await page.addInitScript(() => {
  const w = window as any;
  w.__seeks = { n: 0, drop: [], deadFrom: Infinity };
  const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')!;
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
    configurable: true,
    get() { return desc.get!.call(this); },
    set(v: number) {
      const s = w.__seeks;
      s.n++;
      if (s.drop.includes(s.n) || s.n >= s.deadFrom) return;
      desc.set!.call(this, v);
    },
  });
});
let failed = false;
const check = (cond: boolean, msg: string) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failed = true; };

try {
  await page.goto('http://localhost:4173/?db=test-data');
  // Seed the saved calibration so the outline matches the synthetic scene (a user does this by dragging corners once).
  await page.evaluate(async (pages: unknown) => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('keyval-store');
      req.onupgradeneeded = () => req.result.createObjectStore('keyval');
      req.onsuccess = () => {
        const tx = req.result.transaction('keyval', 'readwrite');
        tx.objectStore('keyval').put({ calibration: { pages, rows: 3, cols: 3 }, rotation: 0, frameW: 1280, frameH: 720 }, 'calibration-v1');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
    });
  }, SCENE_PAGES);
  await page.reload();
  await page.getByRole('button', { name: 'Scan a binder' }).waitFor({ timeout: 20000 });
  await page.screenshot({ path: join(out, '1-home.png') });
  await page.getByRole('button', { name: 'Scan a binder' }).click();
  await page.locator('input[type=text]').fill('Trade Binder');
  await page.screenshot({ path: join(out, '2-setup.png') });
  await page.setInputFiles('[data-testid=video-input]', videoPath);
  await page.getByRole('button', { name: 'Process video' }).waitFor({ timeout: 20000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, '3-calibrate.png') });
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Process video' }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(out, '4-running.png') });
  await page.getByText('Review “Trade Binder”').waitFor({ timeout: 120000 });
  console.log(`processed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, '5-review.png'), fullPage: true });

  const spreadCount = await page.locator('strong', { hasText: /^Spread \d+$/ }).count();
  check(spreadCount === 3, `3 spreads captured (got ${spreadCount}); the hand pass-over was not counted as a new spread`);
  const tiles: { cls: string; name: string }[] = await page.locator('.tile').evaluateAll((els: Element[]) => els.map((e) => ({ cls: e.className, name: e.querySelector('.name')?.textContent ?? '' })));
  const expected = spreadIds.flatMap((ids) => ids.map((id) => (id >= 0 ? `Synthetic Card ${String(id).padStart(3, '0')}` : 'Empty')));
  let correct = 0;
  tiles.forEach((t, i) => { if (t.name === expected[i]) correct++; else console.log(`  tile ${i}: expected ${expected[i]}, got "${t.name}" (${t.cls})`); });
  check(tiles.length === 54 && correct >= 52, `pockets identified: ${correct}/${tiles.length}`);
  const expectedTotal = spreadIds.flat().filter((id) => id >= 0).reduce((t, id) => t + (file.cards[id][6] as number), 0);
  const shownTotal = await page.locator('.big-number').first().textContent();
  console.log(`  total shown ${shownTotal}, expected $${expectedTotal.toFixed(2)} if all correct`);

  // Open a pocket, then save.
  await page.locator('.tile').nth(1).click();
  await page.getByRole('dialog').waitFor();
  await page.screenshot({ path: join(out, '6-sheet.png') });
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Save binder' }).click();
  await page.getByRole('button', { name: 'Export CSV' }).waitFor({ timeout: 10000 });
  await page.screenshot({ path: join(out, '7-binder-gallery.png'), fullPage: true });
  const identified = tiles.filter((t) => !['Empty', '?', 'Check', '—'].includes(t.name)).length;
  // List view, sorted by price (the binder's default sort).
  await page.getByRole('button', { name: 'List', exact: true }).click();
  const listRows = page.locator('[data-testid=cards-list] li');
  const saved = await listRows.count();
  check(saved === identified, `binder saved with ${saved} cards (expected ${identified}; empty pockets are skipped)`);
  const prices: number[] = ((await listRows.locator('.num').allTextContents()) as string[]).map((t: string) => Number(t.replace(/[$,]/g, '')));
  check(prices.every((p: number, i: number) => i === 0 || prices[i - 1] >= p), `list sorted by highest price (${prices.slice(0, 3).join(', ')}, …)`);
  await page.screenshot({ path: join(out, '7-binder-list.png'), fullPage: true });
  // Search inside the binder.
  const someName = file.cards[spreadIds[1][4]][1];
  await page.getByLabel('Search cards').fill(someName);
  const summary = await page.getByTestId('cards-summary').textContent();
  check(/^1 match/.test(summary ?? '') && (await listRows.count()) === 1, `search “${someName}” in the binder: ${summary}`);
  await page.getByRole('button', { name: '‹ Home' }).click();
  // "Do I own…?" from the home screen.
  await page.getByLabel('Search your collection').fill(someName.replace('Synthetic ', ''));
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByText('All cards').waitFor();
  const found = await page.getByTestId('cards-summary').textContent();
  check(/^1 match/.test(found ?? ''), `home search finds it in the collection: ${found}`);
  await page.screenshot({ path: join(out, '8-search.png'), fullPage: true });
  await page.getByRole('button', { name: '‹ Home' }).click();
  await page.screenshot({ path: join(out, '8-home-after.png'), fullPage: true });

  // Quick flips: the middle spread never settles, so it must come from the stillest moment of its pause.
  await page.getByRole('button', { name: 'Scan a binder' }).click();
  await page.locator('input[type=text]').fill('Quick Flips');
  await page.setInputFiles('[data-testid=video-input]', fastPath);
  await page.getByRole('button', { name: 'Process video' }).waitFor({ timeout: 20000 });
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Process video' }).click();
  await page.getByText('Review “Quick Flips”').waitFor({ timeout: 120000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, '9-quick-flips.png'), fullPage: true });
  const fastSpreads = await page.locator('strong', { hasText: /^Spread \d+$/ }).count();
  const fastTiles: string[] = await page.locator('.tile').evaluateAll((els: Element[]) => els.map((e) => e.querySelector('.name')?.textContent ?? ''));
  const fastRight = fastTiles.filter((n, i) => n === expected[i]).length;
  check(fastSpreads === 3 && fastRight >= 52, `quick flips: ${fastSpreads} spreads (expected 3), ${fastRight}/${fastTiles.length} pockets right`);
  await page.getByRole('button', { name: /Home|Discard|Cancel/ }).first().click().catch(() => {});

  const uploadRun = async (name: string, path: string) => {
    await page.getByRole('button', { name: 'Scan a binder' }).click();
    await page.locator('input[type=text]').fill(name);
    await page.setInputFiles('[data-testid=video-input]', path);
    await page.getByRole('button', { name: 'Process video' }).waitFor({ timeout: 20000 });
    await page.waitForTimeout(500);
    await page.evaluate(() => ((window as any).__seeks.n = 0));
    await page.getByRole('button', { name: 'Process video' }).click();
  };
  const reviewed = async () => {
    const spreads = await page.locator('strong', { hasText: /^Spread \d+$/ }).count();
    const names: string[] = await page.locator('.tile').evaluateAll((els: Element[]) => els.map((e) => e.querySelector('.name')?.textContent ?? ''));
    return { spreads, right: names.filter((n, i) => n === expected[i]).length, total: names.length };
  };

  // Pause & adjust in the middle of an uploaded video: drag a corner, continue, and the run finishes normally.
  await uploadRun('Paused Run', videoPath);
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: 'Pause & adjust' }).click();
  await page.getByRole('button', { name: 'Continue' }).waitFor();
  const seeksAtPause = await page.evaluate(() => (window as any).__seeks.n);
  await page.waitForTimeout(1500);
  const seeksPaused = (await page.evaluate(() => (window as any).__seeks.n)) - seeksAtPause;
  const box = (await page.locator('circle.handle').first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 3, box.y + box.height / 2 + 2, { steps: 4 });
  await page.mouse.up();
  await page.screenshot({ path: join(out, '10-upload-paused.png') });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Review “Paused Run”').waitFor({ timeout: 120000 });
  const paused = await reviewed();
  check(seeksPaused <= 1 && paused.spreads === 3 && paused.right >= 52, `pause & adjust mid-upload: video held while paused (${seeksPaused} seeks), then ${paused.spreads} spreads, ${paused.right}/${paused.total} pockets right`);
  await page.getByRole('button', { name: /Discard/ }).click();

  // Safari sometimes drops a seek: the run asks again and carries on.
  await uploadRun('Dropped Seek', videoPath);
  await page.evaluate(() => ((window as any).__seeks.drop = [40]));
  await page.getByText('Review “Dropped Seek”').waitFor({ timeout: 120000 });
  const dropped = await reviewed();
  check(dropped.spreads === 3 && dropped.right >= 52, `a dropped seek is retried: ${dropped.spreads} spreads, ${dropped.right}/${dropped.total} pockets right`);
  await page.getByRole('button', { name: /Discard/ }).click();

  // A video that stops responding part-way: the scan says so and keeps what it captured.
  await uploadRun('Dead Video', videoPath);
  await page.evaluate(() => ((window as any).__seeks = { n: (window as any).__seeks.n, drop: [], deadFrom: 70 }));
  await page.getByText('The scan stopped early').waitFor({ timeout: 60000 });
  const message = await page.locator('.notice.error').textContent();
  await page.screenshot({ path: join(out, '12-stopped-early.png') });
  await page.getByRole('button', { name: /^Review \d+ spread/ }).click();
  await page.getByText('Review “Dead Video”').waitFor({ timeout: 10000 });
  const dead = await reviewed();
  check(dead.spreads >= 1 && /stopped responding/.test(message ?? ''), `video stops responding: "${message}"; ${dead.spreads} spread(s) kept for review`);
  await page.evaluate(() => ((window as any).__seeks = { n: 0, drop: [], deadFrom: Infinity }));
  await page.getByRole('button', { name: /Discard/ }).click();
} catch (e) {
  failed = true;
  console.error(e);
  await page.screenshot({ path: join(out, 'error.png'), fullPage: true }).catch(() => {});
} finally {
  const problems = logs.filter((l) => /error/i.test(l));
  if (problems.length) console.log('browser console:\n  ' + problems.join('\n  '));
  await browser.close();
}

// ---- Opening a portrait video on a browser where play() never settles (seen on an iPhone):
// the app must still get to the outline screen, with the one-upright-page layout.
const portraitPath = join(out, 'portrait.webm');
await new Promise<void>((resolve, reject) => {
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-i', videoPath, '-vf', 'transpose=1', '-t', '3', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', portraitPath]);
  ff.on('error', reject);
  ff.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
});
{
  const b2 = await chromium.launch();
  const p2 = await b2.newPage({ viewport: { width: 390, height: 844 } });
  await p2.addInitScript(() => {
    HTMLMediaElement.prototype.play = function () {
      return new Promise(() => {}); // never settles
    };
  });
  try {
    await p2.goto('http://localhost:4173/?db=test-data');
    await p2.getByRole('button', { name: 'Scan a binder' }).click({ timeout: 20000 });
    const t0 = Date.now();
    await p2.setInputFiles('[data-testid=video-input]', portraitPath);
    await p2.getByRole('button', { name: 'Process video' }).waitFor({ timeout: 15000 });
    const onePage = await p2.getByRole('button', { name: 'One page' }).getAttribute('class');
    check(true, `video opened in ${((Date.now() - t0) / 1000).toFixed(1)} s although play() never settles`);
    check(onePage === 'on', `portrait video defaults to one upright page (${onePage === 'on' ? 'yes' : 'no'})`);
    await p2.screenshot({ path: join(out, '11-portrait-open.png') });
  } catch (e) {
    failed = true;
    console.error('portrait/hanging-play check failed:', e);
    await p2.screenshot({ path: join(out, 'error-portrait.png') }).catch(() => {});
  } finally {
    await b2.close();
  }
}

// ---- Live camera: Snap, Pause & adjust, Continue, keyboard snap.
// Chromium plays a video file as the camera: spread 1 for 11 s, then spread 2.
const camPath = join(out, 'camera.y4m');
await new Promise<void>((resolve, reject) => {
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', '10', '-i', '-', '-pix_fmt', 'yuv420p', '-f', 'yuv4mpegpipe', camPath]);
  ff.on('error', reject);
  ff.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  for (let i = 0; i < 110; i++) ff.stdin.write(rgb(still[0][i % 3]));
  for (let i = 0; i < 110; i++) ff.stdin.write(rgb(still[1][i % 3]));
  ff.stdin.end();
});
const camBrowser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${camPath}`] });
const cam = await camBrowser.newPage({ viewport: { width: 390, height: 844 } });
const camLogs: string[] = [];
cam.on('pageerror', (e: Error) => camLogs.push(`pageerror: ${e.message}`));
try {
  await cam.goto('http://localhost:4173/?db=test-data');
  await cam.evaluate(async (pages: unknown) => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('keyval-store');
      req.onupgradeneeded = () => req.result.createObjectStore('keyval');
      req.onsuccess = () => {
        const tx = req.result.transaction('keyval', 'readwrite');
        tx.objectStore('keyval').put({ calibration: { pages, rows: 3, cols: 3 }, rotation: 0, frameW: 1280, frameH: 720 }, 'calibration-v1');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
    });
  }, SCENE_PAGES);
  await cam.reload();
  await cam.getByRole('button', { name: 'Scan a binder' }).click({ timeout: 20000 });
  await cam.locator('input[type=text]').fill('Camera binder');
  await cam.getByRole('button', { name: 'Use live camera' }).click();
  const t0 = Date.now();
  await cam.getByRole('button', { name: 'When I tap Snap' }).click({ timeout: 20000 });
  await cam.getByRole('button', { name: 'Start run' }).click();
  await cam.waitForTimeout(Math.max(0, 3000 - (Date.now() - t0)));
  await cam.getByRole('button', { name: 'Snap page' }).click();
  await cam.getByText('· 1 spread').waitFor({ timeout: 20000 });
  check(true, 'Snap page captured spread 1 from the live camera');
  await cam.getByRole('button', { name: 'Pause & adjust' }).click();
  await cam.getByRole('button', { name: 'Continue' }).waitFor();
  const handles = await cam.locator('circle.handle').count();
  check(handles === 8, `paused: outline is editable (${handles} corner handles)`);
  await cam.screenshot({ path: join(out, '9-camera-paused.png') });
  await cam.getByRole('button', { name: 'Continue' }).click();
  await cam.getByRole('button', { name: 'Snap page' }).waitFor();
  await cam.waitForTimeout(Math.max(0, 14500 - (Date.now() - t0)));
  await cam.keyboard.press('Space'); // a Bluetooth page-turner sends keys like this
  await cam.getByText('· 2 spreads').waitFor({ timeout: 20000 });
  check(true, 'Space key captured spread 2');
  await cam.getByRole('button', { name: 'Finish' }).click();
  await cam.getByText('Review “Camera binder”').waitFor({ timeout: 60000 });
  const camSpreads = await cam.locator('strong', { hasText: /^Spread \d+$/ }).count();
  const camTiles: string[] = await cam.locator('.tile .name').allTextContents();
  const want = spreadIds.slice(0, 2).flatMap((ids) => ids.map((id) => (id >= 0 ? `Synthetic Card ${String(id).padStart(3, '0')}` : 'Empty')));
  const camRight = camTiles.filter((n, i) => n === want[i]).length;
  check(camSpreads === 2 && camRight >= 34, `camera run: ${camSpreads} spreads, ${camRight}/36 pockets right`);
  await cam.screenshot({ path: join(out, '10-camera-review.png') });
} catch (e) {
  failed = true;
  console.error(e);
  await cam.screenshot({ path: join(out, 'error-camera.png'), fullPage: true }).catch(() => {});
} finally {
  if (camLogs.length) console.log('camera browser errors:\n  ' + camLogs.join('\n  '));
  await camBrowser.close();
  server.close();
  rmSync(camPath, { force: true }); // ~300 MB of raw video
}
console.log(failed ? 'E2E FAILED' : 'E2E PASSED');
process.exit(failed ? 1 : 0);
