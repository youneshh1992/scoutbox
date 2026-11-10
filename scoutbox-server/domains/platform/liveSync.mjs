// Live sync: authenticated, scoped server-sent events. EventSource cannot send headers and long-lived bearer tokens
// never belong in URLs, so a client first mints a short-lived connect ticket over its bearer session
// (POST /events/ticket), then opens GET /events?ticket=…. Every event carries an id; on reconnect the client passes the
// last id it saw and missed events replay from a ring buffer, so a dropped connection catches up instead of going quiet.
import { visibleToOrg } from '../../domain.mjs';
import { audienceFor } from './eventAudience.mjs';
import { minimizePayload } from './eventRegistry.mjs';

const SSE_TICKET_TTL_MS = 10 * 60 * 1000;
const EVENT_LOG_CAP = 500;

export function createLiveSync({ app, store, sessions, byId, users, channels, findPlayer, isBlocked, sessionFor, newToken }) {
  for (const [name, fn] of Object.entries({ findPlayer, isBlocked, sessionFor, newToken })) {
    if (typeof fn !== 'function') throw new TypeError(`createLiveSync needs ${name}`);
  }
  if (typeof sessions?.bySid !== 'function' || typeof channels?.parties !== 'function' || typeof users?.byId !== 'function') throw new TypeError('createLiveSync needs the sessions, channels and staff repositories');

  const sseClients = new Set(); // { res, identity }
  const sseTickets = new Map(); // ticket -> { sid, expiresAt }
  let eventSeq = 0;
  const eventLog = []; // ring buffer of { id, event, payload, ts }
  // Payloads the registry did not allow, counted for /capabilities.
  const eventPayloadDrops = { count: 0, lastEvent: null };

  function sseIdentityFor(session) {
    if (!session) return null;
    if (session.kind === 'org') {
      const org = byId.org(session.refId);
      return org && !org.suspended ? { kind: 'org', orgId: org.id, userId: session.userId } : null;
    }
    if (session.kind === 'player') {
      const p = findPlayer(session.refId);
      return p ? { kind: 'player', playerId: p.id } : null;
    }
    if (session.kind === 'guardian') {
      const g = byId.guardian(session.refId);
      return g ? { kind: 'guardian', guardianId: g.id } : null;
    }
    return null;
  }

  // Authorisation happens at DELIVERY time, from live records: an identity captured at connect never grandfathers a
  // suspended org or a lifted entitlement into continuing to receive events.
  function liveOrg(identity) {
    const org = byId.org(identity.orgId);
    return org && !org.suspended ? org : null;
  }

  // Channel and player events reach only the parties entitled to them. Catalogue events without a payload (orgs, open
  // days, friendlies, bare refresh pings) carry no data and go to every authenticated stream; the refetch they trigger
  // is itself authorisation-checked.
  function shouldDeliver(identity, event, payload) {
    // A suspended or deleted org's open stream goes silent immediately, catalogue pings included.
    const org = identity.kind === 'org' ? liveOrg(identity) : null;
    if (identity.kind === 'org' && !org) return false;
    if (identity.kind === 'org' && identity.userId) {
      // Staff removal takes effect on open streams too, not just reconnects.
      const u = byId.user(identity.userId);
      if (!u || u.removedAt) return false;
    }
    if (event === 'typing' || event === 'messages') {
      const channel = channels.parties(payload.channelId);
      if (!channel) return false;
      if (identity.kind === 'org') return channel.orgId === org.id;
      if (identity.kind === 'player') return channel.playerId === identity.playerId && channel.counterparty === 'player';
      if (identity.kind === 'guardian') return channel.guardianId === identity.guardianId;
      return false;
    }
    if (event === 'notify') {
      if (identity.kind === 'org') return payload.audienceKind === 'org_user' && users.byId(payload.audienceId)?.orgId === org.id;
      if (identity.kind === 'player') return payload.audienceKind === 'player' && payload.audienceId === identity.playerId;
      if (identity.kind === 'guardian') return payload.audienceKind === 'guardian' && payload.audienceId === identity.guardianId;
      return false;
    }
    // An event carrying an orgId is ORGANISATION-PRIVATE: it goes to that club's own streams and to nobody else, not
    // the player it names, not their guardian, not a rival club that can see the player. Checked BEFORE the playerId
    // rule below, which would otherwise deliver it to the subject.
    if (payload.orgId) {
      return identity.kind === 'org' && org.id === payload.orgId;
    }
    if (payload.playerId) {
      const p = findPlayer(payload.playerId);
      if (!p) return false;
      if (identity.kind === 'player') return p.id === identity.playerId;
      if (identity.kind === 'guardian') return p.guardianId === identity.guardianId;
      return visibleToOrg(p, org) && !isBlocked(p.id, org.id);
    }
    // Nothing falls through to "deliver to everyone": a default of true would let the NEXT event with a new payload
    // shape inherit broadcast-to-all. The audience is declared per event name, and an unclassified name fails closed.
    switch (audienceFor(event)) {
      case 'public_safe': return true;
      case 'trust_safety_only': return identity.kind === 'admin';
      case 'player_private': return identity.kind === 'player' || identity.kind === 'guardian';
      case 'guardian_private': return identity.kind === 'guardian';
      case 'org_member': return identity.kind === 'org';
      case 'org_private':
      default:
        // An organisation-private event that did not name its organisation is a classification bug. Nobody gets it.
        return false;
    }
  }

  function sseFrame(row) {
    return `id: ${row.id}\ndata: ${JSON.stringify({ event: row.event, ...row.payload, ts: row.ts })}\n\n`;
  }

  /**
   * Write one already-minimised event to the replay log and the live streams: the transport half of broadcast(), with
   * no registry check. notify() registers it as an afterCommit effect of the row it wrote, so a `notify` frame is never
   * on a stream or in the replay log for a row the database does not hold.
   */
  function publishEvent(event, payload) {
    const row = { id: ++eventSeq, event, payload, ts: Date.now() };
    if (event !== 'typing') {
      // typing is transient by design: never buffered, never replayed
      eventLog.push(row);
      if (eventLog.length > EVENT_LOG_CAP) eventLog.splice(0, eventLog.length - EVENT_LOG_CAP);
    }
    for (const client of sseClients) {
      if (!shouldDeliver(client.identity, event, payload)) continue;
      client.res.write(sseFrame(row));
    }
  }

  function broadcast(event, rawPayload = {}) {
    // The registry is the only authority on what an event may carry. A key it does not list is stripped before
    // anything reaches a stream or the replay log, and in development it throws: a new key on a live event is a
    // privacy decision somebody has to make on purpose.
    const { payload, dropped, unregistered } = minimizePayload(event, rawPayload);
    if (unregistered || dropped.length) {
      eventPayloadDrops.count += 1;
      eventPayloadDrops.lastEvent = event;
      const msg = unregistered
        ? `broadcast('${event}') is not in the event registry`
        : `broadcast('${event}') carried unregistered payload keys: ${dropped.join(', ')}`;
      if ((process.env.NODE_ENV ?? 'development') !== 'production') throw new Error(msg);
      console.error(`EVENT ${msg} — stripped`);
    }
    // Inside a unit of work the change is not committed yet: the event goes out once COMMIT returned, and never for a
    // rolled-back operation. The registry check above still runs now, so a bad call site fails the unit.
    if (store.inUnitOfWork?.()) { store.afterCommit(() => broadcast(event, rawPayload)); return; }
    publishEvent(event, payload);
  }

  /** Close every open stream of one staff member (their removal). */
  function closeStreamsOf(userId) {
    for (const client of [...sseClients]) {
      if (client.identity?.kind === 'org' && client.identity.userId === userId) {
        try { client.res.end(); } catch { /* already gone */ }
        sseClients.delete(client);
      }
    }
  }

  app.post('/events/ticket', (req, res) => {
    const session = sessionFor(req);
    if (!sseIdentityFor(session)) return res.status(401).json({ error: 'AUTH_REQUIRED', message: 'Log in first — live sync is scoped to your account.' });
    for (const [t, v] of sseTickets) if (v.expiresAt < Date.now()) sseTickets.delete(t);
    const ticket = newToken();
    // The ticket names the session by its sid; no bearer token is held anywhere.
    sseTickets.set(ticket, { sid: session.sid, expiresAt: Date.now() + SSE_TICKET_TTL_MS });
    res.json({ ticket, expiresInMs: SSE_TICKET_TTL_MS });
  });

  app.get('/events', (req, res) => {
    const t = sseTickets.get(String(req.query.ticket ?? ''));
    if (!t || t.expiresAt < Date.now()) {
      return res.status(401).json({ error: 'TICKET_INVALID', message: 'Mint a fresh connect ticket (POST /events/ticket) and reconnect.' });
    }
    // Identity resolves at connect time from the live session, so logout or suspension invalidates streams even inside
    // a ticket's lifetime.
    const identity = sseIdentityFor(sessions.bySid(t.sid)); // live sessions only
    if (!identity) return res.status(401).json({ error: 'SESSION_INVALID', message: 'Log in again — this session is no longer valid.' });
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ event: 'connected', ts: Date.now() })}\n\n`);
    const lastId = Number(req.headers['last-event-id'] ?? req.query.lastEventId ?? 0);
    if (lastId > 0) {
      const bufferStart = eventLog.length > 0 ? eventLog[0].id : eventSeq + 1;
      if (lastId > eventSeq || lastId < bufferStart - 1) {
        // The server restarted (ids reset) or the buffer evicted what was missed: never drop updates silently, tell
        // the client to refetch everything.
        res.write(`data: ${JSON.stringify({ event: 'resync', ts: Date.now() })}\n\n`);
      } else {
        for (const row of eventLog) {
          if (row.id > lastId && shouldDeliver(identity, row.event, row.payload)) res.write(sseFrame(row));
        }
        res.write(`data: ${JSON.stringify({ event: 'caught_up', ts: Date.now() })}\n\n`);
      }
    }
    const client = { res, identity };
    sseClients.add(client);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closing */ } }, 25_000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(client); });
  });

  return { broadcast, publishEvent, eventPayloadDrops, closeStreamsOf };
}
