// M21 — the Development Hub, inside a player.
//
// It is reached from a player, which is where a development plan belongs, and
// it adds NO top-level destination (§54). The nav inventory is unchanged, and
// `navConfig.test.mjs` proves it.
//
// Three things this panel refuses to draw, each of which is the easy thing:
//
//   • a progress bar over the plan. "3 of 5 actions completed" is a count of a
//     to-do list; the same three numbers drawn as a filled bar reads as a
//     measure of the player, and there is no honest way to draw it;
//   • a tick on a simulated Combine result. The target says which of the three
//     states it is in and why, in the server's own words;
//   • the internal note on any surface the player can reach. Club-side it is
//     shown, clearly marked as staying inside the club — because a coach
//     needs to know which half of what they wrote the player will read.
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Session } from './api';
import {
  m21, type DevelopmentPlanView, type DevelopmentCatalogue, type GoalView,
  type ActionView, type EvidenceView, type ReviewView, type TargetView,
  type Result, type PlanStatus,
} from './m21Api';
import { conflictOf, ConflictNotice, type Conflict } from './conflict';
import { provenanceOf } from './provenance';
import { t, fmtDate, fmtStamp } from './i18n';
import { httpMessage } from './httpState';

const label = (key: string, fallback: string) => t(key, fallback);
const goalStatus = (s: string) => label(`m21.goal.${s}`, s.replace(/_/g, ' '));
const actionStatus = (s: string) => label(`m21.act.${s}`, s.replace(/_/g, ' '));

const dueText = (d: { state: string; days: number | null }): string | null => {
  switch (d.state) {
    case 'overdue': return `${t('m21.overdue')} · ${d.days}d`;
    case 'due_today': return t('m21.dueToday');
    case 'due_soon':
    case 'upcoming': return `${t('m21.dueIn')} ${d.days}d`;
    default: return null;
  }
};

function Pill({ children, tone }: { children: ReactNode; tone?: string }) {
  return <span className={`pill${tone ? ` ${tone}` : ''}`}>{children}</span>;
}

/** A refusal the server explained. Shown as its explanation, not as an error. */
function Refused({ refusal }: { refusal: { error: string; detail: string } }) {
  return (
    <div className="notice block" role="status" data-refusal={refusal.error} style={{ marginTop: 8 }}>
      <div style={{ fontWeight: 700 }}>{label(`m21.err.${refusal.error}`, t('m21.err.generic'))}</div>
      {refusal.detail && <div style={{ marginTop: 4 }}>{refusal.detail}</div>}
    </div>
  );
}

function TargetBlock({ target }: { target: TargetView }) {
  const tone = target.state === 'target_met' ? 'green' : target.state === 'target_not_met' ? 'gold' : '';
  return (
    <div className="block" data-target-state={target.state} style={{ borderLeft: '2px solid var(--line)', paddingLeft: 10, marginTop: 6 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <b>{target.statement}</b>
        <Pill tone={tone}>{label(`m21.target.${target.state}`, target.state.replace(/_/g, ' '))}</Pill>
      </div>
      {target.measured && <div className="dim" style={{ fontSize: 12.5 }}>{t('m21.measured')}: {target.measured.value} {target.metricUnit}</div>}
      <div className="dim" style={{ fontSize: 12.5, marginTop: 2 }}>{target.note}</div>
      <div className="dim" style={{ fontSize: 11.5, marginTop: 2 }} data-limitation>{target.limitation}</div>
    </div>
  );
}

function EvidenceRow({ e }: { e: EvidenceView }) {
  const prov = e.provenance ? provenanceOf(e.provenance) : null;
  return (
    <div className="list-row" data-evidence data-available={e.available ? 'yes' : 'no'} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 3 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="grow">{e.available ? (e.title ?? e.sourceLabel) : t('m21.evUnavailable')}</span>
        <Pill>{e.sourceLabel}</Pill>
        {prov && <span className={prov.pillClass} title={prov.note}>{prov.glyph ? `${prov.glyph} ` : ''}{prov.label}</span>}
        {e.simulated && <Pill tone="gold">{t('m21.simulated')}</Pill>}
        {!e.available && <Pill>{t('m21.evGone')}</Pill>}
      </div>
      {e.available && e.measuredValue != null && <div className="dim" style={{ fontSize: 12.5 }}>{e.measuredValue} {e.metricUnit}</div>}
      {e.note && <div className="dim" style={{ fontSize: 11.5 }}>{e.note}</div>}
      {e.occurredAt && <div className="dim" style={{ fontSize: 11.5 }}>{fmtDate(e.occurredAt)}</div>}
    </div>
  );
}

function ActionRow({ a, onStatus, disabled }: { a: ActionView; onStatus: (s: string) => void; disabled: boolean }) {
  const due = dueText(a.due);
  return (
    <div className="list-row" data-action style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="grow">{a.title}</span>
        <Pill tone={a.status === 'done' ? 'green' : a.status === 'blocked' ? 'gold' : ''}>{actionStatus(a.status)}</Pill>
        {due && <Pill tone={a.due.state === 'overdue' ? 'gold' : ''}>{due}</Pill>}
      </div>
      <div className="dim" style={{ fontSize: 11.5 }}>
        {label(`m21.type.${a.type}`, a.type.replace(/_/g, ' '))}
        {a.assignee ? ` · ${a.assignee.name}` : ''}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {a.status !== 'done' && a.status !== 'cancelled'
          && <button disabled={disabled} onClick={() => onStatus('done')}>{t('m21.markDone')}</button>}
        {a.status === 'done' && <button disabled={disabled} onClick={() => onStatus('in_progress')}>{t('m21.reopen')}</button>}
        {a.status !== 'blocked' && a.status !== 'done' && a.status !== 'cancelled'
          && <button disabled={disabled} onClick={() => onStatus('blocked')}>{t('m21.block')}</button>}
      </div>
      {a.evidence.map((e) => <EvidenceRow key={e.linkId} e={e} />)}
    </div>
  );
}

function GoalCard({ g, view, session, act, busy }: {
  g: GoalView;
  view: DevelopmentPlanView;
  session: Session;
  act: (fn: () => Promise<Result<DevelopmentPlanView>>) => void;
  busy: boolean;
}) {
  const [addingAction, setAddingAction] = useState(false);
  const [actionTitle, setActionTitle] = useState('');
  const [actionType, setActionType] = useState('training');
  const [blockReason, setBlockReason] = useState('waiting_for_assessment');
  const canWrite = !!view.access.writeGoals;

  return (
    <div className="card block" data-goal={g.id}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <b className="grow">{g.title}</b>
        <Pill>{g.categoryLabel}</Pill>
        <Pill tone={g.status === 'achieved' ? 'green' : g.status === 'blocked' ? 'gold' : ''} data-goal-status={g.status}>{goalStatus(g.status)}</Pill>
      </div>
      {g.description && <div className="dim" style={{ fontSize: 13, marginTop: 3 }}>{g.description}</div>}
      {/* The word never travels without the sentence (§16). */}
      {g.statusMeaning && <div className="dim" style={{ fontSize: 11.5, marginTop: 3 }} data-achieved-meaning>{g.statusMeaning}</div>}
      {g.status === 'blocked' && (
        <div className="dim" style={{ fontSize: 12.5, marginTop: 3 }}>
          {t('m21.blocked')}: {label(`m21.block.${g.blockReason}`, String(g.blockReason ?? '').replace(/_/g, ' '))}
          {g.blockNote ? ` — ${g.blockNote}` : ''}
        </div>
      )}

      {g.targetState && <TargetBlock target={g.targetState} />}

      {/* Counts and a sentence made of counts. Never a bar (§46). */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
        <span data-completion>{g.completion.phrase}</span>
        {g.actionCounts.overdue > 0 && <Pill tone="gold">{g.actionCounts.overdue} {t('m21.overdue')}</Pill>}
      </div>

      <div className="list-rows" style={{ marginTop: 6 }}>
        {g.actions.map((a) => (
          <ActionRow key={a.id} a={a} disabled={busy || !canWrite} onStatus={(s) => act(() => m21.updateAction(session, a.id, { status: s }))} />
        ))}
        {g.actions.length === 0 && <div className="dim" style={{ fontSize: 12.5 }}>{t('m21.noActions')}</div>}
      </div>

      {canWrite && (addingAction ? (
        <div className="block" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
          <input
            value={actionTitle}
            onChange={(e) => setActionTitle(e.target.value)}
            placeholder={t('m21.actionTitle')}
            aria-label={t('m21.actionTitle')}
            style={{ flex: '1 1 200px' }}
          />
          <select value={actionType} onChange={(e) => setActionType(e.target.value)} aria-label={t('m21.actionType')}>
            {['training', 'assessment', 'video_review', 'match_objective', 'coach_review', 'combine', 'box_cam', 'evidence_request', 'custom'].map((ty) => (
              <option key={ty} value={ty}>{label(`m21.type.${ty}`, ty.replace(/_/g, ' '))}</option>
            ))}
          </select>
          <button className="primary" disabled={busy || !actionTitle.trim()} onClick={() => { act(() => m21.addAction(session, g.id, { title: actionTitle.trim(), type: actionType })); setActionTitle(''); setAddingAction(false); }}>{t('m21.add')}</button>
          <button onClick={() => { setAddingAction(false); setActionTitle(''); }}>{t('m21.cancel')}</button>
        </div>
      ) : <button style={{ marginTop: 6 }} onClick={() => setAddingAction(true)}>{t('m21.addAction')}</button>)}

      {g.evidence.length > 0 ? (
        <div className="section">
          <h4>{t('m21.evidence')}</h4>
          <div className="list-rows">{g.evidence.map((e) => <EvidenceRow key={e.linkId} e={e} />)}</div>
          <div className="dim" style={{ fontSize: 11.5, marginTop: 3 }}>{g.evidenceSummary.note}</div>
        </div>
      ) : <div className="dim" style={{ fontSize: 12.5, marginTop: 6 }}>{t('m21.noEvidence')}</div>}

      {canWrite && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          {g.status === 'not_started' && <button disabled={busy} onClick={() => act(() => m21.updateGoal(session, g.id, { status: 'in_progress', expectedRev: g.rev }))}>{t('m21.start')}</button>}
          {g.status === 'in_progress' && <button disabled={busy} onClick={() => act(() => m21.updateGoal(session, g.id, { status: 'achieved', expectedRev: g.rev }))}>{t('m21.markAchieved')}</button>}
          {g.status !== 'blocked' && g.status !== 'achieved' && (
            <>
              <select value={blockReason} onChange={(e) => setBlockReason(e.target.value)} aria-label={t('m21.blockReason')}>
                {['waiting_for_assessment', 'schedule', 'facility', 'coach_review', 'other'].map((r) => (
                  <option key={r} value={r}>{label(`m21.block.${r}`, r.replace(/_/g, ' '))}</option>
                ))}
              </select>
              <button disabled={busy} onClick={() => act(() => m21.updateGoal(session, g.id, { status: 'blocked', blockReason, expectedRev: g.rev }))}>{t('m21.markBlocked')}</button>
            </>
          )}
          {g.status === 'blocked' && <button disabled={busy} onClick={() => act(() => m21.updateGoal(session, g.id, { status: 'in_progress', expectedRev: g.rev }))}>{t('m21.unblock')}</button>}
        </div>
      )}
    </div>
  );
}

function ReviewCard({ r, canShare, onShare, busy }: { r: ReviewView; canShare: boolean; onShare: () => void; busy: boolean }) {
  const shared = r.reviewerKind !== 'coach_review' || r.summary !== null;
  return (
    <div className="card block" data-review={r.id}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Pill tone={r.reviewerKind === 'coach_review' ? 'blue' : ''}>{label(`m21.rev.${r.reviewerKind}`, r.reviewerKind.replace(/_/g, ' '))}</Pill>
        <span className="dim" style={{ fontSize: 12.5 }}>{r.reviewedByName} · {fmtStamp(r.reviewedAt)}</span>
        {r.supersededBy && <Pill tone="gold">{t('m21.superseded')}</Pill>}
        {r.supersedes && <Pill>{t('m21.correction')}</Pill>}
      </div>
      {r.summary
        ? <div style={{ marginTop: 6 }} data-shared-summary>{r.summary}</div>
        : <div className="dim" style={{ marginTop: 6, fontSize: 12.5 }}>{t('m21.noSummary')}</div>}
      {/* Club-side: the note is shown, and marked as staying in the club. */}
      {r.internalNote && (
        <div className="block" data-internal-note style={{ marginTop: 6, borderLeft: '2px solid var(--line)', paddingLeft: 10 }}>
          <div className="dim" style={{ fontSize: 11.5 }}>{t('m21.internalOnly')}</div>
          <div>{r.internalNote}</div>
        </div>
      )}
      {r.goalSnapshots.length > 0 && (
        <div className="section">
          <h4>{t('m21.atReview')}</h4>
          {r.goalSnapshots.map((s) => (
            <div key={s.goalId} className="dim" style={{ fontSize: 12.5 }}>{s.title} — {goalStatus(s.status)} · {s.completion.phrase}</div>
          ))}
        </div>
      )}
      {r.nextReviewAt && <div className="dim" style={{ fontSize: 12.5, marginTop: 4 }}>{t('m21.nextReview')}: {fmtDate(r.nextReviewAt)}</div>}
      {canShare && r.reviewerKind === 'coach_review' && !shared && (
        <button style={{ marginTop: 6 }} disabled={busy} onClick={onShare}>{t('m21.shareReview')}</button>
      )}
    </div>
  );
}

/**
 * The Development panel for one player. Rendered inside the player drawer, so
 * it is authorised exactly as everything else in that drawer is.
 */
export function DevelopmentPanel({ session, playerId, notify }: {
  session: Session;
  playerId: string;
  notify: (text: string, error?: boolean) => void;
}) {
  const [cat, setCat] = useState<DevelopmentCatalogue | null>(null);
  const [view, setView] = useState<DevelopmentPlanView | null>(null);
  const [planId, setPlanId] = useState<string | null>(null);
  const [hasPlan, setHasPlan] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ error: string; detail: string } | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [goalTitle, setGoalTitle] = useState('');
  const [goalCategory, setGoalCategory] = useState('technical');
  const [summary, setSummary] = useState('');
  const [internalNote, setInternalNote] = useState('');
  const [shareWithPlayer, setShareWithPlayer] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await m21.plans(session, playerId);
      const mine = list.items.filter((p) => p.playerId === playerId || list.items.length === 1);
      setHasPlan(mine.length > 0);
      if (mine.length > 0) {
        const id = planId && mine.some((p) => p.id === planId) ? planId : mine[0].id;
        setPlanId(id);
        setView(await m21.plan(session, id));
      } else {
        setView(null);
      }
    } catch (e) {
      setError(httpMessage(e));
    }
  }, [session, playerId, planId]);

  useEffect(() => { if (open) void load(); }, [open, load]);
  useEffect(() => { if (open && !cat) m21.catalogue(session).then(setCat).catch(() => { /* the panel works without it */ }); }, [open, cat, session]);

  /** Every write goes through here: one place for refusals and conflicts. */
  const act = (fn: () => Promise<Result<DevelopmentPlanView>>) => {
    setBusy(true); setRefusal(null); setConflict(null);
    void (async () => {
      try {
        const r = await fn();
        if (!r.ok) { setRefusal({ error: r.error, detail: r.detail }); return; }
        setView(r.value);
        setPlanId(r.value.plan.id);
        setHasPlan(true);
        if (r.value.idempotent) notify(t('m21.alreadyDone'));
      } catch (e) {
        const c = conflictOf(e);
        // The shared M18.2 experience, unchanged: reload, keep your edits.
        if (c) setConflict(c);
        else notify(httpMessage(e), true);
      } finally {
        setBusy(false);
      }
    })();
  };

  if (!open) {
    return (
      <div className="section">
        <h4>{t('m21.title')}</h4>
        <button onClick={() => setOpen(true)} data-open-development>{t('m21.open')}</button>
        <div className="dim" style={{ fontSize: 11.5, marginTop: 4 }}>{t('m21.blurb')}</div>
      </div>
    );
  }

  return (
    <div className="section" data-development-panel>
      <h4>{t('m21.title')}</h4>

      {error && <div className="notice block" role="alert">{error}</div>}
      {refusal && <Refused refusal={refusal} />}
      {conflict && <ConflictNotice conflict={conflict} onReload={() => { setConflict(null); void load(); }} />}

      {hasPlan === false && (
        <div className="card block">
          <b>{t('m21.emptyTitle')}</b>
          <div className="dim" style={{ fontSize: 12.5, marginTop: 4 }}>{t('m21.emptyBody')}</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            <input value={goalTitle} onChange={(e) => setGoalTitle(e.target.value)} placeholder={t('m21.goalTitle')} aria-label={t('m21.goalTitle')} style={{ flex: '1 1 220px' }} />
            <select value={goalCategory} onChange={(e) => setGoalCategory(e.target.value)} aria-label={t('m21.goalCategory')}>
              {(cat?.goal.categories ?? ['technical']).map((c) => (
                <option key={c} value={c}>{cat?.goal.categoryLabels[c] ?? c}</option>
              ))}
            </select>
            <button
              className="primary"
              disabled={busy || !goalTitle.trim()}
              onClick={() => { act(() => m21.createPlan(session, { playerId, title: t('m21.defaultPlanTitle'), visibility: 'org_private', status: 'active', goals: [{ title: goalTitle.trim(), category: goalCategory }] })); setGoalTitle(''); }}
            >
              {t('m21.createPlan')}
            </button>
          </div>
          {cat && <div className="dim" style={{ fontSize: 11.5, marginTop: 6 }}>{cat.goal.omitted.reason}</div>}
        </div>
      )}

      {view && (
        <>
          {/* ---- Overview */}
          <div className="card block" data-plan-overview>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <b className="grow">{view.plan.title}</b>
              <Pill tone={view.plan.status === 'active' ? 'green' : ''}>{label(`m21.plan.${view.plan.status}`, view.plan.status)}</Pill>
              <Pill data-visibility={view.plan.visibility}>{label(`m21.vis.${view.plan.visibility}`, view.plan.visibility)}</Pill>
            </div>
            <div className="dim" style={{ fontSize: 12.5, marginTop: 3 }}>
              {view.plan.owner.kind === 'org' ? `${t('m21.clubPlan')} — ${view.plan.owner.orgName ?? ''}` : t('m21.playerPlan')}
              {view.plan.revBy ? ` · ${t('m21.lastChangedBy')} ${view.plan.revBy}` : ''}
            </div>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 8 }}>
              <span>{t('m21.activeGoals')}: <b>{view.summary.activeGoals}</b></span>
              <span>{t('m21.actionsDue')}: <b>{view.summary.actionsDue}</b></span>
              {view.summary.actionsOverdue > 0 && <Pill tone="gold">{view.summary.actionsOverdue} {t('m21.overdue')}</Pill>}
              <span>{t('m21.linkedEvidence')}: <b>{view.summary.linkedEvidenceAvailable}</b></span>
            </div>
            <div className="dim" style={{ fontSize: 12.5, marginTop: 4 }}>
              {t('m21.lastReview')}: {view.summary.lastReviewAt ? fmtDate(view.summary.lastReviewAt) : t('m21.none')}
              {' · '}
              {t('m21.nextReview')}: {view.summary.nextReviewAt ? fmtDate(view.summary.nextReviewAt) : t('m21.none')}
              {view.summary.reviewDue.state === 'review_overdue' ? ` · ${t('m21.reviewOverdue')}` : ''}
            </div>
            {/* Said out loud exactly where a headline number would sit. */}
            <div className="dim" style={{ fontSize: 11.5, marginTop: 6 }} data-no-score>{view.summary.note}</div>
            {cat && <div className="dim" style={{ fontSize: 11.5, marginTop: 3 }} data-no-scheduler>{cat.reminders.note}</div>}

            {view.access.manage && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                <select
                  value={view.plan.visibility}
                  aria-label={t('m21.visibility')}
                  onChange={(e) => act(() => m21.setVisibility(session, view.plan.id, e.target.value as DevelopmentPlanView['plan']['visibility'], view.plan.rev))}
                >
                  {(cat?.plan.visibilityByOwner[view.plan.owner.kind] ?? [view.plan.visibility]).map((v) => (
                    <option key={v} value={v}>{label(`m21.vis.${v}`, v)}</option>
                  ))}
                </select>
                {view.plan.status === 'active' && <button disabled={busy} onClick={() => act(() => m21.setStatus(session, view.plan.id, 'paused' as PlanStatus, view.plan.rev))}>{t('m21.pause')}</button>}
                {view.plan.status === 'paused' && <button disabled={busy} onClick={() => act(() => m21.setStatus(session, view.plan.id, 'active' as PlanStatus, view.plan.rev))}>{t('m21.resume')}</button>}
                {view.plan.status !== 'archived' && <button disabled={busy} onClick={() => { if (window.confirm(t('m21.confirmArchive'))) act(() => m21.setStatus(session, view.plan.id, 'archived' as PlanStatus, view.plan.rev)); }}>{t('m21.archive')}</button>}
              </div>
            )}
            {view.plan.visibility === 'player_guardian' && (
              <div className="dim" style={{ fontSize: 11.5, marginTop: 4 }} data-player-can-read>{t('m21.playerCanRead')}</div>
            )}
          </div>

          {/* ---- Goals */}
          {view.goals.map((g) => <GoalCard key={g.id} g={g} view={view} session={session} busy={busy} act={act} />)}
          {view.goals.length === 0 && <div className="dim" style={{ fontSize: 12.5 }}>{t('m21.noGoals')}</div>}

          {view.access.writeGoals && (
            <div className="card block">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <input value={goalTitle} onChange={(e) => setGoalTitle(e.target.value)} placeholder={t('m21.goalTitle')} aria-label={t('m21.goalTitle')} style={{ flex: '1 1 220px' }} />
                <select value={goalCategory} onChange={(e) => setGoalCategory(e.target.value)} aria-label={t('m21.goalCategory')}>
                  {(cat?.goal.categories ?? ['technical']).map((c) => <option key={c} value={c}>{cat?.goal.categoryLabels[c] ?? c}</option>)}
                </select>
                <button className="primary" disabled={busy || !goalTitle.trim()} onClick={() => { act(() => m21.addGoal(session, view.plan.id, { title: goalTitle.trim(), category: goalCategory })); setGoalTitle(''); }}>{t('m21.addGoal')}</button>
              </div>
              {cat && (
                <div style={{ marginTop: 6 }}>
                  <div className="dim" style={{ fontSize: 11.5 }}>{cat.goalLibrary.note}</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                    {cat.goalLibrary.items.map((i) => (
                      <button key={i.id} onClick={() => { setGoalTitle(i.title); setGoalCategory(i.category); }}>{i.title}</button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ---- Reviews */}
          <div className="section">
            <h4>{t('m21.reviews')}</h4>
            {view.reviews.length === 0 && <div className="dim" style={{ fontSize: 12.5 }}>{t('m21.noReviews')}</div>}
            {view.reviews.map((r) => (
              <ReviewCard key={r.id} r={r} busy={busy} canShare={!!view.access.readInternal} onShare={() => act(() => m21.shareReview(session, r.id))} />
            ))}
          </div>

          {view.access.review && (
            <div className="card block">
              <b>{t('m21.newReview')}</b>
              <div className="dim" style={{ fontSize: 11.5, marginTop: 3 }}>{t('m21.reviewAppendOnly')}</div>
              <textarea
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder={t('m21.summaryPlaceholder')}
                aria-label={t('m21.summary')}
                rows={3}
                style={{ width: '100%', marginTop: 6 }}
              />
              <textarea
                value={internalNote}
                onChange={(e) => setInternalNote(e.target.value)}
                placeholder={t('m21.internalPlaceholder')}
                aria-label={t('m21.internalNote')}
                rows={2}
                style={{ width: '100%', marginTop: 6 }}
              />
              <div className="dim" style={{ fontSize: 11.5 }}>{t('m21.internalNeverShared')}</div>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
                <input type="checkbox" checked={shareWithPlayer} onChange={(e) => setShareWithPlayer(e.target.checked)} />
                <span>{t('m21.shareSummaryWithPlayer')}</span>
              </label>
              <button
                className="primary"
                style={{ marginTop: 6 }}
                disabled={busy || (!summary.trim() && !internalNote.trim())}
                onClick={() => {
                  act(() => m21.submitReview(session, view.plan.id, {
                    summary: summary.trim() || undefined,
                    internalNote: internalNote.trim() || undefined,
                    shareWithPlayer,
                  }));
                  setSummary(''); setInternalNote(''); setShareWithPlayer(false);
                }}
              >
                {t('m21.submitReview')}
              </button>
            </div>
          )}

          {/* ---- History */}
          <div className="section">
            <button onClick={() => setShowHistory((x) => !x)} data-toggle-history>
              {showHistory ? t('m21.hideHistory') : t('m21.showHistory')}
            </button>
            {showHistory && (
              <div className="list-rows" style={{ marginTop: 6 }}>
                {view.timeline.length === 0 && <div className="dim" style={{ fontSize: 12.5 }}>{t('m21.noHistory')}</div>}
                {view.timeline.map((h) => (
                  <div key={h.id} className="list-row" data-history-entry={h.action}>
                    <span className="dim" style={{ fontSize: 12 }}>{fmtStamp(h.at)}</span>
                    <span className="grow">{h.label}{h.subject.title ? ` — ${h.subject.title}` : ''}</span>
                    {h.byName && <span className="dim" style={{ fontSize: 12 }}>{h.byName}</span>}
                    {h.internal && <Pill>{t('m21.internal')}</Pill>}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="dim" style={{ fontSize: 11.5, marginTop: 8 }} data-limitation>{view.limitation}</div>
          <div className="dim" style={{ fontSize: 11.5 }} data-never-built>{view.neverBuilt.note}</div>
        </>
      )}
    </div>
  );
}
