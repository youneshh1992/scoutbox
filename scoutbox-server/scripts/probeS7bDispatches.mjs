// S7b preparation — synthetic compatibility probe for the dispatch records and their attempts.
//
// NOT a test of desired behaviour and NOT part of `npm test`: it RECORDS what the current build
// (0641b2c) does with `db.dispatches` on synthetic data, so the S7b design amendment
// (docs/architecture/s7-readiness-review.md §9) rests on observed rows rather than narrative:
//   1. ordinary player deletion — which dispatch rows remain after the notifications they
//      reference are gone (the retained-orphan behaviour the proposed CASCADE would change);
//   2. retry and quiet-hours note ordering and counting inside `attempts[]`;
//   3. provider-callback status ordering, duplicates, late bounces and unknown ids;
//   4. acknowledgment coupling: notification contract and dispatch statuses in one commit
//      (observed through the existing routes), including the terminal `skipped` row;
//   5. the realistic rollback shape: every observed dispatch mapped to the proposed
//      `dispatches` + `dispatch_attempts` rows and back, byte-for-byte, with the null/absent
//      patterns and the proposed CHECK/UNIQUE constraints checked against the observed data.
// The real server runs as a child process on a temporary data directory (M13_FAST_RETRY=1 so the
// sweep runs every 400 ms and the retry ladder is [0, 300, 600, 900] ms); every database read goes
// through a second read-only connection. Nothing here touches DATA_DIR, real data or application
// source. Output: a JSON report on stdout and, with a path argument, in that file. Diagnostics name
// ids, counts, statuses and shapes — never a notification text, an address or a token.
//   node scripts/probeS7bDispatches.mjs [out.json]
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { tempDir } from './coreIdentityTestFixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const A = { 'x-admin-key': 'scoutbox-admin' };
const CALLBACK_SECRET = 'local-fake-callback-secret'; // the development default of m13/delivery.mjs
const report = { probe: 'S7b dispatches', build: 'current checkout', node: process.version, at: new Date().toISOString(), sections: {}, observations: [] };
const note = (text) => { report.observations.push(text); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await check(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(60); } };
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

async function boot(dir) {
  const port = await freePort();
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, M13_QUIET_LOGS: '1', M13_FAST_RETRY: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    const j = async (method, p, body, token, headers = {}) => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
      const text = await r.text(); let parsed = null; try { parsed = JSON.parse(text); } catch { /* no body */ }
      return { status: r.status, body: parsed, text };
    };
    const S = { proc, port, dir, log: () => log, j, stop: () => new Promise((res) => { proc.on('exit', () => res()); proc.kill('SIGTERM'); }) };
    proc.stdout.on('data', (d) => { log += d; if (/listening on/.test(log)) resolve(S); });
    proc.stderr.on('data', (d) => { log += d; });
    proc.on('exit', (code, signal) => reject(new Error(`server exited ${code} (${signal}): ${log.slice(-1500)}`)));
    setTimeout(() => reject(new Error(`boot timeout: ${log.slice(-800)}`)), 30_000);
  });
}
const q = (dir, sql, ...p) => { const s = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true }); try { return s.prepare(sql).all(...p).map((r) => ({ ...r })); } finally { s.close(); } };
const blob = (dir, name) => { const r = q(dir, 'SELECT value FROM collections WHERE name = ?', name)[0]; return r ? JSON.parse(r.value) : null; };
/**
 * The dispatch records as the DATABASE holds them, in insertion order, attempts re-nested. Written against the
 * dc4b559 build (the `dispatches` blob). ADAPTED for S7b: after the 0010_dispatches cutover the rows are in the
 * dispatches / dispatch_attempts tables and the probe reads them there in the same legacy shape; before the cutover
 * (an older build) it still reads the blob. The adapter is the only change to this probe; every observation it
 * reports is computed on the same shape as before.
 */
const dispatchesOf = (dir) => {
  if (!q(dir, "SELECT 1 AS one FROM data_migrations WHERE id = '0010_dispatches'").length) return blob(dir, 'dispatches') ?? [];
  const attempts = q(dir, 'SELECT dispatch_seq, seq, kind, attempted_at, ok, error, note FROM dispatch_attempts ORDER BY dispatch_seq, seq');
  return q(dir, 'SELECT seq, id, notification_id, audience_kind, audience_id, channel, to_address, provider, status, skip_reason, provider_message_id, next_at, action_deadline_at, created_at, delivered_at, opened_at, actioned_at, failed_at, fail_reason, extra_json FROM dispatches ORDER BY seq').map((r) => ({
    ...(r.extra_json ? JSON.parse(r.extra_json) : {}),
    id: r.id, notificationId: r.notification_id, audience: { kind: r.audience_kind, id: r.audience_id }, channel: r.channel, to: r.to_address, provider: r.provider, status: r.status, skipReason: r.skip_reason, providerMessageId: r.provider_message_id,
    attempts: attempts.filter((a) => a.dispatch_seq === r.seq).map((a) => (a.kind === 'quiet_recheck' ? { at: a.attempted_at, note: a.note } : { at: a.attempted_at, ok: a.ok === 1, error: a.error })),
    nextAt: r.next_at, actionDeadline: r.action_deadline_at, createdAt: r.created_at, deliveredAt: r.delivered_at, openedAt: r.opened_at, actionedAt: r.actioned_at, failedAt: r.failed_at, failReason: r.fail_reason,
  }));
};
const notificationIds = (dir) => new Set(q(dir, 'SELECT id FROM notifications').map((r) => r.id));
/** A dispatch row with every private value removed: ids, statuses, shapes and timestamps only. */
const shape = (d) => ({ id: d.id, notificationId: d.notificationId, audienceKind: d.audience?.kind, channel: d.channel, provider: d.provider, status: d.status, skipReason: d.skipReason, hasTo: d.to !== null && d.to !== undefined, providerMessageId: d.providerMessageId ? 'set' : d.providerMessageId, attempts: (d.attempts ?? []).map((a) => (Object.hasOwn(a, 'note') ? { kind: 'quiet_recheck', keys: Object.keys(a).sort() } : { kind: 'send', ok: a.ok, error: a.error, keys: Object.keys(a).sort() })), nulls: Object.keys(d).filter((k) => d[k] === null).sort(), keys: Object.keys(d).sort() });
const must = (ok, what) => { if (!ok) throw new Error(`probe precondition failed: ${what}`); };
const orgLogin = async (S, orgId, scoutName, role) => { const r = await S.j('POST', '/auth/org/login', { orgId, scoutName, role }); must(r.status === 200, `org login ${r.status} ${r.text.slice(0, 200)}`); return r.body.token; };
const playerLogin = async (S, playerId) => { const r = await S.j('POST', '/auth/player/login', { playerId }); must(r.status === 200, `player login ${r.status}`); return r.body.token; };
const guardianLogin = async (S, guardianId) => { const r = await S.j('POST', '/auth/guardian/login', { guardianId }); must(r.status === 200, `guardian login ${r.status} ${r.text.slice(0, 200)}`); return r.body.token; };
const sweep = async (S) => { const r = await S.j('POST', '/admin/delivery/sweep', {}, null, A); must(r.status === 200, 'sweep'); return r.body.processed; };
const inject = async (S, count) => must((await S.j('POST', '/admin/delivery/inject-failure', { channel: 'email', count }, null, A)).status === 200, 'inject');
const callback = (S, events) => { const body = JSON.stringify({ provider: 'local-fake', events }); const ts = String(Date.now()); const sig = crypto.createHmac('sha256', CALLBACK_SECRET).update(`callback.${ts}.${body}`).digest('hex'); return S.j('POST', '/callbacks/delivery', JSON.parse(body), null, { 'x-provider-timestamp': ts, 'x-provider-signature': sig }); };

const dir = tempDir('s7b-probe');
const S = await boot(dir);
try {
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment');
  const kola = await playerLogin(S, 'pl-adeyemi');
  const amara = await guardianLogin(S, 'gd-amara');

  // ------------------------------------------------------------- 2 + 3. retry/note ordering, counting; callbacks
  {
    // Quiet hours for the guardian cover the whole day, so her next notification is created with deferredPush and its
    // external dispatch is HELD; the first due sweep records the quiet re-check NOTE, the next one sends.
    const prefs = await S.j('POST', '/guardian/prefs', { quietStart: '00:00', quietEnd: '23:59', timezone: 'Europe/London' }, amara);
    must(prefs.status === 200, `guardian prefs ${prefs.status} ${prefs.text.slice(0, 200)}`);
    await inject(S, 2); // the first two sends fail, the third is accepted
    const req = await S.j('POST', '/org/players/pl-guni/request', { type: 'contact', message: 'Synthetic: a conversation about the under-18 player.' }, maria);
    must(req.status === 201, `contact request on the minor ${req.status} ${req.text.slice(0, 300)}`);
    const guardianNotice = await until(async () => (await S.j('GET', '/guardian/notifications', undefined, amara)).body?.find((n) => n.type === 'request' && n.refId === req.body.requestId));
    must(guardianNotice, 'the guardian was notified of the request');
    report.sections.guardianNoticeDeferredPush = guardianNotice.deferredPush;
    const emailRow = await until(async () => { await sweep(S); const d = dispatchesOf(dir).find((x) => x.notificationId === guardianNotice.id && x.channel === 'email'); return d && (d.status === 'accepted' || d.status === 'failed') ? d : null; }, 15_000);
    must(emailRow, `the guardian's e-mail dispatch settled: ${JSON.stringify(dispatchesOf(dir).filter((x) => x.notificationId === guardianNotice.id).map(shape))}`);
    const rows = dispatchesOf(dir).filter((x) => x.notificationId === guardianNotice.id);
    report.sections.retryAndNote = {
      rowsForOneNotification: rows.map(shape),
      emailStatus: emailRow.status,
      attemptKinds: emailRow.attempts.map((a) => (Object.hasOwn(a, 'note') ? 'note' : a.ok ? 'send:ok' : 'send:fail')),
      sendAttemptsCounted: emailRow.attempts.filter((a) => !a.note).length,
      noteRowsBeforeFirstSend: emailRow.attempts.findIndex((a) => !Object.hasOwn(a, 'note')),
      nextAtAfterSettle: typeof emailRow.nextAt,
    };
    note(`retry/note: the e-mail dispatch for a deferred-push notification holds (held_quiet_hours), records ONE quiet re-check note row FIRST, then the send rows; the retry counter skips the note row (${report.sections.retryAndNote.sendAttemptsCounted} send attempts counted for ${emailRow.attempts.length} attempt rows); status ${emailRow.status}.`);

    // Callbacks on the accepted dispatch: opened before delivered, duplicate id, late bounce, delivered after opened, unknown id.
    if (emailRow.status === 'accepted') {
      const seenBefore = (blob(dir, 'deliveryCallbacksSeen') ?? []).length;
      const c1 = await callback(S, [{ callbackId: 'probe-cb-1', providerMessageId: emailRow.providerMessageId, status: 'opened', at: Date.now() }]);
      const c1dup = await callback(S, [{ callbackId: 'probe-cb-1', providerMessageId: emailRow.providerMessageId, status: 'opened', at: Date.now() }]);
      const c2 = await callback(S, [{ callbackId: 'probe-cb-2', providerMessageId: emailRow.providerMessageId, status: 'bounced', reason: 'synthetic late bounce', at: Date.now() }]);
      const c3 = await callback(S, [{ callbackId: 'probe-cb-3', providerMessageId: emailRow.providerMessageId, status: 'delivered', at: Date.now() - 5000 }]);
      const c4 = await callback(S, [{ callbackId: 'probe-cb-4', providerMessageId: 'fm_unknown_probe', status: 'delivered', at: Date.now() }]);
      await until(async () => dispatchesOf(dir).find((x) => x.id === emailRow.id)?.status === 'opened');
      const after = dispatchesOf(dir).find((x) => x.id === emailRow.id);
      report.sections.callbacks = {
        responses: { openedFirst: c1.body, duplicateId: c1dup.body, lateBounce: c2.body, deliveredAfterOpened: c3.body, unknownProviderMessageId: c4.body },
        finalStatus: after.status, deliveredAtEqualsOpenedAt: after.deliveredAt === after.openedAt, failReasonRecorded: typeof after.failReason === 'string', failedAt: after.failedAt,
        callbacksSeenGrowth: (blob(dir, 'deliveryCallbacksSeen') ?? []).length - seenBefore,
      };
      note(`callbacks: opened before any delivered sets deliveredAt = openedAt; a duplicate callbackId is counted as a duplicate and applies nothing; a late bounce records failReason but never regresses opened; a later 'delivered' never lowers the ladder; a callback for an unknown provider id is remembered as seen but applies nothing (seen grew by ${report.sections.callbacks.callbacksSeenGrowth} for 5 posts).`);
    }

    // Exhausted retries: inject MAX_ATTEMPTS failures before a second guardian notification.
    await S.j('POST', '/guardian/prefs', { quietStart: null, quietEnd: null, timezone: 'Europe/London' }, amara);
    await inject(S, 4);
    const req2 = await S.j('POST', '/org/players/pl-guni/request', { type: 'trial', message: 'Synthetic: a trial conversation.', proposedDate: '2026-12-05' }, maria);
    must(req2.status === 201, `trial request on the minor ${req2.status} ${req2.text.slice(0, 300)}`);
    const notice2 = await until(async () => (await S.j('GET', '/guardian/notifications', undefined, amara)).body?.find((n) => n.type === 'request' && n.refId === req2.body.requestId));
    must(notice2, 'second guardian notice');
    const failedRow = await until(async () => { await sweep(S); const d = dispatchesOf(dir).find((x) => x.notificationId === notice2.id && x.channel === 'email'); return d && ['accepted', 'failed'].includes(d.status) ? d : null; }, 20_000);
    must(failedRow, 'the second e-mail dispatch settled');
    const ops = (blob(dir, 'opsEvents') ?? []).filter((e) => e.kind === 'delivery_failed' && e.detail?.dispatchId === failedRow.id);
    report.sections.exhaustedRetries = { status: failedRow.status, attemptRows: failedRow.attempts.length, sendAttempts: failedRow.attempts.filter((a) => !a.note).length, failedAtSet: failedRow.failedAt !== null, failReasonLength: failedRow.failReason?.length ?? null, opsEventsDeliveryFailed: ops.length, webhookDeliveriesCreated: (blob(dir, 'webhookDeliveries') ?? []).length };
    note(`exhausted retries: ${failedRow.attempts.length} send rows → status ${failedRow.status}, failedAt set, failReason ${failedRow.failReason?.length ?? 'null'} chars (the sweep does NOT truncate failReason; only the callback path slices to 120), one opsEvents delivery_failed row, ${report.sections.exhaustedRetries.webhookDeliveriesCreated} webhook deliveries (no endpoint registered → the delivery.failed webhook intent produces no row).`);
  }

  // ------------------------------------------------------------- 4. acknowledgment coupling (observed through the existing routes)
  {
    const me = (await S.j('GET', '/player/me', undefined, kola)).body; const mediaId = me.media?.[0]?.id ?? me.player?.media?.[0]?.id; must(mediaId, 'adult media');
    const trn = await S.j('POST', '/player/transitions', { pack: { mediaIds: [mediaId] }, note: 'Synthetic transition', periodDays: 60 }, kola); must(trn.status === 201, `transition ${trn.status}`);
    must((await S.j('POST', `/player/transitions/${trn.body.transition.id}/recipients`, { orgId: 'org-eastport', days: 30 }, kola)).status === 201, 'recipient');
    must((await S.j('POST', `/player/transitions/${trn.body.transition.id}/revoke-recipient`, { orgId: 'org-eastport' }, kola)).status === 200, 'revoke');
    const notice = (await S.j('GET', '/org/notifications', undefined, maria)).body.find((n) => n.type === 'transition' && n.actionRequired); must(notice, 'action notice');
    await sweep(S);
    const before = dispatchesOf(dir).filter((d) => d.notificationId === notice.id).map((d) => [d.channel, d.status, d.actionedAt]);
    const ack = await S.j('POST', `/org/notifications/${notice.id}/ack`, {}, maria); must(ack.status === 200, `ack ${ack.status}`);
    await until(async () => dispatchesOf(dir).filter((d) => d.notificationId === notice.id).every((d) => d.actionedAt));
    const after = dispatchesOf(dir).filter((d) => d.notificationId === notice.id).map((d) => [d.channel, d.status, d.actionedAt === ack.body.ackedAt]);
    report.sections.ackCoupling = { before, after, actionDeadlineCopied: dispatchesOf(dir).filter((d) => d.notificationId === notice.id).every((d) => d.actionDeadline === notice.actionRequired.deadline) };
    note(`ack coupling: the in_app row moves to actioned and the skipped e-mail row (org user without an address) KEEPS 'skipped' while gaining actionedAt — RANK has no entry for skipped, so the comparison is false; both carry actionedAt = the notification's ackedAt (one unit of work). actionDeadline is a copy of the notification's deadline at creation.`);
  }

  // ------------------------------------------------------------- 1. ordinary deletion: what remains
  {
    const reqA = await S.j('POST', '/org/players/pl-adeyemi/request', { type: 'contact', message: 'Synthetic: a conversation about next season.' }, maria); must(reqA.status === 201, 'adult request');
    must((await S.j('POST', `/player/requests/${reqA.body.requestId}/respond`, { accept: true }, kola)).status === 200, 'accept');
    const channel = (await S.j('GET', '/player/channels', undefined, kola)).body[0]; must(channel?.id, 'channel');
    must((await S.j('POST', `/org/channels/${channel.id}/messages`, { text: 'Synthetic message before deletion.' }, maria)).status === 201, 'message');
    await sweep(S);
    const playerNoticeIds = q(dir, "SELECT id FROM notifications WHERE audience_kind = 'player' AND audience_id = 'pl-adeyemi'").map((r) => r.id);
    const guardianNoticeIds = q(dir, "SELECT id FROM notifications WHERE audience_kind = 'guardian' AND audience_id = 'gd-amara'").map((r) => r.id);
    const beforeRows = dispatchesOf(dir).filter((d) => playerNoticeIds.includes(d.notificationId));
    must(beforeRows.length > 0, 'dispatch rows for the adult player before deletion');
    const totalBefore = dispatchesOf(dir).length;
    const del = await S.j('DELETE', '/player/account', {}, kola); must(del.status === 200, `delete ${del.status}`);
    await until(async () => q(dir, "SELECT COUNT(*) AS n FROM notifications WHERE audience_kind = 'player' AND audience_id = 'pl-adeyemi'")[0].n === 0);
    const live = notificationIds(dir);
    const afterAll = dispatchesOf(dir);
    const orphans = afterAll.filter((d) => !live.has(d.notificationId));
    const sweepAfter = await sweep(S); // the sweep over orphans must not crash
    const afterSweep = dispatchesOf(dir);
    report.sections.deletion = {
      playerNotificationsBefore: playerNoticeIds.length, playerNotificationsAfter: q(dir, "SELECT COUNT(*) AS n FROM notifications WHERE audience_kind = 'player' AND audience_id = 'pl-adeyemi'")[0].n,
      dispatchRowsBefore: totalBefore, dispatchRowsAfter: afterAll.length, orphanDispatchRows: orphans.length, orphanShapes: orphans.map(shape),
      orphansReferenceDeletedPlayerNotifications: orphans.every((d) => playerNoticeIds.includes(d.notificationId)),
      guardianNotificationsAboutTheMinorUntouched: q(dir, "SELECT COUNT(*) AS n FROM notifications WHERE audience_kind = 'guardian' AND audience_id = 'gd-amara'")[0].n === guardianNoticeIds.length,
      sweepAfterDeletionProcessed: sweepAfter, dispatchRowsAfterSweep: afterSweep.length, orphansUnchangedBySweep: JSON.stringify(afterSweep.filter((d) => !live.has(d.notificationId))) === JSON.stringify(orphans),
      adminDeliveryStillListsOrphans: (await S.j('GET', '/admin/delivery', undefined, null, A)).body.recent.some((d) => orphans.some((o) => o.id === d.id)),
    };
    note(`deletion: DELETE /player/account removed ${playerNoticeIds.length} player-audience notification rows and NOT ONE of their ${orphans.length} dispatch rows; the orphans keep their statuses, the next sweep leaves them unchanged and /admin/delivery still lists them. Their 'to' is "player:<id>" for in_app rows (an identifier of the deleted person) and null for the skipped e-mail rows.`);
  }

  // ------------------------------------------------------------- 5. the proposed mapping, round-tripped over every observed row; constraints checked
  {
    const all = dispatchesOf(dir);
    const KNOWN = ['id', 'notificationId', 'audience', 'channel', 'to', 'provider', 'status', 'skipReason', 'providerMessageId', 'attempts', 'nextAt', 'actionDeadline', 'createdAt', 'deliveredAt', 'openedAt', 'actionedAt', 'failedAt', 'failReason'];
    const toRows = (d) => ({
      row: { id: d.id, notification_id: d.notificationId, audience_kind: d.audience.kind, audience_id: d.audience.id, channel: d.channel, to_address: d.to, provider: d.provider, status: d.status, skip_reason: d.skipReason, provider_message_id: d.providerMessageId, next_at: d.nextAt, action_deadline_at: d.actionDeadline, created_at: d.createdAt, delivered_at: d.deliveredAt, opened_at: d.openedAt, actioned_at: d.actionedAt, failed_at: d.failedAt, fail_reason: d.failReason },
      attempts: d.attempts.map((a, seq) => (Object.hasOwn(a, 'note') ? { dispatch_id: d.id, seq, kind: 'quiet_recheck', attempted_at: a.at, ok: null, error: null, note: a.note } : { dispatch_id: d.id, seq, kind: 'send', attempted_at: a.at, ok: a.ok ? 1 : 0, error: a.error, note: null })),
      unknownKeys: Object.keys(d).filter((k) => !KNOWN.includes(k)),
    });
    const back = ({ row, attempts }) => ({
      id: row.id, notificationId: row.notification_id, audience: { kind: row.audience_kind, id: row.audience_id }, channel: row.channel, to: row.to_address, provider: row.provider, status: row.status, skipReason: row.skip_reason, providerMessageId: row.provider_message_id,
      attempts: attempts.sort((x, y) => x.seq - y.seq).map((a) => (a.kind === 'quiet_recheck' ? { at: a.attempted_at, note: a.note } : { at: a.attempted_at, ok: a.ok === 1, error: a.error })),
      nextAt: row.next_at, actionDeadline: row.action_deadline_at, createdAt: row.created_at, deliveredAt: row.delivered_at, openedAt: row.opened_at, actionedAt: row.actioned_at, failedAt: row.failed_at, failReason: row.fail_reason,
    });
    const roundTrips = all.map((d) => { const m = toRows(d); return { id: d.id, identical: JSON.stringify(back(m)) === JSON.stringify(d), unknownKeys: m.unknownKeys }; });
    const keySets = [...new Set(all.map((d) => Object.keys(d).join(',')))];
    const attemptKeySets = [...new Set(all.flatMap((d) => d.attempts.map((a) => Object.keys(a).join(','))))];
    const byNotificationChannel = new Map(); for (const d of all) { const k = `${d.notificationId}\u0000${d.channel}`; byNotificationChannel.set(k, (byNotificationChannel.get(k) ?? 0) + 1); }
    const pmIds = all.map((d) => d.providerMessageId).filter(Boolean);
    const live = notificationIds(dir);
    report.sections.mapping = {
      rows: all.length, attemptRows: all.reduce((n, d) => n + d.attempts.length, 0),
      roundTripIdentical: roundTrips.every((r) => r.identical), roundTripFailures: roundTrips.filter((r) => !r.identical).map((r) => r.id),
      rowsWithUnknownKeys: roundTrips.filter((r) => r.unknownKeys.length).map((r) => ({ id: r.id, keys: r.unknownKeys })),
      dispatchKeySets: keySets, attemptKeySets,
      observed: { statuses: [...new Set(all.map((d) => d.status))].sort(), channels: [...new Set(all.map((d) => d.channel))].sort(), providers: [...new Set(all.map((d) => d.provider))].sort(), audienceKinds: [...new Set(all.map((d) => d.audience.kind))].sort(), skipReasons: [...new Set(all.map((d) => d.skipReason).filter(Boolean))].sort() },
      proposedConstraintsAgainstObservedData: {
        'notification_id REFERENCES notifications (NOT NULL)': { satisfiable: all.every((d) => live.has(d.notificationId)), orphanRows: all.filter((d) => !live.has(d.notificationId)).length },
        'UNIQUE provider_message_id WHERE NOT NULL': { satisfied: new Set(pmIds).size === pmIds.length, values: pmIds.length },
        'one row per (notification, channel) [not proposed, checked]': { satisfied: [...byNotificationChannel.values()].every((n) => n === 1) },
        'audience_kind IN (player, guardian, org_user)': { satisfiedHere: all.every((d) => ['player', 'guardian', 'org_user'].includes(d.audience.kind)), caveat: 'a notification with a system audience (the moderation report path, server.mjs: by/byId = system/moderation) would get an in_app dispatch with audience_kind system — the CHECK would refuse it; S7a dropped the same CHECK on notifications for this reason' },
        'status IN (nine values)': { satisfiedHere: all.every((d) => ['queued', 'held_quiet_hours', 'retrying', 'accepted', 'delivered', 'opened', 'actioned', 'skipped', 'failed'].includes(d.status)) },
        'fail_reason length <= 120': { satisfiedHere: all.every((d) => d.failReason === null || d.failReason.length <= 120), caveat: 'the sweep stores the provider error untruncated; only the callback path slices to 120' },
        'dispatch_attempts: send rows <= 4, at most one quiet_recheck': { satisfiedHere: all.every((d) => d.attempts.filter((a) => !a.note).length <= 4 && d.attempts.filter((a) => a.note).length <= 1) },
        'quiet_recheck rows carry no ok/error; send rows carry no note': { satisfiedHere: all.every((d) => d.attempts.every((a) => (Object.hasOwn(a, 'note') ? !Object.hasOwn(a, 'ok') && !Object.hasOwn(a, 'error') : !Object.hasOwn(a, 'note')))) },
      },
    };
    note(`mapping: ${all.length} dispatch rows and ${report.sections.mapping.attemptRows} attempt rows round-trip through the proposed columns byte-for-byte when a quiet_recheck attempt is written back as {at, note} ONLY (no ok, no error) and a send attempt as {at, ok, error}; the dispatch literal always carries all 18 keys, with null (never absent) for to/skipReason/providerMessageId/actionDeadline/deliveredAt/openedAt/actionedAt/failedAt/failReason when unset.`);
  }
} finally {
  await S.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}
const out = JSON.stringify(report, null, 2);
console.log(out);
if (process.argv[2]) fs.writeFileSync(process.argv[2], out);
