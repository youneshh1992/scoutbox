// ScoutBox design system — appearance (light / dark) for the web portals.
//
// One theme per application, persisted independently under its own key, so
// switching Pro to dark never touches Grassroots or the Agent workspace. The
// default when nothing is stored follows the approved reference: Agent opens
// dark, every other application opens light.
//
// The attribute lives on <html> (`data-theme`, beside `data-app`) so the
// tokens apply to everything — dialogs, drawers, menus, toasts and routes
// opened later — and a one-line script in each index.html restores it
// BEFORE the first paint, so a saved dark theme never flashes light.
import { useCallback, useEffect, useState } from 'react';
import { Icon } from './icons';

export type AppKey = 'pro' | 'grass' | 'agent' | 'safety' | 'player';
export type Theme = 'light' | 'dark';

export const THEME_DEFAULTS: Record<AppKey, Theme> = { pro: 'light', grass: 'light', agent: 'dark', safety: 'light', player: 'light' };
export const themeStorageKey = (app: AppKey) => `sb-theme:${app}`;

export function readTheme(app: AppKey): Theme {
  try {
    const v = localStorage.getItem(themeStorageKey(app));
    return v === 'dark' || v === 'light' ? v : THEME_DEFAULTS[app];
  } catch { return THEME_DEFAULTS[app]; }
}

/** Stamp the document. `data-app` scopes the application palette (Agent
 *  cream, Grassroots turf); `data-theme` selects light or dark. */
export function applyTheme(app: AppKey, theme: Theme) {
  const root = document.documentElement;
  root.setAttribute('data-app', app);
  root.setAttribute('data-theme', theme);
  root.style.colorScheme = theme;
}

export function useTheme(app: AppKey): { theme: Theme; toggle: () => void; set: (t: Theme) => void } {
  const [theme, setTheme] = useState<Theme>(() => readTheme(app));
  useEffect(() => { applyTheme(app, theme); }, [app, theme]);
  // Another tab of the same application changed its appearance: follow it.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (e.key === themeStorageKey(app)) setTheme(readTheme(app)); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [app]);
  const set = useCallback((t: Theme) => {
    setTheme(t);
    try { localStorage.setItem(themeStorageKey(app), t); } catch { /* private mode: the choice lasts the session */ }
  }, [app]);
  const toggle = useCallback(() => set(theme === 'dark' ? 'light' : 'dark'), [set, theme]);
  return { theme, toggle, set };
}

/** The appearance control from the reference header: a switch whose checked
 *  state is "dark". Keyboard: Space/Enter (a native button). The visible word
 *  is hidden in the phone header, where the track alone carries the state. */
export function ThemeToggle({ theme, onToggle, labels }: {
  theme: Theme; onToggle: () => void;
  labels: { aria: string; light: string; dark: string };
}) {
  const dark = theme === 'dark';
  return (
    <button
      type="button"
      className="p-theme-toggle"
      role="switch"
      aria-checked={dark}
      aria-label={labels.aria}
      onClick={onToggle}
      data-theme-toggle
    >
      <Icon name={dark ? 'moon' : 'sun'} size={15} />
      <span className="p-theme-text">{dark ? labels.dark : labels.light}</span>
      <span className="p-theme-track" aria-hidden="true"><span /></span>
    </button>
  );
}

/** Inline in <head> before the stylesheet: restores the saved theme with no
 *  flash. Kept as a string so each index.html can paste the same line. */
export const PREPAINT_SCRIPT = (app: AppKey) =>
  `(function(){var d='${THEME_DEFAULTS[app]}',t=d;try{var v=localStorage.getItem('sb-theme:${app}');if(v==='dark'||v==='light')t=v;}catch(e){}var r=document.documentElement;r.setAttribute('data-app','${app}');r.setAttribute('data-theme',t);r.style.colorScheme=t;})();`;
