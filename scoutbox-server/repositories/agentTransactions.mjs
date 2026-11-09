/**
 * The Agent Transaction Workspace: transactions, representation bindings and documents.
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
 * Writes (repositories/writes.mjs). A record is created whole and must read back as written, then changes only through
 * named acts (`addParty`, `confirmParty`, `recordCompliance`, `moveByActor`, `withdraw`, `supersede`, …), each an UPDATE
 * of named columns or an INSERT of new rows, joined into the open unit of work, the caller's open transaction, or a
 * transaction of their own. History, notes, terms, linked threads and keys are only inserted; a status moves only along
 * its transition table (ACTOR_, COMPLIANCE_ and PARTY_CHANGE_TRANSITIONS), guarded in SQL, and nothing is added to an
 * ended transaction. The columns and keys are the only check on stored values. An account deletion is `forgetPlayer`.
 *
 * Records are deep-frozen; a list decodes its child rows in one batch.
 *
 * References. Agencies → orgs and staff → org_users (RESTRICT); the context and the snapshot's evaluation →
 * compliance_contexts / compliance_evaluations; a representation's agreement and reviews → representation_agreements /
 * regulatory_reviews; a document's evidence → ver_evidence; the cited recruitment case → recruitment_cases; within the
 * domain, a representation's and a document's transaction and a document's version chain (RESTRICT). Composite keys
 * hold the rules between rows: the snapshot's evaluation is one of the transaction's own context's, a binding is in a
 * transaction of its own agency, a releasing party is only in a transfer or a loan (the party carries its
 * transaction's type), and a new version supersedes a document of its own transaction. A version's `supersededBy` is
 * the version naming it, worked out on read. A party's player
 * or club, a document owner's id, a linked thread's channel and the trial and opportunity links carry no key (tolerant:
 * a channel goes with a deleted player, a trial or an opportunity can be deleted; the record keeps the fact). Child
 * rows cascade.
 */
import { isPlainObject, describe } from './recruitment.mjs';
import { transaction, migrationApplied } from './database.mjs';
import { writeKit } from './writes.mjs';
import { deepFreeze } from './scoutingEvidence.mjs';
import { quote } from './fieldSpecs.mjs';
import { REPRESENTATION_STATUSES } from './complianceRecords.mjs';
import { VERIFICATION_STATES, SCOPES } from '../domains/agents/core/shared.mjs';
import { CONFLICT_OUTCOMES, CONTEXT_TYPES, PARTY_ROLES } from '../domains/agents/compliance/conflict.mjs';
import { TRANSACTION_STATUSES, LIVE_STATUSES, TERMINAL_STATUSES, RELEASING_PARTY_TYPES, ACTOR_TRANSITIONS, COMPLIANCE_TRANSITIONS, PARTY_CHANGE_TRANSITIONS, DOCUMENT_TYPES, DOCUMENT_VISIBILITY, NOTE_VISIBILITY, PENDING_REASONS, COMPLIANCE_GATES, STALENESS_REASONS, WITHDRAWN_REASONS, HOLD_REASON_CODES, CANCEL_REASON_CODES, CLOSE_REASON_CODES, TRANSACTION_LIMITS } from '../domains/agents/transactions/transaction.mjs';

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
  compliance_evaluation_id  TEXT,
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
  CHECK ((close_reason_code IS NULL) = (closed_at IS NULL)),
  FOREIGN KEY (compliance_evaluation_id, context_id) REFERENCES compliance_evaluations(id, context_id) ON DELETE RESTRICT,
  UNIQUE (id, type),
  UNIQUE (id, agency_org_id)
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
  transaction_id  TEXT NOT NULL,
  ${reqIn('transaction_type', CONTEXT_TYPES)},
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
  CHECK (subject_removed_at IS NULL OR removed = 1),
  CHECK (party_role <> 'releasing_entity' OR ${inList('transaction_type', RELEASING_PARTY_TYPES)}),
  FOREIGN KEY (transaction_id, transaction_type) REFERENCES agent_transactions(id, type) ON DELETE CASCADE
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
  transaction_id  TEXT NOT NULL,
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
  CHECK (declared_only = 1 OR agreement_id IS NOT NULL OR verified_by_review_id IS NOT NULL),
  FOREIGN KEY (transaction_id, agency_org_id) REFERENCES agent_transactions(id, agency_org_id) ON DELETE RESTRICT
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
  supersedes_id  TEXT,
  removed_at  INTEGER,
  ${KEY_COLS('add').join(',\n  ')},
  ${REV_COLS.join(',\n  ')},
  CHECK ((owner_kind = 'agent') = (owner_party_role IS NULL)),
  CHECK ((uploaded_by_kind = 'club_user') = (uploaded_by_org_id IS NOT NULL)),
  CHECK ((version = 1) = (supersedes_id IS NULL)),
  UNIQUE (id, transaction_id),
  FOREIGN KEY (supersedes_id, transaction_id) REFERENCES transaction_documents(id, transaction_id) ON DELETE RESTRICT
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


// ------------------------------------------------------------------ rows
const byCols = (by, p = 'by') => ({ [`${p}_kind`]: by?.kind, [`${p}_id`]: by?.userId ?? null, [`${p}_name`]: by?.name ?? null, [`${p}_role`]: by?.role ?? null, [`${p}_org_id`]: by?.orgId ?? null });
const byOfRow = (r, p = 'by') => ({ kind: r[`${p}_kind`], userId: r[`${p}_id`], name: r[`${p}_name`], ...(r[`${p}_kind`] === 'ts_reviewer' ? { role: r[`${p}_role`] } : {}), ...(r[`${p}_kind`] === 'club_user' ? { orgId: r[`${p}_org_id`] } : {}) });
const keyCols = (slot, k) => ({ [`${slot}_key`]: k?.key ?? null, [`${slot}_fp`]: k?.fp ?? null });
const snapshotCols = (c) => ({
  compliance_evaluation_id: c?.evaluationId ?? null, compliance_gate: c?.gate ?? null, compliance_evaluated_at: c?.evaluatedAt ?? null, compliance_pending_reason: c?.pendingReason ?? null,
  compliance_verification_freshness: c?.verificationFreshness ?? null, compliance_party_revision: c?.partyRevision ?? null,
});
const bool = (v) => (v === true ? 1 : v === false ? 0 : v);
function txRow(t) {
  return {
    id: t.id, agency_org_id: t.agencyOrgId, agent_user_id: t.agentUserId, type: t.type, status: t.status, context_id: t.contextId, ...snapshotCols(t.compliance),
    re_evaluation_pending: bool(t.reEvaluationPending), link_trial_id: t.links?.trialId ?? null, link_opportunity_id: t.links?.opportunityId ?? null, link_recruitment_case_id: t.links?.recruitmentCaseId ?? null,
    hold_reason_code: t.holdReasonCode ?? null, hold_reason: t.holdReason ?? null, held_at: t.heldAt ?? null, cancel_reason_code: t.cancelReasonCode ?? null, cancelled_at: t.cancelledAt ?? null,
    close_reason_code: t.closeReasonCode ?? null, closed_at: t.closedAt ?? null, archived_at: t.archivedAt ?? null, initiated_by_name: t.initiatedBy?.name ?? null, created_at: t.createdAt, updated_at: t.updatedAt,
    ...keyCols('create', t.keys?.create), rev: t.rev, rev_at: t.revAt ?? null, rev_by_label: t.revBy?.name ?? null,
  };
}
const partyRow = (txId, type, ord, p) => ({
  id: p.id, transaction_id: txId, transaction_type: type, ord, party_role: p.partyRole, subject_kind: p.subjectKind, subject_id: p.subjectId, added_at: p.addedAt,
  added_by_id: p.addedBy?.userId ?? null, added_by_name: p.addedBy?.name ?? null, removed: bool(p.removed), removed_at: p.removedAt ?? null, ...confirmationCols(p.confirmedAt, p.confirmedBy),
  subject_removed_at: p.subjectRemovedAt ?? null,
});
const confirmationCols = (at, by) => ({ confirmed_at: at ?? null, confirmed_by_kind: by?.kind ?? null, confirmed_by_id: by?.userId ?? null, confirmed_by_name: by?.name ?? null, confirmed_by_org_id: by?.orgId ?? null });
const noteRow = (txId, ord, n) => ({ id: n.id, transaction_id: txId, ord, visibility: n.visibility, text: n.text, by_kind: n.by?.kind, by_id: n.by?.userId ?? null, by_name: n.by?.name ?? null, by_org_id: n.by?.orgId ?? null, at: n.at });
const threadRow = (txId, ord, x) => ({ id: x.id, transaction_id: txId, ord, channel_id: x.channelId, linked_by_id: x.linkedBy?.userId ?? null, linked_by_name: x.linkedBy?.name ?? null, linked_by_org_id: x.linkedBy?.orgId ?? null, linked_at: x.linkedAt });
const termsRow = (txId, v) => ({ id: v.id, transaction_id: txId, version: v.version, recorded_at: v.at, recorded_by_id: v.by?.userId ?? null, recorded_by_name: v.by?.name ?? null, recorded_for: v.recordedFor, visibility: v.visibility, summary: v.summary });
function repRow(r) {
  const jurisdictions = r.jurisdictions ?? [];
  return {
    id: r.id, transaction_id: r.transactionId, agency_org_id: r.agencyOrgId, agent_user_id: r.agentUserId, party_role: r.partyRole, agreement_id: r.agreementId ?? null,
    declared_only: bool(r.declaredOnly), jurisdiction: jurisdictions[0] ?? null, status: r.status, review_id: r.reviewId ?? null, created_at: r.createdAt, verified_at: r.verifiedAt ?? null,
    verified_by_review_id: r.verifiedByReviewId ?? null, first_act_at: r.firstActAt ?? null, withdrawn_at: r.withdrawnAt ?? null, withdrawn_reason: r.withdrawnReason ?? null,
    ...keyCols('attach', r.keys?.attach), rev: r.rev, rev_at: r.revAt ?? null, rev_by_id: r.revBy?.userId ?? null, rev_by_name: r.revBy?.name ?? null,
  };
}
function docRow(d) {
  return {
    id: d.id, transaction_id: d.transactionId, document_type: d.documentType, visibility: d.visibility, label: d.label, version: d.version,
    owner_kind: d.owner?.kind, owner_id: d.owner?.id ?? null, owner_party_role: d.ownerPartyRole ?? null,
    uploaded_by_kind: d.uploadedBy?.kind, uploaded_by_id: d.uploadedBy?.userId ?? null, uploaded_by_name: d.uploadedBy?.name ?? null, uploaded_by_org_id: d.uploadedBy?.orgId ?? null, created_at: d.createdAt, expires_at: d.expiresAt ?? null, evidence_id: d.evidenceRef?.id ?? null, supersedes_id: d.supersedes ?? null, removed_at: d.removedAt ?? null,
    ...keyCols('add', d.keys?.add), rev: d.rev, rev_at: d.revAt ?? null, rev_by_id: d.revBy?.userId ?? null, rev_by_name: d.revBy?.name ?? null,
  };
}
/** A history entry's columns: the detail's allowlisted scalars as typed columns; a key the allowlist does not name is refused (`unknown`). */
function historyRow(owner, ownerCol, ord, h, scalars, unknown) {
  const d = h.detail ?? {};
  const known = new Set([...scalars.map(([k]) => k), 'reasonCodes', 'policyVersions']);
  const extra = Object.keys(d).filter((k) => !known.has(k));
  if (extra.length) unknown(`history ${h.id} detail carries field(s) this build does not store: ${extra.join(', ')}`);
  return { id: h.id, [ownerCol]: owner, ord, at: h.at, ...byCols(h.by), action: h.action, ...Object.fromEntries(scalars.map(([k, c]) => [c, d[k] ?? null])) };
}

// ---- decoding (every list's child rows in one batch per table)
/** A document's history entry repeats the document's own fields (worked out on read). */
const documentDetail = (action, d) => (action === 'transaction_document_added' ? { documentType: d.documentType, visibility: d.visibility, version: d.version } : { version: d.version });
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
/** A version's `supersededBy` is the version that names it (`supersedes_id`): one fact, stored once. */
function decodeDocuments(sqlite, rows) {
  const ids = rows.map((r) => r.id);
  const hist = childOf(sqlite, 'transaction_document_history', 'document_id', ids);
  const next = new Map(inIds(sqlite, `SELECT id, supersedes_id FROM transaction_documents WHERE ${IN('supersedes_id')}`, ids).map((r) => [r.supersedes_id, r.id]));
  return rows.map((r) => {
    const d = {
      id: r.id, transactionId: r.transaction_id, documentType: r.document_type, visibility: r.visibility, label: r.label, version: r.version,
      owner: { kind: r.owner_kind, id: r.owner_id }, ownerPartyRole: r.owner_party_role, uploadedBy: byOfRow(r, 'uploaded_by'), createdAt: r.created_at, expiresAt: r.expires_at,
      evidenceRef: r.evidence_id === null ? null : { kind: 'verification_evidence', id: r.evidence_id }, supersedes: r.supersedes_id, supersededBy: next.get(r.id) ?? null, removedAt: r.removed_at,
      keys: r.add_key === null ? {} : { add: { key: r.add_key, fp: r.add_fp } }, rev: r.rev, revAt: r.rev_at, revBy: r.rev_by_id === null && r.rev_by_name === null ? null : { userId: r.rev_by_id, name: r.rev_by_name },
    };
    d.history = hist(r.id).map((h) => ({ id: h.id, at: h.at, action: h.action, by: byOfRow(h), detail: documentDetail(h.action, d) }));
    return d;
  });
}

// ------------------------------------------------------------------ whole-domain read (the test suites)
export const agentTransactionsLive = (sqlite) => migrationApplied(sqlite, AGENT_TRANSACTIONS_MIGRATION);
function readAll(sqlite) {
  return {
    agentTransactions: decodeTransactions(sqlite, sqlite.prepare('SELECT * FROM agent_transactions ORDER BY rowid').all()),
    transactionRepresentations: decodeRepresentations(sqlite, sqlite.prepare('SELECT * FROM transaction_representations ORDER BY rowid').all()),
    transactionDocuments: decodeDocuments(sqlite, sqlite.prepare('SELECT * FROM transaction_documents ORDER BY rowid').all()),
  };
}
/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const AGENT_TRANSACTIONS_RECORDS = {
  names: AGENT_TRANSACTIONS_COLLECTIONS,
  read(sqlite) { return agentTransactionsLive(sqlite) ? readAll(sqlite) : null; },
};
export const unresolvedPlayerReferences = (sqlite) => (agentTransactionsLive(sqlite) ? { agentTransactions: sqlite.prepare("SELECT count(*) AS n FROM transaction_parties x WHERE subject_kind = 'player' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.subject_id)").get().n } : null);

// ------------------------------------------------------------------ the repository
const LIVE_SQL = `status IN (${LIVE_STATUSES.map(quote).join(',')})`;
const TERMINAL_SQL = `status IN (${TERMINAL_STATUSES.map(quote).join(',')})`;
/** A required party role of `t` that has no live, confirmed party (partiesConfirmed in SQL). */
const UNCONFIRMED_SQL = (t) => `EXISTS (SELECT 1 FROM (SELECT 'individual' AS r UNION ALL SELECT 'engaging_entity' UNION ALL SELECT 'releasing_entity' WHERE ${t}.type IN (${RELEASING_PARTY_TYPES.map(quote).join(',')})) need
  WHERE NOT EXISTS (SELECT 1 FROM transaction_parties p WHERE p.transaction_id = ${t}.id AND p.party_role = need.r AND p.removed = 0 AND p.confirmed_at IS NOT NULL))`;
const leadingTo = (transitions, to) => Object.keys(transitions).filter((x) => transitions[x].includes(to));
const SQLITE_CONSTRAINT = 19;
const WRITES = new Set([
  'create', 'forgetPlayer', 'recordAct', 'addParty', 'removeParty', 'confirmParty', 'moveOnPartyChange', 'recordCompliance', 'flagStale', 'moveByActor',
  'linkOpportunity', 'linkTrial', 'recordTerms', 'addNote', 'linkThread', 'withdraw', 'verifyByReview', 'supersede',
]);

/**
 * `createAgentTransactionsRepository({ sqlite, unit, now, log })`: `transactions`, `representations` and `documents`,
 * each with its whole-record `create`, its named acts and its queries, plus `reads` (the queries alone) and
 * `forgetPlayer` (an account deletion).
 *
 * An act is `act(id, input, bookkeeping)`: its own writes, then the bookkeeping — the history entries (only ever
 * inserted), the rev bump (`bump: { at, label }` on a transaction, `bump: { at, by: { userId, name } }` on a binding or
 * a document) and, with `touch`, the transaction's `updatedAt = at` — in one operation, returning the stored record.
 * `recordAct(id, bookkeeping)` is the bookkeeping alone. A status moves only along its transition table, guarded in SQL.
 */
export function createAgentTransactionsRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the agent transactions repository needs a SQLite connection (node:sqlite)');
  const operation = (fn) => (unit?.active?.() ? unit.join(fn) : sqlite.isTransaction ? fn() : transaction(sqlite, fn));
  const { q, assign, sqlIn, guarded, refusal: refuse, invalid, rowStep, readsBackAsWritten, newRecord } = writeKit(sqlite, 'AGENT_TRANSACTIONS');
  const fail = (message) => { throw invalid(message); };
  /** One write of a record's rows: a missing referenced row and a taken key are named as such, any other constraint failure as junk. */
  const step = (table, id, part, fn) => {
    try { return fn(); } catch (e) {
      if (e?.code !== 'ERR_SQLITE_ERROR' || (e.errcode & 0xff) !== SQLITE_CONSTRAINT) throw e;
      if (/FOREIGN KEY/.test(String(e.message))) throw refuse('REFERENCE_MISSING', `${table} ${id} names a row that is not there (${part}: ${e.message})`);
      if (/UNIQUE|PRIMARY KEY/.test(String(e.message))) throw refuse('DUPLICATE', `${table} ${id} ${part}: ${e.message}`);
      return rowStep(table, id, part, () => { throw e; });
    }
  };
  /** Insert one row; an absent value is bound as NULL (a NOT NULL column then refuses it). */
  const insertRow = (table, row) => {
    const cols = Object.keys(row);
    q(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`).run(Object.fromEntries(cols.map((c) => [c, row[c] === undefined ? null : row[c]])));
  };
  const setRow = (table, keys, cols) => q(`UPDATE ${table} SET ${assign(cols)} WHERE ${Object.keys(keys).map((c) => `${c} = @key_${c}`).join(' AND ')}`)
    .run({ ...Object.fromEntries(Object.entries(cols).map(([c, v]) => [c, v === undefined ? null : v])), ...Object.fromEntries(Object.entries(keys).map(([c, v]) => [`key_${c}`, v])) });
  const nextOrd = (table, owner, id) => q(`SELECT COALESCE(MAX(ord) + 1, 0) AS n FROM ${table} WHERE ${owner} = ?`).get(id).n;
  const one = (decoder, sql) => (...args) => { const row = q(sql).get(...args); return row ? deepFreeze(decoder(sqlite, [row])[0]) : null; };
  const many = (decoder, sql) => (...args) => decoder(sqlite, q(sql).all(...args)).map(deepFreeze);
  const page = (decoder, sql, params, limit) => {
    const rows = q(sql).all({ ...params, n: limit + 1 });
    return { rows: decoder(sqlite, rows).map((record, i) => ({ key: [rows[i].rid], record: deepFreeze(record) })) };
  };
  const listOf = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : fail(`a list was expected (got ${describe(v)})`));
  /** A whole record handed to `create` must read back as it was written. */
  const created = (table, byId, written) => { const stored = byId(written.id); readsBackAsWritten(table, written.id, written, stored); return stored; };

  // ---- history (only inserted)
  const insertHistory = (table, ownerCol, scalars, lists, id, h) => step(table, id, `history ${h?.id}`, () => {
    if (!isPlainObject(h)) fail(`${table} ${id}: a history entry must be an object (got ${describe(h)})`);
    const d = h.detail ?? {};
    const row = historyRow(id, ownerCol, nextOrd(table, ownerCol, id), h, scalars, (m) => fail(`${table} ${id} ${m}`));
    if (lists.codes) row.has_reason_codes = d.reasonCodes ? 1 : 0;
    if (lists.pvs) row.has_policy_versions = d.policyVersions ? 1 : 0;
    insertRow(table, row);
    if (lists.codes) listOf(d.reasonCodes).forEach((x, i) => insertRow(lists.codes, { history_id: h.id, ord: i, code: x }));
    if (lists.pvs) listOf(d.policyVersions).forEach((x, i) => insertRow(lists.pvs, { history_id: h.id, ord: i, policy_version_id: x }));
  });
  const TX_HISTORY = (id, h) => insertHistory('transaction_history', 'transaction_id', DETAIL_SCALARS, { codes: 'transaction_history_reason_codes', pvs: 'transaction_history_policy_versions' }, id, h);
  const REP_HISTORY = (id, h) => insertHistory('transaction_representation_history', 'representation_id', REP_DETAIL_SCALARS, { pvs: 'transaction_representation_history_policy_versions' }, id, h);
  /** A document's entries repeat the document's own fields, worked out on read: only the entry itself is stored. */
  const DOC_HISTORY = (id, h) => step('transaction_documents', id, `history ${h?.id}`, () => insertRow('transaction_document_history', { id: h.id, document_id: id, ord: nextOrd('transaction_document_history', 'document_id', id), at: h.at, ...byCols(h.by), action: h.action }));

  /** Named acts on one table, each `act(id, input, bookkeeping)`, and `recordAct(id, bookkeeping)`. */
  const actsOn = ({ table, byId, history, bump }, defs) => {
    const run = (name, id, fn, { at = null, touch = false, bump: b = null, history: entries = [] } = {}) => operation(() => {
      if (!q(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) throw refuse('NOT_FOUND', `${table} ${id} is not a record of the repository`);
      step(table, id, name, fn);
      if (b) step(table, id, 'rev', () => bump(id, b));
      if (touch) step(table, id, 'updatedAt', () => setRow(table, { id }, { updated_at: at }));
      for (const h of listOf(entries)) history(id, h);
      return byId(id);
    });
    return {
      ...Object.fromEntries(Object.entries(defs).map(([name, fn]) => [name, (id, input = {}, bookkeeping = {}) => run(name, id, () => fn(id, input), bookkeeping)])),
      recordAct: (id, bookkeeping = {}) => run('recordAct', id, () => {}, bookkeeping),
    };
  };
  const bumpWithBy = (table) => (id, { at, by = null }) => q(`UPDATE ${table} SET rev = rev + 1, rev_at = @at, rev_by_id = @uid, rev_by_name = @name WHERE id = @id`).run({ id, at, uid: by?.userId ?? null, name: by?.name ?? null });

  // ---- transactions
  const txById = one(decodeTransactions, 'SELECT * FROM agent_transactions WHERE id = ?');
  const TX = { table: 'agent_transactions', byId: txById, history: TX_HISTORY, bump: (id, { at, label = null }) => q('UPDATE agent_transactions SET rev = rev + 1, rev_at = @at, rev_by_label = @label WHERE id = @id').run({ id, at, label }) };
  const addKey = (id, action, k) => { if (k) insertRow('transaction_keys', { transaction_id: id, action, key: k.key, fp: k.fp }); };
  const typeOf = (id) => q('SELECT type FROM agent_transactions WHERE id = ?').get(id)?.type ?? null;
  /** Nothing is added to or confirmed in a transaction that has ended. */
  const live = (id, what) => guarded('agent_transactions', { id }, LIVE_SQL, {}, `agent_transactions ${id} has ended; ${what} is refused`);
  /** A party row of this transaction, matched while `where` holds. */
  const partyMove = (id, partyId, where, cols, what) => guarded('transaction_parties', { id: partyId, transaction_id: id }, where, cols, `transaction_parties ${partyId} of agent_transactions ${id} ${what}`);
  const move = (transitions, kind) => (id, to, cols = {}) => guarded('agent_transactions', { id }, sqlIn('status', leadingTo(transitions, to)), { status: to, ...cols }, `agent_transactions ${id} cannot move to ${to} from where it is (${kind})`);
  const moveByCompliance = move(COMPLIANCE_TRANSITIONS, 'by compliance');
  const insertTransaction = (t) => {
    const id = t.id;
    step('agent_transactions', id, 'row', () => insertRow('agent_transactions', txRow(t)));
    listOf(t.jurisdictions).forEach((j, i) => step('agent_transactions', id, `jurisdiction ${i}`, () => insertRow('agent_transaction_jurisdictions', { transaction_id: id, ord: i, member_association: j })));
    listOf(t.parties).forEach((p, i) => step('agent_transactions', id, `party ${p?.id}`, () => insertRow('transaction_parties', partyRow(id, t.type, i, p))));
    listOf(t.notes).forEach((n, i) => step('agent_transactions', id, `note ${n?.id}`, () => insertRow('transaction_notes', noteRow(id, i, n))));
    listOf(t.linkedThreads).forEach((x, i) => step('agent_transactions', id, `linked thread ${x?.id}`, () => insertRow('transaction_linked_threads', threadRow(id, i, x))));
    listOf(t.terms?.versions).forEach((v) => step('agent_transactions', id, `terms ${v?.id}`, () => insertRow('transaction_terms_versions', termsRow(id, v))));
    for (const [k, v] of Object.entries(t.keys ?? {})) {
      if (k === 'create') continue;
      const [action, key] = k.split(/:(.*)/s);
      if (key !== v?.key) fail(`agent_transactions ${id} keys.${k}: repeats its own key`);
      step('agent_transactions', id, `key ${k}`, () => addKey(id, action, v));
    }
    listOf(t.history).forEach((h) => TX_HISTORY(id, h));
  };
  const transactions = {
    /** A new transaction, whole (its context opened first). An existing id is refused. */
    create: (t) => operation(() => { newRecord('agent_transactions', (id) => !!q('SELECT 1 FROM agent_transactions WHERE id = ?').get(id), t); insertTransaction(t); return created('agent_transactions', txById, t); }),
    ...actsOn(TX, {
      /** Name a party (a new row; a party is removed, never replaced), with the request's replay key. */
      addParty: (id, { party, key = null }) => { live(id, 'a party'); insertRow('transaction_parties', partyRow(id, typeOf(id), nextOrd('transaction_parties', 'transaction_id', id), party)); addKey(id, 'party', key); },
      removeParty: (id, { partyId, at }) => { live(id, 'a party change'); partyMove(id, partyId, 'removed = 0', { removed: 1, removed_at: at }, 'is already removed'); },
      /** The party confirms its own participation, once. */
      confirmParty: (id, { partyId, at, by }) => { live(id, 'a confirmation'); partyMove(id, partyId, 'removed = 0 AND confirmed_at IS NULL', confirmationCols(at, by), 'is removed or already confirmed'); },
      /** A party change moves the status along PARTY_CHANGE_TRANSITIONS. */
      moveOnPartyChange: (id, { to }) => move(PARTY_CHANGE_TRANSITIONS, 'on a party change')(id, to),
      /** The snapshot of an evaluation (or of the gate that refused first); `to`, when given, is the move it makes along COMPLIANCE_TRANSITIONS. */
      recordCompliance: (id, { snapshot, to = null }) => {
        if (to) moveByCompliance(id, to);
        setRow('agent_transactions', { id }, { ...snapshotCols(snapshot), re_evaluation_pending: 0 });
      },
      /** The snapshot no longer matches the facts: it authorises nothing until re-evaluated. */
      flagStale: (id) => setRow('agent_transactions', { id }, { re_evaluation_pending: 1 }),
      /** An actor's move along ACTOR_TRANSITIONS, with its reason and replay key; leaving a hold clears it. */
      moveByActor: (id, { to, at, key = null, reasonCode = null, reason = null }) => {
        const cols = to === 'ON_HOLD' ? { hold_reason_code: reasonCode, hold_reason: reason, held_at: at }
          : to === 'ACTIVE' ? { hold_reason_code: null, hold_reason: null, held_at: null }
            : to === 'CANCELLED' ? { cancel_reason_code: reasonCode, cancelled_at: at }
              : to === 'CLOSED' ? { close_reason_code: reasonCode, closed_at: at }
                : to === 'ARCHIVED' ? { archived_at: at } : {};
        move(ACTOR_TRANSITIONS, 'by an actor')(id, to, cols);
        addKey(id, 'status', key);
      },
      linkOpportunity: (id, { opportunityId }) => { live(id, 'a link'); setRow('agent_transactions', { id }, { link_opportunity_id: opportunityId }); },
      linkTrial: (id, { trialId }) => { live(id, 'a link'); setRow('agent_transactions', { id }, { link_trial_id: trialId }); },
      /** A terms version: the next one, counted from 1. */
      recordTerms: (id, { terms }) => {
        live(id, 'a terms version');
        const next = q('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM transaction_terms_versions WHERE transaction_id = ?').get(id).v;
        if (terms?.version !== next) fail(`agent_transactions ${id} terms ${terms?.id}: is version ${next}`);
        insertRow('transaction_terms_versions', termsRow(id, terms));
      },
      addNote: (id, { note }) => { live(id, 'a note'); insertRow('transaction_notes', noteRow(id, nextOrd('transaction_notes', 'transaction_id', id), note)); },
      linkThread: (id, { thread }) => { live(id, 'a linked conversation'); insertRow('transaction_linked_threads', threadRow(id, nextOrd('transaction_linked_threads', 'transaction_id', id), thread)); },
    }),
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
    /** The process figures: counts by status, type and reason code, end-to-end durations and the compliance-pending spans. */
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
  const REP = { table: 'transaction_representations', byId: repById, history: REP_HISTORY, bump: bumpWithBy('transaction_representations') };
  const repMove = (id, where, cols, what) => guarded('transaction_representations', { id }, where, cols, `transaction_representations ${id} ${what}`);
  const representations = {
    /** A new binding, whole, in a transaction of its own agency. An existing id is refused. */
    create: (r) => operation(() => {
      newRecord('transaction_representations', (id) => !!q('SELECT 1 FROM transaction_representations WHERE id = ?').get(id), r);
      step('transaction_representations', r.id, 'row', () => insertRow('transaction_representations', repRow(r)));
      listOf(r.scope).forEach((x, i) => step('transaction_representations', r.id, `scope ${i}`, () => insertRow('transaction_representation_scopes', { representation_id: r.id, ord: i, scope: x })));
      if (listOf(r.jurisdictions).length > 1) fail(`transaction_representations ${r.id} jurisdictions: a binding names at most one`);
      listOf(r.history).forEach((h) => REP_HISTORY(r.id, h));
      return created('transaction_representations', repById, r);
    }),
    ...actsOn(REP, {
      /** A withdrawal is final. */
      withdraw: (id, { at, reason }) => repMove(id, "status <> 'withdrawn'", { status: 'withdrawn', withdrawn_at: at, withdrawn_reason: reason }, 'is already withdrawn'),
      /** An attributed reviewer confirmed a declared binding: it is verified by that review. */
      verifyByReview: (id, { at, reviewId }) => repMove(id, "status = 'pending_review'", { status: 'verified', declared_only: 0, verified_at: at, verified_by_review_id: reviewId }, 'is not awaiting review'),
    }),
    byId: repById,
    /** The transaction's bindings, oldest first. */
    forTransaction: many(decodeRepresentations, 'SELECT * FROM transaction_representations WHERE transaction_id = ? ORDER BY rowid'),
    /** The bindings of many transactions, in one read: `(txId) => list`. */
    forTransactions: (ids) => groupBy(decodeRepresentations(sqlite, inIds(sqlite, `SELECT * FROM transaction_representations WHERE ${IN('transaction_id')} ORDER BY rowid`, ids)).map(deepFreeze), (r) => r.transactionId),
    /** The binding attached in this transaction under this client key, or null. */
    byAttachKey: one(decodeRepresentations, 'SELECT * FROM transaction_representations WHERE transaction_id = ? AND attach_key = ?'),
    /** The agency's bindings, oldest first (the agency audit). */
    forAgency: many(decodeRepresentations, 'SELECT * FROM transaction_representations WHERE agency_org_id = ? ORDER BY rowid'),
  };

  // ---- documents
  const docById = one(decodeDocuments, 'SELECT * FROM transaction_documents WHERE id = ?');
  const DOC = { table: 'transaction_documents', byId: docById, history: DOC_HISTORY, bump: bumpWithBy('transaction_documents') };
  const insertDocument = (d) => {
    step('transaction_documents', d.id, 'row', () => insertRow('transaction_documents', docRow(d)));
    listOf(d.history).forEach((h) => DOC_HISTORY(d.id, h));
  };
  const documents = {
    /** A new document, whole; a later version names the one it replaces in the same transaction. An existing id is refused. */
    create: (d) => operation(() => {
      newRecord('transaction_documents', (id) => !!q('SELECT 1 FROM transaction_documents WHERE id = ?').get(id), d);
      insertDocument(d);
      return created('transaction_documents', docById, d);
    }),
    ...actsOn(DOC, {
      /** `document`, whole, is the next version of this live, not yet superseded one (a version is superseded once). */
      supersede: (id, { document: d }) => {
        if (!isPlainObject(d) || d.supersedes !== id) fail(`transaction_documents ${id}: the new version names the one it supersedes`);
        guarded('transaction_documents', { id, transaction_id: d.transactionId, version: d.version - 1 }, 'removed_at IS NULL',
          {}, `transaction_documents ${id} is not the live previous version of ${d.id} in its transaction`);
        newRecord('transaction_documents', (x) => !!q('SELECT 1 FROM transaction_documents WHERE id = ?').get(x), d);
        insertDocument(d);
        created('transaction_documents', docById, d);
      },
    }),
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
   * A player's account removal: every transaction naming them keeps its ids, roles, states and times and loses
   * the person. The party row is tombstoned (it keeps the id), the player's confirmation and their own history entries
   * lose their id and name (another player once named keeps theirs), the player's own documents are removed and lose
   * their owner, every live binding is withdrawn, and the tombstone is recorded (`entryOf()` gives the history entry).
   * Returns the transaction ids touched.
   */
  const forgetPlayer = (playerId, at, entryOf) => operation(() => {
    const touched = q("SELECT DISTINCT transaction_id FROM transaction_parties WHERE subject_kind = 'player' AND subject_id = ? ORDER BY transaction_id").all(playerId).map((r) => r.transaction_id);
    for (const id of touched) {
      const p = { id, pl: playerId, at };
      /** Run with the parameters the statement names (node:sqlite refuses one it does not). */
      const run = (sql) => q(sql).run(Object.fromEntries(Object.entries(p).filter(([k]) => sql.includes(`@${k}`))));
      run("UPDATE transaction_representations SET status = 'withdrawn', withdrawn_at = @at, withdrawn_reason = 'subject_removed' WHERE transaction_id = @id AND status <> 'withdrawn'");
      run("UPDATE transaction_documents SET removed_at = COALESCE(removed_at, @at), owner_id = NULL WHERE transaction_id = @id AND owner_kind = 'player' AND owner_id = @pl");
      run("UPDATE transaction_documents SET uploaded_by_id = NULL, uploaded_by_name = NULL WHERE transaction_id = @id AND uploaded_by_kind = 'player' AND uploaded_by_id = @pl");
      run(`UPDATE transaction_parties SET removed = 1, removed_at = COALESCE(removed_at, @at), subject_removed_at = @at,
        confirmed_by_id = CASE WHEN confirmed_by_kind = 'player' THEN NULL ELSE confirmed_by_id END, confirmed_by_name = CASE WHEN confirmed_by_kind = 'player' THEN NULL ELSE confirmed_by_name END
        WHERE transaction_id = @id AND subject_kind = 'player' AND subject_id = @pl`);
      transactions.recordAct(id, { at, touch: true, history: [entryOf()] });
      // Only the deleted player's own entries: another player once named in the transaction keeps their provenance.
      run("UPDATE transaction_history SET by_id = NULL, by_name = NULL WHERE transaction_id = @id AND by_kind = 'player' AND by_id = @pl");
      run("UPDATE transaction_document_history SET by_id = NULL, by_name = NULL WHERE by_kind = 'player' AND by_id = @pl AND document_id IN (SELECT id FROM transaction_documents WHERE transaction_id = @id)");
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
