import { useRef, useState } from 'react';
import type { Collection } from '../app/store.ts';
import type { ScanSource } from './ScanScreen.tsx';

interface Props {
  collection: Collection;
  englishOnly: boolean;
  onEnglishOnly: (on: boolean) => void;
  onStart: (binder: string, source: ScanSource) => void;
  onBack: () => void;
}

export function SetupScreen({ collection, englishOnly, onEnglishOnly, onStart, onBack }: Props) {
  const [name, setName] = useState(collection.binders[0]?.name ?? 'Binder 1');
  const fileInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
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
        <label className="row small" style={{ gap: 8 }}>
          <input type="checkbox" checked={englishOnly} onChange={(e) => onEnglishOnly(e.target.checked)} />
          <span>My cards are in English <span className="muted">(ignore foreign-language printings, which often share art with English ones)</span></span>
        </label>
        <button className="btn primary block" disabled={!name.trim()} onClick={() => photoInput.current?.click()}>
          Upload photos (one per page)
        </button>
        <p className="muted small" style={{ margin: '-4px 0 0' }}>
          Most accurate: take a photo of each page (or open binder) with the Camera app, then pick them all here, in page order.
        </p>
        <button className="btn block" disabled={!name.trim()} onClick={() => onStart(name.trim(), 'camera')}>
          Use live camera
        </button>
        <button className="btn block" disabled={!name.trim()} onClick={() => fileInput.current?.click()}>
          Upload a video of the run
        </button>
        <input
          ref={photoInput}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          data-testid="photo-input"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            if (files.length) onStart(name.trim(), files);
          }}
        />
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
        <ol className="tips checklist">
          <li>
            <strong>Photos are the most accurate.</strong> Hold the phone flat over the binder and fill the frame with one page (or both
            pages of the open binder). Tap the cards on screen to focus before each shot. On a tripod, take the shot with the volume
            button, an Apple Watch or a Bluetooth shutter so the phone doesn’t move. Then pick all the photos here, in page order.
          </li>
          <li>
            <strong>Light:</strong> bright and even, from two sides (or diffused), so the sleeves don’t glare.
          </li>
          <li>
            <strong>Video instead?</strong> Settings › Camera › Record Video: <strong>4K at 30 fps</strong>, <strong>HDR Video</strong> off,
            <strong> Lock Camera</strong> on. In the Camera app, press and hold on the cards until <strong>AE/AF LOCK</strong> appears, then
            record, pausing about half a second on each spread.
          </li>
        </ol>
        <p className="muted small" style={{ marginBottom: 0 }}>
          This app can’t lock the live camera’s focus, so photos or a video from the Camera app read more cards correctly.
        </p>
      </div>
    </div>
  );
}
