// Live sync over server-sent events. EventSource cannot send headers and bearer tokens must not go in URLs, so a client
// mints a short-lived ticket (POST /events/ticket) and opens GET /events?ticket=…. Missed events replay from a ring
// buffer on reconnect.
import { visibleToOrg } from '../../domain.mjs';
import { audienceFor } from './eventAudience.mjs';
import { minimizePayload } from './eventRegistry.mjs';
import * as v from 'valibot';
import { inputOrRefuse, text, wholeNumberText } from './schemas.mjs';

const TICKET_MAX = 128;
// Clients reconnect with `?ticket=&lastEventId=`; the Last-Event-ID header, when a browser sends it, wins.
const EVENTS_QUERY = v.strictObject({
  ticket: v.optional(text(TICKET_MAX)),
  lastEventId: v.optional(wholeNumberText()),
});

const SSE_TICKET_TTL_MS = 10 * 60 * 1000;
const EVENT_LOG_CAP = 500;

export function createLiveSync({
  app,
  store,
  sessions,
  byId,
  users,
  channels,
  findPlayer,
  isBlocked,
  sessionFor,
  newToken,
}) {
  for (const [name, fn] of Object.entries({ findPlayer, isBlocked, sessionFor, newToken })) {
    if (typeof fn !== 'function') throw new TypeError(`createLiveSync needs ${name}`);
  }
  if (
    typeof sessions?.bySid !== 'function' ||
    typeof channels?.parties !== 'function' ||
    typeof users?.byId !== 'function'
  )
    throw new TypeError('createLiveSync needs the sessions, channels and staff repositories');

  const sseClients = new Set(); // { res, identity }
  const sseTickets = new Map(); // ticket -> { sid, expiresAt }
  let eventSeq = 0;
  const eventLog = []; // ring buffer of { id, event, payload, ts }
  // Counted for /capabilities.
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

  // Authorisation is checked at delivery from live records, so suspension takes effect on open streams.
  function liveOrg(identity) {
    const org = byId.org(identity.orgId);
    return org && !org.suspended ? org : null;
  }

  // Catalogue pings carry no data and go to every stream; the refetch they trigger is authorisation-checked.
  function shouldDeliver(identity, event, payload) {
    const org = identity.kind === 'org' ? liveOrg(identity) : null;
    if (identity.kind === 'org' && !org) return false;
    if (identity.kind === 'org' && identity.userId) {
      const u = byId.user(identity.userId);
      if (!u || u.removedAt) return false;
    }
    if (event === 'typing' || event === 'messages') {
      const channel = channels.parties(payload.channelId);
      if (!channel) return false;
      if (identity.kind === 'org') return channel.orgId === org.id;
      if (identity.kind === 'player')
        return channel.playerId === identity.playerId && channel.counterparty === 'player';
      if (identity.kind === 'guardian') return channel.guardianId === identity.guardianId;
      return false;
    }
    if (event === 'notify') {
      if (identity.kind === 'org')
        return payload.audienceKind === 'org_user' && users.byId(payload.audienceId)?.orgId === org.id;
      if (identity.kind === 'player')
        return payload.audienceKind === 'player' && payload.audienceId === identity.playerId;
      if (identity.kind === 'guardian')
        return payload.audienceKind === 'guardian' && payload.audienceId === identity.guardianId;
      return false;
    }
    // An orgId makes an event private to that club. Checked before the playerId rule, which would deliver it to the
    // subject and to every club that can see them.
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
    // No default of true, so a new payload shape cannot inherit broadcast-to-all; unclassified names fail closed.
    switch (audienceFor(event)) {
      case 'public_safe':
        return true;
      case 'trust_safety_only':
        return identity.kind === 'admin';
      case 'player_private':
        return identity.kind === 'player' || identity.kind === 'guardian';
      case 'guardian_private':
        return identity.kind === 'guardian';
      case 'org_member':
        return identity.kind === 'org';
      case 'org_private':
      default:
        // An org-private event without an orgId is a classification bug; nobody gets it.
        return false;
    }
  }

  function sseFrame(row) {
    return `id: ${row.id}\ndata: ${JSON.stringify({ event: row.event, ...row.payload, ts: row.ts })}\n\n`;
  }

  /**
   * broadcast() without the registry check. notify() runs it after its row commits, so a `notify` frame never
   * refers to a row the database does not hold.
   */
  function publishEvent(event, payload) {
    // A frame about a row the database might still roll back is never sent.
    store.writeRules?.checkOutward(`the live event '${event}'`);
    const row = { id: ++eventSeq, event, payload, ts: Date.now() };
    if (event !== 'typing') {
      // typing is never replayed
      eventLog.push(row);
      if (eventLog.length > EVENT_LOG_CAP) eventLog.splice(0, eventLog.length - EVENT_LOG_CAP);
    }
    for (const client of sseClients) {
      if (!shouldDeliver(client.identity, event, payload)) continue;
      client.res.write(sseFrame(row));
    }
  }

  function broadcast(event, rawPayload = {}) {
    // Unlisted keys are stripped, and throw in development: a new key on a live event is a privacy decision.
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
    // Inside a unit, send after commit (never for a rollback). The check above still runs now, so a bad call site
    // fails the unit.
    if (store.inUnitOfWork?.()) {
      store.afterCommit(() => broadcast(event, rawPayload));
      return;
    }
    publishEvent(event, payload);
  }

  /** On staff removal. */
  function closeStreamsOf(userId) {
    for (const client of [...sseClients]) {
      if (client.identity?.kind === 'org' && client.identity.userId === userId) {
        try {
          client.res.end();
        } catch {
          /* already gone */
        }
        sseClients.delete(client);
      }
    }
  }

  app.post('/events/ticket', (req, res) => {
    if (!inputOrRefuse(res, v.strictObject({}), req.body ?? {})) return;
    const session = sessionFor(req);
    if (!sseIdentityFor(session))
      return res
        .status(401)
        .json({ error: 'AUTH_REQUIRED', message: 'Log in first — live sync is scoped to your account.' });
    for (const [t, v] of sseTickets) if (v.expiresAt < Date.now()) sseTickets.delete(t);
    const ticket = newToken();
    // Holds the session's sid, never a bearer token.
    sseTickets.set(ticket, { sid: session.sid, expiresAt: Date.now() + SSE_TICKET_TTL_MS });
    res.json({ ticket, expiresInMs: SSE_TICKET_TTL_MS });
  });

  app.get('/events', (req, res) => {
    const query = inputOrRefuse(res, EVENTS_QUERY, req.query, { root: 'query' });
    if (!query) return;
    const t = sseTickets.get(query.ticket ?? '');
    if (!t || t.expiresAt < Date.now()) {
      return res
        .status(401)
        .json({ error: 'TICKET_INVALID', message: 'Mint a fresh connect ticket (POST /events/ticket) and reconnect.' });
    }
    // Resolved from the live session, so logout invalidates a ticket within its lifetime.
    const identity = sseIdentityFor(sessions.bySid(t.sid));
    if (!identity)
      return res
        .status(401)
        .json({ error: 'SESSION_INVALID', message: 'Log in again — this session is no longer valid.' });
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ event: 'connected', ts: Date.now() })}\n\n`);
    const lastId = Number(req.headers['last-event-id'] ?? query.lastEventId ?? 0);
    if (lastId > 0) {
      const bufferStart = eventLog.length > 0 ? eventLog[0].id : eventSeq + 1;
      if (lastId > eventSeq || lastId < bufferStart - 1) {
        // A restart reset the ids or the buffer evicted what was missed: the client must refetch everything.
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
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* closing */
      }
    }, 25_000);
    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(client);
    });
  });

  return { broadcast, publishEvent, eventPayloadDrops, closeStreamsOf };
}
