import { useState } from 'react';
import { formatUSD, type CardDB } from '../core/carddb.ts';
import { cardPrice, type LivePrices } from '../app/session.ts';
import { trendFor, type Collection, type PriceHistory } from '../app/store.ts';
import { scryfallImage } from '../app/prices.ts';
import type { Baselines } from '../core/baselines.ts';

interface Props {
  db: CardDB | null;
  dbStatus: { loading: string | null; error: string | null; missing: boolean };
  collection: Collection;
  live: LivePrices;
  history: PriceHistory;
  baselines: Baselines | null;
  refreshing: string | null;
  onScan: () => void;
  onOpenBinder: (name: string) => void;
  /** Open the all-cards view, optionally searching for a name. */
  onBrowse: (query?: string) => void;
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
  price: number | null;
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
      rows.push({ binder: b.name, page: c.page, slot: c.slot, card: idx, id: c.id, name: info.name, set: info.set, finish: c.finish, price, trend: trendFor(history, c.id, c.finish, price, baselines?.get(idx, c.finish)) });
    }
  }
  return rows;
}

/** Quantities aren't tracked: one row per printing and finish across the collection (first place it's stored). */
export function uniqueRows(rows: OwnedRow[]): OwnedRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = `${r.id}:${r.finish}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function TrendBadge({ t }: { t: OwnedRow['trend'] }) {
  if (!t || Math.abs(t.vsAvg) < 0.05) return null;
  const up = t.vsAvg > 0;
  return <span className={`badge ${up ? 'up' : 'down'}`}>{up ? '▲' : '▼'} {Math.round(Math.abs(t.vsAvg) * 100)}%</span>;
}

export function HomeScreen({ db, dbStatus, collection, live, history, baselines, refreshing, onScan, onOpenBinder, onBrowse, onRefresh }: Props) {
  const [query, setQuery] = useState('');
  const allRows = db ? ownedRows(db, collection, live, history, baselines) : [];
  const rows = uniqueRows(allRows);
  const total = rows.reduce((t, r) => t + (r.price ?? 0), 0);
  const sell = rows
    .filter((r) => r.trend && r.trend.vsAvg >= SELL_SIGNAL && r.trend.avg * r.trend.vsAvg >= 1)
    .sort((a, b) => b.trend!.avg * b.trend!.vsAvg - a.trend!.avg * a.trend!.vsAvg)
    .slice(0, 10);
  const top = [...rows].sort((a, b) => (b.price ?? 0) - (a.price ?? 0)).slice(0, 10);
  const binderValue = (name: string) => allRows.filter((r) => r.binder === name).reduce((t, r) => t + (r.price ?? 0), 0);

  return (
    <div>
      <div className="topbar">
        <h1>MTGDB</h1>
      </div>

      {dbStatus.missing && (
        <div className="notice">
          <strong>Card database not built yet.</strong>
          <div className="small" style={{ marginTop: 4 }}>{dbStatus.error}</div>
        </div>
      )}
      {dbStatus.error && !dbStatus.missing && <div className="notice error">{dbStatus.error}</div>}
      {dbStatus.loading && <div className="notice">{dbStatus.loading}</div>}

      <div className="card">
        <h2>Collection value</h2>
        <div className="big-number">{formatUSD(total)}</div>
        <div className="muted small">
          {rows.length} card{rows.length === 1 ? '' : 's'} in {collection.binders.length} binder{collection.binders.length === 1 ? '' : 's'}
          {db && ` · prices from ${db.file.built.slice(0, 10)}`}
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn primary grow" onClick={onScan} disabled={!db}>Scan a binder</button>
          <button className="btn" onClick={onRefresh} disabled={!db || !rows.length || !!refreshing}>{refreshing ?? 'Refresh prices'}</button>
        </div>
      </div>

      {db && rows.length > 0 && (
        <form
          className="card stack"
          onSubmit={(e) => {
            e.preventDefault();
            onBrowse(query.trim());
          }}
        >
          <h2>Do I own…?</h2>
          <div className="row">
            <input type="search" className="grow" placeholder="Card name" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search your collection" />
            <button className="btn" type="submit">Search</button>
          </div>
          <button className="btn block" type="button" onClick={() => onBrowse()}>Browse all {rows.length} cards</button>
        </form>
      )}

      {sell.length > 0 && (
        <div className="card">
          <h2>Worth selling now</h2>
          <p className="muted small" style={{ marginTop: 0 }}>
            Trading at least {Math.round(SELL_SIGNAL * 100)}% (and $1) above their own 30-day average
            {baselines ? ` on TCGplayer, as of ${baselines.asOf}` : ''}.
          </p>
          <ul className="list">
            {sell.map((r) => (
              <li key={`${r.binder}-${r.page}-${r.slot}`}>
                <img className="mini" src={scryfallImage(r.id, 'small')} alt="" loading="lazy" />
                <div className="grow">
                  <div className="ellipsis">{r.name}</div>
                  <div className="muted small">{r.binder} · page {r.page} · slot {r.slot} · avg {formatUSD(r.trend!.avg)}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="num">{formatUSD(r.price)}</div>
                  <TrendBadge t={r.trend} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {collection.binders.length > 0 && (
        <div className="card">
          <h2>Binders</h2>
          <ul className="list">
            {collection.binders.map((b) => (
              <li key={b.name} className="tap" onClick={() => onOpenBinder(b.name)}>
                <div className="grow">
                  <div className="ellipsis">{b.name}</div>
                  <div className="muted small">{b.cards.length} cards · scanned {b.updatedAt.slice(0, 10)}</div>
                </div>
                <span className="num">{db ? formatUSD(binderValue(b.name)) : ''}</span>
                <span className="muted">›</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {top.length > 0 && (
        <div className="card">
          <h2>Most valuable</h2>
          <ul className="list">
            {top.map((r) => (
              <li key={`${r.binder}-${r.page}-${r.slot}`}>
                <img className="mini" src={scryfallImage(r.id, 'small')} alt="" loading="lazy" />
                <div className="grow">
                  <div className="ellipsis">{r.name}{r.finish !== 'nonfoil' ? ' ✦' : ''}</div>
                  <div className="muted small">{r.binder} · page {r.page} · slot {r.slot}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="num">{formatUSD(r.price)}</div>
                  <TrendBadge t={r.trend} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {db && collection.binders.length === 0 && (
        <div className="card">
          <h2>How it works</h2>
          <ol className="tips">
            <li>Mount your iPhone on a tripod, camera facing straight down at the table.</li>
            <li>Open the binder underneath so both pages are in view.</li>
            <li>Line up the outline once, then turn the pages, pausing about half a second on each spread (or tap Snap page).</li>
            <li>Check anything marked orange or red, then save. Prices update daily.</li>
          </ol>
        </div>
      )}

      {db && (
        <p className="muted small" style={{ textAlign: 'center' }}>
          {db.count.toLocaleString()} printings · card data and prices from Scryfall ({db.file.source.replace('Scryfall ', '')})
        </p>
      )}
    </div>
  );
}
