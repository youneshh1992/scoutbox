/**
 * The compliance engine's records: contexts with their evaluations, regulatory reviews and consents.
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
 * Writes (repositories/writes.mjs). A record is created whole and must read back as written, then changes only through
 * named acts (`addParty`, `declareRepresentation`, `close`, `start`, `resolve`, `grant`, `revoke`, …), each an UPDATE of
 * named columns or an INSERT of new rows, joined into the open unit of work, the caller's open transaction, or a
 * transaction of their own. History is only inserted, and an entry whose detail is worked out on read must read back as
 * the writer gave it. A closed context does not reopen, a review is decided once and superseded once, and a consent is
 * answered once and revoked once, each guarded in SQL. An evaluation is recorded with `contexts.recordEvaluation`; an
 * account deletion with `forgetPlayer`. A review's `supersededBy` is the review naming it, worked out on read.
 *
 * Records are deep-frozen. A context carries its latest evaluation and the count.
 *
 * References. Agencies → orgs and staff → org_users (RESTRICT); a reviewer → ts_reviewers; a policy version →
 * jurisdiction_policies; an agreement → representation_agreements; within the domain, a review's context, evaluation
 * and supersession, a representation's review, a consent's context (RESTRICT). A party's or a consent's subject (a
 * player or a club) and a review's player carry no key (tolerant: they outlive an account deletion as ids). Child rows
 * cascade.
 */
import { isPlainObject, describe } from './recruitment.mjs';
import { migrationApplied, operationOn } from './database.mjs';
import { writeKit } from './writes.mjs';
import { deepFreeze } from '../domains/platform/values.mjs';
import { quote } from './fieldSpecs.mjs';
import { REVIEWER_ROLES } from './compliancePolicies.mjs';
import { FACETS, VERIFICATION_STATES, AGREEMENT_STATUSES } from '../domains/agents/core/shared.mjs';
import { RULE_STATUSES, PARTY_ROLES, CONSENT_KINDS } from '../domains/agents/compliance/policyVersions.mjs';
import { CONFLICT_OUTCOMES, CONTEXT_TYPES, derivedOfEvaluation } from '../domains/agents/compliance/conflict.mjs';

export const COMPLIANCE_RECORDS_MIGRATION = '0028_compliance_records';
export const COMPLIANCE_RECORDS_COLLECTIONS = Object.freeze([
  'complianceContexts',
  'regulatoryReviews',
  'regulatoryConsents',
]);

// ------------------------------------------------------------------ vocabularies and limits (one definition; the routes import them)
export const COMPLIANCE_RECORD_LIMITS = Object.freeze({
  id: 80,
  name: 200,
  code: 60,
  ruleId: 40,
  text: 300,
  reasonCode: 60,
  reason: 1000,
  evidenceRef: 200,
  evidenceRefs: 10,
  key: 64,
  fp: 4000,
  parties: 6,
  jurisdictions: 10,
  list: 50,
  role: 60,
});
const L = COMPLIANCE_RECORD_LIMITS;
export const REVIEW_KINDS = Object.freeze([
  'verification_facet',
  'representation_declared',
  'conflict_evaluation',
  'representation_dispute',
]);
export const REVIEW_STATUSES = Object.freeze([
  'PENDING',
  'IN_REVIEW',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'SUPERSEDED',
]);
export const OPEN_REVIEW_STATUSES = Object.freeze(['PENDING', 'IN_REVIEW']);
export const DECISION_OUTCOMES = Object.freeze(['APPROVED', 'REJECTED', 'CANCELLED']);
export const RESULT_NOTES = Object.freeze(['profile gone', 'not disputed any more', 'context gone']);
export const CONTEXT_STATUSES = Object.freeze(['open', 'closed']);
export const REPRESENTATION_STATUSES = Object.freeze(['verified', 'pending_review', 'withdrawn']);
export const RESOLVED_FACTS = Object.freeze([
  'OTHER_SERVICES_PRESUMPTION',
  'INTEREST_DECLARED',
  'REPRESENTATION_UNVERIFIED',
]);
export const SUBJECT_KINDS = Object.freeze(['player', 'club']);
export const STORED_CONSENT_STATUSES = Object.freeze(['requested', 'granted', 'declined']);
export const ACTOR_KINDS = Object.freeze(['org', 'player', 'club_user', 'ts_reviewer', 'system']);
export const CONTEXT_ACTIONS = Object.freeze([
  'compliance_context_opened',
  'compliance_context_party_added',
  'compliance_context_party_removed',
  'compliance_representation_declared',
  'compliance_representation_verified',
  'compliance_representation_withdrawn',
  'compliance_context_evaluated',
  'compliance_context_policy_changed',
  'compliance_context_closed',
]);
export const REVIEW_ACTIONS = Object.freeze([
  'regulatory_review_requested',
  'regulatory_review_started',
  'regulatory_review_resolved',
  'regulatory_review_cancelled',
  'regulatory_review_superseded',
]);
export const CONSENT_ACTIONS = Object.freeze([
  'regulatory_consent_requested',
  'regulatory_consent_granted',
  'regulatory_consent_declined',
  'regulatory_consent_revoked',
]);
const CONSENT_KEY_SLOTS = Object.freeze(['request', 'grant', 'decline', 'revoke']);
/** The extras a reason may carry beyond the rule it names, in the order they are read back. */
const REASON_SCALARS = Object.freeze([
  ['facet', 'facet'],
  ['memberAssociation', 'member_association'],
  ['state', 'state'],
  ['agentUserId', 'agent_user_id'],
  ['partyRole', 'party_role'],
  ['consentKind', 'consent_kind'],
  ['detail', 'detail_text'],
  ['reason', 'reason_text'],
  ['overrideRuleId', 'override_rule_id'],
  ['kind', 'kind_text'],
]);
const REASON_LISTS = Object.freeze(['partyRoles', 'jurisdictions']);

// ------------------------------------------------------------------ DDL
const inList = (c, vals) => `${c} IN (${vals.map(quote).join(',')})`;
const optIn = (c, vals) => `CHECK (${c} IS NULL OR ${inList(c, vals)})`;
const txt = (c, max = L.text, notNull = false) =>
  `${c}  TEXT${notNull ? ' NOT NULL' : ''} CHECK (${notNull ? '' : `${c} IS NULL OR `}(length(${c}) > 0 AND length(${c}) <= ${max}))`;
const MA = (c, notNull = false) =>
  `${c}  TEXT${notNull ? ' NOT NULL' : ''} CHECK (${notNull ? '' : `${c} IS NULL OR `}${c} GLOB '[A-Z][A-Z][A-Z]')`;
const BY_COLS = (p = 'by', { orgId = true } = {}) => [
  `${p}_kind  TEXT NOT NULL CHECK (${inList(`${p}_kind`, ACTOR_KINDS)})`,
  txt(`${p}_id`, L.id),
  `${p}_name  TEXT CHECK (${p}_name IS NULL OR length(${p}_name) <= ${L.name})`,
  `${p}_role  TEXT CHECK (${p}_role IS NULL OR length(${p}_role) <= ${L.role})`,
  ...(orgId ? [txt(`${p}_org_id`, L.id)] : []),
];
const REASON_COLS = [
  txt('code', L.code, true),
  txt('rule_id', L.ruleId),
  optIn('rule_status', RULE_STATUSES).replace(/^CHECK/, 'rule_status  TEXT CHECK'),
  txt('regulator', 20),
  MA('jurisdiction'),
  txt('policy_version_id', L.id),
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
  'ord  INTEGER NOT NULL CHECK (ord >= 0)',
  'at  INTEGER NOT NULL',
  ...BY_COLS(),
];
const KEY_COLS = (slot) => [
  txt(`${slot}_key`, L.key),
  `${slot}_fp  TEXT CHECK ((${slot}_fp IS NULL OR length(${slot}_fp) <= ${L.fp}) AND ((${slot}_key IS NULL) = (${slot}_fp IS NULL)))`,
];
const REV_COLS = [
  'rev  INTEGER NOT NULL CHECK (rev >= 1)',
  'rev_at  INTEGER',
  txt('rev_by_id', L.id),
  `rev_by_name  TEXT CHECK (rev_by_name IS NULL OR length(rev_by_name) <= ${L.name})`,
];

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
  listTable(
    'compliance_context_resolved_facts',
    'context_id',
    'compliance_contexts',
    'code',
    `TEXT NOT NULL CHECK (${inList('code', RESOLVED_FACTS)})`,
  ),
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
  UNIQUE (id, context_id),
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
  listTable(
    'compliance_evaluation_policy_versions',
    'evaluation_id',
    'compliance_evaluations',
    'policy_version_id',
    POLICY_REF,
  ),
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
  snapshot_evaluation_id  TEXT,
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
  ${KEY_COLS('resolve').join(',\n  ')},
  ${REV_COLS.join(',\n  ')},
  CHECK ((decision_outcome IS NULL) = (decision_reviewer_id IS NULL)),
  CHECK (snapshot_evaluation_id IS NULL OR snapshot_outcome IS NOT NULL),
  CHECK (snapshot_evaluation_id IS NULL OR subject_context_id IS NOT NULL),
  CHECK ((started_at IS NULL) = (started_by_id IS NULL)),
  CHECK ((decided_at IS NOT NULL) = (decision_outcome IS NOT NULL OR status = 'CANCELLED')),
  CHECK (decision_outcome IS NOT NULL OR status IN ('PENDING','IN_REVIEW','CANCELLED')),
  CHECK (decision_outcome IS NULL OR decision_outcome = status OR (status = 'SUPERSEDED' AND decision_outcome <> 'CANCELLED')),
  FOREIGN KEY (snapshot_evaluation_id, subject_context_id) REFERENCES compliance_evaluations(id, context_id) ON DELETE RESTRICT
) STRICT;`,
  'CREATE INDEX regulatory_reviews_queue ON regulatory_reviews(status, requested_at);',
  'CREATE UNIQUE INDEX regulatory_reviews_superseded_once ON regulatory_reviews(supersedes_id) WHERE supersedes_id IS NOT NULL;',
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
  "CREATE INDEX regulatory_review_history_decisions ON regulatory_review_history(at) WHERE action <> 'regulatory_review_requested';",
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
  listTable(
    'compliance_context_history_policy_versions',
    'history_id',
    'compliance_context_history',
    'policy_version_id',
    POLICY_REF,
  ),
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
  listTable(
    'regulatory_consent_regarding',
    'consent_id',
    'regulatory_consents',
    'party_role',
    `TEXT NOT NULL CHECK (${inList('party_role', PARTY_ROLES)})`,
  ),
  listTable('regulatory_consent_policy_versions', 'consent_id', 'regulatory_consents', 'policy_version_id', POLICY_REF),
  listTable(
    'regulatory_consent_rule_ids',
    'consent_id',
    'regulatory_consents',
    'rule_id',
    `TEXT NOT NULL CHECK (length(rule_id) > 0 AND length(rule_id) <= ${L.ruleId})`,
  ),
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
  'compliance_contexts',
  'compliance_context_jurisdictions',
  'compliance_context_parties',
  'compliance_context_representations',
  'compliance_context_resolved_facts',
  'compliance_evaluations',
  'compliance_evaluation_reasons',
  'compliance_evaluation_reason_items',
  'compliance_evaluation_consents_outstanding',
  'compliance_evaluation_policy_versions',
  'compliance_evaluation_snapshot_parties',
  'compliance_evaluation_snapshot_representations',
  'regulatory_reviews',
  'regulatory_review_reasons',
  'regulatory_review_reason_items',
  'regulatory_review_policy_versions',
  'regulatory_review_evidence_refs',
  'regulatory_review_history',
  'compliance_context_history',
  'compliance_context_history_policy_versions',
  'regulatory_consents',
  'regulatory_consent_regarding',
  'regulatory_consent_policy_versions',
  'regulatory_consent_rule_ids',
  'regulatory_consent_revocations',
  'regulatory_consent_history',
]);

// ------------------------------------------------------------------ rows
const refusal = (code, message, extra = {}) => Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
const FAIL = (reason) => {
  throw refusal('COMPLIANCE_RECORDS_INPUT_INVALID', reason);
};
const listOf = (v, what) =>
  Array.isArray(v) ? v : v === undefined || v === null ? [] : FAIL(`${what}: must be a list (got ${describe(v)})`);
const bool = (v) => (v === true ? 1 : v === false ? 0 : v);
const byCols = (by, p = 'by') => ({
  [`${p}_kind`]: by?.kind,
  [`${p}_id`]: by?.userId ?? null,
  [`${p}_name`]: by?.name ?? null,
  [`${p}_role`]: by?.role ?? null,
  ...(p === 'by' ? { by_org_id: by?.orgId ?? null } : {}),
});
const byOfRow = (r, p = 'by') => ({
  kind: r[`${p}_kind`],
  userId: r[`${p}_id`],
  name: r[`${p}_name`],
  ...(r[`${p}_kind`] === 'ts_reviewer' ? { role: r[`${p}_role`] } : {}),
  ...(r[`${p}_kind`] === 'club_user' && r[`${p}_org_id`] !== undefined ? { orgId: r[`${p}_org_id`] } : {}),
});
const revCols = (r) => ({
  rev: r.rev,
  rev_at: r.revAt ?? null,
  rev_by_id: r.revBy?.userId ?? null,
  rev_by_name: r.revBy?.name ?? null,
});
const revOfRow = (row) => ({
  rev: row.rev,
  revAt: row.rev_at,
  revBy: row.rev_by_id === null && row.rev_by_name === null ? null : { userId: row.rev_by_id, name: row.rev_by_name },
});
/** The decision states a review records, by kind. */
const PRIOR_KEYS = {
  verification_facet: ['facetState'],
  representation_dispute: ['agreementStatus'],
  representation_declared: ['contextOutcome', 'representationStatus'],
  conflict_evaluation: ['contextOutcome', 'representationStatus'],
};
const uniqueCodes = (reasons) => [...new Set(reasons.map((x) => x.code))];

const st = new WeakMap();
/** An absent value is bound as NULL (a NOT NULL column then refuses it), positional or named. */
const bindable = (v) =>
  v === undefined
    ? null
    : v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === undefined ? null : x]))
      : v;
function statements(sqlite) {
  let s = st.get(sqlite);
  if (s && s.prepare === sqlite.prepare) return s.list;
  const p = (sql) => {
    const stmt = sqlite.prepare(sql);
    return { run: (...args) => stmt.run(...args.map(bindable)) };
  };
  const reasonIns = (prefix, owner) =>
    p(
      `INSERT INTO ${prefix}_reasons (${owner}, ord, code, rule_id, rule_status, regulator, jurisdiction, policy_version_id, ${REASON_SCALARS.map(([, c]) => c).join(', ')}, via_connected_agent, has_party_roles, has_jurisdictions) VALUES (${Array(
        9 + REASON_SCALARS.length + 2,
      )
        .fill('?')
        .join(', ')})`,
    );
  const list = {
    context:
      p(`INSERT INTO compliance_contexts (id, agency_org_id, agent_user_id, type, status, re_evaluation_pending, review_rejected_at, origin, transaction_id, opened_at, closed_at, create_key, create_fp, rev, rev_at, rev_by_id, rev_by_name)
      VALUES (@id, @agency_org_id, @agent_user_id, @type, @status, @re_evaluation_pending, @review_rejected_at, @origin, @transaction_id, @opened_at, @closed_at, @create_key, @create_fp, @rev, @rev_at, @rev_by_id, @rev_by_name)`),
    jurIns: p('INSERT INTO compliance_context_jurisdictions (context_id, ord, member_association) VALUES (?, ?, ?)'),
    partyIns: p(
      'INSERT INTO compliance_context_parties (context_id, ord, id, party_role, subject_kind, subject_id, added_at, removed, removed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    repIns: p(
      'INSERT INTO compliance_context_representations (context_id, ord, id, agent_user_id, party_role, agreement_id, status, declared_only, review_id, declared_at, first_act_at, withdrawn_at, verified_by_review_id, verified_at, declare_key, declare_fp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    factIns: p('INSERT INTO compliance_context_resolved_facts (context_id, ord, code) VALUES (?, ?, ?)'),
    ctxHist:
      p(`INSERT INTO compliance_context_history (id, context_id, ord, at, by_kind, by_id, by_name, by_role, by_org_id, action, detail_party_role, detail_subject_kind, detail_status, detail_review_outcome, detail_evaluation_id, detail_review_id, detail_policy_version_id)
      VALUES (@id, @owner, @ord, @at, @by_kind, @by_id, @by_name, @by_role, @by_org_id, @action, @detail_party_role, @detail_subject_kind, @detail_status, @detail_review_outcome, @detail_evaluation_id, @detail_review_id, @detail_policy_version_id)`),
    ctxHistPv: p(
      'INSERT INTO compliance_context_history_policy_versions (history_id, ord, policy_version_id) VALUES (?, ?, ?)',
    ),
    evaluation: p(
      'INSERT INTO compliance_evaluations (id, context_id, position, outcome, evaluated_at, input_hash, proposed_party_role, proposed_agent_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    evReason: reasonIns('compliance_evaluation', 'evaluation_id'),
    evReasonItem: p(
      'INSERT INTO compliance_evaluation_reason_items (evaluation_id, reason_ord, list, ord, value) VALUES (?, ?, ?, ?, ?)',
    ),
    evConsent: p(
      'INSERT INTO compliance_evaluation_consents_outstanding (evaluation_id, ord, party_role, agent_user_id, consent_kind, reason_code) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    evPv: p(
      'INSERT INTO compliance_evaluation_policy_versions (evaluation_id, ord, policy_version_id) VALUES (?, ?, ?)',
    ),
    evParty: p(
      'INSERT INTO compliance_evaluation_snapshot_parties (evaluation_id, ord, party_role, subject_kind, subject_id) VALUES (?, ?, ?, ?, ?)',
    ),
    evRep: p(
      'INSERT INTO compliance_evaluation_snapshot_representations (evaluation_id, ord, agent_user_id, party_role, status) VALUES (?, ?, ?, ?, ?)',
    ),
    review: p(
      `INSERT INTO regulatory_reviews (${REVIEW_COLS.join(', ')}) VALUES (${REVIEW_COLS.map((c) => `@${c}`).join(', ')})`,
    ),
    rvReason: reasonIns('regulatory_review', 'review_id'),
    rvReasonItem: p(
      'INSERT INTO regulatory_review_reason_items (review_id, reason_ord, list, ord, value) VALUES (?, ?, ?, ?, ?)',
    ),
    rvPv: p('INSERT INTO regulatory_review_policy_versions (review_id, ord, policy_version_id) VALUES (?, ?, ?)'),
    rvRef: p('INSERT INTO regulatory_review_evidence_refs (review_id, ord, ref) VALUES (?, ?, ?)'),
    rvHist: p(
      'INSERT INTO regulatory_review_history (id, review_id, ord, at, by_kind, by_id, by_name, by_role, by_org_id, action, detail_rev, detail_review_id, detail_prior_status) VALUES (@id, @owner, @ord, @at, @by_kind, @by_id, @by_name, @by_role, @by_org_id, @action, @detail_rev, @detail_review_id, @detail_prior_status)',
    ),
    consent: p(
      `INSERT INTO regulatory_consents (${CONSENT_COLS.join(', ')}) VALUES (${CONSENT_COLS.map((c) => `@${c}`).join(', ')})`,
    ),
    csRegarding: p('INSERT INTO regulatory_consent_regarding (consent_id, ord, party_role) VALUES (?, ?, ?)'),
    csPv: p('INSERT INTO regulatory_consent_policy_versions (consent_id, ord, policy_version_id) VALUES (?, ?, ?)'),
    csRule: p('INSERT INTO regulatory_consent_rule_ids (consent_id, ord, rule_id) VALUES (?, ?, ?)'),
    csHist: p(
      'INSERT INTO regulatory_consent_history (id, consent_id, ord, at, by_kind, by_id, by_name, by_role, by_org_id, action) VALUES (@id, @owner, @ord, @at, @by_kind, @by_id, @by_name, @by_role, @by_org_id, @action)',
    ),
    revocation: p(
      'INSERT INTO regulatory_consent_revocations (id, consent_id, revoked_at, by_kind, by_id, by_name, by_org_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ),
  };
  st.set(sqlite, { prepare: sqlite.prepare, list });
  return list;
}
const REVIEW_COLS = [
  'id',
  'kind',
  'status',
  'agency_org_id',
  'agent_user_id',
  'subject_profile_id',
  'subject_user_id',
  'subject_facet',
  'subject_member_association',
  'subject_agreement_id',
  'subject_context_id',
  'subject_transaction_id',
  'subject_representation_id',
  'subject_party_role',
  'subject_is_approach',
  'subject_player_id',
  'subject_jurisdiction',
  'snapshot_outcome',
  'snapshot_evaluation_id',
  'snapshot_evaluated_at',
  'requested_at',
  'requested_by_kind',
  'requested_by_id',
  'requested_by_name',
  'requested_by_role',
  'started_at',
  'started_by_id',
  'started_by_name',
  'started_by_role',
  'decided_at',
  'decision_reviewer_id',
  'decision_reviewer_name',
  'decision_reviewer_role',
  'decision_outcome',
  'decision_reason_code',
  'decision_reason',
  'decision_at',
  'prior_status',
  'prior_facet_state',
  'prior_agreement_status',
  'prior_context_outcome',
  'prior_representation_status',
  'result_facet_state',
  'result_agreement_status',
  'result_context_outcome',
  'result_representation_status',
  'result_note',
  'supersedes_id',
  'resolve_key',
  'resolve_fp',
  'rev',
  'rev_at',
  'rev_by_id',
  'rev_by_name',
];
const CONSENT_COLS = [
  'id',
  'kind',
  'context_id',
  'agent_user_id',
  'agency_org_id',
  'party_role',
  'subject_kind',
  'subject_id',
  'status',
  'requested_at',
  'requested_by_kind',
  'requested_by_id',
  'requested_by_name',
  'requested_by_role',
  'granted_at',
  'granted_by_kind',
  'granted_by_id',
  'granted_by_name',
  'granted_by_org_id',
  'granted_by_signatory',
  'declined_at',
  'declined_by_kind',
  'declined_by_id',
  'declined_by_name',
  'declined_by_org_id',
  'full_particulars_provided',
  'legal_advice_offered',
  'proposed_fee_disclosed',
  'acknowledged_at',
  ...CONSENT_KEY_SLOTS.flatMap((s) => [`${s}_key`, `${s}_fp`]),
  'rev',
  'rev_at',
  'rev_by_id',
  'rev_by_name',
];

function writeReasons(ins, itemIns, owner, reasons) {
  listOf(reasons, `${owner} reasons`).forEach((r, i) => {
    ins.run(
      owner,
      i,
      r?.code,
      r?.ruleId,
      r?.ruleStatus,
      r?.regulator,
      r?.jurisdiction,
      r?.policyVersion,
      ...REASON_SCALARS.map(([k]) => r?.[k] ?? null),
      r?.viaConnectedAgent ? 1 : null,
      r?.partyRoles ? 1 : 0,
      r?.jurisdictions ? 1 : 0,
    );
    for (const list of REASON_LISTS)
      listOf(r?.[list], `${owner} reasons[${i}].${list}`).forEach((v, j) => itemIns.run(owner, i, list, j, v));
  });
}
function readReason(row, items) {
  const out = {
    code: row.code,
    ruleId: row.rule_id,
    ruleStatus: row.rule_status,
    regulator: row.regulator,
    jurisdiction: row.jurisdiction,
    policyVersion: row.policy_version_id,
  };
  for (const [k, c] of REASON_SCALARS) {
    if (row[c] !== null) out[k] = row[c];
    if (k === 'partyRole' && row.has_party_roles)
      out.partyRoles = items.filter((x) => x.list === 'partyRoles').map((x) => x.value);
  }
  if (row.via_connected_agent) out.viaConnectedAgent = true;
  if (row.has_jurisdictions) out.jurisdictions = items.filter((x) => x.list === 'jurisdictions').map((x) => x.value);
  return out;
}

const contextPartyRow = (id, ord, p) => [
  id,
  ord,
  p?.id,
  p?.partyRole,
  p?.subjectKind,
  p?.subjectId,
  p?.addedAt ?? null,
  bool(p?.removed),
  p?.removedAt ?? null,
];
const contextRepRow = (id, ord, r) => [
  id,
  ord,
  r?.id,
  r?.agentUserId,
  r?.partyRole,
  r?.agreementId ?? null,
  r?.status,
  bool(r?.declaredOnly),
  r?.reviewId ?? null,
  r?.declaredAt ?? null,
  r?.firstActAt ?? null,
  r?.withdrawnAt ?? null,
  r?.verifiedByReviewId ?? null,
  r?.verifiedAt ?? null,
  r?.keys?.declare?.key ?? null,
  r?.keys?.declare?.fp ?? null,
];
/** A new context's rows (its evaluations are recorded with recordEvaluation). */
function writeContext(s, c) {
  s.context.run({
    id: c.id,
    agency_org_id: c.agencyOrgId,
    agent_user_id: c.agentUserId,
    type: c.type,
    status: c.status,
    re_evaluation_pending: bool(c.reEvaluationPending),
    review_rejected_at: c.reviewRejectedAt ?? null,
    origin: c.origin ?? null,
    transaction_id: c.transactionId ?? null,
    opened_at: c.openedAt,
    closed_at: c.closedAt ?? null,
    create_key: c.keys?.create?.key ?? null,
    create_fp: c.keys?.create?.fp ?? null,
    ...revCols(c),
  });
  listOf(c.jurisdictions, `compliance_contexts ${c.id} jurisdictions`).forEach((j, i) => s.jurIns.run(c.id, i, j));
  listOf(c.parties, `compliance_contexts ${c.id} parties`).forEach((p, i) =>
    s.partyIns.run(...contextPartyRow(c.id, i, p)),
  );
  listOf(c.representations, `compliance_contexts ${c.id} representations`).forEach((r, i) =>
    s.repIns.run(...contextRepRow(c.id, i, r)),
  );
  listOf(c.resolvedFacts, `compliance_contexts ${c.id} resolvedFacts`).forEach((f, i) => s.factIns.run(c.id, i, f));
}
/** A context history entry; an evaluation entry, and a verified declaration, name the evaluation they repeat. */
function writeContextEntry(s, owner, ord, h, evaluationId) {
  const d = h?.detail ?? {};
  const linksEvaluation =
    (h?.action === 'compliance_context_evaluated' && !d.reviewId) ||
    (h?.action === 'compliance_representation_declared' && d.status === 'verified');
  if (linksEvaluation && !evaluationId)
    FAIL(`compliance_context_history ${h.id}: an evaluation entry needs the evaluation it repeats`);
  s.ctxHist.run({
    id: h?.id,
    owner,
    ord,
    at: h?.at,
    ...byCols(h?.by),
    action: h?.action,
    detail_party_role: d.partyRole ?? null,
    detail_subject_kind: h?.action === 'compliance_context_party_added' ? d.kind : null,
    detail_status: h?.action === 'compliance_representation_declared' ? d.status : null,
    detail_review_outcome: h?.action === 'compliance_context_evaluated' && d.reviewId ? d.outcome : null,
    detail_evaluation_id: linksEvaluation ? evaluationId : null,
    detail_review_id: d.reviewId ?? null,
    detail_policy_version_id:
      h?.action === 'compliance_context_policy_changed'
        ? listOf(d.policyVersions, `history ${h.id} policyVersions`)[0]
        : null,
  });
  if (h?.action === 'compliance_context_opened')
    listOf(d.policyVersions, `history ${h.id} policyVersions`).forEach((pv, i) => s.ctxHistPv.run(h.id, i, pv));
}
function writeEvaluation(s, contextId, position, e, snapshotOf) {
  const id = `${contextId}#${position}`;
  s.evaluation.run(
    id,
    contextId,
    position,
    e?.outcome,
    e?.evaluatedAt,
    e?.inputHash,
    snapshotOf?.proposed?.partyRole ?? null,
    snapshotOf?.proposed?.agentUserId ?? null,
  );
  writeReasons(s.evReason, s.evReasonItem, id, e?.reasons);
  listOf(e?.consentsOutstanding, `${id} consentsOutstanding`).forEach((c, i) =>
    s.evConsent.run(id, i, c?.partyRole, c?.agentUserId ?? null, c?.consentKind, c?.reasonCode),
  );
  listOf(e?.policyVersions, `${id} policyVersions`).forEach((pv, i) => s.evPv.run(id, i, pv));
  listOf(snapshotOf?.parties, `${id} snapshotOf.parties`).forEach((p, i) =>
    s.evParty.run(id, i, p?.partyRole, p?.subjectKind, p?.subjectId),
  );
  listOf(snapshotOf?.representations, `${id} snapshotOf.representations`).forEach((r, i) =>
    s.evRep.run(id, i, r?.agentUserId, r?.partyRole, r?.status),
  );
  return id;
}
/** A review decision's columns (prior and resulting states by kind, or none for a cancellation). */
const decisionCols = (d) => {
  const ps = d?.priorState ?? {};
  const rs = d?.resultingState ?? {};
  return {
    decision_reviewer_id: d?.reviewerId ?? null,
    decision_reviewer_name: d?.reviewerName ?? null,
    decision_reviewer_role: d?.reviewerRole ?? null,
    decision_outcome: d?.outcome ?? null,
    decision_reason_code: d?.reasonCode ?? null,
    decision_reason: d?.reason ?? null,
    decision_at: d?.at ?? null,
    prior_status: d?.priorState ? ps.status : null,
    prior_facet_state: ps.facetState ?? null,
    prior_agreement_status: ps.agreementStatus ?? null,
    prior_context_outcome: ps.contextOutcome ?? null,
    prior_representation_status: ps.representationStatus ?? null,
    result_facet_state: rs.facetState ?? null,
    result_agreement_status: rs.agreementStatus ?? null,
    result_context_outcome: rs.contextOutcome ?? null,
    result_representation_status: rs.representationStatus ?? null,
    result_note: rs.note ?? null,
  };
};
function reviewRow(r) {
  const sub = r.subject ?? {};
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    agency_org_id: r.agencyOrgId,
    agent_user_id: r.agentUserId ?? null,
    subject_profile_id: sub.profileId ?? null,
    subject_user_id: sub.userId ?? null,
    subject_facet: sub.facet ?? null,
    subject_member_association: sub.memberAssociation ?? null,
    subject_agreement_id: sub.agreementId ?? null,
    subject_context_id: sub.contextId ?? null,
    subject_transaction_id: sub.transactionId ?? null,
    subject_representation_id: sub.representationId ?? null,
    subject_party_role: sub.partyRole ?? null,
    subject_is_approach: sub.approach ? 1 : 0,
    subject_player_id: sub.playerId ?? null,
    subject_jurisdiction: sub.jurisdiction ?? null,
    snapshot_outcome: r.snapshot?.outcome ?? null,
    snapshot_evaluation_id: r.snapshot?.evaluationId ?? null,
    snapshot_evaluated_at: r.snapshot?.evaluatedAt ?? null,
    requested_at: r.requestedAt,
    ...byCols(r.requestedBy, 'requested_by'),
    started_at: r.startedAt ?? null,
    started_by_id: r.startedBy?.id ?? null,
    started_by_name: r.startedBy?.name ?? null,
    started_by_role: r.startedBy?.role ?? null,
    decided_at: r.decidedAt ?? null,
    ...decisionCols(r.decision),
    supersedes_id: r.supersedes ?? null,
    resolve_key: r.keys?.resolve?.key ?? null,
    resolve_fp: r.keys?.resolve?.fp ?? null,
    ...revCols(r),
  };
}
/** A new review's rows; its history entries follow, in order. */
function writeReview(s, r) {
  s.review.run(reviewRow(r));
  writeReasons(s.rvReason, s.rvReasonItem, r.id, r.reasons);
  listOf(r.policyVersions, `regulatory_reviews ${r.id} policyVersions`).forEach((pv, i) => s.rvPv.run(r.id, i, pv));
  listOf(r.decision?.evidenceRefs, `regulatory_reviews ${r.id} evidenceRefs`).forEach((ref, i) =>
    s.rvRef.run(r.id, i, ref),
  );
}
const reviewEntry = (owner, ord, h) => {
  const d = h?.detail ?? {};
  return {
    id: h?.id,
    owner,
    ord,
    at: h?.at,
    ...byCols(h?.by),
    action: h?.action,
    detail_rev: d.rev ?? null,
    detail_review_id: d.reviewId ?? null,
    detail_prior_status: d.priorState && h?.action === 'regulatory_review_superseded' ? d.priorState.status : null,
  };
};
const answerCols = (slot, at, by, { signatory = false } = {}) => ({
  [`${slot}_at`]: at ?? null,
  [`${slot}_by_kind`]: by?.kind ?? null,
  [`${slot}_by_id`]: by?.userId ?? null,
  [`${slot}_by_name`]: by?.name ?? null,
  [`${slot}_by_org_id`]: by?.orgId ?? null,
  ...(signatory ? { granted_by_signatory: by?.signatory ? 1 : null } : {}),
});
const consentKeyCols = (keys) =>
  Object.fromEntries(
    CONSENT_KEY_SLOTS.flatMap((sl) => [
      [`${sl}_key`, keys?.[sl]?.key ?? null],
      [`${sl}_fp`, keys?.[sl]?.fp ?? null],
    ]),
  );
/** A new consent's rows; its history entries follow, in order. */
function writeConsent(s, k) {
  const p = k.particulars ?? {};
  s.consent.run({
    id: k.id,
    kind: k.kind,
    context_id: k.contextId,
    agent_user_id: k.agentUserId,
    agency_org_id: k.agencyOrgId,
    party_role: k.partyRole,
    subject_kind: k.subject?.kind,
    subject_id: k.subject?.id,
    status: k.status,
    requested_at: k.requestedAt,
    ...byCols(k.requestedBy, 'requested_by'),
    ...answerCols('granted', k.grantedAt, k.grantedBy, { signatory: true }),
    ...answerCols('declined', k.declinedAt, k.declinedBy),
    full_particulars_provided: bool(p.fullParticularsProvided),
    legal_advice_offered: bool(p.legalAdviceOffered),
    proposed_fee_disclosed: bool(p.proposedFeeDisclosed),
    acknowledged_at: p.acknowledged?.at ?? null,
    ...consentKeyCols(k.keys),
    ...revCols(k),
  });
  listOf(k.regarding, `regulatory_consents ${k.id} regarding`).forEach((x, i) => s.csRegarding.run(k.id, i, x));
  listOf(k.policyVersions, `regulatory_consents ${k.id} policyVersions`).forEach((x, i) => s.csPv.run(k.id, i, x));
  listOf(k.ruleIds, `regulatory_consents ${k.id} ruleIds`).forEach((x, i) => s.csRule.run(k.id, i, x));
}

// ---- decoding
const inIds = (sqlite, sql, list) => (list.length ? sqlite.prepare(sql).all(JSON.stringify([...new Set(list)])) : []);
const groupBy = (rows, key) => {
  const m = new Map();
  for (const r of rows) {
    const k = key(r);
    let l = m.get(k);
    if (!l) m.set(k, (l = []));
    l.push(r);
  }
  return (k) => m.get(k) ?? [];
};
const IN = (col) => `${col} IN (SELECT value FROM json_each(?))`;
function decodeReasonsOf(sqlite, prefix, owner, ownerIds) {
  const rows = groupBy(
    inIds(sqlite, `SELECT * FROM ${prefix}_reasons WHERE ${IN(owner)} ORDER BY ${owner}, ord`, ownerIds),
    (r) => r[owner],
  );
  const items = groupBy(
    inIds(
      sqlite,
      `SELECT * FROM ${prefix}_reason_items WHERE ${IN(owner)} ORDER BY ${owner}, reason_ord, list, ord`,
      ownerIds,
    ),
    (r) => `${r[owner]}#${r.reason_ord}`,
  );
  return (id) => rows(id).map((r) => readReason(r, items(`${id}#${r.ord}`)));
}
function decodeEvaluations(sqlite, rows) {
  const evIds = rows.map((r) => r.id);
  const reasons = decodeReasonsOf(sqlite, 'compliance_evaluation', 'evaluation_id', evIds);
  const consents = groupBy(
    inIds(
      sqlite,
      `SELECT * FROM compliance_evaluation_consents_outstanding WHERE ${IN('evaluation_id')} ORDER BY evaluation_id, ord`,
      evIds,
    ),
    (r) => r.evaluation_id,
  );
  const pvs = groupBy(
    inIds(
      sqlite,
      `SELECT * FROM compliance_evaluation_policy_versions WHERE ${IN('evaluation_id')} ORDER BY evaluation_id, ord`,
      evIds,
    ),
    (r) => r.evaluation_id,
  );
  const parties = groupBy(
    inIds(
      sqlite,
      `SELECT * FROM compliance_evaluation_snapshot_parties WHERE ${IN('evaluation_id')} ORDER BY evaluation_id, ord`,
      evIds,
    ),
    (r) => r.evaluation_id,
  );
  const reps = groupBy(
    inIds(
      sqlite,
      `SELECT * FROM compliance_evaluation_snapshot_representations WHERE ${IN('evaluation_id')} ORDER BY evaluation_id, ord`,
      evIds,
    ),
    (r) => r.evaluation_id,
  );
  return rows.map((row) => {
    const rs = reasons(row.id);
    const co = consents(row.id).map((c) => ({
      partyRole: c.party_role,
      agentUserId: c.agent_user_id,
      consentKind: c.consent_kind,
      reasonCode: c.reason_code,
    }));
    const derived = derivedOfEvaluation({ outcome: row.outcome, reasons: rs, consentsOutstanding: co });
    return {
      outcome: row.outcome,
      alias: derived.alias,
      reasons: rs,
      consentsOutstanding: co,
      requiredActions: derived.requiredActions,
      missingEvidence: derived.missingEvidence,
      policyVersions: pvs(row.id).map((p) => p.policy_version_id),
      evaluatedAt: row.evaluated_at,
      inputHash: row.input_hash,
      snapshotOf: {
        parties: parties(row.id).map((p) => ({
          partyRole: p.party_role,
          subjectKind: p.subject_kind,
          subjectId: p.subject_id,
        })),
        representations: reps(row.id).map((r) => ({
          agentUserId: r.agent_user_id,
          partyRole: r.party_role,
          status: r.status,
        })),
        proposed:
          row.proposed_party_role === null
            ? null
            : { partyRole: row.proposed_party_role, agentUserId: row.proposed_agent_user_id },
      },
      ruleStatuses: derived.ruleStatuses,
      evaluationId: row.id,
      contextId: row.context_id,
      position: row.position,
    };
  });
}
function decodeContexts(sqlite, rows) {
  const cids = rows.map((r) => r.id);
  const jur = groupBy(
    inIds(
      sqlite,
      `SELECT * FROM compliance_context_jurisdictions WHERE ${IN('context_id')} ORDER BY context_id, ord`,
      cids,
    ),
    (r) => r.context_id,
  );
  const parties = groupBy(
    inIds(sqlite, `SELECT * FROM compliance_context_parties WHERE ${IN('context_id')} ORDER BY context_id, ord`, cids),
    (r) => r.context_id,
  );
  const reps = groupBy(
    inIds(
      sqlite,
      `SELECT * FROM compliance_context_representations WHERE ${IN('context_id')} ORDER BY context_id, ord`,
      cids,
    ),
    (r) => r.context_id,
  );
  const facts = groupBy(
    inIds(
      sqlite,
      `SELECT * FROM compliance_context_resolved_facts WHERE ${IN('context_id')} ORDER BY context_id, ord`,
      cids,
    ),
    (r) => r.context_id,
  );
  const histRows = inIds(
    sqlite,
    `SELECT * FROM compliance_context_history WHERE ${IN('context_id')} ORDER BY context_id, ord`,
    cids,
  );
  const hist = groupBy(histRows, (r) => r.context_id);
  const histPv = groupBy(
    inIds(
      sqlite,
      `SELECT * FROM compliance_context_history_policy_versions WHERE ${IN('history_id')} ORDER BY history_id, ord`,
      histRows.filter((h) => h.action === 'compliance_context_opened').map((h) => h.id),
    ),
    (r) => r.history_id,
  );
  const lastRows = inIds(
    sqlite,
    `SELECT e.* FROM compliance_evaluations e JOIN (SELECT context_id, MAX(position) AS p FROM compliance_evaluations WHERE ${IN('context_id')} GROUP BY context_id) m ON m.context_id = e.context_id AND m.p = e.position`,
    cids,
  );
  const linkedIds = histRows.map((h) => h.detail_evaluation_id).filter(Boolean);
  const evRows = [
    ...lastRows,
    ...inIds(sqlite, `SELECT * FROM compliance_evaluations WHERE ${IN('id')}`, linkedIds).filter(
      (r) => !lastRows.some((l) => l.id === r.id),
    ),
  ];
  const evs = new Map(decodeEvaluations(sqlite, evRows).map((e) => [e.evaluationId, e]));
  const lastOf = new Map(lastRows.map((r) => [r.context_id, r]));
  return rows.map((row) => {
    const type = row.type;
    const history = hist(row.id).map((h) => {
      const ev = h.detail_evaluation_id ? evs.get(h.detail_evaluation_id) : null;
      let detail = null;
      switch (h.action) {
        case 'compliance_context_opened':
          detail = { type, policyVersions: histPv(h.id).map((p) => p.policy_version_id) };
          break;
        case 'compliance_context_party_added':
          detail = { partyRole: h.detail_party_role, kind: h.detail_subject_kind };
          break;
        case 'compliance_context_party_removed':
          detail = { partyRole: h.detail_party_role };
          break;
        case 'compliance_representation_declared':
          detail =
            h.detail_status === 'pending_review'
              ? { partyRole: h.detail_party_role, status: 'pending_review' }
              : {
                  partyRole: h.detail_party_role,
                  status: 'verified',
                  outcome: ev.outcome,
                  policyVersions: ev.policyVersions,
                };
          break;
        case 'compliance_representation_verified':
          detail = { partyRole: h.detail_party_role, reviewId: h.detail_review_id };
          break;
        case 'compliance_representation_withdrawn':
          detail = { partyRole: h.detail_party_role, ...(h.detail_review_id ? { reviewId: h.detail_review_id } : {}) };
          break;
        case 'compliance_context_evaluated':
          detail = h.detail_review_id
            ? { reviewId: h.detail_review_id, outcome: h.detail_review_outcome }
            : {
                outcome: ev.outcome,
                reasonCodes: [...new Set(ev.reasons.map((x) => x.code))],
                policyVersions: ev.policyVersions,
              };
          break;
        case 'compliance_context_policy_changed':
          detail = { policyVersions: [h.detail_policy_version_id] };
          break;
        default:
          detail = null;
      }
      return { id: h.id, at: h.at, action: h.action, by: byOfRow(h), detail };
    });
    const last = lastOf.get(row.id);
    return {
      id: row.id,
      agencyOrgId: row.agency_org_id,
      agentUserId: row.agent_user_id,
      type,
      jurisdictions: jur(row.id).map((j) => j.member_association),
      parties: parties(row.id).map((p) => ({
        id: p.id,
        partyRole: p.party_role,
        subjectKind: p.subject_kind,
        subjectId: p.subject_id,
        addedAt: p.added_at,
        removed: p.removed === 1,
        removedAt: p.removed_at,
      })),
      representations: reps(row.id).map((r) => ({
        id: r.id,
        agentUserId: r.agent_user_id,
        partyRole: r.party_role,
        agreementId: r.agreement_id,
        status: r.status,
        declaredOnly: r.declared_only === 1,
        reviewId: r.review_id,
        declaredAt: r.declared_at,
        firstActAt: r.first_act_at,
        withdrawnAt: r.withdrawn_at,
        verifiedByReviewId: r.verified_by_review_id,
        verifiedAt: r.verified_at,
        keys: r.declare_key === null ? {} : { declare: { key: r.declare_key, fp: r.declare_fp } },
      })),
      resolvedFacts: facts(row.id).map((f) => f.code),
      reEvaluationPending: row.re_evaluation_pending === 1,
      reviewRejectedAt: row.review_rejected_at,
      status: row.status,
      ...(row.origin ? { origin: row.origin, transactionId: row.transaction_id } : {}),
      openedAt: row.opened_at,
      closedAt: row.closed_at,
      keys: row.create_key === null ? {} : { create: { key: row.create_key, fp: row.create_fp } },
      ...revOfRow(row),
      history,
      lastEvaluation: last ? evs.get(last.id) : null,
      evaluationCount: last ? last.position : 0,
    };
  });
}
function decodeReviews(sqlite, rows) {
  const rids = rows.map((r) => r.id);
  const reasons = decodeReasonsOf(sqlite, 'regulatory_review', 'review_id', rids);
  const pvs = groupBy(
    inIds(
      sqlite,
      `SELECT * FROM regulatory_review_policy_versions WHERE ${IN('review_id')} ORDER BY review_id, ord`,
      rids,
    ),
    (r) => r.review_id,
  );
  const refs = groupBy(
    inIds(
      sqlite,
      `SELECT * FROM regulatory_review_evidence_refs WHERE ${IN('review_id')} ORDER BY review_id, ord`,
      rids,
    ),
    (r) => r.review_id,
  );
  const hist = groupBy(
    inIds(sqlite, `SELECT * FROM regulatory_review_history WHERE ${IN('review_id')} ORDER BY review_id, ord`, rids),
    (r) => r.review_id,
  );
  const evs = new Map(
    decodeEvaluations(
      sqlite,
      inIds(
        sqlite,
        `SELECT * FROM compliance_evaluations WHERE ${IN('id')}`,
        rows.map((r) => r.snapshot_evaluation_id).filter(Boolean),
      ),
    ).map((e) => [e.evaluationId, e]),
  );
  // A review's `supersededBy` is the review naming it (`supersedes_id`): one fact, stored once.
  const nextOf = new Map(
    inIds(sqlite, `SELECT id, supersedes_id FROM regulatory_reviews WHERE ${IN('supersedes_id')}`, rids).map((r) => [
      r.supersedes_id,
      r.id,
    ]),
  );
  return rows.map((row) => {
    const kind = row.kind;
    const rs = reasons(row.id);
    const policyVersions = pvs(row.id).map((p) => p.policy_version_id);
    const subject =
      kind === 'verification_facet'
        ? {
            profileId: row.subject_profile_id,
            userId: row.subject_user_id,
            facet: row.subject_facet,
            memberAssociation: row.subject_member_association,
          }
        : kind === 'representation_dispute'
          ? { agreementId: row.subject_agreement_id }
          : row.subject_is_approach
            ? { approach: true, playerId: row.subject_player_id, jurisdiction: row.subject_jurisdiction }
            : {
                contextId: row.subject_context_id,
                ...(row.subject_transaction_id ? { transactionId: row.subject_transaction_id } : {}),
                representationId: row.subject_representation_id,
                partyRole: row.subject_party_role,
              };
    let snapshot = null;
    if (row.snapshot_outcome !== null) {
      const ev = row.snapshot_evaluation_id ? evs.get(row.snapshot_evaluation_id) : null;
      snapshot = ev
        ? {
            outcome: ev.outcome,
            alias: ev.alias,
            reasons: ev.reasons,
            consentsOutstanding: ev.consentsOutstanding,
            requiredActions: ev.requiredActions,
            missingEvidence: ev.missingEvidence,
            policyVersions: ev.policyVersions,
            evaluatedAt: ev.evaluatedAt,
            inputHash: ev.inputHash,
            proposed: ev.snapshotOf.proposed,
            evaluationId: ev.evaluationId,
          }
        : { outcome: row.snapshot_outcome, reasons: rs, policyVersions, evaluatedAt: row.snapshot_evaluated_at };
    }
    const keysOfState = PRIOR_KEYS[kind];
    const col = {
      facetState: 'facet_state',
      agreementStatus: 'agreement_status',
      contextOutcome: 'context_outcome',
      representationStatus: 'representation_status',
    };
    let decision = null;
    if (row.decision_reviewer_id !== null) {
      const cancel = row.decision_outcome === 'CANCELLED';
      const prior = cancel
        ? null
        : { status: row.prior_status, ...Object.fromEntries(keysOfState.map((k) => [k, row[`prior_${col[k]}`]])) };
      const resultKeys = row.result_note
        ? kind === 'representation_dispute'
          ? ['agreementStatus']
          : [keysOfState[0]]
        : keysOfState;
      const resulting = cancel
        ? null
        : {
            ...Object.fromEntries(resultKeys.map((k) => [k, row[`result_${col[k]}`]])),
            ...(row.result_note ? { note: row.result_note } : {}),
          };
      decision = {
        reviewerId: row.decision_reviewer_id,
        reviewerName: row.decision_reviewer_name,
        reviewerRole: row.decision_reviewer_role,
        outcome: row.decision_outcome,
        reasonCode: row.decision_reason_code,
        reason: row.decision_reason,
        evidenceRefs: refs(row.id).map((x) => x.ref),
        policyVersions,
        at: row.decision_at,
        priorState: prior,
        resultingState: resulting,
      };
    }
    const history = hist(row.id).map((h) => {
      let detail;
      if (h.action === 'regulatory_review_requested')
        detail = h.detail_review_id
          ? { reasonCode: 'supersedes', reviewId: h.detail_review_id }
          : { kind, reasonCodes: uniqueCodes(rs), policyVersions };
      else if (h.action === 'regulatory_review_started') detail = { rev: h.detail_rev };
      else if (h.action === 'regulatory_review_resolved')
        detail = {
          outcome: decision.outcome,
          reasonCode: decision.reasonCode,
          evidenceRefs: decision.evidenceRefs,
          evidenceCount: decision.evidenceRefs.length,
          policyVersions,
          priorState: decision.priorState,
          resultingState: decision.resultingState,
          rev: h.detail_rev,
        };
      else if (h.action === 'regulatory_review_cancelled')
        detail =
          h.detail_rev === null
            ? { reasonCode: 'context_closed' }
            : { outcome: 'CANCELLED', reasonCode: 'cancelled', rev: h.detail_rev };
      else
        detail = {
          reasonCode: 'superseded',
          reviewId: h.detail_review_id,
          priorState: { status: h.detail_prior_status },
          rev: h.detail_rev,
        };
      return { id: h.id, at: h.at, action: h.action, by: byOfRow(h), detail };
    });
    return {
      id: row.id,
      kind,
      status: row.status,
      agencyOrgId: row.agency_org_id,
      agentUserId: row.agent_user_id,
      subject,
      reasons: rs,
      policyVersions,
      snapshot,
      requestedAt: row.requested_at,
      requestedBy: byOfRow(row, 'requested_by'),
      startedAt: row.started_at,
      startedBy:
        row.started_by_id === null
          ? null
          : { id: row.started_by_id, name: row.started_by_name, role: row.started_by_role },
      decidedAt: row.decided_at,
      decision,
      supersedes: row.supersedes_id,
      supersededBy: nextOf.get(row.id) ?? null,
      keys: row.resolve_key === null ? {} : { resolve: { key: row.resolve_key, fp: row.resolve_fp } },
      ...revOfRow(row),
      history,
    };
  });
}
function decodeConsents(sqlite, rows) {
  const kids = rows.map((r) => r.id);
  const regarding = groupBy(
    inIds(
      sqlite,
      `SELECT * FROM regulatory_consent_regarding WHERE ${IN('consent_id')} ORDER BY consent_id, ord`,
      kids,
    ),
    (r) => r.consent_id,
  );
  const pvs = groupBy(
    inIds(
      sqlite,
      `SELECT * FROM regulatory_consent_policy_versions WHERE ${IN('consent_id')} ORDER BY consent_id, ord`,
      kids,
    ),
    (r) => r.consent_id,
  );
  const rules = groupBy(
    inIds(sqlite, `SELECT * FROM regulatory_consent_rule_ids WHERE ${IN('consent_id')} ORDER BY consent_id, ord`, kids),
    (r) => r.consent_id,
  );
  const hist = groupBy(
    inIds(sqlite, `SELECT * FROM regulatory_consent_history WHERE ${IN('consent_id')} ORDER BY consent_id, ord`, kids),
    (r) => r.consent_id,
  );
  const revs = new Map(
    inIds(sqlite, `SELECT * FROM regulatory_consent_revocations WHERE ${IN('consent_id')}`, kids).map((r) => [
      r.consent_id,
      r,
    ]),
  );
  return rows.map((row) => {
    const policyVersions = pvs(row.id).map((p) => p.policy_version_id);
    const actor = (p) =>
      row[`${p}_kind`] === null
        ? null
        : {
            kind: row[`${p}_kind`],
            userId: row[`${p}_id`],
            name: row[`${p}_name`],
            ...(row[`${p}_kind`] === 'club_user' ? { orgId: row[`${p}_org_id`] } : {}),
            ...(p === 'granted_by' && row.granted_by_signatory ? { signatory: true } : {}),
          };
    const rv = revs.get(row.id);
    return {
      id: row.id,
      kind: row.kind,
      contextId: row.context_id,
      agentUserId: row.agent_user_id,
      agencyOrgId: row.agency_org_id,
      partyRole: row.party_role,
      subject: { kind: row.subject_kind, id: row.subject_id },
      regarding: regarding(row.id).map((r) => r.party_role),
      status: row.status,
      requestedAt: row.requested_at,
      requestedBy: byOfRow(row, 'requested_by'),
      grantedAt: row.granted_at,
      grantedBy: actor('granted_by'),
      declinedAt: row.declined_at,
      declinedBy: actor('declined_by'),
      particulars: {
        fullParticularsProvided: row.full_particulars_provided === 1,
        legalAdviceOffered: row.legal_advice_offered === 1,
        proposedFeeDisclosed: row.proposed_fee_disclosed === 1,
        acknowledged:
          row.acknowledged_at === null ? null : { particulars: true, legalAdvice: true, at: row.acknowledged_at },
      },
      policyVersions,
      ruleIds: rules(row.id).map((r) => r.rule_id),
      keys: Object.fromEntries(
        CONSENT_KEY_SLOTS.filter((s) => row[`${s}_key`] !== null).map((s) => [
          s,
          { key: row[`${s}_key`], fp: row[`${s}_fp`] },
        ]),
      ),
      ...revOfRow(row),
      history: hist(row.id).map((h) => ({
        id: h.id,
        at: h.at,
        action: h.action,
        by: byOfRow(h),
        detail:
          h.action === 'regulatory_consent_requested'
            ? { partyRole: row.party_role, kind: row.kind, policyVersions }
            : h.action === 'regulatory_consent_granted'
              ? { partyRole: row.party_role, policyVersions }
              : h.action === 'regulatory_consent_declined'
                ? { partyRole: row.party_role }
                : { consentId: row.id, partyRole: row.party_role },
      })),
      revocation: rv
        ? {
            id: rv.id,
            at: rv.revoked_at,
            by: {
              kind: rv.by_kind,
              userId: rv.by_id,
              name: rv.by_name,
              ...(rv.by_kind === 'club_user' ? { orgId: rv.by_org_id } : {}),
            },
          }
        : null,
    };
  });
}

// ------------------------------------------------------------------ whole-domain read (the test suites)
export const complianceRecordsLive = (sqlite) => migrationApplied(sqlite, COMPLIANCE_RECORDS_MIGRATION);
/** A context with its evaluations; a consent ledger with its revocation rows. */
function readAll(sqlite) {
  const contexts = decodeContexts(sqlite, sqlite.prepare('SELECT * FROM compliance_contexts ORDER BY rowid').all());
  const evs = groupBy(
    decodeEvaluations(
      sqlite,
      sqlite.prepare('SELECT * FROM compliance_evaluations ORDER BY context_id, position').all(),
    ),
    (e) => e.contextId,
  );
  const consents = decodeConsents(sqlite, sqlite.prepare('SELECT * FROM regulatory_consents ORDER BY rowid').all());
  return {
    complianceContexts: contexts.map(({ lastEvaluation: _l, evaluationCount: _n, ...c }) => ({
      ...c,
      evaluations: evs(c.id).map(({ evaluationId: _i, contextId: _c, position: _p, ...e }) => e),
    })),
    regulatoryReviews: decodeReviews(
      sqlite,
      sqlite.prepare('SELECT * FROM regulatory_reviews ORDER BY rowid').all(),
    ).map(({ snapshot, ...r }) => ({
      ...r,
      snapshot: snapshot && {
        outcome: snapshot.outcome,
        evaluationId: snapshot.evaluationId ?? null,
        evaluatedAt: snapshot.evaluatedAt ?? null,
      },
    })),
    regulatoryConsents: consents.flatMap(({ revocation, ...k }) => [
      k,
      ...(revocation
        ? [{ id: revocation.id, kind: 'revocation', of: k.id, at: revocation.at, by: revocation.by }]
        : []),
    ]),
  };
}
/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const COMPLIANCE_RECORDS_RECORDS = {
  names: COMPLIANCE_RECORDS_COLLECTIONS,
  read(sqlite) {
    return complianceRecordsLive(sqlite) ? readAll(sqlite) : null;
  },
};
const playerRefCount = (sqlite, sql) => sqlite.prepare(sql).get().n;
export const unresolvedPlayerReferences = (sqlite) =>
  complianceRecordsLive(sqlite)
    ? {
        complianceRecords: playerRefCount(
          sqlite,
          "SELECT count(*) AS n FROM compliance_context_parties x WHERE subject_kind = 'player' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.subject_id)",
        ),
      }
    : null;

// ------------------------------------------------------------------ the repository
const WRITES = new Set([
  'create',
  'recordEvaluation',
  'forgetPlayer',
  'flagPolicyChange',
  'recordAct',
  'addParty',
  'declareRepresentation',
  'withdrawRepresentation',
  'decideRepresentation',
  'resolveFacts',
  'rejectByReview',
  'project',
  'close',
  'clearReEvaluation',
  'start',
  'resolve',
  'cancel',
  'markSuperseded',
  'grant',
  'decline',
  'revoke',
]);
const OPEN = "status IN ('PENDING','IN_REVIEW')";
const SQLITE_CONSTRAINT = 19;
/**
 * `createComplianceRecordsRepository({ sqlite, unit, now, log })`: `contexts`, `reviews` and `consents`, each with its
 * whole-record `create`, its named acts and its queries, plus `reads` (the queries alone) and `forgetPlayer` (an
 * account deletion).
 *
 * An act is `act(id, input, bookkeeping)`: its own writes, then the bookkeeping — the history entries (only ever
 * inserted, each reading back as written) and the rev bump (`bump: { at, by: { id | userId, name } }`) — in one
 * operation, returning the stored record. `recordAct(id, bookkeeping)` is the bookkeeping alone.
 */
export function createComplianceRecordsRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the compliance records repository needs a SQLite connection (node:sqlite)');
  const operation = operationOn(sqlite, unit);
  const {
    q,
    assign,
    guarded,
    refusal: refuse,
    invalid,
    rowStep,
    readsBackAsWritten,
    newRecord,
  } = writeKit(sqlite, 'COMPLIANCE_RECORDS');
  const s = () => statements(sqlite);
  /** One write of a record's rows: a missing referenced row and a taken key are named as such, any other constraint failure as junk. */
  const step = (table, id, part, fn) => {
    try {
      return fn();
    } catch (e) {
      if (e?.code !== 'ERR_SQLITE_ERROR' || (e.errcode & 0xff) !== SQLITE_CONSTRAINT) throw e;
      if (/FOREIGN KEY/.test(String(e.message)))
        throw refuse('REFERENCE_MISSING', `${table} ${id} names a row that is not there (${part}: ${e.message})`);
      if (/UNIQUE|PRIMARY KEY/.test(String(e.message)))
        throw refuse('DUPLICATE', `${table} ${id} ${part}: ${e.message}`);
      return rowStep(table, id, part, () => {
        throw e;
      });
    }
  };
  const setRow = (table, keys, cols) =>
    q(
      `UPDATE ${table} SET ${assign(cols)} WHERE ${Object.keys(keys)
        .map((c) => `${c} = @key_${c}`)
        .join(' AND ')}`,
    ).run({
      ...Object.fromEntries(Object.entries(cols).map(([c, v]) => [c, v === undefined ? null : v])),
      ...Object.fromEntries(Object.entries(keys).map(([c, v]) => [`key_${c}`, v])),
    });
  const nextOrd = (table, owner, id) =>
    q(`SELECT COALESCE(MAX(ord) + 1, 0) AS n FROM ${table} WHERE ${owner} = ?`).get(id).n;
  const one =
    (decoder, sql) =>
    (...args) => {
      const row = q(sql).get(...args);
      return row ? deepFreeze(decoder(sqlite, [row])[0]) : null;
    };
  const many =
    (decoder, sql) =>
    (...args) =>
      decoder(sqlite, q(sql).all(...args)).map(deepFreeze);
  const latestEvaluationId = (ctxId) =>
    q('SELECT id FROM compliance_evaluations WHERE context_id = ? ORDER BY position DESC LIMIT 1').get(ctxId)?.id ??
    null;
  const evaluationOf = (id) => {
    const row = q('SELECT * FROM compliance_evaluations WHERE id = ?').get(id);
    return row ? decodeEvaluations(sqlite, [row])[0] : null;
  };
  /** A whole record handed to `create` must read back as it was written. */
  const created = (table, byId, written) => {
    const stored = byId(written.id);
    readsBackAsWritten(table, written.id, written, stored);
    return stored;
  };
  /** Insert a history entry and read it back: a detail worked out on read must repeat what the writer said. */
  const historyWith = (table, ownerCol, byId, insert) => (id, h) => {
    if (!isPlainObject(h)) FAIL(`${table} ${id}: a history entry must be an object (got ${describe(h)})`);
    step(table, id, `history ${h.id}`, () => insert(id, nextOrd(table, ownerCol, id), h));
    readsBackAsWritten(
      table,
      h.id,
      h,
      byId(id).history.find((x) => x.id === h.id),
    );
  };
  const bumpOf =
    (table) =>
    (id, { at, by = null }) =>
      q(`UPDATE ${table} SET rev = rev + 1, rev_at = @at, rev_by_id = @uid, rev_by_name = @name WHERE id = @id`).run({
        id,
        at,
        uid: by?.id ?? by?.userId ?? null,
        name: by?.name ?? null,
      });
  /** Named acts on one table, each `act(id, input, bookkeeping)`, and `recordAct(id, bookkeeping)`. */
  const actsOn = ({ table, byId, history }, defs) => {
    const bump = bumpOf(table);
    const run = (name, id, fn, { bump: b = null, history: entries = [] } = {}) =>
      operation(() => {
        if (!q(`SELECT 1 FROM ${table} WHERE id = ?`).get(id))
          throw refuse('NOT_FOUND', `${table} ${id} is not a record of the repository`);
        step(table, id, name, fn);
        if (b) bump(id, b);
        for (const h of listOf(entries, `${table} ${id} history`)) history(id, h);
        return byId(id);
      });
    return {
      ...Object.fromEntries(
        Object.entries(defs).map(([name, fn]) => [
          name,
          (id, input = {}, bookkeeping = {}) => run(name, id, () => fn(id, input), bookkeeping),
        ]),
      ),
      recordAct: (id, bookkeeping = {}) => run('recordAct', id, () => {}, bookkeeping),
    };
  };

  // ---- contexts
  const contextById = one(decodeContexts, 'SELECT * FROM compliance_contexts WHERE id = ?');
  const CTX = 'compliance_contexts';
  const contextHistory = historyWith('compliance_context_history', 'context_id', contextById, (id, ord, h) =>
    writeContextEntry(s(), id, ord, h, latestEvaluationId(id)),
  );
  const repMove = (id, repId, where, cols, what) =>
    guarded(
      'compliance_context_representations',
      { context_id: id, id: repId },
      where,
      cols,
      `compliance_context_representations ${repId} of ${CTX} ${id} ${what}`,
    );
  const replaceProjection = (id, parties, representations) => {
    q('DELETE FROM compliance_context_parties WHERE context_id = ?').run(id);
    listOf(parties, `${CTX} ${id} parties`).forEach((p, i) => s().partyIns.run(...contextPartyRow(id, i, p)));
    q('DELETE FROM compliance_context_representations WHERE context_id = ?').run(id);
    listOf(representations, `${CTX} ${id} representations`).forEach((r, i) =>
      s().repIns.run(...contextRepRow(id, i, r)),
    );
  };
  const contexts = {
    /** A new context, whole, with its opening history (an evaluation is recorded with recordEvaluation). An existing id is refused. */
    create: (c) =>
      operation(() => {
        newRecord(CTX, (id) => !!q('SELECT 1 FROM compliance_contexts WHERE id = ?').get(id), c);
        const entries = listOf(c.history, `${CTX} ${c.id} history`);
        if (entries.some((h) => h?.action === 'compliance_context_evaluated' || h?.detail?.status === 'verified'))
          FAIL(`${CTX} ${c.id}: an evaluation is recorded with recordEvaluation`);
        step(CTX, c.id, 'rows', () => writeContext(s(), c));
        for (const h of entries)
          step(CTX, c.id, `history ${h?.id}`, () =>
            writeContextEntry(s(), c.id, nextOrd('compliance_context_history', 'context_id', c.id), h, null),
          );
        const { lastEvaluation: _l, evaluationCount: _n, ...written } = c;
        return created(CTX, contextById, written);
      }),
    ...actsOn(
      { table: CTX, byId: contextById, history: contextHistory },
      {
        addParty: (id, { party }) =>
          s().partyIns.run(...contextPartyRow(id, nextOrd('compliance_context_parties', 'context_id', id), party)),
        /** The agent's declaration (verified, or pending its review). */
        declareRepresentation: (id, { representation }) =>
          s().repIns.run(
            ...contextRepRow(id, nextOrd('compliance_context_representations', 'context_id', id), representation),
          ),
        /** A withdrawal is final. */
        withdrawRepresentation: (id, { representationId, at }) =>
          repMove(
            id,
            representationId,
            "status <> 'withdrawn'",
            { status: 'withdrawn', withdrawn_at: at },
            'is already withdrawn',
          ),
        /** An attributed reviewer decided a declaration awaiting review: verified by that review (no act by the agent), or withdrawn. */
        decideRepresentation: (id, { representationId, approved, reviewId, at }) =>
          repMove(
            id,
            representationId,
            "status = 'pending_review'",
            approved
              ? { status: 'verified', declared_only: 0, verified_by_review_id: reviewId, verified_at: at }
              : { status: 'withdrawn', withdrawn_at: at },
            'is not awaiting review',
          ),
        /** Facts an approved review settled (each once). */
        resolveFacts: (id, { codes }) => {
          for (const code of listOf(codes, `${CTX} ${id} codes`)) {
            if (!q('SELECT 1 FROM compliance_context_resolved_facts WHERE context_id = ? AND code = ?').get(id, code))
              s().factIns.run(id, nextOrd('compliance_context_resolved_facts', 'context_id', id), code);
          }
        },
        rejectByReview: (id, { at }) => setRow(CTX, { id }, { review_rejected_at: at }),
        /** The evaluation input, rebuilt from a transaction's own rows (the transaction is the truth; this is its projection). */
        project: (id, { parties, representations }) => replaceProjection(id, parties, representations),
        /** A closed context does not reopen. */
        close: (id, { at }) =>
          guarded(
            CTX,
            { id },
            "status = 'open'",
            { status: 'closed', closed_at: at },
            `${CTX} ${id} is already closed`,
          ),
        clearReEvaluation: (id) => setRow(CTX, { id }, { re_evaluation_pending: 0 }),
      },
    ),
    /**
     * Record an evaluation of the context (append-only): the result, the identity of its inputs and the history entry that
     * says so, at once; the re-evaluation flag clears. Returns the stored evaluation (decoded, with its id).
     */
    recordEvaluation: (id, result, snapshotOf, entry) =>
      operation(() => {
        if (!q('SELECT 1 FROM compliance_contexts WHERE id = ?').get(id))
          throw refuse('NOT_FOUND', `${CTX} ${id} is not a record of the repository`);
        if (!isPlainObject(result) || !isPlainObject(snapshotOf))
          FAIL(`compliance_evaluations ${id}: an evaluation is an engine result and the identity of its inputs`);
        const position =
          (q('SELECT MAX(position) AS p FROM compliance_evaluations WHERE context_id = ?').get(id).p ?? 0) + 1;
        const evId = step('compliance_evaluations', `${id}#${position}`, 'rows', () =>
          writeEvaluation(s(), id, position, result, snapshotOf),
        );
        const stored = evaluationOf(evId);
        const { outcome, reasons, consentsOutstanding, policyVersions, evaluatedAt, inputHash } = result;
        readsBackAsWritten(
          'compliance_evaluations',
          evId,
          { outcome, reasons, consentsOutstanding, policyVersions, evaluatedAt, inputHash, snapshotOf },
          stored,
        );
        contextHistory(id, entry);
        setRow(CTX, { id }, { re_evaluation_pending: 0 });
        return deepFreeze(stored);
      }),
    byId: contextById,
    /** One evaluation row, decoded (a transaction's snapshot names one), or null. */
    evaluationById: (id) => {
      if (typeof id !== 'string') return null;
      const e = evaluationOf(id);
      return e ? deepFreeze(e) : null;
    },
    /** The agent's own contexts in the agency, oldest first. */
    forAgent: many(
      decodeContexts,
      'SELECT * FROM compliance_contexts WHERE agency_org_id = ? AND agent_user_id = ? ORDER BY rowid',
    ),
    /** The agent's context opened under this client key, or null. */
    byCreateKey: one(
      decodeContexts,
      'SELECT * FROM compliance_contexts WHERE agency_org_id = ? AND agent_user_id = ? AND create_key = ?',
    ),
    /** The agency's open contexts other than `exceptId`, oldest first (connected agents in the same transaction). */
    openForAgencyExcept: many(
      decodeContexts,
      "SELECT * FROM compliance_contexts WHERE agency_org_id = ? AND status = 'open' AND id <> ? ORDER BY rowid",
    ),
    /** The agency's contexts, oldest first (the agency audit). */
    forAgency: many(decodeContexts, 'SELECT * FROM compliance_contexts WHERE agency_org_id = ? ORDER BY rowid'),
    /**
     * A published version of `jurisdiction`: flag every open context of that jurisdiction whose latest evaluation did not
     * use it (never re-verdicted), each with its history entry. Returns the flagged ids.
     */
    flagPolicyChange: (jurisdiction, policyVersionId, entryOf) =>
      operation(() => {
        const ids = q(`SELECT c.id FROM compliance_contexts c
        JOIN compliance_context_jurisdictions j ON j.context_id = c.id AND j.member_association = ?
        JOIN compliance_evaluations e ON e.context_id = c.id AND e.position = (SELECT MAX(position) FROM compliance_evaluations WHERE context_id = c.id)
        WHERE c.status = 'open' AND NOT EXISTS (SELECT 1 FROM compliance_evaluation_policy_versions v WHERE v.evaluation_id = e.id AND v.policy_version_id = ?)
        ORDER BY c.rowid`)
          .all(jurisdiction, policyVersionId)
          .map((r) => r.id);
        for (const id of ids) {
          setRow(CTX, { id }, { re_evaluation_pending: 1 });
          contextHistory(id, entryOf());
        }
        return ids;
      }),
    /** Every evaluation's outcome, counted (the T&S metrics). */
    outcomeCounts: () =>
      Object.fromEntries(
        q('SELECT outcome, COUNT(*) AS n FROM compliance_evaluations GROUP BY outcome ORDER BY outcome')
          .all()
          .map((r) => [r.outcome, r.n]),
      ),
  };

  // ---- reviews
  const reviewById = one(decodeReviews, 'SELECT * FROM regulatory_reviews WHERE id = ?');
  const RV = 'regulatory_reviews';
  const reviewHistory = historyWith('regulatory_review_history', 'review_id', reviewById, (id, ord, h) =>
    s().rvHist.run(reviewEntry(id, ord, h)),
  );
  const reviewMove = (id, where, cols, what) => guarded(RV, { id }, where, cols, `${RV} ${id} ${what}`);
  const reviews = {
    /**
     * A new review, whole, with its history; a reconsideration names the decided review it `supersedes` (once). The
     * snapshot names an evaluation of the review's own context. An existing id is refused.
     */
    create: (r) =>
      operation(() => {
        newRecord(RV, (id) => !!q('SELECT 1 FROM regulatory_reviews WHERE id = ?').get(id), r);
        step(RV, r.id, 'rows', () => writeReview(s(), r));
        for (const h of listOf(r.history, `${RV} ${r.id} history`))
          step(RV, r.id, `history ${h?.id}`, () =>
            s().rvHist.run(reviewEntry(r.id, nextOrd('regulatory_review_history', 'review_id', r.id), h)),
          );
        return created(RV, reviewById, r);
      }),
    ...actsOn(
      { table: RV, byId: reviewById, history: reviewHistory },
      {
        start: (id, { at, by }) =>
          reviewMove(
            id,
            "status = 'PENDING'",
            {
              status: 'IN_REVIEW',
              started_at: at,
              started_by_id: by?.id,
              started_by_name: by?.name ?? null,
              started_by_role: by?.role,
            },
            'is not pending',
          ),
        /** A decision is final: the review takes its outcome, with the prior and resulting states and the evidence cited. */
        resolve: (id, { decision, key = null }) => {
          reviewMove(
            id,
            OPEN,
            {
              status: decision?.outcome,
              decided_at: decision?.at,
              ...decisionCols(decision),
              resolve_key: key?.key ?? null,
              resolve_fp: key?.fp ?? null,
            },
            'is not open',
          );
          listOf(decision?.evidenceRefs, `${RV} ${id} evidenceRefs`).forEach((ref, i) => s().rvRef.run(id, i, ref));
        },
        /** An open review is cancelled: by its context closing (no decision), or by a reviewer (a CANCELLED decision). */
        cancel: (id, { at, decision = null }) =>
          reviewMove(id, OPEN, { status: 'CANCELLED', decided_at: at, ...decisionCols(decision) }, 'is not open'),
        /** A decided review is superseded by the review naming it (created first); its decision is retained. */
        markSuperseded: (id) =>
          reviewMove(
            id,
            "status IN ('APPROVED','REJECTED') AND EXISTS (SELECT 1 FROM regulatory_reviews n WHERE n.supersedes_id = regulatory_reviews.id)",
            { status: 'SUPERSEDED' },
            'is not a decided review a newer one supersedes',
          ),
      },
    ),
    byId: reviewById,
    /** The open item for this facet of this profile, or null (one open item per subject). */
    openForFacet: one(
      decodeReviews,
      `SELECT * FROM regulatory_reviews WHERE kind = 'verification_facet' AND ${OPEN} AND subject_profile_id = ? AND subject_facet = ? AND subject_member_association IS ? LIMIT 1`,
    ),
    /** The open dispute item for this agreement, or null. */
    openForAgreement: one(
      decodeReviews,
      `SELECT * FROM regulatory_reviews WHERE kind = 'representation_dispute' AND ${OPEN} AND subject_agreement_id = ? LIMIT 1`,
    ),
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
        ORDER BY rank, requested_at, rowid LIMIT @n`).all({
        status,
        r: after?.[0] ?? null,
        t: after?.[1] ?? null,
        i: after?.[2] ?? null,
        n: limit + 1,
      });
      return {
        rows: decodeReviews(sqlite, rows).map((record, i) => ({
          key: [rows[i].rank, rows[i].requested_at, rows[i].rid],
          record: deepFreeze(record),
        })),
      };
    },
    /** The T&S metrics: counts by status and kind, and the median request-to-decision time. */
    metrics: () => {
      const byStatus = Object.fromEntries(REVIEW_STATUSES.map((st0) => [st0, 0]));
      for (const r of q('SELECT status, COUNT(*) AS n FROM regulatory_reviews GROUP BY status').all())
        byStatus[r.status] = r.n;
      const byKind = Object.fromEntries(REVIEW_KINDS.map((k) => [k, 0]));
      for (const r of q('SELECT kind, COUNT(*) AS n FROM regulatory_reviews GROUP BY kind').all()) byKind[r.kind] = r.n;
      const n = q(
        'SELECT COUNT(*) AS n FROM regulatory_reviews WHERE decided_at IS NOT NULL AND requested_at IS NOT NULL',
      ).get().n;
      const median = n
        ? q(
            'SELECT decided_at - requested_at AS d FROM regulatory_reviews WHERE decided_at IS NOT NULL ORDER BY d LIMIT 1 OFFSET ?',
          ).get(Math.floor(n / 2)).d
        : null;
      return { byStatus, byKind, medianDurationMs: median };
    },
    /** The newest `limit` decision entries (started, resolved, cancelled, superseded) with their review, newest first. */
    decisionEntries: (limit) => {
      const rows = q(
        "SELECT review_id, id FROM regulatory_review_history WHERE action <> 'regulatory_review_requested' ORDER BY at DESC, id DESC LIMIT ?",
      ).all(limit);
      const recs = new Map(
        decodeReviews(
          sqlite,
          inIds(
            sqlite,
            `SELECT * FROM regulatory_reviews WHERE ${IN('id')}`,
            rows.map((r) => r.review_id),
          ),
        ).map((r) => [r.id, deepFreeze(r)]),
      );
      return rows.map((r) => ({
        review: recs.get(r.review_id),
        entry: recs.get(r.review_id).history.find((h) => h.id === r.id),
      }));
    },
    /** The context's open items, oldest first (a context closing cancels them). */
    openForContext: many(
      decodeReviews,
      `SELECT * FROM regulatory_reviews WHERE subject_context_id = ? AND ${OPEN} ORDER BY rowid`,
    ),
  };

  // ---- consents
  const consentById = one(decodeConsents, 'SELECT * FROM regulatory_consents WHERE id = ?');
  const CS = 'regulatory_consents';
  const consentHistory = historyWith('regulatory_consent_history', 'consent_id', consentById, (id, ord, h) =>
    s().csHist.run({ id: h.id, owner: id, ord, at: h.at, ...byCols(h.by), action: h.action }),
  );
  const idTaken = (id) =>
    !!q(
      'SELECT 1 FROM regulatory_consents WHERE id = ? UNION ALL SELECT 1 FROM regulatory_consent_revocations WHERE id = ?',
    ).get(id, id);
  /** The stored status changes once (requested → granted | declined), with the answer's key. */
  const answer = (id, cols, slot, key) =>
    guarded(
      CS,
      { id },
      "status = 'requested'",
      { ...cols, [`${slot}_key`]: key?.key ?? null, [`${slot}_fp`]: key?.fp ?? null },
      `${CS} ${id} is not awaiting an answer`,
    );
  const consents = {
    /** A new consent, whole and requested, with its history. An existing id is refused. */
    create: (k) =>
      operation(() => {
        newRecord(CS, idTaken, k);
        if (k.status !== 'requested') FAIL(`${CS} ${k.id}: a consent is requested first`);
        step(CS, k.id, 'rows', () => writeConsent(s(), k));
        for (const h of listOf(k.history, `${CS} ${k.id} history`))
          step(CS, k.id, `history ${h?.id}`, () =>
            s().csHist.run({
              id: h?.id,
              owner: k.id,
              ord: nextOrd('regulatory_consent_history', 'consent_id', k.id),
              at: h?.at,
              ...byCols(h?.by),
              action: h?.action,
            }),
          );
        return created(CS, consentById, k);
      }),
    ...actsOn(
      { table: CS, byId: consentById, history: consentHistory },
      {
        /** The party grants, acknowledging the particulars and the offer of legal advice (`by.signatory` for a club's signatory). */
        grant: (id, { at, by, key = null }) =>
          answer(
            id,
            { status: 'granted', ...answerCols('granted', at, by, { signatory: true }), acknowledged_at: at },
            'grant',
            key,
          ),
        decline: (id, { at, by, key = null }) =>
          answer(id, { status: 'declined', ...answerCols('declined', at, by) }, 'decline', key),
        /** A granted consent is revoked once: the revocation is its own row; the granted row is never edited (only its key). */
        revoke: (id, { revocation: rv, key = null }) => {
          guarded(
            CS,
            { id },
            "status = 'granted'",
            { revoke_key: key?.key ?? null, revoke_fp: key?.fp ?? null },
            `${CS} ${id}: only a granted consent can be revoked`,
          );
          if (idTaken(rv?.id)) throw refuse('DUPLICATE', `${rv.id} already exists`);
          if (rv?.by?.kind !== 'player' && rv?.by?.kind !== 'club_user')
            FAIL(`regulatory_consent_revocations ${rv?.id}: revoked by the party (a player or a club user)`);
          s().revocation.run(
            rv.id,
            id,
            rv.at,
            rv.by.kind,
            rv.by.userId ?? null,
            rv.by.name ?? null,
            rv.by.orgId ?? null,
          );
        },
      },
    ),
    byId: consentById,
    /** The context's consents, oldest first (the engine's input, the transaction's projection). */
    forContext: many(decodeConsents, 'SELECT * FROM regulatory_consents WHERE context_id = ? ORDER BY rowid'),
    /** The consents asking this party (a player or a club), oldest first. */
    forSubject: many(
      decodeConsents,
      'SELECT * FROM regulatory_consents WHERE subject_kind = ? AND subject_id = ? ORDER BY rowid',
    ),
    /** The agent's consents in the agency, oldest first. */
    forAgent: many(
      decodeConsents,
      'SELECT * FROM regulatory_consents WHERE agency_org_id = ? AND agent_user_id = ? ORDER BY rowid',
    ),
    /** The agency's consents, oldest first (the agency audit). */
    forAgency: many(decodeConsents, 'SELECT * FROM regulatory_consents WHERE agency_org_id = ? ORDER BY rowid'),
    /** The consent the agent requested in the context under this client key, or null. */
    byRequestKey: one(
      decodeConsents,
      'SELECT * FROM regulatory_consents WHERE context_id = ? AND agent_user_id = ? AND request_key = ?',
    ),
    /** How long each answered consent of a transaction's context waited for its answer (the transaction metrics), in ms. */
    transactionAnswerWaits: () =>
      q(`SELECT COALESCE(c.granted_at, c.declined_at) - c.requested_at AS d FROM regulatory_consents c JOIN compliance_contexts x ON x.id = c.context_id
      WHERE x.origin = 'transaction' AND (c.granted_at IS NOT NULL OR c.declined_at IS NOT NULL) ORDER BY d`)
        .all()
        .map((r) => r.d),
    /** The T&S metrics: dual-representation consents requested, granted, declined, revoked. */
    metrics: () => {
      const r =
        q(`SELECT COUNT(*) AS requested, SUM(CASE WHEN c.status = 'granted' AND v.id IS NULL THEN 1 ELSE 0 END) AS granted, SUM(CASE WHEN c.status = 'declined' THEN 1 ELSE 0 END) AS declined, SUM(CASE WHEN v.id IS NOT NULL THEN 1 ELSE 0 END) AS revoked
        FROM regulatory_consents c LEFT JOIN regulatory_consent_revocations v ON v.consent_id = c.id WHERE c.kind = 'dual_representation'`).get();
      return { requested: r.requested, granted: r.granted ?? 0, declined: r.declined ?? 0, revoked: r.revoked ?? 0 };
    },
  };

  /**
   * A player's account removal: every context naming them keeps the party as an id-only removed party (with its history
   * entry) and loses the player's name from its history; every consent asking them, its answers, revocation and history
   * lose the player's id and name. `entryOf()` gives the context's history entry.
   */
  const forgetPlayer = (playerId, at, entryOf) =>
    operation(() => {
      const touched = q(
        "SELECT DISTINCT context_id FROM compliance_context_parties WHERE subject_kind = 'player' AND subject_id = ? AND removed = 0 ORDER BY context_id",
      )
        .all(playerId)
        .map((r) => r.context_id);
      for (const id of touched) {
        q(
          "UPDATE compliance_context_parties SET removed = 1, removed_at = ? WHERE context_id = ? AND subject_kind = 'player' AND subject_id = ? AND removed = 0",
        ).run(at, id, playerId);
        contexts.recordAct(id, { history: [entryOf()] });
        q(
          "UPDATE compliance_context_history SET by_id = NULL, by_name = NULL WHERE context_id = ? AND by_kind = 'player'",
        ).run(id);
      }
      const SUB = "SELECT id FROM regulatory_consents WHERE subject_kind = 'player' AND subject_id = ?";
      q(`UPDATE regulatory_consents SET granted_by_id = CASE WHEN granted_by_kind = 'player' THEN NULL ELSE granted_by_id END, granted_by_name = CASE WHEN granted_by_kind = 'player' THEN NULL ELSE granted_by_name END,
      declined_by_id = CASE WHEN declined_by_kind = 'player' THEN NULL ELSE declined_by_id END, declined_by_name = CASE WHEN declined_by_kind = 'player' THEN NULL ELSE declined_by_name END WHERE id IN (${SUB})`).run(
        playerId,
      );
      q(
        `UPDATE regulatory_consent_revocations SET by_id = NULL, by_name = NULL WHERE by_kind = 'player' AND consent_id IN (${SUB})`,
      ).run(playerId);
      q(
        `UPDATE regulatory_consent_history SET by_id = NULL, by_name = NULL WHERE by_kind = 'player' AND consent_id IN (${SUB})`,
      ).run(playerId);
      return touched;
    });

  const readOnly = (o) => Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => !WRITES.has(k))));
  const repo = { contexts, reviews, consents };
  const counters = {
    complianceContexts: q('SELECT COUNT(*) AS n FROM compliance_contexts'),
    regulatoryReviews: q('SELECT COUNT(*) AS n FROM regulatory_reviews'),
    regulatoryConsents: q('SELECT COUNT(*) AS n FROM regulatory_consents'),
  };
  return {
    ...repo,
    forgetPlayer,
    /** The queries alone, for modules that must not write. */
    reads: Object.freeze(Object.fromEntries(Object.entries(repo).map(([k, v]) => [k, readOnly(v)]))),
    attach() {
      if (!complianceRecordsLive(sqlite))
        throw new Error(
          `the compliance records repository needs ${COMPLIANCE_RECORDS_MIGRATION} recorded; it never imports an in-memory array`,
        );
      return { counts: this.counts() };
    },
    counts() {
      return Object.fromEntries(COMPLIANCE_RECORDS_COLLECTIONS.map((n) => [n, counters[n].get().n]));
    },
    pending: () => 0,
    exportAll() {
      return COMPLIANCE_RECORDS_RECORDS.read(sqlite);
    },
    log,
    now,
  };
}
