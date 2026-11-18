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
import { strFromU8, unzipSync } from 'fflate';
import sharp from 'sharp';

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
// Photos of the three spreads, as JPEGs from the Camera app would be.
const photoPaths = await Promise.all(
  [0, 1, 2].map(async (s) => {
    const p = join(out, `photo-${s + 1}.jpg`);
    const img = still[s][1];
    await sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), { raw: { width: img.width, height: img.height, channels: 4 } }).jpeg({ quality: 92 }).toFile(p);
    return p;
  }),
);
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
  await page.getByRole('button', { name: 'Scan cards' }).waitFor({ timeout: 20000 });
  await page.screenshot({ path: join(out, '1-home.png') });
  await page.getByRole('button', { name: 'Scan cards' }).click();
  // No collections yet: straight to naming a new one.
  await page.getByLabel('New collection name').fill('Trade Binder');
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
  // The card-by-card check opens by itself after a scan; look at the pages first.
  await page.getByRole('heading', { name: /^Card 1 of \d+$/ }).waitFor({ timeout: 10000 });
  check(true, `card-by-card check opened after the scan (${await page.getByRole('heading', { name: /^Card 1 of \d+$/ }).textContent()})`);
  await page.screenshot({ path: join(out, '5-check.png') });
  await page.getByRole('button', { name: '‹ Pages' }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, '5-review.png'), fullPage: true });

  const spreadCount = await page.getByTestId('spread').count();
  check(spreadCount === 3, `3 spreads captured (got ${spreadCount}); the hand pass-over was not counted as a new spread`);
  const tiles: { cls: string; name: string }[] = await page.locator('.tile').evaluateAll((els: Element[]) => els.map((e) => ({ cls: e.className, name: e.querySelector('.name')?.textContent ?? '' })));
  const expected = spreadIds.flatMap((ids) => ids.map((id) => (id >= 0 ? `Synthetic Card ${String(id).padStart(3, '0')}` : 'Empty')));
  let correct = 0;
  tiles.forEach((t, i) => { if (t.name === expected[i]) correct++; else console.log(`  tile ${i}: expected ${expected[i]}, got "${t.name}" (${t.cls})`); });
  check(tiles.length === 54 && correct >= 52, `pockets identified: ${correct}/${tiles.length}`);
  const expectedTotal = spreadIds.flat().filter((id) => id >= 0).reduce((t, id) => t + (file.cards[id][6] as number), 0);
  const shownTotal = await page.locator('.big-number').first().textContent();
  console.log(`  total shown ${shownTotal}, expected $${expectedTotal.toFixed(2)} if all correct`);

  // Review photos are cut straight from the frame (not the old 146-px thumbnails), as compact JPEG files.
  // (Tiles further down load as they're scrolled to.)
  await page.waitForFunction(() => { const i = document.querySelector('.tile img') as HTMLImageElement | null; return !!i && i.complete; });
  const photo = await page.locator('.tile img').first().evaluate((img: HTMLImageElement) => ({ w: img.naturalWidth, url: img.src.slice(0, 5) }));
  check(photo.w > 146 && photo.url === 'blob:', `review photos cut from the frame: ${photo.w} px wide (was 146), ${photo.url} URLs`);
  // Diagnostics: the captured photos and readings, as a zip.
  await page.getByRole('button', { name: 'Scan actions' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Share scan diagnostics' }).click()]);
  await page.keyboard.press('Escape');
  const zipPath = join(out, 'diagnostics.zip');
  await download.saveAs(zipPath);
  const zipped = unzipSync(readFileSync(zipPath));
  const manifest = JSON.parse(strFromU8(zipped['manifest.json']));
  const photos = Object.keys(zipped).filter((n) => n.endsWith('.jpg'));
  check(
    photos.length >= 3 && manifest.readings.length >= 3 && manifest.info.video === '1280x720' && manifest.frames.every((f: { focus: number[] }) => f.focus.length === 2),
    `diagnostics zip: ${photos.length} photos, ${manifest.readings.length} readings, video ${manifest.info.video}, focus per page recorded`,
  );

  // Check cards one by one: browse the options, search a name, save and continue, go back.
  await page.getByRole('button', { name: /^Check cards/ }).click();
  const heading = page.getByRole('heading', { name: /^Card \d+ of \d+$/ });
  const optionName = () => page.locator('.cmp-table tbody tr').first().locator('td').nth(1).textContent();
  const first = await optionName();
  await page.getByRole('button', { name: 'Next option' }).click();
  const second = await optionName();
  await page.getByRole('button', { name: 'Previous option' }).click();
  check(first === expected[0] && second !== first && (await optionName()) === first, `swiping options: "${first}" -> "${second}" -> back`);
  await page.screenshot({ path: join(out, '6-check-card.png') });
  await page.getByRole('button', { name: 'Save + continue' }).click();
  const at2 = await heading.textContent();
  // Card 2: search its name (as if the app had missed it) and pick it.
  await page.getByLabel('Search card name').fill(expected[1].slice(0, -1));
  await page.locator('.check-results li', { hasText: expected[1] }).click();
  const picked = await optionName();
  await page.getByRole('button', { name: 'Save + continue' }).click();
  const at3 = await heading.textContent();
  await page.getByRole('button', { name: '‹ Back' }).click();
  const back = await heading.textContent();
  check(/^Card 2 of/.test(at2 ?? '') && picked === expected[1] && /^Card 3 of/.test(at3 ?? '') && /^Card 2 of/.test(back ?? ''), `save + continue / search / back: ${at2} -> picked "${picked}" -> ${at3} -> back to ${back}`);
  await page.getByRole('button', { name: '‹ Pages' }).click();
  const ticks = await page.locator('.tile .name', { hasText: '✓' }).count();
  check(ticks === 2 && (await page.getByRole('button', { name: /^Check cards \(2\// }).count()) === 1, `checked cards marked on the pages (${ticks}) and counted`);
  await page.getByRole('button', { name: /^(Save now|Save collection)$/ }).click();
  await page.getByRole('button', { name: 'Collection actions' }).waitFor({ timeout: 10000 });
  await page.screenshot({ path: join(out, '7-binder-gallery.png'), fullPage: true });
  const identified = tiles.filter((t) => !['Empty', 'Not identified', 'Check', '—'].includes(t.name) && !t.name.endsWith('?')).length;
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
  // Tapping a card opens its detail screen over the list; Back returns to the list as it was.
  await listRows.first().locator('.card-row').click();
  const detailName = await page.getByRole('dialog').getByRole('heading', { level: 1 }).textContent();
  const detailPrice = await page.getByRole('dialog').getByText('Market price').count();
  await page.getByRole('dialog').getByRole('button', { name: 'Back' }).click();
  const stillSearched = await page.getByTestId('cards-summary').textContent();
  check(detailName === someName && detailPrice === 1 && stillSearched === summary, `card detail opens from the list (${detailName}) and Back keeps the search (${stillSearched})`);
  // Quantity is set on the card's detail screen, saved, and counted in the collection's total and lists.
  const money = (t: string | null) => Number((t ?? '').replace(/[^0-9.]/g, ''));
  const near = (a: number, b: number) => Math.abs(a - b) <= (Math.max(a, b) >= 1000 ? 1.01 : 0.011);
  const storedQtys = () =>
    page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open('keyval-store'); r.onsuccess = () => resolve(r.result); });
      const col = await new Promise<{ binders: { cards: { qty?: number }[] }[] }>((resolve) => { const r = db.transaction('keyval').objectStore('keyval').get('collection-v1'); r.onsuccess = () => resolve(r.result); });
      return col.binders.flatMap((b) => b.cards).filter((c) => c.qty != null).map((c) => c.qty);
    });
  const heroTotal = page.locator('.hero .money-l');
  const totalBefore = money(await heroTotal.textContent());
  const dialog = page.getByRole('dialog');
  await listRows.first().locator('.card-row').click();
  const each = money(await dialog.locator('.money-l').textContent());
  const decreaseOff = await dialog.getByRole('button', { name: 'Decrease quantity' }).isDisabled();
  await dialog.getByRole('button', { name: 'Increase quantity' }).click();
  await dialog.getByRole('button', { name: 'Increase quantity' }).click();
  const qtyShown = await dialog.getByTestId('quantity').textContent();
  const holding = money(await dialog.getByTestId('holding-value').locator('.num').textContent());
  await dialog.getByRole('button', { name: 'Back' }).click();
  const totalAfter = money(await heroTotal.textContent());
  const rowText = (await listRows.first().textContent()) ?? '';
  const rowValue = money(await listRows.first().locator('.price').textContent());
  const qtySummary = (await page.getByTestId('cards-summary').textContent()) ?? '';
  await page.waitForTimeout(300);
  const saved3 = await storedQtys();
  check(
    decreaseOff && qtyShown === '3' && near(holding, 3 * each) && near(totalAfter, totalBefore + 2 * each) && rowText.includes('×3') && near(rowValue, 3 * each) && near(money(qtySummary.split('·').pop() ?? ''), 3 * each) && saved3.join() === '3',
    `quantity 1 -> ${qtyShown} on the detail screen: each ${each}, holding ${holding}; collection ${totalBefore} -> ${totalAfter}; row "${rowText.slice(0, 40)}…" ${rowValue}; "${qtySummary}"; stored ${JSON.stringify(saved3)}`,
  );
  // Back to one copy: the total returns and nothing extra is stored.
  await listRows.first().locator('.card-row').click();
  await dialog.getByRole('button', { name: 'Decrease quantity' }).click();
  await dialog.getByRole('button', { name: 'Decrease quantity' }).click();
  const qtyOne = await dialog.getByTestId('quantity').textContent();
  const noHolding = await dialog.getByTestId('holding-value').count();
  await dialog.getByRole('button', { name: 'Back' }).click();
  const totalAgain = money(await heroTotal.textContent());
  await page.waitForTimeout(300);
  const saved1 = await storedQtys();
  check(qtyOne === '1' && noHolding === 0 && near(totalAgain, totalBefore) && saved1.length === 0, `quantity back to ${qtyOne}: collection ${totalAgain} (was ${totalBefore}); stored quantities ${JSON.stringify(saved1)}`);
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  // "Do I own…?" from the home screen.
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('heading', { name: 'Search' }).waitFor();
  await page.getByLabel('Search cards').fill(someName.replace('Synthetic ', ''));
  const found = await page.getByTestId('cards-summary').textContent();
  check(/^1 match/.test(found ?? ''), `home search finds it in the collection: ${found}`);
  await page.screenshot({ path: join(out, '8-search.png'), fullPage: true });
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await page.screenshot({ path: join(out, '8-home-after.png'), fullPage: true });

  // With a collection saved, the setup screen offers it in a list, and Create new collection for a new one.
  const newCollection = async (name: string) => {
    await page.getByRole('button', { name: 'Scan cards' }).click();
    await page.getByRole('button', { name: '+ Create new collection' }).click();
    await page.getByLabel('New collection name').fill(name);
  };
  await page.getByRole('button', { name: 'Scan cards' }).click();
  const offered = await page.getByLabel('Add to collection').inputValue();
  await page.screenshot({ path: join(out, '2-setup-existing.png') });
  await page.getByRole('button', { name: '+ Create new collection' }).click();
  await page.getByLabel('New collection name').fill('trade binder');
  const sameName = await page.getByText('You already have a collection called “Trade Binder”.').count();
  const blocked = await page.getByRole('button', { name: 'Upload photos (one per page)' }).isDisabled();
  await page.screenshot({ path: join(out, '2-setup-taken.png') });
  await page.getByRole('button', { name: 'Add to it instead' }).click();
  const backTo = await page.getByLabel('Add to collection').inputValue();
  check(offered === 'Trade Binder' && sameName === 1 && blocked && backTo === 'Trade Binder', `setup offers the saved collection (${offered}); a new one can't reuse its name (blocked: ${blocked}) and "Add to it instead" picks it`);
  await page.getByRole('button', { name: '‹ Back' }).click();

  // Quick flips: the middle spread never settles, so it must come from the stillest moment of its pause.
  await newCollection('Quick Flips');
  await page.setInputFiles('[data-testid=video-input]', fastPath);
  await page.getByRole('button', { name: 'Process video' }).waitFor({ timeout: 20000 });
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Process video' }).click();
  await page.getByText('Review “Quick Flips”').waitFor({ timeout: 120000 });
  await page.getByRole('button', { name: '‹ Pages' }).click({ timeout: 10000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, '9-quick-flips.png'), fullPage: true });
  const fastSpreads = await page.getByTestId('spread').count();
  const fastTiles: string[] = await page.locator('.tile').evaluateAll((els: Element[]) => els.map((e) => e.querySelector('.name')?.textContent ?? ''));
  const fastRight = fastTiles.filter((n, i) => n === expected[i]).length;
  check(fastSpreads === 3 && fastRight >= 52, `quick flips: ${fastSpreads} spreads (expected 3), ${fastRight}/${fastTiles.length} pockets right`);
  await page.getByRole('button', { name: 'Scan actions' }).click().catch(() => {});
  await page.getByRole('button', { name: 'Discard scan' }).click().catch(() => {});

  const uploadRun = async (name: string, path: string) => {
    await newCollection(name);
    await page.setInputFiles('[data-testid=video-input]', path);
    await page.getByRole('button', { name: 'Process video' }).waitFor({ timeout: 20000 });
    await page.waitForTimeout(500);
    await page.evaluate(() => ((window as any).__seeks.n = 0));
    await page.getByRole('button', { name: 'Process video' }).click();
  };
  const reviewed = async () => {
    // Close the card-by-card check that opens after a scan, to read the pages.
    const pages = page.getByRole('button', { name: '‹ Pages' });
    if (await pages.count()) await pages.click();
    const spreads = await page.getByTestId('spread').count();
    const names: string[] = await page.locator('.tile').evaluateAll((els: Element[]) => els.map((e) => (e.querySelector('.name')?.textContent ?? '').replace(/^✓ /, '')));
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

  // Autosave: check 5 cards, then reload the page (as if the app crashed) and resume from the home screen.
  const checkHeading = page.getByRole('heading', { name: /^Card \d+ of \d+$/ });
  await checkHeading.waitFor({ timeout: 10000 });
  const toCheck = Number((await checkHeading.textContent())?.match(/of (\d+)/)?.[1]);
  for (let i = 0; i < 5; i++) await page.getByRole('button', { name: 'Save + continue' }).click();
  await page.waitForTimeout(1000);
  await page.reload();
  const banner = page.getByTestId('resume');
  await banner.waitFor({ timeout: 20000 });
  const bannerText = (await banner.textContent()) ?? '';
  await page.screenshot({ path: join(out, '10-resume-offer.png') });
  await banner.getByRole('button', { name: 'Resume' }).click();
  await checkHeading.waitFor({ timeout: 10000 });
  const resumedAt = await checkHeading.textContent();
  const yours = page.locator('.check-compare img[alt="Your card"]').first();
  await page.waitForFunction(() => { const i = document.querySelector('img[alt="Your card"]') as HTMLImageElement | null; return !!i && i.complete && i.naturalWidth > 0; }, null, { timeout: 5000 }).catch(() => {});
  const resumedImg = await yours.evaluate((img: HTMLImageElement) => ({ w: img.naturalWidth, src: img.src.slice(0, 5) })).catch((e: Error) => ({ w: 0, src: e.message.slice(0, 80) }));
  const resumedPhoto = resumedImg.w > 0 && resumedImg.src === 'blob:';
  if (!resumedPhoto) console.log('  resumed photo:', resumedImg);
  check(
    /Paused Run/.test(bannerText) && /5 checked/.test(bannerText) && resumedAt === `Card 6 of ${toCheck}` && resumedPhoto,
    `autosave: after a reload the home screen offers "${bannerText.replace(/\s+/g, ' ').trim()}"; Resume opens ${resumedAt} with its photo`,
  );
  const paused = await reviewed();
  const ticked = await page.locator('.tile .name', { hasText: '✓' }).count();
  check(seeksPaused <= 1 && paused.spreads === 3 && paused.right >= 52, `pause & adjust mid-upload: video held while paused (${seeksPaused} seeks), then ${paused.spreads} spreads, ${paused.right}/${paused.total} pockets right`);
  check(ticked === 5, `resumed scan keeps the 5 checked cards (${ticked} ticked)`);
  await page.getByRole('button', { name: 'Scan actions' }).click();
  await page.getByRole('button', { name: 'Discard scan' }).click();
  await page.getByRole('button', { name: 'Scan cards' }).waitFor();
  check((await page.getByTestId('resume').count()) === 0, 'discarding the scan forgets the autosave');

  // Safari sometimes drops a seek: the run asks again and carries on.
  await uploadRun('Dropped Seek', videoPath);
  await page.evaluate(() => ((window as any).__seeks.drop = [40]));
  await page.getByText('Review “Dropped Seek”').waitFor({ timeout: 120000 });
  const dropped = await reviewed();
  check(dropped.spreads === 3 && dropped.right >= 52, `a dropped seek is retried: ${dropped.spreads} spreads, ${dropped.right}/${dropped.total} pockets right`);
  await page.getByRole('button', { name: 'Scan actions' }).click();
  await page.getByRole('button', { name: 'Discard scan' }).click();

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
  await page.getByRole('button', { name: 'Scan actions' }).click();
  await page.getByRole('button', { name: 'Discard scan' }).click();

  // Photos (two of each spread): the outline set at the start is used for the whole batch, with no stops,
  // until Pause & adjust, which stops on one photo; Continue carries on to the end.
  await newCollection('Photo Binder');
  await page.setInputFiles('[data-testid=photo-input]', photoPaths.flatMap((p) => [p, p]));
  await page.getByRole('button', { name: 'Read 6 photos' }).waitFor({ timeout: 20000 });
  await page.screenshot({ path: join(out, '13-photos-lineup.png') });
  await page.getByRole('button', { name: 'Read 6 photos' }).click();
  await page.locator('.status-pill', { hasText: /Photo [2-5] of 6/ }).waitFor({ timeout: 30000 });
  const onScreen = Number((await page.locator('.status-pill').textContent())?.match(/Photo (\d+) of/)?.[1]);
  const tapped = Date.now();
  await page.getByRole('button', { name: 'Pause & adjust' }).click();
  const stoppedAt = page.getByRole('heading', { name: /^Photo \d of 6$/ });
  await stoppedAt.waitFor({ timeout: 30000 });
  const latency = Date.now() - tapped;
  const stop = Number((await stoppedAt.textContent())?.match(/Photo (\d)/)?.[1]);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Review “Photo Binder”').waitFor({ timeout: 120000 });
  const fromPhotos = await reviewed();
  check(
    stop <= onScreen + 1 && fromPhotos.spreads === 3 && fromPhotos.right >= 52,
    `photo batch: Pause & adjust stopped on photo ${stop} (photo ${onScreen} was on screen; ${latency} ms), that photo was read again, then ${fromPhotos.spreads} spreads, ${fromPhotos.right}/${fromPhotos.total} pockets right`,
  );
  await page.getByRole('button', { name: 'Scan actions' }).click();
  await page.getByRole('button', { name: 'Discard scan' }).click();

  // Scanning more cards into a saved collection adds them after its pages.
  const extraIds = Array.from({ length: 18 }, (_, i) => 250 + i);
  const extraPath = join(out, 'photo-4.jpg');
  {
    const img = renderSpread(extraIds.map((id) => cards[id]), { width: W, height: H, seed: 103, noiseSeed: 600, noise: 2.5, blur: true, jitter: 0.012 }).frame;
    await sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), { raw: { width: img.width, height: img.height, channels: 4 } }).jpeg({ quality: 92 }).toFile(extraPath);
  }
  await page.getByRole('button', { name: 'Scan cards' }).click();
  const picker = page.getByLabel('Add to collection');
  await picker.selectOption('Trade Binder');
  const had = Number((await picker.locator('option:checked').textContent())?.match(/\((\d+) card/)?.[1]);
  await page.setInputFiles('[data-testid=photo-input]', extraPath);
  await page.getByRole('button', { name: 'Read 1 photo' }).click({ timeout: 20000 });
  await page.getByText('Review “Trade Binder”').waitFor({ timeout: 120000 });
  // Fix one card in the check (pick its next option), so the scan report has a change in it.
  await page.getByRole('heading', { name: /^Card 1 of \d+$/ }).waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'Next option' }).click();
  await page.getByRole('button', { name: 'Save + continue' }).click();
  await reviewed();
  await page.getByRole('button', { name: /^(Save now|Save collection)$/ }).click();
  await page.getByRole('button', { name: 'Collection actions' }).waitFor({ timeout: 10000 });
  const nowHas = Number((await page.getByTestId('cards-summary').textContent())?.match(/^(\d+) card/)?.[1]);
  check(had === 53 && nowHas >= had + 16 && nowHas <= had + 18, `adding a scan to a saved collection: ${had} cards + 18 new -> ${nowHas}`);
  // The scan report: both scans of the collection, what the app read against what was saved, with photos.
  await page.getByRole('button', { name: 'Collection actions' }).click();
  const reportRow = page.getByText(/^Scan report:/);
  await reportRow.waitFor({ timeout: 10000 });
  const reportLabel = (await reportRow.textContent()) ?? '';
  const [reportDl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Share scan report' }).click()]);
  const reportZip = unzipSync(readFileSync(await reportDl.path()));
  const report = JSON.parse(strFromU8(reportZip['report.json']));
  const rcards = report.scans.flatMap((sc: { cards: unknown[] }) => sc.cards) as { photo?: string; changed: boolean; app: { card: { name: string } | null }; saved: { name: string } | null; top: unknown[]; page: number }[];
  const fixed = rcards.filter((c) => c.changed);
  const withPhotos = rcards.filter((c) => c.photo && reportZip[c.photo]).length;
  const secondScanPages = report.scans[1]?.cards.map((c: { page: number }) => c.page) ?? [];
  check(
    report.scans.length === 2 && rcards.length === 72 && fixed.length === 1 && fixed[0].app.card?.name !== fixed[0].saved?.name && withPhotos === 72 && Math.min(...secondScanPages) === 7 && /1 fixed by you · 2 scans/.test(reportLabel),
    `scan report: "${reportLabel}"; ${report.scans.length} scans, ${rcards.length} pockets, ${withPhotos} photos, fixed: ${fixed.map((c) => `${c.app.card?.name} -> ${c.saved?.name}`).join(', ')}; added pages start at ${Math.min(...secondScanPages)}`,
  );
  // CSV export (the share sheet on a phone; a download here).
  const [csvDl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()]);
  const csv = readFileSync(await csvDl.path(), 'utf8').split('\n');
  check(csv[0].includes(',Finish,Quantity,Price USD,Total USD,') && csv[0].includes(',Collection,Page,Slot,') && csv.length === nowHas + 1, `CSV export: ${csv.length - 1} rows, header "${csv[0].slice(0, 60)}…"`);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Collections', exact: true }).click();

  // Delete a saved collection from its menu (the confirm dialog is accepted).
  await page.getByRole('button', { name: /^Trade Binder:/ }).click();
  await page.getByRole('button', { name: 'Collection actions' }).click();
  await page.getByRole('button', { name: 'Delete collection' }).click();
  await page.getByTestId('portfolio-total').waitFor();
  await page.waitForTimeout(500);
  const binderRows = await page.locator('.ctile:not(.new)').count();
  const stored = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open('keyval-store'); r.onsuccess = () => resolve(r.result); });
    const keys = await new Promise<IDBValidKey[]>((resolve) => { const r = db.transaction('keyval').objectStore('keyval').getAllKeys(); r.onsuccess = () => resolve(r.result); });
    const col = await Promise.all(keys.map((k) => new Promise<unknown>((resolve) => { const r = db.transaction('keyval').objectStore('keyval').get(k); r.onsuccess = () => resolve(r.result); })));
    return JSON.stringify(col).includes('Trade Binder') || keys.some((k) => String(k).startsWith('report'));
  });
  check(binderRows === 0 && !stored, `collection deleted from its menu, with its scan report (${binderRows} left; anything still stored: ${stored})`);
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
    await p2.getByRole('button', { name: 'Scan cards' }).click({ timeout: 20000 });
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
  await cam.getByRole('button', { name: 'Scan cards' }).click({ timeout: 20000 });
  await cam.getByLabel('New collection name').fill('Camera binder');
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
  const gapHandles = await cam.locator('rect.handle.gap').count();
  check(handles === 4 && gapHandles === 1, `paused: one outline to edit (${handles} corner handles, ${gapHandles} spine handle)`);
  await cam.screenshot({ path: join(out, '9-camera-paused.png') });
  await cam.getByRole('button', { name: 'Continue' }).click();
  await cam.getByRole('button', { name: 'Snap page' }).waitFor();
  await cam.waitForTimeout(Math.max(0, 14500 - (Date.now() - t0)));
  await cam.keyboard.press('Space'); // a Bluetooth page-turner sends keys like this
  await cam.getByText('· 2 spreads').waitFor({ timeout: 20000 });
  check(true, 'Space key captured spread 2');
  // Timed shots: a countdown, then a shot with "Turn the page" (the same spread again, so it's merged as a repeat).
  await cam.getByRole('button', { name: 'Timer', exact: true }).click();
  await cam.locator('.countdown').first().waitFor({ timeout: 5000 });
  await cam.getByText('Turn the page').waitFor({ timeout: 8000 });
  check(true, 'timer mode counts down and takes a shot');
  await cam.getByRole('button', { name: 'Finish' }).click();
  await cam.getByText('Review “Camera binder”').waitFor({ timeout: 60000 });
  // The card-by-card check opens over the pages (which aren't drawn under it); close it to read them.
  await cam.getByRole('button', { name: '‹ Pages' }).click({ timeout: 10000 });
  const camSpreads = await cam.getByTestId('spread').count();
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
