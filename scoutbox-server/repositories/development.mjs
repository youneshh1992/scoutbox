/**
 * Development: objectives, drill-guidance reviews and the Development Hub.
 *
 * Records:
 *   - A development objective: one or two focused objectives grown from feedback a club published, the
 *     player's progress entries, the clubs it is shared with and the reassessments asked of the club. Items, their
 *     exercise references and baseline evidence, progress, shares, reassessments and their outcome evidence are ordered
 *     child rows. `completedAt` is not stored: no route sets it.
 *   - A drill-guidance review: a named person reviewed the recording guidance of a combine drill. The guidance
 *     itself is the same for every drill and lives in code (domains/development/objectives.mjs); a drill with no row is
 *     unreviewed.
 *   - The Development Hub: plans (with the organisations a player shared them with), goals (with an optional
 *     Combine target as columns), actions, evidence links (references only) and reviews (with the goal state they saw,
 *     its cited evidence references as rows). `supersededBy` is not stored: it is the review whose `supersedes` names
 *     this one. `shareScopes` are three flags.
 *   - History: every plan, goal, action and review keeps the append-only history `audit()` writes, all in one table
 *     whose rows name their plan (and their goal, action or review), so a plan's timeline is one indexed query. A
 *     detail is typed columns (`from`, `to`, `visibility`, `owner`, `kind`, `protocolId`, `note`), present keys only.
 *
 * WRITES are explicit: each record kind has `create(record)` and (except links, which are created and removed)
 * `update(id, (draft) => …)`; the result is typed whole and written at once, joined into the open unit of work, the
 * caller's open transaction, or a transaction of its own. An unknown field, a change to a field that never changes, a
 * history entry that changes or goes, and an update from inside its own update are refused.
 *
 * Queries decode deep-frozen records (in insertion order unless they say otherwise), a list's child rows in one batch.
 * Modules receive them as `developmentReads`.
 *
 * References. Player, guardian and evidence ids carry no key (tolerant: an account deletion removes the player's
 * evidence and leaves these rows under the old id); nor do a cited record's id (polymorphic), an action's
 * assignee or an actor's id. Organisations → orgs and the staff an objective names → org_users are immediate RESTRICT;
 * so are the keys between this domain's tables. Child rows (items, progress, shares, history, snapshots) cascade with
 * their owner, which is never deleted (only an evidence link is, by its route).
 */
import { isPlainObject, ids, describe } from './recruitment.mjs';
import { transaction, migrationApplied, childRowsOf } from './database.mjs';
import { deepFreeze } from '../domains/platform/values.mjs';
import {
  text,
  int,
  num,
  bool,
  oneOf,
  group,
  tableDdl,
  bad,
  typeSpec,
  encode,
  decode,
  upsertSql,
  insertSql,
  flat,
} from './fieldSpecs.mjs';
import {
  PLAN_OWNER_KINDS,
  PLAN_VISIBILITY,
  VISIBILITY_BY_OWNER,
  PLAN_STATUSES,
  GOAL_CATEGORIES,
  GOAL_STATUSES,
  BLOCK_REASONS,
  ACTION_TYPES,
  ACTION_STATUSES,
  ASSIGNEE_KINDS,
  EVIDENCE_SOURCES,
  REVIEWER_KINDS,
  SHARE_SCOPES,
  PLAN_TEMPLATES,
  DEVELOPMENT_HUB_LIMITS,
  completionPhrase,
} from '../domains/development/hub/shared.mjs';
import {
  TARGET_SOURCES,
  TARGET_OPERATORS,
  TARGET_STATES,
  NO_MEASUREMENT_REASONS,
} from '../domains/development/hub/targets.mjs';

export const DEVELOPMENT_MIGRATION = '0030_development';
export const DEVELOPMENT_COLLECTIONS = Object.freeze([
  'devObjectives',
  'drillGuidance',
  'developmentPlans',
  'developmentGoals',
  'developmentActions',
  'developmentEvidenceLinks',
  'developmentReviews',
]);

// ------------------------------------------------------------------ vocabularies and limits (one definition; the routes import them)
export const OBJECTIVE_ACTOR_KINDS = Object.freeze(['player', 'guardian']);
export const OBJECTIVE_STATUSES = Object.freeze(['active']);
export const REASSESSMENT_STATUSES = Object.freeze(['requested', 'completed']);
/** Who writes a Hub record: `org` carries a staff id (actorOf in domains/development/hub/index.mjs). */
export const HUB_ACTOR_KINDS = Object.freeze(['player', 'guardian', 'org']);
/** Every history action the Hub writes: the timeline's vocabulary (TIMELINE_ACTIONS) and the status route's fallback. */
export const DEVELOPMENT_HISTORY_ACTIONS = Object.freeze([
  'plan_created',
  'plan_activated',
  'plan_paused',
  'plan_completed',
  'plan_archived',
  'plan_shared',
  'plan_unshared',
  'plan_visibility_changed',
  'plan_updated',
  'goal_created',
  'goal_updated',
  'goal_status_changed',
  'goal_target_set',
  'action_created',
  'action_status_changed',
  'action_completed',
  'evidence_linked',
  'evidence_unlinked',
  'review_submitted',
  'review_shared',
  'review_superseded',
]);
/** The Combine vocabulary a target freezes (domains/development/boxcam/combineShared.mjs COMBINE_PROTOCOLS). */
export const TARGET_METRIC_TYPES = Object.freeze(['count', 'time', 'distance', 'duration', 'set', 'percentage']);
export const TARGET_DIRECTIONS = Object.freeze(['higher', 'lower']);
export const TARGET_PRECISIONS = Object.freeze(['integer', 'tenths', 'hundredths', 'centimetres']);
/** Text limits. Over a limit is refused at the route (domains/development/schemas.mjs), never shortened. */
export const DEVELOPMENT_LIMITS = Object.freeze({
  id: 80,
  name: 200,
  objectiveItems: 2,
  objectiveText: 200,
  exerciseRefs: 4,
  exerciseRef: 200,
  evidenceIds: 50,
  progressNote: 300,
  outcomeNote: 500,
  reviewer: 60,
  detail: 40,
  metricUnit: 40,
  protocolTitle: 120,
  title: DEVELOPMENT_HUB_LIMITS.titleMax,
  description: DEVELOPMENT_HUB_LIMITS.descriptionMax,
  blockNote: DEVELOPMENT_HUB_LIMITS.blockNoteMax,
  summary: DEVELOPMENT_HUB_LIMITS.summaryMax,
  note: DEVELOPMENT_HUB_LIMITS.noteMax,
});
const L = DEVELOPMENT_LIMITS;

// ------------------------------------------------------------------ field specs
const idf = (k, c, o = {}) => text(k, c, L.id, { nonEmpty: true, ...o });
const req = { req: true };
const actor = (k, prefix, kinds) =>
  group(k, [
    oneOf('kind', `${prefix}_kind`, kinds, req),
    idf('id', `${prefix}_id`, req),
    text('name', `${prefix}_name`, L.name),
  ]);
const revFields = () => [
  int('rev', 'rev', req),
  int('revAt', 'rev_at'),
  group('revBy', [idf('userId', 'rev_by_user_id', req), text('name', 'rev_by_name', L.name)], { nullable: true }),
];

const OBJECTIVE_SPEC = [
  idf('id', 'id', req),
  idf('playerId', 'player_id', req),
  idf('sourceFeedbackId', 'source_assessment_id', req),
  idf('orgId', 'org_id', req),
  group('reviewer', [
    idf('userId', 'reviewer_user_id', req),
    text('name', 'reviewer_name', L.name),
    text('orgName', 'reviewer_org_name', L.name),
  ]),
  int('reviewAt', 'review_at'),
  oneOf('status', 'status', OBJECTIVE_STATUSES, req),
  actor('createdBy', 'created_by', OBJECTIVE_ACTOR_KINDS),
  int('createdAt', 'created_at', req),
];
const ITEM_SPEC = [idf('id', 'id', req), text('text', 'text', L.objectiveText, { req: true, nonEmpty: true })];
const PROGRESS_SPEC = [
  idf('id', 'id', req),
  int('at', 'at', req),
  idf('objectiveId', 'item_id'),
  text('note', 'note', L.progressNote),
  idf('evidenceId', 'evidence_id'),
];
const REASSESSMENT_SPEC = [
  idf('id', 'id', req),
  actor('requestedBy', 'requested_by', OBJECTIVE_ACTOR_KINDS),
  int('requestedAt', 'requested_at', req),
  oneOf('status', 'status', REASSESSMENT_STATUSES, req),
];
const OUTCOME_SPEC = [
  text('note', 'outcome_note', L.outcomeNote, { req: true, nonEmpty: true }),
  idf('byUserId', 'outcome_by_user_id', req),
  text('byName', 'outcome_by_name', L.name),
  int('at', 'outcome_at', req),
];
const DRILL_SPEC = [
  idf('drillId', 'drill_id', req),
  text('reviewer', 'reviewer', L.reviewer, { req: true, nonEmpty: true }),
  int('reviewedAt', 'reviewed_at', req),
];

const PLAN_SPEC = [
  idf('id', 'id', req),
  idf('playerId', 'player_id', req),
  group('owner', [
    oneOf('kind', 'owner_kind', PLAN_OWNER_KINDS, req),
    idf('orgId', 'owner_org_id'),
    text('orgName', 'owner_org_name', L.name),
  ]),
  actor('createdBy', 'created_by', HUB_ACTOR_KINDS),
  text('title', 'title', L.title, { req: true, nonEmpty: true }),
  oneOf('status', 'status', PLAN_STATUSES, req),
  oneOf('visibility', 'visibility', PLAN_VISIBILITY, req),
  int('startDate', 'start_at', req),
  int('nextReviewAt', 'next_review_at'),
  int('endDate', 'end_at'),
  oneOf(
    'templateId',
    'template_id',
    PLAN_TEMPLATES.map((t) => t.id),
  ),
  idf('originObjectiveId', 'origin_objective_id'),
  int('createdAt', 'created_at', req),
  int('updatedAt', 'updated_at', req),
  ...revFields(),
  int('completedAt', 'completed_at'),
  int('archivedAt', 'archived_at'),
];
const TARGET_SPEC = [
  oneOf('sourceType', 'target_source_type', TARGET_SOURCES, req),
  idf('protocolId', 'target_protocol_id', req),
  int('protocolVersion', 'target_protocol_version', req),
  oneOf('metricType', 'target_metric_type', TARGET_METRIC_TYPES, req),
  text('metricUnit', 'target_metric_unit', L.metricUnit, { req: true, nonEmpty: true }),
  oneOf('operator', 'target_operator', TARGET_OPERATORS, req),
  num('value', 'target_value', req),
  text('protocolTitle', 'target_protocol_title', L.protocolTitle, { req: true, nonEmpty: true }),
  oneOf('direction', 'target_direction', TARGET_DIRECTIONS, req),
  oneOf('precision', 'target_precision', TARGET_PRECISIONS, req),
];
const GOAL_SPEC = [
  idf('id', 'id', req),
  idf('planId', 'plan_id', req),
  idf('playerId', 'player_id', req),
  text('title', 'title', L.title, { req: true, nonEmpty: true }),
  text('description', 'description', L.description),
  oneOf('category', 'category', GOAL_CATEGORIES, req),
  oneOf('status', 'status', GOAL_STATUSES, req),
  oneOf('blockReason', 'block_reason', BLOCK_REASONS),
  text('blockNote', 'block_note', L.blockNote),
  int('targetDate', 'target_at'),
  group('target', TARGET_SPEC, { nullable: true }),
  idf('originObjectiveId', 'origin_objective_id'),
  actor('createdBy', 'created_by', HUB_ACTOR_KINDS),
  int('createdAt', 'created_at', req),
  int('updatedAt', 'updated_at', req),
  int('completedAt', 'completed_at'),
  ...revFields(),
];
const ACTION_SPEC = [
  idf('id', 'id', req),
  idf('planId', 'plan_id', req),
  idf('goalId', 'goal_id', req),
  idf('playerId', 'player_id', req),
  oneOf('type', 'type', ACTION_TYPES, req),
  text('title', 'title', L.title, { req: true, nonEmpty: true }),
  int('dueAt', 'due_at'),
  group(
    'assignee',
    [
      oneOf('kind', 'assignee_kind', ASSIGNEE_KINDS, req),
      idf('id', 'assignee_id', req),
      text('name', 'assignee_name', L.name),
    ],
    { nullable: true },
  ),
  oneOf('status', 'status', ACTION_STATUSES, req),
  actor('createdBy', 'created_by', HUB_ACTOR_KINDS),
  int('createdAt', 'created_at', req),
  int('updatedAt', 'updated_at', req),
  int('completedAt', 'completed_at'),
];
/** Exactly the keys of EVIDENCE_LINK_FIELDS (domains/development/hub/evidence.mjs): a link holds a reference and no content. */
const LINK_SPEC = [
  idf('id', 'id', req),
  idf('planId', 'plan_id', req),
  idf('goalId', 'goal_id'),
  idf('actionId', 'action_id'),
  idf('playerId', 'player_id', req),
  oneOf('sourceType', 'source_type', EVIDENCE_SOURCES, req),
  idf('sourceId', 'source_id', req),
  oneOf('linkedByKind', 'linked_by_kind', HUB_ACTOR_KINDS, req),
  idf('linkedById', 'linked_by_id', req),
  text('linkedByName', 'linked_by_name', L.name),
  int('linkedAt', 'linked_at', req),
];
const REVIEW_SPEC = [
  idf('id', 'id', req),
  idf('planId', 'plan_id', req),
  idf('playerId', 'player_id', req),
  oneOf('reviewerKind', 'reviewer_kind', REVIEWER_KINDS, req),
  actor('reviewedBy', 'reviewed_by', HUB_ACTOR_KINDS),
  idf('orgId', 'org_id'),
  int('reviewedAt', 'reviewed_at', req),
  text('sharedSummary', 'shared_summary', L.summary),
  text('internalNote', 'internal_note', L.note),
  int('nextReviewAt', 'next_review_at'),
  int('sharedWithPlayerAt', 'shared_with_player_at'),
  idf('supersedes', 'supersedes_review_id'),
  int('createdAt', 'created_at', req),
];
const SNAPSHOT_SPEC = [
  idf('goalId', 'goal_id', req),
  text('title', 'title', L.title, { req: true, nonEmpty: true }),
  oneOf('category', 'category', GOAL_CATEGORIES, req),
  oneOf('status', 'status', GOAL_STATUSES, req),
  group('actionCounts', [
    int('total', 'actions_total', req),
    int('done', 'actions_done', req),
    int('blocked', 'actions_blocked', req),
    int('cancelled', 'actions_cancelled', req),
  ]),
  group(
    'targetStateAtReview',
    [
      oneOf('state', 'target_state', TARGET_STATES, req),
      oneOf('reason', 'target_reason', NO_MEASUREMENT_REASONS),
      num('measured', 'target_measured'),
    ],
    { nullable: true },
  ),
];
const HISTORY_SPEC = [
  idf('id', 'id', req),
  int('at', 'at', req),
  oneOf('byKind', 'by_kind', HUB_ACTOR_KINDS, req),
  idf('byId', 'by_id', req),
  text('byName', 'by_name', L.name),
  oneOf('action', 'action', DEVELOPMENT_HISTORY_ACTIONS, req),
];
const DETAIL_SPEC = [
  text('from', 'detail_from', L.detail, { nonEmpty: true }),
  text('to', 'detail_to', L.detail, { nonEmpty: true }),
  oneOf('visibility', 'detail_visibility', PLAN_VISIBILITY),
  oneOf('owner', 'detail_owner', PLAN_OWNER_KINDS),
  text('kind', 'detail_kind', L.detail, { nonEmpty: true }),
  idf('protocolId', 'detail_protocol_id'),
  bool('note', 'detail_note'),
];

// ------------------------------------------------------------------ DDL (generated from the specs)
const rowOf = (name, c) => `FOREIGN KEY (${c}) REFERENCES ${name}(id) ON DELETE RESTRICT`;
const ownedBy = (name, c) => `FOREIGN KEY (${c}) REFERENCES ${name}(id) ON DELETE CASCADE`;
const ord = (c = 'ord', max = null) =>
  `${c.padEnd(40)} INTEGER NOT NULL CHECK (${c} >= 0${max ? ` AND ${c} < ${max}` : ''})`;
const idCol = (c) => `${c.padEnd(40)} TEXT NOT NULL CHECK (length(${c}) > 0 AND length(${c}) <= ${L.id})`;
const enumIn = (vals) => vals.map((v) => `'${v}'`).join(',');
export const DEVELOPMENT_DDL = [
  tableDdl('dev_objectives', OBJECTIVE_SPEC, [rowOf('orgs', 'org_id'), rowOf('org_users', 'reviewer_user_id')]),
  'CREATE INDEX dev_objectives_player ON dev_objectives (player_id);',
  tableDdl(
    'dev_objective_items',
    [ITEM_SPEC[0], idf('objectiveId', 'objective_id', req), ...ITEM_SPEC.slice(1)],
    [
      `  ${ord('ord', L.objectiveItems)}`.trim(),
      ownedBy('dev_objectives', 'objective_id'),
      'UNIQUE (objective_id, ord)',
    ],
  ),
  `CREATE TABLE dev_objective_item_exercises (\n  ${idCol('item_id')},\n  ${ord('ord', L.exerciseRefs)},\n  ${'ref'.padEnd(40)} TEXT NOT NULL CHECK (length(ref) > 0 AND length(ref) <= ${L.exerciseRef}),\n  ${ownedBy('dev_objective_items', 'item_id')},\n  PRIMARY KEY (item_id, ord)\n) STRICT;`,
  `CREATE TABLE dev_objective_item_evidence (\n  ${idCol('item_id')},\n  ${ord('ord', L.evidenceIds)},\n  ${idCol('evidence_id')},\n  ${ownedBy('dev_objective_items', 'item_id')},\n  PRIMARY KEY (item_id, ord),\n  UNIQUE (item_id, evidence_id)\n) STRICT;`,
  tableDdl(
    'dev_objective_progress',
    [PROGRESS_SPEC[0], idf('parentId', 'objective_id', req), ...PROGRESS_SPEC.slice(1)],
    [ownedBy('dev_objectives', 'objective_id'), ownedBy('dev_objective_items', 'item_id')],
  ),
  'CREATE INDEX dev_objective_progress_objective ON dev_objective_progress (objective_id);',
  `CREATE TABLE dev_objective_shares (\n  ${idCol('objective_id')},\n  ${ord()},\n  ${idCol('org_id')},\n  ${ownedBy('dev_objectives', 'objective_id')},\n  ${rowOf('orgs', 'org_id')},\n  PRIMARY KEY (objective_id, org_id),\n  UNIQUE (objective_id, ord)\n) STRICT;`,
  'CREATE INDEX dev_objective_shares_org ON dev_objective_shares (org_id);',
  tableDdl(
    'dev_objective_reassessments',
    [
      REASSESSMENT_SPEC[0],
      idf('parentId', 'objective_id', req),
      ...REASSESSMENT_SPEC.slice(1),
      ...OUTCOME_SPEC.map((f) => ({ ...f, req: false })),
    ],
    [
      ownedBy('dev_objectives', 'objective_id'),
      rowOf('org_users', 'outcome_by_user_id'),
      "CHECK ((status = 'completed') = (outcome_at IS NOT NULL))",
      'CHECK ((outcome_at IS NULL) = (outcome_note IS NULL) AND (outcome_at IS NULL) = (outcome_by_user_id IS NULL))',
    ],
  ),
  'CREATE INDEX dev_objective_reassessments_objective ON dev_objective_reassessments (objective_id);',
  "CREATE UNIQUE INDEX dev_objective_reassessments_open ON dev_objective_reassessments (objective_id) WHERE status = 'requested';",
  `CREATE TABLE dev_objective_reassessment_evidence (\n  ${idCol('reassessment_id')},\n  ${ord('ord', L.evidenceIds)},\n  ${idCol('evidence_id')},\n  ${ownedBy('dev_objective_reassessments', 'reassessment_id')},\n  PRIMARY KEY (reassessment_id, ord),\n  UNIQUE (reassessment_id, evidence_id)\n) STRICT;`,
  tableDdl('drill_guidance', DRILL_SPEC, ['PRIMARY KEY (drill_id)']),
  tableDdl('development_plans', PLAN_SPEC, [
    rowOf('orgs', 'owner_org_id'),
    rowOf('dev_objectives', 'origin_objective_id'),
    "CHECK ((owner_kind = 'org') = (owner_org_id IS NOT NULL))",
    ...PLAN_OWNER_KINDS.map((k) => `CHECK (owner_kind <> '${k}' OR visibility IN (${enumIn(VISIBILITY_BY_OWNER[k])}))`),
    "CHECK (status <> 'completed' OR completed_at IS NOT NULL)", // a reopened plan keeps the instant it was last completed
    "CHECK (status <> 'archived' OR archived_at IS NOT NULL)",
  ]),
  'CREATE INDEX development_plans_player ON development_plans (player_id, owner_kind, owner_org_id, status);',
  'CREATE INDEX development_plans_owner_org ON development_plans (owner_org_id, updated_at);',
  `CREATE TABLE development_plan_shares (\n  ${idCol('plan_id')},\n  ${ord()},\n  ${idCol('org_id')},\n  ${ownedBy('development_plans', 'plan_id')},\n  ${rowOf('orgs', 'org_id')},\n  PRIMARY KEY (plan_id, org_id),\n  UNIQUE (plan_id, ord)\n) STRICT;`,
  'CREATE INDEX development_plan_shares_org ON development_plan_shares (org_id);',
  tableDdl('development_goals', GOAL_SPEC, [
    rowOf('development_plans', 'plan_id'),
    rowOf('dev_objectives', 'origin_objective_id'),
    "CHECK ((status = 'blocked') = (block_reason IS NOT NULL))",
    "CHECK (status = 'blocked' OR block_note IS NULL)",
    "CHECK ((status = 'achieved') = (completed_at IS NOT NULL))",
  ]),
  'CREATE INDEX development_goals_plan ON development_goals (plan_id);',
  tableDdl('development_actions', ACTION_SPEC, [
    rowOf('development_plans', 'plan_id'),
    rowOf('development_goals', 'goal_id'),
    "CHECK ((status = 'done') = (completed_at IS NOT NULL))",
  ]),
  'CREATE INDEX development_actions_plan ON development_actions (plan_id);',
  'CREATE INDEX development_actions_goal ON development_actions (goal_id);',
  tableDdl('development_evidence_links', LINK_SPEC, [
    rowOf('development_plans', 'plan_id'),
    rowOf('development_goals', 'goal_id'),
    rowOf('development_actions', 'action_id'),
    'CHECK ((goal_id IS NULL) <> (action_id IS NULL))',
  ]),
  'CREATE UNIQUE INDEX development_evidence_links_target_source ON development_evidence_links (coalesce(goal_id, action_id), source_type, source_id);',
  'CREATE INDEX development_evidence_links_plan ON development_evidence_links (plan_id);',
  tableDdl(
    'development_reviews',
    [
      ...REVIEW_SPEC,
      bool('shareSummary', 'share_summary', req),
      bool('shareGoals', 'share_goals', req),
      bool('shareActions', 'share_actions', req),
    ],
    [
      rowOf('development_plans', 'plan_id'),
      rowOf('orgs', 'org_id'),
      rowOf('development_reviews', 'supersedes_review_id'),
      'CHECK (shared_summary IS NOT NULL OR internal_note IS NOT NULL)',
      "CHECK ((reviewer_kind = 'coach_review') = (org_id IS NOT NULL))",
      "CHECK (reviewer_kind = 'coach_review' OR internal_note IS NULL)",
      'CHECK ((share_summary + share_goals + share_actions = 0) OR shared_with_player_at IS NOT NULL)',
    ],
  ),
  'CREATE INDEX development_reviews_plan ON development_reviews (plan_id);',
  'CREATE INDEX development_reviews_org ON development_reviews (org_id) WHERE org_id IS NOT NULL;',
  'CREATE UNIQUE INDEX development_reviews_supersedes ON development_reviews (supersedes_review_id) WHERE supersedes_review_id IS NOT NULL;',
  tableDdl(
    'development_review_snapshots',
    [idf('reviewId', 'review_id', req), int('ord', 'ord', req), ...SNAPSHOT_SPEC],
    [
      ownedBy('development_reviews', 'review_id'),
      rowOf('development_goals', 'goal_id'),
      'PRIMARY KEY (review_id, goal_id)',
      'UNIQUE (review_id, ord)',
      'CHECK (ord >= 0)',
      'CHECK (actions_total >= 0 AND actions_done >= 0 AND actions_blocked >= 0 AND actions_cancelled >= 0 AND actions_done + actions_blocked + actions_cancelled <= actions_total)',
    ],
  ),
  `CREATE TABLE development_review_snapshot_refs (\n  ${idCol('review_id')},\n  ${idCol('goal_id')},\n  ${ord()},\n  ${'source_type'.padEnd(40)} TEXT NOT NULL CHECK (source_type IN (${enumIn(EVIDENCE_SOURCES)})),\n  ${idCol('source_id')},\n  FOREIGN KEY (review_id, goal_id) REFERENCES development_review_snapshots(review_id, goal_id) ON DELETE CASCADE,\n  PRIMARY KEY (review_id, goal_id, ord)\n) STRICT;`,
  tableDdl(
    'development_history',
    [
      HISTORY_SPEC[0],
      idf('planId', 'plan_id', req),
      idf('goalId', 'goal_id'),
      idf('actionId', 'action_id'),
      idf('reviewId', 'review_id'),
      ...HISTORY_SPEC.slice(1),
      ...DETAIL_SPEC,
    ],
    [
      ownedBy('development_plans', 'plan_id'),
      ownedBy('development_goals', 'goal_id'),
      ownedBy('development_actions', 'action_id'),
      ownedBy('development_reviews', 'review_id'),
      'CHECK ((goal_id IS NOT NULL) + (action_id IS NOT NULL) + (review_id IS NOT NULL) <= 1)',
    ],
  ),
  'CREATE INDEX development_history_plan ON development_history (plan_id);',
  'CREATE INDEX development_history_goal ON development_history (goal_id) WHERE goal_id IS NOT NULL;',
  'CREATE INDEX development_history_action ON development_history (action_id) WHERE action_id IS NOT NULL;',
  'CREATE INDEX development_history_review ON development_history (review_id) WHERE review_id IS NOT NULL;',
].join('\n');
export const DEVELOPMENT_TABLES = Object.freeze([
  'dev_objectives',
  'dev_objective_items',
  'dev_objective_item_exercises',
  'dev_objective_item_evidence',
  'dev_objective_progress',
  'dev_objective_shares',
  'dev_objective_reassessments',
  'dev_objective_reassessment_evidence',
  'drill_guidance',
  'development_plans',
  'development_plan_shares',
  'development_goals',
  'development_actions',
  'development_evidence_links',
  'development_reviews',
  'development_review_snapshots',
  'development_review_snapshot_refs',
  'development_history',
]);

// ------------------------------------------------------------------ typing
export const refusal = (code, message, extra = {}) =>
  Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
/** A snapshot's completion sentence, worked out from its counts (never stored): the Hub's completionPhrase. */
const completionOf = (c) => completionPhrase(c);
const labelOf = (at, raw) => `${at} ${isPlainObject(raw) && typeof raw.id === 'string' ? raw.id : ''}`.trim();

/** A list of short texts (ids, references): each non-empty and within `itemMax`, at most `max`, none twice. */
function typeTextList(list, label, field, { max, itemMax = L.id, unique = true }) {
  if (list === undefined || list === null) return { ok: true, value: [] };
  if (!Array.isArray(list)) return bad(label, field, `must be a list (got ${describe(list)})`);
  if (list.length > max) return bad(label, field, `holds more than ${max} entries`);
  const i = list.findIndex((x) => typeof x !== 'string' || !x.length || x.length > itemMax);
  if (i >= 0)
    return bad(label, `${field}[${i}]`, `must be text of 1 to ${itemMax} characters (got ${describe(list[i])})`);
  if (unique && new Set(list).size !== list.length) return bad(label, field, 'names an entry twice');
  return { ok: true, value: [...list] };
}
function typeList(list, label, field, typer) {
  if (list === undefined) list = [];
  if (!Array.isArray(list)) return bad(label, field, `must be a list (got ${describe(list)})`);
  const out = [];
  for (const [i, x] of list.entries()) {
    const t = typer(x, `${label}.${field}[${i}]`);
    if (!t.ok) return t;
    out.push(t.record);
  }
  if (out.length && out[0] && typeof out[0].id === 'string' && new Set(out.map((x) => x.id)).size !== out.length)
    return bad(label, field, 'names an id twice');
  return { ok: true, value: out };
}
/** A history entry: `{ id, at, byKind, byId, byName, action, detail }`, the detail null or the typed keys it names. */
export function typeHistoryEntry(raw, at) {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  const { detail = null, ...rest } = raw;
  const t = typeSpec(HISTORY_SPEC, rest, at);
  if (!t.ok) return t;
  if (detail === null) return { ok: true, record: { ...t.record, detail: null } };
  const d = typeSpec(DETAIL_SPEC, detail, `${at}.detail`);
  if (!d.ok) return d;
  const kept = Object.fromEntries(Object.entries(d.record).filter(([, v]) => v !== null));
  if (!Object.keys(kept).length) return bad(at, 'detail', 'is null or names at least one field');
  return { ok: true, record: { ...t.record, detail: kept } };
}
const typeHistory = (list, label) => typeList(list, label, 'history', typeHistoryEntry);

function typeItem(raw, at) {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  const { exerciseRefs, baselineEvidenceIds, ...rest } = raw;
  const t = typeSpec(ITEM_SPEC, rest, at);
  if (!t.ok) return t;
  const refs = typeTextList(exerciseRefs, at, 'exerciseRefs', {
    max: L.exerciseRefs,
    itemMax: L.exerciseRef,
    unique: false,
  });
  if (!refs.ok) return refs;
  const ev = typeTextList(baselineEvidenceIds, at, 'baselineEvidenceIds', { max: L.evidenceIds });
  if (!ev.ok) return ev;
  return { ok: true, record: { ...t.record, exerciseRefs: refs.value, baselineEvidenceIds: ev.value } };
}
function typeReassessment(raw, at) {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  const { outcome = null, ...rest } = raw;
  const t = typeSpec(REASSESSMENT_SPEC, rest, at);
  if (!t.ok) return t;
  let out = null;
  if (outcome !== null) {
    if (!isPlainObject(outcome)) return bad(at, 'outcome', `must be an object or null (got ${describe(outcome)})`);
    const { evidenceIds, ...o } = outcome;
    const ot = typeSpec(OUTCOME_SPEC, o, `${at}.outcome`);
    if (!ot.ok) return ot;
    const ev = typeTextList(evidenceIds, `${at}.outcome`, 'evidenceIds', { max: L.evidenceIds });
    if (!ev.ok) return ev;
    out = {
      note: ot.record.note,
      evidenceIds: ev.value,
      byUserId: ot.record.byUserId,
      byName: ot.record.byName,
      at: ot.record.at,
    };
  }
  if ((t.record.status === 'completed') !== (out !== null))
    return bad(at, 'outcome', 'is recorded exactly when the reassessment is completed');
  return { ok: true, record: { ...t.record, outcome: out } };
}
/** A development objective: the flat columns, its items, progress, shares and reassessments. */
export function typeObjective(raw, at = 'devObjectives') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { objectives, progress = [], sharing = { orgIds: [] }, reassessments = [], ...flatPart } = raw;
  const t = typeSpec(OBJECTIVE_SPEC, flatPart, label);
  if (!t.ok) return t;
  if (!Array.isArray(objectives) || objectives.length < 1 || objectives.length > L.objectiveItems)
    return bad(label, 'objectives', `must list 1 to ${L.objectiveItems} objectives (got ${describe(objectives)})`);
  const items = typeList(objectives, label, 'objectives', typeItem);
  if (!items.ok) return items;
  const prog = typeList(progress, label, 'progress', (x, a) => typeSpec(PROGRESS_SPEC, x, a));
  if (!prog.ok) return prog;
  const itemIds = new Set(items.value.map((i) => i.id));
  const stray = prog.value.find((p) => p.objectiveId !== null && !itemIds.has(p.objectiveId));
  if (stray)
    return bad(
      label,
      'progress',
      `entry ${stray.id} names ${stray.objectiveId}, which is not one of this objective's items`,
    );
  if (!isPlainObject(sharing) || Object.keys(sharing).some((k) => k !== 'orgIds'))
    return bad(label, 'sharing', `must be { orgIds } (got ${describe(sharing)})`);
  const shares = typeTextList(sharing.orgIds, label, 'sharing.orgIds', { max: 10_000 });
  if (!shares.ok) return shares;
  const ras = typeList(reassessments, label, 'reassessments', typeReassessment);
  if (!ras.ok) return ras;
  if (ras.value.filter((r) => r.status === 'requested').length > 1)
    return bad(label, 'reassessments', 'holds more than one open request');
  return {
    ok: true,
    record: {
      ...t.record,
      objectives: items.value,
      progress: prog.value,
      sharing: { orgIds: shares.value },
      reassessments: ras.value,
    },
  };
}
export const typeDrillReview = (raw, at = 'drillGuidance') => typeSpec(DRILL_SPEC, raw, labelOf(at, raw));

function ownerConsistent(r, label) {
  if ((r.owner.kind === 'org') !== (r.owner.orgId !== null))
    return bad(label, 'owner.orgId', 'is set exactly when an organisation owns the plan');
  if (!VISIBILITY_BY_OWNER[r.owner.kind].includes(r.visibility))
    return bad(
      label,
      'visibility',
      `must be one of ${VISIBILITY_BY_OWNER[r.owner.kind].join('|')} for a ${r.owner.kind}-owned plan`,
    );
  return null;
}
/** A plan: the flat columns, the organisations it is shared with and its own history. */
export function typePlan(raw, at = 'developmentPlans') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { sharedWithOrgIds = [], history = [], ...flatPart } = raw;
  const t = typeSpec(PLAN_SPEC, flatPart, label);
  if (!t.ok) return t;
  const r = t.record;
  const bad1 = ownerConsistent(r, label);
  if (bad1) return bad1;
  const shares = typeTextList(sharedWithOrgIds, label, 'sharedWithOrgIds', { max: 10_000 });
  if (!shares.ok) return shares;
  if (shares.value.length && r.owner.kind !== 'player')
    return bad(label, 'sharedWithOrgIds', 'is for a player-owned plan only');
  if (r.status === 'completed' && r.completedAt === null)
    return bad(label, 'completedAt', 'is set once the plan is completed');
  if (r.status === 'archived' && r.archivedAt === null)
    return bad(label, 'archivedAt', 'is set once the plan is archived');
  const h = typeHistory(history, label);
  if (!h.ok) return h;
  return { ok: true, record: { ...r, sharedWithOrgIds: shares.value, history: h.value } };
}
export function typeGoal(raw, at = 'developmentGoals') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { history = [], ...flatPart } = raw;
  const t = typeSpec(GOAL_SPEC, flatPart, label);
  if (!t.ok) return t;
  const r = t.record;
  if ((r.status === 'blocked') !== (r.blockReason !== null))
    return bad(label, 'blockReason', 'is set exactly while the goal is blocked');
  if (r.status !== 'blocked' && r.blockNote !== null)
    return bad(label, 'blockNote', 'is kept only while the goal is blocked');
  if ((r.status === 'achieved') !== (r.completedAt !== null))
    return bad(label, 'completedAt', 'is set exactly while the goal is achieved');
  const h = typeHistory(history, label);
  if (!h.ok) return h;
  return { ok: true, record: { ...r, history: h.value } };
}
export function typeAction(raw, at = 'developmentActions') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { history = [], ...flatPart } = raw;
  const t = typeSpec(ACTION_SPEC, flatPart, label);
  if (!t.ok) return t;
  if ((t.record.status === 'done') !== (t.record.completedAt !== null))
    return bad(label, 'completedAt', 'is set exactly while the action is done');
  const h = typeHistory(history, label);
  if (!h.ok) return h;
  return { ok: true, record: { ...t.record, history: h.value } };
}
export function typeLink(raw, at = 'developmentEvidenceLinks') {
  const label = labelOf(at, raw);
  const t = typeSpec(LINK_SPEC, raw, label);
  if (!t.ok) return t;
  if ((t.record.goalId === null) === (t.record.actionId === null))
    return bad(label, 'goalId', 'or actionId names the holder: exactly one of the two');
  return t;
}
function typeSnapshot(raw, at) {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  const { evidenceRefs = [], completion: _derived, ...rest } = raw; // completion is worked out from the counts
  const t = typeSpec(SNAPSHOT_SPEC, rest, at);
  if (!t.ok) return t;
  const c = t.record.actionCounts;
  if ([c.total, c.done, c.blocked, c.cancelled].some((n) => n < 0) || c.done + c.blocked + c.cancelled > c.total)
    return bad(at, 'actionCounts', 'do not add up');
  const refs = typeList(evidenceRefs, at, 'evidenceRefs', (x, a) => {
    if (!isPlainObject(x) || Object.keys(x).some((k) => !['sourceType', 'sourceId'].includes(k)))
      return { ok: false, reason: `${a} must be { sourceType, sourceId } (got ${describe(x)})` };
    if (!EVIDENCE_SOURCES.includes(x.sourceType))
      return bad(a, 'sourceType', `must be one of ${EVIDENCE_SOURCES.join('|')}`);
    if (typeof x.sourceId !== 'string' || !x.sourceId.length || x.sourceId.length > L.id)
      return bad(a, 'sourceId', `must be an id (got ${describe(x.sourceId)})`);
    return { ok: true, record: { sourceType: x.sourceType, sourceId: x.sourceId } };
  });
  if (!refs.ok) return refs;
  return { ok: true, record: { ...t.record, completion: completionOf(c), evidenceRefs: refs.value } };
}
/** A review: the flat columns, the goal state it saw, its share scopes and its history. `supersededBy` is derived (accepted as given, never stored). */
export function typeReview(raw, at = 'developmentReviews') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { goalSnapshots = [], shareScopes = [], history = [], supersededBy: _derived, ...flatPart } = raw;
  const t = typeSpec(REVIEW_SPEC, flatPart, label);
  if (!t.ok) return t;
  const r = t.record;
  if (r.sharedSummary === null && r.internalNote === null)
    return bad(label, 'sharedSummary', 'or internalNote is required');
  if ((r.reviewerKind === 'coach_review') !== (r.orgId !== null))
    return bad(label, 'orgId', 'is set exactly on a coach review');
  if (r.reviewerKind !== 'coach_review' && r.internalNote !== null)
    return bad(label, 'internalNote', 'is written by the club only');
  const scopes = typeTextList(shareScopes, label, 'shareScopes', { max: SHARE_SCOPES.length });
  if (!scopes.ok) return scopes;
  const unknown = scopes.value.find((s) => !SHARE_SCOPES.includes(s));
  if (unknown) return bad(label, 'shareScopes', `names ${unknown}, not one of ${SHARE_SCOPES.join('|')}`);
  if (scopes.value.length && r.sharedWithPlayerAt === null)
    return bad(label, 'shareScopes', 'are set only once the review is shared');
  const snaps = typeList(goalSnapshots, label, 'goalSnapshots', typeSnapshot);
  if (!snaps.ok) return snaps;
  if (new Set(snaps.value.map((s) => s.goalId)).size !== snaps.value.length)
    return bad(label, 'goalSnapshots', 'names a goal twice');
  const h = typeHistory(history, label);
  if (!h.ok) return h;
  return {
    ok: true,
    record: {
      ...r,
      shareScopes: SHARE_SCOPES.filter((s) => scopes.value.includes(s)),
      goalSnapshots: snaps.value,
      history: h.value,
    },
  };
}

// ------------------------------------------------------------------ rows
function statements(sqlite) {
  const p = (sql) => sqlite.prepare(sql);
  const histCols = flat([
    HISTORY_SPEC[0],
    idf('planId', 'plan_id'),
    idf('goalId', 'goal_id'),
    idf('actionId', 'action_id'),
    idf('reviewId', 'review_id'),
    ...HISTORY_SPEC.slice(1),
    ...DETAIL_SPEC,
  ]).map((f) => f.c);
  return {
    objective: p(upsertSql('dev_objectives', OBJECTIVE_SPEC)),
    item: p('INSERT INTO dev_objective_items (id, objective_id, ord, text) VALUES (?, ?, ?, ?)'),
    exercise: p('INSERT INTO dev_objective_item_exercises (item_id, ord, ref) VALUES (?, ?, ?)'),
    itemEvidence: p('INSERT INTO dev_objective_item_evidence (item_id, ord, evidence_id) VALUES (?, ?, ?)'),
    progressOf: p('DELETE FROM dev_objective_progress WHERE objective_id = ?'),
    progress: p(
      'INSERT INTO dev_objective_progress (id, objective_id, at, item_id, note, evidence_id) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    sharesOf: p('DELETE FROM dev_objective_shares WHERE objective_id = ?'),
    share: p('INSERT INTO dev_objective_shares (objective_id, ord, org_id) VALUES (?, ?, ?)'),
    reassessmentsOf: p('DELETE FROM dev_objective_reassessments WHERE objective_id = ?'),
    reassessment: p(
      'INSERT INTO dev_objective_reassessments (id, objective_id, requested_by_kind, requested_by_id, requested_by_name, requested_at, status, outcome_note, outcome_by_user_id, outcome_by_name, outcome_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    reassessmentEvidence: p(
      'INSERT INTO dev_objective_reassessment_evidence (reassessment_id, ord, evidence_id) VALUES (?, ?, ?)',
    ),
    drill: p(upsertSql('drill_guidance', DRILL_SPEC, ['drill_id'])),
    plan: p(upsertSql('development_plans', PLAN_SPEC)),
    planSharesOf: p('DELETE FROM development_plan_shares WHERE plan_id = ?'),
    planShare: p('INSERT INTO development_plan_shares (plan_id, ord, org_id) VALUES (?, ?, ?)'),
    goal: p(upsertSql('development_goals', GOAL_SPEC)),
    action: p(upsertSql('development_actions', ACTION_SPEC)),
    link: p(insertSql('development_evidence_links', LINK_SPEC)),
    linkDel: p('DELETE FROM development_evidence_links WHERE id = ?'),
    review: p(
      upsertSql('development_reviews', [
        ...REVIEW_SPEC,
        bool('a', 'share_summary'),
        bool('b', 'share_goals'),
        bool('c', 'share_actions'),
      ]),
    ),
    snapshot: p(
      insertSql('development_review_snapshots', [idf('reviewId', 'review_id'), int('ord', 'ord'), ...SNAPSHOT_SPEC]),
    ),
    snapshotRef: p(
      'INSERT INTO development_review_snapshot_refs (review_id, goal_id, ord, source_type, source_id) VALUES (?, ?, ?, ?, ?)',
    ),
    history: p(
      `INSERT INTO development_history (${histCols.join(', ')}) VALUES (${histCols.map((c) => `@${c}`).join(', ')})`,
    ),
    historyTaken: p('SELECT 1 FROM development_history WHERE id = ?'),
  };
}
function writeObjective(st, rec, { isNew }) {
  st.objective.run(encode(OBJECTIVE_SPEC, rec));
  if (isNew) {
    rec.objectives.forEach((it, i) => {
      st.item.run(it.id, rec.id, i, it.text);
      it.exerciseRefs.forEach((r, j) => st.exercise.run(it.id, j, r));
      it.baselineEvidenceIds.forEach((e, j) => st.itemEvidence.run(it.id, j, e));
    });
  }
  st.progressOf.run(rec.id);
  st.sharesOf.run(rec.id);
  st.reassessmentsOf.run(rec.id);
  for (const g of rec.progress) st.progress.run(g.id, rec.id, g.at, g.objectiveId, g.note, g.evidenceId);
  rec.sharing.orgIds.forEach((o, i) => st.share.run(rec.id, i, o));
  for (const r of rec.reassessments) {
    const o = r.outcome;
    st.reassessment.run(
      r.id,
      rec.id,
      r.requestedBy.kind,
      r.requestedBy.id,
      r.requestedBy.name,
      r.requestedAt,
      r.status,
      o?.note ?? null,
      o?.byUserId ?? null,
      o?.byName ?? null,
      o?.at ?? null,
    );
    (o?.evidenceIds ?? []).forEach((e, j) => st.reassessmentEvidence.run(r.id, j, e));
  }
}
function writeHistory(st, entries, owner) {
  for (const h of entries) {
    if (st.historyTaken.get(h.id)) throw refusal('DEVELOPMENT_DUPLICATE', `development_history ${h.id} already exists`);
    const row = {
      ...encode(HISTORY_SPEC, h),
      plan_id: owner.planId,
      goal_id: owner.goalId ?? null,
      action_id: owner.actionId ?? null,
      review_id: owner.reviewId ?? null,
    };
    encode(DETAIL_SPEC, h.detail ?? {}, row);
    st.history.run(row);
  }
}
function writePlan(st, rec, { known = 0 } = {}) {
  st.plan.run(encode(PLAN_SPEC, rec));
  st.planSharesOf.run(rec.id);
  rec.sharedWithOrgIds.forEach((o, i) => st.planShare.run(rec.id, i, o));
  writeHistory(st, rec.history.slice(known), { planId: rec.id });
}
function writeGoal(st, rec, { known = 0 } = {}) {
  st.goal.run(encode(GOAL_SPEC, rec));
  writeHistory(st, rec.history.slice(known), { planId: rec.planId, goalId: rec.id });
}
function writeAction(st, rec, { known = 0 } = {}) {
  st.action.run(encode(ACTION_SPEC, rec));
  writeHistory(st, rec.history.slice(known), { planId: rec.planId, actionId: rec.id });
}
function writeReview(st, rec, { isNew, known = 0 }) {
  st.review.run({
    ...encode(REVIEW_SPEC, rec),
    share_summary: rec.shareScopes.includes('summary') ? 1 : 0,
    share_goals: rec.shareScopes.includes('goals') ? 1 : 0,
    share_actions: rec.shareScopes.includes('actions') ? 1 : 0,
  });
  if (isNew) {
    rec.goalSnapshots.forEach((s, i) => {
      st.snapshot.run({ review_id: rec.id, ord: i, ...encode(SNAPSHOT_SPEC, s) });
      s.evidenceRefs.forEach((r, j) => st.snapshotRef.run(rec.id, s.goalId, j, r.sourceType, r.sourceId));
    });
  }
  writeHistory(st, rec.history.slice(known), { planId: rec.planId, reviewId: rec.id });
}

const decodeHistoryRow = (h) => {
  const e = decode(HISTORY_SPEC, h);
  const d = Object.fromEntries(Object.entries(decode(DETAIL_SPEC, h)).filter(([, v]) => v !== null));
  return { ...e, detail: Object.keys(d).length ? d : null };
};
const historyOf = (sqlite, col, ids, where = '') =>
  childRowsOf(sqlite, 'development_history', col, ids, { order: 'rowid', where });
function decodeObjectives(sqlite, rows) {
  const oids = rows.map((r) => r.id);
  const items = childRowsOf(sqlite, 'dev_objective_items', 'objective_id', oids, { order: 'ord' });
  const iids = rows.flatMap((r) => items.all(r.id).map((i) => i.id));
  const ex = childRowsOf(sqlite, 'dev_objective_item_exercises', 'item_id', iids, { order: 'ord' });
  const iev = childRowsOf(sqlite, 'dev_objective_item_evidence', 'item_id', iids, { order: 'ord' });
  const prog = childRowsOf(sqlite, 'dev_objective_progress', 'objective_id', oids);
  const shares = childRowsOf(sqlite, 'dev_objective_shares', 'objective_id', oids, { order: 'ord' });
  const ras = childRowsOf(sqlite, 'dev_objective_reassessments', 'objective_id', oids);
  const rids = rows.flatMap((r) => ras.all(r.id).map((x) => x.id));
  const rev = childRowsOf(sqlite, 'dev_objective_reassessment_evidence', 'reassessment_id', rids, { order: 'ord' });
  return rows.map((row) => ({
    ...decode(OBJECTIVE_SPEC, row),
    objectives: items.all(row.id).map((i) => ({
      id: i.id,
      text: i.text,
      exerciseRefs: ex.all(i.id).map((x) => x.ref),
      baselineEvidenceIds: iev.all(i.id).map((x) => x.evidence_id),
    })),
    progress: prog.all(row.id).map((g) => decode(PROGRESS_SPEC, g)),
    sharing: { orgIds: shares.all(row.id).map((s) => s.org_id) },
    reassessments: ras.all(row.id).map((r) => ({
      ...decode(REASSESSMENT_SPEC, r),
      outcome:
        r.outcome_at === null
          ? null
          : {
              note: r.outcome_note,
              evidenceIds: rev.all(r.id).map((x) => x.evidence_id),
              byUserId: r.outcome_by_user_id,
              byName: r.outcome_by_name,
              at: r.outcome_at,
            },
    })),
  }));
}
function decodePlans(sqlite, rows, { history = true } = {}) {
  const pids = rows.map((r) => r.id);
  const shares = childRowsOf(sqlite, 'development_plan_shares', 'plan_id', pids, { order: 'ord' });
  const hist = history
    ? historyOf(sqlite, 'plan_id', pids, 'goal_id IS NULL AND action_id IS NULL AND review_id IS NULL')
    : null;
  return rows.map((row) => ({
    ...decode(PLAN_SPEC, row),
    sharedWithOrgIds: shares.all(row.id).map((s) => s.org_id),
    ...(history ? { history: hist.all(row.id).map(decodeHistoryRow) } : {}),
  }));
}
function decodeWithHistory(sqlite, spec, col, rows) {
  const hist = historyOf(
    sqlite,
    col,
    rows.map((r) => r.id),
  );
  return rows.map((row) => ({ ...decode(spec, row), history: hist.all(row.id).map(decodeHistoryRow) }));
}
function decodeReviews(sqlite, rows) {
  const rids = rows.map((r) => r.id);
  const snaps = childRowsOf(sqlite, 'development_review_snapshots', 'review_id', rids, { order: 'ord' });
  const refs = childRowsOf(sqlite, 'development_review_snapshot_refs', 'review_id', rids, {
    order: 'ord',
    subKey: ['goal_id'],
  });
  const hist = historyOf(sqlite, 'review_id', rids);
  const by = new Map(
    rids.length
      ? sqlite
          .prepare(
            'SELECT id, supersedes_review_id AS s FROM development_reviews WHERE supersedes_review_id IN (SELECT value FROM json_each(?))',
          )
          .all(JSON.stringify(rids))
          .map((r) => [r.s, r.id])
      : [],
  );
  return rows.map((row) => ({
    ...decode(REVIEW_SPEC, row),
    goalSnapshots: snaps.all(row.id).map((s) => {
      const d = decode(SNAPSHOT_SPEC, s);
      return {
        goalId: d.goalId,
        title: d.title,
        category: d.category,
        status: d.status,
        actionCounts: d.actionCounts,
        completion: completionOf(d.actionCounts),
        evidenceRefs: refs.all(row.id, s.goal_id).map((r) => ({ sourceType: r.source_type, sourceId: r.source_id })),
        targetStateAtReview: d.targetStateAtReview,
      };
    }),
    shareScopes: SHARE_SCOPES.filter((s) => row[`share_${s}`] === 1),
    supersededBy: by.get(row.id) ?? null,
    history: hist.all(row.id).map(decodeHistoryRow),
  }));
}
const decodeDrill = (row) => decode(DRILL_SPEC, row);

// ------------------------------------------------------------------ whole-domain read (the test suites)
export const developmentLive = (sqlite) => migrationApplied(sqlite, DEVELOPMENT_MIGRATION);
function readAll(sqlite) {
  const all = (t) => sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
  return {
    devObjectives: decodeObjectives(sqlite, all('dev_objectives')),
    drillGuidance: all('drill_guidance').map(decodeDrill),
    developmentPlans: decodePlans(sqlite, all('development_plans')),
    developmentGoals: decodeWithHistory(sqlite, GOAL_SPEC, 'goal_id', all('development_goals')),
    developmentActions: decodeWithHistory(sqlite, ACTION_SPEC, 'action_id', all('development_actions')),
    developmentEvidenceLinks: all('development_evidence_links').map((r) => decode(LINK_SPEC, r)),
    developmentReviews: decodeReviews(sqlite, all('development_reviews')),
  };
}

/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const DEVELOPMENT_RECORDS = {
  names: DEVELOPMENT_COLLECTIONS,
  read(sqlite) {
    return developmentLive(sqlite) ? readAll(sqlite) : null;
  },
};
const PLAYER_REFS_SQL = 'SELECT player_id AS pid FROM dev_objectives UNION ALL SELECT player_id FROM development_plans';
const playerRefCount = (sqlite, cond) =>
  sqlite.prepare(`SELECT count(*) AS n FROM (${PLAYER_REFS_SQL}) x WHERE ${cond}`).get().n;
export const unresolvedPlayerReferences = (sqlite) =>
  developmentLive(sqlite)
    ? { development: playerRefCount(sqlite, 'NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid)') }
    : null;

// ------------------------------------------------------------------ the repository
const WRITES = new Set(['create', 'update', 'remove', 'record']);
const clone = (v) => JSON.parse(JSON.stringify(v));
/** Equal values, whatever the order of their keys (a typed record and a decoded one list their keys differently). */
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v !== null && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
/**
 * `createDevelopmentRepository({ sqlite, unit, now, log })`: `objectives`, `drillReviews`, `plans`, `goals`, `actions`,
 * `links` and `reviews`, each with its writes and queries, plus `reads` (the queries alone: `developmentReads`).
 */
export function createDevelopmentRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the development repository needs a SQLite connection (node:sqlite)');
  const operation = (fn) => (unit?.active?.() ? unit.join(fn) : sqlite.isTransaction ? fn() : transaction(sqlite, fn));
  const cache = new Map();
  const q = (sql) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = sqlite.prepare(sql)));
    return s;
  };
  const st = statements(sqlite);
  const updating = new Set();
  const guard = (key, fn) => {
    if (updating.has(key))
      throw refusal(
        'DEVELOPMENT_NESTED_UPDATE',
        `${key} is already being updated; make the second change after the first returns`,
      );
    updating.add(key);
    try {
      return fn();
    } finally {
      updating.delete(key);
    }
  };
  const typedOr = (type, raw, name) => {
    const t = type(raw, name);
    if (!t.ok) throw refusal('DEVELOPMENT_INPUT_INVALID', t.reason);
    return t.record;
  };
  const json = (list) => JSON.stringify([...list]);
  /** The common shape of an update: a plain copy edited by `change`, typed whole, fixed fields and the history kept. */
  const updater =
    ({ table, type, byId: find, immutable, write, check = () => {} }) =>
    (id, change) =>
      guard(`${table} ${id}`, () =>
        operation(() => {
          if (typeof change !== 'function')
            throw new TypeError(`${table}.update(id, change) needs a function that edits the copy it is given`);
          const stored = find(id);
          if (!stored) throw refusal('DEVELOPMENT_NOT_FOUND', `${table} ${id} is not a record of the repository`);
          const draft = clone(stored);
          const returned = change(draft);
          const next = typedOr(type, returned === undefined ? draft : returned, table);
          for (const k of immutable)
            if (!same(next[k], stored[k]))
              throw refusal('DEVELOPMENT_INPUT_INVALID', `${table} ${id}: ${k} cannot change`);
          if (stored.history && stored.history.some((h, i) => !same(h, next.history[i])))
            throw refusal(
              'DEVELOPMENT_INPUT_INVALID',
              `${table} ${id}: the history only grows (a stored entry cannot change or go)`,
            );
          check(next, stored);
          write(next, stored);
          return find(id);
        }),
      );
  const one = (decoder) => (sql) => (id) => {
    if (typeof id !== 'string') return null;
    const row = q(sql).get(id);
    return row ? deepFreeze(decoder([row])[0]) : null;
  };
  const many =
    (decoder) =>
    (sql) =>
    (...args) =>
      decoder(q(sql).all(...args)).map(deepFreeze);

  // ---- objectives
  const decO = (rows) => decodeObjectives(sqlite, rows);
  const objectiveById = one(decO)('SELECT * FROM dev_objectives WHERE id = ?');
  const objectivesWhere = (where) => many(decO)(`SELECT * FROM dev_objectives WHERE ${where} ORDER BY rowid`);
  const forPlayersO = objectivesWhere('player_id IN (SELECT value FROM json_each(?))');
  const OBJECTIVE_IMMUTABLE = [
    'id',
    'playerId',
    'sourceFeedbackId',
    'orgId',
    'reviewer',
    'objectives',
    'reviewAt',
    'status',
    'createdBy',
    'createdAt',
  ];
  const objectives = {
    create: (raw) =>
      operation(() => {
        const r = typedOr(typeObjective, raw, 'devObjectives');
        if (objectiveById(r.id)) throw refusal('DEVELOPMENT_DUPLICATE', `dev_objectives ${r.id} already exists`);
        writeObjective(st, r, { isNew: true });
        return objectiveById(r.id);
      }),
    /** `update(id, change)`: the items, owner, source and dates never change; progress only grows; a reassessment, once requested, only completes. */
    update: updater({
      table: 'dev_objectives',
      type: typeObjective,
      byId: objectiveById,
      immutable: OBJECTIVE_IMMUTABLE,
      check: (next, stored) => {
        if (stored.progress.some((g, i) => !same(g, next.progress[i])))
          throw refusal('DEVELOPMENT_INPUT_INVALID', `dev_objectives ${stored.id}: progress only grows`);
        stored.reassessments.forEach((r, i) => {
          const n = next.reassessments[i];
          if (
            !n ||
            n.id !== r.id ||
            !same(n.requestedBy, r.requestedBy) ||
            n.requestedAt !== r.requestedAt ||
            (r.status === 'completed' && !same(n, r))
          )
            throw refusal(
              'DEVELOPMENT_INPUT_INVALID',
              `dev_objectives ${stored.id}: reassessment ${r.id} only completes, once`,
            );
        });
      },
      write: (next) => writeObjective(st, next, { isNew: false }),
    }),
    byId: objectiveById,
    /** The player's objectives, oldest first. */
    forPlayer: objectivesWhere('player_id = ?'),
    forPlayers: (playerIds) => forPlayersO(json(playerIds)),
    /** The player's objectives shared with this organisation, oldest first (the club follow-up view). */
    sharedWith: (playerId, orgId) =>
      objectivesWhere(
        'player_id = ? AND EXISTS (SELECT 1 FROM dev_objective_shares s WHERE s.objective_id = dev_objectives.id AND s.org_id = ?)',
      )(playerId, orgId),
    /** The objective holding this reassessment, or null. */
    byReassessment: (reassessmentId) =>
      objectivesWhere('id IN (SELECT objective_id FROM dev_objective_reassessments WHERE id = ?)')(reassessmentId)[0] ??
      null,
  };

  // ---- drill-guidance reviews
  const drillReviews = {
    /** A named person reviewed this drill's guidance (a second review replaces the first). */
    record: (raw) =>
      operation(() => {
        const r = typedOr(typeDrillReview, raw, 'drillGuidance');
        st.drill.run(encode(DRILL_SPEC, r));
        return deepFreeze({ ...r });
      }),
    byDrill: (drillId) => {
      const row = q('SELECT * FROM drill_guidance WHERE drill_id = ?').get(drillId);
      return row ? deepFreeze(decodeDrill(row)) : null;
    },
    all: () =>
      q('SELECT * FROM drill_guidance ORDER BY rowid')
        .all()
        .map((r) => deepFreeze(decodeDrill(r))),
  };

  // ---- plans
  const decP = (rows) => decodePlans(sqlite, rows);
  const planById = one(decP)('SELECT * FROM development_plans WHERE id = ?');
  const plansWhere =
    (where, order = 'rowid') =>
    (...args) =>
      decodePlans(sqlite, q(`SELECT * FROM development_plans WHERE ${where} ORDER BY ${order}`).all(...args), {
        history: false,
      }).map(deepFreeze);
  const LIST_ORDER = 'updated_at DESC, id';
  const forPlayersP = plansWhere(
    'player_id IN (SELECT value FROM json_each(?)) AND (? IS NULL OR status = ?)',
    LIST_ORDER,
  );
  const forOrgP = plansWhere(
    '(owner_org_id = ? OR id IN (SELECT plan_id FROM development_plan_shares WHERE org_id = ?)) AND (? IS NULL OR player_id = ?) AND (? IS NULL OR status = ?)',
    LIST_ORDER,
  );
  const planShapeCheck = (next, stored) => {
    if (
      next.originObjectiveId &&
      next.originObjectiveId !== stored?.originObjectiveId &&
      !objectiveById(next.originObjectiveId)
    )
      throw refusal(
        'DEVELOPMENT_REFERENCE_MISSING',
        `development_plans ${next.id}: originObjectiveId names no objective (${next.originObjectiveId})`,
      );
  };
  const plans = {
    create: (raw) =>
      operation(() => {
        const r = typedOr(typePlan, raw, 'developmentPlans');
        if (planById(r.id)) throw refusal('DEVELOPMENT_DUPLICATE', `development_plans ${r.id} already exists`);
        planShapeCheck(r, null);
        writePlan(st, r);
        return planById(r.id);
      }),
    /** `update(id, change)`: the player, owner, author, origin and creation never change; the history only grows. */
    update: updater({
      table: 'development_plans',
      type: typePlan,
      byId: planById,
      immutable: ['id', 'playerId', 'owner', 'createdBy', 'originObjectiveId', 'createdAt'],
      write: (next, stored) => writePlan(st, next, { known: stored.history.length }),
    }),
    byId: planById,
    /**
     * The list candidates (without their history), most recently updated first then id: a player's or a guardian's
     * children's plans, or the plans an organisation owns or was shared. The caller applies the access rule.
     */
    forPlayers: (playerIds, { status = null } = {}) => forPlayersP(json(playerIds), status, status),
    forOrg: (orgId, { playerId = null, status = null } = {}) =>
      forOrgP(orgId, orgId, playerId, playerId, status, status),
    /** Goal statuses and action states of these plans, for their list rows: `{ goals: Map, actions: Map }` of `{ status[, dueAt] }`. */
    listCounts: (planIds) => {
      const goals = new Map();
      const actions = new Map();
      for (const id of planIds) {
        goals.set(id, []);
        actions.set(id, []);
      }
      for (const r of q(
        'SELECT plan_id, status FROM development_goals WHERE plan_id IN (SELECT value FROM json_each(?)) ORDER BY rowid',
      ).all(json(planIds)))
        goals.get(r.plan_id).push({ status: r.status });
      for (const r of q(
        'SELECT plan_id, status, due_at FROM development_actions WHERE plan_id IN (SELECT value FROM json_each(?)) ORDER BY rowid',
      ).all(json(planIds)))
        actions.get(r.plan_id).push({ status: r.status, dueAt: r.due_at });
      return { goals, actions };
    },
    /** How many of the player's plans this owner has that are not completed or archived (the limit of five). */
    openCount: (playerId, ownerKind, ownerOrgId) =>
      q(
        "SELECT COUNT(*) AS n FROM development_plans WHERE player_id = ? AND owner_kind = ? AND owner_org_id IS ? AND status NOT IN ('completed','archived')",
      ).get(playerId, ownerKind, ownerOrgId ?? null).n,
    /** The plan this create repeats, if the same author made one with this title and owner for this player since `since`. */
    recentCreate: ({ playerId, title, createdById, ownerKind, ownerOrgId, since }) => {
      const row = q(
        'SELECT id FROM development_plans WHERE player_id = ? AND title = ? AND created_by_id = ? AND owner_kind = ? AND owner_org_id IS ? AND created_at > ? ORDER BY rowid LIMIT 1',
      ).get(playerId, title, createdById, ownerKind, ownerOrgId ?? null, since);
      return row ? planById(row.id) : null;
    },
    /**
     * Everything one plan holds, decoded in one batch per table: `{ plan, goals, actions, links, reviews }` (goals and
     * actions oldest first, reviews and links in insertion order), or null.
     */
    collect: (planId) => {
      const plan = planById(planId);
      if (!plan) return null;
      return {
        plan,
        goals: goalsWhere('plan_id = ?')(planId),
        actions: actionsWhere('plan_id = ?')(planId),
        links: linksWhere('plan_id = ?')(planId),
        reviews: reviewsWhere('plan_id = ?')(planId),
      };
    },
    /**
     * The history entries an organisation's audit feed shows (`actions`): those of the plans it owns, with the plan,
     * and those of the reviews it wrote, with the review id. Insertion order.
     */
    orgFeed: (orgId, actions) => {
      const a = json(actions);
      const planRows = q(
        'SELECT h.*, p.title AS plan_title, p.player_id AS plan_player_id FROM development_history h JOIN development_plans p ON p.id = h.plan_id WHERE p.owner_org_id = ? AND h.goal_id IS NULL AND h.action_id IS NULL AND h.review_id IS NULL AND h.action IN (SELECT value FROM json_each(?)) ORDER BY h.rowid',
      ).all(orgId, a);
      const reviewRows = q(
        'SELECT h.* FROM development_history h JOIN development_reviews r ON r.id = h.review_id WHERE r.org_id = ? AND h.action IN (SELECT value FROM json_each(?)) ORDER BY h.rowid',
      ).all(orgId, a);
      return deepFreeze([
        ...planRows.map((h) => ({
          entry: decodeHistoryRow(h),
          plan: { id: h.plan_id, title: h.plan_title, playerId: h.plan_player_id },
        })),
        ...reviewRows.map((h) => ({ entry: decodeHistoryRow(h), review: { id: h.review_id } })),
      ]);
    },
  };

  // ---- goals, actions, links, reviews
  const decG = (rows) => decodeWithHistory(sqlite, GOAL_SPEC, 'goal_id', rows);
  const goalById = one(decG)('SELECT * FROM development_goals WHERE id = ?');
  const goalsWhere = (where) => many(decG)(`SELECT * FROM development_goals WHERE ${where} ORDER BY created_at, id`);
  const inPlan = (kind, rec) => {
    const plan = planById(rec.planId);
    if (!plan)
      throw refusal('DEVELOPMENT_REFERENCE_MISSING', `${kind} ${rec.id}: planId names no plan (${rec.planId})`);
    if (plan.playerId !== rec.playerId)
      throw refusal('DEVELOPMENT_INPUT_INVALID', `${kind} ${rec.id}: playerId is not the plan's player`);
    return plan;
  };
  const goals = {
    create: (raw) =>
      operation(() => {
        const r = typedOr(typeGoal, raw, 'developmentGoals');
        if (goalById(r.id)) throw refusal('DEVELOPMENT_DUPLICATE', `development_goals ${r.id} already exists`);
        inPlan('development_goals', r);
        if (r.originObjectiveId && !objectiveById(r.originObjectiveId))
          throw refusal(
            'DEVELOPMENT_REFERENCE_MISSING',
            `development_goals ${r.id}: originObjectiveId names no objective (${r.originObjectiveId})`,
          );
        writeGoal(st, r);
        return goalById(r.id);
      }),
    update: updater({
      table: 'development_goals',
      type: typeGoal,
      byId: goalById,
      immutable: ['id', 'planId', 'playerId', 'originObjectiveId', 'createdBy', 'createdAt'],
      write: (next, stored) => writeGoal(st, next, { known: stored.history.length }),
    }),
    byId: goalById,
  };
  const decA = (rows) => decodeWithHistory(sqlite, ACTION_SPEC, 'action_id', rows);
  const actionById = one(decA)('SELECT * FROM development_actions WHERE id = ?');
  const actionsWhere = (where) => many(decA)(`SELECT * FROM development_actions WHERE ${where} ORDER BY rowid`);
  const actions = {
    create: (raw) =>
      operation(() => {
        const r = typedOr(typeAction, raw, 'developmentActions');
        if (actionById(r.id)) throw refusal('DEVELOPMENT_DUPLICATE', `development_actions ${r.id} already exists`);
        const g = goalById(r.goalId);
        if (!g || g.planId !== r.planId || g.playerId !== r.playerId)
          throw refusal(
            'DEVELOPMENT_REFERENCE_MISSING',
            `development_actions ${r.id}: goalId names no goal of plan ${r.planId} (${r.goalId})`,
          );
        writeAction(st, r);
        return actionById(r.id);
      }),
    update: updater({
      table: 'development_actions',
      type: typeAction,
      byId: actionById,
      immutable: ['id', 'planId', 'goalId', 'playerId', 'createdBy', 'createdAt'],
      write: (next, stored) => writeAction(st, next, { known: stored.history.length }),
    }),
    byId: actionById,
  };
  const decL = (rows) => rows.map((r) => decode(LINK_SPEC, r));
  const linkById = one(decL)('SELECT * FROM development_evidence_links WHERE id = ?');
  const linksWhere = (where) => many(decL)(`SELECT * FROM development_evidence_links WHERE ${where} ORDER BY rowid`);
  const links = {
    create: (raw) =>
      operation(() => {
        const r = typedOr(typeLink, raw, 'developmentEvidenceLinks');
        if (linkById(r.id)) throw refusal('DEVELOPMENT_DUPLICATE', `development_evidence_links ${r.id} already exists`);
        const holder = r.goalId ? goalById(r.goalId) : actionById(r.actionId);
        if (!holder || holder.planId !== r.planId || holder.playerId !== r.playerId)
          throw refusal(
            'DEVELOPMENT_REFERENCE_MISSING',
            `development_evidence_links ${r.id}: its holder is not in plan ${r.planId}`,
          );
        if (
          q(
            'SELECT 1 FROM development_evidence_links WHERE coalesce(goal_id, action_id) = ? AND source_type = ? AND source_id = ?',
          ).get(r.goalId ?? r.actionId, r.sourceType, r.sourceId)
        )
          throw refusal(
            'DEVELOPMENT_DUPLICATE',
            `development_evidence_links ${r.id}: that evidence is already linked there`,
          );
        st.link.run(encode(LINK_SPEC, r));
        return linkById(r.id);
      }),
    /** Unlinking deletes the link (the holder's history records it). */
    remove: (id) =>
      operation(() => {
        if (!linkById(id))
          throw refusal('DEVELOPMENT_NOT_FOUND', `development_evidence_links ${id} is not a record of the repository`);
        st.linkDel.run(id);
      }),
    byId: linkById,
  };
  const decR = (rows) => decodeReviews(sqlite, rows);
  const reviewById = one(decR)('SELECT * FROM development_reviews WHERE id = ?');
  const reviewsWhere = (where) => many(decR)(`SELECT * FROM development_reviews WHERE ${where} ORDER BY rowid`);
  const REVIEW_IMMUTABLE = [
    'id',
    'planId',
    'playerId',
    'reviewerKind',
    'reviewedBy',
    'orgId',
    'reviewedAt',
    'sharedSummary',
    'internalNote',
    'goalSnapshots',
    'nextReviewAt',
    'supersedes',
    'createdAt',
  ];
  const reviews = {
    create: (raw) =>
      operation(() => {
        const r = typedOr(typeReview, raw, 'developmentReviews');
        if (reviewById(r.id)) throw refusal('DEVELOPMENT_DUPLICATE', `development_reviews ${r.id} already exists`);
        inPlan('development_reviews', r);
        if (r.supersedes) {
          const old = reviewById(r.supersedes);
          if (!old || old.planId !== r.planId)
            throw refusal(
              'DEVELOPMENT_REFERENCE_MISSING',
              `development_reviews ${r.id}: supersedes names no review of plan ${r.planId} (${r.supersedes})`,
            );
          if (old.supersededBy)
            throw refusal(
              'DEVELOPMENT_DUPLICATE',
              `development_reviews ${r.supersedes} is already superseded by ${old.supersededBy}`,
            );
        }
        const stray = r.goalSnapshots.find((s) => goalById(s.goalId)?.planId !== r.planId);
        if (stray)
          throw refusal(
            'DEVELOPMENT_REFERENCE_MISSING',
            `development_reviews ${r.id}: goal ${stray.goalId} is not in plan ${r.planId}`,
          );
        writeReview(st, r, { isNew: true });
        return reviewById(r.id);
      }),
    /** `update(id, change)`: a review is append-only; only its sharing with the player and its history change. */
    update: updater({
      table: 'development_reviews',
      type: typeReview,
      byId: reviewById,
      immutable: REVIEW_IMMUTABLE,
      check: (next, stored) => {
        if (
          stored.sharedWithPlayerAt !== null &&
          (next.sharedWithPlayerAt !== stored.sharedWithPlayerAt || !same(next.shareScopes, stored.shareScopes))
        )
          throw refusal('DEVELOPMENT_INPUT_INVALID', `development_reviews ${stored.id}: a review is shared once`);
      },
      write: (next, stored) => writeReview(st, next, { isNew: false, known: stored.history.length }),
    }),
    byId: reviewById,
  };

  const readOnly = (o) => Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => !WRITES.has(k))));
  const repo = { objectives, drillReviews, plans, goals, actions, links, reviews };
  const counters = Object.fromEntries(
    [
      ['devObjectives', 'dev_objectives'],
      ['drillGuidance', 'drill_guidance'],
      ['developmentPlans', 'development_plans'],
      ['developmentGoals', 'development_goals'],
      ['developmentActions', 'development_actions'],
      ['developmentEvidenceLinks', 'development_evidence_links'],
      ['developmentReviews', 'development_reviews'],
    ].map(([n, t]) => [n, q(`SELECT COUNT(*) AS n FROM ${t}`)]),
  );
  return {
    ...repo,
    /** The queries alone, for modules and projectors that must not write (`developmentReads`). */
    reads: Object.freeze(Object.fromEntries(Object.entries(repo).map(([k, v]) => [k, readOnly(v)]))),
    attach() {
      if (!developmentLive(sqlite))
        throw new Error(
          `the development repository needs ${DEVELOPMENT_MIGRATION} recorded; it never imports an in-memory array`,
        );
      return { counts: this.counts() };
    },
    counts() {
      return Object.fromEntries(DEVELOPMENT_COLLECTIONS.map((n) => [n, counters[n].get().n]));
    },
    pending: () => 0,
    exportAll() {
      return DEVELOPMENT_RECORDS.read(sqlite);
    },
    log,
    now,
  };
}
