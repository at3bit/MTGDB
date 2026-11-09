// Loads the card catalogue and fingerprint index, and owns the recognizer worker.
import { CardDB, decodeFingerprints, type CardsFile } from '../core/carddb.ts';
import { Baselines } from '../core/baselines.ts';
import type { Calibration } from '../core/geometry.ts';
import type { WireImage, WirePocket, WorkerRequest, WorkerResponse } from './protocol.ts';

/** Where the data files live. `?db=some/path` overrides it (used by the end-to-end test). */
export function dataBase(): string {
  const q = new URLSearchParams(location.search).get('db');
  const base = q ?? 'data';
  return new URL(base.endsWith('/') ? base : `${base}/`, location.href).href;
}

export class MissingDataError extends Error {}

export async function loadCardDB(onProgress?: (msg: string) => void): Promise<CardDB> {
  const base = dataBase();
  onProgress?.('Downloading card catalogue…');
  const missing = () => new MissingDataError('The card database has not been built yet. Run `npm run data` (needs access to scryfall.com) and redeploy.');
  for (let attempt = 0; ; attempt++) {
    const [cards, fp] = await fetchDataFiles(base, ['cards.json', 'fingerprints.bin'], attempt > 0);
    // SPA hosts often answer missing files with index.html.
    if (cards.status === 404 || fp.status === 404 || cards.html) throw missing();
    if (!cards.buf || !fp.buf) throw new Error(`Could not load card data (HTTP ${cards.status}/${fp.status})`);
    onProgress?.('Reading card catalogue…');
    const file = JSON.parse(new TextDecoder().decode(cards.buf)) as CardsFile;
    const fps = decodeFingerprints(fp.buf);
    // Copies from different deployments (one cached, one new): fetch both again from the server.
    if ((!cards.verified || !fp.verified || fps.count !== file.cards.length) && attempt < 2) continue;
    onProgress?.('Indexing names…');
    return new CardDB(file, fps);
  }
}

/** Optional market price baselines; null when not built or out of step with the catalogue. */
export async function loadBaselines(db: CardDB): Promise<Baselines | null> {
  try {
    const [res] = await fetchDataFiles(dataBase(), ['baselines.bin'], false);
    if (!res.buf || !res.verified) return null;
    const b = new Baselines(res.buf);
    return b.count === db.count ? b : null;
  } catch {
    return null;
  }
}

/** Written at build time by scripts/data-version.ts: a content hash for each data file. */
interface DataVersion {
  built: string;
  files: Record<string, string>;
}

const VERSION_KEY = 'mtgdb.dataVersion';
const isHtml = (res: Response) => (res.headers.get('content-type') ?? '').includes('text/html');

/** This deployment's data version; the last one seen when offline; null for builds without one. */
async function fetchVersion(base: string): Promise<DataVersion | null> {
  const remembered = () => {
    try {
      return JSON.parse(localStorage.getItem(VERSION_KEY) ?? 'null') as DataVersion | null;
    } catch {
      return null;
    }
  };
  try {
    const res = await fetch(`${base}version.json`, { cache: 'no-store' });
    if (res.status === 404 || isHtml(res)) return null;
    if (!res.ok) return remembered();
    const v = (await res.json()) as DataVersion;
    if (!v || typeof v.files !== 'object') return null;
    try {
      localStorage.setItem(VERSION_KEY, JSON.stringify(v));
    } catch {
      /* private mode */
    }
    return v;
  } catch {
    return remembered();
  }
}

/** First 8 bytes of the SHA-256, in hex (as scripts/data-version.ts writes them); null where unavailable. */
async function contentHash(buf: ArrayBuffer): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(d.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

interface DataFile {
  status: number;
  html: boolean;
  buf: ArrayBuffer | null;
  /** False if the file isn't the one this deployment lists (an older copy). */
  verified: boolean;
}

/**
 * Downloads data files by content hash (`cards.json?v=<hash>`), so the phone's HTTP cache can't hand back a
 * copy from an earlier deployment, and checks each against its hash. `fresh` bypasses the HTTP cache.
 * Builds without a version.json fall back to one URL per day.
 */
async function fetchDataFiles(base: string, names: string[], fresh: boolean): Promise<DataFile[]> {
  const version = await fetchVersion(base);
  const day = new Date().toISOString().slice(0, 10);
  return Promise.all(
    names.map(async (name): Promise<DataFile> => {
      const want = version?.files[name];
      const res = await fetch(`${base}${name}?${want ? `v=${want}` : `d=${day}`}`, { cache: fresh ? 'reload' : 'default' });
      if (!res.ok || isHtml(res)) return { status: res.status, html: isHtml(res), buf: null, verified: false };
      const buf = await res.arrayBuffer();
      const got = want ? await contentHash(buf) : null;
      return { status: res.status, html: false, buf, verified: got === null || got === want };
    }),
  );
}

export interface SpreadReading {
  pockets: WirePocket[];
  ms: number;
  /** Where the pages were found in this spread. */
  calibration: Calibration;
  retried: number[];
  /** A tentative capture that read as junk (caught mid-turn); ignore it. */
  discarded?: boolean;
}

type Pending = { resolve: (p: SpreadReading) => void; reject: (e: Error) => void };

export class Recognizer {
  private worker: Worker;
  private ready: Promise<void>;
  private pending = new Map<number, Pending>();
  private nextJob = 1;
  inFlight = 0;

  constructor(db: CardDB) {
    this.worker = new Worker(new URL('./recognizer.worker.ts', import.meta.url), { type: 'module' });
    this.ready = new Promise((resolve, reject) => {
      const onMsg = (ev: MessageEvent<WorkerResponse>) => {
        if (ev.data.type === 'ready') resolve();
        else if (ev.data.type === 'error' && ev.data.job === undefined) reject(new Error(ev.data.message));
      };
      this.worker.addEventListener('message', onMsg);
    });
    this.worker.addEventListener('message', (ev: MessageEvent<WorkerResponse>) => {
      const m = ev.data;
      if (m.type === 'spread') {
        this.inFlight--;
        this.pending.get(m.job)?.resolve({ pockets: m.pockets, ms: m.ms, calibration: m.calibration, retried: m.retried, discarded: m.discarded });
        this.pending.delete(m.job);
      } else if (m.type === 'error' && m.job !== undefined) {
        this.inFlight--;
        this.pending.get(m.job)?.reject(new Error(m.message));
        this.pending.delete(m.job);
      }
    });
    const msg: WorkerRequest = { type: 'init', fps: db.fps.slice(), count: db.count, nameOf: db.nameOf.slice(), back: db.back?.slice() };
    this.worker.postMessage(msg);
  }

  /**
   * `calibration` is the user's outline; spreads with the same `runId` are tracked from one to the next.
   * A `tentative` capture comes back `discarded` if it reads as junk.
   */
  async recognize(frames: WireImage[], calibration: Calibration, runId: number, tentative = false) {
    await this.ready;
    const job = this.nextJob++;
    this.inFlight++;
    return new Promise<SpreadReading>((resolve, reject) => {
      this.pending.set(job, { resolve, reject });
      const msg: WorkerRequest = { type: 'spread', job, runId, frames, calibration, tentative };
      this.worker.postMessage(msg, frames.map((f) => f.buffer));
    });
  }

  terminate() {
    this.worker.terminate();
  }
}
