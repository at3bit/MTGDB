// UX tour of a deployed site for design audits: scans real card photos into two collections, visits every
// screen at iPhone size (390x844 @2x) and saves a screenshot of each, plus a measurement of each screen:
// WCAG contrast of every text, tap targets under 44 px, text under 12 px, controls without a name.
//
//   npx tsx scripts/ux-tour.ts [url] [outDir]
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { CATEGORY, NOT_FOR_MATCHING, type CardsFile } from '../src/core/carddb.ts';
import type { RGBAImage } from '../src/core/image.ts';
import { renderSpread, rng } from '../tests/synth.ts';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.argv[2] ?? 'https://mtgdb.vercel.app';
const out = process.argv[3] ?? join(root, 'test-results', 'ux-tour');
mkdirSync(out, { recursive: true });

// Black cards, a third of them worth $3+, like the user's first binder; photos of one page each (portrait).
const file = JSON.parse(readFileSync(join(root, 'public/data/cards.json'), 'utf8')) as CardsFile;
const r = rng(11);
const black = file.cards.map((_, i) => i).filter((i) => ((file.cards[i][11] ?? 0) & CATEGORY.B) && !NOT_FOR_MATCHING.has(file.cards[i][2]) && file.cards[i][9] !== 'w' && !/\/\//.test(file.cards[i][1]));
const valuable = black.filter((i) => (file.cards[i][6] ?? 0) >= 3);
const picks: number[] = [];
while (picks.length < 27) {
  const pool = picks.length % 3 === 0 ? valuable : black;
  const i = pool[Math.floor(r() * pool.length)];
  if (!picks.includes(i)) picks.push(i);
}
console.log('downloading card scans…');
const scans: (RGBAImage | null)[] = await Promise.all(
  picks.map(async (i) => {
    const id = file.cards[i][0];
    const res = await fetch(`https://cards.scryfall.io/normal/front/${id[0]}/${id[1]}/${id}.jpg`, { headers: { 'User-Agent': 'MTGDB-binder-scanner/0.1 (ux tour)' } });
    const { data, info } = await sharp(Buffer.from(await res.arrayBuffer())).resize(488, 680, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) };
  }),
);
// Three page photos (portrait, one page each), one sleeve left empty on the last page.
const page1 = [{ x: 0.1, y: 0.12 }, { x: 0.9, y: 0.12 }, { x: 0.9, y: 0.86 }, { x: 0.1, y: 0.86 }];
const photos: string[] = [];
for (let s = 0; s < 3; s++) {
  const cards = scans.slice(s * 9, s * 9 + 9);
  if (s === 2) cards[4] = null;
  const scene = renderSpread(cards, { width: 1512, height: 2016, seed: 40 + s, noiseSeed: 70 + s, noise: 2, blur: true, haze: 0.05, jitter: 0.008, pages: [page1 as any] });
  const p = join(out, `page-${s + 1}.jpg`);
  const f = scene.frame;
  await sharp(Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength), { raw: { width: f.width, height: f.height, channels: 4 } }).jpeg({ quality: 90 }).toFile(p);
  photos.push(p);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
// tsx keeps function names with a __name() helper, which doesn't exist inside the page.
await ctx.addInitScript({ content: 'window.__name = (f) => f;' });
const page = await ctx.newPage();
page.on('dialog', (d: any) => d.accept());
const measures: Record<string, unknown> = {};

/** Measures the screen as shown: contrast of every text, small targets and text, unnamed controls. */
async function measure(name: string) {
  measures[name] = await page.evaluate(() => {
    const lum = (c: number[]) => {
      const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const parse = (s: string) => { const m = s.match(/[\d.]+/g); return m ? m.map(Number) : [0, 0, 0, 0]; };
    const bgOf = (el: Element | null): number[] => {
      const layers: number[][] = [];
      for (let e = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        const a = c.length > 3 ? c[3] : 1;
        if (a > 0) { layers.push([c[0], c[1], c[2], a]); if (a >= 1) break; }
      }
      let out = [15, 17, 21];
      for (const l of layers.reverse()) out = out.map((v, i) => v * (1 - l[3]) + l[i] * l[3]);
      return out;
    };
    const visible = (el: Element) => { const b = el.getBoundingClientRect(); const s = getComputedStyle(el); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && b.bottom > 0 && b.top < innerHeight; };
    const texts: { text: string; fg: string; bg: string; ratio: number; need: number; size: number; weight: number }[] = [];
    const sizes: Record<string, number> = {};
    for (const el of document.querySelectorAll('body *')) {
      if (!visible(el)) continue;
      const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent!.trim()).map((n) => n.textContent!.trim()).join(' ');
      if (!own) continue;
      const s = getComputedStyle(el);
      const fgc = parse(s.color);
      const bg = bgOf(el);
      const a = fgc.length > 3 ? fgc[3] : 1;
      const fg = fgc.slice(0, 3).map((v, i) => v * a + bg[i] * (1 - a));
      const l1 = lum(fg), l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const size = parseFloat(s.fontSize), weight = Number(s.fontWeight) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      sizes[String(Math.round(size))] = (sizes[String(Math.round(size))] ?? 0) + 1;
      texts.push({ text: own.slice(0, 60), fg: s.color, bg: `rgb(${bg.map(Math.round).join(',')})`, ratio: Math.round(ratio * 100) / 100, need: large ? 3 : 4.5, size, weight });
    }
    const targets: { name: string; w: number; h: number }[] = [];
    const unnamed: string[] = [];
    for (const el of document.querySelectorAll('button, a[href], input:not([type=hidden]), select, [role=button], .tap')) {
      if (!visible(el) && !(el instanceof HTMLInputElement && el.type === 'file')) continue;
      if (el instanceof HTMLInputElement && el.type === 'file') continue;
      const b = el.getBoundingClientRect();
      const name = (el.getAttribute('aria-label') || (el as HTMLElement).innerText || (el as HTMLInputElement).placeholder || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      if (b.width < 44 || b.height < 44) targets.push({ name: name || `<${el.tagName.toLowerCase()}>`, w: Math.round(b.width), h: Math.round(b.height) });
      const labelled = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || (el as HTMLElement).innerText?.trim() || (el.id && document.querySelector(`label[for="${el.id}"]`)) || el.closest('label');
      if (!labelled) unnamed.push(`<${el.tagName.toLowerCase()}${el.className ? ` class="${el.className}"` : ''}>`);
    }
    const imgs = [...document.querySelectorAll('img')].filter(visible);
    return {
      texts: texts.length,
      contrastFails: texts.filter((t) => t.ratio < t.need),
      smallText: texts.filter((t) => t.size < 12).map((t) => `${t.text} (${t.size}px)`),
      fontSizes: sizes,
      smallTargets: targets,
      unnamed,
      imagesWithoutAlt: imgs.filter((i) => !i.getAttribute('alt')).length,
      images: imgs.length,
      headings: [...document.querySelectorAll('h1,h2,h3')].filter(visible).map((h) => `${h.tagName}: ${(h as HTMLElement).innerText.trim().slice(0, 40)}`),
      landmarks: ['main', 'nav', 'header', 'footer'].filter((t) => document.querySelector(t)),
    };
  });
}
async function shot(name: string, full = false) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: full });
  await measure(name);
  console.log(`  ${name}`);
}

try {
  await page.goto(url);
  // The outline as the user would have lined it up on these photos.
  await page.evaluate(async (pages: unknown) => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('keyval-store');
      req.onupgradeneeded = () => req.result.createObjectStore('keyval');
      req.onsuccess = () => {
        const tx = req.result.transaction('keyval', 'readwrite');
        tx.objectStore('keyval').put({ calibration: { pages, rows: 3, cols: 3 }, rotation: 0, frameW: 1512, frameH: 2016 }, 'calibration-v1');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
    });
  }, [page1]);
  await page.reload();
  await page.waitForFunction(() => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === 'Scan cards' || x.textContent === 'Scan cards'); return b && !(b as HTMLButtonElement).disabled; }, null, { timeout: 120000 });
  await shot('01-home-empty');
  await page.getByRole('button', { name: 'Scan cards' }).click();
  await page.getByLabel('New collection name').fill('Black R/UC');
  await page.getByRole('button', { name: 'Black', exact: true }).click().catch(() => {});
  await shot('02-setup-new');
  await shot('02b-setup-new-full', true);
  await page.setInputFiles('[data-testid=photo-input]', photos);
  await page.getByRole('button', { name: /^Read 3 photos$/ }).waitFor({ timeout: 30000 });
  await shot('03-outline');
  await page.getByRole('button', { name: /^Read 3 photos$/ }).click();
  await page.waitForTimeout(700);
  await shot('04-scanning');
  await page.getByText('Review “Black R/UC”').waitFor({ timeout: 180000 });
  await page.getByRole('dialog', { name: 'Check card' }).waitFor({ timeout: 10000 });
  await page.waitForTimeout(3000);
  await shot('05-check-card');
  await page.getByRole('button', { name: '‹ Pages' }).click();
  await page.getByText(/^Reading card names for/).waitFor({ state: 'detached', timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await shot('06-review-pages');
  await shot('06b-review-pages-full', true);
  // An unsure card, if any, in the check.
  const unsure = page.locator('.tile', { hasText: '?' }).first();
  if (await unsure.count()) {
    await unsure.click();
    await page.getByRole('dialog', { name: 'Check card' }).waitFor();
    await page.waitForTimeout(2500);
    await shot('07-check-unsure');
    await shot('07b-check-unsure-full', true);
    await page.getByRole('button', { name: '‹ Pages' }).click();
  }
  // Check every card, then the "all checked" screen.
  await page.getByRole('button', { name: /^Check cards/ }).click();
  for (let i = 0; i < 40; i++) {
    const save = page.getByRole('button', { name: 'Save + continue' });
    if (!(await save.count())) break;
    await save.click();
    await page.waitForTimeout(120);
  }
  await page.getByText(/^All \d+ cards checked$/).waitFor({ timeout: 10000 }).catch(() => {});
  await shot('08-all-checked');
  await page.getByRole('button', { name: /^Save collection$/ }).first().click();
  await page.getByRole('button', { name: 'Collection actions' }).waitFor({ timeout: 10000 });
  await page.waitForTimeout(2500);
  await shot('09-collection-gallery');
  await shot('09b-collection-gallery-full', true);
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await page.waitForTimeout(1500);
  await shot('10-collection-list');
  await page.getByRole('button', { name: 'Art', exact: true }).click();
  await page.waitForTimeout(2500);
  await shot('10c-collection-art');
  await page.locator('.art-tile').first().click();
  await page.waitForTimeout(3000);
  await shot('10d-card-detail');
  await shot('10e-card-detail-full', true);
  await page.getByRole('dialog').getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Gallery', exact: true }).click();
  await page.getByRole('button', { name: 'Collection actions' }).click();
  await page.waitForTimeout(500);
  await shot('10f-collection-menu');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Collections', exact: true }).click();

  await page.getByRole('button', { name: 'Scan cards' }).click();
  await shot('11-setup-existing');
  await page.getByRole('button', { name: '+ Create new collection' }).click();
  await page.getByLabel('New collection name').fill('Trade binder');
  await page.setInputFiles('[data-testid=photo-input]', [photos[2]]);
  await page.getByRole('button', { name: /^Read 1 photo$/ }).click({ timeout: 30000 });
  await page.getByText('Review “Trade binder”').waitFor({ timeout: 180000 });
  await page.getByRole('button', { name: '‹ Pages' }).click({ timeout: 10000 }).catch(() => {});
  await page.getByText(/^Reading card names for/).waitFor({ state: 'detached', timeout: 180000 }).catch(() => {});
  await page.getByRole('button', { name: /^(Save now|Save collection)$/ }).first().click();
  await page.getByRole('button', { name: 'Collection actions' }).waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await page.waitForTimeout(3000);
  await shot('12-home');
  await shot('12b-home-full', true);
  const firstName = await page.locator('.card-row .card-name').first().textContent();
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByLabel('Search cards').fill((firstName ?? '').replace(' ✦', '').slice(0, 8));
  await page.waitForTimeout(2000);
  await shot('13-search');
} catch (e) {
  console.error(e);
  await page.screenshot({ path: join(out, 'error.png'), fullPage: true }).catch(() => {});
}
writeFileSync(join(out, 'measures.json'), JSON.stringify(measures, null, 1));
await browser.close();
console.log(`wrote ${Object.keys(measures).length} screens to ${out}`);
