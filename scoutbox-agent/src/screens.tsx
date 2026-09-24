// ScoutBox Agent — the screens. Every screen reads one server projection and
// renders what it says; nothing here derives access, status or a
// verification state on its own. A refusal is shown as the shared HTTP
// reading (httpState), a conflict as the shared conflict notice.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type Notification, type Session } from './api';
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
import { fmtDate, fmtStamp, t } from './i18n';
import { AGENCY_TABS, CLIENT_TABS, type AgencyTab, type ClientTab } from './nav';

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
  <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} aria-label={label}>{children}</div>
);

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="section"><h4>{title}</h4>{children}</div>
);

const Stat = ({ v, k, testId }: { v: ReactNode; k: string; testId?: string }) => (
  <div className="stat" data-testid={testId}><div className="v">{v}</div><div className="k">{k}</div></div>
);

// ============================================================ Home
export function HomeScreen({ session, tick, onNavigate }: ScreenProps & { onNavigate: (id: 'profile' | 'clients' | 'inbox') => void }) {
  const home = useLoad(() => agent.home(session), [session, tick]);
  const h = home.data as Home | null;
  return (
    <div data-testid="agent-home">
      <p className="pagehint">{h?.regulatoryNotice ?? ''}</p>
      <ErrorLine error={home.error} onRetry={home.reload} />
      {home.loading && !h && <Loading />}
      {h && (
        <>
          <div className="stat-grid" style={{ marginBottom: 18 }}>
            <Stat v={h.counts.active} k={t('home.active')} testId="home-active" />
            <Stat v={h.counts.pending} k={t('home.pending')} testId="home-pending" />
            <Stat v={h.counts.expiringSoon} k={t('home.expiring')} />
            <Stat v={h.counts.disputed} k={t('home.disputed')} />
            <Stat v={h.counts.expired} k={t('home.expired')} />
            <Stat v={<StatePill state={h.profileState} />} k={t('home.verificationState')} testId="home-state" />
          </div>
          {!h.hasProfile && <div className="notice warn" style={{ marginBottom: 12 }}>{t('home.noProfile')} <button onClick={() => onNavigate('profile')} style={{ marginLeft: 8 }}>{t('common.open')}</button></div>}
          <Section title={t('home.tiers')}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{h.tiers.map((x) => <span key={x} className="pill blue">{tr(`tier.${x}`)}</span>)}</div>
          </Section>
          <Section title={t('home.whatThisIs')}>
            <div className="notice">{t('home.whatThisIsBody')}</div>
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
  const state = facet?.state ?? 'UNVERIFIED';
  const submit = async () => {
    setBusy(true); setErr(null);
    try { await onSubmit(ref.trim(), ma); setRef(''); markClean(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <div className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }} data-testid={`facet-${title.toLowerCase().replace(/[^a-z]+/g, '-')}${ma ? `-${ma.toLowerCase()}` : ''}`}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <b className="grow">{title}{ma ? ` · ${ma}` : ''}</b>
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
      {note && <div className="dim" style={{ fontSize: 12.5 }}>{note}</div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5, color: 'var(--muted)', flex: '1 1 220px' }}>
          {t('profile.submitRef')}
          <input value={ref} onChange={(e) => { setRef(e.target.value); markDirty(); }} placeholder={testProvider ? 'TEST-VERIFIED-…' : ''} />
        </label>
        <button className="primary" disabled={busy || !ref.trim()} onClick={submit}>{t('profile.submit')}</button>
      </div>
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
      <p className="pagehint">{p?.honest ?? t('profile.declaredNote')}</p>
      <ErrorLine error={prof.error} onRetry={prof.reload} />
      {prof.loading && !prof.data && <Loading />}
      {prof.data && (
        <>
          {!p && !canWrite && <div className="notice">{t('profile.none')}</div>}
          {(p || canWrite) && (
            <Section title={p ? t('profile.title') : t('profile.create')}>
              <div className="form-grid" data-testid="profile-form">
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
              <div className="dim" style={{ fontSize: 12.5, marginBottom: 8 }}>{t('profile.declaredNote')} {p?.facets.fifa_licence?.state === 'VERIFIED' ? t('profile.resetWarning') : ''}</div>
              {conflict ? <ConflictNotice conflict={conflict} onReload={() => { setErr(null); prof.reload(); }} /> : <ErrorLine error={err} />}
              {canWrite && <button className="primary" disabled={busy || !name.trim()} onClick={save} data-testid="profile-save">{p ? t('common.save') : t('profile.create')}</button>}
            </Section>
          )}
          {p && (
            <>
              <Section title={t('profile.facets')}>
                <div className="notice" style={{ marginBottom: 10 }} data-testid="provider-note">{testProvider ? t('profile.testProvider') : t('profile.noProvider')}</div>
                <div className="list-rows">
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
              </Section>
              <Section title={t('profile.regulated')}>
                <div className="list-rows" data-testid="regulatory-state">
                  <div className="list-row"><span className="grow">FIFA · INT</span>{p.regulatoryState.fifaLicence === 'VERIFIED' ? <span className="pill green">{t('profile.regulated')}</span> : <span className="pill red">{t('profile.notRegulated')}</span>}</div>
                  {p.regulatoryState.jurisdictions.map((j) => (
                    <div key={j.memberAssociation} className="list-row">
                      <span className="grow">{j.memberAssociation} · <StatePill state={j.nationalRegistration} /></span>
                      {j.regulatedActionsPermitted ? <span className="pill green">{t('profile.regulated')}</span> : <span className="pill red">{t('profile.notRegulated')}</span>}
                    </div>
                  ))}
                </div>
              </Section>
              <Section title={t('profile.history')}>
                <div className="list-rows">
                  {p.history.slice().reverse().slice(0, 12).map((h) => (
                    <div key={h.id} className="list-row"><span className="grow">{h.action.replace(/_/g, ' ')}{h.detail?.facet ? ` · ${String(h.detail.facet)}${h.detail.memberAssociation ? ` (${String(h.detail.memberAssociation)})` : ''}` : ''}{h.detail?.to ? ` → ${String(h.detail.to)}` : ''}</span><span className="dim">{fmtStamp(h.at)}</span></div>
                  ))}
                </div>
              </Section>
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
          <div key={r.id} className="list-row" data-testid={`client-row-${r.id}`}>
            <span className="grow">
              <b>{r.client?.name ?? (r.client?.removed ? '—' : r.clientId)}</b>
              <span className="dim" style={{ marginLeft: 8 }}>{scopeLabel(r.scope)}{r.termMonths ? ` · ${r.termMonths} mo` : ''}{r.jurisdiction ? ` · ${r.jurisdiction}` : ''}</span>
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
              <div key={r.id} className="list-row"><span className="grow"><b>{r.client.name ?? r.clientId}</b>{r.legacy ? <span className="pill" style={{ marginLeft: 8 }}>legacy</span> : null}</span><StatusPill status={r.status} /><button onClick={() => onOpen(r.id)}>{t('clients.open')}</button></div>
            ))}
          </div>
        </Section>
      )}
      {rows.length === 0 && <div className="notice">{t('clients.empty')}</div>}
    </>
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
  const trials = useLoad(() => (det && det.mode === 'own' && det.access && tab === 'trials' ? agent.clientTrials(session, id) : Promise.resolve(null)), [session, id, det?.access, tab, tick]);
  // M23 P6. Loaded only on its tab; the server answers 403 when the mandate, scope or licence does not hold NOW, and that answer is rendered.
  const offers = useLoad(() => (det && det.mode === 'own' && det.access && tab === 'offers' ? agent.clientOffers(session, id) : Promise.resolve(null)), [session, id, det?.access, tab, tick]);
  const shares = useLoad(() => (det && det.mode === 'own' && det.access ? agent.clientShares(session, id) : Promise.resolve(null)), [session, id, det?.access, tick]);
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
  const labelFor = (x: ClientTab) => tr(`clients.tab.${x}`);
  return (
    <div data-testid="client-detail" data-status={r.status}>
      <button onClick={onBack}>← {t('clients.back')}</button>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '12px 0 6px' }}>
        <h3 style={{ margin: 0 }}>{c.name ?? (c.removed ? '—' : r.clientId)}</h3>
        <StatusPill status={r.status} />
        {r.shareWithAgencyStaff && <span className="pill">{t('clients.sharing')}</span>}
      </div>
      <div className={`notice ${det.access ? '' : 'warn'}`} data-testid="access-line" data-access={det.access ? 'active' : 'none'}>{accessLine(r, det.access)}</div>
      {r.status === 'disputed' && <div className="notice block" style={{ marginTop: 8 }} data-testid="disputed-note">{t('clients.disputedNote')}</div>}
      {r.status === 'expired' && <div className="notice warn" style={{ marginTop: 8 }}>{t('clients.expiredNote')}</div>}
      <div style={{ marginTop: 12 }}>
        <Tabs tabs={CLIENT_TABS} active={tab} onChange={onTab} label={t('clients.title')} labelFor={labelFor} />
        {tab === 'overview' && (
          <Panel id="overview" label={labelFor('overview')}>
            <Section title={t('clients.identity')}>
              <div className="stat-grid">
                <Stat v={c.position ?? '—'} k="Position" />
                <Stat v={c.age ?? '—'} k="Age" />
                <Stat v={c.club ?? '—'} k="Club" />
                <Stat v={c.country ?? '—'} k="Country" />
              </div>
            </Section>
            {det.access && (
              <Section title={t('clients.profileFields')}>
                <div className="dim" style={{ fontSize: 12.5 }}>{Object.keys(c).filter((k) => !['id', 'name', 'accessBasis'].includes(k) && c[k] !== null && typeof c[k] !== 'object').map((k) => `${k}: ${String(c[k])}`).join(' · ')}</div>
              </Section>
            )}
          </Panel>
        )}
        {tab === 'representation' && (
          <Panel id="representation" label={labelFor('representation')}>
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
            <div className="dim" style={{ fontSize: 12.5, marginTop: 8 }}>{r.honest}</div>
            {conflict ? <ConflictNotice conflict={conflict} onReload={() => { setErr(null); d.reload(); }} /> : <ErrorLine error={err} />}
            {(r.status === 'proposed' || r.status === 'active') && !r.legacy && (
              <div style={{ marginTop: 10 }}><button disabled={busy} onClick={end} data-testid="terminate">{r.status === 'proposed' ? t('clients.withdraw') : t('clients.terminate')}</button></div>
            )}
          </Panel>
        )}
        {tab === 'opportunities' && (
          <Panel id="opportunities" label={labelFor('opportunities')}>
            {!det.access && <div className="notice warn" data-testid="opps-no-access">{t('clients.noAccessOpps')}</div>}
            {det.access && (
              <>
                <p className="pagehint">{opps.data?.note ?? t('clients.oppsNote')}</p>
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
          </Panel>
        )}
        {tab === 'contacts' && (
          <Panel id="contacts" label={labelFor('contacts')}>
            {!det.access && <div className="notice warn" data-testid="contacts-no-access">{t('clients.noAccessOpps')}</div>}
            {det.access && (
              <>
                <p className="pagehint">{contacts.data?.note ?? t('contacts.intro')}</p>
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
          </Panel>
        )}
        {tab === 'trials' && (
          <Panel id="trials" label={labelFor('trials')}>
            {!det.access && <div className="notice warn" data-testid="trials-no-access">{t('clients.noAccessOpps')}</div>}
            {det.access && (
              <>
                <p className="pagehint">{trials.data?.note ?? t('trials.intro')}</p>
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
                          {fmtStamp(ss.startsAt)} → {new Date(ss.endsAt).toLocaleTimeString()} · {ss.venue?.name ?? '—'}{ss.venue?.town ? `, ${ss.venue.town}` : ''} · {tr(`attendance.${ss.attendance.state}`) === `attendance.${ss.attendance.state}` ? ss.attendance.state.replace(/_/g, ' ') : tr(`attendance.${ss.attendance.state}`)}
                        </div>
                      ))}
                      {x.reportObligation && <div className="dim" style={{ fontSize: 12 }}>{t(x.reportObligation === 'outstanding' ? 'trials.reportOutstanding' : 'trials.reportFiled')}</div>}
                    </div>
                  ))}
                </div>
                <p className="dim" style={{ fontSize: 12.5 }}>{trials.data?.honest ?? t('trials.honest')}</p>
              </>
            )}
          </Panel>
        )}
        {tab === 'offers' && (
          <Panel id="offers" label={labelFor('offers')}>
            {!det.access && <div className="notice warn" data-testid="offers-no-access">{t('clients.noAccessOpps')}</div>}
            {det.access && (
              <>
                <p className="pagehint">{t('offers.intro')}</p>
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
          </Panel>
        )}
        {tab === 'activity' && (
          <Panel id="activity" label={labelFor('activity')}>
            <div className="list-rows" data-testid="client-activity">
              {r.history.slice().reverse().map((h) => (
                <div key={h.id} className="list-row"><span className="grow">{tr(`action.${h.action}`) === `action.${h.action}` ? h.action.replace(/_/g, ' ') : tr(`action.${h.action}`)}{h.byName ? ` · ${h.byName}` : ''}</span><span className="dim">{fmtStamp(h.at)}</span></div>
              ))}
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}

export function ClientsScreen({ session, tick, notify, me, clientId, clientTab, onOpenClient, onClientTab, onCloseClient }: ScreenProps & { me: Me | null; clientId: string | null; clientTab: ClientTab; onOpenClient: (id: string) => void; onClientTab: (t: ClientTab) => void; onCloseClient: () => void }) {
  const list = useLoad(() => agent.clients(session), [session, tick]);
  const [showForm, setShowForm] = useState(false);
  const canRequest = !!me?.capabilities.includes('clients.request');
  if (clientId) return <ClientDetailView session={session} id={clientId} tab={clientTab} onTab={onClientTab} onBack={onCloseClient} notify={notify} tick={tick} />;
  return (
    <div data-testid="agent-clients">
      <p className="pagehint">{t('clients.intro')}</p>
      {canRequest && !showForm && <div style={{ marginBottom: 12 }}><button className="primary" onClick={() => setShowForm(true)} data-testid="open-request">{t('clients.request')}</button></div>}
      {canRequest && showForm && <div style={{ marginBottom: 14 }}><RequestForm session={session} notify={notify} onDone={() => { setShowForm(false); list.reload(); }} /></div>}
      <ErrorLine error={list.error} onRetry={list.reload} />
      {list.loading && !list.data && <Loading />}
      {list.data && <ClientList rows={list.data.items} onOpen={onOpenClient} />}
    </div>
  );
}

// ============================================================ Opportunities
function OppRow({ o }: { o: Opportunity }) {
  return (
    <div className="list-row" data-testid={`opp-${o.id}`}>
      <span className="grow"><b>{o.title}</b> <span className="dim">· {o.orgName} · {o.type.replace(/_/g, ' ')}{o.category ? ` · ${o.category}` : ''}{o.distance ? ` · ${o.distance}` : ''}</span>{o.clientName ? <span className="dim"> · {t('opps.client')}: {o.clientName}</span> : null}</span>
      <span className="dim">{t('opps.deadline')} {o.deadline}</span>
      {o.applied ? <span className="pill green">applied</span> : null}
    </div>
  );
}
export function OpportunitiesScreen({ session, tick, me }: ScreenProps & { me: Me | null }) {
  const licensed = !!me?.capabilities.includes('clients.opportunities.read');
  const data = useLoad(() => (licensed ? agent.opportunities(session) : Promise.resolve(null)), [session, tick, licensed]);
  return (
    <div data-testid="agent-opportunities">
      <p className="pagehint">{t('opps.intro')}</p>
      {!licensed && <div className="notice warn">{t('opps.notLicensed')}</div>}
      <ErrorLine error={data.error} onRetry={data.reload} />
      {licensed && data.loading && !data.data && <Loading />}
      {data.data && data.data.items.length === 0 && <div className="notice">{t('opps.empty')}</div>}
      <div className="list-rows">{(data.data?.items ?? []).map((o) => <OppRow key={`${o.clientId}-${o.id}`} o={o} />)}</div>
    </div>
  );
}

// ============================================================ Inbox
export function InboxScreen({ session, tick, notify, onOpenClient }: ScreenProps & { onOpenClient: (id: string) => void }) {
  const data = useLoad(() => agent.inbox(session), [session, tick]);
  const markRead = async () => { try { await api.markNotificationsRead(session); data.reload(); } catch (e) { notify(httpState(e).message, true); } };
  return (
    <div data-testid="agent-inbox">
      <p className="pagehint">{t('inbox.intro')}</p>
      <ErrorLine error={data.error} onRetry={data.reload} />
      {data.loading && !data.data && <Loading />}
      {data.data && (
        <>
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
                <div key={n.id} className="list-row" style={{ opacity: n.read ? 0.7 : 1 }} data-type={n.type}>
                  <span className="grow">{n.text}{(n.repeatCount ?? 1) > 1 && <span className="pill" style={{ marginLeft: 6 }}>×{n.repeatCount}</span>}</span>
                  {n.refId && /^rep-/.test(n.refId) && <button onClick={() => onOpenClient(n.refId!)}>{t('common.open')}</button>}
                  <span className="dim">{fmtStamp(n.ts)}</span>
                </div>
              ))}
            </div>
          </Section>
        </>
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
      <p className="pagehint">{t('agency.teamIntro')}</p>
      {!canWrite && <div className="dim" style={{ fontSize: 12.5, marginBottom: 8 }}>{t('agency.readOnly')}</div>}
      {conflict ? <ConflictNotice conflict={conflict} onReload={() => { setErr(null); team.reload(); }} /> : <ErrorLine error={err} />}
      <ErrorLine error={team.error} onRetry={team.reload} />
      {team.data && (
        <div className="list-rows" data-testid="team-rows">
          {team.data.members.map((m) => (
            <div key={m.affiliationId} className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }} data-testid={`member-${m.userId}`} data-active={m.active ? '1' : '0'}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="grow"><b>{m.name}</b> <span className="dim">· {m.role}{!m.active ? ` · ${t('agency.ended')}${m.endedAt ? ` ${fmtDate(m.endedAt)}` : ''}` : ''}</span></span>
                {m.licensed ? <StatePill state={m.fifaLicence ?? 'UNVERIFIED'} /> : <span className="pill">{t('agency.noProfile')}</span>}
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                {TIERS.map((x) => (
                  <label key={x} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12.5, color: 'var(--muted)' }} title={tr(`tierNote.${x}`)}>
                    <input type="checkbox" checked={(edits[m.userId] ?? m.tiers).includes(x)} disabled={!canWrite || !m.active} onChange={() => setEdits((c) => ({ ...c, [m.userId]: toggle(c[m.userId] ?? m.tiers, x) }))} /> {tr(`tier.${x}`)}
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
      <p className="pagehint">{t('agency.complianceIntro')}</p>
      <ErrorLine error={data.error} onRetry={data.reload} />
      {data.data && (
        <>
          <div className="notice" style={{ marginBottom: 10 }} data-testid="compliance-honest">{data.data.honest}</div>
          <div className="list-rows" data-testid="compliance-rows">
            {data.data.agents.map((a: ComplianceRow) => (
              <div key={a.userId} className="list-row"><span className="grow"><b>{a.name}</b>{!a.hasProfile && <span className="dim"> · {t('agency.noProfile')}</span>}{a.jurisdictions.map((j) => <span key={j.memberAssociation} className="dim"> · {j.memberAssociation}: <StatePill state={j.nationalRegistration} /></span>)}</span><StatePill state={a.fifaLicence} /></div>
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
      <p className="pagehint">{t('agency.settingsIntro')}</p>
      <div className="form-grid" data-testid="agency-settings">
        <label>{t('agency.description')}<input value={desc} onChange={(e) => { setDesc(e.target.value); markDirty(); }} disabled={!canWrite} /></label>
        <div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 4 }}>{t('agency.jurisdictions')}</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{JURISDICTIONS.map((j) => <label key={j} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><input type="checkbox" checked={juris.includes(j)} disabled={!canWrite} onChange={() => { setJuris((c) => (c.includes(j) ? c.filter((x) => x !== j) : [...c, j])); markDirty(); }} /> {j}</label>)}</div>
        </div>
      </div>
      <ErrorLine error={err} />
      {canWrite ? <button className="primary" onClick={save}>{t('common.save')}</button> : <div className="dim" style={{ fontSize: 12.5 }}>{t('agency.readOnly')}</div>}
      {canAudit && (
        <Section title={t('agency.audit')}>
          <p className="pagehint">{t('agency.auditIntro')}</p>
          <ErrorLine error={auditErr} />
          <div className="list-rows" data-testid="audit-rows">
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
      <p className="pagehint">{o?.honest ?? t('agency.honest')}</p>
      <Tabs tabs={tabs} active={tab} onChange={onTab} label={t('agency.title')} labelFor={labelFor} />
      {tab === 'overview' && (
        <Panel id="overview" label={labelFor('overview')}>
          <ErrorLine error={ov.error} onRetry={ov.reload} />
          {ov.loading && !o && <Loading />}
          {o && (
            <>
              <h3 style={{ margin: '0 0 10px' }}>{o.org.name}</h3>
              <div className="stat-grid" data-testid="agency-stats">
                <Stat v={o.members.active} k={t('agency.members')} />
                <Stat v={o.members.admins} k={t('agency.admins')} />
                <Stat v={o.members.licensedAgents} k={t('agency.licensed')} />
                <Stat v={o.relationships.active} k={t('agency.relActive')} />
                <Stat v={o.relationships.pending} k={t('agency.relPending')} />
                <Stat v={o.relationships.legacy} k={t('agency.relLegacy')} />
              </div>
              <Section title={t('agency.roles')}>
                <div className="list-rows">{o.tiers.map((x) => <div key={x} className="list-row"><span className="grow"><b>{tr(`tier.${x}`)}</b> <span className="dim">· {tr(`tierNote.${x}`)}</span></span><span className="dim">{(Object.entries(o.permissions).filter(([, v]) => v.includes(x)).map(([k]) => k)).length} caps</span></div>)}</div>
              </Section>
            </>
          )}
        </Panel>
      )}
      {tab === 'team' && <Panel id="team" label={labelFor('team')}><TeamTab session={session} tick={tick} notify={notify} me={me} /></Panel>}
      {tab === 'compliance' && canCompliance && <Panel id="compliance" label={labelFor('compliance')}><ComplianceTab session={session} tick={tick} notify={notify} /></Panel>}
      {tab === 'settings' && <Panel id="settings" label={labelFor('settings')}><SettingsTab session={session} tick={tick} notify={notify} me={me} overview={o} /></Panel>}
    </div>
  );
}

// ============================================================ Report / Block
export function SafetyModal({ session, notify, onClose }: { session: Session; notify: ScreenProps['notify']; onClose: () => void }) {
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
      <div className="drawer" role="dialog" aria-modal="true" aria-label={t('report.title')} style={{ width: 'min(520px, 92vw)' }}>
        <div className="head"><h3>{t('report.title')}</h3><button className="close" onClick={onClose} aria-label={t('common.close')}>✕</button></div>
        <p className="pagehint">{t('report.body')}</p>
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
