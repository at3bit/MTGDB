// Results of a run: every spread, page by page, with a fix-up sheet per pocket.
import { useMemo, useState } from 'react';
import { formatUSD, type CardDB, type Finish } from '../core/carddb.ts';
import { pocketPrice, rankPrintings, spreadTotal, type LivePrices, type PocketView, type Spread } from '../app/session.ts';
import { scryfallImage } from '../app/prices.ts';

interface Props {
  db: CardDB;
  binder: string;
  spreads: Spread[];
  pagesPerSpread: number;
  live: LivePrices;
  ocrPending: number;
  onUpdate: (spreadId: number, pocket: PocketView) => void;
  onReadName: (spreadId: number, pocket: PocketView) => void;
  onSave: () => void;
  onDiscard: () => void;
}

const STATUS_LABEL = { matched: '', uncertain: 'Check', unknown: '?', empty: 'Empty' };

export function ReviewScreen({ db, binder, spreads, pagesPerSpread, live, ocrPending, onUpdate, onReadName, onSave, onDiscard }: Props) {
  const [open, setOpen] = useState<{ spread: number; page: number; slot: number } | null>(null);
  const total = spreads.reduce((t, s) => t + spreadTotal(db, s, live), 0);
  const counts = useMemo(() => {
    const c = { matched: 0, uncertain: 0, unknown: 0, empty: 0 };
    spreads.forEach((s) => s.pockets.forEach((p) => c[p.status]++));
    return c;
  }, [spreads]);
  const current = open && spreads.find((s) => s.id === open.spread)?.pockets.find((p) => p.page === open.page && p.slot === open.slot);

  return (
    <div>
      <div className="topbar">
        <button className="back" onClick={onDiscard}>‹ Discard</button>
        <h1 className="ellipsis">Review “{binder}”</h1>
      </div>
      <div className="card">
        <div className="row spread">
          <div>
            <div className="big-number">{formatUSD(total)}</div>
            <div className="muted small">
              {counts.matched} identified · {counts.uncertain + counts.unknown} to check · {counts.empty} empty · {spreads.length} spread{spreads.length === 1 ? '' : 's'}
            </div>
          </div>
        </div>
        {ocrPending > 0 && <div className="muted small" style={{ marginTop: 6 }}>Reading card names for {ocrPending} pocket{ocrPending === 1 ? '' : 's'}…</div>}
      </div>
      {spreads.length === 0 && (
        <div className="notice">
          No spreads were captured. Make sure the outline matches the pages and that each spread is held still for about a second.
        </div>
      )}
      {spreads.map((s, si) => (
        <div className="card" key={s.id}>
          <div className="row spread">
            <strong>Spread {si + 1}</strong>
            <span className="num">{formatUSD(spreadTotal(db, s, live))}</span>
          </div>
          <div className={pagesPerSpread === 2 ? 'pages-2' : ''}>
            {Array.from({ length: pagesPerSpread }, (_, page) => (
              <div key={page}>
                <div className="page-label">
                  Page {si * pagesPerSpread + page + 1}
                  {pagesPerSpread === 2 ? (page === 0 ? ' · left' : ' · right') : ''}
                </div>
                <div className="page-grid">
                  {s.pockets
                    .filter((p) => p.page === page)
                    .map((p) => {
                      const info = p.chosen !== null ? db.info(p.chosen) : null;
                      return (
                        <button key={p.slot} className={`tile ${p.status}`} onClick={() => setOpen({ spread: s.id, page: p.page, slot: p.slot })}>
                          <img src={p.thumbUrl} alt={info?.name ?? 'pocket'} />
                          <div className="name">{info ? info.name : STATUS_LABEL[p.status] || '—'}</div>
                          {p.printingCheck && <div className="price" style={{ color: 'var(--warn)' }}>Which printing?</div>}
                          <div className="price">
                            {info ? `${info.set.toUpperCase()} · ${formatUSD(pocketPrice(db, p, live))}` : ' '}
                            {p.finish !== 'nonfoil' && ' ✦'}
                          </div>
                        </button>
                      );
                    })}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      {current && open && (
        <PocketSheet
          db={db}
          live={live}
          pocket={current}
          onChange={(p) => onUpdate(open.spread, p)}
          onReadName={() => onReadName(open.spread, current)}
          onClose={() => setOpen(null)}
        />
      )}
      <div className="savebar">
        <div>
          <div className="grow">
            <div className="num" style={{ fontWeight: 700 }}>{formatUSD(total)}</div>
            <div className="muted small">{counts.uncertain + counts.unknown > 0 ? 'Tap orange/red pockets to check them' : 'All pockets identified'}</div>
          </div>
          <button className="btn primary" onClick={onSave} disabled={!spreads.length}>
            Save binder
          </button>
        </div>
      </div>
    </div>
  );
}

interface SheetProps {
  db: CardDB;
  live: LivePrices;
  pocket: PocketView;
  onChange: (p: PocketView) => void;
  onReadName: () => void;
  onClose: () => void;
}

function PocketSheet({ db, live, pocket, onChange, onReadName, onClose }: SheetProps) {
  const [query, setQuery] = useState('');
  const info = pocket.chosen !== null ? db.info(pocket.chosen) : null;
  const choose = (card: number) => {
    const fin = db.info(card).finishes;
    onChange({ ...pocket, chosen: card, status: 'matched', via: 'manual', printingCheck: false, finish: fin.includes(pocket.finish) ? pocket.finish : fin[0] });
  };
  const printings = info ? rankPrintings(db, db.nameOf[info.index], pocket).slice(0, 30) : [];
  const otherNames: number[] = [];
  for (const m of pocket.matches) {
    const n = db.nameOf[m.card];
    if ((!info || n !== db.nameOf[info.index]) && !otherNames.some((c) => db.nameOf[c] === n)) otherNames.push(m.card);
    if (otherNames.length >= 6) break;
  }
  const results = query.length >= 2 ? db.searchNames(query, 12) : [];

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="sheet" role="dialog" aria-label="Pocket details">
        <div className="compare">
          <figure>
            <img src={pocket.thumbUrl} alt="photo" />
            <figcaption>Your card</figcaption>
          </figure>
          <figure>
            {info ? <img src={scryfallImage(info.id)} alt={info.name} /> : <div style={{ aspectRatio: '63/88', background: '#000', borderRadius: 8 }} />}
            <figcaption>{info ? 'Match' : 'No match'}</figcaption>
          </figure>
        </div>
        {info ? (
          <>
            <h3>{info.name}</h3>
            <div className="muted small">
              {info.setName} ({info.set.toUpperCase()}) · #{info.cn} · {info.rarity}
            </div>
            <div className="row spread" style={{ marginTop: 10 }}>
              <div className="seg">
                {info.finishes.map((f: Finish) => (
                  <button key={f} className={pocket.finish === f ? 'on' : ''} onClick={() => onChange({ ...pocket, finish: f, via: pocket.via === 'image' ? 'image' : pocket.via })}>
                    {f === 'nonfoil' ? 'Regular' : f === 'foil' ? 'Foil' : 'Etched'}
                  </button>
                ))}
              </div>
              <div className="big-number" style={{ fontSize: 24 }}>{formatUSD(pocketPrice(db, pocket, live))}</div>
            </div>
          </>
        ) : (
          <h3>{pocket.status === 'empty' ? 'Empty pocket' : 'Not identified'}</h3>
        )}
        {pocket.ocrText != null && <div className="muted small" style={{ marginTop: 6 }}>Name read as “{pocket.ocrText || '…'}”</div>}
        {pocket.printingCheck && (
          <div className="notice" style={{ marginTop: 12, marginBottom: 0 }}>
            Several printings of this card look the same from the front but are priced differently. Check the set symbol, border and
            corners, then tap the right one below (or tap the current one to confirm it).
          </div>
        )}

        {printings.length > 1 && (
          <>
            <h4>Other printings</h4>
            <ul className="list">
              {printings.map(({ card }) => {
                const p = db.info(card);
                return (
                  <li key={card} className="tap" onClick={() => choose(card)}>
                    <img className="mini" src={scryfallImage(p.id, 'small')} alt="" loading="lazy" />
                    <div className="grow">
                      <div className="ellipsis">{p.setName}</div>
                      <div className="muted small">#{p.cn} · {p.set.toUpperCase()}</div>
                    </div>
                    <span className="num">{formatUSD(p.prices.nonfoil ?? p.prices.foil)}</span>
                    {card === pocket.chosen && <span className="badge ok">✓</span>}
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {otherNames.length > 0 && (
          <>
            <h4>Looks like</h4>
            <ul className="list">
              {otherNames.map((card) => {
                const p = db.info(card);
                return (
                  <li key={card} className="tap" onClick={() => choose(card)}>
                    <img className="mini" src={scryfallImage(p.id, 'small')} alt="" loading="lazy" />
                    <div className="grow ellipsis">{p.name}</div>
                    <span className="muted small">{p.set.toUpperCase()}</span>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        <h4>Search</h4>
        <input type="search" placeholder="Type a card name" value={query} onChange={(e) => setQuery(e.target.value)} />
        {results.length > 0 && (
          <ul className="list">
            {results.map((n) => {
              const best = rankPrintings(db, n, pocket)[0];
              return (
                <li key={n} className="tap" onClick={() => { choose(best.card); setQuery(''); }}>
                  <div className="grow ellipsis">{db.names[n]}</div>
                  <span className="muted small">{db.printings[n].length} printing{db.printings[n].length === 1 ? '' : 's'}</span>
                </li>
              );
            })}
          </ul>
        )}

        <div className="row" style={{ marginTop: 16, flexWrap: 'wrap' }}>
          {pocket.nameCrop && <button className="btn small" onClick={onReadName}>Read name again</button>}
          <button className="btn small" onClick={() => onChange({ ...pocket, chosen: null, status: 'empty', via: 'manual' })}>Mark empty</button>
          <div className="grow" />
          <button className="btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </>
  );
}
