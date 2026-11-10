// Group workspaces and group grants (repositories/groups.mjs, migration 0036): the STRICT tables, the typers'
// refusals, membership (two organisations share a group exactly while both are members), grants only between members,
// and a departure ending a grant only when its owner shares no group with any recipient. Also paging, units of work
// and fixtures. Temporary databases only; nothing touches DATA_DIR. Run with: npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openLayer, readRecords, writeFixture } from './dataLayerFixture.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir, USERS, ORGS } from './coreIdentityTestFixtures.mjs';
import { saveFixture, fixtureDb } from './recruitmentTestFixtures.mjs';
import {
  GROUPS_MIGRATION as MIGRATION,
  GROUPS_TABLES as TABLES,
  GROUPS_COLLECTIONS as COLLECTIONS,
  typeGroup,
  typeGrant,
  typeExpiresDays,
  grantExpiry,
} from '../repositories/groups.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) {
  if (only && !name.includes(only)) return;
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
const rm = (...dirs) => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
};
let counter = 9000;
const nextId = (p) => `${p}-${++counter}`;
const refused = (fn, pattern, label = '') => {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, `${label}: expected a refusal`);
  assert.match(String(err.message), pattern, `${label}: ${err.message}`);
  return err;
};
const plain = (v) => JSON.parse(JSON.stringify(v));

// ------------------------------------------------------------- fixtures: the literals the routes write
const A = 'org-pro';
const B = 'org-b';
const C = 'org-c';
const club = (id, name) => ({ ...ORGS()[0], id, name });
const group = (over = {}) => ({
  id: 'grp-1',
  name: 'North West Group',
  adminOrgIds: [A],
  memberOrgIds: [A],
  pendingInvites: [],
  sharedTemplateIds: [],
  programmes: [],
  createdAt: NOW,
  ...over,
});
const grant = (over = {}) => ({
  id: 'gnt-1',
  groupId: 'grp-1',
  fromOrgId: A,
  fromOrgName: 'Eastport FC',
  toOrgIds: [B],
  resourceKind: 'shortlist',
  resourceId: '*',
  expiresAt: grantExpiry(NOW, 30),
  revokedAt: null,
  revokeReason: null,
  createdBy: 'Maria',
  createdAt: NOW,
  ...over,
});

const FIX = () => ({
  users: [...USERS()],
  orgs: [...ORGS(), club(B, 'Hackney Marsh'), club(C, 'Northside')],
  notifications: [],
  dispatches: [],
});
function serverOpen(dir) {
  const store = openStore(dir);
  const layer = attachDataLayer({ store, nextId, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  return { store, repo: layer.groups, unit: (w) => store.unitOfWork(w), close: () => store.sqlite.close() };
}
const seeded = (label) => {
  const dir = tempDir(label);
  saveFixture(dir, FIX());
  return { dir, s: serverOpen(dir) };
};
/** A group with A (admin), B and C as members. */
function threeMembers(s) {
  s.repo.groups.create(group());
  for (const o of [B, C]) {
    s.repo.groups.invite('grp-1', { orgId: o, invitedBy: A, at: NOW });
    s.repo.groups.accept('grp-1', o);
  }
}

// ------------------------------------------------------------- schema
test('[schema] 0036 is registered after 0035 and creates the STRICT tables (no JSON column), empty', () => {
  const ids = DATA_MIGRATIONS.map((m) => m.id);
  assert.equal(ids.indexOf(MIGRATION), ids.indexOf('0035_enterprise') + 1);
  for (const n of COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is table-backed`);
  const dir = tempDir('s13c-empty');
  const s = openLayer(dir).sqlite;
  for (const t of TABLES) {
    const sql = s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql;
    assert.match(sql, /STRICT\s*$/, `${t} is STRICT`);
    assert.doesNotMatch(sql, /json_valid|_json\s/i, `${t} has no JSON column`);
    assert.equal(s.prepare(`SELECT count(*) AS n FROM ${t}`).get().n, 0, `${t} starts empty`);
  }
  assert.equal(
    s.prepare("SELECT 1 FROM sqlite_master WHERE name = 'group_admins'").get(),
    undefined,
    'an admin is a flagged member row',
  );
  s.close();
  rm(dir);
});

// ------------------------------------------------------------- typing
test('[typing] junk is refused naming the record and field', () => {
  assert.ok(typeGroup(group()).ok);
  assert.ok(typeGrant(grant()).ok);
  assert.match(
    typeGroup(group({ adminOrgIds: [B] })).reason,
    /groups grp-1\.adminOrgIds names an organisation that is not a member \(org-b\)/,
  );
  assert.match(
    typeGroup(group({ pendingInvites: [{ orgId: A, invitedBy: A, at: NOW }] })).reason,
    /pendingInvites\[0\]\.orgId is already a member/,
  );
  assert.match(typeGroup(group({ memberOrgIds: [A, A] })).reason, /memberOrgIds names an organisation or record twice/);
  assert.match(typeGroup(group({ name: 'x'.repeat(101) })).reason, /name exceeds 100 characters/);
  assert.match(
    typeGroup(group({ programmes: [{ id: 'pgm-1', name: '', region: null, createdAt: NOW }] })).reason,
    /programmes\[0\]\.name must not be empty/,
  );
  assert.match(typeGroup({ ...group(), extra: 1 }).reason, /does not store: extra/);
  assert.match(typeGrant(grant({ resourceId: 'case-1' })).reason, /resourceId is '\*' for a shortlist/);
  assert.match(typeGrant(grant({ revokedAt: NOW })).reason, /revokeReason is set exactly when the grant is revoked/);
  assert.match(typeGrant(grant({ toOrgIds: [A] })).reason, /toOrgIds names the owner itself/);
  assert.match(typeGrant(grant({ toOrgIds: [] })).reason, /toOrgIds names no recipient/);
  assert.match(
    typeGrant(grant({ resourceKind: 'player' })).reason,
    /resourceKind must be one of shortlist\|case\|assessment/,
  );
  assert.deepEqual(
    [
      typeExpiresDays(undefined).value,
      typeExpiresDays(7).value,
      typeExpiresDays(0).ok,
      typeExpiresDays(181).ok,
      typeExpiresDays(2.5).ok,
      typeExpiresDays('30').ok,
    ],
    [30, 7, false, false, false, false],
  );
});

// ------------------------------------------------------------- groups
test('[groups] created with its admin as its one member; invited once, joined by accepting, left; shared membership is live', () => {
  const { dir, s } = seeded('s13c-groups');
  refused(() => s.repo.groups.create(group({ memberOrgIds: [A, B] })), /a new group has one member, its admin/);
  refused(
    () => s.repo.groups.create(group({ adminOrgIds: ['org-none'], memberOrgIds: ['org-none'] })),
    /names no organisation \(org-none\)/,
  );
  assert.deepEqual(plain(s.repo.groups.create(group())), plain(group()));
  s.repo.groups.invite('grp-1', { orgId: B, invitedBy: A, at: NOW + 1 });
  refused(() => s.repo.groups.invite('grp-1', { orgId: B, invitedBy: A, at: NOW + 2 }), /already a member or invited/);
  refused(() => s.repo.groups.invite('grp-1', { orgId: A, invitedBy: A, at: NOW + 2 }), /already a member or invited/);
  assert.deepEqual(plain(s.repo.reads.groups.invitesFor(B)), [{ groupId: 'grp-1', name: 'North West Group' }]);
  assert.equal(s.repo.reads.groups.shareAGroup(A, B), false, 'an invitation alone is not membership');
  refused(() => s.repo.groups.accept('grp-1', C), /org-c holds no invite/);
  const joined = s.repo.groups.accept('grp-1', B);
  assert.deepEqual([joined.memberOrgIds, joined.adminOrgIds, joined.pendingInvites], [[A, B], [A], []]);
  assert.equal(s.repo.reads.groups.shareAGroup(A, B), true);
  assert.equal(s.repo.reads.groups.isAdmin('grp-1', B), false);
  assert.deepEqual(
    s.repo.reads.groups.forMember(B).map((g) => g.id),
    ['grp-1'],
  );
  s.repo.groups.shareTemplate('grp-1', 'tpl-1');
  s.repo.groups.shareTemplate('grp-1', 'tpl-1');
  s.repo.groups.addProgramme('grp-1', { id: 'pgm-1', name: 'U14 pathway', region: null, createdAt: NOW });
  refused(
    () => s.repo.groups.addProgramme('grp-1', { id: 'pgm-2', name: 'x'.repeat(101), region: null, createdAt: NOW }),
    /name exceeds 100 characters/,
  );
  const g = s.repo.reads.groups.byId('grp-1');
  assert.deepEqual(
    [g.sharedTemplateIds, g.programmes.map((p) => p.name)],
    [['tpl-1'], ['U14 pathway']],
    'a template is shared once',
  );
  assert.equal(s.repo.groups.leave('grp-1', A), true);
  assert.equal(s.repo.groups.leave('grp-1', A), false, 'leaving twice changes nothing');
  assert.deepEqual(
    [s.repo.reads.groups.byId('grp-1').adminOrgIds, s.repo.reads.groups.shareAGroup(A, B)],
    [[], false],
    'an admin who leaves is no longer an admin or a member',
  );
  s.repo.groups.create(group({ id: 'grp-2', name: 'Second' }));
  const page = s.repo.reads.groups.page({ limit: 1 });
  assert.deepEqual(
    page.items.map((x) => x.id),
    ['grp-2'],
  );
  assert.equal(typeof page.nextCursor, 'string');
  s.close();
  rm(dir);
});

// ------------------------------------------------------------- grants
test('[grants] only between members; revoked once; given pages by cursor; received keeps live grants of fellow members', () => {
  const { dir, s } = seeded('s13c-grants');
  threeMembers(s);
  refused(() => s.repo.grants.create(grant({ toOrgIds: ['org-none'] })), /org-none is not a member of grp-1/);
  assert.deepEqual(plain(s.repo.grants.create(grant())), plain(grant()));
  s.repo.grants.create(grant({ id: 'gnt-2', toOrgIds: [B, C], expiresAt: NOW + 10 }));
  assert.deepEqual(
    s.repo.reads.grants.liveReceived(B, NOW + 5).map((g) => g.id),
    ['gnt-2', 'gnt-1'],
  );
  assert.deepEqual(
    s.repo.reads.grants.liveReceived(B, NOW + 10).map((g) => g.id),
    ['gnt-1'],
    'expiry is derived from the clock',
  );
  assert.deepEqual(s.repo.reads.grants.countsFor(A, NOW + 5), { given: 2, received: 0 });
  assert.deepEqual(s.repo.reads.grants.countsForGroup('grp-1', NOW + 10), { created: 2, live: 1 });
  const first = s.repo.reads.grants.pageGiven(A, { limit: 1 });
  assert.deepEqual(
    first.items.map((g) => g.id),
    ['gnt-2'],
  );
  const second = s.repo.reads.grants.pageGiven(A, {
    limit: 1,
    after: JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString()),
  });
  assert.deepEqual([second.items.map((g) => g.id), second.nextCursor], [['gnt-1'], null]);
  assert.equal(s.repo.reads.grants.givenBy(B, 'gnt-1'), null, 'a recipient cannot act as the owner');
  const revoked = s.repo.grants.revoke('gnt-1', { at: NOW + 1, reason: 'revoked_by_owner' });
  assert.deepEqual(
    [revoked.revokedAt, s.repo.grants.revoke('gnt-1', { at: NOW + 2, reason: 'group_departure' }).revokeReason],
    [NOW + 1, 'revoked_by_owner'],
    'the first revocation stands',
  );
  refused(() => s.repo.grants.revoke('gnt-2', { at: NOW, reason: 'because' }), /a revocation names a time and one of/);
  assert.deepEqual(
    s.repo.reads.grants.allReceivedBy(C).map((g) => g.id),
    ['gnt-2'],
  );
  s.close();
  rm(dir);
});

test('[departure] a grant ends only when its owner shares no group with any recipient', () => {
  const { dir, s } = seeded('s13c-departure');
  threeMembers(s);
  s.repo.grants.create(grant({ id: 'gnt-1', toOrgIds: [B, C] }));
  s.repo.grants.create(grant({ id: 'gnt-2', toOrgIds: [B] }));
  s.repo.grants.create(grant({ id: 'gnt-3', fromOrgId: C, fromOrgName: 'Northside', toOrgIds: [A] }));
  s.repo.groups.leave('grp-1', B);
  assert.equal(s.repo.grants.endUnshared(B, NOW + 1), 1, 'B leaving ends only the grant B alone received');
  assert.deepEqual(
    ['gnt-1', 'gnt-2', 'gnt-3'].map((id) => s.repo.reads.grants.byId(id).revokeReason),
    [null, 'group_departure', null],
    'the grant whose first recipient left stays live for its other recipient',
  );
  assert.deepEqual(
    s.repo.reads.grants.liveReceived(B, NOW + 2).map((g) => g.id),
    [],
    'B no longer reads anything',
  );
  s.repo.groups.leave('grp-1', A);
  assert.equal(
    s.repo.grants.endUnshared(A, NOW + 3),
    2,
    'the owner leaving ends its last grant, and the grant it received',
  );
  s.close();
  rm(dir);
});

// ------------------------------------------------------------- units, retirement, fixtures
test('[unit] a rolled-back unit leaves nothing', () => {
  const { dir, s } = seeded('s13c-unit');
  assert.throws(
    () =>
      s.unit(() => {
        s.repo.groups.create(group());
        s.repo.groups.invite('grp-1', { orgId: B, invitedBy: A, at: NOW });
        throw new Error('boom');
      }),
    /boom/,
  );
  assert.equal(s.repo.reads.groups.byId('grp-1'), null);
  assert.equal(typeof s.repo.reads.groups.create, 'undefined', 'the reads cannot write');
  assert.equal(typeof s.repo.reads.grants.endUnshared, 'undefined', 'the reads cannot write');
  s.close();
  rm(dir);
});

/**
 * Groups and grants written the way the routes write them: a group is created with its admin as its one member, then
 * each other member is invited by the admin and accepts, the open invites are sent, the templates shared and the
 * programmes added; a grant is created live and then revoked.
 */
const WRITERS = {
  groups: (L, records) => {
    for (const { memberOrgIds, pendingInvites = [], sharedTemplateIds = [], programmes = [], ...g } of records) {
      const [admin] = g.adminOrgIds;
      L.groups.groups.create({
        ...g,
        memberOrgIds: [admin],
        pendingInvites: [],
        sharedTemplateIds: [],
        programmes: [],
      });
      for (const orgId of memberOrgIds.filter((o) => o !== admin)) {
        L.groups.groups.invite(g.id, { orgId, invitedBy: admin, at: g.createdAt });
        L.groups.groups.accept(g.id, orgId);
      }
      for (const i of pendingInvites) L.groups.groups.invite(g.id, i);
      for (const t of sharedTemplateIds) L.groups.groups.shareTemplate(g.id, t);
      for (const p of programmes) L.groups.groups.addProgramme(g.id, p);
    }
  },
  groupGrants: (L, records) => {
    for (const { revokedAt = null, revokeReason = null, ...g } of records) {
      L.groups.grants.create({ ...g, revokedAt: null, revokeReason: null });
      if (revokedAt !== null) L.groups.grants.revoke(g.id, { at: revokedAt, reason: revokeReason });
    }
  },
};
const write = (dir, records) => writeFixture(dir, records, { now: NOW, writers: WRITERS });
test('[fixtures] a record written through the repository is typed, a missing reference is named, a refused write leaves nothing, and the records read back as written', () => {
  const dir = tempDir('s13c-fix');
  const full = group({
    memberOrgIds: [A, B],
    pendingInvites: [{ orgId: C, invitedBy: A, at: NOW }],
    sharedTemplateIds: ['tpl-1'],
    programmes: [{ id: 'pgm-1', name: 'U14', region: 'North', createdAt: NOW }],
  });
  const ended = grant({ revokedAt: NOW + 1, revokeReason: 'revoked_by_owner' });
  write(dir, fixtureDb({ ...FIX(), groups: [full], groupGrants: [ended] }));
  const back = readRecords(dir);
  assert.deepEqual(plain(back.groups), [plain(full)]);
  assert.deepEqual(plain(back.groupGrants), [plain(ended)]);
  refused(
    () => write(dir, { groupGrants: [grant({ id: 'gnt-2', groupId: 'grp-none' })] }),
    /GROUPS_REFERENCE_MISSING.*grp-none/,
  );
  refused(
    () => write(dir, { groups: [group({ id: 'grp-2', memberOrgIds: [A, 'org-none'] })] }),
    /GROUPS_REFERENCE_MISSING.*org-none/,
  );
  refused(
    () => write(dir, { groups: [{ ...group({ id: 'grp-3' }), youAdmin: true }] }),
    /GROUPS_INPUT_INVALID.*does not store: youAdmin/,
  );
  const after = readRecords(dir);
  assert.deepEqual(
    [after.groups.map((g) => g.id), after.groupGrants.map((g) => g.id)],
    [['grp-1'], ['gnt-1']],
    'a refused write changed nothing',
  );
  rm(dir);
});

console.log(`\n${passed} groups checks passed`);
