/**
 * Signing packages (revisions, documents, parties, history), completed signings (parties), post-signing follow-ups
 * and outcome reports (confirmations).
 *
 * Every field is a typed column with its vocabulary and length CHECKs, and a record the columns cannot hold is refused
 * with its id (at a route: 400, the field named). The typers still normalise a few gaps and report each in `notes`
 * (a signing without `method` → LEGACY_RECORDED, a missing `rev` or `policyVersion` → 1, the three dead signing fields
 * and any unknown field dropped); nothing else is coerced.
 *
 * The package `keys` are rows of the shared `idempotency_keys` table, owner `signing_packages` (created by 0018).
 * `completion_signing_id` (package → signing) and `signing_package_id` (signing → package) form a cycle, so the
 * package side is DEFERRABLE INITIALLY DEFERRED with NO ACTION (a RESTRICT would fire at once even on a deferred key):
 * checked at COMMIT, which lets the completion unit write the signing row and then the package.
 *
 * References: `org_id` → orgs, `case_id` → recruitment_cases, `offer_id` → recruitment_offers, the staff ids →
 * org_users (RESTRICT). `offer_revision_id` is a plain indexed column checked in code (it could become a real key to
 * offer_revisions.id). Player ids: no key, tolerant and counted (Q7a/Q8a/Q8c-a in docs/decisions.md). Guardian and
 * party ids: polymorphic, no key.
 */
import { isPlainObject, ids } from './recruitment.mjs';
import { pageOf } from '../domains/platform/paging.mjs';
import { transaction, migrationApplied, childRowsOf } from './database.mjs';
import { deepFreeze } from '../domains/platform/values.mjs';

export const SIGNINGS_FOLLOWUPS_MIGRATION = '0018_signings_follow_ups';
export const SIGNINGS_FOLLOWUPS_COLLECTIONS = Object.freeze([
  'signingPackages',
  'signings',
  'followUps',
  'outcomeReports',
]);
export const SIGNINGS_FOLLOWUPS_TABLES = Object.freeze([
  'signing_packages',
  'signing_revisions',
  'signing_documents',
  'signing_revision_parties',
  'signing_history',
  'signings',
  'signing_parties',
  'follow_ups',
  'outcome_reports',
  'outcome_report_confirmations',
]);
/** The owner tables of the shared idempotency_keys table (created by 0018; other domains keep their keys as columns). */
export const SIGNINGS_KEY_OWNERS = Object.freeze(['signing_packages']);

export const SIGNING_STORED_STATUSES = Object.freeze([
  'DRAFT',
  'READY',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'VOIDED',
]);
export const SIGNING_REVISION_STATUSES = Object.freeze([...SIGNING_STORED_STATUSES, 'SUPERSEDED']);
const PARTY_TYPES = ['PLAYER', 'GUARDIAN', 'CLUB_SIGNATORY'];
const ACTOR_KINDS = ['org', 'player', 'guardian', 'admin', 'system'];
const PACKAGE_KEY_ACTS = Object.freeze(['start', 'ready', 'party', 'cancel', 'void', 'supersede', 'complete']);
export const FOLLOW_UP_MILESTONES = Object.freeze(['3m', '6m', '12m']);
export const FOLLOW_UP_STATUSES = Object.freeze(['scheduled', 'due', 'complete']);
export const REGISTRATION_STATUSES = Object.freeze(['registered', 'released', 'left', 'unknown']);
export const OUTCOME_STATUSES = Object.freeze(['reported', 'confirmed', 'disputed']);
export const LIMITS = Object.freeze({
  internalNote: 2000,
  reason: 500,
  label: 120,
  signingNote: 400,
  progression: 200,
  endReason: 200,
  outcomeNote: 300,
});

// ------------------------------------------------------------------ DDL
const BY = (p, { user = true, kind = false, role = false } = {}) =>
  [
    kind
      ? `  ${(p + '_kind').padEnd(32)} TEXT CHECK (${p}_kind IS NULL OR ${p}_kind IN ('org','player','guardian','admin','system'))`
      : null,
    `  ${(p + (user ? '_user_id' : '_id')).padEnd(32)} TEXT${user ? ' REFERENCES org_users(id) ON DELETE RESTRICT' : ''}`,
    `  ${(p + '_name').padEnd(32)} TEXT`,
    role ? `  ${(p + '_role').padEnd(32)} TEXT` : null,
  ]
    .filter(Boolean)
    .join(',\n');
export const SIGNINGS_FOLLOWUPS_DDL = `
CREATE TABLE signing_packages (
  id                               TEXT PRIMARY KEY,
  org_id                           TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  case_id                          TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE RESTRICT,
  player_id                        TEXT NOT NULL,
  offer_id                         TEXT NOT NULL REFERENCES recruitment_offers(id) ON DELETE RESTRICT,
  offer_revision_id                TEXT NOT NULL,
  transaction_id                   TEXT,
  status                           TEXT NOT NULL CHECK (status IN ('DRAFT','READY','IN_PROGRESS','COMPLETED','CANCELLED','VOIDED')),
  current_revision_id              TEXT NOT NULL,
  expires_at                       INTEGER,
  internal_note                    TEXT CHECK (internal_note IS NULL OR length(internal_note) <= 2000),
  completion_signing_id            TEXT REFERENCES signings(id) DEFERRABLE INITIALLY DEFERRED,
  completion_completed_at          INTEGER,
${BY('completion_by', { kind: true, role: true })},
  completion_contract_start_date   TEXT CHECK (completion_contract_start_date IS NULL OR length(completion_contract_start_date) = 10),
  completion_contract_end_date     TEXT CHECK (completion_contract_end_date IS NULL OR length(completion_contract_end_date) = 10),
  completion_document_sha256       TEXT CHECK (completion_document_sha256 IS NULL OR length(completion_document_sha256) = 64),
  completion_lifecycle_from        TEXT,
  completion_lifecycle_to          TEXT,
  completion_lifecycle_at          INTEGER,
  cancelled_at                     INTEGER,
${BY('cancelled_by', { kind: true, role: true })},
  cancel_reason                    TEXT CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 500),
  voided_at                        INTEGER,
${BY('voided_by', { user: false, kind: true, role: true })},
  void_reason                      TEXT CHECK (void_reason IS NULL OR length(void_reason) <= 500),
  created_at                       INTEGER NOT NULL,
  created_by_kind                  TEXT CHECK (created_by_kind IS NULL OR created_by_kind IN ('org','player','guardian','admin','system')),
  created_by_user_id               TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  created_by_name                  TEXT,
  created_by_role                  TEXT,
  updated_at                       INTEGER NOT NULL,
  rev                              INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  rev_at                           INTEGER,
  rev_by_user_id                   TEXT,
  rev_by_name                      TEXT,
  policy_version                   INTEGER NOT NULL DEFAULT 1,
  subject_removed_at               INTEGER,
  CHECK ((status = 'COMPLETED') = (completion_signing_id IS NOT NULL)),
  CHECK ((voided_at IS NULL) = (voided_by_kind IS NULL))
) STRICT;
CREATE INDEX signing_packages_case_org_created ON signing_packages (case_id, org_id, created_at);
CREATE INDEX signing_packages_offer_org ON signing_packages (offer_id, org_id);
CREATE INDEX signing_packages_player_updated ON signing_packages (player_id, updated_at);
CREATE INDEX signing_packages_offer_revision ON signing_packages (offer_revision_id);
CREATE INDEX signing_packages_org_player ON signing_packages (org_id, player_id);
CREATE UNIQUE INDEX signing_packages_one_completed_per_offer ON signing_packages (offer_id) WHERE status = 'COMPLETED';
CREATE TABLE signing_revisions (
  id                               TEXT PRIMARY KEY,
  package_id                       TEXT NOT NULL REFERENCES signing_packages(id) ON DELETE CASCADE,
  position                         INTEGER NOT NULL,
  revision_number                  INTEGER NOT NULL CHECK (revision_number >= 1),
  status                           TEXT NOT NULL CHECK (status IN ('DRAFT','READY','IN_PROGRESS','COMPLETED','CANCELLED','VOIDED','SUPERSEDED')),
  created_at                       INTEGER NOT NULL,
${BY('created_by', { kind: true, role: true })},
  ready_at                         INTEGER,
${BY('ready_by', { kind: true, role: true })},
  completed_at                     INTEGER,
${BY('completed_by', { kind: true, role: true })},
  superseded_at                    INTEGER,
  contract_start_date              TEXT CHECK (contract_start_date IS NULL OR length(contract_start_date) = 10),
  contract_end_date                TEXT CHECK (contract_end_date IS NULL OR length(contract_end_date) = 10),
  policy_version                   INTEGER,
  policy_jurisdiction              TEXT,
  policy_offer_policy_version      INTEGER,
  supersedes_revision_id           TEXT,
  superseded_by_revision_id        TEXT,
  UNIQUE (package_id, revision_number),
  UNIQUE (package_id, position)
) STRICT;
CREATE TABLE signing_documents (
  id                               TEXT PRIMARY KEY,
  revision_id                      TEXT NOT NULL REFERENCES signing_revisions(id) ON DELETE CASCADE,
  kind                             TEXT NOT NULL CHECK (kind IN ('signing','executed')),
  evidence_id                      TEXT NOT NULL,
  sha256                           TEXT NOT NULL CHECK (length(sha256) = 64),
  filename                         TEXT,
  mime                             TEXT,
  bytes                            INTEGER,
  label                            TEXT CHECK (label IS NULL OR length(label) <= 120),
  uploaded_at                      INTEGER NOT NULL,
${BY('uploaded_by', { kind: true, role: true })},
  UNIQUE (revision_id, kind)
) STRICT;
CREATE TABLE signing_revision_parties (
  revision_id                      TEXT NOT NULL REFERENCES signing_revisions(id) ON DELETE CASCADE,
  position                         INTEGER NOT NULL,
  party_type                       TEXT NOT NULL CHECK (party_type IN ('PLAYER','GUARDIAN','CLUB_SIGNATORY')),
  for_entity_id                    TEXT,
  for_player_id                    TEXT,
  status                           TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','COMPLETED')),
  completed_at                     INTEGER,
  completed_by_kind                TEXT CHECK (completed_by_kind IS NULL OR completed_by_kind IN ('org','player','guardian','admin','system')),
  completed_by_id                  TEXT,
  completed_by_name                TEXT,
  method                           TEXT CHECK (method IS NULL OR method IN ('PLATFORM_ACKNOWLEDGMENT','UPLOAD_EXECUTED_DOCUMENT')),
  evidence_ref_kind                TEXT CHECK (evidence_ref_kind IS NULL OR evidence_ref_kind IN ('platform_acknowledgment')),
  evidence_ref_id                  TEXT,
  evidence_revision_id             TEXT,
  evidence_document_sha256         TEXT CHECK (evidence_document_sha256 IS NULL OR length(evidence_document_sha256) = 64),
  evidence_at                      INTEGER,
  evidence_actor_kind              TEXT,
  evidence_actor_id                TEXT,
  evidence_session                 TEXT,
  PRIMARY KEY (revision_id, party_type),
  UNIQUE (revision_id, position),
  CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL))
) STRICT;
CREATE INDEX signing_revision_parties_entity ON signing_revision_parties (party_type, for_entity_id);
CREATE TABLE signing_history (
  id                               TEXT PRIMARY KEY,
  package_id                       TEXT NOT NULL REFERENCES signing_packages(id) ON DELETE RESTRICT,
  position                         INTEGER NOT NULL,
  at                               INTEGER NOT NULL,
  by_kind                          TEXT CHECK (by_kind IS NULL OR by_kind IN ('org','player','guardian','admin','system')),
  by_id                            TEXT,
  by_name                          TEXT,
  action                           TEXT NOT NULL,
  detail_json                      TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
  UNIQUE (package_id, position)
) STRICT;
CREATE INDEX signing_history_package_at ON signing_history (package_id, at);
CREATE TABLE signings (
  id                               TEXT PRIMARY KEY,
  player_id                        TEXT NOT NULL,
  player_name                      TEXT,
  org_id                           TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  org_name                         TEXT,
  user_id                          TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  scout_name                       TEXT,
  ts                               INTEGER NOT NULL,
  signed_at                        INTEGER,
  first_qualifying_ledger_id       TEXT,
  first_qualifying_at              INTEGER,
  first_qualifying_type            TEXT,
  attribution_window_months        INTEGER,
  inside_attribution_window        INTEGER NOT NULL DEFAULT 0 CHECK (inside_attribution_window IN (0,1)),
  method                           TEXT NOT NULL DEFAULT 'LEGACY_RECORDED' CHECK (method IN ('CANONICAL_COMPLETION','LEGACY_RECORDED')),
  note                             TEXT CHECK (note IS NULL OR length(note) <= 400),
  signing_package_id               TEXT REFERENCES signing_packages(id) ON DELETE RESTRICT,
  signing_revision_id              TEXT REFERENCES signing_revisions(id) ON DELETE RESTRICT,
  signing_revision_number          INTEGER,
  case_id                          TEXT REFERENCES recruitment_cases(id) ON DELETE RESTRICT,
  offer_id                         TEXT REFERENCES recruitment_offers(id) ON DELETE RESTRICT,
  offer_revision_id                TEXT,
  transaction_id                   TEXT,
  document_sha256                  TEXT CHECK (document_sha256 IS NULL OR length(document_sha256) = 64),
  document_evidence_id             TEXT,
  executed_document_evidence_id    TEXT,
  contract_start_date              TEXT CHECK (contract_start_date IS NULL OR length(contract_start_date) = 10),
  contract_end_date                TEXT CHECK (contract_end_date IS NULL OR length(contract_end_date) = 10),
  policy_version                   INTEGER,
  CHECK ((method = 'CANONICAL_COMPLETION') = (signing_package_id IS NOT NULL))
) STRICT;
CREATE INDEX signings_org_ts ON signings (org_id, ts);
CREATE INDEX signings_player ON signings (player_id);
CREATE INDEX signings_org_player ON signings (org_id, player_id);
CREATE UNIQUE INDEX signings_one_per_package ON signings (signing_package_id) WHERE signing_package_id IS NOT NULL;
CREATE UNIQUE INDEX signings_one_per_offer ON signings (offer_id) WHERE offer_id IS NOT NULL;
CREATE UNIQUE INDEX signings_one_legacy_per_org_player ON signings (org_id, player_id) WHERE signing_package_id IS NULL;
CREATE TABLE signing_parties (
  signing_id                       TEXT NOT NULL REFERENCES signings(id) ON DELETE CASCADE,
  position                         INTEGER NOT NULL,
  party_type                       TEXT NOT NULL CHECK (party_type IN ('PLAYER','GUARDIAN','CLUB_SIGNATORY')),
  method                           TEXT CHECK (method IS NULL OR method IN ('PLATFORM_ACKNOWLEDGMENT','UPLOAD_EXECUTED_DOCUMENT')),
  completed_at                     INTEGER,
  by_kind                          TEXT CHECK (by_kind IS NULL OR by_kind IN ('org','player','guardian','admin','system')),
  PRIMARY KEY (signing_id, party_type),
  UNIQUE (signing_id, position)
) STRICT;
CREATE TABLE follow_ups (
  id                               TEXT PRIMARY KEY,
  signing_id                       TEXT NOT NULL REFERENCES signings(id) ON DELETE RESTRICT,
  player_id                        TEXT NOT NULL,
  org_id                           TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  milestone                        TEXT NOT NULL CHECK (milestone IN ('3m','6m','12m')),
  due_at                           INTEGER NOT NULL,
  status                           TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','due','complete')),
  notified_at                      INTEGER,
  created_at                       INTEGER NOT NULL,
  UNIQUE (signing_id, milestone)
) STRICT;
CREATE INDEX follow_ups_org_due ON follow_ups (org_id, due_at);
CREATE INDEX follow_ups_player ON follow_ups (player_id);
CREATE INDEX follow_ups_status_due ON follow_ups (status, due_at);
CREATE TABLE outcome_reports (
  id                               TEXT PRIMARY KEY,
  follow_up_id                     TEXT NOT NULL UNIQUE REFERENCES follow_ups(id) ON DELETE RESTRICT,
  signing_id                       TEXT NOT NULL REFERENCES signings(id) ON DELETE RESTRICT,
  player_id                        TEXT NOT NULL,
  org_id                           TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  by_user_id                       TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  by_name                          TEXT,
  registration_status              TEXT NOT NULL CHECK (registration_status IN ('registered','released','left','unknown')),
  matches_played                   INTEGER CHECK (matches_played IS NULL OR matches_played >= 0),
  progression                      TEXT CHECK (progression IS NULL OR length(progression) <= 200),
  end_reason                       TEXT CHECK (end_reason IS NULL OR length(end_reason) <= 200),
  note                             TEXT CHECK (note IS NULL OR length(note) <= 300),
  status                           TEXT NOT NULL DEFAULT 'reported' CHECK (status IN ('reported','confirmed','disputed')),
  at                               INTEGER NOT NULL
) STRICT;
CREATE INDEX outcome_reports_org ON outcome_reports (org_id);
CREATE INDEX outcome_reports_player ON outcome_reports (player_id);
CREATE TABLE outcome_report_confirmations (
  report_id                        TEXT NOT NULL REFERENCES outcome_reports(id) ON DELETE CASCADE,
  position                         INTEGER NOT NULL,
  by_kind                          TEXT NOT NULL CHECK (by_kind IN ('player','guardian')),
  by_id                            TEXT NOT NULL,
  by_name                          TEXT,
  agree                            INTEGER NOT NULL CHECK (agree IN (0,1)),
  note                             TEXT CHECK (note IS NULL OR length(note) <= 300),
  experience_rating                INTEGER CHECK (experience_rating IS NULL OR experience_rating BETWEEN 1 AND 5),
  at                               INTEGER NOT NULL,
  PRIMARY KEY (report_id, by_id),
  UNIQUE (report_id, position)
) STRICT;
`;

// ------------------------------------------------------------------ typing helpers (the one place a value is judged)
const refusal = (code, message, extra = {}) => Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
const isInt = (v) => Number.isSafeInteger(v);
const isStr = (v) => typeof v === 'string';
const nonEmpty = (v) => isStr(v) && v.length > 0;
const optStr = (v) => v === undefined || v === null || isStr(v);
const optInt = (v) => v === undefined || v === null || isInt(v);
const optBool = (v) => v === undefined || v === null || typeof v === 'boolean';
const dateOnly = (v) => isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v);
const sha = (v) => isStr(v) && /^[0-9a-f]{64}$/i.test(v);
const orNull = (v) => (v === undefined ? null : v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** A typing problem: `{ ok: false, reason }` names the record, the field and what it holds — never a note, a body or a name. */
const bad = (at, field, what) => ({ ok: false, reason: `${at}.${field} ${what}` });
const describe = (v) =>
  v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `${typeof v}`;
/** An actor tuple as the writers produce it ({kind, id|userId, name, role?}) → the typed quartet. `null` stays null. */
function actorIn(v, at, field, { kinds = ACTOR_KINDS, required = false } = {}) {
  if (v === null || v === undefined) return required ? bad(at, field, 'is required') : { ok: true, value: null };
  if (!isPlainObject(v)) return bad(at, field, `must be an actor object (got ${describe(v)})`);
  const id = v.id ?? v.userId ?? null;
  if (!kinds.includes(v.kind))
    return bad(at, `${field}.kind`, `must be one of ${kinds.join('|')} (got ${describe(v.kind)})`);
  if (!optStr(id) || !optStr(v.name) || !optStr(v.role))
    return bad(at, field, 'must carry string or null id, name and role');
  return { ok: true, value: { kind: v.kind, id: orNull(id), name: orNull(v.name), role: orNull(v.role) } };
}
const actorOut = (p, row, { user = true, role = true, kind = true } = {}) => {
  const id = row[user ? `${p}_user_id` : `${p}_id`];
  const k = kind ? row[`${p}_kind`] : 'org';
  if (k === null && id === null && row[`${p}_name`] === null) return null;
  const out = { kind: k ?? 'org', id, name: row[`${p}_name`] };
  if (role) out.role = row[`${p}_role`];
  return out;
};
const actorCols = (p, a, { user = true, role = true, kind = true } = {}) => ({
  ...(kind ? { [`${p}_kind`]: a?.kind ?? null } : {}),
  [user ? `${p}_user_id` : `${p}_id`]: a?.id ?? null,
  [`${p}_name`]: a?.name ?? null,
  ...(role ? { [`${p}_role`]: a?.role ?? null } : {}),
});

// ------------------------------------------------------------------ validation + normalisation (one function per record, used by the routes' writers)

/** The signing package the writers produce, typed. Returns `{ ok, record, notes }` or `{ ok: false, reason }`; `notes` are the normalisations applied (ids only). */
export function typeSigningPackage(raw, at = 'signingPackages') {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  if (!nonEmpty(raw.id)) return bad(at, 'id', 'must be a non-empty string');
  const label = `${at} ${raw.id}`;
  const notes = [];
  for (const k of ['orgId', 'caseId', 'playerId', 'offerId', 'offerRevisionId', 'currentRevisionId'])
    if (!nonEmpty(raw[k])) return bad(label, k, 'must be a non-empty string');
  if (!SIGNING_STORED_STATUSES.includes(raw.status))
    return bad(label, 'status', `must be one of ${SIGNING_STORED_STATUSES.join('|')} (got ${describe(raw.status)})`);
  for (const k of ['expiresAt', 'cancelledAt', 'voidedAt', 'updatedAt', 'revAt', 'subjectRemovedAt'])
    if (!optInt(raw[k])) return bad(label, k, `must be an integer instant or null (got ${describe(raw[k])})`);
  if (!isInt(raw.createdAt)) return bad(label, 'createdAt', 'must be an integer instant');
  for (const [k, max] of [
    ['internalNote', LIMITS.internalNote],
    ['cancelReason', LIMITS.reason],
    ['voidReason', LIMITS.reason],
  ]) {
    if (!optStr(raw[k])) return bad(label, k, 'must be text or null');
    if (isStr(raw[k]) && raw[k].length > max) return bad(label, k, `exceeds ${max} characters`);
  }
  if (!optStr(raw.transactionId)) return bad(label, 'transactionId', 'must be a string or null');
  const createdBy = actorIn(raw.createdBy, label, 'createdBy', { required: true });
  if (!createdBy.ok) return createdBy;
  if (!nonEmpty(createdBy.value.id)) return bad(label, 'createdBy.id', 'must name the staff member');
  const cancelledBy = actorIn(raw.cancelledBy, label, 'cancelledBy');
  if (!cancelledBy.ok) return cancelledBy;
  const voidedBy = actorIn(raw.voidedBy, label, 'voidedBy', { kinds: ['org', 'admin'] });
  if (!voidedBy.ok) return voidedBy;
  if ((raw.voidedAt == null) !== (voidedBy.value === null))
    return bad(label, 'voidedAt', 'and voidedBy must be set together');
  let rev = raw.rev;
  if (rev === undefined || rev === null) {
    rev = 1;
    notes.push(`${label}: rev missing, written as 1`);
  } else if (!isInt(rev) || rev < 1) return bad(label, 'rev', 'must be a positive integer');
  let revBy = null;
  if (raw.revBy !== undefined && raw.revBy !== null) {
    if (!isPlainObject(raw.revBy) || !optStr(raw.revBy.userId) || !optStr(raw.revBy.name))
      return bad(label, 'revBy', 'must be {userId, name} or null');
    revBy = { userId: orNull(raw.revBy.userId), name: orNull(raw.revBy.name) };
  }
  let policyVersion = raw.policyVersion;
  if (policyVersion === undefined || policyVersion === null) {
    policyVersion = 1;
    notes.push(`${label}: policyVersion missing, written as 1`);
  } else if (!isInt(policyVersion)) return bad(label, 'policyVersion', 'must be an integer');
  // completion
  let completion = null;
  if (raw.completion !== undefined && raw.completion !== null) {
    const c = raw.completion;
    if (!isPlainObject(c)) return bad(label, 'completion', `must be an object or null (got ${describe(c)})`);
    if (!nonEmpty(c.signingId) || !isInt(c.completedAt))
      return bad(label, 'completion', 'must carry signingId and completedAt');
    const by = actorIn(c.completedBy, label, 'completion.completedBy');
    if (!by.ok) return by;
    const contract = contractIn(c.contract, label, 'completion.contract');
    if (!contract.ok) return contract;
    if (c.documentSha256 !== undefined && c.documentSha256 !== null && !sha(c.documentSha256))
      return bad(label, 'completion.documentSha256', 'must be a SHA-256 hex digest or null');
    let lifecycle = null;
    if (c.lifecycle !== undefined && c.lifecycle !== null) {
      const l = c.lifecycle;
      if (!isPlainObject(l) || !optStr(l.from) || !optStr(l.to) || !optInt(l.at))
        return bad(label, 'completion.lifecycle', 'must be {from, to, at} or null');
      lifecycle = { from: orNull(l.from), to: orNull(l.to), at: orNull(l.at) };
    }
    completion = {
      signingId: c.signingId,
      completedAt: c.completedAt,
      completedBy: by.value,
      contract: contract.value,
      documentSha256: orNull(c.documentSha256),
      lifecycle,
    };
  }
  if ((raw.status === 'COMPLETED') !== (completion !== null))
    return bad(
      label,
      'completion',
      raw.status === 'COMPLETED'
        ? 'is required on a COMPLETED package'
        : 'is present on a package that is not COMPLETED',
    );
  // revisions
  if (!Array.isArray(raw.revisions) || raw.revisions.length === 0)
    return bad(label, 'revisions', 'must be a non-empty array');
  const revisions = [];
  const revIds = new Set();
  const nums = new Set();
  for (let i = 0; i < raw.revisions.length; i++) {
    const r = typeRevision(raw.revisions[i], `${label}.revisions[${i}]`, raw);
    if (!r.ok) return r;
    if (revIds.has(r.record.id)) return bad(label, `revisions[${i}].id`, `duplicates ${r.record.id}`);
    if (nums.has(r.record.revisionNumber))
      return bad(label, `revisions[${i}].revisionNumber`, `duplicates ${r.record.revisionNumber}`);
    revIds.add(r.record.id);
    nums.add(r.record.revisionNumber);
    revisions.push(r.record);
    notes.push(...r.notes);
  }
  if (!revIds.has(raw.currentRevisionId))
    return bad(label, 'currentRevisionId', `names no revision of the package (${raw.currentRevisionId})`);
  // keys
  const keys = { start: null, ready: [], party: [], cancel: [], void: [], supersede: [], complete: [] };
  if (raw.keys !== undefined && raw.keys !== null) {
    if (!isPlainObject(raw.keys)) return bad(label, 'keys', `must be an object (got ${describe(raw.keys)})`);
    for (const k of Object.keys(raw.keys))
      if (!PACKAGE_KEY_ACTS.includes(k)) return bad(label, `keys.${k}`, 'is not a key act this build writes');
    if (raw.keys.start !== undefined && raw.keys.start !== null) {
      const s = raw.keys.start;
      if (!isPlainObject(s) || !nonEmpty(s.key) || !isStr(s.fp))
        return bad(label, 'keys.start', 'must be {key, fp} or null');
      keys.start = { key: s.key, fp: s.fp };
    }
    for (const act of PACKAGE_KEY_ACTS.slice(1)) {
      const list = raw.keys[act];
      if (list === undefined || list === null) continue;
      if (!Array.isArray(list)) return bad(label, `keys.${act}`, `must be an array (got ${describe(list)})`);
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (
          !isPlainObject(e) ||
          !nonEmpty(e.key) ||
          !isStr(e.fp) ||
          !optInt(e.at) ||
          !optStr(e.revisionId) ||
          !optStr(e.actorId) ||
          !optStr(e.signingId)
        )
          return bad(label, `keys.${act}[${i}]`, 'must be {key, fp, at?, revisionId?, actorId?, signingId?}');
        const entry = { key: e.key, fp: e.fp };
        for (const f of ['revisionId', 'actorId', 'signingId', 'at']) if (e[f] !== undefined) entry[f] = e[f];
        keys[act].push(entry);
      }
    }
  }
  // history
  const history = [];
  if (raw.history !== undefined && raw.history !== null) {
    if (!Array.isArray(raw.history)) return bad(label, 'history', `must be an array (got ${describe(raw.history)})`);
    for (let i = 0; i < raw.history.length; i++) {
      const h = typeHistory(raw.history[i], `${label}.history[${i}]`);
      if (!h.ok) return h;
      history.push(h.record);
    }
  }
  const known = new Set([
    'id',
    'orgId',
    'caseId',
    'playerId',
    'offerId',
    'offerRevisionId',
    'transactionId',
    'status',
    'currentRevisionId',
    'revisions',
    'expiresAt',
    'internalNote',
    'keys',
    'history',
    'completion',
    'cancelledAt',
    'cancelledBy',
    'cancelReason',
    'voidedAt',
    'voidedBy',
    'voidReason',
    'createdAt',
    'createdBy',
    'updatedAt',
    'rev',
    'revAt',
    'revBy',
    'policyVersion',
    'subjectRemovedAt',
  ]);
  for (const k of Object.keys(raw)) if (!known.has(k)) notes.push(`${label}: unknown field ${k} dropped`);
  const record = {
    id: raw.id,
    orgId: raw.orgId,
    caseId: raw.caseId,
    playerId: raw.playerId,
    offerId: raw.offerId,
    offerRevisionId: raw.offerRevisionId,
    transactionId: orNull(raw.transactionId),
    status: raw.status,
    currentRevisionId: raw.currentRevisionId,
    revisions,
    expiresAt: orNull(raw.expiresAt),
    internalNote: orNull(raw.internalNote),
    keys,
    history,
    completion,
    cancelledAt: orNull(raw.cancelledAt),
    cancelledBy: cancelledBy.value,
    cancelReason: orNull(raw.cancelReason),
    voidedAt: orNull(raw.voidedAt),
    voidedBy: voidedBy.value,
    voidReason: orNull(raw.voidReason),
    createdAt: raw.createdAt,
    createdBy: createdBy.value,
    updatedAt: raw.updatedAt ?? raw.createdAt,
    rev,
    revAt: orNull(raw.revAt),
    revBy,
    policyVersion,
    subjectRemovedAt: orNull(raw.subjectRemovedAt),
  };
  return { ok: true, record, notes };
}
function contractIn(v, label, field) {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (!isPlainObject(v)) return bad(label, field, `must be {startDate, endDate} or null (got ${describe(v)})`);
  if (v.startDate !== undefined && v.startDate !== null && !dateOnly(v.startDate))
    return bad(label, `${field}.startDate`, 'must be a YYYY-MM-DD day or null');
  if (v.endDate !== undefined && v.endDate !== null && !dateOnly(v.endDate))
    return bad(label, `${field}.endDate`, 'must be a YYYY-MM-DD day or null');
  return { ok: true, value: { startDate: orNull(v.startDate), endDate: orNull(v.endDate) } };
}
function typeDocument(v, label, field) {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (!isPlainObject(v)) return bad(label, field, `must be a document object or null (got ${describe(v)})`);
  if (!nonEmpty(v.id) || !nonEmpty(v.evidenceId) || !sha(v.sha256) || !isInt(v.uploadedAt))
    return bad(label, field, 'must carry id, evidenceId, a SHA-256 digest and uploadedAt');
  if (!optStr(v.filename) || !optStr(v.mime) || !optInt(v.bytes) || !optStr(v.label))
    return bad(label, field, 'filename, mime, bytes and label must be typed or null');
  if (isStr(v.label) && v.label.length > LIMITS.label)
    return bad(label, `${field}.label`, `exceeds ${LIMITS.label} characters`);
  const by = actorIn(v.uploadedBy, label, `${field}.uploadedBy`);
  if (!by.ok) return by;
  return {
    ok: true,
    value: {
      id: v.id,
      evidenceId: v.evidenceId,
      sha256: v.sha256.toLowerCase(),
      filename: orNull(v.filename),
      mime: orNull(v.mime),
      bytes: orNull(v.bytes),
      label: orNull(v.label),
      uploadedAt: v.uploadedAt,
      uploadedBy: by.value,
    },
  };
}
function typeRevision(r, label, pkg) {
  if (!isPlainObject(r)) return { ok: false, reason: `${label} is not an object (${describe(r)})` };
  if (!nonEmpty(r.id)) return bad(label, 'id', 'must be a non-empty string');
  const notes = [];
  if (!isInt(r.revisionNumber) || r.revisionNumber < 1)
    return bad(label, 'revisionNumber', 'must be a positive integer');
  if (!SIGNING_REVISION_STATUSES.includes(r.status))
    return bad(label, 'status', `must be one of ${SIGNING_REVISION_STATUSES.join('|')} (got ${describe(r.status)})`);
  if (!isInt(r.createdAt)) return bad(label, 'createdAt', 'must be an integer instant');
  for (const k of ['readyAt', 'completedAt', 'supersededAt'])
    if (!optInt(r[k])) return bad(label, k, 'must be an integer instant or null');
  const createdBy = actorIn(r.createdBy, label, 'createdBy');
  if (!createdBy.ok) return createdBy;
  const readyBy = actorIn(r.readyBy, label, 'readyBy');
  if (!readyBy.ok) return readyBy;
  const completedBy = actorIn(r.completedBy, label, 'completedBy');
  if (!completedBy.ok) return completedBy;
  const document = typeDocument(r.document, label, 'document');
  if (!document.ok) return document;
  const executed = typeDocument(r.executedDocument, label, 'executedDocument');
  if (!executed.ok) return executed;
  const contract = contractIn(r.contract, label, 'contract');
  if (!contract.ok) return contract;
  let policySnapshot = null;
  if (r.policySnapshot !== undefined && r.policySnapshot !== null) {
    const p = r.policySnapshot;
    if (!isPlainObject(p) || !optInt(p.policyVersion) || !optStr(p.jurisdiction) || !optInt(p.offerPolicyVersion))
      return bad(label, 'policySnapshot', 'must be {policyVersion, jurisdiction, offerPolicyVersion} or null');
    policySnapshot = {
      policyVersion: orNull(p.policyVersion),
      jurisdiction: orNull(p.jurisdiction),
      offerPolicyVersion: orNull(p.offerPolicyVersion),
    };
  }
  if (!optStr(r.supersedesRevisionId) || !optStr(r.supersededByRevisionId))
    return bad(label, 'supersedesRevisionId', 'and supersededByRevisionId must be strings or null');
  if (!Array.isArray(r.requiredParties))
    return bad(label, 'requiredParties', `must be an array (got ${describe(r.requiredParties)})`);
  const parties = [];
  const types = new Set();
  for (let i = 0; i < r.requiredParties.length; i++) {
    const p = r.requiredParties[i];
    const pl = `${label}.requiredParties[${i}]`;
    if (!isPlainObject(p)) return { ok: false, reason: `${pl} is not an object` };
    if (!PARTY_TYPES.includes(p.partyType)) return bad(pl, 'partyType', `must be one of ${PARTY_TYPES.join('|')}`);
    if (types.has(p.partyType)) return bad(pl, 'partyType', `duplicates ${p.partyType}`);
    types.add(p.partyType);
    if (!['PENDING', 'COMPLETED'].includes(p.status)) return bad(pl, 'status', 'must be PENDING or COMPLETED');
    if (!optStr(p.forEntityId) || !optStr(p.forPlayerId) || !optInt(p.completedAt))
      return bad(pl, 'forEntityId', ', forPlayerId and completedAt must be typed or null');
    if ((p.status === 'COMPLETED') !== (p.completedAt != null))
      return bad(pl, 'completedAt', 'must be set exactly on a COMPLETED party');
    const by = actorIn(p.completedBy, pl, 'completedBy', { kinds: ['player', 'guardian', 'org'] });
    if (!by.ok) return by;
    if (
      p.method !== undefined &&
      p.method !== null &&
      !['PLATFORM_ACKNOWLEDGMENT', 'UPLOAD_EXECUTED_DOCUMENT'].includes(p.method)
    )
      return bad(pl, 'method', 'is not a method this build writes');
    let evidenceRef = null;
    if (p.evidenceRef !== undefined && p.evidenceRef !== null) {
      const e = p.evidenceRef;
      if (
        !isPlainObject(e) ||
        e.kind !== 'platform_acknowledgment' ||
        !nonEmpty(e.id) ||
        !optStr(e.revisionId) ||
        (e.documentSha256 != null && !sha(e.documentSha256)) ||
        !optInt(e.at) ||
        !optStr(e.actorKind) ||
        !optStr(e.actorId) ||
        !optStr(e.session)
      )
        return bad(pl, 'evidenceRef', 'must be the platform_acknowledgment evidence shape or null');
      evidenceRef = {
        kind: e.kind,
        id: e.id,
        revisionId: orNull(e.revisionId),
        documentSha256: e.documentSha256 == null ? null : e.documentSha256.toLowerCase(),
        at: orNull(e.at),
        actorKind: orNull(e.actorKind),
        actorId: orNull(e.actorId),
        session: orNull(e.session),
      };
    }
    parties.push({
      partyType: p.partyType,
      forEntityId: orNull(p.forEntityId),
      forPlayerId: orNull(p.forPlayerId),
      status: p.status,
      completedAt: orNull(p.completedAt),
      completedBy: by.value ? { kind: by.value.kind, id: by.value.id, name: by.value.name } : null,
      evidenceRef,
      method: orNull(p.method),
    });
  }
  const record = {
    id: r.id,
    revisionNumber: r.revisionNumber,
    status: r.status,
    createdAt: r.createdAt,
    createdBy: createdBy.value,
    readyAt: orNull(r.readyAt),
    readyBy: readyBy.value,
    completedAt: orNull(r.completedAt),
    completedBy: completedBy.value,
    document: document.value,
    executedDocument: executed.value,
    contract: contract.value,
    requiredParties: parties,
    policySnapshot,
    supersedesRevisionId: orNull(r.supersedesRevisionId),
    supersededByRevisionId: orNull(r.supersededByRevisionId),
    supersededAt: orNull(r.supersededAt),
  };
  void pkg;
  return { ok: true, record, notes };
}
function typeHistory(h, label) {
  if (!isPlainObject(h)) return { ok: false, reason: `${label} is not an object` };
  if (!nonEmpty(h.id) || !isInt(h.at) || !nonEmpty(h.action)) return bad(label, 'id', ', at and action are required');
  const by = actorIn(h.by, label, 'by');
  if (!by.ok) return by;
  if (h.detail !== undefined && h.detail !== null && !isPlainObject(h.detail))
    return bad(label, 'detail', 'must be an object or null');
  return {
    ok: true,
    record: {
      id: h.id,
      at: h.at,
      action: h.action,
      by: by.value ? { kind: by.value.kind, id: by.value.id, name: by.value.name } : null,
      detail: h.detail === undefined ? null : clone(h.detail),
    },
  };
}

/** The completed signing record (canonical or legacy), typed. */
export function typeSigning(raw, at = 'signings') {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  if (!nonEmpty(raw.id)) return bad(at, 'id', 'must be a non-empty string');
  const label = `${at} ${raw.id}`;
  const notes = [];
  for (const k of ['playerId', 'orgId']) if (!nonEmpty(raw[k])) return bad(label, k, 'must be a non-empty string');
  if (!isInt(raw.ts)) return bad(label, 'ts', 'must be an integer instant');
  for (const k of ['signedAt', 'attributionWindowMonths', 'signingRevisionNumber', 'policyVersion'])
    if (!optInt(raw[k])) return bad(label, k, 'must be an integer or null');
  for (const k of [
    'playerName',
    'orgName',
    'userId',
    'scoutName',
    'signingPackageId',
    'signingRevisionId',
    'caseId',
    'offerId',
    'offerRevisionId',
    'transactionId',
    'documentEvidenceId',
    'executedDocumentEvidenceId',
    'note',
  ])
    if (!optStr(raw[k])) return bad(label, k, `must be a string or null (got ${describe(raw[k])})`);
  if (isStr(raw.note) && raw.note.length > LIMITS.signingNote)
    return bad(label, 'note', `exceeds ${LIMITS.signingNote} characters`);
  if (!optBool(raw.insideAttributionWindow)) return bad(label, 'insideAttributionWindow', 'must be a boolean or null');
  if (raw.documentSha256 !== undefined && raw.documentSha256 !== null && !sha(raw.documentSha256))
    return bad(label, 'documentSha256', 'must be a SHA-256 hex digest or null');
  let method = raw.method;
  if (method === undefined || method === null) {
    method = raw.signingPackageId ? 'CANONICAL_COMPLETION' : 'LEGACY_RECORDED';
    notes.push(`${label}: method missing, written as ${method}`);
  } else if (!['CANONICAL_COMPLETION', 'LEGACY_RECORDED'].includes(method))
    return bad(label, 'method', `must be CANONICAL_COMPLETION or LEGACY_RECORDED (got ${describe(method)})`);
  if ((method === 'CANONICAL_COMPLETION') !== !!raw.signingPackageId)
    return bad(label, 'method', 'CANONICAL_COMPLETION requires signingPackageId and LEGACY_RECORDED forbids it');
  let first = null;
  if (raw.firstQualifyingInteraction !== undefined && raw.firstQualifyingInteraction !== null) {
    const f = raw.firstQualifyingInteraction;
    if (!isPlainObject(f) || !optStr(f.id) || !optInt(f.ts) || !optStr(f.type))
      return bad(label, 'firstQualifyingInteraction', 'must be a ledger row reference {id, ts, type} or null');
    first = { id: orNull(f.id), ts: orNull(f.ts), type: orNull(f.type) };
    if (Object.keys(f).some((k) => !['id', 'ts', 'type'].includes(k)))
      notes.push(
        `${label}: firstQualifyingInteraction kept as the ledger reference (id, ts, type); the copied fields dropped`,
      );
  }
  const contract = contractIn(raw.contract, label, 'contract');
  if (!contract.ok) return contract;
  const parties = [];
  if (raw.parties !== undefined && raw.parties !== null) {
    if (!Array.isArray(raw.parties)) return bad(label, 'parties', `must be an array (got ${describe(raw.parties)})`);
    const seen = new Set();
    for (let i = 0; i < raw.parties.length; i++) {
      const p = raw.parties[i];
      const pl = `${label}.parties[${i}]`;
      if (!isPlainObject(p) || !PARTY_TYPES.includes(p.partyType))
        return bad(pl, 'partyType', `must be one of ${PARTY_TYPES.join('|')}`);
      if (seen.has(p.partyType)) return bad(pl, 'partyType', `duplicates ${p.partyType}`);
      seen.add(p.partyType);
      if (p.method != null && !['PLATFORM_ACKNOWLEDGMENT', 'UPLOAD_EXECUTED_DOCUMENT'].includes(p.method))
        return bad(pl, 'method', 'is not a method this build writes');
      if (!optInt(p.completedAt) || (p.byKind != null && !['org', 'player', 'guardian'].includes(p.byKind)))
        return bad(pl, 'completedAt', 'and byKind must be typed or null');
      parties.push({
        partyType: p.partyType,
        method: orNull(p.method),
        completedAt: orNull(p.completedAt),
        byKind: orNull(p.byKind),
      });
    }
  }
  for (const k of ['cancelledAt', 'revokedAt', 'voidedAt'])
    if (raw[k] !== undefined) notes.push(`${label}: dead field ${k} dropped (read by no writer, written by none)`);
  const known = new Set([
    'id',
    'playerId',
    'playerName',
    'orgId',
    'orgName',
    'userId',
    'scoutName',
    'ts',
    'signedAt',
    'firstQualifyingInteraction',
    'attributionWindowMonths',
    'insideAttributionWindow',
    'method',
    'note',
    'signingPackageId',
    'signingRevisionId',
    'signingRevisionNumber',
    'caseId',
    'offerId',
    'offerRevisionId',
    'transactionId',
    'documentSha256',
    'documentEvidenceId',
    'executedDocumentEvidenceId',
    'contract',
    'parties',
    'policyVersion',
    'cancelledAt',
    'revokedAt',
    'voidedAt',
  ]);
  for (const k of Object.keys(raw)) if (!known.has(k)) notes.push(`${label}: unknown field ${k} dropped`);
  const record = {
    id: raw.id,
    playerId: raw.playerId,
    playerName: orNull(raw.playerName),
    orgId: raw.orgId,
    orgName: orNull(raw.orgName),
    userId: orNull(raw.userId),
    scoutName: orNull(raw.scoutName),
    ts: raw.ts,
    signedAt: orNull(raw.signedAt),
    firstQualifyingInteraction: first,
    attributionWindowMonths: orNull(raw.attributionWindowMonths),
    insideAttributionWindow: raw.insideAttributionWindow === true,
    method,
    note: orNull(raw.note),
    signingPackageId: orNull(raw.signingPackageId),
    signingRevisionId: orNull(raw.signingRevisionId),
    signingRevisionNumber: orNull(raw.signingRevisionNumber),
    caseId: orNull(raw.caseId),
    offerId: orNull(raw.offerId),
    offerRevisionId: orNull(raw.offerRevisionId),
    transactionId: orNull(raw.transactionId),
    documentSha256: raw.documentSha256 == null ? null : raw.documentSha256.toLowerCase(),
    documentEvidenceId: orNull(raw.documentEvidenceId),
    executedDocumentEvidenceId: orNull(raw.executedDocumentEvidenceId),
    contract: contract.value,
    parties,
    policyVersion: orNull(raw.policyVersion),
  };
  return { ok: true, record, notes };
}

export function typeFollowUp(raw, at = 'followUps') {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  if (!nonEmpty(raw.id)) return bad(at, 'id', 'must be a non-empty string');
  const label = `${at} ${raw.id}`;
  const notes = [];
  for (const k of ['signingId', 'playerId', 'orgId'])
    if (!nonEmpty(raw[k])) return bad(label, k, 'must be a non-empty string');
  if (!FOLLOW_UP_MILESTONES.includes(raw.milestone))
    return bad(label, 'milestone', `must be one of ${FOLLOW_UP_MILESTONES.join('|')} (got ${describe(raw.milestone)})`);
  if (!isInt(raw.dueAt) || !isInt(raw.createdAt)) return bad(label, 'dueAt', 'and createdAt must be integer instants');
  if (!FOLLOW_UP_STATUSES.includes(raw.status))
    return bad(label, 'status', `must be one of ${FOLLOW_UP_STATUSES.join('|')} (got ${describe(raw.status)})`);
  if (!optInt(raw.notifiedAt)) return bad(label, 'notifiedAt', 'must be an integer instant or null');
  for (const k of Object.keys(raw))
    if (
      !['id', 'signingId', 'playerId', 'orgId', 'milestone', 'dueAt', 'status', 'notifiedAt', 'createdAt'].includes(k)
    )
      notes.push(`${label}: unknown field ${k} dropped`);
  return {
    ok: true,
    record: {
      id: raw.id,
      signingId: raw.signingId,
      playerId: raw.playerId,
      orgId: raw.orgId,
      milestone: raw.milestone,
      dueAt: raw.dueAt,
      status: raw.status,
      notifiedAt: orNull(raw.notifiedAt),
      createdAt: raw.createdAt,
    },
    notes,
  };
}

export function typeOutcomeReport(raw, at = 'outcomeReports') {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  if (!nonEmpty(raw.id)) return bad(at, 'id', 'must be a non-empty string');
  const label = `${at} ${raw.id}`;
  const notes = [];
  for (const k of ['followUpId', 'signingId', 'playerId', 'orgId'])
    if (!nonEmpty(raw[k])) return bad(label, k, 'must be a non-empty string');
  if (!isPlainObject(raw.by) || raw.by.kind !== 'org' || !nonEmpty(raw.by.id) || !optStr(raw.by.name))
    return bad(label, 'by', 'must be {kind: "org", id, name}');
  if (!REGISTRATION_STATUSES.includes(raw.registrationStatus))
    return bad(
      label,
      'registrationStatus',
      `must be one of ${REGISTRATION_STATUSES.join('|')} (got ${describe(raw.registrationStatus)})`,
    );
  if (!optInt(raw.matchesPlayed) || (isInt(raw.matchesPlayed) && raw.matchesPlayed < 0))
    return bad(label, 'matchesPlayed', 'must be a non-negative integer or null');
  for (const [k, max] of [
    ['progression', LIMITS.progression],
    ['endReason', LIMITS.endReason],
    ['note', LIMITS.outcomeNote],
  ]) {
    if (!optStr(raw[k])) return bad(label, k, 'must be text or null');
    if (isStr(raw[k]) && raw[k].length > max) return bad(label, k, `exceeds ${max} characters`);
  }
  if (!OUTCOME_STATUSES.includes(raw.status))
    return bad(label, 'status', `must be one of ${OUTCOME_STATUSES.join('|')}`);
  if (!isInt(raw.at)) return bad(label, 'at', 'must be an integer instant');
  const confirmations = [];
  const seen = new Set();
  if (raw.confirmations !== undefined && raw.confirmations !== null) {
    if (!Array.isArray(raw.confirmations))
      return bad(label, 'confirmations', `must be an array (got ${describe(raw.confirmations)})`);
    for (let i = 0; i < raw.confirmations.length; i++) {
      const c = typeConfirmation(raw.confirmations[i], `${label}.confirmations[${i}]`);
      if (!c.ok) return c;
      if (seen.has(c.record.by.id))
        return bad(label, `confirmations[${i}].by.id`, `duplicates ${c.record.by.id} (one answer per person)`);
      seen.add(c.record.by.id);
      confirmations.push(c.record);
    }
  }
  for (const k of Object.keys(raw))
    if (
      ![
        'id',
        'followUpId',
        'signingId',
        'playerId',
        'orgId',
        'by',
        'registrationStatus',
        'matchesPlayed',
        'progression',
        'endReason',
        'note',
        'status',
        'confirmations',
        'at',
      ].includes(k)
    )
      notes.push(`${label}: unknown field ${k} dropped`);
  return {
    ok: true,
    record: {
      id: raw.id,
      followUpId: raw.followUpId,
      signingId: raw.signingId,
      playerId: raw.playerId,
      orgId: raw.orgId,
      by: { kind: 'org', id: raw.by.id, name: orNull(raw.by.name) },
      registrationStatus: raw.registrationStatus,
      matchesPlayed: orNull(raw.matchesPlayed),
      progression: orNull(raw.progression),
      endReason: orNull(raw.endReason),
      note: orNull(raw.note),
      status: raw.status,
      confirmations,
      at: raw.at,
    },
    notes,
  };
}
export function typeConfirmation(c, label) {
  if (!isPlainObject(c)) return { ok: false, reason: `${label} is not an object` };
  if (!isPlainObject(c.by) || !['player', 'guardian'].includes(c.by.kind) || !nonEmpty(c.by.id) || !optStr(c.by.name))
    return bad(label, 'by', 'must be {kind: player|guardian, id, name}');
  if (typeof c.agree !== 'boolean') return bad(label, 'agree', 'must be a boolean');
  if (!optStr(c.note) || (isStr(c.note) && c.note.length > LIMITS.outcomeNote))
    return bad(label, 'note', `must be text of at most ${LIMITS.outcomeNote} characters or null`);
  if (
    c.experienceRating !== undefined &&
    c.experienceRating !== null &&
    !(isInt(c.experienceRating) && c.experienceRating >= 1 && c.experienceRating <= 5)
  )
    return bad(label, 'experienceRating', 'must be 1–5 or null');
  if (!isInt(c.at)) return bad(label, 'at', 'must be an integer instant');
  return {
    ok: true,
    record: {
      by: { kind: c.by.kind, id: c.by.id, name: orNull(c.by.name) },
      agree: c.agree,
      note: orNull(c.note),
      experienceRating: orNull(c.experienceRating),
      at: c.at,
    },
  };
}

// ------------------------------------------------------------------ rows ↔ records
const insertFor = (sqlite, table, cols, { upsert = null } = {}) =>
  sqlite.prepare(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})${
      upsert
        ? ` ON CONFLICT(${upsert}) DO UPDATE SET ${cols
            .filter((c) => c !== upsert)
            .map((c) => `${c} = excluded.${c}`)
            .join(', ')}`
        : ''
    }`,
  );
const PKG_COLS = [
  'id',
  'org_id',
  'case_id',
  'player_id',
  'offer_id',
  'offer_revision_id',
  'transaction_id',
  'status',
  'current_revision_id',
  'expires_at',
  'internal_note',
  'completion_signing_id',
  'completion_completed_at',
  'completion_by_kind',
  'completion_by_user_id',
  'completion_by_name',
  'completion_by_role',
  'completion_contract_start_date',
  'completion_contract_end_date',
  'completion_document_sha256',
  'completion_lifecycle_from',
  'completion_lifecycle_to',
  'completion_lifecycle_at',
  'cancelled_at',
  'cancelled_by_kind',
  'cancelled_by_user_id',
  'cancelled_by_name',
  'cancelled_by_role',
  'cancel_reason',
  'voided_at',
  'voided_by_kind',
  'voided_by_id',
  'voided_by_name',
  'voided_by_role',
  'void_reason',
  'created_at',
  'created_by_kind',
  'created_by_user_id',
  'created_by_name',
  'created_by_role',
  'updated_at',
  'rev',
  'rev_at',
  'rev_by_user_id',
  'rev_by_name',
  'policy_version',
  'subject_removed_at',
];
const REV_COLS = [
  'id',
  'package_id',
  'position',
  'revision_number',
  'status',
  'created_at',
  'created_by_kind',
  'created_by_user_id',
  'created_by_name',
  'created_by_role',
  'ready_at',
  'ready_by_kind',
  'ready_by_user_id',
  'ready_by_name',
  'ready_by_role',
  'completed_at',
  'completed_by_kind',
  'completed_by_user_id',
  'completed_by_name',
  'completed_by_role',
  'superseded_at',
  'contract_start_date',
  'contract_end_date',
  'policy_version',
  'policy_jurisdiction',
  'policy_offer_policy_version',
  'supersedes_revision_id',
  'superseded_by_revision_id',
];
const DOC_COLS = [
  'id',
  'revision_id',
  'kind',
  'evidence_id',
  'sha256',
  'filename',
  'mime',
  'bytes',
  'label',
  'uploaded_at',
  'uploaded_by_kind',
  'uploaded_by_user_id',
  'uploaded_by_name',
  'uploaded_by_role',
];
const PARTY_COLS = [
  'revision_id',
  'position',
  'party_type',
  'for_entity_id',
  'for_player_id',
  'status',
  'completed_at',
  'completed_by_kind',
  'completed_by_id',
  'completed_by_name',
  'method',
  'evidence_ref_kind',
  'evidence_ref_id',
  'evidence_revision_id',
  'evidence_document_sha256',
  'evidence_at',
  'evidence_actor_kind',
  'evidence_actor_id',
  'evidence_session',
];
const HIST_COLS = ['id', 'package_id', 'position', 'at', 'by_kind', 'by_id', 'by_name', 'action', 'detail_json'];
const KEY_COLS = ['owner_table', 'owner_id', 'position', 'act', 'shape', 'key', 'fp', 'at', 'entry_json'];
const SIGNING_COLS = [
  'id',
  'player_id',
  'player_name',
  'org_id',
  'org_name',
  'user_id',
  'scout_name',
  'ts',
  'signed_at',
  'first_qualifying_ledger_id',
  'first_qualifying_at',
  'first_qualifying_type',
  'attribution_window_months',
  'inside_attribution_window',
  'method',
  'note',
  'signing_package_id',
  'signing_revision_id',
  'signing_revision_number',
  'case_id',
  'offer_id',
  'offer_revision_id',
  'transaction_id',
  'document_sha256',
  'document_evidence_id',
  'executed_document_evidence_id',
  'contract_start_date',
  'contract_end_date',
  'policy_version',
];
const SPARTY_COLS = ['signing_id', 'position', 'party_type', 'method', 'completed_at', 'by_kind'];
const FUP_COLS = [
  'id',
  'signing_id',
  'player_id',
  'org_id',
  'milestone',
  'due_at',
  'status',
  'notified_at',
  'created_at',
];
const OUT_COLS = [
  'id',
  'follow_up_id',
  'signing_id',
  'player_id',
  'org_id',
  'by_user_id',
  'by_name',
  'registration_status',
  'matches_played',
  'progression',
  'end_reason',
  'note',
  'status',
  'at',
];
const CONF_COLS = ['report_id', 'position', 'by_kind', 'by_id', 'by_name', 'agree', 'note', 'experience_rating', 'at'];

function pkgRow(p) {
  const c = p.completion;
  return {
    id: p.id,
    org_id: p.orgId,
    case_id: p.caseId,
    player_id: p.playerId,
    offer_id: p.offerId,
    offer_revision_id: p.offerRevisionId,
    transaction_id: p.transactionId,
    status: p.status,
    current_revision_id: p.currentRevisionId,
    expires_at: p.expiresAt,
    internal_note: p.internalNote,
    completion_signing_id: c?.signingId ?? null,
    completion_completed_at: c?.completedAt ?? null,
    ...actorCols('completion_by', c?.completedBy ?? null),
    completion_contract_start_date: c?.contract?.startDate ?? null,
    completion_contract_end_date: c?.contract?.endDate ?? null,
    completion_document_sha256: c?.documentSha256 ?? null,
    completion_lifecycle_from: c?.lifecycle?.from ?? null,
    completion_lifecycle_to: c?.lifecycle?.to ?? null,
    completion_lifecycle_at: c?.lifecycle?.at ?? null,
    cancelled_at: p.cancelledAt,
    ...actorCols('cancelled_by', p.cancelledBy),
    cancel_reason: p.cancelReason,
    voided_at: p.voidedAt,
    ...actorCols('voided_by', p.voidedBy, { user: false }),
    void_reason: p.voidReason,
    created_at: p.createdAt,
    ...actorCols('created_by', p.createdBy),
    updated_at: p.updatedAt,
    rev: p.rev,
    rev_at: p.revAt,
    rev_by_user_id: p.revBy?.userId ?? null,
    rev_by_name: p.revBy?.name ?? null,
    policy_version: p.policyVersion,
    subject_removed_at: p.subjectRemovedAt,
  };
}
const revRow = (pkgId, r, position) => ({
  id: r.id,
  package_id: pkgId,
  position,
  revision_number: r.revisionNumber,
  status: r.status,
  created_at: r.createdAt,
  ...actorCols('created_by', r.createdBy),
  ready_at: r.readyAt,
  ...actorCols('ready_by', r.readyBy),
  completed_at: r.completedAt,
  ...actorCols('completed_by', r.completedBy),
  superseded_at: r.supersededAt,
  contract_start_date: r.contract?.startDate ?? null,
  contract_end_date: r.contract?.endDate ?? null,
  policy_version: r.policySnapshot?.policyVersion ?? null,
  policy_jurisdiction: r.policySnapshot?.jurisdiction ?? null,
  policy_offer_policy_version: r.policySnapshot?.offerPolicyVersion ?? null,
  supersedes_revision_id: r.supersedesRevisionId,
  superseded_by_revision_id: r.supersededByRevisionId,
});
const docRow = (revId, kind, d) => ({
  id: d.id,
  revision_id: revId,
  kind,
  evidence_id: d.evidenceId,
  sha256: d.sha256,
  filename: d.filename,
  mime: d.mime,
  bytes: d.bytes,
  label: d.label,
  uploaded_at: d.uploadedAt,
  ...actorCols('uploaded_by', d.uploadedBy),
});
const partyRow = (revId, p, position) => ({
  revision_id: revId,
  position,
  party_type: p.partyType,
  for_entity_id: p.forEntityId,
  for_player_id: p.forPlayerId,
  status: p.status,
  completed_at: p.completedAt,
  completed_by_kind: p.completedBy?.kind ?? null,
  completed_by_id: p.completedBy?.id ?? null,
  completed_by_name: p.completedBy?.name ?? null,
  method: p.method,
  evidence_ref_kind: p.evidenceRef?.kind ?? null,
  evidence_ref_id: p.evidenceRef?.id ?? null,
  evidence_revision_id: p.evidenceRef?.revisionId ?? null,
  evidence_document_sha256: p.evidenceRef?.documentSha256 ?? null,
  evidence_at: p.evidenceRef?.at ?? null,
  evidence_actor_kind: p.evidenceRef?.actorKind ?? null,
  evidence_actor_id: p.evidenceRef?.actorId ?? null,
  evidence_session: p.evidenceRef?.session ?? null,
});
const histRow = (pkgId, h, position) => ({
  id: h.id,
  package_id: pkgId,
  position,
  at: h.at,
  by_kind: h.by?.kind ?? null,
  by_id: h.by?.id ?? null,
  by_name: h.by?.name ?? null,
  action: h.action,
  detail_json: h.detail === null ? null : JSON.stringify(h.detail),
});
function keyRows(pkgId, keys) {
  const rows = [];
  let position = 0;
  if (keys.start)
    rows.push({
      owner_table: 'signing_packages',
      owner_id: pkgId,
      position: position++,
      act: 'start',
      shape: 'value',
      key: keys.start.key,
      fp: keys.start.fp,
      at: null,
      entry_json: JSON.stringify(keys.start),
    });
  for (const act of PACKAGE_KEY_ACTS.slice(1))
    for (const e of keys[act] ?? [])
      rows.push({
        owner_table: 'signing_packages',
        owner_id: pkgId,
        position: position++,
        act,
        shape: 'list',
        key: e.key,
        fp: e.fp,
        at: e.at ?? null,
        entry_json: JSON.stringify(e),
      });
  return rows;
}
const signingRow = (s) => ({
  id: s.id,
  player_id: s.playerId,
  player_name: s.playerName,
  org_id: s.orgId,
  org_name: s.orgName,
  user_id: s.userId,
  scout_name: s.scoutName,
  ts: s.ts,
  signed_at: s.signedAt,
  first_qualifying_ledger_id: s.firstQualifyingInteraction?.id ?? null,
  first_qualifying_at: s.firstQualifyingInteraction?.ts ?? null,
  first_qualifying_type: s.firstQualifyingInteraction?.type ?? null,
  attribution_window_months: s.attributionWindowMonths,
  inside_attribution_window: s.insideAttributionWindow ? 1 : 0,
  method: s.method,
  note: s.note,
  signing_package_id: s.signingPackageId,
  signing_revision_id: s.signingRevisionId,
  signing_revision_number: s.signingRevisionNumber,
  case_id: s.caseId,
  offer_id: s.offerId,
  offer_revision_id: s.offerRevisionId,
  transaction_id: s.transactionId,
  document_sha256: s.documentSha256,
  document_evidence_id: s.documentEvidenceId,
  executed_document_evidence_id: s.executedDocumentEvidenceId,
  contract_start_date: s.contract?.startDate ?? null,
  contract_end_date: s.contract?.endDate ?? null,
  policy_version: s.policyVersion,
});
const spartyRow = (sid, p, position) => ({
  signing_id: sid,
  position,
  party_type: p.partyType,
  method: p.method,
  completed_at: p.completedAt,
  by_kind: p.byKind,
});
const fupRow = (f) => ({
  id: f.id,
  signing_id: f.signingId,
  player_id: f.playerId,
  org_id: f.orgId,
  milestone: f.milestone,
  due_at: f.dueAt,
  status: f.status,
  notified_at: f.notifiedAt,
  created_at: f.createdAt,
});
const outRow = (r) => ({
  id: r.id,
  follow_up_id: r.followUpId,
  signing_id: r.signingId,
  player_id: r.playerId,
  org_id: r.orgId,
  by_user_id: r.by.id,
  by_name: r.by.name,
  registration_status: r.registrationStatus,
  matches_played: r.matchesPlayed,
  progression: r.progression,
  end_reason: r.endReason,
  note: r.note,
  status: r.status,
  at: r.at,
});
const confRow = (rid, c, position) => ({
  report_id: rid,
  position,
  by_kind: c.by.kind,
  by_id: c.by.id,
  by_name: c.by.name,
  agree: c.agree ? 1 : 0,
  note: c.note,
  experience_rating: c.experienceRating,
  at: c.at,
});

/** Prepared statements over one connection. */
function statements(sqlite) {
  return {
    pkg: insertFor(sqlite, 'signing_packages', PKG_COLS, { upsert: 'id' }),
    rev: insertFor(sqlite, 'signing_revisions', REV_COLS, { upsert: 'id' }),
    doc: insertFor(sqlite, 'signing_documents', DOC_COLS),
    party: insertFor(sqlite, 'signing_revision_parties', PARTY_COLS),
    hist: insertFor(sqlite, 'signing_history', HIST_COLS),
    key: insertFor(sqlite, 'idempotency_keys', KEY_COLS),
    signing: insertFor(sqlite, 'signings', SIGNING_COLS, { upsert: 'id' }),
    sparty: insertFor(sqlite, 'signing_parties', SPARTY_COLS),
    fup: insertFor(sqlite, 'follow_ups', FUP_COLS, { upsert: 'id' }),
    out: insertFor(sqlite, 'outcome_reports', OUT_COLS, { upsert: 'id' }),
    conf: insertFor(sqlite, 'outcome_report_confirmations', CONF_COLS),
    docsOf: sqlite.prepare(
      'DELETE FROM signing_documents WHERE revision_id IN (SELECT id FROM signing_revisions WHERE package_id = ?)',
    ),
    partiesOf: sqlite.prepare(
      'DELETE FROM signing_revision_parties WHERE revision_id IN (SELECT id FROM signing_revisions WHERE package_id = ?)',
    ),
    histOf: sqlite.prepare('DELETE FROM signing_history WHERE package_id = ?'),
    keysOf: sqlite.prepare("DELETE FROM idempotency_keys WHERE owner_table = 'signing_packages' AND owner_id = ?"),
    revsOf: sqlite.prepare('DELETE FROM signing_revisions WHERE package_id = ?'),
    revsNotIn: (ids_) =>
      sqlite.prepare(
        `DELETE FROM signing_revisions WHERE package_id = ? AND id NOT IN (${ids_.map(() => '?').join(', ')})`,
      ),
    pkgDel: sqlite.prepare('DELETE FROM signing_packages WHERE id = ?'),
    spartiesOf: sqlite.prepare('DELETE FROM signing_parties WHERE signing_id = ?'),
    signingDel: sqlite.prepare('DELETE FROM signings WHERE id = ?'),
    fupDel: sqlite.prepare('DELETE FROM follow_ups WHERE id = ?'),
    confsOf: sqlite.prepare('DELETE FROM outcome_report_confirmations WHERE report_id = ?'),
    outDel: sqlite.prepare('DELETE FROM outcome_reports WHERE id = ?'),
    pkgById: sqlite.prepare('SELECT * FROM signing_packages WHERE id = ?'),
    pkgAll: sqlite.prepare('SELECT * FROM signing_packages ORDER BY rowid'),
    revsBy: sqlite.prepare('SELECT * FROM signing_revisions WHERE package_id = ? ORDER BY position'),
    docsBy: sqlite.prepare('SELECT * FROM signing_documents WHERE revision_id = ?'),
    partiesBy: sqlite.prepare('SELECT * FROM signing_revision_parties WHERE revision_id = ? ORDER BY position'),
    histBy: sqlite.prepare('SELECT * FROM signing_history WHERE package_id = ? ORDER BY position'),
    keysBy: sqlite.prepare(
      "SELECT * FROM idempotency_keys WHERE owner_table = 'signing_packages' AND owner_id = ? ORDER BY position",
    ),
    signingById: sqlite.prepare('SELECT * FROM signings WHERE id = ?'),
    signingAll: sqlite.prepare('SELECT * FROM signings ORDER BY rowid'),
    spartiesBy: sqlite.prepare('SELECT * FROM signing_parties WHERE signing_id = ? ORDER BY position'),
    fupById: sqlite.prepare('SELECT * FROM follow_ups WHERE id = ?'),
    fupAll: sqlite.prepare('SELECT * FROM follow_ups ORDER BY rowid'),
    outById: sqlite.prepare('SELECT * FROM outcome_reports WHERE id = ?'),
    outAll: sqlite.prepare('SELECT * FROM outcome_reports ORDER BY rowid'),
    confsBy: sqlite.prepare('SELECT * FROM outcome_report_confirmations WHERE report_id = ? ORDER BY position'),
    ids: (table) =>
      sqlite
        .prepare(`SELECT id FROM ${table} ORDER BY rowid`)
        .all()
        .map((r) => r.id),
  };
}
/**
 * The statements `decodePackage` and `decodeSigning` read children through, answered for many records at once: each
 * child table read once for the whole list (a package's documents and parties through its
 * revisions) instead of three queries a package plus two a revision. Same rows, same order.
 */
function batchStatements(sqlite, st, { packageIds = [], signingIds = [] }) {
  const revsBy = childRowsOf(sqlite, 'signing_revisions', 'package_id', packageIds, { order: 'position' });
  const revisionIds = packageIds.flatMap((id) => revsBy.all(id).map((r) => r.id));
  return {
    ...st,
    revsBy,
    docsBy: childRowsOf(sqlite, 'signing_documents', 'revision_id', revisionIds),
    partiesBy: childRowsOf(sqlite, 'signing_revision_parties', 'revision_id', revisionIds, { order: 'position' }),
    histBy: childRowsOf(sqlite, 'signing_history', 'package_id', packageIds, { order: 'position' }),
    keysBy: childRowsOf(sqlite, 'idempotency_keys', 'owner_id', packageIds, {
      order: 'position',
      where: "owner_table = 'signing_packages'",
    }),
    spartiesBy: childRowsOf(sqlite, 'signing_parties', 'signing_id', signingIds, { order: 'position' }),
  };
}
const contractOut = (row, p) =>
  row[`${p}start_date`] === null && row[`${p}end_date`] === null
    ? null
    : { startDate: row[`${p}start_date`], endDate: row[`${p}end_date`] };
function decodeDocument(row) {
  return {
    id: row.id,
    evidenceId: row.evidence_id,
    sha256: row.sha256,
    filename: row.filename,
    mime: row.mime,
    bytes: row.bytes,
    label: row.label,
    uploadedAt: row.uploaded_at,
    uploadedBy: actorOut('uploaded_by', row),
  };
}
function decodeParty(row) {
  const ev =
    row.evidence_ref_kind === null && row.evidence_ref_id === null
      ? null
      : {
          kind: row.evidence_ref_kind,
          id: row.evidence_ref_id,
          revisionId: row.evidence_revision_id,
          documentSha256: row.evidence_document_sha256,
          at: row.evidence_at,
          actorKind: row.evidence_actor_kind,
          actorId: row.evidence_actor_id,
          session: row.evidence_session,
        };
  const by =
    row.completed_by_kind === null && row.completed_by_id === null && row.completed_by_name === null
      ? null
      : { kind: row.completed_by_kind, id: row.completed_by_id, name: row.completed_by_name };
  return {
    partyType: row.party_type,
    forEntityId: row.for_entity_id,
    forPlayerId: row.for_player_id,
    status: row.status,
    completedAt: row.completed_at,
    completedBy: by,
    evidenceRef: ev,
    method: row.method,
  };
}
function decodePackage(st, row) {
  const revisions = st.revsBy.all(row.id).map((r) => {
    const docs = st.docsBy.all(r.id);
    const d = docs.find((x) => x.kind === 'signing');
    const x = docs.find((y) => y.kind === 'executed');
    const policy =
      r.policy_version === null && r.policy_jurisdiction === null && r.policy_offer_policy_version === null
        ? null
        : {
            policyVersion: r.policy_version,
            jurisdiction: r.policy_jurisdiction,
            offerPolicyVersion: r.policy_offer_policy_version,
          };
    return {
      id: r.id,
      revisionNumber: r.revision_number,
      status: r.status,
      createdAt: r.created_at,
      createdBy: actorOut('created_by', r),
      readyAt: r.ready_at,
      readyBy: actorOut('ready_by', r),
      completedAt: r.completed_at,
      completedBy: actorOut('completed_by', r),
      document: d ? decodeDocument(d) : null,
      executedDocument: x ? decodeDocument(x) : null,
      contract: contractOut(r, 'contract_'),
      requiredParties: st.partiesBy.all(r.id).map(decodeParty),
      policySnapshot: policy,
      supersedesRevisionId: r.supersedes_revision_id,
      supersededByRevisionId: r.superseded_by_revision_id,
      supersededAt: r.superseded_at,
    };
  });
  const keys = { start: null, ready: [], party: [], cancel: [], void: [], supersede: [], complete: [] };
  for (const k of st.keysBy.all(row.id)) {
    const entry = JSON.parse(k.entry_json);
    if (k.act === 'start') keys.start = entry;
    else keys[k.act].push(entry);
  }
  const history = st.histBy.all(row.id).map((h) => ({
    id: h.id,
    at: h.at,
    action: h.action,
    by:
      h.by_kind === null && h.by_id === null && h.by_name === null
        ? null
        : { kind: h.by_kind, id: h.by_id, name: h.by_name },
    detail: h.detail_json === null ? null : JSON.parse(h.detail_json),
  }));
  const completion =
    row.completion_signing_id === null
      ? null
      : {
          signingId: row.completion_signing_id,
          completedAt: row.completion_completed_at,
          completedBy: actorOut('completion_by', row),
          contract: contractOut(row, 'completion_contract_'),
          documentSha256: row.completion_document_sha256,
          lifecycle:
            row.completion_lifecycle_from === null &&
            row.completion_lifecycle_to === null &&
            row.completion_lifecycle_at === null
              ? null
              : {
                  from: row.completion_lifecycle_from,
                  to: row.completion_lifecycle_to,
                  at: row.completion_lifecycle_at,
                },
        };
  return {
    id: row.id,
    orgId: row.org_id,
    caseId: row.case_id,
    playerId: row.player_id,
    offerId: row.offer_id,
    offerRevisionId: row.offer_revision_id,
    transactionId: row.transaction_id,
    status: row.status,
    currentRevisionId: row.current_revision_id,
    revisions,
    expiresAt: row.expires_at,
    internalNote: row.internal_note,
    keys,
    history,
    completion,
    cancelledAt: row.cancelled_at,
    cancelledBy: actorOut('cancelled_by', row),
    cancelReason: row.cancel_reason,
    voidedAt: row.voided_at,
    voidedBy: actorOut('voided_by', row, { user: false }),
    voidReason: row.void_reason,
    createdAt: row.created_at,
    createdBy: actorOut('created_by', row),
    updatedAt: row.updated_at,
    rev: row.rev,
    revAt: row.rev_at,
    revBy:
      row.rev_by_user_id === null && row.rev_by_name === null
        ? null
        : { userId: row.rev_by_user_id, name: row.rev_by_name },
    policyVersion: row.policy_version,
    subjectRemovedAt: row.subject_removed_at,
  };
}
function decodeSigning(st, row) {
  return {
    id: row.id,
    playerId: row.player_id,
    playerName: row.player_name,
    orgId: row.org_id,
    orgName: row.org_name,
    userId: row.user_id,
    scoutName: row.scout_name,
    ts: row.ts,
    signedAt: row.signed_at,
    firstQualifyingInteraction:
      row.first_qualifying_ledger_id === null && row.first_qualifying_at === null && row.first_qualifying_type === null
        ? null
        : { id: row.first_qualifying_ledger_id, ts: row.first_qualifying_at, type: row.first_qualifying_type },
    attributionWindowMonths: row.attribution_window_months,
    insideAttributionWindow: row.inside_attribution_window === 1,
    method: row.method,
    note: row.note,
    signingPackageId: row.signing_package_id,
    signingRevisionId: row.signing_revision_id,
    signingRevisionNumber: row.signing_revision_number,
    caseId: row.case_id,
    offerId: row.offer_id,
    offerRevisionId: row.offer_revision_id,
    transactionId: row.transaction_id,
    documentSha256: row.document_sha256,
    documentEvidenceId: row.document_evidence_id,
    executedDocumentEvidenceId: row.executed_document_evidence_id,
    contract: contractOut(row, 'contract_'),
    parties: st.spartiesBy
      .all(row.id)
      .map((p) => ({ partyType: p.party_type, method: p.method, completedAt: p.completed_at, byKind: p.by_kind })),
    policyVersion: row.policy_version,
  };
}
const decodeFollowUp = (row) => ({
  id: row.id,
  signingId: row.signing_id,
  playerId: row.player_id,
  orgId: row.org_id,
  milestone: row.milestone,
  dueAt: row.due_at,
  status: row.status,
  notifiedAt: row.notified_at,
  createdAt: row.created_at,
});
const decodeOutcome = (st, row) => ({
  id: row.id,
  followUpId: row.follow_up_id,
  signingId: row.signing_id,
  playerId: row.player_id,
  orgId: row.org_id,
  by: { kind: 'org', id: row.by_user_id, name: row.by_name },
  registrationStatus: row.registration_status,
  matchesPlayed: row.matches_played,
  progression: row.progression,
  endReason: row.end_reason,
  note: row.note,
  status: row.status,
  confirmations: st.confsBy.all(row.id).map((c) => ({
    by: { kind: c.by_kind, id: c.by_id, name: c.by_name },
    agree: c.agree === 1,
    note: c.note,
    experienceRating: c.experience_rating,
    at: c.at,
  })),
  at: row.at,
});

/** Write a typed package whole (its revisions by upsert — a signing may reference one — and the rest replaced). */
function writePackage(st, p) {
  st.pkg.run(pkgRow(p));
  st.docsOf.run(p.id);
  st.partiesOf.run(p.id);
  st.histOf.run(p.id);
  st.keysOf.run(p.id);
  st.revsNotIn(p.revisions.map((r) => r.id)).run(p.id, ...p.revisions.map((r) => r.id));
  p.revisions.forEach((r, i) => {
    st.rev.run(revRow(p.id, r, i));
    if (r.document) st.doc.run(docRow(r.id, 'signing', r.document));
    if (r.executedDocument) st.doc.run(docRow(r.id, 'executed', r.executedDocument));
    r.requiredParties.forEach((pt, j) => st.party.run(partyRow(r.id, pt, j)));
  });
  p.history.forEach((h, i) => st.hist.run(histRow(p.id, h, i)));
  for (const k of keyRows(p.id, p.keys)) st.key.run(k);
}
function writeSigning(st, s) {
  st.signing.run(signingRow(s));
  st.spartiesOf.run(s.id);
  s.parties.forEach((p, i) => st.sparty.run(spartyRow(s.id, p, i)));
}
function writeOutcome(st, r) {
  st.out.run(outRow(r));
  st.confsOf.run(r.id);
  r.confirmations.forEach((c, i) => st.conf.run(confRow(r.id, c, i)));
}

const PLAYER_REFS_SQL = {
  signingPackages:
    "SELECT player_id AS pid FROM signing_packages UNION ALL SELECT for_player_id FROM signing_revision_parties WHERE for_player_id IS NOT NULL UNION ALL SELECT for_entity_id FROM signing_revision_parties WHERE party_type = 'PLAYER' AND for_entity_id IS NOT NULL UNION ALL SELECT completed_by_id FROM signing_revision_parties WHERE completed_by_kind = 'player' AND completed_by_id IS NOT NULL UNION ALL SELECT by_id FROM signing_history WHERE by_kind = 'player' AND by_id IS NOT NULL",
  signings: 'SELECT player_id AS pid FROM signings',
  followUps: 'SELECT player_id AS pid FROM follow_ups',
  outcomeReports:
    "SELECT player_id AS pid FROM outcome_reports UNION ALL SELECT by_id FROM outcome_report_confirmations WHERE by_kind = 'player'",
};
export const signingsFollowUpsLive = (sqlite) => migrationApplied(sqlite, SIGNINGS_FOLLOWUPS_MIGRATION);
export function unresolvedPlayerReferences(sqlite) {
  if (!signingsFollowUpsLive(sqlite)) return null;
  return Object.fromEntries(
    SIGNINGS_FOLLOWUPS_COLLECTIONS.map((c) => [
      c,
      sqlite
        .prepare(
          `SELECT count(*) AS n FROM (${PLAYER_REFS_SQL[c]}) x WHERE NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid)`,
        )
        .get().n,
    ]),
  );
}
export function retainedPlayerReferences(sqlite) {
  if (!signingsFollowUpsLive(sqlite)) return null;
  return Object.fromEntries(
    SIGNINGS_FOLLOWUPS_COLLECTIONS.map((c) => [
      c,
      sqlite
        .prepare(
          `SELECT count(*) AS n FROM (${PLAYER_REFS_SQL[c]}) x WHERE EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid AND p.deleted_at IS NOT NULL)`,
        )
        .get().n,
    ]),
  );
}

/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const SIGNINGS_FOLLOWUPS_RECORDS = {
  names: SIGNINGS_FOLLOWUPS_COLLECTIONS,
  read(sqlite) {
    if (!signingsFollowUpsLive(sqlite)) return null;
    const st = statements(sqlite);
    const pkgs = st.pkgAll.all();
    const sgs = st.signingAll.all();
    const bst = batchStatements(sqlite, st, { packageIds: pkgs.map((r) => r.id), signingIds: sgs.map((r) => r.id) });
    return {
      signingPackages: pkgs.map((r) => decodePackage(bst, r)),
      signings: sgs.map((r) => decodeSigning(bst, r)),
      followUps: st.fupAll.all().map(decodeFollowUp),
      outcomeReports: st.outAll.all().map((r) => decodeOutcome(st, r)),
    };
  },
};

// ------------------------------------------------------------------ the repository
const WRITES = new Set([
  'insert',
  'patch',
  'patchRevision',
  'addRevision',
  'setDocument',
  'setParty',
  'addKey',
  'addHistory',
  'redactPlayer',
  'record',
  'schedule',
  'file',
  'addConfirmation',
]);
const SIGNINGS_FOLLOWUPS_TABLES_OF = [
  ['signingPackages', 'signing_packages'],
  ['signings', 'signings'],
  ['followUps', 'follow_ups'],
  ['outcomeReports', 'outcome_reports'],
];
/**
 * `createSigningsFollowUpsRepository({ sqlite, unit, now, log })`. Every operation runs through `operation`: joined into
 * the open unit of work (a failure poisons it), the caller's open raw transaction, or a transaction of its own; it
 * writes its rows and returns the affected record read back from the tables. The arguments are the typed values the
 * routes validated; the columns' CHECKs are the last line, and a violation is a bug surfacing as a failed unit
 * (answered as a failure), never as a silently kept value.
 *
 * Every query decodes fresh, deep-frozen records (an in-place edit throws), in insertion (rowid) order unless it says
 * otherwise, and runs on the one connection, so a read inside a unit of work sees the unit's own writes. The two
 * lists that grow without limit page by cursor (domains/platform/paging.mjs): `followUps.pageForOrg` (due date, then id) and `signings.pageForOrg` (newest first).
 */
export function createSigningsFollowUpsRepository({ sqlite, unit = null, now = Date.now, log = () => {} }) {
  if (!sqlite) throw new TypeError('the signings/follow-ups repository needs a SQLite connection (node:sqlite)');
  const st = statements(sqlite);
  const inUnit = () => !!unit?.active?.();
  const operation = (fn) => (inUnit() ? unit.join(fn) : sqlite.isTransaction ? fn() : transaction(sqlite, fn));
  const decode = {
    signingPackages: (row) => deepFreeze(decodePackage(st, row)),
    signings: (row) => deepFreeze(decodeSigning(st, row)),
    followUps: (row) => deepFreeze(decodeFollowUp(row)),
    outcomeReports: (row) => deepFreeze(decodeOutcome(st, row)),
  };
  const rowById = {
    signingPackages: st.pkgById,
    signings: st.signingById,
    followUps: st.fupById,
    outcomeReports: st.outById,
  };
  const read = (name, id) => {
    if (typeof id !== 'string') return null;
    const row = rowById[name].get(id);
    return row ? decode[name](row) : null;
  };
  const exists = (name, id) => typeof id === 'string' && !!rowById[name].get(id);
  /** Decode many rows; a list of packages or signings reads its children in one batch (batchStatements). */
  const BATCHED = { signingPackages: [decodePackage, 'packageIds'], signings: [decodeSigning, 'signingIds'] };
  const decodeAll = (name, rows) => {
    if (!BATCHED[name] || rows.length < 2) return rows.map(decode[name]);
    const [decodeOne, key] = BATCHED[name];
    const bst = batchStatements(sqlite, st, { [key]: rows.map((r) => r.id) });
    return rows.map((r) => deepFreeze(decodeOne(bst, r)));
  };
  const list = (name, sql) => {
    const stmt = sqlite.prepare(sql);
    return (...args) => decodeAll(name, stmt.all(...args));
  };
  const one = (name, sql) => {
    const stmt = sqlite.prepare(sql);
    return (...args) => {
      const row = stmt.get(...args);
      return row ? decode[name](row) : null;
    };
  };
  const count = (sql) => {
    const stmt = sqlite.prepare(sql);
    return (...args) => stmt.get(...args).n;
  };
  const refreshPackage = (id) => read('signingPackages', id);
  const refreshSigning = (id) => read('signings', id);
  const refreshFollowUp = (id) => read('followUps', id);
  const refreshOutcome = (id) => read('outcomeReports', id);
  const must = (name, id) => {
    const r = read(name, id);
    if (!r) throw refusal('SIGNINGS_NOT_FOUND', `${name} ${id} is not a record of the repository`);
    return r;
  };
  const typedOr = (t) => {
    if (!t.ok) throw refusal('SIGNINGS_INPUT_INVALID', t.reason);
    return t.record;
  };
  // The two cursor-paged lists: the key is part of the row (`page_key`, `page_id`), so a page never re-reads a record.
  const signingPage = {
    first: sqlite.prepare('SELECT rowid AS page_key, * FROM signings WHERE org_id = ? ORDER BY rowid DESC LIMIT ?'),
    after: sqlite.prepare(
      'SELECT rowid AS page_key, * FROM signings WHERE org_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?',
    ),
  };
  const followUpPage = {
    first: sqlite.prepare('SELECT * FROM follow_ups WHERE org_id = ? ORDER BY due_at, id LIMIT ?'),
    after: sqlite.prepare(
      'SELECT * FROM follow_ups WHERE org_id = ? AND (due_at > ? OR (due_at = ? AND id > ?)) ORDER BY due_at, id LIMIT ?',
    ),
  };
  const patchPackage = (id, change) =>
    operation(() => {
      const cur = must('signingPackages', id);
      const next = typedOr(typeSigningPackage({ ...clone(cur), ...change }, 'signingPackages'));
      st.pkg.run(pkgRow(next));
      return refreshPackage(id);
    });
  const patchRevision = (id, revisionId, change) =>
    operation(() => {
      const cur = must('signingPackages', id);
      const revs = cur.revisions.map((r) => (r.id === revisionId ? { ...clone(r), ...change } : clone(r)));
      if (!revs.some((r) => r.id === revisionId))
        throw refusal('SIGNINGS_NOT_FOUND', `signing_revisions ${revisionId} is not a revision of ${id}`);
      const next = typedOr(typeSigningPackage({ ...clone(cur), revisions: revs }, 'signingPackages'));
      const r = next.revisions.find((x) => x.id === revisionId);
      const i = next.revisions.indexOf(r);
      st.rev.run(revRow(id, r, i));
      sqlite.prepare('DELETE FROM signing_documents WHERE revision_id = ?').run(revisionId);
      if (r.document) st.doc.run(docRow(r.id, 'signing', r.document));
      if (r.executedDocument) st.doc.run(docRow(r.id, 'executed', r.executedDocument));
      sqlite.prepare('DELETE FROM signing_revision_parties WHERE revision_id = ?').run(revisionId);
      r.requiredParties.forEach((pt, j) => st.party.run(partyRow(r.id, pt, j)));
      return refreshPackage(id);
    });

  const signingPackages = {
    /** The package the start route built (revision 1, its parties, the start key, no history yet). */
    insert(raw) {
      return operation(() => {
        const p = typedOr(typeSigningPackage(raw, 'signingPackages'));
        if (exists('signingPackages', p.id))
          throw refusal('SIGNINGS_DUPLICATE', `signing_packages ${p.id} already exists`);
        writePackage(st, p);
        return refreshPackage(p.id);
      });
    },
    patch(id, change) {
      for (const k of Object.keys(change))
        if (
          [
            'id',
            'revisions',
            'keys',
            'history',
            'orgId',
            'caseId',
            'playerId',
            'offerId',
            'offerRevisionId',
            'createdAt',
            'createdBy',
          ].includes(k)
        )
          throw new TypeError(`signingPackages.patch: ${k} is not patched; use the dedicated operation`);
      return patchPackage(id, change);
    },
    patchRevision(id, revisionId, change) {
      for (const k of Object.keys(change))
        if (['id', 'revisionNumber', 'requiredParties', 'createdAt', 'createdBy'].includes(k))
          throw new TypeError(`signingPackages.patchRevision: ${k} is not patched`);
      return patchRevision(id, revisionId, change);
    },
    /** A new revision (the supersede): appended; the caller patches the previous one and the package in the same unit. */
    addRevision(id, rawRevision) {
      return operation(() => {
        const cur = must('signingPackages', id);
        const next = typedOr(
          typeSigningPackage({ ...clone(cur), revisions: [...clone(cur.revisions), rawRevision] }, 'signingPackages'),
        );
        const r = next.revisions[next.revisions.length - 1];
        st.rev.run(revRow(id, r, next.revisions.length - 1));
        r.requiredParties.forEach((pt, j) => st.party.run(partyRow(r.id, pt, j)));
        return refreshPackage(id);
      });
    },
    setDocument(id, revisionId, kind, doc) {
      return patchRevision(id, revisionId, { [kind === 'executed' ? 'executedDocument' : 'document']: doc });
    },
    setParty(id, revisionId, partyType, change) {
      return operation(() => {
        const cur = must('signingPackages', id);
        const rev = cur.revisions.find((r) => r.id === revisionId);
        if (!rev) throw refusal('SIGNINGS_NOT_FOUND', `signing_revisions ${revisionId} is not a revision of ${id}`);
        const parties = rev.requiredParties.map((p) =>
          p.partyType === partyType ? { ...clone(p), ...change } : clone(p),
        );
        if (!rev.requiredParties.some((p) => p.partyType === partyType))
          throw refusal('SIGNINGS_NOT_FOUND', `${partyType} is not a party of ${revisionId}`);
        return patchRevision(id, revisionId, { requiredParties: parties });
      });
    },
    addKey(id, act, entry) {
      return operation(() => {
        const cur = must('signingPackages', id);
        const keys = clone(cur.keys);
        if (act === 'start') keys.start = entry;
        else keys[act] = [...(keys[act] ?? []), entry];
        const next = typedOr(typeSigningPackage({ ...clone(cur), keys }, 'signingPackages'));
        st.keysOf.run(id);
        for (const k of keyRows(id, next.keys)) st.key.run(k);
        return refreshPackage(id);
      });
    },
    addHistory(id, entry) {
      return operation(() => {
        const cur = must('signingPackages', id);
        const next = typedOr(
          typeSigningPackage({ ...clone(cur), history: [...clone(cur.history), entry] }, 'signingPackages'),
        );
        const h = next.history[next.history.length - 1];
        st.hist.run(histRow(id, h, next.history.length - 1));
        return refreshPackage(id);
      });
    },
    /** Subject removal (the deletion unit): the record kept, the player's names nulled, subject_removed_at set. */
    redactPlayer(playerId, at) {
      return operation(() => {
        const touched = [];
        for (const p of sqlite
          .prepare('SELECT id FROM signing_packages WHERE player_id = ? ORDER BY rowid')
          .all(playerId)) {
          sqlite
            .prepare(
              "UPDATE signing_revision_parties SET completed_by_name = NULL WHERE completed_by_kind = 'player' AND revision_id IN (SELECT id FROM signing_revisions WHERE package_id = ?)",
            )
            .run(p.id);
          sqlite
            .prepare("UPDATE signing_history SET by_name = NULL WHERE by_kind = 'player' AND package_id = ?")
            .run(p.id);
          sqlite.prepare('UPDATE signing_packages SET subject_removed_at = ? WHERE id = ?').run(at, p.id);
          touched.push(refreshPackage(p.id));
        }
        return touched;
      });
    },
    byId: (id) => read('signingPackages', id),
    forCase: list('signingPackages', 'SELECT * FROM signing_packages WHERE case_id = ? ORDER BY rowid'),
    /** The packages of several cases (a player's journeys), in insertion order. */
    forCases(caseIds) {
      const want = [...new Set((caseIds ?? []).filter((c) => typeof c === 'string'))];
      if (!want.length) return [];
      return decodeAll(
        'signingPackages',
        sqlite
          .prepare(`SELECT * FROM signing_packages WHERE case_id IN (${want.map(() => '?').join(',')}) ORDER BY rowid`)
          .all(...want),
      );
    },
    forOffer: list('signingPackages', 'SELECT * FROM signing_packages WHERE offer_id = ? ORDER BY rowid'),
    forPlayer: list('signingPackages', 'SELECT * FROM signing_packages WHERE player_id = ? ORDER BY rowid'),
    forOrg: list('signingPackages', 'SELECT * FROM signing_packages WHERE org_id = ? ORDER BY rowid'),
    forOrgPlayer: list(
      'signingPackages',
      'SELECT * FROM signing_packages WHERE org_id = ? AND player_id = ? ORDER BY rowid',
    ),
  };
  const signings = {
    record(raw) {
      return operation(() => {
        const s = typedOr(typeSigning(raw, 'signings'));
        if (exists('signings', s.id)) throw refusal('SIGNINGS_DUPLICATE', `signings ${s.id} already exists`);
        writeSigning(st, s);
        return refreshSigning(s.id);
      });
    },
    byId: (id) => read('signings', id),
    forOrg: list('signings', 'SELECT * FROM signings WHERE org_id = ? ORDER BY rowid'),
    forPlayer: list('signings', 'SELECT * FROM signings WHERE player_id = ? ORDER BY rowid'),
    forOrgPlayer: list('signings', 'SELECT * FROM signings WHERE org_id = ? AND player_id = ? ORDER BY rowid'),
    /** The row a package's completion wrote (one per package), or null. */
    forPackage: one('signings', 'SELECT * FROM signings WHERE signing_package_id = ?'),
    /** The row recorded for an offer (one per offer), or null. */
    forOffer: one('signings', 'SELECT * FROM signings WHERE offer_id = ?'),
    countForOrg: count('SELECT COUNT(*) AS n FROM signings WHERE org_id = ?'),
    count: count('SELECT COUNT(*) AS n FROM signings'),
    /** Signings with fewer follow-ups than `milestones` (the sweep's backfill), in insertion order. */
    missingFollowUps: list(
      'signings',
      'SELECT s.* FROM signings s WHERE (SELECT COUNT(*) FROM follow_ups f WHERE f.signing_id = s.id) < ? ORDER BY s.rowid',
    ),
    /** The organisation's signings, newest first, by cursor: `{ items, nextCursor }` (`after` from readPage(query, ['number'])). */
    pageForOrg(orgId, { limit, after = null }) {
      const rows = after ? signingPage.after.all(orgId, after[0], limit + 1) : signingPage.first.all(orgId, limit + 1);
      const page = pageOf(rows, limit, (r) => [r.page_key]);
      return { items: decodeAll('signings', page.items), nextCursor: page.nextCursor };
    },
  };
  const followUps = {
    schedule(raw) {
      return operation(() => {
        const f = typedOr(typeFollowUp(raw, 'followUps'));
        if (exists('followUps', f.id)) throw refusal('SIGNINGS_DUPLICATE', `follow_ups ${f.id} already exists`);
        st.fup.run(fupRow(f));
        return refreshFollowUp(f.id);
      });
    },
    patch(id, change) {
      for (const k of Object.keys(change))
        if (!['status', 'notifiedAt', 'dueAt'].includes(k)) throw new TypeError(`followUps.patch: ${k} is not patched`);
      return operation(() => {
        const cur = must('followUps', id);
        const f = typedOr(typeFollowUp({ ...clone(cur), ...change }, 'followUps'));
        st.fup.run(fupRow(f));
        return refreshFollowUp(id);
      });
    },
    byId: (id) => read('followUps', id),
    forSigning: list('followUps', 'SELECT * FROM follow_ups WHERE signing_id = ? ORDER BY rowid'),
    forPlayer: list('followUps', 'SELECT * FROM follow_ups WHERE player_id = ? ORDER BY rowid'),
    forPlayers(playerIds) {
      const want = [...new Set((playerIds ?? []).filter((p) => typeof p === 'string'))];
      if (!want.length) return [];
      return sqlite
        .prepare(`SELECT * FROM follow_ups WHERE player_id IN (${want.map(() => '?').join(',')}) ORDER BY rowid`)
        .all(...want)
        .map(decode.followUps);
    },
    /** Scheduled follow-ups whose due instant has passed (the sweep marks them due). */
    dueToMark: list(
      'followUps',
      "SELECT * FROM follow_ups WHERE status = 'scheduled' AND due_at <= ? ORDER BY due_at, id",
    ),
    /** Due follow-ups nobody has been told about yet (the sweep notifies once). */
    dueUnnotified: list(
      'followUps',
      "SELECT * FROM follow_ups WHERE status = 'due' AND notified_at IS NULL ORDER BY due_at, id",
    ),
    /** The organisation's follow-ups by due date, then id, by cursor: `{ items, nextCursor }` (`after` from readPage(query, ['number', 'string'])). */
    pageForOrg(orgId, { limit, after = null }) {
      const rows = after
        ? followUpPage.after.all(orgId, after[0], after[0], after[1], limit + 1)
        : followUpPage.first.all(orgId, limit + 1);
      const page = pageOf(rows, limit, (r) => [r.due_at, r.id]);
      return { items: page.items.map(decode.followUps), nextCursor: page.nextCursor };
    },
  };
  const outcomeReports = {
    file(raw) {
      return operation(() => {
        const r = typedOr(typeOutcomeReport(raw, 'outcomeReports'));
        if (exists('outcomeReports', r.id))
          throw refusal('SIGNINGS_DUPLICATE', `outcome_reports ${r.id} already exists`);
        if (sqlite.prepare('SELECT 1 FROM outcome_reports WHERE follow_up_id = ?').get(r.followUpId))
          throw refusal('SIGNINGS_UNIQUENESS', `follow_ups ${r.followUpId} already has a report`);
        writeOutcome(st, r);
        return refreshOutcome(r.id);
      });
    },
    addConfirmation(id, rawConfirmation, { status } = {}) {
      return operation(() => {
        const cur = must('outcomeReports', id);
        const r = typedOr(
          typeOutcomeReport(
            {
              ...clone(cur),
              confirmations: [...clone(cur.confirmations), rawConfirmation],
              ...(status ? { status } : {}),
            },
            'outcomeReports',
          ),
        );
        const c = r.confirmations[r.confirmations.length - 1];
        st.out.run(outRow(r));
        st.conf.run(confRow(r.id, c, r.confirmations.length - 1));
        return refreshOutcome(id);
      });
    },
    byId: (id) => read('outcomeReports', id),
    /** The report on a follow-up (one per follow-up), or null. */
    forFollowUp: one('outcomeReports', 'SELECT * FROM outcome_reports WHERE follow_up_id = ?'),
    forPlayer: list('outcomeReports', 'SELECT * FROM outcome_reports WHERE player_id = ? ORDER BY rowid'),
  };

  /**
   * The admin outcome figures per organisation with a signing: signings, follow-ups past `scheduled`, and the reports
   * by status and registration — counted in SQL, one row per organisation.
   */
  const totalsStmt = sqlite.prepare(`SELECT s.org_id AS orgId, COUNT(*) AS signings,
      (SELECT COUNT(*) FROM follow_ups f WHERE f.org_id = s.org_id AND f.status <> 'scheduled') AS followUpsDue,
      (SELECT COUNT(*) FROM outcome_reports r WHERE r.org_id = s.org_id) AS reported,
      (SELECT COUNT(*) FROM outcome_reports r WHERE r.org_id = s.org_id AND r.status = 'confirmed') AS confirmed,
      (SELECT COUNT(*) FROM outcome_reports r WHERE r.org_id = s.org_id AND r.status = 'disputed') AS disputed,
      (SELECT COUNT(*) FROM outcome_reports r WHERE r.org_id = s.org_id AND r.registration_status = 'registered') AS retained
    FROM signings s GROUP BY s.org_id`);
  const outcomeTotalsByOrg = () => new Map(totalsStmt.all().map((r) => [r.orgId, { ...r }]));
  const readOnly = (o) => Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => !WRITES.has(k))));
  const counters = Object.fromEntries(
    SIGNINGS_FOLLOWUPS_TABLES_OF.map(([n, t]) => [n, sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`)]),
  );

  return {
    signingPackages,
    signings,
    followUps,
    outcomeReports,
    outcomeTotalsByOrg,
    /** The queries alone, for the pure projectors and providers that must not write. */
    reads: Object.freeze({
      signingPackages: readOnly(signingPackages),
      signings: readOnly(signings),
      followUps: readOnly(followUps),
      outcomeReports: readOnly(outcomeReports),
    }),
    /** Check migration 0018 is recorded; there is nothing to load. */
    attach() {
      if (!signingsFollowUpsLive(sqlite))
        throw new Error(
          `the signings/follow-ups repository needs ${SIGNINGS_FOLLOWUPS_MIGRATION} recorded; it never imports an in-memory array`,
        );
      return { counts: this.counts() };
    },
    counts() {
      return Object.fromEntries(SIGNINGS_FOLLOWUPS_TABLES_OF.map(([n]) => [n, counters[n].get().n]));
    },
    pending: () => 0,
    exportAll() {
      return SIGNINGS_FOLLOWUPS_RECORDS.read(sqlite);
    },
    log,
    now,
  };
}
