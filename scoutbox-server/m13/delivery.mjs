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
// S7b: the dispatch rows and their attempts live in the `dispatches` /
// `dispatch_attempts` tables (repositories/dispatches.mjs, migration 0010),
// read here through `db.dispatches` (the repository's read-only view, in
// insertion order) and written through the `dispatches` repository in its
// staged mode: a sweep pass's rows, attempts and status changes land in the
// same snapshot save as the outbox row the fake provider wrote, the
// failure-injection counter it decremented and the ops event / webhook
// delivery intent of an exhausted retry (`persistNow()` below); an
// acknowledgment's status changes land in the unit's commit with the
// notification's contract; a callback's changes land with the
// `deliveryCallbacksSeen` bookkeeping. The ladder's RANK, the retry schedule,
// the destination rules and the callback contract are unchanged.
import crypto from 'node:crypto';

const RANK = { queued: 0, held_quiet_hours: 0, accepted: 1, delivered: 2, opened: 3, actioned: 4 };

export function registerDelivery(ctx) {
  const {
    db, users, notifications, dispatches, unit, app, orgRouter, playerRouter, guardianRouter, adminRouter,
    nextId, persist, persistNow, notify, findPlayer, isAdult,
    signBody, timingSafeEq, paginate,
  } = ctx;
  if (!notifications) throw new TypeError('registerDelivery needs the notifications repository (ctx.notifications)');
  if (!dispatches) throw new TypeError('registerDelivery needs the dispatches repository (ctx.dispatches)');

  db.deliveryFailInject ??= { email: 0, push: 0 }; // admin-injected provider failures (tests/monitoring)
  db.deliveryCentreSince ??= Date.now(); // notifications older than this get an in-app record only — no retroactive email blast on upgrade

  // Local fake provider: deterministic, in-process, honestly labelled.
  // Real email/SMS/push transport is NOT configured in this environment.
  const PROVIDER = 'local-fake';
  const CALLBACK_SECRET = process.env.DELIVERY_CALLBACK_SECRET || 'local-fake-callback-secret';
  function fakeSend(channel, to, text) {
    if (db.deliveryFailInject[channel] > 0) {
      db.deliveryFailInject[channel] -= 1;
      return { ok: false, error: 'injected provider failure' };
    }
    const providerMessageId = `fm_${crypto.randomBytes(8).toString('hex')}`;
    db.outbox.push({ id: nextId('mail'), at: Date.now(), channel, to, text: String(text).slice(0, 300), providerMessageId, provider: PROVIDER });
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
      const g = db.guardians.find((x) => x.id === a.id);
      dests.push({ channel: 'email', to: g?.email ?? null, skip: g?.email ? undefined : 'no email on record' });
    } else if (a.kind === 'org_user') {
      const u = db.users.find((x) => x.id === a.id);
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
  function dispatchSweep() {
    let changed = 0;
    // 1. Create dispatch rows for notifications that have none yet. The row is
    //    the same eighteen-key literal every build since M13 wrote (the
    //    repository validates it and refuses anything else).
    const seen = dispatches.notificationIdsWithRows();
    for (const n of notifications.view) {
      if (seen.has(n.id)) continue;
      const historical = n.ts < db.deliveryCentreSince;
      for (const dest of destinationsFor(n)) {
        if (historical && dest.channel !== 'in_app') { dest.skip = 'predates delivery centre — no retroactive external send'; }
        const hold = dest.channel !== 'in_app' ? quietHoldUntil(n) : null;
        dispatches.create({
          id: nextId('dsp'), notificationId: n.id, audience: { kind: n.audience.kind, id: n.audience.id },
          channel: dest.channel, to: dest.to ?? null, provider: dest.channel === 'in_app' ? 'in_app' : PROVIDER,
          status: dest.skip ? 'skipped' : dest.channel === 'in_app' ? 'delivered' : hold ? 'held_quiet_hours' : 'queued',
          skipReason: dest.skip ?? null, providerMessageId: null,
          attempts: [], nextAt: hold ?? Date.now(),
          actionDeadline: n.actionRequired?.deadline ?? null,
          createdAt: Date.now(), deliveredAt: dest.channel === 'in_app' ? Date.now() : null,
          openedAt: null, actionedAt: null, failedAt: null, failReason: null,
        });
        changed++;
      }
      seen.add(n.id);
    }
    // 2. Attempt queued/retrying/held external sends that are due. `d` is the
    //    repository's view of the row, so `d.attempts` shows the attempt just
    //    recorded, exactly as the array did before S7b.
    for (const d of db.dispatches) {
      if (!['queued', 'retrying', 'held_quiet_hours'].includes(d.status) || d.nextAt > Date.now()) continue;
      if (d.status === 'held_quiet_hours') {
        const n = notifications.byId(d.notificationId);
        const stillQuiet = n?.deferredPush && quietHoldUntil(n); // conservative single re-check window
        if (stillQuiet && d.attempts.length === 0) { dispatches.recordAttempt(d.id, { at: Date.now(), note: 'quiet hours re-check' }); dispatches.patch(d.id, { nextAt: stillQuiet }); changed++; continue; }
      }
      const n = notifications.byId(d.notificationId);
      const result = fakeSend(d.channel, d.to, n?.text ?? '');
      dispatches.recordAttempt(d.id, { at: Date.now(), ok: result.ok, error: result.error ?? null });
      const sends = d.attempts.filter((a) => !a.note).length; // a quiet re-check note never counts as a send
      if (result.ok) {
        dispatches.patch(d.id, { status: 'accepted', providerMessageId: result.providerMessageId }); // provider accepted ≠ delivered ≠ read
      } else if (sends >= MAX_ATTEMPTS) {
        dispatches.patch(d.id, { status: 'failed', failedAt: Date.now(), failReason: result.error });
        db.opsEvents.push({ id: nextId('ops'), at: Date.now(), kind: 'delivery_failed', detail: { dispatchId: d.id, channel: d.channel } });
        ctx.emitWebhook?.(d.audience.kind === 'org_user' ? (db.users.find((u) => u.id === d.audience.id)?.orgId ?? null) : null, 'delivery.failed', { dispatchId: d.id });
      } else {
        dispatches.patch(d.id, { status: 'retrying', nextAt: Date.now() + RETRY_MS[sends] });
      }
      changed++;
    }
    // 3. Mirror in-app reads → opened (meaningfully measured for in_app only).
    for (const d of db.dispatches) {
      if (d.channel === 'in_app' && !d.openedAt) {
        const n = notifications.byId(d.notificationId);
        if (n?.read) { dispatches.patch(d.id, RANK[d.status] < RANK.opened ? { openedAt: Date.now(), status: 'opened' } : { openedAt: Date.now() }); changed++; }
      }
    }
    if (changed) persistNow();
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
      res.json({ ok: true, ackedAt: n.actionRequired.ackedAt });
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
    const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 100) : [];
    let applied = 0, duplicates = 0;
    for (const ev of events) {
      const cbId = String(ev.callbackId ?? '');
      if (!cbId) continue;
      if (db.deliveryCallbacksSeen.includes(cbId)) { duplicates++; continue; } // idempotent
      db.deliveryCallbacksSeen.push(cbId);
      if (db.deliveryCallbacksSeen.length > 5000) db.deliveryCallbacksSeen.splice(0, 1000);
      // The lookup every build since M13 made: the FIRST row in insertion order
      // whose providerMessageId strictly equals the event's (an explicit null
      // matches the first null row; an omitted id matches nothing — but the
      // callbackId was still remembered above).
      const d = dispatches.byProviderMessageId(ev.providerMessageId);
      if (!d) continue;
      // The clock a callback carries, as every build since M13 read it:
      // `Number(ev.at) || Date.now()` — a finite value, fractional or not, is
      // kept EXACTLY (the table column is the writer's double); a non-finite
      // value (Infinity from a string such as "Infinity") is recorded as null,
      // which is what the JSON save of the previous build persisted for it.
      // The callback API is unchanged.
      const clock = () => { const at = Number(ev.at) || Date.now(); return Number.isFinite(at) ? at : null; };
      const patch = {};
      if (ev.status === 'delivered') {
        if (d.deliveredAt == null) patch.deliveredAt = clock(); // nullish assignment: an existing clock is kept
        if (RANK[d.status] < RANK.delivered) patch.status = 'delivered'; // forward-only: never regresses opened/actioned
      } else if (ev.status === 'opened') {
        if (d.openedAt == null) patch.openedAt = clock();
        if (d.deliveredAt == null) patch.deliveredAt = Object.hasOwn(patch, 'openedAt') ? patch.openedAt : d.openedAt; // out-of-order: opened implies delivered
        if (RANK[d.status] < RANK.opened) patch.status = 'opened';
      } else if (ev.status === 'bounced' || ev.status === 'failed') {
        // A failure report never un-delivers: recorded alongside, status only
        // moves to failed if nothing better was ever confirmed.
        patch.failReason = String(ev.reason ?? ev.status).slice(0, 120);
        if (RANK[d.status] <= RANK.accepted) { patch.status = 'failed'; patch.failedAt = Date.now(); }
      }
      if (Object.keys(patch).length) dispatches.patch(d.id, patch);
      applied++;
    }
    persistNow();
    res.json({ applied, duplicates });
  });

  // ------------------------------------------------------------------ views
  orgRouter.get('/delivery', (req, res) => {
    const mine = db.dispatches.filter((d) => d.audience.kind === 'org_user' && db.users.some((u) => u.id === d.audience.id && u.orgId === req.org.id));
    res.json(paginate(req, mine.slice().reverse()));
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
      recent: db.dispatches.slice(-100).reverse(),
    });
  });

  adminRouter.post('/delivery/inject-failure', (req, res) => {
    // `contact` (M23 P3) makes the next in-app Contact sends fail at the
    // transport, so the honest `failed` state can be exercised end to end.
    // `trial` (M23 P4B) makes the next Trial invitation, acceptance or
    // completion refuse at the transport with NOTHING written.
    // `decision` (M23 P5) makes the next formal decision finalize refuse
    // before anything is written.
    const channel = ['push', 'contact', 'trial', 'decision'].includes(req.body?.channel) ? req.body.channel : 'email';
    const count = Math.min(Math.max(Number(req.body?.count) || 1, 1), 20);
    db.deliveryFailInject[channel] = (db.deliveryFailInject[channel] ?? 0) + count;
    persistNow();
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
