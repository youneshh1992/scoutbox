/**
 * M23 P5.6E — the cross-app integration SEAM: the one database-bound layer that
 * resolves the facts `m27/integration.mjs` decides on.
 *
 * `integration.mjs` is pure and knows no records. This file is the opposite: it
 * reads the canonical stores through their OWN gates — `findPlayer`, `isAdult`,
 * `isBlocked`, `orgCanSee`, M24's `profileOf`, M25's policy verdict — assembles
 * the facts, and hands them to `agentSurfaceDecision`. No app resolves those
 * facts for itself, so "can this agent see this?" has exactly one answer
 * everywhere (§47).
 *
 * What this module deliberately does NOT do:
 *
 *   - it declares no store. Every fact it reads is already somebody's truth;
 *     the client's disclosure choices live on the representation agreement that
 *     they are choices ABOUT (§103: strong preference, no new foundational
 *     stores). Schema stays at 2307.
 *   - it opens no second Inbox, no second Trial workflow, no second transaction
 *     workflow and no Offer lane. The agent-facing routes here are READS of
 *     records the canonical systems own.
 *   - it never turns a legacy M13 F10 row into authority. The basis comes from
 *     `agentClientBasis`, which is `agreementGrantsAccess`
 *     (M23_P56E_REPRESENTATION_SEAM_AUDIT.md §1).
 *
 * The seam is handed to M23 through a holder object created before M23 is
 * registered, because M23 is registered first. Until this module fills that
 * holder, every integration question answers "no" — a suite that boots M23
 * alone routes to the player and to nobody else.
 */

import { effectiveAgreementStatus, agreementGrantsAccess, verificationGap } from '../m24/shared.mjs';
import { MINOR_PATHWAY_PRODUCTION_ENABLED } from '../m25/policy.mjs';
import { scheduleView as trialScheduleView, deriveWorkflowState, TRIAL_WORKFLOW_LABELS, isLegacyTrial } from '../m23/trial.mjs';
import {
  SURFACES, SURFACE_NAMES, SURFACE_DISCLOSURE, POLICY_ACTION_FOR_SURFACE,
  DISCLOSURE_KEYS, DISCLOSURE_DEFAULT, CONTACT_ROUTING_MODES, RULE_ORDER, DENY_CODES,
  agentClientBasis, agentSurfaceDecision, normaliseDisclosure, contactRouting, contactTargetSnapshot,
  clubAgentPresence, surfaceIsRegulated,
} from './integration.mjs';

export function registerIntegration(ctx) {
  const {
    db, orgRouter, findPlayer, isAdult, isBlocked, orgCanSee, agent, compliance,
  } = ctx;

  const now = () => Date.now();
  const agreementsFor = (clientId) => (db.representationAgreements ?? []).filter((a) => a && a.clientId === clientId);
  const agreementById = (id) => (db.representationAgreements ?? []).find((a) => a && a.id === id) ?? null;

  // ---------------------------------------------------------------- basis

  const basisFor = ({ agentUserId, clientId, at = now() }) =>
    agentClientBasis({ agreements: agreementsFor(clientId), agentUserId, clientId, now: at });

  /**
   * Every agent who currently represents this client. A row that names no
   * individual (a legacy mirror) can never appear here: the predicate is asked
   * about the agent the row itself names, so a null agent fails its own test.
   */
  function activeAgentsFor(clientId, at = now()) {
    const out = [];
    for (const a of agreementsFor(clientId)) {
      if (!agreementGrantsAccess(a, a.agentUserId, at)) continue;
      out.push(a);
    }
    return out;
  }

  /**
   * The ONE agent a third party (a club) may be routed to, when there is exactly
   * one. Two active agents and nothing to choose between them is ambiguity, and
   * ambiguity fails closed: ScoutBox does not pick a player's representative for
   * them, and guessing would give one agent an approach the other never saw.
   */
  function soleActiveAgentFor(clientId, at = now()) {
    const all = activeAgentsFor(clientId, at);
    if (all.length === 1) return { agreement: all[0], ambiguous: false };
    return { agreement: null, ambiguous: all.length > 1 };
  }

  // ---------------------------------------------------------------- facts

  /** The agent's required facets are VERIFIED for the agreement's jurisdiction, now. */
  function licenceCurrentFor(agentUserId, jurisdiction, at = now()) {
    const p = agent?.profileOf ? agent.profileOf(agentUserId) : null;
    if (!p) return false;
    return !verificationGap(p, jurisdiction, at);
  }

  /**
   * The compliance layer's CURRENT answer for a regulated surface, through the
   * one narrow seam P5.6C exposes. No seam registered → `null`, which the
   * decision reads as "not evaluated", which is not clear.
   */
  function complianceClearFor(surface, agentUserId, jurisdiction) {
    const action = POLICY_ACTION_FOR_SURFACE[surface] ?? null;
    if (!action || !compliance?.clearFor) return null;
    const v = compliance.clearFor({ agentUserId, jurisdiction, action });
    return typeof v?.clear === 'boolean' ? v.clear : null;
  }

  /**
   * An explicit, separate player share for a surface that needs one (§11, §74).
   *
   * There is NO writer for an agent-directed Passport or evidence share in this
   * build: `db.passportShares` holds link tokens a person opens, not a standing
   * grant to a named agent, and a link a player sent their agent is the player
   * handing over a URL, not ScoutBox granting the agent a projection. So this
   * answers false, `passport_shared` and `evidence_shared` refuse with
   * SHARE_REQUIRED, and the surfaces stay declared rather than deleted — the
   * question gets asked and answered, which is the honest state of the build.
   */
  const sharedFor = () => false;

  /**
   * THE decision, with every fact resolved from a canonical source.
   *
   * `viewerOrgId` is the third party whose screen or action this is (a club).
   * Its block against the player counts too: a club that a player blocked does
   * not reach them through their agent.
   */
  function decide({ surface, clientId, agentUserId, viewerOrgId = null, at = now() }) {
    const basis = basisFor({ agentUserId, clientId, at });
    const agreement = basis.ok ? agreementById(basis.agreementId) : null;
    const player = findPlayer(clientId);
    const subjectPresent = !!player && !player.deletedAt && !player.removedAt && !agreement?.subjectRemovedAt;
    const jurisdiction = agreement?.jurisdiction ?? null;
    return agentSurfaceDecision({
      surface,
      basis,
      subjectPresent,
      isAdult: !!player && isAdult(player),
      // The encoded minor pathway is production-disabled in every jurisdiction
      // this build knows. Read from the policy layer rather than hard-coded
      // false, so enabling one is a policy change and not an edit here.
      minorPathwayOpen: jurisdiction ? MINOR_PATHWAY_PRODUCTION_ENABLED[jurisdiction] === true : false,
      blocked: !!player && (
        (basis.agencyOrgId ? isBlocked(player.id, basis.agencyOrgId) : false)
        || (viewerOrgId ? isBlocked(player.id, viewerOrgId) : false)
      ),
      disclosure: SURFACE_DISCLOSURE[surface] ? normaliseDisclosure(agreement?.disclosure)[SURFACE_DISCLOSURE[surface]] : null,
      shared: sharedFor(),
      licenceCurrent: licenceCurrentFor(agentUserId, jurisdiction, at),
      complianceClear: surfaceIsRegulated(surface) ? complianceClearFor(surface, agentUserId, jurisdiction) : null,
    });
  }

  // ------------------------------------------------------- contact routing

  /**
   * §21–§23. Who a club's contact may validly reach right now.
   *
   * The club never names the agent — it asks for a MODE. This resolves the
   * player's own representative, decides `contact_participation` for that agent,
   * and returns the routing. Called at compose time for the preview AND again at
   * send time, so authority is re-derived rather than remembered (§23).
   */
  function contactRoute({ recipient, clientId, viewerOrgId, requestedMode = 'player_only', at = now() }) {
    if (!recipient) return { ok: false, error: 'CONTACT_RECIPIENT_UNAVAILABLE' };
    if (requestedMode === 'player_only' || recipient.minor === true) {
      return contactRouting({ recipient, agentDecision: null, requestedMode: 'player_only' });
    }
    const { agreement, ambiguous } = soleActiveAgentFor(clientId, at);
    if (!agreement) {
      return contactRouting({
        recipient,
        agentDecision: { allowed: false, code: ambiguous ? 'REPRESENTATION_AMBIGUOUS' : 'NO_REPRESENTATION' },
        requestedMode,
      });
    }
    const decision = decide({ surface: 'contact_participation', clientId, agentUserId: agreement.agentUserId, viewerOrgId, at });
    return contactRouting({ recipient, agentDecision: decision, requestedMode });
  }

  // ------------------------------------------------------- club presence

  /**
   * §14/§63. The Club-facing "represented by" projection, answered from the
   * PLAYER's own disclosure choice. A club does not learn who represents a
   * player because the player exists; it learns because the player said so.
   */
  function clubPresenceFor({ player, viewerOrgId, at = now() }) {
    if (!player) return null;
    const { agreement } = soleActiveAgentFor(player.id, at);
    if (!agreement) return null;
    const decision = decide({ surface: 'club_agent_presence', clientId: player.id, agentUserId: agreement.agentUserId, viewerOrgId, at });
    if (decision.allowed !== true) return null;
    const profile = agent?.profileOf ? agent.profileOf(agreement.agentUserId) : null;
    const user = (db.users ?? []).find((u) => u && u.id === agreement.agentUserId) ?? null;
    const org = (db.orgs ?? []).find((o) => o && o.id === agreement.agencyOrgId) ?? null;
    return clubAgentPresence({
      decision,
      agent: { displayName: profile?.displayName ?? user?.name ?? null },
      agency: { id: org?.id ?? null, name: org?.name ?? null },
      facets: compliance?.facetStatesFor ? compliance.facetStatesFor(agreement.agentUserId) : null,
    });
  }

  // ------------------------------------------------- agent-facing reads

  /**
   * The contacts a club routed to THIS agent (§24). Reading is gated on the
   * live basis, and the items are exactly those whose recorded routing snapshot
   * names this agent — so revoking `contactRouting` stops new contacts arriving
   * without erasing the ones the agent legitimately already received (§22:
   * history is not rewritten).
   *
   * Thread isolation: no `caseId`, no case status, no club-private note, no
   * other player, no recruitment ranking. The club's own recruitment process is
   * not on the other side of this door.
   */
  orgRouter.get('/agent/clients/:id/contacts', (req, res) => {
    if (!agent.resolveMembership(req, res)) return;
    const found = agent.findOwnAgreement(req, res, req.params.id);
    if (!found) return;
    if (found.summaryOnly) return res.status(403).json({ error: 'AGENT_ACTION_NOT_PERMITTED', message: 'A summary row does not open a client\'s contacts.' });
    const a = found;
    const decision = decide({ surface: 'client_private', clientId: a.clientId, agentUserId: req.orgUser.id });
    if (decision.allowed !== true) {
      return res.status(403).json({ error: decision.code, rule: decision.rule, message: 'This client\'s record is not open to you right now.' });
    }
    const items = [];
    for (const c of db.recruitmentContacts ?? []) {
      if (!c || c.playerId !== a.clientId) continue;
      const snap = c.routingSnapshot ?? null;
      if (snap?.agent?.agentUserId !== req.orgUser.id) continue;
      const org = (db.orgs ?? []).find((o) => o && o.id === c.orgId) ?? null;
      items.push({
        id: c.id,
        club: { id: c.orgId, name: org?.name ?? null },
        status: c.status,
        channel: c.channel,
        subject: c.subject ?? null,
        // The club addressed this message to the agent as well as to the
        // player, which is what "routed" means. Nothing the club wrote for
        // itself is here.
        body: c.body ?? null,
        routedAt: snap.at,
        routedMode: snap.mode,
        deliveredAt: c.deliveredAt ?? null,
        respondedAt: c.respondedAt ?? null,
        // The client's own answer, because it answered a message the agent was
        // a party to. The client's free-text reply is theirs and stays out.
        responseKind: c.response?.kind ?? null,
      });
    }
    items.sort((x, y) => (y.routedAt - x.routedAt) || String(y.id).localeCompare(String(x.id)));
    res.json({
      items,
      clientId: a.clientId,
      note: 'Contacts a club routed to you as well as to your client. The club\'s own recruitment case, its internal notes and its assessment of your client are not here and never will be. Answering is your client\'s act, not yours.',
    });
  });

  /**
   * §26–§29. That a Trial exists, and its scheduling. Never its assessment,
   * never its report, never a Box Cam payload, never the exact venue address or
   * the club's joining instructions — those were held back from the invitation
   * until the FAMILY accepted (P4B D-23) and they remain the family's.
   *
   * There is no coordination write here, and no route in this build through
   * which an agent confirms, reschedules, cancels or attends a Trial. The mandate
   * forbids a second Trial workflow, and confirming a schedule for the player
   * would be exactly that.
   */
  orgRouter.get('/agent/clients/:id/trials', (req, res) => {
    if (!agent.resolveMembership(req, res)) return;
    const found = agent.findOwnAgreement(req, res, req.params.id);
    if (!found) return;
    if (found.summaryOnly) return res.status(403).json({ error: 'AGENT_ACTION_NOT_PERMITTED', message: 'A summary row does not open a client\'s trials.' });
    const a = found;
    const decision = decide({ surface: 'trial_projection', clientId: a.clientId, agentUserId: req.orgUser.id });
    if (decision.allowed !== true) {
      return res.status(403).json({
        error: decision.code, rule: decision.rule,
        message: decision.code === 'DISCLOSURE_WITHHELD'
          ? 'Your client has not chosen to share their trial schedule with you. That choice is theirs and they can change it at any time in My Agent.'
          : 'This client\'s trials are not open to you right now.',
      });
    }
    const player = findPlayer(a.clientId);
    const items = [];
    for (const t of db.trials ?? []) {
      if (!t || t.playerId !== a.clientId || t.subjectRemovedAt) continue;
      const org = (db.orgs ?? []).find((o) => o && o.id === t.orgId) ?? null;
      const state = deriveWorkflowState(t);
      items.push({
        id: t.id,
        club: { id: t.orgId, name: t.orgName ?? org?.name ?? null },
        workflowState: state,
        workflowLabel: TRIAL_WORKFLOW_LABELS[state] ?? state,
        legacy: isLegacyTrial(t),
        acceptedAt: t.acceptedAt ?? null,
        // The viewer is 'agent': not the club, not the accepted family. The
        // address, the instructions and the evidence list are absent, not
        // redacted — an absent field cannot leak.
        schedule: trialScheduleView(t, 'agent'),
        awaitingClientConfirmation: !!t.schedule && !t.schedule.confirmedAt,
        completion: t.completion ? { state: t.completion.state, at: t.completion.at } : null,
        // WHETHER a report obligation exists, never what it says.
        reportObligation: t.status === 'awaiting_report' ? 'outstanding' : t.status === 'reported' ? 'filed' : null,
      });
    }
    items.sort((x, y) => (y.acceptedAt ?? 0) - (x.acceptedAt ?? 0) || String(y.id).localeCompare(String(x.id)));
    res.json({
      items,
      clientId: a.clientId,
      clientName: player && orgCanSee(req.org, player) ? player.name : null,
      note: 'Your client\'s trials as the club and your client have recorded them. The club\'s assessment, its trial report and any Box Cam footage are not here. Confirming, rescheduling and attending are your client\'s acts and the club\'s; ScoutBox does not let you do them on your client\'s behalf.',
      honest: 'Nothing here is an offer, a negotiation or a fee. A trial is an assessment opportunity.',
    });
  });

  // ------------------------------------------------------------- the seam

  const seam = {
    // decisions
    decide,
    basisFor,
    activeAgentsFor,
    soleActiveAgentFor,
    // routing
    contactRoute,
    contactTargetSnapshot,
    routingModes: CONTACT_ROUTING_MODES,
    // projections
    clubPresenceFor,
    // vocabulary, for the surfaces and their tests
    surfaces: SURFACE_NAMES,
    surfaceSpec: SURFACES,
    ruleOrder: RULE_ORDER,
    denyCodes: DENY_CODES,
    disclosureKeys: DISCLOSURE_KEYS,
    disclosureDefault: DISCLOSURE_DEFAULT,
  };

  return { seam };
}
