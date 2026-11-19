// Preferences kept on this phone: how the app looks (theme, the scan outline), how collections are shown,
// and when a card counts as worth selling. Applied to the page as a data-theme attribute and CSS variables.

export type Theme = 'dark' | 'light' | 'system';
export type OutlineWeight = 'thin' | 'medium' | 'thick';
export type LibraryView = 'gallery' | 'list' | 'art';

export interface Settings {
  theme: Theme;
  /** Colour of the outline and pocket grid drawn over photos and video (an OUTLINE_COLORS id). */
  outlineColor: string;
  outlineWeight: OutlineWeight;
  /** A contrasting edge behind the outline, so it shows on light and dark cards alike. */
  outlineHalo: boolean;
  /** How a collection's cards are shown until you pick another view there. */
  libraryView: LibraryView;
  /** A card is worth selling when it's this far above its 30-day average (0.2 = 20%). */
  sellSignal: number;
  /**
   * Ask the Photos picker for photos as they are (HEIC). Safari otherwise converts each one to JPEG before
   * handing it over, the long wait after picking dozens of photos. Needs iOS 17 or later to open HEIC.
   */
  keepHeic: boolean;
}

/**
 * Outline colours: bright, saturated ones that stand out over card art, and the Okabe-Ito palette, which
 * people with the common kinds of colour blindness can tell apart.
 */
export const OUTLINE_COLORS: { id: string; name: string; hex: string }[] = [
  { id: 'gold', name: 'Gold', hex: '#d6b06a' },
  { id: 'white', name: 'White', hex: '#ffffff' },
  { id: 'yellow', name: 'Yellow', hex: '#ffe600' },
  { id: 'lime', name: 'Lime', hex: '#39ff14' },
  { id: 'cyan', name: 'Cyan', hex: '#00e5ff' },
  { id: 'magenta', name: 'Magenta', hex: '#ff2bd6' },
  { id: 'red', name: 'Red', hex: '#ff3b30' },
  { id: 'black', name: 'Black', hex: '#000000' },
  { id: 'cb-orange', name: 'Orange (colour-blind safe)', hex: '#e69f00' },
  { id: 'cb-sky', name: 'Sky blue (colour-blind safe)', hex: '#56b4e9' },
  { id: 'cb-green', name: 'Bluish green (colour-blind safe)', hex: '#009e73' },
  { id: 'cb-yellow', name: 'Pale yellow (colour-blind safe)', hex: '#f0e442' },
  { id: 'cb-blue', name: 'Blue (colour-blind safe)', hex: '#0072b2' },
  { id: 'cb-vermillion', name: 'Vermillion (colour-blind safe)', hex: '#d55e00' },
  { id: 'cb-purple', name: 'Reddish purple (colour-blind safe)', hex: '#cc79a7' },
];

export const SELL_SIGNALS = [0.1, 0.2, 0.3, 0.5];

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  outlineColor: 'yellow',
  outlineWeight: 'medium',
  outlineHalo: true,
  libraryView: 'gallery',
  sellSignal: 0.2,
  keepHeic: false,
};

const KEY = 'mtgdb-settings';

export function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Settings> | null;
    const s = { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
    if (!OUTLINE_COLORS.some((c) => c.id === s.outlineColor)) s.outlineColor = DEFAULT_SETTINGS.outlineColor;
    if (!SELL_SIGNALS.includes(s.sellSignal)) s.sellSignal = DEFAULT_SETTINGS.sellSignal;
    return s;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode: kept for this visit only */
  }
}

/** The settings last applied (for code outside React's tree, e.g. the outline's stroke widths). */
let current: Settings = DEFAULT_SETTINGS;
export const currentSettings = () => current;

export const outlineHex = (s: Settings) => (OUTLINE_COLORS.find((c) => c.id === s.outlineColor) ?? OUTLINE_COLORS[0]).hex;

/** Relative luminance (0 black .. 1 white) of a #rrggbb colour. */
export function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** Stroke width multiplier for the outline. */
export const OUTLINE_SCALE: Record<OutlineWeight, number> = { thin: 0.7, medium: 1.25, thick: 1.9 };

const prefersLight = () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;

/** The theme in effect (resolving "system"). */
export const effectiveTheme = (s: Settings): 'dark' | 'light' => (s.theme === 'system' ? (prefersLight() ? 'light' : 'dark') : s.theme);

export function applySettings(s: Settings) {
  current = s;
  const root = document.documentElement;
  const theme = effectiveTheme(s);
  root.dataset.theme = theme;
  const hex = outlineHex(s);
  root.style.setProperty('--outline', hex);
  // A dark edge behind light colours, a light one behind dark colours.
  root.style.setProperty('--outline-halo', luminance(hex) > 0.25 ? 'rgba(0, 0, 0, 0.7)' : 'rgba(255, 255, 255, 0.85)');
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute('content', theme === 'light' ? '#f6f3ec' : '#0b0b0f');
}
