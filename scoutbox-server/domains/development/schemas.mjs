/**
 * Request input for the player's own record (media, medical, attendance, stats, drills), the Grassroots player and
 * club routes (training programme, open days, squad, matchdays, friendlies, coach references) and development
 * objectives. The Hub and Box Cam have their own (hub/schemas.mjs, boxcam/schemas.mjs).
 *
 * The routes keep the codes the apps already read: TITLE_REQUIRED, BADGES_MUST_BE_ARRAY, BAD_COORDINATES,
 * BAD_AVAILABILITY, BAD_CONTRACT_STATUS, ATTENDANCE_UNVERIFIABLE, GPS_INVALID, YEAR_AND_EVENT_REQUIRED, BAD_STAT,
 * BAD_VALUE, TRACK_NOT_FOUND, COACH_DETAILS_REQUIRED, TEXT_REQUIRED, TITLE_DATE_VENUE_REQUIRED, OUTCOME_INVALID,
 * NAME_REQUIRED, FIXTURE_AND_DATE_REQUIRED, DATE_REQUIRED, ONE_OR_TWO_OBJECTIVES, NOTE_REQUIRED. Text over its
 * limit is refused, never shortened.
 */
import * as v from 'valibot';
import {
  CURSOR_PAGE,
  ID_MAX,
  dayOrBlank,
  dueDate,
  flag,
  id,
  inputOrRefuse,
  oneOf,
  requiredText,
  text,
} from '../platform/schemas.mjs';
import { IDENTITY_LIMITS as IL } from '../../repositories/identity.mjs';
import { GRASSROOTS_LIMITS as GL } from '../../repositories/grassroots.mjs';
import { CLUB_SETUP_LIMITS, LOOKING_FOR_POSITIONS } from '../../repositories/clubSetup.mjs';
import { TRANSITION_LIMITS as VL } from '../../repositories/transitionsVouches.mjs';
import { DEVELOPMENT_LIMITS as DL } from '../../repositories/development.mjs';

export const AVAILABILITY = Object.freeze([
  'available_now',
  'end_of_season',
  'loan_open',
  'overseas_open',
  'not_seeking',
]);
// `under_contract` is written only by the completed-signing writer, and no self-declared status replaces a live
// contract.
export const SELF_DECLARABLE_CONTRACT_STATUSES = Object.freeze([
  'expiring_summer',
  'scholarship_ending',
  'release_approaching',
  'free_agent',
  'unknown',
]);
export const STAT_FIELDS = Object.freeze([
  'appearances',
  'goals',
  'assists',
  'paceKmh',
  'passCompletionPct',
  'duelSuccessPct',
  'cleanSheets',
]);
export const STAT_COUNTS = Object.freeze(['appearances', 'goals', 'assists', 'cleanSheets']);
export const OPEN_DAY_OUTCOMES = Object.freeze(['invite_trial', 'declined']);

const BADGES_MAX = 6;
const BADGE_MAX = 60;
const MEDIA_TITLE_MAX = 160;
const MEDIA_KIND_MAX = 20;
const MEDICAL_TYPE_MAX = 40;
const MEDICAL_TITLE_MAX = 160;
const MAX_LAYOFF_WEEKS = 520;
const DEVICE_ID_MAX = 120;
const TIMELINE_YEAR_MAX = 20;
const TIMELINE_EVENT_MAX = 300;
const SEASON_MAX = 20;
const SQUAD_NAME_MAX = 120;
const SQUAD_POSITION_MAX = 40;
const VOUCH_CODE_MAX = 64;

const optText = (max) => v.nullish(text(max));
const optId = optText(ID_MAX);
const day = v.nullish(dayOrBlank);
const between = (min, max) => v.pipe(v.number(), v.minValue(min), v.maxValue(max));
const ids = (max) => v.nullish(v.pipe(v.array(id), v.maxLength(max)));

const objective = v.strictObject({
  text: requiredText(DL.objectiveText),
  exerciseRefs: v.nullish(v.pipe(v.array(requiredText(DL.exerciseRef)), v.maxLength(DL.exerciseRefs))),
  // ownEvidence judges how many, whether any repeats, and that each is the player's.
  baselineEvidenceIds: v.nullish(v.array(text(ID_MAX))),
});

export const DEVELOPMENT_INPUT = Object.freeze({
  // ---- the player's record
  enabled: v.strictObject({ enabled: flag }),
  shared: v.strictObject({ shared: flag }),
  badges: v.strictObject({ badges: v.pipe(v.array(requiredText(BADGE_MAX)), v.maxLength(BADGES_MAX)) }),
  media: v.strictObject({
    title: optText(MEDIA_TITLE_MAX),
    kind: v.optional(text(MEDIA_KIND_MAX)),
    // The route checks it is a data: URL and answers 413 over the upload cap.
    dataUrl: v.nullish(v.string()),
    attendanceId: optId,
  }),
  medicalRecord: v.strictObject({
    type: optText(MEDICAL_TYPE_MAX),
    title: optText(MEDICAL_TITLE_MAX),
    date: day,
    layoffWeeks: v.nullish(between(0, MAX_LAYOFF_WEEKS)),
    cleared: v.nullish(flag),
    conditionStatus: optText(IL.conditionStatus),
  }),
  location: v.strictObject({ lat: between(-90, 90), lng: between(-180, 180) }),
  availability: v.strictObject({
    availability: v.nullish(oneOf(AVAILABILITY)),
    contractStatus: v.nullish(oneOf(['under_contract', ...SELF_DECLARABLE_CONTRACT_STATUSES])),
  }),
  // The route lists what is missing as ATTENDANCE_UNVERIFIABLE.
  attendance: v.strictObject({
    fixture: optText(GL.fixture),
    venue: optText(GL.venue),
    date: day,
    gps: v.nullish(v.strictObject({ lat: v.optional(between(-90, 90)), lng: v.optional(between(-180, 180)) })),
    deviceId: optText(DEVICE_ID_MAX),
  }),
  timeline: v.strictObject({ year: optText(TIMELINE_YEAR_MAX), event: optText(TIMELINE_EVENT_MAX) }),
  // The route judges each figure (whole counts, percentages up to 100) as BAD_STAT.
  stats: v.strictObject({
    ...Object.fromEntries(STAT_FIELDS.map((f) => [f, v.optional(v.number())])),
    season: optText(SEASON_MAX),
  }),
  drillComplete: v.strictObject({
    value: v.nullish(v.pipe(v.number(), v.minValue(0))),
    videoDataUrl: v.nullish(v.string()),
  }),

  // ---- Grassroots, the player's side
  programme: v.strictObject({ track: v.optional(text(IL.programmeTrack)) }),
  guardianRegister: v.strictObject({ childId: optId }),
  vouchRequest: v.strictObject({
    coachName: optText(VL.coachName),
    coachEmail: optText(VL.coachEmail),
    role: optText(VL.role),
  }),
  vouchSubmit: v.strictObject({
    code: optText(VOUCH_CODE_MAX),
    text: optText(VL.text),
    seasons: optText(VL.seasons),
    conflictOfInterest: optText(VL.conflictOfInterest),
  }),

  // ---- Grassroots, the club's side
  openTrial: v.strictObject({
    title: optText(GL.title),
    date: day,
    venue: optText(GL.venue),
    ageGroup: optText(GL.ageGroup),
    positions: v.nullish(v.pipe(v.array(requiredText(GL.position)), v.maxLength(GL.positions))),
    notes: optText(GL.notes),
  }),
  lookingFor: v.strictObject({
    positions: v.pipe(v.array(oneOf(LOOKING_FOR_POSITIONS)), v.maxLength(CLUB_SETUP_LIMITS.lookingFor)),
  }),
  openDayOutcome: v.strictObject({ outcome: v.optional(oneOf(OPEN_DAY_OUTCOMES)), note: optText(GL.outcomeNote) }),
  squad: v.strictObject({
    name: optText(SQUAD_NAME_MAX),
    position: optText(SQUAD_POSITION_MAX),
    playerId: optId,
  }),
  release: v.strictObject({ referenceText: optText(VL.text) }),
  matchday: v.strictObject({
    fixture: optText(GL.fixture),
    venue: optText(GL.venue),
    date: day,
    result: optText(GL.result),
    playerIds: ids(GL.matchdayPlayers),
  }),
  friendly: v.strictObject({
    ageGroup: optText(GL.ageGroup),
    date: day,
    venue: optText(GL.venue),
    notes: optText(GL.notes),
  }),
  friendlyResponse: v.strictObject({ message: optText(GL.message) }),

  // ---- objectives
  drillReview: v.strictObject({ reviewer: optText(DL.reviewer) }),
  objective: v.strictObject({
    feedbackId: optId,
    objectives: v.optional(v.array(objective)),
    reviewAt: v.optional(dueDate),
  }),
  progress: v.strictObject({ note: optText(DL.progressNote), evidenceId: optId, objectiveId: optId }),
  objectiveShare: v.strictObject({ orgId: optId, enabled: flag }),
  reassessmentOutcome: v.strictObject({ note: optText(DL.outcomeNote), evidenceIds: v.nullish(v.array(text(ID_MAX))) }),

  page: v.strictObject({ ...CURSOR_PAGE }),
  none: v.strictObject({}),
});

const CODES_OF = Object.freeze({
  badges: { badges: 'BADGES_MUST_BE_ARRAY' },
  location: { lat: 'BAD_COORDINATES', lng: 'BAD_COORDINATES' },
  availability: { availability: 'BAD_AVAILABILITY', contractStatus: 'BAD_CONTRACT_STATUS' },
  attendance: { gps: 'GPS_INVALID', 'gps.*': 'GPS_INVALID' },
  stats: Object.fromEntries(STAT_FIELDS.map((f) => [f, 'BAD_STAT'])),
  drillComplete: { value: 'BAD_VALUE' },
  openDayOutcome: { outcome: 'OUTCOME_INVALID' },
  objective: { objectives: 'ONE_OR_TWO_OBJECTIVES' },
});

/** The request input read with DEVELOPMENT_INPUT[name], or `undefined` once the 400 has been sent. */
export const developmentInput = (res, name, input, root = 'body') =>
  inputOrRefuse(res, DEVELOPMENT_INPUT[name], input ?? {}, { root, fieldCodes: CODES_OF[name] ?? {} });
