/**
 * Insight and coverage.
 *
 * Records:
 *   - An exposure event: one per (organisation, player, kind, UTC day), unique. Recording one is an insert that does
 *     nothing when the day already has it. Every reader looks at the last 90 days only; the insight sweep deletes what
 *     lies before that window (`exposure.prune`), so the table stays bounded without a global cap.
 *   - A review-later deferral: one per (organisation, player), unique; deferring again replaces it. The sweep finds the
 *     due ones by an indexed query and marks each reminded with its notification.
 *   - An evidence suggestion: a gap one rule found for one player, its cited record ids as ordered rows. At most one
 *     open (suggested or requested) suggestion per (organisation, player, rule). `reconcile` is the explicit upsert the
 *     evidence-gaps read calls. The rule's action copy is the rule registry's, not stored.
 *   - A calibration session: the rubric is the pinned template version (a key to assessment_templates), never a copy;
 *     participants, blind submissions with their ratings, and discussion notes are rows.
 *   - A fixture: an organisation's own record of a match on a real day, with an optional location.
 *   - A coverage plan: a goal of observations over a window.
 *   - A coverage assignment: a scout sent to a fixture. The fixture is the organisation's own (`fixture_id`), a friendly
 *     (`friendly_id`) or an open day (`open_trial_id`), each a key: exactly one is set, by kind. The two event keys name
 *     tables created by 0037, so no assignment to an event can be written before that migration is recorded. Target
 *     players and the warnings raised at creation are rows; the observation, the assessment it produced and a
 *     cancellation are columns.
 *
 * Every write joins the open unit of work, the caller's transaction or its own. Records are deep-frozen; lists decode
 * child rows in one batch. Modules receive the queries as `insightReads`.
 *
 * References. Player, media and assessment ids carry no key (tolerant: records outlive an account deletion).
 * Organisations, the staff named and the calibration template version are RESTRICT keys; so are the keys inside the
 * domain (an assignment's own fixture, a submission's participant). Child rows cascade with their owner.
 */
import { isPlainObject, ids, describe } from './recruitment.mjs';
import { transaction, migrationApplied, childRowsOf } from './database.mjs';
import { deepFreeze } from '../domains/platform/values.mjs';
import {
  text,
  int,
  num,
  oneOf,
  group,
  tableDdl,
  bad,
  typeSpec,
  encode,
  decode,
  insertSql,
  upsertSql,
} from './fieldSpecs.mjs';
import { parseStrictDateOnly } from '../temporal.mjs';
import { CURRENCIES } from '../domains/recruitment/money.mjs';

export const INSIGHT_COVERAGE_MIGRATION = '0033_insight_coverage';
export const INSIGHT_COVERAGE_COLLECTIONS = Object.freeze([
  'exposureEvents',
  'reviewLater',
  'evidenceSuggestions',
  'calibrationSessions',
  'fixtures',
  'coveragePlans',
  'coverageAssignments',
]);

// ------------------------------------------------------------------ vocabularies and limits (one definition)
export const EXPOSURE_KINDS = Object.freeze(['impression', 'profile_view', 'evidence_view']);
/** The evidence-gap rules (domains/insight/insight.mjs RULES must name exactly these). */
export const EVIDENCE_RULE_IDS = Object.freeze([
  'no_recent_footage',
  'single_match_sample',
  'attribute_never_observed',
  'assessment_disagreement',
  'stale_assessment',
  'uncorroborated_claims',
]);
export const SUGGESTION_STATUSES = Object.freeze(['suggested', 'requested', 'supplied', 'dismissed', 'reviewed']);
export const OPEN_SUGGESTION_STATUSES = Object.freeze(['suggested', 'requested']);
export const CALIBRATION_STATUSES = Object.freeze(['open', 'closed']);
export const CALIBRATION_CONFIDENCE = Object.freeze(['low', 'medium', 'high']);
export const FIXTURE_KINDS = Object.freeze(['own', 'friendly_board', 'open_trial']);
export const ASSIGNMENT_WARNINGS = Object.freeze(['duplicate_visit', 'scout_clash']);
export const INSIGHT_LIMITS = Object.freeze({
  id: 80,
  name: 200,
  explanation: 1000,
  records: 200,
  calibrationTitle: 120,
  participants: 50,
  ratings: 40,
  note: 500,
  notes: 500,
  team: 80,
  competition: 80,
  city: 60,
  label: 100,
  region: 80,
  fixtureLabel: 200,
  targets: 200,
  goal: [1, 200],
  windowDays: [7, 365],
  rating: [1, 5],
});
const L = INSIGHT_LIMITS;

// ------------------------------------------------------------------ field specs
const idf = (k, c, o = {}) => text(k, c, L.id, { nonEmpty: true, ...o });
const req = { req: true };

const EXPOSURE_SPEC = [
  idf('id', 'id', req),
  idf('orgId', 'org_id', req),
  idf('playerId', 'player_id', req),
  oneOf('kind', 'kind', EXPOSURE_KINDS, req),
  int('day', 'day_index', req),
  int('at', 'at', req),
];
const REVIEW_LATER_SPEC = [
  idf('id', 'id', req),
  idf('orgId', 'org_id', req),
  idf('playerId', 'player_id', req),
  idf('byUserId', 'by_user_id', req),
  int('dueAt', 'due_at', req),
  int('remindedAt', 'reminded_at'),
];
const SUGGESTION_SPEC = [
  idf('id', 'id', req),
  idf('orgId', 'org_id', req),
  idf('playerId', 'player_id', req),
  text('playerName', 'player_name', L.name),
  oneOf('ruleId', 'rule_id', EVIDENCE_RULE_IDS, req),
  int('ruleVersion', 'rule_version', req),
  text('explanation', 'explanation', L.explanation, { req: true, nonEmpty: true }),
  oneOf('status', 'status', SUGGESTION_STATUSES, req),
  int('requestedAt', 'requested_at'),
  int('createdAt', 'created_at', req),
  int('updatedAt', 'updated_at', req),
];
const SESSION_SPEC = [
  idf('id', 'id', req),
  idf('orgId', 'org_id', req),
  text('title', 'title', L.calibrationTitle, { req: true, nonEmpty: true }),
  idf('templateId', 'template_id', req),
  int('templateVersion', 'template_version', req),
  idf('mediaId', 'media_id'),
  oneOf('status', 'status', CALIBRATION_STATUSES, req),
  idf('createdBy', 'created_by_user_id', req),
  int('createdAt', 'created_at', req),
  int('closedAt', 'closed_at'),
];
const SUBMISSION_SPEC = [
  idf('userId', 'user_id', req),
  text('userName', 'user_name', L.name),
  oneOf('confidence', 'confidence', CALIBRATION_CONFIDENCE, req),
  int('submittedAt', 'submitted_at', req),
];
const NOTE_SPEC = [
  int('at', 'at', req),
  idf('byUserId', 'by_user_id', req),
  text('byName', 'by_name', L.name),
  text('text', 'text', L.note, { req: true, nonEmpty: true }),
];
const FIXTURE_SPEC = [
  idf('id', 'id', req),
  idf('orgId', 'org_id', req),
  text('competition', 'competition', L.competition, { nonEmpty: true }),
  text('home', 'home', L.team, { req: true, nonEmpty: true }),
  text('away', 'away', L.team, { req: true, nonEmpty: true }),
  text('date', 'fixture_date', 10, req),
  group('location', [num('lat', 'lat', req), num('lng', 'lng', req), text('city', 'city', L.city, req)], {
    nullable: true,
  }),
  text('createdBy', 'created_by_name', L.name),
  int('createdAt', 'created_at', req),
];
const PLAN_SPEC = [
  idf('id', 'id', req),
  idf('orgId', 'org_id', req),
  text('label', 'label', L.label, { req: true, nonEmpty: true }),
  text('competition', 'competition', L.competition, { nonEmpty: true }),
  text('region', 'region', L.region, { nonEmpty: true }),
  int('goalObservations', 'goal_observations', req),
  int('windowDays', 'window_days', req),
  text('createdBy', 'created_by_name', L.name),
  int('createdAt', 'created_at', req),
];
const ASSIGNMENT_SPEC = [
  idf('id', 'id', req),
  idf('orgId', 'org_id', req),
  group('fixture', [oneOf('kind', 'fixture_kind', FIXTURE_KINDS, req), idf('id', 'fixture_ref', req)]),
  text('fixtureDate', 'fixture_date', 10, req),
  text('fixtureLabel', 'fixture_label', L.fixtureLabel, { req: true, nonEmpty: true }),
  text('fixtureCompetition', 'fixture_competition', L.competition, { nonEmpty: true }),
  idf('scoutUserId', 'scout_user_id', req),
  text('scoutName', 'scout_name', L.name),
  group(
    'travelBudget',
    [
      int('amountMinor', 'travel_budget_minor', req),
      oneOf('currency', 'travel_currency', CURRENCIES, req),
      text('enteredBy', 'travel_entered_by_name', L.name),
    ],
    { nullable: true },
  ),
  text('assignedBy', 'assigned_by_name', L.name),
  int('createdAt', 'created_at', req),
  int('observedAt', 'observed_at'),
  idf('assessmentId', 'assessment_id'),
  int('cancelledAt', 'cancelled_at'),
];
// The stored assignment splits the fixture reference by kind: `fixture_id` (own), `friendly_id` or `open_trial_id`.
const REF_COLUMN = Object.freeze({ own: 'fixture_id', friendly_board: 'friendly_id', open_trial: 'open_trial_id' });
const ASSIGNMENT_COLUMNS = ASSIGNMENT_SPEC.filter((f) => f.k !== 'fixture');

// ------------------------------------------------------------------ DDL
const rowOf = (name, c, key = 'id') => `FOREIGN KEY (${c}) REFERENCES ${name}(${key}) ON DELETE RESTRICT`;
const ownedBy = (name, c, key = 'id') => `FOREIGN KEY (${c}) REFERENCES ${name}(${key}) ON DELETE CASCADE`;
const col = (c, def) => `${c.padEnd(40)} ${def}`;
const idCol = (c) => col(c, `TEXT NOT NULL CHECK (length(${c}) > 0 AND length(${c}) <= ${L.id})`);
const ordCol = (c = 'ord') => col(c, `INTEGER NOT NULL CHECK (${c} >= 0)`);
const table = (name, cols) => `CREATE TABLE ${name} (\n  ${cols.join(',\n  ')}\n) STRICT;`;
const DAY_GLOB = (c) => `CHECK (${c} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')`;
const enumIn = (vals) => vals.map((v) => `'${v}'`).join(',');

export const INSIGHT_COVERAGE_DDL = [
  tableDdl('exposure_events', EXPOSURE_SPEC, [
    rowOf('orgs', 'org_id'),
    'CHECK (day_index >= 0)',
    'UNIQUE (org_id, player_id, kind, day_index)',
  ]),
  'CREATE INDEX exposure_events_org_day ON exposure_events (org_id, day_index);',
  'CREATE INDEX exposure_events_player_day ON exposure_events (player_id, day_index);',
  'CREATE INDEX exposure_events_day ON exposure_events (day_index);',

  tableDdl('review_later', REVIEW_LATER_SPEC, [
    rowOf('orgs', 'org_id'),
    rowOf('org_users', 'by_user_id'),
    'UNIQUE (org_id, player_id)',
  ]),
  'CREATE INDEX review_later_due ON review_later (due_at) WHERE reminded_at IS NULL;',

  tableDdl('evidence_suggestions', SUGGESTION_SPEC, [
    rowOf('orgs', 'org_id'),
    'CHECK (rule_version >= 1)',
    "CHECK (status <> 'requested' OR requested_at IS NOT NULL)",
  ]),
  'CREATE INDEX evidence_suggestions_org_player ON evidence_suggestions (org_id, player_id);',
  'CREATE INDEX evidence_suggestions_org_status ON evidence_suggestions (org_id, status);',
  "CREATE UNIQUE INDEX evidence_suggestions_one_open ON evidence_suggestions (org_id, player_id, rule_id) WHERE status IN ('suggested','requested');",
  table('evidence_suggestion_records', [
    idCol('suggestion_id'),
    ordCol(),
    idCol('record_id'),
    ownedBy('evidence_suggestions', 'suggestion_id'),
    'PRIMARY KEY (suggestion_id, ord)',
  ]),

  tableDdl('calibration_sessions', SESSION_SPEC, [
    rowOf('orgs', 'org_id'),
    rowOf('org_users', 'created_by_user_id'),
    'FOREIGN KEY (template_id, template_version) REFERENCES assessment_templates(id, version) ON DELETE RESTRICT',
    "CHECK ((status = 'closed') = (closed_at IS NOT NULL))",
  ]),
  'CREATE INDEX calibration_sessions_org_created ON calibration_sessions (org_id, created_at);',
  table('calibration_participants', [
    idCol('session_id'),
    ordCol(),
    idCol('user_id'),
    ownedBy('calibration_sessions', 'session_id'),
    rowOf('org_users', 'user_id'),
    'PRIMARY KEY (session_id, ord)',
    'UNIQUE (session_id, user_id)',
  ]),
  'CREATE INDEX calibration_participants_user ON calibration_participants (user_id);',
  table('calibration_submissions', [
    idCol('session_id'),
    idCol('user_id'),
    col('user_name', `TEXT CHECK (user_name IS NULL OR length(user_name) <= ${L.name})`),
    col('confidence', `TEXT NOT NULL CHECK (confidence IN (${enumIn(CALIBRATION_CONFIDENCE)}))`),
    col('submitted_at', 'INTEGER NOT NULL'),
    'FOREIGN KEY (session_id, user_id) REFERENCES calibration_participants(session_id, user_id) ON DELETE CASCADE',
    'PRIMARY KEY (session_id, user_id)',
  ]),
  table('calibration_ratings', [
    idCol('session_id'),
    idCol('user_id'),
    ordCol(),
    col('attr_id', 'TEXT NOT NULL CHECK (length(attr_id) > 0 AND length(attr_id) <= 40)'),
    col('value', `INTEGER CHECK (value IS NULL OR (value >= ${L.rating[0]} AND value <= ${L.rating[1]}))`),
    col('not_observed', 'INTEGER NOT NULL CHECK (not_observed IN (0,1))'),
    'FOREIGN KEY (session_id, user_id) REFERENCES calibration_submissions(session_id, user_id) ON DELETE CASCADE',
    'PRIMARY KEY (session_id, user_id, ord)',
    'UNIQUE (session_id, user_id, attr_id)',
    'CHECK ((not_observed = 1) = (value IS NULL))',
  ]),
  table('calibration_notes', [
    idCol('session_id'),
    ordCol(),
    col('at', 'INTEGER NOT NULL'),
    idCol('by_user_id'),
    col('by_name', `TEXT CHECK (by_name IS NULL OR length(by_name) <= ${L.name})`),
    col('text', `TEXT NOT NULL CHECK (length(text) > 0 AND length(text) <= ${L.note})`),
    ownedBy('calibration_sessions', 'session_id'),
    rowOf('org_users', 'by_user_id'),
    'PRIMARY KEY (session_id, ord)',
  ]),

  tableDdl('fixtures', FIXTURE_SPEC, [
    rowOf('orgs', 'org_id'),
    DAY_GLOB('fixture_date'),
    'CHECK ((lat IS NULL) = (lng IS NULL))',
    'CHECK ((lat IS NULL) = (city IS NULL))',
    'CHECK (lat IS NULL OR (lat >= -90 AND lat <= 90 AND lng >= -180 AND lng <= 180))',
  ]),
  'CREATE INDEX fixtures_org_date ON fixtures (org_id, fixture_date);',

  tableDdl('coverage_plans', PLAN_SPEC, [
    rowOf('orgs', 'org_id'),
    `CHECK (goal_observations >= ${L.goal[0]} AND goal_observations <= ${L.goal[1]})`,
    `CHECK (window_days >= ${L.windowDays[0]} AND window_days <= ${L.windowDays[1]})`,
  ]),
  'CREATE INDEX coverage_plans_org ON coverage_plans (org_id, created_at);',

  tableDdl(
    'coverage_assignments',
    [
      ...ASSIGNMENT_COLUMNS.slice(0, 2),
      oneOf('kind', 'fixture_kind', FIXTURE_KINDS, req),
      idf('fixtureId', 'fixture_id'),
      idf('friendlyId', 'friendly_id'),
      idf('openTrialId', 'open_trial_id'),
      ...ASSIGNMENT_COLUMNS.slice(2),
    ],
    [
      rowOf('orgs', 'org_id'),
      rowOf('fixtures', 'fixture_id'),
      rowOf('org_users', 'scout_user_id'),
      DAY_GLOB('fixture_date'),
      // Friendlies and open days are never hard-deleted by a route (deleting an open day stamps it).
      rowOf('friendlies', 'friendly_id'),
      rowOf('open_trials', 'open_trial_id'),
      "CHECK ((fixture_kind = 'own') = (fixture_id IS NOT NULL))",
      "CHECK ((fixture_kind = 'friendly_board') = (friendly_id IS NOT NULL))",
      "CHECK ((fixture_kind = 'open_trial') = (open_trial_id IS NOT NULL))",
      'CHECK ((travel_budget_minor IS NULL) = (travel_currency IS NULL))',
      'CHECK (travel_budget_minor IS NULL OR travel_budget_minor >= 0)',
      'CHECK (travel_budget_minor IS NOT NULL OR travel_entered_by_name IS NULL)',
      'CHECK (assessment_id IS NULL OR observed_at IS NOT NULL)',
    ],
  ),
  'CREATE INDEX coverage_assignments_org_created ON coverage_assignments (org_id, created_at, id);',
  'CREATE INDEX coverage_assignments_org_fixture ON coverage_assignments (org_id, fixture_kind, fixture_id, friendly_id, open_trial_id);',
  'CREATE INDEX coverage_assignments_friendly ON coverage_assignments (friendly_id) WHERE friendly_id IS NOT NULL;',
  'CREATE INDEX coverage_assignments_open_trial ON coverage_assignments (open_trial_id) WHERE open_trial_id IS NOT NULL;',
  'CREATE INDEX coverage_assignments_org_scout_date ON coverage_assignments (org_id, scout_user_id, fixture_date);',
  'CREATE INDEX coverage_assignments_org_observed ON coverage_assignments (org_id, observed_at);',
  'CREATE INDEX coverage_assignments_fixture ON coverage_assignments (fixture_id);',
  table('coverage_assignment_targets', [
    idCol('assignment_id'),
    ordCol(),
    idCol('player_id'),
    ownedBy('coverage_assignments', 'assignment_id'),
    'PRIMARY KEY (assignment_id, ord)',
    'UNIQUE (assignment_id, player_id)',
  ]),
  table('coverage_assignment_warnings', [
    idCol('assignment_id'),
    ordCol(),
    col('code', `TEXT NOT NULL CHECK (code IN (${enumIn(ASSIGNMENT_WARNINGS)}))`),
    col('scout_name', `TEXT CHECK (scout_name IS NULL OR length(scout_name) <= ${L.name})`),
    ownedBy('coverage_assignments', 'assignment_id'),
    'PRIMARY KEY (assignment_id, ord)',
    'UNIQUE (assignment_id, code)',
  ]),
].join('\n');
export const INSIGHT_COVERAGE_TABLES = Object.freeze([
  'exposure_events',
  'review_later',
  'evidence_suggestions',
  'evidence_suggestion_records',
  'calibration_sessions',
  'calibration_participants',
  'calibration_submissions',
  'calibration_ratings',
  'calibration_notes',
  'fixtures',
  'coverage_plans',
  'coverage_assignments',
  'coverage_assignment_targets',
  'coverage_assignment_warnings',
]);

// ------------------------------------------------------------------ typing
export const refusal = (code, message, extra = {}) =>
  Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
const labelOf = (at, raw) => `${at} ${isPlainObject(raw) && typeof raw.id === 'string' ? raw.id : ''}`.trim();
const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && parseStrictDateOnly(v).ok;
const typeIdList = (list, label, field, max) => {
  if (list === undefined) return { ok: true, value: [] };
  if (!Array.isArray(list)) return bad(label, field, `must be a list (got ${describe(list)})`);
  if (list.length > max) return bad(label, field, `holds more than ${max} entries`);
  const i = list.findIndex((x) => typeof x !== 'string' || !x.length || x.length > L.id);
  if (i >= 0) return bad(label, `${field}[${i}]`, `must be an id (got ${describe(list[i])})`);
  return { ok: true, value: [...list] };
};
const withOnly = (raw, at, keys) => {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  const unknown = Object.keys(raw).filter((k) => !keys.includes(k));
  return unknown.length
    ? { ok: false, reason: `${at} carries field(s) this build does not store: ${unknown.join(', ')}` }
    : { ok: true };
};

export const typeExposure = (raw, at = 'exposureEvents') => {
  const label = labelOf(at, raw);
  const t = typeSpec(EXPOSURE_SPEC, raw, label);
  if (!t.ok) return t;
  if (t.record.day < 0) return bad(label, 'day', 'must not be negative');
  return t;
};
export const typeReviewLater = (raw, at = 'reviewLater') => typeSpec(REVIEW_LATER_SPEC, raw, labelOf(at, raw));
export function typeSuggestion(raw, at = 'evidenceSuggestions') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { records, ...rest } = raw;
  const t = typeSpec(SUGGESTION_SPEC, rest, label);
  if (!t.ok) return t;
  if (t.record.ruleVersion < 1) return bad(label, 'ruleVersion', 'must be at least 1');
  if (t.record.status === 'requested' && t.record.requestedAt === null)
    return bad(label, 'requestedAt', 'is set once the gap is requested');
  const r = typeIdList(records, label, 'records', L.records);
  if (!r.ok) return r;
  return { ok: true, record: { ...t.record, records: r.value } };
}
function typeRating(raw, at) {
  const shape = withOnly(raw, at, ['attrId', 'value', 'notObserved']);
  if (!shape.ok) return shape;
  if (typeof raw.attrId !== 'string' || !raw.attrId.length || raw.attrId.length > 40)
    return bad(at, 'attrId', `must be an attribute id (got ${describe(raw.attrId)})`);
  if (raw.notObserved === true) {
    if (raw.value !== undefined && raw.value !== null)
      return bad(at, 'value', 'is absent when the attribute was not observed');
    return { ok: true, record: { attrId: raw.attrId, notObserved: true } };
  }
  if (raw.notObserved !== undefined && raw.notObserved !== false)
    return bad(at, 'notObserved', `must be true or false (got ${describe(raw.notObserved)})`);
  if (!Number.isInteger(raw.value) || raw.value < L.rating[0] || raw.value > L.rating[1])
    return bad(
      at,
      'value',
      `must be a whole number from ${L.rating[0]} to ${L.rating[1]} (got ${describe(raw.value)})`,
    );
  return { ok: true, record: { attrId: raw.attrId, value: raw.value, notObserved: false } };
}
export function typeSubmission(raw, at) {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  const { ratings, ...rest } = raw;
  const t = typeSpec(SUBMISSION_SPEC, rest, at);
  if (!t.ok) return t;
  if (!Array.isArray(ratings) || !ratings.length || ratings.length > L.ratings)
    return bad(at, 'ratings', `must list 1 to ${L.ratings} ratings`);
  const out = [];
  for (const [i, x] of ratings.entries()) {
    const r = typeRating(x, `${at}.ratings[${i}]`);
    if (!r.ok) return r;
    if (out.some((y) => y.attrId === r.record.attrId))
      return bad(`${at}.ratings[${i}]`, 'attrId', 'rates an attribute twice');
    out.push(r.record);
  }
  return {
    ok: true,
    record: {
      userId: t.record.userId,
      userName: t.record.userName,
      ratings: out,
      confidence: t.record.confidence,
      submittedAt: t.record.submittedAt,
    },
  };
}
export const typeNote = (raw, at) => typeSpec(NOTE_SPEC, raw, at);
export function typeSession(raw, at = 'calibrationSessions') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { participants, submissions = [], notes = [], ...rest } = raw;
  const t = typeSpec(SESSION_SPEC, rest, label);
  if (!t.ok) return t;
  const r = t.record;
  if ((r.status === 'closed') !== (r.closedAt !== null))
    return bad(label, 'closedAt', 'is set exactly when the session is closed');
  const p = typeIdList(participants, label, 'participants', L.participants);
  if (!p.ok) return p;
  if (p.value.length < 2) return bad(label, 'participants', 'names at least two scouts');
  if (new Set(p.value).size !== p.value.length) return bad(label, 'participants', 'names a scout twice');
  if (!Array.isArray(submissions)) return bad(label, 'submissions', `must be a list (got ${describe(submissions)})`);
  const subs = [];
  for (const [i, x] of submissions.entries()) {
    const s = typeSubmission(x, `${label}.submissions[${i}]`);
    if (!s.ok) return s;
    if (!p.value.includes(s.record.userId)) return bad(`${label}.submissions[${i}]`, 'userId', 'is not a participant');
    if (subs.some((y) => y.userId === s.record.userId))
      return bad(`${label}.submissions[${i}]`, 'userId', 'submitted twice');
    subs.push(s.record);
  }
  if (!Array.isArray(notes) || notes.length > L.notes)
    return bad(label, 'notes', `must be a list of at most ${L.notes}`);
  const ns = [];
  for (const [i, x] of notes.entries()) {
    const n = typeNote(x, `${label}.notes[${i}]`);
    if (!n.ok) return n;
    ns.push(n.record);
  }
  return { ok: true, record: { ...r, participants: p.value, submissions: subs, notes: ns } };
}
export function typeFixture(raw, at = 'fixtures') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { source = 'own', ...rest } = raw;
  if (source !== 'own') return bad(label, 'source', `is own for a stored fixture (got ${describe(source)})`);
  const t = typeSpec(FIXTURE_SPEC, rest, label);
  if (!t.ok) return t;
  const r = t.record;
  if (!isDay(r.date)) return bad(label, 'date', `must be a calendar day written YYYY-MM-DD (got ${describe(r.date)})`);
  if (r.location && (Math.abs(r.location.lat) > 90 || Math.abs(r.location.lng) > 180))
    return bad(label, 'location', 'must be a latitude from -90 to 90 and a longitude from -180 to 180');
  return { ok: true, record: { ...r, source: 'own' } };
}
export function typePlan(raw, at = 'coveragePlans') {
  const label = labelOf(at, raw);
  const t = typeSpec(PLAN_SPEC, raw, label);
  if (!t.ok) return t;
  const r = t.record;
  if (r.goalObservations < L.goal[0] || r.goalObservations > L.goal[1])
    return bad(label, 'goalObservations', `must be from ${L.goal[0]} to ${L.goal[1]}`);
  if (r.windowDays < L.windowDays[0] || r.windowDays > L.windowDays[1])
    return bad(label, 'windowDays', `must be from ${L.windowDays[0]} to ${L.windowDays[1]}`);
  return t;
}
function typeWarning(raw, at) {
  const shape = withOnly(raw, at, ['code', 'scoutName']);
  if (!shape.ok) return shape;
  if (!ASSIGNMENT_WARNINGS.includes(raw.code))
    return bad(at, 'code', `must be one of ${ASSIGNMENT_WARNINGS.join('|')} (got ${describe(raw.code)})`);
  const n = raw.scoutName ?? null;
  if (n !== null && (typeof n !== 'string' || n.length > L.name))
    return bad(at, 'scoutName', `must be text of at most ${L.name} characters or null`);
  return { ok: true, record: { code: raw.code, scoutName: n } };
}
export function typeAssignment(raw, at = 'coverageAssignments') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { targetPlayerIds, warnings = [], ...rest } = raw;
  const t = typeSpec(ASSIGNMENT_SPEC, rest, label);
  if (!t.ok) return t;
  const r = t.record;
  if (!isDay(r.fixtureDate))
    return bad(label, 'fixtureDate', `must be a calendar day written YYYY-MM-DD (got ${describe(r.fixtureDate)})`);
  if (r.travelBudget && r.travelBudget.amountMinor < 0)
    return bad(label, 'travelBudget', 'is a non-negative amount in minor units');
  if (r.assessmentId !== null && r.observedAt === null)
    return bad(label, 'assessmentId', 'is recorded with the observation');
  const tg = typeIdList(targetPlayerIds, label, 'targetPlayerIds', L.targets);
  if (!tg.ok) return tg;
  if (new Set(tg.value).size !== tg.value.length) return bad(label, 'targetPlayerIds', 'names a player twice');
  if (!Array.isArray(warnings) || warnings.length > ASSIGNMENT_WARNINGS.length)
    return bad(label, 'warnings', 'must be a list of at most one warning of each kind');
  const ws = [];
  for (const [i, x] of warnings.entries()) {
    const w = typeWarning(x, `${label}.warnings[${i}]`);
    if (!w.ok) return w;
    if (ws.some((y) => y.code === w.record.code)) return bad(`${label}.warnings[${i}]`, 'code', 'is raised once');
    ws.push(w.record);
  }
  return { ok: true, record: { ...r, targetPlayerIds: tg.value, warnings: ws } };
}

// ------------------------------------------------------------------ rows
const assignmentRow = (a) => ({
  ...encode(ASSIGNMENT_COLUMNS, a),
  fixture_kind: a.fixture.kind,
  ...Object.fromEntries(
    Object.entries(REF_COLUMN).map(([kind, c]) => [c, a.fixture.kind === kind ? a.fixture.id : null]),
  ),
});
const ASSIGNMENT_ROW_COLUMNS = Object.keys(assignmentRow({ fixture: { kind: 'own', id: 'x' } }));
function statements(sqlite) {
  const p = (sql) => sqlite.prepare(sql);
  return {
    exposure: p(
      `${insertSql('exposure_events', EXPOSURE_SPEC)} ON CONFLICT (org_id, player_id, kind, day_index) DO NOTHING`,
    ),
    reviewLaterOf: p('DELETE FROM review_later WHERE org_id = ? AND player_id = ?'),
    reviewLater: p(insertSql('review_later', REVIEW_LATER_SPEC)),
    suggestion: p(upsertSql('evidence_suggestions', SUGGESTION_SPEC)),
    recordsOf: p('DELETE FROM evidence_suggestion_records WHERE suggestion_id = ?'),
    record: p('INSERT INTO evidence_suggestion_records (suggestion_id, ord, record_id) VALUES (?, ?, ?)'),
    session: p(upsertSql('calibration_sessions', SESSION_SPEC)),
    participant: p('INSERT INTO calibration_participants (session_id, ord, user_id) VALUES (?, ?, ?)'),
    submission: p(
      'INSERT INTO calibration_submissions (session_id, user_id, user_name, confidence, submitted_at) VALUES (?, ?, ?, ?, ?)',
    ),
    rating: p(
      'INSERT INTO calibration_ratings (session_id, user_id, ord, attr_id, value, not_observed) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    note: p('INSERT INTO calibration_notes (session_id, ord, at, by_user_id, by_name, text) VALUES (?, ?, ?, ?, ?, ?)'),
    fixture: p(insertSql('fixtures', FIXTURE_SPEC)),
    plan: p(insertSql('coverage_plans', PLAN_SPEC)),
    assignment: p(
      `INSERT INTO coverage_assignments (${ASSIGNMENT_ROW_COLUMNS.join(', ')}) VALUES (${ASSIGNMENT_ROW_COLUMNS.map((c) => `@${c}`).join(', ')}) ON CONFLICT(id) DO UPDATE SET ${ASSIGNMENT_ROW_COLUMNS.filter(
        (c) => c !== 'id',
      )
        .map((c) => `${c} = excluded.${c}`)
        .join(', ')}`,
    ),
    target: p('INSERT INTO coverage_assignment_targets (assignment_id, ord, player_id) VALUES (?, ?, ?)'),
    warning: p('INSERT INTO coverage_assignment_warnings (assignment_id, ord, code, scout_name) VALUES (?, ?, ?, ?)'),
  };
}
function writeSuggestion(st, s) {
  st.suggestion.run(encode(SUGGESTION_SPEC, s));
  st.recordsOf.run(s.id);
  s.records.forEach((id, i) => st.record.run(s.id, i, id));
}
function writeSubmission(st, sessionId, s) {
  st.submission.run(sessionId, s.userId, s.userName, s.confidence, s.submittedAt);
  s.ratings.forEach((r, i) =>
    st.rating.run(sessionId, s.userId, i, r.attrId, r.notObserved ? null : r.value, r.notObserved ? 1 : 0),
  );
}
function writeSession(st, s) {
  st.session.run(encode(SESSION_SPEC, s));
  s.participants.forEach((u, i) => st.participant.run(s.id, i, u));
  for (const sub of s.submissions) writeSubmission(st, s.id, sub);
  s.notes.forEach((n, i) => st.note.run(s.id, i, n.at, n.byUserId, n.byName, n.text));
}
function writeAssignment(st, a, { children = true } = {}) {
  st.assignment.run(assignmentRow(a));
  if (!children) return;
  a.targetPlayerIds.forEach((pid, i) => st.target.run(a.id, i, pid));
  a.warnings.forEach((w, i) => st.warning.run(a.id, i, w.code, w.scoutName));
}

function decodeSuggestions(sqlite, rows) {
  const recs = childRowsOf(
    sqlite,
    'evidence_suggestion_records',
    'suggestion_id',
    rows.map((r) => r.id),
    { order: 'ord' },
  );
  return rows.map((row) => ({ ...decode(SUGGESTION_SPEC, row), records: recs.all(row.id).map((x) => x.record_id) }));
}
function decodeSessions(sqlite, rows) {
  const sids = rows.map((r) => r.id);
  const parts = childRowsOf(sqlite, 'calibration_participants', 'session_id', sids, { order: 'ord' });
  const subs = childRowsOf(sqlite, 'calibration_submissions', 'session_id', sids, { order: 'submitted_at, rowid' });
  const ratings = childRowsOf(sqlite, 'calibration_ratings', 'session_id', sids, { order: 'ord', subKey: ['user_id'] });
  const notes = childRowsOf(sqlite, 'calibration_notes', 'session_id', sids, { order: 'ord' });
  return rows.map((row) => ({
    ...decode(SESSION_SPEC, row),
    participants: parts.all(row.id).map((x) => x.user_id),
    submissions: subs.all(row.id).map((s) => ({
      userId: s.user_id,
      userName: s.user_name,
      ratings: ratings
        .all(row.id, s.user_id)
        .map((r) =>
          r.not_observed
            ? { attrId: r.attr_id, notObserved: true }
            : { attrId: r.attr_id, value: r.value, notObserved: false },
        ),
      confidence: s.confidence,
      submittedAt: s.submitted_at,
    })),
    notes: notes.all(row.id).map((n) => decode(NOTE_SPEC, n)),
  }));
}
const decodeFixture = (row) => ({ ...decode(FIXTURE_SPEC, row), source: 'own' });
function decodeAssignments(sqlite, rows) {
  const aids = rows.map((r) => r.id);
  const targets = childRowsOf(sqlite, 'coverage_assignment_targets', 'assignment_id', aids, { order: 'ord' });
  const warnings = childRowsOf(sqlite, 'coverage_assignment_warnings', 'assignment_id', aids, { order: 'ord' });
  return rows.map((row) => {
    const a = decode(ASSIGNMENT_COLUMNS, row);
    return {
      id: a.id,
      orgId: a.orgId,
      fixture: { kind: row.fixture_kind, id: row[REF_COLUMN[row.fixture_kind]] },
      ...Object.fromEntries(Object.entries(a).filter(([k]) => !['id', 'orgId'].includes(k))),
      targetPlayerIds: targets.all(row.id).map((x) => x.player_id),
      warnings: warnings.all(row.id).map((w) => ({ code: w.code, scoutName: w.scout_name })),
    };
  });
}

// ------------------------------------------------------------------ whole-domain read (the test suites)
export const insightCoverageLive = (sqlite) => migrationApplied(sqlite, INSIGHT_COVERAGE_MIGRATION);
function readAll(sqlite) {
  const all = (t) => sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
  return {
    exposureEvents: all('exposure_events').map((r) => decode(EXPOSURE_SPEC, r)),
    reviewLater: all('review_later').map((r) => decode(REVIEW_LATER_SPEC, r)),
    evidenceSuggestions: decodeSuggestions(sqlite, all('evidence_suggestions')),
    calibrationSessions: decodeSessions(sqlite, all('calibration_sessions')),
    fixtures: all('fixtures').map(decodeFixture),
    coveragePlans: all('coverage_plans').map((r) => decode(PLAN_SPEC, r)),
    coverageAssignments: decodeAssignments(sqlite, all('coverage_assignments')),
  };
}
/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const INSIGHT_COVERAGE_RECORDS = {
  names: INSIGHT_COVERAGE_COLLECTIONS,
  read(sqlite) {
    return insightCoverageLive(sqlite) ? readAll(sqlite) : null;
  },
};
const PLAYER_REFS_SQL =
  'SELECT player_id AS pid FROM exposure_events UNION ALL SELECT player_id FROM review_later UNION ALL SELECT player_id FROM evidence_suggestions UNION ALL SELECT player_id FROM coverage_assignment_targets';
export const unresolvedPlayerReferences = (sqlite) =>
  insightCoverageLive(sqlite)
    ? sqlite
        .prepare(
          `SELECT count(*) AS n FROM (${PLAYER_REFS_SQL}) x WHERE NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid)`,
        )
        .get().n
    : null;

// ------------------------------------------------------------------ the repository
const WRITES = new Set([
  'record',
  'prune',
  'defer',
  'markReminded',
  'reconcile',
  'setStatus',
  'create',
  'submit',
  'close',
  'addNote',
  'complete',
  'cancel',
]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Which status a suggestion may move to from which. */
const SUGGESTION_MOVES = Object.freeze({
  requested: ['suggested'],
  supplied: ['suggested', 'requested'],
  dismissed: SUGGESTION_STATUSES,
  reviewed: ['supplied'],
});

/**
 * `createInsightCoverageRepository({ sqlite, unit, now, log })`: `exposure`, `reviewLater`, `suggestions`,
 * `calibration`, `fixtures`, `plans` and `assignments`, each with its writes and queries, plus `reads` (the queries
 * alone: `insightReads`).
 */
export function createInsightCoverageRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the insight and coverage repository needs a SQLite connection (node:sqlite)');
  const operation = (fn) => (unit?.active?.() ? unit.join(fn) : sqlite.isTransaction ? fn() : transaction(sqlite, fn));
  const cache = new Map();
  const q = (sql) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = sqlite.prepare(sql)));
    return s;
  };
  const st = statements(sqlite);
  const typedOr = (type, raw, name) => {
    const t = type(raw, name);
    if (!t.ok) throw refusal('INSIGHT_INPUT_INVALID', t.reason);
    return t.record;
  };
  const str = (v) => typeof v === 'string';
  const needOrg = (table, rec) => {
    if (!q('SELECT 1 FROM orgs WHERE id = ?').get(rec.orgId))
      throw refusal('INSIGHT_REFERENCE_MISSING', `${table} ${rec.id}: orgId names no organisation (${rec.orgId})`);
  };
  const needStaff = (table, rec, userId, field) => {
    const u = q('SELECT org_id FROM org_users WHERE id = ?').get(userId);
    if (!u)
      throw refusal('INSIGHT_REFERENCE_MISSING', `${table} ${rec.id}: ${field} names no staff member (${userId})`);
    if (u.org_id !== rec.orgId)
      throw refusal('INSIGHT_INPUT_INVALID', `${table} ${rec.id}: ${field} is another organisation's staff member`);
  };
  const frozen = (x) => (x ? deepFreeze(x) : null);

  // ---- exposure events
  const exposure = {
    /** Record one event; false when the (organisation, player, kind, day) already has one. */
    record: (raw) =>
      operation(() => {
        const e = typedOr(typeExposure, raw, 'exposureEvents');
        return st.exposure.run(encode(EXPOSURE_SPEC, e)).changes === 1;
      }),
    has: (orgId, playerId, kind, day) =>
      !!q('SELECT 1 FROM exposure_events WHERE org_id = ? AND player_id = ? AND kind = ? AND day_index = ?').get(
        orgId,
        playerId,
        kind,
        day,
      ),
    /** Delete the events before day `beforeDay` (every reader looks at a recent window only). Returns how many went. */
    prune: (beforeDay) => operation(() => q('DELETE FROM exposure_events WHERE day_index < ?').run(beforeDay).changes),
    /** Distinct players per kind for the organisation since `sinceDay`: `{ impression, profile_view, evidence_view }`. */
    distinctPlayersByKind: (orgId, sinceDay) => {
      const out = Object.fromEntries(EXPOSURE_KINDS.map((k) => [k, 0]));
      for (const r of q(
        'SELECT kind, COUNT(DISTINCT player_id) AS n FROM exposure_events WHERE org_id = ? AND day_index >= ? GROUP BY kind',
      ).all(orgId, sinceDay))
        out[r.kind] = r.n;
      return out;
    },
    /** The players the organisation saw since `sinceDay`, each with the first day: `[{ playerId, firstDay }]`, oldest first. */
    firstSeen: (orgId, sinceDay) =>
      q(
        'SELECT player_id, MIN(day_index) AS first_day FROM exposure_events WHERE org_id = ? AND day_index >= ? GROUP BY player_id ORDER BY first_day, player_id',
      )
        .all(orgId, sinceDay)
        .map((r) => ({ playerId: r.player_id, firstDay: r.first_day })),
    /** One player's figures since `sinceDay`: events per kind and how many organisations (never which). */
    forPlayer: (playerId, sinceDay) => {
      const byKind = Object.fromEntries(EXPOSURE_KINDS.map((k) => [k, 0]));
      for (const r of q(
        'SELECT kind, COUNT(*) AS n FROM exposure_events WHERE player_id = ? AND day_index >= ? GROUP BY kind',
      ).all(playerId, sinceDay))
        byKind[r.kind] = r.n;
      return {
        byKind,
        orgCount: q(
          'SELECT COUNT(DISTINCT org_id) AS n FROM exposure_events WHERE player_id = ? AND day_index >= ?',
        ).get(playerId, sinceDay).n,
      };
    },
  };

  // ---- review later
  const reviewLaterById = (id) =>
    str(id)
      ? frozen(((r) => (r ? decode(REVIEW_LATER_SPEC, r) : null))(q('SELECT * FROM review_later WHERE id = ?').get(id)))
      : null;
  const reviewLater = {
    /** Defer a player for the organisation; an earlier deferral of the same player is replaced. */
    defer: (raw) =>
      operation(() => {
        const r = typedOr(typeReviewLater, raw, 'reviewLater');
        if (r.remindedAt !== null)
          throw refusal('INSIGHT_INPUT_INVALID', `review_later ${r.id}: a new deferral has not been reminded`);
        needOrg('review_later', r);
        needStaff('review_later', r, r.byUserId, 'byUserId');
        st.reviewLaterOf.run(r.orgId, r.playerId);
        st.reviewLater.run(encode(REVIEW_LATER_SPEC, r));
        return reviewLaterById(r.id);
      }),
    /** Record that the reminder went out (once). */
    markReminded: (id, at) =>
      operation(() => {
        const n = q('UPDATE review_later SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL').run(at, id).changes;
        if (!n) throw refusal('INSIGHT_NOT_FOUND', `review_later ${id} is not a deferral awaiting its reminder`);
        return reviewLaterById(id);
      }),
    byId: reviewLaterById,
    /** The organisation's deferrals still running at `at`: Map playerId → dueAt. */
    activeFor: (orgId, at) =>
      new Map(
        q('SELECT player_id, due_at FROM review_later WHERE org_id = ? AND due_at > ?')
          .all(orgId, at)
          .map((r) => [r.player_id, r.due_at]),
      ),
    isDeferred: (orgId, playerId, at) =>
      !!q('SELECT 1 FROM review_later WHERE org_id = ? AND player_id = ? AND due_at > ?').get(orgId, playerId, at),
    /** The deferrals due before `at` whose reminder has not gone out, oldest due first. */
    dueForReminder: (at, limit = 500) =>
      q('SELECT * FROM review_later WHERE reminded_at IS NULL AND due_at < ? ORDER BY due_at, id LIMIT ?')
        .all(at, limit)
        .map((r) => deepFreeze(decode(REVIEW_LATER_SPEC, r))),
  };

  // ---- evidence suggestions
  const decS = (rows) => decodeSuggestions(sqlite, rows).map(deepFreeze);
  const suggestionById = (id) =>
    str(id) ? (decS(q('SELECT * FROM evidence_suggestions WHERE id = ?').all(id))[0] ?? null) : null;
  const suggestionsForOrgPlayer = (orgId, playerId) =>
    decS(
      q('SELECT * FROM evidence_suggestions WHERE org_id = ? AND player_id = ? ORDER BY rowid').all(orgId, playerId),
    );
  const suggestions = {
    /**
     * Bring the stored suggestions for one player in line with what the rules found now (`found`: `[{ ruleId,
     * ruleVersion, records, explanation }]`): an open suggestion whose rule no longer fires becomes `supplied`, an open
     * one whose rule still fires takes the new records and explanation (written only when they changed), a new hit
     * becomes `suggested` with an id from `mintId`. Returns every suggestion of the player.
     */
    reconcile: ({ orgId, playerId, playerName = null, found, at, mintId }) =>
      operation(() => {
        const open = suggestionsForOrgPlayer(orgId, playerId).filter((s) =>
          OPEN_SUGGESTION_STATUSES.includes(s.status),
        );
        const seen = new Set();
        for (const f of found) {
          if (seen.has(f.ruleId))
            throw refusal(
              'INSIGHT_INPUT_INVALID',
              `evidence_suggestions: rule ${f.ruleId} found twice for ${playerId}`,
            );
          seen.add(f.ruleId);
        }
        for (const s of open) {
          const hit = found.find((f) => f.ruleId === s.ruleId);
          if (!hit) {
            writeSuggestion(
              st,
              typedOr(
                typeSuggestion,
                { ...s, records: [...s.records], status: 'supplied', updatedAt: at },
                'evidence_suggestions',
              ),
            );
            continue;
          }
          if (same(hit.records, s.records) && hit.explanation === s.explanation) continue;
          writeSuggestion(
            st,
            typedOr(
              typeSuggestion,
              { ...s, records: [...hit.records], explanation: hit.explanation, updatedAt: at },
              'evidence_suggestions',
            ),
          );
        }
        for (const f of found) {
          if (open.some((s) => s.ruleId === f.ruleId)) continue;
          const rec = typedOr(
            typeSuggestion,
            {
              id: mintId(),
              orgId,
              playerId,
              playerName,
              ruleId: f.ruleId,
              ruleVersion: f.ruleVersion,
              records: [...f.records],
              explanation: f.explanation,
              status: 'suggested',
              requestedAt: null,
              createdAt: at,
              updatedAt: at,
            },
            'evidence_suggestions',
          );
          needOrg('evidence_suggestions', rec);
          if (suggestionById(rec.id))
            throw refusal('INSIGHT_DUPLICATE', `evidence_suggestions ${rec.id} already exists`);
          writeSuggestion(st, rec);
        }
        return suggestionsForOrgPlayer(orgId, playerId);
      }),
    /** Move a suggestion to `status` at `at` (a request also records `requestedAt`), from a status that allows it. */
    setStatus: (id, status, at) =>
      operation(() => {
        const s = suggestionById(id);
        if (!s) throw refusal('INSIGHT_NOT_FOUND', `evidence_suggestions ${id} is not a record of the repository`);
        if (!SUGGESTION_MOVES[status]?.includes(s.status))
          throw refusal('INSIGHT_INPUT_INVALID', `evidence_suggestions ${id}: ${s.status} cannot become ${status}`);
        writeSuggestion(
          st,
          typedOr(
            typeSuggestion,
            {
              ...s,
              records: [...s.records],
              status,
              updatedAt: at,
              ...(status === 'requested' ? { requestedAt: at } : {}),
            },
            'evidence_suggestions',
          ),
        );
        return suggestionById(id);
      }),
    byId: suggestionById,
    /** This organisation's suggestion, or null (another organisation's id is no suggestion). */
    forOrgById: (orgId, id) => {
      const s = suggestionById(id);
      return s && s.orgId === orgId ? s : null;
    },
    forOrgPlayer: suggestionsForOrgPlayer,
    /** Another suggestion of the same (organisation, player, rule) requested at or after `since`, or null (anti-pestering). */
    recentRequest: (orgId, playerId, ruleId, since, exceptId) =>
      decS(
        q(
          'SELECT * FROM evidence_suggestions WHERE org_id = ? AND player_id = ? AND rule_id = ? AND requested_at > ? AND id <> ? ORDER BY requested_at DESC LIMIT 1',
        ).all(orgId, playerId, ruleId, since, exceptId),
      )[0] ?? null,
    /** The players with a suggestion in `status` for the organisation. */
    playerIdsWithStatus: (orgId, status) =>
      new Set(
        q('SELECT DISTINCT player_id FROM evidence_suggestions WHERE org_id = ? AND status = ?')
          .all(orgId, status)
          .map((r) => r.player_id),
      ),
  };

  // ---- calibration
  const decC = (rows) => decodeSessions(sqlite, rows).map(deepFreeze);
  const sessionById = (id) =>
    str(id) ? (decC(q('SELECT * FROM calibration_sessions WHERE id = ?').all(id))[0] ?? null) : null;
  const attrIdsOf = (s) =>
    new Set(
      q('SELECT attr_id FROM assessment_template_attributes WHERE template_id = ? AND template_version = ?')
        .all(s.templateId, s.templateVersion)
        .map((r) => r.attr_id),
    );
  const needAttributes = (s, sub) => {
    const known = attrIdsOf(s);
    const unknown = sub.ratings.filter((r) => !known.has(r.attrId)).map((r) => r.attrId);
    if (unknown.length)
      throw refusal(
        'INSIGHT_INPUT_INVALID',
        `calibration_sessions ${s.id}: the rubric has no attribute ${unknown.join(', ')}`,
      );
  };
  const openSession = (id) => {
    const s = sessionById(id);
    if (!s) throw refusal('INSIGHT_NOT_FOUND', `calibration_sessions ${id} is not a record of the repository`);
    return s;
  };
  const calibration = {
    create: (raw) =>
      operation(() => {
        const s = typedOr(typeSession, raw, 'calibrationSessions');
        if (s.status !== 'open' || s.submissions.length || s.notes.length)
          throw refusal(
            'INSIGHT_INPUT_INVALID',
            `calibration_sessions ${s.id}: a new session is open, with no submissions or notes`,
          );
        if (sessionById(s.id)) throw refusal('INSIGHT_DUPLICATE', `calibration_sessions ${s.id} already exists`);
        needOrg('calibration_sessions', s);
        needStaff('calibration_sessions', s, s.createdBy, 'createdBy');
        for (const u of s.participants) needStaff('calibration_sessions', s, u, 'participants');
        if (!q('SELECT 1 FROM assessment_templates WHERE id = ? AND version = ?').get(s.templateId, s.templateVersion))
          throw refusal(
            'INSIGHT_REFERENCE_MISSING',
            `calibration_sessions ${s.id}: no template ${s.templateId} v${s.templateVersion}`,
          );
        writeSession(st, s);
        return sessionById(s.id);
      }),
    /** A participant's one blind submission, while the session is open. */
    submit: (id, raw) =>
      operation(() => {
        const s = openSession(id);
        if (s.status !== 'open') throw refusal('INSIGHT_INPUT_INVALID', `calibration_sessions ${id} is closed`);
        const sub = typedOr(typeSubmission, raw, `calibration_sessions ${id} submission`);
        if (!s.participants.includes(sub.userId))
          throw refusal('INSIGHT_INPUT_INVALID', `calibration_sessions ${id}: ${sub.userId} is not a participant`);
        if (s.submissions.some((x) => x.userId === sub.userId))
          throw refusal('INSIGHT_DUPLICATE', `calibration_sessions ${id}: ${sub.userId} has already submitted`);
        needAttributes(s, sub);
        writeSubmission(st, id, sub);
        return sessionById(id);
      }),
    close: (id, at) =>
      operation(() => {
        const s = openSession(id);
        if (s.status === 'closed') return s;
        q("UPDATE calibration_sessions SET status = 'closed', closed_at = ? WHERE id = ?").run(at, id);
        return sessionById(id);
      }),
    addNote: (id, raw) =>
      operation(() => {
        const s = openSession(id);
        const n = typedOr(typeNote, raw, `calibration_sessions ${id} note`);
        if (s.notes.length >= L.notes)
          throw refusal('INSIGHT_INPUT_INVALID', `calibration_sessions ${id} holds ${L.notes} notes already`);
        needStaff('calibration_sessions', s, n.byUserId, 'byUserId');
        st.note.run(id, s.notes.length, n.at, n.byUserId, n.byName, n.text);
        return sessionById(id);
      }),
    byId: sessionById,
    forOrgById: (orgId, id) => {
      const s = sessionById(id);
      return s && s.orgId === orgId ? s : null;
    },
    /** The pinned rubric: the template version's attributes, `[{ id, label, anchors }]` in order. */
    attributesOf: (s) =>
      deepFreeze(
        q(
          'SELECT * FROM assessment_template_attributes WHERE template_id = ? AND template_version = ? ORDER BY position',
        )
          .all(s.templateId, s.templateVersion)
          .map((r) => ({
            id: r.attr_id,
            label: r.label,
            anchors: Object.fromEntries(
              Object.keys(r)
                .filter((k) => k.startsWith('anchor_') && r[k] !== null)
                .map((k) => [k.slice(7), r[k]]),
            ),
          })),
      ),
    /**
     * A page of the organisation's sessions a viewer may see (every one for a lead, else those they take part in),
     * newest first: summaries `{ id, title, status, participants, submitted, createdAt }`; `after` is `[createdAt, id]`.
     */
    page: (orgId, { userId = null, after = null, limit = 50 } = {}) =>
      q(`SELECT s.id, s.title, s.status, s.created_at,
        (SELECT COUNT(*) FROM calibration_participants p WHERE p.session_id = s.id) AS participants,
        (SELECT COUNT(*) FROM calibration_submissions b WHERE b.session_id = s.id) AS submitted
      FROM calibration_sessions s WHERE s.org_id = ?
        AND (? IS NULL OR EXISTS (SELECT 1 FROM calibration_participants p WHERE p.session_id = s.id AND p.user_id = ?))
        AND (? IS NULL OR s.created_at < ? OR (s.created_at = ? AND s.id < ?))
      ORDER BY s.created_at DESC, s.id DESC LIMIT ?`)
        .all(
          orgId,
          userId,
          userId,
          after?.[0] ?? null,
          after?.[0] ?? null,
          after?.[0] ?? null,
          after?.[1] ?? null,
          limit + 1,
        )
        .map((r) =>
          deepFreeze({
            id: r.id,
            title: r.title,
            status: r.status,
            participants: r.participants,
            submitted: r.submitted,
            createdAt: r.created_at,
          }),
        ),
  };

  // ---- fixtures
  const fixtureById = (id) =>
    str(id) ? frozen(((r) => (r ? decodeFixture(r) : null))(q('SELECT * FROM fixtures WHERE id = ?').get(id))) : null;
  const fixtures = {
    create: (raw) =>
      operation(() => {
        const f = typedOr(typeFixture, raw, 'fixtures');
        if (fixtureById(f.id)) throw refusal('INSIGHT_DUPLICATE', `fixtures ${f.id} already exists`);
        needOrg('fixtures', f);
        st.fixture.run(encode(FIXTURE_SPEC, f));
        return fixtureById(f.id);
      }),
    byId: fixtureById,
    forOrgById: (orgId, id) => {
      const f = fixtureById(id);
      return f && f.orgId === orgId ? f : null;
    },
    /** The organisation's own fixtures, by date then insertion. */
    forOrg: (orgId) =>
      q('SELECT * FROM fixtures WHERE org_id = ? ORDER BY fixture_date, rowid')
        .all(orgId)
        .map((r) => deepFreeze(decodeFixture(r))),
  };

  // ---- the fixtures an organisation can observe: its own, every friendly on the board and every open day that
  // is not deleted, one SQL union ordered by (date, public id). An event's location is its host club's.
  const OBSERVABLE = `SELECT 'own' AS kind, f.id AS ref, f.id AS public_id, f.fixture_date AS date, f.competition, f.home, f.away, f.lat, f.lng, f.city
      FROM fixtures f WHERE f.org_id = @org
    UNION ALL SELECT 'friendly_board', fr.id, 'fr-' || fr.id, fr.match_date, 'Friendly', o.name, 'open invitation', o.lat, o.lng, o.city
      FROM friendlies fr JOIN orgs o ON o.id = fr.org_id
    UNION ALL SELECT 'open_trial', t.id, 'tr-' || t.id, t.trial_date, 'Open trial', o.name, '—', o.lat, o.lng, o.city
      FROM open_trials t JOIN orgs o ON o.id = t.org_id WHERE t.deleted_at IS NULL`;
  const decodeObservable = (rows) => {
    const own = new Map(rows.filter((r) => r.kind === 'own').map((r) => [r.ref, fixtureById(r.ref)]));
    return rows.map((r) =>
      deepFreeze({
        ref: { kind: r.kind, id: r.ref },
        publicId: r.public_id,
        date: r.date,
        competition: r.competition,
        home: r.home,
        away: r.away,
        location: r.lat === null || r.lat === undefined ? null : { lat: r.lat, lng: r.lng, city: r.city ?? '' },
        fixture: r.kind === 'own' ? own.get(r.ref) : null,
      }),
    );
  };
  const observable = {
    /** A page of the organisation's observable fixtures by date then public id; `after` is `[date, publicId]`. */
    page: (orgId, { after = null, limit }) => {
      const rows = q(
        `SELECT * FROM (${OBSERVABLE}) WHERE (@d IS NULL OR date > @d OR (date = @d AND public_id > @p)) ORDER BY date, public_id LIMIT @n`,
      ).all({ org: orgId, d: after?.[0] ?? null, p: after?.[1] ?? null, n: limit + 1 });
      const items = decodeObservable(rows);
      return { items: items.slice(0, limit), more: items.length > limit };
    },
    /** One observable fixture by its public id (an own fixture's id, `fr-<id>` or `tr-<id>`), or null. */
    byPublicId: (orgId, publicId) =>
      str(publicId)
        ? (decodeObservable(
            q(`SELECT * FROM (${OBSERVABLE}) WHERE public_id = @p LIMIT 1`).all({ org: orgId, p: publicId }),
          )[0] ?? null)
        : null,
    /** The observable fixtures on or after `today` that have a location. */
    upcomingLocated: (orgId, today) =>
      decodeObservable(
        q(`SELECT * FROM (${OBSERVABLE}) WHERE date >= @t AND lat IS NOT NULL ORDER BY date, public_id`).all({
          org: orgId,
          t: today,
        }),
      ),
  };

  // ---- plans
  const planById = (id) =>
    str(id)
      ? frozen(((r) => (r ? decode(PLAN_SPEC, r) : null))(q('SELECT * FROM coverage_plans WHERE id = ?').get(id)))
      : null;
  const plans = {
    create: (raw) =>
      operation(() => {
        const p = typedOr(typePlan, raw, 'coveragePlans');
        if (planById(p.id)) throw refusal('INSIGHT_DUPLICATE', `coverage_plans ${p.id} already exists`);
        needOrg('coverage_plans', p);
        st.plan.run(encode(PLAN_SPEC, p));
        return planById(p.id);
      }),
    byId: planById,
    /** The organisation's plans, insertion order (a club keeps a handful). */
    forOrg: (orgId) =>
      q('SELECT * FROM coverage_plans WHERE org_id = ? ORDER BY rowid')
        .all(orgId)
        .map((r) => deepFreeze(decode(PLAN_SPEC, r))),
    countForOrg: (orgId) => q('SELECT COUNT(*) AS n FROM coverage_plans WHERE org_id = ?').get(orgId).n,
    /** Observations that count towards a plan: completed since `since`, of the plan's competition when it names one. */
    observationsFor: (plan, since) =>
      q(
        'SELECT COUNT(*) AS n FROM coverage_assignments WHERE org_id = ? AND observed_at IS NOT NULL AND observed_at >= ? AND (? IS NULL OR fixture_competition = ?)',
      ).get(plan.orgId, since, plan.competition, plan.competition).n,
  };

  // ---- assignments
  const decA = (rows) => decodeAssignments(sqlite, rows).map(deepFreeze);
  const assignmentById = (id) =>
    str(id) ? (decA(q('SELECT * FROM coverage_assignments WHERE id = ?').all(id))[0] ?? null) : null;
  const fixtureCond = 'fixture_kind = ? AND COALESCE(fixture_id, friendly_id, open_trial_id) = ?';
  const assignments = {
    create: (raw) =>
      operation(() => {
        const a = typedOr(typeAssignment, raw, 'coverageAssignments');
        if (a.observedAt !== null || a.cancelledAt !== null)
          throw refusal(
            'INSIGHT_INPUT_INVALID',
            `coverage_assignments ${a.id}: a new assignment is neither observed nor cancelled`,
          );
        if (assignmentById(a.id)) throw refusal('INSIGHT_DUPLICATE', `coverage_assignments ${a.id} already exists`);
        needOrg('coverage_assignments', a);
        needStaff('coverage_assignments', a, a.scoutUserId, 'scoutUserId');
        if (a.fixture.kind === 'own') {
          const f = fixtureById(a.fixture.id);
          if (!f)
            throw refusal('INSIGHT_REFERENCE_MISSING', `coverage_assignments ${a.id}: no fixture ${a.fixture.id}`);
          if (f.orgId !== a.orgId)
            throw refusal(
              'INSIGHT_INPUT_INVALID',
              `coverage_assignments ${a.id}: the fixture is another organisation's`,
            );
        } else {
          const sql =
            a.fixture.kind === 'friendly_board'
              ? 'SELECT 1 FROM friendlies WHERE id = ?'
              : 'SELECT 1 FROM open_trials WHERE id = ? AND deleted_at IS NULL';
          if (!q(sql).get(a.fixture.id))
            throw refusal(
              'INSIGHT_REFERENCE_MISSING',
              `coverage_assignments ${a.id}: no ${a.fixture.kind === 'friendly_board' ? 'friendly' : 'open day'} ${a.fixture.id}`,
            );
        }
        writeAssignment(st, a);
        return assignmentById(a.id);
      }),
    /** The scout observed the fixture at `at`, optionally producing the organisation's assessment `assessmentId`. Once. */
    complete: (id, { at, assessmentId = null }) =>
      operation(() => {
        const a = assignmentById(id);
        if (!a) throw refusal('INSIGHT_NOT_FOUND', `coverage_assignments ${id} is not a record of the repository`);
        if (a.observedAt !== null)
          throw refusal('INSIGHT_DUPLICATE', `coverage_assignments ${id} is already completed`);
        writeAssignment(
          st,
          typedOr(
            typeAssignment,
            {
              ...a,
              fixture: { ...a.fixture },
              travelBudget: a.travelBudget && { ...a.travelBudget },
              targetPlayerIds: [...a.targetPlayerIds],
              warnings: a.warnings.map((w) => ({ ...w })),
              observedAt: at,
              assessmentId,
            },
            'coverage_assignments',
          ),
          { children: false },
        );
        return assignmentById(id);
      }),
    cancel: (id, at) =>
      operation(() => {
        const a = assignmentById(id);
        if (!a) throw refusal('INSIGHT_NOT_FOUND', `coverage_assignments ${id} is not a record of the repository`);
        if (a.cancelledAt === null) q('UPDATE coverage_assignments SET cancelled_at = ? WHERE id = ?').run(at, id);
        return assignmentById(id);
      }),
    byId: assignmentById,
    forOrgById: (orgId, id) => {
      const a = assignmentById(id);
      return a && a.orgId === orgId ? a : null;
    },
    /** An assignment of the organisation to this fixture that is not cancelled, or null (the duplicate-visit warning). */
    liveForFixture: (orgId, fixture) =>
      decA(
        q(
          `SELECT * FROM coverage_assignments WHERE org_id = ? AND ${fixtureCond} AND cancelled_at IS NULL ORDER BY rowid LIMIT 1`,
        ).all(orgId, fixture.kind, fixture.id),
      )[0] ?? null,
    /** Whether the scout has an assignment that is not cancelled on `date` (the clash warning). */
    scoutBusyOn: (orgId, scoutUserId, date) =>
      !!q(
        'SELECT 1 FROM coverage_assignments WHERE org_id = ? AND scout_user_id = ? AND fixture_date = ? AND cancelled_at IS NULL',
      ).get(orgId, scoutUserId, date),
    /** The fixtures the organisation has a live assignment to, as `<kind>:<id>` keys. */
    coveredKeys: (orgId) =>
      new Set(
        q(
          'SELECT DISTINCT fixture_kind, COALESCE(fixture_id, friendly_id, open_trial_id) AS ref FROM coverage_assignments WHERE org_id = ? AND cancelled_at IS NULL',
        )
          .all(orgId)
          .map((r) => `${r.fixture_kind}:${r.ref}`),
      ),
    /** A page of the organisation's live assignments (one scout's when `scoutUserId` is given), newest first; `after` is `[createdAt, id]`. */
    page: (orgId, { scoutUserId = null, after = null, limit = 50 } = {}) =>
      decA(
        q(`SELECT * FROM coverage_assignments WHERE org_id = ? AND cancelled_at IS NULL AND (? IS NULL OR scout_user_id = ?)
        AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`).all(
          orgId,
          scoutUserId,
          scoutUserId,
          after?.[0] ?? null,
          after?.[0] ?? null,
          after?.[0] ?? null,
          after?.[1] ?? null,
          limit + 1,
        ),
      ),
  };

  const readOnly = (o) => Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => !WRITES.has(k))));
  const repo = { exposure, reviewLater, suggestions, calibration, fixtures, observable, plans, assignments };
  const counters = Object.fromEntries(
    [
      ['exposureEvents', 'exposure_events'],
      ['reviewLater', 'review_later'],
      ['evidenceSuggestions', 'evidence_suggestions'],
      ['calibrationSessions', 'calibration_sessions'],
      ['fixtures', 'fixtures'],
      ['coveragePlans', 'coverage_plans'],
      ['coverageAssignments', 'coverage_assignments'],
    ].map(([n, t]) => [n, q(`SELECT COUNT(*) AS n FROM ${t}`)]),
  );
  return {
    ...repo,
    /** The queries alone, for modules and projectors that must not write (`insightReads`). */
    reads: Object.freeze(Object.fromEntries(Object.entries(repo).map(([k, v]) => [k, readOnly(v)]))),
    attach() {
      if (!insightCoverageLive(sqlite))
        throw new Error(
          `the insight and coverage repository needs ${INSIGHT_COVERAGE_MIGRATION} recorded; it never imports an in-memory array`,
        );
      return { counts: this.counts() };
    },
    counts() {
      return Object.fromEntries(INSIGHT_COVERAGE_COLLECTIONS.map((n) => [n, counters[n].get().n]));
    },
    pending: () => 0,
    exportAll() {
      return INSIGHT_COVERAGE_RECORDS.read(sqlite);
    },
    log,
    now,
  };
}
