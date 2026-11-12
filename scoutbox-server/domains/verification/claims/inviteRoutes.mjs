import { isAdult, visibleToOrg } from '../../../domain.mjs';
import { filled, inputOrRefuse, presentOrRefuse } from '../../platform/schemas.mjs';
import { emailProblem } from './shared.mjs';
import { VERIFICATION_LIMITS as L } from '../../../repositories/verification.mjs';
import { EMAIL_CODES, GuardianInviteAnswer, InviteAnswer, PlayerInvite } from './organisationInput.mjs';

export function registerInviteRoutes(ctx) {
  const {
    byId,
    findPlayer,
    guardianRouter,
    isBlocked,
    mailer,
    mintToken,
    nextId,
    notify,
    orgCanAttest,
    orgOf,
    orgRouter,
    peekToken,
    playerRouter,
    reads,
    unit,
    useToken,
    verEvent,
    verification,
  } = ctx;
  const INVITES_PER_DAY = 20;
  orgRouter.post('/verification/player-invites', async (req, res) => {
    if (!orgCanAttest(req.org))
      return res
        .status(403)
        .json({ error: 'ORG_NOT_ELIGIBLE', message: 'Only a verified organisation can send squad invitations.' });
    const today = reads.playerInvites.countSince(req.org.id, Date.now() - 86_400_000);
    if (today >= INVITES_PER_DAY)
      return res.status(429).json({
        error: 'INVITE_RATE_LIMIT',
        message: `Deterministic limit: ${INVITES_PER_DAY} invitations per organisation per day.`,
      });
    const body = inputOrRefuse(res, PlayerInvite, req.body ?? {}, EMAIL_CODES);
    if (!body) return;
    const { playerId } = body;
    const name = filled(body.name);
    if (!presentOrRefuse(res, name, 'name')) return;
    const email = filled(body.email);
    if (email && emailProblem(email)) return res.status(400).json({ error: 'EMAIL_SYNTAX', field: 'email' });
    // An invite to an existing player binds the token to that identity. Targeting uses the standing visibility rules,
    // so an invite is not a discovery bypass.
    let targetPlayer = null;
    if (playerId) {
      targetPlayer = findPlayer(playerId);
      if (!targetPlayer) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
      if (!visibleToOrg(targetPlayer, req.org) || isBlocked(targetPlayer.id, req.org.id)) {
        return res.status(404).json({ error: 'PLAYER_NOT_FOUND' }); // no probing for hidden players
      }
    }
    let secret = null;
    const inv = unit(() => {
      const created = verification.playerInvites.create({
        id: nextId('vpin'),
        orgId: req.org.id,
        byUserId: req.orgUser.id,
        byName: req.orgUser.name == null ? null : String(req.orgUser.name).slice(0, L.name),
        name,
        squad: body.squad ?? '',
        status: 'pending',
        playerId: null,
        targetPlayerId: targetPlayer?.id ?? null,
        guardianApproved: null,
        createdAt: Date.now(),
        expiresAt: Date.now() + 14 * 86_400_000,
        acceptedAt: null,
      });
      secret = mintToken({
        purpose: 'player_invite',
        email: email ?? null,
        orgId: req.org.id,
        refId: created.id,
        subjectKind: targetPlayer ? 'player' : null,
        subjectId: targetPlayer?.id ?? null,
        ttlMs: 14 * 86_400_000,
      });
      return created;
    });
    if (email)
      await mailer.send({
        to: email,
        subject: `${req.org.name} invited you to ScoutBox`,
        text: `Hi ${inv.name},\n\n${req.orgUser.name} at ${req.org.name} invites you to join ScoutBox${inv.squad ? ` (${inv.squad})` : ''}.\n\nInvitation code: ${secret}\n\nJoining is your choice — an invitation gives the club no control over your profile. Under-18s join through a parent or guardian.`,
      });
    res.status(201).json({
      invite: inv,
      ...(email
        ? {}
        : {
            code: secret,
            note: 'No email supplied — hand the single-use code to the player (or their guardian) directly.',
          }),
    });
  });
  orgRouter.get('/verification/player-invites', (req, res) => {
    res.json({ items: reads.playerInvites.forOrg(req.org.id) });
  });

  // Acceptance creates no identity claim and never bypasses guardianship: a minor's invite is accepted by their guardian.
  playerRouter.post('/invites/accept', (req, res) => {
    if (!isAdult(req.player)) {
      return res
        .status(403)
        .json({ error: 'GUARDIAN_MANAGED', message: 'Your guardian accepts club invitations for you.' });
    }
    const body = inputOrRefuse(res, InviteAnswer, req.body ?? {});
    if (!body) return;
    return acceptInvite(res, body.code, req.player, null, body.email ?? null);
  });
  guardianRouter.post('/invites/accept', (req, res) => {
    const body = inputOrRefuse(res, GuardianInviteAnswer, req.body ?? {});
    if (!body) return;
    const child = byId.player(body.childId, (p) => req.guardian.childIds.includes(p.id));
    if (!child) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    return acceptInvite(res, body.code, child, req.guardian);
  });
  function acceptInvite(res, code, player, guardian, claimedEmail = null) {
    // Peek, check every binding, then consume: a wrong-recipient attempt must not burn the rightful recipient's secret.
    const out = peekToken({ purpose: 'player_invite', secret: code });
    if (out.error) return res.status(out.error === 'TOKEN_EXPIRED' ? 410 : 404).json({ error: out.error });
    const found = reads.playerInvites.byId(out.token.refId);
    const inv = found && found.status === 'pending' && !found.playerId ? found : null;
    if (!inv) return res.status(404).json({ error: 'INVITE_NOT_FOUND' });
    const org = orgOf(inv.orgId);
    if (!org || org.suspended) return res.status(403).json({ error: 'ORG_UNAVAILABLE' });
    // An identity-targeted invite: only the named player, or that child through their guardian.
    if (out.token.subjectId && out.token.subjectId !== player.id) {
      verEvent('security.self_verification_blocked', {
        orgId: inv.orgId,
        subjectId: player.id,
        reason: 'invite recipient mismatch (identity-bound)',
        after: { invite: inv.id },
      });
      return res.status(403).json({
        error: 'INVITE_RECIPIENT_MISMATCH',
        message: 'This invitation names a different recipient. Codes cannot be transferred.',
      });
    }
    // An address-targeted invite: a guardian's verified account e-mail must match. Player accounts carry no e-mail,
    // so an adult confirms the recipient address: address knowledge plus the code, not mailbox re-proof.
    if (out.token.email) {
      const supplied = (guardian ? (guardian.email ?? '') : (claimedEmail ?? '')).trim().toLowerCase();
      if (supplied !== out.token.email) {
        return res.status(403).json({
          error: 'INVITE_RECIPIENT_MISMATCH',
          message: guardian
            ? 'This invitation was addressed to a different guardian email.'
            : 'Confirm the email address the invitation was sent to.',
        });
      }
    }
    const accepted = unit(() => {
      useToken(out.token);
      const next = verification.playerInvites.accept(inv.id, {
        playerId: player.id,
        at: Date.now(),
        guardianId: guardian?.id ?? null,
      });
      verEvent('claim.created', {
        orgId: inv.orgId,
        subjectId: player.id,
        after: { invite: inv.id, guardianApproved: !!guardian },
      });
      notify(
        { kind: 'org_user', id: inv.byUserId },
        'verification',
        `${player.name} accepted your squad invitation${guardian ? ' (guardian-approved)' : ''}.`,
        inv.id,
      );
      return next;
    });
    return res.json({
      invite: accepted,
      note: 'Joining links nothing else: club visibility, contact and consent all still follow the standing safeguarding rules.',
    });
  }
}
