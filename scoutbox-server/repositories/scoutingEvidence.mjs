/**
 * The evidence passport, coach affiliations and squad invitations.
 *
 * Tables: evidence, evidence_media, evidence_disputes, evidence_history; coach_affiliations, coach_affiliation_history;
 * squad_invites. Every field is a typed column with its vocabulary and length CHECKs; there are no side columns, and a
 * record the columns cannot hold is refused with its id — at the repository (the routes check first and answer 400).
 *
 * WRITES are explicit: `create(record)` and `update(id, (draft) => …)` type the whole record and write its rows at once,
 * joined into the open unit of work (a failure poisons it), the caller's open transaction, or a transaction of their
 * own. An unknown field is refused, and so is an update of a record from inside its own update.
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
import { isPlainObject, ids, describe } from './fieldSpecs.mjs';
import { migrationApplied, childRowsOf, operationOn } from './database.mjs';
import { deepFreeze } from '../domains/platform/values.mjs';

export const SCOUTING_EVIDENCE_MIGRATION = '0019_scouting_evidence';
export const SCOUTING_EVIDENCE_COLLECTIONS = Object.freeze(['evidence', 'coachAffiliations', 'squadInvites']);
export const SCOUTING_EVIDENCE_TABLES = Object.freeze([
  'evidence',
  'evidence_media',
  'evidence_disputes',
  'evidence_history',
  'coach_affiliations',
  'coach_affiliation_history',
  'squad_invites',
]);

export const CLAIM_TYPES = Object.freeze([
  'statistic',
  'attendance',
  'assessment_result',
  'reference',
  'footage',
  'availability',
]);
/** The tiers a record can hold. 'independent' exists in the tier ladder but no route can set it, so no row holds it. */
export const EVIDENCE_TIERS_STORED = Object.freeze(['self_reported', 'coach_confirmed', 'club_assessed']);
export const EVIDENCE_SOURCE_KINDS = Object.freeze(['player', 'guardian', 'org']);
export const DISPUTE_BY_KINDS = Object.freeze(['player', 'org']);
export const DISPUTE_OUTCOMES = Object.freeze(['upheld', 'rejected']);
export const AFFILIATION_STATUSES = Object.freeze(['confirmed', 'ended', 'revoked']);
export const INVITE_STATUSES = Object.freeze(['pending_guardian', 'pending_player', 'approved', 'declined']);
export const HISTORY_BY_KINDS = Object.freeze(['player', 'guardian', 'org', 'admin']);
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

// ------------------------------------------------------------------ DDL
export const txt = (col, max, { notNull = false } = {}) =>
  `TEXT${notNull ? ' NOT NULL' : ''} CHECK (${notNull ? '' : `${col} IS NULL OR `}length(${col}) <= ${max})`;
export const historyTable = (table, owner, ownerTable) => `
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
// The helpers below are shared with the scouting assessments repository (scoutingAssessments.mjs).
export const refusal = (code, message, extra = {}) =>
  Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
export const isInt = (v) => Number.isSafeInteger(v);
export const isStr = (v) => typeof v === 'string';
export const nonEmpty = (v) => isStr(v) && v.length > 0;
export const orNull = (v) => (v === undefined ? null : v);
export const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
export const bad = (at, field, what) => ({ ok: false, reason: `${at}.${field} ${what}` });
const dayOnly = (v) => isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v);
/** Text that is optional (null/absent) or a string of at most `max` characters. */
export function optText(rec, at, field, max) {
  const v = rec[field];
  if (v === undefined || v === null) return null;
  if (!isStr(v)) return bad(at, field, `must be text or null (got ${describe(v)})`);
  if (v.length > max) return bad(at, field, `exceeds ${max} characters`);
  return null;
}
export function reqText(rec, at, field, max) {
  const v = rec[field];
  if (!nonEmpty(v)) return bad(at, field, `must be non-empty text (got ${describe(v)})`);
  if (v.length > max) return bad(at, field, `exceeds ${max} characters`);
  return null;
}
export const optInstant = (rec, at, field) =>
  rec[field] === undefined || rec[field] === null || isInt(rec[field])
    ? null
    : bad(at, field, `must be an integer instant or null (got ${describe(rec[field])})`);
export const reqInstant = (rec, at, field) =>
  isInt(rec[field]) ? null : bad(at, field, `must be an integer instant (got ${describe(rec[field])})`);
export const unknownFields = (rec, at, known) => {
  const extra = Object.keys(rec).filter((k) => !known.includes(k));
  return extra.length
    ? { ok: false, reason: `${at} carries field(s) this build does not store: ${extra.join(', ')}` }
    : null;
};
export const first = (...checks) => checks.find((c) => c) ?? null;

/** One history entry, the shared shape `{ id, at, byKind, byId, byName, action, detail }` (detail is text or null). */
export function typeHistory(h, at, kinds = HISTORY_BY_KINDS) {
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
  if (h.byKind !== undefined && h.byKind !== null && !kinds.includes(h.byKind))
    return bad(at, 'byKind', `must be one of ${kinds.join('|')} or null (got ${describe(h.byKind)})`);
  return {
    ok: true,
    record: {
      id: h.id,
      at: h.at,
      byKind: orNull(h.byKind),
      byId: orNull(h.byId),
      byName: orNull(h.byName),
      action: h.action,
      detail: orNull(h.detail),
    },
  };
}
export function typeList(list, at, typer, ...rest) {
  if (list === undefined || list === null) return { ok: true, list: [] };
  if (!Array.isArray(list)) return bad(at, '', `must be an array (got ${describe(list)})`);
  const out = [];
  const seen = new Set();
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
];
function typeDispute(d, at) {
  if (!isPlainObject(d)) return { ok: false, reason: `${at} is not an object (${describe(d)})` };
  const problem = first(
    unknownFields(d, at, ['id', 'at', 'by', 'reason', 'status', 'resolution']),
    reqText(d, at, 'id', 80),
    reqInstant(d, at, 'at'),
    reqText(d, at, 'reason', L.reason),
  );
  if (problem) return problem;
  if (
    !isPlainObject(d.by) ||
    !DISPUTE_BY_KINDS.includes(d.by.kind) ||
    !nonEmpty(d.by.id) ||
    !nonEmpty(d.by.name) ||
    d.by.name.length > L.name ||
    Object.keys(d.by).some((k) => !['kind', 'id', 'name'].includes(k))
  )
    return bad(at, 'by', `must be {kind: ${DISPUTE_BY_KINDS.join('|')}, id, name}`);
  if (!['open', 'resolved'].includes(d.status))
    return bad(at, 'status', `must be open or resolved (got ${describe(d.status)})`);
  let resolution = null;
  if (d.resolution !== undefined && d.resolution !== null) {
    const r = d.resolution;
    if (
      !isPlainObject(r) ||
      !DISPUTE_OUTCOMES.includes(r.outcome) ||
      !isInt(r.at) ||
      Object.keys(r).some((k) => !['outcome', 'note', 'at'].includes(k))
    )
      return bad(at, 'resolution', `must be {outcome: ${DISPUTE_OUTCOMES.join('|')}, note, at} or null`);
    const p = optText(r, `${at}.resolution`, 'note', L.resolutionNote);
    if (p) return p;
    resolution = { outcome: r.outcome, note: orNull(r.note), at: r.at };
  }
  if ((d.status === 'resolved') !== (resolution !== null))
    return bad(
      at,
      'resolution',
      d.status === 'resolved' ? 'is required on a resolved dispute' : 'is present on an open dispute',
    );
  return {
    ok: true,
    record: {
      id: d.id,
      at: d.at,
      by: { kind: d.by.kind, id: d.by.id, name: d.by.name },
      reason: d.reason,
      status: d.status,
      resolution,
    },
  };
}
/** The evidence record the routes produce, typed. `{ ok, record }` or `{ ok: false, reason }` naming the field — never its content. */
export function typeEvidence(raw, at = 'evidence') {
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
  if (!CLAIM_TYPES.includes(raw.claimType))
    return bad(label, 'claimType', `must be one of ${CLAIM_TYPES.join('|')} (got ${describe(raw.claimType)})`);
  const v = raw.value;
  if (!(v === undefined || v === null || Number.isFinite(v) || (isStr(v) && v.length <= L.valueText)))
    return bad(
      label,
      'value',
      `must be a number, text of at most ${L.valueText} characters, or null (got ${describe(v)})`,
    );
  const s = raw.source;
  if (
    !isPlainObject(s) ||
    !EVIDENCE_SOURCE_KINDS.includes(s.kind) ||
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
  if (!EVIDENCE_TIERS_STORED.includes(ver.status))
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
  let mediaIds = [];
  if (raw.mediaIds !== undefined && raw.mediaIds !== null) {
    if (!Array.isArray(raw.mediaIds) || raw.mediaIds.some((m) => !nonEmpty(m)))
      return bad(label, 'mediaIds', 'must be an array of media ids');
    if (new Set(raw.mediaIds).size !== raw.mediaIds.length) return bad(label, 'mediaIds', 'names a media item twice');
    mediaIds = [...raw.mediaIds];
  }
  if (raw.correctionOf && raw.correctionOf === raw.id) return bad(label, 'correctionOf', 'names the record itself');
  if (raw.supersededBy && raw.supersededBy === raw.id) return bad(label, 'supersededBy', 'names the record itself');
  const disputes = typeList(raw.disputes, `${label}.disputes`, typeDispute);
  if (!disputes.ok) return disputes;
  const history = typeList(raw.history, `${label}.history`, typeHistory);
  if (!history.ok) return history;
  return {
    ok: true,
    record: {
      id: raw.id,
      playerId: raw.playerId,
      claimType: raw.claimType,
      label: raw.label,
      value: orNull(v),
      units: orNull(raw.units),
      season: orNull(raw.season),
      source: { kind: s.kind, id: s.id, name: s.name },
      observedAt: orNull(raw.observedAt),
      recordedAt: raw.recordedAt,
      mediaIds,
      verification: {
        status: ver.status,
        method: orNull(ver.method),
        reviewerId: orNull(ver.reviewerId),
        reviewerName: orNull(ver.reviewerName),
        reviewedAt: orNull(ver.reviewedAt),
      },
      expiresAt: orNull(raw.expiresAt),
      correctionOf: orNull(raw.correctionOf),
      supersededBy: orNull(raw.supersededBy),
      disputes: disputes.list,
      note: orNull(raw.note),
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
];
export function typeCoachAffiliation(raw, at = 'coachAffiliations') {
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
  if (raw.to !== undefined && raw.to !== null && !dayOnly(raw.to))
    return bad(label, 'to', 'must be a YYYY-MM-DD day or null');
  if (!AFFILIATION_STATUSES.includes(raw.status))
    return bad(label, 'status', `must be one of ${AFFILIATION_STATUSES.join('|')} (got ${describe(raw.status)})`);
  if ((raw.status === 'confirmed') !== (raw.to === undefined || raw.to === null))
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
  return {
    ok: true,
    record: {
      id: raw.id,
      orgId: raw.orgId,
      orgName: raw.orgName,
      coachName: raw.coachName,
      coachEmail: orNull(raw.coachEmail),
      role: raw.role,
      from: raw.from,
      to: orNull(raw.to),
      status: raw.status,
      confirmedBy: { userId: c.userId, name: c.name },
      conflictOfInterest: orNull(raw.conflictOfInterest),
      createdAt: raw.createdAt,
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
];
export function typeSquadInvite(raw, at = 'squadInvites') {
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
  if (!INVITE_STATUSES.includes(raw.status))
    return bad(label, 'status', `must be one of ${INVITE_STATUSES.join('|')} (got ${describe(raw.status)})`);
  const answered = ['approved', 'declined'].includes(raw.status);
  if (answered !== (raw.respondedAt !== undefined && raw.respondedAt !== null))
    return bad(
      label,
      'respondedAt',
      answered ? 'is required once the invitation is answered' : 'must be null while the invitation is pending',
    );
  return {
    ok: true,
    record: {
      id: raw.id,
      orgId: raw.orgId,
      orgName: raw.orgName,
      playerId: raw.playerId,
      playerName: orNull(raw.playerName),
      byUserId: raw.byUserId,
      byName: raw.byName,
      note: orNull(raw.note),
      status: raw.status,
      createdAt: raw.createdAt,
      respondedAt: orNull(raw.respondedAt),
    },
  };
}
const TYPERS = { evidence: typeEvidence, coachAffiliations: typeCoachAffiliation, squadInvites: typeSquadInvite };
const TABLE_OF = { evidence: 'evidence', coachAffiliations: 'coach_affiliations', squadInvites: 'squad_invites' };

// ------------------------------------------------------------------ rows
function statements(sqlite) {
  const p = (sql) => sqlite.prepare(sql);
  return {
    evidence:
      p(`INSERT INTO evidence (id, player_id, claim_type, label, value_number, value_text, units, season, source_kind, source_id, source_name, observed_at, recorded_at, verification_status, verification_method, reviewer_id, reviewer_name, reviewed_at, expires_at, correction_of_id, superseded_by_id, note)
      VALUES (@id, @player_id, @claim_type, @label, @value_number, @value_text, @units, @season, @source_kind, @source_id, @source_name, @observed_at, @recorded_at, @verification_status, @verification_method, @reviewer_id, @reviewer_name, @reviewed_at, @expires_at, @correction_of_id, @superseded_by_id, @note)
      ON CONFLICT(id) DO UPDATE SET player_id = excluded.player_id, claim_type = excluded.claim_type, label = excluded.label, value_number = excluded.value_number, value_text = excluded.value_text, units = excluded.units, season = excluded.season,
        source_kind = excluded.source_kind, source_id = excluded.source_id, source_name = excluded.source_name, observed_at = excluded.observed_at, recorded_at = excluded.recorded_at, verification_status = excluded.verification_status,
        verification_method = excluded.verification_method, reviewer_id = excluded.reviewer_id, reviewer_name = excluded.reviewer_name, reviewed_at = excluded.reviewed_at, expires_at = excluded.expires_at,
        correction_of_id = excluded.correction_of_id, superseded_by_id = excluded.superseded_by_id, note = excluded.note`),
    media: p('INSERT INTO evidence_media (evidence_id, position, media_id) VALUES (?, ?, ?)'),
    dispute: p(
      'INSERT INTO evidence_disputes (id, evidence_id, position, filed_at, by_kind, by_id, by_name, reason, status, resolution_outcome, resolution_note, resolved_at) VALUES (@id, @evidence_id, @position, @filed_at, @by_kind, @by_id, @by_name, @reason, @status, @resolution_outcome, @resolution_note, @resolved_at)',
    ),
    evHist: p(
      'INSERT INTO evidence_history (id, evidence_id, position, at, by_kind, by_id, by_name, action, detail) VALUES (@id, @owner, @position, @at, @by_kind, @by_id, @by_name, @action, @detail)',
    ),
    mediaOf: p('DELETE FROM evidence_media WHERE evidence_id = ?'),
    disputesOf: p('DELETE FROM evidence_disputes WHERE evidence_id = ?'),
    evHistOf: p('DELETE FROM evidence_history WHERE evidence_id = ?'),
    evidenceDel: p('DELETE FROM evidence WHERE id = ?'),
    clearSelfRefs: p('UPDATE evidence SET correction_of_id = NULL, superseded_by_id = NULL WHERE id = ?'),
    setSelfRefs: p('UPDATE evidence SET correction_of_id = ?, superseded_by_id = ? WHERE id = ?'),
    affiliation:
      p(`INSERT INTO coach_affiliations (id, org_id, org_name, coach_name, coach_email, role, from_date, to_date, status, confirmed_by_user_id, confirmed_by_name, conflict_of_interest, created_at)
      VALUES (@id, @org_id, @org_name, @coach_name, @coach_email, @role, @from_date, @to_date, @status, @confirmed_by_user_id, @confirmed_by_name, @conflict_of_interest, @created_at)
      ON CONFLICT(id) DO UPDATE SET org_id = excluded.org_id, org_name = excluded.org_name, coach_name = excluded.coach_name, coach_email = excluded.coach_email, role = excluded.role, from_date = excluded.from_date, to_date = excluded.to_date,
        status = excluded.status, confirmed_by_user_id = excluded.confirmed_by_user_id, confirmed_by_name = excluded.confirmed_by_name, conflict_of_interest = excluded.conflict_of_interest, created_at = excluded.created_at`),
    affHist: p(
      'INSERT INTO coach_affiliation_history (id, affiliation_id, position, at, by_kind, by_id, by_name, action, detail) VALUES (@id, @owner, @position, @at, @by_kind, @by_id, @by_name, @action, @detail)',
    ),
    affHistOf: p('DELETE FROM coach_affiliation_history WHERE affiliation_id = ?'),
    affiliationDel: p('DELETE FROM coach_affiliations WHERE id = ?'),
    invite:
      p(`INSERT INTO squad_invites (id, org_id, org_name, player_id, player_name, by_user_id, by_name, note, status, created_at, responded_at)
      VALUES (@id, @org_id, @org_name, @player_id, @player_name, @by_user_id, @by_name, @note, @status, @created_at, @responded_at)
      ON CONFLICT(id) DO UPDATE SET org_id = excluded.org_id, org_name = excluded.org_name, player_id = excluded.player_id, player_name = excluded.player_name, by_user_id = excluded.by_user_id, by_name = excluded.by_name,
        note = excluded.note, status = excluded.status, created_at = excluded.created_at, responded_at = excluded.responded_at`),
    inviteDel: p('DELETE FROM squad_invites WHERE id = ?'),
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
    ids: (table) =>
      sqlite
        .prepare(`SELECT id FROM ${table} ORDER BY rowid`)
        .all()
        .map((r) => r.id),
  };
}
/** The child statements for many records at once (one query per child table for a whole list). */
function batchStatements(sqlite, st, { evidenceIds = [], affiliationIds = [] }) {
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
export const histRow = (owner, h, position) => ({
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
export const histOut = (h) => ({
  id: h.id,
  at: h.at,
  byKind: h.by_kind,
  byId: h.by_id,
  byName: h.by_name,
  action: h.action,
  detail: h.detail,
});
function evidenceRow(e, { selfRefs = true } = {}) {
  return {
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
    verification_status: e.verification.status,
    verification_method: e.verification.method,
    reviewer_id: e.verification.reviewerId,
    reviewer_name: e.verification.reviewerName,
    reviewed_at: e.verification.reviewedAt,
    expires_at: e.expiresAt,
    correction_of_id: selfRefs ? e.correctionOf : null,
    superseded_by_id: selfRefs ? e.supersededBy : null,
    note: e.note,
  };
}
function writeEvidence(st, e, opts) {
  st.evidence.run(evidenceRow(e, opts));
  st.mediaOf.run(e.id);
  st.disputesOf.run(e.id);
  st.evHistOf.run(e.id);
  e.mediaIds.forEach((m, i) => st.media.run(e.id, i, m));
  e.disputes.forEach((d, i) =>
    st.dispute.run({
      id: d.id,
      evidence_id: e.id,
      position: i,
      filed_at: d.at,
      by_kind: d.by.kind,
      by_id: d.by.id,
      by_name: d.by.name,
      reason: d.reason,
      status: d.status,
      resolution_outcome: d.resolution?.outcome ?? null,
      resolution_note: d.resolution?.note ?? null,
      resolved_at: d.resolution?.at ?? null,
    }),
  );
  e.history.forEach((h, i) => st.evHist.run(histRow(e.id, h, i)));
}
function writeAffiliation(st, a) {
  st.affiliation.run({
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
  st.affHistOf.run(a.id);
  a.history.forEach((h, i) => st.affHist.run(histRow(a.id, h, i)));
}
function writeInvite(st, i) {
  st.invite.run({
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
}
const WRITERS = { evidence: writeEvidence, coachAffiliations: writeAffiliation, squadInvites: writeInvite };
function decodeEvidence(st, r) {
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
    mediaIds: st.mediaBy.all(r.id).map((m) => m.media_id),
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
    disputes: st.disputesBy.all(r.id).map((d) => ({
      id: d.id,
      at: d.filed_at,
      by: { kind: d.by_kind, id: d.by_id, name: d.by_name },
      reason: d.reason,
      status: d.status,
      resolution:
        d.resolution_outcome === null
          ? null
          : { outcome: d.resolution_outcome, note: d.resolution_note, at: d.resolved_at },
    })),
    note: r.note,
    history: st.evHistBy.all(r.id).map(histOut),
  };
}
const decodeAffiliation = (st, r) => ({
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
  history: st.affHistBy.all(r.id).map(histOut),
});
const decodeInvite = (_st, r) => ({
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
const DECODERS = { evidence: decodeEvidence, coachAffiliations: decodeAffiliation, squadInvites: decodeInvite };
const BATCH_KEY = { evidence: 'evidenceIds', coachAffiliations: 'affiliationIds' };

export const scoutingEvidenceLive = (sqlite) => migrationApplied(sqlite, SCOUTING_EVIDENCE_MIGRATION);
const PLAYER_REFS_SQL = {
  evidence:
    "SELECT player_id AS pid FROM evidence UNION ALL SELECT source_id FROM evidence WHERE source_kind = 'player' UNION ALL SELECT by_id FROM evidence_disputes WHERE by_kind = 'player'",
  squadInvites: 'SELECT player_id AS pid FROM squad_invites',
};
const playerRefCounts = (sqlite, cond) =>
  Object.fromEntries(
    Object.entries(PLAYER_REFS_SQL).map(([c, sql]) => [
      c,
      sqlite.prepare(`SELECT count(*) AS n FROM (${sql}) x WHERE ${cond}`).get().n,
    ]),
  );
export const unresolvedPlayerReferences = (sqlite) =>
  scoutingEvidenceLive(sqlite)
    ? playerRefCounts(sqlite, 'NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid)')
    : null;
export const retainedPlayerReferences = (sqlite) =>
  scoutingEvidenceLive(sqlite)
    ? playerRefCounts(sqlite, 'EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid AND p.deleted_at IS NOT NULL)')
    : null;

function readAll(sqlite) {
  const st = statements(sqlite);
  const ev = st.evidenceAll.all();
  const af = st.affiliationAll.all();
  const bst = batchStatements(sqlite, st, { evidenceIds: ev.map((r) => r.id), affiliationIds: af.map((r) => r.id) });
  return {
    evidence: ev.map((r) => decodeEvidence(bst, r)),
    coachAffiliations: af.map((r) => decodeAffiliation(bst, r)),
    squadInvites: st.inviteAll.all().map((r) => decodeInvite(st, r)),
  };
}

/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const SCOUTING_EVIDENCE_RECORDS = {
  names: SCOUTING_EVIDENCE_COLLECTIONS,
  read(sqlite) {
    return scoutingEvidenceLive(sqlite) ? readAll(sqlite) : null;
  },
};

// ------------------------------------------------------------------ the repository
const WRITES = new Set(['create', 'update']);
/**
 * `createScoutingEvidenceRepository({ sqlite, unit, now, log })`: `evidence`, `coachAffiliations` and `squadInvites`,
 * each with `create(record)` / `update(id, (draft) => …)` and its queries, plus `reads` (the queries alone, for
 * `scoutingReads`).
 */
export function createScoutingEvidenceRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the scouting evidence repository needs a SQLite connection (node:sqlite)');
  const st = statements(sqlite);
  const operation = operationOn(sqlite, unit);
  const rowById = { evidence: st.evidenceById, coachAffiliations: st.affiliationById, squadInvites: st.inviteById };
  const decode = (name, row) => deepFreeze(DECODERS[name](st, row));
  const decodeAll = (name, rows) => {
    if (!BATCH_KEY[name] || rows.length < 2) return rows.map((r) => decode(name, r));
    const bst = batchStatements(sqlite, st, { [BATCH_KEY[name]]: rows.map((r) => r.id) });
    return rows.map((r) => deepFreeze(DECODERS[name](bst, r)));
  };
  const read = (name, id) => {
    if (typeof id !== 'string') return null;
    const row = rowById[name].get(id);
    return row ? decode(name, row) : null;
  };
  const must = (name, id) => {
    const r = read(name, id);
    if (!r) throw refusal('SCOUTING_NOT_FOUND', `${TABLE_OF[name]} ${id} is not a record of the repository`);
    return r;
  };
  const typedOr = (name, raw) => {
    const t = TYPERS[name](raw, name);
    if (!t.ok) throw refusal('SCOUTING_INPUT_INVALID', t.reason);
    return t.record;
  };
  const list = (name, sql) => {
    const stmt = sqlite.prepare(sql);
    return (...args) => decodeAll(name, stmt.all(...args));
  };
  const IMMUTABLE = {
    evidence: ['id', 'playerId', 'recordedAt', 'source'],
    coachAffiliations: ['id', 'orgId', 'createdAt'],
    squadInvites: ['id', 'orgId', 'playerId', 'createdAt'],
  };
  const updating = new Set();

  const create = (name) => (raw) =>
    operation(() => {
      const r = typedOr(name, raw);
      if (rowById[name].get(r.id)) throw refusal('SCOUTING_DUPLICATE', `${TABLE_OF[name]} ${r.id} already exists`);
      if (
        name === 'squadInvites' &&
        r.status.startsWith('pending') &&
        sqlite
          .prepare(
            "SELECT 1 FROM squad_invites WHERE org_id = ? AND player_id = ? AND status IN ('pending_guardian','pending_player')",
          )
          .get(r.orgId, r.playerId)
      )
        throw refusal(
          'SCOUTING_UNIQUENESS',
          `squad_invites: organisation ${r.orgId} already has a pending invitation for player ${r.playerId}`,
        );
      WRITERS[name](st, r);
      return must(name, r.id);
    });
  /**
   * `update(id, change)`: `change` receives a plain copy of the stored record and edits it (or returns a
   * replacement); the result is typed whole and written at once. Identifiers and creation facts cannot change.
   */
  const update = (name) => (id, change) => {
    if (typeof change !== 'function')
      throw new TypeError(`${name}.update(id, change) needs a function that edits the copy it is given`);
    const key = `${name}/${id}`;
    if (updating.has(key))
      throw refusal(
        'SCOUTING_NESTED_UPDATE',
        `${TABLE_OF[name]} ${id} is already being updated; make the second change after the first returns`,
      );
    updating.add(key);
    try {
      return operation(() => {
        const stored = must(name, id);
        const draft = clone(stored);
        const returned = change(draft);
        const next = typedOr(name, returned === undefined ? draft : returned);
        for (const k of IMMUTABLE[name])
          if (JSON.stringify(next[k]) !== JSON.stringify(stored[k]))
            throw refusal('SCOUTING_INPUT_INVALID', `${TABLE_OF[name]} ${id}: ${k} cannot change`);
        WRITERS[name](st, next);
        return must(name, id);
      });
    } finally {
      updating.delete(key);
    }
  };

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
  const disputeOwner = sqlite.prepare('SELECT evidence_id FROM evidence_disputes WHERE id = ?');
  const evidence = {
    create: create('evidence'),
    update: update('evidence'),
    byId: (id) => read('evidence', id),
    /** A player's records, oldest first (the passport, the export, the provider lists). */
    forPlayer: list('evidence', 'SELECT * FROM evidence WHERE player_id = ? ORDER BY rowid'),
    /** A player's current records: not superseded by a correction. */
    currentForPlayer: list(
      'evidence',
      'SELECT * FROM evidence WHERE player_id = ? AND superseded_by_id IS NULL ORDER BY rowid',
    ),
    /** The record holding dispute `disputeId`, or null. */
    byDispute: (disputeId) => {
      const r = typeof disputeId === 'string' ? disputeOwner.get(disputeId) : null;
      return r ? read('evidence', r.evidence_id) : null;
    },
    /**
     * The admin dispute queue, oldest first, by offset (the admin app's `{ total, limit, offset, items }`): each
     * dispute with its record's id, player, label and tier. `all` includes resolved disputes.
     */
    disputePage({ all = false, limit, offset }) {
      const which = all ? 'all' : 'open';
      const items = disputePage[which].all(limit, offset).map((d) => ({
        id: d.id,
        at: d.filed_at,
        by: { kind: d.by_kind, id: d.by_id, name: d.by_name },
        reason: d.reason,
        status: d.status,
        resolution:
          d.resolution_outcome === null
            ? null
            : { outcome: d.resolution_outcome, note: d.resolution_note, at: d.resolved_at },
        evidenceId: d.evidence_id,
        playerId: d.e_player_id,
        label: d.e_label,
        tier: d.e_tier,
      }));
      return { total: disputeCount[which].get().n, limit, offset, items: deepFreeze(items) };
    },
  };
  const affiliationPage = sqlite.prepare(
    'SELECT * FROM coach_affiliations ORDER BY created_at DESC, rowid LIMIT ? OFFSET ?',
  );
  const affiliationCount = sqlite.prepare('SELECT COUNT(*) AS n FROM coach_affiliations');
  const confirmedForOrg = list(
    'coachAffiliations',
    "SELECT * FROM coach_affiliations WHERE org_id = ? AND status = 'confirmed' ORDER BY rowid",
  );
  const coachAffiliations = {
    create: create('coachAffiliations'),
    update: update('coachAffiliations'),
    byId: (id) => read('coachAffiliations', id),
    forOrg: list('coachAffiliations', 'SELECT * FROM coach_affiliations WHERE org_id = ? ORDER BY rowid'),
    /** The confirmed affiliation at `orgId` whose coach name matches `userName` (case-insensitive), or undefined. */
    activeFor: (orgId, userName) =>
      confirmedForOrg(orgId).find((a) => a.coachName.toLowerCase() === String(userName ?? '').toLowerCase()),
    /** Every organisation's affiliations, newest first, by offset (the admin list). */
    page({ limit, offset }) {
      return {
        total: affiliationCount.get().n,
        limit,
        offset,
        items: decodeAll('coachAffiliations', affiliationPage.all(limit, offset)),
      };
    },
  };
  const squadInvites = {
    create: create('squadInvites'),
    update: update('squadInvites'),
    byId: (id) => read('squadInvites', id),
    /** The pending invitation from `orgId` to `playerId`, or null (at most one). */
    pendingFor: (orgId, playerId) => {
      const r = sqlite
        .prepare(
          "SELECT * FROM squad_invites WHERE org_id = ? AND player_id = ? AND status IN ('pending_guardian','pending_player')",
        )
        .get(orgId, playerId);
      return r ? decode('squadInvites', r) : null;
    },
    /** The invitations to any of `playerIds` in `status`, oldest first. */
    forPlayers(playerIds, status) {
      const want = [...new Set((playerIds ?? []).filter((p) => typeof p === 'string'))];
      if (!want.length) return [];
      return decodeAll(
        'squadInvites',
        sqlite
          .prepare(
            `SELECT * FROM squad_invites WHERE status = ? AND player_id IN (SELECT value FROM json_each(?)) ORDER BY rowid`,
          )
          .all(status, JSON.stringify(want)),
      );
    },
  };
  const readOnly = (o) => Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => !WRITES.has(k))));
  const counters = Object.fromEntries(
    SCOUTING_EVIDENCE_COLLECTIONS.map((n) => [n, sqlite.prepare(`SELECT COUNT(*) AS n FROM ${TABLE_OF[n]}`)]),
  );
  return {
    evidence,
    coachAffiliations,
    squadInvites,
    /** The queries alone, for modules and projectors that must not write (`scoutingReads`). */
    reads: Object.freeze({
      evidence: readOnly(evidence),
      coachAffiliations: readOnly(coachAffiliations),
      squadInvites: readOnly(squadInvites),
    }),
    attach() {
      if (!scoutingEvidenceLive(sqlite))
        throw new Error(
          `the scouting evidence repository needs ${SCOUTING_EVIDENCE_MIGRATION} recorded; it never imports an in-memory array`,
        );
      return { counts: this.counts() };
    },
    counts() {
      return Object.fromEntries(SCOUTING_EVIDENCE_COLLECTIONS.map((n) => [n, counters[n].get().n]));
    },
    pending: () => 0,
    exportAll() {
      return SCOUTING_EVIDENCE_RECORDS.read(sqlite);
    },
    log,
    now,
  };
}
