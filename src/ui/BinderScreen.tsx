import { useEffect, useMemo, useState } from 'react';
import { formatUSD, normalizeName, type CardDB } from '../core/carddb.ts';
import { shareFile } from '../app/diagnostics.ts';
import { exportReport, reportSummary, type ReportSummary } from '../app/report.ts';
import type { LivePrices } from '../app/session.ts';
import { rowValue, totals, type Collection, type PriceHistory } from '../app/store.ts';
import { scryfallArt } from '../app/prices.ts';
import type { Baselines } from '../core/baselines.ts';
import { change30, coverRow, ownedRows, type OwnedRow } from './HomeScreen.tsx';
import { CardRow, CardsView, type CardItem } from './CardsView.tsx';
import { ActionRow, ActionSheet, collectionMana, Icon, IconButton, PriceBadge } from './kit.tsx';

function toCSV(rows: OwnedRow[], db: CardDB): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = ['Name,Set,Set code,Collector number,Finish,Quantity,Price USD,Total USD,30-day change USD,Collection,Page,Slot,Scryfall ID'];
  for (const r of rows) {
    const info = db.info(r.card);
    lines.push(
      [info.name, info.setName, info.set, info.cn, r.finish, String(r.qty), r.price?.toFixed(2) ?? '', r.price == null ? '' : rowValue(r).toFixed(2), r.trend?.gain30?.toFixed(2) ?? '', r.binder, String(r.page), String(r.slot), r.id].map(esc).join(','),
    );
  }
  return lines.join('\n');
}

function exportCSV(rows: OwnedRow[], db: CardDB, name: string) {
  void shareFile(new File([toCSV(rows, db)], `${name.replace(/[^\w-]+/g, '_')}.csv`, { type: 'text/csv' }), name);
}

function itemsFor(rows: OwnedRow[], withBinder: boolean, binderOrder: string[], onOpenCard: (r: OwnedRow) => void): CardItem[] {
  return rows.map((r) => ({
    key: `${r.binder}:${r.page}:${r.slot}:${r.id}`,
    card: r.card,
    finish: r.finish,
    price: r.price,
    qty: r.qty,
    trend: r.trend,
    location: `${withBinder ? `${r.binder} · ` : ''}page ${r.page}, slot ${r.slot}`,
    order: binderOrder.indexOf(r.binder) * 1e6 + r.page * 10 + r.slot,
    onOpen: () => onOpenCard(r),
  }));
}

const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;

interface BinderProps {
  db: CardDB;
  name: string;
  collection: Collection;
  live: LivePrices;
  history: PriceHistory;
  baselines: Baselines | null;
  onBack: () => void;
  onDelete: () => void;
  onOpenCard: (row: OwnedRow) => void;
  /** Choose the card whose art represents the collection (null: its most valuable card). */
  onSetCover: (id: string | null) => void;
}

/** Pick the card whose art stands for the collection: its cards' art, most valuable first, with a search. */
function CoverPicker({ db, rows, current, onPick, onClose }: { db: CardDB; rows: OwnedRow[]; current?: string; onPick: (id: string | null) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const cards = useMemo(() => {
    const seen = new Set<string>();
    const nq = normalizeName(q);
    return [...rows]
      .sort((a, b) => (b.price ?? 0) - (a.price ?? 0))
      .filter((r) => !seen.has(r.id) && (seen.add(r.id), !nq || normalizeName(r.name).includes(nq) || normalizeName(db.info(r.card).setName).includes(nq)));
  }, [rows, q, db]);
  return (
    <ActionSheet title="Cover art" subtitle="The card whose art stands for this collection" onClose={onClose}>
      <div className="cover-picker">
        <button className={`btn block ${current ? 'quiet' : 'primary'}`} onClick={() => onPick(null)} aria-pressed={!current}>
          {current ? 'Use the most valuable card (automatic)' : '✓ Most valuable card (automatic)'}
        </button>
        <div className="search-field">
          <Icon name="search" size={20} />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search this collection" aria-label="Search this collection" />
        </div>
        <div className="art-grid" role="radiogroup" aria-label="Cover art">
          {cards.map((r) => (
            <button key={r.id} className={`art-tile${current === r.id ? ' picked' : ''}`} role="radio" aria-checked={current === r.id} onClick={() => onPick(r.id)}>
              <img src={scryfallArt(r.id)} alt="" loading="lazy" />
              <span className="card-name">{r.name}</span>
              <span className="price">{db.info(r.card).setName}</span>
            </button>
          ))}
        </div>
        {cards.length === 0 && <p className="muted small">No card in this collection matches “{q}”.</p>}
      </div>
    </ActionSheet>
  );
}

/** One collection: its header, the library (Gallery, List, Art) and a menu of rare actions. */
export function BinderScreen({ db, name, collection, live, history, baselines, onBack, onDelete, onOpenCard, onSetCover }: BinderProps) {
  const rows = ownedRows(db, collection, live, history, baselines, name);
  const binder = collection.binders.find((b) => b.name === name);
  const { value: total, count } = totals(rows);
  const change = change30(rows);
  const best = coverRow(rows, binder?.cover);
  const pages = new Set(rows.map((r) => r.page)).size;
  const mana = binder ? collectionMana(db, binder) : 'C';
  const [report, setReport] = useState<ReportSummary | null>(null);
  const [sharing, setSharing] = useState(false);
  const [menu, setMenu] = useState(false);
  const [picking, setPicking] = useState(false);
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
    <main>
      <header className={`hero mana-${mana}`}>
        {best && <img className="hero-art" src={scryfallArt(best.id)} alt="" />}
        <div className="hero-tint" />
        <div className="hero-shade" />
        <div className="nav">
          <IconButton icon="back" label="Back" onClick={onBack} />
          <IconButton icon="more" label="Collection actions" onClick={() => setMenu(true)} />
        </div>
        <p className="eyebrow">Collection</p>
        <h1 className="title-xl">{name}</h1>
        <div className="figures">
          <span className="money-l">{formatUSD(total)}</span>
          {change && Math.abs(change.gain) >= 0.05 && <PriceBadge change={change.gain} pct={change.pct} suffix="30 days" />}
        </div>
        <div className="small muted">
          {plural(count, 'card')} · {plural(pages, 'page')}
          {binder && ` · scanned ${new Date(binder.updatedAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}`}
        </div>
      </header>
      <CardsView db={db} items={itemsFor(rows, false, [name], onOpenCard)} storageKey="binder" defaultSort="price" />
      {menu && (
        <ActionSheet title={name} subtitle={`${plural(count, 'card')} · ${formatUSD(total)}`} onClose={() => setMenu(false)}>
          <ActionRow
            icon="image"
            label="Choose cover art"
            note={binder?.cover ? `Now: ${best?.name ?? 'a card no longer here'}` : 'Now: the most valuable card'}
            onClick={() => {
              setMenu(false);
              setPicking(true);
            }}
          />
          <ActionRow icon="download" label="Export CSV" onClick={() => exportCSV(rows, db, name)} />
          {report && (
            <ActionRow
              icon="share"
              label={sharing ? 'Preparing…' : 'Share scan report'}
              note={`Scan report: ${report.cards} cards, ${report.changed} fixed by you${report.scans > 1 ? ` · ${report.scans} scans` : ''}`}
              onClick={shareReport}
              disabled={sharing}
            />
          )}
          <ActionRow
            icon="trash"
            label="Delete collection"
            danger
            onClick={() => {
              if (confirm(`Delete “${name}” and its ${plural(count, 'card')} from this phone? This can’t be undone.`)) {
                setMenu(false);
                onDelete();
              }
            }}
          />
        </ActionSheet>
      )}
      {picking && (
        <CoverPicker
          db={db}
          rows={rows}
          current={binder?.cover}
          onPick={(id) => {
            onSetCover(id);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </main>
  );
}

interface SearchProps {
  db: CardDB;
  collection: Collection;
  live: LivePrices;
  history: PriceHistory;
  baselines: Baselines | null;
  query?: string;
  onOpenCard: (row: OwnedRow) => void;
}

/** One search across every collection ("do I own this?"), with matching cards you don't own yet. */
export function SearchScreen({ db, collection, live, history, baselines, query, onOpenCard }: SearchProps) {
  // Every stored card, so a card kept in two collections shows (and counts) in both.
  const rows = ownedRows(db, collection, live, history, baselines);
  const order = collection.binders.map((b) => b.name);
  const [q, setQ] = useState(query ?? '');
  const owned = useMemo(() => new Set(rows.map((r) => db.nameOf[r.card])), [rows, db]);
  // Cards not in any collection whose name matches: one regular printing each, most valuable first.
  const notOwned = useMemo(() => {
    const nq = normalizeName(q);
    if (nq.length < 3) return [];
    const names = new Set<number>();
    db.names.forEach((n, i) => {
      if (!owned.has(i) && normalizeName(n).includes(nq)) names.add(i);
    });
    if (!names.size) return [];
    const best = new Map<number, number>();
    for (let i = 0; i < db.count; i++) {
      const n = db.nameOf[i];
      if (!names.has(n)) continue;
      const cur = best.get(n);
      const info = db.info(i);
      if (cur === undefined) best.set(n, i);
      else {
        const c = db.info(cur);
        if (info.priority < c.priority || (info.priority === c.priority && (info.prices.nonfoil ?? Infinity) < (c.prices.nonfoil ?? Infinity))) best.set(n, i);
      }
    }
    return [...best.values()].map((i) => db.info(i)).sort((a, b) => (b.prices.nonfoil ?? 0) - (a.prices.nonfoil ?? 0));
  }, [q, db, owned]);
  return (
    <main>
      <h1 className="title-l" style={{ margin: '12px 0 16px' }}>Search</h1>
      <CardsView
        db={db}
        items={itemsFor(rows, true, order, onOpenCard)}
        storageKey="all"
        defaultSort="price"
        initialQuery={query}
        autoFocusSearch={!query}
        searchPlaceholder="Card or set name"
        onQuery={setQ}
        emptyText="No cards saved yet. Scan some cards first."
      />
      {notOwned.length > 0 && (
        <section aria-labelledby="not-owned" style={{ marginTop: 8 }}>
          <h2 className="eyebrow" id="not-owned" style={{ color: 'var(--muted)', marginBottom: 4 }}>Not in your collections · {notOwned.length}</h2>
          {notOwned.slice(0, 5).map((info) => (
            <CardRow
              key={info.id}
              id={info.id}
              name={info.name}
              meta={`${info.setName} · you don’t own this yet`}
              price={info.prices.nonfoil ?? info.prices.foil}
              onOpen={() => window.open(`https://scryfall.com/search?q=${encodeURIComponent(`!"${info.name}"`)}`, '_blank', 'noopener')}
            />
          ))}
        </section>
      )}
      {rows.length > 0 && (
        <button className="btn quiet block" style={{ marginTop: 16 }} onClick={() => exportCSV(rows, db, 'collection')}>
          Export every card (CSV)
        </button>
      )}
    </main>
  );
}
