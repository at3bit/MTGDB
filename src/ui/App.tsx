import { useCallback, useEffect, useRef, useState } from 'react';
import type { CardDB } from '../core/carddb.ts';
import { loadBaselines, loadCardDB, MissingDataError, Recognizer } from '../app/data.ts';
import type { Baselines } from '../core/baselines.ts';
import { addReading, applyOcr, binderEntries, markGhosts, needsOcr, toPocketView, type LivePrices, type PocketView, type Spread } from '../app/session.ts';
import { loadCollection, loadHistory, loadLivePrices, recordPrices, saveCollection, saveLivePrices, type Collection, type OwnedCard, type PriceHistory } from '../app/store.ts';
import { fetchLivePrices } from '../app/prices.ts';
import type { WirePocket } from '../app/protocol.ts';
import { HomeScreen } from './HomeScreen.tsx';
import { SetupScreen } from './SetupScreen.tsx';
import { ScanScreen } from './ScanScreen.tsx';
import { ReviewScreen } from './ReviewScreen.tsx';
import { BinderScreen, CollectionScreen } from './BinderScreen.tsx';

type Screen =
  | { name: 'home' }
  | { name: 'setup' }
  | { name: 'scan'; binder: string; source: 'camera' | File }
  | { name: 'review'; binder: string }
  | { name: 'binder'; binder: string }
  | { name: 'all'; query?: string };

let pocketKeys = 0;
type KeyedPocket = PocketView & { key: number };

export function App() {
  const [db, setDb] = useState<CardDB | null>(null);
  const [dbStatus, setDbStatus] = useState<{ loading: string | null; error: string | null; missing: boolean }>({ loading: 'Loading card database…', error: null, missing: false });
  const [collection, setCollection] = useState<Collection>({ binders: [] });
  const [live, setLive] = useState<LivePrices>({});
  const [history, setHistory] = useState<PriceHistory>({});
  const [baselines, setBaselines] = useState<Baselines | null>(null);
  const [screen, setScreen] = useState<Screen>({ name: 'home' });
  const [spreads, setSpreads] = useState<Spread[]>([]);
  const [pagesPerSpread, setPagesPerSpread] = useState(2);
  const [ocrPending, setOcrPending] = useState(0);
  /** What happened during the last run, shown on the review screen. */
  const [runStats, setRunStats] = useState({ captures: 0, repeats: 0, reread: 0 });
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const recognizer = useRef<Recognizer | null>(null);
  const spreadsRef = useRef<Spread[]>([]);
  const ocrChain = useRef<Promise<void>>(Promise.resolve());

  const commitSpreads = (next: Spread[]) => {
    spreadsRef.current = next;
    setSpreads(next);
  };

  useEffect(() => {
    (async () => {
      const [col, lp, hist] = await Promise.all([loadCollection(), loadLivePrices(), loadHistory()]);
      setCollection(col);
      setLive(lp);
      setHistory(hist);
      try {
        const loaded = await loadCardDB((m) => setDbStatus({ loading: m, error: null, missing: false }));
        setDb(loaded);
        recognizer.current = new Recognizer(loaded);
        setDbStatus({ loading: null, error: null, missing: false });
        setHistory(await recordPrices(loaded, col, lp));
        setBaselines(await loadBaselines(loaded));
        // Prices for the cards you own are refreshed from Scryfall at most twice a day, quietly.
        const ids = [...new Set(col.binders.flatMap((b) => b.cards.map((c) => c.id)))];
        const stale = ids.some((id) => !lp[id] || Date.now() - Date.parse(lp[id].at) > 12 * 3600_000);
        if (ids.length && stale && navigator.onLine !== false) {
          try {
            const merged = { ...lp, ...(await fetchLivePrices(ids)) };
            await saveLivePrices(merged);
            setLive(merged);
            setHistory(await recordPrices(loaded, col, merged));
          } catch (e) {
            console.warn('Automatic price refresh failed', e);
          }
        }
      } catch (e) {
        setDbStatus({ loading: null, error: (e as Error).message, missing: e instanceof MissingDataError });
      }
    })();
  }, []);

  const runOcr = useCallback(
    (key: number, crop: NonNullable<PocketView['nameCrop']>) => {
      if (!db) return;
      setOcrPending((n) => n + 1);
      ocrChain.current = ocrChain.current.then(async () => {
        try {
          const { readCardName } = await import('../app/ocr.ts');
          const { text } = await readCardName(crop);
          commitSpreads(
            spreadsRef.current.map((s) => ({
              ...s,
              pockets: s.pockets.map((p) => ((p as KeyedPocket).key === key && p.via !== 'manual' ? { ...applyOcr(p, text, db), key } : p)),
            })),
          );
        } catch (e) {
          console.warn('OCR failed', e);
        } finally {
          setOcrPending((n) => n - 1);
        }
      });
    },
    [db],
  );

  const onSpread = useCallback(
    (r: { pockets: WirePocket[]; time: number; retried?: number[]; change?: number; manual?: boolean }, pps: number) => {
      if (!db) return;
      setPagesPerSpread(pps);
      const pockets: KeyedPocket[] = r.pockets.map((p) => ({ ...toPocketView(p, db), key: ++pocketKeys }));
      const prev = spreadsRef.current;
      const next = addReading(prev, { pockets, time: r.time, change: r.change ?? Infinity, manual: !!r.manual }, pps, db);
      const repeat = next.length === prev.length && prev.length > 0;
      setRunStats((s) => ({ captures: s.captures + 1, repeats: s.repeats + (repeat ? 1 : 0), reread: s.reread + (r.retried?.length ?? 0) }));
      commitSpreads(next);
      for (const p of pockets) if (needsOcr(p) && !p.cardBack) runOcr(p.key, p.nameCrop!);
    },
    [db, runOcr],
  );

  const updatePocket = (spreadId: number, pocket: PocketView) => {
    const next = spreadsRef.current.map((s) => (s.id === spreadId ? { ...s, pockets: s.pockets.map((p) => (p.page === pocket.page && p.slot === pocket.slot ? pocket : p)) } : s));
    commitSpreads(db ? markGhosts(next, pagesPerSpread, db) : next);
  };

  const saveBinder = async (binder: string) => {
    if (!db) return;
    // One entry per printing (quantities aren't tracked); see-through cards and card backs are left out.
    const cards: OwnedCard[] = binderEntries(spreadsRef.current, pagesPerSpread, db).map((e) => ({
      id: db.info(e.card).id,
      finish: e.finish,
      page: e.spreadIndex * pagesPerSpread + e.page + 1,
      slot: e.slot + 1,
    }));
    const next: Collection = {
      binders: [{ name: binder, updatedAt: new Date().toISOString(), cards }, ...collection.binders.filter((b) => b.name !== binder)],
    };
    await saveCollection(next);
    setCollection(next);
    setHistory(await recordPrices(db, next, live));
    commitSpreads([]);
    setScreen({ name: 'binder', binder });
  };

  const refresh = async () => {
    if (!db) return;
    const ids = collection.binders.flatMap((b) => b.cards.map((c) => c.id));
    try {
      setRefreshing('Refreshing…');
      const fresh = await fetchLivePrices(ids, (d, t) => setRefreshing(`${d}/${t}`));
      const merged = { ...live, ...fresh };
      await saveLivePrices(merged);
      setLive(merged);
      setHistory(await recordPrices(db, collection, merged));
    } catch (e) {
      alert(`Could not refresh prices: ${(e as Error).message}`);
    } finally {
      setRefreshing(null);
    }
  };

  return (
    <div className="app">
      {screen.name === 'home' && (
        <HomeScreen
          db={db}
          dbStatus={dbStatus}
          collection={collection}
          live={live}
          history={history}
          baselines={baselines}
          refreshing={refreshing}
          onScan={() => setScreen({ name: 'setup' })}
          onOpenBinder={(b) => setScreen({ name: 'binder', binder: b })}
          onBrowse={(query) => setScreen({ name: 'all', query })}
          onRefresh={refresh}
        />
      )}
      {screen.name === 'setup' && (
        <SetupScreen
          collection={collection}
          onBack={() => setScreen({ name: 'home' })}
          onStart={(binder, source) => {
            commitSpreads([]);
            setRunStats({ captures: 0, repeats: 0, reread: 0 });
            setScreen({ name: 'scan', binder, source });
          }}
        />
      )}
      {screen.name === 'scan' && recognizer.current && (
        <ScanScreen
          binder={screen.binder}
          source={screen.source}
          recognizer={recognizer.current}
          spreadsSoFar={spreads.length}
          onSpread={onSpread}
          onDone={() => setScreen({ name: 'review', binder: screen.binder })}
          onCancel={() => setScreen({ name: 'home' })}
        />
      )}
      {screen.name === 'review' && db && (
        <ReviewScreen
          db={db}
          binder={screen.binder}
          spreads={spreads}
          pagesPerSpread={pagesPerSpread}
          live={live}
          ocrPending={ocrPending}
          runStats={runStats}
          history={history}
          baselines={baselines}
          onUpdate={updatePocket}
          onReadName={(_, p) => p.nameCrop && runOcr((p as KeyedPocket).key, p.nameCrop)}
          onSave={() => saveBinder(screen.binder)}
          onDiscard={() => {
            if (!spreads.length || confirm('Discard this scan?')) {
              commitSpreads([]);
              setScreen({ name: 'home' });
            }
          }}
        />
      )}
      {screen.name === 'all' && db && (
        <CollectionScreen db={db} collection={collection} live={live} history={history} baselines={baselines} query={screen.query} onBack={() => setScreen({ name: 'home' })} />
      )}
      {screen.name === 'binder' && db && (
        <BinderScreen
          db={db}
          name={screen.binder}
          collection={collection}
          live={live}
          history={history}
          baselines={baselines}
          onBack={() => setScreen({ name: 'home' })}
          onDelete={async () => {
            const next = { binders: collection.binders.filter((b) => b.name !== screen.binder) };
            await saveCollection(next);
            setCollection(next);
            setScreen({ name: 'home' });
          }}
        />
      )}
    </div>
  );
}
