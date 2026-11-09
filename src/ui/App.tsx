import { useCallback, useEffect, useRef, useState } from 'react';
import type { CardDB } from '../core/carddb.ts';
import { loadBaselines, loadCardDB, MissingDataError, Recognizer } from '../app/data.ts';
import type { Baselines } from '../core/baselines.ts';
import { applyOcr, mergeInto, needsOcr, sameSpread, toPocketView, type LivePrices, type PocketView, type Spread } from '../app/session.ts';
import { loadCollection, loadHistory, loadLivePrices, recordPrices, saveCollection, saveLivePrices, type Collection, type OwnedCard, type PriceHistory } from '../app/store.ts';
import { fetchLivePrices } from '../app/prices.ts';
import type { WirePocket } from '../app/protocol.ts';
import { HomeScreen } from './HomeScreen.tsx';
import { SetupScreen } from './SetupScreen.tsx';
import { ScanScreen } from './ScanScreen.tsx';
import { ReviewScreen } from './ReviewScreen.tsx';
import { BinderScreen } from './BinderScreen.tsx';

type Screen =
  | { name: 'home' }
  | { name: 'setup' }
  | { name: 'scan'; binder: string; source: 'camera' | File }
  | { name: 'review'; binder: string }
  | { name: 'binder'; binder: string };

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
  const nextSpreadId = useRef(1);

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
    (r: { pockets: WirePocket[]; time: number; retried?: number[] }, pps: number) => {
      if (!db) return;
      setPagesPerSpread(pps);
      const pockets: KeyedPocket[] = r.pockets.map((p) => ({ ...toPocketView(p, db), key: ++pocketKeys }));
      const prev = spreadsRef.current;
      const last = prev[prev.length - 1];
      const repeat = !!last && sameSpread(last.pockets, pockets, db);
      setRunStats((s) => ({ captures: s.captures + 1, repeats: s.repeats + (repeat ? 1 : 0), reread: s.reread + (r.retried?.length ?? 0) }));
      if (repeat) {
        commitSpreads([...prev.slice(0, -1), { ...last, pockets: mergeInto(last.pockets, pockets) }]);
      } else {
        commitSpreads([...prev, { id: nextSpreadId.current++, time: r.time, pockets }]);
      }
      for (const p of pockets) if (needsOcr(p)) runOcr(p.key, p.nameCrop!);
    },
    [db, runOcr],
  );

  const updatePocket = (spreadId: number, pocket: PocketView) => {
    commitSpreads(spreadsRef.current.map((s) => (s.id === spreadId ? { ...s, pockets: s.pockets.map((p) => (p.page === pocket.page && p.slot === pocket.slot ? pocket : p)) } : s)));
  };

  const saveBinder = async (binder: string) => {
    if (!db) return;
    const cards: OwnedCard[] = [];
    spreadsRef.current.forEach((s, si) => {
      for (const p of s.pockets) {
        if (p.chosen === null) continue;
        cards.push({ id: db.info(p.chosen).id, finish: p.finish, page: si * pagesPerSpread + p.page + 1, slot: p.slot + 1 });
      }
    });
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
