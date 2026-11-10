// Non-English printings (Scryfall lists them when a card or art was printed only in that language):
// how close is each to an English printing of the same card, and would a photo of the English one
// be matched to the foreign one?
import { createReadStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { CardDB, decodeFingerprints, type CardsFile } from '../src/core/carddb.ts';
import { fpDistance } from '../src/core/fingerprint.ts';

const file = JSON.parse(readFileSync('public/data/cards.json', 'utf8')) as CardsFile;
const fpBuf = readFileSync('public/data/fingerprints.bin');
const db = new CardDB(file, decodeFingerprints(fpBuf.buffer.slice(fpBuf.byteOffset, fpBuf.byteOffset + fpBuf.byteLength) as ArrayBuffer));
const lang = new Map<string, string>();
for await (const line of createInterface({ input: createReadStream(process.argv[2] ?? '/tmp/mtgdb-default-cards.json') })) {
  const m = /"id":"([^"]+)".*?"lang":"([^"]+)"/.exec(line);
  if (m) lang.set(m[1], m[2]);
}
const isEn = (i: number) => lang.get(file.cards[i][0]) === 'en';
const foreign = Array.from({ length: db.count }, (_, i) => i).filter((i) => !isEn(i));
let twins = 0, close = 0;
const examples: string[] = [];
const byLang: Record<string, number> = {};
for (const f of foreign) {
  const same = db.printings[db.nameOf[f]].filter(isEn);
  if (!same.length) continue;
  const d = Math.min(...same.map((e) => fpDistance(db.fps.subarray(f * 5, f * 5 + 5), db.fps, e)));
  if (d <= 12) { twins++; byLang[lang.get(file.cards[f][0])!] = (byLang[lang.get(file.cards[f][0])!] ?? 0) + 1; if (examples.length < 8) examples.push(`${file.cards[f][1]} (${file.cards[f][2].toUpperCase()}, ${lang.get(file.cards[f][0])}) d=${d}`); }
  else if (d <= 24) close++;
}
console.log(`${foreign.length} non-English printings; ${twins} look like an English printing of the same card (distance <= 12, i.e. same art: a photo can match either), ${close} more are similar (13-24)`);
console.log('by language:', byLang);
examples.forEach((e) => console.log('  ' + e));
