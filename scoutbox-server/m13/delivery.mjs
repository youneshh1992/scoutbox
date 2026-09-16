// F11 — Delivery and response centre.
// Transactional-outbox architecture: db.notifications is the single canonical
// in-app record (the business action happens exactly once). The dispatcher
// creates per-channel dispatch rows AFTER the fact and retries only the
// SENDING — a retry can therefore never duplicate the business action.
// Status ladder (forward-only): queued → accepted → delivered → opened → actioned.
// "delivered"/"opened" are set ONLY from confirmed provider callbacks — email
// acceptance is never reported as read.
import crypto from 'node:crypto';

const RANK = { queued: 0, held_quiet_hours: 0, accepted: 1, delivered: 2, opened: 3, actioned: 4 };

export function registerDelivery(ctx) {
  const {
    db, app, orgRouter, playerRouter, guardianRouter, adminRouter,
    nextId, persist, persistNow, notify, findPlayer, isAdult,
    signBody, timingSafeEq, paginate,
  } = ctx;

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
    // 1. Create dispatch rows for notifications that have none yet.
    const seen = new Set(db.dispatches.map((d) => d.notificationId));
    for (const n of db.notifications) {
      if (seen.has(n.id)) continue;
      const historical = n.ts < db.deliveryCentreSince;
      for (const dest of destinationsFor(n)) {
        if (historical && dest.channel !== 'in_app') { dest.skip = 'predates delivery centre — no retroactive external send'; }
        const hold = dest.channel !== 'in_app' ? quietHoldUntil(n) : null;
        db.dispatches.push({
          id: nextId('dsp'), notificationId: n.id, audience: n.audience,
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
    // 2. Attempt queued/retrying/held external sends that are due.
    for (const d of db.dispatches) {
      if (!['queued', 'retrying', 'held_quiet_hours'].includes(d.status) || d.nextAt > Date.now()) continue;
      if (d.status === 'held_quiet_hours') {
        const n = db.notifications.find((x) => x.id === d.notificationId);
        const stillQuiet = n?.deferredPush && quietHoldUntil(n); // conservative single re-check window
        if (stillQuiet && d.attempts.length === 0) { d.attempts.push({ at: Date.now(), note: 'quiet hours re-check' }); d.nextAt = stillQuiet; changed++; continue; }
      }
      const n = db.notifications.find((x) => x.id === d.notificationId);
      const result = fakeSend(d.channel, d.to, n?.text ?? '');
      d.attempts.push({ at: Date.now(), ok: result.ok, error: result.error ?? null });
      if (result.ok) {
        d.status = 'accepted'; // provider accepted ≠ delivered ≠ read
        d.providerMessageId = result.providerMessageId;
      } else if (d.attempts.filter((a) => !a.note).length >= MAX_ATTEMPTS) {
        d.status = 'failed';
        d.failedAt = Date.now();
        d.failReason = result.error;
        db.opsEvents.push({ id: nextId('ops'), at: Date.now(), kind: 'delivery_failed', detail: { dispatchId: d.id, channel: d.channel } });
        ctx.emitWebhook?.(d.audience.kind === 'org_user' ? (db.users.find((u) => u.id === d.audience.id)?.orgId ?? null) : null, 'delivery.failed', { dispatchId: d.id });
      } else {
        d.status = 'retrying';
        d.nextAt = Date.now() + RETRY_MS[d.attempts.filter((a) => !a.note).length];
      }
      changed++;
    }
    // 3. Mirror in-app reads → opened (meaningfully measured for in_app only).
    for (const d of db.dispatches) {
      if (d.channel === 'in_app' && !d.openedAt) {
        const n = db.notifications.find((x) => x.id === d.notificationId);
        if (n?.read) { d.openedAt = Date.now(); if (RANK[d.status] < RANK.opened) d.status = 'opened'; changed++; }
      }
    }
    if (changed) persistNow();
    return changed;
  }
  ctx.dispatchSweep = dispatchSweep;

  // ------------------------------------------------ action-required notices
  // notifyAction: same canonical notification + an acknowledgement contract.
  function notifyAction(audience, type, text, refId, deadlineMs) {
    const n = notify(audience, type, text, refId);
    n.actionRequired = { deadline: deadlineMs ?? null, ackedAt: null, ackedBy: null };
    persist();
    return n;
  }
  ctx.notifyAction = notifyAction;

  function ackHandler(kind) {
    return (req, res) => {
      const id = kind === 'player' ? req.player.id : kind === 'guardian' ? req.guardian.id : req.orgUser.id;
      const n = db.notifications.find((x) => x.id === req.params.id && x.audience.kind === (kind === 'org_user' ? 'org_user' : kind) && x.audience.id === id);
      if (!n) return res.status(404).json({ error: 'NOTIFICATION_NOT_FOUND' });
      if (!n.actionRequired) return res.status(400).json({ error: 'NO_ACTION_REQUIRED' });
      if (!n.actionRequired.ackedAt) {
        n.actionRequired.ackedAt = Date.now();
        n.actionRequired.ackedBy = id;
        for (const d of db.dispatches.filter((x) => x.notificationId === n.id)) {
          d.actionedAt = Date.now();
          if (RANK[d.status] < RANK.actioned) d.status = 'actioned';
        }
        persistNow();
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
      const d = db.dispatches.find((x) => x.providerMessageId === ev.providerMessageId);
      if (!d) continue;
      if (ev.status === 'delivered') {
        d.deliveredAt ??= Number(ev.at) || Date.now();
        if (RANK[d.status] < RANK.delivered) d.status = 'delivered'; // forward-only: never regresses opened/actioned
      } else if (ev.status === 'opened') {
        d.openedAt ??= Number(ev.at) || Date.now();
        d.deliveredAt ??= d.openedAt; // out-of-order: opened implies delivered
        if (RANK[d.status] < RANK.opened) d.status = 'opened';
      } else if (ev.status === 'bounced' || ev.status === 'failed') {
        // A failure report never un-delivers: recorded alongside, status only
        // moves to failed if nothing better was ever confirmed.
        d.failReason = String(ev.reason ?? ev.status).slice(0, 120);
        if (RANK[d.status] <= RANK.accepted) { d.status = 'failed'; d.failedAt = Date.now(); }
      }
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
    req.orgUser.deliveryPrefs = {
      quietStart: quietStart ?? null, quietEnd: quietEnd ?? null,
      channels: { email: email !== false },
    };
    persistNow();
    res.json({ prefs: req.orgUser.deliveryPrefs });
  });

  adminRouter.get('/delivery', (req, res) => {
    const counts = {};
    for (const d of db.dispatches) counts[d.status] = (counts[d.status] ?? 0) + 1;
    res.json({
      provider: PROVIDER,
      providerNote: 'Local fake provider only — real email/SMS/push transport is not configured; no message leaves this machine.',
      counts,
      awaitingAck: db.notifications.filter((n) => n.actionRequired && !n.actionRequired.ackedAt).length,
      recent: db.dispatches.slice(-100).reverse(),
    });
  });

  adminRouter.post('/delivery/inject-failure', (req, res) => {
    // `contact` (M23 P3) makes the next in-app Contact sends fail at the
    // transport, so the honest `failed` state can be exercised end to end.
    // `trial` (M23 P4B) makes the next Trial invitation, acceptance or
    // completion refuse at the transport with NOTHING written.
    const channel = ['push', 'contact', 'trial'].includes(req.body?.channel) ? req.body.channel : 'email';
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
