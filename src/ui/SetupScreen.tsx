import { useRef, useState } from 'react';
import type { Collection } from '../app/store.ts';

interface Props {
  collection: Collection;
  onStart: (binder: string, source: 'camera' | File) => void;
  onBack: () => void;
}

export function SetupScreen({ collection, onStart, onBack }: Props) {
  const [name, setName] = useState(collection.binders[0]?.name ?? 'Binder 1');
  const fileInput = useRef<HTMLInputElement>(null);
  const exists = collection.binders.some((b) => b.name === name.trim());

  return (
    <div>
      <div className="topbar">
        <button className="back" onClick={onBack}>‹ Back</button>
        <h1>Scan a binder</h1>
      </div>
      <div className="card stack">
        <label className="field">
          <span>Binder name</span>
          <input type="text" list="binders" value={name} onChange={(e) => setName(e.target.value)} />
          <datalist id="binders">
            {collection.binders.map((b) => (
              <option key={b.name} value={b.name} />
            ))}
          </datalist>
        </label>
        {exists && <div className="muted small">Saving will replace the cards stored for “{name.trim()}”.</div>}
        <button className="btn primary block" disabled={!name.trim()} onClick={() => onStart(name.trim(), 'camera')}>
          Use live camera
        </button>
        <button className="btn block" disabled={!name.trim()} onClick={() => fileInput.current?.click()}>
          Upload a video of the run
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="video/*"
          style={{ display: 'none' }}
          data-testid="video-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onStart(name.trim(), f);
          }}
        />
      </div>
      <div className="card">
        <h2>Before you record</h2>
        <p className="muted small" style={{ marginTop: 0 }}>Most misread cards come from blurry photos. These settings fix most of that.</p>
        <ol className="tips checklist">
          <li>
            <strong>Settings › Camera › Record Video:</strong> choose <strong>4K at 30 fps</strong>, turn <strong>HDR Video</strong> off, and
            turn <strong>Lock Camera</strong> on (so the phone doesn’t switch lenses mid-run). Turn Auto FPS off if you see it.
          </li>
          <li>
            <strong>Lock focus:</strong> in the Camera app, frame the open binder, then press and hold on the cards until
            <strong> AE/AF LOCK</strong> appears. Then start recording.
          </li>
          <li>
            <strong>Height:</strong> phone flat, about 50 cm (20 in) above the table. If one page comes out soft, raise the phone a little:
            the two halves of a thick binder sit at different heights.
          </li>
          <li>
            <strong>Light:</strong> bright and even, from two sides (or diffused), to avoid glare and slow, blurry exposures.
          </li>
          <li>
            <strong>Pace:</strong> pause about half a second on each spread and keep your hand out of frame between turns. Keep the binder in
            one spot (a strip of tape helps).
          </li>
        </ol>
        <p className="muted small" style={{ marginBottom: 0 }}>
          This app can’t lock the live camera’s focus, so a video recorded this way and uploaded gives the sharpest results.
        </p>
      </div>
    </div>
  );
}
