// ScoutBox Player — appearance.
//
// M24A: the palette is no longer a constant. The approved design has a light
// and a dark appearance (ScoutBox-Design-Explorer.html, Player screens); the
// values below are the reference's computed values, and every screen reads
// them through `useColors()` so a switch re-renders the whole app. The legacy
// key names (bg, panel, line, text, muted, accent …) are kept so call sites
// stay readable; the new keys carry the reference's specific surfaces.
//
// Persistence: the player's choice is stored under its own key
// (`sb-theme:player`) — localStorage on the web build, a small file on iOS
// and Android — so Pro, Grassroots and Agent never overwrite it. With nothing
// stored the app opens light, as the reference does.
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Platform, StyleSheet } from 'react-native';

export type Scheme = 'light' | 'dark';

export const palettes = {
  light: {
    bg: '#f6f7f3',        // the phone body (paper)
    bg2: '#ffffff',       // header and tab bar surfaces
    panel: '#ffffff',     // cards
    panel2: '#edf1e9',    // soft fill: tracks, tiles
    line: '#e1e6df',
    text: '#1e2923',
    muted: '#677268',
    accent: '#00e676',    // the brand green — fills and buttons
    accentInk: '#113822', // text on the brand green
    accentText: '#007f42',// green as text or icon on a light surface
    accent2: '#267248',   // links
    gold: '#a67c2e',
    danger: '#ab4736',
    tabActive: '#16733e',
    tabActiveBg: '#eef7eb',
    tabInactive: '#6c776c',
    iconBg: '#edf3e8',
    iconFg: '#437650',
    passport: '#173b27',
    passportText: '#cfdfd0',
    mine: '#dbf4e1',
    safety: '#eaf2e4',
    safetyText: '#547255',
    count: '#e5ede0',
    track: '#ccd5ce',
    knob: '#ffffff',
    greenBg: '#e1f2e5', greenInk: '#215b38',
    infoBg: '#e6eef8', infoInk: '#1e4a7a',
    goldBg: '#f7efd6', goldInk: '#7a5a12',
    dangerBg: '#fbe4e1', dangerInk: '#913b32',
    pitch: 'rgba(255,255,255,0.8)',
    grain: 'rgba(36,59,44,0.018)',
    band: 'rgba(36,59,44,0.009)',
    veil: 'rgba(30,41,35,0.42)',
    frame: '#e9eee6',      // the quiet surround outside the phone viewport (web only)
    frameLine: '#d9dfd5',
    training: '#dfead9',   // the Box Cam hero
    trainingDisc: '#f6fbf0',
    trainingLine: '#788675',
    bubbleMeta: '#75806c',
    chatDate: '#87917e',
  },
  dark: {
    bg: '#202223',
    bg2: '#1a1c1d',
    panel: '#272a2b',
    panel2: '#2a2d2e',
    line: '#393c3d',
    text: '#ffffff',
    muted: '#ffffff',
    accent: '#00e676',
    accentInk: '#113822',
    accentText: '#00e676',
    accent2: '#00e676',
    gold: '#d9b76b',
    danger: '#ff8e80',
    tabActive: '#00e676',
    tabActiveBg: '#2c3c31',
    tabInactive: '#ffffff',
    iconBg: '#333a35',
    iconFg: '#ffffff',
    passport: '#173b27',
    passportText: '#cfdfd0',
    mine: '#2c3c31',
    safety: '#2c3c31',
    safetyText: '#ffffff',
    count: '#333a35',
    track: '#ccd5ce',
    knob: '#ffffff',
    greenBg: '#2c3c31', greenInk: '#ffffff',
    infoBg: '#2c3c31', infoInk: '#ffffff',
    goldBg: '#3a3527', goldInk: '#ffffff',
    dangerBg: '#3c2a2a', dangerInk: '#ffffff',
    pitch: 'rgba(255,255,255,0.075)',
    grain: 'rgba(255,255,255,0.012)',
    band: 'rgba(255,255,255,0.009)',
    veil: 'rgba(0,0,0,0.62)',
    frame: '#181b1c',
    frameLine: '#2c3031',
    training: '#2c3330',
    trainingDisc: '#414a44',
    trainingLine: '#5c6a5e',
    bubbleMeta: '#b9c2b8',
    chatDate: '#9aa39a',
  },
} as const;

export type Palette = { [K in keyof typeof palettes.light]: string };

const STORAGE_KEY = 'sb-theme:player';
const DEFAULT: Scheme = 'light';
const isScheme = (v: unknown): v is Scheme => v === 'light' || v === 'dark';

async function readStored(): Promise<Scheme> {
  try {
    if (Platform.OS === 'web') {
      if (typeof localStorage === 'undefined') return DEFAULT;
      const v = localStorage.getItem(STORAGE_KEY);
      return isScheme(v) ? v : DEFAULT;
    }
    const fs = await import('expo-file-system/legacy');
    const file = `${fs.documentDirectory ?? ''}sb-theme.json`;
    const info = await fs.getInfoAsync(file);
    if (!info.exists) return DEFAULT;
    const v = JSON.parse(await fs.readAsStringAsync(file))?.scheme;
    return isScheme(v) ? v : DEFAULT;
  } catch { return DEFAULT; }
}
async function writeStored(scheme: Scheme): Promise<void> {
  try {
    if (Platform.OS === 'web') { if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, scheme); return; }
    const fs = await import('expo-file-system/legacy');
    await fs.writeAsStringAsync(`${fs.documentDirectory ?? ''}sb-theme.json`, JSON.stringify({ scheme }));
  } catch { /* the choice lasts the session */ }
}
/** Synchronous read for the web build, so the first frame is already right. */
function readSync(): Scheme {
  if (Platform.OS !== 'web') return DEFAULT;
  try { const v = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY); return isScheme(v) ? v : DEFAULT; } catch { return DEFAULT; }
}

interface ThemeValue { scheme: Scheme; colors: Palette; toggle: () => void; set: (s: Scheme) => void }
const ThemeContext = createContext<ThemeValue>({ scheme: DEFAULT, colors: palettes.light, toggle: () => {}, set: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [scheme, setScheme] = useState<Scheme>(readSync);
  useEffect(() => { if (Platform.OS !== 'web') void readStored().then(setScheme); }, []);
  // Web: stamp the document so the page background and form controls follow.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const root = document.documentElement;
    root.setAttribute('data-app', 'player'); root.setAttribute('data-theme', scheme); root.style.colorScheme = scheme;
    // M24C — the page behind the phone viewport is the quiet surround; the
    // viewport itself paints the app background.
    document.body.style.backgroundColor = palettes[scheme].frame;
  }, [scheme]);
  const set = useCallback((s: Scheme) => { setScheme(s); void writeStored(s); }, []);
  const toggle = useCallback(() => set(scheme === 'dark' ? 'light' : 'dark'), [scheme, set]);
  const value = useMemo<ThemeValue>(() => ({ scheme, colors: palettes[scheme], toggle, set }), [scheme, toggle, set]);
  return createElement(ThemeContext.Provider, { value }, children);
}

export const useTheme = () => useContext(ThemeContext);

/** M24C — the authentication composition has its own brand colours (the
 *  deep-green form panel) whatever appearance the player saved. Rendering a
 *  subtree under this provider makes every existing component read those
 *  colours; the saved light/dark choice is untouched and applies again the
 *  moment the person is signed in. */
export const AUTH_PANEL: Palette = {
  ...palettes.dark,
  bg: '#103a32', bg2: '#0e332c', panel: '#0d2f28', panel2: '#164839', line: '#2f6a57',
  text: '#f7faf7', muted: '#a9d9c2',
  accent: '#f7faf7', accentInk: '#103a32', accentText: '#00e676', accent2: '#8fe6b8',
  tabActive: '#f7faf7', tabActiveBg: '#164839', tabInactive: '#a9d9c2',
  iconBg: '#164839', iconFg: '#8fe6b8', greenBg: '#164839', greenInk: '#c8f3dc', infoBg: '#164839', infoInk: '#c8f3dc',
  danger: '#ffb3a8', dangerBg: '#4a2b27', dangerInk: '#ffd4cc', knob: '#f7faf7', track: '#2f6a57',
  frame: '#00e676', frameLine: '#00e676',
};
export const AUTH_PAGE = { green: '#00e676', promo: '#68e99f', ink: '#113822', inkSoft: '#1f5a3a' } as const;

export function ThemeOverride({ colors, children }: { colors: Palette; children: ReactNode }) {
  const base = useContext(ThemeContext);
  const value = useMemo<ThemeValue>(() => ({ ...base, colors }), [base, colors]);
  return createElement(ThemeContext.Provider, { value }, children);
}
export const useColors = (): Palette => useContext(ThemeContext).colors;

/** Theme-aware StyleSheet: `const styles = useStyles(makeStyles)` where
 *  `makeStyles = (colors: Palette) => StyleSheet.create({...})`. Memoised per palette. */
export function useStyles<T extends StyleSheet.NamedStyles<T>>(factory: (colors: Palette) => T): T {
  const colors = useColors();
  return useMemo(() => factory(colors), [factory, colors]);
}
