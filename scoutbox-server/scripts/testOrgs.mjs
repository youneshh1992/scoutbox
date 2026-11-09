// Behavioural tests for the organisations: a typed table since S3, explicit writes
// and SQL reads since S14g (no mirror, no facets, `db.orgs` throws). Everything
// runs on throwaway databases under the OS temp directory with synthetic
// fixtures; nothing touches DATA_DIR. Run with: npm test
import assert from 'node:assert/strict';
import { spawnChild } from './testChildren.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations, transaction } from '../repositories/database.mjs';
import { createOrgsRepository, orgRecordProblems, typeOrgSnapshotRow, ORGS_TABLE, ORGS_CUTOVER_MIGRATION, ORG_RECORD_KEYS } from '../repositories/orgs.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { hasBlobTable } from './coreIdentityTestFixtures.mjs';
import * as m0001 from '../repositories/migrations/0001_org_users.mjs';
import * as m0002 from '../repositories/migrations/0002_core_identity_shadow.mjs';
import * as m0003 from '../repositories/migrations/0003_sessions_live.mjs';
import * as m0004 from '../repositories/migrations/0004_orgs_live.mjs';
import { openStore } from '../store.mjs';
// The checks below that drive the runner on a raw connection are about the S2/S3
// steps (0001–0004): they run exactly those. The S4a steps that follow them
// (0005 core identity, 0006 media deletions) have their own suites
// (testCoreIdentityMigration, testCoreSchema); the full registered list is what
// attachDataLayer and the real-server checks below run.
const S3_MIGRATIONS = DATA_MIGRATIONS.filter((m) => /^000[1-4]_/.test(m.id));
import { buildSeed } from '../seed.mjs';
import { freePort } from './testPort.mjs';

let passed = 0;
// TEST_ONLY=<substring> runs the matching checks alone (reproductions and reviews); unset, every check runs.
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
async function atest(name, fn) { if (only && !name.includes(only)) return; await fn(); passed++; console.log(`  ✓ ${name}`); }
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const DAY = 86_400_000;
const TTL = 30 * DAY;
const HERE = path.dirname(fileURLToPath(import.meta.url));
let counter = 9000;
const nextId = (p) => `${p}-${++counter}`;
const tempDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `sb-${tag}-`));
const openRaw = (dir) => { const s = new DatabaseSync(path.join(dir, 'scoutbox.db')); s.exec('PRAGMA foreign_keys = ON;'); return s; };
/** Every table's rows: "nothing was written" is "the dump did not change". */
const dump = (sqlite) => Object.fromEntries(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(({ name }) => [name, sqlite.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all().map((r) => ({ ...r }))]));
const fileDigest = (dir) => { const s = new DatabaseSync(path.join(dir, 'scoutbox.db')); s.exec('PRAGMA wal_checkpoint(TRUNCATE)'); s.close(); return sha256(fs.readFileSync(path.join(dir, 'scoutbox.db'))); };

/** Organisation records in every shape the application writes (the snapshot form: a record plus its password hash). */
const ORGS = () => [
  // The seed's shape: a pro club with location and a verified domain, password-protected.
  { id: 'org-pro', name: 'Eastport FC', type: 'club', level: 'pro', location: { lat: 51.889, lng: 1.02, city: 'Eastport' }, plan: 'Pro', trustedPartner: true, country: 'GB', verified: true, verifiedDomain: 'eastportfc.example', safeguardingContractSigned: true, password: 'scrypt$00$11' },
  // Registration's shape (server.mjs): a grassroots club with a federation reference.
  { id: 'org-grass', name: 'Riverside Juniors', type: 'club', level: 'grassroots', location: { lat: 51.5, lng: -0.1, city: 'London' }, federationRef: { federation: 'London FA', registrationId: 'LFA-1' }, plan: 'Grassroots', trustedPartner: false, country: 'GB', verified: false, verifiedDomain: null, safeguardingContractSigned: false },
  // The verification review's shape (m14): level null, location null, the revocation column, the enterprise switches.
  { id: 'org-agency', name: 'Northstar Agency', type: 'agency', level: null, plan: 'Pro', trustedPartner: false, country: 'FR', verified: false, verifiedDomain: null, safeguardingContractSigned: false, location: null, federationRef: null, verificationRevokedAt: null, mfaRequiredForLeads: true, emailDomain: 'northstar.example', emailDomainVerified: true, createdAt: 1700000000000 },
];
const AT = 1_750_000_000_000;
/** The record a fixture becomes: every field present, defaults filled, no password. */
const recordOf = ({ password: _pw, ...r }, createdAt = AT) => ({
  id: r.id, name: r.name, type: r.type, level: r.level ?? null, plan: r.plan, country: r.country ?? null,
  location: r.location ? { lat: r.location.lat, lng: r.location.lng, city: r.location.city ?? null } : null,
  federationRef: r.federationRef ?? null,
  trustedPartner: r.trustedPartner ?? false, verified: r.verified ?? false, verifiedDomain: r.verifiedDomain ?? null,
  safeguardingContractSigned: r.safeguardingContractSigned ?? false, suspended: r.suspended ?? false,
  emailDomain: r.emailDomain ?? null, emailDomainVerified: r.emailDomainVerified ?? false, mfaRequiredForLeads: r.mfaRequiredForLeads ?? false,
  verificationRevokedAt: r.verificationRevokedAt ?? null, createdAt: r.createdAt ?? createdAt,
});
/** A migrated in-memory database with the fixture's organisations, and its repository. */
function fresh({ orgs = ORGS(), now = () => AT } = {}) {
  const s = new DatabaseSync(':memory:'); s.exec('PRAGMA foreign_keys = ON;');
  runDataMigrations(s, S3_MIGRATIONS, { context: { sessionTtlMs: TTL } });
  const repo = createOrgsRepository({ sqlite: s, nextId, now });
  if (orgs) repo.initialize(orgs);
  return { s, repo };
}
/** A minimal player record migration 0005 accepts (dob and country are required; everything else is optional). */
const PLAYER_1 = (name = 'P') => ({ id: 'pl-1', name, dob: '2001-01-01', country: 'GB', media: [] });
const fixtureUsers = () => [
  { id: 'usr-pro', orgId: 'org-pro', name: 'Maria Keane', role: 'Head of Recruitment', createdAt: 1, mfa: { secretB32: 'SECRETSECRETSECRET', enabledAt: 7, recoveryHashes: ['1'.repeat(64)] }, deliveryPrefs: { quietStart: '22:00', quietEnd: '07:00', channels: { email: false } } },
  { id: 'usr-grass', orgId: 'org-grass', name: 'Sam', role: 'Manager', createdAt: 2 },
  { id: 'usr-agency', orgId: 'org-agency', name: 'Ava', role: 'Agent', createdAt: 3 },
];
const fixtureSessions = (now = Date.now()) => [
  { token: 'legacy-maria-token', sid: 'sid-maria', kind: 'org', refId: 'org-pro', userId: 'usr-pro', createdAt: now - DAY },
  { token: 'legacy-sam-token', sid: 'sid-sam', kind: 'org', refId: 'org-grass', userId: 'usr-grass', createdAt: now - DAY },
  { token: 'legacy-player-token', sid: 'sid-pl', kind: 'player', refId: 'pl-1', createdAt: now - DAY },
];

// ------------------------------------------------------------- typing
test('typing: a record takes its defaults (null, false, the creation time), every field is always present, and junk is refused by field with nothing coerced', () => {
  for (const rec of ORGS()) {
    const v = typeOrgSnapshotRow(rec, { now: AT });
    assert.equal(v.ok, true, rec.id);
    assert.deepEqual(v.row, recordOf(rec), `${rec.id} with its defaults`);
    assert.deepEqual(Object.keys(v.row), ORG_RECORD_KEYS, `${rec.id}: every field, in one order`);
  }
  assert.equal(typeOrgSnapshotRow(ORGS()[0]).passwordHash, 'scrypt$00$11', 'the hash travels beside the record');
  assert.deepEqual(typeOrgSnapshotRow({ id: 'x', name: 'X', type: 'club', plan: 'Pro', location: { lat: 1, lng: 2, city: '' } }, { now: AT }).row.location, { lat: 1, lng: 2, city: null }, 'an empty city is no city');
  const base = { id: 'x', name: 'X', type: 'club', level: 'pro', plan: 'Pro' };
  const refuse = (rec, pattern) => { const v = typeOrgSnapshotRow(rec, { now: AT }); assert.equal(v.ok, false, JSON.stringify(rec)); assert.match(v.reason, pattern); };
  refuse(null, /not an object/); refuse([], /not an object/);
  refuse({ ...base, id: '' }, /id must be text/); refuse({ ...base, name: 7 }, /name must be text/); refuse({ ...base, name: ' X' }, /without surrounding spaces/);
  refuse({ ...base, name: 'x'.repeat(121) }, /name must be text of 1 to 120/);
  refuse({ ...base, type: 'school' }, /type must be one of club, agency/);
  refuse({ ...base, level: 'agent' }, /level must be one of/); refuse({ ...base, plan: 'Free' }, /plan must be one of/);
  refuse({ ...base, verified: 'yes' }, /verified must be a boolean/); refuse({ ...base, suspended: 1 }, /suspended must be a boolean/);
  refuse({ ...base, country: 44 }, /country must be text/);
  refuse({ ...base, createdAt: '2024-01-01' }, /createdAt must be an integer/); refuse({ ...base, createdAt: 1.5 }, /createdAt/);
  refuse({ ...base, location: 'London' }, /location must be \{ lat, lng, city \}/);
  refuse({ ...base, location: { lat: 1 } }, /latitude .* and a longitude/);
  refuse({ ...base, location: { lat: 91, lng: 0 } }, /latitude \(-90 to 90\)/);
  refuse({ ...base, location: { lat: 1, lng: 2, postcode: 'E1' } }, /location must be/);
  refuse({ ...base, federationRef: 'FA' }, /federationRef must be/);
  refuse({ ...base, federationRef: { federation: 'FA' } }, /registrationId must be text/);
  refuse({ ...base, verificationRevokedAt: 'yes' }, /verificationRevokedAt must be an integer/);
  refuse({ ...base, password: 7 }, /password hash must be text/);
  refuse({ ...base, memos: [] }, /unknown field memos/);
  refuse({ ...base, verification: { domains: [] } }, /verification is no longer an organisation field: write it through the verification repository/);
  refuse({ ...base, squad: [] }, /clubSetup repository/); refuse({ ...base, agencySettings: {} }, /agentCore repository/);
  assert.deepEqual(orgRecordProblems(recordOf({ ...base, level: null })), [], 'level null is a supported shape (the verification review writes it)');
});

// ------------------------------------------------------------- the migration
test('migration 0004 on a new database: orgs is the typed table (no facet column) while org_users (0001\'s final form since S14f) and sessions keep referencing it, the first installation is pending, and a failure before commit leaves no trace', () => {
  const s = new DatabaseSync(':memory:'); s.exec('PRAGMA foreign_keys = ON;');
  assert.ok(runDataMigrations(s, S3_MIGRATIONS, { context: { sessionTtlMs: TTL } }).ran.includes(ORGS_CUTOVER_MIGRATION));
  const orgsSql = s.prepare("SELECT sql FROM sqlite_master WHERE name = 'orgs'").get().sql;
  assert.match(orgsSql, /STRICT/); assert.ok(!/facets_json/.test(orgsSql), 'no facet storage');
  const after = s.prepare("SELECT sql FROM sqlite_master WHERE name = 'org_users'").get().sql;
  assert.match(after, /STRICT/); assert.match(after, /REFERENCES orgs\(id\)/);
  assert.deepEqual(s.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'org_users' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((x) => x.name), ['org_users_org', 'org_users_org_email', 'org_users_org_name', 'org_users_removed_by', 'org_users_sso']);
  assert.match(s.prepare("SELECT sql FROM sqlite_master WHERE name = 'sessions'").get().sql, /REFERENCES org_users\(id, org_id\)/, 'sessions references org_users');
  assert.equal(s.prepare("SELECT value FROM meta WHERE key = 'orgsInit'").get().value, 'pending', 'a new database is a first installation');
  assert.equal(s.prepare('PRAGMA foreign_keys').get().foreign_keys, 1, 'foreign keys are back on after the rebuild');
  // The keys and checks are enforced.
  transaction(s, () => ORGS_TABLE.replace(s, ORGS(), { now: AT }));
  assert.deepEqual(ORGS_TABLE.read(s), ORGS().map((o) => ({ ...recordOf(o), password: o.password ?? null })), 'records read back typed, with their hash');
  assert.equal(s.prepare("SELECT level FROM orgs WHERE id = 'org-agency'").get().level, null, 'the nullable level is stored as NULL');
  assert.equal(s.prepare("SELECT password_hash FROM orgs WHERE id = 'org-pro'").get().password_hash, 'scrypt$00$11');
  for (const [sql, what] of [
    ["UPDATE orgs SET lat = 95 WHERE id = 'org-pro'", 'a latitude out of range'],
    ["UPDATE orgs SET lat = NULL WHERE id = 'org-pro'", 'a longitude without a latitude'],
    ["UPDATE orgs SET federation_registration_id = NULL WHERE id = 'org-grass'", 'half a federation registration'],
    ["UPDATE orgs SET name = '' WHERE id = 'org-pro'", 'an empty name'],
    ["UPDATE orgs SET created_at = NULL WHERE id = 'org-pro'", 'no creation time'],
  ]) assert.throws(() => s.prepare(sql).run(), /CHECK|NOT NULL/, what);
  assert.throws(() => s.prepare("INSERT INTO org_users (id, org_id, name, name_key, role, created_at) VALUES ('usr-x', 'org-none', 'X', 'x', 'Scout', 1)").run(), /FOREIGN KEY/);
  s.prepare("INSERT INTO org_users (id, org_id, name, name_key, role, created_at) VALUES ('usr-new', 'org-pro', 'New', 'new', 'Scout', 1)").run();
  s.prepare("INSERT INTO sessions (token_hash, sid, kind, ref_id, org_user_id, created_at, expires_at) VALUES ('h-new', 'sid-new', 'org', 'org-pro', 'usr-new', 1, 2)").run();
  assert.throws(() => s.prepare("UPDATE org_users SET quiet_start = '25:00' WHERE id = 'usr-new'").run(), /CHECK/);
  assert.throws(() => s.prepare("INSERT INTO sessions (token_hash, sid, kind, ref_id, org_user_id, created_at, expires_at) VALUES ('h-x', 'sid-x', 'org', 'org-grass', 'usr-new', 1, 2)").run(), /FOREIGN KEY/, 'an org session names staff of its own organisation');
  assert.throws(() => s.prepare("DELETE FROM orgs WHERE id = 'org-pro'").run(), /FOREIGN KEY/, 'an organisation with staff cannot be deleted (deletion policy is open question O2)');
  s.close();
  // Failure injection after the rebuild but before the commit.
  const dir = tempDir('s3-inject');
  let f = openRaw(dir);
  runDataMigrations(f, [m0001, m0002, m0003], { context: { sessionTtlMs: TTL } });
  f.close();
  const before = fileDigest(dir);
  f = openRaw(dir);
  const exploding = { id: m0004.id, note: m0004.note, foreignKeysOff: true, up(sqlite, ctx) { m0004.up(sqlite, ctx); throw new Error('process died before commit'); } };
  assert.throws(() => runDataMigrations(f, [m0001, m0002, m0003, exploding], { context: { sessionTtlMs: TTL } }), /process died before commit/);
  assert.match(f.prepare("SELECT sql FROM sqlite_master WHERE name = 'orgs'").get().sql, /verification_org_type/, 'the rebuild was rolled back: the S1 shadow definition is still there');
  assert.equal(f.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  f.close();
  assert.equal(fileDigest(dir), before, 'nothing of the failed attempt reached the file');
  f = openRaw(dir);
  assert.deepEqual(runDataMigrations(f, S3_MIGRATIONS, { context: { sessionTtlMs: TTL } }).ran, [ORGS_CUTOVER_MIGRATION]);
  f.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------- the repository
test('repository: create and update(id, draft => …) write at once and return the stored record; records are fresh and frozen; the password hash is never on a record; junk, unknown fields, a changed id or creation time and a re-entrant update are refused, changing nothing', () => {
  const { s, repo } = fresh();
  const pro = repo.byId('org-pro');
  assert.deepEqual(pro, recordOf(ORGS()[0]));
  assert.ok(Object.isFrozen(pro) && Object.isFrozen(pro.location), 'deep-frozen');
  assert.throws(() => { pro.suspended = true; }, TypeError, 'a record cannot be edited in place');
  assert.notEqual(repo.byId('org-pro'), pro, 'every read is a fresh record');
  assert.ok(!('password' in pro) && !JSON.stringify(repo.list()).includes('scrypt'), 'no hash on any record');
  assert.equal(repo.passwordHashOf('org-pro'), 'scrypt$00$11'); assert.equal(repo.passwordHashOf('org-grass'), null);
  // update
  const updated = repo.update('org-pro', (d) => { d.suspended = true; d.verifiedDomain = null; d.location = { ...d.location, lat: 9 }; });
  assert.equal(updated.suspended, true); assert.equal(updated.location.lat, 9); assert.equal(pro.suspended, false, 'a record read before is a snapshot');
  assert.deepEqual({ ...s.prepare("SELECT suspended, verified_domain, lat, password_hash, created_at FROM orgs WHERE id = 'org-pro'").get() }, { suspended: 1, verified_domain: null, lat: 9, password_hash: 'scrypt$00$11', created_at: AT }, 'written at once; the hash and the creation time are kept');
  const quiet = dump(s);
  const refused = (fn, pattern) => { assert.throws(fn, pattern); assert.deepEqual(dump(s), quiet, 'nothing was written'); };
  refused(() => repo.update('org-pro', (d) => { d.level = 'agent'; }), /ORG_RECORD_INVALID: organisation org-pro: level must be one of/);
  refused(() => repo.update('org-pro', (d) => { d.memos = []; }), /unknown field memos/);
  refused(() => repo.update('org-pro', (d) => { d.verified = 'yes'; }), /verified must be a boolean/);
  refused(() => repo.update('org-pro', (d) => { d.id = 'org-other'; }), /id does not change through update/);
  refused(() => repo.update('org-pro', (d) => { d.createdAt = 1; }), /createdAt does not change through update/);
  refused(() => repo.update('org-none', (d) => { d.suspended = true; }), /ORG_NOT_FOUND/);
  refused(() => repo.update('org-pro', { suspended: true }), /takes a function/);
  refused(() => repo.update('org-pro', () => { repo.update('org-pro', (d) => { d.suspended = false; }); }), /ORG_UPDATE_REENTRANT/);
  // create
  const created = repo.create({ name: 'New FC', type: 'club', level: 'grassroots', location: { lat: 1, lng: 2, city: '' }, federationRef: { federation: 'FA', registrationId: 'R' }, plan: 'Grassroots', country: 'GB', passwordHash: 'scrypt$aa$bb' });
  assert.match(created.id, /^org-\d+$/, 'the id is minted'); assert.equal(created.createdAt, AT, 'stamped at creation'); assert.equal(created.location.city, null);
  assert.equal(repo.passwordHashOf(created.id), 'scrypt$aa$bb'); assert.equal(repo.count(), 4);
  assert.throws(() => repo.create({ id: 'org-pro', name: 'Dup', type: 'club', plan: 'Pro' }), /ORG_EXISTS/);
  assert.throws(() => repo.create({ name: 'B', type: 'club', level: 'agent', plan: 'Pro' }), /level must be one of/);
  assert.throws(() => repo.create({ name: 'B', type: 'club', plan: 'Pro', password: 'plain' }), /unknown field password/, 'a hash is passed as passwordHash, never as a field');
  assert.equal(repo.count(), 4);
  // the password
  repo.setPasswordHash('org-grass', 'scrypt$cc$dd'); assert.equal(repo.passwordHashOf('org-grass'), 'scrypt$cc$dd');
  assert.throws(() => repo.setPasswordHash('org-grass', 7), /password hash must be text/); assert.throws(() => repo.setPasswordHash('org-none', 'x'), /ORG_NOT_FOUND/);
  // an explicit write inside a caller's transaction joins it (and is rolled back with it)
  assert.throws(() => transaction(s, () => { repo.update('org-agency', (d) => { d.suspended = true; }); throw new Error('caller failed'); }), /caller failed/);
  assert.equal(repo.byId('org-agency').suspended, false);
  assert.throws(() => createOrgsRepository({ sqlite: new DatabaseSync(':memory:') }), /cutover record 0004_orgs_live is missing/);
  s.close();
});

test('reads are SQL: the sign-in filters, a page by cursor, a name lookup, the grassroots grounds inside a box, counts', () => {
  const extra = Array.from({ length: 5 }, (_, i) => ({ id: `org-c${i}`, name: `Club ${i}`, type: 'club', level: 'grassroots', plan: 'Grassroots', location: { lat: 51 + i, lng: 0 } }));
  const { s, repo } = fresh({ orgs: [...ORGS(), ...extra] });
  assert.deepEqual(repo.list({ level: 'grassroots' }).map((o) => o.id), ['org-grass', 'org-c0', 'org-c1', 'org-c2', 'org-c3', 'org-c4']);
  assert.deepEqual(repo.list({ notLevel: 'grassroots' }).map((o) => o.id), ['org-pro', 'org-agency'], 'an organisation without a level is on the main platform');
  assert.deepEqual(repo.list({ type: 'agency' }).map((o) => o.id), ['org-agency']);
  assert.deepEqual(repo.list({ level: null }).map((o) => o.id), ['org-agency']);
  assert.equal(repo.count(), 8); assert.equal(repo.count({ type: 'club' }), 7);
  const first = repo.page({ type: 'club' }, { limit: 3, after: null });
  assert.deepEqual(first.items.map((o) => o.id), ['org-pro', 'org-grass', 'org-c0']); assert.ok(first.nextCursor);
  const [after] = [JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8'))];
  const second = repo.page({ type: 'club' }, { limit: 3, after });
  assert.deepEqual(second.items.map((o) => o.id), ['org-c1', 'org-c2', 'org-c3']);
  const last = repo.page({ type: 'club' }, { limit: 3, after: JSON.parse(Buffer.from(second.nextCursor, 'base64url').toString('utf8')) });
  assert.deepEqual(last.items.map((o) => o.id), ['org-c4']); assert.equal(last.nextCursor, null);
  assert.equal(repo.byName('  riverside JUNIORS ')?.id, 'org-grass', 'case and surrounding spaces ignored'); assert.equal(repo.byName('Nobody'), null); assert.equal(repo.byName(''), null);
  assert.deepEqual(repo.locatedInBox({ minLat: 51.4, maxLat: 53.5, minLng: -1, maxLng: 1 }, { level: 'grassroots' }).map((o) => o.id), ['org-grass', 'org-c1', 'org-c2']);
  assert.deepEqual(Object.keys(repo.reads).sort(), ['byId', 'byName', 'count', 'initState', 'list', 'locatedInBox', 'page', 'passwordHashOf'].sort(), 'the reads object has no write');
  s.close();
});

test('units of work: an organisation write joins the open unit — a failure later in it leaves no organisation row, a read inside it sees its write, and db.orgs throws naming the repository', () => {
  const dir = tempDir('s14g-unit');
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = {};
  const layer = attachDataLayer({ db, seed: { orgs: ORGS(), guardians: [], players: [] }, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  assert.ok(!Object.keys(db).includes('orgs'), 'not enumerable');
  assert.throws(() => store.unitOfWork(() => {
    const o = layer.orgs.create({ name: 'Unit FC', type: 'club', plan: 'Pro' });
    layer.users.create({ orgId: o.id, name: 'Pat', role: 'Manager' });
    layer.orgs.update('org-pro', (d) => { d.suspended = true; });
    assert.equal(layer.orgs.byId('org-pro').suspended, true, 'a read inside the unit sees its write');
    throw new Error('late failure');
  }), /late failure/);
  assert.equal(layer.orgs.byName('Unit FC'), null); assert.equal(layer.orgs.byId('org-pro').suspended, false); assert.equal(store.sqlite.prepare('SELECT COUNT(*) AS n FROM org_users').get().n, 0);
  const kept = store.unitOfWork(() => { const o = layer.orgs.create({ name: 'Unit FC', type: 'club', plan: 'Pro' }); layer.users.create({ orgId: o.id, name: 'Pat', role: 'Manager' }); return o; });
  assert.equal(layer.orgs.byId(kept.id).name, 'Unit FC'); assert.equal(layer.users.forOrg(kept.id).length, 1);
  store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------- initialisation
test('initialisation is explicit state, never a row count — a genuine first installation initialises once, atomically, and retries after an interruption; an intentionally empty table stays empty; a later seed is ignored', () => {
  // (a) Through the data layer: a first installation imports the seed once; afterwards the table is authoritative.
  const dirB = tempDir('s3-c3b');
  let store = openStore(dirB, { tableBacked: TABLE_BACKED });
  let layer = attachDataLayer({ db: {}, seed: { orgs: ORGS(), guardians: [], players: [] }, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  assert.deepEqual(layer.boot.orgs, { engine: 'sqlite', rows: 3, imported: 3 });
  assert.equal(layer.orgs.initState(), 'done');
  assert.ok(Number.isSafeInteger(layer.orgs.byId('org-pro').createdAt), 'the seed is stamped at its import');
  store.sqlite.close();
  store = openStore(dirB, { tableBacked: TABLE_BACKED });
  layer = attachDataLayer({ db: {}, seed: { orgs: [...ORGS(), { id: 'org-late', name: 'Late', type: 'club', plan: 'Pro' }], guardians: [], players: [] }, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  assert.deepEqual(layer.boot.orgs, { engine: 'sqlite', rows: 3, imported: 0 }, 'initialised once, then the table');
  assert.equal(layer.orgs.byId('org-late'), null);
  store.sqlite.close(); fs.rmSync(dirB, { recursive: true, force: true });
  // (b) Interrupted initialisation: the rows and the state change are one transaction, so the next boot retries.
  const { s, repo: r } = fresh({ orgs: null });
  assert.equal(r.initState(), 'pending');
  const exec = s.exec.bind(s);
  let explode = true;
  s.exec = (sql) => { if (explode && sql === 'COMMIT') { explode = false; throw new Error('process died during initialisation'); } return exec(sql); };
  assert.throws(() => r.initialize(ORGS()), /process died during initialisation/);
  assert.equal(s.isTransaction, false);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM orgs').get().n, 0, 'nothing of the failed attempt remains');
  assert.equal(r.initState(), 'pending', 'still pending: the next boot retries');
  assert.throws(() => r.initialize([{ id: 'org-bad', name: 'B', type: 'club', level: 'agent', plan: 'Pro' }]), /entry #0 cannot be imported — organisation org-bad: level/);
  assert.equal(r.initState(), 'pending');
  assert.deepEqual(r.initialize(ORGS()), { engine: 'sqlite', rows: 3, imported: 3 });
  assert.equal(r.initState(), 'done');
  assert.throws(() => r.initialize(ORGS()), /already initialised/);
  s.close();
  // (c) An intentionally empty installation stays empty.
  const e = fresh({ orgs: [] });
  assert.equal(e.repo.initState(), 'done'); assert.equal(e.repo.count(), 0);
  assert.throws(() => e.repo.initialize(ORGS()), /already initialised/);
  e.s.close();
  // (d) Rows written outside the repository while pending are not initialised over.
  const w = fresh({ orgs: null });
  w.s.prepare("INSERT INTO orgs (id, name, type, plan, created_at) VALUES ('org-raw', 'Raw', 'club', 'Pro', 1)").run();
  assert.throws(() => w.repo.initialize(ORGS()), /already holds 1 row\(s\) written outside the repository/);
  w.s.close();
});

test('initialise refuses a collection that is not an array — an object, null, a string, a number or nothing — writing no row and keeping the state pending; an explicitly empty array is a valid, empty installation', () => {
  const { s, repo: r } = fresh({ orgs: null });
  const cases = [[{ id: 'synthetic-not-an-array' }, /an object/], [null, /null/], ['orgs', /a string/], [7, /a number/], [undefined, /absent/]];
  for (const [input, re] of cases) {
    const before = JSON.stringify(input ?? null);
    assert.throws(() => r.initialize(input), (err) => err instanceof TypeError && /initialize\(\) needs the first installation's organisations as an array/.test(err.message) && re.test(err.message) && /nothing was written/.test(err.message), `refused: ${re}`);
    assert.equal(r.initState(), 'pending'); assert.equal(r.count(), 0);
    assert.equal(JSON.stringify(input ?? null), before, 'the input is untouched'); assert.equal(s.isTransaction, false);
  }
  const dir = tempDir('s3-init-shape'); const store = openStore(dir, { tableBacked: TABLE_BACKED });
  assert.throws(() => attachDataLayer({ db: {}, seed: { orgs: { id: 'not-an-array' }, guardians: [], players: [] }, store, nextId, persist: () => {}, sessionTtlMs: TTL }), /organisations as an array/);
  assert.equal(store.sqlite.prepare("SELECT value FROM meta WHERE key = 'orgsInit'").get().value, 'pending');
  store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(r.initialize(ORGS()), { engine: 'sqlite', rows: 3, imported: 3 }); assert.equal(r.initState(), 'done');
  s.close();
});

// ------------------------------------------------------------- snapshot tools
test('snapshot mode: a fixture saved into a new directory goes into the table and reads back typed (with its hash); junk, unknown fields and a removed organisation still referenced reject the whole save', () => {
  const dir = tempDir('s3-snap');
  let tool = openStore(dir);
  tool.save({ idCounter: 1000, db: { orgs: ORGS(), users: fixtureUsers(), sessions: fixtureSessions(), players: [PLAYER_1()], guardians: [] } });
  assert.equal(hasBlobTable(tool.sqlite), false, 'no blob');
  assert.equal(tool.sqlite.prepare('SELECT COUNT(*) AS n FROM orgs').get().n, 3);
  tool.sqlite.close();
  tool = openStore(dir); let snap = tool.load();
  const createdAt = snap.db.orgs[0].createdAt;
  assert.ok(Number.isSafeInteger(createdAt), 'an absent creation time is the save\'s');
  assert.deepEqual(snap.db.orgs, ORGS().map((o) => ({ ...recordOf(o, o.createdAt ?? createdAt), password: o.password ?? null })), 'the table, rendered as typed records');
  const before = tool.load();
  const beforeDump = dump(tool.sqlite);
  const untouched = () => {
    const now = tool.load();
    assert.deepEqual(now.db.orgs, before.db.orgs, 'organisations unchanged');
    assert.equal(JSON.stringify(now.db.users), JSON.stringify(before.db.users), 'staff unchanged');
    assert.equal(JSON.stringify(now.db.sessions), JSON.stringify(before.db.sessions), 'sessions unchanged');
    assert.equal(now.db.players[0].name, 'P', 'the unrelated change was rolled back');
    assert.deepEqual(dump(tool.sqlite), beforeDump, 'nothing was written');
  };
  const attempt = (mutate, pattern) => { const x = tool.load(); x.db.players[0].name = 'Changed'; mutate(x); assert.throws(() => tool.save(x), pattern); untouched(); };
  attempt((x) => { x.db.orgs = { id: 'obj' }; }, /orgs: the snapshot collection must be an array/);
  attempt((x) => { x.db.orgs = null; }, /orgs: the snapshot collection must be an array/);
  attempt((x) => { x.db.orgs[0].level = 'agent'; }, /ORGS_IMPORT_BLOCKED: .*organisation org-pro: level must be one of/);
  attempt((x) => { x.db.orgs.push({ ...x.db.orgs[0] }); }, /duplicates organisation org-pro/);
  attempt((x) => { x.db.orgs.push({ id: 'org-x', name: 7, type: 'club', plan: 'Pro' }); }, /organisation org-x: name must be text/);
  attempt((x) => { x.db.orgs[1].tags = ['ST']; }, /organisation org-grass: unknown field tags/);
  attempt((x) => { x.db.orgs = x.db.orgs.filter((o) => o.id !== 'org-grass'); }, /orgs: the snapshot no longer lists organisation org-grass but other records still reference it/);
  attempt((x) => { x.db.users.push({ id: 'usr-x', orgId: 'org-none', name: 'X', role: 'Scout', createdAt: 1 }); }, /FOREIGN KEY/);
  // A valid write: a change, a new organisation, an organisation removed together with its staff and their sessions.
  const ok = tool.load();
  ok.db.orgs[0].suspended = true;
  ok.db.orgs.push({ id: 'org-tool', name: 'Tool FC', type: 'club', level: 'academy', plan: 'Academy' });
  ok.db.orgs = ok.db.orgs.filter((o) => o.id !== 'org-agency'); ok.db.users = ok.db.users.filter((u) => u.orgId !== 'org-agency');
  ok.db.players[0].name = 'Renamed';
  tool.save(ok);
  const after = tool.load();
  assert.deepEqual(after.db.orgs.map((o) => o.id), ['org-pro', 'org-grass', 'org-tool']);
  assert.equal(after.db.orgs[0].suspended, true); assert.equal(after.db.orgs[0].password, 'scrypt$00$11');
  assert.equal(after.db.players[0].name, 'Renamed');
  assert.ok(!after.db.users.some((u) => u.orgId === 'org-agency'));
  // An omitted orgs collection is a partial snapshot.
  const partial = tool.load(); delete partial.db.orgs; partial.db.players[0].name = 'Again'; tool.save(partial);
  assert.deepEqual(tool.load().db.orgs.map((o) => o.id), ['org-pro', 'org-grass', 'org-tool']); assert.equal(tool.load().db.players[0].name, 'Again');
  tool.sqlite.close();
  // The server reads the tool's result.
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const layer = attachDataLayer({ db: {}, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  assert.deepEqual(layer.orgs.list().map((o) => o.id), ['org-pro', 'org-grass', 'org-tool']); assert.equal(layer.orgs.byId('org-pro').suspended, true);
  assert.ok(layer.sessions.byToken('legacy-maria-token') && layer.sessions.byToken('legacy-sam-token'), 'staff sessions survived every refused and accepted save');
  store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------- through the real server
await atest('server: a fixture database boots; registration, settings, suspension, verification, credentials and staff sessions work; junk is refused; changes survive a restart; backup and restore keep every organisation', async () => {
  const dir = tempDir('s3-server');
  const seed = buildSeed();
  seed.users = [{ id: 'usr-legacy', orgId: 'org-eastport', name: 'Maria Keane', role: 'Head of Recruitment', createdAt: 1 }];
  seed.sessions = [{ token: 'legacy-maria-token-00000000000000000000000000', sid: 'sid-maria', kind: 'org', refId: 'org-eastport', userId: 'usr-legacy', createdAt: Date.now() - DAY }];
  // A Room owned by a live organisation: the boot integrity report must still
  // see the organisation on every boot (regression: it ran
  // before the data layer attached and called every Room an orphan).
  seed.recruitmentCases = [{ id: 'case-s3', orgId: 'org-eastport', playerId: seed.players[0].id, playerName: seed.players[0].name, ownerUserId: 'usr-legacy', ownerName: 'Maria Keane', stage: 'identified', priority: 'medium', deadline: null, restricted: false, assignments: [], tasks: [], approvals: [], decision: null, links: { requestIds: [], trialIds: [], signingId: null }, createdAt: 1, history: [], room: { status: 'watching', priority: 'normal', tags: [], leadScoutUserId: 'usr-legacy', sourceContext: 'direct', sourceRef: null, openedBy: { userId: 'usr-legacy', name: 'Maria Keane' }, updatedAt: 1, archivedAt: null, closedAt: null, rev: 1, revAt: 1, revBy: { userId: 'usr-legacy', name: 'Maria Keane' } } }]; // S8b: the case literal the room route writes
  // The fixture, saved by the snapshot store into the tables.
  { const t = openStore(dir); t.save({ idCounter: 1000, db: seed }); t.sqlite.close(); }
  const port = await freePort();
  const boot = () => new Promise((resolve, reject) => {
    const proc = spawnChild(process.execPath, [path.join(HERE, '..', 'server.mjs')], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, M13_QUIET_LOGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    proc.stdout.on('data', (d) => { log += d; if (/listening on/.test(log)) resolve({ proc, log: () => log }); });
    proc.stderr.on('data', (d) => { log += d; });
    proc.on('exit', (code, signal) => reject(new Error(`server exited ${code} (${signal}) on port ${port}: ${log}`)));
    setTimeout(() => reject(new Error(`boot timeout: ${log}`)), 20_000).unref();
  });
  const stop = (S) => new Promise((resolve) => { S.proc.on('exit', () => resolve()); S.proc.kill('SIGTERM'); });
  const j = async (method, p, body, token, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    let parsed = null; try { parsed = await r.json(); } catch { /* no body */ }
    return { status: r.status, body: parsed };
  };
  const A = { 'x-admin-key': 'scoutbox-admin' };
  let S = await boot();
  let regToken, newOrgId;
  try {
    const maria = seed.sessions[0].token;
    assert.equal((await j('GET', '/org/notifications', undefined, maria)).status, 200, 'the fixture staff session works');
    const cap = await j('GET', '/capabilities');
    assert.deepEqual(cap.body.dataLayer.migrations, ['0001_org_users', '0002_core_identity_shadow', '0003_sessions_live', '0004_orgs_live', '0005_core_identity_live', '0006_media_deletions', '0007_player_subrecords', '0008_one_time_codes', '0009_notifications', '0010_dispatches', '0011_outbox_push', '0012_channels', '0013_safety_audit', '0014_player_erasure', '0015_recruitment', '0016_recruitment_cases', '0017_recruitment_contacts_offers', '0018_signings_follow_ups', '0019_scouting_evidence', '0020_scouting_assessments', '0021_club_setup', '0022_opportunities_campaigns', '0023_verification', '0024_passport', '0025_transitions_vouches', '0026_agent_core', '0027_compliance_policies', '0028_compliance_records', '0029_agent_transactions', '0030_development', '0031_box_cam', '0032_discovery', '0033_insight_coverage', '0034_integrations', '0035_enterprise', '0036_groups', '0037_grassroots', '0038_operations', '0039_retire_blob', '0040_match_facts']);
    assert.equal(cap.body.dataLayer.domains.orgs.mode, 'live'); assert.equal(cap.body.dataLayer.domains.orgs.rows, 5);
    assert.equal(cap.body.integrity.ok, true, `the boot integrity report sees the live organisations: ${JSON.stringify(cap.body.integrity.byCode)}`);
    assert.ok(cap.body.integrity.checked >= 6, 'the report counted the organisations and the Room');
    // Directory and admin views keep their shapes (no password hash in either).
    const dirListing = await j('GET', '/orgs/directory');
    assert.equal(dirListing.status, 200); assert.ok(!JSON.stringify(dirListing.body).includes('scrypt'));
    assert.deepEqual(dirListing.body.items.map((o) => o.id), ['org-eastport', 'org-harbour', 'org-hackneymarsh', 'org-mossside'], 'the directory lists the clubs, oldest first'); assert.equal(dirListing.body.nextCursor, null);
    const dirPage = await j('GET', '/orgs/directory?limit=2');
    assert.equal(dirPage.body.items.length, 2); assert.ok(dirPage.body.nextCursor);
    const dirNext = await j('GET', `/orgs/directory?limit=2&cursor=${dirPage.body.nextCursor}`);
    assert.deepEqual(dirNext.body.items.map((o) => o.id), ['org-hackneymarsh', 'org-mossside']);
    assert.equal((await j('GET', '/orgs/directory?limit=0')).status, 400, 'a junk limit is refused'); assert.equal((await j('GET', '/orgs/directory?cursor=junk')).status, 400, 'a junk cursor is refused');
    const clubs = await j('GET', '/admin/clubs', undefined, null, A);
    assert.equal(clubs.status, 200); assert.equal(clubs.body.items.length, 5); assert.ok(!JSON.stringify(clubs.body).includes('password') && !JSON.stringify(clubs.body).includes('scrypt'));
    const east = clubs.body.items.find((o) => o.id === 'org-eastport');
    assert.deepEqual(Object.keys(east).sort(), ['country', 'createdAt', 'emailDomain', 'emailDomainVerified', 'federationCheck', 'federationRef', 'id', 'level', 'location', 'lookingFor', 'mfaRequiredForLeads', 'name', 'plan', 'safeguardingCertified', 'safeguardingContractSigned', 'suspended', 'trustedPartner', 'type', 'verificationRevokedAt', 'verified', 'verifiedDomain'].sort(), 'the admin view is an allowlist');
    assert.equal((await j('GET', '/admin/clubs?limit=abc', undefined, null, A)).status, 400);
    const picker = await j('GET', '/orgs?platform=grassroots');
    assert.deepEqual(picker.body.map((o) => o.id), ['org-hackneymarsh', 'org-mossside'], 'the sign-in picker is the whole filtered list (unpaged: known issue)');
    assert.deepEqual((await j('GET', '/orgs?platform=main')).body.map((o) => o.id), ['org-eastport', 'org-harbour', 'org-northstar']);
    assert.deepEqual((await j('GET', '/orgs?platform=agent')).body.map((o) => o.id), ['org-northstar']);
    // Registration: a new grassroots organisation is a table row at once.
    // A registration whose administrator cannot be created leaves no organisation behind (one unit since S14g).
    const before = (await j('GET', '/admin/clubs', undefined, null, A)).body.items.length;
    const badReg = await j('POST', '/auth/org/register-grassroots', { name: 'Half Rovers', scoutName: 'x'.repeat(121), country: 'GB', lat: 53.8, lng: -1.5, federation: 'West Riding FA', registrationId: 'WR-8' });
    assert.equal(badReg.status, 400);
    const regBase = { name: 'Junk Rovers', scoutName: 'Pat', country: 'GB', lat: 53.8, lng: -1.5, federation: 'West Riding FA', registrationId: 'WR-7' };
    for (const [over, error] of [[{ country: '' }, 'FIELD_INVALID'], [{ country: ' G' }, 'FIELD_INVALID'], [{ federation: '   ' }, 'FEDERATION_REQUIRED'], [{ registrationId: ' ' }, 'FEDERATION_REQUIRED']]) {
      const r = await j('POST', '/auth/org/register-grassroots', { ...regBase, ...over });
      assert.deepEqual([r.status, r.body?.error], [400, error], `junk ${JSON.stringify(over)} is a 400, not a 500`);
    }
    const reg = await j('POST', '/auth/org/register-grassroots', { name: 'Test Rovers', scoutName: 'Pat', role: 'Manager', country: 'GB', city: 'Leeds', lat: 53.8, lng: -1.5, federation: 'West Riding FA', registrationId: 'WR-9', password: 'rovers-pass-123' });
    assert.equal(reg.status, 201, JSON.stringify(reg.body)); newOrgId = reg.body.org.id;
    assert.equal(reg.body.org.password, undefined); assert.ok(Number.isSafeInteger(reg.body.org.createdAt), 'stamped at creation'); assert.deepEqual(reg.body.org.location, { lat: 53.8, lng: -1.5, city: 'Leeds' });
    assert.equal((await j('GET', '/admin/clubs', undefined, null, A)).body.items.length, before + 1, 'only the complete registration created an organisation');
    { const raw = openRaw(dir); assert.equal(raw.prepare('SELECT level FROM orgs WHERE id = ?').get(newOrgId).level, 'grassroots'); assert.equal(hasBlobTable(raw), false); raw.close(); }
    const login = await j('POST', '/auth/org/login', { orgId: newOrgId, scoutName: 'Pat', platform: 'grassroots', password: 'rovers-pass-123' });
    assert.equal(login.status, 200, JSON.stringify(login.body)); regToken = login.body.token;
    assert.equal((await j('POST', '/auth/org/login', { orgId: newOrgId, scoutName: 'Pat', platform: 'grassroots', password: 'wrong-password' })).status, 401, 'the stored password hash is checked');
    // Settings through the modules: lookingFor (server), security (m13) — a facet and a column.
    const lf = await j('POST', '/org/looking-for', { positions: ['ST', 'GK'] }, regToken);
    assert.ok([200, 404].includes(lf.status));
    const sec = await j('PUT', '/org/security', { mfaRequiredForLeads: true }, regToken);
    assert.ok([200, 403].includes(sec.status), `security route answered ${sec.status}`);
    if (sec.status === 200) {
      assert.equal(sec.body.mfaRequiredForLeads, true, 'the response is the stored value');
      assert.equal((await j('PUT', '/org/security', { mfaRequiredForLeads: 'yes' }, regToken)).body.error, 'FIELD_INVALID', 'a switch that is not a boolean is refused, not read as false');
    }
    // Admin: verification toggles and credentials rotation write columns; suspension locks the organisation out.
    for (const [body, field] of [[{ verified: 'yes' }, 'verified'], [{ suspended: 1 }, 'suspended'], [{ safeguardingContractSigned: 'true' }, 'safeguardingContractSigned'], [{ verifiedDomain: 7 }, 'verifiedDomain']]) {
      const r = await j('POST', `/admin/clubs/${newOrgId}/verification`, body, null, A);
      assert.deepEqual([r.status, r.body.error, r.body.field], [400, 'FIELD_INVALID', field], `${field} junk is refused, not coerced`);
    }
    { const raw = openRaw(dir); assert.equal(raw.prepare('SELECT verified, suspended FROM orgs WHERE id = ?').get(newOrgId).verified, 0); raw.close(); }
    const ver = await j('POST', `/admin/clubs/${newOrgId}/verification`, { verified: true, safeguardingContractSigned: true, verifiedDomain: 'rovers.example' }, null, A);
    assert.equal(ver.status, 200, JSON.stringify(ver.body));
    assert.equal(ver.body.verified, true); assert.equal(ver.body.verifiedDomain, 'rovers.example', 'the response is the updated organisation');
    { const raw = openRaw(dir); const row = raw.prepare('SELECT verified, safeguarding_contract_signed, verified_domain FROM orgs WHERE id = ?').get(newOrgId); assert.deepEqual({ ...row }, { verified: 1, safeguarding_contract_signed: 1, verified_domain: 'rovers.example' }); raw.close(); }
    assert.equal((await j('POST', `/admin/clubs/${newOrgId}/credentials`, { password: 'rotated-pass-123' }, null, A)).status, 200);
    assert.equal((await j('POST', '/auth/org/login', { orgId: newOrgId, scoutName: 'Pat', platform: 'grassroots', password: 'rovers-pass-123' })).status, 401, 'the old password is gone');
    const login2 = await j('POST', '/auth/org/login', { orgId: newOrgId, scoutName: 'Pat', platform: 'grassroots', password: 'rotated-pass-123' });
    assert.equal(login2.status, 200);
    assert.equal((await j('POST', `/admin/clubs/${newOrgId}/verification`, { suspended: true }, null, A)).status, 200);
    assert.equal((await j('GET', '/org/notifications', undefined, login2.body.token)).status, 403, 'a suspended organisation is refused');
    assert.equal((await j('GET', '/org/notifications', undefined, maria)).status, 200, 'another organisation is unaffected');
    assert.equal((await j('POST', `/admin/clubs/${newOrgId}/verification`, { suspended: false }, null, A)).status, 200);
    assert.equal((await j('GET', '/org/notifications', undefined, login2.body.token)).status, 200);
    regToken = login2.body.token;
  } finally { await stop(S); }
  // Restart: the changes came back.
  S = await boot();
  let backupDir;
  try {
    const clubs = await j('GET', '/admin/clubs', undefined, null, A);
    const rovers = clubs.body.items.find((o) => o.id === newOrgId);
    assert.equal(rovers.verified, true); assert.equal(rovers.verifiedDomain, 'rovers.example'); assert.equal(rovers.suspended, false);
    if (Array.isArray(rovers.lookingFor)) assert.deepEqual(rovers.lookingFor, ['ST', 'GK']);
    assert.equal((await j('GET', '/org/notifications', undefined, regToken)).status, 200, 'the session minted before the restart is still valid');
    const cap2 = await j('GET', '/capabilities');
    assert.equal(cap2.body.integrity.ok, true, `integrity after a restart: ${JSON.stringify(cap2.body.integrity.byCode)}`);
    assert.equal(cap2.body.integrity.byCode.ROOM_ORPHAN_ORG, undefined, 'the Room still belongs to an organisation the report can see');
    // Backup → restore: every organisation and every session.
    const backup = await (await fetch(`http://127.0.0.1:${port}/admin/backup`, { method: 'POST', headers: A })).json();
    backupDir = backup.dir;
    const copy = new DatabaseSync(path.join(backupDir, 'scoutbox.db'), { readOnly: true });
    assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM orgs').get().n, 6); assert.equal(copy.prepare('SELECT verified FROM orgs WHERE id = ?').get(newOrgId).verified, 1);
    copy.close();
  } finally { await stop(S); }
  const restoreDir = tempDir('s3-restore'); fs.cpSync(backupDir, restoreDir, { recursive: true });
  const port2 = await freePort();
  const restored = spawnChild(process.execPath, [path.join(HERE, '..', 'server.mjs')], { env: { ...process.env, PORT: String(port2), DATA_DIR: restoreDir, M13_QUIET_LOGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log2 = ''; restored.stdout.on('data', (d) => { log2 += d; }); restored.stderr.on('data', (d) => { log2 += d; });
  try {
    await new Promise((resolve, reject) => { restored.stdout.on('data', () => { if (/listening on/.test(log2)) resolve(); }); restored.on('exit', (c) => reject(new Error(`restored server exited ${c}: ${log2}`))); setTimeout(() => reject(new Error(`restore timeout: ${log2}`)), 20_000).unref(); });
    const r = await fetch(`http://127.0.0.1:${port2}/admin/clubs`, { headers: A });
    const clubs = (await r.json()).items;
    assert.equal(clubs.length, 6); assert.equal(clubs.find((o) => o.id === newOrgId).verifiedDomain, 'rovers.example');
    assert.equal((await fetch(`http://127.0.0.1:${port2}/org/notifications`, { headers: { authorization: `Bearer ${regToken}` } })).status, 200, 'the session survives backup and restore');
    const raw = openRaw(restoreDir); assert.equal(hasBlobTable(raw), false); assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []); raw.close();
  } finally {
    await new Promise((resolve) => { restored.on('exit', () => resolve()); restored.kill('SIGTERM'); });
    fs.rmSync(restoreDir, { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${passed} organisation checks passed`);
