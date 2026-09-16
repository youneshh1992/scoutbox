/**
 * M23 P5 — the formal recruitment decision engine: pure functions over the
 * canonical `db.roomDecisions` row and the case's single draft.
 *
 * THE CHAIN OF TRUTH THIS FILE ENFORCES (mandate §1)
 *
 *   evidence ≠ observation ≠ assessment ≠ discussion ≠ decision ≠ offer ≠ signing
 *
 * A formal decision is a row in the SAME append-only decision memory M17
 * created (`db.roomDecisions`), with additive fields:
 *
 *   kind              'formal'   (legacy rows: absent → read as 'recommendation')
 *   outcome           progress | hold | reject
 *   recommendation    the M17 value the outcome maps onto, so every legacy
 *                     reader — Second Look, journey, M20, Nobody Missed —
 *                     keeps reading ONE chain (offer / continue_watching / archive)
 *   state             'final' (a formal row is only ever final; a DRAFT lives
 *                     on the case as `kase.decisionDraft` and is not a decision)
 *   rev               the decision's OWN revision (1 at finalize, bumped when superseded)
 *   evidenceRefs[]    references + minimal immutable metadata, never copies
 *   assessmentSummary counts and ids at decision time — never an average
 *   lifecycle         what the decision did to the case, through the ONE writer
 *   supersession      { reason, of } on a row that replaced a previous final one
 *   keys              idempotency keys with payload fingerprints
 *
 * Nothing here reads a Trust Score, a Box Cam result, an attendance record or
 * an assessment rating to PRODUCE an outcome. Every outcome is typed by a
 * human on the request. Nothing here writes a case status.
 */

import { validateReasonCodes, REASON_CODES } from '../m17/shared.mjs';
import { normaliseClientKey as contactKey, payloadFingerprint } from './contact.mjs';
import { deriveWorkflowState } from './trial.mjs';

export const DECISION_POLICY_VERSION = 1;

const table = (o) => Object.freeze(Object.assign(Object.create(null), o));
const has = (t, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(t, k);
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ------------------------------------------------------------------ vocabulary

/** The three operational outcomes a club can formally decide (§9). */
export const DECISION_OUTCOMES = Object.freeze(['progress', 'hold', 'reject']);

/**
 * Outcome → the M17 recommendation the row also carries, the semantic
 * lifecycle action the outcome asks for, and the lifecycle reason codes that
 * action needs (LIFECYCLE taxonomy, never the decision taxonomy — §46).
 */
export const OUTCOME_MAP = table({
  progress: { recommendation: 'offer', action: 'considerOffer', lifecycleReasons: [], label: 'Progress to offer consideration' },
  hold: { recommendation: 'continue_watching', action: 'holdCase', lifecycleReasons: [], label: 'Hold' },
  reject: { recommendation: 'archive', action: 'rejectCase', lifecycleReasons: ['rejected'], label: 'Reject' },
});

export const DECISION_KINDS = Object.freeze(['recommendation', 'formal']);
export const DECISION_STATES = Object.freeze(['draft', 'final']);

/** What a decision may cite. Each kind is validated against the case's own records. */
export const EVIDENCE_REF_KINDS = Object.freeze(['assessment', 'trial', 'box_cam_session', 'passport_evidence']);

export const DECISION_LIMITS = Object.freeze({
  note: 2000,
  supersessionReason: 500,
  evidenceRefs: 50,
  clientKey: 64,
  reasonCodes: 6,
  historyPage: 100,
});

// ------------------------------------------------------------------ helpers

export const plainText = (s, max) => String(s ?? '').replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim().slice(0, max);

/** A client key in the Decision vocabulary: same rule as Contact and Trial, own code. */
export function normaliseDecisionClientKey(raw) {
  const k = contactKey(raw);
  if (k.ok) return k;
  return { ok: false, error: 'DECISION_CLIENT_KEY_INVALID', message: k.message };
}
export { payloadFingerprint };

/** A legacy M17 row (no `kind`) reads as an advisory recommendation, final. */
export const decisionKind = (d) => (d?.kind === 'formal' ? 'formal' : 'recommendation');
export const isFormal = (d) => decisionKind(d) === 'formal';

// ------------------------------------------------------------------ validation

/** The outcome typed by a human. A key we did not define is nothing. */
export function validateOutcome(raw) {
  if (typeof raw !== 'string' || !has(OUTCOME_MAP, raw)) {
    return { ok: false, error: 'DECISION_OUTCOME_INVALID', message: 'The outcome must be one of progress, hold or reject.', allowed: DECISION_OUTCOMES };
  }
  return { ok: true, outcome: raw };
}

/**
 * Decision reasons come from the M17 DECISION taxonomy (opinions about a
 * player's fit), never from the lifecycle taxonomy (events that happened to a
 * case). A reject needs at least one, like an archive always has.
 */
export function validateDecisionReasons(raw, { outcome = null } = {}) {
  if (raw === undefined || raw === null) raw = [];
  const r = validateReasonCodes(raw);
  if (!r.ok) return { ok: false, error: 'DECISION_REASON_INVALID', message: r.message, ...(r.unknown ? { unknown: r.unknown } : {}), ...(r.prohibited ? { prohibited: r.prohibited } : {}) };
  if (outcome === 'reject' && r.codes.length === 0) {
    return { ok: false, error: 'DECISION_REASON_INVALID', message: 'A rejection needs at least one reason so the decision stays useful later — and so a Second Look can tell whether it still applies.' };
  }
  return { ok: true, codes: r.codes };
}

export function validateNote(raw, { field = 'note', max = DECISION_LIMITS.note } = {}) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, text: null };
  if (typeof raw !== 'string') return { ok: false, error: 'DECISION_CONTENT_INVALID', message: `${field} must be text.`, field };
  if (raw.length > max) return { ok: false, error: 'DECISION_CONTENT_INVALID', message: `Keep the ${field} under ${max} characters.`, field };
  const text = plainText(raw, max);
  return { ok: true, text: text || null };
}

/**
 * The shape of an evidence reference, before it is checked against the case.
 * `{ kind, id }` only; anything else on it is dropped — a reference carries
 * no content of its own.
 */
export function validateEvidenceRefShapes(raw) {
  if (raw === undefined || raw === null) return { ok: true, refs: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'DECISION_EVIDENCE_INVALID', message: 'evidenceRefs must be a list.', field: 'evidenceRefs' };
  if (raw.length > DECISION_LIMITS.evidenceRefs) return { ok: false, error: 'DECISION_EVIDENCE_INVALID', message: `Cite at most ${DECISION_LIMITS.evidenceRefs} records.`, field: 'evidenceRefs' };
  const refs = [];
  const seen = new Set();
  for (const r of raw) {
    if (!isPlain(r) || typeof r.kind !== 'string' || !EVIDENCE_REF_KINDS.includes(r.kind) || typeof r.id !== 'string' || !r.id.trim()) {
      return { ok: false, error: 'DECISION_EVIDENCE_INVALID', message: 'Each reference is { kind, id } with a known kind.', field: 'evidenceRefs', allowed: EVIDENCE_REF_KINDS };
    }
    const key = `${r.kind}:${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ kind: r.kind, id: r.id.trim() });
  }
  return { ok: true, refs };
}

/**
 * Resolve each reference against THIS case's own records (§76, §77, §78).
 * A reference to another organisation's assessment, another player's trial,
 * a Box Cam session not linked on one of this case's trials, or a test-only
 * session in production is refused as `DECISION_CASE_MISMATCH` — the same
 * body whether the record exists elsewhere or not at all. The metadata kept
 * is the minimum needed to read the decision later without re-querying
 * (§51): who assessed and when, the trial's state, the session's verification
 * state, the claim type. Never a rating, a note, a trace or a value.
 */
export function resolveEvidenceRefs(refs, { db, kase, testProviderEnabled = false, providers = {} }) {
  const out = [];
  for (const ref of refs) {
    const mismatch = (message) => ({ ok: false, error: 'DECISION_CASE_MISMATCH', message, ref });
    if (ref.kind === 'assessment') {
      const a = (db.assessments ?? []).find((x) => x && x.id === ref.id);
      if (!a || a.orgId !== kase.orgId || a.playerId !== kase.playerId) return mismatch('That assessment is not one of this case\'s.');
      if (a.state === 'draft') return { ok: false, error: 'DECISION_EVIDENCE_INVALID', message: 'Only a submitted assessment can be cited by a decision.', ref };
      out.push({ kind: 'assessment', id: a.id, meta: { scoutName: a.scoutName ?? null, submittedAt: a.submittedAt ?? null, verdict: a.recommendation?.verdict ?? null, trialId: a.context?.trialId ?? null } });
      continue;
    }
    if (ref.kind === 'trial') {
      const t = (db.trials ?? []).find((x) => x && x.id === ref.id);
      if (!t || t.orgId !== kase.orgId || t.playerId !== kase.playerId || (t.caseId && t.caseId !== kase.id)) return mismatch('That trial is not one of this case\'s.');
      out.push({ kind: 'trial', id: t.id, meta: { workflowState: deriveWorkflowState(t), completedAt: t.completion?.state === 'completed' ? t.completion.at : null } });
      continue;
    }
    if (ref.kind === 'box_cam_session') {
      const link = (db.trials ?? [])
        .filter((t) => t && t.orgId === kase.orgId && t.playerId === kase.playerId && (!t.caseId || t.caseId === kase.id))
        .flatMap((t) => (t.schedule?.sessions ?? []).flatMap((s) => (s?.evidence ?? []).map((e) => ({ trial: t, session: s, e }))))
        .find(({ e }) => e && e.kind === 'box_cam_session' && e.sessionId === ref.id && !e.removedAt);
      if (!link) return mismatch('That Box Cam session is not cited on any trial of this case.');
      const bs = (db.boxSessions ?? []).find((x) => x && x.id === ref.id && x.playerId === kase.playerId) ?? null;
      if (!bs) return mismatch('That Box Cam session is not available to this case.');
      if (providers[bs.provider]?.testOnly && !testProviderEnabled) return mismatch('That Box Cam session is not available to this case.');
      out.push({ kind: 'box_cam_session', id: bs.id, meta: { trialId: link.trial.id, trialSessionId: link.session.id, verificationState: bs.verificationState ?? null, simulated: !!providers[bs.provider]?.testOnly } });
      continue;
    }
    if (ref.kind === 'passport_evidence') {
      const ev = (db.evidence ?? []).find((x) => x && x.id === ref.id);
      if (!ev || ev.playerId !== kase.playerId || ev.supersededBy) return mismatch('That evidence record is not one of this player\'s current records.');
      out.push({ kind: 'passport_evidence', id: ev.id, meta: { claimType: ev.claimType ?? null, provenance: ev.verification?.status ?? 'self_reported' } });
      continue;
    }
    return { ok: false, error: 'DECISION_EVIDENCE_INVALID', message: 'Unknown reference kind.', ref };
  }
  return { ok: true, refs: out };
}

// ------------------------------------------------------------------ integrity

/**
 * A formal row this build can read. Anything else is omitted from P5 lists,
 * counted, logged — and never repaired (§120). Legacy recommendation rows are
 * not judged here; M17 owns their reading.
 */
export function decisionIntegrity(d, { orgId = null, caseId = null } = {}) {
  const problems = [];
  try {
    if (!d || typeof d !== 'object') return ['not_an_object'];
    if (typeof d.id !== 'string' || !d.id) problems.push('id');
    if (!isFormal(d)) return problems;
    if (!has(OUTCOME_MAP, d.outcome)) problems.push('unknown_outcome');
    if (!d.by || typeof d.by !== 'object' || (d.by.userId == null && d.by.name == null)) problems.push('missing_actor');
    if (typeof d.roomId !== 'string' || (caseId && d.roomId !== caseId)) problems.push('missing_case');
    if (orgId && d.orgId !== orgId) problems.push('org_mismatch');
    if (!Number.isFinite(d.createdAt)) problems.push('missing_time');
    if (!Array.isArray(d.reasonCodes)) problems.push('reasons_not_a_list');
    else if (validateReasonCodes(d.reasonCodes).ok === false) problems.push('invalid_reason_code');
    if (d.evidenceRefs !== undefined && !Array.isArray(d.evidenceRefs)) problems.push('refs_not_a_list');
    if (d.rev !== undefined && !(Number.isInteger(d.rev) && d.rev >= 1)) problems.push('rev');
  } catch {
    return ['unreadable'];
  }
  return problems;
}

/** Among a case's rows, more than one formal row with no successor is corruption, not a tie. */
export function duplicateFinalHeads(rows) {
  const heads = rows.filter((d) => isFormal(d) && !d.supersededById);
  return heads.length > 1 ? heads.map((d) => d.id) : [];
}

// ------------------------------------------------------------------ chain

/** The chain head: the one row nothing supersedes. Exact, like M18's reader. */
export function chainHead(rows) {
  const heads = rows.filter((d) => d && !d.supersededById);
  if (heads.length === 0) return null;
  heads.sort((a, b) => (a.createdAt - b.createdAt) || String(a.id).localeCompare(String(b.id)));
  return heads[heads.length - 1];
}

/** Stable order for history: createdAt, then id (§118). */
export const byCreatedThenId = (a, b) => ((a.createdAt ?? 0) - (b.createdAt ?? 0)) || String(a.id).localeCompare(String(b.id));

// ------------------------------------------------------------------ summaries

/**
 * The assessment inputs a decision maker may see, summarised WITHOUT a single
 * number that stands for the player (§21, §22). Per assessor: their verdict,
 * how many attributes they rated, how many they marked not observed, their
 * confidence mix, how many evidence references they attached. Across
 * assessors: the verdict counts and whether they agree. Never an average.
 *
 * `visible` is the list the blind rule already lets this viewer see;
 * `withheld` is how many the rule withholds — said, not hidden.
 */
export function summariseAssessments(visible, { withheld = 0 } = {}) {
  const submitted = visible.filter((a) => a && a.state !== 'draft');
  const per = submitted.map((a) => {
    const ratings = Array.isArray(a.ratings) ? a.ratings : [];
    const conf = { low: 0, medium: 0, high: 0 };
    for (const r of ratings) if (r && !r.notObserved && has(conf, r.confidence)) conf[r.confidence] += 1;
    return {
      id: a.id,
      scoutName: a.scoutName ?? null,
      scoutUserId: a.scoutUserId ?? null,
      state: a.state,
      submittedAt: a.submittedAt ?? null,
      verdict: a.recommendation?.verdict ?? null,
      trialId: a.context?.trialId ?? null,
      trialSessionId: a.context?.trialSessionId ?? null,
      rated: ratings.filter((r) => r && !r.notObserved && r.rating != null).length,
      notObserved: ratings.filter((r) => r && r.notObserved).length,
      confidence: conf,
      evidenceRefs: ratings.reduce((n, r) => n + ((r?.evidenceRefs ?? []).length), 0),
      published: !!a.publishedFeedback,
    };
  }).sort((a, b) => ((a.submittedAt ?? 0) - (b.submittedAt ?? 0)) || String(a.id).localeCompare(String(b.id)));
  const verdicts = { sign: 0, monitor: 0, pass: 0, none: 0 };
  for (const p of per) verdicts[has(verdicts, p.verdict) ? p.verdict : 'none'] += 1;
  const distinct = Object.entries(verdicts).filter(([k, n]) => k !== 'none' && n > 0).map(([k]) => k);
  return {
    submitted: per.length,
    drafts: visible.filter((a) => a && a.state === 'draft').length,
    withheld,
    verdicts,
    disagreement: distinct.length > 1 ? { kind: 'verdicts_differ', verdicts: distinct } : per.length > 1 ? { kind: 'unanimous', verdicts: distinct } : null,
    assessments: per,
    note: 'Independent assessments, summarised as counts. ScoutBox does not average them and does not decide.',
  };
}

/** The immutable metadata a formal row keeps about the assessments it saw (§51): ids and counts. */
export function assessmentSnapshot(summary) {
  return {
    submitted: summary.submitted,
    withheld: summary.withheld,
    verdicts: { ...summary.verdicts },
    assessmentIds: summary.assessments.map((a) => a.id).slice(0, 20),
  };
}

/**
 * Evidence a decision maker can cite, listed as ids and neutral metadata
 * (§106). Box Cam observations appear as a STATE — observed, no reliable
 * observation, withdrawn — never as a recommendation (§26, §27).
 */
export function evidenceCandidates({ db, kase, assessmentsVisible, trialEvidenceViews = null, providers = {}, testProviderEnabled = false }) {
  const trials = (db.trials ?? [])
    .filter((t) => t && t.orgId === kase.orgId && t.playerId === kase.playerId && (!t.caseId || t.caseId === kase.id))
    .sort((a, b) => (a.acceptedAt - b.acceptedAt) || String(a.id).localeCompare(String(b.id)))
    .map((t) => ({ id: t.id, workflowState: deriveWorkflowState(t), completedAt: t.completion?.state === 'completed' ? t.completion.at : null, sessionCount: t.schedule?.sessions?.length ?? 0, legacy: !t.caseId }));
  const boxCam = [];
  for (const t of (db.trials ?? [])) {
    if (!t || t.orgId !== kase.orgId || t.playerId !== kase.playerId || (t.caseId && t.caseId !== kase.id)) continue;
    const views = trialEvidenceViews ? trialEvidenceViews(t) : [];
    for (const v of views) {
      if (v.removedAt) continue;
      const sid = v.session?.id ?? null;
      if (!sid) continue;
      if (v.session?.simulated && !testProviderEnabled) continue;
      boxCam.push({ id: sid, trialId: t.id, trialSessionId: v.trialSessionId, verificationState: v.session?.verificationState ?? null, observation: v.observation?.state ?? 'unavailable', observationCopy: v.observation?.copy ?? null, simulated: !!v.session?.simulated, provenance: v.provenance });
    }
  }
  const passport = (db.evidence ?? [])
    .filter((e) => e && e.playerId === kase.playerId && !e.supersededBy)
    .sort((a, b) => ((b.recordedAt ?? 0) - (a.recordedAt ?? 0)) || String(a.id).localeCompare(String(b.id)))
    .slice(0, 40)
    .map((e) => ({ id: e.id, claimType: e.claimType ?? null, label: e.label ?? null, provenance: e.verification?.status ?? 'self_reported', recordedAt: e.recordedAt ?? null }));
  return {
    assessments: assessmentsVisible.filter((a) => a.state !== 'draft').map((a) => ({ id: a.id, scoutName: a.scoutName ?? null, submittedAt: a.submittedAt ?? null, verdict: a.recommendation?.verdict ?? null, trialId: a.context?.trialId ?? null })),
    trials,
    boxCam,
    passport,
    note: 'References only. A decision cites these records; it copies none of them, and none of them decides anything.',
  };
}

// ------------------------------------------------------------------ views

/** A formal or legacy row, for the club. The note is club-private and travels only here. */
export function decisionView(d, { omitNote = false } = {}) {
  const formal = isFormal(d);
  return {
    id: d.id,
    kind: decisionKind(d),
    state: d.state === 'draft' ? 'draft' : 'final',
    outcome: formal ? d.outcome : null,
    outcomeLabel: formal ? OUTCOME_MAP[d.outcome]?.label ?? d.outcome : null,
    recommendation: d.recommendation ?? null,
    reasonCodes: Array.isArray(d.reasonCodes) ? d.reasonCodes : [],
    note: omitNote ? undefined : (d.note ?? null),
    hasNote: !!d.note,
    by: d.by ? { userId: d.by.userId ?? null, name: d.by.name ?? null, role: d.by.role ?? null } : null,
    createdAt: d.createdAt ?? null,
    finalizedAt: formal ? (d.finalizedAt ?? d.createdAt ?? null) : (d.createdAt ?? null),
    rev: Number.isInteger(d.rev) ? d.rev : 1,
    supersedes: d.supersedes ?? null,
    supersededById: d.supersededById ?? null,
    supersession: formal && d.supersession ? { reason: d.supersession.reason ?? null, of: d.supersession.of ?? null } : null,
    evidenceRefs: formal ? (d.evidenceRefs ?? []) : [],
    evidenceCount: formal ? (d.evidenceRefs ?? []).length : (d.snapshot?.sourceRefs?.evidenceIds?.length ?? 0),
    assessmentSummary: formal ? (d.assessmentSummary ?? null) : null,
    lifecycle: formal ? (d.lifecycle ?? null) : null,
    trigger: d.trigger ?? null,
    snapshot: d.snapshot ? { at: d.snapshot.at ?? null, trust: d.snapshot.trust ?? null, snapshotId: d.snapshot.snapshotId ?? null, note: 'Evidence confidence at the time of the decision. It is not a record of the player’s ability.' } : null,
    policyVersion: formal ? (d.policyVersion ?? DECISION_POLICY_VERSION) : null,
  };
}

/** The case's draft, for the club. Labelled as what it is: not a decision. */
export function draftView(dr) {
  if (!dr) return null;
  return {
    id: dr.id,
    state: 'draft',
    outcome: dr.outcome ?? null,
    outcomeLabel: dr.outcome ? OUTCOME_MAP[dr.outcome]?.label ?? dr.outcome : null,
    reasonCodes: Array.isArray(dr.reasonCodes) ? dr.reasonCodes : [],
    note: dr.note ?? null,
    evidenceRefs: Array.isArray(dr.evidenceRefs) ? dr.evidenceRefs : [],
    by: dr.by ? { userId: dr.by.userId ?? null, name: dr.by.name ?? null } : null,
    createdAt: dr.createdAt ?? null,
    updatedAt: dr.updatedAt ?? dr.createdAt ?? null,
    updatedBy: dr.updatedBy ? { userId: dr.updatedBy.userId ?? null, name: dr.updatedBy.name ?? null } : null,
    rev: Number.isInteger(dr.rev) ? dr.rev : 1,
    label: 'Draft — not a formal decision',
  };
}

/** The journey milestone a formal decision projects: ids, outcome, time, who. Never the note. */
export function decisionMilestone(d) {
  return {
    id: d.id,
    kind: decisionKind(d),
    outcome: isFormal(d) ? d.outcome : null,
    recommendation: d.recommendation ?? null,
    reasonCodes: Array.isArray(d.reasonCodes) ? d.reasonCodes : [],
    at: d.createdAt ?? null,
    by: d.by?.name ?? null,
    supersededById: d.supersededById ?? null,
    hasNote: !!d.note,
    evidenceCount: isFormal(d) ? (d.evidenceRefs ?? []).length : 0,
  };
}

// ------------------------------------------------------------------ readiness

/**
 * Workflow completeness for a decision — what has been DONE, never whether the
 * player is good enough (§30). Every item is a fact a person could check.
 */
export function decisionRequirements({ role, canFinalize, status, submittedAssessments, completedTrials, blocked, subjectRemoved, draft, hasFinal, availability }) {
  return {
    canDraft: !!canFinalize && !subjectRemoved,
    canFinalize: !!canFinalize && !subjectRemoved,
    role,
    blocked: !!blocked,
    subjectRemoved: !!subjectRemoved,
    hasDraft: !!draft,
    hasFinal: !!hasFinal,
    inputs: {
      submittedAssessments,
      completedTrials,
      note: 'Inputs are counts of what exists. None of them is required by policy, and none of them decides anything.',
    },
    outcomes: availability,
    status,
    note: 'A formal decision is an explicit human act by a room lead or recruitment lead. ScoutBox never takes it.',
  };
}

export const REASON_CATEGORIES = REASON_CODES;
