// S8a-core — requests and trials as tables (repositories/recruitment.mjs, migration 0015,
// repositories/recruitmentRollback.mjs): the bounded storage migration the Founder
// approved through Q7a (tolerant player references: live, retained and historically
// missing ids resolve, are counted and never refused or fabricated), Q7b (the two case
// references checked STRICTLY in code against the retained `recruitmentCases` collection
// until S8b) and Q7c (the guardian references checked STRICTLY in code, no SET NULL key).
// The lossless mapping (every writer shape of plan §D.7.3: presence, absence, null,
// unknown fields, off-type values, blockedBy, keys.accept, the tombstone's
// trialDetails.instructions, the day container, recipient.playerId); the cutover
// (migration 0015: sixteen tables, the channels rebuild with the real request key, the
// counts, every refusal with ids only); the repository (in-place mutation landing in the
// next save with the children rewritten, an unchanged save writing nothing, a failed
// ordinary save keeping its pending state, an aborted unit restoring the pre-unit graph
// in place, held nested views); the six-phase snapshot write (plan §D.7.5: new graphs
// in both orders, replacement, request swap, case change/swap with requests omitted equal
// to the full save, completion/cancellation/re-entry, two open trials refused, strict
// case and guardian refusals — identity-only changes included — pair mismatches, the
// channel key, intentional prunes, exact rollback); the copy-only rollback tool.
// Temporary databases only; nothing touches DATA_DIR. Run with: npm test
//
// FAILING-FIRST NOTE (recorded on the unchanged d0f0205 tree, source-identical to the
// accepted 9b109dc, before the implementation): the tests marked [cutover] need the 0015
// migration, the repository module and the rollback module and FAIL there on concrete
// assertions (the migration id is absent from DATA_MIGRATIONS; the tables do not exist;
// the blobs survive; the modules do not export the repository). The tests marked
// [compat] exercise behaviour the accepted build already has and pass on both trees.
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
import { legacyTrialRequest, contactRequest, openDayRequest, p4bInvitation, minorInvitation, acceptedRequest, scheduledTrial, acceptedTrial, preP4bTrial, workedTrial, cancelledTrial, report, session, CASES, persisted, T } from './recruitmentTestFixtures.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const dbFile = (dir) => path.join(dir, 'scoutbox.db');
let counter = 9000; const nextId = (p) => `${p}-${++counter}`;
const MIGRATION = '0015_recruitment';
let rec = null; let rollbackMod = null;
try { rec = await import('../repositories/recruitment.mjs'); } catch { rec = null; }
try { rollbackMod = await import('../repositories/recruitmentRollback.mjs'); } catch { rollbackMod = null; }
const { rollbackRecruitmentCasesCopy } = await import('../repositories/recruitmentCasesRollback.mjs'); // S8b: a live file carries 0016; the S8a tool works on the S8b tool's output (the chain)
const { rollbackRecruitmentContactsOffersCopy } = await import('../repositories/recruitmentContactsOffersRollback.mjs'); // S8c: a live file carries 0017; its tool goes first, the S8b tool works on its output
const playerErasureRollbackMod = await import('../repositories/playerErasureRollback.mjs'); // the S4b-R tool: the rollback chain's previous link
const needRec = () => { assert.ok(rec?.createRecruitmentRepository, 'repositories/recruitment.mjs exports createRecruitmentRepository (the S8a-core repository module)'); return rec; };
const needRollback = () => { assert.ok(rollbackMod?.rollbackRecruitmentCopy, 'repositories/recruitmentRollback.mjs exports rollbackRecruitmentCopy (the S8a-core rollback module)'); return rollbackMod.rollbackRecruitmentCopy; };
const TABLES = ['recruitment_requests', 'request_trial_slots', 'trials', 'trial_schedule_sessions', 'trial_session_evidence', 'trial_schedule_revisions', 'trial_attendance', 'trial_reminders', 'trial_day_staff', 'trial_day_consents', 'trial_day_checkins', 'trial_day_status_events', 'trial_reports', 'trial_history', 'idempotency_keys'];
const second = (dir) => new DatabaseSync(dbFile(dir), { readOnly: true });
const withRo = (dir, fn) => { const s = second(dir); try { return fn(s); } finally { s.close(); } };
const tableExistsIn = (s, t) => !!s.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
const plain = (v) => JSON.parse(JSON.stringify(v));
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
/** The recruitment tables + channels, as an exact canonical dump (rowid order inside each table). */
/** Every table of the file as a logical dump (the stable source snapshot the rollback test compares across the copy). */
const fullDump = (s) => JSON.stringify(s.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => [r.name, s.prepare(`SELECT * FROM "${r.name}"`).all().map((x) => ({ ...x }))]));
const recDump = (s) => JSON.stringify(Object.fromEntries([...TABLES, 'channels', 'messages'].filter((t) => tableExistsIn(s, t)).map((t) => [t, s.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().map((r) => ({ ...r }))])));
const fkTargets = (s, table) => s.prepare(`PRAGMA foreign_key_list(${table})`).all().map((r) => `${r.from}->${r.table}(${r.to}) ${r.on_delete}`);
const CHANNEL = (over = {}) => ({ id: 'chan-1', requestId: 'req-p4b', playerId: 'pl-adult', playerName: 'Adult Signup', orgId: 'org-pro', orgName: 'Eastport FC', orgVerified: true, scoutName: 'Maria', scoutRole: 'Head of Recruitment', counterparty: 'player', guardianId: null, createdAt: T.accepted, messages: [{ id: 'msg-1', ts: T.accepted + 1, sender: { kind: 'org_user', id: 'usr-1', name: 'Maria' }, text: 'Welcome.', attachment: null }], readBy: { org: null, counterparty: null }, ...over });

/** A file at S4b-R (0001–0014 applied) carrying the recruitment blobs the d0f0205 build wrote, with the cases blob the strict references resolve against and a thread on req-p4b. The fixture players (pl-adult, pl-child1, pl-child2, …) carry the trialReports the trials derive (S5's invariant, which migration 0007 checks). */
function preS8aFile(dir, { requests, trials, cases = CASES(), channels = [CHANNEL()], rawBlobs, more = {} } = {}) {
  const extra = { ledger: [], vouches: [], notifications: [], dispatches: [], recruitmentCases: cases, ...more };
  if (requests !== undefined) extra.requests = requests; if (trials !== undefined) extra.trials = trials; if (channels !== undefined) extra.channels = channels;
  const players = FIXTURE().players.map((p) => ({ ...p, trialReports: trialReportsFor(Array.isArray(trials) ? plain(trials) : [], p.id) }));
  s3File(dir, { players, extra, rawBlobs });
  const s = openRaw(dir); runDataMigrations(s, DATA_MIGRATIONS.filter((m) => m.id < MIGRATION), { now: NOW, context: { sessionTtlMs: TTL } }); s.close();
}
const migrateAll = (s, { now = NOW } = {}) => runDataMigrations(s, DATA_MIGRATIONS, { now, context: { sessionTtlMs: TTL } });
const STD = () => ({ requests: [p4bInvitation(), acceptedRequest(p4bInvitation(), 'trial-1'), contactRequest(), openDayRequest(), legacyTrialRequest()].filter((r, i, a) => a.findIndex((x) => x.id === r.id) === i), trials: [scheduledTrial()] });
/** The standard fixture: the accepted P4B pair (req-p4b ↔ trial-1, thread chan-1), a contact, an open-day invitation, a legacy date-only invitation still pending, the minor's invitation, a pre-P4B reported trial on req-old. */
const FIX = () => ({ requests: [acceptedRequest(p4bInvitation(), 'trial-1'), contactRequest(), openDayRequest(), legacyTrialRequest(), minorInvitation(), legacyTrialRequest({ id: 'req-old', status: 'accepted', respondedAt: T.accepted - 30 * 86_400_000, respondedBy: 'player', contactChannel: null })], trials: [scheduledTrial(), preP4bTrial()] });
void STD;

/** The server-mode harness over a prepared file: the real store + data layer, saves through store.save, reads through a second connection. */
function serverOpen(dir, { warnings = [], cases } = {}) {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const loaded = store.load();
  const db = { ...loaded.db, players: [], guardians: [] };
  void cases; // S8b: the cases are a table-backed collection now — the file's recruitmentCases blob (the fixture's CASES()) was imported by 0016 and is served by the repository's view; nothing is assigned on db
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW, warn: (m) => warnings.push(m) });
  const snapshot = () => ({ savedAt: NOW, idCounter: 1000, db });
  return { store, layer, db, warnings, snapshot, save: () => store.save(snapshot()), revision: () => store.revision(), repo: layer.recruitment, close: () => store.sqlite.close() };
}
/** The snapshot-mode harness (backups, restores, persistence tools): whole snapshots through writeTableBacked. */
function snapshotOpen(dir) {
  const store = openStore(dir);
  const loaded = store.load();
  const db = loaded.db;
  const save = (over = {}, { omit = [] } = {}) => { const d = { ...db, ...over }; for (const k of omit) delete d[k]; return store.save({ savedAt: NOW, idCounter: 1000, db: d }); };
  return { store, db, save, revision: () => store.revision(), close: () => store.sqlite.close() };
}

// ------------------------------------------------------------- the migration
test('[cutover] migration 0015 is registered last and, on an S4b-R file, creates the fifteen recruitment tables and rebuilds channels with the real request key (RESTRICT) while every thread, message and attachment survives byte for byte; imports both blobs row for row and retires them; records counts only; the pre-P4B trial whose request has no trialId key is counted as a legacy pair; reruns are no-ops; a file without the blobs creates the tables and imports nothing — never from the seed or memory', () => {
  assert.deepEqual(DATA_MIGRATIONS.map((m) => m.id).slice(-3), [MIGRATION, '0016_recruitment_cases', '0017_recruitment_contacts_offers'], '0015_recruitment is registered after 0014; 0016_recruitment_cases (S8b) and 0017_recruitment_contacts_offers (S8c) follow it and run on the same boot');
  assert.ok(TABLE_BACKED.includes('requests') && TABLE_BACKED.includes('trials'), 'requests and trials are table-backed collections');
  const dir = tempDir('s8a-mig'); preS8aFile(dir, FIX());
  const s = openRaw(dir);
  const channelsBefore = JSON.stringify([s.prepare('SELECT * FROM channels ORDER BY seq').all(), s.prepare('SELECT * FROM messages ORDER BY seq').all(), s.prepare('SELECT * FROM message_attachments ORDER BY message_id').all()]);
  const requestsBlob = blob(s, 'requests'); const trialsBlob = blob(s, 'trials');
  const ran = migrateAll(s);
  assert.deepEqual(ran.ran, [MIGRATION, '0016_recruitment_cases', '0017_recruitment_contacts_offers'], '0016 (S8b) and 0017 (S8c) run on the same boot');
  for (const t of TABLES) assert.ok(tableExistsIn(s, t), `${t} exists`);
  assert.ok(fkTargets(s, 'channels').some((f) => f.startsWith('request_id->recruitment_requests(id) RESTRICT')), `channels.request_id is a real key: ${fkTargets(s, 'channels')}`);
  assert.equal(JSON.stringify([s.prepare('SELECT * FROM channels ORDER BY seq').all(), s.prepare('SELECT * FROM messages ORDER BY seq').all(), s.prepare('SELECT * FROM message_attachments ORDER BY message_id').all()]), channelsBefore, 'the threads survive the rebuild byte for byte');
  assert.equal(blob(s, 'requests'), undefined); assert.equal(blob(s, 'trials'), undefined);
  const { readRequests, readTrials } = needRec();
  assert.deepEqual(readRequests(s), requestsBlob, 'the requests come back exactly (presence, absence, null, nested containers, keys)');
  assert.deepEqual(readTrials(s), trialsBlob, 'the trials come back exactly');
  const record = JSON.parse(meta(s, 'recruitmentCutover'));
  assert.equal(record.requests.imported, 6); assert.equal(record.trials.imported, 2); assert.equal(record.trials.legacyPairs, 1, 'trial-old names req-old, which carries no trialId key: a legacy pair, counted');
  assert.deepEqual(record.players, { live: 8, retained: 0, missing: 0 }, 'six requests and two trials name the live fixture players pl-adult and pl-child1 (Q7a: counted)');
  assert.equal(JSON.stringify(record).includes('Adult Signup'), false, 'counts only');
  assert.deepEqual(migrateAll(s).ran, []);
  s.close();
  const fresh = tempDir('s8a-fresh'); preS8aFile(fresh, { requests: undefined, trials: undefined, channels: [] });
  const f = openRaw(fresh); migrateAll(f);
  assert.equal(f.prepare('SELECT count(*) AS n FROM recruitment_requests').get().n, 0); assert.equal(f.prepare('SELECT count(*) AS n FROM trials').get().n, 0);
  f.close(); rm(dir, fresh);
});

test('[cutover] the mapping is lossless for every writer shape: the P4B invitation (slots, private details, keys.invite, recipient, caseId, trialId null), the contact (subject, contactId, trialDetails null), the open-day literal (trustedPartner absent), the legacy direct request, the accepted request, both tombstones (trialDetails.instructions present-and-null, keys and recipient dropped), the scheduled, accepted, pre-P4B, worked (revision 2, evidence links active and removed, attendance, completion, the day container, the report, reminders, lifecycle, keys lists, rev) and cancelled trials, blockedBy as a value, null and absent, unknown fields at the record, nested-object and list-entry level, off-type values and a live non-finite number', () => {
  const { readRequests, readTrials } = needRec();
  const tombstoneRequest = (r, at) => { const td = r.trialDetails && typeof r.trialDetails === 'object' ? r.trialDetails : null; return { id: r.id, playerId: r.playerId, playerName: null, orgId: r.orgId, orgName: r.orgName, orgType: r.orgType, orgVerified: r.orgVerified, orgSafeguardingCertified: r.orgSafeguardingCertified, trustedPartner: r.trustedPartner, userId: r.userId, scoutName: r.scoutName, scoutRole: r.scoutRole, type: r.type, message: null, ...(r.contactId ? { contactId: r.contactId } : {}), trialDetails: td ? { proposedDate: td.proposedDate ?? null, altSlots: Array.isArray(td.altSlots) ? td.altSlots : [], venue: td.venue ?? null, notes: '', ...(Array.isArray(td.slots) ? { slots: td.slots.map((x) => ({ id: x.id, day: x.day, startsAt: x.startsAt, endsAt: x.endsAt, timezone: x.timezone, kind: x.kind ?? null, venue: x.venue ? { name: x.venue.name, town: x.venue.town ?? null, address: null } : null })), instructions: null } : {}) } : null, ...(r.caseId ? { caseId: r.caseId } : {}), ...(r.trialId ? { trialId: r.trialId } : {}), status: r.status, createdAt: r.createdAt, respondedAt: r.respondedAt ?? null, respondedBy: r.respondedBy ?? null, routedTo: r.routedTo ?? null, guardianId: null, contactChannel: null, subjectRemovedAt: at }; };
  const requests = [p4bInvitation(), contactRequest(), persisted(openDayRequest({ trustedPartner: undefined })), acceptedRequest(legacyTrialRequest(), 'trial-legacy'), acceptedRequest(p4bInvitation({ id: 'req-acc' }), 'trial-acc'), tombstoneRequest(acceptedRequest(p4bInvitation({ id: 'req-tomb' }), 'trial-tomb'), T.removed),
    legacyTrialRequest({ id: 'req-old', status: 'accepted', respondedAt: T.accepted - 30 * 86_400_000, respondedBy: 'player' }), // the pre-P4B pair: no trialId key beside trial-old
    acceptedRequest(p4bInvitation({ id: 'req-worked' }), 'trial-worked'), acceptedRequest(p4bInvitation({ id: 'req-cancelled' }), 'trial-cancelled'),
    legacyTrialRequest({ id: 'req-odd', legacyFlag: 'kept', trialDetails: { proposedDate: '2026-11-01', altSlots: ['2026-11-02'], venue: 'G', notes: 'n', stray: { nested: true } }, createdAt: 'not-a-number', respondedAt: null, guardianId: undefined, ratio: Infinity })];
  const t1 = scheduledTrial({ id: 'trial-acc', requestId: 'req-acc', blockedBy: 'legacy-reason' });
  const t2 = acceptedTrial({ blockedBy: null }); const t3 = preP4bTrial();
  const t4 = workedTrial({ id: 'trial-worked', requestId: 'req-worked', unknownTop: [1, 2], schedule: { ...workedTrial().schedule, unknownInSchedule: 'x', sessions: [{ ...workedTrial().schedule.sessions[0], extraOnSession: true }] }, history: [{ id: 'aud-x', at: 1, action: 'a', by: null, detail: 'a string detail', extraOnEntry: 1 }], reportDueAt: 'soon', completion: { state: 'completed', at: 5, by: { kind: 'system' }, reason: null, phase: 'scheduled' } });
  const t5 = cancelledTrial(); const t6 = { ...scheduledTrial({ id: 'trial-tomb', requestId: 'req-tomb', caseId: 'case-x' }), playerName: null, notes: '', subjectRemovedAt: T.removed }; // case-x: trial-acc already holds case-1's open slot
  const trials = [t1, t2, t3, t4, t5, t6];
  const dir = tempDir('s8a-map'); preS8aFile(dir, { requests: persisted(requests), trials: persisted(trials), cases: [...CASES(), { ...CASES()[0], id: 'case-x', playerId: 'pl-child2', playerName: 'Child pl-child2' }], channels: [] }); // case-x a full case literal: since S8b (0016) the cases blob is imported into recruitment_cases on the same run
  const s = openRaw(dir); migrateAll(s);
  const backR = readRequests(s); const backT = readTrials(s);
  assert.deepEqual(backR, persisted(requests)); assert.deepEqual(backT, persisted(trials));
  // presence, not only equality
  const od = backR.find((r) => r.id === 'req-openday'); assert.equal('trustedPartner' in od, false, 'absent stays absent'); assert.equal('subject' in od, false);
  const odd = backR.find((r) => r.id === 'req-odd'); assert.equal(odd.createdAt, 'not-a-number', 'an off-type value comes back as it was'); assert.equal('guardianId' in odd, false, 'a live undefined is absence (the blob rule)'); assert.equal(odd.ratio, null, 'a non-finite number persists as JSON null (the blob rule)'); assert.deepEqual(odd.trialDetails.stray, { nested: true });
  const tomb = backR.find((r) => r.id === 'req-tomb'); assert.ok('instructions' in tomb.trialDetails && tomb.trialDetails.instructions === null, 'the tombstone\'s present-and-null instructions key'); assert.equal('keys' in tomb, false); assert.equal('recipient' in tomb, false);
  assert.equal(backT.find((t) => t.id === 'trial-acc').blockedBy, 'legacy-reason'); assert.equal(backT.find((t) => t.id === 'trial-legacy').blockedBy, null); assert.equal('blockedBy' in backT.find((t) => t.id === 'trial-1' || t.id === 'trial-old'), false);
  assert.equal('workflowState' in backT.find((t) => t.id === 'trial-old'), false, 'the pre-P4B trial has no workflowState key: nothing is fabricated'); assert.equal('day' in backT.find((t) => t.id === 'trial-old'), false);
  assert.deepEqual(backT.find((t) => t.id === 'trial-worked').keys.accept, { key: null, fp: JSON.stringify({ requestId: 'req-p4b', day: '2026-11-03' }) }, 'keys.accept kept exactly');
  assert.equal(backT.find((t) => t.id === 'trial-worked').reportDueAt, 'soon');
  // the tables hold the mapped columns (not only JSON): a few probes
  assert.equal(s.prepare('SELECT count(*) AS n FROM request_trial_slots').get().n, 2 * 5, 'the five P4B invitations\' slots (the tombstone keeps its slots)');
  assert.equal(s.prepare("SELECT count(*) AS n FROM trial_schedule_sessions").get().n, 4, 'trial-acc, trial-worked, trial-cancelled, trial-tomb (one session each; the legacy and pre-P4B trials have no schedule)'); assert.equal(s.prepare("SELECT count(*) AS n FROM trial_session_evidence").get().n, 2); assert.equal(s.prepare("SELECT count(*) AS n FROM trial_reports").get().n, 2);
  assert.equal(s.prepare("SELECT count(*) AS n FROM idempotency_keys WHERE act = 'invite'").get().n, 4, 'one invite key per P4B invitation with a client key'); assert.equal(s.prepare("SELECT count(*) AS n FROM trial_day_staff").get().n, 2);
  assert.equal(s.prepare("SELECT case_id FROM trials WHERE id = 'trial-acc'").get().case_id, 'case-1'); assert.equal(s.prepare("SELECT recipient_player_id FROM trials WHERE id = 'trial-acc'").get().recipient_player_id, 'pl-adult');
  s.close(); rm(dir);
});

test('[cutover] the import refuses with ids only — nothing written, the blobs and the record untouched, the next boot refuses the same way: a trial whose request is not in the file, two trials for one request, a request naming a trial that names another request, a request naming a missing trial, a case id not in recruitmentCases (Q7b strict), a guardian id (guardianId, recipient.guardianId, a trial\'s recipient.guardianId) not in guardians (Q7c strict), a duplicate id, an entry without an id, a non-object entry, a non-array blob, a non-JSON blob; a trial whose request names NO trial (the legacy pair) and a player id that is live, retained or missing are accepted and counted (Q7a)', () => {
  needRec();
  const refuse = (label, fixture, pattern) => {
    const dir = tempDir('s8a-refuse'); preS8aFile(dir, { channels: [], ...fixture }); const s = openRaw(dir); const before = [blobText(s, 'requests'), blobText(s, 'trials'), applied(s)];
    assert.throws(() => migrateAll(s), (e) => { assert.match(String(e.message), /RECRUITMENT_IMPORT_BLOCKED/, label); assert.match(String(e.message), pattern, label); assert.doesNotMatch(String(e.message), /Adult Signup|Harbour Road|Bring boots/, `${label}: ids only`); return true; });
    assert.deepEqual([blobText(s, 'requests'), blobText(s, 'trials'), applied(s)], before, `${label}: nothing written`); for (const t of TABLES) assert.equal(tableExistsIn(s, t), false, `${label}: ${t} not created`);
    assert.throws(() => migrateAll(s), /RECRUITMENT_IMPORT_BLOCKED/); s.close(); rm(dir);
  };
  refuse('trial without request', { requests: [p4bInvitation()], trials: [scheduledTrial({ requestId: 'req-none' })] }, /trial-1.*req-none|req-none/);
  refuse('two trials one request', { requests: [acceptedRequest(p4bInvitation(), 'trial-1')], trials: [scheduledTrial(), scheduledTrial({ id: 'trial-dup' })] }, /trial-dup/);
  refuse('pair mismatch', { requests: [acceptedRequest(p4bInvitation(), 'trial-1'), acceptedRequest(p4bInvitation({ id: 'req-b' }), 'trial-1')], trials: [scheduledTrial()] }, /req-b/);
  refuse('missing trial', { requests: [acceptedRequest(p4bInvitation(), 'trial-ghost')], trials: [] }, /trial-ghost/);
  refuse('missing case', { requests: [p4bInvitation({ caseId: 'case-ghost' })], trials: [] }, /case-ghost/);
  refuse('missing case on a trial', { requests: [acceptedRequest(p4bInvitation(), 'trial-1')], trials: [scheduledTrial({ caseId: 'case-ghost' })] }, /case-ghost/);
  refuse('missing guardian', { requests: [legacyTrialRequest({ guardianId: 'gd-ghost', routedTo: 'guardian' })], trials: [] }, /gd-ghost/);
  refuse('missing recipient guardian', { requests: [minorInvitation({ recipient: { type: 'guardian', playerId: 'pl-child1', guardianId: 'gd-ghost', minor: true } })], trials: [] }, /gd-ghost/);
  refuse('missing recipient guardian on a trial', { requests: [acceptedRequest(p4bInvitation(), 'trial-1')], trials: [scheduledTrial({ recipient: { type: 'guardian', playerId: 'pl-adult', guardianId: 'gd-ghost', minor: true, at: 1 } })] }, /gd-ghost/);
  refuse('duplicate id', { requests: [legacyTrialRequest(), legacyTrialRequest()], trials: [] }, /req-legacy/);
  refuse('no id', { requests: [{ ...legacyTrialRequest(), id: undefined }], trials: [] }, /entry #0/);
  refuse('non-object', { requests: ['nope'], trials: [] }, /entry #0/);
  refuse('non-array', { requests: undefined, trials: undefined, rawBlobs: { requests: JSON.stringify({ a: 1 }), trials: '[]' } }, /array/);
  refuse('non-json', { requests: undefined, trials: undefined, rawBlobs: { requests: '{not json', trials: '[]' } }, /JSON/);
  const dir = tempDir('s8a-tolerant'); preS8aFile(dir, { requests: [legacyTrialRequest({ id: 'req-gone', playerId: 'pl-gone' }), acceptedRequest(legacyTrialRequest({ id: 'req-old', playerId: 'pl-adult' }), undefined)], trials: [preP4bTrial({ requestId: 'req-old' }), preP4bTrial({ id: 'trial-gone', requestId: 'req-gone', playerId: 'pl-gone', report: undefined })], channels: [] });
  const s = openRaw(dir); migrateAll(s); const c = JSON.parse(meta(s, 'recruitmentCutover'));
  assert.equal(c.players.missing, 2, 'pl-gone on a request and a trial: counted'); assert.equal(c.trials.legacyPairs, 2); assert.equal(s.prepare("SELECT count(*) AS n FROM trials WHERE player_id = 'pl-gone'").get().n, 1, 'imported as it is, never fabricated, never refused');
  s.close(); rm(dir);
});

// ------------------------------------------------------------- the repository (server mode, staged)
test('[cutover] the repository: db.requests and db.trials are read-only ARRAYS of plain mutable records; addRequest/addTrial land in the next save as rows with their children; an in-place mutation (status, a schedule, an attendance push, a day staff push, a keys list push, a report) lands in the next save with the children rewritten in list order; an unchanged save writes no recruitment row and advances the revision; the derived trialReports accessor reads the table; tombstoneForPlayer replaces the records in place; exportRequests/exportTrials are detached copies; a reopen serves the same records', () => {
  const dir = tempDir('s8a-repo'); preS8aFile(dir, FIX()); withRo(dir, () => {}); { const s = openRaw(dir); migrateAll(s); s.close(); }
  const L = serverOpen(dir, { cases: CASES() }); needRec();
  assert.ok(Array.isArray(L.db.requests) && Array.isArray(L.db.trials)); assert.equal(L.db.requests.length, 6); assert.equal(L.db.trials.length, 2);
  assert.throws(() => L.db.requests.push({ id: 'x' }), /repositor/i); assert.throws(() => { L.db.trials[0] = {}; }, /repositor/i);
  const pending = L.db.requests.find((r) => r.id === 'req-legacy');
  pending.status = 'accepted'; pending.respondedAt = NOW; pending.respondedBy = 'player'; pending.contactChannel = null; // the respond route's in-place writes
  const trial = acceptedTrial({ id: 'trial-new', requestId: 'req-legacy', acceptedAt: NOW });
  L.repo.addTrial(trial); pending.trialId = 'trial-new'; // issueAcceptedTrial + the hook
  const newReq = legacyTrialRequest({ id: 'req-new', playerId: 'pl-child2', routedTo: 'guardian', guardianId: 'gd-primary', createdAt: NOW });
  const added = L.repo.addRequest(newReq); assert.equal(added, newReq, 'the record itself is kept (callers mutate it afterwards)');
  assert.equal(L.db.requests.at(-1), newReq);
  const r0 = L.revision(); L.save(); assert.equal(L.revision(), r0 + 1);
  withRo(dir, (s) => {
    assert.deepEqual(plain(s.prepare("SELECT status, trial_id FROM recruitment_requests WHERE id = 'req-legacy'").get()), { status: 'accepted', trial_id: 'trial-new' });
    assert.equal(s.prepare("SELECT request_id FROM trials WHERE id = 'trial-new'").get().request_id, 'req-legacy'); assert.equal(s.prepare("SELECT guardian_id FROM recruitment_requests WHERE id = 'req-new'").get().guardian_id, 'gd-primary');
  });
  // nested in-place mutations
  const t1 = L.db.trials.find((t) => t.id === 'trial-1');
  t1.attendance.push({ sessionId: 'tses-1', state: 'attended', source: 'manual', recordedBy: { kind: 'org', userId: 'usr-1', name: 'Maria' }, recordedAt: NOW, note: null });
  t1.day = { staff: [], consents: [], arrival: null, emergency: null, checkins: [], collection: null, statusEvents: [] }; t1.day.staff.push({ id: 'stf-9', name: 'Coach', role: 'Lead', check: null, addedBy: 'Maria', addedAt: NOW });
  t1.keys.schedule = [{ key: 'k1', fp: 'f1', at: NOW }]; t1.keys.schedule.push({ key: 'k2', fp: 'f2', at: NOW + 1 });
  t1.status = 'reported'; t1.report = report({ id: 'rep-9', filedAt: NOW }); t1.reminders.completionPending = NOW;
  L.save();
  withRo(dir, (s) => {
    assert.equal(s.prepare("SELECT count(*) AS n FROM trial_attendance WHERE trial_id = 'trial-1'").get().n, 1); assert.equal(s.prepare("SELECT name FROM trial_day_staff WHERE trial_id = 'trial-1'").get().name, 'Coach');
    assert.deepEqual(s.prepare("SELECT key FROM idempotency_keys WHERE owner_id = 'trial-1' AND act = 'schedule' ORDER BY position").all().map((r) => r.key), ['k1', 'k2']);
    assert.equal(s.prepare("SELECT id FROM trial_reports WHERE trial_id = 'trial-1'").get().id, 'rep-9'); assert.equal(s.prepare("SELECT status FROM trials WHERE id = 'trial-1'").get().status, 'reported');
    assert.equal(s.prepare("SELECT sent_at FROM trial_reminders WHERE trial_id = 'trial-1' AND marker = 'completionPending'").get().sent_at, NOW);
  });
  assert.deepEqual(L.layer.identity.players.view.find?.call([], () => true), undefined); // (no live players in this fixture's tables)
  assert.deepEqual(L.repo.trialReportsFor('pl-adult').map((r) => r.id), ['rep-old', 'rep-9'], 'derived from the trials, in filing order');
  // unchanged save: no recruitment row written
  const before = withRo(dir, recDump); const r1 = L.revision(); L.save(); assert.equal(withRo(dir, recDump), before, 'an unchanged save rewrites nothing'); assert.equal(L.revision(), r1 + 1);
  assert.equal(L.repo.pending().requests + L.repo.pending().trials, 0);
  // tombstones replace in place
  L.repo.tombstoneForPlayer('pl-adult', { request: (r) => ({ ...r, playerName: null, message: null, subjectRemovedAt: NOW }), trial: (t) => ({ ...t, playerName: null, notes: '', subjectRemovedAt: NOW }) });
  assert.equal(L.db.requests.filter((r) => r.playerId === 'pl-adult').every((r) => r.subjectRemovedAt === NOW), true); assert.equal(L.db.requests.find((r) => r.id === 'req-new').subjectRemovedAt, undefined);
  L.save(); withRo(dir, (s) => { assert.equal(s.prepare("SELECT count(*) AS n FROM recruitment_requests WHERE subject_removed_at IS NOT NULL").get().n, L.db.requests.filter((r) => r.playerId === 'pl-adult').length); assert.equal(s.prepare("SELECT player_name FROM trials WHERE id = 'trial-1'").get().player_name, null); });
  const exported = L.repo.exportTrials(); assert.notEqual(exported.find((t) => t.id === 'trial-1'), t1); assert.deepEqual(plain(exported), plain(L.db.trials));
  L.close();
  const again = serverOpen(dir, { cases: CASES() }); assert.deepEqual(plain(again.db.trials), plain(exported)); assert.deepEqual(plain(again.db.requests), plain(L.db.requests)); again.close(); rm(dir);
});

test('[cutover] the two failure contracts: a failed ORDINARY save (a statement failure, then a failure of the REAL COMMIT) leaves the tables and the revision unchanged, keeps every pending change in memory and lands it ONCE on the next save; an aborted UNIT OF WORK (a joined failure, a real COMMIT failure) rolls the tables back AND restores the pre-unit graph in place — a held nested view (the trial\'s schedule object, the request record) reads the pre-unit values; edits pending before the unit stay pending; the retry lands once', () => {
  const dir = tempDir('s8a-fail'); preS8aFile(dir, FIX()); { const s = openRaw(dir); migrateAll(s); s.close(); }
  const L = serverOpen(dir, { cases: CASES() }); needRec();
  const t1 = L.db.trials.find((t) => t.id === 'trial-1'); const held = t1.schedule; const r1 = L.db.requests.find((r) => r.id === 'req-p4b');
  t1.workflowState = 'completed'; t1.completion = { state: 'completed', at: NOW, by: { kind: 'org', userId: 'usr-1', name: 'Maria' }, reason: null, phase: 'scheduled' };
  const before = withRo(dir, recDump); const rev = L.revision();
  const probe = failRunAt(L.store.sqlite, (sql) => /INTO trials|UPDATE trials/.test(sql), 1, 'synthetic statement failure');
  assert.throws(() => L.save(), /synthetic statement failure/); probe.restore();
  assert.equal(withRo(dir, recDump), before); assert.equal(L.revision(), rev); assert.equal(t1.workflowState, 'completed', 'memory is the intended state'); assert.equal(L.store.sqlite.isTransaction, false);
  // the REAL COMMIT of an ordinary save fails (the store's seam, armed from a flush hook registered after the repositories: the recruitment rows were written inside the transaction, then COMMIT itself is refused)
  let armCommitFailure = false; L.store.setSaveHook(() => { if (armCommitFailure) { armCommitFailure = false; L.store.failCommitOfOpenTransaction(); } });
  armCommitFailure = true; assert.throws(() => L.save(), /FOREIGN KEY constraint failed/);
  assert.equal(withRo(dir, recDump), before, 'the real COMMIT failure: nothing landed'); assert.equal(L.revision(), rev); assert.equal(t1.workflowState, 'completed'); assert.equal(L.store.sqlite.isTransaction, false);
  L.save(); withRo(dir, (s) => assert.equal(s.prepare("SELECT workflow_state FROM trials WHERE id = 'trial-1'").get().workflow_state, 'completed'));
  const landed = withRo(dir, recDump); L.save(); assert.equal(withRo(dir, recDump), landed, 'landed once');
  // a unit of work: pending edit before, joined write inside, failure → restored in place
  r1.message = 'edited before the unit (pending)';
  const dumpBefore = withRo(dir, recDump);
  assert.throws(() => L.store.unitOfWork(() => {
    t1.schedule.revision = 9; t1.schedule.sessions.push(session({ id: 'tses-unit' })); t1.workflowState = 'cancelled';
    L.repo.addRequest(legacyTrialRequest({ id: 'req-unit', createdAt: NOW }));
    throw new Error('synthetic unit failure');
  }, { snapshot: L.snapshot }), /synthetic unit failure/);
  assert.equal(withRo(dir, recDump), dumpBefore); assert.equal(L.store.sqlite.isTransaction, false);
  assert.equal(held.revision, 1, 'the held nested schedule object reads the pre-unit value'); assert.equal(held.sessions.length, 1); assert.equal(t1.schedule, held, 'the same object, restored in place'); assert.equal(t1.workflowState, 'completed');
  assert.equal(L.db.requests.some((r) => r.id === 'req-unit'), false); assert.equal(r1.message, 'edited before the unit (pending)', 'the pre-unit pending edit stays');
  // a real COMMIT failure inside a unit
  assert.throws(() => L.store.unitOfWork(() => { t1.workflowState = 'cancelled'; L.store.failCommitOfOpenTransaction(); }, { snapshot: L.snapshot }));
  assert.equal(t1.workflowState, 'completed'); assert.equal(withRo(dir, recDump), dumpBefore);
  L.store.unitOfWork(() => { t1.workflowState = 'cancelled'; L.repo.addRequest(legacyTrialRequest({ id: 'req-unit', createdAt: NOW })); }, { snapshot: L.snapshot });
  withRo(dir, (s) => { assert.equal(s.prepare("SELECT workflow_state FROM trials WHERE id = 'trial-1'").get().workflow_state, 'cancelled'); assert.equal(s.prepare("SELECT message FROM recruitment_requests WHERE id = 'req-p4b'").get().message, 'edited before the unit (pending)'); assert.ok(s.prepare("SELECT 1 FROM recruitment_requests WHERE id = 'req-unit'").get()); });
  L.close(); rm(dir);
});

// ------------------------------------------------------------- the six-phase snapshot write
test('[cutover] the six-phase snapshot write (plan §D.7.5): an empty file receiving a complete new request/trial/channel graph in BOTH trial orders persists identical rows and children; the unchanged snapshot re-saved is byte-identical; a replacement trial; a request swap between two surviving trials; completion and cancellation followed by a new open trial in the same case in both orders; a terminal trial re-entering accepted only when the holder leaves; case-only changes (case-1 → case-2, → NULL, NULL → case, a swap of two open survivors) with requests OMITTED equal the same change with the unchanged requests supplied, in both orders; a deliberate removal leaves the back-reference NULL', () => {
  needRec();
  const file = (tag, fixture) => { const d = tempDir(`s8a-${tag}`); preS8aFile(d, fixture); const s = openRaw(d); migrateAll(s); s.close(); return d; };
  const both = (label, fixture, over, { omit = [] } = {}) => {
    const outs = [false, true].map((reverse) => { const d = file('both', fixture); const S = snapshotOpen(d); const o = { ...over }; if (reverse && o.trials) o.trials = [...o.trials].reverse(); S.save(o, { omit }); const dump = withRo(d, recDump); S.close(); rm(d); return dump; });
    // the same final graph: every row and child row identical; `seq` (the parents' insertion order) is the supplied order by design, so a swap that departs and re-arrives two trials numbers them in the order given
    const canonical = (dump) => JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(dump)).map(([t, rows]) => [t, rows.map(({ seq, ...r }) => r).map((r) => JSON.stringify(r)).sort()])));
    assert.equal(canonical(outs[0]), canonical(outs[1]), `${label}: both trial orders persist identical rows and children`); return outs[0];
  };
  const empty = { requests: [], trials: [], channels: [] };
  const graph = { requests: [acceptedRequest(p4bInvitation(), 'trial-1'), legacyTrialRequest()], trials: [scheduledTrial()], channels: [CHANNEL()] };
  const g = both('new graph', empty, graph);
  { const d = file('again', empty); const S = snapshotOpen(d); S.save(graph); assert.equal(withRo(d, recDump), g); S.save(graph); assert.equal(withRo(d, recDump), g, 'unchanged: byte-identical'); S.close(); rm(d); }
  // replacement
  { const d = file('repl', graph); const S = snapshotOpen(d); S.save({ requests: [acceptedRequest(p4bInvitation(), 'trial-2'), legacyTrialRequest()], trials: [scheduledTrial({ id: 'trial-2', acceptedAt: NOW })] }); withRo(d, (s) => { assert.deepEqual(s.prepare('SELECT id, request_id FROM trials').all().map((r) => [r.id, r.request_id]), [['trial-2', 'req-p4b']]); assert.equal(s.prepare("SELECT trial_id FROM recruitment_requests WHERE id = 'req-p4b'").get().trial_id, 'trial-2'); assert.equal(s.prepare("SELECT count(*) AS n FROM trial_history WHERE trial_id = 'trial-1'").get().n, 0); assert.equal(s.prepare("SELECT count(*) AS n FROM request_trial_slots WHERE request_id = 'req-p4b'").get().n, 2); }); S.close(); rm(d); }
  // request swap between survivors
  const two = { requests: [acceptedRequest(p4bInvitation(), 'trial-1'), acceptedRequest(p4bInvitation({ id: 'req-2', caseId: 'case-2' }), 'trial-2')], trials: [scheduledTrial(), scheduledTrial({ id: 'trial-2', requestId: 'req-2', caseId: 'case-2' })], channels: [] };
  both('request swap', two, { requests: [acceptedRequest(p4bInvitation(), 'trial-2'), acceptedRequest(p4bInvitation({ id: 'req-2', caseId: 'case-2' }), 'trial-1')], trials: [scheduledTrial({ requestId: 'req-2', caseId: 'case-2' }), scheduledTrial({ id: 'trial-2', requestId: 'req-p4b', caseId: 'case-1' })] });
  // completion / cancellation then a new open trial in the same case
  for (const state of ['completed', 'cancelled']) {
    const dump = both(`${state} then open`, graph, { requests: [acceptedRequest(p4bInvitation(), 'trial-1'), acceptedRequest(legacyTrialRequest(), 'trial-3')], trials: [scheduledTrial({ id: 'trial-3', requestId: 'req-legacy', caseId: 'case-1' }), scheduledTrial({ workflowState: state })] });
    assert.ok(dump.includes('"trial-3"'));
  }
  // re-entry
  const closedOpen = { requests: two.requests, trials: [scheduledTrial({ workflowState: 'completed' }), scheduledTrial({ id: 'trial-2', requestId: 'req-2', caseId: 'case-1' })], channels: [] };
  both('re-entry ok', closedOpen, { trials: [scheduledTrial(), scheduledTrial({ id: 'trial-2', requestId: 'req-2', caseId: 'case-1', workflowState: 'cancelled' })] }, { omit: ['requests'] });
  { const d = file('reentry-refused', closedOpen); const S = snapshotOpen(d); const before = withRo(d, recDump); const rev = S.revision(); assert.throws(() => S.save({ trials: [scheduledTrial(), scheduledTrial({ id: 'trial-2', requestId: 'req-2', caseId: 'case-1' })] }, { omit: ['requests'] }), /UNIQUE constraint failed: trials\.case_id/); assert.equal(withRo(d, recDump), before); assert.equal(S.revision(), rev); S.close(); rm(d); }
  // case-only changes with requests omitted = with requests supplied
  const partialEqualsFull = (label, fixture, trials) => {
    const full = both(`${label} full`, fixture, { requests: fixture.requests, trials }); const partial = both(`${label} partial`, fixture, { trials }, { omit: ['requests'] });
    assert.equal(partial, full, `${label}: the requests-omitted save persists exactly the full save's rows and children`);
  };
  partialEqualsFull('case-1 → case-2', graph, [scheduledTrial({ caseId: 'case-2' })]);
  partialEqualsFull('case-1 → NULL', graph, [scheduledTrial({ caseId: null })]);
  partialEqualsFull('NULL → case-1', { ...graph, trials: [scheduledTrial({ caseId: null })] }, [scheduledTrial({ caseId: 'case-1' })]);
  partialEqualsFull('swap of two open survivors', two, [scheduledTrial({ caseId: 'case-2' }), scheduledTrial({ id: 'trial-2', requestId: 'req-2', caseId: 'case-1' })]);
  partialEqualsFull('same-case completion', graph, [scheduledTrial({ workflowState: 'completed' })]);
  // deliberate removal with requests omitted: back-reference NULL, children gone
  { const d = file('removal', graph); const S = snapshotOpen(d); S.save({ trials: [] }, { omit: ['requests'] }); withRo(d, (s) => { assert.equal(s.prepare("SELECT trial_id FROM recruitment_requests WHERE id = 'req-p4b'").get().trial_id, null); assert.equal(s.prepare('SELECT count(*) AS n FROM trials').get().n + s.prepare('SELECT count(*) AS n FROM trial_history').get().n, 0); }); S.close(); rm(d); }
});

test('[cutover] the snapshot write refuses atomically — every table, the channels and the revision unchanged, no transaction open, ids only: two open trials in one case (both orders); a trial naming a missing request; a request naming a missing trial; a pair mismatch; a new trial for a retained request that names NOTHING but carries the key (trialId null, requests omitted); an actual request reassignment with requests omitted; a case id not in the FINAL recruitmentCases — supplied or retained — including when ONLY the recruitmentCases collection changes (Q7b strict); a guardian not in the FINAL guardians — including when ONLY the identity pair is rewritten (Q7c strict); a request removed while its trial or its thread stays (RESTRICT); a channel naming a request outside the final table (the real key); a malformed collection; a mediaDeletions-style explicit non-array', () => {
  needRec();
  const d = tempDir('s8a-refusals'); preS8aFile(d, { requests: [acceptedRequest(p4bInvitation(), 'trial-1'), acceptedRequest(p4bInvitation({ id: 'req-2', caseId: 'case-2' }), 'trial-2'), minorInvitation()], trials: [scheduledTrial(), scheduledTrial({ id: 'trial-2', requestId: 'req-2', caseId: 'case-2', workflowState: 'completed' })], channels: [CHANNEL()] });
  { const s = openRaw(d); migrateAll(s); s.close(); }
  const S = snapshotOpen(d);
  const refused = (label, over, pattern, { omit = [] } = {}) => {
    const before = withRo(d, (s) => [recDump(s), s.prepare('SELECT count(*) AS n FROM guardians').get().n]); const rev = S.revision();
    assert.throws(() => S.save(over, { omit }), (e) => { assert.match(String(e.message), pattern, `${label}: ${e.message}`); assert.doesNotMatch(String(e.message), /Adult Signup|Harbour Road/, 'ids only'); return true; });
    assert.deepEqual(withRo(d, (s) => [recDump(s), s.prepare('SELECT count(*) AS n FROM guardians').get().n]), before, `${label}: unchanged`); assert.equal(S.revision(), rev, `${label}: revision unchanged`); assert.equal(S.store.sqlite.isTransaction, false);
  };
  const R = () => [acceptedRequest(p4bInvitation(), 'trial-1'), acceptedRequest(p4bInvitation({ id: 'req-2', caseId: 'case-2' }), 'trial-2'), minorInvitation()];
  for (const reverse of [false, true]) { const trials = [scheduledTrial(), scheduledTrial({ id: 'trial-2', requestId: 'req-2', caseId: 'case-1' })]; if (reverse) trials.reverse(); refused(`two open [${reverse}]`, { requests: R(), trials }, /UNIQUE constraint failed: trials\.case_id/); }
  refused('missing request', { requests: R(), trials: [scheduledTrial(), scheduledTrial({ id: 'trial-9', requestId: 'req-ghost', caseId: null })] }, /FOREIGN KEY|req-ghost/);
  refused('missing trial', { requests: [acceptedRequest(p4bInvitation(), 'trial-ghost'), R()[1], R()[2]] }, /FOREIGN KEY|trial-ghost/, { omit: ['trials'] });
  refused('pair mismatch', { requests: R(), trials: [scheduledTrial({ requestId: 'req-2', caseId: 'case-1' }), scheduledTrial({ id: 'trial-2', requestId: 'req-p4b', caseId: 'case-2', workflowState: 'completed' })] }, /PAIR_MISMATCH|names/);
  refused('new trial for a request naming null', { trials: [scheduledTrial(), scheduledTrial({ id: 'trial-2', requestId: 'req-2', caseId: 'case-2', workflowState: 'completed' }), scheduledTrial({ id: 'trial-m', requestId: 'req-minor', caseId: 'case-2', workflowState: 'completed' })] }, /PAIR_MISMATCH|req-minor/, { omit: ['requests'] });
  refused('reassignment with requests omitted', { trials: [scheduledTrial({ requestId: 'req-minor', caseId: null }), scheduledTrial({ id: 'trial-2', requestId: 'req-2', caseId: 'case-2', workflowState: 'completed' })] }, /PAIR_MISMATCH|req-minor|req-p4b/, { omit: ['requests'] });
  refused('missing case, supplied', { requests: [p4bInvitation({ caseId: 'case-ghost', trialId: null }), R()[1], R()[2]], trials: [scheduledTrial({ id: 'trial-2', requestId: 'req-2', caseId: 'case-2', workflowState: 'completed' })] }, /case-ghost/);
  refused('cases-only change removes a referenced case', { recruitmentCases: CASES().filter((c) => c.id !== 'case-2') }, /case-2/);
  refused('missing guardian, supplied', { requests: [R()[0], R()[1], minorInvitation({ guardianId: 'gd-ghost' })] }, /gd-ghost/);
  refused('identity-only rewrite removes the guardian the minor\'s invitation names', { players: S.db.players, guardians: S.db.guardians.filter((g) => g.id !== 'gd-primary') }, /gd-primary/);
  refused('request removed while its trial stays', { requests: R().slice(1) }, /PAIR_MISMATCH.*trial-1.*req-p4b|FOREIGN KEY/, { omit: ['trials'] }); // the pre-write check names the pair (ids only) before the RESTRICT key would
  refused('request removed while its thread stays', { requests: R().slice(1), trials: [scheduledTrial({ id: 'trial-2', requestId: 'req-2', caseId: 'case-2', workflowState: 'completed' })] }, /CHANNEL_REQUEST_MISSING.*chan-1.*req-p4b/, { omit: ['channels'] }); // the prune names the thread (ids only) before the RESTRICT key would
  refused('channel naming a request outside the final table', { channels: [CHANNEL({ requestId: 'req-ghost' })] }, /FOREIGN KEY|CHANNEL_REQUEST_MISSING|req-ghost/);
  refused('malformed collection', { trials: { not: 'an array' } }, /array/);
  S.close(); rm(d);
});

test('[cutover] the snapshot read serves both collections under their names (never a blob), a snapshot that omits them keeps the rows, an explicit empty array clears them (with its channels), and the identity replace still reconciles trialReports against the FINAL trials when the trials are table-backed (supplied or retained)', () => {
  needRec();
  const d = tempDir('s8a-read'); preS8aFile(d, FIX()); { const s = openRaw(d); migrateAll(s); s.close(); }
  const S = snapshotOpen(d);
  assert.deepEqual(plain(S.db.requests), persisted(FIX().requests)); assert.deepEqual(plain(S.db.trials), persisted(FIX().trials));
  const before = withRo(d, recDump); S.save({}, { omit: ['requests', 'trials'] }); assert.equal(withRo(d, recDump), before, 'omitted: retained');
  // the identity replace with the trials omitted reads the TABLE, not a blob: a player claiming a report that the retained trials do not carry is refused
  const claimant = { ...S.db.players[0], trialReports: [{ id: 'rep-ghost' }] };
  assert.throws(() => S.save({ players: [claimant, ...S.db.players.slice(1)] }, { omit: ['trials'] }), /TRIAL_REPORTS_UNRECONCILED|rep-ghost/);
  // the players' derived copies go with the trials (S5's invariant refuses the clear otherwise)
  S.save({ requests: [], trials: [], channels: [], players: S.db.players.map((p) => ({ ...p, trialReports: [] })), guardians: S.db.guardians }); withRo(d, (s) => { assert.equal(s.prepare('SELECT count(*) AS n FROM recruitment_requests').get().n, 0); assert.equal(s.prepare('SELECT count(*) AS n FROM idempotency_keys').get().n, 0); });
  S.close(); rm(d);
});

// ------------------------------------------------------------- review of 6d77aa7 (F1, F2)
// FAILING-FIRST NOTE: recorded on the unchanged 6d77aa7 tree before the correction — F1 fails at the cutover read-back
// (an empty list act comes back absent; a prototype-named own act disappears), F2 fails because a present `null` blob
// imports as an empty collection and records the migration.
test('[cutover] F1 (review of 6d77aa7): every idempotency action is preserved losslessly and DISTINCTLY — an empty list act, an empty object act, a null act, a prototype-named own act (`__proto__`) holding a keyed value or a keyed list, `constructor`- and `toString`-named acts, mixed empty and non-empty acts — through the cutover, a whole-snapshot save, the staged repository (in place, and an unchanged save writing nothing), a reopen, the copy-only rollback and the re-upgrade; a non-empty list keeps its order, its duplicates and its fingerprints', () => {
  const { readRequests, readTrials } = needRec(); const rollback = needRollback();
  const own = (json) => JSON.parse(json); // JSON.parse creates OWN properties, `__proto__` included — the way every blob is read
  const KEYS_R = () => own('{"invite":[],"__proto__":{"key":"proto-key","fp":"proto-fp"},"constructor":{"key":"ctor-key","fp":"ctor-fp"},"toString":[{"key":"ts-1","fp":"ts-fp","at":1}],"empty":{},"nothing":null}');
  const KEYS_T = () => own('{"accept":{"key":null,"fp":"fp-accept"},"schedule":[],"attendance":[{"key":"k-a","fp":"f-a","at":2},{"key":"k-a","fp":"f-a","at":2},{"key":"k-b","fp":"f-b","at":3}],"__proto__":[{"key":"p-1","fp":"p-f"},{"key":"p-1","fp":"p-f"}],"cancel":[],"complete":{}}');
  const requests = [acceptedRequest(p4bInvitation({ keys: KEYS_R() }), 'trial-1'), legacyTrialRequest({ keys: own('{"__proto__":{"key":"legacy-proto","fp":"lp"}}') })];
  const trials = [scheduledTrial({ keys: KEYS_T() })];
  const expectR = persisted(requests); const expectT = persisted(trials);
  assert.ok(Object.hasOwn(expectR[0].keys, '__proto__') && Object.hasOwn(expectT[0].keys, '__proto__'), 'the fixture carries the prototype-named own act (JSON round trip keeps it)');
  const checkKeys = (label, r, t) => {
    assert.deepEqual(r, expectR[0], `${label}: the request`); assert.deepEqual(t, expectT[0], `${label}: the trial`);
    // presence, not only equality
    assert.ok(Object.hasOwn(r.keys, 'invite') && Array.isArray(r.keys.invite) && r.keys.invite.length === 0, `${label}: the empty list act is present and empty`);
    assert.ok(Object.hasOwn(r.keys, '__proto__') && r.keys.__proto__.key === 'proto-key', `${label}: the prototype-named own act`);
    assert.ok(Object.hasOwn(r.keys, 'constructor') && r.keys.constructor.key === 'ctor-key' && Array.isArray(r.keys.toString) && r.keys.toString[0].key === 'ts-1', `${label}: constructor/toString-named acts`);
    assert.ok(Object.hasOwn(r.keys, 'empty') && Object.keys(r.keys.empty).length === 0 && Object.hasOwn(r.keys, 'nothing') && r.keys.nothing === null, `${label}: an empty object act and a null act, distinctly`);
    assert.deepEqual(t.keys.schedule, [], `${label}: schedule []`); assert.deepEqual(t.keys.cancel, [], `${label}: cancel []`); assert.deepEqual(t.keys.complete, {}, `${label}: complete {}`);
    assert.deepEqual(t.keys.attendance.map((e) => [e.key, e.fp, e.at]), [['k-a', 'f-a', 2], ['k-a', 'f-a', 2], ['k-b', 'f-b', 3]], `${label}: order, duplicates and fingerprints`);
    assert.ok(Object.hasOwn(t.keys, '__proto__') && Array.isArray(t.keys.__proto__) && t.keys.__proto__.length === 2, `${label}: the prototype-named list act with its duplicate`);
    assert.deepEqual(t.keys.accept, { key: null, fp: 'fp-accept' }, `${label}: keys.accept as written`);
  };
  const dir = tempDir('s8a-f1'); preS8aFile(dir, { requests: expectR, trials: expectT, channels: [] });
  { const s = openRaw(dir); migrateAll(s); checkKeys('cutover', readRequests(s)[0], readTrials(s)[0]);
    assert.deepEqual(s.prepare("SELECT key, fp FROM idempotency_keys WHERE owner_id = 'trial-1' AND act = 'attendance' ORDER BY position").all().map((r) => [r.key, r.fp]), [['k-a', 'f-a'], ['k-a', 'f-a'], ['k-b', 'f-b']], 'the list rows in order with the duplicate');
    assert.deepEqual(readRequests(s)[1].keys, expectR[1].keys, 'cutover: the legacy request\'s prototype-named act'); s.close(); }
  // a whole-snapshot save with fresh objects
  { const S = snapshotOpen(dir); S.db.requests[0].keys = KEYS_R(); S.db.trials[0].keys = KEYS_T(); S.save(); S.close(); withRo(dir, (s) => checkKeys('snapshot save', readRequests(s)[0], readTrials(s)[0])); }
  // the staged repository: in place, then an unchanged save
  { const L = serverOpen(dir, { cases: CASES() }); L.db.requests[0].keys = KEYS_R(); L.db.trials[0].keys = KEYS_T(); L.save(); withRo(dir, (s) => checkKeys('staged save', readRequests(s)[0], readTrials(s)[0]));
    const before = withRo(dir, recDump); L.save(); assert.equal(withRo(dir, recDump), before, 'an unchanged save rewrites nothing (the fingerprint sees the prototype-named act)'); L.close();
    const again = serverOpen(dir, { cases: CASES() }); checkKeys('reopen', plain(again.db.requests[0]), plain(again.db.trials[0])); again.close(); }
  // the rollback copy carries them in the blobs; the re-upgrade reproduces them
  const s8cF1 = tempDir('s8a-f1-s8c'); rollbackRecruitmentContactsOffersCopy(dbFile(dir), s8cF1, { now: NOW }); // S8c: the file carries 0017 — its rollback goes first (the chain)
  const s8bF1 = tempDir('s8a-f1-s8b'); rollbackRecruitmentCasesCopy(dbFile(s8cF1), s8bF1, { now: NOW }); // then S8b on the S8c copy
  const out = tempDir('s8a-f1-out'); rollback(dbFile(s8bF1), out, { now: NOW });
  withRo(out, (c) => { checkKeys('rollback blob', blob(c, 'requests')[0], blob(c, 'trials')[0]); assert.deepEqual(blob(c, 'requests')[1].keys, expectR[1].keys); });
  { const up = openRaw(out); migrateAll(up); checkKeys('re-upgrade', readRequests(up)[0], readTrials(up)[0]); up.close(); }
  rm(dir, out, s8bF1);
});

test('[cutover] F2 (review of 6d77aa7): a PRESENT null blob — requests or trials — refuses the cutover with RECRUITMENT_IMPORT_BLOCKED like an object, a string or a number: no table created, the blob, the record, saveSeq and every other row untouched, no transaction left open, the next attempt refused the same way; a genuinely ABSENT blob and an explicit [] still import nothing and cut over', () => {
  needRec();
  for (const [name, other] of [['requests', 'trials'], ['trials', 'requests']]) {
    // the null is written AFTER the earlier steps ran (0007 reconciles trialReports against the trials blob and refuses a non-array itself): the file is a valid S4b-R file whose blob row then holds JSON null
    const dir = tempDir('s8a-f2'); preS8aFile(dir, { requests: undefined, trials: undefined, channels: [], rawBlobs: { [other]: '[]' } });
    const s = openRaw(dir); s.prepare('INSERT INTO collections (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run(name, 'null');
    assert.equal(blobText(s, name), 'null'); const before = fullDump(s);
    assert.throws(() => migrateAll(s), (e) => { assert.match(String(e.message), /RECRUITMENT_IMPORT_BLOCKED/, `${name}: refused`); assert.match(String(e.message), new RegExp(`${name} blob.*null`), `${name}: the refusal names the null blob`); return true; });
    assert.equal(blobText(s, name), 'null', `${name}: the blob is left as it was`); assert.equal(applied(s).includes(MIGRATION), false, `${name}: the migration is not recorded`); for (const t of TABLES) assert.equal(tableExistsIn(s, t), false, `${name}: ${t} not created`);
    assert.equal(fullDump(s), before, `${name}: every row of every table as before`);
    s.exec('BEGIN'); s.exec('ROLLBACK'); // the refusal left no transaction open
    assert.throws(() => migrateAll(s), /RECRUITMENT_IMPORT_BLOCKED/, `${name}: the next attempt refuses the same way`); assert.equal(fullDump(s), before);
    s.close(); rm(dir);
  }
  for (const explicit of [false, true]) {
    const dir = tempDir('s8a-f2-ok'); preS8aFile(dir, { requests: undefined, trials: undefined, channels: [], ...(explicit ? { rawBlobs: { requests: '[]', trials: '[]' } } : {}) });
    const s = openRaw(dir); migrateAll(s); assert.ok(applied(s).includes(MIGRATION), explicit ? 'explicit [] blobs cut over' : 'absent blobs cut over'); assert.equal(s.prepare('SELECT count(*) AS n FROM trials').get().n + s.prepare('SELECT count(*) AS n FROM recruitment_requests').get().n, 0); s.close(); rm(dir);
  }
});

// ------------------------------------------------------------- the rollback tool
test('[cutover] the copy-only rollback: the source is never modified; the copy gets the requests and trials blobs back in insertion order in the writers\' literals (presence, absence, unknown fields, keys reassembled), channels rebuilt to the 0012 definition (no request key) with every thread, message and attachment, the fifteen tables dropped, the 0015 record and meta key removed, the revision advanced, every other table untouched; refusals leave no output (a copy that never applied 0015, a non-empty output directory); the S4b-R tool refuses the 0015 file and accepts the rollback output; re-upgrading the copy reproduces the tables exactly', () => {
  const rollback = needRollback(); needRec();
  const d = tempDir('s8a-rb'); preS8aFile(d, FIX()); { const s = openRaw(d); migrateAll(s); s.close(); }
  const L = serverOpen(d, { cases: CASES() }); L.repo.addRequest(legacyTrialRequest({ id: 'req-after', createdAt: NOW, legacyExtra: 1 })); L.save(); const expectedR = plain(L.db.requests); const expectedT = plain(L.db.trials); L.close();
  // The source-preservation contract (C1 of the review of 6d77aa7), checked at a controlled boundary: every WAL frame is
  // checkpointed into the main file and the WAL truncated, so the file pair is stable; the bytes of the main file, the
  // WAL's frame bytes, the logical content of every table and the revision are recorded and must all be the same after
  // the tool ran (it opens the source read-only; a read-only connection may create an empty -wal/-shm pair, never a frame).
  { const s = openRaw(d); s.exec('PRAGMA wal_checkpoint(TRUNCATE)'); s.close(); }
  const sha = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : 'absent');
  const walBytes = () => (fs.existsSync(`${dbFile(d)}-wal`) ? fs.statSync(`${dbFile(d)}-wal`).size : 0);
  const sourceState = () => ({ main: sha(dbFile(d)), walBytes: walBytes(), logical: withRo(d, fullDump), saveSeq: withRo(d, (s) => meta(s, 'saveSeq')) });
  const sourceBefore = sourceState(); assert.equal(sourceBefore.walBytes, 0, 'the boundary: no frame outside the main file before the tool runs');
  const out = tempDir('s8a-rb-out');
  // S8b: the live file carries 0016; this tool refuses it (LATER_SCHEMA) and works on the S8b rollback copy — the chain — whose five blobs ride along untouched
  { const o = tempDir('s8a-rb-refused'); assert.throws(() => rollback(dbFile(d), o, { now: NOW }), (e) => e.code === 'LATER_SCHEMA' && /0016_recruitment_cases/.test(e.message)); assert.equal(fs.readdirSync(o).length, 0); }
  const s8c = tempDir('s8a-rb-s8c'); rollbackRecruitmentContactsOffersCopy(dbFile(d), s8c, { now: NOW }); // S8c first: the live file carries 0017
  const s8b = tempDir('s8a-rb-s8b'); rollbackRecruitmentCasesCopy(dbFile(s8c), s8b, { now: NOW }); const s8bState = withRo(s8b, fullDump);
  const result = rollback(dbFile(s8b), out, { now: NOW });
  assert.equal(withRo(s8b, fullDump), s8bState, 'the S8b copy (this tool\'s source) is untouched');
  assert.equal(result.requests, expectedR.length); assert.equal(result.trials, expectedT.length);
  assert.deepEqual(sourceState(), sourceBefore, 'the source is untouched: the same main-file bytes, no WAL frame written, the same logical content of every table, the same revision');
  withRo(d, (s) => assert.ok(tableExistsIn(s, 'trials'), 'the source still carries the tables (it was never rolled back in place)'));
  const c = new DatabaseSync(dbFile(out), { readOnly: true });
  assert.deepEqual(blob(c, 'requests'), expectedR); assert.deepEqual(blob(c, 'trials'), expectedT);
  for (const t of TABLES) assert.equal(tableExistsIn(c, t), false, `${t} dropped`);
  assert.equal(applied(c).includes(MIGRATION), false); assert.equal(meta(c, 'recruitmentCutover'), undefined);
  assert.equal(fkTargets(c, 'channels').some((f) => f.includes('recruitment_requests')), false, 'channels back to the 0012 definition'); assert.equal(c.prepare('SELECT count(*) AS n FROM channels').get().n, 1); assert.equal(c.prepare('SELECT count(*) AS n FROM messages').get().n, 1);
  assert.equal(c.prepare('PRAGMA foreign_key_check').all().length, 0);
  c.close();
  // the chain: the S4b-R tool refuses the 0015 file (LATER_SCHEMA) and accepts the rollback output
  const { rollbackPlayerErasureCopy } = playerErasureRollbackMod;
  const chain = tempDir('s8a-chain'); assert.throws(() => rollbackPlayerErasureCopy(dbFile(d), chain, { now: NOW }), (e) => e.code === 'LATER_SCHEMA' && /0015_recruitment/.test(e.message)); assert.equal(fs.readdirSync(chain).length, 0);
  rollbackPlayerErasureCopy(dbFile(out), chain, { now: NOW }); assert.ok(fs.existsSync(dbFile(chain)));
  // refusals
  const notCut = tempDir('s8a-notcut'); preS8aFile(notCut, FIX()); const o2 = tempDir('s8a-o2'); assert.throws(() => rollback(dbFile(notCut), o2, { now: NOW }), (e) => e.code === 'NOT_CUT_OVER'); assert.equal(fs.readdirSync(o2).length, 0);
  fs.writeFileSync(path.join(o2, 'x'), ''); assert.throws(() => rollback(dbFile(d), o2, { now: NOW }), (e) => e.code === 'OUTPUT_NOT_EMPTY');
  // an injected failure before the tool's COMMIT: no output left behind, the source still untouched
  const o3 = tempDir('s8a-o3'); assert.throws(() => rollback(dbFile(s8b), o3, { now: NOW, _failBeforeCommit: true }), /synthetic commit failure/); assert.equal(fs.readdirSync(o3).length, 0, 'the failed run removed its output'); assert.deepEqual(sourceState(), sourceBefore, 'after the injected failure the source is still untouched');
  // re-upgrade
  const up = openRaw(out); migrateAll(up); assert.deepEqual(rec.readRequests(up), expectedR); assert.deepEqual(rec.readTrials(up), expectedT); up.close();
  rm(d, out, chain, notCut, o2, o3, s8b);
});
console.log(`\n${passed} recruitment checks passed`);
