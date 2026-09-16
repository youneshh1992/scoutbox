// M23 P3 — Contact persistence suite.
//
// THE INVARIANTS
//
//   1. `db.recruitmentContacts` exists after a clean migration, after an
//      upgrade from any older snapshot, and after a restart — never only
//      because a module registered or a request arrived.
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
import { MIGRATIONS, SCHEMA_VERSION, runMigrations, PRODUCTION_REQUIRED_STORES } from '../m182/migrations.mjs';
import { integrityReport } from '../m182/integrity.mjs';
import { openStore } from '../store.mjs';
import { buildRecruitmentJourney, JOURNEY_REQUIRED_STORES } from '../m23/journey.mjs';
import { createEvidenceProvider } from '../m23/evidence.mjs';
import { contactIntegrity, CONTACT_STATUSES } from '../m23/contact.mjs';
import { guaranteeFor } from '../storeContract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
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
    return openStore(dataDir).load()?.db ?? null;
  };
  return { up, j, stop, log: () => log };
}

const PORT = 5600 + Math.floor(Math.random() * 200);

// ------------------------------------------------------------- fixtures

/** A minimal, sound database with one verified club, one adult player, one case at contact_planned. */
function baseDb() {
  const db = {
    players: [{ id: 'pl-x', name: 'Xavier Adult', dob: '2000-05-05', country: 'GB', city: 'London', media: [], attendance: [], trialReports: [], badges: [], timeline: [], medical: { shared: false, records: [], conditionStatus: 'unknown' }, level: 'amateur', location: { lat: 51.5, lng: -0.1 } }],
    orgs: [{ id: 'org-x', name: 'X FC', type: 'club', level: 'pro', plan: 'Pro', verified: true, safeguardingContractSigned: true, squad: [], location: { lat: 51.5, lng: -0.1 } }],
    guardians: [], users: [], sessions: [], ledger: [], notifications: [],
    recruitmentCases: [{
      id: 'case-x', orgId: 'org-x', playerId: 'pl-x', playerName: 'Xavier Adult', ownerUserId: 'usr-owner', ownerName: 'Owner', stage: 'review',
      priority: 'medium', restricted: false, assignments: [], tasks: [], approvals: [], decision: null, links: { requestIds: [], trialIds: [], signingId: null },
      room: { status: 'contact_planned', priority: 'normal', tags: [], leadScoutUserId: 'usr-owner', sourceContext: 'search', updatedAt: 1000, archivedAt: null, closedAt: null, rev: 2, revAt: 1000, revBy: null },
      createdAt: 1000, history: [{ id: 'aud-1', at: 1000, byKind: 'org', byId: 'usr-owner', byName: 'Owner', action: 'room_created', detail: { status: 'watching' } }, { id: 'aud-2', at: 1001, byKind: 'org', byId: 'usr-owner', byName: 'Owner', action: 'room_status_changed', detail: { from: 'watching', to: 'contact_planned', reasonCodes: [] } }],
    }],
  };
  runMigrations(db);
  return db;
}

const soundContact = (over = {}) => ({
  id: 'rct-1', orgId: 'org-x', caseId: 'case-x', playerId: 'pl-x', status: 'delivered', channel: 'in_app',
  recipient: { type: 'player', playerId: 'pl-x', guardianId: null, minor: false }, subject: 'Hello', body: 'Hi Xavier.', summary: null,
  createdBy: { kind: 'org', userId: 'usr-owner', name: 'Owner' }, createdAt: 2000, updatedAt: 2001,
  sentBy: { kind: 'org', userId: 'usr-owner', name: 'Owner' }, sentAt: 2001, deliveredAt: 2001, failedAt: null, failureCode: null,
  attempts: [{ at: 2001, ok: true, code: null }], requestId: 'req-1', emailCopy: null, lifecycle: null,
  occurredAt: null, recordedBy: null, recordedAt: null, respondedAt: null, response: null, cancelledAt: null, cancelledBy: null,
  keys: { create: { key: 'ck-1', fp: '{"body":"Hi Xavier.","subject":"Hello"}' }, send: { key: 'sk-1', fp: '{"contactId":"rct-1"}' }, record: null },
  history: [{ id: 'aud-10', at: 2000, action: 'contact_created', by: { kind: 'org', userId: 'usr-owner', name: 'Owner' }, detail: { channel: 'in_app' } }, { id: 'aud-11', at: 2001, action: 'contact_sent', by: { kind: 'org', userId: 'usr-owner', name: 'Owner' }, detail: { channel: 'in_app', recipientType: 'player', attempt: 1 } }],
  rev: 2, revAt: 2001, revBy: { userId: 'usr-owner', name: 'Owner' }, policyVersion: 1,
  ...over,
});

const stableJson = (db) => { const { schema, ...rest } = db; const { updatedAt, ...s } = schema ?? {}; return JSON.stringify({ ...rest, schema: s }); };

// ======================================================= §100 — the guarantee
section('§100/§101 — the store is guaranteed by the registry, on every path');
{
  ok(guaranteeFor('recruitmentContacts') === 'migration', 'recruitmentContacts is classified migration-guaranteed in the store contract');
  ok(PRODUCTION_REQUIRED_STORES.includes('recruitmentContacts'), 'and is in the derived required list');
  ok(JOURNEY_REQUIRED_STORES.includes('recruitmentContacts'), 'and the journey declares it required');
  const fresh = {};
  const r = runMigrations(fresh);
  ok(r.to === SCHEMA_VERSION && Array.isArray(fresh.recruitmentContacts), `a clean database migrates to ${SCHEMA_VERSION} with an empty contacts store`);
  ok(MIGRATIONS.find((m) => m.id === 'm230_004_recruitment_contacts')?.version === 2303, 'the step is numbered 2303');

  // A pre-P3 snapshot (schema 2302) gains the store and nothing else moves.
  const old = { players: [], orgs: [], guardians: [], users: [], sessions: [], ledger: [], notifications: [] };
  runMigrations(old);
  old.schema.version = 2302; old.schema.migrations = old.schema.migrations.filter((m) => m.id !== 'm230_004_recruitment_contacts'); delete old.recruitmentContacts;
  const beforeOthers = stableJson({ ...old, schema: undefined });
  const up = runMigrations(old);
  ok(up.ran.length === 1 && up.ran[0] === 'm230_004_recruitment_contacts' && up.to === SCHEMA_VERSION, 'a P2.5-era snapshot (2302) runs exactly the one new step');
  ok(Array.isArray(old.recruitmentContacts) && old.recruitmentContacts.length === 0, 'and gains an empty store');
  const afterOthers = stableJson({ ...old, recruitmentContacts: undefined, schema: undefined });
  neg(beforeOthers === afterOthers, 'and no other collection changed');
  const again = runMigrations(old);
  neg(again.ran.length === 0, 'a second run applies nothing — idempotent');

  // Existing rows are never overwritten.
  const withRows = { players: [], orgs: [], guardians: [], users: [], sessions: [], ledger: [], notifications: [], recruitmentContacts: [soundContact()] };
  runMigrations(withRows);
  neg(withRows.recruitmentContacts.length === 1 && withRows.recruitmentContacts[0].id === 'rct-1', 'a snapshot that already holds contacts keeps them exactly');
}

// ======================================================= §144 — byte-faithful restore
section('§144 — a snapshot with Contact rows restores byte-faithfully through a real boot');
const RESTORE_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-cp-restore-'));
{
  const db = baseDb();
  const rows = [
    soundContact(),
    soundContact({ id: 'rct-2', status: 'draft', recipient: null, sentBy: null, sentAt: null, deliveredAt: null, attempts: [], requestId: null, keys: { create: null, send: null, record: null }, history: [{ id: 'aud-20', at: 3000, action: 'contact_created', by: { kind: 'org', userId: 'usr-owner', name: 'Owner' }, detail: { channel: 'in_app' } }], rev: 1, revAt: 3000 }),
    soundContact({ id: 'rct-3', status: 'recorded', channel: 'phone', body: null, subject: null, summary: 'Called.', occurredAt: 3500, recordedAt: 3600, recordedBy: { kind: 'org', userId: 'usr-owner', name: 'Owner' }, sentBy: null, sentAt: null, deliveredAt: null, attempts: [], requestId: null, keys: { create: null, send: null, record: { key: 'rk-1', fp: 'x' } }, history: [{ id: 'aud-30', at: 3600, action: 'contact_external_recorded', by: { kind: 'org', userId: 'usr-owner', name: 'Owner' }, detail: { channel: 'phone', occurredAt: 3500, recipientType: 'player' } }] }),
    soundContact({ id: 'rct-4', status: 'responded', respondedAt: 4000, response: { kind: 'accepted', message: 'Yes', by: 'player', at: 4000 }, history: [{ id: 'aud-40', at: 2001, action: 'contact_sent', by: { kind: 'org', userId: 'usr-owner', name: 'Owner' }, detail: {} }, { id: 'aud-41', at: 4000, action: 'contact_responded', by: { kind: 'player', name: 'Player' }, detail: { kind: 'accepted' } }], rev: 3 }),
  ];
  db.recruitmentContacts = rows;
  db.requests = [{ id: 'req-1', playerId: 'pl-x', playerName: 'Xavier Adult', orgId: 'org-x', orgName: 'X FC', type: 'contact', message: 'Hi Xavier.', status: 'pending', createdAt: 2001, routedTo: 'player', guardianId: null, contactId: 'rct-1', contactChannel: null }];
  openStore(RESTORE_DIR).save({ savedAt: Date.now(), idCounter: 500, db });
  const before = JSON.stringify(rows);

  const s = await bootOn(RESTORE_DIR, PORT);
  ok(s.up, 'the server boots on the restored snapshot');
  const health = (await s.j('GET', '/healthz')).body;
  ok(health.schemaVersion === SCHEMA_VERSION, `and reports schema ${SCHEMA_VERSION}`);
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
  neg(JSON.stringify(after.recruitmentContacts) === before, 'the four Contact rows came back BYTE-IDENTICAL — reads, replays and a boot rewrote nothing');
  neg(after.schema.migrations.length === MIGRATIONS.length, 'and the migration record did not churn');
}
function expect422(r) { return r.status === 409 && r.body?.error === 'CONTACT_IDEMPOTENCY_CONFLICT'; }

// ======================================================= §143 — corruption
section('§143 — corrupt Contact rows are named and omitted, never fabricated, and never take the server down');
const CORRUPT_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-cp-corrupt-'));
{
  const db = baseDb();
  db.recruitmentContacts = [
    soundContact(),                                                                  // sound
    soundContact({ id: 'rct-badstatus', status: 'sent' }),                           // invalid status
    soundContact({ id: 'rct-norecip', recipient: null }),                             // delivered with no recipient
    soundContact({ id: 'rct-wrongorg', orgId: 'org-other' }),                         // another org's row on this case id
    soundContact({ id: 'rct-wrongplayer', playerId: 'pl-other' }),                    // wrong player (still this org/case) — sound structurally, reported by case? no: playerId is free
    soundContact({ id: 'rct-nohist', history: 'not-a-list' }),                        // malformed history
    soundContact({ id: 'rct-1' }),                                                    // DUPLICATE id
    soundContact({ id: 'rct-badts', deliveredAt: 'yesterday' }),                      // malformed timestamp
    soundContact({ id: 'rct-badchan', channel: 'constructor' }),                      // prototype-key channel
    soundContact({ id: 'rct-impossible', status: 'responded', deliveredAt: null, respondedAt: 5 }), // impossible: responded but never delivered
    null,                                                                             // not an object
    { id: 'rct-unknownevent', orgId: 'org-x', caseId: 'case-x', playerId: 'pl-x', status: 'draft', channel: 'in_app', history: [{ id: 'aud-99', at: 1, action: '__teleported__', by: null, detail: null }], rev: 1 }, // unknown history event on a sound draft
  ];
  // `rct-wrongorg` is NOT in this list: a row carrying another organisation's
  // id is that organisation's row, whatever case id it names. It is filtered
  // by tenant before the shape check, never listed, never counted and, by id,
  // answers the concealing 404 — a foreign row must not become a corruption
  // oracle for the club that can see the case.
  const expectedOmitted = ['rct-badstatus', 'rct-norecip', 'rct-nohist', 'rct-badts', 'rct-badchan', 'rct-impossible'];
  // Pure: the integrity function names each problem.
  const named = db.recruitmentContacts.filter((c) => c && expectedOmitted.includes(c.id)).map((c) => [c.id, contactIntegrity(c, { orgId: 'org-x', caseId: 'case-x' })]);
  ok(named.every(([, p]) => p.length > 0), `the integrity check names a problem on every one of the ${named.length} corrupt rows`);
  neg(contactIntegrity(soundContact({ id: 'rct-wrongplayer', playerId: 'pl-other' }), { orgId: 'org-x', caseId: 'case-x' }).length === 0, 'a row whose player disagrees with its case is structurally sound — the case check, not the shape check, is where that is caught (below)');
  ok(contactIntegrity(db.recruitmentContacts[11]).length === 0, 'a sound draft with an unknown history event is not corrupt — the event is simply not a milestone');

  openStore(CORRUPT_DIR).save({ savedAt: Date.now(), idCounter: 500, db });
  const before = JSON.stringify(db.recruitmentContacts);
  const s = await bootOn(CORRUPT_DIR, PORT + 1);
  ok(s.up, 'the server boots with twelve rows, six of them corrupt, one foreign and one null');
  const owner = (await s.j('POST', '/auth/org/login', { orgId: 'org-x', scoutName: 'Owner', role: 'Head of Recruitment' })).body;
  const list = await s.j('GET', '/org/rooms/case-x/contacts', undefined, owner.token);
  ok(list.status === 200, 'the contact list still answers (200)');
  const ids = list.body.items.map((c) => c.id);
  neg(expectedOmitted.every((id) => !ids.includes(id)), 'every corrupt row is omitted from the list');
  neg(list.body.omitted === expectedOmitted.length, `and the omission is COUNTED (${list.body.omitted}) — partial projection, never a silent one`);
  ok(ids.includes('rct-1') && ids.includes('rct-wrongplayer') && ids.includes('rct-unknownevent'), 'the sound rows beside them still show');
  neg(ids.filter((id) => id === 'rct-1').length === 2, 'a duplicated id is shown twice, not silently merged — a person must decide which is real');
  for (const id of expectedOmitted) {
    const one = await s.j('GET', `/org/rooms/case-x/contacts/${id}`, undefined, owner.token);
    neg(one.status === 500 && one.body?.error === 'CONTACT_STATE_UNKNOWN', `${id} by id answers 500 CONTACT_STATE_UNKNOWN — corruption reads as corruption`);
    neg(!JSON.stringify(one.body).includes('status_unknown') && !JSON.stringify(one.body).includes('recipient_missing'), `${id}: the diagnostic names stay in the log, not the body`);
  }
  neg(/CONTACT integrity rct-badstatus: status_unknown/.test(s.log()), 'the log names the row and the problem');
  const foreign = await s.j('GET', '/org/rooms/case-x/contacts/rct-wrongorg', undefined, owner.token);
  neg(foreign.status === 404 && foreign.body?.error === 'CONTACT_NOT_FOUND', 'a row carrying another organisation\'s id on this case answers the concealing 404, not a corruption report');
  neg(!ids.includes('rct-wrongorg'), 'and is not listed');
  const jr = await s.j('GET', '/org/rooms/case-x/journey', undefined, owner.token);
  ok(jr.status === 200 && jr.body.contact.omitted === expectedOmitted.length, 'the journey projects, omits the same six and counts them');
  neg(!JSON.stringify(jr.body).includes('rct-badstatus') && !JSON.stringify(jr.body).includes('sent'), 'no corrupt row and no invented state reaches the journey');
  neg(!JSON.stringify(jr.body.history.entries).includes('__teleported__'), 'an unknown history event is not rendered as a milestone');
  // The evidence provider ignores corrupt rows but still sees the sound one.
  const ev = createEvidenceProvider({ signings: [], recruitmentContacts: db.recruitmentContacts.filter((c) => c && expectedOmitted.includes(c.id)) }).check('contact_delivered', { kase: db.recruitmentCases[0] });
  neg(ev.satisfied === false && ev.reason === 'no_contact_delivered', 'six corrupt "delivered" rows are NOT evidence of contact');
  const ev2 = createEvidenceProvider({ signings: [], recruitmentContacts: db.recruitmentContacts }).check('contact_delivered', { kase: db.recruitmentCases[0] });
  ok(ev2.satisfied === true && ev2.sourceId === 'rct-1', 'the sound row beside them is');
  const after = await s.stop();
  neg(JSON.stringify(after.recruitmentContacts) === before, 'shutdown wrote the corrupt rows back UNCHANGED — reported, never repaired');
  // Boot-time integrity: contacts are not part of the M18.2 report's subject, and must not make it lie.
  const rep = integrityReport(after);
  ok(rep.stores.ok === true, 'the boot integrity report still finds every required store present');
}

// ======================================================= §100 — clean boot, empty
section('§100 — clean boot: empty store, first write, restart');
const CLEAN_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-cp-clean-'));
{
  openStore(CLEAN_DIR).save({ savedAt: Date.now(), idCounter: 500, db: baseDb() });
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
console.log(`\nM23 P3 Contact persistence: ${total} checks passed, ${negatives} negative/integrity checks (${Math.round((negatives / total) * 100)}%)`);
if (process.exitCode === 1) console.error('\n✗ M23 P3 Contact persistence has failures.');
else console.log('all M23 P3 Contact persistence checks passed');
process.exit(process.exitCode ?? 0);
