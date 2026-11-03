// The results of one binder run, as shown in the review screen.
import { fpDistance, type Match } from '../core/fingerprint.ts';
import { DEFAULT_RECOGNIZE, type PocketStatus } from '../core/recognize.ts';
import type { CardDB, Finish } from '../core/carddb.ts';
import type { WireImage, WirePocket } from './protocol.ts';
import { imageToDataURL } from './capture.ts';

export interface PocketView {
  page: number;
  slot: number;
  status: PocketStatus;
  matches: Match[];
  otherNameDistance: number;
  thumbUrl: string;
  query?: Uint32Array;
  nameCrop?: WireImage;
  /** Chosen card (index into the CardDB), or null for empty / unidentified. */
  chosen: number | null;
  finish: Finish;
  /** How the current choice was made. */
  via: 'image' | 'text' | 'manual' | null;
  ocrText?: string;
  glare: number;
}

export interface Spread {
  id: number;
  /** Seconds into the run when it was captured. */
  time: number;
  pockets: PocketView[];
}

export function toPocketView(p: WirePocket): PocketView {
  const chosen = p.status === 'empty' || !p.matches.length || p.status === 'unknown' ? null : p.matches[0].card;
  return {
    page: p.page,
    slot: p.slot,
    status: p.status,
    matches: p.matches,
    otherNameDistance: p.otherNameDistance,
    thumbUrl: imageToDataURL(p.thumb),
    query: p.query ? Uint32Array.from(p.query) : undefined,
    nameCrop: p.nameCrop,
    chosen,
    finish: 'nonfoil',
    via: chosen === null ? null : 'image',
    glare: p.glare,
  };
}

/** True when two captures show the same spread (most identified pockets agree). */
export function sameSpread(a: PocketView[], b: PocketView[], db: CardDB): boolean {
  let both = 0, agree = 0;
  for (const pa of a) {
    const pb = b.find((p) => p.page === pa.page && p.slot === pa.slot);
    if (!pb || pa.chosen === null || pb.chosen === null) continue;
    both++;
    if (db.nameOf[pa.chosen] === db.nameOf[pb.chosen]) agree++;
  }
  return both >= 3 && agree / both >= 0.5;
}

const RANK: Record<PocketStatus, number> = { matched: 3, uncertain: 2, unknown: 1, empty: 0 };

/** Merges a duplicate capture into an existing spread, keeping the better result per pocket. */
export function mergeInto(a: PocketView[], b: PocketView[]): PocketView[] {
  return a.map((pa) => {
    if (pa.via === 'manual') return pa;
    const pb = b.find((p) => p.page === pa.page && p.slot === pa.slot);
    if (!pb) return pa;
    if (RANK[pb.status] !== RANK[pa.status]) return RANK[pb.status] > RANK[pa.status] ? pb : pa;
    return (pb.matches[0]?.d ?? Infinity) < (pa.matches[0]?.d ?? Infinity) ? pb : pa;
  });
}

/** Printings of a name, nearest to the photographed card first. */
export function rankPrintings(db: CardDB, nameIdx: number, query?: Uint32Array): { card: number; d: number }[] {
  const list = db.printings[nameIdx].map((card) => ({ card, d: query ? fpDistance(query, db.fps, card) : 0 }));
  return list.sort((x, y) => x.d - y.d);
}

/** Applies an OCR reading of the title line to a pocket. */
export function applyOcr(p: PocketView, text: string, db: CardDB): PocketView {
  const hits = db.fuzzyNames(text, 3);
  const top = hits[0];
  if (!top || top.score < 0.45) return { ...p, ocrText: text };
  const printings = rankPrintings(db, top.name, p.query);
  const best = printings[0];
  // The text agrees with one of the image candidates, or is a clean read on its own.
  const agreesWithImage = p.matches.some((m) => db.nameOf[m.card] === top.name);
  const strongRead = top.score >= 0.75 && (hits[1]?.score ?? 0) < top.score - 0.15;
  const status: PocketStatus = agreesWithImage || strongRead ? 'matched' : 'uncertain';
  return { ...p, ocrText: text, chosen: best.card, status, via: 'text' };
}

export function needsOcr(p: PocketView): boolean {
  return !!p.nameCrop && p.via !== 'manual' && (p.status === 'uncertain' || p.status === 'unknown');
}

export function pocketPrice(db: CardDB, p: { chosen: number | null; finish: Finish }, live?: LivePrices): number | null {
  if (p.chosen === null) return null;
  return cardPrice(db, p.chosen, p.finish, live);
}

export type LivePrices = Record<string, { nonfoil: number | null; foil: number | null; etched: number | null; at: string }>;

export function cardPrice(db: CardDB, card: number, finish: Finish, live?: LivePrices): number | null {
  const info = db.info(card);
  const l = live?.[info.id];
  if (l && l.at > db.file.built) return l[finish] ?? null;
  return info.prices[finish] ?? null;
}

export function spreadTotal(db: CardDB, s: Spread, live?: LivePrices): number {
  return s.pockets.reduce((t, p) => t + (pocketPrice(db, p, live) ?? 0), 0);
}

export const ACCEPT = DEFAULT_RECOGNIZE;
