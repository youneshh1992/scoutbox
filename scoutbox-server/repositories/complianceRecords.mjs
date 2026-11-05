/**
 * S11b-2 — the compliance engine's records as typed tables (migration `0028_compliance_records`;
 * docs/architecture/migration.md §4.5 S11; sql/06_agent_compliance_transactions.sql).
 *
 * Records:
 *   - A compliance context: the minimal conflict-evaluation record an agent (or a transaction, through the seam) opens:
 *     ordered jurisdictions, parties and representations, the facts an approved review settled, and its history. Its
 *     EVALUATIONS are their own append-only rows (`<context id>#<n>`, the id a transaction's snapshot names): outcome,
 *     instant, input hash, the policy versions, reasons, outstanding consents and the identity of the inputs. The
 *     alias, required actions, missing evidence and rule statuses are worked out on read (conflict.mjs).
 *   - A regulatory review: an attributed Trust & Safety item. Its subject is typed columns by kind; its snapshot is the
 *     outcome at request time and the evaluation row it was taken from (never a copy); the decision, its prior and
 *     resulting state are columns; reasons, policy versions and evidence references are ordered rows.
 *   - A consent: the party-specific, append-only ledger row. A revocation is its own row (one per consent); the
 *     consent's stored status never changes after its answer, and `revoked` is derived from the revocation row.
 *
 * A reason (an evaluation's or a review's) is typed columns: the rule it names and the per-code extras (facet, member
 * association, state, agent, party role, consent kind, detail, override, connected-agent attribution); its party-role
 * and jurisdiction lists are item rows.
 *
 * History. Ordered rows; a detail is typed columns, or worked out from the record it belongs to (a review's request,
 * resolution and cancellation; a consent's answers; an evaluation entry names its evaluation row).
 *
 * WRITES are explicit: `create(record)` and `update(id, (draft) => …)` type the whole record and write it at once,
 * joined into the open unit of work, the caller's open transaction, or a transaction of their own; an unknown field and
 * an update from inside its own update are refused. History only grows. An evaluation is recorded with
 * `contexts.recordEvaluation`; a revocation with `consents.revoke`; an account deletion with `forgetPlayer`.
 *
 * READS are SQL: no mirror. Records are fresh and deep-frozen. A context carries its latest evaluation and the count.
 *
 * References. Agencies → orgs and staff → org_users (RESTRICT); a reviewer → ts_reviewers; a policy version →
 * jurisdiction_policies; an agreement → representation_agreements; within the domain, a review's context, evaluation
 * and supersession, a representation's review, a consent's context (RESTRICT). A party's or a consent's subject (a
 * player or a club) and a review's player carry no key (tolerant: they outlive an account deletion as ids). Child rows
 * cascade.
 */
import { isPlainObject, describe } from './recruitment.mjs';
import { transaction, migrationApplied } from './database.mjs';
import { deepFreeze } from './scoutingEvidence.mjs';
import { quote } from './fieldSpecs.mjs';
import { REVIEWER_ROLES } from './compliancePolicies.mjs';
import { FACETS, VERIFICATION_STATES, AGREEMENT_STATUSES } from '../domains/agents/core/shared.mjs';
import { RULE_STATUSES, PARTY_ROLES, CONSENT_KINDS } from '../domains/agents/compliance/policyVersions.mjs';
import { CONFLICT_OUTCOMES, CONTEXT_TYPES, derivedOfEvaluation } from '../domains/agents/compliance/conflict.mjs';

export const COMPLIANCE_RECORDS_MIGRATION = '0028_compliance_records';
export const COMPLIANCE_RECORDS_COLLECTIONS = Object.freeze(['complianceContexts', 'regulatoryReviews', 'regulatoryConsents']);

// ------------------------------------------------------------------ vocabularies and limits (one definition; the routes import them)
export const COMPLIANCE_RECORD_LIMITS = Object.freeze({
  id: 80, name: 200, code: 60, ruleId: 40, text: 300, reasonCode: 60, reason: 1000, evidenceRef: 200, evidenceRefs: 10,
  key: 64, fp: 4000, parties: 6, jurisdictions: 10, list: 50, role: 60,
});
const L = COMPLIANCE_RECORD_LIMITS;
export const REVIEW_KINDS = Object.freeze(['verification_facet', 'representation_declared', 'conflict_evaluation', 'representation_dispute']);
export const REVIEW_STATUSES = Object.freeze(['PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED', 'SUPERSEDED']);
export const OPEN_REVIEW_STATUSES = Object.freeze(['PENDING', 'IN_REVIEW']);
export const DECISION_OUTCOMES = Object.freeze(['APPROVED', 'REJECTED', 'CANCELLED']);
export const RESULT_NOTES = Object.freeze(['profile gone', 'not disputed any more', 'context gone']);
export const CONTEXT_STATUSES = Object.freeze(['open', 'closed']);
export const REPRESENTATION_STATUSES = Object.freeze(['verified', 'pending_review', 'withdrawn']);
export const RESOLVED_FACTS = Object.freeze(['OTHER_SERVICES_PRESUMPTION', 'INTEREST_DECLARED', 'REPRESENTATION_UNVERIFIED']);
export const SUBJECT_KINDS = Object.freeze(['player', 'club']);
export const STORED_CONSENT_STATUSES = Object.freeze(['requested', 'granted', 'declined']);
export const ACTOR_KINDS = Object.freeze(['org', 'player', 'club_user', 'ts_reviewer', 'system']);
export const CONTEXT_ACTIONS = Object.freeze(['compliance_context_opened', 'compliance_context_party_added', 'compliance_context_party_removed', 'compliance_representation_declared', 'compliance_representation_verified', 'compliance_representation_withdrawn', 'compliance_context_evaluated', 'compliance_context_policy_changed', 'compliance_context_closed']);
export const REVIEW_ACTIONS = Object.freeze(['regulatory_review_requested', 'regulatory_review_started', 'regulatory_review_resolved', 'regulatory_review_cancelled', 'regulatory_review_superseded']);
export const CONSENT_ACTIONS = Object.freeze(['regulatory_consent_requested', 'regulatory_consent_granted', 'regulatory_consent_declined', 'regulatory_consent_revoked']);
const CONSENT_KEY_SLOTS = Object.freeze(['request', 'grant', 'decline', 'revoke']);
/** The extras a reason may carry beyond the rule it names, in the order they are read back. */
const REASON_SCALARS = Object.freeze([
  ['facet', 'facet'], ['memberAssociation', 'member_association'], ['state', 'state'], ['agentUserId', 'agent_user_id'],
  ['partyRole', 'party_role'], ['consentKind', 'consent_kind'], ['detail', 'detail_text'], ['reason', 'reason_text'],
  ['overrideRuleId', 'override_rule_id'], ['kind', 'kind_text'],
]);
const REASON_LISTS = Object.freeze(['partyRoles', 'jurisdictions']);

// ------------------------------------------------------------------ DDL
const inList = (c, vals) => `${c} IN (${vals.map(quote).join(',')})`;
const optIn = (c, vals) => `CHECK (${c} IS NULL OR ${inList(c, vals)})`;
const txt = (c, max = L.text, notNull = false) => `${c}  TEXT${notNull ? ' NOT NULL' : ''} CHECK (${notNull ? '' : `${c} IS NULL OR `}(length(${c}) > 0 AND length(${c}) <= ${max}))`;
const MA = (c, notNull = false) => `${c}  TEXT${notNull ? ' NOT NULL' : ''} CHECK (${notNull ? '' : `${c} IS NULL OR `}${c} GLOB '[A-Z][A-Z][A-Z]')`;
const BY_COLS = (p = 'by', { orgId = true } = {}) => [
  `${p}_kind  TEXT NOT NULL CHECK (${inList(`${p}_kind`, ACTOR_KINDS)})`, txt(`${p}_id`, L.id), `${p}_name  TEXT CHECK (${p}_name IS NULL OR length(${p}_name) <= ${L.name})`,
  `${p}_role  TEXT CHECK (${p}_role IS NULL OR length(${p}_role) <= ${L.role})`, ...(orgId ? [txt(`${p}_org_id`, L.id)] : []),
];
const REASON_COLS = [
  txt('code', L.code, true), txt('rule_id', L.ruleId), optIn('rule_status', RULE_STATUSES).replace(/^CHECK/, 'rule_status  TEXT CHECK'),
  txt('regulator', 20), MA('jurisdiction'), txt('policy_version_id', L.id),
  ...REASON_SCALARS.map(([, c]) => txt(c, c === 'detail_text' ? L.text : L.id)),
  'via_connected_agent  INTEGER CHECK (via_connected_agent IS NULL OR via_connected_agent = 1)',
  'has_party_roles  INTEGER NOT NULL DEFAULT 0 CHECK (has_party_roles IN (0,1))',
  'has_jurisdictions  INTEGER NOT NULL DEFAULT 0 CHECK (has_jurisdictions IN (0,1))',
];
const reasonTables = (owner, ownerTable, prefix) => [
  `CREATE TABLE ${prefix}_reasons (
  ${owner}  TEXT NOT NULL REFERENCES ${ownerTable}(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0),
  ${REASON_COLS.join(',\n  ')},
  PRIMARY KEY (${owner}, ord)
) STRICT;`,
  `CREATE TABLE ${prefix}_reason_items (
  ${owner}  TEXT NOT NULL,
  reason_ord  INTEGER NOT NULL,
  list  TEXT NOT NULL CHECK (${inList('list', REASON_LISTS)}),
  ord  INTEGER NOT NULL CHECK (ord >= 0),
  value  TEXT NOT NULL CHECK (length(value) > 0 AND length(value) <= ${L.id}),
  PRIMARY KEY (${owner}, reason_ord, list, ord),
  FOREIGN KEY (${owner}, reason_ord) REFERENCES ${prefix}_reasons(${owner}, ord) ON DELETE CASCADE
) STRICT;`,
];
const listTable = (name, owner, ownerTable, col, colDef) => `CREATE TABLE ${name} (
  ${owner}  TEXT NOT NULL REFERENCES ${ownerTable}(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0),
  ${col}  ${colDef},
  PRIMARY KEY (${owner}, ord),
  UNIQUE (${owner}, ${col})
) STRICT;`;
const POLICY_REF = `TEXT NOT NULL REFERENCES jurisdiction_policies(id) ON DELETE RESTRICT`;
const HISTORY_HEAD = (owner, ownerTable) => [
  `id  TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= ${L.id})`,
  `${owner}  TEXT NOT NULL REFERENCES ${ownerTable}(id) ON DELETE CASCADE`,
  'ord  INTEGER NOT NULL CHECK (ord >= 0)', 'at  INTEGER NOT NULL', ...BY_COLS(),
];
const KEY_COLS = (slot) => [txt(`${slot}_key`, L.key), `${slot}_fp  TEXT CHECK ((${slot}_fp IS NULL OR length(${slot}_fp) <= ${L.fp}) AND ((${slot}_key IS NULL) = (${slot}_fp IS NULL)))`];
const REV_COLS = ['rev  INTEGER NOT NULL CHECK (rev >= 1)', 'rev_at  INTEGER', txt('rev_by_id', L.id), `rev_by_name  TEXT CHECK (rev_by_name IS NULL OR length(rev_by_name) <= ${L.name})`];

export const COMPLIANCE_RECORDS_DDL = [
  `CREATE TABLE compliance_contexts (
  id  TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= ${L.id}),
  agency_org_id  TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  agent_user_id  TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  type  TEXT NOT NULL CHECK (${inList('type', CONTEXT_TYPES)}),
  status  TEXT NOT NULL CHECK (${inList('status', CONTEXT_STATUSES)}),
  re_evaluation_pending  INTEGER NOT NULL CHECK (re_evaluation_pending IN (0,1)),
  review_rejected_at  INTEGER,
  origin  TEXT CHECK (origin IS NULL OR origin = 'transaction'),
  ${txt('transaction_id', L.id)},
  opened_at  INTEGER NOT NULL,
  closed_at  INTEGER,
  ${KEY_COLS('create').join(',\n  ')},
  ${REV_COLS.join(',\n  ')},
  CHECK ((origin IS NULL) = (transaction_id IS NULL)),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
) STRICT;`,
  'CREATE INDEX compliance_contexts_agent ON compliance_contexts(agency_org_id, agent_user_id);',
  "CREATE INDEX compliance_contexts_open ON compliance_contexts(agency_org_id) WHERE status = 'open';",
  'CREATE UNIQUE INDEX compliance_contexts_transaction ON compliance_contexts(transaction_id) WHERE transaction_id IS NOT NULL;',
  'CREATE UNIQUE INDEX compliance_contexts_create_key ON compliance_contexts(agency_org_id, agent_user_id, create_key) WHERE create_key IS NOT NULL;',
  `CREATE TABLE compliance_context_jurisdictions (
  context_id  TEXT NOT NULL REFERENCES compliance_contexts(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0 AND ord < ${L.jurisdictions}),
  ${MA('member_association', true)},
  PRIMARY KEY (context_id, ord),
  UNIQUE (context_id, member_association)
) STRICT;`,
  'CREATE INDEX compliance_context_jurisdictions_ma ON compliance_context_jurisdictions(member_association);',
  `CREATE TABLE compliance_context_parties (
  context_id  TEXT NOT NULL REFERENCES compliance_contexts(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0),
  ${txt('id', L.id, true)},
  party_role  TEXT NOT NULL CHECK (${inList('party_role', PARTY_ROLES)}),
  subject_kind  TEXT NOT NULL CHECK (${inList('subject_kind', SUBJECT_KINDS)}),
  ${txt('subject_id', L.id, true)},
  added_at  INTEGER,
  removed  INTEGER NOT NULL CHECK (removed IN (0,1)),
  removed_at  INTEGER,
  PRIMARY KEY (context_id, id),
  UNIQUE (context_id, ord),
  CHECK (removed = 1 OR removed_at IS NULL)
) STRICT;`,
  'CREATE INDEX compliance_context_parties_subject ON compliance_context_parties(subject_kind, subject_id);',
  `CREATE TABLE compliance_context_representations (
  context_id  TEXT NOT NULL REFERENCES compliance_contexts(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0),
  ${txt('id', L.id, true)},
  agent_user_id  TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  party_role  TEXT NOT NULL CHECK (${inList('party_role', PARTY_ROLES)}),
  agreement_id  TEXT REFERENCES representation_agreements(id) ON DELETE RESTRICT,
  status  TEXT NOT NULL CHECK (${inList('status', REPRESENTATION_STATUSES)}),
  declared_only  INTEGER NOT NULL CHECK (declared_only IN (0,1)),
  review_id  TEXT REFERENCES regulatory_reviews(id) ON DELETE RESTRICT,
  declared_at  INTEGER,
  first_act_at  INTEGER,
  withdrawn_at  INTEGER,
  verified_by_review_id  TEXT REFERENCES regulatory_reviews(id) ON DELETE RESTRICT,
  verified_at  INTEGER,
  ${KEY_COLS('declare').join(',\n  ')},
  PRIMARY KEY (context_id, id),
  UNIQUE (context_id, ord)
) STRICT;`,
  listTable('compliance_context_resolved_facts', 'context_id', 'compliance_contexts', 'code', `TEXT NOT NULL CHECK (${inList('code', RESOLVED_FACTS)})`),
  `CREATE TABLE compliance_evaluations (
  id  TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 100),
  context_id  TEXT NOT NULL REFERENCES compliance_contexts(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL CHECK (position >= 1),
  outcome  TEXT NOT NULL CHECK (${inList('outcome', CONFLICT_OUTCOMES)}),
  evaluated_at  INTEGER NOT NULL,
  input_hash  TEXT NOT NULL CHECK (length(input_hash) = 64),
  proposed_party_role  TEXT CHECK (proposed_party_role IS NULL OR ${inList('proposed_party_role', PARTY_ROLES)}),
  proposed_agent_user_id  TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  UNIQUE (context_id, position),
  CHECK (id = context_id || '#' || position),
  CHECK ((proposed_party_role IS NULL) = (proposed_agent_user_id IS NULL))
) STRICT;`,
  'CREATE INDEX compliance_evaluations_outcome ON compliance_evaluations(outcome);',
  ...reasonTables('evaluation_id', 'compliance_evaluations', 'compliance_evaluation'),
  `CREATE TABLE compliance_evaluation_consents_outstanding (
  evaluation_id  TEXT NOT NULL REFERENCES compliance_evaluations(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0),
  party_role  TEXT NOT NULL CHECK (${inList('party_role', PARTY_ROLES)}),
  agent_user_id  TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  consent_kind  TEXT NOT NULL CHECK (${inList('consent_kind', CONSENT_KINDS)}),
  ${txt('reason_code', L.code, true)},
  PRIMARY KEY (evaluation_id, ord),
  UNIQUE (evaluation_id, party_role, consent_kind)
) STRICT;`,
  listTable('compliance_evaluation_policy_versions', 'evaluation_id', 'compliance_evaluations', 'policy_version_id', POLICY_REF),
  `CREATE TABLE compliance_evaluation_snapshot_parties (
  evaluation_id  TEXT NOT NULL REFERENCES compliance_evaluations(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0),
  party_role  TEXT NOT NULL CHECK (${inList('party_role', PARTY_ROLES)}),
  subject_kind  TEXT NOT NULL CHECK (${inList('subject_kind', SUBJECT_KINDS)}),
  ${txt('subject_id', L.id, true)},
  PRIMARY KEY (evaluation_id, ord)
) STRICT;`,
  `CREATE TABLE compliance_evaluation_snapshot_representations (
  evaluation_id  TEXT NOT NULL REFERENCES compliance_evaluations(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0),
  agent_user_id  TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  party_role  TEXT NOT NULL CHECK (${inList('party_role', PARTY_ROLES)}),
  status  TEXT NOT NULL CHECK (${inList('status', REPRESENTATION_STATUSES)}),
  PRIMARY KEY (evaluation_id, ord)
) STRICT;`,
  `CREATE TABLE regulatory_reviews (
  id  TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= ${L.id}),
  kind  TEXT NOT NULL CHECK (${inList('kind', REVIEW_KINDS)}),
  status  TEXT NOT NULL CHECK (${inList('status', REVIEW_STATUSES)}),
  agency_org_id  TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  agent_user_id  TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  subject_profile_id  TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT,
  ${txt('subject_user_id', L.id)},
  subject_facet  TEXT CHECK (subject_facet IS NULL OR ${inList('subject_facet', FACETS)}),
  ${MA('subject_member_association')},
  subject_agreement_id  TEXT REFERENCES representation_agreements(id) ON DELETE RESTRICT,
  subject_context_id  TEXT REFERENCES compliance_contexts(id) ON DELETE RESTRICT,
  ${txt('subject_transaction_id', L.id)},
  ${txt('subject_representation_id', L.id)},
  subject_party_role  TEXT CHECK (subject_party_role IS NULL OR ${inList('subject_party_role', PARTY_ROLES)}),
  subject_is_approach  INTEGER NOT NULL CHECK (subject_is_approach IN (0,1)),
  ${txt('subject_player_id', L.id)},
  ${MA('subject_jurisdiction')},
  snapshot_outcome  TEXT CHECK (snapshot_outcome IS NULL OR ${inList('snapshot_outcome', CONFLICT_OUTCOMES)}),
  snapshot_evaluation_id  TEXT REFERENCES compliance_evaluations(id) ON DELETE RESTRICT,
  snapshot_evaluated_at  INTEGER,
  requested_at  INTEGER NOT NULL,
  ${BY_COLS('requested_by', { orgId: false }).join(',\n  ')},
  started_at  INTEGER,
  started_by_id  TEXT REFERENCES ts_reviewers(id) ON DELETE RESTRICT,
  started_by_name  TEXT CHECK (started_by_name IS NULL OR length(started_by_name) <= ${L.name}),
  started_by_role  TEXT CHECK (started_by_role IS NULL OR ${inList('started_by_role', REVIEWER_ROLES)}),
  decided_at  INTEGER,
  decision_reviewer_id  TEXT REFERENCES ts_reviewers(id) ON DELETE RESTRICT,
  decision_reviewer_name  TEXT CHECK (decision_reviewer_name IS NULL OR length(decision_reviewer_name) <= ${L.name}),
  decision_reviewer_role  TEXT CHECK (decision_reviewer_role IS NULL OR ${inList('decision_reviewer_role', REVIEWER_ROLES)}),
  decision_outcome  TEXT CHECK (decision_outcome IS NULL OR ${inList('decision_outcome', DECISION_OUTCOMES)}),
  ${txt('decision_reason_code', L.reasonCode)},
  ${txt('decision_reason', L.reason)},
  decision_at  INTEGER,
  prior_status  TEXT CHECK (prior_status IS NULL OR ${inList('prior_status', REVIEW_STATUSES)}),
  prior_facet_state  TEXT CHECK (prior_facet_state IS NULL OR ${inList('prior_facet_state', VERIFICATION_STATES)}),
  prior_agreement_status  TEXT CHECK (prior_agreement_status IS NULL OR ${inList('prior_agreement_status', AGREEMENT_STATUSES)}),
  prior_context_outcome  TEXT CHECK (prior_context_outcome IS NULL OR ${inList('prior_context_outcome', CONFLICT_OUTCOMES)}),
  prior_representation_status  TEXT CHECK (prior_representation_status IS NULL OR ${inList('prior_representation_status', REPRESENTATION_STATUSES)}),
  result_facet_state  TEXT CHECK (result_facet_state IS NULL OR ${inList('result_facet_state', VERIFICATION_STATES)}),
  result_agreement_status  TEXT CHECK (result_agreement_status IS NULL OR ${inList('result_agreement_status', AGREEMENT_STATUSES)}),
  result_context_outcome  TEXT CHECK (result_context_outcome IS NULL OR ${inList('result_context_outcome', CONFLICT_OUTCOMES)}),
  result_representation_status  TEXT CHECK (result_representation_status IS NULL OR ${inList('result_representation_status', REPRESENTATION_STATUSES)}),
  result_note  TEXT CHECK (result_note IS NULL OR ${inList('result_note', RESULT_NOTES)}),
  supersedes_id  TEXT REFERENCES regulatory_reviews(id) ON DELETE RESTRICT,
  superseded_by_id  TEXT REFERENCES regulatory_reviews(id) ON DELETE RESTRICT,
  ${KEY_COLS('resolve').join(',\n  ')},
  ${REV_COLS.join(',\n  ')},
  CHECK ((decision_outcome IS NULL) = (decision_reviewer_id IS NULL)),
  CHECK (snapshot_evaluation_id IS NULL OR snapshot_outcome IS NOT NULL)
) STRICT;`,
  'CREATE INDEX regulatory_reviews_queue ON regulatory_reviews(status, requested_at);',
  'CREATE INDEX regulatory_reviews_agency ON regulatory_reviews(agency_org_id, agent_user_id);',
  'CREATE INDEX regulatory_reviews_subject_facet ON regulatory_reviews(subject_profile_id, subject_facet, subject_member_association) WHERE subject_profile_id IS NOT NULL;',
  'CREATE INDEX regulatory_reviews_subject_agreement ON regulatory_reviews(subject_agreement_id) WHERE subject_agreement_id IS NOT NULL;',
  'CREATE INDEX regulatory_reviews_subject_context ON regulatory_reviews(subject_context_id) WHERE subject_context_id IS NOT NULL;',
  ...reasonTables('review_id', 'regulatory_reviews', 'regulatory_review'),
  listTable('regulatory_review_policy_versions', 'review_id', 'regulatory_reviews', 'policy_version_id', POLICY_REF),
  `CREATE TABLE regulatory_review_evidence_refs (
  review_id  TEXT NOT NULL REFERENCES regulatory_reviews(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0 AND ord < ${L.evidenceRefs}),
  ${txt('ref', L.evidenceRef, true)},
  PRIMARY KEY (review_id, ord)
) STRICT;`,
  `CREATE TABLE regulatory_review_history (
  ${HISTORY_HEAD('review_id', 'regulatory_reviews').join(',\n  ')},
  action  TEXT NOT NULL CHECK (${inList('action', REVIEW_ACTIONS)}),
  detail_rev  INTEGER,
  detail_review_id  TEXT REFERENCES regulatory_reviews(id) ON DELETE RESTRICT,
  detail_prior_status  TEXT CHECK (detail_prior_status IS NULL OR ${inList('detail_prior_status', REVIEW_STATUSES)}),
  UNIQUE (review_id, ord)
) STRICT;`,
  'CREATE INDEX regulatory_review_history_decisions ON regulatory_review_history(at) WHERE action <> \'regulatory_review_requested\';',
  `CREATE TABLE compliance_context_history (
  ${HISTORY_HEAD('context_id', 'compliance_contexts').join(',\n  ')},
  action  TEXT NOT NULL CHECK (${inList('action', CONTEXT_ACTIONS)}),
  detail_party_role  TEXT CHECK (detail_party_role IS NULL OR ${inList('detail_party_role', PARTY_ROLES)}),
  detail_subject_kind  TEXT CHECK (detail_subject_kind IS NULL OR ${inList('detail_subject_kind', SUBJECT_KINDS)}),
  detail_status  TEXT CHECK (detail_status IS NULL OR ${inList('detail_status', REPRESENTATION_STATUSES)}),
  detail_review_outcome  TEXT CHECK (detail_review_outcome IS NULL OR ${inList('detail_review_outcome', ['review_approved', 'review_rejected'])}),
  detail_evaluation_id  TEXT REFERENCES compliance_evaluations(id) ON DELETE RESTRICT,
  detail_review_id  TEXT REFERENCES regulatory_reviews(id) ON DELETE RESTRICT,
  detail_policy_version_id  TEXT REFERENCES jurisdiction_policies(id) ON DELETE RESTRICT,
  UNIQUE (context_id, ord)
) STRICT;`,
  listTable('compliance_context_history_policy_versions', 'history_id', 'compliance_context_history', 'policy_version_id', POLICY_REF),
  `CREATE TABLE regulatory_consents (
  id  TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= ${L.id}),
  kind  TEXT NOT NULL CHECK (${inList('kind', CONSENT_KINDS)}),
  context_id  TEXT NOT NULL REFERENCES compliance_contexts(id) ON DELETE RESTRICT,
  agent_user_id  TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  agency_org_id  TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  party_role  TEXT NOT NULL CHECK (${inList('party_role', PARTY_ROLES)}),
  subject_kind  TEXT NOT NULL CHECK (${inList('subject_kind', SUBJECT_KINDS)}),
  ${txt('subject_id', L.id, true)},
  status  TEXT NOT NULL CHECK (${inList('status', STORED_CONSENT_STATUSES)}),
  requested_at  INTEGER NOT NULL,
  ${BY_COLS('requested_by', { orgId: false }).join(',\n  ')},
  granted_at  INTEGER,
  granted_by_kind  TEXT CHECK (granted_by_kind IS NULL OR granted_by_kind IN ('player','club_user')),
  ${txt('granted_by_id', L.id)},
  granted_by_name  TEXT CHECK (granted_by_name IS NULL OR length(granted_by_name) <= ${L.name}),
  ${txt('granted_by_org_id', L.id)},
  granted_by_signatory  INTEGER CHECK (granted_by_signatory IS NULL OR granted_by_signatory = 1),
  declined_at  INTEGER,
  declined_by_kind  TEXT CHECK (declined_by_kind IS NULL OR declined_by_kind IN ('player','club_user')),
  ${txt('declined_by_id', L.id)},
  declined_by_name  TEXT CHECK (declined_by_name IS NULL OR length(declined_by_name) <= ${L.name}),
  ${txt('declined_by_org_id', L.id)},
  full_particulars_provided  INTEGER NOT NULL CHECK (full_particulars_provided IN (0,1)),
  legal_advice_offered  INTEGER NOT NULL CHECK (legal_advice_offered IN (0,1)),
  proposed_fee_disclosed  INTEGER NOT NULL CHECK (proposed_fee_disclosed IN (0,1)),
  acknowledged_at  INTEGER,
  ${CONSENT_KEY_SLOTS.flatMap(KEY_COLS).join(',\n  ')},
  ${REV_COLS.join(',\n  ')},
  CHECK ((status = 'granted') = (granted_at IS NOT NULL AND granted_by_kind IS NOT NULL)),
  CHECK ((status = 'declined') = (declined_at IS NOT NULL AND declined_by_kind IS NOT NULL)),
  CHECK ((status = 'granted') = (acknowledged_at IS NOT NULL))
) STRICT;`,
  'CREATE INDEX regulatory_consents_context ON regulatory_consents(context_id, agent_user_id);',
  'CREATE INDEX regulatory_consents_subject ON regulatory_consents(subject_kind, subject_id);',
  'CREATE INDEX regulatory_consents_agency ON regulatory_consents(agency_org_id, agent_user_id);',
  'CREATE UNIQUE INDEX regulatory_consents_request_key ON regulatory_consents(context_id, agent_user_id, request_key) WHERE request_key IS NOT NULL;',
  listTable('regulatory_consent_regarding', 'consent_id', 'regulatory_consents', 'party_role', `TEXT NOT NULL CHECK (${inList('party_role', PARTY_ROLES)})`),
  listTable('regulatory_consent_policy_versions', 'consent_id', 'regulatory_consents', 'policy_version_id', POLICY_REF),
  listTable('regulatory_consent_rule_ids', 'consent_id', 'regulatory_consents', 'rule_id', `TEXT NOT NULL CHECK (length(rule_id) > 0 AND length(rule_id) <= ${L.ruleId})`),
  `CREATE TABLE regulatory_consent_revocations (
  id  TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= ${L.id}),
  consent_id  TEXT NOT NULL UNIQUE REFERENCES regulatory_consents(id) ON DELETE CASCADE,
  revoked_at  INTEGER NOT NULL,
  by_kind  TEXT NOT NULL CHECK (by_kind IN ('player','club_user')),
  ${txt('by_id', L.id)},
  by_name  TEXT CHECK (by_name IS NULL OR length(by_name) <= ${L.name}),
  ${txt('by_org_id', L.id)}
) STRICT;`,
  `CREATE TABLE regulatory_consent_history (
  ${HISTORY_HEAD('consent_id', 'regulatory_consents').join(',\n  ')},
  action  TEXT NOT NULL CHECK (${inList('action', CONSENT_ACTIONS)}),
  UNIQUE (consent_id, ord)
) STRICT;`,
].join('\n');
export const COMPLIANCE_RECORDS_TABLES = Object.freeze([
  'compliance_contexts', 'compliance_context_jurisdictions', 'compliance_context_parties', 'compliance_context_representations',
  'compliance_context_resolved_facts', 'compliance_evaluations', 'compliance_evaluation_reasons', 'compliance_evaluation_reason_items',
  'compliance_evaluation_consents_outstanding', 'compliance_evaluation_policy_versions', 'compliance_evaluation_snapshot_parties',
  'compliance_evaluation_snapshot_representations', 'regulatory_reviews', 'regulatory_review_reasons', 'regulatory_review_reason_items',
  'regulatory_review_policy_versions', 'regulatory_review_evidence_refs', 'regulatory_review_history', 'compliance_context_history',
  'compliance_context_history_policy_versions', 'regulatory_consents', 'regulatory_consent_regarding', 'regulatory_consent_policy_versions',
  'regulatory_consent_rule_ids', 'regulatory_consent_revocations', 'regulatory_consent_history',
]);

// ------------------------------------------------------------------ typing (the one place a value is judged)
export const refusal = (code, message, extra = {}) => Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
const FAIL = (reason) => { throw refusal('COMPLIANCE_RECORDS_INPUT_INVALID', reason); };
const isId = (v, max = L.id) => typeof v === 'string' && v.length > 0 && v.length <= max;
const isText = (v, max = L.text) => typeof v === 'string' && v.length > 0 && v.length <= max;
const isInt = (v) => Number.isSafeInteger(v);
const optInt = (v) => v === null || v === undefined || Number.isSafeInteger(v);
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
const distinctList = (v, ok, at, field, { max = L.list } = {}) => {
  need(Array.isArray(v) && v.length <= max && v.every(ok) && new Set(v).size === v.length, at, field, `must be a list of at most ${max} distinct entries`);
  return [...v];
};

/** An actor `{ kind, userId, name, role?, orgId? }` (a reviewer carries their role, a club user their club). */
function typeBy(by, at, { kinds = ACTOR_KINDS, signatory = false } = {}) {
  keysOnly(by, ['kind', 'userId', 'name', 'role', 'orgId', ...(signatory ? ['signatory'] : [])], `${at}`);
  inV(by.kind, kinds, at, 'kind');
  need(by.userId === null || by.userId === undefined || isId(by.userId), at, 'userId', 'must be an id or null');
  need(by.name === null || by.name === undefined || (typeof by.name === 'string' && by.name.length <= L.name), at, 'name', `must be text of at most ${L.name} characters`);
  if (by.kind === 'ts_reviewer') inV(by.role, REVIEWER_ROLES, at, 'role'); else need(by.role === undefined, at, 'role', 'is a reviewer\'s only');
  if (by.kind === 'club_user') need(isId(by.orgId), at, 'orgId', 'names the club'); else need(by.orgId === undefined, at, 'orgId', 'is a club user\'s only');
  if (signatory) need(by.signatory === undefined || (by.signatory === true && by.kind === 'club_user'), at, 'signatory', 'is true for a club signatory, or absent');
  return { kind: by.kind, userId: by.userId ?? null, name: by.name ?? null, ...(by.kind === 'ts_reviewer' ? { role: by.role } : {}), ...(by.kind === 'club_user' ? { orgId: by.orgId } : {}), ...(by.signatory ? { signatory: true } : {}) };
}
const byCols = (by, p = 'by') => ({ [`${p}_kind`]: by.kind, [`${p}_id`]: by.userId, [`${p}_name`]: by.name, [`${p}_role`]: by.role ?? null, ...(p === 'by' ? { by_org_id: by.orgId ?? null } : {}) });
const byOfRow = (r, p = 'by') => ({ kind: r[`${p}_kind`], userId: r[`${p}_id`], name: r[`${p}_name`], ...(r[`${p}_kind`] === 'ts_reviewer' ? { role: r[`${p}_role`] } : {}), ...(r[`${p}_kind`] === 'club_user' && r[`${p}_org_id`] !== undefined ? { orgId: r[`${p}_org_id`] } : {}) });
const typeKeys = (raw, slots, at) => {
  const keys = raw ?? {};
  keysOnly(keys, slots, `${at}.keys`);
  const out = {};
  for (const [s, v] of Object.entries(keys)) {
    keysOnly(v, ['key', 'fp'], `${at}.keys.${s}`);
    need(isText(v.key, L.key) && typeof v.fp === 'string' && v.fp.length <= L.fp, `${at}.keys`, s, 'must be { key, fp }');
    out[s] = { key: v.key, fp: v.fp };
  }
  return out;
};
const revOf = (r, at) => {
  need(isInt(r.rev) && r.rev >= 1, at, 'rev', 'starts at 1');
  need(optInt(r.revAt), at, 'revAt', 'must be an instant or null');
  if (r.revBy !== null && r.revBy !== undefined) { keysOnly(r.revBy, ['userId', 'name'], `${at}.revBy`); need((r.revBy.userId === null || isId(r.revBy.userId)) && (r.revBy.name === null || typeof r.revBy.name === 'string'), at, 'revBy', 'is { userId, name }'); }
  return { rev: r.rev, revAt: r.revAt ?? null, revBy: r.revBy ? { userId: r.revBy.userId ?? null, name: r.revBy.name ?? null } : null };
};
const revCols = (r) => ({ rev: r.rev, rev_at: r.revAt, rev_by_id: r.revBy?.userId ?? null, rev_by_name: r.revBy?.name ?? null });
const revOfRow = (row) => ({ rev: row.rev, revAt: row.rev_at, revBy: row.rev_by_id === null && row.rev_by_name === null ? null : { userId: row.rev_by_id, name: row.rev_by_name } });

/** A reason `{ code, ruleId, ruleStatus, regulator?, jurisdiction?, policyVersion, ...extras }`. */
function typeReason(raw, at) {
  keysOnly(raw, ['code', 'ruleId', 'ruleStatus', 'regulator', 'jurisdiction', 'policyVersion', ...REASON_SCALARS.map(([k]) => k), ...REASON_LISTS, 'viaConnectedAgent'], at);
  need(isText(raw.code, L.code), at, 'code', 'names a reason code');
  need(raw.ruleId === null || raw.ruleId === undefined || isId(raw.ruleId, L.ruleId), at, 'ruleId', 'must be a rule id or null');
  inV(raw.ruleStatus, RULE_STATUSES, at, 'ruleStatus', { nullable: true });
  need(raw.regulator === null || raw.regulator === undefined || isText(raw.regulator, 20), at, 'regulator', 'must be text or null');
  need(raw.jurisdiction === null || raw.jurisdiction === undefined || isMa(raw.jurisdiction), at, 'jurisdiction', 'must be a three-letter code or null');
  need(raw.policyVersion === null || raw.policyVersion === undefined || isId(raw.policyVersion), at, 'policyVersion', 'must be a policy version id or null');
  const out = { code: raw.code, ruleId: raw.ruleId ?? null, ruleStatus: raw.ruleStatus ?? null, regulator: raw.regulator ?? null, jurisdiction: raw.jurisdiction ?? null, policyVersion: raw.policyVersion ?? null };
  for (const [k] of REASON_SCALARS) {
    if (raw[k] === null || raw[k] === undefined) continue;
    need(isText(raw[k], k === 'detail' ? L.text : L.id), at, k, 'must be text');
    if (k === 'partyRole') inV(raw[k], PARTY_ROLES, at, k);
    if (k === 'consentKind') inV(raw[k], CONSENT_KINDS, at, k);
    if (k === 'facet') inV(raw[k], FACETS, at, k);
    out[k] = raw[k];
  }
  if (raw.partyRoles !== undefined) out.partyRoles = distinctList(raw.partyRoles, (x) => PARTY_ROLES.includes(x), at, 'partyRoles');
  if (raw.viaConnectedAgent !== undefined) { need(raw.viaConnectedAgent === true, at, 'viaConnectedAgent', 'is true or absent'); out.viaConnectedAgent = true; }
  if (raw.jurisdictions !== undefined) out.jurisdictions = distinctList(raw.jurisdictions, isMa, at, 'jurisdictions');
  return out;
}
const typeReasons = (list, at) => { need(Array.isArray(list) && list.length <= 200, at, 'reasons', 'must be a list'); return list.map((r, i) => typeReason(r, `${at}.reasons[${i}]`)); };
const policyList = (v, at, field = 'policyVersions') => distinctList(v ?? [], (x) => isId(x), at, field);

// ---- contexts
function typeParty(raw, at) {
  keysOnly(raw, ['id', 'partyRole', 'subjectKind', 'subjectId', 'addedAt', 'removed', 'removedAt'], at);
  need(isId(raw.id), at, 'id', 'must be an id'); inV(raw.partyRole, PARTY_ROLES, at, 'partyRole'); inV(raw.subjectKind, SUBJECT_KINDS, at, 'subjectKind');
  need(isId(raw.subjectId), at, 'subjectId', 'must be an id'); need(optInt(raw.addedAt), at, 'addedAt', 'must be an instant');
  need(typeof raw.removed === 'boolean', at, 'removed', 'must be true or false'); need(optInt(raw.removedAt) && (raw.removed || raw.removedAt == null), at, 'removedAt', 'is set only on a removed party');
  return { id: raw.id, partyRole: raw.partyRole, subjectKind: raw.subjectKind, subjectId: raw.subjectId, addedAt: raw.addedAt ?? null, removed: raw.removed, removedAt: raw.removedAt ?? null };
}
function typeRepresentation(raw, at) {
  keysOnly(raw, ['id', 'agentUserId', 'partyRole', 'agreementId', 'status', 'declaredOnly', 'reviewId', 'declaredAt', 'firstActAt', 'withdrawnAt', 'verifiedByReviewId', 'verifiedAt', 'keys'], at);
  need(isId(raw.id), at, 'id', 'must be an id'); need(isId(raw.agentUserId), at, 'agentUserId', 'must be an id'); inV(raw.partyRole, PARTY_ROLES, at, 'partyRole');
  need(raw.agreementId === null || raw.agreementId === undefined || isId(raw.agreementId), at, 'agreementId', 'must be an id or null');
  inV(raw.status, REPRESENTATION_STATUSES, at, 'status'); need(typeof raw.declaredOnly === 'boolean', at, 'declaredOnly', 'must be true or false');
  for (const k of ['reviewId', 'verifiedByReviewId']) need(raw[k] === null || raw[k] === undefined || isId(raw[k]), at, k, 'must be an id or null');
  for (const k of ['declaredAt', 'firstActAt', 'withdrawnAt', 'verifiedAt']) need(optInt(raw[k]), at, k, 'must be an instant or null');
  const keys = typeKeys(raw.keys, ['declare'], at);
  return { id: raw.id, agentUserId: raw.agentUserId, partyRole: raw.partyRole, agreementId: raw.agreementId ?? null, status: raw.status, declaredOnly: raw.declaredOnly, reviewId: raw.reviewId ?? null, declaredAt: raw.declaredAt ?? null, firstActAt: raw.firstActAt ?? null, withdrawnAt: raw.withdrawnAt ?? null, verifiedByReviewId: raw.verifiedByReviewId ?? null, verifiedAt: raw.verifiedAt ?? null, keys };
}
/** A context history detail, by action; `evaluated` and a verified declaration repeat an evaluation (checked by the writer). */
function typeContextDetail(action, d, at) {
  const ex = (req, opt = []) => { keysOnly(d, [...req, ...opt], `${at}.detail`); for (const k of req) need(Object.hasOwn(d, k), `${at}.detail`, k, 'is required'); };
  switch (action) {
    case 'compliance_context_opened': ex(['type', 'policyVersions']); inV(d.type, CONTEXT_TYPES, at, 'detail.type'); return { type: d.type, policyVersions: policyList(d.policyVersions, at, 'detail.policyVersions') };
    case 'compliance_context_party_added': ex(['partyRole', 'kind']); inV(d.partyRole, PARTY_ROLES, at, 'detail.partyRole'); inV(d.kind, SUBJECT_KINDS, at, 'detail.kind'); return { partyRole: d.partyRole, kind: d.kind };
    case 'compliance_context_party_removed': ex(['partyRole']); inV(d.partyRole, PARTY_ROLES, at, 'detail.partyRole'); return { partyRole: d.partyRole };
    case 'compliance_representation_declared':
      if (d?.status === 'pending_review') { ex(['partyRole', 'status']); inV(d.partyRole, PARTY_ROLES, at, 'detail.partyRole'); return { partyRole: d.partyRole, status: 'pending_review' }; }
      ex(['partyRole', 'status', 'outcome', 'policyVersions']); inV(d.partyRole, PARTY_ROLES, at, 'detail.partyRole'); need(d.status === 'verified', at, 'detail.status', 'is verified or pending_review'); inV(d.outcome, CONFLICT_OUTCOMES, at, 'detail.outcome');
      return { partyRole: d.partyRole, status: 'verified', outcome: d.outcome, policyVersions: policyList(d.policyVersions, at, 'detail.policyVersions') };
    case 'compliance_representation_verified': ex(['partyRole', 'reviewId']); inV(d.partyRole, PARTY_ROLES, at, 'detail.partyRole'); need(isId(d.reviewId), at, 'detail.reviewId', 'must be an id'); return { partyRole: d.partyRole, reviewId: d.reviewId };
    case 'compliance_representation_withdrawn': ex(['partyRole'], ['reviewId']); inV(d.partyRole, PARTY_ROLES, at, 'detail.partyRole'); need(d.reviewId === undefined || isId(d.reviewId), at, 'detail.reviewId', 'must be an id'); return { partyRole: d.partyRole, ...(d.reviewId ? { reviewId: d.reviewId } : {}) };
    case 'compliance_context_evaluated':
      if (d && Object.hasOwn(d, 'reviewId')) { ex(['reviewId', 'outcome']); need(isId(d.reviewId), at, 'detail.reviewId', 'must be an id'); inV(d.outcome, ['review_approved', 'review_rejected'], at, 'detail.outcome'); return { reviewId: d.reviewId, outcome: d.outcome }; }
      ex(['outcome', 'reasonCodes', 'policyVersions']); inV(d.outcome, CONFLICT_OUTCOMES, at, 'detail.outcome');
      return { outcome: d.outcome, reasonCodes: distinctList(d.reasonCodes, (x) => isText(x, L.code), at, 'detail.reasonCodes'), policyVersions: policyList(d.policyVersions, at, 'detail.policyVersions') };
    case 'compliance_context_policy_changed': { ex(['policyVersions']); const l = policyList(d.policyVersions, at, 'detail.policyVersions'); need(l.length === 1, at, 'detail.policyVersions', 'names the one version published'); return { policyVersions: l }; }
    default: need(d === null, at, 'detail', 'is null'); return null;
  }
}
function typeHistory(list, at, actions, typeDetail, byOpts) {
  need(Array.isArray(list), at, 'history', 'must be a list');
  const out = list.map((h, i) => {
    const a = `${at}.history[${i}]`;
    keysOnly(h, ['id', 'at', 'action', 'by', 'detail'], a);
    need(isId(h.id), a, 'id', 'must be an id'); need(isInt(h.at), a, 'at', 'must be an instant'); inV(h.action, actions, a, 'action');
    return { id: h.id, at: h.at, action: h.action, by: typeBy(h.by, `${a}.by`, byOpts), detail: typeDetail(h.action, h.detail ?? null, a) };
  });
  need(new Set(out.map((h) => h.id)).size === out.length, at, 'history', 'names an id twice');
  return out;
}
const CONTEXT_FIELDS = ['id', 'agencyOrgId', 'agentUserId', 'type', 'jurisdictions', 'parties', 'representations', 'resolvedFacts', 'reEvaluationPending', 'reviewRejectedAt', 'status', 'origin', 'transactionId', 'openedAt', 'closedAt', 'keys', 'rev', 'revAt', 'revBy', 'history'];
/** A context: flat columns, jurisdictions, parties, representations, resolved facts, keys and history (its evaluations are their own rows). */
export function typeContext(raw, at = 'complianceContexts') {
  const label = `${at} ${isPlainObject(raw) && typeof raw.id === 'string' ? raw.id : ''}`.trim();
  try {
    const { lastEvaluation: _l, evaluationCount: _n, ...rest } = isPlainObject(raw) ? raw : {};
    keysOnly(raw, [...CONTEXT_FIELDS, 'lastEvaluation', 'evaluationCount'], label);
    const r = rest;
    need(isId(r.id), label, 'id', 'must be an id'); need(isId(r.agencyOrgId), label, 'agencyOrgId', 'must be an id'); need(isId(r.agentUserId), label, 'agentUserId', 'must be an id');
    inV(r.type, CONTEXT_TYPES, label, 'type'); inV(r.status, CONTEXT_STATUSES, label, 'status');
    const jurisdictions = distinctList(r.jurisdictions, isMa, label, 'jurisdictions', { max: L.jurisdictions });
    need(jurisdictions.length > 0, label, 'jurisdictions', 'must not be empty');
    need(Array.isArray(r.parties), label, 'parties', 'must be a list');
    const parties = r.parties.map((p, i) => typeParty(p, `${label}.parties[${i}]`));
    need(new Set(parties.map((p) => p.id)).size === parties.length, label, 'parties', 'names an id twice');
    const live = parties.filter((p) => !p.removed).map((p) => p.partyRole);
    need(new Set(live).size === live.length, label, 'parties', 'names a party role twice');
    need(Array.isArray(r.representations), label, 'representations', 'must be a list');
    const representations = r.representations.map((x, i) => typeRepresentation(x, `${label}.representations[${i}]`));
    need(new Set(representations.map((x) => x.id)).size === representations.length, label, 'representations', 'names an id twice');
    const resolvedFacts = distinctList(r.resolvedFacts ?? [], (x) => RESOLVED_FACTS.includes(x), label, 'resolvedFacts');
    need(typeof r.reEvaluationPending === 'boolean', label, 'reEvaluationPending', 'must be true or false');
    for (const k of ['reviewRejectedAt', 'closedAt']) need(optInt(r[k]), label, k, 'must be an instant or null');
    need(isInt(r.openedAt), label, 'openedAt', 'must be an instant');
    need((r.status === 'closed') === (r.closedAt != null), label, 'closedAt', 'is set exactly when the context is closed');
    need((r.origin === undefined || r.origin === null) ? (r.transactionId === undefined || r.transactionId === null) : (r.origin === 'transaction' && isId(r.transactionId)), label, 'origin', 'is transaction, with its transactionId, or absent');
    const keys = typeKeys(r.keys, ['create'], label);
    const history = typeHistory(r.history ?? [], label, CONTEXT_ACTIONS, typeContextDetail);
    return {
      id: r.id, agencyOrgId: r.agencyOrgId, agentUserId: r.agentUserId, type: r.type, jurisdictions, parties, representations, resolvedFacts,
      reEvaluationPending: r.reEvaluationPending, reviewRejectedAt: r.reviewRejectedAt ?? null, status: r.status,
      ...(r.origin ? { origin: 'transaction', transactionId: r.transactionId } : {}), openedAt: r.openedAt, closedAt: r.closedAt ?? null,
      keys, ...revOf(r, label), history,
    };
  } catch (e) { if (e.code === 'COMPLIANCE_RECORDS_INPUT_INVALID') return { ok: false, reason: e.message.replace(/^[A-Z_]+: /, '') }; throw e; }
}
/** The result an evaluation records, with the identity of its inputs. */
function typeEvaluation(result, snapshotOf, at) {
  need(isPlainObject(result), at, 'evaluation', 'must be an engine result');
  inV(result.outcome, CONFLICT_OUTCOMES, at, 'outcome'); need(isInt(result.evaluatedAt), at, 'evaluatedAt', 'must be an instant');
  need(typeof result.inputHash === 'string' && /^[0-9a-f]{64}$/.test(result.inputHash), at, 'inputHash', 'must be a sha256 hex digest');
  const reasons = typeReasons(result.reasons, at);
  need(Array.isArray(result.consentsOutstanding), at, 'consentsOutstanding', 'must be a list');
  const consentsOutstanding = result.consentsOutstanding.map((c, i) => {
    const a = `${at}.consentsOutstanding[${i}]`; keysOnly(c, ['partyRole', 'agentUserId', 'consentKind', 'reasonCode'], a);
    inV(c.partyRole, PARTY_ROLES, a, 'partyRole'); inV(c.consentKind, CONSENT_KINDS, a, 'consentKind'); need(isText(c.reasonCode, L.code), a, 'reasonCode', 'names a reason');
    need(c.agentUserId === null || c.agentUserId === undefined || isId(c.agentUserId), a, 'agentUserId', 'must be an id');
    return { partyRole: c.partyRole, agentUserId: c.agentUserId ?? null, consentKind: c.consentKind, reasonCode: c.reasonCode };
  });
  keysOnly(snapshotOf, ['parties', 'representations', 'proposed'], `${at}.snapshotOf`);
  const parties = snapshotOf.parties.map((p, i) => { const a = `${at}.snapshotOf.parties[${i}]`; keysOnly(p, ['partyRole', 'subjectKind', 'subjectId'], a); inV(p.partyRole, PARTY_ROLES, a, 'partyRole'); inV(p.subjectKind, SUBJECT_KINDS, a, 'subjectKind'); need(isId(p.subjectId), a, 'subjectId', 'must be an id'); return { partyRole: p.partyRole, subjectKind: p.subjectKind, subjectId: p.subjectId }; });
  const representations = snapshotOf.representations.map((x, i) => { const a = `${at}.snapshotOf.representations[${i}]`; keysOnly(x, ['agentUserId', 'partyRole', 'status'], a); need(isId(x.agentUserId), a, 'agentUserId', 'must be an id'); inV(x.partyRole, PARTY_ROLES, a, 'partyRole'); inV(x.status, REPRESENTATION_STATUSES, a, 'status'); return { agentUserId: x.agentUserId, partyRole: x.partyRole, status: x.status }; });
  let proposed = null;
  if (snapshotOf.proposed) { keysOnly(snapshotOf.proposed, ['partyRole', 'agentUserId'], `${at}.snapshotOf.proposed`); inV(snapshotOf.proposed.partyRole, PARTY_ROLES, at, 'proposed.partyRole'); need(isId(snapshotOf.proposed.agentUserId), at, 'proposed.agentUserId', 'must be an id'); proposed = { partyRole: snapshotOf.proposed.partyRole, agentUserId: snapshotOf.proposed.agentUserId }; }
  return { outcome: result.outcome, reasons, consentsOutstanding, policyVersions: policyList(result.policyVersions, at), evaluatedAt: result.evaluatedAt, inputHash: result.inputHash, snapshotOf: { parties, representations, proposed } };
}

// ---- reviews
const PRIOR_KEYS = { verification_facet: ['facetState'], representation_dispute: ['agreementStatus'], representation_declared: ['contextOutcome', 'representationStatus'], conflict_evaluation: ['contextOutcome', 'representationStatus'] };
const STATE_VOCAB = { facetState: VERIFICATION_STATES, agreementStatus: AGREEMENT_STATUSES, contextOutcome: CONFLICT_OUTCOMES, representationStatus: REPRESENTATION_STATUSES };
const NOTE_OF = { verification_facet: 'profile gone', representation_dispute: 'not disputed any more', representation_declared: 'context gone', conflict_evaluation: 'context gone' };
function typeState(v, kind, at, { prior }) {
  if (v === null) return null;
  const keys = PRIOR_KEYS[kind];
  const note = NOTE_OF[kind];
  const gone = !prior && v.note !== undefined;
  const want = prior ? ['status', ...keys] : gone ? (kind === 'representation_dispute' ? ['agreementStatus', 'note'] : [keys[0], 'note']) : keys;
  keysOnly(v, want, at); for (const k of want) need(Object.hasOwn(v, k), at, k, 'is required');
  if (prior) inV(v.status, REVIEW_STATUSES, at, 'status');
  if (gone) need(v.note === note, at, 'note', `is "${note}" for a ${kind} review`);
  for (const k of keys) if (Object.hasOwn(v, k)) inV(v[k], STATE_VOCAB[k], at, k, { nullable: true });
  return Object.fromEntries(want.map((k) => [k, v[k] ?? null]));
}
function typeSubject(kind, s, at) {
  if (kind === 'verification_facet') {
    keysOnly(s, ['profileId', 'userId', 'facet', 'memberAssociation'], at);
    need(isId(s.profileId), at, 'profileId', 'must be an id'); need(isId(s.userId), at, 'userId', 'must be an id'); inV(s.facet, FACETS, at, 'facet');
    need(s.memberAssociation === null || s.memberAssociation === undefined || isMa(s.memberAssociation), at, 'memberAssociation', 'must be a code or null');
    return { profileId: s.profileId, userId: s.userId, facet: s.facet, memberAssociation: s.memberAssociation ?? null };
  }
  if (kind === 'representation_dispute') { keysOnly(s, ['agreementId'], at); need(isId(s.agreementId), at, 'agreementId', 'must be an id'); return { agreementId: s.agreementId }; }
  if (kind === 'conflict_evaluation' && s?.approach === true) {
    keysOnly(s, ['approach', 'playerId', 'jurisdiction'], at); need(isId(s.playerId), at, 'playerId', 'must be an id'); need(isMa(s.jurisdiction), at, 'jurisdiction', 'must be a code');
    return { approach: true, playerId: s.playerId, jurisdiction: s.jurisdiction };
  }
  keysOnly(s, ['contextId', 'transactionId', 'representationId', 'partyRole'], at);
  need(isId(s.contextId), at, 'contextId', 'must be an id'); inV(s.partyRole, PARTY_ROLES, at, 'partyRole');
  for (const k of ['transactionId', 'representationId']) need(s[k] === null || s[k] === undefined || isId(s[k]), at, k, 'must be an id or null');
  if (kind === 'representation_declared') need(isId(s.representationId), at, 'representationId', 'names the declared representation');
  return { contextId: s.contextId, ...(s.transactionId ? { transactionId: s.transactionId } : {}), representationId: s.representationId ?? null, partyRole: s.partyRole };
}
const REVIEW_FIELDS = ['id', 'kind', 'status', 'agencyOrgId', 'agentUserId', 'subject', 'reasons', 'policyVersions', 'snapshot', 'requestedAt', 'requestedBy', 'startedAt', 'startedBy', 'decidedAt', 'decision', 'supersedes', 'supersededBy', 'keys', 'rev', 'revAt', 'revBy', 'history'];
const uniqueCodes = (reasons) => [...new Set(reasons.map((x) => x.code))];
/** A review: subject by kind, reasons, versions, snapshot (outcome + evaluation row), decision and history. */
export function typeReview(raw, at = 'regulatoryReviews') {
  const label = `${at} ${isPlainObject(raw) && typeof raw.id === 'string' ? raw.id : ''}`.trim();
  try {
    keysOnly(raw, REVIEW_FIELDS, label);
    const r = raw;
    need(isId(r.id), label, 'id', 'must be an id'); inV(r.kind, REVIEW_KINDS, label, 'kind'); inV(r.status, REVIEW_STATUSES, label, 'status');
    need(isId(r.agencyOrgId), label, 'agencyOrgId', 'must be an id'); need(r.agentUserId === null || r.agentUserId === undefined || isId(r.agentUserId), label, 'agentUserId', 'must be an id or null');
    const subject = typeSubject(r.kind, r.subject, `${label}.subject`);
    const reasons = typeReasons(r.reasons ?? [], label);
    const policyVersions = policyList(r.policyVersions, label);
    let snapshot = null;
    if (r.snapshot !== null && r.snapshot !== undefined) {
      need(isPlainObject(r.snapshot), label, 'snapshot', 'must be an object or null');
      inV(r.snapshot.outcome, CONFLICT_OUTCOMES, label, 'snapshot.outcome');
      const evaluationId = r.snapshot.evaluationId ?? null;
      need(evaluationId === null || isId(evaluationId, 100), label, 'snapshot.evaluationId', 'must be an evaluation id or null');
      need(optInt(r.snapshot.evaluatedAt), label, 'snapshot.evaluatedAt', 'must be an instant or null');
      snapshot = { outcome: r.snapshot.outcome, evaluationId, evaluatedAt: r.snapshot.evaluatedAt ?? null };
    }
    need(isInt(r.requestedAt), label, 'requestedAt', 'must be an instant');
    const requestedBy = typeBy(r.requestedBy, `${label}.requestedBy`, { kinds: ['org', 'player', 'ts_reviewer', 'system'] });
    let startedBy = null;
    if (r.startedBy) { keysOnly(r.startedBy, ['id', 'name', 'role'], `${label}.startedBy`); need(isId(r.startedBy.id), label, 'startedBy.id', 'names the reviewer'); inV(r.startedBy.role, REVIEWER_ROLES, label, 'startedBy.role'); startedBy = { id: r.startedBy.id, name: r.startedBy.name ?? null, role: r.startedBy.role }; }
    need((r.startedAt != null) === (startedBy !== null), label, 'startedAt', 'is set, with startedBy, exactly when a reviewer started it');
    for (const k of ['startedAt', 'decidedAt']) need(optInt(r[k]), label, k, 'must be an instant or null');
    let decision = null;
    if (r.decision) {
      const d = r.decision; const a = `${label}.decision`;
      keysOnly(d, ['reviewerId', 'reviewerName', 'reviewerRole', 'outcome', 'reasonCode', 'reason', 'evidenceRefs', 'policyVersions', 'at', 'priorState', 'resultingState'], a);
      need(isId(d.reviewerId), a, 'reviewerId', 'names the reviewer'); inV(d.reviewerRole, REVIEWER_ROLES, a, 'reviewerRole'); inV(d.outcome, DECISION_OUTCOMES, a, 'outcome');
      need(isText(d.reasonCode, L.reasonCode), a, 'reasonCode', `must be text of 1 to ${L.reasonCode} characters`); need(isText(d.reason, L.reason), a, 'reason', `must be text of 1 to ${L.reason} characters`);
      const evidenceRefs = distinctList(d.evidenceRefs ?? [], (x) => isText(x, L.evidenceRef), a, 'evidenceRefs', { max: L.evidenceRefs });
      if (d.policyVersions !== undefined) need(same(d.policyVersions, policyVersions), a, 'policyVersions', 'repeats the review\'s own versions');
      need(isInt(d.at), a, 'at', 'must be an instant');
      const cancel = d.outcome === 'CANCELLED';
      const priorState = cancel ? (need(d.priorState === null, a, 'priorState', 'is null on a cancellation'), null) : typeState(d.priorState, r.kind, `${a}.priorState`, { prior: true });
      const resultingState = cancel ? (need(d.resultingState === null, a, 'resultingState', 'is null on a cancellation'), null) : typeState(d.resultingState, r.kind, `${a}.resultingState`, { prior: false });
      need(cancel || (priorState && resultingState), a, 'priorState', 'and resultingState are recorded with a decision');
      decision = { reviewerId: d.reviewerId, reviewerName: d.reviewerName ?? null, reviewerRole: d.reviewerRole, outcome: d.outcome, reasonCode: d.reasonCode, reason: d.reason, evidenceRefs, policyVersions, at: d.at, priorState, resultingState };
    }
    if (decision) need(decision.outcome === r.status || (r.status === 'SUPERSEDED' && decision.outcome !== 'CANCELLED'), label, 'status', 'follows the decision');
    need(decision !== null || !['APPROVED', 'REJECTED', 'SUPERSEDED'].includes(r.status), label, 'decision', 'is recorded with an APPROVED, REJECTED or SUPERSEDED status');
    need((r.decidedAt != null) === (decision !== null || r.status === 'CANCELLED'), label, 'decidedAt', 'is set exactly when the review is decided or cancelled');
    for (const k of ['supersedes', 'supersededBy']) need(r[k] === null || r[k] === undefined || isId(r[k]), label, k, 'must be a review id or null');
    need((r.status === 'SUPERSEDED') === (r.supersededBy != null), label, 'supersededBy', 'is set exactly when the review is superseded');
    const keys = typeKeys(r.keys, ['resolve'], label);
    const history = typeHistory(r.history ?? [], label, REVIEW_ACTIONS, (action, d, a) => typeReviewDetail(action, d, a, { kind: r.kind, reasons, policyVersions, decision }), { kinds: ['org', 'player', 'ts_reviewer', 'system'] });
    return {
      id: r.id, kind: r.kind, status: r.status, agencyOrgId: r.agencyOrgId, agentUserId: r.agentUserId ?? null, subject, reasons, policyVersions, snapshot,
      requestedAt: r.requestedAt, requestedBy, startedAt: r.startedAt ?? null, startedBy, decidedAt: r.decidedAt ?? null, decision,
      supersedes: r.supersedes ?? null, supersededBy: r.supersededBy ?? null, keys, ...revOf(r, label), history,
    };
  } catch (e) { if (e.code === 'COMPLIANCE_RECORDS_INPUT_INVALID') return { ok: false, reason: e.message.replace(/^[A-Z_]+: /, '') }; throw e; }
}
/** A review history detail; the request, resolution and cancellation repeat the review's own fields (worked out on read). */
function typeReviewDetail(action, d, at, own) {
  const ex = (req) => { keysOnly(d, req, `${at}.detail`); for (const k of req) need(Object.hasOwn(d, k), `${at}.detail`, k, 'is required'); };
  const rev = () => (need(isInt(d.rev) && d.rev >= 1, at, 'detail.rev', 'must be a revision'), d.rev);
  switch (action) {
    case 'regulatory_review_requested':
      if (d && Object.hasOwn(d, 'reviewId')) { ex(['reasonCode', 'reviewId']); need(d.reasonCode === 'supersedes' && isId(d.reviewId), at, 'detail', 'is { reasonCode: supersedes, reviewId }'); return { reasonCode: 'supersedes', reviewId: d.reviewId }; }
      ex(['kind', 'reasonCodes', 'policyVersions']);
      need(d.kind === own.kind && same(d.reasonCodes, uniqueCodes(own.reasons)) && same(d.policyVersions, own.policyVersions), at, 'detail', 'repeats the review\'s kind, reason codes and versions');
      return { kind: own.kind, reasonCodes: uniqueCodes(own.reasons), policyVersions: own.policyVersions };
    case 'regulatory_review_started': ex(['rev']); return { rev: rev() };
    case 'regulatory_review_resolved': {
      ex(['outcome', 'reasonCode', 'evidenceRefs', 'evidenceCount', 'policyVersions', 'priorState', 'resultingState', 'rev']);
      const dec = own.decision;
      need(dec && dec.outcome !== 'CANCELLED' && same([d.outcome, d.reasonCode, d.evidenceRefs, d.evidenceCount, d.policyVersions, d.priorState, d.resultingState], [dec.outcome, dec.reasonCode, dec.evidenceRefs, dec.evidenceRefs.length, dec.policyVersions, dec.priorState, dec.resultingState]), at, 'detail', 'repeats the decision');
      return { outcome: dec.outcome, reasonCode: dec.reasonCode, evidenceRefs: dec.evidenceRefs, evidenceCount: dec.evidenceRefs.length, policyVersions: dec.policyVersions, priorState: dec.priorState, resultingState: dec.resultingState, rev: rev() };
    }
    case 'regulatory_review_cancelled':
      if (d && Object.hasOwn(d, 'rev')) { ex(['outcome', 'reasonCode', 'rev']); need(d.outcome === 'CANCELLED' && d.reasonCode === 'cancelled', at, 'detail', 'is a reviewer\'s cancellation'); return { outcome: 'CANCELLED', reasonCode: 'cancelled', rev: rev() }; }
      ex(['reasonCode']); need(d.reasonCode === 'context_closed', at, 'detail.reasonCode', 'is context_closed'); return { reasonCode: 'context_closed' };
    default: {
      ex(['reasonCode', 'reviewId', 'priorState', 'rev']); need(d.reasonCode === 'superseded' && isId(d.reviewId), at, 'detail', 'names the superseding review');
      keysOnly(d.priorState, ['status'], `${at}.detail.priorState`); inV(d.priorState.status, REVIEW_STATUSES, at, 'detail.priorState.status');
      return { reasonCode: 'superseded', reviewId: d.reviewId, priorState: { status: d.priorState.status }, rev: rev() };
    }
  }
}

// ---- consents
const CONSENT_FIELDS = ['id', 'kind', 'contextId', 'agentUserId', 'agencyOrgId', 'partyRole', 'subject', 'regarding', 'status', 'requestedAt', 'requestedBy', 'grantedAt', 'grantedBy', 'declinedAt', 'declinedBy', 'particulars', 'policyVersions', 'ruleIds', 'keys', 'rev', 'revAt', 'revBy', 'history'];
/** A consent: the ledger row (status requested | granted | declined; a revocation is its own row). */
export function typeConsent(raw, at = 'regulatoryConsents') {
  const label = `${at} ${isPlainObject(raw) && typeof raw.id === 'string' ? raw.id : ''}`.trim();
  try {
    const { revokedAt: _r, ...k } = isPlainObject(raw) ? raw : {};
    keysOnly(raw, [...CONSENT_FIELDS, 'revokedAt'], label);
    need(isId(k.id), label, 'id', 'must be an id'); inV(k.kind, CONSENT_KINDS, label, 'kind');
    for (const f of ['contextId', 'agentUserId', 'agencyOrgId']) need(isId(k[f]), label, f, 'must be an id');
    inV(k.partyRole, PARTY_ROLES, label, 'partyRole');
    keysOnly(k.subject, ['kind', 'id'], `${label}.subject`); inV(k.subject.kind, SUBJECT_KINDS, label, 'subject.kind'); need(isId(k.subject.id), label, 'subject.id', 'must be an id');
    const regarding = distinctList(k.regarding ?? [], (x) => PARTY_ROLES.includes(x), label, 'regarding');
    inV(k.status, STORED_CONSENT_STATUSES, label, 'status');
    need(isInt(k.requestedAt), label, 'requestedAt', 'must be an instant');
    const requestedBy = typeBy(k.requestedBy, `${label}.requestedBy`, { kinds: ['org'] });
    for (const f of ['grantedAt', 'declinedAt']) need(optInt(k[f]), label, f, 'must be an instant or null');
    const grantedBy = k.grantedBy ? typeBy(k.grantedBy, `${label}.grantedBy`, { kinds: ['player', 'club_user'], signatory: true }) : null;
    const declinedBy = k.declinedBy ? typeBy(k.declinedBy, `${label}.declinedBy`, { kinds: ['player', 'club_user'] }) : null;
    need((k.status === 'granted') === (k.grantedAt != null && grantedBy !== null), label, 'grantedAt', 'is set, with grantedBy, exactly when granted');
    need((k.status === 'declined') === (k.declinedAt != null && declinedBy !== null), label, 'declinedAt', 'is set, with declinedBy, exactly when declined');
    const p = k.particulars;
    keysOnly(p, ['fullParticularsProvided', 'legalAdviceOffered', 'proposedFeeDisclosed', 'acknowledged'], `${label}.particulars`);
    for (const f of ['fullParticularsProvided', 'legalAdviceOffered', 'proposedFeeDisclosed']) need(typeof p[f] === 'boolean', label, `particulars.${f}`, 'must be true or false');
    let acknowledged = null;
    if (p.acknowledged !== null && p.acknowledged !== undefined) {
      keysOnly(p.acknowledged, ['particulars', 'legalAdvice', 'at'], `${label}.particulars.acknowledged`);
      need(p.acknowledged.particulars === true && p.acknowledged.legalAdvice === true && isInt(p.acknowledged.at), label, 'particulars.acknowledged', 'is { particulars: true, legalAdvice: true, at }');
      acknowledged = { particulars: true, legalAdvice: true, at: p.acknowledged.at };
    }
    need((k.status === 'granted') === (acknowledged !== null), label, 'particulars.acknowledged', 'is recorded exactly when granted');
    const policyVersions = policyList(k.policyVersions, label);
    const ruleIds = distinctList(k.ruleIds ?? [], (x) => isId(x, L.ruleId), label, 'ruleIds');
    const keys = typeKeys(k.keys, CONSENT_KEY_SLOTS, label);
    const history = typeHistory(k.history ?? [], label, CONSENT_ACTIONS, (action, d, a) => {
      const want = action === 'regulatory_consent_requested' ? { partyRole: k.partyRole, kind: k.kind, policyVersions } : action === 'regulatory_consent_granted' ? { partyRole: k.partyRole, policyVersions } : action === 'regulatory_consent_declined' ? { partyRole: k.partyRole } : { consentId: k.id, partyRole: k.partyRole };
      need(same(d, want), a, 'detail', 'repeats the consent\'s own fields');
      return want;
    });
    return {
      id: k.id, kind: k.kind, contextId: k.contextId, agentUserId: k.agentUserId, agencyOrgId: k.agencyOrgId, partyRole: k.partyRole, subject: { kind: k.subject.kind, id: k.subject.id }, regarding,
      status: k.status, requestedAt: k.requestedAt, requestedBy, grantedAt: k.grantedAt ?? null, grantedBy, declinedAt: k.declinedAt ?? null, declinedBy,
      particulars: { fullParticularsProvided: p.fullParticularsProvided, legalAdviceOffered: p.legalAdviceOffered, proposedFeeDisclosed: p.proposedFeeDisclosed, acknowledged },
      policyVersions, ruleIds, keys, ...revOf(k, label), history,
    };
  } catch (e) { if (e.code === 'COMPLIANCE_RECORDS_INPUT_INVALID') return { ok: false, reason: e.message.replace(/^[A-Z_]+: /, '') }; throw e; }
}
const okOr = (fn) => (raw, at) => { const out = fn(raw, at); return out && out.ok === false ? out : { ok: true, record: out }; };

// ------------------------------------------------------------------ rows
const st = new WeakMap();
function statements(sqlite) {
  let s = st.get(sqlite); if (s && s.prepare === sqlite.prepare) return s.list;
  const p = (sql) => sqlite.prepare(sql);
  const reasonIns = (prefix, owner) => p(`INSERT INTO ${prefix}_reasons (${owner}, ord, code, rule_id, rule_status, regulator, jurisdiction, policy_version_id, ${REASON_SCALARS.map(([, c]) => c).join(', ')}, via_connected_agent, has_party_roles, has_jurisdictions) VALUES (${Array(9 + REASON_SCALARS.length + 2).fill('?').join(', ')})`);
  const list = {
    context: p(`INSERT INTO compliance_contexts (id, agency_org_id, agent_user_id, type, status, re_evaluation_pending, review_rejected_at, origin, transaction_id, opened_at, closed_at, create_key, create_fp, rev, rev_at, rev_by_id, rev_by_name)
      VALUES (@id, @agency_org_id, @agent_user_id, @type, @status, @re_evaluation_pending, @review_rejected_at, @origin, @transaction_id, @opened_at, @closed_at, @create_key, @create_fp, @rev, @rev_at, @rev_by_id, @rev_by_name)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, re_evaluation_pending = excluded.re_evaluation_pending, review_rejected_at = excluded.review_rejected_at, closed_at = excluded.closed_at, rev = excluded.rev, rev_at = excluded.rev_at, rev_by_id = excluded.rev_by_id, rev_by_name = excluded.rev_by_name`),
    jurIns: p('INSERT INTO compliance_context_jurisdictions (context_id, ord, member_association) VALUES (?, ?, ?)'),
    partyDel: p('DELETE FROM compliance_context_parties WHERE context_id = ?'),
    partyIns: p('INSERT INTO compliance_context_parties (context_id, ord, id, party_role, subject_kind, subject_id, added_at, removed, removed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    repDel: p('DELETE FROM compliance_context_representations WHERE context_id = ?'),
    repIns: p('INSERT INTO compliance_context_representations (context_id, ord, id, agent_user_id, party_role, agreement_id, status, declared_only, review_id, declared_at, first_act_at, withdrawn_at, verified_by_review_id, verified_at, declare_key, declare_fp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    factDel: p('DELETE FROM compliance_context_resolved_facts WHERE context_id = ?'),
    factIns: p('INSERT INTO compliance_context_resolved_facts (context_id, ord, code) VALUES (?, ?, ?)'),
    ctxHist: p(`INSERT INTO compliance_context_history (id, context_id, ord, at, by_kind, by_id, by_name, by_role, by_org_id, action, detail_party_role, detail_subject_kind, detail_status, detail_review_outcome, detail_evaluation_id, detail_review_id, detail_policy_version_id)
      VALUES (@id, @owner, @ord, @at, @by_kind, @by_id, @by_name, @by_role, @by_org_id, @action, @detail_party_role, @detail_subject_kind, @detail_status, @detail_review_outcome, @detail_evaluation_id, @detail_review_id, @detail_policy_version_id)`),
    ctxHistPv: p('INSERT INTO compliance_context_history_policy_versions (history_id, ord, policy_version_id) VALUES (?, ?, ?)'),
    evaluation: p('INSERT INTO compliance_evaluations (id, context_id, position, outcome, evaluated_at, input_hash, proposed_party_role, proposed_agent_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    evReason: reasonIns('compliance_evaluation', 'evaluation_id'),
    evReasonItem: p('INSERT INTO compliance_evaluation_reason_items (evaluation_id, reason_ord, list, ord, value) VALUES (?, ?, ?, ?, ?)'),
    evConsent: p('INSERT INTO compliance_evaluation_consents_outstanding (evaluation_id, ord, party_role, agent_user_id, consent_kind, reason_code) VALUES (?, ?, ?, ?, ?, ?)'),
    evPv: p('INSERT INTO compliance_evaluation_policy_versions (evaluation_id, ord, policy_version_id) VALUES (?, ?, ?)'),
    evParty: p('INSERT INTO compliance_evaluation_snapshot_parties (evaluation_id, ord, party_role, subject_kind, subject_id) VALUES (?, ?, ?, ?, ?)'),
    evRep: p('INSERT INTO compliance_evaluation_snapshot_representations (evaluation_id, ord, agent_user_id, party_role, status) VALUES (?, ?, ?, ?, ?)'),
    review: p(`INSERT INTO regulatory_reviews (${REVIEW_COLS.join(', ')}) VALUES (${REVIEW_COLS.map((c) => `@${c}`).join(', ')}) ON CONFLICT(id) DO UPDATE SET ${REVIEW_COLS.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')}`),
    rvReason: reasonIns('regulatory_review', 'review_id'),
    rvReasonItem: p('INSERT INTO regulatory_review_reason_items (review_id, reason_ord, list, ord, value) VALUES (?, ?, ?, ?, ?)'),
    rvPv: p('INSERT INTO regulatory_review_policy_versions (review_id, ord, policy_version_id) VALUES (?, ?, ?)'),
    rvRefDel: p('DELETE FROM regulatory_review_evidence_refs WHERE review_id = ?'),
    rvRef: p('INSERT INTO regulatory_review_evidence_refs (review_id, ord, ref) VALUES (?, ?, ?)'),
    rvHist: p('INSERT INTO regulatory_review_history (id, review_id, ord, at, by_kind, by_id, by_name, by_role, by_org_id, action, detail_rev, detail_review_id, detail_prior_status) VALUES (@id, @owner, @ord, @at, @by_kind, @by_id, @by_name, @by_role, @by_org_id, @action, @detail_rev, @detail_review_id, @detail_prior_status)'),
    consent: p(`INSERT INTO regulatory_consents (${CONSENT_COLS.join(', ')}) VALUES (${CONSENT_COLS.map((c) => `@${c}`).join(', ')}) ON CONFLICT(id) DO UPDATE SET ${CONSENT_COLS.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')}`),
    csRegarding: p('INSERT INTO regulatory_consent_regarding (consent_id, ord, party_role) VALUES (?, ?, ?)'),
    csPv: p('INSERT INTO regulatory_consent_policy_versions (consent_id, ord, policy_version_id) VALUES (?, ?, ?)'),
    csRule: p('INSERT INTO regulatory_consent_rule_ids (consent_id, ord, rule_id) VALUES (?, ?, ?)'),
    csHist: p('INSERT INTO regulatory_consent_history (id, consent_id, ord, at, by_kind, by_id, by_name, by_role, by_org_id, action) VALUES (@id, @owner, @ord, @at, @by_kind, @by_id, @by_name, @by_role, @by_org_id, @action)'),
    revocation: p('INSERT INTO regulatory_consent_revocations (id, consent_id, revoked_at, by_kind, by_id, by_name, by_org_id) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  };
  st.set(sqlite, { prepare: sqlite.prepare, list });
  return list;
}
const REVIEW_COLS = ['id', 'kind', 'status', 'agency_org_id', 'agent_user_id', 'subject_profile_id', 'subject_user_id', 'subject_facet', 'subject_member_association', 'subject_agreement_id', 'subject_context_id', 'subject_transaction_id', 'subject_representation_id', 'subject_party_role', 'subject_is_approach', 'subject_player_id', 'subject_jurisdiction', 'snapshot_outcome', 'snapshot_evaluation_id', 'snapshot_evaluated_at', 'requested_at', 'requested_by_kind', 'requested_by_id', 'requested_by_name', 'requested_by_role', 'started_at', 'started_by_id', 'started_by_name', 'started_by_role', 'decided_at', 'decision_reviewer_id', 'decision_reviewer_name', 'decision_reviewer_role', 'decision_outcome', 'decision_reason_code', 'decision_reason', 'decision_at', 'prior_status', 'prior_facet_state', 'prior_agreement_status', 'prior_context_outcome', 'prior_representation_status', 'result_facet_state', 'result_agreement_status', 'result_context_outcome', 'result_representation_status', 'result_note', 'supersedes_id', 'superseded_by_id', 'resolve_key', 'resolve_fp', 'rev', 'rev_at', 'rev_by_id', 'rev_by_name'];
const CONSENT_COLS = ['id', 'kind', 'context_id', 'agent_user_id', 'agency_org_id', 'party_role', 'subject_kind', 'subject_id', 'status', 'requested_at', 'requested_by_kind', 'requested_by_id', 'requested_by_name', 'requested_by_role', 'granted_at', 'granted_by_kind', 'granted_by_id', 'granted_by_name', 'granted_by_org_id', 'granted_by_signatory', 'declined_at', 'declined_by_kind', 'declined_by_id', 'declined_by_name', 'declined_by_org_id', 'full_particulars_provided', 'legal_advice_offered', 'proposed_fee_disclosed', 'acknowledged_at', ...CONSENT_KEY_SLOTS.flatMap((s) => [`${s}_key`, `${s}_fp`]), 'rev', 'rev_at', 'rev_by_id', 'rev_by_name'];

function writeReasons(ins, itemIns, owner, reasons) {
  reasons.forEach((r, i) => {
    ins.run(owner, i, r.code, r.ruleId, r.ruleStatus, r.regulator, r.jurisdiction, r.policyVersion, ...REASON_SCALARS.map(([k]) => r[k] ?? null), r.viaConnectedAgent ? 1 : null, r.partyRoles ? 1 : 0, r.jurisdictions ? 1 : 0);
    for (const list of REASON_LISTS) (r[list] ?? []).forEach((v, j) => itemIns.run(owner, i, list, j, v));
  });
}
function readReason(row, items) {
  const out = { code: row.code, ruleId: row.rule_id, ruleStatus: row.rule_status, regulator: row.regulator, jurisdiction: row.jurisdiction, policyVersion: row.policy_version_id };
  for (const [k, c] of REASON_SCALARS) {
    if (row[c] !== null) out[k] = row[c];
    if (k === 'partyRole' && row.has_party_roles) out.partyRoles = items.filter((x) => x.list === 'partyRoles').map((x) => x.value);
  }
  if (row.via_connected_agent) out.viaConnectedAgent = true;
  if (row.has_jurisdictions) out.jurisdictions = items.filter((x) => x.list === 'jurisdictions').map((x) => x.value);
  return out;
}

function writeContext(s, c, { isNew, knownHistory = 0, latestEvaluationId = null }) {
  s.context.run({
    id: c.id, agency_org_id: c.agencyOrgId, agent_user_id: c.agentUserId, type: c.type, status: c.status, re_evaluation_pending: c.reEvaluationPending ? 1 : 0,
    review_rejected_at: c.reviewRejectedAt, origin: c.origin ?? null, transaction_id: c.transactionId ?? null, opened_at: c.openedAt, closed_at: c.closedAt,
    create_key: c.keys.create?.key ?? null, create_fp: c.keys.create?.fp ?? null, ...revCols(c),
  });
  if (isNew) c.jurisdictions.forEach((j, i) => s.jurIns.run(c.id, i, j));
  s.partyDel.run(c.id);
  c.parties.forEach((p, i) => s.partyIns.run(c.id, i, p.id, p.partyRole, p.subjectKind, p.subjectId, p.addedAt, p.removed ? 1 : 0, p.removedAt));
  s.repDel.run(c.id);
  c.representations.forEach((r, i) => s.repIns.run(c.id, i, r.id, r.agentUserId, r.partyRole, r.agreementId, r.status, r.declaredOnly ? 1 : 0, r.reviewId, r.declaredAt, r.firstActAt, r.withdrawnAt, r.verifiedByReviewId, r.verifiedAt, r.keys.declare?.key ?? null, r.keys.declare?.fp ?? null));
  s.factDel.run(c.id);
  c.resolvedFacts.forEach((f, i) => s.factIns.run(c.id, i, f));
  c.history.slice(knownHistory).forEach((h, i) => writeContextEntry(s, c.id, knownHistory + i, h, latestEvaluationId));
}
function writeContextEntry(s, owner, ord, h, evaluationId) {
  const d = h.detail ?? {};
  const linksEvaluation = (h.action === 'compliance_context_evaluated' && !d.reviewId) || (h.action === 'compliance_representation_declared' && d.status === 'verified');
  if (linksEvaluation && !evaluationId) FAIL(`compliance_context_history ${h.id}: an evaluation entry needs the evaluation it repeats`);
  s.ctxHist.run({
    id: h.id, owner, ord, at: h.at, ...byCols(h.by), action: h.action,
    detail_party_role: d.partyRole ?? null, detail_subject_kind: h.action === 'compliance_context_party_added' ? d.kind : null,
    detail_status: h.action === 'compliance_representation_declared' ? d.status : null,
    detail_review_outcome: h.action === 'compliance_context_evaluated' && d.reviewId ? d.outcome : null,
    detail_evaluation_id: linksEvaluation ? evaluationId : null, detail_review_id: d.reviewId ?? null,
    detail_policy_version_id: h.action === 'compliance_context_policy_changed' ? d.policyVersions[0] : null,
  });
  if (h.action === 'compliance_context_opened') d.policyVersions.forEach((pv, i) => s.ctxHistPv.run(h.id, i, pv));
}
function writeEvaluation(s, contextId, position, e) {
  const id = `${contextId}#${position}`;
  s.evaluation.run(id, contextId, position, e.outcome, e.evaluatedAt, e.inputHash, e.snapshotOf.proposed?.partyRole ?? null, e.snapshotOf.proposed?.agentUserId ?? null);
  writeReasons(s.evReason, s.evReasonItem, id, e.reasons);
  e.consentsOutstanding.forEach((c, i) => s.evConsent.run(id, i, c.partyRole, c.agentUserId, c.consentKind, c.reasonCode));
  e.policyVersions.forEach((pv, i) => s.evPv.run(id, i, pv));
  e.snapshotOf.parties.forEach((p, i) => s.evParty.run(id, i, p.partyRole, p.subjectKind, p.subjectId));
  e.snapshotOf.representations.forEach((r, i) => s.evRep.run(id, i, r.agentUserId, r.partyRole, r.status));
  return id;
}
function reviewRow(r) {
  const sub = r.subject; const d = r.decision; const ps = d?.priorState ?? {}; const rs = d?.resultingState ?? {};
  return {
    id: r.id, kind: r.kind, status: r.status, agency_org_id: r.agencyOrgId, agent_user_id: r.agentUserId,
    subject_profile_id: sub.profileId ?? null, subject_user_id: sub.userId ?? null, subject_facet: sub.facet ?? null, subject_member_association: sub.memberAssociation ?? null,
    subject_agreement_id: sub.agreementId ?? null, subject_context_id: sub.contextId ?? null, subject_transaction_id: sub.transactionId ?? null,
    subject_representation_id: sub.representationId ?? null, subject_party_role: sub.partyRole ?? null, subject_is_approach: sub.approach ? 1 : 0,
    subject_player_id: sub.playerId ?? null, subject_jurisdiction: sub.jurisdiction ?? null,
    snapshot_outcome: r.snapshot?.outcome ?? null, snapshot_evaluation_id: r.snapshot?.evaluationId ?? null, snapshot_evaluated_at: r.snapshot?.evaluatedAt ?? null,
    requested_at: r.requestedAt, ...byCols(r.requestedBy, 'requested_by'),
    started_at: r.startedAt, started_by_id: r.startedBy?.id ?? null, started_by_name: r.startedBy?.name ?? null, started_by_role: r.startedBy?.role ?? null,
    decided_at: r.decidedAt, decision_reviewer_id: d?.reviewerId ?? null, decision_reviewer_name: d?.reviewerName ?? null, decision_reviewer_role: d?.reviewerRole ?? null,
    decision_outcome: d?.outcome ?? null, decision_reason_code: d?.reasonCode ?? null, decision_reason: d?.reason ?? null, decision_at: d?.at ?? null,
    prior_status: d?.priorState ? ps.status : null, prior_facet_state: ps.facetState ?? null, prior_agreement_status: ps.agreementStatus ?? null,
    prior_context_outcome: ps.contextOutcome ?? null, prior_representation_status: ps.representationStatus ?? null,
    result_facet_state: rs.facetState ?? null, result_agreement_status: rs.agreementStatus ?? null, result_context_outcome: rs.contextOutcome ?? null,
    result_representation_status: rs.representationStatus ?? null, result_note: rs.note ?? null,
    supersedes_id: r.supersedes, superseded_by_id: r.supersededBy, resolve_key: r.keys.resolve?.key ?? null, resolve_fp: r.keys.resolve?.fp ?? null, ...revCols(r),
  };
}
function writeReview(s, r, { isNew, knownHistory = 0 }) {
  s.review.run(reviewRow(r));
  if (isNew) { writeReasons(s.rvReason, s.rvReasonItem, r.id, r.reasons); r.policyVersions.forEach((pv, i) => s.rvPv.run(r.id, i, pv)); }
  s.rvRefDel.run(r.id);
  (r.decision?.evidenceRefs ?? []).forEach((ref, i) => s.rvRef.run(r.id, i, ref));
  writeReviewHistory(s, r, knownHistory);
}
function writeReviewHistory(s, r, knownHistory = 0) {
  r.history.slice(knownHistory).forEach((h, i) => {
    const d = h.detail ?? {};
    s.rvHist.run({ id: h.id, owner: r.id, ord: knownHistory + i, at: h.at, ...byCols(h.by), action: h.action, detail_rev: d.rev ?? null, detail_review_id: d.reviewId ?? null, detail_prior_status: d.priorState && h.action === 'regulatory_review_superseded' ? d.priorState.status : null });
  });
}
function writeConsent(s, k, { isNew, knownHistory = 0 }) {
  s.consent.run({
    id: k.id, kind: k.kind, context_id: k.contextId, agent_user_id: k.agentUserId, agency_org_id: k.agencyOrgId, party_role: k.partyRole, subject_kind: k.subject.kind, subject_id: k.subject.id,
    status: k.status, requested_at: k.requestedAt, ...byCols(k.requestedBy, 'requested_by'),
    granted_at: k.grantedAt, granted_by_kind: k.grantedBy?.kind ?? null, granted_by_id: k.grantedBy?.userId ?? null, granted_by_name: k.grantedBy?.name ?? null, granted_by_org_id: k.grantedBy?.orgId ?? null, granted_by_signatory: k.grantedBy?.signatory ? 1 : null,
    declined_at: k.declinedAt, declined_by_kind: k.declinedBy?.kind ?? null, declined_by_id: k.declinedBy?.userId ?? null, declined_by_name: k.declinedBy?.name ?? null, declined_by_org_id: k.declinedBy?.orgId ?? null,
    full_particulars_provided: k.particulars.fullParticularsProvided ? 1 : 0, legal_advice_offered: k.particulars.legalAdviceOffered ? 1 : 0, proposed_fee_disclosed: k.particulars.proposedFeeDisclosed ? 1 : 0,
    acknowledged_at: k.particulars.acknowledged?.at ?? null,
    ...Object.fromEntries(CONSENT_KEY_SLOTS.flatMap((sl) => [[`${sl}_key`, k.keys[sl]?.key ?? null], [`${sl}_fp`, k.keys[sl]?.fp ?? null]])), ...revCols(k),
  });
  if (isNew) { k.regarding.forEach((x, i) => s.csRegarding.run(k.id, i, x)); k.policyVersions.forEach((x, i) => s.csPv.run(k.id, i, x)); k.ruleIds.forEach((x, i) => s.csRule.run(k.id, i, x)); }
  k.history.slice(knownHistory).forEach((h, i) => s.csHist.run({ id: h.id, owner: k.id, ord: knownHistory + i, at: h.at, ...byCols(h.by), action: h.action }));
}

// ---- decoding
const inIds = (sqlite, sql, list) => (list.length ? sqlite.prepare(sql).all(JSON.stringify([...new Set(list)])) : []);
const groupBy = (rows, key) => { const m = new Map(); for (const r of rows) { const k = key(r); let l = m.get(k); if (!l) m.set(k, (l = [])); l.push(r); } return (k) => m.get(k) ?? []; };
const IN = (col) => `${col} IN (SELECT value FROM json_each(?))`;
function decodeReasonsOf(sqlite, prefix, owner, ownerIds) {
  const rows = groupBy(inIds(sqlite, `SELECT * FROM ${prefix}_reasons WHERE ${IN(owner)} ORDER BY ${owner}, ord`, ownerIds), (r) => r[owner]);
  const items = groupBy(inIds(sqlite, `SELECT * FROM ${prefix}_reason_items WHERE ${IN(owner)} ORDER BY ${owner}, reason_ord, list, ord`, ownerIds), (r) => `${r[owner]}#${r.reason_ord}`);
  return (id) => rows(id).map((r) => readReason(r, items(`${id}#${r.ord}`)));
}
function decodeEvaluations(sqlite, rows) {
  const evIds = rows.map((r) => r.id);
  const reasons = decodeReasonsOf(sqlite, 'compliance_evaluation', 'evaluation_id', evIds);
  const consents = groupBy(inIds(sqlite, `SELECT * FROM compliance_evaluation_consents_outstanding WHERE ${IN('evaluation_id')} ORDER BY evaluation_id, ord`, evIds), (r) => r.evaluation_id);
  const pvs = groupBy(inIds(sqlite, `SELECT * FROM compliance_evaluation_policy_versions WHERE ${IN('evaluation_id')} ORDER BY evaluation_id, ord`, evIds), (r) => r.evaluation_id);
  const parties = groupBy(inIds(sqlite, `SELECT * FROM compliance_evaluation_snapshot_parties WHERE ${IN('evaluation_id')} ORDER BY evaluation_id, ord`, evIds), (r) => r.evaluation_id);
  const reps = groupBy(inIds(sqlite, `SELECT * FROM compliance_evaluation_snapshot_representations WHERE ${IN('evaluation_id')} ORDER BY evaluation_id, ord`, evIds), (r) => r.evaluation_id);
  return rows.map((row) => {
    const rs = reasons(row.id);
    const co = consents(row.id).map((c) => ({ partyRole: c.party_role, agentUserId: c.agent_user_id, consentKind: c.consent_kind, reasonCode: c.reason_code }));
    const derived = derivedOfEvaluation({ outcome: row.outcome, reasons: rs, consentsOutstanding: co });
    return {
      outcome: row.outcome, alias: derived.alias, reasons: rs, consentsOutstanding: co, requiredActions: derived.requiredActions, missingEvidence: derived.missingEvidence,
      policyVersions: pvs(row.id).map((p) => p.policy_version_id), evaluatedAt: row.evaluated_at, inputHash: row.input_hash,
      snapshotOf: {
        parties: parties(row.id).map((p) => ({ partyRole: p.party_role, subjectKind: p.subject_kind, subjectId: p.subject_id })),
        representations: reps(row.id).map((r) => ({ agentUserId: r.agent_user_id, partyRole: r.party_role, status: r.status })),
        proposed: row.proposed_party_role === null ? null : { partyRole: row.proposed_party_role, agentUserId: row.proposed_agent_user_id },
      },
      ruleStatuses: derived.ruleStatuses, evaluationId: row.id, contextId: row.context_id, position: row.position,
    };
  });
}
function decodeContexts(sqlite, rows) {
  const cids = rows.map((r) => r.id);
  const jur = groupBy(inIds(sqlite, `SELECT * FROM compliance_context_jurisdictions WHERE ${IN('context_id')} ORDER BY context_id, ord`, cids), (r) => r.context_id);
  const parties = groupBy(inIds(sqlite, `SELECT * FROM compliance_context_parties WHERE ${IN('context_id')} ORDER BY context_id, ord`, cids), (r) => r.context_id);
  const reps = groupBy(inIds(sqlite, `SELECT * FROM compliance_context_representations WHERE ${IN('context_id')} ORDER BY context_id, ord`, cids), (r) => r.context_id);
  const facts = groupBy(inIds(sqlite, `SELECT * FROM compliance_context_resolved_facts WHERE ${IN('context_id')} ORDER BY context_id, ord`, cids), (r) => r.context_id);
  const histRows = inIds(sqlite, `SELECT * FROM compliance_context_history WHERE ${IN('context_id')} ORDER BY context_id, ord`, cids);
  const hist = groupBy(histRows, (r) => r.context_id);
  const histPv = groupBy(inIds(sqlite, `SELECT * FROM compliance_context_history_policy_versions WHERE ${IN('history_id')} ORDER BY history_id, ord`, histRows.filter((h) => h.action === 'compliance_context_opened').map((h) => h.id)), (r) => r.history_id);
  const lastRows = inIds(sqlite, `SELECT e.* FROM compliance_evaluations e JOIN (SELECT context_id, MAX(position) AS p FROM compliance_evaluations WHERE ${IN('context_id')} GROUP BY context_id) m ON m.context_id = e.context_id AND m.p = e.position`, cids);
  const linkedIds = histRows.map((h) => h.detail_evaluation_id).filter(Boolean);
  const evRows = [...lastRows, ...inIds(sqlite, `SELECT * FROM compliance_evaluations WHERE ${IN('id')}`, linkedIds).filter((r) => !lastRows.some((l) => l.id === r.id))];
  const evs = new Map(decodeEvaluations(sqlite, evRows).map((e) => [e.evaluationId, e]));
  const lastOf = new Map(lastRows.map((r) => [r.context_id, r]));
  return rows.map((row) => {
    const type = row.type;
    const history = hist(row.id).map((h) => {
      const ev = h.detail_evaluation_id ? evs.get(h.detail_evaluation_id) : null;
      let detail = null;
      switch (h.action) {
        case 'compliance_context_opened': detail = { type, policyVersions: histPv(h.id).map((p) => p.policy_version_id) }; break;
        case 'compliance_context_party_added': detail = { partyRole: h.detail_party_role, kind: h.detail_subject_kind }; break;
        case 'compliance_context_party_removed': detail = { partyRole: h.detail_party_role }; break;
        case 'compliance_representation_declared': detail = h.detail_status === 'pending_review' ? { partyRole: h.detail_party_role, status: 'pending_review' } : { partyRole: h.detail_party_role, status: 'verified', outcome: ev.outcome, policyVersions: ev.policyVersions }; break;
        case 'compliance_representation_verified': detail = { partyRole: h.detail_party_role, reviewId: h.detail_review_id }; break;
        case 'compliance_representation_withdrawn': detail = { partyRole: h.detail_party_role, ...(h.detail_review_id ? { reviewId: h.detail_review_id } : {}) }; break;
        case 'compliance_context_evaluated': detail = h.detail_review_id ? { reviewId: h.detail_review_id, outcome: h.detail_review_outcome } : { outcome: ev.outcome, reasonCodes: [...new Set(ev.reasons.map((x) => x.code))], policyVersions: ev.policyVersions }; break;
        case 'compliance_context_policy_changed': detail = { policyVersions: [h.detail_policy_version_id] }; break;
        default: detail = null;
      }
      return { id: h.id, at: h.at, action: h.action, by: byOfRow(h), detail };
    });
    const last = lastOf.get(row.id);
    return {
      id: row.id, agencyOrgId: row.agency_org_id, agentUserId: row.agent_user_id, type, jurisdictions: jur(row.id).map((j) => j.member_association),
      parties: parties(row.id).map((p) => ({ id: p.id, partyRole: p.party_role, subjectKind: p.subject_kind, subjectId: p.subject_id, addedAt: p.added_at, removed: p.removed === 1, removedAt: p.removed_at })),
      representations: reps(row.id).map((r) => ({ id: r.id, agentUserId: r.agent_user_id, partyRole: r.party_role, agreementId: r.agreement_id, status: r.status, declaredOnly: r.declared_only === 1, reviewId: r.review_id, declaredAt: r.declared_at, firstActAt: r.first_act_at, withdrawnAt: r.withdrawn_at, verifiedByReviewId: r.verified_by_review_id, verifiedAt: r.verified_at, keys: r.declare_key === null ? {} : { declare: { key: r.declare_key, fp: r.declare_fp } } })),
      resolvedFacts: facts(row.id).map((f) => f.code), reEvaluationPending: row.re_evaluation_pending === 1, reviewRejectedAt: row.review_rejected_at, status: row.status,
      ...(row.origin ? { origin: row.origin, transactionId: row.transaction_id } : {}), openedAt: row.opened_at, closedAt: row.closed_at,
      keys: row.create_key === null ? {} : { create: { key: row.create_key, fp: row.create_fp } }, ...revOfRow(row), history,
      lastEvaluation: last ? evs.get(last.id) : null, evaluationCount: last ? last.position : 0,
    };
  });
}
function decodeReviews(sqlite, rows) {
  const rids = rows.map((r) => r.id);
  const reasons = decodeReasonsOf(sqlite, 'regulatory_review', 'review_id', rids);
  const pvs = groupBy(inIds(sqlite, `SELECT * FROM regulatory_review_policy_versions WHERE ${IN('review_id')} ORDER BY review_id, ord`, rids), (r) => r.review_id);
  const refs = groupBy(inIds(sqlite, `SELECT * FROM regulatory_review_evidence_refs WHERE ${IN('review_id')} ORDER BY review_id, ord`, rids), (r) => r.review_id);
  const hist = groupBy(inIds(sqlite, `SELECT * FROM regulatory_review_history WHERE ${IN('review_id')} ORDER BY review_id, ord`, rids), (r) => r.review_id);
  const evs = new Map(decodeEvaluations(sqlite, inIds(sqlite, `SELECT * FROM compliance_evaluations WHERE ${IN('id')}`, rows.map((r) => r.snapshot_evaluation_id).filter(Boolean))).map((e) => [e.evaluationId, e]));
  return rows.map((row) => {
    const kind = row.kind;
    const rs = reasons(row.id); const policyVersions = pvs(row.id).map((p) => p.policy_version_id);
    const subject = kind === 'verification_facet' ? { profileId: row.subject_profile_id, userId: row.subject_user_id, facet: row.subject_facet, memberAssociation: row.subject_member_association }
      : kind === 'representation_dispute' ? { agreementId: row.subject_agreement_id }
        : row.subject_is_approach ? { approach: true, playerId: row.subject_player_id, jurisdiction: row.subject_jurisdiction }
          : { contextId: row.subject_context_id, ...(row.subject_transaction_id ? { transactionId: row.subject_transaction_id } : {}), representationId: row.subject_representation_id, partyRole: row.subject_party_role };
    let snapshot = null;
    if (row.snapshot_outcome !== null) {
      const ev = row.snapshot_evaluation_id ? evs.get(row.snapshot_evaluation_id) : null;
      snapshot = ev
        ? { outcome: ev.outcome, alias: ev.alias, reasons: ev.reasons, consentsOutstanding: ev.consentsOutstanding, requiredActions: ev.requiredActions, missingEvidence: ev.missingEvidence, policyVersions: ev.policyVersions, evaluatedAt: ev.evaluatedAt, inputHash: ev.inputHash, proposed: ev.snapshotOf.proposed, evaluationId: ev.evaluationId }
        : { outcome: row.snapshot_outcome, reasons: rs, policyVersions, evaluatedAt: row.snapshot_evaluated_at };
    }
    const keysOfState = PRIOR_KEYS[kind];
    const col = { facetState: 'facet_state', agreementStatus: 'agreement_status', contextOutcome: 'context_outcome', representationStatus: 'representation_status' };
    let decision = null;
    if (row.decision_reviewer_id !== null) {
      const cancel = row.decision_outcome === 'CANCELLED';
      const prior = cancel ? null : { status: row.prior_status, ...Object.fromEntries(keysOfState.map((k) => [k, row[`prior_${col[k]}`]])) };
      const resultKeys = row.result_note ? (kind === 'representation_dispute' ? ['agreementStatus'] : [keysOfState[0]]) : keysOfState;
      const resulting = cancel ? null : { ...Object.fromEntries(resultKeys.map((k) => [k, row[`result_${col[k]}`]])), ...(row.result_note ? { note: row.result_note } : {}) };
      decision = { reviewerId: row.decision_reviewer_id, reviewerName: row.decision_reviewer_name, reviewerRole: row.decision_reviewer_role, outcome: row.decision_outcome, reasonCode: row.decision_reason_code, reason: row.decision_reason, evidenceRefs: refs(row.id).map((x) => x.ref), policyVersions, at: row.decision_at, priorState: prior, resultingState: resulting };
    }
    const history = hist(row.id).map((h) => {
      let detail;
      if (h.action === 'regulatory_review_requested') detail = h.detail_review_id ? { reasonCode: 'supersedes', reviewId: h.detail_review_id } : { kind, reasonCodes: uniqueCodes(rs), policyVersions };
      else if (h.action === 'regulatory_review_started') detail = { rev: h.detail_rev };
      else if (h.action === 'regulatory_review_resolved') detail = { outcome: decision.outcome, reasonCode: decision.reasonCode, evidenceRefs: decision.evidenceRefs, evidenceCount: decision.evidenceRefs.length, policyVersions, priorState: decision.priorState, resultingState: decision.resultingState, rev: h.detail_rev };
      else if (h.action === 'regulatory_review_cancelled') detail = h.detail_rev === null ? { reasonCode: 'context_closed' } : { outcome: 'CANCELLED', reasonCode: 'cancelled', rev: h.detail_rev };
      else detail = { reasonCode: 'superseded', reviewId: h.detail_review_id, priorState: { status: h.detail_prior_status }, rev: h.detail_rev };
      return { id: h.id, at: h.at, action: h.action, by: byOfRow(h), detail };
    });
    return {
      id: row.id, kind, status: row.status, agencyOrgId: row.agency_org_id, agentUserId: row.agent_user_id, subject, reasons: rs, policyVersions, snapshot,
      requestedAt: row.requested_at, requestedBy: byOfRow(row, 'requested_by'), startedAt: row.started_at,
      startedBy: row.started_by_id === null ? null : { id: row.started_by_id, name: row.started_by_name, role: row.started_by_role },
      decidedAt: row.decided_at, decision, supersedes: row.supersedes_id, supersededBy: row.superseded_by_id,
      keys: row.resolve_key === null ? {} : { resolve: { key: row.resolve_key, fp: row.resolve_fp } }, ...revOfRow(row), history,
    };
  });
}
function decodeConsents(sqlite, rows) {
  const kids = rows.map((r) => r.id);
  const regarding = groupBy(inIds(sqlite, `SELECT * FROM regulatory_consent_regarding WHERE ${IN('consent_id')} ORDER BY consent_id, ord`, kids), (r) => r.consent_id);
  const pvs = groupBy(inIds(sqlite, `SELECT * FROM regulatory_consent_policy_versions WHERE ${IN('consent_id')} ORDER BY consent_id, ord`, kids), (r) => r.consent_id);
  const rules = groupBy(inIds(sqlite, `SELECT * FROM regulatory_consent_rule_ids WHERE ${IN('consent_id')} ORDER BY consent_id, ord`, kids), (r) => r.consent_id);
  const hist = groupBy(inIds(sqlite, `SELECT * FROM regulatory_consent_history WHERE ${IN('consent_id')} ORDER BY consent_id, ord`, kids), (r) => r.consent_id);
  const revs = new Map(inIds(sqlite, `SELECT * FROM regulatory_consent_revocations WHERE ${IN('consent_id')}`, kids).map((r) => [r.consent_id, r]));
  return rows.map((row) => {
    const policyVersions = pvs(row.id).map((p) => p.policy_version_id);
    const actor = (p) => (row[`${p}_kind`] === null ? null : { kind: row[`${p}_kind`], userId: row[`${p}_id`], name: row[`${p}_name`], ...(row[`${p}_kind`] === 'club_user' ? { orgId: row[`${p}_org_id`] } : {}), ...(p === 'granted_by' && row.granted_by_signatory ? { signatory: true } : {}) });
    const rv = revs.get(row.id);
    return {
      id: row.id, kind: row.kind, contextId: row.context_id, agentUserId: row.agent_user_id, agencyOrgId: row.agency_org_id, partyRole: row.party_role,
      subject: { kind: row.subject_kind, id: row.subject_id }, regarding: regarding(row.id).map((r) => r.party_role),
      status: row.status, requestedAt: row.requested_at, requestedBy: byOfRow(row, 'requested_by'),
      grantedAt: row.granted_at, grantedBy: actor('granted_by'), declinedAt: row.declined_at, declinedBy: actor('declined_by'),
      particulars: { fullParticularsProvided: row.full_particulars_provided === 1, legalAdviceOffered: row.legal_advice_offered === 1, proposedFeeDisclosed: row.proposed_fee_disclosed === 1, acknowledged: row.acknowledged_at === null ? null : { particulars: true, legalAdvice: true, at: row.acknowledged_at } },
      policyVersions, ruleIds: rules(row.id).map((r) => r.rule_id),
      keys: Object.fromEntries(CONSENT_KEY_SLOTS.filter((s) => row[`${s}_key`] !== null).map((s) => [s, { key: row[`${s}_key`], fp: row[`${s}_fp`] }])),
      ...revOfRow(row),
      history: hist(row.id).map((h) => ({
        id: h.id, at: h.at, action: h.action, by: byOfRow(h),
        detail: h.action === 'regulatory_consent_requested' ? { partyRole: row.party_role, kind: row.kind, policyVersions } : h.action === 'regulatory_consent_granted' ? { partyRole: row.party_role, policyVersions } : h.action === 'regulatory_consent_declined' ? { partyRole: row.party_role } : { consentId: row.id, partyRole: row.party_role },
      })),
      revocation: rv ? { id: rv.id, at: rv.revoked_at, by: { kind: rv.by_kind, userId: rv.by_id, name: rv.by_name, ...(rv.by_kind === 'club_user' ? { orgId: rv.by_org_id } : {}) } } : null,
    };
  });
}

// ------------------------------------------------------------------ snapshot (fixtures and the persistence batteries)
export const complianceRecordsLive = (sqlite) => migrationApplied(sqlite, COMPLIANCE_RECORDS_MIGRATION);
/** The snapshot shape: a context with its evaluations; a consent ledger with its revocation rows (as the blob kept them). */
function readAll(sqlite) {
  const contexts = decodeContexts(sqlite, sqlite.prepare('SELECT * FROM compliance_contexts ORDER BY rowid').all());
  const evs = groupBy(decodeEvaluations(sqlite, sqlite.prepare('SELECT * FROM compliance_evaluations ORDER BY context_id, position').all()), (e) => e.contextId);
  const consents = decodeConsents(sqlite, sqlite.prepare('SELECT * FROM regulatory_consents ORDER BY rowid').all());
  return {
    complianceContexts: contexts.map(({ lastEvaluation: _l, evaluationCount: _n, ...c }) => ({ ...c, evaluations: evs(c.id).map(({ evaluationId: _i, contextId: _c, position: _p, ...e }) => e) })),
    regulatoryReviews: decodeReviews(sqlite, sqlite.prepare('SELECT * FROM regulatory_reviews ORDER BY rowid').all()).map(({ snapshot, ...r }) => ({ ...r, snapshot: snapshot && { outcome: snapshot.outcome, evaluationId: snapshot.evaluationId ?? null, evaluatedAt: snapshot.evaluatedAt ?? null } })),
    regulatoryConsents: consents.flatMap(({ revocation, ...k }) => [k, ...(revocation ? [{ id: revocation.id, kind: 'revocation', of: k.id, at: revocation.at, by: revocation.by }] : [])]),
  };
}
/**
 * Whole-snapshot access (readTableBacked / writeTableBacked). A supplied collection IS the whole final collection; an
 * omitted one is kept whole. Every record is typed (junk refused with ids); then the supplied collections' tables are
 * rewritten — contexts (with their evaluations) first, then reviews, then consents (with revocation rows).
 */
export const COMPLIANCE_RECORDS_SNAPSHOT = {
  names: COMPLIANCE_RECORDS_COLLECTIONS,
  read(sqlite) { return complianceRecordsLive(sqlite) ? readAll(sqlite) : null; },
  /**
   * Set the records aside before the tables they name (agreements, profiles, policies, reviewers) are rewritten: read
   * them, then empty the tables. `replace(…, { kept })` writes them back (or the snapshot's own).
   */
  stash(sqlite) {
    if (!complianceRecordsLive(sqlite)) return null;
    const kept = readAll(sqlite);
    sqlite.exec('DELETE FROM regulatory_consents');
    sqlite.exec('DELETE FROM compliance_context_history');
    sqlite.exec('DELETE FROM compliance_context_representations');
    sqlite.exec('UPDATE regulatory_reviews SET supersedes_id = NULL, superseded_by_id = NULL');
    sqlite.exec('DELETE FROM regulatory_review_history');
    sqlite.exec('DELETE FROM regulatory_reviews');
    sqlite.exec('DELETE FROM compliance_evaluations');
    sqlite.exec('DELETE FROM compliance_contexts');
    return kept;
  },
  replace(sqlite, db, { label = 'the snapshot (compliance records)', kept = null } = {}) {
    if (!complianceRecordsLive(sqlite)) return [];
    const written = COMPLIANCE_RECORDS_COLLECTIONS.filter((n) => Object.hasOwn(db, n) && db[n] !== undefined);
    if (!written.length && !kept) return [];
    const blocked = (m) => refusal('COMPLIANCE_RECORDS_IMPORT_BLOCKED', `${label}: ${m}`);
    const typedList = (name, typer, list, map = (x) => x) => {
      if (!Array.isArray(list)) throw blocked(`the ${name} collection must be an array of entries (got ${describe(list)})`);
      const seen = new Set();
      return list.map((raw, i) => {
        const t = typer(map(raw), `${name} entry #${i}`);
        if (!t.ok) throw blocked(t.reason);
        if (seen.has(t.record.id)) throw blocked(`${name} entry #${i} duplicates an earlier entry (${t.record.id})`);
        seen.add(t.record.id);
        return t.record;
      });
    };
    // The three collections reference each other (a review its context and evaluation, a representation its review, a
    // consent its context): an omitted one is kept as it is, and all three are rewritten in dependency order.
    const current = kept ?? readAll(sqlite);
    const src = (n) => (written.includes(n) ? db[n] : current[n]);
    const s = statements(sqlite);
    try {
      const rawContexts = src('complianceContexts');
      const contexts = typedList('complianceContexts', okOr(typeContext), rawContexts, (c) => { if (!isPlainObject(c)) return c; const { evaluations: _e, otherServices: _o, interests: _i, ...rest } = c; return rest; });
      const evals = rawContexts.map((raw, i) => (raw.evaluations ?? []).map((e, j) => { const { snapshotOf, alias: _a, requiredActions: _r, missingEvidence: _m, ruleStatuses: _s, ...result } = e; return typeEvaluation(result, snapshotOf ?? { parties: [], representations: [], proposed: null }, `complianceContexts entry #${i}.evaluations[${j}]`); }));
      const reviews = typedList('regulatoryReviews', okOr(typeReview), src('regulatoryReviews'));
      const ledgerAll = src('regulatoryConsents');
      if (!Array.isArray(ledgerAll)) throw blocked(`the regulatoryConsents collection must be an array of entries (got ${describe(ledgerAll)})`);
      const consents = typedList('regulatoryConsents', okOr(typeConsent), ledgerAll.filter((k) => k?.kind !== 'revocation'));
      const revocations = ledgerAll.filter((k) => k?.kind === 'revocation');
      // Out, children before parents.
      sqlite.exec('DELETE FROM regulatory_consents');
      sqlite.exec('DELETE FROM compliance_context_history');
      sqlite.exec('DELETE FROM compliance_context_representations');
      sqlite.exec('UPDATE regulatory_reviews SET supersedes_id = NULL, superseded_by_id = NULL');
      sqlite.exec('DELETE FROM regulatory_review_history');
      sqlite.exec('DELETE FROM regulatory_reviews');
      sqlite.exec('DELETE FROM compliance_evaluations');
      sqlite.exec('DELETE FROM compliance_contexts');
      // In: contexts and their evaluations, reviews, then what names a review, then consents.
      const evIds = contexts.map((c, i) => { writeContext(s, { ...c, representations: [], history: [] }, { isNew: true }); return evals[i].map((e, j) => writeEvaluation(s, c.id, j + 1, e)); });
      for (const r of reviews) writeReview(s, { ...r, supersedes: null, supersededBy: null, history: [] }, { isNew: true });
      for (const r of reviews) { if (r.supersedes || r.supersededBy) s.review.run(reviewRow(r)); writeReviewHistory(s, r); }
      contexts.forEach((c, i) => {
        c.representations.forEach((r, j) => s.repIns.run(c.id, j, r.id, r.agentUserId, r.partyRole, r.agreementId, r.status, r.declaredOnly ? 1 : 0, r.reviewId, r.declaredAt, r.firstActAt, r.withdrawnAt, r.verifiedByReviewId, r.verifiedAt, r.keys.declare?.key ?? null, r.keys.declare?.fp ?? null));
        // An entry that repeats an evaluation names the one it follows (evaluations and their entries are one to one, in order).
        let evIndex = -1;
        c.history.forEach((h, j) => {
          const d = h.detail ?? {};
          if (h.action === 'compliance_context_evaluated' && !d.reviewId) evIndex += 1;
          const linked = (h.action === 'compliance_context_evaluated' && !d.reviewId) || (h.action === 'compliance_representation_declared' && d.status === 'verified');
          writeContextEntry(s, c.id, j, h, linked ? evIds[i][Math.max(evIndex, 0)] ?? null : null);
        });
      });
      for (const k of consents) writeConsent(s, k, { isNew: true });
      const seen = new Set();
      for (const [i, rv] of revocations.entries()) {
        const at = `regulatoryConsents revocation #${i}`;
        if (!(isPlainObject(rv) && isId(rv.id) && isId(rv.of) && isInt(rv.at) && isPlainObject(rv.by))) throw blocked(`${at} is not { id, kind: revocation, of, at, by }`);
        const k = consents.find((x) => x.id === rv.of);
        if (!k || k.status !== 'granted') throw blocked(`${at} (${rv.id}) revokes ${rv.of}, which is not a granted consent of the snapshot`);
        if (seen.has(rv.of)) throw blocked(`${at} (${rv.id}) revokes ${rv.of} a second time`);
        seen.add(rv.of);
        const by = typeBy(rv.by, `${at}.by`, { kinds: ['player', 'club_user'] });
        s.revocation.run(rv.id, rv.of, rv.at, by.kind, by.userId, by.name, by.orgId ?? null);
      }
    } catch (e) {
      if (e.code === 'COMPLIANCE_RECORDS_INPUT_INVALID') throw blocked(e.message.replace(/^[A-Z_]+: /, ''));
      if (/FOREIGN KEY/.test(String(e.message))) throw refusal('COMPLIANCE_RECORDS_REFERENCE_MISSING', `${label}: a record names a row that is not there (${e.message}); the write was rolled back and nothing was changed`);
      throw e;
    }
    return written;
  },
  assert(sqlite, { label = 'the snapshot (compliance records)' } = {}) {
    if (!complianceRecordsLive(sqlite)) return;
    for (const t of COMPLIANCE_RECORDS_TABLES) {
      const broken = sqlite.prepare(`PRAGMA foreign_key_check(${t})`).all();
      if (broken.length) throw refusal('COMPLIANCE_RECORDS_KEY_VIOLATION', `${label}: ${t} holds ${broken.length} row(s) whose reference is not there (first: rowid ${broken[0].rowid} → ${broken[0].parent}); the write was rolled back`);
    }
  },
};
const playerRefCount = (sqlite, sql) => sqlite.prepare(sql).get().n;
export const unresolvedPlayerReferences = (sqlite) => (complianceRecordsLive(sqlite) ? { complianceRecords: playerRefCount(sqlite, "SELECT count(*) AS n FROM compliance_context_parties x WHERE subject_kind = 'player' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.subject_id)") } : null);

// ------------------------------------------------------------------ the repository
const WRITES = new Set(['create', 'update', 'recordEvaluation', 'revoke', 'forgetPlayer', 'flagPolicyChange']);
const clone = (v) => JSON.parse(JSON.stringify(v));
const OPEN = "status IN ('PENDING','IN_REVIEW')";
/**
 * `createComplianceRecordsRepository({ sqlite, unit, now, log })`: `contexts`, `reviews` and `consents`, each with its
 * writes and queries, plus `reads` (the queries alone) and `forgetPlayer` (an account deletion).
 */
export function createComplianceRecordsRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the compliance records repository needs a SQLite connection (node:sqlite)');
  const operation = (fn) => (unit?.active?.() ? unit.join(fn) : sqlite.isTransaction ? fn() : transaction(sqlite, fn));
  const cache = new Map();
  const q = (sql) => { let s = cache.get(sql); if (!s) cache.set(sql, (s = sqlite.prepare(sql))); return s; };
  const s = () => statements(sqlite);
  const updating = new Set();
  const guard = (key, fn) => {
    if (updating.has(key)) throw refusal('COMPLIANCE_RECORDS_NESTED_UPDATE', `${key} is already being updated; make the second change after the first returns`);
    updating.add(key);
    try { return fn(); } finally { updating.delete(key); }
  };
  const typedOr = (type, raw, name) => { const t = type(raw, name); if (t && t.ok === false) throw refusal('COMPLIANCE_RECORDS_INPUT_INVALID', t.reason); return t; };
  const historyTaken = (h) => q('SELECT 1 FROM compliance_context_history WHERE id = ? UNION ALL SELECT 1 FROM regulatory_review_history WHERE id = ? UNION ALL SELECT 1 FROM regulatory_consent_history WHERE id = ?').get(h.id, h.id, h.id);
  const checkHistory = (table, id, stored, next) => {
    if (next.history.length < stored.history.length || stored.history.some((h, i) => !same(h, next.history[i]))) throw refusal('COMPLIANCE_RECORDS_INPUT_INVALID', `${table} ${id}: the history only grows (a stored entry cannot change or go)`);
    const taken = next.history.slice(stored.history.length).find(historyTaken);
    if (taken) throw refusal('COMPLIANCE_RECORDS_DUPLICATE', `history entry ${taken.id} already exists`);
  };
  const checkFixed = (table, id, stored, next, fields) => { for (const k of fields) if (!same(next[k], stored[k])) throw refusal('COMPLIANCE_RECORDS_INPUT_INVALID', `${table} ${id}: ${k} cannot change`); };
  const one = (decoder, sql) => (...args) => { const row = q(sql).get(...args); return row ? deepFreeze(decoder(sqlite, [row])[0]) : null; };
  const many = (decoder, sql) => (...args) => decoder(sqlite, q(sql).all(...args)).map(deepFreeze);
  const latestEvaluationId = (ctxId) => q('SELECT id FROM compliance_evaluations WHERE context_id = ? ORDER BY position DESC LIMIT 1').get(ctxId)?.id ?? null;
  const evaluationOf = (id) => { const row = q('SELECT * FROM compliance_evaluations WHERE id = ?').get(id); return row ? decodeEvaluations(sqlite, [row])[0] : null; };
  /** An entry that repeats an evaluation must repeat the latest one exactly. */
  const checkEvaluationEntries = (ctxId, entries) => {
    const evId = latestEvaluationId(ctxId); const ev = evId ? evaluationOf(evId) : null;
    for (const h of entries) {
      const d = h.detail ?? {};
      if (h.action === 'compliance_context_evaluated' && !d.reviewId) { if (!ev || !same(d, { outcome: ev.outcome, reasonCodes: [...new Set(ev.reasons.map((x) => x.code))], policyVersions: ev.policyVersions })) throw refusal('COMPLIANCE_RECORDS_INPUT_INVALID', `compliance_context_history ${h.id}: an evaluation entry repeats the latest evaluation`); }
      if (h.action === 'compliance_representation_declared' && d.status === 'verified') { if (!ev || ev.outcome !== d.outcome || !same(ev.policyVersions, d.policyVersions)) throw refusal('COMPLIANCE_RECORDS_INPUT_INVALID', `compliance_context_history ${h.id}: a verified declaration repeats the latest evaluation`); }
    }
    return evId;
  };

  // ---- contexts
  const contextById = one(decodeContexts, 'SELECT * FROM compliance_contexts WHERE id = ?');
  const contexts = {
    create: (raw) => operation(() => {
      const c = typedOr(typeContext, raw, 'complianceContexts');
      if (q('SELECT 1 FROM compliance_contexts WHERE id = ?').get(c.id)) throw refusal('COMPLIANCE_RECORDS_DUPLICATE', `compliance_contexts ${c.id} already exists`);
      const taken = c.history.find(historyTaken); if (taken) throw refusal('COMPLIANCE_RECORDS_DUPLICATE', `history entry ${taken.id} already exists`);
      if (c.history.some((h) => h.action === 'compliance_context_evaluated' || h.detail?.status === 'verified')) throw refusal('COMPLIANCE_RECORDS_INPUT_INVALID', `compliance_contexts ${c.id}: an evaluation is recorded with recordEvaluation`);
      writeContext(s(), c, { isNew: true });
      return contextById(c.id);
    }),
    /**
     * `update(id, change)`: the agency, agent, type, jurisdictions, origin, opening and create key never change; a closed
     * context does not reopen; the history only grows; an evaluation entry repeats the latest evaluation.
     */
    update: (id, change) => guard(`compliance_contexts ${id}`, () => operation(() => {
      if (typeof change !== 'function') throw new TypeError('compliance_contexts: update(id, change) needs a function that edits the copy it is given');
      const stored = contextById(id);
      if (!stored) throw refusal('COMPLIANCE_RECORDS_NOT_FOUND', `compliance_contexts ${id} is not a record of the repository`);
      const draft = clone(stored);
      const returned = change(draft);
      const next = typedOr(typeContext, returned === undefined ? draft : returned, 'complianceContexts');
      const { lastEvaluation: _l, evaluationCount: _n, ...storedFlat } = stored;
      checkFixed('compliance_contexts', id, storedFlat, next, ['id', 'agencyOrgId', 'agentUserId', 'type', 'jurisdictions', 'origin', 'transactionId', 'openedAt', 'keys']);
      if (stored.status === 'closed' && next.status !== 'closed') throw refusal('COMPLIANCE_RECORDS_INPUT_INVALID', `compliance_contexts ${id}: a closed context does not reopen`);
      checkHistory('compliance_contexts', id, storedFlat, next);
      const evId = checkEvaluationEntries(id, next.history.slice(stored.history.length));
      writeContext(s(), next, { isNew: false, knownHistory: stored.history.length, latestEvaluationId: evId });
      return contextById(id);
    })),
    /**
     * Record an evaluation of the context (append-only): the result, the identity of its inputs and the history entry that
     * says so, at once; the re-evaluation flag clears. Returns the stored evaluation (decoded, with its id).
     */
    recordEvaluation: (id, result, snapshotOf, entry) => operation(() => {
      const ctx = q('SELECT id FROM compliance_contexts WHERE id = ?').get(id);
      if (!ctx) throw refusal('COMPLIANCE_RECORDS_NOT_FOUND', `compliance_contexts ${id} is not a record of the repository`);
      const e = typeEvaluation(result, snapshotOf, `compliance_evaluations ${id}`);
      const position = (q('SELECT MAX(position) AS p FROM compliance_evaluations WHERE context_id = ?').get(id).p ?? 0) + 1;
      const evId = writeEvaluation(s(), id, position, e);
      const h = typeHistory([entry], `compliance_contexts ${id}`, CONTEXT_ACTIONS, typeContextDetail)[0];
      if (historyTaken(h)) throw refusal('COMPLIANCE_RECORDS_DUPLICATE', `history entry ${h.id} already exists`);
      checkEvaluationEntries(id, [h]);
      const ord = q('SELECT COUNT(*) AS n FROM compliance_context_history WHERE context_id = ?').get(id).n;
      writeContextEntry(s(), id, ord, h, evId);
      q('UPDATE compliance_contexts SET re_evaluation_pending = 0 WHERE id = ?').run(id);
      return deepFreeze(evaluationOf(evId));
    }),
    byId: contextById,
    /** The agent's own contexts in the agency, oldest first. */
    forAgent: many(decodeContexts, 'SELECT * FROM compliance_contexts WHERE agency_org_id = ? AND agent_user_id = ? ORDER BY rowid'),
    /** The agent's context opened under this client key, or null. */
    byCreateKey: one(decodeContexts, 'SELECT * FROM compliance_contexts WHERE agency_org_id = ? AND agent_user_id = ? AND create_key = ?'),
    /** The agency's open contexts other than `exceptId`, oldest first (connected agents in the same transaction). */
    openForAgencyExcept: many(decodeContexts, "SELECT * FROM compliance_contexts WHERE agency_org_id = ? AND status = 'open' AND id <> ? ORDER BY rowid"),
    /** The agency's contexts, oldest first (the agency audit). */
    forAgency: many(decodeContexts, 'SELECT * FROM compliance_contexts WHERE agency_org_id = ? ORDER BY rowid'),
    /**
     * A published version of `jurisdiction`: flag every open context of that jurisdiction whose latest evaluation did not
     * use it (never re-verdicted), each with its history entry. Returns the flagged ids.
     */
    flagPolicyChange: (jurisdiction, policyVersionId, entryOf) => operation(() => {
      const ids = q(`SELECT c.id FROM compliance_contexts c
        JOIN compliance_context_jurisdictions j ON j.context_id = c.id AND j.member_association = ?
        JOIN compliance_evaluations e ON e.context_id = c.id AND e.position = (SELECT MAX(position) FROM compliance_evaluations WHERE context_id = c.id)
        WHERE c.status = 'open' AND NOT EXISTS (SELECT 1 FROM compliance_evaluation_policy_versions v WHERE v.evaluation_id = e.id AND v.policy_version_id = ?)
        ORDER BY c.rowid`).all(jurisdiction, policyVersionId).map((r) => r.id);
      for (const id of ids) contexts.update(id, (d) => { d.reEvaluationPending = true; d.history.push(entryOf()); });
      return ids;
    }),
    /** Every evaluation's outcome, counted (the T&S metrics). */
    outcomeCounts: () => Object.fromEntries(q('SELECT outcome, COUNT(*) AS n FROM compliance_evaluations GROUP BY outcome ORDER BY outcome').all().map((r) => [r.outcome, r.n])),
  };

  // ---- reviews
  const reviewById = one(decodeReviews, 'SELECT * FROM regulatory_reviews WHERE id = ?');
  const checkSnapshot = (r) => {
    if (!r.snapshot?.evaluationId) return;
    const ev = q('SELECT outcome, context_id FROM compliance_evaluations WHERE id = ?').get(r.snapshot.evaluationId);
    if (!ev || ev.outcome !== r.snapshot.outcome || (r.subject.contextId && ev.context_id !== r.subject.contextId)) throw refusal('COMPLIANCE_RECORDS_INPUT_INVALID', `regulatory_reviews ${r.id}: the snapshot names an evaluation of its context with the same outcome`);
  };
  const reviews = {
    create: (raw) => operation(() => {
      const r = typedOr(typeReview, raw, 'regulatoryReviews');
      if (q('SELECT 1 FROM regulatory_reviews WHERE id = ?').get(r.id)) throw refusal('COMPLIANCE_RECORDS_DUPLICATE', `regulatory_reviews ${r.id} already exists`);
      checkSnapshot(r);
      const taken = r.history.find(historyTaken); if (taken) throw refusal('COMPLIANCE_RECORDS_DUPLICATE', `history entry ${taken.id} already exists`);
      writeReview(s(), r, { isNew: true });
      return reviewById(r.id);
    }),
    /** `update(id, change)`: kind, agency, agent, subject, reasons, versions, snapshot and request never change; a decision is final; the history only grows. */
    update: (id, change) => guard(`regulatory_reviews ${id}`, () => operation(() => {
      if (typeof change !== 'function') throw new TypeError('regulatory_reviews: update(id, change) needs a function that edits the copy it is given');
      const stored = reviewById(id);
      if (!stored) throw refusal('COMPLIANCE_RECORDS_NOT_FOUND', `regulatory_reviews ${id} is not a record of the repository`);
      const draft = clone(stored);
      const returned = change(draft);
      const next = typedOr(typeReview, returned === undefined ? draft : returned, 'regulatoryReviews');
      const flat = (r) => ({ ...r, snapshot: r.snapshot && { outcome: r.snapshot.outcome, evaluationId: r.snapshot.evaluationId ?? null, evaluatedAt: r.snapshot.evaluatedAt ?? null } });
      checkFixed('regulatory_reviews', id, flat(stored), next, ['id', 'kind', 'agencyOrgId', 'agentUserId', 'subject', 'reasons', 'policyVersions', 'snapshot', 'requestedAt', 'requestedBy']);
      for (const k of ['supersedes', 'supersededBy']) if (stored[k] !== null && next[k] !== stored[k]) throw refusal('COMPLIANCE_RECORDS_INPUT_INVALID', `regulatory_reviews ${id}: ${k} is written once`);
      if (stored.decision && !same(stored.decision, next.decision)) throw refusal('COMPLIANCE_RECORDS_INPUT_INVALID', `regulatory_reviews ${id}: a decision is final`);
      if (!OPEN_REVIEW_STATUSES.includes(stored.status) && stored.status !== next.status && !(next.status === 'SUPERSEDED' && ['APPROVED', 'REJECTED'].includes(stored.status))) throw refusal('COMPLIANCE_RECORDS_INPUT_INVALID', `regulatory_reviews ${id}: a ${stored.status} review only becomes SUPERSEDED`);
      for (const k of ['resolve']) if (stored.keys[k] && !same(stored.keys[k], next.keys[k])) throw refusal('COMPLIANCE_RECORDS_INPUT_INVALID', `regulatory_reviews ${id}: the ${k} key is written once`);
      checkHistory('regulatory_reviews', id, stored, next);
      writeReview(s(), next, { isNew: false, knownHistory: stored.history.length });
      return reviewById(id);
    })),
    byId: reviewById,
    /** The open item for this facet of this profile, or null (one open item per subject). */
    openForFacet: one(decodeReviews, `SELECT * FROM regulatory_reviews WHERE kind = 'verification_facet' AND ${OPEN} AND subject_profile_id = ? AND subject_facet = ? AND subject_member_association IS ? LIMIT 1`),
    /** The open dispute item for this agreement, or null. */
    openForAgreement: one(decodeReviews, `SELECT * FROM regulatory_reviews WHERE kind = 'representation_dispute' AND ${OPEN} AND subject_agreement_id = ? LIMIT 1`),
    /** The context's items, oldest first. */
    forContext: many(decodeReviews, 'SELECT * FROM regulatory_reviews WHERE subject_context_id = ? ORDER BY rowid'),
    /** The agency's items, oldest first (the agent overview, the agency audit). */
    forAgency: many(decodeReviews, 'SELECT * FROM regulatory_reviews WHERE agency_org_id = ? ORDER BY rowid'),
    /**
     * The T&S queue by cursor: open items first, each part oldest first (`after` is the previous page's last
     * `[rank, requestedAt, rowid]`): `{ rows: [{ key, record }] }`, one row more than `limit` when there is a next page.
     */
    queuePage: ({ status = null, limit, after = null }) => {
      const rows = q(`SELECT rowid AS rid, CASE WHEN ${OPEN} THEN 0 ELSE 1 END AS rank, * FROM regulatory_reviews
        WHERE (@status IS NULL OR status = @status)
          AND (@r IS NULL OR (CASE WHEN ${OPEN} THEN 0 ELSE 1 END, requested_at, rowid) > (@r, @t, @i))
        ORDER BY rank, requested_at, rowid LIMIT @n`).all({ status, r: after?.[0] ?? null, t: after?.[1] ?? null, i: after?.[2] ?? null, n: limit + 1 });
      return { rows: decodeReviews(sqlite, rows).map((record, i) => ({ key: [rows[i].rank, rows[i].requested_at, rows[i].rid], record: deepFreeze(record) })) };
    },
    /** The T&S metrics: counts by status and kind, and the median request-to-decision time. */
    metrics: () => {
      const byStatus = Object.fromEntries(REVIEW_STATUSES.map((st0) => [st0, 0])); for (const r of q('SELECT status, COUNT(*) AS n FROM regulatory_reviews GROUP BY status').all()) byStatus[r.status] = r.n;
      const byKind = Object.fromEntries(REVIEW_KINDS.map((k) => [k, 0])); for (const r of q('SELECT kind, COUNT(*) AS n FROM regulatory_reviews GROUP BY kind').all()) byKind[r.kind] = r.n;
      const n = q('SELECT COUNT(*) AS n FROM regulatory_reviews WHERE decided_at IS NOT NULL AND requested_at IS NOT NULL').get().n;
      const median = n ? q('SELECT decided_at - requested_at AS d FROM regulatory_reviews WHERE decided_at IS NOT NULL ORDER BY d LIMIT 1 OFFSET ?').get(Math.floor(n / 2)).d : null;
      return { byStatus, byKind, medianDurationMs: median };
    },
    /** The newest `limit` decision entries (started, resolved, cancelled, superseded) with their review, newest first. */
    decisionEntries: (limit) => {
      const rows = q("SELECT review_id, id FROM regulatory_review_history WHERE action <> 'regulatory_review_requested' ORDER BY at DESC, id DESC LIMIT ?").all(limit);
      const recs = new Map(decodeReviews(sqlite, inIds(sqlite, `SELECT * FROM regulatory_reviews WHERE ${IN('id')}`, rows.map((r) => r.review_id))).map((r) => [r.id, deepFreeze(r)]));
      return rows.map((r) => ({ review: recs.get(r.review_id), entry: recs.get(r.review_id).history.find((h) => h.id === r.id) }));
    },
    /** The context's open items, oldest first (a context closing cancels them). */
    openForContext: many(decodeReviews, `SELECT * FROM regulatory_reviews WHERE subject_context_id = ? AND ${OPEN} ORDER BY rowid`),
  };

  // ---- consents
  const consentById = one(decodeConsents, 'SELECT * FROM regulatory_consents WHERE id = ?');
  const consents = {
    create: (raw) => operation(() => {
      const k = typedOr(typeConsent, raw, 'regulatoryConsents');
      if (q('SELECT 1 FROM regulatory_consents WHERE id = ? UNION ALL SELECT 1 FROM regulatory_consent_revocations WHERE id = ?').get(k.id, k.id)) throw refusal('COMPLIANCE_RECORDS_DUPLICATE', `regulatory_consents ${k.id} already exists`);
      if (k.status !== 'requested') throw refusal('COMPLIANCE_RECORDS_INPUT_INVALID', `regulatory_consents ${k.id}: a consent is requested first`);
      const taken = k.history.find(historyTaken); if (taken) throw refusal('COMPLIANCE_RECORDS_DUPLICATE', `history entry ${taken.id} already exists`);
      writeConsent(s(), k, { isNew: true });
      return consentById(k.id);
    }),
    /** `update(id, change)`: the parties, context, versions and particulars offered never change; the stored status changes once (requested → granted | declined); a key is written once; the history only grows. */
    update: (id, change) => guard(`regulatory_consents ${id}`, () => operation(() => {
      if (typeof change !== 'function') throw new TypeError('regulatory_consents: update(id, change) needs a function that edits the copy it is given');
      const stored = consentById(id);
      if (!stored) throw refusal('COMPLIANCE_RECORDS_NOT_FOUND', `regulatory_consents ${id} is not a record of the repository`);
      const { revocation: _rv, ...storedFlat } = stored;
      const draft = clone(storedFlat);
      const returned = change(draft);
      const next = typedOr(typeConsent, returned === undefined ? draft : returned, 'regulatoryConsents');
      checkFixed('regulatory_consents', id, storedFlat, next, ['id', 'kind', 'contextId', 'agentUserId', 'agencyOrgId', 'partyRole', 'subject', 'regarding', 'requestedAt', 'requestedBy', 'policyVersions', 'ruleIds']);
      const fixedParticulars = (p) => ({ ...p, acknowledged: null });
      if (!same(fixedParticulars(next.particulars), fixedParticulars(storedFlat.particulars))) throw refusal('COMPLIANCE_RECORDS_INPUT_INVALID', `regulatory_consents ${id}: the particulars offered cannot change`);
      if (storedFlat.status !== 'requested' && !same([next.status, next.grantedAt, next.grantedBy, next.declinedAt, next.declinedBy, next.particulars], [storedFlat.status, storedFlat.grantedAt, storedFlat.grantedBy, storedFlat.declinedAt, storedFlat.declinedBy, storedFlat.particulars])) throw refusal('COMPLIANCE_RECORDS_INPUT_INVALID', `regulatory_consents ${id}: an answered consent is never edited (a revocation is its own row)`);
      for (const k of CONSENT_KEY_SLOTS) if (storedFlat.keys[k] && !same(storedFlat.keys[k], next.keys[k])) throw refusal('COMPLIANCE_RECORDS_INPUT_INVALID', `regulatory_consents ${id}: the ${k} key is written once`);
      checkHistory('regulatory_consents', id, storedFlat, next);
      writeConsent(s(), next, { isNew: false, knownHistory: storedFlat.history.length });
      return consentById(id);
    })),
    /** Record the revocation of a granted consent, once: its own row (`{ id, at, by }`). */
    revoke: (consentId, { id, at, by }) => operation(() => {
      const k = consentById(consentId);
      if (!k || k.status !== 'granted') throw refusal('COMPLIANCE_RECORDS_INPUT_INVALID', `regulatory_consents ${consentId}: only a granted consent can be revoked`);
      if (k.revocation) throw refusal('COMPLIANCE_RECORDS_DUPLICATE', `regulatory_consents ${consentId} was already revoked`);
      if (!isId(id) || !isInt(at)) throw refusal('COMPLIANCE_RECORDS_INPUT_INVALID', 'a revocation needs an id and an instant');
      if (q('SELECT 1 FROM regulatory_consents WHERE id = ? UNION ALL SELECT 1 FROM regulatory_consent_revocations WHERE id = ?').get(id, id)) throw refusal('COMPLIANCE_RECORDS_DUPLICATE', `${id} already exists`);
      const b = typeBy(by, `regulatory_consent_revocations ${id}.by`, { kinds: ['player', 'club_user'] });
      s().revocation.run(id, consentId, at, b.kind, b.userId, b.name, b.orgId ?? null);
      return consentById(consentId);
    }),
    byId: consentById,
    /** The context's consents, oldest first (the engine's input, the transaction's projection). */
    forContext: many(decodeConsents, 'SELECT * FROM regulatory_consents WHERE context_id = ? ORDER BY rowid'),
    /** The consents asking this party (a player or a club), oldest first. */
    forSubject: many(decodeConsents, 'SELECT * FROM regulatory_consents WHERE subject_kind = ? AND subject_id = ? ORDER BY rowid'),
    /** The agent's consents in the agency, oldest first. */
    forAgent: many(decodeConsents, 'SELECT * FROM regulatory_consents WHERE agency_org_id = ? AND agent_user_id = ? ORDER BY rowid'),
    /** The agency's consents, oldest first (the agency audit). */
    forAgency: many(decodeConsents, 'SELECT * FROM regulatory_consents WHERE agency_org_id = ? ORDER BY rowid'),
    /** The consent the agent requested in the context under this client key, or null. */
    byRequestKey: one(decodeConsents, 'SELECT * FROM regulatory_consents WHERE context_id = ? AND agent_user_id = ? AND request_key = ?'),
    /** The T&S metrics: dual-representation consents requested, granted, declined, revoked. */
    metrics: () => {
      const r = q(`SELECT COUNT(*) AS requested, SUM(CASE WHEN c.status = 'granted' AND v.id IS NULL THEN 1 ELSE 0 END) AS granted, SUM(CASE WHEN c.status = 'declined' THEN 1 ELSE 0 END) AS declined, SUM(CASE WHEN v.id IS NOT NULL THEN 1 ELSE 0 END) AS revoked
        FROM regulatory_consents c LEFT JOIN regulatory_consent_revocations v ON v.consent_id = c.id WHERE c.kind = 'dual_representation'`).get();
      return { requested: r.requested, granted: r.granted ?? 0, declined: r.declined ?? 0, revoked: r.revoked ?? 0 };
    },
  };

  /**
   * A player's account removal: every context naming them keeps the party as an id-only removed party (with its history
   * entry) and loses the player's name from its history; every consent asking them, its answers, revocation and history
   * lose the player's id and name. `entryOf()` gives the context's history entry.
   */
  const forgetPlayer = (playerId, at, entryOf) => operation(() => {
    const touched = q("SELECT DISTINCT context_id FROM compliance_context_parties WHERE subject_kind = 'player' AND subject_id = ? AND removed = 0 ORDER BY context_id").all(playerId).map((r) => r.context_id);
    for (const id of touched) {
      contexts.update(id, (d) => { for (const p of d.parties) if (p.subjectKind === 'player' && p.subjectId === playerId && !p.removed) { p.removed = true; p.removedAt = at; } d.history.push(entryOf()); });
      q("UPDATE compliance_context_history SET by_id = NULL, by_name = NULL WHERE context_id = ? AND by_kind = 'player'").run(id);
    }
    const SUB = "SELECT id FROM regulatory_consents WHERE subject_kind = 'player' AND subject_id = ?";
    q(`UPDATE regulatory_consents SET granted_by_id = CASE WHEN granted_by_kind = 'player' THEN NULL ELSE granted_by_id END, granted_by_name = CASE WHEN granted_by_kind = 'player' THEN NULL ELSE granted_by_name END,
      declined_by_id = CASE WHEN declined_by_kind = 'player' THEN NULL ELSE declined_by_id END, declined_by_name = CASE WHEN declined_by_kind = 'player' THEN NULL ELSE declined_by_name END WHERE id IN (${SUB})`).run(playerId);
    q(`UPDATE regulatory_consent_revocations SET by_id = NULL, by_name = NULL WHERE by_kind = 'player' AND consent_id IN (${SUB})`).run(playerId);
    q(`UPDATE regulatory_consent_history SET by_id = NULL, by_name = NULL WHERE by_kind = 'player' AND consent_id IN (${SUB})`).run(playerId);
    return touched;
  });

  const readOnly = (o) => Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => !WRITES.has(k))));
  const repo = { contexts, reviews, consents };
  const counters = { complianceContexts: q('SELECT COUNT(*) AS n FROM compliance_contexts'), regulatoryReviews: q('SELECT COUNT(*) AS n FROM regulatory_reviews'), regulatoryConsents: q('SELECT COUNT(*) AS n FROM regulatory_consents') };
  return {
    ...repo,
    forgetPlayer,
    /** The queries alone, for modules that must not write. */
    reads: Object.freeze(Object.fromEntries(Object.entries(repo).map(([k, v]) => [k, readOnly(v)]))),
    attach() {
      if (!complianceRecordsLive(sqlite)) throw new Error(`the compliance records repository needs ${COMPLIANCE_RECORDS_MIGRATION} recorded; it never imports an in-memory array`);
      return { counts: this.counts() };
    },
    counts() { return Object.fromEntries(COMPLIANCE_RECORDS_COLLECTIONS.map((n) => [n, counters[n].get().n])); },
    pending: () => 0,
    exportAll() { return COMPLIANCE_RECORDS_SNAPSHOT.read(sqlite); },
    log,
    now,
  };
}
