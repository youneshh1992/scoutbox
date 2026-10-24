// S8b — recruitment cases, room comments, room snapshots, room decisions and room evidence states as tables
// (repositories/recruitmentCases.mjs, migration 0016, repositories/recruitmentCasesRollback.mjs): the bounded storage
// migration designed in docs/architecture/s8b-readiness-review.md (accepted at 4d2c74b) and approved for the player
// references by the Founder's Q8a answer of 23 October 2026, "Approve tolerant (Recommended)" (no player foreign key;
// live, retained and historically missing ids resolve, are counted and never refused, fabricated or deleted).
// The lossless mapping (every writer literal of the review's §2: the M12 case, the M17 room facet with its reopen, both
// task literals, both history literals, the draft and its keys, the handoff and its keys, the budget with its lines,
// fx assumptions and actuals, the comment edit and tombstone, the snapshot with and without trust, the recommendation
// and the formal decision with its snapshot copy and keys, the evidence state, a legacy case without the backfilled
// keys, prototype-named own fields, duplicate link entries, absent / null / off-type / unknown values); the cutover
// (migration 0016: the twenty-five tables, the two S8a parents rebuilt with the REAL case key — Q7b's conversion —,
// idempotency_keys rebuilt with the broadened owner CHECK, every S8a row and thread byte-identical, the counts, every
// refusal with ids only, the Q8a counts); the repository (in-place mutation landing in the next save with the owned
// children rewritten and the polymorphic keys cleaned, an unchanged save writing nothing, the failure contracts, held
// nested views); the corrected snapshot write of the review's §6 through the REAL store (P A R B C D F1 F2 F3 G: the
// reviewer's F1a/F1b/F1c, F2 for each room collection and all four, R1 the owned history under the kept RESTRICT key,
// both input orders, partial saves equal to full saves, the retained refusals with their tables, an injected failure
// after the owned children were removed and before the parent, the retry landing once); the copy-only rollback tool.
// Temporary databases only; nothing touches DATA_DIR. Run with: npm test
//
// FAILING-FIRST NOTE (recorded on the unchanged 4d2c74b tree, source-identical to the accepted 7a7efc6, before the
// implementation): the tests marked [cutover] need migration 0016, the repository module and the rollback module and
// FAIL there on concrete assertions (the migration id is absent from DATA_MIGRATIONS and TABLE_BACKED; the tables do
// not exist; the blobs survive; the parents carry no case key; the modules are absent). The [behaviour] test fails on
// the unchanged tree on a BEHAVIOURAL assertion: that build's whole-snapshot save removes a case a retained room comment
// still names (and silently keeps the comment), where this step refuses with the table and the ids. The [compat] checks
// hold on both trees.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations } from '../repositories/database.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir, s3File, openRaw, applied, blob, blobText, meta, failRunAt, FIXTURE } from './coreIdentityTestFixtures.mjs';
import { trialReportsFor } from '../repositories/playerSubrecords.mjs';
import { p4bInvitation, minorInvitation, acceptedRequest, scheduledTrial, legacyTrialRequest, T } from './recruitmentTestFixtures.mjs';
import { m12Case, roomCase, legacyCase, tombstonedCase, comment, editedComment, tombstonedComment, snapshot, trustedSnapshot, recommendation, formalDecision, evidenceState, hist, S8B_FIX, persisted, TC } from './recruitmentCasesTestFixtures.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const HERE = path.dirname(fileURLToPath(import.meta.url)); void HERE;
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const dbFile = (dir) => path.join(dir, 'scoutbox.db');
let counter = 9000; const nextId = (p) => `${p}-${++counter}`;
const MIGRATION = '0016_recruitment_cases'; const S8A = '0015_recruitment';
const COLLECTIONS = ['recruitmentCases', 'roomComments', 'roomSnapshots', 'roomDecisions', 'roomEvidenceState'];
const CASE_TABLES = ['recruitment_cases', 'case_room_tags', 'case_assignments', 'case_tasks', 'case_approvals', 'case_history', 'case_request_links', 'case_trial_links', 'case_decision_drafts', 'case_decision_draft_reason_codes', 'case_decision_draft_evidence_refs', 'case_transaction_handoffs', 'case_budget_scenarios', 'case_budget_lines', 'case_budget_fx_assumptions', 'case_budget_actuals'];
const ROOM_TABLES = ['room_comments', 'room_comment_mentions', 'room_snapshots', 'room_snapshot_source_refs', 'room_decisions', 'room_decision_reason_codes', 'room_decision_evidence_refs', 'room_decision_assessment_ids', 'room_evidence_states'];
const TABLES = [...CASE_TABLES, ...ROOM_TABLES];
const S8A_TABLES = ['recruitment_requests', 'request_trial_slots', 'trials', 'trial_schedule_sessions', 'trial_session_evidence', 'trial_schedule_revisions', 'trial_attendance', 'trial_reminders', 'trial_day_staff', 'trial_day_consents', 'trial_day_checkins', 'trial_day_status_events', 'trial_reports', 'trial_history', 'idempotency_keys'];
let rc = null; let rollbackMod = null;
try { rc = await import('../repositories/recruitmentCases.mjs'); } catch { rc = null; }
try { rollbackMod = await import('../repositories/recruitmentCasesRollback.mjs'); } catch { rollbackMod = null; }
const s8aRollbackMod = await import('../repositories/recruitmentRollback.mjs'); // the S8a tool: the rollback chain's previous link
const needRc = () => { assert.ok(rc?.createRecruitmentCasesRepository, 'repositories/recruitmentCases.mjs exports createRecruitmentCasesRepository (the S8b repository module)'); return rc; };
const s8cRollbackMod = await import('../repositories/recruitmentContactsOffersRollback.mjs'); // S8c: a live file of this build carries 0017, which the S8b tool refuses outright (LATER_SCHEMA); the chain runs the S8c tool (copy-only) first and the S8b tool on ITS output
const viaS8c = (file, out, opts = {}) => { const s8c = tempDir('s8b-via-s8c'); s8cRollbackMod.rollbackRecruitmentContactsOffersCopy(file, s8c, { now: opts.now }); return rollbackMod.rollbackRecruitmentCasesCopy(dbFile(s8c), out, opts); };
const needRollback = () => { assert.ok(rollbackMod?.rollbackRecruitmentCasesCopy, 'repositories/recruitmentCasesRollback.mjs exports rollbackRecruitmentCasesCopy (the S8b rollback module)'); return viaS8c; };
const second = (dir) => new DatabaseSync(dbFile(dir), { readOnly: true });
const withRo = (dir, fn) => { const s = second(dir); try { return fn(s); } finally { s.close(); } };
const tableExistsIn = (s, t) => !!s.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
const plain = (v) => JSON.parse(JSON.stringify(v));
const fullDump = (s) => JSON.stringify(s.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => [r.name, s.prepare(`SELECT * FROM "${r.name}"`).all().map((x) => ({ ...x }))]));
/** The S8b, S8a and thread tables as an exact dump (rowid order). */
const allDump = (s) => JSON.stringify(Object.fromEntries([...TABLES, ...S8A_TABLES, 'channels', 'messages'].filter((t) => tableExistsIn(s, t)).map((t) => [t, s.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().map((r) => ({ ...r }))])));
/** The same dump with `seq` stripped and rows sorted: two input orders compare by content. */
const canon = (s) => JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(allDump(s))).map(([t, rows]) => [t, rows.map(({ seq, ...r }) => JSON.stringify(r)).sort()])));
const fkTargets = (s, table) => s.prepare(`PRAGMA foreign_key_list(${table})`).all().map((r) => `${r.from}->${r.table}(${r.to}) ${r.on_delete}`);
const ddlOf = (s, t) => s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)?.sql ?? null;
const content = (s, t, where = '1') => JSON.stringify(s.prepare(`SELECT * FROM "${t}" WHERE ${where} ORDER BY rowid`).all().map(({ seq, ...r }) => r));
const ownedOf = (s, caseId) => ({ history: content(s, 'case_history', `case_id = '${caseId}'`), tags: content(s, 'case_room_tags', `case_id = '${caseId}'`), tasks: content(s, 'case_tasks', `case_id = '${caseId}'`), draft: content(s, 'case_decision_drafts', `case_id = '${caseId}'`), handoff: content(s, 'case_transaction_handoffs', `case_id = '${caseId}'`), budget: content(s, 'case_budget_lines', `case_id = '${caseId}'`), keys: content(s, 'idempotency_keys', `owner_table IN ('case_decision_drafts', 'case_transaction_handoffs') AND owner_id = '${caseId}'`), links: { r: content(s, 'case_request_links', `case_id = '${caseId}'`), t: content(s, 'case_trial_links', `case_id = '${caseId}'`) } });
const CHANNEL = (over = {}) => ({ id: 'chan-1', requestId: 'req-p4b', playerId: 'pl-adult', playerName: 'Adult Signup', orgId: 'org-pro', orgName: 'Eastport FC', orgVerified: true, scoutName: 'Maria', scoutRole: 'Head of Recruitment', counterparty: 'player', guardianId: null, createdAt: T.accepted, messages: [{ id: 'msg-1', ts: T.accepted + 1, sender: { kind: 'org_user', id: 'usr-1', name: 'Maria' }, text: 'Welcome.', attachment: null }], readBy: { org: null, counterparty: null }, ...over });
const S8A_FIX = () => ({ requests: [acceptedRequest(p4bInvitation(), 'trial-1'), minorInvitation(), legacyTrialRequest()], trials: [scheduledTrial()] });

/** A file at S8a-core (0001–0015 applied) carrying the five S8b blobs the 7a7efc6 build wrote beside the S8a tables (requests, trials, a thread). */
function preS8bFile(dir, { requests, trials, channels = [CHANNEL()], rawBlobs, more = {}, ...five } = {}) {
  const fix = S8B_FIX(); const extra = { ledger: [], vouches: [], notifications: [], dispatches: [], ...more };
  for (const name of COLLECTIONS) { const v = Object.hasOwn(five, name) ? five[name] : fix[name]; if (v !== undefined) extra[name] = v; }
  const s8a = S8A_FIX(); extra.requests = requests === undefined ? s8a.requests : requests; extra.trials = trials === undefined ? s8a.trials : trials; if (channels !== undefined) extra.channels = channels;
  const players = FIXTURE().players.map((p) => ({ ...p, trialReports: trialReportsFor(Array.isArray(extra.trials) ? plain(extra.trials) : [], p.id) }));
  s3File(dir, { players, extra, rawBlobs });
  const s = openRaw(dir); runDataMigrations(s, DATA_MIGRATIONS.filter((m) => m.id < MIGRATION), { now: NOW, context: { sessionTtlMs: TTL } }); s.close();
}
const migrateAll = (s, { now = NOW } = {}) => runDataMigrations(s, DATA_MIGRATIONS, { now, context: { sessionTtlMs: TTL } });
const file = (tag, over = {}) => { const d = tempDir(`s8b-${tag}`); preS8bFile(d, over); const s = openRaw(d); migrateAll(s); s.close(); return d; };

/** The server-mode harness: the real store + data layer, saves through store.save, reads through a second connection. */
function serverOpen(dir, { warnings = [] } = {}) {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const loaded = store.load();
  const db = { ...loaded.db, players: [], guardians: [] };
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW, warn: (m) => warnings.push(m) });
  const snapshot = () => ({ savedAt: NOW, idCounter: 1000, db });
  return { store, layer, db, warnings, snapshot, save: () => store.save(snapshot()), revision: () => store.revision(), repo: layer.recruitmentCases, recruitment: layer.recruitment, close: () => store.sqlite.close() };
}
/** The snapshot-mode harness (backups, restores, persistence tools): whole snapshots through writeTableBacked. */
function snapshotOpen(dir) {
  const store = openStore(dir);
  const loaded = store.load();
  const db = loaded.db;
  const save = (over = {}, { omit = [] } = {}) => { const d = { ...db, ...over }; for (const k of omit) delete d[k]; return store.save({ savedAt: NOW, idCounter: 1000, db: d }); };
  return { store, db, save, revision: () => store.revision(), close: () => store.sqlite.close() };
}
const refused = (fn, pattern, label = '') => { let err = null; try { fn(); } catch (e) { err = e; } assert.ok(err, `${label}: expected a refusal`); assert.match(String(err.message), pattern, `${label}: ${err.message}`); assert.doesNotMatch(String(err.message), /Adult Signup|Quick on the turn|Strong on the left|Harbour Road/, `${label}: ids only`); return err; };
const reversed = (over) => Object.fromEntries(Object.entries(over).map(([k, v]) => [k, Array.isArray(v) ? [...v].reverse() : v]));

// ------------------------------------------------------------- the migration
test('[cutover] migration 0016 is registered last and, on an S8a-core file, creates the twenty-five case and room tables, rebuilds recruitment_requests and trials with the REAL case_id key (RESTRICT — Q7b\'s conversion) and idempotency_keys with the broadened owner CHECK while every S8a row, key row, thread, message and attachment survives byte for byte; imports the five blobs row for row and retires them; records counts only (the Q8a player counts included); reruns are no-ops; a file without the blobs creates the tables and imports nothing — never from the seed or memory', () => {
  assert.equal(DATA_MIGRATIONS.at(-2)?.id, MIGRATION, 'migration 0016_recruitment_cases is registered after 0015; 0017_recruitment_contacts_offers (S8c) follows it'); assert.equal(DATA_MIGRATIONS.at(-1)?.id, '0017_recruitment_contacts_offers');
  for (const n of COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is a table-backed collection`);
  const dir = tempDir('s8b-mig'); preS8bFile(dir);
  const s = openRaw(dir);
  const s8aBefore = JSON.stringify(S8A_TABLES.map((t) => s.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())); const threadsBefore = JSON.stringify([s.prepare('SELECT * FROM channels ORDER BY seq').all(), s.prepare('SELECT * FROM messages ORDER BY seq').all()]);
  const blobs = Object.fromEntries(COLLECTIONS.map((n) => [n, blob(s, n)]));
  const ran = migrateAll(s);
  assert.deepEqual(ran.ran, [MIGRATION, '0017_recruitment_contacts_offers'], '0017 (S8c) runs on the same boot');
  for (const t of TABLES) assert.ok(tableExistsIn(s, t), `${t} exists`);
  for (const t of ['recruitment_requests', 'trials']) assert.ok(fkTargets(s, t).includes('case_id->recruitment_cases(id) RESTRICT'), `${t}.case_id is a real key: ${fkTargets(s, t)}`);
  assert.match(ddlOf(s, 'idempotency_keys'), /owner_table IN \('recruitment_requests', 'trials', 'recruitment_cases', 'case_decision_drafts', 'case_transaction_handoffs', 'room_decisions', 'recruitment_contacts', 'recruitment_offers'\)/, 'the broadened owner CHECK (0016 adds the four S8b owners; 0017, on the same boot, the two S8c owners)');
  assert.equal(JSON.stringify(S8A_TABLES.map((t) => s.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().filter((r) => !['case_decision_drafts', 'case_transaction_handoffs', 'room_decisions', 'recruitment_cases', 'recruitment_contacts', 'recruitment_offers'].includes(r.owner_table)))), s8aBefore, 'every S8a row (the key rows of the two S8a owners included) survives the rebuilds byte for byte');
  assert.equal(JSON.stringify([s.prepare('SELECT * FROM channels ORDER BY seq').all(), s.prepare('SELECT * FROM messages ORDER BY seq').all()]), threadsBefore);
  assert.equal(s.prepare('PRAGMA foreign_key_check').all().length, 0);
  for (const n of COLLECTIONS) assert.equal(blob(s, n), undefined, `${n} blob retired`);
  const { readCases, readRoomComments, readRoomSnapshots, readRoomDecisions, readRoomEvidenceStates } = needRc();
  assert.deepEqual(readCases(s), blobs.recruitmentCases, 'the cases come back exactly'); assert.deepEqual(readRoomComments(s), blobs.roomComments); assert.deepEqual(readRoomSnapshots(s), blobs.roomSnapshots); assert.deepEqual(readRoomDecisions(s), blobs.roomDecisions); assert.deepEqual(readRoomEvidenceStates(s), blobs.roomEvidenceState);
  const record = JSON.parse(meta(s, 'recruitmentCasesCutover'));
  assert.equal(record.recruitmentCases.imported, 4); assert.equal(record.roomComments.imported, 3); assert.equal(record.roomSnapshots.imported, 2); assert.equal(record.roomDecisions.imported, 2); assert.equal(record.roomEvidenceState.imported, 1);
  assert.deepEqual(record.players, { live: 8, retained: 0, missing: 1 }, 'Q8a: the case of pl-gone-long-ago is counted as missing (cases 4 + snapshots 2 + decisions 2 + handoffs 1 = 9 references), never refused');
  assert.equal(record.recruitmentCases.withExtraFields, 1, 'the legacy case\'s unknown field'); assert.equal(record.recruitmentCases.withAbsentKeys, 4, 'every case lacks at least one known key (subjectRemovedAt before a removal; decisionDraft / transactionHandoff on an M12 case; the legacy case\'s room, budget, restricted, decision, approvals) — absence recorded, never backfilled'); assert.equal(record.recruitmentCases.roomless, 3, 'three cases without a room facet');
  assert.equal(JSON.stringify(record).includes('Adult Signup'), false, 'counts only');
  assert.deepEqual(migrateAll(s).ran, []);
  s.close();
  const fresh = tempDir('s8b-fresh'); preS8bFile(fresh, { recruitmentCases: undefined, roomComments: undefined, roomSnapshots: undefined, roomDecisions: undefined, roomEvidenceState: undefined, requests: [], trials: [], channels: [] });
  const f = openRaw(fresh); migrateAll(f); assert.equal(f.prepare('SELECT count(*) AS n FROM recruitment_cases').get().n, 0); assert.ok(fkTargets(f, 'trials').includes('case_id->recruitment_cases(id) RESTRICT')); f.close(); rm(dir, fresh);
});

test('[cutover] the mapping is lossless for every writer shape: the room case (the facet with its reopen and tags, both task literals, assignments, both history literals, a duplicate trial link kept in position, the draft with its keys.create row, the handoff with its keys.invite row, the budget with lines, fx assumptions, approval and actuals), the M12 case (approvals, the approved decision, room null, budget null), the legacy case (no room/budget/restricted/decision/approvals keys, an unknown field, a history entry with an unknown field), the tombstoned case, a prototype-named own field, an off-type createdAt, a non-finite number, empty/null/empty-list acts; the comments (reply, edit, tombstone, mentions), the snapshots (trust null and present; the note stored as written), the recommendation (superseded) and the formal decision (its snapshot COPY, keys finalize/draft as rows, evidence refs, assessment ids, lifecycle), the evidence state', () => {
  const own = (json) => JSON.parse(json);
  const odd = { ...legacyCase({ id: 'case-odd', createdAt: 'not-a-number', ratio: Infinity, deadline: undefined }), ...own('{"__proto__":{"polluted":true},"constructor":"own-ctor"}') };
  const draftOdd = roomCase({ id: 'case-odd2', links: { requestIds: [], trialIds: [], signingId: null }, decisionDraft: { ...roomCase().decisionDraft, id: 'rdraft-odd', keys: { create: null, empty: {}, list: [], nothing: null } }, transactionHandoff: { ...roomCase().transactionHandoff, id: 'hof-odd', caseId: 'case-odd2', keys: {} }, budget: null, history: [], room: { ...roomCase().room, tags: [], reopened: undefined } });
  const cases = [roomCase(), m12Case(), legacyCase(), tombstonedCase(), odd, draftOdd];
  const decisions = [recommendation(), formalDecision({ keys: { finalize: null, draft: { key: 'draft-key-1', fp: 'fp-draft-1' } } }), formalDecision({ id: 'rdec-3', supersedes: 'rdec-2', snapshot: null, evidenceRefs: [], assessmentSummary: { submitted: 0, withheld: 1, verdicts: {}, assessmentIds: [] }, lifecycle: null, note: null })];
  const dir = tempDir('s8b-map'); preS8bFile(dir, { recruitmentCases: persisted(cases), roomDecisions: persisted(decisions), roomComments: persisted([comment(), editedComment(), tombstonedComment()]), roomSnapshots: persisted([snapshot(), trustedSnapshot()]), roomEvidenceState: persisted([evidenceState()]) });
  const s = openRaw(dir); migrateAll(s); assert.ok(tableExistsIn(s, 'recruitment_cases'), 'migration 0016 created recruitment_cases'); assert.equal(blob(s, 'recruitmentCases'), undefined, 'the blob retired');
  const { readCases, readRoomComments, readRoomSnapshots, readRoomDecisions, readRoomEvidenceStates } = needRc();
  const backC = readCases(s);
  assert.deepEqual(backC, persisted(cases)); assert.deepEqual(readRoomComments(s), persisted([comment(), editedComment(), tombstonedComment()])); assert.deepEqual(readRoomSnapshots(s), persisted([snapshot(), trustedSnapshot()])); assert.deepEqual(readRoomDecisions(s), persisted(decisions)); assert.deepEqual(readRoomEvidenceStates(s), persisted([evidenceState()]));
  // presence, not only equality
  const leg = backC.find((c) => c.id === 'case-legacy'); for (const k of ['room', 'budget', 'restricted', 'decision', 'approvals']) assert.equal(k in leg, false, `the legacy case has no ${k} key`); assert.equal(leg.legacyFlag, true); assert.equal(leg.history[0].legacyNote, 'kept'); assert.equal('signingId' in leg.links, false);
  const o = backC.find((c) => c.id === 'case-odd'); assert.equal(o.createdAt, 'not-a-number'); assert.equal(o.ratio, null, 'a non-finite number persists as JSON null (the blob rule)'); assert.equal('deadline' in o, false, 'a live undefined is absence'); assert.ok(Object.hasOwn(o, '__proto__') && o.__proto__.polluted === true, 'the prototype-named own field'); assert.equal(o.constructor, 'own-ctor');
  const r = backC.find((c) => c.id === 'case-1'); assert.deepEqual(r.links.trialIds, ['trial-1', 'trial-1'], 'the duplicate link entry kept'); assert.equal(r.history[3].by.kind, 'org', 'the m27 history literal'); assert.equal('byKind' in r.history[3], false); assert.equal(r.room.reopened.sourceRef.id, 'sl-1'); assert.equal(r.budget.scenarios[0].fxAssumptions[0].rate, '0.861234', 'the rate stays the decimal TEXT the route stores');
  const d2 = backC.find((c) => c.id === 'case-odd2'); assert.deepEqual(d2.decisionDraft.keys, { create: null, empty: {}, list: [], nothing: null }, 'empty, null and empty-list acts kept distinctly'); assert.deepEqual(d2.transactionHandoff.keys, {}); assert.equal('reopened' in d2.room, false);
  const tomb = backC.find((c) => c.id === 'case-gone'); assert.equal(tomb.playerName, null); assert.equal(tomb.subjectRemovedAt, T.removed);
  const dec = readRoomDecisions(s); assert.deepEqual(dec[1].snapshot, persisted(formalDecision().snapshot), 'the decision\'s full snapshot copy, stored and read back'); assert.equal(dec[0].supersededById, 'rdec-2'); assert.equal(readRoomSnapshots(s)[0].note, snapshot().note, 'the note stored as written');
  // the tables hold the mapped columns (not only JSON): a few probes
  assert.equal(s.prepare("SELECT room_status FROM recruitment_cases WHERE id = 'case-1'").get().room_status, 'trial_requested'); assert.equal(s.prepare("SELECT room_status FROM recruitment_cases WHERE id = 'case-2'").get().room_status, null);
  assert.deepEqual(s.prepare("SELECT position, trial_id FROM case_trial_links WHERE case_id = 'case-1' ORDER BY position").all().map((x) => [x.position, x.trial_id]), [[0, 'trial-1'], [1, 'trial-1']]); assert.equal(s.prepare("SELECT request_id FROM case_request_links WHERE case_id = 'case-2'").get().request_id, 'req-minor');
  assert.equal(s.prepare("SELECT count(*) AS n FROM case_history").get().n, 5 + 4 + 1 + 1 + 1 + 0, 'every history entry a row (the room case, the M12 case, the legacy case, the tombstoned case, the odd case; the draft-odd case has none)'); assert.equal(s.prepare("SELECT count(*) AS n FROM case_room_tags WHERE case_id = 'case-1'").get().n, 2); assert.equal(s.prepare("SELECT count(*) AS n FROM case_budget_lines").get().n, 2); assert.equal(s.prepare("SELECT count(*) AS n FROM case_budget_actuals").get().n, 1);
  assert.equal(s.prepare("SELECT key FROM idempotency_keys WHERE owner_table = 'case_decision_drafts' AND owner_id = 'case-1' AND act = 'create'").get().key, 'draft-key-1', 'the draft\'s keys.create as a row, owned by the CASE id (review of b7c0dd0, F2)'); assert.equal(s.prepare("SELECT key FROM idempotency_keys WHERE owner_table = 'case_transaction_handoffs' AND owner_id = 'case-1' AND act = 'invite'").get().key, 'invite-key-1'); assert.equal(s.prepare("SELECT count(*) AS n FROM idempotency_keys WHERE owner_id IN ('rdraft-1', 'hof-1', 'rdraft-odd', 'case-odd2')").get().n, 0, 'never the child id; a draft whose acts carry no string key holds them on the row');
  assert.deepEqual(s.prepare("SELECT act, key FROM idempotency_keys WHERE owner_table = 'room_decisions' AND owner_id = 'rdec-2' ORDER BY position").all().map((x) => [x.act, x.key]), [['draft', 'draft-key-1']], 'the formal decision\'s string-keyed act as a row; the null finalize act held on the row');
  assert.equal(s.prepare("SELECT count(*) AS n FROM room_snapshot_source_refs WHERE snapshot_id = 'rsnap-2'").get().n, 3 + 1 + 2 + 1); assert.equal(s.prepare("SELECT count(*) AS n FROM room_comment_mentions").get().n, 1); assert.equal(s.prepare("SELECT deleted_by_user_id FROM room_comments WHERE id = 'rcmt-3'").get().deleted_by_user_id, 'usr-1');
  s.close(); rm(dir);
});

test('[cutover] the import refuses with ids only — nothing written, the blobs, the S8a tables and the record untouched, the next boot refuses the same way: a case without an owner/org/player/createdAt/id, a duplicate case id, a non-object entry, a non-array blob, a non-JSON blob, a PRESENT null blob, a room row naming a case that is not in the file, a link naming a request or trial not in the tables, a request or trial naming a case not in the file (Q7b, now the key), an owner or author not in org_users, an org not in orgs, a decision naming a predecessor outside the file; a case, a snapshot, a decision and a handoff naming a missing player are imported and counted (Q8a)', () => {
  const refuse = (label, fixture, pattern) => {
    const dir = tempDir('s8b-refuse'); preS8bFile(dir, { channels: [], ...fixture }); const s = openRaw(dir); const before = [fullDump(s), applied(s)];
    assert.throws(() => migrateAll(s), (e) => { assert.match(String(e.message), /RECRUITMENT_CASES_IMPORT_BLOCKED/, `${label}: ${e.message}`); assert.match(String(e.message), pattern, `${label}: ${e.message}`); assert.doesNotMatch(String(e.message), /Adult Signup|Quick on the turn|Strong on the left/, `${label}: ids only`); return true; });
    assert.deepEqual([fullDump(s), applied(s)], before, `${label}: nothing written`); for (const t of TABLES) assert.equal(tableExistsIn(s, t), false, `${label}: ${t} not created`); assert.equal(s.isTransaction, false);
    assert.throws(() => migrateAll(s), /RECRUITMENT_CASES_IMPORT_BLOCKED/, `${label}: the next boot refuses the same way`); s.close(); rm(dir);
  };
  const minimal = { roomComments: [], roomSnapshots: [], roomDecisions: [], roomEvidenceState: [], requests: [], trials: [] };
  refuse('no owner', { ...minimal, recruitmentCases: [{ ...m12Case(), ownerUserId: undefined, links: { requestIds: [] } }] }, /entry #0.*ownerUserId/);
  refuse('no id', { ...minimal, recruitmentCases: [{ ...m12Case(), id: undefined }] }, /entry #0/);
  refuse('no createdAt', { ...minimal, recruitmentCases: [{ ...m12Case(), createdAt: undefined, links: { requestIds: [] } }] }, /createdAt/);
  refuse('duplicate id', { ...minimal, recruitmentCases: [legacyCase(), legacyCase()] }, /case-legacy/);
  refuse('non-object', { ...minimal, recruitmentCases: ['nope'] }, /entry #0/);
  refuse('non-array', { ...minimal, recruitmentCases: undefined, rawBlobs: { recruitmentCases: JSON.stringify({ a: 1 }) } }, /array/);
  refuse('non-json', { ...minimal, recruitmentCases: undefined, rawBlobs: { recruitmentCases: '{not json' } }, /JSON/);
  refuse('present null blob', { ...minimal, roomComments: undefined, rawBlobs: { roomComments: 'null' } }, /roomComments blob.*null/);
  refuse('comment naming no case', { ...minimal, recruitmentCases: [legacyCase()], roomComments: [comment({ roomId: 'case-ghost' })] }, /rcmt-1.*case-ghost|case-ghost/);
  refuse('snapshot naming no case', { ...minimal, recruitmentCases: [legacyCase()], roomSnapshots: [snapshot({ roomId: 'case-ghost' })] }, /case-ghost/);
  refuse('link naming no trial', { ...minimal, recruitmentCases: [roomCase({ links: { requestIds: [], trialIds: ['trial-ghost'], signingId: null } })] }, /trial-ghost/);
  refuse('link naming no request', { ...minimal, recruitmentCases: [legacyCase({ links: { requestIds: ['req-ghost'], trialIds: [] } })] }, /req-ghost/);
  // a request or trial naming a case outside the file never reaches 0016: the S8a import (Q7b, strict) refuses the file at 0015 first, so the key rebuild meets no dangling case id
  for (const [label, fixture] of [['request naming no case', { ...minimal, recruitmentCases: [legacyCase()], requests: [p4bInvitation({ caseId: 'case-ghost', trialId: null })] }], ['trial naming no case', { ...minimal, recruitmentCases: [legacyCase()], requests: [acceptedRequest(p4bInvitation({ caseId: null }), 'trial-1')], trials: [scheduledTrial({ caseId: 'case-ghost' })] }]]) {
    const dir = tempDir('s8b-q7b'); assert.throws(() => preS8bFile(dir, { channels: [], ...fixture }), /0015_recruitment failed: RECRUITMENT_IMPORT_BLOCKED: RECRUITMENT_CASE_MISSING.*case-ghost/, `${label}: refused at 0015 (Q7b), before 0016`); rm(dir);
  }
  refuse('owner not in org_users', { ...minimal, recruitmentCases: [legacyCase({ ownerUserId: 'usr-ghost' })] }, /usr-ghost/);
  refuse('author not in org_users', { ...minimal, recruitmentCases: [legacyCase({ id: 'case-1' })], roomComments: [comment({ authorId: 'usr-ghost' })] }, /usr-ghost/);
  refuse('org not in orgs', { ...minimal, recruitmentCases: [legacyCase({ orgId: 'org-ghost' })] }, /org-ghost/);
  refuse('decision chain', { ...minimal, recruitmentCases: [legacyCase({ id: 'case-1' })], roomDecisions: [recommendation({ supersededById: null, supersedes: 'rdec-ghost' })] }, /rdec-ghost/);
  // Q8a: tolerant, counted
  const dir = tempDir('s8b-q8a'); preS8bFile(dir, { ...minimal, recruitmentCases: [roomCase({ id: 'case-1', playerId: 'pl-gone', links: { requestIds: [], trialIds: [], signingId: null }, transactionHandoff: { ...roomCase().transactionHandoff, playerId: 'pl-gone' } }), tombstonedCase()], roomSnapshots: [snapshot({ playerId: 'pl-gone' })], roomDecisions: [recommendation({ playerId: 'pl-gone', supersededById: null })], channels: [] });
  const s = openRaw(dir); migrateAll(s); const c = JSON.parse(meta(s, 'recruitmentCasesCutover'));
  assert.deepEqual(c.players, { live: 0, retained: 0, missing: 5 }, 'pl-gone on a case, a handoff, a snapshot and a decision + the tombstoned case: counted, imported as they are');
  assert.equal(s.prepare("SELECT count(*) AS n FROM recruitment_cases WHERE player_id = 'pl-gone'").get().n, 1); assert.equal(s.prepare("SELECT player_id FROM case_transaction_handoffs WHERE id = 'hof-1'").get().player_id, 'pl-gone');
  assert.deepEqual(needRc().unresolvedPlayerReferences(s), { recruitmentCases: 2, roomSnapshots: 1, roomDecisions: 1, caseTransactionHandoffs: 1 });
  s.close(); rm(dir);
});

// ------------------------------------------------------------- the repository (server mode, staged)
test('[cutover] the repository: the five views are read-only ARRAYS of plain mutable records; addCase/addComment/addSnapshot/addDecision/addEvidenceState land in the next save as rows with their children; in-place mutations (a status move, a history push, an M17 task push, a budget scenario push, the draft set and later nulled, the handoff set, a comment edit and tombstone, an evidence state overwrite, a decision superseded) land in the next save with the owned children rewritten in list order and the polymorphic key rows cleaned; removeDecision before a save lands nothing; an unchanged save writes no S8b row and advances the revision; the exports are detached copies; a reopen serves the same records', () => {
  const dir = tempDir('s8b-repo'); preS8bFile(dir); { const s = openRaw(dir); migrateAll(s); s.close(); }
  const L = serverOpen(dir);
  for (const n of COLLECTIONS) { assert.ok(Array.isArray(L.db[n]), `${n} is an array view`); assert.throws(() => L.db[n].push({ id: 'x' }), /repositor/i, `${n} is a read-only view (push refused)`); assert.throws(() => { L.db[n][0] = {}; }, /repositor/i); }
  needRc(); const R = L.repo; assert.ok(R, 'attachDataLayer returns the recruitmentCases repository');
  assert.equal(L.db.recruitmentCases.length, 4); assert.equal(L.db.roomDecisions.length, 2);
  const kase = L.db.recruitmentCases.find((c) => c.id === 'case-1'); const room = kase.room; // the live objects
  const added = R.addCase(m12Case({ id: 'case-new', playerId: 'pl-child2', playerName: 'Child pl-child2', links: { requestIds: [], trialIds: [], signingId: null }, history: [hist('aud-n-1', NOW, 'created', 'identified')], assignments: [], tasks: [], approvals: [], decision: null })); assert.equal(added, L.db.recruitmentCases.at(-1), 'the record itself is kept');
  const c1 = R.addComment(comment({ id: 'rcmt-new', roomId: 'case-1', body: 'A new comment.', mentions: [], createdAt: NOW })); assert.equal(L.db.roomComments.at(-1), c1);
  R.addSnapshot(snapshot({ id: 'rsnap-new', at: NOW, trigger: 'status:shortlisted' })); R.addEvidenceState(evidenceState({ id: 'rev-new', evidenceId: 'ev-2', at: NOW }));
  const d3 = R.addDecision(recommendation({ id: 'rdec-3', supersedes: 'rdec-2', supersededById: null, clientKey: 'rec-key-3', createdAt: NOW, snapshot: null })); L.db.roomDecisions.find((d) => d.id === 'rdec-2').supersededById = 'rdec-3';
  room.status = 'shortlisted'; room.rev = 4; room.revAt = NOW; kase.stage = 'shortlist'; kase.history.push(hist('aud-c1-6', NOW, 'room_status_changed', { from: 'trial_requested', to: 'shortlisted' }));
  kase.tasks.push({ id: 'tsk-3', title: 'Second viewing', description: null, assigneeUserId: null, assigneeName: null, status: 'open', dueAt: null, linkedResourceType: null, linkedResourceId: null, createdBy: { userId: 'usr-1', name: 'Maria' }, createdAt: NOW, completedAt: null });
  kase.budget.scenarios.push({ ...roomCase().budget.scenarios[0], id: 'scn-2', label: 'Stretch', lines: [], fxAssumptions: [], approval: null, actuals: [], version: 1 });
  kase.decisionDraft = { ...roomCase().decisionDraft, id: 'rdraft-2', keys: { create: { key: 'draft-key-2', fp: 'fp-2' } } }; // the discard-and-redraft path: the old draft's key row must go
  const r0 = L.revision(); L.save(); assert.equal(L.revision(), r0 + 1);
  withRo(dir, (s) => {
    assert.equal(s.prepare("SELECT room_status, stage FROM recruitment_cases WHERE id = 'case-1'").get().room_status, 'shortlisted'); assert.equal(s.prepare("SELECT count(*) AS n FROM case_history WHERE case_id = 'case-1'").get().n, 6); assert.equal(s.prepare("SELECT title FROM case_tasks WHERE case_id = 'case-1' AND position = 1").get().title, 'Second viewing');
    assert.equal(s.prepare("SELECT count(*) AS n FROM case_budget_scenarios WHERE case_id = 'case-1'").get().n, 2); assert.equal(s.prepare("SELECT id FROM case_decision_drafts WHERE case_id = 'case-1'").get().id, 'rdraft-2');
    assert.deepEqual(s.prepare("SELECT owner_id, key FROM idempotency_keys WHERE owner_table = 'case_decision_drafts' ORDER BY owner_id").all().map((x) => [x.owner_id, x.key]), [['case-1', 'draft-key-2']], 'the replaced draft\'s key row is gone, the new one present under the case id');
    assert.ok(s.prepare("SELECT 1 FROM recruitment_cases WHERE id = 'case-new'").get()); assert.equal(s.prepare("SELECT body FROM room_comments WHERE id = 'rcmt-new'").get().body, 'A new comment.'); assert.ok(s.prepare("SELECT 1 FROM room_snapshots WHERE id = 'rsnap-new'").get()); assert.ok(s.prepare("SELECT 1 FROM room_evidence_states WHERE id = 'rev-new'").get());
    assert.equal(s.prepare("SELECT superseded_by_id FROM room_decisions WHERE id = 'rdec-2'").get().superseded_by_id, 'rdec-3'); assert.equal(s.prepare("SELECT supersedes_id FROM room_decisions WHERE id = 'rdec-3'").get().supersedes_id, 'rdec-2');
  });
  // the comment edit and tombstone, the evidence overwrite, the draft nulled (finalize), the handoff withdrawn
  c1.body = 'Edited.'; c1.editedAt = NOW + 1; c1.editCount = 1; const c3 = L.db.roomComments.find((x) => x.id === 'rcmt-1'); c3.deletedAt = NOW + 2; c3.deletedBy = { userId: 'usr-1', name: 'Maria' };
  Object.assign(L.db.roomEvidenceState.find((x) => x.id === 'rev-1'), { state: 'disputed', note: null, at: NOW + 3 });
  kase.decisionDraft = null; kase.transactionHandoff.status = 'withdrawn'; kase.transactionHandoff.withdrawnAt = NOW + 4; kase.transactionHandoff.rev = 2;
  L.save();
  withRo(dir, (s) => {
    assert.deepEqual(plain(s.prepare("SELECT body, edit_count FROM room_comments WHERE id = 'rcmt-new'").get()), { body: 'Edited.', edit_count: 1 }); assert.equal(s.prepare("SELECT deleted_at FROM room_comments WHERE id = 'rcmt-1'").get().deleted_at, NOW + 2);
    assert.equal(s.prepare("SELECT state FROM room_evidence_states WHERE id = 'rev-1'").get().state, 'disputed'); assert.equal(s.prepare("SELECT count(*) AS n FROM case_decision_drafts WHERE case_id = 'case-1'").get().n, 0); assert.equal(s.prepare("SELECT count(*) AS n FROM idempotency_keys WHERE owner_table = 'case_decision_drafts'").get().n, 0, 'the finalized draft\'s key row cleaned');
    assert.equal(s.prepare("SELECT status FROM case_transaction_handoffs WHERE id = 'hof-1'").get().status, 'withdrawn');
  });
  // removeDecision before a save: nothing lands
  const d4 = R.addDecision(recommendation({ id: 'rdec-4', supersedes: 'rdec-3', supersededById: null, clientKey: 'rec-key-4', createdAt: NOW + 5, snapshot: null })); d3.supersededById = 'rdec-4'; R.removeDecision(d4); d3.supersededById = null;
  assert.equal(L.db.roomDecisions.some((d) => d.id === 'rdec-4'), false); L.save(); withRo(dir, (s) => assert.equal(s.prepare("SELECT count(*) AS n FROM room_decisions WHERE id = 'rdec-4'").get().n, 0));
  // unchanged save: nothing rewritten
  const before = withRo(dir, allDump); const r1 = L.revision(); L.save(); assert.equal(withRo(dir, allDump), before, 'an unchanged save rewrites nothing'); assert.equal(L.revision(), r1 + 1);
  const p = R.pending(); assert.equal(Object.values(p).reduce((a, b) => a + b, 0), 0);
  const exported = R.exportCases(); assert.notEqual(exported.find((c) => c.id === 'case-1'), kase); assert.deepEqual(plain(exported), plain(L.db.recruitmentCases)); assert.deepEqual(plain(R.exportRoomDecisions()), plain(L.db.roomDecisions));
  L.close();
  const again = serverOpen(dir); assert.deepEqual(plain(again.db.recruitmentCases), plain(exported)); assert.deepEqual(plain(again.db.roomComments), plain(L.db.roomComments)); assert.equal(again.db.recruitmentCases.find((c) => c.id === 'case-1').room.status, 'shortlisted'); again.close(); rm(dir);
});

test('[cutover] the two failure contracts: a failed ORDINARY save (a statement failure, then a failure of the REAL COMMIT) leaves the tables and the revision unchanged, keeps every pending change in memory and lands it ONCE on the next save; an aborted UNIT OF WORK (a joined failure, a real COMMIT failure) rolls the tables back AND restores the pre-unit graph in place — held nested views (the room facet, the draft, a history list, a comment) read the pre-unit values; edits pending before the unit stay pending; the retry lands once', () => {
  const dir = tempDir('s8b-fail'); preS8bFile(dir); { const s = openRaw(dir); migrateAll(s); s.close(); }
  withRo(dir, (s) => assert.ok(tableExistsIn(s, 'recruitment_cases'), 'migration 0016 created recruitment_cases'));
  const L = serverOpen(dir); needRc(); const R = L.repo;
  const kase = L.db.recruitmentCases.find((c) => c.id === 'case-1'); const room = kase.room; const history = kase.history; const c1 = L.db.roomComments[0];
  room.status = 'shortlisted'; room.rev = 4; history.push(hist('aud-x', NOW, 'room_status_changed', { to: 'shortlisted' }));
  const before = withRo(dir, allDump); const rev = L.revision();
  const probe = failRunAt(L.store.sqlite, (sql) => /INTO recruitment_cases|INTO case_history/.test(sql), 1, 'synthetic statement failure');
  assert.throws(() => L.save(), /synthetic statement failure/); probe.restore();
  assert.equal(withRo(dir, allDump), before); assert.equal(L.revision(), rev); assert.equal(room.status, 'shortlisted', 'memory is the intended state'); assert.equal(L.store.sqlite.isTransaction, false);
  let armCommitFailure = false; L.store.setSaveHook(() => { if (armCommitFailure) { armCommitFailure = false; L.store.failCommitOfOpenTransaction(); } });
  armCommitFailure = true; assert.throws(() => L.save(), /FOREIGN KEY constraint failed/);
  assert.equal(withRo(dir, allDump), before, 'the real COMMIT failure: nothing landed'); assert.equal(L.revision(), rev); assert.equal(L.store.sqlite.isTransaction, false);
  L.save(); withRo(dir, (s) => assert.equal(s.prepare("SELECT room_status FROM recruitment_cases WHERE id = 'case-1'").get().room_status, 'shortlisted'));
  const landed = withRo(dir, allDump); L.save(); assert.equal(withRo(dir, allDump), landed, 'landed once');
  // a unit of work: pending edit before, joined writes inside, failure → restored in place
  c1.body = 'edited before the unit (pending)';
  const dumpBefore = withRo(dir, allDump); const draftBefore = kase.decisionDraft;
  assert.throws(() => L.store.unitOfWork(() => {
    room.status = 'archived'; room.archivedAt = NOW; history.push(hist('aud-unit', NOW, 'room_status_changed', { to: 'archived' })); kase.decisionDraft = null;
    R.addComment(comment({ id: 'rcmt-unit', roomId: 'case-1', createdAt: NOW })); R.addCase(legacyCase({ id: 'case-unit' }));
    throw new Error('synthetic unit failure');
  }, { snapshot: L.snapshot }), /synthetic unit failure/);
  assert.equal(withRo(dir, allDump), dumpBefore); assert.equal(L.store.sqlite.isTransaction, false);
  assert.equal(room.status, 'shortlisted', 'the held room facet reads the pre-unit value'); assert.equal(kase.room, room, 'the same object, restored in place'); assert.equal(history.length, 6); assert.equal(kase.history, history); assert.equal(kase.decisionDraft, draftBefore, 'the held draft object is back');
  assert.equal(L.db.roomComments.some((c) => c.id === 'rcmt-unit'), false); assert.equal(L.db.recruitmentCases.some((c) => c.id === 'case-unit'), false); assert.equal(c1.body, 'edited before the unit (pending)', 'the pre-unit pending edit stays');
  assert.throws(() => L.store.unitOfWork(() => { room.status = 'archived'; L.store.failCommitOfOpenTransaction(); }, { snapshot: L.snapshot }));
  assert.equal(room.status, 'shortlisted'); assert.equal(withRo(dir, allDump), dumpBefore);
  L.store.unitOfWork(() => { room.status = 'archived'; R.addComment(comment({ id: 'rcmt-unit', roomId: 'case-1', createdAt: NOW })); }, { snapshot: L.snapshot });
  withRo(dir, (s) => { assert.equal(s.prepare("SELECT room_status FROM recruitment_cases WHERE id = 'case-1'").get().room_status, 'archived'); assert.equal(s.prepare("SELECT body FROM room_comments WHERE id = 'rcmt-1'").get().body, 'edited before the unit (pending)'); assert.ok(s.prepare("SELECT 1 FROM room_comments WHERE id = 'rcmt-unit'").get()); });
  L.close(); rm(dir);
});

// ------------------------------------------------------------- the snapshot write through the real store (the review's §6)
test('[cutover] the corrected snapshot write (readiness review §6, P A R B C D F1 F2 F3 G) through the REAL store: F1a removing a linked trial while clearing its link, F1b rebinding a linked trial to a replacement request (S8a deletes and reinserts it under the link, which is released and reinserted with its positions, duplicate and metadata), F1c removing a linked request with its case; F2 removing a case with its comment, snapshot, decision and evidence state (each room collection and all four); R1 the owner removed with its non-empty history, tags, draft and key rows under the kept case_history RESTRICT key; every landing case in BOTH input orders; cases OMITTED while a retained case\'s trial is deleted and reinserted keep its links, history, tags, draft and keys byte-identical and equal the full save; a resupplied case keeps its history content', () => {
  { const d = file('precheck'); withRo(d, (s) => assert.ok(tableExistsIn(s, 'recruitment_cases'), 'migration 0016 created recruitment_cases')); rm(d); } needRc();
  const landsBoth = (label, over, { omit = [] } = {}) => {
    const dumps = [false, true].map((rev) => { const d = file('both'); const S = snapshotOpen(d); S.save(rev ? reversed(over) : over, { omit }); const out = withRo(d, canon); S.close(); rm(d); return out; });
    assert.equal(dumps[0], dumps[1], `${label}: both input orders persist identical rows`); return dumps[0];
  };
  const fix = S8B_FIX(); const s8a = S8A_FIX();
  // F1a
  const f1a = { recruitmentCases: fix.recruitmentCases.map((c) => (c.id === 'case-1' ? { ...c, links: { requestIds: ['req-p4b'], trialIds: [], signingId: null } } : c)), requests: s8a.requests.map((r) => (r.id === 'req-p4b' ? { ...r, trialId: null } : r)), trials: [] };
  landsBoth('F1a', f1a); { const d = file('f1a'); const S = snapshotOpen(d); S.save(f1a); withRo(d, (s) => { assert.equal(s.prepare('SELECT count(*) AS n FROM trials').get().n, 0); assert.equal(s.prepare("SELECT count(*) AS n FROM case_trial_links WHERE case_id = 'case-1'").get().n, 0); assert.equal(s.prepare("SELECT request_id FROM case_request_links WHERE case_id = 'case-1'").get().request_id, 'req-p4b'); }); S.close(); rm(d); }
  // F1b
  const f1b = { recruitmentCases: fix.recruitmentCases.map((c) => (c.id === 'case-1' ? { ...c, links: { requestIds: ['req-new'], trialIds: c.links.trialIds, signingId: null } } : c)), requests: s8a.requests.map((r) => (r.id === 'req-p4b' ? { ...r, id: 'req-new' } : r)), trials: s8a.trials.map((t) => ({ ...t, requestId: 'req-new' })), channels: [CHANNEL({ requestId: 'req-new' })] };
  landsBoth('F1b', f1b); { const d = file('f1b'); const S = snapshotOpen(d); S.save(f1b); withRo(d, (s) => { assert.deepEqual(s.prepare("SELECT position, trial_id FROM case_trial_links WHERE case_id = 'case-1' ORDER BY position").all().map((x) => [x.position, x.trial_id]), [[0, 'trial-1'], [1, 'trial-1']], 'positions and the duplicate intact'); assert.equal(s.prepare("SELECT request_id FROM trials WHERE id = 'trial-1'").get().request_id, 'req-new'); assert.equal(s.prepare("SELECT trial_id FROM recruitment_requests WHERE id = 'req-new'").get().trial_id, 'trial-1'); assert.equal(s.prepare("SELECT count(*) AS n FROM case_history WHERE case_id = 'case-1'").get().n, 5); }); S.close(); rm(d); }
  // F1c: req-minor and case-2 removed together (trials omitted)
  const f1c = { recruitmentCases: fix.recruitmentCases.filter((c) => c.id !== 'case-2'), requests: s8a.requests.filter((r) => r.id !== 'req-minor') };
  landsBoth('F1c', f1c); { const d = file('f1c'); const S = snapshotOpen(d); S.save(f1c); withRo(d, (s) => { assert.equal(s.prepare("SELECT count(*) AS n FROM recruitment_cases WHERE id = 'case-2'").get().n, 0); assert.equal(s.prepare("SELECT count(*) AS n FROM recruitment_requests WHERE id = 'req-minor'").get().n, 0); assert.equal(s.prepare("SELECT count(*) AS n FROM case_history WHERE case_id = 'case-2'").get().n, 0, 'R1: the removed owner\'s history went with it'); assert.equal(s.prepare('SELECT count(*) AS n FROM case_history').get().n, 7); }); S.close(); rm(d); }
  // F2 / R1: case-1 removed with its room rows, its links cleared on the pair (which moves to NULL case)
  const without1 = (list) => list.filter((r) => r.roomId !== 'case-1');
  const f2 = { recruitmentCases: fix.recruitmentCases.filter((c) => c.id !== 'case-1'), roomComments: without1(fix.roomComments), roomSnapshots: without1(fix.roomSnapshots), roomDecisions: without1(fix.roomDecisions), roomEvidenceState: without1(fix.roomEvidenceState), requests: s8a.requests.map((r) => (r.id === 'req-p4b' ? { ...r, caseId: null } : r)), trials: s8a.trials.map((t) => ({ ...t, caseId: null })) };
  landsBoth('F2 all four', f2); { const d = file('f2'); const S = snapshotOpen(d); const draftKeys = withRo(d, (s) => s.prepare("SELECT count(*) AS n FROM idempotency_keys WHERE owner_table IN ('case_decision_drafts', 'case_transaction_handoffs', 'room_decisions')").get().n); assert.equal(draftKeys, 4, 'rdraft-1 create, hof-1 invite, rdec-2 finalize and draft'); S.save(f2);
    withRo(d, (s) => { assert.equal(s.prepare("SELECT count(*) AS n FROM recruitment_cases WHERE id = 'case-1'").get().n, 0); for (const t of ['case_history', 'case_room_tags', 'case_tasks', 'case_decision_drafts', 'case_transaction_handoffs', 'case_budget_lines', 'room_comments', 'room_snapshots', 'room_decisions', 'room_evidence_states']) assert.equal(s.prepare(`SELECT count(*) AS n FROM ${t} WHERE ${t.startsWith('room_') ? 'room_id' : 'case_id'} = 'case-1'`).get().n, 0, `${t}: the owner's rows gone`); assert.equal(s.prepare("SELECT count(*) AS n FROM idempotency_keys WHERE owner_table IN ('case_decision_drafts', 'case_transaction_handoffs', 'room_decisions')").get().n, 0, 'the polymorphic key rows of the owned draft/handoff and of the removed decisions cleaned'); assert.equal(s.prepare("SELECT count(*) AS n FROM idempotency_keys WHERE owner_table = 'recruitment_requests'").get().n, 2, 'the S8a key rows untouched'); assert.equal(s.prepare("SELECT count(*) AS n FROM case_history WHERE case_id = 'case-2'").get().n, 4, 'the surviving case\'s history untouched'); assert.equal(s.prepare("SELECT case_id FROM trials WHERE id = 'trial-1'").get().case_id, null); }); S.close(); rm(d); }
  // F2 one collection at a time: the other three omitted and retained still name case-1 → refused with their tables (checked in the refusals test); here each collection supplied alone with the case kept
  for (const k of ['roomComments', 'roomSnapshots', 'roomDecisions', 'roomEvidenceState']) { const d = file(`f2-${k}`); const S = snapshotOpen(d); S.save({ [k]: without1(fix[k]) }); withRo(d, (s) => assert.equal(s.prepare(`SELECT count(*) AS n FROM ${{ roomComments: 'room_comments', roomSnapshots: 'room_snapshots', roomDecisions: 'room_decisions', roomEvidenceState: 'room_evidence_states' }[k]} WHERE room_id = 'case-1'`).get().n, 0, `${k}: a supplied collection removes its rows (the case stays)`)); S.close(); rm(d); }
  // partial saves: cases and rooms OMITTED while trial-1 moves to a new request
  const requests = [...s8a.requests.map((r) => (r.id === 'req-p4b' ? { ...r, trialId: null } : r)), acceptedRequest(p4bInvitation({ id: 'req-new' }), 'trial-1')]; const trials = s8a.trials.map((t) => ({ ...t, requestId: 'req-new' }));
  { const d = file('partial'); const S = snapshotOpen(d); const owned1 = withRo(d, (s) => ownedOf(s, 'case-1')); S.save({ requests, trials, channels: [] }); assert.deepEqual(withRo(d, (s) => ownedOf(s, 'case-1')), owned1, 'the retained case\'s links (two positions, the duplicate), history, tags, tasks, draft, handoff, budget and key rows byte-identical after the release and reinsert'); assert.equal(withRo(d, (s) => s.prepare("SELECT request_id FROM trials WHERE id = 'trial-1'").get().request_id), 'req-new'); const partial = withRo(d, canon); S.close(); rm(d);
    const full = landsBoth('partial = full', { ...fix, requests, trials, channels: [] }); assert.equal(partial, full, 'the partial save equals the full save with every collection resent'); }
  // a resupplied case keeps its history content and gains an entry in list order; another case's history untouched
  { const d = file('resupply'); const S = snapshotOpen(d); const h2 = withRo(d, (s) => ownedOf(s, 'case-2').history); S.save({ recruitmentCases: fix.recruitmentCases.map((c) => (c.id === 'case-1' ? { ...c, history: [...c.history, hist('aud-c1-6', NOW, 'room_status_changed', { to: 'shortlisted' })], room: { ...c.room, status: 'shortlisted' } } : c)) }); withRo(d, (s) => { const h = s.prepare("SELECT id FROM case_history WHERE case_id = 'case-1' ORDER BY position").all().map((x) => x.id); assert.deepEqual(h, ['aud-c1-1', 'aud-c1-2', 'aud-c1-3', 'aud-c1-4', 'aud-c1-5', 'aud-c1-6']); assert.equal(ownedOf(s, 'case-2').history, h2); }); S.close(); rm(d); }
});

test('[cutover] the snapshot write refuses atomically — every table, the revision and the keys unchanged, no transaction open, ids only: with the room collections omitted, removing a case the retained comment, snapshot, decision and evidence state still name (every table named, the owned history/tags/draft NOT named — they are the case\'s own); removing a case the retained request and trial name; with the cases omitted, removing a trial a retained case links (never silently detached); a supplied room row naming an unknown case; a case whose link names a request or trial outside the final collections; a decision chain whose predecessor the supplied decisions drop; an owner not in org_users; a malformed collection; an injected failure after the departing owner\'s history and key rows were removed and before its parent restores every row, key and the revision with no open transaction, and the retry lands the intended graph once', () => {
  const d = file('refusals'); withRo(d, (s) => assert.ok(tableExistsIn(s, 'recruitment_cases'), 'migration 0016 created recruitment_cases')); needRc(); const S = snapshotOpen(d); const fix = S8B_FIX(); const s8a = S8A_FIX();
  const stateOf = () => withRo(d, (s) => ({ dump: allDump(s), keys: content(s, 'idempotency_keys'), seq: meta(s, 'saveSeq') }));
  const refusedSave = (label, over, pattern, { omit = [] } = {}) => { const before = stateOf(); const err = refused(() => S.save(over, { omit }), pattern, label); assert.deepEqual(stateOf(), before, `${label}: unchanged`); assert.equal(S.store.sqlite.isTransaction, false); return err; };
  const ROOMS = ['roomComments', 'roomSnapshots', 'roomDecisions', 'roomEvidenceState'];
  const e1 = refusedSave('rooms omitted', { recruitmentCases: fix.recruitmentCases.filter((c) => c.id !== 'case-1'), requests: s8a.requests.map((r) => (r.id === 'req-p4b' ? { ...r, caseId: null } : r)), trials: s8a.trials.map((t) => ({ ...t, caseId: null })) }, /CASE_STILL_REFERENCED/, { omit: ROOMS });
  const e1s = refusedSave('rooms SUPPLIED with the removed case\'s rows', { recruitmentCases: fix.recruitmentCases.filter((c) => c.id !== 'case-1'), requests: s8a.requests.map((r) => (r.id === 'req-p4b' ? { ...r, caseId: null } : r)), trials: s8a.trials.map((t) => ({ ...t, caseId: null })) }, /ROOM_CASE_MISSING.*room_comments rcmt-1 → case-1/); assert.doesNotMatch(e1s.message, /case_history/);
  for (const t of ['room_comments rcmt-1', 'room_snapshots rsnap-1', 'room_decisions rdec-1', 'room_evidence_states rev-1']) assert.match(e1.message, new RegExp(t), `the refusal names ${t}`); assert.doesNotMatch(e1.message, /case_history|case_room_tags|case_decision_drafts|idempotency/, 'the owned rows are not blockers');
  refusedSave('retained request and trial name the case', { recruitmentCases: fix.recruitmentCases.filter((c) => c.id !== 'case-1'), ...Object.fromEntries(['roomComments', 'roomSnapshots', 'roomDecisions', 'roomEvidenceState'].map((k) => [k, fix[k].filter((r) => r.roomId !== 'case-1')])) }, /CASE_STILL_REFERENCED.*(recruitment_requests req-p4b|trials trial-1)/);
  refusedSave('cases omitted, linked trial removed', { trials: [], requests: s8a.requests.map((r) => (r.id === 'req-p4b' ? { ...r, trialId: null } : r)) }, /CASE_LINK_DANGLING.*case-1.*trial-1/, { omit: ['recruitmentCases', ...ROOMS] });
  refusedSave('cases supplied unchanged, linked trial removed', { trials: [], requests: s8a.requests.map((r) => (r.id === 'req-p4b' ? { ...r, trialId: null } : r)) }, /CASE_LINK_DANGLING.*case-1.*trial-1/);
  refusedSave('comment naming an unknown case', { roomComments: [...fix.roomComments, comment({ id: 'rcmt-9', roomId: 'case-9' })] }, /ROOM_CASE_MISSING.*room_comments rcmt-9.*case-9/);
  refusedSave('link naming an unknown request', { recruitmentCases: fix.recruitmentCases.map((c) => (c.id === 'case-2' ? { ...c, links: { requestIds: ['req-ghost'], trialIds: [], signingId: null } } : c)) }, /CASE_LINK_DANGLING.*req-ghost/);
  refusedSave('decision chain broken', { roomDecisions: fix.roomDecisions.filter((x) => x.id !== 'rdec-1') }, /DECISION_CHAIN_BROKEN.*rdec-2.*rdec-1/);
  refusedSave('owner not in org_users', { recruitmentCases: fix.recruitmentCases.map((c) => (c.id === 'case-legacy' ? { ...c, ownerUserId: 'usr-ghost' } : c)) }, /RECRUITMENT_CASES_USER_MISSING.*usr-ghost/);
  refusedSave('malformed collection', { roomSnapshots: { not: 'an array' } }, /array/);
  // the injected failure after the owned children were removed, before the parent (the real store; the parent delete is the statement that fails)
  const removal = { recruitmentCases: fix.recruitmentCases.filter((c) => c.id !== 'case-1'), ...Object.fromEntries(['roomComments', 'roomSnapshots', 'roomDecisions', 'roomEvidenceState'].map((k) => [k, fix[k].filter((r) => r.roomId !== 'case-1')])), requests: s8a.requests.map((r) => (r.id === 'req-p4b' ? { ...r, caseId: null } : r)), trials: s8a.trials.map((t) => ({ ...t, caseId: null })) };
  const before = stateOf(); assert.equal(withRo(d, (s) => s.prepare("SELECT count(*) AS n FROM case_history WHERE case_id = 'case-1'").get().n), 5);
  const probe = failRunAt(S.store.sqlite, (sql) => /DELETE FROM recruitment_cases WHERE id/.test(sql), 1, 'synthetic failure after the owned children');
  assert.throws(() => S.save(removal), /synthetic failure after the owned children/); probe.restore();
  assert.deepEqual(stateOf(), before, 'every row, key and the revision restored'); assert.equal(S.store.sqlite.isTransaction, false); assert.equal(withRo(d, (s) => s.prepare('PRAGMA foreign_key_check').all().length), 0);
  S.save(removal); const after = stateOf(); assert.equal(withRo(d, (s) => s.prepare("SELECT count(*) AS n FROM recruitment_cases WHERE id = 'case-1'").get().n), 0);
  const d2 = file('retry-ref'); const S2 = snapshotOpen(d2); S2.save(removal); assert.equal(withRo(d, canon), withRo(d2, canon), 'the retry lands exactly the intended graph'); S2.close(); rm(d2);
  S.save(removal); assert.equal(stateOf().dump, after.dump, 'a repeated identical write changes nothing further');
  S.close(); rm(d);
});

test('[behaviour] a whole-snapshot save that removes a case a RETAINED room comment still names is refused with the table and the ids (the accepted 7a7efc6 build saved it and silently kept the orphaned comment in its blob)', () => {
  const d = tempDir('s8b-beh'); preS8bFile(d, { channels: [], requests: [], trials: [], recruitmentCases: [legacyCase({ id: 'case-1' })], roomComments: [comment()], roomSnapshots: [], roomDecisions: [], roomEvidenceState: [] });
  { const s = openRaw(d); migrateAll(s); s.close(); }
  const S = snapshotOpen(d); const before = withRo(d, fullDump);
  assert.throws(() => S.save({ recruitmentCases: [] }, { omit: ['roomComments'] }), /CASE_STILL_REFERENCED.*room_comments rcmt-1.*case-1/);
  assert.equal(withRo(d, fullDump), before); S.close(); rm(d);
});

test('[compat] a request naming a case that is not in the FINAL cases is refused when only the cases change (Q7b, the S8a rule, now also the key); the identity replace still reconciles trialReports against the trials', () => {
  const d = tempDir('s8b-compat'); preS8bFile(d); { const s = openRaw(d); migrateAll(s); s.close(); }
  const S = snapshotOpen(d); const before = withRo(d, fullDump);
  assert.throws(() => S.save({ recruitmentCases: S8B_FIX().recruitmentCases.filter((c) => c.id !== 'case-2') }), /case-2/);
  assert.equal(withRo(d, fullDump), before); S.close(); rm(d);
});

// ------------------------------------------------------------- the rollback tool
test('[cutover] the copy-only rollback: the source is never modified (the main file\'s bytes, the WAL, the logical content and the revision); the copy gets the five blobs back in insertion order in the writers\' literals (keys reassembled, every post-cutover edit kept), recruitment_requests and trials rebuilt to the S8a definitions (no case key) row for row, idempotency_keys rebuilt to the S8a CHECK with the S8b owner rows removed, the twenty-five tables dropped, the 0016 record and meta key removed, the revision advanced, every other table untouched; refusals leave no output; the S8a tool refuses the 0016 file (LATER_SCHEMA) and accepts the output; re-upgrading the copy reproduces the tables exactly', () => {
  const d = tempDir('s8b-rb'); preS8bFile(d); { const s = openRaw(d); migrateAll(s); assert.ok(applied(s).includes(MIGRATION), 'migration 0016 applied'); s.close(); }
  const rollback = needRollback(); needRc();
  const L = serverOpen(d); L.repo.addCase(legacyCase({ id: 'case-after', createdAt: NOW })); L.db.recruitmentCases.find((c) => c.id === 'case-1').room.status = 'shortlisted'; L.save();
  const expected = Object.fromEntries(COLLECTIONS.map((n) => [n, plain(L.db[n])])); const expectedR = plain(L.db.requests); const expectedT = plain(L.db.trials); L.close();
  { const s = openRaw(d); s.exec('PRAGMA wal_checkpoint(TRUNCATE)'); s.close(); }
  const sha = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : 'absent');
  const walBytes = () => (fs.existsSync(`${dbFile(d)}-wal`) ? fs.statSync(`${dbFile(d)}-wal`).size : 0);
  const sourceState = () => ({ main: sha(dbFile(d)), walBytes: walBytes(), logical: withRo(d, fullDump), saveSeq: withRo(d, (s) => meta(s, 'saveSeq')) });
  const sourceBefore = sourceState(); assert.equal(sourceBefore.walBytes, 0);
  const s8aRowsBefore = withRo(d, (s) => JSON.stringify(['recruitment_requests', 'trials', 'request_trial_slots', 'trial_history'].map((t) => s.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())));
  const out = tempDir('s8b-rb-out');
  const result = rollback(dbFile(d), out, { now: NOW });
  assert.equal(result.recruitmentCases, 5); assert.equal(result.roomComments, 3);
  assert.deepEqual(sourceState(), sourceBefore, 'the source is untouched');
  withRo(d, (s) => assert.ok(tableExistsIn(s, 'recruitment_cases')));
  const c = new DatabaseSync(dbFile(out), { readOnly: true });
  for (const n of COLLECTIONS) assert.deepEqual(blob(c, n), expected[n], `${n} blob`);
  for (const t of TABLES) assert.equal(tableExistsIn(c, t), false, `${t} dropped`);
  assert.equal(applied(c).includes(MIGRATION), false); assert.ok(applied(c).includes(S8A)); assert.equal(meta(c, 'recruitmentCasesCutover'), undefined);
  for (const t of ['recruitment_requests', 'trials']) assert.equal(fkTargets(c, t).some((f) => f.includes('recruitment_cases')), false, `${t}: no case key`);
  assert.equal(JSON.stringify(['recruitment_requests', 'trials', 'request_trial_slots', 'trial_history'].map((t) => c.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())), s8aRowsBefore, 'the S8a rows byte-identical');
  assert.match(ddlOf(c, 'idempotency_keys'), /owner_table IN \('recruitment_requests', 'trials'\)/); assert.equal(c.prepare("SELECT count(*) AS n FROM idempotency_keys WHERE owner_table NOT IN ('recruitment_requests', 'trials')").get().n, 0); assert.equal(c.prepare("SELECT count(*) AS n FROM idempotency_keys").get().n, 2);
  assert.equal(c.prepare('PRAGMA foreign_key_check').all().length, 0); assert.equal(c.prepare('SELECT count(*) AS n FROM channels').get().n, 1);
  c.close();
  const { rollbackRecruitmentCopy } = s8aRollbackMod;
  const chain = tempDir('s8b-chain'); assert.throws(() => rollbackRecruitmentCopy(dbFile(d), chain, { now: NOW }), (e) => e.code === 'LATER_SCHEMA' && /0016_recruitment_cases/.test(e.message)); assert.equal(fs.readdirSync(chain).length, 0);
  rollbackRecruitmentCopy(dbFile(out), chain, { now: NOW }); assert.ok(fs.existsSync(dbFile(chain)));
  const notCut = tempDir('s8b-notcut'); preS8bFile(notCut); const o2 = tempDir('s8b-o2'); assert.throws(() => rollback(dbFile(notCut), o2, { now: NOW }), (e) => e.code === 'NOT_CUT_OVER'); assert.equal(fs.readdirSync(o2).length, 0);
  fs.writeFileSync(path.join(o2, 'x'), ''); assert.throws(() => rollback(dbFile(d), o2, { now: NOW }), (e) => e.code === 'OUTPUT_NOT_EMPTY');
  const o3 = tempDir('s8b-o3'); assert.throws(() => rollback(dbFile(d), o3, { now: NOW, _failBeforeCommit: true }), /synthetic commit failure/); assert.equal(fs.readdirSync(o3).length, 0); assert.deepEqual(sourceState(), sourceBefore);
  const up = openRaw(out); migrateAll(up); for (const n of COLLECTIONS) assert.deepEqual(rc[{ recruitmentCases: 'readCases', roomComments: 'readRoomComments', roomSnapshots: 'readRoomSnapshots', roomDecisions: 'readRoomDecisions', roomEvidenceState: 'readRoomEvidenceStates' }[n]](up), expected[n], `${n} re-upgraded`);
  assert.equal(JSON.stringify(['recruitment_requests', 'trials', 'request_trial_slots', 'trial_history'].map((t) => up.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())), s8aRowsBefore, 'the S8a rows after the re-upgrade (the case key back) byte-identical to the live file');
  assert.equal(canon(up), withRo(d, canon), 're-upgrading the copy reproduces the live tables exactly');
  up.close(); void expectedR; void expectedT;
  rm(d, out, chain, notCut, o2, o3);
});

// ------------------------------------------------------------- the independent review of b7c0dd0 (F1, F2): regressions written before the correction
// FAILING-FIRST NOTE (recorded on the unchanged b7c0dd0 tree): F1 — the preflight and the final guard checked only that
// a chain target EXISTS, so a decision of case-1 naming a decision of case-2 imported and committed; F2 — the draft and
// handoff key rows were owned by the CHILD id, which the parent-scoped tables admit twice, so a second case with the same
// child id read the first case's keys and a later rewrite of either removed the other's rows.
test('[review b7c0dd0 F1] decision chains are SAME-ROOM: a supersedes / supersededById naming a decision of another room is refused with DECISION_CHAIN_BROKEN and ids only — at the cutover (file unmodified, not recorded, a repeated boot refuses the same way), in a full and a partial snapshot (both input orders), in a staged save (the pending edit kept, the corrected retry landing once), and by the final SQL guard called directly; the fixture\'s same-room chain, a missing target and the duplicate-head policy are unchanged', () => {
  needRc();
  const other = () => recommendation({ id: 'rdec-other', roomId: 'case-2', playerId: 'pl-child1', supersedes: null, supersededById: null });
  const crossed = (rows, key) => { const ds = plain(rows); ds.find((d) => d.id === 'rdec-2')[key] = 'rdec-other'; ds.push(other()); return ds; };
  const idsOnly = (e) => { assert.match(e.message, /DECISION_CHAIN_BROKEN/); assert.match(e.message, /rdec-2/); assert.match(e.message, /rdec-other/); assert.match(e.message, /case-1|case-2/, 'the rooms are named'); assert.doesNotMatch(e.message, /Adult Signup|Strong on the left|Harbour Road/); return e; };
  const recorded = (s) => !!s.prepare('SELECT 1 FROM data_migrations WHERE id = ?').get(MIGRATION);
  for (const key of ['supersedes', 'supersededById']) {
    // the cutover: refused, nothing written, not recorded, the blobs intact, the next boot refuses the same way
    { const d = tempDir('s8b-f1-import'); const f = S8B_FIX(); f.roomDecisions = crossed(f.roomDecisions, key); preS8bFile(d, f); const s = openRaw(d); const before = fullDump(s); const blobs = blob(s, 'roomDecisions');
      const e1 = idsOnly(refused(() => migrateAll(s), /RECRUITMENT_CASES_IMPORT_BLOCKED: DECISION_CHAIN_BROKEN/, `import ${key}`));
      assert.equal(fullDump(s), before, 'nothing written'); assert.equal(recorded(s), false, 'not recorded'); assert.deepEqual(blob(s, 'roomDecisions'), blobs, 'the blob as it was'); assert.equal(s.isTransaction, false);
      const e2 = refused(() => migrateAll(s), /DECISION_CHAIN_BROKEN/, `import ${key} again`); assert.equal(e2.message, e1.message, 'the next boot refuses the same way'); assert.equal(fullDump(s), before); assert.equal(recorded(s), false);
      s.close(); rm(d); }
    // the snapshot write: full (both input orders) and partial (the cases supplied beside the decisions)
    for (const order of ['forward', 'reversed']) { const d = file('f1-snap'); const S = snapshotOpen(d); const before = withRo(d, fullDump); const rev = S.revision();
      const ds = crossed(S.db.roomDecisions, key); const supplied = order === 'reversed' ? [...ds].reverse() : ds;
      idsOnly(refused(() => S.save({ roomDecisions: supplied }), /DECISION_CHAIN_BROKEN/, `snapshot ${key} ${order}`));
      idsOnly(refused(() => S.save({ roomDecisions: supplied, recruitmentCases: plain(S.db.recruitmentCases) }), /DECISION_CHAIN_BROKEN/, `partial ${key} ${order}`));
      assert.equal(withRo(d, fullDump), before, 'nothing written'); assert.equal(S.revision(), rev); assert.equal(S.store.sqlite.isTransaction, false);
      S.close(); rm(d); }
    // the staged save: refused, the pending edits kept for the caller to correct, the corrected retry lands once
    { const d = file('f1-staged'); const L = serverOpen(d); const before = withRo(d, fullDump); const rev = L.revision(); const col = key === 'supersedes' ? 'supersedes_id' : 'superseded_by_id';
      L.repo.addDecision(other()); const target = L.db.roomDecisions.find((r) => r.id === 'rdec-2'); const original = target[key]; target[key] = 'rdec-other';
      idsOnly(refused(() => L.save(), /DECISION_CHAIN_BROKEN/, `staged ${key}`)); assert.equal(withRo(d, fullDump), before, 'nothing written'); assert.equal(L.revision(), rev); assert.equal(L.store.sqlite.isTransaction, false);
      assert.equal(target[key], 'rdec-other', 'memory keeps the refused state for the caller to correct'); assert.ok(L.db.roomDecisions.some((r) => r.id === 'rdec-other'), 'the pending addition stays pending');
      target[key] = original; L.save(); withRo(d, (s) => { assert.ok(s.prepare("SELECT 1 FROM room_decisions WHERE id = 'rdec-other' AND room_id = 'case-2'").get(), 'the corrected retry lands the other room\'s decision'); assert.notEqual(s.prepare('SELECT * FROM room_decisions WHERE id = ?').get('rdec-2')[col], 'rdec-other'); });
      const landed = withRo(d, allDump); L.save(); assert.equal(withRo(d, allDump), landed, 'landed once');
      L.close(); rm(d); }
    // the final SQL guard on its own: a preflight correction must not hide a deficient final check
    { const d = file('f1-guard'); const s = openRaw(d); s.exec('BEGIN'); rc.writeRecord(s, rc.DECISIONS, other()); const col = key === 'supersedes' ? 'supersedes_id' : 'superseded_by_id';
      rc.assertCasesConsistent(s, { label: 'the guard control' }); // the fixture's same-room chain and the other room's head pass
      s.prepare(`UPDATE room_decisions SET ${col} = ? WHERE id = ?`).run('rdec-other', 'rdec-2'); idsOnly(refused(() => rc.assertCasesConsistent(s, { label: 'the guard' }), /DECISION_CHAIN_BROKEN/, `guard ${key}`));
      s.prepare(`UPDATE room_decisions SET ${col} = ? WHERE id = ?`).run('rdec-missing', 'rdec-2'); refused(() => rc.assertCasesConsistent(s), /DECISION_CHAIN_BROKEN[^\n]*rdec-missing/, 'guard missing target');
      s.exec('ROLLBACK'); s.close(); rm(d); }
  }
  // controls: the fixture's same-room chain lands; a missing target is refused; two heads in one room stay a condition judged on read, not a refusal
  { const d = file('f1-controls'); const S = snapshotOpen(d); S.save({ roomDecisions: plain(S.db.roomDecisions) }); const before = withRo(d, fullDump);
    const missing = plain(S.db.roomDecisions); missing.find((x) => x.id === 'rdec-2').supersedes = 'rdec-missing'; refused(() => S.save({ roomDecisions: missing }), /DECISION_CHAIN_BROKEN[^\n]*rdec-missing/, 'missing'); assert.equal(withRo(d, fullDump), before);
    const heads = plain(S.db.roomDecisions); heads.push(formalDecision({ id: 'rdec-head-b', supersedes: null, supersededById: null, clientKey: 'fin-b', keys: {} })); S.save({ roomDecisions: heads });
    withRo(d, (s) => assert.equal(s.prepare("SELECT count(*) AS n FROM room_decisions WHERE room_id = 'case-1' AND superseded_by_id IS NULL").get().n, 2, 'two heads stored; the duplicate-head policy (judged on read) is unchanged'));
    S.close(); rm(d); }
});

test('[review b7c0dd0 F2] owned-child replay keys are owned by the CASE: two cases whose decisionDraft (or transactionHandoff) carry the SAME child id each keep exactly their own keys — at the cutover (both input orders; empty, absent, null, held-only and row-worthy keys on the colliding child), in the snapshot and the staged write (a later edit introducing and removing the collision; two populated maps pending in one transaction; an unrelated rewrite of either owner; an unchanged save; a restart; a statement failure and a real COMMIT failure with the retry landing once; the backup export and a restore; the copy-only rollback and the re-upgrade), and when one owner departs; the key rows are stored under the owning case id, never under the child id', () => {
  needRc(); const rollback = needRollback();
  const variants = { empty: { keys: {} }, absent: {}, null: { keys: null }, held: { keys: { create: { key: null, fp: 'held-fp' } } }, rows: { keys: { create: { key: 'k-second', fp: 'f-second' }, extra: [{ key: 'l1', fp: 'lf1' }] } } };
  const table = { decisionDraft: 'case_decision_drafts', transactionHandoff: 'case_transaction_handoffs' };
  const keyRows = (s, t) => s.prepare('SELECT owner_id, act, key FROM idempotency_keys WHERE owner_table = ? ORDER BY owner_id, position').all(t).map((r) => [r.owner_id, r.act, r.key]);
  const keysOf = (records, caseId, child) => records.find((c) => c.id === caseId)[child].keys;
  for (const child of ['decisionDraft', 'transactionHandoff']) {
    const t = table[child];
    for (const [name, v] of Object.entries(variants)) for (const reverse of [false, true]) {
      const d = tempDir('s8b-f2-import'); const f = S8B_FIX(); f.recruitmentCases[1][child] = { id: f.recruitmentCases[0][child].id, ...v }; if (reverse) f.recruitmentCases.reverse();
      preS8bFile(d, f); const s = openRaw(d); const expected = blob(s, 'recruitmentCases');
      migrateAll(s); assert.deepEqual(rc.readCases(s), expected, `${child} ${name} ${reverse ? 'reversed' : 'forward'}: both owners read back exactly`);
      const rows = keyRows(s, t); assert.ok(rows.length && rows.every((r) => r[0] === 'case-1' || r[0] === 'case-2'), `${child} ${name}: the key rows are owned by the case id (${JSON.stringify(rows)})`); assert.ok(rows.some((r) => r[0] === 'case-1'), 'case-1\'s own key row');
      if (name === 'rows') assert.deepEqual(rows.filter((r) => r[0] === 'case-2').map((r) => r[2]), ['k-second', 'l1'], 'case-2\'s own rows'); else assert.equal(rows.some((r) => r[0] === 'case-2'), false, `${name}: no row for case-2`);
      s.close(); rm(d);
    }
    for (const mode of ['snapshot', 'staged']) {
      const d = file(`f2-${mode}`); const L = mode === 'snapshot' ? snapshotOpen(d) : serverOpen(d);
      const expected = plain(L.db.recruitmentCases); const one = expected.find((c) => c.id === 'case-1');
      const save = (mutate) => { if (mode === 'staged') { mutate(L.db.recruitmentCases); L.save(); } else { mutate(expected); L.save({ recruitmentCases: expected }); } };
      const read = () => rc.readCases(L.store.sqlite); const firstKeys = plain(one[child].keys);
      // the collision introduced by a later edit
      save((cs) => { cs.find((c) => c.id === 'case-2')[child] = { id: one[child].id, keys: {} }; });
      assert.deepEqual(keysOf(read(), 'case-1', child), firstKeys, `${mode} ${child}: case-1 keeps its keys`); assert.deepEqual(keysOf(read(), 'case-2', child), {}, 'case-2 has its own (empty) keys');
      // two populated maps, both pending in one transaction
      save((cs) => { cs.find((c) => c.id === 'case-2')[child].keys = { create: { key: 'k-two', fp: 'f-two' } }; const k1 = cs.find((c) => c.id === 'case-1')[child]; k1.keys = { ...plain(k1.keys), again: { key: 'k-one-b', fp: 'f-one-b' } }; });
      assert.deepEqual(keysOf(read(), 'case-2', child), { create: { key: 'k-two', fp: 'f-two' } }); assert.deepEqual(keysOf(read(), 'case-1', child), { ...firstKeys, again: { key: 'k-one-b', fp: 'f-one-b' } });
      const oneKeys = plain(keysOf(read(), 'case-1', child));
      // an unrelated rewrite of case-2, then of case-1
      save((cs) => { cs.find((c) => c.id === 'case-2').priority = 'high'; }); assert.deepEqual(keysOf(read(), 'case-1', child), oneKeys, 'rewriting case-2 leaves case-1\'s keys');
      save((cs) => { cs.find((c) => c.id === 'case-1').priority = 'high'; }); assert.deepEqual(keysOf(read(), 'case-2', child), { create: { key: 'k-two', fp: 'f-two' } }, 'rewriting case-1 leaves case-2\'s keys');
      // an unchanged save writes nothing; a restart reads the same
      const landed = withRo(d, canon); save(() => {}); assert.equal(withRo(d, canon), landed, 'an unchanged save writes nothing');
      { const again = mode === 'snapshot' ? snapshotOpen(d) : serverOpen(d); assert.deepEqual(plain(again.db.recruitmentCases.map((c) => [c.id, c[child]?.keys ?? null])), plain(read().map((c) => [c.id, c[child]?.keys ?? null])), 'a restart reads the same keys'); again.close(); }
      // the collision removed again, then back
      save((cs) => { cs.find((c) => c.id === 'case-2')[child].id = 'child-two-distinct'; }); assert.deepEqual(keysOf(read(), 'case-1', child), oneKeys); assert.deepEqual(keysOf(read(), 'case-2', child), { create: { key: 'k-two', fp: 'f-two' } });
      save((cs) => { cs.find((c) => c.id === 'case-2')[child].id = one[child].id; }); assert.deepEqual(keysOf(read(), 'case-1', child), oneKeys);
      if (mode === 'staged') {
        // a statement failure and a real COMMIT failure while both owners are pending; the retry lands once
        const before = withRo(d, allDump); const rev = L.revision();
        L.db.recruitmentCases.find((c) => c.id === 'case-2')[child].keys = { create: { key: 'k-two-b', fp: 'f-two-b' } }; L.db.recruitmentCases.find((c) => c.id === 'case-1')[child].keys = { ...oneKeys, third: { key: 'k-one-c', fp: 'f-one-c' } };
        const probe = failRunAt(L.store.sqlite, (sql) => /INTO idempotency_keys/.test(sql), 2, 'synthetic key statement failure'); assert.throws(() => L.save(), /synthetic key statement failure/); probe.restore();
        assert.equal(withRo(d, allDump), before, 'the statement failure: nothing landed'); assert.equal(L.revision(), rev); assert.equal(L.store.sqlite.isTransaction, false);
        let arm = true; L.store.setSaveHook(() => { if (arm) { arm = false; L.store.failCommitOfOpenTransaction(); } }); assert.throws(() => L.save(), /FOREIGN KEY constraint failed/); assert.equal(withRo(d, allDump), before, 'the COMMIT failure: nothing landed'); assert.equal(L.store.sqlite.isTransaction, false);
        L.save(); assert.deepEqual(keysOf(read(), 'case-2', child), { create: { key: 'k-two-b', fp: 'f-two-b' } }); assert.deepEqual(keysOf(read(), 'case-1', child), { ...oneKeys, third: { key: 'k-one-c', fp: 'f-one-c' } }); const l2 = withRo(d, allDump); L.save(); assert.equal(withRo(d, allDump), l2, 'landed once');
        // the backup export and a restore into a fresh file
        const exported = L.repo.exportAll(); assert.deepEqual(exported.recruitmentCases, read(), 'the export equals the rows');
        const r = tempDir('s8b-f2-restore'); preS8bFile(r, { ...exported }); const rs = openRaw(r); migrateAll(rs); assert.deepEqual(rc.readCases(rs), exported.recruitmentCases, 'the restore reads the same cases and keys'); rs.close(); rm(r);
      }
      L.close();
      // the copy-only rollback and the re-upgrade keep each owner's keys
      { const live = withRo(d, (s) => rc.readCases(s)); const out = tempDir('s8b-f2-rb'); rollback(dbFile(d), out, { now: NOW }); const c = openRaw(out); const back = blob(c, 'recruitmentCases');
        assert.deepEqual(back.map((x) => [x.id, x[child]?.keys ?? null]), live.map((x) => [x.id, x[child]?.keys ?? null]), 'the rollback copy carries each case\'s own keys'); migrateAll(c); assert.deepEqual(rc.readCases(c), live, 're-upgraded: identical'); c.close(); rm(out); }
      rm(d);
    }
    // one owner departs: the other's keys stay (a third case, named by nothing, sharing case-1's child id)
    { const d = file('f2-depart'); const S = snapshotOpen(d); const cases = plain(S.db.recruitmentCases); const extra = legacyCase({ id: 'case-3' }); extra[child] = { ...plain(cases.find((c) => c.id === 'case-1')[child]), keys: { create: { key: 'k-three', fp: 'f-three' } } }; cases.push(extra);
      S.save({ recruitmentCases: cases }); const one = plain(keysOf(rc.readCases(S.store.sqlite), 'case-1', child)); assert.deepEqual(keysOf(rc.readCases(S.store.sqlite), 'case-3', child), { create: { key: 'k-three', fp: 'f-three' } });
      S.save({ recruitmentCases: cases.filter((c) => c.id !== 'case-3') }); assert.deepEqual(keysOf(rc.readCases(S.store.sqlite), 'case-1', child), one, 'case-3 gone, case-1\'s keys intact'); assert.equal(S.store.sqlite.prepare("SELECT count(*) AS n FROM idempotency_keys WHERE owner_id = 'case-3'").get().n, 0, 'no orphan row');
      S.close(); rm(d); }
  }
});
// ------------------------------------------------------------- the independent review of 2fe05df (R1): the persisted key format, written before the correction
// FAILING-FIRST NOTE (recorded on the unchanged 2fe05df tree): that build recorded no format marker, read the draft and
// handoff key rows as case-owned on ANY 0016 file, and so returned empty or exchanged keys from a file the superseded
// b7c0dd0 build had written (child-owned rows) — on attachment, on the snapshot load and in the rollback copy — instead
// of refusing before any data was decoded.
test('[review 2fe05df R1] the persisted key format is a recorded discriminator checked before anything is decoded, published, written, exported or rolled back: migration 0016 records meta.recruitmentCasesKeyFormat atomically with its rows (a failed step leaves none, the retry records it); a 0016 file WITHOUT the marker — the layouts of the superseded b7c0dd0 and 2fe05df builds: ordinary, overlapping case/child ids, no row-worthy keys — or with an unknown, empty or malformed marker is refused by the staged load, the snapshot load, the readers, the snapshot write, the final guard and the copy-only rollback (RECRUITMENT_CASES_FORMAT_UNSUPPORTED naming the recorded and the expected format and the version-matched recovery route; the source unchanged; no usable rollback output); the same file reads again once its own marker is back; the rollback copy carries no marker and the re-upgrade, a backup restore and a fresh cutover record it', () => {
  needRc(); const rollback = needRollback();
  const META = rc.RECRUITMENT_CASES_FORMAT_META ?? 'recruitmentCasesKeyFormat'; const FORMAT = rc.RECRUITMENT_CASES_KEY_FORMAT ?? null;
  const marker = (s) => s.prepare('SELECT value FROM meta WHERE key = ?').get(META)?.value ?? null;
  const setMarker = (d, value) => { const s = openRaw(d); if (value === null) s.prepare('DELETE FROM meta WHERE key = ?').run(META); else s.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(META, value); s.close(); };
  // the b7c0dd0 layout with overlapping case/child ids: every key row names an existing case that has that child, yet belongs to the other case — a layout no ownership query can tell apart
  const swapOwners = (d) => { const s = openRaw(d); for (const t of ['case_decision_drafts', 'case_transaction_handoffs']) for (const [from, to] of [['case-1', 'swap-tmp'], ['case-2', 'case-1'], ['swap-tmp', 'case-2']]) s.prepare('UPDATE idempotency_keys SET owner_id = ? WHERE owner_table = ? AND owner_id = ?').run(to, t, from); s.close(); };
  const expectRefusal = (d, label) => {
    const before = withRo(d, fullDump);
    const e1 = refused(() => serverOpen(d), /RECRUITMENT_CASES_FORMAT_UNSUPPORTED/, `${label}: the staged load (attachment)`);
    assert.match(e1.message, /recorded/, `${label}: names the recorded format`); assert.match(e1.message, /expected|this build reads/, `${label}: names the expected format`); assert.match(e1.message, /rollback|roll it back/i, `${label}: names the recovery route`); assert.doesNotMatch(e1.message, /Adult Signup|Strong on the left|Harbour Road/);
    refused(() => snapshotOpen(d), /RECRUITMENT_CASES_FORMAT_UNSUPPORTED/, `${label}: the snapshot load`);
    refused(() => withRo(d, (s) => rc.RECRUITMENT_CASES_SNAPSHOT.read(s)), /RECRUITMENT_CASES_FORMAT_UNSUPPORTED/, `${label}: the snapshot reader`);
    refused(() => withRo(d, (s) => rc.readCases(s)), /RECRUITMENT_CASES_FORMAT_UNSUPPORTED/, `${label}: the case reader`);
    { const s = openRaw(d); s.exec('BEGIN'); refused(() => rc.RECRUITMENT_CASES_SNAPSHOT.begin(s, { recruitmentCases: [] }), /RECRUITMENT_CASES_FORMAT_UNSUPPORTED/, `${label}: the snapshot write`); refused(() => rc.assertCasesConsistent(s), /RECRUITMENT_CASES_FORMAT_UNSUPPORTED/, `${label}: the final guard`); s.exec('ROLLBACK'); s.close(); }
    const out = tempDir('s8b-fmt-rb'); let err = null; try { rollback(dbFile(d), out, { now: NOW }); } catch (e) { err = e; }
    assert.ok(err && err.code === 'FORMAT_UNSUPPORTED' && /RECRUITMENT_CASES_FORMAT_UNSUPPORTED/.test(err.message), `${label}: the rollback refuses with FORMAT_UNSUPPORTED before reading a row (${err?.code}: ${err?.message})`); assert.equal(fs.readdirSync(out).length, 0, `${label}: no usable rollback output`); rm(out);
    assert.equal(withRo(d, fullDump), before, `${label}: the source is unchanged`);
  };
  // 1. the fresh cutover records the marker atomically with its rows; a failed step leaves none; the retry records it
  const dA = tempDir('s8b-fmt-a'); preS8bFile(dA);
  { const s = openRaw(dA);
    const probe = failRunAt(s, (sql) => /INSERT INTO meta/.test(sql), 1, 'synthetic marker failure'); assert.throws(() => migrateAll(s), /synthetic marker failure/); probe.restore();
    assert.equal(marker(s), null, 'a failed cutover records no marker'); assert.equal(tableExistsIn(s, 'recruitment_cases'), false, 'nor tables'); assert.equal(s.prepare('SELECT 1 FROM data_migrations WHERE id = ?').get(MIGRATION) ?? null, null, 'nor the record'); assert.equal(s.isTransaction, false);
    migrateAll(s); assert.ok(typeof marker(s) === 'string' && marker(s).length > 0, 'the cutover records a format marker'); if (FORMAT) assert.equal(marker(s), FORMAT, 'the marker is the format this build reads'); s.close(); }
  const recorded = withRo(dA, marker); const expectedA = withRo(dA, (s) => rc.readCases(s));
  { const L = serverOpen(dA); assert.deepEqual(plain(L.db.recruitmentCases), expectedA); L.close(); }
  // 2. the ordinary file without its marker (the 2fe05df layout); its own marker back, it reads exactly as before
  setMarker(dA, null); expectRefusal(dA, 'the unmarked ordinary file (the 2fe05df layout)');
  setMarker(dA, recorded); { const L = serverOpen(dA); assert.deepEqual(plain(L.db.recruitmentCases), expectedA, 'with its own marker back the file reads exactly as before'); L.close(); }
  // 3. unknown, empty and malformed markers
  for (const [what, v] of [['an unknown marker', 'garbage'], ['an empty marker', ''], ['a malformed marker', JSON.stringify({ v: 1 })]]) { setMarker(dA, v); expectRefusal(dA, what); }
  rm(dA);
  // 4. the b7c0dd0 layout with overlapping case/child ids, unmarked: refused the same way (the marker decides, not the rows)
  { const dB = tempDir('s8b-fmt-b'); const f = S8B_FIX(); for (const child of ['decisionDraft', 'transactionHandoff']) { f.recruitmentCases[0][child] = { ...f.recruitmentCases[0][child], id: 'case-2', keys: { create: { key: 'key-first', fp: 'fp-first' } } }; f.recruitmentCases[1][child] = { id: 'case-1', keys: { create: { key: 'key-second', fp: 'fp-second' } } }; }
    preS8bFile(dB, f); { const s = openRaw(dB); migrateAll(s); s.close(); } swapOwners(dB); setMarker(dB, null); expectRefusal(dB, 'the unmarked file with overlapping case/child ids (the b7c0dd0 layout)'); rm(dB); }
  // 5. a file with no row-worthy key at all, unmarked: refused too (the refusal does not depend on the rows)
  { const dC = tempDir('s8b-fmt-c'); const f = S8B_FIX(); f.recruitmentCases[0].decisionDraft.keys = {}; f.recruitmentCases[0].transactionHandoff.keys = {}; preS8bFile(dC, f); { const s = openRaw(dC); migrateAll(s); s.close(); } setMarker(dC, null); expectRefusal(dC, 'the unmarked file without row-worthy keys'); rm(dC); }
  // 6. the rollback copy carries no marker (a pre-S8b file); the re-upgrade and a backup restore record it again
  { const d = file('fmt-rb'); const out = tempDir('s8b-fmt-out'); rollback(dbFile(d), out, { now: NOW }); const c = openRaw(out); assert.equal(marker(c), null, 'the rollback copy carries no marker'); migrateAll(c); assert.equal(marker(c), recorded, 're-upgraded: recorded again'); c.close();
    const L = serverOpen(d); const exported = L.repo.exportAll(); L.close(); const r = tempDir('s8b-fmt-restore'); preS8bFile(r, { ...exported }); const rs = openRaw(r); migrateAll(rs); assert.equal(marker(rs), recorded, 'a restore records it'); rs.close(); rm(d, out, r); }
});
console.log(`\n${passed} recruitment cases checks passed`);
