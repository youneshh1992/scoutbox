// M15-Nav — one consistent inline-SVG icon set (16×16, stroke-based).
// No emoji in primary navigation, no external icon library: the demo builds
// stay self-contained and every icon shares stroke weight and style.
import type { ReactElement } from 'react';

const PATHS: Record<string, ReactElement> = {
  home: <path d="M2.5 7.5 8 2.5l5.5 5v5.5a1 1 0 0 1-1 1h-3v-4h-3v4h-3a1 1 0 0 1-1-1z" />,
  search: <><circle cx="7" cy="7" r="4.2" /><path d="m10.2 10.2 3.3 3.3" /></>,
  target: <><circle cx="8" cy="8" r="5.6" /><circle cx="8" cy="8" r="2.4" /><path d="M8 1v2.2M8 12.8V15M1 8h2.2M12.8 8H15" /></>,
  clipboard: <><rect x="3.2" y="2.8" width="9.6" height="11" rx="1.2" /><path d="M5.8 2.8V2a.8.8 0 0 1 .8-.8h2.8a.8.8 0 0 1 .8.8v.8M5.6 6.8h4.8M5.6 9.3h4.8M5.6 11.8h3" /></>,
  globe: <><circle cx="8" cy="8" r="5.8" /><path d="M2.2 8h11.6M8 2.2c1.8 1.6 2.7 3.6 2.7 5.8S9.8 12.2 8 13.8C6.2 12.2 5.3 10.2 5.3 8S6.2 3.8 8 2.2z" /></>,
  building: <><rect x="3.2" y="2.5" width="9.6" height="11" rx="0.8" /><path d="M6 5.2h1.4M8.8 5.2h1.4M6 7.7h1.4M8.8 7.7h1.4M6 10.2h1.4M8.8 10.2h1.4M6.8 13.5v-1.6h2.4v1.6" /></>,
  inbox: <><path d="M2.5 9.2 4.4 3.6A1 1 0 0 1 5.3 3h5.4a1 1 0 0 1 .9.6l1.9 5.6v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1z" /><path d="M2.5 9.2h3.3l.7 1.5h3l.7-1.5h3.3" /></>,
  help: <><circle cx="8" cy="8" r="5.8" /><path d="M6.2 6.1A1.9 1.9 0 0 1 8 4.8c1 0 1.9.7 1.9 1.7 0 1.2-1.9 1.4-1.9 2.6" /><circle cx="8" cy="11.4" r="0.2" /></>,
  pin: <path d="M9.5 1.8 14.2 6.5 12 7.2l-2 3.4.2 3-3.4-3.4-4.6 4.6 4.6-4.6L3.4 6.8l3-.2 3.4-2z" />,
  chevron: <path d="m6 3.5 4.5 4.5L6 12.5" />,
  menu: <path d="M2.5 4.2h11M2.5 8h11M2.5 11.8h11" />,
  close: <path d="m3.5 3.5 9 9m0-9-9 9" />,
  collapse: <path d="M9.5 3.5 5 8l4.5 4.5M13 3.5v9" transform="translate(-1 0)" />,
  expand: <path d="M6.5 3.5 11 8l-4.5 4.5M3 3.5v9" />,
  user: <><circle cx="8" cy="5.4" r="2.6" /><path d="M2.8 13.6c.7-2.5 2.8-3.8 5.2-3.8s4.5 1.3 5.2 3.8" /></>,
};

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {PATHS[name] ?? PATHS.home}
    </svg>
  );
}
