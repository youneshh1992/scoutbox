import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Session } from './api';
import { m12, type Segment, type Playlist } from './m12api';
import { ProGlyph } from './proExperience';

import { clipTime, validClipRange } from './proClipModel';
export function ProClipTools({session,mediaId,playerId,videoRef,duration,playhead,notify,onStep}: {
 session:Session;mediaId:string;playerId:string;videoRef:RefObject<HTMLVideoElement|null>;duration:number;playhead:number;notify:(s:string,error?:boolean)=>void;onStep:(n:number)=>void;
}) {
 const [markIn,setMarkIn]=useState<number|null>(null),[markOut,setMarkOut]=useState<number|null>(null),[loop,setLoop]=useState(false);
 const [note,setNote]=useState(''),[event,setEvent]=useState('Observation'),[saving,setSaving]=useState(false),[segments,setSegments]=useState<Segment[]>([]),[playlists,setPlaylists]=useState<Playlist[]>([]);
 const [loadError,setLoadError]=useState('');
 const currentId=useRef(mediaId); currentId.current=mediaId;
 useEffect(()=>{let live=true;setMarkIn(null);setMarkOut(null);setLoop(false);setNote('');setSegments([]);setPlaylists([]);setLoadError('');
  m12.listSegments(session,playerId).then(rows=>{if(live)setSegments(rows.filter(s=>s.mediaId===mediaId));}).catch(()=>{if(live)setLoadError('Saved segments could not be loaded.');});
  m12.listPlaylists(session).then(rows=>{if(live)setPlaylists(rows);}).catch(()=>{if(live)setLoadError('Playlists could not be loaded.');});
  return()=>{live=false};
 },[session,mediaId,playerId]);
 const valid=validClipRange(markIn,markOut,duration);
 const seek=(n:number)=>{const v=videoRef.current;if(v)v.currentTime=Math.max(0,Math.min(duration,n));};
 useEffect(()=>{const v=videoRef.current;if(!v||!loop||!valid)return;
  const repeat=()=>{if(v.currentTime>=markOut!||v.currentTime<markIn!)v.currentTime=markIn!;};
  const replay=()=>{v.currentTime=markIn!;void v.play().catch(()=>{});};
  v.addEventListener('timeupdate',repeat);v.addEventListener('ended',replay);return()=>{v.removeEventListener('timeupdate',repeat);v.removeEventListener('ended',replay)};
 },[videoRef,loop,valid,markIn,markOut,mediaId]);
 useEffect(()=>{const onKey=(e:KeyboardEvent)=>{if(e.metaKey||e.ctrlKey||e.altKey||e.target instanceof HTMLElement&&(e.target.closest('input,select,textarea,button,video,[role="dialog"]')||e.target.isContentEditable))return;const v=videoRef.current;if(!v||!duration)return;
  if([' ','j','k','l','i','o','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();if(e.key==='i')setMarkIn(v.currentTime);if(e.key==='o')setMarkOut(v.currentTime);if(e.key==='j')v.currentTime=Math.max(0,v.currentTime-5);if(e.key==='l')v.currentTime=Math.min(duration,v.currentTime+5);if(e.key===' '||e.key==='k'){if(v.paused)void v.play().catch(()=>{});else v.pause();}if(e.key==='ArrowDown')onStep(1);if(e.key==='ArrowUp')onStep(-1);}
 };window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);},[videoRef,duration,onStep]);
 const save=async()=>{if(!valid||saving)return;setSaving(true);const source=mediaId;try{const segment=await m12.createSegment(session,mediaId,{startS:Number(markIn!.toFixed(3)),endS:Number(markOut!.toFixed(3)),labels:[event.toLowerCase()],eventType:event.toLowerCase().replaceAll(' ','_'),...(note.trim()?{note:note.trim()}:{})});if(currentId.current===source){setSegments(prev=>[segment,...prev]);setNote('');}notify('Segment saved to Evidence & Video.');}catch(e){notify(e instanceof Error?e.message:'Could not save the segment.',true);}finally{setSaving(false);}};
 return <section className="pro-clip-tools" aria-label="Pro segment editor"><header><span><ProGlyph name="video" size={17}/> Segment editor</span><span className="pro-exclusive-label">Pro tools</span></header>
  <div className="pro-edit-timeline" aria-label="Marked range"><div className="pro-timeline-ruler">{[0,.25,.5,.75,1].map(n=><span key={n}>{clipTime(duration*n)}</span>)}</div><div className="pro-timeline-track"><div className="pro-timeline-source"/>{valid&&<span className="pro-timeline-selection" style={{left:`${markIn!/duration*100}%`,width:`${(markOut!-markIn!)/duration*100}%`}}/>}<i style={{left:`${duration?playhead/duration*100:0}%`}}/></div></div>
  <div className="pro-edit-controls"><button disabled={!duration} onClick={()=>{videoRef.current?.pause();seek(playhead-.04)}} aria-label="Step back 0.04 seconds">−.04s</button><button disabled={!duration} onClick={()=>{videoRef.current?.pause();seek(playhead+.04)}} aria-label="Step forward 0.04 seconds">+.04s</button><button disabled={!duration} onClick={()=>setMarkIn(videoRef.current?.currentTime??0)}><kbd>I</kbd> Mark in <b>{markIn===null?'—':clipTime(markIn)}</b></button><button disabled={!duration} onClick={()=>setMarkOut(videoRef.current?.currentTime??0)}><kbd>O</kbd> Mark out <b>{markOut===null?'—':clipTime(markOut)}</b></button><button disabled={!valid} aria-pressed={loop} onClick={()=>{setLoop(!loop);if(!loop)seek(markIn!)}}><ProGlyph name="refresh-cw" size={14}/> Loop</button><button disabled={markIn===null&&markOut===null} onClick={()=>{setMarkIn(null);setMarkOut(null);setLoop(false)}}>Clear</button></div>
  {markIn!==null&&markOut!==null&&!valid&&<p className="pro-editor-error" role="status">Choose a range after mark in, within this clip and no longer than 10 minutes.</p>}
  <div className="pro-segment-form"><label>Event<select value={event} onChange={e=>setEvent(e.target.value)}>{['Observation','Pressing','Finishing','Distribution','Defensive action','Positioning'].map(e=><option key={e}>{e}</option>)}</select></label><label>Club note<input value={note} maxLength={300} onChange={e=>setNote(e.target.value)} placeholder="What should the next scout notice?"/></label><button className="primary" disabled={!valid||saving} onClick={save}>{saving?'Saving…':'Save segment'}</button></div>
  <details className="pro-editor-shortcuts"><summary>Keyboard controls & privacy</summary><p>Space / K: play or pause · J / L: move 5 seconds · I / O: mark the selection · ↑ / ↓: previous or next clip. Precision steps are 0.04 seconds, not a source-frame guarantee.</p><p>Segments and notes are private club records. They are saved to Evidence & Video; footage is not duplicated.</p></details>
  <div className="pro-saved-segments">{loadError&&<p role="status">{loadError}</p>}<h4>Saved from this clip <span>{segments.length}</span></h4>{segments.length?segments.map(s=><div key={s.id}><button className="pro-segment-jump" onClick={()=>{setMarkIn(s.startS);setMarkOut(s.endS);seek(s.startS)}}><span>{clipTime(s.startS)} — {clipTime(s.endS)}</span><strong>{s.note||s.eventType?.replaceAll('_',' ')||'Scouting segment'}</strong></button>{playlists.length>0&&<select aria-label={`Add segment ${s.id} to playlist`} defaultValue="" onChange={async e=>{const id=e.target.value;e.target.value='';if(!id)return;try{await m12.addToPlaylist(session,id,s.id);notify('Segment added to playlist.');}catch(err){notify(err instanceof Error?err.message:'Could not add the segment.',true);}}}><option value="">Add to playlist…</option>{playlists.map(p=><option value={p.id} key={p.id}>{p.name}</option>)}</select>}</div>):<p>Mark a passage of play and save your first segment.</p>}</div>
 </section>;
}
