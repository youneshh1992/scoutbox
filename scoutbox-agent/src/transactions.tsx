// ScoutBox Agent — Transactions (M23 P5.6D). The multi-party workspace: the
// parties and their confirmations, the representation bindings, the compliance
// snapshot with its staleness, the consent view, classified documents, scoped
// notes, linked correspondence and the audience-filtered timeline.
//
// Every verdict on this screen is the server's. Nothing here derives a status,
// an outcome or a visibility; a refusal is shown with the codes the server
// returned. Two things this screen is careful never to say: that a transaction
// is approved, and that anything has been agreed or signed. "Ready" means
// ScoutBox currently permits the workflow to proceed under the encoded rules —
// and the screen prints that sentence rather than implying it.
//
// There is no offer here and no way to make one: the offer seam is a readiness
// boolean with its blockers, shown read-only.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, type Session } from './api';
import {
  agent, clientKey, isSummary, JURISDICTIONS, TRANSACTION_TYPES, TRANSACTION_STATUSES, DOCUMENT_TYPES,
  type ClubHit, type DocumentType, type DocumentVisibility, type Me, type PartyRole, type Reason,
  type Transaction, type TransactionList, type TransactionStatus, type TransactionType, type TxDocument, type TxTimelineEntry,
} from './agentApi';
import { httpState } from './httpState';
import { fmtDate, fmtStamp, t } from './i18n';
import { StatePill, type ScreenProps } from './screens';

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

/**
 * The status pill. A word, never only a colour (§84): the class is decoration
 * and the text is the state.
 */
const statusClass = (s: string) => (s === 'READY' || s === 'ACTIVE' ? 'green' : s === 'COMPLIANCE_BLOCKED' ? 'red' : s === 'COMPLIANCE_PENDING' || s === 'ON_HOLD' ? 'gold' : s === 'CANCELLED' || s === 'CLOSED' || s === 'ARCHIVED' ? 'grey' : 'blue');
export function TxStatusPill({ status }: { status: string }) {
  return <span className={`pill ${statusClass(status)}`} data-testid="tx-status" data-status={status}>{tr(`txStatus.${status}`, status.replace(/_/g, ' ').toLowerCase())}</span>;
}

/** The server's refusal, with the codes it carried. Never the raw status, never a guess. */
function Refusal({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  const s = httpState(error);
  const d = error instanceof ApiError ? error.details ?? {} : {};
  const reasons = Array.isArray(d.reasons) ? (d.reasons as Reason[]) : [];
  const awaiting = Array.isArray(d.awaiting) ? (d.awaiting as string[]) : [];
  const outstanding = Array.isArray(d.consentsOutstanding) ? (d.consentsOutstanding as { partyRole: string; reasonCode: string }[]) : [];
  return (
    <div className="notice block" role="alert" data-http-kind={s.kind} data-code={s.code ?? ''} data-testid="tx-refusal">
      <div>{s.message}</div>
      {typeof d.pendingReason === 'string' && <div className="dim" style={{ marginTop: 4 }} data-testid="refusal-pending">{tr(`txPending.${d.pendingReason}`, String(d.pendingReason).replace(/_/g, ' ').toLowerCase())}</div>}
      {typeof d.staleness === 'string' && <div className="dim" style={{ marginTop: 4 }} data-testid="refusal-stale">{tr(`txStale.${d.staleness}`, String(d.staleness).replace(/_/g, ' ').toLowerCase())}</div>}
      {typeof d.from === 'string' && typeof d.to === 'string' && <div className="dim" style={{ marginTop: 4 }}>{tr(`txStatus.${d.from}`, String(d.from))} → {tr(`txStatus.${d.to}`, String(d.to))}</div>}
      {awaiting.length > 0 && <div className="dim" style={{ marginTop: 4 }}>{t('tx.awaiting')}: {awaiting.map((r) => tr(`party.${r}`, r)).join(', ')}</div>}
      {outstanding.length > 0 && <div className="dim" style={{ marginTop: 4 }}>{t('tx.consentOutstanding')}: {outstanding.map((o) => tr(`party.${o.partyRole}`, o.partyRole)).join(', ')}</div>}
      {reasons.length > 0 && <div className="list-rows" style={{ marginTop: 6 }}>{reasons.map((r, i) => (
        <div className="list-row" key={`${r.code}-${i}`} data-testid="tx-reason" data-code={r.code}>
          <span className="grow"><b>{tr(`reason.${r.code}`, r.code.replace(/_/g, ' '))}</b>{r.ruleId ? <span className="dim"> · {r.ruleId}</span> : null}</span>
          {r.ruleStatus && <span className={`pill ${r.ruleStatus === 'ACTIVE' ? 'green' : 'gold'}`}>{tr(`ruleStatus.${r.ruleStatus}`, r.ruleStatus)}</span>}
        </div>
      ))}</div>}
      {s.retryable && onRetry && <div style={{ marginTop: 6 }}><button onClick={onRetry}>{t('common.retry')}</button></div>}
    </div>
  );
}

/** The compliance box: the current answer, its reason, its staleness, its policy versions. */
function ComplianceBox({ tx, onEvaluate, busy }: { tx: Transaction; onEvaluate: () => void; busy: boolean }) {
  const c = tx.compliance;
  return (
    <div className="section" data-testid="tx-compliance" data-clear={c.clear ? '1' : '0'} data-blocked={c.blocked ? '1' : '0'} data-stale={c.staleness ?? ''}>
      <h4>{t('tx.compliance')}</h4>
      <div className="row wrap gap">
        <span className={`pill ${c.blocked ? 'red' : c.clear ? 'green' : 'gold'}`} data-testid="tx-compliance-state">
          {c.blocked ? t('tx.complianceBlocked') : c.clear ? t('tx.complianceClear') : tr(`txPending.${c.pendingReason ?? 'UNKNOWN'}`, t('tx.compliancePending'))}
        </span>
        {c.outcome && <span className="pill blue" data-testid="tx-outcome" data-outcome={c.outcome}>{tr(`outcome.${c.outcome}`, c.outcome)}</span>}
        {c.staleness && <span className="pill gold" data-testid="tx-stale">{tr(`txStale.${c.staleness}`, c.staleness)}</span>}
      </div>
      {c.evaluatedAt && <div className="dim" style={{ marginTop: 4 }}>{t('tx.evaluatedAt')} {fmtStamp(c.evaluatedAt)}{c.snapshotClear && !c.clear ? ` · ${t('tx.snapshotSaidClear')}` : ''}</div>}
      {c.reasonCodes.length > 0 && (
        <ul className="plain" style={{ marginTop: 6 }} data-testid="tx-reason-codes">
          {c.reasonCodes.map((code) => <li key={code} data-code={code}>{tr(`reason.${code}`, code.replace(/_/g, ' '))}</li>)}
        </ul>
      )}
      {c.consentRequirements.length > 0 && (
        <div className="dim" style={{ marginTop: 4 }} data-testid="tx-consent-required">
          {t('tx.consentOutstanding')}: {c.consentRequirements.map((r) => tr(`party.${r.partyRole}`, r.partyRole)).join(', ')}
        </div>
      )}
      {c.policyVersions?.length ? <div className="dim" style={{ marginTop: 4 }}>{t('tx.policyVersions')}: {c.policyVersions.join(', ')}</div> : null}
      <div className="row gap" style={{ marginTop: 8 }}>
        <button onClick={onEvaluate} disabled={busy} data-testid="tx-evaluate">{t('tx.reEvaluate')}</button>
      </div>
      <p className="dim" style={{ marginTop: 6 }} data-testid="tx-compliance-honest">{c.honest}</p>
    </div>
  );
}

/** The offer seam, read-only: a readiness boolean and its blockers, and a sentence saying no offer exists. */
function OfferBoundaryBox({ tx }: { tx: Transaction }) {
  const b = tx.offerBoundary;
  return (
    <div className="section" data-testid="tx-offer-boundary" data-ready={b.canStartOfferWorkflow ? '1' : '0'}>
      <h4>{t('tx.offerBoundary')}</h4>
      <div className="row wrap gap">
        <span className={`pill ${b.canStartOfferWorkflow ? 'green' : 'grey'}`} data-testid="tx-offer-ready">
          {b.canStartOfferWorkflow ? t('tx.readyToProceed') : t('tx.notReadyToProceed')}
        </span>
      </div>
      {b.blockers.length > 0 && (
        <ul className="plain" style={{ marginTop: 6 }} data-testid="tx-offer-blockers">
          {b.blockers.map((x) => <li key={x} data-blocker={x}>{tr(`txBlocker.${x}`, x.replace(/_/g, ' ').toLowerCase())}</li>)}
        </ul>
      )}
      <p className="dim" style={{ marginTop: 6 }}>{b.honest}</p>
    </div>
  );
}

// ------------------------------------------------------------ the list
function TransactionRow({ tx, onOpen }: { tx: Transaction; onOpen: (id: string) => void }) {
  const individual = tx.parties.find((p) => p.partyRole === 'individual' && !p.removed);
  const engaging = tx.parties.find((p) => p.partyRole === 'engaging_entity' && !p.removed);
  const releasing = tx.parties.find((p) => p.partyRole === 'releasing_entity' && !p.removed);
  return (
    <div className="list-row" data-testid="tx-row" data-tx={tx.id} data-status={tx.status}>
      <span className="grow">
        <b>{individual?.name ?? t('tx.partyUnnamed')}</b>
        <span className="dim"> · {tr(`txType.${tx.type}`, tx.type.replace(/_/g, ' '))}</span>
        <br />
        <span className="dim">
          {engaging?.name ?? t('tx.clubUnnamed')}
          {releasing ? ` ← ${releasing.name ?? t('tx.clubUnnamed')}` : ''}
          {' · '}{tx.jurisdictions.join(', ')}
        </span>
      </span>
      <TxStatusPill status={tx.status} />
      {tx.compliance.staleness && <span className="pill gold" data-testid="tx-row-stale">{t('tx.staleShort')}</span>}
      {tx.consents.some((c) => c.status === 'requested') && <span className="pill blue" data-testid="tx-row-consent">{t('tx.consentWaiting')}</span>}
      <span className="dim">{fmtDate(tx.updatedAt)}</span>
      <button onClick={() => onOpen(tx.id)} data-testid="tx-open">{t('common.open')}</button>
    </div>
  );
}

function NewTransactionForm({ s, clubs, onCreated }: { s: Session; clubs: ClubHit[]; onCreated: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<TransactionType>('employment_contract');
  const [jurisdiction, setJurisdiction] = useState('ENG');
  const [playerId, setPlayerId] = useState('');
  const [engaging, setEngaging] = useState('');
  const [releasing, setReleasing] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const needsReleasing = type === 'transfer' || type === 'loan';
  const { data: clients } = useLoad(() => agent.clients(s), []);
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const parties: { partyRole: PartyRole; subjectKind: 'player' | 'club'; subjectId: string }[] = [];
      if (playerId) parties.push({ partyRole: 'individual', subjectKind: 'player', subjectId: playerId });
      if (engaging) parties.push({ partyRole: 'engaging_entity', subjectKind: 'club', subjectId: engaging });
      if (needsReleasing && releasing) parties.push({ partyRole: 'releasing_entity', subjectKind: 'club', subjectId: releasing });
      const r = await agent.createTransaction(s, { type, jurisdictions: [jurisdiction], parties, clientKey: clientKey() });
      setOpen(false);
      onCreated(r.transaction.id);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  if (!open) return <button onClick={() => setOpen(true)} data-testid="tx-new">{t('tx.new')}</button>;
  return (
    <div className="section" data-testid="tx-new-form">
      <h4>{t('tx.new')}</h4>
      <div className="row wrap gap">
        <label>{t('tx.type')}
          <select value={type} onChange={(e) => setType(e.target.value as TransactionType)} data-testid="tx-new-type">
            {TRANSACTION_TYPES.map((x) => <option key={x} value={x}>{tr(`txType.${x}`, x)}</option>)}
          </select>
        </label>
        <label>{t('tx.jurisdiction')}
          <select value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} data-testid="tx-new-jurisdiction">
            {JURISDICTIONS.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        <label>{t('party.individual')}
          <select value={playerId} onChange={(e) => setPlayerId(e.target.value)} data-testid="tx-new-player">
            <option value="">—</option>
            {(clients?.items ?? []).filter((c) => !isSummary(c) && c.status === 'active').map((c) => <option key={c.clientId} value={c.clientId}>{('client' in c && c.client?.name) || c.clientId}</option>)}
          </select>
        </label>
        <label>{t('party.engaging_entity')}
          <select value={engaging} onChange={(e) => setEngaging(e.target.value)} data-testid="tx-new-engaging">
            <option value="">—</option>
            {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        {needsReleasing && (
          <label>{t('party.releasing_entity')}
            <select value={releasing} onChange={(e) => setReleasing(e.target.value)} data-testid="tx-new-releasing">
              <option value="">—</option>
              {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}
      </div>
      <p className="dim" style={{ marginTop: 6 }}>{t('tx.newHonest')}</p>
      <Refusal error={error} />
      <div className="row gap" style={{ marginTop: 8 }}>
        <button onClick={submit} disabled={busy} data-testid="tx-new-submit">{t('tx.open')}</button>
        <button className="ghost" onClick={() => setOpen(false)}>{t('common.cancel')}</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ detail tabs
const TABS = ['overview', 'parties', 'compliance', 'documents', 'messages', 'timeline'] as const;
type Tab = (typeof TABS)[number];

function PartiesTab({ s, tx, reload }: { s: Session; tx: Transaction; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const { data: clients } = useLoad(() => agent.clients(s), []);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setError(null); try { await fn(); reload(); } catch (e) { setError(e); } finally { setBusy(false); } };
  const live = tx.parties.filter((p) => !p.removed);
  const removed = tx.parties.filter((p) => p.removed);
  return (
    <>
      <Section title={t('tx.parties')} testId="tx-parties">
        <div className="list-rows">
          {live.map((p) => (
            <div className="list-row" key={p.id} data-testid="tx-party" data-party-role={p.partyRole} data-confirmed={p.confirmedAt ? '1' : '0'}>
              <span className="grow"><b>{tr(`party.${p.partyRole}`, p.partyRole)}</b> · {p.name ?? (p.subjectRemovedAt ? t('tx.partyRemovedAccount') : t('tx.partyUnnamed'))}</span>
              <span className={`pill ${p.confirmedAt ? 'green' : 'gold'}`} data-testid="tx-party-confirmed">{p.confirmedAt ? t('tx.confirmed') : t('tx.awaitingConfirmation')}</span>
              {tx.allowedTransitions.length > 0 && (
                <button className="ghost" disabled={busy} onClick={() => act(() => agent.removeTxParty(s, tx.id, p.id, tx.rev))} data-testid="tx-party-remove">{t('tx.removeParty')}</button>
              )}
            </div>
          ))}
        </div>
        {live.length === 0 && <div className="notice">{t('tx.noParties')}</div>}
        {tx.awaitingConfirmation.length > 0 && (
          <div className="notice block" style={{ marginTop: 8 }} data-testid="tx-awaiting">
            {t('tx.awaiting')}: {tx.awaitingConfirmation.map((r) => tr(`party.${r}`, r)).join(', ')}
            <div className="dim" style={{ marginTop: 4 }}>{t('tx.confirmationHonest')}</div>
          </div>
        )}
      </Section>
      {removed.length > 0 && (
        <Section title={t('tx.partyHistory')} testId="tx-party-history">
          <div className="list-rows">
            {removed.map((p) => (
              <div className="list-row" key={p.id} data-testid="tx-party-removed">
                <span className="grow"><b>{tr(`party.${p.partyRole}`, p.partyRole)}</b> · {p.name ?? t('tx.partyUnnamed')}</span>
                <span className="dim">{t('tx.removedAt')} {p.removedAt ? fmtStamp(p.removedAt) : '—'}</span>
              </div>
            ))}
          </div>
          <p className="dim">{t('tx.partyHistoryHonest')}</p>
        </Section>
      )}
      <Section title={t('tx.representations')} testId="tx-representations">
        <div className="list-rows">
          {tx.representations.map((r) => (
            <div className="list-row" key={r.id} data-testid="tx-representation" data-party-role={r.partyRole} data-rep-status={r.status}>
              <span className="grow">
                <b>{tr(`party.${r.partyRole}`, r.partyRole)}</b>
                <span className="dim"> · {tr(`txBasis.${r.basis}`, r.basis.replace(/_/g, ' '))}</span>
                {r.scope.length > 0 && <span className="dim"> · {r.scope.map((x) => tr(`scope.${x}`, x)).join(', ')}</span>}
              </span>
              <StatePill state={r.status} />
              {r.status !== 'withdrawn' && (
                <button className="ghost" disabled={busy} onClick={() => act(() => agent.unbindRepresentation(s, tx.id, r.id, tx.rev))} data-testid="tx-rep-withdraw">{t('tx.withdrawBinding')}</button>
              )}
            </div>
          ))}
        </div>
        {tx.representations.length === 0 && <div className="notice">{t('tx.noRepresentations')}</div>}
        <div className="row wrap gap" style={{ marginTop: 8 }}>
          {live.map((p) => {
            const already = tx.representations.some((r) => r.partyRole === p.partyRole && r.status !== 'withdrawn');
            if (already) return null;
            const rel = p.subjectKind === 'player' ? (clients?.items ?? []).find((c) => !isSummary(c) && c.clientId === p.subjectId && c.status === 'active') : null;
            return (
              <button key={p.id} disabled={busy} data-testid="tx-bind" data-party-role={p.partyRole}
                onClick={() => act(() => agent.bindRepresentation(s, tx.id, { partyRole: p.partyRole, agreementId: rel && !isSummary(rel) ? rel.id : null, clientKey: clientKey(), expectedRev: tx.rev }))}>
                {t('tx.bindFor')} {tr(`party.${p.partyRole}`, p.partyRole)}
              </button>
            );
          })}
        </div>
        <p className="dim" style={{ marginTop: 6 }}>{t('tx.bindingHonest')}</p>
      </Section>
      <Refusal error={error} />
    </>
  );
}

function ComplianceTab({ s, tx, reload }: { s: Session; tx: Transaction; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setError(null); try { await fn(); reload(); } catch (e) { setError(e); } finally { setBusy(false); } };
  return (
    <>
      <ComplianceBox tx={tx} busy={busy} onEvaluate={() => act(() => agent.evaluateTransaction(s, tx.id))} />
      <Section title={t('tx.consents')} testId="tx-consents">
        <div className="list-rows">
          {tx.consents.map((c, i) => (
            <div className="list-row" key={c.id ?? `c-${i}`} data-testid="tx-consent" data-consent-status={c.status} data-party-role={c.partyRole ?? ''}>
              <span className="grow"><b>{tr(`party.${c.partyRole ?? 'individual'}`, c.partyRole ?? '')}</b><span className="dim"> · {tr(`consentKind.${c.kind}`, c.kind.replace(/_/g, ' '))}</span></span>
              <StatePill state={c.status} />
              <span className="dim">{c.grantedAt ? fmtDate(c.grantedAt) : c.requestedAt ? fmtDate(c.requestedAt) : '—'}</span>
            </div>
          ))}
        </div>
        {tx.consents.length === 0 && <div className="notice">{t('tx.noConsents')}</div>}
        {tx.compliance.consentRequirements.length > 0 && (
          <div className="row wrap gap" style={{ marginTop: 8 }}>
            {tx.compliance.consentRequirements.map((r) => (
              <button key={r.partyRole} disabled={busy} data-testid="tx-request-consent" data-party-role={r.partyRole}
                onClick={() => act(() => agent.requestTxConsent(s, tx.id, { partyRole: r.partyRole, fullParticularsProvided: true, legalAdviceOffered: true, proposedFeeDisclosed: true, clientKey: clientKey() }))}>
                {t('tx.requestConsentFrom')} {tr(`party.${r.partyRole}`, r.partyRole)}
              </button>
            ))}
          </div>
        )}
        <p className="dim" style={{ marginTop: 6 }}>{t('tx.consentHonest')}</p>
      </Section>
      <OfferBoundaryBox tx={tx} />
      <Refusal error={error} />
    </>
  );
}

function DocumentsTab({ s, tx, reload }: { s: Session; tx: Transaction; reload: () => void }) {
  const { data, error, loading, reload: reloadDocs } = useLoad(() => agent.txDocuments(s, tx.id), [tx.id]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [ref, setRef] = useState<{ id: string; note: string } | null>(null);
  const [form, setForm] = useState<{ documentType: DocumentType; visibility: string; label: string }>({ documentType: 'mandate', visibility: '', label: '' });
  const uploadable = data?.uploadable ?? [];
  useEffect(() => { if (!form.visibility && uploadable.length > 0) setForm((f) => ({ ...f, visibility: uploadable[0] })); }, [uploadable.join(','), form.visibility]);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); reloadDocs(); reload(); } catch (e) { setErr(e); } finally { setBusy(false); } };
  // Reading a document's reference changes nothing, so it must NOT reload: the
  // parent shows a loading state while it refetches, which unmounts this tab and
  // throws away the answer the user just asked for (D10).
  const read = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); } catch (e) { setErr(e); } finally { setBusy(false); } };
  if (loading) return <Loading />;
  if (error) return <Refusal error={error} onRetry={reloadDocs} />;
  const items = data?.items ?? [];
  return (
    <>
      <Section title={t('tx.documents')} testId="tx-documents">
        <div className="list-rows">
          {items.map((d: TxDocument) => (
            <div className="list-row" key={d.id} data-testid="tx-document" data-visibility={d.visibility} data-version={d.version}>
              <span className="grow">
                <b>{d.label}</b>
                <span className="dim"> · {tr(`docType.${d.documentType}`, d.documentType.replace(/_/g, ' '))} · v{d.version}</span>
                <br /><span className="dim">{tr(`visibility.${d.visibility}`, d.visibility)} · {d.actor?.label ?? '—'} · {fmtDate(d.uploadedAt)}</span>
              </span>
              {d.expired && <span className="pill grey" data-testid="tx-doc-expired">{t('tx.docExpired')}</span>}
              {!d.evidence && <span className="pill gold" data-testid="tx-doc-placeholder">{t('tx.docPlaceholder')}</span>}
              <button className="ghost" disabled={busy} data-testid="tx-doc-reference"
                onClick={() => read(async () => { const r = await agent.txDocumentReference(s, tx.id, d.id); setRef({ id: d.id, note: r.note }); })}>{t('tx.docReference')}</button>
              {d.ownerKind === 'agent' && tx.allowedTransitions.length > 0 && (
                <button className="ghost" disabled={busy} data-testid="tx-doc-supersede"
                  onClick={() => act(() => agent.supersedeTxDocument(s, tx.id, d.id, { label: `${d.label} (v${d.version + 1})`, expectedRev: d.rev }))}>{t('tx.docNewVersion')}</button>
              )}
            </div>
          ))}
        </div>
        {items.length === 0 && <div className="notice" data-testid="tx-documents-empty">{t('tx.noDocuments')}</div>}
        {ref && <div className="notice block" style={{ marginTop: 8 }} data-testid="tx-doc-reference-note">{ref.note}</div>}
      </Section>
      {uploadable.length > 0 && (
        <Section title={t('tx.addDocument')} testId="tx-add-document">
          <div className="row wrap gap">
            <label>{t('tx.docType')}
              <select value={form.documentType} onChange={(e) => setForm({ ...form, documentType: e.target.value as DocumentType })} data-testid="tx-doc-type">
                {DOCUMENT_TYPES.map((x) => <option key={x} value={x}>{tr(`docType.${x}`, x)}</option>)}
              </select>
            </label>
            <label>{t('tx.docVisibility')}
              <select value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })} data-testid="tx-doc-visibility">
                {uploadable.map((x) => <option key={x} value={x}>{tr(`visibility.${x}`, x)}</option>)}
              </select>
            </label>
            <label>{t('tx.docLabel')}
              <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} data-testid="tx-doc-label" />
            </label>
          </div>
          <p className="dim" style={{ marginTop: 6 }}>{t('tx.docHonest')}</p>
          <div className="row gap" style={{ marginTop: 8 }}>
            <button disabled={busy || !form.label.trim()} data-testid="tx-doc-add"
              onClick={() => act(async () => { await agent.addTxDocument(s, tx.id, { documentType: form.documentType, visibility: form.visibility as DocumentVisibility, label: form.label.trim(), clientKey: clientKey() }); setForm({ ...form, label: '' }); })}>
              {t('tx.addDocument')}
            </button>
          </div>
        </Section>
      )}
      <Refusal error={err} />
    </>
  );
}

function MessagesTab({ s, tx }: { s: Session; tx: Transaction }) {
  const { data, error, loading, reload } = useLoad(() => agent.txMessages(s, tx.id), [tx.id]);
  if (loading) return <Loading />;
  if (error) return <Refusal error={error} onRetry={reload} />;
  return (
    <Section title={t('tx.messages')} testId="tx-messages">
      <div className="list-rows">
        {(data?.items ?? []).map((th) => (
          <div className="list-row" key={th.id} data-testid="tx-thread" data-readable={th.readable ? '1' : '0'}>
            <span className="grow"><b>{t('tx.linkedThread')}</b><span className="dim"> · {th.actor?.label ?? '—'} · {fmtDate(th.linkedAt)}</span></span>
            <span className={`pill ${th.readable ? 'green' : 'grey'}`}>{th.readable ? t('tx.threadReadable') : t('tx.threadNotYours')}</span>
          </div>
        ))}
      </div>
      {(data?.items ?? []).length === 0 && <div className="notice" data-testid="tx-messages-empty">{t('tx.noThreads')}</div>}
      <p className="dim" style={{ marginTop: 6 }} data-testid="tx-messages-note">{data?.note}</p>
    </Section>
  );
}

function TimelineTab({ s, tx }: { s: Session; tx: Transaction }) {
  const { data, error, loading, reload } = useLoad(() => agent.txTimeline(s, tx.id), [tx.id]);
  if (loading) return <Loading />;
  if (error) return <Refusal error={error} onRetry={reload} />;
  return (
    <Section title={t('tx.timeline')} testId="tx-timeline">
      <div className="list-rows">
        {(data?.items ?? []).map((e: TxTimelineEntry) => (
          <div className="list-row" key={e.id} data-testid="tx-timeline-entry" data-action={e.action} data-audience={e.audience}>
            <span className="grow">
              <b>{tr(`txAction.${e.action}`, e.action.replace(/^transaction_/, '').replace(/_/g, ' '))}</b>
              {e.detail?.to ? <span className="dim"> · {tr(`txStatus.${String(e.detail.to)}`, String(e.detail.to))}</span> : null}
              {e.detail?.partyRole ? <span className="dim"> · {tr(`party.${String(e.detail.partyRole)}`, String(e.detail.partyRole))}</span> : null}
            </span>
            <span className="dim">{e.actor?.label ?? '—'}</span>
            <span className="dim">{fmtStamp(e.at)}</span>
          </div>
        ))}
      </div>
      {(data?.items ?? []).length === 0 && <div className="notice">{t('tx.noTimeline')}</div>}
      <p className="dim" style={{ marginTop: 6 }}>{data?.note}</p>
    </Section>
  );
}

function OverviewTab({ s, tx, reload }: { s: Session; tx: Transaction; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState('');
  const [noteVisibility, setNoteVisibility] = useState<DocumentVisibility>('AGENT_PRIVATE');
  const [termsText, setTermsText] = useState('');
  const [pending, setPending] = useState<TransactionStatus | null>(null);
  const [reasonCode, setReasonCode] = useState('');
  const { data: list } = useLoad(() => agent.transactions(s), []);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setError(null); try { await fn(); reload(); } catch (e) { setError(e); } finally { setBusy(false); } };
  const reasonCodes = useMemo(() => {
    if (!list || !pending) return [];
    if (pending === 'ON_HOLD') return list.holdReasonCodes;
    if (pending === 'CANCELLED') return list.cancelReasonCodes;
    if (pending === 'CLOSED') return list.closeReasonCodes;
    return [];
  }, [list, pending]);
  useEffect(() => { setReasonCode(reasonCodes[0] ?? ''); }, [reasonCodes.join(',')]);
  return (
    <>
      <div className="stats" data-testid="tx-stats">
        <Stat v={<TxStatusPill status={tx.status} />} k={t('tx.status')} testId="stat-status" />
        <Stat v={tr(`txType.${tx.type}`, tx.type)} k={t('tx.type')} testId="stat-type" />
        <Stat v={tx.parties.filter((p) => !p.removed && p.confirmedAt).length} k={t('tx.confirmedParties')} testId="stat-confirmed" />
        <Stat v={tx.representations.filter((r) => r.status !== 'withdrawn').length} k={t('tx.bindings')} testId="stat-bindings" />
      </div>
      <p className="dim" data-testid="tx-honest">{tx.honest}</p>
      <ComplianceBox tx={tx} busy={busy} onEvaluate={() => act(() => agent.evaluateTransaction(s, tx.id))} />
      {tx.hold && (
        <div className="notice block" data-testid="tx-hold">
          {t('tx.onHold')}: {tr(`holdReason.${tx.hold.reasonCode ?? ''}`, tx.hold.reasonCode ?? '')}
          {tx.hold.reason ? <div className="dim" style={{ marginTop: 4 }}>{tx.hold.reason}</div> : null}
        </div>
      )}
      <Section title={t('tx.actions')} testId="tx-actions">
        {tx.allowedTransitions.length === 0 && <div className="notice" data-testid="tx-no-actions">{t('tx.noActions')}</div>}
        <div className="row wrap gap">
          {tx.allowedTransitions.map((to) => (
            <button key={to} disabled={busy} data-testid="tx-transition" data-to={to}
              onClick={() => (to === 'ON_HOLD' || to === 'CANCELLED' || to === 'CLOSED' ? setPending(to) : act(() => agent.setTransactionStatus(s, tx.id, { to, clientKey: clientKey(), expectedRev: tx.rev })))}>
              {tr(`txAction.to.${to}`, to.replace(/_/g, ' ').toLowerCase())}
            </button>
          ))}
        </div>
        {pending && (
          <div className="section" style={{ marginTop: 8 }} data-testid="tx-reason-form">
            <h4>{tr(`txAction.to.${pending}`, pending)}</h4>
            <label>{t('tx.reasonCode')}
              <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} data-testid="tx-reason-code">
                {reasonCodes.map((x) => <option key={x} value={x}>{tr(`holdReason.${x}`, x.replace(/_/g, ' '))}</option>)}
              </select>
            </label>
            <div className="row gap" style={{ marginTop: 8 }}>
              <button disabled={busy || !reasonCode} data-testid="tx-reason-submit"
                onClick={() => act(async () => { await agent.setTransactionStatus(s, tx.id, { to: pending, reasonCode, clientKey: clientKey(), expectedRev: tx.rev }); setPending(null); })}>{t('common.confirm')}</button>
              <button className="ghost" onClick={() => setPending(null)}>{t('common.cancel')}</button>
            </div>
          </div>
        )}
        <p className="dim" style={{ marginTop: 6 }}>{t('tx.actionsHonest')}</p>
      </Section>
      <Section title={t('tx.terms')} testId="tx-terms">
        <div className="list-rows">
          {tx.terms.versions.map((v) => (
            <div className="list-row" key={v.id} data-testid="tx-terms-version">
              <span className="grow"><b>{tr(`party.${v.recordedFor}`, v.recordedFor)}</b><br /><span className="dim">{v.summary}</span></span>
              <span className="dim">{tr(`visibility.${v.visibility}`, v.visibility)}</span>
              <span className="dim">{fmtDate(v.at)}</span>
            </div>
          ))}
        </div>
        {tx.terms.versions.length === 0 && <div className="notice">{t('tx.noTerms')}</div>}
        {tx.allowedTransitions.length > 0 && (
          <>
            <label style={{ display: 'block', marginTop: 8 }}>{t('tx.recordTerms')}
              <textarea value={termsText} onChange={(e) => setTermsText(e.target.value)} rows={2} data-testid="tx-terms-text" />
            </label>
            <div className="row gap">
              <button disabled={busy || !termsText.trim()} data-testid="tx-terms-submit"
                onClick={() => act(async () => { await agent.recordTerms(s, tx.id, { summary: termsText.trim(), recordedFor: 'individual', visibility: 'PLAYER_AGENT_SHARED', expectedRev: tx.rev }); setTermsText(''); })}>{t('tx.recordTerms')}</button>
            </div>
          </>
        )}
        <p className="dim" style={{ marginTop: 6 }} data-testid="tx-terms-honest">{t('tx.termsHonest')}</p>
      </Section>
      <Section title={t('tx.notes')} testId="tx-notes">
        <div className="list-rows">
          {tx.notes.map((n) => (
            <div className="list-row" key={n.id} data-testid="tx-note" data-visibility={n.visibility}>
              <span className="grow">{n.text}<br /><span className="dim">{tr(`visibility.${n.visibility}`, n.visibility)} · {n.actor?.label ?? '—'} · {fmtStamp(n.at)}</span></span>
            </div>
          ))}
        </div>
        {tx.notes.length === 0 && <div className="notice">{t('tx.noNotes')}</div>}
        {tx.allowedTransitions.length > 0 && (
          <>
            <div className="row wrap gap" style={{ marginTop: 8 }}>
              <label>{t('tx.docVisibility')}
                <select value={noteVisibility} onChange={(e) => setNoteVisibility(e.target.value as DocumentVisibility)} data-testid="tx-note-visibility">
                  <option value="AGENT_PRIVATE">{tr('visibility.AGENT_PRIVATE', 'AGENT_PRIVATE')}</option>
                  <option value="PLAYER_AGENT_SHARED">{tr('visibility.PLAYER_AGENT_SHARED', 'PLAYER_AGENT_SHARED')}</option>
                  <option value="ALL_TRANSACTION_PARTIES">{tr('visibility.ALL_TRANSACTION_PARTIES', 'ALL_TRANSACTION_PARTIES')}</option>
                </select>
              </label>
              <label className="grow">{t('tx.noteText')}
                <input value={note} onChange={(e) => setNote(e.target.value)} data-testid="tx-note-text" />
              </label>
            </div>
            <div className="row gap" style={{ marginTop: 8 }}>
              <button disabled={busy || !note.trim()} data-testid="tx-note-add"
                onClick={() => act(async () => { await agent.addTxNote(s, tx.id, { text: note.trim(), visibility: noteVisibility, expectedRev: tx.rev }); setNote(''); })}>{t('tx.addNote')}</button>
            </div>
          </>
        )}
        <p className="dim" style={{ marginTop: 6 }}>{t('tx.notesHonest')}</p>
      </Section>
      <Refusal error={error} />
    </>
  );
}

// ------------------------------------------------------------ the screen
export function TransactionsScreen({ session, me, transactionId, transactionTab, onOpenTransaction, onTransactionTab }: ScreenProps & {
  me: Me | null; transactionId: string | null; transactionTab: Tab;
  onOpenTransaction: (id: string | null, tab?: Tab) => void; onTransactionTab: (tab: Tab) => void;
}) {
  const s = session;
  // The tab lives in the hash, so a deep link and the Back button agree with what
  // is on screen (D14). This screen renders it; it never keeps its own copy.
  const tab = transactionTab;
  const setTab = onTransactionTab;
  const [filter, setFilter] = useState('');
  const { data: list, error: listError, loading: listLoading, reload: reloadList } = useLoad(() => agent.transactions(s), []);
  const { data: clubs } = useLoad(() => agent.clubs(s), []);
  const { data: detail, error: detailError, loading: detailLoading, reload: reloadDetail } = useLoad(
    () => (transactionId ? agent.transaction(s, transactionId) : Promise.resolve(null)), [transactionId],
  );
  const reloadAll = useCallback(() => { reloadDetail(); reloadList(); }, [reloadDetail, reloadList]);
  const canWrite = !!me?.affiliation?.tiers?.includes('licensed_agent');

  if (transactionId) {
    if (detailLoading) return <Loading />;
    if (detailError) return (
      <div className="screen" data-testid="transactions-screen">
        <div className="row gap"><button className="ghost" onClick={() => onOpenTransaction(null)} data-testid="tx-back">{t('common.back')}</button></div>
        <Refusal error={detailError} onRetry={reloadDetail} />
      </div>
    );
    const tx = detail?.transaction;
    if (!tx) return <div className="notice">{t('tx.notFound')}</div>;
    return (
      <div className="screen" data-testid="transaction-detail" data-tx={tx.id} data-status={tx.status}>
        <div className="row gap wrap">
          <button className="ghost" onClick={() => onOpenTransaction(null)} data-testid="tx-back">{t('common.back')}</button>
          <h3 className="grow">{tx.parties.find((p) => p.partyRole === 'individual')?.name ?? t('tx.partyUnnamed')} · {tr(`txType.${tx.type}`, tx.type)}</h3>
          <TxStatusPill status={tx.status} />
        </div>
        <div className="tabs" role="tablist" aria-label={t('tx.tabs')} data-testid="tx-tabs">
          {TABS.map((x) => (
            <button key={x} role="tab" aria-selected={tab === x} className={tab === x ? 'active' : ''} onClick={() => setTab(x)} data-testid={`tx-tab-${x}`}>
              {tr(`txTab.${x}`, x)}
            </button>
          ))}
        </div>
        <div role="tabpanel" data-testid={`tx-panel-${tab}`}>
          {tab === 'overview' && <OverviewTab s={s} tx={tx} reload={reloadAll} />}
          {tab === 'parties' && <PartiesTab s={s} tx={tx} reload={reloadAll} />}
          {tab === 'compliance' && <ComplianceTab s={s} tx={tx} reload={reloadAll} />}
          {tab === 'documents' && <DocumentsTab s={s} tx={tx} reload={reloadAll} />}
          {tab === 'messages' && <MessagesTab s={s} tx={tx} />}
          {tab === 'timeline' && <TimelineTab s={s} tx={tx} />}
        </div>
      </div>
    );
  }

  if (listLoading) return <Loading />;
  if (listError) return <div className="screen" data-testid="transactions-screen"><Refusal error={listError} onRetry={reloadList} /></div>;
  const l = list as TransactionList;
  const rows = l.items.filter((tx) => !filter || tx.status === filter);
  return (
    <div className="screen" data-testid="transactions-screen">
      <h3>{t('nav.transactions')}</h3>
      <div className="stats" data-testid="tx-counts">
        <Stat v={l.counts.live} k={t('tx.countLive')} testId="count-live" />
        <Stat v={l.counts.ready} k={t('tx.countReady')} testId="count-ready" />
        <Stat v={l.counts.pending} k={t('tx.countPending')} testId="count-pending" />
        <Stat v={l.counts.blocked} k={t('tx.countBlocked')} testId="count-blocked" />
        <Stat v={l.counts.awaitingConfirmation} k={t('tx.countAwaiting')} testId="count-awaiting" />
      </div>
      <p className="dim" data-testid="tx-list-honest">{l.honest}</p>
      <div className="row wrap gap">
        <label>{t('tx.status')}
          <select value={filter} onChange={(e) => setFilter(e.target.value)} data-testid="tx-filter">
            <option value="">{t('tx.allStatuses')}</option>
            {TRANSACTION_STATUSES.map((x) => <option key={x} value={x}>{tr(`txStatus.${x}`, x)}</option>)}
          </select>
        </label>
        {canWrite && <NewTransactionForm s={s} clubs={clubs ?? []} onCreated={(id) => { reloadList(); onOpenTransaction(id); }} />}
      </div>
      <div className="list-rows" style={{ marginTop: 8 }} data-testid="tx-list">
        {rows.map((tx) => <TransactionRow key={tx.id} tx={tx} onOpen={onOpenTransaction} />)}
      </div>
      {rows.length === 0 && <div className="notice" data-testid="tx-list-empty">{l.items.length === 0 ? t('tx.noneYet') : t('tx.noneMatch')}</div>}
    </div>
  );
}
