/**
 * S9c — a club's own setup as typed tables (migration `0021_club_setup`; docs/architecture/migration.md §4.3 "The
 * pattern", §4.5 S9; sql/04_scouting_assessment.sql): the tactical setup (roles with their criteria, transfer
 * windows), the squad, the shadow list, what a grassroots club is looking for, the federation-route verification
 * request, and role vacancies.
 *
 * The first four used to be facets of the organisation record (`org.tactical`, `org.squad`, `org.lookingFor`,
 * `org.federationCheck`, edited in place and flushed with `orgs.facets_json`); vacancies were the blob collection
 * `db.vacancies`. Reading or writing any of them on an organisation now throws, naming this repository
 * (repositories/orgs.mjs `RETIRED_FACETS`), and db.vacancies throws too.
 *
 * The shadow list is its own table (org_shadow_players), not a kind of squad row: a club considering a player for a
 * role is not that player's club. Nothing that reads "on this club's squad" (the grassroots squad, match-day
 * attendance, release, the passport's club relationships, the Trust score, Second Look) sees a shadow entry.
 *
 * WRITES are explicit and typed whole; a record the columns cannot hold is refused with its id (the routes check
 * first and answer 400). Each joins the open unit of work, the caller's transaction, or a transaction of its own.
 *   tactical.save(setup)        — upserts the setup and diffs its roles BY ID: a kept role keeps its row (so its
 *                                 vacancies and shadow entries keep their role), a new role is inserted, a dropped
 *                                 role is deleted (their role_id becomes null; the candidates route answers
 *                                 409 ROLE_DELETED, as before).
 *   squad.create / squad.remove, shadow.create, lookingFor.set, federation.submit, vacancies.create / update.
 *
 * READS are SQL and return fresh deep-frozen records; there is no mirror. Modules receive the queries through
 * `scoutingReads` (tacticalSetups, squad, shadow, lookingFor, federationChecks, vacancies).
 *
 * References. Player ids have NO foreign key (tolerant, like recruitment and S9a: a squad row outlives the account,
 * as it always has). org_id → orgs is RESTRICT (organisations are never deleted, O2). A role's org is its setup
 * (CASCADE children); vacancies.role_id and org_shadow_players.role_id → org_tactical_roles are ON DELETE SET NULL
 * (the documented "role deleted" state); that a role belongs to the same organisation is checked here.
 */
import { isPlainObject, ids, describe } from './recruitment.mjs';
import { transaction, migrationApplied } from './database.mjs';
import { refusal, isInt, isStr, nonEmpty, orNull, clone, bad, optText, reqText, optInstant, reqInstant, unknownFields, first, txt, deepFreeze } from './scoutingEvidence.mjs';
import { PLAYER_POSITIONS, PLAYER_FEET, PLAYER_AVAILABILITY, PLAYER_LEVELS } from './identity.mjs';
import { parseStrictDateOnly } from '../temporal.mjs';

export const CLUB_SETUP_MIGRATION = '0021_club_setup';
export const CLUB_SETUP_COLLECTIONS = Object.freeze(['tacticalSetups', 'squadMembers', 'shadowPlayers', 'lookingFor', 'federationChecks', 'vacancies']);
export const CLUB_SETUP_TABLES = Object.freeze(['org_tactical_setups', 'org_tactical_roles', 'org_tactical_role_criteria', 'org_tactical_windows', 'org_squad_members', 'org_shadow_players', 'org_looking_for', 'org_federation_checks', 'vacancies']);

export const ROLE_POSITION_GROUPS = Object.freeze(['GK', 'DEF', 'MID', 'ATT']);
export const ROLE_CATEGORIES = Object.freeze(['mens', 'womens', 'boys', 'girls', 'mixed']);
export const CRITERIA_KEYS = Object.freeze(['positionGroup', 'minAge', 'maxAge', 'foot', 'availability', 'maxLevel', 'minAppearances', 'category']);
/** What each criterion's value may be: a vocabulary (text) or a whole-number range. */
export const CRITERIA_VALUES = Object.freeze({
  positionGroup: ROLE_POSITION_GROUPS, foot: PLAYER_FEET, availability: PLAYER_AVAILABILITY, maxLevel: PLAYER_LEVELS, category: ROLE_CATEGORIES,
  minAge: Object.freeze({ min: 5, max: 60 }), maxAge: Object.freeze({ min: 5, max: 60 }), minAppearances: Object.freeze({ min: 0, max: 1000 }),
});
export const SQUAD_SOURCES = Object.freeze(['manual', 'invite_approved', 'signing']);
export const VACANCY_STATUSES = Object.freeze(['open', 'closed']);
export const LOOKING_FOR_POSITIONS = PLAYER_POSITIONS;
/** Limits: text over these is shortened by the routes (as it always was); lists over them are refused. */
export const CLUB_SETUP_LIMITS = Object.freeze({
  formation: 20, planningHorizon: 40, roles: 15, windows: 4, criteria: 8, roleName: 60, description: 300, windowName: 40,
  name: 200, position: 40, approvedBy: 200, lookingFor: 5, federation: 120, registrationId: 60, contactEmail: 120, notes: 300,
});
const L = CLUB_SETUP_LIMITS;
const inList = (list) => list.map((v) => `'${v}'`).join(',');

// ------------------------------------------------------------------ DDL
export const CLUB_SETUP_DDL = `
CREATE TABLE org_tactical_setups (
  org_id           TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE RESTRICT,
  formation        TEXT NOT NULL CHECK (length(formation) BETWEEN 1 AND ${L.formation}),
  planning_horizon ${txt('planning_horizon', L.planningHorizon)},
  updated_at       INTEGER NOT NULL,
  updated_by_name  ${txt('updated_by_name', L.name, { notNull: true })}
) STRICT;
CREATE TABLE org_tactical_roles (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES org_tactical_setups(org_id) ON DELETE CASCADE,
  ordinal        INTEGER NOT NULL CHECK (ordinal >= 0),
  name           TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND ${L.roleName}),
  position_group TEXT NOT NULL CHECK (position_group IN (${inList(ROLE_POSITION_GROUPS)})),
  description    ${txt('description', L.description, { notNull: true })},
  category       TEXT NOT NULL CHECK (category IN (${inList(ROLE_CATEGORIES)})),
  UNIQUE (org_id, id)
) STRICT;
CREATE TABLE org_tactical_role_criteria (
  role_id      TEXT NOT NULL REFERENCES org_tactical_roles(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('required','preferred')),
  ordinal      INTEGER NOT NULL CHECK (ordinal >= 0),
  key          TEXT NOT NULL CHECK (key IN (${inList(CRITERIA_KEYS)})),
  value_number INTEGER,
  value_text   TEXT CHECK (value_text IS NULL OR length(value_text) <= 40),
  PRIMARY KEY (role_id, kind, ordinal),
  UNIQUE (role_id, kind, key),
  CHECK ((value_number IS NULL) <> (value_text IS NULL)),
  CHECK ((key IN ('minAge','maxAge','minAppearances')) = (value_number IS NOT NULL))
) STRICT;
CREATE TABLE org_tactical_windows (
  org_id  TEXT NOT NULL REFERENCES org_tactical_setups(org_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  name    ${txt('name', L.windowName, { notNull: true })},
  opens   TEXT CHECK (opens IS NULL OR length(opens) = 10),
  closes  TEXT CHECK (closes IS NULL OR length(closes) = 10),
  PRIMARY KEY (org_id, ordinal),
  CHECK (opens IS NULL OR closes IS NULL OR opens <= closes)
) STRICT;
CREATE TABLE org_squad_members (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  player_id         TEXT,
  name              TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND ${L.name}),
  position          ${txt('position', L.position)},
  source            TEXT NOT NULL CHECK (source IN (${inList(SQUAD_SOURCES)})),
  approved_by_label ${txt('approved_by_label', L.approvedBy)},
  added_at          INTEGER NOT NULL,
  CHECK ((source = 'invite_approved') = (approved_by_label IS NOT NULL)),
  CHECK (source = 'manual' OR player_id IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX org_squad_members_org_player ON org_squad_members (org_id, player_id) WHERE player_id IS NOT NULL;
CREATE INDEX org_squad_members_org ON org_squad_members (org_id);
CREATE INDEX org_squad_members_player ON org_squad_members (player_id);
CREATE TABLE org_shadow_players (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  player_id     TEXT NOT NULL,
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND ${L.name}),
  role_id       TEXT REFERENCES org_tactical_roles(id) ON DELETE SET NULL,
  added_by_name ${txt('added_by_name', L.name, { notNull: true })},
  added_at      INTEGER NOT NULL,
  UNIQUE (org_id, player_id)
) STRICT;
CREATE INDEX org_shadow_players_player ON org_shadow_players (player_id);
CREATE TABLE org_looking_for (
  org_id   TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  ordinal  INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND ${L.lookingFor - 1}),
  position TEXT NOT NULL CHECK (position IN (${inList(LOOKING_FOR_POSITIONS)})),
  PRIMARY KEY (org_id, ordinal),
  UNIQUE (org_id, position)
) STRICT;
CREATE TABLE org_federation_checks (
  org_id          TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE RESTRICT,
  federation      TEXT NOT NULL CHECK (length(federation) BETWEEN 1 AND ${L.federation}),
  registration_id TEXT NOT NULL CHECK (length(registration_id) BETWEEN 1 AND ${L.registrationId}),
  contact_email   ${txt('contact_email', L.contactEmail)},
  status          TEXT NOT NULL CHECK (status IN ('pending')),
  submitted_at    INTEGER NOT NULL
) STRICT;
CREATE TABLE vacancies (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  role_id         TEXT REFERENCES org_tactical_roles(id) ON DELETE SET NULL,
  role_name       TEXT NOT NULL CHECK (length(role_name) BETWEEN 1 AND ${L.roleName}),
  window_name     ${txt('window_name', L.windowName)},
  notes           ${txt('notes', L.notes)},
  status          TEXT NOT NULL CHECK (status IN ('open','closed')),
  created_by_name ${txt('created_by_name', L.name, { notNull: true })},
  created_at      INTEGER NOT NULL,
  closed_at       INTEGER,
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
) STRICT;
CREATE INDEX vacancies_org_status ON vacancies (org_id, status);
CREATE INDEX vacancies_role ON vacancies (role_id);
CREATE INDEX org_shadow_players_role ON org_shadow_players (role_id);
`;

// ------------------------------------------------------------------ typing (the one place a value is judged)
const dayOnly = (v) => isStr(v) && parseStrictDateOnly(v).ok; // one definition of a calendar day (temporal.mjs)
const optDay = (rec, at, field) => (rec[field] === undefined || rec[field] === null || dayOnly(rec[field]) ? null : bad(at, field, `must be a YYYY-MM-DD day or null (got ${describe(rec[field])})`));
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** One criterion `{ key, value }`: the key one of CRITERIA_KEYS, the value in that key's vocabulary or range. */
export function typeCriterion(c, at) {
  if (!isPlainObject(c)) return { ok: false, reason: `${at} is not an object (${describe(c)})` };
  const u = unknownFields(c, at, ['key', 'value']); if (u) return u;
  if (!CRITERIA_KEYS.includes(c.key)) return bad(at, 'key', `must be one of ${CRITERIA_KEYS.join('|')} (got ${describe(c.key)})`);
  const rule = CRITERIA_VALUES[c.key];
  if (Array.isArray(rule)) {
    if (!rule.includes(c.value)) return bad(at, 'value', `must be one of ${rule.join('|')} for ${c.key} (got ${describe(c.value)})`);
  } else if (!isInt(c.value) || c.value < rule.min || c.value > rule.max) return bad(at, 'value', `must be a whole number from ${rule.min} to ${rule.max} for ${c.key} (got ${describe(c.value)})`);
  return { ok: true, record: { key: c.key, value: c.value } };
}
function typeCriteria(list, at) {
  if (list === undefined || list === null) return { ok: true, list: [] };
  if (!Array.isArray(list)) return { ok: false, reason: `${at} must be an array (got ${describe(list)})` };
  if (list.length > L.criteria) return bad(at, '', `holds more than ${L.criteria} criteria`);
  const out = []; const seen = new Set();
  for (let i = 0; i < list.length; i++) {
    const t = typeCriterion(list[i], `${at}[${i}]`); if (!t.ok) return t;
    if (seen.has(t.record.key)) return bad(`${at}[${i}]`, 'key', `repeats ${t.record.key}`);
    seen.add(t.record.key); out.push(t.record);
  }
  return { ok: true, list: out };
}
const ROLE_FIELDS = ['id', 'name', 'positionGroup', 'description', 'category', 'required', 'preferred'];
export function typeRole(r, at) {
  if (!isPlainObject(r)) return { ok: false, reason: `${at} is not an object (${describe(r)})` };
  const problem = first(unknownFields(r, at, ROLE_FIELDS), reqText(r, at, 'id', 80), reqText(r, at, 'name', L.roleName), optText(r, at, 'description', L.description));
  if (problem) return problem;
  if (!ROLE_POSITION_GROUPS.includes(r.positionGroup)) return bad(at, 'positionGroup', `must be one of ${ROLE_POSITION_GROUPS.join('|')} (got ${describe(r.positionGroup)})`);
  if (!ROLE_CATEGORIES.includes(r.category)) return bad(at, 'category', `must be one of ${ROLE_CATEGORIES.join('|')} (got ${describe(r.category)})`);
  const required = typeCriteria(r.required, `${at}.required`); if (!required.ok) return required;
  const preferred = typeCriteria(r.preferred, `${at}.preferred`); if (!preferred.ok) return preferred;
  const age = (k) => required.list.find((c) => c.key === k)?.value;
  if (age('minAge') !== undefined && age('maxAge') !== undefined && age('minAge') > age('maxAge')) return bad(`${at}.required`, 'maxAge', 'is below minAge (the role could match nobody)');
  return { ok: true, record: { id: r.id, name: r.name, positionGroup: r.positionGroup, description: r.description ?? '', category: r.category, required: required.list, preferred: preferred.list } };
}
export function typeWindow(w, at) {
  if (!isPlainObject(w)) return { ok: false, reason: `${at} is not an object (${describe(w)})` };
  const problem = first(unknownFields(w, at, ['name', 'opens', 'closes']), optText(w, at, 'name', L.windowName), optDay(w, at, 'opens'), optDay(w, at, 'closes'));
  if (problem) return problem;
  if (w.opens && w.closes && w.opens > w.closes) return bad(at, 'closes', 'is before opens');
  return { ok: true, record: { name: w.name ?? '', opens: orNull(w.opens), closes: orNull(w.closes) } };
}
const SETUP_FIELDS = ['orgId', 'formation', 'planningHorizon', 'windows', 'roles', 'updatedAt', 'updatedBy'];
/** A tactical setup `{ orgId, formation, planningHorizon, windows, roles, updatedAt, updatedBy }`, typed. */
export function typeTacticalSetup(raw, at = 'tacticalSetups') {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  if (!nonEmpty(raw.orgId)) return bad(at, 'orgId', 'must be a non-empty string');
  const label = `${at} ${raw.orgId}`;
  const problem = first(unknownFields(raw, label, SETUP_FIELDS), reqText(raw, label, 'formation', L.formation), optText(raw, label, 'planningHorizon', L.planningHorizon), reqInstant(raw, label, 'updatedAt'), reqText(raw, label, 'updatedBy', L.name));
  if (problem) return problem;
  if (!Array.isArray(raw.roles)) return bad(label, 'roles', `must be an array (got ${describe(raw.roles)})`);
  if (raw.roles.length > L.roles) return bad(label, 'roles', `holds more than ${L.roles} roles`);
  if (raw.windows !== undefined && raw.windows !== null && !Array.isArray(raw.windows)) return bad(label, 'windows', `must be an array (got ${describe(raw.windows)})`);
  const windowsIn = raw.windows ?? [];
  if (windowsIn.length > L.windows) return bad(label, 'windows', `holds more than ${L.windows} windows`);
  const roles = []; const seen = new Set();
  for (let i = 0; i < raw.roles.length; i++) {
    const t = typeRole(raw.roles[i], `${label}.roles[${i}]`); if (!t.ok) return t;
    if (seen.has(t.record.id)) return bad(`${label}.roles[${i}]`, 'id', `repeats ${t.record.id}`);
    seen.add(t.record.id); roles.push(t.record);
  }
  const windows = [];
  for (let i = 0; i < windowsIn.length; i++) { const t = typeWindow(windowsIn[i], `${label}.windows[${i}]`); if (!t.ok) return t; windows.push(t.record); }
  return { ok: true, record: { orgId: raw.orgId, formation: raw.formation, planningHorizon: orNull(raw.planningHorizon), windows, roles, updatedAt: raw.updatedAt, updatedBy: raw.updatedBy } };
}
const SQUAD_FIELDS = ['id', 'orgId', 'playerId', 'name', 'position', 'source', 'approvedBy', 'addedAt'];
export function typeSquadMember(raw, at = 'squadMembers') {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  if (!nonEmpty(raw.id)) return bad(at, 'id', 'must be a non-empty string');
  const label = `${at} ${raw.id}`;
  const problem = first(unknownFields(raw, label, SQUAD_FIELDS), reqText(raw, label, 'orgId', 80), optText(raw, label, 'playerId', 80), reqText(raw, label, 'name', L.name), optText(raw, label, 'position', L.position), optText(raw, label, 'approvedBy', L.approvedBy), reqInstant(raw, label, 'addedAt'));
  if (problem) return problem;
  if (!SQUAD_SOURCES.includes(raw.source)) return bad(label, 'source', `must be one of ${SQUAD_SOURCES.join('|')} (got ${describe(raw.source)})`);
  if ((raw.source === 'invite_approved') !== nonEmpty(raw.approvedBy)) return bad(label, 'approvedBy', raw.source === 'invite_approved' ? 'is required on an approved invitation' : 'belongs to approved invitations only');
  if (raw.source !== 'manual' && !nonEmpty(raw.playerId)) return bad(label, 'playerId', `is required on a ${raw.source} row`);
  return { ok: true, record: { id: raw.id, orgId: raw.orgId, playerId: raw.playerId || null, name: raw.name, position: raw.position || null, source: raw.source, approvedBy: orNull(raw.approvedBy), addedAt: raw.addedAt } };
}
const SHADOW_FIELDS = ['id', 'orgId', 'playerId', 'name', 'roleId', 'addedBy', 'addedAt'];
export function typeShadowPlayer(raw, at = 'shadowPlayers') {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  if (!nonEmpty(raw.id)) return bad(at, 'id', 'must be a non-empty string');
  const label = `${at} ${raw.id}`;
  const problem = first(unknownFields(raw, label, SHADOW_FIELDS), reqText(raw, label, 'orgId', 80), reqText(raw, label, 'playerId', 80), reqText(raw, label, 'name', L.name), optText(raw, label, 'roleId', 80), reqText(raw, label, 'addedBy', L.name), reqInstant(raw, label, 'addedAt'));
  if (problem) return problem;
  return { ok: true, record: { id: raw.id, orgId: raw.orgId, playerId: raw.playerId, name: raw.name, roleId: orNull(raw.roleId), addedBy: raw.addedBy, addedAt: raw.addedAt } };
}
export function typeLookingFor(raw, at = 'lookingFor') {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  if (!nonEmpty(raw.orgId)) return bad(at, 'orgId', 'must be a non-empty string');
  const label = `${at} ${raw.orgId}`;
  const u = unknownFields(raw, label, ['orgId', 'positions']); if (u) return u;
  if (!Array.isArray(raw.positions) || raw.positions.length > L.lookingFor) return bad(label, 'positions', `must be a list of at most ${L.lookingFor} positions`);
  for (const [i, p] of raw.positions.entries()) if (!LOOKING_FOR_POSITIONS.includes(p)) return bad(label, `positions[${i}]`, `must be one of ${LOOKING_FOR_POSITIONS.join('|')} (got ${describe(p)})`);
  if (new Set(raw.positions).size !== raw.positions.length) return bad(label, 'positions', 'names a position twice');
  return { ok: true, record: { orgId: raw.orgId, positions: [...raw.positions] } };
}
const FEDERATION_FIELDS = ['orgId', 'federation', 'registrationId', 'contactEmail', 'status', 'submittedAt'];
export function typeFederationCheck(raw, at = 'federationChecks') {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  if (!nonEmpty(raw.orgId)) return bad(at, 'orgId', 'must be a non-empty string');
  const label = `${at} ${raw.orgId}`;
  const problem = first(unknownFields(raw, label, FEDERATION_FIELDS), reqText(raw, label, 'federation', L.federation), reqText(raw, label, 'registrationId', L.registrationId), optText(raw, label, 'contactEmail', L.contactEmail), reqInstant(raw, label, 'submittedAt'));
  if (problem) return problem;
  if (raw.contactEmail && !EMAIL.test(raw.contactEmail)) return bad(label, 'contactEmail', 'must be an e-mail address or null');
  if (raw.status !== 'pending') return bad(label, 'status', `must be pending (got ${describe(raw.status)})`);
  return { ok: true, record: { orgId: raw.orgId, federation: raw.federation, registrationId: raw.registrationId, contactEmail: orNull(raw.contactEmail), status: 'pending', submittedAt: raw.submittedAt } };
}
const VACANCY_FIELDS = ['id', 'orgId', 'roleId', 'roleName', 'window', 'notes', 'status', 'createdBy', 'createdAt', 'closedAt'];
export function typeVacancy(raw, at = 'vacancies') {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  if (!nonEmpty(raw.id)) return bad(at, 'id', 'must be a non-empty string');
  const label = `${at} ${raw.id}`;
  const problem = first(unknownFields(raw, label, VACANCY_FIELDS), reqText(raw, label, 'orgId', 80), optText(raw, label, 'roleId', 80), reqText(raw, label, 'roleName', L.roleName), optText(raw, label, 'window', L.windowName), optText(raw, label, 'notes', L.notes), reqText(raw, label, 'createdBy', L.name), reqInstant(raw, label, 'createdAt'), optInstant(raw, label, 'closedAt'));
  if (problem) return problem;
  if (!VACANCY_STATUSES.includes(raw.status)) return bad(label, 'status', `must be one of ${VACANCY_STATUSES.join('|')} (got ${describe(raw.status)})`);
  if ((raw.status === 'closed') !== isInt(raw.closedAt)) return bad(label, 'closedAt', raw.status === 'closed' ? 'is required on a closed vacancy' : 'must be null while the vacancy is open');
  return { ok: true, record: { id: raw.id, orgId: raw.orgId, roleId: orNull(raw.roleId), roleName: raw.roleName, window: orNull(raw.window), notes: orNull(raw.notes), status: raw.status, createdBy: raw.createdBy, createdAt: raw.createdAt, closedAt: orNull(raw.closedAt) } };
}
const TYPERS = { tacticalSetups: typeTacticalSetup, squadMembers: typeSquadMember, shadowPlayers: typeShadowPlayer, lookingFor: typeLookingFor, federationChecks: typeFederationCheck, vacancies: typeVacancy };
const KEY_OF = { tacticalSetups: 'orgId', squadMembers: 'id', shadowPlayers: 'id', lookingFor: 'orgId', federationChecks: 'orgId', vacancies: 'id' };

// ------------------------------------------------------------------ rows
function statements(sqlite) {
  const p = (sql) => sqlite.prepare(sql);
  return {
    setup: p(`INSERT INTO org_tactical_setups (org_id, formation, planning_horizon, updated_at, updated_by_name) VALUES (@org_id, @formation, @planning_horizon, @updated_at, @updated_by_name)
      ON CONFLICT(org_id) DO UPDATE SET formation = excluded.formation, planning_horizon = excluded.planning_horizon, updated_at = excluded.updated_at, updated_by_name = excluded.updated_by_name`),
    role: p(`INSERT INTO org_tactical_roles (id, org_id, ordinal, name, position_group, description, category) VALUES (@id, @org_id, @ordinal, @name, @position_group, @description, @category)
      ON CONFLICT(id) DO UPDATE SET org_id = excluded.org_id, ordinal = excluded.ordinal, name = excluded.name, position_group = excluded.position_group, description = excluded.description, category = excluded.category`),
    roleOwner: p('SELECT org_id FROM org_tactical_roles WHERE id = ?'),
    rolesOf: p('SELECT * FROM org_tactical_roles WHERE org_id = ? ORDER BY ordinal'),
    roleDel: p('DELETE FROM org_tactical_roles WHERE id = ?'),
    criterion: p('INSERT INTO org_tactical_role_criteria (role_id, kind, ordinal, key, value_number, value_text) VALUES (?, ?, ?, ?, ?, ?)'),
    criteriaDel: p('DELETE FROM org_tactical_role_criteria WHERE role_id = ?'),
    criteriaOf: p('SELECT * FROM org_tactical_role_criteria WHERE role_id IN (SELECT id FROM org_tactical_roles WHERE org_id = ?) ORDER BY role_id, kind, ordinal'),
    window: p('INSERT INTO org_tactical_windows (org_id, ordinal, name, opens, closes) VALUES (?, ?, ?, ?, ?)'),
    windowsDel: p('DELETE FROM org_tactical_windows WHERE org_id = ?'),
    windowsOf: p('SELECT * FROM org_tactical_windows WHERE org_id = ? ORDER BY ordinal'),
    setupOf: p('SELECT * FROM org_tactical_setups WHERE org_id = ?'),
    setupDel: p('DELETE FROM org_tactical_setups WHERE org_id = ?'),
    squad: p(`INSERT INTO org_squad_members (id, org_id, player_id, name, position, source, approved_by_label, added_at) VALUES (@id, @org_id, @player_id, @name, @position, @source, @approved_by_label, @added_at)
      ON CONFLICT(id) DO UPDATE SET org_id = excluded.org_id, player_id = excluded.player_id, name = excluded.name, position = excluded.position, source = excluded.source, approved_by_label = excluded.approved_by_label, added_at = excluded.added_at`),
    squadById: p('SELECT * FROM org_squad_members WHERE id = ?'), squadDel: p('DELETE FROM org_squad_members WHERE id = ?'),
    shadow: p(`INSERT INTO org_shadow_players (id, org_id, player_id, name, role_id, added_by_name, added_at) VALUES (@id, @org_id, @player_id, @name, @role_id, @added_by_name, @added_at)
      ON CONFLICT(id) DO UPDATE SET org_id = excluded.org_id, player_id = excluded.player_id, name = excluded.name, role_id = excluded.role_id, added_by_name = excluded.added_by_name, added_at = excluded.added_at`),
    shadowById: p('SELECT * FROM org_shadow_players WHERE id = ?'), shadowDel: p('DELETE FROM org_shadow_players WHERE id = ?'),
    lookingFor: p('INSERT INTO org_looking_for (org_id, ordinal, position) VALUES (?, ?, ?)'),
    lookingForDel: p('DELETE FROM org_looking_for WHERE org_id = ?'),
    lookingForOf: p('SELECT position FROM org_looking_for WHERE org_id = ? ORDER BY ordinal'),
    federation: p(`INSERT INTO org_federation_checks (org_id, federation, registration_id, contact_email, status, submitted_at) VALUES (@org_id, @federation, @registration_id, @contact_email, @status, @submitted_at)
      ON CONFLICT(org_id) DO UPDATE SET federation = excluded.federation, registration_id = excluded.registration_id, contact_email = excluded.contact_email, status = excluded.status, submitted_at = excluded.submitted_at`),
    federationOf: p('SELECT * FROM org_federation_checks WHERE org_id = ?'), federationDel: p('DELETE FROM org_federation_checks WHERE org_id = ?'),
    vacancy: p(`INSERT INTO vacancies (id, org_id, role_id, role_name, window_name, notes, status, created_by_name, created_at, closed_at) VALUES (@id, @org_id, @role_id, @role_name, @window_name, @notes, @status, @created_by_name, @created_at, @closed_at)
      ON CONFLICT(id) DO UPDATE SET org_id = excluded.org_id, role_id = excluded.role_id, role_name = excluded.role_name, window_name = excluded.window_name, notes = excluded.notes, status = excluded.status, created_by_name = excluded.created_by_name, created_at = excluded.created_at, closed_at = excluded.closed_at`),
    vacancyById: p('SELECT * FROM vacancies WHERE id = ?'), vacancyDel: p('DELETE FROM vacancies WHERE id = ?'),
    keys: (table, key) => sqlite.prepare(`SELECT ${key} AS k FROM ${table} ORDER BY rowid`).all().map((r) => r.k),
  };
}
function writeSetup(st, s) {
  st.setup.run({ org_id: s.orgId, formation: s.formation, planning_horizon: s.planningHorizon, updated_at: s.updatedAt, updated_by_name: s.updatedBy });
  // Roles diff BY ID: kept rows are updated in place (their vacancies and shadow entries keep role_id), new ones
  // inserted, dropped ones deleted (role_id → null on what named them).
  const keep = new Set(s.roles.map((r) => r.id));
  for (const r of st.rolesOf.all(s.orgId)) if (!keep.has(r.id)) { st.criteriaDel.run(r.id); st.roleDel.run(r.id); }
  s.roles.forEach((r, i) => {
    st.role.run({ id: r.id, org_id: s.orgId, ordinal: i, name: r.name, position_group: r.positionGroup, description: r.description, category: r.category });
    st.criteriaDel.run(r.id);
    for (const kind of ['required', 'preferred']) r[kind].forEach((c, j) => st.criterion.run(r.id, kind, j, c.key, typeof c.value === 'number' ? c.value : null, typeof c.value === 'string' ? c.value : null));
  });
  st.windowsDel.run(s.orgId);
  s.windows.forEach((w, i) => st.window.run(s.orgId, i, w.name, w.opens, w.closes));
}
const writeSquad = (st, m) => st.squad.run({ id: m.id, org_id: m.orgId, player_id: m.playerId, name: m.name, position: m.position, source: m.source, approved_by_label: m.approvedBy, added_at: m.addedAt });
const writeShadow = (st, s) => st.shadow.run({ id: s.id, org_id: s.orgId, player_id: s.playerId, name: s.name, role_id: s.roleId, added_by_name: s.addedBy, added_at: s.addedAt });
function writeLookingFor(st, l) { st.lookingForDel.run(l.orgId); l.positions.forEach((p, i) => st.lookingFor.run(l.orgId, i, p)); }
const writeFederation = (st, f) => st.federation.run({ org_id: f.orgId, federation: f.federation, registration_id: f.registrationId, contact_email: f.contactEmail, status: f.status, submitted_at: f.submittedAt });
const writeVacancy = (st, v) => st.vacancy.run({ id: v.id, org_id: v.orgId, role_id: v.roleId, role_name: v.roleName, window_name: v.window, notes: v.notes, status: v.status, created_by_name: v.createdBy, created_at: v.createdAt, closed_at: v.closedAt });
const WRITERS = { tacticalSetups: writeSetup, squadMembers: writeSquad, shadowPlayers: writeShadow, lookingFor: writeLookingFor, federationChecks: writeFederation, vacancies: writeVacancy };

function decodeSetup(st, row) {
  if (!row) return null;
  const criteria = new Map();
  for (const c of st.criteriaOf.all(row.org_id)) {
    const k = `${c.role_id}/${c.kind}`; if (!criteria.has(k)) criteria.set(k, []);
    criteria.get(k).push({ key: c.key, value: c.value_number ?? c.value_text });
  }
  return {
    orgId: row.org_id, formation: row.formation, planningHorizon: row.planning_horizon,
    windows: st.windowsOf.all(row.org_id).map((w) => ({ name: w.name, opens: w.opens, closes: w.closes })),
    roles: st.rolesOf.all(row.org_id).map((r) => ({ id: r.id, name: r.name, positionGroup: r.position_group, description: r.description, category: r.category, required: criteria.get(`${r.id}/required`) ?? [], preferred: criteria.get(`${r.id}/preferred`) ?? [] })),
    updatedAt: row.updated_at, updatedBy: row.updated_by_name,
  };
}
const decodeSquad = (r) => ({ id: r.id, orgId: r.org_id, playerId: r.player_id, name: r.name, position: r.position, source: r.source, approvedBy: r.approved_by_label, addedAt: r.added_at });
const decodeShadow = (r) => ({ id: r.id, orgId: r.org_id, playerId: r.player_id, name: r.name, roleId: r.role_id, addedBy: r.added_by_name, addedAt: r.added_at });
const decodeFederation = (r) => (r ? { orgId: r.org_id, federation: r.federation, registrationId: r.registration_id, contactEmail: r.contact_email, status: r.status, submittedAt: r.submitted_at } : null);
const decodeVacancy = (r) => ({ id: r.id, orgId: r.org_id, roleId: r.role_id, roleName: r.role_name, window: r.window_name, notes: r.notes, status: r.status, createdBy: r.created_by_name, createdAt: r.created_at, closedAt: r.closed_at });

// ------------------------------------------------------------------ the rules the code keeps, named with ids before the engine would
function checkRecords(sqlite, typed, label) {
  const problems = [];
  const orgs = new Set(sqlite.prepare('SELECT id FROM orgs').all().map((r) => r.id));
  const roleOrg = new Map();
  for (const s of typed.tacticalSetups) for (const r of s.roles) {
    if (roleOrg.has(r.id)) problems.push(`role ${r.id} is in two setups (${roleOrg.get(r.id)} and ${s.orgId})`);
    roleOrg.set(r.id, s.orgId);
  }
  for (const name of CLUB_SETUP_COLLECTIONS) for (const rec of typed[name]) if (!orgs.has(rec.orgId)) problems.push(`${name} ${rec[KEY_OF[name]]} → orgs ${rec.orgId}`);
  for (const name of ['shadowPlayers', 'vacancies']) for (const rec of typed[name]) {
    if (rec.roleId && roleOrg.has(rec.roleId) && roleOrg.get(rec.roleId) !== rec.orgId) problems.push(`${name} ${rec.id} roleId ${rec.roleId} belongs to another organisation`);
  }
  if (problems.length) throw refusal('CLUB_SETUP_REFERENCE_MISSING', `${problems.length} reference(s) in ${label} are not valid (${ids(problems)}); the write was rolled back and nothing was changed`, { rows: problems });
  const unique = []; const seen = new Map();
  const once = (key, what) => { if (seen.has(key)) unique.push(`${what} (${seen.get(key)} and ${what})`); else seen.set(key, what); };
  for (const m of typed.squadMembers) if (m.playerId) once(`squad/${m.orgId}/${m.playerId}`, `one squad row per organisation and player: ${m.id}`);
  for (const s of typed.shadowPlayers) once(`shadow/${s.orgId}/${s.playerId}`, `one shadow entry per organisation and player: ${s.id}`);
  if (unique.length) throw refusal('CLUB_SETUP_UNIQUENESS', `${unique.length} rule(s) violated in ${label}: ${ids(unique)}; the write was rolled back and nothing was changed`, { rows: unique });
}
function typeCollections(supplied, label) {
  const typed = {};
  for (const name of CLUB_SETUP_COLLECTIONS) {
    const list = supplied[name]; typed[name] = [];
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw refusal('CLUB_SETUP_IMPORT_BLOCKED', `the ${name} collection of ${label} must be an array of entries (got ${describe(list)})`);
    const seen = new Set();
    list.forEach((raw, i) => {
      const t = TYPERS[name](raw, `${name} entry #${i}`);
      if (!t.ok) throw refusal('CLUB_SETUP_IMPORT_BLOCKED', `${label}: ${t.reason}`);
      const key = t.record[KEY_OF[name]];
      if (seen.has(key)) throw refusal('CLUB_SETUP_IMPORT_BLOCKED', `${label}: ${name} entry #${i} duplicates the key of an earlier entry (${key})`);
      seen.add(key); typed[name].push(t.record);
    });
  }
  return typed;
}
export const clubSetupLive = (sqlite) => migrationApplied(sqlite, CLUB_SETUP_MIGRATION);
const PLAYER_REFS_SQL = 'SELECT player_id AS pid FROM org_squad_members WHERE player_id IS NOT NULL UNION ALL SELECT player_id FROM org_shadow_players';
export const unresolvedPlayerReferences = (sqlite) => (clubSetupLive(sqlite) ? { squad: sqlite.prepare(`SELECT count(*) AS n FROM (${PLAYER_REFS_SQL}) x WHERE NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid)`).get().n } : null);
export const retainedPlayerReferences = (sqlite) => (clubSetupLive(sqlite) ? { squad: sqlite.prepare(`SELECT count(*) AS n FROM (${PLAYER_REFS_SQL}) x WHERE EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid AND p.deleted_at IS NOT NULL)`).get().n } : null);

function readAll(sqlite) {
  const st = statements(sqlite);
  return {
    tacticalSetups: sqlite.prepare('SELECT * FROM org_tactical_setups ORDER BY rowid').all().map((r) => decodeSetup(st, r)),
    squadMembers: sqlite.prepare('SELECT * FROM org_squad_members ORDER BY rowid').all().map(decodeSquad),
    shadowPlayers: sqlite.prepare('SELECT * FROM org_shadow_players ORDER BY rowid').all().map(decodeShadow),
    lookingFor: sqlite.prepare('SELECT DISTINCT org_id FROM org_looking_for ORDER BY org_id').all().map((r) => ({ orgId: r.org_id, positions: st.lookingForOf.all(r.org_id).map((x) => x.position) })),
    federationChecks: sqlite.prepare('SELECT * FROM org_federation_checks ORDER BY rowid').all().map(decodeFederation),
    vacancies: sqlite.prepare('SELECT * FROM vacancies ORDER BY rowid').all().map(decodeVacancy),
  };
}

/**
 * Whole-snapshot access (readTableBacked / writeTableBacked). A supplied collection IS the whole final collection;
 * an omitted one is kept whole. Every record is typed (junk refused with ids) and every reference and uniqueness rule
 * of the FINAL combined state is named before the engine would. Written after the organisations are upserted and
 * before they are pruned.
 */
export const CLUB_SETUP_SNAPSHOT = {
  names: CLUB_SETUP_COLLECTIONS,
  read(sqlite) { return clubSetupLive(sqlite) ? readAll(sqlite) : null; },
  replace(sqlite, db, { label = 'the snapshot (club setup: tactical setups, squads, shadow lists, looking-for, federation checks, vacancies)' } = {}) {
    if (!clubSetupLive(sqlite)) return [];
    const supplied = Object.fromEntries(CLUB_SETUP_COLLECTIONS.map((n) => [n, Object.hasOwn(db, n) ? db[n] : undefined]));
    const written = CLUB_SETUP_COLLECTIONS.filter((n) => supplied[n] !== undefined);
    if (!written.length) return [];
    const typed = typeCollections(supplied, label);
    const stored = readAll(sqlite);
    const final = Object.fromEntries(CLUB_SETUP_COLLECTIONS.map((n) => [n, supplied[n] === undefined ? stored[n] : typed[n]]));
    checkRecords(sqlite, final, label);
    const st = statements(sqlite);
    if (supplied.tacticalSetups !== undefined) {
      const keep = new Set(typed.tacticalSetups.map((s) => s.orgId));
      // A setup the snapshot no longer lists goes with its roles, criteria and windows (CASCADE); what named a role keeps its row with role_id null.
      for (const orgId of st.keys('org_tactical_setups', 'org_id').filter((k) => !keep.has(k))) st.setupDel.run(orgId);
      for (const s of typed.tacticalSetups) writeSetup(st, s);
    }
    const plain = [['squadMembers', 'org_squad_members', 'id', st.squadDel], ['shadowPlayers', 'org_shadow_players', 'id', st.shadowDel], ['federationChecks', 'org_federation_checks', 'org_id', st.federationDel], ['vacancies', 'vacancies', 'id', st.vacancyDel]];
    for (const [name, table, key, del] of plain) {
      if (supplied[name] === undefined) continue;
      const keep = new Set(typed[name].map((r) => r[KEY_OF[name]]));
      for (const k of st.keys(table, key).filter((x) => !keep.has(x))) del.run(k);
      for (const r of typed[name]) WRITERS[name](st, r);
    }
    if (supplied.lookingFor !== undefined) {
      sqlite.prepare('DELETE FROM org_looking_for').run();
      for (const l of typed.lookingFor) writeLookingFor(st, l);
    }
    return written;
  },
  assert(sqlite, { label = 'the snapshot (club setup)' } = {}) {
    if (!clubSetupLive(sqlite)) return;
    for (const t of CLUB_SETUP_TABLES) {
      const broken = sqlite.prepare(`PRAGMA foreign_key_check(${t})`).all();
      if (broken.length) throw refusal('CLUB_SETUP_KEY_VIOLATION', `${label}: ${t} holds ${broken.length} row(s) whose reference is not there (first: rowid ${broken[0].rowid} → ${broken[0].parent}); the write was rolled back`);
    }
  },
};

// ------------------------------------------------------------------ the repository
/**
 * `createClubSetupRepository({ sqlite, unit, now, log })`: `tactical`, `squad`, `shadow`, `lookingFor`, `federation`
 * and `vacancies`, each with its writes and queries, plus `reads` (the queries alone, for `scoutingReads`).
 */
export function createClubSetupRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the club setup repository needs a SQLite connection (node:sqlite)');
  const st = statements(sqlite);
  const operation = (fn) => (unit?.active?.() ? unit.join(fn) : sqlite.isTransaction ? fn() : transaction(sqlite, fn));
  const typedOr = (name, raw) => { const t = TYPERS[name](raw, name); if (!t.ok) throw refusal('CLUB_SETUP_INPUT_INVALID', t.reason); return t.record; };
  const freezeAll = (rows, decode) => rows.map((r) => deepFreeze(decode(r)));
  const q = (sql) => sqlite.prepare(sql);
  const roleOrgOr = (roleId, orgId, what) => {
    if (roleId === null) return;
    const owner = st.roleOwner.get(roleId);
    if (!owner || owner.org_id !== orgId) throw refusal('CLUB_SETUP_INPUT_INVALID', `${what}: role ${roleId} is not a role of organisation ${orgId}`);
  };

  const setupFor = (orgId) => (typeof orgId === 'string' ? deepFreeze(decodeSetup(st, st.setupOf.get(orgId))) : null);
  const tactical = {
    /**
     * Save a club's whole setup. A role id must be new (not a role of any organisation) or one of THIS club's
     * current roles; the routes mint new ids. Returns the stored setup.
     */
    save: (raw) => operation(() => {
      const s = typedOr('tacticalSetups', raw);
      for (const r of s.roles) { const owner = st.roleOwner.get(r.id); if (owner && owner.org_id !== s.orgId) throw refusal('CLUB_SETUP_INPUT_INVALID', `tacticalSetups ${s.orgId}: role ${r.id} belongs to another organisation`); }
      writeSetup(st, s); return setupFor(s.orgId);
    }),
    forOrg: setupFor,
    /** One of the club's current roles, or null. */
    roleOf: (orgId, roleId) => setupFor(orgId)?.roles.find((r) => r.id === roleId) ?? null,
    /** The ids of the club's current roles. */
    roleIds: (orgId) => st.rolesOf.all(orgId).map((r) => r.id),
  };

  const squadOf = q('SELECT * FROM org_squad_members WHERE org_id = ? ORDER BY rowid');
  const squadForPlayer = q('SELECT * FROM org_squad_members WHERE player_id = ? ORDER BY rowid');
  const squadHas = q('SELECT 1 FROM org_squad_members WHERE org_id = ? AND player_id = ?');
  const squad = {
    /** Add a row. A player already on this club's squad is refused (CLUB_SETUP_UNIQUENESS); callers check first. */
    create: (raw) => operation(() => {
      const m = typedOr('squadMembers', raw);
      if (st.squadById.get(m.id)) throw refusal('CLUB_SETUP_DUPLICATE', `org_squad_members ${m.id} already exists`);
      if (m.playerId && squadHas.get(m.orgId, m.playerId)) throw refusal('CLUB_SETUP_UNIQUENESS', `org_squad_members: organisation ${m.orgId} already has player ${m.playerId} on its squad`);
      writeSquad(st, m); return deepFreeze(decodeSquad(st.squadById.get(m.id)));
    }),
    /** Remove a row (a release). Returns true when there was one. */
    remove: (id) => operation(() => st.squadDel.run(id).changes > 0),
    byId: (id) => { const r = typeof id === 'string' ? st.squadById.get(id) : null; return r ? deepFreeze(decodeSquad(r)) : null; },
    forOrg: (orgId) => freezeAll(squadOf.all(orgId), decodeSquad),
    /** Every club's row for `playerId` (the passport, the Trust score, Second Look). */
    forPlayer: (playerId) => freezeAll(squadForPlayer.all(playerId), decodeSquad),
    has: (orgId, playerId) => typeof playerId === 'string' && !!squadHas.get(orgId, playerId),
    /** The on-platform player ids on the club's squad. */
    playerIds: (orgId) => q('SELECT player_id FROM org_squad_members WHERE org_id = ? AND player_id IS NOT NULL ORDER BY rowid').all(orgId).map((r) => r.player_id),
  };

  const shadowOf = q('SELECT * FROM org_shadow_players WHERE org_id = ? ORDER BY rowid');
  const shadowHas = q('SELECT 1 FROM org_shadow_players WHERE org_id = ? AND player_id = ?');
  const shadow = {
    create: (raw) => operation(() => {
      const s = typedOr('shadowPlayers', raw);
      if (st.shadowById.get(s.id)) throw refusal('CLUB_SETUP_DUPLICATE', `org_shadow_players ${s.id} already exists`);
      if (shadowHas.get(s.orgId, s.playerId)) throw refusal('CLUB_SETUP_UNIQUENESS', `org_shadow_players: organisation ${s.orgId} already shadows player ${s.playerId}`);
      roleOrgOr(s.roleId, s.orgId, `org_shadow_players ${s.id}`);
      writeShadow(st, s); return deepFreeze(decodeShadow(st.shadowById.get(s.id)));
    }),
    forOrg: (orgId) => freezeAll(shadowOf.all(orgId), decodeShadow),
    has: (orgId, playerId) => typeof playerId === 'string' && !!shadowHas.get(orgId, playerId),
  };

  const lookingFor = {
    /** Replace the club's list. Returns the stored positions. */
    set: (orgId, positions) => operation(() => { const l = typedOr('lookingFor', { orgId, positions }); writeLookingFor(st, l); return Object.freeze(st.lookingForOf.all(orgId).map((r) => r.position)); }),
    forOrg: (orgId) => Object.freeze(st.lookingForOf.all(orgId).map((r) => r.position)),
  };

  const federation = {
    /** Record (or replace) the club's federation-route request. */
    submit: (raw) => operation(() => { const f = typedOr('federationChecks', raw); writeFederation(st, f); return deepFreeze(decodeFederation(st.federationOf.get(f.orgId))); }),
    forOrg: (orgId) => deepFreeze(decodeFederation(st.federationOf.get(orgId))),
  };

  const vacancyPage = q('SELECT rowid AS rid, * FROM vacancies WHERE org_id = ? AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?');
  const updating = new Set();
  const vacancyOr = (id) => { const r = typeof id === 'string' ? st.vacancyById.get(id) : null; if (!r) throw refusal('CLUB_SETUP_NOT_FOUND', `vacancies ${id} is not a record of the repository`); return deepFreeze(decodeVacancy(r)); };
  const vacancies = {
    create: (raw) => operation(() => {
      const v = typedOr('vacancies', raw);
      if (st.vacancyById.get(v.id)) throw refusal('CLUB_SETUP_DUPLICATE', `vacancies ${v.id} already exists`);
      roleOrgOr(v.roleId, v.orgId, `vacancies ${v.id}`);
      writeVacancy(st, v); return vacancyOr(v.id);
    }),
    /** `update(id, (draft) => …)`: typed whole; the id, organisation, role and creation facts cannot change. */
    update(id, change) {
      if (typeof change !== 'function') throw new TypeError('vacancies.update(id, change) needs a function that edits the copy it is given');
      if (updating.has(id)) throw refusal('CLUB_SETUP_NESTED_UPDATE', `vacancies ${id} is already being updated; make the second change after the first returns`);
      updating.add(id);
      try {
        return operation(() => {
          const stored = vacancyOr(id); const draft = clone(stored); const returned = change(draft);
          const next = typedOr('vacancies', returned === undefined ? draft : returned);
          for (const k of ['id', 'orgId', 'roleId', 'roleName', 'createdBy', 'createdAt']) if (next[k] !== stored[k]) throw refusal('CLUB_SETUP_INPUT_INVALID', `vacancies ${id}: ${k} cannot change`);
          writeVacancy(st, next); return vacancyOr(id);
        });
      } finally { updating.delete(id); }
    },
    byId: (id) => { const r = typeof id === 'string' ? st.vacancyById.get(id) : null; return r ? deepFreeze(decodeVacancy(r)) : null; },
    /** The vacancy `id` if it belongs to `orgId`, else null. */
    ofOrg: (id, orgId) => { const v = vacancies.byId(id); return v && v.orgId === orgId ? v : null; },
    openForOrg: (orgId) => freezeAll(q("SELECT * FROM vacancies WHERE org_id = ? AND status = 'open' ORDER BY rowid").all(orgId), decodeVacancy),
    /** The club's vacancies, newest first, by cursor (`after` is the previous page's last `[rowid]`). */
    page(orgId, { limit, after = null }) {
      const rows = vacancyPage.all(orgId, after?.[0] ?? null, after?.[0] ?? null, limit + 1);
      return { rows: rows.map((r) => ({ key: [r.rid], vacancy: deepFreeze(decodeVacancy(r)) })) };
    },
  };

  const WRITE_OPS = new Set(['save', 'create', 'update', 'remove', 'set', 'submit']);
  const readOnly = (o) => Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => !WRITE_OPS.has(k))));
  const counters = Object.fromEntries(CLUB_SETUP_TABLES.map((t) => [t, q(`SELECT COUNT(*) AS n FROM ${t}`)]));
  return {
    tactical, squad, shadow, lookingFor, federation, vacancies,
    /** The queries alone, for modules and projectors that must not write (`scoutingReads`). */
    reads: Object.freeze({ tacticalSetups: readOnly(tactical), squad: readOnly(squad), shadow: readOnly(shadow), lookingFor: readOnly(lookingFor), federationChecks: readOnly(federation), vacancies: readOnly(vacancies) }),
    attach() {
      if (!clubSetupLive(sqlite)) throw new Error(`the club setup repository needs ${CLUB_SETUP_MIGRATION} recorded; it never imports an in-memory array`);
      return { counts: this.counts() };
    },
    counts() { return Object.fromEntries(CLUB_SETUP_TABLES.map((t) => [t, counters[t].get().n])); },
    pending: () => 0,
    exportAll() { return CLUB_SETUP_SNAPSHOT.read(sqlite); },
    log,
    now,
  };
}
