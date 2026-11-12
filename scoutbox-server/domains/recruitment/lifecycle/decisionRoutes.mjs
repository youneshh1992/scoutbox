/**
 * Formal recruitment decision routes: the club's internal decision boundary.
 * A positive decision ends at `offer_consideration`; nothing here writes an
 * offer or notifies the player or guardian. A final row is never edited; a
 * later decision supersedes it.
 */

import { roomRole, roomCan, ROOM_TRANSITIONS, TERMINAL_ROOM_STATUSES, ROOM_STATUS_LABELS } from '../rooms/shared.mjs';
import { guardRev, expectedRevOf } from '../../platform/concurrency.mjs';
import { rateLimitedBody, limitCheck } from '../../platform/rateLimit.mjs';
import { PROVIDERS } from '../../development/public.mjs';
import {
  canTransitionRecruitmentCase,
  LIFECYCLE_ACTIONS,
  NULL_EVIDENCE_PROVIDER,
  RECRUITMENT_LIFECYCLE_POLICY_VERSION,
} from './lifecycle.mjs';
import { sendDomainError } from './errors.mjs';
import {
  DECISION_POLICY_VERSION,
  DECISION_OUTCOMES,
  OUTCOME_MAP,
  EVIDENCE_REF_KINDS,
  DECISION_LIMITS,
  REASON_CATEGORIES,
  normaliseDecisionClientKey,
  payloadFingerprint,
  isFormal,
  decisionKind,
  validateOutcome,
  validateDecisionReasons,
  validateNote,
  validateEvidenceRefShapes,
  resolveEvidenceRefs,
  decisionIntegrity,
  duplicateFinalHeads,
  chainHead,
  byCreatedThenId,
  summariseAssessments,
  assessmentSnapshot,
  evidenceCandidates,
  decisionView,
  draftView,
  decisionRequirements,
} from './decision.mjs';
import { now } from '../../platform/clock.mjs';
import * as v from 'valibot';
import { id, oneOf, parseInput, REV_FIELDS, text, wholeNumber } from '../../platform/schemas.mjs';

// Shape and type only: the reason taxonomy, the note's cleaning and the references' case are judged by
// validateContent, which also re-judges a stored draft at finalize.
const CONTENT = {
  outcome: v.nullish(oneOf(DECISION_OUTCOMES)),
  reasonCodes: v.nullish(v.array(v.string())),
  note: v.nullish(text(DECISION_LIMITS.note)),
  evidenceRefs: v.nullish(
    v.pipe(v.array(v.strictObject({ kind: oneOf(EVIDENCE_REF_KINDS), id })), v.maxLength(DECISION_LIMITS.evidenceRefs)),
  ),
};
// `clientKey` keeps the platform's idempotency-key rule (normaliseDecisionClientKey).
const KEY = { clientKey: v.optional(v.unknown()) };
const NewDraft = v.strictObject({ ...CONTENT, ...KEY });
const DraftEdit = v.strictObject({ ...CONTENT, ...REV_FIELDS });
const DraftDiscard = v.strictObject(REV_FIELDS);
const Finalize = v.strictObject({
  ...KEY,
  ...REV_FIELDS,
  supersedes: v.nullish(id),
  supersedesRev: v.nullish(wholeNumber({ min: 0 })),
  supersessionReason: v.nullish(text(DECISION_LIMITS.supersessionReason)),
});
export const DECISION_INPUT_CODES = Object.freeze({
  codes: { FIELD_INVALID: 'DECISION_CONTENT_INVALID' },
  fieldCodes: {
    outcome: 'DECISION_OUTCOME_INVALID',
    'reasonCodes.*': 'DECISION_REASON_INVALID',
    'evidenceRefs.*': 'DECISION_EVIDENCE_INVALID',
    expectedRev: 'DECISION_REV_REQUIRED',
    expectedVersion: 'DECISION_REV_REQUIRED',
    supersedesRev: 'DECISION_REV_REQUIRED',
  },
});

export function registerDecision(ctx) {
  const {
    orgRouter,
    nextId,
    notify,
    broadcast,
    findPlayer,
    isBlocked,
    rateLimit,
    isLead,
    moderateOrRefuse,
    auditEntry,
    testProviderEnabled = false,
    recruitmentCases,
    unit, // drafts, formal rows and the case move are explicit repository writes, one unit per act
    recruitmentReads,
    scoutingReads,
    boxCamReads, // a cited Box Cam session
  } = ctx;
  const reads = { ...recruitmentReads, ...scoutingReads, boxCam: boxCamReads };
  if (typeof reads?.trials?.forOrgPlayer !== 'function')
    throw new TypeError('registerDecision needs recruitmentReads (trials) from the data layer');
  if (typeof unit !== 'function' || !recruitmentCases?.cases)
    throw new TypeError('registerDecision needs the recruitment-cases repository and unit from the data layer');
  const { cases, decisions } = recruitmentCases;

  const err = (res, error, message, extra = {}) => sendDomainError(res, { error, message, ...extra }, 'decision');
  /** The request body read with its schema, or `undefined` once the refusal is sent. */
  const decisionInput = (res, schema, body) => {
    const parsed = parseInput(schema, body ?? {}, DECISION_INPUT_CODES);
    if (parsed.ok) return parsed.value;
    sendDomainError(res, parsed, 'decision');
    return undefined;
  };
  const limited = limitCheck(rateLimit);
  const roleFor = (req, room) => roomRole({ room, user: req.orgUser, isLead: isLead(req.orgUser) });
  const evidenceProvider = () => ctx.recruitmentEvidenceProvider ?? NULL_EVIDENCE_PROVIDER;
  const actor = (req) => ({ userId: req.orgUser.id, name: req.orgUser.name, role: req.orgUser.role ?? null });
  const byStaff = (req, action, detail) => ({
    history: [auditEntry('org', req.orgUser.id, req.orgUser.name, action, detail)],
  });

  // ------------------------------------------------------------- lookups

  function roomFor(req, res, need) {
    const room = ctx.findRoomForRequest(req, res);
    if (!room) return null;
    const role = roleFor(req, room);
    if (!roomCan(role, need)) {
      err(
        res,
        'DECISION_NOT_PERMITTED',
        need === 'decision_view'
          ? 'Your role cannot read decisions in this room.'
          : 'Only a room lead or recruitment lead can draft or finalize a recruitment decision.',
      );
      return null;
    }
    return { room, role };
  }

  /** Corrupt formal rows omitted and counted; recommendation rows are left to the rooms' reading. */
  function rowsOf(kase) {
    const good = [];
    let omitted = 0;
    for (const d of reads.decisions.forRoom(kase.id)) {
      if (d.orgId !== kase.orgId) continue;
      if (isFormal(d)) {
        const problems = decisionIntegrity(d, { orgId: kase.orgId, caseId: kase.id });
        if (problems.length) {
          omitted += 1;
          console.error(`DECISION integrity ${d.id ?? '?'}: ${problems.join(',')}`);
          continue;
        }
      }
      good.push(d);
    }
    good.sort(byCreatedThenId);
    const dup = duplicateFinalHeads(good);
    if (dup.length) console.error(`DECISION integrity case=${kase.id} duplicate_final_heads ${dup.join(',')}`);
    return { rows: good, omitted, duplicateHeads: dup };
  }

  /** The Room's blind rule: a scout reads a peer's submitted assessment only after submitting their own. */
  function assessmentsVisible(req, kase) {
    const mine = reads.assessments.forOrgPlayer(kase.orgId, kase.playerId);
    const lead = isLead(req.orgUser);
    const ownNonDraft = mine.some((a) => a.scoutUserId === req.orgUser.id && a.state !== 'draft');
    const visible = mine.filter(
      (a) => lead || a.scoutUserId === req.orgUser.id || (a.state !== 'draft' && ownNonDraft),
    );
    return {
      visible,
      withheld: mine.filter((a) => a.state !== 'draft').length - visible.filter((a) => a.state !== 'draft').length,
    };
  }

  const subjectRemoved = (kase) => !!kase.subjectRemovedAt || !findPlayer(kase.playerId);

  /** Edge and role only: the evidence a progress needs is the decision itself. */
  function outcomeAvailability(kase, role) {
    const status = kase.room?.status;
    return DECISION_OUTCOMES.map((outcome) => {
      const def = LIFECYCLE_ACTIONS[OUTCOME_MAP[outcome].action];
      const to = def.to;
      const roleOk =
        canTransitionRecruitmentCase(kase, OUTCOME_MAP[outcome].action, {
          role,
          evidence: NULL_EVIDENCE_PROVIDER,
          forAvailability: true,
        }).error !== 'LIFECYCLE_NOT_PERMITTED';
      const alreadyThere = status === to;
      const edge = alreadyThere || (ROOM_TRANSITIONS[status] ?? []).includes(to);
      const applicable = !def.applicableFrom || def.applicableFrom(status);
      return {
        outcome,
        action: OUTCOME_MAP[outcome].action,
        to,
        toLabel: ROOM_STATUS_LABELS[to] ?? to,
        possible: roleOk && edge && applicable,
        alreadyThere,
        reason: !roleOk ? 'role' : !edge ? 'transition' : !applicable ? 'not_applicable' : null,
      };
    });
  }

  /** Required, and an integer, never coerced (the Trial routes' rule). */
  function revGate(req, res, record) {
    const exp = expectedRevOf(req.body);
    if (exp === null) {
      err(res, 'DECISION_REV_REQUIRED', 'expectedRev is required: send the rev you were looking at.');
      return false;
    }
    const rawRev = req.body?.expectedRev ?? req.body?.expectedVersion;
    if (!Number.isInteger(rawRev) || rawRev < 0) {
      err(res, 'DECISION_REV_REQUIRED', 'expectedRev must be a non-negative integer.', {
        field: 'expectedRev',
        expected: 'integer',
      });
      return false;
    }
    return guardRev(req, res, record, { errorCode: 'DECISION_VERSION_CONFLICT', current: { rev: record.rev } });
  }

  /** Each field is optional on a draft; all are checked when present. */
  function validateContent(body, { requireOutcome = false } = {}) {
    if (body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body)))
      return { ok: false, error: 'DECISION_CONTENT_INVALID', message: 'The body must be an object.' };
    const b = body ?? {};
    let outcome = null;
    if (b.outcome !== undefined && b.outcome !== null) {
      const o = validateOutcome(b.outcome);
      if (!o.ok) return o;
      outcome = o.outcome;
    } else if (requireOutcome) {
      return {
        ok: false,
        error: 'DECISION_OUTCOME_INVALID',
        message: 'A decision needs an outcome: progress, hold or reject.',
        allowed: DECISION_OUTCOMES,
      };
    }
    const reasons = validateDecisionReasons(b.reasonCodes, { outcome: requireOutcome ? outcome : null });
    if (!reasons.ok) return reasons;
    const note = validateNote(b.note);
    if (!note.ok) return note;
    const shapes = validateEvidenceRefShapes(b.evidenceRefs);
    if (!shapes.ok) return shapes;
    return {
      ok: true,
      outcome,
      reasonCodes: reasons.codes,
      note: note.text,
      refShapes: shapes.refs,
      provided: {
        outcome: b.outcome !== undefined,
        reasonCodes: b.reasonCodes !== undefined,
        note: b.note !== undefined,
        evidenceRefs: b.evidenceRefs !== undefined,
      },
    };
  }

  const resolveRefs = (refs, kase) =>
    resolveEvidenceRefs(refs, { reads, kase, testProviderEnabled, providers: PROVIDERS });

  // ---------------------------------------------------------------- read

  orgRouter.get('/rooms/:id/decision', (req, res) => {
    const got = roomFor(req, res, 'decision_view');
    if (!got) return;
    const { room: kase, role } = got;
    const { rows, omitted, duplicateHeads } = rowsOf(kase);
    // Two current formal rows is corruption, not a tie: there is no honest current decision to show.
    if (duplicateHeads.length) return err(res, 'DECISION_STATE_UNKNOWN', "This case's decision record cannot be read.");
    const head = chainHead(rows);
    const current = head && isFormal(head) ? decisionView(head) : null;
    const advisory = head && !isFormal(head) ? decisionView(head) : null;
    const { visible, withheld } = assessmentsVisible(req, kase);
    const summary = summariseAssessments(visible, { withheld });
    const removed = subjectRemoved(kase);
    const blocked = isBlocked(kase.playerId, kase.orgId);
    const canFinalize = roomCan(role, 'decision_finalize');
    const completedTrials = reads.trials
      .forOrgPlayer(kase.orgId, kase.playerId)
      .filter((t) => (!t.caseId || t.caseId === kase.id) && t.completion?.state === 'completed').length;
    res.json({
      current,
      advisory,
      draft: draftView(kase.decisionDraft ?? null),
      history: rows
        .slice()
        .reverse()
        .map((d) => decisionView(d)),
      omitted,
      duplicateHeads,
      assessments: summary,
      evidence: evidenceCandidates({
        reads,
        kase,
        assessmentsVisible: visible,
        trialEvidenceViews: ctx.trialEvidenceViews ?? null,
        providers: PROVIDERS,
        testProviderEnabled,
      }),
      requirements: decisionRequirements({
        role,
        canFinalize,
        status: kase.room?.status ?? null,
        submittedAssessments: summary.submitted,
        completedTrials,
        blocked,
        subjectRemoved: removed,
        draft: kase.decisionDraft ?? null,
        hasFinal: !!current,
        availability: outcomeAvailability(kase, role),
      }),
      blocked,
      subjectRemoved: removed,
      vocabulary: {
        outcomes: DECISION_OUTCOMES,
        outcomeLabels: Object.fromEntries(DECISION_OUTCOMES.map((o) => [o, OUTCOME_MAP[o].label])),
        reasonCategories: REASON_CATEGORIES,
        evidenceRefKinds: EVIDENCE_REF_KINDS,
      },
      limits: DECISION_LIMITS,
      policyVersion: DECISION_POLICY_VERSION,
      note: "A formal decision is the club's internal decision about this case. It is not an offer, it is not sent to the player, and nothing in ScoutBox infers it from evidence.",
    });
  });

  // ---------------------------------------------------------------- draft

  orgRouter.post('/rooms/:id/decision/draft', (req, res) => {
    const got = roomFor(req, res, 'decision_draft');
    if (!got) return;
    const { room: kase } = got;
    const body = decisionInput(res, NewDraft, req.body);
    if (!body) return;
    const key = normaliseDecisionClientKey(body.clientKey);
    if (!key.ok) return err(res, key.error, key.message);
    const content = validateContent(body);
    if (!content.ok)
      return err(
        res,
        content.error,
        content.message,
        content.field ? { field: content.field } : content.allowed ? { allowed: content.allowed } : {},
      );
    const fp = payloadFingerprint({
      outcome: content.outcome,
      reasonCodes: content.reasonCodes,
      note: content.note,
      refs: content.refShapes.map((r) => `${r.kind}:${r.id}`),
    });
    // The same key on the live draft, or on the formal row that draft became.
    if (key.key) {
      const dr = kase.decisionDraft;
      if (dr?.keys?.create?.key === key.key) {
        if (dr.keys.create.fp === fp) return res.json({ draft: draftView(dr), idempotent: true });
        return err(res, 'DECISION_IDEMPOTENCY_CONFLICT', 'This clientKey was already used for a different draft.');
      }
      const became = reads.decisions
        .forRoom(kase.id)
        .find((d) => d.orgId === kase.orgId && d.keys?.draft?.key === key.key);
      if (became) {
        if (became.keys.draft.fp === fp)
          return res.json({ draft: null, decision: decisionView(became), idempotent: true });
        return err(res, 'DECISION_IDEMPOTENCY_CONFLICT', 'This clientKey was already used for a different draft.');
      }
    }
    if (subjectRemoved(kase))
      return err(
        res,
        'DECISION_SUBJECT_REMOVED',
        'This player removed their ScoutBox account. The case stays on record; no new decision is written about a person who left.',
      );
    if (kase.decisionDraft)
      return err(res, 'DECISION_INVALID_STATE', 'This case already has a draft. Edit it or discard it.', {
        current: { draftId: kase.decisionDraft.id, rev: kase.decisionDraft.rev },
      });
    if (limited('decision_draft', req.org.id)) return res.status(429).json(rateLimitedBody('decision_draft'));
    const refs = resolveRefs(content.refShapes, kase);
    if (!refs.ok) return err(res, refs.error, refs.message, { ref: refs.ref });
    if (
      content.note &&
      !moderateOrRefuse(res, content.note, { kind: 'recruitment_decision', orgId: req.org.id, userId: req.orgUser.id })
    )
      return;
    const at = now();
    const by = actor(req);
    const draft = {
      id: nextId('rdraft'),
      outcome: content.outcome,
      reasonCodes: content.reasonCodes,
      note: content.note,
      evidenceRefs: refs.refs,
      by,
      createdAt: at,
      updatedAt: at,
      updatedBy: by,
      rev: 1,
      revAt: at,
      keys: { create: key.key ? { key: key.key, fp } : null },
    };
    const fresh = cases.startDraft(
      kase.id,
      { draft },
      byStaff(req, 'room_decision_drafted', { draftId: draft.id, outcome: content.outcome, note: !!content.note }),
    );
    res.status(201).json({ draft: draftView(fresh.decisionDraft) });
  });

  orgRouter.patch('/rooms/:id/decision/draft', (req, res) => {
    const got = roomFor(req, res, 'decision_draft');
    if (!got) return;
    const { room: kase } = got;
    const dr = kase.decisionDraft;
    if (!dr) return err(res, 'DECISION_NOT_FOUND', 'This case has no draft decision.');
    if (subjectRemoved(kase))
      return err(
        res,
        'DECISION_SUBJECT_REMOVED',
        'This player removed their ScoutBox account. The draft can no longer be changed.',
      );
    const body = decisionInput(res, DraftEdit, req.body);
    if (!body) return;
    const content = validateContent(body);
    if (!content.ok)
      return err(
        res,
        content.error,
        content.message,
        content.field ? { field: content.field } : content.allowed ? { allowed: content.allowed } : {},
      );
    if (!revGate(req, res, dr)) return;
    if (limited('decision_draft', req.org.id)) return res.status(429).json(rateLimitedBody('decision_draft'));
    let refs = null;
    if (content.provided.evidenceRefs) {
      refs = resolveRefs(content.refShapes, kase);
      if (!refs.ok) return err(res, refs.error, refs.message, { ref: refs.ref });
    }
    if (
      content.provided.note &&
      content.note &&
      !moderateOrRefuse(res, content.note, { kind: 'recruitment_decision', orgId: req.org.id, userId: req.orgUser.id })
    )
      return;
    const at = now();
    const fresh = cases.editDraft(kase.id, {
      outcome: content.provided.outcome ? content.outcome : undefined,
      reasonCodes: content.provided.reasonCodes ? content.reasonCodes : undefined,
      note: content.provided.note ? content.note : undefined,
      evidenceRefs: refs ? refs.refs : undefined,
      at,
      by: actor(req),
    });
    res.json({ draft: draftView(fresh.decisionDraft) });
  });

  orgRouter.delete('/rooms/:id/decision/draft', (req, res) => {
    const got = roomFor(req, res, 'decision_draft');
    if (!got) return;
    const { room: kase } = got;
    const dr = kase.decisionDraft;
    if (!dr) return err(res, 'DECISION_NOT_FOUND', 'This case has no draft decision.');
    if (!decisionInput(res, DraftDiscard, req.body)) return;
    if (!revGate(req, res, dr)) return;
    cases.discardDraft(
      kase.id,
      {},
      byStaff(req, 'room_decision_draft_discarded', { draftId: dr.id, outcome: dr.outcome ?? null }),
    );
    res.json({ draft: null, discarded: { id: dr.id } });
  });

  // ------------------------------------------------------------- finalize

  function finalizeHandler(mode) {
    return (req, res) => {
      const got = roomFor(req, res, 'decision_finalize');
      if (!got) return;
      const { room: kase, role } = got;
      const at = now();
      const body = decisionInput(res, Finalize, req.body);
      if (!body) return;
      const key = normaliseDecisionClientKey(body.clientKey);
      if (!key.ok) return err(res, key.error, key.message);

      const { rows, duplicateHeads } = rowsOf(kase);
      if (duplicateHeads.length)
        return err(
          res,
          'DECISION_STATE_UNKNOWN',
          "This case's decision record cannot be read; nothing new is written on top of it.",
        );
      const dr = kase.decisionDraft ?? null;
      const supersedesRaw = body.supersedes ?? null;
      const fp = dr
        ? payloadFingerprint({
            draftId: dr.id,
            outcome: dr.outcome,
            reasonCodes: dr.reasonCodes,
            note: dr.note,
            refs: (dr.evidenceRefs ?? []).map((r) => `${r.kind}:${r.id}`),
            supersedes: typeof supersedesRaw === 'string' ? supersedesRaw : null,
          })
        : null;
      if (key.key) {
        const prior = rows.find((d) => isFormal(d) && d.keys?.finalize?.key === key.key);
        if (prior) {
          if (prior.keys.finalize.fp === fp || (dr === null && prior.keys.finalize.fp)) {
            // The draft is gone because this key already finalised it.
            if (dr === null || prior.keys.finalize.fp === fp)
              return res.json({ decision: decisionView(prior), lifecycle: prior.lifecycle ?? null, idempotent: true });
          }
          return err(res, 'DECISION_IDEMPOTENCY_CONFLICT', 'This clientKey was already used for a different decision.');
        }
      }

      if (subjectRemoved(kase))
        return err(
          res,
          'DECISION_SUBJECT_REMOVED',
          'This player removed their ScoutBox account. The case stays on record; no new decision is written about a person who left.',
        );
      if (!dr)
        return err(res, 'DECISION_INVALID_STATE', 'There is no draft to finalize. Open a draft, then finalize it.');
      if (!revGate(req, res, dr)) return;

      // Re-validated as a final decision now.
      const content = validateContent(
        { outcome: dr.outcome, reasonCodes: dr.reasonCodes, note: dr.note, evidenceRefs: dr.evidenceRefs ?? [] },
        { requireOutcome: true },
      );
      if (!content.ok)
        return err(res, content.error, content.message, content.allowed ? { allowed: content.allowed } : {});
      const outcome = content.outcome;
      const map = OUTCOME_MAP[outcome];
      // Resolved again now: an assessment invalidated, a session withdrawn or a record superseded since the draft is not cited.
      const refs = resolveRefs(content.refShapes, kase);
      if (!refs.ok) return err(res, refs.error, refs.message, { ref: refs.ref });

      // A current formal decision must be named and its rev matched; an advisory head is simply superseded.
      const head = chainHead(rows);
      const headFormal = head && isFormal(head) ? head : null;
      let supersession = null;
      if (headFormal) {
        if (typeof supersedesRaw !== 'string' || supersedesRaw !== headFormal.id) {
          return err(
            res,
            'DECISION_ALREADY_FINAL',
            'This case already has a formal decision. To replace it, name it as `supersedes` with its current `supersedesRev` and a reason.',
            {
              current: {
                decisionId: headFormal.id,
                rev: Number.isInteger(headFormal.rev) ? headFormal.rev : 1,
                outcome: headFormal.outcome,
              },
            },
          );
        }
        const sr = body.supersedesRev;
        if (!Number.isInteger(sr) || sr < 0)
          return err(res, 'DECISION_REV_REQUIRED', "supersedesRev must be the current decision's rev, as an integer.", {
            field: 'supersedesRev',
            expected: 'integer',
          });
        const headRev = Number.isInteger(headFormal.rev) ? headFormal.rev : 1;
        if (sr !== headRev)
          return err(
            res,
            'DECISION_VERSION_CONFLICT',
            'The formal decision changed while you were looking. Reload and try again.',
            { current: { decisionId: headFormal.id, rev: headRev } },
          );
        const reason = validateNote(body.supersessionReason, {
          field: 'supersessionReason',
          max: DECISION_LIMITS.supersessionReason,
        });
        if (!reason.ok) return err(res, reason.error, reason.message, { field: reason.field });
        if (!reason.text)
          return err(
            res,
            'DECISION_CONTENT_INVALID',
            'Replacing a formal decision needs a reason the history will keep.',
            { field: 'supersessionReason' },
          );
        supersession = { of: headFormal.id, reason: reason.text };
      } else if (mode === 'supersede') {
        return err(res, 'DECISION_INVALID_STATE', 'There is no formal decision to supersede on this case.');
      } else if (typeof supersedesRaw === 'string' && supersedesRaw) {
        return err(res, 'DECISION_INVALID_STATE', 'There is no formal decision with that id to supersede.', {
          supersedes: supersedesRaw,
        });
      }

      // A hold or a rejection is internal; progressing toward an offer is not taken while a block stands.
      if (outcome === 'progress' && isBlocked(kase.playerId, kase.orgId))
        return err(
          res,
          'DECISION_BLOCKED',
          'This player (or their guardian) has blocked your organisation. A decision to progress is not recorded while the block stands; a hold or a rejection may be.',
        );
      if (limited('decision_finalize', req.org.id)) return res.status(429).json(rateLimitedBody('decision_finalize'));
      if (
        content.note &&
        !moderateOrRefuse(res, content.note, {
          kind: 'recruitment_decision',
          orgId: req.org.id,
          userId: req.orgUser.id,
        })
      )
        return;
      if (
        supersession?.reason &&
        !moderateOrRefuse(res, supersession.reason, {
          kind: 'recruitment_decision',
          orgId: req.org.id,
          userId: req.orgUser.id,
        })
      )
        return;

      // The write refuses before anything is recorded.
      if (ctx.operations.delivery.consumeInjectedFailure('decision')) {
        // used up through the delivery bookkeeping (a row)
        console.error(`DECISION transport_failed finalize case=${kase.id}`);
        return err(
          res,
          'DECISION_TRANSPORT_REFUSED',
          'The decision could not be recorded. Nothing was changed; try again.',
        );
      }

      // ---- The formal row, the case move and the draft's removal: one unit of work.
      const { visible, withheld } = assessmentsVisible(req, kase);
      const summary = summariseAssessments(visible, { withheld });
      const by = actor(req);
      const from = kase.room.status;
      const action = headFormal ? 'room_decision_superseded' : 'room_decision_finalized';
      class LifecycleRefused extends Error {}
      let refused = null;
      let row;
      let lifecycle;
      let fresh;
      try {
        ({ row, lifecycle, fresh } = unit(() => {
          const snapshot = ctx.captureRoomSnapshot?.(kase, req, 'decision:finalize') ?? null;
          const formal = decisions.create({
            id: nextId('rdec'),
            roomId: kase.id,
            orgId: kase.orgId,
            playerId: kase.playerId,
            kind: 'formal',
            state: 'final',
            outcome,
            recommendation: map.recommendation,
            reasonCodes: content.reasonCodes,
            note: content.note,
            by,
            createdAt: at,
            finalizedAt: at,
            trigger: 'decision:finalize',
            clientKey: key.key,
            supersedes: head?.id ?? null,
            supersededById: null,
            supersession,
            rev: 1,
            revAt: at,
            evidenceRefs: refs.refs,
            assessmentSummary: assessmentSnapshot(summary),
            snapshot: snapshot
              ? { at: snapshot.at, trust: snapshot.trust, sourceRefs: snapshot.sourceRefs, snapshotId: snapshot.id }
              : null,
            keys: { finalize: key.key ? { key: key.key, fp } : null, draft: dr.keys?.create ?? null },
            draftId: dr.id,
            lifecycle: null,
            policyVersion: DECISION_POLICY_VERSION,
          });
          if (head) decisions.markSuperseded(head.id, { by: formal.id });
          // The validator now sees this row as the evidence a progress needs.
          let lc;
          if (from === LIFECYCLE_ACTIONS[map.action].to) {
            lc = { action: map.action, from, to: from, applied: false, reason: 'already_there', at };
          } else {
            const verdict = canTransitionRecruitmentCase(kase, map.action, {
              role,
              evidence: evidenceProvider(),
              reasonCodes: map.lifecycleReasons,
              now: at,
            });
            // A refusal rolls the whole unit back: no row, no snapshot, no supersession.
            if (!verdict.ok) {
              refused = verdict;
              throw new LifecycleRefused();
            }
            const moved = ctx.applyLifecycleTransition({
              req,
              room: kase,
              to: verdict.to,
              reasonCodes: map.lifecycleReasons,
              trigger: `decision:finalize:${formal.id}`,
              statusDetail: {
                lifecycleAction: map.action,
                clientKey: null,
                policyVersion: RECRUITMENT_LIFECYCLE_POLICY_VERSION,
                decisionId: formal.id,
              },
            });
            lc = { action: map.action, from: moved.from, to: moved.to, applied: true, at };
          }
          const saved = decisions.recordLifecycle(formal.id, { lifecycle: lc });
          if (headFormal) decisions.bump(headFormal.id, { at });
          const after = cases.discardDraft(
            kase.id,
            {},
            byStaff(req, action, {
              decisionId: formal.id,
              outcome,
              supersedes: headFormal?.id ?? null,
              reasonCodes: content.reasonCodes,
              note: !!content.note,
              to: lc.applied ? lc.to : undefined,
            }),
          );
          return { row: saved, lifecycle: lc, fresh: after };
        }));
      } catch (e) {
        if (!(e instanceof LifecycleRefused)) throw e;
      }
      if (refused)
        return err(
          res,
          'DECISION_LIFECYCLE_CONFLICT',
          `The case at "${ROOM_STATUS_LABELS[from] ?? from}" cannot take the step this decision asks for (${map.action}). ${refused.message ?? ''}`.trim(),
          { lifecycle: refused.error, allowed: refused.allowed ?? [], current: { status: from } },
        );

      const decisionEvent = { orgId: kase.orgId, roomId: kase.id, decisionId: row.id };
      if (headFormal) broadcast?.('room_decision_superseded', decisionEvent);
      else broadcast?.('room_decision_finalized', decisionEvent);
      if (TERMINAL_ROOM_STATUSES.includes(fresh.room.status)) {
        // The Second Look contract: the ids-only event the rooms broadcast when a room is archived.
        broadcast?.('recruitment_room_archived', { orgId: kase.orgId, roomId: kase.id });
      }
      for (const uid of new Set([fresh.ownerUserId, fresh.room?.leadScoutUserId])) {
        if (!uid || uid === req.orgUser.id) continue;
        notify(
          { kind: 'org_user', id: uid },
          'recruitment_room',
          `Recruitment Room — ${kase.playerName ?? 'a removed player'}: formal decision recorded (${map.label}).`,
          kase.id,
        );
      }
      res.status(201).json({
        decision: decisionView(row),
        lifecycle,
        case: lifecycle.applied
          ? { from: lifecycle.from, to: lifecycle.to }
          : { unchanged: true, status: fresh.room.status },
        rev: fresh.room.rev,
      });
    };
  }
  orgRouter.post('/rooms/:id/decision/finalize', finalizeHandler('finalize'));
  orgRouter.post('/rooms/:id/decision/supersede', finalizeHandler('supersede'));

  // ------------------------------------------------------------ vocabulary

  orgRouter.get('/recruitment/decision-policy', (_req, res) => {
    res.json({
      policyVersion: DECISION_POLICY_VERSION,
      outcomes: DECISION_OUTCOMES.map((o) => ({
        outcome: o,
        label: OUTCOME_MAP[o].label,
        recommendation: OUTCOME_MAP[o].recommendation,
        lifecycleAction: OUTCOME_MAP[o].action,
        to: LIFECYCLE_ACTIONS[OUTCOME_MAP[o].action].to,
      })),
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
