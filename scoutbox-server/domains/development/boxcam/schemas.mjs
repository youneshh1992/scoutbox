/**
 * Box Cam and At-Home Combine request input: sessions and their observation batches, club assignments and
 * challenges, privacy settings, disputes, Combine attempts and Club Combine requests. The routes keep the codes the
 * Player and club apps already read (DRILL_UNKNOWN, TARGET_TYPE_UNSUPPORTED, TARGET_VALUE_INVALID, TARGET_INVALID,
 * BATCH_INVALID, EVENT_INVALID, NOTE_REQUIRED, REASON_REQUIRED, METRIC_INVALID, SHARE_INVALID, OUTCOME_REQUIRED,
 * MODE_INVALID, CAPTURE_CONTEXT_INVALID, PROTOCOLS_REQUIRED, PLAYERS_REQUIRED).
 *
 * A session's result is derived from accepted observations and the server's clock: a body naming a result,
 * a state or a provenance is refused as an unknown field.
 */
import * as v from 'valibot';
import {
  CURSOR_PAGE,
  ID_MAX,
  dayOrBlank,
  flag,
  idList,
  idsText,
  inputOrRefuse,
  oneOf,
  parseInput,
  text,
  wholeNumber,
} from '../../platform/schemas.mjs';
import { BOX_CAM_LIMITS as L } from '../../../repositories/boxCam.mjs';
import { PROVIDER_ERRORS as CV } from './cv/provider.mjs';

const NONCE_MAX = 256;
const nonce = v.optional(text(NONCE_MAX));
const optId = v.nullish(text(ID_MAX));
const optText = (max) => v.nullish(text(max));

export const SHARE_CHOICES = Object.freeze(['private', 'recruitment']);
export const CHALLENGE_METRICS = Object.freeze(['reps', 'active_minutes']);
export const DISPUTE_OUTCOMES = Object.freeze(['stands', 'invalidated', 'provider_bug']);
export const COMBINE_MODES = Object.freeze(['verified', 'practice']);
export const CAPTURE_CONTEXTS = Object.freeze(['at_home', 'club', 'event']);

// The route judges the type against the drill and the value against the type's bounds.
const drillTarget = v.strictObject({ type: v.optional(v.string()), value: v.optional(v.number()) });

const ms = v.nullish(v.number());
// The route judges the sequence, the type and each timestamp against the session (SEQUENCE_INVALID,
// EVENT_TYPE_UNKNOWN, TIMESTAMP_OUT_OF_RANGE) and the observation it becomes (EVENT_INVALID).
const event = v.strictObject({
  seq: v.number(),
  type: v.string(),
  atMs: ms,
  fromMs: ms,
  toMs: ms,
  quality: v.nullish(v.string()),
  confidence: v.nullish(v.number()),
});

export const BOX_CAM_INPUT = Object.freeze({
  session: v.strictObject({
    drillId: v.optional(text(ID_MAX)),
    target: v.nullish(drillTarget),
    provider: v.optional(text(ID_MAX)),
    assignmentId: optId,
    challengeEntryId: optId,
  }),
  start: v.strictObject({ nonce, liveness: v.nullish(text(ID_MAX)) }),
  events: v.strictObject({ nonce, batch: v.optional(v.array(event)) }),
  withNonce: v.strictObject({ nonce }),
  note: v.strictObject({ note: optText(L.note) }),
  clip: v.strictObject({ mediaId: optId }),

  assignment: v.strictObject({
    playerId: optId,
    drillId: v.optional(text(ID_MAX)),
    target: v.nullish(drillTarget),
    frequencyPerWeek: v.nullish(wholeNumber({ min: 1, max: 14 })),
    dueDate: v.nullish(dayOrBlank),
    instructions: optText(L.instructions),
    objectiveId: optId,
  }),
  challenge: v.strictObject({
    title: optText(L.title),
    drillId: v.optional(text(ID_MAX)),
    metric: v.optional(oneOf(CHALLENGE_METRICS)),
    targetTotal: v.optional(wholeNumber({ min: 1, max: 100_000 })),
    days: v.nullish(wholeNumber({ min: 1, max: 60 })),
    adultOnly: v.nullish(flag),
    cap: v.nullish(wholeNumber({ min: 1, max: 1_000_000 })),
  }),
  prefs: v.strictObject({
    shareDevelopmentActivity: v.optional(oneOf(SHARE_CHOICES)),
    retainClips: v.optional(flag),
  }),
  dispute: v.strictObject({ reason: optText(L.disputeReason) }),
  resolve: v.strictObject({ outcome: v.optional(oneOf(DISPUTE_OUTCOMES)), reason: optText(L.resolutionReason) }),
  restore: v.strictObject({ reason: optText(L.detail) }),
  disputeQueue: v.strictObject({ ...CURSOR_PAGE, all: v.optional(oneOf(['0', '1'])) }),

  attempt: v.strictObject({
    protocolId: v.optional(text(ID_MAX)),
    mode: v.optional(oneOf(COMBINE_MODES)),
    provider: v.optional(text(ID_MAX)),
    captureContext: v.optional(oneOf(CAPTURE_CONTEXTS)),
    requestId: optId,
  }),
  calibrate: v.strictObject({
    checks: v.optional(
      v.pipe(
        v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(L.calibrationCheck))),
        v.maxLength(L.calibrationChecks),
      ),
    ),
  }),
  combineRequest: v.strictObject({
    title: optText(L.title),
    protocolIds: v.optional(idList(L.protocols)),
    deadline: v.nullish(dayOrBlank),
    instructions: optText(L.instructions),
    playerIds: v.optional(v.array(text(ID_MAX))),
    playerId: optId,
  }),
  // `?playerIds=a,b&protocols=x,y`; a comparison shows at most 30 players.
  compare: v.strictObject({ playerIds: v.optional(idsText(30)), protocols: v.optional(idsText(L.protocols)) }),
  // A club's assignment and request lists, filtered to one player or not.
  orgList: v.strictObject({ ...CURSOR_PAGE, playerId: v.optional(text(ID_MAX)) }),
  page: v.strictObject({ ...CURSOR_PAGE }),
  none: v.strictObject({}),
});

const CODES_OF = Object.freeze({
  session: {
    target: 'TARGET_VALUE_INVALID',
    'target.type': 'TARGET_TYPE_UNSUPPORTED',
    'target.*': 'TARGET_VALUE_INVALID',
  },
  events: { batch: 'BATCH_INVALID', 'batch.*': 'EVENT_INVALID' },
  assignment: { target: 'TARGET_INVALID', 'target.*': 'TARGET_INVALID' },
  challenge: { metric: 'METRIC_INVALID', targetTotal: 'TARGET_INVALID' },
  prefs: { shareDevelopmentActivity: 'SHARE_INVALID' },
  resolve: { outcome: 'OUTCOME_REQUIRED' },
  attempt: { mode: 'MODE_INVALID', captureContext: 'CAPTURE_CONTEXT_INVALID' },
});

// The production CV routes answer with the provider's codes and statuses (cv/routes.mjs `fail`). Fields the provider
// derives are refused there as CLIENT_FIELD_REFUSED before these schemas run. decodeFrame judges each frame's
// encoding, size and bytes.
const frame = v.strictObject({
  encoding: v.optional(v.string()),
  seq: v.optional(v.number()),
  atMs: v.optional(v.number()),
  w: v.optional(v.number()),
  h: v.optional(v.number()),
  data: v.optional(v.string()),
  capturedAtMs: v.nullish(v.number()),
});
const providerSessionId = v.nullish(text(ID_MAX));
const reported = v.nullish(flag);
const measured = v.nullish(v.number());

export const CV_INPUT = Object.freeze({
  begin: v.strictObject({ nonce, protocolId: v.optional(text(ID_MAX)) }),
  frames: v.strictObject({ nonce, providerSessionId, frames: v.optional(v.array(frame)) }),
  finalize: v.strictObject({
    nonce,
    providerSessionId,
    protocolWindowMs: v.nullish(wholeNumber({ min: 1, max: 24 * 3_600_000 })),
  }),
  cancel: v.strictObject({ nonce, providerSessionId }),
  // What the client reports during setup: advice only, so each is judged as sent and nothing more.
  readyCheck: v.strictObject({
    cameraPermission: v.nullish(text(ID_MAX)),
    secureContext: reported,
    frameWidth: measured,
    frameHeight: measured,
    fps: measured,
    personDetected: reported,
    ballDetected: reported,
    lightingOk: reported,
    protocolId: v.nullish(text(ID_MAX)),
  }),
});

const CV_CODES_OF = Object.freeze({
  frames: {
    frames: CV.UNSUPPORTED_FRAME_FORMAT,
    'frames.w': CV.INVALID_FRAME_DIMENSIONS,
    'frames.h': CV.INVALID_FRAME_DIMENSIONS,
    'frames.*': CV.UNSUPPORTED_FRAME_FORMAT,
  },
});

/** `{ ok: true, value }`, or the refusal for the CV route to send with its own status. */
export const cvInput = (name, input) =>
  parseInput(CV_INPUT[name], input ?? {}, { fieldCodes: CV_CODES_OF[name] ?? {} });

/** The request input read with BOX_CAM_INPUT[name], or `undefined` once the 400 has been sent. */
export const boxCamInput = (res, name, input, root = 'body') =>
  inputOrRefuse(res, BOX_CAM_INPUT[name], input ?? {}, { root, fieldCodes: CODES_OF[name] ?? {} });
