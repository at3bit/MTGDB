// Loading the card data when the phone's HTTP cache holds a copy from an earlier deployment.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFingerprints, type CardsFile } from '../src/core/carddb.ts';
import { FP_WORDS } from '../src/core/fingerprint.ts';
import { loadCardDB } from '../src/app/data.ts';

const catalogue = (n: number) => {
  const file: CardsFile = { v: 1, built: '2026-11-09', source: 'test', sets: { tst: 'Test' }, cards: [] };
  for (let i = 0; i < n; i++) file.cards.push([`id${i}`, `Card ${i}`, 'tst', String(i), 'common', 1, 1, null, null]);
  return new TextEncoder().encode(JSON.stringify(file));
};
const fingerprints = (n: number) => encodeFingerprints(new Uint32Array(n * FP_WORDS), n);
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex').slice(0, 16);

// Two deployments on the same day: Scryfall added a printing in between.
const older = { cards: catalogue(2), fps: fingerprints(2) };
const newer = { cards: catalogue(3), fps: fingerprints(3) };

/** A server on the newer deployment, behind a phone cache that still holds the older card list. */
function phone(opts: { versionFile: boolean }) {
  const requests: string[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const fresh = init?.cache === 'reload' || init?.cache === 'no-store';
    requests.push(`${url.replace('https://mtgdb.test/data/', '')}${fresh ? ' (fresh)' : ''}`);
    const bin = (b: Uint8Array) => new Response(b.slice().buffer as ArrayBuffer, { headers: { 'content-type': 'application/octet-stream' } });
    if (url.includes('version.json')) {
      if (!opts.versionFile) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify({ built: 'x', files: { 'cards.json': hash(newer.cards), 'fingerprints.bin': hash(newer.fps) } }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('cards.json')) return bin(fresh ? newer.cards : older.cards);
    if (url.includes('fingerprints.bin')) return bin(newer.fps);
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return requests;
}

describe('card data from different deployments', () => {
  beforeEach(() => vi.stubGlobal('location', { search: '', href: 'https://mtgdb.test/' }));
  afterEach(() => vi.unstubAllGlobals());

  it('re-downloads a cached card list that does not match this deployment', async () => {
    const requests = phone({ versionFile: true });
    const db = await loadCardDB();
    expect(db.count).toBe(3);
    expect(requests).toContain(`cards.json?v=${hash(newer.cards)} (fresh)`);
  });

  it('heals the old daily URLs too (no version.json)', async () => {
    phone({ versionFile: false });
    const db = await loadCardDB();
    expect(db.count).toBe(3);
  });
});
