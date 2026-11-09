// Transition cases and coach references (vouches; repositories/transitionsVouches.mjs, migration 0025): the STRICT
// tables, a create that must read back as written, a case read back whole with its pack, grants and history, the named
// acts (grants only inserted and revoked once, the history only inserted, a case leaves open once), a reference code
// stored only as its hash (single use, unique), the routes' queries, units of work and fixtures. Temporary databases only; nothing touches DATA_DIR. Run with: npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openLayer, readRecords } from './dataLayerFixture.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir } from './coreIdentityTestFixtures.mjs';
import { saveFixture, ORG } from './recruitmentTestFixtures.mjs';
import {
  TRANSITIONS_MIGRATION as MIGRATION, TRANSITIONS_TABLES as TABLES, TRANSITIONS_COLLECTIONS as COLLECTIONS,
  vouchCodeHash,
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
  const store = openStore(dir);
  const layer = attachDataLayer({ store, nextId, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  return { store, repo: layer.transitionsVouches, unit: (w) => store.unitOfWork(w), close: () => store.sqlite.close() };
}

// ------------------------------------------------------------- schema
test('[schema] 0025 is registered after 0024 and creates the five STRICT tables (no JSON column), empty on a fresh database', () => {
  const ids = DATA_MIGRATIONS.map((m) => m.id);
  assert.equal(ids.indexOf(MIGRATION), ids.indexOf('0024_passport') + 1);
  for (const n of COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is table-backed`);
  const dir = tempDir('s10c-empty'); const s = openLayer(dir).sqlite;
  for (const t of TABLES) {
    assert.match(s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql, /STRICT\s*$/, `${t} is STRICT`);
    assert.equal(s.prepare(`SELECT count(*) AS n FROM ${t}`).get().n, 0);
    assert.ok(!s.prepare(`PRAGMA table_info(${t})`).all().some((c) => /_json$/.test(c.name)), `${t}: no JSON column`);
  }
  assert.ok(!s.prepare('PRAGMA table_info(vouches)').all().some((c) => c.name === 'code'), 'no plain code column');
  s.close(); rm(dir);
});

// ------------------------------------------------------------- creates
test('[create] a record the columns cannot hold is refused with the record and field named, and nothing is written', () => {
  const dir = tempDir('s10c-create'); saveFixture(dir);
  const s = serverOpen(dir);
  const T = s.repo.transitionCases; const V = s.repo.vouches;
  try {
    refused(() => T.create(transition({ sneaky: 1 })), /TRANSITIONS_INPUT_INVALID: transition_cases trn-1 sneaky: is not stored as written/);
    refused(() => T.create(transition({ pack: { mediaIds: ['m', 'm'] } })), /trn-1 pack\.mediaIds\[1\]: UNIQUE constraint failed/);
    refused(() => T.create(transition({ pack: { mediaIds: ['m'], notes: ['x'] } })), /trn-1 pack\.notes: is not stored as written/);
    refused(() => T.create(transition({ status: 'released' })), /trn-1 row: CHECK constraint failed/);
    refused(() => T.create(transition({ status: 'placed' })), /trn-1 row: CHECK constraint failed/, 'a placed case names its placement');
    refused(() => T.create(transition({ caseOwner: { kind: 'guardian', id: 'gd-1', name: 'G' } })), /trn-1 caseOwner\.kind: is not stored as written/, 'the owner is who started the case');
    refused(() => T.create(transition({ history: [hist('aud-1', 'opened', { orgId: ORG.id })] })), /trn-1 history\[0\]: CHECK constraint failed/);
    refused(() => T.create(transition({ history: [hist('aud-1', 'withdrawn', { items: 1 })] })), /trn-1 history\[0\]: CHECK constraint failed/);
    refused(() => T.create(transition({ recipients: [grant({ expiresAt: NOW - 1 })] })), /trn-1 recipients\[0\]: CHECK constraint failed/);
    refused(() => V.create(vouch({ code: 'ABCD2345' })), /vouches vch-1 code: is not stored as written/);
    refused(() => V.create(vouch({ codeHash: 'ABCD2345' })), /vch-1 row: CHECK constraint failed/, 'a code is stored as its SHA-256 hex digest');
    refused(() => V.create(vouch({ status: 'published', codeHash: null })), /vch-1 row: CHECK constraint failed/, 'published needs its text');
    refused(() => V.create(vouch({ status: 'published', text: 'Good.', publishedAt: NOW })), /vch-1 row: CHECK constraint failed/, 'a published reference holds no code');
    refused(() => V.create(vouch({ identityVerified: true })), /vch-1 identityVerified: is not stored as written/, 'an email code never proves identity');
    refused(() => V.create(vouch({ coachName: '' })), /vch-1 row: CHECK constraint failed/);
    assert.deepEqual(s.repo.counts(), { transitionCases: 0, vouches: 0 }, 'nothing was written');
  } finally { s.close(); rm(dir); }
});

// ------------------------------------------------------------- writes and reads
test('[cases] a case is created whole and read back; its acts only insert grants (revoked once) and history, and it leaves open once', () => {
  const dir = tempDir('s10c-cases'); saveFixture(dir, { orgs: [{ ...ORG, plan: 'Pro' }, { id: 'org-2', name: 'Other FC', type: 'club', plan: 'Pro' }] });
  const s = serverOpen(dir);
  const T = s.repo.transitionCases;
  try {
    const t = T.create(transition({ pack: { mediaIds: ['med-2', 'med-1'], evidenceIds: ['ev-1'], feedbackIds: [] } }));
    assert.ok(Object.isFrozen(t) && Object.isFrozen(t.pack.mediaIds), 'deep-frozen');
    assert.deepEqual(t.pack, { mediaIds: ['med-2', 'med-1'], evidenceIds: ['ev-1'], feedbackIds: [] }, 'the pack keeps its order');
    assert.deepEqual(t.history, [hist('aud-1', 'opened', { items: 1 })]);
    refused(() => T.create(transition()), /TRANSITIONS_DUPLICATE: transition_cases trn-1 already exists/, 'duplicate id');
    assert.equal(typeof T.update, 'undefined', 'no whole-record update');
    const g = T.grant('trn-1', { recipient: grant() }, { history: [hist('aud-2', 'recipient_added', { orgId: ORG.id })] });
    assert.deepEqual(g.recipients, [grant()]);
    assert.deepEqual(T.grantedTo(ORG.id, NOW).map((x) => x.id), ['trn-1'], 'the club sees the case it holds a live grant for');
    assert.deepEqual(T.grantedTo(ORG.id, NOW + 31 * DAY), [], 'not after the grant expired');
    refused(() => T.grant('trn-1', { recipient: grant({ orgId: 'org-none' }) }), /FOREIGN KEY/, 'a grant to a missing organisation');
    refused(() => T.grant('trn-1', { recipient: grant({ extra: 1 }) }), /recipients\[1\]\.extra: is not stored as written/, 'a grant reads back as written');
    refused(() => T.grant('trn-1', { recipient: grant() }, { history: [hist('aud-1', 'recipient_added', { orgId: ORG.id })] }), /history aud-1: UNIQUE|PRIMARY KEY/, 'a history id is used once');
    assert.equal(T.byId('trn-1').recipients.length, 1, 'a refused act wrote nothing');
    T.recordView('trn-1', { ord: 0, at: NOW + 1 });
    const r = T.revokeGrant('trn-1', { ord: 0, at: NOW + 1 }, { history: [hist('aud-3', 'recipient_revoked', { orgId: ORG.id })] });
    assert.equal(r.recipients[0].revokedAt, NOW + 1);
    assert.deepEqual(T.grantedTo(ORG.id, NOW), [], 'a revoked grant shows nothing');
    refused(() => T.revokeGrant('trn-1', { ord: 0, at: NOW + 2 }), /grant #0 is already revoked/, 'revoked twice');
    refused(() => T.recordView('trn-1', { ord: 0, at: NOW + 2 }), /grant #0 is revoked/, 'no view under a revoked grant');
    T.grant('trn-1', { recipient: grant({ grantedAt: NOW + 2 }) });
    T.grant('trn-1', { recipient: grant({ orgId: 'org-2', orgName: 'Other FC', grantedAt: NOW + 2 }) });
    const p = T.place('trn-1', { placement: { orgId: ORG.id, orgName: ORG.name, at: NOW + 3, note: 'U21s' }, followUpDueAt: NOW + 60 * DAY, at: NOW + 3 }, { history: [hist('aud-4', 'placed', { orgId: ORG.id })] });
    assert.equal(p.status, 'placed'); assert.equal(p.history.length, 4); assert.deepEqual(p.followUp, { dueAt: NOW + 60 * DAY, notifiedAt: null });
    assert.deepEqual(p.recipients.map((x) => x.revokedAt), [NOW + 1, null, NOW + 3], "the placing club's grant stays, every other ends");
    refused(() => T.withdraw('trn-1', { at: NOW }), /transition_cases trn-1 is not open/, 'a case leaves open once');
    refused(() => T.grant('trn-1', { recipient: grant() }), /is not open; a grant is refused/, 'no grant on a closed case');
    assert.deepEqual(T.followUpsDue(NOW + 61 * DAY).map((x) => x.id), ['trn-1']);
    T.markFollowUpNotified('trn-1', { at: NOW + 61 * DAY });
    assert.deepEqual(T.followUpsDue(NOW + 62 * DAY), [], 'a check-in is sent once');
    refused(() => T.markFollowUpNotified('trn-1', { at: NOW + 62 * DAY }), /has no check-in due/);
    T.create(transition({ id: 'trn-2', history: [hist('aud-5', 'opened', { items: 1 })] }));
    assert.deepEqual(T.expiredBy(NOW + 61 * DAY).map((x) => x.id), ['trn-2'], 'only open cases expire');
    assert.equal(T.expire('trn-2', {}, { history: [hist('aud-6', 'expired', null, { byKind: 'system', byId: 'sweep', byName: 'system' })] }).status, 'expired');
    assert.deepEqual(T.forPlayers([PID, 'pl-other']).map((x) => x.id), ['trn-1', 'trn-2']);
    assert.equal(typeof s.repo.reads.transitionCases.grant, 'undefined', 'the reads carry no writes');
    T.create(transition({ id: 'trn-3', history: [hist('aud-7', 'opened', { items: 1 })] }));
    refused(() => T.grant('trn-3', { recipient: grant({ grantedAt: NOW + 61 * DAY, expiresAt: NOW + 60 * DAY }) }), /CHECK constraint failed/, 'a grant after the period ended (the route answers 409 CASE_CLOSED first)');
    const w = T.withdraw('trn-3', { at: NOW }, { history: [hist('aud-8', 'withdrawn')] });
    assert.equal(w.status, 'withdrawn');
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
    const pub = V.publish('vch-1', { text: 'Reliable.', at: NOW });
    assert.equal(pub.codeHash, null); assert.equal(pub.status, 'published'); assert.equal(V.pendingByCode('ABCD2345'), null, 'single use');
    refused(() => V.publish('vch-1', { text: 'Again.', at: NOW }), /vouches vch-1 is not pending/, 'a code is spent once');
    assert.equal(typeof V.update, 'undefined', 'no whole-record update');
    assert.deepEqual(V.publishedFor(PID).map((v) => v.id), ['vch-1']);
    V.withdraw('vch-1', { at: NOW, by: 'admin', reason: 'withdrawn by Trust & Safety' });
    refused(() => V.withdraw('vch-1', { at: NOW, by: 'admin', reason: 'again' }), /already withdrawn/, 'withdrawn once');
    assert.deepEqual(V.publishedFor(PID), [], 'a withdrawn reference leaves every profile');
    assert.equal(V.forPlayer(PID).length, 1, 'the player still sees it in their own list');
    V.create(vouch({ id: 'vch-2', codeHash: null, coachEmail: null, status: 'published', text: 'A season of graft.', publishedAt: NOW }));
    V.create(vouch({ id: 'vch-3', codeHash: vouchCodeHash('ZZZZ9999') }));
    const revoked = V.revoke('vch-3');
    assert.deepEqual([revoked.status, revoked.codeHash], ['revoked', null], 'a revoked reference keeps no live code');
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

test('[fixtures] a fixture written through the repository must read back as written (a plain code refused, nothing written), a grant to a missing organisation is refused, and the records read back as written', () => {
  const dir = tempDir('s10c-fix');
  const placed = transition({
    id: 'trn-2', status: 'placed', recipients: [grant({ revokedAt: NOW + 5 })], placement: { orgId: ORG.id, orgName: ORG.name, at: NOW + 5, note: null }, followUp: { dueAt: NOW + 60 * DAY, notifiedAt: null },
    history: [hist('aud-2', 'opened', { items: 1 }), hist('aud-3', 'placed', { orgId: ORG.id })],
  });
  saveFixture(dir, { transitionCases: [transition(), placed], vouches: [vouch()] });
  try {
    const back = readRecords(dir);
    assert.deepEqual(back.transitionCases, [{ ...transition(), caseOwner: PLAYER }, { ...placed, caseOwner: PLAYER }]);
    assert.deepEqual(back.vouches, [{ ...vouch(), verificationMethod: 'email_code', identityVerified: false }]);
  } finally { rm(dir); }
  const refusedFixture = (label, db, re) => {
    const d = tempDir(`s10c-fix-${label}`);
    try {
      refused(() => saveFixture(d, { transitionCases: [transition({ id: 'trn-ok' })], ...db }), re, label);
      const back = readRecords(d);
      assert.equal(back.transitionCases.length + back.vouches.length, 0, `${label}: a refused fixture wrote nothing`);
    } finally { rm(d); }
  };
  refusedFixture('org', { transitionCases: [transition(), transition({ id: 'trn-3', recipients: [grant({ orgId: 'org-none' })] })] }, /FOREIGN KEY constraint failed/);
  refusedFixture('code', { vouches: [vouch({ code: 'ABCD2345' })] }, /TRANSITIONS_INPUT_INVALID: vouches vch-1 code/);
});

console.log(`\ntransitions and references repository: ${passed} checks passed`);
