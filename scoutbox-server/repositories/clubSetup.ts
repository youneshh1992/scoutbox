/**
 * A club's own setup: the tactical setup (roles with their criteria, transfer windows), the squad, the shadow list,
 * what a grassroots club is looking for, the federation-route verification request, and role vacancies. Writing any of
 * the first four on an organisation record is refused, naming this repository (repositories/orgs.ts).
 *
 * Records (the keys every reader sees): `TacticalSetup`, `SquadMember`, `ShadowPlayer`, `FederationCheck` and
 * `Vacancy` below, deep-frozen as read back; a club's looking-for list reads back as its positions.
 *
 * The shadow list is its own table (org_shadow_players), not a kind of squad row: a club considering a player for a
 * role is not that player's club. Nothing that reads "on this club's squad" (the grassroots squad, match-day
 * attendance, release, the passport's club relationships, the Trust score, Second Look) sees a shadow entry.
 *
 * Writes are typed whole; a record the columns cannot hold is refused with its id (the routes check first and answer
 * 400). Each joins the open unit of work, the caller's transaction, or a transaction of its own. The typers take
 * `unknown`, so a caller still in JavaScript can pass anything: the typer and the columns judge it.
 *   tactical.save(setup)        — upserts the setup and diffs its roles BY ID: a kept role keeps its row (so its
 *                                 vacancies and shadow entries keep their role), a new role is inserted, a dropped
 *                                 role is deleted (their role_id becomes null; the candidates route answers
 *                                 409 ROLE_DELETED).
 *   squad.create / squad.remove, shadow.create, lookingFor.set, federation.submit, vacancies.create / close.
 *
 * Reads return deep-frozen records. Modules receive the queries through `scoutingReads` (tacticalSetups, squad,
 * shadow, lookingFor, federationChecks, vacancies).
 *
 * References. Player ids have NO foreign key (tolerant, like recruitment and the evidence passport: a squad row
 * outlives the account). org_id → orgs is RESTRICT (organisations are never deleted, O2 in docs/decisions.md). A
 * role's org is its setup (CASCADE children); vacancies.role_id and org_shadow_players.role_id → org_tactical_roles
 * are ON DELETE SET NULL (the documented "role deleted" state); that a role belongs to the same organisation is
 * checked here.
 */
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import { isPlainObject, describe } from './fieldSpecs.ts';
import { migrationApplied, operationOn, type UnitParticipant } from './database.ts';
import { readsOf } from './identityRules.ts';
import { columnsOf, insertFor, type Flatten, type InputFor, type RowOf } from './writes.ts';
import {
  txt,
  refusal,
  isInt,
  isStr,
  nonEmpty,
  orNull,
  bad,
  optText,
  reqText,
  optInstant,
  reqInstant,
  unknownFields,
  first,
  type Bad,
  type Typed,
} from './scoutingEvidence.ts';
import { deepFreeze, type DeepReadonly } from '../domains/platform/values.ts';
import {
  PLAYER_POSITIONS,
  PLAYER_FEET,
  PLAYER_AVAILABILITY,
  PLAYER_LEVELS,
  type PlayerAvailability,
  type PlayerFoot,
  type PlayerLevel,
  type PlayerPosition,
} from './playerRecord.ts';
import { parseStrictDateOnly } from '../temporal.ts';

export const CLUB_SETUP_MIGRATION = '0021_club_setup';
export const CLUB_SETUP_COLLECTIONS = Object.freeze([
  'tacticalSetups',
  'squadMembers',
  'shadowPlayers',
  'lookingFor',
  'federationChecks',
  'vacancies',
] as const);
export type ClubSetupCollection = (typeof CLUB_SETUP_COLLECTIONS)[number];
export const CLUB_SETUP_TABLES = Object.freeze([
  'org_tactical_setups',
  'org_tactical_roles',
  'org_tactical_role_criteria',
  'org_tactical_windows',
  'org_squad_members',
  'org_shadow_players',
  'org_looking_for',
  'org_federation_checks',
  'vacancies',
] as const);
export type ClubSetupTable = (typeof CLUB_SETUP_TABLES)[number];

// ------------------------------------------------------------------ vocabulary
export const ROLE_POSITION_GROUPS = Object.freeze(['GK', 'DEF', 'MID', 'ATT'] as const);
export const ROLE_CATEGORIES = Object.freeze(['mens', 'womens', 'boys', 'girls', 'mixed'] as const);
export const CRITERIA_KEYS = Object.freeze([
  'positionGroup',
  'minAge',
  'maxAge',
  'foot',
  'availability',
  'maxLevel',
  'minAppearances',
  'category',
] as const);
export type RolePositionGroup = (typeof ROLE_POSITION_GROUPS)[number];
export type RoleCategory = (typeof ROLE_CATEGORIES)[number];
export type CriterionKey = (typeof CRITERIA_KEYS)[number];
type Range = { readonly min: number; readonly max: number };
/** What each criterion's value may be: a vocabulary (text) or a whole-number range. */
export const CRITERIA_VALUES = Object.freeze({
  positionGroup: ROLE_POSITION_GROUPS,
  foot: PLAYER_FEET,
  availability: PLAYER_AVAILABILITY,
  maxLevel: PLAYER_LEVELS,
  category: ROLE_CATEGORIES,
  minAge: Object.freeze({ min: 5, max: 60 }),
  maxAge: Object.freeze({ min: 5, max: 60 }),
  minAppearances: Object.freeze({ min: 0, max: 1000 }),
} as const satisfies Record<CriterionKey, readonly string[] | Range>);
export const SQUAD_SOURCES = Object.freeze(['manual', 'invite_approved', 'signing'] as const);
export const VACANCY_STATUSES = Object.freeze(['open', 'closed'] as const);
export const LOOKING_FOR_POSITIONS = PLAYER_POSITIONS;
export type SquadSource = (typeof SQUAD_SOURCES)[number];
export type VacancyStatus = (typeof VACANCY_STATUSES)[number];
export type LookingForPosition = PlayerPosition;
/** A role's two lists of criteria, stored as the `kind` of each criterion row. */
const CRITERIA_KINDS = Object.freeze(['required', 'preferred'] as const);
type CriterionKind = (typeof CRITERIA_KINDS)[number];
/** Limits: text over these is shortened by the routes; lists over them are refused. */
export const CLUB_SETUP_LIMITS = Object.freeze({
  formation: 20,
  planningHorizon: 40,
  roles: 15,
  windows: 4,
  criteria: 8,
  roleName: 60,
  description: 300,
  windowName: 40,
  name: 200,
  position: 40,
  approvedBy: 200,
  lookingFor: 5,
  federation: 120,
  registrationId: 60,
  contactEmail: 120,
  notes: 300,
});
const L = CLUB_SETUP_LIMITS;
const inList = (list: readonly string[]) => list.map((v) => `'${v}'`).join(',');

// ------------------------------------------------------------------ records
/** The value each criterion holds: a word of its vocabulary, or a whole number in its range. */
type CriterionValueOf = {
  positionGroup: RolePositionGroup;
  foot: PlayerFoot;
  availability: PlayerAvailability;
  maxLevel: PlayerLevel;
  category: RoleCategory;
  minAge: number;
  maxAge: number;
  minAppearances: number;
};
type CriterionFields = {
  [K in CriterionKey]: { key: K; value: CriterionValueOf[K] };
}[CriterionKey];
type RoleFields = {
  id: string;
  name: string;
  positionGroup: RolePositionGroup;
  /** '' when the club wrote none. */
  description: string;
  category: RoleCategory;
  required: CriterionFields[];
  preferred: CriterionFields[];
};
type WindowFields = {
  /** '' when the club named none. */
  name: string;
  /** A day, YYYY-MM-DD. */
  opens: string | null;
  /** A day, YYYY-MM-DD, not before `opens`. */
  closes: string | null;
};
type TacticalSetupFields = {
  orgId: string;
  formation: string;
  planningHorizon: string | null;
  windows: WindowFields[];
  roles: RoleFields[];
  updatedAt: number;
  /** The name of who saved it. */
  updatedBy: string;
};
type SquadMemberFields = {
  id: string;
  orgId: string;
  /** Null only on a manual row naming someone off the platform. */
  playerId: string | null;
  name: string;
  position: string | null;
  source: SquadSource;
  /** Who approved the invitation: set exactly on an `invite_approved` row. */
  approvedBy: string | null;
  addedAt: number;
};
type ShadowPlayerFields = {
  id: string;
  orgId: string;
  playerId: string;
  name: string;
  /** Null once the role it was shadowed for is deleted. */
  roleId: string | null;
  addedBy: string;
  addedAt: number;
};
type LookingForFields = { orgId: string; positions: LookingForPosition[] };
type FederationCheckFields = {
  orgId: string;
  federation: string;
  registrationId: string;
  contactEmail: string | null;
  status: 'pending';
  submittedAt: number;
};
type VacancyFields = {
  id: string;
  orgId: string;
  /** Null once the role it was opened for is deleted. */
  roleId: string | null;
  roleName: string;
  window: string | null;
  notes: string | null;
  status: VacancyStatus;
  createdBy: string;
  createdAt: number;
  /** Set exactly when the vacancy is closed. */
  closedAt: number | null;
};
export type RoleCriterion = DeepReadonly<CriterionFields>;
export type TacticalRole = DeepReadonly<RoleFields>;
export type TacticalWindow = DeepReadonly<WindowFields>;
export type TacticalSetup = DeepReadonly<TacticalSetupFields>;
export type SquadMember = DeepReadonly<SquadMemberFields>;
export type ShadowPlayer = DeepReadonly<ShadowPlayerFields>;
export type LookingFor = DeepReadonly<LookingForFields>;
export type FederationCheck = DeepReadonly<FederationCheckFields>;
export type Vacancy = DeepReadonly<VacancyFields>;
type FieldsOf = {
  tacticalSetups: TacticalSetupFields;
  squadMembers: SquadMemberFields;
  shadowPlayers: ShadowPlayerFields;
  lookingFor: LookingForFields;
  federationChecks: FederationCheckFields;
  vacancies: VacancyFields;
};
type RecordOf = { [N in ClubSetupCollection]: DeepReadonly<FieldsOf[N]> };
export type ClubSetupRecords = { [N in ClubSetupCollection]: RecordOf[N][] };

// ------------------------------------------------------------------ inputs (what the typers accept)
export type RoleCriterionInput = CriterionFields;
export type TacticalRoleInput = Flatten<Omit<InputFor<RoleFields>, 'description'> & { description?: string | null }>;
export type TacticalWindowInput = Flatten<Omit<InputFor<WindowFields>, 'name'> & { name?: string | null }>;
/** A setup names its roles, even when there are none. */
export type TacticalSetupInput = Flatten<
  Omit<InputFor<TacticalSetupFields>, 'roles' | 'windows'> & {
    roles: TacticalRoleInput[];
    windows?: TacticalWindowInput[] | null;
  }
>;
export type SquadMemberInput = InputFor<SquadMemberFields>;
export type ShadowPlayerInput = InputFor<ShadowPlayerFields>;
export type LookingForInput = LookingForFields;
export type FederationCheckInput = InputFor<FederationCheckFields>;
export type VacancyInput = InputFor<VacancyFields>;

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
// Each typer checks the value field by field, then reads it as the input it has just been checked to be.
const dayOnly = (v: unknown): v is string => isStr(v) && parseStrictDateOnly(v).ok; // one definition of a calendar day (temporal.ts)
const oneOf = <T>(list: readonly T[], v: unknown): v is T => (list as readonly unknown[]).includes(v);
const objectAt = (raw: unknown, at: string): Bad => ({
  ok: false,
  reason: `${at} is not an object (${describe(raw)})`,
});
const optDay = (rec: Record<string, unknown>, at: string, field: string): Bad | null =>
  rec[field] === undefined || rec[field] === null || dayOnly(rec[field])
    ? null
    : bad(at, field, `must be a YYYY-MM-DD day or null (got ${describe(rec[field])})`);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** One criterion `{ key, value }`: the key one of CRITERIA_KEYS, the value in that key's vocabulary or range. */
export function typeCriterion(c: unknown, at: string): Typed<CriterionFields> {
  if (!isPlainObject(c)) return objectAt(c, at);
  const u = unknownFields(c, at, ['key', 'value']);
  if (u) return u;
  if (!oneOf(CRITERIA_KEYS, c.key))
    return bad(at, 'key', `must be one of ${CRITERIA_KEYS.join('|')} (got ${describe(c.key)})`);
  const rule: readonly string[] | Range = CRITERIA_VALUES[c.key];
  if (!('min' in rule)) {
    if (!oneOf(rule, c.value))
      return bad(at, 'value', `must be one of ${rule.join('|')} for ${c.key} (got ${describe(c.value)})`);
  } else if (!isInt(c.value) || c.value < rule.min || c.value > rule.max)
    return bad(
      at,
      'value',
      `must be a whole number from ${rule.min} to ${rule.max} for ${c.key} (got ${describe(c.value)})`,
    );
  return {
    ok: true,
    record: { key: c.key, value: c.value } as CriterionFields,
  };
}
function typeCriteria(list: unknown, at: string): { ok: true; list: CriterionFields[] } | Bad {
  if (list === undefined || list === null) return { ok: true, list: [] };
  if (!Array.isArray(list))
    return {
      ok: false,
      reason: `${at} must be an array (got ${describe(list)})`,
    };
  if (list.length > L.criteria) return bad(at, '', `holds more than ${L.criteria} criteria`);
  const out: CriterionFields[] = [];
  const seen = new Set<CriterionKey>();
  for (let i = 0; i < list.length; i++) {
    const t = typeCriterion(list[i], `${at}[${i}]`);
    if (!t.ok) return t;
    if (seen.has(t.record.key)) return bad(`${at}[${i}]`, 'key', `repeats ${t.record.key}`);
    seen.add(t.record.key);
    out.push(t.record);
  }
  return { ok: true, list: out };
}
const ROLE_FIELDS = [
  'id',
  'name',
  'positionGroup',
  'description',
  'category',
  'required',
  'preferred',
] as const satisfies readonly (keyof RoleFields)[];
export function typeRole(r: unknown, at: string): Typed<RoleFields> {
  if (!isPlainObject(r)) return objectAt(r, at);
  const problem = first(
    unknownFields(r, at, ROLE_FIELDS),
    reqText(r, at, 'id', 80),
    reqText(r, at, 'name', L.roleName),
    optText(r, at, 'description', L.description),
  );
  if (problem) return problem;
  if (!oneOf(ROLE_POSITION_GROUPS, r.positionGroup))
    return bad(
      at,
      'positionGroup',
      `must be one of ${ROLE_POSITION_GROUPS.join('|')} (got ${describe(r.positionGroup)})`,
    );
  if (!oneOf(ROLE_CATEGORIES, r.category))
    return bad(at, 'category', `must be one of ${ROLE_CATEGORIES.join('|')} (got ${describe(r.category)})`);
  const required = typeCriteria(r.required, `${at}.required`);
  if (!required.ok) return required;
  const preferred = typeCriteria(r.preferred, `${at}.preferred`);
  if (!preferred.ok) return preferred;
  const age = (k: 'minAge' | 'maxAge') => required.list.find((c) => c.key === k)?.value as number | undefined;
  const minAge = age('minAge');
  const maxAge = age('maxAge');
  if (minAge !== undefined && maxAge !== undefined && minAge > maxAge)
    return bad(`${at}.required`, 'maxAge', 'is below minAge (the role could match nobody)');
  const v = r as TacticalRoleInput;
  return {
    ok: true,
    record: {
      id: v.id,
      name: v.name,
      positionGroup: v.positionGroup,
      description: v.description ?? '',
      category: v.category,
      required: required.list,
      preferred: preferred.list,
    },
  };
}
export function typeWindow(w: unknown, at: string): Typed<WindowFields> {
  if (!isPlainObject(w)) return objectAt(w, at);
  const problem = first(
    unknownFields(w, at, ['name', 'opens', 'closes'] satisfies (keyof WindowFields)[]),
    optText(w, at, 'name', L.windowName),
    optDay(w, at, 'opens'),
    optDay(w, at, 'closes'),
  );
  if (problem) return problem;
  const v = w as TacticalWindowInput;
  if (v.opens && v.closes && v.opens > v.closes) return bad(at, 'closes', 'is before opens');
  return {
    ok: true,
    record: {
      name: v.name ?? '',
      opens: orNull(v.opens),
      closes: orNull(v.closes),
    },
  };
}
const SETUP_FIELDS = [
  'orgId',
  'formation',
  'planningHorizon',
  'windows',
  'roles',
  'updatedAt',
  'updatedBy',
] as const satisfies readonly (keyof TacticalSetupFields)[];
/** A tactical setup `{ orgId, formation, planningHorizon, windows, roles, updatedAt, updatedBy }`, typed. */
export function typeTacticalSetup(raw: unknown, at = 'tacticalSetups'): Typed<TacticalSetupFields> {
  if (!isPlainObject(raw)) return objectAt(raw, at);
  if (!nonEmpty(raw.orgId)) return bad(at, 'orgId', 'must be a non-empty string');
  const label = `${at} ${raw.orgId}`;
  const problem = first(
    unknownFields(raw, label, SETUP_FIELDS),
    reqText(raw, label, 'formation', L.formation),
    optText(raw, label, 'planningHorizon', L.planningHorizon),
    reqInstant(raw, label, 'updatedAt'),
    reqText(raw, label, 'updatedBy', L.name),
  );
  if (problem) return problem;
  if (!Array.isArray(raw.roles)) return bad(label, 'roles', `must be an array (got ${describe(raw.roles)})`);
  if (raw.roles.length > L.roles) return bad(label, 'roles', `holds more than ${L.roles} roles`);
  if (raw.windows !== undefined && raw.windows !== null && !Array.isArray(raw.windows))
    return bad(label, 'windows', `must be an array (got ${describe(raw.windows)})`);
  const windowsIn = (raw.windows ?? []) as unknown[];
  if (windowsIn.length > L.windows) return bad(label, 'windows', `holds more than ${L.windows} windows`);
  const roles: RoleFields[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.roles.length; i++) {
    const t = typeRole(raw.roles[i], `${label}.roles[${i}]`);
    if (!t.ok) return t;
    if (seen.has(t.record.id)) return bad(`${label}.roles[${i}]`, 'id', `repeats ${t.record.id}`);
    seen.add(t.record.id);
    roles.push(t.record);
  }
  const windows: WindowFields[] = [];
  for (let i = 0; i < windowsIn.length; i++) {
    const t = typeWindow(windowsIn[i], `${label}.windows[${i}]`);
    if (!t.ok) return t;
    windows.push(t.record);
  }
  const s = raw as TacticalSetupInput;
  return {
    ok: true,
    record: {
      orgId: s.orgId,
      formation: s.formation,
      planningHorizon: orNull(s.planningHorizon),
      windows,
      roles,
      updatedAt: s.updatedAt,
      updatedBy: s.updatedBy,
    },
  };
}
const SQUAD_FIELDS = [
  'id',
  'orgId',
  'playerId',
  'name',
  'position',
  'source',
  'approvedBy',
  'addedAt',
] as const satisfies readonly (keyof SquadMemberFields)[];
export function typeSquadMember(raw: unknown, at = 'squadMembers'): Typed<SquadMemberFields> {
  if (!isPlainObject(raw)) return objectAt(raw, at);
  if (!nonEmpty(raw.id)) return bad(at, 'id', 'must be a non-empty string');
  const label = `${at} ${raw.id}`;
  const problem = first(
    unknownFields(raw, label, SQUAD_FIELDS),
    reqText(raw, label, 'orgId', 80),
    optText(raw, label, 'playerId', 80),
    reqText(raw, label, 'name', L.name),
    optText(raw, label, 'position', L.position),
    optText(raw, label, 'approvedBy', L.approvedBy),
    reqInstant(raw, label, 'addedAt'),
  );
  if (problem) return problem;
  if (!oneOf(SQUAD_SOURCES, raw.source))
    return bad(label, 'source', `must be one of ${SQUAD_SOURCES.join('|')} (got ${describe(raw.source)})`);
  if ((raw.source === 'invite_approved') !== nonEmpty(raw.approvedBy))
    return bad(
      label,
      'approvedBy',
      raw.source === 'invite_approved'
        ? 'is required on an approved invitation'
        : 'belongs to approved invitations only',
    );
  if (raw.source !== 'manual' && !nonEmpty(raw.playerId))
    return bad(label, 'playerId', `is required on a ${raw.source} row`);
  const m = raw as SquadMemberInput;
  return {
    ok: true,
    record: {
      id: m.id,
      orgId: m.orgId,
      // An empty id or position is none at all.
      playerId: m.playerId || null,
      name: m.name,
      position: m.position || null,
      source: m.source,
      approvedBy: orNull(m.approvedBy),
      addedAt: m.addedAt,
    },
  };
}
const SHADOW_FIELDS = [
  'id',
  'orgId',
  'playerId',
  'name',
  'roleId',
  'addedBy',
  'addedAt',
] as const satisfies readonly (keyof ShadowPlayerFields)[];
export function typeShadowPlayer(raw: unknown, at = 'shadowPlayers'): Typed<ShadowPlayerFields> {
  if (!isPlainObject(raw)) return objectAt(raw, at);
  if (!nonEmpty(raw.id)) return bad(at, 'id', 'must be a non-empty string');
  const label = `${at} ${raw.id}`;
  const problem = first(
    unknownFields(raw, label, SHADOW_FIELDS),
    reqText(raw, label, 'orgId', 80),
    reqText(raw, label, 'playerId', 80),
    reqText(raw, label, 'name', L.name),
    optText(raw, label, 'roleId', 80),
    reqText(raw, label, 'addedBy', L.name),
    reqInstant(raw, label, 'addedAt'),
  );
  if (problem) return problem;
  const s = raw as ShadowPlayerInput;
  return {
    ok: true,
    record: {
      id: s.id,
      orgId: s.orgId,
      playerId: s.playerId,
      name: s.name,
      roleId: orNull(s.roleId),
      addedBy: s.addedBy,
      addedAt: s.addedAt,
    },
  };
}
export function typeLookingFor(raw: unknown, at = 'lookingFor'): Typed<LookingForFields> {
  if (!isPlainObject(raw)) return objectAt(raw, at);
  if (!nonEmpty(raw.orgId)) return bad(at, 'orgId', 'must be a non-empty string');
  const label = `${at} ${raw.orgId}`;
  const u = unknownFields(raw, label, ['orgId', 'positions'] satisfies (keyof LookingForFields)[]);
  if (u) return u;
  if (!Array.isArray(raw.positions) || raw.positions.length > L.lookingFor)
    return bad(label, 'positions', `must be a list of at most ${L.lookingFor} positions`);
  for (const [i, p] of raw.positions.entries())
    if (!oneOf(LOOKING_FOR_POSITIONS, p))
      return bad(label, `positions[${i}]`, `must be one of ${LOOKING_FOR_POSITIONS.join('|')} (got ${describe(p)})`);
  if (new Set(raw.positions).size !== raw.positions.length) return bad(label, 'positions', 'names a position twice');
  return {
    ok: true,
    record: {
      orgId: raw.orgId,
      positions: [...(raw.positions as LookingForPosition[])],
    },
  };
}
const FEDERATION_FIELDS = [
  'orgId',
  'federation',
  'registrationId',
  'contactEmail',
  'status',
  'submittedAt',
] as const satisfies readonly (keyof FederationCheckFields)[];
export function typeFederationCheck(raw: unknown, at = 'federationChecks'): Typed<FederationCheckFields> {
  if (!isPlainObject(raw)) return objectAt(raw, at);
  if (!nonEmpty(raw.orgId)) return bad(at, 'orgId', 'must be a non-empty string');
  const label = `${at} ${raw.orgId}`;
  const problem = first(
    unknownFields(raw, label, FEDERATION_FIELDS),
    reqText(raw, label, 'federation', L.federation),
    reqText(raw, label, 'registrationId', L.registrationId),
    optText(raw, label, 'contactEmail', L.contactEmail),
    reqInstant(raw, label, 'submittedAt'),
  );
  if (problem) return problem;
  const f = raw as FederationCheckInput;
  if (f.contactEmail && !EMAIL.test(f.contactEmail))
    return bad(label, 'contactEmail', 'must be an e-mail address or null');
  if (raw.status !== 'pending') return bad(label, 'status', `must be pending (got ${describe(raw.status)})`);
  return {
    ok: true,
    record: {
      orgId: f.orgId,
      federation: f.federation,
      registrationId: f.registrationId,
      contactEmail: orNull(f.contactEmail),
      status: 'pending',
      submittedAt: f.submittedAt,
    },
  };
}
const VACANCY_FIELDS = [
  'id',
  'orgId',
  'roleId',
  'roleName',
  'window',
  'notes',
  'status',
  'createdBy',
  'createdAt',
  'closedAt',
] as const satisfies readonly (keyof VacancyFields)[];
export function typeVacancy(raw: unknown, at = 'vacancies'): Typed<VacancyFields> {
  if (!isPlainObject(raw)) return objectAt(raw, at);
  if (!nonEmpty(raw.id)) return bad(at, 'id', 'must be a non-empty string');
  const label = `${at} ${raw.id}`;
  const problem = first(
    unknownFields(raw, label, VACANCY_FIELDS),
    reqText(raw, label, 'orgId', 80),
    optText(raw, label, 'roleId', 80),
    reqText(raw, label, 'roleName', L.roleName),
    optText(raw, label, 'window', L.windowName),
    optText(raw, label, 'notes', L.notes),
    reqText(raw, label, 'createdBy', L.name),
    reqInstant(raw, label, 'createdAt'),
    optInstant(raw, label, 'closedAt'),
  );
  if (problem) return problem;
  if (!oneOf(VACANCY_STATUSES, raw.status))
    return bad(label, 'status', `must be one of ${VACANCY_STATUSES.join('|')} (got ${describe(raw.status)})`);
  if ((raw.status === 'closed') !== isInt(raw.closedAt))
    return bad(
      label,
      'closedAt',
      raw.status === 'closed' ? 'is required on a closed vacancy' : 'must be null while the vacancy is open',
    );
  const v = raw as VacancyInput;
  return {
    ok: true,
    record: {
      id: v.id,
      orgId: v.orgId,
      roleId: orNull(v.roleId),
      roleName: v.roleName,
      window: orNull(v.window),
      notes: orNull(v.notes),
      status: v.status,
      createdBy: v.createdBy,
      createdAt: v.createdAt,
      closedAt: orNull(v.closedAt),
    },
  };
}
const TYPERS: {
  [N in ClubSetupCollection]: (raw: unknown, at: string) => Typed<FieldsOf[N]>;
} = {
  tacticalSetups: typeTacticalSetup,
  squadMembers: typeSquadMember,
  shadowPlayers: typeShadowPlayer,
  lookingFor: typeLookingFor,
  federationChecks: typeFederationCheck,
  vacancies: typeVacancy,
};

// ------------------------------------------------------------------ rows ↔ records
const setupRow = (s: TacticalSetupFields) => ({
  org_id: s.orgId,
  formation: s.formation,
  planning_horizon: s.planningHorizon,
  updated_at: s.updatedAt,
  updated_by_name: s.updatedBy,
});
type SetupRow = RowOf<typeof setupRow>;
const roleRow = (orgId: string, r: RoleFields, ordinal: number) => ({
  id: r.id,
  org_id: orgId,
  ordinal,
  name: r.name,
  position_group: r.positionGroup,
  description: r.description,
  category: r.category,
});
type RoleRow = RowOf<typeof roleRow>;
const criterionRow = (roleId: string, kind: CriterionKind, c: CriterionFields, ordinal: number) => ({
  role_id: roleId,
  kind,
  ordinal,
  key: c.key,
  value_number: typeof c.value === 'number' ? c.value : null,
  value_text: typeof c.value === 'string' ? c.value : null,
});
type CriterionRow = RowOf<typeof criterionRow>;
const windowRow = (orgId: string, w: WindowFields, ordinal: number) => ({
  org_id: orgId,
  ordinal,
  name: w.name,
  opens: w.opens,
  closes: w.closes,
});
type WindowRow = RowOf<typeof windowRow>;
const squadRow = (m: SquadMemberFields) => ({
  id: m.id,
  org_id: m.orgId,
  player_id: m.playerId,
  name: m.name,
  position: m.position,
  source: m.source,
  approved_by_label: m.approvedBy,
  added_at: m.addedAt,
});
type SquadRow = RowOf<typeof squadRow>;
const shadowRow = (s: ShadowPlayerFields) => ({
  id: s.id,
  org_id: s.orgId,
  player_id: s.playerId,
  name: s.name,
  role_id: s.roleId,
  added_by_name: s.addedBy,
  added_at: s.addedAt,
});
type ShadowRow = RowOf<typeof shadowRow>;
const lookingForRow = (orgId: string, position: LookingForPosition, ordinal: number) => ({
  org_id: orgId,
  ordinal,
  position,
});
type LookingForRow = RowOf<typeof lookingForRow>;
const federationRow = (f: FederationCheckFields) => ({
  org_id: f.orgId,
  federation: f.federation,
  registration_id: f.registrationId,
  contact_email: f.contactEmail,
  status: f.status,
  submitted_at: f.submittedAt,
});
type FederationRow = RowOf<typeof federationRow>;
const vacancyRow = (v: VacancyFields) => ({
  id: v.id,
  org_id: v.orgId,
  role_id: v.roleId,
  role_name: v.roleName,
  window_name: v.window,
  notes: v.notes,
  status: v.status,
  created_by_name: v.createdBy,
  created_at: v.createdAt,
  closed_at: v.closedAt,
});
type VacancyRow = RowOf<typeof vacancyRow>;
const SETUP_COLS = columnsOf<SetupRow>()(['org_id', 'formation', 'planning_horizon', 'updated_at', 'updated_by_name']);
const ROLE_COLS = columnsOf<RoleRow>()([
  'id',
  'org_id',
  'ordinal',
  'name',
  'position_group',
  'description',
  'category',
]);
const CRITERION_COLS = columnsOf<CriterionRow>()(['role_id', 'kind', 'ordinal', 'key', 'value_number', 'value_text']);
const WINDOW_COLS = columnsOf<WindowRow>()(['org_id', 'ordinal', 'name', 'opens', 'closes']);
const SQUAD_COLS = columnsOf<SquadRow>()([
  'id',
  'org_id',
  'player_id',
  'name',
  'position',
  'source',
  'approved_by_label',
  'added_at',
]);
const SHADOW_COLS = columnsOf<ShadowRow>()([
  'id',
  'org_id',
  'player_id',
  'name',
  'role_id',
  'added_by_name',
  'added_at',
]);
const LOOKING_FOR_COLS = columnsOf<LookingForRow>()(['org_id', 'ordinal', 'position']);
const FEDERATION_COLS = columnsOf<FederationRow>()([
  'org_id',
  'federation',
  'registration_id',
  'contact_email',
  'status',
  'submitted_at',
]);
const VACANCY_COLS = columnsOf<VacancyRow>()([
  'id',
  'org_id',
  'role_id',
  'role_name',
  'window_name',
  'notes',
  'status',
  'created_by_name',
  'created_at',
  'closed_at',
]);

/** Prepared statements over one connection. */
function statements(sqlite: DatabaseSync) {
  const p = (sql: string) => sqlite.prepare(sql);
  return {
    // A setup is written by its club, and a kept role by its id, so that what names the role keeps it.
    setup: insertFor(sqlite, 'org_tactical_setups', SETUP_COLS, {
      upsert: ['org_id'],
    }),
    role: insertFor(sqlite, 'org_tactical_roles', ROLE_COLS, {
      upsert: ['id'],
    }),
    roleOwner: p('SELECT org_id FROM org_tactical_roles WHERE id = ?'),
    rolesOf: p('SELECT * FROM org_tactical_roles WHERE org_id = ? ORDER BY ordinal'),
    roleDel: p('DELETE FROM org_tactical_roles WHERE id = ?'),
    criterion: insertFor(sqlite, 'org_tactical_role_criteria', CRITERION_COLS),
    criteriaDel: p('DELETE FROM org_tactical_role_criteria WHERE role_id = ?'),
    criteriaOf: p(
      'SELECT * FROM org_tactical_role_criteria WHERE role_id IN (SELECT id FROM org_tactical_roles WHERE org_id = ?) ORDER BY role_id, kind, ordinal',
    ),
    window: insertFor(sqlite, 'org_tactical_windows', WINDOW_COLS),
    windowsDel: p('DELETE FROM org_tactical_windows WHERE org_id = ?'),
    windowsOf: p('SELECT * FROM org_tactical_windows WHERE org_id = ? ORDER BY ordinal'),
    setupOf: p('SELECT * FROM org_tactical_setups WHERE org_id = ?'),
    setupAll: p('SELECT * FROM org_tactical_setups ORDER BY rowid'),
    squad: insertFor(sqlite, 'org_squad_members', SQUAD_COLS),
    squadById: p('SELECT * FROM org_squad_members WHERE id = ?'),
    squadDel: p('DELETE FROM org_squad_members WHERE id = ?'),
    squadAll: p('SELECT * FROM org_squad_members ORDER BY rowid'),
    shadow: insertFor(sqlite, 'org_shadow_players', SHADOW_COLS),
    shadowById: p('SELECT * FROM org_shadow_players WHERE id = ?'),
    shadowAll: p('SELECT * FROM org_shadow_players ORDER BY rowid'),
    lookingFor: insertFor(sqlite, 'org_looking_for', LOOKING_FOR_COLS),
    lookingForDel: p('DELETE FROM org_looking_for WHERE org_id = ?'),
    lookingForOf: p('SELECT position FROM org_looking_for WHERE org_id = ? ORDER BY ordinal'),
    lookingForOrgs: p('SELECT DISTINCT org_id FROM org_looking_for ORDER BY org_id'),
    // A club has one federation-route request; submitting again replaces it.
    federation: insertFor(sqlite, 'org_federation_checks', FEDERATION_COLS, {
      upsert: ['org_id'],
    }),
    federationOf: p('SELECT * FROM org_federation_checks WHERE org_id = ?'),
    federationAll: p('SELECT * FROM org_federation_checks ORDER BY rowid'),
    vacancy: insertFor(sqlite, 'vacancies', VACANCY_COLS),
    vacancyById: p('SELECT * FROM vacancies WHERE id = ?'),
    vacancyAll: p('SELECT * FROM vacancies ORDER BY rowid'),
    vacancyClose: p(
      "UPDATE vacancies SET status = 'closed', closed_at = @closed_at WHERE id = @id AND status = 'open'",
    ),
  };
}
type Statements = ReturnType<typeof statements>;

function writeSetup(st: Statements, s: TacticalSetupFields) {
  st.setup.run(setupRow(s));
  // Roles diff BY ID: kept rows are updated in place (their vacancies and shadow entries keep role_id), new ones
  // inserted, dropped ones deleted (role_id → null on what named them).
  const keep = new Set(s.roles.map((r) => r.id));
  for (const r of st.rolesOf.all(s.orgId) as RoleRow[])
    if (!keep.has(r.id)) {
      st.criteriaDel.run(r.id);
      st.roleDel.run(r.id);
    }
  s.roles.forEach((r, i) => {
    st.role.run(roleRow(s.orgId, r, i));
    st.criteriaDel.run(r.id);
    for (const kind of CRITERIA_KINDS) r[kind].forEach((c, j) => st.criterion.run(criterionRow(r.id, kind, c, j)));
  });
  st.windowsDel.run(s.orgId);
  s.windows.forEach((w, i) => st.window.run(windowRow(s.orgId, w, i)));
}
function writeLookingFor(st: Statements, l: LookingForFields) {
  st.lookingForDel.run(l.orgId);
  l.positions.forEach((p, i) => st.lookingFor.run(lookingForRow(l.orgId, p, i)));
}

function decodeSetup(st: Statements, row: SetupRow): TacticalSetupFields {
  const criteria = new Map<string, CriterionFields[]>();
  for (const c of st.criteriaOf.all(row.org_id) as CriterionRow[]) {
    const k = `${c.role_id}/${c.kind}`;
    if (!criteria.has(k)) criteria.set(k, []);
    // The columns hold a number exactly for the numeric keys, so the pair is a criterion as typed.
    criteria.get(k)?.push({
      key: c.key,
      value: c.value_number ?? c.value_text,
    } as CriterionFields);
  }
  return {
    orgId: row.org_id,
    formation: row.formation,
    planningHorizon: row.planning_horizon,
    windows: (st.windowsOf.all(row.org_id) as WindowRow[]).map((w) => ({
      name: w.name,
      opens: w.opens,
      closes: w.closes,
    })),
    roles: (st.rolesOf.all(row.org_id) as RoleRow[]).map((r) => ({
      id: r.id,
      name: r.name,
      positionGroup: r.position_group,
      description: r.description,
      category: r.category,
      required: criteria.get(`${r.id}/required`) ?? [],
      preferred: criteria.get(`${r.id}/preferred`) ?? [],
    })),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by_name,
  };
}
const decodeSquad = (r: SquadRow): SquadMemberFields => ({
  id: r.id,
  orgId: r.org_id,
  playerId: r.player_id,
  name: r.name,
  position: r.position,
  source: r.source,
  approvedBy: r.approved_by_label,
  addedAt: r.added_at,
});
const decodeShadow = (r: ShadowRow): ShadowPlayerFields => ({
  id: r.id,
  orgId: r.org_id,
  playerId: r.player_id,
  name: r.name,
  roleId: r.role_id,
  addedBy: r.added_by_name,
  addedAt: r.added_at,
});
const decodeFederation = (r: FederationRow): FederationCheckFields => ({
  orgId: r.org_id,
  federation: r.federation,
  registrationId: r.registration_id,
  contactEmail: r.contact_email,
  status: r.status,
  submittedAt: r.submitted_at,
});
const decodeVacancy = (r: VacancyRow): VacancyFields => ({
  id: r.id,
  orgId: r.org_id,
  roleId: r.role_id,
  roleName: r.role_name,
  window: r.window_name,
  notes: r.notes,
  status: r.status,
  createdBy: r.created_by_name,
  createdAt: r.created_at,
  closedAt: r.closed_at,
});
const positionsOf = (st: Statements, orgId: string): LookingForPosition[] =>
  (st.lookingForOf.all(orgId) as Pick<LookingForRow, 'position'>[]).map((r) => r.position);

export const clubSetupLive = (sqlite: DatabaseSync) => migrationApplied(sqlite, CLUB_SETUP_MIGRATION);
const PLAYER_REFS_SQL =
  'SELECT player_id AS pid FROM org_squad_members WHERE player_id IS NOT NULL UNION ALL SELECT player_id FROM org_shadow_players';
type PlayerRefCounts = { squad: number };
const playerRefCounts = (sqlite: DatabaseSync, cond: string): PlayerRefCounts => ({
  squad: (sqlite.prepare(`SELECT count(*) AS n FROM (${PLAYER_REFS_SQL}) x WHERE ${cond}`).get() as { n: number }).n,
});
export const unresolvedPlayerReferences = (sqlite: DatabaseSync): PlayerRefCounts | null =>
  clubSetupLive(sqlite) ? playerRefCounts(sqlite, 'NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid)') : null;
export const retainedPlayerReferences = (sqlite: DatabaseSync): PlayerRefCounts | null =>
  clubSetupLive(sqlite)
    ? playerRefCounts(sqlite, 'EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid AND p.deleted_at IS NOT NULL)')
    : null;

function readAll(sqlite: DatabaseSync): ClubSetupRecords {
  const st = statements(sqlite);
  return {
    tacticalSetups: (st.setupAll.all() as SetupRow[]).map((r) => decodeSetup(st, r)),
    squadMembers: (st.squadAll.all() as SquadRow[]).map(decodeSquad),
    shadowPlayers: (st.shadowAll.all() as ShadowRow[]).map(decodeShadow),
    lookingFor: (st.lookingForOrgs.all() as { org_id: string }[]).map((r) => ({
      orgId: r.org_id,
      positions: positionsOf(st, r.org_id),
    })),
    federationChecks: (st.federationAll.all() as FederationRow[]).map(decodeFederation),
    vacancies: (st.vacancyAll.all() as VacancyRow[]).map(decodeVacancy),
  };
}

/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const CLUB_SETUP_RECORDS = {
  names: CLUB_SETUP_COLLECTIONS,
  read(sqlite: DatabaseSync): ClubSetupRecords | null {
    return clubSetupLive(sqlite) ? readAll(sqlite) : null;
  },
};

// ------------------------------------------------------------------ the repository
/** A page of a club's vacancies: `after` is the previous page's last key. */
type VacancyPageRequest = { limit: number; after?: readonly [number] | null };
/**
 * `createClubSetupRepository({ sqlite, unit, now, log })`: `tactical`, `squad`, `shadow`, `lookingFor`, `federation`
 * and `vacancies`, each with its writes and queries, plus `reads` (the queries alone, for `scoutingReads`).
 */
export function createClubSetupRepository(
  {
    sqlite,
    unit = null,
    now = Date.now,
    log = () => {},
  }: {
    sqlite: DatabaseSync;
    unit?: UnitParticipant | null;
    now?: () => number;
    log?: (message: string) => void;
  } = {} as { sqlite: DatabaseSync },
) {
  if (!sqlite) throw new TypeError('the club setup repository needs a SQLite connection (node:sqlite)');
  const st = statements(sqlite);
  const operation = operationOn(sqlite, unit);
  const typedOr = <N extends ClubSetupCollection>(name: N, raw: unknown): FieldsOf[N] => {
    const t = TYPERS[name](raw, name);
    if (!t.ok) throw refusal('CLUB_SETUP_INPUT_INVALID', t.reason);
    return t.record;
  };
  const q = (sql: string) => sqlite.prepare(sql);
  const freezeAll = <R, T>(stmt: StatementSync, decode: (r: R) => T, ...args: SQLInputValue[]) =>
    (stmt.all(...args) as R[]).map((r) => deepFreeze(decode(r)));
  const roleOrgOr = (roleId: string | null, orgId: string, what: string) => {
    if (roleId === null) return;
    const owner = st.roleOwner.get(roleId) as { org_id: string } | undefined;
    if (!owner || owner.org_id !== orgId)
      throw refusal('CLUB_SETUP_INPUT_INVALID', `${what}: role ${roleId} is not a role of organisation ${orgId}`);
  };

  const setupFor = (orgId: unknown): TacticalSetup | null => {
    if (typeof orgId !== 'string') return null;
    const row = st.setupOf.get(orgId) as SetupRow | undefined;
    return row ? deepFreeze(decodeSetup(st, row)) : null;
  };
  const tacticalWrites = {
    /**
     * Save a club's whole setup. A role id must be new (not a role of any organisation) or one of THIS club's
     * current roles; the routes mint new ids. Returns the stored setup.
     */
    save: (raw: TacticalSetupInput): TacticalSetup =>
      operation(() => {
        const s = typedOr('tacticalSetups', raw);
        for (const r of s.roles) {
          const owner = st.roleOwner.get(r.id) as { org_id: string } | undefined;
          if (owner && owner.org_id !== s.orgId)
            throw refusal(
              'CLUB_SETUP_INPUT_INVALID',
              `tacticalSetups ${s.orgId}: role ${r.id} belongs to another organisation`,
            );
        }
        writeSetup(st, s);
        return setupFor(s.orgId) as TacticalSetup;
      }),
  };
  const tactical = {
    ...tacticalWrites,
    forOrg: setupFor,
    /** One of the club's current roles, or null. */
    roleOf: (orgId: unknown, roleId: unknown): TacticalRole | null =>
      setupFor(orgId)?.roles.find((r) => r.id === roleId) ?? null,
    /** The ids of the club's current roles. */
    roleIds: (orgId: string): string[] => (st.rolesOf.all(orgId) as RoleRow[]).map((r) => r.id),
  };

  const squadOf = q('SELECT * FROM org_squad_members WHERE org_id = ? ORDER BY rowid');
  const squadForPlayer = q('SELECT * FROM org_squad_members WHERE player_id = ? ORDER BY rowid');
  const squadHas = q('SELECT 1 FROM org_squad_members WHERE org_id = ? AND player_id = ?');
  const squadPlayerIds = q(
    'SELECT player_id FROM org_squad_members WHERE org_id = ? AND player_id IS NOT NULL ORDER BY rowid',
  );
  const squadById = (id: unknown): SquadMember | null => {
    const r = typeof id === 'string' ? (st.squadById.get(id) as SquadRow | undefined) : undefined;
    return r ? deepFreeze(decodeSquad(r)) : null;
  };
  const squadWrites = {
    /** Add a row. A player already on this club's squad is refused (CLUB_SETUP_UNIQUENESS); callers check first. */
    create: (raw: SquadMemberInput): SquadMember =>
      operation(() => {
        const m = typedOr('squadMembers', raw);
        if (st.squadById.get(m.id)) throw refusal('CLUB_SETUP_DUPLICATE', `org_squad_members ${m.id} already exists`);
        if (m.playerId && squadHas.get(m.orgId, m.playerId))
          throw refusal(
            'CLUB_SETUP_UNIQUENESS',
            `org_squad_members: organisation ${m.orgId} already has player ${m.playerId} on its squad`,
          );
        st.squad.run(squadRow(m));
        return squadById(m.id) as SquadMember;
      }),
    /** Remove a row (a release). Returns true when there was one. */
    remove: (id: string): boolean => operation(() => st.squadDel.run(id).changes > 0),
  };
  const squad = {
    ...squadWrites,
    byId: squadById,
    forOrg: (orgId: string): SquadMember[] => freezeAll(squadOf, decodeSquad, orgId),
    /** Every club's row for `playerId` (the passport, the Trust score, Second Look). */
    forPlayer: (playerId: string): SquadMember[] => freezeAll(squadForPlayer, decodeSquad, playerId),
    has: (orgId: string, playerId: unknown): boolean => typeof playerId === 'string' && !!squadHas.get(orgId, playerId),
    /** The on-platform player ids on the club's squad. */
    playerIds: (orgId: string): string[] =>
      (squadPlayerIds.all(orgId) as { player_id: string }[]).map((r) => r.player_id),
  };

  const shadowOf = q('SELECT * FROM org_shadow_players WHERE org_id = ? ORDER BY rowid');
  const shadowHas = q('SELECT 1 FROM org_shadow_players WHERE org_id = ? AND player_id = ?');
  const shadowWrites = {
    create: (raw: ShadowPlayerInput): ShadowPlayer =>
      operation(() => {
        const s = typedOr('shadowPlayers', raw);
        if (st.shadowById.get(s.id)) throw refusal('CLUB_SETUP_DUPLICATE', `org_shadow_players ${s.id} already exists`);
        if (shadowHas.get(s.orgId, s.playerId))
          throw refusal(
            'CLUB_SETUP_UNIQUENESS',
            `org_shadow_players: organisation ${s.orgId} already shadows player ${s.playerId}`,
          );
        roleOrgOr(s.roleId, s.orgId, `org_shadow_players ${s.id}`);
        st.shadow.run(shadowRow(s));
        return deepFreeze(decodeShadow(st.shadowById.get(s.id) as ShadowRow));
      }),
  };
  const shadow = {
    ...shadowWrites,
    forOrg: (orgId: string): ShadowPlayer[] => freezeAll(shadowOf, decodeShadow, orgId),
    has: (orgId: string, playerId: unknown): boolean =>
      typeof playerId === 'string' && !!shadowHas.get(orgId, playerId),
  };

  const lookingForWrites = {
    /** Replace the club's list. Returns the stored positions. */
    set: (orgId: string, positions: readonly LookingForPosition[]): readonly LookingForPosition[] =>
      operation(() => {
        const l = typedOr('lookingFor', { orgId, positions });
        writeLookingFor(st, l);
        return Object.freeze(positionsOf(st, orgId));
      }),
  };
  const lookingFor = {
    ...lookingForWrites,
    forOrg: (orgId: string): readonly LookingForPosition[] => Object.freeze(positionsOf(st, orgId)),
  };

  const federationOf = (orgId: string): FederationCheck | null => {
    const r = st.federationOf.get(orgId) as FederationRow | undefined;
    return r ? deepFreeze(decodeFederation(r)) : null;
  };
  const federationWrites = {
    /** Record (or replace) the club's federation-route request. */
    submit: (raw: FederationCheckInput): FederationCheck =>
      operation(() => {
        const f = typedOr('federationChecks', raw);
        st.federation.run(federationRow(f));
        return federationOf(f.orgId) as FederationCheck;
      }),
  };
  const federation = { ...federationWrites, forOrg: federationOf };

  const vacancyPage = q(
    'SELECT rowid AS rid, * FROM vacancies WHERE org_id = ? AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?',
  );
  const vacancyOpen = q("SELECT * FROM vacancies WHERE org_id = ? AND status = 'open' ORDER BY rowid");
  const vacancyById = (id: unknown): Vacancy | null => {
    const r = typeof id === 'string' ? (st.vacancyById.get(id) as VacancyRow | undefined) : undefined;
    return r ? deepFreeze(decodeVacancy(r)) : null;
  };
  const vacancyOr = (id: unknown): Vacancy => {
    const v = vacancyById(id);
    if (!v) throw refusal('CLUB_SETUP_NOT_FOUND', `vacancies ${id} is not a record of the repository`);
    return v;
  };
  const vacancyWrites = {
    create: (raw: VacancyInput): Vacancy =>
      operation(() => {
        const v = typedOr('vacancies', raw);
        if (st.vacancyById.get(v.id)) throw refusal('CLUB_SETUP_DUPLICATE', `vacancies ${v.id} already exists`);
        roleOrgOr(v.roleId, v.orgId, `vacancies ${v.id}`);
        st.vacancy.run(vacancyRow(v));
        return vacancyOr(v.id);
      }),
    /** Close an open vacancy at `at`; a closed one is refused (`CLUB_SETUP_STATE_CONFLICT`). */
    close: (id: string, at: number): Vacancy =>
      operation(() => {
        vacancyOr(id);
        if (!st.vacancyClose.run({ id, closed_at: at }).changes)
          throw refusal('CLUB_SETUP_STATE_CONFLICT', `vacancies ${id} is already closed`);
        return vacancyOr(id);
      }),
  };
  const vacancies = {
    ...vacancyWrites,
    byId: vacancyById,
    /** The vacancy `id` if it belongs to `orgId`, else null. */
    ofOrg: (id: unknown, orgId: string): Vacancy | null => {
      const v = vacancyById(id);
      return v && v.orgId === orgId ? v : null;
    },
    openForOrg: (orgId: string): Vacancy[] => freezeAll(vacancyOpen, decodeVacancy, orgId),
    /** The club's vacancies, newest first, by cursor (`after` is the previous page's last `[rowid]`). */
    page(orgId: string, { limit, after = null }: VacancyPageRequest): { rows: { key: [number]; vacancy: Vacancy }[] } {
      const rows = vacancyPage.all(orgId, after?.[0] ?? null, after?.[0] ?? null, limit + 1) as (VacancyRow & {
        rid: number;
      })[];
      return {
        rows: rows.map((r) => ({
          key: [r.rid],
          vacancy: deepFreeze(decodeVacancy(r)),
        })),
      };
    },
  };

  const writeKeys = <T extends object>(_repo: T, w: object) => Object.keys(w) as (keyof T)[];
  const counters = Object.fromEntries(CLUB_SETUP_TABLES.map((t) => [t, q(`SELECT COUNT(*) AS n FROM ${t}`)])) as Record<
    ClubSetupTable,
    StatementSync
  >;
  return {
    tactical,
    squad,
    shadow,
    lookingFor,
    federation,
    vacancies,
    /** The queries alone, for modules and projectors that must not write (`scoutingReads`). */
    reads: Object.freeze({
      tacticalSetups: readsOf(tactical, writeKeys(tactical, tacticalWrites)),
      squad: readsOf(squad, writeKeys(squad, squadWrites)),
      shadow: readsOf(shadow, writeKeys(shadow, shadowWrites)),
      lookingFor: readsOf(lookingFor, writeKeys(lookingFor, lookingForWrites)),
      federationChecks: readsOf(federation, writeKeys(federation, federationWrites)),
      vacancies: readsOf(vacancies, writeKeys(vacancies, vacancyWrites)),
    }),
    attach() {
      if (!clubSetupLive(sqlite))
        throw new Error(
          `the club setup repository needs ${CLUB_SETUP_MIGRATION} recorded; it never imports an in-memory array`,
        );
      return { counts: this.counts() };
    },
    counts(): Record<ClubSetupTable, number> {
      return Object.fromEntries(CLUB_SETUP_TABLES.map((t) => [t, (counters[t].get() as { n: number }).n])) as Record<
        ClubSetupTable,
        number
      >;
    },
    pending: () => 0,
    exportAll(): ClubSetupRecords | null {
      return CLUB_SETUP_RECORDS.read(sqlite);
    },
    log,
    now,
  };
}
export type ClubSetupRepository = ReturnType<typeof createClubSetupRepository>;
export type ClubSetupReads = ClubSetupRepository['reads'];
