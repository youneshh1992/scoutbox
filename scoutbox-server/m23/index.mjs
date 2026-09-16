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
  canTransitionRecruitmentCase, actionPermittedForRole, NULL_EVIDENCE_PROVIDER,
  validateLifecycleReasons, LIFECYCLE_REASON_CODES,
} from './lifecycle.mjs';
import { buildRecruitmentJourney } from './journey.mjs';
import { sendDomainError } from './errors.mjs';
import { registerContact } from './contactRoutes.mjs';
import { registerTrial } from './trialRoutes.mjs';
import { roomRole } from '../m17/shared.mjs';
import { guardRev, revMeta } from '../m181/concurrency.mjs';
import { buildShared } from '../m12/shared.mjs';

export function registerM23(rawCtx) {
  // The established seam: isLead, orgCanSee, audit and paginate come from one
  // place rather than being re-derived per milestone.
  const ctx = { ...rawCtx, ...buildShared(rawCtx) };
  const { db, orgRouter, persistNow, isLead } = ctx;

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

  // Domain errors answer through `sendDomainError` in errors.mjs — the ONE
  // mapping table, shared with the P3 Contact routes.

  // ------------------------------------------------------------- journey read
  orgRouter.get('/rooms/:id/journey', (req, res) => {
    const room = ctx.findRoomForRequest(req, res);
    if (!room) return undefined;

    const out = buildRecruitmentJourney(db, room.id, {
      kind: req.org.level === 'grassroots' ? 'grassroots_staff' : 'org_staff',
      orgId: req.org.id,
      userId: req.orgUser.id,
      role: roomRole({ room, user: req.orgUser, isLead: isLead(req.orgUser) }),
    }, { evidence: evidenceProvider(), historyLimit: req.query.limit, historyCursor: req.query.cursor });

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

    // The LIFECYCLE taxonomy, not M17's decision taxonomy. The two describe
    // different things and share no code; validating a transition against the
    // decision vocabulary wrote a judgement about a player into a record of
    // what happened to a case.
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
      actions: LIFECYCLE_ACTION_NAMES.map((a) => ({
        action: a,
        to: LIFECYCLE_ACTIONS[a].to,
        roles: LIFECYCLE_ACTIONS[a].roles,
        reasonCodesRequired: !!LIFECYCLE_ACTIONS[a].reasonCodesRequired,
      })),
      // Published, because a client that must supply a reason code needs to be
      // able to discover which ones exist. They were unreachable before: the
      // route validated against a different taxonomy entirely.
      reasonCodes: LIFECYCLE_REASON_CODES,
    });
  });

  // ------------------------------------------------------- P3 — Contact
  // The Contact workflow registers on the same context: the same concealing
  // room lookup, the same single status writer, the same evidence provider.
  registerContact(ctx);

  // ------------------------------------------------------- P4B — Trial
  // The Trial workflow registers on the same context: the same concealing
  // room lookup, the same single status writer, the same evidence provider
  // (which now answers trial_invited / trial_confirmed / trial_completed),
  // and the same single request writer for the invitation.
  registerTrial(ctx);

  return ctx;
}

export function migrateM23() {
  // P2 introduced no store. P3's `db.recruitmentContacts` is created by the
  // migration registry (m182/migrations.mjs, `m230_004_recruitment_contacts`)
  // so it survives an arbitrary restore — not here, where it would exist only
  // after this module registered. `db.recruitmentOffers` still arrives with
  // the phase that actually writes offers.
}
