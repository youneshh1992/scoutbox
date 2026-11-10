// Scout Inbox requests: the one writer of an org → player/guardian request row, the one writer of an accepted
// trial, the recipient's view of a request, and the club's direct request route and lists.
//
// There is no direct message channel anywhere in this API. An org can only file a request; contact unlocks on
// acceptance. For minors the request never reaches the child — it routes to the guardian, and any conversation that
// opens is between adults.
import { isAdult, visibleToOrg, validateTrialDetails, trialReportDueAt } from '../../domain.mjs';
import { readPage, sendPageError } from '../platform/paging.mjs';
import { rateLimitedBody } from '../platform/rateLimit.mjs';
import { validateContactReply } from './lifecycle/contact.mjs';

/**
 * A request row as its RECIPIENT may see it: no org id, no user id, no internal Contact link. `caseId` is the club's
 * workflow id and never travels; the trial the recipient's own acceptance created is THEIR record (what
 * /player/trials and /guardian/trials list), so its id does, for the Inbox to deep-link to it. The address line and
 * the instructions of an invitation are shared after acceptance only, never in the Inbox view.
 */
export const requestForRecipient = ({ orgId, userId, contactId, caseId, recipient, keys, trialId, ...visible }) => {
  const out = { ...visible, trialId: trialId ?? null };
  if (out.trialDetails && typeof out.trialDetails === 'object' && 'private' in out.trialDetails) {
    const { private: _p, ...td } = out.trialDetails;
    return { ...out, trialDetails: td };
  }
  return out;
};

export function createRequestWriters({ recruitment, nextId, ledgerAppend, notify, broadcast, safeguardingCertified, moderateOrRefuse }) {
  /**
   * THE one writer of an org → player/guardian request row. The Contact workflow's send, the Trial invitation, an
   * open-day invitation and the direct request route all reach the Inbox through it: the same routing (scout →
   * parent, never scout → child), the same ledger entry, the same notifications, the same `inbox` ping.
   *
   * `guardianId` lets a caller that has already resolved the guardian route (the Contact workflow checks the record,
   * the child link and the verification gates) name it; otherwise the player's own link is used. `notice` words the
   * notifications for a caller with its own occasion (`{ kind, toGuardian, toPlayer }`). `workflow` lets the Trial
   * invitation write its case link, recipient snapshot and client key in the same create (`{ caseId, recipient, keys }`).
   * Returns the stored, read-only row.
   */
  function issueRecruitmentRequest({
    org, orgUser, player, type, message = '', trialDetails = null,
    subject = null, contactId = null, guardianId = undefined, at = Date.now(), notice = null, workflow = null,
  }) {
    const minor = !isAdult(player);
    const request = {
      id: nextId('req'),
      playerId: player.id,
      playerName: player.name,
      orgId: org.id,
      orgName: org.name,
      orgType: org.type,
      orgVerified: !!org.verified,
      orgSafeguardingCertified: safeguardingCertified(org),
      trustedPartner: org.trustedPartner,
      userId: orgUser.id,
      scoutName: orgUser.name,
      scoutRole: orgUser.role || 'Scout',
      type,
      message: message || '',
      // `contactId` is an internal link, stripped from every recipient-facing view (`requestForRecipient`).
      ...(subject ? { subject } : {}),
      ...(contactId ? { contactId } : {}),
      trialDetails,
      status: 'pending',
      createdAt: at,
      routedTo: minor ? 'guardian' : 'player',
      guardianId: minor ? (guardianId ?? player.guardianId) : null,
      contactChannel: null, // stays null until the player/guardian accepts
      ...(workflow ? { caseId: workflow.caseId, trialId: null, recipient: workflow.recipient, keys: workflow.keys } : {}),
    };
    const stored = recruitment.requests.create(request);
    ledgerAppend({ type: `${type}_request${minor ? '_to_guardian' : ''}`, playerId: player.id, orgId: org.id, orgName: org.name, userId: orgUser.id, scoutName: orgUser.name });
    const kind = notice?.kind ?? 'request';
    if (minor) {
      notify({ kind: 'guardian', id: stored.guardianId }, kind, notice?.toGuardian ?? `${org.name} has requested to discuss a ${type === 'trial' ? 'trial' : 'conversation'} for ${player.name}.`, stored.id);
      notify({ kind: 'player', id: player.id }, kind, notice?.toPlayer ?? `${org.name} contacted your parent/guardian about a ${type === 'trial' ? 'trial' : 'conversation'}.`, stored.id);
    } else {
      notify({ kind: 'player', id: player.id }, kind, notice?.toPlayer ?? `${org.name} sent you a ${type} request.`, stored.id);
    }
    broadcast('inbox', { playerId: player.id });
    return stored;
  }

  /**
   * THE one writer of an accepted trial. Both respond routes — the adult's own and the guardian's on a minor's
   * behalf — call this with the slot they already validated (`chooseTrialSlot`), so the two rows cannot drift apart:
   * same fields, same clock (`at` is the response instant stamped on the request), same deadline derivation.
   * `trialDate` is a validated `YYYY-MM-DD` or null (date to be confirmed); `trialReportDueAt` never returns NaN.
   */
  function issueAcceptedTrial({ request, player, trialDate, by, at, actor = null }) {
    const details = request.trialDetails ?? {};
    // Accepting one of a slot-based invitation's concrete slots IS the schedule confirmation: the trial is born
    // `scheduled` with revision 1 confirmed by the recipient. A date-only or undated invitation is born `accepted`
    // with no schedule — a date the club typed is not a confirmed schedule, and nothing is fabricated from it.
    const slot = Array.isArray(details.slots) ? details.slots.find((s) => s && s.day === trialDate) ?? null : null;
    const recipient = { type: by, playerId: player.id, guardianId: by === 'guardian' ? (actor?.id ?? null) : null, minor: by === 'guardian', at };
    const who = { kind: by, id: actor?.id ?? null, name: actor?.name ?? null };
    // The address line and the instructions were held back from the invitation; they join the session now.
    const priv = details.private && typeof details.private === 'object' ? details.private : {};
    const session = slot ? {
      id: nextId('tses'), kind: slot.kind ?? 'training', startsAt: slot.startsAt, endsAt: slot.endsAt,
      venue: slot.venue ? { name: slot.venue.name, town: slot.venue.town ?? null, address: typeof priv.venueAddress === 'string' ? priv.venueAddress : null } : null,
      instructions: typeof priv.instructions === 'string' ? priv.instructions : null,
      evidence: [],
    } : null;
    const proposedBy = { kind: 'org', userId: request.userId ?? null, name: request.scoutName ?? null };
    const schedule = session ? {
      timezone: slot.timezone, revision: 1, proposedAt: request.createdAt ?? at, proposedBy,
      confirmedAt: at, confirmedBy: who,
      sessions: [session],
      revisions: [{ revision: 1, timezone: slot.timezone, sessions: [{ ...session, evidence: undefined }], proposedAt: request.createdAt ?? at, proposedBy, confirmedAt: at, confirmedBy: who, supersededAt: null, reason: 'invitation', material: null }],
    } : null;
    const trial = {
      id: nextId('trial'),
      requestId: request.id,
      caseId: request.caseId ?? null,
      playerId: player.id,
      playerName: player.name,
      orgId: request.orgId,
      orgName: request.orgName,
      scoutName: request.scoutName,
      acceptedAt: at,
      acceptedBy: by,
      guardianApproved: by === 'guardian',
      proposedDate: trialDate,
      venue: typeof details.venue === 'string' && details.venue !== '' ? details.venue : null,
      notes: typeof details.notes === 'string' ? details.notes : '',
      // The mandatory report is due 7 days after the trial day (or acceptance).
      reportDueAt: trialReportDueAt(trialDate, at),
      status: 'awaiting_report',
      workflowState: schedule ? 'scheduled' : 'accepted',
      schedule,
      attendance: [],
      completion: null,
      recipient,
      history: [
        { id: nextId('aud'), at, action: 'trial_accepted', by: who, detail: { recipientType: by, slotId: slot?.id ?? null, day: trialDate ?? null } },
        ...(schedule ? [{ id: nextId('aud'), at, action: 'trial_schedule_confirmed', by: who, detail: { revision: 1, sessionCount: 1 } }] : []),
      ],
      reminders: {},
      rev: 1, revAt: at, revBy: null,
    };
    return recruitment.trials.create(trial); // inside the respond route's unit
  }

  /**
   * An optional short reply on a CONTACT-type request, validated before anything is written and refused if it is
   * not text or if moderation refuses it. Returns `{ ok, reply }`, or answers the request and returns `{ ok: false }`.
   */
  function contactReplyFrom(req, res, request) {
    const check = validateContactReply(req.body?.message, { isContact: request.type === 'contact' });
    if (!check.ok) { res.status(400).json({ error: check.error, message: check.message }); return { ok: false }; }
    if (check.reply && !moderateOrRefuse(res, check.reply, { kind: 'contact_reply', requestId: request.id })) return { ok: false };
    return { ok: true, reply: check.reply };
  }

  return { issueRecruitmentRequest, issueAcceptedTrial, contactReplyFrom };
}

/** The direct request route, and the club's Requests and Trials lists and home figures. */
export function registerClubRequests({ orgRouter, recruitment, findPlayer, isBlocked, moderateOrRefuse, rateLimit, issueRecruitmentRequest }) {
  if (typeof issueRecruitmentRequest !== 'function' || typeof rateLimit?.limited !== 'function') throw new TypeError('registerClubRequests needs the request writer and the rate limiter');

  orgRouter.post('/players/:id/request', (req, res) => {
    const p = findPlayer(req.params.id);
    if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    if (!visibleToOrg(p, req.org)) {
      return res.status(403).json({
        error: req.org.type === 'agency' ? 'UNDER_18_WALL' : 'VERIFIED_CLUBS_ONLY',
        message: req.org.type === 'agency' ? 'Agency accounts cannot contact minors.' : 'Only verified clubs can contact under-18 players (via their guardian).',
      });
    }
    if (isBlocked(p.id, req.org.id)) {
      return res.status(403).json({ error: 'BLOCKED', message: 'This player (or their guardian) has blocked your organisation.' });
    }
    const { type, message } = req.body || {};
    if (!['contact', 'trial'].includes(type)) return res.status(400).json({ error: 'TYPE_MUST_BE_CONTACT_OR_TRIAL' });
    if (!moderateOrRefuse(res, message, { kind: 'org_request_message', orgId: req.org.id, userId: req.orgUser.id })) return;

    if (type === 'trial') {
      // Trial reports are mandatory: an org with an unfiled report for a past trial cannot request new trials until
      // it files. A report can never be filed for a subject who removed their account, so a tombstoned trial does not
      // hold the organisation hostage.
      const overdue = recruitment.trials.forOrgStatus(req.org.id, 'awaiting_report').filter((t) => !t.subjectRemovedAt);
      if (overdue.length > 0) {
        return res.status(409).json({
          error: 'REPORTS_OUTSTANDING',
          message: `You have ${overdue.length} trial(s) awaiting a mandatory performance report. File them before requesting new trials.`,
          trialIds: overdue.map((t) => t.id),
        });
      }
    }

    // Trial logistics: what the player/guardian is actually agreeing to; altSlots lets the other side pick a date.
    // Every date and text field is checked by the one Trial validator before anything is written.
    let trialDetails = null;
    if (type === 'trial') {
      const check = validateTrialDetails(req.body);
      if (!check.ok) return res.status(400).json(check);
      trialDetails = check.details;
      if (trialDetails.notes && !moderateOrRefuse(res, trialDetails.notes, { kind: 'trial_notes', orgId: req.org.id })) return;
    }
    // A second path to the same inbox row as a canonical Contact send or Trial invitation, so it draws on the SAME
    // budgets and keeps the same one-pending rule: a club cannot flood a player through this door.
    const pendingSame = recruitment.requests.forOrgPlayer(req.org.id, p.id).find((r) => r.type === type && r.status === 'pending' && !r.subjectRemovedAt);
    if (pendingSame) return res.status(409).json({ error: 'REQUEST_PENDING', message: `A ${type} request to this player is already awaiting an answer.`, requestId: pendingSame.id });
    if (rateLimit.limited(type === 'trial' ? 'trial_invite' : 'contact_send', req.org.id)) return res.status(429).json(rateLimitedBody(type === 'trial' ? 'trial_invite' : 'contact_send'));
    const request = issueRecruitmentRequest({ org: req.org, orgUser: req.orgUser, player: p, type, message, trialDetails });
    res.status(201).json({ ok: true, requestId: request.id, status: 'pending', routedTo: request.routedTo });
  });

  // Newest first, paged by cursor. The home dashboards read their figures from /org/recruitment-counts, never by
  // counting a page.
  orgRouter.get('/requests', (req, res) => {
    let page;
    try { page = readPage(req.query, ['number']); } catch (e) { return sendPageError(res, e); }
    res.json(recruitment.requests.pageForOrg(req.org.id, page));
  });

  orgRouter.get('/trials', (req, res) => {
    let page;
    try { page = readPage(req.query, ['number']); } catch (e) { return sendPageError(res, e); }
    res.json(recruitment.trials.pageForOrg(req.org.id, page));
  });

  orgRouter.get('/recruitment-counts', (req, res) => {
    res.json({
      requestsPending: recruitment.requests.countForOrgStatus(req.org.id, 'pending'),
      trialsAwaitingReport: recruitment.trials.countForOrgStatus(req.org.id, 'awaiting_report'),
      trials: recruitment.trials.countForOrg(req.org.id),
    });
  });
}
