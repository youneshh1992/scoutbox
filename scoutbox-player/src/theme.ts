// ScoutBox Player is dark-only. Saved light preferences and OS appearance
// never select a different palette. Keep the approved dark values unchanged.
import { createContext, createElement, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { Platform, StyleSheet } from 'react-native';

export type Scheme = 'dark';

export const palettes = {
  dark: {
    gradientEnd: '#12161a', gradientInk: '#ffffff', gradientShade: 'rgba(0,0,0,0.55)',
    bg: '#0e131f',
    bg2: '#12161a',
    panel: '#161c24',
    panel2: '#202933',
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
    iconBg: '#18352f',
    iconFg: '#5aeeb2',
    passport: '#173b27',
    passportText: '#cfdfd0',
    mine: '#00e676',
    safety: '#202e3e',
    safetyText: '#b0d7f5',
    count: '#18352f',
    track: '#35424f',
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
    offer: '#00c8ff',
    offerBg: '#133240',
    offerInk: '#99e9ff',
    signing: '#00e676',
    signingBg: '#104735',
    signingInk: '#adf4c9',
    pitch: 'rgba(255,255,255,0.075)',
    grain: 'rgba(255,255,255,0.012)',
    band: 'rgba(255,255,255,0.009)',
    veil: 'rgba(0,0,0,0.68)',
    frame: '#12161a',
    frameLine: '#35424f',
    training: '#161c24',
    trainingDisc: '#203a37',
    trainingLine: '#00e676',
    bubbleMeta: '#b4d5bf',
    chatDate: '#aba2bb',
  },
} as const;

export type Palette = { [K in keyof typeof palettes.dark]: string };
interface ThemeValue { scheme: Scheme; colors: Palette }
const DARK_THEME: ThemeValue = { scheme: 'dark', colors: palettes.dark };
const ThemeContext = createContext<ThemeValue>(DARK_THEME);

export function ThemeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const root = document.documentElement;
    root.setAttribute('data-app', 'player');
    root.setAttribute('data-theme', 'dark');
    root.style.colorScheme = 'dark';
    document.body.style.backgroundColor = palettes.dark.frame;
  }, []);
  return createElement(ThemeContext.Provider, { value: DARK_THEME }, children);
}

export const useTheme = () => useContext(ThemeContext);

/** Authentication retains its approved deep-green brand palette. */
export const AUTH_PANEL: Palette = {
  ...palettes.dark,
  // M24C.3 — the entry palette: the dark football green of the Football
  // Passport card for the surfaces, white and #CFDFD0 for the text, the
  // bright brand green for the primary action, links and focus.
  bg: '#173b27', bg2: '#113822', panel: '#113822', panel2: '#1d4a33', line: 'rgba(207,223,208,0.35)',
  text: '#ffffff', muted: '#cfdfd0',
  accent: '#00e676', accentInk: '#113822', accentText: '#00e676', accent2: '#00e676',
  tabActive: '#ffffff', tabActiveBg: '#113822', tabInactive: '#cfdfd0',
  iconBg: '#113822', iconFg: '#5aeeb2', greenBg: '#113822', greenInk: '#e5f5e9', infoBg: '#113822', infoInk: '#e5f5e9',
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
