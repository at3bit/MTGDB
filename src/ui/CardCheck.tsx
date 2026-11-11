// The card-by-card approval step: your photo next to the proposed match, which
// you swipe through the likely options (other printings, look-alikes) or
// replace by searching for the name. Name, edition and price are compared
// side by side; Save + continue moves to the next card.
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatUSD, type CardDB, type Finish } from '../core/carddb.ts';
import { approveEmpty, approvePocket, cardOptions, finishFor, nameUnsure, pocketPrice, type LivePrices, type PocketView } from '../app/session.ts';
import { scryfallImage } from '../app/prices.ts';
import { SYMBOL_REGION } from '../core/symbol.ts';

/** The set-symbol area of a printing's Scryfall image, to compare with the photo's. */
function SymbolZoom({ id }: { id: string }) {
  const [x0, y0, x1, y1] = SYMBOL_REGION;
  const w = x1 - x0, h = y1 - y0;
  return (
    <span
      className="symbol-zoom"
      title="This printing's set symbol"
      style={{
        backgroundImage: `url(${scryfallImage(id, 'normal')})`,
        backgroundSize: `${100 / w}% ${100 / h}%`,
        backgroundPosition: `${(x0 / (1 - w)) * 100}% ${(y0 / (1 - h)) * 100}%`,
      }}
    />
  );
}

const FINISH_LABEL: Record<Finish, string> = { nonfoil: 'Regular', foil: 'Foil', etched: 'Etched' };

interface Props {
  db: CardDB;
  live: LivePrices;
  pocket: PocketView;
  /** Where it is, e.g. "Page 3 (left) · slot 5". */
  location: string;
  /** Position in the list being checked (1-based) and its length; null when checking a single card. */
  position: { index: number; total: number } | null;
  onSave: (p: PocketView) => void;
  onBack: () => void;
  onClose: () => void;
  onReadName?: () => void;
}

export function CardCheck({ db, live, pocket, location, position, onSave, onBack, onClose, onReadName }: Props) {
  const [query, setQuery] = useState('');
  /** A name picked from the search: swipe through its printings instead. */
  const [searched, setSearched] = useState<number | null>(null);
  const options = useMemo(() => cardOptions(db, pocket, searched ?? undefined), [db, pocket, searched]);
  const [i, setI] = useState(0);
  const option = options[Math.min(i, options.length - 1)] ?? null;
  const info = option !== null ? db.info(option) : null;
  const current = pocket.chosen !== null ? db.info(pocket.chosen) : null;
  const [finish, setFinish] = useState<Finish>(pocket.finish);
  const optionFinish: Finish = info ? finishFor(db, info.index, finish) : finish;
  const results = query.trim().length >= 2 ? db.searchNames(query, 8) : [];

  // A new card (or a search): start from the first option.
  useEffect(() => {
    setI(0);
    setFinish(pocket.finish);
  }, [pocket.page, pocket.slot, location, searched]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setSearched(null);
    setQuery('');
  }, [location]);

  const go = (d: number) => setI((n) => Math.max(0, Math.min(options.length - 1, n + d)));
  const save = () => onSave(info ? approvePocket(pocket, info.index, optionFinish) : { ...pocket, approved: true });

  // Keyboard: ← → browse options, Enter saves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'Enter') save();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Load the neighbouring options' images ahead of a swipe.
  useEffect(() => {
    for (const d of [1, -1, 2]) {
      const c = options[i + d];
      if (c !== undefined) new Image().src = scryfallImage(db.info(c).id);
    }
  }, [i, options, db]);

  // Swipe on the match image.
  const drag = useRef<{ x: number; id: number } | null>(null);
  const [dx, setDx] = useState(0);
  const onDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, id: e.pointerId };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (drag.current?.id === e.pointerId) setDx(e.clientX - drag.current.x);
  };
  const onUp = (e: React.PointerEvent) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    if (dx < -40) go(1);
    else if (dx > 40) go(-1);
    setDx(0);
  };

  const unsure = nameUnsure(pocket);
  const note = pocket.ghost
    ? 'Seen through an empty sleeve: it’s recorded on the page where it really is. Save it here only if it really is in this sleeve.'
    : pocket.nameCheck === 'differs' && pocket.readName !== undefined
      ? `The picture looks like ${current?.name ?? 'another card'}, but the name on the card reads as ${db.names[pocket.readName]}. Swipe or search for the right one.`
      : unsure
        ? 'The app isn’t sure of this card. It isn’t saved until you check it.'
        : pocket.status === 'unknown'
          ? 'Not identified. Swipe through the closest matches or search for the name.'
          : pocket.printingCheck
            ? 'Several printings look alike but are priced differently: compare the set symbol and border, and swipe to the right one.'
            : pocket.seeThrough
              ? 'Hazier than the other cards on its page, as if behind an empty sleeve. If the sleeve is empty, mark it empty.'
              : null;
  const row = (label: string, a: string, b: string) => (
    <tr className={a !== b ? 'differs' : ''}>
      <th>{label}</th>
      <td>{a}</td>
      <td>{b}</td>
    </tr>
  );
  const edition = (c: ReturnType<CardDB['info']> | null) => (c ? `${c.setName} (${c.set.toUpperCase()} #${c.cn})` : '—');
  const price = (card: number | null, f: Finish) => (card === null ? '—' : formatUSD(pocketPrice(db, { chosen: card, finish: f }, live)));

  return (
    <div className="check" role="dialog" aria-label="Check card">
      <div className="topbar">
        <button className="back" onClick={onClose}>‹ Pages</button>
        <h1 className="ellipsis">{position ? `Card ${position.index} of ${position.total}` : 'Check card'}</h1>
      </div>
      <div className="muted small check-where">
        {location}
        {pocket.approved && ' · checked ✓'}
      </div>

      <div className="check-search">
        <input
          type="search"
          placeholder="Search the right card by name"
          aria-label="Search card name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {results.length > 0 && (
          <ul className="list check-results">
            {results.map((n) => (
              <li
                key={n}
                className="tap"
                onClick={() => {
                  setSearched(n);
                  setQuery('');
                }}
              >
                <div className="grow ellipsis">{db.names[n]}</div>
                <span className="muted small">{db.printingsOf(n).length} printing{db.printingsOf(n).length === 1 ? '' : 's'}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {searched !== null && (
        <div className="row small" style={{ gap: 8, marginBottom: 8 }}>
          <span className="muted">Printings of {db.names[searched]}</span>
          <button className="btn small" onClick={() => setSearched(null)}>Back to suggestions</button>
        </div>
      )}

      <div className="check-compare">
        <figure>
          <figcaption>Your card</figcaption>
          <img src={pocket.thumbUrl} alt="Your card" />
        </figure>
        <figure>
          <figcaption>
            Match {options.length > 0 && <span className="muted">{Math.min(i, options.length - 1) + 1} / {options.length}</span>}
          </figcaption>
          <div className="swipe" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
            {info ? (
              <img src={scryfallImage(info.id)} alt={info.name} draggable={false} style={{ transform: `translateX(${dx}px)`, transition: dx ? 'none' : 'transform 0.15s' }} />
            ) : (
              <div className="nomatch">No match yet: search for the name</div>
            )}
          </div>
          <div className="swipe-nav">
            <button className="btn small" aria-label="Previous option" disabled={i <= 0} onClick={() => go(-1)}>‹</button>
            <button className="btn small" aria-label="Next option" disabled={i >= options.length - 1} onClick={() => go(1)}>›</button>
          </div>
        </figure>
      </div>

      <table className="cmp-table">
        <thead>
          <tr>
            <th />
            <th>Scanned as</th>
            <th>This option</th>
          </tr>
        </thead>
        <tbody>
          {row('Name', current ? `${current.name}${unsure ? '?' : ''}` : pocket.status === 'unknown' ? 'Not identified' : '—', info?.name ?? '—')}
          {row('Edition', edition(current), edition(info))}
          {row(
            'Price',
            price(pocket.chosen, pocket.chosen === null ? pocket.finish : finishFor(db, pocket.chosen, pocket.finish)),
            price(info?.index ?? null, optionFinish),
          )}
        </tbody>
      </table>

      {info && info.finishes.length > 1 && (
        <div className="seg" style={{ marginTop: 10 }}>
          {info.finishes.map((f) => (
            <button key={f} className={optionFinish === f ? 'on' : ''} onClick={() => setFinish(f)}>
              {FINISH_LABEL[f]}
            </button>
          ))}
        </div>
      )}
      {pocket.symbolUrl && info && (
        <div className="row small muted" style={{ marginTop: 10, gap: 8 }}>
          <img className="symbol-zoom" src={pocket.symbolUrl} alt="Set symbol on your card" />
          <SymbolZoom id={info.id} />
          <span>Set symbol: yours, then this printing’s.</span>
        </div>
      )}
      {note && <div className="notice small" style={{ marginTop: 12, marginBottom: 0 }}>{note}</div>}
      {pocket.ocrText != null && <div className="muted small" style={{ marginTop: 8 }}>Name read from the card: “{pocket.ocrText || '…'}”</div>}
      <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
        {onReadName && pocket.nameCrop && <button className="btn small" onClick={onReadName}>Read name again</button>}
        <button className="btn small" onClick={() => onSave(approveEmpty(pocket))}>No card here (empty)</button>
      </div>

      <div className="check-bar">
        <div>
          <button className="btn" onClick={onBack}>‹ Back</button>
          <button className="btn primary grow" onClick={save}>
            {position ? 'Save + continue' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
