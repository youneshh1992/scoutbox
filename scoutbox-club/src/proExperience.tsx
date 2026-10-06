import { useState, type CSSProperties, type ReactNode } from 'react';
import { Icon as BaseIcon } from '../../design-system/icons';
import type { TacticalRole } from './m12api';
import type { ScreenId } from './App';

/** One lockup for Pro entry, desktop navigation and the mobile drawer. */
export function ProBrand() {
  return <span className="pro-brand-lockup"><span className="pro-wordmark-group"><span className="wordmark">ScoutBox</span><sup className="tm" aria-label="trademark">TM</sup></span><span className="brand-sub">PRO</span></span>;
}

/** Pro's compact, two-tone glyphs. Existing icon names retain a shared fallback. */
export function ProGlyph({ name, size = 20, label, style }: {name: string; size?: number; label?: string; style?: CSSProperties}) {
  const paths: Record<string, ReactNode> = {
    home: <><path className="glyph-fill" d="M3 10 12 3l9 7v11H3Z"/><path d="m3 10 9-7 9 7M5 9v11h14V9M10 20v-6h4v6"/></>,
    target: <><circle className="glyph-fill" cx="11" cy="13" r="8"/><circle cx="11" cy="13" r="8"/><circle cx="11" cy="13" r="4"/><path d="m11 13 9-9m-5 0h5v5"/></>,
    clipboard: <><rect className="glyph-fill" x="4" y="5" width="16" height="16" rx="2"/><path d="M8 5H5v16h14V5h-3M8 3h8v4H8Zm0 9h8m-8 4h5"/></>,
    globe: <><circle className="glyph-fill" cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c-5 5-5 13 0 18 5-5 5-13 0-18Z"/></>,
    building: <><path className="glyph-fill" d="M4 7 13 3v18H4Zm9 4h7v10h-7Z"/><path d="M4 21V7l9-4v18m0-10h7v10M2 21h20M7 9v1m3-2v1m-3 4v1m3-2v1m6 1v1m0 3v1M7 17v1m3-2v1"/></>,
    'messages-square': <><path className="glyph-fill" d="M3 4h15v12H8l-5 4Z"/><path d="M3 4h15v12H8l-5 4ZM8 8h6M8 12h3m10-4v13l-5-3"/></>,
    send: <><path className="glyph-fill" d="m3 3 19 9-19 9 4-9Z"/><path d="m3 3 19 9-19 9 4-9Zm4 9h15"/></>,
    'credit-card': <><rect className="glyph-fill" x="2" y="5" width="20" height="14" rx="2"/><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/></>,
    download: <><path className="glyph-fill" d="M3 15h18v6H3Z"/><path d="M12 3v12m-5-5 5 5 5-5M3 16v5h18v-5"/></>,
    search: <><circle className="glyph-fill" cx="10.5" cy="10.5" r="6.5"/><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
    bell: <><path d="M5 17c2-2 2-3 2-7a5 5 0 0 1 10 0c0 4 0 5 2 7H5Z" fill="currentColor" fillOpacity=".2"/><path d="M5 17c2-2 2-3 2-7a5 5 0 0 1 10 0c0 4 0 5 2 7H5Zm5 3a2 2 0 0 0 4 0M12 2v3"/></>,
    'shield-alert': <><path d="m12 2 8 3v7c0 5-8 10-8 10S4 17 4 12V5Z" fill="currentColor" fillOpacity=".1"/><path d="m12 2 8 3v7c0 5-8 10-8 10S4 17 4 12V5Zm0 5v6m0 3v.1"/></>,
    flag: <><path className="glyph-fill" d="M5 4h6l3 3h6v10h-6l-3-3H5Z"/><path d="M5 22V3m0 1h6l3 3h6v10h-6l-3-3H5"/></>,
    video: <><rect className="glyph-fill" x="3" y="5" width="18" height="14" rx="2"/><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3Zm-7 0h3m12 0h3M3 15h3m12 0h3"/></>,
    signal: <><path className="glyph-fill" d="M3 15h4v6H3Zm7-6h4v12h-4Zm7-6h4v18h-4Z"/><path d="M5 18v3m7-9v9m7-15v15M2 22h20"/></>,
    'settings-2': <><path className="glyph-fill" d="M3 6h18v12H3Z"/><path d="M3 6h18M3 12h18M3 18h18M8 3v6m8 0v6m-6 0v6"/></>,
  };
  const content = paths[name];
  if (!content) return <BaseIcon name={name} size={size} label={label} style={name==='badge-check'?{...style,color:'#00e676'}:style}/>;
  return <svg className="pro-glyph" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label} style={style}>{content}</svg>;
}

export const PRO_PAGE_META: Partial<Record<ScreenId, {icon: string; note: string}>> = {
 fixtures:{icon:'calendar-days',note:'Scheduled matches & venues'},search:{icon:'search',note:'Browse the player market'},shortlist:{icon:'users',note:'Your retained prospects'},filmroom:{icon:'video',note:'Footage & observations'},insight:{icon:'signal',note:'Reach, exposure & evidence'},
 recruitment:{icon:'folder-open',note:'Manage active cases'},rooms:{icon:'messages-square',note:'Player decision rooms'},requests:{icon:'send',note:'Track your approaches'},opportunities:{icon:'flag',note:'Open recruitment needs'},
 campaigns:{icon:'target',note:'Coordinate your search'},briefs:{icon:'clipboard',note:'Define the next signing'},assessments:{icon:'clipboard',note:'Reports from your scouts'},video:{icon:'video',note:'Segments & playlists'},trials:{icon:'calendar-days',note:'Invitations & reports'},trialdays:{icon:'calendar-days',note:'Build the next trial day'},
 matching:{icon:'settings-2',note:'Search by recorded facts'},watchlists:{icon:'eye',note:'Follow saved criteria'},secondlook:{icon:'refresh-cw',note:'Review new evidence'},nobodymissed:{icon:'scan-line',note:'See gaps in your coverage'},outcomes:{icon:'badge-check',note:'Signings & follow-through'},dashboard:{icon:'signal',note:'Your decision dashboard'},funnel:{icon:'signal',note:'Activity through the stages'},ledger:{icon:'files',note:'Trace every discovery'},
 planner:{icon:'target',note:'Roles & squad depth'},coverage:{icon:'map-pin',note:'Assignments & visits'},calibration:{icon:'users',note:'Align scout observations'},network:{icon:'globe',note:'Club relationships & access'},representation:{icon:'users',note:'Representation records'},organisation:{icon:'building',note:'People, access & security'},verification:{icon:'badge-check',note:'Club credentials'},reputation:{icon:'shield-check',note:'Evidence of good standing'},imports:{icon:'network',note:'Data & connected services'},budgets:{icon:'credit-card',note:'Scenarios & commitments'},plan:{icon:'building',note:'Your Pro membership'},messages:{icon:'messages-square',note:'Club correspondence'},
};

export function ClubCrest({ initials }: {initials: string}) {
 return <span className="pro-club-crest" aria-hidden="true"><svg viewBox="0 0 48 56" fill="none"><path d="M3 4h42v27c0 12-21 21-21 21S3 43 3 31Z" fill="currentColor" fillOpacity=".07" stroke="currentColor"/><path d="M8 9h32v21c0 8-16 16-16 16S8 38 8 30Z" stroke="currentColor" opacity=".25"/><path d="M19 5v4m10-4v4M19 44h10" stroke="currentColor"/></svg><b>{initials}</b></span>;
}

/** A relationship diagram, not a geographic map. Every node is a recorded member. */
export function ProNetworkMap({club, members}: {club:string; members:{id:string; name:string}[]}) {
 const [selected,setSelected]=useState<string|null>(null);
 const visible=members.slice(0,8);
 return <section className="pro-network-map" aria-label="Club relationship diagram"><header><span className="pro-eyebrow">Your club network</span><span>{members.length} {members.length===1?'connection':'connections'}</span></header><div className="pro-constellation"><svg viewBox="0 0 600 280" preserveAspectRatio="none" aria-hidden="true"><ellipse cx="300" cy="140" rx="212" ry="102"/><ellipse cx="300" cy="140" rx="110" ry="52"/>{visible.map((m,i)=>{const a=(i/visible.length)*Math.PI*2+(visible.length===1?0:-Math.PI/2);return <path key={m.id} className={selected===m.id?'selected':''} d={`M300 140 Q300 ${140+Math.sin(a)*40} ${300+Math.cos(a)*215} ${140+Math.sin(a)*93}`}/>})}</svg><span className="pro-network-centre"><ClubCrest initials={club.split(' ').map(x=>x[0]).slice(0,2).join('')}/><strong>{club}</strong><small>Your club</small></span>{visible.map((m,i)=>{const a=(i/visible.length)*Math.PI*2+(visible.length===1?0:-Math.PI/2);return <button key={m.id} aria-pressed={selected===m.id} onClick={()=>setSelected(selected===m.id?null:m.id)} style={{left:`${50+Math.cos(a)*36}%`,top:`${50+Math.sin(a)*33}%`}}><span>{m.name.split(' ').map(x=>x[0]).slice(0,2).join('')}</span><small>{m.name}</small></button>})}</div><footer>{selected ? members.find(m=>m.id===selected)?.name : 'Select a club to identify a connection.'}{members.length>8&&<span>Showing 8 of {members.length} members; all members are listed below.</span>}</footer></section>;
}

export function ProSquadBoard({formation,roles}: {formation:string|null;roles:TacticalRole[]}) {
 const [id,setId]=useState<string|null>(null);
 const selected=roles.find(r=>r.id===id)??roles[0];
 const bands=['ATT','MID','DEF','GK'];
 const unplaced=roles.filter(r=>!bands.includes(r.positionGroup));
 return <section className="pro-tactics"><div className="pro-tactics-field"><header><span className="pro-eyebrow">Tactical roles</span><strong>{formation??'Formation not set'}</strong></header><div className="pro-role-pitch"><svg viewBox="0 0 400 430" preserveAspectRatio="none" aria-hidden="true"><rect x="1" y="1" width="398" height="428"/><path d="M1 215h398M115 1v65h170V1M158 1v25h84V1M115 429v-65h170v65M158 429v-25h84v25"/><circle cx="200" cy="215" r="45"/><circle cx="200" cy="215" r="2"/></svg>{bands.map(band=><div className="pro-role-band" key={band}><span>{band}</span>{roles.filter(r=>r.positionGroup===band).map(r=><button key={r.id} aria-pressed={r.id===selected?.id} onClick={()=>setId(r.id)}><ProGlyph name="user" size={18}/><strong>{r.name}</strong></button>)}</div>)}</div><p>Recorded role groups. This is not a starting XI.</p></div><div className="pro-role-inspector"><span className="pro-eyebrow">Role brief</span>{selected?<><h3>{selected.name}</h3><span className="pro-role-position">{selected.positionGroup}</span><p>{selected.description}</p><h4>Required</h4><dl>{selected.required.map((c,i)=><div key={i}><dt>{c.key.replace(/([A-Z])/g,' $1').replace(/^./,x=>x.toUpperCase())}</dt><dd>{c.key==='foot' ? (({L:'Left',R:'Right',B:'Both'} as Record<string,string>)[String(c.value)] ?? String(c.value)) : String(c.value).replaceAll('_',' ')}</dd></div>)}</dl><h4>Preferred</h4><dl>{selected.preferred.map((c,i)=><div key={i}><dt>{c.key.replace(/([A-Z])/g,' $1').replace(/^./,x=>x.toUpperCase())}</dt><dd>{c.key==='foot' ? (({L:'Left',R:'Right',B:'Both'} as Record<string,string>)[String(c.value)] ?? String(c.value)) : String(c.value).replaceAll('_',' ')}</dd></div>)}</dl></>:<p>No tactical roles recorded yet.</p>}{unplaced.length>0&&<div>{unplaced.map(r=><button key={r.id} onClick={()=>setId(r.id)}>{r.name}</button>)}</div>}</div></section>;
}
