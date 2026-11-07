// Smoke test of a deployed site with real card scans:
//   1. picks random printings from public/data and downloads their Scryfall scans,
//   2. renders a simulated binder run (2 spreads, a page turn) as a video,
//   3. uploads it to the live site in headless Chromium and checks the review screen.
//
//   npm run smoke -- https://mtgdb.vercel.app
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import type { CardsFile } from '../src/core/carddb.ts';
import type { RGBAImage } from '../src/core/image.ts';
import { renderSpread, rng, SCENE_PAGES } from '../tests/synth.ts';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.argv[2] ?? 'https://mtgdb.vercel.app';
const out = join(root, 'test-results', 'smoke');
mkdirSync(out, { recursive: true });
const W = 1920, H = 1080, FPS = 15;

const file = JSON.parse(readFileSync(join(root, 'public/data/cards.json'), 'utf8')) as CardsFile;
const r = rng(Number(process.env.SEED ?? 7));
// Mix of random printings and ones worth $5+, like a real trade binder.
const valuable = file.cards.map((_, i) => i).filter((i) => (file.cards[i][6] ?? 0) >= 5);
const picks: number[] = [];
while (picks.length < 36) {
  const i = picks.length % 2 ? valuable[Math.floor(r() * valuable.length)] : Math.floor(r() * file.cards.length);
  if (!picks.includes(i)) picks.push(i);
}
console.log('downloading 36 card scans…');
const scans: RGBAImage[] = await Promise.all(
  picks.map(async (i) => {
    const id = file.cards[i][0];
    const res = await fetch(`https://cards.scryfall.io/normal/front/${id[0]}/${id[1]}/${id}.jpg`, { headers: { 'User-Agent': 'MTGDB-binder-scanner/0.1 (smoke test)' } });
    const { data, info } = await sharp(Buffer.from(await res.arrayBuffer())).resize(488, 680, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) };
  }),
);

console.log('rendering video…');
const still = [0, 1].map((s) => [0, 1, 2].map((v) => renderSpread(scans.slice(s * 18, s * 18 + 18), { width: W, height: H, seed: 300 + s, noiseSeed: 900 + v, noise: 3, blur: true, haze: 0.08, jitter: 0.012 }).frame));
const rgb = (img: RGBAImage) => { const o = new Uint8Array(W * H * 3); for (let i = 0, j = 0; i < img.data.length; i += 4, j += 3) { o[j] = img.data[i]; o[j + 1] = img.data[i + 1]; o[j + 2] = img.data[i + 2]; } return o; };
const frames: Uint8Array[] = [];
for (let i = 0; i < 1.6 * FPS; i++) frames.push(rgb(still[0][i % 3]));
for (let i = 0; i < 12; i++) {
  // page turn: crossfade under a passing hand
  const t = i / 11, hx = 1.1 - 1.4 * t, o = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = (y * W + x) * 4, q = (y * W + x) * 3, dx = (x / W - hx) / 0.18, dy = (y / H - 0.55) / 0.35;
    for (let c = 0; c < 3; c++) o[q + c] = dx * dx + dy * dy <= 1 ? [196, 150, 120][c] : still[0][0].data[p + c] * (1 - t) + still[1][0].data[p + c] * t;
  }
  frames.push(o);
}
for (let i = 0; i < 1.6 * FPS; i++) frames.push(rgb(still[1][i % 3]));
const videoPath = join(out, 'run.webm');
await new Promise<void>((resolve, reject) => {
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-', '-c:v', 'libvpx-vp9', '-b:v', '12M', '-deadline', 'realtime', '-cpu-used', '8', '-g', '15', videoPath]);
  ff.on('error', reject);
  ff.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  for (const f of frames) ff.stdin.write(f);
  ff.stdin.end();
});
console.log(`video: ${frames.length} frames, ${(statSync(videoPath).size / 1e6).toFixed(1)} MB`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const problems: string[] = [];
page.on('pageerror', (e: Error) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m: any) => { if (m.type() === 'error') problems.push(m.text()); });
page.on('response', (res: any) => { if (res.status() >= 400) problems.push(`${res.status()} ${res.url()}`); });
let failed = false;
try {
  const t0 = Date.now();
  await page.goto(url);
  await page.evaluate(async (pages: unknown) => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('keyval-store');
      req.onupgradeneeded = () => req.result.createObjectStore('keyval');
      req.onsuccess = () => {
        const tx = req.result.transaction('keyval', 'readwrite');
        tx.objectStore('keyval').put({ calibration: { pages, rows: 3, cols: 3 }, rotation: 0, frameW: 1920, frameH: 1080 }, 'calibration-v1');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
    });
  }, SCENE_PAGES);
  await page.reload();
  await page.waitForFunction(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Scan a binder'); return b && !(b as HTMLButtonElement).disabled; }, null, { timeout: 120000 });
  console.log(`card database loaded from ${url} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log(`  ${await page.locator('p.muted.small').last().textContent()}`);
  await page.getByRole('button', { name: 'Scan a binder' }).click();
  await page.locator('input[type=text]').fill('Smoke test');
  await page.setInputFiles('[data-testid=video-input]', videoPath);
  await page.getByRole('button', { name: 'Process video' }).click({ timeout: 30000 });
  await page.getByText('Review “Smoke test”').waitFor({ timeout: 180000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(out, 'review.png'), fullPage: true });
  const tiles: { cls: string; name: string }[] = await page.locator('.tile').evaluateAll((els: Element[]) => els.map((e) => ({ cls: e.className, name: e.querySelector('.name')?.textContent ?? '' })));
  const spreads = await page.locator('strong', { hasText: /^Spread \d+$/ }).count();
  let right = 0;
  tiles.forEach((t, i) => {
    const want = file.cards[picks[i]][1];
    if (t.name === want) right++;
    else console.log(`  pocket ${i + 1}: expected "${want}", app shows "${t.name}" (${t.cls.replace('tile ', '')})`);
  });
  const toCheck = tiles.filter((t) => /uncertain|unknown/.test(t.cls)).length;
  console.log(`spreads: ${spreads}; right card name: ${right}/${tiles.length}; flagged to check: ${toCheck}`);
  console.log(`total shown: ${await page.locator('.big-number').first().textContent()}`);
  if (spreads !== 2 || right < tiles.length - 2) failed = true;
} catch (e) {
  failed = true;
  console.error(e);
  await page.screenshot({ path: join(out, 'error.png'), fullPage: true }).catch(() => {});
}
if (problems.length) console.log('browser problems:\n  ' + [...new Set(problems)].join('\n  '));
await browser.close();
console.log(failed ? 'SMOKE FAILED' : 'SMOKE PASSED');
process.exit(failed ? 1 : 0);
