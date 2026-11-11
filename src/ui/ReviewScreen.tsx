// Results of a run: every spread, page by page (or as a sortable, searchable
// list / gallery), and the card-by-card check (CardCheck) before saving.
import { useMemo, useState } from 'react';
import { diagnostics, shareDiagnostics } from '../app/diagnostics.ts';
import { formatUSD, type CardDB } from '../core/carddb.ts';
import type { Baselines } from '../core/baselines.ts';
import { binderEntries, checkList, findPocket, nameUnsure, needsCheck, pocketPrice, spreadTotal, type PocketKey, type LivePrices, type PocketView, type Spread } from '../app/session.ts';
import { trendFor, type PriceHistory } from '../app/store.ts';
import { CardsView, type CardItem } from './CardsView.tsx';
import { CardCheck } from './CardCheck.tsx';

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
  /** Start the card-by-card check straight away (right after a scan). */
  checkOnOpen?: boolean;
}

/** What a pocket tile says when it isn't showing a card name. */
function pocketLabel(p: PocketView): string {
  if (p.cardBack) return 'Card back';
  if (p.status === 'empty') return 'Empty';
  if (p.status === 'unknown') return 'Not identified';
  return 'Check';
}

/** A tile's name line: unsure names are shown as a question. */
function tileName(db: CardDB, p: PocketView): string {
  if (p.ghost) return 'Seen through sleeve';
  if (p.chosen === null || p.cardBack) return pocketLabel(p);
  if (nameUnsure(p)) return `${db.info(p.chosen).name}?`;
  return p.approved ? `✓ ${db.info(p.chosen).name}` : db.info(p.chosen).name;
}

function pocketClass(p: PocketView): string {
  if (p.ghost) return 'ghost';
  if (p.cardBack) return 'empty';
  if (p.status === 'empty' || p.status === 'unknown') return p.status;
  return needsCheck(p) ? 'uncertain' : 'matched';
}

export function ReviewScreen({ db, binder, spreads, pagesPerSpread, live, history, baselines, ocrPending, runStats, onUpdate, onReadName, onSave, onDiscard, checkOnOpen }: Props) {
  const [sharing, setSharing] = useState(false);
  /** The card-by-card check: the pockets being checked and which one is showing (index === length: all done). */
  const [check, setCheck] = useState<{ keys: PocketKey[]; i: number; single: boolean } | null>(() => {
    if (!checkOnOpen) return null;
    const keys = checkList(spreads);
    return keys.length ? { keys, i: 0, single: false } : null;
  });
  const openOne = (k: PocketKey) => setCheck({ keys: [k], i: 0, single: true });
  const startCheck = () => {
    const keys = checkList(spreads);
    const first = keys.findIndex((k) => !findPocket(spreads, k)?.approved);
    setCheck({ keys, i: Math.max(0, first), single: false });
  };
  // What saving would store: one entry per printing, without see-through cards and card backs.
  const entries = useMemo(() => binderEntries(spreads, pagesPerSpread, db), [spreads, pagesPerSpread, db]);
  const total = entries.reduce((t, e) => t + (pocketPrice(db, { chosen: e.card, finish: e.finish }, live) ?? 0), 0);
  const counts = useMemo(() => {
    const c = { identified: 0, check: 0, empty: 0, seeThrough: 0, unsure: 0 };
    spreads.forEach((s) =>
      s.pockets.forEach((p) => {
        if (p.ghost) c.seeThrough++;
        else if (p.status === 'empty' || p.cardBack) c.empty++;
        else if (needsCheck(p)) c.check++;
        else c.identified++;
        if (!p.ghost && nameUnsure(p)) c.unsure++;
      }),
    );
    return c;
  }, [spreads]);
  const toCheck = useMemo(() => checkList(spreads), [spreads]);
  const checked = toCheck.filter((k) => findPocket(spreads, k)?.approved).length;
  const checking = check && check.i < check.keys.length ? check.keys[check.i] : null;
  const checkingPocket = checking ? findPocket(spreads, checking) : undefined;
  const spreadIndex = (id: number) => spreads.findIndex((s) => s.id === id);
  const pageName = (si: number, page: number) => `Page ${si * pagesPerSpread + page + 1}${pagesPerSpread === 2 ? (page === 0 ? ' (left)' : ' (right)') : ''}`;

  const items: CardItem[] = useMemo(
    () =>
      spreads.flatMap((s, si) =>
        s.pockets
          .filter((p) => !p.ghost && !p.cardBack && p.status !== 'empty')
          .map((p) => {
            const unsure = nameUnsure(p);
            const price = unsure ? null : pocketPrice(db, p, live);
            const info = p.chosen !== null && !unsure ? db.info(p.chosen) : null;
            return {
              key: `${s.id}:${p.page}:${p.slot}`,
              card: unsure ? null : p.chosen,
              finish: p.finish,
              price,
              trend: info ? trendFor(history, info.id, p.finish, price, baselines?.get(p.chosen!, p.finish)) : null,
              location: `${pageName(si, p.page)} · slot ${p.slot + 1}`,
              order: si * 100 + p.page * 10 + p.slot,
              thumb: p.thumbUrl,
              flagged: needsCheck(p),
              note: unsure ? `${p.chosen !== null ? db.info(p.chosen).name : 'Name'}? Tap to confirm` : p.printingCheck ? 'Which printing?' : p.seeThrough ? 'Through a sleeve?' : undefined,
              onOpen: () => openOne({ spread: s.id, page: p.page, slot: p.slot }),
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
              {s.pockets.filter((p) => p.page === page && p.blurry && !p.ghost).length >= 3 && (
                <div className="blurry-note">Blurry photo: check these cards, or scan this page again with focus locked.</div>
              )}
              <div className="page-grid">
                {s.pockets
                  .filter((p) => p.page === page)
                  .map((p) => {
                    const info = p.chosen !== null && !p.cardBack ? db.info(p.chosen) : null;
                    return (
                      <button key={p.slot} className={`tile ${pocketClass(p)}`} onClick={() => openOne({ spread: s.id, page: p.page, slot: p.slot })}>
                        <img src={p.thumbUrl} alt={info?.name ?? 'pocket'} />
                        <div className="name">{tileName(db, p)}</div>
                        {!p.ghost && p.printingCheck && <div className="price" style={{ color: 'var(--warn)' }}>Which printing?</div>}
                        {!p.ghost && p.seeThrough && <div className="price" style={{ color: 'var(--warn)' }}>Through a sleeve?</div>}
                        {!p.ghost && nameUnsure(p) && <div className="price" style={{ color: 'var(--warn)' }}>{p.nameCheck === 'differs' ? 'Name reads differently' : 'Tap to confirm'}</div>}
                        <div className="price">
                          {p.ghost && info ? info.name : info && !nameUnsure(p) ? `${info.set.toUpperCase()} · ${formatUSD(pocketPrice(db, p, live))}` : ' '}
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
          {counts.unsure > 0 && ` · ${counts.unsure} name${counts.unsure === 1 ? '' : 's'} to confirm (not saved or counted until you do)`}
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
        {diagnostics.hasRun && (
          <div className="row small" style={{ marginTop: 8, gap: 8, flexWrap: 'wrap' }}>
            <span className="muted">Scan look wrong?</span>
            <button
              className="btn small"
              disabled={sharing}
              onClick={async () => {
                setSharing(true);
                try {
                  await shareDiagnostics();
                } catch (e) {
                  alert(`Couldn’t share the diagnostics: ${(e as Error).message}`);
                } finally {
                  setSharing(false);
                }
              }}
            >
              {sharing ? 'Packing…' : 'Share scan diagnostics'}
            </button>
          </div>
        )}
      </div>
      {spreads.length === 0 ? (
        <div className="notice">No spreads were captured. Make sure the outline matches the pages and that each spread is held still for about half a second.</div>
      ) : (
        <CardsView db={db} items={items} storageKey="review" orderGallery={pageGrids} />
      )}
      {check && checking && checkingPocket && (
        <CardCheck
          db={db}
          live={live}
          pocket={checkingPocket}
          location={`${pageName(spreadIndex(checking.spread), checking.page)} · slot ${checking.slot + 1}`}
          position={check.single ? null : { index: check.i + 1, total: check.keys.length }}
          onSave={(p) => {
            onUpdate(checking.spread, p);
            setCheck(check.single ? null : { ...check, i: check.i + 1 });
          }}
          onBack={() => setCheck(check.i > 0 && !check.single ? { ...check, i: check.i - 1 } : null)}
          onClose={() => setCheck(null)}
          onReadName={() => onReadName(checking.spread, checkingPocket)}
        />
      )}
      {check && !checking && (
        <div className="check" role="dialog" aria-label="All cards checked">
          <div className="check-done">
            <h2>All {check.keys.length} cards checked</h2>
            <div className="big-number">{formatUSD(total)}</div>
            <p className="muted">{entries.length} card{entries.length === 1 ? '' : 's'} will be saved to “{binder}”.</p>
            <div className="stack">
              <button className="btn primary block" onClick={onSave}>Save binder</button>
              <button className="btn block" onClick={() => setCheck({ ...check, i: check.keys.length - 1 })}>‹ Back to the last card</button>
              <button className="btn block" onClick={() => setCheck(null)}>See the pages</button>
            </div>
          </div>
        </div>
      )}
      <div className="savebar">
        <div>
          <div className="grow">
            <div className="num" style={{ fontWeight: 700 }}>{formatUSD(total)}</div>
            <div className="muted small">{counts.check > 0 ? `${counts.check} to check (orange/red)` : 'All pockets identified'}</div>
          </div>
          {checked < toCheck.length ? (
            <>
              <button className="btn small" onClick={onSave} disabled={!spreads.length}>
                Save now
              </button>
              <button className="btn primary" onClick={startCheck}>
                Check cards ({checked}/{toCheck.length})
              </button>
            </>
          ) : (
            <button className="btn primary" onClick={onSave} disabled={!spreads.length}>
              Save binder
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
