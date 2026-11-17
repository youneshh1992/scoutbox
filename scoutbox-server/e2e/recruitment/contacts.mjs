// Acceptance suite — the Contact workflow.
//
// The governing principle this suite exists to enforce:
//
//   ScoutBox must never confuse internal interest with real contact, a drafted
//   message with a sent communication, or access to a player with permission
//   to contact them.
//
// The pure engine (U: states, actions, roles, content, recipient rule, cooldown) and the evidence and journey rules
// (V: a draft is not evidence; bodies never project) are checked in scripts/rules/recruitment/contacts.mjs. Here:
//
//   V  the registry, limits and schema, read from spec/ and the migrated schema
//   J  the adult journey over HTTP, with the recipient's own view at each step
//   D  hidden-draft privacy and enumeration
//   I  internal-note isolation with a sentinel, across every recipient surface
//   M  the minor journey — guardian route, direct contact refused, missing guardian
//   B  blocks, before and after, and the response rule
//   R  roles — contributor, downgrade, removal, foreign organisation, agency, unverified
//   K  idempotency, payload collision, stale rev, malformed rev, concurrency
//   F  honest transport failure and resend
//   C  cooldown and rate limit
//   X  content: XSS, moderation, prototype keys, Unicode
//   E  every refusal swept at once; the error contract
//   S  the subsystems Contact must not touch
//   Z  restart: idempotency and truth survive the process dying
//
// No assertion here is `status !== 200`. Every refusal names the status and
// the code it expects.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freePort } from '../support/testPort.mjs';
import { readRows } from '../support/sqlRows.mjs';
import { serverCommand, serverDir } from '../support/server.mjs';
import contactSpec from '../support/spec/recruitment/lifecycle/contact.json' with { type: 'json' };
import lifecycleErrors from '../support/spec/recruitment/lifecycle/errors.json' with { type: 'json' };
import eventSpec from '../support/spec/platform/eventRegistry.json' with { type: 'json' };
import rateSpec from '../support/spec/platform/rateLimit.json' with { type: 'json' };

const { CONTACT_LIMITS } = contactSpec;
const { LIFECYCLE_ERROR_HTTP } = lifecycleErrors;
const { EVENT_REGISTRY } = eventSpec;
const { RATE_LIMIT_POLICY } = rateSpec;
const httpStatusFor = (code) => LIFECYCLE_ERROR_HTTP[code] ?? null;
// The table migrations a new database records, as the migrated schema lists them.
const MIGRATIONS = (() => {
  const R = readRows(mkdtempSync(path.join(tmpdir(), 'sbx-m23c-schema-')));
  try {
    return R.rows('data_migrations').map((r) => r.id);
  } finally {
    R.close();
  }
})();
const LATEST_SCHEMA = Number(MIGRATIONS.at(-1).slice(0, 4)); // the latest table migration's number

const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23c-'));
const ADMIN = { 'x-admin-key': process.env.ADMIN_KEY || 'scoutbox-admin' };
const SENTINEL = 'PRIVATE_ROOM_SENTINEL_123';

let passed = 0;
let negatives = 0;
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};
const ok = (cond, msg) => {
  if (cond) {
    passed++;
    console.log(`✓ ${msg}`);
  } else fail(msg);
};
const neg = (cond, msg) => {
  negatives++;
  ok(cond, `[neg] ${msg}`);
};
const section = (name) => console.log(`\n— ${name} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Exact status AND exact code. */
const expect = (r, status, code, what) => {
  const good = r.status === status && (code === null || r.body?.error === code);
  if (!good) console.error(`   got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return good;
};

section('V — registry, limits and schema');
{
  for (const e of [
    'contact_created',
    'contact_sent',
    'contact_failed',
    'contact_external_recorded',
    'contact_responded',
  ]) {
    const def = EVENT_REGISTRY[e];
    ok(
      def && def.audience === 'org_private' && def.privacyClass === 'org_internal',
      `${e} is registered org_private / org_internal`,
    );
    neg(
      def.payload.every((k) => ['orgId', 'roomId', 'contactId'].includes(k)),
      `${e} carries ids only`,
    );
  }
  neg(!EVENT_REGISTRY.contact_created.notificationEligible, 'a draft can never become a notification');
  for (const a of ['contact_draft', 'contact_send', 'contact_external_record', 'contact_response'])
    ok(RATE_LIMIT_POLICY[a]?.max > 0, `rate-limit policy ${a} exists (${RATE_LIMIT_POLICY[a].max}/window)`);
  ok(
    RATE_LIMIT_POLICY.contact_response.scope === 'actor',
    "the response limit is per actor, so a club cannot exhaust a recipient's quota",
  );
  ok(
    MIGRATIONS.length === LATEST_SCHEMA && MIGRATIONS.includes('0017_recruitment_contacts_offers'),
    'the current schema: table migration 0017 creates the contacts (later steps may add migrations, never remove this one)',
  );
  for (const code of Object.keys(LIFECYCLE_ERROR_HTTP).filter((c) => c.startsWith('CONTACT_'))) {
    ok([400, 403, 404, 409, 422, 429, 500].includes(httpStatusFor(code)), `${code} → ${httpStatusFor(code)}`);
  }
}

// =================================================================== HTTP
section('HTTP — booting a real server');
const children = [];
process.on('exit', () => {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
});
async function boot() {
  const proc = spawn(...serverCommand(), {
    cwd: serverDir,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, SCOUTBOX_QUIET_LOGS: '1' },
    stdio: 'ignore',
  });
  children.push(proc);
  proc.unref();
  let up = false;
  for (let i = 0; i < 160 && !up; i++) {
    try {
      up = (await fetch(`${BASE}/healthz`)).ok;
    } catch {
      /* booting */
    }
    if (!up) await sleep(250);
  }
  if (!up) throw new Error('server did not come up');
  return proc;
}
let server = await boot();

async function j(method, url, body, token, extra = {}) {
  const r = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await r.json();
  } catch {
    /* non-json */
  }
  return { status: r.status, body: data, text: data === null ? await r.text().catch(() => '') : null };
}
const login = async (orgId, scoutName, role, platform) =>
  (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;
const playerLogin = async (playerId) => (await j('POST', '/auth/player/login', { playerId })).body;
const guardianLogin = async (guardianId) => (await j('POST', '/auth/guardian/login', { guardianId })).body;

/** Read SSE frames for a while, as one identity. */
async function sseCollect(token, ms) {
  const t = await j('POST', '/events/ticket', undefined, token);
  const ac = new AbortController();
  const frames = [];
  const res = await fetch(`${BASE}/events?ticket=${encodeURIComponent(t.body.ticket)}`, { signal: ac.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const done = (async () => {
    try {
      for (;;) {
        const { value, done: d } = await reader.read();
        if (d) break;
        frames.push(dec.decode(value));
      }
    } catch {
      /* aborted */
    }
  })();
  return {
    stop: async () => {
      await sleep(ms);
      ac.abort();
      await done;
      return frames.join('');
    },
  };
}

const ERROR_BODIES = [];
const collect = (label, r) => {
  if (r.status >= 400) ERROR_BODIES.push({ label, status: r.status, body: r.body });
  return r;
};

const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
const tom = await login('org-eastport', 'Tom Field', 'First-Team Scout');
const rita = await login('org-harbour', 'Rita Vale', 'Head of Recruitment');
const agent = await login('org-northstar', 'Tomás Rivera', 'Director');
const kola = await playerLogin('pl-adeyemi');
const guni = await playerLogin('pl-guni');
const amara = await guardianLogin('gd-amara');
const marek = await guardianLogin('gd-marek');
ok(
  [maria, tom, rita, agent, kola, guni, amara, marek].every((x) => x?.token),
  'HTTP actors logged in',
);

/** Open a room for a player and move it to contact_planned. */
async function planned(token, playerId) {
  const r = await j('POST', '/org/rooms', { playerId, sourceContext: 'search' }, token);
  if (r.status !== 201) throw new Error(`room for ${playerId}: ${r.status} ${JSON.stringify(r.body)}`);
  const RID = r.body.room.roomId;
  const jr = (await j('GET', `/org/rooms/${RID}/journey`, undefined, token)).body;
  const mv = await j('POST', `/org/rooms/${RID}/lifecycle`, { action: 'planContact', expectedRev: jr.case.rev }, token);
  if (mv.status !== 200) throw new Error(`planContact ${RID}: ${mv.status} ${JSON.stringify(mv.body)}`);
  return RID;
}
const stage = async (RID, token = maria.token) =>
  (await j('GET', `/org/rooms/${RID}/journey`, undefined, token)).body.lifecycle.currentStage;
/** Case TRANSITIONS only. The journey timeline also carries decisions and contact milestones, which are not case history. */
const historyLen = async (RID, token = maria.token) =>
  (await j('GET', `/org/rooms/${RID}/journey?limit=200`, undefined, token)).body.history.entries.filter(
    (e) => e.kind === 'room_status_changed',
  ).length;
let D_ROOM = null;
let M_ROOM = null;
let IMANI_ROOM = null;
let IMANI_DRAFT = null;
const K_PROBE = { room: null, contact: null, key: null };

// ================================================================= J — adult
section('J — the adult journey: draft is invisible, send is contact, response lands on the Contact');
const J = {};
{
  const roomBefore = await j('POST', '/org/rooms', { playerId: 'pl-adeyemi', sourceContext: 'search' }, maria.token);
  J.RID = roomBefore.body.room.roomId;
  const early = collect(
    'draft before planning',
    await j('POST', `/org/rooms/${J.RID}/contacts`, { body: 'Hello' }, maria.token),
  );
  neg(
    expect(early, 409, 'CONTACT_CASE_STATE', ''),
    'J0 a case at `watching` cannot start a contact — the club must first agree to approach (409 CONTACT_CASE_STATE)',
  );
  neg(
    Array.isArray(early.body.allowed) && early.body.allowed.includes('contact_planned'),
    'J0b and the refusal names the states that can',
  );
  const jr0 = (await j('GET', `/org/rooms/${J.RID}/journey`, undefined, maria.token)).body;
  await j('POST', `/org/rooms/${J.RID}/lifecycle`, { action: 'planContact', expectedRev: jr0.case.rev }, maria.token);
  ok((await stage(J.RID)) === 'contact_planned', 'J1 the case is at contact_planned');
  const inboxBefore = (await j('GET', '/player/inbox', undefined, kola.token)).body.items;
  const notifsBefore = (await j('GET', '/player/notifications', undefined, kola.token)).body;
  const outboxBefore = (await j('GET', '/admin/overview', undefined, undefined, ADMIN)).body.emailsSent; // the outbox pages; its size is the overview's count

  // Internal notes go in BEFORE anything is sent, so every recipient-facing
  // payload from here on is a leak test.
  await j('POST', `/org/rooms/${J.RID}/comments`, { body: `${SENTINEL} internal comment about attitude` }, maria.token);
  await j(
    'POST',
    `/org/rooms/${J.RID}/decisions`,
    {
      recommendation: 'shortlist',
      reasonCodes: ['position_need'],
      note: `${SENTINEL} decision note`,
      expectedRev: (await j('GET', `/org/rooms/${J.RID}`, undefined, maria.token)).body.room.rev,
    },
    maria.token,
  );
  await j('POST', `/org/rooms/${J.RID}/tasks`, { title: `${SENTINEL} task` }, maria.token);
  const roomView = await j('GET', `/org/rooms/${J.RID}`, undefined, maria.token);
  ok(
    JSON.stringify(roomView.body).includes(SENTINEL),
    'J1b the sentinel really is stored and visible to the club — the leak checks below are not vacuous',
  );
  J.histAtPlanned = await historyLen(J.RID);

  // The draft.
  const sseP = await sseCollect(kola.token, 600);
  const draft = await j(
    'POST',
    `/org/rooms/${J.RID}/contacts`,
    {
      subject: 'Interest from Eastport',
      body: 'Hi Kola, we would like to talk about your plans for next season.',
      clientKey: 'J-create',
    },
    maria.token,
  );
  ok(draft.status === 201 && draft.body.contact.status === 'draft', 'J2 a draft is created (201, status draft)');
  J.CID = draft.body.contact.id;
  ok(
    draft.body.routing.available === true && draft.body.routing.type === 'player' && draft.body.routing.minor === false,
    'J2b with a live routing preview: this will reach the player directly',
  );
  ok(draft.body.contact.recipient === null, 'J2c and NO resolved recipient yet — that is decided at send');
  neg((await stage(J.RID)) === 'contact_planned', 'J3 the case did NOT move — a draft is not contact');
  neg((await historyLen(J.RID)) === J.histAtPlanned, 'J3b and no case history entry was written');
  neg(
    JSON.stringify((await j('GET', '/player/inbox', undefined, kola.token)).body.items) === JSON.stringify(inboxBefore),
    "J4 the player's Inbox is unchanged — the draft is invisible",
  );
  neg(
    (await j('GET', '/player/notifications', undefined, kola.token)).body.length === notifsBefore.length,
    'J4b and the player was not notified',
  );
  neg(
    (await j('GET', '/admin/overview', undefined, undefined, ADMIN)).body.emailsSent === outboxBefore,
    'J4c and nothing was queued to the outbox',
  );
  neg(
    (await j('GET', '/org/requests', undefined, maria.token)).body.items.every((r) => r.contactId !== J.CID),
    'J4d and no request row exists for it',
  );
  const sseFrames = await sseP.stop();
  neg(
    !sseFrames.includes(J.CID) && !/contact_created/.test(sseFrames),
    "J4e the player's live stream carried no contact event and no contact id during the draft",
  );

  // Edit with the rev.
  const edit = await j(
    'PATCH',
    `/org/rooms/${J.RID}/contacts/${J.CID}`,
    {
      body: 'Hi Kola, we would like to talk about your plans for next season. Would a call suit you?',
      expectedRev: draft.body.contact.rev,
    },
    maria.token,
  );
  ok(
    edit.status === 200 && edit.body.contact.rev === draft.body.contact.rev + 1,
    'J5 an edit with the right rev is applied and moves the rev by one',
  );
  const stale = collect(
    'stale edit',
    await j(
      'PATCH',
      `/org/rooms/${J.RID}/contacts/${J.CID}`,
      { body: 'stale', expectedRev: draft.body.contact.rev },
      maria.token,
    ),
  );
  neg(
    expect(stale, 409, 'CONTACT_VERSION_CONFLICT', ''),
    'J5b an edit on the old rev is refused 409 CONTACT_VERSION_CONFLICT',
  );
  ok(
    (await j('GET', `/org/rooms/${J.RID}/contacts/${J.CID}`, undefined, maria.token)).body.contact.body.endsWith(
      'suit you?',
    ),
    'J5c and nothing of the stale edit landed',
  );

  // Send.
  const sseS = await sseCollect(kola.token, 800);
  const sent = await j(
    'POST',
    `/org/rooms/${J.RID}/contacts/${J.CID}/send`,
    { expectedRev: edit.body.contact.rev, clientKey: 'J-send' },
    maria.token,
  );
  ok(
    sent.status === 200 && sent.body.delivered === true && sent.body.contact.status === 'delivered',
    'J6 send hands the message to the in-app transport: delivered',
  );
  ok(
    sent.body.contact.sentAt === sent.body.contact.deliveredAt,
    'J6b sentAt and deliveredAt are ONE clock reading for the in-app transport',
  );
  ok(sent.body.contact.recipient?.type === 'player', 'J6c the recipient was resolved at send: the player');
  ok(
    sent.body.case?.from === 'contact_planned' && sent.body.case?.to === 'contacted',
    'J7 and the case moved contact_planned → contacted, through the lifecycle',
  );
  ok((await stage(J.RID)) === 'contacted', 'J7b the journey confirms it');
  ok((await historyLen(J.RID)) === J.histAtPlanned + 1, 'J7c exactly one case history entry was appended');
  const jrS = (await j('GET', `/org/rooms/${J.RID}/journey`, undefined, maria.token)).body;
  const moved = jrS.history.entries.find((e) => e.to === 'contacted');
  ok(
    moved && moved.reasonCodes.length === 0 && moved.kind === 'room_status_changed',
    'J7d it is the same room_status_changed entry the analytics funnel reads',
  );
  ok(
    jrS.contact.contacts.some((c) => c.id === J.CID && c.status === 'delivered'),
    'J7e the journey lists the contact milestone',
  );
  const inboxAfter = (await j('GET', '/player/inbox', undefined, kola.token)).body.items;
  J.request = inboxAfter.find((r) => r.type === 'contact' && r.subject === 'Interest from Eastport');
  ok(!!J.request && J.request.status === 'pending', "J8 the player's Inbox now holds the contact, pending");
  ok(
    J.request.message.endsWith('suit you?') &&
      J.request.scoutName === 'Maria Keane' &&
      J.request.orgName === 'Eastport FC',
    'J8b with the shared message, the named sender and the club',
  );
  neg(
    !('contactId' in J.request) && !('orgId' in J.request) && !('userId' in J.request),
    'J8c and no internal id — no contact id, no org id, no user id',
  );
  const notifsAfter = (await j('GET', '/player/notifications', undefined, kola.token)).body;
  ok(
    notifsAfter.length === notifsBefore.length + 1 && notifsAfter[0].type === 'request',
    'J8d the player was notified once, through the existing request notification',
  );
  const sseSent = await sseS.stop();
  ok(/"event":"(inbox|notify)"/.test(sseSent), "J8e the player's stream got the existing inbox/notify ping");
  neg(
    !sseSent.includes(SENTINEL) && !sseSent.includes('suit you') && !sseSent.includes(J.CID),
    'J8f and the stream carried no message text, no sentinel and no contact id',
  );

  // Resend of a delivered contact.
  const again = collect(
    'send twice',
    await j(
      'POST',
      `/org/rooms/${J.RID}/contacts/${J.CID}/send`,
      { expectedRev: sent.body.contact.rev, clientKey: 'J-send-2' },
      maria.token,
    ),
  );
  neg(
    expect(again, 409, 'CONTACT_ALREADY_SENT', ''),
    'J9 sending a delivered contact again is refused 409 CONTACT_ALREADY_SENT',
  );
  neg(
    (await j('GET', '/player/inbox', undefined, kola.token)).body.items.filter((r) => r.type === 'contact').length ===
      1,
    'J9b and the player still has exactly one',
  );

  // The response.
  const tomNotifsBefore = (await j('GET', '/org/notifications', undefined, tom.token)).body.length;
  const respond = await j(
    'POST',
    `/player/requests/${J.request.id}/respond`,
    { accept: true, message: 'Yes, happy to talk next week.' },
    kola.token,
  );
  ok(
    respond.status === 200 && respond.body.status === 'accepted',
    'J10 the player accepts through the existing respond route, with a short reply',
  );
  const cAfter = (await j('GET', `/org/rooms/${J.RID}/contacts/${J.CID}`, undefined, maria.token)).body.contact;
  ok(
    cAfter.status === 'responded' &&
      cAfter.response?.kind === 'accepted' &&
      cAfter.response.message === 'Yes, happy to talk next week.' &&
      cAfter.response.by === 'player',
    'J10b the Contact records the response: accepted, by the player, with the reply',
  );
  ok(cAfter.respondedAt === cAfter.response.at, 'J10c one clock for the response');
  neg(
    (await stage(J.RID)) === 'contacted',
    'J11 the case did NOT gain a "responded" stage — the response belongs to the Contact',
  );
  ok(
    cAfter.history.map((h) => h.action).join(',') === 'contact_created,contact_edited,contact_sent,contact_responded',
    'J11b the Contact history is complete and append-only, in order',
  );
  const mariaNotifs = (await j('GET', '/org/notifications', undefined, maria.token)).body;
  ok(
    mariaNotifs.some((n) => n.type === 'accepted'),
    'J12 the sender is told the player accepted',
  );
  neg(
    (await j('GET', '/org/notifications', undefined, tom.token)).body.length === tomNotifsBefore,
    'J12b a colleague who is neither sender, owner nor lead is NOT notified',
  );
  const respondTwice = collect(
    'respond twice',
    await j('POST', `/player/requests/${J.request.id}/respond`, { accept: false }, kola.token),
  );
  neg(expect(respondTwice, 409, 'ALREADY_RESPONDED', ''), 'J13 a second response is refused 409 ALREADY_RESPONDED');
  ok(
    (await j('GET', `/org/rooms/${J.RID}/contacts/${J.CID}`, undefined, maria.token)).body.contact.response.kind ===
      'accepted',
    'J13b and the first answer stands',
  );
  const jrR = (await j('GET', `/org/rooms/${J.RID}/journey`, undefined, maria.token)).body;
  ok(
    jrR.history.entries.some((e) => e.kind === 'contact_response_received' && e.responseKind === 'accepted'),
    'J14 the journey shows the safe milestone "response received"',
  );
  neg(!JSON.stringify(jrR).includes('happy to talk'), 'J14b and not the reply text');
  const audit = (await j('GET', '/org/audit?limit=50', undefined, maria.token)).body;
  ok(
    audit.items.some((i) => i.action === 'contact_sent' && i.domain === 'recruitment_contact') &&
      audit.items.some((i) => i.action === 'contact_responded'),
    'J15 the organisation audit feed records the send and the response',
  );
  neg(
    !JSON.stringify(audit).includes(SENTINEL) &&
      !JSON.stringify(audit).includes('suit you') &&
      !JSON.stringify(audit).includes('happy to talk'),
    'J15b content-free',
  );

  // External record on the same case (already contacted): no second transition.
  const histNow = await historyLen(J.RID);
  const ext = await j(
    'POST',
    `/org/rooms/${J.RID}/contacts/external`,
    {
      channel: 'phone',
      occurredAt: Date.now() - 600_000,
      summary: 'Phoned to confirm the call time.',
      recipientType: 'player',
      clientKey: 'J-ext',
    },
    maria.token,
  );
  ok(
    ext.status === 201 && ext.body.contact.status === 'recorded' && ext.body.contact.channel === 'phone',
    'J16 a phone call is recorded as an external contact (201, recorded)',
  );
  ok(
    ext.body.case?.unchanged === true && (await historyLen(J.RID)) === histNow,
    'J16b the case was already contacted: no second transition, no second history entry',
  );
  ok(
    ext.body.contact.recordedBy?.name === 'Maria Keane' && typeof ext.body.contact.occurredAt === 'number',
    'J16c attributed to the named person, with the time they say it happened',
  );
  neg(
    (await j('GET', '/player/inbox', undefined, kola.token)).body.items.filter((r) => r.type === 'contact').length ===
      1,
    "J16d it created nothing in the player's Inbox — a recorded contact has no recipient object",
  );
  J.EXT = ext.body.contact.id;
}

// ==================================================================== D
section('D — hidden-draft privacy and enumeration');
{
  const RID = await planned(maria.token, 'pl-svensson');
  const elias = await playerLogin('pl-svensson');
  const draft = await j(
    'POST',
    `/org/rooms/${RID}/contacts`,
    { body: 'Draft only, never sent.', subject: 'Quiet' },
    maria.token,
  );
  const CID = draft.body.contact.id;
  neg(
    (await j('GET', '/player/inbox', undefined, elias.token)).body.items.length === 0,
    'D1 a player with a draft against them has an empty Inbox',
  );
  neg((await j('GET', '/player/notifications', undefined, elias.token)).body.length === 0, 'D1b and no notification');
  neg(
    (await j('GET', '/player/insights', undefined, elias.token)).body.recent.every((r) => !/contact/.test(r.type)),
    'D1c and no insight row about a contact',
  );
  const real = await j('GET', `/player/contacts/${CID}`, undefined, elias.token);
  const fake = await j('GET', '/player/contacts/rct-999999', undefined, elias.token);
  neg(
    real.status === 404 &&
      fake.status === 404 &&
      (real.text ?? JSON.stringify(real.body)) === (fake.text ?? JSON.stringify(fake.body)),
    'D2 a guessed draft id and an impossible id answer byte-identically to the player — there is no player contact route to probe',
  );
  const realG = await j('GET', `/guardian/contacts/${CID}`, undefined, amara.token);
  const fakeG = await j('GET', '/guardian/contacts/rct-999999', undefined, amara.token);
  neg(
    realG.status === 404 && (realG.text ?? JSON.stringify(realG.body)) === (fakeG.text ?? JSON.stringify(fakeG.body)),
    'D2b and to a guardian',
  );
  const exp = (await j('GET', '/player/export', undefined, elias.token)).body;
  neg(
    !JSON.stringify(exp).includes(CID) && !JSON.stringify(exp).includes('never sent'),
    "D3 the player's data export holds no trace of the draft",
  );
  // Cancel keeps the text, records the act.
  const cancel = await j(
    'POST',
    `/org/rooms/${RID}/contacts/${CID}/cancel`,
    { expectedRev: draft.body.contact.rev },
    maria.token,
  );
  ok(
    cancel.status === 200 &&
      cancel.body.contact.status === 'cancelled' &&
      cancel.body.contact.body === 'Draft only, never sent.',
    'D4 cancelling keeps what was written and records that nothing was sent',
  );
  neg(
    expect(
      collect(
        'send cancelled',
        await j(
          'POST',
          `/org/rooms/${RID}/contacts/${CID}/send`,
          { expectedRev: cancel.body.contact.rev },
          maria.token,
        ),
      ),
      409,
      'CONTACT_INVALID_STATE',
      '',
    ),
    'D4b a cancelled draft cannot be sent',
  );
  neg((await stage(RID)) === 'contact_planned', 'D4c the case never moved');
  D_ROOM = RID;
}

// ==================================================================== I
section('I — internal-note isolation: the sentinel reaches no recipient surface');
{
  const surfaces = {
    'player inbox': (await j('GET', '/player/inbox', undefined, kola.token)).body.items,
    'player notifications': (await j('GET', '/player/notifications', undefined, kola.token)).body,
    'player channels': (await j('GET', '/player/channels', undefined, kola.token)).body,
    'player export': (await j('GET', '/player/export', undefined, kola.token)).body,
    'player insights': (await j('GET', '/player/insights', undefined, kola.token)).body,
    'player feed': (await j('GET', '/player/feed', undefined, kola.token)).body,
    'guardian inbox': (await j('GET', '/guardian/inbox', undefined, amara.token)).body.items,
    'guardian notifications': (await j('GET', '/guardian/notifications', undefined, amara.token)).body,
    'guardian log': (await j('GET', '/guardian/log?limit=100', undefined, amara.token)).body.items,
    outbox: (await j('GET', '/admin/outbox', undefined, undefined, ADMIN)).body,
    'push log': (await j('GET', '/admin/push-log', undefined, undefined, ADMIN)).body,
    'foreign org journey': (await j('GET', `/org/rooms/${J.RID}/journey`, undefined, rita.token)).body,
    'foreign org contacts': (await j('GET', `/org/rooms/${J.RID}/contacts`, undefined, rita.token)).body,
  };
  ok(surfaces['player inbox'].length >= 1, 'I0 the player surfaces are populated, so the sweep is not vacuous');
  for (const [name, body] of Object.entries(surfaces)) {
    neg(!JSON.stringify(body ?? {}).includes(SENTINEL), `I1 ${name} carries no internal note`);
  }
  // Deep-link metadata: the notification refId is the request id, never a case or contact id.
  const n = (await j('GET', '/player/notifications', undefined, kola.token)).body.find((x) => x.type === 'request');
  ok(n && /^req-/.test(n.refId), "I2 the player's notification deep-links to the request, not to a case or a Contact");
  neg(
    !/rct-|case-/.test(JSON.stringify(surfaces['player notifications'])),
    'I2b no case id and no Contact id in any player notification',
  );
  // The registry: no contact event may name anything but ids.
  neg(
    Object.entries(EVENT_REGISTRY)
      .filter(([k]) => k.startsWith('contact_'))
      .every(([, d]) => !d.payload.some((p) => /body|subject|note|message/i.test(p))),
    'I3 no contact event payload can carry text',
  );
}

// ==================================================================== M
section('M — the minor journey: guardian route, no direct contact, missing guardian fails closed');
{
  const RID = await planned(maria.token, 'pl-guni');
  const draft = await j(
    'POST',
    `/org/rooms/${RID}/contacts`,
    { subject: 'About Guni', body: 'We would like to discuss Guni joining our U15 programme.', clientKey: 'M-create' },
    maria.token,
  );
  ok(
    draft.status === 201 && draft.body.routing.type === 'guardian' && draft.body.routing.minor === true,
    'M1 the routing preview says: this will reach the guardian',
  );
  const direct = collect(
    'external minor as player',
    await j(
      'POST',
      `/org/rooms/${RID}/contacts/external`,
      { channel: 'phone', occurredAt: Date.now(), recipientType: 'player' },
      maria.token,
    ),
  );
  neg(
    expect(direct, 400, 'CONTACT_RECIPIENT_MISMATCH', ''),
    'M2 recording direct contact WITH the child is refused 400 CONTACT_RECIPIENT_MISMATCH',
  );
  const guniInboxBefore = (await j('GET', '/player/inbox', undefined, guni.token)).body.items;
  const sent = await j(
    'POST',
    `/org/rooms/${RID}/contacts/${draft.body.contact.id}/send`,
    { expectedRev: draft.body.contact.rev, clientKey: 'M-send' },
    maria.token,
  );
  ok(
    sent.status === 200 &&
      sent.body.contact.recipient?.type === 'guardian' &&
      sent.body.contact.recipient.minor === true,
    'M3 send resolves the guardian as the recipient',
  );
  ok(sent.body.case?.to === 'contacted', 'M3b a guardian-routed delivery satisfies contact_delivered');
  const gInbox = (await j('GET', '/guardian/inbox', undefined, amara.token)).body.items;
  const gReq = gInbox.find((r) => r.type === 'contact' && r.subject === 'About Guni');
  ok(
    !!gReq && gReq.routedTo === 'guardian' && gReq.playerName === 'Guni Adebayo',
    "M4 the guardian's Inbox holds it, naming the child and the club",
  );
  const childInbox = (await j('GET', '/player/inbox', undefined, guni.token)).body.items;
  const childItem = childInbox.find((r) => r.type === 'contact');
  ok(childItem && childItem.guardianManaged === true, 'M5 the child sees only a guardian-managed status note');
  neg(
    !('message' in childItem) && !('subject' in childItem) && !JSON.stringify(childItem).includes('U15 programme'),
    "M5b the child never sees the club's message",
  );
  neg(childInbox.length === guniInboxBefore.length + 1, 'M5c exactly one status item');
  neg(
    expect(
      collect('child responds', await j('POST', `/player/requests/${gReq.id}/respond`, { accept: true }, guni.token)),
      403,
      'GUARDIAN_MANAGED',
      '',
    ),
    'M6 the child cannot respond — 403 GUARDIAN_MANAGED',
  );
  neg(
    expect(
      collect('child channels', {
        status: 200,
        body: (await j('GET', '/player/channels', undefined, guni.token)).body,
      }),
      200,
      null,
      '',
    ) && (await j('GET', '/player/channels', undefined, guni.token)).body.length === 0,
    'M6b and has no channel',
  );
  await sleep(50);
  const cM = (await j('GET', `/org/rooms/${RID}/contacts/${draft.body.contact.id}`, undefined, maria.token)).body
    .contact;
  ok(
    cM.emailCopy?.state === 'local_outbox' && cM.emailCopy.to === 'guardian',
    'M7 the guardian got a courtesy email copy, honestly labelled local_outbox — never "delivered"',
  );
  const outbox = (await j('GET', '/admin/outbox', undefined, undefined, ADMIN)).body.items;
  const mail = outbox.find((m) => m.id === cM.emailCopy.outboxId);
  ok(mail && mail.to === 'amara.adebayo@example.com', 'M7b the outbox record is addressed to the guardian');
  neg(
    !mail.text.includes('U15 programme') && !mail.text.includes(SENTINEL),
    'M7c and carries no message body — it says something is waiting in ScoutBox',
  );
  const resp = await j(
    'POST',
    `/guardian/requests/${gReq.id}/respond`,
    { accept: false, message: 'Thank you, not this season.' },
    amara.token,
  );
  ok(resp.status === 200 && resp.body.status === 'declined', 'M8 the guardian declines with a reply');
  const cAfter = (await j('GET', `/org/rooms/${RID}/contacts/${draft.body.contact.id}`, undefined, maria.token)).body
    .contact;
  ok(
    cAfter.status === 'responded' && cAfter.response.kind === 'declined' && cAfter.response.by === 'guardian',
    'M8b the Contact records: declined, by the guardian',
  );
  neg((await stage(RID)) === 'contacted', 'M8c the case stays at contacted — a decline is not a case state');
  M_ROOM = RID;

  // Missing guardian path: Tomasz (16, guardian Marek). Revoke Marek's IDV.
  const RID2 = await planned(maria.token, 'pl-tomasz');
  const d2 = await j('POST', `/org/rooms/${RID2}/contacts`, { body: 'About Tomasz.' }, maria.token);
  ok(d2.status === 201, 'M9 a draft for Tomasz while his guardian is verified');
  const revoke = await j('POST', '/admin/guardians/gd-marek/idv', { approved: false }, undefined, ADMIN);
  ok(
    revoke.status === 200 && revoke.body.idVerified === false,
    "M9b Trust & Safety revokes the guardian's identity verification",
  );
  const noRoute = collect(
    'missing guardian',
    await j(
      'POST',
      `/org/rooms/${RID2}/contacts/${d2.body.contact.id}/send`,
      { expectedRev: d2.body.contact.rev },
      maria.token,
    ),
  );
  neg(
    expect(noRoute, 422, 'CONTACT_GUARDIAN_REQUIRED', ''),
    'M10 with no valid guardian route the send FAILS CLOSED — 422 CONTACT_GUARDIAN_REQUIRED, no direct fallback',
  );
  neg((await stage(RID2)) === 'contact_planned', 'M10b the case did not move');
  neg(
    (await j('GET', '/guardian/inbox', undefined, marek.token)).body.items.every(
      (r) => r.playerId !== 'pl-tomasz' || r.type !== 'contact',
    ),
    'M10c and nothing reached the unverified guardian',
  );
  neg(
    (await j('GET', '/player/inbox', undefined, (await playerLogin('pl-tomasz')).token)).body.items.length === 0,
    'M10d nor the child',
  );
  neg(
    (await j('GET', `/org/rooms/${RID2}/contacts/${d2.body.contact.id}`, undefined, maria.token)).body.contact
      .status === 'draft',
    'M10e the draft is still a draft — a refused send is not an attempt',
  );
  neg(
    expect(
      collect(
        'external missing guardian',
        await j(
          'POST',
          `/org/rooms/${RID2}/contacts/external`,
          { channel: 'phone', occurredAt: Date.now(), recipientType: 'guardian' },
          maria.token,
        ),
      ),
      422,
      'CONTACT_GUARDIAN_REQUIRED',
      '',
    ),
    'M10f recording an external contact with a guardian who cannot be validated is refused too',
  );
  await j('POST', '/admin/guardians/gd-marek/idv', { approved: true }, undefined, ADMIN);
  const restored = await j(
    'POST',
    `/org/rooms/${RID2}/contacts/${d2.body.contact.id}/send`,
    { expectedRev: d2.body.contact.rev },
    maria.token,
  );
  ok(
    restored.status === 200 && restored.body.contact.recipient.type === 'guardian',
    'M11 once the guardian is verified again the same draft sends to them',
  );

  // Imani: 18, but still guardian-linked. Adult by the canonical rule → the player.
  const RID3 = await planned(maria.token, 'pl-imani');
  const d3 = await j('POST', `/org/rooms/${RID3}/contacts`, { body: 'Hi Imani.' }, maria.token);
  ok(
    d3.body.routing.type === 'player',
    'M12 a guardian-linked player who has turned 18 is routed to themselves, by isAdult and nothing else',
  );
  IMANI_ROOM = RID3;
  IMANI_DRAFT = d3.body.contact;
}

// ==================================================================== B
section('B — blocks: before compose, after compose, after delivery');
{
  // Block before compose.
  const osei = await playerLogin('pl-osei');
  const RID = await planned(maria.token, 'pl-osei');
  await j('POST', '/player/block', { orgId: 'org-eastport', reason: 'no thanks' }, osei.token);
  neg(
    expect(
      collect('draft when blocked', await j('POST', `/org/rooms/${RID}/contacts`, { body: 'Hello' }, maria.token)),
      403,
      'CONTACT_BLOCKED',
      '',
    ),
    'B1 a block placed before compose refuses the draft — 403 CONTACT_BLOCKED',
  );
  neg(
    expect(
      collect(
        'external when blocked',
        await j(
          'POST',
          `/org/rooms/${RID}/contacts/external`,
          { channel: 'phone', occurredAt: Date.now(), recipientType: 'player' },
          maria.token,
        ),
      ),
      403,
      'CONTACT_BLOCKED',
      '',
    ),
    'B1b and an external record',
  );

  // Block after compose, before send.
  const kim = await playerLogin('pl-kim');
  const RID2 = await planned(maria.token, 'pl-kim');
  const d = await j('POST', `/org/rooms/${RID2}/contacts`, { body: 'Hi Min-jae.' }, maria.token);
  ok(d.status === 201, 'B2 a draft exists before the block');
  await j('POST', '/player/block', { orgId: 'org-eastport' }, kim.token);
  neg(
    expect(
      collect(
        'send after block',
        await j(
          'POST',
          `/org/rooms/${RID2}/contacts/${d.body.contact.id}/send`,
          { expectedRev: d.body.contact.rev },
          maria.token,
        ),
      ),
      403,
      'CONTACT_BLOCKED',
      '',
    ),
    'B3 a block placed after compose refuses the send — the mutation re-checks',
  );
  neg(
    (await stage(RID2)) === 'contact_planned' &&
      (await j('GET', '/player/inbox', undefined, kim.token)).body.items.length === 0,
    'B3b the case did not move and the player received nothing',
  );
  neg(
    (await j('GET', `/org/rooms/${RID2}/contacts/${d.body.contact.id}`, undefined, maria.token)).body.contact.status ===
      'draft',
    'B3c the draft remains a draft, historically',
  );

  // Block after delivery: history stays; accept refused; decline allowed.
  const imani = await playerLogin('pl-imani');
  const s = await j(
    'POST',
    `/org/rooms/${IMANI_ROOM}/contacts/${IMANI_DRAFT.id}/send`,
    { expectedRev: IMANI_DRAFT.rev },
    maria.token,
  );
  ok(s.status === 200, 'B4 a contact is delivered to Imani');
  await j('POST', '/player/block', { orgId: 'org-eastport' }, imani.token);
  const cView = await j('GET', `/org/rooms/${IMANI_ROOM}/contacts/${IMANI_DRAFT.id}`, undefined, maria.token);
  ok(
    cView.status === 200 && cView.body.contact.status === 'delivered',
    "B5 after the block the club's historical record of the delivered contact remains",
  );
  const req = (await j('GET', '/player/inbox', undefined, imani.token)).body.items.find((r) => r.type === 'contact');
  neg(
    expect(
      collect(
        'accept after block',
        await j('POST', `/player/requests/${req.id}/respond`, { accept: true }, imani.token),
      ),
      403,
      'BLOCKED',
      '',
    ),
    "B6 accepting a blocked organisation's contact is refused 403 BLOCKED — it would open a thread",
  );
  const dec = await j('POST', `/player/requests/${req.id}/respond`, { accept: false }, imani.token);
  ok(
    dec.status === 200 && dec.body.status === 'declined',
    "B6b declining it is allowed — the block is the player's own act",
  );
  neg(
    (await j('GET', `/org/rooms/${IMANI_ROOM}/contacts/${IMANI_DRAFT.id}`, undefined, maria.token)).body.contact
      .response?.kind === 'declined',
    'B6c and the Contact records the decline',
  );
  const jrB = await j('GET', `/org/rooms/${IMANI_ROOM}/journey`, undefined, maria.token);
  neg(
    jrB.status === 200 && !JSON.stringify(jrB.body).includes('Imani'),
    'B7 the journey still projects and names no player — there is no player data in it for the block to stop',
  );
  const room = (await j('GET', `/org/rooms/${IMANI_ROOM}`, undefined, maria.token)).body.room;
  neg(room.playerAvailable === false && room.playerName === null, 'B7b while the Room itself withholds the player');
  neg(
    expect(
      collect(
        'new draft after block',
        await j('POST', `/org/rooms/${IMANI_ROOM}/contacts`, { body: 'again' }, maria.token),
      ),
      403,
      'CONTACT_BLOCKED',
      '',
    ),
    'B8 and no new contact can be drafted',
  );
}

// ==================================================================== R
section('R — roles are decided now, from the database');
{
  neg(
    expect(
      collect(
        'contributor drafts',
        await j('POST', `/org/rooms/${J.RID}/contacts`, { body: 'I am a scout' }, tom.token),
      ),
      403,
      'CONTACT_NOT_PERMITTED',
      '',
    ),
    'R1 a first-team scout (contributor) cannot draft — 403 CONTACT_NOT_PERMITTED',
  );
  const list = await j('GET', `/org/rooms/${J.RID}/contacts`, undefined, tom.token);
  ok(
    list.status === 200 && list.body.items.length >= 1 && list.body.canWrite === false,
    'R1b but reads the Contact history, and is told they cannot write',
  );
  neg(
    expect(
      collect(
        'contributor sends',
        await j('POST', `/org/rooms/${J.RID}/contacts/${J.CID}/send`, { expectedRev: 1 }, tom.token),
      ),
      403,
      'CONTACT_NOT_PERMITTED',
      '',
    ),
    'R1c nor send',
  );
  neg(
    expect(
      collect(
        'contributor records',
        await j(
          'POST',
          `/org/rooms/${J.RID}/contacts/external`,
          { channel: 'phone', occurredAt: Date.now(), recipientType: 'player' },
          tom.token,
        ),
      ),
      403,
      'CONTACT_NOT_PERMITTED',
      '',
    ),
    'R1d nor record',
  );

  // Downgrade between compose and send. The room is MARIA's: the drifter is
  // neither its owner nor its lead scout, so their standing in it comes from
  // the organisation tier alone — which is what a demotion changes. (A person
  // who opened a room is its room lead whatever their tier;
  // that is reassignment, tested below, not demotion.)
  const drifter = await login('org-eastport', 'Drift Lead', 'Head of Recruitment');
  const RID = await planned(maria.token, 'pl-mensah');
  const d = await j('POST', `/org/rooms/${RID}/contacts`, { body: 'Hi Kwame.' }, drifter.token);
  ok(d.status === 201, "R2 a recruitment lead composes in a colleague's room");
  await login('org-eastport', 'Drift Lead', 'First-Team Scout'); // demoted in the database
  neg(
    expect(
      collect(
        'send after demotion',
        await j(
          'POST',
          `/org/rooms/${RID}/contacts/${d.body.contact.id}/send`,
          { expectedRev: d.body.contact.rev },
          drifter.token,
        ),
      ),
      403,
      'CONTACT_NOT_PERMITTED',
      '',
    ),
    'R3 demoted before sending, the OLD token is refused — the role is read per request',
  );
  neg(
    expect(
      collect(
        'edit after demotion',
        await j(
          'PATCH',
          `/org/rooms/${RID}/contacts/${d.body.contact.id}`,
          { body: 'x', expectedRev: d.body.contact.rev },
          drifter.token,
        ),
      ),
      403,
      'CONTACT_NOT_PERMITTED',
      '',
    ),
    'R3a and cannot edit their own draft any more',
  );
  await login('org-eastport', 'Drift Lead', 'Head of Recruitment');
  const s = await j(
    'POST',
    `/org/rooms/${RID}/contacts/${d.body.contact.id}/send`,
    { expectedRev: d.body.contact.rev },
    drifter.token,
  );
  ok(s.status === 200, 'R3b promoted again, the same token sends');
  // Reassignment: a room's lead scout who is moved off the room loses the room-lead standing.
  const scoutLead = await login('org-eastport', 'Room Owner Scout', 'First-Team Scout');
  const RID2 = await planned(scoutLead.token, 'pl-osei').catch(() => null);
  if (RID2) {
    const d2 = await j('POST', `/org/rooms/${RID2}/contacts`, { body: 'Hi.' }, scoutLead.token);
    ok(
      d2.status === 403 || d2.status === 201,
      'R3c a scout who opened the room is its room lead (or the player is blocked)',
    );
  }
  // Removal.
  const removed = await j('POST', `/org/staff/${drifter.userId}/remove`, {}, maria.token);
  ok(removed.status === 200, 'R4 the lead is removed from the organisation');
  neg(
    (await j('GET', `/org/rooms/${RID}/contacts`, undefined, drifter.token)).status === 401,
    'R4b their token is refused outright (401)',
  );
  neg(
    (await j('POST', `/org/rooms/${RID}/contacts`, { body: 'x' }, drifter.token)).status === 401,
    'R4c on writes too',
  );
  ok(
    (await j('GET', `/org/rooms/${RID}/contacts`, undefined, maria.token)).body.items[0].sentBy?.name === 'Drift Lead',
    'R4d while the contact stays attributed to them',
  );

  // Foreign organisation: identical to a case that never existed.
  const ghost = await j('GET', '/org/rooms/case-does-not-exist/contacts', undefined, rita.token);
  const foreign = await j('GET', `/org/rooms/${J.RID}/contacts`, undefined, rita.token);
  neg(
    foreign.status === 404 && ghost.status === 404 && JSON.stringify(foreign.body) === JSON.stringify(ghost.body),
    "R5 another club reading this case's contacts gets the same 404 body as for a case that never existed",
  );
  const foreignW = collect('foreign write', await j('POST', `/org/rooms/${J.RID}/contacts`, { body: 'x' }, rita.token));
  const ghostW = await j('POST', '/org/rooms/case-does-not-exist/contacts', { body: 'x' }, rita.token);
  neg(foreignW.status === 404 && JSON.stringify(foreignW.body) === JSON.stringify(ghostW.body), 'R5b and for a write');
  const foreignC = await j('GET', `/org/rooms/${J.RID}/contacts/${J.CID}`, undefined, rita.token);
  neg(
    foreignC.status === 404 && JSON.stringify(foreignC.body) === JSON.stringify(ghost.body),
    'R5c and for one contact by id — no enumeration through the id',
  );
  neg(
    (await j('POST', `/org/rooms/${J.RID}/contacts/${J.CID}/send`, { expectedRev: 1 }, rita.token)).status === 404,
    "R5d nor can it send another club's draft",
  );

  // Agency and minors.
  const agencyRoom = collect(
    'agency room on minor',
    await j('POST', '/org/rooms', { playerId: 'pl-guni', sourceContext: 'search' }, agent.token),
  );
  neg(
    expect(agencyRoom, 403, 'NOT_VISIBLE', ''),
    'R6 an agency cannot even open a case on a minor (403 NOT_VISIBLE), so it has no case to contact through',
  );
  neg(
    (await j('POST', `/org/rooms/${M_ROOM}/contacts`, { body: 'x' }, agent.token)).status === 404,
    "R6b and Eastport's case on that minor is invisible to it",
  );
  neg(
    (await j('GET', '/org/players', undefined, agent.token)).body.items.every((p) => p.id !== 'pl-guni'),
    "R6c the minor is not in the agency's search either",
  );
  const unverifiedRoom = collect(
    'unverified club on minor',
    await j('POST', '/org/rooms', { playerId: 'pl-guni', sourceContext: 'search' }, rita.token),
  );
  neg(
    expect(unverifiedRoom, 403, 'NOT_VISIBLE', ''),
    'R7 an unverified club cannot open a case on a minor either — the minor gate is untouched',
  );
  neg(
    expect(
      collect('no auth', await j('GET', `/org/rooms/${J.RID}/contacts`, undefined, undefined)),
      401,
      'ORG_AUTH_REQUIRED',
      '',
    ),
    'R8 no session, no contacts',
  );
  neg(
    expect(
      collect('player token on org route', await j('GET', `/org/rooms/${J.RID}/contacts`, undefined, kola.token)),
      401,
      'ORG_AUTH_REQUIRED',
      '',
    ),
    'R8b a player token is not an organisation',
  );
}

// ==================================================================== K
section('K — idempotency, collision, stale and malformed revs, concurrency');
{
  // Create replay and collision.
  const RID = await planned(maria.token, 'pl-carvalho');
  const a = await j('POST', `/org/rooms/${RID}/contacts`, { body: 'Hi Mateus.', clientKey: 'K1' }, maria.token);
  const b = await j('POST', `/org/rooms/${RID}/contacts`, { body: 'Hi Mateus.', clientKey: 'K1' }, maria.token);
  ok(
    a.status === 201 && b.status === 200 && b.body.idempotent === true && b.body.contact.id === a.body.contact.id,
    'K1 the same create key replays the same draft',
  );
  neg(
    (await j('GET', `/org/rooms/${RID}/contacts`, undefined, maria.token)).body.items.length === 1,
    'K1b one draft, not two',
  );
  neg(
    expect(
      collect(
        'create collision',
        await j('POST', `/org/rooms/${RID}/contacts`, { body: 'Different words.', clientKey: 'K1' }, maria.token),
      ),
      409,
      'CONTACT_IDEMPOTENCY_CONFLICT',
      '',
    ),
    'K2 the same key with a different payload is refused 409 CONTACT_IDEMPOTENCY_CONFLICT',
  );
  // Cross-org: the same key in another organisation is that organisation's own.
  const rRoom = await planned(rita.token, 'pl-carvalho');
  const rA = await j('POST', `/org/rooms/${rRoom}/contacts`, { body: 'Harbour here.', clientKey: 'K1' }, rita.token);
  ok(
    rA.status === 201 && rA.body.contact.id !== a.body.contact.id,
    "K3 the same client key in another organisation creates that organisation's own draft — keys do not collide across tenants",
  );
  // Send replay: one request row.
  const CID = a.body.contact.id;
  const s1 = await j(
    'POST',
    `/org/rooms/${RID}/contacts/${CID}/send`,
    { expectedRev: a.body.contact.rev, clientKey: 'K-send' },
    maria.token,
  );
  const s2 = await j(
    'POST',
    `/org/rooms/${RID}/contacts/${CID}/send`,
    { expectedRev: 999, clientKey: 'K-send' },
    maria.token,
  );
  ok(
    s1.status === 200 && s2.status === 200 && s2.body.idempotent === true,
    'K4 the same send key replays without sending again, whatever rev the retry carries',
  );
  const mateus = await playerLogin('pl-carvalho');
  neg(
    (await j('GET', '/player/inbox', undefined, mateus.token)).body.items.filter((r) => r.type === 'contact').length ===
      1,
    'K4b the player received exactly one message',
  );
  neg(
    (await j('GET', '/player/notifications', undefined, mateus.token)).body.filter((n) => n.type === 'request')
      .length === 1,
    'K4c and exactly one notification',
  );
  neg(
    (await j('GET', `/org/rooms/${RID}/journey`, undefined, maria.token)).body.history.entries.filter(
      (e) => e.to === 'contacted',
    ).length === 1,
    'K4d and the case moved exactly once',
  );
  K_PROBE.room = RID;
  K_PROBE.contact = CID;
  K_PROBE.key = 'K-send';
  // A send key reused on ANOTHER contact of the same case.
  const other = await j('POST', `/org/rooms/${RID}/contacts`, { body: 'Second message.' }, maria.token);
  neg(
    expect(
      collect(
        'send key on other contact',
        await j(
          'POST',
          `/org/rooms/${RID}/contacts/${other.body.contact.id}/send`,
          { expectedRev: other.body.contact.rev, clientKey: 'K-send' },
          maria.token,
        ),
      ),
      409,
      'CONTACT_IDEMPOTENCY_CONFLICT',
      '',
    ),
    'K5 a send key already bound to one contact cannot send a different one',
  );
  // External record replay + collision.
  const e1 = await j(
    'POST',
    `/org/rooms/${RID}/contacts/external`,
    {
      channel: 'in_person',
      occurredAt: Date.now() - 1000,
      recipientType: 'player',
      summary: 'At the ground.',
      clientKey: 'K-ext',
    },
    maria.token,
  );
  const e2 = await j(
    'POST',
    `/org/rooms/${RID}/contacts/external`,
    {
      channel: 'in_person',
      occurredAt: e1.body.contact.occurredAt,
      recipientType: 'player',
      summary: 'At the ground.',
      clientKey: 'K-ext',
    },
    maria.token,
  );
  ok(e1.status === 201 && e2.status === 200 && e2.body.idempotent === true, 'K6 an external record replays');
  neg(
    expect(
      collect(
        'external collision',
        await j(
          'POST',
          `/org/rooms/${RID}/contacts/external`,
          { channel: 'phone', occurredAt: Date.now(), recipientType: 'player', clientKey: 'K-ext' },
          maria.token,
        ),
      ),
      409,
      'CONTACT_IDEMPOTENCY_CONFLICT',
      '',
    ),
    'K6b and a different record under the same key is refused',
  );

  // Malformed revs are refused, never coerced.
  const d = await j('POST', `/org/rooms/${RID}/contacts`, { body: 'Rev tests.' }, maria.token);
  const DID = d.body.contact.id;
  for (const [label, rev, code] of [
    ['a string', 'abc', 'EXPECTED_REV_INVALID'],
    ['a float', 1.5, 'EXPECTED_REV_INVALID'],
    ['negative', -1, 'EXPECTED_REV_INVALID'],
    ['an object', { toString: 1 }, 'EXPECTED_REV_INVALID'],
  ]) {
    neg(
      expect(
        collect(
          `rev ${label}`,
          await j('PATCH', `/org/rooms/${RID}/contacts/${DID}`, { body: 'x', expectedRev: rev }, maria.token),
        ),
        400,
        code,
        '',
      ),
      `K7 expectedRev ${label} → 400 ${code}`,
    );
  }
  neg(
    expect(
      collect('rev missing', await j('PATCH', `/org/rooms/${RID}/contacts/${DID}`, { body: 'x' }, maria.token)),
      400,
      'CONTACT_REV_REQUIRED',
      '',
    ),
    'K7b a missing expectedRev is refused 400 CONTACT_REV_REQUIRED, not treated as "any"',
  );
  neg(
    expect(
      collect('cancel rev missing', await j('POST', `/org/rooms/${RID}/contacts/${DID}/cancel`, {}, maria.token)),
      400,
      'CONTACT_REV_REQUIRED',
      '',
    ),
    'K7c on cancel too',
  );
  neg(
    (await j('GET', `/org/rooms/${RID}/contacts/${DID}`, undefined, maria.token)).body.contact.body === 'Rev tests.',
    'K7d and none of them changed the draft',
  );

  // Concurrency: send vs edit on the same rev.
  const [sx, ex] = await Promise.all([
    j('POST', `/org/rooms/${RID}/contacts/${DID}/send`, { expectedRev: d.body.contact.rev }, maria.token),
    j(
      'PATCH',
      `/org/rooms/${RID}/contacts/${DID}`,
      { body: 'edited under the send', expectedRev: d.body.contact.rev },
      maria.token,
    ),
  ]);
  // The cooldown may refuse the send (Mateus was contacted moments ago and has not answered) — that too is one winner, one honest loser.
  const winners = [sx, ex].filter((r) => r.status === 200).length;
  ok(
    winners <= 1,
    `K8 send vs edit on one rev: at most one wins (${sx.status} ${sx.body?.error ?? 'ok'} / ${ex.status} ${ex.body?.error ?? 'ok'})`,
  );
  const after = (await j('GET', `/org/rooms/${RID}/contacts/${DID}`, undefined, maria.token)).body.contact;
  neg(
    !(after.status === 'delivered' && after.body === 'edited under the send'),
    'K8b what was delivered is never something edited after the send',
  );
}
{
  // Two sends of the same draft on the same rev, in parallel: one message.
  const RID = await planned(maria.token, 'pl-tanaka');
  const d = await j('POST', `/org/rooms/${RID}/contacts`, { body: 'Hi Riku.' }, maria.token);
  const [p, q] = await Promise.all([
    j('POST', `/org/rooms/${RID}/contacts/${d.body.contact.id}/send`, { expectedRev: d.body.contact.rev }, maria.token),
    j('POST', `/org/rooms/${RID}/contacts/${d.body.contact.id}/send`, { expectedRev: d.body.contact.rev }, maria.token),
  ]);
  ok([p, q].filter((r) => r.status === 200).length === 1, 'K9 two racing sends on one rev: exactly one succeeds');
  const loser = [p, q].find((r) => r.status !== 200);
  neg(
    loser.status === 409 && ['CONTACT_ALREADY_SENT', 'CONTACT_VERSION_CONFLICT'].includes(loser.body?.error),
    `K9b the loser is told 409 ${loser.body?.error}`,
  );
  const riku = await playerLogin('pl-tanaka');
  neg(
    (await j('GET', '/player/inbox', undefined, riku.token)).body.items.filter((r) => r.type === 'contact').length ===
      1,
    'K9c the player got one message, not two',
  );
  // Send vs cancel.
  const RID2 = await planned(maria.token, 'pl-alvarez');
  const d2 = await j('POST', `/org/rooms/${RID2}/contacts`, { body: 'Hi Santiago.' }, maria.token);
  const [s, c] = await Promise.all([
    j(
      'POST',
      `/org/rooms/${RID2}/contacts/${d2.body.contact.id}/send`,
      { expectedRev: d2.body.contact.rev },
      maria.token,
    ),
    j(
      'POST',
      `/org/rooms/${RID2}/contacts/${d2.body.contact.id}/cancel`,
      { expectedRev: d2.body.contact.rev },
      maria.token,
    ),
  ]);
  ok([s, c].filter((r) => r.status === 200).length === 1, 'K10 send vs cancel: one wins');
  const fin = (await j('GET', `/org/rooms/${RID2}/contacts/${d2.body.contact.id}`, undefined, maria.token)).body
    .contact;
  neg(
    ['delivered', 'cancelled'].includes(fin.status) && !(fin.status === 'cancelled' && fin.requestId),
    'K10b the record is either delivered or cancelled, never a cancelled message that was also sent',
  );
  // External record vs send: two different facts, both allowed, one transition.
  const RID3 = await planned(maria.token, 'pl-nowak');
  const d3 = await j('POST', `/org/rooms/${RID3}/contacts`, { body: 'Hi Filip.' }, maria.token);
  const [x, y] = await Promise.all([
    j(
      'POST',
      `/org/rooms/${RID3}/contacts/${d3.body.contact.id}/send`,
      { expectedRev: d3.body.contact.rev },
      maria.token,
    ),
    j(
      'POST',
      `/org/rooms/${RID3}/contacts/external`,
      { channel: 'phone', occurredAt: Date.now() - 1000, recipientType: 'player' },
      maria.token,
    ),
  ]);
  ok(
    x.status === 200 && y.status === 201,
    'K11 a send and an external record at once are both accepted — they are different facts',
  );
  neg(
    (await j('GET', `/org/rooms/${RID3}/journey`, undefined, maria.token)).body.history.entries.filter(
      (e) => e.to === 'contacted',
    ).length === 1,
    'K11b and the case moved exactly once',
  );
  // Response vs block: the accept loses to a block placed at the same time.
  const filip = await playerLogin('pl-nowak');
  const req = (await j('GET', '/player/inbox', undefined, filip.token)).body.items.find((r) => r.type === 'contact');
  const [blk, acc] = await Promise.all([
    j('POST', '/player/block', { orgId: 'org-eastport' }, filip.token),
    j('POST', `/player/requests/${req.id}/respond`, { accept: true }, filip.token),
  ]);
  ok(blk.status === 201, 'K12 the block lands');
  const cN = (await j('GET', `/org/rooms/${RID3}/contacts/${d3.body.contact.id}`, undefined, maria.token)).body.contact;
  ok(
    (acc.status === 200 && cN.response?.kind === 'accepted') || (acc.status === 403 && cN.response == null),
    `K12b response vs block: a consistent outcome (${acc.status}) — either the accept preceded the block and stands, or it was refused`,
  );
}

// ==================================================================== F
section('F — honest transport failure and resend');
{
  const RID = await planned(maria.token, 'pl-martin');
  const d = await j('POST', `/org/rooms/${RID}/contacts`, { body: 'Hi Théo.', subject: 'Goalkeeping' }, maria.token);
  const inj = await j('POST', '/admin/delivery/inject-failure', { channel: 'contact', count: 1 }, undefined, ADMIN);
  ok(
    inj.status === 200 && inj.body.injected.channel === 'contact',
    'F1 the next in-app contact send is made to fail at the transport',
  );
  const theo = await playerLogin('pl-martin');
  const s = await j(
    'POST',
    `/org/rooms/${RID}/contacts/${d.body.contact.id}/send`,
    { expectedRev: d.body.contact.rev, clientKey: 'F-send' },
    maria.token,
  );
  ok(
    s.status === 200 &&
      s.body.delivered === false &&
      s.body.contact.status === 'failed' &&
      s.body.contact.failureCode === 'TRANSPORT_REFUSED',
    'F2 the send reports delivered:false and the Contact is `failed` with a failure code — not delivered, not queued',
  );
  neg(s.body.contact.deliveredAt === null && s.body.contact.sentAt === null, 'F2b no delivery time was invented');
  neg((await stage(RID)) === 'contact_planned', 'F3 the case did NOT move — a failed attempt is not contact');
  neg(
    (await j('GET', '/player/inbox', undefined, theo.token)).body.items.length === 0,
    'F3b the player received nothing',
  );
  neg((await j('GET', '/player/notifications', undefined, theo.token)).body.length === 0, 'F3c and was not notified');
  ok(
    s.body.contact.attempts === 1 && s.body.contact.history.some((h) => h.action === 'contact_send_failed'),
    'F4 the attempt is on the record — a failure does not erase that the club tried',
  );
  const replay = await j(
    'POST',
    `/org/rooms/${RID}/contacts/${d.body.contact.id}/send`,
    { expectedRev: 999, clientKey: 'F-send' },
    maria.token,
  );
  ok(
    replay.status === 200 && replay.body.idempotent === true && replay.body.delivered === false,
    "F4b replaying the failed send's key reports the same failed outcome — it does not retry behind the caller's back",
  );
  const again = await j(
    'POST',
    `/org/rooms/${RID}/contacts/${d.body.contact.id}/send`,
    { expectedRev: s.body.contact.rev, clientKey: 'F-send-2' },
    maria.token,
  );
  ok(
    again.status === 200 &&
      again.body.delivered === true &&
      again.body.contact.status === 'delivered' &&
      again.body.contact.attempts === 2,
    'F5 an explicit resend is a new attempt on the SAME Contact: delivered, attempts 2',
  );
  ok(
    again.body.contact.history.map((h) => h.action).join(',') === 'contact_created,contact_send_failed,contact_sent',
    'F5b history keeps both attempts in order',
  );
  ok(
    (await stage(RID)) === 'contacted' &&
      (await j('GET', '/player/inbox', undefined, theo.token)).body.items.length === 1,
    'F5c now the case moves and the player has exactly one message',
  );
  const everyMail = []; // the outbox pages; read every page
  for (let page = { nextCursor: '' }; page.nextCursor !== null; ) {
    page = (
      await j(
        'GET',
        `/admin/outbox?limit=100${page.nextCursor ? `&cursor=${page.nextCursor}` : ''}`,
        undefined,
        undefined,
        ADMIN,
      )
    ).body;
    everyMail.push(...page.items);
  }
  neg(
    everyMail.length > 0 && everyMail.every((m) => !String(m.text ?? '').includes('Goalkeeping')),
    'F6 no outbox record ever carries the message body',
  );
}

// ==================================================================== X
section('X — content at the HTTP boundary');
{
  const RID = J.RID;
  const dHtml = await j(
    'POST',
    `/org/rooms/${RID}/contacts`,
    { subject: '<b>S</b>', body: '<script>alert(1)</script>Hello <img src=x onerror=alert(1)>' },
    maria.token,
  );
  ok(dHtml.status === 201, 'X1 markup in a draft is accepted');
  neg(
    !/[<>]/.test(dHtml.body.contact.body) &&
      !/[<>]/.test(dHtml.body.contact.subject) &&
      !/script|onerror/.test(dHtml.body.contact.body),
    'X1b and stored inert — no tag, no handler survives',
  );
  neg(
    expect(
      collect(
        'moderation email',
        await j('POST', `/org/rooms/${RID}/contacts`, { body: 'Email me at scout@eastportfc.com' }, maria.token),
      ),
      400,
      'MODERATION_BLOCKED',
      '',
    ),
    'X2 a message carrying an email address is refused by the existing moderation — no off-platform detail',
  );
  neg(
    expect(
      collect(
        'moderation url',
        await j('POST', `/org/rooms/${RID}/contacts`, { body: 'See https://example.com/offer' }, maria.token),
      ),
      400,
      'MODERATION_BLOCKED',
      '',
    ),
    'X2b and a URL',
  );
  neg(
    expect(
      collect(
        'moderation grooming',
        await j('POST', `/org/rooms/${M_ROOM}/contacts`, { body: "don't tell your parents about this" }, maria.token),
      ),
      400,
      'MODERATION_BLOCKED',
      '',
    ),
    'X2c grooming-pattern language is refused and escalated',
  );
  neg(
    expect(
      collect('empty body', await j('POST', `/org/rooms/${RID}/contacts`, { body: '' }, maria.token)),
      400,
      'CONTACT_CONTENT_INVALID',
      '',
    ),
    'X3 an empty message is refused 400 CONTACT_CONTENT_INVALID',
  );
  neg(
    expect(
      collect('object body', await j('POST', `/org/rooms/${RID}/contacts`, { body: { toString: 1 } }, maria.token)),
      400,
      'CONTACT_CONTENT_INVALID',
      '',
    ),
    'X3b so is a non-text body',
  );
  neg(
    expect(
      collect('huge body', await j('POST', `/org/rooms/${RID}/contacts`, { body: 'x'.repeat(20_000) }, maria.token)),
      400,
      'CONTACT_CONTENT_TOO_LONG',
      '',
    ),
    'X3c and a body far over the limit',
  );
  const forgedStatus = collect(
    'forged status',
    await j('POST', `/org/rooms/${RID}/contacts`, { body: 'ok', status: 'delivered' }, maria.token),
  );
  neg(
    expect(forgedStatus, 400, 'CONTACT_CONTENT_INVALID', '') &&
      forgedStatus.body.field === 'status' &&
      forgedStatus.body.problem === 'unknown_field',
    'X3d a draft cannot name its own status: an undeclared field is refused',
  );
  const forgedRecipient = collect(
    'forged recipient',
    await j(
      'POST',
      `/org/rooms/${RID}/contacts/external`,
      { channel: 'phone', occurredAt: Date.now(), recipientType: 'player', recipientId: 'pl-someone-else' },
      maria.token,
    ),
  );
  neg(
    expect(forgedRecipient, 400, 'CONTACT_CONTENT_INVALID', '') && forgedRecipient.body.problem === 'unknown_field',
    'X3e a recorded contact cannot name its own recipient: it is derived, and a sent one is refused',
  );
  neg(
    expect(
      collect('bad key', await j('POST', `/org/rooms/${RID}/contacts`, { body: 'ok', clientKey: 42 }, maria.token)),
      400,
      'CONTACT_CLIENT_KEY_INVALID',
      '',
    ),
    'X3d a non-text client key',
  );
  const uni = await j(
    'POST',
    `/org/rooms/${RID}/contacts`,
    { body: 'Bonjour café \uD800 hi\u0007 there' },
    maria.token,
  );
  ok(
    uni.status === 201 && uni.body.contact.body === 'Bonjour café  hi there',
    'X4 malformed Unicode is cleaned, never stored raw',
  );
  neg(
    expect(
      collect(
        'proto channel',
        await j(
          'POST',
          `/org/rooms/${RID}/contacts/external`,
          { channel: 'constructor', occurredAt: Date.now(), recipientType: 'player' },
          maria.token,
        ),
      ),
      400,
      'CONTACT_CHANNEL_INVALID',
      '',
    ),
    'X5 channel "constructor" → 400 CONTACT_CHANNEL_INVALID, with the allowed list',
  );
  neg(
    expect(
      collect(
        'proto recipient',
        await j(
          'POST',
          `/org/rooms/${RID}/contacts/external`,
          { channel: 'phone', occurredAt: Date.now(), recipientType: '__proto__' },
          maria.token,
        ),
      ),
      400,
      'CONTACT_RECIPIENT_MISMATCH',
      '',
    ),
    'X5b recipientType "__proto__" → 400',
  );
  neg(
    expect(
      collect(
        'future record',
        await j(
          'POST',
          `/org/rooms/${RID}/contacts/external`,
          { channel: 'phone', occurredAt: Date.now() + 86_400_000, recipientType: 'player' },
          maria.token,
        ),
      ),
      400,
      'CONTACT_OCCURRED_AT_INVALID',
      '',
    ),
    'X5c a contact dated tomorrow → 400',
  );
  neg(
    expect(
      collect(
        'no recipient type',
        await j(
          'POST',
          `/org/rooms/${RID}/contacts/external`,
          { channel: 'phone', occurredAt: Date.now() },
          maria.token,
        ),
      ),
      400,
      'CONTACT_CONTENT_INVALID',
      '',
    ),
    'X5d a record without a recipient classification → 400',
  );
  {
    // A fresh, pending contact to Elias (his draft was cancelled in D).
    const elias = await playerLogin('pl-svensson');
    const dE = await j(
      'POST',
      `/org/rooms/${D_ROOM}/contacts`,
      { body: 'Hi Elias, a quick word about next season.' },
      maria.token,
    );
    const sE = await j(
      'POST',
      `/org/rooms/${D_ROOM}/contacts/${dE.body.contact.id}/send`,
      { expectedRev: dE.body.contact.rev },
      maria.token,
    );
    ok(sE.status === 200 && sE.body.delivered, 'X6a a pending contact reaches Elias');
    const reqE = (await j('GET', '/player/inbox', undefined, elias.token)).body.items.find(
      (r) => r.type === 'contact' && r.status === 'pending',
    );
    neg(
      expect(
        collect(
          'bad reply',
          await j('POST', `/player/requests/${reqE.id}/respond`, { accept: true, message: { x: 1 } }, elias.token),
        ),
        400,
        'CONTACT_RESPONSE_INVALID',
        '',
      ),
      'X6 a non-text reply is refused before anything is touched',
    );
    neg(
      (await j('GET', `/org/rooms/${D_ROOM}/contacts/${dE.body.contact.id}`, undefined, maria.token)).body.contact
        .status === 'delivered',
      'X6b and the contact is still awaiting a response',
    );
    neg(
      expect(
        collect(
          'reply with email',
          await j(
            'POST',
            `/player/requests/${reqE.id}/respond`,
            { accept: true, message: 'call me on 07700 900123' },
            elias.token,
          ),
        ),
        400,
        'MODERATION_BLOCKED',
        '',
      ),
      'X6c a reply carrying a phone number is refused by moderation',
    );
    const decl = await j(
      'POST',
      `/player/requests/${reqE.id}/respond`,
      { accept: false, message: 'Not for me, thanks.' },
      elias.token,
    );
    ok(decl.status === 200, 'X6d a clean decline lands');
    // The player leaves ScoutBox: the next send finds nobody.
    const dGone = await j('POST', `/org/rooms/${D_ROOM}/contacts`, { body: 'One more thing.' }, maria.token);
    ok(dGone.status === 201, 'X6e a further draft exists');
    const bye = await j('DELETE', '/player/account', undefined, elias.token);
    ok(bye.status === 200, 'X6f the player deletes their account');
    neg(
      expect(
        collect(
          'recipient gone',
          await j(
            'POST',
            `/org/rooms/${D_ROOM}/contacts/${dGone.body.contact.id}/send`,
            { expectedRev: dGone.body.contact.rev },
            maria.token,
          ),
        ),
        422,
        'CONTACT_RECIPIENT_UNAVAILABLE',
        '',
      ),
      'X6g sending to a player who no longer exists is refused 422 CONTACT_RECIPIENT_UNAVAILABLE — no recipient is fabricated',
    );
    neg(
      (await j('GET', `/org/rooms/${D_ROOM}/contacts/${dGone.body.contact.id}`, undefined, maria.token)).body.contact
        .status === 'draft',
      'X6h the draft remains a draft',
    );
  }
  neg(
    expect(
      collect('ghost contact', await j('GET', `/org/rooms/${RID}/contacts/rct-999999`, undefined, maria.token)),
      404,
      'CONTACT_NOT_FOUND',
      '',
    ),
    "X7 an unknown contact id in the club's own case → 404 CONTACT_NOT_FOUND",
  );
  neg(
    expect(
      collect('unknown room', await j('GET', '/org/rooms/case-none/contacts', undefined, maria.token)),
      404,
      'ROOM_NOT_FOUND',
      '',
    ),
    "X7b an unknown case → the Room's own 404",
  );
  neg(
    expect(
      collect(
        'too large',
        await j('POST', `/org/rooms/${RID}/contacts`, { body: 'x'.repeat(21_000_000) }, maria.token),
      ),
      413,
      'REQUEST_TOO_LARGE',
      '',
    ),
    'X8 a body over the shared 20 MB HTTP limit is refused before any handler runs',
  );
}

// ==================================================================== Y
// The routing MODE at the HTTP boundary. The agent-side behaviour (who is
// routed, what they then see, and the re-authorization at send time) belongs
// to e2e/agents/crossApp.mjs, which has an agent and a confirmed
// relationship to work with. What belongs HERE is the part that is Contact's own:
// the vocabulary, the refusal, and that a club with no agent in the picture is
// unaffected.
section('Y — the routing mode is vocabulary, and an unknown one is refused');
{
  const RID = J.RID;
  const policy = await j('GET', '/org/recruitment/contact-policy', undefined, maria.token);
  ok(
    Array.isArray(policy.body?.modes) && policy.body.modes.join(',') === 'player_only,both',
    'Y1 the published modes are exactly player_only and both',
  );
  neg(
    !policy.body.modes.includes('agent_only'),
    'Y1b there is no mode that reaches an agent INSTEAD of the player — the player is a target in both',
  );
  neg(
    expect(
      collect(
        'mode agent_only',
        await j('POST', `/org/rooms/${RID}/contacts`, { body: 'Hello', contactMode: 'agent_only' }, maria.token),
      ),
      400,
      'CONTACT_MODE_INVALID',
      '',
    ),
    'Y2 contactMode "agent_only" → 400 CONTACT_MODE_INVALID, refused rather than downgraded to player_only',
  );
  neg(
    expect(
      collect(
        'mode nonsense',
        await j('POST', `/org/rooms/${RID}/contacts`, { body: 'Hello', contactMode: 'everyone' }, maria.token),
      ),
      400,
      'CONTACT_MODE_INVALID',
      '',
    ),
    'Y2b so is any other unknown mode',
  );
  neg(
    expect(
      collect(
        'mode non-text',
        await j('POST', `/org/rooms/${RID}/contacts`, { body: 'Hello', contactMode: { both: true } }, maria.token),
      ),
      400,
      'CONTACT_MODE_INVALID',
      '',
    ),
    'Y2c and a mode that is not text at all',
  );
  const omitted = await j('POST', `/org/rooms/${RID}/contacts`, { body: 'No mode named at all.' }, maria.token);
  ok(
    omitted.status === 201 && omitted.body.contact.contactMode === 'player_only',
    'Y3 omitting contactMode means the player alone — the safe answer is the default',
  );
  neg(
    omitted.body.contact.routedToAgent === false && omitted.body.contact.routedAt === null,
    'Y3b and a draft has routed nothing to anybody, whatever mode it asks for',
  );
  const both = await j(
    'POST',
    `/org/rooms/${RID}/contacts`,
    { body: 'Asking for the representative too.', contactMode: 'both' },
    maria.token,
  );
  ok(
    both.status === 201 && both.body.contact.contactMode === 'both',
    'Y4 a club may ask for "both" — it is a request, not an entitlement',
  );
  neg(
    both.body.routing?.agentParty === false && both.body.routing?.agentRefusal === 'NO_REPRESENTATION',
    'Y4b and with no canonical relationship in the picture the answer is no, with the rule that refused named',
  );
  await j(
    'POST',
    `/org/rooms/${RID}/contacts/${both.body.contact.id}/cancel`,
    { expectedRev: both.body.contact.rev },
    maria.token,
  );
  await j(
    'POST',
    `/org/rooms/${RID}/contacts/${omitted.body.contact.id}/cancel`,
    { expectedRev: omitted.body.contact.rev },
    maria.token,
  );
}

// ==================================================================== S
section('S — the subsystems Contact must not touch');
{
  // Kola's case is already contacted and answered, so a second delivery and a
  // recorded call are both possible — and both must leave everything else alone.
  const RID = J.RID;
  const target = 'pl-adeyemi';
  const readAll = async () => ({
    trust: (await j('GET', `/org/players/${target}/trust`, undefined, maria.token)).body,
    passport: (await j('GET', `/org/players/${target}/passport`, undefined, maria.token)).body,
    plans: (await j('GET', `/org/development/plans?playerId=${target}`, undefined, maria.token)).body,
    secondLook: (await j('GET', '/org/second-look', undefined, maria.token)).body,
    combine: (await j('GET', `/org/players/${target}/combine`, undefined, maria.token)).body,
    watch: (await j('GET', '/org/watchlists', undefined, maria.token)).body,
  });
  const stable = (o) => JSON.stringify(o, (k, v) => (/at$|At$|generatedAt|updatedAt|ts$/.test(k) ? undefined : v));
  const before = await readAll();
  {
    const d = await j('POST', `/org/rooms/${RID}/contacts`, { body: 'Following up on our call.' }, maria.token);
    const s = await j(
      'POST',
      `/org/rooms/${RID}/contacts/${d.body.contact.id}/send`,
      { expectedRev: d.body.contact.rev },
      maria.token,
    );
    ok(s.status === 200 && s.body.delivered, 'S0 a second contact is delivered to an already-contacted player');
    const e = await j(
      'POST',
      `/org/rooms/${RID}/contacts/external`,
      { channel: 'phone', occurredAt: Date.now(), recipientType: 'player' },
      maria.token,
    );
    ok(e.status === 201, 'S0b and a call is recorded');
  }
  const after = await readAll();
  neg(
    stable(before.trust) === stable(after.trust),
    'S1 a delivered contact and a recorded call move the Trust Score not at all',
  );
  neg(stable(before.passport) === stable(after.passport), 'S2 and put nothing in the Passport');
  neg(stable(before.plans) === stable(after.plans), 'S3 and create no Development Plan');
  neg(stable(before.combine) === stable(after.combine), 'S4 and change nothing in Combine');
  neg(stable(before.secondLook) === stable(after.secondLook), 'S5 and raise no Second Look item');
  neg(stable(before.watch) === stable(after.watch), 'S6 and touch no watchlist');
  const funnel = (await j('GET', '/org/rooms-funnel', undefined, maria.token)).body;
  ok(
    funnel.byStatus.contacted >= 1,
    'S7 the funnel DOES count contacted cases — it is the one reader of the lifecycle',
  );
  const analytics = await j('GET', '/org/analytics/dashboard', undefined, maria.token);
  neg(
    analytics.status !== 200 || !/contactScore|responseRate|contactRanking/i.test(JSON.stringify(analytics.body)),
    'S8 no Contact ranking or score appears in analytics',
  );
}

// ==================================================================== C
section('C — cooldown and rate limit are server-enforced and deterministic');
{
  const RID = await planned(maria.token, 'pl-okafor');
  const d1 = await j('POST', `/org/rooms/${RID}/contacts`, { body: 'First.' }, maria.token);
  const s1 = await j(
    'POST',
    `/org/rooms/${RID}/contacts/${d1.body.contact.id}/send`,
    { expectedRev: d1.body.contact.rev },
    maria.token,
  );
  ok(s1.status === 200 && s1.body.delivered, 'C1 a first contact is delivered');
  const d2 = await j('POST', `/org/rooms/${RID}/contacts`, { body: 'Second, too soon.' }, maria.token);
  const s2 = collect(
    'cooldown',
    await j(
      'POST',
      `/org/rooms/${RID}/contacts/${d2.body.contact.id}/send`,
      { expectedRev: d2.body.contact.rev },
      maria.token,
    ),
  );
  neg(
    expect(s2, 429, 'CONTACT_COOLDOWN', ''),
    'C2 a second unanswered contact to the same player inside 72 h is refused 429 CONTACT_COOLDOWN',
  );
  ok(
    typeof s2.body.retryAt === 'number' && s2.body.retryAt === s1.body.contact.deliveredAt + CONTACT_LIMITS.cooldownMs,
    'C2b with a deterministic retry time: first delivery + 72 h',
  );
  const list = (await j('GET', `/org/rooms/${RID}/contacts`, undefined, maria.token)).body;
  ok(list.cooldown?.until === s2.body.retryAt, 'C2c and the list tells the club in advance');
  const chinedu = await playerLogin('pl-okafor');
  const req = (await j('GET', '/player/inbox', undefined, chinedu.token)).body.items.find((r) => r.type === 'contact');
  await j('POST', `/player/requests/${req.id}/respond`, { accept: true }, chinedu.token);
  const s3 = await j(
    'POST',
    `/org/rooms/${RID}/contacts/${d2.body.contact.id}/send`,
    { expectedRev: d2.body.contact.rev },
    maria.token,
  );
  ok(
    s3.status === 200 && s3.body.delivered,
    'C3 once the first is answered, the second sends — the cooldown is about unanswered messages, not about the player',
  );
  neg(
    (await j('GET', `/org/rooms/${RID}/journey`, undefined, maria.token)).body.history.entries.filter(
      (e) => e.to === 'contacted',
    ).length === 1,
    'C3b and the second delivery adds no second transition',
  );
  // Rate limit: drafts, 60/h per organisation.
  let limitedAt = null;
  for (let i = 0; i < RATE_LIMIT_POLICY.contact_draft.max + 5; i += 1) {
    const r = await j('POST', `/org/rooms/${J.RID}/contacts`, { body: `burst ${i}` }, maria.token);
    if (r.status === 429) {
      limitedAt = i;
      collect('rate limited', r);
      break;
    }
  }
  neg(
    limitedAt !== null && limitedAt <= RATE_LIMIT_POLICY.contact_draft.max,
    `C4 a draft burst is limited by the named policy (429 at attempt ${limitedAt})`,
  );
  const r429 = ERROR_BODIES.find((e) => e.label === 'rate limited');
  ok(
    r429?.body?.error === 'RATE_LIMITED' && r429.body.action === 'contact_draft',
    "C4b with the platform's own RATE_LIMITED body naming the action",
  );
  neg(!/pl-|Kola|Adeyemi/.test(JSON.stringify(r429.body)), 'C4c and no player in it');
}

// ==================================================================== E
section('E — every refusal, swept at once; the contract');
{
  ok(ERROR_BODIES.length >= 40, `E1 ${ERROR_BODIES.length} refusals collected across the groups`);
  const FORBIDDEN = [
    [SENTINEL, 'an internal note'],
    ['Rita Vale', 'a person at another club'],
    ['suit you', 'a message body'],
    ['happy to talk', 'a reply'],
    ['amara.adebayo', 'a guardian email'],
  ];
  const offenders = [];
  for (const { label, body } of ERROR_BODIES) {
    const text = JSON.stringify(body ?? {});
    for (const [needle, what] of FORBIDDEN) if (text.includes(needle)) offenders.push(`${label}: ${what}`);
  }
  for (const o of offenders) console.error(`   ${o}`);
  neg(
    offenders.length === 0,
    "E2 no refusal carries an internal note, a body, a reply, another club's staff or an email address",
  );
  const stacky = ERROR_BODIES.filter(({ body }) =>
    /\bat [\w$.]+ \(|\.mjs:\d+|node_modules|TypeError:|ReferenceError:/.test(JSON.stringify(body ?? {})),
  );
  neg(stacky.length === 0, 'E3 none carries a stack trace or a file path');
  const unnamed = ERROR_BODIES.filter(
    ({ body }) => typeof body?.error !== 'string' || !/^[A-Z][A-Z0-9_]+$/.test(body.error),
  );
  neg(unnamed.length === 0, 'E4 every refusal names itself');
  neg(
    ERROR_BODIES.every((e) => e.status < 500),
    'E5 not one is a 5xx',
  );
  const ALLOWED = new Set([
    'ok',
    'error',
    'message',
    'allowed',
    'to',
    'actions',
    'requires',
    'evidenceReason',
    'current',
    'expectedRev',
    'rev',
    'retryAt',
    // An input refusal: the field, what was wrong with it, and the bound it broke.
    'field',
    'problem',
    'min',
    'max',
    'expected',
  ]);
  const strays = [];
  for (const { label, body } of ERROR_BODIES) {
    if (!String(body?.error ?? '').startsWith('CONTACT_')) continue;
    if (body.error === 'CONTACT_VERSION_CONFLICT') continue; // the shared version-conflict body
    for (const k of Object.keys(body ?? {})) if (!ALLOWED.has(k)) strays.push(`${label}.${k}`);
  }
  for (const s of strays) console.error(`   stray: ${s}`);
  neg(strays.length === 0, 'E6 no CONTACT_ refusal carries a field outside the published error shape');
  const conflict = ERROR_BODIES.find((e) => e.body?.error === 'CONTACT_VERSION_CONFLICT');
  ok(
    conflict &&
      Object.keys(conflict.body).every((k) =>
        ['error', 'message', 'expectedRev', 'currentRev', 'updatedBy', 'updatedAt', 'status'].includes(k),
      ),
    "E7 the conflict body is exactly M18.1's contract",
  );
  neg(
    conflict && typeof conflict.body.updatedBy === 'string' && !/^usr-/.test(conflict.body.updatedBy),
    'E7b naming a person, never a user id',
  );
  const codesSeen = new Set(ERROR_BODIES.map((e) => e.body?.error));
  // CONTACT_ACTION_UNKNOWN is the validator's answer to an action name that no
  // route can pass it (actions are bound to routes), so it is provable only in
  // group U. Everything else must have been provoked for real.
  const contactCodes = Object.keys(LIFECYCLE_ERROR_HTTP).filter(
    (c) => c.startsWith('CONTACT_') && httpStatusFor(c) < 500 && c !== 'CONTACT_ACTION_UNKNOWN',
  );
  const unseen = contactCodes.filter((c) => !codesSeen.has(c));
  ok(
    unseen.length === 0,
    `E8 every non-internal CONTACT_ code was provoked over HTTP${unseen.length ? ` (missing: ${unseen.join(', ')})` : ''}`,
  );
  for (const e of ERROR_BODIES) {
    if (String(e.body?.error ?? '').startsWith('CONTACT_') && httpStatusFor(e.body.error) !== e.status)
      fail(`E9 ${e.label}: ${e.body.error} answered ${e.status}, table says ${httpStatusFor(e.body.error)}`);
  }
  ok(true, 'E9 every CONTACT_ refusal answered with exactly the status the table declares');
}

// ==================================================================== Z
section('Z — restart: idempotency and truth survive the process dying');
{
  server.kill('SIGKILL');
  for (let i = 0; i < 40; i += 1) {
    try {
      await fetch(`${BASE}/healthz`);
      await sleep(100);
    } catch {
      break;
    }
  }
  server = await boot();
  const re = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
  ok(!!re?.token, 'Z1 the server came back');
  const replay = await j(
    'POST',
    `/org/rooms/${K_PROBE.room}/contacts/${K_PROBE.contact}/send`,
    { expectedRev: 999, clientKey: K_PROBE.key },
    re.token,
  );
  neg(
    replay.status === 200 && replay.body.idempotent === true,
    'Z2 a send replay after the process died is still a replay — the key lives on the record',
  );
  const mateus = await playerLogin('pl-carvalho');
  neg(
    (await j('GET', '/player/inbox', undefined, mateus.token)).body.items.filter((r) => r.type === 'contact').length ===
      1,
    'Z2b and the player still has exactly one message',
  );
  const c = (await j('GET', `/org/rooms/${J.RID}/contacts/${J.CID}`, undefined, re.token)).body.contact;
  ok(
    c.status === 'responded' &&
      c.response.kind === 'accepted' &&
      c.response.message === 'Yes, happy to talk next week.',
    'Z3 the responded contact, its reply and its history are exactly as before',
  );
  ok(c.history.length === 4, 'Z3b four history entries, unchanged');
  ok((await stage(J.RID, re.token)) === 'contacted', 'Z4 the case is still contacted — the evidence is durable');
  const jr = (await j('GET', `/org/rooms/${J.RID}/journey`, undefined, re.token)).body;
  ok(
    jr.contact.contacts.some((x) => x.id === J.EXT && x.status === 'recorded'),
    'Z4b the recorded external contact survived too',
  );
  const createReplay = await j(
    'POST',
    `/org/rooms/${J.RID}/contacts`,
    {
      subject: 'Interest from Eastport',
      body: 'Hi Kola, we would like to talk about your plans for next season.',
      clientKey: 'J-create',
    },
    re.token,
  );
  neg(
    createReplay.status === 200 && createReplay.body.idempotent === true && createReplay.body.contact.id === J.CID,
    'Z5 a create replay after restart returns the original contact',
  );
  const health = (await j('GET', '/healthz')).body;
  ok(health.schemaVersion === LATEST_SCHEMA, 'Z6 the current schema after the restart');
}

// ---------------------------------------------------------------- report
const total = passed;
const ratio = total ? Math.round((negatives / total) * 100) : 0;
console.log(
  `\nrecruitment/contacts: ${total} checks passed, ${negatives} negative/security/safeguarding checks (${ratio}%)`,
);
if (process.exitCode === 1) console.error('\n✗ recruitment/contacts has failures.');
else console.log('all recruitment/contacts checks passed');
process.exit(process.exitCode ?? 0);
