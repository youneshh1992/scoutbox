/**
 * The opportunity board, applications, assessment campaigns and players' private suitability preferences.
 *
 * Records (the keys every reader sees): `Opportunity`, `Application`, `Campaign`, `CampaignSubmission` (with its
 * `CampaignAttempt`s) and `PlayerPreferences` below, deep-frozen as read back.
 *
 * A record is created typed whole, then changes only through named acts: each is typed with the record, writes only
 * its own columns and rows, and is guarded in SQL by the state it moves from. A record the columns cannot hold is
 * refused with its id (the routes check first and answer 400). Each joins the open unit of work, the caller's
 * transaction, or a transaction of its own. The typers take `unknown`, so a caller still in JavaScript can pass
 * anything: the typer and the columns judge it.
 *   opportunities.create, close, setStructured
 *   applications.create, withdraw, decide, markReminded, shareSuitability, unshareSuitability
 *   campaigns.create
 *   submissions.create, addAttempt, reviewAttempt — one submission per campaign and player; attempts are child rows
 *   preferences.save(record) — one row per player, written only when the player or guardian saves
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
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { isPlainObject, describe } from './fieldSpecs.ts';
import { migrationApplied, operationOn, type UnitParticipant } from './database.ts';
import { readsOf } from './identityRules.ts';
import { columnsOf, insertFor, writeKit, type Flatten, type InputFor, type RowOf } from './writes.ts';
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
  historyOf,
  histOut,
  type Bad,
  type HistoryRow,
  type ScoutingHistoryEntry,
  type ScoutingHistoryInput,
  type Typed,
} from './scoutingEvidence.ts';
import { deepFreeze, type DeepReadonly } from '../domains/platform/values.ts';
import { PLAYER_LEVELS, type PlayerLevel } from './playerRecord.ts';
import { ORG_LEVELS, type OrgLevel } from './orgs.ts';
import { parseStrictDateOnly } from '../temporal.ts';

export const OPPORTUNITIES_CAMPAIGNS_MIGRATION = '0022_opportunities_campaigns';
export const OPPORTUNITIES_CAMPAIGNS_COLLECTIONS = Object.freeze([
  'opportunities',
  'applications',
  'campaigns',
  'campaignSubmissions',
  'playerPrefs',
] as const);
export type OpportunitiesCampaignsCollection = (typeof OPPORTUNITIES_CAMPAIGNS_COLLECTIONS)[number];
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
] as const);
export type OpportunitiesCampaignsTable = (typeof OPPORTUNITIES_CAMPAIGNS_TABLES)[number];

// ------------------------------------------------------------------ vocabulary
export const OPPORTUNITY_TYPES = Object.freeze(['trial', 'open_day', 'programme', 'role'] as const);
export const OPPORTUNITY_CATEGORIES = Object.freeze(['mens', 'womens', 'boys', 'girls', 'mixed'] as const);
export const ELIGIBILITY_POSITION_GROUPS = Object.freeze(['any', 'GK', 'DEF', 'MID', 'ATT'] as const);
export const OPPORTUNITY_STATUSES = Object.freeze(['published', 'closed'] as const);
export const APPLICATION_STATUSES = Object.freeze(['submitted', 'withdrawn', 'accepted', 'declined'] as const);
export const ACTOR_KINDS = Object.freeze(['player', 'guardian'] as const);
export const SUITABILITY_DIMENSIONS = Object.freeze([
  'schedule',
  'travel',
  'relocation',
  'compensation',
  'environment',
  'accessibility',
] as const);
export const SUITABILITY_VERDICTS = Object.freeze(['compatible', 'conflict', 'unknown'] as const);
export const ATTEMPT_STATUSES = Object.freeze(['submitted', 'failed_checks', 'accepted', 'returned'] as const);
/** The automated FILE checks: what each issue says to the player, by its stored code. */
export const FILE_CHECK_ISSUES = Object.freeze({
  media_missing: 'attach the recorded video before submitting',
  not_video: 'the attached file is not a video',
  not_uploaded: 'the video file itself was never uploaded',
} as const);
export const SLOT_DAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const);
export const TRANSPORTS = Object.freeze(['own', 'public', 'lift_needed'] as const);
export const RELOCATIONS = Object.freeze(['yes', 'no', 'discuss'] as const);
export type OpportunityType = (typeof OPPORTUNITY_TYPES)[number];
export type OpportunityCategory = (typeof OPPORTUNITY_CATEGORIES)[number];
export type EligibilityPositionGroup = (typeof ELIGIBILITY_POSITION_GROUPS)[number];
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];
export type ActorKind = (typeof ACTOR_KINDS)[number];
export type SuitabilityDimension = (typeof SUITABILITY_DIMENSIONS)[number];
export type SuitabilityVerdict = (typeof SUITABILITY_VERDICTS)[number];
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];
/** An issue's stored code. */
export type FileCheckIssueCode = keyof typeof FILE_CHECK_ISSUES;
/** What an issue says to the player: the form a record carries. */
export type FileCheckIssue = (typeof FILE_CHECK_ISSUES)[FileCheckIssueCode];
export type SlotDay = (typeof SLOT_DAYS)[number];
export type Transport = (typeof TRANSPORTS)[number];
export type Relocation = (typeof RELOCATIONS)[number];
/** An answered application's status, which its outcome's decision repeats. */
export type ApplicationDecision = 'accepted' | 'declined';
/** A reviewed attempt's status. */
export type AttemptDecision = 'accepted' | 'returned';
const ISSUE_CODE = new Map(
  (Object.keys(FILE_CHECK_ISSUES) as FileCheckIssueCode[]).map((code) => [FILE_CHECK_ISSUES[code], code] as const),
);
const isIssue = (v: unknown): v is FileCheckIssue => ISSUE_CODE.has(v as FileCheckIssue);
/** The kinds of an opportunity's text rows, and of a player's. */
type OpportunityTextKind = 'requirement' | 'environment' | 'accommodation';
type PrefSlotKind = 'commitment' | 'available';
type PrefTextKind = 'environment' | 'accessibility';
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

// ------------------------------------------------------------------ records
type SlotFields = {
  day: SlotDay;
  /** 24-hour HH:MM, before `end`. */
  start: string;
  end: string;
  /** An IANA time zone. */
  tz: string;
};
type LabelledSlotFields = Flatten<SlotFields & { label: string | null }>;
type CampaignEligibilityFields = {
  minAge: number | null;
  maxAge: number | null;
  positionGroup: EligibilityPositionGroup;
  maxLevel: PlayerLevel | null;
  radiusKm: number | null;
};
type OpportunityEligibilityFields = {
  minAge: number | null;
  maxAge: number | null;
  positionGroup: EligibilityPositionGroup;
  category: OpportunityCategory;
  maxLevel: PlayerLevel | null;
  radiusKm: number | null;
};
type StructuredFields = {
  trainingSlots: SlotFields[];
  relocationRequired: boolean;
  feeMinor: number | null;
  /** A three-letter code such as GBP. */
  currency: string;
  expensesCovered: boolean;
  environment: string[];
  accommodations: string[];
};
type OpportunityFields = {
  id: string;
  orgId: string;
  orgName: string;
  orgLevel: OrgLevel;
  type: OpportunityType;
  title: string;
  team: string | null;
  category: OpportunityCategory;
  ageGroup: string | null;
  role: string | null;
  description: string | null;
  schedule: string | null;
  /** A day, YYYY-MM-DD. */
  deadline: string;
  capacity: number | null;
  eligibility: OpportunityEligibilityFields;
  requirements: string[];
  status: OpportunityStatus;
  /** The name of who published it. */
  createdBy: string;
  createdAt: number;
  /** Set exactly when the opportunity is closed. */
  closedAt: number | null;
  /** The suitability requirements, when the club declared them. */
  structured: StructuredFields | null;
};
type ActorFields = { kind: ActorKind; id: string; name: string | null };
type OutcomeFields = {
  decision: ApplicationDecision;
  note: string | null;
  byUserId: string;
  byName: string | null;
  at: number;
};
type VerdictFields = {
  dimension: SuitabilityDimension;
  verdict: SuitabilityVerdict;
};
type SuitabilitySummaryFields = {
  approvedAt: number;
  approvedBy: ActorKind;
  verdicts: VerdictFields[];
};
type HistoryFields = Flatten<ScoutingHistoryEntry>;
type ApplicationFields = {
  id: string;
  opportunityId: string;
  orgId: string;
  playerId: string;
  playerName: string | null;
  submittedBy: ActorFields;
  note: string | null;
  status: ApplicationStatus;
  /** Set exactly on an accepted or declined application. */
  outcome: OutcomeFields | null;
  createdAt: number;
  remindedAt: number | null;
  /** What the player or guardian approved onto this application, dimension and verdict only. */
  suitabilitySummary: SuitabilitySummaryFields | null;
  history: HistoryFields[];
};
type RecordingFields = {
  equipment: string;
  distance: string;
  surface: string;
  camera: string;
};
type DrillFields = {
  name: string;
  instructions: string;
  recording: RecordingFields;
};
type RubricFields = { criterion: string; guidance: string };
type CampaignFields = {
  id: string;
  orgId: string;
  orgName: string;
  title: string;
  drills: DrillFields[];
  /** A day, YYYY-MM-DD. */
  deadline: string;
  attemptsAllowed: number;
  eligibility: CampaignEligibilityFields;
  rubric: RubricFields[];
  status: 'published';
  createdBy: string;
  createdAt: number;
};
type FileChecksFields = {
  /** Exactly when no issue is listed. */
  passed: boolean;
  issues: FileCheckIssue[];
  checkedAt: number;
  kind: 'automated_file_check';
};
type ReviewFields = {
  byUserId: string;
  byName: string | null;
  at: number;
  kind: 'human_review';
  /** Required on a returned attempt. */
  reasons: string | null;
  rubricNotes: string | null;
};
type AttemptFields = {
  id: string;
  mediaId: string | null;
  drillName: string;
  note: string | null;
  fileChecks: FileChecksFields;
  /** `failed_checks` exactly when the file checks failed. */
  status: AttemptStatus;
  /** Set exactly on an accepted or returned attempt. */
  review: ReviewFields | null;
  submittedAt: number;
};
type SubmissionFields = {
  id: string;
  campaignId: string;
  orgId: string;
  playerId: string;
  playerName: string | null;
  submittedBy: ActorFields;
  attempts: AttemptFields[];
  createdAt: number;
};
type CompensationFields = {
  maxFeeMinor: number | null;
  currency: string;
  expensesNeeded: boolean;
};
type PreferencesFields = {
  playerId: string;
  commitments: LabelledSlotFields[];
  availableSlots: LabelledSlotFields[];
  travelLimitKm: number | null;
  transport: Transport | null;
  relocation: Relocation | null;
  ambitions: string | null;
  environment: string[];
  accessibility: string[];
  compensation: CompensationFields;
  updatedAt: number;
};
export type WeeklySlot = DeepReadonly<SlotFields>;
export type LabelledSlot = DeepReadonly<LabelledSlotFields>;
export type OpportunityEligibility = DeepReadonly<OpportunityEligibilityFields>;
export type CampaignEligibility = DeepReadonly<CampaignEligibilityFields>;
export type StructuredRequirements = DeepReadonly<StructuredFields>;
export type Opportunity = DeepReadonly<OpportunityFields>;
export type ApplicationActor = DeepReadonly<ActorFields>;
export type ApplicationOutcome = DeepReadonly<OutcomeFields>;
export type SuitabilitySummary = DeepReadonly<SuitabilitySummaryFields>;
export type Application = DeepReadonly<ApplicationFields>;
export type CampaignDrill = DeepReadonly<DrillFields>;
export type CampaignRubricCriterion = DeepReadonly<RubricFields>;
export type Campaign = DeepReadonly<CampaignFields>;
export type AttemptFileChecks = DeepReadonly<FileChecksFields>;
export type AttemptReview = DeepReadonly<ReviewFields>;
export type CampaignAttempt = DeepReadonly<AttemptFields>;
export type CampaignSubmission = DeepReadonly<SubmissionFields>;
export type PlayerPreferences = DeepReadonly<PreferencesFields>;
/** A player's preferences before anything is saved: nothing is stored, so there is no `updatedAt`. */
export type BlankPreferences = Flatten<Omit<PreferencesFields, 'updatedAt'> & { updatedAt: null }>;
type FieldsOf = {
  opportunities: OpportunityFields;
  applications: ApplicationFields;
  campaigns: CampaignFields;
  campaignSubmissions: SubmissionFields;
  playerPrefs: PreferencesFields;
};
type RecordOf = {
  [N in OpportunitiesCampaignsCollection]: DeepReadonly<FieldsOf[N]>;
};
export type OpportunitiesCampaignsRecords = {
  [N in OpportunitiesCampaignsCollection]: RecordOf[N][];
};

// ------------------------------------------------------------------ inputs (what the typers accept)
// InputFor lets a list be left out; the lists the typers require are named again here.
export type WeeklySlotInput = SlotFields;
export type LabelledSlotInput = InputFor<LabelledSlotFields>;
export type OpportunityEligibilityInput = InputFor<OpportunityEligibilityFields>;
export type CampaignEligibilityInput = InputFor<CampaignEligibilityFields>;
export type StructuredRequirementsInput = Flatten<
  Omit<InputFor<StructuredFields>, 'trainingSlots' | 'environment' | 'accommodations'> & {
    trainingSlots: WeeklySlotInput[];
    environment: string[];
    accommodations: string[];
  }
>;
export type OpportunityInput = Flatten<
  Omit<InputFor<OpportunityFields>, 'structured'> & {
    structured?: StructuredRequirementsInput | null;
  }
>;
export type ApplicationActorInput = InputFor<ActorFields>;
export type ApplicationOutcomeInput = InputFor<OutcomeFields>;
export type SuitabilitySummaryInput = Flatten<
  Omit<InputFor<SuitabilitySummaryFields>, 'verdicts'> & {
    verdicts: VerdictFields[];
  }
>;
export type ApplicationInput = Flatten<
  Omit<InputFor<ApplicationFields>, 'suitabilitySummary' | 'history'> & {
    suitabilitySummary?: SuitabilitySummaryInput | null;
    history?: ScoutingHistoryInput[] | null;
  }
>;
export type CampaignDrillInput = DrillFields;
export type CampaignRubricInput = RubricFields;
export type CampaignInput = Flatten<
  Omit<InputFor<CampaignFields>, 'drills' | 'rubric'> & {
    drills: CampaignDrillInput[];
    rubric?: CampaignRubricInput[] | null;
  }
>;
export type AttemptFileChecksInput = FileChecksFields;
export type AttemptReviewInput = InputFor<ReviewFields>;
export type CampaignAttemptInput = Flatten<
  Omit<InputFor<AttemptFields>, 'fileChecks'> & {
    fileChecks: AttemptFileChecksInput;
  }
>;
export type CampaignSubmissionInput = Flatten<
  Omit<InputFor<SubmissionFields>, 'attempts'> & {
    attempts?: CampaignAttemptInput[] | null;
  }
>;
export type CompensationInput = InputFor<CompensationFields>;
export type PlayerPreferencesInput = Flatten<
  Omit<InputFor<PreferencesFields>, 'commitments' | 'availableSlots' | 'environment' | 'accessibility'> & {
    commitments: LabelledSlotInput[];
    availableSlots: LabelledSlotInput[];
    environment: string[];
    accessibility: string[];
  }
>;
/** What each act accepts. */
export type ApplicationDecisionInput = Flatten<
  Omit<ApplicationOutcomeInput, 'decision'> & { decision: ApplicationDecision }
>;
export type AttemptReviewDecision = {
  attemptId: string;
  decision: AttemptDecision;
  review: AttemptReviewInput;
};

// ------------------------------------------------------------------ DDL
const inList = (list: readonly string[]) => list.map((v) => `'${v}'`).join(',');
const HHMM = "length(%c) = 5 AND %c GLOB '[0-2][0-9]:[0-5][0-9]' AND %c <= '23:59'";
const hhmm = (c: string) => HHMM.replaceAll('%c', c);
const slotColumns = `
  ordinal    INTEGER NOT NULL CHECK (ordinal >= 0),
  day        TEXT NOT NULL CHECK (day IN (${inList(SLOT_DAYS)})),
  start_time TEXT NOT NULL CHECK (${hhmm('start_time')}),
  end_time   TEXT NOT NULL CHECK (${hhmm('end_time')}),
  tz         TEXT NOT NULL CHECK (length(tz) BETWEEN 1 AND ${L.tz}),`;
const eligibilityColumns = (withCategory: boolean) => `
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
// Each typer checks the value field by field, then reads it as the input it has just been checked to be.
type Fields = Record<string, unknown>;
type Listed<T> = { ok: true; list: T[] } | Bad;
const objectAt = (raw: unknown, at: string): Bad => ({
  ok: false,
  reason: `${at} is not an object (${describe(raw)})`,
});
const dayOnly = (v: unknown): v is string => isStr(v) && parseStrictDateOnly(v).ok; // one definition of a calendar day (temporal.ts)
const reqDay = (rec: Fields, at: string, field: string): Bad | null =>
  dayOnly(rec[field]) ? null : bad(at, field, `must be a YYYY-MM-DD day (got ${describe(rec[field])})`);
const isBool = (v: unknown): v is boolean => v === true || v === false;
const reqBool = (rec: Fields, at: string, field: string): Bad | null =>
  isBool(rec[field]) ? null : bad(at, field, `must be true or false (got ${describe(rec[field])})`);
const oneOf = (
  rec: Fields,
  at: string,
  field: string,
  list: readonly string[],
  { optional = false }: { optional?: boolean } = {},
): Bad | null => {
  const v = rec[field];
  if (optional && (v === undefined || v === null)) return null;
  return (list as readonly unknown[]).includes(v)
    ? null
    : bad(at, field, `must be one of ${list.join('|')}${optional ? ' or null' : ''} (got ${describe(v)})`);
};
const optIntIn = (rec: Fields, at: string, field: string, min: number, max: number): Bad | null => {
  const v = rec[field];
  if (v === undefined || v === null) return null;
  return isInt(v) && v >= min && v <= max
    ? null
    : bad(at, field, `must be a whole number from ${min} to ${max} or null (got ${describe(v)})`);
};
const optNumIn = (rec: Fields, at: string, field: string, min: number, max: number): Bad | null => {
  const v = rec[field];
  if (v === undefined || v === null) return null;
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
    ? null
    : bad(at, field, `must be a number from ${min} to ${max} or null (got ${describe(v)})`);
};
const CURRENCY = /^[A-Z]{3}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** An IANA time zone this runtime knows. */
export const knownTimeZone = (tz: unknown): tz is string => {
  if (!nonEmpty(tz) || tz.length > L.tz) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** A weekly slot `{ day, start, end, tz }` (and `label` where `withLabel`): a known day, HH:MM times, start before end, a known zone. */
export function typeSlot(s: unknown, at: string, opts: { withLabel: true }): Typed<LabelledSlotFields>;
export function typeSlot(s: unknown, at: string, opts?: { withLabel?: false }): Typed<SlotFields>;
export function typeSlot(
  s: unknown,
  at: string,
  { withLabel = false }: { withLabel?: boolean } = {},
): Typed<SlotFields | LabelledSlotFields> {
  if (!isPlainObject(s)) return objectAt(s, at);
  const problem = first(
    unknownFields(s, at, withLabel ? ['day', 'start', 'end', 'tz', 'label'] : ['day', 'start', 'end', 'tz']),
    oneOf(s, at, 'day', SLOT_DAYS),
    withLabel ? optText(s, at, 'label', L.label) : null,
  );
  if (problem) return problem;
  for (const f of ['start', 'end'])
    if (!isStr(s[f]) || !TIME.test(s[f])) return bad(at, f, `must be a 24-hour time HH:MM (got ${describe(s[f])})`);
  const v = s as LabelledSlotInput;
  if (v.start >= v.end) return bad(at, 'end', 'must be after start (a slot within one day)');
  if (!knownTimeZone(v.tz))
    return bad(at, 'tz', `must be an IANA time zone such as Europe/London (got ${describe(v.tz)})`);
  return {
    ok: true,
    record: {
      day: v.day,
      start: v.start,
      end: v.end,
      tz: v.tz,
      // An empty label is none at all.
      ...(withLabel ? { label: orNull(v.label) || null } : {}),
    },
  };
}
function typeSlots<T>(list: unknown, at: string, max: number, typer: (s: unknown, at: string) => Typed<T>): Listed<T> {
  if (!Array.isArray(list)) return bad(at, '', `must be an array (got ${describe(list)})`);
  if (list.length > max) return bad(at, '', `holds more than ${max} slots`);
  const out: T[] = [];
  for (let i = 0; i < list.length; i++) {
    const t = typer(list[i], `${at}[${i}]`);
    if (!t.ok) return t;
    out.push(t.record);
  }
  return { ok: true, list: out };
}
const weekly = (s: unknown, at: string) => typeSlot(s, at);
const labelled = (s: unknown, at: string) => typeSlot(s, at, { withLabel: true });
function typeTexts(list: unknown, at: string, max: number, maxLen: number): Listed<string> {
  if (!Array.isArray(list)) return bad(at, '', `must be an array (got ${describe(list)})`);
  if (list.length > max) return bad(at, '', `holds more than ${max} entries`);
  for (let i = 0; i < list.length; i++)
    if (!nonEmpty(list[i]) || list[i].length > maxLen)
      return bad(at, `[${i}]`, `must be non-empty text of at most ${maxLen} characters (got ${describe(list[i])})`);
  return { ok: true, list: [...(list as string[])] };
}
const typeActor = (a: unknown, at: string): Typed<ActorFields> =>
  isPlainObject(a) &&
  (ACTOR_KINDS as readonly unknown[]).includes(a.kind) &&
  nonEmpty(a.id) &&
  a.id.length <= 80 &&
  (a.name === null || a.name === undefined || (isStr(a.name) && a.name.length <= L.name)) &&
  Object.keys(a).every((k) => ['kind', 'id', 'name'].includes(k))
    ? {
        ok: true,
        record: {
          kind: a.kind as ActorKind,
          id: a.id,
          name: orNull(a.name as string | null | undefined),
        },
      }
    : {
        ok: false,
        reason: `${at} must be {kind: ${ACTOR_KINDS.join('|')}, id, name}`,
      };

const ELIG_FIELDS = (withCategory: boolean) =>
  withCategory
    ? ['minAge', 'maxAge', 'positionGroup', 'category', 'maxLevel', 'radiusKm']
    : ['minAge', 'maxAge', 'positionGroup', 'maxLevel', 'radiusKm'];
/** Eligibility `{ minAge, maxAge, positionGroup, [category], maxLevel, radiusKm }`, typed; every field present. */
export function typeEligibility(
  e: unknown,
  at: string,
  opts: { withCategory: true },
): Typed<OpportunityEligibilityFields>;
export function typeEligibility(
  e: unknown,
  at: string,
  opts: { withCategory: false },
): Typed<CampaignEligibilityFields>;
export function typeEligibility(
  e: unknown,
  at: string,
  opts: { withCategory: boolean },
): Typed<OpportunityEligibilityFields | CampaignEligibilityFields>;
export function typeEligibility(
  e: unknown,
  at: string,
  { withCategory }: { withCategory: boolean },
): Typed<OpportunityEligibilityFields | CampaignEligibilityFields> {
  if (!isPlainObject(e)) return objectAt(e, at);
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
  const v = e as OpportunityEligibilityInput;
  if (isInt(v.minAge) && isInt(v.maxAge) && v.minAge > v.maxAge)
    return bad(at, 'maxAge', 'is below minAge (nobody could be eligible)');
  return {
    ok: true,
    record: {
      minAge: orNull(v.minAge),
      maxAge: orNull(v.maxAge),
      positionGroup: v.positionGroup,
      ...(withCategory ? { category: v.category } : {}),
      maxLevel: orNull(v.maxLevel),
      radiusKm: orNull(v.radiusKm),
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
] as const satisfies readonly (keyof StructuredFields)[];
/** An opportunity's structured requirements (suitability), typed. */
export function typeStructured(s: unknown, at: string): Typed<StructuredFields> {
  if (!isPlainObject(s)) return objectAt(s, at);
  const problem = first(
    unknownFields(s, at, STRUCTURED_FIELDS),
    reqBool(s, at, 'relocationRequired'),
    reqBool(s, at, 'expensesCovered'),
    optIntIn(s, at, 'feeMinor', 0, Number.MAX_SAFE_INTEGER),
  );
  if (problem) return problem;
  if (!isStr(s.currency) || !CURRENCY.test(s.currency))
    return bad(at, 'currency', `must be a three-letter currency code such as GBP (got ${describe(s.currency)})`);
  const slots = typeSlots(s.trainingSlots, `${at}.trainingSlots`, L.trainingSlots, weekly);
  if (!slots.ok) return slots;
  const env = typeTexts(s.environment, `${at}.environment`, L.tags, L.tag);
  if (!env.ok) return env;
  const acc = typeTexts(s.accommodations, `${at}.accommodations`, L.accommodations, L.accommodation);
  if (!acc.ok) return acc;
  const v = s as StructuredRequirementsInput;
  return {
    ok: true,
    record: {
      trainingSlots: slots.list,
      relocationRequired: v.relocationRequired,
      feeMinor: orNull(v.feeMinor),
      currency: v.currency,
      expensesCovered: v.expensesCovered,
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
] as const satisfies readonly (keyof OpportunityFields)[];
export function typeOpportunity(raw: unknown, at = 'opportunities'): Typed<OpportunityFields> {
  if (!isPlainObject(raw)) return objectAt(raw, at);
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
  const elig = typeEligibility(raw.eligibility, `${label}.eligibility`, {
    withCategory: true,
  });
  if (!elig.ok) return elig;
  const reqs = typeTexts(raw.requirements ?? [], `${label}.requirements`, L.requirements, L.requirement);
  if (!reqs.ok) return reqs;
  let structured: StructuredFields | null = null;
  if (raw.structured !== undefined && raw.structured !== null) {
    const s = typeStructured(raw.structured, `${label}.structured`);
    if (!s.ok) return s;
    structured = s.record;
  }
  const o = raw as OpportunityInput;
  return {
    ok: true,
    record: {
      id: o.id,
      orgId: o.orgId,
      orgName: o.orgName,
      orgLevel: o.orgLevel,
      type: o.type,
      title: o.title,
      team: orNull(o.team),
      category: o.category,
      ageGroup: orNull(o.ageGroup),
      role: orNull(o.role),
      description: orNull(o.description),
      schedule: orNull(o.schedule),
      deadline: o.deadline,
      capacity: orNull(o.capacity),
      eligibility: elig.record,
      requirements: reqs.list,
      status: o.status,
      createdBy: o.createdBy,
      createdAt: o.createdAt,
      closedAt: orNull(o.closedAt),
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
] as const satisfies readonly (keyof ApplicationFields)[];
export function typeApplication(raw: unknown, at = 'applications'): Typed<ApplicationFields> {
  if (!isPlainObject(raw)) return objectAt(raw, at);
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
  let outcome: OutcomeFields | null = null;
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
    const v = o as ApplicationOutcomeInput;
    outcome = {
      decision: v.decision,
      note: orNull(v.note),
      byUserId: v.byUserId,
      byName: orNull(v.byName),
      at: v.at,
    };
  }
  const status = raw.status as ApplicationStatus;
  if ((status === 'accepted' || status === 'declined') !== (outcome !== null))
    return bad(
      label,
      'outcome',
      outcome ? 'belongs to an accepted or declined application only' : `is required on an ${status} application`,
    );
  if (outcome && outcome.decision !== status)
    return bad(label, 'outcome', `decision ${outcome.decision} disagrees with status ${status}`);
  let summary: SuitabilitySummaryFields | null = null;
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
    const seen = new Set<SuitabilityDimension>();
    const verdicts: VerdictFields[] = [];
    for (const [i, v] of s.verdicts.entries()) {
      if (
        !isPlainObject(v) ||
        !(SUITABILITY_DIMENSIONS as readonly unknown[]).includes(v.dimension) ||
        !(SUITABILITY_VERDICTS as readonly unknown[]).includes(v.verdict) ||
        Object.keys(v).some((k) => !['dimension', 'verdict'].includes(k))
      )
        return bad(
          sat,
          `verdicts[${i}]`,
          `must be {dimension: ${SUITABILITY_DIMENSIONS.join('|')}, verdict: ${SUITABILITY_VERDICTS.join('|')}}`,
        );
      const { dimension, verdict } = v as VerdictFields;
      if (seen.has(dimension)) return bad(sat, `verdicts[${i}]`, `repeats ${dimension}`);
      seen.add(dimension);
      verdicts.push({ dimension, verdict });
    }
    const v = s as SuitabilitySummaryInput;
    summary = { approvedAt: v.approvedAt, approvedBy: v.approvedBy, verdicts };
  }
  const history = typeList(raw.history, `${label}.history`, typeHistory);
  if (!history.ok) return history;
  const a = raw as ApplicationInput;
  return {
    ok: true,
    record: {
      id: a.id,
      opportunityId: a.opportunityId,
      orgId: a.orgId,
      playerId: a.playerId,
      playerName: orNull(a.playerName),
      submittedBy: by.record,
      note: orNull(a.note),
      status: a.status,
      outcome,
      createdAt: a.createdAt,
      remindedAt: orNull(a.remindedAt),
      suitabilitySummary: summary,
      history: history.list,
    },
  };
}
const DRILL_FIELDS = ['name', 'instructions', 'recording'] as const satisfies readonly (keyof DrillFields)[];
const RECORDING_FIELDS = [
  'equipment',
  'distance',
  'surface',
  'camera',
] as const satisfies readonly (keyof RecordingFields)[];
function typeDrill(d: unknown, at: string): Typed<DrillFields> {
  if (!isPlainObject(d)) return objectAt(d, at);
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
  const v = d as CampaignDrillInput;
  const rec = v.recording;
  return {
    ok: true,
    record: {
      name: v.name,
      instructions: v.instructions,
      recording: {
        equipment: rec.equipment,
        distance: rec.distance,
        surface: rec.surface,
        camera: rec.camera,
      },
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
] as const satisfies readonly (keyof CampaignFields)[];
export function typeCampaign(raw: unknown, at = 'campaigns'): Typed<CampaignFields> {
  if (!isPlainObject(raw)) return objectAt(raw, at);
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
  const drills: DrillFields[] = [];
  const names = new Set<string>();
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
  const rubric: RubricFields[] = [];
  for (const [i, r] of rubricIn.entries()) {
    const rat = `${label}.rubric[${i}]`;
    if (!isPlainObject(r)) return objectAt(r, rat);
    const p = first(
      unknownFields(r, rat, ['criterion', 'guidance']),
      reqText(r, rat, 'criterion', L.criterion),
      isStr(r.guidance)
        ? optText(r, rat, 'guidance', L.guidance)
        : bad(rat, 'guidance', `must be text (got ${describe(r.guidance)})`),
    );
    if (p) return p;
    const v = r as CampaignRubricInput;
    rubric.push({ criterion: v.criterion, guidance: v.guidance });
  }
  const elig = typeEligibility(raw.eligibility, `${label}.eligibility`, {
    withCategory: false,
  });
  if (!elig.ok) return elig;
  const c = raw as CampaignInput;
  return {
    ok: true,
    record: {
      id: c.id,
      orgId: c.orgId,
      orgName: c.orgName,
      title: c.title,
      drills,
      deadline: c.deadline,
      attemptsAllowed: c.attemptsAllowed,
      eligibility: elig.record,
      rubric,
      status: 'published',
      createdBy: c.createdBy,
      createdAt: c.createdAt,
    },
  };
}
const ATTEMPT_FIELDS = [
  'id',
  'mediaId',
  'drillName',
  'note',
  'fileChecks',
  'status',
  'review',
  'submittedAt',
] as const satisfies readonly (keyof AttemptFields)[];
function typeAttempt(a: unknown, at: string): Typed<AttemptFields> {
  if (!isPlainObject(a)) return objectAt(a, at);
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
  if (!Array.isArray(f.issues) || f.issues.some((x) => !isIssue(x)) || new Set(f.issues).size !== f.issues.length)
    return bad(fat, 'issues', 'must list distinct automated file-check messages');
  const checks = f as AttemptFileChecksInput;
  if (checks.passed !== (checks.issues.length === 0)) return bad(fat, 'passed', 'disagrees with the issues listed');
  if ((a.status === 'failed_checks') !== !checks.passed)
    return bad(at, 'status', `${a.status} disagrees with the file checks`);
  let review: ReviewFields | null = null;
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
    const v = r as AttemptReviewInput;
    review = {
      byUserId: v.byUserId,
      byName: orNull(v.byName),
      at: v.at,
      kind: 'human_review',
      reasons: orNull(v.reasons),
      rubricNotes: orNull(v.rubricNotes),
    };
  }
  if ((a.status === 'accepted' || a.status === 'returned') !== (review !== null))
    return bad(at, 'review', review ? 'belongs to a reviewed attempt only' : `is required on a ${a.status} attempt`);
  if (a.status === 'returned' && !nonEmpty(review?.reasons))
    return bad(at, 'review', 'a returned attempt carries its reasons');
  const v = a as CampaignAttemptInput;
  return {
    ok: true,
    record: {
      id: v.id,
      mediaId: orNull(v.mediaId),
      drillName: v.drillName,
      note: orNull(v.note),
      fileChecks: {
        passed: checks.passed,
        issues: [...checks.issues],
        checkedAt: checks.checkedAt,
        kind: 'automated_file_check',
      },
      status: v.status,
      review,
      submittedAt: v.submittedAt,
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
] as const satisfies readonly (keyof SubmissionFields)[];
export function typeSubmission(raw: unknown, at = 'campaignSubmissions'): Typed<SubmissionFields> {
  if (!isPlainObject(raw)) return objectAt(raw, at);
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
  const s = raw as CampaignSubmissionInput;
  return {
    ok: true,
    record: {
      id: s.id,
      campaignId: s.campaignId,
      orgId: s.orgId,
      playerId: s.playerId,
      playerName: orNull(s.playerName),
      submittedBy: by.record,
      attempts: attempts.list,
      createdAt: s.createdAt,
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
] as const satisfies readonly (keyof PreferencesFields)[];
export function typePreferences(raw: unknown, at = 'playerPrefs'): Typed<PreferencesFields> {
  if (!isPlainObject(raw)) return objectAt(raw, at);
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
  const commitments = typeSlots(raw.commitments, `${label}.commitments`, L.slots, labelled);
  if (!commitments.ok) return commitments;
  const available = typeSlots(raw.availableSlots, `${label}.availableSlots`, L.slots, labelled);
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
  const p = raw as PlayerPreferencesInput;
  const comp = c as CompensationInput;
  return {
    ok: true,
    record: {
      playerId: p.playerId,
      commitments: commitments.list,
      availableSlots: available.list,
      travelLimitKm: orNull(p.travelLimitKm),
      transport: orNull(p.transport),
      relocation: orNull(p.relocation),
      ambitions: orNull(p.ambitions),
      environment: env.list,
      accessibility: acc.list,
      compensation: {
        maxFeeMinor: orNull(comp.maxFeeMinor),
        currency: comp.currency,
        expensesNeeded: comp.expensesNeeded,
      },
      updatedAt: p.updatedAt,
    },
  };
}
/** A player's preferences before anything is saved (nothing is stored for them). */
export const blankPreferences = (playerId: string): BlankPreferences => ({
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
const TYPERS: {
  [N in OpportunitiesCampaignsCollection]: (raw: unknown, at: string) => Typed<FieldsOf[N]>;
} = {
  opportunities: typeOpportunity,
  applications: typeApplication,
  campaigns: typeCampaign,
  campaignSubmissions: typeSubmission,
  playerPrefs: typePreferences,
};

// ------------------------------------------------------------------ rows ↔ records
const b = (v: boolean | undefined) => (v ? 1 : 0);
const eligRow = (e: CampaignEligibilityFields) => ({
  elig_min_age: e.minAge,
  elig_max_age: e.maxAge,
  elig_position_group: e.positionGroup,
  elig_max_level: e.maxLevel,
  elig_radius_km: e.radiusKm,
});
const structuredCols = (s: StructuredFields | null) => ({
  structured_declared: b(!!s),
  relocation_required: b(s?.relocationRequired),
  fee_minor: s ? s.feeMinor : null,
  currency: s ? s.currency : null,
  expenses_covered: b(s?.expensesCovered),
});
const oppRow = (o: OpportunityFields) => ({
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
  ...structuredCols(o.structured),
});
type OppRow = RowOf<typeof oppRow>;
const oppSlotRow = (opportunityId: string, s: SlotFields, ordinal: number) => ({
  opportunity_id: opportunityId,
  ordinal,
  day: s.day,
  start_time: s.start,
  end_time: s.end,
  tz: s.tz,
});
type OppSlotRow = RowOf<typeof oppSlotRow>;
const oppTextRow = (opportunityId: string, kind: OpportunityTextKind, text: string, ordinal: number) => ({
  opportunity_id: opportunityId,
  kind,
  ordinal,
  text,
});
type OppTextRow = RowOf<typeof oppTextRow>;
const appRow = (a: ApplicationFields) => ({
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
type AppRow = RowOf<typeof appRow>;
const verdictRow = (applicationId: string, v: VerdictFields, ordinal: number) => ({
  application_id: applicationId,
  ordinal,
  dimension: v.dimension,
  verdict: v.verdict,
});
type VerdictRow = RowOf<typeof verdictRow>;
type AppHistRow = HistoryRow & { application_id: string };
const campRow = (c: CampaignFields) => ({
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
type CampRow = RowOf<typeof campRow>;
const drillRow = (campaignId: string, d: DrillFields, ordinal: number) => ({
  campaign_id: campaignId,
  ordinal,
  name: d.name,
  instructions: d.instructions,
  equipment: d.recording.equipment,
  distance: d.recording.distance,
  surface: d.recording.surface,
  camera: d.recording.camera,
});
type DrillRow = RowOf<typeof drillRow>;
const rubricRow = (campaignId: string, r: RubricFields, ordinal: number) => ({
  campaign_id: campaignId,
  ordinal,
  criterion: r.criterion,
  guidance: r.guidance,
});
type RubricRow = RowOf<typeof rubricRow>;
const subRow = (s: SubmissionFields) => ({
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
type SubRow = RowOf<typeof subRow>;
const attemptRow = (submissionId: string, a: AttemptFields, ordinal: number) => ({
  id: a.id,
  submission_id: submissionId,
  ordinal,
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
type AttemptRow = RowOf<typeof attemptRow>;
// The typer admits only the listed messages, so each has its code.
const issueRow = (attemptId: string, text: FileCheckIssue, ordinal: number) => ({
  attempt_id: attemptId,
  ordinal,
  issue: ISSUE_CODE.get(text) as FileCheckIssueCode,
});
type IssueRow = RowOf<typeof issueRow>;
const prefsRow = (p: PreferencesFields) => ({
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
type PrefsRow = RowOf<typeof prefsRow>;
const prefSlotRow = (playerId: string, kind: PrefSlotKind, s: LabelledSlotFields, ordinal: number) => ({
  player_id: playerId,
  kind,
  ordinal,
  day: s.day,
  start_time: s.start,
  end_time: s.end,
  tz: s.tz,
  label: s.label,
});
type PrefSlotRow = RowOf<typeof prefSlotRow>;
const prefTextRow = (playerId: string, kind: PrefTextKind, text: string, ordinal: number) => ({
  player_id: playerId,
  kind,
  ordinal,
  text,
});
type PrefTextRow = RowOf<typeof prefTextRow>;
const ELIG_COLS = ['elig_min_age', 'elig_max_age', 'elig_position_group', 'elig_max_level', 'elig_radius_km'] as const;
const OPP_COLS = columnsOf<OppRow>()([
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
  ...ELIG_COLS,
  'elig_category',
  'status',
  'created_by_name',
  'created_at',
  'closed_at',
  'structured_declared',
  'relocation_required',
  'fee_minor',
  'currency',
  'expenses_covered',
]);
const OPP_SLOT_COLS = columnsOf<OppSlotRow>()(['opportunity_id', 'ordinal', 'day', 'start_time', 'end_time', 'tz']);
const OPP_TEXT_COLS = columnsOf<OppTextRow>()(['opportunity_id', 'kind', 'ordinal', 'text']);
const APP_COLS = columnsOf<AppRow>()([
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
]);
const VERDICT_COLS = columnsOf<VerdictRow>()(['application_id', 'ordinal', 'dimension', 'verdict']);
const CAMP_COLS = columnsOf<CampRow>()([
  'id',
  'org_id',
  'org_name',
  'title',
  'deadline',
  'attempts_allowed',
  ...ELIG_COLS,
  'status',
  'created_by_name',
  'created_at',
]);
const DRILL_COLS = columnsOf<DrillRow>()([
  'campaign_id',
  'ordinal',
  'name',
  'instructions',
  'equipment',
  'distance',
  'surface',
  'camera',
]);
const RUBRIC_COLS = columnsOf<RubricRow>()(['campaign_id', 'ordinal', 'criterion', 'guidance']);
const SUB_COLS = columnsOf<SubRow>()([
  'id',
  'campaign_id',
  'org_id',
  'player_id',
  'player_name',
  'submitted_by_kind',
  'submitted_by_id',
  'submitted_by_name',
  'created_at',
]);
const ATTEMPT_COLS = columnsOf<AttemptRow>()([
  'id',
  'submission_id',
  'ordinal',
  'media_id',
  'drill_name',
  'note',
  'file_checks_passed',
  'file_checked_at',
  'status',
  'review_by_user_id',
  'review_by_name',
  'reviewed_at',
  'review_reasons',
  'review_rubric_notes',
  'submitted_at',
]);
const ISSUE_COLS = columnsOf<IssueRow>()(['attempt_id', 'ordinal', 'issue']);
const PREFS_COLS = columnsOf<PrefsRow>()([
  'player_id',
  'travel_limit_km',
  'transport',
  'relocation',
  'ambitions',
  'max_fee_minor',
  'currency',
  'expenses_needed',
  'updated_at',
]);
const PREF_SLOT_COLS = columnsOf<PrefSlotRow>()([
  'player_id',
  'kind',
  'ordinal',
  'day',
  'start_time',
  'end_time',
  'tz',
  'label',
]);
const PREF_TEXT_COLS = columnsOf<PrefTextRow>()(['player_id', 'kind', 'ordinal', 'text']);

/** Prepared statements over one connection. */
function statements(sqlite: DatabaseSync) {
  const p = (sql: string) => sqlite.prepare(sql);
  const childrenOf = (table: string, owner: string, order: string) =>
    p(`SELECT * FROM ${table} WHERE ${owner} IN (SELECT value FROM json_each(?)) ORDER BY ${owner}, ${order}`);
  return {
    opp: insertFor(sqlite, 'opportunities', OPP_COLS),
    oppById: p('SELECT * FROM opportunities WHERE id = ?'),
    oppSlot: insertFor(sqlite, 'opportunity_training_slots', OPP_SLOT_COLS),
    oppSlotsDel: p('DELETE FROM opportunity_training_slots WHERE opportunity_id = ?'),
    oppText: insertFor(sqlite, 'opportunity_texts', OPP_TEXT_COLS),
    oppStructuredTextsDel: p("DELETE FROM opportunity_texts WHERE opportunity_id = ? AND kind <> 'requirement'"),
    oppSlotsOf: childrenOf('opportunity_training_slots', 'opportunity_id', 'ordinal'),
    oppTextsOf: childrenOf('opportunity_texts', 'opportunity_id', 'kind, ordinal'),
    app: insertFor(sqlite, 'applications', APP_COLS),
    appById: p('SELECT * FROM applications WHERE id = ?'),
    appVerdict: insertFor(sqlite, 'application_suitability', VERDICT_COLS),
    appVerdictsDel: p('DELETE FROM application_suitability WHERE application_id = ?'),
    appHist: p(historyOf('application_history', 'application_id').insert),
    appVerdictsOf: childrenOf('application_suitability', 'application_id', 'ordinal'),
    appHistOf: childrenOf('application_history', 'application_id', 'position'),
    camp: insertFor(sqlite, 'campaigns', CAMP_COLS),
    campById: p('SELECT * FROM campaigns WHERE id = ?'),
    drill: insertFor(sqlite, 'campaign_drills', DRILL_COLS),
    rubric: insertFor(sqlite, 'campaign_rubric', RUBRIC_COLS),
    drillsOf: childrenOf('campaign_drills', 'campaign_id', 'ordinal'),
    rubricOf: childrenOf('campaign_rubric', 'campaign_id', 'ordinal'),
    sub: insertFor(sqlite, 'campaign_submissions', SUB_COLS),
    subById: p('SELECT * FROM campaign_submissions WHERE id = ?'),
    attempt: insertFor(sqlite, 'campaign_attempts', ATTEMPT_COLS),
    issue: insertFor(sqlite, 'campaign_attempt_issues', ISSUE_COLS),
    attemptsOf: childrenOf('campaign_attempts', 'submission_id', 'ordinal'),
    issuesOf: p(
      'SELECT i.* FROM campaign_attempt_issues i JOIN campaign_attempts a ON a.id = i.attempt_id WHERE a.submission_id IN (SELECT value FROM json_each(?)) ORDER BY i.attempt_id, i.ordinal',
    ),
    attemptOwner: p('SELECT submission_id FROM campaign_attempts WHERE id = ?'),
    // A player has one row of preferences; saving again replaces it.
    prefs: insertFor(sqlite, 'player_prefs', PREFS_COLS, {
      upsert: ['player_id'],
    }),
    prefsOf: p('SELECT * FROM player_prefs WHERE player_id = ?'),
    prefSlot: insertFor(sqlite, 'player_pref_slots', PREF_SLOT_COLS),
    prefSlotsDel: p('DELETE FROM player_pref_slots WHERE player_id = ?'),
    prefText: insertFor(sqlite, 'player_pref_texts', PREF_TEXT_COLS),
    prefTextsDel: p('DELETE FROM player_pref_texts WHERE player_id = ?'),
    prefSlotsOf: p('SELECT * FROM player_pref_slots WHERE player_id = ? ORDER BY kind, ordinal'),
    prefTextsOf: p('SELECT * FROM player_pref_texts WHERE player_id = ? ORDER BY kind, ordinal'),
  };
}
type Statements = ReturnType<typeof statements>;

function writeOpportunity(st: Statements, o: OpportunityFields) {
  st.opp.run(oppRow(o));
  o.requirements.forEach((t, i) => st.oppText.run(oppTextRow(o.id, 'requirement', t, i)));
  writeStructuredRows(st, o.id, o.structured);
}
/** The structured requirements' child rows: the training slots, the environment and the accommodations. */
function writeStructuredRows(st: Statements, id: string, s: StructuredFields | null) {
  (s?.trainingSlots ?? []).forEach((x, i) => st.oppSlot.run(oppSlotRow(id, x, i)));
  (s?.environment ?? []).forEach((t, i) => st.oppText.run(oppTextRow(id, 'environment', t, i)));
  (s?.accommodations ?? []).forEach((t, i) => st.oppText.run(oppTextRow(id, 'accommodation', t, i)));
}
function writeApplication(st: Statements, a: ApplicationFields) {
  st.app.run(appRow(a));
  writeVerdicts(st, a.id, a.suitabilitySummary);
  a.history.forEach((h, i) => st.appHist.run(histRow(a.id, h, i)));
}
function writeVerdicts(st: Statements, id: string, summary: SuitabilitySummaryFields | null) {
  (summary?.verdicts ?? []).forEach((v, i) => st.appVerdict.run(verdictRow(id, v, i)));
}
function writeCampaign(st: Statements, c: CampaignFields) {
  st.camp.run(campRow(c));
  c.drills.forEach((d, i) => st.drill.run(drillRow(c.id, d, i)));
  c.rubric.forEach((r, i) => st.rubric.run(rubricRow(c.id, r, i)));
}
function writeSubmission(st: Statements, s: SubmissionFields) {
  st.sub.run(subRow(s));
  s.attempts.forEach((a, i) => writeAttempt(st, s.id, a, i));
}
function writeAttempt(st: Statements, submissionId: string, a: AttemptFields, ordinal: number) {
  st.attempt.run(attemptRow(submissionId, a, ordinal));
  a.fileChecks.issues.forEach((text, j) => st.issue.run(issueRow(a.id, text, j)));
}
function writePreferences(st: Statements, p: PreferencesFields) {
  st.prefs.run(prefsRow(p));
  st.prefSlotsDel.run(p.playerId);
  st.prefTextsDel.run(p.playerId);
  p.commitments.forEach((s, i) => st.prefSlot.run(prefSlotRow(p.playerId, 'commitment', s, i)));
  p.availableSlots.forEach((s, i) => st.prefSlot.run(prefSlotRow(p.playerId, 'available', s, i)));
  p.environment.forEach((t, i) => st.prefText.run(prefTextRow(p.playerId, 'environment', t, i)));
  p.accessibility.forEach((t, i) => st.prefText.run(prefTextRow(p.playerId, 'accessibility', t, i)));
}

/** Group child rows by their owner column, one query for the whole list. */
const groupBy = <R, K extends keyof R>(rows: R[], key: K): Map<R[K], R[]> => {
  const m = new Map<R[K], R[]>();
  for (const r of rows) {
    const list = m.get(r[key]);
    if (list) list.push(r);
    else m.set(r[key], [r]);
  }
  return m;
};
const childRows = <R>(stmt: StatementSync, ids: string) => stmt.all(ids) as R[];
const idsOf = (rows: readonly { id: string }[]) => JSON.stringify(rows.map((r) => r.id));
const campaignEligOut = (r: CampRow | OppRow): CampaignEligibilityFields => ({
  minAge: r.elig_min_age,
  maxAge: r.elig_max_age,
  positionGroup: r.elig_position_group,
  maxLevel: r.elig_max_level,
  radiusKm: r.elig_radius_km,
});
const opportunityEligOut = (r: OppRow): OpportunityEligibilityFields => ({
  minAge: r.elig_min_age,
  maxAge: r.elig_max_age,
  positionGroup: r.elig_position_group,
  category: r.elig_category,
  maxLevel: r.elig_max_level,
  radiusKm: r.elig_radius_km,
});
const slotOut = (s: OppSlotRow | PrefSlotRow): SlotFields => ({
  day: s.day,
  start: s.start_time,
  end: s.end_time,
  tz: s.tz,
});
function decodeOpportunities(st: Statements, rows: OppRow[]): OpportunityFields[] {
  if (!rows.length) return [];
  const json = idsOf(rows);
  const slots = groupBy(childRows<OppSlotRow>(st.oppSlotsOf, json), 'opportunity_id');
  const texts = groupBy(childRows<OppTextRow>(st.oppTextsOf, json), 'opportunity_id');
  return rows.map((r) => {
    const t = texts.get(r.id) ?? [];
    const of = (kind: OpportunityTextKind) => t.filter((x) => x.kind === kind).map((x) => x.text);
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
      eligibility: opportunityEligOut(r),
      requirements: of('requirement'),
      status: r.status,
      createdBy: r.created_by_name,
      createdAt: r.created_at,
      closedAt: r.closed_at,
      // A declared structure always has its currency (a CHECK), so the column is set here.
      structured: r.structured_declared
        ? {
            trainingSlots: (slots.get(r.id) ?? []).map(slotOut),
            relocationRequired: !!r.relocation_required,
            feeMinor: r.fee_minor,
            currency: r.currency as string,
            expensesCovered: !!r.expenses_covered,
            environment: of('environment'),
            accommodations: of('accommodation'),
          }
        : null,
    };
  });
}
function decodeApplications(st: Statements, rows: AppRow[]): ApplicationFields[] {
  if (!rows.length) return [];
  const json = idsOf(rows);
  const verdicts = groupBy(childRows<VerdictRow>(st.appVerdictsOf, json), 'application_id');
  const hist = groupBy(childRows<AppHistRow>(st.appHistOf, json), 'application_id');
  // The columns' CHECKs pair an outcome with an answered status and its user, and an approval with its approver.
  return rows.map((r) => ({
    id: r.id,
    opportunityId: r.opportunity_id,
    orgId: r.org_id,
    playerId: r.player_id,
    playerName: r.player_name,
    submittedBy: {
      kind: r.submitted_by_kind,
      id: r.submitted_by_id,
      name: r.submitted_by_name,
    },
    note: r.note,
    status: r.status,
    outcome:
      r.outcome_at === null
        ? null
        : {
            decision: r.status as ApplicationDecision,
            note: r.outcome_note,
            byUserId: r.outcome_by_user_id as string,
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
            approvedBy: r.suitability_approved_by as ActorKind,
            verdicts: (verdicts.get(r.id) ?? []).map((v) => ({
              dimension: v.dimension,
              verdict: v.verdict,
            })),
          },
    history: (hist.get(r.id) ?? []).map(histOut),
  }));
}
function decodeCampaigns(st: Statements, rows: CampRow[]): CampaignFields[] {
  if (!rows.length) return [];
  const json = idsOf(rows);
  const drills = groupBy(childRows<DrillRow>(st.drillsOf, json), 'campaign_id');
  const rubric = groupBy(childRows<RubricRow>(st.rubricOf, json), 'campaign_id');
  return rows.map((r) => ({
    id: r.id,
    orgId: r.org_id,
    orgName: r.org_name,
    title: r.title,
    drills: (drills.get(r.id) ?? []).map((d) => ({
      name: d.name,
      instructions: d.instructions,
      recording: {
        equipment: d.equipment,
        distance: d.distance,
        surface: d.surface,
        camera: d.camera,
      },
    })),
    deadline: r.deadline,
    attemptsAllowed: r.attempts_allowed,
    eligibility: campaignEligOut(r),
    rubric: (rubric.get(r.id) ?? []).map((x) => ({
      criterion: x.criterion,
      guidance: x.guidance,
    })),
    status: r.status,
    createdBy: r.created_by_name,
    createdAt: r.created_at,
  }));
}
function decodeSubmissions(st: Statements, rows: SubRow[]): SubmissionFields[] {
  if (!rows.length) return [];
  const json = idsOf(rows);
  const attempts = groupBy(childRows<AttemptRow>(st.attemptsOf, json), 'submission_id');
  const issues = groupBy(childRows<IssueRow>(st.issuesOf, json), 'attempt_id');
  return rows.map((r) => ({
    id: r.id,
    campaignId: r.campaign_id,
    orgId: r.org_id,
    playerId: r.player_id,
    playerName: r.player_name,
    submittedBy: {
      kind: r.submitted_by_kind,
      id: r.submitted_by_id,
      name: r.submitted_by_name,
    },
    attempts: (attempts.get(r.id) ?? []).map((a) => ({
      id: a.id,
      mediaId: a.media_id,
      drillName: a.drill_name,
      note: a.note,
      fileChecks: {
        passed: !!a.file_checks_passed,
        issues: (issues.get(a.id) ?? []).map((i) => FILE_CHECK_ISSUES[i.issue]),
        checkedAt: a.file_checked_at,
        kind: 'automated_file_check' as const,
      },
      status: a.status,
      // A review's time and reviewer are set together (a CHECK).
      review:
        a.reviewed_at === null
          ? null
          : {
              byUserId: a.review_by_user_id as string,
              byName: a.review_by_name,
              at: a.reviewed_at,
              kind: 'human_review' as const,
              reasons: a.review_reasons,
              rubricNotes: a.review_rubric_notes,
            },
      submittedAt: a.submitted_at,
    })),
    createdAt: r.created_at,
  }));
}
function decodePreferences(st: Statements, r: PrefsRow): PreferencesFields {
  const slots = st.prefSlotsOf.all(r.player_id) as PrefSlotRow[];
  const texts = st.prefTextsOf.all(r.player_id) as PrefTextRow[];
  const slotsOf = (kind: PrefSlotKind) =>
    slots.filter((s) => s.kind === kind).map((s) => ({ ...slotOut(s), label: s.label }));
  const of = (kind: PrefTextKind) => texts.filter((t) => t.kind === kind).map((t) => t.text);
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
    compensation: {
      maxFeeMinor: r.max_fee_minor,
      currency: r.currency,
      expensesNeeded: !!r.expenses_needed,
    },
    updatedAt: r.updated_at,
  };
}

export const opportunitiesCampaignsLive = (sqlite: DatabaseSync) =>
  migrationApplied(sqlite, OPPORTUNITIES_CAMPAIGNS_MIGRATION);
const PLAYER_REFS_SQL =
  'SELECT player_id AS pid FROM applications UNION ALL SELECT player_id FROM campaign_submissions UNION ALL SELECT player_id FROM player_prefs';
type PlayerRefCounts = { rows: number };
const playerRefCounts = (sqlite: DatabaseSync, cond: string): PlayerRefCounts => ({
  rows: (sqlite.prepare(`SELECT count(*) AS n FROM (${PLAYER_REFS_SQL}) x WHERE ${cond}`).get() as { n: number }).n,
});
export const unresolvedPlayerReferences = (sqlite: DatabaseSync): PlayerRefCounts | null =>
  opportunitiesCampaignsLive(sqlite)
    ? playerRefCounts(sqlite, 'NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid)')
    : null;
export const retainedPlayerReferences = (sqlite: DatabaseSync): PlayerRefCounts | null =>
  opportunitiesCampaignsLive(sqlite)
    ? playerRefCounts(sqlite, 'EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid AND p.deleted_at IS NOT NULL)')
    : null;

function readAll(sqlite: DatabaseSync): OpportunitiesCampaignsRecords {
  const st = statements(sqlite);
  const all = <R>(t: OpportunitiesCampaignsTable) => sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all() as R[];
  return {
    opportunities: decodeOpportunities(st, all<OppRow>('opportunities')),
    applications: decodeApplications(st, all<AppRow>('applications')),
    campaigns: decodeCampaigns(st, all<CampRow>('campaigns')),
    campaignSubmissions: decodeSubmissions(st, all<SubRow>('campaign_submissions')),
    playerPrefs: all<PrefsRow>('player_prefs').map((r) => decodePreferences(st, r)),
  };
}

/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const OPPORTUNITIES_CAMPAIGNS_RECORDS = {
  names: OPPORTUNITIES_CAMPAIGNS_COLLECTIONS,
  read(sqlite: DatabaseSync): OpportunitiesCampaignsRecords | null {
    return opportunitiesCampaignsLive(sqlite) ? readAll(sqlite) : null;
  },
};

// ------------------------------------------------------------------ the repository
/** A page of a club's records, newest first: `after` is the previous page's last key. */
type CursorPageRequest = { limit: number; after?: readonly [number] | null };
type Counts<K extends string> = Record<string, Record<K, number>>;
/**
 * `createOpportunitiesCampaignsRepository({ sqlite, unit, now, log })`: `opportunities`, `applications`, `campaigns`,
 * `submissions` and `preferences`, each with its writes and queries, plus `reads` (the queries alone, for
 * `scoutingReads`).
 */
export function createOpportunitiesCampaignsRepository(
  {
    sqlite,
    unit = null,
    now = Date.now,
    log = () => {},
  }: {
    sqlite: DatabaseSync;
    unit?: UnitParticipant | null;
    now?: () => number;
    log?: (message: string) => void;
  } = {} as { sqlite: DatabaseSync },
) {
  if (!sqlite)
    throw new TypeError('the opportunities and campaigns repository needs a SQLite connection (node:sqlite)');
  const st = statements(sqlite);
  const operation = operationOn(sqlite, unit);
  const typedOr = <N extends OpportunitiesCampaignsCollection>(name: N, raw: unknown): FieldsOf[N] => {
    const t = TYPERS[name](raw, name);
    if (!t.ok) throw refusal('OPPORTUNITIES_CAMPAIGNS_INPUT_INVALID', t.reason);
    return t.record;
  };
  const q = (sql: string) => sqlite.prepare(sql);
  type Decode<R, T> = (st: Statements, rows: R[]) => T[];
  const frozen = <T>(list: T[]) => list.map((r) => deepFreeze(r));
  const one = <R, T>(decode: Decode<R, T>, row: unknown): DeepReadonly<T> | null =>
    row ? deepFreeze(decode(st, [row as R])[0]) : null;
  const byIdOf =
    <R, T>(stmt: StatementSync, decode: Decode<R, T>) =>
    (id: unknown): DeepReadonly<T> | null =>
      typeof id === 'string' ? one(decode, stmt.get(id)) : null;
  const mustOf =
    <T>(name: string, byId: (id: unknown) => T | null) =>
    (id: string): T => {
      const r = byId(id);
      if (!r) throw refusal('OPPORTUNITIES_CAMPAIGNS_NOT_FOUND', `${name} ${id} is not a record of the repository`);
      return r;
    };
  const pageOf = <R, T>(
    stmt: StatementSync,
    decode: Decode<R, T>,
    orgId: string,
    { limit, after = null }: CursorPageRequest,
  ) => {
    const rows = stmt.all(orgId, after?.[0] ?? null, after?.[0] ?? null, limit + 1) as (R & { rid: number })[];
    const decoded = decode(st, rows);
    return rows.map((r, i) => ({
      key: [r.rid] as [number],
      record: deepFreeze(decoded[i]),
    }));
  };

  const { guarded, actsOn } = writeKit(sqlite, 'OPPORTUNITIES_CAMPAIGNS');
  /** The record as an act leaves it, typed whole: the act's fields are judged with the rest. */
  const typedWith = <N extends OpportunitiesCampaignsCollection>(name: N, stored: RecordOf[N], fields: object) =>
    typedOr(name, { ...clone(stored), ...fields });

  // ---- opportunities
  const opportunityById = byIdOf(st.oppById, decodeOpportunities);
  const mustOpportunity = mustOf<Opportunity>('opportunities', opportunityById);
  const opportunityActs = actsOn(
    { operation, label: 'opportunities', must: mustOpportunity },
    {
      /** Close a published opportunity at `at`, once. */
      close: (id: string, { at }: { at: number }) =>
        guarded(
          'opportunities',
          { id },
          "status = 'published'",
          { status: 'closed', closed_at: at },
          `opportunities ${id} is already closed`,
        ),
      /** Replace the structured requirements (or remove them with null). */
      setStructured: (
        id: string,
        { structured }: { structured: StructuredRequirementsInput | null },
        stored: Opportunity,
      ) => {
        const s = typedWith('opportunities', stored, { structured }).structured;
        guarded('opportunities', { id }, '', structuredCols(s), `opportunities ${id} is not stored`);
        st.oppSlotsDel.run(id);
        st.oppStructuredTextsDel.run(id);
        writeStructuredRows(st, id, s);
      },
    },
  );
  const oppPage = q(
    'SELECT rowid AS rid, * FROM opportunities WHERE org_id = ? AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?',
  );
  const oppOpen = q(
    "SELECT * FROM opportunities WHERE status = 'published' AND deadline >= ? ORDER BY deadline, rowid",
  );
  const appCounts = q(
    "SELECT opportunity_id AS id, SUM(status <> 'withdrawn') AS live, SUM(status = 'submitted') AS outstanding FROM applications WHERE opportunity_id IN (SELECT value FROM json_each(?)) GROUP BY opportunity_id",
  );
  const opportunityWrites = {
    create: (raw: OpportunityInput): Opportunity =>
      operation(() => {
        const o = typedOr('opportunities', raw);
        if (st.oppById.get(o.id))
          throw refusal('OPPORTUNITIES_CAMPAIGNS_DUPLICATE', `opportunities ${o.id} already exists`);
        writeOpportunity(st, o);
        return opportunityById(o.id) as Opportunity;
      }),
    ...opportunityActs,
  };
  const opportunities = {
    ...opportunityWrites,
    byId: opportunityById,
    /** The opportunity `id` if it belongs to `orgId`, else null. */
    ofOrg: (id: unknown, orgId: string): Opportunity | null => {
      const o = opportunityById(id);
      return o && o.orgId === orgId ? o : null;
    },
    /** Published opportunities whose deadline is `today` or later, soonest first (the board narrows further in code). */
    openOn: (today: string): Opportunity[] => frozen(decodeOpportunities(st, oppOpen.all(today) as OppRow[])),
    /** The club's opportunities, newest first, by cursor (`after` is the previous page's last `[rowid]`). */
    page(orgId: string, request: CursorPageRequest): { rows: { key: [number]; opportunity: Opportunity }[] } {
      return {
        rows: pageOf(oppPage, decodeOpportunities, orgId, request).map(({ key, record }) => ({
          key,
          opportunity: record,
        })),
      };
    },
    /** `{ [id]: { applications, outstanding } }`: live (not withdrawn) and unanswered applications per opportunity. */
    applicationCounts(oppIds: readonly string[]): Counts<'applications' | 'outstanding'> {
      const out: Counts<'applications' | 'outstanding'> = Object.fromEntries(
        oppIds.map((id) => [id, { applications: 0, outstanding: 0 }]),
      );
      for (const r of appCounts.all(JSON.stringify(oppIds)) as {
        id: string;
        live: number;
        outstanding: number;
      }[])
        out[r.id] = { applications: r.live, outstanding: r.outstanding };
      return out;
    },
  };

  // ---- applications
  const applicationById = byIdOf(st.appById, decodeApplications);
  const mustApplication = mustOf<Application>('applications', applicationById);
  const OUTSTANDING = "status = 'submitted'";
  const applicationActs = actsOn(
    {
      operation,
      label: 'applications',
      must: mustApplication,
      history: historyOf('application_history', 'application_id'),
    },
    {
      /** The applicant withdraws an unanswered application. */
      withdraw: (id: string, _input: Record<string, never>) =>
        guarded('applications', { id }, OUTSTANDING, { status: 'withdrawn' }, `applications ${id} is not outstanding`),
      /** The club answers an outstanding application, once (`decision` is accepted or declined). */
      decide: (
        id: string,
        { decision, note = null, byUserId, byName, at }: ApplicationDecisionInput,
        stored: Application,
      ) => {
        typedWith('applications', stored, {
          status: decision,
          outcome: { decision, note, byUserId, byName, at },
        });
        guarded(
          'applications',
          { id },
          OUTSTANDING,
          {
            status: decision,
            outcome_note: note,
            outcome_by_user_id: byUserId,
            outcome_by_name: byName,
            outcome_at: at,
          },
          `applications ${id} is not outstanding`,
        );
      },
      /** The week-old reminder went out at `at`; it goes once. */
      markReminded: (id: string, { at }: { at: number }) =>
        guarded(
          'applications',
          { id },
          'reminded_at IS NULL',
          { reminded_at: at },
          `applications ${id} was already reminded`,
        ),
      /** The player or guardian approves this suitability summary onto the application, replacing any earlier one. */
      shareSuitability: (id: string, { summary }: { summary: SuitabilitySummaryInput }, stored: Application) => {
        const s = typedWith('applications', stored, {
          suitabilitySummary: summary,
        }).suitabilitySummary;
        guarded(
          'applications',
          { id },
          '',
          {
            suitability_approved_at: summary.approvedAt,
            suitability_approved_by: summary.approvedBy,
          },
          `applications ${id} is not stored`,
        );
        st.appVerdictsDel.run(id);
        writeVerdicts(st, id, s);
      },
      /** The player or guardian takes the summary back. */
      unshareSuitability: (id: string) => {
        guarded(
          'applications',
          { id },
          '',
          { suitability_approved_at: null, suitability_approved_by: null },
          `applications ${id} is not stored`,
        );
        st.appVerdictsDel.run(id);
      },
    },
  );
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
  const applicationWrites = {
    create: (raw: ApplicationInput): Application =>
      operation(() => {
        const a = typedOr('applications', raw);
        if (st.appById.get(a.id))
          throw refusal('OPPORTUNITIES_CAMPAIGNS_DUPLICATE', `applications ${a.id} already exists`);
        const o = st.oppById.get(a.opportunityId) as OppRow | undefined;
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
        return applicationById(a.id) as Application;
      }),
    ...applicationActs,
  };
  const applications = {
    ...applicationWrites,
    byId: applicationById,
    ofOrg: (id: unknown, orgId: string): Application | null => {
      const a = applicationById(id);
      return a && a.orgId === orgId ? a : null;
    },
    /** The application `id` if it is one of `playerIds`', else null. */
    ofPlayers: (id: unknown, playerIds: readonly string[]): Application | null => {
      const a = applicationById(id);
      return a && playerIds.includes(a.playerId) ? a : null;
    },
    forPlayers: (playerIds: readonly string[]): Application[] =>
      frozen(decodeApplications(st, appsOfPlayer.all(JSON.stringify(playerIds)) as AppRow[])),
    forOpportunity: (oppId: string): Application[] => frozen(decodeApplications(st, appsOfOpp.all(oppId) as AppRow[])),
    /** One opportunity's applications by offset, oldest first (the club list's shape), `{ total, items }`. */
    pageForOpportunity: (
      oppId: string,
      { limit, offset }: { limit: number; offset: number },
    ): { total: number; items: Application[] } => ({
      total: (appsOfOppCount.get(oppId) as { n: number }).n,
      items: frozen(decodeApplications(st, appsOfOppPage.all(oppId, limit, offset) as AppRow[])),
    }),
    /** The player's application to the opportunity that is not withdrawn, or null. */
    liveFor: (oppId: string, playerId: string): Application | null =>
      one(decodeApplications, appLive.get(oppId, playerId)),
    /** Unanswered applications submitted before `cutoff` that were never reminded (the sweep). */
    remindersDue: (cutoff: number): Application[] =>
      frozen(decodeApplications(st, appReminders.all(cutoff) as AppRow[])),
  };

  // ---- campaigns and submissions
  const campaignById = byIdOf(st.campById, decodeCampaigns);
  const campPage = q(
    'SELECT rowid AS rid, * FROM campaigns WHERE org_id = ? AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?',
  );
  const campOpen = q("SELECT * FROM campaigns WHERE status = 'published' AND deadline >= ? ORDER BY rowid");
  const subCounts = q(`SELECT s.campaign_id AS id, COUNT(*) AS submissions,
      SUM(EXISTS (SELECT 1 FROM campaign_attempts a WHERE a.submission_id = s.id AND a.status = 'submitted')) AS awaiting
    FROM campaign_submissions s WHERE s.campaign_id IN (SELECT value FROM json_each(?)) GROUP BY s.campaign_id`);
  const campaignWrites = {
    create: (raw: CampaignInput): Campaign =>
      operation(() => {
        const c = typedOr('campaigns', raw);
        if (st.campById.get(c.id))
          throw refusal('OPPORTUNITIES_CAMPAIGNS_DUPLICATE', `campaigns ${c.id} already exists`);
        writeCampaign(st, c);
        return campaignById(c.id) as Campaign;
      }),
  };
  const campaigns = {
    ...campaignWrites,
    byId: campaignById,
    ofOrg: (id: unknown, orgId: string): Campaign | null => {
      const c = campaignById(id);
      return c && c.orgId === orgId ? c : null;
    },
    /** Published campaigns whose deadline is `today` or later. */
    openOn: (today: string): Campaign[] => frozen(decodeCampaigns(st, campOpen.all(today) as CampRow[])),
    page(orgId: string, request: CursorPageRequest): { rows: { key: [number]; campaign: Campaign }[] } {
      return {
        rows: pageOf(campPage, decodeCampaigns, orgId, request).map(({ key, record }) => ({ key, campaign: record })),
      };
    },
    /** `{ [id]: { submissions, awaitingReview } }`: submissions, and those with an attempt waiting for a human review. */
    submissionCounts(campIds: readonly string[]): Counts<'submissions' | 'awaitingReview'> {
      const out: Counts<'submissions' | 'awaitingReview'> = Object.fromEntries(
        campIds.map((id) => [id, { submissions: 0, awaitingReview: 0 }]),
      );
      for (const r of subCounts.all(JSON.stringify(campIds)) as {
        id: string;
        submissions: number;
        awaiting: number;
      }[])
        out[r.id] = { submissions: r.submissions, awaitingReview: r.awaiting };
      return out;
    },
  };

  const submissionById = byIdOf(st.subById, decodeSubmissions);
  const mustSubmission = mustOf<CampaignSubmission>('campaignSubmissions', submissionById);
  const attemptExists = (attemptId: string) => !!st.attemptOwner.get(attemptId);
  const submissionActs = actsOn(
    { operation, label: 'campaignSubmissions', must: mustSubmission },
    {
      /** A new attempt, after the stored ones. */
      addAttempt: (id: string, { attempt }: { attempt: CampaignAttemptInput }, stored: CampaignSubmission) => {
        const next = typedWith('campaignSubmissions', stored, {
          attempts: [...stored.attempts, attempt],
        });
        // The typer has judged the new attempt, so it is the last one typed.
        const typed = next.attempts[next.attempts.length - 1];
        if (attemptExists(typed.id))
          throw refusal('OPPORTUNITIES_CAMPAIGNS_DUPLICATE', `campaign attempt ${typed.id} already exists`);
        writeAttempt(st, id, typed, stored.attempts.length);
      },
      /** A person reviews an attempt waiting for review, once (`decision` is accepted or returned). */
      reviewAttempt: (
        id: string,
        { attemptId, decision, review }: AttemptReviewDecision,
        stored: CampaignSubmission,
      ) => {
        typedWith('campaignSubmissions', stored, {
          attempts: stored.attempts.map((a) => (a.id === attemptId ? { ...a, status: decision, review } : a)),
        });
        guarded(
          'campaign_attempts',
          { id: attemptId, submission_id: id },
          "status = 'submitted'",
          {
            status: decision,
            review_by_user_id: review.byUserId,
            review_by_name: review.byName,
            reviewed_at: review.at,
            review_reasons: review.reasons ?? null,
            review_rubric_notes: review.rubricNotes ?? null,
          },
          `campaign attempt ${attemptId} of ${id} is not waiting for review`,
        );
      },
    },
  );
  const subsOfCamp = q('SELECT * FROM campaign_submissions WHERE campaign_id = ? ORDER BY rowid');
  const subOf = q('SELECT * FROM campaign_submissions WHERE campaign_id = ? AND player_id = ?');
  const subsOfPlayer = q('SELECT * FROM campaign_submissions WHERE player_id = ? ORDER BY rowid');
  const submissionWrites = {
    create: (raw: CampaignSubmissionInput): CampaignSubmission =>
      operation(() => {
        const s = typedOr('campaignSubmissions', raw);
        if (st.subById.get(s.id))
          throw refusal('OPPORTUNITIES_CAMPAIGNS_DUPLICATE', `campaignSubmissions ${s.id} already exists`);
        const c = st.campById.get(s.campaignId) as CampRow | undefined;
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
          if (attemptExists(a.id))
            throw refusal('OPPORTUNITIES_CAMPAIGNS_DUPLICATE', `campaign attempt ${a.id} already exists`);
        writeSubmission(st, s);
        return submissionById(s.id) as CampaignSubmission;
      }),
    ...submissionActs,
  };
  const submissions = {
    ...submissionWrites,
    byId: submissionById,
    forCampaign: (campaignId: string): CampaignSubmission[] =>
      frozen(decodeSubmissions(st, subsOfCamp.all(campaignId) as SubRow[])),
    /** The player's submission to the campaign, or null. */
    forCampaignPlayer: (campaignId: string, playerId: string): CampaignSubmission | null =>
      one(decodeSubmissions, subOf.get(campaignId, playerId)),
    forPlayer: (playerId: string): CampaignSubmission[] =>
      frozen(decodeSubmissions(st, subsOfPlayer.all(playerId) as SubRow[])),
    /** The submission holding attempt `attemptId`, or null. */
    byAttempt: (attemptId: unknown): CampaignSubmission | null => {
      const o =
        typeof attemptId === 'string'
          ? (st.attemptOwner.get(attemptId) as { submission_id: string } | undefined)
          : undefined;
      return o ? submissionById(o.submission_id) : null;
    },
  };

  // ---- preferences
  const preferencesOf = (playerId: unknown): PlayerPreferences | null => {
    const r = typeof playerId === 'string' ? (st.prefsOf.get(playerId) as PrefsRow | undefined) : undefined;
    return r ? deepFreeze(decodePreferences(st, r)) : null;
  };
  const preferenceWrites = {
    /** Save the player's whole preferences (one row per player). Returns the stored record. */
    save: (raw: PlayerPreferencesInput): PlayerPreferences =>
      operation(() => {
        const p = typedOr('playerPrefs', raw);
        writePreferences(st, p);
        return preferencesOf(p.playerId) as PlayerPreferences;
      }),
  };
  const preferences = {
    ...preferenceWrites,
    /** The player's saved preferences, or null when nothing was ever saved. */
    forPlayer: preferencesOf,
  };

  const writeKeys = <T extends object>(_repo: T, w: object) => Object.keys(w) as (keyof T)[];
  const counters = Object.fromEntries(
    OPPORTUNITIES_CAMPAIGNS_TABLES.map((t) => [t, q(`SELECT COUNT(*) AS n FROM ${t}`)]),
  ) as Record<OpportunitiesCampaignsTable, StatementSync>;
  return {
    opportunities,
    applications,
    campaigns,
    submissions,
    preferences,
    /** The queries alone, for modules and projectors that must not write (`scoutingReads`). */
    reads: Object.freeze({
      opportunities: readsOf(opportunities, writeKeys(opportunities, opportunityWrites)),
      applications: readsOf(applications, writeKeys(applications, applicationWrites)),
      campaigns: readsOf(campaigns, writeKeys(campaigns, campaignWrites)),
      campaignSubmissions: readsOf(submissions, writeKeys(submissions, submissionWrites)),
      playerPrefs: readsOf(preferences, writeKeys(preferences, preferenceWrites)),
    }),
    attach() {
      if (!opportunitiesCampaignsLive(sqlite))
        throw new Error(
          `the opportunities and campaigns repository needs ${OPPORTUNITIES_CAMPAIGNS_MIGRATION} recorded; it never imports an in-memory array`,
        );
      return { counts: this.counts() };
    },
    counts(): Record<OpportunitiesCampaignsTable, number> {
      return Object.fromEntries(
        OPPORTUNITIES_CAMPAIGNS_TABLES.map((t) => [t, (counters[t].get() as { n: number }).n]),
      ) as Record<OpportunitiesCampaignsTable, number>;
    },
    pending: () => 0,
    exportAll(): OpportunitiesCampaignsRecords | null {
      return OPPORTUNITIES_CAMPAIGNS_RECORDS.read(sqlite);
    },
    log,
    now,
  };
}
export type OpportunitiesCampaignsRepository = ReturnType<typeof createOpportunitiesCampaignsRepository>;
export type OpportunitiesCampaignsReads = OpportunitiesCampaignsRepository['reads'];
