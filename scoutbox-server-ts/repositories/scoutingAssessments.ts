/**
 * Assessment templates, assessments, video segments and playlists.
 *
 * Records (the keys every reader sees): `AssessmentTemplate`, `Assessment`, `VideoSegment` and `Playlist` below,
 * deep-frozen as read back.
 *
 * Tables: assessment_templates, assessment_template_attributes; assessments, assessment_ratings,
 * assessment_rating_refs, assessment_history; video_segments, video_segment_labels; playlists, playlist_segments.
 * Every field is a typed column with its vocabulary and length CHECKs. A segment's drawing is the one JSON column: an
 * overlay the client draws and the server never reads, kept as data (no app sends one today). A record the columns
 * cannot hold is refused with its id at the repository (the routes check first and answer 400).
 *
 * WRITES are explicit. Templates are append-only (`templates.create`); a new version never changes an old one.
 * Assessments and playlists have `create(record)`, typed whole and written at once (an unknown field is refused), then
 * change only through named acts: an assessment is revised while a draft, submitted, reviewed and has its feedback
 * published, each guarded in SQL by the state it moves from, with its history entries; a playlist gains segments.
 * Segments are never edited (`segments.create`). Writes join the open unit of work, the caller's transaction, or a
 * transaction of their own. The typers take `unknown`, so a caller still in JavaScript can pass anything: the typer
 * and the columns judge it.
 *
 * Queries decode fresh, deep-frozen records in insertion (rowid) order unless they say otherwise; a read inside a unit
 * of work sees the unit's writes. Modules receive the queries as `scoutingReads` (`templates`, `assessments`,
 * `segments`, `playlists`).
 *
 * An assessment's `attributesSnapshot` is not stored: a template version never changes, so the attributes of
 * (template_id, template_version) are the snapshot, joined on read.
 *
 * References. Player, media, trial and trial-session ids have no foreign key: tolerant, like recruitment and the
 * evidence passport (an assessment outlives its player's account, which nulls the name; a trial is never deleted, only
 * tombstoned; the routes check the trial when the assessment is written). `org_id` → orgs and the staff ids →
 * org_users are RESTRICT (organisations are never deleted, O2 in docs/decisions.md). Inside the domain every key is immediate RESTRICT: an assessment's template,
 * its first opinion, a rating's cited segment and a playlist's segments; the child rows cascade with their owner.
 */
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import { isPlainObject, describe } from './fieldSpecs.ts';
import { migrationApplied, childRowsOf, operationOn, type Row, type UnitParticipant } from './database.ts';
import { readsOf } from './identityRules.ts';
import { writeKit, columnsOf, insertFor, type Flatten, type InputFor, type RowOf } from './writes.ts';
import {
  txt,
  historyTable,
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
  typeHistory,
  typeList,
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

export const SCOUTING_ASSESSMENTS_MIGRATION = '0020_scouting_assessments';
export const SCOUTING_ASSESSMENTS_COLLECTIONS = Object.freeze([
  'assessmentTemplates',
  'assessments',
  'videoSegments',
  'playlists',
] as const);
export type ScoutingAssessmentsCollection = (typeof SCOUTING_ASSESSMENTS_COLLECTIONS)[number];
export const SCOUTING_ASSESSMENTS_TABLES = Object.freeze([
  'assessment_templates',
  'assessment_template_attributes',
  'assessments',
  'assessment_ratings',
  'assessment_rating_refs',
  'assessment_history',
  'video_segments',
  'video_segment_labels',
  'playlists',
  'playlist_segments',
] as const);

// ------------------------------------------------------------------ vocabulary
export const POSITION_GROUPS = Object.freeze(['GK', 'DEF', 'MID', 'ATT'] as const);
export const ASSESSMENT_STATES = Object.freeze(['draft', 'submitted', 'reviewed'] as const);
export const CONFIDENCE_LEVELS = Object.freeze(['low', 'medium', 'high'] as const);
export const VERDICTS = Object.freeze(['sign', 'monitor', 'pass'] as const);
export const VIEWINGS = Object.freeze(['live', 'video'] as const);
/** The anchor levels a template attribute may describe (a 3 means the sentence, not a feeling). */
export const ANCHOR_LEVELS = Object.freeze(['1', '2', '3', '4', '5'] as const);
/** Limits: the routes shorten longer text to these; the columns refuse anything longer. */
export const ASSESSMENT_LIMITS = Object.freeze({
  attrId: 40,
  attrLabel: 80,
  anchor: 200,
  attributes: 20,
  name: 200,
  fixture: 120,
  opponentLevel: 60,
  reasons: 500,
  reviewNote: 300,
  feedback: 800,
  ratingNote: 300,
  refs: 6,
  refLabel: 80,
  ref: 80,
  minutesWatched: 600,
  labels: 8,
  label: 30,
  eventType: 40,
  segmentNote: 300,
  drawing: 4000,
  segmentSeconds: 600,
  playlistName: 80,
});
const L = ASSESSMENT_LIMITS;
export type PositionGroup = (typeof POSITION_GROUPS)[number];
export type AssessmentState = (typeof ASSESSMENT_STATES)[number];
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];
export type Verdict = (typeof VERDICTS)[number];
export type Viewing = (typeof VIEWINGS)[number];
export type AnchorLevel = (typeof ANCHOR_LEVELS)[number];

// ------------------------------------------------------------------ records
/** The descriptive sentence for each level an attribute describes; a level it leaves out has no key. */
type AnchorsFields = Partial<Record<AnchorLevel, string>>;
type AttributeFields = { id: string; label: string; anchors: AnchorsFields };
type TemplateFields = {
  id: string;
  positionGroup: PositionGroup;
  version: number;
  createdAt: number;
  /** The name of who published the version ('seed' for the v1 catalogue). */
  createdBy: string;
  attributes: AttributeFields[];
};
/** What a rating cites; a key it does not cite is absent, not null. */
type RefFields = { segmentId?: string; trialSessionId?: string; boxSessionId?: string; t?: number; label?: string };
type RatingFields = {
  attrId: string;
  /** 1 to 5, or null exactly when the attribute was not observed. */
  rating: number | null;
  notObserved: boolean;
  confidence: ConfidenceLevel;
  note: string | null;
  evidenceRefs: RefFields[];
};
type ContextFields = {
  fixture: string | null;
  /** A day, YYYY-MM-DD. */
  date: string | null;
  minutesWatched: number | null;
  viewing: Viewing | null;
  opponentLevel: string | null;
  trialId: string | null;
  /** Set only with `trialId`. */
  trialSessionId: string | null;
};
type RecommendationFields = { verdict: Verdict; reasons: string };
type FeedbackFields = { text: string; byUserId: string; byName: string; at: number };
type HistoryFields = Flatten<ScoutingHistoryEntry>;
/** An assessment as stored: what it reads back as, less the attributes joined from its template version. */
type StoredAssessmentFields = {
  id: string;
  orgId: string;
  playerId: string;
  playerName: string | null;
  scoutUserId: string;
  scoutName: string;
  templateId: string;
  templateVersion: number;
  context: ContextFields;
  ratings: RatingFields[];
  state: AssessmentState;
  recommendation: RecommendationFields | null;
  secondOpinionOf: string | null;
  createdAt: number;
  submittedAt: number | null;
  reviewedAt: number | null;
  reviewNote: string | null;
  publishedFeedback: FeedbackFields | null;
  history: HistoryFields[];
};
type AssessmentFields = Flatten<
  Omit<StoredAssessmentFields, 'context'> & { attributesSnapshot: AttributeFields[]; context: ContextFields }
>;
type StaffFields = { userId: string; name: string };
/** A JSON object the client draws and the server never reads. */
type DrawingFields = Record<string, unknown>;
type SegmentFields = {
  id: string;
  mediaId: string;
  playerId: string;
  orgId: string;
  createdBy: StaffFields;
  startS: number;
  endS: number;
  labels: string[];
  eventType: string | null;
  note: string | null;
  drawing: DrawingFields | null;
  createdAt: number;
};
type PlaylistFields = {
  id: string;
  orgId: string;
  name: string;
  createdBy: StaffFields;
  segmentIds: string[];
  createdAt: number;
};
export type TemplateAttribute = DeepReadonly<AttributeFields>;
export type AssessmentTemplate = DeepReadonly<TemplateFields>;
export type RatingRef = DeepReadonly<RefFields>;
export type AssessmentRating = DeepReadonly<RatingFields>;
export type AssessmentContext = DeepReadonly<ContextFields>;
export type AssessmentRecommendation = DeepReadonly<RecommendationFields>;
export type PublishedFeedback = DeepReadonly<FeedbackFields>;
export type Assessment = DeepReadonly<AssessmentFields>;
export type VideoSegment = DeepReadonly<SegmentFields>;
export type Playlist = DeepReadonly<PlaylistFields>;
type FieldsOf = {
  assessmentTemplates: TemplateFields;
  assessments: AssessmentFields;
  videoSegments: SegmentFields;
  playlists: PlaylistFields;
};
/** What each typer produces: an assessment is typed without the attributes it reads back with. */
type TypedFieldsOf = Flatten<Omit<FieldsOf, 'assessments'> & { assessments: StoredAssessmentFields }>;
type RecordOf = { [N in ScoutingAssessmentsCollection]: DeepReadonly<FieldsOf[N]> };
export type ScoutingAssessmentsRecords = { [N in ScoutingAssessmentsCollection]: RecordOf[N][] };

// ------------------------------------------------------------------ inputs (what the typers accept)
export type TemplateAttributeInput = Flatten<Omit<InputFor<AttributeFields>, 'anchors'> & { anchors?: AnchorsFields }>;
/** A template version names its attributes (2 to 20). */
export type AssessmentTemplateInput = Flatten<
  Omit<InputFor<TemplateFields>, 'attributes'> & { attributes: TemplateAttributeInput[] }
>;
export type RatingRefInput = { [K in keyof RefFields]?: RefFields[K] | null };
/** A rating names its references, even when there are none. */
export type AssessmentRatingInput = Flatten<
  Omit<InputFor<RatingFields>, 'evidenceRefs'> & { evidenceRefs: RatingRefInput[] }
>;
export type AssessmentContextInput = Partial<InputFor<ContextFields>>;
export type AssessmentRecommendationInput = InputFor<RecommendationFields>;
export type PublishedFeedbackInput = InputFor<FeedbackFields>;
/** An assessment; an `attributesSnapshot` (as a read-back record carries) is accepted and not stored. */
export type AssessmentInput = Flatten<
  Omit<InputFor<StoredAssessmentFields>, 'context' | 'ratings' | 'history'> & {
    context?: AssessmentContextInput | null;
    ratings?: AssessmentRatingInput[] | null;
    history?: ScoutingHistoryInput[] | null;
    attributesSnapshot?: unknown;
  }
>;
export type VideoSegmentInput = Flatten<Omit<InputFor<SegmentFields>, 'drawing'> & { drawing?: DrawingFields | null }>;
export type PlaylistInput = InputFor<PlaylistFields>;
type InputOf = {
  assessmentTemplates: AssessmentTemplateInput;
  assessments: AssessmentInput;
  videoSegments: VideoSegmentInput;
  playlists: PlaylistInput;
};
/** What `assessments.revise` changes on a draft: each part given replaces the stored one. */
export type AssessmentRevision = {
  ratings?: AssessmentRatingInput[] | null;
  context?: AssessmentContextInput | null;
  recommendation?: AssessmentRecommendationInput | null;
};

const REF_KEYS = Object.freeze([
  'segmentId',
  'trialSessionId',
  'boxSessionId',
  't',
  'label',
] as const satisfies readonly (keyof RefFields)[]);
const CONTEXT_KEYS = Object.freeze([
  'fixture',
  'date',
  'minutesWatched',
  'viewing',
  'opponentLevel',
  'trialId',
  'trialSessionId',
] as const satisfies readonly (keyof ContextFields)[]);

// ------------------------------------------------------------------ the v1 templates (inserted by migration 0020)
// Position-specific templates with DESCRIPTIVE anchors: a 3 means the sentence, not a feeling.
/** A catalogue template: `createdAt` is the migration's clock, stamped when it is inserted. */
type SeedTemplateFields = Omit<TemplateFields, 'createdAt'>;
const anchor = (a1: string, a3: string, a5: string): AnchorsFields => ({ 1: a1, 3: a3, 5: a5 });
const T = (positionGroup: PositionGroup, attributes: [string, string, AnchorsFields][]): SeedTemplateFields => ({
  id: `tpl-${positionGroup.toLowerCase()}`,
  positionGroup,
  version: 1,
  createdBy: 'seed',
  attributes: attributes.map(([id, label, anchors]) => ({ id, label, anchors })),
});
export const SEED_TEMPLATES: readonly DeepReadonly<SeedTemplateFields>[] = Object.freeze(
  [
    T('GK', [
      [
        'shot_stopping',
        'Shot stopping',
        anchor(
          'Beaten by savable strikes',
          'Makes the expected saves',
          'Repeatedly saves strikes most keepers concede',
        ),
      ],
      [
        'distribution',
        'Distribution',
        anchor('Kicks are a turnover', 'Safe short + adequate long', 'Starts attacks under pressure'),
      ],
      [
        'command_of_area',
        'Command of area',
        anchor('Stays rooted on crosses', 'Claims the straightforward ball', 'Owns the box, organises the line'),
      ],
      [
        'one_v_one',
        '1v1',
        anchor('Commits early, easily rounded', 'Delays and narrows angles', 'Consistently wins clean 1v1s'),
      ],
    ]),
    T('DEF', [
      [
        'positioning',
        'Positioning',
        anchor('Caught ball-watching', 'Holds the line, tracks runners', 'Reads danger two passes early'),
      ],
      [
        'duels',
        'Duels (ground + air)',
        anchor('Loses most contests', 'Breaks even vs like-for-like', 'Dominant in both phases'),
      ],
      [
        'first_pass',
        'First pass out',
        anchor('Clears blind', 'Finds the free full-back', 'Breaks a line on the ground'),
      ],
      [
        'recovery_pace',
        'Recovery pace',
        anchor('Exposed in space', 'Copes with average movers', 'Recovers vs quick attackers'),
      ],
    ]),
    T('MID', [
      [
        'receiving',
        'Receiving under pressure',
        anchor('Hides from the ball', 'Keeps it simple, keeps it safe', 'Wants it in traffic, turns out of it'),
      ],
      [
        'progression',
        'Ball progression',
        anchor(
          'Sideways and backwards only',
          'Moves play forward when on',
          'Consistently breaks lines by pass or carry',
        ),
      ],
      [
        'defensive_work',
        'Defensive contribution',
        anchor('Jogs back', 'Screens and tracks adequately', 'Wins it back high, reads screens'),
      ],
      ['tempo', 'Tempo control', anchor('Rushes everything', 'Plays at the game’s pace', 'Dictates the game’s pace')],
    ]),
    T('ATT', [
      [
        'finishing',
        'Finishing',
        anchor('Snatches at chances', 'Buries the clear ones', 'Finishes half-chances both feet'),
      ],
      [
        'movement',
        'Movement off the ball',
        anchor('Static, marks himself', 'Finds space in rotation', 'Constantly unbalances the back line'),
      ],
      [
        'first_touch',
        'First touch',
        anchor('Touch escapes under pressure', 'Controls with time', 'Kills any ball instantly under pressure'),
      ],
      ['pressing', 'Pressing', anchor('No defensive effort', 'Presses on triggers', 'First defender, sets the press')],
    ]),
  ].map((t) => deepFreeze(t)),
);

// ------------------------------------------------------------------ DDL
const anchorCols = ANCHOR_LEVELS.map((l) => `  anchor_${l}         ${txt(`anchor_${l}`, L.anchor)},`).join('\n');
export const SCOUTING_ASSESSMENTS_DDL = `
CREATE TABLE assessment_templates (
  id              TEXT NOT NULL,
  version         INTEGER NOT NULL CHECK (version >= 1),
  position_group  TEXT NOT NULL CHECK (position_group IN ('GK','DEF','MID','ATT')),
  created_at      INTEGER NOT NULL,
  created_by_name ${txt('created_by_name', L.name, { notNull: true })},
  PRIMARY KEY (id, version),
  UNIQUE (position_group, version)
) STRICT;
CREATE TABLE assessment_template_attributes (
  template_id      TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  position         INTEGER NOT NULL,
  attr_id          ${txt('attr_id', L.attrId, { notNull: true })},
  label            ${txt('label', L.attrLabel, { notNull: true })},
${anchorCols}
  PRIMARY KEY (template_id, template_version, position),
  UNIQUE (template_id, template_version, attr_id),
  FOREIGN KEY (template_id, template_version) REFERENCES assessment_templates(id, version) ON DELETE CASCADE
) STRICT;
CREATE TABLE video_segments (
  id                 TEXT PRIMARY KEY,
  media_id           TEXT NOT NULL,
  player_id          TEXT NOT NULL,
  org_id             TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  created_by_user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  created_by_name    ${txt('created_by_name', L.name, { notNull: true })},
  start_s            REAL NOT NULL CHECK (start_s >= 0),
  end_s              REAL NOT NULL CHECK (end_s > start_s AND end_s - start_s <= ${L.segmentSeconds}),
  event_type         ${txt('event_type', L.eventType)},
  note               ${txt('note', L.segmentNote)},
  drawing_json       TEXT CHECK (drawing_json IS NULL OR (json_valid(drawing_json) AND json_type(drawing_json) = 'object' AND length(drawing_json) <= ${L.drawing})),
  created_at         INTEGER NOT NULL
) STRICT;
CREATE INDEX video_segments_org_player ON video_segments (org_id, player_id);
CREATE INDEX video_segments_org_media ON video_segments (org_id, media_id);
CREATE TABLE video_segment_labels (
  segment_id TEXT NOT NULL REFERENCES video_segments(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL CHECK (position BETWEEN 0 AND ${L.labels - 1}),
  label      ${txt('label', L.label, { notNull: true })},
  PRIMARY KEY (segment_id, position)
) STRICT;
CREATE TABLE playlists (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  name               ${txt('name', L.playlistName, { notNull: true })},
  created_by_user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  created_by_name    ${txt('created_by_name', L.name, { notNull: true })},
  created_at         INTEGER NOT NULL
) STRICT;
CREATE INDEX playlists_org ON playlists (org_id);
CREATE TABLE playlist_segments (
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  segment_id  TEXT NOT NULL REFERENCES video_segments(id) ON DELETE RESTRICT,
  PRIMARY KEY (playlist_id, position),
  UNIQUE (playlist_id, segment_id)
) STRICT;
CREATE TABLE assessments (
  id                            TEXT PRIMARY KEY,
  org_id                        TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  player_id                     TEXT NOT NULL,
  player_name                   ${txt('player_name', L.name)},
  scout_user_id                 TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  scout_name                    ${txt('scout_name', L.name, { notNull: true })},
  template_id                   TEXT NOT NULL,
  template_version              INTEGER NOT NULL,
  context_fixture               ${txt('context_fixture', L.fixture)},
  context_date                  TEXT CHECK (context_date IS NULL OR length(context_date) = 10),
  context_minutes_watched       INTEGER CHECK (context_minutes_watched IS NULL OR context_minutes_watched BETWEEN 1 AND ${L.minutesWatched}),
  context_viewing               TEXT CHECK (context_viewing IS NULL OR context_viewing IN ('live','video')),
  context_opponent_level        ${txt('context_opponent_level', L.opponentLevel)},
  context_trial_id              TEXT,
  context_trial_session_id      TEXT CHECK (context_trial_session_id IS NULL OR context_trial_id IS NOT NULL),
  state                         TEXT NOT NULL CHECK (state IN ('draft','submitted','reviewed')),
  recommendation_verdict        TEXT CHECK (recommendation_verdict IS NULL OR recommendation_verdict IN ('sign','monitor','pass')),
  recommendation_reasons        ${txt('recommendation_reasons', L.reasons)},
  second_opinion_of_id          TEXT REFERENCES assessments(id) ON DELETE RESTRICT,
  created_at                    INTEGER NOT NULL,
  submitted_at                  INTEGER,
  reviewed_at                   INTEGER,
  review_note                   ${txt('review_note', L.reviewNote)},
  published_feedback_text       ${txt('published_feedback_text', L.feedback)},
  published_feedback_by_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  published_feedback_by_name    ${txt('published_feedback_by_name', L.name)},
  published_feedback_at         INTEGER,
  FOREIGN KEY (template_id, template_version) REFERENCES assessment_templates(id, version) ON DELETE RESTRICT,
  CHECK ((state = 'draft') = (submitted_at IS NULL)),
  CHECK ((state = 'reviewed') = (reviewed_at IS NOT NULL)),
  CHECK (review_note IS NULL OR state = 'reviewed'),
  CHECK ((recommendation_verdict IS NULL) = (recommendation_reasons IS NULL)),
  CHECK ((published_feedback_text IS NULL) = (published_feedback_by_user_id IS NULL) AND (published_feedback_text IS NULL) = (published_feedback_by_name IS NULL) AND (published_feedback_text IS NULL) = (published_feedback_at IS NULL)),
  CHECK (published_feedback_text IS NULL OR state <> 'draft')
) STRICT;
CREATE INDEX assessments_org_player ON assessments (org_id, player_id);
CREATE INDEX assessments_org_scout ON assessments (org_id, scout_user_id);
CREATE INDEX assessments_player_feedback ON assessments (player_id, published_feedback_at);
CREATE INDEX assessments_trial ON assessments (context_trial_id);
CREATE TABLE assessment_ratings (
  assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  attr_id       ${txt('attr_id', L.attrId, { notNull: true })},
  rating        INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  not_observed  INTEGER NOT NULL CHECK (not_observed IN (0,1)),
  confidence    TEXT NOT NULL CHECK (confidence IN ('low','medium','high')),
  note          ${txt('note', L.ratingNote)},
  PRIMARY KEY (assessment_id, position),
  UNIQUE (assessment_id, attr_id),
  CHECK ((not_observed = 1) = (rating IS NULL))
) STRICT;
CREATE TABLE assessment_rating_refs (
  assessment_id    TEXT NOT NULL,
  rating_position  INTEGER NOT NULL,
  position         INTEGER NOT NULL CHECK (position BETWEEN 0 AND ${L.refs - 1}),
  segment_id       TEXT REFERENCES video_segments(id) ON DELETE RESTRICT,
  trial_session_id ${txt('trial_session_id', L.ref)},
  box_session_id   ${txt('box_session_id', L.ref)},
  t_s              REAL CHECK (t_s IS NULL OR t_s >= 0),
  label            ${txt('label', L.refLabel)},
  PRIMARY KEY (assessment_id, rating_position, position),
  FOREIGN KEY (assessment_id, rating_position) REFERENCES assessment_ratings(assessment_id, position) ON DELETE CASCADE
) STRICT;
CREATE INDEX assessment_rating_refs_segment ON assessment_rating_refs (segment_id);
${historyTable('assessment_history', 'assessment_id', 'assessments')}
`;

// ------------------------------------------------------------------ typing (the one place a value is judged)
// Each typer checks the value field by field, then reads it as the input it has just been checked to be.
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const dayOnly = (v: unknown): v is string => isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isAbsent = (v: unknown): v is null | undefined => v === undefined || v === null;
const oneOf = <T>(list: readonly T[], v: unknown): v is T => (list as readonly unknown[]).includes(v);
const objectAt = (raw: unknown, at: string): Bad | null =>
  isPlainObject(raw) ? null : { ok: false, reason: `${at} is not an object (${describe(raw)})` };
const idOf = (raw: Record<string, unknown>, at: string): Bad | null =>
  nonEmpty(raw.id) ? null : bad(at, 'id', 'must be a non-empty string');
const named = (v: unknown, at: string, field: string): Bad | null =>
  isPlainObject(v) &&
  nonEmpty(v.userId) &&
  nonEmpty(v.name) &&
  v.name.length <= L.name &&
  Object.keys(v).every((k) => ['userId', 'name'].includes(k))
    ? null
    : bad(at, field, 'must be {userId, name}');

function typeAttribute(a: unknown, at: string): Typed<AttributeFields> {
  if (!isPlainObject(a)) return objectAt(a, at) as Bad;
  const problem = first(
    unknownFields(a, at, ['id', 'label', 'anchors']),
    reqText(a, at, 'id', L.attrId),
    reqText(a, at, 'label', L.attrLabel),
  );
  if (problem) return problem;
  const anchors = a.anchors ?? {};
  if (
    !isPlainObject(anchors) ||
    Object.entries(anchors).some(([k, v]) => !oneOf(ANCHOR_LEVELS, k) || !nonEmpty(v) || v.length > L.anchor)
  )
    return bad(at, 'anchors', `must map levels ${ANCHOR_LEVELS.join('|')} to text of at most ${L.anchor} characters`);
  const v = a as TemplateAttributeInput;
  return {
    ok: true,
    record: {
      id: v.id,
      label: v.label,
      anchors: Object.fromEntries(
        ANCHOR_LEVELS.filter((l) => anchors[l] !== undefined).map((l) => [l, anchors[l] as string]),
      ),
    },
  };
}
const TEMPLATE_FIELDS = [
  'id',
  'positionGroup',
  'version',
  'createdAt',
  'createdBy',
  'attributes',
] as const satisfies readonly (keyof TemplateFields)[];
/** A template version, typed. `{ ok, record }` or `{ ok: false, reason }` naming the field, never its content. */
export function typeTemplate(raw: unknown, at = 'assessmentTemplates'): Typed<TemplateFields> {
  if (!isPlainObject(raw)) return objectAt(raw, at) as Bad;
  const head = idOf(raw, at);
  if (head) return head;
  const label = `${at} ${raw.id}`;
  const problem = first(
    unknownFields(raw, label, TEMPLATE_FIELDS),
    reqInstant(raw, label, 'createdAt'),
    reqText(raw, label, 'createdBy', L.name),
  );
  if (problem) return problem;
  if (!oneOf(POSITION_GROUPS, raw.positionGroup))
    return bad(label, 'positionGroup', `must be one of ${POSITION_GROUPS.join('|')}`);
  if (!isInt(raw.version) || raw.version < 1) return bad(label, 'version', 'must be an integer of at least 1');
  if (!Array.isArray(raw.attributes) || raw.attributes.length < 2 || raw.attributes.length > L.attributes)
    return bad(label, 'attributes', `must list 2 to ${L.attributes} attributes`);
  const attributes: AttributeFields[] = [];
  for (let i = 0; i < raw.attributes.length; i++) {
    const t = typeAttribute(raw.attributes[i], `${label}.attributes[${i}]`);
    if (!t.ok) return t;
    if (attributes.some((x) => x.id === t.record.id))
      return bad(`${label}.attributes[${i}]`, 'id', 'names an attribute twice');
    attributes.push(t.record);
  }
  const t = raw as AssessmentTemplateInput;
  return {
    ok: true,
    record: {
      id: t.id,
      positionGroup: t.positionGroup,
      version: t.version,
      createdAt: t.createdAt,
      createdBy: t.createdBy,
      attributes,
    },
  };
}

function typeRef(ref: unknown, at: string): Typed<RefFields> {
  if (!isPlainObject(ref)) return objectAt(ref, at) as Bad;
  const problem = first(
    unknownFields(ref, at, REF_KEYS),
    optText(ref, at, 'segmentId', L.ref),
    optText(ref, at, 'trialSessionId', L.ref),
    optText(ref, at, 'boxSessionId', L.ref),
    optText(ref, at, 'label', L.refLabel),
  );
  if (problem) return problem;
  if (!isAbsent(ref.t) && !(isNum(ref.t) && ref.t >= 0))
    return bad(at, 't', 'must be a number of seconds (0 or more) or null');
  return {
    ok: true,
    record: Object.fromEntries(REF_KEYS.filter((k) => !isAbsent(ref[k])).map((k) => [k, ref[k]])) as RefFields,
  };
}
function typeRating(r: unknown, at: string): Typed<RatingFields> {
  if (!isPlainObject(r)) return objectAt(r, at) as Bad;
  const problem = first(
    unknownFields(r, at, ['attrId', 'rating', 'notObserved', 'confidence', 'note', 'evidenceRefs']),
    reqText(r, at, 'attrId', L.attrId),
    optText(r, at, 'note', L.ratingNote),
  );
  if (problem) return problem;
  if (typeof r.notObserved !== 'boolean') return bad(at, 'notObserved', 'must be true or false');
  if (r.notObserved ? r.rating !== null : !(isInt(r.rating) && r.rating >= 1 && r.rating <= 5))
    return bad(at, 'rating', r.notObserved ? 'must be null when not observed' : 'must be a whole number from 1 to 5');
  if (!oneOf(CONFIDENCE_LEVELS, r.confidence))
    return bad(at, 'confidence', `must be one of ${CONFIDENCE_LEVELS.join('|')}`);
  if (!Array.isArray(r.evidenceRefs) || r.evidenceRefs.length > L.refs)
    return bad(at, 'evidenceRefs', `must be a list of at most ${L.refs} references`);
  const refs: RefFields[] = [];
  for (let i = 0; i < r.evidenceRefs.length; i++) {
    const t = typeRef(r.evidenceRefs[i], `${at}.evidenceRefs[${i}]`);
    if (!t.ok) return t;
    refs.push(t.record);
  }
  const v = r as AssessmentRatingInput;
  return {
    ok: true,
    record: {
      attrId: v.attrId,
      rating: v.rating as number | null,
      notObserved: v.notObserved,
      confidence: v.confidence,
      note: orNull(v.note),
      evidenceRefs: refs,
    },
  };
}
const ASSESSMENT_FIELDS = [
  'id',
  'orgId',
  'playerId',
  'playerName',
  'scoutUserId',
  'scoutName',
  'templateId',
  'templateVersion',
  'attributesSnapshot',
  'context',
  'ratings',
  'state',
  'recommendation',
  'secondOpinionOf',
  'createdAt',
  'submittedAt',
  'reviewedAt',
  'reviewNote',
  'publishedFeedback',
  'history',
] as const satisfies readonly (keyof AssessmentFields)[];
/** An assessment, typed. `attributesSnapshot` is accepted and dropped: it is the template version's attributes. */
export function typeAssessment(raw: unknown, at = 'assessments'): Typed<StoredAssessmentFields> {
  if (!isPlainObject(raw)) return objectAt(raw, at) as Bad;
  const head = idOf(raw, at);
  if (head) return head;
  const label = `${at} ${raw.id}`;
  const problem = first(
    unknownFields(raw, label, ASSESSMENT_FIELDS),
    reqText(raw, label, 'orgId', 80),
    reqText(raw, label, 'playerId', 80),
    optText(raw, label, 'playerName', L.name),
    reqText(raw, label, 'scoutUserId', 80),
    reqText(raw, label, 'scoutName', L.name),
    reqText(raw, label, 'templateId', 80),
    optText(raw, label, 'secondOpinionOf', 80),
    reqInstant(raw, label, 'createdAt'),
    optInstant(raw, label, 'submittedAt'),
    optInstant(raw, label, 'reviewedAt'),
    optText(raw, label, 'reviewNote', L.reviewNote),
  );
  if (problem) return problem;
  if (!isInt(raw.templateVersion) || raw.templateVersion < 1)
    return bad(label, 'templateVersion', 'must be an integer of at least 1');
  if (!oneOf(ASSESSMENT_STATES, raw.state)) return bad(label, 'state', `must be one of ${ASSESSMENT_STATES.join('|')}`);
  const c = raw.context ?? {};
  const cAt = `${label}.context`;
  if (!isPlainObject(c)) return objectAt(c, cAt) as Bad;
  const cp = first(
    unknownFields(c, cAt, CONTEXT_KEYS),
    optText(c, cAt, 'fixture', L.fixture),
    optText(c, cAt, 'opponentLevel', L.opponentLevel),
    optText(c, cAt, 'trialId', 80),
    optText(c, cAt, 'trialSessionId', 80),
  );
  if (cp) return cp;
  if (!isAbsent(c.date) && !dayOnly(c.date)) return bad(cAt, 'date', 'must be a YYYY-MM-DD day or null');
  if (
    !isAbsent(c.minutesWatched) &&
    !(isInt(c.minutesWatched) && c.minutesWatched >= 1 && c.minutesWatched <= L.minutesWatched)
  )
    return bad(cAt, 'minutesWatched', `must be a whole number of minutes from 1 to ${L.minutesWatched} or null`);
  if (!isAbsent(c.viewing) && !oneOf(VIEWINGS, c.viewing))
    return bad(cAt, 'viewing', `must be one of ${VIEWINGS.join('|')} or null`);
  if (c.trialSessionId && !c.trialId) return bad(cAt, 'trialSessionId', 'needs the trialId too');
  const ratings: RatingFields[] = [];
  if (!isAbsent(raw.ratings)) {
    if (!Array.isArray(raw.ratings)) return bad(label, 'ratings', 'must be a list');
    for (let i = 0; i < raw.ratings.length; i++) {
      const t = typeRating(raw.ratings[i], `${label}.ratings[${i}]`);
      if (!t.ok) return t;
      if (ratings.some((x) => x.attrId === t.record.attrId))
        return bad(`${label}.ratings[${i}]`, 'attrId', 'rates an attribute twice');
      ratings.push(t.record);
    }
  }
  let recommendation: RecommendationFields | null = null;
  if (!isAbsent(raw.recommendation)) {
    const r = raw.recommendation;
    if (
      !isPlainObject(r) ||
      !oneOf(VERDICTS, r.verdict) ||
      !isStr(r.reasons) ||
      r.reasons.length > L.reasons ||
      Object.keys(r).some((k) => !['verdict', 'reasons'].includes(k))
    )
      return bad(label, 'recommendation', `must be {verdict: ${VERDICTS.join('|')}, reasons} or null`);
    recommendation = { verdict: r.verdict, reasons: r.reasons };
  }
  let publishedFeedback: FeedbackFields | null = null;
  if (!isAbsent(raw.publishedFeedback)) {
    const f = raw.publishedFeedback;
    const fAt = `${label}.publishedFeedback`;
    if (!isPlainObject(f)) return objectAt(f, fAt) as Bad;
    const fp = first(
      unknownFields(f, fAt, ['text', 'byUserId', 'byName', 'at']),
      reqText(f, fAt, 'text', L.feedback),
      reqText(f, fAt, 'byUserId', 80),
      reqText(f, fAt, 'byName', L.name),
      reqInstant(f, fAt, 'at'),
    );
    if (fp) return fp;
    if (raw.state === 'draft') return bad(label, 'publishedFeedback', 'cannot be published from a draft');
    const v = f as PublishedFeedbackInput;
    publishedFeedback = { text: v.text, byUserId: v.byUserId, byName: v.byName, at: v.at };
  }
  if ((raw.state === 'draft') !== isAbsent(raw.submittedAt))
    return bad(label, 'submittedAt', raw.state === 'draft' ? 'must be null on a draft' : 'is required once submitted');
  if ((raw.state === 'reviewed') !== !isAbsent(raw.reviewedAt))
    return bad(
      label,
      'reviewedAt',
      raw.state === 'reviewed' ? 'is required once reviewed' : 'must be null before review',
    );
  if (raw.reviewNote && raw.state !== 'reviewed') return bad(label, 'reviewNote', 'exists only after review');
  if (raw.secondOpinionOf && raw.secondOpinionOf === raw.id)
    return bad(label, 'secondOpinionOf', 'names the record itself');
  const history = typeList(raw.history, `${label}.history`, typeHistory, ['org']);
  if (!history.ok) return history;
  const a = raw as AssessmentInput;
  const ctx = c as AssessmentContextInput;
  return {
    ok: true,
    record: {
      id: a.id,
      orgId: a.orgId,
      playerId: a.playerId,
      playerName: orNull(a.playerName),
      scoutUserId: a.scoutUserId,
      scoutName: a.scoutName,
      templateId: a.templateId,
      templateVersion: a.templateVersion,
      context: {
        fixture: orNull(ctx.fixture),
        date: orNull(ctx.date),
        minutesWatched: orNull(ctx.minutesWatched),
        viewing: orNull(ctx.viewing),
        opponentLevel: orNull(ctx.opponentLevel),
        trialId: orNull(ctx.trialId),
        trialSessionId: orNull(ctx.trialSessionId),
      },
      ratings,
      state: a.state,
      recommendation,
      secondOpinionOf: orNull(a.secondOpinionOf),
      createdAt: a.createdAt,
      submittedAt: orNull(a.submittedAt),
      reviewedAt: orNull(a.reviewedAt),
      reviewNote: orNull(a.reviewNote),
      publishedFeedback,
      history: history.list,
    },
  };
}

const SEGMENT_FIELDS = [
  'id',
  'mediaId',
  'playerId',
  'orgId',
  'createdBy',
  'startS',
  'endS',
  'labels',
  'eventType',
  'note',
  'drawing',
  'createdAt',
] as const satisfies readonly (keyof SegmentFields)[];
export function typeSegment(raw: unknown, at = 'videoSegments'): Typed<SegmentFields> {
  if (!isPlainObject(raw)) return objectAt(raw, at) as Bad;
  const head = idOf(raw, at);
  if (head) return head;
  const label = `${at} ${raw.id}`;
  const problem = first(
    unknownFields(raw, label, SEGMENT_FIELDS),
    reqText(raw, label, 'mediaId', 80),
    reqText(raw, label, 'playerId', 80),
    reqText(raw, label, 'orgId', 80),
    named(raw.createdBy, label, 'createdBy'),
    optText(raw, label, 'eventType', L.eventType),
    optText(raw, label, 'note', L.segmentNote),
    reqInstant(raw, label, 'createdAt'),
  );
  if (problem) return problem;
  if (!(isNum(raw.startS) && raw.startS >= 0)) return bad(label, 'startS', 'must be a number of seconds, 0 or more');
  if (!(isNum(raw.endS) && raw.endS > raw.startS && raw.endS - raw.startS <= L.segmentSeconds))
    return bad(label, 'endS', `must be after startS, at most ${L.segmentSeconds} seconds later`);
  const labels = raw.labels ?? [];
  if (!Array.isArray(labels) || labels.length > L.labels || labels.some((l) => !nonEmpty(l) || l.length > L.label))
    return bad(label, 'labels', `must be at most ${L.labels} labels of at most ${L.label} characters`);
  const drawing = raw.drawing ?? null;
  if (drawing !== null && (!isPlainObject(drawing) || JSON.stringify(drawing).length > L.drawing))
    return bad(label, 'drawing', `must be an object of at most ${L.drawing} characters as JSON, or null`);
  const s = raw as VideoSegmentInput;
  return {
    ok: true,
    record: {
      id: s.id,
      mediaId: s.mediaId,
      playerId: s.playerId,
      orgId: s.orgId,
      createdBy: { userId: s.createdBy.userId, name: s.createdBy.name },
      startS: s.startS,
      endS: s.endS,
      labels: [...(labels as string[])],
      eventType: orNull(s.eventType),
      note: orNull(s.note),
      drawing: clone(drawing),
      createdAt: s.createdAt,
    },
  };
}

const PLAYLIST_FIELDS = [
  'id',
  'orgId',
  'name',
  'createdBy',
  'segmentIds',
  'createdAt',
] as const satisfies readonly (keyof PlaylistFields)[];
export function typePlaylist(raw: unknown, at = 'playlists'): Typed<PlaylistFields> {
  if (!isPlainObject(raw)) return objectAt(raw, at) as Bad;
  const head = idOf(raw, at);
  if (head) return head;
  const label = `${at} ${raw.id}`;
  const problem = first(
    unknownFields(raw, label, PLAYLIST_FIELDS),
    reqText(raw, label, 'orgId', 80),
    reqText(raw, label, 'name', L.playlistName),
    named(raw.createdBy, label, 'createdBy'),
    reqInstant(raw, label, 'createdAt'),
  );
  if (problem) return problem;
  const segs = raw.segmentIds ?? [];
  if (!Array.isArray(segs) || segs.some((s) => !nonEmpty(s)))
    return bad(label, 'segmentIds', 'must be a list of segment ids');
  if (new Set(segs).size !== segs.length) return bad(label, 'segmentIds', 'names a segment twice');
  const p = raw as PlaylistInput;
  return {
    ok: true,
    record: {
      id: p.id,
      orgId: p.orgId,
      name: p.name,
      createdBy: { userId: p.createdBy.userId, name: p.createdBy.name },
      segmentIds: [...(segs as string[])],
      createdAt: p.createdAt,
    },
  };
}
const TYPERS: { [N in ScoutingAssessmentsCollection]: (raw: unknown, at: string) => Typed<TypedFieldsOf[N]> } = {
  assessmentTemplates: typeTemplate,
  assessments: typeAssessment,
  videoSegments: typeSegment,
  playlists: typePlaylist,
};
const TABLE_OF = {
  assessmentTemplates: 'assessment_templates',
  assessments: 'assessments',
  videoSegments: 'video_segments',
  playlists: 'playlists',
} as const satisfies Record<ScoutingAssessmentsCollection, string>;

// ------------------------------------------------------------------ rows ↔ records
type AnchorCols = Record<`anchor_${AnchorLevel}`, string | null>;
const anchorColsOf = (anchors: AnchorsFields): AnchorCols =>
  Object.fromEntries(ANCHOR_LEVELS.map((l) => [`anchor_${l}`, anchors[l] ?? null])) as AnchorCols;
const templateRow = (t: TemplateFields) => ({
  id: t.id,
  version: t.version,
  position_group: t.positionGroup,
  created_at: t.createdAt,
  created_by_name: t.createdBy,
});
type TemplateRow = RowOf<typeof templateRow>;
const attributeRow = (t: TemplateFields, a: AttributeFields, position: number) => ({
  template_id: t.id,
  template_version: t.version,
  position,
  attr_id: a.id,
  label: a.label,
  ...anchorColsOf(a.anchors),
});
type AttributeRow = RowOf<typeof attributeRow>;
const contextCols = (c: ContextFields) => ({
  context_fixture: c.fixture,
  context_date: c.date,
  context_minutes_watched: c.minutesWatched,
  context_viewing: c.viewing,
  context_opponent_level: c.opponentLevel,
  context_trial_id: c.trialId,
  context_trial_session_id: c.trialSessionId,
});
const recommendationCols = (r: RecommendationFields | null) => ({
  recommendation_verdict: r?.verdict ?? null,
  recommendation_reasons: r?.reasons ?? null,
});
const assessmentRow = (a: StoredAssessmentFields) => ({
  id: a.id,
  org_id: a.orgId,
  player_id: a.playerId,
  player_name: a.playerName,
  scout_user_id: a.scoutUserId,
  scout_name: a.scoutName,
  template_id: a.templateId,
  template_version: a.templateVersion,
  ...contextCols(a.context),
  state: a.state,
  ...recommendationCols(a.recommendation),
  second_opinion_of_id: a.secondOpinionOf,
  created_at: a.createdAt,
  submitted_at: a.submittedAt,
  reviewed_at: a.reviewedAt,
  review_note: a.reviewNote,
  published_feedback_text: a.publishedFeedback?.text ?? null,
  published_feedback_by_user_id: a.publishedFeedback?.byUserId ?? null,
  published_feedback_by_name: a.publishedFeedback?.byName ?? null,
  published_feedback_at: a.publishedFeedback?.at ?? null,
});
type AssessmentRow = RowOf<typeof assessmentRow>;
const ratingRow = (assessmentId: string, r: RatingFields, position: number) => ({
  assessment_id: assessmentId,
  position,
  attr_id: r.attrId,
  rating: r.rating,
  not_observed: r.notObserved ? 1 : 0,
  confidence: r.confidence,
  note: r.note,
});
type RatingRow = RowOf<typeof ratingRow>;
const refRow = (assessmentId: string, ratingPosition: number, ref: RefFields, position: number) => ({
  assessment_id: assessmentId,
  rating_position: ratingPosition,
  position,
  segment_id: ref.segmentId ?? null,
  trial_session_id: ref.trialSessionId ?? null,
  box_session_id: ref.boxSessionId ?? null,
  t_s: ref.t ?? null,
  label: ref.label ?? null,
});
type RefRow = RowOf<typeof refRow>;
const segmentRow = (s: SegmentFields) => ({
  id: s.id,
  media_id: s.mediaId,
  player_id: s.playerId,
  org_id: s.orgId,
  created_by_user_id: s.createdBy.userId,
  created_by_name: s.createdBy.name,
  start_s: s.startS,
  end_s: s.endS,
  event_type: s.eventType,
  note: s.note,
  drawing_json: s.drawing === null ? null : JSON.stringify(s.drawing),
  created_at: s.createdAt,
});
type SegmentRow = RowOf<typeof segmentRow>;
const segLabelRow = (segmentId: string, label: string, position: number) => ({
  segment_id: segmentId,
  position,
  label,
});
type SegLabelRow = RowOf<typeof segLabelRow>;
const playlistRow = (p: PlaylistFields) => ({
  id: p.id,
  org_id: p.orgId,
  name: p.name,
  created_by_user_id: p.createdBy.userId,
  created_by_name: p.createdBy.name,
  created_at: p.createdAt,
});
type PlaylistRow = RowOf<typeof playlistRow>;
const plSegRow = (playlistId: string, segmentId: string, position: number) => ({
  playlist_id: playlistId,
  position,
  segment_id: segmentId,
});
type PlSegRow = RowOf<typeof plSegRow>;

const TEMPLATE_COLS = columnsOf<TemplateRow>()(['id', 'version', 'position_group', 'created_at', 'created_by_name']);
const ATTRIBUTE_COLS = columnsOf<AttributeRow>()([
  'template_id',
  'template_version',
  'position',
  'attr_id',
  'label',
  'anchor_1',
  'anchor_2',
  'anchor_3',
  'anchor_4',
  'anchor_5',
]);
const ASSESSMENT_COLS = columnsOf<AssessmentRow>()([
  'id',
  'org_id',
  'player_id',
  'player_name',
  'scout_user_id',
  'scout_name',
  'template_id',
  'template_version',
  'context_fixture',
  'context_date',
  'context_minutes_watched',
  'context_viewing',
  'context_opponent_level',
  'context_trial_id',
  'context_trial_session_id',
  'state',
  'recommendation_verdict',
  'recommendation_reasons',
  'second_opinion_of_id',
  'created_at',
  'submitted_at',
  'reviewed_at',
  'review_note',
  'published_feedback_text',
  'published_feedback_by_user_id',
  'published_feedback_by_name',
  'published_feedback_at',
]);
const RATING_COLS = columnsOf<RatingRow>()([
  'assessment_id',
  'position',
  'attr_id',
  'rating',
  'not_observed',
  'confidence',
  'note',
]);
const REF_COLS = columnsOf<RefRow>()([
  'assessment_id',
  'rating_position',
  'position',
  'segment_id',
  'trial_session_id',
  'box_session_id',
  't_s',
  'label',
]);
const SEGMENT_COLS = columnsOf<SegmentRow>()([
  'id',
  'media_id',
  'player_id',
  'org_id',
  'created_by_user_id',
  'created_by_name',
  'start_s',
  'end_s',
  'event_type',
  'note',
  'drawing_json',
  'created_at',
]);
const SEG_LABEL_COLS = columnsOf<SegLabelRow>()(['segment_id', 'position', 'label']);
const PLAYLIST_COLS = columnsOf<PlaylistRow>()([
  'id',
  'org_id',
  'name',
  'created_by_user_id',
  'created_by_name',
  'created_at',
]);
const PL_SEG_COLS = columnsOf<PlSegRow>()(['playlist_id', 'position', 'segment_id']);

/** Prepared statements over one connection. */
function statements(sqlite: DatabaseSync) {
  const p = (sql: string) => sqlite.prepare(sql);
  return {
    // A template is written by its (id, version) key, its attributes replaced: the migration's catalogue and a new
    // version go through the same writer.
    template: insertFor(sqlite, 'assessment_templates', TEMPLATE_COLS, { upsert: ['id', 'version'] }),
    templateAll: p('SELECT * FROM assessment_templates ORDER BY rowid'),
    attributesOf: p('DELETE FROM assessment_template_attributes WHERE template_id = ? AND template_version = ?'),
    attribute: insertFor(sqlite, 'assessment_template_attributes', ATTRIBUTE_COLS),
    templateBy: p('SELECT * FROM assessment_templates WHERE id = ? AND version = ?'),
    attributesBy: p(
      'SELECT * FROM assessment_template_attributes WHERE template_id = ? AND template_version = ? ORDER BY position',
    ),
    assessment: insertFor(sqlite, 'assessments', ASSESSMENT_COLS),
    rating: insertFor(sqlite, 'assessment_ratings', RATING_COLS),
    ref: insertFor(sqlite, 'assessment_rating_refs', REF_COLS),
    asHist: p(historyOf('assessment_history', 'assessment_id').insert),
    refsOf: p('DELETE FROM assessment_rating_refs WHERE assessment_id = ?'),
    ratingsOf: p('DELETE FROM assessment_ratings WHERE assessment_id = ?'),
    assessmentById: p('SELECT * FROM assessments WHERE id = ?'),
    assessmentAll: p('SELECT * FROM assessments ORDER BY rowid'),
    ratingsBy: p('SELECT * FROM assessment_ratings WHERE assessment_id = ? ORDER BY position'),
    refsBy: p('SELECT * FROM assessment_rating_refs WHERE assessment_id = ? AND rating_position = ? ORDER BY position'),
    asHistBy: p('SELECT * FROM assessment_history WHERE assessment_id = ? ORDER BY position'),
    segment: insertFor(sqlite, 'video_segments', SEGMENT_COLS),
    segLabel: insertFor(sqlite, 'video_segment_labels', SEG_LABEL_COLS),
    segmentById: p('SELECT * FROM video_segments WHERE id = ?'),
    segmentAll: p('SELECT * FROM video_segments ORDER BY rowid'),
    segLabelsBy: p('SELECT * FROM video_segment_labels WHERE segment_id = ? ORDER BY position'),
    playlist: insertFor(sqlite, 'playlists', PLAYLIST_COLS),
    plSeg: insertFor(sqlite, 'playlist_segments', PL_SEG_COLS),
    playlistById: p('SELECT * FROM playlists WHERE id = ?'),
    playlistAll: p('SELECT * FROM playlists ORDER BY rowid'),
    plSegsBy: p('SELECT * FROM playlist_segments WHERE playlist_id = ? ORDER BY position'),
  };
}
type Statements = ReturnType<typeof statements>;
/** Reads a record's child rows: a prepared statement, or the same rows for many records at once (`childRowsOf`). */
type ChildReader = { all(parentId: string, ...subKey: number[]): Row[] };
/** What the decoders read children through. */
type Readers = Record<'attributesBy' | 'ratingsBy' | 'refsBy' | 'asHistBy' | 'segLabelsBy' | 'plSegsBy', ChildReader>;
type BatchIds = { assessmentIds?: string[]; segmentIds?: string[]; playlistIds?: string[] };
/** The child statements for many records at once (one query per child table for a whole list). */
function batchStatements(
  sqlite: DatabaseSync,
  st: Statements,
  { assessmentIds = [], segmentIds = [], playlistIds = [] }: BatchIds,
): Readers {
  return {
    ...st,
    ratingsBy: childRowsOf(sqlite, 'assessment_ratings', 'assessment_id', assessmentIds, { order: 'position' }),
    refsBy: childRowsOf(sqlite, 'assessment_rating_refs', 'assessment_id', assessmentIds, {
      order: 'rating_position, position',
      subKey: ['rating_position'],
    }),
    asHistBy: childRowsOf(sqlite, 'assessment_history', 'assessment_id', assessmentIds, { order: 'position' }),
    segLabelsBy: childRowsOf(sqlite, 'video_segment_labels', 'segment_id', segmentIds, { order: 'position' }),
    plSegsBy: childRowsOf(sqlite, 'playlist_segments', 'playlist_id', playlistIds, { order: 'position' }),
  };
}

function writeTemplate(st: Statements, t: TemplateFields) {
  st.template.run(templateRow(t));
  st.attributesOf.run(t.id, t.version);
  t.attributes.forEach((a, i) => st.attribute.run(attributeRow(t, a, i)));
}
/** An assessment's ratings and their evidence references, replacing the stored ones. */
function writeRatings(st: Statements, id: string, ratings: readonly RatingFields[]) {
  st.refsOf.run(id);
  st.ratingsOf.run(id);
  ratings.forEach((r, i) => {
    st.rating.run(ratingRow(id, r, i));
    r.evidenceRefs.forEach((ref, j) => st.ref.run(refRow(id, i, ref, j)));
  });
}
function writeAssessment(st: Statements, a: StoredAssessmentFields) {
  st.assessment.run(assessmentRow(a));
  writeRatings(st, a.id, a.ratings);
  a.history.forEach((h, i) => st.asHist.run(histRow(a.id, h, i)));
}
function writeSegment(st: Statements, s: SegmentFields) {
  st.segment.run(segmentRow(s));
  s.labels.forEach((l, i) => st.segLabel.run(segLabelRow(s.id, l, i)));
}
function writePlaylist(st: Statements, p: PlaylistFields) {
  st.playlist.run(playlistRow(p));
  p.segmentIds.forEach((s, i) => st.plSeg.run(plSegRow(p.id, s, i)));
}
const WRITERS: { [N in ScoutingAssessmentsCollection]: (st: Statements, r: TypedFieldsOf[N]) => void } = {
  assessmentTemplates: writeTemplate,
  assessments: writeAssessment,
  videoSegments: writeSegment,
  playlists: writePlaylist,
};

const decodeAttribute = (r: AttributeRow): AttributeFields => ({
  id: r.attr_id,
  label: r.label,
  anchors: Object.fromEntries(
    ANCHOR_LEVELS.filter((l) => r[`anchor_${l}`] !== null).map((l) => [l, r[`anchor_${l}`] as string]),
  ),
});
const decodeTemplate = (st: Readers, r: TemplateRow): TemplateFields => ({
  id: r.id,
  positionGroup: r.position_group,
  version: r.version,
  createdAt: r.created_at,
  createdBy: r.created_by_name,
  attributes: (st.attributesBy.all(r.id, r.version) as AttributeRow[]).map(decodeAttribute),
});
const decodeRef = (x: RefRow): RefFields =>
  Object.fromEntries(
    (
      [
        ['segmentId', x.segment_id],
        ['trialSessionId', x.trial_session_id],
        ['boxSessionId', x.box_session_id],
        ['t', x.t_s],
        ['label', x.label],
      ] as const
    ).filter(([, v]) => v !== null),
  );
function decodeAssessment(st: Readers, r: AssessmentRow): AssessmentFields {
  return {
    id: r.id,
    orgId: r.org_id,
    playerId: r.player_id,
    playerName: r.player_name,
    scoutUserId: r.scout_user_id,
    scoutName: r.scout_name,
    templateId: r.template_id,
    templateVersion: r.template_version,
    attributesSnapshot: (st.attributesBy.all(r.template_id, r.template_version) as AttributeRow[]).map(decodeAttribute),
    context: {
      fixture: r.context_fixture,
      date: r.context_date,
      minutesWatched: r.context_minutes_watched,
      viewing: r.context_viewing,
      opponentLevel: r.context_opponent_level,
      trialId: r.context_trial_id,
      trialSessionId: r.context_trial_session_id,
    },
    ratings: (st.ratingsBy.all(r.id) as RatingRow[]).map((x) => ({
      attrId: x.attr_id,
      rating: x.rating,
      notObserved: x.not_observed === 1,
      confidence: x.confidence,
      note: x.note,
      evidenceRefs: (st.refsBy.all(r.id, x.position) as RefRow[]).map(decodeRef),
    })),
    state: r.state,
    // Each part's columns are written together from one typed value, so a part that reads back present is whole.
    recommendation:
      r.recommendation_verdict === null
        ? null
        : { verdict: r.recommendation_verdict, reasons: r.recommendation_reasons as string },
    secondOpinionOf: r.second_opinion_of_id,
    createdAt: r.created_at,
    submittedAt: r.submitted_at,
    reviewedAt: r.reviewed_at,
    reviewNote: r.review_note,
    publishedFeedback:
      r.published_feedback_text === null
        ? null
        : {
            text: r.published_feedback_text,
            byUserId: r.published_feedback_by_user_id as string,
            byName: r.published_feedback_by_name as string,
            at: r.published_feedback_at as number,
          },
    history: (st.asHistBy.all(r.id) as HistoryRow[]).map(histOut),
  };
}
const decodeSegment = (st: Readers, r: SegmentRow): SegmentFields => ({
  id: r.id,
  mediaId: r.media_id,
  playerId: r.player_id,
  orgId: r.org_id,
  createdBy: { userId: r.created_by_user_id, name: r.created_by_name },
  startS: r.start_s,
  endS: r.end_s,
  labels: (st.segLabelsBy.all(r.id) as SegLabelRow[]).map((x) => x.label),
  eventType: r.event_type,
  note: r.note,
  drawing: r.drawing_json === null ? null : (JSON.parse(r.drawing_json) as DrawingFields),
  createdAt: r.created_at,
});
const decodePlaylist = (st: Readers, r: PlaylistRow): PlaylistFields => ({
  id: r.id,
  orgId: r.org_id,
  name: r.name,
  createdBy: { userId: r.created_by_user_id, name: r.created_by_name },
  segmentIds: (st.plSegsBy.all(r.id) as PlSegRow[]).map((x) => x.segment_id),
  createdAt: r.created_at,
});
const DECODE: { [N in ScoutingAssessmentsCollection]: (st: Readers, row: Row) => FieldsOf[N] } = {
  assessmentTemplates: (st, row) => decodeTemplate(st, row as TemplateRow),
  assessments: (st, row) => decodeAssessment(st, row as AssessmentRow),
  videoSegments: (st, row) => decodeSegment(st, row as SegmentRow),
  playlists: (st, row) => decodePlaylist(st, row as PlaylistRow),
};
const BATCH_KEY: Partial<Record<ScoutingAssessmentsCollection, keyof BatchIds>> = {
  assessments: 'assessmentIds',
  videoSegments: 'segmentIds',
  playlists: 'playlistIds',
};

// ------------------------------------------------------------------ the rules the code keeps, named with ids before the engine would
const templateKey = (id: string, version: number) => `${id}@${version}`;
export const scoutingAssessmentsLive = (sqlite: DatabaseSync) =>
  migrationApplied(sqlite, SCOUTING_ASSESSMENTS_MIGRATION);
const PLAYER_REFS_SQL = {
  assessments: 'SELECT player_id AS pid FROM assessments',
  videoSegments: 'SELECT player_id AS pid FROM video_segments',
} as const;
type PlayerRefCounts = Record<keyof typeof PLAYER_REFS_SQL, number>;
const playerRefCounts = (sqlite: DatabaseSync, cond: string): PlayerRefCounts =>
  Object.fromEntries(
    Object.entries(PLAYER_REFS_SQL).map(([c, sql]) => [
      c,
      (sqlite.prepare(`SELECT count(*) AS n FROM (${sql}) x WHERE ${cond}`).get() as { n: number }).n,
    ]),
  ) as PlayerRefCounts;
export const unresolvedPlayerReferences = (sqlite: DatabaseSync): PlayerRefCounts | null =>
  scoutingAssessmentsLive(sqlite)
    ? playerRefCounts(sqlite, 'NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid)')
    : null;
export const retainedPlayerReferences = (sqlite: DatabaseSync): PlayerRefCounts | null =>
  scoutingAssessmentsLive(sqlite)
    ? playerRefCounts(sqlite, 'EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid AND p.deleted_at IS NOT NULL)')
    : null;

function readAll(sqlite: DatabaseSync): ScoutingAssessmentsRecords {
  const st = statements(sqlite);
  const as = st.assessmentAll.all() as AssessmentRow[];
  const sg = st.segmentAll.all() as SegmentRow[];
  const pl = st.playlistAll.all() as PlaylistRow[];
  const bst = batchStatements(sqlite, st, {
    assessmentIds: as.map((r) => r.id),
    segmentIds: sg.map((r) => r.id),
    playlistIds: pl.map((r) => r.id),
  });
  return {
    assessmentTemplates: (st.templateAll.all() as TemplateRow[]).map((r) => decodeTemplate(st, r)),
    assessments: as.map((r) => decodeAssessment(bst, r)),
    videoSegments: sg.map((r) => decodeSegment(bst, r)),
    playlists: pl.map((r) => decodePlaylist(bst, r)),
  };
}

/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const SCOUTING_ASSESSMENTS_RECORDS = {
  names: SCOUTING_ASSESSMENTS_COLLECTIONS,
  read(sqlite: DatabaseSync): ScoutingAssessmentsRecords | null {
    return scoutingAssessmentsLive(sqlite) ? readAll(sqlite) : null;
  },
};

/** Migration 0020's catalogue rows: the four v1 templates, stamped with the migration's clock. */
export function insertSeedTemplates(sqlite: DatabaseSync, now: number) {
  const st = statements(sqlite);
  for (const t of SEED_TEMPLATES) writeTemplate(st, { ...(t as SeedTemplateFields), createdAt: now });
}

// ------------------------------------------------------------------ the repository
/**
 * `createScoutingAssessmentsRepository({ sqlite, unit, now, log })`: `templates`, `assessments`, `segments` and
 * `playlists`, each with its writes and queries, plus `reads` (the queries alone, for `scoutingReads`).
 */
export function createScoutingAssessmentsRepository(
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
  if (!sqlite) throw new TypeError('the scouting assessments repository needs a SQLite connection (node:sqlite)');
  const st = statements(sqlite);
  const operation = operationOn(sqlite, unit);
  type Kept = Exclude<ScoutingAssessmentsCollection, 'assessmentTemplates'>;
  const rowById: Record<Kept, StatementSync> = {
    assessments: st.assessmentById,
    videoSegments: st.segmentById,
    playlists: st.playlistById,
  };
  const decode = <N extends ScoutingAssessmentsCollection>(name: N, row: Row): RecordOf[N] =>
    deepFreeze(DECODE[name](st, row)) as RecordOf[N];
  const decodeAll = <N extends ScoutingAssessmentsCollection>(name: N, rows: Row[]): RecordOf[N][] => {
    const key = BATCH_KEY[name];
    if (!key || rows.length < 2) return rows.map((r) => decode(name, r));
    const bst = batchStatements(sqlite, st, { [key]: rows.map((r) => r.id as string) });
    return rows.map((r) => deepFreeze(DECODE[name](bst, r)) as RecordOf[N]);
  };
  const read = <N extends Kept>(name: N, id: unknown): RecordOf[N] | null => {
    if (typeof id !== 'string') return null;
    const row = rowById[name].get(id);
    return row ? decode(name, row) : null;
  };
  const must = <N extends Kept>(name: N, id: string): RecordOf[N] => {
    const r = read(name, id);
    if (!r) throw refusal('SCOUTING_NOT_FOUND', `${TABLE_OF[name]} ${id} is not a record of the repository`);
    return r;
  };
  const typedOr = <N extends ScoutingAssessmentsCollection>(name: N, raw: unknown): TypedFieldsOf[N] => {
    const t = TYPERS[name](raw, name);
    if (!t.ok) throw refusal('SCOUTING_INPUT_INVALID', t.reason);
    return t.record;
  };
  const list = <N extends ScoutingAssessmentsCollection, A extends SQLInputValue[]>(name: N, sql: string) => {
    const stmt = sqlite.prepare(sql);
    return (...args: A): RecordOf[N][] => decodeAll(name, stmt.all(...args));
  };
  type SegmentOwner = { org_id: string; player_id: string };
  const segmentOwner = (id: string) => st.segmentById.get(id) as SegmentOwner | undefined;
  /** The rule a single write keeps that a column cannot: an assessment's cited segments belong to its club and player. */
  const checkAssessment = (r: StoredAssessmentFields) => {
    if (!st.templateBy.get(r.templateId, r.templateVersion))
      throw refusal(
        'SCOUTING_REFERENCE_MISSING',
        `assessments ${r.id} → assessment_templates ${templateKey(r.templateId, r.templateVersion)}`,
      );
    for (const rt of r.ratings)
      for (const ref of rt.evidenceRefs) {
        if (!ref.segmentId) continue;
        const s = segmentOwner(ref.segmentId);
        if (!s || s.org_id !== r.orgId || s.player_id !== r.playerId)
          throw refusal(
            'SCOUTING_REFERENCE_MISSING',
            `assessments ${r.id} ${rt.attrId} cites ${ref.segmentId}, which is not a segment of this club and player`,
          );
      }
  };
  /** A playlist names only segments of its own club. */
  const checkPlaylist = (r: { id: string; orgId: string; segmentIds: readonly string[] }) => {
    for (const s of r.segmentIds) {
      const row = segmentOwner(s);
      if (!row || row.org_id !== r.orgId)
        throw refusal(
          'SCOUTING_REFERENCE_MISSING',
          `playlists ${r.id} names ${s}, which is not a segment of this club`,
        );
    }
  };
  const CHECKS: { [N in Kept]?: (r: TypedFieldsOf[N]) => void } = {
    assessments: checkAssessment,
    playlists: checkPlaylist,
  };
  const create =
    <N extends Kept>(name: N) =>
    (raw: InputOf[N]): RecordOf[N] =>
      operation(() => {
        const r = typedOr(name, raw);
        if (rowById[name].get(r.id)) throw refusal('SCOUTING_DUPLICATE', `${TABLE_OF[name]} ${r.id} already exists`);
        CHECKS[name]?.(r);
        WRITERS[name](st, r);
        return must(name, r.id);
      });
  const { guarded, actsOn } = writeKit(sqlite, 'SCOUTING');
  /**
   * The assessment's acts. A draft is revised (ratings, context, recommendation) until it is submitted; a submitted
   * one is reviewed once; feedback is published once from a submitted one. Each is guarded in SQL by that state.
   */
  const assessmentWrites = actsOn(
    {
      operation,
      label: 'assessments',
      must: (id) => must('assessments', id),
      history: historyOf('assessment_history', 'assessment_id'),
    },
    {
      revise: (id, { ratings, context, recommendation }: AssessmentRevision, stored: Assessment) => {
        const next = typedOr('assessments', {
          ...clone(stored),
          ...(ratings !== undefined ? { ratings } : {}),
          ...(context !== undefined ? { context } : {}),
          ...(recommendation !== undefined ? { recommendation } : {}),
        });
        checkAssessment(next);
        guarded(
          'assessments',
          { id },
          "state = 'draft'",
          {
            ...(context !== undefined ? contextCols(next.context) : {}),
            ...(recommendation !== undefined ? recommendationCols(next.recommendation) : {}),
          },
          `assessments ${id} is no longer a draft`,
        );
        if (ratings !== undefined) writeRatings(st, id, next.ratings);
      },
      submit: (id, { at }: { at: number }) =>
        guarded(
          'assessments',
          { id },
          "state = 'draft'",
          { state: 'submitted', submitted_at: at },
          `assessments ${id} is already submitted`,
        ),
      review: (id, { at, note = null }: { at: number; note?: string | null }) =>
        guarded(
          'assessments',
          { id },
          "state = 'submitted'",
          { state: 'reviewed', reviewed_at: at, review_note: note },
          `assessments ${id} is not awaiting review`,
        ),
      publishFeedback: (id, { text, byUserId, byName, at }: PublishedFeedbackInput) =>
        guarded(
          'assessments',
          { id },
          "state <> 'draft' AND published_feedback_text IS NULL",
          {
            published_feedback_text: text,
            published_feedback_by_user_id: byUserId,
            published_feedback_by_name: byName,
            published_feedback_at: at,
          },
          `assessments ${id}: feedback is published once, from a submitted assessment`,
        ),
    },
  );
  const playlistWrites = actsOn(
    { operation, label: 'playlists', must: (id) => must('playlists', id) },
    {
      /** Add a segment of the playlist's club at the end; a segment already on it is refused. */
      addSegment: (id, { segmentId }: { segmentId: string }, stored: Playlist) => {
        checkPlaylist({ ...stored, segmentIds: [...stored.segmentIds, segmentId] });
        if (stored.segmentIds.includes(segmentId))
          throw refusal('SCOUTING_STATE_CONFLICT', `playlists ${id} already holds ${segmentId}`);
        st.plSeg.run(plSegRow(id, segmentId, stored.segmentIds.length));
      },
    },
  );

  const templateRows = st.templateAll;
  const latestOfGroup = sqlite.prepare(
    'SELECT * FROM assessment_templates WHERE position_group = ? ORDER BY version DESC LIMIT 1',
  );
  const latestOfId = sqlite.prepare('SELECT * FROM assessment_templates WHERE id = ? ORDER BY version DESC LIMIT 1');
  const decodeTemplateRow = (r: Row | undefined): AssessmentTemplate | null =>
    r ? decode('assessmentTemplates', r) : null;
  const templateWrites = {
    /** A new version (append-only). Its version must be the next one of its position group. */
    create: (raw: AssessmentTemplateInput): AssessmentTemplate =>
      operation(() => {
        const t = typedOr('assessmentTemplates', raw);
        const latest = latestOfGroup.get(t.positionGroup) as TemplateRow | undefined;
        if (t.version !== (latest?.version ?? 0) + 1)
          throw refusal(
            'SCOUTING_INPUT_INVALID',
            `assessment_templates ${t.id}: version ${t.version} is not the next version of ${t.positionGroup}`,
          );
        writeTemplate(st, t);
        return decodeTemplateRow(st.templateBy.get(t.id, t.version)) as AssessmentTemplate;
      }),
  };
  const templates = {
    ...templateWrites,
    /** Every version of every template, in the order they were published. */
    all: (): AssessmentTemplate[] => templateRows.all().map((r) => decode('assessmentTemplates', r)),
    /** The newest version for a position group, or null. */
    currentFor: (positionGroup: unknown) =>
      typeof positionGroup === 'string' ? decodeTemplateRow(latestOfGroup.get(positionGroup)) : null,
    /** The newest version of template `id`, or null. */
    currentById: (id: unknown) => (typeof id === 'string' ? decodeTemplateRow(latestOfId.get(id)) : null),
    /** One exact version, or null. */
    byIdVersion: (id: unknown, version: unknown) =>
      typeof id === 'string' && isInt(version) ? decodeTemplateRow(st.templateBy.get(id, version)) : null,
  };
  const anyForTrial = sqlite.prepare('SELECT 1 FROM assessments WHERE context_trial_id = ? LIMIT 1');
  const redact = sqlite.prepare('UPDATE assessments SET player_name = NULL WHERE player_id = ?');
  const assessmentOwnWrites = {
    create: create('assessments'),
    /** Account deletion: the assessments stay (the club's own records) and the player's name goes from them. */
    redactPlayer: (playerId: string): number => operation(() => Number(redact.run(playerId).changes)),
  };
  const assessments = {
    ...assessmentOwnWrites,
    ...assessmentWrites,
    byId: (id: unknown) => read('assessments', id),
    /** One club's assessments, oldest first. */
    forOrg: list<'assessments', [orgId: string]>(
      'assessments',
      'SELECT * FROM assessments WHERE org_id = ? ORDER BY rowid',
    ),
    /** One club's assessments of one player, oldest first (the blind rule, the Room, the journey). */
    forOrgPlayer: list<'assessments', [orgId: string, playerId: string]>(
      'assessments',
      'SELECT * FROM assessments WHERE org_id = ? AND player_id = ? ORDER BY rowid',
    ),
    /** One scout's assessments at their club, oldest first. */
    forOrgScout: list<'assessments', [orgId: string, scoutUserId: string]>(
      'assessments',
      'SELECT * FROM assessments WHERE org_id = ? AND scout_user_id = ? ORDER BY rowid',
    ),
    /** Every club's assessments of one player, oldest first (the passport export, the evidence links). */
    forPlayer: list<'assessments', [playerId: string]>(
      'assessments',
      'SELECT * FROM assessments WHERE player_id = ? ORDER BY rowid',
    ),
    /** One player's assessments whose feedback a club published, oldest first. */
    withFeedbackForPlayer: list<'assessments', [playerId: string]>(
      'assessments',
      'SELECT * FROM assessments WHERE player_id = ? AND published_feedback_at IS NOT NULL ORDER BY rowid',
    ),
    /** Does any assessment name trial `trialId`? */
    anyForTrial: (trialId: string): boolean => !!anyForTrial.get(trialId),
  };
  const segmentsOfOrg = sqlite.prepare(
    'SELECT * FROM video_segments WHERE org_id = @org AND (@player IS NULL OR player_id = @player) AND (@media IS NULL OR media_id = @media) ORDER BY rowid',
  );
  const segmentWrites = { create: create('videoSegments') };
  const segments = {
    ...segmentWrites,
    byId: (id: unknown) => read('videoSegments', id),
    /** One club's segments, oldest first, optionally narrowed to a player and/or a media item. */
    forOrg(
      orgId: string,
      { playerId = null, mediaId = null }: { playerId?: string | null; mediaId?: string | null } = {},
    ): VideoSegment[] {
      return decodeAll('videoSegments', segmentsOfOrg.all({ org: orgId, player: playerId, media: mediaId }));
    },
  };
  const playlistOwnWrites = { create: create('playlists') };
  const playlists = {
    ...playlistOwnWrites,
    ...playlistWrites,
    byId: (id: unknown) => read('playlists', id),
    forOrg: list<'playlists', [orgId: string]>('playlists', 'SELECT * FROM playlists WHERE org_id = ? ORDER BY rowid'),
  };
  const writeKeys = <T extends object>(_repo: T, ...w: object[]) => w.flatMap((o) => Object.keys(o)) as (keyof T)[];
  const counters = Object.fromEntries(
    SCOUTING_ASSESSMENTS_COLLECTIONS.map((n) => [n, sqlite.prepare(`SELECT COUNT(*) AS n FROM ${TABLE_OF[n]}`)]),
  ) as Record<ScoutingAssessmentsCollection, StatementSync>;
  return {
    templates,
    assessments,
    segments,
    playlists,
    /** The queries alone, for modules and projectors that must not write (`scoutingReads`). */
    reads: Object.freeze({
      templates: readsOf(templates, writeKeys(templates, templateWrites)),
      assessments: readsOf(assessments, writeKeys(assessments, assessmentOwnWrites, assessmentWrites)),
      segments: readsOf(segments, writeKeys(segments, segmentWrites)),
      playlists: readsOf(playlists, writeKeys(playlists, playlistOwnWrites, playlistWrites)),
    }),
    attach() {
      if (!scoutingAssessmentsLive(sqlite))
        throw new Error(
          `the scouting assessments repository needs ${SCOUTING_ASSESSMENTS_MIGRATION} recorded; it never imports an in-memory array`,
        );
      return { counts: this.counts() };
    },
    counts(): Record<ScoutingAssessmentsCollection, number> {
      return Object.fromEntries(
        SCOUTING_ASSESSMENTS_COLLECTIONS.map((n) => [n, (counters[n].get() as { n: number }).n]),
      ) as Record<ScoutingAssessmentsCollection, number>;
    },
    exportAll(): ScoutingAssessmentsRecords | null {
      return SCOUTING_ASSESSMENTS_RECORDS.read(sqlite);
    },
    log,
    now,
  };
}
export type ScoutingAssessmentsRepository = ReturnType<typeof createScoutingAssessmentsRepository>;
export type ScoutingAssessmentsReads = ScoutingAssessmentsRepository['reads'];
