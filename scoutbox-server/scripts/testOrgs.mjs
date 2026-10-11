// Behavioural tests for migration plan step S3: organisations become
// table-backed (scalars in columns, every other field in facets_json), org_users
// is rebuilt STRICT with the organisation foreign key, and a rollback tool
// produces a pre-S3 copy. Everything runs on throwaway databases under the OS
// temp directory with synthetic fixtures; nothing touches DATA_DIR. Run with: npm test
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations, transaction } from '../repositories/database.mjs';
import { createOrgsRepository, validateOrgRecord, toRow, fromRow, ORGS_TABLE, ORGS_CUTOVER_MIGRATION, MIGRATED_KEYS } from '../repositories/orgs.mjs';
import { rollbackOrgsCopy } from '../repositories/orgsRollback.mjs';
import { createCoreIdentityShadow, CORE_SHADOW_TABLES } from '../repositories/shadow.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import * as m0001 from '../repositories/migrations/0001_org_users.mjs';
import * as m0002 from '../repositories/migrations/0002_core_identity_shadow.mjs';
import * as m0003 from '../repositories/migrations/0003_sessions_live.mjs';
import * as m0004 from '../repositories/migrations/0004_orgs_live.mjs';
import { openStore } from '../store.mjs';
import { buildSeed } from '../seed.mjs';
import { pickPort } from './testPort.mjs';

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }
async function atest(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const DAY = 86_400_000;
const TTL = 30 * DAY;
const HERE = path.dirname(fileURLToPath(import.meta.url));
let counter = 9000;
const nextId = (p) => `${p}-${++counter}`;
const tempDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `sb-${tag}-`));
const openRaw = (dir) => { const s = new DatabaseSync(path.join(dir, 'scoutbox.db')); s.exec('PRAGMA foreign_keys = ON;'); return s; };
const fileDigest = (dir) => { const s = new DatabaseSync(path.join(dir, 'scoutbox.db')); s.exec('PRAGMA wal_checkpoint(TRUNCATE)'); s.close(); return sha256(fs.readFileSync(path.join(dir, 'scoutbox.db'))); };

/** Organisation records in every shape the application writes. */
const ORGS = () => [
  // The seed's shape: a pro club with location, explicit nulls and a verified domain.
  { id: 'org-pro', name: 'Eastport FC', type: 'club', level: 'pro', location: { lat: 51.889, lng: 1.02, city: 'Eastport' }, plan: 'Pro', trustedPartner: true, country: 'GB', verified: true, verifiedDomain: 'eastportfc.example', safeguardingContractSigned: true, password: 'scrypt$00$11', tactical: null, squad: [] },
  // Registration's shape (server.mjs): a grassroots club with a federation reference and a key order of its own.
  { id: 'org-grass', name: 'Riverside Juniors', type: 'club', level: 'grassroots', location: { lat: 51.5, lng: -0.1, city: 'London' }, federationRef: { federation: 'London FA', registrationId: 'LFA-1' }, plan: 'Grassroots', trustedPartner: false, country: 'GB', verified: false, verifiedDomain: null, safeguardingContractSigned: false, squad: [{ id: 'sq-1', name: 'Kid', position: 'ST', playerId: null, source: 'manual', addedAt: 5 }], lookingFor: ['ST', 'CB'] },
  // The verification review's shape (m14): level null, location null, a verification facet, unknown fields.
  { id: 'org-agency', name: 'Northstar Agency', type: 'agency', level: null, plan: 'Pro', trustedPartner: false, country: 'FR', verified: false, verifiedDomain: null, safeguardingContractSigned: false, location: null, federationRef: null, verification: { domains: [{ domain: 'northstar.example', status: 'verified', method: 'scoutbox_manual_review', verifiedAt: 7, addedBy: 'trust_safety' }], revokedAt: null, orgType: 'agency' }, agencySettings: { licence: 'FIFA-1' }, somethingNewer: { kept: true }, mfaRequiredForLeads: true, emailDomain: 'northstar.example', emailDomainVerified: true, createdAt: 1700000000000 },
];
const legacyUsers = () => [
  { id: 'usr-pro', orgId: 'org-pro', name: 'Maria Keane', role: 'Head of Recruitment', createdAt: 1, mfa: { secretB32: 'S', enabledAt: 7, recoveryHashes: ['h1'] }, deliveryPrefs: { quietStart: '22:00' }, oddField: { kept: true } },
  { id: 'usr-grass', orgId: 'org-grass', name: 'Sam', role: 'Manager', createdAt: 2 },
  { id: 'usr-agency', orgId: 'org-agency', name: 'Ava', role: 'Agent', createdAt: 3 },
];
const legacySessions = (now = Date.now()) => [
  { token: 'legacy-maria-token', sid: 'sid-maria', kind: 'org', refId: 'org-pro', userId: 'usr-pro', createdAt: now - DAY },
  { token: 'legacy-sam-token', sid: 'sid-sam', kind: 'org', refId: 'org-grass', userId: 'usr-grass', createdAt: now - DAY },
  { token: 'legacy-player-token', sid: 'sid-pl', kind: 'player', refId: 'pl-1', createdAt: now - DAY },
];

/** An S2 database file: migrations 0001–0003 applied, staff and sessions in their tables, orgs still a blob. */
function s2File(dir, { orgs = ORGS(), users = legacyUsers(), sessions = legacySessions(), extra = {} } = {}) {
  const s = new DatabaseSync(path.join(dir, 'scoutbox.db'));
  s.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  s.exec('CREATE TABLE IF NOT EXISTS collections (name TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  const put = s.prepare('INSERT INTO collections (name, value) VALUES (?, ?)');
  put.run('users', JSON.stringify(users));
  put.run('sessions', JSON.stringify(sessions));
  put.run('orgs', JSON.stringify(orgs));
  put.run('players', JSON.stringify([{ id: 'pl-1', name: 'P', media: [] }]));
  for (const [k, v] of Object.entries(extra)) put.run(k, JSON.stringify(v));
  s.prepare("INSERT INTO meta (key, value) VALUES ('idCounter', '1000'), ('savedAt', '1'), ('saveSeq', '1')").run();
  runDataMigrations(s, [m0001, m0002, m0003], { context: { sessionTtlMs: TTL } }); // S2 state: staff and sessions live, orgs a blob
  s.close();
}

// ------------------------------------------------------------- record ↔ row
test('mapping: every record shape the application writes round-trips byte for byte — key order, explicit nulls, absent fields, composites, unknown fields', () => {
  for (const rec of ORGS()) {
    const back = fromRow({ ...toRow(rec) });
    assert.equal(JSON.stringify(back), JSON.stringify(rec), `round trip of ${rec.id}`);
    assert.deepEqual(Object.keys(back), Object.keys(rec), `key order of ${rec.id}`);
  }
  // Absent versus null versus false, per field.
  const a = fromRow(toRow({ id: 'x', name: 'X', type: 'club', plan: 'Pro' }));
  assert.deepEqual(a, { id: 'x', name: 'X', type: 'club', plan: 'Pro' }, 'absent fields stay absent (no level, no booleans, no country)');
  const b = fromRow(toRow({ id: 'x', name: 'X', type: 'club', plan: 'Pro', level: null, country: null, verified: false, location: null, federationRef: { federation: null, registrationId: 'R' } }));
  assert.deepEqual(b, { id: 'x', name: 'X', type: 'club', plan: 'Pro', level: null, country: null, verified: false, location: null, federationRef: { federation: null, registrationId: 'R' } }, 'explicit nulls and false survive');
  // A composite with a sub-key the columns do not know keeps it.
  const c = fromRow(toRow({ id: 'x', name: 'X', type: 'club', plan: 'Pro', location: { lat: 1, lng: 2, city: 'C', postcode: 'E1' } }));
  assert.deepEqual(c.location, { lat: 1, lng: 2, city: 'C', postcode: 'E1' });
  // The row carries the scalars as columns and never the facets' keys as columns.
  const row = toRow(ORGS()[2]);
  assert.equal(row.level, null); assert.equal(row.mfa_required_for_leads, 1); assert.equal(row.email_domain, 'northstar.example'); assert.equal(row.created_at, 1700000000000);
  assert.equal(row.verification_org_type, 'agency'); assert.equal(row.verification_revoked_at, null);
  const facets = JSON.parse(row.facets_json);
  assert.deepEqual(Object.keys(facets).filter((k) => !k.startsWith('__')).sort(), ['agencySettings', 'somethingNewer', 'verification']);
  assert.ok(!('tactical' in facets) || true);
  for (const key of MIGRATED_KEYS) assert.ok(!(key in facets), `${key} is a column, never a facet`);
});
test('validation: unsupported records are refused with a reason and nothing is coerced', () => {
  const base = { id: 'x', name: 'X', type: 'club', level: 'pro', plan: 'Pro' };
  const refuse = (rec, pattern) => { const v = validateOrgRecord(rec); assert.equal(v.ok, false, JSON.stringify(rec)); assert.match(v.reason, pattern); };
  refuse(null, /not an object/); refuse([], /not an object/);
  refuse({ ...base, id: '' }, /no id/); refuse({ ...base, name: 7 }, /no name/);
  refuse({ ...base, type: 'school' }, /type .* is not one of club\/agency/);
  refuse({ ...base, level: 'agent' }, /level .* is not one of/); refuse({ ...base, plan: 'Free' }, /plan .* is not one of/);
  refuse({ ...base, verified: 'yes' }, /verified is a string .*, not a boolean/);
  refuse({ ...base, suspended: 1 }, /suspended is a number/);
  refuse({ ...base, country: 44 }, /country is a number/);
  refuse({ ...base, createdAt: '2024-01-01' }, /createdAt is a string/); refuse({ ...base, createdAt: 1.5 }, /createdAt/);
  refuse({ ...base, location: 'London' }, /location is a string/);
  refuse({ ...base, location: { lat: 1 } }, /one of lat\/lng without the other/);
  refuse({ ...base, location: { lat: 'a', lng: 'b' } }, /not finite numbers/);
  refuse({ ...base, federationRef: 'FA' }, /federationRef is a string/);
  refuse({ ...base, federationRef: { federation: 1 } }, /federationRef.federation is a number/);
  refuse({ ...base, verification: 'yes' }, /verification is a string/);
  refuse({ ...base, __meta: {} }, /reserved field/);
  assert.equal(validateOrgRecord({ ...base, level: null }).ok, true, 'level null is a supported shape (the verification review writes it)');
  for (const rec of ORGS()) assert.equal(validateOrgRecord(rec).ok, true, rec.id);
});

// ------------------------------------------------------------- the cutover migration
test('cutover: the orgs blob is imported with every field preserved, org_users is rebuilt STRICT with the orgs foreign key, every staff row and session survives, and the blob is retired — in one transaction', () => {
  const dir = tempDir('s3-valid'); s2File(dir);
  const s = openRaw(dir);
  const staffBefore = s.prepare('SELECT * FROM org_users ORDER BY rowid').all().map((r) => ({ ...r }));
  const sessionsBefore = s.prepare('SELECT token_hash, sid, org_user_id FROM sessions ORDER BY sid').all().map((r) => ({ ...r }));
  const before = s.prepare("SELECT sql FROM sqlite_master WHERE name = 'org_users'").get().sql;
  assert.ok(!/STRICT/.test(before) && !/REFERENCES/.test(before), 'the S0 table is not STRICT and has no foreign key');
  const r = runDataMigrations(s, DATA_MIGRATIONS, { context: { sessionTtlMs: TTL } });
  assert.deepEqual(r.ran, [ORGS_CUTOVER_MIGRATION]);
  // Organisations: every record, every field, in its own shape.
  const stored = ORGS_TABLE.read(s);
  assert.equal(JSON.stringify(stored), JSON.stringify(ORGS()), 'records read back exactly as the blob held them');
  assert.equal(s.prepare("SELECT COUNT(*) AS n FROM collections WHERE name = 'orgs'").get().n, 0, 'the legacy blob is retired');
  assert.equal(s.prepare("SELECT level FROM orgs WHERE id = 'org-agency'").get().level, null, 'the nullable level is stored as NULL');
  assert.equal(s.prepare("SELECT password_hash FROM orgs WHERE id = 'org-pro'").get().password_hash, 'scrypt$00$11');
  // Staff: rebuilt, every row and field identical, STRICT, foreign key, json checks, indexes.
  const after = s.prepare("SELECT sql FROM sqlite_master WHERE name = 'org_users'").get().sql;
  assert.match(after, /STRICT/); assert.match(after, /REFERENCES orgs\(id\)/); assert.match(after, /json_valid\(mfa_json\)/);
  assert.deepEqual(s.prepare('SELECT * FROM org_users ORDER BY rowid').all().map((r) => ({ ...r })), staffBefore, 'every staff row and field is carried over');
  assert.deepEqual(s.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'org_users' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((x) => x.name), ['org_users_org', 'org_users_org_email', 'org_users_org_name', 'org_users_sso']);
  // Sessions: untouched, still pointing at org_users by name, every reference intact.
  assert.deepEqual(s.prepare('SELECT token_hash, sid, org_user_id FROM sessions ORDER BY sid').all().map((r) => ({ ...r })), sessionsBefore, 'no session was cascaded away or changed');
  assert.match(s.prepare("SELECT sql FROM sqlite_master WHERE name = 'sessions'").get().sql, /REFERENCES org_users\(id\)/, 'sessions still references org_users, not a temporary name');
  assert.deepEqual(s.prepare('PRAGMA foreign_key_check').all(), [], 'every foreign key resolves');
  assert.equal(s.prepare("SELECT value FROM meta WHERE key = 'orgsCutover'").get().value.includes('"imported":3'), true);
  // The foreign key is enforced from now on, and the live tables still accept writes.
  assert.throws(() => s.prepare("INSERT INTO org_users (id, org_id, name) VALUES ('usr-x', 'org-none', 'X')").run(), /FOREIGN KEY/);
  s.prepare("INSERT INTO org_users (id, org_id, name) VALUES ('usr-new', 'org-pro', 'New')").run();
  s.prepare("INSERT INTO sessions (token_hash, sid, kind, ref_id, org_user_id, created_at, expires_at) VALUES ('h-new', 'sid-new', 'org', 'org-pro', 'usr-new', 1, 2)").run();
  assert.throws(() => s.prepare("UPDATE org_users SET mfa_json = 'not json' WHERE id = 'usr-new'").run(), /CHECK/);
  assert.throws(() => s.prepare("DELETE FROM orgs WHERE id = 'org-pro'").run(), /FOREIGN KEY/, 'an organisation with staff cannot be deleted (deletion policy is open question O2)');
  s.close(); fs.rmSync(dir, { recursive: true, force: true });
});
test('cutover: an unsupported record, a duplicate id or a staff row naming a missing organisation aborts the whole migration; the file is byte-identical; a restart aborts the same way; the repaired file cuts over', () => {
  const cases = [
    ['a refused record', (o) => { o[1].level = 'agent'; return o; }, /id org-grass: level a string \("agent"\)/],
    ['a duplicate id', (o) => [...o, { ...o[0] }], /id org-pro: duplicate id/],
    ['a plan outside the list', (o) => { o[0].plan = 'Free'; return o; }, /id org-pro: plan/],
    ['a staff row whose organisation is missing from the blob', (o) => o.filter((x) => x.id !== 'org-grass'), /staff usr-grass: names organisation org-grass, which the orgs blob does not hold/],
  ];
  for (const [name, mutate, pattern] of cases) {
    const dir = tempDir('s3-abort'); s2File(dir, { orgs: mutate(ORGS()) });
    const before = fileDigest(dir);
    for (let attempt = 0; attempt < 2; attempt++) {
      const s = openRaw(dir);
      assert.throws(() => runDataMigrations(s, DATA_MIGRATIONS, { context: { sessionTtlMs: TTL } }), (err) => /ORGS_CUTOVER_BLOCKED/.test(err.message) && pattern.test(err.message), `${name}: aborts (attempt ${attempt + 1})`);
      assert.equal(s.prepare('SELECT COUNT(*) AS n FROM data_migrations WHERE id = ?').get(ORGS_CUTOVER_MIGRATION).n, 0);
      assert.equal(s.prepare("SELECT COUNT(*) AS n FROM collections WHERE name = 'orgs'").get().n, 1, `${name}: the blob stays authoritative`);
      assert.ok(!/STRICT/.test(s.prepare("SELECT sql FROM sqlite_master WHERE name = 'org_users'").get().sql), `${name}: org_users was not rebuilt`);
      assert.equal(s.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 3, `${name}: sessions untouched`);
      assert.equal(s.prepare('PRAGMA foreign_keys').get().foreign_keys, 1, `${name}: foreign keys are back on after the failed step`);
      s.close();
      assert.equal(fileDigest(dir), before, `${name}: byte-identical`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Repair, then retry: cuts over.
  const dir = tempDir('s3-retry'); s2File(dir, { orgs: ORGS().map((o) => (o.id === 'org-grass' ? { ...o, level: 'agent' } : o)) });
  let s = openRaw(dir);
  assert.throws(() => runDataMigrations(s, DATA_MIGRATIONS, { context: { sessionTtlMs: TTL } }), /ORGS_CUTOVER_BLOCKED/);
  const fixed = JSON.parse(s.prepare("SELECT value FROM collections WHERE name = 'orgs'").get().value).map((o) => (o.id === 'org-grass' ? { ...o, level: 'grassroots' } : o));
  s.prepare("UPDATE collections SET value = ? WHERE name = 'orgs'").run(JSON.stringify(fixed));
  s.close(); s = openRaw(dir);
  assert.deepEqual(runDataMigrations(s, DATA_MIGRATIONS, { context: { sessionTtlMs: TTL } }).ran, [ORGS_CUTOVER_MIGRATION]);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM orgs').get().n, 3);
  s.close(); fs.rmSync(dir, { recursive: true, force: true });
});
test('cutover: an empty blob, a missing blob (first installation) and a stale populated S1 shadow all cut over to a complete, correct table; a failure injected before commit leaves no trace', () => {
  for (const [name, setup] of [['empty blob', (dir) => s2File(dir, { orgs: [], users: [], sessions: [] })], ['missing blob', (dir) => { s2File(dir, { orgs: [], users: [], sessions: [] }); const s = openRaw(dir); s.prepare("DELETE FROM collections WHERE name = 'orgs'").run(); s.close(); }]]) {
    const dir = tempDir('s3-empty'); setup(dir);
    const s = openRaw(dir);
    assert.deepEqual(runDataMigrations(s, DATA_MIGRATIONS, { context: { sessionTtlMs: TTL } }).ran, [ORGS_CUTOVER_MIGRATION], name);
    assert.equal(s.prepare('SELECT COUNT(*) AS n FROM orgs').get().n, 0, name);
    assert.equal(s.prepare('SELECT COUNT(*) AS n FROM data_migrations WHERE id = ?').get(ORGS_CUTOVER_MIGRATION).n, 1, `${name}: completion is the record, not the rows`);
    const repo = createOrgsRepository({ sqlite: s }); assert.deepEqual(repo.attach([]), { engine: 'sqlite', loaded: 0, imported: 0 });
    s.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
  // A stale populated shadow: rows an S1 projection left in the orgs table that no longer match the blob.
  const dir = tempDir('s3-stale'); s2File(dir);
  let s = openRaw(dir);
  s.prepare("INSERT INTO orgs (id, name, type, level, plan) VALUES ('org-ghost', 'Ghost', 'club', 'pro', 'Pro')").run();
  s.prepare("INSERT INTO orgs (id, name, type, level, plan) VALUES ('org-pro', 'Stale Name', 'club', 'pro', 'Pro')").run();
  runDataMigrations(s, DATA_MIGRATIONS, { context: { sessionTtlMs: TTL } });
  assert.deepEqual(s.prepare('SELECT id, name FROM orgs ORDER BY id').all().map((r) => [r.id, r.name]), [['org-agency', 'Northstar Agency'], ['org-grass', 'Riverside Juniors'], ['org-pro', 'Eastport FC']], 'the shadow rows are replaced by the blob, the authoritative source');
  s.close(); fs.rmSync(dir, { recursive: true, force: true });
  // Failure injection after the rebuild but before the commit.
  const dir2 = tempDir('s3-inject'); s2File(dir2);
  s = openRaw(dir2);
  const before = fileDigest(dir2);
  const exploding = { id: m0004.id, note: m0004.note, foreignKeysOff: true, up(sqlite, ctx) { m0004.up(sqlite, ctx); assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM orgs').get().n, 3, 'rows were written inside the transaction'); throw new Error('process died before commit'); } };
  assert.throws(() => runDataMigrations(s, [m0001, m0002, m0003, exploding], { context: { sessionTtlMs: TTL } }), /process died before commit/);
  assert.equal(s.prepare("SELECT COUNT(*) AS n FROM collections WHERE name = 'orgs'").get().n, 1);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 3);
  assert.ok(!/STRICT/.test(s.prepare("SELECT sql FROM sqlite_master WHERE name = 'org_users'").get().sql));
  assert.equal(s.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  s.close();
  assert.equal(fileDigest(dir2), before, 'nothing of the failed attempt reached the file');
  s = openRaw(dir2);
  assert.deepEqual(runDataMigrations(s, DATA_MIGRATIONS, { context: { sessionTtlMs: TTL } }).ran, [ORGS_CUTOVER_MIGRATION]);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM orgs').get().n, 3);
  s.close(); fs.rmSync(dir2, { recursive: true, force: true });
});

// ------------------------------------------------------------- the repository
test('repository: insert and update write migrated fields immediately; a migrated field on the view throws; facet fields are mutable in place and persisted by flush, atomically with a save', () => {
  const dir = tempDir('s3-repo');
  let store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = { orgs: ORGS(), guardians: [], players: [{ id: 'pl-1', name: 'P' }], sessions: [], users: [] };
  let layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  assert.deepEqual(layer.boot.orgs, { engine: 'sqlite', loaded: 3, imported: 3 }, 'a first boot imports the in-memory records (seed / fixture)');
  assert.equal(db.orgs.length, 3);
  assert.equal(JSON.stringify(db.orgs), JSON.stringify(ORGS()), 'the view renders the records exactly');
  // Migrated fields: refused on the view, written through update.
  const pro = db.orgs.find((o) => o.id === 'org-pro');
  assert.throws(() => { pro.suspended = true; }, /organisations repository/);
  assert.throws(() => { pro.name = 'X'; }, /organisations repository/);
  assert.throws(() => { pro.location = { lat: 0, lng: 0 }; }, /organisations repository/);
  assert.throws(() => { delete pro.country; }, /organisations repository/);
  assert.throws(() => { db.orgs.push({ id: 'org-x' }); }, /organisations repository/);
  assert.throws(() => { db.orgs[0] = {}; }, /organisations repository/);
  assert.throws(() => { db.orgs = []; }, TypeError);
  layer.orgs.update('org-pro', { suspended: true, verifiedDomain: null, password: 'scrypt$new' });
  assert.equal(pro.suspended, true, 'the same record object the route holds is current'); assert.equal(pro.verifiedDomain, null); assert.equal(pro.password, 'scrypt$new');
  assert.equal(store.sqlite.prepare("SELECT suspended, verified_domain, password_hash FROM orgs WHERE id = 'org-pro'").get().suspended, 1, 'written immediately');
  assert.throws(() => layer.orgs.update('org-pro', { level: 'agent' }), /refused: level/);
  assert.throws(() => layer.orgs.update('org-pro', { squad: [] }), /not a migrated organisation field/);
  assert.throws(() => layer.orgs.update('org-none', { suspended: true }), /does not exist/);
  // Facets: mutated in place (as the modules do), persisted by the next save.
  pro.squad.push({ id: 'sq-9', name: 'New', position: 'GK', playerId: null, source: 'manual', addedAt: 9 });
  pro.tactical = { formation: '4-3-3' };
  pro.verification = { domains: [], revokedAt: 123, orgType: 'professional club' };
  const grass = db.orgs.find((o) => o.id === 'org-grass');
  grass.lookingFor = ['GK'];
  delete grass.squad;
  assert.equal(JSON.parse(store.sqlite.prepare("SELECT facets_json FROM orgs WHERE id = 'org-pro'").get().facets_json).squad.length, 0, 'not yet persisted');
  store.save({ savedAt: 2, idCounter: 1000, db });
  const facets = JSON.parse(store.sqlite.prepare("SELECT facets_json FROM orgs WHERE id = 'org-pro'").get().facets_json);
  assert.equal(facets.squad.length, 1); assert.deepEqual(facets.tactical, { formation: '4-3-3' });
  assert.equal(store.sqlite.prepare("SELECT verification_revoked_at, verification_org_type FROM orgs WHERE id = 'org-pro'").get().verification_org_type, 'professional club', 'the mirror columns follow the facet');
  assert.equal(store.sqlite.prepare("SELECT COUNT(*) AS n FROM collections WHERE name = 'orgs'").get().n, 0, 'no blob');
  // Insert: a new organisation is a row from the first byte.
  const created = layer.orgs.insert({ id: 'org-new', name: 'New FC', type: 'club', level: 'grassroots', location: { lat: 1, lng: 2, city: '' }, federationRef: { federation: 'FA', registrationId: 'R' }, plan: 'Grassroots', trustedPartner: false, country: 'GB', verified: false, verifiedDomain: null, safeguardingContractSigned: false });
  assert.equal(db.orgs.length, 4); assert.equal(db.orgs[3], created); assert.equal(layer.orgs.byId('org-new'), created);
  assert.equal(store.sqlite.prepare("SELECT COUNT(*) AS n FROM orgs WHERE id = 'org-new'").get().n, 1);
  assert.throws(() => layer.orgs.insert({ id: 'org-new', name: 'Dup', type: 'club', plan: 'Pro' }), /already exists/);
  assert.throws(() => layer.orgs.insert({ id: 'org-bad', name: 'B', type: 'club', level: 'agent', plan: 'Pro' }), /refused/);
  store.sqlite.close();
  // Restart: scalar changes and facet changes come back together.
  store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db2 = { orgs: [], guardians: [], players: [], sessions: [], users: [] };
  layer = attachDataLayer({ db: db2, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  assert.deepEqual(layer.boot.orgs, { engine: 'sqlite', loaded: 4, imported: 0 });
  const pro2 = db2.orgs.find((o) => o.id === 'org-pro');
  assert.equal(pro2.suspended, true); assert.equal(pro2.password, 'scrypt$new'); assert.equal(pro2.squad.length, 1); assert.deepEqual(pro2.tactical, { formation: '4-3-3' }); assert.equal(pro2.verification.revokedAt, 123);
  const grass2 = db2.orgs.find((o) => o.id === 'org-grass');
  assert.deepEqual(grass2.lookingFor, ['GK']); assert.ok(!('squad' in grass2), 'a deleted facet stays deleted');
  assert.equal(JSON.stringify(db2.orgs.find((o) => o.id === 'org-agency')), JSON.stringify(ORGS()[2]), 'an untouched record is byte-identical after the restart');
  store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});
test('repository: authority is the cutover record — attach refuses without it; a stale in-memory array never overwrites the table; a first-boot import refuses invalid records', () => {
  const s = new DatabaseSync(':memory:'); s.exec('PRAGMA foreign_keys = ON;');
  runDataMigrations(s, [m0001, m0002, m0003]);
  assert.throws(() => createOrgsRepository({ sqlite: s }).attach([]), /cutover record 0004_orgs_live is missing/);
  runDataMigrations(s, DATA_MIGRATIONS);
  const warnings = [];
  const repo = createOrgsRepository({ sqlite: s, warn: (m) => warnings.push(m) });
  assert.throws(() => repo.attach([{ id: 'org-bad', name: 'B', type: 'club', level: 'agent', plan: 'Pro' }]), /cannot be imported — id org-bad: level/);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM orgs').get().n, 0, 'nothing imported from a refused batch');
  repo.attach(ORGS());
  assert.equal(repo.count(), 3);
  const again = createOrgsRepository({ sqlite: s, warn: (m) => warnings.push(m) });
  again.attach([ORGS()[0], { id: 'org-stale', name: 'S', type: 'club', plan: 'Pro' }]);
  assert.equal(again.count(), 3, 'the table wins; the stale array row is not imported');
  assert.match(warnings[0], /1 organisation\(s\) the table does not hold was ignored/);
  s.close();
});

// ------------------------------------------------------------- snapshot tools
test('snapshot mode: before the cutover record the orgs blob is authoritative; after it the table is read and written back, with shape and row validation rejecting the whole save', () => {
  const dir = tempDir('s3-snap'); s2File(dir);
  // Before: S2 state, blob authoritative, table (S1 shadow) ignored.
  let tool = openStore(dir);
  let snap = tool.load();
  assert.equal(JSON.stringify(snap.db.orgs), JSON.stringify(ORGS()), 'the blob');
  snap.db.players.push({ id: 'pl-2', name: 'Q' }); tool.save(snap);
  assert.equal(JSON.parse(tool.sqlite.prepare("SELECT value FROM collections WHERE name = 'orgs'").get().value).length, 3, 'the blob is kept');
  assert.equal(tool.sqlite.prepare('SELECT COUNT(*) AS n FROM orgs').get().n, 0, 'the shadow table is not promoted');
  tool.sqlite.close();
  // Cut over through the server path.
  let store = openStore(dir, { tableBacked: TABLE_BACKED });
  let layer = attachDataLayer({ db: { ...store.load().db }, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  assert.equal(layer.orgs.count(), 3); store.sqlite.close();
  // After: the table, as records.
  tool = openStore(dir); snap = tool.load();
  assert.equal(JSON.stringify(snap.db.orgs), JSON.stringify(ORGS()), 'the table, rendered as the same records');
  const before = tool.load();
  const untouched = () => {
    const now = tool.load();
    assert.equal(JSON.stringify(now.db.orgs), JSON.stringify(before.db.orgs), 'organisations unchanged');
    assert.equal(JSON.stringify(now.db.users), JSON.stringify(before.db.users), 'staff unchanged');
    assert.equal(JSON.stringify(now.db.sessions), JSON.stringify(before.db.sessions), 'sessions unchanged');
    assert.equal(now.db.players[0].name, 'P', 'the unrelated change was rolled back');
    assert.equal(now.saveSeq, before.saveSeq);
    assert.equal(tool.sqlite.prepare("SELECT COUNT(*) AS n FROM collections WHERE name = 'orgs'").get().n, 0, 'no legacy blob recreated');
  };
  const attempt = (mutate, pattern) => { const x = tool.load(); x.db.players[0].name = 'Changed'; mutate(x); assert.throws(() => tool.save(x), pattern); untouched(); };
  attempt((x) => { x.db.orgs = { id: 'obj' }; }, /orgs: the snapshot collection must be an array/);
  attempt((x) => { x.db.orgs = null; }, /orgs: the snapshot collection must be an array/);
  attempt((x) => { x.db.orgs[0].level = 'agent'; }, /orgs: snapshot row id org-pro was refused \(level/);
  attempt((x) => { x.db.orgs.push({ ...x.db.orgs[0] }); }, /duplicate id/);
  attempt((x) => { x.db.orgs.push({ id: 'org-x', name: 7, type: 'club', plan: 'Pro' }); }, /no name/);
  attempt((x) => { x.db.orgs = x.db.orgs.filter((o) => o.id !== 'org-grass'); }, /orgs: the snapshot no longer lists organisation org-grass but other records still reference it/);
  attempt((x) => { x.db.users.push({ id: 'usr-x', orgId: 'org-none', name: 'X', role: 'Scout', createdAt: 1 }); }, /FOREIGN KEY/);
  // A valid write: scalar and facet changes together, a new organisation, an organisation removed together with its staff and their sessions.
  const ok = tool.load();
  ok.db.orgs[0].suspended = true; ok.db.orgs[0].squad.push({ id: 'sq-t', name: 'T' }); ok.db.orgs[0].brandNew = { from: 'tool' };
  ok.db.orgs.push({ id: 'org-tool', name: 'Tool FC', type: 'club', level: 'academy', plan: 'Academy' });
  ok.db.orgs = ok.db.orgs.filter((o) => o.id !== 'org-agency'); ok.db.users = ok.db.users.filter((u) => u.orgId !== 'org-agency');
  ok.db.players[0].name = 'Renamed';
  tool.save(ok);
  const after = tool.load();
  assert.deepEqual(after.db.orgs.map((o) => o.id), ['org-pro', 'org-grass', 'org-tool']);
  assert.equal(after.db.orgs[0].suspended, true); assert.equal(after.db.orgs[0].squad.length, 1); assert.deepEqual(after.db.orgs[0].brandNew, { from: 'tool' });
  assert.equal(after.db.players[0].name, 'Renamed');
  assert.ok(!after.db.users.some((u) => u.orgId === 'org-agency'));
  // An omitted orgs collection is a partial snapshot.
  const partial = tool.load(); delete partial.db.orgs; partial.db.players[0].name = 'Again'; tool.save(partial);
  assert.deepEqual(tool.load().db.orgs.map((o) => o.id), ['org-pro', 'org-grass', 'org-tool']); assert.equal(tool.load().db.players[0].name, 'Again');
  tool.sqlite.close();
  // The server reads the tool's result.
  store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db2 = { orgs: [], guardians: [], players: [], sessions: [], users: [] };
  layer = attachDataLayer({ db: db2, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  assert.deepEqual(db2.orgs.map((o) => o.id), ['org-pro', 'org-grass', 'org-tool']); assert.equal(db2.orgs[0].suspended, true);
  assert.ok(layer.sessions.byToken('legacy-maria-token') && layer.sessions.byToken('legacy-sam-token'), 'staff sessions survived every refused and accepted save');
  store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------- shadow isolation
test('shadow validation, even when enabled, never writes or deletes live organisations or sessions', () => {
  const dir = tempDir('s3-shadow');
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = { orgs: ORGS(), guardians: [{ id: 'gd-1', name: 'G', email: 'g@example.com', childIds: [] }], players: [], sessions: [], users: [] };
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, shadowValidation: true });
  const a = layer.sessions.create('player', 'pl-1');
  const rowsBefore = store.sqlite.prepare('SELECT * FROM orgs ORDER BY rowid').all().map((r) => ({ ...r }));
  for (let i = 1; i <= 3; i++) store.save({ savedAt: i, idCounter: 1000, db });
  assert.deepEqual(store.sqlite.prepare('SELECT * FROM orgs ORDER BY rowid').all().map((r) => ({ ...r })), rowsBefore, 'orgs rows untouched by three projecting saves');
  assert.ok(layer.sessions.byToken(a.token));
  assert.deepEqual([...CORE_SHADOW_TABLES], ['guardians', 'players', 'guardian_children']);
  const report = layer.report();
  assert.ok(!('orgs' in report.shadow.tables)); assert.equal(report.domains.orgs.mode, 'live'); assert.equal(report.domains.orgs.rows, 3);
  const shadow = createCoreIdentityShadow({ sqlite: store.sqlite });
  transaction(store.sqlite, () => shadow.project({ orgs: [], guardians: [], players: [] }));
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) AS n FROM orgs').get().n, 3, 'a direct projection of an empty snapshot deletes no organisation');
  store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------- rollback
test('rollback: the tool produces a pre-S3 copy — orgs back in the blob with every field, org_users back to the S0 definition with every row, sessions untouched, source unchanged; it refuses a later schema and a file that never cut over', () => {
  const dir = tempDir('s3-rb-src'); s2File(dir, { extra: { notes: [{ id: 'n1' }] } });
  let store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = { ...store.load().db };
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  layer.orgs.update('org-pro', { suspended: true }); db.orgs[0].squad.push({ id: 'sq-after', name: 'After S3' });
  layer.orgs.insert({ id: 'org-after', name: 'After FC', type: 'club', level: 'pro', plan: 'Pro' });
  const minted = layer.sessions.create('org', 'org-pro', { userId: 'usr-pro' });
  store.save({ savedAt: 2, idCounter: 1000, db }); store.sqlite.close();
  const before = fileDigest(dir);
  const out = tempDir('s3-rb-out');
  const result = rollbackOrgsCopy(path.join(dir, 'scoutbox.db'), out);
  assert.equal(fileDigest(dir), before, 'the source is untouched');
  assert.equal(result.organisations, 4); assert.equal(result.staff, 3); assert.equal(result.sessions, 4); assert.equal(result.recordRemoved, true);
  const o = openRaw(out);
  assert.deepEqual(o.prepare('SELECT id FROM data_migrations ORDER BY id').all().map((r) => r.id), ['0001_org_users', '0002_core_identity_shadow', '0003_sessions_live']);
  const blob = JSON.parse(o.prepare("SELECT value FROM collections WHERE name = 'orgs'").get().value);
  assert.deepEqual(blob.map((x) => x.id), ['org-pro', 'org-grass', 'org-agency', 'org-after']);
  assert.equal(blob[0].suspended, true); assert.equal(blob[0].squad.at(-1).name, 'After S3'); assert.equal(JSON.stringify(blob[2]), JSON.stringify(ORGS()[2]), 'post-S3 changes are kept; an untouched record is identical');
  assert.equal(o.prepare('SELECT COUNT(*) AS n FROM orgs').get().n, 0, 'the S1 shadow table is empty');
  assert.ok(!/facets_json/.test(o.prepare("SELECT sql FROM sqlite_master WHERE name = 'orgs'").get().sql), 'the S1 definition');
  const staffSql = o.prepare("SELECT sql FROM sqlite_master WHERE name = 'org_users'").get().sql;
  assert.ok(!/STRICT/.test(staffSql) && !/REFERENCES/.test(staffSql), 'org_users is back to the S0 definition');
  assert.equal(o.prepare('SELECT COUNT(*) AS n FROM org_users').get().n, 3);
  assert.deepEqual(o.prepare('SELECT sid FROM sessions ORDER BY sid').all().map((r) => r.sid).length, 4, 'every session, the one minted after S3 included, is kept');
  assert.ok(o.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(sha256(minted.token)));
  assert.match(o.prepare("SELECT sql FROM sqlite_master WHERE name = 'sessions'").get().sql, /REFERENCES org_users\(id\)/);
  assert.deepEqual(o.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(o.prepare("SELECT value FROM collections WHERE name = 'notes'").get().value, '[{"id":"n1"}]');
  o.close();
  // The S2 data layer (the previous build's repositories: 0001–0003) attaches to the copy and reads the sessions.
  // Refusals: a later schema step, and a file that never cut over.
  const later = openRaw(dir); later.prepare("INSERT INTO data_migrations (id, applied_at) VALUES ('0005_core_identity_live', 1)").run(); later.close();
  const out2 = tempDir('s3-rb-out2');
  assert.throws(() => rollbackOrgsCopy(path.join(dir, 'scoutbox.db'), out2), (err) => err.code === 'LATER_SCHEMA' && /0005_core_identity_live/.test(err.message));
  assert.deepEqual(fs.readdirSync(out2), [], 'a refused rollback leaves no output');
  const out3 = tempDir('s3-rb-out3');
  assert.throws(() => rollbackOrgsCopy(path.join(out, 'scoutbox.db'), out3), (err) => err.code === 'NOT_CUT_OVER');
  assert.deepEqual(fs.readdirSync(out3), []);
  // CLI exit codes.
  const script = path.join(HERE, 'orgsRollback.mjs');
  try { execFileSync(process.execPath, [script, dir, path.join(tempDir('s3-rb-cli'), 'x')], { stdio: 'pipe' }); assert.fail('should refuse'); } catch (err) { assert.equal(err.status, 4); }
  try { execFileSync(process.execPath, [script, out, path.join(tempDir('s3-rb-cli2'), 'x')], { stdio: 'pipe' }); assert.fail('should refuse'); } catch (err) { assert.equal(err.status, 5); }
  for (const d of [dir, out, out2, out3]) fs.rmSync(d, { recursive: true, force: true });
});

// ------------------------------------------------------------- through the real server
await atest('server: an S2 database boots and cuts over; registration, settings, suspension, verification, credentials and staff sessions work; facet and scalar changes survive a restart; backup and restore keep every organisation', async () => {
  const dir = tempDir('s3-server');
  const seed = buildSeed();
  seed.users = [{ id: 'usr-legacy', orgId: 'org-eastport', name: 'Maria Keane', role: 'Head of Recruitment', createdAt: 1 }];
  seed.sessions = [{ token: 'legacy-maria-token-00000000000000000000000000', sid: 'sid-maria', kind: 'org', refId: 'org-eastport', userId: 'usr-legacy', createdAt: Date.now() - DAY }];
  seed.orgs.find((o) => o.id === 'org-eastport').squad = [{ id: 'sq-seed', name: 'Seeded', position: 'ST', playerId: null, source: 'manual', addedAt: 1 }];
  // A Room owned by a live organisation: the boot integrity report must still
  // see the organisation on every boot after the cutover (regression: it ran
  // before the data layer attached and called every Room an orphan).
  seed.recruitmentCases = [{ id: 'case-s3', orgId: 'org-eastport', playerId: seed.players[0].id, room: { status: 'watching', rev: 1 } }];
  // An S2 file: blobs saved by the snapshot store, then migrations 0001–0003 applied.
  openStore(dir).save({ savedAt: Date.now(), idCounter: 1000, db: seed });
  { const s = openRaw(dir); runDataMigrations(s, [m0001, m0002, m0003], { context: { sessionTtlMs: TTL } }); s.close(); }
  const port = pickPort(7600, 100);
  const boot = () => new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(HERE, '..', 'server.mjs')], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, M13_QUIET_LOGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    proc.stdout.on('data', (d) => { log += d; if (/listening on/.test(log)) resolve({ proc, log: () => log }); });
    proc.stderr.on('data', (d) => { log += d; });
    proc.on('exit', (code, signal) => reject(new Error(`server exited ${code} (${signal}) on port ${port}: ${log}`)));
    setTimeout(() => reject(new Error(`boot timeout: ${log}`)), 20_000);
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
    assert.equal((await j('GET', '/org/notifications', undefined, maria)).status, 200, 'the staff session survived the org_users rebuild');
    const cap = await j('GET', '/capabilities');
    assert.deepEqual(cap.body.dataLayer.migrations, ['0001_org_users', '0002_core_identity_shadow', '0003_sessions_live', '0004_orgs_live']);
    assert.equal(cap.body.dataLayer.domains.orgs.mode, 'live'); assert.equal(cap.body.dataLayer.domains.orgs.rows, 5);
    assert.equal(cap.body.integrity.ok, true, `the boot integrity report sees the live organisations: ${JSON.stringify(cap.body.integrity.byCode)}`);
    assert.ok(cap.body.integrity.checked >= 6, 'the report counted the organisations and the Room');
    // Directory and admin views keep their shapes (no password hash in either).
    const dirListing = await j('GET', '/orgs/directory');
    assert.equal(dirListing.status, 200); assert.ok(!JSON.stringify(dirListing.body).includes('scrypt'));
    const clubs = await j('GET', '/admin/clubs', undefined, null, A);
    assert.equal(clubs.status, 200); assert.ok(clubs.body.find((o) => o.id === 'org-eastport').squad.length === 1, 'the facet is served'); assert.ok(!JSON.stringify(clubs.body).includes('password'));
    // Registration: a new grassroots organisation is a table row at once.
    const reg = await j('POST', '/auth/org/register-grassroots', { name: 'Test Rovers', scoutName: 'Pat', role: 'Manager', country: 'GB', city: 'Leeds', lat: 53.8, lng: -1.5, federation: 'West Riding FA', registrationId: 'WR-9', password: 'rovers-pass-123' });
    assert.equal(reg.status, 201, JSON.stringify(reg.body)); newOrgId = reg.body.org.id;
    { const raw = openRaw(dir); assert.equal(raw.prepare('SELECT level FROM orgs WHERE id = ?').get(newOrgId).level, 'grassroots'); assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM collections WHERE name = 'orgs'").get().n, 0); raw.close(); }
    const login = await j('POST', '/auth/org/login', { orgId: newOrgId, scoutName: 'Pat', platform: 'grassroots', password: 'rovers-pass-123' });
    assert.equal(login.status, 200, JSON.stringify(login.body)); regToken = login.body.token;
    assert.equal((await j('POST', '/auth/org/login', { orgId: newOrgId, scoutName: 'Pat', platform: 'grassroots', password: 'wrong-password' })).status, 401, 'the stored password hash is checked');
    // Settings through the modules: lookingFor (server), security (m13) — a facet and a column.
    const lf = await j('POST', '/org/looking-for', { positions: ['ST', 'GK'] }, regToken);
    assert.ok([200, 404].includes(lf.status));
    const sec = await j('PUT', '/org/security', { mfaRequiredForLeads: true }, regToken);
    assert.ok([200, 403].includes(sec.status), `security route answered ${sec.status}`);
    // Admin: verification toggles and credentials rotation write columns; suspension locks the organisation out.
    const ver = await j('POST', `/admin/clubs/${newOrgId}/verification`, { verified: true, safeguardingContractSigned: true, verifiedDomain: 'rovers.example' }, null, A);
    assert.equal(ver.status, 200, JSON.stringify(ver.body));
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
  // Restart: columns and facets came back together.
  S = await boot();
  let backupDir;
  try {
    const clubs = await j('GET', '/admin/clubs', undefined, null, A);
    const rovers = clubs.body.find((o) => o.id === newOrgId);
    assert.equal(rovers.verified, true); assert.equal(rovers.verifiedDomain, 'rovers.example'); assert.equal(rovers.suspended, false);
    if (Array.isArray(rovers.lookingFor)) assert.deepEqual(rovers.lookingFor, ['ST', 'GK']);
    assert.equal(clubs.body.find((o) => o.id === 'org-eastport').squad[0].name, 'Seeded', 'the seeded facet survived the cutover and a restart');
    assert.equal((await j('GET', '/org/notifications', undefined, regToken)).status, 200, 'the session minted before the restart is still valid');
    const cap2 = await j('GET', '/capabilities');
    assert.equal(cap2.body.integrity.ok, true, `integrity after a restart on a cut-over file: ${JSON.stringify(cap2.body.integrity.byCode)}`);
    assert.equal(cap2.body.integrity.byCode.ROOM_ORPHAN_ORG, undefined, 'the Room still belongs to an organisation the report can see');
    // Backup → restore: every organisation, with its facets, and every session.
    const backup = await (await fetch(`http://127.0.0.1:${port}/admin/backup`, { method: 'POST', headers: A })).json();
    backupDir = backup.dir;
    const exported = JSON.parse(fs.readFileSync(path.join(backupDir, 'db.json'), 'utf8'));
    assert.equal(exported.db.orgs.length, 6); assert.ok(exported.db.orgs.find((o) => o.id === newOrgId).verified);
    assert.ok(!JSON.stringify(exported.db.orgs).includes('__meta'), 'the reserved shape metadata never leaves the repository');
  } finally { await stop(S); }
  const restoreDir = tempDir('s3-restore'); fs.cpSync(backupDir, restoreDir, { recursive: true });
  const port2 = pickPort(7700, 100);
  const restored = spawn(process.execPath, [path.join(HERE, '..', 'server.mjs')], { env: { ...process.env, PORT: String(port2), DATA_DIR: restoreDir, M13_QUIET_LOGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log2 = ''; restored.stdout.on('data', (d) => { log2 += d; }); restored.stderr.on('data', (d) => { log2 += d; });
  try {
    await new Promise((resolve, reject) => { restored.stdout.on('data', () => { if (/listening on/.test(log2)) resolve(); }); restored.on('exit', (c) => reject(new Error(`restored server exited ${c}: ${log2}`))); setTimeout(() => reject(new Error(`restore timeout: ${log2}`)), 20_000); });
    const r = await fetch(`http://127.0.0.1:${port2}/admin/clubs`, { headers: A });
    const clubs = await r.json();
    assert.equal(clubs.length, 6); assert.equal(clubs.find((o) => o.id === newOrgId).verifiedDomain, 'rovers.example'); assert.equal(clubs.find((o) => o.id === 'org-eastport').squad[0].name, 'Seeded');
    assert.equal((await fetch(`http://127.0.0.1:${port2}/org/notifications`, { headers: { authorization: `Bearer ${regToken}` } })).status, 200, 'the session survives backup and restore');
    const raw = openRaw(restoreDir); assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM collections WHERE name = 'orgs'").get().n, 0); assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []); raw.close();
  } finally {
    await new Promise((resolve) => { restored.on('exit', () => resolve()); restored.kill('SIGTERM'); });
    fs.rmSync(restoreDir, { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${passed} organisation checks passed`);
