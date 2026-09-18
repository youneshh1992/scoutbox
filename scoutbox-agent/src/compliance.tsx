// ScoutBox Agent — Compliance (M23 P5.6C). The agent's own regulatory
// standing, the jurisdiction policy versions in effect, attributed review
// items, minimal compliance contexts with their conflict clearance, and the
// party-specific consent ledger.
//
// Every verdict on this screen is the server's. Nothing here derives an
// outcome, a rule status or a consent's sufficiency; a refusal is shown with
// the codes the server returned and the shared HTTP reading. This is NOT a
// transaction room: no offer, no terms, no fee and no negotiation exist here.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, type Session } from './api';
import {
  agent, clientKey, isSummary, JURISDICTIONS, CONTEXT_TYPES, PARTY_ROLES,
  type AgentConsent, type Clearance, type ClubHit, type ComplianceContext, type ComplianceOverview, type ContextType, type Facet, type FacetFreshness,
  type Me, type MinorReadiness, type PartyRole, type Reason, type Relationship, type ReviewPublic,
} from './agentApi';
import { httpState } from './httpState';
import { conflictOf, ConflictNotice } from './conflict';
import { fmtDate, fmtStamp, t } from './i18n';
import { markClean, markDirty, StatePill, type ScreenProps } from './screens';

type TKey = Parameters<typeof t>[0];
const tr = (k: string, fallback?: string) => t(k as TKey, fallback);

// ------------------------------------------------------------ shared bits
function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
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
  return { data, error, loading, reload: () => setN((x) => x + 1) };
}
const Loading = () => <div className="notice" role="status" aria-live="polite">{t('common.loading')}</div>;
const Section = ({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) => <div className="section" data-testid={testId}><h4>{title}</h4>{children}</div>;
const Stat = ({ v, k, testId }: { v: ReactNode; k: string; testId?: string }) => <div className="stat" data-testid={testId}><div className="v">{v}</div><div className="k">{k}</div></div>;

/** A reason row: code · rule id · the rule's OPERATIVE status · policy version. Never prose. */
function ReasonRow({ r }: { r: Reason }) {
  return (
    <div className="list-row" data-testid="reason" data-code={r.code} data-rule-status={r.ruleStatus ?? ''}>
      <span className="grow"><b>{tr(`reason.${r.code}`, r.code.replace(/_/g, ' '))}</b>{r.ruleId ? <span className="dim"> · {r.ruleId}{r.overrideRuleId ? ` → ${r.overrideRuleId}` : ''}</span> : null}{r.partyRoles?.length ? <span className="dim"> · {r.partyRoles.map((x) => tr(`party.${x}`)).join(' + ')}</span> : null}</span>
      {r.ruleStatus && <span className={`pill ${r.ruleStatus === 'ACTIVE' ? 'green' : r.ruleStatus === 'JURISDICTION_OVERRIDE' ? 'blue' : 'gold'}`} data-testid="rule-status">{tr(`ruleStatus.${r.ruleStatus}`)}</span>}
      {r.policyVersion && <span className="dim">{r.policyVersion}</span>}
    </div>
  );
}

const outcomeClass = (o: string) => (o === 'CLEAR' ? 'green' : o === 'PROHIBITED_CONFLICT' ? 'red' : o === 'PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED' ? 'blue' : 'gold');
export function OutcomePill({ outcome }: { outcome: string }) {
  return <span className={`pill ${outcomeClass(outcome)}`} data-testid="outcome" data-outcome={outcome}>{tr(`outcome.${outcome}`, outcome)}</span>;
}

/** The server's refusal, with the codes it carried: reasons, outstanding consents, a review id. Never the raw status. */
function Refusal({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  const s = httpState(error);
  const d = error instanceof ApiError ? error.details ?? {} : {};
  const reasons = Array.isArray(d.reasons) ? (d.reasons as Reason[]) : [];
  const outstanding = Array.isArray(d.consentsOutstanding) ? (d.consentsOutstanding as { partyRole: string; reasonCode: string }[]) : [];
  return (
    <div className="notice block" role="alert" data-http-kind={s.kind} data-code={s.code ?? ''} data-testid="refusal">
      <div>{s.message}</div>
      {typeof d.reviewId === 'string' && <div className="dim" style={{ marginTop: 4 }}>{t('cx.reviewRaised')} <code>{d.reviewId}</code></div>}
      {reasons.length > 0 && <div className="list-rows" style={{ marginTop: 6 }}>{reasons.map((r, i) => <ReasonRow key={`${r.code}-${i}`} r={r} />)}</div>}
      {outstanding.length > 0 && <div className="dim" style={{ marginTop: 4 }}>{t('cx.outstanding')}: {outstanding.map((o) => `${tr(`party.${o.partyRole}`)} (${tr(`consentReason.${o.reasonCode}`, o.reasonCode)})`).join(', ')}</div>}
      {s.retryable && onRetry && <div style={{ marginTop: 6 }}><button onClick={onRetry}>{t('common.retry')}</button></div>}
    </div>
  );
}

// ------------------------------------------------------------ pieces
function ClearanceBox({ c, onEvaluate, busy }: { c: Clearance | null; onEvaluate?: () => void; busy?: boolean }) {
  if (!c) return <div className="notice">{t('cx.noEvaluation')}</div>;
  return (
    <div className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }} data-testid="clearance" data-current={c.current ? '1' : '0'}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <OutcomePill outcome={c.outcome} />
        {!c.current && <span className="pill gold" data-testid="stale-clearance">{t('cx.reEvaluationPending')}</span>}
        <span className="dim">{t('cx.evaluatedAt')} {fmtStamp(c.evaluatedAt)} · {c.policyVersions.join(', ')}</span>
        {onEvaluate && <button disabled={busy} onClick={onEvaluate} data-testid="evaluate">{t('cx.evaluate')}</button>}
      </div>
      <div className="dim" style={{ fontSize: 12.5 }}>{tr(`outcomeNote.${c.outcome}`)}</div>
      {c.reasons.length > 0 && <div className="list-rows">{c.reasons.map((r, i) => <ReasonRow key={`${r.code}-${i}`} r={r} />)}</div>}
      {c.consentsOutstanding.length > 0 && (
        <div className="notice warn" data-testid="consents-outstanding">{t('cx.outstanding')}: {c.consentsOutstanding.map((o) => `${tr(`party.${o.partyRole}`)} — ${tr(`consentReason.${o.reasonCode}`, o.reasonCode)}`).join(' · ')}</div>
      )}
    </div>
  );
}

function ReviewRow({ r, onOpenContext }: { r: ReviewPublic; onOpenContext?: (id: string) => void }) {
  const ctx = typeof r.subject?.contextId === 'string' ? (r.subject.contextId as string) : null;
  const cls = r.status === 'APPROVED' ? 'green' : r.status === 'REJECTED' ? 'red' : r.status === 'PENDING' || r.status === 'IN_REVIEW' ? 'gold' : '';
  return (
    <div className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }} data-testid={`review-${r.id}`} data-status={r.status}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="grow"><b>{tr(`reviewKind.${r.kind}`, r.kind)}</b>{typeof r.subject?.facet === 'string' ? <span className="dim"> · {tr(`facet.${String(r.subject.facet)}`)}{r.subject.memberAssociation ? ` (${String(r.subject.memberAssociation)})` : ''}</span> : null}</span>
        <span className={`pill ${cls}`}>{tr(`reviewStatus.${r.status}`, r.status)}</span>
        <span className="dim">{fmtStamp(r.requestedAt)}</span>
        {ctx && onOpenContext && <button onClick={() => onOpenContext(ctx)}>{t('common.open')}</button>}
      </div>
      {r.reasons.length > 0 && <div className="dim" style={{ fontSize: 12.5 }}>{r.reasons.map((x) => `${tr(`reason.${x.code}`, x.code)}${x.ruleId ? ` (${x.ruleId}: ${tr(`ruleStatus.${x.ruleStatus ?? 'UNKNOWN'}`)})` : ''}`).join(' · ')}</div>}
      {r.decision && <div className="dim" style={{ fontSize: 12.5 }} data-testid="review-decision">{t('cx.decidedBy')} {tr(`reviewerRole.${r.decision.reviewer.role}`, r.decision.reviewer.role)} · {tr(`reviewDecision.${r.decision.outcome}`, r.decision.outcome)} · {t('cx.evidenceCount').replace('{n}', String(r.decision.evidenceCount))}</div>}
      {!r.decision && (r.status === 'PENDING' || r.status === 'IN_REVIEW') && <div className="dim" style={{ fontSize: 12.5 }}>{t('cx.awaitingReviewer')}</div>}
    </div>
  );
}

function ConsentRow({ k, onOpenContext }: { k: AgentConsent; onOpenContext?: (id: string) => void }) {
  const cls = k.status === 'granted' ? 'green' : k.status === 'requested' ? 'blue' : k.status === 'declined' || k.status === 'revoked' ? 'red' : '';
  return (
    <div className="list-row" data-testid={`consent-${k.id}`} data-status={k.status}>
      <span className="grow"><b>{tr(`party.${k.partyRole ?? ''}`, k.partyRole ?? '')}</b> <span className="dim">· {t('cx.consentKind')} · {k.policyVersions.join(', ')}{k.ruleIds.length ? ` · ${k.ruleIds.join(', ')}` : ''}</span></span>
      <span className={`pill ${cls}`}>{tr(`consentStatus.${k.status}`, k.status)}</span>
      <span className="dim">{fmtStamp(k.revokedAt ?? k.declinedAt ?? k.grantedAt ?? k.requestedAt ?? 0)}</span>
      {k.contextId && onOpenContext && <button onClick={() => onOpenContext(k.contextId!)}>{t('common.open')}</button>}
    </div>
  );
}

function FreshnessRow({ f, canRecheck, onRecheck, busy }: { f: FacetFreshness; canRecheck: boolean; onRecheck: (facet: Facet, ma: string | null) => void; busy: boolean }) {
  return (
    <div className="list-row" data-testid={`freshness-${f.facet}${f.memberAssociation ? `-${f.memberAssociation}` : ''}`} data-state={f.state}>
      <span className="grow"><b>{tr(`facet.${f.facet}`)}</b>{f.memberAssociation ? <span className="dim"> · {f.memberAssociation}</span> : null}{f.provenance ? <span className="dim"> · {f.provenance.provider}</span> : null}</span>
      <StatePill state={f.state} />
      <span className="dim">{f.daysUntilRecheck === null ? '—' : f.daysUntilRecheck < 0 ? t('cx.recheckOverdue') : t('cx.recheckIn').replace('{n}', String(f.daysUntilRecheck))}</span>
      {canRecheck && <button disabled={busy} onClick={() => onRecheck(f.facet, f.memberAssociation)} data-testid="recheck">{t('cx.recheck')}</button>}
    </div>
  );
}

function MinorReadinessRow({ m }: { m: MinorReadiness }) {
  return (
    <div className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }} data-testid={`minor-readiness-${m.memberAssociation}`} data-pathway={m.pathwayEnabledInProduction ? 'live' : 'closed'}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="grow"><b>{m.memberAssociation}</b>{m.timingRule ? <span className="dim"> · {m.timingRule.ruleId} · {tr(`ruleStatus.${m.timingRule.ruleStatus}`)}{m.timingEncoded ? '' : ` · ${t('cx.timingNotEncoded')}`}</span> : null}</span>
        <span className={`pill ${m.pathwayEnabledInProduction ? 'green' : 'red'}`}>{m.pathwayEnabledInProduction ? t('cx.pathwayLive') : t('cx.pathwayClosed')}</span>
        <span className={`pill ${m.agentReady ? 'green' : 'gold'}`}>{m.agentReady ? t('cx.agentReady') : t('cx.agentNotReady')}</span>
      </div>
      {m.gaps.length > 0 && <div className="dim" style={{ fontSize: 12.5 }}>{t('cx.gaps')}: {m.gaps.map((g) => `${tr(`facet.${g.facet}`)}${g.memberAssociation ? ` (${g.memberAssociation})` : ''}: ${tr(`state.${g.state}`)}`).join(' · ')}</div>}
      <div className="dim" style={{ fontSize: 12.5 }}>{m.honest}</div>
    </div>
  );
}

// ------------------------------------------------------------ new context
function NewContextForm({ session, notify, onCreated }: { session: Session; notify: ScreenProps['notify']; onCreated: (id: string) => void }) {
  const clients = useLoad(() => agent.clients(session), [session]);
  const clubs = useLoad(() => agent.clubs(session), [session]);
  const [type, setType] = useState<ContextType>('employment_contract');
  const [juris, setJuris] = useState<string[]>(['ENG']);
  const [individual, setIndividual] = useState('');
  const [engaging, setEngaging] = useState('');
  const [releasing, setReleasing] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const keyRef = useRef(clientKey());
  const own = useMemo(() => (clients.data?.items ?? []).filter((r): r is Relationship & { mode: 'own' } => !isSummary(r) && r.status === 'active'), [clients.data]);
  const toggleJ = (j: string) => { setJuris((cur) => (cur.includes(j) ? cur.filter((x) => x !== j) : [...cur, j])); markDirty(); };
  const submit = async () => {
    setBusy(true); setErr(null);
    const parties: { partyRole: PartyRole; subjectKind: 'player' | 'club'; subjectId: string }[] = [];
    if (individual) parties.push({ partyRole: 'individual', subjectKind: 'player', subjectId: individual });
    if (engaging) parties.push({ partyRole: 'engaging_entity', subjectKind: 'club', subjectId: engaging });
    if (releasing) parties.push({ partyRole: 'releasing_entity', subjectKind: 'club', subjectId: releasing });
    try {
      const r = await agent.createContext(session, { type, jurisdictions: juris, parties, clientKey: keyRef.current });
      keyRef.current = clientKey(); markClean(); notify(t('cx.created')); onCreated(r.context.id);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <div className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }} data-testid="new-context">
      <b>{t('cx.new')}</b>
      <div className="dim" style={{ fontSize: 12.5 }}>{t('cx.newIntro')}</div>
      <div className="form-grid">
        <label>{t('cx.type')}<select value={type} onChange={(e) => { setType(e.target.value as ContextType); markDirty(); }} data-testid="ctx-type">{CONTEXT_TYPES.map((x) => <option key={x} value={x}>{tr(`ctxType.${x}`)}</option>)}</select></label>
        <div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 4 }}>{t('cx.jurisdictions')}</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{JURISDICTIONS.map((j) => <label key={j} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><input type="checkbox" checked={juris.includes(j)} onChange={() => toggleJ(j)} /> {j}</label>)}</div>
        </div>
        <label>{t('party.individual')}
          <select value={individual} onChange={(e) => { setIndividual(e.target.value); markDirty(); }} data-testid="ctx-individual">
            <option value="">—</option>
            {own.map((r) => <option key={r.id} value={r.clientId}>{r.client?.name ?? r.clientId}</option>)}
          </select>
        </label>
        <label>{t('party.engaging_entity')}
          <select value={engaging} onChange={(e) => { setEngaging(e.target.value); markDirty(); }} data-testid="ctx-engaging">
            <option value="">—</option>
            {(clubs.data ?? []).map((c: ClubHit) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label>{t('party.releasing_entity')}
          <select value={releasing} onChange={(e) => { setReleasing(e.target.value); markDirty(); }} data-testid="ctx-releasing">
            <option value="">—</option>
            {(clubs.data ?? []).map((c: ClubHit) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      </div>
      <div className="dim" style={{ fontSize: 12 }}>{t('cx.individualNote')}</div>
      <Refusal error={err} />
      <div><button className="primary" disabled={busy || juris.length === 0 || (!individual && !engaging && !releasing)} onClick={submit} data-testid="ctx-create">{t('cx.create')}</button></div>
    </div>
  );
}

// ------------------------------------------------------------ context detail
function ContextDetail({ session, tick, notify, me, id, onBack, onOpenClient }: ScreenProps & { me: Me | null; id: string; onBack: () => void; onOpenClient: (id: string) => void }) {
  const d = useLoad(() => agent.context(session, id), [session, id, tick]);
  const clients = useLoad(() => agent.clients(session), [session, tick]);
  const c = d.data?.context ?? null;
  const canWrite = !!me?.capabilities.includes('compliance.contexts.write');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [declareRole, setDeclareRole] = useState<PartyRole | ''>('');
  const [consentRole, setConsentRole] = useState<PartyRole | ''>('');
  const [particulars, setParticulars] = useState({ fullParticularsProvided: true, legalAdviceOffered: true, proposedFeeDisclosed: true });
  const own = useMemo(() => (clients.data?.items ?? []).filter((r): r is Relationship & { mode: 'own' } => !isSummary(r)), [clients.data]);
  const run = async (fn: () => Promise<unknown>, okMsg?: string) => {
    setBusy(true); setErr(null);
    try { await fn(); if (okMsg) notify(okMsg); markClean(); d.reload(); } catch (e) { setErr(e); d.reload(); } finally { setBusy(false); }
  };
  if (d.error) return <><button onClick={onBack}>← {t('cx.back')}</button><Refusal error={d.error} onRetry={d.reload} /></>;
  if (!c) return <Loading />;
  const parties = c.parties.filter((p) => !p.removed);
  const myReps = c.representations.filter((r) => r.agentUserId === me?.user.id && r.status !== 'withdrawn');
  const declarable = parties.filter((p) => !myReps.some((r) => r.partyRole === p.partyRole));
  const agreementFor = (role: PartyRole | '') => {
    const p = parties.find((x) => x.partyRole === role);
    if (!p || p.subjectKind !== 'player') return undefined;
    return own.find((r) => r.clientId === p.subjectId && r.status === 'active')?.id;
  };
  const conflict = conflictOf(err);
  const outstanding = c.clearance?.consentsOutstanding ?? [];
  return (
    <div data-testid="context-detail" data-status={c.status} data-outcome={c.clearance?.outcome ?? ''}>
      <button onClick={onBack}>← {t('cx.back')}</button>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '12px 0 6px' }}>
        <h3 style={{ margin: 0 }}>{tr(`ctxType.${c.type}`)} · {c.jurisdictions.join(' + ')}</h3>
        <span className="pill">{tr(`scope.ctx.${c.scope}`, c.scope)}</span>
        <span className={`pill ${c.status === 'open' ? 'green' : ''}`}>{c.status === 'open' ? t('cx.open') : t('cx.closed')}</span>
        <span className="dim">{c.id}</span>
      </div>
      <div className="notice" data-testid="context-honest">{c.honest}</div>
      {conflict ? <ConflictNotice conflict={conflict} onReload={() => { setErr(null); d.reload(); }} /> : <Refusal error={err} />}

      <Section title={t('cx.clearance')} testId="clearance-section">
        <ClearanceBox c={c.clearance} onEvaluate={canWrite && c.status === 'open' ? () => run(() => agent.evaluateContext(session, c.id), t('cx.evaluated')) : undefined} busy={busy} />
      </Section>

      <Section title={t('cx.parties')} testId="parties-section">
        <div className="list-rows">
          {parties.map((p) => {
            const rep = myReps.find((r) => r.partyRole === p.partyRole);
            const rel = p.subjectKind === 'player' ? own.find((r) => r.clientId === p.subjectId) : null;
            return (
              <div key={p.id} className="list-row" data-testid={`party-${p.partyRole}`} data-represented={rep ? rep.status : 'no'}>
                <span className="grow"><b>{p.name ?? '—'}</b> <span className="dim">· {tr(`party.${p.partyRole}`)} · {p.subjectKind === 'player' ? t('cx.player') : t('cx.club')}</span></span>
                {rep ? <span className={`pill ${rep.status === 'verified' ? 'green' : 'gold'}`} data-testid="rep-status">{tr(`repStatus.${rep.status}`, rep.status)}</span> : <span className="pill">{t('cx.notRepresented')}</span>}
                {rel && <button onClick={() => onOpenClient(rel.id)}>{t('cx.openClient')}</button>}
                {rep && canWrite && c.status === 'open' && <button disabled={busy} onClick={() => run(() => agent.withdraw(session, c.id, rep.id, c.rev), t('cx.withdrawn'))} data-testid={`withdraw-${p.partyRole}`}>{t('cx.withdraw')}</button>}
              </div>
            );
          })}
        </div>
        {canWrite && c.status === 'open' && declarable.length > 0 && (
          <div className="list-row" style={{ marginTop: 10, flexDirection: 'column', alignItems: 'stretch', gap: 8 }} data-testid="declare-form">
            <b>{t('cx.declare')}</b>
            <div className="dim" style={{ fontSize: 12.5 }}>{t('cx.declareIntro')}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <select value={declareRole} onChange={(e) => setDeclareRole(e.target.value as PartyRole)} aria-label={t('cx.declareFor')} data-testid="declare-role">
                <option value="">{t('cx.declareFor')}</option>
                {declarable.map((p) => <option key={p.id} value={p.partyRole}>{tr(`party.${p.partyRole}`)} — {p.name ?? p.subjectId}</option>)}
              </select>
              {declareRole && parties.find((p) => p.partyRole === declareRole)?.subjectKind === 'player' && !agreementFor(declareRole) && <span className="dim" data-testid="no-agreement">{t('cx.noAgreement')}</span>}
              <button className="primary" disabled={busy || !declareRole || (parties.find((p) => p.partyRole === declareRole)?.subjectKind === 'player' && !agreementFor(declareRole))} onClick={() => run(() => agent.declare(session, c.id, { partyRole: declareRole as PartyRole, agreementId: agreementFor(declareRole), clientKey: clientKey(), expectedRev: c.rev }).then(() => setDeclareRole('')), t('cx.declared'))} data-testid="declare">{t('cx.declare')}</button>
            </div>
          </div>
        )}
      </Section>

      {(outstanding.length > 0 || c.status === 'open') && canWrite && c.clearance?.outcome === 'PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED' && (
        <Section title={t('cx.requestConsent')} testId="consent-request-section">
          <div className="dim" style={{ fontSize: 12.5, marginBottom: 8 }}>{t('cx.consentIntro')}</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <select value={consentRole} onChange={(e) => setConsentRole(e.target.value as PartyRole)} aria-label={t('cx.consentFrom')} data-testid="consent-role">
              <option value="">{t('cx.consentFrom')}</option>
              {outstanding.map((o) => <option key={o.partyRole} value={o.partyRole}>{tr(`party.${o.partyRole}`)} — {tr(`consentReason.${o.reasonCode}`, o.reasonCode)}</option>)}
            </select>
            {(['fullParticularsProvided', 'legalAdviceOffered', 'proposedFeeDisclosed'] as const).map((k) => (
              <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12.5, color: 'var(--muted)' }}><input type="checkbox" checked={particulars[k]} onChange={(e) => setParticulars((cur) => ({ ...cur, [k]: e.target.checked }))} /> {tr(`particulars.${k}`)}</label>
            ))}
            <button className="primary" disabled={busy || !consentRole} onClick={() => run(() => agent.requestConsent(session, c.id, { partyRole: consentRole as PartyRole, ...particulars, clientKey: clientKey() }).then(() => setConsentRole('')), t('cx.consentRequested'))} data-testid="request-consent">{t('cx.requestConsent')}</button>
          </div>
        </Section>
      )}

      <Section title={t('cx.history')}>
        <div className="list-rows" data-testid="context-history">
          {c.history.slice().reverse().map((h) => (
            <div key={h.id} className="list-row"><span className="grow">{tr(`cxAction.${h.action}`, h.action.replace(/_/g, ' '))}{h.detail?.partyRole ? ` · ${tr(`party.${String(h.detail.partyRole)}`)}` : ''}{h.detail?.outcome ? ` · ${tr(`outcome.${String(h.detail.outcome)}`, String(h.detail.outcome))}` : ''}{h.byKind === 'ts_reviewer' ? ` · ${t('cx.byReviewer')}` : ''}</span><span className="dim">{fmtStamp(h.at)}</span></div>
          ))}
        </div>
      </Section>
      {canWrite && c.status === 'open' && (
        <div style={{ marginTop: 8 }}><button disabled={busy} onClick={() => { if (window.confirm(`${t('cx.closeConfirm')}\n\n${t('cx.closeBody')}`)) void run(() => agent.closeContext(session, c.id, c.rev), t('cx.closedOk')); }} data-testid="close-context">{t('cx.close')}</button></div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ the screen
export function ComplianceScreen({ session, tick, notify, me, contextId, onOpenContext, onOpenClient }: ScreenProps & { me: Me | null; contextId: string | null; onOpenContext: (id: string | null) => void; onOpenClient: (id: string) => void }) {
  const ov = useLoad(() => agent.complianceOverview(session), [session, tick]);
  const o = ov.data as ComplianceOverview | null;
  const canWrite = !!me?.capabilities.includes('compliance.contexts.write');
  const [showNew, setShowNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  if (contextId) return <ContextDetail session={session} tick={tick} notify={notify} me={me} id={contextId} onBack={() => onOpenContext(null)} onOpenClient={onOpenClient} />;
  const recheck = async (facet: Facet, ma: string | null) => {
    setBusy(true); setErr(null);
    try { const r = await agent.recheckFacet(session, facet, ma ?? undefined); notify(`${t('cx.rechecked')} ${tr(`state.${r.facet.state}`)}`); ov.reload(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <div data-testid="agent-compliance">
      <p className="pagehint">{o?.honest ?? t('cx.intro')}</p>
      <Refusal error={ov.error} onRetry={ov.reload} />
      {ov.loading && !o && <Loading />}
      {o && (
        <>
          <div className="stat-grid" style={{ marginBottom: 14 }} data-testid="compliance-counts">
            <Stat v={o.counts.contextsOpen} k={t('cx.openContexts')} testId="count-contexts" />
            <Stat v={o.counts.consentsOutstanding} k={t('cx.consentsOutstanding')} testId="count-consents" />
            <Stat v={o.counts.reviewsPending} k={t('cx.reviewsPending')} testId="count-reviews" />
            <Stat v={o.counts.staleFacets} k={t('cx.staleFacets')} testId="count-stale" />
          </div>
          <div className={`notice ${o.provider.live ? '' : 'warn'}`} data-testid="provider-status" data-live={o.provider.live ? '1' : '0'}>
            <b>{t('cx.provider')}:</b> {o.provider.provider} · {o.provider.live ? t('cx.providerLive') : t('cx.providerNotLive')} · {o.provider.note}
          </div>
          <Refusal error={err} />

          <Section title={t('cx.policies')} testId="policies-section">
            <div className="list-rows">
              {o.policies.inEffect.map((p) => <div key={p.id} className="list-row" data-testid={`policy-${p.id}`}><span className="grow"><b>{p.id}</b> <span className="dim">· {p.regulator} · {p.jurisdiction}</span></span><span className="dim">{t('cx.effectiveFrom')} {p.effectiveFrom}</span></div>)}
              {o.policies.missing.length > 0 && <div className="notice warn" data-testid="policies-missing">{t('cx.policiesMissing')}: {o.policies.missing.join(', ')}</div>}
            </div>
            <div className="dim" style={{ fontSize: 12.5, marginTop: 6 }}>{t('cx.policiesNote')}</div>
          </Section>

          <Section title={t('cx.freshness')} testId="freshness-section">
            {!o.facets && <div className="notice">{t('cx.noProfile')}</div>}
            <div className="list-rows">{o.freshness.map((f) => <FreshnessRow key={`${f.facet}-${f.memberAssociation ?? ''}`} f={f} canRecheck={canWrite} onRecheck={recheck} busy={busy} />)}</div>
          </Section>

          <Section title={t('cx.contexts')} testId="contexts-section">
            <div className="dim" style={{ fontSize: 12.5, marginBottom: 8 }}>{t('cx.contextsIntro')}</div>
            {canWrite && !showNew && <div style={{ marginBottom: 10 }}><button className="primary" onClick={() => setShowNew(true)} data-testid="open-new-context">{t('cx.new')}</button></div>}
            {canWrite && showNew && <div style={{ marginBottom: 12 }}><NewContextForm session={session} notify={notify} onCreated={(id) => { setShowNew(false); onOpenContext(id); }} /></div>}
            <div className="list-rows" data-testid="context-rows">
              {o.contexts.map((c: ComplianceContext) => (
                <div key={c.id} className="list-row" data-testid={`context-${c.id}`} data-status={c.status}>
                  <span className="grow"><b>{tr(`ctxType.${c.type}`)}</b> <span className="dim">· {c.jurisdictions.join(' + ')} · {c.parties.filter((p) => !p.removed).map((p) => p.name ?? '—').join(', ')}</span></span>
                  {c.clearance && <OutcomePill outcome={c.clearance.outcome} />}
                  {c.reEvaluationPending && <span className="pill gold">{t('cx.reEvaluationPending')}</span>}
                  {c.status === 'closed' && <span className="pill">{t('cx.closed')}</span>}
                  <button onClick={() => onOpenContext(c.id)}>{t('common.open')}</button>
                </div>
              ))}
              {o.contexts.length === 0 && <div className="notice">{t('cx.noContexts')}</div>}
            </div>
          </Section>

          <Section title={t('cx.consents')} testId="consents-section">
            <div className="list-rows">
              {o.consents.map((k) => <ConsentRow key={k.id} k={k} onOpenContext={onOpenContext} />)}
              {o.consents.length === 0 && <div className="notice">{t('cx.noConsents')}</div>}
            </div>
            <div className="dim" style={{ fontSize: 12.5, marginTop: 6 }}>{t('cx.consentsNote')}</div>
          </Section>

          <Section title={t('cx.reviews')} testId="reviews-section">
            <div className="list-rows">
              {o.reviews.map((r) => <ReviewRow key={r.id} r={r} onOpenContext={onOpenContext} />)}
              {o.reviews.length === 0 && <div className="notice">{t('cx.noReviews')}</div>}
            </div>
            <div className="dim" style={{ fontSize: 12.5, marginTop: 6 }}>{t('cx.reviewsNote')}</div>
          </Section>

          <Section title={t('cx.minors')} testId="minors-section">
            <div className="notice warn" style={{ marginBottom: 8 }} data-testid="minors-closed">{t('cx.minorsNote')}</div>
            <div className="list-rows">{o.minorReadiness.map((m) => <MinorReadinessRow key={m.memberAssociation} m={m} />)}</div>
          </Section>
        </>
      )}
    </div>
  );
}

// PARTY_ROLES is re-exported for the demo builder; unused here beyond typing.
export { PARTY_ROLES };
