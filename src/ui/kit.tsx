// Shared pieces of the MTGDB design system (see the "MTGDB Design System" Figma file):
// icons, tab bar, action sheet, switch rows, price badges and collection colours.
import { useEffect, useRef, type ReactNode } from 'react';
import { CATEGORY, formatUSD, type CardDB } from '../core/carddb.ts';
import type { Binder } from '../app/store.ts';

const PATHS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4.35-4.35"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  chevron: '<path d="M9 18l6-6-6-6"/>',
  close: '<path d="M18 6L6 18"/><path d="M6 6l12 12"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14L21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  share: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M16 6l-4-4-4 4"/><path d="M12 2v13"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
} as const;
export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 24 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: PATHS[name] }} />
  );
}

export function IconButton({ icon, label, onClick, filled }: { icon: IconName; label: string; onClick: () => void; filled?: boolean }) {
  return (
    <button className={`icon-btn${filled ? ' filled' : ''}`} aria-label={label} onClick={onClick}>
      <Icon name={icon} />
    </button>
  );
}

export type Tab = 'collections' | 'search';

/** Bottom navigation: Collections and Search, with Scan as the raised gold action. */
export function TabBar({ active, onTab, onScan, scanDisabled }: { active: Tab | null; onTab: (t: Tab) => void; onScan: () => void; scanDisabled?: boolean }) {
  return (
    <nav className="tabbar" aria-label="Main">
      <div>
        <button className="tab" aria-current={active === 'collections' ? 'page' : undefined} onClick={() => onTab('collections')}>
          <Icon name="grid" />
          <span>Collections</span>
        </button>
        <button className="tab-scan" aria-label="Scan cards" onClick={onScan} disabled={scanDisabled}>
          <span className="fab"><Icon name="camera" /></span>
          <span>Scan</span>
        </button>
        <button className="tab" aria-current={active === 'search' ? 'page' : undefined} onClick={() => onTab('search')}>
          <Icon name="search" />
          <span>Search</span>
        </button>
      </div>
    </nav>
  );
}

/** Bottom sheet for rare and destructive actions. Escape or a tap outside closes it. */
export function ActionSheet({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('.action-row:not(:disabled)')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close.current();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, []);
  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="grabber" />
        <div className="sheet-head">
          <div className="grow">
            <div className="title-m ellipsis">{title}</div>
            {subtitle && <div className="sub">{subtitle}</div>}
          </div>
          <IconButton icon="close" label="Close" onClick={onClose} filled />
        </div>
        {children}
      </div>
    </>
  );
}

export function ActionRow({ icon, label, note, onClick, danger, disabled }: { icon: IconName; label: string; note?: string; onClick: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <button className={`action-row${danger ? ' danger' : ''}`} onClick={onClick} disabled={disabled}>
      <Icon name={icon} />
      <span className="grow">
        <span style={{ display: 'block' }}>{label}</span>
        {note && <span className="note">{note}</span>}
      </span>
    </button>
  );
}

/** A setting with an on/off switch; the whole row is the tap target. */
export function SwitchRow({ checked, onChange, title, description }: { checked: boolean; onChange: (on: boolean) => void; title: string; description?: string }) {
  return (
    <button className="switch-row" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}>
      <span className="label">
        <strong>{title}</strong>
        {description && <span>{description}</span>}
      </span>
      <span className="switch" aria-hidden="true" />
    </button>
  );
}

/** Price movement: arrow and colour both carry the direction. */
export function PriceBadge({ change, pct, suffix }: { change: number | null | undefined; pct?: number | null; suffix?: string }) {
  if (change == null || Number.isNaN(change)) return null;
  const flat = Math.abs(change) < 0.005;
  const up = change > 0;
  const text = pct != null ? `${Math.abs(pct * 100).toFixed(1)}%` : formatUSD(Math.abs(change));
  return (
    <span className={`badge ${flat ? '' : up ? 'up' : 'down'}`} aria-label={`${flat ? 'No change' : up ? 'Up' : 'Down'} ${text}${suffix ? ` ${suffix}` : ''}`}>
      <span aria-hidden="true">{flat ? '–' : up ? '▲' : '▼'}</span> {text}
      {suffix && <span style={{ fontWeight: 500 }}> {suffix}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Collection colours

/** W/U/B/R/G, C (colourless, artifacts and lands) or M (multicolour). */
export type Mana = 'W' | 'U' | 'B' | 'R' | 'G' | 'C' | 'M';
const COLOURS: Mana[] = ['W', 'U', 'B', 'R', 'G'];
const CATS_KEY = 'mtgdb-binder-categories';

function savedCategories(): Record<string, number> {
  try {
    return (JSON.parse(localStorage.getItem(CATS_KEY) ?? 'null') as Record<string, number>) ?? {};
  } catch {
    return {};
  }
}

function manaOfMask(mask: number): Mana | null {
  const colours = COLOURS.filter((c) => mask & CATEGORY[c as 'W']);
  if (colours.length === 1 && !(mask & CATEGORY.multicolor)) return colours[0];
  if (colours.length > 1 || mask & CATEGORY.multicolor) return 'M';
  if (mask & (CATEGORY.artifact | CATEGORY.colorless | CATEGORY.land)) return 'C';
  return null;
}

/**
 * The colour of a collection's tile: what was chosen for it on the scan screen, or else the colour
 * most of its cards share (at least half of them), multicolour when they're spread out.
 */
export function collectionMana(db: CardDB, binder: Binder): Mana {
  const chosen = manaOfMask(savedCategories()[binder.name] ?? 0);
  if (chosen) return chosen;
  const counts = new Map<Mana, number>();
  let known = 0;
  for (const c of binder.cards) {
    const i = db.indexOfId(c.id);
    if (i < 0) continue;
    const m = manaOfMask(db.categoryOf(i));
    if (!m) continue;
    known++;
    counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  const [best, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['C', 0];
  return known && n / known >= 0.5 ? best : known ? 'M' : 'C';
}

export const LIGHT_TILES: Mana[] = ['W', 'M'];
