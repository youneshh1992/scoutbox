import { useId } from 'react';

/** Decorative club-ground illustration, not a squad formation or a live map. */
export function ClubGround() {
  const id = useId().replace(/:/g, '');
  return <svg className="club-ground" viewBox="0 0 520 330" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={`${id}turf`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#174b2e" /><stop offset="1" stopColor="#092619" /></linearGradient>
      <linearGradient id={`${id}edge`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#00e676" stopOpacity=".65" /><stop offset="1" stopColor="#00e676" stopOpacity=".06" /></linearGradient>
      <radialGradient id={`${id}glow`}><stop stopColor="#00e676" stopOpacity=".28" /><stop offset="1" stopColor="#00e676" stopOpacity="0" /></radialGradient>
      <pattern id={`${id}mow`} width="60" height="100" patternUnits="userSpaceOnUse"><rect width="30" height="100" fill="#00e676" opacity=".035" /></pattern>
    </defs>
    <ellipse cx="267" cy="180" rx="252" ry="160" fill={`url(#${id}glow)`} />
    <g fill="none" stroke="#90ae87" strokeWidth=".6" opacity=".18">
      <path d="M36 194C-17 103 104 37 223 53S470 36 482 160 382 312 213 287 88 284 36 194Z" />
      <path d="M21 202C-39 95 91 20 224 34S493 20 502 159 391 334 210 305 79 300 21 202Z" />
      <path d="M59 183C9 107 116 58 224 70S449 57 458 159 376 286 215 269 103 261 59 183Z" />
    </g>
    <g transform="translate(112 48) rotate(13 157 113)">
      <rect x="-12" y="10" width="340" height="244" rx="16" fill="#04170e" opacity=".65" />
      <rect x="-10" y="-10" width="334" height="242" rx="14" fill={`url(#${id}turf)`} stroke={`url(#${id}edge)`} />
      <rect width="314" height="222" rx="5" fill={`url(#${id}mow)`} />
      <g stroke="#a6d8b5" strokeWidth="1.3" fill="none" opacity=".65">
        <rect x="8" y="8" width="298" height="206" rx="2" /><path d="M157 8V214 M8 62H57V160H8 M306 62H257V160H306 M8 88H27V134H8 M306 88H287V134H306" />
        <circle cx="157" cy="111" r="30" /><circle cx="157" cy="111" r="2" fill="#a6d8b5" />
        <path d="M57 91A25 25 0 0 1 57 131 M257 91A25 25 0 0 0 257 131 M0 96H8 M0 126H8 M306 96H314 M306 126H314" />
      </g>
      <g fill="#00e676"><circle cx="8" cy="8" r="3" /><circle cx="306" cy="214" r="3" /></g>
      <path d="M8 8H125 M306 214H217" stroke="#00e676" strokeWidth="2" />
    </g>
    <g fill="#aaba9b" opacity=".55"><path d="M40 260l5-13 5 13z M63 268l6-17 6 17z M439 58l6-17 6 17z M461 74l5-13 5 13z" /></g>
  </svg>;
}
