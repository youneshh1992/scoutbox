// M12 org screens: Assessments (with offline drafts), Recruitment cases,
// Squad Planner, Opportunities, Campaigns, Video Workspace, Outcomes,
// Trial Days — plus the Evidence Passport panel.
// Accessibility: every interactive control carries a label, status changes
// announce via aria-live, and everything operates by keyboard.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Session } from './api';
import {
  m12, type Assessment, type AssessmentRating, type CaseRec, type Campaign,
  type Candidate, type CompareResult, type FollowUp, type Objective,
  type Opportunity, type Passport, type Playlist, type Segment, type StaffRow,
  type TrialDay, type Vacancy,
} from './m12api';
import { fmtDate, fmtDateTime, t } from './i18n';
import { confirmDestructive, DESTRUCTIVE_ACTIONS } from './confirmAction';

type ScreenProps = { session: Session; tick: number; notify: (text: string, error?: boolean) => void; openPlayer: (id: string) => void };

const tierPill = (tier: string) =>
  tier === 'independent' ? 'gold' : tier === 'club_assessed' ? 'green' : tier === 'coach_confirmed' ? 'blue' : '';

function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): [T | null, () => void] {
  const [v, setV] = useState<T | null>(null);
  const [bump, setBump] = useState(0);
  useEffect(() => {
    let live = true;
    fn().then((x) => live && setV(x)).catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, bump]);
  return [v, () => setBump((b) => b + 1)];
}

// ------------------------------------------------------- evidence passport
export function PassportPanel({ session, playerId, notify }: { session: Session; playerId: string; notify: ScreenProps['notify'] }) {
  const [pp, reload] = useAsync<Passport>(() => m12.getPassport(session, playerId), [playerId]);
  if (!pp) return <div className="notice">{t('common.loading')}</div>;
  return (
    <div className="section" aria-label={t('passport.title')}>
      <h3>{t('passport.title')}</h3>
      <div className="notice" style={{ fontSize: 12.5 }}>{pp.summary.note}</div>
      {pp.summary.insufficient && <div className="notice block">⚠️ {t('passport.insufficient')}</div>}
      <div className="list-rows">
        {pp.records.map((r) => (
          <div key={r.id} className="list-row" style={{ opacity: r.superseded ? 0.55 : 1 }}>
            <span className="grow">
              <b>{r.label}</b>{r.value != null && <> — {String(r.value)}{r.units ? ` ${r.units}` : ''}</>}
              {r.season && <span className="dim"> · {r.season}</span>}
              {r.superseded && <span className="pill red" style={{ marginLeft: 6 }}>superseded</span>}
              {r.correctionOf && <span className="pill" style={{ marginLeft: 6 }}>correction</span>}
              {(r.openDisputes ?? 0) > 0 && <span className="pill red" style={{ marginLeft: 6 }}>disputed</span>}
              <div className="dim">
                {r.verification.status.replace('_', ' ')}{r.verification.method ? ` · ${r.verification.method}` : ''}
                {r.verification.reviewerName ? ` · by ${r.verification.reviewerName}` : ''} · {r.freshness?.ageDays ?? 0}d old
              </div>
            </span>
            {!r.superseded && r.verification.status === 'self_reported' && (
              <button aria-label={`${t('passport.corroborate')} ${r.label}`} onClick={async () => {
                try { await m12.corroborateEvidence(session, r.id); notify('✅ Corroborated — tier upgraded.'); reload(); }
                catch (e) { notify(e instanceof Error ? e.message : 'Failed', true); }
              }}>{t('passport.corroborate')}</button>
            )}
            {!r.superseded && (
              <button aria-label={`${t('passport.dispute')} ${r.label}`} onClick={async () => {
                const reason = window.prompt('Dispute reason (goes to Trust & Safety):');
                if (!reason) return;
                try { await m12.disputeEvidence(session, r.id, reason); notify('Dispute filed with Trust & Safety.'); reload(); }
                catch (e) { notify(e instanceof Error ? e.message : 'Failed', true); }
              }}>{t('passport.dispute')}</button>
            )}
            <span className={`pill ${tierPill(r.verification.status)}`}>{r.verification.status.replace('_', ' ')}</span>
          </div>
        ))}
        {pp.legacy.map((l, i) => (
          <div key={i} className="list-row">
            <span className="grow">
              {l.label}
              {l.conflictOfInterest && <div className="dim">Declared: {l.conflictOfInterest}</div>}
              {l.caveat && <div className="dim">⚠︎ {l.caveat}</div>}
            </span>
            <span className={`pill ${tierPill(l.tier)}`}>{l.tier.replace('_', ' ')}</span>
          </div>
        ))}
        {pp.records.length + pp.legacy.length === 0 && <div className="notice">{t('common.none')}</div>}
      </div>
    </div>
  );
}

// ------------------------------------------------ assessments + offline drafts
type Draft = { ratings: AssessmentRating[]; recommendation: { verdict: string; reasons: string }; savedAt: number; baseState: string };
const draftKey = (s: Session, aid: string) => `sbdraft:${s.org.id}:${s.userId}:${aid}`;
const loadDraft = (s: Session, aid: string): Draft | null => {
  try { const raw = localStorage.getItem(draftKey(s, aid)); return raw ? JSON.parse(raw) : null; } catch { return null; }
};

export function AssessmentsScreen({ session, tick, notify }: ScreenProps) {
  const [playerId, setPlayerId] = useState('');
  const [players, setPlayers] = useState<{ id: string; name: string }[]>([]);
  const [list, reload] = useAsync<Assessment[]>(() => m12.listAssessments(session, playerId || undefined), [tick, playerId]);
  const [editing, setEditing] = useState<Assessment | null>(null);
  const [compare, setCompare] = useState<CompareResult | null>(null);

  useEffect(() => { api.searchPlayers(session, {}).then((ps) => setPlayers(ps.map((p) => ({ id: p.id, name: p.name })))).catch(() => {}); }, [session]);

  const openEditor = async (a?: Assessment) => {
    if (a) return setEditing(a);
    if (!playerId) return notify('Pick a player first.', true);
    try { setEditing(await m12.createAssessment(session, playerId)); reload(); }
    catch (e) { notify(e instanceof Error ? e.message : 'Failed', true); }
  };

  return (
    <div>
      <div className="filters" role="toolbar" aria-label="Assessment filters">
        <select aria-label="Player" value={playerId} onChange={(e) => { setPlayerId(e.target.value); setCompare(null); }}>
          <option value="">All players</option>
          {players.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button className="primary" onClick={() => openEditor()}>{t('assess.new')}</button>
        {playerId && <button onClick={async () => setCompare(await m12.compareAssessments(session, playerId))}>{t('assess.compare')}</button>}
      </div>
      <div className="notice" style={{ fontSize: 12.5 }}>{t('assess.blindNote')}</div>
      {playerId && <PassportPanel session={session} playerId={playerId} notify={notify} />}
      {compare && <ComparePanel compare={compare} onClose={() => setCompare(null)} />}
      {editing && <AssessmentEditor session={session} assessment={editing} notify={notify} onClose={() => { setEditing(null); reload(); }} />}
      <div className="list-rows" aria-live="polite">
        {(list ?? []).map((a) => {
          const draft = loadDraft(session, a.id);
          return (
            <div key={a.id} className="list-row">
              <span className="grow">
                <b>{a.playerName}</b> · {a.scoutName} · v{a.templateVersion}
                {a.secondOpinionOf && <span className="pill blue" style={{ marginLeft: 6 }}>2nd opinion</span>}
                <div className="dim">{a.context.fixture ?? '—'} · {a.context.viewing ?? ''} {a.context.minutesWatched ? `· ${a.context.minutesWatched} min` : ''}</div>
              </span>
              {draft && a.state === 'draft' && <span className="pill gold">{t('assess.draftSaved')} · {t('assess.pendingSync')}</span>}
              {a.publishedFeedback && <span className="pill green">feedback published</span>}
              <span className={`pill ${a.state === 'draft' ? '' : 'blue'}`}>{a.state}</span>
              {a.state === 'draft' ? (
                <button onClick={() => openEditor(a)}>Edit</button>
              ) : !a.publishedFeedback && (
                <button aria-label={`${t('assess.publish')} for ${a.playerName}`} onClick={async () => {
                  const text = window.prompt('Feedback the player/guardian will actually see (this is the ONLY thing that leaves the club):');
                  if (!text) return;
                  try { await m12.publishFeedback(session, a.id, text); notify('📋 Feedback published to the player side.'); reload(); }
                  catch (e) { notify(e instanceof Error ? e.message : 'Failed', true); }
                }}>{t('assess.publish')}</button>
              )}
            </div>
          );
        })}
        {(list ?? []).length === 0 && <div className="notice">{t('common.none')}</div>}
      </div>
    </div>
  );
}

function ComparePanel({ compare, onClose }: { compare: CompareResult; onClose: () => void }) {
  return (
    <div className="section">
      <h3>{t('assess.compare')} <button onClick={onClose} style={{ float: 'right' }}>{t('common.close')}</button></h3>
      <div className="notice" style={{ fontSize: 12.5 }}>{compare.note}</div>
      <div style={{ overflowX: 'auto' }}>
        <table className="data">
          <thead><tr><th>Attribute</th>{compare.assessments.map((a) => <th key={a.id}>{a.scoutName}<div className="dim">{fmtDate(a.submittedAt)}</div></th>)}<th>Avg (observed)</th></tr></thead>
          <tbody>
            {compare.attributes.map((row) => (
              <tr key={row.attrId}>
                <td>{row.label}</td>
                {row.cells.map((c, i) => (
                  <td key={i}>{c.notObserved ? <span className="dim">{t('assess.notObserved')}</span> : <b>{c.rating}</b>}{c.confidence && !c.notObserved && <span className="dim"> · {c.confidence}</span>}</td>
                ))}
                <td>{row.average ?? <span className="dim">—</span>} <span className="dim">({row.observedCount} {t('assess.observedOf')})</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="list-rows" style={{ marginTop: 8 }}>
        {compare.assessments.map((a) => a.recommendation && (
          <div key={a.id} className="list-row"><span className="grow"><b>{a.scoutName}</b>: {a.recommendation.verdict} — {a.recommendation.reasons}</span></div>
        ))}
      </div>
    </div>
  );
}

function AssessmentEditor({ session, assessment, notify, onClose }: { session: Session; assessment: Assessment; notify: ScreenProps['notify']; onClose: () => void }) {
  const existing = loadDraft(session, assessment.id);
  const conflict = existing != null && existing.baseState !== assessment.state;
  const [ratings, setRatings] = useState<AssessmentRating[]>(
    existing?.ratings ?? assessment.attributesSnapshot.map((attr) => assessment.ratings.find((r) => r.attrId === attr.id) ?? ({ attrId: attr.id, rating: null, notObserved: false, confidence: 'medium', note: null, evidenceRefs: [] }))
  );
  const [verdict, setVerdict] = useState(existing?.recommendation.verdict ?? assessment.recommendation?.verdict ?? 'monitor');
  const [reasons, setReasons] = useState(existing?.recommendation.reasons ?? assessment.recommendation?.reasons ?? '');
  const [saveState, setSaveState] = useState<'idle' | 'local' | 'synced'>(existing ? 'local' : 'idle');

  // Offline drafts (F12C): every edit lands in identity-scoped local storage
  // first, so a dropped connection or closed laptop loses nothing.
  const persistLocal = useCallback((r: AssessmentRating[], v: string, re: string) => {
    try {
      localStorage.setItem(draftKey(session, assessment.id), JSON.stringify({ ratings: r, recommendation: { verdict: v, reasons: re }, savedAt: Date.now(), baseState: assessment.state } satisfies Draft));
      setSaveState('local');
    } catch { /* private mode: editor still works, drafts don't persist */ }
  }, [session, assessment]);

  const setRating = (attrId: string, patch: Partial<AssessmentRating>) => {
    setRatings((rs) => {
      const next = rs.map((r) => (r.attrId === attrId ? { ...r, ...patch } : r));
      persistLocal(next, verdict, reasons);
      return next;
    });
  };

  const syncToServer = async (submit: boolean) => {
    try {
      await m12.updateAssessment(session, assessment.id, { ratings, recommendation: { verdict, reasons } });
      if (submit) await m12.submitAssessment(session, assessment.id);
      try { localStorage.removeItem(draftKey(session, assessment.id)); } catch { /* fine */ }
      setSaveState('synced');
      notify(submit ? '✅ Assessment submitted — it is now immutable.' : 'Saved to the server.');
      if (submit) onClose();
    } catch (e) {
      notify(`${e instanceof Error ? e.message : 'Failed'} — ${t('assess.draftSaved')}.`, true);
    }
  };

  return (
    <div className="section" role="form" aria-label={`Assessment of ${assessment.playerName}`}>
      <h3>{assessment.playerName} <span className="dim">template v{assessment.templateVersion}</span>
        <span className="pill" style={{ marginLeft: 8 }} aria-live="polite">
          {saveState === 'local' ? `💾 ${t('assess.draftSaved')} · ${t('assess.pendingSync')}` : saveState === 'synced' ? `✓ ${t('assess.synced')}` : t('assess.draft')}
        </span>
        <button onClick={onClose} style={{ float: 'right' }}>{t('common.close')}</button>
      </h3>
      {conflict && <div className="notice block">⚠️ {t('assess.conflict')}</div>}
      {assessment.attributesSnapshot.map((attr) => {
        const r = ratings.find((x) => x.attrId === attr.id)!;
        return (
          <div key={attr.id} className="list-row" style={{ alignItems: 'flex-start' }}>
            <span className="grow">
              <b>{attr.label}</b>
              <div className="dim">1 — {attr.anchors['1']} · 3 — {attr.anchors['3']} · 5 — {attr.anchors['5']}</div>
            </span>
            <span role="radiogroup" aria-label={`${attr.label} rating`}>
              {[1, 2, 3, 4, 5].map((v) => (
                <button key={v} role="radio" aria-checked={r.rating === v} className={r.rating === v ? 'primary' : ''}
                  disabled={r.notObserved} onClick={() => setRating(attr.id, { rating: v, notObserved: false })}>{v}</button>
              ))}
            </span>
            <label style={{ fontSize: 12.5 }}>
              <input type="checkbox" checked={r.notObserved} onChange={(e) => setRating(attr.id, { notObserved: e.target.checked, rating: e.target.checked ? null : r.rating })} /> {t('assess.notObserved')}
            </label>
            <select aria-label={`${attr.label} ${t('assess.confidence')}`} value={r.confidence} onChange={(e) => setRating(attr.id, { confidence: e.target.value })}>
              {['low', 'medium', 'high'].map((c) => <option key={c}>{c}</option>)}
            </select>
          </div>
        );
      })}
      <div className="filters">
        <label>{t('assess.recommendation')}:
          <select aria-label={t('assess.recommendation')} value={verdict} onChange={(e) => { setVerdict(e.target.value); persistLocal(ratings, e.target.value, reasons); }}>
            {['sign', 'monitor', 'pass'].map((v) => <option key={v}>{v}</option>)}
          </select>
        </label>
        <input aria-label={t('common.reasons')} placeholder={t('common.reasons')} value={reasons} style={{ flex: 1 }}
          onChange={(e) => { setReasons(e.target.value); persistLocal(ratings, verdict, e.target.value); }} />
        <button onClick={() => syncToServer(false)}>{t('common.save')}</button>
        <button className="primary" onClick={() => syncToServer(true)}>{t('assess.submit')}</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------- recruitment cases
export function RecruitmentScreen({ session, tick, notify, openPlayer }: ScreenProps) {
  const [data, reload] = useAsync(() => m12.listCases(session), [tick]);
  const [staff] = useAsync<StaffRow[]>(() => m12.listStaff(session), [tick]);
  const [players, setPlayers] = useState<{ id: string; name: string }[]>([]);
  const [newPlayer, setNewPlayer] = useState('');
  useEffect(() => { api.searchPlayers(session, {}).then((ps) => setPlayers(ps.map((p) => ({ id: p.id, name: p.name })))).catch(() => {}); }, [session]);

  const act = (fn: () => Promise<unknown>, done: string) => fn().then(() => { notify(done); reload(); }).catch((e) => notify(e instanceof Error ? e.message : 'Failed', true));

  return (
    <div>
      <div className="filters">
        <select aria-label="Player for new case" value={newPlayer} onChange={(e) => setNewPlayer(e.target.value)}>
          <option value="">Player…</option>
          {players.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button className="primary" onClick={() => newPlayer && act(() => m12.createCase(session, newPlayer), 'Case opened.')}>{t('cases.newCase')}</button>
      </div>
      <div className="list-rows">
        {(data?.items ?? []).map((c) => (
          <CaseCard key={c.id} c={c} stages={data?.stages ?? []} session={session} staff={staff ?? []} act={act} openPlayer={openPlayer} />
        ))}
        {(data?.items ?? []).length === 0 && <div className="notice">{t('common.none')}</div>}
      </div>
      <div className="section">
        <h3>{t('cases.staff')}</h3>
        <div className="list-rows">
          {(staff ?? []).map((u) => (
            <div key={u.id} className="list-row">
              <span className="grow"><b>{u.name}</b> · {u.role} {u.lead && <span className="pill gold">lead</span>}</span>
              {u.removedAt ? <span className="pill red">access removed {fmtDate(u.removedAt)}</span> : u.id !== session.userId && (
                <button aria-label={`${t('cases.removeStaff')}: ${u.name}`} onClick={() => confirmDestructive({ ...DESTRUCTIVE_ACTIONS.removeStaff, name: u.name }) && act(() => m12.removeStaff(session, u.id), 'Access revoked — sessions, events and media links are dead.')}>{t('cases.removeStaff')}</button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function CaseCard({ c, stages, session, staff, act, openPlayer }: { c: CaseRec; stages: string[]; session: Session; staff: StaffRow[]; act: (fn: () => Promise<unknown>, done: string) => void; openPlayer: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="section" style={{ padding: 12 }}>
      <div className="list-row" style={{ border: 'none', padding: 0 }}>
        <button className="grow" style={{ textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer' }} aria-expanded={open} onClick={() => setOpen(!open)}>
          <b>{c.playerName}</b> <span className="dim">· {t('cases.owner')} {c.ownerName}</span>
          {c.restricted && <span className="pill red" style={{ marginLeft: 6 }}>{t('cases.restricted')}</span>}
          {c.decision && <span className="pill green" style={{ marginLeft: 6 }}>{c.decision.outcome} — {c.decision.byName}{c.decision.approvedBy ? ` (approved: ${c.decision.approvedBy})` : ''}</span>}
        </button>
        <span className={`pill ${c.priority === 'high' ? 'red' : ''}`}>{c.priority}</span>
        <select aria-label={`${t('cases.stage')} for ${c.playerName}`} value={c.stage} onChange={(e) => act(() => m12.setStage(session, c.id, e.target.value), `Stage → ${e.target.value}`)}>
          {stages.map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>
      {open && (
        <div style={{ marginTop: 8 }}>
          <button onClick={() => openPlayer(c.playerId)}>Open profile</button>{' '}
          <select aria-label={t('cases.assign')} defaultValue="" onChange={(e) => { if (e.target.value) act(() => m12.assignScout(session, c.id, e.target.value, 'Scout this player'), 'Assigned.'); e.target.value = ''; }}>
            <option value="">{t('cases.assign')}…</option>
            {staff.filter((u) => !u.removedAt).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>{' '}
          {!c.decision && (
            <button onClick={() => {
              const reasons = window.prompt('Decision reasons (kept forever):');
              if (!reasons) return;
              const outcome = window.prompt('Outcome: sign / monitor / pass', 'sign') ?? 'monitor';
              act(async () => {
                const r = await m12.decideCase(session, c.id, outcome, reasons);
                if (r.pending) throw new Error('Sent for lead approval — a sign decision needs a recruitment lead.');
              }, 'Decision recorded.');
            }}>{t('cases.decision')}</button>
          )}
          {c.assignments.length > 0 && <div className="dim" style={{ marginTop: 6 }}>{c.assignments.map((a) => `${a.name}: ${a.task}`).join(' · ')}</div>}
          {c.approvals.filter((a) => a.status === 'pending').map((a) => (
            <div key={a.id} className="list-row">
              <span className="grow">⏳ {a.requestedBy.name} requests <b>{a.decision.outcome}</b>: {a.decision.reasons}</span>
              <button onClick={() => act(() => m12.approveCase(session, c.id, a.id, true), 'Approved.')}>Approve</button>
              <button onClick={() => act(() => m12.approveCase(session, c.id, a.id, false), 'Rejected.')}>Reject</button>
            </div>
          ))}
          <div style={{ marginTop: 6 }}>
            <b style={{ fontSize: 12.5 }}>{t('cases.history')}</b>
            {c.history.slice(-6).map((h, i) => <div key={i} className="dim" style={{ fontSize: 12 }}>{fmtDateTime(h.at)} — {h.byName}: {h.action}{h.detail ? ` (${h.detail})` : ''}</div>)}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------- squad planner
export function SquadPlannerScreen({ session, tick, notify }: ScreenProps) {
  const [planner, reload] = useAsync(() => m12.squadPlanner(session), [tick]);
  const [vacancies] = useAsync<Vacancy[]>(() => m12.listVacancies(session), [tick]);
  const [cands, setCands] = useState<{ candidates: Candidate[]; note: string; roleName: string } | null>(null);

  const showCandidates = async (v: Vacancy) => {
    try {
      const r = await m12.vacancyCandidates(session, v.id);
      setCands({ candidates: r.candidates, note: r.note, roleName: r.role.name });
    } catch (e) { notify(e instanceof Error ? e.message : 'Failed', true); }
  };

  return (
    <div>
      <p className="pagehint">{t('planner.noScores')}</p>
      <div className="stat-grid">
        <div className="stat"><b>{planner?.formation ?? '—'}</b><span>{t('planner.formation')}</span></div>
        <div className="stat"><b>{planner?.roles.length ?? 0}</b><span>{t('planner.roles')}</span></div>
        <div className="stat"><b>{(vacancies ?? []).filter((v) => v.status === 'open').length}</b><span>{t('planner.vacancies')}</span></div>
        <div className="stat"><b>{planner?.shadow.length ?? 0}</b><span>{t('planner.shadow')}</span></div>
      </div>
      <div className="section">
        <h3>{t('planner.vacancies')}</h3>
        <div className="list-rows">
          {(vacancies ?? []).map((v) => (
            <div key={v.id} className="list-row">
              <span className="grow"><b>{v.roleName}</b>{v.notes && <span className="dim"> · {v.notes}</span>}</span>
              <span className={`pill ${v.status === 'open' ? 'green' : ''}`}>{v.status}</span>
              <button onClick={() => showCandidates(v)}>{t('planner.candidates')}</button>
            </div>
          ))}
          {(vacancies ?? []).length === 0 && <div className="notice">{t('common.none')}</div>}
        </div>
      </div>
      {cands && (
        <div className="section">
          <h3>{t('planner.candidates')} — {cands.roleName} <button style={{ float: 'right' }} onClick={() => setCands(null)}>{t('common.close')}</button></h3>
          <div className="list-rows">
            {cands.candidates.map((c) => (
              <div key={c.playerId} className="list-row" style={{ alignItems: 'flex-start' }}>
                <span className="grow">
                  <b>{c.name}</b> <span className="dim">{c.position} · {c.age}</span>
                  {c.caseId && <span className="pill blue" style={{ marginLeft: 6 }}>case open</span>}
                  <div style={{ fontSize: 12.5, marginTop: 4 }}>
                    {[...c.required, ...c.preferred].map((cr, i) => (
                      <span key={i} className={`pill ${cr.verdict === 'met' ? 'green' : cr.verdict === 'not_met' ? 'red' : ''}`} style={{ marginRight: 4 }} title={cr.source}>
                        {cr.key}: {t(cr.verdict === 'met' ? 'planner.met' : cr.verdict === 'not_met' ? 'planner.notMet' : 'planner.unknown')}
                      </span>
                    ))}
                  </div>
                  <div className="dim" style={{ fontSize: 11.5 }}>{c.required.map((cr) => `${cr.key}: ${cr.source}`).join(' · ')}</div>
                </span>
                <span className="pill">{c.requiredMet}/{c.requiredTotal} required</span>
                <button onClick={async () => { try { await m12.addShadow(session, c.playerId); notify('Added to shadow squad.'); reload(); } catch (e) { notify(e instanceof Error ? e.message : 'Failed', true); } }}>+ {t('planner.shadow')}</button>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="section">
        <h3>Squad & contracts</h3>
        <div className="list-rows">
          {(planner?.current ?? []).map((p) => (
            <div key={p.playerId} className="list-row">
              <span className="grow"><b>{p.name}</b> <span className="dim">{p.position ?? ''}</span></span>
              {p.contractUntil && <span className={`pill ${new Date(p.contractUntil).getTime() < Date.now() + 180 * 86400000 ? 'red' : ''}`}>contract to {p.contractUntil}</span>}
              <span className="pill">{p.source}</span>
            </div>
          ))}
          {(planner?.shadow ?? []).map((p) => (
            <div key={p.playerId} className="list-row" style={{ opacity: 0.85 }}>
              <span className="grow"><b>{p.name}</b> <span className="dim">{p.position ?? ''}</span></span>
              <span className="pill gold">{t('planner.shadow')}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------- opportunities
export function OpportunitiesScreen({ session, tick, notify }: ScreenProps) {
  const [list, reload] = useAsync<Opportunity[]>(() => m12.listOpportunities(session), [tick]);
  const [apps, setApps] = useState<{ opp: Opportunity; items: Awaited<ReturnType<typeof m12.listApplications>> } | null>(null);
  const [title, setTitle] = useState('');
  const [deadline, setDeadline] = useState('');

  const act = (fn: () => Promise<unknown>, done: string) => fn().then(() => { notify(done); reload(); if (apps) m12.listApplications(session, apps.opp.id).then((items) => setApps({ opp: apps.opp, items })); }).catch((e) => notify(e instanceof Error ? e.message : 'Failed', true));

  return (
    <div>
      <div className="filters">
        <input aria-label="Opportunity title" placeholder="Title (e.g. U23 open trial — attackers)" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: 1 }} />
        <input aria-label={t('common.deadline')} type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
        <button className="primary" onClick={() => title && deadline && act(async () => { await m12.createOpportunity(session, { title, type: 'trial', deadline }); setTitle(''); }, 'Opportunity published.')}>{t('opp.new')}</button>
      </div>
      <div className="list-rows">
        {(list ?? []).map((o) => (
          <div key={o.id} className="list-row">
            <span className="grow">
              <b>{o.title}</b> <span className="pill">{o.type}</span> <span className="pill">{o.category}</span>
              <div className="dim">{t('common.deadline')} {o.deadline} · {o.applications ?? 0} {t('opp.applications').toLowerCase()} · {o.outstanding ?? 0} outstanding</div>
            </span>
            <span className={`pill ${o.status === 'published' ? 'green' : ''}`}>{o.status}</span>
            <button onClick={async () => setApps({ opp: o, items: await m12.listApplications(session, o.id) })}>{t('opp.applications')}</button>
            {o.status === 'published' && <button onClick={() => act(() => m12.closeOpportunity(session, o.id), 'Closed.')}>{t('opp.close')}</button>}
          </div>
        ))}
        {(list ?? []).length === 0 && <div className="notice">{t('common.none')}</div>}
      </div>
      {apps && (
        <div className="section">
          <h3>{t('opp.applications')} — {apps.opp.title} <button style={{ float: 'right' }} onClick={() => setApps(null)}>{t('common.close')}</button></h3>
          <div className="list-rows">
            {apps.items.map((a) => (
              <div key={a.id} className="list-row">
                <span className="grow">
                  <b>{a.playerName}</b> <span className="dim">via {a.submittedBy.kind === 'guardian' ? `guardian ${a.submittedBy.name}` : 'player'}</span>
                  {a.note && <div className="dim">“{a.note}”</div>}
                  {a.outcome && <div className="dim">{a.outcome.decision} — {a.outcome.byName}{a.outcome.note ? `: ${a.outcome.note}` : ''}</div>}
                </span>
                <span className={`pill ${a.status === 'accepted' ? 'green' : a.status === 'declined' ? 'red' : ''}`}>{a.status}</span>
                <button onClick={async () => {
                  // M13 (F3): the club sees only a player/guardian-APPROVED
                  // verdict summary — never raw preferences or reasons.
                  const { m13 } = await import('./m13api');
                  try {
                    const r = await m13.applicationSuitability(session, a.id);
                    notify(r.summary
                      ? `🧭 Suitability (player-approved): ${r.summary.verdicts.map((v) => `${v.dimension} ${v.verdict === 'compatible' ? '✓' : v.verdict === 'conflict' ? '✗' : '?'}`).join(' · ')}`
                      : 'No suitability summary shared for this application.');
                  } catch (e) { notify(e instanceof Error ? e.message : 'failed', true); }
                }}>Suitability</button>
                {a.status === 'submitted' && <>
                  <button onClick={() => act(() => m12.resolveApplication(session, a.id, 'accepted', 'See you there.'), 'Accepted.')}>{t('opp.accept')}</button>
                  <button onClick={() => {
                    const note = window.prompt('A kind, useful reason (the player/guardian reads this):') ?? undefined;
                    act(() => m12.resolveApplication(session, a.id, 'declined', note), 'Declined with a reason.');
                  }}>{t('opp.decline')}</button>
                </>}
              </div>
            ))}
            {apps.items.length === 0 && <div className="notice">{t('common.none')}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------- campaigns
export function CampaignsScreen({ session, tick, notify }: ScreenProps) {
  const [list, reload] = useAsync<Campaign[]>(() => m12.listCampaigns(session), [tick]);
  const [queue, setQueue] = useState<{ camp: Campaign; rows: Awaited<ReturnType<typeof m12.reviewQueue>>['queue'] } | null>(null);
  const [title, setTitle] = useState('');
  const [deadline, setDeadline] = useState('');

  const act = (fn: () => Promise<unknown>, done: string) => fn().then(async () => {
    notify(done); reload();
    if (queue) setQueue({ camp: queue.camp, rows: (await m12.reviewQueue(session, queue.camp.id)).queue });
  }).catch((e) => notify(e instanceof Error ? e.message : 'Failed', true));

  return (
    <div>
      <p className="pagehint">{t('camp.fileVsHuman')}</p>
      <div className="filters">
        <input aria-label="Campaign title" placeholder="Title (e.g. Remote sprint assessment)" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: 1 }} />
        <input aria-label={t('common.deadline')} type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
        <button className="primary" onClick={() => title && deadline && act(async () => {
          await m12.createCampaign(session, { title, deadline, drills: [{ name: '30m sprint', instructions: 'Two cones 30m apart, one run per clip.', recording: { equipment: 'Any phone ≥720p', distance: 'Full run in frame', surface: 'Flat grass', camera: 'Fixed, side-on' } }], rubric: [{ criterion: 'Full run visible', guidance: 'Start and finish cones in frame' }] });
          setTitle('');
        }, 'Campaign published.')}>{t('camp.new')}</button>
      </div>
      <div className="list-rows">
        {(list ?? []).map((c) => (
          <div key={c.id} className="list-row">
            <span className="grow"><b>{c.title}</b><div className="dim">{c.drills.map((d) => d.name).join(' · ')} · {t('common.deadline')} {c.deadline} · {c.attemptsAllowed} attempts</div></span>
            <span className="pill">{c.submissions ?? 0} submissions</span>
            {(c.awaitingReview ?? 0) > 0 && <span className="pill gold">{c.awaitingReview} awaiting human review</span>}
            <button onClick={async () => setQueue({ camp: c, rows: (await m12.reviewQueue(session, c.id)).queue })}>{t('camp.queue')}</button>
          </div>
        ))}
        {(list ?? []).length === 0 && <div className="notice">{t('common.none')}</div>}
      </div>
      {queue && (
        <div className="section">
          <h3>{t('camp.queue')} — {queue.camp.title} <button style={{ float: 'right' }} onClick={() => setQueue(null)}>{t('common.close')}</button></h3>
          <div className="list-rows">
            {queue.rows.map((q) => (
              <div key={q.attempt.id} className="list-row">
                <span className="grow">
                  <b>{q.playerName}</b> · {q.attempt.drillName}
                  <div className="dim">{q.attempt.fileChecks.kind}: {q.attempt.fileChecks.passed ? 'passed (file only — drill unvalidated)' : q.attempt.fileChecks.issues.join('; ')}</div>
                </span>
                {q.attempt.mediaUrl && api.mediaUrl(q.attempt.mediaUrl) && <a href={api.mediaUrl(q.attempt.mediaUrl)!} target="_blank" rel="noreferrer">▶ view</a>}
                <button onClick={() => act(() => m12.reviewAttempt(session, q.attempt.id, 'accepted', undefined, 'Meets the rubric.'), 'Accepted.')}>{t('camp.accept')}</button>
                <button onClick={() => {
                  const reasons = window.prompt('What must they fix, and how do they resubmit?');
                  if (reasons) act(() => m12.reviewAttempt(session, q.attempt.id, 'returned', reasons), 'Returned with instructions.');
                }}>{t('camp.return')}</button>
              </div>
            ))}
            {queue.rows.length === 0 && <div className="notice">{t('common.none')}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------- video workspace
export function VideoScreen({ session, tick, notify, openPlayer }: ScreenProps) {
  const [segments, reload] = useAsync<Segment[]>(() => m12.listSegments(session), [tick]);
  const [playlists, reloadPl] = useAsync<Playlist[]>(() => m12.listPlaylists(session), [tick]);
  const [playing, setPlaying] = useState<Segment | null>(null);
  const [slow, setSlow] = useState(false);

  return (
    <div>
      <p className="pagehint">Annotations are private club workflow records stored against the source footage — never public comments, never a channel to a player. Mark segments from any profile's footage (open a player → their clips).</p>
      {playing && (
        <div className="section">
          <h3>{playing.note ?? playing.labels.join(', ')} <span className="dim">{playing.startS}s → {playing.endS}s</span>
            <button style={{ float: 'right' }} onClick={() => setPlaying(null)}>{t('common.close')}</button></h3>
          {api.mediaUrl(playing.mediaUrl ?? null) ? (
            <video
              key={playing.id} controls autoPlay style={{ width: '100%', maxHeight: 380, background: '#000' }}
              ref={(el) => { if (el) { el.playbackRate = slow ? 0.4 : 1; el.currentTime = playing.startS; } }}
              onTimeUpdate={(e) => { const v = e.currentTarget; if (v.currentTime > playing.endS) v.pause(); }}
              src={api.mediaUrl(playing.mediaUrl ?? null)!}
            />
          ) : <div className="notice">Source unavailable in this build — the annotation itself is shown.</div>}
          <label style={{ fontSize: 12.5 }}><input type="checkbox" checked={slow} onChange={(e) => setSlow(e.target.checked)} /> {t('video.slow')} (0.4×)</label>
        </div>
      )}
      <div className="section">
        <h3>{t('video.segments')}</h3>
        <div className="list-rows">
          {(segments ?? []).map((s) => (
            <div key={s.id} className="list-row">
              <span className="grow">
                <b>{s.eventType ?? s.labels[0] ?? 'segment'}</b> · {s.startS}s → {s.endS}s
                {s.note && <span className="dim"> · “{s.note}”</span>}
                <div className="dim">{s.labels.map((l) => `#${l}`).join(' ')} · {s.createdBy.name} · {fmtDate(s.createdAt)}</div>
              </span>
              <button onClick={() => openPlayer(s.playerId)}>profile</button>
              <button onClick={() => setPlaying(s)}>▶ play</button>
              <select aria-label="Add to playlist" defaultValue="" onChange={async (e) => {
                if (!e.target.value) return;
                await m12.addToPlaylist(session, e.target.value, s.id);
                notify('Added to playlist.'); reloadPl(); e.target.value = '';
              }}>
                <option value="">+ playlist…</option>
                {(playlists ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          ))}
          {(segments ?? []).length === 0 && <div className="notice">{t('common.none')}</div>}
        </div>
      </div>
      <div className="section">
        <h3>{t('video.playlists')} <button style={{ float: 'right' }} onClick={async () => {
          const name = window.prompt('Playlist name:');
          if (name) { await m12.createPlaylist(session, name); reloadPl(); }
        }}>+ {t('common.create')}</button></h3>
        <div className="list-rows">
          {(playlists ?? []).map((p) => (
            <div key={p.id} className="list-row"><span className="grow"><b>{p.name}</b></span><span className="pill">{p.segmentIds.length} segments</span></div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------- outcomes (F11 org)
export function OutcomesScreen({ session, tick, notify }: ScreenProps) {
  const [list, reload] = useAsync<FollowUp[]>(() => m12.listFollowUps(session), [tick]);
  const stateClass = (s: string) => s === 'confirmed' ? 'green' : s === 'disputed' ? 'red' : s === 'unknown_pending' ? 'gold' : '';
  return (
    <div>
      <p className="pagehint">Follow-ups are scheduled records that survive restarts. Reported ≠ confirmed: the player/guardian answers back, and "unknown" is counted as unknown.</p>
      <div className="list-rows">
        {(list ?? []).map((f) => (
          <div key={f.id} className="list-row">
            <span className="grow">
              <b>{f.playerName}</b> · {f.milestone} check-in · {t('out.due')} {fmtDate(f.dueAt)}
              {f.report && <div className="dim">{f.report.registrationStatus}{f.report.matchesPlayed != null ? ` · ${f.report.matchesPlayed} matches` : ''}{f.report.progression ? ` · ${f.report.progression}` : ''}</div>}
            </span>
            <span className={`pill ${stateClass(f.outcomeState)}`}>{f.outcomeState.replace('_', ' ')}</span>
            {!f.report && f.status !== 'scheduled' && (
              <button onClick={async () => {
                const reg = window.prompt('Registration status: registered / released / left / unknown', 'registered');
                if (!reg) return;
                const matches = window.prompt('Matches played (leave blank if no evidence):');
                try {
                  await m12.reportFollowUp(session, f.id, { registrationStatus: reg, matchesPlayed: matches ? Number(matches) : undefined });
                  notify('Outcome report filed — the player/guardian will confirm or dispute it.'); reload();
                } catch (e) { notify(e instanceof Error ? e.message : 'Failed', true); }
              }}>{t('out.report')}</button>
            )}
          </div>
        ))}
        {(list ?? []).length === 0 && <div className="notice">{t('common.none')}</div>}
      </div>
      <div className="section">
        <h3>Objectives shared with you</h3>
        <SharedObjectives session={session} tick={tick} notify={notify} />
      </div>
    </div>
  );
}

function SharedObjectives({ session, tick, notify }: { session: Session; tick: number; notify: ScreenProps['notify'] }) {
  const [players, setPlayers] = useState<{ id: string; name: string }[]>([]);
  const [rows, setRows] = useState<{ player: string; obj: Objective }[]>([]);
  useEffect(() => {
    api.searchPlayers(session, {}).then(async (ps) => {
      setPlayers(ps.map((p) => ({ id: p.id, name: p.name })));
      const all: { player: string; obj: Objective }[] = [];
      for (const p of ps.slice(0, 12)) {
        try { for (const o of await m12.playerObjectives(session, p.id)) all.push({ player: p.name, obj: o }); } catch { /* not visible */ }
      }
      setRows(all);
    }).catch(() => {});
  }, [session, tick]);
  void players;
  return (
    <div className="list-rows">
      {rows.map(({ player, obj }) => (
        <div key={obj.id} className="list-row">
          <span className="grow">
            <b>{player}</b>: {obj.objectives.map((o) => o.text).join(' · ')}
            <div className="dim">{obj.progress.length} progress entries · shared by the player/guardian (they can turn this off)</div>
          </span>
          {obj.reassessments.filter((r) => r.status === 'requested').map((r) => (
            <button key={r.id} onClick={async () => {
              const note = window.prompt('Reassessment outcome (point at the evidence):');
              if (!note) return;
              try { await m12.reassessmentOutcome(session, r.id, note); notify('Outcome recorded and sent.'); } catch (e) { notify(e instanceof Error ? e.message : 'Failed', true); }
            }}>🔁 record reassessment</button>
          ))}
        </div>
      ))}
      {rows.length === 0 && <div className="notice">Nothing shared with your club yet — sharing is the player's (or guardian's) call.</div>}
    </div>
  );
}

// ------------------------------------------------------------- trial days
export function TrialDaysScreen({ session, tick, notify }: ScreenProps) {
  const [trials, setTrials] = useState<{ id: string; playerName: string; proposedDate: string | null }[]>([]);
  const [day, setDay] = useState<TrialDay | null>(null);
  useEffect(() => {
    api.getTrials(session).then((ts) => setTrials((ts as unknown as { id: string; playerName: string; proposedDate: string | null }[]))).catch(() => {});
  }, [session, tick]);

  const refresh = async (id: string) => setDay(await m12.getTrialDay(session, id));
  const act = (fn: () => Promise<unknown>, done: string) => fn().then(() => { notify(done); if (day) refresh(day.id); }).catch((e) => notify(e instanceof Error ? e.message : 'Failed', true));

  return (
    <div>
      <p className="pagehint">{t('day.gateNote')}</p>
      <div className="list-rows">
        {trials.map((tr) => (
          <div key={tr.id} className="list-row">
            <span className="grow"><b>{tr.playerName}</b> · {tr.proposedDate ?? 'date TBC'}</span>
            <button onClick={() => refresh(tr.id)}>Manage day</button>
          </div>
        ))}
        {trials.length === 0 && <div className="notice">{t('common.none')}</div>}
      </div>
      {day && (
        <div className="section" aria-live="polite">
          <h3>{day.playerName} · {day.proposedDate ?? 'TBC'} {day.cancelled && <span className="pill red">cancelled</span>}
            <button style={{ float: 'right' }} onClick={() => setDay(null)}>{t('common.close')}</button></h3>
          <b style={{ fontSize: 13 }}>{t('day.staff')}</b>
          <div className="list-rows">
            {day.staff.map((s) => (
              <div key={s.id} className="list-row">
                <span className="grow"><b>{s.name}</b> · {s.role}<div className="dim">{s.check.kind ?? 'no check filed'}</div></span>
                <span className={`pill ${s.check.status === 'reviewed' ? 'green' : s.check.status === 'expired' || s.check.status === 'rejected' ? 'red' : 'gold'}`}>
                  {s.check.status === 'pending' ? t('day.checkPending') : s.check.status}
                </span>
              </div>
            ))}
          </div>
          <div className="filters" style={{ marginTop: 8 }}>
            <button onClick={() => {
              const name = window.prompt('Staff name:');
              const role = name && window.prompt('Role (e.g. Safeguarding Lead):');
              if (name && role) act(() => m12.addTrialStaff(session, day.id, { name, role, check: { kind: 'DBS (England & Wales)', ref: 'filed' } }), 'Staff added — check is PENDING until T&S review.');
            }}>{t('day.addStaff')}</button>
            <button onClick={() => {
              const address = window.prompt('Arrival address / gate:', day.arrival?.address ?? '');
              if (address != null) act(() => m12.setArrival(session, day.id, { address, time: day.arrival?.time ?? '09:30' }), 'Arrival details published to the family.');
            }}>{t('day.arrival')}</button>
            <button className="primary" onClick={() => act(() => m12.checkinTrial(session, day.id), '✅ Checked in — attendance recorded once, coach-signed.')}>{t('day.checkin')}</button>
            <button onClick={() => {
              const reason = window.prompt('Reason (families are notified):');
              const newDate = reason && window.prompt('New date (YYYY-MM-DD):');
              if (reason) act(() => m12.postponeTrial(session, day.id, reason, newDate ?? undefined), 'Postponed — everyone notified.');
            }}>{t('day.postpone')}</button>
            <button onClick={() => {
              const reason = window.prompt('Reason (families are notified):');
              if (reason) act(() => m12.cancelTrial(session, day.id, reason), 'Cancelled — everyone notified.');
            }}>{t('day.cancel')}</button>
          </div>
          <div className="dim" style={{ fontSize: 12.5, marginTop: 6 }}>
            Consents: {day.consents.length ? day.consents.map((c) => c.scope).join(', ') : 'none yet'} ·
            Check-ins: {day.checkins.length} ·
            Emergency contact: {day.emergency ? `${day.emergency.name} (event staff only — never in profiles)` : 'not provided'}
          </div>
          {day.statusEvents.map((e, i) => <div key={i} className="dim" style={{ fontSize: 12 }}>{e.kind} — {e.reason}{e.newDate ? ` → ${e.newDate}` : ''}</div>)}
        </div>
      )}
    </div>
  );
}
