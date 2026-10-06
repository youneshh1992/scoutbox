import { useId, useState, type CSSProperties } from 'react';
import { Icon } from '../../design-system/icons';
import type { Squad } from './api';

export interface ChartCount { label: string; value: number }
export function countBy<T>(rows: readonly T[], key: (row: T) => string | null | undefined): ChartCount[] {
  const counts = new Map<string, number>();
  for (const row of rows) { const label = (key(row) || 'Not recorded').replace(/_/g, ' '); counts.set(label, (counts.get(label) ?? 0) + 1); }
  return [...counts].map(([label, value]) => ({ label, value }));
}
const COLOURS = ['#00e676', '#83b99a', '#d0bb88', '#459b83', '#a7bb6c', '#7c9891'];
/** Counts only. A ring is offered only for mutually exclusive groups. */
export function CountChart({ title, note, items, unit = 'records', distribution = false, variant = 'bars' }: {
  title: string; note: string; items: ChartCount[] | null; unit?: string; distribution?: boolean; variant?: 'bars' | 'columns';
}) {
  const id = useId();
  const [ring, setRing] = useState(false);
  const rows = (items ?? []).map(x => ({ ...x, value: Number.isFinite(x.value) ? Math.max(0, x.value) : 0 }));
  const total = rows.reduce((sum, x) => sum + x.value, 0);
  const max = Math.max(1, ...rows.map(x => x.value));
  let offset = 0;
  return <section className={`scout-chart ${ring ? 'is-ring' : variant}`} aria-labelledby={id} aria-busy={items === null}>
    <div className="scout-chart-heading"><div><span className="scout-kicker">At a glance</span><h3 id={id}>{title}</h3></div>
      {distribution && <div className="scout-chart-switch" role="group" aria-label={`${title} chart view`}><button type="button" aria-pressed={!ring} onClick={() => setRing(false)} title="Bar chart"><Icon name="signal" size={16} /><span>Bars</span></button><button type="button" aria-pressed={ring} onClick={() => setRing(true)} title="Ring chart"><Icon name="target" size={16} /><span>Ring</span></button></div>}
    </div>
    {items === null ? <p className="scout-chart-empty">Loading records…</p> : total === 0 ? <div className="scout-chart-empty"><Icon name="signal" size={28} /><span>No {unit} recorded yet.</span></div> : <div className="scout-chart-body">
      {ring && <div className="scout-ring"><svg viewBox="0 0 160 160" aria-hidden="true"><circle cx="80" cy="80" r="62" className="scout-ring-track" />{rows.map((r,i) => { const length = r.value / total * 100; const start = offset; offset += length; return <circle key={r.label} cx="80" cy="80" r="62" pathLength="100" fill="none" stroke={COLOURS[i % COLOURS.length]} strokeWidth="12" strokeDasharray={`${length} ${100-length}`} strokeDashoffset={-start} transform="rotate(-90 80 80)" />; })}</svg><span><b>{total}</b><small>{unit}</small></span></div>}
      <div className="scout-chart-plot">
        {!ring && <div className="scout-chart-scale" aria-hidden="true"><span>{variant === 'columns' ? `${unit} · scale 0–${max}` : '0'}</span>{variant !== 'columns' && <span>{max} · {unit}</span>}</div>}
        <ul className="scout-chart-values">{rows.map((r,i) => <li key={r.label} title={`${r.label}: ${r.value} ${unit}`} style={{ '--chart-colour': COLOURS[i % COLOURS.length], '--chart-size': `${r.value / max * 100}%`, '--chart-delay': `${Math.min(i,8)*55}ms` } as CSSProperties}>
          <span className="scout-chart-label">{r.label}</span><span className="scout-chart-track" aria-hidden="true"><span /></span><b>{r.value}</b>
        </li>)}</ul>
      </div>
    </div>}
    <p className="scout-chart-note">{note}</p>
  </section>;
}

export function SquadCoverage({ squad }: { squad: Squad }) {
  return <div className="scout-squad-overview"><section className="scout-pitch-panel" aria-label="Squad position coverage"><div><span className="scout-kicker">Squad balance</span><h3>Your squad, by position</h3><p>Roster counts by group · not a starting XI</p></div>
    <div className="scout-coverage-pitch"><svg viewBox="0 0 500 250" aria-hidden="true"><rect x="12" y="12" width="476" height="226" rx="3" /><path d="M250 12v226M12 65h65v120H12M488 65h-65v120h65M12 95h24v60H12M488 95h-24v60h24"/><circle cx="250" cy="125" r="38"/><circle cx="250" cy="125" r="2"/></svg>
      <div className="scout-pitch-zones">{['GK','DEF','MID','ATT'].map(k => <div key={k} className={squad.gaps.includes(k) ? 'thin' : ''}><span>{k}</span><b>{squad.coverage[k] ?? 0}</b><small>{squad.gaps.includes(k) ? 'Thin cover' : 'Covered'}</small></div>)}</div>
    </div></section><CountChart title="Position coverage" note="A group with fewer than two rostered players is flagged by the squad service." unit="players" items={Object.entries(squad.coverage).map(([label,value])=>({label,value}))} /></div>;
}

const HEADINGS: Record<string, [string,string,string]> = {
  squad: ['The team','Build your squad. Plan the next match day.','users'], coaches: ['Coaching team','The people behind your players.','user-round'], friendlies: ['The local game','Find your next opposition, close to home.','users'], fixtures: ['Match intelligence','Follow the fixtures. See who played.','calendar-days'],
  search: ['Player discovery','Find the right conversation to start.','search'], shortlist: ['Your watch','Keep the players you want to follow in view.','pin'], filmroom: ['Footage review','Watch closely. Record what you see.','video'], insight: ['Scouting intelligence','A clearer view of your club’s discovery activity.','signal'],
  recruitment: ['Recruitment pipeline','Move each case forward with a clear next step.','target'], rooms: ['Recruitment workspace','Evidence, discussion and decisions in one place.','folders'], requests: ['Player contact','Track your requests and their responses.','mail'], opportunities: ['Opportunity board','Give local players a route into your club.','clipboard'], campaigns: ['Recruitment outreach','Organise your next search for players.','flag'], opendays: ['At your ground','Open the gates to your next group of players.','calendar-days'],
  assessments: ['Player evaluation','Observations backed by evidence.','clipboard'], video: ['Evidence library','Keep the footage behind every observation.','video'], trials: ['Trial programme','From invitation to a recorded report.','clipboard'], trialdays: ['At the touchline','Run the day. Keep the details together.','calendar-days'], briefs: ['Recruitment planning','Define what your club is looking for.','file-text'], matching: ['Discovery tools','Match recorded facts to your requirements.','sliders-horizontal'], watchlists: ['Ongoing discovery','Keep track as relevant records change.','eye'], secondlook: ['Revisit the evidence','See what changed since your last decision.','history'], nobodymissed: ['Discovery coverage','See where your club’s attention has landed.','compass'],
  outcomes: ['Beyond the signing','Follow the next chapter of each placement.','flag'], dashboard: ['The wider picture','Your club’s recruitment activity, in focus.','signal'], funnel: ['Recruitment flow','See how records move through the process.','signal'], ledger: ['Your audit trail','Every discovery action, attributed and recorded.','files'], coverage: ['Scouting coverage','Put your people where the football is.','map-pin'], calibration: ['Shared standards','Compare observations. Improve consistency.','sliders-horizontal'],
  network: ['Club connections','Work together, with control over what you share.','building-2'], organisation: ['Your workspace','People, access and the everyday running of your club.','shield-check'], verification: ['Trust & standing','Make your club and role clear to others.','badge-check'], imports: ['Connected operations','Bring your club’s records together.','upload'], plan: ['Club administration','Your plan, records and responsibilities.','file-text'], messages: ['Club conversations','Keep the conversation moving.','messages-square'],
};
export function ScoutPageHeading({ screen, title }: { screen: string; title: string }) {
  const [eyebrow, description, icon] = HEADINGS[screen] ?? ['Club workspace','Your next action starts here.','compass'];
  return <div className="f-heading scout-page-heading"><div><span className="scout-kicker">{eyebrow}</span><p className="f-display" aria-hidden="true">{title}</p><p className="scout-page-description">{description}</p></div><div className="scout-page-emblem" aria-hidden="true"><Icon name={icon} size={34} /></div></div>;
}
