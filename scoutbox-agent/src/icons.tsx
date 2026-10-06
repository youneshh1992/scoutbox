import type { CSSProperties, ReactNode } from 'react';
import { Icon as PlatformIcon, hasIcon as hasPlatformIcon, ICON_NAMES as PLATFORM_NAMES } from '../../design-system/icons';
const shapes:Record<string,ReactNode>={
 home:<><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
 briefcase:<><rect x="3" y="7" width="18" height="14" rx="3"/><path d="M8 7V4h8v3M3 12c6 4 12 4 18 0m-9 0v4"/></>,
 target:<><path d="M4 7h14m-4-4 4 4-4 4M20 17H6m4-4-4 4 4 4"/></>,
 search:<><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
 bell:<><path d="M5 17c2-3 2-3 2-7a5 5 0 0 1 10 0c0 4 0 4 2 7H5Zm5 3h4M12 2v3"/></>,
 globe:<><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/></>,
 'pie-chart':<><path d="M10 3a9 9 0 1 0 11 11H10V3ZM14 3v7h7a9 9 0 0 0-7-7Z"/></>,
 'arrow-up-right':<path d="M6 18 18 6M6 6h12v12"/>,
 user:<><circle cx="9" cy="8" r="4"/><path d="M2 21v-3a7 7 0 0 1 14 0v3m0-18a4 4 0 0 1 0 8m3 4a6 6 0 0 1 3 6"/></>,
 building:<><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h1m4 0h1M9 11h1m4 0h1M9 15h1m4 0h1m-3 3v3"/></>,
 flag:<><path d="M5 22V3m0 1h7l3 3h6v9h-6l-3-3H5"/></>,
 inbox:<><path d="M3 5h18v15H3V5Zm0 9h5l2 3h4l2-3h5M8 9h8"/></>
};
export function Icon({name,size=20,label,style}:{name:string;size?:number;label?:string;style?:CSSProperties}){return shapes[name]?<svg className="a-icon" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" role={label?'img':undefined} aria-label={label} aria-hidden={label?undefined:true} style={style}>{shapes[name]}</svg>:<PlatformIcon name={name} size={size} label={label} style={style}/>}
export const hasIcon=(name:string)=>!!shapes[name]||hasPlatformIcon(name);
export const ICON_NAMES=[...new Set([...PLATFORM_NAMES,...Object.keys(shapes)])];
