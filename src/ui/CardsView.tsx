// A list of cards with Gallery / List / Art views, sorting and name search. Used
// for scan results, a collection, and search across every collection.
import { useMemo, useState, type ReactNode } from 'react';
import { formatUSD, normalizeName, type CardDB, type Finish } from '../core/carddb.ts';
import type { Trend } from '../app/store.ts';
import { scryfallArt, scryfallImage } from '../app/prices.ts';
import { Icon } from './kit.tsx';

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
  { key: 'order', label: 'Page order' },
  { key: 'price', label: 'Highest price' },
  { key: 'gain', label: 'Biggest gain, 30 days ($)' },
  { key: 'gainPct', label: 'Biggest gain, 30 days (%)' },
  { key: 'drop', label: 'Biggest drop, 30 days' },
  { key: 'name', label: 'Name A–Z' },
  { key: 'set', label: 'Set' },
];

export type ViewMode = 'gallery' | 'list' | 'art';
const VIEW_LABEL: Record<ViewMode, string> = { gallery: 'Gallery', list: 'List', art: 'Art' };

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

/** 30-day change, shown when it's at least 5 cents and 1%. */
export function ChangeBadge({ trend }: { trend: Trend | null }) {
  if (!trend || trend.gain30 == null || trend.pct30 == null || Math.abs(trend.gain30) < 0.05 || Math.abs(trend.pct30) < 0.01) return null;
  const up = trend.gain30 > 0;
  const pct = `${(Math.abs(trend.pct30) * 100).toFixed(1)}%`;
  return (
    <span className={`badge ${up ? 'up' : 'down'}`} title={`${up ? '+' : '−'}${formatUSD(Math.abs(trend.gain30))} over the last 30 days`} aria-label={`${up ? 'Up' : 'Down'} ${pct} in 30 days`}>
      <span aria-hidden="true">{up ? '▲' : '▼'}</span> {pct}
    </span>
  );
}

/** One card in a list: scan, name, where it is, price and its 30-day change. */
export function CardRow({ id, thumb, name, finish, meta, price, trend, flag, onOpen }: { id?: string; thumb?: string; name: string; finish?: Finish; meta: string; price: number | null; trend?: Trend | null; flag?: string; onOpen?: () => void }) {
  const src = thumb ?? (id ? scryfallImage(id, 'small') : '');
  return (
    <button className="card-row" onClick={onOpen} disabled={!onOpen}>
      {src ? <img src={src} alt="" loading="lazy" /> : <span style={{ width: 40, height: 56, flex: 'none', borderRadius: 3, background: 'var(--raised)' }} />}
      <span className="grow">
        <span className="card-name ellipsis" style={{ display: 'block' }}>
          {name}
          {finish && finish !== 'nonfoil' ? ' ✦' : ''}
        </span>
        <span className="meta ellipsis" style={{ display: 'block' }}>{meta}</span>
        {flag && <span className="badge warn" style={{ marginTop: 4 }}>{flag}</span>}
      </span>
      <span className="right">
        <span className="price num">{formatUSD(price)}</span>
        <ChangeBadge trend={trend ?? null} />
      </span>
    </button>
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
  /** Views offered (the scan review has no Art view: its cards are photos). */
  views?: ViewMode[];
  /** Scan results: tiles show whether each card still needs checking. */
  statusTiles?: boolean;
  /** Placeholder for the search field. */
  searchPlaceholder?: string;
  /** Called as the search text changes (the Search tab adds cards you don't own). */
  onQuery?: (q: string) => void;
}

export function CardsView({ db, items, storageKey, defaultSort = 'order', initialQuery = '', autoFocusSearch, orderGallery, emptyText, views = ['gallery', 'list', 'art'], statusTiles, searchPlaceholder, onQuery }: Props) {
  const [view, setView] = useState<ViewMode>(() => {
    const v = load(`mtgdb-view-${storageKey}`, 'gallery') as ViewMode;
    return views.includes(v) ? v : 'gallery';
  });
  const [sort, setSort] = useState<SortKey>(() => (load(`mtgdb-sort-${storageKey}`, defaultSort) as SortKey) || defaultSort);
  const [query, setQueryState] = useState(initialQuery);
  const setQuery = (q: string) => {
    setQueryState(q);
    onQuery?.(q);
  };

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
  const nameFor = (it: CardItem) => (it.card !== null ? db.info(it.card).name : 'Not identified');

  return (
    <div>
      <div className="library-controls">
        {views.length > 1 && (
          <div className="seg" role="group" aria-label="View">
            {views.map((v) => (
              <button key={v} className={view === v ? 'on' : ''} onClick={() => setViewSaved(v)} aria-pressed={view === v}>
                {VIEW_LABEL[v]}
              </button>
            ))}
          </div>
        )}
        <div className="search-row">
          <label className="search-field">
            <Icon name="search" size={20} />
            <input type="search" placeholder={searchPlaceholder ?? 'Search'} value={query} onChange={(e) => setQuery(e.target.value)} autoFocus={autoFocusSearch} aria-label="Search cards" />
          </label>
          <select className="select" value={sort} onChange={(e) => setSortSaved(e.target.value as SortKey)} aria-label="Sort by">
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
        </div>
        <div className="library-summary" data-testid="cards-summary">
          {query ? `${shown.length} match${shown.length === 1 ? '' : 'es'} for “${query}”` : `${shown.length} card${shown.length === 1 ? '' : 's'}`} · {formatUSD(total)}
        </div>
      </div>

      {shown.length === 0 && <div className="notice">{query ? `No card matching “${query}” here.` : emptyText ?? 'No cards yet.'}</div>}

      {useOrderGallery ? (
        orderGallery!()
      ) : view === 'gallery' ? (
        <div className="card-grid">
          {shown.map((it) => {
            const info = it.card !== null ? db.info(it.card) : null;
            const src = it.thumb ?? (info ? scryfallImage(info.id, 'small') : '');
            return statusTiles ? (
              <button key={it.key} className={`tile ${it.flagged ? 'uncertain' : info ? 'matched' : 'unknown'}`} onClick={it.onOpen}>
                <img src={src} alt={info?.name ?? 'pocket'} loading="lazy" />
                <div className="name">{info ? info.name : 'Not identified'}{it.finish !== 'nonfoil' ? ' ✦' : ''}</div>
                {it.note && <div className="price" style={{ color: 'var(--warn)' }}>{it.note}</div>}
                <div className="price">{info ? `${info.set.toUpperCase()} · ${formatUSD(it.price)}` : it.location}</div>
              </button>
            ) : (
              <button key={it.key} className="ctard" onClick={it.onOpen}>
                <img src={src} alt={info?.name ?? 'Unidentified card'} loading="lazy" />
                <span className="name">{nameFor(it)}{it.finish !== 'nonfoil' ? ' ✦' : ''}</span>
                <span className="price">{formatUSD(it.price)}</span>
              </button>
            );
          })}
        </div>
      ) : view === 'art' ? (
        <div className="art-grid">
          {shown.map((it) => {
            const info = it.card !== null ? db.info(it.card) : null;
            return (
              <button key={it.key} className="art-tile" onClick={it.onOpen}>
                {info && <img src={scryfallArt(info.id)} alt="" loading="lazy" />}
                <span className="card-name">{nameFor(it)}</span>
                <span className="price">{formatUSD(it.price)}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <ul className="list" data-testid="cards-list">
          {shown.map((it) => {
            const info = it.card !== null ? db.info(it.card) : null;
            return (
              <li key={it.key} style={{ padding: 0, borderTop: 0 }}>
                <CardRow
                  id={info?.id}
                  thumb={it.thumb}
                  name={nameFor(it)}
                  finish={it.finish}
                  meta={`${info ? `${info.setName} #${info.cn} · ` : ''}${it.location}`}
                  price={it.price}
                  trend={it.trend}
                  flag={it.flagged ? it.note ?? 'Check' : undefined}
                  onOpen={it.onOpen}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
