import { useCallback, useEffect, useRef, useState } from 'react';
import { diagnostics } from '../app/diagnostics.ts';
import { buildReport, deleteReport, saveReport } from '../app/report.ts';
import { clearDraft, draftSummary, loadDraft, saveDraft, type DraftMeta, type DraftSummary } from '../app/draft.ts';
import type { CardDB } from '../core/carddb.ts';
import { loadBaselines, loadCardDB, MissingDataError, Recognizer } from '../app/data.ts';
import type { Baselines } from '../core/baselines.ts';
import { addReading, applyInfoRead, applyOcr, binderEntries, needsInfoOcr, preferPageSets, DEFAULT_SESSION, markGhosts, needsOcr, releasePhotos, toPocketView, type SessionConfig, type LivePrices, type PocketView, type Spread } from '../app/session.ts';
import { loadCollection, loadHistory, loadLivePrices, recordPrices, saveCollection, saveLivePrices, type Collection, type OwnedCard, type PriceHistory } from '../app/store.ts';
import { fetchLivePrices } from '../app/prices.ts';
import type { WirePocket } from '../app/protocol.ts';
import type { Calibration } from '../core/geometry.ts';
import { HomeScreen } from './HomeScreen.tsx';
import { SetupScreen } from './SetupScreen.tsx';
import { ScanScreen, type ScanSource } from './ScanScreen.tsx';
import { ReviewScreen } from './ReviewScreen.tsx';
import { BinderScreen, CollectionScreen } from './BinderScreen.tsx';

type Screen =
  | { name: 'home' }
  | { name: 'setup' }
  | { name: 'scan'; binder: string; source: ScanSource }
  | { name: 'review'; binder: string; fresh?: boolean }
  | { name: 'binder'; binder: string }
  | { name: 'all'; query?: string };

let pocketKeys = 0;
type KeyedPocket = PocketView & { key: number };

const ENGLISH_KEY = 'mtgdb-english-only';
/** Match English printings only (the default): see CardDB.setEnglishOnly. */
function readEnglishOnly(): boolean {
  try {
    return localStorage.getItem(ENGLISH_KEY) !== 'off';
  } catch {
    return true;
  }
}
function writeEnglishOnly(on: boolean) {
  try {
    localStorage.setItem(ENGLISH_KEY, on ? 'on' : 'off');
  } catch {
    /* private mode */
  }
}

export function App() {
  const [db, setDb] = useState<CardDB | null>(null);
  const [dbStatus, setDbStatus] = useState<{ loading: string | null; error: string | null; missing: boolean }>({ loading: 'Loading card database…', error: null, missing: false });
  const [collection, setCollection] = useState<Collection>({ binders: [] });
  const [englishOnly, setEnglishOnlyState] = useState(readEnglishOnly);
  /** Review bookkeeping for the current scan (e.g. no see-through cards when empty sleeves hold blanks). */
  const sessionCfg = useRef<SessionConfig>(DEFAULT_SESSION);
  /** The unfinished scan saved on the phone (offered on the home screen after a crash). */
  const [draft, setDraft] = useState<DraftSummary | null>(null);
  /** What the current scan is (saved with it, so it can be resumed). */
  const scanMeta = useRef<DraftMeta | null>(null);
  const checksSinceSave = useRef(0);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Saves the scan in progress to the phone (see draft.ts). */
  const autosave = (delayMs = 0) => {
    if (!scanMeta.current) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      autosaveTimer.current = null;
      if (scanMeta.current && spreadsRef.current.length) void saveDraft({ ...scanMeta.current, pagesPerSpread: pagesRef.current, runStats: runStatsRef.current }, spreadsRef.current);
    }, delayMs);
  };
  const pagesRef = useRef(2);
  const runStatsRef = useRef({ captures: 0, repeats: 0, reread: 0 });
  /** Done with the scan (saved as a binder, or discarded): forget the autosave. */
  const endScan = () => {
    scanMeta.current = null;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    setDraft(null);
    void clearDraft();
  };
  // iOS may close a backgrounded app: save first.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') autosave();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
    };
  });
  const [live, setLive] = useState<LivePrices>({});
  const [history, setHistory] = useState<PriceHistory>({});
  const [baselines, setBaselines] = useState<Baselines | null>(null);
  const [screen, setScreen] = useState<Screen>({ name: 'home' });
  const [spreads, setSpreads] = useState<Spread[]>([]);
  const [pagesPerSpread, setPagesPerSpread] = useState(2);
  const [ocrPending, setOcrPending] = useState(0);
  /** What happened during the last run, shown on the review screen. */
  const [runStats, setRunStats] = useState({ captures: 0, repeats: 0, reread: 0 });
  pagesRef.current = pagesPerSpread;
  runStatsRef.current = runStats;
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const recognizer = useRef<Recognizer | null>(null);
  const spreadsRef = useRef<Spread[]>([]);
  const ocrChain = useRef<Promise<void>>(Promise.resolve());
  /** A scan is running: name reading waits (see runOcr). */
  const scanning = useRef(false);
  const ocrQueue = useRef<(() => Promise<void>)[]>([]);

  const commitSpreads = (next: Spread[]) => {
    spreadsRef.current = next;
    setSpreads(next);
  };

  useEffect(() => {
    (async () => {
      // Ask the browser not to clear saved binders when it runs low on space or the site goes unused for a while.
      navigator.storage?.persist?.().catch(() => {});
      const [col, lp, hist, unfinished] = await Promise.all([loadCollection(), loadLivePrices(), loadHistory(), draftSummary()]);
      setCollection(col);
      setDraft(unfinished);
      setLive(lp);
      setHistory(hist);
      try {
        const loaded = await loadCardDB((m) => setDbStatus({ loading: m, error: null, missing: false }));
        loaded.setEnglishOnly(readEnglishOnly());
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
    (key: number, crop?: NonNullable<PocketView['nameCrop']>) => {
      if (!db) return;
      setOcrPending((n) => n + 1);
      const find = () => spreadsRef.current.flatMap((s) => s.pockets).find((p) => (p as KeyedPocket).key === key);
      const update = (fn: (p: PocketView) => PocketView) =>
        commitSpreads(
          spreadsRef.current.map((s) =>
            s.pockets.some((p) => (p as KeyedPocket).key === key)
              ? preferPageSets({ ...s, pockets: s.pockets.map((p) => ((p as KeyedPocket).key === key && p.via !== 'manual' ? { ...fn(p), key } : p)) }, db)
              : s,
          ),
        );
      const job = async () => {
        try {
          // The pocket may be gone (its photo was read again after Pause & adjust).
          const p = find();
          if (!p) return;
          const ocr = await import('../app/ocr.ts');
          // The printed name (asked for again with `crop`, from the card check).
          const nameCrop = crop ?? (needsOcr(p) ? p.nameCrop : undefined);
          if (nameCrop) {
            const { text } = await ocr.readCardName(nameCrop);
            update((q) => applyOcr(q, text, db));
          }
          // Then the collector line, to tell printings apart.
          const q = find();
          if (q && needsInfoOcr(q, db)) {
            const text = await ocr.readCollectorLine(q.infoCrop!);
            update((r) => applyInfoRead(r, text, db));
          }
        } catch (e) {
          console.warn('OCR failed', e);
        } finally {
          setOcrPending((n) => n - 1);
        }
      };
      // While a scan runs, names are read afterwards: the phone's time goes to the scan (and to taps on Pause).
      if (scanning.current) ocrQueue.current.push(job);
      else ocrChain.current = ocrChain.current.then(job);
    },
    [db],
  );

  /** The scan ended: read the names held back during it. */
  const flushOcr = () => {
    scanning.current = false;
    for (const job of ocrQueue.current.splice(0)) ocrChain.current = ocrChain.current.then(job);
  };

  const onSpread = useCallback(
    (r: { pockets: WirePocket[]; time: number; retried?: number[]; change?: number; manual?: boolean; ms?: number; calibration?: Calibration; photo?: number }, pps: number) => {
      if (!db) return;
      setPagesPerSpread(pps);
      diagnostics.addReading(r, db);
      const pockets: KeyedPocket[] = r.pockets.map((p) => ({ ...toPocketView(p, db), key: ++pocketKeys }));
      const prev = spreadsRef.current;
      // A photo read again after Pause & adjust replaces its earlier (misaligned) reading.
      const redo = r.photo !== undefined ? prev.findIndex((s) => s.photo === r.photo) : -1;
      if (redo >= 0) {
        const replaced = prev.map((s, i) => (i === redo ? preferPageSets({ ...s, pockets }, db) : s));
        commitSpreads(markGhosts(replaced, pps, db, sessionCfg.current));
        for (const p of pockets) if ((needsOcr(p) || needsInfoOcr(p, db)) && !p.cardBack) runOcr(p.key);
        autosave(1500);
        return;
      }
      let next = addReading(prev, { pockets, time: r.time, change: r.change ?? Infinity, manual: !!r.manual }, pps, db, sessionCfg.current);
      const repeat = next.length === prev.length && prev.length > 0;
      if (!repeat && r.photo !== undefined) next = next.map((s, i) => (i === next.length - 1 ? { ...s, photo: r.photo } : s));
      setRunStats((s) => ({ captures: s.captures + 1, repeats: s.repeats + (repeat ? 1 : 0), reread: s.reread + (r.retried?.length ?? 0) }));
      commitSpreads(next);
      for (const p of pockets) if ((needsOcr(p) || needsInfoOcr(p, db)) && !p.cardBack) runOcr(p.key);
      autosave(1500);
    },
    [db, runOcr],
  );

  const updatePocket = (spreadId: number, pocket: PocketView) => {
    // A card the user picked also tells the other cards on its page which set they're likely from.
    const next = spreadsRef.current.map((s) => (s.id === spreadId && db ? preferPageSets({ ...s, pockets: s.pockets.map((p) => (p.page === pocket.page && p.slot === pocket.slot ? pocket : p)) }, db) : s));
    commitSpreads(db ? markGhosts(next, pagesPerSpread, db, sessionCfg.current) : next);
    // Autosave every 5 cards checked (Save + continue).
    if (++checksSinceSave.current >= 5) {
      checksSinceSave.current = 0;
      autosave();
    }
  };

  /** Picks up the scan saved on the phone, where it was left. */
  const resumeDraft = async () => {
    if (!db) return;
    releasePhotos(); // before loading: the draft's photos come back as new object URLs
    const saved = await loadDraft();
    if (!saved) {
      setDraft(null);
      return;
    }
    const { meta } = saved;
    db.setCategories(meta.options.categories);
    recognizer.current?.updateAllowed();
    sessionCfg.current = { ...DEFAULT_SESSION, seeThrough: !meta.options.blankFillers };
    scanMeta.current = meta;
    scanning.current = false;
    const spreads = saved.spreads.map((s) => ({ ...s, pockets: s.pockets.map((p) => ({ ...p, key: ++pocketKeys })) }));
    commitSpreads(spreads);
    setPagesPerSpread(meta.pagesPerSpread);
    setRunStats(meta.runStats);
    setDraft(null);
    for (const s of spreads) for (const p of s.pockets) if ((needsOcr(p) || needsInfoOcr(p, db)) && !p.cardBack) runOcr((p as KeyedPocket).key);
    setScreen({ name: 'review', binder: meta.binder, fresh: true });
  };

  /** Removes a binder and its cards from the collection on this phone. */
  const deleteBinder = async (binder: string) => {
    const next: Collection = { binders: collection.binders.filter((b) => b.name !== binder) };
    await saveCollection(next);
    await deleteReport(binder).catch(() => {});
    setCollection(next);
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
    // Adding to a binder saved earlier (e.g. the rest of it, scanned as another run): after its pages.
    const before = scanMeta.current?.addToExisting ? collection.binders.find((b) => b.name === binder) : undefined;
    const offset = before ? Math.max(0, ...before.cards.map((c) => c.page)) : 0;
    // What the app read next to what was saved, with the card photos, to share for improving recognition.
    try {
      const options = { categories: scanMeta.current?.options.categories ?? 0, blankFillers: !!scanMeta.current?.options.blankFillers, englishOnly };
      const { scan, photos } = buildReport(db, spreadsRef.current, pagesPerSpread, offset, options);
      await saveReport(binder, scan, photos, !before);
    } catch (e) {
      console.warn('Scan report not saved', e);
    }
    if (before) {
      const have = new Set(before.cards.map((c) => `${c.id}:${c.finish}`));
      cards.splice(0, cards.length, ...before.cards, ...cards.filter((c) => !have.has(`${c.id}:${c.finish}`)).map((c) => ({ ...c, page: c.page + offset })));
    }
    const next: Collection = {
      binders: [{ name: binder, updatedAt: new Date().toISOString(), cards }, ...collection.binders.filter((b) => b.name !== binder)],
    };
    await saveCollection(next);
    setCollection(next);
    setHistory(await recordPrices(db, next, live));
    endScan();
    releasePhotos();
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
          onDeleteBinder={deleteBinder}
          draft={draft}
          onResume={resumeDraft}
          onDiscardDraft={() => {
            if (draft && confirm(`Discard the unfinished scan of “${draft.binder}”? The ${draft.checked} cards checked so far will be lost.`)) endScan();
          }}
          onBrowse={(query) => setScreen({ name: 'all', query })}
          onRefresh={refresh}
        />
      )}
      {screen.name === 'setup' && (
        <SetupScreen
          collection={collection}
          englishOnly={englishOnly}
          onEnglishOnly={(on) => {
            setEnglishOnlyState(on);
            writeEnglishOnly(on);
            if (db) {
              db.setEnglishOnly(on);
              recognizer.current?.updateAllowed();
            }
          }}
          onBack={() => setScreen({ name: 'home' })}
          hasCategories={!!db?.hasCategories}
          onStart={(binder, source, options) => {
            if (draft && !confirm(`Starting a new scan discards the unfinished scan of “${draft.binder}” (${draft.checked} of ${draft.cards} cards checked). Start anyway?`)) return;
            endScan();
            scanMeta.current = { binder, pagesPerSpread: 2, runStats: { captures: 0, repeats: 0, reread: 0 }, options: { categories: options.categories, blankFillers: options.blankFillers }, addToExisting: options.addToExisting };
            checksSinceSave.current = 0;
            if (db) {
              db.setCategories(options.categories);
              recognizer.current?.updateAllowed();
            }
            sessionCfg.current = { ...DEFAULT_SESSION, seeThrough: !options.blankFillers };
            scanning.current = true;
            diagnostics.note('scanOptions', options);
            releasePhotos();
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
          onDone={() => {
            flushOcr();
            autosave();
            setScreen({ name: 'review', binder: screen.binder, fresh: true });
          }}
          onCancel={() => {
            flushOcr();
            setScreen({ name: 'home' });
          }}
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
          checkOnOpen={!!screen.fresh}
          onSave={() => saveBinder(screen.binder)}
          onDiscard={() => {
            if (!spreads.length || confirm('Discard this scan?')) {
              endScan();
              releasePhotos();
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
            await deleteBinder(screen.binder);
            setScreen({ name: 'home' });
          }}
        />
      )}
    </div>
  );
}
