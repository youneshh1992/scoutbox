/**
 * Discovery: Recruitment Briefs, Nobody Missed reviews, Second Look items and Dynamic Watchlists.
 *
 * Records:
 *   - A Recruitment Brief: a club's explicit criteria as columns, its positions, evidence requirements and Combine
 *     protocols as ordered rows (the position groups are worked out from the positions, never stored). `version` is the
 *     CRITERIA version Nobody Missed points at; `rev` the concurrency token. The audit trail `audit()` writes is rows,
 *     its detail typed columns (`version`, `from`, `to`, `criteriaChanged`).
 *   - A Nobody Missed review: what one organisation did with one player for one brief (unique), its trail as rows.
 *   - A Second Look item: one per (organisation, room, decision cycle), unique; its change fingerprints, the archive
 *     reasons the changes resolve and its trail are ordered rows.
 *   - A Dynamic Watchlist: saved criteria, each criterion as typed columns by kind with its values as rows; a
 *     brief-sourced list names its brief by key (`brief_id`), any other carries a free reference (`source_ref`). The last
 *     derived membership is rows (`watchlist_members`, with the required criteria each member met), read and replaced
 *     only by `reconcile`. The lifecycle trail is rows; the membership transitions (`watchlistHistory`) are
 *     `watchlist_membership_events`, one per fingerprint.
 *
 * WRITES are explicit: `create(record)` and `update(id, (draft) => …)` per record kind (the update hands a plain copy,
 * types it whole, refuses an unknown field, a change to a field that never changes, a trail entry that changes or goes,
 * and an update from inside its own update); `watchlists.reconcile(id, …)` replaces the membership and appends the new
 * transitions. Every write joins the open unit of work, the caller's open transaction, or a transaction of its own.
 *
 * Deep-frozen records; a list's child rows decode in one batch. Modules receive them as `discoveryReads`.
 *
 * References. Player ids carry no key (tolerant: records outlive an account deletion). Organisations, the
 * staff named, a review's or a watchlist's brief, and the room and decision a record names are immediate RESTRICT keys.
 * Child rows cascade with their owner, which is never deleted.
 */
import { isPlainObject, ids, describe } from './recruitment.mjs';
import { transaction, migrationApplied, childRowsOf } from './database.mjs';
import { deepFreeze } from '../domains/platform/values.mjs';
import { text, int, num, bool, oneOf, group, tableDdl, bad, typeSpec, encode, decode, upsertSql, insertSql } from './fieldSpecs.mjs';
import { parseStrictDateOnly } from '../temporal.mjs';
import { BRIEF_STATUSES, POSITIONS, POSITION_GROUP_OF, EVIDENCE_REQUIREMENTS, TRUST_BANDS, SECOND_LOOK_STATUSES, SECOND_LOOK_KINDS, DISMISSAL_REASONS, NOBODY_MISSED_STATES, NM_DISMISSAL_REASONS, REASON_CHANGE_MAP } from '../domains/discovery/shared.mjs';
import { CRITERION_TYPES, CRITERION_CLASSES, criterionId, LIMITS as MATCH_LIMITS } from '../domains/discovery/matching/criteria.mjs';
import { WATCHLIST_MODES, WATCHLIST_STATUSES, WATCHLIST_SOURCES, ENTRY_REASONS, EXIT_REASONS } from '../domains/discovery/matching/watchlists.mjs';

export const DISCOVERY_MIGRATION = '0032_discovery';
export const DISCOVERY_COLLECTIONS = Object.freeze(['recruitmentBriefs', 'nobodyMissedReviews', 'secondLookItems', 'dynamicWatchlists', 'watchlistHistory']);

// ------------------------------------------------------------------ vocabularies and limits (one definition)
export const BRIEF_LEVELS = Object.freeze(['amateur', 'semi_pro', 'pro']);
export const BRIEF_FEET = Object.freeze(['Left', 'Right', 'Both']);
export const BRIEF_HISTORY_ACTIONS = Object.freeze(['recruitment_brief_created', 'recruitment_brief_activated', 'recruitment_brief_updated']);
/** The kinds of a brief's listed criteria, each from its own vocabulary (Combine protocols: COMBINE_PROTOCOLS ids, checked by the route). */
export const BRIEF_VALUE_KINDS = Object.freeze({ positions: 'position', evidenceRequirements: 'evidence_requirement', combineProtocols: 'combine_protocol' });
export const SECOND_LOOK_HISTORY_ACTIONS = Object.freeze(['surfaced', 'resurfaced', 'reviewed', 'dismissed', 'reopened_room']);
/** Why an item came back (secondLookStatus's `reopen` verdict). */
export const RESURFACE_REASONS = Object.freeze(['materially_new_evidence']);
export const ARCHIVE_REASON_CODES = Object.freeze(Object.keys(REASON_CHANGE_MAP));
export const WATCHLIST_HISTORY_ACTIONS = Object.freeze(['watchlist_created', 'watchlist_updated', 'watchlist_archived']);
/** The fields a watchlist update reports as changed, in the order it lists them. */
export const WATCHLIST_CHANGED_FIELDS = Object.freeze(['name', 'mode', 'status', 'criteriaVersion']);
export const MEMBERSHIP_TRANSITIONS = Object.freeze(['entered', 'left']);
export const MEMBERSHIP_REASONS = Object.freeze([...new Set([...Object.keys(ENTRY_REASONS), ...Object.keys(EXIT_REASONS)])]);
export const DISCOVERY_LIMITS = Object.freeze({
  id: 80, name: 200, briefTitle: 120, availability: 40, ref: 64, protocol: 80, fingerprint: 400, criteriaVersion: 40,
  watchlistName: MATCH_LIMITS.maxNameLength, criterionId: 600, criterionText: 80, eventText: 2000,
  positions: POSITIONS.length, protocols: 40, fingerprints: 100_000,
});
const L = DISCOVERY_LIMITS;

// ------------------------------------------------------------------ field specs
const idf = (k, c, o = {}) => text(k, c, L.id, { nonEmpty: true, ...o });
const req = { req: true };
const person = (k, prefix, o = {}) => group(k, [idf('userId', `${prefix}_user_id`, req), text('name', `${prefix}_name`, L.name)], o);
const revFields = () => [int('rev', 'rev', req), int('revAt', 'rev_at'), group('revBy', [idf('userId', 'rev_by_user_id', req), text('name', 'rev_by_name', L.name)], { nullable: true })];

const BRIEF_SPEC = [
  idf('id', 'id', req), idf('orgId', 'org_id', req), text('title', 'title', L.briefTitle, { req: true, nonEmpty: true }),
  int('version', 'version', req), oneOf('status', 'status', BRIEF_STATUSES, req),
  text('activeFrom', 'active_from_date', 10), text('activeUntil', 'active_until_date', 10),
  text('roleId', 'role_id', L.ref, { nonEmpty: true }), text('vacancyId', 'vacancy_id', L.ref, { nonEmpty: true }),
  person('createdBy', 'created_by'), int('createdAt', 'created_at', req), int('updatedAt', 'updated_at', req), ...revFields(),
];
/** The criteria's scalar part, in the order validateRecruitmentBrief builds it (the brief route compares criteria as JSON). */
const BRIEF_CRITERIA_SPEC = [
  int('minAge', 'min_age'), int('maxAge', 'max_age'), num('radiusKm', 'radius_km'), oneOf('maxLevel', 'max_level', BRIEF_LEVELS),
  oneOf('foot', 'foot', BRIEF_FEET), text('availability', 'availability', L.availability), oneOf('minTrustBand', 'min_trust_band', TRUST_BANDS),
];
const AUDIT_SPEC = (actions) => [idf('id', 'id', req), int('at', 'at', req), oneOf('byKind', 'by_kind', ['org'], req), idf('byId', 'by_id', req), text('byName', 'by_name', L.name), oneOf('action', 'action', actions, req)];
const BRIEF_HISTORY_SPEC = AUDIT_SPEC(BRIEF_HISTORY_ACTIONS);
const BRIEF_DETAIL_SPEC = [int('version', 'detail_version'), oneOf('from', 'detail_from', BRIEF_STATUSES), oneOf('to', 'detail_to', BRIEF_STATUSES), bool('criteriaChanged', 'detail_criteria_changed')];

const REVIEW_SPEC = [
  idf('id', 'id', req), idf('orgId', 'org_id', req), idf('briefId', 'brief_id', req), int('briefVersion', 'brief_version', req),
  idf('playerId', 'player_id', req), oneOf('state', 'state', NOBODY_MISSED_STATES, req), int('createdAt', 'created_at', req), int('updatedAt', 'updated_at', req),
  person('reviewedBy', 'reviewed_by', { nullable: true }), int('reviewedAt', 'reviewed_at'),
  oneOf('dismissReason', 'dismiss_reason', NM_DISMISSAL_REASONS), person('dismissedBy', 'dismissed_by', { nullable: true }), int('dismissedAt', 'dismissed_at'),
  idf('roomId', 'room_id'),
];
const REVIEW_TRAIL_SPEC = [int('at', 'at', req), oneOf('state', 'state', NOBODY_MISSED_STATES, req), person('by', 'by')];

const ITEM_SPEC = [
  idf('id', 'id', req), idf('orgId', 'org_id', req), idf('playerId', 'player_id', req), idf('roomId', 'room_id', req), idf('decisionId', 'decision_id', req),
  int('policyVersion', 'policy_version', req), oneOf('triggerType', 'trigger_type', SECOND_LOOK_KINDS, req), oneOf('status', 'status', SECOND_LOOK_STATUSES, req),
  int('createdAt', 'created_at', req), int('updatedAt', 'updated_at', req), int('latestChangeAt', 'latest_change_at', req),
  int('reviewedAt', 'reviewed_at'), person('reviewedBy', 'reviewed_by', { nullable: true }),
  int('dismissedAt', 'dismissed_at'), person('dismissedBy', 'dismissed_by', { nullable: true }), oneOf('dismissReason', 'dismiss_reason', DISMISSAL_REASONS),
  int('reopenedAt', 'reopened_at'), person('reopenedBy', 'reopened_by', { nullable: true }),
];
const ITEM_TRAIL_REASONS = Object.freeze([...RESURFACE_REASONS, ...DISMISSAL_REASONS]);

const WATCHLIST_SPEC = [
  idf('id', 'id', req), idf('orgId', 'org_id', req), text('name', 'name', L.watchlistName, { req: true, nonEmpty: true }),
  oneOf('mode', 'mode', WATCHLIST_MODES, req), oneOf('status', 'status', WATCHLIST_STATUSES, req), oneOf('sourceType', 'source_type', WATCHLIST_SOURCES, req),
  int('schemaVersion', 'schema_version', req), text('criteriaVersion', 'criteria_version', L.criteriaVersion, { req: true, nonEmpty: true }),
  bool('notify', 'notify', req), idf('createdBy', 'created_by_user_id', req), text('createdByName', 'created_by_name', L.name),
  int('createdAt', 'created_at', req), int('updatedAt', 'updated_at', req), ...revFields(),
  text('lastCriteriaVersion', 'last_criteria_version', L.criteriaVersion, { nonEmpty: true }), int('lastBriefVersion', 'last_brief_version'), int('lastReconciledAt', 'last_reconciled_at'),
];
const WATCHLIST_HISTORY_SPEC = AUDIT_SPEC(WATCHLIST_HISTORY_ACTIONS);
const changedCol = (f) => `detail_changed_${f === 'criteriaVersion' ? 'criteria' : f}`;
const WATCHLIST_DETAIL_COLUMNS = [
  oneOf('mode', 'detail_mode', WATCHLIST_MODES), oneOf('sourceType', 'detail_source_type', WATCHLIST_SOURCES), oneOf('status', 'detail_status', WATCHLIST_STATUSES),
  ...WATCHLIST_CHANGED_FIELDS.map((f) => bool(f, changedCol(f))),
];
const EVENT_SPEC = [
  idf('id', 'id', req), idf('watchlistId', 'watchlist_id', req), idf('orgId', 'org_id', req), idf('playerId', 'player_id', req),
  oneOf('transition', 'transition', MEMBERSHIP_TRANSITIONS, req), oneOf('reason', 'reason', MEMBERSHIP_REASONS, req),
  text('criterionId', 'criterion_id', L.criterionId, { nonEmpty: true }), text('text', 'text', L.eventText, { req: true, nonEmpty: true }),
  text('criteriaVersion', 'criteria_version', L.criteriaVersion, { req: true, nonEmpty: true }), int('briefVersion', 'brief_version'),
  int('policyVersion', 'policy_version', req), int('at', 'at', req), text('fingerprint', 'fingerprint', L.fingerprint, { req: true, nonEmpty: true }),
];

/**
 * A criterion's body by type and operator: which keys it carries, in the order the criteria schema normalises them,
 * and how each is stored. `list` → criterion value rows; `range` → range_min / range_max; `text` / `num` → value_text /
 * value_num; `primaryOnly`, `evidenceKind`, `protocol` → their own columns.
 */
const BODY = {
  'position:in': [['values', 'list'], ['primaryOnly', 'bool']],
  'age:between': [['values', 'range']], 'age:gte': [['value', 'num']], 'age:lte': [['value', 'num']],
  'geography:within_radius': [['value', 'num']],
  'level:lte': [['value', 'text']], 'level:in': [['values', 'list']],
  'foot:in': [['values', 'list']],
  'availability:equals': [['value', 'text']],
  'evidence:exists': [['value', 'text']],
  'evidence_recency:within_days': [['value', 'num'], ['evidenceKind', 'text']],
  'trust_band:gte': [['value', 'text']],
  'combine_result:exists': [['value', 'text']],
  'combine_measurement:gte': [['protocol', 'text'], ['value', 'num']], 'combine_measurement:lte': [['protocol', 'text'], ['value', 'num']],
};
for (const [type, def] of Object.entries(CRITERION_TYPES)) {
  for (const op of def.operators) if (!BODY[`${type}:${op}`]) throw new Error(`discovery: criterion ${type}:${op} has no stored shape`);
}
const CRITERION_COLUMN = { value: { text: 'value_text', num: 'value_num' }, evidenceKind: 'evidence_kind', protocol: 'protocol', primaryOnly: 'primary_only' };

// ------------------------------------------------------------------ DDL
const rowOf = (name, c, key = 'id') => `FOREIGN KEY (${c}) REFERENCES ${name}(${key}) ON DELETE RESTRICT`;
const ownedBy = (name, c) => `FOREIGN KEY (${c}) REFERENCES ${name}(id) ON DELETE CASCADE`;
const col = (c, def) => `${c.padEnd(40)} ${def}`;
const idCol = (c) => col(c, `TEXT NOT NULL CHECK (length(${c}) > 0 AND length(${c}) <= ${L.id})`);
const ordCol = (c = 'ord') => col(c, `INTEGER NOT NULL CHECK (${c} >= 0)`);
const enumIn = (vals) => vals.map((v) => `'${v}'`).join(',');
const DAY_GLOB = (c) => `CHECK (${c} IS NULL OR ${c} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')`;
const table = (name, cols) => `CREATE TABLE ${name} (\n  ${cols.join(',\n  ')}\n) STRICT;`;
const detailOf = (spec) => spec.map((f) => ({ ...f, req: false }));

export const DISCOVERY_DDL = [
  tableDdl('recruitment_briefs', [...BRIEF_SPEC, ...BRIEF_CRITERIA_SPEC], [
    rowOf('orgs', 'org_id'), rowOf('org_users', 'created_by_user_id'),
    DAY_GLOB('active_from_date'), DAY_GLOB('active_until_date'),
    'CHECK (version >= 1)', 'CHECK (rev >= 1)',
    'CHECK (min_age IS NULL OR (min_age >= 5 AND min_age <= 60))', 'CHECK (max_age IS NULL OR (max_age >= 5 AND max_age <= 60))',
    'CHECK (min_age IS NULL OR max_age IS NULL OR min_age <= max_age)', 'CHECK (radius_km IS NULL OR (radius_km > 0 AND radius_km <= 20000))',
    'CHECK (active_from_date IS NULL OR active_until_date IS NULL OR active_from_date <= active_until_date)',
  ]),
  'CREATE INDEX recruitment_briefs_org_updated ON recruitment_briefs (org_id, updated_at);',
  table('recruitment_brief_values', [
    idCol('brief_id'), col('kind', `TEXT NOT NULL CHECK (kind IN (${enumIn(Object.values(BRIEF_VALUE_KINDS))}))`), ordCol(),
    col('value', `TEXT NOT NULL CHECK (length(value) > 0 AND length(value) <= ${L.protocol})`),
    "CHECK (kind <> 'position' OR value IN (" + enumIn(POSITIONS) + '))',
    "CHECK (kind <> 'evidence_requirement' OR value IN (" + enumIn(EVIDENCE_REQUIREMENTS.map((r) => r.key)) + '))',
    ownedBy('recruitment_briefs', 'brief_id'), 'PRIMARY KEY (brief_id, kind, ord)', 'UNIQUE (brief_id, kind, value)',
  ]),
  tableDdl('recruitment_brief_history', [BRIEF_HISTORY_SPEC[0], idf('briefId', 'brief_id', req), ...BRIEF_HISTORY_SPEC.slice(1), ...detailOf(BRIEF_DETAIL_SPEC)], [ownedBy('recruitment_briefs', 'brief_id')]),
  'CREATE INDEX recruitment_brief_history_brief ON recruitment_brief_history (brief_id);',

  tableDdl('nobody_missed_reviews', REVIEW_SPEC, [
    rowOf('orgs', 'org_id'), rowOf('recruitment_briefs', 'brief_id'), rowOf('org_users', 'reviewed_by_user_id'), rowOf('org_users', 'dismissed_by_user_id'),
    rowOf('recruitment_cases', 'room_id'),
    "CHECK (state <> 'dismissed' OR dismissed_at IS NOT NULL)", "CHECK (state <> 'added_to_room' OR room_id IS NOT NULL)",
    'UNIQUE (org_id, brief_id, player_id)',
  ]),
  'CREATE INDEX nobody_missed_reviews_brief ON nobody_missed_reviews (brief_id);',
  tableDdl('nobody_missed_review_history', [idf('reviewId', 'review_id', req), int('ord', 'ord', req), ...REVIEW_TRAIL_SPEC], [
    ownedBy('nobody_missed_reviews', 'review_id'), rowOf('org_users', 'by_user_id'), 'PRIMARY KEY (review_id, ord)', 'CHECK (ord >= 0)',
  ]),

  tableDdl('second_look_items', ITEM_SPEC, [
    rowOf('orgs', 'org_id'), rowOf('recruitment_cases', 'room_id'), rowOf('room_decisions', 'decision_id'),
    rowOf('org_users', 'reviewed_by_user_id'), rowOf('org_users', 'dismissed_by_user_id'), rowOf('org_users', 'reopened_by_user_id'),
    "CHECK (status <> 'reviewed' OR reviewed_at IS NOT NULL)", "CHECK (status <> 'dismissed' OR dismissed_at IS NOT NULL)",
    "CHECK (status <> 'reopened_room' OR reopened_at IS NOT NULL)",
    'UNIQUE (org_id, room_id, decision_id)',
  ]),
  'CREATE INDEX second_look_items_org_player ON second_look_items (org_id, player_id);',
  table('second_look_item_fingerprints', [
    idCol('item_id'), ordCol(), col('fingerprint', `TEXT NOT NULL CHECK (length(fingerprint) > 0 AND length(fingerprint) <= ${L.fingerprint})`),
    ownedBy('second_look_items', 'item_id'), 'PRIMARY KEY (item_id, ord)', 'UNIQUE (item_id, fingerprint)',
  ]),
  table('second_look_item_reasons', [
    idCol('item_id'), ordCol(), col('code', `TEXT NOT NULL CHECK (code IN (${enumIn(ARCHIVE_REASON_CODES)}))`),
    ownedBy('second_look_items', 'item_id'), 'PRIMARY KEY (item_id, ord)', 'UNIQUE (item_id, code)',
  ]),
  table('second_look_item_history', [
    idCol('item_id'), ordCol(), col('at', 'INTEGER NOT NULL'), col('action', `TEXT NOT NULL CHECK (action IN (${enumIn(SECOND_LOOK_HISTORY_ACTIONS)}))`),
    col('by_user_id', `TEXT CHECK (by_user_id IS NULL OR (length(by_user_id) > 0 AND length(by_user_id) <= ${L.id}))`), col('by_name', `TEXT CHECK (by_name IS NULL OR length(by_name) <= ${L.name})`),
    col('reason', `TEXT CHECK (reason IS NULL OR reason IN (${enumIn(ITEM_TRAIL_REASONS)}))`),
    ownedBy('second_look_items', 'item_id'), rowOf('org_users', 'by_user_id'), 'PRIMARY KEY (item_id, ord)',
    "CHECK ((action IN ('surfaced','resurfaced')) = (by_user_id IS NULL))", "CHECK (by_user_id IS NOT NULL OR by_name IS NULL)",
    "CHECK (action IN ('resurfaced','dismissed') OR reason IS NULL)", "CHECK (action <> 'resurfaced' OR reason IS NOT NULL)",
  ]),

  tableDdl('dynamic_watchlists', [...WATCHLIST_SPEC.slice(0, 6), idf('briefId', 'brief_id'), text('sourceRef', 'source_ref', L.ref, { nonEmpty: true }), ...WATCHLIST_SPEC.slice(6)], [
    rowOf('orgs', 'org_id'), rowOf('recruitment_briefs', 'brief_id'), rowOf('org_users', 'created_by_user_id'),
    "CHECK ((source_type = 'brief') = (brief_id IS NOT NULL))", "CHECK (source_type <> 'brief' OR source_ref IS NULL)",
    "CHECK (mode <> 'live_linked' OR source_type = 'brief')", 'CHECK (rev >= 1)',
    'CHECK ((last_reconciled_at IS NULL) = (last_criteria_version IS NULL))',
  ]),
  'CREATE INDEX dynamic_watchlists_org_updated ON dynamic_watchlists (org_id, updated_at);',
  table('watchlist_criteria', [
    idCol('watchlist_id'), col('class', `TEXT NOT NULL CHECK (class IN (${enumIn(CRITERION_CLASSES)}))`), ordCol(),
    col('criterion_id', `TEXT NOT NULL CHECK (length(criterion_id) > 0 AND length(criterion_id) <= ${L.criterionId})`),
    col('type', `TEXT NOT NULL CHECK (type IN (${enumIn(Object.keys(CRITERION_TYPES))}))`),
    col('operator', `TEXT NOT NULL CHECK (operator IN (${enumIn([...new Set(Object.values(CRITERION_TYPES).flatMap((d) => d.operators))])}))`),
    col('value_text', `TEXT CHECK (value_text IS NULL OR (length(value_text) > 0 AND length(value_text) <= ${L.criterionText}))`), col('value_num', 'REAL'),
    col('range_min', 'INTEGER'), col('range_max', 'INTEGER'), col('primary_only', 'INTEGER CHECK (primary_only IS NULL OR primary_only IN (0,1))'),
    col('evidence_kind', "TEXT CHECK (evidence_kind IS NULL OR evidence_kind IN ('any','footage'))"),
    col('protocol', `TEXT CHECK (protocol IS NULL OR (length(protocol) > 0 AND length(protocol) <= ${L.protocol}))`),
    ownedBy('dynamic_watchlists', 'watchlist_id'), 'PRIMARY KEY (watchlist_id, class, ord)', 'UNIQUE (watchlist_id, class, criterion_id)',
    'CHECK ((range_min IS NULL) = (range_max IS NULL))',
  ]),
  table('watchlist_criterion_values', [
    idCol('watchlist_id'), col('class', `TEXT NOT NULL CHECK (class IN (${enumIn(CRITERION_CLASSES)}))`), ordCol('criterion_ord'), ordCol(),
    col('value', `TEXT NOT NULL CHECK (length(value) > 0 AND length(value) <= ${L.criterionText})`),
    'FOREIGN KEY (watchlist_id, class, criterion_ord) REFERENCES watchlist_criteria(watchlist_id, class, ord) ON DELETE CASCADE',
    'PRIMARY KEY (watchlist_id, class, criterion_ord, ord)',
  ]),
  table('watchlist_members', [idCol('watchlist_id'), idCol('player_id'), ownedBy('dynamic_watchlists', 'watchlist_id'), 'PRIMARY KEY (watchlist_id, player_id)']),
  table('watchlist_member_checks', [
    idCol('watchlist_id'), idCol('player_id'), ordCol(),
    col('criterion_id', `TEXT NOT NULL CHECK (length(criterion_id) > 0 AND length(criterion_id) <= ${L.criterionId})`), col('met', 'INTEGER NOT NULL CHECK (met IN (0,1))'),
    'FOREIGN KEY (watchlist_id, player_id) REFERENCES watchlist_members(watchlist_id, player_id) ON DELETE CASCADE', 'PRIMARY KEY (watchlist_id, player_id, ord)',
  ]),
  tableDdl('watchlist_history', [WATCHLIST_HISTORY_SPEC[0], idf('watchlistId', 'watchlist_id', req), ...WATCHLIST_HISTORY_SPEC.slice(1), ...detailOf(WATCHLIST_DETAIL_COLUMNS)], [
    ownedBy('dynamic_watchlists', 'watchlist_id'),
    `CHECK ((${WATCHLIST_CHANGED_FIELDS.map((f) => `${changedCol(f)} IS NULL`).join(' AND ')}) OR (${WATCHLIST_CHANGED_FIELDS.map((f) => `${changedCol(f)} IS NOT NULL`).join(' AND ')}))`,
  ]),
  'CREATE INDEX watchlist_history_watchlist ON watchlist_history (watchlist_id);',
  tableDdl('watchlist_membership_events', EVENT_SPEC, [
    rowOf('dynamic_watchlists', 'watchlist_id'), rowOf('orgs', 'org_id'), 'UNIQUE (fingerprint)',
  ]),
  'CREATE INDEX watchlist_membership_events_watchlist_at ON watchlist_membership_events (watchlist_id, at, id);',
  'CREATE INDEX watchlist_membership_events_org_at ON watchlist_membership_events (org_id, at);',
].join('\n');
export const DISCOVERY_TABLES = Object.freeze([
  'recruitment_briefs', 'recruitment_brief_values', 'recruitment_brief_history', 'nobody_missed_reviews', 'nobody_missed_review_history',
  'second_look_items', 'second_look_item_fingerprints', 'second_look_item_reasons', 'second_look_item_history',
  'dynamic_watchlists', 'watchlist_criteria', 'watchlist_criterion_values', 'watchlist_members', 'watchlist_member_checks',
  'watchlist_history', 'watchlist_membership_events',
]);

// ------------------------------------------------------------------ typing
export const refusal = (code, message, extra = {}) => Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
const labelOf = (at, raw) => `${at} ${isPlainObject(raw) && typeof raw.id === 'string' ? raw.id : ''}`.trim();
const isDay = (v) => typeof v === 'string' && parseStrictDateOnly(v).ok;

/** A list of distinct short texts, each from `vocab` when one is given. */
function typeValueList(list, label, field, { max, itemMax = L.criterionText, vocab = null, unique = true }) {
  if (list === undefined) return { ok: true, value: [] };
  if (!Array.isArray(list)) return bad(label, field, `must be a list (got ${describe(list)})`);
  if (list.length > max) return bad(label, field, `holds more than ${max} entries`);
  const i = list.findIndex((x) => typeof x !== 'string' || !x.length || x.length > itemMax || (vocab && !vocab.includes(x)));
  if (i >= 0) return bad(label, `${field}[${i}]`, vocab ? `must be one of ${vocab.join('|')} (got ${describe(list[i])})` : `must be text of 1 to ${itemMax} characters (got ${describe(list[i])})`);
  if (unique && new Set(list).size !== list.length) return bad(label, field, 'names an entry twice');
  return { ok: true, value: [...list] };
}
function typeList(list, label, field, typer) {
  if (list === undefined) list = [];
  if (!Array.isArray(list)) return bad(label, field, `must be a list (got ${describe(list)})`);
  const out = [];
  for (const [i, x] of list.entries()) { const t = typer(x, `${label}.${field}[${i}]`); if (!t.ok) return t; out.push(t.record); }
  return { ok: true, value: out };
}
/** An `audit()` entry: `{ id, at, byKind, byId, byName, action, detail }`, the detail null or the typed keys it names. */
const auditTyper = (spec, detailSpec) => (raw, at) => {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  const { detail = null, ...rest } = raw;
  const t = typeSpec(spec, rest, at); if (!t.ok) return t;
  if (detail === null) return { ok: true, record: { ...t.record, detail: null } };
  const d = typeSpec(detailSpec, detail, `${at}.detail`); if (!d.ok) return d;
  const kept = Object.fromEntries(Object.entries(d.record).filter(([, v]) => v !== null));
  if (!Object.keys(kept).length) return bad(at, 'detail', 'is null or names at least one field');
  return { ok: true, record: { ...t.record, detail: kept } };
};
const typeBriefHistoryEntry = auditTyper(BRIEF_HISTORY_SPEC, BRIEF_DETAIL_SPEC);
/** A watchlist trail detail: `{ mode, sourceType }` (created) or `{ changed, mode, status }` (updated, archived). */
const WATCHLIST_DETAIL_SPEC = [
  oneOf('mode', 'detail_mode', WATCHLIST_MODES), oneOf('sourceType', 'detail_source_type', WATCHLIST_SOURCES), oneOf('status', 'detail_status', WATCHLIST_STATUSES),
];
function typeWatchlistHistoryEntry(raw, at) {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  const { detail = null, ...rest } = raw;
  const t = typeSpec(WATCHLIST_HISTORY_SPEC, rest, at); if (!t.ok) return t;
  if (detail === null) return { ok: true, record: { ...t.record, detail: null } };
  if (!isPlainObject(detail)) return bad(at, 'detail', `must be an object or null (got ${describe(detail)})`);
  const { changed, ...scalars } = detail;
  const d = typeSpec(WATCHLIST_DETAIL_SPEC, scalars, `${at}.detail`); if (!d.ok) return d;
  const out = {};
  if (changed !== undefined) {
    const c = typeValueList(changed, `${at}.detail`, 'changed', { max: WATCHLIST_CHANGED_FIELDS.length, vocab: WATCHLIST_CHANGED_FIELDS }); if (!c.ok) return c;
    out.changed = WATCHLIST_CHANGED_FIELDS.filter((f) => c.value.includes(f));
    if (out.changed.join() !== c.value.join()) return bad(`${at}.detail`, 'changed', `lists the fields in the order ${WATCHLIST_CHANGED_FIELDS.join(', ')}`);
  }
  for (const [k, v] of Object.entries(d.record)) if (v !== null) out[k] = v;
  if (!Object.keys(out).length) return bad(at, 'detail', 'is null or names at least one field');
  return { ok: true, record: { ...t.record, detail: out } };
}
function noTrailRewrite(stored, next, label) {
  if (stored.history.some((h, i) => !same(h, next.history[i]))) throw refusal('DISCOVERY_INPUT_INVALID', `${label}: the history only grows (a stored entry cannot change or go)`);
}

/** A brief's criteria: the listed criteria as value rows, the scalars as columns, the position groups worked out. */
export function typeBriefCriteria(raw, label) {
  if (!isPlainObject(raw)) return bad(label, 'criteria', `must be an object (got ${describe(raw)})`);
  const { positions, positionGroups, evidenceRequirements, combineProtocols, ...scalars } = raw;
  const t = typeSpec(BRIEF_CRITERIA_SPEC, scalars, `${label}.criteria`); if (!t.ok) return t;
  const pos = typeValueList(positions, `${label}.criteria`, 'positions', { max: L.positions, vocab: POSITIONS }); if (!pos.ok) return pos;
  const ev = typeValueList(evidenceRequirements, `${label}.criteria`, 'evidenceRequirements', { max: EVIDENCE_REQUIREMENTS.length, vocab: EVIDENCE_REQUIREMENTS.map((r) => r.key) }); if (!ev.ok) return ev;
  const cp = typeValueList(combineProtocols, `${label}.criteria`, 'combineProtocols', { max: L.protocols, itemMax: L.protocol }); if (!cp.ok) return cp;
  const groups = [...new Set(pos.value.map((p) => POSITION_GROUP_OF[p]))];
  if (positionGroups !== undefined && !same(positionGroups, groups)) return bad(`${label}.criteria`, 'positionGroups', `must be the groups of the positions (${groups.join(', ') || 'none'})`);
  const c = t.record;
  for (const k of ['minAge', 'maxAge']) if (c[k] !== null && (c[k] < 5 || c[k] > 60)) return bad(`${label}.criteria`, k, 'must be from 5 to 60');
  if (c.minAge !== null && c.maxAge !== null && c.minAge > c.maxAge) return bad(`${label}.criteria`, 'minAge', 'is above maxAge');
  if (c.radiusKm !== null && (c.radiusKm <= 0 || c.radiusKm > 20000)) return bad(`${label}.criteria`, 'radiusKm', 'must be above 0 and at most 20000');
  return {
    ok: true,
    record: {
      positions: pos.value, positionGroups: groups, minAge: c.minAge, maxAge: c.maxAge, radiusKm: c.radiusKm, maxLevel: c.maxLevel,
      foot: c.foot, availability: c.availability, evidenceRequirements: ev.value, minTrustBand: c.minTrustBand, combineProtocols: cp.value,
    },
  };
}
export function typeBrief(raw, at = 'recruitmentBriefs') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { criteria, history = [], ...flatPart } = raw;
  const t = typeSpec(BRIEF_SPEC, flatPart, label); if (!t.ok) return t;
  const r = t.record;
  for (const k of ['activeFrom', 'activeUntil']) if (r[k] !== null && !isDay(r[k])) return bad(label, k, `must be a day written YYYY-MM-DD (got ${describe(r[k])})`);
  if (r.activeFrom && r.activeUntil && r.activeFrom > r.activeUntil) return bad(label, 'activeFrom', 'is after activeUntil');
  if (r.version < 1) return bad(label, 'version', 'must be at least 1');
  if (r.rev < 1) return bad(label, 'rev', 'must be at least 1');
  const c = typeBriefCriteria(criteria, label); if (!c.ok) return c;
  const h = typeList(history, label, 'history', typeBriefHistoryEntry); if (!h.ok) return h;
  return { ok: true, record: { ...r, criteria: c.record, history: h.value } };
}

function typeReviewTrailEntry(raw, at) { return typeSpec(REVIEW_TRAIL_SPEC, raw, at); }
export function typeReview(raw, at = 'nobodyMissedReviews') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { history = [], ...flatPart } = raw;
  const t = typeSpec(REVIEW_SPEC, flatPart, label); if (!t.ok) return t;
  const r = t.record;
  if (r.state === 'dismissed' && r.dismissedAt === null) return bad(label, 'dismissedAt', 'is set once the candidate is dismissed');
  if (r.state === 'added_to_room' && r.roomId === null) return bad(label, 'roomId', 'names the Room the candidate was added to');
  const h = typeList(history, label, 'history', typeReviewTrailEntry); if (!h.ok) return h;
  return { ok: true, record: { ...r, history: h.value } };
}

/** A Second Look trail entry: `{ at, action, by }` plus `reason` on a resurfacing or a dismissal. */
function typeItemTrailEntry(raw, at) {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  const allowed = new Set(['at', 'action', 'by', 'reason']);
  const unknown = Object.keys(raw).filter((k) => !allowed.has(k));
  if (unknown.length) return { ok: false, reason: `${at} carries field(s) this build does not store: ${unknown.join(', ')}` };
  if (!Number.isSafeInteger(raw.at)) return bad(at, 'at', `must be an integer (got ${describe(raw.at)})`);
  if (!SECOND_LOOK_HISTORY_ACTIONS.includes(raw.action)) return bad(at, 'action', `must be one of ${SECOND_LOOK_HISTORY_ACTIONS.join('|')} (got ${describe(raw.action)})`);
  const system = raw.action === 'surfaced' || raw.action === 'resurfaced';
  let by = null;
  if (system) { if (raw.by !== null && raw.by !== undefined) return bad(at, 'by', 'is null: ScoutBox surfaced the item'); } else {
    const b = typeSpec([idf('userId', 'u', req), text('name', 'n', L.name)], raw.by, `${at}.by`); if (!b.ok) return b;
    by = b.record;
  }
  const withReason = raw.action === 'resurfaced' || raw.action === 'dismissed';
  const out = { at: raw.at, action: raw.action, by };
  if (withReason) {
    const reason = raw.reason ?? null;
    if (raw.action === 'resurfaced' && !RESURFACE_REASONS.includes(reason)) return bad(at, 'reason', `must be one of ${RESURFACE_REASONS.join('|')} (got ${describe(reason)})`);
    if (raw.action === 'dismissed' && reason !== null && !DISMISSAL_REASONS.includes(reason)) return bad(at, 'reason', `must be one of ${DISMISSAL_REASONS.join('|')} or null (got ${describe(reason)})`);
    out.reason = reason;
  } else if (raw.reason !== undefined) return bad(at, 'reason', `is not recorded on a ${raw.action} entry`);
  return { ok: true, record: out };
}
export function typeSecondLookItem(raw, at = 'secondLookItems') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { changeFingerprints, directReasonCodes, history = [], ...flatPart } = raw;
  const t = typeSpec(ITEM_SPEC, flatPart, label); if (!t.ok) return t;
  const r = t.record;
  if (r.status === 'reviewed' && r.reviewedAt === null) return bad(label, 'reviewedAt', 'is set once the item is reviewed');
  if (r.status === 'dismissed' && r.dismissedAt === null) return bad(label, 'dismissedAt', 'is set once the item is dismissed');
  if (r.status === 'reopened_room' && r.reopenedAt === null) return bad(label, 'reopenedAt', 'is set once the Room is reopened');
  const fp = typeValueList(changeFingerprints, label, 'changeFingerprints', { max: L.fingerprints, itemMax: L.fingerprint }); if (!fp.ok) return fp;
  const rc = typeValueList(directReasonCodes, label, 'directReasonCodes', { max: ARCHIVE_REASON_CODES.length, vocab: ARCHIVE_REASON_CODES }); if (!rc.ok) return rc;
  const h = typeList(history, label, 'history', typeItemTrailEntry); if (!h.ok) return h;
  return { ok: true, record: { ...r, changeFingerprints: fp.value, directReasonCodes: rc.value, history: h.value } };
}

/** One saved criterion: `{ id, type, operator, class, …body }`, its body the shape the criteria schema normalises, its id the one it derives. */
export function typeCriterion(raw, at, cls) {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  const shape = BODY[`${raw.type}:${raw.operator}`];
  if (!shape) return bad(at, 'type', `and operator must be a criterion the schema evaluates (got ${describe(raw.type)} ${describe(raw.operator)})`);
  if (raw.class !== cls) return bad(at, 'class', `must be ${cls} (got ${describe(raw.class)})`);
  const allowed = new Set(['id', 'type', 'operator', 'class', ...shape.map(([k]) => k)]);
  const unknown = Object.keys(raw).filter((k) => !allowed.has(k));
  if (unknown.length) return { ok: false, reason: `${at} carries field(s) this build does not store: ${unknown.join(', ')}` };
  const body = {};
  for (const [k, kind] of shape) {
    const v = raw[k];
    if (kind === 'list') { const l = typeValueList(v ?? null, at, k, { max: L.positions }); if (!l.ok) return l; body[k] = l.value; }
    else if (kind === 'range') { if (!Array.isArray(v) || v.length !== 2 || !v.every(Number.isSafeInteger) || v[0] > v[1]) return bad(at, k, `must be [low, high], whole numbers (got ${describe(v)})`); body[k] = [...v]; }
    else if (kind === 'num') { if (typeof v !== 'number' || !Number.isFinite(v)) return bad(at, k, `must be a finite number (got ${describe(v)})`); body[k] = v; }
    else if (kind === 'bool') { if (typeof v !== 'boolean') return bad(at, k, `must be true or false (got ${describe(v)})`); body[k] = v; }
    else {
      const max = k === 'protocol' ? L.protocol : L.criterionText;
      if (typeof v !== 'string' || !v.length || v.length > max) return bad(at, k, `must be text of 1 to ${max} characters (got ${describe(v)})`);
      if (k === 'evidenceKind' && !['any', 'footage'].includes(v)) return bad(at, k, `must be any|footage (got ${describe(v)})`);
      body[k] = v;
    }
  }
  const id = criterionId(raw.type, raw.operator, body);
  if (raw.id !== id) return bad(at, 'id', `must be the criterion's own id (${id})`);
  return { ok: true, record: { id, type: raw.type, operator: raw.operator, class: cls, ...body } };
}
export function typeCriteria(raw, label) {
  if (!isPlainObject(raw)) return bad(label, 'criteria', `must be an object (got ${describe(raw)})`);
  const unknown = Object.keys(raw).filter((k) => !['required', 'preferred', 'schemaVersion'].includes(k));
  if (unknown.length) return { ok: false, reason: `${label}.criteria carries field(s) this build does not store: ${unknown.join(', ')}` };
  const out = {};
  for (const cls of CRITERION_CLASSES) {
    const list = raw[cls] ?? [];
    if (!Array.isArray(list)) return bad(`${label}.criteria`, cls, `must be a list (got ${describe(list)})`);
    const typed = typeList(list, `${label}.criteria`, cls, (x, a) => typeCriterion(x, a, cls)); if (!typed.ok) return typed;
    if (new Set(typed.value.map((c) => c.id)).size !== typed.value.length) return bad(`${label}.criteria`, cls, 'names a criterion twice');
    out[cls] = typed.value;
  }
  if (!Number.isSafeInteger(raw.schemaVersion)) return bad(`${label}.criteria`, 'schemaVersion', `must be an integer (got ${describe(raw.schemaVersion)})`);
  return { ok: true, record: { required: out.required, preferred: out.preferred, schemaVersion: raw.schemaVersion } };
}
export function typeWatchlist(raw, at = 'dynamicWatchlists') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { criteria, sourceId = null, history = [], ...flatPart } = raw;
  const t = typeSpec(WATCHLIST_SPEC, flatPart, label); if (!t.ok) return t;
  const r = t.record;
  if (sourceId !== null && (typeof sourceId !== 'string' || !sourceId.length || sourceId.length > (r.sourceType === 'brief' ? L.id : L.ref))) return bad(label, 'sourceId', `must be text of 1 to ${r.sourceType === 'brief' ? L.id : L.ref} characters or null (got ${describe(sourceId)})`);
  if (r.sourceType === 'brief' && sourceId === null) return bad(label, 'sourceId', 'names the brief a brief-sourced watchlist follows');
  if (r.mode === 'live_linked' && r.sourceType !== 'brief') return bad(label, 'mode', 'is live_linked only for a brief-sourced watchlist');
  if ((r.lastReconciledAt === null) !== (r.lastCriteriaVersion === null)) return bad(label, 'lastCriteriaVersion', 'is recorded exactly when the watchlist was reconciled');
  if (r.rev < 1) return bad(label, 'rev', 'must be at least 1');
  const c = typeCriteria(criteria, label); if (!c.ok) return c;
  if (c.record.schemaVersion !== r.schemaVersion) return bad(label, 'schemaVersion', 'is the schema version of its criteria');
  const h = typeList(history, label, 'history', typeWatchlistHistoryEntry); if (!h.ok) return h;
  return { ok: true, record: { ...r, sourceId, criteria: c.record, history: h.value } };
}
/** The last derived membership: `[{ playerId, required: [{ criterionId, met }] }]`, one entry per player. */
export function typeMembers(list, label) {
  if (!Array.isArray(list)) return bad(label, 'members', `must be a list (got ${describe(list)})`);
  const out = [];
  for (const [i, m] of list.entries()) {
    const at = `${label}.members[${i}]`;
    if (!isPlainObject(m) || Object.keys(m).some((k) => !['playerId', 'required'].includes(k))) return { ok: false, reason: `${at} must be { playerId, required } (got ${describe(m)})` };
    if (typeof m.playerId !== 'string' || !m.playerId.length || m.playerId.length > L.id) return bad(at, 'playerId', `must be an id (got ${describe(m.playerId)})`);
    const req2 = typeList(m.required ?? [], at, 'required', (x, a) => {
      if (!isPlainObject(x) || Object.keys(x).some((k) => !['criterionId', 'met'].includes(k))) return { ok: false, reason: `${a} must be { criterionId, met }` };
      if (typeof x.criterionId !== 'string' || !x.criterionId.length || x.criterionId.length > L.criterionId) return bad(a, 'criterionId', 'must be a criterion id');
      if (typeof x.met !== 'boolean') return bad(a, 'met', 'must be true or false');
      return { ok: true, record: { criterionId: x.criterionId, met: x.met } };
    });
    if (!req2.ok) return req2;
    out.push({ playerId: m.playerId, required: req2.value });
  }
  if (new Set(out.map((m) => m.playerId)).size !== out.length) return bad(label, 'members', 'names a player twice');
  return { ok: true, value: out };
}
export const typeMembershipEvent = (raw, at = 'watchlistHistory') => typeSpec(EVENT_SPEC, raw, labelOf(at, raw));

// ------------------------------------------------------------------ rows
function statements(sqlite) {
  const p = (sql) => sqlite.prepare(sql);
  const auditCols = (spec, owner, detail) => [...spec.map((f) => f.c), owner, ...detail.map((f) => f.c)];
  const bh = auditCols(BRIEF_HISTORY_SPEC, 'brief_id', BRIEF_DETAIL_SPEC);
  const wh = auditCols(WATCHLIST_HISTORY_SPEC, 'watchlist_id', WATCHLIST_DETAIL_COLUMNS);
  const named = (t, cols) => p(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`);
  return {
    brief: p(upsertSql('recruitment_briefs', [...BRIEF_SPEC, ...BRIEF_CRITERIA_SPEC])),
    briefValuesOf: p('DELETE FROM recruitment_brief_values WHERE brief_id = ?'),
    briefValue: p('INSERT INTO recruitment_brief_values (brief_id, kind, ord, value) VALUES (?, ?, ?, ?)'),
    briefHistory: named('recruitment_brief_history', bh),
    review: p(upsertSql('nobody_missed_reviews', REVIEW_SPEC)),
    reviewTrail: p(insertSql('nobody_missed_review_history', [idf('reviewId', 'review_id'), int('ord', 'ord'), ...REVIEW_TRAIL_SPEC])),
    item: p(upsertSql('second_look_items', ITEM_SPEC)),
    itemFingerprintsOf: p('DELETE FROM second_look_item_fingerprints WHERE item_id = ?'),
    itemFingerprint: p('INSERT INTO second_look_item_fingerprints (item_id, ord, fingerprint) VALUES (?, ?, ?)'),
    itemReasonsOf: p('DELETE FROM second_look_item_reasons WHERE item_id = ?'),
    itemReason: p('INSERT INTO second_look_item_reasons (item_id, ord, code) VALUES (?, ?, ?)'),
    itemTrail: p('INSERT INTO second_look_item_history (item_id, ord, at, action, by_user_id, by_name, reason) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    watchlist: p(upsertSql('dynamic_watchlists', [...WATCHLIST_SPEC, idf('briefId', 'brief_id'), text('sourceRef', 'source_ref', L.ref)])),
    criteriaOf: p('DELETE FROM watchlist_criteria WHERE watchlist_id = ?'),
    criterion: p('INSERT INTO watchlist_criteria (watchlist_id, class, ord, criterion_id, type, operator, value_text, value_num, range_min, range_max, primary_only, evidence_kind, protocol) VALUES (@watchlist_id, @class, @ord, @criterion_id, @type, @operator, @value_text, @value_num, @range_min, @range_max, @primary_only, @evidence_kind, @protocol)'),
    criterionValue: p('INSERT INTO watchlist_criterion_values (watchlist_id, class, criterion_ord, ord, value) VALUES (?, ?, ?, ?, ?)'),
    watchlistHistory: named('watchlist_history', wh),
    membersOf: p('DELETE FROM watchlist_members WHERE watchlist_id = ?'),
    member: p('INSERT INTO watchlist_members (watchlist_id, player_id) VALUES (?, ?)'),
    memberCheck: p('INSERT INTO watchlist_member_checks (watchlist_id, player_id, ord, criterion_id, met) VALUES (?, ?, ?, ?, ?)'),
    event: p(insertSql('watchlist_membership_events', EVENT_SPEC)),
    eventByFingerprint: p('SELECT 1 FROM watchlist_membership_events WHERE fingerprint = ?'),
    historyTaken: p('SELECT 1 FROM recruitment_brief_history WHERE id = ? UNION ALL SELECT 1 FROM watchlist_history WHERE id = ?'),
  };
}
const encodeAudit = (spec, detailSpec, h, owner) => {
  const row = { ...encode(spec, h), ...owner };
  for (const f of detailSpec) row[f.c] = null;
  return row;
};
function writeBrief(st, rec, { known = 0 } = {}) {
  st.brief.run({ ...encode(BRIEF_SPEC, rec), ...encode(BRIEF_CRITERIA_SPEC, rec.criteria) });
  st.briefValuesOf.run(rec.id);
  for (const [field, kind] of Object.entries(BRIEF_VALUE_KINDS)) rec.criteria[field].forEach((v, i) => st.briefValue.run(rec.id, kind, i, v));
  for (const h of rec.history.slice(known)) {
    if (st.historyTaken.get(h.id, h.id)) throw refusal('DISCOVERY_DUPLICATE', `recruitment_brief_history ${h.id} already exists`);
    const row = encodeAudit(BRIEF_HISTORY_SPEC, BRIEF_DETAIL_SPEC, h, { brief_id: rec.id });
    encode(BRIEF_DETAIL_SPEC, h.detail ?? {}, row);
    st.briefHistory.run(row);
  }
}
function writeReview(st, rec, { known = 0 } = {}) {
  st.review.run(encode(REVIEW_SPEC, rec));
  rec.history.slice(known).forEach((h, i) => st.reviewTrail.run({ review_id: rec.id, ord: known + i, ...encode(REVIEW_TRAIL_SPEC, h) }));
}
function writeItem(st, rec, { known = 0 } = {}) {
  st.item.run(encode(ITEM_SPEC, rec));
  st.itemFingerprintsOf.run(rec.id); st.itemReasonsOf.run(rec.id);
  rec.changeFingerprints.forEach((f, i) => st.itemFingerprint.run(rec.id, i, f));
  rec.directReasonCodes.forEach((c, i) => st.itemReason.run(rec.id, i, c));
  rec.history.slice(known).forEach((h, i) => st.itemTrail.run(rec.id, known + i, h.at, h.action, h.by?.userId ?? null, h.by?.name ?? null, h.reason ?? null));
}
function criterionRow(watchlistId, c, ord) {
  const row = { watchlist_id: watchlistId, class: c.class, ord, criterion_id: c.id, type: c.type, operator: c.operator, value_text: null, value_num: null, range_min: null, range_max: null, primary_only: null, evidence_kind: null, protocol: null };
  for (const [k, kind] of BODY[`${c.type}:${c.operator}`]) {
    if (kind === 'list') continue;
    if (kind === 'range') { [row.range_min, row.range_max] = c[k]; continue; }
    if (k === 'value') row[CRITERION_COLUMN.value[kind]] = c[k];
    else row[CRITERION_COLUMN[k]] = kind === 'bool' ? (c[k] ? 1 : 0) : c[k];
  }
  return row;
}
function writeWatchlist(st, rec, { known = 0, criteria = true } = {}) {
  const brief = rec.sourceType === 'brief';
  st.watchlist.run({ ...encode(WATCHLIST_SPEC, rec), brief_id: brief ? rec.sourceId : null, source_ref: brief ? null : rec.sourceId });
  if (criteria) {
    st.criteriaOf.run(rec.id);
    for (const cls of CRITERION_CLASSES) {
      rec.criteria[cls].forEach((c, i) => {
        st.criterion.run(criterionRow(rec.id, c, i));
        for (const [k, kind] of BODY[`${c.type}:${c.operator}`]) if (kind === 'list') c[k].forEach((v, j) => st.criterionValue.run(rec.id, cls, i, j, v));
      });
    }
  }
  for (const h of rec.history.slice(known)) {
    if (st.historyTaken.get(h.id, h.id)) throw refusal('DISCOVERY_DUPLICATE', `watchlist_history ${h.id} already exists`);
    const row = encodeAudit(WATCHLIST_HISTORY_SPEC, WATCHLIST_DETAIL_COLUMNS, h, { watchlist_id: rec.id });
    const d = h.detail ?? {};
    row.detail_mode = d.mode ?? null; row.detail_source_type = d.sourceType ?? null; row.detail_status = d.status ?? null;
    for (const f of WATCHLIST_CHANGED_FIELDS) row[changedCol(f)] = d.changed ? (d.changed.includes(f) ? 1 : 0) : null;
    st.watchlistHistory.run(row);
  }
}
function writeMembers(st, watchlistId, members) {
  st.membersOf.run(watchlistId);
  for (const m of members) {
    st.member.run(watchlistId, m.playerId);
    m.required.forEach((r, i) => st.memberCheck.run(watchlistId, m.playerId, i, r.criterionId, r.met ? 1 : 0));
  }
}

const decodeAuditRow = (spec, detailSpec) => (h) => {
  const e = decode(spec, h);
  const d = Object.fromEntries(Object.entries(decode(detailSpec, h)).filter(([, v]) => v !== null));
  return { ...e, detail: Object.keys(d).length ? d : null };
};
const decodeBriefHistory = decodeAuditRow(BRIEF_HISTORY_SPEC, BRIEF_DETAIL_SPEC);
function decodeWatchlistHistory(h) {
  const e = decode(WATCHLIST_HISTORY_SPEC, h);
  const d = {};
  if (h[changedCol('name')] !== null) d.changed = WATCHLIST_CHANGED_FIELDS.filter((f) => h[changedCol(f)] === 1);
  if (h.detail_mode !== null) d.mode = h.detail_mode;
  if (h.detail_source_type !== null) d.sourceType = h.detail_source_type;
  if (h.detail_status !== null) d.status = h.detail_status;
  return { ...e, detail: Object.keys(d).length ? d : null };
}
function decodeBriefs(sqlite, rows, { history = true } = {}) {
  const bids = rows.map((r) => r.id);
  const values = childRowsOf(sqlite, 'recruitment_brief_values', 'brief_id', bids, { order: 'ord', subKey: ['kind'] });
  const hist = history ? childRowsOf(sqlite, 'recruitment_brief_history', 'brief_id', bids) : null;
  return rows.map((row) => {
    const c = decode(BRIEF_CRITERIA_SPEC, row);
    const list = (field) => values.all(row.id, BRIEF_VALUE_KINDS[field]).map((v) => v.value);
    const positions = list('positions');
    return {
      ...decode(BRIEF_SPEC, row),
      criteria: {
        positions, positionGroups: [...new Set(positions.map((p) => POSITION_GROUP_OF[p]))], minAge: c.minAge, maxAge: c.maxAge, radiusKm: c.radiusKm,
        maxLevel: c.maxLevel, foot: c.foot, availability: c.availability, evidenceRequirements: list('evidenceRequirements'), minTrustBand: c.minTrustBand,
        combineProtocols: list('combineProtocols'),
      },
      ...(history ? { history: hist.all(row.id).map(decodeBriefHistory) } : {}),
    };
  });
}
function decodeReviews(sqlite, rows) {
  const trail = childRowsOf(sqlite, 'nobody_missed_review_history', 'review_id', rows.map((r) => r.id), { order: 'ord' });
  return rows.map((row) => ({ ...decode(REVIEW_SPEC, row), history: trail.all(row.id).map((h) => decode(REVIEW_TRAIL_SPEC, h)) }));
}
function decodeItems(sqlite, rows) {
  const iids = rows.map((r) => r.id);
  const fps = childRowsOf(sqlite, 'second_look_item_fingerprints', 'item_id', iids, { order: 'ord' });
  const reasons = childRowsOf(sqlite, 'second_look_item_reasons', 'item_id', iids, { order: 'ord' });
  const trail = childRowsOf(sqlite, 'second_look_item_history', 'item_id', iids, { order: 'ord' });
  return rows.map((row) => ({
    ...decode(ITEM_SPEC, row),
    changeFingerprints: fps.all(row.id).map((f) => f.fingerprint),
    directReasonCodes: reasons.all(row.id).map((r) => r.code),
    history: trail.all(row.id).map((h) => ({
      at: h.at, action: h.action, by: h.by_user_id === null ? null : { userId: h.by_user_id, name: h.by_name },
      ...(h.action === 'resurfaced' || h.action === 'dismissed' ? { reason: h.reason } : {}),
    })),
  }));
}
function decodeCriterion(row, values) {
  const c = { id: row.criterion_id, type: row.type, operator: row.operator, class: row.class };
  for (const [k, kind] of BODY[`${row.type}:${row.operator}`]) {
    if (kind === 'list') c[k] = values.all(row.watchlist_id, row.class, row.ord).map((v) => v.value);
    else if (kind === 'range') c[k] = [row.range_min, row.range_max];
    else if (k === 'value') c[k] = row[CRITERION_COLUMN.value[kind]];
    else if (kind === 'bool') c[k] = row[CRITERION_COLUMN[k]] === 1;
    else c[k] = row[CRITERION_COLUMN[k]];
  }
  return c;
}
function decodeWatchlists(sqlite, rows, { history = true } = {}) {
  const wids = rows.map((r) => r.id);
  const crit = childRowsOf(sqlite, 'watchlist_criteria', 'watchlist_id', wids, { order: 'ord', subKey: ['class'] });
  const values = childRowsOf(sqlite, 'watchlist_criterion_values', 'watchlist_id', wids, { order: 'ord', subKey: ['class', 'criterion_ord'] });
  const hist = history ? childRowsOf(sqlite, 'watchlist_history', 'watchlist_id', wids) : null;
  return rows.map((row) => {
    const w = decode(WATCHLIST_SPEC, row);
    const { schemaVersion } = w;
    const rec = {
      id: w.id, orgId: w.orgId, name: w.name, mode: w.mode, status: w.status, sourceType: w.sourceType,
      sourceId: row.brief_id ?? row.source_ref ?? null,
      criteria: { required: crit.all(row.id, 'required').map((c) => decodeCriterion(c, values)), preferred: crit.all(row.id, 'preferred').map((c) => decodeCriterion(c, values)), schemaVersion },
      ...Object.fromEntries(Object.entries(w).filter(([k]) => !['id', 'orgId', 'name', 'mode', 'status', 'sourceType'].includes(k))),
    };
    if (history) rec.history = hist.all(row.id).map(decodeWatchlistHistory);
    return rec;
  });
}
function decodeMembers(sqlite, watchlistIds) {
  const members = childRowsOf(sqlite, 'watchlist_members', 'watchlist_id', watchlistIds, { order: 'player_id' });
  const checks = childRowsOf(sqlite, 'watchlist_member_checks', 'watchlist_id', watchlistIds, { order: 'ord', subKey: ['player_id'] });
  return (id) => members.all(id).map((m) => ({ playerId: m.player_id, required: checks.all(id, m.player_id).map((c) => ({ criterionId: c.criterion_id, met: c.met === 1 })) }));
}
const decodeEvent = (row) => decode(EVENT_SPEC, row);

// ------------------------------------------------------------------ whole-domain read (the test suites)
export const discoveryLive = (sqlite) => migrationApplied(sqlite, DISCOVERY_MIGRATION);
function readAll(sqlite) {
  const all = (t) => sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
  const wl = all('dynamic_watchlists');
  const membersOf = decodeMembers(sqlite, wl.map((w) => w.id));
  return {
    recruitmentBriefs: decodeBriefs(sqlite, all('recruitment_briefs')),
    nobodyMissedReviews: decodeReviews(sqlite, all('nobody_missed_reviews')),
    secondLookItems: decodeItems(sqlite, all('second_look_items')),
    // A watchlist's last derived membership travels with it (`members`, empty until it was reconciled).
    dynamicWatchlists: decodeWatchlists(sqlite, wl).map((w) => ({ ...w, members: membersOf(w.id) })),
    watchlistHistory: all('watchlist_membership_events').map(decodeEvent),
  };
}
/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const DISCOVERY_RECORDS = {
  names: DISCOVERY_COLLECTIONS,
  read(sqlite) { return discoveryLive(sqlite) ? readAll(sqlite) : null; },
};
const PLAYER_REFS_SQL = 'SELECT player_id AS pid FROM nobody_missed_reviews UNION ALL SELECT player_id FROM second_look_items UNION ALL SELECT player_id FROM watchlist_members UNION ALL SELECT player_id FROM watchlist_membership_events';
export const unresolvedPlayerReferences = (sqlite) => (discoveryLive(sqlite)
  ? sqlite.prepare(`SELECT count(*) AS n FROM (${PLAYER_REFS_SQL}) x WHERE NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid)`).get().n
  : null);

// ------------------------------------------------------------------ the repository
const WRITES = new Set(['create', 'update', 'reconcile']);
const clone = (v) => JSON.parse(JSON.stringify(v));
const canonical = (v) => (Array.isArray(v) ? v.map(canonical) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v);
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * `createDiscoveryRepository({ sqlite, unit, now, log })`: `briefs`, `reviews` (Nobody Missed), `secondLook`,
 * `watchlists` and `events` (the membership transitions), each with its writes and queries, plus `reads` (the queries
 * alone: `discoveryReads`).
 */
export function createDiscoveryRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the discovery repository needs a SQLite connection (node:sqlite)');
  const operation = (fn) => (unit?.active?.() ? unit.join(fn) : sqlite.isTransaction ? fn() : transaction(sqlite, fn));
  const cache = new Map();
  const q = (sql) => { let s = cache.get(sql); if (!s) cache.set(sql, (s = sqlite.prepare(sql))); return s; };
  const st = statements(sqlite);
  const updating = new Set();
  const guard = (key, fn) => {
    if (updating.has(key)) throw refusal('DISCOVERY_NESTED_UPDATE', `${key} is already being updated; make the second change after the first returns`);
    updating.add(key);
    try { return fn(); } finally { updating.delete(key); }
  };
  const typedOr = (type, raw, name) => { const t = type(raw, name); if (!t.ok) throw refusal('DISCOVERY_INPUT_INVALID', t.reason); return t.record; };
  const json = (list) => JSON.stringify([...list]);
  const one = (decoder) => (sql) => (...args) => { if (typeof args[0] !== 'string') return null; const row = q(sql).get(...args); return row ? deepFreeze(decoder([row])[0]) : null; };
  const many = (decoder) => (sql) => (...args) => decoder(q(sql).all(...args)).map(deepFreeze);
  /** The common shape of an update: a plain copy edited by `change`, typed whole, fixed fields and the trail kept. */
  const updater = ({ table, type, byId: find, immutable, write, check = () => {} }) => (id, change) => guard(`${table} ${id}`, () => operation(() => {
    if (typeof change !== 'function') throw new TypeError(`${table}.update(id, change) needs a function that edits the copy it is given`);
    const stored = find(id);
    if (!stored) throw refusal('DISCOVERY_NOT_FOUND', `${table} ${id} is not a record of the repository`);
    const draft = clone(stored);
    const returned = change(draft);
    const next = typedOr(type, returned === undefined ? draft : returned, table);
    for (const k of immutable) if (!same(next[k], stored[k])) throw refusal('DISCOVERY_INPUT_INVALID', `${table} ${id}: ${k} cannot change`);
    noTrailRewrite(stored, next, `${table} ${id}`);
    check(next, stored);
    write(next, stored);
    return find(id);
  }));
  const orgExists = (orgId) => !!q('SELECT 1 FROM orgs WHERE id = ?').get(orgId);
  const needOrg = (table, rec) => { if (!orgExists(rec.orgId)) throw refusal('DISCOVERY_REFERENCE_MISSING', `${table} ${rec.id}: orgId names no organisation (${rec.orgId})`); };

  // ---- briefs
  const decB = (rows) => decodeBriefs(sqlite, rows);
  const briefById = one(decB)('SELECT * FROM recruitment_briefs WHERE id = ?');
  const BRIEF_ORDER = 'updated_at DESC, id';
  const briefs = {
    create: (raw) => operation(() => {
      const r = typedOr(typeBrief, raw, 'recruitmentBriefs');
      if (briefById(r.id)) throw refusal('DISCOVERY_DUPLICATE', `recruitment_briefs ${r.id} already exists`);
      needOrg('recruitment_briefs', r);
      writeBrief(st, r);
      return briefById(r.id);
    }),
    /** `update(id, change)`: the organisation, author and creation never change; the history only grows. */
    update: updater({
      table: 'recruitment_briefs', type: typeBrief, byId: briefById, immutable: ['id', 'orgId', 'createdBy', 'createdAt'],
      check: (next, stored) => { if (next.version < stored.version) throw refusal('DISCOVERY_INPUT_INVALID', `recruitment_briefs ${stored.id}: the criteria version only grows`); },
      write: (next, stored) => writeBrief(st, next, { known: stored.history.length }),
    }),
    byId: briefById,
    /** This organisation's brief, or null (another organisation's id is no brief). */
    forOrgById: one(decB)('SELECT * FROM recruitment_briefs WHERE id = ? AND org_id = ?'),
    /** The organisation's briefs, most recently updated first then id. */
    forOrg: many(decB)(`SELECT * FROM recruitment_briefs WHERE org_id = ? ORDER BY ${BRIEF_ORDER}`),
    countForOrg: (orgId) => q('SELECT COUNT(*) AS n FROM recruitment_briefs WHERE org_id = ?').get(orgId).n,
    /** The trail entries an organisation's audit feed shows (`actions`), each with its brief's id and title, insertion order. */
    historyFeed: (orgId, actions) => deepFreeze(q('SELECT h.*, b.title AS brief_title FROM recruitment_brief_history h JOIN recruitment_briefs b ON b.id = h.brief_id WHERE b.org_id = ? AND h.action IN (SELECT value FROM json_each(?)) ORDER BY h.rowid').all(orgId, json(actions))
      .map((h) => ({ entry: decodeBriefHistory(h), brief: { id: h.brief_id, title: h.brief_title } }))),
  };

  // ---- Nobody Missed reviews
  const decR = (rows) => decodeReviews(sqlite, rows);
  const reviewById = one(decR)('SELECT * FROM nobody_missed_reviews WHERE id = ?');
  const reviewNeeds = (r) => {
    const b = briefById(r.briefId);
    if (!b) throw refusal('DISCOVERY_REFERENCE_MISSING', `nobody_missed_reviews ${r.id}: briefId names no brief (${r.briefId})`);
    if (b.orgId !== r.orgId) throw refusal('DISCOVERY_INPUT_INVALID', `nobody_missed_reviews ${r.id}: the brief is another organisation's`);
  };
  const reviews = {
    create: (raw) => operation(() => {
      const r = typedOr(typeReview, raw, 'nobodyMissedReviews');
      if (reviewById(r.id)) throw refusal('DISCOVERY_DUPLICATE', `nobody_missed_reviews ${r.id} already exists`);
      reviewNeeds(r);
      if (q('SELECT 1 FROM nobody_missed_reviews WHERE org_id = ? AND brief_id = ? AND player_id = ?').get(r.orgId, r.briefId, r.playerId)) throw refusal('DISCOVERY_DUPLICATE', `nobody_missed_reviews: ${r.orgId} already has a review of ${r.playerId} for ${r.briefId}`);
      writeReview(st, r);
      return reviewById(r.id);
    }),
    /** `update(id, change)`: the organisation, brief, player and creation never change; the trail only grows. */
    update: updater({
      table: 'nobody_missed_reviews', type: typeReview, byId: reviewById, immutable: ['id', 'orgId', 'briefId', 'playerId', 'createdAt'],
      write: (next, stored) => writeReview(st, next, { known: stored.history.length }),
    }),
    byId: reviewById,
    /** This organisation's review of this player for this brief, or null. */
    byKey: one(decR)('SELECT * FROM nobody_missed_reviews WHERE org_id = ? AND brief_id = ? AND player_id = ?'),
    /** The organisation's reviews for one brief, insertion order. */
    forBrief: many(decR)('SELECT * FROM nobody_missed_reviews WHERE org_id = ? AND brief_id = ? ORDER BY rowid'),
    /** Every review of the organisation, insertion order (the analytics projection). */
    forOrg: many(decR)('SELECT * FROM nobody_missed_reviews WHERE org_id = ? ORDER BY rowid'),
  };

  // ---- Second Look items
  const decI = (rows) => decodeItems(sqlite, rows);
  const itemById = one(decI)('SELECT * FROM second_look_items WHERE id = ?');
  const itemNeeds = (r) => {
    const room = q('SELECT org_id, player_id FROM recruitment_cases WHERE id = ?').get(r.roomId);
    if (!room) throw refusal('DISCOVERY_REFERENCE_MISSING', `second_look_items ${r.id}: roomId names no room (${r.roomId})`);
    if (room.org_id !== r.orgId || room.player_id !== r.playerId) throw refusal('DISCOVERY_INPUT_INVALID', `second_look_items ${r.id}: the room is not this organisation's room for this player`);
    if (!q('SELECT 1 FROM room_decisions WHERE id = ?').get(r.decisionId)) throw refusal('DISCOVERY_REFERENCE_MISSING', `second_look_items ${r.id}: decisionId names no decision (${r.decisionId})`);
  };
  const secondLook = {
    create: (raw) => operation(() => {
      const r = typedOr(typeSecondLookItem, raw, 'secondLookItems');
      if (itemById(r.id)) throw refusal('DISCOVERY_DUPLICATE', `second_look_items ${r.id} already exists`);
      itemNeeds(r);
      if (q('SELECT 1 FROM second_look_items WHERE org_id = ? AND room_id = ? AND decision_id = ?').get(r.orgId, r.roomId, r.decisionId)) throw refusal('DISCOVERY_DUPLICATE', `second_look_items: ${r.orgId} already has an item for room ${r.roomId} and decision ${r.decisionId}`);
      writeItem(st, r);
      return itemById(r.id);
    }),
    /** `update(id, change)`: the organisation, player, room, decision cycle and creation never change; the trail only grows. */
    update: updater({
      table: 'second_look_items', type: typeSecondLookItem, byId: itemById, immutable: ['id', 'orgId', 'playerId', 'roomId', 'decisionId', 'createdAt'],
      write: (next, stored) => writeItem(st, next, { known: stored.history.length }),
    }),
    byId: itemById,
    /** This organisation's item, or null (another organisation's id is no item). */
    forOrgById: one(decI)('SELECT * FROM second_look_items WHERE id = ? AND org_id = ?'),
    /** The item of one decision cycle of one room, or null. */
    byKey: one(decI)('SELECT * FROM second_look_items WHERE org_id = ? AND room_id = ? AND decision_id = ?'),
    /** Every item of the organisation, insertion order. */
    forOrg: many(decI)('SELECT * FROM second_look_items WHERE org_id = ? ORDER BY rowid'),
    forOrgPlayer: many(decI)('SELECT * FROM second_look_items WHERE org_id = ? AND player_id = ? ORDER BY rowid'),
  };

  // ---- watchlists
  const decW = (rows) => decodeWatchlists(sqlite, rows);
  const watchlistById = one(decW)('SELECT * FROM dynamic_watchlists WHERE id = ?');
  const watchlistNeeds = (r, stored = null) => {
    if (r.sourceType !== 'brief' || r.sourceId === stored?.sourceId) return;
    const b = briefById(r.sourceId);
    if (!b) throw refusal('DISCOVERY_REFERENCE_MISSING', `dynamic_watchlists ${r.id}: sourceId names no brief (${r.sourceId})`);
    if (b.orgId !== r.orgId) throw refusal('DISCOVERY_INPUT_INVALID', `dynamic_watchlists ${r.id}: the brief is another organisation's`);
  };
  const WATCHLIST_ORDER = 'updated_at DESC, id ASC';
  const RECONCILE_FIELDS = ['lastCriteriaVersion', 'lastBriefVersion', 'lastReconciledAt'];
  const watchlists = {
    create: (raw) => operation(() => {
      const r = typedOr(typeWatchlist, raw, 'dynamicWatchlists');
      if (watchlistById(r.id)) throw refusal('DISCOVERY_DUPLICATE', `dynamic_watchlists ${r.id} already exists`);
      needOrg('dynamic_watchlists', r);
      watchlistNeeds(r);
      if (r.lastReconciledAt !== null) throw refusal('DISCOVERY_INPUT_INVALID', `dynamic_watchlists ${r.id}: a new watchlist has not been reconciled`);
      writeWatchlist(st, r);
      return watchlistById(r.id);
    }),
    /**
     * `update(id, change)`: the organisation, source, author and creation never change, nor what the last reconciliation
     * recorded (only `reconcile` writes that); the history only grows.
     */
    update: updater({
      table: 'dynamic_watchlists', type: typeWatchlist, byId: watchlistById,
      immutable: ['id', 'orgId', 'sourceType', 'sourceId', 'createdBy', 'createdByName', 'createdAt', ...RECONCILE_FIELDS],
      write: (next, stored) => writeWatchlist(st, next, { known: stored.history.length, criteria: !same(next.criteria, stored.criteria) }),
    }),
    /**
     * Record a reconciliation: the membership derived now (`members`, `[{ playerId, required: [{ criterionId, met }] }]`)
     * replaces the last one, the transitions not seen before are appended (a fingerprint already recorded is one
     * transition, skipped), and the watchlist records the criteria and brief version it was evaluated against.
     * Returns the events it appended.
     */
    reconcile: (id, { at, criteriaVersion, briefVersion = null, members, events = [] }) => guard(`dynamic_watchlists ${id}`, () => operation(() => {
      const stored = watchlistById(id);
      if (!stored) throw refusal('DISCOVERY_NOT_FOUND', `dynamic_watchlists ${id} is not a record of the repository`);
      const next = typedOr(typeWatchlist, { ...clone(stored), lastCriteriaVersion: criteriaVersion, lastBriefVersion: briefVersion, lastReconciledAt: at }, 'dynamic_watchlists');
      const m = typeMembers(members, `dynamic_watchlists ${id}`); if (!m.ok) throw refusal('DISCOVERY_INPUT_INVALID', m.reason);
      const fresh = [];
      const seen = new Set(); // membership is uncapped, so the batch's own duplicates are found by key
      for (const [i, raw] of events.entries()) {
        const e = typedOr(typeMembershipEvent, raw, `dynamic_watchlists ${id} events[${i}]`);
        if (e.watchlistId !== id || e.orgId !== stored.orgId) throw refusal('DISCOVERY_INPUT_INVALID', `dynamic_watchlists ${id}: event ${e.id} names another watchlist or organisation`);
        if (seen.has(e.fingerprint) || st.eventByFingerprint.get(e.fingerprint)) continue;
        seen.add(e.fingerprint);
        fresh.push(e);
      }
      writeWatchlist(st, next, { known: stored.history.length, criteria: false });
      writeMembers(st, id, m.value);
      for (const e of fresh) st.event.run(encode(EVENT_SPEC, e));
      return deepFreeze(fresh.map((e) => ({ ...e })));
    })),
    byId: watchlistById,
    /** This organisation's watchlist, or null (another organisation's id is no watchlist). */
    forOrgById: one(decW)('SELECT * FROM dynamic_watchlists WHERE id = ? AND org_id = ?'),
    /** The last derived membership: `{ playerIds (sorted), required: Map playerId → [{ criterionId, met }] }`, or null before the first reconciliation. */
    membership: (id) => {
      const w = q('SELECT last_reconciled_at FROM dynamic_watchlists WHERE id = ?').get(id);
      if (!w || w.last_reconciled_at === null) return null;
      const list = decodeMembers(sqlite, [id])(id);
      return deepFreeze({ playerIds: list.map((m) => m.playerId), required: new Map(list.map((m) => [m.playerId, m.required])) });
    },
    /**
     * A page of the organisation's watchlists, most recently updated first then id (without their history):
     * `{ rows, total }`; `after` is the `[updatedAt, id]` of the last row of the previous page.
     */
    page: (orgId, { status = null, after = null, limit = 50 } = {}) => {
      const cond = 'org_id = ? AND (? IS NULL OR status = ?)';
      const rows = q(`SELECT * FROM dynamic_watchlists WHERE ${cond} AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND id > ?)) ORDER BY ${WATCHLIST_ORDER} LIMIT ?`)
        .all(orgId, status, status, after?.[0] ?? null, after?.[0] ?? null, after?.[0] ?? null, after?.[1] ?? null, limit + 1);
      return { rows: decodeWatchlists(sqlite, rows, { history: false }).map(deepFreeze), total: q(`SELECT COUNT(*) AS n FROM dynamic_watchlists WHERE ${cond}`).get(orgId, status, status).n };
    },
    /** How many of the organisation's watchlists are not archived (the per-organisation limit). */
    openCount: (orgId) => q("SELECT COUNT(*) AS n FROM dynamic_watchlists WHERE org_id = ? AND status <> 'archived'").get(orgId).n,
    /** Every watchlist of the organisation, without history (the analytics projection), insertion order. */
    forOrg: (orgId) => decodeWatchlists(sqlite, q('SELECT * FROM dynamic_watchlists WHERE org_id = ? ORDER BY rowid').all(orgId), { history: false }).map(deepFreeze),
    /** The trail entries an organisation's audit feed shows (`actions`), each with its watchlist's id and name, insertion order. */
    historyFeed: (orgId, actions) => deepFreeze(q('SELECT h.*, w.name AS watchlist_name FROM watchlist_history h JOIN dynamic_watchlists w ON w.id = h.watchlist_id WHERE w.org_id = ? AND h.action IN (SELECT value FROM json_each(?)) ORDER BY h.rowid').all(orgId, json(actions))
      .map((h) => ({ entry: decodeWatchlistHistory(h), watchlist: { id: h.watchlist_id, name: h.watchlist_name } }))),
  };

  // ---- membership events
  const events = {
    /** A page of one watchlist's transitions, newest first then id descending: `{ rows, total }`; `after` is `[at, id]`. */
    page: (watchlistId, { after = null, limit = 50 } = {}) => ({
      rows: q('SELECT * FROM watchlist_membership_events WHERE watchlist_id = ? AND (? IS NULL OR at < ? OR (at = ? AND id < ?)) ORDER BY at DESC, id DESC LIMIT ?')
        .all(watchlistId, after?.[0] ?? null, after?.[0] ?? null, after?.[0] ?? null, after?.[1] ?? null, limit + 1).map((r) => deepFreeze(decodeEvent(r))),
      total: q('SELECT COUNT(*) AS n FROM watchlist_membership_events WHERE watchlist_id = ?').get(watchlistId).n,
    }),
    /** The transitions of the watchlist's most recent recorded change (every event at the latest instant). */
    lastBatch: (watchlistId) => q('SELECT * FROM watchlist_membership_events WHERE watchlist_id = ? AND at = (SELECT MAX(at) FROM watchlist_membership_events WHERE watchlist_id = ?) ORDER BY rowid')
      .all(watchlistId, watchlistId).map((r) => deepFreeze(decodeEvent(r))),
    /** The organisation's transitions, oldest first (the analytics projection; `from` / `to` bound the instant). */
    forOrg: (orgId, { from = null, to = null } = {}) => q('SELECT * FROM watchlist_membership_events WHERE org_id = ? AND (? IS NULL OR at >= ?) AND (? IS NULL OR at <= ?) ORDER BY at, rowid')
      .all(orgId, from, from, to, to).map((r) => deepFreeze(decodeEvent(r))),
  };

  const readOnly = (o) => Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => !WRITES.has(k))));
  const repo = { briefs, reviews, secondLook, watchlists, events };
  const counters = Object.fromEntries([
    ['recruitmentBriefs', 'recruitment_briefs'], ['nobodyMissedReviews', 'nobody_missed_reviews'], ['secondLookItems', 'second_look_items'],
    ['dynamicWatchlists', 'dynamic_watchlists'], ['watchlistHistory', 'watchlist_membership_events'],
  ].map(([n, t]) => [n, q(`SELECT COUNT(*) AS n FROM ${t}`)]));
  return {
    ...repo,
    /** The queries alone, for modules and projectors that must not write (`discoveryReads`). */
    reads: Object.freeze(Object.fromEntries(Object.entries(repo).map(([k, v]) => [k, readOnly(v)]))),
    attach() {
      if (!discoveryLive(sqlite)) throw new Error(`the discovery repository needs ${DISCOVERY_MIGRATION} recorded; it never imports an in-memory array`);
      return { counts: this.counts() };
    },
    counts() { return Object.fromEntries(DISCOVERY_COLLECTIONS.map((n) => [n, counters[n].get().n])); },
    pending: () => 0,
    exportAll() { return DISCOVERY_RECORDS.read(sqlite); },
    log,
    now,
  };
}
