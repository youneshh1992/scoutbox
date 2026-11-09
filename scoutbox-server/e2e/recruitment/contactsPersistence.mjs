// M23 P3 — Contact persistence suite.
//
// THE INVARIANTS
//
//   1. The contacts are rows of recruitment_contacts (table migration 0017),
//      there after a clean boot and after a restart — never only because a
//      module registered or a request arrived.
//   2. A snapshot that carries Contact rows restores them byte-faithfully.
//      Nothing is rewritten, re-ordered or "repaired" on boot.
//   3. A corrupt Contact row is NAMED and OMITTED, never fabricated into a
//      sound-looking one, and never allowed to take the server down.
//   4. The idempotency keys live on the record, so a replay after the process
//      died is still a replay (proved over HTTP in m23ContactE2E group Z;
//      re-proved here from the snapshot).
//
// Like m23Persistence, no fixture here calls buildSeed(): the whole defect
// class lives in the gap between "the seed made it" and "the database
// guarantees it".

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { integrityReport } from '../../domains/platform/integrity.mjs';
import { DatabaseSync } from 'node:sqlite';
import { writeFixture, readRecords } from '../../scripts/dataLayerFixture.mjs';
import { contactIntegrity, CONTACT_STATUSES } from '../../domains/recruitment/lifecycle/contact.mjs';
import { DATA_MIGRATIONS, TABLE_BACKED } from '../../repositories/index.mjs';
import { buildRecruitmentJourney, createEvidenceProvider } from '../../scripts/recruitmentReadsFixture.mjs'; // §4.3 step 2: the contacts/offers queries over the plain arrays
const LATEST_SCHEMA = Number(DATA_MIGRATIONS.map((m) => m.id).sort().at(-1).slice(0, 4)); // S14a: the latest table migration's number

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', '..', 'server.mjs');
const ADMIN = { 'x-admin-key': process.env.ADMIN_KEY || 'scoutbox-admin' };

let passed = 0; let negatives = 0;
const fail = (m) => { console.error(`✗ ${m}`); process.exitCode = 1; };
const ok = (c, m) => { if (c) { passed++; console.log(`✓ ${m}`); } else fail(m); };
const neg = (c, m) => { negatives++; ok(c, `[neg] ${m}`); };
const section = (n) => console.log(`\n— ${n} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });

/** Boot the real server on a directory; return a client and a stop() that SIGTERMs and reads the snapshot back. */
async function bootOn(dataDir, port) {
  const base = `http://localhost:${port}`;
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, M13_QUIET_LOGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(proc);
  let log = '';
  proc.stdout.on('data', (b) => { log += b; }); proc.stderr.on('data', (b) => { log += b; });
  proc.unref(); proc.stdout.unref(); proc.stderr.unref();
  let up = false;
  for (let i = 0; i < 160 && !up; i += 1) {
    if (proc.exitCode != null) return { up: false, log: () => log };
    try { up = (await fetch(`${base}/healthz`)).ok; } catch { /* booting */ }
    if (!up) await sleep(250);
  }
  const j = async (method, url, body, token, extra = {}) => {
    const r = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null; try { data = await r.json(); } catch { /* non-json */ }
    return { status: r.status, body: data };
  };
  const stop = async () => {
    proc.kill('SIGTERM');
    for (let i = 0; i < 60 && proc.exitCode == null; i += 1) await sleep(100);
    return readRecords(dataDir);
  };
  return { up, j, stop, log: () => log };
}

const PORT = 5600 + Math.floor(Math.random() * 200);

// ------------------------------------------------------------- fixtures

/** A minimal, sound database with one verified club, one adult player, one case at contact_planned. */
function baseDb() {
  const db = {
    players: [{ id: 'pl-x', name: 'Xavier Adult', dob: '2000-05-05', country: 'GB', city: 'London', media: [], attendance: [], trialReports: [], badges: [], timeline: [], medical: { shared: false, records: [], conditionStatus: 'unknown' }, level: 'amateur', location: { lat: 51.5, lng: -0.1 } }],
    orgs: [{ id: 'org-x', name: 'X FC', type: 'club', level: 'pro', plan: 'Pro', verified: true, safeguardingContractSigned: true, location: { lat: 51.5, lng: -0.1 } }],
    guardians: [],
    // S8a-core: a request names its staff member by a real key (recruitment_requests.user_id → org_users), so the
    // fixture carries the staff row the case and the request name (the dev login below finds it by org and name).
    users: [{ id: 'usr-owner', orgId: 'org-x', name: 'Owner', role: 'Head of Recruitment', createdAt: 1 }],
    sessions: [], ledger: [], notifications: [],
    recruitmentCases: [{
      id: 'case-x', orgId: 'org-x', playerId: 'pl-x', playerName: 'Xavier Adult', ownerUserId: 'usr-owner', ownerName: 'Owner', stage: 'review',
      priority: 'medium', restricted: false, assignments: [], tasks: [], approvals: [], decision: null, links: { requestIds: [], trialIds: [], signingId: null },
      room: { status: 'contact_planned', priority: 'normal', tags: [], leadScoutUserId: 'usr-owner', sourceContext: 'search', updatedAt: 1000, archivedAt: null, closedAt: null, rev: 2, revAt: 1000, revBy: null },
      createdAt: 1000, history: [{ id: 'aud-1', at: 1000, byKind: 'org', byId: 'usr-owner', byName: 'Owner', action: 'room_created', detail: { status: 'watching' } }, { id: 'aud-2', at: 1001, byKind: 'org', byId: 'usr-owner', byName: 'Owner', action: 'room_status_changed', detail: { from: 'watching', to: 'contact_planned', reasonCodes: [] } }],
    }],
  };
  return db;
}

const soundContact = (over = {}) => ({
  id: 'rct-1', orgId: 'org-x', caseId: 'case-x', playerId: 'pl-x', status: 'delivered', channel: 'in_app',
  recipient: { type: 'player', playerId: 'pl-x', guardianId: null, minor: false }, contactMode: 'player_only', routingSnapshot: null, subject: 'Hello', body: 'Hi Xavier.', summary: null,
  createdBy: { kind: 'org', userId: 'usr-owner', name: 'Owner' }, createdAt: 2000, updatedAt: 2001,
  sentBy: { kind: 'org', userId: 'usr-owner', name: 'Owner' }, sentAt: 2001, deliveredAt: 2001, failedAt: null, failureCode: null,
  attempts: [{ at: 2001, ok: true, code: null }], requestId: 'req-1', emailCopy: null, lifecycle: null,
  occurredAt: null, recordedBy: null, recordedAt: null, respondedAt: null, response: null, cancelledAt: null, cancelledBy: null,
  keys: { create: { key: 'ck-1', fp: '{"body":"Hi Xavier.","subject":"Hello"}' }, send: { key: 'sk-1', fp: '{"contactId":"rct-1"}' }, record: null },
  history: [{ id: 'aud-10', at: 2000, action: 'contact_created', by: { kind: 'org', userId: 'usr-owner', name: 'Owner' }, detail: { channel: 'in_app' } }, { id: 'aud-11', at: 2001, action: 'contact_sent', by: { kind: 'org', userId: 'usr-owner', name: 'Owner' }, detail: { channel: 'in_app', recipientType: 'player', attempt: 1 } }],
  rev: 2, revAt: 2001, revBy: { userId: 'usr-owner', name: 'Owner' }, policyVersion: 1,
  ...over,
});

// The table-migration ledger of a stopped server's file: every id with the time it was applied.
const ledger = (dir) => { const db = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true }); try { return JSON.stringify(db.prepare('SELECT id, applied_at FROM data_migrations ORDER BY id').all()); } finally { db.close(); } };

// ======================================================= §100 — the guarantee
section('§100/§101 — the store is guaranteed by the registry, on every path');
{
  // Rewritten in S14a: the store-contract, runMigrations and 2302/2303 upgrade cases described the blob (an in-memory
  // upgrade path, ground rule 1). The contacts are rows of recruitment_contacts, created by table migration 0017.
  ok(TABLE_BACKED.includes('recruitmentContacts') && DATA_MIGRATIONS.filter((m) => m.id === '0017_recruitment_contacts_offers').length === 1, 'recruitmentContacts is a table, created by migration 0017 (read through SQL)');
  const noContacts = buildRecruitmentJourney({ recruitmentCases: [], roomDecisions: [], requests: [], trials: [], assessments: [], signings: [] }, 'k', { kind: 'org_staff', orgId: 'o1' });
  ok(noContacts.ok === false && noContacts.error === 'JOURNEY_STORE_MISSING' && noContacts.missing.includes('recruitmentContacts'), 'the journey still requires the contacts: without their queries it reports the store missing');
}

// ======================================================= §144 — byte-faithful restore
section('§144 — a fixture with Contact rows restores byte-faithfully through a real boot');
const RESTORE_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-cp-restore-'));
{
  const db = baseDb();
  const rows = [
    soundContact(),
    soundContact({ id: 'rct-2', status: 'draft', recipient: null, sentBy: null, sentAt: null, deliveredAt: null, attempts: [], requestId: null, keys: { create: null, send: null, record: null }, history: [{ id: 'aud-20', at: 3000, action: 'contact_created', by: { kind: 'org', userId: 'usr-owner', name: 'Owner' }, detail: { channel: 'in_app' } }], rev: 1, revAt: 3000 }),
    soundContact({ id: 'rct-3', status: 'recorded', channel: 'phone', body: null, subject: null, summary: 'Called.', occurredAt: 3500, recordedAt: 3600, recordedBy: { kind: 'org', userId: 'usr-owner', name: 'Owner' }, sentBy: null, sentAt: null, deliveredAt: null, attempts: [], requestId: null, keys: { create: null, send: null, record: { key: 'rk-1', fp: 'x' } }, history: [{ id: 'aud-30', at: 3600, action: 'contact_external_recorded', by: { kind: 'org', userId: 'usr-owner', name: 'Owner' }, detail: { channel: 'phone', occurredAt: 3500, recipientType: 'player' } }] }),
    // S8c (migration 0017): a sent contact and its request are a PAIR (recruitment_contacts.request_id is a real key and the
    // request names its contact back); two contacts naming ONE request is a state the production writer never produces
    // (the send creates the request for that contact) and the cutover refuses it with the ids (CONTACT_REQUEST_MISMATCH),
    // never repairs it. The responded contact therefore carries its own request, as a real one would.
    soundContact({ id: 'rct-4', status: 'responded', requestId: 'req-4', respondedAt: 4000, response: { kind: 'accepted', message: 'Yes', by: 'player', at: 4000 }, history: [{ id: 'aud-40', at: 2001, action: 'contact_sent', by: { kind: 'org', userId: 'usr-owner', name: 'Owner' }, detail: {} }, { id: 'aud-41', at: 4000, action: 'contact_responded', by: { kind: 'player', name: 'Player' }, detail: { kind: 'accepted' } }], rev: 3 }),
  ];
  db.recruitmentContacts = rows;
  // S8a: the request rows are issueRecruitmentRequest's literal (the staff member and the organisation's flags it
  // always sets); a row the typed table cannot hold is refused with its id, never repaired.
  db.requests = [
    { id: 'req-1', playerId: 'pl-x', playerName: 'Xavier Adult', orgId: 'org-x', orgName: 'X FC', orgType: 'club', orgVerified: true, orgSafeguardingCertified: true, userId: 'usr-owner', scoutName: 'Owner', scoutRole: 'Head of Recruitment', type: 'contact', message: 'Hi Xavier.', status: 'pending', createdAt: 2001, routedTo: 'player', guardianId: null, contactId: 'rct-1', contactChannel: null },
    { id: 'req-4', playerId: 'pl-x', playerName: 'Xavier Adult', orgId: 'org-x', orgName: 'X FC', orgType: 'club', orgVerified: true, orgSafeguardingCertified: true, userId: 'usr-owner', scoutName: 'Owner', scoutRole: 'Head of Recruitment', type: 'contact', message: 'Hi Xavier.', status: 'accepted', createdAt: 2001, respondedAt: 4000, respondedBy: 'player', routedTo: 'player', guardianId: null, contactId: 'rct-4', contactChannel: null },
  ];
  writeFixture(RESTORE_DIR, db, { idCounter: 500 });
  const L0 = ledger(RESTORE_DIR);
  // S8c: the rows are read back from the tables, every key and value identical, the keys in the stored shape's order (the
  // documented table-read property; m23DecisionPersistence compares the same way since S8b) — key-order-insensitive here.
  const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  const stable = (v) => JSON.stringify(canon(v));
  const before = stable(rows);

  const s = await bootOn(RESTORE_DIR, PORT);
  ok(s.up, 'the server boots on the fixture');
  if (!s.up) { console.error(`   the server did not come up; its log ends:\n${s.log().slice(-1500)}`); process.exit(1); }
  const health = (await s.j('GET', '/healthz')).body;
  ok(health.schemaVersion === LATEST_SCHEMA, 'and reports the current schema');
  neg(!/STORE_MISSING|INTEGRITY/.test(s.log()), 'no missing store and no integrity violation was logged');
  const owner = (await s.j('POST', '/auth/org/login', { orgId: 'org-x', scoutName: 'Owner', role: 'Head of Recruitment' })).body;
  const list = await s.j('GET', '/org/rooms/case-x/contacts', undefined, owner.token);
  ok(list.status === 200 && list.body.items.length === 4 && list.body.omitted === 0, 'all four restored contacts are listed, none omitted');
  ok(list.body.items.map((c) => c.status).join(',') === 'delivered,draft,recorded,responded', 'in creation order with their restored states');
  const jr = await s.j('GET', '/org/rooms/case-x/journey', undefined, owner.token);
  ok(jr.status === 200 && jr.body.contact.contacts.length === 4, 'the journey projects them');
  const replay = await s.j('POST', '/org/rooms/case-x/contacts/rct-1/send', { expectedRev: 999, clientKey: 'sk-1' }, owner.token);
  neg(replay.status === 200 && replay.body.idempotent === true, 'a send key that was only ever on disk is still a replay after the boot');
  const createReplay = await s.j('POST', '/org/rooms/case-x/contacts', { subject: 'Hello', body: 'Hi Xavier.', clientKey: 'ck-1' }, owner.token);
  neg(createReplay.status === 200 && createReplay.body.idempotent === true && createReplay.body.contact.id === 'rct-1', 'and so is a create key');
  neg(expect422(await s.j('POST', '/org/rooms/case-x/contacts', { subject: 'Other', body: 'Different.', clientKey: 'ck-1' }, owner.token)), 'and the same key with a different payload is a 409 CONTACT_IDEMPOTENCY_CONFLICT, from the snapshot');
  const after = await s.stop();
  ok(after !== null, 'the server shut down and wrote the snapshot back');
  neg(stable(after.recruitmentContacts) === before, 'the four Contact rows came back IDENTICAL in every key and value — reads, replays and a boot rewrote nothing');
  neg(JSON.parse(L0).length === DATA_MIGRATIONS.length && ledger(RESTORE_DIR) === L0, 'and the migration record did not churn'); // rewritten in S14a: it read db.schema
}
function expect422(r) { return r.status === 409 && r.body?.error === 'CONTACT_IDEMPOTENCY_CONFLICT'; }

// ======================================================= §143 — corruption
section('§143 — corrupt Contact rows are named and omitted, never fabricated, and never take the server down');
const CORRUPT_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-cp-corrupt-'));
{
  // S8c (migration 0017; typed since §4.3): the contacts are rows of typed tables. A row the columns cannot hold — an
  // entry that is not a record, a duplicated id, an unknown status word, an off-type history or timestamp, a channel
  // the vocabulary does not know, a record missing the writer's fields — and a contact naming a request that is not in
  // the file are REFUSED by the save, naming the entry, and nothing is written; asserted below, one directory each. The
  // defects a typed row CAN carry (a delivered contact with no recipient, a contact answered but never delivered, a row
  // of another organisation, a player disagreeing with its case) are still planted and still judged on read.
  const REQ = { playerId: 'pl-x', playerName: 'Xavier Adult', orgId: 'org-x', orgName: 'X FC', orgType: 'club', orgVerified: true, orgSafeguardingCertified: true, userId: 'usr-owner', scoutName: 'Owner', scoutRole: 'Head of Recruitment', type: 'contact', message: 'Hi Xavier.', status: 'pending', createdAt: 2001, routedTo: 'player', guardianId: null, contactChannel: null };
  // A fixture is written through the repositories in one unit of work: a record they cannot hold is refused, naming the
  // entry, and nothing of the fixture is written. What a new directory holds then (the migrations' reference rows and
  // the first installation's organisation and player, by id) is the yardstick for "nothing was written".
  const rowIds = (db) => JSON.stringify(Object.fromEntries(Object.entries(db).map(([k, rows]) => [k, rows.map((r) => r?.id ?? JSON.stringify(r))])));
  const FRESH_DB = (() => { const { orgs, players, guardians } = baseDb(); return rowIds(readRecords(writeFixture(mkdtempSync(path.join(tmpdir(), 'sbx-cp-fresh-')), { orgs, players, guardians }))); })();
  const refusedAtCutover = async (label, port, contacts, requests, pattern) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbx-cp-refused-'));
    const fixture = baseDb(); fixture.recruitmentContacts = contacts; fixture.requests = requests;
    let refused = null;
    try { writeFixture(dir, fixture, { idCounter: 500 }); } catch (err) { refused = err; }
    const msg = String(refused?.message ?? '');
    neg(!!refused && pattern.test(msg), `${label}: the write is refused and names the entry (${(pattern.exec(msg) ?? ['NOT named'])[0]})`);
    if (!refused || !pattern.test(msg)) console.error(`   ${label}: refused=${!!refused}; ${msg.slice(0, 700)}`);
    neg(rowIds(readRecords(dir)) === FRESH_DB, `${label}: nothing was written — nothing imported, dropped or repaired`);
    if (port) {
      const s = await bootOn(dir, port);
      neg(s.up, `${label}: a server started on the directory boots (the refused fixture left nothing behind)`);
      if (s.up) await s.stop();
    }
  };
  const req1 = [{ ...REQ, id: 'req-1', contactId: 'rct-1' }];
  await refusedAtCutover('a null entry', PORT + 4, [soundContact(), null], req1, /CONTACTS_OFFERS_INPUT_INVALID: recruitmentContacts is not an object \(null\)/);
  await refusedAtCutover('a duplicated id', PORT + 5, [soundContact(), soundContact({ id: 'rct-1', requestId: null })], req1, /CONTACTS_OFFERS_DUPLICATE: recruitment_contacts rct-1 already exists/);
  await refusedAtCutover('a request that is not in the file', PORT + 6, [soundContact({ requestId: 'req-ghost' })], [], /FOREIGN KEY constraint failed/); // recruitment_contacts.request_id → recruitment_requests
  await refusedAtCutover('an unknown status word', null, [soundContact({ id: 'rct-badstatus', status: 'sent', requestId: null })], [], /rct-badstatus\.status must be one of draft\|delivered/);
  await refusedAtCutover('a history that is not a list', null, [soundContact({ id: 'rct-nohist', history: 'not-a-list', requestId: null })], [], /rct-nohist\.history must be a list/);
  await refusedAtCutover('a timestamp that is not an instant', null, [soundContact({ id: 'rct-badts', deliveredAt: 'yesterday', requestId: null })], [], /rct-badts\.deliveredAt must be an integer or null/);
  await refusedAtCutover('a prototype-key channel', null, [soundContact({ id: 'rct-badchan', channel: 'constructor', requestId: null })], [], /rct-badchan\.channel must be one of in_app\|phone/);
  await refusedAtCutover('a record missing the writer\'s fields', null, [{ id: 'rct-partial', orgId: 'org-x', caseId: 'case-x', playerId: 'pl-x', status: 'draft', channel: 'in_app', history: [], rev: 1 }], [], /rct-partial\.contactMode must be one of player_only\|both/);
  // Pure: the read-time integrity function still names each of those defects, should one ever reach it.
  const unstorable = [soundContact({ id: 'rct-badstatus', status: 'sent' }), soundContact({ id: 'rct-nohist', history: 'not-a-list' }), soundContact({ id: 'rct-badts', deliveredAt: 'yesterday' }), soundContact({ id: 'rct-badchan', channel: 'constructor' })];
  ok(unstorable.every((c) => contactIntegrity(c, { orgId: 'org-x', caseId: 'case-x' }).length > 0), 'the integrity check still names a problem on each of the four unstorable rows');

  const db = baseDb();
  db.orgs.push({ id: 'org-other', name: 'Other FC', type: 'club', level: 'pro', plan: 'Pro', verified: true, safeguardingContractSigned: true, location: { lat: 51.5, lng: -0.1 } }); // the foreign row's organisation exists (org_id is a real key); the tenant filter below is unchanged
  db.recruitmentContacts = [
    soundContact(),                                                                  // sound
    soundContact({ id: 'rct-norecip', recipient: null }),                             // delivered with no recipient
    soundContact({ id: 'rct-wrongorg', orgId: 'org-other' }),                         // another org's row on this case id
    soundContact({ id: 'rct-wrongplayer', playerId: 'pl-other' }),                    // wrong player (still this org/case) — sound structurally, reported by case? no: playerId is free
    soundContact({ id: 'rct-impossible', status: 'responded', deliveredAt: null, respondedAt: 5 }), // impossible: responded but never delivered
    soundContact({ id: 'rct-unknownevent', status: 'draft', recipient: null, sentBy: null, sentAt: null, deliveredAt: null, attempts: [], requestId: null, keys: { create: null, send: null, record: null }, history: [{ id: 'aud-99', at: 1, action: '__teleported__', by: null, detail: null }], rev: 1 }), // unknown history event on a sound draft
  ].map((c, i) => (c.requestId === 'req-1' ? { ...c, requestId: `rq-${i + 1}` } : c)) // each sent row with its OWN request (the pair), as the writer produces; the request ids carry no contact id (the journey check below looks for the corrupt ids)
    .map((c, i) => (i === 0 ? c : { ...c, history: c.history.map((h) => ({ ...h, id: `${h.id}-${i}` })) })); // a history entry's id is unique across contacts, as the writer's nextId makes it
  db.requests = db.recruitmentContacts.filter((c) => c.requestId).map((c) => ({ ...REQ, id: c.requestId, contactId: c.id, orgId: c.orgId, playerId: c.playerId }));
  // `rct-wrongorg` is NOT in this list: a row carrying another organisation's
  // id is that organisation's row, whatever case id it names. It is filtered
  // by tenant before the shape check, never listed, never counted and, by id,
  // answers the concealing 404 — a foreign row must not become a corruption
  // oracle for the club that can see the case.
  const expectedOmitted = ['rct-norecip', 'rct-impossible'];
  // Pure: the integrity function names each problem.
  const named = db.recruitmentContacts.filter((c) => c && expectedOmitted.includes(c.id)).map((c) => [c.id, contactIntegrity(c, { orgId: 'org-x', caseId: 'case-x' })]);
  ok(named.every(([, p]) => p.length > 0), `the integrity check names a problem on every one of the ${named.length} corrupt rows`);
  neg(contactIntegrity(soundContact({ id: 'rct-wrongplayer', playerId: 'pl-other' }), { orgId: 'org-x', caseId: 'case-x' }).length === 0, 'a row whose player disagrees with its case is structurally sound — the case check, not the shape check, is where that is caught (below)');
  ok(contactIntegrity(db.recruitmentContacts[5]).length === 0, 'a sound draft with an unknown history event is not corrupt — the event is simply not a milestone');

  writeFixture(CORRUPT_DIR, db, { idCounter: 500 });
  const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  const before = JSON.stringify(canon(db.recruitmentContacts));
  const s = await bootOn(CORRUPT_DIR, PORT + 1);
  ok(s.up, 'the server boots with six rows, two of them corrupt and one foreign');
  if (!s.up) { console.error(`   the server did not come up; its log ends:\n${s.log().slice(-1500)}`); process.exit(1); }
  const owner = (await s.j('POST', '/auth/org/login', { orgId: 'org-x', scoutName: 'Owner', role: 'Head of Recruitment' })).body;
  const list = await s.j('GET', '/org/rooms/case-x/contacts', undefined, owner.token);
  ok(list.status === 200, 'the contact list still answers (200)');
  const ids = list.body.items.map((c) => c.id);
  neg(expectedOmitted.every((id) => !ids.includes(id)), 'every corrupt row is omitted from the list');
  neg(list.body.omitted === expectedOmitted.length, `and the omission is COUNTED (${list.body.omitted}) — partial projection, never a silent one`);
  ok(ids.includes('rct-1') && ids.includes('rct-wrongplayer') && ids.includes('rct-unknownevent'), 'the sound rows beside them still show');
  neg(ids.filter((id) => id === 'rct-1').length === 1, 'the sound row is listed once (a duplicated id can no longer reach a boot: the cutover refused it above, with the id, for a person to decide which is real)');
  for (const id of expectedOmitted) {
    const one = await s.j('GET', `/org/rooms/case-x/contacts/${id}`, undefined, owner.token);
    neg(one.status === 500 && one.body?.error === 'CONTACT_STATE_UNKNOWN', `${id} by id answers 500 CONTACT_STATE_UNKNOWN — corruption reads as corruption`);
    neg(!JSON.stringify(one.body).includes('status_unknown') && !JSON.stringify(one.body).includes('recipient_missing'), `${id}: the diagnostic names stay in the log, not the body`);
  }
  neg(/CONTACT integrity rct-norecip: recipient_missing/.test(s.log()), 'the log names the row and the problem');
  const foreign = await s.j('GET', '/org/rooms/case-x/contacts/rct-wrongorg', undefined, owner.token);
  neg(foreign.status === 404 && foreign.body?.error === 'CONTACT_NOT_FOUND', 'a row carrying another organisation\'s id on this case answers the concealing 404, not a corruption report');
  neg(!ids.includes('rct-wrongorg'), 'and is not listed');
  const jr = await s.j('GET', '/org/rooms/case-x/journey', undefined, owner.token);
  ok(jr.status === 200 && jr.body.contact.omitted === expectedOmitted.length, 'the journey projects, omits the same two and counts them');
  neg(!JSON.stringify(jr.body).includes('rct-norecip') && !JSON.stringify(jr.body).includes('rct-impossible'), 'no corrupt row and no invented state reaches the journey');
  neg(!JSON.stringify(jr.body.history.entries).includes('__teleported__'), 'an unknown history event is not rendered as a milestone');
  // The evidence provider ignores corrupt rows but still sees the sound one.
  const ev = createEvidenceProvider({ signings: [], recruitmentContacts: db.recruitmentContacts.filter((c) => c && expectedOmitted.includes(c.id)) }).check('contact_delivered', { kase: db.recruitmentCases[0] });
  neg(ev.satisfied === false && ev.reason === 'no_contact_delivered', 'the corrupt "delivered" rows are NOT evidence of contact');
  const ev2 = createEvidenceProvider({ signings: [], recruitmentContacts: db.recruitmentContacts }).check('contact_delivered', { kase: db.recruitmentCases[0] });
  ok(ev2.satisfied === true && ev2.sourceId === 'rct-1', 'the sound row beside them is');
  const after = await s.stop();
  neg(JSON.stringify(canon(after.recruitmentContacts)) === before, 'shutdown wrote the corrupt rows back UNCHANGED in every key and value — reported, never repaired (the missing recipient and the impossible state carried as written)');
  // Boot-time integrity: contacts are not part of the M18.2 report's subject, and must not make it lie.
  // Rewritten in S14a: the report has no store list any more (it described the blob's required stores).
  const rep = integrityReport(after, { cases: after.recruitmentCases ?? [] });
  ok(rep.ok === true && rep.violations.length === 0, 'the boot integrity report is clean');
}

// ======================================================= §100 — clean boot, empty
section('§100 — clean boot: empty store, first write, restart');
const CLEAN_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-cp-clean-'));
{
  writeFixture(CLEAN_DIR, baseDb(), { idCounter: 500 });
  const s = await bootOn(CLEAN_DIR, PORT + 2);
  ok(s.up, 'boot on an empty contacts store');
  const owner = (await s.j('POST', '/auth/org/login', { orgId: 'org-x', scoutName: 'Owner', role: 'Head of Recruitment' })).body;
  const list = await s.j('GET', '/org/rooms/case-x/contacts', undefined, owner.token);
  ok(list.status === 200 && list.body.items.length === 0 && list.body.routing.available === true, 'an empty store lists nothing and still previews routing');
  const d = await s.j('POST', '/org/rooms/case-x/contacts', { body: 'First ever.', clientKey: 'first' }, owner.token);
  ok(d.status === 201, 'the first write lands');
  const snap1 = await s.stop();
  ok(snap1.recruitmentContacts.length === 1 && snap1.recruitmentContacts[0].status === 'draft', 'and is on disk as a draft after shutdown');
  const s2 = await bootOn(CLEAN_DIR, PORT + 3);
  const owner2 = (await s2.j('POST', '/auth/org/login', { orgId: 'org-x', scoutName: 'Owner', role: 'Head of Recruitment' })).body;
  const again = await s2.j('POST', '/org/rooms/case-x/contacts', { body: 'First ever.', clientKey: 'first' }, owner2.token);
  neg(again.status === 200 && again.body.idempotent === true, 'after a restart the create key is still a replay');
  const sent = await s2.j('POST', `/org/rooms/case-x/contacts/${d.body.contact.id}/send`, { expectedRev: d.body.contact.rev, clientKey: 'send-1' }, owner2.token);
  ok(sent.status === 200 && sent.body.delivered && sent.body.case?.to === 'contacted', 'the draft written before the restart sends after it, and moves the case');
  const snap2 = await s2.stop();
  ok(snap2.recruitmentContacts[0].status === 'delivered' && snap2.recruitmentCases[0].room.status === 'contacted' && snap2.requests.length === 1, 'contact, case and request row are all on disk together — one save, one transaction');
  ok(CONTACT_STATUSES.includes(snap2.recruitmentContacts[0].status), 'with a status this build recognises');
}

const total = passed;
console.log(`\nrecruitment/contactsPersistence: ${total} checks passed, ${negatives} negative/integrity checks (${Math.round((negatives / total) * 100)}%)`);
if (process.exitCode === 1) console.error('\n✗ recruitment/contactsPersistence has failures.');
else console.log('all recruitment/contactsPersistence checks passed');
process.exit(process.exitCode ?? 0);
