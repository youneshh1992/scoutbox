/**
 * Recruitment contacts (attempts, history) and offers (revisions and their documents, responses, read receipts,
 * history, keys).
 *
 * Every field is a typed column with the vocabulary and length CHECKs of the domain rules
 * (domains/recruitment/lifecycle/contact.mjs, domains/recruitment/offers/offer.mjs). The idempotency keys are columns
 * of their owner (`create_key`, `send_key`, …) and the offer's per-act key lists are the rows of `offer_keys`.
 *
 * Writes. A contact is created and updated whole, typed in JavaScript (an unknown field at any level is refused). An
 * offer is created whole and then changes only through named acts (`editDraft`, `issueRevision`, `recordResponse`, …),
 * each an UPDATE or INSERT of the rows it concerns; its columns and keys are the only judge of its values, and a
 * revision moves only along `OFFER_REVISION_TRANSITIONS`. Either way a refusal names the record and the unit rolls back.
 *
 * References. `org_id` → orgs and `case_id` → recruitment_cases (RESTRICT). A contact's `request_id` →
 * recruitment_requests is DEFERRABLE INITIALLY DEFERRED (checked at COMMIT): a send writes its contact before the
 * request row it names. Staff ids → org_users. Player ids: no key, tolerant and counted (Q8c-a in docs/decisions.md).
 * Guardian ids: no key (the routes resolve the guardian before they write, Q8c-b). The offer's own pointers (current
 * revision, response, supersedes, superseded by, discarded by, a receipt's, response's or key's revision) are composite
 * keys `(offer_id, …)` into the same offer's rows; the current-revision key is deferred, as the offer row is written
 * before its revisions.
 *
 * Refusals name tables, fields and ids, never a subject, a body, a note, a message or a name.
 */
import { transaction, migrationApplied, newestHistory, childRowsOf } from './database.mjs';
import { isPlainObject, ids } from './recruitment.mjs';
import { CONTACT_STATUSES, CONTACT_CHANNELS, CONTACT_MODES, CONTACT_LIMITS, RESPONSE_KINDS } from '../domains/recruitment/lifecycle/contact.mjs';
import { OFFER_STATUSES, OFFER_REVISION_TRANSITIONS, OFFER_TYPES, OFFER_LIMITS, OFFER_RESPONSE_TYPES, OFFER_RESPONSE_ACTORS } from '../domains/recruitment/offers/offer.mjs';

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
const calendarDay = (col) => `CHECK (${col} IS NULL OR ${col} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')`;
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
  CHECK ((create_key IS NULL) = (create_fp IS NULL)),
  FOREIGN KEY (id, current_revision_id) REFERENCES offer_revisions(offer_id, id) DEFERRABLE INITIALLY DEFERRED
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
  term_start_date TEXT ${calendarDay('term_start_date')},
  term_end_date TEXT ${calendarDay('term_end_date')},
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
  UNIQUE (offer_id, id),
  UNIQUE (offer_id, revision_number),
  UNIQUE (offer_id, position),
  FOREIGN KEY (offer_id, supersedes_revision_id) REFERENCES offer_revisions(offer_id, id),
  FOREIGN KEY (offer_id, superseded_by_revision_id) REFERENCES offer_revisions(offer_id, id),
  FOREIGN KEY (offer_id, response_id) REFERENCES offer_responses(offer_id, id),
  FOREIGN KEY (offer_id, discarded_by_response_id) REFERENCES offer_responses(offer_id, id)
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
  actor_id TEXT NOT NULL CHECK (length(actor_id) > 0),
  actor_name TEXT,
  for_player_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  reason TEXT ${maxLen('reason', OFFER_LIMITS.declineReason)},
  client_key TEXT,
  UNIQUE (offer_id, id),
  UNIQUE (offer_id, revision_id),
  UNIQUE (offer_id, position),
  FOREIGN KEY (offer_id, revision_id) REFERENCES offer_revisions(offer_id, id)
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
  UNIQUE (offer_id, revision_id, viewer_kind, viewer_id),
  FOREIGN KEY (offer_id, revision_id) REFERENCES offer_revisions(offer_id, id)
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
  PRIMARY KEY (offer_id, act, position),
  FOREIGN KEY (offer_id, revision_id) REFERENCES offer_revisions(offer_id, id)
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
// The offer encoders take the record as the routes build it (or a fixture writes it); an absent field is NULL, and
// the columns' CHECKs and keys judge the values.
const n = (v) => (v === undefined ? null : v);
const offerRow = (o) => ({
  id: n(o.id), org_id: n(o.orgId), case_id: n(o.caseId), player_id: n(o.playerId), type: n(o.type), decision_id: n(o.decisionId), transaction_id: n(o.transactionId), status: n(o.status), current_revision_id: n(o.currentRevisionId),
  ...agentShareCols(o.agentShare),
  create_key: o.keys?.create?.key ?? null, create_fp: o.keys?.create?.fp ?? null,
  ...lifecycleCols(o.lifecycle),
  created_at: n(o.createdAt), created_by_user_id: o.createdBy?.id ?? null, created_by_name: o.createdBy?.name ?? null, created_by_role: o.createdBy?.role ?? null, updated_at: n(o.updatedAt),
  rev: n(o.rev), ...revByCols(o.revAt, o.revBy), policy_version: n(o.policyVersion), subject_removed_at: n(o.subjectRemovedAt),
});
const agentShareCols = (s) => ({ agent_share_user_id: s?.agentUserId ?? null, agent_share_agreement_id: s?.agreementId ?? null, agent_share_at: s?.at ?? null, agent_share_by_kind: s?.by?.kind ?? null, agent_share_by_id: s?.by?.id ?? null });
const lifecycleCols = (l) => ({ lifecycle_applied: b(l?.applied), lifecycle_action: l?.action ?? null, lifecycle_reason: l?.reason ?? null, lifecycle_message: l?.message ?? null, lifecycle_allowed_json: json(l?.allowed), lifecycle_from: l?.from ?? null, lifecycle_to: l?.to ?? null, lifecycle_at: l?.at ?? null });
const revByCols = (at, by) => ({ rev_at: n(at), rev_by_user_id: by?.userId ?? null, rev_by_name: by?.name ?? null });
const actorCols = (p, a) => ({ [`${p}_user_id`]: a?.id ?? null, [`${p}_name`]: a?.name ?? null, [`${p}_role`]: a?.role ?? null });
const termCols = (t) => ({ term_offer_type: t?.offerType ?? null, term_role: t?.role ?? null, term_squad: t?.squad ?? null, term_start_date: t?.startDate ?? null, term_end_date: t?.endDate ?? null, term_conditions: t?.conditions ?? null });
const recipientCols = (s) => ({ recipient_type: s?.type ?? null, recipient_player_id: s?.playerId ?? null, recipient_guardian_id: s?.guardianId ?? null, recipient_minor: b(s?.minor), recipient_at: s?.at ?? null });
const readinessCols = (s) => ({ readiness_transaction_id: s?.transactionId ?? null, readiness_evaluated_at: s?.evaluatedAt ?? null, readiness_status: s?.status ?? null, readiness_blockers_json: json(s?.blockers) });
/** A revision's pointers to other rows of its offer: written once those rows exist. */
const revisionPointers = (r) => ({ supersedes_revision_id: r.supersedesRevisionId ?? null, superseded_by_revision_id: r.supersededByRevisionId ?? null, response_id: r.response?.id ?? null, discarded_by_response_id: r.discardedByResponseId ?? null });
const revisionRow = (offerId, r, position) => ({
  id: n(r.id), offer_id: offerId, position, revision_number: n(r.revisionNumber), status: n(r.status), ...termCols(r.terms),
  recipient_message: n(r.recipientMessage), internal_note: n(r.internalNote), expires_at: n(r.expiresAt), created_at: n(r.createdAt), ...actorCols('created_by', r.createdBy), updated_at: n(r.updatedAt), ...actorCols('updated_by', r.updatedBy),
  issued_at: n(r.issuedAt), ...actorCols('issued_by', r.issuedBy), withdrawn_at: n(r.withdrawnAt), ...actorCols('withdrawn_by', r.withdrawnBy), withdraw_reason: n(r.withdrawReason),
  responded_at: n(r.respondedAt), superseded_at: n(r.supersededAt), ...recipientCols(r.recipientSnapshot), ...readinessCols(r.readinessSnapshot),
  rev: n(r.rev), ...revByCols(r.revAt, r.revBy), ...revisionPointers({}),
});
const documentRow = (revisionId, d, position) => ({ id: n(d.id), revision_id: revisionId, position, evidence_id: n(d.evidenceId), label: n(d.label), mime: n(d.mime), bytes: n(d.bytes) });
const responseRow = (offerId, x, position) => ({ id: n(x.id), offer_id: offerId, position, revision_id: n(x.revisionId), response_type: n(x.responseType), actor_type: n(x.actorType), actor_id: n(x.actorId), actor_name: n(x.actorName), for_player_id: n(x.forPlayerId), occurred_at: n(x.occurredAt), reason: n(x.reason), client_key: n(x.clientKey) });
const receiptRow = (offerId, x, position) => ({ offer_id: offerId, position, revision_id: n(x.revisionId), viewer_kind: n(x.viewerKind), viewer_id: n(x.viewerId), first_viewed_at: n(x.firstViewedAt) });
const offerHistoryRow = (offerId, h, position) => ({ id: n(h.id), offer_id: offerId, position, at: n(h.at), action: n(h.action), by_kind: h.by?.kind ?? null, by_id: h.by?.id ?? null, by_name: h.by?.name ?? null, detail_json: json(h.detail) });

// ------------------------------------------------------------------ statements and the record readers
const COLS = {
  recruitment_contacts: Object.keys(contactRow(typeContactSample())),
  recruitment_offers: Object.keys(offerRow({})),
  offer_revisions: Object.keys(revisionRow('o', {}, 0)),
  contact_attempts: ['contact_id', 'position', 'at', 'ok', 'code'],
  contact_history: ['id', 'contact_id', 'position', 'at', 'action', 'by_kind', 'by_user_id', 'by_name', 'detail_json'],
  offer_revision_documents: Object.keys(documentRow('r', {}, 0)),
  offer_responses: Object.keys(responseRow('o', {}, 0)),
  offer_read_receipts: Object.keys(receiptRow('o', {}, 0)),
  offer_history: Object.keys(offerHistoryRow('o', {}, 0)),
  offer_keys: ['offer_id', 'act', 'position', 'key', 'revision_id'],
};
function typeContactSample() { return { id: 'x', orgId: 'o', caseId: 'c', playerId: 'p', status: 'draft', channel: 'in_app', recipient: null, contactMode: 'player_only', routingSnapshot: null, subject: null, body: null, summary: null, createdBy: { kind: 'org', userId: 'u', name: null }, createdAt: 0, updatedAt: 0, sentBy: null, sentAt: null, deliveredAt: null, failedAt: null, failureCode: null, attempts: [], requestId: null, emailCopy: null, lifecycle: null, occurredAt: null, recordedBy: null, recordedAt: null, respondedAt: null, response: null, cancelledAt: null, cancelledBy: null, keys: { create: null, send: null, record: null }, history: [], rev: 1, revAt: null, revBy: null, policyVersion: 1 }; }

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
    offer: insert('recruitment_offers'), revision: insert('offer_revisions'), doc: insert('offer_revision_documents'), response: insert('offer_responses'), receipt: insert('offer_read_receipts'), ohist: insert('offer_history'), okey: insert('offer_keys'),
    contactChildrenDel: [sqlite.prepare('DELETE FROM contact_attempts WHERE contact_id = ?'), sqlite.prepare('DELETE FROM contact_history WHERE contact_id = ?')],
    contactDel: sqlite.prepare('DELETE FROM recruitment_contacts WHERE id = ?'),
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

/** The case a contact or an offer names is written first (an immediate key): a miss is named with the ids. */
function caseMustExist(st, table, r) {
  if (!st.caseExists.get(r.caseId)) throw refusal('CONTACTS_OFFERS_REFERENCE_MISSING', `${table} holds 1 row(s) naming a recruitment_cases row that is not there (${r.id} → recruitment_cases ${r.caseId}); the write was rolled back`);
}
/** Write a typed contact whole: the row upserted (its rowid, and so its insertion order, kept), the children replaced. */
function writeContact(st, c) {
  caseMustExist(st, 'recruitment_contacts', c);
  st.contact.run(contactRow(c));
  for (const d of st.contactChildrenDel) d.run(c.id);
  c.attempts.forEach((a, i) => st.attempt.run({ contact_id: c.id, position: i, at: a.at, ok: b(a.ok), code: a.code }));
  c.history.forEach((h, i) => st.chist.run({ id: h.id, contact_id: c.id, position: i, at: h.at, action: h.action, by_kind: h.by?.kind ?? null, by_user_id: h.by?.userId ?? null, by_name: h.by?.name ?? null, detail_json: json(h.detail) }));
}
/** A constraint failure on an offer's rows, as a refusal naming the offer and the part that broke it. */
function offerStep(offerId, part, fn) {
  try { return fn(); } catch (e) {
    if (e?.code !== 'ERR_SQLITE_ERROR' || !/constraint failed/.test(e.message)) throw e;
    throw refusal('CONTACTS_OFFERS_INPUT_INVALID', `recruitment_offers ${offerId} ${part}: ${e.message}`);
  }
}
const revisionPointerSql = 'UPDATE offer_revisions SET supersedes_revision_id = @supersedes_revision_id, superseded_by_revision_id = @superseded_by_revision_id, response_id = @response_id, discarded_by_response_id = @discarded_by_response_id WHERE id = @id';
/**
 * A whole offer, inserted. The revisions go in before the rows that name them; their own pointers (to each other and
 * to the responses) are set last, so every key inside the offer is checked as it is written. The current-revision
 * pointer is checked here too: its key is deferred (the offer row is written before its revisions).
 */
function insertOffer(sqlite, st, o) {
  caseMustExist(st, 'recruitment_offers', o);
  const id = o.id;
  offerStep(id, 'row', () => st.offer.run(offerRow(o)));
  (o.revisions ?? []).forEach((r, i) => {
    offerStep(id, `revision ${r.id}`, () => st.revision.run(revisionRow(id, r, i)));
    (r.documents ?? []).forEach((d, j) => offerStep(id, `revision ${r.id} document ${d.id}`, () => st.doc.run(documentRow(r.id, d, j))));
  });
  (o.responses ?? []).forEach((x, i) => offerStep(id, `response ${x.id}`, () => st.response.run(responseRow(id, x, i))));
  const pointers = sqlite.prepare(revisionPointerSql);
  for (const r of o.revisions ?? []) offerStep(id, `revision ${r.id} pointers`, () => pointers.run({ id: r.id, ...revisionPointers(r) }));
  (o.readReceipts ?? []).forEach((x, i) => offerStep(id, `read receipt ${i}`, () => st.receipt.run(receiptRow(id, x, i))));
  (o.history ?? []).forEach((h, i) => offerStep(id, `history ${h.id}`, () => st.ohist.run(offerHistoryRow(id, h, i))));
  for (const act of OFFER_KEY_LISTS) (o.keys?.[act] ?? []).forEach((e, i) => offerStep(id, `${act} key ${i}`, () => st.okey.run({ offer_id: id, act, position: i, key: e.key, revision_id: e.revisionId })));
  if (!sqlite.prepare('SELECT 1 FROM offer_revisions WHERE offer_id = ? AND id = ?').get(id, o.currentRevisionId)) {
    throw refusal('CONTACTS_OFFERS_INPUT_INVALID', `recruitment_offers ${id} currentRevisionId: ${o.currentRevisionId} is not a revision of this offer`);
  }
}

/**
 * The statements `decodeContact` and `decodeOffer` read children through, answered for many records at once: each
 * child table read once for the whole list (an offer's documents through its revisions) instead of two
 * queries a contact and five an offer plus one a revision. Same rows, same order.
 */
function batchStatements(sqlite, st, { contactIds = [], offerIds = [] }) {
  const rows = (table, col, ids, order = 'position') => childRowsOf(sqlite, table, col, ids, { order });
  const revisionsOf = rows('offer_revisions', 'offer_id', offerIds);
  const revisionIds = offerIds.flatMap((id) => revisionsOf.all(id).map((r) => r.id));
  return {
    ...st,
    attemptsOf: rows('contact_attempts', 'contact_id', contactIds), chistOf: rows('contact_history', 'contact_id', contactIds),
    revisionsOf, docsOf: rows('offer_revision_documents', 'revision_id', revisionIds),
    responsesOf: rows('offer_responses', 'offer_id', offerIds), receiptsOf: rows('offer_read_receipts', 'offer_id', offerIds),
    ohistOf: rows('offer_history', 'offer_id', offerIds), okeysOf: rows('offer_keys', 'offer_id', offerIds, 'act, position'),
  };
}

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
export const readContacts = (sqlite) => { const st = statements(sqlite); const rows = st.contactAll.all(); const bst = batchStatements(sqlite, st, { contactIds: rows.map((r) => r.id) }); return rows.map((r) => decodeContact(bst, r)); };
export const readOffers = (sqlite) => { const st = statements(sqlite); const rows = st.offerAll.all(); const bst = batchStatements(sqlite, st, { offerIds: rows.map((r) => r.id) }); return rows.map((r) => decodeOffer(bst, r)); };

// ------------------------------------------------------------------ references (Q8c-a counted)
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


// ------------------------------------------------------------------ the whole-domain read
export const CONTACTS_OFFERS_RECORDS = {
  names: RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS,
  read(sqlite) { if (!recruitmentContactsOffersLive(sqlite)) return null; return { recruitmentContacts: readContacts(sqlite), recruitmentOffers: readOffers(sqlite) }; },
};

// ------------------------------------------------------------------ the repository
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
 * Every query runs on the one connection, so a read inside a unit of work sees the unit's own uncommitted writes. Each
 * record handed out is a fresh, deep-frozen decode of its rows: an in-place edit throws, and a change is
 * `update(id, (draft) => …)`. Lists come back in insertion (rowid) order.
 */
export function createRecruitmentContactsOffersRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the recruitment contacts/offers repository needs a SQLite connection (node:sqlite)');
  const st = statements(sqlite);
  const operation = (fn) => (unit?.active?.() ? unit.join(fn) : sqlite.isTransaction ? fn() : transaction(sqlite, fn));
  const decode = { recruitmentContacts: (row) => deepFreeze(decodeContact(st, row)), recruitmentOffers: (row) => deepFreeze(decodeOffer(st, row)) };
  const rowById = { recruitmentContacts: st.contactById, recruitmentOffers: st.offerById };
  const read = (name, id) => { if (typeof id !== 'string') return null; const row = rowById[name].get(id); return row ? decode[name](row) : null; };
  const must = (name, id) => { const r = read(name, id); if (!r) throw refusal('CONTACTS_OFFERS_NOT_FOUND', `${name} ${id} is not a record of the repository`); return r; };
  const typedContact = (raw) => { const t = typeContact(raw, 'recruitmentContacts'); if (!t.ok) throw refusal('CONTACTS_OFFERS_INPUT_INVALID', t.reason); return t.record; };
  const IMMUTABLE = ['id', 'orgId', 'caseId', 'playerId', 'createdAt'];
  /** Decode many rows; a list reads its records' children in one batch (batchStatements). */
  const BATCHED = { recruitmentContacts: [decodeContact, 'contactIds'], recruitmentOffers: [decodeOffer, 'offerIds'] };
  const decodeAll = (name, rows) => {
    if (rows.length < 2) return rows.map(decode[name]);
    const [decodeOne, key] = BATCHED[name];
    const bst = batchStatements(sqlite, st, { [key]: rows.map((r) => r.id) });
    return rows.map((r) => deepFreeze(decodeOne(bst, r)));
  };
  const queries = (name, sql) => Object.fromEntries(Object.entries(sql).map(([k, q]) => { const stmt = sqlite.prepare(q); return [k, (...args) => decodeAll(name, stmt.all(...args))]; }));
  /** The records naming any of `values` in `col`, in insertion order. */
  const inList = (name, table, col) => (values) => { const want = [...new Set((values ?? []).filter((v) => typeof v === 'string'))]; if (!want.length) return []; return decodeAll(name, sqlite.prepare(`SELECT * FROM ${table} WHERE ${col} IN (${want.map(() => '?').join(',')}) ORDER BY rowid`).all(...want)); };
  const countOf = (table) => sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`);
  const counters = { recruitmentContacts: countOf('recruitment_contacts'), recruitmentOffers: countOf('recruitment_offers') };

  /** `create(record)`: a new contact, typed whole; an existing id is refused. */
  const createContact = (raw) => operation(() => {
    const r = typedContact(raw);
    if (st.contactById.get(r.id)) throw refusal('CONTACTS_OFFERS_DUPLICATE', `recruitment_contacts ${r.id} already exists`);
    writeContact(st, r); return must('recruitmentContacts', r.id);
  });
  /**
   * `update(id, change)`: `change` receives a plain copy of the stored contact and edits it (or returns a replacement);
   * the result is typed whole and written at once. The identifiers and the creation instant cannot change.
   */
  const updateContact = (id, change) => operation(() => {
    if (typeof change !== 'function') throw new TypeError('recruitmentContacts.update(id, change) needs a function that edits the copy it is given');
    const stored = must('recruitmentContacts', id);
    const draft = clone(stored);
    const returned = change(draft);
    const next = typedContact(returned === undefined ? draft : returned);
    for (const k of IMMUTABLE) if (next[k] !== stored[k]) throw refusal('CONTACTS_OFFERS_INPUT_INVALID', `recruitment_contacts ${id}: ${k} cannot change`);
    writeContact(st, next); return must('recruitmentContacts', id);
  });

  const contactHistoryFrom = (orgId, actions) => ({ from: 'contact_history h JOIN recruitment_contacts c ON c.id = h.contact_id', where: `c.org_id = ? AND h.action IN (${actions.map(() => '?').join(', ') || 'NULL'})`, params: [orgId, ...actions] });
  const contacts = {
    create: createContact, update: updateContact,
    /** One contact by id, or null. Callers check the organisation and case they expect. */
    byId: (id) => read('recruitmentContacts', id),
    /** forCase(caseId), forOrgPlayer(orgId, playerId), forPlayer(playerId), forRequest(requestId), forAgent(agentUserId), forOrg(orgId). */
    ...queries('recruitmentContacts', CONTACT_READS),
    /** The contacts of several cases (a player's journeys), in insertion order. */
    forCases: inList('recruitmentContacts', 'recruitment_contacts', 'case_id'),
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
  // ---- offers: every write is a named act on the offer's own rows.
  const sqlCache = new Map();
  const q = (sql) => { let s = sqlCache.get(sql); if (!s) sqlCache.set(sql, (s = sqlite.prepare(sql))); return s; };
  const offerMust = (id) => must('recruitmentOffers', id);
  const offerExists = (id) => { if (!st.offerById.get(id)) throw refusal('CONTACTS_OFFERS_NOT_FOUND', `recruitment_offers ${id} is not a record of the repository`); };
  const nextPosition = (table, offerId, act = null) => (act === null
    ? q(`SELECT COALESCE(MAX(position) + 1, 0) AS p FROM ${table} WHERE offer_id = ?`).get(offerId)
    : q(`SELECT COALESCE(MAX(position) + 1, 0) AS p FROM ${table} WHERE offer_id = ? AND act = ?`).get(offerId, act)).p;
  const assign = (cols) => Object.keys(cols).map((c) => `${c} = @${c}`).join(', ');
  const stamp = (prefix, a) => ({ [`${prefix}_user_id`]: a?.id ?? null, [`${prefix}_name`]: a?.name ?? null, [`${prefix}_role`]: a?.role ?? null });
  /**
   * Move one revision into `to`, only from a status the domain's transition table leads from. A revision anywhere else
   * means a gate let through a move it should have refused: the unit rolls back.
   */
  const moveRevision = (offerId, revisionId, to, cols = {}) => {
    const from = OFFER_STATUSES.filter((st0) => OFFER_REVISION_TRANSITIONS[st0].includes(to));
    const r = q(`UPDATE offer_revisions SET status = @to${Object.keys(cols).length ? `, ${assign(cols)}` : ''} WHERE id = @rid AND offer_id = @oid AND status IN (${from.map((x) => `'${x}'`).join(', ')})`)
      .run({ ...cols, to, rid: revisionId, oid: offerId });
    if (r.changes !== 1) throw refusal('CONTACTS_OFFERS_STATE_CONFLICT', `offer_revisions ${revisionId} of recruitment_offers ${offerId} cannot move to ${to} from where it is`);
  };
  const setOffer = (id, cols) => q(`UPDATE recruitment_offers SET ${assign(cols)} WHERE id = @id`).run({ ...cols, id });
  const insertRevision = (offerId, r) => {
    offerStep(offerId, `revision ${r.id}`, () => st.revision.run(revisionRow(offerId, r, nextPosition('offer_revisions', offerId))));
    offerStep(offerId, `revision ${r.id} pointers`, () => q(revisionPointerSql).run({ id: r.id, ...revisionPointers(r) }));
    replaceDocuments(offerId, r.id, r.documents ?? []);
  };
  const replaceDocuments = (offerId, revisionId, documents) => {
    q('DELETE FROM offer_revision_documents WHERE revision_id = ?').run(revisionId);
    documents.forEach((d, j) => offerStep(offerId, `revision ${revisionId} document ${d.id}`, () => st.doc.run(documentRow(revisionId, d, j))));
  };
  /**
   * The bookkeeping an act leaves on its offer: the outcome of the case move it asked for, its client key, the rev
   * bumps, the last-changed instant and its history entries (history is only ever appended).
   */
  const applyAct = (id, { at = null, revBy = null, touch = false, bumpOffer = false, bumpRevisionId = null, lifecycle, key = null, history = [] } = {}) => {
    const rev = { rev_at: at, rev_by_user_id: revBy?.id ?? null, rev_by_name: revBy?.name ?? null };
    if (bumpRevisionId) q(`UPDATE offer_revisions SET rev = rev + 1, ${assign(rev)} WHERE id = @rid AND offer_id = @oid`).run({ ...rev, rid: bumpRevisionId, oid: id });
    const cols = { ...(touch ? { updated_at: at } : {}), ...(lifecycle !== undefined ? lifecycleCols(lifecycle) : {}) };
    if (bumpOffer) q(`UPDATE recruitment_offers SET rev = rev + 1, ${assign(rev)} WHERE id = @id`).run({ ...rev, id });
    if (Object.keys(cols).length) setOffer(id, cols);
    if (key) offerStep(id, `${key.act} key`, () => st.okey.run({ offer_id: id, act: key.act, position: nextPosition('offer_keys', id, key.act), key: key.key, revision_id: key.revisionId }));
    for (const h of history) offerStep(id, `history ${h.id}`, () => st.ohist.run(offerHistoryRow(id, h, nextPosition('offer_history', id))));
  };
  const act = (fn) => (id, ...args) => operation(() => { offerExists(id); fn(id, ...args); return offerMust(id); });

  const offers = {
    /** A new offer, whole: the club's first draft, or a fixture's record. An existing id is refused. */
    create: (o) => operation(() => {
      if (!isPlainObject(o) || !nonEmpty(o.id)) throw refusal('CONTACTS_OFFERS_INPUT_INVALID', 'recruitment_offers: a record needs an id');
      if (st.offerById.get(o.id)) throw refusal('CONTACTS_OFFERS_DUPLICATE', `recruitment_offers ${o.id} already exists`);
      insertOffer(sqlite, st, o);
      return offerMust(o.id);
    }),
    /**
     * Change a DRAFT revision's content (`documents` undefined keeps them). There is no other write of a revision's
     * terms, so an issued revision is frozen by construction.
     */
    editDraft: act((id, revisionId, { at, by, terms, recipientMessage, internalNote, expiresAt, documents }, bookkeeping) => {
      const cols = { ...termCols(terms), recipient_message: recipientMessage ?? null, internal_note: internalNote ?? null, expires_at: expiresAt ?? null, updated_at: at, ...stamp('updated_by', by) };
      const r = q(`UPDATE offer_revisions SET ${assign(cols)} WHERE id = @rid AND offer_id = @oid AND status = 'DRAFT'`).run({ ...cols, rid: revisionId, oid: id });
      if (r.changes !== 1) throw refusal('CONTACTS_OFFERS_STATE_CONFLICT', `offer_revisions ${revisionId} of recruitment_offers ${id} is not a draft`);
      if (documents !== undefined) replaceDocuments(id, revisionId, documents);
      setOffer(id, { type: terms.offerType });
      applyAct(id, bookkeeping);
    }),
    /** Issue a DRAFT revision with its final terms and the recipient and readiness it was issued against; it supersedes the revision it names. */
    issueRevision: act((id, revisionId, { at, by, terms, recipientSnapshot, readinessSnapshot, supersedesRevisionId = null }, bookkeeping) => {
      moveRevision(id, revisionId, 'ISSUED', { ...termCols(terms), issued_at: at, ...stamp('issued_by', by), ...recipientCols(recipientSnapshot), ...readinessCols(readinessSnapshot) });
      if (supersedesRevisionId) moveRevision(id, supersedesRevisionId, 'SUPERSEDED', { superseded_by_revision_id: revisionId, superseded_at: at });
      setOffer(id, { status: 'ISSUED' });
      applyAct(id, bookkeeping);
    }),
    withdrawRevision: act((id, revisionId, { at, by, reason = null }, bookkeeping) => {
      moveRevision(id, revisionId, 'WITHDRAWN', { withdrawn_at: at, ...stamp('withdrawn_by', by), withdraw_reason: reason });
      setOffer(id, { status: 'WITHDRAWN' });
      applyAct(id, bookkeeping);
    }),
    /** A new DRAFT revision, which becomes the current one. */
    addRevision: act((id, revision, bookkeeping) => {
      insertRevision(id, revision);
      setOffer(id, { current_revision_id: revision.id, status: 'DRAFT' });
      applyAct(id, bookkeeping);
    }),
    /**
     * The recipient's answer to an ISSUED revision. A draft open beside it is discarded (recorded WITHDRAWN, naming the
     * answer), and the answered revision becomes the current one.
     */
    recordResponse: act((id, response, { discardRevisionId = null } = {}, bookkeeping) => {
      offerStep(id, `response ${response.id}`, () => st.response.run(responseRow(id, response, nextPosition('offer_responses', id))));
      const to = response.responseType === 'accepted' ? 'ACCEPTED' : 'DECLINED';
      moveRevision(id, response.revisionId, to, { responded_at: response.occurredAt, response_id: response.id });
      if (discardRevisionId) {
        moveRevision(id, discardRevisionId, 'WITHDRAWN', { withdrawn_at: response.occurredAt, ...stamp('withdrawn_by', null), withdraw_reason: null, discarded_by_response_id: response.id });
        setOffer(id, { current_revision_id: response.revisionId });
      }
      setOffer(id, { status: to });
      applyAct(id, bookkeeping);
    }),
    addReadReceipt: act((id, receipt, bookkeeping) => {
      offerStep(id, 'read receipt', () => st.receipt.run(receiptRow(id, receipt, nextPosition('offer_read_receipts', id))));
      applyAct(id, bookkeeping);
    }),
    /** The recipient's share with their agent, or `null` to clear it. */
    setAgentShare: act((id, share, bookkeeping) => {
      offerStep(id, 'agent share', () => setOffer(id, agentShareCols(share)));
      applyAct(id, bookkeeping);
    }),
    /** The bookkeeping alone, for the second half of an act whose case move came in between. */
    recordAct: act((id, bookkeeping) => applyAct(id, bookkeeping)),
    /** One offer by id, or null. Callers check the organisation they expect. */
    byId: (id) => read('recruitmentOffers', id),
    /** forCase(caseId), forOrgPlayer(orgId, playerId), forPlayer(playerId), forAgentShare(agentUserId), forOrg(orgId). */
    ...queries('recruitmentOffers', OFFER_READS),
    /** The offers of several players (a guardian's children), in insertion order. */
    forPlayers: inList('recruitmentOffers', 'recruitment_offers', 'player_id'),
    /** The offers of several cases (a player's journeys), in insertion order. */
    forCases: inList('recruitmentOffers', 'recruitment_offers', 'case_id'),
    /** The deletion unit: ids, states and times stay; the player's name and words go; subject_removed_at set. */
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

  const WRITES = ['create', 'update', 'redactPlayer', 'editDraft', 'issueRevision', 'withdrawRevision', 'addRevision', 'recordResponse', 'addReadReceipt', 'setAgentShare', 'recordAct'];
  const readOnly = (o) => Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => !WRITES.includes(k))));
  return {
    contacts, offers,
    /** The queries alone, for the pure projectors and providers that must not write (the evidence provider, the journey). */
    reads: Object.freeze({ contacts: readOnly(contacts), offers: readOnly(offers) }),
    /** Check migration 0017 is recorded; there is nothing to load. */
    attach() {
      if (!recruitmentContactsOffersLive(sqlite)) throw new Error(`the recruitment contacts/offers repository needs ${RECRUITMENT_CONTACTS_OFFERS_MIGRATION} recorded; it never imports an in-memory array`);
      return { counts: this.counts() };
    },
    counts() { return Object.fromEntries(RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS.map((n) => [n, counters[n].get().n])); },
    pending: () => 0,
    exportAll() { return CONTACTS_OFFERS_RECORDS.read(sqlite); },
    log,
    now,
  };
}
