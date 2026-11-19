// Settings: the scan outline's colour and weight, the theme, how collections are shown, when a card is
// worth selling, and the scanning switches that apply to every scan.
import { useState } from 'react';
import type { CardDB } from '../core/carddb.ts';
import { luminance, OUTLINE_COLORS, OUTLINE_SCALE, SELL_SIGNALS, type LibraryView, type OutlineWeight, type Settings, type Theme } from '../app/settings.ts';
import { IconButton, SwitchRow } from './kit.tsx';

interface Props {
  db: CardDB | null;
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  englishOnly: boolean;
  onEnglishOnly: (on: boolean) => void;
  onBack: () => void;
}

const SOUND_KEY = 'mtgdb-capture-sound';
const readSound = () => {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off';
  } catch {
    return true;
  }
};

function Seg<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} className={value === o.value ? 'on' : ''} aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A binder page of light, dark and coloured cards with the outline over it, as it will look when scanning. */
function OutlinePreview({ settings }: { settings: Settings }) {
  const W = 300, H = 200, unit = Math.max(W, H) / 100;
  const w = OUTLINE_SCALE[settings.outlineWeight];
  const x0 = 36, y0 = 14, cw = 76, ch = 57.3;
  const cards = ['#e9e4d4', '#16161a', '#2a6fb0', '#a8321f', '#2f7a4b', '#c9a24e', '#8c8f96', '#f2efe6', '#3a2f4a'];
  const grid: string[] = [];
  for (let i = 0; i <= 3; i++) grid.push(`M${x0 + i * cw},${y0}V${y0 + 3 * ch}`, `M${x0},${y0 + i * ch}H${x0 + 3 * cw}`);
  const d = grid.join('');
  return (
    <div className="outline-preview" aria-hidden="true">
      <svg viewBox={`0 0 ${W} ${H}`}>
        {cards.map((c, i) => (
          <g key={i}>
            <rect x={x0 + (i % 3) * cw + 4} y={y0 + Math.floor(i / 3) * ch + 3} width={cw - 8} height={ch - 6} rx={3} fill={c} />
            <rect x={x0 + (i % 3) * cw + 9} y={y0 + Math.floor(i / 3) * ch + 9} width={cw - 18} height={ch * 0.45} fill={i % 2 ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.22)'} />
          </g>
        ))}
        {settings.outlineHalo && <path className="halo" d={d} strokeWidth={unit * w * 0.35 + unit * 0.5} />}
        <path d={d} fill="none" stroke="var(--outline)" strokeWidth={unit * w * 0.35} />
      </svg>
    </div>
  );
}

export function SettingsScreen({ db, settings, onChange, englishOnly, onEnglishOnly, onBack }: Props) {
  const [sound, setSoundState] = useState(readSound);
  const setSound = (on: boolean) => {
    setSoundState(on);
    try {
      localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');
    } catch {
      /* private mode */
    }
  };
  const colour = OUTLINE_COLORS.find((c) => c.id === settings.outlineColor) ?? OUTLINE_COLORS[0];
  return (
    <main className="settings">
      <div className="topbar">
        <IconButton icon="back" label="Back" onClick={onBack} />
        <h1 className="title-l" style={{ margin: 0 }}>Settings</h1>
      </div>

      <h2 className="eyebrow" id="outline-title">Scan outline</h2>
      <div className="group">
        <div className="setting">
          <div className="setting-title">Colour</div>
          <div className="setting-note">{colour.name}. Pick one that stands out from your cards and the table.</div>
          <div className="swatches" role="radiogroup" aria-labelledby="outline-title">
            {OUTLINE_COLORS.map((c) => (
              <button
                key={c.id}
                className="swatch"
                role="radio"
                aria-checked={settings.outlineColor === c.id}
                aria-label={c.name}
                title={c.name}
                style={{ background: c.hex, ['--check-ink' as string]: luminance(c.hex) > 0.35 ? '#000' : '#fff' }}
                onClick={() => onChange({ outlineColor: c.id })}
              />
            ))}
          </div>
          <OutlinePreview settings={settings} />
        </div>
        <div className="setting">
          <div className="setting-title">Line weight</div>
          <Seg<OutlineWeight> label="Line weight" value={settings.outlineWeight} onChange={(v) => onChange({ outlineWeight: v })} options={[{ value: 'thin', label: 'Thin' }, { value: 'medium', label: 'Medium' }, { value: 'thick', label: 'Thick' }]} />
        </div>
        <SwitchRow checked={settings.outlineHalo} onChange={(on) => onChange({ outlineHalo: on })} title="Contrast edge" description="A dark edge behind light colours (a light one behind dark colours), so the lines show over any card." />
      </div>

      <h2 className="eyebrow">Appearance</h2>
      <div className="group">
        <div className="setting">
          <div className="setting-title">Theme</div>
          <Seg<Theme> label="Theme" value={settings.theme} onChange={(v) => onChange({ theme: v })} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'Match phone' }]} />
        </div>
      </div>

      <h2 className="eyebrow">Collections</h2>
      <div className="group">
        <div className="setting">
          <div className="setting-title">Show cards as</div>
          <div className="setting-note">How a collection and Search open. You can still switch on each screen.</div>
          <Seg<LibraryView> label="Show cards as" value={settings.libraryView} onChange={(v) => onChange({ libraryView: v })} options={[{ value: 'gallery', label: 'Gallery' }, { value: 'list', label: 'List' }, { value: 'art', label: 'Art' }]} />
        </div>
        <div className="setting">
          <div className="setting-title">Worth selling when</div>
          <div className="setting-note">A card at least this far above its 30-day average (and $1 up) shows under Worth selling now.</div>
          <Seg<number> label="Worth selling when" value={settings.sellSignal} onChange={(v) => onChange({ sellSignal: v })} options={SELL_SIGNALS.map((v) => ({ value: v, label: `+${Math.round(v * 100)}%` }))} />
        </div>
      </div>

      <h2 className="eyebrow">Scanning</h2>
      <div className="group">
        <SwitchRow checked={englishOnly} onChange={onEnglishOnly} title="English cards only" description="Ignore foreign printings, which often share art with English ones." />
        <SwitchRow checked={sound} onChange={setSound} title="Click sound" description="A soft click each time a page is captured." />
        <SwitchRow
          checked={settings.keepHeic}
          onChange={(on) => onChange({ keepHeic: on })}
          title="Faster photo import"
          description="Hand photos over as they are (HEIC) instead of converting each one first, which is most of the wait after picking many photos. Needs iOS 17 or later: turn it off if photos won’t open."
        />
      </div>

      {db && (
        <p className="about">
          {db.count.toLocaleString()} printings · card data and prices from Scryfall ({db.file.source.replace('Scryfall ', '')})
          <br />
          Your collections are kept on this phone only.
        </p>
      )}
    </main>
  );
}
