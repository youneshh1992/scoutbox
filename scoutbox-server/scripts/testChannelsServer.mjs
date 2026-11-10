// Message threads through the REAL server (server.mjs booted as a child process on temporary data directories,
// synthetic seed records only): both acceptance paths (an adult player accepts; a guardian
// accepts for a minor), messages from all three sender kinds, both attachment shapes, the duplicate-clientMsgId
// answer, the three read-receipt routes, typing, the per-audience views (the player's and the guardian's carry no
// orgId/guardianId; the org's carries orgId; the admin's both), the export, the SSE lookup, the blocked-organisation
// refusal, the account deletion (D-B: the deleted player's threads go, guardian–club threads included, other players'
// threads stay); migration 0012 recorded at boot, a thread durable with the acceptance's unit (SIGKILL right after),
// a message durable before the sender hears 201 (SIGKILL), a message whose unit fails at the REAL COMMIT answered 500
// with nothing stored, the admin backup and a restore. Every database read goes through a second read-only
// connection. Nothing here touches DATA_DIR or real data. Run with: npm test
import assert from 'node:assert/strict';
import { spawnChild } from './testChildren.mjs';
import { freePort } from './testPort.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { tempDir } from './coreIdentityTestFixtures.mjs';
import { createSafetyAuditRepository } from '../repositories/safetyAudit.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
async function test(name, fn) {
  if (only && !name.includes(only)) return;
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const rm = (...dirs) => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
};
const A = { 'x-admin-key': 'scoutbox-admin' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 10_000, step = 40) => {
  const t0 = Date.now();
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
};
const MIGRATION = '0012_channels';
/** seed.mjs `med()`: the media id is derived from the title; the first clip of pl-adeyemi. */
const hash = (s) => {
  let h = 0;
  for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0;
  return h;
};
const MEDIA_ID = `media-${Math.abs(hash('Match highlights vs Riverside'))}`;
const REPORT = {
  acceleration: 7,
  sprintSpeedKmh: 31,
  distanceKm: 6.2,
  passCompletionPct: 78,
  duelSuccessPct: 55,
  coachRating: 8,
};

async function boot(dir, env = {}, server = SERVER) {
  const port = await freePort();
  return new Promise((resolve, reject) => {
    const proc = spawnChild(process.execPath, [server], {
      env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: dir,
        SCOUTBOX_QUIET_LOGS: '1',
        SCOUTBOX_FAST_SWEEPS: '1',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let log = '';
    const j = async (method, p, body, token, headers = {}) => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* no body */
      }
      return { status: r.status, body: parsed, text };
    };
    const S = {
      proc,
      port,
      dir,
      log: () => log,
      j,
      stop: () =>
        new Promise((res) => {
          proc.on('exit', () => res());
          proc.kill('SIGTERM');
        }),
      kill: () =>
        new Promise((res) => {
          proc.on('exit', () => res());
          proc.kill('SIGKILL');
        }),
    };
    proc.stdout.on('data', (d) => {
      log += d;
      if (/listening on/.test(log)) resolve(S);
    });
    proc.stderr.on('data', (d) => {
      log += d;
    });
    proc.on('exit', (code, signal) =>
      reject(Object.assign(new Error(`server exited ${code} (${signal}): ${log.slice(-1500)}`), { code, log })),
    );
    setTimeout(() => reject(new Error(`boot timeout: ${log.slice(-800)}`)), 30_000).unref();
  });
}
/** Every read of the file goes through a second, read-only connection; `snap` pins ONE read transaction so several reads see one committed state. */
const snap = (dir, fn) => {
  const s = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true });
  try {
    s.exec('BEGIN');
    try {
      return fn({
        get: (sql, ...p) => {
          const r = s.prepare(sql).get(...p);
          return r ? { ...r } : r;
        },
        all: (sql, ...p) =>
          s
            .prepare(sql)
            .all(...p)
            .map((r) => ({ ...r })),
      });
    } finally {
      s.exec('COMMIT');
    }
  } finally {
    s.close();
  }
};
const q1 = (dir, sql, ...p) => snap(dir, (c) => c.get(sql, ...p));
const live = (dir) => !!q1(dir, 'SELECT 1 AS one FROM data_migrations WHERE id = ?', MIGRATION);
/** Whether the file still has the retired blob table (dropped by migration 0039). */
const hasBlobTable = (dir) =>
  !!q1(dir, "SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = 'collections'");
// The ledger, read in the writer's literal through the repository's own reader.
const ledgerRows = (dir) => {
  const s = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true });
  try {
    return createSafetyAuditRepository({ sqlite: s }).exportAll().ledger ?? [];
  } finally {
    s.close();
  }
};
// The requests: the recruitment_requests columns the assertions need.
const requestRows = (c) =>
  c.all('SELECT id, status, contact_channel_id AS contactChannel FROM recruitment_requests ORDER BY rowid');
const requestsOf = (dir) => snap(dir, (c) => requestRows(c) ?? []);
const attachmentOf = (r) =>
  r.kind === 'clip'
    ? { kind: 'clip', mediaId: r.media_id, title: r.title, url: r.url, verifiedClip: r.verified_clip === 1 }
    : { kind: 'trial_report', reportId: r.report_id, orgName: r.org_name, summary: r.summary };
/**
 * The threads as the DATABASE holds them, in insertion order and in the writers'
 * literal (typed columns only).
 */
const readStored = (c) => {
  const attachments = new Map(c.all('SELECT * FROM message_attachments').map((r) => [r.message_id, r]));
  const messages = new Map();
  for (const m of c.all('SELECT * FROM messages ORDER BY channel_id, position')) {
    const row = {
      id: m.id,
      ts: m.created_at,
      sender: { kind: m.sender_kind, id: m.sender_user_id ?? m.sender_person_id, name: m.sender_name },
      text: m.text,
      attachment: attachments.has(m.id) ? attachmentOf(attachments.get(m.id)) : null,
    };
    if (m.client_msg_id !== null) row.clientMsgId = m.client_msg_id;
    if (!messages.has(m.channel_id)) messages.set(m.channel_id, []);
    messages.get(m.channel_id).push(row);
  }
  // In the admin audit's key order (the organisation's view, then the guardian's id).
  return c.all('SELECT * FROM channels ORDER BY seq').map((r) => ({
    id: r.id,
    requestId: r.request_id,
    playerId: r.player_id,
    playerName: r.player_name,
    orgId: r.org_id,
    orgName: r.org_name,
    orgVerified: r.org_verified === null ? null : r.org_verified === 1,
    scoutName: r.scout_name,
    scoutRole: r.scout_role,
    counterparty: r.counterparty,
    createdAt: r.created_at,
    lastActivityAt: r.last_activity_at,
    messages: messages.get(r.id) ?? [],
    readBy: { org: r.read_by_org_at, counterparty: r.read_by_counterparty_at },
    guardianId: r.guardian_id,
  }));
};
const stored = (dir) => snap(dir, readStored);
const storedIds = (dir) => stored(dir).map((c) => [c.id, c.messages.map((m) => m.id)]);
/** The admin audit and the org's list page most recently active first; the first page, put in insertion order to compare with the file. */
const inStoredOrder = (dir, items) => {
  const order = stored(dir).map((c) => c.id);
  return [...items].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
};
const adminAudit = async (S) => {
  const r = await S.j('GET', '/admin/channels', undefined, null, A);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.nextCursor, null);
  return inStoredOrder(S.dir, r.body.items);
};

const orgLogin = async (S, orgId = 'org-eastport', scoutName = 'Maria Keane', role = 'Head of Recruitment') => {
  const r = await S.j('POST', '/auth/org/login', { orgId, scoutName, role });
  assert.equal(r.status, 200, `org login ${orgId}: ${r.text}`);
  return r.body.token;
};
const playerLogin = async (S, playerId) => {
  const r = await S.j('POST', '/auth/player/login', { playerId });
  assert.equal(r.status, 200, r.text);
  return r.body.token;
};
const guardianLogin = async (S, guardianId) => {
  const r = await S.j('POST', '/auth/guardian/login', { guardianId });
  assert.equal(r.status, 200, r.text);
  return r.body.token;
};
/** A contact request answered by the ADULT player: the thread between the club and the player. */
async function adultThread(S, maria, playerToken, playerId = 'pl-adeyemi') {
  const req = await S.j(
    'POST',
    `/org/players/${playerId}/request`,
    { type: 'contact', message: 'Synthetic contact request.' },
    maria,
  );
  assert.equal(req.status, 201, req.text);
  assert.equal(req.body.routedTo, 'player');
  const ans = await S.j('POST', `/player/requests/${req.body.requestId}/respond`, { accept: true }, playerToken);
  assert.equal(ans.status, 200, ans.text);
  const channel = (await S.j('GET', '/player/channels', undefined, playerToken)).body.find(
    (c) => c.requestId === req.body.requestId,
  );
  assert.ok(channel?.id, 'the thread is listed at once');
  return { requestId: req.body.requestId, channel };
}
/** A contact request for the MINOR, routed to and answered by the guardian: the thread between the club and the guardian. */
async function guardianThread(S, maria, amara, playerId = 'pl-guni') {
  const req = await S.j(
    'POST',
    `/org/players/${playerId}/request`,
    { type: 'contact', message: 'Synthetic contact request for the child.' },
    maria,
  );
  assert.equal(req.status, 201, req.text);
  assert.equal(req.body.routedTo, 'guardian', "a minor's request is routed to the guardian");
  const ans = await S.j('POST', `/guardian/requests/${req.body.requestId}/respond`, { accept: true }, amara);
  assert.equal(ans.status, 200, ans.text);
  const channel = (await S.j('GET', '/guardian/channels', undefined, amara)).body.find(
    (c) => c.requestId === req.body.requestId,
  );
  assert.ok(channel?.id);
  return { requestId: req.body.requestId, channel };
}
/** One SSE stream for a session: the frames it receives, collected until `close()`. */
async function stream(S, token) {
  const t = await S.j('POST', '/events/ticket', {}, token);
  assert.equal(t.status, 200, t.text);
  const ctrl = new AbortController();
  const r = await fetch(`http://127.0.0.1:${S.port}/events?ticket=${encodeURIComponent(t.body.ticket)}`, {
    signal: ctrl.signal,
  });
  assert.equal(r.status, 200);
  const frames = [];
  let buffer = '';
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let i;
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const data = frame.split('\n').find((l) => l.startsWith('data: '));
          if (data) frames.push(JSON.parse(data.slice(6)));
        }
      }
    } catch {
      /* aborted */
    }
  })();
  await until(async () => frames.some((f) => f.event === 'connected'), 5000);
  return { frames, close: () => ctrl.abort() };
}

// ============================================================= [compat] the routes' behaviour
await test("[compat] both acceptance paths, all three sender kinds, both attachment shapes, the duplicate clientMsgId, the three receipt routes, typing, the per-audience views, the export and the admin audit: a contact request accepted by the ADULT player opens a player thread; one for the MINOR is routed to the guardian and opens a guardian thread; the org, the player and the guardian each post (sender kind, id and composed name as before); a clip attachment of the player's media and a filed trial report attach in their two shapes; a retried send with the same clientMsgId answers 201 with the SAME stored message and stores it once; receipts stamp readBy.org / readBy.counterparty and answer { readBy }; the player's and the guardian's views carry neither orgId nor guardianId, the org's carries orgId, the admin audit carries both; the stored threads equal the views in order and content; a restart serves the same", async () => {
  const dir = tempDir('s7d-compat');
  let S = await boot(dir);
  const maria = await orgLogin(S);
  let kola = await playerLogin(S, 'pl-adeyemi');
  const amara = await guardianLogin(S, 'gd-amara');
  assert.deepEqual((await S.j('GET', '/player/channels', undefined, kola)).body, []);
  assert.deepEqual(stored(dir), [], 'no thread before any acceptance');
  const { requestId: reqA, channel: adult } = await adultThread(S, maria, kola);
  assert.equal(adult.counterparty, 'player');
  assert.equal(adult.playerId, 'pl-adeyemi');
  assert.equal(adult.playerName, 'Kola Adeyemi');
  assert.equal(adult.orgName, 'Eastport FC');
  assert.equal(adult.scoutName, 'Maria Keane');
  assert.equal(adult.scoutRole, 'Head of Recruitment');
  assert.deepEqual(adult.messages, []);
  assert.deepEqual(adult.readBy, { org: null, counterparty: null });
  assert.equal(Object.hasOwn(adult, 'orgId'), false, "the player's view holds no orgId");
  assert.equal(Object.hasOwn(adult, 'guardianId'), false, 'nor a guardianId');
  const { requestId: reqG, channel: guardian } = await guardianThread(S, maria, amara);
  assert.equal(guardian.counterparty, 'guardian');
  assert.equal(guardian.playerId, 'pl-guni');
  assert.equal(Object.hasOwn(guardian, 'orgId'), false);
  assert.equal(Object.hasOwn(guardian, 'guardianId'), false, "the guardian's view holds no guardianId either");
  // The thread and the request's answer are durable together (the acceptance route's one unit).
  const st = snap(dir, (c) => ({ threads: readStored(c), requests: requestRows(c) }));
  assert.deepEqual(
    st.threads.map((c) => [c.id, c.requestId, c.playerId, c.orgId, c.counterparty, c.guardianId]),
    [
      [adult.id, reqA, 'pl-adeyemi', 'org-eastport', 'player', null],
      [guardian.id, reqG, 'pl-guni', 'org-eastport', 'guardian', 'gd-amara'],
    ],
    'stored in insertion order with the ids the views withhold',
  );
  assert.deepEqual(
    st.requests.filter((r) => [reqA, reqG].includes(r.id)).map((r) => [r.status, r.contactChannel]),
    [
      ['accepted', adult.id],
      ['accepted', guardian.id],
    ],
    "the request's status and contactChannel in the same committed state",
  );
  // The org's view carries orgId; the three audiences post.
  const orgView = (await S.j('GET', '/org/channels', undefined, maria)).body.items;
  assert.deepEqual(
    orgView.map((c) => c.id),
    [guardian.id, adult.id],
    'most recently active first',
  );
  assert.ok(orgView.every((c) => c.orgId === 'org-eastport' && !Object.hasOwn(c, 'guardianId')));
  const m1 = await S.j(
    'POST',
    `/org/channels/${adult.id}/messages`,
    { text: 'Synthetic club message to the player.' },
    maria,
  );
  assert.equal(m1.status, 201, m1.text);
  assert.deepEqual(m1.body.sender, {
    kind: 'org_user',
    id: m1.body.sender.id,
    name: 'Maria Keane · Head of Recruitment · Eastport FC',
  });
  assert.equal(m1.body.attachment, null);
  assert.equal(Object.hasOwn(m1.body, 'clientMsgId'), false, 'no clientMsgId key when the client sent none');
  const m2 = await S.j(
    'POST',
    `/player/channels/${adult.id}/messages`,
    { text: 'Synthetic reply with a clip.', attachMediaId: MEDIA_ID, clientMsgId: 'client-clip-1' },
    kola,
  );
  assert.equal(m2.status, 201, m2.text);
  assert.deepEqual(m2.body.sender, { kind: 'player', id: 'pl-adeyemi', name: 'Kola Adeyemi' });
  assert.equal(m2.body.clientMsgId, 'client-clip-1');
  assert.deepEqual(Object.keys(m2.body.attachment), ['kind', 'mediaId', 'title', 'url', 'verifiedClip']);
  assert.equal(m2.body.attachment.kind, 'clip');
  assert.equal(m2.body.attachment.mediaId, MEDIA_ID);
  assert.equal(m2.body.attachment.title, 'Match highlights vs Riverside');
  assert.equal(
    (await S.j('POST', `/player/channels/${adult.id}/messages`, { text: 'x', attachMediaId: 'media-unknown' }, kola))
      .body.error,
    'MEDIA_NOT_FOUND',
  );
  // a non-string text is junk: 400 TEXT_REQUIRED on all three sender routes, never a 500, nothing stored
  for (const [route, who] of [
    [`/player/channels/${adult.id}/messages`, kola],
    [`/org/channels/${adult.id}/messages`, maria],
    [`/guardian/channels/${guardian.id}/messages`, amara],
  ]) {
    for (const text of [5, ['x'], { t: 'x' }, true]) {
      const r = await S.j('POST', route, { text }, who);
      assert.equal(r.status, 400, `${route} ${JSON.stringify(text)}: ${r.text}`);
      assert.equal(r.body.error, 'TEXT_REQUIRED');
    }
  }
  // The duplicate: the same clientMsgId from the same sender answers the SAME message, stored once.
  const dup = await S.j(
    'POST',
    `/player/channels/${adult.id}/messages`,
    { text: 'Synthetic retry (must not duplicate).', clientMsgId: 'client-clip-1' },
    kola,
  );
  assert.equal(dup.status, 201);
  assert.deepEqual(dup.body, m2.body, 'the retried send answers the stored message');
  assert.equal((await S.j('GET', '/player/channels', undefined, kola)).body[0].messages.length, 2, 'stored once');
  const m3 = await S.j(
    'POST',
    `/org/channels/${guardian.id}/messages`,
    { text: 'Synthetic club message to the guardian.' },
    maria,
  );
  assert.equal(m3.status, 201, m3.text);
  const m4 = await S.j(
    'POST',
    `/guardian/channels/${guardian.id}/messages`,
    { text: 'Synthetic guardian reply.', clientMsgId: 'client-g-1' },
    amara,
  );
  assert.equal(m4.status, 201, m4.text);
  assert.deepEqual(m4.body.sender, { kind: 'guardian', id: 'gd-amara', name: m4.body.sender.name });
  assert.equal(typeof m4.body.sender.name, 'string');
  // A trial report attachment: a trial request accepted, the mandatory report filed, attached by the club in the player thread.
  const trialReq = await S.j(
    'POST',
    '/org/players/pl-adeyemi/request',
    {
      type: 'trial',
      message: 'Synthetic trial invitation.',
      proposedDate: '2026-12-05',
      altSlots: ['2026-12-12'],
      venue: 'Eastport Dome',
      notes: 'Synthetic.',
    },
    maria,
  );
  assert.equal(trialReq.status, 201, trialReq.text);
  assert.equal(
    (await S.j('POST', `/player/requests/${trialReq.body.requestId}/respond`, { accept: true }, kola)).status,
    200,
  );
  const trialThread = (await S.j('GET', '/player/channels', undefined, kola)).body.find(
    (c) => c.requestId === trialReq.body.requestId,
  );
  assert.ok(trialThread?.id, 'a trial acceptance opens a thread of its own too (as before)');
  assert.deepEqual(trialThread.messages, []);
  const trial = (await S.j('GET', '/org/trials', undefined, maria)).body.items.find(
    (t) => t.requestId === trialReq.body.requestId,
  );
  assert.ok(trial?.id, 'the accepted trial');
  const filed = await S.j('POST', `/org/trials/${trial.id}/report`, REPORT, maria);
  assert.equal(filed.status, 201, filed.text);
  const m5 = await S.j(
    'POST',
    `/org/channels/${adult.id}/messages`,
    { text: 'Synthetic message with the trial report.', attachTrialReportId: filed.body.report.id },
    maria,
  );
  assert.equal(m5.status, 201, m5.text);
  assert.deepEqual(m5.body.attachment, {
    kind: 'trial_report',
    reportId: filed.body.report.id,
    orgName: 'Eastport FC',
    summary: 'accel 7/10 · 31 km/h · 6.2 km · pass 78% · duels 55% · coach 8/10',
  });
  assert.equal(
    (
      await S.j(
        'POST',
        `/player/channels/${adult.id}/messages`,
        { text: 'x', attachTrialReportId: 'rep-unknown' },
        kola,
      )
    ).body.error,
    'TRIAL_REPORT_NOT_FOUND',
  );
  // Receipts, typing.
  const r1 = await S.j('POST', `/player/channels/${adult.id}/read`, {}, kola);
  assert.equal(r1.status, 200);
  assert.deepEqual(Object.keys(r1.body), ['readBy']);
  assert.equal(r1.body.readBy.org, null);
  assert.equal(typeof r1.body.readBy.counterparty, 'number');
  const r2 = await S.j('POST', `/org/channels/${adult.id}/read`, {}, maria);
  assert.equal(typeof r2.body.readBy.org, 'number');
  assert.equal(r2.body.readBy.counterparty, r1.body.readBy.counterparty);
  const r3 = await S.j('POST', `/guardian/channels/${guardian.id}/read`, {}, amara);
  assert.equal(typeof r3.body.readBy.counterparty, 'number');
  assert.equal(r3.body.readBy.org, null);
  assert.equal((await S.j('POST', `/player/channels/${adult.id}/typing`, {}, kola)).status, 200);
  assert.equal((await S.j('POST', `/guardian/channels/${guardian.id}/typing`, {}, amara)).status, 200);
  // The stored threads equal the views, in order and content.
  const expectThreads = (rows, label) => {
    assert.deepEqual(
      rows.map((c) => [c.id, c.messages.map((m) => m.id)]),
      [
        [adult.id, [m1.body.id, m2.body.id, m5.body.id]],
        [guardian.id, [m3.body.id, m4.body.id]],
        [trialThread.id, []],
      ],
      `${label}: threads in insertion order, messages in post order`,
    );
    assert.deepEqual(
      rows[0].messages.map((m) => [m.sender.kind, m.attachment?.kind ?? null, m.clientMsgId ?? '(absent)']),
      [
        ['org_user', null, '(absent)'],
        ['player', 'clip', 'client-clip-1'],
        ['org_user', 'trial_report', '(absent)'],
      ],
      label,
    );
    assert.deepEqual(
      rows[1].messages.map((m) => [m.sender.kind, m.clientMsgId ?? '(absent)']),
      [
        ['org_user', '(absent)'],
        ['guardian', 'client-g-1'],
      ],
      label,
    );
    assert.deepEqual(rows[0].readBy, r2.body.readBy, `${label}: the adult thread's receipts`);
    assert.deepEqual(rows[1].readBy, r3.body.readBy);
    assert.ok(
      rows[0].messages.every((m) => typeof m.ts === 'number' && Object.hasOwn(m, 'attachment')),
      `${label}: every message carries ts and the attachment key`,
    );
  };
  const admin = await adminAudit(S);
  expectThreads(admin, 'the admin audit');
  assert.deepEqual(
    admin.map((c) => [c.orgId, c.guardianId]),
    [
      ['org-eastport', null],
      ['org-eastport', 'gd-amara'],
      ['org-eastport', null],
    ],
    'the admin audit carries both ids',
  );
  const onDisk = stored(dir);
  expectThreads(onDisk, 'the database');
  assert.deepEqual(
    onDisk.map((c) => Object.keys(c)),
    admin.map((c) => Object.keys(c)),
    "the stored shape is the literal's shape, key for key",
  );
  assert.deepEqual(onDisk, admin, 'the stored threads equal the admin audit exactly');
  const pc = (await S.j('GET', '/player/channels', undefined, kola)).body;
  const gc = (await S.j('GET', '/guardian/channels', undefined, amara)).body;
  expectThreads([pc[0], gc[0], pc[1]], "the audiences' views");
  assert.equal((await S.j('GET', '/admin/overview', undefined, null, A)).body.channels, 3);
  const exp = (await S.j('GET', '/player/export', undefined, kola)).body;
  assert.deepEqual(
    exp.threads.map((c) => [c.id, c.messages.length]),
    [
      [adult.id, 3],
      [trialThread.id, 0],
    ],
  );
  assert.equal(Object.hasOwn(exp.threads[0], 'orgId'), false);
  const gexp = (await S.j('GET', '/guardian/export', undefined, amara)).body;
  assert.deepEqual(
    gexp.children.flatMap((c) => c.threads.map((t) => t.id)),
    [guardian.id],
    "the guardian's export carries the child's thread",
  );
  // A restart serves the same.
  await S.stop();
  S = await boot(dir);
  kola = await playerLogin(S, 'pl-adeyemi');
  assert.deepEqual(await adminAudit(S), admin, 'the restart serves the same threads');
  assert.deepEqual(
    (await S.j('GET', '/player/channels', undefined, kola)).body.map((c) => [c.id, c.messages.length]),
    [
      [adult.id, 3],
      [trialThread.id, 0],
    ],
  );
  await S.stop();
  rm(dir);
});

await test("[compat] privacy, visibility and the live lookup: another adult player lists no thread and gets 404 on the thread's routes; the guardian cannot post in the adult thread nor the player in the guardian thread (404); a child's own session cannot post (guardian-managed); the SSE stream of the player receives the `messages` event of its own thread and nothing of the guardian thread, the guardian's stream the reverse, the club's both; after the player BLOCKS the organisation both sides are refused with BLOCKED on a new message, the club's list marks the thread closed and the history stays (as before)", async () => {
  const dir = tempDir('s7d-privacy');
  const S = await boot(dir);
  const maria = await orgLogin(S);
  const kola = await playerLogin(S, 'pl-adeyemi');
  const amara = await guardianLogin(S, 'gd-amara');
  const mateus = await playerLogin(S, 'pl-carvalho');
  const { channel: adult } = await adultThread(S, maria, kola);
  const { channel: guardian } = await guardianThread(S, maria, amara);
  assert.deepEqual((await S.j('GET', '/player/channels', undefined, mateus)).body, []);
  for (const p of [
    `/player/channels/${adult.id}/messages`,
    `/player/channels/${adult.id}/read`,
    `/player/channels/${guardian.id}/messages`,
  ])
    assert.equal((await S.j('POST', p, { text: 'Synthetic intrusion.' }, mateus)).status, 404, p);
  assert.equal(
    (await S.j('POST', `/guardian/channels/${adult.id}/messages`, { text: 'Synthetic intrusion.' }, amara)).status,
    404,
  );
  assert.equal(
    (await S.j('POST', `/player/channels/${guardian.id}/messages`, { text: 'Synthetic intrusion.' }, kola)).status,
    404,
  );
  const guniLogin = await S.j('POST', '/auth/player/login', { playerId: 'pl-guni' });
  if (guniLogin.status === 200) {
    const childPost = await S.j(
      'POST',
      `/player/channels/${guardian.id}/messages`,
      { text: 'Synthetic child message.' },
      guniLogin.body.token,
    );
    assert.ok([403, 404].includes(childPost.status), `a child never posts (${childPost.status})`);
  }
  assert.deepEqual(
    stored(dir).map((c) => c.messages.length),
    [0, 0],
    'no intrusion stored',
  );
  const sk = await stream(S, kola);
  const sa = await stream(S, amara);
  const sm = await stream(S, maria);
  assert.equal(
    (await S.j('POST', `/org/channels/${adult.id}/messages`, { text: 'Synthetic to the player.' }, maria)).status,
    201,
  );
  assert.equal(
    (await S.j('POST', `/org/channels/${guardian.id}/messages`, { text: 'Synthetic to the guardian.' }, maria)).status,
    201,
  );
  assert.ok(
    await until(async () => sk.frames.some((f) => f.event === 'messages' && f.channelId === adult.id), 5000),
    "the player's stream got its thread's event",
  );
  assert.ok(
    await until(async () => sa.frames.some((f) => f.event === 'messages' && f.channelId === guardian.id), 5000),
    "the guardian's stream got its thread's event",
  );
  assert.ok(
    await until(async () => sm.frames.filter((f) => f.event === 'messages').length >= 2, 5000),
    "the club's stream got both",
  );
  await sleep(300);
  assert.equal(
    sk.frames.some((f) => f.channelId === guardian.id),
    false,
    'nothing of the guardian thread reached the player',
  );
  assert.equal(
    sa.frames.some((f) => f.channelId === adult.id),
    false,
    'nothing of the adult thread reached the guardian',
  );
  sk.close();
  sa.close();
  sm.close();
  assert.equal((await S.j('POST', '/player/block', { orgId: 'org-eastport', reason: 'synthetic' }, kola)).status, 201);
  const blocked = await S.j(
    'POST',
    `/player/channels/${adult.id}/messages`,
    { text: 'Synthetic after the block.' },
    kola,
  );
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error, 'BLOCKED');
  assert.equal((await S.j('GET', '/player/channels', undefined, kola)).body[0].messages.length, 1, 'the history stays');
  const clubBlocked = await S.j(
    'POST',
    `/org/channels/${adult.id}/messages`,
    { text: 'Synthetic club message after the block.' },
    maria,
  );
  assert.equal(clubBlocked.status, 403);
  assert.equal(clubBlocked.body.error, 'BLOCKED', "the club's side is closed by the same standing check, as before");
  assert.equal(
    (await S.j('GET', '/org/channels', undefined, maria)).body.items.find((c) => c.id === adult.id).closed,
    true,
    "the club's list marks the thread closed",
  );
  assert.deepEqual(
    stored(dir).map((c) => c.messages.length),
    [1, 1],
    'nothing new after the block; the history stays',
  );
  await S.stop();
  rm(dir);
});

await test("[compat] account deletion reproduces today's behaviour (D-B, as approved for this storage-only step): DELETE /player/account removes every thread of the adult — its messages, attachments and receipts with it — and leaves the other players' threads intact, the guardian–club thread included; DELETE /guardian/children/:id removes the child's guardian–club thread; the removals are committed when the routes answer (second connection), the club's list and the admin audit agree, and a restart changes nothing; no retention rule appears (the ledger rows of the threads stay, id-only)", async () => {
  const dir = tempDir('s7d-delete');
  let S = await boot(dir);
  const maria = await orgLogin(S);
  const kola = await playerLogin(S, 'pl-adeyemi');
  const amara = await guardianLogin(S, 'gd-amara');
  const mateus = await playerLogin(S, 'pl-carvalho');
  const { channel: adult } = await adultThread(S, maria, kola);
  const { channel: guardian } = await guardianThread(S, maria, amara);
  const { channel: other } = await adultThread(S, maria, mateus, 'pl-carvalho');
  assert.equal(
    (
      await S.j(
        'POST',
        `/player/channels/${adult.id}/messages`,
        { text: 'Synthetic with a clip.', attachMediaId: MEDIA_ID },
        kola,
      )
    ).status,
    201,
  );
  assert.equal(
    (await S.j('POST', `/org/channels/${guardian.id}/messages`, { text: 'Synthetic to the guardian.' }, maria)).status,
    201,
  );
  assert.equal(
    (await S.j('POST', `/player/channels/${other.id}/messages`, { text: 'Synthetic other player.' }, mateus)).status,
    201,
  );
  assert.equal((await S.j('POST', `/org/channels/${adult.id}/read`, {}, maria)).status, 200);
  const ledgerBefore = ledgerRows(dir).filter((l) => l.type === 'message').length;
  assert.deepEqual(
    storedIds(dir).map(([id, ms]) => [id, ms.length]),
    [
      [adult.id, 1],
      [guardian.id, 1],
      [other.id, 1],
    ],
  );
  assert.equal((await S.j('DELETE', '/player/account', {}, kola)).status, 200);
  assert.deepEqual(
    storedIds(dir).map(([id, ms]) => [id, ms.length]),
    [
      [guardian.id, 1],
      [other.id, 1],
    ],
    "the adult's thread went with its message when the route answered; the others stay",
  );
  if (live(dir))
    assert.deepEqual(
      snap(dir, (c) => [
        c.get('SELECT COUNT(*) AS n FROM messages').n,
        c.get('SELECT COUNT(*) AS n FROM message_attachments').n,
      ]),
      [2, 0],
      'its message and attachment rows went with it (the cascades)',
    );
  assert.deepEqual(
    (await S.j('GET', '/org/channels', undefined, maria)).body.items.map((c) => c.id),
    [other.id, guardian.id],
    'most recently active first',
  );
  assert.equal((await S.j('DELETE', `/guardian/children/pl-guni`, {}, amara)).status, 200);
  assert.deepEqual(
    storedIds(dir).map(([id]) => id),
    [other.id],
    "the guardian–club thread of the deleted child went too (today's behaviour, kept)",
  );
  assert.deepEqual((await S.j('GET', '/guardian/channels', undefined, amara)).body, []);
  assert.deepEqual(
    (await adminAudit(S)).map((c) => c.id),
    [other.id],
  );
  assert.equal(
    ledgerRows(dir).filter((l) => l.type === 'message').length,
    ledgerBefore,
    'the ledger rows stay (append-only, ids only)',
  );
  await S.stop();
  S = await boot(dir);
  assert.deepEqual(
    (await adminAudit(S)).map((c) => [c.id, c.messages.length]),
    [[other.id, 1]],
  );
  assert.deepEqual(
    (await S.j('GET', '/player/channels', undefined, await playerLogin(S, 'pl-carvalho'))).body.map((c) => c.id),
    [other.id],
    "the other player's thread is intact after the restart",
  );
  await S.stop();
  rm(dir);
});

// ============================================================= [cutover] the tables, the durable points, the crash windows
await test("[cutover] the cutover and the save points: a fresh boot records 0012_channels after 0011 and creates channels, messages and message_attachments and the file has no blob table (the data layer reports the domain); the thread opened by an acceptance is committed with the request's answer and survives a SIGKILL right after the response; a message is in the file before the sender hears 201 (SIGKILL right after); a message whose unit fails at the REAL COMMIT (internal:unit.sqlite_commit) is answered 500 and leaves no message and no ledger row, and the retry lands once at the next position; a receipt is in the file when its route answers", async () => {
  const dir = tempDir('s7d-cutover');
  let S = await boot(dir, { SCOUTBOX_FAST_SWEEPS: '' });
  assert.ok(live(dir), 'the boot recorded 0012');
  assert.deepEqual(
    snap(dir, (c) =>
      c
        .all('SELECT id FROM data_migrations ORDER BY applied_at, id')
        .map((r) => r.id)
        .filter((id) => id < '0019')
        .slice(-8),
    ),
    [
      '0011_outbox_push',
      MIGRATION,
      '0013_safety_audit',
      '0014_player_erasure',
      '0015_recruitment',
      '0016_recruitment_cases',
      '0017_recruitment_contacts_offers',
      '0018_signings_follow_ups',
    ],
  ); // 0013–0018 follow on the same boot
  for (const t of ['channels', 'messages', 'message_attachments'])
    assert.ok(q1(dir, "SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?", t), `${t} exists`);
  assert.equal(hasBlobTable(dir), false, 'no blob table');
  const cap = (await S.j('GET', '/capabilities')).body;
  const domains = cap?.persistence?.dataLayer?.domains ?? cap?.dataLayer?.domains ?? {};
  assert.ok(domains.channels, `the data layer reports the channels domain (${Object.keys(domains).join(', ')})`);
  const maria = await orgLogin(S);
  let kola = await playerLogin(S, 'pl-adeyemi');
  const req = await S.j(
    'POST',
    '/org/players/pl-adeyemi/request',
    { type: 'contact', message: 'Synthetic contact request.' },
    maria,
  );
  assert.equal(req.status, 201);
  const ans = await S.j('POST', `/player/requests/${req.body.requestId}/respond`, { accept: true }, kola);
  assert.equal(ans.status, 200, ans.text);
  await S.kill();
  const afterKill = snap(dir, (c) => ({
    threads: c.all('SELECT seq, id, request_id FROM channels ORDER BY seq'),
    request: requestRows(c).find((r) => r.id === req.body.requestId),
  }));
  assert.equal(
    afterKill.threads.length,
    1,
    'the thread is in the file although the process was killed right after the answer',
  );
  assert.equal(afterKill.threads[0].request_id, req.body.requestId);
  assert.equal(afterKill.request.status, 'accepted');
  assert.equal(
    afterKill.request.contactChannel,
    afterKill.threads[0].id,
    'the answer and the thread it opened are both in the file',
  );
  const channelId = afterKill.threads[0].id;
  S = await boot(dir, { SCOUTBOX_FAST_SWEEPS: '' });
  kola = await playerLogin(S, 'pl-adeyemi');
  const maria2 = await orgLogin(S);
  assert.deepEqual(
    (await S.j('GET', '/player/channels', undefined, kola)).body.map((c) => c.id),
    [channelId],
  );
  const m1 = await S.j(
    'POST',
    `/player/channels/${channelId}/messages`,
    { text: 'Synthetic message durable before 201.', attachMediaId: MEDIA_ID },
    kola,
  );
  assert.equal(m1.status, 201, m1.text);
  await S.kill();
  assert.deepEqual(
    snap(dir, (c) => c.all('SELECT id, position FROM messages WHERE channel_id = ? ORDER BY position', channelId)),
    [{ id: m1.body.id, position: 0 }],
    'the message is in the file when the sender hears 201',
  );
  assert.equal(q1(dir, 'SELECT kind FROM message_attachments WHERE message_id = ?', m1.body.id).kind, 'clip');
  // The real COMMIT failure (a message is one unit with its ledger row and notifications).
  S = await boot(dir, { SCOUTBOX_FAST_SWEEPS: '' });
  kola = await playerLogin(S, 'pl-adeyemi');
  const maria3 = await orgLogin(S);
  assert.equal((await S.j('POST', '/__faults', { rules: 'internal:unit.sqlite_commit:1' })).status, 200);
  const ledgerBefore = ledgerRows(dir).filter((l) => l.type === 'message').length;
  const m2 = await S.j(
    'POST',
    `/org/channels/${channelId}/messages`,
    { text: 'Synthetic message whose unit fails at COMMIT.' },
    maria3,
  );
  assert.equal(m2.status, 500, 'the sender hears the failure');
  assert.equal((await S.j('POST', '/__faults', { rules: '' })).status, 200);
  assert.deepEqual(
    snap(dir, (c) => c.all('SELECT id FROM messages WHERE channel_id = ? ORDER BY position', channelId)).map(
      (r) => r.id,
    ),
    [m1.body.id],
    'the message did not land',
  );
  assert.equal(ledgerRows(dir).filter((l) => l.type === 'message').length, ledgerBefore, 'nor its ledger row');
  assert.deepEqual(
    (await S.j('GET', '/org/channels', undefined, maria3)).body.items[0].messages.map((m) => m.id),
    [m1.body.id],
    'the thread reads as the file holds it',
  );
  const m3 = await S.j(
    'POST',
    `/org/channels/${channelId}/messages`,
    { text: 'Synthetic message whose unit fails at COMMIT.' },
    maria3,
  );
  assert.equal(m3.status, 201, 'the retry lands');
  assert.deepEqual(
    snap(dir, (c) => c.all('SELECT id, position FROM messages WHERE channel_id = ? ORDER BY position', channelId)),
    [
      { id: m1.body.id, position: 0 },
      { id: m3.body.id, position: 1 },
    ],
    'once, at the next position',
  );
  const rc = await S.j('POST', `/org/channels/${channelId}/read`, {}, maria3);
  assert.equal(rc.status, 200);
  assert.equal(
    q1(dir, 'SELECT read_by_org_at AS r FROM channels WHERE id = ?', channelId).r,
    rc.body.readBy.org,
    'the receipt is in the file when the route answers',
  );
  void maria;
  void maria2;
  await S.stop();
  rm(dir);
});

await test("[cutover] the admin backup and a restore: the backup's database copy holds the stored threads exactly; a restore into a NEW directory boots with them row for row (no blob table), the admin audit shows them, and a message appends after the restored ones", async () => {
  const dir = tempDir('s7d-backup');
  let S = await boot(dir);
  const maria = await orgLogin(S);
  let kola = await playerLogin(S, 'pl-adeyemi');
  const amara = await guardianLogin(S, 'gd-amara');
  const { channel: adult } = await adultThread(S, maria, kola);
  const { channel: guardian } = await guardianThread(S, maria, amara);
  assert.equal(
    (await S.j('POST', `/org/channels/${adult.id}/messages`, { text: 'Synthetic one.' }, maria)).status,
    201,
  );
  const clipMsg = await S.j(
    'POST',
    `/player/channels/${adult.id}/messages`,
    { text: 'Synthetic two with a clip.', attachMediaId: MEDIA_ID, clientMsgId: 'client-rb' },
    kola,
  );
  assert.equal(clipMsg.status, 201);
  assert.equal(
    (await S.j('POST', `/guardian/channels/${guardian.id}/messages`, { text: 'Synthetic guardian.' }, amara)).status,
    201,
  );
  assert.equal((await S.j('POST', `/org/channels/${adult.id}/read`, {}, maria)).status, 200);
  const original = stored(dir);
  assert.deepEqual(
    original.map((c) => c.messages.length),
    [2, 1],
  );
  const bk = await S.j('POST', '/admin/backup', {}, null, A);
  assert.equal(bk.status, 201, bk.text);
  assert.equal(
    JSON.stringify(stored(bk.body.dir)),
    JSON.stringify(original),
    "the backup's copy holds the stored threads exactly",
  );
  await S.stop();
  const restored = tempDir('s7d-restored');
  fs.cpSync(bk.body.dir, restored, { recursive: true });
  S = await boot(restored);
  assert.ok(live(restored));
  assert.equal(JSON.stringify(stored(restored)), JSON.stringify(original), 'row for row');
  assert.equal(hasBlobTable(restored), false, 'no blob table');
  const audit = await adminAudit(S);
  assert.equal(JSON.stringify(audit), JSON.stringify(original), 'the admin audit shows the restored threads');
  kola = await playerLogin(S, 'pl-adeyemi');
  const m = await S.j('POST', `/player/channels/${adult.id}/messages`, { text: 'Synthetic after the restore.' }, kola);
  assert.equal(m.status, 201, m.text);
  assert.deepEqual(
    stored(restored)[0].messages.map((x) => x.id),
    [...original[0].messages.map((x) => x.id), m.body.id],
  );
  await S.stop();
  rm(dir, restored);
});

console.log(`\n${passed} channel server checks passed`);
