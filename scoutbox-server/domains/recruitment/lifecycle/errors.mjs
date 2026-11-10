/**
 * The lifecycle and journey error contract: domain error code → HTTP status,
 * and a projection of an internal result into a body safe for a client.
 *
 * A table, not a ternary chain, so there is no default: an unmapped code
 * answers 500 and is logged, and `e2e/recruitment/lifecycle` fails when a
 * producible code is missing. Null prototype because it is indexed by strings
 * from request bodies and stored records.
 */

const table = (o) => Object.freeze(Object.assign(Object.create(null), o));

/**
 *   400  the request is wrong and the caller can fix it
 *   403  the caller may not do this, whatever state the case is in
 *   404  this case is not visible to you (concealment)
 *   409  the request is fine; the case is not where the caller thought
 *   422  the request and the case are fine; the evidence is not there
 *   500  this build or its data is wrong
 */
export const LIFECYCLE_ERROR_HTTP = table({
  LIFECYCLE_STAGE_NOT_SETTABLE: 400,
  LIFECYCLE_ACTION_UNKNOWN: 400,
  LIFECYCLE_REASONS_INVALID: 400,
  LIFECYCLE_REASONS_TOO_MANY: 400,
  LIFECYCLE_REASON_UNKNOWN: 400,
  LIFECYCLE_REASON_REQUIRED: 400,
  // The rooms' rule: a protected characteristic can never be a reason for anything.
  ROOM_REASON_PROHIBITED: 400,

  LIFECYCLE_NOT_PERMITTED: 403,
  // The agent journey route: a summary row opens no client's journey.
  AGENT_ACTION_NOT_PERMITTED: 403,

  // A case in another organisation, one that never existed and one with no
  // workspace answer identically, or the status is an existence oracle.
  CASE_NOT_FOUND: 404,
  CASE_NOT_A_ROOM: 404,
  // The guardian journey route: not this guardian's child.
  CHILD_NOT_FOUND: 404,
  LIFECYCLE_CASE_NOT_A_ROOM: 404,

  // Nothing in the request to fix, so 400 would send the caller to the wrong place.
  LIFECYCLE_TRANSITION_INVALID: 409,
  LIFECYCLE_NO_CHANGE: 409,
  LIFECYCLE_ACTION_NOT_APPLICABLE: 409,
  ROOM_VERSION_CONFLICT: 409,

  LIFECYCLE_EVIDENCE_REQUIRED: 422,

  // Unrecognised stored state is corruption; 409 would invite a retry that cannot succeed.
  LIFECYCLE_STATE_UNKNOWN: 500,
  JOURNEY_STORE_MISSING: 500,
  CASE_HISTORY_CORRUPT: 500,
  // A viewer kind the projector does not know is the caller's defect; 404
  // would say "no such case" about one that exists.
  JOURNEY_VIEWER_UNKNOWN: 500,
  // The routes' fallback for an unmapped code; it is producible, so it is mapped.
  LIFECYCLE_INTERNAL: 500,

  // ============================================================== Contact
  CONTACT_CONTENT_INVALID: 400,
  CONTACT_CONTENT_TOO_LONG: 400,
  CONTACT_CLIENT_KEY_INVALID: 400,
  CONTACT_REV_REQUIRED: 400,
  CONTACT_CHANNEL_INVALID: 400,
  CONTACT_OCCURRED_AT_INVALID: 400,
  CONTACT_RECIPIENT_MISMATCH: 400,
  CONTACT_ACTION_UNKNOWN: 400,
  CONTACT_RESPONSE_INVALID: 400,
  // Refused rather than read as `player_only`, which would hide the caller's bug.
  CONTACT_MODE_INVALID: 400,

  // `CONTACT_BLOCKED` matches the request route's `BLOCKED` 403.
  CONTACT_NOT_PERMITTED: 403,
  CONTACT_BLOCKED: 403,

  // Reached only after the room's own concealing lookup.
  CONTACT_NOT_FOUND: 404,

  CONTACT_INVALID_STATE: 409,
  CONTACT_ALREADY_SENT: 409,
  CONTACT_CASE_STATE: 409,
  CONTACT_VERSION_CONFLICT: 409,
  CONTACT_IDEMPOTENCY_CONFLICT: 409,

  CONTACT_RECIPIENT_UNAVAILABLE: 422,
  CONTACT_GUARDIAN_REQUIRED: 422,

  // Per-recipient cooldown. The platform limiter's `RATE_LIMITED` is not in this table.
  CONTACT_COOLDOWN: 429,

  CONTACT_STATE_UNKNOWN: 500,

  // ================================================================ Trial
  // `TRIAL_DATE_INVALID`, `TRIAL_SLOT_INVALID` and `TRIAL_NOTES_INVALID` come
  // from the trial date validator (domain.mjs) and are answered by the request
  // routes directly, not through this table.
  TRIAL_SCHEDULE_INVALID: 400,
  TRIAL_TIMEZONE_INVALID: 400,
  TRIAL_VENUE_INVALID: 400,
  TRIAL_SLOTS_INVALID: 400,
  TRIAL_CONTENT_INVALID: 400,
  TRIAL_CLIENT_KEY_INVALID: 400,
  TRIAL_REV_REQUIRED: 400,
  TRIAL_ATTENDANCE_INVALID: 400,
  TRIAL_EVIDENCE_REF_INVALID: 400,

  TRIAL_NOT_PERMITTED: 403,
  TRIAL_BLOCKED: 403,
  EVIDENCE_CONSENT_REQUIRED: 403,

  // A trial, session or Box Cam session elsewhere, for another player, or that never existed answer alike.
  TRIAL_NOT_FOUND: 404,
  TRIAL_SESSION_NOT_FOUND: 404,
  TRIAL_BOXCAM_INCOMPATIBLE: 404,

  TRIAL_INVALID_STATE: 409,
  TRIAL_CASE_STATE: 409,
  TRIAL_VERSION_CONFLICT: 409,
  TRIAL_IDEMPOTENCY_CONFLICT: 409,
  TRIAL_COMPLETION_REQUIREMENTS_NOT_MET: 409,
  TRIAL_SUBJECT_REMOVED: 409,
  TRIAL_ALREADY_INVITED: 409,
  EVIDENCE_NOT_FINAL: 409,
  EVIDENCE_WITHDRAWN: 409,

  TRIAL_RECIPIENT_UNAVAILABLE: 422,
  TRIAL_GUARDIAN_REQUIRED: 422,

  // A declined invitation cannot be followed by another within the Contact window.
  TRIAL_INVITE_COOLDOWN: 429,

  // A refused transport writes nothing and says so.
  TRIAL_STATE_UNKNOWN: 500,
  TRIAL_TRANSPORT_REFUSED: 500,

  // ============================================================= Decision
  DECISION_OUTCOME_INVALID: 400,
  DECISION_REASON_INVALID: 400,
  DECISION_CONTENT_INVALID: 400,
  DECISION_EVIDENCE_INVALID: 400,
  DECISION_CASE_MISMATCH: 400,
  DECISION_CLIENT_KEY_INVALID: 400,
  DECISION_REV_REQUIRED: 400,

  DECISION_NOT_PERMITTED: 403,
  DECISION_BLOCKED: 403,

  // Reached only after the room's own concealing lookup.
  DECISION_NOT_FOUND: 404,

  DECISION_INVALID_STATE: 409,
  DECISION_ALREADY_FINAL: 409,
  DECISION_VERSION_CONFLICT: 409,
  DECISION_IDEMPOTENCY_CONFLICT: 409,
  DECISION_LIFECYCLE_CONFLICT: 409,
  DECISION_SUBJECT_REMOVED: 409,

  DECISION_STATE_UNKNOWN: 500,
  DECISION_TRANSPORT_REFUSED: 500,
});

/** The codes that mean "this build or its data is broken", not "your request was". */
export const LIFECYCLE_INTERNAL_ERRORS = Object.freeze(
  Object.keys(LIFECYCLE_ERROR_HTTP).filter((c) => LIFECYCLE_ERROR_HTTP[c] === 500),
);

/** Status for a code, or `null` if the table has never heard of it. */
export const httpStatusFor = (code) => LIFECYCLE_ERROR_HTTP[code] ?? null;

/**
 * Fields a client may see on an error body; everything else belongs in the
 * log. `JOURNEY_STORE_MISSING`, for example, carries raw store names.
 * `requires` and `evidenceReason` name an evidence kind and why it is
 * unsatisfied, never a record or a person: a 422 is useless if it will not say
 * which record is missing.
 */
const PUBLIC_ERROR_FIELDS = [
  'error',
  'message',
  'allowed',
  'to',
  'actions',
  'requires',
  'evidenceReason',
  'current',
  'expectedRev',
  'rev',
  // Contact cooldown: when the caller may try again.
  'retryAt',
  // Trial: the refused field, the days offered, the expected syntax, and the
  // missing completion requirements.
  'field',
  'offered',
  'expected',
  'reasons',
  // Decision: the lifecycle code under a DECISION_LIFECYCLE_CONFLICT and the
  // caller's own refused reference and `supersedes` id. The reason code lists
  // (`unknown`, `prohibited`) stay internal, as e2e/recruitment/lifecycle pins.
  'lifecycle',
  'ref',
  'supersedes',
];

/** Internal (500-class) errors are reduced to the code and a fixed message; the caller logs the full object. */
export function publicErrorBody(out) {
  const code = out?.error;
  if (LIFECYCLE_ERROR_HTTP[code] === 500) {
    return {
      ok: false,
      error: code,
      message: 'The recruitment journey cannot be served for this case. This has been recorded.',
    };
  }
  const body = { ok: false };
  for (const k of PUBLIC_ERROR_FIELDS) {
    if (out?.[k] !== undefined) body[k] = out[k];
  }
  return body;
}

/** Answer a domain error through the mapping table; an unmapped code is a logged 500. */
export function sendDomainError(res, out, where) {
  const status = httpStatusFor(out?.error);
  if (status === null) {
    console.error(`lifecycle ${where} UNMAPPED_ERROR ${out?.error} — ${JSON.stringify(out)}`);
    return res.status(500).json({
      ok: false,
      error: 'LIFECYCLE_INTERNAL',
      message: 'The recruitment journey cannot be served for this case. This has been recorded.',
    });
  }
  if (status === 500) console.error(`lifecycle ${where} ${out.error} — ${JSON.stringify(out)}`);
  return res.status(status).json(publicErrorBody(out));
}
