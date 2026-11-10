/**
 * Recruitment lifecycle routes.
 *
 * Two surfaces only, and neither of them is a stage setter:
 *
 *   GET  /org/rooms/:id/journey        the canonical projection, viewer-aware
 *   POST /org/rooms/:id/lifecycle      one SEMANTIC action, validated server-side
 *
 * There is deliberately no `PATCH { stage }`. A client that can name the
 * destination is a client that owns the lifecycle, and then the rules about
 * what may follow what live in whichever caller remembered them. Here the
 * client names an ACTION — "planContact", "holdCase" — and the server decides
 * whether that action is possible, permitted and supported by evidence.
 */

import {
  LIFECYCLE_ACTIONS, LIFECYCLE_ACTION_NAMES, RECRUITMENT_LIFECYCLE_POLICY_VERSION,
  canTransitionRecruitmentCase, actionPermittedForRole, NULL_EVIDENCE_PROVIDER,
  validateLifecycleReasons, LIFECYCLE_REASON_CODES,
} from './lifecycle.mjs';
import { buildRecruitmentJourney } from './journey.mjs';
import { sendDomainError } from './errors.mjs';
import { registerContact } from './contactRoutes.mjs';
import { registerTrial } from './trialRoutes.mjs';
import { registerDecision } from './decisionRoutes.mjs';
import { roomRole } from '../rooms/shared.mjs';
import { guardRev, revMeta } from '../../platform/concurrency.mjs';
import { buildShared } from '../../../m12/shared.mjs';

export function registerLifecycle(rawCtx) {
  // isLead, orgCanSee, audit and paginate come from one place rather than
  // being re-derived per domain.
  const ctx = { ...rawCtx, ...buildShared(rawCtx) };
  const { recruitmentReads, scoutingReads, orgRouter, isLead } = ctx;
  // The journey reads the club's assessments too (scoutingReads).
  if (!ctx.safetyReads?.blocks) throw new TypeError('the lifecycle routes need safetyReads (the safety repository\'s queries)');
  const journeyReads = { ...recruitmentReads, ...scoutingReads, blocks: ctx.safetyReads.blocks, player: (id) => ctx.byId.player(id) };
  if (!recruitmentReads?.contacts || !recruitmentReads?.offers) throw new TypeError('registerLifecycle needs recruitmentReads (contacts, offers) from the data layer');

  /**
   * Idempotency for lifecycle actions.
   *
   * Bound to the REQUEST identity — org, case, action and client key — and not
   * to the stage pair. `closed → reopened → closed` is three legitimate
   * transitions and the third must not be silently swallowed because the pair
   * `x → closed` was seen before. That is why the key includes the caller's own
   * clientKey and why replaying without one is simply not idempotent.
   */
  const idempotentHit = (kase, action, clientKey) => {
    if (!clientKey) return null;
    return (kase.history ?? []).find(
      (h) => h?.action === 'room_status_changed' && h.detail?.clientKey === clientKey && h.detail?.lifecycleAction === action,
    ) ?? null;
  };

  /** The composed evidence provider (evidence.mjs); without one, the null provider refuses every evidence-bearing move. */
  const evidenceProvider = () => ctx.recruitmentEvidenceProvider ?? NULL_EVIDENCE_PROVIDER;
  // The same per-request test clock the Offer and signing routes
  // honour (development only), so an expiry-derived stage reads the same here.
  const TEST_CLOCK = process.env.SCOUTBOX_TEST_CLOCK === '1' && process.env.NODE_ENV !== 'production';
  const nowOf = (req) => { if (TEST_CLOCK && req?.get) { const n = Number(req.get('x-scoutbox-test-clock')); if (Number.isFinite(n) && n > 0) return n; } return Date.now(); };

  // Domain errors answer through `sendDomainError` in errors.mjs — the ONE
  // mapping table, shared with the Contact, Trial and Decision routes.

  // ------------------------------------------------------------- journey read
  orgRouter.get('/rooms/:id/journey', (req, res) => {
    const room = ctx.findRoomForRequest(req, res);
    if (!room) return undefined;

    const out = buildRecruitmentJourney(room.id, {
      kind: req.org.level === 'grassroots' ? 'grassroots_staff' : 'org_staff',
      orgId: req.org.id,
      userId: req.orgUser.id,
      role: roomRole({ room, user: req.orgUser, isLead: isLead(req.orgUser) }),
    }, { now: nowOf(req), evidence: evidenceProvider(), historyLimit: req.query.limit, historyCursor: req.query.cursor, reads: journeyReads });

    if (!out.ok) return sendDomainError(res, out, 'journey');
    return res.json(out);
  });

  // -------------------------------------------------------- lifecycle action
  orgRouter.post('/rooms/:id/lifecycle', (req, res) => {
    const room = ctx.findRoomForRequest(req, res);
    if (!room) return undefined;

    const { action, reasonCodes = [], clientKey = null } = req.body ?? {};

    // A client naming a STAGE rather than an action is refused by name, so the
    // refusal is unambiguous in a log rather than looking like a typo.
    if (req.body?.stage !== undefined || req.body?.status !== undefined) {
      return sendDomainError(res, {
        error: 'LIFECYCLE_STAGE_NOT_SETTABLE',
        message: 'The recruitment stage is not settable directly. Name a recruitment action instead.',
        actions: LIFECYCLE_ACTION_NAMES,
      }, 'lifecycle');
    }
    if (typeof action !== 'string' || !LIFECYCLE_ACTIONS[action]) {
      return sendDomainError(res, {
        error: 'LIFECYCLE_ACTION_UNKNOWN',
        message: 'Unknown recruitment action.',
        actions: LIFECYCLE_ACTION_NAMES,
      }, 'lifecycle');
    }

    // The LIFECYCLE taxonomy, not the decision taxonomy. The two describe
    // different things and share no code; validating a transition against the
    // decision vocabulary would write a judgement about a player into a record
    // of what happened to a case.
    const reasons = validateLifecycleReasons(reasonCodes);
    if (!reasons.ok) return sendDomainError(res, reasons, 'lifecycle');

    const role = roomRole({ room, user: req.orgUser, isLead: isLead(req.orgUser) });

    // Idempotent replay: same org, same case, same action, same client key.
    //
    // Permission is checked FIRST. A replay is still an action, and answering
    // 200 to someone whose role could never have performed it tells them their
    // request succeeded — a wrong answer, not merely a generous one. Full
    // validation cannot stand in for this: the case has already moved, so the
    // transition is no longer legal and every replay would be refused.
    const prior = idempotentHit(room, action, clientKey);
    if (prior && !actionPermittedForRole(action, role)) {
      return sendDomainError(res, {
        error: 'LIFECYCLE_NOT_PERMITTED',
        message: 'Your role cannot take this recruitment action.',
      }, 'lifecycle');
    }
    if (prior) {
      return res.json({
        idempotent: true,
        from: prior.detail?.from ?? null,
        to: prior.detail?.to ?? null,
        ...revMeta(room.room),
      });
    }

    const verdict = canTransitionRecruitmentCase(room, action, {
      role,
      evidence: evidenceProvider(),
      reasonCodes: reasons.codes,
    });
    // The bands — 400 fix your request, 403 not yours, 409 the case is not
    // where you thought, 422 the evidence is not there, 500 ours — and the
    // reasoning behind each, live in `errors.mjs` next to the table.
    if (!verdict.ok) return sendDomainError(res, verdict, 'lifecycle');

    // Concurrency AFTER validation, so a stale rev on an impossible action
    // reports the impossibility rather than sending the caller to reload and
    // try the same impossible thing again.
    if (!guardRev(req, res, room.room, { errorCode: 'ROOM_VERSION_CONFLICT', current: { status: room.room.status } })) return undefined;

    // The action identity is recorded on the history entry the transition
    // writes, so a replay can find it. The entry is the one analytics reads;
    // the keys are part of its detail, not a second entry.
    const { from, to, room: fresh } = ctx.applyLifecycleTransition({
      req, room, to: verdict.to, reasonCodes: reasons.codes, trigger: `lifecycle:${action}`,
      statusDetail: { lifecycleAction: action, clientKey, policyVersion: RECRUITMENT_LIFECYCLE_POLICY_VERSION },
    });

    return res.json({ ok: true, action, from, to, ...revMeta(fresh.room) });
  });

  // ------------------------------------------------- vocabulary (read-only)
  orgRouter.get('/recruitment/lifecycle', (req, res) => {
    res.json({
      policyVersion: RECRUITMENT_LIFECYCLE_POLICY_VERSION,
      actions: LIFECYCLE_ACTION_NAMES.map((a) => ({
        action: a,
        to: LIFECYCLE_ACTIONS[a].to,
        roles: LIFECYCLE_ACTIONS[a].roles,
        reasonCodesRequired: !!LIFECYCLE_ACTIONS[a].reasonCodesRequired,
      })),
      // Published, because a client that must supply a reason code needs to be
      // able to discover which ones exist.
      reasonCodes: LIFECYCLE_REASON_CODES,
    });
  });

  // ------------------------------------------------------------- Contact
  // The Contact workflow registers on the same context: the same concealing
  // room lookup, the same single status writer, the same evidence provider.
  registerContact(ctx);

  // --------------------------------------------------------------- Trial
  // The Trial workflow registers on the same context: the same concealing
  // room lookup, the same single status writer, the same evidence provider
  // (which answers trial_invited / trial_confirmed / trial_completed),
  // and the same single request writer for the invitation.
  registerTrial(ctx);

  // ------------------------------------------------------------ Decision
  // The formal decision registers on the same context: the same concealing
  // room lookup, the same single status writer, the same evidence provider
  // (which answers decision_progress), the same decision memory the rooms own.
  registerDecision(ctx);

  return ctx;
}

