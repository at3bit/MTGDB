import { formatUSD, type CardDB } from '../core/carddb.ts';
import { cardPrice, type LivePrices } from '../app/session.ts';
import { copies, totals, trendFor, type Collection, type PriceHistory } from '../app/store.ts';
import { scryfallArt } from '../app/prices.ts';
import type { Baselines } from '../core/baselines.ts';
import type { DraftSummary } from '../app/draft.ts';
import { collectionMana, Icon, LIGHT_TILES, PriceBadge } from './kit.tsx';
import { CardRow } from './CardsView.tsx';

interface Props {
  db: CardDB | null;
  dbStatus: { loading: string | null; error: string | null; missing: boolean };
  collection: Collection;
  live: LivePrices;
  history: PriceHistory;
  baselines: Baselines | null;
  refreshing: string | null;
  onOpenBinder: (name: string) => void;
  onNewCollection: () => void;
  onOpenCard: (row: OwnedRow) => void;
  /** Every card, most valuable first (the Search tab). */
  onSeeAll: () => void;
  /** An unfinished scan saved on the phone (e.g. after a crash), to resume or discard. */
  draft: DraftSummary | null;
  onResume: () => void;
  onDiscardDraft: () => void;
  onRefresh: () => void;
}

/** A card is a sell candidate when it's this far above its own 30-day average. */
export const SELL_SIGNAL = 0.2;

export interface OwnedRow {
  binder: string;
  page: number;
  slot: number;
  card: number;
  id: string;
  name: string;
  set: string;
  finish: 'nonfoil' | 'foil' | 'etched';
  /** Price of one copy. */
  price: number | null;
  /** Copies held (see OwnedCard.qty). */
  qty: number;
  trend: ReturnType<typeof trendFor>;
}

export function ownedRows(db: CardDB, col: Collection, live: LivePrices, history: PriceHistory, baselines: Baselines | null, binder?: string): OwnedRow[] {
  const rows: OwnedRow[] = [];
  for (const b of col.binders) {
    if (binder && b.name !== binder) continue;
    for (const c of b.cards) {
      const idx = db.indexOfId(c.id);
      if (idx < 0) continue;
      const info = db.info(idx);
      const price = cardPrice(db, idx, c.finish, live);
      rows.push({ binder: b.name, page: c.page, slot: c.slot, card: idx, id: c.id, name: info.name, set: info.set, finish: c.finish, price, qty: copies(c), trend: trendFor(history, c.id, c.finish, price, baselines?.get(idx, c.finish)) });
    }
  }
  return rows;
}

/** One row per printing and finish (the first place it's stored), for lists that name each card once. */
export function uniqueRows(rows: OwnedRow[]): OwnedRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = `${r.id}:${r.finish}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Total change over 30 days of the cards whose change is known (each copy counts): dollars and fraction. */
export function change30(rows: OwnedRow[]): { gain: number; pct: number } | null {
  let gain = 0, base = 0, n = 0;
  for (const r of rows) {
    if (r.price == null || r.trend?.gain30 == null) continue;
    gain += r.trend.gain30 * r.qty;
    base += (r.price - r.trend.gain30) * r.qty;
    n++;
  }
  return n && base > 0 ? { gain, pct: gain / base } : null;
}

const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;

export function HomeScreen({ db, dbStatus, collection, live, history, baselines, refreshing, onOpenBinder, onNewCollection, onOpenCard, onSeeAll, draft, onResume, onDiscardDraft, onRefresh }: Props) {
  const allRows = db ? ownedRows(db, collection, live, history, baselines) : [];
  // The portfolio is every copy in every collection; the lists below name each printing once.
  const rows = uniqueRows(allRows);
  const { value: total, count } = totals(allRows);
  const change = change30(allRows);
  const sell = rows
    .filter((r) => r.trend && r.trend.vsAvg >= SELL_SIGNAL && r.trend.avg * r.trend.vsAvg >= 1)
    .sort((a, b) => b.trend!.avg * b.trend!.vsAvg - a.trend!.avg * a.trend!.vsAvg)
    .slice(0, 5);
  const top = [...rows].sort((a, b) => (b.price ?? 0) - (a.price ?? 0)).slice(0, 5);
  const lastRefresh = Object.values(live).reduce((t, p) => (p.at > t ? p.at : t), '');
  const pricesAsOf = lastRefresh ? new Date(lastRefresh) : db ? new Date(db.file.built) : null;

  return (
    <main>
      {dbStatus.missing && (
        <div className="notice">
          <strong>Card database not built yet.</strong>
          <div className="small" style={{ marginTop: 4 }}>{dbStatus.error}</div>
        </div>
      )}
      {dbStatus.error && !dbStatus.missing && <div className="notice error">{dbStatus.error}</div>}
      {draft && (
        <div className="notice" data-testid="resume">
          <strong>Unfinished scan of “{draft.binder}”</strong>
          <div className="small muted" style={{ marginTop: 4 }}>
            {plural(draft.cards, 'card')}, {draft.checked} checked · saved {new Date(draft.savedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
          </div>
          <div className="row" style={{ marginTop: 10, gap: 8 }}>
            <button className="btn primary" disabled={!db} onClick={onResume}>Resume</button>
            <button className="btn" onClick={onDiscardDraft}>Discard</button>
          </div>
        </div>
      )}
      {dbStatus.loading && <div className="notice">{dbStatus.loading}</div>}

      <section className="portfolio" aria-labelledby="portfolio-title">
        <h1 className="eyebrow" id="portfolio-title">Portfolio</h1>
        <div className="money-hero" data-testid="portfolio-total">{formatUSD(total)}</div>
        <div className="trend">
          {change && Math.abs(change.gain) >= 0.05 && <PriceBadge change={change.gain} pct={change.pct} suffix="30 days" />}
          <span className="small muted">
            {plural(count, 'card')}
            {pricesAsOf && ` · prices ${pricesAsOf.toLocaleDateString([], { day: 'numeric', month: 'short' })}`}
          </span>
          {rows.length > 0 && (
            <button className="btn quiet small" onClick={onRefresh} disabled={!db || !!refreshing} style={{ marginLeft: -8 }}>
              <Icon name="refresh" size={18} />
              {refreshing ?? 'Refresh prices'}
            </button>
          )}
        </div>
      </section>

      {db && collection.binders.length === 0 && !draft && (
        <section className="card stack">
          <h2 className="title-m">Start your first collection</h2>
          <ol className="tips checklist">
            <li>Take a photo of each binder page, flat and filling the frame, with the Camera app.</li>
            <li>Tap Scan, name the collection and pick the photos, in page order.</li>
            <li>Check the cards the app isn’t sure about, then save. Prices update every day.</li>
          </ol>
          <button className="btn primary block" onClick={onNewCollection}>Scan your first collection</button>
        </section>
      )}

      {collection.binders.length > 0 && (
        <section aria-labelledby="collections-title">
          <div className="section-head">
            <h2 className="title-m" id="collections-title">Collections</h2>
            <span className="small muted">{collection.binders.length}</span>
          </div>
          <div className="tiles">
            {collection.binders.map((b) => {
              const mine = db ? allRows.filter((r) => r.binder === b.name) : [];
              const { value, count: held } = totals(mine);
              const best = mine.reduce<OwnedRow | null>((m, r) => ((r.price ?? 0) > (m?.price ?? -1) ? r : m), null);
              const mana = db ? collectionMana(db, b) : 'C';
              return (
                <button key={b.name} className={`ctile mana-${mana}${LIGHT_TILES.includes(mana) ? ' light' : ''}`} onClick={() => onOpenBinder(b.name)} aria-label={`${b.name}: ${db ? formatUSD(value) : ''}, ${plural(db ? held : b.cards.length, 'card')}`}>
                  {best && <img className="art" src={scryfallArt(best.id)} alt="" loading="lazy" />}
                  <span className="shade" />
                  <span className="name">{b.name}</span>
                  <span>
                    <span className="value" style={{ display: 'block' }}>{db ? formatUSD(value) : ''}</span>
                    <span className="count">{plural(db ? held : b.cards.length, 'card')}</span>
                  </span>
                </button>
              );
            })}
            <button className="ctile new" onClick={onNewCollection}>
              <Icon name="plus" />
              New collection
            </button>
          </div>
        </section>
      )}

      {sell.length > 0 && (
        <section aria-labelledby="sell-title" style={{ marginBottom: 28 }}>
          <div className="section-head">
            <h2 className="title-m" id="sell-title">Worth selling now</h2>
          </div>
          <p className="small muted" style={{ margin: '-6px 0 4px' }}>
            At least {Math.round(SELL_SIGNAL * 100)}% (and $1) above their 30-day average{baselines ? ` on TCGplayer, as of ${baselines.asOf}` : ''}.
          </p>
          {sell.map((r) => (
            <CardRow key={`${r.binder}-${r.page}-${r.slot}`} id={r.id} name={r.name} finish={r.finish} meta={`${r.binder} · page ${r.page}, slot ${r.slot} · avg ${formatUSD(r.trend!.avg)}`} price={r.price} qty={r.qty} trend={r.trend} onOpen={() => onOpenCard(r)} />
          ))}
        </section>
      )}

      {top.length > 0 && (
        <section aria-labelledby="top-title">
          <div className="section-head">
            <h2 className="title-m" id="top-title">Most valuable</h2>
            <button className="btn quiet small" onClick={onSeeAll} style={{ marginRight: -16 }}>See all</button>
          </div>
          {top.map((r) => (
            <CardRow key={`${r.binder}-${r.page}-${r.slot}`} id={r.id} name={r.name} finish={r.finish} meta={`${r.binder} · page ${r.page}, slot ${r.slot}`} price={r.price} qty={r.qty} trend={r.trend} onOpen={() => onOpenCard(r)} />
          ))}
        </section>
      )}

      {db && (
        <p className="muted small" style={{ textAlign: 'center', marginTop: 24 }}>
          {db.count.toLocaleString()} printings · card data and prices from Scryfall ({db.file.source.replace('Scryfall ', '')})
        </p>
      )}
    </main>
  );
}
