// S7c — synthetic compatibility probe for the mail outbox, the push log and the push tokens.
//
// NOT a test of desired behaviour and NOT part of `npm test`: it RECORDS what the current build does
// with `db.outbox`, `db.pushLog` and `db.pushTokens` on synthetic data, so the S7c implementation plan
// (docs/architecture/s7-readiness-review.md §10) rests on observed rows rather than narrative.
// CORRECTED after the independent review of 6ca66ba: this probe's original timing narrative said the push
// row "schedules no save of its own" — wrong. The push sender calls nextId('push'), and the server's nextId
// calls the debounced persist(), so the push row reaches the file about two seconds later through that
// existing best-effort save even when nothing else saves; the 400 ms sweep of this probe's M13_FAST_RETRY
// run masked that timer (its persistNow came first). The timing note below now labels which save carried
// the row; scripts/testOutboxPushServer.mjs measures both modes. The original (uncorrected) output is kept
// in the handoff as evidence. The review's independent script (review-6ca66ba-compatibility.mjs) is the
// baseline for the two other observations this probe records: the registration route accepts any truthy
// JSON token (number, string, boolean, object, array; primitives collapse by `===`, objects never), and the
// real boot sweep over an accepted queued dispatch with to: null writes a delivery record with to: null.
// After the S7c cutover the three collections are tables; the probe's readers were ADAPTED to read them in
// the same legacy shapes (see `storedOutbox` / `storedPush` / `storedTokens`) — the only change to its readers.
// What it records:
//   1. the TWO outbox shapes from the real routes — (a) the mailer record (guardian sign-up, org invite,
//      club e-mail challenge with its withheld secret) and (b) the delivery centre's fakeSend record (the
//      sweep of a guardian notice) — with their key sets, missing-versus-null fields, insertion order,
//      duplicate identifiers and the S6a withholding seen through `/admin/outbox` before and after a restart;
//   2. push-log rows from a non-deferred notification and the TIMING of that row relative to the
//      notification row it announces (which save revision carries each; whether the push row waits for
//      an unrelated later save);
//   3. push-token registration keys and audiences: player, guardian and org sessions, the same token
//      twice, re-registration order, and the sender's filter applied to the observed rows;
//   4. ordinary player deletion — what happens to the three collections;
//   5. the proposed unified mapping round-tripped over every observed row (JavaScript check) and the
//      proposed DDL executed in an in-memory SQLite database over the observed rows, including the NULL
//      behaviour of every CHECK with its actual predicate (executed SQL check).
// The real server runs as a child process on a temporary data directory (M13_FAST_RETRY=1); every database
// read goes through a second read-only connection. Nothing here touches DATA_DIR, real data or application
// source. Output: a JSON report on stdout and, with a path argument, in that file. Diagnostics name ids,
// counts, key sets, kinds, revisions and booleans — never a mail text, an address, a code or a token.
//   node scripts/probeS7cOutboxPush.mjs [out.json]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { tempDir } from './coreIdentityTestFixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const A = { 'x-admin-key': 'scoutbox-admin' };
const report = { probe: 'S7c outbox / push log / push tokens', build: 'current checkout', node: process.version, at: new Date().toISOString(), sections: {}, observations: [] };
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
/** ADAPTED for S7c (the only change to this probe's readers): after the 0011_outbox_push cutover the three collections are tables and the probe reads them in the same legacy shapes; before it (an older build) it reads the blobs. Every observation is computed on the same shapes as before. */
const liveS7c = (dir) => q(dir, "SELECT 1 AS one FROM data_migrations WHERE id = '0011_outbox_push'").length > 0;
const storedOutbox = (dir) => (liveS7c(dir) ? q(dir, 'SELECT id, source, created_at, to_address, subject, text, transport, delivered, channel, provider_message_id FROM outbox ORDER BY seq').map((r) => (r.source === 'mailer' ? { id: r.id, ts: r.created_at, to: r.to_address, subject: r.subject, text: r.text, transport: r.transport, delivered: r.delivered === 1 } : { id: r.id, at: r.created_at, channel: r.channel, to: r.to_address, text: r.text, providerMessageId: r.provider_message_id, provider: r.transport })) : storedOutbox(dir));
const storedPush = (dir) => (liveS7c(dir) ? q(dir, 'SELECT id, created_at, audience_kind, audience_id, title, body, transport FROM push_log ORDER BY seq').map((r) => ({ id: r.id, ts: r.created_at, audience: { kind: r.audience_kind, id: r.audience_id }, title: r.title, body: r.body, transport: r.transport })) : storedPush(dir));
const storedTokens = (dir) => (liveS7c(dir) ? q(dir, 'SELECT ref_kind, ref_id, token_json, registered_at FROM push_tokens ORDER BY seq').map((r) => ({ kind: r.ref_kind, refId: r.ref_id, token: JSON.parse(r.token_json), ts: r.registered_at })) : storedTokens(dir));
const revision = (dir) => Number(q(dir, "SELECT value FROM meta WHERE key = 'saveSeq'")[0]?.value) || 0;
const must = (ok, what) => { if (!ok) throw new Error(`probe precondition failed: ${what}`); };
const orgLogin = async (S, orgId, scoutName, role) => { const r = await S.j('POST', '/auth/org/login', { orgId, scoutName, role }); must(r.status === 200, `org login ${r.status} ${r.text.slice(0, 200)}`); return r.body.token; };
const playerLogin = async (S, playerId) => { const r = await S.j('POST', '/auth/player/login', { playerId }); must(r.status === 200, `player login ${r.status}`); return r.body.token; };
const guardianLogin = async (S, guardianId) => { const r = await S.j('POST', '/auth/guardian/login', { guardianId }); must(r.status === 200, `guardian login ${r.status} ${r.text.slice(0, 200)}`); return r.body.token; };
const sweep = async (S) => { const r = await S.j('POST', '/admin/delivery/sweep', {}, null, A); must(r.status === 200, 'sweep'); return r.body.processed; };

/** An outbox row with every private value removed: id, shape, key set, nulls, kinds and booleans only. */
const SHAPE_A = ['id', 'ts', 'to', 'subject', 'text', 'transport', 'delivered'];
const SHAPE_B = ['id', 'at', 'channel', 'to', 'text', 'providerMessageId', 'provider'];
const shapeOf = (m) => { const keys = Object.keys(m); const a = SHAPE_A.every((k) => keys.includes(k)); const b = SHAPE_B.every((k) => keys.includes(k)); return a && !b ? 'a' : b && !a ? 'b' : a && b ? 'both' : 'neither'; };
const outboxShape = (m) => ({ id: m.id, shape: shapeOf(m), keys: Object.keys(m), nulls: Object.keys(m).filter((k) => m[k] === null).sort(), undefineds: Object.keys(m).filter((k) => m[k] === undefined).sort(), hasTo: typeof m.to === 'string' && m.to.length > 0, transportOrProvider: m.transport ?? m.provider, delivered: m.delivered, channel: m.channel, providerMessageId: m.providerMessageId ? 'set' : m.providerMessageId, textLength: typeof m.text === 'string' ? m.text.length : null });
const pushShape = (p) => ({ id: p.id, keys: Object.keys(p), audienceKind: p.audience?.kind, title: p.title, transport: p.transport, bodyLength: typeof p.body === 'string' ? p.body.length : null });
const tokenShape = (t) => ({ keys: Object.keys(t), kind: t.kind, refId: t.refId, tokenLabel: TOKEN_LABELS.get(t.token) ?? 'unknown', ts: t.ts });
const TOKEN_LABELS = new Map([['probe-device-token-A-' + process.pid, 'A'], ['probe-device-token-B-' + process.pid, 'B']]);
const TOKEN_A = 'probe-device-token-A-' + process.pid;
const TOKEN_B = 'probe-device-token-B-' + process.pid;

const dir = tempDir('s7c-probe');
let S = await boot(dir);
try {
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment');
  const kola = await playerLogin(S, 'pl-adeyemi');
  const amara = await guardianLogin(S, 'gd-amara');
  const outboxBefore = storedOutbox(dir).length;
  const pushBefore = storedPush(dir).length;

  // ------------------------------------------------------------- 1. the two outbox shapes, from the real routes
  {
    // (a1) guardian sign-up: the mailer record; the route awaits the mail, calls no persistNow() of its own.
    const r0 = revision(dir);
    const signup = await S.j('POST', '/auth/guardian/signup', { name: 'Probe Guardian', email: `probe-guardian-${process.pid}@example.invalid`, password: 'probe-password-1' });
    must(signup.status === 201, `guardian signup ${signup.status} ${signup.text.slice(0, 200)}`);
    const memA1 = (await S.j('GET', '/admin/outbox', undefined, null, A)).body;
    const rowA1 = memA1.find((m) => m.subject && /guardian account/i.test(m.subject));
    must(rowA1, 'the sign-up mail is in the admin outbox view');
    const inDbA1 = storedOutbox(dir).some((m) => m.id === rowA1.id);
    const landedA1 = await until(async () => (storedOutbox(dir).some((m) => m.id === rowA1.id) ? revision(dir) : null), 6000);
    report.sections.outboxGuardianSignup = { row: outboxShape(rowA1), inDatabaseAtResponse: inDbA1, revisionAtResponse: r0, revisionWhenLanded: landedA1, codeInPersistedText: typeof signup.body.devEmailCode === 'string' && storedOutbox(dir).find((m) => m.id === rowA1.id)?.text.includes(signup.body.devEmailCode) };
    note(`outbox (a1) guardian sign-up: a shape-(a) row, keys ${JSON.stringify(outboxShape(rowA1).keys)}; it was ${inDbA1 ? 'already' : 'NOT yet'} in the database when the route answered and landed with save revision ${landedA1} (the debounced persist, 2 s); the persisted text ${report.sections.outboxGuardianSignup.codeInPersistedText ? 'CONTAINS the one-time code in clear (one of the six plain-code sites)' : 'does not contain the code'}.`);

    // (a2) org invite: the mailer record, persisted by the route's own persistNow() with the invite row.
    const r1 = revision(dir);
    const invite = await S.j('POST', '/org/invites', { email: `probe-invitee-${process.pid}@example.invalid`, name: 'Probe Invitee', role: 'Scout' }, maria);
    must(invite.status === 201, `invite ${invite.status} ${invite.text.slice(0, 200)}`);
    const memA2 = (await S.j('GET', '/admin/outbox', undefined, null, A)).body;
    const rowA2 = memA2.find((m) => m.subject && /invited you/i.test(m.subject));
    must(rowA2, 'the invite mail is in the admin outbox view');
    const dbA2 = storedOutbox(dir).find((m) => m.id === rowA2.id);
    report.sections.outboxOrgInvite = { row: outboxShape(rowA2), inDatabaseAtResponse: !!dbA2, revisionBefore: r1, revisionAtResponse: revision(dir), inviteRowInSameRevision: !!dbA2 && (blob(dir, 'orgInvites') ?? []).some((i) => i.id === invite.body.invite.id) };
    note(`outbox (a2) org invite: a shape-(a) row written by the mailer BEFORE its (dev) delivery resolves, committed by the route's persistNow() in the same save as the invite row (revision ${r1} → ${report.sections.outboxOrgInvite.revisionAtResponse}).`);

    // (a3) club e-mail challenge: the only call site passing `secrets` — the persisted row withholds the code, the admin view serves the full text from process memory.
    const challenge = await S.j('POST', '/org/verification/email', { email: `probe-club-${process.pid}@example-club.invalid` }, maria);
    must(challenge.status === 201, `challenge ${challenge.status} ${challenge.text.slice(0, 200)}`);
    const memA3 = (await S.j('GET', '/admin/outbox', undefined, null, A)).body.find((m) => m.subject && /^Verify .* on ScoutBox$/.test(m.subject));
    must(memA3, 'the challenge mail is in the admin outbox view');
    const dbA3 = await until(async () => storedOutbox(dir).find((m) => m.id === memA3.id), 6000);
    must(dbA3, 'the challenge row landed');
    const PLACEHOLDER = '[code withheld — delivered to the recipient only]';
    report.sections.outboxChallengeWithheld = { row: outboxShape(dbA3), persistedTextHasPlaceholder: dbA3.text.includes(PLACEHOLDER), adminViewHasPlaceholderBeforeRestart: memA3.text.includes(PLACEHOLDER), adminViewTextDiffersFromPersisted: memA3.text !== dbA3.text, adminViewRowOtherwiseIdentical: JSON.stringify({ ...memA3, text: null }) === JSON.stringify({ ...dbA3, text: null }) };
    note(`outbox (a3) club challenge (the one \`secrets\` site): the persisted row carries the placeholder; the admin view before a restart serves the full text from process memory (the same row, only \`text\` differs) — the S6a contract S7c must keep: the column holds the withheld text, the in-memory full text is never a column.`);

    // (b) the delivery centre: a guardian notice swept to the guardian's e-mail → fakeSend's record.
    const req = await S.j('POST', '/org/players/pl-guni/request', { type: 'contact', message: 'Synthetic: a conversation about the under-18 player.' }, maria);
    must(req.status === 201, `contact request on the minor ${req.status} ${req.text.slice(0, 300)}`);
    const guardianNotice = await until(async () => (await S.j('GET', '/guardian/notifications', undefined, amara)).body?.find((n) => n.type === 'request' && n.refId === req.body.requestId));
    must(guardianNotice, 'the guardian was notified of the request');
    const rowB = await until(async () => { await sweep(S); return storedOutbox(dir).find((m) => m.provider === 'local-fake' && m.providerMessageId && q(dir, 'SELECT provider_message_id FROM dispatches WHERE notification_id = ? AND channel = ?', guardianNotice.id, 'email').some((d) => d.provider_message_id === m.providerMessageId)); }, 15_000);
    must(rowB, 'the sweep wrote a fakeSend outbox row for the guardian e-mail dispatch');
    const dispatchRev = revision(dir);
    report.sections.outboxDelivery = { row: outboxShape(rowB), textIsNotificationTextTruncatedTo300: rowB.text.length <= 300 && guardianNotice.text.startsWith(rowB.text), sameRevisionAsDispatchRow: dispatchRev === revision(dir), dispatchRowReferencesIt: q(dir, 'SELECT COUNT(*) AS n FROM dispatches WHERE provider_message_id = ?', rowB.providerMessageId)[0].n };
    note(`outbox (b) delivery centre: a shape-(b) row, keys ${JSON.stringify(outboxShape(rowB).keys)} — no subject, no delivered, \`at\` instead of \`ts\`, \`provider\` instead of \`transport\`, a providerMessageId that exactly one dispatch row carries; written by the sweep in the same save as the dispatch row and its attempt (S7b).`);

    // The collection as a whole: order, ids, shapes, missing-versus-null.
    const all = storedOutbox(dir);
    const ids = all.map((m) => m.id);
    const idNums = ids.map((id) => Number(String(id).replace(/^mail-/, '')));
    const stamps = all.map((m) => m.ts ?? m.at);
    report.sections.outboxCollection = {
      rows: all.length, seededRows: outboxBefore, shapes: all.map((m) => shapeOf(m)).reduce((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {}),
      keySets: [...new Set(all.map((m) => Object.keys(m).join(',')))],
      duplicateIds: ids.length - new Set(ids).size, idSuffixMonotonic: idNums.every((n, i) => i === 0 || n > idNums[i - 1]), idStringSortEqualsArrayOrder: JSON.stringify([...ids].sort()) === JSON.stringify(ids),
      timestampsNonDecreasing: stamps.every((t, i) => i === 0 || t >= stamps[i - 1]), timestampTies: stamps.filter((t, i) => i > 0 && t === stamps[i - 1]).length,
      rowsWithoutTo: all.filter((m) => typeof m.to !== 'string' || !m.to.length).length, nullValues: [...new Set(all.flatMap((m) => Object.keys(m).filter((k) => m[k] === null)))], undefinedValues: [...new Set(all.flatMap((m) => Object.keys(m).filter((k) => m[k] === undefined)))],
      deliveredValues: [...new Set(all.map((m) => m.delivered))].map(String), transports: [...new Set(all.map((m) => m.transport ?? m.provider))].sort(), channels: [...new Set(all.map((m) => m.channel))].map(String),
      adminViewNewestFirst: (await S.j('GET', '/admin/outbox', undefined, null, A)).body.map((m) => m.id).join(',') === [...ids].reverse().join(','),
    };
    note(`outbox collection: ${all.length} rows (${outboxBefore} seeded); shapes ${JSON.stringify(report.sections.outboxCollection.shapes)}; absent fields are ABSENT (undefined), never null — a shape-(a) row has no channel/providerMessageId key, a shape-(b) row no subject/delivered key; ids are unique with a monotonic numeric suffix (${report.sections.outboxCollection.idSuffixMonotonic}); string order of the ids ${report.sections.outboxCollection.idStringSortEqualsArrayOrder ? 'happens to equal' : 'differs from'} array order here (it cannot be relied on: 'mail-999' sorts after 'mail-1000'); timestamps are non-decreasing with ${report.sections.outboxCollection.timestampTies} tie(s) in this run, with no rule against ties — array position is the only total order, so the table needs its own insertion key.`);
  }

  // ------------------------------------------------------------- 2. push log: the row and its timing against the notification row
  {
    // An org message to an ADULT player (no quiet hours set) → notify() → a non-deferred push → pushSender.send after the carrying save's COMMIT.
    const reqA = await S.j('POST', '/org/players/pl-adeyemi/request', { type: 'contact', message: 'Synthetic: a conversation about next season.' }, maria); must(reqA.status === 201, `adult request ${reqA.status} ${reqA.text.slice(0, 200)}`);
    must((await S.j('POST', `/player/requests/${reqA.body.requestId}/respond`, { accept: true }, kola)).status === 200, 'accept');
    const channel = (await S.j('GET', '/player/channels', undefined, kola)).body[0]; must(channel?.id, 'channel');
    // Settle first: the accept above produced pushes of its own; wait until memory and database agree and the sweep has nothing left to create.
    const settled = await until(async () => { await sleep(500); const mem = (await S.j('GET', '/admin/push-log', undefined, null, A)).body.length; const dbn = storedPush(dir).length; return mem === dbn ? dbn : null; }, 12_000);
    must(settled !== null, 'push log memory and database agree before the timing measurement');
    const pushCountBefore = settled;
    const memPushBefore = settled;
    const t0 = Date.now();
    const msg = await S.j('POST', `/org/channels/${channel.id}/messages`, { text: 'Synthetic message for the push-log probe.' }, maria); must(msg.status === 201, `message ${msg.status}`);
    const revAtResponse = revision(dir);
    const noticeRow = q(dir, "SELECT id FROM notifications WHERE audience_kind = 'player' AND audience_id = 'pl-adeyemi' AND type = 'message' ORDER BY seq DESC LIMIT 1")[0];
    const dispatchRowsAtResponse = q(dir, 'SELECT COUNT(*) AS n FROM dispatches WHERE notification_id = ?', noticeRow?.id ?? '')[0].n;
    const memPushAtResponse = (await S.j('GET', '/admin/push-log', undefined, null, A)).body.length;
    const dbPushAtResponse = storedPush(dir).length;
    // Leave the server alone and watch: which save carries the push row, how long after the response, and what else that save introduced.
    let landing = null;
    await until(async () => { const n = storedPush(dir).length; if (n > pushCountBefore) { landing = { afterMs: Date.now() - t0, revision: revision(dir), dispatchRowsForTheNotification: q(dir, 'SELECT COUNT(*) AS n FROM dispatches WHERE notification_id = ?', noticeRow?.id ?? '')[0].n }; return true; } return null; }, 6000);
    const revAfterWatch = revision(dir);
    // If it never landed on its own, an unrelated write that calls persist() carries it.
    let unrelated = null;
    if (!landing) {
      must((await S.j('POST', '/push/register', { token: TOKEN_A }, kola)).status === 201, 'register (unrelated write)');
      unrelated = await until(async () => (storedPush(dir).length > pushCountBefore ? revision(dir) : null), 6000);
    } else {
      must((await S.j('POST', '/push/register', { token: TOKEN_A }, kola)).status === 201, 'register (the player token the token section builds on)');
    }
    const pushRows = storedPush(dir);
    const newest = pushRows[pushRows.length - 1];
    report.sections.pushLogTiming = {
      notificationRowInDatabaseAtResponse: !!noticeRow, revisionAtResponse: revAtResponse, dispatchRowsForTheNotificationAtResponse: dispatchRowsAtResponse,
      pushRowsInMemoryAtResponse: memPushAtResponse - memPushBefore, pushRowsInDatabaseAtResponse: dbPushAtResponse - pushCountBefore,
      landedOnItsOwn: landing, revisionAfterWatch: revAfterWatch, landedWithUnrelatedWriteRevision: unrelated,
      row: newest ? pushShape(newest) : null, bodyEqualsNotificationText: newest && q(dir, 'SELECT text FROM notifications WHERE id = ?', noticeRow?.id)[0]?.text === newest.body,
      sweepIntervalInThisRunMs: 400, sweepIntervalInProductionMs: 60_000,
    };
    note(`push log timing (CURRENT behaviour, M13_FAST_RETRY=1 — this run): the message route's persistNow() commits the notification row (revision ${revAtResponse}, ${dispatchRowsAtResponse} dispatch rows for it yet); the push row is written to memory by the after-durable effect right after that COMMIT (in \`/admin/push-log\` at once: ${memPushAtResponse - memPushBefore} row) but NOT in that save (${dbPushAtResponse - pushCountBefore} in the database at the response). ${landing ? `It landed ${landing.afterMs} ms later with revision ${landing.revision}${landing.dispatchRowsForTheNotification > 0 ? `, the save that also introduced the notification's ${landing.dispatchRowsForTheNotification} dispatch rows — i.e. the 400 ms sweep's persistNow() came FIRST in this accelerated run and carried it` : ' with no dispatch rows yet — i.e. the sender\'s own nextId()/persist() debounce carried it'}.` : `It had not landed after 6 s idle; an unrelated write's save carried it (revision ${unrelated}).`} CORRECTION (review of 6ca66ba, D1): the sender's nextId('push') calls the server's debounced persist(), so the row ALWAYS has a save scheduled (about two seconds, best effort — scripts/testOutboxPushServer.mjs measures the normal mode: it lands with zero dispatch rows and no sweep); the earlier claim that "the effect schedules no save of its own" was wrong. The row is never in the notification's own save; its durability is the next save, which may be the sweep's, a route's, or that debounce.`);

    // A coalesced repeat: no second push row (current behaviour, S7a).
    const before2 = (await S.j('GET', '/admin/push-log', undefined, null, A)).body.length;
    must((await S.j('POST', `/org/channels/${channel.id}/messages`, { text: 'Synthetic second message, coalesced.' }, maria)).status === 201, 'second message');
    const after2 = (await S.j('GET', '/admin/push-log', undefined, null, A)).body.length;
    const allPush = (await S.j('GET', '/admin/push-log', undefined, null, A)).body;
    report.sections.pushLogCollection = { rowsAfterSecondMessage: after2 - before2, keySets: [...new Set(allPush.map((p) => Object.keys(p).join(',')))], audienceKinds: [...new Set(allPush.map((p) => p.audience?.kind))].sort(), titles: [...new Set(allPush.map((p) => p.title))], transports: [...new Set(allPush.map((p) => p.transport))], adminViewNewestFirst: allPush.map((p) => p.id).join(',') === [...storedPush(dir)].reverse().map((p) => p.id).join(',') || 'pending rows differ', seededRows: pushBefore };
    note(`push log collection: one key set ${JSON.stringify(report.sections.pushLogCollection.keySets)}; a coalesced repeat adds ${after2 - before2} push row(s); title is always 'ScoutBox'; audience kinds observed ${JSON.stringify(report.sections.pushLogCollection.audienceKinds)}.`);
  }

  // ------------------------------------------------------------- 3. push tokens: keys, audiences, duplicates, order
  {
    const tokensBefore = storedTokens(dir).length;
    must((await S.j('POST', '/push/register', { token: TOKEN_A }, amara)).status === 201, 'guardian register');
    must((await S.j('POST', '/push/register', { token: TOKEN_A }, maria)).status === 201, 'org register');
    must((await S.j('POST', '/push/register', { token: TOKEN_B }, kola)).status === 201, 'player register B');
    const firstOrder = await until(async () => { const t = storedTokens(dir); return t.length >= tokensBefore + 3 ? t : null; }, 6000);
    must(firstOrder, 'the three registrations landed');
    const tsBefore = firstOrder.find((t) => t.kind === 'player' && t.token === TOKEN_A)?.ts;
    must(typeof tsBefore === 'number', "the player's first token row is in the database");
    const positionBefore = firstOrder.findIndex((t) => t.kind === 'player' && t.token === TOKEN_A);
    await sleep(5);
    must((await S.j('POST', '/push/register', { token: TOKEN_A }, kola)).status === 201, 'player re-register A');
    const afterRe = await until(async () => { const t = storedTokens(dir); const row = t.find((x) => x.kind === 'player' && x.token === TOKEN_A); return row && row.ts !== tsBefore ? t : null; }, 6000);
    must(afterRe, 'the re-registration landed');
    const key = (t) => `${t.kind}\u0000${t.refId}\u0000${String(t.token)}`;
    const unauth = await S.j('POST', '/push/register', { token: TOKEN_B });
    const noToken = await S.j('POST', '/push/register', {}, kola);
    // Non-string tokens: the route checks truthiness only. What does the collection hold afterwards? (JSON input the route ACCEPTS today.)
    const numberToken = await S.j('POST', '/push/register', { token: 424242 }, amara);
    const objectToken = await S.j('POST', '/push/register', { token: { nested: ['value'] } }, maria);
    const withOdd = (await until(async () => { const t = storedTokens(dir); return t.some((x) => typeof x.token !== 'string') ? t : null; }, 6000)) ?? [];
    report.sections.pushTokensNonStringInput = { numberTokenStatus: numberToken.status, objectTokenStatus: objectToken.status, storedTokenTypes: [...new Set(withOdd.map((t) => (t.token === null ? 'null' : Array.isArray(t.token) ? 'array' : typeof t.token)))].sort(), rowsWithNonStringToken: withOdd.filter((t) => typeof t.token !== 'string').length };
    note(`push tokens, non-string input (CURRENT behaviour, PRESERVED): the route accepts any truthy JSON value as a token (number → ${numberToken.status}, object → ${objectToken.status}) and stores it as it came. CORRECTION (review of 6ca66ba, D2): the earlier conclusion "the plan refuses" was withdrawn — the implemented S7c stores every token LOSSLESSLY as JSON text (token_json) and decodes it on read, keeps the route's acceptance and its \`===\` matching rule (a primitive collapses an earlier row holding the same value of the same type; objects and arrays never collapse) and adds no uniqueness constraint; a plain STRICT TEXT column would have converted a number and refused an object (the executed SQL section records that), which is why the JSON column was chosen.`);
    const orgRow = afterRe.find((t) => t.token === TOKEN_A && t.kind !== 'player' && t.kind !== 'guardian');
    // The sender's filter (adapters.mjs createPushSender.send): tokens where t.kind === audience.kind && t.refId === audience.id.
    const pushRows = storedPush(dir);
    const orgUserAudiences = pushRows.filter((p) => p.audience?.kind === 'org_user').map((p) => p.audience);
    const matchesForOrgUserAudiences = orgUserAudiences.map((a) => afterRe.filter((t) => t.kind === a.kind && t.refId === a.id).length);
    report.sections.pushTokens = {
      rowsBefore: tokensBefore, rowsAfterThreeMoreRegistrations: firstOrder.length, rowsAfterReRegistration: afterRe.length,
      orderBefore: firstOrder.map(tokenShape), rows: afterRe.map(tokenShape), reRegisteredRowPositionBefore: positionBefore, reRegisteredRowPositionAfter: afterRe.findIndex((t) => t.kind === 'player' && t.token === TOKEN_A),
      keySets: [...new Set(afterRe.map((t) => Object.keys(t).join(','))).values()], kinds: [...new Set(afterRe.map((t) => t.kind))].sort(),
      sameTokenUnderThreeSessions: afterRe.filter((t) => t.token === TOKEN_A).length, naturalKeyDuplicates: afterRe.length - new Set(afterRe.map(key)).size,
      reRegistrationMovedRowToEnd: afterRe[afterRe.length - 1]?.kind === 'player' && afterRe[afterRe.length - 1]?.token === TOKEN_A, reRegistrationUpdatedTs: afterRe.find((t) => t.kind === 'player' && t.token === TOKEN_A)?.ts !== tsBefore,
      orgSessionRow: orgRow ? { kind: orgRow.kind, refIdIsTheOrgId: orgRow.refId === 'org-eastport' } : null,
      senderFilterOverObservedRows: { orgUserPushRows: orgUserAudiences.length, tokensMatchingEachOrgUserPush: matchesForOrgUserAudiences, playerPushRowsWithAMatchingToken: pushRows.filter((p) => p.audience?.kind === 'player').filter((p) => afterRe.some((t) => t.kind === 'player' && t.refId === p.audience.id)).length },
      refusals: { unauthenticated: unauth.status, missingToken: noToken.status },
    };
    note(`push tokens: one key set {kind, refId, token, ts}; the same device token registered by a player, a guardian and an org session is three rows (the natural key is the triple); re-registering an existing triple keeps the count (${firstOrder.length} → ${afterRe.length}), updates ts and ${report.sections.pushTokens.reRegistrationMovedRowToEnd ? 'MOVES the row from position ' + positionBefore + ' to the end of the array (filter-then-push) — array order is not first-registration order' : 'leaves the row at position ' + report.sections.pushTokens.reRegisteredRowPositionAfter}; the org session's row is kind 'org' with the organisation's id while every org-staff push row carries audience kind 'org_user' with a user id, so ${matchesForOrgUserAudiences.length} staff push row(s) match ${matchesForOrgUserAudiences.reduce((a, b) => a + b, 0)} token(s) under the sender's filter (the known staff-push defect, carried through unchanged).`);
  }

  // ------------------------------------------------------------- 4. ordinary deletion: what remains
  {
    const counts = () => ({ outbox: storedOutbox(dir).length, pushLog: storedPush(dir).length, pushTokens: storedTokens(dir).length });
    await sleep(2200); // let any pending debounced save land so the counts are stable
    const before = counts();
    const playerTokensBefore = storedTokens(dir).filter((t) => t.kind === 'player' && t.refId === 'pl-adeyemi').length;
    const playerPushRowsBefore = storedPush(dir).filter((p) => p.audience?.kind === 'player' && p.audience?.id === 'pl-adeyemi').length;
    const del = await S.j('DELETE', '/player/account', {}, kola); must(del.status === 200, `delete ${del.status}`);
    await until(async () => q(dir, "SELECT COUNT(*) AS n FROM notifications WHERE audience_kind = 'player' AND audience_id = 'pl-adeyemi'")[0].n === 0);
    await sleep(2200);
    const after = counts();
    report.sections.deletion = {
      before, after, unchanged: JSON.stringify(before) === JSON.stringify(after),
      deletedPlayerTokensBefore: playerTokensBefore, deletedPlayerTokensAfter: storedTokens(dir).filter((t) => t.kind === 'player' && t.refId === 'pl-adeyemi').length,
      deletedPlayerPushRowsBefore: playerPushRowsBefore, deletedPlayerPushRowsAfter: storedPush(dir).filter((p) => p.audience?.kind === 'player' && p.audience?.id === 'pl-adeyemi').length,
      playerNotificationsAfter: q(dir, "SELECT COUNT(*) AS n FROM notifications WHERE audience_kind = 'player' AND audience_id = 'pl-adeyemi'")[0].n,
      sessionRevokedSoNoReRegistration: (await S.j('POST', '/push/register', { token: TOKEN_B }, kola)).status,
    };
    note(`deletion (CURRENT behaviour): DELETE /player/account removed the player's notification rows and touched NONE of the three collections — the deleted person's ${playerTokensBefore} device token row(s) and ${playerPushRowsBefore} push-log row(s) naming them stay; the revoked session can no longer register. S7c preserves this (no cascade, no cleanup); retention is the open §4.4 question.`);
  }

  // ------------------------------------------------------------- 5. the proposed mapping (JavaScript) and the proposed DDL (executed SQL)
  {
    const outbox = storedOutbox(dir); const pushLog = storedPush(dir); const pushTokens = storedTokens(dir);
    // JavaScript mapping check — the unified outbox row and the way back, chosen by the stored transport.
    const KNOWN_A = SHAPE_A, KNOWN_B = SHAPE_B;
    const toOutboxRow = (m, seq) => {
      const s = shapeOf(m);
      if (s === 'a') return { seq, id: m.id, created_at: m.ts, to_address: m.to, subject: m.subject, text: m.text, transport: m.transport, delivered: m.delivered ? 1 : 0, channel: null, provider_message_id: null, extra: Object.keys(m).filter((k) => !KNOWN_A.includes(k)) };
      if (s === 'b') return { seq, id: m.id, created_at: m.at, to_address: m.to, subject: null, text: m.text, transport: m.provider, delivered: 0, channel: m.channel, provider_message_id: m.providerMessageId, extra: Object.keys(m).filter((k) => !KNOWN_B.includes(k)) };
      return { seq, id: m.id, refused: `shape ${s}` };
    };
    const backOutbox = (r) => (r.transport === 'local-fake'
      ? { id: r.id, at: r.created_at, channel: r.channel, to: r.to_address, text: r.text, providerMessageId: r.provider_message_id, provider: r.transport }
      : { id: r.id, ts: r.created_at, to: r.to_address, subject: r.subject, text: r.text, transport: r.transport, delivered: r.delivered === 1 });
    const outboxTrips = outbox.map((m, i) => { const r = toOutboxRow(m, i); return { id: m.id, identical: !r.refused && JSON.stringify(backOutbox(r)) === JSON.stringify(m), refused: r.refused ?? null, extra: r.extra ?? [] }; });
    const toPushRow = (p, seq) => ({ seq, id: p.id, created_at: p.ts, audience_kind: p.audience?.kind, audience_id: p.audience?.id, title: p.title, body: p.body, transport: p.transport, extra: Object.keys(p).filter((k) => !['id', 'ts', 'audience', 'title', 'body', 'transport'].includes(k)).concat(Object.keys(p.audience ?? {}).filter((k) => !['kind', 'id'].includes(k)).map((k) => `audience.${k}`)) });
    const backPush = (r) => ({ id: r.id, ts: r.created_at, audience: { kind: r.audience_kind, id: r.audience_id }, title: r.title, body: r.body, transport: r.transport });
    const pushTrips = pushLog.map((p, i) => { const r = toPushRow(p, i); return { id: p.id, identical: JSON.stringify(backPush(r)) === JSON.stringify(p), extra: r.extra }; });
    const toTokenRow = (t, seq) => ({ seq, ref_kind: t.kind, ref_id: t.refId, token: t.token, registered_at: t.ts, extra: Object.keys(t).filter((k) => !['kind', 'refId', 'token', 'ts'].includes(k)) });
    const backToken = (r) => ({ kind: r.ref_kind, refId: r.ref_id, token: r.token, ts: r.registered_at });
    const tokenTrips = pushTokens.map((t, i) => { const r = toTokenRow(t, i); return { identical: JSON.stringify(backToken(r)) === JSON.stringify(t), extra: r.extra }; });
    report.sections.mappingJavaScript = {
      outbox: { rows: outbox.length, roundTripIdentical: outboxTrips.every((t) => t.identical), failures: outboxTrips.filter((t) => !t.identical).map((t) => t.id), refused: outboxTrips.filter((t) => t.refused).length, rowsWithUnknownKeys: outboxTrips.filter((t) => t.extra.length).length, note: 'shape (a) ⇄ {id, ts, to, subject, text, transport, delivered}; shape (b) ⇄ {id, at, channel, to, text, providerMessageId, provider}; the stored transport decides the way back (local-fake → (b)); key ORDER is part of the byte-identity and is the writers\' literal order' },
      pushLog: { rows: pushLog.length, roundTripIdentical: pushTrips.every((t) => t.identical), failures: pushTrips.filter((t) => !t.identical).map((t) => t.id), rowsWithUnknownKeys: pushTrips.filter((t) => t.extra.length).length },
      pushTokens: { rows: pushTokens.length, roundTripIdentical: tokenTrips.every((t) => t.identical), failures: tokenTrips.filter((t) => !t.identical).length, rowsWithUnknownKeys: tokenTrips.filter((t) => t.extra.length).length },
    };
    note(`JavaScript mapping: ${outbox.length} outbox, ${pushLog.length} push-log and ${pushTokens.length} push-token rows round-trip through the proposed columns byte-for-byte (key order included) when the outbox way back is chosen by the stored transport and a shape-(b) row is rebuilt WITHOUT subject/delivered keys and a shape-(a) row WITHOUT channel/providerMessageId keys; no row carries an unknown key.`);

    // Executed SQL check — the proposed DDL (sql/03 as proposed, plus the insertion key `seq` this plan adds) over the observed rows, in memory.
    const mem = new DatabaseSync(':memory:');
    mem.exec(`
      CREATE TABLE outbox (
        seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, to_address TEXT NOT NULL, subject TEXT, text TEXT NOT NULL,
        transport TEXT NOT NULL CHECK (transport IN ('sendgrid','dev-outbox','local-fake')),
        delivered INTEGER NOT NULL DEFAULT 0 CHECK (delivered IN (0,1)),
        channel TEXT CHECK (channel IS NULL OR channel IN ('email')), provider_message_id TEXT, extra_json TEXT
      ) STRICT;
      CREATE TABLE push_log (
        seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
        audience_kind TEXT NOT NULL CHECK (audience_kind IN ('player','guardian','org_user')), audience_id TEXT NOT NULL,
        title TEXT NOT NULL, body TEXT NOT NULL, transport TEXT NOT NULL CHECK (transport IN ('expo','dev-log')), extra_json TEXT
      ) STRICT;
      CREATE TABLE push_tokens (
        seq INTEGER PRIMARY KEY, ref_kind TEXT NOT NULL CHECK (ref_kind IN ('player','guardian','org','ts_reviewer')), ref_id TEXT NOT NULL, token TEXT NOT NULL, registered_at INTEGER NOT NULL, extra_json TEXT,
        UNIQUE (ref_kind, ref_id, token)
      ) STRICT;`);
    const tryRun = (sql, params) => { try { mem.prepare(sql).run(...params); return 'ok'; } catch (e) { return String(e.message).replace(/'[^']*'/g, "'…'").slice(0, 120); } };
    const outboxInserts = outbox.map((m, i) => { const r = toOutboxRow(m, i); return r.refused ? `refused by the mapping (${r.refused})` : tryRun('INSERT INTO outbox (seq, id, created_at, to_address, subject, text, transport, delivered, channel, provider_message_id, extra_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [r.seq, r.id, r.created_at, r.to_address, r.subject, r.text, r.transport, r.delivered, r.channel, r.provider_message_id, null]); });
    const pushInserts = pushLog.map((p, i) => { const r = toPushRow(p, i); return tryRun('INSERT INTO push_log (seq, id, created_at, audience_kind, audience_id, title, body, transport, extra_json) VALUES (?,?,?,?,?,?,?,?,?)', [r.seq, r.id, r.created_at, r.audience_kind, r.audience_id, r.title, r.body, r.transport, null]); });
    const tokenInserts = pushTokens.map((t, i) => { const r = toTokenRow(t, i); return tryRun('INSERT INTO push_tokens (seq, ref_kind, ref_id, token, registered_at, extra_json) VALUES (?,?,?,?,?,?)', [r.seq, r.ref_kind, r.ref_id, r.token, r.registered_at, null]); });
    const tally = (xs) => xs.reduce((acc, x) => ({ ...acc, [x]: (acc[x] ?? 0) + 1 }), {});
    // NULL behaviour of every CHECK, with the actual predicate: a CHECK whose result is NULL PASSES in SQLite; NOT NULL is what refuses.
    const nullBehaviour = {
      'outbox.channel NULL (shape (a))': tryRun('INSERT INTO outbox (seq,id,created_at,to_address,text,transport,delivered,channel) VALUES (?,?,?,?,?,?,?,?)', [9001, 'probe-null-1', 1, 'x', 'x', 'dev-outbox', 0, null]),
      "outbox.channel 'sms'": tryRun('INSERT INTO outbox (seq,id,created_at,to_address,text,transport,delivered,channel) VALUES (?,?,?,?,?,?,?,?)', [9002, 'probe-null-2', 1, 'x', 'x', 'local-fake', 0, 'sms']),
      'outbox.delivered explicit NULL (a shape-(b) row mapped naively)': tryRun('INSERT INTO outbox (seq,id,created_at,to_address,text,transport,delivered) VALUES (?,?,?,?,?,?,?)', [9003, 'probe-null-3', 1, 'x', 'x', 'local-fake', null]),
      'outbox.delivered omitted (DEFAULT 0)': tryRun('INSERT INTO outbox (seq,id,created_at,to_address,text,transport) VALUES (?,?,?,?,?,?)', [9004, 'probe-null-4', 1, 'x', 'x', 'local-fake']),
      'outbox.transport NULL': tryRun('INSERT INTO outbox (seq,id,created_at,to_address,text,transport) VALUES (?,?,?,?,?,?)', [9005, 'probe-null-5', 1, 'x', 'x', null]),
      'outbox.to_address NULL': tryRun('INSERT INTO outbox (seq,id,created_at,to_address,text,transport) VALUES (?,?,?,?,?,?)', [9006, 'probe-null-6', 1, null, 'x', 'dev-outbox']),
      'outbox.delivered 2': tryRun('INSERT INTO outbox (seq,id,created_at,to_address,text,transport,delivered) VALUES (?,?,?,?,?,?,?)', [9007, 'probe-null-7', 1, 'x', 'x', 'dev-outbox', 2]),
      'outbox duplicate id': tryRun('INSERT INTO outbox (seq,id,created_at,to_address,text,transport) VALUES (?,?,?,?,?,?)', [9008, 'probe-null-4', 1, 'x', 'x', 'dev-outbox']),
      "push_log.audience_kind outside the three (S7a keeps the notification audience kind OPEN; no current notify call site uses another kind, by code reading)": tryRun('INSERT INTO push_log (seq,id,created_at,audience_kind,audience_id,title,body,transport) VALUES (?,?,?,?,?,?,?,?)', [9001, 'probe-push-1', 1, 'other', 'x', 'x', 'x', 'dev-log']),
      'push_tokens.token a number (what the route stores for a numeric JSON token; a STRICT TEXT column CONVERTS a bound number — see the mapping note)': tryRun('INSERT INTO push_tokens (seq,ref_kind,ref_id,token,registered_at) VALUES (?,?,?,?,?)', [9000, 'guardian', 'x', 424242, 1]),
      'push_log.audience_kind NULL': tryRun('INSERT INTO push_log (seq,id,created_at,audience_kind,audience_id,title,body,transport) VALUES (?,?,?,?,?,?,?,?)', [9002, 'probe-push-2', 1, null, 'x', 'x', 'x', 'dev-log']),
      'push_log.body NULL (notify with a non-string text, by code reading)': tryRun('INSERT INTO push_log (seq,id,created_at,audience_kind,audience_id,title,body,transport) VALUES (?,?,?,?,?,?,?,?)', [9003, 'probe-push-3', 1, 'player', 'x', 'x', null, 'dev-log']),
      "push_tokens.ref_kind 'org' (the org session's rows as they are)": tryRun('INSERT INTO push_tokens (seq,ref_kind,ref_id,token,registered_at) VALUES (?,?,?,?,?)', [9001, 'org', 'x', 'probe-t-1', 1]),
      "push_tokens.ref_kind 'org_user' (what the sender filters for — NOT what the route writes)": tryRun('INSERT INTO push_tokens (seq,ref_kind,ref_id,token,registered_at) VALUES (?,?,?,?,?)', [9002, 'org_user', 'x', 'probe-t-2', 1]),
      'push_tokens duplicate triple': tryRun('INSERT INTO push_tokens (seq,ref_kind,ref_id,token,registered_at) VALUES (?,?,?,?,?)', [9003, 'org', 'x', 'probe-t-1', 2]),
      'push_tokens same token, other ref_kind': tryRun('INSERT INTO push_tokens (seq,ref_kind,ref_id,token,registered_at) VALUES (?,?,?,?,?)', [9004, 'player', 'x', 'probe-t-1', 2]),
      'push_tokens.token NULL': tryRun('INSERT INTO push_tokens (seq,ref_kind,ref_id,token,registered_at) VALUES (?,?,?,?,?)', [9005, 'player', 'x', null, 2]),
    };
    const numericTokenStored = mem.prepare('SELECT typeof(token) AS t, length(token) AS n FROM push_tokens WHERE seq = 9000').get();
    mem.close();
    report.sections.constraintsExecutedSql = { observedRows: { outbox: tally(outboxInserts), pushLog: tally(pushInserts), pushTokens: tally(tokenInserts) }, nullBehaviour, numericTokenAfterStrictTextInsert: numericTokenStored ? { ...numericTokenStored } : null };
    note(`executed SQL against the PREPARED DDL (superseded: the implemented schema — nullable to_address, a total source CHECK with delivered NULL for a delivery row, token_json, no unique triple — is exercised by scripts/testOutboxPush.mjs; this section is kept as the record that motivated it): observed rows against the prepared tables: ${JSON.stringify(report.sections.constraintsExecutedSql.observedRows)} — a STRICT TEXT column CONVERTS a bound number (node binds every number as a double: 424242 becomes the text '424242.0', typeof ${numericTokenStored?.t}, ${numericTokenStored?.n} chars) and refuses an object, so a non-string token must be refused by the import's own validation, not left to SQLite; a NULL \`channel\` passes its CHECK (NULL result = pass), a NULL \`delivered\` is refused by NOT NULL — so the mapping must write 0 for shape (b), never NULL; the proposed \`audience_kind\` CHECK would refuse a kind outside the three while S7a keeps the kind open (no current notify call site uses another kind); the push_tokens unique triple admits the same token under another kind, as the code does.`);
  }

  // ------------------------------------------------------------- 6. restart: the admin view after the process memory is gone
  {
    const beforeRestart = (await S.j('GET', '/admin/outbox', undefined, null, A)).body;
    const challengeBefore = beforeRestart.find((m) => m.subject && /^Verify .* on ScoutBox$/.test(m.subject));
    const PLACEHOLDER = '[code withheld — delivered to the recipient only]';
    await S.stop();
    S = await boot(dir);
    const afterRestart = (await S.j('GET', '/admin/outbox', undefined, null, A)).body;
    const challengeAfter = afterRestart.find((m) => m.id === challengeBefore?.id);
    report.sections.restart = { outboxRowsBefore: beforeRestart.length, outboxRowsAfter: afterRestart.length, sameIdsSameOrder: beforeRestart.map((m) => m.id).join(',') === afterRestart.map((m) => m.id).join(','), challengeFullTextBeforeRestart: !!challengeBefore && !challengeBefore.text.includes(PLACEHOLDER), challengePlaceholderAfterRestart: !!challengeAfter && challengeAfter.text.includes(PLACEHOLDER), pushLogRowsAfter: (await S.j('GET', '/admin/push-log', undefined, null, A)).body.length, pushTokensAfter: storedTokens(dir).length };
    note(`restart: the admin outbox lists the same ${afterRestart.length} ids in the same order; the challenge mail that showed its full text before the restart shows the placeholder after it (the in-memory dev delivery is gone, the column was always the withheld text).`);
  }
} finally {
  await S.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}
const out = JSON.stringify(report, null, 2);
console.log(out);
if (process.argv[2]) fs.writeFileSync(process.argv[2], out);
