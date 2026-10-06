import { useEffect, useState, type CSSProperties } from 'react';
import { ProGlyph as Icon, PRO_PAGE_META } from './proExperience';
import { exportCsv } from './proExport';
import { api, type Session, type Funnel, type Player, type OrgRequest, type Trial } from './api';
import type { ScreenId } from './App';

const pageNotes: Partial<Record<ScreenId, [string, string]>> = {
  search: ['Talent discovery', 'Build a clearer picture of your next signing.'],
  filmroom: ['The screening room', 'Watch the evidence. Capture the detail.'],
  insight: ['Scouting intelligence', 'Understand the reach and depth of your scouting.'],
  shortlist: ['Your player portfolio', 'Keep the players that matter within reach.'],
  rooms: ['Recruitment operations', 'Every conversation, observation and decision in one place.'],
  dashboard: ['Director’s office', 'A precise view of your recruitment process.'],
  planner: ['Squad strategy', 'Plan the shape of your next squad.'],
  plan: ['Your membership', 'The tools and terms behind your club’s workspace.'],
  matching: ['Recruitment intelligence', 'Turn your requirements into a focused player search.'],
  briefs: ['Recruitment intelligence', 'Define the player your team needs.'],
  watchlists: ['Recruitment intelligence', 'Follow the criteria that matter to your club.'],
  nobodymissed: ['Discovery coverage', 'Find the gaps in your evaluation coverage.'],
  secondlook: ['Evidence review', 'Return to decisions when the evidence changes.'],
  imports: ['Connected operations', 'Bring your club’s records into one workspace.'],
  budgets: ['Club operations', 'Keep recruitment commitments and budgets in view.'],
  verification: ['Trust & standing', 'Manage the credentials behind your club.'],
  messages: ['Club correspondence', 'Keep the next conversation moving.'],
  funnel: ['Recruitment intelligence', 'Follow recorded activity through the recruitment process.'],
};
export function ProMasthead({ screen, title, section }: { screen: ScreenId; title: string; section: string | null }) {
  const [eyebrow, note] = pageNotes[screen] ?? [section ?? 'Club workspace', ''];
  return <header className="pro-masthead"><div><span className="pro-eyebrow">{eyebrow}</span><p className="pro-page-title" aria-hidden="true">{title}</p>{note && <p className="pro-page-note">{note}</p>}</div><span className="pro-page-signature" aria-hidden="true"><Icon name={PRO_PAGE_META[screen]?.icon??"home"} size={32}/><span>SCOUTBOX<strong>PRO WORKSPACE</strong></span></span></header>;
}

export function ProChart({ title, note, items, additive = true }: { title: string; note?: string; additive?: boolean; items: { label: string; value: number }[] }) {
  const [mode, setMode] = useState<'bars' | 'ring' | 'table'>('bars');
  const max = Math.max(1, ...items.map(x => x.value));
  const total = items.reduce((n, x) => n + x.value, 0);
  let start = 0;
  const colors = ['#00e676', '#70dbc2', '#53aebc', '#b4d6db', '#709fbb', '#7b8d98'];
  const segments = items.map((x, i) => { const from = start; start += total ? x.value / total * 100 : 0; return `${colors[i % colors.length]} ${from}% ${start}%`; });
  return <section className="pro-chart" aria-label={title}>
    <header><div><span className="pro-eyebrow">Analysis / Pro</span><h3>{title}</h3></div><div className="pro-chart-modes" role="group" aria-label={`${title} chart style`}>{(additive ? ['bars','ring','table'] as const : ['bars','table'] as const).map(m=><button key={m} aria-pressed={mode===m} onClick={()=>setMode(m)} aria-label={m==='bars'?'Bar chart':m==='ring'?'Ring chart':'Data table'}><Icon name={m==='bars'?'signal':m==='ring'?'target':'clipboard'} size={15}/></button>)}<button disabled={!items.length} aria-label={`Export ${title} CSV`} title="Export visible chart data" onClick={()=>exportCsv(`scoutbox-pro-${title.toLowerCase().replace(/[^a-z0-9]+/g,'-')}.csv`,['Category','Count','Context'],items.map(x=>[x.label,x.value,note??'']))}><Icon name="download" size={15}/></button></div></header>
    <div className="pro-chart-summary"><strong>{(additive ? total : items[0]?.value ?? 0).toLocaleString()}</strong><span>{additive ? 'Total across displayed categories' : items[0]?.label ?? 'No activity'}<small>{items.length} categories · recorded data</small></span></div>
    {!items.length ? <p className="pro-chart-empty">No records to plot yet. This view will populate as activity is recorded.</p> : mode==='table' ? <table className="pro-chart-table"><thead><tr><th>Category</th><th>Count</th></tr></thead><tbody>{items.map((x,i)=><tr key={i}><td>{x.label}</td><td>{x.value.toLocaleString()}</td></tr>)}</tbody></table> : mode==='bars' ? <div className="pro-column-chart"><div className="pro-chart-axis" aria-hidden="true"><span>{max}</span><span>{Number((max/2).toFixed(1))}</span><span>0</span></div><dl className="pro-columns" style={{'--chart-columns':items.length} as CSSProperties}>{items.map((x,i)=><div key={i} title={`${x.label}: ${x.value}`} style={{'--chart-color':colors[i%colors.length]} as CSSProperties}><dt>{x.label}</dt><dd><strong>{x.value}</strong><span style={{height:`${x.value/max*100}%`}}/></dd></div>)}</dl></div> : <div className="pro-chart-body ring"><div className="pro-donut" aria-hidden="true" style={{background:total?`conic-gradient(${segments.join(',')})`:'#2d3541'}}><div><strong>{total}</strong><span>Total</span></div></div><dl className="pro-chart-series">{items.map((x,i)=><div className="pro-chart-datum" key={i} style={{'--chart-color':colors[i%colors.length]} as CSSProperties}><dt><span/>{x.label}</dt><dd>{x.value.toLocaleString()}</dd></div>)}</dl></div>}
    {note && <p className="pro-data-note">{note}</p>}
  </section>;
}

interface OverviewData { shortlist: Player[] | null; requests: OrgRequest[] | null; trials: Trial[] | null; funnel: Funnel | null }
export function ProOverview({ session, tick, navigate }: { session: Session; tick: number; navigate: (id: ScreenId) => void }) {
  const [data, setData] = useState<OverviewData | null>(null);
  useEffect(() => { let gone = false; const safe = <T,>(p: Promise<T>) => p.catch(() => null); Promise.all([safe(api.getShortlist(session)), safe(api.getRequests(session)), safe(api.getTrials(session)), safe(api.getFunnel(session))]).then(([shortlist, requests, trials, funnel]) => { if (!gone) setData({shortlist, requests, trials, funnel}); }); return () => { gone = true; }; }, [session, tick]);
  const metrics: { label: string; value: number | null; icon: string; target: ScreenId; sub: string }[] = [
    {label:'Player portfolio',value:data?.shortlist?.length ?? null,icon:'users',target:'shortlist',sub:'Shortlisted players'},
    {label:'Open conversations',value:data?.requests?.filter(x=>x.status==='pending').length ?? null,icon:'messages-square',target:'requests',sub:'Pending requests'},
    {label:'Trial reports',value:data?.trials?.filter(x=>x.status==='awaiting_report').length ?? null,icon:'clipboard-list',target:'trials',sub:'Awaiting a report'},
    {label:'Trial programme',value:data?.trials?.length ?? null,icon:'calendar-days',target:'trials',sub:'Recorded trials'},
  ];
  const positions = data?.shortlist?.reduce<Record<string, number>>((acc, p) => { acc[p.position] = (acc[p.position] ?? 0) + 1; return acc; }, {});
  return <>
    <section className="pro-home-hero">
      <div className="pro-home-intro"><span className="pro-eyebrow">ScoutBox Pro / {session.org.name}</span><h2>The next chapter.<br/><span>Starts with a decision.</span></h2><p>Welcome back, {session.scoutName.split(' ')[0]}. Your club’s recruitment, from first observation to final decision.</p><div className="pro-home-actions"><button className="primary" onClick={()=>navigate('search')}>Discover players <Icon name="arrow-right" size={17}/></button><button onClick={()=>navigate('dashboard')}>Director’s dashboard <Icon name="arrow-up-right" size={15}/></button></div></div>
      <div className="pro-home-index"><div className="pro-index-heading"><span className="pro-eyebrow">Your workspace</span><span className="pro-membership">{session.org.plan}</span></div><button onClick={()=>navigate('filmroom')}><span className="pro-index-number"><Icon name="video" size={26}/></span><span><strong>Film room</strong><small>Review the detail that matters.</small></span><Icon name="video" size={20}/></button><button onClick={()=>navigate('briefs')}><span className="pro-index-number"><Icon name="clipboard" size={26}/></span><span><strong>Recruitment briefs</strong><small>Set the direction for your search.</small></span><Icon name="arrow-up-right" size={18}/></button><button onClick={()=>navigate('planner')}><span className="pro-index-number"><Icon name="target" size={26}/></span><span><strong>Squad planning</strong><small>Build your club’s next chapter.</small></span><Icon name="arrow-up-right" size={18}/></button></div>
    </section>
    <div className="pro-metric-grid">{metrics.map(m=><button key={m.label} className="pro-metric" onClick={()=>navigate(m.target)}><span className="pro-metric-top"><Icon name={m.icon} size={18}/><span>{m.label}</span><Icon name="arrow-up-right" size={14}/></span><strong>{m.value ?? '—'}</strong><small>{data && m.value === null ? 'Records unavailable' : !data ? 'Loading records…' : m.sub}</small></button>)}</div>
    <div className="pro-overview-charts">
      {data?.funnel ? <ProChart additive={false} title="Recruitment activity" items={data.funnel.stages.map(s=>({label:s.label,value:s.count}))} note="Recorded events at each stage. Counts may include the same player across stages."/> : <div className="pro-chart"><h3>Recruitment activity</h3><p className="pro-data-note">{data ? 'Activity records are unavailable for this account.' : 'Loading activity…'}</p></div>}
      {positions ? <ProChart title="Portfolio by position" items={Object.entries(positions).map(([label,value])=>({label,value}))} note="Positions represented in your shortlist. Counts describe your portfolio, not player quality."/> : <div className="pro-chart"><h3>Portfolio by position</h3><p className="pro-data-note">{data ? 'Shortlist records are unavailable.' : 'Loading your portfolio…'}</p></div>}
    </div>
  </>;
}
