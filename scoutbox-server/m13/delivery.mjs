// F11 — Delivery and response centre.
// Transactional-outbox architecture: the notifications table (S7a,
// repositories/notifications.mjs, read here through the `notifications`
// repository) is the single canonical in-app record (the business action
// happens exactly once). The dispatcher creates per-channel dispatch rows
// AFTER the fact and retries only the SENDING — a retry can therefore never
// duplicate the business action.
// Status ladder (forward-only): queued → accepted → delivered → opened → actioned.
// "delivered"/"opened" are set ONLY from confirmed provider callbacks — email
// acceptance is never reported as read.
//
// S14d: the dispatches and their attempts (repositories/dispatches.mjs) and the
// fake provider's outbox record (repositories/outboxPush.mjs) are explicit writes
// and SQL reads. A notification's dispatches are created in one unit of work; each
// send — its attempt, its status, the outbox row, the injected failure it used and,
// when the retries run out, the ops event and the webhook intent — is one unit; a
// provider callback event commits with its seen marker; an acknowledgment with the
// notification's contract. The ladder's RANK, the retry schedule, the destination
// rules and the callback contract are unchanged.
import crypto from 'node:crypto';
import { readPage, sendPageError } from '../domains/platform/paging.mjs';

const RANK = { queued: 0, held_quiet_hours: 0, accepted: 1, delivered: 2, opened: 3, actioned: 4 };

export function registerDelivery(ctx) {
  const {
    byId, users, notifications, dispatches, outbox, safetyAudit, unit, app, orgRouter, playerRouter, guardianRouter, adminRouter,
    nextId, persist, persistNow, notify, findPlayer, isAdult,
    signBody, timingSafeEq, operations,
  } = ctx;
  if (!notifications) throw new TypeError('registerDelivery needs the notifications repository (ctx.notifications)');
  if (!dispatches) throw new TypeError('registerDelivery needs the dispatches repository (ctx.dispatches)');
  if (typeof outbox?.append !== 'function') throw new TypeError('registerDelivery needs the outbox repository (ctx.outbox)');
  if (typeof operations?.delivery?.markSeen !== 'function') throw new TypeError('registerDelivery needs the operations repository (ctx.operations, S13e)');
  // S13e: the callback ids applied, the instant the delivery centre started and the injected failures are rows of
  // repositories/operations.mjs (delivery_callbacks_seen, delivery_centre, delivery_fail_injections), written explicitly.
  const bookkeeping = operations.delivery;
  // An exhausted retry's ops event is a row of ops_events (repositories/safetyAudit.mjs), written at once
  // (in the sweep's unit of work when one is open).
  const opsEvent = (row) => safetyAudit.opsEvents.record(row);
  // Notifications older than the delivery centre's start (written by migration 0038) get an in-app record only — no
  // retroactive email blast; admin-injected provider failures (tests/monitoring) are used up one send at a time.

  // Local fake provider: deterministic, in-process, honestly labelled.
  // Real email/SMS/push transport is NOT configured in this environment.
  const PROVIDER = 'local-fake';
  const CALLBACK_STATUSES = ['delivered', 'opened', 'bounced', 'failed'];
  const CALLBACK_SECRET = process.env.DELIVERY_CALLBACK_SECRET || 'local-fake-callback-secret';
  function fakeSend(channel, to, text) {
    if (bookkeeping.consumeInjectedFailure(channel)) return { ok: false, error: 'injected provider failure' };
    const providerMessageId = `fm_${crypto.randomBytes(8).toString('hex')}`;
    // The delivery record is an outbox row, written in the send's unit with the dispatch's attempt and status.
    outbox.append({ id: nextId('mail'), at: Date.now(), channel, to, text: String(text).slice(0, 300), providerMessageId, provider: PROVIDER });
    return { ok: true, providerMessageId };
  }

  // ------------------------------------------------- audience → destinations
  function destinationsFor(n) {
    const a = n.audience;
    const dests = [{ channel: 'in_app', to: `${a.kind}:${a.id}` }]; // canonical, always
    if (a.kind === 'player') {
      const p = findPlayer(a.id);
      if (p && !isAdult(p)) {
        // Guardian-approved destinations only: a minor's external channels are
        // the guardian's. The child's in-app record stays (contentless flows
        // are handled at notification-creation time by the M12 rules).
        dests.push({ channel: 'email', to: null, skip: 'guardian_routed — external delivery for under-18s goes to the guardian record' });
      } else if (p?.email) {
        dests.push({ channel: 'email', to: p.email });
      } else {
        dests.push({ channel: 'email', to: null, skip: 'no email on record' });
      }
    } else if (a.kind === 'guardian') {
      const g = byId.guardian(a.id);
      dests.push({ channel: 'email', to: g?.email ?? null, skip: g?.email ? undefined : 'no email on record' });
    } else if (a.kind === 'org_user') {
      const u = byId.user(a.id);
      if (u?.deliveryPrefs?.channels?.email === false) dests.push({ channel: 'email', to: null, skip: 'channel disabled by user preference' });
      else dests.push({ channel: 'email', to: u?.email ?? null, skip: u?.email ? undefined : 'no email on record' });
    }
    return dests;
  }

  function quietHoldUntil(n) {
    // Reuses the pushDeferred decision recorded on the notification: if push
    // was deferred at creation, external channels hold for a re-check cycle.
    return n.deferredPush ? Date.now() + (process.env.M13_FAST_RETRY === '1' ? 500 : 15 * 60_000) : null;
  }

  const RETRY_MS = process.env.M13_FAST_RETRY === '1'
    ? [0, 300, 600, 900]
    : [0, 120_000, 900_000, 3_600_000];
  const MAX_ATTEMPTS = RETRY_MS.length;

  // --------------------------------------------------------------- sweeper
  /** One sweep item in its own unit of work; a refusal is logged by id and the sweep goes on with the next item. */
  const item = (what, work) => {
    try { return unit(work); } catch (err) { console.error(`delivery sweep: ${what} was not processed (${err?.code ?? err?.message ?? err})`); return 0; }
  };
  /** The organisation of a staff audience (null for a player, a guardian or a staff member who no longer exists). */
  const orgOfAudience = (a) => (a.kind === 'org_user' ? byId.user(a.id)?.orgId ?? null : null);
  const shortReason = (v) => (v == null || v === '' ? null : String(v).slice(0, 500));

  function dispatchSweep() {
    let changed = 0;
    // 1. Create the dispatches of every notification the centre has not dispatched yet (the `dispatched_at` marker,
    //    set in the same unit): one unit per notification. A notice that already has dispatches only gets its marker.
    //    A refused one keeps no marker and is tried again by the next sweep.
    const centreSince = bookkeeping.centreSince();
    for (let afterSeq = 0, batch; (batch = notifications.undispatched({ afterSeq })).length; afterSeq = batch[batch.length - 1].seq) {
      for (const { notification: n } of batch) {
        changed += item(`notification ${n.id}`, () => {
          const at = Date.now();
          if (dispatches.forNotification(n.id).length) { notifications.markDispatched(n.id, { at }); return 0; }
          const historical = n.ts < centreSince;
          const audience = { kind: n.audience.kind, id: n.audience.id };
          const orgId = orgOfAudience(audience);
          let made = 0;
          for (const dest of destinationsFor(n)) {
            if (historical && dest.channel !== 'in_app') { dest.skip = 'predates delivery centre — no retroactive external send'; }
            const hold = dest.channel !== 'in_app' ? quietHoldUntil(n) : null;
            dispatches.create({
              id: nextId('dsp'), notificationId: n.id, audience, orgId,
              channel: dest.channel, to: dest.to ?? null, provider: dest.channel === 'in_app' ? 'in_app' : PROVIDER,
              status: dest.skip ? 'skipped' : dest.channel === 'in_app' ? 'delivered' : hold ? 'held_quiet_hours' : 'queued',
              skipReason: dest.skip ?? null, providerMessageId: null,
              attempts: [], nextAt: hold ?? at,
              actionDeadline: n.actionRequired?.deadline ?? null,
              createdAt: at, deliveredAt: dest.channel === 'in_app' ? at : null,
              openedAt: null, actionedAt: null, failedAt: null, failReason: null,
            });
            made++;
          }
          notifications.markDispatched(n.id, { at });
          return made;
        });
      }
    }
    // 2. Attempt the external sends that are due: one unit per dispatch, holding everything the send wrote.
    for (const due of dispatches.due(Date.now())) {
      changed += item(`dispatch ${due.id}`, () => {
        const n = notifications.byId(due.notificationId);
        if (due.status === 'held_quiet_hours') {
          const stillQuiet = n?.deferredPush && quietHoldUntil(n); // conservative single re-check window
          if (stillQuiet && due.attempts.length === 0) { dispatches.recordAttempt(due.id, { at: Date.now(), note: 'quiet hours re-check' }); dispatches.patch(due.id, { nextAt: stillQuiet }); return 1; }
        }
        const result = fakeSend(due.channel, due.to, n?.text ?? '');
        const d = dispatches.recordAttempt(due.id, { at: Date.now(), ok: result.ok, error: shortReason(result.error) });
        const sends = d.attempts.filter((a) => !Object.hasOwn(a, 'note')).length; // a quiet re-check note never counts as a send
        if (result.ok) {
          dispatches.patch(d.id, { status: 'accepted', providerMessageId: result.providerMessageId }); // provider accepted ≠ delivered ≠ read
        } else if (sends >= MAX_ATTEMPTS) {
          dispatches.patch(d.id, { status: 'failed', failedAt: Date.now(), failReason: shortReason(result.error) ?? 'provider failure' });
          opsEvent({ id: nextId('ops'), at: Date.now(), kind: 'delivery_failed', detail: { dispatchId: d.id, channel: d.channel } });
          ctx.emitWebhook?.(d.orgId, 'delivery.failed', { dispatchId: d.id });
        } else {
          dispatches.patch(d.id, { status: 'retrying', nextAt: Date.now() + RETRY_MS[sends] });
        }
        return 1;
      });
    }
    // 3. Mirror in-app reads → opened (meaningfully measured for in_app only).
    for (const d of dispatches.unopenedInAppRead()) {
      changed += item(`dispatch ${d.id}`, () => { const at = Date.now(); dispatches.patch(d.id, RANK[d.status] < RANK.opened ? { openedAt: at, status: 'opened' } : { openedAt: at }); return 1; });
    }
    return changed;
  }
  ctx.dispatchSweep = dispatchSweep;

  // ------------------------------------------------ action-required notices
  // notifyAction: same canonical notification + an acknowledgement contract,
  // written in ONE repository operation (S7a: `notify` passes the contract
  // through to the create or the coalesce, so the row and its contract are
  // never two writes). A notification the person's preferences mute is null
  // here as it is from notify(); the caller gets null, never a crash.
  function notifyAction(audience, type, text, refId, deadlineMs) {
    const n = notify(audience, type, text, refId, { actionRequired: { deadline: deadlineMs ?? null } });
    if (!n) return null;
    persist();
    return n;
  }
  ctx.notifyAction = notifyAction;

  function ackHandler(kind) {
    return (req, res) => {
      const id = kind === 'player' ? req.player.id : kind === 'guardian' ? req.guardian.id : req.orgUser.id;
      const audience = { kind: kind === 'org_user' ? 'org_user' : kind, id };
      const n = notifications.byId(req.params.id);
      if (!n || n.audience.kind !== audience.kind || n.audience.id !== audience.id) return res.status(404).json({ error: 'NOTIFICATION_NOT_FOUND' });
      if (!n.actionRequired) return res.status(400).json({ error: 'NO_ACTION_REQUIRED' });
      if (!n.actionRequired.ackedAt) {
        // S7a/S7b: the acknowledgment on the notification row and the dispatch
        // rows' status changes (every row of the notice, a terminal skipped row
        // included — it keeps its status and gains actionedAt) commit together
        // or not at all: both repositories join this unit.
        unit(() => {
          const at = Date.now();
          const acked = notifications.ack(n.id, audience, { at });
          if (acked.status !== 'ok') throw new Error(`notifications: acknowledgment of ${n.id} answered ${acked.status} inside the unit`);
          for (const d of dispatches.forNotification(n.id)) {
            dispatches.patch(d.id, RANK[d.status] < RANK.actioned ? { actionedAt: at, status: 'actioned' } : { actionedAt: at });
          }
        });
      }
      res.json({ ok: true, ackedAt: notifications.byId(n.id).actionRequired.ackedAt });
    };
  }
  playerRouter.post('/notifications/:id/ack', ackHandler('player'));
  guardianRouter.post('/notifications/:id/ack', ackHandler('guardian'));
  orgRouter.post('/notifications/:id/ack', ackHandler('org_user'));

  // ------------------------------------------------------ provider callbacks
  // Signed, idempotent, out-of-order-safe. The fake provider posts here in
  // tests; a real provider integration would use the same contract.
  app.post('/callbacks/delivery', (req, res) => {
    const ts = String(req.headers['x-provider-timestamp'] ?? '');
    const sig = String(req.headers['x-provider-signature'] ?? '');
    const body = JSON.stringify(req.body ?? {});
    if (!ts || Math.abs(Date.now() - Number(ts)) > 5 * 60_000) return res.status(401).json({ error: 'TIMESTAMP_INVALID', message: 'Callbacks older than 5 minutes are rejected (replay protection).' });
    if (!timingSafeEq(sig, signBody(CALLBACK_SECRET, 'callback', ts, body))) return res.status(401).json({ error: 'SIGNATURE_INVALID' });
    // S14d: the whole batch is checked before anything is applied; junk is refused naming the field, never skipped or
    // read as "now". An event is { callbackId (1–200 characters), providerMessageId (text), status (delivered, opened,
    // bounced or failed), at (a whole-number timestamp; omitted or null means now), reason (text, optional) }.
    const events = req.body?.events ?? [];
    const invalid = (field, message) => res.status(400).json({ error: 'FIELD_INVALID', field, message });
    if (!Array.isArray(events)) return invalid('events', 'events is a list of delivery events.');
    if (events.length > 100) return invalid('events', 'A callback carries at most 100 events.');
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]; const f = (k) => `events[${i}]${k ? `.${k}` : ''}`;
      if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) return invalid(f(), 'An event is an object.');
      if (typeof ev.callbackId !== 'string' || ev.callbackId.length < 1 || ev.callbackId.length > 200) return invalid(f('callbackId'), 'A callback id is 1 to 200 characters.');
      if (typeof ev.providerMessageId !== 'string' || ev.providerMessageId.length < 1 || ev.providerMessageId.length > 200) return invalid(f('providerMessageId'), 'A provider message id is 1 to 200 characters.');
      if (!CALLBACK_STATUSES.includes(ev.status)) return invalid(f('status'), `status is one of ${CALLBACK_STATUSES.join(', ')}.`);
      if (ev.at != null && !(Number.isSafeInteger(ev.at) && ev.at > 0)) return invalid(f('at'), 'at is a whole-number timestamp in milliseconds.');
      if (ev.reason != null && typeof ev.reason !== 'string') return invalid(f('reason'), 'reason is text.');
    }
    let applied = 0, duplicates = 0;
    // Each event commits with its seen marker (a row of delivery_callbacks_seen; the newest 5,000 are kept), so a
    // crash can never leave an id remembered and its change lost.
    for (const ev of events) {
      const outcome = unit(() => {
        if (!bookkeeping.markSeen(ev.callbackId, Date.now())) return 'duplicate'; // idempotent
        const d = dispatches.byProviderMessageId(ev.providerMessageId);
        if (!d) return 'unknown'; // the id is still remembered
        const clock = ev.at ?? Date.now();
        const patch = {};
        if (ev.status === 'delivered') {
          if (d.deliveredAt == null) patch.deliveredAt = clock; // an existing clock is kept
          if (RANK[d.status] < RANK.delivered) patch.status = 'delivered'; // forward-only: never regresses opened/actioned
        } else if (ev.status === 'opened') {
          if (d.openedAt == null) patch.openedAt = clock;
          if (d.deliveredAt == null) patch.deliveredAt = patch.openedAt ?? d.openedAt; // out-of-order: opened implies delivered
          if (RANK[d.status] < RANK.opened) patch.status = 'opened';
        } else {
          // A failure report never un-delivers: recorded alongside, status only
          // moves to failed if nothing better was ever confirmed.
          patch.failReason = (ev.reason || ev.status).slice(0, 120);
          if (RANK[d.status] <= RANK.accepted) { patch.status = 'failed'; patch.failedAt = Date.now(); }
        }
        dispatches.patch(d.id, patch);
        return 'applied';
      });
      if (outcome === 'duplicate') duplicates++;
      else if (outcome === 'applied') applied++;
    }
    res.json({ applied, duplicates });
  });

  // ------------------------------------------------------------------ views
  // S14d: a club's staff dispatches, newest first, paged by cursor (an index on the dispatch's organisation). The view
  // is an allowlist: the fields the club's delivery screen had, the attempts as outcomes and times.
  const orgDeliveryView = (d) => ({
    id: d.id, notificationId: d.notificationId, audience: { kind: d.audience.kind, id: d.audience.id }, orgId: d.orgId, channel: d.channel, to: d.to,
    provider: d.provider, status: d.status, skipReason: d.skipReason, providerMessageId: d.providerMessageId,
    attempts: d.attempts.map((a) => (Object.hasOwn(a, 'note') ? { at: a.at, note: a.note } : { at: a.at, ok: a.ok, error: a.error })),
    nextAt: d.nextAt, actionDeadline: d.actionDeadline, createdAt: d.createdAt, deliveredAt: d.deliveredAt, openedAt: d.openedAt,
    actionedAt: d.actionedAt, failedAt: d.failedAt, failReason: d.failReason,
  });
  orgRouter.get('/delivery', (req, res) => {
    let page;
    try { page = readPage(req.query, ['number']); } catch (e) { return sendPageError(res, e); }
    const out = dispatches.pageForOrg(req.org.id, page);
    res.json({ items: out.items.map(orgDeliveryView), nextCursor: out.nextCursor });
  });

  orgRouter.put('/delivery/prefs', (req, res) => {
    const { quietStart, quietEnd, email } = req.body ?? {};
    // PRE-M24 (PM-10): quiet hours are HH:MM or absent — an object was stored and read back as a time.
    const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
    for (const [f, v] of [['quietStart', quietStart], ['quietEnd', quietEnd]]) if (v != null && !(typeof v === 'string' && HHMM.test(v))) return res.status(400).json({ error: 'FIELD_INVALID', field: f, message: `${f} is a time written HH:MM.` });
    users.update(req.orgUser.id, {
      deliveryPrefs: {
        quietStart: quietStart ?? null, quietEnd: quietEnd ?? null,
        channels: { email: email !== false },
      },
    });
    persistNow();
    res.json({ prefs: req.orgUser.deliveryPrefs });
  });

  adminRouter.get('/delivery', (req, res) => {
    res.json({
      provider: PROVIDER,
      providerNote: 'Local fake provider only — real email/SMS/push transport is not configured; no message leaves this machine.',
      counts: dispatches.countsByStatus(),
      awaitingAck: notifications.awaitingAckCount(),
      recent: dispatches.recent(100),
    });
  });

  adminRouter.post('/delivery/inject-failure', (req, res) => {
    // `contact` (M23 P3) makes the next in-app Contact sends fail at the
    // transport, so the honest `failed` state can be exercised end to end.
    // `trial` (M23 P4B) makes the next Trial invitation, acceptance or
    // completion refuse at the transport with NOTHING written.
    // `decision` (M23 P5) makes the next formal decision finalize refuse
    // before anything is written.
    // S13e: junk is refused, not read as `email` or clamped: the channel is one of the five (default email), the count a
    // whole number from 1 to 20 (default 1).
    const channel = req.body?.channel ?? 'email';
    const count = req.body?.count ?? 1;
    if (!['email', 'push', 'contact', 'trial', 'decision'].includes(channel)) return res.status(400).json({ error: 'FIELD_INVALID', field: 'channel', message: 'channel is email, push, contact, trial or decision.' });
    if (!Number.isSafeInteger(count) || count < 1 || count > 20) return res.status(400).json({ error: 'FIELD_INVALID', field: 'count', message: 'count is a whole number from 1 to 20.' });
    bookkeeping.inject(channel, count);
    res.json({ injected: { channel, count }, note: 'The next sends on this channel will fail at the provider — for monitoring/retry tests.' });
  });

  adminRouter.post('/delivery/sweep', (_req, res) => {
    res.json({ processed: dispatchSweep() });
  });

  // Boot + interval — restart-safe because every dispatch row is persisted.
  dispatchSweep();
  const timer = setInterval(() => { dispatchSweep(); ctx.webhookSweep?.(); }, process.env.M13_FAST_RETRY === '1' ? 400 : 60_000);
  timer.unref();
}
