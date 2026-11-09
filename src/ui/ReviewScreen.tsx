// Results of a run: every spread, page by page (or as a sortable, searchable
// list / gallery), with a fix-up sheet per pocket.
import { useMemo, useState } from 'react';
import { formatUSD, type CardDB, type Finish } from '../core/carddb.ts';
import type { Baselines } from '../core/baselines.ts';
import { binderEntries, needsCheck, pocketPrice, rankPrintings, spreadTotal, type LivePrices, type PocketView, type Spread } from '../app/session.ts';
import { trendFor, type PriceHistory } from '../app/store.ts';
import { scryfallImage } from '../app/prices.ts';
import { CardsView, type CardItem } from './CardsView.tsx';
import { SYMBOL_REGION } from '../core/symbol.ts';

/** The set-symbol area of a printing's Scryfall image, zoomed with CSS (no extra download beyond the image). */
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

interface Props {
  db: CardDB;
  binder: string;
  spreads: Spread[];
  pagesPerSpread: number;
  live: LivePrices;
  history: PriceHistory;
  baselines: Baselines | null;
  ocrPending: number;
  runStats: { captures: number; repeats: number; reread: number };
  onUpdate: (spreadId: number, pocket: PocketView) => void;
  onReadName: (spreadId: number, pocket: PocketView) => void;
  onSave: () => void;
  onDiscard: () => void;
}

/** What a pocket tile says when it isn't showing a card name. */
function pocketLabel(p: PocketView): string {
  if (p.cardBack) return 'Card back';
  if (p.status === 'empty') return 'Empty';
  if (p.status === 'unknown') return '?';
  return 'Check';
}

function pocketClass(p: PocketView): string {
  if (p.ghost) return 'ghost';
  if (p.cardBack) return 'empty';
  if (p.status === 'empty' || p.status === 'unknown') return p.status;
  return needsCheck(p) ? 'uncertain' : 'matched';
}

export function ReviewScreen({ db, binder, spreads, pagesPerSpread, live, history, baselines, ocrPending, runStats, onUpdate, onReadName, onSave, onDiscard }: Props) {
  const [open, setOpen] = useState<{ spread: number; page: number; slot: number } | null>(null);
  // What saving would store: one entry per printing, without see-through cards and card backs.
  const entries = useMemo(() => binderEntries(spreads, pagesPerSpread, db), [spreads, pagesPerSpread, db]);
  const total = entries.reduce((t, e) => t + (pocketPrice(db, { chosen: e.card, finish: e.finish }, live) ?? 0), 0);
  const counts = useMemo(() => {
    const c = { identified: 0, check: 0, empty: 0, seeThrough: 0 };
    spreads.forEach((s) =>
      s.pockets.forEach((p) => {
        if (p.ghost) c.seeThrough++;
        else if (p.status === 'empty' || p.cardBack) c.empty++;
        else if (needsCheck(p)) c.check++;
        else c.identified++;
      }),
    );
    return c;
  }, [spreads]);
  const current = open && spreads.find((s) => s.id === open.spread)?.pockets.find((p) => p.page === open.page && p.slot === open.slot);
  const pageName = (si: number, page: number) => `Page ${si * pagesPerSpread + page + 1}${pagesPerSpread === 2 ? (page === 0 ? ' (left)' : ' (right)') : ''}`;

  const items: CardItem[] = useMemo(
    () =>
      spreads.flatMap((s, si) =>
        s.pockets
          .filter((p) => !p.ghost && !p.cardBack && p.status !== 'empty')
          .map((p) => {
            const price = pocketPrice(db, p, live);
            const info = p.chosen !== null ? db.info(p.chosen) : null;
            return {
              key: `${s.id}:${p.page}:${p.slot}`,
              card: p.chosen,
              finish: p.finish,
              price,
              trend: info ? trendFor(history, info.id, p.finish, price, baselines?.get(p.chosen!, p.finish)) : null,
              location: `${pageName(si, p.page)} · slot ${p.slot + 1}`,
              order: si * 100 + p.page * 10 + p.slot,
              thumb: p.thumbUrl,
              flagged: needsCheck(p),
              note: p.printingCheck ? 'Which printing?' : p.seeThrough ? 'Through a sleeve?' : undefined,
              onOpen: () => setOpen({ spread: s.id, page: p.page, slot: p.slot }),
            };
          }),
      ),
    [spreads, db, live, history, baselines, pagesPerSpread], // pageName depends only on pagesPerSpread
  );

  const pageGrids = () =>
    spreads.map((s, si) => (
      <div className="card" key={s.id}>
        <div className="row spread">
          <strong>Spread {si + 1}</strong>
          <span className="num">{formatUSD(spreadTotal(db, s, live))}</span>
        </div>
        <div className={pagesPerSpread === 2 ? 'pages-2' : ''}>
          {Array.from({ length: pagesPerSpread }, (_, page) => (
            <div key={page}>
              <div className="page-label">{pageName(si, page)}</div>
              <div className="page-grid">
                {s.pockets
                  .filter((p) => p.page === page)
                  .map((p) => {
                    const info = p.chosen !== null && !p.cardBack ? db.info(p.chosen) : null;
                    return (
                      <button key={p.slot} className={`tile ${pocketClass(p)}`} onClick={() => setOpen({ spread: s.id, page: p.page, slot: p.slot })}>
                        <img src={p.thumbUrl} alt={info?.name ?? 'pocket'} />
                        <div className="name">{p.ghost ? 'Seen through sleeve' : info ? info.name : pocketLabel(p)}</div>
                        {!p.ghost && p.printingCheck && <div className="price" style={{ color: 'var(--warn)' }}>Which printing?</div>}
                        {!p.ghost && p.seeThrough && <div className="price" style={{ color: 'var(--warn)' }}>Through a sleeve?</div>}
                        <div className="price">
                          {p.ghost && info ? info.name : info ? `${info.set.toUpperCase()} · ${formatUSD(pocketPrice(db, p, live))}` : ' '}
                          {!p.ghost && p.finish !== 'nonfoil' && ' ✦'}
                        </div>
                      </button>
                    );
                  })}
              </div>
            </div>
          ))}
        </div>
      </div>
    ));

  return (
    <div>
      <div className="topbar">
        <button className="back" onClick={onDiscard}>‹ Discard</button>
        <h1 className="ellipsis">Review “{binder}”</h1>
      </div>
      <div className="card">
        <div className="big-number">{formatUSD(total)}</div>
        <div className="muted small">
          {entries.length} card{entries.length === 1 ? '' : 's'} · {counts.check} to check · {counts.empty} empty
          {counts.seeThrough > 0 && ` · ${counts.seeThrough} seen through empty sleeves (counted on their own page)`}
        </div>
        {runStats.captures > 0 && (
          <div className="muted small" style={{ marginTop: 6 }} data-testid="run-stats">
            {spreads.length} spread{spreads.length === 1 ? '' : 's'} ({spreads.length * pagesPerSpread} pages) from {runStats.captures} capture{runStats.captures === 1 ? '' : 's'}
            {runStats.repeats > 0 && ` · ${runStats.repeats} repeat${runStats.repeats === 1 ? '' : 's'} merged`}
            {runStats.reread > 0 && ` · ${runStats.reread} page${runStats.reread === 1 ? '' : 's'} re-read`}
            . Fewer pages than your binder has? Pause about half a second on each spread, or use Snap page.
          </div>
        )}
        {ocrPending > 0 && <div className="muted small" style={{ marginTop: 6 }}>Reading card names for {ocrPending} pocket{ocrPending === 1 ? '' : 's'}… wait for this before saving.</div>}
      </div>
      {spreads.length === 0 ? (
        <div className="notice">No spreads were captured. Make sure the outline matches the pages and that each spread is held still for about half a second.</div>
      ) : (
        <CardsView db={db} items={items} storageKey="review" orderGallery={pageGrids} />
      )}
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
            <div className="muted small">{counts.check > 0 ? `${counts.check} to check (orange/red)` : 'All pockets identified'}</div>
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
    onChange({ ...pocket, chosen: card, status: 'matched', via: 'manual', printingCheck: false, ghost: false, seeThrough: false, cardBack: false, finish: fin.includes(pocket.finish) ? pocket.finish : fin[0] });
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
        {pocket.ghost && (
          <div className="notice" style={{ marginTop: 12, marginBottom: 0 }}>
            This card was seen through an empty sleeve. It's recorded on the page where it actually is, not here. If it really is in
            this sleeve, tap it in the list below to keep it here too.
          </div>
        )}
        {pocket.seeThrough && (
          <div className="notice" style={{ marginTop: 12, marginBottom: 0 }}>
            This card looks hazier than the others on its page, as if it's behind an empty sleeve. If the sleeve is empty, tap Mark empty.
          </div>
        )}
        {pocket.cardBack && <div className="muted small" style={{ marginTop: 6 }}>This sleeve shows the back of a card (in the sleeve's other side), so it's treated as empty.</div>}
        {pocket.printingCheck && (
          <div className="notice" style={{ marginTop: 12, marginBottom: 0 }}>
            Several printings of this card look the same from the front but are priced differently. Check the set symbol, border and
            corners, then tap the right one below (or tap the current one to confirm it).
          </div>
        )}

        {printings.length > 1 && (
          <>
            <h4>Other printings</h4>
            {pocket.symbolUrl && (
              <div className="row small muted" style={{ marginBottom: 6 }}>
                <img className="symbol-zoom" src={pocket.symbolUrl} alt="Set symbol on your card" />
                <span>Your card’s set symbol. Compare it with each printing’s (right).</span>
              </div>
            )}
            <ul className="list">
              {printings.map(({ card }, i) => {
                const p = db.info(card);
                return (
                  <li key={card} className="tap" onClick={() => choose(card)}>
                    <img className="mini" src={scryfallImage(p.id, 'small')} alt="" loading="lazy" />
                    <div className="grow">
                      <div className="ellipsis">{p.setName}</div>
                      <div className="muted small">#{p.cn} · {p.set.toUpperCase()}</div>
                    </div>
                    <span className="num">{formatUSD(p.prices.nonfoil ?? p.prices.foil)}</span>
                    {pocket.symbolUrl && i < 6 && <SymbolZoom id={p.id} />}
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
          <button className="btn small" onClick={() => onChange({ ...pocket, chosen: null, status: 'empty', via: 'manual', seeThrough: false })}>Mark empty</button>
          <div className="grow" />
          <button className="btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </>
  );
}
