// How long the page is blocked (long tasks) while it reads a photo batch, and how fast Pause responds.
//   npx tsx scripts/responsiveness.ts <dist dir> <photo>...
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const [dist, ...photos] = process.argv.slice(2);
const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };
const server = createServer((req, res) => {
  let p = join(dist, decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
  if (!existsSync(p) || statSync(p).isDirectory()) p = join(dist, 'index.html');
  res.writeHead(200, { 'Content-Type': types[extname(p)] ?? 'application/octet-stream' });
  res.end(readFileSync(p));
});
await new Promise<void>((r) => server.listen(4180, r));
// A phone-like CPU: 4x slower than this machine.
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
await page.addInitScript(() => {
  (window as any).__long = [];
  new PerformanceObserver((l) => l.getEntries().forEach((e) => (window as any).__long.push(e.duration))).observe({ type: 'longtask', buffered: true });
});
await page.goto('http://localhost:4180/');
await page.getByRole('button', { name: 'Scan cards' }).waitFor({ timeout: 120000 });
await page.getByRole('button', { name: 'Scan cards' }).click();
await page.getByLabel('New collection name').fill('Timing');
await page.setInputFiles('[data-testid=photo-input]', photos);
const read = page.getByRole('button', { name: /^Read \d+ photos?$/ });
await read.waitFor({ timeout: 60000 });
await page.evaluate(() => ((window as any).__long = []));
await read.click();
await page.waitForTimeout(1500);
const t0 = Date.now();
await page.getByRole('button', { name: 'Pause & adjust' }).click();
await page.getByRole('heading', { name: /^Photo \d+ of \d+$/ }).waitFor({ timeout: 120000 });
const pauseMs = Date.now() - t0;
await page.getByRole('button', { name: 'Continue' }).click();
await page.getByText('Review “Timing”').waitFor({ timeout: 600000 });
const long: number[] = await page.evaluate(() => (window as any).__long);
long.sort((a, b) => b - a);
console.log(`Pause & adjust took effect after ${pauseMs} ms; page blocked ${Math.round(long.reduce((a, b) => a + b, 0))} ms in ${long.length} long tasks, longest ${Math.round(long[0] ?? 0)} ms (4x CPU throttling)`);
await browser.close();
server.close();
