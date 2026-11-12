// Transactional outbox: the notification row is the one in-app record, so the business action happens once. The
// dispatcher creates per-channel dispatch rows after the fact and retries only the sending, so a retry never
// duplicates the action. Status is forward-only (queued → accepted → delivered → opened → actioned), and delivered and
// opened come only from confirmed provider callbacks: email acceptance is never reported as read.
import crypto from 'node:crypto';
import { readPage, sendPageError } from '../platform/paging.mjs';
import { timingSafeEqStr as timingSafeEq } from '../identity/totp.mjs';
import { signBody } from '../integrations/webhooks.mjs';
import { messagingInput } from './schemas.mjs';
import { asSweep } from '../../writeRules.mjs';

const RANK = { queued: 0, held_quiet_hours: 0, accepted: 1, delivered: 2, opened: 3, actioned: 4 };

export function registerDelivery(ctx) {
  const {
    byId,
    users,
    notifications,
    dispatches,
    outbox,
    safetyAudit,
    unit,
    app,
    orgRouter,
    playerRouter,
    guardianRouter,
    adminRouter,
    nextId,
    notify,
    findPlayer,
    isAdult,
    operations,
    emitWebhook,
    webhookSweep,
  } = ctx;
  if (!notifications) throw new TypeError('registerDelivery needs the notifications repository (ctx.notifications)');
  if (!dispatches) throw new TypeError('registerDelivery needs the dispatches repository (ctx.dispatches)');
  if (typeof outbox?.append !== 'function')
    throw new TypeError('registerDelivery needs the outbox repository (ctx.outbox)');
  if (typeof operations?.delivery?.markSeen !== 'function')
    throw new TypeError('registerDelivery needs the operations repository (ctx.operations)');
  if (typeof emitWebhook !== 'function' || typeof webhookSweep !== 'function')
    throw new TypeError('registerDelivery needs the webhook emitter and sweep (registerImports)');
  const bookkeeping = operations.delivery;
  const opsEvent = (row) => safetyAudit.opsEvents.record(row);
  // Notifications older than the delivery centre's start get an in-app record only: no retroactive email blast.

  // Real email/SMS/push transport is not configured in this environment.
  const PROVIDER = 'local-fake';
  const CALLBACK_SECRET = process.env.DELIVERY_CALLBACK_SECRET || 'local-fake-callback-secret';
  function fakeSend(channel, to, text) {
    if (bookkeeping.consumeInjectedFailure(channel)) return { ok: false, error: 'injected provider failure' };
    const providerMessageId = `fm_${crypto.randomBytes(8).toString('hex')}`;
    outbox.append({
      id: nextId('mail'),
      at: Date.now(),
      channel,
      to,
      text: String(text).slice(0, 300),
      providerMessageId,
      provider: PROVIDER,
    });
    return { ok: true, providerMessageId };
  }

  // ------------------------------------------------- audience → destinations
  function destinationsFor(n) {
    const a = n.audience;
    const dests = [{ channel: 'in_app', to: `${a.kind}:${a.id}` }]; // always
    if (a.kind === 'player') {
      const p = findPlayer(a.id);
      if (p && !isAdult(p)) {
        // A minor's external channels are the guardian's. The child's in-app record stays.
        dests.push({
          channel: 'email',
          to: null,
          skip: 'guardian_routed — external delivery for under-18s goes to the guardian record',
        });
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
      if (u?.deliveryPrefs?.channels?.email === false)
        dests.push({ channel: 'email', to: null, skip: 'channel disabled by user preference' });
      else dests.push({ channel: 'email', to: u?.email ?? null, skip: u?.email ? undefined : 'no email on record' });
    }
    return dests;
  }

  function quietHoldUntil(n) {
    // If push was deferred at creation, external channels hold for a re-check cycle.
    return n.deferredPush ? Date.now() + (process.env.SCOUTBOX_FAST_SWEEPS === '1' ? 500 : 15 * 60_000) : null;
  }

  const RETRY_MS = process.env.SCOUTBOX_FAST_SWEEPS === '1' ? [0, 300, 600, 900] : [0, 120_000, 900_000, 3_600_000];
  const MAX_ATTEMPTS = RETRY_MS.length;

  // --------------------------------------------------------------- sweeper
  /** A refusal is logged by id and the sweep goes on with the next item. */
  const item = (what, work) => {
    try {
      return unit(work);
    } catch (err) {
      console.error(`delivery sweep: ${what} was not processed (${err?.code ?? err?.message ?? err})`);
      return 0;
    }
  };
  const orgOfAudience = (a) => (a.kind === 'org_user' ? (byId.user(a.id)?.orgId ?? null) : null);
  const shortReason = (v) => (v == null || v === '' ? null : String(v).slice(0, 500));

  function dispatchSweep() {
    let changed = 0;
    // 1. Dispatch every notification without a `dispatched_at` marker (set in the same unit). A notice that already
    //    has dispatches only gets its marker; a refused one keeps none and is retried by the next sweep.
    const centreSince = bookkeeping.centreSince();
    for (
      let afterSeq = 0, batch;
      (batch = notifications.undispatched({ afterSeq })).length;
      afterSeq = batch[batch.length - 1].seq
    ) {
      for (const { notification: n } of batch) {
        changed += item(`notification ${n.id}`, () => {
          const at = Date.now();
          if (dispatches.forNotification(n.id).length) {
            notifications.markDispatched(n.id, { at });
            return 0;
          }
          const historical = n.ts < centreSince;
          const audience = { kind: n.audience.kind, id: n.audience.id };
          const orgId = orgOfAudience(audience);
          let made = 0;
          for (const dest of destinationsFor(n)) {
            if (historical && dest.channel !== 'in_app') {
              dest.skip = 'predates delivery centre — no retroactive external send';
            }
            const hold = dest.channel !== 'in_app' ? quietHoldUntil(n) : null;
            dispatches.create({
              id: nextId('dsp'),
              notificationId: n.id,
              audience,
              orgId,
              channel: dest.channel,
              to: dest.to ?? null,
              provider: dest.channel === 'in_app' ? 'in_app' : PROVIDER,
              status: dest.skip
                ? 'skipped'
                : dest.channel === 'in_app'
                  ? 'delivered'
                  : hold
                    ? 'held_quiet_hours'
                    : 'queued',
              skipReason: dest.skip ?? null,
              providerMessageId: null,
              attempts: [],
              nextAt: hold ?? at,
              actionDeadline: n.actionRequired?.deadline ?? null,
              createdAt: at,
              deliveredAt: dest.channel === 'in_app' ? at : null,
              openedAt: null,
              actionedAt: null,
              failedAt: null,
              failReason: null,
            });
            made++;
          }
          notifications.markDispatched(n.id, { at });
          return made;
        });
      }
    }
    // 2. Attempt the external sends that are due.
    for (const due of dispatches.due(Date.now())) {
      changed += item(`dispatch ${due.id}`, () => {
        const n = notifications.byId(due.notificationId);
        if (due.status === 'held_quiet_hours') {
          const stillQuiet = n?.deferredPush && quietHoldUntil(n); // conservative single re-check window
          if (stillQuiet && due.attempts.length === 0) {
            dispatches.recordAttempt(due.id, { at: Date.now(), note: 'quiet hours re-check' });
            dispatches.patch(due.id, { nextAt: stillQuiet });
            return 1;
          }
        }
        const result = fakeSend(due.channel, due.to, n?.text ?? '');
        const d = dispatches.recordAttempt(due.id, { at: Date.now(), ok: result.ok, error: shortReason(result.error) });
        const sends = d.attempts.filter((a) => !Object.hasOwn(a, 'note')).length; // a quiet re-check note never counts as a send
        if (result.ok) {
          dispatches.patch(d.id, { status: 'accepted', providerMessageId: result.providerMessageId }); // provider accepted ≠ delivered ≠ read
        } else if (sends >= MAX_ATTEMPTS) {
          dispatches.patch(d.id, {
            status: 'failed',
            failedAt: Date.now(),
            failReason: shortReason(result.error) ?? 'provider failure',
          });
          opsEvent({
            id: nextId('ops'),
            at: Date.now(),
            kind: 'delivery_failed',
            detail: { dispatchId: d.id, channel: d.channel },
          });
          emitWebhook(d.orgId, 'delivery.failed', { dispatchId: d.id });
        } else {
          dispatches.patch(d.id, { status: 'retrying', nextAt: Date.now() + RETRY_MS[sends] });
        }
        return 1;
      });
    }
    // 3. Mirror in-app reads → opened (meaningful for in_app only).
    for (const d of dispatches.unopenedInAppRead()) {
      changed += item(`dispatch ${d.id}`, () => {
        const at = Date.now();
        dispatches.patch(d.id, RANK[d.status] < RANK.opened ? { openedAt: at, status: 'opened' } : { openedAt: at });
        return 1;
      });
    }
    return changed;
  }

  // ------------------------------------------------ action-required notices
  // One repository operation writes the notification and its acknowledgement contract. A notification muted by the
  // person's preferences is null here, as from notify().
  function notifyAction(audience, type, text, refId, deadlineMs) {
    const n = notify(audience, type, text, refId, { actionRequired: { deadline: deadlineMs ?? null } });
    if (!n) return null;
    return n;
  }

  function ackHandler(kind) {
    return (req, res) => {
      const id = kind === 'player' ? req.player.id : kind === 'guardian' ? req.guardian.id : req.orgUser.id;
      const audience = { kind: kind === 'org_user' ? 'org_user' : kind, id };
      const n = notifications.byId(req.params.id);
      if (!n || n.audience.kind !== audience.kind || n.audience.id !== audience.id)
        return res.status(404).json({ error: 'NOTIFICATION_NOT_FOUND' });
      if (!n.actionRequired) return res.status(400).json({ error: 'NO_ACTION_REQUIRED' });
      if (!n.actionRequired.ackedAt) {
        // Every dispatch row of the notice gains actionedAt, a terminal skipped row included (it keeps its status).
        unit(() => {
          const at = Date.now();
          const acked = notifications.ack(n.id, audience, { at });
          if (acked.status !== 'ok')
            throw new Error(`notifications: acknowledgment of ${n.id} answered ${acked.status} inside the unit`);
          for (const d of dispatches.forNotification(n.id)) {
            dispatches.patch(
              d.id,
              RANK[d.status] < RANK.actioned ? { actionedAt: at, status: 'actioned' } : { actionedAt: at },
            );
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
  // Signed, idempotent and safe out of order. The fake provider posts here in tests; a real one would use the same
  // contract.
  app.post('/callbacks/delivery', (req, res) => {
    const ts = String(req.headers['x-provider-timestamp'] ?? '');
    const sig = String(req.headers['x-provider-signature'] ?? '');
    const body = JSON.stringify(req.body ?? {});
    if (!ts || Math.abs(Date.now() - Number(ts)) > 5 * 60_000)
      return res.status(401).json({
        error: 'TIMESTAMP_INVALID',
        message: 'Callbacks older than 5 minutes are rejected (replay protection).',
      });
    if (!timingSafeEq(sig, signBody(CALLBACK_SECRET, 'callback', ts, body)))
      return res.status(401).json({ error: 'SIGNATURE_INVALID' });
    // The whole batch is checked before anything is applied; junk is refused naming the field, never skipped or read
    // as "now". `at` omitted or null means now.
    const input = messagingInput(res, 'callback', req.body);
    if (!input) return;
    const events = input.events ?? [];
    let applied = 0,
      duplicates = 0;
    // Each event commits with its seen marker (the newest 5,000 are kept), so a crash can never leave an id remembered
    // and its change lost.
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
          // A failure report never un-delivers: status moves to failed only if nothing better was confirmed.
          patch.failReason = (ev.reason || ev.status).slice(0, 120);
          if (RANK[d.status] <= RANK.accepted) {
            patch.status = 'failed';
            patch.failedAt = Date.now();
          }
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
  // The attempts are shown as outcomes and times.
  const orgDeliveryView = (d) => ({
    id: d.id,
    notificationId: d.notificationId,
    audience: { kind: d.audience.kind, id: d.audience.id },
    orgId: d.orgId,
    channel: d.channel,
    to: d.to,
    provider: d.provider,
    status: d.status,
    skipReason: d.skipReason,
    providerMessageId: d.providerMessageId,
    attempts: d.attempts.map((a) =>
      Object.hasOwn(a, 'note') ? { at: a.at, note: a.note } : { at: a.at, ok: a.ok, error: a.error },
    ),
    nextAt: d.nextAt,
    actionDeadline: d.actionDeadline,
    createdAt: d.createdAt,
    deliveredAt: d.deliveredAt,
    openedAt: d.openedAt,
    actionedAt: d.actionedAt,
    failedAt: d.failedAt,
    failReason: d.failReason,
  });
  orgRouter.get('/delivery', (req, res) => {
    const query = messagingInput(res, 'page', req.query, 'query');
    if (!query) return;
    let page;
    try {
      page = readPage(query, ['number']);
    } catch (e) {
      return sendPageError(res, e);
    }
    const out = dispatches.pageForOrg(req.org.id, page);
    res.json({ items: out.items.map(orgDeliveryView), nextCursor: out.nextCursor });
  });

  orgRouter.put('/delivery/prefs', (req, res) => {
    const body = messagingInput(res, 'staffPrefs', req.body);
    if (!body) return;
    const { quietStart, quietEnd, email } = body;
    const saved = users.update(req.orgUser.id, (d) => {
      d.deliveryPrefs = {
        quietStart: quietStart ?? null,
        quietEnd: quietEnd ?? null,
        channels: { email: email !== false },
      };
    });
    res.json({ prefs: saved.deliveryPrefs });
  });

  adminRouter.get('/delivery', (req, res) => {
    res.json({
      provider: PROVIDER,
      providerNote:
        'Local fake provider only — real email/SMS/push transport is not configured; no message leaves this machine.',
      counts: dispatches.countsByStatus(),
      awaitingAck: notifications.awaitingAckCount(),
      recent: dispatches.recent(100),
    });
  });

  adminRouter.post('/delivery/inject-failure', (req, res) => {
    // `contact`, `trial` and `decision` make the next send of that kind fail at the transport, so the honest failure
    // states can be exercised end to end; `trial` and `decision` refuse with nothing written.
    const body = messagingInput(res, 'injectFailure', req.body);
    if (!body) return;
    const channel = body.channel ?? 'email';
    const count = body.count ?? 1;
    bookkeeping.inject(channel, count);
    res.json({
      injected: { channel, count },
      note: 'The next sends on this channel will fail at the provider — for monitoring/retry tests.',
    });
  });

  adminRouter.post('/delivery/sweep', (req, res) => {
    if (!messagingInput(res, 'none', req.body)) return;
    res.json({ processed: asSweep(dispatchSweep) });
  });

  // Restart-safe: every dispatch row is persisted.
  dispatchSweep();
  const timer = setInterval(
    () => {
      dispatchSweep();
      webhookSweep();
    },
    process.env.SCOUTBOX_FAST_SWEEPS === '1' ? 400 : 60_000,
  );
  timer.unref();
  return { notifyAction };
}
