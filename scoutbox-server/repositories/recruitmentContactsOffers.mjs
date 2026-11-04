/**
 * Recruitment contacts and offers as typed tables with EXPLICIT writes (migration `0017_recruitment_contacts_offers`,
 * docs/architecture/migration.md §4.3; the S8d repository, repositories/signingsFollowUps.mjs, is the template).
 *
 * Tables (file 02):
 *   recruitment_contacts, contact_attempts, contact_history                      → db.recruitmentContacts
 *   recruitment_offers, offer_revisions, offer_revision_documents, offer_responses,
 *   offer_read_receipts, offer_history, offer_keys                               → db.recruitmentOffers
 *
 * EVERY FIELD IS A TYPED COLUMN with the vocabulary and length CHECKs of the domain rules (domains/recruitment/lifecycle/contact.mjs,
 * domains/recruitment/offers/offer.mjs). There is no `absent_keys_json`, `offtype_json`, `extra_json` or `raw_json`. A record the columns
 * cannot hold — an unknown field at any level included — is REFUSED with its id, at a repository write (the unit
 * rolls back) and at a snapshot write (the save rolls back). The idempotency keys are columns of their owner
 * (`create_key`, `send_key`, …) and the offer's per-act key lists the rows of `offer_keys`.
 *
 * EXPLICIT WRITES, SQL READS. There is no in-memory mirror and no `db.<collection>` view (§4.3 step 2): readers
 * call the repository's queries (`contacts.byId`, `contacts.forCase`, `offers.forPlayers`, …), and every record they
 * get is a fresh, deep-frozen decode, so an in-place edit throws. A route changes a record by calling an operation:
 * `contacts.create(record)`, `contacts.update(id, (draft) => { … })`, `offers.create`, `offers.update`, and the
 * deletion unit's `redactPlayer`. `update` hands the caller a plain copy to change, types the result whole, writes
 * the record's rows at once and returns it read back from the tables. An operation joins the open unit of work
 * (store.unit) or runs a transaction of its own.
 *
 * References. `org_id` → orgs and `case_id` → recruitment_cases (RESTRICT). A contact's `request_id` →
 * recruitment_requests is DEFERRABLE INITIALLY DEFERRED (checked at COMMIT): a send writes its contact before the
 * request row it names. Staff ids →
 * org_users. Player ids: no key, tolerant and counted (Q8c-a). Guardian ids: no key; a snapshot write naming a
 * guardian that is not in the final guardians table is refused (Q8c-b). The offer's own pointers (current revision,
 * response, supersedes, superseded by, discarded by, a receipt's or response's revision) must name a row of the
 * same offer.
 *
 * Refusals name tables, fields and ids — never a subject, a body, a note, a message or a name.
 */
import { transaction, migrationApplied, newestHistory } from './database.mjs';
import { isPlainObject, ids, tableExists } from './recruitment.mjs';
import { CONTACT_STATUSES, CONTACT_CHANNELS, CONTACT_MODES, CONTACT_LIMITS, RESPONSE_KINDS } from '../domains/recruitment/lifecycle/contact.mjs';
import { OFFER_STATUSES, OFFER_TYPES, OFFER_LIMITS, OFFER_RESPONSE_TYPES, OFFER_RESPONSE_ACTORS } from '../domains/recruitment/offers/offer.mjs';

export const RECRUITMENT_CONTACTS_OFFERS_MIGRATION = '0017_recruitment_contacts_offers';
export const RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS = Object.freeze(['recruitmentContacts', 'recruitmentOffers']);
export const RECRUITMENT_CONTACTS_OFFERS_TABLES = Object.freeze(['recruitment_contacts', 'contact_attempts', 'contact_history', 'recruitment_offers', 'offer_revisions', 'offer_revision_documents', 'offer_responses', 'offer_read_receipts', 'offer_history', 'offer_keys']);
export const recruitmentContactsOffersLive = (sqlite) => migrationApplied(sqlite, RECRUITMENT_CONTACTS_OFFERS_MIGRATION);

const CHANNELS = Object.keys(CONTACT_CHANNELS);
const RECIPIENT_TYPES = ['player', 'guardian'];
const EMAIL_COPY_STATES = ['queued', 'not_available', 'local_outbox', 'accepted_by_provider', 'failed'];
const CONTACT_ACTOR_KINDS = ['org', 'player', 'guardian'];
const OFFER_ACTOR_KINDS = ['org', 'player', 'guardian', 'admin', 'system'];
const OFFER_KEY_LISTS = ['issue', 'withdraw', 'revise'];

// ------------------------------------------------------------------ DDL
const inList = (col, list) => `CHECK (${col} IS NULL OR ${col} IN (${list.map((v) => `'${v}'`).join(',')}))`;
const maxLen = (col, n) => `CHECK (${col} IS NULL OR length(${col}) <= ${n})`;
const bool = (col) => `CHECK (${col} IS NULL OR ${col} IN (0,1))`;
const staff = (p) => `  ${p}_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,\n  ${p}_name TEXT`;
const orgActor = (p) => `${staff(p)},\n  ${p}_role TEXT`;

export const RECRUITMENT_CONTACTS_OFFERS_DDL = `
CREATE TABLE recruitment_contacts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  case_id TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE RESTRICT,
  player_id TEXT NOT NULL,
  status TEXT NOT NULL ${inList('status', CONTACT_STATUSES)},
  channel TEXT NOT NULL ${inList('channel', CHANNELS)},
  contact_mode TEXT NOT NULL ${inList('contact_mode', CONTACT_MODES)},
  recipient_type TEXT ${inList('recipient_type', RECIPIENT_TYPES)},
  recipient_player_id TEXT,
  recipient_guardian_id TEXT,
  recipient_minor INTEGER ${bool('recipient_minor')},
  routing_at INTEGER,
  routing_mode TEXT ${inList('routing_mode', CONTACT_MODES)},
  routing_player INTEGER ${bool('routing_player')},
  routing_guardian INTEGER ${bool('routing_guardian')},
  routing_agent_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  routing_agent_agreement_id TEXT,
  routing_honest TEXT,
  subject TEXT ${maxLen('subject', CONTACT_LIMITS.subject)},
  body TEXT ${maxLen('body', CONTACT_LIMITS.body)},
  summary TEXT ${maxLen('summary', CONTACT_LIMITS.summary)},
  created_by_user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  created_by_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
${staff('sent_by')},
  sent_at INTEGER,
  delivered_at INTEGER,
  failed_at INTEGER,
  failure_code TEXT,
  request_id TEXT REFERENCES recruitment_requests(id) DEFERRABLE INITIALLY DEFERRED,
  email_copy_state TEXT ${inList('email_copy_state', EMAIL_COPY_STATES)},
  email_copy_to TEXT ${inList('email_copy_to', ['guardian'])},
  email_copy_outbox_id TEXT,
  email_copy_at INTEGER,
  lifecycle_applied INTEGER ${bool('lifecycle_applied')},
  lifecycle_from TEXT,
  lifecycle_to TEXT,
  lifecycle_reason TEXT,
  lifecycle_at INTEGER,
  occurred_at INTEGER,
${staff('recorded_by')},
  recorded_at INTEGER,
  responded_at INTEGER,
  response_kind TEXT ${inList('response_kind', RESPONSE_KINDS)},
  response_message TEXT ${maxLen('response_message', CONTACT_LIMITS.replyMessage)},
  response_by TEXT ${inList('response_by', RECIPIENT_TYPES)},
  response_at INTEGER,
  cancelled_at INTEGER,
${staff('cancelled_by')},
  create_key TEXT,
  create_fp TEXT,
  send_key TEXT,
  send_fp TEXT,
  record_key TEXT,
  record_fp TEXT,
  rev INTEGER NOT NULL CHECK (rev >= 0),
  rev_at INTEGER,
  rev_by_user_id TEXT,
  rev_by_name TEXT,
  policy_version INTEGER NOT NULL,
  CHECK ((recipient_type IS NULL) = (recipient_minor IS NULL)),
  CHECK ((routing_at IS NULL) = (routing_mode IS NULL)),
  CHECK ((email_copy_state IS NULL) = (email_copy_to IS NULL)),
  CHECK ((response_kind IS NULL) = (response_by IS NULL)),
  CHECK (send_key IS NULL OR send_fp IS NOT NULL)
) STRICT;
CREATE INDEX recruitment_contacts_case_org ON recruitment_contacts (case_id, org_id);
CREATE INDEX recruitment_contacts_org_player ON recruitment_contacts (org_id, player_id);
CREATE INDEX recruitment_contacts_request ON recruitment_contacts (request_id);
CREATE INDEX recruitment_contacts_routing_agent ON recruitment_contacts (routing_agent_user_id);
CREATE INDEX recruitment_contacts_player ON recruitment_contacts (player_id);
CREATE TABLE contact_attempts (
  contact_id TEXT NOT NULL REFERENCES recruitment_contacts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL ${bool('ok')},
  code TEXT,
  PRIMARY KEY (contact_id, position)
) STRICT;
CREATE TABLE contact_history (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES recruitment_contacts(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,
  by_kind TEXT ${inList('by_kind', CONTACT_ACTOR_KINDS)},
  by_user_id TEXT,
  by_name TEXT,
  detail_json TEXT CHECK (detail_json IS NULL OR json_type(detail_json) = 'object'),
  UNIQUE (contact_id, position)
) STRICT;
CREATE INDEX contact_history_contact_at ON contact_history (contact_id, at);
CREATE TABLE recruitment_offers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  case_id TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE RESTRICT,
  player_id TEXT NOT NULL,
  type TEXT NOT NULL ${inList('type', OFFER_TYPES)},
  decision_id TEXT,
  transaction_id TEXT,
  status TEXT NOT NULL ${inList('status', OFFER_STATUSES)},
  current_revision_id TEXT NOT NULL,
  agent_share_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  agent_share_agreement_id TEXT,
  agent_share_at INTEGER,
  agent_share_by_kind TEXT ${inList('agent_share_by_kind', ['player'])},
  agent_share_by_id TEXT,
  create_key TEXT,
  create_fp TEXT,
  lifecycle_applied INTEGER ${bool('lifecycle_applied')},
  lifecycle_action TEXT,
  lifecycle_reason TEXT,
  lifecycle_message TEXT,
  lifecycle_allowed_json TEXT CHECK (lifecycle_allowed_json IS NULL OR json_type(lifecycle_allowed_json) = 'array'),
  lifecycle_from TEXT,
  lifecycle_to TEXT,
  lifecycle_at INTEGER,
  created_at INTEGER NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  created_by_name TEXT,
  created_by_role TEXT,
  updated_at INTEGER NOT NULL,
  rev INTEGER NOT NULL CHECK (rev >= 1),
  rev_at INTEGER,
  rev_by_user_id TEXT,
  rev_by_name TEXT,
  policy_version INTEGER NOT NULL,
  subject_removed_at INTEGER,
  CHECK ((agent_share_user_id IS NULL) = (agent_share_at IS NULL)),
  CHECK ((create_key IS NULL) = (create_fp IS NULL))
) STRICT;
CREATE INDEX recruitment_offers_case_org ON recruitment_offers (case_id, org_id);
CREATE INDEX recruitment_offers_org_player ON recruitment_offers (org_id, player_id);
CREATE INDEX recruitment_offers_agent_share ON recruitment_offers (agent_share_user_id);
CREATE INDEX recruitment_offers_decision ON recruitment_offers (decision_id);
CREATE INDEX recruitment_offers_player ON recruitment_offers (player_id);
CREATE TABLE offer_revisions (
  id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL REFERENCES recruitment_offers(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
  status TEXT NOT NULL ${inList('status', OFFER_STATUSES)},
  term_offer_type TEXT NOT NULL ${inList('term_offer_type', OFFER_TYPES)},
  term_role TEXT ${maxLen('term_role', OFFER_LIMITS.role)},
  term_squad TEXT ${maxLen('term_squad', OFFER_LIMITS.squad)},
  term_start_date TEXT CHECK (term_start_date IS NULL OR length(term_start_date) = 10),
  term_end_date TEXT CHECK (term_end_date IS NULL OR length(term_end_date) = 10),
  term_conditions TEXT ${maxLen('term_conditions', OFFER_LIMITS.conditions)},
  recipient_message TEXT ${maxLen('recipient_message', OFFER_LIMITS.recipientMessage)},
  internal_note TEXT ${maxLen('internal_note', OFFER_LIMITS.internalNote)},
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
${orgActor('created_by')},
  updated_at INTEGER NOT NULL,
${orgActor('updated_by')},
  issued_at INTEGER,
${orgActor('issued_by')},
  withdrawn_at INTEGER,
${orgActor('withdrawn_by')},
  withdraw_reason TEXT ${maxLen('withdraw_reason', OFFER_LIMITS.withdrawReason)},
  responded_at INTEGER,
  response_id TEXT,
  supersedes_revision_id TEXT,
  superseded_by_revision_id TEXT,
  superseded_at INTEGER,
  recipient_type TEXT ${inList('recipient_type', RECIPIENT_TYPES)},
  recipient_player_id TEXT,
  recipient_guardian_id TEXT,
  recipient_minor INTEGER ${bool('recipient_minor')},
  recipient_at INTEGER,
  readiness_transaction_id TEXT,
  readiness_evaluated_at INTEGER,
  readiness_status TEXT,
  readiness_blockers_json TEXT CHECK (readiness_blockers_json IS NULL OR json_type(readiness_blockers_json) = 'array'),
  rev INTEGER NOT NULL CHECK (rev >= 1),
  rev_at INTEGER,
  rev_by_user_id TEXT,
  rev_by_name TEXT,
  discarded_by_response_id TEXT,
  CHECK ((recipient_type IS NULL) = (recipient_at IS NULL)),
  UNIQUE (offer_id, revision_number),
  UNIQUE (offer_id, position)
) STRICT;
CREATE INDEX offer_revisions_offer_status ON offer_revisions (offer_id, status);
CREATE TABLE offer_revision_documents (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES offer_revisions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  evidence_id TEXT NOT NULL,
  label TEXT ${maxLen('label', OFFER_LIMITS.documentLabel)},
  mime TEXT,
  bytes INTEGER,
  UNIQUE (revision_id, position)
) STRICT;
CREATE TABLE offer_responses (
  id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL REFERENCES recruitment_offers(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  revision_id TEXT NOT NULL,
  response_type TEXT NOT NULL ${inList('response_type', OFFER_RESPONSE_TYPES)},
  actor_type TEXT NOT NULL ${inList('actor_type', OFFER_RESPONSE_ACTORS)},
  actor_id TEXT NOT NULL,
  actor_name TEXT,
  for_player_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  reason TEXT ${maxLen('reason', OFFER_LIMITS.declineReason)},
  client_key TEXT,
  UNIQUE (offer_id, revision_id),
  UNIQUE (offer_id, position)
) STRICT;
CREATE UNIQUE INDEX offer_responses_offer_client_key ON offer_responses (offer_id, client_key) WHERE client_key IS NOT NULL;
CREATE TABLE offer_read_receipts (
  offer_id TEXT NOT NULL REFERENCES recruitment_offers(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  revision_id TEXT NOT NULL,
  viewer_kind TEXT NOT NULL ${inList('viewer_kind', RECIPIENT_TYPES)},
  viewer_id TEXT NOT NULL,
  first_viewed_at INTEGER NOT NULL,
  PRIMARY KEY (offer_id, position),
  UNIQUE (offer_id, revision_id, viewer_kind, viewer_id)
) STRICT;
CREATE TABLE offer_history (
  id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL REFERENCES recruitment_offers(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,
  by_kind TEXT ${inList('by_kind', OFFER_ACTOR_KINDS)},
  by_id TEXT,
  by_name TEXT,
  detail_json TEXT CHECK (detail_json IS NULL OR json_type(detail_json) = 'object'),
  UNIQUE (offer_id, position)
) STRICT;
CREATE INDEX offer_history_offer_at ON offer_history (offer_id, at);
CREATE TABLE offer_keys (
  offer_id TEXT NOT NULL REFERENCES recruitment_offers(id) ON DELETE CASCADE,
  act TEXT NOT NULL ${inList('act', OFFER_KEY_LISTS)},
  position INTEGER NOT NULL,
  key TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  PRIMARY KEY (offer_id, act, position)
) STRICT;
CREATE INDEX offer_keys_key ON offer_keys (offer_id, act, key);
`;

// ------------------------------------------------------------------ typing (the one place a value is judged)
const refusal = (code, message, extra = {}) => Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
const isInt = (v) => Number.isSafeInteger(v);
const isStr = (v) => typeof v === 'string';
const nonEmpty = (v) => isStr(v) && v.length > 0;
const orNull = (v) => (v === undefined ? null : v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const describe = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : typeof v);
const dateOnly = (v) => isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** A typing failure carries `reason` (record, field, what it holds — never the value of a text field). */
class Bad extends Error {}
const fail = (label, field, what) => { throw new Bad(`${label}.${field} ${what}`); };
/** Refuse an own key the table has no column for: a value the routes write but the tables would drop is a lost value. */
function onlyKeys(v, keys, label, field) {
  if (!isPlainObject(v)) fail(label, field, `must be an object (got ${describe(v)})`);
  for (const k of Object.keys(v)) if (!keys.includes(k)) fail(label, `${field}.${k}`, 'is not a field this table stores');
  return v;
}
const str = (v, label, field, { max = null, required = false } = {}) => {
  if (v === undefined || v === null) { if (required) fail(label, field, 'is required'); return null; }
  if (!isStr(v)) fail(label, field, `must be text or null (got ${describe(v)})`);
  if (required && v.length === 0) fail(label, field, 'must not be empty');
  if (max !== null && v.length > max) fail(label, field, `exceeds ${max} characters`);
  return v;
};
const int = (v, label, field, { required = false, min = null } = {}) => {
  if (v === undefined || v === null) { if (required) fail(label, field, 'is required'); return null; }
  if (!isInt(v)) fail(label, field, `must be an integer or null (got ${describe(v)})`);
  if (min !== null && v < min) fail(label, field, `must be at least ${min}`);
  return v;
};
const flag = (v, label, field, { required = false } = {}) => {
  if (v === undefined || v === null) { if (required) fail(label, field, 'is required'); return null; }
  if (typeof v !== 'boolean') fail(label, field, `must be true or false (got ${describe(v)})`);
  return v;
};
const oneOf = (v, list, label, field, { required = true } = {}) => {
  if ((v === undefined || v === null) && !required) return null;
  if (!list.includes(v)) fail(label, field, `must be one of ${list.join('|')} (got ${describe(v)})`);
  return v;
};
const list = (v, label, field) => { if (v === undefined || v === null) return []; if (!Array.isArray(v)) fail(label, field, `must be a list (got ${describe(v)})`); return v; };
const detail = (v, label, field) => { if (v === undefined || v === null) return null; if (!isPlainObject(v)) fail(label, field, 'must be an object or null'); return clone(v); };
const revBy = (v, label) => { if (v === undefined || v === null) return null; onlyKeys(v, ['userId', 'name'], label, 'revBy'); return { userId: str(v.userId, label, 'revBy.userId'), name: str(v.name, label, 'revBy.name') }; };
/** contactRoutes.mjs actorOf(req): `{kind:'org', userId, name}`. */
const contactStaff = (v, label, field, { required = false } = {}) => {
  if (v === undefined || v === null) { if (required) fail(label, field, 'is required'); return null; }
  onlyKeys(v, ['kind', 'userId', 'name'], label, field);
  oneOf(v.kind, ['org'], label, `${field}.kind`);
  return { kind: 'org', userId: str(v.userId, label, `${field}.userId`, { required: true }), name: str(v.name, label, `${field}.name`) };
};
/** m28 byOrg(req): `{kind:'org', id, name, role}`. */
const offerStaff = (v, label, field, { required = false } = {}) => {
  if (v === undefined || v === null) { if (required) fail(label, field, 'is required'); return null; }
  onlyKeys(v, ['kind', 'id', 'name', 'role'], label, field);
  oneOf(v.kind, ['org'], label, `${field}.kind`);
  return { kind: 'org', id: str(v.id, label, `${field}.id`, { required: true }), name: str(v.name, label, `${field}.name`), role: str(v.role, label, `${field}.role`) };
};

function typeContactHistory(h, label) {
  onlyKeys(h, ['id', 'at', 'action', 'by', 'detail'], label, 'entry');
  let by = null;
  if (h.by !== undefined && h.by !== null) {
    onlyKeys(h.by, ['kind', 'userId', 'name'], label, 'by');
    const kind = oneOf(h.by.kind, CONTACT_ACTOR_KINDS, label, 'by.kind');
    by = kind === 'org' ? { kind, userId: str(h.by.userId, label, 'by.userId'), name: str(h.by.name, label, 'by.name') } : { kind, name: str(h.by.name, label, 'by.name') };
    if (kind !== 'org' && h.by.userId !== undefined) fail(label, 'by.userId', 'is only stored for a staff actor');
  }
  return { id: str(h.id, label, 'id', { required: true }), at: int(h.at, label, 'at', { required: true }), action: str(h.action, label, 'action', { required: true }), by, detail: detail(h.detail, label, 'detail') };
}

const CONTACT_KEYS = ['id', 'orgId', 'caseId', 'playerId', 'status', 'channel', 'recipient', 'contactMode', 'routingSnapshot', 'subject', 'body', 'summary', 'createdBy', 'createdAt', 'updatedAt', 'sentBy', 'sentAt', 'deliveredAt', 'failedAt', 'failureCode', 'attempts', 'requestId', 'emailCopy', 'lifecycle', 'occurredAt', 'recordedBy', 'recordedAt', 'respondedAt', 'response', 'cancelledAt', 'cancelledBy', 'keys', 'history', 'rev', 'revAt', 'revBy', 'policyVersion'];

/** A contact as the routes write it, typed. Returns `{ ok: true, record }` or `{ ok: false, reason }`. */
export function typeContact(raw, at = 'recruitmentContacts') {
  try {
    if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
    if (!nonEmpty(raw.id)) return { ok: false, reason: `${at}.id must be a non-empty string` };
    const L = `${at} ${raw.id}`;
    onlyKeys(raw, CONTACT_KEYS, L, 'record');
    const recipient = raw.recipient === undefined || raw.recipient === null ? null : (() => {
      const r = onlyKeys(raw.recipient, ['type', 'playerId', 'guardianId', 'minor'], L, 'recipient');
      return { type: oneOf(r.type, RECIPIENT_TYPES, L, 'recipient.type'), playerId: str(r.playerId, L, 'recipient.playerId'), guardianId: str(r.guardianId, L, 'recipient.guardianId'), minor: flag(r.minor, L, 'recipient.minor', { required: true }) };
    })();
    const routingSnapshot = raw.routingSnapshot === undefined || raw.routingSnapshot === null ? null : (() => {
      const r = onlyKeys(raw.routingSnapshot, ['at', 'mode', 'player', 'guardian', 'agent', 'honest'], L, 'routingSnapshot');
      let agent = null;
      if (r.agent !== undefined && r.agent !== null) {
        onlyKeys(r.agent, ['agentUserId', 'agreementId'], L, 'routingSnapshot.agent');
        agent = { agentUserId: str(r.agent.agentUserId, L, 'routingSnapshot.agent.agentUserId', { required: true }), agreementId: str(r.agent.agreementId, L, 'routingSnapshot.agent.agreementId') };
      }
      return { at: int(r.at, L, 'routingSnapshot.at', { required: true }), mode: oneOf(r.mode, CONTACT_MODES, L, 'routingSnapshot.mode'), player: flag(r.player, L, 'routingSnapshot.player', { required: true }), guardian: flag(r.guardian, L, 'routingSnapshot.guardian', { required: true }), agent, honest: str(r.honest, L, 'routingSnapshot.honest') };
    })();
    const attempts = list(raw.attempts, L, 'attempts').map((a, i) => { onlyKeys(a, ['at', 'ok', 'code'], L, `attempts[${i}]`); return { at: int(a.at, L, `attempts[${i}].at`, { required: true }), ok: flag(a.ok, L, `attempts[${i}].ok`, { required: true }), code: str(a.code, L, `attempts[${i}].code`) }; });
    const emailCopy = raw.emailCopy === undefined || raw.emailCopy === null ? null : (() => {
      const e = onlyKeys(raw.emailCopy, ['state', 'to', 'outboxId', 'at'], L, 'emailCopy');
      return { state: oneOf(e.state, EMAIL_COPY_STATES, L, 'emailCopy.state'), to: oneOf(e.to, ['guardian'], L, 'emailCopy.to'), outboxId: str(e.outboxId, L, 'emailCopy.outboxId'), at: int(e.at, L, 'emailCopy.at') };
    })();
    const lifecycle = raw.lifecycle === undefined || raw.lifecycle === null ? null : (() => {
      const c = onlyKeys(raw.lifecycle, ['applied', 'from', 'to', 'at', 'reason'], L, 'lifecycle');
      const applied = flag(c.applied, L, 'lifecycle.applied', { required: true });
      if (applied) { if (c.reason !== undefined) fail(L, 'lifecycle.reason', 'is not stored on an applied move'); return { applied, from: str(c.from, L, 'lifecycle.from'), to: str(c.to, L, 'lifecycle.to'), at: int(c.at, L, 'lifecycle.at') }; }
      if (c.from !== undefined || c.to !== undefined) fail(L, 'lifecycle.from', 'is not stored on a move that was not applied');
      return { applied, reason: str(c.reason, L, 'lifecycle.reason'), at: int(c.at, L, 'lifecycle.at') };
    })();
    const response = raw.response === undefined || raw.response === null ? null : (() => {
      const r = onlyKeys(raw.response, ['kind', 'message', 'by', 'at'], L, 'response');
      return { kind: oneOf(r.kind, RESPONSE_KINDS, L, 'response.kind'), message: str(r.message, L, 'response.message', { max: CONTACT_LIMITS.replyMessage }), by: oneOf(r.by, RECIPIENT_TYPES, L, 'response.by'), at: int(r.at, L, 'response.at') };
    })();
    const keys = raw.keys === undefined || raw.keys === null ? { create: null, send: null, record: null } : (() => {
      onlyKeys(raw.keys, ['create', 'send', 'record'], L, 'keys');
      const one = (act) => { const k = raw.keys[act]; if (k === undefined || k === null) return null; onlyKeys(k, ['key', 'fp'], L, `keys.${act}`); return { key: str(k.key, L, `keys.${act}.key`, { required: act !== 'send' }), fp: str(k.fp, L, `keys.${act}.fp`, { required: true }) }; };
      return { create: one('create'), send: one('send'), record: one('record') };
    })();
    const history = list(raw.history, L, 'history').map((h, i) => typeContactHistory(h, `${L} history[${i}]`));
    const record = {
      id: raw.id, orgId: str(raw.orgId, L, 'orgId', { required: true }), caseId: str(raw.caseId, L, 'caseId', { required: true }), playerId: str(raw.playerId, L, 'playerId', { required: true }),
      status: oneOf(raw.status, CONTACT_STATUSES, L, 'status'), channel: oneOf(raw.channel, CHANNELS, L, 'channel'), recipient,
      contactMode: oneOf(raw.contactMode, CONTACT_MODES, L, 'contactMode'), routingSnapshot,
      subject: str(raw.subject, L, 'subject', { max: CONTACT_LIMITS.subject }), body: str(raw.body, L, 'body', { max: CONTACT_LIMITS.body }), summary: str(raw.summary, L, 'summary', { max: CONTACT_LIMITS.summary }),
      createdBy: contactStaff(raw.createdBy, L, 'createdBy', { required: true }), createdAt: int(raw.createdAt, L, 'createdAt', { required: true }), updatedAt: int(raw.updatedAt, L, 'updatedAt', { required: true }),
      sentBy: contactStaff(raw.sentBy, L, 'sentBy'), sentAt: int(raw.sentAt, L, 'sentAt'), deliveredAt: int(raw.deliveredAt, L, 'deliveredAt'), failedAt: int(raw.failedAt, L, 'failedAt'), failureCode: str(raw.failureCode, L, 'failureCode'),
      attempts, requestId: str(raw.requestId, L, 'requestId'), emailCopy, lifecycle,
      occurredAt: int(raw.occurredAt, L, 'occurredAt'), recordedBy: contactStaff(raw.recordedBy, L, 'recordedBy'), recordedAt: int(raw.recordedAt, L, 'recordedAt'),
      respondedAt: int(raw.respondedAt, L, 'respondedAt'), response, cancelledAt: int(raw.cancelledAt, L, 'cancelledAt'), cancelledBy: contactStaff(raw.cancelledBy, L, 'cancelledBy'),
      keys, history, rev: int(raw.rev, L, 'rev', { required: true, min: 0 }), revAt: int(raw.revAt, L, 'revAt'), revBy: revBy(raw.revBy, L), policyVersion: int(raw.policyVersion, L, 'policyVersion', { required: true }),
    };
    if (record.requestId !== null && record.channel !== 'in_app') fail(L, 'requestId', 'is only set on an in-app contact');
    const seen = new Set(); for (const h of history) { if (seen.has(h.id)) fail(L, 'history', `repeats the entry id ${h.id}`); seen.add(h.id); }
    return { ok: true, record };
  } catch (e) { if (e instanceof Bad) return { ok: false, reason: e.message }; throw e; }
}

const REVISION_KEYS = ['id', 'revisionNumber', 'status', 'terms', 'recipientMessage', 'internalNote', 'documents', 'expiresAt', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'issuedAt', 'issuedBy', 'withdrawnAt', 'withdrawnBy', 'withdrawReason', 'respondedAt', 'response', 'supersedesRevisionId', 'supersededByRevisionId', 'supersededAt', 'recipientSnapshot', 'readinessSnapshot', 'rev', 'revAt', 'revBy', 'discardedByResponseId'];
function typeRevision(r, L) {
  onlyKeys(r, REVISION_KEYS, L, 'revision');
  const t = onlyKeys(r.terms, ['offerType', 'role', 'squad', 'startDate', 'endDate', 'conditions'], L, 'terms');
  for (const k of ['startDate', 'endDate']) if (t[k] !== undefined && t[k] !== null && !dateOnly(t[k])) fail(L, `terms.${k}`, 'must be a calendar day (YYYY-MM-DD) or null');
  const terms = { offerType: oneOf(t.offerType, OFFER_TYPES, L, 'terms.offerType'), role: str(t.role, L, 'terms.role', { max: OFFER_LIMITS.role }), squad: str(t.squad, L, 'terms.squad', { max: OFFER_LIMITS.squad }), startDate: orNull(t.startDate), endDate: orNull(t.endDate), conditions: str(t.conditions, L, 'terms.conditions', { max: OFFER_LIMITS.conditions }) };
  const documents = list(r.documents, L, 'documents').map((d, i) => { onlyKeys(d, ['id', 'evidenceId', 'label', 'mime', 'bytes'], L, `documents[${i}]`); return { id: str(d.id, L, `documents[${i}].id`, { required: true }), evidenceId: str(d.evidenceId, L, `documents[${i}].evidenceId`, { required: true }), label: str(d.label, L, `documents[${i}].label`, { max: OFFER_LIMITS.documentLabel }), mime: str(d.mime, L, `documents[${i}].mime`), bytes: int(d.bytes, L, `documents[${i}].bytes`) }; });
  const response = r.response === undefined || r.response === null ? null : (onlyKeys(r.response, ['id'], L, 'response'), { id: str(r.response.id, L, 'response.id', { required: true }) });
  const recipientSnapshot = r.recipientSnapshot === undefined || r.recipientSnapshot === null ? null : (() => {
    const s = onlyKeys(r.recipientSnapshot, ['type', 'playerId', 'guardianId', 'minor', 'at'], L, 'recipientSnapshot');
    return { type: oneOf(s.type, RECIPIENT_TYPES, L, 'recipientSnapshot.type'), playerId: str(s.playerId, L, 'recipientSnapshot.playerId'), guardianId: str(s.guardianId, L, 'recipientSnapshot.guardianId'), minor: flag(s.minor, L, 'recipientSnapshot.minor', { required: true }), at: int(s.at, L, 'recipientSnapshot.at', { required: true }) };
  })();
  const readinessSnapshot = r.readinessSnapshot === undefined || r.readinessSnapshot === null ? null : (() => {
    const s = onlyKeys(r.readinessSnapshot, ['transactionId', 'evaluatedAt', 'status', 'blockers'], L, 'readinessSnapshot');
    return { transactionId: str(s.transactionId, L, 'readinessSnapshot.transactionId'), evaluatedAt: int(s.evaluatedAt, L, 'readinessSnapshot.evaluatedAt'), status: str(s.status, L, 'readinessSnapshot.status'), blockers: list(s.blockers, L, 'readinessSnapshot.blockers').map((b, i) => str(b, L, `readinessSnapshot.blockers[${i}]`, { required: true })) };
  })();
  const out = {
    id: str(r.id, L, 'id', { required: true }), revisionNumber: int(r.revisionNumber, L, 'revisionNumber', { required: true, min: 1 }), status: oneOf(r.status, OFFER_STATUSES, L, 'status'), terms,
    recipientMessage: str(r.recipientMessage, L, 'recipientMessage', { max: OFFER_LIMITS.recipientMessage }), internalNote: str(r.internalNote, L, 'internalNote', { max: OFFER_LIMITS.internalNote }), documents,
    expiresAt: int(r.expiresAt, L, 'expiresAt'), createdAt: int(r.createdAt, L, 'createdAt', { required: true }), createdBy: offerStaff(r.createdBy, L, 'createdBy', { required: true }),
    updatedAt: int(r.updatedAt, L, 'updatedAt', { required: true }), updatedBy: offerStaff(r.updatedBy, L, 'updatedBy'),
    issuedAt: int(r.issuedAt, L, 'issuedAt'), issuedBy: offerStaff(r.issuedBy, L, 'issuedBy'), withdrawnAt: int(r.withdrawnAt, L, 'withdrawnAt'), withdrawnBy: offerStaff(r.withdrawnBy, L, 'withdrawnBy'),
    withdrawReason: str(r.withdrawReason, L, 'withdrawReason', { max: OFFER_LIMITS.withdrawReason }), respondedAt: int(r.respondedAt, L, 'respondedAt'), response,
    supersedesRevisionId: str(r.supersedesRevisionId, L, 'supersedesRevisionId'), supersededByRevisionId: str(r.supersededByRevisionId, L, 'supersededByRevisionId'), supersededAt: int(r.supersededAt, L, 'supersededAt'),
    recipientSnapshot, readinessSnapshot, rev: int(r.rev, L, 'rev', { required: true, min: 1 }), revAt: int(r.revAt, L, 'revAt'), revBy: revBy(r.revBy, L),
  };
  // Present only on a draft an acceptance discarded (m28 respondHandler); every other revision has no such key.
  const discarded = str(r.discardedByResponseId, L, 'discardedByResponseId');
  if (discarded !== null) out.discardedByResponseId = discarded;
  return out;
}

const OFFER_KEYS = ['id', 'orgId', 'caseId', 'playerId', 'type', 'decisionId', 'transactionId', 'status', 'currentRevisionId', 'revisions', 'responses', 'readReceipts', 'agentShare', 'keys', 'lifecycle', 'history', 'createdAt', 'createdBy', 'updatedAt', 'rev', 'revAt', 'revBy', 'policyVersion', 'subjectRemovedAt'];

/** An offer as the routes write it, typed, with every pointer resolved inside the offer. `{ ok, record }` or `{ ok: false, reason }`. */
export function typeOffer(raw, at = 'recruitmentOffers') {
  try {
    if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
    if (!nonEmpty(raw.id)) return { ok: false, reason: `${at}.id must be a non-empty string` };
    const L = `${at} ${raw.id}`;
    onlyKeys(raw, OFFER_KEYS, L, 'record');
    const revisions = list(raw.revisions, L, 'revisions').map((r, i) => typeRevision(r, `${L} revisions[${i}]`));
    if (revisions.length === 0) fail(L, 'revisions', 'must hold at least one revision');
    const responses = list(raw.responses, L, 'responses').map((x, i) => {
      const P = `${L} responses[${i}]`;
      onlyKeys(x, ['id', 'revisionId', 'responseType', 'actorType', 'actorId', 'actorName', 'forPlayerId', 'occurredAt', 'reason', 'clientKey'], P, 'response');
      return { id: str(x.id, P, 'id', { required: true }), revisionId: str(x.revisionId, P, 'revisionId', { required: true }), responseType: oneOf(x.responseType, OFFER_RESPONSE_TYPES, P, 'responseType'), actorType: oneOf(x.actorType, OFFER_RESPONSE_ACTORS, P, 'actorType'), actorId: str(x.actorId, P, 'actorId', { required: true }), actorName: str(x.actorName, P, 'actorName'), forPlayerId: str(x.forPlayerId, P, 'forPlayerId', { required: true }), occurredAt: int(x.occurredAt, P, 'occurredAt', { required: true }), reason: str(x.reason, P, 'reason', { max: OFFER_LIMITS.declineReason }), clientKey: str(x.clientKey, P, 'clientKey') };
    });
    const readReceipts = list(raw.readReceipts, L, 'readReceipts').map((x, i) => {
      const P = `${L} readReceipts[${i}]`;
      onlyKeys(x, ['revisionId', 'viewerKind', 'viewerId', 'firstViewedAt'], P, 'receipt');
      return { revisionId: str(x.revisionId, P, 'revisionId', { required: true }), viewerKind: oneOf(x.viewerKind, RECIPIENT_TYPES, P, 'viewerKind'), viewerId: str(x.viewerId, P, 'viewerId', { required: true }), firstViewedAt: int(x.firstViewedAt, P, 'firstViewedAt', { required: true }) };
    });
    const agentShare = raw.agentShare === undefined || raw.agentShare === null ? null : (() => {
      const s = onlyKeys(raw.agentShare, ['agentUserId', 'agreementId', 'at', 'by'], L, 'agentShare');
      onlyKeys(s.by, ['kind', 'id'], L, 'agentShare.by');
      return { agentUserId: str(s.agentUserId, L, 'agentShare.agentUserId', { required: true }), agreementId: str(s.agreementId, L, 'agentShare.agreementId'), at: int(s.at, L, 'agentShare.at', { required: true }), by: { kind: oneOf(s.by.kind, ['player'], L, 'agentShare.by.kind'), id: str(s.by.id, L, 'agentShare.by.id', { required: true }) } };
    })();
    const keys = (() => {
      const k = raw.keys === undefined || raw.keys === null ? {} : onlyKeys(raw.keys, ['create', ...OFFER_KEY_LISTS], L, 'keys');
      let create = null;
      if (k.create !== undefined && k.create !== null) { onlyKeys(k.create, ['key', 'fp'], L, 'keys.create'); create = { key: str(k.create.key, L, 'keys.create.key', { required: true }), fp: str(k.create.fp, L, 'keys.create.fp', { required: true }) }; }
      const out = { create };
      for (const act of OFFER_KEY_LISTS) out[act] = list(k[act], L, `keys.${act}`).map((e, i) => { onlyKeys(e, ['key', 'revisionId'], L, `keys.${act}[${i}]`); return { key: str(e.key, L, `keys.${act}[${i}].key`, { required: true }), revisionId: str(e.revisionId, L, `keys.${act}[${i}].revisionId`, { required: true }) }; });
      return out;
    })();
    const lifecycle = raw.lifecycle === undefined || raw.lifecycle === null ? null : (() => {
      const c = onlyKeys(raw.lifecycle, ['applied', 'action', 'reason', 'message', 'allowed', 'from', 'to', 'at'], L, 'lifecycle');
      const out = { applied: flag(c.applied, L, 'lifecycle.applied', { required: true }), action: str(c.action, L, 'lifecycle.action'), from: str(c.from, L, 'lifecycle.from'), to: str(c.to, L, 'lifecycle.to'), at: int(c.at, L, 'lifecycle.at') };
      const reason = str(c.reason, L, 'lifecycle.reason'); const message = str(c.message, L, 'lifecycle.message');
      const allowed = c.allowed === undefined || c.allowed === null ? null : list(c.allowed, L, 'lifecycle.allowed').map((a, i) => str(a, L, `lifecycle.allowed[${i}]`, { required: true }));
      if (reason !== null) out.reason = reason; if (message !== null) out.message = message; if (allowed !== null) out.allowed = allowed;
      return out;
    })();
    const history = list(raw.history, L, 'history').map((h, i) => {
      const P = `${L} history[${i}]`;
      onlyKeys(h, ['id', 'at', 'action', 'by', 'detail'], P, 'entry');
      let by = null;
      if (h.by !== undefined && h.by !== null) { onlyKeys(h.by, ['kind', 'id', 'name'], P, 'by'); by = { kind: oneOf(h.by.kind, OFFER_ACTOR_KINDS, P, 'by.kind'), id: str(h.by.id, P, 'by.id'), name: str(h.by.name, P, 'by.name') }; }
      return { id: str(h.id, P, 'id', { required: true }), at: int(h.at, P, 'at', { required: true }), action: str(h.action, P, 'action', { required: true }), by, detail: detail(h.detail, P, 'detail') };
    });
    const record = {
      id: raw.id, orgId: str(raw.orgId, L, 'orgId', { required: true }), caseId: str(raw.caseId, L, 'caseId', { required: true }), playerId: str(raw.playerId, L, 'playerId', { required: true }),
      type: oneOf(raw.type, OFFER_TYPES, L, 'type'), decisionId: str(raw.decisionId, L, 'decisionId'), transactionId: str(raw.transactionId, L, 'transactionId'), status: oneOf(raw.status, OFFER_STATUSES, L, 'status'),
      currentRevisionId: str(raw.currentRevisionId, L, 'currentRevisionId', { required: true }), revisions, responses, readReceipts, agentShare, keys, lifecycle, history,
      createdAt: int(raw.createdAt, L, 'createdAt', { required: true }), createdBy: offerStaff(raw.createdBy, L, 'createdBy', { required: true }), updatedAt: int(raw.updatedAt, L, 'updatedAt', { required: true }),
      rev: int(raw.rev, L, 'rev', { required: true, min: 1 }), revAt: int(raw.revAt, L, 'revAt'), revBy: revBy(raw.revBy, L), policyVersion: int(raw.policyVersion, L, 'policyVersion', { required: true }),
      subjectRemovedAt: int(raw.subjectRemovedAt, L, 'subjectRemovedAt'),
    };
    // Uniqueness and the pointers, all inside this offer.
    const revIds = new Set(); const nums = new Set(); const respIds = new Set(); const respRevs = new Set(); const docIds = new Set(); const histIds = new Set();
    for (const r of revisions) {
      if (revIds.has(r.id)) fail(L, 'revisions', `repeats the revision id ${r.id}`); revIds.add(r.id);
      if (nums.has(r.revisionNumber)) fail(L, 'revisions', `repeats revision number ${r.revisionNumber}`); nums.add(r.revisionNumber);
      for (const d of r.documents) { if (docIds.has(d.id)) fail(L, 'documents', `repeats the document id ${d.id}`); docIds.add(d.id); }
    }
    for (const x of responses) {
      if (respIds.has(x.id)) fail(L, 'responses', `repeats the response id ${x.id}`); respIds.add(x.id);
      if (respRevs.has(x.revisionId)) fail(L, 'responses', `answer revision ${x.revisionId} twice`); respRevs.add(x.revisionId);
      if (!revIds.has(x.revisionId)) fail(L, `responses ${x.id}.revisionId`, `names ${x.revisionId}, not a revision of this offer`);
    }
    if (!revIds.has(record.currentRevisionId)) fail(L, 'currentRevisionId', `names ${record.currentRevisionId}, not a revision of this offer`);
    for (const r of revisions) {
      for (const [field, target, set] of [['supersedesRevisionId', r.supersedesRevisionId, revIds], ['supersededByRevisionId', r.supersededByRevisionId, revIds], ['response.id', r.response?.id ?? null, respIds], ['discardedByResponseId', r.discardedByResponseId ?? null, respIds]]) {
        if (target !== null && !set.has(target)) fail(L, `revisions ${r.id}.${field}`, `names ${target}, not a row of this offer`);
      }
    }
    const receipts = new Set();
    for (const x of readReceipts) {
      if (!revIds.has(x.revisionId)) fail(L, 'readReceipts', `name ${x.revisionId}, not a revision of this offer`);
      const k = `${x.revisionId}/${x.viewerKind}/${x.viewerId}`; if (receipts.has(k)) fail(L, 'readReceipts', `repeat a receipt for ${x.revisionId}`); receipts.add(k);
    }
    for (const act of OFFER_KEY_LISTS) for (const e of keys[act]) if (!revIds.has(e.revisionId)) fail(L, `keys.${act}`, `name ${e.revisionId}, not a revision of this offer`);
    for (const h of history) { if (histIds.has(h.id)) fail(L, 'history', `repeats the entry id ${h.id}`); histIds.add(h.id); }
    const clientKeys = responses.map((x) => x.clientKey).filter((k) => k !== null);
    if (new Set(clientKeys).size !== clientKeys.length) fail(L, 'responses', 'repeat a clientKey');
    return { ok: true, record };
  } catch (e) { if (e instanceof Bad) return { ok: false, reason: e.message }; throw e; }
}

// ------------------------------------------------------------------ rows
const b = (v) => (v === null || v === undefined ? null : v ? 1 : 0);
const json = (v) => (v === null || v === undefined ? null : JSON.stringify(v));
const contactRow = (c) => ({
  id: c.id, org_id: c.orgId, case_id: c.caseId, player_id: c.playerId, status: c.status, channel: c.channel, contact_mode: c.contactMode,
  recipient_type: c.recipient?.type ?? null, recipient_player_id: c.recipient?.playerId ?? null, recipient_guardian_id: c.recipient?.guardianId ?? null, recipient_minor: b(c.recipient?.minor),
  routing_at: c.routingSnapshot?.at ?? null, routing_mode: c.routingSnapshot?.mode ?? null, routing_player: b(c.routingSnapshot?.player), routing_guardian: b(c.routingSnapshot?.guardian),
  routing_agent_user_id: c.routingSnapshot?.agent?.agentUserId ?? null, routing_agent_agreement_id: c.routingSnapshot?.agent?.agreementId ?? null, routing_honest: c.routingSnapshot?.honest ?? null,
  subject: c.subject, body: c.body, summary: c.summary, created_by_user_id: c.createdBy.userId, created_by_name: c.createdBy.name, created_at: c.createdAt, updated_at: c.updatedAt,
  sent_by_user_id: c.sentBy?.userId ?? null, sent_by_name: c.sentBy?.name ?? null, sent_at: c.sentAt, delivered_at: c.deliveredAt, failed_at: c.failedAt, failure_code: c.failureCode, request_id: c.requestId,
  email_copy_state: c.emailCopy?.state ?? null, email_copy_to: c.emailCopy?.to ?? null, email_copy_outbox_id: c.emailCopy?.outboxId ?? null, email_copy_at: c.emailCopy?.at ?? null,
  lifecycle_applied: b(c.lifecycle?.applied), lifecycle_from: c.lifecycle?.from ?? null, lifecycle_to: c.lifecycle?.to ?? null, lifecycle_reason: c.lifecycle?.reason ?? null, lifecycle_at: c.lifecycle?.at ?? null,
  occurred_at: c.occurredAt, recorded_by_user_id: c.recordedBy?.userId ?? null, recorded_by_name: c.recordedBy?.name ?? null, recorded_at: c.recordedAt,
  responded_at: c.respondedAt, response_kind: c.response?.kind ?? null, response_message: c.response?.message ?? null, response_by: c.response?.by ?? null, response_at: c.response?.at ?? null,
  cancelled_at: c.cancelledAt, cancelled_by_user_id: c.cancelledBy?.userId ?? null, cancelled_by_name: c.cancelledBy?.name ?? null,
  create_key: c.keys.create?.key ?? null, create_fp: c.keys.create?.fp ?? null, send_key: c.keys.send?.key ?? null, send_fp: c.keys.send?.fp ?? null, record_key: c.keys.record?.key ?? null, record_fp: c.keys.record?.fp ?? null,
  rev: c.rev, rev_at: c.revAt, rev_by_user_id: c.revBy?.userId ?? null, rev_by_name: c.revBy?.name ?? null, policy_version: c.policyVersion,
});
const offerRow = (o) => ({
  id: o.id, org_id: o.orgId, case_id: o.caseId, player_id: o.playerId, type: o.type, decision_id: o.decisionId, transaction_id: o.transactionId, status: o.status, current_revision_id: o.currentRevisionId,
  agent_share_user_id: o.agentShare?.agentUserId ?? null, agent_share_agreement_id: o.agentShare?.agreementId ?? null, agent_share_at: o.agentShare?.at ?? null, agent_share_by_kind: o.agentShare?.by.kind ?? null, agent_share_by_id: o.agentShare?.by.id ?? null,
  create_key: o.keys.create?.key ?? null, create_fp: o.keys.create?.fp ?? null,
  lifecycle_applied: b(o.lifecycle?.applied), lifecycle_action: o.lifecycle?.action ?? null, lifecycle_reason: o.lifecycle?.reason ?? null, lifecycle_message: o.lifecycle?.message ?? null, lifecycle_allowed_json: json(o.lifecycle?.allowed), lifecycle_from: o.lifecycle?.from ?? null, lifecycle_to: o.lifecycle?.to ?? null, lifecycle_at: o.lifecycle?.at ?? null,
  created_at: o.createdAt, created_by_user_id: o.createdBy.id, created_by_name: o.createdBy.name, created_by_role: o.createdBy.role, updated_at: o.updatedAt,
  rev: o.rev, rev_at: o.revAt, rev_by_user_id: o.revBy?.userId ?? null, rev_by_name: o.revBy?.name ?? null, policy_version: o.policyVersion, subject_removed_at: o.subjectRemovedAt,
});
const actorCols = (p, a) => ({ [`${p}_user_id`]: a?.id ?? null, [`${p}_name`]: a?.name ?? null, [`${p}_role`]: a?.role ?? null });
const revisionRow = (offerId, r, position) => ({
  id: r.id, offer_id: offerId, position, revision_number: r.revisionNumber, status: r.status,
  term_offer_type: r.terms.offerType, term_role: r.terms.role, term_squad: r.terms.squad, term_start_date: r.terms.startDate, term_end_date: r.terms.endDate, term_conditions: r.terms.conditions,
  recipient_message: r.recipientMessage, internal_note: r.internalNote, expires_at: r.expiresAt, created_at: r.createdAt, ...actorCols('created_by', r.createdBy), updated_at: r.updatedAt, ...actorCols('updated_by', r.updatedBy),
  issued_at: r.issuedAt, ...actorCols('issued_by', r.issuedBy), withdrawn_at: r.withdrawnAt, ...actorCols('withdrawn_by', r.withdrawnBy), withdraw_reason: r.withdrawReason,
  responded_at: r.respondedAt, response_id: r.response?.id ?? null, supersedes_revision_id: r.supersedesRevisionId, superseded_by_revision_id: r.supersededByRevisionId, superseded_at: r.supersededAt,
  recipient_type: r.recipientSnapshot?.type ?? null, recipient_player_id: r.recipientSnapshot?.playerId ?? null, recipient_guardian_id: r.recipientSnapshot?.guardianId ?? null, recipient_minor: b(r.recipientSnapshot?.minor), recipient_at: r.recipientSnapshot?.at ?? null,
  readiness_transaction_id: r.readinessSnapshot?.transactionId ?? null, readiness_evaluated_at: r.readinessSnapshot?.evaluatedAt ?? null, readiness_status: r.readinessSnapshot?.status ?? null, readiness_blockers_json: json(r.readinessSnapshot?.blockers),
  rev: r.rev, rev_at: r.revAt, rev_by_user_id: r.revBy?.userId ?? null, rev_by_name: r.revBy?.name ?? null, discarded_by_response_id: r.discardedByResponseId ?? null,
});

// ------------------------------------------------------------------ statements and the record readers
const COLS = {
  recruitment_contacts: Object.keys(contactRow(typeContactSample())),
  recruitment_offers: Object.keys(offerRow(typeOfferSample())),
  offer_revisions: Object.keys(revisionRow('o', typeOfferSample().revisions[0], 0)),
  contact_attempts: ['contact_id', 'position', 'at', 'ok', 'code'],
  contact_history: ['id', 'contact_id', 'position', 'at', 'action', 'by_kind', 'by_user_id', 'by_name', 'detail_json'],
  offer_revision_documents: ['id', 'revision_id', 'position', 'evidence_id', 'label', 'mime', 'bytes'],
  offer_responses: ['id', 'offer_id', 'position', 'revision_id', 'response_type', 'actor_type', 'actor_id', 'actor_name', 'for_player_id', 'occurred_at', 'reason', 'client_key'],
  offer_read_receipts: ['offer_id', 'position', 'revision_id', 'viewer_kind', 'viewer_id', 'first_viewed_at'],
  offer_history: ['id', 'offer_id', 'position', 'at', 'action', 'by_kind', 'by_id', 'by_name', 'detail_json'],
  offer_keys: ['offer_id', 'act', 'position', 'key', 'revision_id'],
};
function typeContactSample() { return { id: 'x', orgId: 'o', caseId: 'c', playerId: 'p', status: 'draft', channel: 'in_app', recipient: null, contactMode: 'player_only', routingSnapshot: null, subject: null, body: null, summary: null, createdBy: { kind: 'org', userId: 'u', name: null }, createdAt: 0, updatedAt: 0, sentBy: null, sentAt: null, deliveredAt: null, failedAt: null, failureCode: null, attempts: [], requestId: null, emailCopy: null, lifecycle: null, occurredAt: null, recordedBy: null, recordedAt: null, respondedAt: null, response: null, cancelledAt: null, cancelledBy: null, keys: { create: null, send: null, record: null }, history: [], rev: 1, revAt: null, revBy: null, policyVersion: 1 }; }
function typeOfferSample() { const by = { kind: 'org', id: 'u', name: null, role: null }; return { id: 'x', orgId: 'o', caseId: 'c', playerId: 'p', type: OFFER_TYPES[0], decisionId: null, transactionId: null, status: 'DRAFT', currentRevisionId: 'r', revisions: [{ id: 'r', revisionNumber: 1, status: 'DRAFT', terms: { offerType: OFFER_TYPES[0], role: null, squad: null, startDate: null, endDate: null, conditions: null }, recipientMessage: null, internalNote: null, documents: [], expiresAt: null, createdAt: 0, createdBy: by, updatedAt: 0, updatedBy: by, issuedAt: null, issuedBy: null, withdrawnAt: null, withdrawnBy: null, withdrawReason: null, respondedAt: null, response: null, supersedesRevisionId: null, supersededByRevisionId: null, supersededAt: null, recipientSnapshot: null, readinessSnapshot: null, rev: 1, revAt: null, revBy: null }], responses: [], readReceipts: [], agentShare: null, keys: { create: null, issue: [], withdraw: [], revise: [] }, lifecycle: null, history: [], createdAt: 0, createdBy: by, updatedAt: 0, rev: 1, revAt: null, revBy: null, policyVersion: 1, subjectRemovedAt: null }; }

const stmtCache = new WeakMap();
function statements(sqlite) {
  let s = stmtCache.get(sqlite); if (s && s.preparedBy === sqlite.prepare) return s;
  const insert = (table, { upsert = false } = {}) => {
    const cols = COLS[table];
    const tail = upsert ? ` ON CONFLICT(id) DO UPDATE SET ${cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')}` : '';
    return sqlite.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})${tail}`);
  };
  s = {
    contact: insert('recruitment_contacts', { upsert: true }), attempt: insert('contact_attempts'), chist: insert('contact_history'),
    offer: insert('recruitment_offers', { upsert: true }), revision: insert('offer_revisions'), doc: insert('offer_revision_documents'), response: insert('offer_responses'), receipt: insert('offer_read_receipts'), ohist: insert('offer_history'), okey: insert('offer_keys'),
    contactChildrenDel: [sqlite.prepare('DELETE FROM contact_attempts WHERE contact_id = ?'), sqlite.prepare('DELETE FROM contact_history WHERE contact_id = ?')],
    offerChildrenDel: [sqlite.prepare('DELETE FROM offer_revisions WHERE offer_id = ?'), sqlite.prepare('DELETE FROM offer_responses WHERE offer_id = ?'), sqlite.prepare('DELETE FROM offer_read_receipts WHERE offer_id = ?'), sqlite.prepare('DELETE FROM offer_history WHERE offer_id = ?'), sqlite.prepare('DELETE FROM offer_keys WHERE offer_id = ?')],
    contactDel: sqlite.prepare('DELETE FROM recruitment_contacts WHERE id = ?'), offerDel: sqlite.prepare('DELETE FROM recruitment_offers WHERE id = ?'),
    contactById: sqlite.prepare('SELECT * FROM recruitment_contacts WHERE id = ?'), contactAll: sqlite.prepare('SELECT * FROM recruitment_contacts ORDER BY rowid'),
    attemptsOf: sqlite.prepare('SELECT * FROM contact_attempts WHERE contact_id = ? ORDER BY position'), chistOf: sqlite.prepare('SELECT * FROM contact_history WHERE contact_id = ? ORDER BY position'),
    offerById: sqlite.prepare('SELECT * FROM recruitment_offers WHERE id = ?'), offerAll: sqlite.prepare('SELECT * FROM recruitment_offers ORDER BY rowid'),
    revisionsOf: sqlite.prepare('SELECT * FROM offer_revisions WHERE offer_id = ? ORDER BY position'), docsOf: sqlite.prepare('SELECT * FROM offer_revision_documents WHERE revision_id = ? ORDER BY position'),
    responsesOf: sqlite.prepare('SELECT * FROM offer_responses WHERE offer_id = ? ORDER BY position'), receiptsOf: sqlite.prepare('SELECT * FROM offer_read_receipts WHERE offer_id = ? ORDER BY position'),
    ohistOf: sqlite.prepare('SELECT * FROM offer_history WHERE offer_id = ? ORDER BY position'), okeysOf: sqlite.prepare('SELECT * FROM offer_keys WHERE offer_id = ? ORDER BY act, position'),
    ids: (table) => sqlite.prepare(`SELECT id FROM ${table} ORDER BY rowid`).all().map((r) => r.id),
    caseExists: sqlite.prepare('SELECT 1 FROM recruitment_cases WHERE id = ?'),
    preparedBy: sqlite.prepare,
  };
  stmtCache.set(sqlite, s); return s;
}

/** Write a typed contact whole: the row upserted (its rowid, and so its place in the mirror, kept), the children replaced. */
/** The case a contact or an offer names is written first (an immediate key): a miss is named with the ids. */
function caseMustExist(st, table, r) {
  if (!st.caseExists.get(r.caseId)) throw refusal('CONTACTS_OFFERS_REFERENCE_MISSING', `${table} holds 1 row(s) naming a recruitment_cases row that is not there (${r.id} → recruitment_cases ${r.caseId}); the write was rolled back`);
}
function writeContact(st, c) {
  caseMustExist(st, 'recruitment_contacts', c);
  st.contact.run(contactRow(c));
  for (const d of st.contactChildrenDel) d.run(c.id);
  c.attempts.forEach((a, i) => st.attempt.run({ contact_id: c.id, position: i, at: a.at, ok: b(a.ok), code: a.code }));
  c.history.forEach((h, i) => st.chist.run({ id: h.id, contact_id: c.id, position: i, at: h.at, action: h.action, by_kind: h.by?.kind ?? null, by_user_id: h.by?.userId ?? null, by_name: h.by?.name ?? null, detail_json: json(h.detail) }));
}
function writeOffer(st, o) {
  caseMustExist(st, 'recruitment_offers', o);
  st.offer.run(offerRow(o));
  for (const d of st.offerChildrenDel) d.run(o.id);
  o.revisions.forEach((r, i) => { st.revision.run(revisionRow(o.id, r, i)); r.documents.forEach((d, j) => st.doc.run({ id: d.id, revision_id: r.id, position: j, evidence_id: d.evidenceId, label: d.label, mime: d.mime, bytes: d.bytes })); });
  o.responses.forEach((x, i) => st.response.run({ id: x.id, offer_id: o.id, position: i, revision_id: x.revisionId, response_type: x.responseType, actor_type: x.actorType, actor_id: x.actorId, actor_name: x.actorName, for_player_id: x.forPlayerId, occurred_at: x.occurredAt, reason: x.reason, client_key: x.clientKey }));
  o.readReceipts.forEach((x, i) => st.receipt.run({ offer_id: o.id, position: i, revision_id: x.revisionId, viewer_kind: x.viewerKind, viewer_id: x.viewerId, first_viewed_at: x.firstViewedAt }));
  o.history.forEach((h, i) => st.ohist.run({ id: h.id, offer_id: o.id, position: i, at: h.at, action: h.action, by_kind: h.by?.kind ?? null, by_id: h.by?.id ?? null, by_name: h.by?.name ?? null, detail_json: json(h.detail) }));
  for (const act of OFFER_KEY_LISTS) o.keys[act].forEach((e, i) => st.okey.run({ offer_id: o.id, act, position: i, key: e.key, revision_id: e.revisionId }));
}
function deleteContact(st, id) { for (const d of st.contactChildrenDel) d.run(id); st.contactDel.run(id); }
function deleteOffer(st, id) { for (const d of st.offerChildrenDel) d.run(id); st.offerDel.run(id); }

const flagOut = (v) => (v === null ? null : v === 1);
const pick = (row, p, keys) => keys.every((k) => row[`${p}_${k}`] === null);
const contactHistoryOut = (h) => ({ id: h.id, at: h.at, action: h.action, by: h.by_kind === null ? null : h.by_kind === 'org' ? { kind: 'org', userId: h.by_user_id, name: h.by_name } : { kind: h.by_kind, name: h.by_name }, detail: h.detail_json === null ? null : JSON.parse(h.detail_json) });
function decodeContact(st, row) {
  const staffOut = (p) => (row[`${p}_user_id`] === null && row[`${p}_name`] === null ? null : { kind: 'org', userId: row[`${p}_user_id`], name: row[`${p}_name`] });
  const key = (act) => (row[`${act}_fp`] === null ? null : { key: row[`${act}_key`], fp: row[`${act}_fp`] });
  return {
    id: row.id, orgId: row.org_id, caseId: row.case_id, playerId: row.player_id, status: row.status, channel: row.channel,
    recipient: row.recipient_type === null ? null : { type: row.recipient_type, playerId: row.recipient_player_id, guardianId: row.recipient_guardian_id, minor: row.recipient_minor === 1 },
    contactMode: row.contact_mode,
    routingSnapshot: row.routing_mode === null ? null : { at: row.routing_at, mode: row.routing_mode, player: row.routing_player === 1, guardian: row.routing_guardian === 1, agent: row.routing_agent_user_id === null ? null : { agentUserId: row.routing_agent_user_id, agreementId: row.routing_agent_agreement_id }, honest: row.routing_honest },
    subject: row.subject, body: row.body, summary: row.summary, createdBy: staffOut('created_by'), createdAt: row.created_at, updatedAt: row.updated_at,
    sentBy: staffOut('sent_by'), sentAt: row.sent_at, deliveredAt: row.delivered_at, failedAt: row.failed_at, failureCode: row.failure_code,
    attempts: st.attemptsOf.all(row.id).map((a) => ({ at: a.at, ok: a.ok === 1, code: a.code })), requestId: row.request_id,
    emailCopy: row.email_copy_state === null ? null : { state: row.email_copy_state, to: row.email_copy_to, outboxId: row.email_copy_outbox_id, at: row.email_copy_at },
    lifecycle: row.lifecycle_applied === null ? null : row.lifecycle_applied === 1 ? { applied: true, from: row.lifecycle_from, to: row.lifecycle_to, at: row.lifecycle_at } : { applied: false, reason: row.lifecycle_reason, at: row.lifecycle_at },
    occurredAt: row.occurred_at, recordedBy: staffOut('recorded_by'), recordedAt: row.recorded_at, respondedAt: row.responded_at,
    response: row.response_kind === null ? null : { kind: row.response_kind, message: row.response_message, by: row.response_by, at: row.response_at },
    cancelledAt: row.cancelled_at, cancelledBy: staffOut('cancelled_by'),
    keys: { create: key('create'), send: key('send'), record: key('record') },
    history: st.chistOf.all(row.id).map(contactHistoryOut),
    rev: row.rev, revAt: row.rev_at, revBy: row.rev_by_user_id === null && row.rev_by_name === null ? null : { userId: row.rev_by_user_id, name: row.rev_by_name }, policyVersion: row.policy_version,
  };
}
function decodeOffer(st, row) {
  const actorOut = (r, p) => (pick(r, p, ['user_id', 'name', 'role']) ? null : { kind: 'org', id: r[`${p}_user_id`], name: r[`${p}_name`], role: r[`${p}_role`] });
  const revisions = st.revisionsOf.all(row.id).map((r) => {
    const out = {
      id: r.id, revisionNumber: r.revision_number, status: r.status,
      terms: { offerType: r.term_offer_type, role: r.term_role, squad: r.term_squad, startDate: r.term_start_date, endDate: r.term_end_date, conditions: r.term_conditions },
      recipientMessage: r.recipient_message, internalNote: r.internal_note,
      documents: st.docsOf.all(r.id).map((d) => ({ id: d.id, evidenceId: d.evidence_id, label: d.label, mime: d.mime, bytes: d.bytes })),
      expiresAt: r.expires_at, createdAt: r.created_at, createdBy: actorOut(r, 'created_by'), updatedAt: r.updated_at, updatedBy: actorOut(r, 'updated_by'),
      issuedAt: r.issued_at, issuedBy: actorOut(r, 'issued_by'), withdrawnAt: r.withdrawn_at, withdrawnBy: actorOut(r, 'withdrawn_by'), withdrawReason: r.withdraw_reason,
      respondedAt: r.responded_at, response: r.response_id === null ? null : { id: r.response_id },
      supersedesRevisionId: r.supersedes_revision_id, supersededByRevisionId: r.superseded_by_revision_id, supersededAt: r.superseded_at,
      recipientSnapshot: r.recipient_type === null ? null : { type: r.recipient_type, playerId: r.recipient_player_id, guardianId: r.recipient_guardian_id, minor: r.recipient_minor === 1, at: r.recipient_at },
      readinessSnapshot: pick(r, 'readiness', ['transaction_id', 'evaluated_at', 'status', 'blockers_json']) ? null : { transactionId: r.readiness_transaction_id, evaluatedAt: r.readiness_evaluated_at, status: r.readiness_status, blockers: r.readiness_blockers_json === null ? [] : JSON.parse(r.readiness_blockers_json) },
      rev: r.rev, revAt: r.rev_at, revBy: r.rev_by_user_id === null && r.rev_by_name === null ? null : { userId: r.rev_by_user_id, name: r.rev_by_name },
    };
    if (r.discarded_by_response_id !== null) out.discardedByResponseId = r.discarded_by_response_id;
    return out;
  });
  const keyRows = st.okeysOf.all(row.id);
  const lifecycle = row.lifecycle_applied === null ? null : (() => {
    const l = { applied: row.lifecycle_applied === 1, action: row.lifecycle_action, from: row.lifecycle_from, to: row.lifecycle_to, at: row.lifecycle_at };
    if (row.lifecycle_reason !== null) l.reason = row.lifecycle_reason; if (row.lifecycle_message !== null) l.message = row.lifecycle_message; if (row.lifecycle_allowed_json !== null) l.allowed = JSON.parse(row.lifecycle_allowed_json);
    return l;
  })();
  return {
    id: row.id, orgId: row.org_id, caseId: row.case_id, playerId: row.player_id, type: row.type, decisionId: row.decision_id, transactionId: row.transaction_id, status: row.status, currentRevisionId: row.current_revision_id,
    revisions,
    responses: st.responsesOf.all(row.id).map((x) => ({ id: x.id, revisionId: x.revision_id, responseType: x.response_type, actorType: x.actor_type, actorId: x.actor_id, actorName: x.actor_name, forPlayerId: x.for_player_id, occurredAt: x.occurred_at, reason: x.reason, clientKey: x.client_key })),
    readReceipts: st.receiptsOf.all(row.id).map((x) => ({ revisionId: x.revision_id, viewerKind: x.viewer_kind, viewerId: x.viewer_id, firstViewedAt: x.first_viewed_at })),
    agentShare: row.agent_share_user_id === null ? null : { agentUserId: row.agent_share_user_id, agreementId: row.agent_share_agreement_id, at: row.agent_share_at, by: { kind: row.agent_share_by_kind, id: row.agent_share_by_id } },
    keys: { create: row.create_key === null ? null : { key: row.create_key, fp: row.create_fp }, ...Object.fromEntries(OFFER_KEY_LISTS.map((act) => [act, keyRows.filter((k) => k.act === act).map((k) => ({ key: k.key, revisionId: k.revision_id }))])) },
    lifecycle,
    history: st.ohistOf.all(row.id).map((h) => ({ id: h.id, at: h.at, action: h.action, by: h.by_kind === null ? null : { kind: h.by_kind, id: h.by_id, name: h.by_name }, detail: h.detail_json === null ? null : JSON.parse(h.detail_json) })),
    createdAt: row.created_at, createdBy: { kind: 'org', id: row.created_by_user_id, name: row.created_by_name, role: row.created_by_role }, updatedAt: row.updated_at,
    rev: row.rev, revAt: row.rev_at, revBy: row.rev_by_user_id === null && row.rev_by_name === null ? null : { userId: row.rev_by_user_id, name: row.rev_by_name }, policyVersion: row.policy_version, subjectRemovedAt: row.subject_removed_at,
  };
}
export const readContacts = (sqlite) => { const st = statements(sqlite); return st.contactAll.all().map((r) => decodeContact(st, r)); };
export const readOffers = (sqlite) => { const st = statements(sqlite); return st.offerAll.all().map((r) => decodeOffer(st, r)); };

// ------------------------------------------------------------------ references (Q8c-a counted, Q8c-b strict on a snapshot write)
const PLAYER_REFS_SQL = {
  recruitmentContacts: 'SELECT player_id AS pid FROM recruitment_contacts UNION ALL SELECT recipient_player_id FROM recruitment_contacts WHERE recipient_player_id IS NOT NULL',
  recruitmentOffers: "SELECT player_id AS pid FROM recruitment_offers UNION ALL SELECT recipient_player_id FROM offer_revisions WHERE recipient_player_id IS NOT NULL UNION ALL SELECT for_player_id FROM offer_responses UNION ALL SELECT actor_id FROM offer_responses WHERE actor_type = 'player' UNION ALL SELECT viewer_id FROM offer_read_receipts WHERE viewer_kind = 'player'",
};
export function unresolvedPlayerReferences(sqlite) {
  if (!recruitmentContactsOffersLive(sqlite)) return null;
  return Object.fromEntries(RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS.map((c) => [c, sqlite.prepare(`SELECT count(*) AS n FROM (${PLAYER_REFS_SQL[c]}) x WHERE NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid)`).get().n]));
}
export function retainedPlayerReferences(sqlite) {
  if (!recruitmentContactsOffersLive(sqlite)) return null;
  return Object.fromEntries(RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS.map((c) => [c, sqlite.prepare(`SELECT count(*) AS n FROM (${PLAYER_REFS_SQL[c]}) x WHERE EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid AND p.deleted_at IS NOT NULL)`).get().n]));
}
/** Every guardian id a typed record names (recipient, revision recipient, guardian response actor, guardian receipt viewer). */
function guardianIdsOf(name, r) {
  if (name === 'recruitmentContacts') return r.recipient?.guardianId !== null && r.recipient?.guardianId !== undefined ? [r.recipient.guardianId] : [];
  return [...r.revisions.map((x) => x.recipientSnapshot?.guardianId ?? null), ...r.responses.filter((x) => x.actorType === 'guardian').map((x) => x.actorId), ...r.readReceipts.filter((x) => x.viewerKind === 'guardian').map((x) => x.viewerId)].filter((x) => x !== null);
}

/** The pair the respond routes read both ways: a contact's request never names another contact. */
function assertPairs(sqlite, label) {
  const broken = sqlite.prepare('SELECT c.id AS contact, c.request_id AS request FROM recruitment_contacts c JOIN recruitment_requests r ON r.id = c.request_id WHERE r.contact_id IS NOT NULL AND r.contact_id <> c.id').all();
  if (broken.length) throw refusal('CONTACT_REQUEST_MISMATCH', `${label}: ${broken.length} contact(s) name a request that does not name them back (${ids(broken.map((x) => `${x.contact} → ${x.request}`))}); the write was rolled back`);
}
function assertKeys(sqlite, label) {
  for (const t of RECRUITMENT_CONTACTS_OFFERS_TABLES) {
    const broken = sqlite.prepare(`PRAGMA foreign_key_check(${t})`).all();
    if (broken.length) {
      const idOf = (r) => sqlite.prepare(`SELECT ${t === 'contact_attempts' ? 'contact_id' : t === 'offer_read_receipts' || t === 'offer_keys' ? 'offer_id' : 'id'} AS id FROM ${t} WHERE rowid = ?`).get(r.rowid)?.id ?? `rowid ${r.rowid}`;
      throw refusal('CONTACTS_OFFERS_REFERENCE_MISSING', `${label}: ${t} holds ${broken.length} row(s) naming a ${broken[0].parent} row that is not there (${ids(broken.map((r) => `${idOf(r)} → ${r.parent}`))}); the write was rolled back`);
    }
  }
}

// ------------------------------------------------------------------ the snapshot path (tools, fixtures, the persistence suites)
const TYPERS = { recruitmentContacts: typeContact, recruitmentOffers: typeOffer };
const TABLE_OF = { recruitmentContacts: 'recruitment_contacts', recruitmentOffers: 'recruitment_offers' };
export const CONTACTS_OFFERS_SNAPSHOT = {
  names: RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS,
  read(sqlite) { if (!recruitmentContactsOffersLive(sqlite)) return null; return { recruitmentContacts: readContacts(sqlite), recruitmentOffers: readOffers(sqlite) }; },
  /**
   * Type the supplied collections (an omitted one is retained whole, an array is the whole final collection), check
   * the guardian references against the final guardians (Q8c-b), and remove the departing records. Returns the plan
   * `write` takes, or null before the 0017 record.
   */
  begin(sqlite, db, { guardians, label = 'the snapshot' } = {}) {
    if (!recruitmentContactsOffersLive(sqlite)) return null;
    const supplied = Object.fromEntries(RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS.map((n) => [n, Object.hasOwn(db, n) && db[n] !== undefined ? db[n] : undefined]));
    const typed = {}; const written = [];
    for (const name of RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS) {
      const value = supplied[name];
      if (value === undefined) continue;
      if (!Array.isArray(value)) throw refusal('CONTACTS_OFFERS_INPUT_INVALID', `the ${name} collection of ${label} must be an array of records (got ${describe(value)}); nothing was written`);
      const seen = new Set();
      typed[name] = value.map((raw, i) => {
        const t = TYPERS[name](raw, `${name} entry #${i}`);
        if (!t.ok) throw refusal('CONTACTS_OFFERS_INPUT_INVALID', `${label}: ${t.reason}; nothing was written`);
        if (seen.has(t.record.id)) throw refusal('CONTACTS_OFFERS_INPUT_INVALID', `${label}: ${name} entry #${i} duplicates the id of an earlier entry (${t.record.id}); nothing was written`);
        seen.add(t.record.id); return t.record;
      });
      written.push(name);
    }
    if (!written.length) return { written, typed };
    // The child ids are keys of their tables across records (the writers' nextId makes them so): a repeat is named.
    const childIds = { recruitmentContacts: (c) => [['contact_history', c.history.map((h) => h.id)]], recruitmentOffers: (o) => [['offer_revisions', o.revisions.map((r) => r.id)], ['offer_revision_documents', o.revisions.flatMap((r) => r.documents.map((d) => d.id))], ['offer_responses', o.responses.map((x) => x.id)], ['offer_history', o.history.map((h) => h.id)]] };
    const repeats = [];
    for (const name of written) {
      const owner = new Map();
      for (const r of typed[name]) for (const [table, list] of childIds[name](r)) for (const id of list) { const k = `${table} ${id}`; if (owner.has(k) && owner.get(k) !== r.id) repeats.push(`${k} (${owner.get(k)} and ${r.id})`); else owner.set(k, r.id); }
    }
    if (repeats.length) throw refusal('CONTACTS_OFFERS_INPUT_INVALID', `${label}: ${repeats.length} child id(s) appear under two records (${ids(repeats)}); nothing was written`);
    const known = guardians !== undefined && Array.isArray(guardians) ? new Set(guardians.filter(isPlainObject).map((g) => g.id)) : tableExists(sqlite, 'guardians') ? new Set(sqlite.prepare('SELECT id FROM guardians').all().map((r) => r.id)) : new Set();
    const missing = [];
    for (const name of written) for (const r of typed[name]) for (const g of guardianIdsOf(name, r)) if (!known.has(g)) missing.push(`${TABLE_OF[name]} ${r.id} → guardians ${g === '' ? '""' : g}`);
    if (missing.length) throw refusal('CONTACTS_OFFERS_GUARDIAN_MISSING', `${label}: ${missing.length} guardian reference(s) name no guardian (${ids(missing)}); nothing was written`);
    const st = statements(sqlite);
    for (const name of written) {
      const keep = new Set(typed[name].map((r) => r.id));
      for (const id of st.ids(TABLE_OF[name])) if (!keep.has(id)) (name === 'recruitmentContacts' ? deleteContact : deleteOffer)(st, id);
    }
    return { written, typed, label };
  },
  /** The supplied records written (after the cases and requests of the same snapshot are in place). */
  write(sqlite, plan) {
    if (!plan) return; const st = statements(sqlite);
    for (const c of plan.typed.recruitmentContacts ?? []) writeContact(st, c);
    for (const o of plan.typed.recruitmentOffers ?? []) writeOffer(st, o);
  },
  /** Every key and the contact/request pairs, named with ids before COMMIT would refuse them anonymously. */
  assert(sqlite, { label = 'the snapshot' } = {}) { if (!recruitmentContactsOffersLive(sqlite)) return; assertKeys(sqlite, label); assertPairs(sqlite, label); },
};

// ------------------------------------------------------------------ the repository (explicit writes; SQL reads; the participant)
const deepFreeze = (v) => { if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const k of Object.keys(v)) deepFreeze(v[k]); } return v; };
const CONTACT_READS = {
  forCase: 'SELECT * FROM recruitment_contacts WHERE case_id = ? ORDER BY rowid',
  forOrgPlayer: 'SELECT * FROM recruitment_contacts WHERE org_id = ? AND player_id = ? ORDER BY rowid',
  forPlayer: 'SELECT * FROM recruitment_contacts WHERE player_id = ? ORDER BY rowid',
  forRequest: 'SELECT * FROM recruitment_contacts WHERE request_id = ? ORDER BY rowid',
  forAgent: 'SELECT * FROM recruitment_contacts WHERE routing_agent_user_id = ? ORDER BY rowid',
  forOrg: 'SELECT * FROM recruitment_contacts WHERE org_id = ? ORDER BY rowid',
};
const OFFER_READS = {
  forCase: 'SELECT * FROM recruitment_offers WHERE case_id = ? ORDER BY rowid',
  forOrgPlayer: 'SELECT * FROM recruitment_offers WHERE org_id = ? AND player_id = ? ORDER BY rowid',
  forPlayer: 'SELECT * FROM recruitment_offers WHERE player_id = ? ORDER BY rowid',
  forAgentShare: 'SELECT * FROM recruitment_offers WHERE agent_share_user_id = ? ORDER BY rowid',
  forOrg: 'SELECT * FROM recruitment_offers WHERE org_id = ? ORDER BY rowid',
};

/**
 * `createRecruitmentContactsOffersRepository({ sqlite, unit, now, log })`. Every operation joins the open unit of work
 * (a failure poisons it), the caller's open raw transaction, or runs a transaction of its own; it writes its rows and
 * returns the record read back from the tables. A route that writes a contact naming a request created in the same act
 * runs inside a unit, whose COMMIT checks the deferred request key.
 *
 * READS ARE SQL (§4.3 step 2). There is no in-memory mirror and no `db.recruitmentContacts` / `db.recruitmentOffers`:
 * callers ask the repository (`contacts.byId`, `contacts.forCase`, `offers.forPlayer`, …). Every query runs on the
 * one connection, so a read inside a unit of work sees the unit's own uncommitted writes, and a rolled-back unit
 * leaves nothing to restore. Each record handed out is a fresh, deep-frozen decode of its rows: an in-place edit
 * throws, and a change is `update(id, (draft) => …)`. Lists come back in insertion (rowid) order, the order the
 * mirrors had.
 */
export function createRecruitmentContactsOffersRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the recruitment contacts/offers repository needs a SQLite connection (node:sqlite)');
  const st = statements(sqlite);
  const operation = (fn) => (unit?.active?.() ? unit.join(fn) : sqlite.isTransaction ? fn() : transaction(sqlite, fn));
  const decode = { recruitmentContacts: (row) => deepFreeze(decodeContact(st, row)), recruitmentOffers: (row) => deepFreeze(decodeOffer(st, row)) };
  const rowById = { recruitmentContacts: st.contactById, recruitmentOffers: st.offerById };
  const read = (name, id) => { if (typeof id !== 'string') return null; const row = rowById[name].get(id); return row ? decode[name](row) : null; };
  const must = (name, id) => { const r = read(name, id); if (!r) throw refusal('CONTACTS_OFFERS_NOT_FOUND', `${name} ${id} is not a record of the repository`); return r; };
  const typedOr = (name, raw) => { const t = TYPERS[name](raw, name); if (!t.ok) throw refusal('CONTACTS_OFFERS_INPUT_INVALID', t.reason); return t.record; };
  const IMMUTABLE = ['id', 'orgId', 'caseId', 'playerId', 'createdAt'];
  const write = (name, record) => (name === 'recruitmentContacts' ? writeContact(st, record) : writeOffer(st, record));
  const queries = (name, sql) => Object.fromEntries(Object.entries(sql).map(([k, q]) => { const stmt = sqlite.prepare(q); return [k, (...args) => stmt.all(...args).map(decode[name])]; }));
  const countOf = (table) => sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`);
  const counters = { recruitmentContacts: countOf('recruitment_contacts'), recruitmentOffers: countOf('recruitment_offers') };

  /** `create(record)`: a new record, typed whole; an existing id is refused. */
  const create = (name) => (raw) => operation(() => {
    const r = typedOr(name, raw);
    if (rowById[name].get(r.id)) throw refusal('CONTACTS_OFFERS_DUPLICATE', `${TABLE_OF[name]} ${r.id} already exists`);
    write(name, r); return must(name, r.id);
  });
  /**
   * `update(id, change)`: `change` receives a plain copy of the stored record and edits it (or returns a replacement);
   * the result is typed whole and written at once. The identifiers and the creation instant cannot change.
   */
  const update = (name) => (id, change) => operation(() => {
    if (typeof change !== 'function') throw new TypeError(`${name}.update(id, change) needs a function that edits the copy it is given`);
    const stored = must(name, id);
    const draft = clone(stored);
    const returned = change(draft);
    const next = typedOr(name, returned === undefined ? draft : returned);
    for (const k of IMMUTABLE) if (next[k] !== stored[k]) throw refusal('CONTACTS_OFFERS_INPUT_INVALID', `${TABLE_OF[name]} ${id}: ${k} cannot change`);
    write(name, next); return must(name, id);
  });

  const contactHistoryFrom = (orgId, actions) => ({ from: 'contact_history h JOIN recruitment_contacts c ON c.id = h.contact_id', where: `c.org_id = ? AND h.action IN (${actions.map(() => '?').join(', ') || 'NULL'})`, params: [orgId, ...actions] });
  const contacts = {
    create: create('recruitmentContacts'), update: update('recruitmentContacts'),
    /** One contact by id, or null. Callers check the organisation and case they expect. */
    byId: (id) => read('recruitmentContacts', id),
    /** forCase(caseId), forOrgPlayer(orgId, playerId), forPlayer(playerId), forRequest(requestId), forAgent(agentUserId), forOrg(orgId). */
    ...queries('recruitmentContacts', CONTACT_READS),
    /**
     * The history of the organisation's contacts with one of `actions`, newest first, for a merged feed (the audit
     * feed): `{ contactId, caseId, playerId, entry }`. See `newestHistory` (database.mjs) for `atMost` and `n`.
     */
    historyFeed(orgId, actions, atMost, n) {
      return newestHistory(sqlite, { select: 'h.*, c.case_id AS owner_case_id, c.player_id AS owner_player_id', ...contactHistoryFrom(orgId, actions) }, atMost, n)
        .map((h) => ({ contactId: h.contact_id, caseId: h.owner_case_id, playerId: h.owner_player_id, entry: contactHistoryOut(h) }));
    },
    historyCount(orgId, actions) { const f = contactHistoryFrom(orgId, actions); return sqlite.prepare(`SELECT COUNT(*) AS n FROM ${f.from} WHERE ${f.where}`).get(...f.params).n; },
    /** The deletion unit: the player's own words leave the contacts about them (the reply message); the records stay. */
    redactPlayer(playerId) {
      return operation(() => {
        const ids = sqlite.prepare('SELECT id FROM recruitment_contacts WHERE player_id = ? AND response_message IS NOT NULL ORDER BY rowid').all(playerId).map((r) => r.id);
        sqlite.prepare('UPDATE recruitment_contacts SET response_message = NULL WHERE player_id = ? AND response_message IS NOT NULL').run(playerId);
        return ids.map((id) => must('recruitmentContacts', id));
      });
    },
  };
  const offers = {
    create: create('recruitmentOffers'), update: update('recruitmentOffers'),
    /** One offer by id, or null. Callers check the organisation they expect. */
    byId: (id) => read('recruitmentOffers', id),
    /** forCase(caseId), forOrgPlayer(orgId, playerId), forPlayer(playerId), forAgentShare(agentUserId), forOrg(orgId). */
    ...queries('recruitmentOffers', OFFER_READS),
    /** The offers of several players (a guardian's children), in insertion order. */
    forPlayers(playerIds) { const want = [...new Set((playerIds ?? []).filter((p) => typeof p === 'string'))]; if (!want.length) return []; return sqlite.prepare(`SELECT * FROM recruitment_offers WHERE player_id IN (${want.map(() => '?').join(',')}) ORDER BY rowid`).all(...want).map(decode.recruitmentOffers); },
    /** The deletion unit (P6.1 §66): ids, states and times stay; the player's name and words go; subject_removed_at set. */
    redactPlayer(playerId, at) {
      return operation(() => {
        const ids = sqlite.prepare('SELECT id FROM recruitment_offers WHERE player_id = ? ORDER BY rowid').all(playerId).map((r) => r.id);
        for (const id of ids) {
          sqlite.prepare("UPDATE offer_responses SET actor_name = NULL, reason = NULL WHERE offer_id = ? AND actor_type = 'player'").run(id);
          sqlite.prepare("UPDATE offer_history SET by_name = NULL WHERE offer_id = ? AND by_kind = 'player'").run(id);
          sqlite.prepare('UPDATE recruitment_offers SET subject_removed_at = ? WHERE id = ?').run(at, id);
        }
        return ids.map((id) => must('recruitmentOffers', id));
      });
    },
  };

  const readOnly = (o) => Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => !['create', 'update', 'redactPlayer'].includes(k))));
  return {
    contacts, offers,
    /** The queries alone, for the pure projectors and providers that must not write (the evidence provider, the journey). */
    reads: Object.freeze({ contacts: readOnly(contacts), offers: readOnly(offers) }),
    /** Check the tables are authoritative (0017 recorded); there is nothing to load. */
    attach() {
      if (!recruitmentContactsOffersLive(sqlite)) throw new Error(`the recruitment contacts/offers repository needs ${RECRUITMENT_CONTACTS_OFFERS_MIGRATION} recorded; it never imports an in-memory array`);
      return { counts: this.counts() };
    },
    counts() { return Object.fromEntries(RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS.map((n) => [n, counters[n].get().n])); },
    pending: () => 0,
    exportAll() { return CONTACTS_OFFERS_SNAPSHOT.read(sqlite); },
    log,
    now,
  };
}
