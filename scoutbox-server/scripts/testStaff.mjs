// Organisation staff (repositories/users.mjs, migration 0001): the table and its rules (a name unique in its
// organisation, case-insensitive, removed accounts included; an e-mail unique among current staff; an SSO subject
// unique in the organisation); typed writes that join the caller's transaction; SQL reads without the MFA secret; MFA
// recovery codes; a write's cost does not grow with the staff. In-memory databases only. Run with: npm test
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations, transaction } from '../repositories/database.mjs';
import { DATA_MIGRATIONS } from '../repositories/index.mjs';
import { createUsersRepository, USERS_TABLE, STAFF_LIMITS, staffNameKey } from '../repositories/users.mjs';

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }
let counter = 5000;
const nextId = (p) => `${p}-${++counter}`;
const NOW = 1_800_000_000_000;
const HASH = (c) => c.repeat(64);
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

function fresh() {
  const s = new DatabaseSync(':memory:');
  s.exec('PRAGMA foreign_keys = ON;');
  runDataMigrations(s, DATA_MIGRATIONS, { now: NOW, context: { sessionTtlMs: 30 * 86_400_000 } });
  for (const id of ['org-a', 'org-b']) s.prepare("INSERT INTO orgs (id, name, type, level, plan, created_at) VALUES (?, 'Org', 'club', 'pro', 'Pro', 0)").run(id);
  return s;
}
const repoOn = (s) => createUsersRepository({ sqlite: s, nextId, now: () => NOW });
const refused = (fn, code, field) => assert.throws(fn, (e) => e.code === code && (field === undefined || new RegExp(field).test(e.message)), `${code}${field ? ` (${field})` : ''}`);

test('create: the id is minted, the record is typed whole with its defaults, fresh and deep-frozen; the secret is never on it', () => {
  const s = fresh(); const users = repoOn(s);
  const u = users.create({ orgId: 'org-a', name: 'Maria Keane', role: 'Head of Recruitment', email: 'maria@eastport.example' });
  assert.match(u.id, /^usr-/);
  assert.deepEqual(JSON.parse(JSON.stringify(u)), {
    id: u.id, orgId: 'org-a', name: 'Maria Keane', role: 'Head of Recruitment', email: 'maria@eastport.example', ssoSubject: null, createdAt: NOW,
    removedAt: null, removedById: null, provenance: null, mfa: null, deliveryPrefs: { quietStart: null, quietEnd: null, channels: { email: true } },
  });
  assert.ok(Object.isFrozen(u) && Object.isFrozen(u.deliveryPrefs.channels));
  assert.throws(() => { u.role = 'Owner'; }, TypeError);
  assert.notEqual(users.byId(u.id), users.byId(u.id), 'every read is a fresh record');
  assert.equal(users.byId('usr-none'), null); assert.equal(users.byId(null), null);
  assert.equal(users.count(), 1);
});

test('create: junk is refused by field before anything is written; an organisation that does not exist is refused', () => {
  const s = fresh(); const users = repoOn(s);
  const ok = { orgId: 'org-a', name: 'Sam', role: 'Scout' };
  refused(() => users.create({ ...ok, name: '' }), 'STAFF_RECORD_INVALID', 'name');
  refused(() => users.create({ ...ok, name: ' Sam ' }), 'STAFF_RECORD_INVALID', 'name');
  refused(() => users.create({ ...ok, name: 'x'.repeat(STAFF_LIMITS.name + 1) }), 'STAFF_RECORD_INVALID', 'name');
  refused(() => users.create({ ...ok, role: '' }), 'STAFF_RECORD_INVALID', 'role');
  refused(() => users.create({ ...ok, role: 'r'.repeat(STAFF_LIMITS.role + 1) }), 'STAFF_RECORD_INVALID', 'role');
  refused(() => users.create({ ...ok, email: ['a@b.c'] }), 'STAFF_RECORD_INVALID', 'email');
  refused(() => users.create({ ...ok, provenance: 'magic' }), 'STAFF_RECORD_INVALID', 'provenance');
  refused(() => users.create({ ...ok, createdAt: 'yesterday' }), 'STAFF_RECORD_INVALID', 'createdAt');
  refused(() => users.create({ ...ok, deliveryPrefs: { quietStart: '25:00' } }), 'STAFF_RECORD_INVALID', 'quietStart');
  refused(() => users.create({ ...ok, deliveryPrefs: { channels: { email: 'no' } } }), 'STAFF_RECORD_INVALID', 'channels.email');
  refused(() => users.create({ ...ok, orgId: 'org-none' }), 'STAFF_ORG_MISSING');
  assert.equal(users.count(), 0, 'nothing was written');
  assert.equal(users.create({ ...ok, provenance: 'org_password_bootstrap' }).provenance, 'org_password_bootstrap');
});

test('uniqueness: a name belongs to one account of its organisation (case-insensitive beyond ASCII, removed accounts included); e-mail among current staff; SSO subject per organisation', () => {
  const s = fresh(); const users = repoOn(s);
  const a = users.create({ orgId: 'org-a', name: 'Ömer Kaya', role: 'Scout', email: 'omer@a.example', ssoSubject: 'idp|1' });
  refused(() => users.create({ orgId: 'org-a', name: 'ömer kaya', role: 'Scout' }), 'STAFF_NAME_TAKEN');
  assert.equal(users.byOrgAndName('org-a', '  ÖMER KAYA ').id, a.id, 'sign-in finds the account whatever the case');
  assert.equal(staffNameKey(' Ömer '), 'ömer');
  assert.ok(users.create({ orgId: 'org-b', name: 'Ömer Kaya', role: 'Scout', email: 'omer@a.example', ssoSubject: 'idp|1' }), 'another organisation may have the same name, e-mail and subject');
  refused(() => users.create({ orgId: 'org-a', name: 'Other', role: 'Scout', email: 'OMER@a.example' }), 'STAFF_EMAIL_TAKEN');
  refused(() => users.create({ orgId: 'org-a', name: 'Other', role: 'Scout', ssoSubject: 'idp|1' }), 'STAFF_SSO_TAKEN');
  const lead = users.create({ orgId: 'org-a', name: 'Lead', role: 'Manager' });
  users.update(a.id, (d) => { d.removedAt = NOW + 1; d.removedById = lead.id; });
  refused(() => users.create({ orgId: 'org-a', name: 'ÖMER KAYA', role: 'Scout' }), 'STAFF_NAME_TAKEN');
  assert.ok(users.create({ orgId: 'org-a', name: 'New Person', role: 'Scout', email: 'omer@a.example' }), 'a removed account frees its e-mail');
  // A restore takes the account back; its e-mail must not belong to a current colleague meanwhile.
  refused(() => users.update(a.id, (d) => { d.removedAt = null; d.removedById = null; }), 'STAFF_EMAIL_TAKEN');
  assert.equal(users.update(a.id, (d) => { d.removedAt = null; d.removedById = null; d.email = 'omer2@a.example'; }).removedAt, null);
  // The engine holds the same rules (raw SQL cannot bypass them).
  assert.throws(() => s.prepare("INSERT INTO org_users (id, org_id, name, name_key, role, created_at) VALUES ('usr-raw', 'org-a', 'x', 'lead', 'Scout', 1)").run(), /UNIQUE/);
});

test('update(id, draft => …): the change is typed whole and written at once; fixed fields, unknown fields, a remover of another organisation and a nested update are refused', () => {
  const s = fresh(); const users = repoOn(s);
  const lead = users.create({ orgId: 'org-a', name: 'Lead', role: 'Manager' });
  const u = users.create({ orgId: 'org-a', name: 'Sam', role: 'Scout' });
  const other = users.create({ orgId: 'org-b', name: 'Elsewhere', role: 'Manager' });
  const after = users.update(u.id, (d) => { d.role = 'Senior Scout'; d.deliveryPrefs = { quietStart: '22:00', quietEnd: '07:00', channels: { email: false } }; });
  assert.equal(after.role, 'Senior Scout'); assert.equal(u.role, 'Scout', 'a record already handed out does not change');
  assert.deepEqual(JSON.parse(JSON.stringify(users.byId(u.id).deliveryPrefs)), { quietStart: '22:00', quietEnd: '07:00', channels: { email: false } });
  for (const [field, edit] of [['orgId', (d) => { d.orgId = 'org-b'; }], ['createdAt', (d) => { d.createdAt = 1; }], ['id', (d) => { d.id = 'usr-x'; }], ['mfa', (d) => { d.mfa = { enabledAt: 1 }; }], ['provenance', (d) => { d.provenance = 'org_password_bootstrap'; }]]) {
    refused(() => users.update(u.id, edit), 'STAFF_RECORD_INVALID', field);
  }
  refused(() => users.update(u.id, (d) => { d.colour = 'red'; }), 'STAFF_RECORD_INVALID', 'unknown field');
  refused(() => users.update(u.id, (d) => { d.removedById = lead.id; }), 'STAFF_RECORD_INVALID', 'removedById');
  refused(() => users.update(u.id, (d) => { d.removedAt = NOW; d.removedById = other.id; }), 'STAFF_RECORD_INVALID', 'same organisation');
  refused(() => users.update(u.id, () => { users.update(u.id, (d) => { d.role = 'x'; }); }), 'STAFF_UPDATE_REENTRANT');
  refused(() => users.update('usr-none', () => {}), 'STAFF_NOT_FOUND');
  assert.equal(users.byId(u.id).role, 'Senior Scout', 'every refused update left the row as it was');
  const removed = users.update(u.id, (d) => { d.removedAt = NOW + 5; d.removedById = lead.id; });
  assert.equal(removed.removedById, lead.id);
});

test('remove: ends a membership once, by a staff member of the same organisation; the row stays', () => {
  const s = fresh(); const users = repoOn(s);
  const lead = users.create({ orgId: 'org-a', name: 'Lead', role: 'Manager' });
  const u = users.create({ orgId: 'org-a', name: 'Sam', role: 'Scout' });
  const other = users.create({ orgId: 'org-b', name: 'Elsewhere', role: 'Manager' });
  refused(() => users.remove(u.id, { at: NOW, by: other.id }), 'STAFF_RECORD_INVALID', 'same organisation');
  refused(() => users.remove('usr-none', { at: NOW, by: lead.id }), 'STAFF_NOT_FOUND');
  assert.throws(() => users.remove(u.id, { at: -1, by: lead.id }), TypeError);
  assert.equal(users.byId(u.id).removedAt, null, 'every refused removal left the row as it was');
  const removed = users.remove(u.id, { at: NOW + 5, by: lead.id });
  assert.deepEqual([removed.removedAt, removed.removedById], [NOW + 5, lead.id]);
  refused(() => users.remove(u.id, { at: NOW + 6, by: lead.id }), 'STAFF_ALREADY_REMOVED');
  assert.equal(users.byId(u.id).removedAt, NOW + 5, 'the first removal stands');
  assert.deepEqual(users.forOrg('org-a', { active: true }).map((x) => x.id), [lead.id]);
  assert.equal(users.forOrg('org-a').length, 2, 'the removed row stays');
});

test('MFA: set up, confirm, a recovery code works exactly once, disable; the secret is read only through mfaSecretOf', () => {
  const s = fresh(); const users = repoOn(s);
  const u = users.create({ orgId: 'org-a', name: 'Lead', role: 'Manager' });
  refused(() => users.enableMfa(u.id, { at: NOW }), 'STAFF_MFA_NOT_PENDING');
  assert.deepEqual({ ...users.startMfa(u.id, SECRET).mfa }, { enabledAt: null }, 'set up but not confirmed');
  assert.equal(users.mfaSecretOf(u.id), SECRET);
  assert.ok(!JSON.stringify(users.byId(u.id)).includes(SECRET), 'the secret is not on the record');
  refused(() => users.startMfa(u.id, 'short'), 'STAFF_RECORD_INVALID', 'secret');
  refused(() => users.enableMfa(u.id, { at: NOW, recoveryHashes: ['not-a-hash'] }), 'STAFF_RECORD_INVALID', 'recovery');
  assert.equal(users.enableMfa(u.id, { at: NOW + 1, recoveryHashes: [HASH('a'), HASH('b')] }).mfa.enabledAt, NOW + 1);
  refused(() => users.startMfa(u.id, SECRET), 'STAFF_MFA_ENABLED');
  assert.equal(users.recoveryCodesLeft(u.id), 2);
  assert.equal(users.useRecoveryCode(u.id, HASH('a')), true);
  assert.equal(users.useRecoveryCode(u.id, HASH('a')), false, 'a spent code never works again');
  assert.equal(users.useRecoveryCode(u.id, 'junk'), false);
  assert.equal(users.recoveryCodesLeft(u.id), 1);
  assert.equal(users.disableMfa(u.id).mfa, null);
  assert.equal(users.mfaSecretOf(u.id), null); assert.equal(users.recoveryCodesLeft(u.id), 0);
});

test('reads: forOrg (creation order, active filter), firstActive, activeByEmail, bySsoSubject', () => {
  const s = fresh(); const users = repoOn(s);
  const a = users.create({ orgId: 'org-a', name: 'A', role: 'Manager', email: 'a@x.example', ssoSubject: 'sub-a' });
  const b = users.create({ orgId: 'org-a', name: 'B', role: 'Scout' });
  users.create({ orgId: 'org-b', name: 'C', role: 'Scout' });
  users.update(a.id, (d) => { d.removedAt = NOW; d.removedById = b.id; });
  assert.deepEqual(users.forOrg('org-a').map((u) => u.name), ['A', 'B']);
  assert.deepEqual(users.forOrg('org-a', { active: true }).map((u) => u.name), ['B']);
  assert.equal(users.firstActive('org-a').id, b.id); assert.equal(users.firstActive('org-none'), null);
  assert.equal(users.activeByEmail('org-a', 'A@X.example'), null, 'a removed account is not current staff');
  assert.equal(users.bySsoSubject('org-a', 'sub-a').id, a.id, 'the subject still names the removed account');
  assert.equal(users.bySsoSubject('org-b', 'sub-a'), null);
  assert.ok(Object.isFrozen(users.reads) && !('create' in users.reads) && typeof users.reads.byId === 'function');
});

test('writes join the caller\'s transaction: a rollback leaves no staff row, code or secret', () => {
  const s = fresh(); const users = repoOn(s);
  const u = users.create({ orgId: 'org-a', name: 'Lead', role: 'Manager' });
  assert.throws(() => transaction(s, () => {
    users.create({ orgId: 'org-a', name: 'Inside', role: 'Scout' });
    users.startMfa(u.id, SECRET);
    users.enableMfa(u.id, { at: NOW, recoveryHashes: [HASH('c')] });
    throw new Error('late failure');
  }), /late failure/);
  assert.equal(users.count(), 1); assert.equal(users.mfaSecretOf(u.id), null); assert.equal(users.recoveryCodesLeft(u.id), 0);
});

test('[records] a staff record reads back whole (the MFA secret and codes included); junk and a duplicate name are refused by create and nothing is written; a removal names its remover', () => {
  const s = fresh(); const users = repoOn(s);
  const lead = users.create({ orgId: 'org-a', name: 'Lead', role: 'Manager' });
  users.startMfa(lead.id, SECRET); users.enableMfa(lead.id, { at: NOW, recoveryHashes: [HASH('d')] });
  assert.deepEqual(USERS_TABLE.read(s)[0].mfa, { secretB32: SECRET, enabledAt: NOW, recoveryHashes: [HASH('d')] });
  const later = users.create({ id: 'usr-later', orgId: 'org-a', name: 'Later', role: 'Manager', createdAt: 3 });
  users.create({ id: 'usr-gone', orgId: 'org-a', name: 'Gone', role: 'Scout', createdAt: 1 });
  users.update('usr-gone', (d) => { d.removedAt = 2; d.removedById = later.id; });
  assert.equal(users.byId('usr-gone').removedById, 'usr-later');
  assert.equal(users.byId('usr-later').deliveryPrefs.channels.email, true, 'an absent preference takes its default');
  const before = JSON.stringify(USERS_TABLE.read(s));
  for (const [bad, why] of [
    [{ orgId: 'org-a', name: 'LEAD', role: 'Scout' }, /STAFF_NAME_TAKEN/],
    [{ orgId: 'org-a', name: 'Seven', role: 7 }, /role must be text/],
  ]) assert.throws(() => users.create(bad), why);
  assert.equal(JSON.stringify(USERS_TABLE.read(s)), before, 'every refused write left the table as it was');
});

test('cost: a staff write runs the same number of SQL statements with 20 and with 2,000 staff (no mirror, no whole-table pass)', () => {
  const measure = (n) => {
    const s = fresh();
    let runs = 0;
    const prepare = s.prepare.bind(s);
    s.prepare = (sql) => { const st = prepare(sql); return { run: (...a) => { runs++; return st.run(...a); }, get: (...a) => { runs++; return st.get(...a); }, all: (...a) => { runs++; return st.all(...a); } }; };
    const users = repoOn(s);
    for (let i = 0; i < n; i++) users.create({ orgId: 'org-a', name: `Staff ${i}`, role: 'Scout' });
    const target = users.firstActive('org-a');
    runs = 0;
    users.update(target.id, (d) => { d.role = 'Lead Scout'; });
    users.create({ orgId: 'org-a', name: 'One more', role: 'Scout' });
    users.byOrgAndName('org-a', 'staff 7');
    return runs;
  };
  assert.equal(measure(20), measure(2000));
});

console.log(`\n${passed} staff checks passed`);
