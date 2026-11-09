// S9c — a club's setup as typed tables with explicit writes (repositories/clubSetup.mjs, migration 0021): the
// tactical setup (roles, criteria, windows), the squad, the shadow list, looking-for, the federation-route request and
// vacancies. What this suite proves: the migration creates the nine typed tables, empty, and removes the four retired
// facets from orgs.facets_json; the organisation record refuses them (reading, writing, a record carrying one) and
// the typers refuse junk with the field named; a tactical re-save diffs roles by id (a kept role
// keeps its vacancies and shadow entries, a dropped one leaves them with no role); a role of another club is refused;
// the squad and shadow uniqueness rules hold and the two lists are separate; a rolled-back unit leaves nothing; the
// vacancy list pages by cursor; and a fixture written through the repository is typed, refuses missing references,
// uniqueness and junk (nothing written), and reads back what it wrote.
// Temporary databases only; nothing touches DATA_DIR. Run with: npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { readRecords, writeFixture } from './dataLayerFixture.mjs';
import { runDataMigrations } from '../repositories/database.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir } from './coreIdentityTestFixtures.mjs';
import { saveFixture, ORG } from './recruitmentTestFixtures.mjs';
import {
  CLUB_SETUP_MIGRATION as MIGRATION, CLUB_SETUP_TABLES as TABLES, CLUB_SETUP_COLLECTIONS as COLLECTIONS,
  typeTacticalSetup, typeSquadMember, typeShadowPlayer, typeLookingFor, typeFederationCheck, typeVacancy,
} from '../repositories/clubSetup.mjs';

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
const reason = (t) => (t.ok ? '' : t.reason);

// ------------------------------------------------------------- fixtures: the literals the routes write
const OTHER = Object.freeze({ id: 'org-two', name: 'Riverside Juniors', type: 'club', level: 'grassroots', plan: 'Grassroots', country: 'GB' });
/** POST /org/tactical, typed. */
const role = (over = {}) => ({ id: 'role-1', name: 'Pressing 9', positionGroup: 'ATT', description: 'Leads the press', category: 'mens', required: [{ key: 'positionGroup', value: 'ATT' }, { key: 'maxAge', value: 23 }], preferred: [{ key: 'foot', value: 'left' }], ...over });
const setup = (over = {}) => ({ orgId: ORG.id, formation: '4-3-3', planningHorizon: '2 windows', windows: [{ name: 'Summer 2027', opens: '2027-06-01', closes: '2027-08-31' }], roles: [role()], updatedAt: NOW - 5000, updatedBy: 'Maria', ...over });
/** POST /org/squad (manual), the invitation approval, the grassroots signing. */
const squadRow = (over = {}) => ({ id: 'sq-1', orgId: ORG.id, playerId: 'pl-adult', name: 'Adult Signup', position: 'ST', source: 'manual', approvedBy: null, addedAt: NOW - 4000, ...over });
/** POST /org/squad/shadow. */
const shadowRow = (over = {}) => ({ id: 'shd-1', orgId: ORG.id, playerId: 'pl-adult', name: 'Adult Signup', roleId: 'role-1', addedBy: 'Maria', addedAt: NOW - 3000, ...over });
/** POST /org/vacancies. */
const vacancy = (over = {}) => ({ id: 'vac-1', orgId: ORG.id, roleId: 'role-1', roleName: 'Pressing 9', window: null, notes: 'ST leaves', status: 'open', createdBy: 'Maria', createdAt: NOW - 2000, closedAt: null, ...over });
const federation = (over = {}) => ({ orgId: ORG.id, federation: 'Manchester FA', registrationId: 'MFA-1', contactEmail: 'club@example.com', status: 'pending', submittedAt: NOW - 1000, ...over });

function serverOpen(dir) {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const layer = attachDataLayer({ store, nextId, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  return { store, repo: layer.clubSetup, layer, unit: (w) => store.unitOfWork(w), close: () => store.sqlite.close() };
}

// ------------------------------------------------------------- schema
test('[schema] 0021 is registered after 0020 and creates the nine STRICT tables empty (S14g: the organisations have no facets to clean up)', () => {
  const ids = DATA_MIGRATIONS.map((m) => m.id);
  assert.equal(ids.indexOf(MIGRATION), ids.indexOf('0020_scouting_assessments') + 1);
  for (const n of COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is table-backed`);
  const s = new DatabaseSync(':memory:'); s.exec('PRAGMA foreign_keys = ON;');
  runDataMigrations(s, DATA_MIGRATIONS, { now: NOW, log: () => {} });
  assert.ok(!s.prepare('PRAGMA table_info(orgs)').all().some((c) => c.name === 'facets_json'), 'the organisations have no facet column');
  for (const t of TABLES) {
    assert.match(s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql, /STRICT\s*$/, `${t} is STRICT`);
    assert.equal(s.prepare(`SELECT count(*) AS n FROM ${t}`).get().n, 0);
    const tc = s.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    for (const c of ['extra_json', 'absent_keys_json', 'offtype_json', 'value_json']) assert.ok(!tc.includes(c), `${t}: no ${c}`);
    assert.ok(!s.prepare(`PRAGMA foreign_key_list(${t})`).all().some((f) => f.table === 'players'), `${t}: no player key (tolerant)`);
  }
  s.close();
});

// ------------------------------------------------------------- typing
test('[typing] junk is refused with the field named: criteria, roles, windows, squad rows, looking-for, federation, vacancies', () => {
  assert.ok(typeTacticalSetup(setup()).ok);
  const bad = (over, re) => assert.match(reason(typeTacticalSetup(setup(over))), re);
  bad({ roles: [role({ positionGroup: 'STRIKER' })] }, /roles\[0\]\.positionGroup/);
  bad({ roles: [role({ category: 'veterans' })] }, /roles\[0\]\.category/);
  bad({ roles: [role({ required: [{ key: 'height', value: 180 }] })] }, /required\[0\]\.key/);
  bad({ roles: [role({ preferred: [{ key: 'foot', value: 'L' }] })] }, /preferred\[0\]\.value/);
  bad({ roles: [role({ required: [{ key: 'maxAge', value: '23' }] })] }, /required\[0\]\.value/);
  bad({ roles: [role({ required: [{ key: 'maxAge', value: 23 }, { key: 'maxAge', value: 25 }] })] }, /repeats maxAge/);
  bad({ roles: [role(), role()] }, /repeats role-1/);
  bad({ roles: Array.from({ length: 16 }, (_, i) => role({ id: `role-${i}` })) }, /more than 15 roles/);
  bad({ windows: [{ name: 'Summer', opens: 'next June' }] }, /windows\[0\]\.opens/);
  bad({ windows: [{ name: 'Summer', opens: '2027-09-01', closes: '2027-06-01' }] }, /closes is before opens/);
  bad({ formation: '' }, /formation/);
  bad({ windows: [{ name: 'Feb', opens: '2027-02-30' }] }, /windows\[0\]\.opens/);
  bad({ roles: [role({ required: [{ key: 'minAge', value: 16 }, { key: 'maxAge', value: 15 }] })] }, /maxAge is below minAge/);
  bad({ roles: [role({ required: 'ATT' })] }, /roles\[0\]\.required must be an array/);
  bad({ roles: [role({ extra: 1 })] }, /does not store: extra/);
  assert.match(reason(typeSquadMember(squadRow({ source: 'invite_approved' }))), /approvedBy is required/);
  assert.match(reason(typeSquadMember(squadRow({ source: 'signing', playerId: null }))), /playerId is required/);
  assert.match(reason(typeSquadMember(squadRow({ source: 'shadow' }))), /source must be one of manual\|invite_approved\|signing/);
  assert.ok(typeSquadMember(squadRow({ playerId: null })).ok, 'a manual row may name an off-platform person');
  assert.match(reason(typeShadowPlayer(shadowRow({ playerId: null }))), /playerId/);
  assert.match(reason(typeLookingFor({ orgId: ORG.id, positions: ['striker'] })), /positions\[0\]/);
  assert.match(reason(typeLookingFor({ orgId: ORG.id, positions: ['ST', 'ST'] })), /twice/);
  assert.match(reason(typeLookingFor({ orgId: ORG.id, positions: ['GK', 'CB', 'LB', 'RB', 'CM', 'ST'] })), /at most 5/);
  assert.match(reason(typeFederationCheck(federation({ contactEmail: 'nope' }))), /contactEmail/);
  assert.match(reason(typeFederationCheck(federation({ status: 'verified' }))), /status/);
  assert.match(reason(typeVacancy(vacancy({ status: 'closed' }))), /closedAt is required/);
  assert.match(reason(typeVacancy(vacancy({ closedAt: NOW }))), /closedAt must be null/);
});

// ------------------------------------------------------------- the organisation record
test('[orgs] an organisation carries no retired facet, a record carrying one is refused naming its repository', () => {
  const dir = saveFixture(tempDir('s9c-orgs'));
  const o = serverOpen(dir);
  try {
    const org = o.layer.orgs.byId(ORG.id);
    for (const k of ['squad', 'tactical', 'lookingFor', 'federationCheck']) {
      assert.ok(!(k in org), `an organisation has no ${k}`);
      refused(() => o.layer.orgs.update(ORG.id, (d) => { d[k] = []; }), /no longer an organisation field: write it through the clubSetup repository/, `writing org.${k}`);
    }
    refused(() => o.layer.orgs.create({ ...OTHER, squad: [] }), /squad is no longer an organisation field/);
    refused(() => o.layer.orgs.create({ ...OTHER, lookingFor: ['ST'] }), /lookingFor is no longer an organisation field/);
  } finally { o.close(); rm(dir); }
});

// ------------------------------------------------------------- writes
test('[tactical] a re-save diffs roles by id: a kept role keeps its vacancy, a dropped one leaves its vacancy and shadow entry with no role; a role of another club is refused', () => {
  const dir = saveFixture(tempDir('s9c-tac'));
  const o = serverOpen(dir); const { repo } = o;
  try {
    o.layer.orgs.create(OTHER);
    const first = repo.tactical.save(setup({ roles: [role(), role({ id: 'role-2', name: 'Ball-winning 6', positionGroup: 'MID', category: 'mixed', required: [], preferred: [] })] }));
    assert.deepEqual(first.roles.map((r) => r.id), ['role-1', 'role-2']);
    assert.deepEqual(first.roles[0].required, [{ key: 'positionGroup', value: 'ATT' }, { key: 'maxAge', value: 23 }], 'criteria read back typed, in order');
    assert.ok(Object.isFrozen(first.roles[0]), 'records are deep-frozen');
    repo.vacancies.create(vacancy({ id: 'vac-1', roleId: 'role-1' }));
    repo.vacancies.create(vacancy({ id: 'vac-2', roleId: 'role-2', roleName: 'Ball-winning 6' }));
    repo.shadow.create(shadowRow({ roleId: 'role-2' }));
    const second = repo.tactical.save(setup({ formation: '4-4-2', roles: [role({ name: 'Pressing 9 (renamed)' }), role({ id: 'role-3', name: 'Wide 7', positionGroup: 'ATT' })] }));
    assert.deepEqual(second.roles.map((r) => [r.id, r.name]), [['role-1', 'Pressing 9 (renamed)'], ['role-3', 'Wide 7']]);
    assert.equal(repo.vacancies.byId('vac-1').roleId, 'role-1', 'the kept role keeps its vacancy');
    assert.equal(repo.vacancies.byId('vac-2').roleId, null, "the dropped role's vacancy has no role (ROLE_DELETED)");
    assert.equal(repo.vacancies.byId('vac-2').roleName, 'Ball-winning 6', 'the vacancy keeps the role name');
    assert.equal(repo.shadow.forOrg(ORG.id)[0].roleId, null, "the dropped role's shadow entry has no role");
    refused(() => repo.tactical.save(setup({ orgId: OTHER.id, roles: [role({ id: 'role-1' })] })), /role-1 belongs to another organisation/);
    refused(() => repo.vacancies.create(vacancy({ id: 'vac-9', orgId: OTHER.id, roleId: 'role-1' })), /not a role of organisation org-two/);
    refused(() => repo.vacancies.update('vac-1', (d) => { d.roleId = 'role-3'; }), /roleId cannot change/);
    refused(() => repo.vacancies.update('vac-1', (d) => { repo.vacancies.update('vac-1', () => {}); d.notes = 'x'; }), /already being updated/);
    const closed = repo.vacancies.update('vac-1', (d) => { d.status = 'closed'; d.closedAt = NOW; });
    assert.equal(closed.status, 'closed');
    assert.deepEqual(repo.vacancies.openForOrg(ORG.id).map((v) => v.id), ['vac-2']);
  } finally { o.close(); rm(dir); }
});

test('[squad] one squad row and one shadow entry per club and player; the two lists are separate; a rolled-back unit leaves nothing; looking-for and federation replace whole', () => {
  const dir = saveFixture(tempDir('s9c-squad'));
  const o = serverOpen(dir); const { repo } = o;
  try {
    repo.shadow.create(shadowRow({ roleId: null }));
    assert.equal(repo.squad.has(ORG.id, 'pl-adult'), false, 'a shadow entry is not a squad row');
    assert.deepEqual(repo.squad.forPlayer('pl-adult'), [], 'nor a club relationship');
    repo.squad.create(squadRow({ source: 'invite_approved', approvedBy: 'the player', position: null }));
    assert.equal(repo.squad.has(ORG.id, 'pl-adult'), true, 'a shadowed player can join the squad');
    assert.equal(repo.shadow.has(ORG.id, 'pl-adult'), true);
    refused(() => repo.squad.create(squadRow({ id: 'sq-2' })), /already has player pl-adult on its squad/);
    refused(() => repo.shadow.create(shadowRow({ id: 'shd-2', roleId: null })), /already shadows player pl-adult/);
    repo.squad.create(squadRow({ id: 'sq-off', playerId: null, name: 'Big Trev' }));
    repo.squad.create(squadRow({ id: 'sq-off2', playerId: null, name: 'Little Trev' }));
    assert.deepEqual(repo.squad.playerIds(ORG.id), ['pl-adult'], 'off-platform rows have no player id and repeat freely');
    refused(() => o.unit(() => { repo.squad.create(squadRow({ id: 'sq-rb', playerId: 'pl-child1', name: 'Child' })); throw new Error('later step failed'); }), /later step failed/);
    assert.equal(repo.squad.byId('sq-rb'), null, 'the rolled-back unit left no row');
    assert.equal(repo.squad.remove('sq-off'), true); assert.equal(repo.squad.byId('sq-off'), null);
    assert.deepEqual([...repo.lookingFor.set(ORG.id, ['ST', 'CDM'])], ['ST', 'CDM']);
    assert.deepEqual([...repo.lookingFor.set(ORG.id, ['GK'])], ['GK'], 'the list is replaced whole');
    refused(() => repo.lookingFor.set(ORG.id, ['striker']), /positions\[0\]/);
    repo.federation.submit(federation()); repo.federation.submit(federation({ registrationId: 'MFA-2' }));
    assert.equal(repo.federation.forOrg(ORG.id).registrationId, 'MFA-2', 'one request per club, replaced on resubmission');
  } finally { o.close(); rm(dir); }
});

test('[reads] the vacancy list pages newest first by cursor', () => {
  const dir = saveFixture(tempDir('s9c-page'));
  const o = serverOpen(dir); const { repo } = o;
  try {
    repo.tactical.save(setup());
    for (const n of [1, 2, 3]) repo.vacancies.create(vacancy({ id: `vac-${n}`, createdAt: NOW + n }));
    const p1 = repo.vacancies.page(ORG.id, { limit: 2 }).rows;
    assert.deepEqual(p1.map((r) => r.vacancy.id), ['vac-3', 'vac-2', 'vac-1'], 'one row more than the page, newest first');
    const p2 = repo.vacancies.page(ORG.id, { limit: 2, after: p1[1].key }).rows;
    assert.deepEqual(p2.map((r) => r.vacancy.id), ['vac-1']);
  } finally { o.close(); rm(dir); }
});

// ------------------------------------------------------------- fixtures
const write = (dir, collections) => writeFixture(dir, collections, { now: NOW });

test('[fixtures] a fixture written through the repository is typed and reads back; missing references, uniqueness and junk are refused with ids, nothing written', () => {
  const dir = saveFixture(tempDir('s9c-fix'), { squadMembers: [squadRow(), squadRow({ id: 'sq-off', playerId: null, name: 'Big Trev' })] });
  // The shadow entry and the vacancy name a role, so they are written after the setup that holds it.
  write(dir, { tacticalSetups: [setup()], lookingFor: [{ orgId: ORG.id, positions: ['ST'] }], federationChecks: [federation()] });
  write(dir, { shadowPlayers: [shadowRow({ playerId: 'pl-child1', name: 'Child' })], vacancies: [vacancy()] });
  try {
    const back = readRecords(dir);
    assert.deepEqual(back.tacticalSetups, [setup()]);
    assert.deepEqual(back.squadMembers.map((m) => m.id), ['sq-1', 'sq-off']);
    assert.deepEqual(back.shadowPlayers, [shadowRow({ playerId: 'pl-child1', name: 'Child' })]);
    assert.deepEqual(back.lookingFor, [{ orgId: ORG.id, positions: ['ST'] }]);
    assert.deepEqual(back.federationChecks, [federation()]);
    assert.deepEqual(back.vacancies, [vacancy()]);
  } finally { rm(dir); }
  const refusedFixture = (label, db, re) => {
    const d = tempDir(`s9c-fix-${label}`);
    try {
      refused(() => saveFixture(d, db), re, label);
      const back = readRecords(d);
      assert.equal(back.squadMembers.length + back.vacancies.length, 0, `${label}: a refused fixture wrote nothing`);
    } finally { rm(d); }
  };
  refusedFixture('org', { squadMembers: [squadRow({ orgId: 'org-ghost' })] }, /FOREIGN KEY constraint failed/);
  refusedFixture('unique', { squadMembers: [squadRow(), squadRow({ id: 'sq-2' })] }, /already has player pl-adult on its squad/);
  refusedFixture('junk', { squadMembers: [squadRow({ source: 'shadow' })] }, /CLUB_SETUP_INPUT_INVALID.*source/);
  refusedFixture('role', { squadMembers: [squadRow()], vacancies: [vacancy({ roleId: 'role-ghost' })] }, /role-ghost|FOREIGN KEY/);
});

console.log(`\n${passed} club setup checks passed`);
