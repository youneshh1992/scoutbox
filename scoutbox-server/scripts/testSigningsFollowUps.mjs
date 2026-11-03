// S8d — signing packages, completed signings, follow-ups and outcome reports as typed tables with EXPLICIT writes
// (repositories/signingsFollowUps.mjs, migration 0018): docs/architecture/s8d-design-note.md. What this suite proves:
// the migration creates the typed tables; a snapshot save (fixtures, tools) types every field into its column,
// normalises what the note lists, stops on a row it cannot type and names every missing reference and every
// uniqueness rule with ids; the repository's operations write rows at once and return fresh records, the views are
// read-only arrays of frozen records, a unit of work rolls rows AND mirrors back (a statement failure, a real COMMIT
// failure, the deferred completion key), the completion cycle commits in one unit; the snapshot write (full, partial,
// [], junk, a retained dependant) and the live counters.
// Temporary databases only; nothing touches DATA_DIR. Run with: npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations } from '../repositories/database.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED, readTableBacked } from '../repositories/index.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir } from './coreIdentityTestFixtures.mjs';
import { p4bInvitation, minorInvitation, acceptedRequest, scheduledTrial, legacyTrialRequest, saveFixture, fixtureDb } from './recruitmentTestFixtures.mjs';
import { S8B_FIX } from './recruitmentCasesTestFixtures.mjs';
import { S8C_FIX } from './recruitmentContactsOffersTestFixtures.mjs';
import { S8D_FIX, draftPackage, completedPackage, canonicalSigning, legacySigning, followUpsFor, outcomeReport, srevision, parties, sdoc, shist, BY, SHA, SHA2, T } from './signingsFollowUpsTestFixtures.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const dbFile = (dir) => path.join(dir, 'scoutbox.db');
let counter = 9000; const nextId = (p) => `${p}-${++counter}`;
const MIGRATION = '0018_signings_follow_ups'; const S8C = '0017_recruitment_contacts_offers';
const COLLECTIONS = ['signingPackages', 'signings', 'followUps', 'outcomeReports'];
const TABLES = ['signing_packages', 'signing_revisions', 'signing_documents', 'signing_revision_parties', 'signing_history', 'signings', 'signing_parties', 'follow_ups', 'outcome_reports', 'outcome_report_confirmations'];
const EARLIER = ['recruitment_requests', 'trials', 'recruitment_cases', 'room_decisions', 'recruitment_contacts', 'recruitment_offers', 'offer_revisions'];
let mod = null;
try { mod = await import('../repositories/signingsFollowUps.mjs'); } catch { mod = null; }
const need = () => { assert.ok(mod?.createSigningsFollowUpsRepository, 'repositories/signingsFollowUps.mjs exports createSigningsFollowUpsRepository (the S8d repository module)'); return mod; };
const second = (dir) => new DatabaseSync(dbFile(dir), { readOnly: true });
const withRo = (dir, fn) => { const s = second(dir); try { return fn(s); } finally { s.close(); } };
const tableExistsIn = (s, t) => !!s.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
const plain = (v) => JSON.parse(JSON.stringify(v));
const fullDump = (s) => JSON.stringify(s.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => [r.name, s.prepare(`SELECT * FROM "${r.name}"`).all().map((x) => ({ ...x }))]));
const rowsOf = (s, t) => s.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().map((r) => ({ ...r }));
const col = (s, sql, ...p) => { const r = s.prepare(sql).get(...p); return r ? Object.values({ ...r })[0] : undefined; };
const ddlOf = (s, t) => s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)?.sql ?? null;
const openRaw = (dir) => { const s = new DatabaseSync(dbFile(dir)); s.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;'); return s; };
const S8A_FIX = () => ({ requests: [acceptedRequest(p4bInvitation(), 'trial-1'), minorInvitation(), legacyTrialRequest()], trials: [scheduledTrial()] });

/** A database holding the S8a–S8d fixtures, written by a snapshot-mode save (the tables, never blobs). `four` overrides an S8d collection (undefined omits it). */
const fixtureCollections = ({ more = {}, ...four } = {}) => {
  const fix = S8D_FIX(); const db = { ...S8B_FIX(), ...S8C_FIX(), ...S8A_FIX(), ...more };
  for (const name of COLLECTIONS) { const v = Object.hasOwn(four, name) ? four[name] : fix[name]; if (v !== undefined) db[name] = v; }
  return db;
};
const migrateAll = (s, { now = NOW } = {}) => runDataMigrations(s, DATA_MIGRATIONS, { now, context: { sessionTtlMs: TTL } });
const file = (tag, over = {}) => saveFixture(tempDir(`s8d-${tag}`), fixtureCollections(over));
/** Save the fixtures, with `over`, into a new database and expect the save refused, atomically. */
const refusedSave = (tag, over, pattern) => {
  const d = tempDir(`s8d-ref-${tag}`); const st = openStore(d); const before = fullDump(st.sqlite);
  refused(() => st.save({ savedAt: NOW, idCounter: 1000, db: fixtureDb(fixtureCollections(over)) }), pattern, tag);
  assert.equal(st.sqlite.isTransaction, false); assert.equal(fullDump(st.sqlite), before, `${tag}: nothing written`); assert.equal(st.revision(), 0);
  refused(() => st.save({ savedAt: NOW, idCounter: 1000, db: fixtureDb(fixtureCollections(over)) }), pattern, `${tag} (again)`);
  st.sqlite.close(); rm(d);
};
function serverOpen(dir, { warnings = [] } = {}) {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const loaded = store.load();
  const db = { ...loaded.db, players: [], guardians: [] };
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW, warn: (m) => warnings.push(m) });
  const snapshot = () => ({ savedAt: NOW, idCounter: 1000, db });
  return { store, layer, db, warnings, snapshot, save: () => store.save(snapshot()), unit: (w) => store.unitOfWork(w, { snapshot }), revision: () => store.revision(), repo: layer.signingsFollowUps, close: () => store.sqlite.close() };
}
function snapshotOpen(dir) {
  const store = openStore(dir); const loaded = store.load(); const db = loaded.db;
  const save = (over = {}, { omit = [] } = {}) => { const d = { ...db, ...over }; for (const k of omit) delete d[k]; return store.save({ savedAt: NOW, idCounter: 1000, db: d }); };
  return { store, db, save, revision: () => store.revision(), close: () => store.sqlite.close() };
}
const refused = (fn, pattern, label = '') => { let err = null; try { fn(); } catch (e) { err = e; } assert.ok(err, `${label}: expected a refusal`); assert.match(String(err.message), pattern, `${label}: ${err.message}`); assert.doesNotMatch(String(err.message), /agreed verbally|Regular starter|All good|open day|Adult Signup|Kid One/, `${label}: ids only, never a note, a name or a text`); return err; };
/** The typed expectation of a fixture: what the cutover and every read return (the normalisations applied). */
const typed = (name, raw) => { const t = mod[{ signingPackages: 'typeSigningPackage', signings: 'typeSigning', followUps: 'typeFollowUp', outcomeReports: 'typeOutcomeReport' }[name]](raw); assert.ok(t.ok, t.reason); return plain(t.record); };

// ------------------------------------------------------------- the cutover

test('[schema] migration 0018 is registered last and creates the ten typed STRICT tables (no lossless side column), the deferred completion key and the signing method CHECK, and broadens idempotency_keys to signing_packages; a fresh database holds no row; the step never runs twice; the fixtures written by a snapshot save read back as the typed expectation (the legacy signing\'s method and the copied ledger row normalised), with their key rows; the live player counters', () => {
  need();
  assert.equal(DATA_MIGRATIONS.at(-1)?.id, MIGRATION, 'the last registered migration'); for (const n of COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is table-backed`);
  // a fresh database: the tables exist and are empty
  const empty = tempDir('s8d-empty'); const e = openStore(empty).sqlite;
  assert.equal(e.prepare('SELECT id FROM data_migrations ORDER BY id').all().at(-1).id, MIGRATION);
  for (const t of TABLES) { assert.ok(tableExistsIn(e, t), `${t} exists`); assert.equal(e.prepare(`SELECT count(*) AS n FROM ${t}`).get().n, 0); }
  for (const t of TABLES) { assert.doesNotMatch(ddlOf(e, t), /absent_keys_json|offtype_json|extra_json/, `${t} has no lossless side column`); assert.match(ddlOf(e, t), /STRICT/); }
  assert.match(ddlOf(e, 'signing_packages'), /completion_signing_id\s+TEXT REFERENCES signings\(id\) DEFERRABLE INITIALLY DEFERRED/);
  assert.match(ddlOf(e, 'signings'), /CHECK \(method IN \('CANONICAL_COMPLETION','LEGACY_RECORDED'\)\)/);
  assert.match(ddlOf(e, 'idempotency_keys'), /'signing_packages'/); assert.match(ddlOf(e, 'idempotency_keys'), /'recruitment_offers'/);
  for (const n of COLLECTIONS) assert.equal(e.prepare('SELECT count(*) AS n FROM collections WHERE name = ?').get(n).n, 0, `no ${n} blob`);
  e.close(); rm(empty);
  // the fixtures
  const d = file('mig'); const s = openRaw(d);
  const after = fullDump(s); assert.deepEqual(migrateAll(s).ran, []); assert.equal(fullDump(s), after, 'never runs twice');
  for (const n of COLLECTIONS) assert.equal(s.prepare('SELECT count(*) AS n FROM collections WHERE name = ?').get(n).n, 0, `no ${n} blob`);
  const back = readTableBacked(s);
  assert.deepEqual(plain(back.signingPackages), [typed('signingPackages', draftPackage()), typed('signingPackages', completedPackage())]);
  assert.deepEqual(plain(back.signings), [typed('signings', canonicalSigning()), typed('signings', legacySigning())]);
  assert.deepEqual(plain(back.followUps), S8D_FIX().followUps.map((f) => typed('followUps', f)));
  assert.deepEqual(plain(back.outcomeReports), [typed('outcomeReports', outcomeReport())]);
  assert.equal(back.signings[1].method, 'LEGACY_RECORDED'); assert.deepEqual(back.signings[0].firstQualifyingInteraction, { id: 'led-1', ts: T.started - 24 * 3600 * 1000, type: 'view' }); assert.equal(back.signings[1].signingPackageId, null);
  assert.equal(col(s, "SELECT method FROM signings WHERE id = 'sign-legacy'"), 'LEGACY_RECORDED'); assert.equal(col(s, "SELECT inside_attribution_window FROM signings WHERE id = 'sign-2'"), 1);
  assert.equal(s.prepare("SELECT count(*) AS n FROM idempotency_keys WHERE owner_table = 'signing_packages'").get().n, 1 + 5, 'the start key and the five list entries of the two packages');
  assert.deepEqual(s.prepare("SELECT act, shape, key FROM idempotency_keys WHERE owner_table = 'signing_packages' AND owner_id = 'spk-2' ORDER BY position").all().map((r) => [r.act, r.shape, r.key]), [['start', 'value', 'k-start-2'], ['ready', 'list', 'k-ready-2'], ['party', 'list', 'k-party-p'], ['party', 'list', 'k-party-c'], ['complete', 'list', 'k-complete-2']]);
  assert.equal(s.prepare("SELECT count(*) AS n FROM signing_revision_parties WHERE status = 'COMPLETED'").get().n, 2); assert.equal(col(s, "SELECT evidence_document_sha256 FROM signing_revision_parties WHERE revision_id = 'spr-2' AND party_type = 'PLAYER'"), SHA);
  assert.equal(col(s, "SELECT sha256 FROM signing_documents WHERE revision_id = 'spr-2' AND kind = 'executed'"), SHA2);
  assert.deepEqual(mod.unresolvedPlayerReferences(s), { signingPackages: 0, signings: 0, followUps: 0, outcomeReports: 0 }); assert.deepEqual(mod.retainedPlayerReferences(s), { signingPackages: 0, signings: 0, followUps: 0, outcomeReports: 0 });
  s.close(); rm(d);
});

test('[snapshot][typed] a save STOPS with the id on a row the columns cannot hold — nothing written, the revision unchanged, the same save refused again: an unknown status word, a note over 400 characters, a package without a revision, a present null collection, a report whose matchesPlayed is not an integer, two confirmations by one person, an unknown party type; whereas the dead signing fields and an unknown field are dropped, not refused', () => {
  need();
  refusedSave('status', { signingPackages: [draftPackage({ status: 'OPEN' })] }, /SIGNINGS_IMPORT_BLOCKED[\s\S]*signingPackages entry #0 spk-1\.status must be one of DRAFT\|READY/);
  refusedSave('note', { signings: [canonicalSigning(), legacySigning({ note: 'x'.repeat(401) })] }, /signings entry #1 sign-legacy\.note exceeds 400 characters/);
  refusedSave('revisions', { signingPackages: [draftPackage({ revisions: [] })] }, /spk-1\.revisions must be a non-empty array/);
  refusedSave('null', { followUps: null }, /followUps: the snapshot collection must be an array/);
  refusedSave('matches', { outcomeReports: [outcomeReport({ matchesPlayed: 2.5 })] }, /outcomeReports entry #0 out-1\.matchesPlayed must be a non-negative integer or null/);
  refusedSave('twice', { outcomeReports: [outcomeReport({ confirmations: [outcomeReport().confirmations[0], outcomeReport().confirmations[0]] })] }, /out-1\.confirmations\[1\]\.by\.id duplicates pl-adult/);
  refusedSave('party-type', { signingPackages: [draftPackage({ revisions: [srevision({ requiredParties: [{ ...parties()[0], partyType: 'AGENT' }] })] })] }, /spk-1\.revisions\[0\]\.requiredParties\[0\]\.partyType must be one of PLAYER\|GUARDIAN\|CLUB_SIGNATORY/);
  // dropped, not refused
  const d = file('notes', { signings: [canonicalSigning({ cancelledAt: null, revokedAt: null, voidedAt: null, legacyFlag: true }), legacySigning()] });
  withRo(d, (s) => { const sg = readTableBacked(s).signings[0]; assert.equal(Object.hasOwn(sg, 'legacyFlag'), false); assert.equal(Object.hasOwn(sg, 'cancelledAt'), false); }); rm(d);
});

test('[snapshot] every reference and every uniqueness rule is named with ids before the engine would: a package naming a missing case / offer / organisation / staff member, a signing naming a missing package, a follow-up naming a missing signing, a report naming a missing follow-up; two completed packages per offer, two signings per package, two standing legacy signings per organisation and player, two follow-ups per signing and milestone, two reports per follow-up; and the player references (Q7a/Q8a/Q8c-a applied): a missing player id is written and counted, never refused', () => {
  need();
  refusedSave('case', { signingPackages: [draftPackage({ caseId: 'case-nowhere' }), completedPackage()] }, /SIGNINGS_REFERENCE_MISSING[\s\S]*signing_packages spk-1 → recruitment_cases case-nowhere/);
  refusedSave('offer', { signingPackages: [draftPackage({ offerId: 'rof-nowhere' }), completedPackage()] }, /signing_packages spk-1 → recruitment_offers rof-nowhere/);
  refusedSave('org', { signingPackages: [draftPackage({ orgId: 'org-nowhere' }), completedPackage()] }, /signing_packages spk-1 → orgs org-nowhere/);
  refusedSave('staff', { signingPackages: [draftPackage({ createdBy: { ...BY, id: 'usr-ghost' } }), completedPackage()] }, /signing_packages spk-1 createdBy → org_users usr-ghost/);
  refusedSave('package', { signings: [canonicalSigning({ signingPackageId: 'spk-ghost', signingRevisionId: null })] }, /signings sign-2 → signing_packages spk-ghost/);
  refusedSave('signing', { followUps: [{ ...followUpsFor()[0], signingId: 'sign-ghost' }] }, /follow_ups fup-sign-2-3m → signings sign-ghost/);
  refusedSave('followup', { outcomeReports: [outcomeReport({ followUpId: 'fup-ghost' })] }, /outcome_reports out-1 → follow_ups fup-ghost/);
  refusedSave('two-done', { signingPackages: [draftPackage(), completedPackage(), completedPackage({ id: 'spk-dup', currentRevisionId: 'spr-dup', revisions: [srevision({ id: 'spr-dup', status: 'COMPLETED', readyAt: T.ready, readyBy: BY, completedAt: T.completed, completedBy: BY, document: sdoc('sgd-dup') })], keys: { start: null }, history: [], completion: { ...completedPackage().completion, signingId: 'sign-dup' } })], signings: [canonicalSigning(), canonicalSigning({ id: 'sign-dup', signingPackageId: 'spk-dup', signingRevisionId: 'spr-dup' })] }, /SIGNINGS_UNIQUENESS[\s\S]*a completed package per offer rof-1/);
  refusedSave('two-signings', { signings: [canonicalSigning(), canonicalSigning({ id: 'sign-dup', signingPackageId: 'spk-2', signingRevisionId: 'spr-2' })] }, /a signing per package spk-2/);
  refusedSave('two-legacy', { signings: [canonicalSigning(), legacySigning(), legacySigning({ id: 'sign-legacy-2' })] }, /a standing legacy signing per organisation and player org-pro\/pl-child1/);
  refusedSave('two-fups', { followUps: [...followUpsFor(), { ...followUpsFor()[0], id: 'fup-dup' }] }, /a follow-up per signing and milestone sign-2\/3m/);
  refusedSave('two-reports', { outcomeReports: [outcomeReport(), outcomeReport({ id: 'out-dup' })] }, /a report per follow-up fup-sign-2-3m/);
  // tolerated and counted
  const d = file('tolerant', { signings: [canonicalSigning(), legacySigning({ playerId: 'pl-never-existed' })], followUps: followUpsFor().concat([{ ...followUpsFor('sign-legacy', 'pl-never-existed', T.legacy)[1], id: 'fup-gone' }]) });
  withRo(d, (s) => { assert.deepEqual(mod.unresolvedPlayerReferences(s), { signingPackages: 0, signings: 1, followUps: 1, outcomeReports: 0 }, 'the legacy signing and its follow-up'); assert.equal(col(s, "SELECT player_id FROM signings WHERE id = 'sign-legacy'"), 'pl-never-existed', 'kept verbatim'); });
  rm(d);
});

// ------------------------------------------------------------- the repository (explicit writes)

test('[repository] the four views are read-only arrays of read-only records (a push, a field assignment and a nested edit throw, naming the repository); every operation writes its rows AT ONCE — a second read-only connection sees them before the save — and returns the fresh record while the record the caller held is unchanged: insert, patch, patchRevision, addRevision, setDocument, setParty, addKey, addHistory; signings.record; followUps.schedule and patch; outcomeReports.file and addConfirmation; a save writes nothing more; the counts; a unit-less operation runs in a transaction of its own', () => {
  need();
  const d = file('repo'); const L = serverOpen(d);
  for (const n of COLLECTIONS) { assert.ok(Array.isArray(L.db[n]), `${n} is an array`); assert.throws(() => L.db[n].push({}), /written through its domain repository/, `${n}: push refused`); }
  const held = L.db.signingPackages.find((p) => p.id === 'spk-1');
  assert.throws(() => { held.status = 'READY'; }, /written through its domain repository|read only|Cannot assign/, 'a field assignment on a record throws');
  assert.throws(() => { held.revisions[0].status = 'READY'; }, /written through its domain repository|read only|Cannot assign/, 'a nested edit throws');
  assert.throws(() => { L.repo.signingPackages.byId('spk-1').status = 'READY'; }, /written through its domain repository/, 'a record a lookup returns is read-only too');
  const sp = L.repo.signingPackages; const rev0 = L.revision();
  // insert
  const pkg3 = draftPackage({ id: 'spk-3', offerId: 'rof-2', caseId: 'case-2', playerId: 'pl-child1', offerRevisionId: 'rofr-3', revisions: [srevision({ id: 'spr-3' })], currentRevisionId: 'spr-3', keys: { start: { key: 'k-start-3', fp: 'fp3' } }, history: [] });
  const inserted = sp.insert(pkg3);
  assert.equal(inserted.id, 'spk-3'); assert.throws(() => { inserted.status = 'READY'; }, /written through its domain repository/, 'a returned record is read-only'); assert.equal(L.db.signingPackages.length, 3);
  withRo(d, (s) => { assert.equal(col(s, "SELECT status FROM signing_packages WHERE id = 'spk-3'"), 'DRAFT', 'the row is committed before any save'); assert.equal(col(s, "SELECT count(*) FROM signing_revision_parties WHERE revision_id = 'spr-3'"), 2); assert.equal(col(s, "SELECT key FROM idempotency_keys WHERE owner_table = 'signing_packages' AND owner_id = 'spk-3'"), 'k-start-3'); });
  assert.throws(() => sp.insert(pkg3), /SIGNINGS_DUPLICATE/);
  assert.throws(() => sp.insert(draftPackage({ id: 'spk-bad', status: 'OPEN' })), /SIGNINGS_INPUT_INVALID[\s\S]*spk-bad\.status/);
  // patch / patchRevision / setDocument / addHistory / addKey / setParty / addRevision
  const p1 = sp.patch('spk-1', { internalNote: 'changed', expiresAt: T.started + 40 * 24 * 3600 * 1000, updatedAt: NOW, rev: 2, revAt: NOW, revBy: { userId: BY.id, name: BY.name } });
  assert.equal(p1.internalNote, 'changed'); assert.equal(held.internalNote, 'Internal: agreed verbally.', 'the held record is unchanged'); assert.equal(L.db.signingPackages.find((p) => p.id === 'spk-1').internalNote, 'changed', 'the view serves the fresh record');
  assert.throws(() => sp.patch('spk-1', { playerId: 'pl-x' }), /not patched/); assert.throws(() => sp.patch('spk-1', { internalNote: 'x'.repeat(2001) }), /SIGNINGS_INPUT_INVALID[\s\S]*internalNote exceeds 2000/);
  const p2 = sp.setDocument('spk-1', 'spr-1', 'signing', sdoc('sgd-9')); assert.equal(p2.revisions[0].document.sha256, SHA); withRo(d, (s) => assert.equal(col(s, "SELECT evidence_id FROM signing_documents WHERE revision_id = 'spr-1' AND kind = 'signing'"), 'ver-sgn-1'));
  const p3 = sp.patchRevision('spk-1', 'spr-1', { status: 'READY', readyAt: NOW, readyBy: BY }); assert.equal(p3.revisions[0].status, 'READY'); assert.equal(p3.revisions[0].readyBy.name, BY.name);
  assert.throws(() => sp.patchRevision('spk-1', 'spr-nope', { status: 'READY' }), /SIGNINGS_NOT_FOUND/);
  const p4 = sp.setParty('spk-1', 'spr-1', 'PLAYER', { status: 'COMPLETED', completedAt: NOW, completedBy: { kind: 'player', id: 'pl-adult', name: 'Adult Signup' }, method: 'PLATFORM_ACKNOWLEDGMENT', evidenceRef: { kind: 'platform_acknowledgment', id: 'sgev-9', revisionId: 'spr-1', documentSha256: SHA, at: NOW, actorKind: 'player', actorId: 'pl-adult', session: 'authenticated' } });
  assert.equal(p4.revisions[0].requiredParties[0].status, 'COMPLETED'); withRo(d, (s) => assert.equal(col(s, "SELECT evidence_ref_id FROM signing_revision_parties WHERE revision_id = 'spr-1' AND party_type = 'PLAYER'"), 'sgev-9'));
  assert.throws(() => sp.setParty('spk-1', 'spr-1', 'PLAYER', { status: 'COMPLETED', completedAt: null }), /completedAt must be set exactly on a COMPLETED party/, 'the CHECK the typer knows is applied before SQL');
  const p5 = sp.addKey('spk-1', 'ready', { key: 'k-r9', fp: 'fp', revisionId: 'spr-1', at: NOW }); assert.deepEqual(p5.keys.ready, [{ key: 'k-r9', fp: 'fp', revisionId: 'spr-1', at: NOW }]); assert.deepEqual(p5.keys.start, { key: 'k-start-1', fp: draftPackage().keys.start.fp });
  const p6 = sp.addHistory('spk-1', shist('aud-x1', NOW, 'signing_ready', { revisionId: 'spr-1', sha256: SHA })); assert.equal(p6.history.length, 2); assert.equal(p6.history[1].action, 'signing_ready');
  const p7 = sp.addRevision('spk-1', srevision({ id: 'spr-1b', revisionNumber: 2, supersedesRevisionId: 'spr-1' })); assert.equal(p7.revisions.length, 2); assert.equal(p7.revisions[1].id, 'spr-1b'); withRo(d, (s) => assert.deepEqual(s.prepare("SELECT id, position FROM signing_revisions WHERE package_id = 'spk-1' ORDER BY position").all().map((r) => [r.id, r.position]), [['spr-1', 0], ['spr-1b', 1]]));
  assert.throws(() => sp.addRevision('spk-1', srevision({ id: 'spr-1c', revisionNumber: 2 })), /revisionNumber duplicates 2/);
  // signings, follow-ups, reports
  const sg = L.repo.signings.record(legacySigning({ id: 'sign-9', playerId: 'pl-child2', note: null })); assert.equal(sg.method, 'LEGACY_RECORDED'); withRo(d, (s) => assert.equal(col(s, "SELECT method FROM signings WHERE id = 'sign-9'"), 'LEGACY_RECORDED'));
  assert.throws(() => L.repo.signings.record(legacySigning({ id: 'sign-10', playerId: 'pl-child2' })), /a standing legacy signing per organisation and player|UNIQUE/, 'the engine keeps the rule the typer cannot see across records');
  const f9 = L.repo.followUps.schedule({ id: 'fup-9', signingId: 'sign-9', playerId: 'pl-child2', orgId: 'org-pro', milestone: '3m', dueAt: NOW + 1, status: 'scheduled', notifiedAt: null, createdAt: NOW }); assert.equal(f9.status, 'scheduled');
  const f9b = L.repo.followUps.patch('fup-9', { status: 'due', notifiedAt: NOW + 2 }); assert.equal(f9b.notifiedAt, NOW + 2); assert.equal(L.db.followUps.find((f) => f.id === 'fup-9').status, 'due');
  assert.throws(() => L.repo.followUps.patch('fup-9', { milestone: '6m' }), /not patched/); assert.throws(() => L.repo.followUps.patch('fup-9', { status: 'done' }), /status must be one of scheduled\|due\|complete/);
  const r9 = L.repo.outcomeReports.file(outcomeReport({ id: 'out-9', followUpId: 'fup-9', signingId: 'sign-9', playerId: 'pl-child2', status: 'reported', confirmations: [] })); assert.equal(r9.status, 'reported');
  assert.throws(() => L.repo.outcomeReports.file(outcomeReport({ id: 'out-10', followUpId: 'fup-9', signingId: 'sign-9', playerId: 'pl-child2', confirmations: [] })), /follow_ups fup-9 already has a report/);
  const r9b = L.repo.outcomeReports.addConfirmation('out-9', { by: { kind: 'guardian', id: 'gd-primary', name: 'Primary Parent' }, agree: false, note: 'Not quite', experienceRating: 2, at: NOW + 3 }, { status: 'disputed' }); assert.equal(r9b.status, 'disputed'); assert.equal(r9b.confirmations.length, 1);
  assert.throws(() => L.repo.outcomeReports.addConfirmation('out-9', { by: { kind: 'guardian', id: 'gd-primary', name: 'Primary Parent' }, agree: true, note: null, experienceRating: null, at: NOW + 4 }), /confirmations\[1\]\.by\.id duplicates gd-primary/);
  assert.throws(() => L.repo.outcomeReports.addConfirmation('out-9', { by: { kind: 'player', id: 'pl-child2', name: 'Kid Two' }, agree: true, note: 'x'.repeat(301), experienceRating: null, at: NOW + 5 }), /note must be text of at most 300/);
  // a save writes nothing more; the revision moves only for the blobs; the counts
  const dump = Object.fromEntries(JSON.parse(withRo(d, fullDump))); L.save(); withRo(d, (s) => { for (const t of TABLES) assert.equal(JSON.stringify(rowsOf(s, t)), JSON.stringify(dump[t]), `the save rewrites no ${t} row`); });
  assert.deepEqual(L.repo.counts(), { signingPackages: 3, signings: 3, followUps: 4, outcomeReports: 2 }); assert.equal(L.revision(), rev0 + 1);
  assert.deepEqual(L.layer.report().domains.signingsFollowUps.rows, { signingPackages: 3, signings: 3, followUps: 4, outcomeReports: 2 }); assert.equal(L.layer.report().domains.signingsFollowUps.pendingWrites, 0);
  L.close();
  // a restart reads the same records
  const L2 = serverOpen(d); assert.deepEqual(plain(L2.db.signingPackages.find((p) => p.id === 'spk-1')), plain(p7)); assert.equal(L2.db.outcomeReports.find((r) => r.id === 'out-9').status, 'disputed'); L2.close(); rm(d);
});

test('[repository] the unit of work: several operations and a failure at the end — a thrown error, a refused typing inside a nested call, a REAL COMMIT failure — roll the rows AND the mirrors back (a second connection sees nothing; the views, the held references and the revision unchanged); the retry lands once; the completion cycle (the signing row, then the package\'s COMPLETED status with its completion naming the signing) commits in one unit through the deferred key, and a COMPLETED package without its signing row is refused at COMMIT; redactPlayer inside the deletion unit', () => {
  need();
  const d = file('unit'); const L = serverOpen(d); const sp = L.repo.signingPackages;
  const before = withRo(d, fullDump); const rev0 = L.revision(); const held = L.db.signingPackages.find((p) => p.id === 'spk-1'); const views = plain([L.db.signingPackages, L.db.signings, L.db.followUps, L.db.outcomeReports]);
  const work = (fail) => () => { sp.patch('spk-1', { internalNote: 'in unit' }); sp.setDocument('spk-1', 'spr-1', 'signing', sdoc('sgd-u')); L.repo.followUps.patch('fup-sign-2-6m', { status: 'due' }); L.repo.signings.record(legacySigning({ id: 'sign-u', playerId: 'pl-child2' })); if (fail === 'throw') throw new Error('synthetic failure after four writes'); if (fail === 'typed') sp.patch('spk-1', { status: 'OPEN' }); if (fail === 'commit') L.store.failCommitOfOpenTransaction(); };
  for (const fail of ['throw', 'typed', 'commit']) {
    assert.throws(() => L.unit(work(fail)), fail === 'typed' ? /SIGNINGS_INPUT_INVALID/ : fail === 'commit' ? /FOREIGN KEY constraint failed/ : /synthetic failure/, fail);
    assert.equal(withRo(d, fullDump), before, `${fail}: nothing committed`); assert.equal(L.revision(), rev0);
    assert.deepEqual(plain([L.db.signingPackages, L.db.signings, L.db.followUps, L.db.outcomeReports]), views, `${fail}: the mirrors restored`);
    assert.deepEqual(plain(L.db.signingPackages.find((p) => p.id === 'spk-1')), plain(held), `${fail}: the same record is served again`); assert.equal(L.db.signings.some((s) => s.id === 'sign-u'), false); assert.equal(L.store.sqlite.isTransaction, false);
  }
  L.unit(work(null));
  assert.equal(withRo(d, (s) => col(s, "SELECT internal_note FROM signing_packages WHERE id = 'spk-1'")), 'in unit'); assert.equal(L.db.signings.some((s) => s.id === 'sign-u'), true); assert.equal(L.revision(), rev0 + 1, 'one commit');
  // the completion cycle
  // on a second offer: rof-1 already carries the completed spk-2 (one COMPLETED package per offer, as m29 rules)
  sp.insert(draftPackage({ id: 'spk-c', caseId: 'case-2', playerId: 'pl-child1', offerId: 'rof-2', offerRevisionId: 'rofr-3', revisions: [srevision({ id: 'spr-c' })], currentRevisionId: 'spr-c', keys: { start: { key: 'k-start-c', fp: 'fpc' } }, history: [] }));
  sp.patchRevision('spk-c', 'spr-c', { status: 'IN_PROGRESS', readyAt: NOW, readyBy: BY }); sp.patch('spk-c', { status: 'IN_PROGRESS' });
  const signing = canonicalSigning({ id: 'sign-1', playerId: 'pl-child1', signingPackageId: 'spk-c', signingRevisionId: 'spr-c', offerId: 'rof-2', offerRevisionId: 'rofr-3', caseId: 'case-2' });
  assert.throws(() => L.unit(() => { sp.patchRevision('spk-c', 'spr-c', { status: 'COMPLETED', completedAt: NOW, completedBy: BY }); sp.patch('spk-c', { status: 'COMPLETED', completion: { signingId: 'sign-1', completedAt: NOW, completedBy: BY, contract: null, documentSha256: SHA, lifecycle: null } }); }), /FOREIGN KEY constraint failed/, 'a COMPLETED package whose signing row does not exist is refused at COMMIT (the deferred key)');
  assert.equal(L.db.signingPackages.find((p) => p.id === 'spk-c').status, 'IN_PROGRESS', 'restored');
  const done = L.unit(() => { L.repo.signings.record(signing); sp.patchRevision('spk-c', 'spr-c', { status: 'COMPLETED', completedAt: NOW, completedBy: BY }); return sp.patch('spk-c', { status: 'COMPLETED', completion: { signingId: 'sign-1', completedAt: NOW, completedBy: BY, contract: null, documentSha256: SHA, lifecycle: { from: 'offer_accepted', to: 'signed', at: NOW } } }); });
  assert.equal(done.status, 'COMPLETED'); assert.equal(done.completion.signingId, 'sign-1'); withRo(d, (s) => { assert.equal(col(s, "SELECT completion_signing_id FROM signing_packages WHERE id = 'spk-c'"), 'sign-1'); assert.equal(col(s, "SELECT signing_package_id FROM signings WHERE id = 'sign-1'"), 'spk-c'); assert.equal(s.prepare('PRAGMA foreign_key_check').all().length, 0); });
  // subject removal
  const touched = L.unit(() => sp.redactPlayer('pl-adult', NOW + 9)); assert.equal(touched.length, 2);
  const r = L.db.signingPackages.find((p) => p.id === 'spk-2'); assert.equal(r.subjectRemovedAt, NOW + 9); assert.equal(r.revisions[0].requiredParties[0].completedBy.name, null, 'the player\'s name nulled'); assert.equal(r.revisions[0].requiredParties[1].completedBy.name, BY.name, 'the club signatory\'s kept'); assert.equal(r.history.find((h) => h.by?.kind === 'player').by.name, null);
  L.close(); rm(d);
});

// ------------------------------------------------------------- the snapshot write (backups, restores, the persistence suites)

test('[snapshot] readTableBacked / writeTableBacked (snapshot mode): a save with the four collections supplied lands exactly (every record typed; a legacy-shaped signing normalised); a partial save retains the omitted collections whole; [] empties one; a departing signing a RETAINED follow-up still names is refused with the ids, atomically, as is a departing package a retained signing names; junk is refused with the id; the departures of a package and its offer in ONE save succeed (the S8d departures run before the S8c ones)', () => {
  need();
  const d = file('snap'); const S = snapshotOpen(d); const rev0 = S.revision();
  // a legacy-shaped signing: sign-legacy without a method, a copied ledger row — typed on the way in
  const fups = plain(S.db.followUps); const reports = plain(S.db.outcomeReports);
  S.save({ signingPackages: plain(S.db.signingPackages), signings: [canonicalSigning(), legacySigning()], followUps: fups, outcomeReports: reports }, { omit: ['requests', 'trials'] });
  assert.equal(S.revision(), rev0 + 1); withRo(d, (s) => { assert.equal(col(s, "SELECT method FROM signings WHERE id = 'sign-legacy'"), 'LEGACY_RECORDED'); assert.deepEqual(plain(readTableBacked(s).signings), [typed('signings', canonicalSigning()), typed('signings', legacySigning())]); });
  // partial: follow-ups omitted are retained whole; [] empties the reports (the follow-up's report departs; nothing names it)
  const before = withRo(d, fullDump);
  S.save({ outcomeReports: [] }, { omit: ['signingPackages', 'signings', 'followUps', 'requests', 'trials'] });
  withRo(d, (s) => { assert.equal(s.prepare('SELECT count(*) AS n FROM outcome_reports').get().n, 0); assert.equal(s.prepare('SELECT count(*) AS n FROM outcome_report_confirmations').get().n, 0); assert.equal(s.prepare('SELECT count(*) AS n FROM follow_ups').get().n, 3, 'retained'); });
  S.save({ outcomeReports: [outcomeReport()] }, { omit: ['signingPackages', 'signings', 'followUps', 'requests', 'trials'] }); assert.equal(withRo(d, fullDump).length > 0, true);
  // a departing signing still named by a RETAINED follow-up; a departing package still named by a RETAINED signing
  const mid = withRo(d, fullDump); const revMid = S.revision();
  refused(() => S.save({ signings: [legacySigning()] }, { omit: ['signingPackages', 'followUps', 'outcomeReports', 'requests', 'trials'] }), /SIGNINGS_STILL_REFERENCED[\s\S]*follow_ups fup-sign-2-3m → signings sign-2/, 'a retained follow-up');
  refused(() => S.save({ signingPackages: [draftPackage()] }, { omit: ['signings', 'followUps', 'outcomeReports', 'requests', 'trials'] }), /SIGNINGS_STILL_REFERENCED[\s\S]*signings sign-2 → signing_packages spk-2/, 'a retained signing');
  refused(() => S.save({ signings: [canonicalSigning(), legacySigning({ note: 'x'.repeat(401) })] }, { omit: ['signingPackages', 'followUps', 'outcomeReports', 'requests', 'trials'] }), /SIGNINGS_IMPORT_BLOCKED[\s\S]*sign-legacy\.note exceeds 400/, 'junk');
  refused(() => S.save({ followUps: null }, { omit: ['signingPackages', 'signings', 'outcomeReports', 'requests', 'trials'] }), /followUps: the snapshot collection must be an array/, 'a present null');
  assert.equal(withRo(d, fullDump), mid, 'every refusal atomic'); assert.equal(S.revision(), revMid);
  // the joint departure: the completed package, its signing, its follow-ups and report, and the OFFER it was opened over, in one save
  const offers = plain(S.db.recruitmentOffers).filter((o) => o.id !== 'rof-1'); const contacts = plain(S.db.recruitmentContacts).filter((c) => !(c.caseId === 'case-1'));
  S.save({ recruitmentOffers: offers, recruitmentContacts: contacts, signingPackages: [], signings: [legacySigning()], followUps: [], outcomeReports: [] }, { omit: ['requests', 'trials'] });
  withRo(d, (s) => { assert.equal(s.prepare('SELECT count(*) AS n FROM signing_packages').get().n, 0); assert.equal(s.prepare("SELECT count(*) AS n FROM recruitment_offers WHERE id = 'rof-1'").get().n, 0, 'the offer departed with its package'); assert.equal(s.prepare("SELECT count(*) AS n FROM idempotency_keys WHERE owner_table = 'signing_packages'").get().n, 0, 'the packages\' key rows went with them'); assert.equal(s.prepare('PRAGMA foreign_key_check').all().length, 0); });
  S.close(); rm(d);
});

console.log(`\n${passed} signings/follow-ups checks passed`);
