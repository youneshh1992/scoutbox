/**
 * The cross-app integration seam: resolves, through each domain's own gates, the facts the pure rules in
 * `integration.mjs` decide on, so "can this agent see this?" has one answer everywhere.
 *
 * It registers before the recruitment lifecycle and the transactions, which take its seam as an argument.
 */

import {
  effectiveAgreementStatus,
  agreementGrantsAccess,
  verificationGap,
  shareView,
  MAX_OPPORTUNITY_SHARES,
} from '../core/shared.mjs';
import { MINOR_PATHWAY_PRODUCTION_ENABLED } from '../compliance/policy.mjs';
import { opportunityBoardFor } from '../../scouting/journeys.mjs';
import { refuseWhenLimited } from '../../platform/rateLimit.mjs';
import { plainShared } from '../../recruitment/lifecycle/contact.mjs';
import { normaliseClientKey, payloadFingerprint } from '../../platform/idempotency.mjs';
import { inputOrRefuse } from '../../platform/schemas.mjs';
import { AGENT_INPUT, agentParseOptions } from '../core/schemas.mjs';
import { AGENT_CORE_LIMITS } from '../../../repositories/agentCore.mjs';
import { chainHead, isFormal } from '../../recruitment/lifecycle/decision.mjs';
import { roomRole, roomCan } from '../../recruitment/rooms/shared.mjs';
import { TERMINAL_STATUSES } from '../transactions/transaction.mjs';
import {
  scheduleView as trialScheduleView,
  deriveWorkflowState,
  TRIAL_WORKFLOW_LABELS,
  isLegacyTrial,
} from '../../recruitment/lifecycle/trial.mjs';
import {
  SURFACES,
  SURFACE_NAMES,
  SURFACE_DISCLOSURE,
  POLICY_ACTION_FOR_SURFACE,
  DISCLOSURE_KEYS,
  DISCLOSURE_DEFAULT,
  CONTACT_ROUTING_MODES,
  RULE_ORDER,
  DENY_CODES,
  agentClientBasis,
  agentSurfaceDecision,
  normaliseDisclosure,
  contactRouting,
  contactTargetSnapshot,
  clubAgentPresence,
  surfaceIsRegulated,
  HANDOFF_STATUSES,
  HANDOFF_BLOCKERS,
  HANDOFF_TTL_MS,
  effectiveHandoffStatus,
  handoffBlockers,
  duplicateTransactionOf,
} from './integration.mjs';
import { now } from '../../platform/clock.mjs';

export function registerIntegration(ctx) {
  const {
    byId,
    orgRouter,
    playerRouter,
    nextId,
    notify,
    broadcast,
    findPlayer,
    isAdult,
    isBlocked,
    orgCanSee,
    checkEligibility,
    distanceBand,
    access,
    compliance,
    rateLimit,
    agentCore,
    unit, // an opportunity share is a row of its agreement, written by agreements.addShare in a unit
    recruitmentCases, // the handoff is part of its case, written by the case's handoff acts
    recruitmentReads,
    transactionReads,
  } = ctx;
  if (typeof transactionReads?.transactions?.liveForIndividual !== 'function')
    throw new TypeError('registerIntegration needs transactionReads from the data layer');
  if (!recruitmentCases?.cases)
    throw new TypeError('registerIntegration needs the recruitment-cases repository from the data layer');
  if (typeof agentCore?.agreements?.recordAct !== 'function' || typeof unit !== 'function')
    throw new TypeError('registerIntegration needs the agent core repository and unit from the data layer');
  if (typeof recruitmentReads?.contacts?.forAgent !== 'function')
    throw new TypeError('registerIntegration needs recruitmentReads (contacts) from the data layer');
  const { cases } = recruitmentCases;
  const handoffHistory = (at, action, by, detail) => ({
    history: [
      { id: nextId('aud'), at, byKind: 'org', byId: by.userId ?? null, byName: by.name ?? null, action, detail },
    ],
  });

  /**
   * Charged only once a request has passed authorisation and is about to change something, so a refused caller
   * cannot spend the budget of the club or agent they are impersonating.
   */
  const limitedOr429 = refuseWhenLimited(rateLimit);
  /** The request input read with its schema (core/schemas.mjs), or `undefined` once the refusal is sent. */
  const inputOr400 = (res, name, input) => inputOrRefuse(res, AGENT_INPUT[name], input ?? {}, agentParseOptions(name));
  const clientKeyOf = (body, res) => {
    const k = normaliseClientKey(body.clientKey);
    if (!k.ok) {
      res.status(400).json({ error: 'AGENT_CLIENT_KEY_INVALID', message: k.message });
      return undefined;
    }
    return k.key;
  };
  const agentDisplayName = (userId) => access?.profileOf?.(userId)?.displayName ?? byId.user(userId)?.name ?? null;

  /**
   * A handoff is a decision about the club's external conduct, so writing it needs the same rank as the formal
   * decision.
   */
  function roomForHandoff(req, res, need) {
    const kase = ctx.findRoomForRequest(req, res);
    if (!kase) return null;
    const role = roomRole({ room: kase, user: req.orgUser, isLead: ctx.isLead(req.orgUser) });
    if (!roomCan(role, 'decision_view')) {
      res.status(403).json({ error: 'HANDOFF_NOT_PERMITTED', message: "Your role cannot read this case's handoff." });
      return null;
    }
    const canWrite = roomCan(role, 'decision_finalize');
    if (need === 'write' && !canWrite) {
      res.status(403).json({
        error: 'HANDOFF_NOT_PERMITTED',
        message: 'Only a recruitment lead can invite a transaction workspace.',
      });
      return null;
    }
    return { kase, role, canWrite };
  }
  const agreementsFor = (clientId) => ctx.agentReads.agreements.forClient(clientId);
  const agreementById = (id) => (typeof id === 'string' ? ctx.agentReads.agreements.byId(id) : null);

  // ---------------------------------------------------------------- basis

  const basisFor = ({ agentUserId, clientId, at = now() }) =>
    agentClientBasis({ agreements: agreementsFor(clientId), agentUserId, clientId, now: at });

  /** A row naming no agent fails the predicate, because it is asked about the agent the row names. */
  function activeAgentsFor(clientId, at = now()) {
    const out = [];
    for (const a of agreementsFor(clientId)) {
      if (!agreementGrantsAccess(a, a.agentUserId, at)) continue;
      out.push(a);
    }
    return out;
  }

  /**
   * Two active agents is ambiguity and fails closed: ScoutBox does not pick a player's representative, and guessing
   * would give one agent an approach the other never saw.
   */
  function soleActiveAgentFor(clientId, at = now()) {
    const all = activeAgentsFor(clientId, at);
    if (all.length === 1) return { agreement: all[0], ambiguous: false };
    return { agreement: null, ambiguous: all.length > 1 };
  }

  // ---------------------------------------------------------------- facts

  function licenceCurrentFor(agentUserId, jurisdiction, at = now()) {
    const p = access?.profileOf ? access.profileOf(agentUserId) : null;
    if (!p) return false;
    return !verificationGap(p, jurisdiction, at);
  }

  /** No compliance seam → null, which the decision reads as "not evaluated", not clear. */
  function complianceClearFor(surface, agentUserId, jurisdiction) {
    const action = POLICY_ACTION_FOR_SURFACE[surface] ?? null;
    if (!action || !compliance?.clearFor) return null;
    const v = compliance.clearFor({ agentUserId, jurisdiction, action });
    return typeof v?.clear === 'boolean' ? v.clear : null;
  }

  /**
   * Nothing writes an agent-directed Passport or evidence share (Passport share links are tokens a person opens, not
   * a grant to a named agent), so those surfaces refuse with SHARE_REQUIRED.
   */
  const sharedFor = () => false;

  /** `viewerOrgId` is the third party (a club): a club the player blocked does not reach them through their agent. */
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
      // Read from the policy layer, so enabling a minor pathway is a policy change and not an edit here.
      minorPathwayOpen: jurisdiction ? MINOR_PATHWAY_PRODUCTION_ENABLED[jurisdiction] === true : false,
      blocked:
        !!player &&
        ((basis.agencyOrgId ? isBlocked(player.id, basis.agencyOrgId) : false) ||
          (viewerOrgId ? isBlocked(player.id, viewerOrgId) : false)),
      disclosure: SURFACE_DISCLOSURE[surface]
        ? normaliseDisclosure(agreement?.disclosure)[SURFACE_DISCLOSURE[surface]]
        : null,
      shared: sharedFor(),
      licenceCurrent: licenceCurrentFor(agentUserId, jurisdiction, at),
      complianceClear: surfaceIsRegulated(surface) ? complianceClearFor(surface, agentUserId, jurisdiction) : null,
    });
  }

  // ------------------------------------------------------- contact routing

  /**
   * The club asks for a mode, never names the agent. Called at compose time and again at send time, so authority is
   * re-derived rather than remembered.
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
    const decision = decide({
      surface: 'contact_participation',
      clientId,
      agentUserId: agreement.agentUserId,
      viewerOrgId,
      at,
    });
    return contactRouting({ recipient, agentDecision: decision, requestedMode });
  }

  // ------------------------------------------------------- club presence

  /**
   * Only the agreement's own jurisdiction: where else the agent is registered is their business, not something the
   * player chose to disclose.
   */
  const flatFacets = (states, jurisdiction) =>
    states
      ? {
          fifa_licence: typeof states.fifa_licence === 'string' ? states.fifa_licence : null,
          national_registration: jurisdiction ? (states.national_registration?.[jurisdiction] ?? null) : null,
          domestic_authorisation: jurisdiction ? (states.domestic_authorisation?.[jurisdiction] ?? null) : null,
        }
      : null;

  /** A club learns who represents a player only because the player chose to disclose it. */
  function clubPresenceFor({ player, viewerOrgId, at = now() }) {
    if (!player) return null;
    const { agreement } = soleActiveAgentFor(player.id, at);
    if (!agreement) return null;
    const decision = decide({
      surface: 'club_agent_presence',
      clientId: player.id,
      agentUserId: agreement.agentUserId,
      viewerOrgId,
      at,
    });
    if (decision.allowed !== true) return null;
    const profile = access?.profileOf ? access.profileOf(agreement.agentUserId) : null;
    const user = byId.user(agreement.agentUserId);
    const org = byId.org(agreement.agencyOrgId);
    return clubAgentPresence({
      decision,
      agent: { displayName: profile?.displayName ?? user?.name ?? null },
      agency: { id: org?.id ?? null, name: org?.name ?? null },
      facets: flatFacets(
        compliance?.facetStatesFor ? compliance.facetStatesFor(agreement.agentUserId) : null,
        agreement.jurisdiction,
      ),
    });
  }

  // ------------------------------------------------- agent-facing reads

  /**
   * Filtered by the routing snapshot, so revoking `contactRouting` stops new contacts without erasing ones already
   * received. Nothing of the club's recruitment case crosses.
   */
  orgRouter.get('/agent/clients/:id/contacts', (req, res) => {
    if (!access.resolveMembership(req, res)) return;
    const found = access.findOwnAgreement(req, res, req.params.id);
    if (!found) return;
    if (found.summaryOnly)
      return res
        .status(403)
        .json({ error: 'AGENT_ACTION_NOT_PERMITTED', message: "A summary row does not open a client's contacts." });
    const a = found;
    const decision = decide({ surface: 'client_private', clientId: a.clientId, agentUserId: req.orgUser.id });
    if (decision.allowed !== true) {
      return res.status(403).json({
        error: decision.code,
        rule: decision.rule,
        message: "This client's record is not open to you right now.",
      });
    }
    const items = [];
    for (const c of recruitmentReads.contacts.forAgent(req.orgUser.id)) {
      if (c.playerId !== a.clientId) continue;
      const snap = c.routingSnapshot ?? null;
      if (snap?.agent?.agentUserId !== req.orgUser.id) continue;
      const org = byId.org(c.orgId);
      items.push({
        id: c.id,
        club: { id: c.orgId, name: org?.name ?? null },
        status: c.status,
        channel: c.channel,
        subject: c.subject ?? null,
        // Routed means the club addressed this to the agent as well as the player.
        body: c.body ?? null,
        routedAt: snap.at,
        routedMode: snap.mode,
        deliveredAt: c.deliveredAt ?? null,
        respondedAt: c.respondedAt ?? null,
        // The kind of answer only; the client's free-text reply stays theirs.
        responseKind: c.response?.kind ?? null,
      });
    }
    items.sort((x, y) => y.routedAt - x.routedAt || String(y.id).localeCompare(String(x.id)));
    res.json({
      items,
      clientId: a.clientId,
      note: "Contacts a club routed to you as well as to your client. The club's own recruitment case, its internal notes and its assessment of your client are not here and never will be. Answering is your client's act, not yours.",
    });
  });

  /**
   * That a trial exists and its scheduling, without the assessment, report, Box Cam footage, venue address or joining
   * instructions (those were held back until the family accepted). An agent cannot act on a trial for the player.
   */
  orgRouter.get('/agent/clients/:id/trials', (req, res) => {
    if (!access.resolveMembership(req, res)) return;
    const found = access.findOwnAgreement(req, res, req.params.id);
    if (!found) return;
    if (found.summaryOnly)
      return res
        .status(403)
        .json({ error: 'AGENT_ACTION_NOT_PERMITTED', message: "A summary row does not open a client's trials." });
    const a = found;
    const decision = decide({ surface: 'trial_projection', clientId: a.clientId, agentUserId: req.orgUser.id });
    if (decision.allowed !== true) {
      return res.status(403).json({
        error: decision.code,
        rule: decision.rule,
        message:
          decision.code === 'DISCLOSURE_WITHHELD'
            ? 'Your client has not chosen to share their trial schedule with you. That choice is theirs and they can change it at any time in My Agent.'
            : "This client's trials are not open to you right now.",
      });
    }
    const player = findPlayer(a.clientId);
    const items = [];
    for (const t of recruitmentReads.trials.forPlayer(a.clientId)) {
      if (t.subjectRemovedAt) continue;
      const org = byId.org(t.orgId);
      const state = deriveWorkflowState(t);
      items.push({
        id: t.id,
        club: { id: t.orgId, name: t.orgName ?? org?.name ?? null },
        workflowState: state,
        workflowLabel: TRIAL_WORKFLOW_LABELS[state] ?? state,
        legacy: isLegacyTrial(t),
        acceptedAt: t.acceptedAt ?? null,
        // As the 'agent' viewer: address, instructions and evidence are absent, not redacted.
        schedule: trialScheduleView(t, 'agent'),
        awaitingClientConfirmation: !!t.schedule && !t.schedule.confirmedAt,
        completion: t.completion ? { state: t.completion.state, at: t.completion.at } : null,
        // Whether a report obligation exists, never what it says.
        reportObligation: t.status === 'awaiting_report' ? 'outstanding' : t.status === 'reported' ? 'filed' : null,
      });
    }
    items.sort((x, y) => (y.acceptedAt ?? 0) - (x.acceptedAt ?? 0) || String(y.id).localeCompare(String(x.id)));
    res.json({
      items,
      clientId: a.clientId,
      clientName: player && orgCanSee(req.org, player) ? player.name : null,
      note: "Your client's trials as the club and your client have recorded them. The club's assessment, its trial report and any Box Cam footage are not here. Confirming, rescheduling and attending are your client's acts and the club's; ScoutBox does not let you do them on your client's behalf.",
      honest: 'Nothing here is an offer, a negotiation or a fee. A trial is an assessment opportunity.',
    });
  });

  // --------------------------------------------------- opportunity share

  /**
   * The opportunity must already be on the client's own board, rebuilt with the player screen's function, so an agent
   * cannot surface anything the client could not find. Applying stays the player's own act.
   */
  orgRouter.post('/agent/clients/:id/opportunities/:oppId/share', (req, res) => {
    if (!access.resolveMembership(req, res)) return;
    if (!access.requireCap(req, res, 'clients.opportunities.share')) return;
    const found = access.findOwnAgreement(req, res, req.params.id);
    if (!found) return;
    if (found.summaryOnly)
      return res
        .status(403)
        .json({ error: 'AGENT_ACTION_NOT_PERMITTED', message: 'A summary row does not permit sharing.' });
    const a = found;

    const b = inputOr400(res, 'opportunityShare', req.body);
    if (!b) return;
    const key = clientKeyOf(b, res);
    if (key === undefined) return;
    const note = plainShared(b.note, AGENT_CORE_LIMITS.shareNote);

    if (key) {
      const hit = a.opportunityShares.find((s) => s && s.keys?.share?.key === key);
      if (hit) {
        if (hit.keys.share.fp === payloadFingerprint({ opportunityId: req.params.oppId, note })) {
          return res.json({ share: shareView(hit), idempotent: true });
        }
        return res
          .status(409)
          .json({ error: 'AGENT_IDEMPOTENCY_CONFLICT', message: 'That key was used for a different share.' });
      }
    }

    const decision = decide({ surface: 'opportunity_share', clientId: a.clientId, agentUserId: req.orgUser.id });
    if (decision.allowed !== true) {
      return res.status(403).json({
        error: decision.code,
        rule: decision.rule,
        message:
          decision.code === 'SCOPE_INSUFFICIENT'
            ? 'Your agreement with this client does not cover employment or transfer work, which is what sharing an opportunity is.'
            : 'You cannot share an opportunity with this client right now.',
      });
    }
    // Before the board is searched: unlimited attempts could probe the board one id at a time, and the uniform 404
    // hides only the answer, not the count. Sharing and withdrawing share one budget.
    if (limitedOr429(res, 'opportunity_share', req.orgUser.id)) return;
    const player = findPlayer(a.clientId);
    const board = opportunityBoardFor(ctx.grassrootsReads, player, {
      orgCanSee,
      checkEligibility,
      distanceBand,
      scoutingReads: ctx.scoutingReads,
      orgOf: ctx.byId.org,
    });
    const opp = board.find((o) => o && o.id === req.params.oppId) ?? null;
    // Missing, closed and ineligible answer alike, or this is an existence oracle over the board.
    if (!opp)
      return res
        .status(404)
        .json({ error: 'OPPORTUNITY_NOT_AVAILABLE', message: "That opportunity is not on this client's board." });

    const already = a.opportunityShares.find((s) => s && s.opportunityId === opp.id && !s.withdrawnAt);
    if (already)
      return res.status(409).json({
        error: 'OPPORTUNITY_ALREADY_SHARED',
        shareId: already.id,
        message: 'You have already shared this opportunity with this client.',
      });
    if (a.opportunityShares.length >= MAX_OPPORTUNITY_SHARES) {
      return res.status(409).json({
        error: 'OPPORTUNITY_SHARE_LIMIT',
        message: `This relationship already holds ${MAX_OPPORTUNITY_SHARES} shares, which is the most one record keeps.`,
      });
    }

    const at = now();
    const share = unit(() => {
      const draft = {
        id: nextId('aos'),
        opportunityId: opp.id,
        via: opp.via ?? null,
        title: opp.title ?? null,
        orgName: opp.orgName ?? null,
        deadline: opp.deadline ?? null,
        note: note || null,
        sharedAt: at,
        sharedBy: { kind: 'org', userId: req.orgUser.id, name: agentDisplayName(req.orgUser.id) },
        withdrawnAt: null,
        keys: key ? { share: { key, fp: payloadFingerprint({ opportunityId: opp.id, note }) } } : {},
        rev: 1,
        revAt: at,
      };
      // No agreement rev: a share changes no term.
      agentCore.agreements.addShare(
        a.id,
        { share: draft },
        {
          history: [
            {
              id: nextId('aud'),
              at,
              action: 'opportunity_shared',
              by: { kind: 'org', userId: req.orgUser.id, name: req.orgUser.name },
              detail: { shareId: draft.id, via: draft.via },
            },
          ],
        },
      );
      broadcast('agent_opportunity_shared', { orgId: a.agencyOrgId, agreementId: a.id, agentUserId: req.orgUser.id });
      notify(
        { kind: 'player', id: a.clientId },
        'representation_opportunity',
        `${draft.sharedBy.name ?? 'Your agent'} shared an opportunity with you${draft.orgName ? ` at ${draft.orgName}` : ''}. Applying is your own decision — nobody can apply on your behalf.`,
        draft.id,
      );
      return draft;
    });
    res.status(201).json({
      share: shareView(share),
      note: 'Shared. Your client decides whether to apply, on their own screen, in their own name.',
    });
  });

  /** The record stays, marked withdrawn. */
  orgRouter.post('/agent/clients/:id/opportunities/shares/:shareId/withdraw', (req, res) => {
    if (!access.resolveMembership(req, res)) return;
    if (!access.requireCap(req, res, 'clients.opportunities.share')) return;
    const found = access.findOwnAgreement(req, res, req.params.id);
    if (!found || found.summaryOnly) {
      if (found?.summaryOnly) res.status(403).json({ error: 'AGENT_ACTION_NOT_PERMITTED' });
      return;
    }
    const a = found;
    const share = a.opportunityShares.find((s) => s.id === req.params.shareId);
    if (!share) return res.status(404).json({ error: 'OPPORTUNITY_SHARE_NOT_FOUND' });
    if (!inputOr400(res, 'none', req.body)) return;
    if (share.withdrawnAt) return res.json({ share: shareView(share), idempotent: true });
    // No live basis check: an agent whose relationship ended can still take back a share, which widens nobody's
    // access. It draws on the sharing quota, being the other half of the share/withdraw loop.
    if (limitedOr429(res, 'opportunity_share', req.orgUser.id)) return;
    const at = now();
    const updated = unit(() =>
      agentCore.agreements.withdrawShare(
        a.id,
        { shareId: share.id, at },
        {
          history: [
            {
              id: nextId('aud'),
              at,
              action: 'opportunity_share_withdrawn',
              by: { kind: 'org', userId: req.orgUser.id, name: req.orgUser.name },
              detail: { shareId: share.id },
            },
          ],
        },
      ),
    );
    res.json({ share: shareView(updated.opportunityShares.find((x) => x.id === share.id)) });
  });

  orgRouter.get('/agent/clients/:id/opportunities/shares', (req, res) => {
    if (!access.resolveMembership(req, res)) return;
    const found = access.findOwnAgreement(req, res, req.params.id);
    if (!found) return;
    if (found.summaryOnly) return res.status(403).json({ error: 'AGENT_ACTION_NOT_PERMITTED' });
    // Closes when the mandate does: an agent's history of acting is not a window onto a former client.
    // `client_private`, because this reads the relationship rather than making a suggestion.
    const decision = decide({ surface: 'client_private', clientId: found.clientId, agentUserId: req.orgUser.id });
    if (decision.allowed !== true) {
      return res.status(403).json({
        error: decision.code,
        rule: decision.rule,
        message: "This client's record is not open to you right now.",
      });
    }
    res.json({ items: found.opportunityShares.map(shareView).sort((x, y) => y.sharedAt - x.sharedAt) });
  });

  /** Only active agreements: a share made under a relationship that has ended stops appearing. */
  playerRouter.get('/agent/shared-opportunities', (req, res) => {
    if (req.playerIsMinor) return res.json({ items: [], minor: true });
    const items = [];
    for (const a of activeAgentsFor(req.player.id)) {
      for (const s of a.opportunityShares) {
        if (s.withdrawnAt) continue;
        items.push({ ...shareView(s), agreementId: a.id, agencyOrgId: a.agencyOrgId });
      }
    }
    items.sort((x, y) => y.sharedAt - x.sharedAt);
    res.json({
      items,
      note: 'Opportunities your agent brought to your attention. Each one is still yours to apply for, or not: your agent cannot apply for you and ScoutBox will not do it on their word.',
    });
  });

  // ------------------------------------ formal decision → transaction

  /** Only this boolean crosses the boundary, never the internal decision itself. */
  function hasFinalProgressDecision(kase) {
    const rows = recruitmentReads.decisions.forRoom(kase.id).filter((d) => d.orgId === kase.orgId);
    const head = chainHead(rows);
    return !!head && isFormal(head) && head.state === 'final' && head.outcome === 'progress' && !head.supersededById;
  }

  const handoffOf = (kase) => kase.transactionHandoff ?? null;

  function liveTransactionFor(kase) {
    return duplicateTransactionOf(
      transactionReads.transactions.liveForIndividual(kase.playerId, 'employment_contract'),
      {
        clientId: kase.playerId,
        type: 'employment_contract',
        engagingOrgId: kase.orgId,
        releasingOrgId: null,
        terminalStatuses: TERMINAL_STATUSES,
        partiesOf: (t) => t.parties ?? [],
      },
    );
  }

  function handoffFacts(req, kase, { canWrite }) {
    const player = findPlayer(kase.playerId);
    const h = handoffOf(kase);
    const live = liveTransactionFor(kase);
    // An unrepresented player has no agent to evaluate; the transaction's creation gate asks whoever opens one.
    const { agreement } = soleActiveAgentFor(kase.playerId);
    const complianceEvaluable = agreement
      ? compliance?.clearFor
        ? compliance.clearFor({
            agentUserId: agreement.agentUserId,
            jurisdiction: agreement.jurisdiction,
            action: 'declare_representation',
          }).clear === true
        : false
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

  /** Whether the client is represented, never by whom (that is the player's `clubPresence` choice). */
  const handoffView = (h, kase) =>
    h
      ? {
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
          honest:
            'An invitation to open a transaction workspace. It is not an offer, it carries no terms and no fee, and it commits nobody to anything. The workspace itself is opened by a licensed agent, and every party confirms their own participation.',
        }
      : null;

  /** The mutation below calls the same `handoffBlockers`, so forcing the request gets the answer the screen showed. */
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
      // A viewer does not get a checklist of what a lead could do.
      blockers: canWrite ? blockers : ['HANDOFF_NOT_PERMITTED'],
      blockerVocabulary: HANDOFF_BLOCKERS,
      action: 'inviteToTransaction',
      note: 'Inviting a transaction is a separate, explicit decision. ScoutBox never creates one from a recruitment decision by itself, and this invitation is not an offer.',
    });
  });

  orgRouter.post('/rooms/:id/transaction-handoff', (req, res) => {
    const got = roomForHandoff(req, res, 'write');
    if (!got) return;
    const { kase, canWrite } = got;
    const b = inputOr400(res, 'handoffInvite', req.body);
    if (!b) return;
    const key = clientKeyOf(b, res);
    if (key === undefined) return;
    const existing = handoffOf(kase);
    if (existing && key && existing.keys?.invite?.key === key) {
      return res.json({ handoff: handoffView(existing, kase), idempotent: true });
    }
    const facts = handoffFacts(req, kase, { canWrite });
    const blockers = handoffBlockers(facts);
    if (blockers.length) {
      return res
        .status(
          blockers[0] === 'HANDOFF_NOT_PERMITTED'
            ? 403
            : blockers.includes('HANDOFF_EXISTS') || blockers.includes('HANDOFF_TRANSACTION_EXISTS')
              ? 409
              : 422,
        )
        .json({
          error: blockers[0],
          blockers,
          message: 'This case cannot be handed to a transaction workspace right now.',
        });
    }
    // A withdrawn invitation may be re-issued, so without a quota invite/withdraw/invite could ring a player's and an
    // agent's notifications without limit.
    if (limitedOr429(res, 'transaction_handoff', kase.orgId)) return;
    const { agreement } = soleActiveAgentFor(kase.playerId);
    const at = now();
    const h = {
      id: nextId('hof'),
      caseId: kase.id,
      orgId: kase.orgId,
      playerId: kase.playerId,
      status: 'invited',
      invitedAt: at,
      invitedBy: { kind: 'org', userId: req.orgUser.id, name: req.orgUser.name },
      acceptedAt: null,
      withdrawnAt: null,
      transactionId: null,
      // Whether, not who: the handoff must not become a back door to the agent's identity.
      representedAtInvitation: !!agreement,
      // The transaction that answers the invitation must come from this agency.
      invitedAgencyOrgId: agreement?.agencyOrgId ?? null,
      invitedAgentUserId: agreement?.agentUserId ?? null,
      keys: { invite: key ? { key } : null },
      rev: 1,
      revAt: at,
    };
    cases.inviteHandoff(
      kase.id,
      { handoff: h },
      handoffHistory(at, 'transaction_handoff_invited', h.invitedBy, {
        handoffId: h.id,
        represented: h.representedAtInvitation,
      }),
    );
    broadcast('transaction_handoff_invited', { orgId: kase.orgId, roomId: kase.id, handoffId: h.id });
    // The player hears too: they should never learn a club is acting on them from their agent alone.
    if (agreement?.agentUserId) {
      notify(
        { kind: 'org_user', id: agreement.agentUserId },
        'representation_transaction',
        `${req.org.name} has invited a transaction workspace for one of your clients. Opening it is your action, and it commits nobody to anything.`,
        h.id,
      );
    }
    notify(
      { kind: 'player', id: kase.playerId },
      'representation_transaction',
      `${req.org.name} has asked to open a transaction workspace about you. Nothing has been agreed and this is not an offer; you confirm your own participation if a workspace is opened.`,
      h.id,
    );
    res.status(201).json({
      handoff: handoffView(h, kase),
      note: 'Invited. A licensed agent opens the workspace, and every party confirms for themselves.',
    });
  });

  orgRouter.post('/rooms/:id/transaction-handoff/withdraw', (req, res) => {
    const got = roomForHandoff(req, res, 'write');
    if (!got) return;
    const { kase } = got;
    const h = handoffOf(kase);
    if (!h) return res.status(404).json({ error: 'HANDOFF_NOT_FOUND' });
    if (!inputOr400(res, 'none', req.body)) return;
    if (h.status === 'withdrawn') return res.json({ handoff: handoffView(h, kase), idempotent: true });
    // Withdrawing a taken-up invitation would not close the transaction, so it is refused.
    if (h.status === 'accepted') {
      return res.status(409).json({
        error: 'HANDOFF_ALREADY_ACCEPTED',
        transactionId: h.transactionId,
        message:
          'A workspace has already been opened from this invitation. Withdrawing the invitation would not close it — act in the workspace instead.',
      });
    }
    // The other half of the invite/withdraw loop, on the same club budget.
    if (limitedOr429(res, 'transaction_handoff', kase.orgId)) return;
    const at = now();
    const fresh = cases.withdrawHandoff(
      kase.id,
      { at },
      handoffHistory(
        at,
        'transaction_handoff_withdrawn',
        { userId: req.orgUser.id, name: req.orgUser.name },
        { handoffId: h.id },
      ),
    );
    broadcast('transaction_handoff_withdrawn', { orgId: kase.orgId, roomId: kase.id, handoffId: h.id });
    if (h.invitedAgentUserId) {
      notify(
        { kind: 'org_user', id: h.invitedAgentUserId },
        'representation_transaction',
        'A club has withdrawn its invitation to open a transaction workspace. Nothing was opened and nothing was agreed.',
        h.id,
      );
    }
    res.json({ handoff: handoffView(fresh.transactionHandoff, fresh) });
  });

  /** Enough to open a transaction from, and nothing of the club's recruitment thinking. */
  orgRouter.get('/agent/handoffs', (req, res) => {
    if (!access.resolveMembership(req, res)) return;
    if (!access.requireCap(req, res, 'transactions.read')) return;
    const items = [];
    for (const kase of recruitmentReads.cases.forHandoffAgent(req.orgUser.id)) {
      const h = kase?.transactionHandoff;
      if (!h || h.invitedAgentUserId !== req.orgUser.id) continue;
      if (effectiveHandoffStatus(h) !== 'invited') continue;
      // An invitation sent while the relationship was active is not an entitlement after it ends.
      const basis = basisFor({ agentUserId: req.orgUser.id, clientId: h.playerId });
      if (!basis.ok) continue;
      const club = byId.org(h.orgId);
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
   * Binds the invitation to the transaction citing it, so the club sees one was opened and a second cannot be opened
   * from it. Returns a refusal code or null.
   */
  function bindHandoff({ recruitmentCaseId, transactionId, agencyOrgId, agentUserId, clientId, at = now() }) {
    const kase = recruitmentReads.cases.byId(recruitmentCaseId);
    if (!kase) return 'HANDOFF_NOT_FOUND';
    const h = kase.transactionHandoff;
    if (!h) return 'HANDOFF_NOT_FOUND';
    if (h.playerId !== clientId) return 'HANDOFF_SUBJECT_MISMATCH';
    if (effectiveHandoffStatus(h) !== 'invited') return 'HANDOFF_NOT_OPEN';
    // Otherwise an invitation would become a general licence to open a workspace citing this club.
    if (h.invitedAgencyOrgId && h.invitedAgencyOrgId !== agencyOrgId) return 'HANDOFF_NOT_ADDRESSED';
    if (h.invitedAgentUserId && h.invitedAgentUserId !== agentUserId) return 'HANDOFF_NOT_ADDRESSED';
    cases.acceptHandoff(
      kase.id,
      { at, transactionId },
      handoffHistory(at, 'transaction_handoff_accepted', { userId: agentUserId, name: null }, { handoffId: h.id }),
    );
    return null;
  }

  // ------------------------------------------------- the seam

  const seam = {
    // decisions
    decide,
    caseBelongsTo: (caseId, orgId) => recruitmentReads.cases.byId(caseId)?.orgId === orgId,
    basisFor,
    // For agent work that is not a regulated action (the Offer projection).
    licenceCurrentFor,
    activeAgentsFor,
    soleActiveAgentFor,
    // routing
    contactRoute,
    contactTargetSnapshot,
    routingModes: CONTACT_ROUTING_MODES,
    // projections
    clubPresenceFor,
    // handoff
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
