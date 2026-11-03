// Calibrate the tripod view, then run through the binder.
import { useEffect, useRef, useState } from 'react';
import { defaultCalibration, type Calibration, type Rotation } from '../core/geometry.ts';
import { keepAwake, openCamera, openVideoFile, type FrameSource } from '../app/capture.ts';
import { RunController, type RunStatus } from '../app/run.ts';
import type { Recognizer } from '../app/data.ts';
import type { WirePocket } from '../app/protocol.ts';
import { loadCalibration, saveCalibration } from '../app/store.ts';
import { QuadOverlay } from './QuadOverlay.tsx';

interface Props {
  binder: string;
  source: 'camera' | File;
  recognizer: Recognizer;
  spreadsSoFar: number;
  onSpread: (r: { pockets: WirePocket[]; ms: number; time: number }, pagesPerSpread: number) => void;
  onDone: () => void;
  onCancel: () => void;
}

type Phase = 'opening' | 'calibrate' | 'running' | 'finishing';

const PHASE_TEXT: Record<RunStatus['phase'], string> = {
  watching: 'Watching',
  moving: 'Page moving…',
  settled: 'Captured',
  finishing: 'Finishing…',
  done: 'Done',
};

export function ScanScreen({ binder, source, recognizer, spreadsSoFar, onSpread, onDone, onCancel }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const srcRef = useRef<FrameSource | null>(null);
  const ctrlRef = useRef<RunController | null>(null);
  const [phase, setPhase] = useState<Phase>('opening');
  const [dims, setDims] = useState({ w: 16, h: 9 });
  const [cal, setCal] = useState<Calibration | null>(null);
  const [rotation, setRotation] = useState<Rotation>(0);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isFile = source !== 'camera';

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

  const rotate = () => {
    const next = (((rotation + 90) % 360) as Rotation);
    setRotation(next);
    setCal(defaultCalibration(dims.w, dims.h, next, cal?.pages.length ?? 2));
  };
  const setPages = (n: number) => setCal(defaultCalibration(dims.w, dims.h, rotation, n));

  const start = async () => {
    if (!cal || !srcRef.current) return;
    await saveCalibration({ calibration: cal, rotation, frameW: dims.w, frameH: dims.h });
    const pagesPerSpread = cal.pages.length;
    const release = await keepAwake();
    const ctrl = new RunController(srcRef.current, cal, recognizer, {
      status: setStatus,
      spread: (r) => onSpread(r, pagesPerSpread),
      error: (e) => setError(e.message),
    });
    ctrlRef.current = ctrl;
    setPhase('running');
    try {
      await ctrl.run();
    } finally {
      release();
    }
    onDone();
  };

  const finish = () => {
    setPhase('finishing');
    ctrlRef.current?.stop();
  };

  const lowRes = dims.w * dims.h > 0 && Math.max(dims.w, dims.h) < 1920 && phase !== 'opening';

  return (
    <div>
      <div className="topbar">
        <button className="back" onClick={onCancel}>‹ Cancel</button>
        <h1 className="ellipsis">{phase === 'calibrate' ? 'Line up the pages' : `Scanning “${binder}”`}</h1>
      </div>
      {error && <div className="notice error">{error}</div>}
      <div className="stage-wrap">
        <div className="stage" style={{ '--ar': `${dims.w} / ${dims.h}` } as React.CSSProperties}>
          <video ref={videoRef} playsInline muted />
          {cal && phase !== 'opening' && (
            <QuadOverlay cal={cal} width={dims.w} height={dims.h} editable={phase === 'calibrate'} onChange={setCal} highlight={status?.phase === 'settled'} />
          )}
          {status && phase !== 'calibrate' && (
            <div className={`status-pill ${status.phase}`}>
              <span className="dot" />
              {PHASE_TEXT[status.phase]} · {spreadsSoFar} spread{spreadsSoFar === 1 ? '' : 's'}
              {status.processing > 0 ? ` · ${status.processing} reading` : ''}
            </div>
          )}
        </div>
      </div>

      {phase === 'opening' && !error && <p className="muted">{isFile ? 'Opening video…' : 'Starting camera… allow camera access if Safari asks.'}</p>}

      {phase === 'calibrate' && cal && (
        <div className="stack">
          <p className="muted small" style={{ margin: 0 }}>
            Drag the corners to the outer corners of the 3×3 card area on each page. The white edge is the top of the cards. You only need to do this once per tripod setup.
          </p>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <div className="seg">
              <button className={cal.pages.length === 2 ? 'on' : ''} onClick={() => setPages(2)}>Open binder</button>
              <button className={cal.pages.length === 1 ? 'on' : ''} onClick={() => setPages(1)}>One page</button>
            </div>
            <button className="btn small" onClick={rotate}>Rotate ↻</button>
            <button className="btn small" onClick={() => setCal(defaultCalibration(dims.w, dims.h, rotation, cal.pages.length))}>Reset</button>
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            {dims.w}×{dims.h} {isFile ? 'video' : 'camera'}
            {lowRes && ' — low resolution; record in 4K for best results (Settings › Camera › Record Video).'}
          </p>
          <button className="btn primary block" onClick={start}>
            {isFile ? 'Process video' : 'Start run'}
          </button>
          {!isFile && <p className="muted small" style={{ margin: 0 }}>Once started, turn the pages at a steady pace. Pause about a second on each spread so it settles.</p>}
        </div>
      )}

      {(phase === 'running' || phase === 'finishing') && (
        <div className="stack">
          {isFile && status && (
            <div className="progress" aria-label="progress">
              <div style={{ width: `${Math.round(status.progress * 100)}%` }} />
            </div>
          )}
          <button className="btn primary block" onClick={finish} disabled={phase === 'finishing'}>
            {phase === 'finishing' ? 'Finishing…' : isFile ? 'Stop early' : 'Finish run'}
          </button>
        </div>
      )}
    </div>
  );
}
