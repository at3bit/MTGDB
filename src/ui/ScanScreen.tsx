// Line up the outline, then run through the binder: a live camera, an uploaded
// video, or a set of photos. During a run you can pause to re-line-up the
// outline (it never moves by itself), and snap pages by hand or on a timer.
import { useEffect, useRef, useState } from 'react';
import { diagnostics } from '../app/diagnostics.ts';
import { defaultCalibration, type Calibration, type Rotation } from '../core/geometry.ts';
import { keepAwake, openCamera, openPhotos, openVideoFile, type FrameSource } from '../app/capture.ts';
import { RunController, type CaptureMode, type RunStatus } from '../app/run.ts';
import type { Recognizer, SpreadReading } from '../app/data.ts';
import { loadCalibration, saveCalibration } from '../app/store.ts';
import { QuadOverlay } from './QuadOverlay.tsx';

export type ScanSource = 'camera' | File | File[];

interface Props {
  binder: string;
  source: ScanSource;
  recognizer: Recognizer;
  spreadsSoFar: number;
  onSpread: (r: SpreadReading & { time: number; change: number; manual: boolean }, pagesPerSpread: number) => void;
  onDone: () => void;
  onCancel: () => void;
}

type Phase = 'opening' | 'calibrate' | 'running' | 'paused' | 'finishing' | 'stopped';

const PHASE_TEXT: Record<RunStatus['phase'], string> = {
  watching: 'Watching',
  moving: 'Page moving…',
  settled: 'Captured',
  paused: 'Paused',
  finishing: 'Finishing…',
  done: 'Done',
};

const MODE_KEY = 'mtgdb-capture-mode';
const SOUND_KEY = 'mtgdb-capture-sound';
const INTERVAL_KEY = 'mtgdb-capture-interval';
const LINEUP_KEY = 'mtgdb-lineup-each';
const read = (k: string, d: string) => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
};

/** A short, soft click so you know a page was captured without looking at the screen. */
function makeClick(): () => void {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return () => {};
  const ctx = new Ctx();
  return () => {
    if (ctx.state === 'suspended') void ctx.resume();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1400, t);
    osc.frequency.exponentialRampToValueAtTime(700, t + 0.06);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.1);
  };
}

const MODES: { mode: CaptureMode; label: string }[] = [
  { mode: 'auto', label: 'Automatically' },
  { mode: 'timed', label: 'On a timer' },
  { mode: 'manual', label: 'When I tap Snap' },
];

export function ScanScreen({ binder, source, recognizer, spreadsSoFar, onSpread, onDone, onCancel }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const srcRef = useRef<FrameSource | null>(null);
  const ctrlRef = useRef<RunController | null>(null);
  const clickRef = useRef<() => void>(() => {});
  const phaseRef = useRef<Phase>('opening');
  const [phase, setPhaseState] = useState<Phase>('opening');
  const [dims, setDims] = useState({ w: 16, h: 9 });
  const [cal, setCal] = useState<Calibration | null>(null);
  const [rotation, setRotation] = useState<Rotation>(0);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isPhotos = Array.isArray(source);
  const isVideo = source instanceof File;
  const isCamera = source === 'camera';
  const [mode, setModeState] = useState<CaptureMode>(() => {
    const m = read(MODE_KEY, 'auto');
    return m === 'manual' || m === 'timed' ? m : 'auto';
  });
  const [interval, setIntervalState] = useState(() => Number(read(INTERVAL_KEY, '4')) || 4);
  const [lineUpEach, setLineUpEachState] = useState(() => read(LINEUP_KEY, 'on') === 'on');
  const [sound, setSoundState] = useState(() => read(SOUND_KEY, 'on') === 'on');
  const [flash, setFlash] = useState(0);
  const [openStep, setOpenStep] = useState<string | null>(null);
  const [slowOpen, setSlowOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  /** Photos: the photo waiting to be lined up. */
  const [lineUp, setLineUp] = useState<{ index: number; count: number; reason: 'each' | 'shape' } | null>(null);
  /** Captures where a page didn't read well with the outline and was found elsewhere. */
  const [shifted, setShifted] = useState(0);
  /** Timed shots: seconds to the next shot (null = not counting), and when the last one was taken. */
  const [countdown, setCountdown] = useState<number | null>(null);
  const [shotAt, setShotAt] = useState(0);

  const setPhase = (p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  };
  const setMode = (m: CaptureMode) => {
    setModeState(m);
    write(MODE_KEY, m);
    if (ctrlRef.current) ctrlRef.current.mode = m;
  };
  const setSound = (on: boolean) => {
    setSoundState(on);
    write(SOUND_KEY, on ? 'on' : 'off');
  };
  const setLineUpEach = (on: boolean) => {
    setLineUpEachState(on);
    write(LINEUP_KEY, on ? 'on' : 'off');
    if (ctrlRef.current) ctrlRef.current.lineUpEach = on;
  };
  const soundRef = useRef(sound);
  soundRef.current = sound;

  useEffect(() => {
    let cancelled = false;
    setSlowOpen(false);
    setError(null);
    // If opening takes unusually long, say so and offer a retry instead of looking stuck.
    const slow = setTimeout(() => !cancelled && phaseRef.current === 'opening' && setSlowOpen(true), 20_000);
    (async () => {
      try {
        const src =
          source === 'camera'
            ? await openCamera(videoRef.current!)
            : Array.isArray(source)
              ? await openPhotos(imgRef.current!, source)
              : await openVideoFile(videoRef.current!, source, undefined, setOpenStep);
        if (cancelled) return src.stop();
        srcRef.current = src;
        const w = src.width, h = src.height;
        setDims({ w, h });
        const saved = await loadCalibration();
        if (saved && Math.abs(saved.frameW / saved.frameH - w / h) < 0.01) {
          setCal(saved.calibration);
          setRotation(saved.rotation);
        } else {
          // Landscape: an open binder. Portrait: one upright page.
          setCal(defaultCalibration(w, h, 0, w >= h ? 2 : 1));
          setRotation(0);
        }
        if (src.kind === 'file') {
          // Show a frame from a moment in, for lining up the outline.
          const video = videoRef.current!;
          video.currentTime = Math.min(1, video.duration / 10);
        }
        setPhase('calibrate');
      } catch (e) {
        setError((e as Error).message || String(e));
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(slow);
      ctrlRef.current?.stop();
      srcRef.current?.stop();
    };
  }, [source, attempt]);

  // Keyboard / Bluetooth page-turner pedals and remotes: Space, Enter, → or Page Down snaps a page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phaseRef.current !== 'running' || srcRef.current?.kind === 'photos') return;
      if ([' ', 'Enter', 'ArrowRight', 'PageDown'].includes(e.key)) {
        e.preventDefault();
        ctrlRef.current?.snap();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Timed shots: count down, snap, and give the user the interval to turn the page.
  useEffect(() => {
    if (phase !== 'running' || mode !== 'timed' || !isCamera) {
      setCountdown(null);
      return;
    }
    let left = interval;
    setCountdown(left);
    const tick = setInterval(() => {
      left -= 0.1;
      if (left <= 0.05) {
        ctrlRef.current?.snap();
        setShotAt(Date.now());
        left = interval;
      }
      setCountdown(left);
    }, 100);
    return () => clearInterval(tick);
  }, [phase, mode, interval, isCamera]);

  const rotate = () => {
    const next = ((rotation + 90) % 360) as Rotation;
    setRotation(next);
    setCal(defaultCalibration(dims.w, dims.h, next, cal?.pages.length ?? 2));
  };
  const setPages = (n: number) => setCal(defaultCalibration(dims.w, dims.h, rotation, n));

  const start = async () => {
    if (!cal || !srcRef.current) return;
    await saveCalibration({ calibration: cal, rotation, frameW: dims.w, frameH: dims.h });
    const pagesPerSpread = cal.pages.length;
    diagnostics.startRun({
      source: isPhotos
        ? { kind: 'photos', count: (source as File[]).length, names: (source as File[]).map((f) => f.name) }
        : isVideo
          ? { kind: 'file', name: (source as File).name, type: (source as File).type, bytes: (source as File).size, duration: videoRef.current?.duration }
          : { kind: 'camera' },
      video: `${dims.w}x${dims.h}`,
      outline: cal,
      rotation,
      mode: isPhotos ? (lineUpEach ? 'photos, lined up each' : 'photos') : mode,
    });
    clickRef.current = makeClick(); // created on the tap so Safari allows sound
    const release = await keepAwake();
    const ctrl = new RunController(
      srcRef.current,
      cal,
      recognizer,
      {
        status: setStatus,
        sent: (f) => diagnostics.addFrames(f),
        captured: () => {
          if (soundRef.current) clickRef.current();
          setFlash((n) => n + 1);
        },
        spread: (r) => {
          onSpread(r, pagesPerSpread);
          // The outline stays where the user put it; if a page had to be found elsewhere, say so.
          if (r.retried.length) setShifted((n) => n + 1);
        },
        lineUp: (index, count, reason) => {
          setLineUp({ index, count, reason });
          setPhase('paused');
        },
        error: (e) => setError(e.message),
      },
      mode,
    );
    ctrl.lineUpEach = lineUpEach;
    ctrlRef.current = ctrl;
    setPhase('running');
    try {
      await ctrl.run();
    } catch (e) {
      ctrl.endedEarly ??= e instanceof Error ? e : new Error(String(e));
      setError(ctrl.endedEarly.message);
    } finally {
      release();
    }
    // If the run stopped early, say so and let the user go on to review what was captured.
    if (ctrl.endedEarly) setPhase('stopped');
    else onDone();
  };

  const pause = () => {
    ctrlRef.current?.pause();
    setPhase('paused');
  };
  const resume = () => {
    if (cal) ctrlRef.current?.resume(cal);
    setLineUp(null);
    setShifted(0);
    setPhase('running');
  };
  const skip = () => {
    ctrlRef.current?.skip();
    setLineUp(null);
    setPhase('running');
  };
  const finish = () => {
    setPhase('finishing');
    setLineUp(null);
    ctrlRef.current?.stop();
  };

  // Below 4K a card's name is under ~20 px tall: names and set symbols get hard to read.
  const lowRes = dims.w * dims.h > 0 && Math.max(dims.w, dims.h) < 3000 && phase !== 'opening';
  const editable = phase === 'calibrate' || phase === 'paused';
  const sourceWord = isPhotos ? 'photo' : isVideo ? 'video' : 'camera';
  const photoCount = isPhotos ? (source as File[]).length : 0;
  const justShot = Date.now() - shotAt < 1500;

  return (
    <div>
      <div className="topbar">
        <button className="back" onClick={onCancel}>‹ Cancel</button>
        <h1 className="ellipsis">
          {phase === 'calibrate' ? 'Line up the cards' : lineUp ? `Photo ${lineUp.index + 1} of ${lineUp.count}` : phase === 'paused' ? 'Paused: adjust the outline' : `Scanning “${binder}”`}
        </h1>
      </div>
      {error && <div className="notice error">{error}</div>}
      <div className="stage-wrap">
        <div className="stage" style={{ '--ar': `${dims.w} / ${dims.h}` } as React.CSSProperties}>
          {isPhotos ? <img ref={imgRef} alt="" /> : <video ref={videoRef} playsInline muted />}
          {cal && phase !== 'opening' && (
            <QuadOverlay cal={cal} width={dims.w} height={dims.h} editable={editable} onChange={setCal} highlight={status?.phase === 'settled'} />
          )}
          {flash > 0 && phase === 'running' && <div key={flash} className="capture-flash" />}
          {status && phase !== 'calibrate' && (
            <div className={`status-pill ${phase === 'paused' ? 'paused' : status.phase}`}>
              <span className="dot" />
              {phase === 'paused' ? 'Paused' : isPhotos ? `Photo ${Math.round(status.progress * photoCount)} of ${photoCount}` : PHASE_TEXT[status.phase]} · {spreadsSoFar}{' '}
              {isPhotos ? 'read' : `spread${spreadsSoFar === 1 ? '' : 's'}`}
              {status.processing > 0 ? ` · ${status.processing} reading` : ''}
            </div>
          )}
          {countdown !== null && phase === 'running' && (
            justShot ? <div className="countdown turn">Turn the page</div> : <div className="countdown">{Math.ceil(countdown)}</div>
          )}
        </div>
      </div>

      {phase === 'opening' && !error && (
        <p className="muted">{isPhotos ? 'Opening photos…' : isVideo ? openStep ?? 'Opening video…' : 'Starting camera… allow camera access if Safari asks.'}</p>
      )}
      {phase === 'opening' && (slowOpen || error) && (
        <div className="stack">
          {slowOpen && !error && (
            <p className="muted small" style={{ margin: 0 }}>
              This is taking longer than usual. Long 4K videos can be slow to open; if nothing happens, try again, or trim the video in Photos first.
            </p>
          )}
          <button className="btn block" onClick={() => { srcRef.current?.stop(); srcRef.current = null; setAttempt((n) => n + 1); }}>Try again</button>
        </div>
      )}

      {phase === 'calibrate' && cal && (
        <div className="stack">
          <p className="muted small" style={{ margin: 0 }}>
            Drag the four corners onto the outer corners of the cards{cal.pages.length > 1 ? ' (around both pages; drag the white tab to match the gap at the spine)' : ''}. The white edge is the top of the cards.
          </p>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <div className="seg">
              <button className={cal.pages.length === 1 ? 'on' : ''} onClick={() => setPages(1)}>One page</button>
              <button className={cal.pages.length === 2 ? 'on' : ''} onClick={() => setPages(2)}>Open binder</button>
            </div>
            <button className="btn small" onClick={rotate}>Rotate ↻</button>
            <button className="btn small" onClick={() => setCal(defaultCalibration(dims.w, dims.h, rotation, cal.pages.length))}>Reset</button>
          </div>
          {isCamera && (
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <span className="muted small">Capture pages</span>
              <div className="seg">
                {MODES.map((m) => (
                  <button key={m.mode} className={mode === m.mode ? 'on' : ''} onClick={() => setMode(m.mode)}>{m.label}</button>
                ))}
              </div>
              {mode === 'timed' && (
                <label className="row small" style={{ gap: 6 }}>
                  every
                  <select value={interval} onChange={(e) => { const v = Number(e.target.value); setIntervalState(v); write(INTERVAL_KEY, String(v)); }}>
                    {[3, 4, 5, 6, 8].map((s) => <option key={s} value={s}>{s} s</option>)}
                  </select>
                </label>
              )}
              <label className="row small" style={{ gap: 6 }}>
                <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} /> Click sound
              </label>
            </div>
          )}
          {isPhotos && (
            <label className="row small" style={{ gap: 8 }}>
              <input type="checkbox" checked={lineUpEach} onChange={(e) => setLineUpEach(e.target.checked)} />
              <span>Line up the outline on each photo <span className="muted">(for photos taken by hand; turn off if the phone was on a tripod)</span></span>
            </label>
          )}
          <p className="muted small" style={{ margin: 0 }}>
            {dims.w}×{dims.h} {sourceWord}{isPhotos ? ` · ${photoCount} photo${photoCount === 1 ? '' : 's'}` : ''}
          </p>
          {lowRes && (
            <div className="notice small" style={{ margin: 0 }}>
              {isVideo
                ? `This video is ${Math.min(dims.w, dims.h)}p. At this size card names and set symbols are only a few pixels tall, so more cards will need checking. For the best results take a photo of each page instead, or record in 4K: Settings › Camera › Record Video › 4K at 30 fps.`
                : isCamera
                  ? `The camera is giving ${dims.w}×${dims.h} here. For the sharpest results, take a photo of each page with the Camera app and upload the photos instead.`
                  : 'This photo is small. Photos straight from the Camera app (12 MP or more) give the best results.'}
            </div>
          )}
          <button className="btn primary block" onClick={start}>
            {isPhotos ? `Read ${photoCount} photo${photoCount === 1 ? '' : 's'}` : isVideo ? 'Process video' : 'Start run'}
          </button>
          {isCamera && (
            <p className="muted small" style={{ margin: 0 }}>
              {mode === 'auto'
                ? 'Turn the pages at a steady pace, pausing about half a second on each spread; you’ll hear a click as each one is captured. Snap a page by hand any time.'
                : mode === 'timed'
                  ? `A shot is taken every ${interval} seconds, with a click and a flash: turn the page right after each one.`
                  : 'Tap Snap page (or press Space / a Bluetooth page-turner) on each spread.'}
            </p>
          )}
        </div>
      )}

      {phase === 'running' && (
        <div className="stack">
          {shifted > 0 && (
            <div className="notice small" style={{ margin: 0 }}>
              On {shifted} capture{shifted === 1 ? '' : 's'} a page didn’t line up with the outline. If the cards aren’t inside the grid, tap Pause &amp; adjust.
            </div>
          )}
          {!isCamera && status && (
            <div className="progress" aria-label="progress">
              <div style={{ width: `${Math.round(status.progress * 100)}%` }} />
            </div>
          )}
          {isCamera && mode !== 'timed' && (
            <button className="btn primary block snap-btn" onClick={() => ctrlRef.current?.snap()}>
              Snap page
            </button>
          )}
          <div className="row">
            <button className="btn grow" onClick={pause}>Pause &amp; adjust</button>
            <button className="btn grow" onClick={finish}>{isCamera ? 'Finish' : 'Stop early'}</button>
          </div>
          {isCamera && (
            <div className="row" style={{ justifyContent: 'center' }}>
              <div className="seg">
                <button className={mode === 'auto' ? 'on' : ''} onClick={() => setMode('auto')}>Auto</button>
                <button className={mode === 'timed' ? 'on' : ''} onClick={() => setMode('timed')}>Timer</button>
                <button className={mode === 'manual' ? 'on' : ''} onClick={() => setMode('manual')}>Snap only</button>
              </div>
            </div>
          )}
        </div>
      )}

      {phase === 'paused' && (
        <div className="stack">
          <p className="muted small" style={{ margin: 0 }}>
            {lineUp?.reason === 'shape'
              ? 'This photo is a different shape from the first one: drag the corners onto its cards.'
              : lineUp
                ? 'Drag the corners onto the cards in this photo, then use it.'
                : 'Drag the corners onto the cards as they sit now, then continue.'}
          </p>
          <button className="btn primary block" onClick={resume}>{lineUp ? 'Use this photo' : 'Continue'}</button>
          {lineUp && <button className="btn block" onClick={skip}>Skip this photo</button>}
          <button className="btn block" onClick={finish}>Finish</button>
        </div>
      )}

      {phase === 'finishing' && <p className="muted">Finishing… reading the last {isPhotos ? 'photos' : 'spreads'}.</p>}

      {phase === 'stopped' && (
        <div className="stack">
          <p className="muted small" style={{ margin: 0 }}>
            The scan stopped early. Everything captured up to here is kept: review and save it.
          </p>
          <button className="btn primary block" onClick={onDone}>
            Review {spreadsSoFar} spread{spreadsSoFar === 1 ? '' : 's'}
          </button>
        </div>
      )}
    </div>
  );
}
