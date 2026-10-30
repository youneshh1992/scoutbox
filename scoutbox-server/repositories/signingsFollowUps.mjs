/**
 * S8d — signing packages, completed signings, post-signing follow-ups and outcome reports as tables (migration
 * `0018_signings_follow_ups`; docs/architecture/s8d-design-note.md; the rules of 30 October 2026 in CLAUDE.md).
 *
 * The first domain built under the fidelity rule: EVERY field is a typed column with the vocabulary and length CHECKs
 * of the drafted schema (docs/architecture/sql/02_recruitment.sql), there is no `absent_keys_json`, `offtype_json` or
 * `extra_json`, and a record the columns cannot hold is REFUSED with its id — at a route (400, the field named), at
 * the cutover (the boot stops) and at a snapshot write (the save rolls back). The cutover normalises exactly what the
 * design note lists (a legacy signing without `method` → LEGACY_RECORDED, a missing `rev` → 1, the three dead signing
 * fields dropped, an unknown field dropped) and REPORTS each normalisation with the row id in the boot log and in
 * `meta.signingsFollowUpsCutover.notes`; nothing else is coerced.
 *
 * The first domain with EXPLICIT WRITES: the four `db.<collection>` arrays are read-only views over the repository's
 * mirrors of plain, deep-frozen records; every change is a repository operation that writes its rows at once — joined
 * into the open unit of work through the store's participant API, in a transaction of its own outside one — and then
 * re-reads the record from the tables into the mirror, so the mirror never holds a value the database does not. An
 * in-place edit of a record through a view or a returned record throws (read-only proxies); there is no fingerprinting and no save-time flush.
 * The mirrors are restored by the store's unit of work through `snapshotState` / `restoreState`.
 *
 * Tables (file 02): signing_packages, signing_revisions, signing_documents, signing_revision_parties, signing_history;
 * signings, signing_parties; follow_ups, outcome_reports, outcome_report_confirmations — ten definitions; the design
 * note counted nine before `signing_parties` was separated from `signings`. The package `keys` are rows of the ONE
 * shared `idempotency_keys` table, owner `signing_packages` (the CHECK broadened by 0018). `completion_signing_id`
 * (package → signing) and `signing_package_id` (signing → package) form a cycle, so the package side is DEFERRABLE
 * INITIALLY DEFERRED with NO ACTION (a RESTRICT would fire at once even on a deferred key): checked at COMMIT, which
 * lets the completion unit write the signing row and then the package, and a snapshot remove the pair in one save.
 *
 * References: `org_id` → orgs, `case_id` → recruitment_cases, `offer_id` → recruitment_offers, the staff ids →
 * org_users (RESTRICT, as drafted). `offer_revision_id` stays a plain indexed column (offer_revisions.id is indexed,
 * not unique — S8c as accepted; this step alters no accepted table). Player ids: NO key, tolerant and counted —
 * Q7a/Q8a/Q8c-a applied a fourth time, not re-asked. Guardian and party ids: polymorphic, no key.
 */
import { S8C_KEY_OWNERS } from './recruitmentContactsOffers.mjs';
import { idempotencyKeysDdl, isPlainObject, ids, tableExists } from './recruitment.mjs';
import { readonlyView, markView } from './readonly.mjs';
import { transaction, migrationApplied } from './database.mjs';

export const SIGNINGS_FOLLOWUPS_MIGRATION = '0018_signings_follow_ups';
export const SIGNINGS_FOLLOWUPS_CUTOVER_META = 'signingsFollowUpsCutover';
export const SIGNINGS_FOLLOWUPS_COLLECTIONS = Object.freeze(['signingPackages', 'signings', 'followUps', 'outcomeReports']);
export const SIGNINGS_FOLLOWUPS_TABLES = Object.freeze(['signing_packages', 'signing_revisions', 'signing_documents', 'signing_revision_parties', 'signing_history', 'signings', 'signing_parties', 'follow_ups', 'outcome_reports', 'outcome_report_confirmations']);
/** The owner tables the shared idempotency_keys CHECK names once 0018 is recorded. */
export const S8D_KEY_OWNERS = Object.freeze([...S8C_KEY_OWNERS, 'signing_packages']);

export const SIGNING_STORED_STATUSES = Object.freeze(['DRAFT', 'READY', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'VOIDED']);
export const SIGNING_REVISION_STATUSES = Object.freeze([...SIGNING_STORED_STATUSES, 'SUPERSEDED']);
const PARTY_TYPES = ['PLAYER', 'GUARDIAN', 'CLUB_SIGNATORY'];
const ACTOR_KINDS = ['org', 'player', 'guardian', 'admin', 'system'];
const PACKAGE_KEY_ACTS = Object.freeze(['start', 'ready', 'party', 'cancel', 'void', 'supersede', 'complete']);
export const FOLLOW_UP_MILESTONES = Object.freeze(['3m', '6m', '12m']);
export const FOLLOW_UP_STATUSES = Object.freeze(['scheduled', 'due', 'complete']);
export const REGISTRATION_STATUSES = Object.freeze(['registered', 'released', 'left', 'unknown']);
export const OUTCOME_STATUSES = Object.freeze(['reported', 'confirmed', 'disputed']);
export const LIMITS = Object.freeze({ internalNote: 2000, reason: 500, label: 120, signingNote: 400, progression: 200, endReason: 200, outcomeNote: 300 });

// ------------------------------------------------------------------ DDL (typed; the drafted definitions with the by-actor kind/role columns the writers produce)
const BY = (p, { user = true, kind = false, role = false } = {}) => [kind ? `  ${(p + '_kind').padEnd(32)} TEXT CHECK (${p}_kind IS NULL OR ${p}_kind IN ('org','player','guardian','admin','system'))` : null, `  ${(p + (user ? '_user_id' : '_id')).padEnd(32)} TEXT${user ? ' REFERENCES org_users(id) ON DELETE RESTRICT' : ''}`, `  ${(p + '_name').padEnd(32)} TEXT`, role ? `  ${(p + '_role').padEnd(32)} TEXT` : null].filter(Boolean).join(',\n');
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
const describe = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `${typeof v}`);
/** An actor tuple as the writers produce it ({kind, id|userId, name, role?}) → the typed quartet. `null` stays null. */
function actorIn(v, at, field, { kinds = ACTOR_KINDS, required = false } = {}) {
  if (v === null || v === undefined) return required ? bad(at, field, 'is required') : { ok: true, value: null };
  if (!isPlainObject(v)) return bad(at, field, `must be an actor object (got ${describe(v)})`);
  const id = v.id ?? v.userId ?? null;
  if (!kinds.includes(v.kind)) return bad(at, `${field}.kind`, `must be one of ${kinds.join('|')} (got ${describe(v.kind)})`);
  if (!optStr(id) || !optStr(v.name) || !optStr(v.role)) return bad(at, field, 'must carry string or null id, name and role');
  return { ok: true, value: { kind: v.kind, id: orNull(id), name: orNull(v.name), role: orNull(v.role) } };
}
const actorOut = (p, row, { user = true, role = true, kind = true } = {}) => {
  const id = row[user ? `${p}_user_id` : `${p}_id`]; const k = kind ? row[`${p}_kind`] : 'org';
  if (k === null && id === null && row[`${p}_name`] === null) return null;
  const out = { kind: k ?? 'org', id, name: row[`${p}_name`] };
  if (role) out.role = row[`${p}_role`];
  return out;
};
const actorCols = (p, a, { user = true, role = true, kind = true } = {}) => ({ ...(kind ? { [`${p}_kind`]: a?.kind ?? null } : {}), [user ? `${p}_user_id` : `${p}_id`]: a?.id ?? null, [`${p}_name`]: a?.name ?? null, ...(role ? { [`${p}_role`]: a?.role ?? null } : {}) });

// ------------------------------------------------------------------ validation + normalisation (one function per record, used by the routes' writers, the cutover and the snapshot write)

/** The signing package the writers produce, typed. Returns `{ ok, record, notes }` or `{ ok: false, reason }`; `notes` are the normalisations applied (ids only). */
export function typeSigningPackage(raw, at = 'signingPackages') {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  if (!nonEmpty(raw.id)) return bad(at, 'id', 'must be a non-empty string');
  const label = `${at} ${raw.id}`; const notes = [];
  for (const k of ['orgId', 'caseId', 'playerId', 'offerId', 'offerRevisionId', 'currentRevisionId']) if (!nonEmpty(raw[k])) return bad(label, k, 'must be a non-empty string');
  if (!SIGNING_STORED_STATUSES.includes(raw.status)) return bad(label, 'status', `must be one of ${SIGNING_STORED_STATUSES.join('|')} (got ${describe(raw.status)})`);
  for (const k of ['expiresAt', 'cancelledAt', 'voidedAt', 'updatedAt', 'revAt', 'subjectRemovedAt']) if (!optInt(raw[k])) return bad(label, k, `must be an integer instant or null (got ${describe(raw[k])})`);
  if (!isInt(raw.createdAt)) return bad(label, 'createdAt', 'must be an integer instant');
  for (const [k, max] of [['internalNote', LIMITS.internalNote], ['cancelReason', LIMITS.reason], ['voidReason', LIMITS.reason]]) { if (!optStr(raw[k])) return bad(label, k, 'must be text or null'); if (isStr(raw[k]) && raw[k].length > max) return bad(label, k, `exceeds ${max} characters`); }
  if (!optStr(raw.transactionId)) return bad(label, 'transactionId', 'must be a string or null');
  const createdBy = actorIn(raw.createdBy, label, 'createdBy', { required: true }); if (!createdBy.ok) return createdBy;
  if (!nonEmpty(createdBy.value.id)) return bad(label, 'createdBy.id', 'must name the staff member');
  const cancelledBy = actorIn(raw.cancelledBy, label, 'cancelledBy'); if (!cancelledBy.ok) return cancelledBy;
  const voidedBy = actorIn(raw.voidedBy, label, 'voidedBy', { kinds: ['org', 'admin'] }); if (!voidedBy.ok) return voidedBy;
  if ((raw.voidedAt == null) !== (voidedBy.value === null)) return bad(label, 'voidedAt', 'and voidedBy must be set together');
  let rev = raw.rev; if (rev === undefined || rev === null) { rev = 1; notes.push(`${label}: rev missing, written as 1`); } else if (!isInt(rev) || rev < 1) return bad(label, 'rev', 'must be a positive integer');
  let revBy = null; if (raw.revBy !== undefined && raw.revBy !== null) { if (!isPlainObject(raw.revBy) || !optStr(raw.revBy.userId) || !optStr(raw.revBy.name)) return bad(label, 'revBy', 'must be {userId, name} or null'); revBy = { userId: orNull(raw.revBy.userId), name: orNull(raw.revBy.name) }; }
  let policyVersion = raw.policyVersion; if (policyVersion === undefined || policyVersion === null) { policyVersion = 1; notes.push(`${label}: policyVersion missing, written as 1`); } else if (!isInt(policyVersion)) return bad(label, 'policyVersion', 'must be an integer');
  // completion
  let completion = null;
  if (raw.completion !== undefined && raw.completion !== null) {
    const c = raw.completion; if (!isPlainObject(c)) return bad(label, 'completion', `must be an object or null (got ${describe(c)})`);
    if (!nonEmpty(c.signingId) || !isInt(c.completedAt)) return bad(label, 'completion', 'must carry signingId and completedAt');
    const by = actorIn(c.completedBy, label, 'completion.completedBy'); if (!by.ok) return by;
    const contract = contractIn(c.contract, label, 'completion.contract'); if (!contract.ok) return contract;
    if (c.documentSha256 !== undefined && c.documentSha256 !== null && !sha(c.documentSha256)) return bad(label, 'completion.documentSha256', 'must be a SHA-256 hex digest or null');
    let lifecycle = null; if (c.lifecycle !== undefined && c.lifecycle !== null) { const l = c.lifecycle; if (!isPlainObject(l) || !optStr(l.from) || !optStr(l.to) || !optInt(l.at)) return bad(label, 'completion.lifecycle', 'must be {from, to, at} or null'); lifecycle = { from: orNull(l.from), to: orNull(l.to), at: orNull(l.at) }; }
    completion = { signingId: c.signingId, completedAt: c.completedAt, completedBy: by.value, contract: contract.value, documentSha256: orNull(c.documentSha256), lifecycle };
  }
  if ((raw.status === 'COMPLETED') !== (completion !== null)) return bad(label, 'completion', raw.status === 'COMPLETED' ? 'is required on a COMPLETED package' : 'is present on a package that is not COMPLETED');
  // revisions
  if (!Array.isArray(raw.revisions) || raw.revisions.length === 0) return bad(label, 'revisions', 'must be a non-empty array');
  const revisions = []; const revIds = new Set(); const nums = new Set();
  for (let i = 0; i < raw.revisions.length; i++) { const r = typeRevision(raw.revisions[i], `${label}.revisions[${i}]`, raw); if (!r.ok) return r; if (revIds.has(r.record.id)) return bad(label, `revisions[${i}].id`, `duplicates ${r.record.id}`); if (nums.has(r.record.revisionNumber)) return bad(label, `revisions[${i}].revisionNumber`, `duplicates ${r.record.revisionNumber}`); revIds.add(r.record.id); nums.add(r.record.revisionNumber); revisions.push(r.record); notes.push(...r.notes); }
  if (!revIds.has(raw.currentRevisionId)) return bad(label, 'currentRevisionId', `names no revision of the package (${raw.currentRevisionId})`);
  // keys
  const keys = { start: null, ready: [], party: [], cancel: [], void: [], supersede: [], complete: [] };
  if (raw.keys !== undefined && raw.keys !== null) {
    if (!isPlainObject(raw.keys)) return bad(label, 'keys', `must be an object (got ${describe(raw.keys)})`);
    for (const k of Object.keys(raw.keys)) if (!PACKAGE_KEY_ACTS.includes(k)) return bad(label, `keys.${k}`, 'is not a key act this build writes');
    if (raw.keys.start !== undefined && raw.keys.start !== null) { const s = raw.keys.start; if (!isPlainObject(s) || !nonEmpty(s.key) || !isStr(s.fp)) return bad(label, 'keys.start', 'must be {key, fp} or null'); keys.start = { key: s.key, fp: s.fp }; }
    for (const act of PACKAGE_KEY_ACTS.slice(1)) {
      const list = raw.keys[act]; if (list === undefined || list === null) continue;
      if (!Array.isArray(list)) return bad(label, `keys.${act}`, `must be an array (got ${describe(list)})`);
      for (let i = 0; i < list.length; i++) { const e = list[i]; if (!isPlainObject(e) || !nonEmpty(e.key) || !isStr(e.fp) || !optInt(e.at) || !optStr(e.revisionId) || !optStr(e.actorId) || !optStr(e.signingId)) return bad(label, `keys.${act}[${i}]`, 'must be {key, fp, at?, revisionId?, actorId?, signingId?}'); const entry = { key: e.key, fp: e.fp }; for (const f of ['revisionId', 'actorId', 'signingId', 'at']) if (e[f] !== undefined) entry[f] = e[f]; keys[act].push(entry); }
    }
  }
  // history
  const history = [];
  if (raw.history !== undefined && raw.history !== null) {
    if (!Array.isArray(raw.history)) return bad(label, 'history', `must be an array (got ${describe(raw.history)})`);
    for (let i = 0; i < raw.history.length; i++) { const h = typeHistory(raw.history[i], `${label}.history[${i}]`); if (!h.ok) return h; history.push(h.record); }
  }
  const known = new Set(['id', 'orgId', 'caseId', 'playerId', 'offerId', 'offerRevisionId', 'transactionId', 'status', 'currentRevisionId', 'revisions', 'expiresAt', 'internalNote', 'keys', 'history', 'completion', 'cancelledAt', 'cancelledBy', 'cancelReason', 'voidedAt', 'voidedBy', 'voidReason', 'createdAt', 'createdBy', 'updatedAt', 'rev', 'revAt', 'revBy', 'policyVersion', 'subjectRemovedAt']);
  for (const k of Object.keys(raw)) if (!known.has(k)) notes.push(`${label}: unknown field ${k} dropped`);
  const record = {
    id: raw.id, orgId: raw.orgId, caseId: raw.caseId, playerId: raw.playerId, offerId: raw.offerId, offerRevisionId: raw.offerRevisionId, transactionId: orNull(raw.transactionId),
    status: raw.status, currentRevisionId: raw.currentRevisionId, revisions, expiresAt: orNull(raw.expiresAt), internalNote: orNull(raw.internalNote), keys, history, completion,
    cancelledAt: orNull(raw.cancelledAt), cancelledBy: cancelledBy.value, cancelReason: orNull(raw.cancelReason), voidedAt: orNull(raw.voidedAt), voidedBy: voidedBy.value, voidReason: orNull(raw.voidReason),
    createdAt: raw.createdAt, createdBy: createdBy.value, updatedAt: raw.updatedAt ?? raw.createdAt, rev, revAt: orNull(raw.revAt), revBy, policyVersion, subjectRemovedAt: orNull(raw.subjectRemovedAt),
  };
  return { ok: true, record, notes };
}
function contractIn(v, label, field) {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (!isPlainObject(v)) return bad(label, field, `must be {startDate, endDate} or null (got ${describe(v)})`);
  if (v.startDate !== undefined && v.startDate !== null && !dateOnly(v.startDate)) return bad(label, `${field}.startDate`, 'must be a YYYY-MM-DD day or null');
  if (v.endDate !== undefined && v.endDate !== null && !dateOnly(v.endDate)) return bad(label, `${field}.endDate`, 'must be a YYYY-MM-DD day or null');
  return { ok: true, value: { startDate: orNull(v.startDate), endDate: orNull(v.endDate) } };
}
function typeDocument(v, label, field) {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (!isPlainObject(v)) return bad(label, field, `must be a document object or null (got ${describe(v)})`);
  if (!nonEmpty(v.id) || !nonEmpty(v.evidenceId) || !sha(v.sha256) || !isInt(v.uploadedAt)) return bad(label, field, 'must carry id, evidenceId, a SHA-256 digest and uploadedAt');
  if (!optStr(v.filename) || !optStr(v.mime) || !optInt(v.bytes) || !optStr(v.label)) return bad(label, field, 'filename, mime, bytes and label must be typed or null');
  if (isStr(v.label) && v.label.length > LIMITS.label) return bad(label, `${field}.label`, `exceeds ${LIMITS.label} characters`);
  const by = actorIn(v.uploadedBy, label, `${field}.uploadedBy`); if (!by.ok) return by;
  return { ok: true, value: { id: v.id, evidenceId: v.evidenceId, sha256: v.sha256.toLowerCase(), filename: orNull(v.filename), mime: orNull(v.mime), bytes: orNull(v.bytes), label: orNull(v.label), uploadedAt: v.uploadedAt, uploadedBy: by.value } };
}
function typeRevision(r, label, pkg) {
  if (!isPlainObject(r)) return { ok: false, reason: `${label} is not an object (${describe(r)})` };
  if (!nonEmpty(r.id)) return bad(label, 'id', 'must be a non-empty string');
  const notes = [];
  if (!isInt(r.revisionNumber) || r.revisionNumber < 1) return bad(label, 'revisionNumber', 'must be a positive integer');
  if (!SIGNING_REVISION_STATUSES.includes(r.status)) return bad(label, 'status', `must be one of ${SIGNING_REVISION_STATUSES.join('|')} (got ${describe(r.status)})`);
  if (!isInt(r.createdAt)) return bad(label, 'createdAt', 'must be an integer instant');
  for (const k of ['readyAt', 'completedAt', 'supersededAt']) if (!optInt(r[k])) return bad(label, k, 'must be an integer instant or null');
  const createdBy = actorIn(r.createdBy, label, 'createdBy'); if (!createdBy.ok) return createdBy;
  const readyBy = actorIn(r.readyBy, label, 'readyBy'); if (!readyBy.ok) return readyBy;
  const completedBy = actorIn(r.completedBy, label, 'completedBy'); if (!completedBy.ok) return completedBy;
  const document = typeDocument(r.document, label, 'document'); if (!document.ok) return document;
  const executed = typeDocument(r.executedDocument, label, 'executedDocument'); if (!executed.ok) return executed;
  const contract = contractIn(r.contract, label, 'contract'); if (!contract.ok) return contract;
  let policySnapshot = null;
  if (r.policySnapshot !== undefined && r.policySnapshot !== null) { const p = r.policySnapshot; if (!isPlainObject(p) || !optInt(p.policyVersion) || !optStr(p.jurisdiction) || !optInt(p.offerPolicyVersion)) return bad(label, 'policySnapshot', 'must be {policyVersion, jurisdiction, offerPolicyVersion} or null'); policySnapshot = { policyVersion: orNull(p.policyVersion), jurisdiction: orNull(p.jurisdiction), offerPolicyVersion: orNull(p.offerPolicyVersion) }; }
  if (!optStr(r.supersedesRevisionId) || !optStr(r.supersededByRevisionId)) return bad(label, 'supersedesRevisionId', 'and supersededByRevisionId must be strings or null');
  if (!Array.isArray(r.requiredParties)) return bad(label, 'requiredParties', `must be an array (got ${describe(r.requiredParties)})`);
  const parties = []; const types = new Set();
  for (let i = 0; i < r.requiredParties.length; i++) {
    const p = r.requiredParties[i]; const pl = `${label}.requiredParties[${i}]`;
    if (!isPlainObject(p)) return { ok: false, reason: `${pl} is not an object` };
    if (!PARTY_TYPES.includes(p.partyType)) return bad(pl, 'partyType', `must be one of ${PARTY_TYPES.join('|')}`);
    if (types.has(p.partyType)) return bad(pl, 'partyType', `duplicates ${p.partyType}`); types.add(p.partyType);
    if (!['PENDING', 'COMPLETED'].includes(p.status)) return bad(pl, 'status', 'must be PENDING or COMPLETED');
    if (!optStr(p.forEntityId) || !optStr(p.forPlayerId) || !optInt(p.completedAt)) return bad(pl, 'forEntityId', ', forPlayerId and completedAt must be typed or null');
    if ((p.status === 'COMPLETED') !== (p.completedAt != null)) return bad(pl, 'completedAt', 'must be set exactly on a COMPLETED party');
    const by = actorIn(p.completedBy, pl, 'completedBy', { kinds: ['player', 'guardian', 'org'] }); if (!by.ok) return by;
    if (p.method !== undefined && p.method !== null && !['PLATFORM_ACKNOWLEDGMENT', 'UPLOAD_EXECUTED_DOCUMENT'].includes(p.method)) return bad(pl, 'method', 'is not a method this build writes');
    let evidenceRef = null;
    if (p.evidenceRef !== undefined && p.evidenceRef !== null) { const e = p.evidenceRef; if (!isPlainObject(e) || e.kind !== 'platform_acknowledgment' || !nonEmpty(e.id) || !optStr(e.revisionId) || (e.documentSha256 != null && !sha(e.documentSha256)) || !optInt(e.at) || !optStr(e.actorKind) || !optStr(e.actorId) || !optStr(e.session)) return bad(pl, 'evidenceRef', 'must be the platform_acknowledgment evidence shape or null'); evidenceRef = { kind: e.kind, id: e.id, revisionId: orNull(e.revisionId), documentSha256: e.documentSha256 == null ? null : e.documentSha256.toLowerCase(), at: orNull(e.at), actorKind: orNull(e.actorKind), actorId: orNull(e.actorId), session: orNull(e.session) }; }
    parties.push({ partyType: p.partyType, forEntityId: orNull(p.forEntityId), forPlayerId: orNull(p.forPlayerId), status: p.status, completedAt: orNull(p.completedAt), completedBy: by.value ? { kind: by.value.kind, id: by.value.id, name: by.value.name } : null, evidenceRef, method: orNull(p.method) });
  }
  const record = { id: r.id, revisionNumber: r.revisionNumber, status: r.status, createdAt: r.createdAt, createdBy: createdBy.value, readyAt: orNull(r.readyAt), readyBy: readyBy.value, completedAt: orNull(r.completedAt), completedBy: completedBy.value, document: document.value, executedDocument: executed.value, contract: contract.value, requiredParties: parties, policySnapshot, supersedesRevisionId: orNull(r.supersedesRevisionId), supersededByRevisionId: orNull(r.supersededByRevisionId), supersededAt: orNull(r.supersededAt) };
  void pkg;
  return { ok: true, record, notes };
}
function typeHistory(h, label) {
  if (!isPlainObject(h)) return { ok: false, reason: `${label} is not an object` };
  if (!nonEmpty(h.id) || !isInt(h.at) || !nonEmpty(h.action)) return bad(label, 'id', ', at and action are required');
  const by = actorIn(h.by, label, 'by'); if (!by.ok) return by;
  if (h.detail !== undefined && h.detail !== null && !isPlainObject(h.detail)) return bad(label, 'detail', 'must be an object or null');
  return { ok: true, record: { id: h.id, at: h.at, action: h.action, by: by.value ? { kind: by.value.kind, id: by.value.id, name: by.value.name } : null, detail: h.detail === undefined ? null : clone(h.detail) } };
}

/** The completed signing record (canonical or legacy), typed. */
export function typeSigning(raw, at = 'signings') {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  if (!nonEmpty(raw.id)) return bad(at, 'id', 'must be a non-empty string');
  const label = `${at} ${raw.id}`; const notes = [];
  for (const k of ['playerId', 'orgId']) if (!nonEmpty(raw[k])) return bad(label, k, 'must be a non-empty string');
  if (!isInt(raw.ts)) return bad(label, 'ts', 'must be an integer instant');
  for (const k of ['signedAt', 'attributionWindowMonths', 'signingRevisionNumber', 'policyVersion']) if (!optInt(raw[k])) return bad(label, k, 'must be an integer or null');
  for (const k of ['playerName', 'orgName', 'userId', 'scoutName', 'signingPackageId', 'signingRevisionId', 'caseId', 'offerId', 'offerRevisionId', 'transactionId', 'documentEvidenceId', 'executedDocumentEvidenceId', 'note']) if (!optStr(raw[k])) return bad(label, k, `must be a string or null (got ${describe(raw[k])})`);
  if (isStr(raw.note) && raw.note.length > LIMITS.signingNote) return bad(label, 'note', `exceeds ${LIMITS.signingNote} characters`);
  if (!optBool(raw.insideAttributionWindow)) return bad(label, 'insideAttributionWindow', 'must be a boolean or null');
  if (raw.documentSha256 !== undefined && raw.documentSha256 !== null && !sha(raw.documentSha256)) return bad(label, 'documentSha256', 'must be a SHA-256 hex digest or null');
  let method = raw.method; if (method === undefined || method === null) { method = raw.signingPackageId ? 'CANONICAL_COMPLETION' : 'LEGACY_RECORDED'; notes.push(`${label}: method missing, written as ${method}`); } else if (!['CANONICAL_COMPLETION', 'LEGACY_RECORDED'].includes(method)) return bad(label, 'method', `must be CANONICAL_COMPLETION or LEGACY_RECORDED (got ${describe(method)})`);
  if ((method === 'CANONICAL_COMPLETION') !== !!raw.signingPackageId) return bad(label, 'method', 'CANONICAL_COMPLETION requires signingPackageId and LEGACY_RECORDED forbids it');
  let first = null;
  if (raw.firstQualifyingInteraction !== undefined && raw.firstQualifyingInteraction !== null) { const f = raw.firstQualifyingInteraction; if (!isPlainObject(f) || !optStr(f.id) || !optInt(f.ts) || !optStr(f.type)) return bad(label, 'firstQualifyingInteraction', 'must be a ledger row reference {id, ts, type} or null'); first = { id: orNull(f.id), ts: orNull(f.ts), type: orNull(f.type) }; if (Object.keys(f).some((k) => !['id', 'ts', 'type'].includes(k))) notes.push(`${label}: firstQualifyingInteraction kept as the ledger reference (id, ts, type); the copied fields dropped`); }
  const contract = contractIn(raw.contract, label, 'contract'); if (!contract.ok) return contract;
  const parties = [];
  if (raw.parties !== undefined && raw.parties !== null) {
    if (!Array.isArray(raw.parties)) return bad(label, 'parties', `must be an array (got ${describe(raw.parties)})`);
    const seen = new Set();
    for (let i = 0; i < raw.parties.length; i++) { const p = raw.parties[i]; const pl = `${label}.parties[${i}]`; if (!isPlainObject(p) || !PARTY_TYPES.includes(p.partyType)) return bad(pl, 'partyType', `must be one of ${PARTY_TYPES.join('|')}`); if (seen.has(p.partyType)) return bad(pl, 'partyType', `duplicates ${p.partyType}`); seen.add(p.partyType); if (p.method != null && !['PLATFORM_ACKNOWLEDGMENT', 'UPLOAD_EXECUTED_DOCUMENT'].includes(p.method)) return bad(pl, 'method', 'is not a method this build writes'); if (!optInt(p.completedAt) || (p.byKind != null && !['org', 'player', 'guardian'].includes(p.byKind))) return bad(pl, 'completedAt', 'and byKind must be typed or null'); parties.push({ partyType: p.partyType, method: orNull(p.method), completedAt: orNull(p.completedAt), byKind: orNull(p.byKind) }); }
  }
  for (const k of ['cancelledAt', 'revokedAt', 'voidedAt']) if (raw[k] !== undefined) notes.push(`${label}: dead field ${k} dropped (read by no writer, written by none)`);
  const known = new Set(['id', 'playerId', 'playerName', 'orgId', 'orgName', 'userId', 'scoutName', 'ts', 'signedAt', 'firstQualifyingInteraction', 'attributionWindowMonths', 'insideAttributionWindow', 'method', 'note', 'signingPackageId', 'signingRevisionId', 'signingRevisionNumber', 'caseId', 'offerId', 'offerRevisionId', 'transactionId', 'documentSha256', 'documentEvidenceId', 'executedDocumentEvidenceId', 'contract', 'parties', 'policyVersion', 'cancelledAt', 'revokedAt', 'voidedAt']);
  for (const k of Object.keys(raw)) if (!known.has(k)) notes.push(`${label}: unknown field ${k} dropped`);
  const record = {
    id: raw.id, playerId: raw.playerId, playerName: orNull(raw.playerName), orgId: raw.orgId, orgName: orNull(raw.orgName), userId: orNull(raw.userId), scoutName: orNull(raw.scoutName),
    ts: raw.ts, signedAt: orNull(raw.signedAt), firstQualifyingInteraction: first, attributionWindowMonths: orNull(raw.attributionWindowMonths), insideAttributionWindow: raw.insideAttributionWindow === true,
    method, note: orNull(raw.note), signingPackageId: orNull(raw.signingPackageId), signingRevisionId: orNull(raw.signingRevisionId), signingRevisionNumber: orNull(raw.signingRevisionNumber),
    caseId: orNull(raw.caseId), offerId: orNull(raw.offerId), offerRevisionId: orNull(raw.offerRevisionId), transactionId: orNull(raw.transactionId),
    documentSha256: raw.documentSha256 == null ? null : raw.documentSha256.toLowerCase(), documentEvidenceId: orNull(raw.documentEvidenceId), executedDocumentEvidenceId: orNull(raw.executedDocumentEvidenceId),
    contract: contract.value, parties, policyVersion: orNull(raw.policyVersion),
  };
  return { ok: true, record, notes };
}

export function typeFollowUp(raw, at = 'followUps') {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  if (!nonEmpty(raw.id)) return bad(at, 'id', 'must be a non-empty string');
  const label = `${at} ${raw.id}`; const notes = [];
  for (const k of ['signingId', 'playerId', 'orgId']) if (!nonEmpty(raw[k])) return bad(label, k, 'must be a non-empty string');
  if (!FOLLOW_UP_MILESTONES.includes(raw.milestone)) return bad(label, 'milestone', `must be one of ${FOLLOW_UP_MILESTONES.join('|')} (got ${describe(raw.milestone)})`);
  if (!isInt(raw.dueAt) || !isInt(raw.createdAt)) return bad(label, 'dueAt', 'and createdAt must be integer instants');
  if (!FOLLOW_UP_STATUSES.includes(raw.status)) return bad(label, 'status', `must be one of ${FOLLOW_UP_STATUSES.join('|')} (got ${describe(raw.status)})`);
  if (!optInt(raw.notifiedAt)) return bad(label, 'notifiedAt', 'must be an integer instant or null');
  for (const k of Object.keys(raw)) if (!['id', 'signingId', 'playerId', 'orgId', 'milestone', 'dueAt', 'status', 'notifiedAt', 'createdAt'].includes(k)) notes.push(`${label}: unknown field ${k} dropped`);
  return { ok: true, record: { id: raw.id, signingId: raw.signingId, playerId: raw.playerId, orgId: raw.orgId, milestone: raw.milestone, dueAt: raw.dueAt, status: raw.status, notifiedAt: orNull(raw.notifiedAt), createdAt: raw.createdAt }, notes };
}

export function typeOutcomeReport(raw, at = 'outcomeReports') {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  if (!nonEmpty(raw.id)) return bad(at, 'id', 'must be a non-empty string');
  const label = `${at} ${raw.id}`; const notes = [];
  for (const k of ['followUpId', 'signingId', 'playerId', 'orgId']) if (!nonEmpty(raw[k])) return bad(label, k, 'must be a non-empty string');
  if (!isPlainObject(raw.by) || raw.by.kind !== 'org' || !nonEmpty(raw.by.id) || !optStr(raw.by.name)) return bad(label, 'by', 'must be {kind: "org", id, name}');
  if (!REGISTRATION_STATUSES.includes(raw.registrationStatus)) return bad(label, 'registrationStatus', `must be one of ${REGISTRATION_STATUSES.join('|')} (got ${describe(raw.registrationStatus)})`);
  if (!optInt(raw.matchesPlayed) || (isInt(raw.matchesPlayed) && raw.matchesPlayed < 0)) return bad(label, 'matchesPlayed', 'must be a non-negative integer or null');
  for (const [k, max] of [['progression', LIMITS.progression], ['endReason', LIMITS.endReason], ['note', LIMITS.outcomeNote]]) { if (!optStr(raw[k])) return bad(label, k, 'must be text or null'); if (isStr(raw[k]) && raw[k].length > max) return bad(label, k, `exceeds ${max} characters`); }
  if (!OUTCOME_STATUSES.includes(raw.status)) return bad(label, 'status', `must be one of ${OUTCOME_STATUSES.join('|')}`);
  if (!isInt(raw.at)) return bad(label, 'at', 'must be an integer instant');
  const confirmations = []; const seen = new Set();
  if (raw.confirmations !== undefined && raw.confirmations !== null) {
    if (!Array.isArray(raw.confirmations)) return bad(label, 'confirmations', `must be an array (got ${describe(raw.confirmations)})`);
    for (let i = 0; i < raw.confirmations.length; i++) { const c = typeConfirmation(raw.confirmations[i], `${label}.confirmations[${i}]`); if (!c.ok) return c; if (seen.has(c.record.by.id)) return bad(label, `confirmations[${i}].by.id`, `duplicates ${c.record.by.id} (one answer per person)`); seen.add(c.record.by.id); confirmations.push(c.record); }
  }
  for (const k of Object.keys(raw)) if (!['id', 'followUpId', 'signingId', 'playerId', 'orgId', 'by', 'registrationStatus', 'matchesPlayed', 'progression', 'endReason', 'note', 'status', 'confirmations', 'at'].includes(k)) notes.push(`${label}: unknown field ${k} dropped`);
  return { ok: true, record: { id: raw.id, followUpId: raw.followUpId, signingId: raw.signingId, playerId: raw.playerId, orgId: raw.orgId, by: { kind: 'org', id: raw.by.id, name: orNull(raw.by.name) }, registrationStatus: raw.registrationStatus, matchesPlayed: orNull(raw.matchesPlayed), progression: orNull(raw.progression), endReason: orNull(raw.endReason), note: orNull(raw.note), status: raw.status, confirmations, at: raw.at }, notes };
}
export function typeConfirmation(c, label) {
  if (!isPlainObject(c)) return { ok: false, reason: `${label} is not an object` };
  if (!isPlainObject(c.by) || !['player', 'guardian'].includes(c.by.kind) || !nonEmpty(c.by.id) || !optStr(c.by.name)) return bad(label, 'by', 'must be {kind: player|guardian, id, name}');
  if (typeof c.agree !== 'boolean') return bad(label, 'agree', 'must be a boolean');
  if (!optStr(c.note) || (isStr(c.note) && c.note.length > LIMITS.outcomeNote)) return bad(label, 'note', `must be text of at most ${LIMITS.outcomeNote} characters or null`);
  if (c.experienceRating !== undefined && c.experienceRating !== null && !(isInt(c.experienceRating) && c.experienceRating >= 1 && c.experienceRating <= 5)) return bad(label, 'experienceRating', 'must be 1–5 or null');
  if (!isInt(c.at)) return bad(label, 'at', 'must be an integer instant');
  return { ok: true, record: { by: { kind: c.by.kind, id: c.by.id, name: orNull(c.by.name) }, agree: c.agree, note: orNull(c.note), experienceRating: orNull(c.experienceRating), at: c.at } };
}
const TYPERS = { signingPackages: typeSigningPackage, signings: typeSigning, followUps: typeFollowUp, outcomeReports: typeOutcomeReport };

// ------------------------------------------------------------------ rows ↔ records
const insertFor = (sqlite, table, cols, { upsert = null } = {}) => sqlite.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})${upsert ? ` ON CONFLICT(${upsert}) DO UPDATE SET ${cols.filter((c) => c !== upsert).map((c) => `${c} = excluded.${c}`).join(', ')}` : ''}`);
const PKG_COLS = ['id', 'org_id', 'case_id', 'player_id', 'offer_id', 'offer_revision_id', 'transaction_id', 'status', 'current_revision_id', 'expires_at', 'internal_note', 'completion_signing_id', 'completion_completed_at', 'completion_by_kind', 'completion_by_user_id', 'completion_by_name', 'completion_by_role', 'completion_contract_start_date', 'completion_contract_end_date', 'completion_document_sha256', 'completion_lifecycle_from', 'completion_lifecycle_to', 'completion_lifecycle_at', 'cancelled_at', 'cancelled_by_kind', 'cancelled_by_user_id', 'cancelled_by_name', 'cancelled_by_role', 'cancel_reason', 'voided_at', 'voided_by_kind', 'voided_by_id', 'voided_by_name', 'voided_by_role', 'void_reason', 'created_at', 'created_by_kind', 'created_by_user_id', 'created_by_name', 'created_by_role', 'updated_at', 'rev', 'rev_at', 'rev_by_user_id', 'rev_by_name', 'policy_version', 'subject_removed_at'];
const REV_COLS = ['id', 'package_id', 'position', 'revision_number', 'status', 'created_at', 'created_by_kind', 'created_by_user_id', 'created_by_name', 'created_by_role', 'ready_at', 'ready_by_kind', 'ready_by_user_id', 'ready_by_name', 'ready_by_role', 'completed_at', 'completed_by_kind', 'completed_by_user_id', 'completed_by_name', 'completed_by_role', 'superseded_at', 'contract_start_date', 'contract_end_date', 'policy_version', 'policy_jurisdiction', 'policy_offer_policy_version', 'supersedes_revision_id', 'superseded_by_revision_id'];
const DOC_COLS = ['id', 'revision_id', 'kind', 'evidence_id', 'sha256', 'filename', 'mime', 'bytes', 'label', 'uploaded_at', 'uploaded_by_kind', 'uploaded_by_user_id', 'uploaded_by_name', 'uploaded_by_role'];
const PARTY_COLS = ['revision_id', 'position', 'party_type', 'for_entity_id', 'for_player_id', 'status', 'completed_at', 'completed_by_kind', 'completed_by_id', 'completed_by_name', 'method', 'evidence_ref_kind', 'evidence_ref_id', 'evidence_revision_id', 'evidence_document_sha256', 'evidence_at', 'evidence_actor_kind', 'evidence_actor_id', 'evidence_session'];
const HIST_COLS = ['id', 'package_id', 'position', 'at', 'by_kind', 'by_id', 'by_name', 'action', 'detail_json'];
const KEY_COLS = ['owner_table', 'owner_id', 'position', 'act', 'shape', 'key', 'fp', 'at', 'entry_json'];
const SIGNING_COLS = ['id', 'player_id', 'player_name', 'org_id', 'org_name', 'user_id', 'scout_name', 'ts', 'signed_at', 'first_qualifying_ledger_id', 'first_qualifying_at', 'first_qualifying_type', 'attribution_window_months', 'inside_attribution_window', 'method', 'note', 'signing_package_id', 'signing_revision_id', 'signing_revision_number', 'case_id', 'offer_id', 'offer_revision_id', 'transaction_id', 'document_sha256', 'document_evidence_id', 'executed_document_evidence_id', 'contract_start_date', 'contract_end_date', 'policy_version'];
const SPARTY_COLS = ['signing_id', 'position', 'party_type', 'method', 'completed_at', 'by_kind'];
const FUP_COLS = ['id', 'signing_id', 'player_id', 'org_id', 'milestone', 'due_at', 'status', 'notified_at', 'created_at'];
const OUT_COLS = ['id', 'follow_up_id', 'signing_id', 'player_id', 'org_id', 'by_user_id', 'by_name', 'registration_status', 'matches_played', 'progression', 'end_reason', 'note', 'status', 'at'];
const CONF_COLS = ['report_id', 'position', 'by_kind', 'by_id', 'by_name', 'agree', 'note', 'experience_rating', 'at'];

function pkgRow(p) {
  const c = p.completion;
  return {
    id: p.id, org_id: p.orgId, case_id: p.caseId, player_id: p.playerId, offer_id: p.offerId, offer_revision_id: p.offerRevisionId, transaction_id: p.transactionId, status: p.status, current_revision_id: p.currentRevisionId, expires_at: p.expiresAt, internal_note: p.internalNote,
    completion_signing_id: c?.signingId ?? null, completion_completed_at: c?.completedAt ?? null, ...actorCols('completion_by', c?.completedBy ?? null), completion_contract_start_date: c?.contract?.startDate ?? null, completion_contract_end_date: c?.contract?.endDate ?? null, completion_document_sha256: c?.documentSha256 ?? null, completion_lifecycle_from: c?.lifecycle?.from ?? null, completion_lifecycle_to: c?.lifecycle?.to ?? null, completion_lifecycle_at: c?.lifecycle?.at ?? null,
    cancelled_at: p.cancelledAt, ...actorCols('cancelled_by', p.cancelledBy), cancel_reason: p.cancelReason, voided_at: p.voidedAt, ...actorCols('voided_by', p.voidedBy, { user: false }), void_reason: p.voidReason,
    created_at: p.createdAt, ...actorCols('created_by', p.createdBy), updated_at: p.updatedAt, rev: p.rev, rev_at: p.revAt, rev_by_user_id: p.revBy?.userId ?? null, rev_by_name: p.revBy?.name ?? null, policy_version: p.policyVersion, subject_removed_at: p.subjectRemovedAt,
  };
}
const revRow = (pkgId, r, position) => ({ id: r.id, package_id: pkgId, position, revision_number: r.revisionNumber, status: r.status, created_at: r.createdAt, ...actorCols('created_by', r.createdBy), ready_at: r.readyAt, ...actorCols('ready_by', r.readyBy), completed_at: r.completedAt, ...actorCols('completed_by', r.completedBy), superseded_at: r.supersededAt, contract_start_date: r.contract?.startDate ?? null, contract_end_date: r.contract?.endDate ?? null, policy_version: r.policySnapshot?.policyVersion ?? null, policy_jurisdiction: r.policySnapshot?.jurisdiction ?? null, policy_offer_policy_version: r.policySnapshot?.offerPolicyVersion ?? null, supersedes_revision_id: r.supersedesRevisionId, superseded_by_revision_id: r.supersededByRevisionId });
const docRow = (revId, kind, d) => ({ id: d.id, revision_id: revId, kind, evidence_id: d.evidenceId, sha256: d.sha256, filename: d.filename, mime: d.mime, bytes: d.bytes, label: d.label, uploaded_at: d.uploadedAt, ...actorCols('uploaded_by', d.uploadedBy) });
const partyRow = (revId, p, position) => ({ revision_id: revId, position, party_type: p.partyType, for_entity_id: p.forEntityId, for_player_id: p.forPlayerId, status: p.status, completed_at: p.completedAt, completed_by_kind: p.completedBy?.kind ?? null, completed_by_id: p.completedBy?.id ?? null, completed_by_name: p.completedBy?.name ?? null, method: p.method, evidence_ref_kind: p.evidenceRef?.kind ?? null, evidence_ref_id: p.evidenceRef?.id ?? null, evidence_revision_id: p.evidenceRef?.revisionId ?? null, evidence_document_sha256: p.evidenceRef?.documentSha256 ?? null, evidence_at: p.evidenceRef?.at ?? null, evidence_actor_kind: p.evidenceRef?.actorKind ?? null, evidence_actor_id: p.evidenceRef?.actorId ?? null, evidence_session: p.evidenceRef?.session ?? null });
const histRow = (pkgId, h, position) => ({ id: h.id, package_id: pkgId, position, at: h.at, by_kind: h.by?.kind ?? null, by_id: h.by?.id ?? null, by_name: h.by?.name ?? null, action: h.action, detail_json: h.detail === null ? null : JSON.stringify(h.detail) });
function keyRows(pkgId, keys) {
  const rows = []; let position = 0;
  if (keys.start) rows.push({ owner_table: 'signing_packages', owner_id: pkgId, position: position++, act: 'start', shape: 'value', key: keys.start.key, fp: keys.start.fp, at: null, entry_json: JSON.stringify(keys.start) });
  for (const act of PACKAGE_KEY_ACTS.slice(1)) for (const e of keys[act] ?? []) rows.push({ owner_table: 'signing_packages', owner_id: pkgId, position: position++, act, shape: 'list', key: e.key, fp: e.fp, at: e.at ?? null, entry_json: JSON.stringify(e) });
  return rows;
}
const signingRow = (s) => ({ id: s.id, player_id: s.playerId, player_name: s.playerName, org_id: s.orgId, org_name: s.orgName, user_id: s.userId, scout_name: s.scoutName, ts: s.ts, signed_at: s.signedAt, first_qualifying_ledger_id: s.firstQualifyingInteraction?.id ?? null, first_qualifying_at: s.firstQualifyingInteraction?.ts ?? null, first_qualifying_type: s.firstQualifyingInteraction?.type ?? null, attribution_window_months: s.attributionWindowMonths, inside_attribution_window: s.insideAttributionWindow ? 1 : 0, method: s.method, note: s.note, signing_package_id: s.signingPackageId, signing_revision_id: s.signingRevisionId, signing_revision_number: s.signingRevisionNumber, case_id: s.caseId, offer_id: s.offerId, offer_revision_id: s.offerRevisionId, transaction_id: s.transactionId, document_sha256: s.documentSha256, document_evidence_id: s.documentEvidenceId, executed_document_evidence_id: s.executedDocumentEvidenceId, contract_start_date: s.contract?.startDate ?? null, contract_end_date: s.contract?.endDate ?? null, policy_version: s.policyVersion });
const spartyRow = (sid, p, position) => ({ signing_id: sid, position, party_type: p.partyType, method: p.method, completed_at: p.completedAt, by_kind: p.byKind });
const fupRow = (f) => ({ id: f.id, signing_id: f.signingId, player_id: f.playerId, org_id: f.orgId, milestone: f.milestone, due_at: f.dueAt, status: f.status, notified_at: f.notifiedAt, created_at: f.createdAt });
const outRow = (r) => ({ id: r.id, follow_up_id: r.followUpId, signing_id: r.signingId, player_id: r.playerId, org_id: r.orgId, by_user_id: r.by.id, by_name: r.by.name, registration_status: r.registrationStatus, matches_played: r.matchesPlayed, progression: r.progression, end_reason: r.endReason, note: r.note, status: r.status, at: r.at });
const confRow = (rid, c, position) => ({ report_id: rid, position, by_kind: c.by.kind, by_id: c.by.id, by_name: c.by.name, agree: c.agree ? 1 : 0, note: c.note, experience_rating: c.experienceRating, at: c.at });

/** Prepared statements over one connection. */
function statements(sqlite) {
  return {
    pkg: insertFor(sqlite, 'signing_packages', PKG_COLS, { upsert: 'id' }), rev: insertFor(sqlite, 'signing_revisions', REV_COLS, { upsert: 'id' }), doc: insertFor(sqlite, 'signing_documents', DOC_COLS), party: insertFor(sqlite, 'signing_revision_parties', PARTY_COLS), hist: insertFor(sqlite, 'signing_history', HIST_COLS), key: insertFor(sqlite, 'idempotency_keys', KEY_COLS),
    signing: insertFor(sqlite, 'signings', SIGNING_COLS, { upsert: 'id' }), sparty: insertFor(sqlite, 'signing_parties', SPARTY_COLS), fup: insertFor(sqlite, 'follow_ups', FUP_COLS, { upsert: 'id' }), out: insertFor(sqlite, 'outcome_reports', OUT_COLS, { upsert: 'id' }), conf: insertFor(sqlite, 'outcome_report_confirmations', CONF_COLS),
    docsOf: sqlite.prepare('DELETE FROM signing_documents WHERE revision_id IN (SELECT id FROM signing_revisions WHERE package_id = ?)'), partiesOf: sqlite.prepare('DELETE FROM signing_revision_parties WHERE revision_id IN (SELECT id FROM signing_revisions WHERE package_id = ?)'), histOf: sqlite.prepare('DELETE FROM signing_history WHERE package_id = ?'), keysOf: sqlite.prepare("DELETE FROM idempotency_keys WHERE owner_table = 'signing_packages' AND owner_id = ?"), revsOf: sqlite.prepare('DELETE FROM signing_revisions WHERE package_id = ?'), revsNotIn: (ids_) => sqlite.prepare(`DELETE FROM signing_revisions WHERE package_id = ? AND id NOT IN (${ids_.map(() => '?').join(', ')})`), pkgDel: sqlite.prepare('DELETE FROM signing_packages WHERE id = ?'),
    spartiesOf: sqlite.prepare('DELETE FROM signing_parties WHERE signing_id = ?'), signingDel: sqlite.prepare('DELETE FROM signings WHERE id = ?'), fupDel: sqlite.prepare('DELETE FROM follow_ups WHERE id = ?'), confsOf: sqlite.prepare('DELETE FROM outcome_report_confirmations WHERE report_id = ?'), outDel: sqlite.prepare('DELETE FROM outcome_reports WHERE id = ?'),
    pkgById: sqlite.prepare('SELECT * FROM signing_packages WHERE id = ?'), pkgAll: sqlite.prepare('SELECT * FROM signing_packages ORDER BY rowid'), revsBy: sqlite.prepare('SELECT * FROM signing_revisions WHERE package_id = ? ORDER BY position'), docsBy: sqlite.prepare('SELECT * FROM signing_documents WHERE revision_id = ?'), partiesBy: sqlite.prepare('SELECT * FROM signing_revision_parties WHERE revision_id = ? ORDER BY position'), histBy: sqlite.prepare('SELECT * FROM signing_history WHERE package_id = ? ORDER BY position'), keysBy: sqlite.prepare("SELECT * FROM idempotency_keys WHERE owner_table = 'signing_packages' AND owner_id = ? ORDER BY position"),
    signingById: sqlite.prepare('SELECT * FROM signings WHERE id = ?'), signingAll: sqlite.prepare('SELECT * FROM signings ORDER BY rowid'), spartiesBy: sqlite.prepare('SELECT * FROM signing_parties WHERE signing_id = ? ORDER BY position'),
    fupById: sqlite.prepare('SELECT * FROM follow_ups WHERE id = ?'), fupAll: sqlite.prepare('SELECT * FROM follow_ups ORDER BY rowid'), outById: sqlite.prepare('SELECT * FROM outcome_reports WHERE id = ?'), outAll: sqlite.prepare('SELECT * FROM outcome_reports ORDER BY rowid'), confsBy: sqlite.prepare('SELECT * FROM outcome_report_confirmations WHERE report_id = ? ORDER BY position'),
    ids: (table) => sqlite.prepare(`SELECT id FROM ${table} ORDER BY rowid`).all().map((r) => r.id),
  };
}
const contractOut = (row, p) => (row[`${p}start_date`] === null && row[`${p}end_date`] === null ? null : { startDate: row[`${p}start_date`], endDate: row[`${p}end_date`] });
function decodeDocument(row) { return { id: row.id, evidenceId: row.evidence_id, sha256: row.sha256, filename: row.filename, mime: row.mime, bytes: row.bytes, label: row.label, uploadedAt: row.uploaded_at, uploadedBy: actorOut('uploaded_by', row) }; }
function decodeParty(row) {
  const ev = row.evidence_ref_kind === null && row.evidence_ref_id === null ? null : { kind: row.evidence_ref_kind, id: row.evidence_ref_id, revisionId: row.evidence_revision_id, documentSha256: row.evidence_document_sha256, at: row.evidence_at, actorKind: row.evidence_actor_kind, actorId: row.evidence_actor_id, session: row.evidence_session };
  const by = row.completed_by_kind === null && row.completed_by_id === null && row.completed_by_name === null ? null : { kind: row.completed_by_kind, id: row.completed_by_id, name: row.completed_by_name };
  return { partyType: row.party_type, forEntityId: row.for_entity_id, forPlayerId: row.for_player_id, status: row.status, completedAt: row.completed_at, completedBy: by, evidenceRef: ev, method: row.method };
}
function decodePackage(st, row) {
  const revisions = st.revsBy.all(row.id).map((r) => {
    const docs = st.docsBy.all(r.id); const d = docs.find((x) => x.kind === 'signing'); const x = docs.find((y) => y.kind === 'executed');
    const policy = r.policy_version === null && r.policy_jurisdiction === null && r.policy_offer_policy_version === null ? null : { policyVersion: r.policy_version, jurisdiction: r.policy_jurisdiction, offerPolicyVersion: r.policy_offer_policy_version };
    return { id: r.id, revisionNumber: r.revision_number, status: r.status, createdAt: r.created_at, createdBy: actorOut('created_by', r), readyAt: r.ready_at, readyBy: actorOut('ready_by', r), completedAt: r.completed_at, completedBy: actorOut('completed_by', r), document: d ? decodeDocument(d) : null, executedDocument: x ? decodeDocument(x) : null, contract: contractOut(r, 'contract_'), requiredParties: st.partiesBy.all(r.id).map(decodeParty), policySnapshot: policy, supersedesRevisionId: r.supersedes_revision_id, supersededByRevisionId: r.superseded_by_revision_id, supersededAt: r.superseded_at };
  });
  const keys = { start: null, ready: [], party: [], cancel: [], void: [], supersede: [], complete: [] };
  for (const k of st.keysBy.all(row.id)) { const entry = JSON.parse(k.entry_json); if (k.act === 'start') keys.start = entry; else keys[k.act].push(entry); }
  const history = st.histBy.all(row.id).map((h) => ({ id: h.id, at: h.at, action: h.action, by: h.by_kind === null && h.by_id === null && h.by_name === null ? null : { kind: h.by_kind, id: h.by_id, name: h.by_name }, detail: h.detail_json === null ? null : JSON.parse(h.detail_json) }));
  const completion = row.completion_signing_id === null ? null : { signingId: row.completion_signing_id, completedAt: row.completion_completed_at, completedBy: actorOut('completion_by', row), contract: contractOut(row, 'completion_contract_'), documentSha256: row.completion_document_sha256, lifecycle: row.completion_lifecycle_from === null && row.completion_lifecycle_to === null && row.completion_lifecycle_at === null ? null : { from: row.completion_lifecycle_from, to: row.completion_lifecycle_to, at: row.completion_lifecycle_at } };
  return {
    id: row.id, orgId: row.org_id, caseId: row.case_id, playerId: row.player_id, offerId: row.offer_id, offerRevisionId: row.offer_revision_id, transactionId: row.transaction_id, status: row.status, currentRevisionId: row.current_revision_id, revisions, expiresAt: row.expires_at, internalNote: row.internal_note, keys, history, completion,
    cancelledAt: row.cancelled_at, cancelledBy: actorOut('cancelled_by', row), cancelReason: row.cancel_reason, voidedAt: row.voided_at, voidedBy: actorOut('voided_by', row, { user: false }), voidReason: row.void_reason,
    createdAt: row.created_at, createdBy: actorOut('created_by', row), updatedAt: row.updated_at, rev: row.rev, revAt: row.rev_at, revBy: row.rev_by_user_id === null && row.rev_by_name === null ? null : { userId: row.rev_by_user_id, name: row.rev_by_name }, policyVersion: row.policy_version, subjectRemovedAt: row.subject_removed_at,
  };
}
function decodeSigning(st, row) {
  return {
    id: row.id, playerId: row.player_id, playerName: row.player_name, orgId: row.org_id, orgName: row.org_name, userId: row.user_id, scoutName: row.scout_name, ts: row.ts, signedAt: row.signed_at,
    firstQualifyingInteraction: row.first_qualifying_ledger_id === null && row.first_qualifying_at === null && row.first_qualifying_type === null ? null : { id: row.first_qualifying_ledger_id, ts: row.first_qualifying_at, type: row.first_qualifying_type },
    attributionWindowMonths: row.attribution_window_months, insideAttributionWindow: row.inside_attribution_window === 1, method: row.method, note: row.note, signingPackageId: row.signing_package_id, signingRevisionId: row.signing_revision_id, signingRevisionNumber: row.signing_revision_number, caseId: row.case_id, offerId: row.offer_id, offerRevisionId: row.offer_revision_id, transactionId: row.transaction_id, documentSha256: row.document_sha256, documentEvidenceId: row.document_evidence_id, executedDocumentEvidenceId: row.executed_document_evidence_id, contract: contractOut(row, 'contract_'),
    parties: st.spartiesBy.all(row.id).map((p) => ({ partyType: p.party_type, method: p.method, completedAt: p.completed_at, byKind: p.by_kind })), policyVersion: row.policy_version,
  };
}
const decodeFollowUp = (row) => ({ id: row.id, signingId: row.signing_id, playerId: row.player_id, orgId: row.org_id, milestone: row.milestone, dueAt: row.due_at, status: row.status, notifiedAt: row.notified_at, createdAt: row.created_at });
const decodeOutcome = (st, row) => ({ id: row.id, followUpId: row.follow_up_id, signingId: row.signing_id, playerId: row.player_id, orgId: row.org_id, by: { kind: 'org', id: row.by_user_id, name: row.by_name }, registrationStatus: row.registration_status, matchesPlayed: row.matches_played, progression: row.progression, endReason: row.end_reason, note: row.note, status: row.status, confirmations: st.confsBy.all(row.id).map((c) => ({ by: { kind: c.by_kind, id: c.by_id, name: c.by_name }, agree: c.agree === 1, note: c.note, experienceRating: c.experience_rating, at: c.at })), at: row.at });

/** Write a typed package whole (its revisions by upsert — a signing may reference one — and the rest replaced). */
function writePackage(st, p) {
  st.pkg.run(pkgRow(p));
  st.docsOf.run(p.id); st.partiesOf.run(p.id); st.histOf.run(p.id); st.keysOf.run(p.id);
  st.revsNotIn(p.revisions.map((r) => r.id)).run(p.id, ...p.revisions.map((r) => r.id));
  p.revisions.forEach((r, i) => { st.rev.run(revRow(p.id, r, i)); if (r.document) st.doc.run(docRow(r.id, 'signing', r.document)); if (r.executedDocument) st.doc.run(docRow(r.id, 'executed', r.executedDocument)); r.requiredParties.forEach((pt, j) => st.party.run(partyRow(r.id, pt, j))); });
  p.history.forEach((h, i) => st.hist.run(histRow(p.id, h, i)));
  for (const k of keyRows(p.id, p.keys)) st.key.run(k);
}
function writeSigning(st, s) { st.signing.run(signingRow(s)); st.spartiesOf.run(s.id); s.parties.forEach((p, i) => st.sparty.run(spartyRow(s.id, p, i))); }
function writeOutcome(st, r) { st.out.run(outRow(r)); st.confsOf.run(r.id); r.confirmations.forEach((c, i) => st.conf.run(confRow(r.id, c, i))); }
function deletePackage(st, id) { st.docsOf.run(id); st.partiesOf.run(id); st.histOf.run(id); st.keysOf.run(id); st.revsOf.run(id); st.pkgDel.run(id); }

/** Every reference a record names that must exist (ids only), checked before the engine would name a rowid. */
function checkReferences(sqlite, typed, label) {
  const has = (table, id) => !!sqlite.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id);
  const orgs = new Set(sqlite.prepare('SELECT id FROM orgs').all().map((r) => r.id)); const users = new Set(sqlite.prepare('SELECT id FROM org_users').all().map((r) => r.id));
  const pkgIds = new Set(typed.signingPackages.map((p) => p.id)); const revIds = new Set(typed.signingPackages.flatMap((p) => p.revisions.map((r) => r.id)));
  const signingIds = new Set(typed.signings.map((s) => s.id)); const fupIds = new Set(typed.followUps.map((f) => f.id));
  const problems = [];
  const need = (ok, what) => { if (!ok) problems.push(what); };
  for (const p of typed.signingPackages) {
    need(orgs.has(p.orgId), `signing_packages ${p.id} → orgs ${p.orgId}`); need(tableExists(sqlite, 'recruitment_cases') && has('recruitment_cases', p.caseId), `signing_packages ${p.id} → recruitment_cases ${p.caseId}`); need(tableExists(sqlite, 'recruitment_offers') && has('recruitment_offers', p.offerId), `signing_packages ${p.id} → recruitment_offers ${p.offerId}`);
    for (const [f, a] of [['createdBy', p.createdBy], ['cancelledBy', p.cancelledBy], ['completion.completedBy', p.completion?.completedBy]]) if (a?.id && a.kind === 'org') need(users.has(a.id), `signing_packages ${p.id} ${f} → org_users ${a.id}`);
    if (p.completion) need(signingIds.has(p.completion.signingId), `signing_packages ${p.id} completion → signings ${p.completion.signingId}`);
    for (const r of p.revisions) { for (const [f, a] of [['createdBy', r.createdBy], ['readyBy', r.readyBy], ['completedBy', r.completedBy], ['document.uploadedBy', r.document?.uploadedBy], ['executedDocument.uploadedBy', r.executedDocument?.uploadedBy]]) if (a?.id && a.kind === 'org') need(users.has(a.id), `signing_revisions ${r.id} ${f} → org_users ${a.id}`); if (r.supersedesRevisionId) need(revIds.has(r.supersedesRevisionId), `signing_revisions ${r.id} supersedes → ${r.supersedesRevisionId}`); if (r.supersededByRevisionId) need(revIds.has(r.supersededByRevisionId), `signing_revisions ${r.id} supersededBy → ${r.supersededByRevisionId}`); }
  }
  for (const s of typed.signings) {
    need(orgs.has(s.orgId), `signings ${s.id} → orgs ${s.orgId}`); if (s.userId) need(users.has(s.userId), `signings ${s.id} → org_users ${s.userId}`);
    if (s.signingPackageId) need(pkgIds.has(s.signingPackageId), `signings ${s.id} → signing_packages ${s.signingPackageId}`); if (s.signingRevisionId) need(revIds.has(s.signingRevisionId), `signings ${s.id} → signing_revisions ${s.signingRevisionId}`);
    if (s.caseId) need(has('recruitment_cases', s.caseId), `signings ${s.id} → recruitment_cases ${s.caseId}`); if (s.offerId) need(has('recruitment_offers', s.offerId), `signings ${s.id} → recruitment_offers ${s.offerId}`);
  }
  for (const f of typed.followUps) { need(orgs.has(f.orgId), `follow_ups ${f.id} → orgs ${f.orgId}`); need(signingIds.has(f.signingId), `follow_ups ${f.id} → signings ${f.signingId}`); }
  for (const r of typed.outcomeReports) { need(orgs.has(r.orgId), `outcome_reports ${r.id} → orgs ${r.orgId}`); need(signingIds.has(r.signingId), `outcome_reports ${r.id} → signings ${r.signingId}`); need(fupIds.has(r.followUpId), `outcome_reports ${r.id} → follow_ups ${r.followUpId}`); need(users.has(r.by.id), `outcome_reports ${r.id} by → org_users ${r.by.id}`); }
  if (problems.length) throw refusal('SIGNINGS_REFERENCE_MISSING', `${problems.length} reference(s) in ${label} name a row that is not there (${ids(problems)}); the write was rolled back and nothing was changed`, { rows: problems });
}
/** The uniqueness rules the code keeps, named with ids before the engine would. */
function checkUniqueness(typed, label) {
  const problems = []; const seen = (m, k, what) => { if (k === null || k === undefined) return; if (m.has(k)) problems.push(`${what} ${k} (${m.get(k)} and this)`); else m.set(k, what); };
  const done = new Map(); const perPkg = new Map(); const perOffer = new Map(); const legacy = new Map(); const perMilestone = new Map(); const perFup = new Map();
  // one LIVE package per offer is a rule of the clock (EXPIRED is derived from expires_at, never stored: an expired
  // READY package and the next one share the offer), so it stays with m29 canStart; one COMPLETED per offer is a column
  const revIds = new Map(); const docIds = new Map(); const histIds = new Map();
  for (const p of typed.signingPackages) { if (p.status === 'COMPLETED') seen(done, p.offerId, 'a completed package per offer'); for (const r of p.revisions) { seen(revIds, r.id, `a revision id in ${p.id}`); for (const d of [r.document, r.executedDocument]) if (d) seen(docIds, d.id, `a document id in ${p.id}`); } for (const h of p.history) seen(histIds, h.id, `a history id in ${p.id}`); }
  for (const s of typed.signings) { seen(perPkg, s.signingPackageId, 'a signing per package'); seen(perOffer, s.offerId, 'a signing per offer'); if (!s.signingPackageId) seen(legacy, `${s.orgId}/${s.playerId}`, 'a standing legacy signing per organisation and player'); }
  for (const f of typed.followUps) seen(perMilestone, `${f.signingId}/${f.milestone}`, 'a follow-up per signing and milestone');
  for (const r of typed.outcomeReports) seen(perFup, r.followUpId, 'a report per follow-up');
  if (problems.length) throw refusal('SIGNINGS_UNIQUENESS', `${problems.length} rule(s) violated in ${label}: ${ids(problems)}; the write was rolled back and nothing was changed`, { rows: problems });
}
/** Type every entry of the supplied collections (array order kept); refuse on the first problem with ids only. */
function typeCollections(supplied, label) {
  const typed = {}; const notes = []; const counts = {};
  for (const name of SIGNINGS_FOLLOWUPS_COLLECTIONS) {
    const list = supplied[name]; typed[name] = [];
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw refusal('SIGNINGS_IMPORT_BLOCKED', `the ${name} collection of ${label} must be an array of entries (got ${describe(list)})`);
    const seen = new Set(); let normalised = 0;
    list.forEach((raw, i) => { const t = TYPERS[name](raw, `${name} entry #${i}`); if (!t.ok) throw refusal('SIGNINGS_IMPORT_BLOCKED', `${label}: ${t.reason}`); if (seen.has(t.record.id)) throw refusal('SIGNINGS_IMPORT_BLOCKED', `${label}: ${name} entry #${i} duplicates the id of an earlier entry (${t.record.id})`); seen.add(t.record.id); typed[name].push(t.record); if (t.notes.length) normalised += 1; notes.push(...t.notes); });
    counts[name] = { imported: list.length, normalised };
  }
  return { typed, notes, counts };
}
/** Count the player references (every occurrence) as live, retained or missing — Q7a/Q8a/Q8c-a applied; never refused. */
function countPlayers(sqlite, typed) {
  const counts = { live: 0, retained: 0, missing: 0 };
  if (!tableExists(sqlite, 'players')) return counts;
  const live = new Set(sqlite.prepare('SELECT id FROM players WHERE deleted_at IS NULL').all().map((r) => r.id)); const retained = new Set(sqlite.prepare('SELECT id FROM players WHERE deleted_at IS NOT NULL').all().map((r) => r.id));
  const count = (pid) => { if (live.has(pid)) counts.live += 1; else if (retained.has(pid)) counts.retained += 1; else counts.missing += 1; };
  for (const p of typed.signingPackages) { count(p.playerId); for (const r of p.revisions) for (const pt of r.requiredParties) { if (isStr(pt.forPlayerId)) count(pt.forPlayerId); if (pt.partyType === 'PLAYER' && isStr(pt.forEntityId)) count(pt.forEntityId); if (pt.completedBy?.kind === 'player' && isStr(pt.completedBy.id)) count(pt.completedBy.id); } for (const h of p.history) if (h.by?.kind === 'player' && isStr(h.by.id)) count(h.by.id); }
  for (const s of typed.signings) count(s.playerId);
  for (const f of typed.followUps) count(f.playerId);
  for (const r of typed.outcomeReports) { count(r.playerId); for (const c of r.confirmations) if (c.by.kind === 'player') count(c.by.id); }
  return counts;
}
const PLAYER_REFS_SQL = {
  signingPackages: "SELECT player_id AS pid FROM signing_packages UNION ALL SELECT for_player_id FROM signing_revision_parties WHERE for_player_id IS NOT NULL UNION ALL SELECT for_entity_id FROM signing_revision_parties WHERE party_type = 'PLAYER' AND for_entity_id IS NOT NULL UNION ALL SELECT completed_by_id FROM signing_revision_parties WHERE completed_by_kind = 'player' AND completed_by_id IS NOT NULL UNION ALL SELECT by_id FROM signing_history WHERE by_kind = 'player' AND by_id IS NOT NULL",
  signings: 'SELECT player_id AS pid FROM signings', followUps: 'SELECT player_id AS pid FROM follow_ups',
  outcomeReports: "SELECT player_id AS pid FROM outcome_reports UNION ALL SELECT by_id FROM outcome_report_confirmations WHERE by_kind = 'player'",
};
export const signingsFollowUpsLive = (sqlite) => migrationApplied(sqlite, SIGNINGS_FOLLOWUPS_MIGRATION);
export function unresolvedPlayerReferences(sqlite) {
  if (!signingsFollowUpsLive(sqlite)) return null;
  return Object.fromEntries(SIGNINGS_FOLLOWUPS_COLLECTIONS.map((c) => [c, sqlite.prepare(`SELECT count(*) AS n FROM (${PLAYER_REFS_SQL[c]}) x WHERE NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid)`).get().n]));
}
export function retainedPlayerReferences(sqlite) {
  if (!signingsFollowUpsLive(sqlite)) return null;
  return Object.fromEntries(SIGNINGS_FOLLOWUPS_COLLECTIONS.map((c) => [c, sqlite.prepare(`SELECT count(*) AS n FROM (${PLAYER_REFS_SQL[c]}) x WHERE EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid AND p.deleted_at IS NOT NULL)`).get().n]));
}

/** Write typed collections in dependency order: packages (deferred completion key) → signings → follow-ups → reports. */
function writeTyped(sqlite, typed) {
  const st = statements(sqlite);
  for (const p of typed.signingPackages) writePackage(st, p);
  for (const s of typed.signings) writeSigning(st, s);
  for (const f of typed.followUps) st.fup.run(fupRow(f));
  for (const r of typed.outcomeReports) writeOutcome(st, r);
}
function assertKeys(sqlite, label) {
  for (const t of SIGNINGS_FOLLOWUPS_TABLES) { const broken = sqlite.prepare(`PRAGMA foreign_key_check(${t})`).all(); if (broken.length) throw refusal('SIGNINGS_KEY_VIOLATION', `${label}: ${t} holds ${broken.length} row(s) whose reference is not there (first: rowid ${broken[0].rowid} → ${broken[0].parent}); the write was rolled back`); }
}

/**
 * The cutover (migration 0018): the four blobs typed and normalised (notes with ids), every reference checked against
 * the tables as they stand, the uniqueness rules named, the rows written, the player references counted. Returns the
 * counts and the notes for `meta.signingsFollowUpsCutover`. Any refusal throws SIGNINGS_IMPORT_BLOCKED and the runner
 * rolls back; a genuinely absent blob imports nothing.
 */
export function importSigningsFollowUpsBlobs(sqlite) {
  const blob = (name) => { const row = tableExists(sqlite, 'collections') ? sqlite.prepare('SELECT value FROM collections WHERE name = ?').get(name) : null; if (!row) return undefined; let v; try { v = JSON.parse(row.value); } catch { throw refusal('SIGNINGS_IMPORT_BLOCKED', `the ${name} blob is not valid JSON`); } if (v === null || !Array.isArray(v)) throw refusal('SIGNINGS_IMPORT_BLOCKED', `the ${name} blob must be an array of entries (got ${describe(v)})`); return v; };
  const supplied = Object.fromEntries(SIGNINGS_FOLLOWUPS_COLLECTIONS.map((n) => [n, blob(n)]));
  const { typed, notes, counts } = typeCollections(supplied, 'the signing, follow-up and outcome blobs');
  try { checkReferences(sqlite, typed, 'the blobs'); checkUniqueness(typed, 'the blobs'); } catch (e) { throw refusal('SIGNINGS_IMPORT_BLOCKED', e.message, { cause: e }); }
  writeTyped(sqlite, typed);
  if (tableExists(sqlite, 'collections')) for (const n of SIGNINGS_FOLLOWUPS_COLLECTIONS) sqlite.prepare('DELETE FROM collections WHERE name = ?').run(n);
  const players = countPlayers(sqlite, typed);
  return { counts, players, notes };
}

/** Whole-snapshot access (readTableBacked / writeTableBacked). */
export const SIGNINGS_FOLLOWUPS_SNAPSHOT = {
  names: SIGNINGS_FOLLOWUPS_COLLECTIONS,
  read(sqlite) { if (!signingsFollowUpsLive(sqlite)) return null; const st = statements(sqlite); return { signingPackages: st.pkgAll.all().map((r) => decodePackage(st, r)), signings: st.signingAll.all().map((r) => decodeSigning(st, r)), followUps: st.fupAll.all().map(decodeFollowUp), outcomeReports: st.outAll.all().map((r) => decodeOutcome(st, r)) }; },
  /**
   * The supplied collections typed (refused on junk, ids only; a legacy backup's rows normalised as the cutover
   * normalises them, logged), the departures — the rows a supplied array no longer lists — removed children first
   * (a departing row a RETAINED collection still references is refused with ids), BEFORE the S8c departures so a
   * package can leave with its offer. Returns the plan `write` and `assert` take, or null before the 0018 record.
   */
  begin(sqlite, db, { label = 'the snapshot', log = () => {} } = {}) {
    if (!signingsFollowUpsLive(sqlite)) return null;
    const supplied = Object.fromEntries(SIGNINGS_FOLLOWUPS_COLLECTIONS.map((n) => [n, Object.hasOwn(db, n) && db[n] !== undefined ? db[n] : undefined]));
    if (SIGNINGS_FOLLOWUPS_COLLECTIONS.every((n) => supplied[n] === undefined)) return { written: [], typed: null };
    const { typed, notes } = typeCollections(supplied, label);
    for (const n of notes) log(`signings/follow-ups snapshot: ${n}`);
    const st = statements(sqlite);
    const stored = Object.fromEntries([['signingPackages', 'signing_packages'], ['signings', 'signings'], ['followUps', 'follow_ups'], ['outcomeReports', 'outcome_reports']].map(([n, t]) => [n, st.ids(t)]));
    const final = (n) => (supplied[n] === undefined ? new Set(stored[n]) : new Set(typed[n].map((r) => r.id)));
    const departing = (n) => (supplied[n] === undefined ? [] : stored[n].filter((id) => !final(n).has(id)));
    // the retained dependants of a departing row, named before the engine would
    const problems = [];
    const finalPkgs = final('signingPackages'); const finalSignings = final('signings'); const finalFups = final('followUps');
    // every row that will be there after this save — the supplied (typed) ones or the stored ones — against every id that will be there
    const finalRows = (n, fromRow, fromRecord) => (supplied[n] === undefined ? st[{ signingPackages: 'pkgAll', signings: 'signingAll', followUps: 'fupAll', outcomeReports: 'outAll' }[n]].all().map(fromRow) : typed[n].map(fromRecord));
    const pkgs = finalRows('signingPackages', (p) => ({ id: p.id, signingId: p.completion_signing_id }), (p) => ({ id: p.id, signingId: p.completion?.signingId ?? null }));
    const sgs = finalRows('signings', (s) => ({ id: s.id, pkg: s.signing_package_id }), (s) => ({ id: s.id, pkg: s.signingPackageId }));
    const fups = finalRows('followUps', (f) => ({ id: f.id, signingId: f.signing_id }), (f) => ({ id: f.id, signingId: f.signingId }));
    const outs = finalRows('outcomeReports', (r) => ({ id: r.id, signingId: r.signing_id, fup: r.follow_up_id }), (r) => ({ id: r.id, signingId: r.signingId, fup: r.followUpId }));
    for (const p of pkgs) if (p.signingId && !finalSignings.has(p.signingId)) problems.push(`signing_packages ${p.id} → signings ${p.signingId}`);
    for (const s of sgs) if (s.pkg && !finalPkgs.has(s.pkg)) problems.push(`signings ${s.id} → signing_packages ${s.pkg}`);
    for (const f of fups) if (!finalSignings.has(f.signingId)) problems.push(`follow_ups ${f.id} → signings ${f.signingId}`);
    for (const r of outs) { if (!finalSignings.has(r.signingId)) problems.push(`outcome_reports ${r.id} → signings ${r.signingId}`); if (!finalFups.has(r.fup)) problems.push(`outcome_reports ${r.id} → follow_ups ${r.fup}`); }
    if (problems.length) throw refusal('SIGNINGS_STILL_REFERENCED', `${problems.length} row(s) of ${label} still name a row this snapshot does not carry (${ids(problems)}); the save was rolled back and nothing was changed`, { rows: problems });
    for (const id of departing('outcomeReports')) { st.confsOf.run(id); st.outDel.run(id); }
    for (const id of departing('followUps')) st.fupDel.run(id);
    // the package ↔ signing cycle (each side's CHECK forbids a half-state): the signings leave first — the package's
    // completion key is deferred (NO ACTION, checked at COMMIT; a RESTRICT would fire at once), the signing's package
    // key is immediate — then the packages, and COMMIT finds the pair gone
    for (const id of departing('signings')) { st.spartiesOf.run(id); st.signingDel.run(id); }
    for (const id of departing('signingPackages')) deletePackage(st, id);
    const written = SIGNINGS_FOLLOWUPS_COLLECTIONS.filter((n) => supplied[n] !== undefined);
    return { written, typed, supplied, label };
  },
  /** The supplied rows upserted (after the offers and cases of the same snapshot are in place). */
  write(sqlite, plan) {
    if (!plan || !plan.typed) return;
    const all = { signingPackages: plan.supplied.signingPackages === undefined ? SIGNINGS_FOLLOWUPS_SNAPSHOT.read(sqlite).signingPackages : plan.typed.signingPackages, signings: plan.supplied.signings === undefined ? SIGNINGS_FOLLOWUPS_SNAPSHOT.read(sqlite).signings : plan.typed.signings, followUps: plan.supplied.followUps === undefined ? SIGNINGS_FOLLOWUPS_SNAPSHOT.read(sqlite).followUps : plan.typed.followUps, outcomeReports: plan.supplied.outcomeReports === undefined ? SIGNINGS_FOLLOWUPS_SNAPSHOT.read(sqlite).outcomeReports : plan.typed.outcomeReports };
    checkReferences(sqlite, all, plan.label); checkUniqueness(all, plan.label);
    writeTyped(sqlite, plan.typed);
  },
  assert(sqlite, { label = 'the snapshot' } = {}) { assertKeys(sqlite, label); },
};

// ------------------------------------------------------------------ the repository (explicit writes; the mirrors; the participant)
/**
 * `createSigningsFollowUpsRepository({ sqlite, unit, now, log })`. Every operation runs through `operation`: joined into
 * the open unit of work (a failure poisons it), the caller's open raw transaction, or a transaction of its own; it
 * writes its rows and re-reads the affected record from the tables into the mirror. The arguments are the typed
 * values the routes validated; the columns' CHECKs are the last line, and a violation is a bug surfacing as a failed
 * unit (answered as a failure), never as a silently kept value.
 */
export function createSigningsFollowUpsRepository({ sqlite, unit = null, now = Date.now, log = () => {} }) {
  if (!sqlite) throw new TypeError('the signings/follow-ups repository needs a SQLite connection (node:sqlite)');
  const st = statements(sqlite);
  const inUnit = () => !!unit?.active?.();
  const operation = (fn) => (inUnit() ? unit.join(fn) : sqlite.isTransaction ? fn() : transaction(sqlite, fn));
  const mirrors = { signingPackages: [], signings: [], followUps: [], outcomeReports: [] };
  const views = Object.fromEntries(SIGNINGS_FOLLOWUPS_COLLECTIONS.map((n) => [n, readonlyView(mirrors[n], `a ${n} record`)]));
  for (const v of Object.values(views)) markView(v);
  const reload = () => { const all = SIGNINGS_FOLLOWUPS_SNAPSHOT.read(sqlite); for (const n of SIGNINGS_FOLLOWUPS_COLLECTIONS) { mirrors[n].length = 0; for (const r of all[n]) mirrors[n].push(r); } };
  // The mirror holds plain records (a frozen object cannot sit behind a read-only proxy); the views and every record an
  // operation returns are read-only proxies, so an in-place edit through either throws, naming the repository.
  const replaceIn = (name, id, record) => { const i = mirrors[name].findIndex((r) => r.id === id); if (record === null) { if (i >= 0) mirrors[name].splice(i, 1); return null; } if (i >= 0) mirrors[name][i] = record; else mirrors[name].push(record); return readonlyView(record, `a ${name} record`); };
  const refreshPackage = (id) => { const row = st.pkgById.get(id); return replaceIn('signingPackages', id, row ? decodePackage(st, row) : null); };
  const refreshSigning = (id) => { const row = st.signingById.get(id); return replaceIn('signings', id, row ? decodeSigning(st, row) : null); };
  const refreshFollowUp = (id) => { const row = st.fupById.get(id); return replaceIn('followUps', id, row ? decodeFollowUp(row) : null); };
  const refreshOutcome = (id) => { const row = st.outById.get(id); return replaceIn('outcomeReports', id, row ? decodeOutcome(st, row) : null); };
  const must = (name, id) => { const r = mirrors[name].find((x) => x.id === id); if (!r) throw refusal('SIGNINGS_NOT_FOUND', `${name} ${id} is not a record of the repository`); return r; };
  const typedOr = (t) => { if (!t.ok) throw refusal('SIGNINGS_INPUT_INVALID', t.reason); return t.record; };
  /** A package column update: the record re-typed whole after the change, so every CHECK the typer knows is applied before SQL. */
  const patchPackage = (id, change) => operation(() => { const cur = must('signingPackages', id); const next = typedOr(typeSigningPackage({ ...clone(cur), ...change }, 'signingPackages')); st.pkg.run(pkgRow(next)); return refreshPackage(id); });
  const patchRevision = (id, revisionId, change) => operation(() => { const cur = must('signingPackages', id); const revs = cur.revisions.map((r) => (r.id === revisionId ? { ...clone(r), ...change } : clone(r))); if (!revs.some((r) => r.id === revisionId)) throw refusal('SIGNINGS_NOT_FOUND', `signing_revisions ${revisionId} is not a revision of ${id}`); const next = typedOr(typeSigningPackage({ ...clone(cur), revisions: revs }, 'signingPackages')); const r = next.revisions.find((x) => x.id === revisionId); const i = next.revisions.indexOf(r); st.rev.run(revRow(id, r, i)); sqlite.prepare('DELETE FROM signing_documents WHERE revision_id = ?').run(revisionId); if (r.document) st.doc.run(docRow(r.id, 'signing', r.document)); if (r.executedDocument) st.doc.run(docRow(r.id, 'executed', r.executedDocument)); sqlite.prepare('DELETE FROM signing_revision_parties WHERE revision_id = ?').run(revisionId); r.requiredParties.forEach((pt, j) => st.party.run(partyRow(r.id, pt, j))); return refreshPackage(id); });

  const signingPackages = {
    /** The package the start route built (revision 1, its parties, the start key, no history yet). */
    insert(raw) { return operation(() => { const p = typedOr(typeSigningPackage(raw, 'signingPackages')); if (mirrors.signingPackages.some((x) => x.id === p.id)) throw refusal('SIGNINGS_DUPLICATE', `signing_packages ${p.id} already exists`); writePackage(st, p); return refreshPackage(p.id); }); },
    patch(id, change) { for (const k of Object.keys(change)) if (['id', 'revisions', 'keys', 'history', 'orgId', 'caseId', 'playerId', 'offerId', 'offerRevisionId', 'createdAt', 'createdBy'].includes(k)) throw new TypeError(`signingPackages.patch: ${k} is not patched; use the dedicated operation`); return patchPackage(id, change); },
    patchRevision(id, revisionId, change) { for (const k of Object.keys(change)) if (['id', 'revisionNumber', 'requiredParties', 'createdAt', 'createdBy'].includes(k)) throw new TypeError(`signingPackages.patchRevision: ${k} is not patched`); return patchRevision(id, revisionId, change); },
    /** A new revision (the supersede): appended; the caller patches the previous one and the package in the same unit. */
    addRevision(id, rawRevision) { return operation(() => { const cur = must('signingPackages', id); const next = typedOr(typeSigningPackage({ ...clone(cur), revisions: [...clone(cur.revisions), rawRevision] }, 'signingPackages')); const r = next.revisions[next.revisions.length - 1]; st.rev.run(revRow(id, r, next.revisions.length - 1)); r.requiredParties.forEach((pt, j) => st.party.run(partyRow(r.id, pt, j))); return refreshPackage(id); }); },
    setDocument(id, revisionId, kind, doc) { return patchRevision(id, revisionId, { [kind === 'executed' ? 'executedDocument' : 'document']: doc }); },
    setParty(id, revisionId, partyType, change) { return operation(() => { const cur = must('signingPackages', id); const rev = cur.revisions.find((r) => r.id === revisionId); if (!rev) throw refusal('SIGNINGS_NOT_FOUND', `signing_revisions ${revisionId} is not a revision of ${id}`); const parties = rev.requiredParties.map((p) => (p.partyType === partyType ? { ...clone(p), ...change } : clone(p))); if (!rev.requiredParties.some((p) => p.partyType === partyType)) throw refusal('SIGNINGS_NOT_FOUND', `${partyType} is not a party of ${revisionId}`); return patchRevision(id, revisionId, { requiredParties: parties }); }); },
    addKey(id, act, entry) { return operation(() => { const cur = must('signingPackages', id); const keys = clone(cur.keys); if (act === 'start') keys.start = entry; else keys[act] = [...(keys[act] ?? []), entry]; const next = typedOr(typeSigningPackage({ ...clone(cur), keys }, 'signingPackages')); st.keysOf.run(id); for (const k of keyRows(id, next.keys)) st.key.run(k); return refreshPackage(id); }); },
    addHistory(id, entry) { return operation(() => { const cur = must('signingPackages', id); const next = typedOr(typeSigningPackage({ ...clone(cur), history: [...clone(cur.history), entry] }, 'signingPackages')); const h = next.history[next.history.length - 1]; st.hist.run(histRow(id, h, next.history.length - 1)); return refreshPackage(id); }); },
    /** Subject removal (the deletion unit): the record kept, the player's names nulled, subject_removed_at set. */
    redactPlayer(playerId, at) { return operation(() => { const touched = []; for (const p of mirrors.signingPackages.filter((x) => x.playerId === playerId)) { sqlite.prepare("UPDATE signing_revision_parties SET completed_by_name = NULL WHERE completed_by_kind = 'player' AND revision_id IN (SELECT id FROM signing_revisions WHERE package_id = ?)").run(p.id); sqlite.prepare("UPDATE signing_history SET by_name = NULL WHERE by_kind = 'player' AND package_id = ?").run(p.id); sqlite.prepare('UPDATE signing_packages SET subject_removed_at = ? WHERE id = ?').run(at, p.id); touched.push(refreshPackage(p.id)); } return touched; }); },
    byId: (id) => { const p = mirrors.signingPackages.find((x) => x.id === id); return p ? readonlyView(p, 'a signingPackages record') : null; },
  };
  const signings = {
    record(raw) { return operation(() => { const s = typedOr(typeSigning(raw, 'signings')); if (mirrors.signings.some((x) => x.id === s.id)) throw refusal('SIGNINGS_DUPLICATE', `signings ${s.id} already exists`); writeSigning(st, s); return refreshSigning(s.id); }); },
    byId: (id) => { const r = mirrors.signings.find((x) => x.id === id); return r ? readonlyView(r, 'a signings record') : null; },
  };
  const followUps = {
    schedule(raw) { return operation(() => { const f = typedOr(typeFollowUp(raw, 'followUps')); if (mirrors.followUps.some((x) => x.id === f.id)) throw refusal('SIGNINGS_DUPLICATE', `follow_ups ${f.id} already exists`); st.fup.run(fupRow(f)); return refreshFollowUp(f.id); }); },
    patch(id, change) { for (const k of Object.keys(change)) if (!['status', 'notifiedAt', 'dueAt'].includes(k)) throw new TypeError(`followUps.patch: ${k} is not patched`); return operation(() => { const cur = must('followUps', id); const f = typedOr(typeFollowUp({ ...clone(cur), ...change }, 'followUps')); st.fup.run(fupRow(f)); return refreshFollowUp(id); }); },
    byId: (id) => { const r = mirrors.followUps.find((x) => x.id === id); return r ? readonlyView(r, 'a followUps record') : null; },
  };
  const outcomeReports = {
    file(raw) { return operation(() => { const r = typedOr(typeOutcomeReport(raw, 'outcomeReports')); if (mirrors.outcomeReports.some((x) => x.id === r.id)) throw refusal('SIGNINGS_DUPLICATE', `outcome_reports ${r.id} already exists`); if (mirrors.outcomeReports.some((x) => x.followUpId === r.followUpId)) throw refusal('SIGNINGS_UNIQUENESS', `follow_ups ${r.followUpId} already has a report`); writeOutcome(st, r); return refreshOutcome(r.id); }); },
    addConfirmation(id, rawConfirmation, { status } = {}) { return operation(() => { const cur = must('outcomeReports', id); const r = typedOr(typeOutcomeReport({ ...clone(cur), confirmations: [...clone(cur.confirmations), rawConfirmation], ...(status ? { status } : {}) }, 'outcomeReports')); const c = r.confirmations[r.confirmations.length - 1]; st.out.run(outRow(r)); st.conf.run(confRow(r.id, c, r.confirmations.length - 1)); return refreshOutcome(id); }); },
    byId: (id) => { const r = mirrors.outcomeReports.find((x) => x.id === id); return r ? readonlyView(r, 'a outcomeReports record') : null; },
  };

  return {
    views, signingPackages, signings, followUps, outcomeReports,
    /** Load the mirrors (the tables are authoritative once 0018 is recorded; nothing is imported from memory). */
    attach() { if (!signingsFollowUpsLive(sqlite)) throw new Error(`the signings/follow-ups repository needs ${SIGNINGS_FOLLOWUPS_MIGRATION} recorded; it never imports an in-memory array`); reload(); const record = sqlite.prepare('SELECT value FROM meta WHERE key = ?').get(SIGNINGS_FOLLOWUPS_CUTOVER_META)?.value ?? null; return { counts: this.counts(), cutover: record ? JSON.parse(record) : null }; },
    /** The store participant: no flush (every write is already in the tables); the mirrors restored by the unit's rollback. */
    hook() { return { flush() {}, snapshotState() { return Object.fromEntries(SIGNINGS_FOLLOWUPS_COLLECTIONS.map((n) => [n, mirrors[n].slice()])); }, restoreState(s) { if (!s) return; for (const n of SIGNINGS_FOLLOWUPS_COLLECTIONS) { mirrors[n].length = 0; for (const r of s[n]) mirrors[n].push(r); } } }; },
    counts() { return Object.fromEntries(SIGNINGS_FOLLOWUPS_COLLECTIONS.map((n) => [n, mirrors[n].length])); },
    pending: () => 0,
    exportAll() { return Object.fromEntries(SIGNINGS_FOLLOWUPS_COLLECTIONS.map((n) => [n, clone(mirrors[n])])); },
    log,
    now,
  };
}
