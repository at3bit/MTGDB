// Autosave of an unfinished scan, so a crash (or iOS closing the app) doesn't lose it.
//
// The scan's state (spreads, the cards checked so far, settings) is one record; each pocket's review photo
// and name crop are records of their own, written once, so saving again (every few checks) only rewrites
// the small state. Everything stays on the phone (IndexedDB).
import { delMany, get, getMany, keys, set, setMany } from 'idb-keyval';
import { photoUrl, type PocketView, type Spread } from './session.ts';

const STATE = 'draft-v1';
const PHOTO = 'draft-photo:';
const NAME = 'draft-name:';
const INFO = 'draft-info:';

export interface DraftMeta {
  binder: string;
  pagesPerSpread: number;
  runStats: { captures: number; repeats: number; reread: number };
  /** Binder colours/types (CATEGORY bits) and whether empty sleeves hold blank cards. */
  options: { categories: number; blankFillers: boolean };
  /** Add these cards to a binder already saved under this name, rather than replace it. */
  addToExisting?: boolean;
}

type DraftPocket = Omit<PocketView, 'thumbUrl' | 'photo' | 'nameCrop' | 'infoCrop' | 'query'> & { query?: number[]; hasName?: boolean; hasInfo?: boolean };

interface DraftState extends DraftMeta {
  v: 1;
  savedAt: string;
  spreads: (Omit<Spread, 'pockets'> & { pockets: DraftPocket[] })[];
}

/** Summary for the home screen's Resume offer. */
export interface DraftSummary {
  binder: string;
  savedAt: string;
  cards: number;
  checked: number;
}

/** Records already written in this session (photos never change once taken). */
const written = new Set<string>();
let saving: Promise<void> = Promise.resolve();

/** Saves the scan (queued, so saves never overlap). */
export function saveDraft(meta: DraftMeta, spreads: Spread[]): Promise<void> {
  saving = saving.then(() => write(meta, spreads)).catch((e) => console.warn('Autosave failed', e));
  return saving;
}

async function write(meta: DraftMeta, spreads: Spread[]) {
  const blobs: [string, Blob][] = [];
  const state: DraftState = {
    v: 1,
    ...meta,
    savedAt: new Date().toISOString(),
    spreads: spreads.map((s) => ({
      ...s,
      pockets: s.pockets.map((p) => {
        const { thumbUrl: _u, photo, nameCrop, infoCrop, query, ...rest } = p;
        const pid = p.pid ?? '';
        if (pid && photo && !written.has(PHOTO + pid)) blobs.push([PHOTO + pid, photo]);
        if (pid && nameCrop instanceof Blob && !written.has(NAME + pid)) blobs.push([NAME + pid, nameCrop]);
        if (pid && infoCrop && !written.has(INFO + pid)) blobs.push([INFO + pid, infoCrop]);
        return { ...rest, query: query ? Array.from(query) : undefined, hasName: nameCrop instanceof Blob, hasInfo: !!infoCrop };
      }),
    })),
  };
  if (blobs.length) await setMany(blobs);
  blobs.forEach(([k]) => written.add(k));
  await set(STATE, state);
}

export async function draftSummary(): Promise<DraftSummary | null> {
  try {
    const d = (await get(STATE)) as DraftState | undefined;
    if (!d?.spreads?.length) return null;
    const cards = d.spreads.flatMap((s) => s.pockets).filter((p) => p.status !== 'empty' && !p.ghost && !p.cardBack);
    return { binder: d.binder, savedAt: d.savedAt, cards: cards.length, checked: cards.filter((p) => p.approved).length };
  } catch {
    return null;
  }
}

/** The saved scan, with its photos back as object URLs. */
export async function loadDraft(): Promise<{ meta: DraftMeta; spreads: Spread[] } | null> {
  const d = (await get(STATE)) as DraftState | undefined;
  if (!d?.spreads?.length) return null;
  const pockets = d.spreads.flatMap((s) => s.pockets);
  const photos = await getMany(pockets.map((p) => PHOTO + (p.pid ?? '')));
  const names = await getMany(pockets.map((p) => (p.hasName ? NAME + (p.pid ?? '') : '')));
  const infos = await getMany(pockets.map((p) => (p.hasInfo ? INFO + (p.pid ?? '') : '')));
  let k = 0;
  const spreads: Spread[] = d.spreads.map((s) => ({
    ...s,
    pockets: s.pockets.map(({ hasName: _h, hasInfo: _i, query, ...p }) => {
      const photo = photos[k] as Blob | undefined;
      const name = names[k] as Blob | undefined;
      const info = infos[k] as Blob | undefined;
      k++;
      if (photo) written.add(PHOTO + p.pid);
      if (name) written.add(NAME + p.pid);
      if (info) written.add(INFO + p.pid);
      return { ...p, query: query ? Uint32Array.from(query) : undefined, photo, thumbUrl: photo ? photoUrl(photo) : '', nameCrop: name, infoCrop: info };
    }),
  }));
  const { binder, pagesPerSpread, runStats, options, addToExisting } = d;
  return { meta: { binder, pagesPerSpread, runStats, options, addToExisting }, spreads };
}

/** Forgets the saved scan (after saving the binder, or discarding); waits for a save in progress. */
export function clearDraft(): Promise<void> {
  saving = saving.then(async () => {
    written.clear();
    const all = (await keys()).filter((k) => typeof k === 'string' && (k === STATE || k.startsWith(PHOTO) || k.startsWith(NAME) || k.startsWith(INFO)));
    if (all.length) await delMany(all);
  });
  return saving;
}
