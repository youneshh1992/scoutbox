// S8c — recruitment contacts and offers as typed tables with EXPLICIT writes (repositories/recruitmentContactsOffers.mjs,
// migration 0017; docs/architecture/migration.md §4.3). What this suite proves: the migration creates the ten typed
// tables (no lossless side column, the deferred case and request keys); a fixture written through the repository types
// every field into its column and reads back the typed record, stops on a record it cannot type and names every missing
// reference with ids; the player references are counted, never refused (Q8c-a); the repository's operations write rows at once and return fresh read-only records; there is no db.* view
// (§4.3 step 2: a reader naming one throws) and every query matches a scan of the tables; a unit of work rolls the rows
// back and a read inside it sees its own writes; a contact may name a request the staged S8a repository writes at the
// same unit's COMMIT; the deletion unit's redactions.
// Temporary databases only; nothing touches DATA_DIR. Run with: npm test
import assert from 'node:assert/strict';
import { checkHistoryFeed } from './historyFeedCheck.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations } from '../repositories/database.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openStore } from '../store.mjs';
import { openLayer, readRecords } from './dataLayerFixture.mjs';
import { NOW, TTL, tempDir, hasBlobTable } from './coreIdentityTestFixtures.mjs';
import { p4bInvitation, minorInvitation, acceptedRequest, scheduledTrial, legacyTrialRequest, saveFixture } from './recruitmentTestFixtures.mjs';
import { S8B_FIX } from './recruitmentCasesTestFixtures.mjs';
import { draftContact, respondedContact, nullKeyContact, externalContact, cancelledContact, draftOffer, acceptedOffer, declinedOffer, withdrawnOffer, revision, contactRequest, S8C_FIX, persisted, TX } from './recruitmentContactsOffersTestFixtures.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const dbFile = (dir) => path.join(dir, 'scoutbox.db');
let counter = 9000; const nextId = (p) => `${p}-${++counter}`;
const MIGRATION = '0017_recruitment_contacts_offers';
const COLLECTIONS = ['recruitmentContacts', 'recruitmentOffers'];
const TABLES = ['recruitment_contacts', 'contact_attempts', 'contact_history', 'recruitment_offers', 'offer_revisions', 'offer_revision_documents', 'offer_responses', 'offer_read_receipts', 'offer_history', 'offer_keys'];
const mod = await import('../repositories/recruitmentContactsOffers.mjs');
const second = (dir) => new DatabaseSync(dbFile(dir), { readOnly: true });
const withRo = (dir, fn) => { const s = second(dir); try { return fn(s); } finally { s.close(); } };
const tableExistsIn = (s, t) => !!s.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
const plain = (v) => JSON.parse(JSON.stringify(v));
const fullDump = (s) => JSON.stringify(s.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => [r.name, s.prepare(`SELECT * FROM "${r.name}"`).all().map((x) => ({ ...x }))]));
const s8cDump = (s) => JSON.stringify(TABLES.map((t) => s.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().map((r) => ({ ...r }))));
const ddlOf = (s, t) => s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)?.sql ?? null;
const col = (s, sql, ...p) => { const r = s.prepare(sql).get(...p); return r ? Object.values({ ...r })[0] : undefined; };
const S8A_FIX = () => ({ requests: [acceptedRequest(p4bInvitation(), 'trial-1'), minorInvitation(), legacyTrialRequest()], trials: [scheduledTrial()] });
/** The typed expectation of a fixture: what every read returns. */
const typed = (name, raw) => { const t = (name === 'recruitmentContacts' ? mod.typeContact : mod.typeOffer)(persisted(raw)); assert.ok(t.ok, t.reason); return plain(t.record); };

/** The S8a–S8c fixtures as one fixture; `two` overrides a contact/offer collection (undefined omits it). */
function fixtureCollections({ more = {}, ...two } = {}) {
  const fix = S8C_FIX(); const db = { ...S8B_FIX(), ...S8A_FIX(), ...more };
  for (const name of COLLECTIONS) { const v = Object.hasOwn(two, name) ? two[name] : fix[name]; if (v !== undefined) db[name] = v; }
  return db;
}
const file = (tag, over = {}) => saveFixture(tempDir(`s8c-${tag}`), fixtureCollections(over));
const refused = (fn, pattern, label = '') => { let err = null; try { fn(); } catch (e) { err = e; } assert.ok(err, `${label}: expected a refusal`); assert.match(String(err.message), pattern, `${label}: ${err.message}`); assert.doesNotMatch(String(err.message), /next season|winter window|Yes please|Too far|Primary Parent|Adult Signup|Spoke on the phone/, `${label}: ids only, never a body, a note, a reply or a name`); return err; };
/** Write the fixtures, with `over`, into a new database and expect the write refused, atomically: no recruitment row written. */
const refusedSave = (tag, over, pattern) => {
  const d = tempDir(`s8c-ref-${tag}`);
  refused(() => saveFixture(d, fixtureCollections(over)), pattern, tag);
  assert.equal(withRo(d, (s) => TABLES.concat(['recruitment_cases', 'recruitment_requests', 'trials']).reduce((n, t) => n + col(s, `SELECT count(*) FROM ${t}`), 0)), 0, `${tag}: nothing written`); rm(d);
};
function serverOpen(dir) {
  const store = openStore(dir);
  const layer = attachDataLayer({ store, nextId, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  return { store, layer, unit: (w) => store.unitOfWork(w), repo: layer.recruitmentContactsOffers, recruitment: layer.recruitment, close: () => store.sqlite.close() };
}

// ------------------------------------------------------------- the schema and the typed fixtures

test('[schema] migration 0017 is registered before 0018 and creates the ten typed STRICT tables (no lossless side column, the case key immediate and the request key deferred to COMMIT, the vocabulary CHECKs); a fresh database holds no row and no blob; the fixtures written through the repository read back as the typed expectation, their keys as columns and offer_keys rows; the live counters count the historically missing player (Q8c-a); the step never runs twice', () => {
  const ids = DATA_MIGRATIONS.map((m) => m.id); assert.ok(ids.indexOf(MIGRATION) >= 0 && ids.indexOf(MIGRATION) < ids.indexOf('0018_signings_follow_ups'));
  for (const n of COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is table-backed`);
  const empty = tempDir('s8c-empty'); const E = openLayer(empty); const e = E.sqlite;
  for (const t of TABLES) { assert.ok(tableExistsIn(e, t), `${t} exists`); assert.equal(col(e, `SELECT count(*) FROM ${t}`), 0); assert.match(ddlOf(e, t), /STRICT/); assert.doesNotMatch(ddlOf(e, t), /absent_keys_json|offtype_json|extra_json|raw_json/, `${t} has no lossless side column`); }
  assert.match(ddlOf(e, 'recruitment_contacts'), /case_id TEXT NOT NULL REFERENCES recruitment_cases\(id\) ON DELETE RESTRICT,/);
  assert.match(ddlOf(e, 'recruitment_contacts'), /request_id TEXT REFERENCES recruitment_requests\(id\) DEFERRABLE INITIALLY DEFERRED/);
  assert.match(ddlOf(e, 'recruitment_contacts'), /status TEXT NOT NULL CHECK \(status IS NULL OR status IN \('draft','delivered','failed','responded','recorded','cancelled'\)\)/);
  assert.match(ddlOf(e, 'offer_revisions'), /internal_note TEXT CHECK \(internal_note IS NULL OR length\(internal_note\) <= 2000\)/);
  assert.doesNotMatch(ddlOf(e, 'idempotency_keys'), /'recruitment_contacts'|'recruitment_offers'/, 'the keys are the owners\' own columns');
  assert.equal(hasBlobTable(e), false, 'no blob table'); // rewritten in S14a: it described the blob
  E.close(); rm(empty);
  const d = file('schema'); const back = readRecords(d); const s = new DatabaseSync(dbFile(d)); s.exec('PRAGMA foreign_keys = ON');
  const after = fullDump(s); assert.deepEqual(runDataMigrations(s, DATA_MIGRATIONS, { now: NOW, context: { sessionTtlMs: TTL } }).ran, []); assert.equal(fullDump(s), after, 'never runs twice');
  const fix = S8C_FIX();
  assert.deepEqual(plain(back.recruitmentContacts), fix.recruitmentContacts.map((c) => typed('recruitmentContacts', c)));
  assert.deepEqual(plain(back.recruitmentOffers), fix.recruitmentOffers.map((o) => typed('recruitmentOffers', o)));
  assert.deepEqual(back.recruitmentContacts[2].keys.send, { key: null, fp: '{"contactId":"rct-3"}' }, 'the null-key send');
  assert.equal(Object.hasOwn(back.recruitmentOffers[1].revisions[2], 'discardedByResponseId'), true); assert.equal(Object.hasOwn(back.recruitmentOffers[1].revisions[1], 'discardedByResponseId'), false, 'only the discarded draft carries the pointer');
  assert.deepEqual(back.recruitmentOffers[2].lifecycle, { applied: false, action: 'considerOffer', from: 'offer_declined', to: 'offer_declined', at: TX.accepted + 60_000, reason: 'LIFECYCLE_NOT_ALLOWED', message: 'not from here', allowed: ['offer_accepted', 'withdrawn'] });
  assert.deepEqual(s.prepare("SELECT act, key, revision_id FROM offer_keys WHERE offer_id = 'rof-2' ORDER BY act, position").all().map((r) => [r.act, r.key, r.revision_id]), [['issue', 'k-issue-1', 'rofr-2'], ['issue', 'k-issue-2', 'rofr-3'], ['revise', 'k-rev-2', 'rofr-3'], ['revise', 'k-rev-3', 'rofr-4']]);
  assert.equal(col(s, "SELECT create_key FROM recruitment_contacts WHERE id = 'rct-1'"), 'k-create-1'); assert.equal(col(s, "SELECT record_key FROM recruitment_contacts WHERE id = 'rct-4'"), 'k-rec-4');
  assert.deepEqual(mod.unresolvedPlayerReferences(s), { recruitmentContacts: 1, recruitmentOffers: 2 }, 'pl-gone-long-ago: the cancelled contact; the withdrawn offer and its revision recipient');
  s.close(); rm(d);
});

test('[fixtures][typed] a write STOPS with the id on a record the columns cannot hold — nothing written: an unknown status, a subject over 120 characters, an unknown field (top level and nested), an off-type rev, a list that is not a list, a current revision the offer does not hold, a response naming another offer\'s revision, two answers to one revision, a receipt naming a missing revision; a contact naming a case or a request that is not there', () => {
  const C = (over) => ({ recruitmentContacts: [draftContact(over)] });
  const O = (o) => ({ recruitmentOffers: [o] });
  refusedSave('status', C({ status: 'sent' }), /CONTACTS_OFFERS_INPUT_INVALID[\s\S]*recruitmentContacts rct-1\.status must be one of draft\|delivered/);
  refusedSave('subject', C({ subject: 'x'.repeat(121) }), /rct-1\.subject exceeds 120 characters/);
  refusedSave('unknown', C({ legacyFlag: 'kept' }), /rct-1\.record\.legacyFlag is not a field this table stores/);
  refusedSave('nested', C({ emailCopy: { state: 'queued', to: 'guardian', outboxId: null, at: NOW, extra: 1 } }), /rct-1\.emailCopy\.extra is not a field this table stores/);
  refusedSave('rev', C({ rev: '1' }), /rct-1\.rev must be an integer or null \(got string\)/);
  refusedSave('attempts', C({ attempts: { not: 'a list' } }), /rct-1\.attempts must be a list/);
  refusedSave('current', O(draftOffer({ currentRevisionId: 'rofr-missing' })), /rof-1\.currentRevisionId names rofr-missing, not a revision of this offer/);
  const foreign = acceptedOffer(); foreign.responses[0].revisionId = 'rofr-1';
  refusedSave('foreign', O(foreign), /rof-2\.responses rofa-1\.revisionId names rofr-1, not a revision of this offer/);
  const twice = acceptedOffer(); twice.responses.push({ ...twice.responses[0], id: 'rofa-9', clientKey: null });
  refusedSave('twice', O(twice), /rof-2\.responses answer revision rofr-3 twice/);
  refusedSave('receipt', O(draftOffer({ readReceipts: [{ revisionId: 'rofr-x', viewerKind: 'player', viewerId: 'pl-adult', firstViewedAt: NOW }] })), /rof-1\.readReceipts name rofr-x, not a revision of this offer/);
  refusedSave('actor-empty', { recruitmentOffers: [acceptedOffer({ responses: [{ ...acceptedOffer().responses[0], actorId: '' }] })] }, /rof-2 responses\[0\]\.actorId must not be empty/);
  refusedSave('case', C({ caseId: 'case-nowhere' }), /CONTACTS_OFFERS_REFERENCE_MISSING[\s\S]*recruitment_contacts holds 1 row\(s\) naming a recruitment_cases row that is not there \(rct-1 → recruitment_cases case-nowhere\)/);
  refusedSave('request', C({ status: 'delivered', requestId: 'req-nowhere', recipient: { type: 'player', playerId: 'pl-adult', guardianId: null, minor: false } }), /FOREIGN KEY constraint failed/); // the deferred request key, at COMMIT
});

// ------------------------------------------------------------- the repository

test('[repository] explicit writes: there is no db.* view (reading or assigning db.recruitmentContacts / db.recruitmentOffers throws, naming the repository); every returned record is read-only (a field assignment and a nested push throw); create and update write their rows at once — a second connection sees them with no save — and return the fresh record; update hands out a plain copy, types the result whole and refuses junk, a changed identifier and an unknown id; nothing is written by a save; a reopen serves the same records', () => {
  const d = file('repo'); const L = serverOpen(d); const { contacts, offers } = L.repo;
  assert.throws(() => { contacts.byId('rct-1').status = 'cancelled'; }, TypeError);
  assert.throws(() => { offers.byId('rof-2').revisions[0].documents.push({}); }, TypeError);
  const created = contacts.create(draftContact({ id: 'rct-new', keys: { create: null, send: null, record: null }, history: [] }));
  assert.equal(created.id, 'rct-new'); assert.throws(() => { created.subject = 'x'; }, TypeError);
  withRo(d, (s) => assert.equal(col(s, "SELECT status FROM recruitment_contacts WHERE id = 'rct-new'"), 'draft', 'written at once'));
  refused(() => contacts.create(draftContact({ id: 'rct-new' })), /CONTACTS_OFFERS_DUPLICATE: recruitment_contacts rct-new already exists/);
  const edited = contacts.update('rct-new', (draft) => { draft.subject = 'Edited'; draft.history.push({ id: 'aud-e1', at: NOW, action: 'contact_edited', by: { kind: 'org', userId: 'usr-1', name: 'Maria' }, detail: { fields: ['subject'] } }); draft.rev = 2; });
  assert.equal(edited.subject, 'Edited'); assert.equal(contacts.byId('rct-new').history.length, 1);
  withRo(d, (s) => { assert.equal(col(s, "SELECT subject FROM recruitment_contacts WHERE id = 'rct-new'"), 'Edited'); assert.equal(col(s, "SELECT action FROM contact_history WHERE contact_id = 'rct-new'"), 'contact_edited'); });
  refused(() => contacts.update('rct-new', (draft) => { draft.subject = 42; }), /CONTACTS_OFFERS_INPUT_INVALID: recruitmentContacts rct-new\.subject must be text or null/);
  refused(() => contacts.update('rct-new', (draft) => { draft.caseId = 'case-2'; }), /rct-new: caseId cannot change/);
  refused(() => contacts.update('rct-nowhere', () => {}), /CONTACTS_OFFERS_NOT_FOUND/);
  assert.equal(contacts.byId('rct-new').subject, 'Edited', 'a refused update changed nothing');
  const o = offers.update('rof-1', (draft) => { draft.revisions.push(revision({ id: 'rofr-n', revisionNumber: 2 })); draft.currentRevisionId = 'rofr-n'; draft.keys.revise.push({ key: 'k-n', revisionId: 'rofr-n' }); draft.rev = 2; });
  assert.equal(o.revisions.length, 2); withRo(d, (s) => { assert.equal(col(s, "SELECT count(*) FROM offer_revisions WHERE offer_id = 'rof-1'"), 2); assert.equal(col(s, "SELECT key FROM offer_keys WHERE offer_id = 'rof-1'"), 'k-n'); });
  refused(() => offers.update('rof-1', (draft) => { draft.currentRevisionId = 'rofr-2'; }), /rof-1\.currentRevisionId names rofr-2, not a revision of this offer/);
  const dump = withRo(d, s8cDump); assert.equal(withRo(d, s8cDump), dump, 'a save writes no S8c row');
  const served = plain(L.repo.exportAll()); L.close();
  const R = serverOpen(d); assert.deepEqual(plain(R.repo.exportAll()), served); R.close(); rm(d);
});

test('[repository] SQL reads (§4.3 step 2): byId and every list query return exactly the records a scan of the tables would, in insertion order; an unknown or non-text id reads null; forPlayers takes several players and ignores junk; the read-only `reads` object carries the queries and no write', () => {
  const d = file('reads'); const L = serverOpen(d); const { contacts, offers, reads } = L.repo;
  const all = { contacts: mod.readContacts(L.store.sqlite), offers: mod.readOffers(L.store.sqlite) };
  assert.ok(all.contacts.length >= 5 && all.offers.length >= 4, 'the fixture has records to query');
  const ids = (rows) => rows.map((r) => r.id);
  const values = (list, key) => [...new Set(list.map((r) => key(r)).filter((v) => v !== null && v !== undefined)), 'nobody'];
  for (const c of all.contacts) assert.deepEqual(plain(contacts.byId(c.id)), plain(c));
  for (const o of all.offers) assert.deepEqual(plain(offers.byId(o.id)), plain(o));
  for (const bad of ['rct-nowhere', undefined, null, 42]) { assert.equal(contacts.byId(bad), null); assert.equal(offers.byId(bad), null); }
  const check = (label, got, want) => assert.deepEqual(ids(got), ids(want), label);
  for (const v of values(all.contacts, (c) => c.caseId)) check(`contacts.forCase ${v}`, contacts.forCase(v), all.contacts.filter((c) => c.caseId === v));
  for (const v of values(all.contacts, (c) => c.playerId)) check(`contacts.forPlayer ${v}`, contacts.forPlayer(v), all.contacts.filter((c) => c.playerId === v));
  for (const v of values(all.contacts, (c) => c.orgId)) check(`contacts.forOrg ${v}`, contacts.forOrg(v), all.contacts.filter((c) => c.orgId === v));
  for (const v of values(all.contacts, (c) => c.requestId)) check(`contacts.forRequest ${v}`, contacts.forRequest(v), all.contacts.filter((c) => c.requestId === v));
  for (const v of values(all.contacts, (c) => c.routingSnapshot?.agent?.agentUserId)) check(`contacts.forAgent ${v}`, contacts.forAgent(v), all.contacts.filter((c) => c.routingSnapshot?.agent?.agentUserId === v));
  for (const c of all.contacts) check(`contacts.forOrgPlayer ${c.orgId}/${c.playerId}`, contacts.forOrgPlayer(c.orgId, c.playerId), all.contacts.filter((x) => x.orgId === c.orgId && x.playerId === c.playerId));
  for (const v of values(all.offers, (o) => o.caseId)) check(`offers.forCase ${v}`, offers.forCase(v), all.offers.filter((o) => o.caseId === v));
  for (const v of values(all.offers, (o) => o.playerId)) check(`offers.forPlayer ${v}`, offers.forPlayer(v), all.offers.filter((o) => o.playerId === v));
  for (const v of values(all.offers, (o) => o.orgId)) check(`offers.forOrg ${v}`, offers.forOrg(v), all.offers.filter((o) => o.orgId === v));
  for (const v of values(all.offers, (o) => o.agentShare?.agentUserId)) check(`offers.forAgentShare ${v}`, offers.forAgentShare(v), all.offers.filter((o) => o.agentShare?.agentUserId === v));
  for (const o of all.offers) check(`offers.forOrgPlayer ${o.orgId}/${o.playerId}`, offers.forOrgPlayer(o.orgId, o.playerId), all.offers.filter((x) => x.orgId === o.orgId && x.playerId === o.playerId));
  const players = values(all.offers, (o) => o.playerId);
  check('offers.forPlayers (all, with junk and a repeat)', offers.forPlayers([...players, players[0], 42, null]), all.offers.filter((o) => players.includes(o.playerId)));
  assert.deepEqual(offers.forPlayers([]), []); assert.deepEqual(offers.forPlayers(undefined), []);
  for (const r of [...contacts.forOrg(all.contacts[0].orgId), ...offers.forOrg(all.offers[0].orgId)]) assert.ok(Object.isFrozen(r), 'a listed record is read-only');
  for (const name of ['contacts', 'offers']) {
    assert.ok(Object.isFrozen(reads[name]));
    for (const w of ['create', 'update', 'redactPlayer']) assert.equal(reads[name][w], undefined, `reads.${name} has no ${w}`);
    assert.equal(reads[name].byId, L.repo[name].byId);
  }
  assert.deepEqual(L.repo.counts(), { recruitmentContacts: all.contacts.length, recruitmentOffers: all.offers.length });
  checkHistoryFeed('contacts.historyFeed', { feed: L.repo.contacts.historyFeed, count: L.repo.contacts.historyCount, records: all.contacts, ownerKey: 'contactId' });
  L.close(); rm(d);
});

test('[repository] a unit of work: a contact written in a unit together with the request it names — a NEW request the staged S8a repository writes at the same COMMIT (the deferred key) — commits; a read inside the unit sees the unit\'s own writes; a unit that throws after its writes rolls the rows back (the records held before read the pre-unit values, and a fresh read the stored ones); a contact naming a request that never arrives fails at COMMIT and nothing lands', () => {
  const d = file('unit'); const L = serverOpen(d); const { contacts } = L.repo;
  const sent = (id, requestId) => draftContact({ id, status: 'delivered', recipient: { type: 'player', playerId: 'pl-adult', guardianId: null, minor: false }, requestId, sentAt: NOW, deliveredAt: NOW, attempts: [{ at: NOW, ok: true, code: null }], keys: { create: null, send: { key: null, fp: `{"contactId":"${id}"}` }, record: null }, history: [] });
  L.unit(() => { L.recruitment.requests.create(contactRequest('req-new', 'rct-new')); contacts.create(sent('rct-new', 'req-new')); });
  withRo(d, (s) => { assert.equal(col(s, "SELECT request_id FROM recruitment_contacts WHERE id = 'rct-new'"), 'req-new'); assert.equal(col(s, "SELECT contact_id FROM recruitment_requests WHERE id = 'req-new'"), 'rct-new'); });
  const held = L.repo.contacts.byId('rct-1'); const before = withRo(d, fullDump);
  assert.throws(() => L.unit(() => {
    contacts.update('rct-1', (x) => { x.subject = 'In the unit'; }); contacts.create(draftContact({ id: 'rct-gone', history: [] }));
    assert.equal(contacts.byId('rct-1').subject, 'In the unit', 'a read inside the unit sees its update'); assert.ok(contacts.forCase(contacts.byId('rct-gone').caseId).some((c) => c.id === 'rct-gone'), 'and its create');
    throw new Error('synthetic unit failure');
  }), /synthetic unit failure/);
  assert.equal(withRo(d, fullDump), before, 'the rows rolled back'); assert.equal(held.subject, 'Next season'); assert.equal(L.repo.contacts.byId('rct-1').subject, 'Next season'); assert.equal(L.repo.contacts.byId('rct-gone'), null, 'a fresh read sees the rollback');
  assert.throws(() => L.unit(() => { contacts.create(sent('rct-dangling', 'req-never')); }), /FOREIGN KEY constraint failed/);
  assert.equal(withRo(d, fullDump), before); assert.equal(L.repo.contacts.byId('rct-dangling'), null); assert.equal(L.store.sqlite.isTransaction, false);
  L.close(); rm(d);
});

test('[repository] the deletion unit\'s redactions: the contacts about the player lose the reply\'s words and keep everything else; the offers keep ids, states and times and lose the player\'s name and words (a PLAYER response\'s name and reason, a PLAYER history name) and gain subject_removed_at; a guardian\'s answer and other players\' records are untouched', () => {
  const playerAnswer = { ...acceptedOffer().responses[0], id: 'rofa-p', revisionId: 'rofr-1', responseType: 'declined', actorType: 'player', actorId: 'pl-adult', actorName: 'Adult Signup', forPlayerId: 'pl-adult', reason: 'Too far', clientKey: null };
  const answered = draftOffer({ status: 'DECLINED', revisions: [revision({ status: 'DECLINED', issuedAt: TX.issued, issuedBy: acceptedOffer().createdBy, expiresAt: TX.issued + 86_400_000, respondedAt: TX.accepted, response: { id: 'rofa-p' }, recipientSnapshot: { type: 'player', playerId: 'pl-adult', guardianId: null, minor: false, at: TX.issued } })], responses: [playerAnswer], history: [{ id: 'aud-p', at: TX.accepted, action: 'offer_declined', by: { kind: 'player', id: 'pl-adult', name: 'Adult Signup' }, detail: null }] });
  const replied = nullKeyContact({ status: 'responded', respondedAt: TX.answered, response: { kind: 'accepted', message: 'Yes please', by: 'player', at: TX.answered } });
  const d = file('redact', { recruitmentContacts: [draftContact(), respondedContact(), replied], recruitmentOffers: [answered, acceptedOffer()] }); const L = serverOpen(d);
  L.unit(() => { L.repo.contacts.redactPlayer('pl-adult'); L.repo.offers.redactPlayer('pl-adult', NOW); });
  withRo(d, (s) => {
    assert.equal(col(s, "SELECT response_message FROM recruitment_contacts WHERE id = 'rct-3'"), null); assert.equal(col(s, "SELECT response_kind FROM recruitment_contacts WHERE id = 'rct-3'"), 'accepted');
    assert.equal(col(s, "SELECT response_message FROM recruitment_contacts WHERE id = 'rct-2'"), 'Yes please', 'another player\'s reply is untouched');
    assert.deepEqual({ ...s.prepare("SELECT actor_name, reason, response_type FROM offer_responses WHERE id = 'rofa-p'").get() }, { actor_name: null, reason: null, response_type: 'declined' });
    assert.equal(col(s, "SELECT by_name FROM offer_history WHERE id = 'aud-p'"), null); assert.equal(col(s, "SELECT subject_removed_at FROM recruitment_offers WHERE id = 'rof-1'"), NOW);
    assert.equal(col(s, "SELECT subject_removed_at FROM recruitment_offers WHERE id = 'rof-2'"), TX.removed, 'another player\'s offer is untouched');
  });
  assert.equal(L.repo.offers.byId('rof-1').responses[0].actorName, null, 'a read follows the redaction');
  L.close(); rm(d);
});

test('[capabilities] the live report: explicit write mode, no pending writes, the typed tables and the player counters', () => {
  const d = file('caps', { recruitmentContacts: [draftContact(), cancelledContact()] }); const L = serverOpen(d);
  const r = L.layer.report().domains.recruitmentContactsOffers;
  assert.equal(r.pendingWrites, 0); assert.match(r.writeMode, /^explicit/); assert.deepEqual(r.rows, { recruitmentContacts: 2, recruitmentOffers: 4 });
  assert.deepEqual(r.unresolvedPlayerReferences, { recruitmentContacts: 1, recruitmentOffers: 2 }); assert.equal(Object.hasOwn(r, 'unresolvedPointerReferences'), false);
  L.close(); rm(d);
});

console.log(`${passed} recruitment contacts/offers checks passed`);
