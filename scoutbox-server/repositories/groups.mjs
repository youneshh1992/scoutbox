/**
 * Group workspaces and group grants.
 *
 * Records:
 *   - A group (a federation or parent organisation): its member organisations as rows, each flagged admin or not
 *     (so an admin is always a member), its pending invites (one per invited organisation, never a member's), the
 *     assessment templates its admin shares (by template id) and its programmes.
 *   - A group grant: one organisation shares one resource (its whole shortlist, a case or an assessment) with
 *     named fellow members until it expires or is revoked. The recipients are ordered rows. Ownership, liveness, shared
 *     membership and each player's visibility are re-checked on every read (domains/groups/groups.mjs).
 *
 * Every write joins the open unit of work, the caller's transaction or its own. Records are deep-frozen; lists decode
 * child rows in one batch. Modules receive the queries as `groupReads`.
 *
 * References. Organisations are RESTRICT keys; so is a grant's group. A group's member, invite, template and
 * programme rows cascade with it (groups are never deleted); a grant's recipients cascade with the grant.
 */
import { isPlainObject, ids, describe } from './recruitment.mjs';
import { transaction, migrationApplied, childRowsOf } from './database.mjs';
import { deepFreeze } from '../domains/platform/values.mjs';
import { text, int, oneOf, tableDdl, bad, typeSpec, encode, decode, insertSql } from './fieldSpecs.mjs';
import { pageOf } from '../domains/platform/paging.mjs';

export const GROUPS_MIGRATION = '0036_groups';
export const GROUPS_COLLECTIONS = Object.freeze(['groups', 'groupGrants']);

// ------------------------------------------------------------------ vocabularies and limits (one definition)
/** What a grant can share: the owner's whole shortlist (resource id '*'), one of its cases, one of its assessments. */
export const GRANT_RESOURCE_KINDS = Object.freeze(['shortlist', 'case', 'assessment']);
export const GRANT_REVOKE_REASONS = Object.freeze(['group_departure', 'revoked_by_owner']);
export const GROUP_LIMITS = Object.freeze({
  id: 80, name: 100, orgName: 200, staffName: 200, programmeName: 100, region: 80,
  members: 500, templates: 200, programmes: 200, expiresDays: [1, 180],
});
const L = GROUP_LIMITS;
const DAY = 86_400_000;

// ------------------------------------------------------------------ field specs
const idf = (k, c, o = {}) => text(k, c, L.id, { nonEmpty: true, ...o });
const req = { req: true };

const GROUP_SPEC = [idf('id', 'id', req), text('name', 'name', L.name, { req: true, nonEmpty: true }), int('createdAt', 'created_at', req)];
const PROGRAMME_SPEC = [
  idf('id', 'id', req), text('name', 'name', L.programmeName, { req: true, nonEmpty: true }), text('region', 'region', L.region, { nonEmpty: true }),
  int('createdAt', 'created_at', req),
];
const GRANT_SPEC = [
  idf('id', 'id', req), idf('groupId', 'group_id', req), idf('fromOrgId', 'from_org_id', req),
  text('fromOrgName', 'from_org_name', L.orgName, req), oneOf('resourceKind', 'resource_kind', GRANT_RESOURCE_KINDS, req),
  idf('resourceId', 'resource_id', req), int('expiresAt', 'expires_at', req), int('revokedAt', 'revoked_at'),
  oneOf('revokeReason', 'revoke_reason', GRANT_REVOKE_REASONS), text('createdBy', 'created_by_name', L.staffName), int('createdAt', 'created_at', req),
];

// ------------------------------------------------------------------ DDL
const rowOf = (name, c, key = 'id') => `FOREIGN KEY (${c}) REFERENCES ${name}(${key}) ON DELETE RESTRICT`;
const ownedBy = (name, c, key = 'id') => `FOREIGN KEY (${c}) REFERENCES ${name}(${key}) ON DELETE CASCADE`;
const col = (c, def) => `${c.padEnd(40)} ${def}`;
const idCol = (c) => col(c, `TEXT NOT NULL CHECK (length(${c}) > 0 AND length(${c}) <= ${L.id})`);
const table = (name, cols) => `CREATE TABLE ${name} (\n  ${cols.join(',\n  ')}\n) STRICT;`;

const PROGRAMME_ROW_SPEC = [PROGRAMME_SPEC[0], idf('groupId', 'group_id', req), ...PROGRAMME_SPEC.slice(1)];

export const GROUPS_DDL = [
  tableDdl('groups', GROUP_SPEC),
  // One row per member organisation; `admin` marks the organisations that administer the group.
  table('group_members', [
    idCol('group_id'), idCol('org_id'), col('admin', 'INTEGER NOT NULL CHECK (admin IN (0,1))'),
    ownedBy('groups', 'group_id'), rowOf('orgs', 'org_id'), 'PRIMARY KEY (group_id, org_id)',
  ]),
  'CREATE INDEX group_members_org ON group_members (org_id, group_id);',
  table('group_pending_invites', [
    idCol('group_id'), idCol('org_id'), idCol('invited_by_org_id'), col('invited_at', 'INTEGER NOT NULL'),
    ownedBy('groups', 'group_id'), rowOf('orgs', 'org_id'), rowOf('orgs', 'invited_by_org_id'), 'PRIMARY KEY (group_id, org_id)',
  ]),
  'CREATE INDEX group_pending_invites_org ON group_pending_invites (org_id);',
  // An assessment template by its id (a template id is shared by every version and every club).
  table('group_shared_templates', [idCol('group_id'), idCol('template_id'), ownedBy('groups', 'group_id'), 'PRIMARY KEY (group_id, template_id)']),
  tableDdl('group_programmes', PROGRAMME_ROW_SPEC, [ownedBy('groups', 'group_id')]),
  'CREATE INDEX group_programmes_group ON group_programmes (group_id);',

  tableDdl('group_grants', GRANT_SPEC, [
    rowOf('groups', 'group_id'), rowOf('orgs', 'from_org_id'),
    "CHECK (resource_kind <> 'shortlist' OR resource_id = '*')",
    'CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))',
  ]),
  'CREATE INDEX group_grants_from_org ON group_grants (from_org_id);',
  'CREATE INDEX group_grants_group ON group_grants (group_id);',
  table('group_grant_recipients', [
    idCol('grant_id'), col('ord', 'INTEGER NOT NULL CHECK (ord >= 0)'), idCol('org_id'),
    ownedBy('group_grants', 'grant_id'), rowOf('orgs', 'org_id'), 'PRIMARY KEY (grant_id, ord)', 'UNIQUE (grant_id, org_id)',
  ]),
  'CREATE INDEX group_grant_recipients_org ON group_grant_recipients (org_id);',
].join('\n');
export const GROUPS_TABLES = Object.freeze([
  'groups', 'group_members', 'group_pending_invites', 'group_shared_templates', 'group_programmes', 'group_grants', 'group_grant_recipients',
]);

// ------------------------------------------------------------------ typing
export const refusal = (code, message, extra = {}) => Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
const labelOf = (at, raw) => `${at} ${isPlainObject(raw) && typeof raw.id === 'string' ? raw.id : ''}`.trim();
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= L.id;
const withOnly = (raw, at, keys) => {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  const unknown = Object.keys(raw).filter((k) => !keys.includes(k));
  return unknown.length ? { ok: false, reason: `${at} carries field(s) this build does not store: ${unknown.join(', ')}` } : { ok: true };
};
/** A list of distinct record ids, at most `max`. */
function typeIdList(list, label, field, max) {
  if (!Array.isArray(list)) return bad(label, field, `must be a list (got ${describe(list)})`);
  if (list.length > max) return bad(label, field, `holds more than ${max} entries`);
  for (const [i, v] of list.entries()) if (!isId(v)) return bad(label, `${field}[${i}]`, `must be a record id (got ${describe(v)})`);
  if (new Set(list).size !== list.length) return bad(label, field, 'names an organisation or record twice');
  return { ok: true, value: [...list] };
}

export function typeGroup(raw, at = 'groups') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { memberOrgIds, adminOrgIds, pendingInvites, sharedTemplateIds, programmes, ...rest } = raw;
  const t = typeSpec(GROUP_SPEC, rest, label); if (!t.ok) return t;
  const members = typeIdList(memberOrgIds, label, 'memberOrgIds', L.members); if (!members.ok) return members;
  const admins = typeIdList(adminOrgIds, label, 'adminOrgIds', L.members); if (!admins.ok) return admins;
  const missing = admins.value.find((id) => !members.value.includes(id));
  if (missing) return bad(label, 'adminOrgIds', `names an organisation that is not a member (${missing})`);
  if (!Array.isArray(pendingInvites) || pendingInvites.length > L.members) return bad(label, 'pendingInvites', `must be a list of at most ${L.members}`);
  const invites = [];
  for (const [i, x] of pendingInvites.entries()) {
    const f = `${label}.pendingInvites[${i}]`;
    const shape = withOnly(x, f, ['orgId', 'invitedBy', 'at']); if (!shape.ok) return shape;
    if (!isId(x.orgId)) return bad(f, 'orgId', 'must be an organisation id');
    if (!isId(x.invitedBy)) return bad(f, 'invitedBy', 'must be an organisation id');
    if (!Number.isSafeInteger(x.at)) return bad(f, 'at', `must be an integer (got ${describe(x.at)})`);
    if (members.value.includes(x.orgId)) return bad(f, 'orgId', 'is already a member');
    if (invites.some((y) => y.orgId === x.orgId)) return bad(f, 'orgId', 'is invited twice');
    invites.push({ orgId: x.orgId, invitedBy: x.invitedBy, at: x.at });
  }
  const templates = typeIdList(sharedTemplateIds, label, 'sharedTemplateIds', L.templates); if (!templates.ok) return templates;
  if (!Array.isArray(programmes) || programmes.length > L.programmes) return bad(label, 'programmes', `must be a list of at most ${L.programmes}`);
  const progs = [];
  for (const [i, x] of programmes.entries()) { const p = typeSpec(PROGRAMME_SPEC, x, `${label}.programmes[${i}]`); if (!p.ok) return p; progs.push(p.record); }
  return {
    ok: true,
    record: { ...t.record, adminOrgIds: admins.value, memberOrgIds: members.value, pendingInvites: invites, sharedTemplateIds: templates.value, programmes: progs },
  };
}

export function typeGrant(raw, at = 'groupGrants') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { toOrgIds, ...rest } = raw;
  const t = typeSpec(GRANT_SPEC, rest, label); if (!t.ok) return t;
  const g = t.record;
  const to = typeIdList(toOrgIds, label, 'toOrgIds', L.members); if (!to.ok) return to;
  if (!to.value.length) return bad(label, 'toOrgIds', 'names no recipient');
  if (to.value.includes(g.fromOrgId)) return bad(label, 'toOrgIds', 'names the owner itself');
  if (g.resourceKind === 'shortlist' && g.resourceId !== '*') return bad(label, 'resourceId', "is '*' for a shortlist (the owner's whole shortlist)");
  if ((g.revokedAt === null) !== (g.revokeReason === null)) return bad(label, 'revokeReason', 'is set exactly when the grant is revoked');
  return { ok: true, record: { ...g, toOrgIds: to.value } };
}

/** The days a new grant runs for: absent is 30; otherwise a whole number from 1 to 180. `{ ok, value }` or `{ ok: false }`. */
export function typeExpiresDays(v) {
  if (v === undefined || v === null) return { ok: true, value: 30 };
  return Number.isInteger(v) && v >= L.expiresDays[0] && v <= L.expiresDays[1] ? { ok: true, value: v } : { ok: false };
}
export const grantExpiry = (createdAt, days) => createdAt + days * DAY;

// ------------------------------------------------------------------ rows
function statements(sqlite) {
  const p = (sql) => sqlite.prepare(sql);
  return {
    group: p(insertSql('groups', GROUP_SPEC)),
    member: p('INSERT INTO group_members (group_id, org_id, admin) VALUES (?, ?, ?)'),
    invite: p('INSERT INTO group_pending_invites (group_id, org_id, invited_by_org_id, invited_at) VALUES (?, ?, ?, ?)'),
    template: p('INSERT INTO group_shared_templates (group_id, template_id) VALUES (?, ?)'),
    programme: p(insertSql('group_programmes', PROGRAMME_ROW_SPEC)),
    grant: p(insertSql('group_grants', GRANT_SPEC)),
    recipient: p('INSERT INTO group_grant_recipients (grant_id, ord, org_id) VALUES (?, ?, ?)'),
  };
}
function writeGroup(st, g) {
  st.group.run(encode(GROUP_SPEC, g));
  for (const orgId of g.memberOrgIds) st.member.run(g.id, orgId, g.adminOrgIds.includes(orgId) ? 1 : 0);
  for (const i of g.pendingInvites) st.invite.run(g.id, i.orgId, i.invitedBy, i.at);
  for (const t of g.sharedTemplateIds) st.template.run(g.id, t);
  for (const p of g.programmes) st.programme.run(encode(PROGRAMME_ROW_SPEC, { ...p, groupId: g.id }));
}
function writeGrant(st, g) {
  st.grant.run(encode(GRANT_SPEC, g));
  g.toOrgIds.forEach((orgId, i) => st.recipient.run(g.id, i, orgId));
}
function decodeGroups(sqlite, rows) {
  const gids = rows.map((r) => r.id);
  const members = childRowsOf(sqlite, 'group_members', 'group_id', gids);
  const invites = childRowsOf(sqlite, 'group_pending_invites', 'group_id', gids);
  const templates = childRowsOf(sqlite, 'group_shared_templates', 'group_id', gids);
  const programmes = childRowsOf(sqlite, 'group_programmes', 'group_id', gids);
  return rows.map((row) => {
    const ms = members.all(row.id);
    return {
      ...decode(GROUP_SPEC, row),
      adminOrgIds: ms.filter((m) => m.admin === 1).map((m) => m.org_id),
      memberOrgIds: ms.map((m) => m.org_id),
      pendingInvites: invites.all(row.id).map((i) => ({ orgId: i.org_id, invitedBy: i.invited_by_org_id, at: i.invited_at })),
      sharedTemplateIds: templates.all(row.id).map((t) => t.template_id),
      programmes: programmes.all(row.id).map((p) => decode(PROGRAMME_SPEC, p)),
    };
  });
}
function decodeGrants(sqlite, rows) {
  const to = childRowsOf(sqlite, 'group_grant_recipients', 'grant_id', rows.map((r) => r.id), { order: 'ord' });
  return rows.map((row) => ({ ...decode(GRANT_SPEC, row), toOrgIds: to.all(row.id).map((r) => r.org_id) }));
}

// ------------------------------------------------------------------ whole-domain read (the test suites)
export const groupsLive = (sqlite) => migrationApplied(sqlite, GROUPS_MIGRATION);
function readAll(sqlite) {
  const all = (t) => sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
  return { groups: decodeGroups(sqlite, all('groups')), groupGrants: decodeGrants(sqlite, all('group_grants')) };
}
/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const GROUPS_RECORDS = {
  names: GROUPS_COLLECTIONS,
  read(sqlite) { return groupsLive(sqlite) ? readAll(sqlite) : null; },
};

// ------------------------------------------------------------------ the repository
const WRITES = new Set(['create', 'invite', 'accept', 'leave', 'shareTemplate', 'addProgramme', 'revoke', 'endUnshared']);

/**
 * `createGroupsRepository({ sqlite, unit, now, log })`: `groups` and `grants`, each with its writes and queries, plus
 * `reads` (the queries alone: `groupReads`).
 */
export function createGroupsRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the groups repository needs a SQLite connection (node:sqlite)');
  const operation = (fn) => (unit?.active?.() ? unit.join(fn) : sqlite.isTransaction ? fn() : transaction(sqlite, fn));
  const cache = new Map();
  const q = (sql) => { let s = cache.get(sql); if (!s) cache.set(sql, (s = sqlite.prepare(sql))); return s; };
  const st = statements(sqlite);
  const typedOr = (type, raw, name) => { const t = type(raw, name); if (!t.ok) throw refusal('GROUPS_INPUT_INVALID', t.reason); return t.record; };
  const str = (v) => typeof v === 'string';
  const needOrg = (what, id) => { if (!q('SELECT 1 FROM orgs WHERE id = ?').get(id)) throw refusal('GROUPS_REFERENCE_MISSING', `${what} names no organisation (${id})`); };
  const notFound = (table, id) => refusal('GROUPS_NOT_FOUND', `${table} ${id} is not a record of the repository`);

  // ---- groups
  const decGr = (rows) => decodeGroups(sqlite, rows).map(deepFreeze);
  const groupById = (id) => (str(id) ? decGr(q('SELECT * FROM groups WHERE id = ?').all(id))[0] ?? null : null);
  const mustGroup = (id) => { const g = groupById(id); if (!g) throw notFound('groups', id); return g; };
  const isMember = (groupId, orgId) => !!q('SELECT 1 FROM group_members WHERE group_id = ? AND org_id = ?').get(groupId, orgId);
  const groups = {
    /** A new group with its first (admin) member; no invites, templates or programmes. */
    create: (raw) => operation(() => {
      const g = typedOr(typeGroup, raw, 'groups');
      if (g.memberOrgIds.length !== 1 || g.adminOrgIds.length !== 1 || g.pendingInvites.length || g.sharedTemplateIds.length || g.programmes.length) {
        throw refusal('GROUPS_INPUT_INVALID', `groups ${g.id}: a new group has one member, its admin, and nothing else`);
      }
      if (groupById(g.id)) throw refusal('GROUPS_DUPLICATE', `groups ${g.id} already exists`);
      needOrg(`groups ${g.id} admin`, g.adminOrgIds[0]);
      writeGroup(st, g);
      return groupById(g.id);
    }),
    /** `invitedBy` invites `orgId` (neither a member nor already invited) at `at`. */
    invite: (groupId, { orgId, invitedBy, at }) => operation(() => {
      const g = mustGroup(groupId);
      if (!isId(orgId) || !isId(invitedBy) || !Number.isSafeInteger(at)) throw refusal('GROUPS_INPUT_INVALID', `groups ${groupId}: an invite names two organisations and a time`);
      if (g.memberOrgIds.includes(orgId) || g.pendingInvites.some((i) => i.orgId === orgId)) throw refusal('GROUPS_DUPLICATE', `groups ${groupId}: ${orgId} is already a member or invited`);
      needOrg(`groups ${groupId} invite`, orgId); needOrg(`groups ${groupId} invite by`, invitedBy);
      if (g.memberOrgIds.length + g.pendingInvites.length >= L.members) throw refusal('GROUPS_INPUT_INVALID', `groups ${groupId} holds ${L.members} members and invites already`);
      st.invite.run(groupId, orgId, invitedBy, at);
      return groupById(groupId);
    }),
    /** The invited organisation joins (not as an admin); its invite goes. */
    accept: (groupId, orgId) => operation(() => {
      const removed = q('DELETE FROM group_pending_invites WHERE group_id = ? AND org_id = ?').run(groupId, orgId).changes;
      if (!removed) throw refusal('GROUPS_NOT_FOUND', `groups ${groupId}: ${orgId} holds no invite`);
      st.member.run(groupId, orgId, 0);
      return groupById(groupId);
    }),
    /** The organisation leaves (admin or not); false when it was not a member. */
    leave: (groupId, orgId) => operation(() => q('DELETE FROM group_members WHERE group_id = ? AND org_id = ?').run(groupId, orgId).changes === 1),
    /** Share an assessment template with the group (once). */
    shareTemplate: (groupId, templateId) => operation(() => {
      const g = mustGroup(groupId);
      if (!isId(templateId)) throw refusal('GROUPS_INPUT_INVALID', `groups ${groupId}: templateId must be a record id`);
      if (g.sharedTemplateIds.includes(templateId)) return g;
      if (g.sharedTemplateIds.length >= L.templates) throw refusal('GROUPS_INPUT_INVALID', `groups ${groupId} shares ${L.templates} templates already`);
      st.template.run(groupId, templateId);
      return groupById(groupId);
    }),
    /** A programme `{ id, name, region, createdAt }`. */
    addProgramme: (groupId, raw) => operation(() => {
      const g = mustGroup(groupId);
      const p = typedOr((x, a) => typeSpec(PROGRAMME_SPEC, x, a), raw, `groups ${groupId} programme`);
      if (g.programmes.length >= L.programmes) throw refusal('GROUPS_INPUT_INVALID', `groups ${groupId} holds ${L.programmes} programmes already`);
      if (q('SELECT 1 FROM group_programmes WHERE id = ?').get(p.id)) throw refusal('GROUPS_DUPLICATE', `group_programmes ${p.id} already exists`);
      st.programme.run(encode(PROGRAMME_ROW_SPEC, { ...p, groupId }));
      return groupById(groupId);
    }),
    byId: groupById,
    /** The groups the organisation is a member of, oldest first. */
    forMember: (orgId) => (str(orgId) ? decGr(q('SELECT g.* FROM groups g JOIN group_members m ON m.group_id = g.id WHERE m.org_id = ? ORDER BY g.rowid').all(orgId)) : []),
    /** The groups that have invited the organisation: `{ groupId, name }`, oldest invite first. */
    invitesFor: (orgId) => (str(orgId) ? q('SELECT g.id AS groupId, g.name FROM group_pending_invites i JOIN groups g ON g.id = i.group_id WHERE i.org_id = ? ORDER BY i.rowid').all(orgId).map((r) => ({ groupId: r.groupId, name: r.name })) : []),
    isMember: (groupId, orgId) => str(groupId) && str(orgId) && isMember(groupId, orgId),
    isAdmin: (groupId, orgId) => str(groupId) && str(orgId) && !!q('SELECT 1 FROM group_members WHERE group_id = ? AND org_id = ? AND admin = 1').get(groupId, orgId),
    /** Do the two organisations share a group now? */
    shareAGroup: (orgA, orgB) => str(orgA) && str(orgB) && !!q('SELECT 1 FROM group_members a JOIN group_members b ON b.group_id = a.group_id WHERE a.org_id = ? AND b.org_id = ? LIMIT 1').get(orgA, orgB),
    /** A page of every group, newest first (Trust & Safety). */
    page: ({ after = null, limit }) => {
      const rows = q('SELECT rowid, * FROM groups WHERE (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?').all(after?.[0] ?? null, after?.[0] ?? null, limit + 1);
      const page = pageOf(rows, limit, (r) => [r.rowid]);
      return { items: decGr(page.items), nextCursor: page.nextCursor };
    },
  };

  // ---- grants
  const decG = (rows) => decodeGrants(sqlite, rows).map(deepFreeze);
  const grantById = (id) => (str(id) ? decG(q('SELECT * FROM group_grants WHERE id = ?').all(id))[0] ?? null : null);
  const LIVE = 'revoked_at IS NULL AND expires_at > ?';
  const SHARED = 'EXISTS (SELECT 1 FROM group_members a JOIN group_members b ON b.group_id = a.group_id WHERE a.org_id = gr.from_org_id AND b.org_id = ?)';
  const grants = {
    /** A new grant of a group the owner is a member of, to fellow members. */
    create: (raw) => operation(() => {
      const g = typedOr(typeGrant, raw, 'groupGrants');
      if (g.revokedAt !== null) throw refusal('GROUPS_INPUT_INVALID', `group_grants ${g.id}: a new grant is not revoked`);
      if (grantById(g.id)) throw refusal('GROUPS_DUPLICATE', `group_grants ${g.id} already exists`);
      if (!groupById(g.groupId)) throw refusal('GROUPS_REFERENCE_MISSING', `group_grants ${g.id}: no group ${g.groupId}`);
      for (const orgId of [g.fromOrgId, ...g.toOrgIds]) {
        if (!isMember(g.groupId, orgId)) throw refusal('GROUPS_INPUT_INVALID', `group_grants ${g.id}: ${orgId} is not a member of ${g.groupId}`);
      }
      writeGrant(st, g);
      return grantById(g.id);
    }),
    /** Revoke at `at` for `reason`; a grant already revoked is returned as it is (the first revocation stands). */
    revoke: (id, { at, reason }) => operation(() => {
      const g = grantById(id);
      if (!g) throw notFound('group_grants', id);
      if (g.revokedAt !== null) return g;
      if (!GRANT_REVOKE_REASONS.includes(reason) || !Number.isSafeInteger(at)) throw refusal('GROUPS_INPUT_INVALID', `group_grants ${id}: a revocation names a time and one of ${GRANT_REVOKE_REASONS.join('|')}`);
      q('UPDATE group_grants SET revoked_at = ?, revoke_reason = ? WHERE id = ?').run(at, reason, id);
      return grantById(id);
    }),
    /**
     * After `orgId` left a group: every unrevoked grant it gives or receives whose owner no longer shares a group with
     * ANY of its recipients is revoked at `at` ('group_departure'). Returns how many.
     */
    endUnshared: (orgId, at) => operation(() => q(`
      UPDATE group_grants AS gr SET revoked_at = ?, revoke_reason = 'group_departure'
      WHERE gr.revoked_at IS NULL
        AND (gr.from_org_id = ? OR EXISTS (SELECT 1 FROM group_grant_recipients r WHERE r.grant_id = gr.id AND r.org_id = ?))
        AND NOT EXISTS (
          SELECT 1 FROM group_grant_recipients r
          JOIN group_members a ON a.org_id = gr.from_org_id
          JOIN group_members b ON b.group_id = a.group_id AND b.org_id = r.org_id
          WHERE r.grant_id = gr.id)`).run(at, orgId, orgId).changes),
    byId: grantById,
    /** The grant if `orgId` gave it, else null. */
    givenBy: (orgId, id) => { const g = grantById(id); return g && g.fromOrgId === orgId ? g : null; },
    /** A page of the grants the organisation gave, newest first. */
    pageGiven: (orgId, { after = null, limit }) => {
      const rows = q('SELECT rowid, * FROM group_grants WHERE from_org_id = ? AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?').all(orgId, after?.[0] ?? null, after?.[0] ?? null, limit + 1);
      const page = pageOf(rows, limit, (r) => [r.rowid]);
      return { items: decG(page.items), nextCursor: page.nextCursor };
    },
    /** The grants naming the organisation that are live at `at` and whose owner still shares a group with it, newest first. */
    liveReceived: (orgId, at) => decG(q(`SELECT gr.* FROM group_grants gr JOIN group_grant_recipients r ON r.grant_id = gr.id
      WHERE r.org_id = ? AND gr.revoked_at IS NULL AND gr.expires_at > ? AND ${SHARED} ORDER BY gr.rowid DESC`).all(orgId, at, orgId)),
    /** `{ given, received }`: how many grants the organisation gave, and how many it can read now. */
    countsFor: (orgId, at) => ({
      given: q('SELECT COUNT(*) AS n FROM group_grants WHERE from_org_id = ?').get(orgId).n,
      received: q(`SELECT COUNT(*) AS n FROM group_grants gr JOIN group_grant_recipients r ON r.grant_id = gr.id
        WHERE r.org_id = ? AND gr.revoked_at IS NULL AND gr.expires_at > ? AND ${SHARED}`).get(orgId, at, orgId).n,
    }),
    /** `{ created, live }` for the group's grants at `at`. */
    countsForGroup: (groupId, at) => {
      const r = q(`SELECT COUNT(*) AS created, COALESCE(SUM(CASE WHEN ${LIVE} THEN 1 ELSE 0 END), 0) AS live FROM group_grants WHERE group_id = ?`).get(at, groupId);
      return { created: r.created, live: r.live };
    },
    /** Every grant the organisation gave, oldest first (the audit export). */
    allGivenBy: (orgId) => decG(q('SELECT * FROM group_grants WHERE from_org_id = ? ORDER BY rowid').all(orgId)),
    /** Every grant naming the organisation, oldest first (the audit export). */
    allReceivedBy: (orgId) => decG(q('SELECT gr.* FROM group_grants gr JOIN group_grant_recipients r ON r.grant_id = gr.id WHERE r.org_id = ? ORDER BY gr.rowid').all(orgId)),
  };

  const readOnly = (o) => Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => !WRITES.has(k))));
  const repo = { groups, grants };
  const counters = { groups: q('SELECT COUNT(*) AS n FROM groups'), groupGrants: q('SELECT COUNT(*) AS n FROM group_grants') };
  return {
    ...repo,
    /** The queries alone, for modules that must not write (`groupReads`). */
    reads: Object.freeze(Object.fromEntries(Object.entries(repo).map(([k, v]) => [k, readOnly(v)]))),
    attach() {
      if (!groupsLive(sqlite)) throw new Error(`the groups repository needs ${GROUPS_MIGRATION} recorded; it never imports an in-memory array`);
      return { counts: this.counts() };
    },
    counts() { return Object.fromEntries(GROUPS_COLLECTIONS.map((n) => [n, counters[n].get().n])); },
    pending: () => 0,
    exportAll() { return GROUPS_RECORDS.read(sqlite); },
    log,
    now,
  };
}
