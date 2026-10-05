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
    bg: '#f1fff8',
    bg2: '#ffffff',
    panel: '#ffffff',
    panel2: 'rgba(118,113,237,0.09)',
    line: '#e5e3ee',
    text: '#191827',
    muted: '#696578',
    accent: '#00e676',
    accentInk: '#113822',
    accentText: '#007b40',
    accent2: '#007b40',
    gold: '#986316',
    danger: '#b52f48',
    tabActive: '#006f3a',
    tabActiveBg: '#d7fbe7',
    tabInactive: '#767083',
    iconBg: '#e9e2ff',
    iconFg: '#6b45bd',
    passport: '#173b27',
    passportText: '#cfdfd0',
    mine: '#d7fbe7',
    safety: '#e8f5ff',
    safetyText: '#315c79',
    count: '#e9e2ff',
    track: '#cfccda',
    knob: '#ffffff',
    greenBg: '#d7fbe7',
    greenInk: '#125737',
    infoBg: '#e7edff',
    infoInk: '#354b97',
    goldBg: '#fff0d9',
    goldInk: '#845217',
    dangerBg: '#ffe6ed',
    dangerInk: '#9f2946',
    trial: '#d18a25',
    trialBg: '#fff0d9',
    trialInk: '#845217',
    offer: '#7760d5',
    offerBg: '#eee8ff',
    offerInk: '#5c3e9b',
    signing: '#007f42',
    signingBg: '#d7fbe7',
    signingInk: '#125737',
    pitch: 'rgba(255,255,255,0.8)',
    grain: 'rgba(36,59,44,0.018)',
    band: 'rgba(36,59,44,0.009)',
    veil: 'rgba(25,24,39,0.48)',
    frame: '#ddecf3',
    frameLine: '#d7d1e3',
    training: '#dfd7ff',
    trainingDisc: '#f7f2ff',
    trainingLine: '#7961ae',
    bubbleMeta: '#587366',
    chatDate: '#777083',
  },
  dark: {
    bg: '#070c10',
    bg2: '#0a131b',
    panel: 'rgba(14,24,35,0.78)',
    panel2: 'rgba(83,88,127,0.20)',
    line: 'rgba(181,214,255,0.16)',
    text: '#faf8ff',
    muted: '#b9ccda',
    accent: '#00e676',
    accentInk: '#113822',
    accentText: '#00e676',
    accent2: '#00e676',
    gold: '#f6c376',
    danger: '#ff97ae',
    tabActive: '#00e676',
    tabActiveBg: '#183b2c',
    tabInactive: '#aaa3ba',
    iconBg: 'rgba(143,96,255,0.22)',
    iconFg: '#c6acff',
    passport: '#173b27',
    passportText: '#cfdfd0',
    mine: '#00e676',
    safety: '#202e3e',
    safetyText: '#b0d7f5',
    count: 'rgba(143,96,255,0.22)',
    track: '#514a61',
    knob: '#ffffff',
    greenBg: '#104735',
    greenInk: '#adf4c9',
    infoBg: '#242e50',
    infoInk: '#bccdff',
    goldBg: '#422f20',
    goldInk: '#ffd399',
    dangerBg: '#432231',
    dangerInk: '#ffb5c8',
    trial: '#f6c376',
    trialBg: '#422f20',
    trialInk: '#ffd399',
    offer: '#b89bff',
    offerBg: '#35294d',
    offerInk: '#ddccff',
    signing: '#00e676',
    signingBg: '#104735',
    signingInk: '#adf4c9',
    pitch: 'rgba(255,255,255,0.075)',
    grain: 'rgba(255,255,255,0.012)',
    band: 'rgba(255,255,255,0.009)',
    veil: 'rgba(0,0,0,0.68)',
    frame: '#070d12',
    frameLine: '#302a3c',
    training: '#37294e',
    trainingDisc: '#54416f',
    trainingLine: '#c6acff',
    bubbleMeta: '#b4d5bf',
    chatDate: '#aba2bb',
  },
} as const;

export type Palette = { [K in keyof typeof palettes.light]: string };

const STORAGE_KEY = 'sb-theme:player';
const DEFAULT: Scheme = 'dark';
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
  // M24C.3 — the entry palette: the dark football green of the Football
  // Passport card for the surfaces, white and #CFDFD0 for the text, the
  // bright brand green for the primary action, links and focus.
  bg: '#173b27', bg2: '#113822', panel: '#113822', panel2: '#1d4a33', line: 'rgba(207,223,208,0.35)',
  text: '#ffffff', muted: '#cfdfd0',
  accent: '#00e676', accentInk: '#113822', accentText: '#00e676', accent2: '#00e676',
  tabActive: '#ffffff', tabActiveBg: '#113822', tabInactive: '#cfdfd0',
  iconBg: '#113822', iconFg: '#00e676', greenBg: '#113822', greenInk: '#e5f5e9', infoBg: '#113822', infoInk: '#e5f5e9',
  goldBg: '#113822', goldInk: '#f3dca3',
  trial: '#e9c46a', trialBg: '#113822', trialInk: '#f3dca3', offer: '#6fd3cc', offerBg: '#113822', offerInk: '#bfe9e5', signing: '#00e676', signingBg: '#113822', signingInk: '#d6f5df',
  // errors keep their own hue so a refusal never reads as success
  danger: '#ffb3a8', dangerBg: '#4a2b27', dangerInk: '#ffd4cc', knob: '#ffffff', track: 'rgba(207,223,208,0.35)',
  frame: '#173b27', frameLine: '#173b27',
  // the pitch behind the entry screen: white lines at 8%, grain under 2%
  pitch: 'rgba(255,255,255,0.08)', grain: 'rgba(255,255,255,0.016)', band: 'rgba(255,255,255,0.012)',
};
export const AUTH_PAGE = { page: '#173b27', panel: '#173b27', green: '#00e676', ink: '#113822', white: '#ffffff', soft: '#cfdfd0', pale: '#e5f5e9', panelLine: 'rgba(255,255,255,0.14)' } as const;

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
