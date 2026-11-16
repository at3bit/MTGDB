// Scan reports: for every pocket of a scan, what the app read (its best matches, how close they were, the
// name it read, its flags) next to what was saved after the card check, with the card's photo. Kept on the
// phone with each collection and shared from the collection's page as a zip, so recognition can be measured
// and tuned on real cards: each card the user fixed is a mistake to learn from, each one kept is a check.
import { strToU8, zipSync } from 'fflate';
import { delMany, get, getMany, set, setMany } from 'idb-keyval';
import type { CardDB, Finish } from '../core/carddb.ts';
import type { PocketStatus } from '../core/recognize.ts';
import type { PocketView, Spread } from './session.ts';

const KEY = 'report:';
const PHOTO = 'report-photo:';

declare const __BUILD__: string;

interface CardRef {
  id: string;
  name: string;
  set: string;
  cn: string;
}

export interface ReportCard {
  /** Where it's saved in the collection (1-based). */
  page: number;
  slot: number;
  /** The card's photo in the zip. */
  photo?: string;
  /** What the app chose before the card check. */
  app: { card: CardRef | null; status: PocketStatus; via: PocketView['via'] };
  /** The app's closest matches (Hamming distance of the fingerprints; lower is closer). */
  top: (CardRef & { d: number })[];
  /** What was saved (null: empty, or left out as a card seen through an empty sleeve). */
  saved: (CardRef & { finish: Finish }) | null;
  /** Looked at in the card check. */
  checked: boolean;
  /** The user changed the app's choice. */
  changed: boolean;
  flags: Record<string, unknown>;
}

export interface ReportScan {
  savedAt: string;
  build: string;
  options: { categories: number; blankFillers: boolean; englishOnly: boolean };
  pagesPerSpread: number;
  cards: ReportCard[];
}

interface ReportFile {
  v: 1;
  collection: string;
  scans: ReportScan[];
}

const ref = (db: CardDB, c: number): CardRef => {
  const i = db.info(c);
  return { id: i.id, name: i.name, set: i.set, cn: i.cn };
};

/** Builds the report of a scan as it's saved; `pageOffset` is where its pages start in the collection. */
export function buildReport(
  db: CardDB,
  spreads: Spread[],
  pagesPerSpread: number,
  pageOffset: number,
  options: ReportScan['options'],
): { scan: ReportScan; photos: [string, Blob][] } {
  const photos: [string, Blob][] = [];
  const cards: ReportCard[] = [];
  spreads.forEach((s, si) => {
    for (const p of s.pockets) {
      const first = p.firstGuess ?? { card: p.status === 'empty' || p.ghost || p.cardBack ? null : p.chosen, status: p.status, via: p.via };
      const savedCard = p.status !== 'empty' && !p.ghost && !p.cardBack ? p.chosen : null;
      const appCard = first.card;
      let photo: string | undefined;
      if (p.photo && p.pid) {
        photo = `cards/${p.pid}.jpg`;
        photos.push([p.pid, p.photo]);
      }
      cards.push({
        page: pageOffset + si * pagesPerSpread + p.page + 1,
        slot: p.slot + 1,
        photo,
        app: { card: appCard === null ? null : ref(db, appCard), status: first.status, via: first.via },
        top: p.matches.slice(0, 5).map((m) => ({ ...ref(db, m.card), d: m.d })),
        saved: savedCard === null ? null : { ...ref(db, savedCard), finish: p.finish },
        checked: !!p.approved,
        changed: !!p.firstGuess && (appCard ?? -1) !== (savedCard ?? -1),
        flags: {
          blank: p.blank,
          cardBack: p.cardBack,
          ghost: p.ghost,
          seeThrough: p.seeThrough,
          offCategory: p.offCategory,
          printingCheck: p.printingCheck,
          blurry: p.blurry,
          nameCheck: p.nameCheck,
          readName: p.readName !== undefined ? db.names[p.readName] : undefined,
          ocrText: p.ocrText,
          infoText: p.infoText,
          printingRead: p.printingRead,
          otherNameDistance: p.otherNameDistance,
          sharpness: p.sharpness,
          contrast: p.contrast,
          glare: p.glare,
        },
      });
    }
  });
  return { scan: { savedAt: new Date().toISOString(), build: typeof __BUILD__ === 'string' ? __BUILD__ : 'dev', options, pagesPerSpread, cards }, photos };
}

/** Adds a scan to the collection's report (a collection scanned in several sittings keeps every scan). */
export async function saveReport(collection: string, scan: ReportScan, photos: [string, Blob][], replace: boolean): Promise<void> {
  const old = (await get(KEY + collection)) as ReportFile | undefined;
  if (replace && old) await deleteReport(collection);
  const file: ReportFile = { v: 1, collection, scans: [...(replace ? [] : (old?.scans ?? [])), scan] };
  // Copies of the photos' bytes: a photo of a resumed scan is read back from the autosave, and Safari
  // keeps such a blob tied to the autosave's file, which is deleted once the collection is saved
  // ("The object can not be found here" when the report was shared).
  const copies: [string, Blob][] = [];
  for (const [pid, b] of photos) {
    try {
      copies.push([PHOTO + pid, new Blob([await b.arrayBuffer()], { type: b.type || 'image/jpeg' })]);
    } catch {
      /* a photo that can't be read is left out */
    }
  }
  if (copies.length) await setMany(copies);
  await set(KEY + collection, file);
}

export interface ReportSummary {
  scans: number;
  cards: number;
  checked: number;
  changed: number;
}

export async function reportSummary(collection: string): Promise<ReportSummary | null> {
  try {
    const f = (await get(KEY + collection)) as ReportFile | undefined;
    if (!f?.scans.length) return null;
    const cards = f.scans.flatMap((s) => s.cards);
    return { scans: f.scans.length, cards: cards.filter((c) => c.saved || c.app.card).length, checked: cards.filter((c) => c.checked).length, changed: cards.filter((c) => c.changed).length };
  } catch {
    return null;
  }
}

/** The report as a zip: report.json plus each card's photo. */
export async function exportReport(collection: string): Promise<File | null> {
  const f = (await get(KEY + collection)) as ReportFile | undefined;
  if (!f) return null;
  const pids = f.scans.flatMap((s) => s.cards.map((c) => c.photo?.slice(6, -4)).filter((p): p is string => !!p));
  const keys = pids.map((p) => PHOTO + p);
  // One unreadable record can fail a batch read: then read them one by one.
  const blobs = await getMany(keys).catch(() => Promise.all(keys.map((k) => get(k).catch(() => undefined))));
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {};
  let missing = 0;
  for (let i = 0; i < pids.length; i++) {
    const b = blobs[i] as Blob | undefined;
    try {
      if (b) files[`cards/${pids[i]}.jpg`] = [new Uint8Array(await b.arrayBuffer()), { level: 0 }];
      else missing++;
    } catch {
      // A photo saved before reports kept their own copies may be gone: the readings still go out.
      missing++;
    }
  }
  files['report.json'] = strToU8(JSON.stringify({ ...f, missingPhotos: missing }, null, 1));
  const zip = zipSync(files);
  const safe = collection.replace(/[^\w-]+/g, '_');
  return new File([zip.buffer as ArrayBuffer], `mtgdb-report-${safe}.zip`, { type: 'application/zip' });
}

/** Forgets a collection's report and its photos (when the collection is deleted). */
export async function deleteReport(collection: string): Promise<void> {
  const f = (await get(KEY + collection)) as ReportFile | undefined;
  if (!f) return;
  const pids = f.scans.flatMap((s) => s.cards.map((c) => c.photo?.slice(6, -4)).filter((p): p is string => !!p));
  await delMany([KEY + collection, ...pids.map((p) => PHOTO + p)]);
}
