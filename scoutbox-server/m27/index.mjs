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

import {
  effectiveAgreementStatus, agreementGrantsAccess, verificationGap,
  shareView, MAX_OPPORTUNITY_SHARES,
} from '../m24/shared.mjs';
import { MINOR_PATHWAY_PRODUCTION_ENABLED } from '../m25/policy.mjs';
import { opportunityBoardFor } from '../m12/journeys.mjs';
import { plainShared, normaliseClientKey, payloadFingerprint } from '../m23/contact.mjs';
import { chainHead, isFormal } from '../m23/decision.mjs';
import { roomRole, roomCan } from '../m17/shared.mjs';
import { TERMINAL_STATUSES } from '../m26/transaction.mjs';
import { scheduleView as trialScheduleView, deriveWorkflowState, TRIAL_WORKFLOW_LABELS, isLegacyTrial } from '../m23/trial.mjs';
import {
  SURFACES, SURFACE_NAMES, SURFACE_DISCLOSURE, POLICY_ACTION_FOR_SURFACE,
  DISCLOSURE_KEYS, DISCLOSURE_DEFAULT, CONTACT_ROUTING_MODES, RULE_ORDER, DENY_CODES,
  agentClientBasis, agentSurfaceDecision, normaliseDisclosure, contactRouting, contactTargetSnapshot,
  clubAgentPresence, surfaceIsRegulated,
  HANDOFF_STATUSES, HANDOFF_BLOCKERS, HANDOFF_TTL_MS, effectiveHandoffStatus,
  handoffBlockers, duplicateTransactionOf,
} from './integration.mjs';

export function registerIntegration(ctx) {
  const {
    db, orgRouter, playerRouter, nextId, persistNow, notify, broadcast,
    findPlayer, isAdult, isBlocked, orgCanSee, checkEligibility, distanceBand,
    agent, compliance,
  } = ctx;

  const now = () => Date.now();
  const clientKeyOf = (req, res) => {
    const k = normaliseClientKey(req.body?.clientKey);
    if (!k.ok) { res.status(400).json({ error: 'AGENT_CLIENT_KEY_INVALID', message: k.message }); return undefined; }
    return k.key;
  };
  const agentDisplayName = (userId) => agent?.profileOf?.(userId)?.displayName
    ?? (db.users ?? []).find((u) => u && u.id === userId)?.name ?? null;

  /**
   * The case, through M17's own concealing lookup and M17's own role ranking —
   * not a second copy of either. `need` is 'view' or 'write'; a handoff is a
   * decision about the club's external conduct, so it needs the same rank the
   * formal decision does.
   */
  function roomForHandoff(req, res, need) {
    const kase = ctx.findRoomForRequest(req, res);
    if (!kase) return null;
    const role = roomRole({ room: kase, user: req.orgUser, isLead: ctx.isLead(req.orgUser) });
    if (!roomCan(role, 'decision_view')) {
      res.status(403).json({ error: 'HANDOFF_NOT_PERMITTED', message: 'Your role cannot read this case\'s handoff.' });
      return null;
    }
    const canWrite = roomCan(role, 'decision_finalize');
    if (need === 'write' && !canWrite) {
      res.status(403).json({ error: 'HANDOFF_NOT_PERMITTED', message: 'Only a recruitment lead can invite a transaction workspace.' });
      return null;
    }
    return { kase, role, canWrite };
  }
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
   * The three facet STATE WORDS for one jurisdiction. A per-association map is
   * the agent's own business: which jurisdictions they are registered in is a
   * fact about them that no player was asked to disclose, so only the agreement's
   * own jurisdiction is read, and a missing one is absent rather than guessed.
   */
  const flatFacets = (states, jurisdiction) => (states ? {
    fifa_licence: typeof states.fifa_licence === 'string' ? states.fifa_licence : null,
    national_registration: jurisdiction ? states.national_registration?.[jurisdiction] ?? null : null,
    domestic_authorisation: jurisdiction ? states.domestic_authorisation?.[jurisdiction] ?? null : null,
  } : null);

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
      // Flattened to the ONE jurisdiction this relationship names, so the badge
      // carries three state words and not a map of everywhere this agent works.
      facets: flatFacets(compliance?.facetStatesFor ? compliance.facetStatesFor(agreement.agentUserId) : null, agreement.jurisdiction),
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

  // --------------------------------------------- §17–§19 opportunity share

  /**
   * §18. The agent brings an opportunity to their client's attention.
   *
   * The opportunity must ALREADY be on the client's own board — the board is
   * rebuilt here through `opportunityBoardFor`, the same function the player's
   * own screen uses, under the same mutual-visibility and eligibility rules. An
   * agent therefore cannot surface something their client could not already
   * find, and a club's private recruitment case, its watchlist and its matching
   * weights have no path into this route at all (§17).
   *
   * `Do not auto-apply Player` (§18): this writes a share and a notification.
   * Applying stays the player's own act on the player's own route, and there is
   * no parameter here that could start one.
   */
  orgRouter.post('/agent/clients/:id/opportunities/:oppId/share', (req, res) => {
    if (!agent.resolveMembership(req, res)) return;
    if (!agent.requireCap(req, res, 'clients.opportunities.share')) return;
    const found = agent.findOwnAgreement(req, res, req.params.id);
    if (!found) return;
    if (found.summaryOnly) return res.status(403).json({ error: 'AGENT_ACTION_NOT_PERMITTED', message: 'A summary row does not permit sharing.' });
    const a = found;

    const key = clientKeyOf(req, res); if (key === undefined) return;
    const note = plainShared(req.body?.note, 300);
    if (note === null) return res.status(400).json({ error: 'AGENT_INPUT_INVALID', field: 'note', message: 'A note must be text.' });

    // Idempotency and the duplicate rule are the same question asked twice: the
    // same key replays, and the same opportunity is already shared.
    a.opportunityShares ??= [];
    if (key) {
      const hit = a.opportunityShares.find((s) => s && s.keys?.share?.key === key);
      if (hit) {
        if (hit.keys.share.fp === payloadFingerprint({ opportunityId: req.params.oppId, note })) {
          return res.json({ share: shareView(hit), idempotent: true });
        }
        return res.status(409).json({ error: 'AGENT_IDEMPOTENCY_CONFLICT', message: 'That key was used for a different share.' });
      }
    }

    const decision = decide({ surface: 'opportunity_share', clientId: a.clientId, agentUserId: req.orgUser.id });
    if (decision.allowed !== true) {
      return res.status(403).json({
        error: decision.code, rule: decision.rule,
        message: decision.code === 'SCOPE_INSUFFICIENT'
          ? 'Your agreement with this client does not cover employment or transfer work, which is what sharing an opportunity is.'
          : 'You cannot share an opportunity with this client right now.',
      });
    }
    const player = findPlayer(a.clientId);
    const board = opportunityBoardFor(db, player, { orgCanSee, checkEligibility, distanceBand });
    const opp = board.find((o) => o && o.id === req.params.oppId) ?? null;
    // A uniform 404: whether the opportunity does not exist, is closed, or is
    // simply not one this client is eligible for, the agent learns the same
    // thing. Anything else is an existence oracle over the whole board.
    if (!opp) return res.status(404).json({ error: 'OPPORTUNITY_NOT_AVAILABLE', message: 'That opportunity is not on this client\'s board.' });

    const already = a.opportunityShares.find((s) => s && s.opportunityId === opp.id && !s.withdrawnAt);
    if (already) return res.status(409).json({ error: 'OPPORTUNITY_ALREADY_SHARED', shareId: already.id, message: 'You have already shared this opportunity with this client.' });
    if (a.opportunityShares.length >= MAX_OPPORTUNITY_SHARES) {
      return res.status(409).json({ error: 'OPPORTUNITY_SHARE_LIMIT', message: `This relationship already holds ${MAX_OPPORTUNITY_SHARES} shares, which is the most one record keeps.` });
    }

    const at = now();
    const share = {
      id: nextId('aos'),
      opportunityId: opp.id, via: opp.via ?? null, title: opp.title ?? null,
      orgName: opp.orgName ?? null, deadline: opp.deadline ?? null,
      note: note || null,
      sharedAt: at, sharedBy: { kind: 'org', userId: req.orgUser.id, name: agentDisplayName(req.orgUser.id) },
      withdrawnAt: null,
      keys: key ? { share: { key, fp: payloadFingerprint({ opportunityId: opp.id, note }) } } : {},
      rev: 1, revAt: at,
    };
    a.opportunityShares.push(share);
    a.history ??= [];
    a.history.push({ id: nextId('aud'), at, action: 'opportunity_shared', by: { kind: 'org', userId: req.orgUser.id, name: req.orgUser.name }, detail: { shareId: share.id, via: share.via } });
    persistNow();
    broadcast('agent_opportunity_shared', { orgId: a.agencyOrgId, agreementId: a.id, agentUserId: req.orgUser.id });
    notify({ kind: 'player', id: a.clientId }, 'representation_opportunity',
      `${share.sharedBy.name ?? 'Your agent'} shared an opportunity with you${share.orgName ? ` at ${share.orgName}` : ''}. Applying is your own decision — nobody can apply on your behalf.`, share.id);
    res.status(201).json({
      share: shareView(share),
      note: 'Shared. Your client decides whether to apply, on their own screen, in their own name.',
    });
  });

  /** Withdraw a share. The record stays, marked — it happened. */
  orgRouter.post('/agent/clients/:id/opportunities/shares/:shareId/withdraw', (req, res) => {
    if (!agent.resolveMembership(req, res)) return;
    if (!agent.requireCap(req, res, 'clients.opportunities.share')) return;
    const found = agent.findOwnAgreement(req, res, req.params.id);
    if (!found || found.summaryOnly) { if (found?.summaryOnly) res.status(403).json({ error: 'AGENT_ACTION_NOT_PERMITTED' }); return; }
    const a = found;
    const share = (a.opportunityShares ?? []).find((s) => s && s.id === req.params.shareId);
    if (!share) return res.status(404).json({ error: 'OPPORTUNITY_SHARE_NOT_FOUND' });
    if (share.withdrawnAt) return res.json({ share: shareView(share), idempotent: true });
    // Withdrawing needs no live basis check: an agent whose relationship has
    // ended must still be able to take back something they put in front of a
    // client, and taking something away can never widen anyone's access.
    const at = now();
    share.withdrawnAt = at;
    share.rev = (share.rev ?? 1) + 1;
    share.revAt = at;
    a.history ??= [];
    a.history.push({ id: nextId('aud'), at, action: 'opportunity_share_withdrawn', by: { kind: 'org', userId: req.orgUser.id, name: req.orgUser.name }, detail: { shareId: share.id } });
    persistNow();
    res.json({ share: shareView(share) });
  });

  /** The agent's own list for one client. */
  orgRouter.get('/agent/clients/:id/opportunities/shares', (req, res) => {
    if (!agent.resolveMembership(req, res)) return;
    const found = agent.findOwnAgreement(req, res, req.params.id);
    if (!found) return;
    if (found.summaryOnly) return res.status(403).json({ error: 'AGENT_ACTION_NOT_PERMITTED' });
    // The same gate the other two client-scoped reads use. A share list is a list of
    // things said to a particular client, so it closes when the mandate does — the
    // agent's own history of having acted is not a standing window onto a person who
    // is no longer their client. `client_private` and not `opportunity_share`: this
    // is a read of the relationship, not the regulated act of making a suggestion.
    const decision = decide({ surface: 'client_private', clientId: found.clientId, agentUserId: req.orgUser.id });
    if (decision.allowed !== true) {
      return res.status(403).json({ error: decision.code, rule: decision.rule, message: 'This client\'s record is not open to you right now.' });
    }
    res.json({ items: (found.opportunityShares ?? []).map(shareView).sort((x, y) => y.sharedAt - x.sharedAt) });
  });

  /**
   * §19. The player's own view of what their agents have put in front of them.
   * Read from the agreements that are active NOW: a share made under a
   * relationship that has since ended stops appearing, because the suggestion
   * was part of that relationship. Nothing here applies for anybody.
   */
  playerRouter.get('/agent/shared-opportunities', (req, res) => {
    if (req.playerIsMinor) return res.json({ items: [], minor: true });
    const items = [];
    for (const a of activeAgentsFor(req.player.id)) {
      for (const s of a.opportunityShares ?? []) {
        if (!s || s.withdrawnAt) continue;
        items.push({ ...shareView(s), agreementId: a.id, agencyOrgId: a.agencyOrgId });
      }
    }
    items.sort((x, y) => y.sharedAt - x.sharedAt);
    res.json({
      items,
      note: 'Opportunities your agent brought to your attention. Each one is still yours to apply for, or not: your agent cannot apply for you and ScoutBox will not do it on their word.',
    });
  });

  // ------------------------------------ §32–§39 P5 decision → transaction

  /**
   * Whether a finalised formal decision to PROGRESS is the current head of this
   * case's decision chain. The one thing that crosses the boundary is this
   * boolean: not the reasons, not the note, not the evidence, not the author
   * (§32 "Do not expose the internal decision itself").
   */
  function hasFinalProgressDecision(kase) {
    const rows = (db.roomDecisions ?? []).filter((d) => d && d.roomId === kase.id && d.orgId === kase.orgId);
    // `chainHead` and `isFormal` are P5's own — an advisory recommendation is not
    // a formal decision, and a superseded row is not the head.
    const head = chainHead(rows);
    return !!head && isFormal(head) && head.state === 'final' && head.outcome === 'progress' && !head.supersededById;
  }

  const handoffOf = (kase) => kase.transactionHandoff ?? null;

  /** The live transaction, if any, that already covers this club's context. */
  function liveTransactionFor(kase) {
    return duplicateTransactionOf(db.agentTransactions ?? [], {
      clientId: kase.playerId,
      type: 'employment_contract',
      engagingOrgId: kase.orgId,
      releasingOrgId: null,
      terminalStatuses: TERMINAL_STATUSES,
      partiesOf: (t) => t.parties ?? [],
    });
  }

  /** Every fact `handoffBlockers` needs, resolved from canonical sources. */
  function handoffFacts(req, kase, { canWrite }) {
    const player = findPlayer(kase.playerId);
    const h = handoffOf(kase);
    const live = liveTransactionFor(kase);
    // "current compliance can be evaluated" (§34). Asked of the client's own
    // agent where there is one; where the player is unrepresented there is no
    // agent to evaluate and the question does not arise, so it is satisfied —
    // the transaction's own creation gate will ask it of whoever opens one.
    const { agreement } = soleActiveAgentFor(kase.playerId);
    const complianceEvaluable = agreement
      ? (compliance?.clearFor ? compliance.clearFor({ agentUserId: agreement.agentUserId, jurisdiction: agreement.jurisdiction, action: 'declare_representation' }).clear === true : false)
      : true;
    return {
      canWrite,
      hasFinalProgressDecision: hasFinalProgressDecision(kase),
      caseStatus: kase.room?.status ?? null,
      subjectPresent: !!player && !player.deletedAt && !player.removedAt && orgCanSee(req.org, player),
      isAdult: !!player && isAdult(player),
      minorPathwayOpen: false,
      blocked: isBlocked(kase.playerId, kase.orgId),
      existingHandoffStatus: effectiveHandoffStatus(h),
      liveTransactionId: live?.id ?? null,
      complianceEvaluable,
    };
  }

  /**
   * What the club may see of the handoff. Deliberately thin: the state, when,
   * who by (a name, because the club's own staff acted), and whether the client
   * is represented — never WHO represents them unless the player's own
   * `clubPresence` choice says so, and never the transaction's contents.
   */
  const handoffView = (h, kase) => (h ? {
    id: h.id,
    status: effectiveHandoffStatus(h),
    storedStatus: h.status,
    invitedAt: h.invitedAt ?? null,
    invitedByName: h.invitedBy?.name ?? null,
    acceptedAt: h.acceptedAt ?? null,
    withdrawnAt: h.withdrawnAt ?? null,
    transactionId: h.transactionId ?? null,
    representedAtInvitation: h.representedAtInvitation === true,
    caseId: kase.id,
    rev: h.rev ?? 1,
    honest: 'An invitation to open a transaction workspace. It is not an offer, it carries no terms and no fee, and it commits nobody to anything. The workspace itself is opened by a licensed agent, and every party confirms their own participation.',
  } : null);

  /**
   * §38. The readiness view. The club sees whether the entrypoint is available
   * and, if not, every reason — as codes, so the surface can word them and no
   * internal rationale rides along. "Visibility of button is not authorization":
   * the mutation below calls the very same function, so a club that forces the
   * request gets the same answer the screen showed.
   */
  orgRouter.get('/rooms/:id/transaction-handoff', (req, res) => {
    const got = roomForHandoff(req, res, 'view');
    if (!got) return;
    const { kase, canWrite } = got;
    const facts = handoffFacts(req, kase, { canWrite });
    const blockers = handoffBlockers(facts);
    const h = handoffOf(kase);
    res.json({
      handoff: handoffView(h, kase),
      available: blockers.length === 0,
      // A club that cannot write is told that, and nothing else about the case's
      // readiness — a viewer does not get a checklist of what a lead could do.
      blockers: canWrite ? blockers : ['HANDOFF_NOT_PERMITTED'],
      blockerVocabulary: HANDOFF_BLOCKERS,
      action: 'inviteToTransaction',
      note: 'Inviting a transaction is a separate, explicit decision. ScoutBox never creates one from a recruitment decision by itself, and this invitation is not an offer.',
    });
  });

  /** §32/§33. The explicit authorised club action. */
  orgRouter.post('/rooms/:id/transaction-handoff', (req, res) => {
    const got = roomForHandoff(req, res, 'write');
    if (!got) return;
    const { kase, canWrite } = got;
    const key = clientKeyOf(req, res); if (key === undefined) return;
    const existing = handoffOf(kase);
    if (existing && key && existing.keys?.invite?.key === key) {
      return res.json({ handoff: handoffView(existing, kase), idempotent: true });
    }
    const facts = handoffFacts(req, kase, { canWrite });
    const blockers = handoffBlockers(facts);
    if (blockers.length) {
      return res.status(blockers[0] === 'HANDOFF_NOT_PERMITTED' ? 403 : blockers.includes('HANDOFF_EXISTS') || blockers.includes('HANDOFF_TRANSACTION_EXISTS') ? 409 : 422).json({
        error: blockers[0], blockers,
        message: 'This case cannot be handed to a transaction workspace right now.',
      });
    }
    const { agreement } = soleActiveAgentFor(kase.playerId);
    const at = now();
    const h = {
      id: nextId('hof'), caseId: kase.id, orgId: kase.orgId, playerId: kase.playerId,
      status: 'invited', invitedAt: at, invitedBy: { kind: 'org', userId: req.orgUser.id, name: req.orgUser.name },
      acceptedAt: null, withdrawnAt: null, transactionId: null,
      // WHETHER the client is represented, resolved now. Not who: that is the
      // player's disclosure to make, and the handoff does not become a back door
      // to an agent's identity.
      representedAtInvitation: !!agreement,
      // The agency is recorded so the invitation can be delivered, and because
      // the transaction that answers it must come from this agency and no other.
      invitedAgencyOrgId: agreement?.agencyOrgId ?? null,
      invitedAgentUserId: agreement?.agentUserId ?? null,
      keys: key ? { invite: { key } } : {},
      rev: 1, revAt: at,
    };
    kase.transactionHandoff = h;
    kase.history ??= [];
    kase.history.push({ id: nextId('aud'), at, action: 'transaction_handoff_invited', by: h.invitedBy, detail: { handoffId: h.id, represented: h.representedAtInvitation } });
    persistNow();
    broadcast('transaction_handoff_invited', { orgId: kase.orgId, roomId: kase.id, handoffId: h.id });
    // The agent hears, because they are the one who can open the workspace. The
    // player hears too, because a club has moved from thinking to acting about
    // them and they should never learn that from their agent alone.
    if (agreement?.agentUserId) {
      notify({ kind: 'org_user', id: agreement.agentUserId }, 'representation_transaction',
        `${req.org.name} has invited a transaction workspace for one of your clients. Opening it is your action, and it commits nobody to anything.`, h.id);
    }
    notify({ kind: 'player', id: kase.playerId }, 'representation_transaction',
      `${req.org.name} has asked to open a transaction workspace about you. Nothing has been agreed and this is not an offer; you confirm your own participation if a workspace is opened.`, h.id);
    res.status(201).json({ handoff: handoffView(h, kase), note: 'Invited. A licensed agent opens the workspace, and every party confirms for themselves.' });
  });

  /** Withdraw the invitation. A club may always take back its own invitation. */
  orgRouter.post('/rooms/:id/transaction-handoff/withdraw', (req, res) => {
    const got = roomForHandoff(req, res, 'write');
    if (!got) return;
    const { kase } = got;
    const h = handoffOf(kase);
    if (!h) return res.status(404).json({ error: 'HANDOFF_NOT_FOUND' });
    if (h.status === 'withdrawn') return res.json({ handoff: handoffView(h, kase), idempotent: true });
    // An invitation that has already been taken up is history: withdrawing it
    // would not close the transaction, and pretending otherwise would be a lie
    // about what the club can still control.
    if (h.status === 'accepted') {
      return res.status(409).json({ error: 'HANDOFF_ALREADY_ACCEPTED', transactionId: h.transactionId, message: 'A workspace has already been opened from this invitation. Withdrawing the invitation would not close it — act in the workspace instead.' });
    }
    const at = now();
    h.status = 'withdrawn';
    h.withdrawnAt = at;
    h.rev = (h.rev ?? 1) + 1;
    h.revAt = at;
    kase.history ??= [];
    kase.history.push({ id: nextId('aud'), at, action: 'transaction_handoff_withdrawn', by: { kind: 'org', userId: req.orgUser.id, name: req.orgUser.name }, detail: { handoffId: h.id } });
    persistNow();
    broadcast('transaction_handoff_withdrawn', { orgId: kase.orgId, roomId: kase.id, handoffId: h.id });
    if (h.invitedAgentUserId) {
      notify({ kind: 'org_user', id: h.invitedAgentUserId }, 'representation_transaction',
        'A club has withdrawn its invitation to open a transaction workspace. Nothing was opened and nothing was agreed.', h.id);
    }
    res.json({ handoff: handoffView(h, kase) });
  });

  /**
   * The AGENT's side of the invitation (§39): the handoffs standing for this
   * agent's own clients. A reference and an id — enough to open a transaction
   * from, and nothing about the club's recruitment thinking.
   */
  orgRouter.get('/agent/handoffs', (req, res) => {
    if (!agent.resolveMembership(req, res)) return;
    if (!agent.requireCap(req, res, 'transactions.read')) return;
    const items = [];
    for (const kase of db.recruitmentCases ?? []) {
      const h = kase?.transactionHandoff;
      if (!h || h.invitedAgentUserId !== req.orgUser.id) continue;
      if (effectiveHandoffStatus(h) !== 'invited') continue;
      // Re-derived NOW: an invitation sent while the relationship was active is
      // not an entitlement after it ends.
      const basis = basisFor({ agentUserId: req.orgUser.id, clientId: h.playerId });
      if (!basis.ok) continue;
      const club = (db.orgs ?? []).find((o) => o && o.id === h.orgId) ?? null;
      items.push({
        handoffId: h.id,
        recruitmentCaseId: kase.id,
        clientId: h.playerId,
        agreementId: basis.agreementId,
        club: { id: h.orgId, name: club?.name ?? null },
        invitedAt: h.invitedAt,
        expiresAt: h.invitedAt + HANDOFF_TTL_MS,
      });
    }
    items.sort((x, y) => y.invitedAt - x.invitedAt);
    res.json({
      items,
      note: 'Clubs that have invited a transaction workspace for one of your clients. Their recruitment case, their assessment and their reasons are not here. Opening a workspace is your action and commits nobody to anything.',
    });
  });

  /**
   * Called by P5.6D when a transaction names a `recruitmentCaseId`: the
   * invitation is marked taken up and bound to that transaction, so the club can
   * see one was opened without seeing inside it, and so a second transaction
   * cannot be opened from the same invitation.
   *
   * Returns a refusal code or null. The transaction route obeys it.
   */
  function bindHandoff({ recruitmentCaseId, transactionId, agencyOrgId, agentUserId, clientId, at = now() }) {
    const kase = (db.recruitmentCases ?? []).find((k) => k && k.id === recruitmentCaseId) ?? null;
    if (!kase) return 'HANDOFF_NOT_FOUND';
    const h = kase.transactionHandoff;
    if (!h) return 'HANDOFF_NOT_FOUND';
    if (h.playerId !== clientId) return 'HANDOFF_SUBJECT_MISMATCH';
    if (effectiveHandoffStatus(h) !== 'invited') return 'HANDOFF_NOT_OPEN';
    // The invitation was addressed to one agency. Another agency's agent cannot
    // answer it, even for the same client — that would let an invitation become
    // a general licence to open a workspace citing this club.
    if (h.invitedAgencyOrgId && h.invitedAgencyOrgId !== agencyOrgId) return 'HANDOFF_NOT_ADDRESSED';
    if (h.invitedAgentUserId && h.invitedAgentUserId !== agentUserId) return 'HANDOFF_NOT_ADDRESSED';
    h.status = 'accepted';
    h.acceptedAt = at;
    h.transactionId = transactionId;
    h.rev = (h.rev ?? 1) + 1;
    h.revAt = at;
    kase.history ??= [];
    kase.history.push({ id: nextId('aud'), at, action: 'transaction_handoff_accepted', by: { kind: 'org', userId: agentUserId, name: null }, detail: { handoffId: h.id } });
    return null;
  }

  // ------------------------------------------------- the seam

  const seam = {
    // decisions
    decide,
    /**
     * Does this recruitment case belong to this organisation? P5.6D asks this
     * before it shows a club a case reference, so that the transaction module
     * never has to read `db.recruitmentCases` itself.
     */
    caseBelongsTo: (caseId, orgId) => (db.recruitmentCases ?? []).some((k) => k && k.id === caseId && k.orgId === orgId),
    basisFor,
    activeAgentsFor,
    soleActiveAgentFor,
    // routing
    contactRoute,
    contactTargetSnapshot,
    routingModes: CONTACT_ROUTING_MODES,
    // projections
    clubPresenceFor,
    // the P5 → transaction handoff, for P5.6D's create route to bind
    bindHandoff,
    duplicateTransactionOf,
    handoffStatuses: HANDOFF_STATUSES,
    handoffBlockerCodes: HANDOFF_BLOCKERS,
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
