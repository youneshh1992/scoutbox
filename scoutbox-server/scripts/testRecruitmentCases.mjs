// S8b — recruitment cases, room comments, room snapshots, room decisions and room evidence states as typed tables with
// EXPLICIT writes (repositories/recruitmentCases.mjs, migration 0016; docs/architecture/migration.md §4.3). What this
// suite proves: the migration creates the twenty-five typed STRICT tables (no lossless side column, the vocabulary
// CHECKs, the children cascading, the room rows RESTRICT) and the case keys of requests, trials, contacts and offers are
// immediate; a snapshot save (fixtures, tools) types every writer shape into its columns and reads back the typed record,
// refuses a record it cannot type and names every missing reference with ids; the player references are counted, never
// refused (Q8a); the repository's operations write rows at once and return fresh read-only records, the views refuse an
// in-place edit, an update inside its own update is refused, a unit of work rolls rows AND mirrors back; a decision's
// snapshot is the snapshot row it names; the deletion unit's redaction.
// Temporary databases only; nothing touches DATA_DIR. Run with: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir } from './coreIdentityTestFixtures.mjs';
import { p4bInvitation, minorInvitation, acceptedRequest, scheduledTrial, legacyTrialRequest, saveFixture, fixtureDb, SCOUT } from './recruitmentTestFixtures.mjs';
import { roomCase, m12Case, comment, snapshot, trustedSnapshot, recommendation, formalDecision, evidenceState, hist, S8B_FIX, persisted, TC } from './recruitmentCasesTestFixtures.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const dbFile = (dir) => path.join(dir, 'scoutbox.db');
let counter = 9000; const nextId = (p) => `${p}-${++counter}`;
const MIGRATION = '0016_recruitment_cases';
const rc = await import('../repositories/recruitmentCases.mjs');
const COLLECTIONS = rc.RECRUITMENT_CASES_COLLECTIONS;
const TABLES = rc.RECRUITMENT_CASES_TABLES;
const second = (dir) => new DatabaseSync(dbFile(dir), { readOnly: true });
const withRo = (dir, fn) => { const s = second(dir); try { return fn(s); } finally { s.close(); } };
const plain = (v) => JSON.parse(JSON.stringify(v));
const fullDump = (s) => JSON.stringify(s.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => [r.name, s.prepare(`SELECT * FROM "${r.name}"`).all().map((x) => ({ ...x }))]));
const caseDump = (s) => JSON.stringify(TABLES.map((t) => s.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().map((r) => ({ ...r }))));
const ddlOf = (s, t) => s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)?.sql ?? null;
const col = (s, sql, ...p) => { const r = s.prepare(sql).get(...p); return r ? Object.values({ ...r })[0] : undefined; };
const fkOf = (s, t) => s.prepare(`PRAGMA foreign_key_list(${t})`).all().map((r) => `${r.from}->${r.table} ${r.on_delete}`);
const TYPERS = { recruitmentCases: rc.typeCase, roomComments: rc.typeComment, roomSnapshots: rc.typeSnapshot, roomDecisions: rc.typeDecision, roomEvidenceState: rc.typeEvidenceState };
/** The typed expectation of a writer's literal: what every read returns (a decision's snapshot is read back from its row). */
const typed = (name, raw) => { const t = TYPERS[name](persisted(raw), name); assert.ok(t.ok, t.reason); return plain(t.record); };
const S8A = () => ({ requests: [acceptedRequest(p4bInvitation(), 'trial-1'), minorInvitation(), legacyTrialRequest()], trials: [scheduledTrial()] });
const fixtureCollections = (over = {}) => ({ notifications: [], dispatches: [], ...S8A(), ...S8B_FIX(), ...over });
const file = (tag, over = {}) => saveFixture(tempDir(`s8b-${tag}`), fixtureCollections(over));
const refused = (fn, pattern, label = '') => { let err = null; try { fn(); } catch (e) { err = e; } assert.ok(err, `${label}: expected a refusal`); assert.match(String(err.message), pattern, `${label}: ${err.message}`); return err; };
/** Save the fixtures, with `over`, into a new database and expect the save refused, atomically, twice. */
const refusedSave = (tag, over, pattern) => {
  const d = tempDir(`s8b-ref-${tag}`); const st = openStore(d); const before = fullDump(st.sqlite);
  for (const label of [tag, `${tag} (again)`]) { refused(() => st.save({ savedAt: NOW, idCounter: 1000, db: fixtureDb(fixtureCollections(over)) }), pattern, label); assert.equal(st.sqlite.isTransaction, false); assert.equal(fullDump(st.sqlite), before, `${label}: nothing written`); }
  st.sqlite.close(); rm(d);
};
function serverOpen(dir) {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const loaded = store.load();
  const db = { ...loaded.db, players: [], guardians: [] };
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  const snap = () => ({ savedAt: NOW, idCounter: 1000, db });
  return { store, layer, db, save: () => store.save(snap()), unit: (w) => store.unitOfWork(w, { snapshot: snap }), repo: layer.recruitmentCases, close: () => store.sqlite.close() };
}

test('[schema] migration 0016 is registered between 0015 and 0017 and creates the twenty-five typed STRICT tables (no lossless side column, the vocabulary CHECKs, the children cascading, the room rows RESTRICT, a decision\'s snapshot by key); the case keys of requests, trials, contacts and offers are immediate; idempotency_keys belongs to the signing packages; a fresh database holds no row and no blob', () => {
  const ids = DATA_MIGRATIONS.map((m) => m.id);
  assert.ok(ids.indexOf('0015_recruitment') < ids.indexOf(MIGRATION) && ids.indexOf(MIGRATION) < ids.indexOf('0017_recruitment_contacts_offers'));
  for (const n of COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is table-backed`);
  const d = tempDir('s8b-fresh'); const f = openStore(d).sqlite;
  for (const t of TABLES) {
    const sql = ddlOf(f, t); assert.ok(sql, `${t} exists`); assert.match(sql, /STRICT\s*$/, `${t} is STRICT`); assert.equal(col(f, `SELECT count(*) FROM ${t}`), 0);
    for (const c of ['raw_json', 'extra_json', 'absent_keys_json', 'offtype_json']) assert.ok(!f.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c), `${t}: no ${c}`);
  }
  assert.match(ddlOf(f, 'recruitment_cases'), /room_status TEXT CHECK \(room_status IS NULL OR room_status IN \('watching'/);
  assert.match(ddlOf(f, 'case_budget_lines'), /schedule TEXT NOT NULL CHECK \(schedule IS NULL OR schedule IN \('one_off','weekly','monthly','annual'\)\)/);
  assert.match(ddlOf(f, 'room_evidence_states'), /UNIQUE \(room_id, evidence_id\)/);
  assert.deepEqual(fkOf(f, 'case_history'), ['case_id->recruitment_cases CASCADE']);
  for (const t of ['room_comments', 'room_snapshots', 'room_decisions', 'room_evidence_states']) assert.ok(fkOf(f, t).includes('room_id->recruitment_cases RESTRICT'), t);
  assert.ok(fkOf(f, 'room_decisions').includes('snapshot_id->room_snapshots RESTRICT'));
  for (const t of ['recruitment_requests', 'trials', 'recruitment_contacts', 'recruitment_offers']) assert.ok(fkOf(f, t).includes('case_id->recruitment_cases RESTRICT'), `${t}.case_id is immediate`);
  assert.match(ddlOf(f, 'idempotency_keys'), /owner_table IN \('signing_packages'\)/);
  for (const n of COLLECTIONS) assert.equal(col(f, 'SELECT count(*) FROM collections WHERE name = ?', n), 0, `no ${n} blob`);
  f.close(); rm(d);
});

test('[snapshot][typed] every writer shape — the room case (the facet with its reopen and tags, both task literals, assignments, the draft and its key, the handoff and its key, the budget with its lines, FX and actuals), the M12 case with its approval and sign-off, a bare M12 case, the deleted player\'s case, a comment with its edit and tombstone, a snapshot with and without trust, the recommendation and the formal decision, an evidence state — is written by a snapshot save and reads back as the typed record, in insertion order; the decision\'s snapshot is the row it names', () => {
  const d = file('typed'); const s = openStore(d); const back = s.load().db;
  const fix = S8B_FIX();
  for (const n of COLLECTIONS) assert.deepEqual(plain(back[n]), fix[n].map((r) => typed(n, r)).map((r) => (n === 'roomDecisions' && r.snapshot ? { ...r, snapshot: back[n].find((x) => x.id === r.id).snapshot } : r)), `${n} reads back typed`);
  const fin = back.roomDecisions.find((x) => x.id === 'rdec-2');
  assert.deepEqual(plain(fin.snapshot), { at: TC.decided, trust: trustedSnapshot().trust, sourceRefs: trustedSnapshot().sourceRefs, snapshotId: 'rsnap-2' }, 'the formal decision reads its snapshot from rsnap-2');
  withRo(d, (r) => {
    assert.equal(col(r, "SELECT snapshot_id FROM room_decisions WHERE id = 'rdec-2'"), 'rsnap-2');
    assert.equal(col(r, "SELECT create_key FROM case_decision_drafts WHERE case_id = 'case-1'"), 'draft-key-1', 'the draft\'s key is a column');
    assert.equal(col(r, "SELECT invite_key FROM case_transaction_handoffs WHERE case_id = 'case-1'"), 'invite-key-1');
    assert.equal(col(r, "SELECT finalize_key FROM room_decisions WHERE id = 'rdec-2'"), 'fin-key-1');
    assert.equal(col(r, "SELECT due_at FROM case_tasks WHERE case_id = 'case-1'"), TC.moved + 2 * 24 * 3600_000, 'an instant due date');
    assert.equal(col(r, "SELECT due_day FROM case_tasks WHERE case_id = 'case-2'"), '2026-11-20', 'a day due date');
    assert.equal(col(r, "SELECT detail_text FROM case_history WHERE id = 'aud-c2-1'"), 'identified', 'an M12 text detail');
    assert.equal(JSON.parse(col(r, "SELECT detail_json FROM case_history WHERE id = 'aud-c1-1'")).status, 'under_review', 'an object detail');
    assert.equal(col(r, "SELECT count(*) FROM case_budget_lines WHERE case_id = 'case-1'"), 2);
    assert.equal(col(r, "SELECT room_status FROM recruitment_cases WHERE id = 'case-2'"), null, 'an M12 case has no Room facet');
  });
  // an absent field reads back as null, an absent list as empty
  const bare = back.recruitmentCases.find((c) => c.id === 'case-legacy');
  assert.equal(bare.room, null); assert.equal(bare.budget, null); assert.equal(bare.decisionDraft, null); assert.equal(bare.transactionHandoff, null); assert.deepEqual(bare.approvals, []);
  s.sqlite.close(); rm(d);
});

test('[snapshot][typed] a save STOPS with the ids on a record the tables cannot hold — nothing written, the same save refused again: an unknown field (top level and nested), a status outside the vocabulary, an off-type value, a due date that is neither a day nor an instant, a duplicate id, a duplicate link, the M27 `by` history literal, a room row naming no case, a link naming no request, a decision chain crossing rooms, a decision citing another room\'s snapshot', () => {
  const fix = S8B_FIX();
  const withCase = (over) => ({ recruitmentCases: [roomCase(over), ...fix.recruitmentCases.slice(1)] });
  refusedSave('unknown', withCase({ legacyFlag: true }), /case-1\.record\.legacyFlag is not a field this table stores/);
  refusedSave('nested unknown', withCase({ room: { ...roomCase().room, colour: 'red' } }), /case-1\.room\.colour is not a field this table stores/);
  refusedSave('vocabulary', withCase({ room: { ...roomCase().room, status: 'shortlist' } }), /case-1\.room\.status must be one of/);
  refusedSave('off-type', withCase({ createdAt: 'yesterday' }), /case-1\.createdAt must be an integer/);
  refusedSave('due date', withCase({ tasks: [{ ...roomCase().tasks[0], dueAt: 'soon' }] }), /tasks\[0\]\.dueAt must be a YYYY-MM-DD day, an instant in ms, or null/);
  refusedSave('duplicate id', { recruitmentCases: [...fix.recruitmentCases, m12Case()] }, /duplicates the id of an earlier entry \(case-2\)/);
  refusedSave('duplicate link', withCase({ links: { requestIds: ['req-p4b'], trialIds: ['trial-1', 'trial-1'], signingId: null } }), /case-1\.links\.trialIds repeats trial-1/);
  refusedSave('m27 history literal', withCase({ history: [{ id: 'aud-x', at: TC.decided, action: 'transaction_handoff_invited', by: { kind: 'org', userId: SCOUT.userId, name: SCOUT.name }, detail: null }] }), /history\[0\]\.entry\.by is not a field this table stores/);
  refusedSave('room case', { roomComments: [...fix.roomComments, comment({ id: 'rcmt-9', roomId: 'case-nowhere' })] }, /ROOM_CASE_MISSING[\s\S]*room_comments rcmt-9 → case case-nowhere/);
  refusedSave('link', withCase({ links: { requestIds: ['req-nowhere'], trialIds: ['trial-1'], signingId: null } }), /CASE_LINK_DANGLING[\s\S]*case case-1 links request req-nowhere/);
  const other = m12Case({ id: 'case-other', playerId: 'pl-adult', links: { requestIds: [], trialIds: [], signingId: null }, history: [], approvals: [], decision: null });
  refusedSave('chain', { recruitmentCases: [...fix.recruitmentCases, other], roomDecisions: [recommendation({ roomId: 'case-other', snapshot: null }), formalDecision()] }, /DECISION_CHAIN_BROKEN[\s\S]*rdec-2 \(room case-1\) names rdec-1 \(supersedes\) of room case-other/);
  refusedSave('snapshot room', { recruitmentCases: [...fix.recruitmentCases, other], roomSnapshots: [snapshot({ roomId: 'case-other' }), trustedSnapshot()] }, /DECISION_CHAIN_BROKEN[\s\S]*rdec-1 names snapshot rsnap-1, which is not a snapshot of room case-1/);
});

test('[snapshot] removals: a supplied collection is the whole final collection — a room row it no longer lists goes, a case it no longer lists goes with its children; a case a retained row still names is refused with the table and the ids, nothing changed; a partial save leaves an omitted collection whole', () => {
  const d = file('prune'); const s = openStore(d);
  const before = caseDump(s.sqlite);
  refused(() => s.save({ savedAt: NOW, idCounter: 1000, db: fixtureDb({ recruitmentCases: S8B_FIX().recruitmentCases.filter((c) => c.id !== 'case-1') }) }), /CASE_STILL_REFERENCED[\s\S]*recruitment_requests → case case-1|CASE_STILL_REFERENCED[\s\S]*→ case case-1/, 'case-1 is still named by requests, trials and room rows');
  assert.equal(caseDump(s.sqlite), before, 'nothing changed');
  s.save({ savedAt: NOW, idCounter: 1000, db: fixtureDb({ roomComments: [comment()] }) });
  withRo(d, (r) => { assert.deepEqual(r.prepare('SELECT id FROM room_comments ORDER BY rowid').all().map((x) => x.id), ['rcmt-1']); assert.equal(col(r, "SELECT count(*) FROM room_comment_mentions WHERE comment_id <> 'rcmt-1'"), 0, 'the removed comments\' mentions went with them'); assert.equal(col(r, 'SELECT count(*) FROM room_decisions'), 2, 'the omitted decisions stay'); });
  s.save({ savedAt: NOW, idCounter: 1000, db: fixtureDb({ recruitmentCases: S8B_FIX().recruitmentCases.filter((c) => c.id !== 'case-gone') }) });
  withRo(d, (r) => { assert.equal(col(r, "SELECT count(*) FROM recruitment_cases WHERE id = 'case-gone'"), 0); assert.equal(col(r, "SELECT count(*) FROM case_history WHERE case_id = 'case-gone'"), 0, 'its history cascaded'); assert.equal(col(r, 'SELECT count(*) FROM recruitment_cases'), 3); });
  s.sqlite.close(); rm(d);
});

test('[repository] explicit writes: the five views are read-only (an in-place edit throws, a push throws); create and update write rows at once and return fresh read-only records; update hands a plain copy, refuses an identifier change and an update inside its own update; a refused write changes nothing', () => {
  const d = file('repo'); const L = serverOpen(d); const R = L.repo;
  const held = L.db.recruitmentCases.find((c) => c.id === 'case-1');
  refused(() => { held.stage = 'closed'; }, /written through its domain repository/, 'a field');
  refused(() => { held.history.push(hist('aud-x', NOW, 'x')); }, /written through its domain repository/, 'a nested push');
  refused(() => { L.db.roomComments.push(comment({ id: 'rcmt-9' })); }, /written through its domain repository/, 'a collection push');
  const fresh = R.cases.update('case-1', (c) => { c.room.tags.push('fast'); c.history.push(hist('aud-c1-9', NOW, 'room_tag_changed', { count: 3 })); });
  assert.deepEqual(plain(fresh.room.tags), ['watch', 'u18', 'fast']); assert.equal(held.room.tags.length, 2, 'the held record is the old version');
  withRo(d, (r) => { assert.equal(col(r, "SELECT count(*) FROM case_room_tags WHERE case_id = 'case-1'"), 3, 'the row is written at once'); assert.equal(col(r, "SELECT action FROM case_history WHERE id = 'aud-c1-9'"), 'room_tag_changed'); });
  refused(() => R.cases.update('case-1', (c) => { c.playerId = 'pl-other'; }), /playerId cannot change/);
  refused(() => R.cases.update('case-1', () => { R.cases.update('case-1', () => {}); }), /already being updated/);
  const before = withRo(d, caseDump);
  refused(() => R.cases.update('case-1', (c) => { c.room.status = 'somewhere'; }), /RECRUITMENT_CASES_INPUT_INVALID[\s\S]*room\.status must be one of/);
  refused(() => R.comments.create(comment({ id: 'rcmt-9', roomId: 'case-nowhere' })), /ROOM_CASE_MISSING/);
  refused(() => R.comments.create(comment()), /RECRUITMENT_CASES_DUPLICATE/);
  refused(() => R.evidenceStates.create(evidenceState({ id: 'rev-2' })), /already reviews evidence ev-1/);
  refused(() => R.cases.create(m12Case({ id: 'case-9', ownerUserId: 'usr-nobody' })), /RECRUITMENT_CASES_REFERENCE_MISSING[\s\S]*org_users usr-nobody/);
  assert.equal(withRo(d, caseDump), before, 'nothing was written by a refused operation');
  const c9 = R.cases.create(m12Case({ id: 'case-9', links: { requestIds: [], trialIds: [], signingId: null }, history: [] }));
  assert.equal(c9.id, 'case-9'); assert.ok(L.db.recruitmentCases.some((c) => c.id === 'case-9'));
  refused(() => { c9.priority = 'high'; }, /written through its domain repository/, 'a returned record is read-only');
  L.close(); rm(d);
});

test('[repository] decisions: an advisory recommendation and its supersession, a formal decision naming its snapshot (read back from the snapshot row, never a copy), a chain crossing rooms refused with DECISION_CHAIN_BROKEN', () => {
  const d = file('dec'); const L = serverOpen(d); const R = L.repo;
  const snap = R.snapshots.create(snapshot({ id: 'rsnap-9', at: NOW, trigger: 'decision' }));
  const dec = R.decisions.create(recommendation({ id: 'rdec-9', createdAt: NOW, clientKey: null, supersedes: 'rdec-2', supersededById: null, snapshot: { at: snap.at, trust: snap.trust, sourceRefs: snap.sourceRefs, snapshotId: snap.id } }));
  R.decisions.update('rdec-2', (x) => { x.supersededById = 'rdec-9'; });
  assert.deepEqual(plain(dec.snapshot), { at: snap.at, trust: null, sourceRefs: plain(snap.sourceRefs), snapshotId: 'rsnap-9' });
  withRo(d, (r) => { assert.equal(col(r, "SELECT superseded_by_id FROM room_decisions WHERE id = 'rdec-2'"), 'rdec-9'); assert.equal(col(r, "SELECT snapshot_id FROM room_decisions WHERE id = 'rdec-9'"), 'rsnap-9'); });
  R.cases.create(m12Case({ id: 'case-x', links: { requestIds: [], trialIds: [], signingId: null }, history: [] }));
  refused(() => R.decisions.create(recommendation({ id: 'rdec-x', roomId: 'case-x', supersedes: 'rdec-9', supersededById: null, snapshot: null })), /DECISION_CHAIN_BROKEN[\s\S]*names rdec-9 \(supersedes\) of room case-1/);
  refused(() => R.decisions.create(recommendation({ id: 'rdec-y', roomId: 'case-x', supersedes: null, supersededById: null, snapshot: { snapshotId: 'rsnap-9' } })), /not a snapshot of room case-x/);
  L.close(); rm(d);
});

test('[repository] a unit of work: case, comment and decision writes commit together; a unit that fails rolls the rows AND the mirrors back; the deletion unit\'s redaction keeps ids, states and history and loses the name', () => {
  const d = file('unit'); const L = serverOpen(d); const R = L.repo;
  const rows = withRo(d, caseDump); const mirror = JSON.stringify(L.db.recruitmentCases);
  refused(() => L.unit(() => { R.comments.create(comment({ id: 'rcmt-u' })); R.cases.update('case-1', (c) => { c.room.updatedAt = NOW; }); throw new Error('synthetic unit failure'); }), /synthetic unit failure/);
  assert.equal(withRo(d, caseDump), rows, 'no row changed'); assert.equal(JSON.stringify(L.db.recruitmentCases), mirror, 'the mirror is back'); assert.equal(L.db.roomComments.some((c) => c.id === 'rcmt-u'), false);
  L.unit(() => { R.comments.create(comment({ id: 'rcmt-u' })); R.cases.update('case-1', (c) => { c.history.push(hist('aud-u', NOW, 'room_comment_added', { commentId: 'rcmt-u', replyToId: null })); }); });
  withRo(d, (r) => { assert.equal(col(r, "SELECT count(*) FROM room_comments WHERE id = 'rcmt-u'"), 1); assert.equal(col(r, "SELECT count(*) FROM case_history WHERE id = 'aud-u'"), 1); });
  assert.equal(R.redactPlayer('pl-adult', NOW + 5), 1);
  const red = L.db.recruitmentCases.find((c) => c.id === 'case-1');
  assert.equal(red.playerName, null); assert.equal(red.subjectRemovedAt, NOW + 5); assert.equal(red.playerId, 'pl-adult'); assert.equal(red.room.status, 'trial_requested'); assert.ok(red.history.length >= 6);
  assert.equal(R.counts().recruitmentCases, 4); assert.equal(R.pending(), 0);
  L.close(); rm(d);
});

test('[references] the player references are tolerant and counted (Q8a): the deleted player\'s case and a snapshot naming nobody are stored and counted, never refused', () => {
  const d = file('counts');
  withRo(d, (r) => {
    const unresolved = rc.unresolvedPlayerReferences(r); const retained = rc.retainedPlayerReferences(r);
    assert.ok(unresolved.recruitmentCases >= 1, 'the deleted player\'s case is counted'); assert.equal(typeof retained.roomSnapshots, 'number');
    assert.equal(col(r, "SELECT player_id FROM recruitment_cases WHERE id = 'case-gone'"), 'pl-gone-long-ago');
  });
  rm(d);
});

console.log(`${passed} recruitment cases checks passed`);
