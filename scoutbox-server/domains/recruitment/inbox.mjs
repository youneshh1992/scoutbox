// The recipient's side of a club's contact or trial request: the Scout Inbox and the answer. An adult player answers
// their own; a child's requests go to the guardian, and the child's inbox only shows what the guardian decided. No
// message thread exists until a request is accepted, and the thread that opens for a child is between adults.
import { readPage, sendPageError } from '../platform/paging.mjs';
import { rateLimitedBody } from '../platform/rateLimit.mjs';
import { chooseTrialSlot } from '../../domain.mjs';

const childInboxNote = (r) => (r.status === 'pending'
  ? `${r.orgName} contacted your parent/guardian about a ${r.type === 'trial' ? 'trial' : 'conversation'}. They will decide together with you.`
  : r.status === 'accepted'
    ? `Your parent/guardian accepted the ${r.type} with ${r.orgName}.`
    : `Your parent/guardian declined the ${r.type} with ${r.orgName}.`);

export function registerRequestInbox({
  playerRouter, guardianRouter, requests, findPlayer, unit, rateLimit, isBlocked, contactReplyFrom, requestForRecipient,
  lifecycle, openChannel, issueAcceptedTrial, ledgerAppend, notify, broadcast, guardianManagedOnly,
}) {
  for (const hook of ['trialAcceptGate', 'onRequestResponded', 'onTrialAccepted', 'onTrialDeclined']) {
    if (typeof lifecycle?.[hook] !== 'function') throw new TypeError(`registerRequestInbox needs the lifecycle's ${hook}`);
  }

  const pageOf = (req, res) => { try { return readPage(req.query, ['number']); } catch (e) { sendPageError(res, e); return null; } };

  // Newest first, paged by cursor. A child's inbox never carries a message or a contact channel.
  playerRouter.get('/inbox', (req, res) => {
    const page = pageOf(req, res); if (!page) return;
    const { items, nextCursor } = requests.pageForPlayer(req.player.id, page);
    if (req.playerIsMinor) {
      return res.json({
        items: items.map((r) => ({ id: r.id, type: r.type, orgName: r.orgName, orgVerified: r.orgVerified, status: r.status, guardianManaged: true, note: childInboxNote(r) })),
        nextCursor,
      });
    }
    res.json({ items: items.map(requestForRecipient), nextCursor });
  });

  // The guardian sees the verified club and the sender's verified role.
  guardianRouter.get('/inbox', (req, res) => {
    const page = pageOf(req, res); if (!page) return;
    const { items, nextCursor } = requests.pageForGuardianOf(req.guardian.childIds, page);
    res.json({ items: items.map(requestForRecipient), nextCursor });
  });

  /**
   * One answer to a pending request, by `responder` (`{ kind: 'player' | 'guardian', id, name }`) for `player`. A
   * block placed after the request arrived still lets it be declined, never accepted. The trial slot is checked
   * before the answer is recorded, so a refused slot leaves the request pending. A trial invitation tied to a
   * recruitment case re-derives its recipient now. The answer, the Contact, the thread and the trial are one unit.
   */
  function respond(req, res, found, player, responder) {
    if (found.status !== 'pending') return res.status(409).json({ error: 'ALREADY_RESPONDED' });
    const { accept, chosenSlot } = req.body || {};
    const replyCheck = contactReplyFrom(req, res, found);
    if (!replyCheck.ok) return;
    if (accept && isBlocked(found.playerId, found.orgId)) {
      return res.status(403).json({ error: 'BLOCKED', message: 'You have blocked this organisation. Lift the block before accepting.' });
    }
    if (found.contactId && rateLimit.limited('contact_response', `${responder.kind}:${responder.id}`)) return res.status(429).json(rateLimitedBody('contact_response'));
    const slot = accept && found.type === 'trial' ? chooseTrialSlot(found.trialDetails, chosenSlot) : { ok: true, date: null };
    if (!slot.ok) return res.status(400).json(slot);
    if (accept && found.type === 'trial' && found.caseId) {
      const gate = lifecycle.trialAcceptGate({ request: found, by: responder.kind, actorId: responder.id });
      if (!gate.ok) return res.status(gate.status).json({ error: gate.error, message: gate.message });
    }
    const byGuardian = responder.kind === 'guardian';
    const who = byGuardian ? `The guardian of ${player.name}` : player.name;
    const ledgerSuffix = byGuardian ? '_by_guardian' : '';
    const actor = { kind: responder.kind, id: responder.id, name: responder.name };
    const at = Date.now();
    const answered = unit(() => {
      let request = requests.recordResponse(found.id, { status: accept ? 'accepted' : 'declined', respondedAt: at, respondedBy: responder.kind });
      lifecycle.onRequestResponded({ request, accept: !!accept, message: replyCheck.reply, by: responder.kind, at });
      const ledger = (outcome) => ledgerAppend({ type: `${request.type}_${outcome}${ledgerSuffix}`, playerId: player.id, orgId: request.orgId, orgName: request.orgName, userId: request.userId, scoutName: request.scoutName });
      if (accept) {
        const channel = openChannel(request);
        request = requests.attachChannel(request.id, { channelId: channel.id });
        ledger('accepted');
        if (request.type === 'trial') {
          const trial = issueAcceptedTrial({ request, player, trialDate: slot.date, by: responder.kind, at, actor: { id: responder.id, name: responder.name } });
          lifecycle.onTrialAccepted({ request, trial, at, actor });
        }
        notify({ kind: 'org_user', id: request.userId }, 'accepted', `${who} accepted your ${request.type} request — thread open.`, request.contactChannel);
        // The child hears the outcome as a request outcome, the category the club's own rows use, not as a discovery nudge.
        if (byGuardian) notify({ kind: 'player', id: player.id }, 'guardian_decision', `Your parent/guardian accepted the ${request.type} with ${request.orgName}.`, request.id);
      } else {
        ledger('declined');
        if (request.type === 'trial') lifecycle.onTrialDeclined({ request, at, actor, message: replyCheck.reply });
        notify({ kind: 'org_user', id: request.userId }, 'declined', `${who} declined your ${request.type} request.`, request.id);
        if (byGuardian) notify({ kind: 'player', id: player.id }, 'guardian_decision', `Your parent/guardian declined the ${request.type} with ${request.orgName}.`, request.id);
      }
      broadcast('requests', { playerId: player.id });
      return requests.byId(request.id);
    });
    res.json(requestForRecipient(answered));
  }

  playerRouter.post('/requests/:id/respond', (req, res) => {
    if (guardianManagedOnly(req, res)) return;
    const r = requests.byId(req.params.id);
    if (!r || r.playerId !== req.player.id || r.routedTo !== 'player') return res.status(404).json({ error: 'REQUEST_NOT_FOUND' });
    respond(req, res, r, req.player, { kind: 'player', id: req.player.id, name: req.player.name });
  });

  guardianRouter.post('/requests/:id/respond', (req, res) => {
    const r = requests.byId(req.params.id);
    if (!r || r.routedTo !== 'guardian' || !req.guardian.childIds.includes(r.playerId)) return res.status(404).json({ error: 'REQUEST_NOT_FOUND' });
    respond(req, res, r, findPlayer(r.playerId), { kind: 'guardian', id: req.guardian.id, name: req.guardian.name });
  });
}
