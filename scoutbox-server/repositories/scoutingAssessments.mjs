/**
 * Assessment templates, assessments, video segments and playlists.
 *
 * Tables: assessment_templates, assessment_template_attributes; assessments, assessment_ratings,
 * assessment_rating_refs, assessment_history; video_segments, video_segment_labels; playlists, playlist_segments.
 * Every field is a typed column with its vocabulary and length CHECKs. A segment's drawing is the one JSON column: an
 * overlay the client draws and the server never reads, kept as data (no app sends one today). A record the columns
 * cannot hold is refused with its id at the repository (the routes check first and answer 400).
 *
 * WRITES are explicit. Templates are append-only (`templates.create`); a new version never changes an old one.
 * Assessments and playlists have `create(record)` and `update(id, (draft) => …)`, typed whole and written at once;
 * segments are never edited (`segments.create`). Writes join the open unit of work, the caller's transaction, or a
 * transaction of their own. An unknown field is refused, and so is an update of a record from inside its own update.
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
import { isPlainObject, ids, describe } from './recruitment.mjs';
import { transaction, migrationApplied, childRowsOf } from './database.mjs';
import { txt, historyTable, refusal, isInt, isStr, nonEmpty, orNull, clone, bad, optText, reqText, optInstant, reqInstant, unknownFields, first, typeHistory, typeList, histRow, histOut, deepFreeze } from './scoutingEvidence.mjs';

export const SCOUTING_ASSESSMENTS_MIGRATION = '0020_scouting_assessments';
export const SCOUTING_ASSESSMENTS_COLLECTIONS = Object.freeze(['assessmentTemplates', 'assessments', 'videoSegments', 'playlists']);
export const SCOUTING_ASSESSMENTS_TABLES = Object.freeze([
  'assessment_templates', 'assessment_template_attributes', 'assessments', 'assessment_ratings', 'assessment_rating_refs',
  'assessment_history', 'video_segments', 'video_segment_labels', 'playlists', 'playlist_segments',
]);

export const POSITION_GROUPS = Object.freeze(['GK', 'DEF', 'MID', 'ATT']);
export const ASSESSMENT_STATES = Object.freeze(['draft', 'submitted', 'reviewed']);
export const CONFIDENCE_LEVELS = Object.freeze(['low', 'medium', 'high']);
export const VERDICTS = Object.freeze(['sign', 'monitor', 'pass']);
export const VIEWINGS = Object.freeze(['live', 'video']);
/** The anchor levels a template attribute may describe (a 3 means the sentence, not a feeling). */
export const ANCHOR_LEVELS = Object.freeze(['1', '2', '3', '4', '5']);
/** Limits: the routes shorten longer text to these; the columns refuse anything longer. */
export const ASSESSMENT_LIMITS = Object.freeze({
  attrId: 40, attrLabel: 80, anchor: 200, attributes: 20, name: 200, fixture: 120, opponentLevel: 60, reasons: 500,
  reviewNote: 300, feedback: 800, ratingNote: 300, refs: 6, refLabel: 80, ref: 80, minutesWatched: 600,
  labels: 8, label: 30, eventType: 40, segmentNote: 300, drawing: 4000, segmentSeconds: 600, playlistName: 80,
});
const L = ASSESSMENT_LIMITS;
const REF_KEYS = Object.freeze(['segmentId', 'trialSessionId', 'boxSessionId', 't', 'label']);
const CONTEXT_KEYS = Object.freeze(['fixture', 'date', 'minutesWatched', 'viewing', 'opponentLevel', 'trialId', 'trialSessionId']);

// ------------------------------------------------------------------ the v1 templates (inserted by migration 0020)
// Position-specific templates with DESCRIPTIVE anchors: a 3 means the sentence, not a feeling.
const anchor = (a1, a3, a5) => ({ 1: a1, 3: a3, 5: a5 });
const T = (positionGroup, attributes) => ({ id: `tpl-${positionGroup.toLowerCase()}`, positionGroup, version: 1, createdBy: 'seed', attributes: attributes.map(([id, label, anchors]) => ({ id, label, anchors })) });
export const SEED_TEMPLATES = Object.freeze([
  T('GK', [
    ['shot_stopping', 'Shot stopping', anchor('Beaten by savable strikes', 'Makes the expected saves', 'Repeatedly saves strikes most keepers concede')],
    ['distribution', 'Distribution', anchor('Kicks are a turnover', 'Safe short + adequate long', 'Starts attacks under pressure')],
    ['command_of_area', 'Command of area', anchor('Stays rooted on crosses', 'Claims the straightforward ball', 'Owns the box, organises the line')],
    ['one_v_one', '1v1', anchor('Commits early, easily rounded', 'Delays and narrows angles', 'Consistently wins clean 1v1s')],
  ]),
  T('DEF', [
    ['positioning', 'Positioning', anchor('Caught ball-watching', 'Holds the line, tracks runners', 'Reads danger two passes early')],
    ['duels', 'Duels (ground + air)', anchor('Loses most contests', 'Breaks even vs like-for-like', 'Dominant in both phases')],
    ['first_pass', 'First pass out', anchor('Clears blind', 'Finds the free full-back', 'Breaks a line on the ground')],
    ['recovery_pace', 'Recovery pace', anchor('Exposed in space', 'Copes with average movers', 'Recovers vs quick attackers')],
  ]),
  T('MID', [
    ['receiving', 'Receiving under pressure', anchor('Hides from the ball', 'Keeps it simple, keeps it safe', 'Wants it in traffic, turns out of it')],
    ['progression', 'Ball progression', anchor('Sideways and backwards only', 'Moves play forward when on', 'Consistently breaks lines by pass or carry')],
    ['defensive_work', 'Defensive contribution', anchor('Jogs back', 'Screens and tracks adequately', 'Wins it back high, reads screens')],
    ['tempo', 'Tempo control', anchor('Rushes everything', 'Plays at the game’s pace', 'Dictates the game’s pace')],
  ]),
  T('ATT', [
    ['finishing', 'Finishing', anchor('Snatches at chances', 'Buries the clear ones', 'Finishes half-chances both feet')],
    ['movement', 'Movement off the ball', anchor('Static, marks himself', 'Finds space in rotation', 'Constantly unbalances the back line')],
    ['first_touch', 'First touch', anchor('Touch escapes under pressure', 'Controls with time', 'Kills any ball instantly under pressure')],
    ['pressing', 'Pressing', anchor('No defensive effort', 'Presses on triggers', 'First defender, sets the press')],
  ]),
].map((t) => deepFreeze(t)));

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
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const dayOnly = (v) => isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v);
const objectAt = (raw, at) => (isPlainObject(raw) ? null : { ok: false, reason: `${at} is not an object (${describe(raw)})` });
const idOf = (raw, at) => (nonEmpty(raw.id) ? null : bad(at, 'id', 'must be a non-empty string'));
const named = (v, at, field) => (isPlainObject(v) && nonEmpty(v.userId) && nonEmpty(v.name) && v.name.length <= L.name && Object.keys(v).every((k) => ['userId', 'name'].includes(k)) ? null : bad(at, field, 'must be {userId, name}'));

function typeAttribute(a, at) {
  const problem = objectAt(a, at) ?? first(unknownFields(a, at, ['id', 'label', 'anchors']), reqText(a, at, 'id', L.attrId), reqText(a, at, 'label', L.attrLabel));
  if (problem) return problem;
  const anchors = a.anchors ?? {};
  if (!isPlainObject(anchors) || Object.entries(anchors).some(([k, v]) => !ANCHOR_LEVELS.includes(k) || !nonEmpty(v) || v.length > L.anchor)) return bad(at, 'anchors', `must map levels ${ANCHOR_LEVELS.join('|')} to text of at most ${L.anchor} characters`);
  return { ok: true, record: { id: a.id, label: a.label, anchors: Object.fromEntries(ANCHOR_LEVELS.filter((l) => anchors[l] !== undefined).map((l) => [l, anchors[l]])) } };
}
const TEMPLATE_FIELDS = ['id', 'positionGroup', 'version', 'createdAt', 'createdBy', 'attributes'];
/** A template version, typed. `{ ok, record }` or `{ ok: false, reason }` naming the field, never its content. */
export function typeTemplate(raw, at = 'assessmentTemplates') {
  const head = objectAt(raw, at) ?? idOf(raw, at); if (head) return head;
  const label = `${at} ${raw.id}`;
  const problem = first(unknownFields(raw, label, TEMPLATE_FIELDS), reqInstant(raw, label, 'createdAt'), reqText(raw, label, 'createdBy', L.name));
  if (problem) return problem;
  if (!POSITION_GROUPS.includes(raw.positionGroup)) return bad(label, 'positionGroup', `must be one of ${POSITION_GROUPS.join('|')}`);
  if (!isInt(raw.version) || raw.version < 1) return bad(label, 'version', 'must be an integer of at least 1');
  if (!Array.isArray(raw.attributes) || raw.attributes.length < 2 || raw.attributes.length > L.attributes) return bad(label, 'attributes', `must list 2 to ${L.attributes} attributes`);
  const attributes = [];
  for (let i = 0; i < raw.attributes.length; i++) {
    const t = typeAttribute(raw.attributes[i], `${label}.attributes[${i}]`); if (!t.ok) return t;
    if (attributes.some((x) => x.id === t.record.id)) return bad(`${label}.attributes[${i}]`, 'id', 'names an attribute twice');
    attributes.push(t.record);
  }
  return { ok: true, record: { id: raw.id, positionGroup: raw.positionGroup, version: raw.version, createdAt: raw.createdAt, createdBy: raw.createdBy, attributes } };
}

function typeRef(ref, at) {
  const problem = objectAt(ref, at) ?? first(unknownFields(ref, at, REF_KEYS), optText(ref, at, 'segmentId', L.ref), optText(ref, at, 'trialSessionId', L.ref), optText(ref, at, 'boxSessionId', L.ref), optText(ref, at, 'label', L.refLabel));
  if (problem) return problem;
  if (ref.t !== undefined && ref.t !== null && !(isNum(ref.t) && ref.t >= 0)) return bad(at, 't', 'must be a number of seconds (0 or more) or null');
  return { ok: true, record: Object.fromEntries(REF_KEYS.filter((k) => ref[k] !== undefined && ref[k] !== null).map((k) => [k, ref[k]])) };
}
function typeRating(r, at) {
  const problem = objectAt(r, at) ?? first(unknownFields(r, at, ['attrId', 'rating', 'notObserved', 'confidence', 'note', 'evidenceRefs']), reqText(r, at, 'attrId', L.attrId), optText(r, at, 'note', L.ratingNote));
  if (problem) return problem;
  if (typeof r.notObserved !== 'boolean') return bad(at, 'notObserved', 'must be true or false');
  if (r.notObserved ? r.rating !== null : !(isInt(r.rating) && r.rating >= 1 && r.rating <= 5)) return bad(at, 'rating', r.notObserved ? 'must be null when not observed' : 'must be a whole number from 1 to 5');
  if (!CONFIDENCE_LEVELS.includes(r.confidence)) return bad(at, 'confidence', `must be one of ${CONFIDENCE_LEVELS.join('|')}`);
  if (!Array.isArray(r.evidenceRefs) || r.evidenceRefs.length > L.refs) return bad(at, 'evidenceRefs', `must be a list of at most ${L.refs} references`);
  const refs = [];
  for (let i = 0; i < r.evidenceRefs.length; i++) { const t = typeRef(r.evidenceRefs[i], `${at}.evidenceRefs[${i}]`); if (!t.ok) return t; refs.push(t.record); }
  return { ok: true, record: { attrId: r.attrId, rating: r.rating, notObserved: r.notObserved, confidence: r.confidence, note: orNull(r.note), evidenceRefs: refs } };
}
const ASSESSMENT_FIELDS = ['id', 'orgId', 'playerId', 'playerName', 'scoutUserId', 'scoutName', 'templateId', 'templateVersion', 'attributesSnapshot', 'context', 'ratings', 'state', 'recommendation', 'secondOpinionOf', 'createdAt', 'submittedAt', 'reviewedAt', 'reviewNote', 'publishedFeedback', 'history'];
/** An assessment, typed. `attributesSnapshot` is accepted and dropped: it is the template version's attributes. */
export function typeAssessment(raw, at = 'assessments') {
  const head = objectAt(raw, at) ?? idOf(raw, at); if (head) return head;
  const label = `${at} ${raw.id}`;
  const problem = first(unknownFields(raw, label, ASSESSMENT_FIELDS), reqText(raw, label, 'orgId', 80), reqText(raw, label, 'playerId', 80), optText(raw, label, 'playerName', L.name), reqText(raw, label, 'scoutUserId', 80), reqText(raw, label, 'scoutName', L.name),
    reqText(raw, label, 'templateId', 80), optText(raw, label, 'secondOpinionOf', 80), reqInstant(raw, label, 'createdAt'), optInstant(raw, label, 'submittedAt'), optInstant(raw, label, 'reviewedAt'), optText(raw, label, 'reviewNote', L.reviewNote));
  if (problem) return problem;
  if (!isInt(raw.templateVersion) || raw.templateVersion < 1) return bad(label, 'templateVersion', 'must be an integer of at least 1');
  if (!ASSESSMENT_STATES.includes(raw.state)) return bad(label, 'state', `must be one of ${ASSESSMENT_STATES.join('|')}`);
  const c = raw.context ?? {};
  const cAt = `${label}.context`;
  const cp = objectAt(c, cAt) ?? first(unknownFields(c, cAt, CONTEXT_KEYS), optText(c, cAt, 'fixture', L.fixture), optText(c, cAt, 'opponentLevel', L.opponentLevel), optText(c, cAt, 'trialId', 80), optText(c, cAt, 'trialSessionId', 80));
  if (cp) return cp;
  if (c.date !== undefined && c.date !== null && !dayOnly(c.date)) return bad(cAt, 'date', 'must be a YYYY-MM-DD day or null');
  if (c.minutesWatched !== undefined && c.minutesWatched !== null && !(isInt(c.minutesWatched) && c.minutesWatched >= 1 && c.minutesWatched <= L.minutesWatched)) return bad(cAt, 'minutesWatched', `must be a whole number of minutes from 1 to ${L.minutesWatched} or null`);
  if (c.viewing !== undefined && c.viewing !== null && !VIEWINGS.includes(c.viewing)) return bad(cAt, 'viewing', `must be one of ${VIEWINGS.join('|')} or null`);
  if (c.trialSessionId && !c.trialId) return bad(cAt, 'trialSessionId', 'needs the trialId too');
  const ratings = [];
  if (raw.ratings !== undefined && raw.ratings !== null) {
    if (!Array.isArray(raw.ratings)) return bad(label, 'ratings', 'must be a list');
    for (let i = 0; i < raw.ratings.length; i++) {
      const t = typeRating(raw.ratings[i], `${label}.ratings[${i}]`); if (!t.ok) return t;
      if (ratings.some((x) => x.attrId === t.record.attrId)) return bad(`${label}.ratings[${i}]`, 'attrId', 'rates an attribute twice');
      ratings.push(t.record);
    }
  }
  let recommendation = null;
  if (raw.recommendation !== undefined && raw.recommendation !== null) {
    const r = raw.recommendation;
    if (!isPlainObject(r) || !VERDICTS.includes(r.verdict) || !isStr(r.reasons) || r.reasons.length > L.reasons || Object.keys(r).some((k) => !['verdict', 'reasons'].includes(k))) return bad(label, 'recommendation', `must be {verdict: ${VERDICTS.join('|')}, reasons} or null`);
    recommendation = { verdict: r.verdict, reasons: r.reasons };
  }
  let publishedFeedback = null;
  if (raw.publishedFeedback !== undefined && raw.publishedFeedback !== null) {
    const f = raw.publishedFeedback; const fAt = `${label}.publishedFeedback`;
    const fp = objectAt(f, fAt) ?? first(unknownFields(f, fAt, ['text', 'byUserId', 'byName', 'at']), reqText(f, fAt, 'text', L.feedback), reqText(f, fAt, 'byUserId', 80), reqText(f, fAt, 'byName', L.name), reqInstant(f, fAt, 'at'));
    if (fp) return fp;
    if (raw.state === 'draft') return bad(label, 'publishedFeedback', 'cannot be published from a draft');
    publishedFeedback = { text: f.text, byUserId: f.byUserId, byName: f.byName, at: f.at };
  }
  if ((raw.state === 'draft') !== (raw.submittedAt === undefined || raw.submittedAt === null)) return bad(label, 'submittedAt', raw.state === 'draft' ? 'must be null on a draft' : 'is required once submitted');
  if ((raw.state === 'reviewed') !== (raw.reviewedAt !== undefined && raw.reviewedAt !== null)) return bad(label, 'reviewedAt', raw.state === 'reviewed' ? 'is required once reviewed' : 'must be null before review');
  if (raw.reviewNote && raw.state !== 'reviewed') return bad(label, 'reviewNote', 'exists only after review');
  if (raw.secondOpinionOf && raw.secondOpinionOf === raw.id) return bad(label, 'secondOpinionOf', 'names the record itself');
  const history = typeList(raw.history, `${label}.history`, typeHistory, ['org']); if (!history.ok) return history;
  return {
    ok: true,
    record: {
      id: raw.id, orgId: raw.orgId, playerId: raw.playerId, playerName: orNull(raw.playerName), scoutUserId: raw.scoutUserId, scoutName: raw.scoutName,
      templateId: raw.templateId, templateVersion: raw.templateVersion,
      context: { fixture: orNull(c.fixture), date: orNull(c.date), minutesWatched: orNull(c.minutesWatched), viewing: orNull(c.viewing), opponentLevel: orNull(c.opponentLevel), trialId: orNull(c.trialId), trialSessionId: orNull(c.trialSessionId) },
      ratings, state: raw.state, recommendation, secondOpinionOf: orNull(raw.secondOpinionOf),
      createdAt: raw.createdAt, submittedAt: orNull(raw.submittedAt), reviewedAt: orNull(raw.reviewedAt), reviewNote: orNull(raw.reviewNote), publishedFeedback, history: history.list,
    },
  };
}

const SEGMENT_FIELDS = ['id', 'mediaId', 'playerId', 'orgId', 'createdBy', 'startS', 'endS', 'labels', 'eventType', 'note', 'drawing', 'createdAt'];
export function typeSegment(raw, at = 'videoSegments') {
  const head = objectAt(raw, at) ?? idOf(raw, at); if (head) return head;
  const label = `${at} ${raw.id}`;
  const problem = first(unknownFields(raw, label, SEGMENT_FIELDS), reqText(raw, label, 'mediaId', 80), reqText(raw, label, 'playerId', 80), reqText(raw, label, 'orgId', 80), named(raw.createdBy, label, 'createdBy'),
    optText(raw, label, 'eventType', L.eventType), optText(raw, label, 'note', L.segmentNote), reqInstant(raw, label, 'createdAt'));
  if (problem) return problem;
  if (!(isNum(raw.startS) && raw.startS >= 0)) return bad(label, 'startS', 'must be a number of seconds, 0 or more');
  if (!(isNum(raw.endS) && raw.endS > raw.startS && raw.endS - raw.startS <= L.segmentSeconds)) return bad(label, 'endS', `must be after startS, at most ${L.segmentSeconds} seconds later`);
  const labels = raw.labels ?? [];
  if (!Array.isArray(labels) || labels.length > L.labels || labels.some((l) => !nonEmpty(l) || l.length > L.label)) return bad(label, 'labels', `must be at most ${L.labels} labels of at most ${L.label} characters`);
  const drawing = raw.drawing ?? null;
  if (drawing !== null && (!isPlainObject(drawing) || JSON.stringify(drawing).length > L.drawing)) return bad(label, 'drawing', `must be an object of at most ${L.drawing} characters as JSON, or null`);
  return { ok: true, record: { id: raw.id, mediaId: raw.mediaId, playerId: raw.playerId, orgId: raw.orgId, createdBy: { userId: raw.createdBy.userId, name: raw.createdBy.name }, startS: raw.startS, endS: raw.endS, labels: [...labels], eventType: orNull(raw.eventType), note: orNull(raw.note), drawing: clone(drawing), createdAt: raw.createdAt } };
}

const PLAYLIST_FIELDS = ['id', 'orgId', 'name', 'createdBy', 'segmentIds', 'createdAt'];
export function typePlaylist(raw, at = 'playlists') {
  const head = objectAt(raw, at) ?? idOf(raw, at); if (head) return head;
  const label = `${at} ${raw.id}`;
  const problem = first(unknownFields(raw, label, PLAYLIST_FIELDS), reqText(raw, label, 'orgId', 80), reqText(raw, label, 'name', L.playlistName), named(raw.createdBy, label, 'createdBy'), reqInstant(raw, label, 'createdAt'));
  if (problem) return problem;
  const segs = raw.segmentIds ?? [];
  if (!Array.isArray(segs) || segs.some((s) => !nonEmpty(s))) return bad(label, 'segmentIds', 'must be a list of segment ids');
  if (new Set(segs).size !== segs.length) return bad(label, 'segmentIds', 'names a segment twice');
  return { ok: true, record: { id: raw.id, orgId: raw.orgId, name: raw.name, createdBy: { userId: raw.createdBy.userId, name: raw.createdBy.name }, segmentIds: [...segs], createdAt: raw.createdAt } };
}
const TYPERS = { assessmentTemplates: typeTemplate, assessments: typeAssessment, videoSegments: typeSegment, playlists: typePlaylist };
const TABLE_OF = { assessmentTemplates: 'assessment_templates', assessments: 'assessments', videoSegments: 'video_segments', playlists: 'playlists' };

// ------------------------------------------------------------------ rows
const upsert = (table, cols, key = ['id']) => `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})
  ON CONFLICT(${key.join(', ')}) DO UPDATE SET ${cols.filter((c) => !key.includes(c)).map((c) => `${c} = excluded.${c}`).join(', ')}`;
const ASSESSMENT_COLS = ['id', 'org_id', 'player_id', 'player_name', 'scout_user_id', 'scout_name', 'template_id', 'template_version', 'context_fixture', 'context_date', 'context_minutes_watched', 'context_viewing', 'context_opponent_level', 'context_trial_id', 'context_trial_session_id',
  'state', 'recommendation_verdict', 'recommendation_reasons', 'second_opinion_of_id', 'created_at', 'submitted_at', 'reviewed_at', 'review_note', 'published_feedback_text', 'published_feedback_by_user_id', 'published_feedback_by_name', 'published_feedback_at'];
function statements(sqlite) {
  const p = (sql) => sqlite.prepare(sql);
  return {
    template: p(upsert('assessment_templates', ['id', 'version', 'position_group', 'created_at', 'created_by_name'], ['id', 'version'])),
    attributesOf: p('DELETE FROM assessment_template_attributes WHERE template_id = ? AND template_version = ?'),
    attribute: p(`INSERT INTO assessment_template_attributes (template_id, template_version, position, attr_id, label, ${ANCHOR_LEVELS.map((l) => `anchor_${l}`).join(', ')}) VALUES (@template_id, @template_version, @position, @attr_id, @label, ${ANCHOR_LEVELS.map((l) => `@anchor_${l}`).join(', ')})`),
    templateDel: p('DELETE FROM assessment_templates WHERE id = ? AND version = ?'),
    templateAll: p('SELECT * FROM assessment_templates ORDER BY rowid'),
    templateBy: p('SELECT * FROM assessment_templates WHERE id = ? AND version = ?'),
    attributesBy: p('SELECT * FROM assessment_template_attributes WHERE template_id = ? AND template_version = ? ORDER BY position'),
    assessment: p(upsert('assessments', ASSESSMENT_COLS)),
    rating: p('INSERT INTO assessment_ratings (assessment_id, position, attr_id, rating, not_observed, confidence, note) VALUES (@assessment_id, @position, @attr_id, @rating, @not_observed, @confidence, @note)'),
    ref: p('INSERT INTO assessment_rating_refs (assessment_id, rating_position, position, segment_id, trial_session_id, box_session_id, t_s, label) VALUES (@assessment_id, @rating_position, @position, @segment_id, @trial_session_id, @box_session_id, @t_s, @label)'),
    asHist: p('INSERT INTO assessment_history (id, assessment_id, position, at, by_kind, by_id, by_name, action, detail) VALUES (@id, @owner, @position, @at, @by_kind, @by_id, @by_name, @action, @detail)'),
    refsOf: p('DELETE FROM assessment_rating_refs WHERE assessment_id = ?'), ratingsOf: p('DELETE FROM assessment_ratings WHERE assessment_id = ?'), asHistOf: p('DELETE FROM assessment_history WHERE assessment_id = ?'),
    assessmentDel: p('DELETE FROM assessments WHERE id = ?'),
    assessmentById: p('SELECT * FROM assessments WHERE id = ?'), assessmentAll: p('SELECT * FROM assessments ORDER BY rowid'),
    ratingsBy: p('SELECT * FROM assessment_ratings WHERE assessment_id = ? ORDER BY position'),
    refsBy: p('SELECT * FROM assessment_rating_refs WHERE assessment_id = ? AND rating_position = ? ORDER BY position'),
    asHistBy: p('SELECT * FROM assessment_history WHERE assessment_id = ? ORDER BY position'),
    segment: p(upsert('video_segments', ['id', 'media_id', 'player_id', 'org_id', 'created_by_user_id', 'created_by_name', 'start_s', 'end_s', 'event_type', 'note', 'drawing_json', 'created_at'])),
    segLabel: p('INSERT INTO video_segment_labels (segment_id, position, label) VALUES (?, ?, ?)'),
    segLabelsOf: p('DELETE FROM video_segment_labels WHERE segment_id = ?'), segmentDel: p('DELETE FROM video_segments WHERE id = ?'),
    segmentById: p('SELECT * FROM video_segments WHERE id = ?'), segmentAll: p('SELECT * FROM video_segments ORDER BY rowid'),
    segLabelsBy: p('SELECT * FROM video_segment_labels WHERE segment_id = ? ORDER BY position'),
    playlist: p(upsert('playlists', ['id', 'org_id', 'name', 'created_by_user_id', 'created_by_name', 'created_at'])),
    plSeg: p('INSERT INTO playlist_segments (playlist_id, position, segment_id) VALUES (?, ?, ?)'),
    plSegsOf: p('DELETE FROM playlist_segments WHERE playlist_id = ?'), playlistDel: p('DELETE FROM playlists WHERE id = ?'),
    playlistById: p('SELECT * FROM playlists WHERE id = ?'), playlistAll: p('SELECT * FROM playlists ORDER BY rowid'),
    plSegsBy: p('SELECT * FROM playlist_segments WHERE playlist_id = ? ORDER BY position'),
    ids: (table) => sqlite.prepare(`SELECT id FROM ${table} ORDER BY rowid`).all().map((r) => r.id),
  };
}
/** The child statements for many records at once (one query per child table for a whole list). */
function batchStatements(sqlite, st, { assessmentIds = [], segmentIds = [], playlistIds = [] }) {
  return {
    ...st,
    ratingsBy: childRowsOf(sqlite, 'assessment_ratings', 'assessment_id', assessmentIds, { order: 'position' }),
    refsBy: childRowsOf(sqlite, 'assessment_rating_refs', 'assessment_id', assessmentIds, { order: 'rating_position, position', subKey: ['rating_position'] }),
    asHistBy: childRowsOf(sqlite, 'assessment_history', 'assessment_id', assessmentIds, { order: 'position' }),
    segLabelsBy: childRowsOf(sqlite, 'video_segment_labels', 'segment_id', segmentIds, { order: 'position' }),
    plSegsBy: childRowsOf(sqlite, 'playlist_segments', 'playlist_id', playlistIds, { order: 'position' }),
  };
}

function writeTemplate(st, t) {
  st.template.run({ id: t.id, version: t.version, position_group: t.positionGroup, created_at: t.createdAt, created_by_name: t.createdBy });
  st.attributesOf.run(t.id, t.version);
  t.attributes.forEach((a, i) => st.attribute.run({ template_id: t.id, template_version: t.version, position: i, attr_id: a.id, label: a.label, ...Object.fromEntries(ANCHOR_LEVELS.map((l) => [`anchor_${l}`, a.anchors[l] ?? null])) }));
}
function writeAssessment(st, a) {
  const c = a.context;
  st.assessment.run({
    id: a.id, org_id: a.orgId, player_id: a.playerId, player_name: a.playerName, scout_user_id: a.scoutUserId, scout_name: a.scoutName, template_id: a.templateId, template_version: a.templateVersion,
    context_fixture: c.fixture, context_date: c.date, context_minutes_watched: c.minutesWatched, context_viewing: c.viewing, context_opponent_level: c.opponentLevel, context_trial_id: c.trialId, context_trial_session_id: c.trialSessionId,
    state: a.state, recommendation_verdict: a.recommendation?.verdict ?? null, recommendation_reasons: a.recommendation?.reasons ?? null, second_opinion_of_id: a.secondOpinionOf,
    created_at: a.createdAt, submitted_at: a.submittedAt, reviewed_at: a.reviewedAt, review_note: a.reviewNote,
    published_feedback_text: a.publishedFeedback?.text ?? null, published_feedback_by_user_id: a.publishedFeedback?.byUserId ?? null, published_feedback_by_name: a.publishedFeedback?.byName ?? null, published_feedback_at: a.publishedFeedback?.at ?? null,
  });
  st.refsOf.run(a.id); st.ratingsOf.run(a.id); st.asHistOf.run(a.id);
  a.ratings.forEach((r, i) => {
    st.rating.run({ assessment_id: a.id, position: i, attr_id: r.attrId, rating: r.rating, not_observed: r.notObserved ? 1 : 0, confidence: r.confidence, note: r.note });
    r.evidenceRefs.forEach((ref, j) => st.ref.run({ assessment_id: a.id, rating_position: i, position: j, segment_id: ref.segmentId ?? null, trial_session_id: ref.trialSessionId ?? null, box_session_id: ref.boxSessionId ?? null, t_s: ref.t ?? null, label: ref.label ?? null }));
  });
  a.history.forEach((h, i) => st.asHist.run(histRow(a.id, h, i)));
}
function writeSegment(st, s) {
  st.segment.run({ id: s.id, media_id: s.mediaId, player_id: s.playerId, org_id: s.orgId, created_by_user_id: s.createdBy.userId, created_by_name: s.createdBy.name, start_s: s.startS, end_s: s.endS, event_type: s.eventType, note: s.note, drawing_json: s.drawing === null ? null : JSON.stringify(s.drawing), created_at: s.createdAt });
  st.segLabelsOf.run(s.id);
  s.labels.forEach((l, i) => st.segLabel.run(s.id, i, l));
}
function writePlaylist(st, p) {
  st.playlist.run({ id: p.id, org_id: p.orgId, name: p.name, created_by_user_id: p.createdBy.userId, created_by_name: p.createdBy.name, created_at: p.createdAt });
  st.plSegsOf.run(p.id);
  p.segmentIds.forEach((s, i) => st.plSeg.run(p.id, i, s));
}
const WRITERS = { assessmentTemplates: writeTemplate, assessments: writeAssessment, videoSegments: writeSegment, playlists: writePlaylist };

const decodeAttribute = (r) => ({ id: r.attr_id, label: r.label, anchors: Object.fromEntries(ANCHOR_LEVELS.filter((l) => r[`anchor_${l}`] !== null).map((l) => [l, r[`anchor_${l}`]])) });
const decodeTemplate = (st, r) => ({ id: r.id, positionGroup: r.position_group, version: r.version, createdAt: r.created_at, createdBy: r.created_by_name, attributes: st.attributesBy.all(r.id, r.version).map(decodeAttribute) });
const decodeRef = (x) => Object.fromEntries([['segmentId', x.segment_id], ['trialSessionId', x.trial_session_id], ['boxSessionId', x.box_session_id], ['t', x.t_s], ['label', x.label]].filter(([, v]) => v !== null));
function decodeAssessment(st, r) {
  return {
    id: r.id, orgId: r.org_id, playerId: r.player_id, playerName: r.player_name, scoutUserId: r.scout_user_id, scoutName: r.scout_name,
    templateId: r.template_id, templateVersion: r.template_version, attributesSnapshot: st.attributesBy.all(r.template_id, r.template_version).map(decodeAttribute),
    context: { fixture: r.context_fixture, date: r.context_date, minutesWatched: r.context_minutes_watched, viewing: r.context_viewing, opponentLevel: r.context_opponent_level, trialId: r.context_trial_id, trialSessionId: r.context_trial_session_id },
    ratings: st.ratingsBy.all(r.id).map((x) => ({ attrId: x.attr_id, rating: x.rating, notObserved: x.not_observed === 1, confidence: x.confidence, note: x.note, evidenceRefs: st.refsBy.all(r.id, x.position).map(decodeRef) })),
    state: r.state, recommendation: r.recommendation_verdict === null ? null : { verdict: r.recommendation_verdict, reasons: r.recommendation_reasons },
    secondOpinionOf: r.second_opinion_of_id, createdAt: r.created_at, submittedAt: r.submitted_at, reviewedAt: r.reviewed_at, reviewNote: r.review_note,
    publishedFeedback: r.published_feedback_text === null ? null : { text: r.published_feedback_text, byUserId: r.published_feedback_by_user_id, byName: r.published_feedback_by_name, at: r.published_feedback_at },
    history: st.asHistBy.all(r.id).map(histOut),
  };
}
const decodeSegment = (st, r) => ({ id: r.id, mediaId: r.media_id, playerId: r.player_id, orgId: r.org_id, createdBy: { userId: r.created_by_user_id, name: r.created_by_name }, startS: r.start_s, endS: r.end_s, labels: st.segLabelsBy.all(r.id).map((x) => x.label), eventType: r.event_type, note: r.note, drawing: r.drawing_json === null ? null : JSON.parse(r.drawing_json), createdAt: r.created_at });
const decodePlaylist = (st, r) => ({ id: r.id, orgId: r.org_id, name: r.name, createdBy: { userId: r.created_by_user_id, name: r.created_by_name }, segmentIds: st.plSegsBy.all(r.id).map((x) => x.segment_id), createdAt: r.created_at });
const DECODERS = { assessmentTemplates: decodeTemplate, assessments: decodeAssessment, videoSegments: decodeSegment, playlists: decodePlaylist };
const BATCH_KEY = { assessments: 'assessmentIds', videoSegments: 'segmentIds', playlists: 'playlistIds' };

// ------------------------------------------------------------------ the rules the code keeps, named with ids before the engine would
const templateKey = (id, version) => `${id}@${version}`;
export const scoutingAssessmentsLive = (sqlite) => migrationApplied(sqlite, SCOUTING_ASSESSMENTS_MIGRATION);
const PLAYER_REFS_SQL = { assessments: 'SELECT player_id AS pid FROM assessments', videoSegments: 'SELECT player_id AS pid FROM video_segments' };
const playerRefCounts = (sqlite, cond) => Object.fromEntries(Object.entries(PLAYER_REFS_SQL).map(([c, sql]) => [c, sqlite.prepare(`SELECT count(*) AS n FROM (${sql}) x WHERE ${cond}`).get().n]));
export const unresolvedPlayerReferences = (sqlite) => (scoutingAssessmentsLive(sqlite) ? playerRefCounts(sqlite, 'NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid)') : null);
export const retainedPlayerReferences = (sqlite) => (scoutingAssessmentsLive(sqlite) ? playerRefCounts(sqlite, 'EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid AND p.deleted_at IS NOT NULL)') : null);

function readAll(sqlite) {
  const st = statements(sqlite);
  const as = st.assessmentAll.all(); const sg = st.segmentAll.all(); const pl = st.playlistAll.all();
  const bst = batchStatements(sqlite, st, { assessmentIds: as.map((r) => r.id), segmentIds: sg.map((r) => r.id), playlistIds: pl.map((r) => r.id) });
  return {
    assessmentTemplates: st.templateAll.all().map((r) => decodeTemplate(st, r)),
    assessments: as.map((r) => decodeAssessment(bst, r)),
    videoSegments: sg.map((r) => decodeSegment(bst, r)),
    playlists: pl.map((r) => decodePlaylist(bst, r)),
  };
}

/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const SCOUTING_ASSESSMENTS_RECORDS = {
  names: SCOUTING_ASSESSMENTS_COLLECTIONS,
  read(sqlite) { return scoutingAssessmentsLive(sqlite) ? readAll(sqlite) : null; },
};

/** Migration 0020's catalogue rows: the four v1 templates, stamped with the migration's clock. */
export function insertSeedTemplates(sqlite, now) {
  const st = statements(sqlite);
  for (const t of SEED_TEMPLATES) writeTemplate(st, { ...t, createdAt: now });
}

// ------------------------------------------------------------------ the repository
const WRITES = new Set(['create', 'update', 'redactPlayer']);
/**
 * `createScoutingAssessmentsRepository({ sqlite, unit, now, log })`: `templates`, `assessments`, `segments` and
 * `playlists`, each with its writes and queries, plus `reads` (the queries alone, for `scoutingReads`).
 */
export function createScoutingAssessmentsRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the scouting assessments repository needs a SQLite connection (node:sqlite)');
  const st = statements(sqlite);
  const operation = (fn) => (unit?.active?.() ? unit.join(fn) : sqlite.isTransaction ? fn() : transaction(sqlite, fn));
  const rowById = { assessments: st.assessmentById, videoSegments: st.segmentById, playlists: st.playlistById };
  const decode = (name, row) => deepFreeze(DECODERS[name](st, row));
  const decodeAll = (name, rows) => {
    if (!BATCH_KEY[name] || rows.length < 2) return rows.map((r) => decode(name, r));
    const bst = batchStatements(sqlite, st, { [BATCH_KEY[name]]: rows.map((r) => r.id) });
    return rows.map((r) => deepFreeze(DECODERS[name](bst, r)));
  };
  const read = (name, id) => { if (typeof id !== 'string') return null; const row = rowById[name].get(id); return row ? decode(name, row) : null; };
  const must = (name, id) => { const r = read(name, id); if (!r) throw refusal('SCOUTING_NOT_FOUND', `${TABLE_OF[name]} ${id} is not a record of the repository`); return r; };
  const typedOr = (name, raw) => { const t = TYPERS[name](raw, name); if (!t.ok) throw refusal('SCOUTING_INPUT_INVALID', t.reason); return t.record; };
  const list = (name, sql) => { const stmt = sqlite.prepare(sql); return (...args) => decodeAll(name, stmt.all(...args)); };
  const IMMUTABLE = { assessments: ['id', 'orgId', 'playerId', 'scoutUserId', 'templateId', 'templateVersion', 'secondOpinionOf', 'createdAt'], playlists: ['id', 'orgId', 'createdBy', 'createdAt'] };
  const updating = new Set();
  /** The rules a single write keeps that a column cannot: an assessment's cited segments belong to its club and player. */
  const checkOne = (name, r) => {
    if (name === 'assessments') {
      if (!st.templateBy.get(r.templateId, r.templateVersion)) throw refusal('SCOUTING_REFERENCE_MISSING', `assessments ${r.id} → assessment_templates ${templateKey(r.templateId, r.templateVersion)}`);
      for (const rt of r.ratings) for (const ref of rt.evidenceRefs) {
        if (!ref.segmentId) continue;
        const s = st.segmentById.get(ref.segmentId);
        if (!s || s.org_id !== r.orgId || s.player_id !== r.playerId) throw refusal('SCOUTING_REFERENCE_MISSING', `assessments ${r.id} ${rt.attrId} cites ${ref.segmentId}, which is not a segment of this club and player`);
      }
    }
    if (name === 'playlists') for (const s of r.segmentIds) { const row = st.segmentById.get(s); if (!row || row.org_id !== r.orgId) throw refusal('SCOUTING_REFERENCE_MISSING', `playlists ${r.id} names ${s}, which is not a segment of this club`); }
  };
  const create = (name) => (raw) => operation(() => {
    const r = typedOr(name, raw);
    if (rowById[name].get(r.id)) throw refusal('SCOUTING_DUPLICATE', `${TABLE_OF[name]} ${r.id} already exists`);
    checkOne(name, r); WRITERS[name](st, r); return must(name, r.id);
  });
  /**
   * `update(id, change)`: `change` receives a plain copy of the stored record and edits it (or returns a replacement);
   * the result is typed whole and written at once. Identifiers and creation facts cannot change.
   */
  const update = (name) => (id, change) => {
    if (typeof change !== 'function') throw new TypeError(`${name}.update(id, change) needs a function that edits the copy it is given`);
    const key = `${name}/${id}`;
    if (updating.has(key)) throw refusal('SCOUTING_NESTED_UPDATE', `${TABLE_OF[name]} ${id} is already being updated; make the second change after the first returns`);
    updating.add(key);
    try {
      return operation(() => {
        const stored = must(name, id);
        const draft = clone(stored);
        const returned = change(draft);
        const next = typedOr(name, returned === undefined ? draft : returned);
        for (const k of IMMUTABLE[name]) if (JSON.stringify(next[k]) !== JSON.stringify(stored[k])) throw refusal('SCOUTING_INPUT_INVALID', `${TABLE_OF[name]} ${id}: ${k} cannot change`);
        checkOne(name, next); WRITERS[name](st, next); return must(name, id);
      });
    } finally { updating.delete(key); }
  };

  const templateRows = sqlite.prepare('SELECT * FROM assessment_templates ORDER BY rowid');
  const latestOfGroup = sqlite.prepare('SELECT * FROM assessment_templates WHERE position_group = ? ORDER BY version DESC LIMIT 1');
  const latestOfId = sqlite.prepare('SELECT * FROM assessment_templates WHERE id = ? ORDER BY version DESC LIMIT 1');
  const decodeTemplateRow = (r) => (r ? deepFreeze(decodeTemplate(st, r)) : null);
  const templates = {
    /** A new version (append-only). Its version must be the next one of its position group. */
    create: (raw) => operation(() => {
      const t = typedOr('assessmentTemplates', raw);
      const latest = latestOfGroup.get(t.positionGroup);
      if (t.version !== (latest?.version ?? 0) + 1) throw refusal('SCOUTING_INPUT_INVALID', `assessment_templates ${t.id}: version ${t.version} is not the next version of ${t.positionGroup}`);
      writeTemplate(st, t); return decodeTemplateRow(st.templateBy.get(t.id, t.version));
    }),
    /** Every version of every template, in the order they were published. */
    all: () => templateRows.all().map(decodeTemplateRow),
    /** The newest version for a position group, or null. */
    currentFor: (positionGroup) => (typeof positionGroup === 'string' ? decodeTemplateRow(latestOfGroup.get(positionGroup) ?? null) : null),
    /** The newest version of template `id`, or null. */
    currentById: (id) => (typeof id === 'string' ? decodeTemplateRow(latestOfId.get(id) ?? null) : null),
    /** One exact version, or null. */
    byIdVersion: (id, version) => (typeof id === 'string' && isInt(version) ? decodeTemplateRow(st.templateBy.get(id, version) ?? null) : null),
  };
  const anyForTrial = sqlite.prepare('SELECT 1 FROM assessments WHERE context_trial_id = ? LIMIT 1');
  const redact = sqlite.prepare('UPDATE assessments SET player_name = NULL WHERE player_id = ?');
  const assessments = {
    create: create('assessments'), update: update('assessments'),
    /** Account deletion: the assessments stay (the club's own records) and the player's name goes from them. */
    redactPlayer: (playerId) => operation(() => redact.run(playerId).changes),
    byId: (id) => read('assessments', id),
    /** One club's assessments, oldest first. */
    forOrg: list('assessments', 'SELECT * FROM assessments WHERE org_id = ? ORDER BY rowid'),
    /** One club's assessments of one player, oldest first (the blind rule, the Room, the journey). */
    forOrgPlayer: list('assessments', 'SELECT * FROM assessments WHERE org_id = ? AND player_id = ? ORDER BY rowid'),
    /** One scout's assessments at their club, oldest first. */
    forOrgScout: list('assessments', 'SELECT * FROM assessments WHERE org_id = ? AND scout_user_id = ? ORDER BY rowid'),
    /** Every club's assessments of one player, oldest first (the passport export, the evidence links). */
    forPlayer: list('assessments', 'SELECT * FROM assessments WHERE player_id = ? ORDER BY rowid'),
    /** One player's assessments whose feedback a club published, oldest first. */
    withFeedbackForPlayer: list('assessments', 'SELECT * FROM assessments WHERE player_id = ? AND published_feedback_at IS NOT NULL ORDER BY rowid'),
    /** Does any assessment name trial `trialId`? */
    anyForTrial: (trialId) => !!anyForTrial.get(trialId),
  };
  const segmentsOfOrg = sqlite.prepare('SELECT * FROM video_segments WHERE org_id = @org AND (@player IS NULL OR player_id = @player) AND (@media IS NULL OR media_id = @media) ORDER BY rowid');
  const segments = {
    create: create('videoSegments'),
    byId: (id) => read('videoSegments', id),
    /** One club's segments, oldest first, optionally narrowed to a player and/or a media item. */
    forOrg(orgId, { playerId = null, mediaId = null } = {}) {
      return decodeAll('videoSegments', segmentsOfOrg.all({ org: orgId, player: playerId, media: mediaId }));
    },
  };
  const playlists = {
    create: create('playlists'), update: update('playlists'),
    byId: (id) => read('playlists', id),
    forOrg: list('playlists', 'SELECT * FROM playlists WHERE org_id = ? ORDER BY rowid'),
  };
  const readOnly = (o) => Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => !WRITES.has(k))));
  const counters = Object.fromEntries(SCOUTING_ASSESSMENTS_COLLECTIONS.map((n) => [n, sqlite.prepare(`SELECT COUNT(*) AS n FROM ${TABLE_OF[n]}`)]));
  return {
    templates, assessments, segments, playlists,
    /** The queries alone, for modules and projectors that must not write (`scoutingReads`). */
    reads: Object.freeze({ templates: readOnly(templates), assessments: readOnly(assessments), segments: readOnly(segments), playlists: readOnly(playlists) }),
    attach() {
      if (!scoutingAssessmentsLive(sqlite)) throw new Error(`the scouting assessments repository needs ${SCOUTING_ASSESSMENTS_MIGRATION} recorded; it never imports an in-memory array`);
      return { counts: this.counts() };
    },
    counts() { return Object.fromEntries(SCOUTING_ASSESSMENTS_COLLECTIONS.map((n) => [n, counters[n].get().n])); },
    pending: () => 0,
    exportAll() { return SCOUTING_ASSESSMENTS_RECORDS.read(sqlite); },
    log,
    now,
  };
}
