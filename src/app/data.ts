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
  // Bust the HTTP cache once a day so nightly price updates show up.
  const day = new Date().toISOString().slice(0, 10);
  const [cardsRes, fpRes] = await Promise.all([fetch(`${base}cards.json?d=${day}`), fetch(`${base}fingerprints.bin?d=${day}`)]);
  if (cardsRes.status === 404 || fpRes.status === 404) {
    throw new MissingDataError('The card database has not been built yet. Run `npm run data` (needs access to scryfall.com) and redeploy.');
  }
  if (!cardsRes.ok || !fpRes.ok) throw new Error(`Could not load card data (HTTP ${cardsRes.status}/${fpRes.status})`);
  const contentType = cardsRes.headers.get('content-type') ?? '';
  if (contentType.includes('text/html')) {
    // SPA hosts often answer missing files with index.html.
    throw new MissingDataError('The card database has not been built yet. Run `npm run data` (needs access to scryfall.com) and redeploy.');
  }
  onProgress?.('Reading card catalogue…');
  const file = (await cardsRes.json()) as CardsFile;
  const fps = decodeFingerprints(await fpRes.arrayBuffer());
  onProgress?.('Indexing names…');
  return new CardDB(file, fps);
}

/** Optional market price baselines; null when not built or out of step with the catalogue. */
export async function loadBaselines(db: CardDB): Promise<Baselines | null> {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const res = await fetch(`${dataBase()}baselines.bin?d=${day}`);
    if (!res.ok || (res.headers.get('content-type') ?? '').includes('text/html')) return null;
    const b = new Baselines(await res.arrayBuffer());
    return b.count === db.count ? b : null;
  } catch {
    return null;
  }
}

type Pending = { resolve: (p: { pockets: WirePocket[]; ms: number }) => void; reject: (e: Error) => void };

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
        this.pending.get(m.job)?.resolve({ pockets: m.pockets, ms: m.ms });
        this.pending.delete(m.job);
      } else if (m.type === 'error' && m.job !== undefined) {
        this.inFlight--;
        this.pending.get(m.job)?.reject(new Error(m.message));
        this.pending.delete(m.job);
      }
    });
    const msg: WorkerRequest = { type: 'init', fps: db.fps.slice(), count: db.count, nameOf: db.nameOf.slice() };
    this.worker.postMessage(msg);
  }

  async recognize(frames: WireImage[], calibration: Calibration) {
    await this.ready;
    const job = this.nextJob++;
    this.inFlight++;
    return new Promise<{ pockets: WirePocket[]; ms: number }>((resolve, reject) => {
      this.pending.set(job, { resolve, reject });
      const msg: WorkerRequest = { type: 'spread', job, frames, calibration };
      this.worker.postMessage(msg, frames.map((f) => f.buffer));
    });
  }

  terminate() {
    this.worker.terminate();
  }
}
