import { AgentTabs, AgentPanel, DeskIntro } from './AgentExperience';
import { Icon } from './icons';
import { AgentDashboard } from './AgentVisuals';
import type { ScreenId } from './App';
import { Hint } from '../../design-system/About';
import { fmtClock } from '../../design-system/time';
// ScoutBox Agent — the screens. Every screen reads one server projection and
// renders what it says; nothing here derives access, status or a
// verification state on its own. A refusal is shown as the shared HTTP
// reading (httpState), a conflict as the shared conflict notice.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type Notification, type Session } from './api';
import { useDialog } from './dialog';
import {
  agent, clientKey, isSummary, JURISDICTIONS, SCOPES, TIERS,
  type AgencyOverview, type AuditRow, type ClientDetail, type ClientRow, type ComplianceRow, type FacetView, type Home, type Me,
  type Member, type Opportunity, type PlayerHit, type Profile, type Relationship, type RelationshipSummary, type Scope, type Tier,
} from './agentApi';
import { httpState } from './httpState';
import { conflictOf, ConflictNotice } from './conflict';
import { confirmDestructive, DESTRUCTIVE_ACTIONS } from './confirmAction';
import { registerDirtyGuard } from './dirtyGuard';

// One dirty flag for the workspace's forms: set by any input, cleared by a
// successful save or by a confirmed navigation (App calls markClean).
let dirtyFlag = false;
registerDirtyGuard(() => dirtyFlag);
export const markDirty = () => { dirtyFlag = true; };
export const markClean = () => { dirtyFlag = false; };
import type { ClientOffer, ClientSigning } from './agentApi';
import { fmtDate, fmtStamp, t } from './i18n';
import { AGENCY_TABS, hashForTransaction, hashForContext, type AgencyTab, type ClientTab } from './nav';
// M24B — the client case as category → subcategory.
import { CaseNav, CaseCrumb, casePanelProps } from '../../design-system/CaseNavigation';
import { defaultLocation, locate } from '../../design-system/caseNav';
import { CLIENT_NAV } from './caseNav';

type TKey = Parameters<typeof t>[0];
const tr = (k: string) => t(k as TKey);

// ------------------------------------------------------------ shared bits
export interface ScreenProps { session: Session; tick: number; notify: (text: string, error?: boolean) => void }

export function Toast({ text, error }: { text: string; error?: boolean }) {
  return <div className={`toast ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'} aria-live={error ? 'assertive' : 'polite'}>{text}</div>;
}

/** One reading of an async load: loading, error (shared HTTP wording) or data. */
function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: unknown; reload: () => void; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    fn().then((v) => { if (live) { setData(v); setError(null); } }).catch((e) => { if (live) setError(e); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, loading, reload: useCallback(() => setN((x) => x + 1), []) };
}

function ErrorLine({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  const s = httpState(error);
  return (
    <div className="notice block" role="alert" data-http-kind={s.kind}>
      {s.message}
      {s.retryable && onRetry && <> <button onClick={onRetry} style={{ marginLeft: 8 }}>{t('common.retry')}</button></>}
    </div>
  );
}

const Loading = () => <div className="notice" role="status" aria-live="polite">{t('common.loading')}</div>;

export function StatePill({ state }: { state: string }) {
  const cls = state === 'VERIFIED' ? 'green' : state === 'STALE' || state === 'MANUAL_REVIEW_REQUIRED' || state === 'PENDING' ? 'gold' : state === 'INACTIVE' ? 'red' : '';
  return <span className={`pill ${cls}`} data-state={state}>{tr(`state.${state}`)}</span>;
}
export function StatusPill({ status }: { status: string }) {
  const cls = status === 'active' ? 'green' : status === 'proposed' ? 'blue' : status === 'disputed' ? 'red' : status === 'expired' ? 'gold' : '';
  return <span className={`pill ${cls}`} data-status={status}>{tr(`status.${status}`)}</span>;
}
const scopeLabel = (s: string[]) => s.map((x) => tr(`scope.${x}`)).join(', ');

function Tabs<T extends string>({ tabs, active, onChange, label, labelFor }: { tabs: readonly T[]; active: T; onChange: (t: T) => void; label: string; labelFor: (t: T) => string }) {
  return (
    <div role="tablist" aria-label={label} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
      {tabs.map((tab) => (
        <button key={tab} role="tab" aria-selected={active === tab} aria-controls={`panel-${tab}`} id={`tab-${tab}`} className={active === tab ? 'primary' : ''} onClick={() => onChange(tab)}>{labelFor(tab)}</button>
      ))}
    </div>
  );
}
const Panel = ({ id, label, children }: { id: string; label: string; children: ReactNode }) => (
  <div {...casePanelProps('client', id, label)}>{children}</div>
);

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="section a-section"><h4>{title}</h4>{children}</section>
);

const Stat = ({ v, k, testId }: { v: ReactNode; k: string; testId?: string }) => (
  <div className="stat" data-testid={testId}><div className="v">{v}</div><div className="k">{k}</div></div>
);

// ============================================================ Home
export function HomeScreen({ session, tick, onNavigate }: ScreenProps & { onNavigate: (id: ScreenId) => void }) {
  const home = useLoad(() => agent.home(session), [session, tick]);
  const h = home.data as Home | null;
  return (
    <div data-testid="agent-home">
      {/* M24F.5 — one way in to every explanation on Home: what the workspace is, and the regulatory notice. */}
      <Hint>{[t('home.whatThisIsBody'), h?.regulatoryNotice ?? ''].filter(Boolean).join(' ')}</Hint>
      <ErrorLine error={home.error} onRetry={home.reload} />
      {home.loading && !h && <Loading />}
      {h && (
        <>
          <AgentDashboard session={session} tick={tick} home={h} onNavigate={onNavigate}/>
          <div className="a-standing-summary"><span>Professional standing</span><span data-testid="home-state"><StatePill state={h.profileState}/></span><button onClick={()=>onNavigate('profile')}>Manage credentials</button></div>
          {!h.hasProfile && <div className="notice warn" style={{ marginBottom: 12 }}>{t('home.noProfile')} <button onClick={() => onNavigate('profile')} style={{ marginLeft: 8 }}>{t('common.open')}</button></div>}
          <Section title={t('home.tiers')}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{h.tiers.map((x) => <span key={x} className="pill blue">{tr(`tier.${x}`)}</span>)}</div>
          </Section>
        </>
      )}
    </div>
  );
}

// ============================================================ Profile & verification
function FacetCard({ title, facet, ma, testProvider, onSubmit, note }: { title: string; facet: FacetView | null; ma?: string; testProvider: boolean; onSubmit: (reference: string, ma?: string) => Promise<void>; note?: string }) {
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [editing, setEditing] = useState(false);
  const state = facet?.state ?? 'UNVERIFIED';
  const submit = async () => {
    setBusy(true); setErr(null);
    try { await onSubmit(ref.trim(), ma); setRef(''); setEditing(false); markClean(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <div className="list-row a-credential-card" data-state={state} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }} data-testid={`facet-${title.toLowerCase().replace(/[^a-z]+/g, '-')}${ma ? `-${ma.toLowerCase()}` : ''}`}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className={`a-credential-symbol ${state==='VERIFIED'?'verified':''}`}><Icon name={state==='VERIFIED'?'badge-check':'shield-check'} size={23}/></span><b className="grow">{title}{ma ? ` · ${ma}` : ''}</b>
        <StatePill state={state} />
      </div>
      {facet?.provenance && (
        <div className="dim">
          {t('profile.provenance')}: {facet.provenance.provider}{facet.provenance.kind !== 'none' ? ` (${facet.provenance.kind})` : ''}
          {facet.submittedAt ? ` · ${t('profile.submitted')} ${fmtDate(facet.submittedAt)}` : ''}
          {facet.recheckAt ? ` · ${t('profile.recheck')} ${fmtDate(facet.recheckAt)}` : ''}
        </div>
      )}
      {facet?.note && <div className="dim" style={{ fontSize: 12.5 }}>{facet.note}</div>}
      {note && <Hint className="dim" style={{ fontSize: 12.5 }}>{note}</Hint>}
      {/* M24F.5 — a verified facet keeps its reference form one tap away; an unverified one shows it. */}
      {state === 'VERIFIED' && !editing ? (
        <div><button type="button" className="linklike" style={{ color: 'var(--sb-link)' }} onClick={() => setEditing(true)} data-testid="facet-new-reference">{t('profile.newReference')}</button></div>
      ) : <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5, color: 'var(--muted)', flex: '1 1 220px' }}>
          {t('profile.submitRef')}
          <input value={ref} onChange={(e) => { setRef(e.target.value); markDirty(); }} placeholder={testProvider ? 'TEST-VERIFIED-…' : ''} />
        </label>
        <button className="primary" disabled={busy || !ref.trim()} onClick={submit}>{t('profile.submit')}</button>
      </div>}
      <ErrorLine error={err} />
    </div>
  );
}

export function ProfileScreen({ session, tick, notify, me }: ScreenProps & { me: Me | null }) {
  const prof = useLoad(() => agent.getProfile(session), [session, tick]);
  const p = prof.data?.profile ?? null;
  const canWrite = !!me?.capabilities.includes('profile.write.own');
  const testProvider = !!me?.platform.testVerificationProvider;
  const [name, setName] = useState('');
  const [profileTab,setProfileTab]=useState('identity');
  const [licence, setLicence] = useState('');
  const [juris, setJuris] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => { if (p) { setName(p.displayName); setLicence(p.declared.fifaLicenceNumber ?? ''); setJuris(p.declared.jurisdictions); } else if (me) { setName(me.user.name); } }, [p, me]);
  const conflict = conflictOf(err);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await agent.saveProfile(session, { displayName: name, fifaLicenceNumber: licence, jurisdictions: juris, ...(p ? { expectedRev: p.rev } : {}) });
      markClean(); notify(t('profile.saved')); prof.reload();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const submitFacet = (facet: 'fifa_licence' | 'national_registration' | 'domestic_authorisation' | 'minors_authorisation') => async (reference: string, ma?: string) => {
    const r = await agent.submitFacet(session, facet, { reference, memberAssociation: ma });
    notify(`${t('profile.submittedOk')} ${tr(`state.${r.facet.state}`)}`);
    prof.reload();
  };
  const toggleJ = (j: string) => { setJuris((cur) => (cur.includes(j) ? cur.filter((x) => x !== j) : [...cur, j])); markDirty(); };
  return (
    <div data-testid="agent-profile">
      <div className="a-profile-identity"><span className="a-profile-monogram">{(p?.displayName??me?.user.name??'').split(' ').map(n=>n[0]).slice(0,2).join('')}</span><div><span className="a-overline">YOUR PROFESSIONAL IDENTITY</span><h3>{p?.displayName??me?.user.name}</h3><p>Agent credentials &amp; operating permissions</p></div><Icon name={p?.facets.fifa_licence?.state==='VERIFIED'?'badge-check':'user'} size={32}/></div>
      <Hint>{p?.honest ?? t('profile.declaredNote')}</Hint>
      <ErrorLine error={prof.error} onRetry={prof.reload} />
      {prof.loading && !prof.data && <Loading />}
      <AgentTabs scope="profile" value={profileTab} onChange={setProfileTab} items={[{id:'identity',label:'Identity',icon:'user'},...(p?[{id:'credentials',label:'Credentials',icon:'badge-check'},{id:'permissions',label:'Authorisations',icon:'shield-check'},{id:'history',label:'Activity',icon:'calendar-days'}]:[])]}/>
      {prof.data && (
        <>
          {!p && !canWrite && <div className="notice">{t('profile.none')}</div>}
          {(p || canWrite) && (
            <AgentPanel scope="profile" id="identity" active={profileTab}><Section title={p ? t('profile.title') : t('profile.create')}>
              <DeskIntro eyebrow="PERSONAL DETAILS" title="Your professional identity" description="Manage the details clients see and the jurisdictions you declare." icon="user"/><div className="form-grid" data-testid="profile-form">
                <label>{t('profile.displayName')}<input value={name} onChange={(e) => { setName(e.target.value); markDirty(); }} disabled={!canWrite} /></label>
                <label>{t('profile.licenceNumber')}<input value={licence} onChange={(e) => { setLicence(e.target.value); markDirty(); }} disabled={!canWrite} /></label>
                <div>
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 4 }}>{t('profile.jurisdictions')}</div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    {JURISDICTIONS.filter((j) => j !== 'INT').map((j) => (
                      <label key={j} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><input type="checkbox" checked={juris.includes(j)} onChange={() => toggleJ(j)} disabled={!canWrite} /> {j}</label>
                    ))}
                  </div>
                </div>
              </div>
              <Hint className="dim" style={{ fontSize: 12.5, marginBottom: 8 }}>{t('profile.declaredNote')} {p?.facets.fifa_licence?.state === 'VERIFIED' ? t('profile.resetWarning') : ''}</Hint>
              {conflict ? <ConflictNotice conflict={conflict} onReload={() => { setErr(null); prof.reload(); }} /> : <ErrorLine error={err} />}
              {canWrite && <button className="primary" disabled={busy || !name.trim()} onClick={save} data-testid="profile-save">{p ? t('common.save') : t('profile.create')}</button>}
            </Section></AgentPanel>
          )}
          {p && (
            <>
              <AgentPanel scope="profile" id="credentials" active={profileTab}><Section title={t('profile.facets')}>
                <div className="notice" style={{ marginBottom: 10 }} data-testid="provider-note">{testProvider ? t('profile.testProvider') : t('profile.noProvider')}</div>
                <div className="a-credentials-grid">
                  <FacetCard title={t('profile.fifa')} facet={p.facets.fifa_licence} testProvider={testProvider} onSubmit={submitFacet('fifa_licence')} />
                  {(juris.length ? juris : ['ENG']).map((ma) => (
                    <FacetCard key={`nr-${ma}`} title={t('profile.national')} ma={ma} facet={p.facets.national_registration[ma] ?? null} testProvider={testProvider} onSubmit={submitFacet('national_registration')} />
                  ))}
                  {(juris.length ? juris : ['ENG']).map((ma) => (
                    <FacetCard key={`da-${ma}`} title={t('profile.domestic')} ma={ma} facet={p.facets.domestic_authorisation?.[ma] ?? null} testProvider={testProvider} onSubmit={submitFacet('domestic_authorisation')} note={t('profile.domesticNote')} />
                  ))}
                  {(juris.length ? juris : ['ENG']).map((ma) => (
                    <FacetCard key={`mn-${ma}`} title={t('profile.minors')} ma={ma} facet={p.facets.minors_authorisation[ma] ?? null} testProvider={testProvider} onSubmit={submitFacet('minors_authorisation')} note={t('profile.minorsNote')} />
                  ))}
                </div>
              </Section></AgentPanel>
              <AgentPanel scope="profile" id="permissions" active={profileTab}><Section title={t('profile.regulated')}>
                <DeskIntro eyebrow="OPERATING PERMISSIONS" title="Where you can act" description="Current authorisations, shown separately for each jurisdiction." icon="shield-check"/><div className="list-rows a-permissions-grid" data-testid="regulatory-state">
                  <div className="list-row"><span className="grow">FIFA · INT</span>{p.regulatoryState.fifaLicence === 'VERIFIED' ? <span className="pill green">{t('profile.regulated')}</span> : <span className="pill red">{t('profile.notRegulated')}</span>}</div>
                  {p.regulatoryState.jurisdictions.map((j) => (
                    <div key={j.memberAssociation} className="list-row">
                      <span className="grow">{j.memberAssociation} · <StatePill state={j.nationalRegistration} /></span>
                      {j.regulatedActionsPermitted ? <span className="pill green">{t('profile.regulated')}</span> : <span className="pill red">{t('profile.notRegulated')}</span>}
                    </div>
                  ))}
                </div>
              </Section></AgentPanel>
              <AgentPanel scope="profile" id="history" active={profileTab}><Section title={t('profile.history')}><DeskIntro eyebrow="YOUR RECORD" title="Credential activity" description="An attributed record of submissions and changes." icon="calendar-days"/>
                <div className="list-rows a-history-ledger">
                  {p.history.slice().reverse().slice(0, 12).map((h) => (
                    <div key={h.id} className="list-row"><span className="grow">{(() => { const a = h.action.replace(/^agent_/, '').replace(/_/g, ' '); return a.charAt(0).toUpperCase() + a.slice(1); })()}{h.detail?.facet ? ` · ${tr(`facet.${String(h.detail.facet)}`)}${h.detail.memberAssociation ? ` (${String(h.detail.memberAssociation)})` : ''}` : ''}{h.detail?.to ? ` → ${tr(`state.${String(h.detail.to)}`)}` : ''}</span><span className="dim">{fmtStamp(h.at)}</span></div>
                  ))}
                </div>
              </Section></AgentPanel>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ============================================================ Clients
function accessLine(r: Relationship, access?: boolean) {
  if (r.legacy) return t('clients.legacyNote');
  if (r.subjectRemovedAt) return t('clients.removedNote');
  if (access) return t('clients.accessActive');
  if (r.status === 'proposed') return t('clients.accessPending');
  if (r.status === 'disputed') return t('clients.accessSuspended');
  return t('clients.accessNone');
}

function RequestForm({ session, notify, onDone }: { session: Session; notify: ScreenProps['notify']; onDone: () => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<PlayerHit[] | null>(null);
  const [lookupErr, setLookupErr] = useState<unknown>(null);
  const [pick, setPick] = useState<PlayerHit | null>(null);
  const [scope, setScope] = useState<Scope[]>(['employment']);
  const [term, setTerm] = useState(12);
  const [juris, setJuris] = useState<string>('INT');
  const [exclusive, setExclusive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const keyRef = useRef(clientKey());
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    if (q.trim().length < 2) { setHits(null); return; }
    timer.current = window.setTimeout(() => {
      agent.lookup(session, q).then((r) => { setHits(r.items); setLookupErr(null); }).catch((e) => { setHits([]); setLookupErr(e); });
    }, 250);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [q, session]);
  const toggleScope = (s: Scope) => setScope((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  const send = async () => {
    if (!pick) return;
    setBusy(true); setErr(null);
    try {
      await agent.requestClient(session, { playerId: pick.id, scope, termMonths: term, jurisdiction: juris as 'INT', exclusive, clientKey: keyRef.current });
      keyRef.current = clientKey();
      notify(t('clients.sent')); markClean(); onDone();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <div className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }} data-testid="request-form">
      <b>{t('clients.request')}</b>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5, color: 'var(--muted)' }}>
        {t('clients.lookup')}
        <input value={q} onChange={(e) => { setQ(e.target.value); setPick(null); markDirty(); }} placeholder={t('clients.lookupHint')} aria-describedby="lookup-hint" data-testid="lookup-input" />
      </label>
      <div id="lookup-hint" className="dim" style={{ fontSize: 12 }}>{t('clients.lookupHint')}</div>
      <ErrorLine error={lookupErr} />
      {hits && !pick && (
        <div className="list-rows" role="listbox" aria-label={t('clients.lookup')}>
          {hits.length === 0 && <div className="dim">{t('clients.noHits')}</div>}
          {hits.map((h) => (
            <button key={h.id} role="option" aria-selected={false} className="list-row" style={{ textAlign: 'left' }} onClick={() => setPick(h)} data-testid={`hit-${h.id}`}>
              <span className="grow"><b>{h.name}</b> · {h.position ?? '—'} · {h.age ?? '—'}{h.club ? ` · ${h.club}` : ''}</span>
            </button>
          ))}
        </div>
      )}
      {pick && (
        <>
          <div className="notice" data-testid="picked">{pick.name} · {pick.position ?? '—'} · {pick.age ?? '—'}{pick.club ? ` · ${pick.club}` : ''} <button style={{ marginLeft: 8 }} onClick={() => setPick(null)}>{t('common.cancel')}</button></div>
          <div className="form-grid">
            <div>
              <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 4 }}>{t('clients.scope')}</div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {SCOPES.map((s) => <label key={s} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><input type="checkbox" checked={scope.includes(s)} onChange={() => toggleScope(s)} /> {tr(`scope.${s}`)}</label>)}
              </div>
            </div>
            <label>{t('clients.term')}<input type="number" min={1} max={24} value={term} onChange={(e) => setTerm(Number(e.target.value))} data-testid="term-input" /></label>
            <label>{t('clients.jurisdiction')}
              <select value={juris} onChange={(e) => setJuris(e.target.value)}>{JURISDICTIONS.map((j) => <option key={j} value={j}>{j}</option>)}</select>
            </label>
            <label style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><input type="checkbox" checked={exclusive} onChange={(e) => setExclusive(e.target.checked)} /> {t('clients.exclusive')}</label>
          </div>
          <ErrorLine error={err} />
          <div><button className="primary" disabled={busy || scope.length === 0} onClick={send} data-testid="send-request">{t('clients.send')}</button></div>
        </>
      )}
    </div>
  );
}

function ClientList({ rows, onOpen }: { rows: ClientRow[]; onOpen: (id: string) => void }) {
  const own = rows.filter((r): r is Relationship & { mode: 'own' } => !isSummary(r));
  const shared = rows.filter(isSummary);
  const group = (title: string, items: (Relationship & { mode: 'own' })[], testId: string) => items.length > 0 && (
    <Section title={title}>
      <div className="list-rows" data-testid={testId}>
        {items.map((r) => (
          <div key={r.id} className="list-row a-client-row" data-testid={`client-row-${r.id}`}><span className="a-client-avatar" aria-hidden="true">{(r.client?.name??'').split(' ').map(n=>n[0]).slice(0,2).join('')}</span>
            <span className="grow">
              <b>{r.client?.name ?? (r.client?.removed ? '—' : r.clientId)}</b>
              <span className="a-client-facts"><span>{scopeLabel(r.scope)}</span>{r.termMonths&&<span>{r.termMonths} months</span>}{r.jurisdiction&&<span>{r.jurisdiction}</span>}</span>
            </span>
            <StatusPill status={r.status} />
            <button onClick={() => onOpen(r.id)}>{t('clients.open')}</button>
          </div>
        ))}
      </div>
    </Section>
  );
  return (
    <>
      {group(t('clients.pending'), own.filter((r) => r.status === 'proposed'), 'clients-pending')}
      {group(t('clients.activeList'), own.filter((r) => r.status === 'active'), 'clients-active')}
      {group(t('clients.ended'), own.filter((r) => !['proposed', 'active'].includes(r.status)), 'clients-ended')}
      {shared.length > 0 && (
        <Section title={t('clients.summaryList')}>
          <div className="list-rows" data-testid="clients-summary">
            {shared.map((r) => (
              <div key={r.id} className="list-row"><span className="grow"><b>{r.client.name ?? r.clientId}</b>{r.legacy ? <span className="pill" style={{ marginLeft: 8 }}>Legacy</span> : null}</span><StatusPill status={r.status} /><button onClick={() => onOpen(r.id)}>{t('clients.open')}</button></div>
            ))}
          </div>
        </Section>
      )}
      {rows.length === 0 && <div className="notice">{t('clients.empty')}</div>}
    </>
  );
}

/**
 * M23 P8 §17 — the client's journeys with clubs, as the server projects them
 * for THIS agent: only clubs that shared something (a contact routed to the
 * agent, an Offer the client shared, a trial the client disclosed), only
 * factual stage words, never a club's assessment, decision or priority. A
 * refusal (basis, scope, licence) is rendered as the answer it is.
 */
function ClientJourneyLine({ session, id, tick }: { session: Session; id: string; tick: number }) {
  const j = useLoad(() => agent.clientJourney(session, id), [session, id, tick]);
  if (j.error) return <Section title={t('clients.journey.title')}><ErrorLine error={j.error} onRetry={j.reload} /></Section>;
  if (!j.data) return null;
  const stage = (s: string) => t(`clients.journey.st.${s}`, s.replace(/_/g, ' '));
  return (
    <Section title={t('clients.journey.title')}>
      <div className="dim" style={{ fontSize: 12.5, marginBottom: 6 }}>{t('clients.journey.honest')}</div>
      {j.data.items.length === 0 ? <div className="dim" data-testid="client-journey-empty">{t('clients.journey.none')}</div> : (
        <div className="list-rows" data-testid="client-journey">
          {j.data.items.map((it) => (
            <div key={it.club.id} className="list-row" style={{ flexWrap: 'wrap' }} data-testid={`client-journey-${it.club.id}`} data-stage={it.journey.stage}>
              <span className="grow"><b>{it.club.name ?? it.club.id}</b></span>
              <span className="pill">{stage(it.journey.stage)}</span>
              {it.journey.timeline.length > 0 && <span className="dim" style={{ fontSize: 12 }}>{t('clients.journey.last')} {t(`clients.journey.ev.${it.journey.timeline[it.journey.timeline.length - 1].kind}`, it.journey.timeline[it.journey.timeline.length - 1].kind.replace(/_/g, ' '))} · {fmtDate(it.journey.timeline[it.journey.timeline.length - 1].at)}</span>}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function ClientDetailView({ session, id, tab, onTab, onBack, notify, tick }: { session: Session; id: string; tab: ClientTab; onTab: (t: ClientTab) => void; onBack: () => void; notify: ScreenProps['notify']; tick: number }) {
  const d = useLoad(() => agent.client(session, id), [session, id, tick]);
  const det = d.data as ClientDetail | null;
  const opps = useLoad(() => (det && det.mode === 'own' && det.access ? agent.clientOpportunities(session, id) : Promise.resolve(null)), [session, id, det?.access, tick]);
  // M23 P5.6E. Loaded only where a basis exists, and each one refuses on its own
  // terms when the client's disclosure for it is off — the error IS the answer, so
  // it is rendered rather than swallowed.
  const contacts = useLoad(() => (det && det.mode === 'own' && det.access && tab === 'contacts' ? agent.clientContacts(session, id) : Promise.resolve(null)), [session, id, det?.access, tab, tick]);
  const trials = useLoad(() => (det && det.mode === 'own' && det.access && (tab === 'trials' || tab === 'tasks') ? agent.clientTrials(session, id) : Promise.resolve(null)), [session, id, det?.access, tab, tick]);
  // M23 P6. Loaded only on its tab; the server answers 403 when the mandate, scope or licence does not hold NOW, and that answer is rendered.
  const offers = useLoad(() => (det && det.mode === 'own' && det.access && (tab === 'offers' || tab === 'tasks' || tab === 'past-offers') ? agent.clientOffers(session, id) : Promise.resolve(null)), [session, id, det?.access, tab, tick]);
  // M23 P7 — signing progress over the shared Offers; a refusal (scope, licence, basis) hides the line rather than the Offers.
  const signings = useLoad(() => (det && det.mode === 'own' && det.access && (tab === 'signings' || tab === 'tasks' || tab === 'past-signings') ? agent.clientSignings(session, id).then((r) => ({ ...r, refused: null as string | null })).catch((e: unknown) => ({ items: [], clientId: id, clientName: null, honest: '', refused: (e as { code?: string } | null)?.code ?? 'REFUSED' })) : Promise.resolve(null)), [session, id, det?.access, tab, tick]);
  const shares = useLoad(() => (det && det.mode === 'own' && det.access ? agent.clientShares(session, id) : Promise.resolve(null)), [session, id, det?.access, tick]);
  // M24B — read-only pages over records the agent already reads elsewhere: the
  // compliance contexts naming this client, the transaction workspaces the
  // client is a party to (where the agent's own documents live), the full
  // journey timeline. Each is loaded only on its page and refuses on its own terms.
  const contexts = useLoad(() => (det && det.mode === 'own' && tab === 'compliance' ? agent.contexts(session) : Promise.resolve(null)), [session, id, det?.mode, tab, tick]);
  const txs = useLoad(() => (det && det.mode === 'own' && tab === 'documents' ? agent.transactions(session) : Promise.resolve(null)), [session, id, det?.mode, tab, tick]);
  const timeline = useLoad(() => (det && det.mode === 'own' && det.access && tab === 'timeline' ? agent.clientJourney(session, id) : Promise.resolve(null)), [session, id, det?.access, tab, tick]);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [shareNote, setShareNote] = useState<Record<string, string>>({});
  if (d.error) return <><button onClick={onBack}>← {t('clients.back')}</button><ErrorLine error={d.error} onRetry={d.reload} /></>;
  if (!det) return <Loading />;
  if (det.mode === 'summary') {
    const s = det.relationship as RelationshipSummary;
    return (
      <div data-testid="client-detail">
        <button onClick={onBack}>← {t('clients.back')}</button>
        <h3 style={{ margin: '12px 0 6px' }}>{s.client.name ?? s.clientId}</h3>
        <StatusPill status={s.status} />
        <div className="notice" style={{ marginTop: 10 }} data-testid="summary-only">{s.legacy ? t('clients.legacyNote') : t('clients.summaryOnly')}</div>
        <div className="dim" style={{ marginTop: 8 }}>{s.startAt ? `${t('clients.startedAt')} ${fmtDate(s.startAt)}` : ''}{s.endAt ? ` · ${t('clients.endsAt')} ${fmtDate(s.endAt)}` : ''}</div>
      </div>
    );
  }
  const r = det.relationship as Relationship;
  const c = det.client!;
  const conflict = conflictOf(err);
  const end = async () => {
    const withdrawing = r.status === 'proposed';
    if (!confirmDestructive({ ...(withdrawing ? DESTRUCTIVE_ACTIONS.withdrawRequest : DESTRUCTIVE_ACTIONS.terminateRelationship), name: c.name ?? r.clientId })) return;
    setBusy(true); setErr(null);
    try { await agent.terminate(session, r.id, { reasonCode: withdrawing ? 'withdrawn' : 'agent_ended', clientKey: clientKey(), expectedRev: r.rev }); notify(t('clients.terminated')); d.reload(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  /** §18 — share, and nothing else. A refused share says which rule refused. */
  const share = async (oppId: string) => {
    setBusy(true); setErr(null);
    try {
      await agent.shareOpportunity(session, r.id, oppId, { note: shareNote[oppId] ?? '', clientKey: clientKey() });
      notify(t('share.done'));
      setShareNote((c) => ({ ...c, [oppId]: '' }));
      shares.reload();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const withdrawShare = async (shareId: string) => {
    setBusy(true); setErr(null);
    try { await agent.withdrawShare(session, r.id, shareId); notify(t('share.withdrawn')); shares.reload(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const labelFor = (x: string) => tr(`clients.tab.${x}`);
  const loc = locate(CLIENT_NAV, tab) ?? defaultLocation(CLIENT_NAV);
  const sub = loc.sub;
  const noAccess = (testId: string) => <div className="notice warn" data-testid={testId}>{t('clients.noAccessOpps')}</div>;
  const signingLabel = (s: ClientSigning) => (tr(`signing.st.${s.status}`) === `signing.st.${s.status}` ? s.statusLabel ?? s.status : tr(`signing.st.${s.status}`));
  const offerLabel = (x: ClientOffer) => (tr(`offers.st.${x.status ?? ''}`) === `offers.st.${x.status ?? ''}` ? x.statusLabel ?? x.status : tr(`offers.st.${x.status ?? ''}`));
  const PAST_OFFER = new Set(['DECLINED', 'WITHDRAWN', 'EXPIRED', 'SUPERSEDED']);
  const signingRow = (sg: ClientSigning) => {
    const done = sg.requiredParties.filter((p) => p.status === 'COMPLETED').length;
    return (
      <div key={sg.id} className="list-row" data-testid={`offer-signing-${sg.offerId}`} data-signing-status={sg.status} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 4 }}>
        <div className="row" style={{ gap: 8, width: '100%', flexWrap: 'wrap' }}>
          <strong className="grow">{sg.club.name ?? '—'}</strong>
          <span className="pill" data-testid={`signing-state-${sg.id}`}>{signingLabel(sg)}</span>
          {sg.clientActionRequired && <span className="pill warn">{t('signing.clientAction')}</span>}
        </div>
        <div className="dim" style={{ fontSize: 12.5 }}>
          {t('signing.revision')} {sg.currentRevisionNumber ?? '—'} · {t('signing.parties').replace('{done}', String(done)).replace('{total}', String(sg.requiredParties.length))}
          {sg.completedAt ? ` · ${t('signing.completedAt')} ${fmtStamp(sg.completedAt)}` : ''}
          {sg.contract?.startDate ? ` · ${sg.contract.startDate}${sg.contract.endDate ? ` → ${sg.contract.endDate}` : ''}` : ''}
        </div>
      </div>
    );
  };
  return (
    <div data-testid="client-detail" data-status={r.status}>
      <button onClick={onBack}>← {t('clients.back')}</button>
      <div className="a-client-heading"><span className="a-client-avatar" aria-hidden="true">{(c.name??'').split(' ').map(n=>n[0]).slice(0,2).join('')}</span>
        <h3 style={{ margin: 0 }}>{c.name ?? (c.removed ? '—' : r.clientId)}</h3>
        <StatusPill status={r.status} />
        {r.shareWithAgencyStaff && <span className="pill">{t('clients.sharing')}</span>}
      </div>
      <div className={`notice ${det.access ? '' : 'warn'}`} data-testid="access-line" data-access={det.access ? 'active' : 'none'}>{accessLine(r, det.access)}</div>
      {r.status === 'disputed' && <div className="notice block" style={{ marginTop: 8 }} data-testid="disputed-note">{t('clients.disputedNote')}</div>}
      {r.status === 'expired' && <div className="notice warn" style={{ marginTop: 8 }}>{t('clients.expiredNote')}</div>}
      <div style={{ marginTop: 12 }}>
        {/* M24B — category → subcategory; only the current category's pages are in the DOM. */}
        <CaseCrumb model={CLIENT_NAV} value={loc} translate={tr} prefix={[t('clients.title'), c.name ?? r.clientId]} />
        <CaseNav
          model={CLIENT_NAV} value={loc} onChange={(l) => onTab(l.sub)} translate={tr} idPrefix="client"
          label={t('clients.sections')} categoriesLabel={t('clients.areas')} subsLabel={(x) => `${t('clients.pagesIn')} ${x}`}
          testId="client-nav" catTestId={(x) => `client-cat-${x}`} subTestId={(x) => `client-tab-${x}`}
        />
        <Panel id={sub} label={labelFor(sub)}>
          {sub === 'summary' && (
            <>
              <Section title={t('clients.identity')}>
                <div className="stat-grid">
                  <Stat v={c.position ?? '—'} k="Position" />
                  <Stat v={c.age ?? '—'} k="Age" />
                  <Stat v={c.club ?? '—'} k="Club" />
                  <Stat v={c.country ?? '—'} k="Country" />
                </div>
              </Section>
              <Section title={t('clients.tab.representation')}>
                <div className="stat-grid">
                  <Stat v={scopeLabel(r.scope)} k={t('clients.scope')} />
                  <Stat v={r.termMonths ?? '—'} k={t('clients.term')} />
                  <Stat v={r.startAt ? fmtDate(r.startAt) : '—'} k={t('clients.startedAt')} />
                  <Stat v={r.endAt ? fmtDate(r.endAt) : '—'} k={t('clients.endsAt')} />
                </div>
              </Section>
            </>
          )}
          {sub === 'journey' && (det.access ? <ClientJourneyLine session={session} id={id} tick={tick} /> : noAccess('journey-no-access'))}
          {sub === 'tasks' && (
            <Section title={t('clients.tasksTitle')}>
              <Hint>{t('clients.tasksNote')}</Hint>
              {!det.access ? noAccess('tasks-no-access') : (() => {
                const rows: { key: string; text: string; sub: string }[] = [];
                for (const x of offers.data?.items ?? []) if (x.awaitingClientResponse) rows.push({ key: `o-${x.id}`, text: `${t('clients.taskOffer')} · ${x.club.name ?? '—'}`, sub: 'offers' });
                for (const g of signings.data?.items ?? []) if (g.clientActionRequired) rows.push({ key: `s-${g.id}`, text: `${t('clients.taskSigning')} · ${g.club.name ?? '—'}`, sub: 'signings' });
                for (const x of trials.data?.items ?? []) if (x.awaitingClientConfirmation) rows.push({ key: `t-${x.id}`, text: `${t('clients.taskTrial')} · ${x.club.name ?? '—'}`, sub: 'trials' });
                const withheld = [offers.error ? t('clients.tab.offers') : null, signings.data?.refused ? t('clients.tab.signings') : null, trials.error ? t('clients.tab.trials') : null].filter(Boolean);
                return (
                  <>
                    {rows.length === 0 && <div className="notice" data-testid="client-tasks-none">{t('clients.tasksNone')}</div>}
                    <div className="list-rows" data-testid="client-tasks">
                      {rows.map((row) => <div key={row.key} className="list-row"><span className="grow">{row.text}</span><button onClick={() => onTab(row.sub)}>{labelFor(row.sub)}</button></div>)}
                    </div>
                    {withheld.length > 0 && <p className="dim" style={{ fontSize: 12.5 }}>{withheld.join(', ')}: {t('clients.taskWithheld')}</p>}
                  </>
                );
              })()}
            </Section>
          )}
          {sub === 'activity' && (<>
            <div className="list-rows" data-testid="client-activity">
              {r.history.slice().reverse().map((h) => (
                <div key={h.id} className="list-row"><span className="grow">{tr(`action.${h.action}`) === `action.${h.action}` ? h.action.replace(/_/g, ' ') : tr(`action.${h.action}`)}{h.byName ? ` · ${h.byName}` : ''}</span><span className="dim">{fmtStamp(h.at)}</span></div>
              ))}
            </div>
          </>)}
          {sub === 'profile' && (det.access ? (
            <Section title={t('clients.profileFields')}>
              <div className="dim" style={{ fontSize: 12.5 }}>{Object.keys(c).filter((k) => !['id', 'name', 'accessBasis'].includes(k) && c[k] !== null && typeof c[k] !== 'object').map((k) => `${k}: ${String(c[k])}`).join(' · ')}</div>
            </Section>
          ) : noAccess('profile-no-access'))}
          {sub === 'representation' && (<>
            <div className="stat-grid" style={{ marginBottom: 12 }}>
              <Stat v={scopeLabel(r.scope)} k={t('clients.scope')} />
              <Stat v={r.termMonths ?? '—'} k={t('clients.term')} />
              <Stat v={r.jurisdiction ?? '—'} k={t('clients.jurisdiction')} />
              <Stat v={r.exclusive ? t('common.yes') : t('common.no')} k={t('clients.exclusive')} />
            </div>
            <div className="list-rows">
              <div className="list-row"><span className="grow">{t('clients.proposedAt')}</span><span className="dim">{r.proposedAt ? fmtStamp(r.proposedAt) : '—'}</span></div>
              <div className="list-row"><span className="grow">{t('clients.confirmedBy')}</span><span className="dim">{r.confirmedAt ? fmtStamp(r.confirmedAt) : '—'}</span></div>
              <div className="list-row"><span className="grow">{t('clients.startedAt')} / {t('clients.endsAt')}</span><span className="dim">{r.startAt ? fmtDate(r.startAt) : '—'} → {r.endAt ? fmtDate(r.endAt) : '—'}</span></div>
              <div className="list-row"><span className="grow">{r.shareWithAgencyStaff ? t('clients.sharing') : t('clients.notShared')}</span></div>
            </div>
            <Hint className="dim" style={{ fontSize: 12.5, marginTop: 8 }}>{r.honest}</Hint>
            {conflict ? <ConflictNotice conflict={conflict} onReload={() => { setErr(null); d.reload(); }} /> : <ErrorLine error={err} />}
            {(r.status === 'proposed' || r.status === 'active') && !r.legacy && (
              <div style={{ marginTop: 10 }}><button disabled={busy} onClick={end} data-testid="terminate">{r.status === 'proposed' ? t('clients.withdraw') : t('clients.terminate')}</button></div>
            )}
          </>)}
          {sub === 'compliance' && (
            <Section title={t('clients.tab.compliance')}>
              <Hint>{t('clients.complianceNote')}</Hint>
              <ErrorLine error={contexts.error} onRetry={contexts.reload} />
              {contexts.data && (() => {
                const mine = contexts.data.items.filter((cx) => cx.parties.some((pa) => pa.subjectKind === 'player' && pa.subjectId === r.clientId && !pa.removed));
                return mine.length === 0 ? <div className="notice" data-testid="client-compliance-none">{t('clients.complianceNone')}</div> : (
                  <div className="list-rows" data-testid="client-compliance">
                    {mine.map((cx) => (
                      <div key={cx.id} className="list-row" data-context={cx.id}>
                        <span className="grow"><strong>{cx.type}</strong> <span className="dim">· {cx.status} · {cx.jurisdictions.join(', ') || '—'}</span></span>
                        <a className="linklike" href={hashForContext(cx.id)}>{t('clients.complianceOpen')}</a>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </Section>
          )}
          {sub === 'opportunities' && (<>
            {!det.access && <div className="notice warn" data-testid="opps-no-access">{t('clients.noAccessOpps')}</div>}
            {det.access && (
              <>
                <Hint>{opps.data?.note ?? t('clients.oppsNote')}</Hint>
                <ErrorLine error={opps.error} onRetry={opps.reload} />
                {opps.data && opps.data.items.length === 0 && <div className="notice">{t('clients.noOpps')}</div>}
                <div className="list-rows" data-testid="client-opps">{(opps.data?.items ?? []).map((o) => {
                  const shared = (shares.data?.items ?? []).find((x) => x.opportunityId === o.id && !x.withdrawnAt) ?? null;
                  return (
                    <div key={o.id} data-testid={`opp-wrap-${o.id}`}>
                      <OppRow o={o} />
                      {/*
                        M23 P5.6E §18. Bringing it to the client's attention — and
                        nothing more. There is deliberately no "apply" control here
                        at any role: applying is the client's own act on their own
                        screen, and a button here would be a lie about that.
                      */}
                      <div className="row" style={{ gap: 8, margin: '4px 0 10px', flexWrap: 'wrap', alignItems: 'center' }}>
                        {shared ? (
                          <>
                            <span className="pill" data-testid={`share-state-${o.id}`}>{t('share.shared')}</span>
                            <span className="dim" style={{ fontSize: 12 }}>{fmtStamp(shared.sharedAt)}</span>
                            <button disabled={busy} onClick={() => withdrawShare(shared.id)} data-testid={`share-withdraw-${o.id}`}>{t('share.withdraw')}</button>
                          </>
                        ) : (
                          <>
                            <input
                              aria-label={t('share.noteLabel')}
                              placeholder={t('share.notePlaceholder')}
                              value={shareNote[o.id] ?? ''}
                              maxLength={300}
                              onChange={(e) => setShareNote((c) => ({ ...c, [o.id]: e.target.value }))}
                              data-testid={`share-note-${o.id}`}
                              style={{ flex: '1 1 220px', minWidth: 0 }}
                            />
                            <button disabled={busy} onClick={() => share(o.id)} data-testid={`share-${o.id}`}>{t('share.action')}</button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}</div>
                <p className="dim" style={{ fontSize: 12.5 }}>{t('share.honest')}</p>
              </>
            )}
          </>)}
          {sub === 'contacts' && (<>
            {!det.access && <div className="notice warn" data-testid="contacts-no-access">{t('clients.noAccessOpps')}</div>}
            {det.access && (
              <>
                <Hint>{contacts.data?.note ?? t('contacts.intro')}</Hint>
                <ErrorLine error={contacts.error} onRetry={contacts.reload} />
                {contacts.data && contacts.data.items.length === 0 && <div className="notice" data-testid="contacts-none">{t('contacts.none')}</div>}
                <div className="list-rows" data-testid="client-contacts">
                  {(contacts.data?.items ?? []).map((k) => (
                    <div key={k.id} className="list-row" data-testid={`contact-${k.id}`} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 4 }}>
                      <div className="row" style={{ gap: 8, width: '100%', flexWrap: 'wrap' }}>
                        <strong className="grow">{k.club.name ?? '—'}</strong>
                        <span className="pill">{tr(`contactStatus.${k.status}`) === `contactStatus.${k.status}` ? k.status : tr(`contactStatus.${k.status}`)}</span>
                        <span className="dim" style={{ fontSize: 12 }}>{fmtStamp(k.routedAt)}</span>
                      </div>
                      {k.subject && <div style={{ fontWeight: 600, fontSize: 13 }}>{k.subject}</div>}
                      {k.body && <div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap' }}>{k.body}</div>}
                      <div className="dim" style={{ fontSize: 12 }}>
                        {k.responseKind ? `${t('contacts.clientAnswered')}: ${tr(`contactResponse.${k.responseKind}`) === `contactResponse.${k.responseKind}` ? k.responseKind : tr(`contactResponse.${k.responseKind}`)}` : t('contacts.awaitingClient')}
                      </div>
                    </div>
                  ))}
                </div>
                <p className="dim" style={{ fontSize: 12.5 }}>{t('contacts.honest')}</p>
              </>
            )}
          </>)}
          {sub === 'trials' && (<>
            {!det.access && <div className="notice warn" data-testid="trials-no-access">{t('clients.noAccessOpps')}</div>}
            {det.access && (
              <>
                <Hint>{trials.data?.note ?? t('trials.intro')}</Hint>
                <ErrorLine error={trials.error} onRetry={trials.reload} />
                {trials.data && trials.data.items.length === 0 && <div className="notice" data-testid="trials-none">{t('trials.none')}</div>}
                <div className="list-rows" data-testid="client-trials">
                  {(trials.data?.items ?? []).map((x) => (
                    <div key={x.id} className="list-row" data-testid={`trial-${x.id}`} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 4 }}>
                      <div className="row" style={{ gap: 8, width: '100%', flexWrap: 'wrap' }}>
                        <strong className="grow">{x.club.name ?? '—'}</strong>
                        <span className="pill" data-testid={`trial-state-${x.id}`}>{x.workflowLabel}</span>
                        {x.awaitingClientConfirmation && <span className="pill warn">{t('trials.awaitingClient')}</span>}
                      </div>
                      {(x.schedule?.sessions ?? []).map((ss) => (
                        <div key={ss.id} className="dim" style={{ fontSize: 12.5 }}>
                          {fmtStamp(ss.startsAt)} → {fmtClock(ss.endsAt)} · {ss.venue?.name ?? '—'}{ss.venue?.town ? `, ${ss.venue.town}` : ''} · {tr(`attendance.${ss.attendance.state}`) === `attendance.${ss.attendance.state}` ? ss.attendance.state.replace(/_/g, ' ') : tr(`attendance.${ss.attendance.state}`)}
                        </div>
                      ))}
                      {x.reportObligation && <div className="dim" style={{ fontSize: 12 }}>{t(x.reportObligation === 'outstanding' ? 'trials.reportOutstanding' : 'trials.reportFiled')}</div>}
                    </div>
                  ))}
                </div>
                <p className="dim" style={{ fontSize: 12.5 }}>{trials.data?.honest ?? t('trials.honest')}</p>
              </>
            )}
          </>)}
          {sub === 'offers' && (<>
            {!det.access && <div className="notice warn" data-testid="offers-no-access">{t('clients.noAccessOpps')}</div>}
            {det.access && (
              <>
                <Hint>{t('offers.intro')}</Hint>
                <ErrorLine error={offers.error} onRetry={offers.reload} />
                {offers.data && offers.data.items.length === 0 && <div className="notice" data-testid="offers-none">{t('offers.none')}</div>}
                <div className="list-rows" data-testid="client-offers">
                  {(offers.data?.items ?? []).map((x) => {
                    const cur = x.currentRevision;
                    return (
                      <div key={x.id} className="list-row" data-testid={`offer-${x.id}`} data-status={x.status ?? ''} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 4 }}>
                        <div className="row" style={{ gap: 8, width: '100%', flexWrap: 'wrap' }}>
                          <strong className="grow">{x.club.name ?? '—'}</strong>
                          <span className="pill" data-testid={`offer-state-${x.id}`}>{tr(`offers.st.${x.status ?? ''}`) === `offers.st.${x.status ?? ''}` ? x.statusLabel ?? x.status : tr(`offers.st.${x.status ?? ''}`)}</span>
                          {x.awaitingClientResponse && <span className="pill warn">{t('offers.awaitingClient')}</span>}
                        </div>
                        {cur && (
                          <div className="dim" style={{ fontSize: 12.5 }} data-testid={`offer-terms-${x.id}`}>
                            {t('offers.revision')} {cur.revisionNumber} · {cur.terms.role ?? '—'}{cur.terms.squad ? ` · ${cur.terms.squad}` : ''} · {cur.terms.startDate ?? '—'}{cur.terms.endDate ? ` → ${cur.terms.endDate}` : ''}
                            {cur.expiresAt ? ` · ${t('offers.expires')} ${fmtStamp(cur.expiresAt)}` : ''}
                          </div>
                        )}
                        {cur?.terms.conditions && <div className="dim" style={{ fontSize: 12.5 }}>{cur.terms.conditions}</div>}
                        {x.status === 'ACCEPTED' && <div className="dim" style={{ fontSize: 12.5 }} data-testid={`offer-signing-pending-${x.id}`}>{t('offers.signingPending')}</div>}
                        {x.sharedAt && <div className="dim" style={{ fontSize: 12 }}>{t('offers.sharedAt')} {fmtStamp(x.sharedAt)}</div>}
                      </div>
                    );
                  })}
                </div>
                <p className="dim" style={{ fontSize: 12.5 }}>{t('offers.honest')}</p>
              </>
            )}
          </>)}
          {sub === 'signings' && (
            <>
              {!det.access && noAccess('signings-no-access')}
              {det.access && (
                <>
                  <Hint>{t('signing.honest')}</Hint>
                  {signings.data?.refused && <div className="notice warn" data-testid="client-signings-withheld">{t('signing.withheld')}</div>}
                  {signings.data && !signings.data.refused && signings.data.items.filter((g) => !g.terminal || g.status === 'COMPLETED').length === 0 && <div className="notice" data-testid="signings-none">{t('clients.pastSigningsNone')}</div>}
                  <div className="list-rows" data-testid="client-signings">{(signings.data?.items ?? []).filter((g) => !g.terminal || g.status === 'COMPLETED').map(signingRow)}</div>
                  {signings.data && signings.data.items.length > 0 && <p className="dim" style={{ fontSize: 12.5 }} data-testid="client-signings-honest">{t('signing.honest')}</p>}
                </>
              )}
            </>
          )}
          {sub === 'documents' && (
            <Section title={t('clients.tab.documents')}>
              <Hint>{t('clients.documentsNote')}</Hint>
              <ErrorLine error={txs.error} onRetry={txs.reload} />
              {txs.data && (() => {
                const mine = txs.data.items.filter((tx) => tx.playerId === r.clientId);
                return mine.length === 0 ? <div className="notice" data-testid="client-documents-none">{t('clients.documentsNone')}</div> : (
                  <div className="list-rows" data-testid="client-documents">
                    {mine.map((tx) => (
                      <div key={tx.id} className="list-row" data-tx={tx.id}>
                        <span className="grow"><strong>{tr(`txType.${tx.type}`) === `txType.${tx.type}` ? tx.type : tr(`txType.${tx.type}`)}</strong> <span className="dim">· {tx.status} · {tx.documents.length} {t('txTab.documents').toLowerCase()}</span></span>
                        <a className="linklike" href={hashForTransaction(tx.id, 'documents')}>{t('clients.documentsOpen')}</a>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </Section>
          )}
          {sub === 'timeline' && (
            <Section title={t('clients.tab.timeline')}>
              <Hint>{t('clients.timelineNote')}</Hint>
              {!det.access && noAccess('timeline-no-access')}
              <ErrorLine error={timeline.error} onRetry={timeline.reload} />
              {timeline.data && timeline.data.items.every((it) => it.journey.timeline.length === 0) && <div className="notice" data-testid="client-timeline-none">{t('clients.timelineNone')}</div>}
              {timeline.data && timeline.data.items.filter((it) => it.journey.timeline.length > 0).map((it) => (
                <div key={it.club.id} className="list-rows" data-testid={`client-timeline-${it.club.id}`}>
                  <div className="list-row"><strong className="grow">{it.club.name ?? it.club.id}</strong><span className="pill">{t(`clients.journey.st.${it.journey.stage}`, it.journey.stage.replace(/_/g, ' '))}</span></div>
                  {it.journey.timeline.map((ev, i) => (
                    <div key={`${ev.kind}-${ev.at}-${i}`} className="list-row" data-kind={ev.kind}><span className="dim" style={{ minWidth: 120 }}>{fmtStamp(ev.at)}</span><span className="grow">{t(`clients.journey.ev.${ev.kind}`, ev.kind.replace(/_/g, ' '))}</span></div>
                  ))}
                </div>
              ))}
            </Section>
          )}
          {sub === 'past-offers' && (
            <Section title={t('clients.tab.past-offers')}>
              <Hint>{t('clients.historyNote')}</Hint>
              {!det.access && noAccess('past-offers-no-access')}
              <ErrorLine error={offers.error} onRetry={offers.reload} />
              {offers.data && offers.data.items.filter((x) => PAST_OFFER.has(x.status ?? '')).length === 0 && <div className="notice" data-testid="past-offers-none">{t('clients.pastOffersNone')}</div>}
              <div className="list-rows" data-testid="client-past-offers">
                {(offers.data?.items ?? []).filter((x) => PAST_OFFER.has(x.status ?? '')).map((x) => (
                  <div key={x.id} className="list-row" data-testid={`past-offer-${x.id}`} data-status={x.status ?? ''}>
                    <strong className="grow">{x.club.name ?? '—'}</strong>
                    <span className="pill">{offerLabel(x)}</span>
                    <span className="dim" style={{ fontSize: 12 }}>{x.currentRevision ? `${t('offers.revision')} ${x.currentRevision.revisionNumber}` : ''}{x.responses.length ? ` · ${fmtStamp(x.responses[x.responses.length - 1].occurredAt)}` : ''}</span>
                  </div>
                ))}
              </div>
            </Section>
          )}
          {sub === 'past-signings' && (
            <Section title={t('clients.tab.past-signings')}>
              <Hint>{t('clients.historyNote')}</Hint>
              {!det.access && noAccess('past-signings-no-access')}
              {signings.data?.refused && <div className="notice warn">{t('signing.withheld')}</div>}
              {signings.data && !signings.data.refused && signings.data.items.filter((g) => g.terminal).length === 0 && <div className="notice" data-testid="past-signings-none">{t('clients.pastSigningsNone')}</div>}
              <div className="list-rows" data-testid="client-past-signings">{(signings.data?.items ?? []).filter((g) => g.terminal).map(signingRow)}</div>
            </Section>
          )}
        </Panel>
      </div>
    </div>
  );
}

export function ClientsScreen({ session, tick, notify, me, clientId, clientTab, onOpenClient, onClientTab, onCloseClient }: ScreenProps & { me: Me | null; clientId: string | null; clientTab: ClientTab; onOpenClient: (id: string) => void; onClientTab: (t: ClientTab) => void; onCloseClient: () => void }) {
  const list = useLoad(() => agent.clients(session), [session, tick]);
  const [showForm, setShowForm] = useState(false);
  const [clientQuery,setClientQuery]=useState(''),[clientStatus,setClientStatus]=useState('');
  const canRequest = !!me?.capabilities.includes('clients.request');
  const visibleClients=(list.data?.items??[]).filter(r=>(r.client?.name??'').toLowerCase().includes(clientQuery.toLowerCase())&&(!clientStatus||r.status===clientStatus));
  if (clientId) return <ClientDetailView session={session} id={clientId} tab={clientTab} onTab={onClientTab} onBack={onCloseClient} notify={notify} tick={tick} />;
  return (
    <div data-testid="agent-clients">
      <Hint>{t('clients.intro')}</Hint>
      {canRequest && !showForm && <div style={{ marginBottom: 12 }}><button className="primary" onClick={() => setShowForm(true)} data-testid="open-request">{t('clients.request')}</button></div>}
      {canRequest && showForm && <div style={{ marginBottom: 14 }}><RequestForm session={session} notify={notify} onDone={() => { setShowForm(false); list.reload(); }} /></div>}
      <ErrorLine error={list.error} onRetry={list.reload} />
      {list.loading && !list.data && <Loading />}
      {list.data && <><div className="a-record-toolbar"><label className="a-inline-search"><Icon name="search" size={17}/><input aria-label="Search client portfolio" placeholder="Find a client" value={clientQuery} onChange={e=>setClientQuery(e.target.value)}/></label><select aria-label="Client status" value={clientStatus} onChange={e=>setClientStatus(e.target.value)}><option value="">All relationships</option>{['active','proposed','disputed','expired','declined','terminated_by_client','terminated_by_agent'].map(st=><option key={st} value={st}>{tr(`status.${st}`)}</option>)}</select><span>{visibleClients.length} of {list.data.items.length} records</span></div><ClientList rows={visibleClients} onOpen={onOpenClient} /></>}
    </div>
  );
}

// ============================================================ Opportunities
function OppRow({o,onOpenClient}:{o:Opportunity;onOpenClient?:(id:string)=>void}) {
 const date=new Date(o.deadline);const valid=Number.isFinite(date.getTime());
 return <article className="a-opportunity-v2" data-testid={`opp-${o.id}`}>
   <header><span className="a-org-seal">{o.orgName.split(' ').map(n=>n[0]).slice(0,2).join('')}</span><div><strong>{o.orgName}</strong><span>{o.type.replace(/_/g,' ')}</span></div><span className="a-deadline"><b>{valid?date.getUTCDate():'—'}</b><span>{valid?date.toLocaleDateString('en-GB',{month:'short',timeZone:'UTC'}):'No date'}</span></span></header>
   <h3>{o.title}</h3><div className="a-opportunity-tags">{o.category&&<span>{o.category}</span>}{o.distance&&<span><Icon name="globe" size={12}/>{o.distance}</span>}<span>{o.applied?'Applied':'Available on client board'}</span></div>
   <footer><div><span className="a-overline">CLIENT</span><strong>{o.clientName??'Client record'}</strong></div>{o.agreementId&&onOpenClient&&<button aria-label={`View ${o.clientName??'client'} opportunities`} onClick={()=>onOpenClient(o.agreementId!)}>Client board <Icon name="arrow-up-right" size={15}/></button>}</footer>
   <div className="a-opportunity-date">Deadline {valid?date.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}):o.deadline}</div>
 </article>;
}
export function OpportunitiesScreen({ session, tick, me, onOpenClient }: ScreenProps & { me: Me | null;onOpenClient:(id:string)=>void }) {
  const licensed = !!me?.capabilities.includes('clients.opportunities.read');
  const data = useLoad(() => (licensed ? agent.opportunities(session) : Promise.resolve(null)), [session, tick, licensed]);
  const [query,setQuery]=useState(''),[type,setType]=useState('all'),[order,setOrder]=useState('deadline');
  const items=data.data?.items??[];
  const types=[...new Set(items.map(o=>o.type))];
  const shown=items.filter(o=>(type==='all'||o.type===type)&&`${o.title} ${o.orgName} ${o.clientName??''}`.toLowerCase().includes(query.toLowerCase())).sort((a,b)=>order==='deadline'?a.deadline.localeCompare(b.deadline):a.orgName.localeCompare(b.orgName));
  return <div data-testid="agent-opportunities">
    <Hint>{t('opps.intro')}</Hint>
    {!licensed && <div className="notice warn">{t('opps.notLicensed')}</div>}
    <ErrorLine error={data.error} onRetry={data.reload}/>
    {licensed&&data.loading&&!data.data&&<Loading/>}
    {data.data&&<><div className="a-business-hero a-market-hero"><div><span className="a-overline">THE OPPORTUNITY BOARD</span><h3>Find the next opening.</h3><p>Opportunities visible to your confirmed clients, ready for a closer look.</p></div><div className="a-business-total"><strong>{items.length.toString().padStart(2,'0')}</strong><span>visible opportunities</span></div></div>
      <div className="a-opportunity-controls"><label className="a-inline-search"><Icon name="search" size={17}/><input aria-label="Search opportunities" placeholder="Search opportunity, club or client" value={query} onChange={e=>setQuery(e.target.value)}/></label><select aria-label="Sort opportunities" value={order} onChange={e=>setOrder(e.target.value)}><option value="deadline">Closing soonest</option><option value="club">Club name</option></select></div>
      <div className="a-filter-pills" aria-label="Opportunity type"><button aria-pressed={type==='all'} onClick={()=>setType('all')}>All opportunities <b>{items.length}</b></button>{types.map(x=><button key={x} aria-pressed={type===x} onClick={()=>setType(x)}>{x.replace(/_/g,' ')} <b>{items.filter(o=>o.type===x).length}</b></button>)}<span>{shown.length} in this view</span></div>
      <div className="a-opportunity-board">{shown.map(o=><OppRow key={`${o.clientId}-${o.id}`} o={o} onOpenClient={onOpenClient}/>)}</div>
      {!shown.length&&<div className="a-empty-state"><Icon name="search" size={30}/><h3>{items.length?'No matching opportunities':'Your board is clear'}</h3><p>{items.length?'Try another name or opportunity type.':t('opps.empty')}</p></div>}
    </>}
  </div>;
}

// ============================================================ Inbox
export function InboxScreen({ session, tick, notify, onOpenClient }: ScreenProps & { onOpenClient: (id: string) => void }) {
  const data = useLoad(() => agent.inbox(session), [session, tick]);
  const markRead = async () => { try { await api.markNotificationsRead(session); data.reload(); } catch (e) { notify(httpState(e).message, true); } };
  return (
    <div className="a-correspondence" data-testid="agent-inbox">
      <Hint>{t('inbox.intro')}</Hint>
      <ErrorLine error={data.error} onRetry={data.reload} />
      {data.loading && !data.data && <Loading />}
      {data.data && (
        <div className="a-inbox-layout"><aside className="a-inbox-summary"><Icon name="inbox" size={27}/><span className="a-overline">CORRESPONDENCE</span><h3>Your agency desk.</h3><p>Every request and update, connected to its client record.</p><div><strong>{data.data.notifications.filter(n=>!n.read).length}</strong><span>{data.data.notifications.filter(n=>!n.read).length===1?'Unread notice':'Unread notices'}</span></div><div><strong>{data.data.pending.length}</strong><span>{data.data.pending.length===1?'Pending client decision':'Pending client decisions'}</span></div></aside><div>
          {data.data.pending.length > 0 && (
            <Section title={t('inbox.pending')}>
              <div className="list-rows">
                {data.data.pending.map((r) => (
                  <div key={r.id} className="list-row"><span className="grow"><b>{r.client?.name ?? r.clientId}</b> <span className="dim">· {scopeLabel(r.scope)}</span></span><StatusPill status={r.status} /><button onClick={() => onOpenClient(r.id)}>{t('common.open')}</button></div>
                ))}
              </div>
            </Section>
          )}
          <Section title={t('inbox.notices')}>
            {data.data.notifications.length === 0 && <div className="notice">{t('inbox.empty')}</div>}
            {data.data.notifications.some((n) => !n.read) && <div style={{ marginBottom: 8 }}><button onClick={markRead}>{t('inbox.markRead')}</button></div>}
            <div className="list-rows" data-testid="inbox-notices">
              {data.data.notifications.map((n: Notification) => (
                <div key={n.id} className="list-row" style={{ opacity: n.read ? 0.7 : 1 }} data-type={n.type}><span className={`a-notice-marker ${n.read?'read':''}`}><Icon name="bell" size={17}/></span>
                  <span className="grow">{n.text}{(n.repeatCount ?? 1) > 1 && <span className="pill" style={{ marginLeft: 6 }}>×{n.repeatCount}</span>}</span>
                  {n.refId && /^rep-/.test(n.refId) && <button onClick={() => onOpenClient(n.refId!)}>{t('common.open')}</button>}
                  <span className="dim">{fmtStamp(n.ts)}</span>
                </div>
              ))}
            </div>
          </Section>
        </div></div>
      )}
    </div>
  );
}

// ============================================================ Agency
function TeamTab({ session, tick, notify, me }: ScreenProps & { me: Me | null }) {
  const team = useLoad(() => agent.team(session), [session, tick]);
  const canWrite = !!me?.capabilities.includes('agency.team.write');
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [tiers, setTiers] = useState<Tier[]>(['assistant']);
  const [edits, setEdits] = useState<Record<string, Tier[]>>({});
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const keyRef = useRef(clientKey());
  const toggle = (list: Tier[], x: Tier) => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x]);
  const add = async () => {
    setBusy(true); setErr(null);
    try { await agent.addMember(session, { name, role: role || undefined, tiers, clientKey: keyRef.current }); keyRef.current = clientKey(); setName(''); setRole(''); setTiers(['assistant']); markClean(); team.reload(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const saveTiers = async (m: Member) => {
    setBusy(true); setErr(null);
    try { await agent.setTiers(session, m.userId, edits[m.userId] ?? m.tiers, m.rev); setEdits((c) => { const n = { ...c }; delete n[m.userId]; return n; }); notify(t('agency.saved')); team.reload(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const end = async (m: Member) => {
    if (!confirmDestructive({ ...DESTRUCTIVE_ACTIONS.endMember, name: m.name })) return;
    setBusy(true); setErr(null);
    try { await agent.endMember(session, m.userId, m.rev, 'left'); team.reload(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const conflict = conflictOf(err);
  return (
    <>
      <DeskIntro eyebrow="PEOPLE & ACCESS" title="The people behind your agency" description="A named account for every member, with a clear role and access record." icon="users"/><Hint>{t('agency.teamIntro')}</Hint>
      {!canWrite && <div className="dim" style={{ fontSize: 12.5, marginBottom: 8 }}>{t('agency.readOnly')}</div>}
      {conflict ? <ConflictNotice conflict={conflict} onReload={() => { setErr(null); team.reload(); }} /> : <ErrorLine error={err} />}
      <ErrorLine error={team.error} onRetry={team.reload} />
      {team.data && (
        <div className="a-team-grid" data-testid="team-rows">
          {team.data.members.map((m) => (
            <div key={m.affiliationId} className="list-row a-person-card" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }} data-testid={`member-${m.userId}`} data-active={m.active ? '1' : '0'}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="a-member-avatar">{(m.name??'').split(' ').map(n=>n[0]).slice(0,2).join('')}</span><span className="grow"><b>{m.name}</b> <span className="dim">· {m.role}{!m.active ? ` · ${t('agency.ended')}${m.endedAt ? ` ${fmtDate(m.endedAt)}` : ''}` : ''}</span></span>
                {m.licensed ? <StatePill state={m.fifaLicence ?? 'UNVERIFIED'} /> : <span className="pill">{t('agency.noProfile')}</span>}
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                {(canWrite&&m.active?TIERS:m.tiers).map((x) => (
                  <label className={`a-role-chip ${(edits[m.userId]??m.tiers).includes(x)?'selected':''}`} key={x} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12.5, color: 'var(--muted)' }} title={tr(`tierNote.${x}`)}>
                    {canWrite&&m.active?<input type="checkbox" checked={(edits[m.userId] ?? m.tiers).includes(x)} onChange={() => setEdits((c) => ({ ...c, [m.userId]: toggle(c[m.userId] ?? m.tiers, x) }))} />:<Icon name="badge-check" size={12}/>} {tr(`tier.${x}`)}
                  </label>
                ))}
                {canWrite && m.active && edits[m.userId] && <button className="primary" disabled={busy} onClick={() => saveTiers(m)}>{t('agency.saveTiers')}</button>}
                {canWrite && m.active && <button disabled={busy} onClick={() => end(m)} data-testid={`end-${m.userId}`}>{t('agency.endMember')}</button>}
              </div>
            </div>
          ))}
        </div>
      )}
      {canWrite && (
        <Section title={t('agency.addMember')}>
          <div className="form-grid" data-testid="add-member">
            <label>{t('agency.memberName')}<input value={name} onChange={(e) => { setName(e.target.value); markDirty(); }} /></label>
            <label>{t('agency.memberRole')}<input value={role} onChange={(e) => { setRole(e.target.value); markDirty(); }} /></label>
            <div>
              <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 4 }}>{t('agency.tiers')}</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{TIERS.map((x) => <label key={x} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}><input type="checkbox" checked={tiers.includes(x)} onChange={() => setTiers((c) => toggle(c, x))} /> {tr(`tier.${x}`)}</label>)}</div>
            </div>
          </div>
          <button className="primary" disabled={busy || !name.trim() || tiers.length === 0} onClick={add}>{t('agency.addMember')}</button>
        </Section>
      )}
    </>
  );
}

function ComplianceTab({ session, tick }: ScreenProps) {
  const data = useLoad(() => agent.compliance(session), [session, tick]);
  return (
    <>
      <Hint>{t('agency.complianceIntro')}</Hint>
      <ErrorLine error={data.error} onRetry={data.reload} />
      {data.data && (
        <>
          <Hint className="notice" style={{ marginBottom: 10 }} testID="compliance-honest">{data.data.honest}</Hint>
          <DeskIntro eyebrow="AGENCY CREDENTIALS" title="Your team’s professional standing" description="Individual credentials and jurisdiction records, kept separate from agency membership." icon="shield-check"/><div className="a-agency-credentials" data-testid="compliance-rows">
            {data.data.agents.map((a: ComplianceRow) => (
              <div key={a.userId} className="list-row a-person-card"><span className="a-member-avatar">{(a.name??'').split(' ').map(n=>n[0]).slice(0,2).join('')}</span><span className="grow"><b>{a.name}</b>{!a.hasProfile && <span className="dim"> · {t('agency.noProfile')}</span>}{a.jurisdictions.map((j) => <span key={j.memberAssociation} className="a-standing-fact"><span>{j.memberAssociation} registration</span><StatePill state={j.nationalRegistration} /></span>)}</span><div className="a-licence-status"><span>FIFA licence</span><StatePill state={a.fifaLicence} /></div></div>
            ))}
            {data.data.agents.length === 0 && <div className="notice">{t('common.none')}</div>}
          </div>
        </>
      )}
    </>
  );
}

function SettingsTab({ session, tick, notify, me, overview }: ScreenProps & { me: Me | null; overview: AgencyOverview | null }) {
  const canWrite = !!me?.capabilities.includes('agency.settings.write');
  const canAudit = !!me?.capabilities.includes('agency.audit.read');
  const [desc, setDesc] = useState('');
  const [juris, setJuris] = useState<string[]>([]);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => { if (overview) { setDesc(overview.settings.description); setJuris(overview.settings.jurisdictions); } }, [overview]);
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [auditErr, setAuditErr] = useState<unknown>(null);
  const loadAudit = useCallback(async (c: string | null, replace: boolean) => {
    try { const r = await agent.audit(session, c); setRows((cur) => (replace ? r.items : [...cur, ...r.items])); setCursor(r.nextCursor); setAuditErr(null); } catch (e) { setAuditErr(e); }
  }, [session]);
  useEffect(() => { if (canAudit) void loadAudit(null, true); }, [canAudit, loadAudit, tick]);
  const save = async () => {
    setErr(null);
    try { await agent.saveSettings(session, { description: desc, jurisdictions: juris }); markClean(); notify(t('agency.saved')); } catch (e) { setErr(e); }
  };
  return (
    <>
      <DeskIntro eyebrow="AGENCY PREFERENCES" title="Your operating profile" description="Keep your agency description and declared markets up to date." icon="building"/><Hint>{t('agency.settingsIntro')}</Hint>
      <div className="form-grid" data-testid="agency-settings">
        <label>{t('agency.description')}{canWrite?<textarea rows={4} value={desc} onChange={(e) => { setDesc(e.target.value); markDirty(); }} />:<p className="a-readonly-value">{desc||'No description recorded.'}</p>}</label>
        <div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 4 }}>{t('agency.jurisdictions')}</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{(canWrite?JURISDICTIONS:juris).map((j) => <label className={"a-role-chip "+(juris.includes(j)?'selected':'')} key={j} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>{canWrite&&<input type="checkbox" checked={juris.includes(j)} onChange={() => { setJuris((c) => (c.includes(j) ? c.filter((x) => x !== j) : [...c, j])); markDirty(); }} />} {j}</label>)}</div>
        </div>
      </div>
      <ErrorLine error={err} />
      {canWrite ? <button className="primary" onClick={save}>{t('common.save')}</button> : <div className="dim" style={{ fontSize: 12.5 }}>{t('agency.readOnly')}</div>}
      {canAudit && (
        <Section title={t('agency.audit')}>
          <Hint>{t('agency.auditIntro')}</Hint>
          <ErrorLine error={auditErr} />
          <div className="list-rows a-history-ledger" data-testid="audit-rows">
            {rows.map((r) => (
              <div key={r.id} className="list-row"><span className="grow">{r.action.replace(/_/g, ' ')}{r.actor?.name ? ` · ${r.actor.name}` : ''}{typeof r.target.playerName === 'string' ? ` · ${r.target.playerName}` : ''}</span><span className="pill">{r.domain}</span><span className="dim">{fmtStamp(r.at)}</span></div>
            ))}
          </div>
          {cursor && <button style={{ marginTop: 8 }} onClick={() => loadAudit(cursor, false)}>{t('agency.auditMore')}</button>}
        </Section>
      )}
    </>
  );
}

export function AgencyScreen({ session, tick, notify, me, tab, onTab }: ScreenProps & { me: Me | null; tab: AgencyTab; onTab: (t: AgencyTab) => void }) {
  const ov = useLoad(() => agent.agency(session), [session, tick]);
  const o = ov.data as AgencyOverview | null;
  const labelFor = (x: AgencyTab) => tr(`agency.tab.${x}`);
  const canCompliance = !!me?.capabilities.includes('agency.compliance.read');
  const tabs = useMemo(() => AGENCY_TABS.filter((x) => x !== 'compliance' || canCompliance), [canCompliance]);
  return (
    <div data-testid="agent-agency">
      <Hint>{o?.honest ?? t('agency.honest')}</Hint>
      <AgentTabs scope="agency" value={tab} onChange={onTab} items={tabs.map(id=>({id,label:labelFor(id),icon:id==='overview'?'pie-chart':id==='team'?'users':id==='compliance'?'shield-check':'building'}))}/>
      {tab === 'overview' && (
        <AgentPanel scope="agency" active={tab} id="overview">
          <ErrorLine error={ov.error} onRetry={ov.reload} />
          {ov.loading && !o && <Loading />}
          {o && (
            <>
              <div className="a-business-hero"><span className="a-agency-emblem"><Icon name="building" size={36}/></span><div><span className="a-overline">YOUR AGENCY</span><h3>{o.org.name}</h3><p>{o.settings.description||'Your people, relationships and permissions.'}</p><div className="a-jurisdiction-chips">{o.settings.jurisdictions.map(j=><span key={j}>{j}</span>)}</div></div></div>
              <div className="stat-grid" data-testid="agency-stats">
                <Stat v={o.members.active} k={t('agency.members')} />
                <Stat v={o.members.admins} k={t('agency.admins')} />
                <Stat v={o.members.licensedAgents} k={t('agency.licensed')} />
                <Stat v={o.relationships.active} k={t('agency.relActive')} />
                <Stat v={o.relationships.pending} k={t('agency.relPending')} />
                <Stat v={o.relationships.legacy} k={t('agency.relLegacy')} />
              </div>
              <Section title={t('agency.roles')}>
                <div className="list-rows">{o.tiers.map((x) => <div key={x} className="list-row a-permission-row"><span className="a-role-symbol"><Icon name={x==='licensed_agent'?'badge-check':x==='agency_admin'?'building':'user'} size={19}/></span><span className="grow"><b>{tr(`tier.${x}`)}</b> <span className="dim">· {tr(`tierNote.${x}`)}</span></span><span className="dim">{(Object.entries(o.permissions).filter(([, v]) => v.includes(x)).map(([k]) => k)).length} permissions</span></div>)}</div>
              </Section>
            </>
          )}
        </AgentPanel>
      )}
      {tab === 'team' && <AgentPanel scope="agency" active={tab} id="team"><TeamTab session={session} tick={tick} notify={notify} me={me} /></AgentPanel>}
      {tab === 'compliance' && canCompliance && <AgentPanel scope="agency" active={tab} id="compliance"><ComplianceTab session={session} tick={tick} notify={notify} /></AgentPanel>}
      {tab === 'settings' && <AgentPanel scope="agency" active={tab} id="settings"><SettingsTab session={session} tick={tick} notify={notify} me={me} overview={o} /></AgentPanel>}
    </div>
  );
}

// ============================================================ Report / Block
export function SafetyModal({ session, notify, onClose }: { session: Session; notify: ScreenProps['notify']; onClose: () => void }) {
  const dialogRef = useDialog<HTMLDivElement>(onClose); // PRE-M24 (PM-8)
  const [reason, setReason] = useState('');
  const [target, setTarget] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const submit = async () => {
    if (!reason.trim()) return;
    try {
      await api.report(session, { targetKind: target.trim() ? 'player' : 'scout', targetPlayerId: target.trim() || undefined, targetScoutName: target.trim() ? undefined : 'unspecified', reason, urgent });
      notify(t('report.sent')); onClose();
    } catch (e) { setErr(e); }
  };
  return (
    <>
      <div className="drawer-veil" onClick={onClose} />
      <div className="drawer" ref={dialogRef} role="dialog" aria-modal="true" aria-label={t('report.title')} tabIndex={-1} style={{ width: 'min(520px, 92vw)' }}>
        <div className="head"><h3>{t('report.title')}</h3><button className="close" onClick={onClose} aria-label={t('common.close')}>✕</button></div>
        <Hint>{t('report.body')}</Hint>
        <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
          <label>{t('report.target')}<input value={target} onChange={(e) => setTarget(e.target.value)} /></label>
          <label>{t('report.reason')}<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <label style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} /> {t('report.urgent')}</label>
        </div>
        <ErrorLine error={err} />
        <button className="primary" disabled={!reason.trim()} onClick={submit}>{t('report.send')}</button>
      </div>
    </>
  );
}

// Re-exported so App can type the profile it holds.
export type { Profile };
