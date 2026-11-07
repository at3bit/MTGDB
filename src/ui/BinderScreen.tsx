import { useState } from 'react';
import { formatUSD, type CardDB } from '../core/carddb.ts';
import type { LivePrices } from '../app/session.ts';
import type { Collection, PriceHistory } from '../app/store.ts';
import { scryfallImage, scryfallPage } from '../app/prices.ts';
import { ownedRows, TrendBadge, type OwnedRow } from './HomeScreen.tsx';
import type { Baselines } from '../core/baselines.ts';

interface Props {
  db: CardDB;
  name: string;
  collection: Collection;
  live: LivePrices;
  history: PriceHistory;
  baselines: Baselines | null;
  onBack: () => void;
  onDelete: () => void;
}

function toCSV(rows: OwnedRow[], db: CardDB): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = ['Name,Set,Set code,Collector number,Finish,Price USD,Binder,Page,Slot,Scryfall ID'];
  for (const r of rows) {
    const info = db.info(r.card);
    lines.push([info.name, info.setName, info.set, info.cn, r.finish, r.price?.toFixed(2) ?? '', r.binder, String(r.page), String(r.slot), r.id].map(esc).join(','));
  }
  return lines.join('\n');
}

export function BinderScreen({ db, name, collection, live, history, baselines, onBack, onDelete }: Props) {
  const [sort, setSort] = useState<'value' | 'page'>('value');
  const rows = ownedRows(db, collection, live, history, baselines, name);
  const sorted = [...rows].sort((a, b) => (sort === 'value' ? (b.price ?? 0) - (a.price ?? 0) : a.page - b.page || a.slot - b.slot));
  const total = rows.reduce((t, r) => t + (r.price ?? 0), 0);

  const exportCSV = () => {
    const blob = new Blob([toCSV(sorted, db)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name.replace(/[^\w-]+/g, '_')}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <div>
      <div className="topbar">
        <button className="back" onClick={onBack}>‹ Home</button>
        <h1 className="ellipsis">{name}</h1>
      </div>
      <div className="card">
        <div className="big-number">{formatUSD(total)}</div>
        <div className="muted small">{rows.length} cards</div>
        <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
          <div className="seg">
            <button className={sort === 'value' ? 'on' : ''} onClick={() => setSort('value')}>By value</button>
            <button className={sort === 'page' ? 'on' : ''} onClick={() => setSort('page')}>By page</button>
          </div>
          <div className="grow" />
          <button className="btn small" onClick={exportCSV}>Export CSV</button>
        </div>
      </div>
      <div className="card">
        <ul className="list">
          {sorted.map((r) => (
            <li key={`${r.page}-${r.slot}`}>
              <img className="mini" src={scryfallImage(r.id, 'small')} alt="" loading="lazy" />
              <div className="grow">
                <a className="ellipsis" style={{ display: 'block', color: 'inherit', textDecoration: 'none' }} href={scryfallPage(r.set, db.info(r.card).cn)} target="_blank" rel="noreferrer">
                  {r.name}{r.finish !== 'nonfoil' ? ' ✦' : ''}
                </a>
                <div className="muted small">{r.set.toUpperCase()} · page {r.page} · slot {r.slot}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className="num">{formatUSD(r.price)}</div>
                <TrendBadge t={r.trend} />
              </div>
            </li>
          ))}
        </ul>
      </div>
      <button
        className="btn danger block"
        onClick={() => {
          if (confirm(`Delete “${name}” and its ${rows.length} cards from this phone?`)) onDelete();
        }}
      >
        Delete binder
      </button>
    </div>
  );
}
