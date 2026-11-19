import { useEffect, useRef, useState } from 'react';
import { CATEGORY, type Category } from '../core/carddb.ts';
import type { Collection } from '../app/store.ts';
import type { ScanSource } from './ScanScreen.tsx';
import { SwitchRow } from './kit.tsx';

/** Choices made before a scan. */
export interface ScanOptions {
  /** CATEGORY bits of what the collection holds (0 = anything). */
  categories: number;
  /** Empty sleeves hold a blank card, so nothing can be seen through them. */
  blankFillers: boolean;
  /** Add these cards to a collection saved earlier (rather than start a new one). */
  addToExisting: boolean;
}

const CHIPS: { cat: Category; label: string }[] = [
  { cat: 'W', label: 'White' },
  { cat: 'U', label: 'Blue' },
  { cat: 'B', label: 'Black' },
  { cat: 'R', label: 'Red' },
  { cat: 'G', label: 'Green' },
  { cat: 'multicolor', label: 'Multicolor' },
  { cat: 'artifact', label: 'Artifact' },
  { cat: 'land', label: 'Land' },
  { cat: 'colorless', label: 'Colorless' },
];

const CATS_KEY = 'mtgdb-binder-categories';
const FILLERS_KEY = 'mtgdb-blank-fillers';
const readJSON = <T,>(k: string, d: T): T => {
  try {
    return (JSON.parse(localStorage.getItem(k) ?? 'null') as T) ?? d;
  } catch {
    return d;
  }
};
const writeJSON = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* private mode */
  }
};

interface Props {
  collection: Collection;
  englishOnly: boolean;
  onEnglishOnly: (on: boolean) => void;
  onStart: (binder: string, source: ScanSource, options: ScanOptions) => void;
  /** Whether the card data knows colours and types. */
  hasCategories: boolean;
  onBack: () => void;
  /** Opened from the "New collection" tile: start on the name field. */
  startCreating?: boolean;
  /** Ask for photos as they are (HEIC) rather than converted to JPEG: see Settings.keepHeic. */
  keepHeic?: boolean;
}

export function SetupScreen({ collection, englishOnly, onEnglishOnly, onStart, onBack, hasCategories, startCreating, keepHeic }: Props) {
  const existing = collection.binders;
  // Add to a collection saved earlier (the most recently scanned first), or create a new one.
  const [creating, setCreating] = useState(existing.length === 0 || !!startCreating);
  const [picked, setPicked] = useState(existing[0]?.name ?? '');
  const [newName, setNewName] = useState('');
  const pickedSaved = existing.find((b) => b.name === picked);
  const name = creating || !pickedSaved ? newName : picked;
  const taken = creating ? existing.find((b) => b.name.toLowerCase() === newName.trim().toLowerCase()) : undefined;
  const ready = !!name.trim() && !taken;
  const fileInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);

  // What each binder holds is remembered by its name ("Black binder" stays Black). The colours picked here
  // stay picked while the name is typed or changed (they used to be filed under the name as it was then, so
  // picking Blue before typing "Blue UC/R" scanned with no colours at all); they're saved under the name the
  // scan starts with, and a collection that has colours remembered shows them when it's picked.
  const [byBinder] = useState<Record<string, number>>(() => readJSON(CATS_KEY, {}));
  const [categories, setCategories] = useState<number>(() => byBinder[name.trim()] ?? 0);
  useEffect(() => {
    const remembered = byBinder[name.trim()];
    if (remembered !== undefined) setCategories(remembered);
  }, [name, byBinder]);
  const [blankFillers, setBlankFillers] = useState(() => readJSON(FILLERS_KEY, false));
  const start = (source: ScanSource) => {
    writeJSON(CATS_KEY, { ...readJSON<Record<string, number>>(CATS_KEY, {}), [name.trim()]: categories });
    onStart(name.trim(), source, { categories, blankFillers, addToExisting: !creating && !!pickedSaved });
  };
  /**
   * The Photos picker is open, or handing the photos over: iOS converts each one before the page gets
   * any, which takes a while for dozens of photos, so the app says it's waiting rather than look idle.
   */
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    const input = photoInput.current;
    if (!input) return;
    const cancel = () => setPicking(false);
    input.addEventListener('cancel', cancel);
    return () => input.removeEventListener('cancel', cancel);
  }, []);

  return (
    <main>
      {picking && (
        <div className="picking" role="status" aria-live="polite" data-testid="picking">
          <div className="spinner" aria-hidden="true" />
          <p className="title-m" style={{ margin: 0 }}>Getting your photos…</p>
          <p className="muted small" style={{ margin: 0 }}>
            The Photos app prepares each photo before handing it over: a few seconds for a handful, a minute or more for 50 or more.
            {keepHeic ? '' : ' Faster photo import in Settings skips most of this.'}
          </p>
          <button className="btn quiet" onClick={() => setPicking(false)}>
            Cancel
          </button>
        </div>
      )}
      <div className="topbar">
        <button className="back" onClick={onBack}>‹ Back</button>
        <h1>Scan cards</h1>
      </div>
      <p className="muted" style={{ margin: '-4px 0 16px' }}>Add binder pages to a collection. Photos of 3 × 3 pages work best.</p>
      <div className="card stack">
        {!creating ? (
          <>
            <label className="field">
              <span>Add to collection</span>
              <select className="select block-select" value={picked} onChange={(e) => setPicked(e.target.value)} aria-label="Add to collection">
                {existing.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name} ({b.cards.length} card{b.cards.length === 1 ? '' : 's'})
                  </option>
                ))}
              </select>
            </label>
            <p className="muted small" style={{ margin: '-4px 0 0' }}>
              New pages go after its {pickedSaved?.cards.length ?? 0} cards; printings it already has aren’t added twice.
            </p>
            <button className="btn block" onClick={() => setCreating(true)}>+ Create new collection</button>
          </>
        ) : (
          <>
            <label className="field">
              <span>New collection name</span>
              <input type="text" value={newName} placeholder="e.g. Black UC/R" autoFocus={existing.length > 0} onChange={(e) => setNewName(e.target.value)} />
            </label>
            {taken && (
              <div className="notice small" style={{ margin: 0 }}>
                You already have a collection called “{taken.name}”.{' '}
                <button className="linkish" onClick={() => { setPicked(taken.name); setCreating(false); setNewName(''); }}>Add to it instead</button>
              </div>
            )}
            {existing.length > 0 && !taken && (
              <button className="btn block" onClick={() => { setCreating(false); setNewName(''); }}>‹ Add to an existing collection instead</button>
            )}
          </>
        )}
        {hasCategories && (
          <div>
            <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--muted)', marginBottom: 8 }}>
              Colours in this collection <span style={{ fontWeight: 400 }}>· checked first</span>
            </div>
            <div className="chips" role="group" aria-label="Collection colours and types">
              <button className={`chip ${categories === 0 ? 'on' : ''}`} onClick={() => setCategories(0)}>Anything</button>
              {CHIPS.map(({ cat, label }) => (
                <button
                  key={cat}
                  className={`chip ${categories & CATEGORY[cat] ? 'on' : ''}`}
                  aria-pressed={!!(categories & CATEGORY[cat])}
                  onClick={() => setCategories(categories ^ CATEGORY[cat])}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
        <div>
          <SwitchRow
            checked={blankFillers}
            onChange={(on) => { setBlankFillers(on); writeJSON(FILLERS_KEY, on); }}
            title="Blank sleeves are fillers"
            description="Empty pockets hold a blank card, so nothing shows through them."
          />
          <SwitchRow checked={englishOnly} onChange={onEnglishOnly} title="English cards only" description="Ignore foreign printings, which often share art with English ones." />
        </div>
        <button
          className="btn primary block large"
          disabled={!ready}
          onClick={() => {
            setPicking(true);
            photoInput.current?.click();
          }}
        >
          Upload photos (one per page)
        </button>
        <p className="muted small" style={{ margin: '-4px 0 0' }}>
          Most accurate: photograph each page with the Camera app, then pick the photos here in page order.
        </p>
        <button className="btn block" disabled={!ready} onClick={() => start('camera')}>
          Use live camera
        </button>
        <button className="btn block" disabled={!ready} onClick={() => fileInput.current?.click()}>
          Upload a video of the run
        </button>
        <input
          ref={photoInput}
          type="file"
          accept={keepHeic ? 'image/*,image/heic,image/heif' : 'image/*'}
          multiple
          style={{ display: 'none' }}
          data-testid="photo-input"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            setPicking(false);
            if (files.length) start(files);
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
            if (f) start(f);
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
    </main>
  );
}
