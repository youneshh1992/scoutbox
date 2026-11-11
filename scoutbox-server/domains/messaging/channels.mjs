// A channel is the only conversation surface, and it exists only because a request was accepted. For a minor the
// counterparty is the guardian; the child is never in the thread. Every message is moderated and logged.
import { MESSAGE_LIMITS } from '../../repositories/channels.mjs';
import { readPage, sendPageError } from '../platform/paging.mjs';
import { visibleToOrg } from '../../domain.mjs';
import { filled, presentOrRefuse } from '../platform/schemas.mjs';
import { messagingInput } from './schemas.mjs';

// Names have no limit at sign-up: a thread keeps them shortened, never refused.
const threadName = (v) => (typeof v === 'string' ? v.slice(0, MESSAGE_LIMITS.name) : v);

// Allowlists: the organisation's id only for the organisation itself, the guardian's id never.
const attachmentView = (a) =>
  a === null
    ? null
    : a.kind === 'clip'
      ? { kind: 'clip', mediaId: a.mediaId, title: a.title, url: a.url, verifiedClip: a.verifiedClip }
      : { kind: 'trial_report', reportId: a.reportId, orgName: a.orgName, summary: a.summary };
export function messageView(m) {
  return {
    id: m.id,
    ts: m.ts,
    sender: { kind: m.sender.kind, id: m.sender.id, name: m.sender.name },
    text: m.text,
    attachment: attachmentView(m.attachment),
    ...(m.clientMsgId !== undefined ? { clientMsgId: m.clientMsgId } : {}),
  };
}
export function channelViewFor(c, viewer) {
  return {
    id: c.id,
    requestId: c.requestId,
    playerId: c.playerId,
    playerName: c.playerName,
    ...(viewer === 'org' ? { orgId: c.orgId } : {}),
    orgName: c.orgName,
    orgVerified: c.orgVerified,
    scoutName: c.scoutName,
    scoutRole: c.scoutRole,
    counterparty: c.counterparty,
    createdAt: c.createdAt,
    lastActivityAt: c.lastActivityAt,
    messages: c.messages.map(messageView),
    readBy: { org: c.readBy.org, counterparty: c.readBy.counterparty },
  };
}

/** Returns `{ openChannel }` for the acceptance routes, which open the thread inside their own unit. */
export function registerMessaging({
  orgRouter,
  playerRouter,
  guardianRouter,
  channels,
  recruitment,
  byId,
  isBlocked,
  unit,
  nextId,
  notify,
  broadcast,
  ledgerAppend,
  moderateOrRefuse,
  guardianManagedOnly,
}) {
  if (typeof channels?.appendMessage !== 'function' || typeof unit !== 'function')
    throw new TypeError('registerMessaging needs the channels repository and unit from the data layer');

  function openChannel(request) {
    return channels.open({
      id: nextId('chan'),
      requestId: request.id,
      playerId: request.playerId,
      playerName: threadName(request.playerName),
      orgId: request.orgId,
      orgName: threadName(request.orgName),
      orgVerified: request.orgVerified,
      scoutName: threadName(request.scoutName),
      scoutRole: threadName(request.scoutRole),
      counterparty: request.routedTo, // 'player' | 'guardian'
      guardianId: request.guardianId,
      createdAt: Date.now(),
      messages: [],
      readBy: { org: null, counterparty: null },
    });
  }

  function buildAttachment(channel, body, senderSide) {
    const { attachMediaId, attachTrialReportId } = body || {};
    if (!attachMediaId && !attachTrialReportId) return { ok: true, attachment: null };
    const player = byId.player(channel.playerId);
    if (attachMediaId) {
      const m = player?.media.find((x) => x.id === attachMediaId);
      if (!m) return { ok: false, error: 'MEDIA_NOT_FOUND' };
      return {
        ok: true,
        attachment: { kind: 'clip', mediaId: m.id, title: m.title, url: m.url, verifiedClip: !!m.verifiedClip },
      };
    }
    const r = player?.trialReports.find(
      (x) => x.id === attachTrialReportId && (senderSide !== 'org' || x.orgId === channel.orgId),
    );
    if (!r) return { ok: false, error: 'TRIAL_REPORT_NOT_FOUND' };
    return {
      ok: true,
      attachment: {
        kind: 'trial_report',
        reportId: r.id,
        orgName: r.orgName,
        summary: `accel ${r.acceleration}/10 · ${r.sprintSpeedKmh} km/h · ${r.distanceKm} km · pass ${r.passCompletionPct}% · duels ${r.duelSuccessPct}% · coach ${r.coachRating}/10`,
      },
    };
  }

  /** Null once a 400 has been sent. Junk is refused, never cut. */
  function messageInput(req, res) {
    const body = messagingInput(res, 'message', req.body);
    if (!body) return null;
    const text = filled(body.text);
    if (!presentOrRefuse(res, text, 'text')) return null;
    return { ...body, text, clientMsgId: body.clientMsgId || null };
  }

  function postMessage(channel, rawSender, text, attachment = null, clientMsgId = null) {
    const sender = { ...rawSender, name: threadName(rawSender.name) };
    // A retried send with the same client id returns the message that already landed.
    const dup = clientMsgId ? channels.byClientMsgId(channel.id, sender, clientMsgId) : null;
    if (dup) return messageView(dup);
    const msg = unit(() => {
      const stored = channels.appendMessage(channel.id, {
        id: nextId('msg'),
        ts: Date.now(),
        sender,
        text,
        attachment,
        ...(clientMsgId ? { clientMsgId } : {}),
      });
      ledgerAppend({
        type: 'message',
        playerId: channel.playerId,
        orgId: channel.orgId,
        orgName: channel.orgName,
        userId: sender.kind === 'org_user' ? sender.id : null,
        scoutName: sender.name,
      });
      const recipient =
        channel.counterparty === 'guardian'
          ? { kind: 'guardian', id: channel.guardianId }
          : { kind: 'player', id: channel.playerId };
      if (sender.kind !== 'org_user') {
        // Every staff member who has written in the thread, and the one who sent the request.
        const userIds = new Set(channels.staffSenders(channel.id));
        const req = recruitment.requests.byId(channel.requestId);
        if (req) userIds.add(req.userId);
        for (const uid of userIds) {
          if (uid)
            notify(
              { kind: 'org_user', id: uid },
              'message',
              `${sender.name} replied in the ${channel.playerName} thread.`,
              channel.id,
            );
        }
      } else if (recipient.id) {
        notify(recipient, 'message', `${channel.orgName} (${channel.scoutRole}) sent a message.`, channel.id);
      }
      return stored;
    });
    broadcast('messages', { channelId: channel.id });
    return messageView(msg);
  }

  const orgThread = (req) => {
    const c = channels.byId(req.params.id);
    return c && c.orgId === req.org.id ? c : null;
  };
  const guardianThread = (req) => {
    const c = channels.byId(req.params.id);
    return c && c.guardianId === req.guardian.id ? c : null;
  };
  const playerThread = (req) => {
    const c = channels.byId(req.params.id);
    return c && c.playerId === req.player.id && c.counterparty === 'player' ? c : null;
  };

  // Standing is rechecked on every use: a block, a suspension, or the player leaving the club's platform closes the
  // thread; the history stays for audit.
  function channelClosedForOrg(channel, org) {
    const p = byId.player(channel.playerId);
    if (!p) return { error: 'CHANNEL_CLOSED', message: 'This player account no longer exists.' };
    if (isBlocked(p.id, org.id))
      return { error: 'BLOCKED', message: 'This player (or their guardian) has blocked your organisation.' };
    if (!visibleToOrg(p, org))
      return {
        error: 'CHANNEL_CLOSED',
        message:
          'This player is no longer available to your organisation — the thread is closed (history retained for audit).',
      };
    return null;
  }
  function channelClosedForCounterparty(channel, playerId) {
    const org = byId.org(channel.orgId);
    if (!org) return { error: 'CHANNEL_CLOSED', message: 'This organisation no longer exists.' };
    if (org.suspended)
      return {
        error: 'ORG_SUSPENDED',
        message: 'This organisation is suspended pending a safety review — the thread is paused.',
      };
    if (isBlocked(playerId, org.id))
      return {
        error: 'BLOCKED',
        message: 'You have blocked this organisation. Lift the block to continue the conversation.',
      };
    return null;
  }

  const send = (req, res, channel, closed, { kind, side, sender }) => {
    if (closed) return res.status(403).json(closed);
    const input = messageInput(req, res);
    if (!input) return;
    if (!moderateOrRefuse(res, input.text, { kind, channelId: channel.id })) return;
    const att = buildAttachment(channel, input, side);
    if (!att.ok) return res.status(400).json({ error: att.error });
    res.status(201).json(postMessage(channel, sender, input.text, att.attachment, input.clientMsgId));
  };
  const markRead = (req, res, channel, side) => {
    if (!messagingInput(res, 'none', req.body)) return;
    const readBy = channels.markRead(channel.id, side, Date.now());
    broadcast('messages', { channelId: channel.id });
    res.json({ readBy: { org: readBy.org, counterparty: readBy.counterparty } });
  };
  const typing = (req, res, channel, side) => {
    if (!messagingInput(res, 'none', req.body)) return;
    broadcast('typing', { channelId: channel.id, side });
    res.json({ ok: true });
  };
  const notFound = (res) => res.status(404).json({ error: 'CHANNEL_NOT_FOUND' });

  // ------------------------------------------------------------ club staff
  // `playerId` limits the page to one player's threads (a Room's inbox panel).
  orgRouter.get('/channels', (req, res) => {
    const query = messagingInput(res, 'channelsQuery', req.query, 'query');
    if (!query) return;
    let page;
    try {
      page = readPage(query, ['number', 'number']);
    } catch (e) {
      return sendPageError(res, e);
    }
    const { playerId } = query;
    const out = channels.pageForOrg(req.org.id, { playerId: playerId ?? null }, page);
    res.json({
      items: out.items.map((c) => ({ ...channelViewFor(c, 'org'), closed: !!channelClosedForOrg(c, req.org) })),
      nextCursor: out.nextCursor,
    });
  });
  // Messages from players and guardians since the club last opened each thread.
  orgRouter.get('/channels/counts', (req, res) => res.json(channels.countsForOrg(req.org.id)));
  orgRouter.post('/channels/:id/messages', (req, res) => {
    const channel = orgThread(req);
    if (!channel) return notFound(res);
    send(req, res, channel, channelClosedForOrg(channel, req.org), {
      kind: 'org_message',
      side: 'org',
      sender: {
        kind: 'org_user',
        id: req.orgUser.id,
        name: `${req.orgUser.name} · ${req.orgUser.role || 'Scout'} · ${req.org.name}`,
      },
    });
  });
  orgRouter.post('/channels/:id/read', (req, res) => {
    const channel = orgThread(req);
    if (!channel) return notFound(res);
    markRead(req, res, channel, 'org');
  });
  orgRouter.post('/channels/:id/typing', (req, res) => {
    const channel = orgThread(req);
    if (!channel) return notFound(res);
    if (channelClosedForOrg(channel, req.org)) return res.status(403).json({ error: 'CHANNEL_CLOSED' });
    typing(req, res, channel, 'org');
  });

  // -------------------------------------------------------- adult players
  playerRouter.get('/channels', (req, res) => {
    if (req.playerIsMinor) return res.json([]); // a child's threads live with the guardian
    res.json(channels.forPlayer(req.player.id, { counterparty: 'player' }).map((c) => channelViewFor(c, 'player')));
  });
  playerRouter.post('/channels/:id/messages', (req, res) => {
    if (guardianManagedOnly(req, res)) return;
    const channel = playerThread(req);
    if (!channel) return notFound(res);
    send(req, res, channel, channelClosedForCounterparty(channel, req.player.id), {
      kind: 'player_message',
      side: 'player',
      sender: { kind: 'player', id: req.player.id, name: req.player.name },
    });
  });
  playerRouter.post('/channels/:id/read', (req, res) => {
    if (guardianManagedOnly(req, res)) return;
    const channel = playerThread(req);
    if (!channel) return notFound(res);
    markRead(req, res, channel, 'counterparty');
  });
  playerRouter.post('/channels/:id/typing', (req, res) => {
    if (guardianManagedOnly(req, res)) return;
    const channel = playerThread(req);
    if (!channel) return notFound(res);
    typing(req, res, channel, 'counterparty');
  });

  // ------------------------------------------------------------- guardians
  guardianRouter.get('/channels', (req, res) => {
    res.json(channels.forGuardian(req.guardian.id).map((c) => channelViewFor(c, 'guardian')));
  });
  guardianRouter.post('/channels/:id/messages', (req, res) => {
    const channel = guardianThread(req);
    if (!channel) return notFound(res);
    send(req, res, channel, channelClosedForCounterparty(channel, channel.playerId), {
      kind: 'guardian_message',
      side: 'guardian',
      sender: { kind: 'guardian', id: req.guardian.id, name: req.guardian.name },
    });
  });
  guardianRouter.post('/channels/:id/read', (req, res) => {
    const channel = guardianThread(req);
    if (!channel) return notFound(res);
    markRead(req, res, channel, 'counterparty');
  });
  guardianRouter.post('/channels/:id/typing', (req, res) => {
    const channel = guardianThread(req);
    if (!channel) return notFound(res);
    typing(req, res, channel, 'counterparty');
  });

  return { openChannel };
}
