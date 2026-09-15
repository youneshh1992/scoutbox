/**
 * M23 — recruitment lifecycle routes.
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
  canTransitionRecruitmentCase, NULL_EVIDENCE_PROVIDER,
} from './lifecycle.mjs';
import { buildRecruitmentJourney } from './journey.mjs';
import { roomRole, validateReasonCodes } from '../m17/shared.mjs';
import { guardRev, revMeta } from '../m181/concurrency.mjs';
import { buildShared } from '../m12/shared.mjs';

export function registerM23(rawCtx) {
  // The established seam: isLead, orgCanSee, audit and paginate come from one
  // place rather than being re-derived per milestone.
  const ctx = { ...rawCtx, ...buildShared(rawCtx) };
  const { db, orgRouter, persistNow, isLead } = ctx;

  const now = () => new Date().toISOString();

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

  /** Evidence provider. P2 ships the null provider: no phase supplies evidence yet. */
  const evidenceProvider = () => ctx.recruitmentEvidenceProvider ?? NULL_EVIDENCE_PROVIDER;

  // ------------------------------------------------------------- journey read
  orgRouter.get('/rooms/:id/journey', (req, res) => {
    const room = ctx.findRoomForRequest(req, res);
    if (!room) return undefined;

    const out = buildRecruitmentJourney(db, room.id, {
      kind: req.org.level === 'grassroots' ? 'grassroots_staff' : 'org_staff',
      orgId: req.org.id,
      userId: req.orgUser.id,
      role: roomRole({ room, user: req.orgUser, isLead: isLead(req) }),
    }, { evidence: evidenceProvider(), historyLimit: req.query.limit, historyCursor: req.query.cursor });

    if (!out.ok) {
      // A missing store is infrastructure, not "no history" — 500, loudly.
      const code = out.error === 'JOURNEY_STORE_MISSING' ? 500 : 404;
      return res.status(code).json(out);
    }
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
      return res.status(400).json({
        error: 'LIFECYCLE_STAGE_NOT_SETTABLE',
        message: 'The recruitment stage is not settable directly. Name a recruitment action instead.',
        actions: LIFECYCLE_ACTION_NAMES,
      });
    }
    if (typeof action !== 'string' || !LIFECYCLE_ACTIONS[action]) {
      return res.status(400).json({
        error: 'LIFECYCLE_ACTION_UNKNOWN',
        message: 'Unknown recruitment action.',
        actions: LIFECYCLE_ACTION_NAMES,
      });
    }

    const reasons = validateReasonCodes(reasonCodes);
    if (!reasons.ok) return res.status(400).json(reasons);

    const role = roomRole({ room, user: req.orgUser, isLead: isLead(req) });

    // Idempotent replay: same org, same case, same action, same client key.
    const prior = idempotentHit(room, action, clientKey);
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
    if (!verdict.ok) {
      const code = verdict.error === 'LIFECYCLE_NOT_PERMITTED' ? 403
        : verdict.error === 'LIFECYCLE_TRANSITION_INVALID' || verdict.error === 'LIFECYCLE_NO_CHANGE' ? 409
          : verdict.error === 'LIFECYCLE_EVIDENCE_REQUIRED' ? 422
            : 400;
      return res.status(code).json(verdict);
    }

    // Concurrency AFTER validation, so a stale rev on an impossible action
    // reports the impossibility rather than sending the caller to reload and
    // try the same impossible thing again.
    if (!guardRev(req, res, room.room, { errorCode: 'ROOM_VERSION_CONFLICT', current: { status: room.room.status } })) return undefined;

    const { from, to } = ctx.applyLifecycleTransition({
      req, room, to: verdict.to, reasonCodes: reasons.codes, trigger: `lifecycle:${action}`,
    });

    // Record the action identity on the history entry the transition just
    // wrote, so a replay can find it. The entry is the one M20 already reads;
    // this adds keys to its detail, it does not add a second entry.
    const last = room.history[room.history.length - 1];
    if (last?.action === 'room_status_changed') {
      last.detail = { ...last.detail, lifecycleAction: action, clientKey, policyVersion: RECRUITMENT_LIFECYCLE_POLICY_VERSION };
    }

    persistNow();
    return res.json({ ok: true, action, from, to, ...revMeta(room.room) });
  });

  // ------------------------------------------------- vocabulary (read-only)
  orgRouter.get('/recruitment/lifecycle', (req, res) => {
    res.json({
      policyVersion: RECRUITMENT_LIFECYCLE_POLICY_VERSION,
      actions: LIFECYCLE_ACTION_NAMES.map((a) => ({ action: a, to: LIFECYCLE_ACTIONS[a].to, roles: LIFECYCLE_ACTIONS[a].roles })),
    });
  });
}

export function migrateM23() {
  // P2 introduces no store. The lifecycle lives on records that already exist,
  // and the journey is computed rather than kept. `db.recruitmentOffers`
  // arrives with the phase that actually writes offers — creating it now would
  // be a container for something no code can produce.
}
