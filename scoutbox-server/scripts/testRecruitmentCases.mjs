// S8b — recruitment cases, room comments, room snapshots, room decisions and room evidence states as typed tables with
// EXPLICIT writes (repositories/recruitmentCases.mjs, migration 0016; docs/architecture/migration.md §4.3). What this
// suite proves: the migration creates the twenty-five typed STRICT tables (no lossless side column, the vocabulary
// CHECKs, the children cascading, the room rows RESTRICT) and the case keys of requests, trials, contacts and offers are
// immediate; a snapshot save (fixtures, tools) types every writer shape into its columns and reads back the typed record,
// refuses a record it cannot type and names every missing reference with ids; the player references are counted, never
// refused (Q8a); the repository's operations write rows at once and return fresh read-only records (§4.3 step 2: no
// db.* view, every query matches a table scan), the records refuse an
// in-place edit, an update inside its own update is refused, a unit of work rolls rows AND mirrors back; a decision's
// snapshot is the snapshot row it names; the deletion unit's redaction.
// Temporary databases only; nothing touches DATA_DIR. Run with: npm test
import assert from 'node:assert/strict';
import { checkHistoryFeed } from './historyFeedCheck.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir, USERS, hasBlobTable } from './coreIdentityTestFixtures.mjs';
import { ROOM_STATUSES, OPEN_ROOM_STATUSES, CASE_STAGES, TASK_STATES, roomRole } from '../domains/recruitment/rooms/shared.mjs';
import { pageSorted } from '../domains/platform/paging.mjs';
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
  const db = {}; // S14a: a fixture-saved file is not a first installation, so there is nothing to hand in
  const layer = attachDataLayer({ db, store, nextId, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  return { store, layer, db, save: () => store.save(), unit: (w) => store.unitOfWork(w), repo: layer.recruitmentCases, close: () => store.sqlite.close() };
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
  assert.equal(hasBlobTable(f), false, 'no blob table'); // rewritten in S14a: it described the blob
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

test('[repository] explicit writes: there is no db.* view (reading or assigning one of the five throws, naming the repository) and every record a query returns is read-only (an in-place edit throws); create and update write rows at once and return fresh read-only records; update hands a plain copy, refuses an identifier change and an update inside its own update; a refused write changes nothing', () => {
  const d = file('repo'); const L = serverOpen(d); const R = L.repo;
  for (const n of ['recruitmentCases', 'roomComments', 'roomSnapshots', 'roomDecisions', 'roomEvidenceState']) { assert.throws(() => L.db[n], new RegExp(`db\\.${n} is gone: read it through the recruitmentCases repository`)); assert.throws(() => { L.db[n] = []; }, /is gone/); assert.equal(Object.keys(L.db).includes(n), false); }
  const held = R.cases.byId('case-1');
  assert.throws(() => { held.stage = 'closed'; }, /read only|Cannot assign/, 'a field');
  assert.throws(() => { held.history.push(hist('aud-x', NOW, 'x')); }, /not extensible|read only|Cannot add/, 'a nested push');
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
  assert.equal(c9.id, 'case-9'); assert.ok(R.cases.byId('case-9'));
  assert.throws(() => { c9.priority = 'high'; }, /read only|Cannot assign/, 'a returned record is read-only');
  L.close(); rm(d);
});

test('[repository] SQL reads (§4.3 step 2): byId and every list query of the five collections return exactly what a scan of the tables would, in insertion order; the handoff-agent query, the Room counts and the per-status counts agree; `reads` carries no write', () => {
  const d = file('reads'); const L = serverOpen(d); const R = L.repo;
  const all = R.exportAll();
  const ids = (rows) => rows.map((r) => r.id);
  const values = (list, key) => [...new Set(list.map(key).filter((v) => v !== null && v !== undefined)), 'nobody'];
  const check = (label, got, want) => assert.deepEqual(ids(got), ids(want), label);
  const repoOf = { recruitmentCases: R.cases, roomComments: R.comments, roomSnapshots: R.snapshots, roomDecisions: R.decisions, roomEvidenceState: R.evidenceStates };
  for (const [n, repo] of Object.entries(repoOf)) {
    for (const r of all[n]) assert.deepEqual(plain(repo.byId(r.id)), plain(r), `${n}.byId ${r.id}`);
    for (const bad of ['nope', undefined, null, 42]) assert.equal(repo.byId(bad), null);
    if (n !== 'recruitmentCases') for (const v of values(all[n], (r) => r.roomId)) check(`${n}.forRoom ${v}`, repo.forRoom(v), all[n].filter((r) => r.roomId === v));
  }
  const cases = all.recruitmentCases;
  for (const [key, q] of [['orgId', 'forOrg'], ['playerId', 'forPlayer']]) for (const v of values(cases, (c) => c[key])) check(`cases.${q} ${v}`, R.cases[q](v), cases.filter((c) => c[key] === v));
  for (const c of cases) check('cases.forOrgPlayer', R.cases.forOrgPlayer(c.orgId, c.playerId), cases.filter((x) => x.orgId === c.orgId && x.playerId === c.playerId));
  for (const v of values(cases, (c) => c.transactionHandoff?.invitedAgentUserId)) check(`cases.forHandoffAgent ${v}`, R.cases.forHandoffAgent(v), cases.filter((c) => c.transactionHandoff?.invitedAgentUserId === v));
  check('cases.withRoom', R.cases.withRoom(), cases.filter((c) => c.room)); assert.equal(R.cases.roomCount(), cases.filter((c) => c.room).length);
  checkHistoryFeed('cases.roomHistoryFeed', { feed: R.cases.roomHistoryFeed, count: R.cases.roomHistoryCount, records: cases.filter((c) => c.room), ownerKey: 'caseId' });
  // §4.3 step 4: a list decodes its cases' children in one batch; each record is the one byId decodes on its own.
  const whole = (list) => assert.deepEqual(plain(list), plain(list.map((c) => R.cases.byId(c.id))), 'a batch-decoded list is the per-case decode');
  for (const v of values(cases, (c) => c.orgId)) whole(R.cases.forOrg(v)); whole(R.cases.withRoom()); whole(cases);
  for (const part of ['budget', 'decisionDraft', 'transactionHandoff', 'room']) assert.ok(cases.some((c) => c[part]), `the fixture exercises ${part}`);
  assert.ok(cases.some((c) => c.tasks.length && c.history.length && c.assignments.length), 'the fixture exercises tasks, history and assignments');
  for (const v of values(cases, (c) => c.orgId)) {
    assert.equal(R.cases.countForOrg(v), cases.filter((c) => c.orgId === v).length);
    const want = {}; for (const c of cases.filter((x) => x.orgId === v && x.room)) want[c.room.status] = (want[c.room.status] ?? 0) + 1;
    assert.deepEqual(R.cases.roomStatusCounts(v), want, `roomStatusCounts ${v}`);
  }
  const decs = all.roomDecisions;
  for (const v of values(decs, (r) => r.orgId)) check(`decisions.forOrg ${v}`, R.decisions.forOrg(v), decs.filter((r) => r.orgId === v));
  for (const r of decs) check('decisions.forOrgPlayer', R.decisions.forOrgPlayer(r.orgId, r.playerId), decs.filter((x) => x.orgId === r.orgId && x.playerId === r.playerId));
  for (const n of ['cases', 'comments', 'snapshots', 'decisions', 'evidenceStates']) { assert.ok(Object.isFrozen(R.reads[n])); assert.equal(R.reads[n].byId, R[n].byId); assert.equal(R.reads[n].create, undefined); assert.equal(R.reads[n].update, undefined); }
  L.close(); rm(d);
});

test('[repository] the per-viewer lists in SQL (§4.3 step 4): over sixty varied cases, every viewer (lead or not, owner, Room lead, assignee, stranger), every filter and every page size, pageForViewer and roomPageForViewer return exactly the pages the old in-code filter, sort and pageSorted returned; the search filter keeps reading until the page is full; the access-scoped Room counts, the open-Room rows, the overdue-task counts and the Rooms with a decision agree with the records', () => {
  const H = 3_600_000;
  let seed = 7; const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 65536) % n; };
  const pick = (xs) => xs[rnd(xs.length)];
  const STAFF = ['usr-1', 'usr-2', 'usr-3'];
  const users = [...USERS(), { id: 'usr-2', orgId: 'org-pro', name: 'Sam', role: 'Scout', createdAt: 1 }, { id: 'usr-3', orgId: 'org-pro', name: 'Ola', role: 'Analyst', createdAt: 1 }];
  const made = [];
  for (let i = 0; i < 64; i += 1) {
    const due = () => pick([null, NOW - 2 * H, NOW + 2 * H, '2026-11-20', 0]);
    const base = {
      id: `case-v${String(i).padStart(2, '0')}`, playerId: pick(['pl-adult', 'pl-child1']), playerName: pick(['Adult Signup', 'Child pl-child1', null]),
      ownerUserId: pick(STAFF), stage: pick(CASE_STAGES), restricted: rnd(3) === 0, createdAt: TC.created + rnd(6) * H,
      assignments: rnd(2) ? [{ id: 'asg-x', userId: pick(STAFF), name: 'X', task: 'Look', dueAt: null, status: pick(TASK_STATES), createdAt: TC.created }] : [],
      tasks: Array.from({ length: rnd(3) }, (_, k) => ({ id: `tsk-x${k}`, title: 'Do', dueAt: due(), assigneeUserId: pick([...STAFF, null]), status: pick(TASK_STATES), createdAt: TC.created })),
      links: { requestIds: [], trialIds: [], signingId: null }, history: [],
    };
    if (rnd(4) === 0) { made.push(m12Case({ ...base, approvals: [], decision: null })); continue; }
    const tags = ['watch', 'u18', 'left'].filter(() => rnd(2));
    made.push(roomCase({ ...base, decisionDraft: null, transactionHandoff: null, budget: null, room: { ...roomCase().room, status: pick(ROOM_STATUSES), tags, leadScoutUserId: pick([...STAFF, null]), updatedAt: TC.moved + rnd(5) * H, reopened: null } }));
  }
  const d = file('viewers', { users }); const L = serverOpen(d); const R = L.repo;
  L.unit(() => { for (const c of made) R.cases.create(c); });
  const all = R.exportAll().recruitmentCases.filter((c) => c.orgId === 'org-pro');
  const decs = R.exportAll().roomDecisions;
  assert.ok(all.filter((c) => c.room).length > 30 && all.some((c) => c.room && c.restricted) && all.some((c) => !c.room && c.restricted), 'rooms and cases, restricted and open');
  const ids = (xs) => xs.map((c) => c.id);
  const walk = (fetch, limit) => { const seen = []; let cursor; for (let n = 0; n < 200; n += 1) { const p = fetch(cursor === undefined ? { limit } : { limit, after: JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) }); seen.push(p); if (!p.nextCursor) return seen; cursor = p.nextCursor; } throw new Error('the pages never ended'); };
  const same = (label, got, want) => { assert.deepEqual(got.map((p) => [ids(p.items), p.nextCursor]), want.map((p) => [ids(p.items), p.nextCursor]), label); };
  const newestFirst = (a, b) => (b[0] - a[0]) || (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0);
  const recentFirst = (a, b) => (b[0] - a[0]) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
  const viewers = [...STAFF.map((userId) => ({ userId, isLead: false })), { userId: 'usr-1', isLead: true }, { userId: 'nobody', isLead: false }];
  let nonEmpty = 0;
  for (const v of viewers) {
    const user = { id: v.userId };
    const caseOk = (c) => !c.restricted || c.ownerUserId === v.userId || c.assignments.some((a) => a.userId === v.userId) || v.isLead;
    const roomOk = (c) => c.room && roomRole({ room: c, user, isLead: v.isLead }) !== null;
    for (const stage of [null, 'identified', 'trial']) {
      const want = all.filter(caseOk).filter((c) => stage === null || c.stage === stage).sort((a, b) => newestFirst([a.createdAt, a.id], [b.createdAt, b.id]));
      for (const limit of [1, 3, 100]) same(`cases ${v.userId}/${v.isLead} ${stage} by ${limit}`, walk((page) => R.cases.pageForViewer('org-pro', v, { stage }, page), limit), walk((page) => pageSorted(want, page, (c) => [c.createdAt, c.id], newestFirst), limit));
    }
    const filters = [
      [{}, () => true],
      [{ statuses: OPEN_ROOM_STATUSES }, (c) => OPEN_ROOM_STATUSES.includes(c.room.status)],
      [{ statuses: ['shortlisted', 'priority'] }, (c) => ['shortlisted', 'priority'].includes(c.room.status)],
      [{ mineOf: v.userId }, (c) => c.ownerUserId === v.userId || c.room.leadScoutUserId === v.userId],
      [{ assignedTo: v.userId }, (c) => c.assignments.some((a) => a.userId === v.userId) || c.tasks.some((t) => t.assigneeUserId === v.userId && ['open', 'in_progress'].includes(t.status))],
      [{ status: 'shortlisted' }, (c) => c.room.status === 'shortlisted'],
      [{ tag: 'watch' }, (c) => c.room.tags.includes('watch')],
      [{ assignee: 'usr-2' }, (c) => c.tasks.some((t) => t.assigneeUserId === 'usr-2') || c.room.leadScoutUserId === 'usr-2' || c.ownerUserId === 'usr-2'],
      [{ statuses: OPEN_ROOM_STATUSES, tag: 'u18', assignee: 'usr-3' }, (c) => OPEN_ROOM_STATUSES.includes(c.room.status) && c.room.tags.includes('u18') && (c.tasks.some((t) => t.assigneeUserId === 'usr-3') || c.room.leadScoutUserId === 'usr-3' || c.ownerUserId === 'usr-3')],
    ];
    for (const [filter, keep] of filters) {
      for (const search of [null, (x) => x.tags.includes('left') || (x.playerName ?? '').includes('Child')]) {
        const want = all.filter(roomOk).filter(keep).filter((c) => !search || search({ ...c, status: c.room.status, tags: c.room.tags })).sort((a, b) => recentFirst([a.room.updatedAt, a.id], [b.room.updatedAt, b.id]));
        nonEmpty += want.length ? 1 : 0;
        for (const limit of [1, 3, 100]) same(`rooms ${v.userId}/${v.isLead} ${JSON.stringify(filter)} search=${!!search} by ${limit}`, walk((page) => R.cases.roomPageForViewer('org-pro', v, filter, page, search), limit), walk((page) => pageSorted(want, page, (c) => [c.room.updatedAt, c.id], recentFirst), limit));
      }
      assert.deepEqual(R.cases.roomRowsForViewer('org-pro', v, filter).map((x) => x.id), ids(all.filter(roomOk).filter(keep)), `roomRowsForViewer ${JSON.stringify(filter)}`);
    }
    const counts = {}; for (const c of all.filter(roomOk)) counts[c.room.status] = (counts[c.room.status] ?? 0) + 1;
    assert.deepEqual(R.cases.roomStatusCounts('org-pro', v), counts, `roomStatusCounts for ${v.userId}/${v.isLead}`);
  }
  assert.ok(nonEmpty > 50, `the filters select rooms (${nonEmpty} of 90 non-empty)`);
  const light = R.cases.roomRowsForViewer('org-pro', viewers[3], {})[0]; const full = all.find((c) => c.id === light.id);
  assert.deepEqual(light, { id: full.id, playerId: full.playerId, playerName: full.playerName, status: full.room.status });
  for (const at of [NOW - 3 * H, NOW, NOW + 3 * H]) {
    const want = new Map(); for (const c of all) { const n = c.tasks.filter((t) => ['open', 'in_progress'].includes(t.status) && t.dueAt && t.dueAt < at).length; if (n) want.set(c.id, n); }
    assert.deepEqual([...R.cases.overdueTaskCounts('org-pro', at)].sort(), [...want].sort(), `overdueTaskCounts at ${at - NOW}`);
  }
  assert.ok(R.cases.overdueTaskCounts('org-pro', NOW).size > 0, 'some tasks are overdue');
  assert.deepEqual([...R.decisions.roomIdsForOrg('org-pro')].sort(), [...new Set(decs.filter((x) => all.some((c) => c.id === x.roomId)).map((x) => x.roomId))].sort());
  assert.ok(R.decisions.roomIdsForOrg('org-pro').size > 0); assert.equal(R.decisions.roomIdsForOrg('nobody').size, 0);
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

test('[repository] a unit of work: case, comment and decision writes commit together; a unit that fails rolls the rows back while a read inside it sees its writes; the deletion unit\'s redaction keeps ids, states and history and loses the name', () => {
  const d = file('unit'); const L = serverOpen(d); const R = L.repo;
  const rows = withRo(d, caseDump); const before = JSON.stringify(R.exportAll());
  refused(() => L.unit(() => { R.comments.create(comment({ id: 'rcmt-u' })); R.cases.update('case-1', (c) => { c.room.updatedAt = NOW; }); assert.ok(R.comments.byId('rcmt-u'), 'a read inside the unit sees its create'); assert.equal(R.cases.byId('case-1').room.updatedAt, NOW); throw new Error('synthetic unit failure'); }), /synthetic unit failure/);
  assert.equal(withRo(d, caseDump), rows, 'no row changed'); assert.equal(JSON.stringify(R.exportAll()), before, 'a fresh read sees the rollback'); assert.equal(R.comments.byId('rcmt-u'), null);
  L.unit(() => { R.comments.create(comment({ id: 'rcmt-u' })); R.cases.update('case-1', (c) => { c.history.push(hist('aud-u', NOW, 'room_comment_added', { commentId: 'rcmt-u', replyToId: null })); }); });
  withRo(d, (r) => { assert.equal(col(r, "SELECT count(*) FROM room_comments WHERE id = 'rcmt-u'"), 1); assert.equal(col(r, "SELECT count(*) FROM case_history WHERE id = 'aud-u'"), 1); });
  assert.equal(R.redactPlayer('pl-adult', NOW + 5), 1);
  const red = R.cases.byId('case-1');
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
