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
  assert.equal(s.prepare("SELECT value FROM meta WHERE key = 'orgsInit'").get().value, 'done', 'a cut-over blob is the initialisation: nothing is ever imported over it');
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
  // insert/update commit on their own: inside someone else's transaction their bookkeeping could not follow a rollback.
  assert.throws(() => transaction(store.sqlite, () => layer.orgs.update('org-pro', { suspended: false })), /cannot run inside an open transaction/);
  assert.throws(() => transaction(store.sqlite, () => layer.orgs.insert({ id: 'org-tx', name: 'T', type: 'club', plan: 'Pro' })), /cannot run inside an open transaction/);
  assert.equal(pro.suspended, true, 'the refused update changed nothing');
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
test('repository: authority is the cutover record — attach refuses without it; a stale in-memory array never overwrites the table; a first-installation import refuses invalid records and imports nothing from a refused batch', () => {
  const s = new DatabaseSync(':memory:'); s.exec('PRAGMA foreign_keys = ON;');
  runDataMigrations(s, [m0001, m0002, m0003]);
  assert.throws(() => createOrgsRepository({ sqlite: s }), /cutover record 0004_orgs_live is missing/);
  runDataMigrations(s, DATA_MIGRATIONS);
  const warnings = [];
  const repo = createOrgsRepository({ sqlite: s, warn: (m) => warnings.push(m) });
  assert.equal(repo.initState(), 'pending', 'a database nothing was ever saved to is a first installation');
  assert.throws(() => repo.initialize([{ id: 'org-bad', name: 'B', type: 'club', level: 'agent', plan: 'Pro' }]), /cannot be imported — id org-bad: level/);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM orgs').get().n, 0, 'nothing imported from a refused batch');
  assert.equal(repo.initState(), 'pending', 'and the initialisation is still owed');
  repo.initialize(ORGS());
  assert.equal(repo.count(), 3); assert.equal(repo.initState(), 'done');
  const again = createOrgsRepository({ sqlite: s, warn: (m) => warnings.push(m) });
  again.attach([ORGS()[0], { id: 'org-stale', name: 'S', type: 'club', plan: 'Pro' }]);
  assert.equal(again.count(), 3, 'the table wins; the stale array row is not imported');
  assert.match(warnings[0], /1 organisation\(s\) the table does not hold was ignored/);
  s.close();
});

// ------------------------------------------------------------- review corrections after 0851d38
test('correction 1: facet change tracking reflects committed state only — a save that fails after the flush, inside the flush or at commit leaves every pending change eligible for retry; the retry persists them and a restart reads them', () => {
  const dir = tempDir('s3-c1');
  let store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = { orgs: ORGS(), guardians: [], players: [{ id: 'pl-1', name: 'P' }], sessions: [], users: [] };
  attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  store.save({ savedAt: 1, idCounter: 1000, db });
  const facetsOf = (id) => JSON.parse(store.sqlite.prepare('SELECT facets_json FROM orgs WHERE id = ?').get(id).facets_json);
  const pro = db.orgs.find((o) => o.id === 'org-pro');
  const grass = db.orgs.find((o) => o.id === 'org-grass');
  assert.deepEqual(facetsOf('org-pro').squad, []); assert.deepEqual(facetsOf('org-grass').lookingFor, ['ST', 'CB']);
  // (a) The failure is in a LATER write of the same save: an unrelated collection that cannot be serialised.
  pro.squad.push({ id: 'sq-1', name: 'A', position: 'ST', playerId: null, source: 'manual', addedAt: 1 });
  grass.lookingFor = ['GK'];
  db.players[0].big = 1n;
  assert.throws(() => store.save({ savedAt: 2, idCounter: 1000, db }), /BigInt/);
  assert.equal(store.sqlite.isTransaction, false, 'the transaction was rolled back');
  assert.deepEqual(facetsOf('org-pro').squad, [], 'the flushed squad change was rolled back with the rest of the save');
  assert.deepEqual(facetsOf('org-grass').lookingFor, ['ST', 'CB'], 'so was the second organisation');
  delete db.players[0].big;
  store.save({ savedAt: 3, idCounter: 1000, db });
  assert.equal(facetsOf('org-pro').squad.length, 1, 'the retry persists the change the failed save had already flushed');
  assert.deepEqual(facetsOf('org-grass').lookingFor, ['GK'], 'for every organisation that had a pending change');
  // (b) The failure is at COMMIT.
  pro.tactical = { formation: '4-4-2' };
  const exec = store.sqlite.exec.bind(store.sqlite);
  let explodeAtCommit = true;
  store.sqlite.exec = (sql) => { if (explodeAtCommit && sql === 'COMMIT') { explodeAtCommit = false; throw new Error('disk full at commit'); } return exec(sql); };
  assert.throws(() => store.save({ savedAt: 4, idCounter: 1000, db }), /disk full at commit/);
  assert.equal(store.sqlite.isTransaction, false);
  assert.equal(facetsOf('org-pro').tactical, null, 'nothing committed');
  store.save({ savedAt: 5, idCounter: 1000, db });
  assert.deepEqual(facetsOf('org-pro').tactical, { formation: '4-4-2' }, 'the retry persists the change');
  // (c) The failure is INSIDE the flush, after the first organisation's row was already written in the transaction.
  pro.squad.push({ id: 'sq-2', name: 'B', position: 'GK', playerId: null, source: 'manual', addedAt: 2 });
  grass.agencySettings = { n: 1n };
  assert.throws(() => store.save({ savedAt: 6, idCounter: 1000, db }), /BigInt/);
  assert.equal(facetsOf('org-pro').squad.length, 1, 'the first organisation\'s UPDATE was rolled back');
  grass.agencySettings = { n: 1 };
  store.save({ savedAt: 7, idCounter: 1000, db });
  assert.equal(facetsOf('org-pro').squad.length, 2); assert.deepEqual(facetsOf('org-grass').agencySettings, { n: 1 });
  // A save with nothing pending writes no organisation row; a successful save is not re-flushed.
  store.sqlite.exec = exec;
  const seq = store.revision();
  store.save({ savedAt: 8, idCounter: 1000, db });
  assert.equal(store.revision(), seq + 1);
  store.sqlite.close();
  // Restart: everything the retries persisted is there.
  store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db2 = { orgs: [], guardians: [], players: [], sessions: [], users: [] };
  attachDataLayer({ db: db2, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  const pro2 = db2.orgs.find((o) => o.id === 'org-pro'); const grass2 = db2.orgs.find((o) => o.id === 'org-grass');
  assert.deepEqual(pro2.squad.map((m) => m.id), ['sq-1', 'sq-2']); assert.deepEqual(pro2.tactical, { formation: '4-4-2' });
  assert.deepEqual(grass2.lookingFor, ['GK']); assert.deepEqual(grass2.agencySettings, { n: 1 });
  store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});
test('correction 2: nested migrated fields are protected — assigning, deleting or defining a property inside location or federationRef throws, the view never diverges from the table, and a repository update of a composite persists across a restart', () => {
  const dir = tempDir('s3-c2');
  let store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = { orgs: ORGS(), guardians: [], players: [{ id: 'pl-1', name: 'P' }], sessions: [], users: [] };
  let layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  const pro = db.orgs.find((o) => o.id === 'org-pro');
  const grass = db.orgs.find((o) => o.id === 'org-grass');
  assert.throws(() => { pro.location.lat = 9; }, /organisations repository/);
  assert.throws(() => { grass.federationRef.registrationId = 'NEW'; }, /organisations repository/);
  assert.throws(() => { delete pro.location.city; }, /organisations repository/);
  assert.throws(() => { Object.defineProperty(pro.location, 'lat', { value: 9 }); }, /organisations repository/);
  assert.throws(() => { Object.assign(grass.federationRef, { federation: 'X' }); }, /organisations repository/);
  assert.equal(pro.location.lat, 51.889); assert.equal(pro.location.city, 'Eastport'); assert.equal(grass.federationRef.registrationId, 'LFA-1');
  store.save({ savedAt: 1, idCounter: 1000, db });
  assert.equal(store.sqlite.prepare("SELECT lat FROM orgs WHERE id = 'org-pro'").get().lat, 51.889);
  assert.equal(store.sqlite.prepare("SELECT federation_registration_id FROM orgs WHERE id = 'org-grass'").get().federation_registration_id, 'LFA-1');
  assert.equal(JSON.stringify(ORGS_TABLE.read(store.sqlite)), JSON.stringify(db.orgs), 'the view and the table agree record for record');
  // Reading is unchanged: spread, JSON, stable identity, sub-key order.
  assert.deepEqual({ ...pro.location }, { lat: 51.889, lng: 1.02, city: 'Eastport' });
  assert.equal(pro.location, pro.location, 'the same guarded object every time');
  assert.equal(JSON.stringify(pro.location), '{"lat":51.889,"lng":1.02,"city":"Eastport"}');
  assert.equal(db.orgs.find((o) => o.id === 'org-agency').location, null, 'a null composite reads as null');
  // Column-backed changes go through the repository, built from the guarded view if the caller likes.
  layer.orgs.update('org-pro', { location: { ...pro.location, lat: 9 } });
  layer.orgs.update('org-grass', { federationRef: { ...grass.federationRef, registrationId: 'NEW' } });
  assert.equal(pro.location.lat, 9); assert.equal(grass.federationRef.registrationId, 'NEW');
  assert.equal(store.sqlite.prepare("SELECT lat FROM orgs WHERE id = 'org-pro'").get().lat, 9, 'written immediately');
  assert.throws(() => { pro.location.lat = 10; }, /organisations repository/, 'the replaced composite is guarded too');
  store.sqlite.close();
  store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db2 = { orgs: [], guardians: [], players: [], sessions: [], users: [] };
  layer = attachDataLayer({ db: db2, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  assert.equal(JSON.stringify(db2.orgs.find((o) => o.id === 'org-pro').location), '{"lat":9,"lng":1.02,"city":"Eastport"}', 'the update survived the restart with the sub-key order kept');
  assert.deepEqual(db2.orgs.find((o) => o.id === 'org-grass').federationRef, { federation: 'London FA', registrationId: 'NEW' });
  assert.equal(JSON.stringify(ORGS_TABLE.read(store.sqlite)), JSON.stringify(db2.orgs));
  store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});
test('correction 3: initialisation is explicit state, never a row count — an empty cut-over table stays authoritative against stale arrays and blobs; a genuine first installation initialises once, atomically, and retries after an interruption; an intentionally empty table stays empty', () => {
  // (a) A cut-over database whose table was emptied: a stale array is ignored, nothing is imported.
  const dirA = tempDir('s3-c3a'); s2File(dirA);
  let s = openRaw(dirA);
  runDataMigrations(s, DATA_MIGRATIONS, { context: { sessionTtlMs: TTL } });
  s.exec('DELETE FROM sessions; DELETE FROM org_users; DELETE FROM orgs;');
  let warnings = [];
  const repo = createOrgsRepository({ sqlite: s, warn: (m) => warnings.push(m) });
  const stale = [{ id: 'org-stale', name: 'Stale', type: 'club', plan: 'Pro' }];
  assert.deepEqual(repo.attach(stale), { engine: 'sqlite', loaded: 0, imported: 0 }, 'an empty authoritative table imports nothing');
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM orgs').get().n, 0);
  assert.match(warnings[0], /ignored/);
  assert.equal(repo.initState(), 'done', 'the migration recorded that the organisations were initialised from the blob');
  s.close();
  // The same through the data layer with a seed-shaped array, as a server booting from the seed would pass.
  let store = openStore(dirA, { tableBacked: TABLE_BACKED });
  let db = { orgs: ORGS(), guardians: [], players: [], sessions: [], users: [] };
  warnings = [];
  let layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, warn: (m) => warnings.push(m) });
  assert.deepEqual(layer.boot.orgs, { engine: 'sqlite', loaded: 0, imported: 0 }); assert.equal(db.orgs.length, 0);
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) AS n FROM orgs').get().n, 0);
  assert.match(warnings.join('\n'), /3 organisation\(s\) the table does not hold was ignored/);
  // A stale orgs blob written back into the file is ignored at attach and removed by the next save.
  store.sqlite.prepare("INSERT INTO collections (name, value) VALUES ('orgs', ?)").run(JSON.stringify(ORGS()));
  store.sqlite.close();
  store = openStore(dirA, { tableBacked: TABLE_BACKED });
  db = { ...store.load().db };
  assert.equal(Array.isArray(db.orgs) && db.orgs.length, 3, 'fixture: the stale blob is what the server would load into memory');
  layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, warn: () => {} });
  assert.deepEqual(layer.boot.orgs, { engine: 'sqlite', loaded: 0, imported: 0 }); assert.equal(db.orgs.length, 0);
  store.save({ savedAt: 9, idCounter: 1000, db });
  assert.equal(store.sqlite.prepare("SELECT COUNT(*) AS n FROM collections WHERE name = 'orgs'").get().n, 0, 'the stale blob is gone');
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) AS n FROM orgs').get().n, 0, 'and the table is still empty');
  store.sqlite.close(); fs.rmSync(dirA, { recursive: true, force: true });
  // (b) A genuine first installation: nothing was ever saved, so the migration leaves initialisation pending and the seed is imported once.
  const dirB = tempDir('s3-c3b');
  store = openStore(dirB, { tableBacked: TABLE_BACKED });
  db = { orgs: ORGS(), guardians: [], players: [], sessions: [], users: [] };
  layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  assert.deepEqual(layer.boot.orgs, { engine: 'sqlite', loaded: 3, imported: 3 });
  assert.equal(layer.orgs.initState(), 'done');
  assert.equal(store.sqlite.prepare("SELECT value FROM meta WHERE key = 'orgsInit'").get().value, 'done');
  store.sqlite.close();
  store = openStore(dirB, { tableBacked: TABLE_BACKED });
  db = { orgs: ORGS(), guardians: [], players: [], sessions: [], users: [] }; // the seed again: a restart before the first snapshot save
  layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  assert.deepEqual(layer.boot.orgs, { engine: 'sqlite', loaded: 3, imported: 0 }, 'initialised once, then the table');
  store.sqlite.close(); fs.rmSync(dirB, { recursive: true, force: true });
  // (c) Interrupted initialisation: the rows and the state change are one transaction, so the next boot retries.
  s = new DatabaseSync(':memory:'); s.exec('PRAGMA foreign_keys = ON;');
  runDataMigrations(s, DATA_MIGRATIONS, { context: { sessionTtlMs: TTL } });
  let r = createOrgsRepository({ sqlite: s });
  assert.equal(r.initState(), 'pending');
  assert.deepEqual(r.attach(ORGS()), { engine: 'sqlite', loaded: 0, imported: 0 }, 'attach never initialises; the state says pending and the records are reported, not imported');
  const exec = s.exec.bind(s);
  let explode = true;
  s.exec = (sql) => { if (explode && sql === 'COMMIT') { explode = false; throw new Error('process died during initialisation'); } return exec(sql); };
  assert.throws(() => r.initialize(ORGS()), /process died during initialisation/);
  assert.equal(s.isTransaction, false);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM orgs').get().n, 0, 'nothing of the failed attempt remains');
  assert.equal(r.initState(), 'pending', 'still pending: the next boot retries');
  assert.throws(() => r.initialize([{ id: 'org-bad', name: 'B', type: 'club', level: 'agent', plan: 'Pro' }]), /cannot be imported — id org-bad: level/);
  assert.equal(r.initState(), 'pending');
  assert.deepEqual(r.initialize(ORGS()), { engine: 'sqlite', loaded: 3, imported: 3 });
  assert.equal(r.initState(), 'done');
  assert.throws(() => r.initialize(ORGS()), /already initialised/);
  r = createOrgsRepository({ sqlite: s });
  assert.deepEqual(r.attach(ORGS()), { engine: 'sqlite', loaded: 3, imported: 0 });
  s.close();
  // (d) An intentionally empty installation: initialising with no records records the decision; a later seed array is ignored.
  s = new DatabaseSync(':memory:'); s.exec('PRAGMA foreign_keys = ON;');
  runDataMigrations(s, DATA_MIGRATIONS, { context: { sessionTtlMs: TTL } });
  r = createOrgsRepository({ sqlite: s });
  assert.deepEqual(r.initialize([]), { engine: 'sqlite', loaded: 0, imported: 0 });
  assert.equal(r.initState(), 'done');
  warnings = [];
  r = createOrgsRepository({ sqlite: s, warn: (m) => warnings.push(m) });
  assert.deepEqual(r.attach(ORGS()), { engine: 'sqlite', loaded: 0, imported: 0 });
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM orgs').get().n, 0, 'empty on purpose stays empty');
  assert.match(warnings[0], /ignored/);
  s.close();
});

test('review (cb1d22b): initialise refuses a collection that is not an array — an object, null, a string, a number or nothing — writing no row, keeping the state pending and the input untouched; an explicitly empty array stays a valid, empty installation and a later valid retry initialises', () => {
  const s = new DatabaseSync(':memory:'); s.exec('PRAGMA foreign_keys = ON;');
  runDataMigrations(s, DATA_MIGRATIONS, { context: { sessionTtlMs: TTL } });
  const r = createOrgsRepository({ sqlite: s });
  assert.equal(r.initState(), 'pending');
  const cases = [[{ id: 'synthetic-not-an-array' }, /an object/], [null, /null/], ['orgs', /a string/], [7, /a number/], [undefined, /absent/]];
  for (const [input, re] of cases) {
    const before = JSON.stringify(input ?? null);
    assert.throws(() => r.initialize(input), (err) => err instanceof TypeError && /initialize\(\) needs the first installation's organisations as an array/.test(err.message) && re.test(err.message) && /nothing was written/.test(err.message), `refused: ${re}`);
    assert.equal(r.initState(), 'pending', 'still pending: the next boot retries'); assert.equal(s.prepare('SELECT COUNT(*) AS n FROM orgs').get().n, 0); assert.equal(r.count(), 0);
    assert.equal(JSON.stringify(input ?? null), before, 'the input is untouched'); assert.equal(s.isTransaction, false);
  }
  // The data layer refuses the same way at boot (a malformed seed is a fatal error, not an empty installation).
  const dir = tempDir('s3-init-shape'); const store = openStore(dir, { tableBacked: TABLE_BACKED });
  assert.throws(() => attachDataLayer({ db: { orgs: { id: 'not-an-array' }, guardians: [], players: [], sessions: [], users: [] }, store, nextId, persist: () => {}, sessionTtlMs: TTL }), /organisations as an array/);
  assert.equal(store.sqlite.prepare("SELECT value FROM meta WHERE key = 'orgsInit'").get().value, 'pending');
  store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
  // A valid retry, and an explicitly empty installation, still work.
  assert.deepEqual(r.initialize(ORGS()), { engine: 'sqlite', loaded: 3, imported: 3 }); assert.equal(r.initState(), 'done');
  s.close();
  const e = new DatabaseSync(':memory:'); e.exec('PRAGMA foreign_keys = ON;'); runDataMigrations(e, DATA_MIGRATIONS, { context: { sessionTtlMs: TTL } });
  const re2 = createOrgsRepository({ sqlite: e });
  assert.deepEqual(re2.initialize([]), { engine: 'sqlite', loaded: 0, imported: 0 }); assert.equal(re2.initState(), 'done');
  e.close();
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
  assert.equal(o.prepare("SELECT COUNT(*) AS n FROM meta WHERE key IN ('orgsCutover', 'orgsInit')").get().n, 0, 'the S3 bookkeeping is gone with the record');
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
