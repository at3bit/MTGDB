// Calibrate the tripod view, then run through the binder. During a run you
// can pause to re-line-up the outline (the page stacks shift as you go),
// and snap pages by hand.
import { useEffect, useRef, useState } from 'react';
import { defaultCalibration, type Calibration, type Rotation } from '../core/geometry.ts';
import { keepAwake, openCamera, openVideoFile, type FrameSource } from '../app/capture.ts';
import { RunController, type CaptureMode, type RunStatus } from '../app/run.ts';
import type { Recognizer, SpreadReading } from '../app/data.ts';
import { loadCalibration, saveCalibration } from '../app/store.ts';
import { QuadOverlay } from './QuadOverlay.tsx';

interface Props {
  binder: string;
  source: 'camera' | File;
  recognizer: Recognizer;
  spreadsSoFar: number;
  onSpread: (r: SpreadReading & { time: number; change: number; manual: boolean }, pagesPerSpread: number) => void;
  onDone: () => void;
  onCancel: () => void;
}

type Phase = 'opening' | 'calibrate' | 'running' | 'paused' | 'finishing';

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

export function ScanScreen({ binder, source, recognizer, spreadsSoFar, onSpread, onDone, onCancel }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
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
  const [mode, setModeState] = useState<CaptureMode>(() => (read(MODE_KEY, 'auto') === 'manual' ? 'manual' : 'auto'));
  const [sound, setSoundState] = useState(() => read(SOUND_KEY, 'on') === 'on');
  const [flash, setFlash] = useState(0);
  const isFile = source !== 'camera';

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
  const soundRef = useRef(sound);
  soundRef.current = sound;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const video = videoRef.current!;
        const src = source === 'camera' ? await openCamera(video) : await openVideoFile(video, source);
        if (cancelled) return src.stop();
        srcRef.current = src;
        const w = src.width, h = src.height;
        setDims({ w, h });
        const saved = await loadCalibration();
        if (saved && Math.abs(saved.frameW / saved.frameH - w / h) < 0.01) {
          setCal(saved.calibration);
          setRotation(saved.rotation);
        } else {
          setCal(defaultCalibration(w, h, w >= h ? 0 : 90));
          setRotation(w >= h ? 0 : 90);
        }
        if (source !== 'camera') {
          // Show a frame from a moment in, for lining up the outline.
          video.currentTime = Math.min(1, video.duration / 10);
        }
        setPhase('calibrate');
      } catch (e) {
        setError((e as Error).message || String(e));
      }
    })();
    return () => {
      cancelled = true;
      ctrlRef.current?.stop();
      srcRef.current?.stop();
    };
  }, [source]);

  // Keyboard / Bluetooth page-turner pedals and remotes: Space, Enter, → or Page Down snaps a page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phaseRef.current !== 'running') return;
      if ([' ', 'Enter', 'ArrowRight', 'PageDown'].includes(e.key)) {
        e.preventDefault();
        ctrlRef.current?.snap();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
    clickRef.current = makeClick(); // created on the tap so Safari allows sound
    const release = await keepAwake();
    const ctrl = new RunController(
      srcRef.current,
      cal,
      recognizer,
      {
        status: setStatus,
        captured: () => {
          if (soundRef.current) clickRef.current();
          setFlash((n) => n + 1);
        },
        spread: (r) => {
          onSpread(r, pagesPerSpread);
          // Show the outline where the pages were actually found, so you can see it follow them
          // (but not while you're adjusting it by hand).
          if (phaseRef.current === 'running') setCal(r.calibration);
        },
        error: (e) => setError(e.message),
      },
      mode,
    );
    ctrlRef.current = ctrl;
    setPhase('running');
    try {
      await ctrl.run();
    } finally {
      release();
    }
    onDone();
  };

  const pause = () => {
    ctrlRef.current?.pause();
    setPhase('paused');
  };
  const resume = () => {
    if (cal) ctrlRef.current?.resume(cal);
    setPhase('running');
  };
  const finish = () => {
    setPhase('finishing');
    ctrlRef.current?.stop();
  };

  const lowRes = dims.w * dims.h > 0 && Math.max(dims.w, dims.h) < 1920 && phase !== 'opening';
  const editable = phase === 'calibrate' || phase === 'paused';

  return (
    <div>
      <div className="topbar">
        <button className="back" onClick={onCancel}>‹ Cancel</button>
        <h1 className="ellipsis">{phase === 'calibrate' ? 'Line up the pages' : phase === 'paused' ? 'Paused: adjust the outline' : `Scanning “${binder}”`}</h1>
      </div>
      {error && <div className="notice error">{error}</div>}
      <div className="stage-wrap">
        <div className="stage" style={{ '--ar': `${dims.w} / ${dims.h}` } as React.CSSProperties}>
          <video ref={videoRef} playsInline muted />
          {cal && phase !== 'opening' && (
            <QuadOverlay cal={cal} width={dims.w} height={dims.h} editable={editable} onChange={setCal} highlight={status?.phase === 'settled'} />
          )}
          {flash > 0 && phase === 'running' && <div key={flash} className="capture-flash" />}
          {status && phase !== 'calibrate' && (
            <div className={`status-pill ${phase === 'paused' ? 'paused' : status.phase}`}>
              <span className="dot" />
              {phase === 'paused' ? 'Paused' : PHASE_TEXT[status.phase]} · {spreadsSoFar} spread{spreadsSoFar === 1 ? '' : 's'}
              {status.processing > 0 ? ` · ${status.processing} reading` : ''}
            </div>
          )}
        </div>
      </div>

      {phase === 'opening' && !error && <p className="muted">{isFile ? 'Opening video…' : 'Starting camera… allow camera access if Safari asks.'}</p>}

      {phase === 'calibrate' && cal && (
        <div className="stack">
          <p className="muted small" style={{ margin: 0 }}>
            Drag the corners to the outer corners of the 3×3 card area on each page. The white edge is the top of the cards.
          </p>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <div className="seg">
              <button className={cal.pages.length === 2 ? 'on' : ''} onClick={() => setPages(2)}>Open binder</button>
              <button className={cal.pages.length === 1 ? 'on' : ''} onClick={() => setPages(1)}>One page</button>
            </div>
            <button className="btn small" onClick={rotate}>Rotate ↻</button>
            <button className="btn small" onClick={() => setCal(defaultCalibration(dims.w, dims.h, rotation, cal.pages.length))}>Reset</button>
          </div>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <span className="muted small">Capture pages</span>
            <div className="seg">
              <button className={mode === 'auto' ? 'on' : ''} onClick={() => setMode('auto')}>Automatically</button>
              <button className={mode === 'manual' ? 'on' : ''} onClick={() => setMode('manual')}>When I tap Snap</button>
            </div>
            <label className="row small" style={{ gap: 6 }}>
              <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} /> Click sound
            </label>
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            {dims.w}×{dims.h} {isFile ? 'video' : 'camera'}
            {lowRes && ' — low resolution; record in 4K for best results (Settings › Camera › Record Video).'}
          </p>
          <button className="btn primary block" onClick={start}>
            {isFile ? 'Process video' : 'Start run'}
          </button>
          {!isFile && (
            <p className="muted small" style={{ margin: 0 }}>
              {mode === 'auto'
                ? 'Turn the pages at a steady pace, pausing about half a second on each spread; you’ll hear a click as each one is captured. Snap a page by hand any time.'
                : 'Tap Snap page (or press Space / a Bluetooth page-turner) on each spread.'}
            </p>
          )}
        </div>
      )}

      {phase === 'running' && (
        <div className="stack">
          {isFile && status && (
            <div className="progress" aria-label="progress">
              <div style={{ width: `${Math.round(status.progress * 100)}%` }} />
            </div>
          )}
          {!isFile && (
            <button className="btn primary block snap-btn" onClick={() => ctrlRef.current?.snap()}>
              Snap page
            </button>
          )}
          <div className="row">
            <button className="btn grow" onClick={pause}>Pause &amp; adjust</button>
            <button className="btn grow" onClick={finish}>{isFile ? 'Stop early' : 'Finish'}</button>
          </div>
          {!isFile && (
            <div className="row" style={{ justifyContent: 'center' }}>
              <div className="seg">
                <button className={mode === 'auto' ? 'on' : ''} onClick={() => setMode('auto')}>Auto</button>
                <button className={mode === 'manual' ? 'on' : ''} onClick={() => setMode('manual')}>Snap only</button>
              </div>
            </div>
          )}
        </div>
      )}

      {phase === 'paused' && (
        <div className="stack">
          <p className="muted small" style={{ margin: 0 }}>
            Drag the corners onto the pages as they sit now, then continue. Page tracking restarts from your outline.
          </p>
          <button className="btn primary block" onClick={resume}>Continue</button>
          <button className="btn block" onClick={finish}>Finish</button>
        </div>
      )}

      {phase === 'finishing' && <p className="muted">Finishing… reading the last spreads.</p>}
    </div>
  );
}
