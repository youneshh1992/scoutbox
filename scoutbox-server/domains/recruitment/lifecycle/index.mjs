/**
 * Recruitment lifecycle routes. There is no stage setter: the client names an
 * action and the server decides whether it is possible, permitted and
 * supported by evidence.
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
import { requestClock } from '../../platform/clock.mjs';
import { buildRouteHelpers } from '../../platform/routeHelpers.mjs';

export function registerLifecycle(rawCtx) {
  const ctx = { ...rawCtx, ...buildRouteHelpers(rawCtx) };
  const { recruitmentReads, scoutingReads, orgRouter, isLead } = ctx;
  if (!ctx.safetyReads?.blocks) throw new TypeError('the lifecycle routes need safetyReads (the safety repository\'s queries)');
  const journeyReads = { ...recruitmentReads, ...scoutingReads, blocks: ctx.safetyReads.blocks, player: (id) => ctx.byId.player(id) };
  if (!recruitmentReads?.contacts || !recruitmentReads?.offers) throw new TypeError('registerLifecycle needs recruitmentReads (contacts, offers) from the data layer');

  /**
   * Keyed on the request identity (org, case, action, client key), not the
   * stage pair: `closed → reopened → closed` is three legitimate transitions and
   * the third must not be swallowed. Without a client key there is no idempotency.
   */
  const idempotentHit = (kase, action, clientKey) => {
    if (!clientKey) return null;
    return (kase.history ?? []).find(
      (h) => h?.action === 'room_status_changed' && h.detail?.clientKey === clientKey && h.detail?.lifecycleAction === action,
    ) ?? null;
  };

  /** Without a composed provider, the null provider refuses every evidence-bearing move. */
  const evidenceProvider = () => ctx.recruitmentEvidenceProvider ?? NULL_EVIDENCE_PROVIDER;
  const nowOf = requestClock();

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

    // Refused by name, so it is unambiguous in a log rather than looking like a typo.
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

    // The lifecycle taxonomy, not the decision taxonomy: a judgement about a
    // player must not become the record of what happened to a case.
    const reasons = validateLifecycleReasons(reasonCodes);
    if (!reasons.ok) return sendDomainError(res, reasons, 'lifecycle');

    const role = roomRole({ room, user: req.orgUser, isLead: isLead(req.orgUser) });

    // Permission is checked before an idempotent replay answers: a replay is
    // still an action. Full validation cannot stand in, because the case has
    // already moved and every replay would be refused.
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
    if (!verdict.ok) return sendDomainError(res, verdict, 'lifecycle');

    // Concurrency after validation, so a stale rev on an impossible action
    // reports the impossibility rather than inviting a reload and retry.
    if (!guardRev(req, res, room.room, { errorCode: 'ROOM_VERSION_CONFLICT', current: { status: room.room.status } })) return undefined;

    // The action identity goes on the transition's history entry (the one
    // analytics reads), so a replay can find it.
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
      reasonCodes: LIFECYCLE_REASON_CODES,
    });
  });

  // ------------------------------------------------------------- Contact
  registerContact(ctx);

  // --------------------------------------------------------------- Trial
  registerTrial(ctx);

  // ------------------------------------------------------------ Decision
  registerDecision(ctx);

  return ctx;
}

