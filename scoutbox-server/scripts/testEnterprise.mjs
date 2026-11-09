// S13b — staff invites, SSO configurations and sign-in states, support tickets and support access grants as typed
// tables with explicit writes (repositories/enterprise.mjs, migration 0035). What this suite proves: the migration
// creates the STRICT tables (no JSON column), empty; the typers refuse junk naming the record and field (a plain invite
// code or SSO state where a hash belongs, a reference kind the support read cannot resolve, a grant's state that does
// not match its clocks); an invite is found by its code's hash only, and moves pending → accepted (naming staff of its
// organisation) | revoked | expired once; an organisation has one SSO configuration and a sign-in state is used once,
// decided in the database; a ticket keeps its references and replies as ordered rows; a grant is approved for its
// hours and logs every read; a rolled-back unit leaves nothing; and the snapshot write types,
// names a missing reference and reads back what it wrote. Temporary databases only; nothing touches DATA_DIR.
// Run with: npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED, readTableBacked } from '../repositories/index.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir, USERS } from './coreIdentityTestFixtures.mjs';
import { saveFixture, ORG, SCOUT } from './recruitmentTestFixtures.mjs';
import {
  ENTERPRISE_MIGRATION as MIGRATION, ENTERPRISE_TABLES as TABLES, ENTERPRISE_COLLECTIONS as COLLECTIONS,
  typeInvite, typeSsoState, typeTicket, typeGrant, typeRefs,
} from '../repositories/enterprise.mjs';

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
const plain = (v) => JSON.parse(JSON.stringify(v));
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');

// ------------------------------------------------------------- fixtures: the literals the routes write
const invite = (over = {}) => ({
  id: 'inv-1', orgId: ORG.id, email: 'synthetic.invitee@example.test', name: 'Synthetic Invitee', role: 'Scout', tokenHash: sha('code-1'),
  status: 'pending', invitedBy: 'Maria', createdAt: NOW, expiresAt: NOW + 7 * 86_400_000, acceptedAt: null, revokedAt: null, userId: null, ...over,
});
const ssoState = (over = {}) => ({ id: 'sst-1', stateHash: sha('state-1'), nonceHash: sha('nonce-1'), orgId: ORG.id, createdAt: NOW, expiresAt: NOW + 600_000, usedAt: null, ...over });
const ticket = (over = {}) => ({ id: 'tkt-1', orgId: ORG.id, byUserId: SCOUT.userId, byName: 'Maria', subject: 'Case question', body: 'Please look', refs: [{ kind: 'case', id: 'case-1' }], status: 'open', replies: [], createdAt: NOW, ...over });
const grant = (over = {}) => ({ id: 'sag-1', ticketId: 'tkt-1', orgId: ORG.id, hours: 4, status: 'requested', requestedAt: NOW, approvedBy: null, approvedAt: null, expiresAt: null, accessLog: [], ...over });

const FIX = () => ({ users: [...USERS()], notifications: [], dispatches: [] });
function serverOpen(dir) {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = {}; // S14a: a fixture-saved file is not a first installation, so there is nothing to hand in
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  const snapshot = () => ({ savedAt: NOW, idCounter: 1000, db });
  return { store, db, repo: layer.enterprise, unit: (w) => store.unitOfWork(w, { snapshot }), close: () => store.sqlite.close() };
}
const seeded = (label) => { const dir = tempDir(label); saveFixture(dir, FIX()); return { dir, s: serverOpen(dir) }; };

// ------------------------------------------------------------- schema
test('[schema] 0035 is registered after 0034 and creates the STRICT tables (no JSON column), empty', () => {
  const ids = DATA_MIGRATIONS.map((m) => m.id);
  assert.equal(ids.indexOf(MIGRATION), ids.indexOf('0034_integrations') + 1);
  for (const n of COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is table-backed`);
  const dir = tempDir('s13b-empty'); const s = openStore(dir).sqlite;
  for (const t of TABLES) {
    const sql = s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql;
    assert.match(sql, /STRICT\s*$/, `${t} is STRICT`);
    assert.doesNotMatch(sql, /json_valid|_json\s/i, `${t} has no JSON column`);
    assert.equal(s.prepare(`SELECT count(*) AS n FROM ${t}`).get().n, 0, `${t} starts empty`);
  }
  for (const [t, c] of [['org_invites', 'token'], ['sso_states', 'state'], ['sso_states', 'nonce']]) {
    assert.equal(s.prepare(`SELECT 1 FROM pragma_table_info('${t}') WHERE name = ?`).get(c), undefined, `${t} has no plain ${c} column`);
  }
  s.close(); rm(dir);
});

// ------------------------------------------------------------- typing
test('[typing] junk is refused naming the record and field', () => {
  assert.ok(typeInvite(invite()).ok);
  assert.match(typeInvite(invite({ tokenHash: 'code-1' })).reason, /orgInvites inv-1\.tokenHash must be a sha-256 hex digest/);
  assert.match(typeInvite({ ...invite(), token: 'code-1' }).reason, /carries field\(s\) this build does not store: token/);
  assert.match(typeInvite(invite({ status: 'accepted', acceptedAt: NOW })).reason, /acceptedAt and userId are set exactly when the invite is accepted/);
  assert.match(typeInvite(invite({ role: 42 })).reason, /role must be text/);
  assert.match(typeSsoState(ssoState({ stateHash: 'state-1' })).reason, /stateHash must be a sha-256 hex digest/);
  assert.match(typeSsoState({ ...ssoState(), nonce: 'n' }).reason, /does not store: nonce/);
  assert.match(typeTicket(ticket({ refs: [{ kind: 'player', id: 'pl-1' }] })).reason, /refs\[0\]\.kind must be one of case\|import/);
  assert.match(typeTicket(ticket({ replies: [{ at: NOW, by: 'Trust & Safety', text: '' }] })).reason, /replies\[0\]\.text must be text of 1 to 2000/);
  assert.match(typeGrant(grant({ hours: 100 })).reason, /hours must be from 1 to 72/);
  assert.match(typeGrant(grant({ status: 'active' })).reason, /approvedAt and expiresAt are set exactly when the grant is active/);
  assert.match(typeGrant(grant({ accessLog: [{ at: NOW, what: 'org-records' }] })).reason, /accessLog is empty until the grant is approved/);
  assert.equal(typeRefs('case-1').field, 'refs');
  assert.equal(typeRefs(Array.from({ length: 11 }, (_, i) => ({ kind: 'case', id: `c-${i}` }))).field, 'refs');
  assert.equal(typeRefs([{ kind: 'case', id: 42 }]).field, 'refs[0].id');
  assert.equal(typeRefs([{ kind: 'case', id: 'c-1', note: 'x' }]).field, 'refs[0]');
});

// ------------------------------------------------------------- invites
test('[invites] found by the code\'s hash only; pending → accepted (staff of its organisation) | revoked | expired, once', () => {
  const { dir, s } = seeded('s13b-invites');
  const created = s.repo.invites.create(invite());
  assert.deepEqual(plain(created), plain(invite()));
  assert.equal(s.repo.reads.invites.byTokenHash(sha('code-1')).id, 'inv-1');
  assert.equal(s.repo.reads.invites.byTokenHash('code-1'), null, 'the plain code finds nothing');
  refused(() => s.repo.invites.create(invite({ id: 'inv-2' })), /UNIQUE|token_hash/, 'one row per code');
  refused(() => s.repo.invites.accept('inv-1', { userId: 'usr-none', at: NOW }), /userId names no staff member/);
  const accepted = s.repo.invites.accept('inv-1', { userId: SCOUT.userId, at: NOW + 1 });
  assert.deepEqual([accepted.status, accepted.acceptedAt, accepted.userId], ['accepted', NOW + 1, SCOUT.userId]);
  refused(() => s.repo.invites.accept('inv-1', { userId: SCOUT.userId, at: NOW + 2 }), /is accepted, not pending/);
  assert.equal(s.repo.invites.revoke('inv-1', NOW + 3).status, 'accepted', 'an accepted invite is not revoked');
  s.repo.invites.create(invite({ id: 'inv-3', tokenHash: sha('code-3') }));
  assert.equal(s.repo.invites.expire('inv-3').status, 'expired');
  assert.equal(s.repo.invites.revoke('inv-3', NOW).status, 'expired', 'an expired invite stays expired');
  s.repo.invites.create(invite({ id: 'inv-4', tokenHash: sha('code-4') }));
  assert.deepEqual([s.repo.invites.revoke('inv-4', NOW + 4).revokedAt, s.repo.invites.revoke('inv-4', NOW + 5).revokedAt], [NOW + 4, NOW + 4], 'the first revocation stands');
  const page = s.repo.reads.invites.page(ORG.id, { limit: 2 });
  assert.deepEqual(page.items.map((i) => i.id), ['inv-4', 'inv-3']); assert.equal(typeof page.nextCursor, 'string');
  s.close(); rm(dir);
});

// ------------------------------------------------------------- SSO
test('[sso] one configuration per organisation; a sign-in state is found by its hash and used once', () => {
  const { dir, s } = seeded('s13b-sso');
  const first = s.repo.sso.configure({ id: 'sso-1', orgId: ORG.id, issuer: 'local-test-idp', clientId: `scoutbox-${ORG.id}`, at: NOW });
  const again = s.repo.sso.configure({ id: 'sso-2', orgId: ORG.id, issuer: 'local-test-idp', clientId: `scoutbox-${ORG.id}`, at: NOW + 9 });
  assert.deepEqual([again.id, again.createdAt, again.updatedAt], ['sso-1', NOW, NOW + 9], 'the second configuration replaces the first, keeping its id');
  assert.equal(first.issuer, 'local-test-idp');
  refused(() => s.repo.sso.configure({ id: 'sso-3', orgId: ORG.id, issuer: 'corporate-okta', clientId: 'x', at: NOW }), /issuer must be one of local-test-idp/);
  s.repo.ssoStates.create(ssoState());
  const st = s.repo.reads.ssoStates.byStateHash(sha('state-1'));
  assert.equal(st.nonceHash, sha('nonce-1'));
  assert.equal(s.repo.ssoStates.markUsed('sst-1', NOW + 1), true);
  assert.equal(s.repo.ssoStates.markUsed('sst-1', NOW + 2), false, 'the second use is refused by the database');
  assert.equal(s.repo.reads.ssoStates.byStateHash(sha('state-1')).usedAt, NOW + 1);
  s.close(); rm(dir);
});

// ------------------------------------------------------------- support
test('[support] a ticket keeps references and replies as rows; a grant is approved for its hours and logs every read', () => {
  const { dir, s } = seeded('s13b-support');
  assert.deepEqual(plain(s.repo.tickets.create(ticket())), plain(ticket()));
  refused(() => s.repo.tickets.create(ticket({ id: 'tkt-2', byUserId: 'usr-none' })), /byUserId names no staff member/);
  s.repo.tickets.reply('tkt-1', { at: NOW + 1, by: 'Trust & Safety', text: 'Looking now.' });
  const closed = s.repo.tickets.reply('tkt-1', { at: NOW + 2, by: 'Trust & Safety', text: 'Done.' }, { close: true });
  assert.deepEqual(plain(closed.replies), [{ at: NOW + 1, by: 'Trust & Safety', text: 'Looking now.' }, { at: NOW + 2, by: 'Trust & Safety', text: 'Done.' }]);
  assert.equal(closed.status, 'closed');
  refused(() => s.repo.grants.request(grant({ ticketId: 'tkt-none' })), /no ticket tkt-none/);
  s.repo.grants.request(grant());
  assert.equal(s.repo.reads.grants.pendingFor(ORG.id, 'tkt-1').id, 'sag-1');
  assert.equal(s.repo.reads.grants.pendingFor('org-other', 'tkt-1'), null, 'another organisation approves nothing');
  refused(() => s.repo.grants.logAccess('sag-1', { at: NOW, what: 'org-records' }), /is not active/);
  const active = s.repo.grants.approve('sag-1', { by: 'Maria', at: NOW + 10 });
  assert.deepEqual([active.status, active.expiresAt], ['active', NOW + 10 + 4 * 3600_000]);
  assert.equal(s.repo.reads.grants.liveFor('tkt-1', NOW + 11).id, 'sag-1');
  assert.equal(s.repo.reads.grants.liveFor('tkt-1', NOW + 10 + 4 * 3600_000), null, 'expiry is derived from the clock');
  s.repo.grants.logAccess('sag-1', { at: NOW + 12, what: 'org-records' });
  assert.deepEqual(plain(s.repo.reads.grants.forOrg(ORG.id)[0].accessLog), [{ at: NOW + 12, what: 'org-records' }]);
  refused(() => s.repo.grants.approve('sag-1', { by: 'Maria', at: NOW }), /is active, not requested/);
  assert.equal(s.repo.reads.tickets.pageAll({ limit: 10 }).items[0].id, 'tkt-1');
  s.close(); rm(dir);
});

// ------------------------------------------------------------- units, retirement, snapshot
test('[unit] a rolled-back unit leaves nothing', () => {
  const { dir, s } = seeded('s13b-unit');
  assert.throws(() => s.unit(() => { s.repo.tickets.create(ticket()); s.repo.grants.request(grant()); throw new Error('boom'); }), /boom/);
  assert.equal(s.repo.reads.tickets.byId('tkt-1'), null); assert.equal(s.repo.reads.grants.byId('sag-1'), null);
  assert.equal(typeof s.repo.reads.invites.create, 'undefined', 'the reads cannot write');
  s.close(); rm(dir);
});

test('[snapshot] the write types every record, names a missing reference, and reads back what it wrote', () => {
  const dir = tempDir('s13b-snapshot');
  const live = grant({ status: 'active', approvedBy: 'Maria', approvedAt: NOW + 1, expiresAt: NOW + 1 + 4 * 3600_000, accessLog: [{ at: NOW + 2, what: 'org-records' }] });
  const replied = ticket({ replies: [{ at: NOW + 1, by: 'Trust & Safety', text: 'Hello' }] });
  const cfg = { id: 'sso-1', orgId: ORG.id, issuer: 'local-test-idp', clientId: 'scoutbox-org-pro', createdAt: NOW, updatedAt: NOW };
  saveFixture(dir, { ...FIX(), orgInvites: [invite()], ssoConfigs: [cfg], ssoStates: [ssoState()], supportTickets: [replied], supportAccessGrants: [live] });
  const store = openStore(dir);
  const back = readTableBacked(store.sqlite);
  assert.deepEqual(plain(back.orgInvites), [plain(invite())]);
  assert.deepEqual(plain(back.supportTickets), [plain(replied)]);
  assert.deepEqual(plain(back.supportAccessGrants), [plain(live)]);
  assert.deepEqual(plain(back.ssoStates), [plain(ssoState())]);
  const snap = store.load();
  refused(() => store.save({ ...snap, db: { ...snap.db, supportAccessGrants: [grant({ ticketId: 'tkt-none' })] } }), /ENTERPRISE_REFERENCE_MISSING.*tkt-none/);
  refused(() => store.save({ ...snap, db: { ...snap.db, orgInvites: [{ ...invite(), token: 'plain' }] } }), /ENTERPRISE_IMPORT_BLOCKED.*does not store: token/);
  refused(() => store.save({ ...snap, db: { ...snap.db, ssoConfigs: [cfg, { ...cfg, id: 'sso-2' }] } }), /two SSO configurations name the same organisation/);
  refused(() => store.save({ ...snap, db: { ...snap.db, supportTickets: [ticket({ refs: [{ kind: 'note', id: 'x' }] })] } }), /ENTERPRISE_IMPORT_BLOCKED.*refs\[0\]\.kind/);
  assert.deepEqual(readTableBacked(store.sqlite).supportTickets.map((t) => t.replies.length), [1], 'a refused write changed nothing');
  store.sqlite.close(); rm(dir);
});

console.log(`\n${passed} enterprise checks passed`);
