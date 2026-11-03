// Fresh prices for the cards you own, straight from Scryfall's API
// (TCGplayer market prices in USD, which Scryfall updates about once a day).
import type { LivePrices } from './session.ts';

const num = (v: string | null | undefined) => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export async function fetchLivePrices(ids: string[], onProgress?: (done: number, total: number) => void): Promise<LivePrices> {
  const out: LivePrices = {};
  const unique = [...new Set(ids)];
  const at = new Date().toISOString();
  for (let i = 0; i < unique.length; i += 75) {
    const chunk = unique.slice(i, i + 75);
    const res = await fetch('https://api.scryfall.com/cards/collection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ identifiers: chunk.map((id) => ({ id })) }),
    });
    if (!res.ok) throw new Error(`Scryfall returned HTTP ${res.status}`);
    const body = (await res.json()) as { data: { id: string; prices: Record<string, string | null> }[] };
    for (const c of body.data) {
      out[c.id] = { nonfoil: num(c.prices.usd), foil: num(c.prices.usd_foil), etched: num(c.prices.usd_etched), at };
    }
    onProgress?.(Math.min(unique.length, i + 75), unique.length);
    // Scryfall asks for no more than ~10 requests per second.
    await new Promise((r) => setTimeout(r, 120));
  }
  return out;
}

export function scryfallImage(id: string, size: 'small' | 'normal' = 'normal') {
  return `https://cards.scryfall.io/${size}/front/${id[0]}/${id[1]}/${id}.jpg`;
}

export function scryfallPage(set: string, cn: string) {
  return `https://scryfall.com/card/${set}/${encodeURIComponent(cn)}`;
}
