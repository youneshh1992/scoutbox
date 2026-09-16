/**
 * M23 P5 — formal recruitment decision routes: the club's internal decision
 * boundary. Everything here ends at `offer_consideration`; nothing here knows
 * what an offer is.
 *
 *   GET    /org/rooms/:id/decision                  the decision surface for this case
 *   POST   /org/rooms/:id/decision/draft            open the case's ONE draft
 *   PATCH  /org/rooms/:id/decision/draft            edit it (own rev)
 *   DELETE /org/rooms/:id/decision/draft            discard it (own rev)
 *   POST   /org/rooms/:id/decision/finalize         the formal decision: row + case move, one save
 *   POST   /org/rooms/:id/decision/supersede        finalize, explicitly replacing the current formal decision
 *   GET    /org/recruitment/decision-policy         vocabulary
 *
 * WHAT NEVER HAPPENS HERE
 *
 * No `case.status = …` (only `ctx.applyLifecycleTransition`, after the ONE
 * validator agreed); no offer row, draft, term or notification; no player or
 * guardian notification; no reading of a rating, a Trust Score, a Box Cam
 * result or an attendance record to PRODUCE an outcome; no edit of a final
 * row (a later decision supersedes it); no decision taxonomy code written
 * into the lifecycle history and no lifecycle code written into a decision.
 */

import { roomRole, roomCan, ROOM_TRANSITIONS, TERMINAL_ROOM_STATUSES, ROOM_STATUS_LABELS } from '../m17/shared.mjs';
import { guardRev, expectedRevOf } from '../m181/concurrency.mjs';
import { rateLimitedBody } from '../m181/rateLimit.mjs';
import { PROVIDERS } from '../m16/drills.mjs';
import { canTransitionRecruitmentCase, LIFECYCLE_ACTIONS, NULL_EVIDENCE_PROVIDER, RECRUITMENT_LIFECYCLE_POLICY_VERSION } from './lifecycle.mjs';
import { sendDomainError } from './errors.mjs';
import {
  DECISION_POLICY_VERSION, DECISION_OUTCOMES, OUTCOME_MAP, EVIDENCE_REF_KINDS, DECISION_LIMITS, REASON_CATEGORIES,
  normaliseDecisionClientKey, payloadFingerprint, isFormal, decisionKind,
  validateOutcome, validateDecisionReasons, validateNote, validateEvidenceRefShapes, resolveEvidenceRefs,
  decisionIntegrity, duplicateFinalHeads, chainHead, byCreatedThenId,
  summariseAssessments, assessmentSnapshot, evidenceCandidates, decisionView, draftView, decisionRequirements,
} from './decision.mjs';

export function registerDecision(ctx) {
  const {
    db, orgRouter, nextId, persistNow, notify, broadcast, findPlayer, isBlocked,
    rateLimit, isLead, moderateOrRefuse, audit, testProviderEnabled = false,
  } = ctx;

  const err = (res, error, message, extra = {}) => sendDomainError(res, { error, message, ...extra }, 'decision');
  const limited = (action, keyPart) => !!rateLimit?.limited(action, keyPart);
  const roleFor = (req, room) => roomRole({ room, user: req.orgUser, isLead: isLead(req.orgUser) });
  const evidenceProvider = () => ctx.recruitmentEvidenceProvider ?? NULL_EVIDENCE_PROVIDER;
  const actor = (req) => ({ userId: req.orgUser.id, name: req.orgUser.name, role: req.orgUser.role ?? null });
  const now = () => Date.now();

  // ------------------------------------------------------------- lookups

  function roomFor(req, res, need) {
    const room = ctx.findRoomForRequest(req, res);
    if (!room) return null;
    const role = roleFor(req, room);
    if (!roomCan(role, need)) {
      err(res, 'DECISION_NOT_PERMITTED', need === 'decision_view'
        ? 'Your role cannot read decisions in this room.'
        : 'Only a room lead or recruitment lead can draft or finalize a recruitment decision.');
      return null;
    }
    return { room, role };
  }

  function storeOr500(res) {
    if (!Array.isArray(db.roomDecisions)) {
      console.error('DECISION store_missing db.roomDecisions is absent or not a list');
      err(res, 'DECISION_STORE_MISSING', 'Decisions cannot be served right now.');
      return null;
    }
    return db.roomDecisions;
  }

  /** This case's rows in chain order; corrupt FORMAL rows omitted and counted, legacy rows left to M17's reading. */
  function rowsOf(kase) {
    const good = [];
    let omitted = 0;
    for (const d of db.roomDecisions ?? []) {
      if (!d || typeof d !== 'object' || d.roomId !== kase.id || d.orgId !== kase.orgId) continue;
      if (isFormal(d)) {
        const problems = decisionIntegrity(d, { orgId: kase.orgId, caseId: kase.id });
        if (problems.length) { omitted += 1; console.error(`DECISION integrity ${d.id ?? '?'}: ${problems.join(',')}`); continue; }
      }
      good.push(d);
    }
    good.sort(byCreatedThenId);
    const dup = duplicateFinalHeads(good);
    if (dup.length) console.error(`DECISION integrity case=${kase.id} duplicate_final_heads ${dup.join(',')}`);
    return { rows: good, omitted, duplicateHeads: dup };
  }

  /** The same blind rule the Room applies (M12/M13): a scout reads a peer's submitted assessment only after submitting their own. */
  function assessmentsVisible(req, kase) {
    const mine = (db.assessments ?? []).filter((a) => a && a.orgId === kase.orgId && a.playerId === kase.playerId);
    const lead = isLead(req.orgUser);
    const ownNonDraft = mine.some((a) => a.scoutUserId === req.orgUser.id && a.state !== 'draft');
    const visible = mine.filter((a) => lead || a.scoutUserId === req.orgUser.id || (a.state !== 'draft' && ownNonDraft));
    return { visible, withheld: mine.filter((a) => a.state !== 'draft').length - visible.filter((a) => a.state !== 'draft').length };
  }

  const subjectRemoved = (kase) => !!kase.subjectRemovedAt || !findPlayer(kase.playerId);

  /** For each outcome: could the case take the corresponding lifecycle step from where it is, for this role? Edge and role only — the evidence is the decision itself. */
  function outcomeAvailability(kase, role) {
    const status = kase.room?.status;
    return DECISION_OUTCOMES.map((outcome) => {
      const def = LIFECYCLE_ACTIONS[OUTCOME_MAP[outcome].action];
      const to = def.to;
      const roleOk = canTransitionRecruitmentCase(kase, OUTCOME_MAP[outcome].action, { role, evidence: NULL_EVIDENCE_PROVIDER, forAvailability: true }).error !== 'LIFECYCLE_NOT_PERMITTED';
      const alreadyThere = status === to;
      const edge = alreadyThere || (ROOM_TRANSITIONS[status] ?? []).includes(to);
      const applicable = !def.applicableFrom || def.applicableFrom(status);
      return {
        outcome, action: OUTCOME_MAP[outcome].action, to, toLabel: ROOM_STATUS_LABELS[to] ?? to,
        possible: roleOk && edge && applicable,
        alreadyThere,
        reason: !roleOk ? 'role' : !edge ? 'transition' : !applicable ? 'not_applicable' : null,
      };
    });
  }

  /** `expectedRev` is REQUIRED and is an integer — never coerced (P4B rule, mandate §45). */
  function revGate(req, res, record) {
    const exp = expectedRevOf(req.body);
    if (exp === null) { err(res, 'DECISION_REV_REQUIRED', 'expectedRev is required: send the rev you were looking at.'); return false; }
    const rawRev = req.body?.expectedRev ?? req.body?.expectedVersion;
    if (!Number.isInteger(rawRev) || rawRev < 0) { err(res, 'DECISION_REV_REQUIRED', 'expectedRev must be a non-negative integer.', { field: 'expectedRev', expected: 'integer' }); return false; }
    return guardRev(req, res, record, { errorCode: 'DECISION_VERSION_CONFLICT', current: { rev: record.rev } });
  }

  /** Validate the content fields a draft or a finalize may carry. Each field is optional on a draft; all are checked when present. */
  function validateContent(body, { requireOutcome = false } = {}) {
    if (body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body))) return { ok: false, error: 'DECISION_CONTENT_INVALID', message: 'The body must be an object.' };
    const b = body ?? {};
    let outcome = null;
    if (b.outcome !== undefined && b.outcome !== null) {
      const o = validateOutcome(b.outcome);
      if (!o.ok) return o;
      outcome = o.outcome;
    } else if (requireOutcome) {
      return { ok: false, error: 'DECISION_OUTCOME_INVALID', message: 'A decision needs an outcome: progress, hold or reject.', allowed: DECISION_OUTCOMES };
    }
    const reasons = validateDecisionReasons(b.reasonCodes, { outcome: requireOutcome ? outcome : null });
    if (!reasons.ok) return reasons;
    const note = validateNote(b.note);
    if (!note.ok) return note;
    const shapes = validateEvidenceRefShapes(b.evidenceRefs);
    if (!shapes.ok) return shapes;
    return { ok: true, outcome, reasonCodes: reasons.codes, note: note.text, refShapes: shapes.refs, provided: { outcome: b.outcome !== undefined, reasonCodes: b.reasonCodes !== undefined, note: b.note !== undefined, evidenceRefs: b.evidenceRefs !== undefined } };
  }

  const resolveRefs = (refs, kase) => resolveEvidenceRefs(refs, { db, kase, testProviderEnabled, providers: PROVIDERS });

  // ---------------------------------------------------------------- read

  orgRouter.get('/rooms/:id/decision', (req, res) => {
    const got = roomFor(req, res, 'decision_view');
    if (!got) return;
    if (!storeOr500(res)) return;
    const { room: kase, role } = got;
    const { rows, omitted, duplicateHeads } = rowsOf(kase);
    // Two formal rows both claiming to be current is corruption, not a tie —
    // there is no honest "current decision" to show (§120). Say so.
    if (duplicateHeads.length) return err(res, 'DECISION_STATE_UNKNOWN', 'This case\'s decision record cannot be read.');
    const head = chainHead(rows);
    const current = head && isFormal(head) ? decisionView(head) : null;
    const advisory = head && !isFormal(head) ? decisionView(head) : null;
    const { visible, withheld } = assessmentsVisible(req, kase);
    const summary = summariseAssessments(visible, { withheld });
    const removed = subjectRemoved(kase);
    const blocked = isBlocked(kase.playerId, kase.orgId);
    const canFinalize = roomCan(role, 'decision_finalize');
    const completedTrials = (db.trials ?? []).filter((t) => t && t.orgId === kase.orgId && t.playerId === kase.playerId && (!t.caseId || t.caseId === kase.id) && t.completion?.state === 'completed').length;
    res.json({
      current,
      advisory,
      draft: draftView(kase.decisionDraft ?? null),
      history: rows.slice().reverse().map((d) => decisionView(d)),
      omitted,
      duplicateHeads,
      assessments: summary,
      evidence: evidenceCandidates({ db, kase, assessmentsVisible: visible, trialEvidenceViews: ctx.trialEvidenceViews ?? null, providers: PROVIDERS, testProviderEnabled }),
      requirements: decisionRequirements({
        role, canFinalize, status: kase.room?.status ?? null,
        submittedAssessments: summary.submitted, completedTrials,
        blocked, subjectRemoved: removed, draft: kase.decisionDraft ?? null, hasFinal: !!current,
        availability: outcomeAvailability(kase, role),
      }),
      blocked,
      subjectRemoved: removed,
      vocabulary: { outcomes: DECISION_OUTCOMES, outcomeLabels: Object.fromEntries(DECISION_OUTCOMES.map((o) => [o, OUTCOME_MAP[o].label])), reasonCategories: REASON_CATEGORIES, evidenceRefKinds: EVIDENCE_REF_KINDS },
      limits: DECISION_LIMITS,
      policyVersion: DECISION_POLICY_VERSION,
      note: 'A formal decision is the club\'s internal decision about this case. It is not an offer, it is not sent to the player, and nothing in ScoutBox infers it from evidence.',
    });
  });

  // ---------------------------------------------------------------- draft

  orgRouter.post('/rooms/:id/decision/draft', (req, res) => {
    const got = roomFor(req, res, 'decision_draft');
    if (!got) return;
    if (!storeOr500(res)) return;
    const { room: kase } = got;
    const key = normaliseDecisionClientKey(req.body?.clientKey);
    if (!key.ok) return err(res, key.error, key.message);
    const content = validateContent(req.body);
    if (!content.ok) return err(res, content.error, content.message, content.field ? { field: content.field } : (content.allowed ? { allowed: content.allowed } : {}));
    const fp = payloadFingerprint({ outcome: content.outcome, reasonCodes: content.reasonCodes, note: content.note, refs: content.refShapes.map((r) => `${r.kind}:${r.id}`) });
    // Replay: the same key on the live draft, or on the formal row that draft became.
    if (key.key) {
      const dr = kase.decisionDraft;
      if (dr?.keys?.create?.key === key.key) {
        if (dr.keys.create.fp === fp) return res.json({ draft: draftView(dr), idempotent: true });
        return err(res, 'DECISION_IDEMPOTENCY_CONFLICT', 'This clientKey was already used for a different draft.');
      }
      const became = (db.roomDecisions ?? []).find((d) => d && d.roomId === kase.id && d.orgId === kase.orgId && d.keys?.draft?.key === key.key);
      if (became) {
        if (became.keys.draft.fp === fp) return res.json({ draft: null, decision: decisionView(became), idempotent: true });
        return err(res, 'DECISION_IDEMPOTENCY_CONFLICT', 'This clientKey was already used for a different draft.');
      }
    }
    if (subjectRemoved(kase)) return err(res, 'DECISION_SUBJECT_REMOVED', 'This player removed their ScoutBox account. The case stays on record; no new decision is written about a person who left.');
    if (kase.decisionDraft) return err(res, 'DECISION_INVALID_STATE', 'This case already has a draft. Edit it or discard it.', { current: { draftId: kase.decisionDraft.id, rev: kase.decisionDraft.rev } });
    if (limited('decision_draft', req.org.id)) return res.status(429).json(rateLimitedBody('decision_draft'));
    const refs = resolveRefs(content.refShapes, kase);
    if (!refs.ok) return err(res, refs.error, refs.message, { ref: refs.ref });
    if (content.note && !moderateOrRefuse(res, content.note, { kind: 'recruitment_decision', orgId: req.org.id, userId: req.orgUser.id })) return;
    const at = now();
    const by = actor(req);
    kase.decisionDraft = {
      id: nextId('rdraft'), outcome: content.outcome, reasonCodes: content.reasonCodes, note: content.note, evidenceRefs: refs.refs,
      by, createdAt: at, updatedAt: at, updatedBy: by, rev: 1, revAt: at,
      keys: { create: key.key ? { key: key.key, fp } : null },
    };
    audit(kase, 'org', req.orgUser.id, req.orgUser.name, 'room_decision_drafted', { draftId: kase.decisionDraft.id, outcome: content.outcome, note: !!content.note });
    persistNow();
    res.status(201).json({ draft: draftView(kase.decisionDraft) });
  });

  orgRouter.patch('/rooms/:id/decision/draft', (req, res) => {
    const got = roomFor(req, res, 'decision_draft');
    if (!got) return;
    if (!storeOr500(res)) return;
    const { room: kase } = got;
    const dr = kase.decisionDraft;
    if (!dr) return err(res, 'DECISION_NOT_FOUND', 'This case has no draft decision.');
    if (subjectRemoved(kase)) return err(res, 'DECISION_SUBJECT_REMOVED', 'This player removed their ScoutBox account. The draft can no longer be changed.');
    const content = validateContent(req.body);
    if (!content.ok) return err(res, content.error, content.message, content.field ? { field: content.field } : (content.allowed ? { allowed: content.allowed } : {}));
    if (!revGate(req, res, dr)) return;
    if (limited('decision_draft', req.org.id)) return res.status(429).json(rateLimitedBody('decision_draft'));
    let refs = null;
    if (content.provided.evidenceRefs) {
      refs = resolveRefs(content.refShapes, kase);
      if (!refs.ok) return err(res, refs.error, refs.message, { ref: refs.ref });
    }
    if (content.provided.note && content.note && !moderateOrRefuse(res, content.note, { kind: 'recruitment_decision', orgId: req.org.id, userId: req.orgUser.id })) return;
    const at = now();
    if (content.provided.outcome) dr.outcome = content.outcome;
    if (content.provided.reasonCodes) dr.reasonCodes = content.reasonCodes;
    if (content.provided.note) dr.note = content.note;
    if (refs) dr.evidenceRefs = refs.refs;
    dr.updatedAt = at;
    dr.updatedBy = actor(req);
    dr.rev = (Number.isInteger(dr.rev) ? dr.rev : 1) + 1;
    dr.revAt = at;
    persistNow();
    res.json({ draft: draftView(dr) });
  });

  orgRouter.delete('/rooms/:id/decision/draft', (req, res) => {
    const got = roomFor(req, res, 'decision_draft');
    if (!got) return;
    const { room: kase } = got;
    const dr = kase.decisionDraft;
    if (!dr) return err(res, 'DECISION_NOT_FOUND', 'This case has no draft decision.');
    if (!revGate(req, res, dr)) return;
    kase.decisionDraft = null;
    audit(kase, 'org', req.orgUser.id, req.orgUser.name, 'room_decision_draft_discarded', { draftId: dr.id, outcome: dr.outcome ?? null });
    persistNow();
    res.json({ draft: null, discarded: { id: dr.id } });
  });

  // ------------------------------------------------------------- finalize

  function finalizeHandler(mode) {
    return (req, res) => {
      const got = roomFor(req, res, 'decision_finalize');
      if (!got) return;
      if (!storeOr500(res)) return;
      const { room: kase, role } = got;
      const at = now();
      const key = normaliseDecisionClientKey(req.body?.clientKey);
      if (!key.ok) return err(res, key.error, key.message);

      // Replay of a finalize: the same key on a formal row of this case.
      const { rows, duplicateHeads } = rowsOf(kase);
      if (duplicateHeads.length) return err(res, 'DECISION_STATE_UNKNOWN', 'This case\'s decision record cannot be read; nothing new is written on top of it.');
      const dr = kase.decisionDraft ?? null;
      const supersedesRaw = req.body?.supersedes;
      const fp = dr ? payloadFingerprint({ draftId: dr.id, outcome: dr.outcome, reasonCodes: dr.reasonCodes, note: dr.note, refs: (dr.evidenceRefs ?? []).map((r) => `${r.kind}:${r.id}`), supersedes: typeof supersedesRaw === 'string' ? supersedesRaw : null }) : null;
      if (key.key) {
        const prior = rows.find((d) => isFormal(d) && d.keys?.finalize?.key === key.key);
        if (prior) {
          if (prior.keys.finalize.fp === fp || (dr === null && prior.keys.finalize.fp)) {
            // The draft is gone because THIS key already finalized it; same key, same decision.
            if (dr === null || prior.keys.finalize.fp === fp) return res.json({ decision: decisionView(prior), lifecycle: prior.lifecycle ?? null, idempotent: true });
          }
          return err(res, 'DECISION_IDEMPOTENCY_CONFLICT', 'This clientKey was already used for a different decision.');
        }
      }

      if (subjectRemoved(kase)) return err(res, 'DECISION_SUBJECT_REMOVED', 'This player removed their ScoutBox account. The case stays on record; no new decision is written about a person who left.');
      if (!dr) return err(res, 'DECISION_INVALID_STATE', 'There is no draft to finalize. Open a draft, then finalize it.');
      if (!revGate(req, res, dr)) return;

      // The content is the draft's, re-validated as a FINAL decision now.
      const content = validateContent({ outcome: dr.outcome, reasonCodes: dr.reasonCodes, note: dr.note, evidenceRefs: dr.evidenceRefs ?? [] }, { requireOutcome: true });
      if (!content.ok) return err(res, content.error, content.message, content.allowed ? { allowed: content.allowed } : {});
      const outcome = content.outcome;
      const map = OUTCOME_MAP[outcome];
      // References are resolved AGAIN now: an assessment invalidated since the draft, a session withdrawn, a record superseded — none of it is cited.
      const refs = resolveRefs(content.refShapes, kase);
      if (!refs.ok) return err(res, refs.error, refs.message, { ref: refs.ref });

      // Supersession: a current FORMAL decision must be named and its rev matched (§43, §44). An advisory recommendation at the head is simply superseded.
      const head = chainHead(rows);
      const headFormal = head && isFormal(head) ? head : null;
      let supersession = null;
      if (headFormal) {
        if (typeof supersedesRaw !== 'string' || supersedesRaw !== headFormal.id) {
          return err(res, 'DECISION_ALREADY_FINAL', 'This case already has a formal decision. To replace it, name it as `supersedes` with its current `supersedesRev` and a reason.', { current: { decisionId: headFormal.id, rev: Number.isInteger(headFormal.rev) ? headFormal.rev : 1, outcome: headFormal.outcome } });
        }
        const sr = req.body?.supersedesRev;
        if (!Number.isInteger(sr) || sr < 0) return err(res, 'DECISION_REV_REQUIRED', 'supersedesRev must be the current decision\'s rev, as an integer.', { field: 'supersedesRev', expected: 'integer' });
        const headRev = Number.isInteger(headFormal.rev) ? headFormal.rev : 1;
        if (sr !== headRev) return err(res, 'DECISION_VERSION_CONFLICT', 'The formal decision changed while you were looking. Reload and try again.', { current: { decisionId: headFormal.id, rev: headRev } });
        const reason = validateNote(req.body?.supersessionReason, { field: 'supersessionReason', max: DECISION_LIMITS.supersessionReason });
        if (!reason.ok) return err(res, reason.error, reason.message, { field: reason.field });
        if (!reason.text) return err(res, 'DECISION_CONTENT_INVALID', 'Replacing a formal decision needs a reason the history will keep.', { field: 'supersessionReason' });
        supersession = { of: headFormal.id, reason: reason.text };
      } else if (mode === 'supersede') {
        return err(res, 'DECISION_INVALID_STATE', 'There is no formal decision to supersede on this case.');
      } else if (typeof supersedesRaw === 'string' && supersedesRaw) {
        return err(res, 'DECISION_INVALID_STATE', 'There is no formal decision with that id to supersede.', { supersedes: supersedesRaw });
      }

      // A blocked family: a hold or a rejection is internal; progressing toward an offer is not taken while the block stands (§72).
      if (outcome === 'progress' && isBlocked(kase.playerId, kase.orgId)) return err(res, 'DECISION_BLOCKED', 'This player (or their guardian) has blocked your organisation. A decision to progress is not recorded while the block stands; a hold or a rejection may be.');
      if (limited('decision_finalize', req.org.id)) return res.status(429).json(rateLimitedBody('decision_finalize'));
      if (content.note && !moderateOrRefuse(res, content.note, { kind: 'recruitment_decision', orgId: req.org.id, userId: req.orgUser.id })) return;
      if (supersession?.reason && !moderateOrRefuse(res, supersession.reason, { kind: 'recruitment_decision', orgId: req.org.id, userId: req.orgUser.id })) return;

      // Failure injection (M13 mechanism): the write refuses BEFORE anything is
      // recorded — no row, no history, no case move, no notification (§54).
      const inject = db.deliveryFailInject;
      if (inject && Number(inject.decision ?? 0) > 0) {
        inject.decision = Number(inject.decision) - 1;
        persistNow();
        console.error(`DECISION transport_failed finalize case=${kase.id}`);
        return err(res, 'DECISION_TRANSPORT_REFUSED', 'The decision could not be recorded. Nothing was changed; try again.');
      }

      // ---- The formal row. Built in memory; persisted once, with the case move, or not at all.
      const { visible, withheld } = assessmentsVisible(req, kase);
      const summary = summariseAssessments(visible, { withheld });
      const snapshot = ctx.captureRoomSnapshot?.(kase, req, 'decision:finalize') ?? null;
      const by = actor(req);
      const row = {
        id: nextId('rdec'), roomId: kase.id, orgId: kase.orgId, playerId: kase.playerId,
        kind: 'formal', state: 'final', outcome, recommendation: map.recommendation,
        reasonCodes: content.reasonCodes, note: content.note,
        by, createdAt: at, finalizedAt: at, trigger: 'decision:finalize', clientKey: key.key,
        supersedes: head?.id ?? null, supersededById: null, supersession,
        rev: 1, revAt: at,
        evidenceRefs: refs.refs,
        assessmentSummary: assessmentSnapshot(summary),
        snapshot: snapshot ? { at: snapshot.at, trust: snapshot.trust, sourceRefs: snapshot.sourceRefs, snapshotId: snapshot.id } : null,
        keys: { finalize: key.key ? { key: key.key, fp } : null, draft: dr.keys?.create ?? null },
        draftId: dr.id,
        lifecycle: null,
        policyVersion: DECISION_POLICY_VERSION,
      };

      // ---- The case, through the ONE validator, which now sees this row as the evidence a progress needs.
      const from = kase.room.status;
      const prevSupersededById = head ? head.supersededById : null;
      db.roomDecisions.push(row);
      if (head) head.supersededById = row.id;
      const rollback = () => { db.roomDecisions.splice(db.roomDecisions.indexOf(row), 1); if (head) head.supersededById = prevSupersededById; };
      let lifecycle;
      if (from === LIFECYCLE_ACTIONS[map.action].to) {
        lifecycle = { action: map.action, from, to: from, applied: false, reason: 'already_there', at };
      } else {
        const verdict = canTransitionRecruitmentCase(kase, map.action, { role, evidence: evidenceProvider(), reasonCodes: map.lifecycleReasons, now: at });
        if (!verdict.ok) {
          rollback();
          return err(res, 'DECISION_LIFECYCLE_CONFLICT', `The case at "${ROOM_STATUS_LABELS[from] ?? from}" cannot take the step this decision asks for (${map.action}). ${verdict.message ?? ''}`.trim(), { lifecycle: verdict.error, allowed: verdict.allowed ?? [], current: { status: from } });
        }
        const moved = ctx.applyLifecycleTransition({ req, room: kase, to: verdict.to, reasonCodes: map.lifecycleReasons, trigger: `decision:finalize:${row.id}` });
        const last = kase.history[kase.history.length - 1];
        if (last?.action === 'room_status_changed') {
          last.detail = { ...last.detail, lifecycleAction: map.action, clientKey: null, policyVersion: RECRUITMENT_LIFECYCLE_POLICY_VERSION, decisionId: row.id };
        }
        lifecycle = { action: map.action, from: moved.from, to: moved.to, applied: true, at };
      }
      row.lifecycle = lifecycle;
      if (headFormal) { headFormal.rev = (Number.isInteger(headFormal.rev) ? headFormal.rev : 1) + 1; headFormal.revAt = at; }
      kase.decisionDraft = null;

      const action = headFormal ? 'room_decision_superseded' : 'room_decision_finalized';
      audit(kase, 'org', req.orgUser.id, req.orgUser.name, action, { decisionId: row.id, outcome, supersedes: headFormal?.id ?? null, reasonCodes: content.reasonCodes, note: !!content.note, to: lifecycle.applied ? lifecycle.to : undefined });
      persistNow();

      broadcast?.(action, { orgId: kase.orgId, roomId: kase.id, decisionId: row.id });
      if (TERMINAL_ROOM_STATUSES.includes(kase.room.status)) {
        // The Second Look contract: the same ids-only event M17 broadcasts when a room is archived.
        broadcast?.('recruitment_room_archived', { orgId: kase.orgId, roomId: kase.id });
      }
      for (const uid of new Set([kase.ownerUserId, kase.room?.leadScoutUserId])) {
        if (!uid || uid === req.orgUser.id) continue;
        notify({ kind: 'org_user', id: uid }, 'recruitment_room', `Recruitment Room — ${kase.playerName ?? 'a removed player'}: formal decision recorded (${map.label}).`, kase.id);
      }
      res.status(201).json({ decision: decisionView(row), lifecycle, case: lifecycle.applied ? { from: lifecycle.from, to: lifecycle.to } : { unchanged: true, status: kase.room.status }, rev: kase.room.rev });
    };
  }
  orgRouter.post('/rooms/:id/decision/finalize', finalizeHandler('finalize'));
  orgRouter.post('/rooms/:id/decision/supersede', finalizeHandler('supersede'));

  // ------------------------------------------------------------ vocabulary

  orgRouter.get('/recruitment/decision-policy', (_req, res) => {
    res.json({
      policyVersion: DECISION_POLICY_VERSION,
      outcomes: DECISION_OUTCOMES.map((o) => ({ outcome: o, label: OUTCOME_MAP[o].label, recommendation: OUTCOME_MAP[o].recommendation, lifecycleAction: OUTCOME_MAP[o].action, to: LIFECYCLE_ACTIONS[OUTCOME_MAP[o].action].to })),
      reasonCategories: REASON_CATEGORIES,
      evidenceRefKinds: EVIDENCE_REF_KINDS,
      limits: DECISION_LIMITS,
      note: 'Evidence informs assessment; assessment informs discussion; discussion informs a formal human decision; that decision is not an offer and is never sent to the player. A positive decision stops at offer consideration.',
    });
  });

  ctx.decisionRowsOf = rowsOf;
  return { rowsOf };
}

export { decisionKind };
