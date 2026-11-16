// Which printing: exact twins (The List, foil-only ★) lose to the regular card, a visual tie with a big
// price gap is still flagged, and in a binder sorted by set the page's set decides among look-alikes.
// From a real scan: 9 of 34 cards with a List twin were saved as the List reprint.
import { describe, expect, it } from 'vitest';
import { CardDB, decodeFingerprints, encodeFingerprints, type CardRow, type CardsFile } from '../src/core/carddb.ts';
import { FP_WORDS, fingerprint } from '../src/core/fingerprint.ts';
import { originSet, parseCollectorLine, printingFromCollector, resolvePrinting } from '../src/core/printing.ts';
import { addReading, applyInfoRead, approvePocket, needsInfoOcr, preferPageSets, type PocketView, type Spread } from '../src/app/session.ts';
import { makeCard, toReferenceSize } from './synth.ts';

// [id, name, set, collector number, rarity, finish bits (1 nonfoil, 2 foil), usd, usd foil, usd etched, border, priority]
const rows: CardRow[] = [
  ['ch-lgn', 'Corpse Harvester', 'lgn', '62', 'uncommon', 3, 0.4, 2, null, 'black', 0], // 0
  ['ch-list', 'Corpse Harvester', 'plst', 'LGN-62', 'uncommon', 1, 0.26, null, null, 'black', 1], // 1: same card, tiny mark
  ['gz-8ed', 'Gluttonous Zombie', '8ed', '136', 'uncommon', 1, 0.16, null, null, 'white', 0], // 2
  ['gz-star', 'Gluttonous Zombie', '8ed', '136★', 'uncommon', 2, null, 0.06, null, 'white', 0], // 3: foil-only twin
  ['bolt-b', 'Lightning Bolt', 'leb', '161', 'common', 1, 300, null, null, 'black', 0], // 4
  ['bolt-ce', 'Lightning Bolt', 'ced', '161', 'common', 1, 40, null, null, 'black', 2], // 5: collectible look-alike
  ['ww-lgn', 'Withered Wretch', 'lgn', '86', 'uncommon', 3, 2.5, 5, null, 'black', 0], // 6
  ['ww-tsb', 'Withered Wretch', 'tsb', '54', 'special', 3, 1.72, 4, null, 'black', 0], // 7: timeshifted, same look
  ['zb', 'Zombie Brute', 'lgn', '87', 'uncommon', 3, 0.13, 1, null, 'black', 0], // 8
  ['ss', 'Spectral Sliver', 'lgn', '83', 'uncommon', 3, 0.35, 1, null, 'black', 0], // 9
  ['hd', 'Havoc Demon', 'lgn', '74', 'rare', 3, 0.35, 1, null, 'black', 0], // 10
  ['ro-cma', 'Razorjaw Oni', 'cma', '63', 'uncommon', 1, 0.13, null, null, 'black', 0], // 11
  ['ro-sok', 'Razorjaw Oni', 'sok', '87', 'uncommon', 3, 0.18, 1, null, 'black', 0], // 12: different frame
  ['vt', 'Visara the Dreadful', 'ons', '179', 'rare', 3, 6.94, 20, null, 'black', 0], // 13
  ['dm-nph', 'Dismember', 'nph', '57', 'uncommon', 3, 2, 8, null, 'black', 0], // 14
  ['dm-mm2', 'Dismember', 'mm2', '79', 'uncommon', 3, 1.5, 6, null, 'black', 0], // 15: a reprint the photo can't tell apart
  ['dt-kld', 'Diabolic Tutor', 'kld', '75', 'uncommon', 3, 0.2, 1, null, 'black', 0], // 16
];
const file: CardsFile = { v: 1, built: '2026-01-01', source: 'test', sets: { lgn: 'Legions', plst: 'The List', '8ed': 'Eighth Edition', leb: 'Beta', ced: "Collectors' Edition", tsb: 'Time Spiral Timeshifted', cma: 'Commander Anthology', sok: 'Saviors of Kamigawa', ons: 'Onslaught', nph: 'New Phyrexia', mm2: 'Modern Masters 2015', kld: 'Kaladesh' }, cards: rows };
const art = [0, 0, 1, 1, 2, 2, 3, 3, 4, 5, 6, 7, 7, 8, 9, 9, 10];
const fps = new Uint32Array(rows.length * FP_WORDS);
rows.forEach((_, i) => fps.set(fingerprint(toReferenceSize(makeCard(700 + art[i]))), i * FP_WORDS));
/** Flips `n` bits of card i's fingerprint (spread over the words). */
const flip = (a: Uint32Array, n: number, from = 0) => {
  const o = a.slice();
  for (let k = 0; k < n; k++) o[(from + k) % FP_WORDS] ^= 1 << ((from + k * 7) % 32);
  return o;
};
const fpOf = (i: number) => fps.slice(i * FP_WORDS, (i + 1) * FP_WORDS);
fps.set(flip(fpOf(1), 3), 1 * FP_WORDS); // The List scan differs by a few bits
fps.set(flip(fpOf(3), 2), 3 * FP_WORDS);
fps.set(flip(fpOf(7), 6), 7 * FP_WORDS);
fps.set(flip(fpOf(12), 30), 12 * FP_WORDS); // a different frame: clearly different
const db = new CardDB(file, decodeFingerprints(encodeFingerprints(fps, rows.length).buffer as ArrayBuffer));

describe('exact twins', () => {
  it('a photo slightly closer to the List reprint is still read as the original', () => {
    // The photo's fingerprint: The List's, plus noise (1 bit closer to it than to the original).
    const q = flip(fpOf(1), 2, 11);
    const c = resolvePrinting(db, db.nameOf[0], q);
    expect(db.info(c.card).set).toBe('lgn');
    expect(c.ambiguous).toBe(false); // 40¢ vs 26¢: not worth asking
    expect(originSet(db.info(1))).toBe('lgn');
  });
  it('the regular printing wins over its foil-only ★ twin', () => {
    expect(db.info(resolvePrinting(db, db.nameOf[2], fpOf(3)).card).cn).toBe('136');
  });
  it('look-alikes far apart in price are still flagged for the user, whatever the preference', () => {
    const c = resolvePrinting(db, db.nameOf[4], fpOf(5));
    expect(c.ambiguous).toBe(true);
    expect(c.ties.map((t) => t.card).sort()).toEqual([4, 5]);
  });
});

const pocket = (slot: number, card: number | null, extra: Partial<PocketView> = {}): PocketView => ({
  page: 0, slot, status: card === null ? 'empty' : 'matched', matches: card === null ? [] : [{ card, d: 20 }], otherNameDistance: 60,
  thumbUrl: '', chosen: card, finish: 'nonfoil', via: card === null ? null : 'image', glare: 0, query: card === null ? undefined : fpOf(card), ...extra,
});
const spreadOf = (pockets: PocketView[]): Spread => ({ id: 1, time: 0, pockets });

describe('page set', () => {
  it('on a Legions page, a timeshifted look-alike is read as the Legions printing', () => {
    const s = preferPageSets(spreadOf([pocket(0, 8), pocket(1, 9), pocket(2, 10), pocket(3, 7)]), db);
    expect(s.pockets[3]).toMatchObject({ chosen: 6, pageSet: 'lgn' });
    expect(s.pockets.slice(0, 3).map((p) => p.chosen)).toEqual([8, 9, 10]);
  });
  it('a List reprint counts towards its original set, and is itself read as the original', () => {
    // Zombie Brute and the List reprint make two Legions cards for the Wretch; the reprint itself sees two others.
    const s = preferPageSets(spreadOf([pocket(0, 8), pocket(1, 9), pocket(2, 1), pocket(3, 7)]), db);
    expect(s.pockets.map((p) => p.chosen)).toEqual([8, 9, 0, 6]);
    expect(preferPageSets(spreadOf([pocket(0, 8), pocket(1, 1), pocket(2, 7)]), db).pockets[2].chosen).toBe(6);
  });
  it('leaves cards the user picked, printings that look different, and mixed pages alone', () => {
    const picked = approvePocket(pocket(3, 7), 7, 'nonfoil');
    expect(preferPageSets(spreadOf([pocket(0, 8), pocket(1, 9), pocket(2, 10), picked]), db).pockets[3].chosen).toBe(7);
    // Razorjaw Oni's Saviors printing has a different frame: no switching to it on a Saviors-free page or any other.
    expect(preferPageSets(spreadOf([pocket(0, 8), pocket(1, 9), pocket(2, 11)]), db).pockets[2].chosen).toBe(11);
    // One Legions card and one Onslaught card: no set leads.
    expect(preferPageSets(spreadOf([pocket(0, 8), pocket(1, 13), pocket(2, 7)]), db).pockets[2].chosen).toBe(7);
  });
  it('is applied as a spread is read', () => {
    const spreads = addReading([], { pockets: [pocket(0, 8), pocket(1, 9), pocket(2, 10), pocket(3, 7)], time: 0, change: Infinity, manual: false }, 1, db);
    expect(spreads[0].pockets[3].chosen).toBe(6);
  });
});

describe('collector line', () => {
  const known = (c: string) => db.hasSet(c);
  it('reads set code and number off modern cards, as OCR garbles them', () => {
    expect(parseCollectorLine('079/249 U ™ & © 2015 Wizards MM2 » EN & TERESE NIELSEN', known)).toEqual({ number: 79, total: 249, set: 'mm2' });
    expect(parseCollectorLine('Q72/184 U biti KLD * EN & Dax Scory', known)).toMatchObject({ number: 72, set: 'kld' });
    expect(parseCollectorLine('M 0169 DFT • EN', known)).toMatchObject({ number: 169 });
    // Older cards: the copyright line ends with number / cards in the set.
    expect(parseCollectorLine('™ & © 1993-2003 Wizards of the Coast, Inc. 62/145', known)).toEqual({ number: 62, total: 145 });
  });
  it('picks the printing it names, where the photo cannot tell them apart', () => {
    expect(db.info(printingFromCollector(db, { number: 79, total: 249, set: 'mm2' }, db.nameOf[14])!).set).toBe('mm2');
    expect(db.info(printingFromCollector(db, { set: 'nph' }, db.nameOf[15])!).set).toBe('nph');
    // An older card's number: the original, not its List reprint ("LGN-62").
    expect(printingFromCollector(db, { number: 62, total: 145 }, db.nameOf[1])).toBe(0);
    expect(printingFromCollector(db, { set: 'kld', number: 75 }, db.nameOf[14])).toBeNull();
  });
  it('a printing read off the card is kept, and anchors its page', () => {
    const read = applyInfoRead({ ...pocket(0, 14), infoCrop: new Blob() }, '079/249 U MM2 » EN', db);
    expect(read).toMatchObject({ chosen: 15, printingRead: true, infoText: '079/249 U MM2 » EN' });
    expect(read.infoCrop).toBeUndefined();
    // Two Legions cards would otherwise turn it into... nothing (no Legions Dismember), but it isn't touched either way.
    expect(preferPageSets(spreadOf([pocket(0, 8), pocket(1, 9), { ...read, slot: 2 }]), db).pockets[2].chosen).toBe(15);
  });
  it('names the card outright only for one the app was not sure of', () => {
    const unsure = { ...pocket(0, 14), status: 'uncertain' as const, infoCrop: new Blob() };
    expect(needsInfoOcr(unsure, db)).toBe(true);
    expect(applyInfoRead(unsure, '075/264 U KLD + EN', db)).toMatchObject({ chosen: 16, status: 'uncertain', via: 'text' });
    // An identified card: a misread number naming another card changes nothing.
    expect(applyInfoRead({ ...pocket(0, 14), infoCrop: new Blob() }, '075/264 U KLD + EN', db).chosen).toBe(14);
    // A card with one printing that the app is sure of isn't read at all.
    expect(needsInfoOcr({ ...pocket(0, 13), infoCrop: new Blob() }, db)).toBe(false);
  });
});

describe('unsure guesses', () => {
  // [.., priority, category bits]: B = 4, G = 16, land = 256 (see CATEGORY).
  const crows: CardRow[] = [
    ['ooze', 'March of the World Ooze', 'dft', '169', 'mythic', 1, 2.75, null, null, 'black', 0, 16],
    ['grim', 'Grim Return', 'm14', '100', 'rare', 1, 0.5, null, null, 'black', 0, 4],
    ['plains', 'Plains', 'tsp', '285', 'common', 1, 0.35, null, null, 'black', 0, 256],
    ['zeta', 'Power Sink', 'slz', '149', 'common', 1, null, null, null, 'black', 0, 2],
  ];
  const cdb = new CardDB({ v: 1, built: 'x', source: 't', sets: { dft: 'Aetherdrift', m14: 'Magic 2014', tsp: 'Time Spiral', slz: 'The Zeta Set' }, cards: crows }, decodeFingerprints(encodeFingerprints(new Uint32Array(crows.length * FP_WORDS), crows.length).buffer as ArrayBuffer));
  cdb.setCategories(4);
  const wire = (matches: { card: number; d: number }[], extra = {}) => ({ page: 0, slot: 0, status: 'uncertain' as const, matches, otherNameDistance: matches[1]?.d ?? 99, sharpness: 1, glare: 0, offCategory: true, ...extra });
  it('a card the app is unsure of shows its closest in-colour candidate first', async () => {
    const { toPocketView } = await import('../src/app/session.ts');
    const p = toPocketView(wire([{ card: 0, d: 33.5 }, { card: 2, d: 36 }, { card: 1, d: 40 }]), cdb);
    expect(p).toMatchObject({ chosen: 1, status: 'uncertain', offCategory: false });
    // A confident off-colour match (a misfiled card) is left alone.
    expect(toPocketView(wire([{ card: 0, d: 18 }, { card: 1, d: 40 }]), cdb).chosen).toBe(0);
  });
  it('joke and playtest sets are left out of picture matching', () => {
    expect(Array.from(cdb.matchable)).toEqual([1, 1, 1, 0]);
  });
});
