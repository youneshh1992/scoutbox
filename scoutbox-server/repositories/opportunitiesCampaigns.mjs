/**
 * The opportunity board, applications, assessment campaigns and players' private suitability preferences.
 *
 * Writes are typed whole; a record the columns cannot hold is refused with its id (the routes check first and answer
 * 400). Each joins the open unit of work, the caller's transaction, or a transaction of its own.
 *   opportunities.create / update(id, fn)   — fn edits a plain copy (close; the structured requirements)
 *   applications.create / update(id, fn)    — withdraw, outcome, the reminder marker, the approved suitability summary
 *   campaigns.create
 *   submissions.create / update(id, fn)     — one submission per campaign and player; its attempts are child rows
 *   preferences.save(record)                — one row per player, written only when the player or guardian saves
 *
 * Reads return deep-frozen records. Modules receive them through `scoutingReads` (opportunities, applications,
 * campaigns, campaignSubmissions, playerPrefs).
 *
 * References. Player ids have NO foreign key (tolerant, like recruitment and the rest of scouting: an application
 * outlives the account). org_id → orgs and the staff ids → org_users are RESTRICT. An application's opportunity and
 * a submission's campaign are RESTRICT keys inside the domain; owned children cascade with their owner.
 *
 * Preferences are PRIVATE to the player (the guardian for a minor). No organisation-facing read exists here: the only
 * thing that leaves them is the verdict summary the player or guardian approves onto one application.
 */
import { isPlainObject, ids, describe } from './recruitment.mjs';
import { transaction, migrationApplied } from './database.mjs';
import {
  refusal,
  isInt,
  isStr,
  nonEmpty,
  orNull,
  clone,
  bad,
  optText,
  reqText,
  optInstant,
  reqInstant,
  unknownFields,
  first,
  txt,
  typeHistory,
  typeList,
  historyTable,
  histRow,
  histOut,
} from './scoutingEvidence.mjs';
import { deepFreeze } from '../domains/platform/values.mjs';
import { PLAYER_LEVELS } from './identity.mjs';
import { ORG_LEVELS } from './orgs.mjs';
import { parseStrictDateOnly } from '../temporal.mjs';

export const OPPORTUNITIES_CAMPAIGNS_MIGRATION = '0022_opportunities_campaigns';
export const OPPORTUNITIES_CAMPAIGNS_COLLECTIONS = Object.freeze([
  'opportunities',
  'applications',
  'campaigns',
  'campaignSubmissions',
  'playerPrefs',
]);
export const OPPORTUNITIES_CAMPAIGNS_TABLES = Object.freeze([
  'opportunities',
  'opportunity_training_slots',
  'opportunity_texts',
  'applications',
  'application_suitability',
  'application_history',
  'campaigns',
  'campaign_drills',
  'campaign_rubric',
  'campaign_submissions',
  'campaign_attempts',
  'campaign_attempt_issues',
  'player_prefs',
  'player_pref_slots',
  'player_pref_texts',
]);

export const OPPORTUNITY_TYPES = Object.freeze(['trial', 'open_day', 'programme', 'role']);
export const OPPORTUNITY_CATEGORIES = Object.freeze(['mens', 'womens', 'boys', 'girls', 'mixed']);
export const ELIGIBILITY_POSITION_GROUPS = Object.freeze(['any', 'GK', 'DEF', 'MID', 'ATT']);
export const OPPORTUNITY_STATUSES = Object.freeze(['published', 'closed']);
export const APPLICATION_STATUSES = Object.freeze(['submitted', 'withdrawn', 'accepted', 'declined']);
export const ACTOR_KINDS = Object.freeze(['player', 'guardian']);
export const SUITABILITY_DIMENSIONS = Object.freeze([
  'schedule',
  'travel',
  'relocation',
  'compensation',
  'environment',
  'accessibility',
]);
export const SUITABILITY_VERDICTS = Object.freeze(['compatible', 'conflict', 'unknown']);
export const ATTEMPT_STATUSES = Object.freeze(['submitted', 'failed_checks', 'accepted', 'returned']);
/** The automated FILE checks: what each issue says to the player, by its stored code. */
export const FILE_CHECK_ISSUES = Object.freeze({
  media_missing: 'attach the recorded video before submitting',
  not_video: 'the attached file is not a video',
  not_uploaded: 'the video file itself was never uploaded',
});
const ISSUE_CODE = new Map(Object.entries(FILE_CHECK_ISSUES).map(([code, text]) => [text, code]));
export const SLOT_DAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
export const TRANSPORTS = Object.freeze(['own', 'public', 'lift_needed']);
export const RELOCATIONS = Object.freeze(['yes', 'no', 'discuss']);
/** Limits: text over these is shortened by the routes; lists over them are refused. */
export const OPPORTUNITIES_CAMPAIGNS_LIMITS = Object.freeze({
  title: 120,
  team: 60,
  ageGroup: 20,
  role: 60,
  description: 500,
  schedule: 200,
  requirement: 120,
  requirements: 6,
  trainingSlots: 10,
  tag: 40,
  tags: 8,
  accommodation: 80,
  accommodations: 8,
  note: 300,
  outcomeNote: 300,
  drills: 6,
  drillName: 80,
  instructions: 400,
  recording: 120,
  rubric: 8,
  criterion: 100,
  guidance: 200,
  reasons: 400,
  rubricNotes: 400,
  attempts: 50,
  slots: 20,
  label: 60,
  ambitions: 300,
  accessibility: 80,
  tz: 40,
  name: 200,
  minAge: 4,
  maxAge: 99,
  radiusKm: 1000,
  travelLimitKm: 500,
  attemptsAllowed: 5,
});
const L = OPPORTUNITIES_CAMPAIGNS_LIMITS;
const inList = (list) => list.map((v) => `'${v}'`).join(',');
const HHMM = "length(%c) = 5 AND %c GLOB '[0-2][0-9]:[0-5][0-9]' AND %c <= '23:59'";
const hhmm = (c) => HHMM.replaceAll('%c', c);
const slotColumns = `
  ordinal    INTEGER NOT NULL CHECK (ordinal >= 0),
  day        TEXT NOT NULL CHECK (day IN (${inList(SLOT_DAYS)})),
  start_time TEXT NOT NULL CHECK (${hhmm('start_time')}),
  end_time   TEXT NOT NULL CHECK (${hhmm('end_time')}),
  tz         TEXT NOT NULL CHECK (length(tz) BETWEEN 1 AND ${L.tz}),`;
const eligibilityColumns = (withCategory) => `
  elig_min_age        INTEGER CHECK (elig_min_age IS NULL OR elig_min_age BETWEEN ${L.minAge} AND ${L.maxAge}),
  elig_max_age        INTEGER CHECK (elig_max_age IS NULL OR elig_max_age BETWEEN ${L.minAge} AND ${L.maxAge}),
  elig_position_group TEXT NOT NULL CHECK (elig_position_group IN (${inList(ELIGIBILITY_POSITION_GROUPS)})),${
    withCategory
      ? `
  elig_category       TEXT NOT NULL CHECK (elig_category IN (${inList(OPPORTUNITY_CATEGORIES)})),`
      : ''
  }
  elig_max_level      TEXT CHECK (elig_max_level IS NULL OR elig_max_level IN (${inList(PLAYER_LEVELS)})),
  elig_radius_km      REAL CHECK (elig_radius_km IS NULL OR elig_radius_km BETWEEN 0 AND ${L.radiusKm}),`;

// ------------------------------------------------------------------ DDL
export const OPPORTUNITIES_CAMPAIGNS_DDL = `
CREATE TABLE opportunities (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  org_name            ${txt('org_name', L.name, { notNull: true })},
  org_level           TEXT NOT NULL CHECK (org_level IN (${inList(ORG_LEVELS)})),
  type                TEXT NOT NULL CHECK (type IN (${inList(OPPORTUNITY_TYPES)})),
  title               TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND ${L.title}),
  team                ${txt('team', L.team)},
  category            TEXT NOT NULL CHECK (category IN (${inList(OPPORTUNITY_CATEGORIES)})),
  age_group           ${txt('age_group', L.ageGroup)},
  role                ${txt('role', L.role)},
  description         ${txt('description', L.description)},
  schedule            ${txt('schedule', L.schedule)},
  deadline            TEXT NOT NULL CHECK (length(deadline) = 10),
  capacity            INTEGER CHECK (capacity IS NULL OR capacity >= 1),${eligibilityColumns(true)}
  status              TEXT NOT NULL CHECK (status IN (${inList(OPPORTUNITY_STATUSES)})),
  created_by_name     ${txt('created_by_name', L.name, { notNull: true })},
  created_at          INTEGER NOT NULL,
  closed_at           INTEGER,
  structured_declared INTEGER NOT NULL CHECK (structured_declared IN (0,1)),
  relocation_required INTEGER NOT NULL CHECK (relocation_required IN (0,1)),
  fee_minor           INTEGER CHECK (fee_minor IS NULL OR fee_minor >= 0),
  currency            TEXT CHECK (currency IS NULL OR (length(currency) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]')),
  expenses_covered    INTEGER NOT NULL CHECK (expenses_covered IN (0,1)),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CHECK (elig_min_age IS NULL OR elig_max_age IS NULL OR elig_min_age <= elig_max_age),
  CHECK ((structured_declared = 1) = (currency IS NOT NULL)),
  CHECK (structured_declared = 1 OR (relocation_required = 0 AND expenses_covered = 0 AND fee_minor IS NULL))
) STRICT;
CREATE INDEX opportunities_org ON opportunities (org_id);
CREATE INDEX opportunities_status_deadline ON opportunities (status, deadline);
CREATE TABLE opportunity_training_slots (
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,${slotColumns}
  PRIMARY KEY (opportunity_id, ordinal),
  CHECK (start_time < end_time)
) STRICT;
CREATE TABLE opportunity_texts (
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('requirement','environment','accommodation')),
  ordinal        INTEGER NOT NULL CHECK (ordinal >= 0),
  text           TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND ${L.requirement}),
  PRIMARY KEY (opportunity_id, kind, ordinal)
) STRICT;
CREATE TABLE applications (
  id                      TEXT PRIMARY KEY,
  opportunity_id          TEXT NOT NULL REFERENCES opportunities(id) ON DELETE RESTRICT,
  org_id                  TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  player_id               TEXT NOT NULL,
  player_name             ${txt('player_name', L.name)},
  submitted_by_kind       TEXT NOT NULL CHECK (submitted_by_kind IN (${inList(ACTOR_KINDS)})),
  submitted_by_id         TEXT NOT NULL CHECK (length(submitted_by_id) BETWEEN 1 AND 80),
  submitted_by_name       ${txt('submitted_by_name', L.name)},
  note                    ${txt('note', L.note)},
  status                  TEXT NOT NULL CHECK (status IN (${inList(APPLICATION_STATUSES)})),
  outcome_note            ${txt('outcome_note', L.outcomeNote)},
  outcome_by_user_id      TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  outcome_by_name         ${txt('outcome_by_name', L.name)},
  outcome_at              INTEGER,
  created_at              INTEGER NOT NULL,
  reminded_at             INTEGER,
  suitability_approved_at INTEGER,
  suitability_approved_by TEXT CHECK (suitability_approved_by IS NULL OR suitability_approved_by IN (${inList(ACTOR_KINDS)})),
  CHECK ((status IN ('accepted','declined')) = (outcome_at IS NOT NULL)),
  CHECK ((outcome_at IS NULL) = (outcome_by_user_id IS NULL)),
  CHECK (outcome_at IS NOT NULL OR (outcome_note IS NULL AND outcome_by_name IS NULL)),
  CHECK ((suitability_approved_at IS NULL) = (suitability_approved_by IS NULL))
) STRICT;
CREATE UNIQUE INDEX applications_one_live ON applications (opportunity_id, player_id) WHERE status <> 'withdrawn';
CREATE INDEX applications_opportunity_status ON applications (opportunity_id, status);
CREATE INDEX applications_player ON applications (player_id);
CREATE INDEX applications_reminder_due ON applications (created_at) WHERE status = 'submitted' AND reminded_at IS NULL;
CREATE TABLE application_suitability (
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  ordinal        INTEGER NOT NULL CHECK (ordinal >= 0),
  dimension      TEXT NOT NULL CHECK (dimension IN (${inList(SUITABILITY_DIMENSIONS)})),
  verdict        TEXT NOT NULL CHECK (verdict IN (${inList(SUITABILITY_VERDICTS)})),
  PRIMARY KEY (application_id, ordinal),
  UNIQUE (application_id, dimension)
) STRICT;
${historyTable('application_history', 'application_id', 'applications')}
CREATE TABLE campaigns (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  org_name            ${txt('org_name', L.name, { notNull: true })},
  title               TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND ${L.title}),
  deadline            TEXT NOT NULL CHECK (length(deadline) = 10),
  attempts_allowed    INTEGER NOT NULL CHECK (attempts_allowed BETWEEN 1 AND ${L.attemptsAllowed}),${eligibilityColumns(false)}
  status              TEXT NOT NULL CHECK (status IN ('published')),
  created_by_name     ${txt('created_by_name', L.name, { notNull: true })},
  created_at          INTEGER NOT NULL,
  CHECK (elig_min_age IS NULL OR elig_max_age IS NULL OR elig_min_age <= elig_max_age)
) STRICT;
CREATE INDEX campaigns_org ON campaigns (org_id);
CREATE INDEX campaigns_status_deadline ON campaigns (status, deadline);
CREATE TABLE campaign_drills (
  campaign_id  TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  ordinal      INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND ${L.drills - 1}),
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND ${L.drillName}),
  instructions ${txt('instructions', L.instructions, { notNull: true })},
  equipment    ${txt('equipment', L.recording, { notNull: true })},
  distance     ${txt('distance', L.recording, { notNull: true })},
  surface      ${txt('surface', L.recording, { notNull: true })},
  camera       ${txt('camera', L.recording, { notNull: true })},
  PRIMARY KEY (campaign_id, ordinal),
  UNIQUE (campaign_id, name)
) STRICT;
CREATE TABLE campaign_rubric (
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND ${L.rubric - 1}),
  criterion   TEXT NOT NULL CHECK (length(criterion) BETWEEN 1 AND ${L.criterion}),
  guidance    ${txt('guidance', L.guidance, { notNull: true })},
  PRIMARY KEY (campaign_id, ordinal)
) STRICT;
CREATE TABLE campaign_submissions (
  id                TEXT PRIMARY KEY,
  campaign_id       TEXT NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
  org_id            TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  player_id         TEXT NOT NULL,
  player_name       ${txt('player_name', L.name)},
  submitted_by_kind TEXT NOT NULL CHECK (submitted_by_kind IN (${inList(ACTOR_KINDS)})),
  submitted_by_id   TEXT NOT NULL CHECK (length(submitted_by_id) BETWEEN 1 AND 80),
  submitted_by_name ${txt('submitted_by_name', L.name)},
  created_at        INTEGER NOT NULL,
  UNIQUE (campaign_id, player_id)
) STRICT;
CREATE INDEX campaign_submissions_player ON campaign_submissions (player_id);
CREATE TABLE campaign_attempts (
  id                 TEXT PRIMARY KEY,
  submission_id      TEXT NOT NULL REFERENCES campaign_submissions(id) ON DELETE CASCADE,
  ordinal            INTEGER NOT NULL CHECK (ordinal >= 0),
  media_id           TEXT CHECK (media_id IS NULL OR length(media_id) <= 80),
  drill_name         TEXT NOT NULL CHECK (length(drill_name) BETWEEN 1 AND ${L.drillName}),
  note               ${txt('note', L.note)},
  file_checks_passed INTEGER NOT NULL CHECK (file_checks_passed IN (0,1)),
  file_checked_at    INTEGER NOT NULL,
  status             TEXT NOT NULL CHECK (status IN (${inList(ATTEMPT_STATUSES)})),
  review_by_user_id  TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  review_by_name     ${txt('review_by_name', L.name)},
  reviewed_at        INTEGER,
  review_reasons     ${txt('review_reasons', L.reasons)},
  review_rubric_notes ${txt('review_rubric_notes', L.rubricNotes)},
  submitted_at       INTEGER NOT NULL,
  UNIQUE (submission_id, ordinal),
  CHECK ((status = 'failed_checks') = (file_checks_passed = 0)),
  CHECK ((status IN ('accepted','returned')) = (reviewed_at IS NOT NULL)),
  CHECK ((reviewed_at IS NULL) = (review_by_user_id IS NULL)),
  CHECK (reviewed_at IS NOT NULL OR (review_by_name IS NULL AND review_reasons IS NULL AND review_rubric_notes IS NULL)),
  CHECK (status <> 'returned' OR review_reasons IS NOT NULL)
) STRICT;
CREATE INDEX campaign_attempts_status ON campaign_attempts (submission_id, status);
CREATE TABLE campaign_attempt_issues (
  attempt_id TEXT NOT NULL REFERENCES campaign_attempts(id) ON DELETE CASCADE,
  ordinal    INTEGER NOT NULL CHECK (ordinal >= 0),
  issue      TEXT NOT NULL CHECK (issue IN (${inList(Object.keys(FILE_CHECK_ISSUES))})),
  PRIMARY KEY (attempt_id, ordinal),
  UNIQUE (attempt_id, issue)
) STRICT;
CREATE TABLE player_prefs (
  player_id       TEXT PRIMARY KEY,
  travel_limit_km REAL CHECK (travel_limit_km IS NULL OR travel_limit_km BETWEEN 0 AND ${L.travelLimitKm}),
  transport       TEXT CHECK (transport IS NULL OR transport IN (${inList(TRANSPORTS)})),
  relocation      TEXT CHECK (relocation IS NULL OR relocation IN (${inList(RELOCATIONS)})),
  ambitions       ${txt('ambitions', L.ambitions)},
  max_fee_minor   INTEGER CHECK (max_fee_minor IS NULL OR max_fee_minor >= 0),
  currency        TEXT NOT NULL CHECK (length(currency) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'),
  expenses_needed INTEGER NOT NULL CHECK (expenses_needed IN (0,1)),
  updated_at      INTEGER NOT NULL
) STRICT;
CREATE TABLE player_pref_slots (
  player_id  TEXT NOT NULL REFERENCES player_prefs(player_id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('commitment','available')),${slotColumns}
  label      ${txt('label', L.label)},
  PRIMARY KEY (player_id, kind, ordinal),
  CHECK (start_time < end_time)
) STRICT;
CREATE TABLE player_pref_texts (
  player_id TEXT NOT NULL REFERENCES player_prefs(player_id) ON DELETE CASCADE,
  kind      TEXT NOT NULL CHECK (kind IN ('environment','accessibility')),
  ordinal   INTEGER NOT NULL CHECK (ordinal >= 0),
  text      TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND ${L.accessibility}),
  PRIMARY KEY (player_id, kind, ordinal)
) STRICT;
`;

// ------------------------------------------------------------------ typing (the one place a value is judged)
const dayOnly = (v) => isStr(v) && parseStrictDateOnly(v).ok; // one definition of a calendar day (temporal.mjs)
const reqDay = (rec, at, field) =>
  dayOnly(rec[field]) ? null : bad(at, field, `must be a YYYY-MM-DD day (got ${describe(rec[field])})`);
const isBool = (v) => v === true || v === false;
const reqBool = (rec, at, field) =>
  isBool(rec[field]) ? null : bad(at, field, `must be true or false (got ${describe(rec[field])})`);
const oneOf = (rec, at, field, list, { optional = false } = {}) => {
  const v = rec[field];
  if (optional && (v === undefined || v === null)) return null;
  return list.includes(v)
    ? null
    : bad(at, field, `must be one of ${list.join('|')}${optional ? ' or null' : ''} (got ${describe(v)})`);
};
const optIntIn = (rec, at, field, min, max) => {
  const v = rec[field];
  if (v === undefined || v === null) return null;
  return isInt(v) && v >= min && v <= max
    ? null
    : bad(at, field, `must be a whole number from ${min} to ${max} or null (got ${describe(v)})`);
};
const optNumIn = (rec, at, field, min, max) => {
  const v = rec[field];
  if (v === undefined || v === null) return null;
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
    ? null
    : bad(at, field, `must be a number from ${min} to ${max} or null (got ${describe(v)})`);
};
const CURRENCY = /^[A-Z]{3}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** An IANA time zone this runtime knows. */
export const knownTimeZone = (tz) => {
  if (!nonEmpty(tz) || tz.length > L.tz) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** A weekly slot `{ day, start, end, tz }` (and `label` where `withLabel`): a known day, HH:MM times, start before end, a known zone. */
export function typeSlot(s, at, { withLabel = false } = {}) {
  if (!isPlainObject(s)) return { ok: false, reason: `${at} is not an object (${describe(s)})` };
  const problem = first(
    unknownFields(s, at, withLabel ? ['day', 'start', 'end', 'tz', 'label'] : ['day', 'start', 'end', 'tz']),
    oneOf(s, at, 'day', SLOT_DAYS),
    withLabel ? optText(s, at, 'label', L.label) : null,
  );
  if (problem) return problem;
  for (const f of ['start', 'end'])
    if (!isStr(s[f]) || !TIME.test(s[f])) return bad(at, f, `must be a 24-hour time HH:MM (got ${describe(s[f])})`);
  if (s.start >= s.end) return bad(at, 'end', 'must be after start (a slot within one day)');
  if (!knownTimeZone(s.tz))
    return bad(at, 'tz', `must be an IANA time zone such as Europe/London (got ${describe(s.tz)})`);
  return {
    ok: true,
    record: {
      day: s.day,
      start: s.start,
      end: s.end,
      tz: s.tz,
      ...(withLabel ? { label: orNull(s.label) || null } : {}),
    },
  };
}
function typeSlots(list, at, max, opts) {
  if (!Array.isArray(list)) return bad(at, '', `must be an array (got ${describe(list)})`);
  if (list.length > max) return bad(at, '', `holds more than ${max} slots`);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const t = typeSlot(list[i], `${at}[${i}]`, opts);
    if (!t.ok) return t;
    out.push(t.record);
  }
  return { ok: true, list: out };
}
function typeTexts(list, at, max, maxLen) {
  if (!Array.isArray(list)) return bad(at, '', `must be an array (got ${describe(list)})`);
  if (list.length > max) return bad(at, '', `holds more than ${max} entries`);
  for (let i = 0; i < list.length; i++)
    if (!nonEmpty(list[i]) || list[i].length > maxLen)
      return bad(at, `[${i}]`, `must be non-empty text of at most ${maxLen} characters (got ${describe(list[i])})`);
  return { ok: true, list: [...list] };
}
const typeActor = (a, at) =>
  isPlainObject(a) &&
  ACTOR_KINDS.includes(a.kind) &&
  nonEmpty(a.id) &&
  a.id.length <= 80 &&
  (a.name === null || a.name === undefined || (isStr(a.name) && a.name.length <= L.name)) &&
  Object.keys(a).every((k) => ['kind', 'id', 'name'].includes(k))
    ? { ok: true, record: { kind: a.kind, id: a.id, name: orNull(a.name) } }
    : { ok: false, reason: `${at} must be {kind: ${ACTOR_KINDS.join('|')}, id, name}` };

const ELIG_FIELDS = (withCategory) =>
  withCategory
    ? ['minAge', 'maxAge', 'positionGroup', 'category', 'maxLevel', 'radiusKm']
    : ['minAge', 'maxAge', 'positionGroup', 'maxLevel', 'radiusKm'];
/** Eligibility `{ minAge, maxAge, positionGroup, [category], maxLevel, radiusKm }`, typed; every field present. */
export function typeEligibility(e, at, { withCategory }) {
  if (!isPlainObject(e)) return { ok: false, reason: `${at} is not an object (${describe(e)})` };
  const problem = first(
    unknownFields(e, at, ELIG_FIELDS(withCategory)),
    optIntIn(e, at, 'minAge', L.minAge, L.maxAge),
    optIntIn(e, at, 'maxAge', L.minAge, L.maxAge),
    oneOf(e, at, 'positionGroup', ELIGIBILITY_POSITION_GROUPS),
    withCategory ? oneOf(e, at, 'category', OPPORTUNITY_CATEGORIES) : null,
    oneOf(e, at, 'maxLevel', PLAYER_LEVELS, { optional: true }),
    optNumIn(e, at, 'radiusKm', 0, L.radiusKm),
  );
  if (problem) return problem;
  if (isInt(e.minAge) && isInt(e.maxAge) && e.minAge > e.maxAge)
    return bad(at, 'maxAge', 'is below minAge (nobody could be eligible)');
  return {
    ok: true,
    record: {
      minAge: orNull(e.minAge),
      maxAge: orNull(e.maxAge),
      positionGroup: e.positionGroup,
      ...(withCategory ? { category: e.category } : {}),
      maxLevel: orNull(e.maxLevel),
      radiusKm: orNull(e.radiusKm),
    },
  };
}
const STRUCTURED_FIELDS = [
  'trainingSlots',
  'relocationRequired',
  'feeMinor',
  'currency',
  'expensesCovered',
  'environment',
  'accommodations',
];
/** An opportunity's structured requirements (suitability), typed. */
export function typeStructured(s, at) {
  if (!isPlainObject(s)) return { ok: false, reason: `${at} is not an object (${describe(s)})` };
  const problem = first(
    unknownFields(s, at, STRUCTURED_FIELDS),
    reqBool(s, at, 'relocationRequired'),
    reqBool(s, at, 'expensesCovered'),
    optIntIn(s, at, 'feeMinor', 0, Number.MAX_SAFE_INTEGER),
  );
  if (problem) return problem;
  if (!isStr(s.currency) || !CURRENCY.test(s.currency))
    return bad(at, 'currency', `must be a three-letter currency code such as GBP (got ${describe(s.currency)})`);
  const slots = typeSlots(s.trainingSlots, `${at}.trainingSlots`, L.trainingSlots);
  if (!slots.ok) return slots;
  const env = typeTexts(s.environment, `${at}.environment`, L.tags, L.tag);
  if (!env.ok) return env;
  const acc = typeTexts(s.accommodations, `${at}.accommodations`, L.accommodations, L.accommodation);
  if (!acc.ok) return acc;
  return {
    ok: true,
    record: {
      trainingSlots: slots.list,
      relocationRequired: s.relocationRequired,
      feeMinor: orNull(s.feeMinor),
      currency: s.currency,
      expensesCovered: s.expensesCovered,
      environment: env.list,
      accommodations: acc.list,
    },
  };
}
const OPPORTUNITY_FIELDS = [
  'id',
  'orgId',
  'orgName',
  'orgLevel',
  'type',
  'title',
  'team',
  'category',
  'ageGroup',
  'role',
  'description',
  'schedule',
  'deadline',
  'capacity',
  'eligibility',
  'requirements',
  'status',
  'createdBy',
  'createdAt',
  'closedAt',
  'structured',
];
export function typeOpportunity(raw, at = 'opportunities') {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  if (!nonEmpty(raw.id)) return bad(at, 'id', 'must be a non-empty string');
  const label = `${at} ${raw.id}`;
  const problem = first(
    unknownFields(raw, label, OPPORTUNITY_FIELDS),
    reqText(raw, label, 'orgId', 80),
    reqText(raw, label, 'orgName', L.name),
    oneOf(raw, label, 'orgLevel', ORG_LEVELS),
    oneOf(raw, label, 'type', OPPORTUNITY_TYPES),
    reqText(raw, label, 'title', L.title),
    optText(raw, label, 'team', L.team),
    oneOf(raw, label, 'category', OPPORTUNITY_CATEGORIES),
    optText(raw, label, 'ageGroup', L.ageGroup),
    optText(raw, label, 'role', L.role),
    optText(raw, label, 'description', L.description),
    optText(raw, label, 'schedule', L.schedule),
    reqDay(raw, label, 'deadline'),
    optIntIn(raw, label, 'capacity', 1, Number.MAX_SAFE_INTEGER),
    oneOf(raw, label, 'status', OPPORTUNITY_STATUSES),
    reqText(raw, label, 'createdBy', L.name),
    reqInstant(raw, label, 'createdAt'),
    optInstant(raw, label, 'closedAt'),
  );
  if (problem) return problem;
  if ((raw.status === 'closed') !== isInt(raw.closedAt))
    return bad(
      label,
      'closedAt',
      raw.status === 'closed'
        ? 'is required on a closed opportunity'
        : 'must be null while the opportunity is published',
    );
  const elig = typeEligibility(raw.eligibility, `${label}.eligibility`, { withCategory: true });
  if (!elig.ok) return elig;
  const reqs = typeTexts(raw.requirements ?? [], `${label}.requirements`, L.requirements, L.requirement);
  if (!reqs.ok) return reqs;
  let structured = null;
  if (raw.structured !== undefined && raw.structured !== null) {
    const s = typeStructured(raw.structured, `${label}.structured`);
    if (!s.ok) return s;
    structured = s.record;
  }
  return {
    ok: true,
    record: {
      id: raw.id,
      orgId: raw.orgId,
      orgName: raw.orgName,
      orgLevel: raw.orgLevel,
      type: raw.type,
      title: raw.title,
      team: orNull(raw.team),
      category: raw.category,
      ageGroup: orNull(raw.ageGroup),
      role: orNull(raw.role),
      description: orNull(raw.description),
      schedule: orNull(raw.schedule),
      deadline: raw.deadline,
      capacity: orNull(raw.capacity),
      eligibility: elig.record,
      requirements: reqs.list,
      status: raw.status,
      createdBy: raw.createdBy,
      createdAt: raw.createdAt,
      closedAt: orNull(raw.closedAt),
      structured,
    },
  };
}
const APPLICATION_FIELDS = [
  'id',
  'opportunityId',
  'orgId',
  'playerId',
  'playerName',
  'submittedBy',
  'note',
  'status',
  'outcome',
  'createdAt',
  'remindedAt',
  'suitabilitySummary',
  'history',
];
export function typeApplication(raw, at = 'applications') {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  if (!nonEmpty(raw.id)) return bad(at, 'id', 'must be a non-empty string');
  const label = `${at} ${raw.id}`;
  const problem = first(
    unknownFields(raw, label, APPLICATION_FIELDS),
    reqText(raw, label, 'opportunityId', 80),
    reqText(raw, label, 'orgId', 80),
    reqText(raw, label, 'playerId', 80),
    optText(raw, label, 'playerName', L.name),
    optText(raw, label, 'note', L.note),
    oneOf(raw, label, 'status', APPLICATION_STATUSES),
    reqInstant(raw, label, 'createdAt'),
    optInstant(raw, label, 'remindedAt'),
  );
  if (problem) return problem;
  const by = typeActor(raw.submittedBy, `${label}.submittedBy`);
  if (!by.ok) return by;
  let outcome = null;
  if (raw.outcome !== undefined && raw.outcome !== null) {
    const o = raw.outcome;
    const oat = `${label}.outcome`;
    if (!isPlainObject(o)) return bad(label, 'outcome', `must be an object or null (got ${describe(o)})`);
    const p = first(
      unknownFields(o, oat, ['decision', 'note', 'byUserId', 'byName', 'at']),
      oneOf(o, oat, 'decision', ['accepted', 'declined']),
      optText(o, oat, 'note', L.outcomeNote),
      reqText(o, oat, 'byUserId', 80),
      optText(o, oat, 'byName', L.name),
      reqInstant(o, oat, 'at'),
    );
    if (p) return p;
    outcome = { decision: o.decision, note: orNull(o.note), byUserId: o.byUserId, byName: orNull(o.byName), at: o.at };
  }
  if (['accepted', 'declined'].includes(raw.status) !== (outcome !== null))
    return bad(
      label,
      'outcome',
      outcome ? 'belongs to an accepted or declined application only' : `is required on an ${raw.status} application`,
    );
  if (outcome && outcome.decision !== raw.status)
    return bad(label, 'outcome', `decision ${outcome.decision} disagrees with status ${raw.status}`);
  let summary = null;
  if (raw.suitabilitySummary !== undefined && raw.suitabilitySummary !== null) {
    const s = raw.suitabilitySummary;
    const sat = `${label}.suitabilitySummary`;
    if (!isPlainObject(s)) return bad(label, 'suitabilitySummary', `must be an object or null (got ${describe(s)})`);
    const p = first(
      unknownFields(s, sat, ['approvedAt', 'approvedBy', 'verdicts']),
      reqInstant(s, sat, 'approvedAt'),
      oneOf(s, sat, 'approvedBy', ACTOR_KINDS),
    );
    if (p) return p;
    if (!Array.isArray(s.verdicts) || s.verdicts.length > SUITABILITY_DIMENSIONS.length)
      return bad(sat, 'verdicts', `must be a list of at most ${SUITABILITY_DIMENSIONS.length} verdicts`);
    const seen = new Set();
    const verdicts = [];
    for (const [i, v] of s.verdicts.entries()) {
      if (
        !isPlainObject(v) ||
        !SUITABILITY_DIMENSIONS.includes(v.dimension) ||
        !SUITABILITY_VERDICTS.includes(v.verdict) ||
        Object.keys(v).some((k) => !['dimension', 'verdict'].includes(k))
      )
        return bad(
          sat,
          `verdicts[${i}]`,
          `must be {dimension: ${SUITABILITY_DIMENSIONS.join('|')}, verdict: ${SUITABILITY_VERDICTS.join('|')}}`,
        );
      if (seen.has(v.dimension)) return bad(sat, `verdicts[${i}]`, `repeats ${v.dimension}`);
      seen.add(v.dimension);
      verdicts.push({ dimension: v.dimension, verdict: v.verdict });
    }
    summary = { approvedAt: s.approvedAt, approvedBy: s.approvedBy, verdicts };
  }
  const history = typeList(raw.history, `${label}.history`, typeHistory);
  if (!history.ok) return history;
  return {
    ok: true,
    record: {
      id: raw.id,
      opportunityId: raw.opportunityId,
      orgId: raw.orgId,
      playerId: raw.playerId,
      playerName: orNull(raw.playerName),
      submittedBy: by.record,
      note: orNull(raw.note),
      status: raw.status,
      outcome,
      createdAt: raw.createdAt,
      remindedAt: orNull(raw.remindedAt),
      suitabilitySummary: summary,
      history: history.list,
    },
  };
}
const DRILL_FIELDS = ['name', 'instructions', 'recording'];
const RECORDING_FIELDS = ['equipment', 'distance', 'surface', 'camera'];
function typeDrill(d, at) {
  if (!isPlainObject(d)) return { ok: false, reason: `${at} is not an object (${describe(d)})` };
  const problem = first(
    unknownFields(d, at, DRILL_FIELDS),
    reqText(d, at, 'name', L.drillName),
    isStr(d.instructions)
      ? optText(d, at, 'instructions', L.instructions)
      : bad(at, 'instructions', `must be text (got ${describe(d.instructions)})`),
  );
  if (problem) return problem;
  if (!isPlainObject(d.recording)) return bad(at, 'recording', `must be an object (got ${describe(d.recording)})`);
  const r = d.recording;
  const rat = `${at}.recording`;
  const p = first(
    unknownFields(r, rat, RECORDING_FIELDS),
    ...RECORDING_FIELDS.map((f) =>
      isStr(r[f]) ? optText(r, rat, f, L.recording) : bad(rat, f, `must be text (got ${describe(r[f])})`),
    ),
  );
  if (p) return p;
  return {
    ok: true,
    record: {
      name: d.name,
      instructions: d.instructions,
      recording: { equipment: r.equipment, distance: r.distance, surface: r.surface, camera: r.camera },
    },
  };
}
const CAMPAIGN_FIELDS = [
  'id',
  'orgId',
  'orgName',
  'title',
  'drills',
  'deadline',
  'attemptsAllowed',
  'eligibility',
  'rubric',
  'status',
  'createdBy',
  'createdAt',
];
export function typeCampaign(raw, at = 'campaigns') {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  if (!nonEmpty(raw.id)) return bad(at, 'id', 'must be a non-empty string');
  const label = `${at} ${raw.id}`;
  const problem = first(
    unknownFields(raw, label, CAMPAIGN_FIELDS),
    reqText(raw, label, 'orgId', 80),
    reqText(raw, label, 'orgName', L.name),
    reqText(raw, label, 'title', L.title),
    reqDay(raw, label, 'deadline'),
    isInt(raw.attemptsAllowed) && raw.attemptsAllowed >= 1 && raw.attemptsAllowed <= L.attemptsAllowed
      ? null
      : bad(
          label,
          'attemptsAllowed',
          `must be a whole number from 1 to ${L.attemptsAllowed} (got ${describe(raw.attemptsAllowed)})`,
        ),
    oneOf(raw, label, 'status', ['published']),
    reqText(raw, label, 'createdBy', L.name),
    reqInstant(raw, label, 'createdAt'),
  );
  if (problem) return problem;
  if (!Array.isArray(raw.drills) || raw.drills.length < 1 || raw.drills.length > L.drills)
    return bad(label, 'drills', `must be a list of 1 to ${L.drills} drills`);
  const drills = [];
  const names = new Set();
  for (let i = 0; i < raw.drills.length; i++) {
    const t = typeDrill(raw.drills[i], `${label}.drills[${i}]`);
    if (!t.ok) return t;
    if (names.has(t.record.name)) return bad(`${label}.drills[${i}]`, 'name', `repeats ${t.record.name}`);
    names.add(t.record.name);
    drills.push(t.record);
  }
  const rubricIn = raw.rubric ?? [];
  if (!Array.isArray(rubricIn) || rubricIn.length > L.rubric)
    return bad(label, 'rubric', `must be a list of at most ${L.rubric} criteria`);
  const rubric = [];
  for (const [i, r] of rubricIn.entries()) {
    const rat = `${label}.rubric[${i}]`;
    if (!isPlainObject(r)) return { ok: false, reason: `${rat} is not an object (${describe(r)})` };
    const p = first(
      unknownFields(r, rat, ['criterion', 'guidance']),
      reqText(r, rat, 'criterion', L.criterion),
      isStr(r.guidance)
        ? optText(r, rat, 'guidance', L.guidance)
        : bad(rat, 'guidance', `must be text (got ${describe(r.guidance)})`),
    );
    if (p) return p;
    rubric.push({ criterion: r.criterion, guidance: r.guidance });
  }
  const elig = typeEligibility(raw.eligibility, `${label}.eligibility`, { withCategory: false });
  if (!elig.ok) return elig;
  return {
    ok: true,
    record: {
      id: raw.id,
      orgId: raw.orgId,
      orgName: raw.orgName,
      title: raw.title,
      drills,
      deadline: raw.deadline,
      attemptsAllowed: raw.attemptsAllowed,
      eligibility: elig.record,
      rubric,
      status: 'published',
      createdBy: raw.createdBy,
      createdAt: raw.createdAt,
    },
  };
}
const ATTEMPT_FIELDS = ['id', 'mediaId', 'drillName', 'note', 'fileChecks', 'status', 'review', 'submittedAt'];
function typeAttempt(a, at) {
  if (!isPlainObject(a)) return { ok: false, reason: `${at} is not an object (${describe(a)})` };
  const problem = first(
    unknownFields(a, at, ATTEMPT_FIELDS),
    reqText(a, at, 'id', 80),
    optText(a, at, 'mediaId', 80),
    reqText(a, at, 'drillName', L.drillName),
    optText(a, at, 'note', L.note),
    oneOf(a, at, 'status', ATTEMPT_STATUSES),
    reqInstant(a, at, 'submittedAt'),
  );
  if (problem) return problem;
  const f = a.fileChecks;
  const fat = `${at}.fileChecks`;
  if (!isPlainObject(f)) return bad(at, 'fileChecks', `must be an object (got ${describe(f)})`);
  const fp = first(
    unknownFields(f, fat, ['passed', 'issues', 'checkedAt', 'kind']),
    reqBool(f, fat, 'passed'),
    reqInstant(f, fat, 'checkedAt'),
    oneOf(f, fat, 'kind', ['automated_file_check']),
  );
  if (fp) return fp;
  if (
    !Array.isArray(f.issues) ||
    f.issues.some((x) => !ISSUE_CODE.has(x)) ||
    new Set(f.issues).size !== f.issues.length
  )
    return bad(fat, 'issues', 'must list distinct automated file-check messages');
  if (f.passed !== (f.issues.length === 0)) return bad(fat, 'passed', 'disagrees with the issues listed');
  if ((a.status === 'failed_checks') !== !f.passed)
    return bad(at, 'status', `${a.status} disagrees with the file checks`);
  let review = null;
  if (a.review !== undefined && a.review !== null) {
    const r = a.review;
    const rat = `${at}.review`;
    if (!isPlainObject(r)) return bad(at, 'review', `must be an object or null (got ${describe(r)})`);
    const p = first(
      unknownFields(r, rat, ['byUserId', 'byName', 'at', 'kind', 'reasons', 'rubricNotes']),
      reqText(r, rat, 'byUserId', 80),
      optText(r, rat, 'byName', L.name),
      reqInstant(r, rat, 'at'),
      oneOf(r, rat, 'kind', ['human_review']),
      optText(r, rat, 'reasons', L.reasons),
      optText(r, rat, 'rubricNotes', L.rubricNotes),
    );
    if (p) return p;
    review = {
      byUserId: r.byUserId,
      byName: orNull(r.byName),
      at: r.at,
      kind: 'human_review',
      reasons: orNull(r.reasons),
      rubricNotes: orNull(r.rubricNotes),
    };
  }
  if (['accepted', 'returned'].includes(a.status) !== (review !== null))
    return bad(at, 'review', review ? 'belongs to a reviewed attempt only' : `is required on a ${a.status} attempt`);
  if (a.status === 'returned' && !nonEmpty(review.reasons))
    return bad(at, 'review', 'a returned attempt carries its reasons');
  return {
    ok: true,
    record: {
      id: a.id,
      mediaId: orNull(a.mediaId),
      drillName: a.drillName,
      note: orNull(a.note),
      fileChecks: { passed: f.passed, issues: [...f.issues], checkedAt: f.checkedAt, kind: 'automated_file_check' },
      status: a.status,
      review,
      submittedAt: a.submittedAt,
    },
  };
}
const SUBMISSION_FIELDS = [
  'id',
  'campaignId',
  'orgId',
  'playerId',
  'playerName',
  'submittedBy',
  'attempts',
  'createdAt',
];
export function typeSubmission(raw, at = 'campaignSubmissions') {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  if (!nonEmpty(raw.id)) return bad(at, 'id', 'must be a non-empty string');
  const label = `${at} ${raw.id}`;
  const problem = first(
    unknownFields(raw, label, SUBMISSION_FIELDS),
    reqText(raw, label, 'campaignId', 80),
    reqText(raw, label, 'orgId', 80),
    reqText(raw, label, 'playerId', 80),
    optText(raw, label, 'playerName', L.name),
    reqInstant(raw, label, 'createdAt'),
  );
  if (problem) return problem;
  const by = typeActor(raw.submittedBy, `${label}.submittedBy`);
  if (!by.ok) return by;
  if (Array.isArray(raw.attempts) && raw.attempts.length > L.attempts)
    return bad(label, 'attempts', `holds more than ${L.attempts} attempts`);
  const attempts = typeList(raw.attempts, `${label}.attempts`, typeAttempt);
  if (!attempts.ok) return attempts;
  return {
    ok: true,
    record: {
      id: raw.id,
      campaignId: raw.campaignId,
      orgId: raw.orgId,
      playerId: raw.playerId,
      playerName: orNull(raw.playerName),
      submittedBy: by.record,
      attempts: attempts.list,
      createdAt: raw.createdAt,
    },
  };
}
const PREFS_FIELDS = [
  'playerId',
  'commitments',
  'availableSlots',
  'travelLimitKm',
  'transport',
  'relocation',
  'ambitions',
  'environment',
  'accessibility',
  'compensation',
  'updatedAt',
];
export function typePreferences(raw, at = 'playerPrefs') {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  if (!nonEmpty(raw.playerId)) return bad(at, 'playerId', 'must be a non-empty string');
  const label = `${at} ${raw.playerId}`;
  const problem = first(
    unknownFields(raw, label, PREFS_FIELDS),
    optNumIn(raw, label, 'travelLimitKm', 0, L.travelLimitKm),
    oneOf(raw, label, 'transport', TRANSPORTS, { optional: true }),
    oneOf(raw, label, 'relocation', RELOCATIONS, { optional: true }),
    optText(raw, label, 'ambitions', L.ambitions),
    reqInstant(raw, label, 'updatedAt'),
  );
  if (problem) return problem;
  const commitments = typeSlots(raw.commitments, `${label}.commitments`, L.slots, { withLabel: true });
  if (!commitments.ok) return commitments;
  const available = typeSlots(raw.availableSlots, `${label}.availableSlots`, L.slots, { withLabel: true });
  if (!available.ok) return available;
  const env = typeTexts(raw.environment, `${label}.environment`, L.tags, L.tag);
  if (!env.ok) return env;
  const acc = typeTexts(raw.accessibility, `${label}.accessibility`, L.tags, L.accessibility);
  if (!acc.ok) return acc;
  const c = raw.compensation;
  const cat = `${label}.compensation`;
  if (!isPlainObject(c)) return bad(label, 'compensation', `must be an object (got ${describe(c)})`);
  const cp = first(
    unknownFields(c, cat, ['maxFeeMinor', 'currency', 'expensesNeeded']),
    optIntIn(c, cat, 'maxFeeMinor', 0, Number.MAX_SAFE_INTEGER),
    reqBool(c, cat, 'expensesNeeded'),
  );
  if (cp) return cp;
  if (!isStr(c.currency) || !CURRENCY.test(c.currency))
    return bad(cat, 'currency', `must be a three-letter currency code such as GBP (got ${describe(c.currency)})`);
  return {
    ok: true,
    record: {
      playerId: raw.playerId,
      commitments: commitments.list,
      availableSlots: available.list,
      travelLimitKm: orNull(raw.travelLimitKm),
      transport: orNull(raw.transport),
      relocation: orNull(raw.relocation),
      ambitions: orNull(raw.ambitions),
      environment: env.list,
      accessibility: acc.list,
      compensation: { maxFeeMinor: orNull(c.maxFeeMinor), currency: c.currency, expensesNeeded: c.expensesNeeded },
      updatedAt: raw.updatedAt,
    },
  };
}
/** A player's preferences before anything is saved (nothing is stored for them). */
export const blankPreferences = (playerId) => ({
  playerId,
  commitments: [],
  availableSlots: [],
  travelLimitKm: null,
  transport: null,
  relocation: null,
  ambitions: null,
  environment: [],
  accessibility: [],
  compensation: { maxFeeMinor: null, currency: 'GBP', expensesNeeded: false },
  updatedAt: null,
});
const TYPERS = {
  opportunities: typeOpportunity,
  applications: typeApplication,
  campaigns: typeCampaign,
  campaignSubmissions: typeSubmission,
  playerPrefs: typePreferences,
};

// ------------------------------------------------------------------ rows
function statements(sqlite) {
  const p = (sql) => sqlite.prepare(sql);
  const upsert = (table, cols, key = 'id') =>
    p(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')}) ON CONFLICT(${key}) DO UPDATE SET ${cols
        .filter((c) => c !== key)
        .map((c) => `${c} = excluded.${c}`)
        .join(', ')}`,
    );
  return {
    opp: upsert('opportunities', [
      'id',
      'org_id',
      'org_name',
      'org_level',
      'type',
      'title',
      'team',
      'category',
      'age_group',
      'role',
      'description',
      'schedule',
      'deadline',
      'capacity',
      'elig_min_age',
      'elig_max_age',
      'elig_position_group',
      'elig_category',
      'elig_max_level',
      'elig_radius_km',
      'status',
      'created_by_name',
      'created_at',
      'closed_at',
      'structured_declared',
      'relocation_required',
      'fee_minor',
      'currency',
      'expenses_covered',
    ]),
    oppById: p('SELECT * FROM opportunities WHERE id = ?'),
    oppDel: p('DELETE FROM opportunities WHERE id = ?'),
    oppSlot: p(
      'INSERT INTO opportunity_training_slots (opportunity_id, ordinal, day, start_time, end_time, tz) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    oppSlotsDel: p('DELETE FROM opportunity_training_slots WHERE opportunity_id = ?'),
    oppText: p('INSERT INTO opportunity_texts (opportunity_id, kind, ordinal, text) VALUES (?, ?, ?, ?)'),
    oppTextsDel: p('DELETE FROM opportunity_texts WHERE opportunity_id = ?'),
    oppSlotsOf: p(
      'SELECT * FROM opportunity_training_slots WHERE opportunity_id IN (SELECT value FROM json_each(?)) ORDER BY opportunity_id, ordinal',
    ),
    oppTextsOf: p(
      'SELECT * FROM opportunity_texts WHERE opportunity_id IN (SELECT value FROM json_each(?)) ORDER BY opportunity_id, kind, ordinal',
    ),
    app: upsert('applications', [
      'id',
      'opportunity_id',
      'org_id',
      'player_id',
      'player_name',
      'submitted_by_kind',
      'submitted_by_id',
      'submitted_by_name',
      'note',
      'status',
      'outcome_note',
      'outcome_by_user_id',
      'outcome_by_name',
      'outcome_at',
      'created_at',
      'reminded_at',
      'suitability_approved_at',
      'suitability_approved_by',
    ]),
    appById: p('SELECT * FROM applications WHERE id = ?'),
    appDel: p('DELETE FROM applications WHERE id = ?'),
    appVerdict: p(
      'INSERT INTO application_suitability (application_id, ordinal, dimension, verdict) VALUES (?, ?, ?, ?)',
    ),
    appVerdictsDel: p('DELETE FROM application_suitability WHERE application_id = ?'),
    appHist: p(
      'INSERT INTO application_history (id, application_id, position, at, by_kind, by_id, by_name, action, detail) VALUES (@id, @owner, @position, @at, @by_kind, @by_id, @by_name, @action, @detail)',
    ),
    appHistDel: p('DELETE FROM application_history WHERE application_id = ?'),
    appVerdictsOf: p(
      'SELECT * FROM application_suitability WHERE application_id IN (SELECT value FROM json_each(?)) ORDER BY application_id, ordinal',
    ),
    appHistOf: p(
      'SELECT * FROM application_history WHERE application_id IN (SELECT value FROM json_each(?)) ORDER BY application_id, position',
    ),
    camp: upsert('campaigns', [
      'id',
      'org_id',
      'org_name',
      'title',
      'deadline',
      'attempts_allowed',
      'elig_min_age',
      'elig_max_age',
      'elig_position_group',
      'elig_max_level',
      'elig_radius_km',
      'status',
      'created_by_name',
      'created_at',
    ]),
    campById: p('SELECT * FROM campaigns WHERE id = ?'),
    campDel: p('DELETE FROM campaigns WHERE id = ?'),
    drill: p(
      'INSERT INTO campaign_drills (campaign_id, ordinal, name, instructions, equipment, distance, surface, camera) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    drillsDel: p('DELETE FROM campaign_drills WHERE campaign_id = ?'),
    rubric: p('INSERT INTO campaign_rubric (campaign_id, ordinal, criterion, guidance) VALUES (?, ?, ?, ?)'),
    rubricDel: p('DELETE FROM campaign_rubric WHERE campaign_id = ?'),
    drillsOf: p(
      'SELECT * FROM campaign_drills WHERE campaign_id IN (SELECT value FROM json_each(?)) ORDER BY campaign_id, ordinal',
    ),
    rubricOf: p(
      'SELECT * FROM campaign_rubric WHERE campaign_id IN (SELECT value FROM json_each(?)) ORDER BY campaign_id, ordinal',
    ),
    sub: upsert('campaign_submissions', [
      'id',
      'campaign_id',
      'org_id',
      'player_id',
      'player_name',
      'submitted_by_kind',
      'submitted_by_id',
      'submitted_by_name',
      'created_at',
    ]),
    subById: p('SELECT * FROM campaign_submissions WHERE id = ?'),
    subDel: p('DELETE FROM campaign_submissions WHERE id = ?'),
    attempt:
      p(`INSERT INTO campaign_attempts (id, submission_id, ordinal, media_id, drill_name, note, file_checks_passed, file_checked_at, status, review_by_user_id, review_by_name, reviewed_at, review_reasons, review_rubric_notes, submitted_at)
      VALUES (@id, @submission_id, @ordinal, @media_id, @drill_name, @note, @file_checks_passed, @file_checked_at, @status, @review_by_user_id, @review_by_name, @reviewed_at, @review_reasons, @review_rubric_notes, @submitted_at)`),
    attemptsDel: p('DELETE FROM campaign_attempts WHERE submission_id = ?'),
    issue: p('INSERT INTO campaign_attempt_issues (attempt_id, ordinal, issue) VALUES (?, ?, ?)'),
    attemptsOf: p(
      'SELECT * FROM campaign_attempts WHERE submission_id IN (SELECT value FROM json_each(?)) ORDER BY submission_id, ordinal',
    ),
    issuesOf: p(
      'SELECT i.* FROM campaign_attempt_issues i JOIN campaign_attempts a ON a.id = i.attempt_id WHERE a.submission_id IN (SELECT value FROM json_each(?)) ORDER BY i.attempt_id, i.ordinal',
    ),
    attemptOwner: p('SELECT submission_id FROM campaign_attempts WHERE id = ?'),
    prefs: upsert(
      'player_prefs',
      [
        'player_id',
        'travel_limit_km',
        'transport',
        'relocation',
        'ambitions',
        'max_fee_minor',
        'currency',
        'expenses_needed',
        'updated_at',
      ],
      'player_id',
    ),
    prefsOf: p('SELECT * FROM player_prefs WHERE player_id = ?'),
    prefsDel: p('DELETE FROM player_prefs WHERE player_id = ?'),
    prefSlot: p(
      'INSERT INTO player_pref_slots (player_id, kind, ordinal, day, start_time, end_time, tz, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    prefSlotsDel: p('DELETE FROM player_pref_slots WHERE player_id = ?'),
    prefText: p('INSERT INTO player_pref_texts (player_id, kind, ordinal, text) VALUES (?, ?, ?, ?)'),
    prefTextsDel: p('DELETE FROM player_pref_texts WHERE player_id = ?'),
    prefSlotsOf: p('SELECT * FROM player_pref_slots WHERE player_id = ? ORDER BY kind, ordinal'),
    prefTextsOf: p('SELECT * FROM player_pref_texts WHERE player_id = ? ORDER BY kind, ordinal'),
    keys: (table, key) =>
      sqlite
        .prepare(`SELECT ${key} AS k FROM ${table} ORDER BY rowid`)
        .all()
        .map((r) => r.k),
  };
}
const b = (v) => (v ? 1 : 0);
const eligRow = (e) => ({
  elig_min_age: e.minAge,
  elig_max_age: e.maxAge,
  elig_position_group: e.positionGroup,
  elig_max_level: e.maxLevel,
  elig_radius_km: e.radiusKm,
});
function writeOpportunity(st, o) {
  const s = o.structured;
  st.opp.run({
    id: o.id,
    org_id: o.orgId,
    org_name: o.orgName,
    org_level: o.orgLevel,
    type: o.type,
    title: o.title,
    team: o.team,
    category: o.category,
    age_group: o.ageGroup,
    role: o.role,
    description: o.description,
    schedule: o.schedule,
    deadline: o.deadline,
    capacity: o.capacity,
    ...eligRow(o.eligibility),
    elig_category: o.eligibility.category,
    status: o.status,
    created_by_name: o.createdBy,
    created_at: o.createdAt,
    closed_at: o.closedAt,
    structured_declared: b(s),
    relocation_required: b(s?.relocationRequired),
    fee_minor: s ? s.feeMinor : null,
    currency: s ? s.currency : null,
    expenses_covered: b(s?.expensesCovered),
  });
  st.oppSlotsDel.run(o.id);
  st.oppTextsDel.run(o.id);
  (s?.trainingSlots ?? []).forEach((x, i) => st.oppSlot.run(o.id, i, x.day, x.start, x.end, x.tz));
  o.requirements.forEach((t, i) => st.oppText.run(o.id, 'requirement', i, t));
  (s?.environment ?? []).forEach((t, i) => st.oppText.run(o.id, 'environment', i, t));
  (s?.accommodations ?? []).forEach((t, i) => st.oppText.run(o.id, 'accommodation', i, t));
}
function writeApplication(st, a) {
  st.app.run({
    id: a.id,
    opportunity_id: a.opportunityId,
    org_id: a.orgId,
    player_id: a.playerId,
    player_name: a.playerName,
    submitted_by_kind: a.submittedBy.kind,
    submitted_by_id: a.submittedBy.id,
    submitted_by_name: a.submittedBy.name,
    note: a.note,
    status: a.status,
    outcome_note: a.outcome?.note ?? null,
    outcome_by_user_id: a.outcome?.byUserId ?? null,
    outcome_by_name: a.outcome?.byName ?? null,
    outcome_at: a.outcome?.at ?? null,
    created_at: a.createdAt,
    reminded_at: a.remindedAt,
    suitability_approved_at: a.suitabilitySummary?.approvedAt ?? null,
    suitability_approved_by: a.suitabilitySummary?.approvedBy ?? null,
  });
  st.appVerdictsDel.run(a.id);
  st.appHistDel.run(a.id);
  (a.suitabilitySummary?.verdicts ?? []).forEach((v, i) => st.appVerdict.run(a.id, i, v.dimension, v.verdict));
  a.history.forEach((h, i) => st.appHist.run(histRow(a.id, h, i)));
}
function writeCampaign(st, c) {
  st.camp.run({
    id: c.id,
    org_id: c.orgId,
    org_name: c.orgName,
    title: c.title,
    deadline: c.deadline,
    attempts_allowed: c.attemptsAllowed,
    ...eligRow(c.eligibility),
    status: c.status,
    created_by_name: c.createdBy,
    created_at: c.createdAt,
  });
  st.drillsDel.run(c.id);
  st.rubricDel.run(c.id);
  c.drills.forEach((d, i) =>
    st.drill.run(
      c.id,
      i,
      d.name,
      d.instructions,
      d.recording.equipment,
      d.recording.distance,
      d.recording.surface,
      d.recording.camera,
    ),
  );
  c.rubric.forEach((r, i) => st.rubric.run(c.id, i, r.criterion, r.guidance));
}
function writeSubmission(st, s) {
  st.sub.run({
    id: s.id,
    campaign_id: s.campaignId,
    org_id: s.orgId,
    player_id: s.playerId,
    player_name: s.playerName,
    submitted_by_kind: s.submittedBy.kind,
    submitted_by_id: s.submittedBy.id,
    submitted_by_name: s.submittedBy.name,
    created_at: s.createdAt,
  });
  st.attemptsDel.run(s.id); // the issues cascade with their attempts
  s.attempts.forEach((a, i) => {
    st.attempt.run({
      id: a.id,
      submission_id: s.id,
      ordinal: i,
      media_id: a.mediaId,
      drill_name: a.drillName,
      note: a.note,
      file_checks_passed: b(a.fileChecks.passed),
      file_checked_at: a.fileChecks.checkedAt,
      status: a.status,
      review_by_user_id: a.review?.byUserId ?? null,
      review_by_name: a.review?.byName ?? null,
      reviewed_at: a.review?.at ?? null,
      review_reasons: a.review?.reasons ?? null,
      review_rubric_notes: a.review?.rubricNotes ?? null,
      submitted_at: a.submittedAt,
    });
    a.fileChecks.issues.forEach((text, j) => st.issue.run(a.id, j, ISSUE_CODE.get(text)));
  });
}
function writePreferences(st, p) {
  st.prefs.run({
    player_id: p.playerId,
    travel_limit_km: p.travelLimitKm,
    transport: p.transport,
    relocation: p.relocation,
    ambitions: p.ambitions,
    max_fee_minor: p.compensation.maxFeeMinor,
    currency: p.compensation.currency,
    expenses_needed: b(p.compensation.expensesNeeded),
    updated_at: p.updatedAt,
  });
  st.prefSlotsDel.run(p.playerId);
  st.prefTextsDel.run(p.playerId);
  for (const [kind, list] of [
    ['commitment', p.commitments],
    ['available', p.availableSlots],
  ])
    list.forEach((s, i) => st.prefSlot.run(p.playerId, kind, i, s.day, s.start, s.end, s.tz, s.label));
  for (const [kind, list] of [
    ['environment', p.environment],
    ['accessibility', p.accessibility],
  ])
    list.forEach((t, i) => st.prefText.run(p.playerId, kind, i, t));
}

/** Group child rows by their owner column, one query for the whole list. */
const groupBy = (rows, key) => {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r[key])) m.set(r[key], []);
    m.get(r[key]).push(r);
  }
  return m;
};
const eligOut = (r, withCategory) => ({
  minAge: r.elig_min_age,
  maxAge: r.elig_max_age,
  positionGroup: r.elig_position_group,
  ...(withCategory ? { category: r.elig_category } : {}),
  maxLevel: r.elig_max_level,
  radiusKm: r.elig_radius_km,
});
const slotOut = (s) => ({ day: s.day, start: s.start_time, end: s.end_time, tz: s.tz });
function decodeOpportunities(st, rows) {
  if (!rows.length) return [];
  const json = JSON.stringify(rows.map((r) => r.id));
  const slots = groupBy(st.oppSlotsOf.all(json), 'opportunity_id');
  const texts = groupBy(st.oppTextsOf.all(json), 'opportunity_id');
  return rows.map((r) => {
    const t = texts.get(r.id) ?? [];
    const of = (kind) => t.filter((x) => x.kind === kind).map((x) => x.text);
    return {
      id: r.id,
      orgId: r.org_id,
      orgName: r.org_name,
      orgLevel: r.org_level,
      type: r.type,
      title: r.title,
      team: r.team,
      category: r.category,
      ageGroup: r.age_group,
      role: r.role,
      description: r.description,
      schedule: r.schedule,
      deadline: r.deadline,
      capacity: r.capacity,
      eligibility: eligOut(r, true),
      requirements: of('requirement'),
      status: r.status,
      createdBy: r.created_by_name,
      createdAt: r.created_at,
      closedAt: r.closed_at,
      structured: r.structured_declared
        ? {
            trainingSlots: (slots.get(r.id) ?? []).map(slotOut),
            relocationRequired: !!r.relocation_required,
            feeMinor: r.fee_minor,
            currency: r.currency,
            expensesCovered: !!r.expenses_covered,
            environment: of('environment'),
            accommodations: of('accommodation'),
          }
        : null,
    };
  });
}
function decodeApplications(st, rows) {
  if (!rows.length) return [];
  const json = JSON.stringify(rows.map((r) => r.id));
  const verdicts = groupBy(st.appVerdictsOf.all(json), 'application_id');
  const hist = groupBy(st.appHistOf.all(json), 'application_id');
  return rows.map((r) => ({
    id: r.id,
    opportunityId: r.opportunity_id,
    orgId: r.org_id,
    playerId: r.player_id,
    playerName: r.player_name,
    submittedBy: { kind: r.submitted_by_kind, id: r.submitted_by_id, name: r.submitted_by_name },
    note: r.note,
    status: r.status,
    outcome:
      r.outcome_at === null
        ? null
        : {
            decision: r.status,
            note: r.outcome_note,
            byUserId: r.outcome_by_user_id,
            byName: r.outcome_by_name,
            at: r.outcome_at,
          },
    createdAt: r.created_at,
    remindedAt: r.reminded_at,
    suitabilitySummary:
      r.suitability_approved_at === null
        ? null
        : {
            approvedAt: r.suitability_approved_at,
            approvedBy: r.suitability_approved_by,
            verdicts: (verdicts.get(r.id) ?? []).map((v) => ({ dimension: v.dimension, verdict: v.verdict })),
          },
    history: (hist.get(r.id) ?? []).map(histOut),
  }));
}
function decodeCampaigns(st, rows) {
  if (!rows.length) return [];
  const json = JSON.stringify(rows.map((r) => r.id));
  const drills = groupBy(st.drillsOf.all(json), 'campaign_id');
  const rubric = groupBy(st.rubricOf.all(json), 'campaign_id');
  return rows.map((r) => ({
    id: r.id,
    orgId: r.org_id,
    orgName: r.org_name,
    title: r.title,
    drills: (drills.get(r.id) ?? []).map((d) => ({
      name: d.name,
      instructions: d.instructions,
      recording: { equipment: d.equipment, distance: d.distance, surface: d.surface, camera: d.camera },
    })),
    deadline: r.deadline,
    attemptsAllowed: r.attempts_allowed,
    eligibility: eligOut(r, false),
    rubric: (rubric.get(r.id) ?? []).map((x) => ({ criterion: x.criterion, guidance: x.guidance })),
    status: r.status,
    createdBy: r.created_by_name,
    createdAt: r.created_at,
  }));
}
function decodeSubmissions(st, rows) {
  if (!rows.length) return [];
  const json = JSON.stringify(rows.map((r) => r.id));
  const attempts = groupBy(st.attemptsOf.all(json), 'submission_id');
  const issues = groupBy(st.issuesOf.all(json), 'attempt_id');
  return rows.map((r) => ({
    id: r.id,
    campaignId: r.campaign_id,
    orgId: r.org_id,
    playerId: r.player_id,
    playerName: r.player_name,
    submittedBy: { kind: r.submitted_by_kind, id: r.submitted_by_id, name: r.submitted_by_name },
    attempts: (attempts.get(r.id) ?? []).map((a) => ({
      id: a.id,
      mediaId: a.media_id,
      drillName: a.drill_name,
      note: a.note,
      fileChecks: {
        passed: !!a.file_checks_passed,
        issues: (issues.get(a.id) ?? []).map((i) => FILE_CHECK_ISSUES[i.issue]),
        checkedAt: a.file_checked_at,
        kind: 'automated_file_check',
      },
      status: a.status,
      review:
        a.reviewed_at === null
          ? null
          : {
              byUserId: a.review_by_user_id,
              byName: a.review_by_name,
              at: a.reviewed_at,
              kind: 'human_review',
              reasons: a.review_reasons,
              rubricNotes: a.review_rubric_notes,
            },
      submittedAt: a.submitted_at,
    })),
    createdAt: r.created_at,
  }));
}
function decodePreferences(st, r) {
  if (!r) return null;
  const slots = st.prefSlotsOf.all(r.player_id);
  const texts = st.prefTextsOf.all(r.player_id);
  const slotsOf = (kind) => slots.filter((s) => s.kind === kind).map((s) => ({ ...slotOut(s), label: s.label }));
  const of = (kind) => texts.filter((t) => t.kind === kind).map((t) => t.text);
  return {
    playerId: r.player_id,
    commitments: slotsOf('commitment'),
    availableSlots: slotsOf('available'),
    travelLimitKm: r.travel_limit_km,
    transport: r.transport,
    relocation: r.relocation,
    ambitions: r.ambitions,
    environment: of('environment'),
    accessibility: of('accessibility'),
    compensation: { maxFeeMinor: r.max_fee_minor, currency: r.currency, expensesNeeded: !!r.expenses_needed },
    updatedAt: r.updated_at,
  };
}

export const opportunitiesCampaignsLive = (sqlite) => migrationApplied(sqlite, OPPORTUNITIES_CAMPAIGNS_MIGRATION);
const PLAYER_REFS_SQL =
  'SELECT player_id AS pid FROM applications UNION ALL SELECT player_id FROM campaign_submissions UNION ALL SELECT player_id FROM player_prefs';
export const unresolvedPlayerReferences = (sqlite) =>
  opportunitiesCampaignsLive(sqlite)
    ? {
        rows: sqlite
          .prepare(
            `SELECT count(*) AS n FROM (${PLAYER_REFS_SQL}) x WHERE NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid)`,
          )
          .get().n,
      }
    : null;
export const retainedPlayerReferences = (sqlite) =>
  opportunitiesCampaignsLive(sqlite)
    ? {
        rows: sqlite
          .prepare(
            `SELECT count(*) AS n FROM (${PLAYER_REFS_SQL}) x WHERE EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid AND p.deleted_at IS NOT NULL)`,
          )
          .get().n,
      }
    : null;

function readAll(sqlite) {
  const st = statements(sqlite);
  const all = (t) => sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
  return {
    opportunities: decodeOpportunities(st, all('opportunities')),
    applications: decodeApplications(st, all('applications')),
    campaigns: decodeCampaigns(st, all('campaigns')),
    campaignSubmissions: decodeSubmissions(st, all('campaign_submissions')),
    playerPrefs: all('player_prefs').map((r) => decodePreferences(st, r)),
  };
}

/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const OPPORTUNITIES_CAMPAIGNS_RECORDS = {
  names: OPPORTUNITIES_CAMPAIGNS_COLLECTIONS,
  read(sqlite) {
    return opportunitiesCampaignsLive(sqlite) ? readAll(sqlite) : null;
  },
};

// ------------------------------------------------------------------ the repository
/**
 * `createOpportunitiesCampaignsRepository({ sqlite, unit, now, log })`: `opportunities`, `applications`, `campaigns`,
 * `submissions` and `preferences`, each with its writes and queries, plus `reads` (the queries alone, for
 * `scoutingReads`).
 */
export function createOpportunitiesCampaignsRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite)
    throw new TypeError('the opportunities and campaigns repository needs a SQLite connection (node:sqlite)');
  const st = statements(sqlite);
  const operation = (fn) => (unit?.active?.() ? unit.join(fn) : sqlite.isTransaction ? fn() : transaction(sqlite, fn));
  const typedOr = (name, raw) => {
    const t = TYPERS[name](raw, name);
    if (!t.ok) throw refusal('OPPORTUNITIES_CAMPAIGNS_INPUT_INVALID', t.reason);
    return t.record;
  };
  const q = (sql) => sqlite.prepare(sql);
  const frozen = (list) => list.map(deepFreeze);
  const one = (decode, row) => (row ? deepFreeze(decode(st, [row])[0]) : null);

  /** `update(id, (draft) => …)` for one kind: typed whole; the listed fields cannot change; nested updates refused. */
  const updater = (name, byIdStmt, decode, write, fixed) => {
    const updating = new Set();
    const read = (id) => {
      const r = typeof id === 'string' ? byIdStmt.get(id) : null;
      if (!r) throw refusal('OPPORTUNITIES_CAMPAIGNS_NOT_FOUND', `${name} ${id} is not a record of the repository`);
      return deepFreeze(decode(st, [r])[0]);
    };
    return (id, change) => {
      if (typeof change !== 'function')
        throw new TypeError(`${name}.update(id, change) needs a function that edits the copy it is given`);
      if (updating.has(id))
        throw refusal(
          'OPPORTUNITIES_CAMPAIGNS_NESTED_UPDATE',
          `${name} ${id} is already being updated; make the second change after the first returns`,
        );
      updating.add(id);
      try {
        return operation(() => {
          const stored = read(id);
          const draft = clone(stored);
          const returned = change(draft);
          const next = typedOr(name, returned === undefined ? draft : returned);
          for (const k of fixed)
            if (JSON.stringify(next[k]) !== JSON.stringify(stored[k]))
              throw refusal('OPPORTUNITIES_CAMPAIGNS_INPUT_INVALID', `${name} ${id}: ${k} cannot change`);
          write(st, next);
          return read(id);
        });
      } finally {
        updating.delete(id);
      }
    };
  };

  // ---- opportunities
  const oppPage = q(
    'SELECT rowid AS rid, * FROM opportunities WHERE org_id = ? AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?',
  );
  const oppOpen = q(
    "SELECT * FROM opportunities WHERE status = 'published' AND deadline >= ? ORDER BY deadline, rowid",
  );
  const appCounts = q(
    "SELECT opportunity_id AS id, SUM(status <> 'withdrawn') AS live, SUM(status = 'submitted') AS outstanding FROM applications WHERE opportunity_id IN (SELECT value FROM json_each(?)) GROUP BY opportunity_id",
  );
  const opportunities = {
    create: (raw) =>
      operation(() => {
        const o = typedOr('opportunities', raw);
        if (st.oppById.get(o.id))
          throw refusal('OPPORTUNITIES_CAMPAIGNS_DUPLICATE', `opportunities ${o.id} already exists`);
        writeOpportunity(st, o);
        return opportunities.byId(o.id);
      }),
    update: updater('opportunities', st.oppById, decodeOpportunities, writeOpportunity, [
      'id',
      'orgId',
      'orgName',
      'orgLevel',
      'createdBy',
      'createdAt',
    ]),
    byId: (id) => one(decodeOpportunities, typeof id === 'string' ? st.oppById.get(id) : null),
    /** The opportunity `id` if it belongs to `orgId`, else null. */
    ofOrg: (id, orgId) => {
      const o = opportunities.byId(id);
      return o && o.orgId === orgId ? o : null;
    },
    /** Published opportunities whose deadline is `today` or later, soonest first (the board narrows further in code). */
    openOn: (today) => frozen(decodeOpportunities(st, oppOpen.all(today))),
    /** The club's opportunities, newest first, by cursor (`after` is the previous page's last `[rowid]`). */
    page(orgId, { limit, after = null }) {
      const rows = oppPage.all(orgId, after?.[0] ?? null, after?.[0] ?? null, limit + 1);
      const decoded = decodeOpportunities(st, rows);
      return { rows: rows.map((r, i) => ({ key: [r.rid], opportunity: deepFreeze(decoded[i]) })) };
    },
    /** `{ [id]: { applications, outstanding } }`: live (not withdrawn) and unanswered applications per opportunity. */
    applicationCounts(oppIds) {
      const out = Object.fromEntries(oppIds.map((id) => [id, { applications: 0, outstanding: 0 }]));
      for (const r of appCounts.all(JSON.stringify(oppIds)))
        out[r.id] = { applications: r.live, outstanding: r.outstanding };
      return out;
    },
  };

  // ---- applications
  const appsOfPlayer = q(
    'SELECT * FROM applications WHERE player_id IN (SELECT value FROM json_each(?)) ORDER BY rowid',
  );
  const appsOfOpp = q('SELECT * FROM applications WHERE opportunity_id = ? ORDER BY rowid');
  const appsOfOppPage = q('SELECT * FROM applications WHERE opportunity_id = ? ORDER BY rowid LIMIT ? OFFSET ?');
  const appsOfOppCount = q('SELECT COUNT(*) AS n FROM applications WHERE opportunity_id = ?');
  const appLive = q("SELECT * FROM applications WHERE opportunity_id = ? AND player_id = ? AND status <> 'withdrawn'");
  const appReminders = q(
    "SELECT * FROM applications WHERE status = 'submitted' AND reminded_at IS NULL AND created_at < ? ORDER BY created_at",
  );
  const applications = {
    create: (raw) =>
      operation(() => {
        const a = typedOr('applications', raw);
        if (st.appById.get(a.id))
          throw refusal('OPPORTUNITIES_CAMPAIGNS_DUPLICATE', `applications ${a.id} already exists`);
        const o = st.oppById.get(a.opportunityId);
        if (!o || o.org_id !== a.orgId)
          throw refusal(
            'OPPORTUNITIES_CAMPAIGNS_INPUT_INVALID',
            `applications ${a.id}: opportunity ${a.opportunityId} is not an opportunity of organisation ${a.orgId}`,
          );
        if (a.status !== 'withdrawn' && appLive.get(a.opportunityId, a.playerId))
          throw refusal(
            'OPPORTUNITIES_CAMPAIGNS_UNIQUENESS',
            `applications: player ${a.playerId} already has a live application to ${a.opportunityId}`,
          );
        writeApplication(st, a);
        return applications.byId(a.id);
      }),
    update: updater('applications', st.appById, decodeApplications, writeApplication, [
      'id',
      'opportunityId',
      'orgId',
      'playerId',
      'submittedBy',
      'createdAt',
    ]),
    byId: (id) => one(decodeApplications, typeof id === 'string' ? st.appById.get(id) : null),
    ofOrg: (id, orgId) => {
      const a = applications.byId(id);
      return a && a.orgId === orgId ? a : null;
    },
    /** The application `id` if it is one of `playerIds`', else null. */
    ofPlayers: (id, playerIds) => {
      const a = applications.byId(id);
      return a && playerIds.includes(a.playerId) ? a : null;
    },
    forPlayers: (playerIds) => frozen(decodeApplications(st, appsOfPlayer.all(JSON.stringify(playerIds)))),
    forOpportunity: (oppId) => frozen(decodeApplications(st, appsOfOpp.all(oppId))),
    /** One opportunity's applications by offset, oldest first (the club list's shape), `{ total, items }`. */
    pageForOpportunity: (oppId, { limit, offset }) => ({
      total: appsOfOppCount.get(oppId).n,
      items: frozen(decodeApplications(st, appsOfOppPage.all(oppId, limit, offset))),
    }),
    /** The player's application to the opportunity that is not withdrawn, or null. */
    liveFor: (oppId, playerId) => one(decodeApplications, appLive.get(oppId, playerId)),
    /** Unanswered applications submitted before `cutoff` that were never reminded (the sweep). */
    remindersDue: (cutoff) => frozen(decodeApplications(st, appReminders.all(cutoff))),
  };

  // ---- campaigns and submissions
  const campPage = q(
    'SELECT rowid AS rid, * FROM campaigns WHERE org_id = ? AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?',
  );
  const campOpen = q("SELECT * FROM campaigns WHERE status = 'published' AND deadline >= ? ORDER BY rowid");
  const subCounts = q(`SELECT s.campaign_id AS id, COUNT(*) AS submissions,
      SUM(EXISTS (SELECT 1 FROM campaign_attempts a WHERE a.submission_id = s.id AND a.status = 'submitted')) AS awaiting
    FROM campaign_submissions s WHERE s.campaign_id IN (SELECT value FROM json_each(?)) GROUP BY s.campaign_id`);
  const campaigns = {
    create: (raw) =>
      operation(() => {
        const c = typedOr('campaigns', raw);
        if (st.campById.get(c.id))
          throw refusal('OPPORTUNITIES_CAMPAIGNS_DUPLICATE', `campaigns ${c.id} already exists`);
        writeCampaign(st, c);
        return campaigns.byId(c.id);
      }),
    byId: (id) => one(decodeCampaigns, typeof id === 'string' ? st.campById.get(id) : null),
    ofOrg: (id, orgId) => {
      const c = campaigns.byId(id);
      return c && c.orgId === orgId ? c : null;
    },
    /** Published campaigns whose deadline is `today` or later. */
    openOn: (today) => frozen(decodeCampaigns(st, campOpen.all(today))),
    page(orgId, { limit, after = null }) {
      const rows = campPage.all(orgId, after?.[0] ?? null, after?.[0] ?? null, limit + 1);
      const decoded = decodeCampaigns(st, rows);
      return { rows: rows.map((r, i) => ({ key: [r.rid], campaign: deepFreeze(decoded[i]) })) };
    },
    /** `{ [id]: { submissions, awaitingReview } }`: submissions, and those with an attempt waiting for a human review. */
    submissionCounts(campIds) {
      const out = Object.fromEntries(campIds.map((id) => [id, { submissions: 0, awaitingReview: 0 }]));
      for (const r of subCounts.all(JSON.stringify(campIds)))
        out[r.id] = { submissions: r.submissions, awaitingReview: r.awaiting };
      return out;
    },
  };
  const subsOfCamp = q('SELECT * FROM campaign_submissions WHERE campaign_id = ? ORDER BY rowid');
  const subOf = q('SELECT * FROM campaign_submissions WHERE campaign_id = ? AND player_id = ?');
  const subsOfPlayer = q('SELECT * FROM campaign_submissions WHERE player_id = ? ORDER BY rowid');
  const submissions = {
    create: (raw) =>
      operation(() => {
        const s = typedOr('campaignSubmissions', raw);
        if (st.subById.get(s.id))
          throw refusal('OPPORTUNITIES_CAMPAIGNS_DUPLICATE', `campaignSubmissions ${s.id} already exists`);
        const c = st.campById.get(s.campaignId);
        if (!c || c.org_id !== s.orgId)
          throw refusal(
            'OPPORTUNITIES_CAMPAIGNS_INPUT_INVALID',
            `campaignSubmissions ${s.id}: campaign ${s.campaignId} is not a campaign of organisation ${s.orgId}`,
          );
        if (subOf.get(s.campaignId, s.playerId))
          throw refusal(
            'OPPORTUNITIES_CAMPAIGNS_UNIQUENESS',
            `campaignSubmissions: player ${s.playerId} already has a submission to ${s.campaignId}`,
          );
        for (const a of s.attempts)
          if (st.attemptOwner.get(a.id))
            throw refusal('OPPORTUNITIES_CAMPAIGNS_DUPLICATE', `campaign attempt ${a.id} already exists`);
        writeSubmission(st, s);
        return submissions.byId(s.id);
      }),
    update: updater(
      'campaignSubmissions',
      st.subById,
      decodeSubmissions,
      (s2, next) => {
        for (const a of next.attempts) {
          const owner = s2.attemptOwner.get(a.id);
          if (owner && owner.submission_id !== next.id)
            throw refusal(
              'OPPORTUNITIES_CAMPAIGNS_DUPLICATE',
              `campaign attempt ${a.id} belongs to another submission`,
            );
        }
        writeSubmission(s2, next);
      },
      ['id', 'campaignId', 'orgId', 'playerId', 'submittedBy', 'createdAt'],
    ),
    byId: (id) => one(decodeSubmissions, typeof id === 'string' ? st.subById.get(id) : null),
    forCampaign: (campaignId) => frozen(decodeSubmissions(st, subsOfCamp.all(campaignId))),
    /** The player's submission to the campaign, or null. */
    forCampaignPlayer: (campaignId, playerId) => one(decodeSubmissions, subOf.get(campaignId, playerId)),
    forPlayer: (playerId) => frozen(decodeSubmissions(st, subsOfPlayer.all(playerId))),
    /** The submission holding attempt `attemptId`, or null. */
    byAttempt: (attemptId) => {
      const o = typeof attemptId === 'string' ? st.attemptOwner.get(attemptId) : null;
      return o ? submissions.byId(o.submission_id) : null;
    },
  };

  // ---- preferences
  const preferences = {
    /** Save the player's whole preferences (one row per player). Returns the stored record. */
    save: (raw) =>
      operation(() => {
        const p = typedOr('playerPrefs', raw);
        writePreferences(st, p);
        return preferences.forPlayer(p.playerId);
      }),
    /** The player's saved preferences, or null when nothing was ever saved. */
    forPlayer: (playerId) =>
      typeof playerId === 'string' ? deepFreeze(decodePreferences(st, st.prefsOf.get(playerId))) : null,
  };

  const WRITE_OPS = new Set(['create', 'update', 'save']);
  const readOnly = (o) => Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => !WRITE_OPS.has(k))));
  const counters = Object.fromEntries(
    OPPORTUNITIES_CAMPAIGNS_TABLES.map((t) => [t, q(`SELECT COUNT(*) AS n FROM ${t}`)]),
  );
  return {
    opportunities,
    applications,
    campaigns,
    submissions,
    preferences,
    /** The queries alone, for modules and projectors that must not write (`scoutingReads`). */
    reads: Object.freeze({
      opportunities: readOnly(opportunities),
      applications: readOnly(applications),
      campaigns: readOnly(campaigns),
      campaignSubmissions: readOnly(submissions),
      playerPrefs: readOnly(preferences),
    }),
    attach() {
      if (!opportunitiesCampaignsLive(sqlite))
        throw new Error(
          `the opportunities and campaigns repository needs ${OPPORTUNITIES_CAMPAIGNS_MIGRATION} recorded; it never imports an in-memory array`,
        );
      return { counts: this.counts() };
    },
    counts() {
      return Object.fromEntries(OPPORTUNITIES_CAMPAIGNS_TABLES.map((t) => [t, counters[t].get().n]));
    },
    pending: () => 0,
    exportAll() {
      return OPPORTUNITIES_CAMPAIGNS_RECORDS.read(sqlite);
    },
    log,
    now,
  };
}
