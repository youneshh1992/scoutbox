// M23 P5 — the formal recruitment decision, inside the Room's Decision tab.
//
// Evidence informs assessment; assessment informs discussion; discussion
// informs a formal HUMAN decision; that decision is not an offer and is never
// sent to the player. This panel renders exactly that chain as the server
// holds it: what the club may cite, how the assessors differ, a DRAFT that is
// visibly not a decision, and a finalize step behind an explicit confirmation
// that says what it records — the club's internal decision — and never "offer".
//
// What never appears here: an average of assessments, a score, a Box Cam
// verdict, a Trust Score treated as a reason, a rationale reaching anyone
// outside the room, an "Offer player" button.
import { useCallback, useEffect, useState } from 'react';
import { ApiError, type Session } from './api';
import { confirmDestructive, DESTRUCTIVE_ACTIONS } from './confirmAction';
import {
  rooms, type Room, type DecisionSurface, type DecisionOutcome, type DecisionDraft, type FormalDecision, type DecisionEvidenceRefKind,
  type HandoffSurface,
} from './roomsApi';
import { t, fmtDateTime } from './i18n';

interface Props {
  session: Session;
  room: Room;
  notify: (text: string, error?: boolean) => void;
  reload: () => void;
}

const reasonLabel = (code: string) => t(`rm.reason.${code}`, code.replace(/_/g, ' '));
const outcomeLabel = (o: string | null) => (o ? t(`dc.outcome.${o}`, o) : '');
const verdictLabel = (v: string | null) => t(`dc.verdict.${v ?? 'none'}`, v ?? 'none');
const statusLabel = (s: string) => t(`rm.st.${s}`, s.replace(/_/g, ' '));

export function decisionErrMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const specific = t(`dc.err.${e.code}`, '');
    const allowed = (e.details as { allowed?: string[] } | null)?.allowed;
    const tail = e.code === 'DECISION_LIFECYCLE_CONFLICT' && Array.isArray(allowed) && allowed.length ? ` ${t('dc.allowedNext')}: ${allowed.map(statusLabel).join(', ')}` : '';
    if (specific) return `${specific}${tail}`;
    if (/VERSION_CONFLICT$/.test(e.code)) return t('common.conflict');
    if (e.code === 'RATE_LIMITED') return t('rm.errRateLimited');
    return e.message;
  }
  return e instanceof Error ? e.message : 'failed';
}

type RefKey = `${DecisionEvidenceRefKind}:${string}`;
const refKey = (kind: DecisionEvidenceRefKind, id: string): RefKey => `${kind}:${id}`;

export function DecisionWorkflow({ session, room, notify, reload }: Props) {
  const [data, setData] = useState<DecisionSurface | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState('');
  // Draft form state — mirrors the server draft; saved explicitly.
  const [outcome, setOutcome] = useState<DecisionOutcome | ''>('');
  const [codes, setCodes] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [refs, setRefs] = useState<RefKey[]>([]);
  const [supersessionReason, setSupersessionReason] = useState('');

  const load = useCallback(async () => {
    try {
      const d = await rooms.decision(session, room.roomId);
      setData(d); setError(null);
      const dr = d.draft;
      setOutcome((dr?.outcome as DecisionOutcome | null) ?? '');
      setCodes(dr?.reasonCodes ?? []);
      setNote(dr?.note ?? '');
      setRefs((dr?.evidenceRefs ?? []).map((r) => refKey(r.kind, r.id)));
    } catch (e) { setError(decisionErrMessage(e)); }
  }, [session, room.roomId]);
  useEffect(() => { void load(); }, [load, room.rev]);

  const run = async (fn: () => Promise<string>) => {
    if (busy) return;
    setBusy(true);
    try { const msg = await fn(); setLive(msg); notify(msg); await load(); }
    catch (e) { const msg = decisionErrMessage(e); setLive(msg); notify(msg, true); await load(); }
    finally { setBusy(false); }
  };

  if (error) return <div className="notice block" role="status">{error}</div>;
  if (!data) return <div className="dim">{t('common.loading')}</div>;

  const req = data.requirements;
  const draft = data.draft;
  const current = data.current;
  const refsInput = refs.map((k) => { const i = k.indexOf(':'); return { kind: k.slice(0, i) as DecisionEvidenceRefKind, id: k.slice(i + 1) }; });
  const toggleRef = (k: RefKey) => setRefs((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));
  const toggleCode = (c: string) => setCodes((s) => (s.includes(c) ? s.filter((x) => x !== c) : [...s, c]));

  const openDraft = () => run(async () => {
    await rooms.createDecisionDraft(session, room.roomId, { clientKey: `dc-draft-${room.roomId}-${Date.now()}` });
    return t('dc.draftOpened');
  });
  const saveDraft = () => run(async () => {
    if (!draft) return t('dc.noDraft');
    await rooms.updateDecisionDraft(session, room.roomId, { outcome: outcome || null, reasonCodes: codes, note: note.trim() || null, evidenceRefs: refsInput, expectedRev: draft.rev });
    return t('dc.saved');
  });
  const discardDraft = () => run(async () => {
    if (!draft) return t('dc.noDraft');
    if (!confirmDestructive({ ...DESTRUCTIVE_ACTIONS.discardDecisionDraft })) return t('dc.kept');
    await rooms.discardDecisionDraft(session, room.roomId, draft.rev);
    return t('dc.discarded');
  });
  const finalize = () => run(async () => {
    if (!draft) return t('dc.noDraft');
    if (!outcome) return t('dc.err.DECISION_OUTCOME_INVALID');
    // Save what is on screen first, so the finalized decision is the one the person is looking at.
    const saved = await rooms.updateDecisionDraft(session, room.roomId, { outcome, reasonCodes: codes, note: note.trim() || null, evidenceRefs: refsInput, expectedRev: draft.rev });
    const label = outcomeLabel(outcome);
    if (!confirmDestructive({ ...DESTRUCTIVE_ACTIONS.finalizeDecision, name: label })) return t('dc.notFinalized');
    const r = await rooms.finalizeDecision(session, room.roomId, {
      expectedRev: saved.draft.rev,
      clientKey: `dc-final-${room.roomId}-${saved.draft.id}`,
      ...(current ? { supersedes: current.id, supersedesRev: current.rev, supersessionReason: supersessionReason.trim() } : {}),
    });
    setSupersessionReason('');
    reload();
    return r.case && 'to' in r.case && r.case.to ? t('dc.finalizedMoved').replace('{status}', statusLabel(r.case.to)) : t('dc.finalized');
  });

  return (
    <div aria-label={t('dc.title')} data-testid="decision-workflow">
      <div role="status" aria-live="polite" className="dim" style={{ fontSize: 12.5, minHeight: 16 }}>{live}</div>

      {/* ---- the formal decision ---- */}
      <div className="section" aria-label={t('dc.title')}>
        <h4>{t('dc.title')}</h4>
        <div className="dim" style={{ fontSize: 12.5, marginBottom: 6 }}>{t('dc.intro')}</div>
        {current ? <DecisionCard d={current} /> : (
          <div className="dim" data-testid="decision-none">{t('dc.none')}{data.advisory ? ` ${t('dc.advisoryOnly').replace('{rec}', t(`rm.rec.${data.advisory.recommendation ?? ''}`, data.advisory.recommendation ?? ''))}` : ''}</div>
        )}
        {data.blocked && <div className="notice block" role="status" style={{ marginTop: 6 }}>{t('dc.blocked')}</div>}
        {data.subjectRemoved && <div className="notice block" role="status" style={{ marginTop: 6 }}>{t('dc.subjectRemoved')}</div>}
        {!req.canFinalize && !data.subjectRemoved && <div className="dim" style={{ fontSize: 12.5, marginTop: 6 }}>{t('dc.readOnly')}</div>}
      </div>

      {/* ---- readiness: what exists, what the case can take ---- */}
      <div className="section" aria-label={t('dc.readiness')}>
        <h4>{t('dc.readiness')}</h4>
        <div className="list-rows">
          <div className="list-row"><span className="grow">{t('dc.inputs.assessments')}</span><span data-testid="dc-submitted">{req.inputs.submittedAssessments}</span></div>
          <div className="list-row"><span className="grow">{t('dc.inputs.trials')}</span><span data-testid="dc-trials">{req.inputs.completedTrials}</span></div>
          {req.outcomes.map((o) => (
            <div className="list-row" key={o.outcome} data-outcome-availability={o.outcome} data-possible={o.possible ? '1' : '0'}>
              <span className="grow">{outcomeLabel(o.outcome)} <span className="dim">→ {statusLabel(o.to)}</span></span>
              <span className="pill">{o.alreadyThere ? t('dc.avail.alreadyThere') : o.possible ? `✓ ${t('dc.avail.possible')}` : `○ ${t(`dc.avail.${o.reason ?? 'transition'}`)}`}</span>
            </div>
          ))}
        </div>
        <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>{t('dc.readinessNote')}</div>
      </div>

      {/* ---- assessments: independent, summarised, never averaged ---- */}
      <div className="section" aria-label={t('dc.assessments')}>
        <h4>{t('dc.assessments')} ({data.assessments.submitted})</h4>
        <div className="dim" style={{ fontSize: 12.5, marginBottom: 4 }}>{t('dc.assessmentsNote')}</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }} data-testid="dc-verdicts">
          {(['sign', 'monitor', 'pass'] as const).map((v) => <span key={v} className="pill" data-verdict={v}>{verdictLabel(v)}: {data.assessments.verdicts[v]}</span>)}
          {data.assessments.withheld > 0 && <span className="pill">{t('dc.withheld').replace('{n}', String(data.assessments.withheld))}</span>}
        </div>
        {data.assessments.disagreement?.kind === 'verdicts_differ' && (
          <div className="notice block" role="status" data-testid="dc-disagreement">{t('dc.disagreement').replace('{verdicts}', data.assessments.disagreement.verdicts.map(verdictLabel).join(' / '))}</div>
        )}
        {data.assessments.disagreement?.kind === 'unanimous' && <div className="dim" style={{ fontSize: 12.5 }}>{t('dc.unanimous')}</div>}
        <div className="list-rows">
          {data.assessments.assessments.map((a) => (
            <div key={a.id} className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch' }} data-assessment-id={a.id}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <span className="grow"><b>{a.scoutName ?? '—'}</b> <span className="dim">· {a.submittedAt ? fmtDateTime(a.submittedAt) : t('dc.state.draft')}{a.trialId ? ` · ${t('dc.inTrial')}` : ''}</span></span>
                <span className="pill" data-verdict={a.verdict ?? 'none'}>{verdictLabel(a.verdict)}</span>
              </div>
              <div className="dim" style={{ fontSize: 12 }}>
                {t('dc.rated').replace('{n}', String(a.rated))} · {t('dc.notObserved').replace('{n}', String(a.notObserved))} · {t('dc.confidence')}: {a.confidence.high}/{a.confidence.medium}/{a.confidence.low} · {t('dc.refs').replace('{n}', String(a.evidenceRefs))}
              </div>
            </div>
          ))}
          {data.assessments.assessments.length === 0 && <div className="dim">{t('dc.noAssessments')}</div>}
        </div>
      </div>

      {/* ---- draft ---- */}
      {req.canDraft && (
        <div className="section" aria-label={t('dc.draft')} data-testid="decision-draft">
          <h4>{t('dc.draft')}</h4>
          {!draft && <button className="primary" onClick={openDraft} disabled={busy}>{t('dc.openDraft')}</button>}
          {draft && (
            <form onSubmit={(e) => { e.preventDefault(); void saveDraft(); }} aria-label={t('dc.draftForm')}>
              <div className="notice block" role="status" data-testid="draft-label"><b>{t('dc.draftLabel')}</b> <span className="dim">· {draft.by?.name ?? ''} · {t('tr.rev')} {draft.rev}</span></div>
              <fieldset style={{ border: 0, padding: 0, margin: '8px 0' }}>
                <legend style={{ fontSize: 13, fontWeight: 700 }}>{t('dc.outcomeLabel')}</legend>
                {(['progress', 'hold', 'reject'] as DecisionOutcome[]).map((o) => (
                  <label key={o} style={{ display: 'block', fontSize: 13, padding: '4px 0' }}>
                    <input type="radio" name="dc-outcome" value={o} checked={outcome === o} onChange={() => setOutcome(o)} aria-label={outcomeLabel(o)} /> {outcomeLabel(o)}
                    <span className="dim"> — {t(`dc.outcomeHint.${o}`)}</span>
                  </label>
                ))}
              </fieldset>
              <div aria-label={t('dc.reasons')}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{t('dc.reasons')}</div>
                <div className="dim" style={{ fontSize: 12.5 }}>{t('dc.reasonsNote')}</div>
                {Object.entries(data.vocabulary.reasonCategories).map(([cat, list]) => (
                  <div key={cat} style={{ marginBottom: 4 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700 }}>{t(`rm.reasonCat.${cat}`, cat)}</div>
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                      {list.map((code) => (
                        <label key={code} style={{ fontSize: 12.5 }}><input type="checkbox" checked={codes.includes(code)} onChange={() => toggleCode(code)} aria-label={reasonLabel(code)} /> {reasonLabel(code)}</label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <label style={{ display: 'block', fontSize: 13, marginTop: 8 }}>
                {t('dc.rationale')}
                <textarea style={{ width: '100%', minHeight: 64, marginTop: 4 }} aria-label={t('dc.rationale')} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
              </label>
              <div className="dim" style={{ fontSize: 12 }}>{t('dc.rationaleNote')}</div>

              <div style={{ marginTop: 8 }} aria-label={t('dc.cite')}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{t('dc.cite')}</div>
                <div className="dim" style={{ fontSize: 12.5 }}>{t('dc.evidenceNote')}</div>
                {data.evidence.assessments.map((a) => (
                  <label key={a.id} style={{ display: 'block', fontSize: 12.5 }}><input type="checkbox" checked={refs.includes(refKey('assessment', a.id))} onChange={() => toggleRef(refKey('assessment', a.id))} aria-label={`${t('dc.ev.assessment')} ${a.scoutName ?? a.id}`} /> {t('dc.ev.assessment')} · {a.scoutName ?? a.id} · {verdictLabel(a.verdict)}</label>
                ))}
                {data.evidence.trials.map((tr) => (
                  <label key={tr.id} style={{ display: 'block', fontSize: 12.5 }}><input type="checkbox" checked={refs.includes(refKey('trial', tr.id))} onChange={() => toggleRef(refKey('trial', tr.id))} aria-label={`${t('dc.ev.trial')} ${tr.id}`} /> {t('dc.ev.trial')} · {t(`tr.state.${tr.workflowState}`, tr.workflowState)} · {tr.sessionCount} {t('tr.sessions').toLowerCase()}</label>
                ))}
                {data.evidence.boxCam.map((b) => (
                  <label key={b.id} style={{ display: 'block', fontSize: 12.5 }}><input type="checkbox" checked={refs.includes(refKey('box_cam_session', b.id))} onChange={() => toggleRef(refKey('box_cam_session', b.id))} aria-label={`${t('dc.ev.boxCam')} ${b.id}`} /> {t('dc.ev.boxCam')} · {t(`tr.obs.${b.observation}`, b.observation)}{b.simulated ? ` · ${t('tr.simulated')}` : ''} · <span className="dim">{t('tr.combineVerifiedNo')}</span></label>
                ))}
                {data.evidence.passport.map((p) => (
                  <label key={p.id} style={{ display: 'block', fontSize: 12.5 }}><input type="checkbox" checked={refs.includes(refKey('passport_evidence', p.id))} onChange={() => toggleRef(refKey('passport_evidence', p.id))} aria-label={`${t('dc.ev.passport')} ${p.label ?? p.id}`} /> {t('dc.ev.passport')} · {p.label ?? p.claimType ?? p.id} · <span className="dim">{p.provenance}</span></label>
                ))}
                {data.evidence.assessments.length + data.evidence.trials.length + data.evidence.boxCam.length + data.evidence.passport.length === 0 && <div className="dim" style={{ fontSize: 12.5 }}>{t('dc.noEvidence')}</div>}
              </div>

              {current && (
                <label style={{ display: 'block', fontSize: 13, marginTop: 8 }}>
                  {t('dc.supersessionReason')}
                  <input style={{ width: '100%', marginTop: 4 }} aria-label={t('dc.supersessionReason')} value={supersessionReason} maxLength={500} onChange={(e) => setSupersessionReason(e.target.value)} />
                </label>
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                <button type="submit" disabled={busy}>{t('dc.save')}</button>
                <button type="button" onClick={discardDraft} disabled={busy}>{t('dc.discard')}</button>
                <button type="button" className="primary" onClick={finalize} disabled={busy || !outcome || (!!current && !supersessionReason.trim())} data-testid="dc-finalize">
                  {current ? t('dc.finalizeReplace') : t('dc.finalize')}
                </button>
              </div>
              <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>{t('dc.finalizeNote')}</div>
            </form>
          )}
        </div>
      )}

      {/* ---- M23 P5.6E: the transaction handoff ---- */}
      <HandoffSection session={session} room={room} notify={notify} />

      {/* ---- history ---- */}
      <div className="section" aria-label={t('dc.history')}>
        <h4>{t('dc.history')}</h4>
        {data.history.length === 0 && <div className="dim">{t('dc.none')}</div>}
        <div className="list-rows">
          {data.history.map((d) => <DecisionCard key={d.id} d={d} compact />)}
        </div>
        {data.omitted > 0 && <div className="dim" style={{ fontSize: 12 }}>{t('dc.omitted').replace('{n}', String(data.omitted))}</div>}
        <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{t('rm.decisionAppendOnly')}</div>
      </div>
    </div>
  );
}

/**
 * M23 P5.6E §32/§38 — the club's transaction-handoff entrypoint.
 *
 * It sits below the decision because it FOLLOWS one, and it is a separate,
 * explicit act: ScoutBox never opens a workspace because a decision said
 * "progress". The control appears only when the server says every precondition
 * is met, and every refusal is a code the screen words — the decision's reasons,
 * its note and its evidence never reach this component, because they are not in
 * what the server sends it.
 *
 * "Visibility of button is not authorization": pressing it asks the server,
 * which checks everything again.
 */
function HandoffSection({ session, room, notify }: { session: Props['session']; room: Props['room']; notify: Props['notify'] }) {
  const [data, setData] = useState<HandoffSurface | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setData(await rooms.handoff(session, room.roomId)); setError(null); } catch (e) { setError(decisionErrMessage(e)); }
  }, [session, room.roomId]);
  useEffect(() => { void load(); }, [load, room.rev]);
  if (error) return <div className="section" aria-label={t('hof.title')}><h4>{t('hof.title')}</h4><div className="notice block">{error}</div></div>;
  if (!data) return null;
  const h = data.handoff;
  const act = async (fn: () => Promise<unknown>, okKey: string) => {
    setBusy(true); setError(null);
    try { await fn(); notify(t(okKey)); await load(); } catch (e) { setError(decisionErrMessage(e)); } finally { setBusy(false); }
  };
  return (
    <div className="section" aria-label={t('hof.title')} data-testid="handoff-section" data-available={data.available ? '1' : '0'}>
      <h4>{t('hof.title')}</h4>
      <div className="dim" style={{ fontSize: 12.5, marginBottom: 8 }}>{t('hof.intro')}</div>
      {h && (
        <div className="badges" style={{ marginBottom: 8 }} data-testid="handoff-state" data-status={h.status}>
          <span className={`pill ${h.status === 'accepted' ? 'blue' : h.status === 'invited' ? 'gold' : ''}`}>{t(`hof.${h.status}`, h.status)}</span>
          <span className="dim" style={{ fontSize: 12 }}>{h.representedAtInvitation ? t('hof.represented') : t('hof.notRepresented')}</span>
        </div>
      )}
      {!data.available && data.blockers.length > 0 && (
        <div className="notice block" role="status" style={{ marginBottom: 8 }} data-testid="handoff-blockers">
          {t('hof.blocked')}
          <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
            {data.blockers.map((b) => <li key={b} data-testid={`handoff-blocker-${b}`}>{t(`hof.b.${b}`, b)}</li>)}
          </ul>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {data.available && (
          <button className="primary" disabled={busy} onClick={() => act(() => rooms.inviteHandoff(session, room.roomId, { clientKey: `hof-${Date.now().toString(36)}` }), 'hof.invited')} data-testid="handoff-invite">{t('hof.invite')}</button>
        )}
        {h?.status === 'invited' && (
          <button disabled={busy} onClick={() => act(() => rooms.withdrawHandoff(session, room.roomId), 'hof.withdrawn')} data-testid="handoff-withdraw">{t('hof.withdraw')}</button>
        )}
      </div>
      <div className="dim" style={{ fontSize: 12, marginTop: 8 }}>{h?.honest ?? t('hof.honest')}</div>
    </div>
  );
}

function DecisionCard({ d, compact = false }: { d: FormalDecision; compact?: boolean }) {
  const formal = d.kind === 'formal';
  return (
    <div className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch' }} data-decision-id={d.id} data-outcome={d.outcome ?? undefined} data-kind={d.kind}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <span className="grow">
          <b>{formal ? outcomeLabel(d.outcome) : t(`rm.rec.${d.recommendation ?? ''}`, d.recommendation ?? '')}</b>
          {!formal && <span className="dim"> · {t('dc.advisory')}</span>}
          <span className="dim"> · {d.by?.name ?? ''}{d.by?.role ? ` (${d.by.role})` : ''} · {d.finalizedAt ? fmtDateTime(d.finalizedAt) : ''}</span>
        </span>
        {formal && <span className="pill green" data-state={d.state}>{t('dc.state.final')}</span>}
        {d.supersededById && <span className="pill">{t('rm.superseded')}</span>}
      </div>
      {d.reasonCodes.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
          {d.reasonCodes.map((c) => <span key={c} className="pill">{reasonLabel(c)}</span>)}
        </div>
      )}
      {formal && d.lifecycle && (
        <div className="dim" style={{ fontSize: 12.5, marginTop: 4 }}>
          {d.lifecycle.applied ? t('dc.caseEffect').replace('{status}', statusLabel(d.lifecycle.to)) : t('dc.caseUnchanged').replace('{status}', statusLabel(d.lifecycle.to))}
        </div>
      )}
      {formal && <div className="dim" style={{ fontSize: 12.5 }}>{t('dc.evidenceCount').replace('{n}', String(d.evidenceCount))}{d.assessmentSummary ? ` · ${t('dc.assessmentsAtDecision').replace('{n}', String(d.assessmentSummary.submitted))}` : ''}</div>}
      {formal && d.supersession && <div className="dim" style={{ fontSize: 12.5 }}>{t('dc.supersession').replace('{reason}', d.supersession.reason ?? '')}</div>}
      {!compact && d.note && <div className="dim" style={{ fontSize: 12.5, marginTop: 4 }} data-testid="dc-rationale">“{d.note}”</div>}
      {compact && d.hasNote && <div className="dim" style={{ fontSize: 12 }}>{t('dc.hasRationale')}</div>}
    </div>
  );
}
