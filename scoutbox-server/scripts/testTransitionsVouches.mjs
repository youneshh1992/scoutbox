// S10c — transition cases and coach references (vouches) as typed tables with explicit writes
// (repositories/transitionsVouches.mjs, migration 0025). What this suite proves: the migration creates the five STRICT
// tables (no JSON column) and a fresh database holds no row; the typers refuse junk
// with the record and field named (an unknown field, an empty pack, a history detail that does not fit its action, a
// plain code, a published reference without text); a case is created with its pack, grants and history and read back
// whole; an update keeps the pack, owner and period, only adds grants (a revocation happens once) and only grows the
// history; a reference code is stored only as its hash, found by the code as typed, single use and unique; the club,
// sweep and T&S queries answer what the routes need; a rolled-back unit leaves nothing; db.transitionCases and
// db.vouches throw; and the snapshot write types, names a missing organisation and reads back
// what it wrote. Temporary databases only; nothing touches DATA_DIR. Run with: npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED, readTableBacked } from '../repositories/index.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir } from './coreIdentityTestFixtures.mjs';
import { saveFixture, ORG } from './recruitmentTestFixtures.mjs';
import {
  TRANSITIONS_MIGRATION as MIGRATION, TRANSITIONS_TABLES as TABLES, TRANSITIONS_COLLECTIONS as COLLECTIONS,
  typeTransitionCase, typeVouch, vouchCodeHash,
} from '../repositories/transitionsVouches.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
let counter = 9000; const nextId = (p) => `${p}-${++counter}`;
const refused = (fn, pattern, label = '') => {
  let err = null; try { fn(); } catch (e) { err = e; }
  assert.ok(err, `${label}: expected a refusal`); assert.match(String(err.message), pattern, `${label}: ${err.message}`);
  return err;
};
const DAY = 86_400_000;

// ------------------------------------------------------------- fixtures: the literals the routes write
const PID = 'pl-1';
const PLAYER = { kind: 'player', id: PID, name: 'Kola' };
const hist = (id, action, detail = null, over = {}) => ({ id, at: NOW, byKind: 'player', byId: PID, byName: 'Kola', action, detail, ...over });
/** createTransition (domains/verification/transitions.mjs). */
const transition = (over = {}) => ({
  id: 'trn-1', playerId: PID, playerName: 'Kola', startedBy: { ...PLAYER }, note: 'After the academy', pack: { mediaIds: ['med-1'], evidenceIds: [], feedbackIds: [] },
  periodEndsAt: NOW + 60 * DAY, recipients: [], status: 'open', placement: null, followUp: null, createdAt: NOW,
  history: [hist('aud-1', 'opened', { items: 1 })], ...over,
});
/** addRecipient. */
const grant = (over = {}) => ({ orgId: ORG.id, orgName: ORG.name, grantedAt: NOW, expiresAt: NOW + 30 * DAY, revokedAt: null, viewedAt: null, ...over });
/** createVouchRequest (server.mjs). */
const vouch = (over = {}) => ({
  id: 'vch-1', playerId: PID, playerName: 'Kola', coachName: 'Ade Balogun', coachEmail: 'ade@example.test', role: 'Coach',
  status: 'pending', codeHash: vouchCodeHash('ABCD2345'), text: null, seasons: null, ts: NOW, publishedAt: null, conflictOfInterest: null, withdrawn: null, ...over,
});

function serverOpen(dir) {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = {}; // S14a: a fixture-saved file is not a first installation, so there is nothing to hand in
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  const snapshot = () => ({ savedAt: NOW, idCounter: 1000, db });
  return { store, db, repo: layer.transitionsVouches, unit: (w) => store.unitOfWork(w, { snapshot }), close: () => store.sqlite.close() };
}

// ------------------------------------------------------------- schema
test('[schema] 0025 is registered after 0024 and creates the five STRICT tables (no JSON column), empty on a fresh database', () => {
  const ids = DATA_MIGRATIONS.map((m) => m.id);
  assert.equal(ids.indexOf(MIGRATION), ids.indexOf('0024_passport') + 1);
  for (const n of COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is table-backed`);
  const dir = tempDir('s10c-empty'); const s = openStore(dir).sqlite;
  for (const t of TABLES) {
    assert.match(s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql, /STRICT\s*$/, `${t} is STRICT`);
    assert.equal(s.prepare(`SELECT count(*) AS n FROM ${t}`).get().n, 0);
    assert.ok(!s.prepare(`PRAGMA table_info(${t})`).all().some((c) => /_json$/.test(c.name)), `${t}: no JSON column`);
  }
  assert.ok(!s.prepare('PRAGMA table_info(vouches)').all().some((c) => c.name === 'code'), 'no plain code column');
  s.close(); rm(dir);
});

// ------------------------------------------------------------- typing
test('[typing] the typers refuse junk with the record and field named', () => {
  assert.equal(typeTransitionCase(transition()).ok, true);
  assert.deepEqual(typeTransitionCase(transition()).record.caseOwner, PLAYER, 'caseOwner is startedBy');
  assert.match(typeTransitionCase(transition({ sneaky: 1 })).reason, /trn-1 carries field\(s\) this build does not store: sneaky/);
  assert.match(typeTransitionCase(transition({ pack: { mediaIds: [], evidenceIds: [], feedbackIds: [] } })).reason, /pack holds no item/);
  assert.match(typeTransitionCase(transition({ pack: { mediaIds: ['m', 'm'] } })).reason, /pack\.mediaIds names an entry twice/);
  assert.match(typeTransitionCase(transition({ pack: { notes: ['x'] } })).reason, /pack carries field/);
  assert.match(typeTransitionCase(transition({ status: 'released' })).reason, /status must be one of/);
  assert.match(typeTransitionCase(transition({ status: 'placed' })).reason, /placement is set exactly when the case is placed/);
  assert.match(typeTransitionCase(transition({ caseOwner: { kind: 'guardian', id: 'gd-1', name: 'G' } })).reason, /caseOwner is always who started/);
  assert.match(typeTransitionCase(transition({ history: [hist('aud-1', 'opened', { orgId: ORG.id })] })).reason, /detail must be \{ items \} for opened/);
  assert.match(typeTransitionCase(transition({ history: [hist('aud-1', 'withdrawn', { items: 1 })] })).reason, /detail must be null for withdrawn/);
  assert.match(typeTransitionCase(transition({ recipients: [grant({ expiresAt: NOW - 1 })] })).reason, /expiresAt is before the grant/);
  assert.equal(typeVouch(vouch()).ok, true);
  assert.equal(typeVouch(vouch()).record.verificationMethod, 'email_code');
  assert.match(typeVouch(vouch({ code: 'ABCD2345' })).reason, /carries field\(s\) this build does not store: code/);
  assert.match(typeVouch(vouch({ codeHash: 'ABCD2345' })).reason, /codeHash must be a SHA-256 hex digest/);
  assert.match(typeVouch(vouch({ status: 'published', codeHash: null })).reason, /text and publishedAt are required once published/);
  assert.match(typeVouch(vouch({ status: 'published', text: 'Good.', publishedAt: NOW })).reason, /codeHash is held exactly while the reference is pending/);
  assert.match(typeVouch(vouch({ identityVerified: true })).reason, /identityVerified is always false/);
  assert.match(typeVouch(vouch({ coachName: '' })).reason, /coachName must not be empty/);
});

// ------------------------------------------------------------- writes and reads
test('[cases] a case is created whole and read back; an update keeps the pack, owner and period, only adds grants (revoked once) and only grows the history', () => {
  const dir = tempDir('s10c-cases'); saveFixture(dir);
  const s = serverOpen(dir);
  const T = s.repo.transitionCases;
  try {
    const t = T.create(transition({ pack: { mediaIds: ['med-2', 'med-1'], evidenceIds: ['ev-1'], feedbackIds: [] } }));
    assert.ok(Object.isFrozen(t) && Object.isFrozen(t.pack.mediaIds), 'deep-frozen');
    assert.deepEqual(t.pack, { mediaIds: ['med-2', 'med-1'], evidenceIds: ['ev-1'], feedbackIds: [] }, 'the pack keeps its order');
    assert.deepEqual(t.history, [hist('aud-1', 'opened', { items: 1 })]);
    refused(() => T.create(transition()), /already exists/, 'duplicate id');
    const g = T.update('trn-1', (d) => { d.recipients.push(grant()); d.history.push(hist('aud-2', 'recipient_added', { orgId: ORG.id })); });
    assert.deepEqual(g.recipients, [grant()]);
    assert.deepEqual(T.grantedTo(ORG.id, NOW).map((x) => x.id), ['trn-1'], 'the club sees the case it holds a live grant for');
    assert.deepEqual(T.grantedTo(ORG.id, NOW + 31 * DAY), [], 'not after the grant expired');
    refused(() => T.update('trn-1', (d) => { d.recipients.push(grant({ orgId: 'org-none' })); }), /FOREIGN KEY/, 'a grant to a missing organisation');
    refused(() => T.update('trn-1', (d) => { d.pack.mediaIds.push('med-9'); }), /pack cannot change/, 'pack change');
    refused(() => T.update('trn-1', (d) => { d.startedBy.id = 'pl-9'; }), /startedBy|caseOwner/, 'owner change');
    refused(() => T.update('trn-1', (d) => { d.periodEndsAt += DAY; }), /periodEndsAt cannot change/, 'period change');
    refused(() => T.update('trn-1', (d) => { d.recipients = []; }), /a grant cannot be removed/, 'grant removed');
    refused(() => T.update('trn-1', (d) => { d.recipients[0].expiresAt += DAY; }), /keeps its organisation and dates/, 'grant extended');
    refused(() => T.update('trn-1', (d) => { d.history.pop(); }), /only grows/, 'history dropped');
    refused(() => T.update('trn-1', () => { T.update('trn-1', () => {}); }), /already being updated/, 'nested update');
    const r = T.update('trn-1', (d) => { d.recipients[0].revokedAt = NOW + 1; d.history.push(hist('aud-3', 'recipient_revoked', { orgId: ORG.id })); });
    assert.equal(r.recipients[0].revokedAt, NOW + 1);
    assert.deepEqual(T.grantedTo(ORG.id, NOW), [], 'a revoked grant shows nothing');
    refused(() => T.update('trn-1', (d) => { d.recipients[0].revokedAt = NOW + 2; }), /already revoked/, 'revoked twice');
    const p = T.update('trn-1', (d) => {
      d.status = 'placed'; d.placement = { orgId: ORG.id, orgName: ORG.name, at: NOW, note: 'U21s' }; d.followUp = { dueAt: NOW + 60 * DAY, notifiedAt: null };
      d.history.push(hist('aud-4', 'placed', { orgId: ORG.id }));
    });
    assert.equal(p.status, 'placed'); assert.equal(p.history.length, 4); assert.deepEqual(p.followUp, { dueAt: NOW + 60 * DAY, notifiedAt: null });
    assert.deepEqual(T.followUpsDue(NOW + 61 * DAY).map((x) => x.id), ['trn-1']);
    T.update('trn-1', (d) => { d.followUp.notifiedAt = NOW + 61 * DAY; });
    assert.deepEqual(T.followUpsDue(NOW + 62 * DAY), [], 'a check-in is sent once');
    T.create(transition({ id: 'trn-2', history: [hist('aud-5', 'opened', { items: 1 })] }));
    assert.deepEqual(T.expiredBy(NOW + 61 * DAY).map((x) => x.id), ['trn-2'], 'only open cases expire');
    assert.deepEqual(T.forPlayers([PID, 'pl-other']).map((x) => x.id), ['trn-1', 'trn-2']);
    assert.equal(typeof s.repo.reads.transitionCases.update, 'undefined', 'the reads carry no writes');
    refused(() => T.update('trn-2', (d) => { d.recipients.push(grant({ grantedAt: NOW + 61 * DAY, expiresAt: NOW + 60 * DAY })); }), /expiresAt is before the grant/, 'a grant after the period ended (the route answers 409 CASE_CLOSED first)');
  } finally { s.close(); rm(dir); }
});

test('[vouches] a code is stored only as its hash, found by the code as typed, single use and unique; published and T&S reads', () => {
  const dir = tempDir('s10c-vouches'); saveFixture(dir);
  const s = serverOpen(dir);
  const V = s.repo.vouches;
  try {
    V.create(vouch());
    const row = s.store.sqlite.prepare('SELECT * FROM vouches WHERE id = ?').get('vch-1');
    assert.equal(row.code_hash, vouchCodeHash('ABCD2345')); assert.ok(!JSON.stringify(row).includes('ABCD2345'), 'the plain code is nowhere in the row');
    assert.equal(V.pendingByCode(' abcd2345 ').id, 'vch-1', 'the code as typed: trimmed, any case');
    assert.equal(V.pendingByCode('WRONG000'), null);
    refused(() => V.create(vouch({ id: 'vch-2' })), /that code is already issued/, 'a second reference with the same code');
    assert.deepEqual(V.publishedFor(PID), [], 'pending is not published');
    const pub = V.update('vch-1', (d) => { d.status = 'published'; d.text = 'Reliable.'; d.publishedAt = NOW; d.codeHash = null; });
    assert.equal(pub.codeHash, null); assert.equal(V.pendingByCode('ABCD2345'), null, 'single use');
    refused(() => V.update('vch-1', (d) => { d.codeHash = vouchCodeHash('NEW12345'); }), /a code is issued once|codeHash is held exactly/, 'a code re-issued');
    refused(() => V.update('vch-1', (d) => { d.coachEmail = 'other@example.test'; }), /coachEmail cannot change/, 'identity change');
    assert.deepEqual(V.publishedFor(PID).map((v) => v.id), ['vch-1']);
    V.update('vch-1', (d) => { d.withdrawn = { at: NOW, by: 'admin', reason: 'withdrawn by Trust & Safety' }; });
    assert.deepEqual(V.publishedFor(PID), [], 'a withdrawn reference leaves every profile');
    assert.equal(V.forPlayer(PID).length, 1, 'the player still sees it in their own list');
    V.create(vouch({ id: 'vch-2', codeHash: null, coachEmail: null, status: 'published', text: 'A season of graft.', publishedAt: NOW }));
    V.create(vouch({ id: 'vch-3', codeHash: vouchCodeHash('ZZZZ9999') }));
    const first = V.page({ limit: 2 }).rows;
    assert.deepEqual(first.map((r) => r.record.id), ['vch-3', 'vch-2', 'vch-1'], 'limit + 1 rows, newest first');
    assert.deepEqual(V.page({ limit: 2, after: first[1].key }).rows.map((r) => r.record.id), ['vch-1']);
  } finally { s.close(); rm(dir); }
});

test('[units] a rolled-back unit leaves nothing; db.transitionCases and db.vouches throw', () => {
  const dir = tempDir('s10c-unit'); saveFixture(dir);
  const s = serverOpen(dir);
  try {
    assert.throws(() => s.unit(() => { s.repo.transitionCases.create(transition()); s.repo.vouches.create(vouch()); throw new Error('boom'); }), /boom/);
    assert.equal(s.repo.reads.transitionCases.byId('trn-1'), null);
    assert.equal(s.repo.reads.vouches.byId('vch-1'), null);
  } finally { s.close(); rm(dir); }
});

test('[snapshot] the snapshot write types every record, names a grant to a missing organisation, and reads back what it wrote', () => {
  const dir = tempDir('s10c-snap');
  const placed = transition({
    id: 'trn-2', status: 'placed', recipients: [grant({ revokedAt: NOW + 5 })], placement: { orgId: ORG.id, orgName: ORG.name, at: NOW + 5, note: null }, followUp: { dueAt: NOW + 60 * DAY, notifiedAt: null },
    history: [hist('aud-2', 'opened', { items: 1 }), hist('aud-3', 'placed', { orgId: ORG.id })],
  });
  saveFixture(dir, { transitionCases: [transition(), placed], vouches: [vouch()] });
  const store = openStore(dir);
  try {
    const back = readTableBacked(store.sqlite);
    assert.deepEqual(back.transitionCases, [{ ...transition(), caseOwner: PLAYER }, { ...placed, caseOwner: PLAYER }]);
    assert.deepEqual(back.vouches, [{ ...vouch(), verificationMethod: 'email_code', identityVerified: false }]);
    refused(() => store.save({ savedAt: NOW, idCounter: 1000, db: { ...store.load().db, transitionCases: [transition({ recipients: [grant({ orgId: 'org-none' })] })] } }), /TRANSITIONS_REFERENCE_MISSING.*trn-1/, 'missing organisation');
    refused(() => store.save({ savedAt: NOW, idCounter: 1000, db: { ...store.load().db, vouches: [vouch({ code: 'ABCD2345' })] } }), /TRANSITIONS_IMPORT_BLOCKED.*vch-1.*code/, 'a plain code');
  } finally { store.sqlite.close(); rm(dir); }
});

console.log(`\ntransitions and references repository: ${passed} checks passed`);
