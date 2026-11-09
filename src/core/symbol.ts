// The set-symbol area of a card (right end of the type line: the expansion
// symbol, coloured by rarity).
//
// The app crops this area sharply from the photo and shows it next to each
// look-alike printing's symbol area, so you can settle "Which printing?" by
// eye. Comparing them automatically (symbolSimilarity / pickBySymbol below)
// was tried with `npm run eval -- --symbol`: over 102 ties it picked the right
// printing 51 times versus 56 for the default choice, because the symbol is
// only ~20 px wide at 4K and many look-alikes have identical symbol areas
// (Beta and Collectors' Edition have no symbol; promos differ by a stamp on
// the art). So the app does not use it to decide.
import { fullRect, resampleRGBA, subRect, type RGBAImage, type Rect } from './image.ts';

/** Area around the set symbol, as fractions of the full card. Generous enough for the 1993-2015+ frames. */
export const SYMBOL_REGION = [0.78, 0.53, 0.96, 0.65] as const;
export const SYMBOL_W = 80;
export const SYMBOL_H = 72;

/** The symbol area of a full card image (e.g. a Scryfall scan), at the comparison size. */
export function symbolArea(card: RGBAImage, cardRect: Rect = fullRect(card)): RGBAImage {
  const [x0, y0, x1, y1] = SYMBOL_REGION;
  return resampleRGBA(card, subRect(cardRect, x0, y0, x1, y1), SYMBOL_W, SYMBOL_H);
}

/** Per-channel zero-mean, unit-variance planes (cancels lighting and colour cast). */
function planes(img: RGBAImage): Float32Array[] {
  const n = img.width * img.height;
  return [0, 1, 2].map((c) => {
    const p = new Float32Array(n);
    let s = 0, s2 = 0;
    for (let i = 0; i < n; i++) {
      const v = img.data[i * 4 + c];
      p[i] = v;
      s += v;
      s2 += v * v;
    }
    const m = s / n;
    const sd = Math.sqrt(Math.max(1e-6, s2 / n - m * m));
    for (let i = 0; i < n; i++) p[i] = (p[i] - m) / sd;
    return p;
  });
}

/**
 * Similarity (-1..1) of two symbol-area crops of the same size: normalised
 * correlation of each colour channel, at the best small offset.
 */
export function symbolSimilarity(photo: RGBAImage, ref: RGBAImage, maxShift = 4): number {
  const W = photo.width, H = photo.height;
  if (ref.width !== W || ref.height !== H) throw new Error('symbol crops must be the same size');
  const a = planes(photo), b = planes(ref);
  let best = -1;
  for (let dy = -maxShift; dy <= maxShift; dy++) {
    for (let dx = -maxShift; dx <= maxShift; dx++) {
      let total = 0;
      for (let c = 0; c < 3; c++) {
        let s = 0, n = 0;
        for (let y = Math.max(0, -dy); y < Math.min(H, H - dy); y++) {
          const ra = y * W, rb = (y + dy) * W;
          for (let x = Math.max(0, -dx); x < Math.min(W, W - dx); x++) {
            s += a[c][ra + x] * b[c][rb + x + dx];
            n++;
          }
        }
        total += s / n;
      }
      if (total / 3 > best) best = total / 3;
    }
  }
  return best;
}

export interface SymbolPick {
  /** Candidate with the most similar symbol area. */
  card: number;
  scores: { card: number; score: number }[];
  /** The winner is clear enough to settle the tie without asking. */
  decisive: boolean;
}

/** Compares the photo's symbol area with each tied printing's; decisive when one clearly wins. */
export function pickBySymbol(photo: RGBAImage, candidates: { card: number; image: RGBAImage }[], minLead = 0.06, minScore = 0.35): SymbolPick | null {
  if (candidates.length < 2) return null;
  const scores = candidates.map((c) => ({ card: c.card, score: symbolSimilarity(photo, symbolArea(c.image)) })).sort((x, y) => y.score - x.score);
  const lead = scores[0].score - scores[1].score;
  return { card: scores[0].card, scores, decisive: scores[0].score >= minScore && lead >= minLead };
}
