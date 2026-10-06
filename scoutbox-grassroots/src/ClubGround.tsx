import { useId } from 'react';

/** Decorative touchline scene. It does not represent the club's actual ground. */
export function ClubGround() {
  const id = useId().replace(/:/g, '');
  return <svg className="club-ground" viewBox="0 0 620 370" preserveAspectRatio="none" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={`${id}sky`} x2="0" y2="1"><stop stopColor="#0b211b"/><stop offset="1" stopColor="#355343"/></linearGradient>
      <linearGradient id={`${id}grass`} x1="0" y1="0" x2=".6" y2="1"><stop stopColor="#31593e"/><stop offset=".6" stopColor="#173d2b"/><stop offset="1" stopColor="#091e15"/></linearGradient>
      <linearGradient id={`${id}light`} x2="0" y2="1"><stop stopColor="#dcf4cd" stopOpacity=".19"/><stop offset="1" stopColor="#dcf4cd" stopOpacity="0"/></linearGradient>
      <radialGradient id={`${id}lamp`}><stop stopColor="#f1f9dd" stopOpacity=".7"/><stop offset=".15" stopColor="#b9e8b3" stopOpacity=".2"/><stop offset="1" stopColor="#b9e8b3" stopOpacity="0"/></radialGradient>
      <pattern id={`${id}net`} width="7" height="7" patternUnits="userSpaceOnUse"><path d="M0 0H7V7" fill="none" stroke="#c7d8bc" strokeWidth=".55" opacity=".45"/></pattern>
      <pattern id={`${id}fence`} width="12" height="16" patternUnits="userSpaceOnUse"><path d="m0 8 6-8 6 8-6 8Z" fill="none" stroke="#a6b8a0" strokeWidth=".5" opacity=".25"/></pattern>
      <clipPath id={`${id}field`}><path d="M0 211 620 177V370H0Z"/></clipPath>
    </defs>
    {/* An open horizon, low terracing and the lights of an evening session. */}
    <path d="M0 0H620V242H0Z" fill={`url(#${id}sky)`}/>
    <path d="M0 163Q15 137 32 151 42 124 63 141 82 106 104 137 124 123 138 144 157 128 174 143 194 121 212 148 231 131 247 151 271 135 288 151 306 125 326 146 348 128 365 150 388 117 410 146 434 133 452 151 476 129 492 150 515 130 537 148 555 126 574 143 599 128 620 142V232H0Z" fill="#10271d"/>
    <path d="M0 185Q32 163 68 177T135 180T207 176T280 184T357 176T431 181T506 173T578 179L620 170V226H0Z" fill="#183425"/>
    <path d="M68 213 64 36M69 213 66 36M483 185 485 62" stroke="#8b9d88" strokeWidth="2"/>
    <path d="M61 67H69M61 94H70M62 122H70M63 151H71M482 90H488M482 118H487M481 147H487" stroke="#4c6954"/>
    <path d="M53 38 168 237H0L73 38Z M475 65 594 205H384L495 65Z" fill={`url(#${id}light)`}/>
    <ellipse cx="65" cy="37" rx="53" ry="43" fill={`url(#${id}lamp)`}/><ellipse cx="485" cy="64" rx="43" ry="35" fill={`url(#${id}lamp)`}/>
    <g fill="#d5e8c1" stroke="#465a46" strokeWidth="2"><rect x="49" y="30" width="12" height="7" rx="1"/><rect x="63" y="30" width="12" height="7" rx="1"/><rect x="49" y="39" width="12" height="7" rx="1"/><rect x="63" y="39" width="12" height="7" rx="1"/><rect x="473" y="58" width="10" height="6" rx="1"/><rect x="485" y="58" width="10" height="6" rx="1"/><rect x="473" y="66" width="10" height="6" rx="1"/><rect x="485" y="66" width="10" height="6" rx="1"/></g>
    {/* A modest covered stand; deliberately no invented club insignia. */}
    <path d="m363 158 166-9 47 18-175 12Z" fill="#17211b" stroke="#65765f" strokeWidth="1"/>
    <path d="m377 159 159-7M391 165l159-9M401 173l160-10" stroke="#405643"/>
    <path d="M402 179V220M568 168V207M488 174V212" stroke="#809779" strokeWidth="3"/>
    <path d="m407 197 154-8v16l-154 10Z" fill="#0d2518"/>
    <path d="m410 196 146-8M410 203l146-8M410 210l146-8" stroke="#749077" strokeWidth="3"/>
    <path d="m497 193 10-1v15l-10 1Z" fill="#00e676" opacity=".9"/>
    <path d="M0 205 620 171V221L0 251Z" fill={`url(#${id}fence)`}/>
    <path d="M0 205 620 171M0 235 620 202" fill="none" stroke="#678069" strokeWidth="1"/>
    {[15,116,218,320,420,521,615].map((x,i)=><path key={x} d={`M${x} ${203-i*5.5}v39`} stroke="#748b70" strokeWidth="2"/>)}
    {/* The view from beside the pitch, with chalk, netting and worn turf. */}
    <path d="M0 236 620 197V370H0Z" fill="#403e2b"/>
    <path d="M0 244 620 200V370H0Z" fill={`url(#${id}grass)`}/>
    <g clipPath={`url(#${id}field)`} opacity=".16" fill="#8ca76c"><path d="m132 230 20-1-65 141H32Z"/><path d="m233 222 24-2-19 150h-48Z"/><path d="m349 215 22-2 33 157h-62Z"/><path d="m468 207 23-1 79 164h-54Z"/></g>
    <path d="m85 370 110-130 425-29M174 265l256-19 43 58-352 28M199 239l-5 33 124-9-2-32" fill="none" stroke="#c6d8b0" strokeWidth="1.5" opacity=".7"/>
    <path d="m186 290-14 17 126-10 1-17" fill="none" stroke="#c6d8b0" strokeWidth="1" opacity=".6"/>
    <path d="M369 301q-34 20-83 8" fill="none" stroke="#c6d8b0" opacity=".55"/>
    <ellipse cx="240" cy="269" rx="37" ry="6" fill="#877d4d" opacity=".17"/>
    <path d="m208 227-16 41 106-8-5-42Z" fill={`url(#${id}net)`}/>
    <path d="m207 227-7 34m92-42 9 36M193 268l7-7 101-6-3 5" fill="none" stroke="#8eae90" strokeWidth="1"/>
    <path d="m193 268 1-46 106-9-2 47" fill="none" stroke="#e2e5c7" strokeWidth="3"/>
    <path d="m194 222 13 5 85-8 8-6" fill="none" stroke="#aabea4"/>
    <path d="m67 359 62-71 16 2-55 80Z" fill="#495237" opacity=".35"/>
    <path d="m86 370 106-126" fill="none" stroke="#d1dbc0" strokeWidth="2.5"/>
    {/* Green corner flag and a ball at the near touchline. */}
    <path d="m508 341 3-61" stroke="#c9d6b8" strokeWidth="2"/>
    <path className="ground-corner-flag" d="m511 280 30 4-8 8-22-1Z" fill="#00e676"/>
    <ellipse cx="484" cy="350" rx="19" ry="5" fill="#051b10" opacity=".6"/>
    <circle cx="481" cy="340" r="11" fill="#cdd5b9"/>
    <path d="m478 332 7 1 2 7-6 4-6-5Z M471 336l4-7m10 2 5 4m-17 12 6 4m9-7-1 5" fill="#203c2c" stroke="#203c2c" strokeWidth="1.5"/>
    <g stroke="#72915e" strokeWidth="1" opacity=".45"><path d="m73 354-3-8m3 8 4-6m70 22-2-9m2 9 5-6m256-16-2-7m2 7 4-5m115 17-3-9m3 9 4-7m-191 16 1-6m-1 6-3-5"/></g>
  </svg>;
}
