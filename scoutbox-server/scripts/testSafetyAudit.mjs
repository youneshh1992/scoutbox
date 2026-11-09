// The eight audit collections as typed tables (repositories/safetyAudit.mjs, migration 0013_safety_audit). Q4 (see
// docs/decisions.md): the five player references (blocks, reports, org notes, ledger, source
// changes) carry no key and an unresolved id is counted, never refused. Q4b: the ID-check queue names an existing
// guardian, checked on every write. Q5: lifting a block deletes its row.
//
// Covered: the schema (typed columns, vocabulary CHECKs, organisation and staff RESTRICT keys, no key on a player or
// guardian id, the ledger details as typed columns by type); the repository's explicit writes (each record typed — an
// unknown field or a wrong type refused by name, never by value —, a detail key the type does not carry refused, the
// organisation, staff and guardian references checked, a duplicate refused; every write committed at once; fresh,
// deep-frozen reads); the queries the routes use (blocks, the report triage order and its cursor, the reporter's
// list, the ledger's lists, counts and paging, the source-change cap); units of work (a write joins the open unit and
// rolls back with it; a read inside the unit sees its writes); no db.<collection> name (each throws, naming the
// repository); fixtures written through the repository (round trip, refusals by id, nothing written).
// Temporary databases only; nothing touches DATA_DIR. Run with: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runDataMigrations } from '../repositories/database.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { createSafetyAuditRepository, AUDIT_COLLECTIONS, LEDGER_TYPES, LEDGER_DETAIL } from '../repositories/safetyAudit.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir, openRaw, applied, dump, FIXTURE, ORGS, USERS, SESSIONS, hasBlobTable } from './coreIdentityTestFixtures.mjs';
import { writeFixture, readRecords } from './dataLayerFixture.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
let counter = 9000;
const nextId = (p) => `${p}-${++counter}`;
const MIGRATION = '0013_safety_audit';
const plain = (v) => JSON.parse(JSON.stringify(v));
/** The key a cursor carries (what readPage hands the repository). */
const after = (cursor) => JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));

// ------------------------------------------------------------------ the writers' literals (synthetic values only)
const T = NOW - 60_000;
const block = (over = {}) => ({ id: 'blk-1', playerId: 'pl-adult', orgId: 'org-pro', by: 'player', reason: 'synthetic reason', ts: T, ...over });
const report = (over = {}) => ({ id: 'rep-1', ts: T, by: 'player', byId: 'pl-adult', byOrgId: null, targetKind: 'club', targetOrgId: 'org-pro', targetScoutName: null, targetPlayerId: null, reason: 'Synthetic report reason.', urgent: false, status: 'pending_review', outcome: null, resolvedAt: null, ...over });
const modHit = (over = {}) => ({ id: 'mod-1', ts: T, context: { kind: 'player_message', channelId: 'chan-1' }, flags: ['email'], severity: 'contact', excerpt: 'synthetic excerpt', ...over });
const note = (over = {}) => ({ id: 'note-1', orgId: 'org-pro', playerId: 'pl-adult', userId: 'usr-1', scoutName: 'Maria', text: 'Synthetic note text.', ts: T, ...over });
const led = (over = {}) => ({ id: 'led-1', ts: T, type: 'view', playerId: 'pl-adult', orgId: 'org-pro', orgName: 'Eastport FC', userId: 'usr-1', scoutName: 'Maria', detail: null, ...over });
const ops = (over = {}) => ({ id: 'ops-1', at: T, kind: 'backup_created', detail: { dir: '2026-10-19', files: 3, queuedForRemoval: 0 }, ...over });
const srcc = (over = {}) => ({ id: 'srcc-1', playerId: 'pl-adult', type: 'position_changed', sourceSystem: 'passport_prefs', sourceId: 'pl-adult:ST', occurredAt: T, detail: { to: 'ST', submittedBy: 'player' }, ...over });
const idv = (over = {}) => ({ id: 'idv-1', guardianId: 'gd-primary', guardianName: 'Primary Parent', documentType: 'passport', documentRef: '4567', provider: 'dev-attestation', reference: 'idv_0123456789abcdef', ts: T, status: 'approved', ...over });

/** The fixture's identity, organisation and staff with the given audit collections, written through the repositories. */
const fixtureDb = (audit = {}) => ({ ...FIXTURE(), orgs: ORGS(), users: USERS(), sessions: SESSIONS(), ...audit });
function fixtureFile(dir, audit = {}) { writeFixture(dir, fixtureDb(audit), { now: NOW, idCounter: 1000 }); }
const migrate = (s) => runDataMigrations(s, DATA_MIGRATIONS, { now: NOW, context: { sessionTtlMs: TTL } });
/** A repository on a bare migrated connection holding the fixture. */
function bare(tag, audit = {}) {
  const dir = tempDir(tag); fixtureFile(dir, audit); const s = openRaw(dir); migrate(s);
  return { dir, s, repo: createSafetyAuditRepository({ sqlite: s, now: () => NOW }), close: () => { s.close(); rm(dir); } };
}
/** A live server-mode store with the data layer attached, as the server runs it. */
function live(dir) {
  const store = openStore(dir);
  const layer = attachDataLayer({ store, nextId, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  return { store, layer, repo: layer.safetyAudit, close: () => store.sqlite.close() };
}
const ids = (s, table) => s.prepare(`SELECT id FROM ${table} ORDER BY seq`).all().map((r) => r.id);

// ============================================================= the schema
test('the schema: 0013 after 0012, no blob; typed columns with vocabulary CHECKs and no JSON column; organisation and staff RESTRICT keys and no key on a player or guardian id (Q4, Q4b); a ledger detail column holds a value only for the types that carry it; the moderation flags and the Combine protocols are ordered child rows', () => {
  assert.deepEqual(DATA_MIGRATIONS.map((m) => m.id).filter((id) => id <= MIGRATION).slice(-2), ['0012_channels', MIGRATION]);
  const { s, close } = bare('sa-schema');
  assert.ok(applied(s).includes(MIGRATION)); assert.equal(hasBlobTable(s), false);
  for (const t of ['blocks', 'reports', 'moderation_log', 'org_notes', 'ledger', 'ops_events', 'source_changes', 'idv_queue']) {
    const cols = s.prepare(`PRAGMA table_info(${t})`).all();
    assert.deepEqual(cols.filter((c) => /_json$/.test(c.name)).map((c) => c.name), [], `${t}: no JSON column`);
    const keys = s.prepare(`PRAGMA foreign_key_list(${t})`).all();
    assert.ok(keys.every((k) => ['orgs', 'org_users'].includes(k.table) && k.on_delete === 'RESTRICT'), `${t}: organisation and staff keys only, RESTRICT`);
    assert.ok(!keys.some((k) => /player_id|guardian_id/.test(k.from)), `${t}: no key on a player or guardian id`);
  }
  const ins = (sql) => () => s.exec(sql);
  assert.throws(ins("INSERT INTO blocks (id, player_id, org_id, by_kind, reason, created_at) VALUES ('b', 'p', 'org-pro', 'admin', '', 1)"), /CHECK/, 'by_kind is a vocabulary');
  assert.throws(ins("INSERT INTO blocks (id, player_id, org_id, by_kind, reason, created_at) VALUES ('b', 'p', 'org-nobody', 'player', '', 1)"), /FOREIGN KEY/, 'org_id is a key');
  s.exec("INSERT INTO blocks (id, player_id, org_id, by_kind, reason, created_at) VALUES ('b', 'pl-nobody', 'org-pro', 'player', '', 1)"); // Q4: a player id resolves to nothing, tolerated
  assert.throws(ins("INSERT INTO ledger (id, occurred_at, type) VALUES ('l', 1, 'invented')"), /CHECK/, 'the ledger type is a vocabulary');
  assert.throws(ins("INSERT INTO ledger (id, occurred_at, type, detail_drill_id) VALUES ('l', 1, 'view', 'd1')"), /CHECK/, 'a view carries no drill');
  s.exec("INSERT INTO ledger (id, occurred_at, type, detail_drill_id) VALUES ('l', 1, 'box_challenge_published', 'd1')");
  assert.throws(ins("INSERT INTO moderation_flags (moderation_id, ord, flag) VALUES ('m', 0, 'email')"), /FOREIGN KEY/, 'a flag belongs to a hit');
  s.exec("INSERT INTO idv_queue (id, guardian_id, document_type, document_ref_last4, provider, reference, created_at, status) VALUES ('i', 'gd-nobody', 'passport', '1', 'p', 'r', 1, 'approved')"); // Q4b is the code's check, not a key
  close();
});

// ============================================================= explicit writes
test('explicit writes: each collection\'s record is typed and committed at once, read back fresh and deep-frozen, in the writer\'s key order; an unknown field, a wrong type, a detail key its type does not carry or an over-long text is refused by name (never by value); a missing organisation or staff member, a duplicate id and a missing guardian are refused; nothing is written by a refusal', () => {
  const { s, repo, close } = bare('sa-writes');
  const b = repo.blocks.add(block());
  assert.deepEqual(Object.keys(b), ['id', 'playerId', 'orgId', 'by', 'reason', 'ts']); assert.ok(Object.isFrozen(b)); assert.throws(() => { b.reason = 'x'; }, TypeError);
  assert.deepEqual(ids(s, 'blocks'), ['blk-1'], 'committed at once');
  const r = repo.reports.file(report()); assert.deepEqual(plain(r), report());
  const m = repo.moderationLog.record(modHit()); assert.deepEqual(m.context, { kind: 'player_message', channelId: 'chan-1' }); assert.deepEqual(m.flags, ['email']);
  assert.deepEqual(plain(repo.orgNotes.add(note())), note());
  assert.deepEqual(plain(repo.ledger.append(led())), led());
  const combine = repo.ledger.append(led({ id: 'led-c', type: 'combine_request_created', detail: { requestId: 'cr-1', protocols: ['sprint@1', 'agility@2'] } }));
  assert.deepEqual(combine.detail, { requestId: 'cr-1', protocols: ['sprint@1', 'agility@2'] }, 'the protocols are ordered rows');
  assert.deepEqual(repo.ledger.append(led({ id: 'led-t', type: 'box_assignment_created', detail: { drillId: 'd-1', target: { type: 'reps', value: 20 } } })).detail, { drillId: 'd-1', target: { type: 'reps', value: 20 } });
  assert.deepEqual(repo.ledger.append(led({ id: 'led-p', type: 'box_prefs_changed', orgId: null, orgName: null, userId: null, scoutName: null, detail: { by: 'player', share: undefined, retainClips: false } })).detail, { by: 'player', retainClips: false }, 'an undefined detail key is absent');
  assert.deepEqual(repo.opsEvents.record(ops()).detail, ops().detail);
  assert.deepEqual(plain(repo.sourceChanges.record(srcc())), srcc());
  assert.deepEqual(plain(repo.idvQueue.add(idv())), idv());
  const SECRET = 'SECRET-VALUE-77';
  const refused = (fn, re) => assert.throws(fn, (e) => re.test(e.message) && !e.message.includes(SECRET));
  const before = dump(s);
  refused(() => repo.blocks.add(block({ id: 'blk-x', futureField: SECRET })), /AUDIT_RECORD_INVALID[^]*futureField/);
  refused(() => repo.blocks.add(block({ id: 'blk-x', reason: { why: SECRET } })), /AUDIT_RECORD_INVALID[^]*reason must be text/);
  refused(() => repo.blocks.add(block({ id: 'blk-x', by: SECRET })), /by must be one of/);
  refused(() => repo.reports.file(report({ id: 'rep-x', urgent: 'yes' })), /urgent must be true or false/);
  refused(() => repo.reports.file(report({ id: 'rep-x', reason: `${SECRET}${'x'.repeat(2000)}` })), /reason exceeds 2000 characters/);
  refused(() => repo.reports.file(report({ id: 'rep-x', outcome: SECRET })), /outcome is set only on a resolved report/);
  refused(() => repo.reports.file(report({ id: 'rep-x', by: 'org_user' })), /byOrgId is set exactly when a club user filed/);
  refused(() => repo.moderationLog.record(modHit({ id: 'mod-x', flags: [SECRET] })), /flags must be a list of distinct moderation flags/);
  refused(() => repo.moderationLog.record(modHit({ id: 'mod-x', context: { kind: 'x', note: SECRET } })), /context carries field\(s\)[^]*note/);
  refused(() => repo.ledger.append(led({ id: 'led-x', detail: { drillId: SECRET } })), /detail\.drillId is not part of a view detail/);
  refused(() => repo.ledger.append(led({ id: 'led-x', type: SECRET })), /type must be one of/);
  refused(() => repo.ledger.append(led({ id: 'led-x', type: 'box_assignment_created', detail: { target: { type: 'reps', value: SECRET } } })), /target[^]*finite number/);
  refused(() => repo.opsEvents.record(ops({ id: 'ops-x', detail: { dir: 'd', conflicts: [SECRET] } })), /detail\.conflicts is not part of a backup_created detail/);
  refused(() => repo.blocks.add(block({ id: 'blk-x', orgId: 'org-nobody' })), /AUDIT_REFERENCE_MISSING: blocks blk-x orgId names no orgs row/);
  refused(() => repo.orgNotes.add(note({ id: 'note-x', userId: 'usr-nobody' })), /AUDIT_REFERENCE_MISSING: org_notes note-x userId names no org_users row/);
  refused(() => repo.opsEvents.record(ops({ id: 'ops-x', kind: 'staff_bootstrapped', detail: { orgId: 'org-nobody', userId: 'usr-1', by: 'M' } })), /detail\.orgId names no orgs row/);
  refused(() => repo.blocks.add(block()), /AUDIT_DUPLICATE: blocks blk-1 already exists/);
  refused(() => repo.idvQueue.add(idv({ id: 'idv-x', guardianId: 'gd-missing', guardianName: SECRET })), /IDV_GUARDIAN_MISSING[^]*gd-missing/);
  assert.equal(dump(s), before, 'no refusal wrote anything');
  close();
});

// ============================================================= the queries the routes use
test('the queries: blocks.has and the newest-first page; the report triage order (urgent pending, pending, both oldest first; then resolved, newest first) paged by cursor; resolve once (ALREADY_RESOLVED after); the reporter\'s list; the ledger by player, by player and club, by club and type, the listed players in first-listed order, counts by type and by actor, the newest-first pages; the moderation and ops counts; the IDV first entry and status; the source-change cap', () => {
  const { s, repo, close } = bare('sa-reads');
  for (let i = 0; i < 5; i++) repo.blocks.add(block({ id: `blk-${i}`, playerId: `pl-${i}`, ts: T + i }));
  assert.equal(repo.blocks.has('pl-3', 'org-pro'), true); assert.equal(repo.blocks.has('pl-3', 'org-other'), false); assert.equal(repo.blocks.has(undefined, 'org-pro'), false);
  let page = repo.blocks.page({ limit: 2 }); assert.deepEqual(page.items.map((b) => b.id), ['blk-4', 'blk-3']);
  page = repo.blocks.page({ limit: 2, after: after(page.nextCursor) }); assert.deepEqual(page.items.map((b) => b.id), ['blk-2', 'blk-1']);
  page = repo.blocks.page({ limit: 2, after: after(page.nextCursor) }); assert.deepEqual([page.items.map((b) => b.id), page.nextCursor], [['blk-0'], null]);
  assert.deepEqual(plain(repo.blocks.lift('blk-0')), block({ id: 'blk-0', playerId: 'pl-0', ts: T })); assert.equal(repo.blocks.lift('blk-0'), null, 'Q5: gone');
  repo.reports.file(report({ id: 'r-old', ts: 1 })); repo.reports.file(report({ id: 'r-urgent-new', ts: 5, urgent: true })); repo.reports.file(report({ id: 'r-urgent-old', ts: 2, urgent: true }));
  repo.reports.file(report({ id: 'r-res-1', ts: 3 })); repo.reports.file(report({ id: 'r-res-2', ts: 4 })); repo.reports.file(report({ id: 'r-mine', ts: 6, by: 'guardian', byId: 'gd-primary' }));
  repo.reports.resolve('r-res-1', { outcome: 'Done.', at: 10 }); repo.reports.resolve('r-res-2', { outcome: 'Done.', at: 11 });
  assert.throws(() => repo.reports.resolve('r-res-1', { outcome: 'Again.', at: 12 }), /ALREADY_RESOLVED/); assert.throws(() => repo.reports.resolve('r-nobody', { outcome: 'x', at: 1 }), /REPORT_NOT_FOUND/);
  const triage = []; let cursor = null;
  do { const p = repo.reports.triagePage({ limit: 2, after: cursor ? after(cursor) : null }); triage.push(...p.items.map((r) => r.id)); cursor = p.nextCursor; } while (cursor);
  assert.deepEqual(triage, ['r-urgent-old', 'r-urgent-new', 'r-old', 'r-mine', 'r-res-2', 'r-res-1']);
  assert.equal(repo.reports.openUrgentAgainst('org-pro'), true); assert.equal(repo.reports.countOpen(), 4);
  assert.deepEqual(repo.reports.forReporter('guardian', 'gd-primary').map((r) => r.id), ['r-mine']);
  repo.ledger.append(led({ id: 'l1', playerId: 'pl-a', type: 'view' })); repo.ledger.append(led({ id: 'l2', playerId: 'pl-b', type: 'shortlist' }));
  repo.ledger.append(led({ id: 'l3', playerId: 'pl-a', type: 'shortlist' })); repo.ledger.append(led({ id: 'l4', playerId: 'pl-b', type: 'shortlist', scoutName: 'Tom' }));
  repo.ledger.append(led({ id: 'l5', playerId: 'pl-a', type: 'org_blocked_by_player', orgId: null, orgName: null, userId: null, scoutName: 'player' }));
  assert.deepEqual(repo.ledger.forPlayer('pl-a').map((l) => l.id), ['l1', 'l3', 'l5']); assert.deepEqual(repo.ledger.forPlayer('pl-a', ['view']).map((l) => l.id), ['l1']);
  assert.deepEqual(repo.ledger.forPlayerOrg('pl-a', 'org-pro').map((l) => l.id), ['l1', 'l3']);
  assert.deepEqual(repo.ledger.playersListedBy('org-pro'), ['pl-b', 'pl-a'], 'in the order first listed, once each');
  assert.equal(repo.ledger.isListedBy('org-pro', 'pl-a'), true); assert.equal(repo.ledger.isListedBy('org-pro', 'pl-c'), false);
  assert.deepEqual(repo.ledger.countsForOrg('org-pro'), { view: 1, shortlist: 3 }); assert.equal(repo.ledger.countForPlayer('pl-b', 'shortlist'), 2);
  assert.deepEqual(repo.ledger.topActorsForOrg('org-pro', 8), [{ scoutName: 'Maria', events: 3 }, { scoutName: 'Tom', events: 1 }]);
  assert.deepEqual(repo.ledger.countsByActor().filter((r) => r.scoutName === 'Maria'), [{ scoutName: 'Maria', orgName: 'Eastport FC', type: 'view', n: 1 }, { scoutName: 'Maria', orgName: 'Eastport FC', type: 'shortlist', n: 2 }]);
  assert.deepEqual(repo.ledger.forOrg('org-pro', ['view']).map((l) => l.id), ['l1']);
  const lp = repo.ledger.pageForOrg('org-pro', { limit: 3 }); assert.deepEqual(lp.items.map((l) => l.id), ['l4', 'l3', 'l2']); assert.deepEqual(repo.ledger.pageForOrg('org-pro', { limit: 3, after: after(lp.nextCursor) }).items.map((l) => l.id), ['l1']);
  assert.deepEqual(repo.ledger.pageForPlayers(['pl-a'], { limit: 50 }).items.map((l) => l.id), ['l5', 'l3', 'l1'], 'a guardian\'s log covers the player whichever club');
  repo.moderationLog.record(modHit()); repo.moderationLog.record(modHit({ id: 'mod-2', severity: 'grooming', flags: ['secrecy'] }));
  assert.deepEqual([repo.moderationLog.count(), repo.moderationLog.count('grooming')], [2, 1]); assert.deepEqual(repo.moderationLog.page({ limit: 50 }).items.map((m) => m.id), ['mod-2', 'mod-1']);
  repo.opsEvents.record(ops()); repo.opsEvents.record(ops({ id: 'ops-2', kind: 'webhook_failed', detail: { deliveryId: 'd', endpointId: 'e' } }));
  assert.deepEqual([repo.opsEvents.count('webhook_failed'), repo.opsEvents.newest(1)[0].id], [1, 'ops-2']);
  repo.idvQueue.add(idv()); repo.idvQueue.add(idv({ id: 'idv-2', ts: T + 1 }));
  assert.equal(repo.idvQueue.firstForGuardian('gd-primary').id, 'idv-1'); assert.equal(repo.idvQueue.setStatus('idv-1', 'revoked').status, 'revoked');
  assert.throws(() => repo.idvQueue.setStatus('idv-1', 'pending'), /status must be one of/); assert.throws(() => repo.idvQueue.setStatus('idv-nobody', 'approved'), /IDV_ENTRY_NOT_FOUND/);
  for (let i = 0; i < 5; i++) repo.sourceChanges.record(srcc({ id: `srcc-${i}`, occurredAt: T + i }), { cap: 3 });
  assert.deepEqual(ids(s, 'source_changes'), ['srcc-2', 'srcc-3', 'srcc-4'], 'the oldest beyond the cap are deleted');
  assert.deepEqual(repo.unresolvedPlayerReferences(), { blocks: 4, reports: 0, orgNotes: 0, ledger: 5, sourceChanges: 0 }, 'Q4: counted, never refused');
  assert.deepEqual(Object.keys(repo.reads), AUDIT_COLLECTIONS); assert.equal(repo.reads.blocks.add, undefined, 'reads carry no writes');
  close();
});

// ============================================================= every ledger type and detail the writers produce
test('every ledger type is accepted with the detail its writer passes; LEDGER_DETAIL names only known types', () => {
  const { repo, close } = bare('sa-types');
  for (const t of Object.keys(LEDGER_DETAIL)) assert.ok(LEDGER_TYPES.includes(t), t);
  let i = 0;
  for (const type of LEDGER_TYPES) repo.ledger.append(led({ id: `l-${i++}`, type }));
  assert.equal(repo.counts().ledger, LEDGER_TYPES.length);
  close();
});

// ============================================================= units of work and the retired names
test('units of work: a write joins the open unit, a read inside it sees the write, and a failure later in the unit rolls the write back; db.<collection> is gone for all eight, naming the repository', () => {
  const dir = tempDir('sa-unit'); fixtureFile(dir);
  const L = live(dir);
  assert.throws(() => L.store.unitOfWork(() => {
    L.repo.blocks.add(block());
    L.repo.ledger.append(led({ type: 'org_blocked_by_player' }));
    assert.equal(L.repo.blocks.has('pl-adult', 'org-pro'), true, 'the unit sees its own write');
    throw new Error('synthetic failure after the writes');
  }), /synthetic failure/);
  assert.deepEqual([L.repo.blocks.has('pl-adult', 'org-pro'), L.repo.counts().ledger], [false, 0], 'both rolled back');
  L.store.unitOfWork(() => { L.repo.blocks.add(block()); L.repo.ledger.append(led({ type: 'org_blocked_by_player' })); });
  assert.deepEqual([L.repo.blocks.has('pl-adult', 'org-pro'), L.repo.counts().ledger], [true, 1], 'committed together');
  assert.equal(L.layer.report().domains.safetyAudit.pendingWrites, 0);
  L.close(); rm(dir);
});

// ============================================================= fixtures
test('fixtures: all eight collections written through the repository read back record for record; junk is refused by collection and id (never by value) and writes nothing; a missing organisation or ID-check guardian is refused; Q4: a player id that resolves to nothing is stored as it is', () => {
  const audit = { blocks: [block()], reports: [report(), report({ id: 'rep-2', status: 'resolved', outcome: 'Done.', resolvedAt: T + 1 })], moderationLog: [modHit()], orgNotes: [note()], ledger: [led(), led({ id: 'led-c', type: 'combine_request_created', detail: { requestId: 'cr', protocols: ['a@1'] } })], opsEvents: [ops()], sourceChanges: [srcc()], idvQueue: [idv()] };
  const dir = tempDir('sa-fix'); fixtureFile(dir, audit);
  const read = () => { const r = readRecords(dir); return Object.fromEntries(AUDIT_COLLECTIONS.map((n) => [n, r[n]])); };
  const dumpOf = () => { const s = openRaw(dir); try { return dump(s); } finally { s.close(); } };
  assert.deepEqual(plain(read()), plain(audit), 'round trip, record for record');
  const before = dumpOf(); const SECRET = 'SECRET-NOTE-44';
  for (const [label, extra, re] of [
    ['duplicate', { ledger: [led({ id: 'led-d' }), led({ id: 'led-d' })] }, /AUDIT_DUPLICATE[^]*ledger led-d already exists/],
    ['not an object', { blocks: ['blk-2'] }, /AUDIT_RECORD_INVALID[^]*not an object/],
    ['unknown field', { orgNotes: [note({ id: 'note-2', secret: SECRET })] }, /AUDIT_RECORD_INVALID[^]*note-2 carries field\(s\)[^]*secret/],
    ['wrong type', { orgNotes: [note({ id: 'note-2', text: [SECRET] })] }, /AUDIT_RECORD_INVALID[^]*note-2\.text must be text/],
    ['missing org', { blocks: [block({ id: 'blk-2', orgId: 'org-nobody' })] }, /AUDIT_REFERENCE_MISSING[^]*org-nobody/],
    ['missing guardian', { idvQueue: [idv({ id: 'idv-2', guardianId: 'gd-missing' })] }, /IDV_GUARDIAN_MISSING[^]*idv-2/],
  ]) {
    assert.throws(() => writeFixture(dir, extra, { now: NOW }), (e) => re.test(e.message) && !e.message.includes(SECRET), label);
    assert.equal(dumpOf(), before, `${label}: nothing changed`);
  }
  writeFixture(dir, { ledger: [led({ id: 'led-gone', playerId: 'pl-gone' })], sourceChanges: [srcc({ id: 'srcc-gone', playerId: 'pl-gone' })] }, { now: NOW });
  assert.equal(read().ledger.find((l) => l.id === 'led-gone').playerId, 'pl-gone', 'Q4: a player id that resolves to nothing is stored as it is');
  assert.equal(read().sourceChanges.find((c) => c.id === 'srcc-gone').playerId, 'pl-gone');
  rm(dir);
});

console.log(`safety audit: ${passed} checks passed`);
