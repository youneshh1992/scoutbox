/**
 * S11c — the Agent Transaction Workspace as typed tables (migration `0029_agent_transactions`;
 * docs/architecture/migration.md §4.5 S11c; sql/06_agent_compliance_transactions.sql).
 *
 * Records:
 *   - A transaction: the multi-party workspace an agent opens. Ordered jurisdictions and parties (one live party per
 *     role), its compliance snapshot, scoped notes, linked Inbox threads, recorded terms versions, the replay keys of
 *     its party and status requests, and its append-only history. It owns exactly one compliance context.
 *   - A representation binding: the (agent, party role, transaction) triple with its own lifecycle, review link, rev
 *     and history — the conflict engine's unit of evaluation.
 *   - A document: a classification of a record in the canonical evidence vault (or a placeholder), with its visibility
 *     class, version chain, expiry, rev and history. It stores no bytes.
 *
 * The compliance snapshot names the evaluation row it was taken from (`compliance_evaluations`, a key), or the facet
 * gate that refused before the engine ran; with the pending reason it reached, the party revision it was taken under
 * and the licence freshness. The outcome, reason codes, policy versions and consent requirements are the evaluation's
 * own and are read back from its row (snapshotView in domains/agents/transactions/transaction.mjs), never copied.
 *
 * History. Ordered rows; a detail is typed columns (the timeline's allowlist: from/to, party role, subject kind,
 * status, outcome, pending reason, document type, visibility, staleness, reason code, version, count) with its reason
 * codes and policy versions as item rows. A document's entries repeat the document's own fields (worked out on read).
 *
 * WRITES are explicit: `create(record)` and `update(id, (draft) => …)` type the whole record and write it at once,
 * joined into the open unit of work, the caller's open transaction, or a transaction of their own; an unknown field and
 * an update from inside its own update are refused. History, notes, terms, linked threads and keys only grow. An
 * account deletion is `forgetPlayer`.
 *
 * READS are SQL: no mirror. Records are fresh and deep-frozen; a list decodes its child rows in one batch.
 *
 * References. Agencies → orgs and staff → org_users (RESTRICT); the context and the snapshot's evaluation →
 * compliance_contexts / compliance_evaluations; a representation's agreement and reviews → representation_agreements /
 * regulatory_reviews; a document's evidence → ver_evidence; the cited recruitment case → recruitment_cases; within the
 * domain, a representation's and a document's transaction and a document's version chain (RESTRICT). A party's player
 * or club, a document owner's id, a linked thread's channel and the trial and opportunity links carry no key (tolerant:
 * a channel goes with a deleted player, a trial or an opportunity can be deleted; the record keeps the fact). Child
 * rows cascade.
 */
import { isPlainObject, describe } from './recruitment.mjs';
import { transaction, migrationApplied } from './database.mjs';
import { deepFreeze } from './scoutingEvidence.mjs';
import { quote } from './fieldSpecs.mjs';
import { REPRESENTATION_STATUSES } from './complianceRecords.mjs';
import { VERIFICATION_STATES, SCOPES } from '../domains/agents/core/shared.mjs';
import { CONFLICT_OUTCOMES, CONTEXT_TYPES, PARTY_ROLES } from '../domains/agents/compliance/conflict.mjs';
import { TRANSACTION_STATUSES, LIVE_STATUSES, TERMINAL_STATUSES, RELEASING_PARTY_TYPES, DOCUMENT_TYPES, DOCUMENT_VISIBILITY, NOTE_VISIBILITY, PENDING_REASONS, COMPLIANCE_GATES, STALENESS_REASONS, WITHDRAWN_REASONS, HOLD_REASON_CODES, CANCEL_REASON_CODES, CLOSE_REASON_CODES, TRANSACTION_LIMITS } from '../domains/agents/transactions/transaction.mjs';

export const AGENT_TRANSACTIONS_MIGRATION = '0029_agent_transactions';
export const AGENT_TRANSACTIONS_COLLECTIONS = Object.freeze(['agentTransactions', 'transactionRepresentations', 'transactionDocuments']);

// ------------------------------------------------------------------ vocabularies and limits (one definition; the routes import them)
export const AGENT_TRANSACTION_LIMITS = Object.freeze({
  id: 80, evaluationId: 100, name: 200, key: 64, fp: 4000, code: 60, jurisdictions: 10,
  note: TRANSACTION_LIMITS.note, label: TRANSACTION_LIMITS.label, reason: TRANSACTION_LIMITS.reason,
  partyRows: TRANSACTION_LIMITS.parties * 3, notes: TRANSACTION_LIMITS.notes, linkedThreads: TRANSACTION_LIMITS.linkedThreads, terms: TRANSACTION_LIMITS.termsVersions,
});
const L = AGENT_TRANSACTION_LIMITS;
export const SUBJECT_KINDS = Object.freeze(['player', 'club']);
export const ACTOR_KINDS = Object.freeze(['org', 'player', 'club_user', 'ts_reviewer', 'system']);
export const OWNER_KINDS = Object.freeze(['agent', 'club', 'player']);
export const REASON_CODES = Object.freeze([...new Set([...HOLD_REASON_CODES, ...CANCEL_REASON_CODES, ...CLOSE_REASON_CODES])]);
export const TRANSACTION_ACTIONS = Object.freeze([
  'transaction_created', 'transaction_party_added', 'transaction_party_removed', 'transaction_party_confirmed',
  'transaction_status_changed', 'transaction_held', 'transaction_cancelled', 'transaction_closed', 'transaction_archived',
  'transaction_compliance_evaluated', 'transaction_compliance_stale', 'transaction_document_added', 'transaction_document_superseded',
  'transaction_message_linked', 'transaction_terms_recorded', 'transaction_representation_attached', 'transaction_representation_withdrawn',
  'transaction_note_added', 'transaction_subject_tombstoned',
]);
export const REPRESENTATION_ACTIONS = Object.freeze(['transaction_representation_attached', 'transaction_representation_withdrawn']);
export const DOCUMENT_ACTIONS = Object.freeze(['transaction_document_added', 'transaction_document_superseded']);
const KEY_ACTIONS = Object.freeze(['party', 'status']);
/** The scalar keys a history detail may carry: record key, column, vocabulary (or 'int'). The timeline's allowlist. */
const DETAIL_SCALARS = Object.freeze([
  ['from', 'detail_from', TRANSACTION_STATUSES], ['to', 'detail_to', TRANSACTION_STATUSES], ['partyRole', 'detail_party_role', PARTY_ROLES],
  ['subjectKind', 'detail_subject_kind', SUBJECT_KINDS], ['status', 'detail_status', REPRESENTATION_STATUSES], ['outcome', 'detail_outcome', CONFLICT_OUTCOMES],
  ['pendingReason', 'detail_pending_reason', PENDING_REASONS], ['documentType', 'detail_document_type', DOCUMENT_TYPES], ['visibility', 'detail_visibility', DOCUMENT_VISIBILITY],
  ['staleness', 'detail_staleness', STALENESS_REASONS], ['holdReasonCode', 'detail_reason_code', REASON_CODES], ['version', 'detail_version', 'int'], ['count', 'detail_count', 'int'],
]);
const REP_DETAIL_SCALARS = DETAIL_SCALARS.filter(([k]) => ['partyRole', 'status'].includes(k));

// ------------------------------------------------------------------ DDL
const inList = (c, vals) => `${c} IN (${vals.map(quote).join(',')})`;
const optIn = (c, vals) => `${c}  TEXT CHECK (${c} IS NULL OR ${inList(c, vals)})`;
const reqIn = (c, vals) => `${c}  TEXT NOT NULL CHECK (${inList(c, vals)})`;
const txt = (c, max = L.id, notNull = false) => `${c}  TEXT${notNull ? ' NOT NULL' : ''} CHECK (${notNull ? '' : `${c} IS NULL OR `}(length(${c}) > 0 AND length(${c}) <= ${max}))`;
const name = (c) => `${c}  TEXT CHECK (${c} IS NULL OR length(${c}) <= ${L.name})`;
const MA = (c, notNull = false) => `${c}  TEXT${notNull ? ' NOT NULL' : ''} CHECK (${notNull ? '' : `${c} IS NULL OR `}${c} GLOB '[A-Z][A-Z][A-Z]')`;
const BY_COLS = [reqIn('by_kind', ACTOR_KINDS), txt('by_id'), name('by_name'), `by_role  TEXT CHECK (by_role IS NULL OR length(by_role) <= 60)`, txt('by_org_id')];
const KEY_COLS = (slot) => [txt(`${slot}_key`, L.key), `${slot}_fp  TEXT CHECK ((${slot}_fp IS NULL OR length(${slot}_fp) <= ${L.fp}) AND ((${slot}_key IS NULL) = (${slot}_fp IS NULL)))`];
const REV_COLS = ['rev  INTEGER NOT NULL CHECK (rev >= 1)', 'rev_at  INTEGER', txt('rev_by_id'), name('rev_by_name')];
const listTable = (table, owner, ownerTable, col, colDef) => `CREATE TABLE ${table} (
  ${owner}  TEXT NOT NULL REFERENCES ${ownerTable}(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0),
  ${col}  ${colDef},
  PRIMARY KEY (${owner}, ord),
  UNIQUE (${owner}, ${col})
) STRICT;`;
const POLICY_REF = 'TEXT NOT NULL REFERENCES jurisdiction_policies(id) ON DELETE RESTRICT';
const CODE = `TEXT NOT NULL CHECK (length(code) > 0 AND length(code) <= ${L.code})`;
const DETAIL_COLS = DETAIL_SCALARS.map(([, c, vals]) => (vals === 'int' ? `${c}  INTEGER CHECK (${c} IS NULL OR ${c} >= 0)` : optIn(c, vals)));
const HISTORY_HEAD = (owner, ownerTable) => [
  'id  TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80)',
  `${owner}  TEXT NOT NULL REFERENCES ${ownerTable}(id) ON DELETE CASCADE`,
  'ord  INTEGER NOT NULL CHECK (ord >= 0)', 'at  INTEGER NOT NULL', ...BY_COLS,
];

export const AGENT_TRANSACTIONS_DDL = [
  `CREATE TABLE agent_transactions (
  id  TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= ${L.id}),
  agency_org_id  TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  agent_user_id  TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  ${reqIn('type', CONTEXT_TYPES)},
  ${reqIn('status', TRANSACTION_STATUSES)},
  context_id  TEXT NOT NULL UNIQUE REFERENCES compliance_contexts(id) ON DELETE RESTRICT,
  compliance_evaluation_id  TEXT REFERENCES compliance_evaluations(id) ON DELETE RESTRICT,
  ${optIn('compliance_gate', COMPLIANCE_GATES)},
  compliance_evaluated_at  INTEGER,
  ${optIn('compliance_pending_reason', PENDING_REASONS)},
  ${optIn('compliance_verification_freshness', VERIFICATION_STATES)},
  compliance_party_revision  TEXT CHECK (compliance_party_revision IS NULL OR (length(compliance_party_revision) = 64 AND compliance_party_revision NOT GLOB '*[^0-9a-f]*')),
  re_evaluation_pending  INTEGER NOT NULL CHECK (re_evaluation_pending IN (0,1)),
  ${txt('link_trial_id')},
  ${txt('link_opportunity_id')},
  link_recruitment_case_id  TEXT REFERENCES recruitment_cases(id) ON DELETE RESTRICT,
  ${optIn('hold_reason_code', HOLD_REASON_CODES)},
  ${txt('hold_reason', L.reason)},
  held_at  INTEGER,
  ${optIn('cancel_reason_code', CANCEL_REASON_CODES)},
  cancelled_at  INTEGER,
  ${optIn('close_reason_code', CLOSE_REASON_CODES)},
  closed_at  INTEGER,
  archived_at  INTEGER,
  ${name('initiated_by_name')},
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  ${KEY_COLS('create').join(',\n  ')},
  rev  INTEGER NOT NULL CHECK (rev >= 1),
  rev_at  INTEGER,
  ${name('rev_by_label')},
  CHECK (compliance_evaluation_id IS NULL OR compliance_gate IS NULL),
  CHECK ((compliance_evaluated_at IS NULL) = (compliance_evaluation_id IS NULL AND compliance_gate IS NULL)),
  CHECK ((compliance_evaluated_at IS NULL) = (compliance_party_revision IS NULL)),
  CHECK (compliance_gate IS NULL OR compliance_pending_reason = compliance_gate),
  CHECK (compliance_evaluated_at IS NOT NULL OR (compliance_pending_reason IS NULL AND compliance_verification_freshness IS NULL)),
  CHECK ((hold_reason_code IS NULL) = (held_at IS NULL) AND (hold_reason IS NULL OR hold_reason_code IS NOT NULL)),
  CHECK ((cancel_reason_code IS NULL) = (cancelled_at IS NULL)),
  CHECK ((close_reason_code IS NULL) = (closed_at IS NULL))
) STRICT;`,
  'CREATE INDEX agent_transactions_agent ON agent_transactions(agency_org_id, agent_user_id, status);',
  'CREATE INDEX agent_transactions_status ON agent_transactions(status);',
  'CREATE INDEX agent_transactions_case ON agent_transactions(link_recruitment_case_id) WHERE link_recruitment_case_id IS NOT NULL;',
  'CREATE UNIQUE INDEX agent_transactions_create_key ON agent_transactions(agency_org_id, agent_user_id, create_key) WHERE create_key IS NOT NULL;',
  `CREATE TABLE agent_transaction_jurisdictions (
  transaction_id  TEXT NOT NULL REFERENCES agent_transactions(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0 AND ord < ${L.jurisdictions}),
  ${MA('member_association', true)},
  PRIMARY KEY (transaction_id, ord),
  UNIQUE (transaction_id, member_association)
) STRICT;`,
  `CREATE TABLE transaction_parties (
  id  TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= ${L.id}),
  transaction_id  TEXT NOT NULL REFERENCES agent_transactions(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0 AND ord < ${L.partyRows}),
  ${reqIn('party_role', PARTY_ROLES)},
  ${reqIn('subject_kind', SUBJECT_KINDS)},
  ${txt('subject_id', L.id, true)},
  added_at  INTEGER NOT NULL,
  added_by_id  TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  ${name('added_by_name')},
  removed  INTEGER NOT NULL CHECK (removed IN (0,1)),
  removed_at  INTEGER,
  confirmed_at  INTEGER,
  ${optIn('confirmed_by_kind', ['player', 'club_user'])},
  ${txt('confirmed_by_id')},
  ${name('confirmed_by_name')},
  ${txt('confirmed_by_org_id')},
  subject_removed_at  INTEGER,
  UNIQUE (transaction_id, ord),
  CHECK (subject_kind <> 'player' OR party_role = 'individual'),
  CHECK (subject_kind <> 'club' OR party_role <> 'individual'),
  CHECK ((removed = 1) = (removed_at IS NOT NULL)),
  CHECK ((confirmed_at IS NULL) = (confirmed_by_kind IS NULL)),
  CHECK ((confirmed_by_kind = 'club_user') = (confirmed_by_org_id IS NOT NULL)),
  CHECK (subject_removed_at IS NULL OR removed = 1)
) STRICT;`,
  'CREATE INDEX transaction_parties_subject ON transaction_parties(subject_kind, subject_id) WHERE removed = 0;',
  'CREATE UNIQUE INDEX transaction_parties_live_role ON transaction_parties(transaction_id, party_role) WHERE removed = 0;',
  `CREATE TABLE transaction_notes (
  id  TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= ${L.id}),
  transaction_id  TEXT NOT NULL REFERENCES agent_transactions(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0 AND ord < ${L.notes}),
  ${reqIn('visibility', NOTE_VISIBILITY)},
  ${txt('text', L.note, true)},
  ${reqIn('by_kind', ['org', 'club_user'])},
  ${txt('by_id')},
  ${name('by_name')},
  ${txt('by_org_id')},
  at  INTEGER NOT NULL,
  UNIQUE (transaction_id, ord),
  CHECK ((by_kind = 'club_user') = (by_org_id IS NOT NULL))
) STRICT;`,
  `CREATE TABLE transaction_linked_threads (
  id  TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= ${L.id}),
  transaction_id  TEXT NOT NULL REFERENCES agent_transactions(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0 AND ord < ${L.linkedThreads}),
  ${txt('channel_id', L.id, true)},
  ${txt('linked_by_id')},
  ${name('linked_by_name')},
  ${txt('linked_by_org_id', L.id, true)},
  linked_at  INTEGER NOT NULL,
  UNIQUE (transaction_id, ord),
  UNIQUE (transaction_id, channel_id)
) STRICT;`,
  `CREATE TABLE transaction_terms_versions (
  id  TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= ${L.id}),
  transaction_id  TEXT NOT NULL REFERENCES agent_transactions(id) ON DELETE CASCADE,
  version  INTEGER NOT NULL CHECK (version >= 1 AND version <= ${L.terms}),
  recorded_at  INTEGER NOT NULL,
  recorded_by_id  TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  ${name('recorded_by_name')},
  ${reqIn('recorded_for', PARTY_ROLES)},
  ${reqIn('visibility', NOTE_VISIBILITY)},
  ${txt('summary', L.note, true)},
  UNIQUE (transaction_id, version)
) STRICT;`,
  `CREATE TABLE transaction_keys (
  transaction_id  TEXT NOT NULL REFERENCES agent_transactions(id) ON DELETE CASCADE,
  ${reqIn('action', KEY_ACTIONS)},
  ${txt('key', L.key, true)},
  fp  TEXT NOT NULL CHECK (length(fp) <= ${L.fp}),
  PRIMARY KEY (transaction_id, action, key)
) STRICT;`,
  `CREATE TABLE transaction_history (
  ${HISTORY_HEAD('transaction_id', 'agent_transactions').join(',\n  ')},
  ${reqIn('action', TRANSACTION_ACTIONS)},
  ${DETAIL_COLS.join(',\n  ')},
  has_reason_codes  INTEGER NOT NULL CHECK (has_reason_codes IN (0,1)),
  has_policy_versions  INTEGER NOT NULL CHECK (has_policy_versions IN (0,1)),
  UNIQUE (transaction_id, ord)
) STRICT;`,
  'CREATE INDEX transaction_history_status_moves ON transaction_history(transaction_id, ord) WHERE action = \'transaction_status_changed\';',
  listTable('transaction_history_reason_codes', 'history_id', 'transaction_history', 'code', CODE),
  listTable('transaction_history_policy_versions', 'history_id', 'transaction_history', 'policy_version_id', POLICY_REF),
  `CREATE TABLE transaction_representations (
  id  TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= ${L.id}),
  transaction_id  TEXT NOT NULL REFERENCES agent_transactions(id) ON DELETE RESTRICT,
  agency_org_id  TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  agent_user_id  TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  ${reqIn('party_role', PARTY_ROLES)},
  agreement_id  TEXT REFERENCES representation_agreements(id) ON DELETE RESTRICT,
  declared_only  INTEGER NOT NULL CHECK (declared_only IN (0,1)),
  ${MA('jurisdiction')},
  ${reqIn('status', REPRESENTATION_STATUSES)},
  review_id  TEXT REFERENCES regulatory_reviews(id) ON DELETE RESTRICT,
  created_at  INTEGER NOT NULL,
  verified_at  INTEGER,
  verified_by_review_id  TEXT REFERENCES regulatory_reviews(id) ON DELETE RESTRICT,
  first_act_at  INTEGER,
  withdrawn_at  INTEGER,
  ${optIn('withdrawn_reason', WITHDRAWN_REASONS)},
  ${KEY_COLS('attach').join(',\n  ')},
  ${REV_COLS.join(',\n  ')},
  CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL)),
  CHECK ((withdrawn_at IS NULL) = (withdrawn_reason IS NULL)),
  CHECK (status <> 'pending_review' OR (declared_only = 1 AND review_id IS NOT NULL)),
  CHECK (declared_only = 1 OR agreement_id IS NOT NULL OR verified_by_review_id IS NOT NULL)
) STRICT;`,
  'CREATE INDEX transaction_representations_transaction ON transaction_representations(transaction_id);',
  'CREATE INDEX transaction_representations_agency ON transaction_representations(agency_org_id);',
  'CREATE UNIQUE INDEX transaction_representations_live ON transaction_representations(transaction_id, party_role, agent_user_id) WHERE status <> \'withdrawn\';',
  'CREATE UNIQUE INDEX transaction_representations_attach_key ON transaction_representations(transaction_id, attach_key) WHERE attach_key IS NOT NULL;',
  listTable('transaction_representation_scopes', 'representation_id', 'transaction_representations', 'scope', `TEXT NOT NULL CHECK (${inList('scope', SCOPES)})`),
  `CREATE TABLE transaction_representation_history (
  ${HISTORY_HEAD('representation_id', 'transaction_representations').join(',\n  ')},
  ${reqIn('action', REPRESENTATION_ACTIONS)},
  ${REP_DETAIL_SCALARS.map(([, c, vals]) => optIn(c, vals)).join(',\n  ')},
  has_policy_versions  INTEGER NOT NULL CHECK (has_policy_versions IN (0,1)),
  UNIQUE (representation_id, ord)
) STRICT;`,
  listTable('transaction_representation_history_policy_versions', 'history_id', 'transaction_representation_history', 'policy_version_id', POLICY_REF),
  `CREATE TABLE transaction_documents (
  id  TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= ${L.id}),
  transaction_id  TEXT NOT NULL REFERENCES agent_transactions(id) ON DELETE RESTRICT,
  ${reqIn('document_type', DOCUMENT_TYPES)},
  ${reqIn('visibility', DOCUMENT_VISIBILITY)},
  ${txt('label', L.label, true)},
  version  INTEGER NOT NULL CHECK (version >= 1),
  ${reqIn('owner_kind', OWNER_KINDS)},
  ${txt('owner_id')},
  ${optIn('owner_party_role', PARTY_ROLES)},
  ${reqIn('uploaded_by_kind', ['org', 'club_user', 'player'])},
  ${txt('uploaded_by_id')},
  ${name('uploaded_by_name')},
  ${txt('uploaded_by_org_id')},
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER,
  evidence_id  TEXT REFERENCES ver_evidence(id) ON DELETE RESTRICT,
  supersedes_id  TEXT REFERENCES transaction_documents(id) ON DELETE RESTRICT,
  superseded_by_id  TEXT REFERENCES transaction_documents(id) ON DELETE RESTRICT,
  removed_at  INTEGER,
  ${KEY_COLS('add').join(',\n  ')},
  ${REV_COLS.join(',\n  ')},
  CHECK ((owner_kind = 'agent') = (owner_party_role IS NULL)),
  CHECK ((uploaded_by_kind = 'club_user') = (uploaded_by_org_id IS NOT NULL)),
  CHECK ((version = 1) = (supersedes_id IS NULL))
) STRICT;`,
  'CREATE INDEX transaction_documents_transaction ON transaction_documents(transaction_id);',
  'CREATE UNIQUE INDEX transaction_documents_superseded_once ON transaction_documents(supersedes_id) WHERE supersedes_id IS NOT NULL;',
  'CREATE UNIQUE INDEX transaction_documents_add_key ON transaction_documents(transaction_id, add_key) WHERE add_key IS NOT NULL;',
  `CREATE TABLE transaction_document_history (
  ${HISTORY_HEAD('document_id', 'transaction_documents').join(',\n  ')},
  ${reqIn('action', DOCUMENT_ACTIONS)},
  UNIQUE (document_id, ord)
) STRICT;`,
].join('\n');
export const AGENT_TRANSACTIONS_TABLES = Object.freeze([
  'agent_transactions', 'agent_transaction_jurisdictions', 'transaction_parties', 'transaction_notes', 'transaction_linked_threads',
  'transaction_terms_versions', 'transaction_keys', 'transaction_history', 'transaction_history_reason_codes', 'transaction_history_policy_versions',
  'transaction_representations', 'transaction_representation_scopes', 'transaction_representation_history', 'transaction_representation_history_policy_versions',
  'transaction_documents', 'transaction_document_history',
]);

// ------------------------------------------------------------------ typing (the one place a value is judged)
export const refusal = (code, message, extra = {}) => Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
const FAIL = (reason) => { throw refusal('AGENT_TRANSACTIONS_INPUT_INVALID', reason); };
const isId = (v, max = L.id) => typeof v === 'string' && v.length > 0 && v.length <= max;
const isText = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const isName = (v) => v === null || v === undefined || (typeof v === 'string' && v.length <= L.name);
const isInt = (v) => Number.isSafeInteger(v);
const optInt = (v) => v === null || v === undefined || Number.isSafeInteger(v);
const optId = (v) => v === null || v === undefined || isId(v);
const isMa = (v) => typeof v === 'string' && /^[A-Z]{3}$/.test(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Refuse unless `ok`, naming the record and the field (never the value). */
const need = (ok, at, field, what) => { if (!ok) FAIL(`${at}.${field} ${what}`); };
const keysOnly = (raw, allowed, at) => {
  need(isPlainObject(raw), at, 'record', `must be an object (got ${describe(raw)})`);
  const extra = Object.keys(raw).filter((k) => !allowed.includes(k));
  if (extra.length) FAIL(`${at} carries field(s) this build does not store: ${extra.join(', ')}`);
};
const inV = (v, vocab, at, field, { nullable = false } = {}) => need((nullable && (v === null || v === undefined)) || vocab.includes(v), at, field, `must be one of ${vocab.join('|')}${nullable ? ' or null' : ''} (got ${describe(v)})`);
const distinctList = (v, ok, at, field, { max = 50 } = {}) => {
  need(Array.isArray(v) && v.length <= max && v.every(ok) && new Set(v).size === v.length, at, field, `must be a list of at most ${max} distinct entries`);
  return [...v];
};
const keyPair = (v, at, field) => { keysOnly(v, ['key', 'fp'], `${at}.${field}`); need(isText(v.key, L.key) && typeof v.fp === 'string' && v.fp.length <= L.fp, at, field, 'must be { key, fp }'); return { key: v.key, fp: v.fp }; };

/** An actor `{ kind, userId, name, role?, orgId? }` (a reviewer carries their role, a club user their club). */
function typeBy(by, at, kinds = ACTOR_KINDS) {
  keysOnly(by, ['kind', 'userId', 'name', 'role', 'orgId'], at);
  inV(by.kind, kinds, at, 'kind');
  need(optId(by.userId), at, 'userId', 'must be an id or null');
  need(isName(by.name), at, 'name', `must be text of at most ${L.name} characters`);
  if (by.kind === 'ts_reviewer') need(typeof by.role === 'string' && by.role.length <= 60, at, 'role', 'names the reviewer\'s role'); else need(by.role === undefined, at, 'role', 'is a reviewer\'s only');
  if (by.kind === 'club_user') need(isId(by.orgId), at, 'orgId', 'names the club'); else need(by.orgId === undefined, at, 'orgId', 'is a club user\'s only');
  return { kind: by.kind, userId: by.userId ?? null, name: by.name ?? null, ...(by.kind === 'ts_reviewer' ? { role: by.role } : {}), ...(by.kind === 'club_user' ? { orgId: by.orgId } : {}) };
}
const byCols = (by, p = 'by') => ({ [`${p}_kind`]: by.kind, [`${p}_id`]: by.userId, [`${p}_name`]: by.name, [`${p}_role`]: by.role ?? null, [`${p}_org_id`]: by.orgId ?? null });
const byOfRow = (r, p = 'by') => ({ kind: r[`${p}_kind`], userId: r[`${p}_id`], name: r[`${p}_name`], ...(r[`${p}_kind`] === 'ts_reviewer' ? { role: r[`${p}_role`] } : {}), ...(r[`${p}_kind`] === 'club_user' ? { orgId: r[`${p}_org_id`] } : {}) });
const typeRev = (r, at) => {
  need(isInt(r.rev) && r.rev >= 1, at, 'rev', 'starts at 1');
  need(optInt(r.revAt), at, 'revAt', 'must be an instant or null');
  if (r.revBy !== null && r.revBy !== undefined) { keysOnly(r.revBy, ['userId', 'name'], `${at}.revBy`); need(optId(r.revBy.userId) && isName(r.revBy.name), at, 'revBy', 'is { userId, name }'); }
  return { rev: r.rev, revAt: r.revAt ?? null, revBy: r.revBy ? { userId: r.revBy.userId ?? null, name: r.revBy.name ?? null } : null };
};

/** A history detail: the allowlisted scalars (null ones are not kept) and the reason-code and policy-version lists. */
function typeDetail(d, at, { scalars = DETAIL_SCALARS, lists = ['reasonCodes', 'policyVersions'] } = {}) {
  if (d === null || d === undefined) return null;
  keysOnly(d, [...scalars.map(([k]) => k), ...lists], `${at}.detail`);
  const out = {};
  for (const [k, , vals] of scalars) {
    const v = d[k];
    if (v === null || v === undefined) continue;
    if (vals === 'int') need(isInt(v) && v >= 0, `${at}.detail`, k, 'must be a whole number');
    else inV(v, vals, `${at}.detail`, k);
    out[k] = v;
  }
  if (d.reasonCodes !== undefined) out.reasonCodes = distinctList(d.reasonCodes, (x) => isText(x, L.code), `${at}.detail`, 'reasonCodes');
  if (d.policyVersions !== undefined) out.policyVersions = distinctList(d.policyVersions, (x) => isId(x), `${at}.detail`, 'policyVersions');
  return Object.keys(out).length ? out : null;
}
function typeHistory(list, at, actions, { detail = (d, a) => typeDetail(d, a), kinds = ACTOR_KINDS } = {}) {
  need(Array.isArray(list), at, 'history', 'must be a list');
  const out = list.map((h, i) => {
    const a = `${at}.history[${i}]`;
    keysOnly(h, ['id', 'at', 'action', 'by', 'detail'], a);
    need(isId(h.id), a, 'id', 'must be an id'); need(isInt(h.at), a, 'at', 'must be an instant'); inV(h.action, actions, a, 'action');
    return { id: h.id, at: h.at, action: h.action, by: typeBy(h.by, `${a}.by`, kinds), detail: detail(h.detail ?? null, a, h.action) };
  });
  need(new Set(out.map((h) => h.id)).size === out.length, at, 'history', 'names an id twice');
  return out;
}

// ---- transactions
function typeParty(raw, at, type) {
  keysOnly(raw, ['id', 'partyRole', 'subjectKind', 'subjectId', 'addedAt', 'addedBy', 'removed', 'removedAt', 'confirmedAt', 'confirmedBy', 'subjectRemovedAt'], at);
  need(isId(raw.id), at, 'id', 'must be an id'); inV(raw.partyRole, PARTY_ROLES, at, 'partyRole'); inV(raw.subjectKind, SUBJECT_KINDS, at, 'subjectKind');
  need(isId(raw.subjectId), at, 'subjectId', 'must be an id');
  need((raw.subjectKind === 'player') === (raw.partyRole === 'individual'), at, 'partyRole', 'is individual exactly for a player');
  need(raw.partyRole !== 'releasing_entity' || RELEASING_PARTY_TYPES.includes(type), at, 'partyRole', 'is a releasing entity only in a transfer or a loan');
  need(isInt(raw.addedAt), at, 'addedAt', 'must be an instant');
  const addedBy = typeBy(raw.addedBy, `${at}.addedBy`, ['org']); need(isId(addedBy.userId), at, 'addedBy.userId', 'names the agent');
  need(typeof raw.removed === 'boolean', at, 'removed', 'must be true or false');
  need(optInt(raw.removedAt) && raw.removed === (raw.removedAt != null), at, 'removedAt', 'is set exactly on a removed party');
  need(optInt(raw.confirmedAt), at, 'confirmedAt', 'must be an instant or null');
  const confirmedBy = raw.confirmedBy ? typeBy(raw.confirmedBy, `${at}.confirmedBy`, ['player', 'club_user']) : null;
  need((raw.confirmedAt != null) === (confirmedBy !== null), at, 'confirmedBy', 'is set, with confirmedAt, exactly when the party confirmed');
  need(optInt(raw.subjectRemovedAt) && (raw.subjectRemovedAt == null || raw.removed), at, 'subjectRemovedAt', 'is set only on a removed party');
  return { id: raw.id, partyRole: raw.partyRole, subjectKind: raw.subjectKind, subjectId: raw.subjectId, addedAt: raw.addedAt, addedBy, removed: raw.removed, removedAt: raw.removedAt ?? null, confirmedAt: raw.confirmedAt ?? null, confirmedBy, subjectRemovedAt: raw.subjectRemovedAt ?? null };
}
/** The stored snapshot: the evaluation it names or the gate that refused, the pending reason, the revision, the freshness. */
function typeCompliance(raw, at) {
  if (raw === null || raw === undefined) return null;
  keysOnly(raw, ['evaluationId', 'gate', 'evaluatedAt', 'pendingReason', 'verificationFreshness', 'partyRevision'], `${at}.compliance`);
  need(raw.evaluationId === null || raw.evaluationId === undefined || isId(raw.evaluationId, L.evaluationId), at, 'compliance.evaluationId', 'must be an evaluation id or null');
  inV(raw.gate, COMPLIANCE_GATES, at, 'compliance.gate', { nullable: true });
  need((raw.evaluationId == null) !== (raw.gate == null), at, 'compliance.evaluationId', 'names the evaluation, or the gate names why there is none (exactly one)');
  need(isInt(raw.evaluatedAt), at, 'compliance.evaluatedAt', 'must be an instant');
  inV(raw.pendingReason, PENDING_REASONS, at, 'compliance.pendingReason', { nullable: true });
  need(raw.gate == null || raw.pendingReason === raw.gate, at, 'compliance.pendingReason', 'is the gate on a gate snapshot');
  inV(raw.verificationFreshness, VERIFICATION_STATES, at, 'compliance.verificationFreshness', { nullable: true });
  need(typeof raw.partyRevision === 'string' && /^[0-9a-f]{64}$/.test(raw.partyRevision), at, 'compliance.partyRevision', 'must be a sha256 hex digest');
  return { evaluationId: raw.evaluationId ?? null, gate: raw.gate ?? null, evaluatedAt: raw.evaluatedAt, pendingReason: raw.pendingReason ?? null, verificationFreshness: raw.verificationFreshness ?? null, partyRevision: raw.partyRevision };
}
const TRANSACTION_FIELDS = ['id', 'agencyOrgId', 'agentUserId', 'type', 'jurisdictions', 'status', 'parties', 'contextId', 'compliance', 'reEvaluationPending', 'notes', 'linkedThreads', 'links', 'terms', 'holdReasonCode', 'holdReason', 'heldAt', 'cancelReasonCode', 'cancelledAt', 'closeReasonCode', 'closedAt', 'archivedAt', 'initiatedBy', 'initiatedAt', 'createdAt', 'updatedAt', 'keys', 'rev', 'revAt', 'revBy', 'history'];
/** A transaction: flat columns, jurisdictions, parties, snapshot, notes, threads, links, terms, keys and history. */
export function typeTransaction(raw, at = 'agentTransactions') {
  const label = `${at} ${isPlainObject(raw) && typeof raw.id === 'string' ? raw.id : ''}`.trim();
  try {
    keysOnly(raw, TRANSACTION_FIELDS, label);
    const r = raw;
    need(isId(r.id), label, 'id', 'must be an id'); need(isId(r.agencyOrgId), label, 'agencyOrgId', 'must be an id'); need(isId(r.agentUserId), label, 'agentUserId', 'must be an id');
    inV(r.type, CONTEXT_TYPES, label, 'type'); inV(r.status, TRANSACTION_STATUSES, label, 'status');
    const jurisdictions = distinctList(r.jurisdictions, isMa, label, 'jurisdictions', { max: L.jurisdictions });
    need(jurisdictions.length > 0, label, 'jurisdictions', 'must not be empty');
    need(Array.isArray(r.parties) && r.parties.length <= L.partyRows, label, 'parties', `must be a list of at most ${L.partyRows} party records`);
    const parties = r.parties.map((p, i) => typeParty(p, `${label}.parties[${i}]`, r.type));
    need(new Set(parties.map((p) => p.id)).size === parties.length, label, 'parties', 'names an id twice');
    const live = parties.filter((p) => !p.removed).map((p) => p.partyRole);
    need(new Set(live).size === live.length, label, 'parties', 'names a live party role twice');
    need(isId(r.contextId), label, 'contextId', 'names the transaction\'s compliance context');
    const compliance = typeCompliance(r.compliance, label);
    need(typeof r.reEvaluationPending === 'boolean', label, 'reEvaluationPending', 'must be true or false');
    need(Array.isArray(r.notes) && r.notes.length <= L.notes, label, 'notes', `must be a list of at most ${L.notes}`);
    const notes = r.notes.map((n, i) => {
      const a = `${label}.notes[${i}]`; keysOnly(n, ['id', 'visibility', 'text', 'by', 'at'], a);
      need(isId(n.id), a, 'id', 'must be an id'); inV(n.visibility, NOTE_VISIBILITY, a, 'visibility'); need(isText(n.text, L.note), a, 'text', `must be text of 1 to ${L.note} characters`); need(isInt(n.at), a, 'at', 'must be an instant');
      return { id: n.id, visibility: n.visibility, text: n.text, by: typeBy(n.by, `${a}.by`, ['org', 'club_user']), at: n.at };
    });
    need(Array.isArray(r.linkedThreads) && r.linkedThreads.length <= L.linkedThreads, label, 'linkedThreads', `must be a list of at most ${L.linkedThreads}`);
    const linkedThreads = r.linkedThreads.map((t, i) => {
      const a = `${label}.linkedThreads[${i}]`; keysOnly(t, ['id', 'channelId', 'linkedBy', 'linkedAt'], a);
      need(isId(t.id), a, 'id', 'must be an id'); need(isId(t.channelId), a, 'channelId', 'must be an id'); need(isInt(t.linkedAt), a, 'linkedAt', 'must be an instant');
      return { id: t.id, channelId: t.channelId, linkedBy: typeBy(t.linkedBy, `${a}.linkedBy`, ['club_user']), linkedAt: t.linkedAt };
    });
    need(new Set(linkedThreads.map((t) => t.channelId)).size === linkedThreads.length, label, 'linkedThreads', 'links a conversation twice');
    keysOnly(r.links, ['trialId', 'opportunityId', 'recruitmentCaseId'], `${label}.links`);
    for (const k of ['trialId', 'opportunityId', 'recruitmentCaseId']) need(optId(r.links[k]), label, `links.${k}`, 'must be an id or null');
    const links = { trialId: r.links.trialId ?? null, opportunityId: r.links.opportunityId ?? null, recruitmentCaseId: r.links.recruitmentCaseId ?? null };
    keysOnly(r.terms, ['versions'], `${label}.terms`);
    need(Array.isArray(r.terms.versions) && r.terms.versions.length <= L.terms, label, 'terms.versions', `must be a list of at most ${L.terms}`);
    const versions = r.terms.versions.map((v, i) => {
      const a = `${label}.terms.versions[${i}]`; keysOnly(v, ['id', 'at', 'by', 'recordedFor', 'visibility', 'summary', 'version'], a);
      need(isId(v.id), a, 'id', 'must be an id'); need(isInt(v.at), a, 'at', 'must be an instant'); need(v.version === i + 1, a, 'version', 'counts from 1, in order');
      inV(v.recordedFor, PARTY_ROLES, a, 'recordedFor'); inV(v.visibility, NOTE_VISIBILITY, a, 'visibility'); need(isText(v.summary, L.note), a, 'summary', `must be text of 1 to ${L.note} characters`);
      const by = typeBy(v.by, `${a}.by`, ['org']); need(isId(by.userId), a, 'by.userId', 'names the agent');
      return { id: v.id, at: v.at, by, recordedFor: v.recordedFor, visibility: v.visibility, summary: v.summary, version: v.version };
    });
    inV(r.holdReasonCode, HOLD_REASON_CODES, label, 'holdReasonCode', { nullable: true });
    need(r.holdReason === null || r.holdReason === undefined || isText(r.holdReason, L.reason), label, 'holdReason', `must be text of 1 to ${L.reason} characters or null`);
    inV(r.cancelReasonCode, CANCEL_REASON_CODES, label, 'cancelReasonCode', { nullable: true });
    inV(r.closeReasonCode, CLOSE_REASON_CODES, label, 'closeReasonCode', { nullable: true });
    for (const k of ['heldAt', 'cancelledAt', 'closedAt', 'archivedAt']) need(optInt(r[k]), label, k, 'must be an instant or null');
    need((r.holdReasonCode == null) === (r.heldAt == null) && (r.holdReason == null || r.holdReasonCode != null), label, 'holdReasonCode', 'is set, with heldAt, exactly when the transaction was held');
    need((r.cancelReasonCode == null) === (r.cancelledAt == null), label, 'cancelReasonCode', 'is set, with cancelledAt, exactly when the transaction was cancelled');
    need((r.closeReasonCode == null) === (r.closedAt == null), label, 'closeReasonCode', 'is set, with closedAt, exactly when the transaction was closed');
    const initiatedBy = typeBy(r.initiatedBy, `${label}.initiatedBy`, ['org']);
    need(initiatedBy.userId === r.agentUserId, label, 'initiatedBy', 'is the agent who opened it');
    need(isInt(r.createdAt) && isInt(r.updatedAt), label, 'createdAt', 'and updatedAt must be instants');
    need(r.initiatedAt === undefined || r.initiatedAt === r.createdAt, label, 'initiatedAt', 'is the creation instant');
    const keys = {};
    keysOnly(r.keys, Object.keys(r.keys ?? {}).filter((k) => k === 'create' || /^(party|status):/.test(k)), `${label}.keys`);
    for (const [k, v] of Object.entries(r.keys)) {
      const pair = keyPair(v, label, `keys.${k}`);
      if (k !== 'create') need(k === `${k.split(':')[0]}:${pair.key}`, label, `keys.${k}`, 'repeats its own key');
      keys[k] = pair;
    }
    const history = typeHistory(r.history ?? [], label, TRANSACTION_ACTIONS);
    return {
      id: r.id, agencyOrgId: r.agencyOrgId, agentUserId: r.agentUserId, type: r.type, jurisdictions, status: r.status, parties, contextId: r.contextId,
      compliance, reEvaluationPending: r.reEvaluationPending, notes, linkedThreads, links, terms: { versions },
      holdReasonCode: r.holdReasonCode ?? null, holdReason: r.holdReason ?? null, heldAt: r.heldAt ?? null, cancelReasonCode: r.cancelReasonCode ?? null, cancelledAt: r.cancelledAt ?? null,
      closeReasonCode: r.closeReasonCode ?? null, closedAt: r.closedAt ?? null, archivedAt: r.archivedAt ?? null,
      initiatedBy, initiatedAt: r.createdAt, createdAt: r.createdAt, updatedAt: r.updatedAt, keys, ...typeRev(r, label), history,
    };
  } catch (e) { if (e.code === 'AGENT_TRANSACTIONS_INPUT_INVALID') return { ok: false, reason: e.message.replace(/^[A-Z_]+: /, '') }; throw e; }
}

// ---- representations
const REPRESENTATION_FIELDS = ['id', 'transactionId', 'agencyOrgId', 'agentUserId', 'partyRole', 'agreementId', 'declaredOnly', 'scope', 'jurisdictions', 'status', 'reviewId', 'createdAt', 'verifiedAt', 'verifiedByReviewId', 'firstActAt', 'withdrawnAt', 'withdrawnReason', 'keys', 'rev', 'revAt', 'revBy', 'history'];
/** A representation binding: its agreement or its declaration, scope, jurisdiction, lifecycle, review link, key and history. */
export function typeRepresentation(raw, at = 'transactionRepresentations') {
  const label = `${at} ${isPlainObject(raw) && typeof raw.id === 'string' ? raw.id : ''}`.trim();
  try {
    keysOnly(raw, REPRESENTATION_FIELDS, label);
    const r = raw;
    for (const k of ['id', 'transactionId', 'agencyOrgId', 'agentUserId']) need(isId(r[k]), label, k, 'must be an id');
    inV(r.partyRole, PARTY_ROLES, label, 'partyRole');
    for (const k of ['agreementId', 'reviewId', 'verifiedByReviewId']) need(optId(r[k]), label, k, 'must be an id or null');
    need(typeof r.declaredOnly === 'boolean', label, 'declaredOnly', 'must be true or false');
    const scope = distinctList(r.scope ?? [], (x) => SCOPES.includes(x), label, 'scope');
    const jurisdictions = distinctList(r.jurisdictions ?? [], isMa, label, 'jurisdictions', { max: 1 });
    inV(r.status, REPRESENTATION_STATUSES, label, 'status');
    for (const k of ['createdAt']) need(isInt(r[k]), label, k, 'must be an instant');
    for (const k of ['verifiedAt', 'firstActAt', 'withdrawnAt']) need(optInt(r[k]), label, k, 'must be an instant or null');
    need((r.status === 'withdrawn') === (r.withdrawnAt != null), label, 'withdrawnAt', 'is set exactly when the binding was withdrawn');
    inV(r.withdrawnReason, WITHDRAWN_REASONS, label, 'withdrawnReason', { nullable: true });
    need((r.withdrawnAt == null) === (r.withdrawnReason == null), label, 'withdrawnReason', 'is set, with withdrawnAt, exactly when the binding was withdrawn');
    need(r.status !== 'pending_review' || (r.declaredOnly && r.reviewId != null), label, 'status', 'is pending_review only for a declared binding with its review');
    need(r.declaredOnly || r.agreementId != null || r.verifiedByReviewId != null, label, 'agreementId', 'names the agreement of a binding that is not declared');
    const keys = {};
    keysOnly(r.keys ?? {}, ['attach'], `${label}.keys`);
    if (r.keys?.attach) keys.attach = keyPair(r.keys.attach, label, 'keys.attach');
    const history = typeHistory(r.history ?? [], label, REPRESENTATION_ACTIONS, { detail: (d, a) => typeDetail(d, a, { scalars: REP_DETAIL_SCALARS, lists: ['policyVersions'] }) });
    return {
      id: r.id, transactionId: r.transactionId, agencyOrgId: r.agencyOrgId, agentUserId: r.agentUserId, partyRole: r.partyRole, agreementId: r.agreementId ?? null,
      declaredOnly: r.declaredOnly, scope, jurisdictions, status: r.status, reviewId: r.reviewId ?? null, createdAt: r.createdAt, verifiedAt: r.verifiedAt ?? null,
      verifiedByReviewId: r.verifiedByReviewId ?? null, firstActAt: r.firstActAt ?? null, withdrawnAt: r.withdrawnAt ?? null, withdrawnReason: r.withdrawnReason ?? null,
      keys, ...typeRev(r, label), history,
    };
  } catch (e) { if (e.code === 'AGENT_TRANSACTIONS_INPUT_INVALID') return { ok: false, reason: e.message.replace(/^[A-Z_]+: /, '') }; throw e; }
}

// ---- documents
const DOCUMENT_FIELDS = ['id', 'transactionId', 'documentType', 'visibility', 'label', 'version', 'owner', 'ownerPartyRole', 'uploadedBy', 'createdAt', 'expiresAt', 'evidenceRef', 'supersedes', 'supersededBy', 'removedAt', 'keys', 'rev', 'revAt', 'revBy', 'history'];
/** A document's history entry repeats the document's own fields (worked out on read). */
const documentDetail = (action, d) => (action === 'transaction_document_added' ? { documentType: d.documentType, visibility: d.visibility, version: d.version } : { version: d.version });
/** A document: classification, visibility, owner, version chain, expiry, evidence reference, key and history. */
export function typeDocument(raw, at = 'transactionDocuments') {
  const label = `${at} ${isPlainObject(raw) && typeof raw.id === 'string' ? raw.id : ''}`.trim();
  try {
    keysOnly(raw, DOCUMENT_FIELDS, label);
    const d = raw;
    need(isId(d.id), label, 'id', 'must be an id'); need(isId(d.transactionId), label, 'transactionId', 'must be an id');
    inV(d.documentType, DOCUMENT_TYPES, label, 'documentType'); inV(d.visibility, DOCUMENT_VISIBILITY, label, 'visibility');
    need(isText(d.label, L.label), label, 'label', `must be text of 1 to ${L.label} characters`);
    need(isInt(d.version) && d.version >= 1, label, 'version', 'counts from 1');
    keysOnly(d.owner, ['kind', 'id'], `${label}.owner`); inV(d.owner.kind, OWNER_KINDS, label, 'owner.kind'); need(optId(d.owner.id), label, 'owner.id', 'must be an id or null');
    need(d.owner.kind === 'player' || isId(d.owner.id), label, 'owner.id', 'names the owner (only a deleted player\'s is gone)');
    inV(d.ownerPartyRole, PARTY_ROLES, label, 'ownerPartyRole', { nullable: true });
    need((d.owner.kind === 'agent') === (d.ownerPartyRole == null), label, 'ownerPartyRole', 'is the party role of a party\'s document, and absent for the agent\'s');
    const uploadedBy = typeBy(d.uploadedBy, `${label}.uploadedBy`, ['org', 'club_user', 'player']);
    need(isInt(d.createdAt), label, 'createdAt', 'must be an instant'); need(optInt(d.expiresAt), label, 'expiresAt', 'must be an instant or null'); need(optInt(d.removedAt), label, 'removedAt', 'must be an instant or null');
    let evidenceRef = null;
    if (d.evidenceRef !== null && d.evidenceRef !== undefined) {
      keysOnly(d.evidenceRef, ['kind', 'id'], `${label}.evidenceRef`);
      need(d.evidenceRef.kind === 'verification_evidence' && isId(d.evidenceRef.id), label, 'evidenceRef', 'is { kind: verification_evidence, id }');
      evidenceRef = { kind: 'verification_evidence', id: d.evidenceRef.id };
    }
    for (const k of ['supersedes', 'supersededBy']) need(optId(d[k]), label, k, 'must be a document id or null');
    need((d.version === 1) === (d.supersedes == null), label, 'supersedes', 'names the version this one replaces exactly when it is not the first');
    const keys = {};
    keysOnly(d.keys ?? {}, ['add'], `${label}.keys`);
    if (d.keys?.add) keys.add = keyPair(d.keys.add, label, 'keys.add');
    const history = typeHistory(d.history ?? [], label, DOCUMENT_ACTIONS, {
      detail: (det, a, action) => { const want = documentDetail(action, d); need(det === null || same(det, want), a, 'detail', 'repeats the document\'s own fields'); return want; },
    });
    return {
      id: d.id, transactionId: d.transactionId, documentType: d.documentType, visibility: d.visibility, label: d.label, version: d.version,
      owner: { kind: d.owner.kind, id: d.owner.id ?? null }, ownerPartyRole: d.ownerPartyRole ?? null, uploadedBy, createdAt: d.createdAt, expiresAt: d.expiresAt ?? null,
      evidenceRef, supersedes: d.supersedes ?? null, supersededBy: d.supersededBy ?? null, removedAt: d.removedAt ?? null, keys, ...typeRev(d, label), history,
    };
  } catch (e) { if (e.code === 'AGENT_TRANSACTIONS_INPUT_INVALID') return { ok: false, reason: e.message.replace(/^[A-Z_]+: /, '') }; throw e; }
}

// ------------------------------------------------------------------ rows
const TX_COLS = ['id', 'agency_org_id', 'agent_user_id', 'type', 'status', 'context_id', 'compliance_evaluation_id', 'compliance_gate', 'compliance_evaluated_at', 'compliance_pending_reason', 'compliance_verification_freshness', 'compliance_party_revision', 're_evaluation_pending', 'link_trial_id', 'link_opportunity_id', 'link_recruitment_case_id', 'hold_reason_code', 'hold_reason', 'held_at', 'cancel_reason_code', 'cancelled_at', 'close_reason_code', 'closed_at', 'archived_at', 'initiated_by_name', 'created_at', 'updated_at', 'create_key', 'create_fp', 'rev', 'rev_at', 'rev_by_label'];
const REP_COLS = ['id', 'transaction_id', 'agency_org_id', 'agent_user_id', 'party_role', 'agreement_id', 'declared_only', 'jurisdiction', 'status', 'review_id', 'created_at', 'verified_at', 'verified_by_review_id', 'first_act_at', 'withdrawn_at', 'withdrawn_reason', 'attach_key', 'attach_fp', 'rev', 'rev_at', 'rev_by_id', 'rev_by_name'];
const DOC_COLS = ['id', 'transaction_id', 'document_type', 'visibility', 'label', 'version', 'owner_kind', 'owner_id', 'owner_party_role', 'uploaded_by_kind', 'uploaded_by_id', 'uploaded_by_name', 'uploaded_by_org_id', 'created_at', 'expires_at', 'evidence_id', 'supersedes_id', 'superseded_by_id', 'removed_at', 'add_key', 'add_fp', 'rev', 'rev_at', 'rev_by_id', 'rev_by_name'];
const HIST_COLS = ['id', 'transaction_id', 'ord', 'at', 'by_kind', 'by_id', 'by_name', 'by_role', 'by_org_id', 'action', ...DETAIL_SCALARS.map(([, c]) => c), 'has_reason_codes', 'has_policy_versions'];
const REP_HIST_COLS = ['id', 'representation_id', 'ord', 'at', 'by_kind', 'by_id', 'by_name', 'by_role', 'by_org_id', 'action', ...REP_DETAIL_SCALARS.map(([, c]) => c), 'has_policy_versions'];
const upsert = (table, cols) => `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')}) ON CONFLICT(id) DO UPDATE SET ${cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')}`;
const insert = (table, cols) => `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`;
const st = new WeakMap();
function statements(sqlite) {
  const s = st.get(sqlite); if (s && s.prepare === sqlite.prepare) return s.list;
  const p = (sql) => sqlite.prepare(sql);
  const list = {
    tx: p(upsert('agent_transactions', TX_COLS)),
    jurIns: p('INSERT INTO agent_transaction_jurisdictions (transaction_id, ord, member_association) VALUES (?, ?, ?)'),
    partyDel: p('DELETE FROM transaction_parties WHERE transaction_id = ?'),
    partyIns: p('INSERT INTO transaction_parties (id, transaction_id, ord, party_role, subject_kind, subject_id, added_at, added_by_id, added_by_name, removed, removed_at, confirmed_at, confirmed_by_kind, confirmed_by_id, confirmed_by_name, confirmed_by_org_id, subject_removed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    noteIns: p('INSERT INTO transaction_notes (id, transaction_id, ord, visibility, text, by_kind, by_id, by_name, by_org_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    threadIns: p('INSERT INTO transaction_linked_threads (id, transaction_id, ord, channel_id, linked_by_id, linked_by_name, linked_by_org_id, linked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    termIns: p('INSERT INTO transaction_terms_versions (id, transaction_id, version, recorded_at, recorded_by_id, recorded_by_name, recorded_for, visibility, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    keyIns: p('INSERT INTO transaction_keys (transaction_id, action, key, fp) VALUES (?, ?, ?, ?)'),
    hist: p(insert('transaction_history', HIST_COLS)),
    histCode: p('INSERT INTO transaction_history_reason_codes (history_id, ord, code) VALUES (?, ?, ?)'),
    histPv: p('INSERT INTO transaction_history_policy_versions (history_id, ord, policy_version_id) VALUES (?, ?, ?)'),
    rep: p(upsert('transaction_representations', REP_COLS)),
    repScope: p('INSERT INTO transaction_representation_scopes (representation_id, ord, scope) VALUES (?, ?, ?)'),
    repHist: p(insert('transaction_representation_history', REP_HIST_COLS)),
    repHistPv: p('INSERT INTO transaction_representation_history_policy_versions (history_id, ord, policy_version_id) VALUES (?, ?, ?)'),
    doc: p(upsert('transaction_documents', DOC_COLS)),
    docHist: p('INSERT INTO transaction_document_history (id, document_id, ord, at, by_kind, by_id, by_name, by_role, by_org_id, action) VALUES (@id, @owner, @ord, @at, @by_kind, @by_id, @by_name, @by_role, @by_org_id, @action)'),
  };
  st.set(sqlite, { prepare: sqlite.prepare, list });
  return list;
}

function txRow(t) {
  const c = t.compliance;
  return {
    id: t.id, agency_org_id: t.agencyOrgId, agent_user_id: t.agentUserId, type: t.type, status: t.status, context_id: t.contextId,
    compliance_evaluation_id: c?.evaluationId ?? null, compliance_gate: c?.gate ?? null, compliance_evaluated_at: c?.evaluatedAt ?? null, compliance_pending_reason: c?.pendingReason ?? null,
    compliance_verification_freshness: c?.verificationFreshness ?? null, compliance_party_revision: c?.partyRevision ?? null, re_evaluation_pending: t.reEvaluationPending ? 1 : 0,
    link_trial_id: t.links.trialId, link_opportunity_id: t.links.opportunityId, link_recruitment_case_id: t.links.recruitmentCaseId,
    hold_reason_code: t.holdReasonCode, hold_reason: t.holdReason, held_at: t.heldAt, cancel_reason_code: t.cancelReasonCode, cancelled_at: t.cancelledAt,
    close_reason_code: t.closeReasonCode, closed_at: t.closedAt, archived_at: t.archivedAt, initiated_by_name: t.initiatedBy.name, created_at: t.createdAt, updated_at: t.updatedAt,
    create_key: t.keys.create?.key ?? null, create_fp: t.keys.create?.fp ?? null, rev: t.rev, rev_at: t.revAt, rev_by_label: t.revBy?.name ?? null,
  };
}
function writeHistoryEntry(s, owner, ord, h) {
  const d = h.detail ?? {};
  s.hist.run({ id: h.id, transaction_id: owner, ord, at: h.at, ...byCols(h.by), action: h.action, ...Object.fromEntries(DETAIL_SCALARS.map(([k, c]) => [c, d[k] ?? null])), has_reason_codes: d.reasonCodes ? 1 : 0, has_policy_versions: d.policyVersions ? 1 : 0 });
  (d.reasonCodes ?? []).forEach((x, i) => s.histCode.run(h.id, i, x));
  (d.policyVersions ?? []).forEach((x, i) => s.histPv.run(h.id, i, x));
}
/** Write a transaction; `known` says what the stored record already holds (new rows only for the appended tail). */
function writeTransaction(s, t, known = null) {
  s.tx.run(txRow(t));
  if (!known) t.jurisdictions.forEach((j, i) => s.jurIns.run(t.id, i, j));
  s.partyDel.run(t.id);
  t.parties.forEach((p, i) => s.partyIns.run(p.id, t.id, i, p.partyRole, p.subjectKind, p.subjectId, p.addedAt, p.addedBy.userId, p.addedBy.name, p.removed ? 1 : 0, p.removedAt, p.confirmedAt, p.confirmedBy?.kind ?? null, p.confirmedBy?.userId ?? null, p.confirmedBy?.name ?? null, p.confirmedBy?.orgId ?? null, p.subjectRemovedAt));
  t.notes.slice(known?.notes ?? 0).forEach((n, j) => { const i = (known?.notes ?? 0) + j; s.noteIns.run(n.id, t.id, i, n.visibility, n.text, n.by.kind, n.by.userId, n.by.name, n.by.orgId ?? null, n.at); });
  t.linkedThreads.slice(known?.linkedThreads ?? 0).forEach((x, j) => { const i = (known?.linkedThreads ?? 0) + j; s.threadIns.run(x.id, t.id, i, x.channelId, x.linkedBy.userId, x.linkedBy.name, x.linkedBy.orgId, x.linkedAt); });
  t.terms.versions.slice(known?.terms ?? 0).forEach((v) => s.termIns.run(v.id, t.id, v.version, v.at, v.by.userId, v.by.name, v.recordedFor, v.visibility, v.summary));
  for (const [k, v] of Object.entries(t.keys)) { if (k === 'create' || known?.keys?.includes(k)) continue; const [action] = k.split(':'); s.keyIns.run(t.id, action, v.key, v.fp); }
  t.history.slice(known?.history ?? 0).forEach((h, j) => writeHistoryEntry(s, t.id, (known?.history ?? 0) + j, h));
}
function writeRepresentation(s, r, known = null) {
  s.rep.run({
    id: r.id, transaction_id: r.transactionId, agency_org_id: r.agencyOrgId, agent_user_id: r.agentUserId, party_role: r.partyRole, agreement_id: r.agreementId,
    declared_only: r.declaredOnly ? 1 : 0, jurisdiction: r.jurisdictions[0] ?? null, status: r.status, review_id: r.reviewId, created_at: r.createdAt, verified_at: r.verifiedAt,
    verified_by_review_id: r.verifiedByReviewId, first_act_at: r.firstActAt, withdrawn_at: r.withdrawnAt, withdrawn_reason: r.withdrawnReason,
    attach_key: r.keys.attach?.key ?? null, attach_fp: r.keys.attach?.fp ?? null, rev: r.rev, rev_at: r.revAt, rev_by_id: r.revBy?.userId ?? null, rev_by_name: r.revBy?.name ?? null,
  });
  if (!known) r.scope.forEach((x, i) => s.repScope.run(r.id, i, x));
  r.history.slice(known?.history ?? 0).forEach((h, j) => {
    const d = h.detail ?? {};
    s.repHist.run({ id: h.id, representation_id: r.id, ord: (known?.history ?? 0) + j, at: h.at, ...byCols(h.by), action: h.action, ...Object.fromEntries(REP_DETAIL_SCALARS.map(([k, c]) => [c, d[k] ?? null])), has_policy_versions: d.policyVersions ? 1 : 0 });
    (d.policyVersions ?? []).forEach((x, i) => s.repHistPv.run(h.id, i, x));
  });
}
function writeDocument(s, d, known = null) {
  s.doc.run(docRowOf(d));
  d.history.slice(known?.history ?? 0).forEach((h, j) => s.docHist.run({ id: h.id, owner: d.id, ord: (known?.history ?? 0) + j, at: h.at, ...byCols(h.by), action: h.action }));
}
function docRowOf(d) {
  const u = d.uploadedBy;
  return {
    id: d.id, transaction_id: d.transactionId, document_type: d.documentType, visibility: d.visibility, label: d.label, version: d.version,
    owner_kind: d.owner.kind, owner_id: d.owner.id, owner_party_role: d.ownerPartyRole,
    uploaded_by_kind: u.kind, uploaded_by_id: u.userId, uploaded_by_name: u.name, uploaded_by_org_id: u.orgId ?? null,
    created_at: d.createdAt, expires_at: d.expiresAt, evidence_id: d.evidenceRef?.id ?? null, supersedes_id: d.supersedes, superseded_by_id: d.supersededBy, removed_at: d.removedAt,
    add_key: d.keys.add?.key ?? null, add_fp: d.keys.add?.fp ?? null, rev: d.rev, rev_at: d.revAt, rev_by_id: d.revBy?.userId ?? null, rev_by_name: d.revBy?.name ?? null,
  };
}

// ---- decoding (every list's child rows in one batch per table)
const inIds = (sqlite, sql, list) => (list.length ? sqlite.prepare(sql).all(JSON.stringify([...new Set(list)])) : []);
const groupBy = (rows, key) => { const m = new Map(); for (const r of rows) { const k = key(r); let l = m.get(k); if (!l) m.set(k, (l = [])); l.push(r); } return (k) => m.get(k) ?? []; };
const IN = (col) => `${col} IN (SELECT value FROM json_each(?))`;
const childOf = (sqlite, table, col, ids, order = 'ord') => groupBy(inIds(sqlite, `SELECT * FROM ${table} WHERE ${IN(col)} ORDER BY ${col}, ${order}`, ids), (r) => r[col]);
const detailOf = (h, scalars, lists) => {
  const out = {};
  for (const [k, c] of scalars) if (h[c] !== null && h[c] !== undefined) out[k] = h[c];
  if (h.has_reason_codes) out.reasonCodes = lists.codes(h.id).map((x) => x.code);
  if (h.has_policy_versions) out.policyVersions = lists.pvs(h.id).map((x) => x.policy_version_id);
  return Object.keys(out).length ? out : null;
};
function decodeTransactions(sqlite, rows) {
  const ids = rows.map((r) => r.id);
  const jur = childOf(sqlite, 'agent_transaction_jurisdictions', 'transaction_id', ids);
  const parties = childOf(sqlite, 'transaction_parties', 'transaction_id', ids);
  const notes = childOf(sqlite, 'transaction_notes', 'transaction_id', ids);
  const threads = childOf(sqlite, 'transaction_linked_threads', 'transaction_id', ids);
  const terms = childOf(sqlite, 'transaction_terms_versions', 'transaction_id', ids, 'version');
  const keys = childOf(sqlite, 'transaction_keys', 'transaction_id', ids, 'rowid');
  const histRows = inIds(sqlite, `SELECT * FROM transaction_history WHERE ${IN('transaction_id')} ORDER BY transaction_id, ord`, ids);
  const hist = groupBy(histRows, (r) => r.transaction_id);
  const hids = histRows.filter((h) => h.has_reason_codes || h.has_policy_versions).map((h) => h.id);
  const lists = { codes: childOf(sqlite, 'transaction_history_reason_codes', 'history_id', hids), pvs: childOf(sqlite, 'transaction_history_policy_versions', 'history_id', hids) };
  return rows.map((row) => ({
    id: row.id, agencyOrgId: row.agency_org_id, agentUserId: row.agent_user_id, type: row.type, jurisdictions: jur(row.id).map((j) => j.member_association), status: row.status,
    parties: parties(row.id).map((p) => ({
      id: p.id, partyRole: p.party_role, subjectKind: p.subject_kind, subjectId: p.subject_id, addedAt: p.added_at, addedBy: { kind: 'org', userId: p.added_by_id, name: p.added_by_name },
      removed: p.removed === 1, removedAt: p.removed_at, confirmedAt: p.confirmed_at,
      confirmedBy: p.confirmed_by_kind === null ? null : { kind: p.confirmed_by_kind, userId: p.confirmed_by_id, name: p.confirmed_by_name, ...(p.confirmed_by_kind === 'club_user' ? { orgId: p.confirmed_by_org_id } : {}) },
      subjectRemovedAt: p.subject_removed_at,
    })),
    contextId: row.context_id,
    compliance: row.compliance_evaluated_at === null ? null : { evaluationId: row.compliance_evaluation_id, gate: row.compliance_gate, evaluatedAt: row.compliance_evaluated_at, pendingReason: row.compliance_pending_reason, verificationFreshness: row.compliance_verification_freshness, partyRevision: row.compliance_party_revision },
    reEvaluationPending: row.re_evaluation_pending === 1,
    notes: notes(row.id).map((n) => ({ id: n.id, visibility: n.visibility, text: n.text, by: { kind: n.by_kind, userId: n.by_id, name: n.by_name, ...(n.by_kind === 'club_user' ? { orgId: n.by_org_id } : {}) }, at: n.at })),
    linkedThreads: threads(row.id).map((x) => ({ id: x.id, channelId: x.channel_id, linkedBy: { kind: 'club_user', userId: x.linked_by_id, name: x.linked_by_name, orgId: x.linked_by_org_id }, linkedAt: x.linked_at })),
    links: { trialId: row.link_trial_id, opportunityId: row.link_opportunity_id, recruitmentCaseId: row.link_recruitment_case_id },
    terms: { versions: terms(row.id).map((v) => ({ id: v.id, at: v.recorded_at, by: { kind: 'org', userId: v.recorded_by_id, name: v.recorded_by_name }, recordedFor: v.recorded_for, visibility: v.visibility, summary: v.summary, version: v.version })) },
    holdReasonCode: row.hold_reason_code, holdReason: row.hold_reason, heldAt: row.held_at, cancelReasonCode: row.cancel_reason_code, cancelledAt: row.cancelled_at,
    closeReasonCode: row.close_reason_code, closedAt: row.closed_at, archivedAt: row.archived_at,
    initiatedBy: { kind: 'org', userId: row.agent_user_id, name: row.initiated_by_name }, initiatedAt: row.created_at, createdAt: row.created_at, updatedAt: row.updated_at,
    keys: { ...(row.create_key === null ? {} : { create: { key: row.create_key, fp: row.create_fp } }), ...Object.fromEntries(keys(row.id).map((k) => [`${k.action}:${k.key}`, { key: k.key, fp: k.fp }])) },
    rev: row.rev, revAt: row.rev_at, revBy: row.rev_by_label === null ? null : { userId: null, name: row.rev_by_label },
    history: hist(row.id).map((h) => ({ id: h.id, at: h.at, action: h.action, by: byOfRow(h), detail: detailOf(h, DETAIL_SCALARS, lists) })),
  }));
}
function decodeRepresentations(sqlite, rows) {
  const ids = rows.map((r) => r.id);
  const scopes = childOf(sqlite, 'transaction_representation_scopes', 'representation_id', ids);
  const histRows = inIds(sqlite, `SELECT * FROM transaction_representation_history WHERE ${IN('representation_id')} ORDER BY representation_id, ord`, ids);
  const hist = groupBy(histRows, (r) => r.representation_id);
  const lists = { codes: () => [], pvs: childOf(sqlite, 'transaction_representation_history_policy_versions', 'history_id', histRows.filter((h) => h.has_policy_versions).map((h) => h.id)) };
  return rows.map((r) => ({
    id: r.id, transactionId: r.transaction_id, agencyOrgId: r.agency_org_id, agentUserId: r.agent_user_id, partyRole: r.party_role, agreementId: r.agreement_id,
    declaredOnly: r.declared_only === 1, scope: scopes(r.id).map((x) => x.scope), jurisdictions: r.jurisdiction === null ? [] : [r.jurisdiction], status: r.status, reviewId: r.review_id,
    createdAt: r.created_at, verifiedAt: r.verified_at, verifiedByReviewId: r.verified_by_review_id, firstActAt: r.first_act_at, withdrawnAt: r.withdrawn_at, withdrawnReason: r.withdrawn_reason,
    keys: r.attach_key === null ? {} : { attach: { key: r.attach_key, fp: r.attach_fp } },
    rev: r.rev, revAt: r.rev_at, revBy: r.rev_by_id === null && r.rev_by_name === null ? null : { userId: r.rev_by_id, name: r.rev_by_name },
    history: hist(r.id).map((h) => ({ id: h.id, at: h.at, action: h.action, by: byOfRow(h), detail: detailOf(h, REP_DETAIL_SCALARS, lists) })),
  }));
}
function decodeDocuments(sqlite, rows) {
  const hist = childOf(sqlite, 'transaction_document_history', 'document_id', rows.map((r) => r.id));
  return rows.map((r) => {
    const d = {
      id: r.id, transactionId: r.transaction_id, documentType: r.document_type, visibility: r.visibility, label: r.label, version: r.version,
      owner: { kind: r.owner_kind, id: r.owner_id }, ownerPartyRole: r.owner_party_role, uploadedBy: byOfRow(r, 'uploaded_by'), createdAt: r.created_at, expiresAt: r.expires_at,
      evidenceRef: r.evidence_id === null ? null : { kind: 'verification_evidence', id: r.evidence_id }, supersedes: r.supersedes_id, supersededBy: r.superseded_by_id, removedAt: r.removed_at,
      keys: r.add_key === null ? {} : { add: { key: r.add_key, fp: r.add_fp } }, rev: r.rev, revAt: r.rev_at, revBy: r.rev_by_id === null && r.rev_by_name === null ? null : { userId: r.rev_by_id, name: r.rev_by_name },
    };
    d.history = hist(r.id).map((h) => ({ id: h.id, at: h.at, action: h.action, by: byOfRow(h), detail: documentDetail(h.action, d) }));
    return d;
  });
}

// ------------------------------------------------------------------ snapshot (fixtures and the persistence batteries)
export const agentTransactionsLive = (sqlite) => migrationApplied(sqlite, AGENT_TRANSACTIONS_MIGRATION);
function readAll(sqlite) {
  return {
    agentTransactions: decodeTransactions(sqlite, sqlite.prepare('SELECT * FROM agent_transactions ORDER BY rowid').all()),
    transactionRepresentations: decodeRepresentations(sqlite, sqlite.prepare('SELECT * FROM transaction_representations ORDER BY rowid').all()),
    transactionDocuments: decodeDocuments(sqlite, sqlite.prepare('SELECT * FROM transaction_documents ORDER BY rowid').all()),
  };
}
/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back); null before its migration. */
export const AGENT_TRANSACTIONS_RECORDS = {
  names: AGENT_TRANSACTIONS_COLLECTIONS,
  read(sqlite) { return agentTransactionsLive(sqlite) ? readAll(sqlite) : null; },
};
export const unresolvedPlayerReferences = (sqlite) => (agentTransactionsLive(sqlite) ? { agentTransactions: sqlite.prepare("SELECT count(*) AS n FROM transaction_parties x WHERE subject_kind = 'player' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.subject_id)").get().n } : null);

// ------------------------------------------------------------------ the repository
const WRITES = new Set(['create', 'update', 'forgetPlayer']);
const clone = (v) => JSON.parse(JSON.stringify(v));
const LIVE_SQL = `status IN (${LIVE_STATUSES.map(quote).join(',')})`;
const TERMINAL_SQL = `status IN (${TERMINAL_STATUSES.map(quote).join(',')})`;
/** A required party role of `t` that has no live, confirmed party (partiesConfirmed in SQL). */
const UNCONFIRMED_SQL = (t) => `EXISTS (SELECT 1 FROM (SELECT 'individual' AS r UNION ALL SELECT 'engaging_entity' UNION ALL SELECT 'releasing_entity' WHERE ${t}.type IN (${RELEASING_PARTY_TYPES.map(quote).join(',')})) need
  WHERE NOT EXISTS (SELECT 1 FROM transaction_parties p WHERE p.transaction_id = ${t}.id AND p.party_role = need.r AND p.removed = 0 AND p.confirmed_at IS NOT NULL))`;
/**
 * `createAgentTransactionsRepository({ sqlite, unit, now, log })`: `transactions`, `representations` and `documents`,
 * each with its writes and queries, plus `reads` (the queries alone) and `forgetPlayer` (an account deletion).
 */
export function createAgentTransactionsRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the agent transactions repository needs a SQLite connection (node:sqlite)');
  const operation = (fn) => (unit?.active?.() ? unit.join(fn) : sqlite.isTransaction ? fn() : transaction(sqlite, fn));
  const cache = new Map();
  const q = (sql) => { let x = cache.get(sql); if (!x) cache.set(sql, (x = sqlite.prepare(sql))); return x; };
  const s = () => statements(sqlite);
  const updating = new Set();
  const guard = (key, fn) => {
    if (updating.has(key)) throw refusal('AGENT_TRANSACTIONS_NESTED_UPDATE', `${key} is already being updated; make the second change after the first returns`);
    updating.add(key);
    try { return fn(); } finally { updating.delete(key); }
  };
  const typedOr = (type, raw, n) => { const t = type(raw, n); if (t && t.ok === false) throw refusal('AGENT_TRANSACTIONS_INPUT_INVALID', t.reason); return t; };
  const historyTaken = (h) => q('SELECT 1 FROM transaction_history WHERE id = ? UNION ALL SELECT 1 FROM transaction_representation_history WHERE id = ? UNION ALL SELECT 1 FROM transaction_document_history WHERE id = ?').get(h.id, h.id, h.id);
  const growsOnly = (table, id, storedList, nextList, what) => {
    if (nextList.length < storedList.length || storedList.some((x, i) => !same(x, nextList[i]))) throw refusal('AGENT_TRANSACTIONS_INPUT_INVALID', `${table} ${id}: ${what} only grow (a stored entry cannot change or go)`);
  };
  const checkHistory = (table, id, stored, next) => {
    growsOnly(table, id, stored.history, next.history, 'the history entries');
    const taken = next.history.slice(stored.history.length).find(historyTaken);
    if (taken) throw refusal('AGENT_TRANSACTIONS_DUPLICATE', `history entry ${taken.id} already exists`);
  };
  const checkFixed = (table, id, stored, next, fields) => { for (const k of fields) if (!same(next[k], stored[k])) throw refusal('AGENT_TRANSACTIONS_INPUT_INVALID', `${table} ${id}: ${k} cannot change`); };
  const sqlRefusal = (e, table, id) => {
    if (/UNIQUE/.test(String(e.message))) return refusal('AGENT_TRANSACTIONS_DUPLICATE', `${table} ${id}: ${e.message}`);
    if (/FOREIGN KEY/.test(String(e.message))) return refusal('AGENT_TRANSACTIONS_REFERENCE_MISSING', `${table} ${id} names a row that is not there`);
    return e;
  };
  const one = (decoder, sql) => (...args) => { const row = q(sql).get(...args); return row ? deepFreeze(decoder(sqlite, [row])[0]) : null; };
  const many = (decoder, sql) => (...args) => decoder(sqlite, q(sql).all(...args)).map(deepFreeze);
  const page = (decoder, sql, params, limit) => {
    const rows = q(sql).all({ ...params, n: limit + 1 });
    return { rows: decoder(sqlite, rows).map((record, i) => ({ key: [rows[i].rid], record: deepFreeze(record) })) };
  };
  /** The snapshot's evaluation is one of its own context's. */
  const checkSnapshot = (t) => {
    if (!t.compliance?.evaluationId) return;
    const ev = q('SELECT context_id FROM compliance_evaluations WHERE id = ?').get(t.compliance.evaluationId);
    if (!ev || ev.context_id !== t.contextId) throw refusal('AGENT_TRANSACTIONS_INPUT_INVALID', `agent_transactions ${t.id}: the compliance snapshot names an evaluation of its own context`);
  };

  // ---- transactions
  const txById = one(decodeTransactions, 'SELECT * FROM agent_transactions WHERE id = ?');
  const transactions = {
    create: (raw) => operation(() => {
      const t = typedOr(typeTransaction, raw, 'agentTransactions');
      if (q('SELECT 1 FROM agent_transactions WHERE id = ?').get(t.id)) throw refusal('AGENT_TRANSACTIONS_DUPLICATE', `agent_transactions ${t.id} already exists`);
      const taken = t.history.find(historyTaken); if (taken) throw refusal('AGENT_TRANSACTIONS_DUPLICATE', `history entry ${taken.id} already exists`);
      checkSnapshot(t);
      try { writeTransaction(s(), t); } catch (e) { throw sqlRefusal(e, 'agent_transactions', t.id); }
      return txById(t.id);
    }),
    /**
     * `update(id, change)`: the agency, agent, type, jurisdictions, context, opening and create key never change; a party
     * keeps its identity; notes, linked threads, terms, keys and history only grow.
     */
    update: (id, change) => guard(`agent_transactions ${id}`, () => operation(() => {
      if (typeof change !== 'function') throw new TypeError('agent_transactions: update(id, change) needs a function that edits the copy it is given');
      const stored = txById(id);
      if (!stored) throw refusal('AGENT_TRANSACTIONS_NOT_FOUND', `agent_transactions ${id} is not a record of the repository`);
      const draft = clone(stored);
      const returned = change(draft);
      const next = typedOr(typeTransaction, returned === undefined ? draft : returned, 'agentTransactions');
      checkFixed('agent_transactions', id, stored, next, ['id', 'agencyOrgId', 'agentUserId', 'type', 'jurisdictions', 'contextId', 'initiatedBy', 'createdAt']);
      if (!same(stored.keys.create ?? null, next.keys.create ?? null)) throw refusal('AGENT_TRANSACTIONS_INPUT_INVALID', `agent_transactions ${id}: the create key is written once`);
      for (const [k, v] of Object.entries(stored.keys)) if (!same(next.keys[k], v)) throw refusal('AGENT_TRANSACTIONS_INPUT_INVALID', `agent_transactions ${id}: the key ${k} is written once`);
      for (const p of stored.parties) {
        const n = next.parties.find((x) => x.id === p.id);
        if (!n || n.partyRole !== p.partyRole || n.subjectKind !== p.subjectKind || n.subjectId !== p.subjectId || n.addedAt !== p.addedAt) throw refusal('AGENT_TRANSACTIONS_INPUT_INVALID', `agent_transactions ${id}: party ${p.id} keeps its role, subject and addition (a party is removed, never replaced)`);
        if (p.removed && !n.removed) throw refusal('AGENT_TRANSACTIONS_INPUT_INVALID', `agent_transactions ${id}: a removed party does not return`);
      }
      growsOnly('agent_transactions', id, stored.notes, next.notes, 'the notes');
      growsOnly('agent_transactions', id, stored.linkedThreads, next.linkedThreads, 'the linked threads');
      growsOnly('agent_transactions', id, stored.terms.versions, next.terms.versions, 'the terms versions');
      checkHistory('agent_transactions', id, stored, next);
      checkSnapshot(next);
      try {
        writeTransaction(s(), next, { notes: stored.notes.length, linkedThreads: stored.linkedThreads.length, terms: stored.terms.versions.length, keys: Object.keys(stored.keys), history: stored.history.length });
      } catch (e) { throw sqlRefusal(e, 'agent_transactions', id); }
      return txById(id);
    })),
    byId: txById,
    /** The agent's transaction opened under this client key, or null. */
    byCreateKey: one(decodeTransactions, 'SELECT * FROM agent_transactions WHERE agency_org_id = ? AND agent_user_id = ? AND create_key = ?'),
    /** The agent's own transactions in the agency, newest first, by cursor (`after` is the previous page's last `[rowid]`). */
    agentPage: ({ agencyOrgId, agentUserId, status = null, limit, after = null }) => page(decodeTransactions, `SELECT rowid AS rid, * FROM agent_transactions
      WHERE agency_org_id = @a AND agent_user_id = @u AND (@s IS NULL OR status = @s) AND (@r IS NULL OR rowid < @r) ORDER BY rowid DESC LIMIT @n`, { a: agencyOrgId, u: agentUserId, s: status, r: after?.[0] ?? null }, limit),
    /** The agent's figures over every transaction of theirs (not one page): live, blocked, pending, ready, awaiting confirmation. */
    agentCounts: (agencyOrgId, agentUserId) => {
      const r = q(`SELECT SUM(CASE WHEN ${LIVE_SQL} THEN 1 ELSE 0 END) AS live, SUM(CASE WHEN status = 'COMPLIANCE_BLOCKED' THEN 1 ELSE 0 END) AS blocked,
        SUM(CASE WHEN status = 'COMPLIANCE_PENDING' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status = 'READY' THEN 1 ELSE 0 END) AS ready,
        SUM(CASE WHEN ${LIVE_SQL} AND ${UNCONFIRMED_SQL('t')} THEN 1 ELSE 0 END) AS awaiting
        FROM agent_transactions t WHERE agency_org_id = ? AND agent_user_id = ?`).get(agencyOrgId, agentUserId);
      return { live: r.live ?? 0, blocked: r.blocked ?? 0, pending: r.pending ?? 0, ready: r.ready ?? 0, awaitingConfirmation: r.awaiting ?? 0 };
    },
    /** The transactions a club is a live party to, newest first, by cursor. */
    clubPage: ({ orgId, limit, after = null }) => page(decodeTransactions, `SELECT rowid AS rid, * FROM agent_transactions t
      WHERE EXISTS (SELECT 1 FROM transaction_parties p WHERE p.transaction_id = t.id AND p.subject_kind = 'club' AND p.subject_id = @o AND p.removed = 0)
        AND (@r IS NULL OR rowid < @r) ORDER BY rowid DESC LIMIT @n`, { o: orgId, r: after?.[0] ?? null }, limit),
    /** The transactions a player is the live individual party to, oldest first (a per-player list). */
    forPlayer: many(decodeTransactions, `SELECT t.* FROM agent_transactions t WHERE EXISTS (SELECT 1 FROM transaction_parties p WHERE p.transaction_id = t.id AND p.subject_kind = 'player' AND p.subject_id = ? AND p.removed = 0) ORDER BY t.rowid`),
    /** Every transaction (the attributed Trust & Safety read), newest first, by cursor. */
    allPage: ({ status = null, limit, after = null }) => page(decodeTransactions, `SELECT rowid AS rid, * FROM agent_transactions
      WHERE (@s IS NULL OR status = @s) AND (@r IS NULL OR rowid < @r) ORDER BY rowid DESC LIMIT @n`, { s: status, r: after?.[0] ?? null }, limit),
    /** The live transactions of this type naming this player as the live individual (the duplicate rule's candidates). */
    liveForIndividual: (playerId, type) => many(decodeTransactions, `SELECT t.* FROM agent_transactions t WHERE t.type = ? AND NOT ${TERMINAL_SQL.replace('status', 't.status')}
      AND EXISTS (SELECT 1 FROM transaction_parties p WHERE p.transaction_id = t.id AND p.party_role = 'individual' AND p.subject_id = ? AND p.removed = 0) ORDER BY t.rowid`)(type, playerId),
    /** The agency's transactions, oldest first (the agency audit). */
    forAgency: many(decodeTransactions, 'SELECT * FROM agent_transactions WHERE agency_org_id = ? ORDER BY rowid'),
    /** The live transactions, oldest first (the stale-snapshot figure). */
    live: many(decodeTransactions, `SELECT * FROM agent_transactions WHERE ${LIVE_SQL} ORDER BY rowid`),
    /** The process figures (§76): counts by status, type and reason code, end-to-end durations and the compliance-pending spans. */
    metrics: () => {
      const count = (col) => Object.fromEntries(q(`SELECT ${col} AS k, COUNT(*) AS n FROM agent_transactions WHERE ${col} IS NOT NULL GROUP BY ${col}`).all().map((r) => [r.k, r.n]));
      const durations = q(`SELECT COALESCE(cancelled_at, closed_at, updated_at) - created_at AS d FROM agent_transactions WHERE ${TERMINAL_SQL} ORDER BY d`).all().map((r) => r.d);
      const moves = q("SELECT transaction_id, at, detail_from, detail_to FROM transaction_history WHERE action = 'transaction_status_changed' AND (detail_to = 'COMPLIANCE_PENDING' OR detail_from = 'COMPLIANCE_PENDING') ORDER BY transaction_id, ord").all();
      const pendingSpans = []; let tx = null; let from = null;
      for (const m of moves) {
        if (m.transaction_id !== tx) { tx = m.transaction_id; from = null; }
        if (m.detail_to === 'COMPLIANCE_PENDING') from = m.at;
        else if (from !== null && m.detail_from === 'COMPLIANCE_PENDING') { pendingSpans.push(m.at - from); from = null; }
      }
      return { byStatus: count('status'), byType: count('type'), cancelReasons: count('cancel_reason_code'), holdReasons: count('hold_reason_code'), durations, pendingSpans };
    },
  };

  // ---- representations
  const repById = one(decodeRepresentations, 'SELECT * FROM transaction_representations WHERE id = ?');
  const representations = {
    create: (raw) => operation(() => {
      const r = typedOr(typeRepresentation, raw, 'transactionRepresentations');
      if (q('SELECT 1 FROM transaction_representations WHERE id = ?').get(r.id)) throw refusal('AGENT_TRANSACTIONS_DUPLICATE', `transaction_representations ${r.id} already exists`);
      const tx = q('SELECT agency_org_id FROM agent_transactions WHERE id = ?').get(r.transactionId);
      if (!tx || tx.agency_org_id !== r.agencyOrgId) throw refusal('AGENT_TRANSACTIONS_INPUT_INVALID', `transaction_representations ${r.id}: names a transaction of its own agency`);
      const taken = r.history.find(historyTaken); if (taken) throw refusal('AGENT_TRANSACTIONS_DUPLICATE', `history entry ${taken.id} already exists`);
      try { writeRepresentation(s(), r); } catch (e) { throw sqlRefusal(e, 'transaction_representations', r.id); }
      return repById(r.id);
    }),
    /** `update(id, change)`: the binding's transaction, agent, party role, agreement, scope, jurisdiction, creation and key never change; a withdrawal is final; the history only grows. */
    update: (id, change) => guard(`transaction_representations ${id}`, () => operation(() => {
      if (typeof change !== 'function') throw new TypeError('transaction_representations: update(id, change) needs a function that edits the copy it is given');
      const stored = repById(id);
      if (!stored) throw refusal('AGENT_TRANSACTIONS_NOT_FOUND', `transaction_representations ${id} is not a record of the repository`);
      const draft = clone(stored);
      const returned = change(draft);
      const next = typedOr(typeRepresentation, returned === undefined ? draft : returned, 'transactionRepresentations');
      checkFixed('transaction_representations', id, stored, next, ['id', 'transactionId', 'agencyOrgId', 'agentUserId', 'partyRole', 'agreementId', 'scope', 'jurisdictions', 'createdAt', 'keys']);
      if (stored.status === 'withdrawn' && next.status !== 'withdrawn') throw refusal('AGENT_TRANSACTIONS_INPUT_INVALID', `transaction_representations ${id}: a withdrawn binding does not return`);
      checkHistory('transaction_representations', id, stored, next);
      try { writeRepresentation(s(), next, { history: stored.history.length }); } catch (e) { throw sqlRefusal(e, 'transaction_representations', id); }
      return repById(id);
    })),
    byId: repById,
    /** The transaction's bindings, oldest first. */
    forTransaction: many(decodeRepresentations, 'SELECT * FROM transaction_representations WHERE transaction_id = ? ORDER BY rowid'),
    /** The bindings of many transactions, in one read: `(txId) => list`. */
    forTransactions: (ids) => { const m = groupBy(decodeRepresentations(sqlite, inIds(sqlite, `SELECT * FROM transaction_representations WHERE ${IN('transaction_id')} ORDER BY rowid`, ids)).map(deepFreeze), (r) => r.transactionId); return m; },
    /** The binding attached in this transaction under this client key, or null. */
    byAttachKey: one(decodeRepresentations, 'SELECT * FROM transaction_representations WHERE transaction_id = ? AND attach_key = ?'),
    /** The agency's bindings, oldest first (the agency audit). */
    forAgency: many(decodeRepresentations, 'SELECT * FROM transaction_representations WHERE agency_org_id = ? ORDER BY rowid'),
  };

  // ---- documents
  const docById = one(decodeDocuments, 'SELECT * FROM transaction_documents WHERE id = ?');
  const documents = {
    create: (raw) => operation(() => {
      const d = typedOr(typeDocument, raw, 'transactionDocuments');
      if (q('SELECT 1 FROM transaction_documents WHERE id = ?').get(d.id)) throw refusal('AGENT_TRANSACTIONS_DUPLICATE', `transaction_documents ${d.id} already exists`);
      if (d.supersededBy) throw refusal('AGENT_TRANSACTIONS_INPUT_INVALID', `transaction_documents ${d.id}: a new version is not superseded yet`);
      if (d.supersedes) {
        const old = docById(d.supersedes);
        if (!old || old.transactionId !== d.transactionId || old.version + 1 !== d.version) throw refusal('AGENT_TRANSACTIONS_INPUT_INVALID', `transaction_documents ${d.id}: supersedes the previous version of its own transaction's document`);
      }
      const taken = d.history.find(historyTaken); if (taken) throw refusal('AGENT_TRANSACTIONS_DUPLICATE', `history entry ${taken.id} already exists`);
      try { writeDocument(s(), d); } catch (e) { throw sqlRefusal(e, 'transaction_documents', d.id); }
      return docById(d.id);
    }),
    /** `update(id, change)`: only the supersession (once), the removal, the uploader's and owner's identity (an account deletion), the rev and the history change. */
    update: (id, change) => guard(`transaction_documents ${id}`, () => operation(() => {
      if (typeof change !== 'function') throw new TypeError('transaction_documents: update(id, change) needs a function that edits the copy it is given');
      const stored = docById(id);
      if (!stored) throw refusal('AGENT_TRANSACTIONS_NOT_FOUND', `transaction_documents ${id} is not a record of the repository`);
      const draft = clone(stored);
      const returned = change(draft);
      const next = typedOr(typeDocument, returned === undefined ? draft : returned, 'transactionDocuments');
      checkFixed('transaction_documents', id, stored, next, ['id', 'transactionId', 'documentType', 'visibility', 'label', 'version', 'ownerPartyRole', 'createdAt', 'expiresAt', 'evidenceRef', 'supersedes', 'keys']);
      if (stored.supersededBy && next.supersededBy !== stored.supersededBy) throw refusal('AGENT_TRANSACTIONS_INPUT_INVALID', `transaction_documents ${id}: a version is superseded once`);
      if (stored.removedAt !== null && next.removedAt !== stored.removedAt) throw refusal('AGENT_TRANSACTIONS_INPUT_INVALID', `transaction_documents ${id}: a removal is final`);
      checkHistory('transaction_documents', id, stored, next);
      try { writeDocument(s(), next, { history: stored.history.length }); } catch (e) { throw sqlRefusal(e, 'transaction_documents', id); }
      return docById(id);
    })),
    byId: docById,
    /** Every version of the transaction's documents, removed ones included, oldest first. */
    forTransaction: many(decodeDocuments, 'SELECT * FROM transaction_documents WHERE transaction_id = ? ORDER BY rowid'),
    /** The live (not removed) documents of many transactions, in one read: `(txId) => list`. */
    liveForTransactions: (ids) => groupBy(decodeDocuments(sqlite, inIds(sqlite, `SELECT * FROM transaction_documents WHERE removed_at IS NULL AND ${IN('transaction_id')} ORDER BY rowid`, ids)).map(deepFreeze), (d) => d.transactionId),
    /** How many live documents the transaction holds (the cap). */
    liveCount: (txId) => q('SELECT COUNT(*) AS n FROM transaction_documents WHERE transaction_id = ? AND removed_at IS NULL').get(txId).n,
    /** The document added to this transaction under this client key, or null. */
    byAddKey: one(decodeDocuments, 'SELECT * FROM transaction_documents WHERE transaction_id = ? AND add_key = ?'),
    /** The agency's documents, oldest first (the agency audit). */
    forAgency: many(decodeDocuments, 'SELECT d.* FROM transaction_documents d JOIN agent_transactions t ON t.id = d.transaction_id WHERE t.agency_org_id = ? ORDER BY d.rowid'),
  };

  /**
   * A player's account removal (§71): every transaction naming them keeps its ids, roles, states and times and loses
   * the person — the party row is tombstoned, the player's confirmation and their own history entries lose their
   * id and name (another player once named keeps theirs), the player's own documents are removed and lose their owner, every live binding is withdrawn,
   * and the tombstone is recorded (`entryOf()` gives the history entry). Returns the transaction ids touched.
   */
  const forgetPlayer = (playerId, at, entryOf) => operation(() => {
    const touched = q("SELECT DISTINCT transaction_id FROM transaction_parties WHERE subject_kind = 'player' AND subject_id = ? ORDER BY transaction_id").all(playerId).map((r) => r.transaction_id);
    for (const id of touched) {
      for (const r of representations.forTransaction(id)) {
        if (r.status !== 'withdrawn') representations.update(r.id, (d) => { d.status = 'withdrawn'; d.withdrawnAt = at; d.withdrawnReason = 'subject_removed'; });
      }
      for (const d0 of documents.forTransaction(id)) {
        const uploadedByThem = d0.uploadedBy.kind === 'player' && d0.uploadedBy.userId === playerId;
        if (!(d0.owner.kind === 'player' && d0.owner.id === playerId) && !uploadedByThem) continue;
        documents.update(d0.id, (d) => {
          if (d.owner.kind === 'player' && d.owner.id === playerId) { d.removedAt ??= at; d.owner = { kind: 'player', id: null }; }
          if (d.uploadedBy.kind === 'player' && d.uploadedBy.userId === playerId) d.uploadedBy = { kind: 'player', userId: null, name: null };
        });
      }
      transactions.update(id, (d) => {
        for (const p of d.parties) {
          if (p.subjectKind !== 'player' || p.subjectId !== playerId) continue;
          p.removed = true; p.removedAt ??= at; p.subjectRemovedAt = at;
          if (p.confirmedBy?.kind === 'player') p.confirmedBy = { kind: 'player', userId: null, name: null };
        }
        d.history.push(entryOf());
        d.updatedAt = at;
      });
      // Only the deleted player's own entries: another player once named in the transaction keeps their provenance.
      q("UPDATE transaction_history SET by_id = NULL, by_name = NULL WHERE transaction_id = ? AND by_kind = 'player' AND by_id = ?").run(id, playerId);
      q("UPDATE transaction_document_history SET by_id = NULL, by_name = NULL WHERE by_kind = 'player' AND by_id = ? AND document_id IN (SELECT id FROM transaction_documents WHERE transaction_id = ?)").run(playerId, id);
    }
    return touched;
  });

  const readOnly = (o) => Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => !WRITES.has(k))));
  const repo = { transactions, representations, documents };
  const counters = { agentTransactions: q('SELECT COUNT(*) AS n FROM agent_transactions'), transactionRepresentations: q('SELECT COUNT(*) AS n FROM transaction_representations'), transactionDocuments: q('SELECT COUNT(*) AS n FROM transaction_documents') };
  return {
    ...repo,
    forgetPlayer,
    /** The queries alone, for modules that must not write. */
    reads: Object.freeze(Object.fromEntries(Object.entries(repo).map(([k, v]) => [k, readOnly(v)]))),
    attach() {
      if (!agentTransactionsLive(sqlite)) throw new Error(`the agent transactions repository needs ${AGENT_TRANSACTIONS_MIGRATION} recorded; it never imports an in-memory array`);
      return { counts: this.counts() };
    },
    counts() { return Object.fromEntries(AGENT_TRANSACTIONS_COLLECTIONS.map((n) => [n, counters[n].get().n])); },
    pending: () => 0,
    exportAll() { return AGENT_TRANSACTIONS_RECORDS.read(sqlite); },
    log,
    now,
  };
}
