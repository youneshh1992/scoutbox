/**
 * The evidence passport, coach affiliations and squad invitations.
 *
 * Records (the keys every reader sees): `Evidence`, `CoachAffiliation` and `SquadInvite` below, deep-frozen as read
 * back.
 *
 * Tables: evidence, evidence_media, evidence_disputes, evidence_history; coach_affiliations, coach_affiliation_history;
 * squad_invites. Every field is a typed column with its vocabulary and length CHECKs; there are no side columns, and a
 * record the columns cannot hold is refused with its id — at the repository (the routes check first and answer 400).
 *
 * WRITES are explicit, each joined into the open unit of work (a failure poisons it), the caller's open transaction,
 * or a transaction of its own. `create(record)` types the whole record and writes its rows at once (an unknown field is
 * refused); then a record changes only through named acts guarded in SQL by the state they move from (evidence is
 * corroborated, superseded and disputed; an affiliation closed; an invitation answered), with their history entries.
 * The typers take `unknown`, so a caller still in JavaScript can pass anything: the typer and the columns judge it.
 *
 * Every query decodes fresh, deep-frozen records in insertion (rowid) order unless it says otherwise; a read inside a
 * unit of work sees the unit's own writes. Modules receive the queries as `scoutingReads`.
 *
 * References. Player ids have NO foreign key: tolerant and counted, like recruitment (Q7a/Q8a/Q8c-a in
 * docs/decisions.md): evidence and invitations stay after an account deletion (retention is an open question, Q6).
 * Media ids on evidence have no key either: a removed clip stays named.
 * `org_id` → orgs and the staff ids → org_users are immediate RESTRICT keys (organisations are never deleted, O2).
 * `correction_of_id` / `superseded_by_id` → evidence are immediate RESTRICT keys: the correction is inserted first,
 * then the original is pointed at it, in one unit.
 */
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import { isPlainObject, describe } from './fieldSpecs.ts';
import { migrationApplied, childRowsOf, operationOn, type Row, type UnitParticipant } from './database.ts';
import { readsOf } from './identityRules.ts';
import { writeKit, columnsOf, insertFor, type Flatten, type History, type InputFor, type RowOf } from './writes.ts';
import { deepFreeze, type DeepReadonly } from '../domains/platform/values.ts';

export const SCOUTING_EVIDENCE_MIGRATION = '0019_scouting_evidence';
export const SCOUTING_EVIDENCE_COLLECTIONS = Object.freeze(['evidence', 'coachAffiliations', 'squadInvites'] as const);
export type ScoutingEvidenceCollection = (typeof SCOUTING_EVIDENCE_COLLECTIONS)[number];
export const SCOUTING_EVIDENCE_TABLES = Object.freeze([
  'evidence',
  'evidence_media',
  'evidence_disputes',
  'evidence_history',
  'coach_affiliations',
  'coach_affiliation_history',
  'squad_invites',
] as const);

// ------------------------------------------------------------------ vocabulary
export const CLAIM_TYPES = Object.freeze([
  'statistic',
  'attendance',
  'assessment_result',
  'reference',
  'footage',
  'availability',
] as const);
/** The tiers a record can hold. 'independent' exists in the tier ladder but no route can set it, so no row holds it. */
export const EVIDENCE_TIERS_STORED = Object.freeze(['self_reported', 'coach_confirmed', 'club_assessed'] as const);
export const EVIDENCE_SOURCE_KINDS = Object.freeze(['player', 'guardian', 'org'] as const);
export const DISPUTE_BY_KINDS = Object.freeze(['player', 'org'] as const);
export const DISPUTE_OUTCOMES = Object.freeze(['upheld', 'rejected'] as const);
const DISPUTE_STATUSES = ['open', 'resolved'] as const;
export const AFFILIATION_STATUSES = Object.freeze(['confirmed', 'ended', 'revoked'] as const);
const CLOSED_AFFILIATION_STATUSES = ['ended', 'revoked'] as const;
export const INVITE_STATUSES = Object.freeze(['pending_guardian', 'pending_player', 'approved', 'declined'] as const);
const ANSWERED_INVITE_STATUSES = ['approved', 'declined'] as const;
export const HISTORY_BY_KINDS = Object.freeze(['player', 'guardian', 'org', 'admin'] as const);
/** Text limits: the routes shorten longer text to these; the columns refuse anything longer. */
export const EVIDENCE_LIMITS = Object.freeze({
  label: 120,
  valueText: 120,
  units: 20,
  season: 20,
  note: 300,
  method: 80,
  reason: 300,
  resolutionNote: 300,
  sourceName: 200,
  coachName: 80,
  coachEmail: 120,
  role: 60,
  conflict: 200,
  closeReason: 200,
  inviteNote: 200,
  detail: 500,
  name: 200,
});
const L = EVIDENCE_LIMITS;
export type ClaimType = (typeof CLAIM_TYPES)[number];
export type EvidenceTier = (typeof EVIDENCE_TIERS_STORED)[number];
export type EvidenceSourceKind = (typeof EVIDENCE_SOURCE_KINDS)[number];
export type DisputeByKind = (typeof DISPUTE_BY_KINDS)[number];
export type DisputeOutcome = (typeof DISPUTE_OUTCOMES)[number];
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];
export type AffiliationStatus = (typeof AFFILIATION_STATUSES)[number];
export type ClosedAffiliationStatus = (typeof CLOSED_AFFILIATION_STATUSES)[number];
export type InviteStatus = (typeof INVITE_STATUSES)[number];
export type HistoryByKind = (typeof HISTORY_BY_KINDS)[number];

// ------------------------------------------------------------------ records
/** One history entry, the shape shared with the scouting assessments, club setup and opportunities repositories. */
type HistoryFields = {
  id: string;
  at: number;
  byKind: HistoryByKind | null;
  byId: string | null;
  byName: string | null;
  action: string;
  detail: string | null;
};
type SourceFields = { kind: EvidenceSourceKind; id: string; name: string };
type VerificationFields = {
  status: EvidenceTier;
  method: string | null;
  reviewerId: string | null;
  reviewerName: string | null;
  reviewedAt: number | null;
};
type DisputeResolutionFields = { outcome: DisputeOutcome; note: string | null; at: number };
type DisputeFields = {
  id: string;
  at: number;
  by: { kind: DisputeByKind; id: string; name: string };
  reason: string;
  status: DisputeStatus;
  resolution: DisputeResolutionFields | null;
};
type EvidenceFields = {
  id: string;
  playerId: string;
  claimType: ClaimType;
  label: string;
  value: number | string | null;
  units: string | null;
  season: string | null;
  source: SourceFields;
  observedAt: number | null;
  recordedAt: number;
  mediaIds: string[];
  verification: VerificationFields;
  expiresAt: number | null;
  correctionOf: string | null;
  supersededBy: string | null;
  disputes: DisputeFields[];
  note: string | null;
  history: HistoryFields[];
};
type AffiliationFields = {
  id: string;
  orgId: string;
  orgName: string;
  coachName: string;
  coachEmail: string | null;
  role: string;
  /** A day, YYYY-MM-DD. */
  from: string;
  /** A day, YYYY-MM-DD; null exactly while the affiliation is confirmed. */
  to: string | null;
  status: AffiliationStatus;
  confirmedBy: { userId: string; name: string };
  conflictOfInterest: string | null;
  createdAt: number;
  history: HistoryFields[];
};
type InviteFields = {
  id: string;
  orgId: string;
  orgName: string;
  playerId: string;
  playerName: string | null;
  byUserId: string;
  byName: string;
  note: string | null;
  status: InviteStatus;
  createdAt: number;
  /** Set exactly once the invitation is answered. */
  respondedAt: number | null;
};
type DisputeQueueItemFields = Flatten<
  DisputeFields & { evidenceId: string; playerId: string; label: string; tier: EvidenceTier }
>;
export type ScoutingHistoryEntry = DeepReadonly<HistoryFields>;
export type EvidenceSource = DeepReadonly<SourceFields>;
export type EvidenceVerification = DeepReadonly<VerificationFields>;
export type EvidenceDispute = DeepReadonly<DisputeFields>;
export type Evidence = DeepReadonly<EvidenceFields>;
export type CoachAffiliation = DeepReadonly<AffiliationFields>;
export type SquadInvite = DeepReadonly<InviteFields>;
/** A dispute in the admin queue, with its record's id, player, label and tier. */
export type DisputeQueueItem = DeepReadonly<DisputeQueueItemFields>;
type FieldsOf = { evidence: EvidenceFields; coachAffiliations: AffiliationFields; squadInvites: InviteFields };
type RecordOf = { [N in ScoutingEvidenceCollection]: DeepReadonly<FieldsOf[N]> };
export type ScoutingEvidenceRecords = { [N in ScoutingEvidenceCollection]: RecordOf[N][] };

// ------------------------------------------------------------------ inputs (what the typers accept)
export type ScoutingHistoryInput = InputFor<HistoryFields>;
export type EvidenceVerificationInput = InputFor<VerificationFields>;
export type EvidenceDisputeInput = InputFor<DisputeFields>;
export type EvidenceInput = InputFor<EvidenceFields>;
export type CoachAffiliationInput = InputFor<AffiliationFields>;
export type SquadInviteInput = InputFor<InviteFields>;
type InputOf = {
  evidence: EvidenceInput;
  coachAffiliations: CoachAffiliationInput;
  squadInvites: SquadInviteInput;
};
/** A dispute as filed: always open, so its status and resolution may be left out. */
export type DisputeFiling = Flatten<
  Pick<EvidenceDisputeInput, 'id' | 'at' | 'by' | 'reason'> & { status?: 'open'; resolution?: null }
>;
type OffsetPage = { limit: number; offset: number };
type OffsetPageOf<T> = { total: number; limit: number; offset: number; items: T[] };

// ------------------------------------------------------------------ DDL
export const txt = (col: string, max: number, { notNull = false }: { notNull?: boolean } = {}) =>
  `TEXT${notNull ? ' NOT NULL' : ''} CHECK (${notNull ? '' : `${col} IS NULL OR `}length(${col}) <= ${max})`;
export const historyTable = (table: string, owner: string, ownerTable: string) => `
CREATE TABLE ${table} (
  id          TEXT PRIMARY KEY,
  ${owner}    TEXT NOT NULL REFERENCES ${ownerTable}(id) ON DELETE RESTRICT,
  position    INTEGER NOT NULL,
  at          INTEGER NOT NULL,
  by_kind     TEXT CHECK (by_kind IS NULL OR by_kind IN ('player','guardian','org','admin')),
  by_id       TEXT,
  by_name     ${txt('by_name', L.name)},
  action      TEXT NOT NULL,
  detail      ${txt('detail', L.detail)},
  UNIQUE (${owner}, position)
) STRICT;`;
export const SCOUTING_EVIDENCE_DDL = `
CREATE TABLE evidence (
  id                  TEXT PRIMARY KEY,
  player_id           TEXT NOT NULL,
  claim_type          TEXT NOT NULL CHECK (claim_type IN ('statistic','attendance','assessment_result','reference','footage','availability')),
  label               ${txt('label', L.label, { notNull: true })},
  value_number        REAL,
  value_text          ${txt('value_text', L.valueText)},
  units               ${txt('units', L.units)},
  season              ${txt('season', L.season)},
  source_kind         TEXT NOT NULL CHECK (source_kind IN ('player','guardian','org')),
  source_id           TEXT NOT NULL,
  source_name         ${txt('source_name', L.sourceName, { notNull: true })},
  observed_at         INTEGER,
  recorded_at         INTEGER NOT NULL,
  verification_status TEXT NOT NULL CHECK (verification_status IN ('self_reported','coach_confirmed','club_assessed')),
  verification_method ${txt('verification_method', L.method)},
  reviewer_id         TEXT,
  reviewer_name       ${txt('reviewer_name', L.name)},
  reviewed_at         INTEGER,
  expires_at          INTEGER,
  correction_of_id    TEXT REFERENCES evidence(id) ON DELETE RESTRICT,
  superseded_by_id    TEXT REFERENCES evidence(id) ON DELETE RESTRICT,
  note                ${txt('note', L.note)},
  CHECK (value_number IS NULL OR value_text IS NULL)
) STRICT;
CREATE INDEX evidence_player ON evidence (player_id, claim_type);
CREATE INDEX evidence_superseded_by ON evidence (superseded_by_id);
CREATE TABLE evidence_media (
  evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  media_id    TEXT NOT NULL,
  PRIMARY KEY (evidence_id, position),
  UNIQUE (evidence_id, media_id)
) STRICT;
CREATE TABLE evidence_disputes (
  id                 TEXT PRIMARY KEY,
  evidence_id        TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  position           INTEGER NOT NULL,
  filed_at           INTEGER NOT NULL,
  by_kind            TEXT NOT NULL CHECK (by_kind IN ('player','org')),
  by_id              TEXT NOT NULL,
  by_name            ${txt('by_name', L.name, { notNull: true })},
  reason             ${txt('reason', L.reason, { notNull: true })},
  status             TEXT NOT NULL CHECK (status IN ('open','resolved')),
  resolution_outcome TEXT CHECK (resolution_outcome IS NULL OR resolution_outcome IN ('upheld','rejected')),
  resolution_note    ${txt('resolution_note', L.resolutionNote)},
  resolved_at        INTEGER,
  UNIQUE (evidence_id, position),
  CHECK ((status = 'resolved') = (resolution_outcome IS NOT NULL AND resolved_at IS NOT NULL))
) STRICT;
CREATE INDEX evidence_disputes_status_filed ON evidence_disputes (status, filed_at);
${historyTable('evidence_history', 'evidence_id', 'evidence')}
CREATE TABLE coach_affiliations (
  id                   TEXT PRIMARY KEY,
  org_id               TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  org_name             ${txt('org_name', L.name, { notNull: true })},
  coach_name           ${txt('coach_name', L.coachName, { notNull: true })},
  coach_email          ${txt('coach_email', L.coachEmail)},
  role                 ${txt('role', L.role, { notNull: true })},
  from_date            TEXT NOT NULL CHECK (length(from_date) = 10),
  to_date              TEXT CHECK (to_date IS NULL OR length(to_date) = 10),
  status               TEXT NOT NULL CHECK (status IN ('confirmed','ended','revoked')),
  confirmed_by_user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  confirmed_by_name    ${txt('confirmed_by_name', L.name, { notNull: true })},
  conflict_of_interest ${txt('conflict_of_interest', L.conflict)},
  created_at           INTEGER NOT NULL,
  CHECK ((status = 'confirmed') = (to_date IS NULL))
) STRICT;
CREATE INDEX coach_affiliations_org_status ON coach_affiliations (org_id, status);
CREATE INDEX coach_affiliations_created ON coach_affiliations (created_at);
${historyTable('coach_affiliation_history', 'affiliation_id', 'coach_affiliations')}
CREATE TABLE squad_invites (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  org_name     ${txt('org_name', L.name, { notNull: true })},
  player_id    TEXT NOT NULL,
  player_name  ${txt('player_name', L.name)},
  by_user_id   TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  by_name      ${txt('by_name', L.name, { notNull: true })},
  note         ${txt('note', L.inviteNote)},
  status       TEXT NOT NULL CHECK (status IN ('pending_guardian','pending_player','approved','declined')),
  created_at   INTEGER NOT NULL,
  responded_at INTEGER,
  CHECK ((status IN ('approved','declined')) = (responded_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX squad_invites_one_pending ON squad_invites (org_id, player_id) WHERE status IN ('pending_guardian','pending_player');
CREATE INDEX squad_invites_player_status ON squad_invites (player_id, status);
`;

// ------------------------------------------------------------------ typing (the one place a value is judged)
// The helpers below are shared with the scouting assessments, club setup and opportunities repositories.
type Present<T> = Exclude<T, undefined> | (undefined extends T ? null : never);
/** A typing problem: names the record, the field and what it holds — never its content. */
export type Bad = { ok: false; reason: string };
/** What a typer answers: the record it would write, or why it refused. */
export type Typed<T> = { ok: true; record: T } | Bad;
export const refusal = (code: string, message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
export const isInt = (v: unknown): v is number => Number.isSafeInteger(v);
export const isStr = (v: unknown): v is string => typeof v === 'string';
export const nonEmpty = (v: unknown): v is string => isStr(v) && v.length > 0;
export const orNull = <T>(v: T): Present<T> => (v === undefined ? null : v) as Present<T>;
export const clone = <T>(v: T): T => (v === undefined ? undefined : JSON.parse(JSON.stringify(v))) as T;
export const bad = (at: string, field: string, what: string): Bad => ({ ok: false, reason: `${at}.${field} ${what}` });
const oneOf = <T>(list: readonly T[], v: unknown): v is T => (list as readonly unknown[]).includes(v);
const dayOnly = (v: unknown): v is string => isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isAbsent = (v: unknown): v is null | undefined => v === undefined || v === null;
type Fields = Record<string, unknown>;
/** Text that is optional (null/absent) or a string of at most `max` characters. */
export function optText(rec: Fields, at: string, field: string, max: number): Bad | null {
  const v = rec[field];
  if (isAbsent(v)) return null;
  if (!isStr(v)) return bad(at, field, `must be text or null (got ${describe(v)})`);
  if (v.length > max) return bad(at, field, `exceeds ${max} characters`);
  return null;
}
export function reqText(rec: Fields, at: string, field: string, max: number): Bad | null {
  const v = rec[field];
  if (!nonEmpty(v)) return bad(at, field, `must be non-empty text (got ${describe(v)})`);
  if (v.length > max) return bad(at, field, `exceeds ${max} characters`);
  return null;
}
export const optInstant = (rec: Fields, at: string, field: string): Bad | null =>
  isAbsent(rec[field]) || isInt(rec[field])
    ? null
    : bad(at, field, `must be an integer instant or null (got ${describe(rec[field])})`);
export const reqInstant = (rec: Fields, at: string, field: string): Bad | null =>
  isInt(rec[field]) ? null : bad(at, field, `must be an integer instant (got ${describe(rec[field])})`);
export const unknownFields = (rec: Fields, at: string, known: readonly string[]): Bad | null => {
  const extra = Object.keys(rec).filter((k) => !known.includes(k));
  return extra.length
    ? { ok: false, reason: `${at} carries field(s) this build does not store: ${extra.join(', ')}` }
    : null;
};
export const first = (...checks: (Bad | null)[]): Bad | null => checks.find((c) => c) ?? null;
// Each typer checks the value field by field, then reads it as the input it has just been checked to be.

/** One history entry, the shared shape `{ id, at, byKind, byId, byName, action, detail }` (detail is text or null). */
export function typeHistory(
  h: unknown,
  at: string,
  kinds: readonly HistoryByKind[] = HISTORY_BY_KINDS,
): Typed<HistoryFields> {
  if (!isPlainObject(h)) return { ok: false, reason: `${at} is not an object (${describe(h)})` };
  const problem = first(
    unknownFields(h, at, ['id', 'at', 'byKind', 'byId', 'byName', 'action', 'detail']),
    reqText(h, at, 'id', 80),
    reqInstant(h, at, 'at'),
    reqText(h, at, 'action', 80),
    optText(h, at, 'byId', 80),
    optText(h, at, 'byName', L.name),
    optText(h, at, 'detail', L.detail),
  );
  if (problem) return problem;
  if (!isAbsent(h.byKind) && !oneOf(kinds, h.byKind))
    return bad(at, 'byKind', `must be one of ${kinds.join('|')} or null (got ${describe(h.byKind)})`);
  const v = h as ScoutingHistoryInput;
  return {
    ok: true,
    record: {
      id: v.id,
      at: v.at,
      byKind: orNull(v.byKind),
      byId: orNull(v.byId),
      byName: orNull(v.byName),
      action: v.action,
      detail: orNull(v.detail),
    },
  };
}
/** A list of parts, each typed by `typer`; absent is empty, and two parts with one id are refused. */
export function typeList<T extends { id?: string }, A extends unknown[]>(
  list: unknown,
  at: string,
  typer: (v: unknown, at: string, ...rest: A) => Typed<T>,
  ...rest: A
): { ok: true; list: T[] } | Bad {
  if (isAbsent(list)) return { ok: true, list: [] };
  if (!Array.isArray(list)) return bad(at, '', `must be an array (got ${describe(list)})`);
  const out: T[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    const t = typer(list[i], `${at}[${i}]`, ...rest);
    if (!t.ok) return t;
    if (t.record.id !== undefined) {
      if (seen.has(t.record.id)) return bad(`${at}[${i}]`, 'id', `duplicates ${t.record.id}`);
      seen.add(t.record.id);
    }
    out.push(t.record);
  }
  return { ok: true, list: out };
}

const EVIDENCE_FIELDS = [
  'id',
  'playerId',
  'claimType',
  'label',
  'value',
  'units',
  'season',
  'source',
  'observedAt',
  'recordedAt',
  'mediaIds',
  'verification',
  'expiresAt',
  'correctionOf',
  'supersededBy',
  'disputes',
  'note',
  'history',
] as const satisfies readonly (keyof EvidenceFields)[];
function typeDispute(d: unknown, at: string): Typed<DisputeFields> {
  if (!isPlainObject(d)) return { ok: false, reason: `${at} is not an object (${describe(d)})` };
  const problem = first(
    unknownFields(d, at, ['id', 'at', 'by', 'reason', 'status', 'resolution']),
    reqText(d, at, 'id', 80),
    reqInstant(d, at, 'at'),
    reqText(d, at, 'reason', L.reason),
  );
  if (problem) return problem;
  const by = d.by;
  if (
    !isPlainObject(by) ||
    !oneOf(DISPUTE_BY_KINDS, by.kind) ||
    !nonEmpty(by.id) ||
    !nonEmpty(by.name) ||
    by.name.length > L.name ||
    Object.keys(by).some((k) => !['kind', 'id', 'name'].includes(k))
  )
    return bad(at, 'by', `must be {kind: ${DISPUTE_BY_KINDS.join('|')}, id, name}`);
  if (!oneOf(DISPUTE_STATUSES, d.status))
    return bad(at, 'status', `must be open or resolved (got ${describe(d.status)})`);
  let resolution: DisputeResolutionFields | null = null;
  if (!isAbsent(d.resolution)) {
    const r = d.resolution;
    if (
      !isPlainObject(r) ||
      !oneOf(DISPUTE_OUTCOMES, r.outcome) ||
      !isInt(r.at) ||
      Object.keys(r).some((k) => !['outcome', 'note', 'at'].includes(k))
    )
      return bad(at, 'resolution', `must be {outcome: ${DISPUTE_OUTCOMES.join('|')}, note, at} or null`);
    const p = optText(r, `${at}.resolution`, 'note', L.resolutionNote);
    if (p) return p;
    resolution = { outcome: r.outcome, note: orNull(r.note as string | null | undefined), at: r.at };
  }
  if ((d.status === 'resolved') !== (resolution !== null))
    return bad(
      at,
      'resolution',
      d.status === 'resolved' ? 'is required on a resolved dispute' : 'is present on an open dispute',
    );
  const v = d as EvidenceDisputeInput;
  return {
    ok: true,
    record: {
      id: v.id,
      at: v.at,
      by: { kind: by.kind, id: by.id, name: by.name },
      reason: v.reason,
      status: d.status,
      resolution,
    },
  };
}
/** The evidence record the routes produce, typed. `{ ok, record }` or `{ ok: false, reason }` naming the field — never its content. */
export function typeEvidence(raw: unknown, at = 'evidence'): Typed<EvidenceFields> {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  if (!nonEmpty(raw.id)) return bad(at, 'id', 'must be a non-empty string');
  const label = `${at} ${raw.id}`;
  const problem = first(
    unknownFields(raw, label, EVIDENCE_FIELDS),
    reqText(raw, label, 'playerId', 80),
    reqText(raw, label, 'label', L.label),
    optText(raw, label, 'units', L.units),
    optText(raw, label, 'season', L.season),
    optText(raw, label, 'note', L.note),
    optInstant(raw, label, 'observedAt'),
    reqInstant(raw, label, 'recordedAt'),
    optInstant(raw, label, 'expiresAt'),
    optText(raw, label, 'correctionOf', 80),
    optText(raw, label, 'supersededBy', 80),
  );
  if (problem) return problem;
  if (!oneOf(CLAIM_TYPES, raw.claimType))
    return bad(label, 'claimType', `must be one of ${CLAIM_TYPES.join('|')} (got ${describe(raw.claimType)})`);
  const value = raw.value;
  if (!(isAbsent(value) || Number.isFinite(value) || (isStr(value) && value.length <= L.valueText)))
    return bad(
      label,
      'value',
      `must be a number, text of at most ${L.valueText} characters, or null (got ${describe(value)})`,
    );
  const s = raw.source;
  if (
    !isPlainObject(s) ||
    !oneOf(EVIDENCE_SOURCE_KINDS, s.kind) ||
    !nonEmpty(s.id) ||
    !isStr(s.name) ||
    s.name.length > L.sourceName ||
    Object.keys(s).some((k) => !['kind', 'id', 'name'].includes(k))
  )
    return bad(label, 'source', `must be {kind: ${EVIDENCE_SOURCE_KINDS.join('|')}, id, name}`);
  const ver = raw.verification;
  if (
    !isPlainObject(ver) ||
    Object.keys(ver).some((k) => !['status', 'method', 'reviewerId', 'reviewerName', 'reviewedAt'].includes(k))
  )
    return bad(label, 'verification', 'must be {status, method, reviewerId, reviewerName, reviewedAt}');
  if (!oneOf(EVIDENCE_TIERS_STORED, ver.status))
    return bad(
      label,
      'verification.status',
      `must be one of ${EVIDENCE_TIERS_STORED.join('|')} (got ${describe(ver.status)})`,
    );
  const vp = first(
    optText(ver, `${label}.verification`, 'method', L.method),
    optText(ver, `${label}.verification`, 'reviewerId', 80),
    optText(ver, `${label}.verification`, 'reviewerName', L.name),
    optInstant(ver, `${label}.verification`, 'reviewedAt'),
  );
  if (vp) return vp;
  let mediaIds: string[] = [];
  if (!isAbsent(raw.mediaIds)) {
    if (!Array.isArray(raw.mediaIds) || raw.mediaIds.some((m) => !nonEmpty(m)))
      return bad(label, 'mediaIds', 'must be an array of media ids');
    if (new Set(raw.mediaIds).size !== raw.mediaIds.length) return bad(label, 'mediaIds', 'names a media item twice');
    mediaIds = [...(raw.mediaIds as string[])];
  }
  if (raw.correctionOf && raw.correctionOf === raw.id) return bad(label, 'correctionOf', 'names the record itself');
  if (raw.supersededBy && raw.supersededBy === raw.id) return bad(label, 'supersededBy', 'names the record itself');
  const disputes = typeList(raw.disputes, `${label}.disputes`, typeDispute);
  if (!disputes.ok) return disputes;
  const history = typeList(raw.history, `${label}.history`, typeHistory);
  if (!history.ok) return history;
  const e = raw as EvidenceInput;
  const v = e.verification;
  return {
    ok: true,
    record: {
      id: e.id,
      playerId: e.playerId,
      claimType: e.claimType,
      label: e.label,
      value: orNull(e.value),
      units: orNull(e.units),
      season: orNull(e.season),
      source: { kind: s.kind, id: s.id, name: s.name },
      observedAt: orNull(e.observedAt),
      recordedAt: e.recordedAt,
      mediaIds,
      verification: {
        status: v.status,
        method: orNull(v.method),
        reviewerId: orNull(v.reviewerId),
        reviewerName: orNull(v.reviewerName),
        reviewedAt: orNull(v.reviewedAt),
      },
      expiresAt: orNull(e.expiresAt),
      correctionOf: orNull(e.correctionOf),
      supersededBy: orNull(e.supersededBy),
      disputes: disputes.list,
      note: orNull(e.note),
      history: history.list,
    },
  };
}

const AFFILIATION_FIELDS = [
  'id',
  'orgId',
  'orgName',
  'coachName',
  'coachEmail',
  'role',
  'from',
  'to',
  'status',
  'confirmedBy',
  'conflictOfInterest',
  'createdAt',
  'history',
] as const satisfies readonly (keyof AffiliationFields)[];
export function typeCoachAffiliation(raw: unknown, at = 'coachAffiliations'): Typed<AffiliationFields> {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  if (!nonEmpty(raw.id)) return bad(at, 'id', 'must be a non-empty string');
  const label = `${at} ${raw.id}`;
  const problem = first(
    unknownFields(raw, label, AFFILIATION_FIELDS),
    reqText(raw, label, 'orgId', 80),
    reqText(raw, label, 'orgName', L.name),
    reqText(raw, label, 'coachName', L.coachName),
    optText(raw, label, 'coachEmail', L.coachEmail),
    reqText(raw, label, 'role', L.role),
    optText(raw, label, 'conflictOfInterest', L.conflict),
    reqInstant(raw, label, 'createdAt'),
  );
  if (problem) return problem;
  if (!dayOnly(raw.from)) return bad(label, 'from', 'must be a YYYY-MM-DD day');
  if (!isAbsent(raw.to) && !dayOnly(raw.to)) return bad(label, 'to', 'must be a YYYY-MM-DD day or null');
  if (!oneOf(AFFILIATION_STATUSES, raw.status))
    return bad(label, 'status', `must be one of ${AFFILIATION_STATUSES.join('|')} (got ${describe(raw.status)})`);
  if ((raw.status === 'confirmed') !== isAbsent(raw.to))
    return bad(
      label,
      'to',
      raw.status === 'confirmed'
        ? 'must be null while the affiliation is confirmed'
        : 'is required once the affiliation ended',
    );
  const c = raw.confirmedBy;
  if (
    !isPlainObject(c) ||
    !nonEmpty(c.userId) ||
    !nonEmpty(c.name) ||
    c.name.length > L.name ||
    Object.keys(c).some((k) => !['userId', 'name'].includes(k))
  )
    return bad(label, 'confirmedBy', 'must be {userId, name}');
  const history = typeList(raw.history, `${label}.history`, typeHistory, ['org']);
  if (!history.ok) return history;
  const a = raw as CoachAffiliationInput;
  return {
    ok: true,
    record: {
      id: a.id,
      orgId: a.orgId,
      orgName: a.orgName,
      coachName: a.coachName,
      coachEmail: orNull(a.coachEmail),
      role: a.role,
      from: a.from,
      to: orNull(a.to),
      status: a.status,
      confirmedBy: { userId: c.userId, name: c.name },
      conflictOfInterest: orNull(a.conflictOfInterest),
      createdAt: a.createdAt,
      history: history.list,
    },
  };
}

const INVITE_FIELDS = [
  'id',
  'orgId',
  'orgName',
  'playerId',
  'playerName',
  'byUserId',
  'byName',
  'note',
  'status',
  'createdAt',
  'respondedAt',
] as const satisfies readonly (keyof InviteFields)[];
export function typeSquadInvite(raw: unknown, at = 'squadInvites'): Typed<InviteFields> {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  if (!nonEmpty(raw.id)) return bad(at, 'id', 'must be a non-empty string');
  const label = `${at} ${raw.id}`;
  const problem = first(
    unknownFields(raw, label, INVITE_FIELDS),
    reqText(raw, label, 'orgId', 80),
    reqText(raw, label, 'orgName', L.name),
    reqText(raw, label, 'playerId', 80),
    optText(raw, label, 'playerName', L.name),
    reqText(raw, label, 'byUserId', 80),
    reqText(raw, label, 'byName', L.name),
    optText(raw, label, 'note', L.inviteNote),
    reqInstant(raw, label, 'createdAt'),
    optInstant(raw, label, 'respondedAt'),
  );
  if (problem) return problem;
  if (!oneOf(INVITE_STATUSES, raw.status))
    return bad(label, 'status', `must be one of ${INVITE_STATUSES.join('|')} (got ${describe(raw.status)})`);
  const answered = oneOf(ANSWERED_INVITE_STATUSES, raw.status);
  if (answered !== !isAbsent(raw.respondedAt))
    return bad(
      label,
      'respondedAt',
      answered ? 'is required once the invitation is answered' : 'must be null while the invitation is pending',
    );
  const i = raw as SquadInviteInput;
  return {
    ok: true,
    record: {
      id: i.id,
      orgId: i.orgId,
      orgName: i.orgName,
      playerId: i.playerId,
      playerName: orNull(i.playerName),
      byUserId: i.byUserId,
      byName: i.byName,
      note: orNull(i.note),
      status: i.status,
      createdAt: i.createdAt,
      respondedAt: orNull(i.respondedAt),
    },
  };
}
const TYPERS: { [N in ScoutingEvidenceCollection]: (raw: unknown, at: string) => Typed<FieldsOf[N]> } = {
  evidence: typeEvidence,
  coachAffiliations: typeCoachAffiliation,
  squadInvites: typeSquadInvite,
};
const TABLE_OF = {
  evidence: 'evidence',
  coachAffiliations: 'coach_affiliations',
  squadInvites: 'squad_invites',
} as const satisfies Record<ScoutingEvidenceCollection, string>;

// ------------------------------------------------------------------ rows ↔ records
export const histRow = (owner: string, h: HistoryFields, position: number) => ({
  id: h.id,
  owner,
  position,
  at: h.at,
  by_kind: h.byKind,
  by_id: h.byId,
  by_name: h.byName,
  action: h.action,
  detail: h.detail,
});
/** A history row as read back: the owner column is named by its table, so it is left out. */
export type HistoryRow = Omit<RowOf<typeof histRow>, 'owner'>;
/** A history table made by `historyTable`, as the write kit's `actsOn` keeps it. */
export const historyOf = (table: string, owner: string): History<HistoryFields> => ({
  table,
  owner,
  type: (h, at) => typeHistory(h, at),
  insert: `INSERT INTO ${table} (id, ${owner}, position, at, by_kind, by_id, by_name, action, detail) VALUES (@id, @owner, @position, @at, @by_kind, @by_id, @by_name, @action, @detail)`,
  row: histRow,
});
export const histOut = (h: HistoryRow): HistoryFields => ({
  id: h.id,
  at: h.at,
  byKind: h.by_kind,
  byId: h.by_id,
  byName: h.by_name,
  action: h.action,
  detail: h.detail,
});
const verificationCols = (v: VerificationFields) => ({
  verification_status: v.status,
  verification_method: v.method,
  reviewer_id: v.reviewerId,
  reviewer_name: v.reviewerName,
  reviewed_at: v.reviewedAt,
});
const evidenceRow = (e: EvidenceFields) => ({
  id: e.id,
  player_id: e.playerId,
  claim_type: e.claimType,
  label: e.label,
  value_number: typeof e.value === 'number' ? e.value : null,
  value_text: typeof e.value === 'string' ? e.value : null,
  units: e.units,
  season: e.season,
  source_kind: e.source.kind,
  source_id: e.source.id,
  source_name: e.source.name,
  observed_at: e.observedAt,
  recorded_at: e.recordedAt,
  ...verificationCols(e.verification),
  expires_at: e.expiresAt,
  correction_of_id: e.correctionOf,
  superseded_by_id: e.supersededBy,
  note: e.note,
});
type EvidenceRow = RowOf<typeof evidenceRow>;
const mediaRow = (evidenceId: string, mediaId: string, position: number) => ({
  evidence_id: evidenceId,
  position,
  media_id: mediaId,
});
type MediaRow = RowOf<typeof mediaRow>;
const disputeRow = (evidenceId: string, d: DisputeFields, position: number) => ({
  id: d.id,
  evidence_id: evidenceId,
  position,
  filed_at: d.at,
  by_kind: d.by.kind,
  by_id: d.by.id,
  by_name: d.by.name,
  reason: d.reason,
  status: d.status,
  resolution_outcome: d.resolution?.outcome ?? null,
  resolution_note: d.resolution?.note ?? null,
  resolved_at: d.resolution?.at ?? null,
});
type DisputeRow = RowOf<typeof disputeRow>;
const affiliationRow = (a: AffiliationFields) => ({
  id: a.id,
  org_id: a.orgId,
  org_name: a.orgName,
  coach_name: a.coachName,
  coach_email: a.coachEmail,
  role: a.role,
  from_date: a.from,
  to_date: a.to,
  status: a.status,
  confirmed_by_user_id: a.confirmedBy.userId,
  confirmed_by_name: a.confirmedBy.name,
  conflict_of_interest: a.conflictOfInterest,
  created_at: a.createdAt,
});
type AffiliationRow = RowOf<typeof affiliationRow>;
const inviteRow = (i: InviteFields) => ({
  id: i.id,
  org_id: i.orgId,
  org_name: i.orgName,
  player_id: i.playerId,
  player_name: i.playerName,
  by_user_id: i.byUserId,
  by_name: i.byName,
  note: i.note,
  status: i.status,
  created_at: i.createdAt,
  responded_at: i.respondedAt,
});
type InviteRow = RowOf<typeof inviteRow>;

const EVIDENCE_COLS = columnsOf<EvidenceRow>()([
  'id',
  'player_id',
  'claim_type',
  'label',
  'value_number',
  'value_text',
  'units',
  'season',
  'source_kind',
  'source_id',
  'source_name',
  'observed_at',
  'recorded_at',
  'verification_status',
  'verification_method',
  'reviewer_id',
  'reviewer_name',
  'reviewed_at',
  'expires_at',
  'correction_of_id',
  'superseded_by_id',
  'note',
]);
const MEDIA_COLS = columnsOf<MediaRow>()(['evidence_id', 'position', 'media_id']);
const DISPUTE_COLS = columnsOf<DisputeRow>()([
  'id',
  'evidence_id',
  'position',
  'filed_at',
  'by_kind',
  'by_id',
  'by_name',
  'reason',
  'status',
  'resolution_outcome',
  'resolution_note',
  'resolved_at',
]);
const AFFILIATION_COLS = columnsOf<AffiliationRow>()([
  'id',
  'org_id',
  'org_name',
  'coach_name',
  'coach_email',
  'role',
  'from_date',
  'to_date',
  'status',
  'confirmed_by_user_id',
  'confirmed_by_name',
  'conflict_of_interest',
  'created_at',
]);
const INVITE_COLS = columnsOf<InviteRow>()([
  'id',
  'org_id',
  'org_name',
  'player_id',
  'player_name',
  'by_user_id',
  'by_name',
  'note',
  'status',
  'created_at',
  'responded_at',
]);

/** Prepared statements over one connection. */
function statements(sqlite: DatabaseSync) {
  const p = (sql: string) => sqlite.prepare(sql);
  return {
    evidence: insertFor(sqlite, 'evidence', EVIDENCE_COLS),
    media: insertFor(sqlite, 'evidence_media', MEDIA_COLS),
    dispute: insertFor(sqlite, 'evidence_disputes', DISPUTE_COLS),
    evHist: p(historyOf('evidence_history', 'evidence_id').insert),
    affiliation: insertFor(sqlite, 'coach_affiliations', AFFILIATION_COLS),
    affHist: p(historyOf('coach_affiliation_history', 'affiliation_id').insert),
    invite: insertFor(sqlite, 'squad_invites', INVITE_COLS),
    evidenceById: p('SELECT * FROM evidence WHERE id = ?'),
    affiliationById: p('SELECT * FROM coach_affiliations WHERE id = ?'),
    inviteById: p('SELECT * FROM squad_invites WHERE id = ?'),
    evidenceAll: p('SELECT * FROM evidence ORDER BY rowid'),
    affiliationAll: p('SELECT * FROM coach_affiliations ORDER BY rowid'),
    inviteAll: p('SELECT * FROM squad_invites ORDER BY rowid'),
    mediaBy: p('SELECT * FROM evidence_media WHERE evidence_id = ? ORDER BY position'),
    disputesBy: p('SELECT * FROM evidence_disputes WHERE evidence_id = ? ORDER BY position'),
    evHistBy: p('SELECT * FROM evidence_history WHERE evidence_id = ? ORDER BY position'),
    affHistBy: p('SELECT * FROM coach_affiliation_history WHERE affiliation_id = ? ORDER BY position'),
  };
}
type Statements = ReturnType<typeof statements>;
/** Reads a record's child rows: a prepared statement, or the same rows for many records at once (`childRowsOf`). */
type ChildReader = { all(parentId: string): Row[] };
/** What the decoders read children through. */
type Readers = Record<'mediaBy' | 'disputesBy' | 'evHistBy' | 'affHistBy', ChildReader>;
type BatchIds = { evidenceIds?: string[]; affiliationIds?: string[] };
/** The child statements for many records at once (one query per child table for a whole list). */
function batchStatements(
  sqlite: DatabaseSync,
  st: Statements,
  { evidenceIds = [], affiliationIds = [] }: BatchIds,
): Readers {
  return {
    ...st,
    mediaBy: childRowsOf(sqlite, 'evidence_media', 'evidence_id', evidenceIds, { order: 'position' }),
    disputesBy: childRowsOf(sqlite, 'evidence_disputes', 'evidence_id', evidenceIds, { order: 'position' }),
    evHistBy: childRowsOf(sqlite, 'evidence_history', 'evidence_id', evidenceIds, { order: 'position' }),
    affHistBy: childRowsOf(sqlite, 'coach_affiliation_history', 'affiliation_id', affiliationIds, {
      order: 'position',
    }),
  };
}
function writeEvidence(st: Statements, e: EvidenceFields) {
  st.evidence.run(evidenceRow(e));
  e.mediaIds.forEach((m, i) => st.media.run(mediaRow(e.id, m, i)));
  e.disputes.forEach((d, i) => st.dispute.run(disputeRow(e.id, d, i)));
  e.history.forEach((h, i) => st.evHist.run(histRow(e.id, h, i)));
}
function writeAffiliation(st: Statements, a: AffiliationFields) {
  st.affiliation.run(affiliationRow(a));
  a.history.forEach((h, i) => st.affHist.run(histRow(a.id, h, i)));
}
function writeInvite(st: Statements, i: InviteFields) {
  st.invite.run(inviteRow(i));
}
const WRITERS: { [N in ScoutingEvidenceCollection]: (st: Statements, r: FieldsOf[N]) => void } = {
  evidence: writeEvidence,
  coachAffiliations: writeAffiliation,
  squadInvites: writeInvite,
};
// A part's columns are written together from one typed value (the encoders above), so a resolution that reads back
// with an outcome has its time too.
const disputeOut = (d: DisputeRow): DisputeFields => ({
  id: d.id,
  at: d.filed_at,
  by: { kind: d.by_kind, id: d.by_id, name: d.by_name },
  reason: d.reason,
  status: d.status,
  resolution:
    d.resolution_outcome === null
      ? null
      : { outcome: d.resolution_outcome, note: d.resolution_note, at: d.resolved_at as number },
});
function decodeEvidence(st: Readers, r: EvidenceRow): EvidenceFields {
  return {
    id: r.id,
    playerId: r.player_id,
    claimType: r.claim_type,
    label: r.label,
    value: r.value_number ?? r.value_text ?? null,
    units: r.units,
    season: r.season,
    source: { kind: r.source_kind, id: r.source_id, name: r.source_name },
    observedAt: r.observed_at,
    recordedAt: r.recorded_at,
    mediaIds: (st.mediaBy.all(r.id) as MediaRow[]).map((m) => m.media_id),
    verification: {
      status: r.verification_status,
      method: r.verification_method,
      reviewerId: r.reviewer_id,
      reviewerName: r.reviewer_name,
      reviewedAt: r.reviewed_at,
    },
    expiresAt: r.expires_at,
    correctionOf: r.correction_of_id,
    supersededBy: r.superseded_by_id,
    disputes: (st.disputesBy.all(r.id) as DisputeRow[]).map(disputeOut),
    note: r.note,
    history: (st.evHistBy.all(r.id) as HistoryRow[]).map(histOut),
  };
}
const decodeAffiliation = (st: Readers, r: AffiliationRow): AffiliationFields => ({
  id: r.id,
  orgId: r.org_id,
  orgName: r.org_name,
  coachName: r.coach_name,
  coachEmail: r.coach_email,
  role: r.role,
  from: r.from_date,
  to: r.to_date,
  status: r.status,
  confirmedBy: { userId: r.confirmed_by_user_id, name: r.confirmed_by_name },
  conflictOfInterest: r.conflict_of_interest,
  createdAt: r.created_at,
  history: (st.affHistBy.all(r.id) as HistoryRow[]).map(histOut),
});
const decodeInvite = (r: InviteRow): InviteFields => ({
  id: r.id,
  orgId: r.org_id,
  orgName: r.org_name,
  playerId: r.player_id,
  playerName: r.player_name,
  byUserId: r.by_user_id,
  byName: r.by_name,
  note: r.note,
  status: r.status,
  createdAt: r.created_at,
  respondedAt: r.responded_at,
});
const DECODE: { [N in ScoutingEvidenceCollection]: (st: Readers, row: Row) => FieldsOf[N] } = {
  evidence: (st, row) => decodeEvidence(st, row as EvidenceRow),
  coachAffiliations: (st, row) => decodeAffiliation(st, row as AffiliationRow),
  squadInvites: (_st, row) => decodeInvite(row as InviteRow),
};
const BATCH_KEY: Partial<Record<ScoutingEvidenceCollection, keyof BatchIds>> = {
  evidence: 'evidenceIds',
  coachAffiliations: 'affiliationIds',
};

export const scoutingEvidenceLive = (sqlite: DatabaseSync) => migrationApplied(sqlite, SCOUTING_EVIDENCE_MIGRATION);
const PLAYER_REFS_SQL = {
  evidence:
    "SELECT player_id AS pid FROM evidence UNION ALL SELECT source_id FROM evidence WHERE source_kind = 'player' UNION ALL SELECT by_id FROM evidence_disputes WHERE by_kind = 'player'",
  squadInvites: 'SELECT player_id AS pid FROM squad_invites',
} as const;
type PlayerRefCounts = Record<keyof typeof PLAYER_REFS_SQL, number>;
const playerRefCounts = (sqlite: DatabaseSync, cond: string): PlayerRefCounts =>
  Object.fromEntries(
    Object.entries(PLAYER_REFS_SQL).map(([c, sql]) => [
      c,
      (sqlite.prepare(`SELECT count(*) AS n FROM (${sql}) x WHERE ${cond}`).get() as { n: number }).n,
    ]),
  ) as PlayerRefCounts;
export const unresolvedPlayerReferences = (sqlite: DatabaseSync): PlayerRefCounts | null =>
  scoutingEvidenceLive(sqlite)
    ? playerRefCounts(sqlite, 'NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid)')
    : null;
export const retainedPlayerReferences = (sqlite: DatabaseSync): PlayerRefCounts | null =>
  scoutingEvidenceLive(sqlite)
    ? playerRefCounts(sqlite, 'EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid AND p.deleted_at IS NOT NULL)')
    : null;

function readAll(sqlite: DatabaseSync): ScoutingEvidenceRecords {
  const st = statements(sqlite);
  const ev = st.evidenceAll.all() as EvidenceRow[];
  const af = st.affiliationAll.all() as AffiliationRow[];
  const bst = batchStatements(sqlite, st, { evidenceIds: ev.map((r) => r.id), affiliationIds: af.map((r) => r.id) });
  return {
    evidence: ev.map((r) => decodeEvidence(bst, r)),
    coachAffiliations: af.map((r) => decodeAffiliation(bst, r)),
    squadInvites: (st.inviteAll.all() as InviteRow[]).map(decodeInvite),
  };
}

/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const SCOUTING_EVIDENCE_RECORDS = {
  names: SCOUTING_EVIDENCE_COLLECTIONS,
  read(sqlite: DatabaseSync): ScoutingEvidenceRecords | null {
    return scoutingEvidenceLive(sqlite) ? readAll(sqlite) : null;
  },
};

// ------------------------------------------------------------------ the repository
/**
 * `createScoutingEvidenceRepository({ sqlite, unit, now, log })`: `evidence`, `coachAffiliations` and `squadInvites`,
 * each with `create(record)`, its named acts and its queries, plus `reads` (the queries alone, for `scoutingReads`).
 */
export function createScoutingEvidenceRepository(
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
  if (!sqlite) throw new TypeError('the scouting evidence repository needs a SQLite connection (node:sqlite)');
  const st = statements(sqlite);
  const operation = operationOn(sqlite, unit);
  const rowById: Record<ScoutingEvidenceCollection, StatementSync> = {
    evidence: st.evidenceById,
    coachAffiliations: st.affiliationById,
    squadInvites: st.inviteById,
  };
  const decode = <N extends ScoutingEvidenceCollection>(name: N, row: Row): RecordOf[N] =>
    deepFreeze(DECODE[name](st, row)) as RecordOf[N];
  const decodeAll = <N extends ScoutingEvidenceCollection>(name: N, rows: Row[]): RecordOf[N][] => {
    const key = BATCH_KEY[name];
    if (!key || rows.length < 2) return rows.map((r) => decode(name, r));
    const bst = batchStatements(sqlite, st, { [key]: rows.map((r) => r.id as string) });
    return rows.map((r) => deepFreeze(DECODE[name](bst, r)) as RecordOf[N]);
  };
  const read = <N extends ScoutingEvidenceCollection>(name: N, id: unknown): RecordOf[N] | null => {
    if (typeof id !== 'string') return null;
    const row = rowById[name].get(id);
    return row ? decode(name, row) : null;
  };
  const must = <N extends ScoutingEvidenceCollection>(name: N, id: string): RecordOf[N] => {
    const r = read(name, id);
    if (!r) throw refusal('SCOUTING_NOT_FOUND', `${TABLE_OF[name]} ${id} is not a record of the repository`);
    return r;
  };
  const typedOr = <T>(t: Typed<T>): T => {
    if (!t.ok) throw refusal('SCOUTING_INPUT_INVALID', t.reason);
    return t.record;
  };
  const list = <N extends ScoutingEvidenceCollection, A extends SQLInputValue[]>(name: N, sql: string) => {
    const stmt = sqlite.prepare(sql);
    return (...args: A): RecordOf[N][] => decodeAll(name, stmt.all(...args));
  };
  const pendingInvite = sqlite.prepare(
    "SELECT * FROM squad_invites WHERE org_id = ? AND player_id = ? AND status IN ('pending_guardian','pending_player')",
  );
  const create =
    <N extends ScoutingEvidenceCollection>(name: N) =>
    (raw: InputOf[N]): RecordOf[N] =>
      operation(() => {
        const r = typedOr(TYPERS[name](raw, name));
        if (rowById[name].get(r.id)) throw refusal('SCOUTING_DUPLICATE', `${TABLE_OF[name]} ${r.id} already exists`);
        if (name === 'squadInvites') {
          const i = r as InviteFields;
          if (i.status.startsWith('pending') && pendingInvite.get(i.orgId, i.playerId))
            throw refusal(
              'SCOUTING_UNIQUENESS',
              `squad_invites: organisation ${i.orgId} already has a pending invitation for player ${i.playerId}`,
            );
        }
        WRITERS[name](st, r);
        return must(name, r.id);
      });
  const { guarded, nextPosition, actsOn } = writeKit(sqlite, 'SCOUTING');
  // An act's input is judged by the columns, so a caller in JavaScript may leave out what a verification can hold as null.
  const verificationIn = (v: EvidenceVerificationInput): VerificationFields => ({
    status: v.status,
    method: v.method ?? null,
    reviewerId: v.reviewerId ?? null,
    reviewerName: v.reviewerName ?? null,
    reviewedAt: v.reviewedAt ?? null,
  });
  /**
   * A record's acts. A current self-reported record is corroborated once; a record is superseded once, by a correction
   * of it; a dispute is filed open and resolved once, an upheld one optionally downgrading the record.
   */
  const evidenceWrites = actsOn(
    {
      operation,
      label: 'evidence',
      must: (id) => must('evidence', id),
      history: historyOf('evidence_history', 'evidence_id'),
    },
    {
      corroborate: (id, { verification }: { verification: EvidenceVerificationInput }) =>
        guarded(
          'evidence',
          { id },
          "verification_status = 'self_reported' AND superseded_by_id IS NULL",
          verificationCols(verificationIn(verification)),
          `evidence ${id} is already verified or superseded`,
        ),
      supersede: (id, { by }: { by: string }) =>
        guarded(
          'evidence',
          { id },
          'superseded_by_id IS NULL AND EXISTS (SELECT 1 FROM evidence c WHERE c.id = @superseded_by_id AND c.correction_of_id = @key_id)',
          { superseded_by_id: by },
          `evidence ${id} is already superseded, or ${by} is not a correction of it`,
        ),
      fileDispute: (id, { dispute: d }: { dispute: DisputeFiling }) =>
        st.dispute.run({
          id: d.id,
          evidence_id: id,
          position: nextPosition('evidence_disputes', 'evidence_id', id),
          filed_at: d.at,
          by_kind: d.by?.kind ?? null,
          by_id: d.by?.id ?? null,
          by_name: d.by?.name ?? null,
          reason: d.reason,
          status: 'open',
          resolution_outcome: null,
          resolution_note: null,
          resolved_at: null,
        }),
      resolveDispute: (
        id,
        {
          disputeId,
          outcome,
          note = null,
          at,
          downgrade = null,
        }: {
          disputeId: string;
          outcome: DisputeOutcome;
          note?: string | null;
          at: number;
          downgrade?: EvidenceVerificationInput | null;
        },
      ) => {
        guarded(
          'evidence_disputes',
          { id: disputeId, evidence_id: id },
          "status = 'open'",
          { status: 'resolved', resolution_outcome: outcome, resolution_note: note, resolved_at: at },
          `evidence_disputes ${disputeId} is not an open dispute of evidence ${id}`,
        );
        if (downgrade)
          guarded('evidence', { id }, '', verificationCols(verificationIn(downgrade)), `evidence ${id} is not stored`);
      },
    },
  );
  const affiliationWrites = actsOn(
    {
      operation,
      label: 'coach_affiliations',
      must: (id) => must('coachAffiliations', id),
      history: historyOf('coach_affiliation_history', 'affiliation_id'),
    },
    {
      /** End or revoke a confirmed affiliation on `to` (a day); either is final. */
      close: (id, { status, to }: { status: ClosedAffiliationStatus; to: string }) => {
        if (!oneOf(CLOSED_AFFILIATION_STATUSES, status))
          throw refusal('SCOUTING_INPUT_INVALID', `coach_affiliations ${id}: a closed affiliation is ended or revoked`);
        if (!dayOnly(to))
          throw refusal('SCOUTING_INPUT_INVALID', `coach_affiliations ${id}.to must be a day (YYYY-MM-DD)`);
        guarded(
          'coach_affiliations',
          { id },
          "status = 'confirmed'",
          { status, to_date: to },
          `coach_affiliations ${id} is not current`,
        );
      },
    },
  );
  const inviteWrites = actsOn(
    { operation, label: 'squad_invites', must: (id) => must('squadInvites', id) },
    {
      /** A pending invitation is approved or declined at `at`, once. */
      respond: (id, { accept, at }: { accept: boolean; at: number }) =>
        guarded(
          'squad_invites',
          { id },
          "status IN ('pending_guardian','pending_player')",
          { status: accept === true ? 'approved' : 'declined', responded_at: at },
          `squad_invites ${id} is already answered`,
        ),
    },
  );

  const disputeCount = {
    open: sqlite.prepare("SELECT COUNT(*) AS n FROM evidence_disputes WHERE status = 'open'"),
    all: sqlite.prepare('SELECT COUNT(*) AS n FROM evidence_disputes'),
  };
  const disputePage = {
    open: sqlite.prepare(
      "SELECT d.*, e.player_id AS e_player_id, e.label AS e_label, e.verification_status AS e_tier FROM evidence_disputes d JOIN evidence e ON e.id = d.evidence_id WHERE d.status = 'open' ORDER BY d.filed_at, d.rowid LIMIT ? OFFSET ?",
    ),
    all: sqlite.prepare(
      'SELECT d.*, e.player_id AS e_player_id, e.label AS e_label, e.verification_status AS e_tier FROM evidence_disputes d JOIN evidence e ON e.id = d.evidence_id ORDER BY d.filed_at, d.rowid LIMIT ? OFFSET ?',
    ),
  };
  type DisputePageRow = DisputeRow & { e_player_id: string; e_label: string; e_tier: EvidenceTier };
  const disputeOwner = sqlite.prepare('SELECT evidence_id FROM evidence_disputes WHERE id = ?');
  const evidenceCreate = { create: create('evidence') };
  const evidence = {
    ...evidenceCreate,
    ...evidenceWrites,
    byId: (id: unknown) => read('evidence', id),
    /** A player's records, oldest first (the passport, the export, the provider lists). */
    forPlayer: list<'evidence', [playerId: string]>(
      'evidence',
      'SELECT * FROM evidence WHERE player_id = ? ORDER BY rowid',
    ),
    /** A player's current records: not superseded by a correction. */
    currentForPlayer: list<'evidence', [playerId: string]>(
      'evidence',
      'SELECT * FROM evidence WHERE player_id = ? AND superseded_by_id IS NULL ORDER BY rowid',
    ),
    /** The record holding dispute `disputeId`, or null. */
    byDispute: (disputeId: unknown): Evidence | null => {
      const r =
        typeof disputeId === 'string' ? (disputeOwner.get(disputeId) as { evidence_id: string } | undefined) : null;
      return r ? read('evidence', r.evidence_id) : null;
    },
    /**
     * The admin dispute queue, oldest first, by offset (the admin app's `{ total, limit, offset, items }`): each
     * dispute with its record's id, player, label and tier. `all` includes resolved disputes.
     */
    disputePage({ all = false, limit, offset }: OffsetPage & { all?: boolean }): OffsetPageOf<DisputeQueueItem> {
      const which = all ? 'all' : 'open';
      const items: DisputeQueueItemFields[] = (disputePage[which].all(limit, offset) as DisputePageRow[]).map((d) => ({
        ...disputeOut(d),
        evidenceId: d.evidence_id,
        playerId: d.e_player_id,
        label: d.e_label,
        tier: d.e_tier,
      }));
      return {
        total: (disputeCount[which].get() as { n: number }).n,
        limit,
        offset,
        items: deepFreeze(items) as DisputeQueueItem[],
      };
    },
  };
  const affiliationPage = sqlite.prepare(
    'SELECT * FROM coach_affiliations ORDER BY created_at DESC, rowid LIMIT ? OFFSET ?',
  );
  const affiliationCount = sqlite.prepare('SELECT COUNT(*) AS n FROM coach_affiliations');
  const confirmedForOrg = list<'coachAffiliations', [orgId: string]>(
    'coachAffiliations',
    "SELECT * FROM coach_affiliations WHERE org_id = ? AND status = 'confirmed' ORDER BY rowid",
  );
  const affiliationCreate = { create: create('coachAffiliations') };
  const coachAffiliations = {
    ...affiliationCreate,
    ...affiliationWrites,
    byId: (id: unknown) => read('coachAffiliations', id),
    forOrg: list<'coachAffiliations', [orgId: string]>(
      'coachAffiliations',
      'SELECT * FROM coach_affiliations WHERE org_id = ? ORDER BY rowid',
    ),
    /** The confirmed affiliation at `orgId` whose coach name matches `userName` (case-insensitive), or undefined. */
    activeFor: (orgId: string, userName: unknown): CoachAffiliation | undefined =>
      confirmedForOrg(orgId).find((a) => a.coachName.toLowerCase() === String(userName ?? '').toLowerCase()),
    /** Every organisation's affiliations, newest first, by offset (the admin list). */
    page({ limit, offset }: OffsetPage): OffsetPageOf<CoachAffiliation> {
      return {
        total: (affiliationCount.get() as { n: number }).n,
        limit,
        offset,
        items: decodeAll('coachAffiliations', affiliationPage.all(limit, offset)),
      };
    },
  };
  const invitesFor = sqlite.prepare(
    'SELECT * FROM squad_invites WHERE status = ? AND player_id IN (SELECT value FROM json_each(?)) ORDER BY rowid',
  );
  const inviteCreate = { create: create('squadInvites') };
  const squadInvites = {
    ...inviteCreate,
    ...inviteWrites,
    byId: (id: unknown) => read('squadInvites', id),
    /** The pending invitation from `orgId` to `playerId`, or null (at most one). */
    pendingFor: (orgId: string, playerId: string): SquadInvite | null => {
      const r = pendingInvite.get(orgId, playerId);
      return r ? decode('squadInvites', r) : null;
    },
    /** The invitations to any of `playerIds` in `status`, oldest first. */
    forPlayers(playerIds: readonly unknown[] | null | undefined, status: InviteStatus): SquadInvite[] {
      const want = [...new Set((playerIds ?? []).filter((p) => typeof p === 'string'))];
      if (!want.length) return [];
      return decodeAll('squadInvites', invitesFor.all(status, JSON.stringify(want)));
    },
  };
  const writeKeys = (...w: object[]) => w.flatMap((o) => Object.keys(o));
  const counters = Object.fromEntries(
    SCOUTING_EVIDENCE_COLLECTIONS.map((n) => [n, sqlite.prepare(`SELECT COUNT(*) AS n FROM ${TABLE_OF[n]}`)]),
  ) as Record<ScoutingEvidenceCollection, StatementSync>;
  return {
    evidence,
    coachAffiliations,
    squadInvites,
    /** The queries alone, for modules and projectors that must not write (`scoutingReads`). */
    reads: Object.freeze({
      evidence: readsOf(evidence, writeKeys(evidenceCreate, evidenceWrites) as (keyof typeof evidence)[]),
      coachAffiliations: readsOf(
        coachAffiliations,
        writeKeys(affiliationCreate, affiliationWrites) as (keyof typeof coachAffiliations)[],
      ),
      squadInvites: readsOf(squadInvites, writeKeys(inviteCreate, inviteWrites) as (keyof typeof squadInvites)[]),
    }),
    attach() {
      if (!scoutingEvidenceLive(sqlite))
        throw new Error(
          `the scouting evidence repository needs ${SCOUTING_EVIDENCE_MIGRATION} recorded; it never imports an in-memory array`,
        );
      return { counts: this.counts() };
    },
    counts(): Record<ScoutingEvidenceCollection, number> {
      return Object.fromEntries(
        SCOUTING_EVIDENCE_COLLECTIONS.map((n) => [n, (counters[n].get() as { n: number }).n]),
      ) as Record<ScoutingEvidenceCollection, number>;
    },
    exportAll(): ScoutingEvidenceRecords | null {
      return SCOUTING_EVIDENCE_RECORDS.read(sqlite);
    },
    log,
    now,
  };
}
export type ScoutingEvidenceRepository = ReturnType<typeof createScoutingEvidenceRepository>;
export type ScoutingEvidenceReads = ScoutingEvidenceRepository['reads'];
