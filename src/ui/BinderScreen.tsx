import { useEffect, useState } from 'react';
import { formatUSD, type CardDB } from '../core/carddb.ts';
import { shareFile } from '../app/diagnostics.ts';
import { exportReport, reportSummary, type ReportSummary } from '../app/report.ts';
import type { LivePrices } from '../app/session.ts';
import type { Collection, PriceHistory } from '../app/store.ts';
import { scryfallPage } from '../app/prices.ts';
import type { Baselines } from '../core/baselines.ts';
import { ownedRows, uniqueRows, type OwnedRow } from './HomeScreen.tsx';
import { CardsView, type CardItem } from './CardsView.tsx';

function toCSV(rows: OwnedRow[], db: CardDB): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = ['Name,Set,Set code,Collector number,Finish,Price USD,30-day change USD,Collection,Page,Slot,Scryfall ID'];
  for (const r of rows) {
    const info = db.info(r.card);
    lines.push(
      [info.name, info.setName, info.set, info.cn, r.finish, r.price?.toFixed(2) ?? '', r.trend?.gain30?.toFixed(2) ?? '', r.binder, String(r.page), String(r.slot), r.id].map(esc).join(','),
    );
  }
  return lines.join('\n');
}

function exportCSV(rows: OwnedRow[], db: CardDB, name: string) {
  void shareFile(new File([toCSV(rows, db)], `${name.replace(/[^\w-]+/g, '_')}.csv`, { type: 'text/csv' }), name);
}

function itemsFor(rows: OwnedRow[], db: CardDB, withBinder: boolean, binderOrder: string[]): CardItem[] {
  return rows.map((r) => {
    const info = db.info(r.card);
    return {
      key: `${r.binder}:${r.page}:${r.slot}:${r.id}`,
      card: r.card,
      finish: r.finish,
      price: r.price,
      trend: r.trend,
      location: `${withBinder ? `${r.binder} · ` : ''}page ${r.page} · slot ${r.slot}`,
      order: binderOrder.indexOf(r.binder) * 1e6 + r.page * 10 + r.slot,
      onOpen: () => window.open(scryfallPage(info.set, info.cn), '_blank', 'noopener'),
    };
  });
}

interface BinderProps {
  db: CardDB;
  name: string;
  collection: Collection;
  live: LivePrices;
  history: PriceHistory;
  baselines: Baselines | null;
  onBack: () => void;
  onDelete: () => void;
}

export function BinderScreen({ db, name, collection, live, history, baselines, onBack, onDelete }: BinderProps) {
  const rows = ownedRows(db, collection, live, history, baselines, name);
  const total = rows.reduce((t, r) => t + (r.price ?? 0), 0);
  const [report, setReport] = useState<ReportSummary | null>(null);
  const [sharing, setSharing] = useState(false);
  useEffect(() => {
    let live = true;
    void reportSummary(name).then((r) => live && setReport(r));
    return () => {
      live = false;
    };
  }, [name, collection]);
  const shareReport = async () => {
    setSharing(true);
    try {
      const file = await exportReport(name);
      if (file) await shareFile(file, `MTGDB scan report: ${name}`);
    } catch (e) {
      alert(`Could not make the scan report: ${(e as Error).message}`);
    } finally {
      setSharing(false);
    }
  };
  return (
    <div>
      <div className="topbar">
        <button className="back" onClick={onBack}>‹ Home</button>
        <h1 className="ellipsis">{name}</h1>
      </div>
      <div className="card">
        <div className="big-number">{formatUSD(total)}</div>
        <div className="row spread">
          <span className="muted small grow">{rows.length} cards</span>
          <button className="btn small" onClick={() => exportCSV(rows, db, name)}>Export CSV</button>
          <button
            className="btn small danger"
            onClick={() => {
              if (confirm(`Delete “${name}” and its ${rows.length} cards from this phone? This can’t be undone.`)) onDelete();
            }}
          >
            Delete collection
          </button>
        </div>
        {report && (
          <div className="row spread" style={{ marginTop: 10 }}>
            <span className="muted small grow">
              Scan report: {report.cards} cards, {report.changed} fixed by you{report.scans > 1 ? ` · ${report.scans} scans` : ''}
            </span>
            <button className="btn small" onClick={shareReport} disabled={sharing}>
              {sharing ? 'Preparing…' : 'Share scan report'}
            </button>
          </div>
        )}
      </div>
      <CardsView db={db} items={itemsFor(rows, db, false, [name])} storageKey="binder" defaultSort="price" />
    </div>
  );
}

interface AllProps {
  db: CardDB;
  collection: Collection;
  live: LivePrices;
  history: PriceHistory;
  baselines: Baselines | null;
  query?: string;
  onBack: () => void;
}

/** Every card in every binder (one entry per printing), to browse or to check whether you own a card. */
export function CollectionScreen({ db, collection, live, history, baselines, query, onBack }: AllProps) {
  const rows = uniqueRows(ownedRows(db, collection, live, history, baselines));
  const order = collection.binders.map((b) => b.name);
  return (
    <div>
      <div className="topbar">
        <button className="back" onClick={onBack}>‹ Home</button>
        <h1>All cards</h1>
        <button className="btn small" onClick={() => exportCSV(rows, db, 'collection')}>Export CSV</button>
      </div>
      <CardsView db={db} items={itemsFor(rows, db, true, order)} storageKey="all" defaultSort="price" initialQuery={query} autoFocusSearch={!query} emptyText="No cards saved yet. Scan some cards first." />
    </div>
  );
}
