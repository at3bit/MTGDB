// A list of cards with a gallery/list toggle, sorting and name search. Used
// for scan results, a binder, and the whole collection.
import { useMemo, useState, type ReactNode } from 'react';
import { formatUSD, normalizeName, type CardDB, type Finish } from '../core/carddb.ts';
import type { Trend } from '../app/store.ts';
import { scryfallImage } from '../app/prices.ts';

export interface CardItem {
  key: string;
  /** Index into the CardDB, or null for a pocket that wasn't identified. */
  card: number | null;
  finish: Finish;
  price: number | null;
  trend: Trend | null;
  /** Where it is, e.g. "Trade Binder · page 5 · slot 3". */
  location: string;
  /** Position in binder order. */
  order: number;
  /** The photographed card (scan results); otherwise Scryfall's image is shown. */
  thumb?: string;
  /** Needs checking (shown orange). */
  flagged?: boolean;
  /** Short note, e.g. "Which printing?". */
  note?: string;
  onOpen?: () => void;
}

export type SortKey = 'order' | 'price' | 'gain' | 'gainPct' | 'drop' | 'name' | 'set';

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'order', label: 'Binder order' },
  { key: 'price', label: 'Highest price' },
  { key: 'gain', label: 'Biggest gain, 30 days ($)' },
  { key: 'gainPct', label: 'Biggest gain, 30 days (%)' },
  { key: 'drop', label: 'Biggest drop, 30 days' },
  { key: 'name', label: 'Name A–Z' },
  { key: 'set', label: 'Set' },
];

type ViewMode = 'gallery' | 'list';

const load = (k: string, d: string) => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};
const save = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
};

export function ChangeBadge({ trend }: { trend: Trend | null }) {
  if (!trend || trend.gain30 == null || trend.pct30 == null || Math.abs(trend.gain30) < 0.01) return null;
  const up = trend.gain30 > 0;
  return (
    <span className={`badge ${up ? 'up' : 'down'}`} title="Change over the last 30 days">
      {up ? '▲' : '▼'} {formatUSD(Math.abs(trend.gain30))} ({Math.round(Math.abs(trend.pct30) * 100)}%)
    </span>
  );
}

interface Props {
  db: CardDB;
  items: CardItem[];
  /** Remembers the view and sort per screen. */
  storageKey: string;
  defaultSort?: SortKey;
  initialQuery?: string;
  autoFocusSearch?: boolean;
  /** Gallery in binder order can be drawn by the caller (e.g. page grids on the review screen). */
  orderGallery?: () => ReactNode;
  emptyText?: string;
}

export function CardsView({ db, items, storageKey, defaultSort = 'order', initialQuery = '', autoFocusSearch, orderGallery, emptyText }: Props) {
  const [view, setView] = useState<ViewMode>(() => (load(`mtgdb-view-${storageKey}`, 'gallery') === 'list' ? 'list' : 'gallery'));
  const [sort, setSort] = useState<SortKey>(() => (load(`mtgdb-sort-${storageKey}`, defaultSort) as SortKey) || defaultSort);
  const [query, setQuery] = useState(initialQuery);

  const shown = useMemo(() => {
    const q = normalizeName(query);
    const nameOf = (it: CardItem) => (it.card === null ? '' : db.names[db.nameOf[it.card]]);
    let list = items;
    if (q) {
      list = items.filter((it) => {
        if (it.card === null) return false;
        const info = db.info(it.card);
        return normalizeName(info.name).includes(q) || normalizeName(info.setName).includes(q) || info.set === q;
      });
    }
    const last = (v: number | null | undefined, dir: 1 | -1) => (v == null || Number.isNaN(v) ? Infinity : dir * v);
    const by: Record<SortKey, (a: CardItem, b: CardItem) => number> = {
      order: (a, b) => a.order - b.order,
      price: (a, b) => last(a.price, -1) - last(b.price, -1),
      gain: (a, b) => last(a.trend?.gain30, -1) - last(b.trend?.gain30, -1),
      gainPct: (a, b) => last(a.trend?.pct30, -1) - last(b.trend?.pct30, -1),
      drop: (a, b) => last(a.trend?.gain30, 1) - last(b.trend?.gain30, 1),
      name: (a, b) => (a.card === null ? 1 : b.card === null ? -1 : nameOf(a).localeCompare(nameOf(b))),
      set: (a, b) => {
        if (a.card === null || b.card === null) return a.card === null ? 1 : -1;
        const ia = db.info(a.card), ib = db.info(b.card);
        return ia.setName.localeCompare(ib.setName) || ia.cn.localeCompare(ib.cn, undefined, { numeric: true });
      },
    };
    return [...list].sort((a, b) => by[sort](a, b) || a.order - b.order);
  }, [items, query, sort, db]);

  const total = shown.reduce((t, it) => t + (it.price ?? 0), 0);
  const setViewSaved = (v: ViewMode) => {
    setView(v);
    save(`mtgdb-view-${storageKey}`, v);
  };
  const setSortSaved = (s: SortKey) => {
    setSort(s);
    save(`mtgdb-sort-${storageKey}`, s);
  };
  const useOrderGallery = view === 'gallery' && sort === 'order' && !query && orderGallery;

  return (
    <div>
      <div className="card stack" style={{ paddingBottom: 12 }}>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <div className="seg" role="tablist" aria-label="View">
            <button className={view === 'gallery' ? 'on' : ''} onClick={() => setViewSaved('gallery')} aria-pressed={view === 'gallery'}>Gallery</button>
            <button className={view === 'list' ? 'on' : ''} onClick={() => setViewSaved('list')} aria-pressed={view === 'list'}>List</button>
          </div>
          <select className="select grow" value={sort} onChange={(e) => setSortSaved(e.target.value as SortKey)} aria-label="Sort by">
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>Sort: {s.label}</option>
            ))}
          </select>
        </div>
        <input type="search" placeholder="Search by card or set name" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus={autoFocusSearch} aria-label="Search cards" />
        <div className="muted small" data-testid="cards-summary">
          {query ? `${shown.length} match${shown.length === 1 ? '' : 'es'} for “${query}”` : `${shown.length} card${shown.length === 1 ? '' : 's'}`} · {formatUSD(total)}
        </div>
      </div>

      {shown.length === 0 && <div className="notice">{query ? `No card matching “${query}”.` : emptyText ?? 'No cards yet.'}</div>}

      {useOrderGallery ? (
        orderGallery!()
      ) : view === 'gallery' ? (
        <div className="card-grid">
          {shown.map((it) => {
            const info = it.card !== null ? db.info(it.card) : null;
            return (
              <button key={it.key} className={`tile ${it.flagged ? 'uncertain' : info ? 'matched' : 'unknown'}`} onClick={it.onOpen}>
                <img src={it.thumb ?? (info ? scryfallImage(info.id, 'small') : '')} alt={info?.name ?? 'pocket'} loading="lazy" />
                <div className="name">{info ? info.name : 'Not identified'}{it.finish !== 'nonfoil' ? ' ✦' : ''}</div>
                {it.note && <div className="price" style={{ color: 'var(--warn)' }}>{it.note}</div>}
                <div className="price">{info ? `${info.set.toUpperCase()} · ${formatUSD(it.price)}` : it.location}</div>
                <ChangeBadge trend={it.trend} />
              </button>
            );
          })}
        </div>
      ) : (
        <div className="card">
          <ul className="list" data-testid="cards-list">
            {shown.map((it) => {
              const info = it.card !== null ? db.info(it.card) : null;
              return (
                <li key={it.key} className={it.onOpen ? 'tap' : ''} onClick={it.onOpen}>
                  <img className="mini" src={it.thumb ?? (info ? scryfallImage(info.id, 'small') : '')} alt="" loading="lazy" />
                  <div className="grow">
                    <div className="ellipsis">
                      {info ? info.name : 'Not identified'}
                      {it.finish !== 'nonfoil' ? ' ✦' : ''}
                      {it.flagged && <span className="badge warn" style={{ marginLeft: 6 }}>{it.note ?? 'Check'}</span>}
                    </div>
                    <div className="muted small ellipsis">{info ? `${info.set.toUpperCase()} #${info.cn} · ` : ''}{it.location}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="num">{formatUSD(it.price)}</div>
                    <ChangeBadge trend={it.trend} />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
