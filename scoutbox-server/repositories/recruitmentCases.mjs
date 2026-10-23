/**
 * Recruitment cases (the M12 case with its M17 Room facet, M23 decision draft, M27 transaction handoff and M13 budget),
 * room comments, room snapshots, room decisions and room evidence states — migration plan step S8b
 * (docs/architecture/s8b-readiness-review.md, the design independently accepted at 4d2c74b; plan §D.9; approved for
 * the player references by the Founder's explicit Q8a answer of 23 October 2026, "Approve tolerant (Recommended)").
 *
 * Owns twenty-five tables (and, since migration 0016, the `case_id` REAL keys of `recruitment_requests` and `trials` —
 * Q7b's conversion — and the broadened owner CHECK of the ONE shared `idempotency_keys` table) and five read-only
 * collection views:
 *
 *   recruitment_cases, case_room_tags, case_assignments, case_tasks, case_approvals,
 *   case_history, case_request_links, case_trial_links, case_decision_drafts,
 *   case_decision_draft_reason_codes, case_decision_draft_evidence_refs,
 *   case_transaction_handoffs, case_budget_scenarios, case_budget_lines,
 *   case_budget_fx_assumptions, case_budget_actuals                                → db.recruitmentCases
 *   room_comments, room_comment_mentions                                           → db.roomComments
 *   room_snapshots, room_snapshot_source_refs                                      → db.roomSnapshots
 *   room_decisions, room_decision_reason_codes, room_decision_evidence_refs,
 *   room_decision_assessment_ids                                                   → db.roomDecisions
 *   room_evidence_states                                                           → db.roomEvidenceState
 *   idempotency_keys (the `keys` of the drafts, the handoffs and the formal decisions, beside the S8a rows)
 *
 * WHAT THE ROWS ARE. The five collections were JSON blobs every build since M12/M17 wrote and mutated IN PLACE from
 * m12/scouting.mjs, m13/planning.mjs, m17/rooms.mjs, m23/decisionRoutes.mjs, m27/index.mjs and server.mjs (the
 * deletion unit's tombstone). This step keeps that contract exactly as S8a-core did for requests and trials: the five
 * views are read-only ARRAYS (push/splice/assignment refused) whose elements are the plain, mutable records the routes
 * hold; every in-place change — a status move, a pushed history entry, a task, a budget scenario, the draft set and
 * nulled, the handoff, a comment edit or tombstone, an evidence state overwrite, a decision superseded — is detected and
 * written by the next save's flush, so each row lands in the save that carried its blob before; new records enter
 * through `addCase` / `addComment` / `addSnapshot` / `addDecision` / `addEvidenceState` (the former `push` sites) and
 * the finalize route's transport-failure splice through `removeDecision`.
 *
 * LOSSLESS, AT EVERY LEVEL — the S8a engine (repositories/recruitment.mjs, shared here): the writers' literals key for
 * key; every scalar a column of the writer's nullability (no vocabulary or length CHECK — a storage step changes no
 * product rule; the NOT NULL columns are the identifiers the keys need); every known nested object columns of the same
 * row; every list a child table keyed (owner…, position) in list order — a list of strings in a `scalar` column, a
 * non-matching entry in `raw_json`, so a duplicate link entry or tag is kept in its position and never deduplicated;
 * absent keys in `absent_keys_json` (dotted), off-type values in `offtype_json`, unknown own fields (a prototype-named
 * one included) in `extra_json`. The two history literals (`{byKind, byId, byName}` and `{by: {kind, userId, name}}`)
 * are mapped side by side. The decision's full `snapshot` copy and the snapshot's `note` are stored as written. The
 * `keys` of a draft, a handoff or a formal decision follow the S8a rule: a value act carrying a string key is a row of
 * idempotency_keys (owner the child table, owner_id the child record's id), everything else is held on the row.
 *
 * REFERENCES — THE APPROVED SCOPE (§2, §3, §9 of the review; Q8a):
 *   player_id (recruitment_cases, room_snapshots, room_decisions, case_transaction_handoffs)
 *                             NO key, TOLERANT (Q8a, 23 October 2026): a live id resolves, a retained id resolves to the
 *                             retained record, a historically missing id is preserved and counted — never refused,
 *                             never given a fabricated account, never deleted.
 *   org_id                    REFERENCES orgs RESTRICT (every table that carries one).
 *   owner_user_id, room_lead_scout_user_id (nullable), decision_by_user_id, case_assignments.user_id,
 *   room_comments.author_user_id          REFERENCES org_users RESTRICT (staff are never deleted).
 *   recruitment_requests.case_id, trials.case_id    REFERENCES recruitment_cases RESTRICT (rebuilt by 0016).
 *   case_request_links.request_id → recruitment_requests RESTRICT; case_trial_links.trial_id → trials RESTRICT.
 *   room_*.room_id            REFERENCES recruitment_cases RESTRICT (independent collections: a retained row blocks a
 *                             case removal, named at the preflight with its table).
 *   case_history.case_id      RESTRICT (owned; removed explicitly before its owner, R1); every other child CASCADE.
 *   decision chain, client keys, vacancy/evidence/assessment/signing/transaction/agency ids: plain ids checked in code.
 *   recruitment_cases_one_open_room          WITHDRAWN (§3): the routes keep their one-open-room rule.
 *
 * THE WRITE (review §6, corrected after the reviews of 57076a2 and 86342b8), one algorithm for the import, a restore, a
 * flush and a snapshot, every step inside the one transaction:
 *   P  preflight against the FINAL combined graph (every supplied collection as supplied, every omitted one as the
 *      retained rows; in a flush the mirrors): every link of every final case names a final request/trial
 *      (CASE_LINK_DANGLING); a case the write removes is named by no RETAINED independent row (CASE_STILL_REFERENCED,
 *      naming the table — recruitment_requests, trials, room_comments, room_snapshots, room_decisions,
 *      room_evidence_states; the owned children never block); every room row's roomId names a final case
 *      (ROOM_CASE_MISSING); the decision chain (DECISION_CHAIN_BROKEN); the organisation and staff keys named with ids
 *      (RECRUITMENT_CASES_ORG_MISSING / RECRUITMENT_CASES_USER_MISSING); the player references counted.
 *   A  the supplied (or changed) cases upserted by id (seq kept), their owned children rewritten in list order — the
 *      link rows excepted — with the polymorphic key rows of the previous draft/handoff removed first;
 *   R  release: the link rows of the cases this write supplies or prunes are gone (rewritten at C); the link rows of
 *      RETAINED cases naming a trial of the S8a departure set (or a pruned request) are MEMORISED verbatim and deleted;
 *   B  the accepted S8a phases (repositories/recruitment.mjs — its own hook, between this repository's two);
 *   C  the supplied cases' link rows in list order; the memorised rows back verbatim;
 *   D  the supplied room collections upserted, children in list order, the decision chain as plain ids;
 *   E  the channels (S7d, its own hook);
 *   F1 the rows a SUPPLIED room collection no longer lists (their key rows first) — before their case;
 *   F2 the S8a request prune (inside the recruitment hook's flush; in a snapshot its own call);
 *   F3 the cases no longer listed: for each departing owner, its case_history rows and the idempotency_keys rows of its
 *      owned draft/handoff explicitly, THEN the parent row (the CASCADE children follow);
 *   G  the final assertions, ids only: every link target present, the decision chain, foreign_key_check empty.
 * Nothing disables foreign keys, drops a constraint, depends on the input order or changes a product rule.
 *
 * TWO FAILURE CONTRACTS (the store's, unchanged): a failed ORDINARY save leaves the records as they are — memory is the
 * intended state — and the next save lands them once (change tracking reflects COMMITTED state only); an aborted UNIT
 * OF WORK rolls the tables back AND restores the five mirrors in place through the graph memento (every record, nested
 * object and array by identity: a held room facet, draft or history list reads the pre-unit value), the pending edits
 * made before the unit still pending.
 *
 * Whether the tables are authoritative is decided by the cutover record `0016_recruitment_cases` in `data_migrations`,
 * never by the tables existing. Refusals (RECRUITMENT_CASES_IMPORT_BLOCKED and the reference codes) name collections,
 * positions, tables and ids — never a name, a note, a body or a message.
 */
import { markView } from './readonly.mjs';
import { captureGraph, restoreGraph } from './memento.mjs';
import { migrationApplied } from './database.mjs';
import { EXTRA_CHECK, ABSENT_CHECK, JSON_CHECK, describe, isPlainObject, nonEmpty, tableExists, setOwn, clone, parseJson, ids, sqlType, columnsOf, childSpecs, encode, decodeLevel, rowMeta, metaOf, columnAdmits, toColumn, fromColumn, copyRecord, recruitmentLive, readRequests, readTrials, S8A_KEY_OWNERS } from './recruitment.mjs';

export const RECRUITMENT_CASES_MIGRATION = '0016_recruitment_cases';
/** `meta` key holding the cutover record: counts only, never data. */
export const RECRUITMENT_CASES_CUTOVER_META = 'recruitmentCasesCutover';
export const RECRUITMENT_CASES_COLLECTIONS = Object.freeze(['recruitmentCases', 'roomComments', 'roomSnapshots', 'roomDecisions', 'roomEvidenceState']);
/** The owner tables the shared idempotency_keys CHECK names once 0016 is recorded (the S8a two first). */
export const S8B_KEY_OWNERS = Object.freeze([...S8A_KEY_OWNERS, 'recruitment_cases', 'case_decision_drafts', 'case_transaction_handoffs', 'room_decisions']);

export const recruitmentCasesLive = (sqlite) => migrationApplied(sqlite, RECRUITMENT_CASES_MIGRATION);
const blocked = (detail, extra = {}) => Object.assign(new Error(`RECRUITMENT_CASES_IMPORT_BLOCKED: ${detail}; nothing was imported`), { code: 'RECRUITMENT_CASES_IMPORT_BLOCKED', ...extra });
const refusal = (code, message, extra = {}) => Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
const jsonOrNull = (obj) => (Object.keys(obj).length ? JSON.stringify(obj) : null);

// ------------------------------------------------------------------ the shapes (the writers' literals, key for key)
// kinds: text | int | num | bool | json | id (as the S8a engine). A child spec: { table, ownerCols, shape, scalar?: [col, kind]
// (a list of scalars: a matching entry in the column, any other entry in raw_json), constant?: { col: value } (several
// lists sharing one table), single?: true (an object child: one row), restrict?: true (deleted explicitly before its owner),
// indexes?: [...] }. A `maps` entry with `ownerTable` is the idempotency_keys rule, owner_id the record's own id.
const EMPTY = { keys: [], cols: {} };
const BY2 = (p) => ({ keys: ['userId', 'name'], cols: { userId: [`${p}_user_id`, 'text'], name: [`${p}_name`, 'text'] } });
const BY3 = (p) => ({ keys: ['kind', 'userId', 'name'], cols: { kind: [`${p}_kind`, 'text'], userId: [`${p}_user_id`, 'text'], name: [`${p}_name`, 'text'] } });
const BY_ROLE = (p) => ({ keys: ['userId', 'name', 'role'], cols: { userId: [`${p}_user_id`, 'text'], name: [`${p}_name`, 'text'], role: [`${p}_role`, 'text'] } });
const scalarList = (table, ownerCols, scalar, extra = {}) => ({ table, ownerCols, shape: EMPTY, scalar, ...extra });

const ROOM_TAGS = scalarList('case_room_tags', ['case_id'], ['tag', 'text']);
const ASSIGNMENTS = { table: 'case_assignments', ownerCols: ['case_id'], shape: { keys: ['id', 'userId', 'name', 'task', 'dueAt', 'status', 'createdAt'], cols: { id: ['id', 'text'], userId: ['user_id', 'text'], name: ['user_name', 'text'], task: ['task', 'text'], dueAt: ['due_at_json', 'json'], status: ['status', 'text'], createdAt: ['created_at', 'int'] } }, indexes: ['CREATE INDEX case_assignments_user ON case_assignments (user_id)'] };
const TASKS = { table: 'case_tasks', ownerCols: ['case_id'], shape: { keys: ['id', 'title', 'description', 'dueAt', 'assigneeUserId', 'assigneeName', 'status', 'linkedResourceType', 'linkedResourceId', 'createdBy', 'createdAt', 'completedAt', 'completedBy'], cols: { id: ['id', 'text'], title: ['title', 'text'], description: ['description', 'text'], dueAt: ['due_at_json', 'json'], assigneeUserId: ['assignee_user_id', 'text'], assigneeName: ['assignee_name', 'text'], status: ['status', 'text'], linkedResourceType: ['linked_resource_type', 'text'], linkedResourceId: ['linked_resource_id', 'text'], createdAt: ['created_at', 'int'], completedAt: ['completed_at', 'int'], completedBy: ['completed_by_name', 'text'] }, objects: { createdBy: BY2('created_by') } }, indexes: ['CREATE INDEX case_tasks_assignee_status ON case_tasks (assignee_user_id, status)'] };
const APPROVALS = { table: 'case_approvals', ownerCols: ['case_id'], shape: { keys: ['id', 'decision', 'requestedBy', 'status', 'requestedAt', 'resolvedBy'], cols: { id: ['id', 'text'], status: ['status', 'text'], requestedAt: ['requested_at', 'int'] }, objects: { decision: { keys: ['outcome', 'reasons'], cols: { outcome: ['decision_outcome', 'text'], reasons: ['decision_reasons', 'text'] } }, requestedBy: BY2('requested_by'), resolvedBy: { keys: ['userId', 'name', 'at'], cols: { userId: ['resolved_by_user_id', 'text'], name: ['resolved_by_name', 'text'], at: ['resolved_at', 'int'] } } } } };
const HISTORY = { table: 'case_history', ownerCols: ['case_id'], restrict: true, shape: { keys: ['id', 'at', 'byKind', 'byId', 'byName', 'action', 'by', 'detail'], cols: { id: ['id', 'text'], at: ['at', 'int'], byKind: ['by_kind', 'text'], byId: ['by_id', 'text'], byName: ['by_name', 'text'], action: ['action', 'text'], detail: ['detail_json', 'json'] }, objects: { by: BY3('actor') } }, indexes: ['CREATE INDEX case_history_case_at ON case_history (case_id, at)', 'CREATE INDEX case_history_id ON case_history (id)'] };
const REQUEST_LINKS = scalarList('case_request_links', ['case_id'], ['request_id', 'text'], { indexes: ['CREATE INDEX case_request_links_request ON case_request_links (request_id)'] });
const TRIAL_LINKS = scalarList('case_trial_links', ['case_id'], ['trial_id', 'text'], { indexes: ['CREATE INDEX case_trial_links_trial ON case_trial_links (trial_id)'] });
const DRAFT_REASONS = scalarList('case_decision_draft_reason_codes', ['case_id', 'draft_position'], ['code', 'text']);
const DRAFT_REFS = { table: 'case_decision_draft_evidence_refs', ownerCols: ['case_id', 'draft_position'], shape: { keys: ['kind', 'id', 'meta'], cols: { kind: ['kind', 'text'], id: ['ref_id', 'text'], meta: ['meta_json', 'json'] } } };
const DRAFT = { table: 'case_decision_drafts', ownerCols: ['case_id'], single: true, shape: { keys: ['id', 'outcome', 'reasonCodes', 'note', 'evidenceRefs', 'by', 'createdAt', 'updatedAt', 'updatedBy', 'rev', 'revAt', 'keys'], cols: { id: ['id', 'text'], outcome: ['outcome', 'text'], note: ['note', 'text'], createdAt: ['created_at', 'int'], updatedAt: ['updated_at', 'int'], rev: ['rev', 'int'], revAt: ['rev_at', 'int'] }, objects: { by: BY_ROLE('by'), updatedBy: BY_ROLE('updated_by') }, lists: { reasonCodes: DRAFT_REASONS, evidenceRefs: DRAFT_REFS }, maps: { keys: { table: 'idempotency_keys', ownerTable: 'case_decision_drafts' } } }, indexes: ['CREATE INDEX case_decision_drafts_id ON case_decision_drafts (id)'] };
const HANDOFF = { table: 'case_transaction_handoffs', ownerCols: ['case_id'], single: true, shape: { keys: ['id', 'caseId', 'orgId', 'playerId', 'status', 'invitedAt', 'invitedBy', 'acceptedAt', 'withdrawnAt', 'transactionId', 'representedAtInvitation', 'invitedAgencyOrgId', 'invitedAgentUserId', 'keys', 'rev', 'revAt'], cols: { id: ['id', 'text'], caseId: ['handoff_case_id', 'text'], orgId: ['org_id', 'text'], playerId: ['player_id', 'text'], status: ['status', 'text'], invitedAt: ['invited_at', 'int'], acceptedAt: ['accepted_at', 'int'], withdrawnAt: ['withdrawn_at', 'int'], transactionId: ['transaction_id', 'text'], representedAtInvitation: ['represented_at_invitation', 'bool'], invitedAgencyOrgId: ['invited_agency_org_id', 'text'], invitedAgentUserId: ['invited_agent_user_id', 'text'], rev: ['rev', 'int'], revAt: ['rev_at', 'int'] }, objects: { invitedBy: BY3('invited_by') }, maps: { keys: { table: 'idempotency_keys', ownerTable: 'case_transaction_handoffs' } } }, indexes: ['CREATE INDEX case_transaction_handoffs_id ON case_transaction_handoffs (id)', 'CREATE INDEX case_transaction_handoffs_agency_status ON case_transaction_handoffs (invited_agency_org_id, status)', 'CREATE INDEX case_transaction_handoffs_player ON case_transaction_handoffs (player_id)'] };
const BUDGET_LINES = { table: 'case_budget_lines', ownerCols: ['case_id', 'scenario_position'], shape: { keys: ['id', 'kind', 'label', 'amountMinor', 'currency', 'schedule', 'confirmed', 'conditional'], cols: { id: ['id', 'text'], kind: ['kind', 'text'], label: ['label', 'text'], amountMinor: ['amount_minor', 'int'], currency: ['currency', 'text'], schedule: ['schedule', 'text'], confirmed: ['confirmed', 'bool'] }, objects: { conditional: { keys: ['assumption'], cols: { assumption: ['conditional_assumption', 'text'] } } } } };
const BUDGET_FX = { table: 'case_budget_fx_assumptions', ownerCols: ['case_id', 'scenario_position'], shape: { keys: ['from', 'to', 'rate', 'source', 'date', 'manual'], cols: { from: ['from_currency', 'text'], to: ['to_currency', 'text'], rate: ['rate', 'text'], source: ['source', 'text'], date: ['date', 'text'], manual: ['manual', 'bool'] } } };
const BUDGET_ACTUALS = { table: 'case_budget_actuals', ownerCols: ['case_id', 'scenario_position'], shape: { keys: ['id', 'lineId', 'amountMinor', 'at', 'recordedBy'], cols: { id: ['id', 'text'], lineId: ['line_id', 'text'], amountMinor: ['amount_minor', 'int'], at: ['at', 'int'], recordedBy: ['recorded_by_name', 'text'] } } };
const BUDGET_SCENARIOS = { table: 'case_budget_scenarios', ownerCols: ['case_id'], shape: { keys: ['id', 'version', 'label', 'currency', 'termMonths', 'lines', 'fxAssumptions', 'approval', 'actuals', 'createdBy', 'createdAt', 'updatedAt'], cols: { id: ['id', 'text'], version: ['version', 'int'], label: ['label', 'text'], currency: ['currency', 'text'], termMonths: ['term_months', 'int'], createdBy: ['created_by_name', 'text'], createdAt: ['created_at', 'int'], updatedAt: ['updated_at', 'int'] }, objects: { approval: { keys: ['by', 'byUserId', 'at', 'version', 'superseded'], cols: { by: ['approval_by_name', 'text'], byUserId: ['approval_by_user_id', 'text'], at: ['approval_at', 'int'], version: ['approval_version', 'int'], superseded: ['approval_superseded', 'bool'] } } }, lists: { lines: BUDGET_LINES, fxAssumptions: BUDGET_FX, actuals: BUDGET_ACTUALS } }, indexes: ['CREATE INDEX case_budget_scenarios_id ON case_budget_scenarios (id)'] };
const CASE_SHAPE = {
  keys: ['id', 'orgId', 'playerId', 'playerName', 'vacancyId', 'ownerUserId', 'ownerName', 'stage', 'priority', 'deadline', 'restricted', 'assignments', 'tasks', 'approvals', 'decision', 'links', 'createdAt', 'history', 'room', 'decisionDraft', 'transactionHandoff', 'budget', 'subjectRemovedAt'],
  cols: { id: ['id', 'id'], orgId: ['org_id', 'text'], playerId: ['player_id', 'text'], playerName: ['player_name', 'text'], vacancyId: ['vacancy_id', 'text'], ownerUserId: ['owner_user_id', 'text'], ownerName: ['owner_name', 'text'], stage: ['stage', 'text'], priority: ['priority', 'text'], deadline: ['deadline_json', 'json'], restricted: ['restricted', 'bool'], createdAt: ['created_at', 'int'], subjectRemovedAt: ['subject_removed_at', 'int'] },
  objects: {
    decision: { keys: ['outcome', 'reasons', 'byUserId', 'byName', 'approvedBy', 'at'], cols: { outcome: ['decision_outcome', 'text'], reasons: ['decision_reasons', 'text'], byUserId: ['decision_by_user_id', 'text'], byName: ['decision_by_name', 'text'], approvedBy: ['decision_approved_by_name', 'text'], at: ['decision_at', 'int'] } },
    links: { keys: ['requestIds', 'trialIds', 'signingId'], cols: { signingId: ['links_signing_id', 'text'] }, lists: { requestIds: REQUEST_LINKS, trialIds: TRIAL_LINKS } },
    room: {
      keys: ['status', 'priority', 'tags', 'leadScoutUserId', 'sourceContext', 'sourceRef', 'openedBy', 'updatedAt', 'archivedAt', 'closedAt', 'rev', 'revAt', 'revBy', 'reopened'],
      cols: { status: ['room_status', 'text'], priority: ['room_priority', 'text'], leadScoutUserId: ['room_lead_scout_user_id', 'text'], sourceContext: ['room_source_context', 'text'], sourceRef: ['room_source_ref_json', 'json'], updatedAt: ['room_updated_at', 'int'], archivedAt: ['room_archived_at', 'int'], closedAt: ['room_closed_at', 'int'], rev: ['room_rev', 'int'], revAt: ['room_rev_at', 'int'] },
      objects: { openedBy: BY2('room_opened_by'), revBy: BY2('room_rev_by'), reopened: { keys: ['by', 'at', 'from', 'reasonCodes', 'sourceContext', 'sourceRef'], cols: { at: ['room_reopened_at', 'int'], from: ['room_reopened_from', 'text'], reasonCodes: ['room_reopened_reason_codes_json', 'json'], sourceContext: ['room_reopened_source_context', 'text'], sourceRef: ['room_reopened_source_ref_json', 'json'] }, objects: { by: BY2('room_reopened_by') } } },
      lists: { tags: ROOM_TAGS },
    },
    budget: { keys: ['scenarios'], cols: {}, lists: { scenarios: BUDGET_SCENARIOS } },
  },
  lists: { assignments: ASSIGNMENTS, tasks: TASKS, approvals: APPROVALS, history: HISTORY },
  object: { decisionDraft: DRAFT, transactionHandoff: HANDOFF },
};
const MENTIONS = scalarList('room_comment_mentions', ['comment_id'], ['user_id', 'text']);
const COMMENT_SHAPE = { keys: ['id', 'roomId', 'orgId', 'authorId', 'authorName', 'body', 'replyToId', 'mentions', 'createdAt', 'editedAt', 'editCount', 'deletedAt', 'deletedBy'], cols: { id: ['id', 'id'], roomId: ['room_id', 'text'], orgId: ['org_id', 'text'], authorId: ['author_user_id', 'text'], authorName: ['author_name', 'text'], body: ['body', 'text'], replyToId: ['reply_to_id', 'text'], createdAt: ['created_at', 'int'], editedAt: ['edited_at', 'int'], editCount: ['edit_count', 'int'], deletedAt: ['deleted_at', 'int'] }, objects: { deletedBy: BY2('deleted_by') }, lists: { mentions: MENTIONS } };
const sourceRefList = (kind) => ({ table: 'room_snapshot_source_refs', ownerCols: ['snapshot_id'], shape: EMPTY, scalar: ['ref_id', 'text'], constant: { kind } });
const SOURCE_REFS = { keys: ['passportVersion', 'passportRevision', 'evidenceIds', 'assessmentIds', 'combineResults', 'trialIds'], cols: { passportVersion: ['source_passport_version', 'int'], passportRevision: ['source_passport_revision', 'int'] }, lists: { evidenceIds: sourceRefList('evidence'), assessmentIds: sourceRefList('assessment'), combineResults: sourceRefList('combine'), trialIds: sourceRefList('trial') } };
const TRUST = (p) => ({ keys: ['score', 'band', 'policyVersion', 'componentLevels', 'hash'], cols: { score: [`${p}_score`, 'num'], band: [`${p}_band`, 'text'], policyVersion: [`${p}_policy_version`, 'int'], componentLevels: [`${p}_component_levels_json`, 'json'], hash: [`${p}_hash`, 'text'] } });
const SNAPSHOT_SHAPE = { keys: ['id', 'roomId', 'orgId', 'playerId', 'at', 'trigger', 'trust', 'sourceRefs', 'note'], cols: { id: ['id', 'id'], roomId: ['room_id', 'text'], orgId: ['org_id', 'text'], playerId: ['player_id', 'text'], at: ['at', 'int'], trigger: ['trigger', 'text'], note: ['note', 'text'] }, objects: { trust: TRUST('trust'), sourceRefs: SOURCE_REFS } };
const DECISION_REASONS = scalarList('room_decision_reason_codes', ['decision_id'], ['code', 'text']);
const DECISION_REFS = { table: 'room_decision_evidence_refs', ownerCols: ['decision_id'], shape: { keys: ['kind', 'id', 'meta'], cols: { kind: ['kind', 'text'], id: ['ref_id', 'text'], meta: ['meta_json', 'json'] } }, indexes: ['CREATE INDEX room_decision_evidence_refs_ref ON room_decision_evidence_refs (kind, ref_id)'] };
const DECISION_ASSESSMENTS = scalarList('room_decision_assessment_ids', ['decision_id'], ['assessment_id', 'text']);
const DECISION_SHAPE = {
  keys: ['id', 'roomId', 'orgId', 'playerId', 'kind', 'state', 'outcome', 'recommendation', 'reasonCodes', 'note', 'by', 'createdAt', 'finalizedAt', 'trigger', 'clientKey', 'supersedes', 'supersededById', 'supersession', 'rev', 'revAt', 'evidenceRefs', 'assessmentSummary', 'snapshot', 'keys', 'draftId', 'lifecycle', 'policyVersion'],
  cols: { id: ['id', 'id'], roomId: ['room_id', 'text'], orgId: ['org_id', 'text'], playerId: ['player_id', 'text'], kind: ['kind', 'text'], state: ['state', 'text'], outcome: ['outcome', 'text'], recommendation: ['recommendation', 'text'], note: ['note', 'text'], createdAt: ['created_at', 'int'], finalizedAt: ['finalized_at', 'int'], trigger: ['trigger', 'text'], clientKey: ['client_key', 'text'], supersedes: ['supersedes_id', 'text'], supersededById: ['superseded_by_id', 'text'], rev: ['rev', 'int'], revAt: ['rev_at', 'int'], draftId: ['draft_id', 'text'], policyVersion: ['policy_version', 'int'] },
  objects: {
    by: BY_ROLE('by'),
    supersession: { keys: ['of', 'reason'], cols: { of: ['supersession_of_id', 'text'], reason: ['supersession_reason', 'text'] } },
    assessmentSummary: { keys: ['submitted', 'withheld', 'verdicts', 'assessmentIds'], cols: { submitted: ['assessments_submitted', 'int'], withheld: ['assessments_withheld', 'int'], verdicts: ['assessment_verdicts_json', 'json'] }, lists: { assessmentIds: DECISION_ASSESSMENTS } },
    snapshot: { keys: ['at', 'trust', 'sourceRefs', 'snapshotId'], cols: { at: ['snapshot_at', 'int'], sourceRefs: ['snapshot_source_refs_json', 'json'], snapshotId: ['snapshot_id', 'text'] }, objects: { trust: TRUST('snapshot_trust') } },
    lifecycle: { keys: ['action', 'from', 'to', 'applied', 'reason', 'at'], cols: { action: ['lifecycle_action', 'text'], from: ['lifecycle_from', 'text'], to: ['lifecycle_to', 'text'], applied: ['lifecycle_applied', 'bool'], reason: ['lifecycle_reason', 'text'], at: ['lifecycle_at', 'int'] } },
  },
  lists: { reasonCodes: DECISION_REASONS, evidenceRefs: DECISION_REFS },
  maps: { keys: { table: 'idempotency_keys', ownerTable: 'room_decisions' } },
};
const EVIDENCE_SHAPE = { keys: ['id', 'roomId', 'orgId', 'evidenceId', 'state', 'note', 'byId', 'byName', 'at'], cols: { id: ['id', 'id'], roomId: ['room_id', 'text'], orgId: ['org_id', 'text'], evidenceId: ['evidence_id', 'text'], state: ['state', 'text'], note: ['note', 'text'], byId: ['by_user_id', 'text'], byName: ['by_name', 'text'], at: ['at', 'int'] } };

/** One collection: its parent table, shape, children (write order: a sub-child after its owner), the key owners it carries, its indexes. */
const COLL = (name, table, shape, indexes, { roomRef = null, keyOwners = [] } = {}) => ({ name, table, shape, children: Object.freeze(childSpecs(shape)), indexes, roomRef, keyOwners });
export const CASES = COLL('recruitmentCases', 'recruitment_cases', CASE_SHAPE, ['CREATE INDEX recruitment_cases_org_created ON recruitment_cases (org_id, created_at)', 'CREATE INDEX recruitment_cases_org_player ON recruitment_cases (org_id, player_id)', 'CREATE INDEX recruitment_cases_org_room_status_updated ON recruitment_cases (org_id, room_status, room_updated_at)', 'CREATE INDEX recruitment_cases_org_stage ON recruitment_cases (org_id, stage)', 'CREATE INDEX recruitment_cases_player ON recruitment_cases (player_id)'], { keyOwners: [DRAFT, HANDOFF] });
export const COMMENTS = COLL('roomComments', 'room_comments', COMMENT_SHAPE, ['CREATE INDEX room_comments_room_created ON room_comments (room_id, created_at)', 'CREATE INDEX room_comments_author ON room_comments (author_user_id)'], { roomRef: 'room_id' });
export const SNAPSHOTS = COLL('roomSnapshots', 'room_snapshots', SNAPSHOT_SHAPE, ['CREATE INDEX room_snapshots_room_at ON room_snapshots (room_id, at)', 'CREATE INDEX room_snapshots_player ON room_snapshots (player_id)'], { roomRef: 'room_id' });
export const DECISIONS = COLL('roomDecisions', 'room_decisions', DECISION_SHAPE, ['CREATE INDEX room_decisions_room_created ON room_decisions (room_id, created_at)', 'CREATE INDEX room_decisions_room_client_key ON room_decisions (room_id, client_key)', 'CREATE INDEX room_decisions_player ON room_decisions (player_id)', 'CREATE INDEX room_decisions_draft ON room_decisions (draft_id)'], { roomRef: 'room_id', keyOwners: [{ table: 'room_decisions', self: true }] });
export const EVIDENCE_STATES = COLL('roomEvidenceState', 'room_evidence_states', EVIDENCE_SHAPE, ['CREATE INDEX room_evidence_states_room_evidence ON room_evidence_states (room_id, evidence_id)'], { roomRef: 'room_id' });
const ROOM_COLLECTIONS = Object.freeze([COMMENTS, SNAPSHOTS, DECISIONS, EVIDENCE_STATES]);
const ALL_COLLECTIONS = Object.freeze([CASES, ...ROOM_COLLECTIONS]);
const byName = Object.fromEntries(ALL_COLLECTIONS.map((c) => [c.name, c]));
const LINK_TABLES = new Set([REQUEST_LINKS.table, TRIAL_LINKS.table]);
const dedupeTables = (list) => [...new Set(list)];
export const RECRUITMENT_CASES_TABLES = Object.freeze(dedupeTables(ALL_COLLECTIONS.flatMap((c) => [c.table, ...c.children.map((ch) => ch.table)])));

// ------------------------------------------------------------------ the DDL (generated from the shapes; amended into docs/architecture/sql/02_recruitment.sql at this step)
const CONSTRAINTS = {
  recruitment_cases: { id: 'TEXT NOT NULL UNIQUE', org_id: 'TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT', player_id: 'TEXT NOT NULL', owner_user_id: 'TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT', room_lead_scout_user_id: 'TEXT REFERENCES org_users(id) ON DELETE RESTRICT', decision_by_user_id: 'TEXT REFERENCES org_users(id) ON DELETE RESTRICT' },
  case_assignments: { user_id: 'TEXT REFERENCES org_users(id) ON DELETE RESTRICT' },
  case_request_links: { request_id: 'TEXT REFERENCES recruitment_requests(id) ON DELETE RESTRICT' },
  case_trial_links: { trial_id: 'TEXT REFERENCES trials(id) ON DELETE RESTRICT' },
  case_transaction_handoffs: { org_id: 'TEXT REFERENCES orgs(id) ON DELETE RESTRICT' },
  room_comments: { id: 'TEXT NOT NULL UNIQUE', room_id: 'TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE RESTRICT', org_id: 'TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT', author_user_id: 'TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT' },
  room_snapshots: { id: 'TEXT NOT NULL UNIQUE', room_id: 'TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE RESTRICT', org_id: 'TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT' },
  room_decisions: { id: 'TEXT NOT NULL UNIQUE', room_id: 'TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE RESTRICT', org_id: 'TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT' },
  room_evidence_states: { id: 'TEXT NOT NULL UNIQUE', room_id: 'TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE RESTRICT', org_id: 'TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT' },
};
const colDdl = (table, [col, kind]) => `  ${col.padEnd(32)} ${CONSTRAINTS[table]?.[col] ?? sqlType(kind)}${kind === 'json' && !CONSTRAINTS[table]?.[col] ? ` ${JSON_CHECK(col)}` : ''}`;
function parentDdl(coll) {
  const cols = columnsOf(coll.shape).map((c) => colDdl(coll.table, c));
  return `CREATE TABLE ${coll.table} (\n  seq                              INTEGER PRIMARY KEY,\n${cols.join(',\n')},\n  absent_keys_json                 TEXT ${ABSENT_CHECK},\n  offtype_json                     TEXT ${EXTRA_CHECK('offtype_json')},\n  extra_json                       TEXT ${EXTRA_CHECK('extra_json')}\n) STRICT;\n${coll.indexes.map((ix) => `${ix};`).join('\n')}`;
}
function childDdl(spec, parentTable) {
  const owner = spec.ownerCols.map((c, i) => `  ${c.padEnd(32)} ${i === 0 ? `TEXT NOT NULL REFERENCES ${parentTable}(id) ON DELETE ${spec.restrict ? 'RESTRICT' : 'CASCADE'}` : 'INTEGER NOT NULL'}`);
  const constants = Object.keys(spec.constant ?? {}).map((c) => `  ${c.padEnd(32)} TEXT NOT NULL`);
  const scalar = spec.scalar ? [colDdl(spec.table, spec.scalar)] : [];
  const cols = columnsOf(spec.shape).map((c) => colDdl(spec.table, c));
  // an object child (one row or none) is keyed by its owner alone: the drafted `case_id UNIQUE` is structural, its primary key
  const pk = spec.single ? `PRIMARY KEY (${spec.ownerCols.join(', ')})` : `PRIMARY KEY (${[...spec.ownerCols, ...Object.keys(spec.constant ?? {}), 'position'].join(', ')})`;
  return `CREATE TABLE ${spec.table} (\n${[...owner, ...constants].join(',\n')},\n  position                         INTEGER NOT NULL,\n${[...scalar, ...cols, `  raw_json                         TEXT ${JSON_CHECK('raw_json')}`, `  absent_keys_json                 TEXT ${ABSENT_CHECK}`, `  offtype_json                     TEXT ${EXTRA_CHECK('offtype_json')}`, `  extra_json                       TEXT ${EXTRA_CHECK('extra_json')}`].join(',\n')},\n  ${pk}\n) STRICT;\n${(spec.indexes ?? []).map((ix) => `${ix};`).join('\n')}`;
}
/** The twenty-five tables, parents before children, cases before the room collections (their room_id keys). Each child table once (the four source-reference lists share one). */
export const RECRUITMENT_CASES_DDL = ALL_COLLECTIONS.flatMap((coll) => { const seen = new Set(); return [parentDdl(coll), ...coll.children.filter((ch) => (seen.has(ch.table) ? false : (seen.add(ch.table), true))).map((ch) => childDdl(ch, coll.table))]; }).join('\n');

// ------------------------------------------------------------------ statements (lazily prepared per connection; re-prepared when the connection's `prepare` is replaced — the suites' statement-failure seam)
const stmtCache = new WeakMap();
function stmts(sqlite) {
  let s = stmtCache.get(sqlite); if (s && s.preparedBy === sqlite.prepare) return s;
  const insertFor = (table, cols) => sqlite.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`);
  const parentFor = (coll) => {
    const cols = [...columnsOf(coll.shape).map((c) => c[0]), 'absent_keys_json', 'offtype_json', 'extra_json'];
    const set = cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`);
    return { upsert: sqlite.prepare(`INSERT INTO ${coll.table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')}) ON CONFLICT(id) DO UPDATE SET ${set.join(', ')}`), select: sqlite.prepare(`SELECT * FROM ${coll.table} ORDER BY seq`), ids: sqlite.prepare(`SELECT id FROM ${coll.table} ORDER BY seq`), del: sqlite.prepare(`DELETE FROM ${coll.table} WHERE id = ?`), cols };
  };
  const childFor = (spec) => {
    const cols = [...spec.ownerCols, ...Object.keys(spec.constant ?? {}), 'position', ...(spec.scalar ? [spec.scalar[0]] : []), ...columnsOf(spec.shape).map((c) => c[0]), 'raw_json', 'absent_keys_json', 'offtype_json', 'extra_json'];
    return { insert: insertFor(spec.table, cols), deleteOwner: sqlite.prepare(`DELETE FROM ${spec.table} WHERE ${spec.ownerCols[0]} = ?`), select: sqlite.prepare(`SELECT * FROM ${spec.table} ORDER BY ${[...spec.ownerCols, ...Object.keys(spec.constant ?? {}), 'position'].join(', ')}`), cols };
  };
  const children = {}; for (const coll of ALL_COLLECTIONS) for (const ch of coll.children) if (!children[ch.table]) children[ch.table] = childFor(ch);
  s = {
    parents: Object.fromEntries(ALL_COLLECTIONS.map((c) => [c.name, parentFor(c)])),
    children,
    keys: { insert: insertFor('idempotency_keys', ['owner_table', 'owner_id', 'position', 'act', 'shape', 'key', 'fp', 'at', 'entry_json']), deleteOwner: sqlite.prepare('DELETE FROM idempotency_keys WHERE owner_table = ? AND owner_id = ?'), select: sqlite.prepare('SELECT * FROM idempotency_keys WHERE owner_table = ? ORDER BY owner_id, position') },
    draftIdsOf: sqlite.prepare('SELECT id FROM case_decision_drafts WHERE case_id = ?'),
    handoffIdsOf: sqlite.prepare('SELECT id FROM case_transaction_handoffs WHERE case_id = ?'),
    historyOf: sqlite.prepare('DELETE FROM case_history WHERE case_id = ?'),
    deleteCase: sqlite.prepare('DELETE FROM recruitment_cases WHERE id = ?'),
    linkRowsNaming: { requests: (n) => sqlite.prepare(`SELECT * FROM case_request_links WHERE request_id IN (${Array(n).fill('?').join(', ')})`), trials: (n) => sqlite.prepare(`SELECT * FROM case_trial_links WHERE trial_id IN (${Array(n).fill('?').join(', ')})`) },
    deleteLinkRow: { case_request_links: sqlite.prepare('DELETE FROM case_request_links WHERE case_id = ? AND position = ?'), case_trial_links: sqlite.prepare('DELETE FROM case_trial_links WHERE case_id = ? AND position = ?') },
    preparedBy: sqlite.prepare,
  };
  stmtCache.set(sqlite, s); return s;
}

// ------------------------------------------------------------------ the mapping engine (record ↔ row + child rows), generic over the specs above
/** Idempotency rows need an owner id: a child record without a string id keeps its row-worthy acts on the row too (held under `keys` in extra_json), so nothing is lost and no row is minted. */
function foldKeysWithoutOwner(enc, item) {
  if (nonEmpty(item?.id)) return;
  enc.children = enc.children.filter((ch) => {
    if (!ch.spec.ownerTable) return true;
    const held = isPlainObject(enc.extra.keys) ? enc.extra.keys : {}; for (const [act, v] of Object.entries(ch.map)) setOwn(held, act, clone(v, `keys.${act}`).value); setOwn(enc.extra, 'keys', held); return false;
  });
}
function writeKeyRows(S, ownerTable, ownerId, map) {
  let i = 0;
  for (const [act, v] of Object.entries(map)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const e of v) { const c = clone(e, `keys.${act}`).value; S.keys.insert.run({ owner_table: ownerTable, owner_id: ownerId, position: i++, act, shape: 'list', key: isPlainObject(c) && typeof c.key === 'string' ? c.key : null, fp: isPlainObject(c) && typeof c.fp === 'string' ? c.fp : null, at: isPlainObject(c) && Number.isSafeInteger(c.at) ? c.at : null, entry_json: JSON.stringify(c === undefined ? null : c) }); }
    else { const c = clone(v, `keys.${act}`).value; S.keys.insert.run({ owner_table: ownerTable, owner_id: ownerId, position: i++, act, shape: 'value', key: isPlainObject(c) && typeof c.key === 'string' ? c.key : null, fp: isPlainObject(c) && typeof c.fp === 'string' ? c.fp : null, at: null, entry_json: JSON.stringify(c === undefined ? null : c) }); }
  }
}
/** Write the children of one encoded level: `ownerValues` the owner key so far, `owner` the record at this level (its id owns the key rows), `include(spec)` the stage filter. */
function writeChildren(sqlite, children, ownerValues, owner, include) {
  const S = stmts(sqlite);
  for (const ch of children) {
    if (ch.spec.ownerTable) { if (include(ch.spec)) writeKeyRows(S, ch.spec.ownerTable, owner.id, ch.map); continue; }
    if (!include(ch.spec)) continue;
    const st = S.children[ch.spec.table]; const constants = ch.spec.constant ?? {};
    ch.items.forEach((item, position) => {
      const base = { ...Object.fromEntries(ch.spec.ownerCols.map((c, i) => [c, ownerValues[i]])), ...constants, position };
      const blank = Object.fromEntries(columnsOf(ch.spec.shape).map(([col]) => [col, null]));
      if (ch.spec.scalar) { const [col, kind] = ch.spec.scalar; const fits = item !== null && item !== undefined && !isPlainObject(item) && columnAdmits(kind, item); st.insert.run({ ...base, [col]: fits ? toColumn(kind, item) : null, ...blank, raw_json: fits ? null : JSON.stringify(clone(item, ch.path).value), absent_keys_json: null, offtype_json: null, extra_json: null }); return; }
      if (!isPlainObject(item)) { st.insert.run({ ...base, ...blank, raw_json: JSON.stringify(clone(item, ch.path).value), absent_keys_json: null, offtype_json: null, extra_json: null }); return; }
      const enc = encode(ch.spec.shape, item); foldKeysWithoutOwner(enc, item);
      st.insert.run({ ...base, ...Object.fromEntries(columnsOf(ch.spec.shape).map(([col]) => [col, enc.cols[col] ?? null])), raw_json: null, ...rowMeta(enc) });
      if (enc.children.length) writeChildren(sqlite, enc.children, [...ownerValues, position], item, include);
    });
  }
}
/** The idempotency rows a parent record's owned key owners hold in the tables now (by the stored child ids), deleted before the children are rewritten or the owner departs. */
function deleteOwnedKeyRows(sqlite, coll, recordId) {
  const S = stmts(sqlite);
  for (const owner of coll.keyOwners) {
    if (owner.self) { S.keys.deleteOwner.run(owner.table, recordId); continue; }
    const q = owner === DRAFT ? S.draftIdsOf : S.handoffIdsOf;
    for (const r of q.all(recordId)) S.keys.deleteOwner.run(owner.table, r.id);
  }
}
/**
 * Write one parent record: its row by upsert (seq kept), every child row of the included stage deleted and reinserted in
 * list order (`include`: the A stage excludes the link tables, the C stage writes nothing but them).
 */
export function writeRecord(sqlite, coll, record, { include = () => true, upsertParent = true } = {}) {
  const S = stmts(sqlite); const P = S.parents[coll.name];
  const enc = encode(coll.shape, record); foldKeysWithoutOwner(enc, record);
  if (upsertParent) {
    deleteOwnedKeyRows(sqlite, coll, record.id);
    P.upsert.run({ ...Object.fromEntries(columnsOf(coll.shape).map(([col]) => [col, enc.cols[col] ?? null])), ...rowMeta(enc) });
  }
  const seen = new Set(); for (const ch of coll.children) if (include(ch) && !seen.has(ch.table)) { seen.add(ch.table); S.children[ch.table].deleteOwner.run(record.id); }
  writeChildren(sqlite, enc.children, [record.id], record, include);
}
const notLinks = (spec) => !LINK_TABLES.has(spec.table);
const onlyLinks = (spec) => LINK_TABLES.has(spec.table);
/** Read every parent record of a collection with its children, in `seq` order: fresh objects from the file. */
export function readRecords(sqlite, coll) {
  const S = stmts(sqlite);
  const groups = new Map(); // `${table}|${constants}|${ownerKey}` → rows
  const seen = new Set();
  for (const c of coll.children) { if (seen.has(c.table)) continue; seen.add(c.table); for (const r of S.children[c.table].select.all()) { const key = `${c.table}|${Object.keys(c.constant ?? {}).map((k) => r[k]).join('|')}|${c.ownerCols.map((col) => r[col]).join('|')}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push({ ...r }); } }
  const keys = new Map(); // `${ownerTable}|${ownerId}` → rows
  const keyTables = new Set(); const collectKeyTables = (shape) => { for (const m of Object.values(shape.maps ?? {})) if (m.ownerTable) keyTables.add(m.ownerTable); for (const sub of Object.values(shape.objects ?? {})) collectKeyTables(sub); for (const sub of Object.values(shape.lists ?? {})) collectKeyTables(sub.shape); for (const sub of Object.values(shape.object ?? {})) collectKeyTables(sub.shape); }; collectKeyTables(coll.shape);
  for (const t of keyTables) for (const r of S.keys.select.all(t)) { const k = `${t}|${r.owner_id}`; if (!keys.has(k)) keys.set(k, []); keys.get(k).push(r); }
  const rowsOf = (sub, ownerValues) => groups.get(`${sub.table}|${Object.values(sub.constant ?? {}).join('|')}|${ownerValues.join('|')}`) ?? [];
  const decodeChildren = (shape, ownerValues, ownerId, out = new Map(), prefix = '') => {
    for (const [k, sub] of Object.entries(shape.lists ?? {})) out.set(`${prefix}${k}`, rowsOf(sub, ownerValues).map((r) => decodeChild(sub, r, ownerValues)));
    for (const [k, sub] of Object.entries(shape.object ?? {})) out.set(`${prefix}${k}`, rowsOf(sub, ownerValues).map((r) => decodeChild(sub, r, ownerValues)));
    for (const [k, sub] of Object.entries(shape.maps ?? {})) { const o = {}; for (const r of keys.get(`${sub.ownerTable}|${ownerId}`) ?? []) { const v = parseJson(r.entry_json, 'entry_json'); if (r.shape === 'list') { if (!Object.hasOwn(o, r.act) || !Array.isArray(o[r.act])) setOwn(o, r.act, []); o[r.act].push(v); } else setOwn(o, r.act, v); } out.set(`${prefix}${k}`, o); } // own properties only: an act named __proto__ is data
    for (const [k, sub] of Object.entries(shape.objects ?? {})) decodeChildren(sub, ownerValues, ownerId, out, `${prefix}${k}.`);
    return out;
  };
  const decodeChild = (sub, r, ownerValues) => {
    if (r.raw_json !== null) return parseJson(r.raw_json, 'raw_json');
    if (sub.scalar) return fromColumn(sub.scalar[1], r[sub.scalar[0]], sub.scalar[0]);
    const m = metaOf(r); const kids = decodeChildren(sub.shape, [...ownerValues, r.position], typeof r.id === 'string' ? r.id : null);
    return decodeLevel(sub.shape, r, '', m.extra, m.absent, m.offtype, kids);
  };
  return S.parents[coll.name].select.all().map((r) => { const m = metaOf(r); return decodeLevel(coll.shape, r, '', m.extra, m.absent, m.offtype, decodeChildren(coll.shape, [r.id], r.id)); });
}
export const readCases = (sqlite) => readRecords(sqlite, CASES);
export const readRoomComments = (sqlite) => readRecords(sqlite, COMMENTS);
export const readRoomSnapshots = (sqlite) => readRecords(sqlite, SNAPSHOTS);
export const readRoomDecisions = (sqlite) => readRecords(sqlite, DECISIONS);
export const readRoomEvidenceStates = (sqlite) => readRecords(sqlite, EVIDENCE_STATES);
const READERS = { recruitmentCases: readCases, roomComments: readRoomComments, roomSnapshots: readRoomSnapshots, roomDecisions: readRoomDecisions, roomEvidenceState: readRoomEvidenceStates };

// ------------------------------------------------------------------ validation (the literal's contract: never a value in a message)
const presentKey = (raw, k) => Object.hasOwn(raw, k) && raw[k] !== undefined;
/** Validate one entry of a collection: `{ ok: true }` or `{ ok: false, reason }`. The contract is the identifiers the keys need (and, for a case, the createdAt the ordering reads); everything else is lossless. */
export function validateEntry(coll, raw, at = coll.name) {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  if (!nonEmpty(raw.id)) return { ok: false, reason: `${at}.id must be a non-empty string` };
  if (!nonEmpty(raw.orgId)) return { ok: false, reason: `${at}.orgId must be a non-empty string (${raw.id})` };
  if (coll === CASES) {
    if (!nonEmpty(raw.playerId)) return { ok: false, reason: `${at}.playerId must be a non-empty string (${raw.id})` };
    if (!nonEmpty(raw.ownerUserId)) return { ok: false, reason: `${at}.ownerUserId must be a non-empty string (${raw.id})` };
    if (!presentKey(raw, 'createdAt')) return { ok: false, reason: `${at}.createdAt must be present (${raw.id})` };
  } else {
    if (!nonEmpty(raw.roomId)) return { ok: false, reason: `${at}.roomId must be a non-empty string (${raw.id})` };
    if (coll === COMMENTS && !nonEmpty(raw.authorId)) return { ok: false, reason: `${at}.authorId must be a non-empty string (${raw.id})` };
  }
  try { encode(coll.shape, raw); } catch (e) { return { ok: false, reason: `${at} (${raw.id}): ${e.message}` }; }
  return { ok: true };
}
const unknownExtras = (enc) => Object.keys(enc.extra).some((k) => k !== 'keys');
const strRefs = (list) => (Array.isArray(list) ? list.filter(nonEmpty) : []);
const linkRefsOf = (c) => ({ requests: isPlainObject(c.links) ? strRefs(c.links.requestIds) : [], trials: isPlainObject(c.links) ? strRefs(c.links.trialIds) : [] });
const idSet = (list) => new Set((Array.isArray(list) ? list : []).filter(isPlainObject).map((x) => x.id));
const ROOM_TABLE_LABEL = Object.fromEntries(ROOM_COLLECTIONS.map((c) => [c.name, c.table]));

/**
 * The preflight P of the review's §6 against the FINAL combined graph, ids only, before any write. `supplied` holds the
 * five collections as supplied (`undefined` = omitted, retained); `stored` the retained side as records (ids suffice)
 * for every omitted collection; `s8a` the final requests and trials (`{ requests, trials }` as records: the supplied
 * snapshot collections, the recruitment mirror in a flush, the table rows otherwise) with `departures` (the trial ids
 * B deletes or reinserts, the request ids F2 prunes); `orgs`/`users` the final organisations and staff (records) or
 * undefined for the tables; `only` (a flush) restricts the entry validation to the changed ids — the mirrors' other
 * records were validated when they were committed. Returns `{ counts, departingCases }` or throws.
 */
export function preflight(sqlite, supplied, { stored, s8a, orgs, users, only = null, label = 'the snapshot' }) {
  const problems = [];
  const counts = { players: { live: 0, retained: 0, missing: 0 } };
  for (const coll of ALL_COLLECTIONS) {
    const list = supplied[coll.name];
    counts[coll.name] = { imported: 0, withExtraFields: 0, withAbsentKeys: 0, withOfftypeValues: 0, ...(coll === CASES ? { roomless: 0 } : {}) };
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw blocked(`${label}: ${coll.name} must be an array of entries (got ${describe(list)})`);
    const seen = new Set();
    list.forEach((raw, i) => {
      if (only && isPlainObject(raw) && !only[coll.name]?.has(raw.id)) { if (seen.has(raw.id)) problems.push(`${coll.name} entry #${i}: duplicates the id of an earlier entry (${raw.id})`); seen.add(raw.id); return; }
      const v = validateEntry(coll, raw, `${coll.name} entry #${i}`); if (!v.ok) { problems.push(v.reason); return; }
      if (seen.has(raw.id)) { problems.push(`${coll.name} entry #${i}: duplicates the id of an earlier entry (${raw.id})`); return; } seen.add(raw.id);
      const e = encode(coll.shape, raw); const c = counts[coll.name]; c.imported += 1; if (unknownExtras(e)) c.withExtraFields += 1; if (e.absent.length) c.withAbsentKeys += 1; if (Object.keys(e.offtype).length) c.withOfftypeValues += 1;
      if (coll === CASES && !isPlainObject(raw.room)) c.roomless += 1;
    });
  }
  if (problems.length) throw blocked(`${problems.length} invalid entr${problems.length === 1 ? 'y' : 'ies'} in ${label} — ${problems.slice(0, 20).join('; ')}${problems.length > 20 ? '; …' : ''}`, { problems });
  const final = (coll) => (supplied[coll.name] === undefined ? (stored[coll.name] ?? []) : supplied[coll.name]);
  const finalCases = final(CASES).filter(isPlainObject); const finalCaseIds = idSet(finalCases);
  const storedCaseIds = idSet(stored.recruitmentCases ?? []);
  const departingCases = supplied.recruitmentCases === undefined ? [] : [...storedCaseIds].filter((id) => !finalCaseIds.has(id));
  // (1) every link of every final case names a final request/trial
  const reqIds = idSet(s8a.requests); const trialIds = idSet(s8a.trials);
  const dangling = [];
  for (const c of finalCases) { const l = linkRefsOf(c); for (const r of l.requests) if (!reqIds.has(r)) dangling.push(`case ${c.id} links request ${r}`); for (const t of l.trials) if (!trialIds.has(t)) dangling.push(`case ${c.id} links trial ${t}`); }
  if (dangling.length) throw refusal('CASE_LINK_DANGLING', `${dangling.length} case link(s) in ${label} name a request or trial that is not in the final collections (${ids(dangling)}); the write was rolled back and nothing was changed — remove the link with its target, or keep the target`, { links: dangling });
  // (2) a case the write removes is named by no RETAINED independent row (the owned children never block)
  if (departingCases.length) {
    const departing = new Set(departingCases); const blockers = [];
    for (const r of (s8a.requests ?? []).filter(isPlainObject)) if (nonEmpty(r.caseId) && departing.has(r.caseId)) blockers.push(['recruitment_requests', r.id, r.caseId]);
    for (const t of (s8a.trials ?? []).filter(isPlainObject)) if (nonEmpty(t.caseId) && departing.has(t.caseId)) blockers.push(['trials', t.id, t.caseId]);
    for (const coll of ROOM_COLLECTIONS) if (supplied[coll.name] === undefined) for (const r of (stored[coll.name] ?? []).filter(isPlainObject)) if (nonEmpty(r.roomId) && departing.has(r.roomId)) blockers.push([coll.table, r.id, r.roomId]);
    if (blockers.length) {
      const byTable = new Map(); for (const [t, id] of blockers) { if (!byTable.has(t)) byTable.set(t, []); byTable.get(t).push(id); }
      throw refusal('CASE_STILL_REFERENCED', `${blockers.length} retained row(s) in ${label} name a case this write removes (${[...byTable].map(([t, list]) => `${t} ${ids(list)}`).join('; ')} → cases ${ids([...new Set(blockers.map((b) => b[2]))])}); the write was rolled back and nothing was changed — remove the rows with their case in the same snapshot, or keep the case`, { rows: blockers.map((b) => `${b[0]} ${b[1]}`) });
    }
  }
  // (3) every supplied room row names a final case
  const missingRoom = [];
  for (const coll of ROOM_COLLECTIONS) if (supplied[coll.name] !== undefined) for (const r of supplied[coll.name]) if (!finalCaseIds.has(r.roomId)) missingRoom.push([coll.table, r.id, r.roomId]);
  if (missingRoom.length) throw refusal('ROOM_CASE_MISSING', `${missingRoom.length} room row(s) in ${label} name a case that is not in the final recruitmentCases collection (${ids(missingRoom.map((m) => `${m[0]} ${m[1]} → ${m[2]}`))}); the write was rolled back and nothing was changed`, { rows: missingRoom.map((m) => `${m[0]} ${m[1]}`) });
  // the decision chain over the final decisions, ids only
  const finalDecisions = final(DECISIONS).filter(isPlainObject); const decIds = idSet(finalDecisions); const broken = [];
  for (const d of finalDecisions) for (const k of ['supersedes', 'supersededById']) if (nonEmpty(d[k]) && !decIds.has(d[k])) broken.push(`${d.id} names ${d[k]} (${k})`);
  if (broken.length) throw refusal('DECISION_CHAIN_BROKEN', `${broken.length} decision chain reference(s) in ${label} name a decision that is not in the final roomDecisions collection (${ids(broken)}); the write was rolled back and nothing was changed`, { links: broken });
  // the organisation and staff keys (RESTRICT): named here with ids, against the FINAL collections when the snapshot supplies them, the tables otherwise
  const orgIds = orgs !== undefined ? idSet(orgs) : tableExists(sqlite, 'orgs') ? new Set(sqlite.prepare('SELECT id FROM orgs').all().map((r) => r.id)) : null;
  const userIds = users !== undefined ? idSet(users) : tableExists(sqlite, 'org_users') ? new Set(sqlite.prepare('SELECT id FROM org_users').all().map((r) => r.id)) : null;
  const noOrg = []; const noUser = [];
  for (const coll of ALL_COLLECTIONS) {
    const list = supplied[coll.name]; if (list === undefined) continue;
    for (const r of list) {
      if (orgIds && !orgIds.has(r.orgId)) noOrg.push([coll.table, r.id, r.orgId]);
      if (!userIds) continue;
      if (coll === CASES) {
        if (!userIds.has(r.ownerUserId)) noUser.push([coll.table, r.id, r.ownerUserId]);
        if (isPlainObject(r.room) && nonEmpty(r.room.leadScoutUserId) && !userIds.has(r.room.leadScoutUserId)) noUser.push([coll.table, r.id, r.room.leadScoutUserId]);
        if (isPlainObject(r.decision) && nonEmpty(r.decision.byUserId) && !userIds.has(r.decision.byUserId)) noUser.push([coll.table, r.id, r.decision.byUserId]);
        for (const a of Array.isArray(r.assignments) ? r.assignments : []) if (isPlainObject(a) && nonEmpty(a.userId) && !userIds.has(a.userId)) noUser.push(['case_assignments', r.id, a.userId]);
      } else if (coll === COMMENTS && !userIds.has(r.authorId)) noUser.push([coll.table, r.id, r.authorId]);
    }
  }
  if (noOrg.length) throw refusal('RECRUITMENT_CASES_ORG_MISSING', `${noOrg.length} row(s) in ${label} name an organisation that does not exist in the final orgs table (${ids(noOrg.map((x) => `${x[0]} ${x[1]}`))}; organisations ${ids([...new Set(noOrg.map((x) => x[2]))])}); the write was rolled back and nothing was changed`, { rows: noOrg.map((x) => x[1]) });
  if (noUser.length) throw refusal('RECRUITMENT_CASES_USER_MISSING', `${noUser.length} row(s) in ${label} name a staff member that does not exist in the final org_users table (${ids(noUser.map((x) => `${x[0]} ${x[1]}`))}; staff ${ids([...new Set(noUser.map((x) => x[2]))])}); the write was rolled back and nothing was changed`, { rows: noUser.map((x) => x[1]) });
  // the tolerant player references (Q8a), counted: cases, snapshots, decisions and the handoffs of the supplied cases
  if (tableExists(sqlite, 'players')) {
    const live = new Set(sqlite.prepare('SELECT id FROM players WHERE deleted_at IS NULL').all().map((r) => r.id)); const retained = new Set(sqlite.prepare('SELECT id FROM players WHERE deleted_at IS NOT NULL').all().map((r) => r.id));
    const count = (pid) => { if (live.has(pid)) counts.players.live += 1; else if (retained.has(pid)) counts.players.retained += 1; else counts.players.missing += 1; };
    for (const c of supplied.recruitmentCases ?? []) { count(c.playerId); if (isPlainObject(c.transactionHandoff) && presentKey(c.transactionHandoff, 'playerId')) count(c.transactionHandoff.playerId); }
    for (const coll of [SNAPSHOTS, DECISIONS]) for (const r of supplied[coll.name] ?? []) if (presentKey(r, 'playerId')) count(r.playerId);
  }
  return { counts, departingCases };
}

// ------------------------------------------------------------------ the stages against the tables (inside the caller's transaction)
/** A: the supplied cases upserted with their owned children; their link rows are deleted here and rewritten at C (after the S8a phases); `only` restricts to the given ids. */
export function stageCases(sqlite, cases, { only = null } = {}) { const S = stmts(sqlite); for (const c of cases) if (!only || only.has(c.id)) { writeRecord(sqlite, CASES, c, { include: notLinks }); S.children.case_request_links.deleteOwner.run(c.id); S.children.case_trial_links.deleteOwner.run(c.id); } }
/**
 * R: release the link rows B or F2 would hit. The supplied cases' rows were deleted at A (rewritten at C). The rows of
 * RETAINED cases naming a trial of the departure set or a pruned request are memorised verbatim and deleted; the
 * supplied-or-pruned cases' remaining rows (a pruned case) are deleted. Returns the memo for C.
 */
export function releaseLinks(sqlite, { departures, rewritten, pruned }) {
  const S = stmts(sqlite); const memo = [];
  const skip = new Set([...rewritten, ...pruned]);
  const release = (table, targets, kind) => {
    if (!targets.length) return;
    for (const row of S.linkRowsNaming[kind](targets.length).all(...targets)) { if (!skip.has(row.case_id)) memo.push({ table, row: { ...row } }); S.deleteLinkRow[table].run(row.case_id, row.position); }
  };
  release('case_trial_links', departures.trials, 'trials'); release('case_request_links', departures.requests, 'requests');
  for (const id of pruned) { S.children.case_request_links.deleteOwner.run(id); S.children.case_trial_links.deleteOwner.run(id); }
  return memo;
}
/** C: the supplied cases' link rows in list order; the memorised rows of the retained cases back verbatim. */
export function stageLinks(sqlite, cases, memo, { only = null } = {}) {
  const S = stmts(sqlite);
  for (const c of cases) if (!only || only.has(c.id)) writeRecord(sqlite, CASES, c, { include: onlyLinks, upsertParent: false });
  for (const { table, row } of memo) S.children[table].insert.run(row);
}
/** D: the supplied room collections upserted (the formal decisions' key rows rewritten with them). */
export function stageRooms(sqlite, supplied, { only = null } = {}) { for (const coll of ROOM_COLLECTIONS) for (const r of supplied[coll.name] ?? []) if (!only || only[coll.name].has(r.id)) writeRecord(sqlite, coll, r); }
/** F1: the rows a SUPPLIED room collection no longer lists (their key rows first). `gone` maps a collection name to the ids to remove. */
export function pruneRooms(sqlite, gone) { const S = stmts(sqlite); for (const coll of ROOM_COLLECTIONS) for (const id of gone[coll.name] ?? []) { deleteOwnedKeyRows(sqlite, coll, id); S.parents[coll.name].del.run(id); } }
/** F3: the cases no longer listed — each departing owner's RESTRICT-owned history rows and the key rows of its owned draft/handoff explicitly, THEN the parent (the cascades follow). */
export function pruneCases(sqlite, gone) { const S = stmts(sqlite); for (const id of gone) { S.historyOf.run(id); deleteOwnedKeyRows(sqlite, CASES, id); S.deleteCase.run(id); } }
/** G: the final assertions, ids only — every link target present, the decision chain over the final table state, foreign_key_check empty on the tables this step owns and the two it keyed. */
export function assertCasesConsistent(sqlite, { label = 'the snapshot' } = {}) {
  if (!recruitmentCasesLive(sqlite)) return;
  const danglingR = sqlite.prepare('SELECT l.case_id, l.request_id FROM case_request_links l LEFT JOIN recruitment_requests r ON r.id = l.request_id WHERE l.request_id IS NOT NULL AND r.id IS NULL').all();
  const danglingT = sqlite.prepare('SELECT l.case_id, l.trial_id FROM case_trial_links l LEFT JOIN trials t ON t.id = l.trial_id WHERE l.trial_id IS NOT NULL AND t.id IS NULL').all();
  if (danglingR.length || danglingT.length) throw refusal('CASE_LINK_DANGLING', `${danglingR.length + danglingT.length} case link(s) in ${label} name a request or trial that is not in the final tables (${ids([...danglingR.map((r) => `case ${r.case_id} links request ${r.request_id}`), ...danglingT.map((r) => `case ${r.case_id} links trial ${r.trial_id}`)])}); the write was rolled back and nothing was changed`);
  const chain = sqlite.prepare('SELECT d.id, d.supersedes_id, d.superseded_by_id FROM room_decisions d WHERE (d.supersedes_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM room_decisions x WHERE x.id = d.supersedes_id)) OR (d.superseded_by_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM room_decisions x WHERE x.id = d.superseded_by_id))').all();
  if (chain.length) throw refusal('DECISION_CHAIN_BROKEN', `${chain.length} decision chain reference(s) in ${label} name a decision that is not in the final room_decisions table (${ids(chain.map((d) => `${d.id} names ${d.supersedes_id ?? d.superseded_by_id}`))}); the write was rolled back and nothing was changed`);
  const broken = [...RECRUITMENT_CASES_TABLES, 'recruitment_requests', 'trials'].flatMap((t) => sqlite.prepare(`PRAGMA foreign_key_check(${t})`).all());
  if (broken.length) throw refusal('RECRUITMENT_CASES_KEY_VIOLATION', `foreign_key_check found ${broken.length} broken reference(s) in ${label} (first: ${broken[0].table} rowid ${broken[0].rowid} → ${broken[0].parent}); the write was rolled back and nothing was changed`);
}
/** The counts of the admin report: rows naming a player that is not in the players table, and rows naming a retained record (Q8a: counted, never refused). */
const PLAYER_COUNT_TABLES = { recruitmentCases: 'recruitment_cases', roomSnapshots: 'room_snapshots', roomDecisions: 'room_decisions', caseTransactionHandoffs: 'case_transaction_handoffs' };
export function unresolvedPlayerReferences(sqlite) {
  if (!recruitmentCasesLive(sqlite)) return null;
  return Object.fromEntries(Object.entries(PLAYER_COUNT_TABLES).map(([k, t]) => [k, sqlite.prepare(`SELECT count(*) AS n FROM ${t} x WHERE x.player_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.player_id)`).get().n]));
}
export function retainedPlayerReferences(sqlite) {
  if (!recruitmentCasesLive(sqlite)) return null;
  return Object.fromEntries(Object.entries(PLAYER_COUNT_TABLES).map(([k, t]) => [k, sqlite.prepare(`SELECT count(*) AS n FROM ${t} x WHERE EXISTS (SELECT 1 FROM players p WHERE p.id = x.player_id AND p.deleted_at IS NOT NULL)`).get().n]));
}

// ------------------------------------------------------------------ whole-snapshot access (writeTableBacked / readTableBacked)
/** The ids-only stored side for an omitted collection (the preflight needs ids and references, never a decoded record). */
function storedRefs(sqlite) {
  return {
    recruitmentCases: sqlite.prepare('SELECT id FROM recruitment_cases ORDER BY seq').all().map((r) => ({ id: r.id })),
    roomComments: sqlite.prepare('SELECT id, room_id AS roomId FROM room_comments ORDER BY seq').all().map((r) => ({ ...r })),
    roomSnapshots: sqlite.prepare('SELECT id, room_id AS roomId FROM room_snapshots ORDER BY seq').all().map((r) => ({ ...r })),
    roomDecisions: sqlite.prepare('SELECT id, room_id AS roomId, supersedes_id AS supersedes, superseded_by_id AS supersededById FROM room_decisions ORDER BY seq').all().map((r) => ({ ...r })),
    roomEvidenceState: sqlite.prepare('SELECT id, room_id AS roomId FROM room_evidence_states ORDER BY seq').all().map((r) => ({ ...r })),
  };
}
/** The retained cases' link references (ids only) for the preflight when the cases are omitted. */
function storedCaseLinks(sqlite) {
  const cases = new Map(sqlite.prepare('SELECT id FROM recruitment_cases ORDER BY seq').all().map((r) => [r.id, { id: r.id, links: { requestIds: [], trialIds: [] } }]));
  for (const r of sqlite.prepare('SELECT case_id, request_id FROM case_request_links WHERE request_id IS NOT NULL').all()) cases.get(r.case_id)?.links.requestIds.push(r.request_id);
  for (const r of sqlite.prepare('SELECT case_id, trial_id FROM case_trial_links WHERE trial_id IS NOT NULL').all()) cases.get(r.case_id)?.links.trialIds.push(r.trial_id);
  return [...cases.values()];
}
const s8aRows = (sqlite) => ({ requests: sqlite.prepare('SELECT id, case_id AS caseId FROM recruitment_requests').all().map((r) => ({ ...r })), trials: sqlite.prepare('SELECT id, request_id AS requestId, case_id AS caseId FROM trials').all().map((r) => ({ ...r })) });
/** What the S8a phases will delete or reinsert for the supplied requests/trials against the tables (recruitment.mjs phase 2a and 5), ids only. */
function s8aDepartures(sqlite, { requests, trials }) {
  const out = { trials: [], requests: [] };
  if (trials !== undefined) { const byId = new Map(trials.filter(isPlainObject).map((t) => [t.id, t])); out.trials = sqlite.prepare('SELECT id, request_id FROM trials').all().filter((st) => { const t = byId.get(st.id); return !t || t.requestId !== st.request_id; }).map((st) => st.id); }
  if (requests !== undefined) { const keep = idSet(requests); out.requests = sqlite.prepare('SELECT id FROM recruitment_requests').all().map((r) => r.id).filter((id) => !keep.has(id)); }
  return out;
}
const suppliedOf = (db) => Object.fromEntries(RECRUITMENT_CASES_COLLECTIONS.map((n) => [n, Object.hasOwn(db, n) && db[n] !== undefined ? db[n] : undefined]));
export const RECRUITMENT_CASES_SNAPSHOT = {
  names: RECRUITMENT_CASES_COLLECTIONS,
  read(sqlite) { if (!recruitmentCasesLive(sqlite)) return null; return Object.fromEntries(RECRUITMENT_CASES_COLLECTIONS.map((n) => [n, READERS[n](sqlite)])); },
  /**
   * P, A and R for the supplied collections (any subset of the five) against the tables; returns the plan C, D, F1 and
   * F3 need (`null` before the cutover record: the caller writes the blobs). `requests`/`trials` are the snapshot's
   * supplied S8a collections (undefined when omitted). Runs inside the caller's transaction.
   */
  begin(sqlite, db, { requests, trials, orgs, users, label = 'the snapshot' } = {}) {
    if (!recruitmentCasesLive(sqlite)) return null;
    if (!sqlite.isTransaction) throw new Error('recruitmentCases: begin() runs inside the caller\'s transaction');
    const supplied = suppliedOf(db);
    const anyCases = RECRUITMENT_CASES_COLLECTIONS.some((n) => supplied[n] !== undefined);
    const anyS8a = requests !== undefined || trials !== undefined;
    if (!anyCases && !anyS8a) return null;
    const stored = storedRefs(sqlite); if (supplied.recruitmentCases === undefined) stored.recruitmentCases = storedCaseLinks(sqlite);
    const table = s8aRows(sqlite);
    const s8a = { requests: requests !== undefined ? requests : table.requests, trials: trials !== undefined ? trials : table.trials };
    const { counts, departingCases } = preflight(sqlite, supplied, { stored, s8a, orgs, users, label });
    const departures = s8aDepartures(sqlite, { requests, trials });
    if (supplied.recruitmentCases !== undefined) stageCases(sqlite, supplied.recruitmentCases);
    const rewritten = supplied.recruitmentCases === undefined ? [] : supplied.recruitmentCases.map((c) => c.id);
    const memo = releaseLinks(sqlite, { departures, rewritten, pruned: departingCases });
    const gone = {}; for (const coll of ROOM_COLLECTIONS) if (supplied[coll.name] !== undefined) { const keep = idSet(supplied[coll.name]); gone[coll.name] = stored[coll.name].map((r) => r.id).filter((id) => !keep.has(id)); }
    return { supplied, memo, departingCases, gone, counts, written: RECRUITMENT_CASES_COLLECTIONS.filter((n) => supplied[n] !== undefined) };
  },
  /** C and D after the S8a phases. */
  links(sqlite, plan) { if (plan) stageLinks(sqlite, plan.supplied.recruitmentCases ?? [], plan.memo); },
  rooms(sqlite, plan) { if (plan) stageRooms(sqlite, plan.supplied); },
  /** F1: the supplied room collections' prunes (before the S8a request prune and the cases). */
  pruneRooms(sqlite, plan) { if (plan) pruneRooms(sqlite, plan.gone); },
  /** F3: the cases no longer listed (after the S8a request prune, before the staff and organisations). */
  pruneCases(sqlite, plan) { if (plan) pruneCases(sqlite, plan.departingCases); },
  /** G. */
  assert(sqlite, { label } = {}) { assertCasesConsistent(sqlite, { label }); },
};

/**
 * Import the legacy (or exported) five blobs into the tables inside the migration's transaction (every entry validated,
 * the cross references checked against the file's S8a tables and the orgs/org_users tables, insertion in array order,
 * the blob rows retired). An absent blob imports nothing; a non-array, non-JSON or PRESENT-null blob refuses the step.
 * `s8a` names the two S8a phases the migration interleaves: `rebuildParents()` between A and C (the real case key).
 * Returns the counts the migration records (never a value).
 */
export function importRecruitmentCasesBlobs(sqlite, { rebuildParents = () => {} } = {}) {
  const read = (name) => { const row = tableExists(sqlite, 'collections') ? sqlite.prepare('SELECT value FROM collections WHERE name = ?').get(name) : null; if (!row) return undefined; try { return JSON.parse(row.value); } catch { throw blocked(`the ${name} blob is not valid JSON`); } };
  const supplied = {};
  for (const n of RECRUITMENT_CASES_COLLECTIONS) { const v = read(n); supplied[n] = v === undefined ? [] : v; if (!Array.isArray(supplied[n])) throw blocked(`the ${n} blob must be an array of entries (got ${describe(supplied[n])})`); }
  const live = recruitmentLive(sqlite);
  const s8a = live ? { requests: readRequests(sqlite), trials: readTrials(sqlite) } : { requests: [], trials: [] };
  let counts;
  try { ({ counts } = preflight(sqlite, supplied, { stored: { recruitmentCases: [], roomComments: [], roomSnapshots: [], roomDecisions: [], roomEvidenceState: [] }, s8a, label: 'the recruitment cases blobs' })); }
  catch (e) { if (e?.code && e.code !== 'RECRUITMENT_CASES_IMPORT_BLOCKED') throw blocked(e.message, { refusal: e.code, rows: e.rows, problems: e.problems }); throw e; } // one code for the operator (the step is blocked), the specific refusal in the detail
  stageCases(sqlite, supplied.recruitmentCases); // A
  rebuildParents(); // the two S8a parents gain the real case key (B's tables, no rows change)
  stageLinks(sqlite, supplied.recruitmentCases, []); // C
  stageRooms(sqlite, supplied); // D
  if (tableExists(sqlite, 'collections')) sqlite.prepare(`DELETE FROM collections WHERE name IN (${RECRUITMENT_CASES_COLLECTIONS.map(() => '?').join(', ')})`).run(...RECRUITMENT_CASES_COLLECTIONS);
  return counts;
}

// ------------------------------------------------------------------ the repository
/**
 * `unit` is the store's participant API ({ active(), join(work) }) or null; `staged` selects the server's write mode
 * (the four hooks must be registered in the order attachDataLayer registers them); `recruitment` is an accessor for the
 * S8a repository (its mirrors are the final requests/trials of a flush; its departures() the release set).
 */
export function createRecruitmentCasesRepository({ sqlite, now = Date.now, log = () => {}, unit = null, staged = false, recruitment = null } = {}) {
  if (!sqlite) throw new TypeError('the recruitment-cases repository needs a SQLite connection (node:sqlite); the five collections have no in-memory or JSON fallback');
  if (unit !== null && (typeof unit?.active !== 'function' || typeof unit?.join !== 'function')) throw new TypeError('the recruitment-cases repository needs the store\'s participant API `unit` ({ active(), join(work) }) or null');
  if (staged && !unit) throw new TypeError('the recruitment-cases repository in staged mode needs the store\'s participant API `unit` and the store must register its hooks');
  if (recruitment !== null && typeof recruitment !== 'function') throw new TypeError('the recruitment-cases repository takes `recruitment` as an accessor function returning the recruitment repository');
  void now;
  const cutover = sqlite.prepare('SELECT 1 FROM data_migrations WHERE id = ?');
  const refuse = (what) => { throw new TypeError(`${what} is written through the recruitment-cases repository (addCase / addComment / addSnapshot / addDecision / addEvidenceState / removeDecision), never directly on the in-memory collection; a record's own fields are edited in place and land in the next save`); };
  // The mirrors: plain, mutable records in insertion order; the views are read-only ARRAYS over them.
  const mirrors = Object.fromEntries(RECRUITMENT_CASES_COLLECTIONS.map((n) => [n, []]));
  const arrayView = (target, label) => markView(new Proxy(target, { set() { return refuse(`the ${label} collection`); }, deleteProperty() { return refuse(`the ${label} collection`); }, defineProperty() { return refuse(`the ${label} collection`); } }));
  const views = Object.fromEntries(RECRUITMENT_CASES_COLLECTIONS.map((n) => [n, arrayView(mirrors[n], n)]));
  // Change tracking reflects COMMITTED state only: id → the fingerprint of the record as last committed.
  const committed = Object.fromEntries(RECRUITMENT_CASES_COLLECTIONS.map((n) => [n, new Map()]));
  let inFlight = null; // the plan of the open save transaction: applied by commit(), discarded by rollback()
  const fp = (r) => JSON.stringify(r);
  const load = () => {
    for (const n of RECRUITMENT_CASES_COLLECTIONS) { mirrors[n].length = 0; committed[n].clear(); }
    if (!recruitmentCasesLive(sqlite)) return;
    for (const n of RECRUITMENT_CASES_COLLECTIONS) for (const r of READERS[n](sqlite)) { mirrors[n].push(r); committed[n].set(r.id, fp(r)); }
  };
  load();
  const inUnit = () => !!unit?.active?.();
  let hooksTaken = 0;
  const hookRefusal = (what) => new Error(`recruitmentCases: ${what} needs the repository's four save hooks registered with the store first (coreHook, linksHook, roomsHook, pruneHook around the recruitment and channels hooks): the hooks are how a save writes the changed records and how a unit of work's rollback restores this repository's memory`);
  const mutate = (fn) => { if (inUnit()) return unit.join(() => { if (hooksTaken < 4) throw hookRefusal('a write inside a unit of work'); return fn(); }); if (staged && hooksTaken < 4) throw hookRefusal('a write'); return fn(); };
  const casesHave = (id) => mirrors.recruitmentCases.some((c) => c.id === id);
  const add = (coll, record) => mutate(() => {
    const v = validateEntry(coll, record); if (!v.ok) throw new TypeError(`a ${coll.name} record needs the writer's literal: ${v.reason}`);
    if (mirrors[coll.name].some((r) => r.id === record.id)) throw new Error(`recruitmentCases: a ${coll.name} record with id ${record.id} already exists`);
    if (coll !== CASES && !casesHave(record.roomId)) throw refusal('ROOM_CASE_MISSING', `recruitmentCases: ${coll.table} ${record.id} names case ${record.roomId}, which is not in the recruitmentCases collection`);
    mirrors[coll.name].push(record); return record;
  });

  const repo = {
    attach() {
      if (!cutover.get(RECRUITMENT_CASES_MIGRATION)) throw new Error(`recruitmentCases: the cutover record ${RECRUITMENT_CASES_MIGRATION} is missing from data_migrations; the tables cannot be trusted as the source of truth`);
      load();
      log(`recruitment cases: ${RECRUITMENT_CASES_COLLECTIONS.map((n) => `${mirrors[n].length} ${n}`).join(', ')} loaded from the tables`);
      return { engine: 'sqlite', ...Object.fromEntries(RECRUITMENT_CASES_COLLECTIONS.map((n) => [n, mirrors[n].length])) };
    },
    reload() { load(); return RECRUITMENT_CASES_COLLECTIONS.reduce((a, n) => a + mirrors[n].length, 0); },
    casesView: views.recruitmentCases, commentsView: views.roomComments, snapshotsView: views.roomSnapshots, decisionsView: views.roomDecisions, evidenceView: views.roomEvidenceState,
    views,
    counts: () => Object.fromEntries(RECRUITMENT_CASES_COLLECTIONS.map((n) => [n, mirrors[n].length])),
    /** Changed or new records not yet in a committed save, plus removed ones. */
    pending: () => Object.fromEntries(RECRUITMENT_CASES_COLLECTIONS.map((n) => [n, mirrors[n].filter((r) => committed[n].get(r.id) !== fp(r)).length + [...committed[n].keys()].filter((id) => !mirrors[n].some((r) => r.id === id)).length])),
    /** A new record at the end (the former `db.<collection>.push`): the record itself is kept, validated like an import; a room row's case must exist (ids only). */
    addCase: (record) => add(CASES, record),
    addComment: (record) => add(COMMENTS, record),
    addSnapshot: (record) => add(SNAPSHOTS, record),
    addDecision: (record) => add(DECISIONS, record),
    addEvidenceState: (record) => add(EVIDENCE_STATES, record),
    /** The finalize route's transport-failure splice (decisionRoutes.mjs:392): the record leaves the mirror; a committed row is pruned by the next save, an uncommitted one lands nowhere. */
    removeDecision(record) { return mutate(() => { const i = mirrors.roomDecisions.indexOf(record); if (i < 0) return false; mirrors.roomDecisions.splice(i, 1); return true; }); },
    /** Every record in its legacy shape, detached (the admin backup). */
    exportCases: () => mirrors.recruitmentCases.map(copyRecord),
    exportRoomComments: () => mirrors.roomComments.map(copyRecord),
    exportRoomSnapshots: () => mirrors.roomSnapshots.map(copyRecord),
    exportRoomDecisions: () => mirrors.roomDecisions.map(copyRecord),
    exportRoomEvidenceState: () => mirrors.roomEvidenceState.map(copyRecord),
    exportAll: () => Object.fromEntries(RECRUITMENT_CASES_COLLECTIONS.map((n) => [n, mirrors[n].map(copyRecord)])),

    // ---------------------------------------------------------- the four save hooks (P A R | B | C | D F1 | E | F2 inside B's hook | F3 G)
    /** Hook 1 (before the recruitment hook): the preflight against the mirrors, A for the changed cases, R. */
    flushCore() {
      if (!sqlite.isTransaction) throw new Error('recruitmentCases.flushCore runs inside a save transaction; the store reports its commit or rollback afterwards');
      const changed = {}; const removed = {}; let touched = false;
      for (const n of RECRUITMENT_CASES_COLLECTIONS) { changed[n] = new Set(mirrors[n].filter((r) => committed[n].get(r.id) !== fp(r)).map((r) => r.id)); removed[n] = [...committed[n].keys()].filter((id) => !mirrors[n].some((r) => r.id === id)); if (changed[n].size || removed[n].length) touched = true; }
      const rec = recruitment ? recruitment() : null;
      const s8a = rec ? { requests: rec.requestsView, trials: rec.trialsView } : s8aRows(sqlite);
      const departures = rec ? rec.departures() : { trials: [], requests: [] };
      const s8aMoves = departures.trials.length + departures.requests.length > 0;
      if (!touched && !s8aMoves) { inFlight = { changed, removed, memo: [], plan: null }; return 0; }
      // the FINAL graph of a flush is the mirrors: every collection "supplied" (its changed records are what A, D write; its removed ids what F1, F3 prune)
      const supplied = Object.fromEntries(RECRUITMENT_CASES_COLLECTIONS.map((n) => [n, mirrors[n]]));
      for (const n of RECRUITMENT_CASES_COLLECTIONS) for (const id of changed[n]) { const r = mirrors[n].find((x) => x.id === id); const v = validateEntry(byName[n], r); if (!v.ok) throw new TypeError(`recruitmentCases: a ${n} record cannot be saved: ${v.reason}`); }
      const stored = storedRefs(sqlite);
      preflight(sqlite, supplied, { stored, s8a, only: changed, label: 'the save' });
      stageCases(sqlite, mirrors.recruitmentCases, { only: changed.recruitmentCases }); // A
      const memo = releaseLinks(sqlite, { departures, rewritten: [...changed.recruitmentCases], pruned: removed.recruitmentCases }); // R
      inFlight = { changed, removed, memo, plan: true };
      return RECRUITMENT_CASES_COLLECTIONS.reduce((a, n) => a + changed[n].size + removed[n].length, 0);
    },
    /** Hook 2 (after the recruitment hook): C. */
    flushLinks() { if (!inFlight?.plan) return; stageLinks(sqlite, mirrors.recruitmentCases, inFlight.memo, { only: inFlight.changed.recruitmentCases }); },
    /** Hook 3 (before the channels hook): D, F1. */
    flushRooms() { if (!inFlight?.plan) return; stageRooms(sqlite, Object.fromEntries(ROOM_COLLECTIONS.map((c) => [c.name, mirrors[c.name]])), { only: inFlight.changed }); pruneRooms(sqlite, inFlight.removed); },
    /** Hook 4 (after the channels hook; the S8a request prune ran inside the recruitment hook): F3, G. */
    flushPrune() { if (!inFlight?.plan) return; pruneCases(sqlite, inFlight.removed.recruitmentCases); assertCasesConsistent(sqlite, { label: 'the save (cases, rooms, requests and trials together)' }); },
    commit() { if (!inFlight) return; for (const n of RECRUITMENT_CASES_COLLECTIONS) { for (const id of inFlight.changed[n]) committed[n].set(id, fp(mirrors[n].find((x) => x.id === id))); for (const id of inFlight.removed[n]) committed[n].delete(id); } inFlight = null; },
    rollback() { inFlight = null; },
    /** Unit-of-work participation: the graph memento of the five mirrors, restored IN PLACE. The committed fingerprints are not part of it: they reflect committed state, which a rollback does not change. */
    snapshotState: () => ({ graph: captureGraph(RECRUITMENT_CASES_COLLECTIONS.map((n) => mirrors[n])) }),
    restoreState(state) { if (!state) return; inFlight = null; restoreGraph(state.graph); },
    coreHook: () => { hooksTaken += 1; return { flush: () => repo.flushCore(), commit: () => repo.commit(), rollback: () => repo.rollback(), snapshotState: () => repo.snapshotState(), restoreState: (s) => repo.restoreState(s) }; },
    linksHook: () => { hooksTaken += 1; return { flush: () => repo.flushLinks() }; },
    roomsHook: () => { hooksTaken += 1; return { flush: () => repo.flushRooms() }; },
    pruneHook: () => { hooksTaken += 1; return { flush: () => repo.flushPrune() }; },
  };
  return repo;
}
