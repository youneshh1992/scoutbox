// S8c — recruitment contacts and offers as tables (repositories/recruitmentContactsOffers.mjs, migration 0017,
// repositories/recruitmentContactsOffersRollback.mjs): the bounded storage migration designed in
// docs/architecture/s8c-readiness-review.md (independently accepted at 19f5ca8 after the reviews of 854d035, a5a7ed9
// and 19f5ca8) and decided by the Founder's explicit answers of 24 October 2026: Q8c-a "Approve tolerant (Recommended)"
// (no player key; live, retained and historically missing player ids resolve, are counted and never refused, fabricated
// or deleted) and Q8c-b "Approve strict checks (Recommended)" (no guardian key; a write or cutover naming a guardian that
// is not in the FINAL guardians table is refused with ids). The lossless mapping of every writer literal (review §2);
// the cutover (migration 0017: the nine tables, idempotency_keys rebuilt with the broadened owner CHECK, every S8a/S8b
// row and thread byte-identical, the counts, every refusal with ids only); the repository (in-place mutation landing in
// the next save with the owned children rewritten and the key rows cleaned, an unchanged save writing nothing, the
// failure contracts, held nested views); the snapshot write of the review's §6 through the REAL store (P F0 R | B1 |
// A′ D′ | F2 | G: both input orders, partial saves equal to full saves, [] versus omitted, the joint contact/request
// departure, the retarget with the old request departing, the retained refusals with their tables, the FIVE offer
// pointers over the FINAL collection in both R1 directions, the true foreign-owner refusal with both owners present,
// an injected statement failure and a real COMMIT failure with byte-identical tables and the retry landing once); the
// copy-only rollback tool and the chain through the S8b and S8a tools. Temporary databases only; nothing touches
// DATA_DIR. Run with: npm test
//
// FAILING-FIRST NOTE (recorded on the unchanged 19f5ca8 tree, source-identical to the accepted 7072dd9, before the
// implementation): the tests marked [cutover] need migration 0017, the repository module and the rollback module and
// FAIL there on concrete assertions (the migration id is absent from DATA_MIGRATIONS and TABLE_BACKED; the tables do
// not exist; the blobs survive; the modules are absent). The [behaviour] test fails on the unchanged tree on a
// BEHAVIOURAL assertion: that build's whole-snapshot save removes a request a retained contact still names (and keeps
// the contact pointing at nothing), where this step refuses with the table and the ids. The [compat] checks hold on both.
// The [review 535e247 F1/F2/F3] tests were written first on the unchanged 535e247 tree and failed there on their behavioural
// assertions (review §14.1). The two [empty-string ids] tests were written first on the unchanged 9fb1bc6 tree and fail
// there on behavioural assertions — the cutover record counts 0 missing where the live report counts 5; an empty-string
// guardian id imports unrefused (review §14.2, the one reference rule).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations } from '../repositories/database.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir, s3File, openRaw, applied, blob, blobText, meta, failRunAt, FIXTURE } from './coreIdentityTestFixtures.mjs';
import { trialReportsFor } from '../repositories/playerSubrecords.mjs';
import { p4bInvitation, minorInvitation, acceptedRequest, scheduledTrial, legacyTrialRequest } from './recruitmentTestFixtures.mjs';
import { S8B_FIX } from './recruitmentCasesTestFixtures.mjs';
import { draftContact, respondedContact, nullKeyContact, externalContact, legacyContact, offtypeContact, draftOffer, acceptedOffer, declinedOffer, legacyOffer, revision, contactRequest, S8C_FIX, persisted, TX, PRIVATE_BODY, PRIVATE_NOTE } from './recruitmentContactsOffersTestFixtures.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const dbFile = (dir) => path.join(dir, 'scoutbox.db');
let counter = 9000; const nextId = (p) => `${p}-${++counter}`;
const MIGRATION = '0017_recruitment_contacts_offers'; const S8B = '0016_recruitment_cases';
const COLLECTIONS = ['recruitmentContacts', 'recruitmentOffers'];
const TABLES = ['recruitment_contacts', 'contact_attempts', 'contact_history', 'recruitment_offers', 'offer_revisions', 'offer_revision_documents', 'offer_responses', 'offer_read_receipts', 'offer_history'];
const S8AB_TABLES = ['recruitment_requests', 'request_trial_slots', 'trials', 'trial_history', 'idempotency_keys', 'recruitment_cases', 'case_history', 'room_comments', 'room_decisions'];
let rco = null; let rollbackMod = null;
try { rco = await import('../repositories/recruitmentContactsOffers.mjs'); } catch { rco = null; }
try { rollbackMod = await import('../repositories/recruitmentContactsOffersRollback.mjs'); } catch { rollbackMod = null; }
const s8bRollbackMod = await import('../repositories/recruitmentCasesRollback.mjs');
const chainMod = await import('../repositories/rollbackChain.mjs'); // S8d: the S8d step-back then the S8c tool, as one link
const needRco = () => { assert.ok(rco?.createRecruitmentContactsOffersRepository, 'repositories/recruitmentContactsOffers.mjs exports createRecruitmentContactsOffersRepository (the S8c repository module)'); return rco; };
const needRollback = () => { assert.ok(rollbackMod?.rollbackRecruitmentContactsOffersCopy, 'repositories/recruitmentContactsOffersRollback.mjs exports rollbackRecruitmentContactsOffersCopy (the S8c rollback module)'); return rollbackMod.rollbackRecruitmentContactsOffersCopy; };
const second = (dir) => new DatabaseSync(dbFile(dir), { readOnly: true });
const withRo = (dir, fn) => { const s = second(dir); try { return fn(s); } finally { s.close(); } };
const tableExistsIn = (s, t) => !!s.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
const plain = (v) => JSON.parse(JSON.stringify(v));
const fullDump = (s) => JSON.stringify(s.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => [r.name, s.prepare(`SELECT * FROM "${r.name}"`).all().map((x) => ({ ...x }))]));
const allDump = (s) => JSON.stringify(Object.fromEntries([...TABLES, ...S8AB_TABLES].filter((t) => tableExistsIn(s, t)).map((t) => [t, s.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().map((r) => ({ ...r }))])));
/** The nine S8c tables and the S8c key rows as an exact dump (rowid order). */
const s8cDump = (s) => JSON.stringify([...TABLES.map((t) => s.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().map((r) => ({ ...r }))), s.prepare("SELECT * FROM idempotency_keys WHERE owner_table IN ('recruitment_contacts', 'recruitment_offers') ORDER BY rowid").all().map((r) => ({ ...r }))]);
const canon = (s) => JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(allDump(s))).map(([t, rows]) => [t, rows.map(({ seq, ...r }) => JSON.stringify(r)).sort()])));
const ddlOf = (s, t) => s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)?.sql ?? null;
const fkTargets = (s, table) => s.prepare(`PRAGMA foreign_key_list(${table})`).all().map((r) => `${r.from}->${r.table}(${r.to}) ${r.on_delete}`);
const col = (s, sql, ...p) => { const r = s.prepare(sql).get(...p); return r ? Object.values({ ...r })[0] : undefined; };
const S8A_FIX = () => ({ requests: [acceptedRequest(p4bInvitation(), 'trial-1'), minorInvitation(), legacyTrialRequest()], trials: [scheduledTrial()] });
const CHANNEL = { id: 'chan-1', requestId: 'req-p4b', playerId: 'pl-adult', playerName: 'Adult Signup', orgId: 'org-pro', orgName: 'Eastport FC', orgVerified: true, scoutName: 'Maria', scoutRole: 'Head of Recruitment', counterparty: 'player', guardianId: null, createdAt: NOW - 1000, messages: [], readBy: { org: null, counterparty: null } };

/** A file at S8b (0001–0016 applied) carrying the two S8c blobs the 7072dd9 build wrote beside the S8a/S8b tables. */
function preS8cFile(dir, { requests, trials, rawBlobs, more = {}, ...two } = {}) {
  const fix = S8C_FIX(); const extra = { ledger: [], vouches: [], notifications: [], dispatches: [], channels: [CHANNEL], ...S8B_FIX(), ...more };
  for (const name of COLLECTIONS) { const v = Object.hasOwn(two, name) ? two[name] : fix[name]; if (v !== undefined) extra[name] = v; }
  const s8a = S8A_FIX(); extra.requests = requests === undefined ? s8a.requests : requests; extra.trials = trials === undefined ? s8a.trials : trials;
  const players = FIXTURE().players.map((p) => ({ ...p, trialReports: trialReportsFor(Array.isArray(extra.trials) ? plain(extra.trials) : [], p.id) }));
  s3File(dir, { players, extra, rawBlobs });
  const s = openRaw(dir); runDataMigrations(s, DATA_MIGRATIONS.filter((m) => m.id < MIGRATION), { now: NOW, context: { sessionTtlMs: TTL } }); s.close();
}
const migrateAll = (s, { now = NOW } = {}) => runDataMigrations(s, DATA_MIGRATIONS, { now, context: { sessionTtlMs: TTL } });
const file = (tag, over = {}) => { const d = tempDir(`s8c-${tag}`); preS8cFile(d, over); const s = openRaw(d); migrateAll(s); s.close(); return d; };
function serverOpen(dir, { warnings = [] } = {}) {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const loaded = store.load();
  const db = { ...loaded.db, players: [], guardians: [] };
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW, warn: (m) => warnings.push(m) });
  const snapshot = () => ({ savedAt: NOW, idCounter: 1000, db });
  return { store, layer, db, warnings, snapshot, save: () => store.save(snapshot()), revision: () => store.revision(), repo: layer.recruitmentContactsOffers, recruitment: layer.recruitment, close: () => store.sqlite.close() };
}
function snapshotOpen(dir) {
  const store = openStore(dir); const loaded = store.load(); const db = loaded.db;
  const save = (over = {}, { omit = [] } = {}) => { const d = { ...db, ...over }; for (const k of omit) delete d[k]; return store.save({ savedAt: NOW, idCounter: 1000, db: d }); };
  return { store, db, save, revision: () => store.revision(), close: () => store.sqlite.close() };
}
const refused = (fn, pattern, label = '') => { let err = null; try { fn(); } catch (e) { err = e; } assert.ok(err, `${label}: expected a refusal`); assert.match(String(err.message), pattern, `${label}: ${err.message}`); assert.doesNotMatch(String(err.message), /next season|winter window|Yes please|Too far|Primary Parent|Adult Signup/, `${label}: ids only, never a body, a note, a reply or a name`); return err; };
/** An offer whose pointer of `kind` carries `value`; `owns` adds a revision / response id the offer owns. */
const KINDS = ['current_revision_id', 'response_id', 'supersedes_revision_id', 'superseded_by_revision_id', 'discarded_by_response_id'];
const isResp = (k) => k === 'response_id' || k === 'discarded_by_response_id';
function offerPointing(id, kind, target, { caseId = 'case-1', playerId = 'pl-adult', owns = null } = {}) {
  const rev0 = revision({ id: `${id}-r0`, status: 'DRAFT' }); if (kind === 'response_id') rev0.response = { id: target }; if (kind === 'supersedes_revision_id') rev0.supersedesRevisionId = target; if (kind === 'superseded_by_revision_id') rev0.supersededByRevisionId = target; if (kind === 'discarded_by_response_id') rev0.discardedByResponseId = target;
  const o = draftOffer({ id, caseId, playerId, currentRevisionId: kind === 'current_revision_id' ? target : `${id}-r0`, revisions: [rev0], history: [] });
  if (owns) { if (isResp(kind)) o.responses = [{ id: owns, revisionId: `${id}-r0`, responseType: 'accepted', actorType: 'player', actorId: playerId, actorName: null, forPlayerId: playerId, occurredAt: TX.accepted, reason: null, clientKey: null }]; else o.revisions.push(revision({ id: owns, revisionNumber: 2 })); }
  return o;
}
const pointerCol = (s, offerId, kind) => (kind === 'current_revision_id' ? col(s, 'SELECT current_revision_id FROM recruitment_offers WHERE id = ?', offerId) : col(s, `SELECT ${kind} FROM offer_revisions WHERE offer_id = ? AND position = 0`, offerId));

// ------------------------------------------------------------- the migration
test('[cutover] migration 0017 is registered last and, on an S8b file, creates the nine contact and offer tables and rebuilds idempotency_keys with the owner CHECK broadened to the two parents while every S8a/S8b row, key row, the S8b key-format marker, thread and case survives byte for byte; imports the two blobs row for row and retires them; records counts only (the Q8c-a player counts, the unresolved pointers per kind, the dangling decision ids); reruns are no-ops; a file without the blobs creates the tables and imports nothing — never from the seed or memory', () => {
  assert.equal(DATA_MIGRATIONS.at(-2)?.id, MIGRATION, 'migration 0017 is registered after 0016; 0018_signings_follow_ups (S8d) follows it'); for (const n of COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is table-backed`);
  const d = tempDir('s8c-mig'); preS8cFile(d);
  const s = openRaw(d);
  assert.ok(applied(s).includes(S8B)); for (const n of COLLECTIONS) assert.ok(Array.isArray(blob(s, n)), `${n} blob before`);
  const s8abRows = () => JSON.stringify(S8AB_TABLES.map((t) => (t === 'idempotency_keys' ? s.prepare("SELECT * FROM idempotency_keys WHERE owner_table NOT IN ('recruitment_contacts', 'recruitment_offers') ORDER BY owner_table, owner_id, position").all() : s.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())));
  const before = s8abRows(); const marker = meta(s, 'recruitmentCasesKeyFormat'); const seq = meta(s, 'saveSeq');
  migrateAll(s);
  assert.equal(applied(s).at(-2), MIGRATION); assert.equal(applied(s).at(-1), '0018_signings_follow_ups', 'S8d follows (it imports nothing from this fixture)'); for (const t of TABLES) assert.ok(tableExistsIn(s, t), `${t} exists`);
  assert.match(ddlOf(s, 'idempotency_keys'), /'recruitment_contacts', 'recruitment_offers'/, 'the broadened owner CHECK');
  assert.equal(s8abRows(), before, 'every S8a/S8b row (the S8a/S8b key rows included) byte-identical'); assert.equal(meta(s, 'recruitmentCasesKeyFormat'), marker, 'the S8b marker untouched'); assert.equal(meta(s, 'saveSeq'), seq, 'the migration is not a save');
  for (const n of COLLECTIONS) assert.equal(blob(s, n), undefined, `${n} blob retired`);
  assert.equal(col(s, 'SELECT count(*) FROM recruitment_contacts'), 6); assert.equal(col(s, 'SELECT count(*) FROM recruitment_offers'), 4); assert.equal(col(s, 'SELECT count(*) FROM offer_revisions'), 6); assert.equal(col(s, 'SELECT count(*) FROM offer_revision_documents'), 3); assert.equal(col(s, 'SELECT count(*) FROM contact_history'), 9); assert.equal(col(s, 'SELECT count(*) FROM offer_read_receipts'), 2);
  assert.deepEqual(s.prepare("SELECT owner_id, act, key FROM idempotency_keys WHERE owner_table = 'recruitment_offers' AND owner_id = 'rof-2' ORDER BY position").all().map((r) => r.key), ['k-o2', 'k-issue-1', 'k-issue-2', 'k-rev-2', 'k-rev-3'], 'the offer keys as rows in act order');
  assert.equal(col(s, "SELECT count(*) FROM idempotency_keys WHERE owner_table = 'recruitment_contacts' AND owner_id = 'rct-3'"), 1, 'the null-key send act is held on the row, not a row');
  assert.deepEqual(fkTargets(s, 'recruitment_contacts').filter((f) => /request|case|orgs/.test(f)).sort(), ['case_id->recruitment_cases(id) RESTRICT', 'org_id->orgs(id) RESTRICT', 'request_id->recruitment_requests(id) RESTRICT'].sort(), 'the real keys'); assert.ok(fkTargets(s, 'contact_history').includes('contact_id->recruitment_contacts(id) RESTRICT')); assert.ok(fkTargets(s, 'offer_revisions').includes('offer_id->recruitment_offers(id) CASCADE'));
  const cut = JSON.parse(meta(s, 'recruitmentContactsOffersCutover'));
  assert.equal(cut.recruitmentContacts.imported, 6); assert.equal(cut.recruitmentOffers.imported, 4); assert.equal(cut.recruitmentContacts.withAbsentKeys, 4, 'rct-5 (pre-P5.6E: contactMode and routingSnapshot absent) and the three lifecycle literals whose other branch\'s keys are absent (rct-2, rct-3, rct-4) — absence is recorded at every level'); assert.equal(cut.recruitmentOffers.withAbsentKeys, 4, 'every offer: subjectRemovedAt is ABSENT until the deletion unit sets it (rof-1, rof-3), rof-2\'s lifecycle literal lacks the refusal branch\'s keys, rof-4 has no keys map and no readReceipts list'); assert.equal(cut.recruitmentContacts.withOfftypeValues, 6, 'every contact carries at least one null object (recipient, routingSnapshot, emailCopy, response, …), which the engine records in offtype_json as the S8a/S8b engine does; rct-8 the genuinely off-type values too'); assert.equal(cut.recruitmentContacts.withExtraFields, 1, 'rct-5\'s unknown top-level key (the held key acts are not extra fields)');
  assert.deepEqual(cut.unresolvedPointers, { current_revision_id: 1, response_id: 0, supersedes_revision_id: 0, superseded_by_revision_id: 0, discarded_by_response_id: 0 }, 'rof-4\'s missing current revision counted, never refused'); assert.equal(cut.danglingDecisionIds, 1, 'rof-2\'s decision id names no decision: counted');
  assert.equal(cut.players.missing, 3, 'pl-gone-long-ago on rct-5, on rof-4 and on rof-4\'s recipient snapshot (Q8c-a: counted, never refused)'); assert.ok(cut.players.live >= 10); assert.doesNotMatch(JSON.stringify(cut), /next season|Yes please|Too far|winter/, 'counts only');
  assert.equal(s.prepare('PRAGMA foreign_key_check').all().length, 0);
  const again = migrateAll(s); assert.deepEqual(again.ran, []); s.close();
  const empty = tempDir('s8c-empty'); preS8cFile(empty, { recruitmentContacts: undefined, recruitmentOffers: undefined }); const e = openRaw(empty); for (const n of COLLECTIONS) assert.equal(blob(e, n), undefined); migrateAll(e); assert.equal(col(e, 'SELECT count(*) FROM recruitment_contacts'), 0); assert.equal(col(e, 'SELECT count(*) FROM recruitment_offers'), 0); assert.equal(JSON.parse(meta(e, 'recruitmentContactsOffersCutover')).recruitmentContacts.imported, 0); e.close();
  rm(d, empty);
});

test('[cutover] the mapping is lossless for every writer shape: the draft, the sent/answered contact (attempts and history in order, the agent routing, the e-mail copy, the reply), the null-key send (held on the row), the external record (a prototype-named own key in a detail), the pre-P5.6E literal (contactMode and routingSnapshot ABSENT, an unknown key kept), off-type values; the draft offer, the issued/revised/accepted offer (documents per revision, the discarded draft with discardedByResponseId present on it only, receipts, the share, the nulled names, subjectRemovedAt), the declined offer (a legacy non-array keys.issue, the lifecycle `allowed` list), the legacy offer (keys and readReceipts ABSENT, an off-type recipient message, the missing current revision kept verbatim)', () => {
  const d = file('map'); needRco(); const s = openRaw(d);
  const fix = S8C_FIX(); const backC = rco.readContacts(s); const backO = rco.readOffers(s);
  assert.deepEqual(plain(backC), persisted(fix.recruitmentContacts), 'every contact key for key, in insertion order'); assert.deepEqual(plain(backO), persisted(fix.recruitmentOffers), 'every offer key for key');
  const c5 = backC.find((c) => c.id === 'rct-5'); assert.equal(Object.hasOwn(c5, 'contactMode'), false); assert.equal(Object.hasOwn(c5, 'routingSnapshot'), false); assert.equal(c5.legacyFlag, 'kept');
  const c3 = backC.find((c) => c.id === 'rct-3'); assert.equal(c3.keys.send.key, null); assert.equal(c3.keys.send.fp, '{"contactId":"rct-3"}');
  assert.equal(Object.hasOwn(backC.find((c) => c.id === 'rct-4').history[0].detail, '__proto__'), true, 'the prototype-named own key survives as data');
  const c8 = backC.find((c) => c.id === 'rct-8'); assert.equal(c8.subject, 42); assert.equal(c8.rev, '1'); assert.deepEqual(c8.attempts, { not: 'a list' }); assert.deepEqual(c8.keys.strange, []);
  const o2 = backO.find((o) => o.id === 'rof-2'); assert.deepEqual(o2.revisions.map((r) => r.id), ['rofr-2', 'rofr-3', 'rofr-4']); assert.equal(o2.revisions[2].discardedByResponseId, 'rofa-1'); assert.equal(Object.hasOwn(o2.revisions[0], 'discardedByResponseId'), false); assert.equal(o2.revisions[0].documents[1].label, null); assert.equal(o2.responses[0].actorName, null); assert.equal(o2.subjectRemovedAt, TX.removed);
  const o3 = backO.find((o) => o.id === 'rof-3'); assert.equal(Array.isArray(o3.keys.issue), false); assert.equal(o3.keys.issue.key, 'legacy-issue'); assert.deepEqual(o3.lifecycle.allowed, ['offer_accepted', 'withdrawn']);
  const o4 = backO.find((o) => o.id === 'rof-4'); assert.equal(Object.hasOwn(o4, 'keys'), false); assert.equal(Object.hasOwn(o4, 'readReceipts'), false); assert.deepEqual(o4.revisions[0].recipientMessage, ['not', 'text']); assert.equal(o4.currentRevisionId, 'rofr-missing', '[review 854d035 F1] the missing current target kept verbatim');
  assert.equal(col(s, "SELECT typeof(delivered_at) FROM recruitment_contacts WHERE id = 'rct-2'"), 'integer'); assert.equal(col(s, "SELECT recipient_guardian_id FROM recruitment_contacts WHERE id = 'rct-2'"), 'gd-primary'); assert.equal(col(s, "SELECT internal_note FROM offer_revisions WHERE id = 'rofr-1'"), PRIVATE_NOTE); assert.equal(col(s, "SELECT body FROM recruitment_contacts WHERE id = 'rct-1'"), PRIVATE_BODY);
  s.close(); rm(d);
});

test('[cutover] the import refuses with ids only — nothing written, the blobs, the S8a/S8b tables and the record untouched, the next boot refuses the same way: a contact naming a case that is not in recruitment_cases; a contact naming a request that is not in recruitment_requests; a contact/request pair that disagrees; a guardian that is not in the guardians table (Q8c-b: strict); a present JSON null blob; an offer pointer naming a row that belongs to ANOTHER offer (both present); whereas an UNRESOLVED pointer (no owner anywhere) and a historically missing player import and are counted (Q8c-a)', () => {
  const tryImport = (tag, over, pattern) => {
    const d = tempDir(`s8c-ref-${tag}`); preS8cFile(d, over); const s = openRaw(d); const before = fullDump(s); const bl = COLLECTIONS.map((n) => blobText(s, n));
    refused(() => migrateAll(s), pattern, tag); assert.equal(s.isTransaction, false); assert.equal(fullDump(s), before, `${tag}: nothing written`); assert.deepEqual(COLLECTIONS.map((n) => blobText(s, n)), bl); assert.equal(applied(s).includes(MIGRATION), false);
    refused(() => migrateAll(s), pattern, `${tag} (again)`); s.close(); rm(d);
  };
  tryImport('case', { recruitmentContacts: [draftContact({ caseId: 'case-nowhere' })] }, /CONTACTS_OFFERS_IMPORT_BLOCKED[\s\S]*CONTACT_OFFER_CASE_MISSING[\s\S]*rct-1 → case-nowhere/);
  tryImport('request', { recruitmentContacts: [nullKeyContact({ requestId: 'req-nowhere' })] }, /CONTACT_REQUEST_DANGLING[\s\S]*rct-3 → req-nowhere/);
  tryImport('pair', { recruitmentContacts: [nullKeyContact({ requestId: 'req-c9' })], requests: [...S8A_FIX().requests, contactRequest('req-c9', 'rct-other')] }, /CONTACT_REQUEST_MISMATCH[\s\S]*contact rct-3 → request req-c9 → contact rct-other/);
  tryImport('guardian', { recruitmentContacts: [respondedContact({ recipient: { type: 'guardian', playerId: 'pl-child1', guardianId: 'gd-nowhere', minor: true } })] }, /CONTACTS_OFFERS_GUARDIAN_MISSING[\s\S]*rct-2 → gd-nowhere[\s\S]*Q8c-b/);
  tryImport('guardian-offer', { recruitmentOffers: [acceptedOffer({ responses: [{ ...acceptedOffer().responses[0], actorId: 'gd-ghost' }] })] }, /CONTACTS_OFFERS_GUARDIAN_MISSING[\s\S]*rof-2 → gd-ghost/);
  tryImport('null', { rawBlobs: { recruitmentOffers: 'null' } }, /CONTACTS_OFFERS_IMPORT_BLOCKED: the recruitmentOffers blob must be an array of entries \(got null\)/);
  tryImport('foreign', { recruitmentOffers: [draftOffer({ id: 'rof-a', currentRevisionId: 'rofr-b' }), draftOffer({ id: 'rof-b', currentRevisionId: 'rofr-b', revisions: [revision({ id: 'rofr-b' })] })] }, /OFFER_CHAIN_BROKEN[\s\S]*rof-a\/rof-a current_revision_id→rofr-b owned by offer rof-b/);
  tryImport('f2b', { recruitmentOffers: [acceptedOffer(), draftOffer({ revisions: [revision({ discardedByResponseId: 'rofa-1' })] })] }, /OFFER_CHAIN_BROKEN[\s\S]*rof-1\/rofr-1 discarded_by_response_id→rofa-1 owned by offer rof-2/);
  // tolerated and counted
  const d = file('tolerant', { recruitmentOffers: [legacyOffer(), draftOffer({ playerId: 'pl-never-existed' })], recruitmentContacts: [legacyContact()] }); const s = openRaw(d);
  const cut = JSON.parse(meta(s, 'recruitmentContactsOffersCutover')); assert.equal(cut.unresolvedPointers.current_revision_id, 1); assert.equal(cut.players.missing, 4); assert.equal(col(s, "SELECT current_revision_id FROM recruitment_offers WHERE id = 'rof-4'"), 'rofr-missing');
  assert.deepEqual(rco.unresolvedPlayerReferences(s), { recruitmentContacts: 1, recruitmentOffers: 3 }, 'every occurrence, as the cutover counts (the review of 535e247, F3): the legacy contact\'s parent; the legacy offer\'s parent and its revision recipient, the pl-never-existed parent'); assert.equal(1 + 3, cut.players.missing, 'the live counts and the cutover count agree'); assert.deepEqual(rco.unresolvedPointerReferences(s).current_revision_id, 1); s.close(); rm(d);
});

// ------------------------------------------------------------- the repository
test('[cutover] the repository: the two views are read-only ARRAYS of plain mutable records; addContact/addOffer land in the next save as rows with their children (a missing case refused with ids); in-place mutations (a send: status, recipient, request, attempts, routing, e-mail copy, lifecycle, history, the send key; a reply; the e-mail-copy outcome; an issue, a revision with documents, a receipt, a share, an acceptance discarding the draft beside it; the deletion unit\'s nulled words) land in the next save with the children rewritten in list order and the key rows cleaned; an unchanged save writes no S8c row; the exports are detached copies; a reopen serves the same records', () => {
  const dir = file('repo'); const L = serverOpen(dir);
  for (const n of COLLECTIONS) { assert.ok(Array.isArray(L.db[n]), `${n} is an array view`); assert.throws(() => L.db[n].push({ id: 'x' }), /repositor/i, `${n}: push refused`); assert.throws(() => { L.db[n][0] = {}; }, /repositor/i); }
  needRco(); const R = L.repo; assert.ok(R, 'attachDataLayer returns the recruitmentContactsOffers repository'); assert.equal(L.db.recruitmentContacts.length, 6); assert.equal(L.db.recruitmentOffers.length, 4);
  refused(() => R.addContact(draftContact({ id: 'rct-x', caseId: 'case-nowhere' })), /CONTACT_OFFER_CASE_MISSING.*rct-x.*case-nowhere/, 'a missing case'); assert.throws(() => R.addOffer({ id: 'rof-x' }), /writer's literal/);
  const c = R.addContact(draftContact({ id: 'rct-new', subject: 'New', history: [], keys: { create: null, send: null, record: null } })); assert.equal(c, L.db.recruitmentContacts.at(-1), 'the record itself is kept');
  const o = R.addOffer(draftOffer({ id: 'rof-new', revisions: [revision({ id: 'rofr-new' })], currentRevisionId: 'rofr-new', history: [] })); assert.equal(o, L.db.recruitmentOffers.at(-1));
  // the send of rct-new (contactRoutes.mjs:453-508) with its NEW request through the S8a repository, in ONE save
  L.recruitment.addRequest(contactRequest('req-new', 'rct-new'));
  Object.assign(c, { status: 'delivered', recipient: { type: 'player', playerId: 'pl-adult', guardianId: null, minor: false }, routingSnapshot: { at: NOW, mode: 'player_only', player: true, guardian: false, agent: null, honest: 'x' }, sentBy: c.createdBy, sentAt: NOW, deliveredAt: NOW, requestId: 'req-new', emailCopy: { state: 'queued', to: 'guardian', outboxId: null, at: NOW }, lifecycle: { applied: true, from: 'contact_planned', to: 'contacted', at: NOW }, rev: 2, revAt: NOW });
  c.attempts.push({ at: NOW, ok: true, code: null }); c.keys.send = { key: 'k-send-new', fp: '{"contactId":"rct-new"}' }; c.history.push({ id: 'aud-new-1', at: NOW, action: 'contact_sent', by: c.createdBy, detail: { channel: 'in_app', recipientType: 'player', attempt: 1, mode: 'player_only', agentParty: false } });
  const r0 = L.revision(); L.save(); assert.equal(L.revision(), r0 + 1);
  withRo(dir, (s) => {
    assert.deepEqual(plain(s.prepare("SELECT status, request_id, recipient_type, email_copy_state, lifecycle_to, rev FROM recruitment_contacts WHERE id = 'rct-new'").get()), { status: 'delivered', request_id: 'req-new', recipient_type: 'player', email_copy_state: 'queued', lifecycle_to: 'contacted', rev: 2 });
    assert.equal(col(s, "SELECT count(*) FROM contact_attempts WHERE contact_id = 'rct-new'"), 1); assert.equal(col(s, "SELECT action FROM contact_history WHERE contact_id = 'rct-new' AND position = 0"), 'contact_sent'); assert.equal(col(s, "SELECT key FROM idempotency_keys WHERE owner_table = 'recruitment_contacts' AND owner_id = 'rct-new' AND act = 'send'"), 'k-send-new');
    assert.equal(col(s, "SELECT contact_id FROM recruitment_requests WHERE id = 'req-new'"), 'rct-new', 'the pair in the tables'); assert.equal(col(s, "SELECT current_revision_id FROM recruitment_offers WHERE id = 'rof-new'"), 'rofr-new');
  });
  // the reply (the response hook), the e-mail-copy outcome (its own later save); the offer: issue, revise with a document, a receipt, a share, the acceptance discarding the draft beside it
  c.status = 'responded'; c.respondedAt = NOW + 1; c.response = { kind: 'accepted', message: 'Yes please', by: 'player', at: NOW + 1 }; c.rev = 3; c.history.push({ id: 'aud-new-2', at: NOW + 1, action: 'contact_responded', by: { kind: 'player', name: 'Player' }, detail: { kind: 'accepted' } });
  L.save(); c.emailCopy = { state: 'accepted_by_provider', to: 'guardian', outboxId: 'mail-9', at: NOW + 2 }; L.save();
  const rv1 = o.revisions[0]; Object.assign(rv1, { status: 'ISSUED', issuedAt: NOW, issuedBy: o.createdBy, expiresAt: NOW + 86_400_000, recipientSnapshot: { type: 'player', playerId: 'pl-adult', guardianId: null, minor: false, at: NOW }, rev: 2 }); o.status = 'ISSUED'; o.keys.issue.push({ key: 'k-issue-new', revisionId: 'rofr-new' }); o.history.push({ id: 'aud-new-3', at: NOW, action: 'offer_issued', by: { kind: 'org', id: 'usr-1', name: 'Maria' }, detail: { revisionId: 'rofr-new' } });
  const rv2 = revision({ id: 'rofr-new-2', revisionNumber: 2, documents: [{ id: 'rofd-new', evidenceId: 'ver-9', label: 'Sheet', mime: 'application/pdf', bytes: 10 }], supersedesRevisionId: 'rofr-new', createdAt: NOW + 3 }); o.revisions.push(rv2); o.currentRevisionId = 'rofr-new-2'; o.keys.revise.push({ key: 'k-rev-new', revisionId: 'rofr-new-2' });
  o.readReceipts.push({ revisionId: 'rofr-new', viewerKind: 'player', viewerId: 'pl-adult', firstViewedAt: NOW + 4 }); o.agentShare = { agentUserId: 'usr-1', agreementId: 'rep-7', at: NOW + 5, by: { kind: 'player', id: 'pl-adult' } };
  L.save();
  withRo(dir, (s) => {
    assert.equal(col(s, "SELECT status FROM offer_revisions WHERE offer_id = 'rof-new' AND position = 0"), 'ISSUED'); assert.equal(col(s, "SELECT supersedes_revision_id FROM offer_revisions WHERE offer_id = 'rof-new' AND position = 1"), 'rofr-new'); assert.equal(col(s, "SELECT evidence_id FROM offer_revision_documents WHERE offer_id = 'rof-new' AND revision_position = 1"), 'ver-9');
    assert.equal(col(s, "SELECT count(*) FROM offer_read_receipts WHERE offer_id = 'rof-new'"), 1); assert.equal(col(s, "SELECT agent_share_user_id FROM recruitment_offers WHERE id = 'rof-new'"), 'usr-1');
    assert.deepEqual(s.prepare("SELECT act, key FROM idempotency_keys WHERE owner_table = 'recruitment_offers' AND owner_id = 'rof-new' ORDER BY position").all().map((r) => [r.act, r.key]), [['create', 'k-o1'], ['issue', 'k-issue-new'], ['revise', 'k-rev-new']], 'the key rows rewritten, never duplicated');
    assert.equal(col(s, "SELECT response_message FROM recruitment_contacts WHERE id = 'rct-new'"), 'Yes please'); assert.equal(col(s, "SELECT email_copy_outbox_id FROM recruitment_contacts WHERE id = 'rct-new'"), 'mail-9');
  });
  // the acceptance (m28/index.mjs:742-772): revision 1 answered, the draft revision 2 discarded by the response; the deletion unit's edits (server.mjs:4294; m28 :894-896)
  o.responses.push({ id: 'rofa-new', revisionId: 'rofr-new', responseType: 'accepted', actorType: 'player', actorId: 'pl-adult', actorName: 'Adult Signup', forPlayerId: 'pl-adult', occurredAt: NOW + 6, reason: null, clientKey: 'ck-new' });
  rv1.status = 'ACCEPTED'; rv1.respondedAt = NOW + 6; rv1.response = { id: 'rofa-new' }; rv2.status = 'WITHDRAWN'; rv2.withdrawnAt = NOW + 6; rv2.discardedByResponseId = 'rofa-new'; o.status = 'ACCEPTED'; o.currentRevisionId = 'rofr-new';
  c.response = { ...c.response, message: null }; o.responses[0].actorName = null; o.subjectRemovedAt = NOW + 7;
  L.save();
  withRo(dir, (s) => { assert.equal(col(s, "SELECT response_id FROM offer_revisions WHERE id = 'rofr-new'"), 'rofa-new'); assert.equal(col(s, "SELECT discarded_by_response_id FROM offer_revisions WHERE id = 'rofr-new-2'"), 'rofa-new'); assert.equal(col(s, "SELECT response_message FROM recruitment_contacts WHERE id = 'rct-new'"), null); assert.equal(col(s, "SELECT actor_name FROM offer_responses WHERE id = 'rofa-new'"), null); assert.equal(col(s, "SELECT subject_removed_at FROM recruitment_offers WHERE id = 'rof-new'"), NOW + 7); });
  const before = withRo(dir, allDump); const r1 = L.revision(); L.save(); assert.equal(withRo(dir, allDump), before, 'an unchanged save rewrites nothing'); assert.equal(L.revision(), r1 + 1); assert.deepEqual(R.pending(), { recruitmentContacts: 0, recruitmentOffers: 0 });
  const exported = R.exportAll(); assert.notEqual(exported.recruitmentContacts.find((x) => x.id === 'rct-new'), c); assert.deepEqual(plain(exported.recruitmentContacts), plain(L.db.recruitmentContacts)); assert.deepEqual(plain(exported.recruitmentOffers), plain(L.db.recruitmentOffers));
  L.close(); const again = serverOpen(dir); assert.deepEqual(plain(again.db.recruitmentContacts), plain(exported.recruitmentContacts)); assert.deepEqual(plain(again.db.recruitmentOffers), plain(exported.recruitmentOffers)); assert.equal(again.db.recruitmentOffers.find((x) => x.id === 'rof-new').revisions[1].discardedByResponseId, 'rofa-new'); again.close(); rm(dir);
});

test('[cutover] the two failure contracts: a failed ORDINARY save (a statement failure, then a failure of the REAL COMMIT) leaves the tables and the revision unchanged, keeps every pending change in memory and lands it ONCE on the next save; an aborted UNIT OF WORK (a joined failure, a real COMMIT failure) rolls the tables back AND restores the pre-unit graph in place — held nested views (a revisions list, a response object, a history list) read the pre-unit values; edits pending before the unit stay pending; the retry lands once', () => {
  const dir = file('fail'); const L = serverOpen(dir); needRco(); const R = L.repo;
  const c2 = L.db.recruitmentContacts.find((x) => x.id === 'rct-2'); const o1 = L.db.recruitmentOffers.find((x) => x.id === 'rof-1'); const revisions = o1.revisions; const history = c2.history;
  c2.status = 'cancelled'; history.push({ id: 'aud-x', at: NOW, action: 'contact_cancelled', by: c2.createdBy, detail: null }); revisions[0].internalNote = 'changed';
  const before = withRo(dir, allDump); const rev = L.revision();
  const probe = failRunAt(L.store.sqlite, (sql) => /INTO recruitment_contacts|INTO offer_revisions/.test(sql), 1, 'synthetic statement failure');
  assert.throws(() => L.save(), /synthetic statement failure/); probe.restore();
  assert.equal(withRo(dir, allDump), before); assert.equal(L.revision(), rev); assert.equal(c2.status, 'cancelled', 'memory is the intended state'); assert.equal(L.store.sqlite.isTransaction, false);
  let arm = false; L.store.setSaveHook(() => { if (arm) { arm = false; L.store.failCommitOfOpenTransaction(); } });
  arm = true; assert.throws(() => L.save(), /FOREIGN KEY constraint failed/); assert.equal(withRo(dir, allDump), before, 'the real COMMIT failure: nothing landed'); assert.equal(L.revision(), rev); assert.equal(L.store.sqlite.isTransaction, false);
  L.save(); withRo(dir, (s) => { assert.equal(col(s, "SELECT status FROM recruitment_contacts WHERE id = 'rct-2'"), 'cancelled'); assert.equal(col(s, "SELECT internal_note FROM offer_revisions WHERE id = 'rofr-1'"), 'changed'); assert.equal(col(s, "SELECT count(*) FROM contact_history WHERE contact_id = 'rct-2'"), 5); });
  const landed = withRo(dir, allDump); L.save(); assert.equal(withRo(dir, allDump), landed, 'landed once');
  const c1 = L.db.recruitmentContacts[0]; c1.subject = 'edited before the unit (pending)';
  const dumpBefore = withRo(dir, allDump); const responseBefore = c2.response;
  assert.throws(() => L.store.unitOfWork(() => { c2.response = { ...c2.response, message: null }; history.push({ id: 'aud-unit', at: NOW, action: 'x', by: null, detail: null }); revisions.push(revision({ id: 'rofr-unit', revisionNumber: 2 })); o1.currentRevisionId = 'rofr-unit'; R.addOffer(draftOffer({ id: 'rof-unit', revisions: [revision({ id: 'rofr-u' })], currentRevisionId: 'rofr-u', history: [] })); throw new Error('synthetic unit failure'); }, { snapshot: L.snapshot }), /synthetic unit failure/);
  assert.equal(withRo(dir, allDump), dumpBefore); assert.equal(L.store.sqlite.isTransaction, false);
  assert.equal(c2.response, responseBefore, 'the held response object is back'); assert.equal(c2.response.message, 'Yes please'); assert.equal(history.length, 5); assert.equal(c2.history, history); assert.equal(revisions.length, 1); assert.equal(o1.revisions, revisions); assert.equal(o1.currentRevisionId, 'rofr-1');
  assert.equal(L.db.recruitmentOffers.some((x) => x.id === 'rof-unit'), false); assert.equal(c1.subject, 'edited before the unit (pending)', 'the pre-unit pending edit stays');
  assert.throws(() => L.store.unitOfWork(() => { c2.status = 'responded'; L.store.failCommitOfOpenTransaction(); }, { snapshot: L.snapshot })); assert.equal(c2.status, 'cancelled'); assert.equal(withRo(dir, allDump), dumpBefore);
  L.store.unitOfWork(() => { c2.response = { ...c2.response, message: null }; R.addOffer(draftOffer({ id: 'rof-unit', revisions: [revision({ id: 'rofr-u' })], currentRevisionId: 'rofr-u', history: [] })); }, { snapshot: L.snapshot });
  withRo(dir, (s) => { assert.equal(col(s, "SELECT response_message FROM recruitment_contacts WHERE id = 'rct-2'"), null); assert.equal(col(s, "SELECT subject FROM recruitment_contacts WHERE id = 'rct-1'"), 'edited before the unit (pending)'); assert.ok(s.prepare("SELECT 1 FROM recruitment_offers WHERE id = 'rof-unit'").get()); });
  L.close(); rm(dir);
});

// ------------------------------------------------------------- the snapshot write through the real store (the review's §6)
test('[cutover] the snapshot write (readiness review §6: P F0 R | B1 | A′ D′ | F2 | G) through the REAL store: the same valid final graph commits identically in BOTH input orders; a partial save (contacts only / offers only / neither while the requests change) equals the full save and leaves the omitted collection WHOLE; `[]` empties a collection (every owner departs with its RESTRICT history and key rows); a present null or non-array collection is refused with nothing written; a departing contact and its departing request leave in one save; a surviving contact retargets a new request while its old request departs (one save and two partial saves); a new pair arrives; a RETAINED contact whose request this save removes is refused with the table (CONTACT_STILL_REFERENCED); a contact naming a request outside the final requests is refused (CONTACT_REQUEST_DANGLING); a case removed under a retained contact or offer is refused with the table (CASE_STILL_REFERENCED); every refusal leaves the tables byte-identical and the retry lands', () => {
  { const d = file('precheck'); withRo(d, (s) => assert.ok(tableExistsIn(s, 'recruitment_contacts'), 'migration 0017 created recruitment_contacts')); rm(d); } needRco();
  const graph = () => { const fix = S8C_FIX(); const s8a = S8A_FIX(); return { recruitmentContacts: [...fix.recruitmentContacts, nullKeyContact({ id: 'rct-7', caseId: 'case-1', requestId: 'req-c7' })], recruitmentOffers: fix.recruitmentOffers, requests: [...s8a.requests, contactRequest('req-c7', 'rct-7')], trials: s8a.trials }; };
  const open = (tag, over = {}) => { const g = graph(); const d = file(tag, { recruitmentContacts: g.recruitmentContacts, requests: g.requests, ...over }); return { d, L: snapshotOpen(d) }; };
  // both input orders; partial saves
  const a = open('order-a'); const b = open('order-b'); const g = graph();
  a.L.save({ recruitmentContacts: g.recruitmentContacts, recruitmentOffers: g.recruitmentOffers, requests: g.requests }); b.L.save({ requests: [...g.requests].reverse(), recruitmentOffers: [...g.recruitmentOffers].reverse(), recruitmentContacts: [...g.recruitmentContacts].reverse() });
  assert.equal(withRo(a.d, canon), withRo(b.d, canon), 'the same final graph in both input orders');
  const fullCanon = withRo(a.d, canon);
  const p1 = open('partial-contacts'); p1.L.save({ recruitmentContacts: g.recruitmentContacts.map((c) => (c.id === 'rct-1' ? { ...c, subject: 'edited' } : c)) }, { omit: ['recruitmentOffers', 'requests', 'trials'] });
  withRo(p1.d, (s) => { assert.equal(col(s, "SELECT subject FROM recruitment_contacts WHERE id = 'rct-1'"), 'edited'); assert.equal(col(s, 'SELECT count(*) FROM recruitment_offers'), 4, 'the omitted offers retained WHOLE'); assert.equal(col(s, "SELECT current_revision_id FROM recruitment_offers WHERE id = 'rof-4'"), 'rofr-missing', 'their pointer bytes included'); });
  const p2 = open('partial-offers'); const canonP2 = withRo(p2.d, canon); p2.L.save({ recruitmentOffers: g.recruitmentOffers }, { omit: ['recruitmentContacts', 'requests', 'trials'] }); assert.equal(withRo(p2.d, canon), canonP2, 'an offers-only save of the unchanged offers equals the stored tables (content; the children are rewritten in list order)'); withRo(p2.d, (s) => assert.deepEqual(s.prepare('SELECT seq, id FROM recruitment_offers ORDER BY seq').all().map((r) => `${r.seq}:${r.id}`), ['1:rof-1', '2:rof-2', '3:rof-3', '4:rof-4'], 'the parents keep their seq (insertion order)'));
  const p3 = open('partial-none'); const dumpP3 = withRo(p3.d, s8cDump); p3.L.save({ requests: g.requests }, { omit: COLLECTIONS }); assert.equal(withRo(p3.d, s8cDump), dumpP3, 'neither collection supplied while the requests are resupplied: every contact and offer row retained byte for byte (the S8a phases rewrite the requests as before)'); assert.equal(withRo(p3.d, canon), fullCanon, 'and equal to the full save');
  // [] empties; null / non-array refused
  const e = open('empty'); e.L.save({ recruitmentOffers: [] }, { omit: ['recruitmentContacts', 'requests', 'trials'] });
  withRo(e.d, (s) => { for (const t of ['recruitment_offers', 'offer_revisions', 'offer_history', 'offer_responses']) assert.equal(col(s, `SELECT count(*) FROM ${t}`), 0, `${t} emptied`); assert.equal(col(s, "SELECT count(*) FROM idempotency_keys WHERE owner_table = 'recruitment_offers'"), 0, 'the key rows gone'); assert.equal(col(s, 'SELECT count(*) FROM recruitment_contacts'), 7, 'the omitted contacts retained'); });
  const n = open('null'); const dumpN = withRo(n.d, allDump); const revN = n.L.revision();
  for (const bad of [null, { not: 'a list' }, 'x']) refused(() => n.L.save({ recruitmentContacts: bad }), /recruitmentContacts: the snapshot collection must be an array/, `collection ${JSON.stringify(bad)}`);
  assert.equal(withRo(n.d, allDump), dumpN); assert.equal(n.L.revision(), revN); assert.equal(n.L.store.sqlite.isTransaction, false);
  // the joint departure, the retarget, the new pair
  const j = open('joint'); j.L.save({ recruitmentContacts: g.recruitmentContacts.filter((c) => c.id !== 'rct-7'), requests: g.requests.filter((r) => r.id !== 'req-c7') }, { omit: ['recruitmentOffers', 'trials'] });
  withRo(j.d, (s) => { assert.equal(col(s, "SELECT count(*) FROM recruitment_contacts WHERE id = 'rct-7'"), 0); assert.equal(col(s, "SELECT count(*) FROM recruitment_requests WHERE id = 'req-c7'"), 0); assert.equal(col(s, "SELECT count(*) FROM contact_history WHERE contact_id = 'rct-7'"), 0, 'the RESTRICT history removed explicitly first'); assert.equal(col(s, "SELECT count(*) FROM idempotency_keys WHERE owner_id = 'rct-7'"), 0); });
  const t = open('retarget'); const retargeted = g.recruitmentContacts.map((c) => (c.id === 'rct-7' ? { ...c, requestId: 'req-c8' } : c)); const reqs = [...g.requests.filter((r) => r.id !== 'req-c7'), contactRequest('req-c8', 'rct-7')];
  t.L.save({ recruitmentContacts: retargeted, requests: reqs }, { omit: ['recruitmentOffers', 'trials'] });
  withRo(t.d, (s) => { assert.equal(col(s, "SELECT request_id FROM recruitment_contacts WHERE id = 'rct-7'"), 'req-c8'); assert.equal(col(s, "SELECT count(*) FROM recruitment_requests WHERE id = 'req-c7'"), 0); assert.equal(col(s, "SELECT contact_id FROM recruitment_requests WHERE id = 'req-c8'"), 'rct-7'); });
  const t2 = open('retarget-partial'); t2.L.save({ requests: [...g.requests, contactRequest('req-c8', 'rct-7')] }, { omit: [...COLLECTIONS, 'trials'] }); t2.L.save({ recruitmentContacts: retargeted }, { omit: ['recruitmentOffers', 'requests', 'trials'] }); t2.L.save({ requests: reqs }, { omit: [...COLLECTIONS, 'trials'] });
  assert.equal(withRo(t2.d, canon), withRo(t.d, canon), 'the retarget as three partial saves equals the one save');
  const np = open('new-pair'); np.L.save({ recruitmentContacts: [...g.recruitmentContacts, draftContact({ id: 'rct-9', status: 'delivered', requestId: 'req-c9' })], requests: [...g.requests, contactRequest('req-c9', 'rct-9')] }, { omit: ['recruitmentOffers', 'trials'] }); withRo(np.d, (s) => assert.equal(col(s, "SELECT request_id FROM recruitment_contacts WHERE id = 'rct-9'"), 'req-c9'));
  // the refusals: byte-identical tables, no transaction open, the retry lands
  const x = open('refusals'); const dumpX = withRo(x.d, allDump); const revX = x.L.revision();
  refused(() => x.L.save({ requests: g.requests.filter((r) => r.id !== 'req-c7') }, { omit: [...COLLECTIONS, 'trials'] }), /CONTACT_STILL_REFERENCED.*recruitment_contacts rct-7 → requests req-c7/, 'a retained contact\'s request pruned');
  refused(() => x.L.save({ recruitmentContacts: g.recruitmentContacts.map((c) => (c.id === 'rct-7' ? { ...c, requestId: 'req-nowhere' } : c)) }, { omit: ['recruitmentOffers', 'requests', 'trials'] }), /CONTACT_REQUEST_DANGLING.*rct-7 → req-nowhere/, 'a request outside the final requests');
  refused(() => x.L.save({ recruitmentCases: S8B_FIX().recruitmentCases.filter((k) => k.id !== 'case-gone'), roomComments: [], roomSnapshots: [], roomDecisions: [], roomEvidenceState: [] }, { omit: [...COLLECTIONS, 'requests', 'trials'] }), /CASE_STILL_REFERENCED.*recruitment_contacts rct-5.*recruitment_offers rof-4.*cases case-gone/, 'a case removed under retained rows');
  refused(() => x.L.save({ recruitmentContacts: g.recruitmentContacts.map((c) => (c.id === 'rct-1' ? { ...c, requestId: 'req-c7' } : c)) }, { omit: ['recruitmentOffers', 'requests', 'trials'] }), /CONTACT_REQUEST_MISMATCH.*contact rct-1 → request req-c7 → contact rct-7/, 'a pair that disagrees (the request names another contact)');
  assert.equal(withRo(x.d, allDump), dumpX, 'every refusal left the tables byte-identical'); assert.equal(x.L.revision(), revX); assert.equal(x.L.store.sqlite.isTransaction, false);
  x.L.save({ recruitmentContacts: g.recruitmentContacts.map((c) => (c.id === 'rct-1' ? { ...c, status: 'delivered', requestId: 'req-minor' } : c)) }, { omit: ['recruitmentOffers', 'requests', 'trials'] }); withRo(x.d, (s) => assert.equal(col(s, "SELECT request_id FROM recruitment_contacts WHERE id = 'rct-1'"), 'req-minor', 'a request that names no contact back may be named (the pair guard is the S8a PAIR_MISMATCH rule, not a unique index)')); x.L.save({ recruitmentContacts: g.recruitmentContacts }, { omit: ['recruitmentOffers', 'requests', 'trials'] });
  const revY = x.L.revision(); x.L.save({ recruitmentContacts: g.recruitmentContacts.filter((c) => c.id !== 'rct-7'), requests: g.requests.filter((r) => r.id !== 'req-c7') }, { omit: ['recruitmentOffers', 'trials'] }); assert.equal(x.L.revision(), revY + 1, 'the corrected retry lands');
  for (const h of [a, b, p1, p2, p3, e, n, j, t, t2, np, x]) { h.L.close(); rm(h.d); }
});

test('[review a5a7ed9 R1; review 854d035 F1/F2b — ported to the REAL store] for EACH of the five offer pointers (current_revision_id, response_id, supersedes_revision_id, superseded_by_revision_id, discarded_by_response_id): direction 1 — the target\'s owner departs from a SUPPLIED collection while the pointer arrives → the valid final collection commits (owner removed with its children, pointer kept verbatim, counted as unresolved, foreign_key_check empty); direction 2 — the unresolved pointer\'s owner departs while a new offer arrives owning the target id → commits; a TRUE foreign-owner pointer (both owners in the supplied collection) is refused with the owner named, every row and the revision unchanged, and the retry without the pointer lands; F1 — a current revision missing everywhere is written and kept verbatim; F2b — a discarded_by pointer to another offer\'s response is refused atomically; omitted versus [] versus null', () => {
  { const d = file('precheck-r1'); withRo(d, (s) => assert.ok(tableExistsIn(s, 'recruitment_offers'), 'migration 0017 created recruitment_offers')); rm(d); } needRco();
  const base = (tag, offers) => { const d = file(tag, { recruitmentOffers: offers, recruitmentContacts: [] }); return { d, L: snapshotOpen(d) }; };
  for (const kind of KINDS) {
    // direction 1
    const d1 = base(`r1-d1-${kind}`, [offerPointing('offer-a', kind, `${kind}-own`, { owns: `${kind}-own` }), offerPointing('offer-b', kind, 'gone-target', { owns: 'gone-target' })]);
    d1.L.save({ recruitmentOffers: [offerPointing('offer-a', kind, 'gone-target')] }, { omit: ['recruitmentContacts', 'requests', 'trials'] });
    withRo(d1.d, (s) => { assert.deepEqual(s.prepare('SELECT id FROM recruitment_offers ORDER BY seq').all().map((r) => r.id), ['offer-a'], `${kind} d1: offer-b departed`); assert.equal(pointerCol(s, 'offer-a', kind), 'gone-target', `${kind} d1: the pointer kept verbatim`); assert.equal(col(s, "SELECT count(*) FROM offer_revisions WHERE offer_id = 'offer-b'"), 0); assert.equal(col(s, "SELECT count(*) FROM offer_history WHERE offer_id = 'offer-b'"), 0); assert.equal(s.prepare('PRAGMA foreign_key_check').all().length, 0); assert.equal(rco.unresolvedPointerReferences(s)[kind], 1, `${kind} d1: counted as unresolved`); });
    d1.L.close(); rm(d1.d);
    // direction 2
    const d2 = base(`r1-d2-${kind}`, [offerPointing('offer-a', kind, 'new-target')]);
    d2.L.save({ recruitmentOffers: [offerPointing('offer-b', kind, 'new-target', { owns: 'new-target' })] }, { omit: ['recruitmentContacts', 'requests', 'trials'] });
    withRo(d2.d, (s) => { assert.deepEqual(s.prepare('SELECT id FROM recruitment_offers ORDER BY seq').all().map((r) => r.id), ['offer-b'], `${kind} d2: offer-a departed, offer-b arrived owning the id`); assert.equal(rco.unresolvedPointerReferences(s)[kind], 0); });
    d2.L.close(); rm(d2.d);
    // the true foreign owner, both present
    const f = base(`r1-f-${kind}`, [offerPointing('offer-a', kind, `${kind}-own`, { owns: `${kind}-own` }), offerPointing('offer-b', kind, 'b-target', { owns: 'b-target' })]); const dumpF = withRo(f.d, allDump); const revF = f.L.revision();
    refused(() => f.L.save({ recruitmentOffers: [offerPointing('offer-a', kind, 'b-target'), offerPointing('offer-b', kind, 'b-target', { owns: 'b-target' })] }, { omit: ['recruitmentContacts', 'requests', 'trials'] }), new RegExp(`OFFER_CHAIN_BROKEN.*offer-a/.* ${kind}→b-target owned by offer offer-b`), `${kind} foreign`);
    assert.equal(withRo(f.d, allDump), dumpF, `${kind}: every row unchanged`); assert.equal(f.L.revision(), revF); assert.equal(f.L.store.sqlite.isTransaction, false);
    f.L.save({ recruitmentOffers: [offerPointing('offer-a', kind, `${kind}-own`, { owns: `${kind}-own` }), offerPointing('offer-b', kind, 'b-target', { owns: 'b-target' })] }, { omit: ['recruitmentContacts', 'requests', 'trials'] }); assert.equal(f.L.revision(), revF + 1, `${kind}: the retry without the pointer lands`);
    f.L.close(); rm(f.d);
  }
  // F1, F2b; omitted / [] / null
  const z = base('r1-misc', [draftOffer()]); z.L.save({ recruitmentOffers: [draftOffer(), legacyOffer()] }, { omit: ['recruitmentContacts', 'requests', 'trials'] }); withRo(z.d, (s) => assert.equal(col(s, "SELECT current_revision_id FROM recruitment_offers WHERE id = 'rof-4'"), 'rofr-missing', '[F1] kept verbatim'));
  const dumpZ = withRo(z.d, s8cDump);
  refused(() => z.L.save({ recruitmentOffers: [acceptedOffer(), draftOffer({ revisions: [revision({ discardedByResponseId: 'rofa-1' })] })] }, { omit: ['recruitmentContacts', 'requests', 'trials'] }), /OFFER_CHAIN_BROKEN.*rof-1\/rofr-1 discarded_by_response_id→rofa-1 owned by offer rof-2/, '[F2b]'); assert.equal(withRo(z.d, s8cDump), dumpZ);
  z.L.save({}, { omit: [...COLLECTIONS, 'requests', 'trials'] }); assert.equal(withRo(z.d, s8cDump), dumpZ, 'omitted: the whole stored collection retained');
  refused(() => z.L.save({ recruitmentOffers: null }, { omit: ['recruitmentContacts', 'requests', 'trials'] }), /recruitmentOffers: the snapshot collection must be an array/, 'null is not an omission'); assert.equal(withRo(z.d, s8cDump), dumpZ);
  z.L.save({ recruitmentOffers: [] }, { omit: ['recruitmentContacts', 'requests', 'trials'] }); withRo(z.d, (s) => assert.equal(col(s, 'SELECT count(*) FROM recruitment_offers'), 0, '[] empties the collection'));
  z.L.close(); rm(z.d);
});

test('[behaviour] a whole-snapshot save that removes a request a RETAINED contact still names is refused with the table and the ids (the accepted 7072dd9 blob store removed the request and kept the contact pointing at nothing); [compat] a contact naming a case that is not in the FINAL cases is refused when only the contacts change; a guardian that is not in the FINAL guardians table is refused on a snapshot write (Q8c-b) while a historically missing player id is written and counted (Q8c-a)', () => {
  const d = tempDir('s8c-beh'); preS8cFile(d, { recruitmentContacts: [nullKeyContact({ id: 'rct-7', requestId: 'req-c7' })], requests: [...S8A_FIX().requests, contactRequest('req-c7', 'rct-7')] }); { const s = openRaw(d); migrateAll(s); s.close(); }
  const L = snapshotOpen(d); const before = withRo(d, allDump);
  refused(() => L.save({ requests: S8A_FIX().requests }, { omit: [...COLLECTIONS, 'trials'] }), /CONTACT_STILL_REFERENCED.*recruitment_contacts rct-7 → requests req-c7/, 'the retained contact');
  assert.equal(withRo(d, allDump), before); assert.equal(L.store.sqlite.isTransaction, false);
  refused(() => L.save({ recruitmentContacts: [draftContact({ id: 'rct-x', caseId: 'case-nowhere' })] }, { omit: ['recruitmentOffers', 'requests', 'trials'] }), /CONTACT_OFFER_CASE_MISSING.*rct-x → case-nowhere/, '[compat] the case');
  refused(() => L.save({ recruitmentContacts: [respondedContact({ requestId: null, recipient: { type: 'guardian', playerId: 'pl-child1', guardianId: 'gd-nowhere', minor: true } })] }, { omit: ['recruitmentOffers', 'requests', 'trials'] }), /CONTACTS_OFFERS_GUARDIAN_MISSING.*rct-2 → gd-nowhere/, 'Q8c-b strict');
  assert.equal(withRo(d, allDump), before);
  L.save({ recruitmentContacts: [nullKeyContact({ id: 'rct-7', requestId: 'req-c7' }), respondedContact({ id: 'rct-g', requestId: null, recipient: { type: 'guardian', playerId: 'pl-child1', guardianId: 'gd-signup', minor: true } })] }, { omit: ['recruitmentOffers', 'requests', 'trials'] });
  const dumpG = withRo(d, s8cDump); const gs = plain(L.db.guardians).filter((x) => x.id !== 'gd-signup');
  refused(() => L.save({ players: plain(L.db.players), guardians: gs }, { omit: [...COLLECTIONS, 'requests', 'trials'] }), /CONTACTS_OFFERS_GUARDIAN_MISSING.*recruitment_contacts rct-g → gd-signup/, 'Q8c-b against the FINAL guardians of the same snapshot: a RETAINED contact naming a guardian the identity snapshot removes');
  assert.equal(withRo(d, s8cDump), dumpG); assert.ok(withRo(d, (s) => s.prepare("SELECT 1 FROM guardians WHERE id = 'gd-signup'").get()), 'the guardian row stays (the whole save rolled back)');
  L.save({ recruitmentContacts: [legacyContact()] }, { omit: ['recruitmentOffers', 'requests', 'trials'] }); withRo(d, (s) => { assert.equal(col(s, "SELECT player_id FROM recruitment_contacts WHERE id = 'rct-5'"), 'pl-gone-long-ago', 'Q8c-a: written as it is'); assert.deepEqual(rco.unresolvedPlayerReferences(s), { recruitmentContacts: 1, recruitmentOffers: 2 }, 'per occurrence (the review of 535e247, F3): the legacy contact\'s parent; the legacy offer\'s parent and its revision recipient'); });
  L.close(); rm(d);
});

// ------------------------------------------------------------- the independent review of 535e247 (F1, F2, F3): regressions written before the correction
// FAILING-FIRST NOTE (recorded on the unchanged 535e247 tree): F1 — the snapshot write's retained guardian references
// included the stored rows of records a SUPPLIED collection no longer listed (departing at F0), so one save that removed
// a guardian together with every contact/offer naming it was refused; F2 — a save in which only a request's contactId
// changed in the staged S8a mirror committed a disagreeing pair (flushPre saw no S8c change and no departure, flushWrite
// skipped the final guard); F3 — the live unresolved/retained player counts inspected the two parents' player_id only,
// while the cutover (and Q8c-a) count every player-reference occurrence.
test('[review 535e247 F1 — ported to the REAL store] the FINAL guardian references exclude the owners a supplied collection departs: one save removing a guardian and every contact (recipient) / offer (revision recipient; guardian response actor and receipt viewer) naming it succeeds for each kind and reaches the same state as the reviewer\'s two-save control; the omitted collection is still retained (refused with the retained row named, never the departing one); a replacement or same-id row still naming the guardian is refused; same-id rows with the reference changed land; every refusal is atomic and the corrected retry lands', () => {
  needRco();
  const guardianRef = { type: 'guardian', playerId: 'pl-adult', guardianId: 'gd-signup', minor: false };
  const refContact = (over = {}) => draftContact({ id: 'rct-depart', recipient: guardianRef, ...over });
  const refOffer = (over = {}) => draftOffer({ id: 'rof-depart', revisions: [revision({ recipientSnapshot: { ...guardianRef, at: NOW } })], ...over });
  const actorOffer = () => draftOffer({ id: 'rof-actor', responses: [{ id: 'resp-g', revisionId: 'rofr-1', responseType: 'declined', actorType: 'guardian', actorId: 'gd-signup', actorName: null, forPlayerId: 'pl-adult', occurredAt: TX.accepted, reason: null, clientKey: null }], readReceipts: [{ revisionId: 'rofr-1', viewerKind: 'guardian', viewerId: 'gd-signup', firstViewedAt: NOW }] });
  const withoutSignup = (L) => plain(L.db.guardians).filter((g) => g.id !== 'gd-signup');
  const signupGone = (d) => withRo(d, (s) => s.prepare("SELECT count(*) AS n FROM guardians WHERE id = 'gd-signup'").get().n === 0);
  const s8cRows = (d) => withRo(d, (s) => s.prepare('SELECT count(*) AS n FROM recruitment_contacts').get().n + s.prepare('SELECT count(*) AS n FROM recruitment_offers').get().n);
  for (const [kind, records] of [['contact recipient', { recruitmentContacts: [refContact()], recruitmentOffers: [] }], ['offer revision recipient', { recruitmentContacts: [], recruitmentOffers: [refOffer()] }], ['guardian response actor and receipt viewer', { recruitmentContacts: [], recruitmentOffers: [actorOffer()] }]]) {
    const d = file(`f1-${kind.replace(/\W+/g, '-')}`, records); const L = snapshotOpen(d); const before = withRo(d, fullDump); const rev = L.revision();
    // control: the guardian departs while the referring collection is OMITTED (retained whole) → refused, atomic
    refused(() => L.save({ players: plain(L.db.players), guardians: withoutSignup(L) }, { omit: [...COLLECTIONS, 'requests', 'trials'] }), /CONTACTS_OFFERS_GUARDIAN_MISSING[\s\S]*gd-signup/, `${kind}: retained`);
    assert.equal(withRo(d, fullDump), before, `${kind}: nothing written`); assert.equal(L.revision(), rev); assert.equal(L.store.sqlite.isTransaction, false);
    // F1: the departure in ONE save — both collections supplied as [] and the guardian removed: the final graph names no guardian
    L.save({ players: plain(L.db.players), guardians: withoutSignup(L), recruitmentContacts: [], recruitmentOffers: [] }, { omit: ['requests', 'trials'] });
    assert.ok(signupGone(d), `${kind}: the guardian departed`); assert.equal(s8cRows(d), 0, `${kind}: the referring records departed`); assert.equal(L.store.sqlite.isTransaction, false);
    L.close(); rm(d);
  }
  // the reviewer's two-save control (the referring collections emptied first, the guardian second) reaches the same final state as the one-save path
  { const d1 = file('f1-one', { recruitmentContacts: [refContact()], recruitmentOffers: [refOffer()] }); const d2 = file('f1-two', { recruitmentContacts: [refContact()], recruitmentOffers: [refOffer()] });
    const L1 = snapshotOpen(d1); L1.save({ players: plain(L1.db.players), guardians: withoutSignup(L1), recruitmentContacts: [], recruitmentOffers: [] }, { omit: ['requests', 'trials'] }); L1.close();
    const L2 = snapshotOpen(d2); L2.save({ recruitmentContacts: [], recruitmentOffers: [] }, { omit: ['requests', 'trials'] }); L2.save({ players: plain(L2.db.players), guardians: withoutSignup(L2) }, { omit: [...COLLECTIONS, 'requests', 'trials'] }); L2.close();
    const state = (d) => withRo(d, (s) => JSON.stringify([canon(s), s.prepare('SELECT id FROM guardians ORDER BY id').all().map((r) => r.id)]));
    assert.equal(state(d1), state(d2), 'one save and two saves reach the same final tables'); rm(d1, d2); }
  // the collections supplied / omitted independently; [] versus a replacement; same ids with changed references
  { const d = file('f1-mixed', { recruitmentContacts: [refContact()], recruitmentOffers: [refOffer()] }); const L = snapshotOpen(d); const before = withRo(d, fullDump); const players = plain(L.db.players);
    // contacts supplied [] but offers OMITTED: the retained offer still names gd-signup → refused with the OFFER named; the departing contact is not a reference any more and is not named
    const e1 = refused(() => L.save({ players, guardians: withoutSignup(L), recruitmentContacts: [] }, { omit: ['recruitmentOffers', 'requests', 'trials'] }), /CONTACTS_OFFERS_GUARDIAN_MISSING[\s\S]*recruitment_offers rof-depart → gd-signup/, 'the omitted collection is retained');
    assert.doesNotMatch(e1.message, /rct-depart/, 'a departing owner is not a final reference'); assert.equal(withRo(d, fullDump), before, 'atomic');
    // offers supplied [] but contacts OMITTED: the mirror case
    const e2 = refused(() => L.save({ players, guardians: withoutSignup(L), recruitmentOffers: [] }, { omit: ['recruitmentContacts', 'requests', 'trials'] }), /CONTACTS_OFFERS_GUARDIAN_MISSING[\s\S]*recruitment_contacts rct-depart → gd-signup/, 'the omitted contacts are retained');
    assert.doesNotMatch(e2.message, /rof-depart/); assert.equal(withRo(d, fullDump), before, 'atomic');
    // a REPLACEMENT that still names the guardian is a genuine surviving reference → refused; so is a same-id row that still names it
    refused(() => L.save({ players, guardians: withoutSignup(L), recruitmentContacts: [refContact({ id: 'rct-new' })], recruitmentOffers: [] }, { omit: ['requests', 'trials'] }), /CONTACTS_OFFERS_GUARDIAN_MISSING[\s\S]*recruitment_contacts rct-new → gd-signup/, 'a replacement still naming the guardian');
    refused(() => L.save({ players, guardians: withoutSignup(L), recruitmentContacts: [], recruitmentOffers: [refOffer({ revisions: [revision({ recipientSnapshot: { ...guardianRef, at: NOW + 1 } })] })] }, { omit: ['requests', 'trials'] }), /CONTACTS_OFFERS_GUARDIAN_MISSING[\s\S]*recruitment_offers rof-depart → gd-signup/, 'a same-id offer still naming the guardian');
    assert.equal(withRo(d, fullDump), before, 'every refusal atomic');
    // the same ids with the reference moved to a guardian that stays: the guardian departs, both rows land with the new reference (the corrected retry)
    L.save({ players, guardians: withoutSignup(L), recruitmentContacts: [refContact({ recipient: { ...guardianRef, guardianId: 'gd-primary' } })], recruitmentOffers: [refOffer({ revisions: [revision({ recipientSnapshot: { ...guardianRef, guardianId: 'gd-primary', at: NOW } })] })] }, { omit: ['requests', 'trials'] });
    assert.ok(signupGone(d)); withRo(d, (s) => { assert.equal(col(s, "SELECT recipient_guardian_id FROM recruitment_contacts WHERE id = 'rct-depart'"), 'gd-primary'); assert.equal(col(s, "SELECT recipient_guardian_id FROM offer_revisions WHERE offer_id = 'rof-depart'"), 'gd-primary'); });
    L.close(); rm(d); }
});

test('[review 535e247 F2 — through the REAL store hooks] a save in which ONLY a request\'s contactId changes in the staged S8a mirror (no contact or offer dirty, no departure) is refused by the pair guard with the ids: every table and the revision unchanged, a separate connection sees the committed pair, the request keeps its intended (refused) value in memory and a plain retry is refused again; the corrected value lands; a valid request-only edit lands without rewriting any S8c row; a unit of work that retargets the request alone is refused at its commit and the request memory is restored; the contact and request moved TOGETHER land', () => {
  needRco();
  const d = file('f2', { recruitmentContacts: [draftContact({ requestId: 'req-c' })], recruitmentOffers: [], requests: [...S8A_FIX().requests, contactRequest('req-c', 'rct-1')] });
  const L = serverOpen(d); L.save(); const before = withRo(d, allDump); const rev = L.revision();
  const findReq = () => L.db.requests.find((x) => x.id === 'req-c');
  findReq().contactId = 'rct-other';
  refused(() => L.save(), /CONTACT_REQUEST_MISMATCH[\s\S]*contact rct-1 → request req-c → contact rct-other/, 'a request-only staged change');
  assert.equal(withRo(d, allDump), before, 'every table unchanged'); assert.equal(L.revision(), rev, 'the revision unchanged'); assert.equal(L.store.sqlite.isTransaction, false);
  assert.deepEqual(withRo(d, (s) => ({ ...s.prepare("SELECT c.request_id, r.contact_id FROM recruitment_contacts c JOIN recruitment_requests r ON r.id = c.request_id WHERE c.id = 'rct-1'").get() })), { request_id: 'req-c', contact_id: 'rct-1' }, 'a separate connection sees the committed pair');
  assert.equal(findReq().contactId, 'rct-other', 'memory keeps the intended state for the caller to correct');
  refused(() => L.save(), /CONTACT_REQUEST_MISMATCH/, 'a plain retry is refused again'); assert.equal(withRo(d, allDump), before);
  findReq().contactId = 'rct-1'; L.save(); assert.equal(withRo(d, allDump), before, 'the correction lands (nothing differs from the committed state)');
  const s8cBefore = withRo(d, s8cDump); findReq().message = 'edited message'; L.save();
  assert.equal(withRo(d, s8cDump), s8cBefore, 'a valid request-only edit rewrites no S8c row'); assert.equal(withRo(d, (s) => col(s, "SELECT message FROM recruitment_requests WHERE id = 'req-c'")), 'edited message');
  const landed = withRo(d, allDump);
  assert.throws(() => L.store.unitOfWork(() => { findReq().contactId = 'rct-other'; }, { snapshot: L.snapshot }), /CONTACT_REQUEST_MISMATCH/, 'a unit of work retargeting the request alone');
  assert.equal(findReq().contactId, 'rct-1', 'the unit memento restored the request'); assert.equal(withRo(d, allDump), landed); assert.equal(L.store.sqlite.isTransaction, false);
  // the pair moved TOGETHER (the contact released, a new contact takes the request, the request names it) lands and passes the guard
  L.repo.addContact(draftContact({ id: 'rct-9', requestId: 'req-c' })); L.db.recruitmentContacts.find((x) => x.id === 'rct-1').requestId = null; findReq().contactId = 'rct-9'; L.save();
  withRo(d, (s) => { assert.equal(col(s, "SELECT request_id FROM recruitment_contacts WHERE id = 'rct-1'"), null); assert.equal(col(s, "SELECT request_id FROM recruitment_contacts WHERE id = 'rct-9'"), 'req-c'); assert.equal(col(s, "SELECT contact_id FROM recruitment_requests WHERE id = 'req-c'"), 'rct-9'); rco.assertContactsOffersConsistent(s); });
  L.close(); rm(d);
});

test('[review 535e247 F3 — the live counts cover every Q8c-a reference occurrence, as the cutover does] parent player_id, contact recipient_player_id, revision recipient_player_id, response for_player_id, the PLAYER response actor and the PLAYER receipt viewer are counted per occurrence (a duplicate twice; a guardian-typed actor or viewer never); the per-collection shape and count-only output stay; the counts equal the cutover\'s, follow a staged save, a restore and a restart; retainedPlayerReferences covers the same fields', () => {
  needRco();
  const missing = (playerId) => ({ type: 'player', playerId, guardianId: null, minor: false });
  const offer = draftOffer({
    revisions: [revision({ recipientSnapshot: { ...missing('missing-offer-recipient'), at: NOW } }), revision({ id: 'rofr-dup', revisionNumber: 2, recipientSnapshot: { ...missing('missing-offer-recipient'), at: NOW } })],
    responses: [{ id: 'resp-p', revisionId: 'rofr-1', responseType: 'accepted', actorType: 'player', actorId: 'missing-actor', actorName: null, forPlayerId: 'missing-subject', occurredAt: TX.accepted, reason: null, clientKey: null }, { id: 'resp-g', revisionId: 'rofr-1', responseType: 'declined', actorType: 'guardian', actorId: 'gd-primary', actorName: null, forPlayerId: 'pl-adult', occurredAt: TX.accepted, reason: null, clientKey: null }],
    readReceipts: [{ revisionId: 'rofr-1', viewerKind: 'player', viewerId: 'missing-viewer', firstViewedAt: NOW }, { revisionId: 'rofr-1', viewerKind: 'guardian', viewerId: 'gd-primary', firstViewedAt: NOW }],
  });
  const d = file('f3', { recruitmentContacts: [draftContact({ recipient: missing('missing-contact-recipient') })], recruitmentOffers: [offer] });
  // the cutover: parents live (2) + resp-g's forPlayerId (1) = 3 live; the contact recipient + two revision recipients + the player actor + forPlayerId + the player viewer = 6 missing; the guardian actor and viewer are not player references
  withRo(d, (s) => { const cut = JSON.parse(meta(s, 'recruitmentContactsOffersCutover')); assert.deepEqual(cut.players, { live: 3, retained: 0, missing: 6 }); assert.deepEqual(rco.unresolvedPlayerReferences(s), { recruitmentContacts: 1, recruitmentOffers: 5 }, 'the live counts equal the cutover\'s, per collection'); assert.deepEqual(rco.retainedPlayerReferences(s), { recruitmentContacts: 0, recruitmentOffers: 0 }); });
  // after a staged save: a new contact with a missing recipient and a receipt pushed onto the offer in place
  const L = serverOpen(d); assert.deepEqual(L.layer.report().domains.recruitmentContactsOffers.unresolvedPlayerReferences, { recruitmentContacts: 1, recruitmentOffers: 5 });
  L.repo.addContact(draftContact({ id: 'rct-n', recipient: missing('missing-contact-recipient-2') })); L.db.recruitmentOffers[0].readReceipts.push({ revisionId: 'rofr-1', viewerKind: 'player', viewerId: 'missing-viewer-2', firstViewedAt: NOW }); L.save();
  assert.deepEqual(L.layer.report().domains.recruitmentContactsOffers.unresolvedPlayerReferences, { recruitmentContacts: 2, recruitmentOffers: 6 }, 'after the staged save');
  for (const v of Object.values(L.layer.report().domains.recruitmentContactsOffers.unresolvedPlayerReferences)) assert.equal(typeof v, 'number', 'count-only output');
  assert.doesNotMatch(JSON.stringify(L.layer.report().domains.recruitmentContactsOffers), /missing-contact-recipient|missing-viewer|missing-actor/, 'no id in the aggregate report');
  L.close();
  // after a restart and after a restore (every record re-supplied)
  { const L2 = serverOpen(d); assert.deepEqual(L2.layer.report().domains.recruitmentContactsOffers.unresolvedPlayerReferences, { recruitmentContacts: 2, recruitmentOffers: 6 }, 'after a restart'); L2.close(); }
  { const S = snapshotOpen(d); S.save({ recruitmentContacts: plain(S.db.recruitmentContacts), recruitmentOffers: plain(S.db.recruitmentOffers) }, { omit: ['requests', 'trials'] }); S.close(); withRo(d, (s) => assert.deepEqual(rco.unresolvedPlayerReferences(s), { recruitmentContacts: 2, recruitmentOffers: 6 }, 'after a restore')); }
  // retained (S4b-R) references, field by field: pl-adult retained → the two parents, rct-n's parent and resp-g's forPlayerId
  { const s = openRaw(d); s.prepare("UPDATE players SET deleted_at = ? WHERE id = 'pl-adult'").run(NOW); assert.deepEqual(rco.retainedPlayerReferences(s), { recruitmentContacts: 2, recruitmentOffers: 2 }, 'retained occurrences'); assert.deepEqual(rco.unresolvedPlayerReferences(s), { recruitmentContacts: 2, recruitmentOffers: 6 }, 'a retained id is not unresolved'); s.prepare("UPDATE players SET deleted_at = NULL WHERE id = 'pl-adult'").run(); s.close(); }
  rm(d);
});

test('[empty-string ids — the ONE reference rule, Q8c-a] a string id, EMPTY INCLUDED, is a reference occurrence; an absent or null id is none: a nested empty-string player id (contact recipient, revision recipient, response for-player, PLAYER actor, PLAYER viewer) is counted as missing at the cutover exactly as the live report counts it, stored verbatim, never refused or repaired; a null or absent nested id is counted by neither; the counts follow a staged save and a restore', () => {
  needRco();
  // ---- Q8c-a, the counted side (the reviewer's 27 October fixture, plus the null and absent controls)
  const playerRef = (playerId) => ({ type: 'player', playerId, guardianId: null, minor: false });
  const absentRef = { type: 'player', guardianId: null, minor: false };
  const emptyOffer = draftOffer({
    revisions: [revision({ recipientSnapshot: { ...playerRef(''), at: NOW } })],
    responses: [{ id: 'resp-e', revisionId: 'rofr-1', responseType: 'accepted', actorType: 'player', actorId: '', actorName: null, forPlayerId: '', occurredAt: TX.accepted, reason: null, clientKey: null }],
    readReceipts: [{ revisionId: 'rofr-1', viewerKind: 'player', viewerId: '', firstViewedAt: NOW }],
  });
  const controlOffer = draftOffer({
    id: 'rof-ctl', keys: { ...draftOffer().keys, create: { key: 'k-o-ctl', fp: '{}' } },
    revisions: [revision({ recipientSnapshot: { ...playerRef(null), at: NOW } }), revision({ id: 'rofr-abs', revisionNumber: 2, recipientSnapshot: { ...absentRef, at: NOW } })],
    responses: [{ id: 'resp-null', revisionId: 'rofr-1', responseType: 'declined', actorType: 'player', actorId: null, actorName: null, forPlayerId: null, occurredAt: TX.accepted, reason: null, clientKey: null }, { id: 'resp-abs', revisionId: 'rofr-1', responseType: 'declined', actorType: 'player', actorName: null, occurredAt: TX.accepted, reason: null, clientKey: null }],
    readReceipts: [{ revisionId: 'rofr-1', viewerKind: 'player', viewerId: null, firstViewedAt: NOW }, { revisionId: 'rofr-1', viewerKind: 'player', firstViewedAt: NOW }],
  });
  const d = file('empty-player', {
    recruitmentContacts: [draftContact({ recipient: playerRef('') }), draftContact({ id: 'rct-null', recipient: playerRef(null), keys: { ...draftContact().keys, create: { key: 'k-c-null', fp: '{}' } } }), draftContact({ id: 'rct-abs', recipient: absentRef, keys: { ...draftContact().keys, create: { key: 'k-c-abs', fp: '{}' } } })],
    recruitmentOffers: [emptyOffer, controlOffer],
  });
  withRo(d, (s) => {
    // stored verbatim: the empty strings are in their columns (never null, never off-type, never repaired)
    assert.deepEqual({ c: col(s, "SELECT count(*) FROM recruitment_contacts WHERE recipient_player_id = ''"), rv: col(s, "SELECT count(*) FROM offer_revisions WHERE recipient_player_id = ''"), fp: col(s, "SELECT count(*) FROM offer_responses WHERE for_player_id = ''"), a: col(s, "SELECT count(*) FROM offer_responses WHERE actor_id = ''"), v: col(s, "SELECT count(*) FROM offer_read_receipts WHERE viewer_id = ''") }, { c: 1, rv: 1, fp: 1, a: 1, v: 1}, 'the empty strings are stored as written');
    assert.equal(col(s, "SELECT recipient_player_id FROM recruitment_contacts WHERE id = 'rct-null'"), null); assert.equal(col(s, "SELECT recipient_player_id FROM recruitment_contacts WHERE id = 'rct-abs'"), null);
    // the cutover record: the five parents live; the contact recipient + the revision recipient + for-player + the player actor + the player viewer = 5 missing; the null and absent ids are no reference
    const cut = JSON.parse(meta(s, 'recruitmentContactsOffersCutover'));
    assert.deepEqual(cut.players, { live: 5, retained: 0, missing: 5 }, 'the cutover counts every nested empty-string id as a missing reference (the live report\'s rule)');
    const live = rco.unresolvedPlayerReferences(s);
    assert.deepEqual(live, { recruitmentContacts: 1, recruitmentOffers: 4 }, 'the live counts: unchanged by this correction');
    assert.equal(live.recruitmentContacts + live.recruitmentOffers, cut.players.missing, 'the cutover record and the live report count alike');
    assert.deepEqual(rco.retainedPlayerReferences(s), { recruitmentContacts: 0, recruitmentOffers: 0 });
  });
  // a staged save re-validating the records with the empty ids lands (nothing refused, nothing rewritten); a restore counts the same
  { const L = serverOpen(d); L.db.recruitmentOffers[0].readReceipts.push({ revisionId: 'rofr-1', viewerKind: 'player', viewerId: '', firstViewedAt: NOW + 1 }); L.save(); assert.deepEqual(L.layer.report().domains.recruitmentContactsOffers.unresolvedPlayerReferences, { recruitmentContacts: 1, recruitmentOffers: 5 }, 'after a staged save'); L.close(); }
  { const S = snapshotOpen(d); S.save({ recruitmentContacts: plain(S.db.recruitmentContacts), recruitmentOffers: plain(S.db.recruitmentOffers) }, { omit: ['requests', 'trials'] }); S.close(); withRo(d, (s) => assert.deepEqual(rco.unresolvedPlayerReferences(s), { recruitmentContacts: 1, recruitmentOffers: 5 }, 'after a restore')); }
  rm(d);
});

test('[empty-string ids — the ONE reference rule, Q8c-b] the same rule on the strict side: an empty-string guardian id (contact recipient, offer revision recipient, guardian response actor, guardian receipt viewer) is refused at the cutover AND at a snapshot write with the ids, the empty id rendered QUOTED so it never reads as a blank, atomically, the next attempt refused the same way; a null guardian id and an absent guardian id are no reference and stay accepted on both paths', () => {
  needRco();
  const gRef = (guardianId) => ({ type: 'guardian', playerId: 'pl-adult', guardianId, minor: false });
  const kinds = [
    ['contact recipient', (g) => ({ recruitmentContacts: [draftContact({ id: 'rct-g', recipient: g === undefined ? { type: 'guardian', playerId: 'pl-adult', minor: false } : gRef(g) })], recruitmentOffers: [] }), 'recruitment_contacts rct-g'],
    ['offer revision recipient', (g) => ({ recruitmentContacts: [], recruitmentOffers: [draftOffer({ id: 'rof-g', revisions: [revision({ recipientSnapshot: g === undefined ? { type: 'guardian', playerId: 'pl-adult', minor: false, at: NOW } : { ...gRef(g), at: NOW } })] })] }), 'recruitment_offers rof-g'],
    ['guardian response actor', (g) => ({ recruitmentContacts: [], recruitmentOffers: [draftOffer({ id: 'rof-g', responses: [{ id: 'resp-g', revisionId: 'rofr-1', responseType: 'declined', actorType: 'guardian', ...(g === undefined ? {} : { actorId: g }), actorName: null, forPlayerId: 'pl-adult', occurredAt: TX.accepted, reason: null, clientKey: null }] })] }), 'recruitment_offers rof-g'],
    ['guardian receipt viewer', (g) => ({ recruitmentContacts: [], recruitmentOffers: [draftOffer({ id: 'rof-g', readReceipts: [{ revisionId: 'rofr-1', viewerKind: 'guardian', ...(g === undefined ? {} : { viewerId: g }), firstViewedAt: NOW }] })] }), 'recruitment_offers rof-g'],
  ];
  for (const [kind, records, where] of kinds) {
    const tag = kind.replace(/\W+/g, '-'); const quoted = new RegExp(`CONTACTS_OFFERS_GUARDIAN_MISSING[\\s\\S]*${where} → ""[\\s\\S]*Q8c-b`);
    // the cutover: refused with the ids, the empty id rendered quoted (never a blank); nothing written; the next boot refuses the same way
    { const dd = tempDir(`s8c-empty-g-${tag}`); preS8cFile(dd, records('')); const s = openRaw(dd); const before = fullDump(s); const bl = COLLECTIONS.map((n) => blobText(s, n));
      const e = refused(() => migrateAll(s), quoted, `${kind}: cutover`); assert.doesNotMatch(e.message, new RegExp(`${where} → (;|\\)|,|$)`, 'm'), `${kind}: the empty id never reads as a blank`);
      assert.equal(s.isTransaction, false); assert.equal(fullDump(s), before, `${kind}: nothing written`); assert.deepEqual(COLLECTIONS.map((n) => blobText(s, n)), bl); assert.equal(applied(s).includes(MIGRATION), false);
      refused(() => migrateAll(s), quoted, `${kind}: cutover (again)`); s.close(); rm(dd); }
    // the controls at the cutover: a null guardian id and an absent guardian id are no reference and import
    for (const [ctl, g] of [['null', null], ['absent', undefined]]) { const dd = file(`empty-g-${tag}-${ctl}`, records(g)); withRo(dd, (s) => { assert.ok(applied(s).includes(MIGRATION), `${kind}: the ${ctl} control imports`); assert.equal(s.prepare('SELECT count(*) AS n FROM recruitment_contacts').get().n + s.prepare('SELECT count(*) AS n FROM recruitment_offers').get().n, 1, `${kind}: the ${ctl} control's record is in the tables`); }); rm(dd); }
    // the snapshot write: the same record supplied to a live file is refused by the preflight with the quoted id, atomically; the null and absent controls land
    { const dd = file(`empty-g-${tag}-snap`); const L = snapshotOpen(dd); const before = withRo(dd, fullDump); const rev = L.revision();
      const supplied = (g) => { const r = records(g); return { recruitmentContacts: [...plain(L.db.recruitmentContacts), ...r.recruitmentContacts], recruitmentOffers: [...plain(L.db.recruitmentOffers), ...r.recruitmentOffers] }; };
      const e = refused(() => L.save(supplied(''), { omit: ['requests', 'trials'] }), quoted, `${kind}: snapshot write`); assert.doesNotMatch(e.message, new RegExp(`${where} → (;|\\)|,|$)`, 'm'));
      assert.equal(withRo(dd, fullDump), before, `${kind}: atomic`); assert.equal(L.revision(), rev); assert.equal(L.store.sqlite.isTransaction, false);
      L.save(supplied(null), { omit: ['requests', 'trials'] }); assert.ok(L.revision() > rev, `${kind}: the null control lands`);
      L.save(supplied(undefined), { omit: ['requests', 'trials'] }); withRo(dd, (s) => assert.equal(s.prepare("SELECT count(*) AS n FROM recruitment_contacts WHERE id = 'rct-g'").get().n + s.prepare("SELECT count(*) AS n FROM recruitment_offers WHERE id = 'rof-g'").get().n, 1, `${kind}: the absent control lands`));
      L.close(); rm(dd); }
  }
});

// ------------------------------------------------------------- the rollback
test('[cutover] the copy-only rollback: the source is never modified (the main file\'s bytes, the WAL, the logical content and the revision); the copy gets the two blobs back in insertion order in the writers\' literals (keys reassembled, every post-cutover edit and every pointer kept), idempotency_keys rebuilt to the S8b CHECK with the S8c owner rows removed and every S8a/S8b row byte for byte, the S8b key-format marker untouched, the nine tables dropped, the 0017 record and meta key removed, the revision advanced, every other table untouched; refusals leave no output (NOT_CUT_OVER, OUTPUT_NOT_EMPTY, FORMAT_UNSUPPORTED, a commit failure); the S8b tool refuses the 0017 file (LATER_SCHEMA) and accepts the output, the S8a tool the S8b output; re-upgrading the copy reproduces the tables exactly', () => {
  const d = tempDir('s8c-rb'); preS8cFile(d); { const s = openRaw(d); migrateAll(s); assert.ok(applied(s).includes(MIGRATION), 'migration 0017 applied'); s.close(); }
  needRollback(); needRco();
  // S8d: a live file of this build carries 0018, which the S8c tool refuses by design (LATER_SCHEMA); the chain step runs the S8d step-back first and the S8c tool on its output, with the S8c tool's result and refusals.
  const rollback = chainMod.rollbackToPreS8c;
  const L = serverOpen(d); L.repo.addOffer(draftOffer({ id: 'rof-after', revisions: [revision({ id: 'rofr-after' })], currentRevisionId: 'rofr-after', history: [] })); L.db.recruitmentContacts.find((c) => c.id === 'rct-1').subject = 'after the cutover'; L.save();
  const expected = L.repo.exportAll(); L.close();
  { const s = openRaw(d); s.exec('PRAGMA wal_checkpoint(TRUNCATE)'); s.close(); }
  const sha = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : 'absent');
  const sourceState = () => ({ main: sha(dbFile(d)), wal: fs.existsSync(`${dbFile(d)}-wal`) ? fs.statSync(`${dbFile(d)}-wal`).size : 0, logical: withRo(d, fullDump), saveSeq: withRo(d, (s) => meta(s, 'saveSeq')) });
  const sourceBefore = sourceState();
  const s8abBefore = withRo(d, (s) => JSON.stringify([...S8AB_TABLES.filter((t) => t !== 'idempotency_keys').map((t) => s.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()), s.prepare("SELECT * FROM idempotency_keys WHERE owner_table NOT IN ('recruitment_contacts', 'recruitment_offers') ORDER BY rowid").all()]));
  const out = tempDir('s8c-rb-out'); const result = rollback(dbFile(d), out);
  assert.equal(result.recruitmentContacts, 6); assert.equal(result.recruitmentOffers, 5); assert.deepEqual(sourceState(), sourceBefore, 'the source is untouched');
  const c = new DatabaseSync(dbFile(out), { readOnly: true });
  for (const n of COLLECTIONS) assert.deepEqual(blob(c, n), plain(expected[n]), `${n} blob`);
  assert.equal(blob(c, 'recruitmentOffers').find((o) => o.id === 'rof-4').currentRevisionId, 'rofr-missing', 'the unresolved pointer byte for byte'); assert.equal(blob(c, 'recruitmentContacts')[0].subject, 'after the cutover');
  for (const t of TABLES) assert.equal(tableExistsIn(c, t), false, `${t} dropped`); assert.equal(applied(c).includes(MIGRATION), false); assert.ok(applied(c).includes(S8B)); assert.equal(meta(c, 'recruitmentContactsOffersCutover'), undefined); assert.equal(meta(c, 'recruitmentCasesKeyFormat'), 'case-owned-keys/1', 'the S8b marker untouched');
  assert.equal(JSON.stringify([...S8AB_TABLES.filter((t) => t !== 'idempotency_keys').map((t) => c.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()), c.prepare('SELECT * FROM idempotency_keys ORDER BY rowid').all()]), s8abBefore, 'the S8a/S8b rows byte-identical');
  assert.doesNotMatch(ddlOf(c, 'idempotency_keys'), /recruitment_contacts|recruitment_offers/); assert.match(ddlOf(c, 'idempotency_keys'), /'room_decisions'/); assert.equal(c.prepare('PRAGMA foreign_key_check').all().length, 0); c.close();
  const notCut = tempDir('s8c-notcut'); preS8cFile(notCut); const o2 = tempDir('s8c-o2'); assert.throws(() => rollback(dbFile(notCut), o2), (e) => e.code === 'NOT_CUT_OVER'); assert.equal(fs.readdirSync(o2).length, 0);
  fs.writeFileSync(path.join(o2, 'x'), ''); assert.throws(() => rollback(dbFile(d), o2), (e) => e.code === 'OUTPUT_NOT_EMPTY');
  const o3 = tempDir('s8c-o3'); assert.throws(() => rollback(dbFile(d), o3, { _failBeforeCommit: true }), /synthetic commit failure/); assert.equal(fs.readdirSync(o3).length, 0); assert.deepEqual(sourceState(), sourceBefore);
  const fmt = tempDir('s8c-fmt'); fs.cpSync(d, fmt, { recursive: true }); { const s = openRaw(fmt); s.prepare('DELETE FROM meta WHERE key = ?').run('recruitmentCasesKeyFormat'); s.close(); } const o4 = tempDir('s8c-o4'); assert.throws(() => rollback(dbFile(fmt), o4), (e) => e.code === 'FORMAT_UNSUPPORTED'); assert.equal(fs.readdirSync(o4).length, 0);
  const { rollbackRecruitmentCasesCopy } = s8bRollbackMod; const chain = tempDir('s8c-chain'); assert.throws(() => rollbackRecruitmentCasesCopy(dbFile(d), chain), (e) => e.code === 'LATER_SCHEMA' && /0017_recruitment_contacts_offers/.test(e.message)); assert.equal(fs.readdirSync(chain).length, 0);
  rollbackRecruitmentCasesCopy(dbFile(out), chain); assert.ok(fs.existsSync(dbFile(chain)), 'the S8b tool accepts the S8c output');
  const up = openRaw(out); migrateAll(up); assert.deepEqual(plain(rco.readContacts(up)), plain(expected.recruitmentContacts)); assert.deepEqual(plain(rco.readOffers(up)), plain(expected.recruitmentOffers)); assert.equal(canon(up), withRo(d, canon), 're-upgrading the copy reproduces the live tables exactly'); up.close();
  rm(d, out, notCut, o2, o3, fmt, o4, chain);
});

console.log(`\n${passed} recruitment contacts/offers checks passed`);
