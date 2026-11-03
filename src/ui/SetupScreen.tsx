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
        <h2>For the best results</h2>
        <ul className="tips">
          <li>Light from two sides (or soft, diffused light) to keep glare off the pocket plastic.</li>
          <li>Hold the phone parallel to the table, about 50 cm (20 in) up for an open binder.</li>
          <li>For uploads, record in 4K: Settings › Camera › Record Video › 4K at 30 fps.</li>
          <li>Keep the binder in the same spot; a strip of tape on the table helps.</li>
          <li>Pause about a second on each spread. Your hand can stay out of frame between turns.</li>
        </ul>
      </div>
    </div>
  );
}
