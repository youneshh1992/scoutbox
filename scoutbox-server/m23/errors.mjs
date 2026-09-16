/**
 * M23 — the lifecycle and journey error contract.
 *
 * ONE table mapping every domain error this milestone can produce to the HTTP
 * status it must answer with, and one function that projects an internal
 * result into a body that is safe to hand a client.
 *
 * WHY THIS IS A TABLE AND NOT A TERNARY CHAIN
 *
 * It used to be two ternary chains, one per route, each ending in a default.
 * A default is the problem: a new error code added to the validator inherits
 * whatever the last branch happened to be, silently, and the wrong status is
 * indistinguishable from a considered one. `LIFECYCLE_REASON_REQUIRED` and
 * `LIFECYCLE_CASE_NOT_A_ROOM` were both already arriving at their status that
 * way — correctly, as it turned out for the first, and wrongly for the second.
 *
 * With a table there is no default. `httpStatusFor` returns `null` for a code
 * it has never been told about, the caller answers 500 and says so in the log,
 * and `m23E2E` fails the moment a producible code is missing from the table.
 *
 * Null-prototype, because it is indexed by strings that originate in request
 * bodies and stored records. `M23_ERROR_HTTP['constructor']` must be absent,
 * not a function.
 */

const table = (o) => Object.freeze(Object.assign(Object.create(null), o));

/**
 * Domain error code → HTTP status.
 *
 * The four bands, and what separates them:
 *
 *   400  the REQUEST is wrong and the caller can fix it
 *   403  the caller may not do this, whatever state the case is in
 *   404  this case is not visible to you — see the concealment note below
 *   409  the request is fine; the CASE is not where the caller thought
 *   422  the request and the case are fine; the EVIDENCE is not there
 *   500  this build is wrong, or its data is. Never the caller's to fix.
 */
export const M23_ERROR_HTTP = table({
  // ---- 400: fix the request.
  LIFECYCLE_STAGE_NOT_SETTABLE: 400,
  LIFECYCLE_ACTION_UNKNOWN: 400,
  LIFECYCLE_REASONS_INVALID: 400,
  LIFECYCLE_REASONS_TOO_MANY: 400,
  LIFECYCLE_REASON_UNKNOWN: 400,
  LIFECYCLE_REASON_REQUIRED: 400,
  // M17's rule, shared deliberately: a protected characteristic can never be a
  // reason for anything, and that must not have two implementations.
  ROOM_REASON_PROHIBITED: 400,

  // ---- 403: not yours to do.
  LIFECYCLE_NOT_PERMITTED: 403,

  // ---- 404: concealment. A case in another organisation, a case that never
  // existed, and a case with no workspace all answer identically. Anything
  // that distinguishes them is an existence oracle.
  CASE_NOT_FOUND: 404,
  CASE_NOT_A_ROOM: 404,
  LIFECYCLE_CASE_NOT_A_ROOM: 404,

  // ---- 409: the case is not in a position for this. There is nothing in the
  // request to fix, so 400 would send the caller to look in the wrong place.
  LIFECYCLE_TRANSITION_INVALID: 409,
  LIFECYCLE_NO_CHANGE: 409,
  LIFECYCLE_ACTION_NOT_APPLICABLE: 409,
  ROOM_VERSION_CONFLICT: 409,

  // ---- 422: well-formed, permitted, possible — and unsupported by evidence.
  LIFECYCLE_EVIDENCE_REQUIRED: 422,

  // ---- 500: ours. A stored state this build does not recognise is corruption
  // and must read as corruption; 409 would invite a reload-and-retry that
  // cannot ever succeed.
  LIFECYCLE_STATE_UNKNOWN: 500,
  JOURNEY_STORE_MISSING: 500,
  CASE_HISTORY_CORRUPT: 500,
  // A viewer kind the projector does not know is a defect in whoever called
  // it, not a statement about the case. It answered 404 until the P2 closure
  // pass — which told a caller "no such case" about a case that exists.
  JOURNEY_VIEWER_UNKNOWN: 500,
  // The fallback the routes emit when a code reaches them that this table has
  // never heard of. It is in the table because it is a code this module can
  // produce, and the drift test does not make an exception for the code that
  // exists to report drift.
  LIFECYCLE_INTERNAL: 500,

  // ======================================================== M23 P3 Contact
  // Same bands, same rule: no default. Every code below is produced by
  // m23/contact.mjs or m23/contactRoutes.mjs and swept by the drift guard.

  // ---- 400: fix the request.
  CONTACT_CONTENT_INVALID: 400,
  CONTACT_CONTENT_TOO_LONG: 400,
  CONTACT_CLIENT_KEY_INVALID: 400,
  CONTACT_REV_REQUIRED: 400,
  CONTACT_CHANNEL_INVALID: 400,
  CONTACT_OCCURRED_AT_INVALID: 400,
  CONTACT_RECIPIENT_MISMATCH: 400,
  CONTACT_ACTION_UNKNOWN: 400,
  CONTACT_RESPONSE_INVALID: 400,

  // ---- 403: not yours to do. `CONTACT_BLOCKED` keeps the platform's
  // existing shape (the request route answers `BLOCKED` 403 to a club).
  CONTACT_NOT_PERMITTED: 403,
  CONTACT_BLOCKED: 403,

  // ---- 404: concealment. Reached only after the room's own concealing
  // lookup, so it distinguishes nothing a 200 would not.
  CONTACT_NOT_FOUND: 404,

  // ---- 409: the contact or the case is not where the caller thought.
  CONTACT_INVALID_STATE: 409,
  CONTACT_ALREADY_SENT: 409,
  CONTACT_CASE_STATE: 409,
  CONTACT_VERSION_CONFLICT: 409,
  CONTACT_IDEMPOTENCY_CONFLICT: 409,

  // ---- 422: well-formed, permitted, possible — and the world says no.
  CONTACT_RECIPIENT_UNAVAILABLE: 422,
  CONTACT_GUARDIAN_REQUIRED: 422,

  // ---- 429: deterministic per-recipient cooldown. The limiter's own
  // `RATE_LIMITED` answers are produced by m181 and are not in this table.
  CONTACT_COOLDOWN: 429,

  // ---- 500: ours.
  CONTACT_STATE_UNKNOWN: 500,
  CONTACT_STORE_MISSING: 500,

  // ======================================================== M23 P4B Trial
  // Same bands, same rule: no default. Every code below is produced by
  // m23/trial.mjs or m23/trialRoutes.mjs and swept by the drift guard.

  // ---- 400: fix the request.
  // (`TRIAL_DATE_INVALID`, `TRIAL_SLOT_INVALID` and `TRIAL_NOTES_INVALID` are
  // the P4A-D1 date module's codes, answered by the legacy request and
  // respond routes in server.mjs directly; they are not in this table.)
  TRIAL_SCHEDULE_INVALID: 400,
  TRIAL_TIMEZONE_INVALID: 400,
  TRIAL_VENUE_INVALID: 400,
  TRIAL_SLOTS_INVALID: 400,
  TRIAL_CONTENT_INVALID: 400,
  TRIAL_CLIENT_KEY_INVALID: 400,
  TRIAL_REV_REQUIRED: 400,
  TRIAL_ATTENDANCE_INVALID: 400,
  TRIAL_EVIDENCE_REF_INVALID: 400,

  // ---- 403: not yours to do.
  TRIAL_NOT_PERMITTED: 403,
  TRIAL_BLOCKED: 403,
  EVIDENCE_CONSENT_REQUIRED: 403,

  // ---- 404: concealment. A trial, a session or a Box Cam session in another
  // organisation, for another player, or that never existed answer alike.
  TRIAL_NOT_FOUND: 404,
  TRIAL_SESSION_NOT_FOUND: 404,
  TRIAL_BOXCAM_INCOMPATIBLE: 404,

  // ---- 409: the trial or the case is not where the caller thought.
  TRIAL_INVALID_STATE: 409,
  TRIAL_CASE_STATE: 409,
  TRIAL_VERSION_CONFLICT: 409,
  TRIAL_IDEMPOTENCY_CONFLICT: 409,
  TRIAL_COMPLETION_REQUIREMENTS_NOT_MET: 409,
  TRIAL_SUBJECT_REMOVED: 409,
  TRIAL_ALREADY_INVITED: 409,
  EVIDENCE_NOT_FINAL: 409,
  EVIDENCE_WITHDRAWN: 409,

  // ---- 422: well-formed, permitted, possible — and the world says no.
  TRIAL_RECIPIENT_UNAVAILABLE: 422,
  TRIAL_GUARDIAN_REQUIRED: 422,

  // ---- 429: the deterministic per-player invitation cooldown (a declined
  // invitation cannot be followed by another within the Contact window).
  TRIAL_INVITE_COOLDOWN: 429,

  // ---- 500: ours. A refused transport (injected for tests, or a real
  // persistence problem) writes nothing and says so.
  TRIAL_STATE_UNKNOWN: 500,
  TRIAL_STORE_MISSING: 500,
  TRIAL_TRANSPORT_REFUSED: 500,

  // ======================================================== M23 P5 Decision
  // Same bands, same rule: no default. Every code below is produced by
  // m23/decision.mjs or m23/decisionRoutes.mjs and swept by the drift guard.

  // ---- 400: fix the request.
  DECISION_OUTCOME_INVALID: 400,
  DECISION_REASON_INVALID: 400,
  DECISION_CONTENT_INVALID: 400,
  DECISION_EVIDENCE_INVALID: 400,
  DECISION_CASE_MISMATCH: 400,
  DECISION_CLIENT_KEY_INVALID: 400,
  DECISION_REV_REQUIRED: 400,

  // ---- 403: not yours to do.
  DECISION_NOT_PERMITTED: 403,
  DECISION_BLOCKED: 403,

  // ---- 404: concealment. Reached only after the room's own concealing
  // lookup; a draft that does not exist is not a thing to find.
  DECISION_NOT_FOUND: 404,

  // ---- 409: the decision or the case is not where the caller thought.
  DECISION_INVALID_STATE: 409,
  DECISION_ALREADY_FINAL: 409,
  DECISION_VERSION_CONFLICT: 409,
  DECISION_IDEMPOTENCY_CONFLICT: 409,
  DECISION_LIFECYCLE_CONFLICT: 409,
  DECISION_SUBJECT_REMOVED: 409,

  // ---- 500: ours.
  DECISION_STATE_UNKNOWN: 500,
  DECISION_STORE_MISSING: 500,
  DECISION_TRANSPORT_REFUSED: 500,
});

/** The codes that mean "this build or its data is broken", not "your request was". */
export const M23_INTERNAL_ERRORS = Object.freeze(
  Object.keys(M23_ERROR_HTTP).filter((c) => M23_ERROR_HTTP[c] === 500),
);

/** Status for a code, or `null` if the table has never heard of it. No default. */
export const httpStatusFor = (code) => M23_ERROR_HTTP[code] ?? null;

/**
 * Fields a client may see on an error body.
 *
 * Everything else the projector or validator returns is internal diagnostic
 * detail and belongs in the log. `JOURNEY_STORE_MISSING` is the reason this
 * exists: it carries `missing` and `malformed`, which are lists of RAW STORE
 * NAMES. Those are useful in a unit test and in a server log, and they are
 * the internal schema handed to anyone who can provoke a 500.
 *
 * `allowed`, `to` and `actions` stay: they tell a caller what they could do
 * instead, which is the point of a refusal, and none of them names anything
 * the caller could not already read from the vocabulary route.
 *
 * `requires` and `evidenceReason` stay too, and that is a decision rather than
 * an oversight. A 422 whose whole job is "the record that would justify this
 * is not there" is useless if it will not say WHICH record. `requires` is an
 * evidence KIND — `confirmed_join`, `contact_delivered` — not a record, not an
 * id, and not a person; `evidenceReason` is `not_implemented`, `unsatisfied`
 * or `no_confirmed_join`. Neither reveals anything about a player, and being
 * honest in the product about what this deployment cannot yet check is the
 * same honesty M18.1's capabilities surface already publishes.
 */
const PUBLIC_ERROR_FIELDS = [
  'error', 'message', 'allowed', 'to', 'actions',
  'requires', 'evidenceReason',
  'current', 'expectedRev', 'rev',
  // P3: when a contact is refused for cooldown, the caller may know when it
  // can try again. A timestamp, not a person and not a record.
  'retryAt',
  // P4B: a Trial refusal names the FIELD it refused, the days that WERE
  // offered, the syntax it expected, and — for the completion gate — the
  // requirement codes that are missing. Vocabulary, never a person.
  'field', 'offered', 'expected', 'reasons',
  // P5: a Decision refusal may name the LIFECYCLE code underneath a
  // DECISION_LIFECYCLE_CONFLICT, echo the reference `{ kind, id }` it refused,
  // echo the `supersedes` id the caller named, and list the reason codes it
  // did not know or will not accept. All of it is the caller's own input or
  // vocabulary; none of it is a person or a record.
  'lifecycle', 'ref', 'supersedes', 'unknown', 'prohibited',
];

/**
 * Project an internal result into a body that is safe to send.
 *
 * Internal (500-class) errors are reduced to the code and a fixed message: no
 * store names, no field lists, no counts. The caller logs the full object.
 */
export function publicErrorBody(out) {
  const code = out?.error;
  if (M23_ERROR_HTTP[code] === 500) {
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

/**
 * Answer a domain error through the ONE mapping table.
 *
 * Shared by the lifecycle routes and the Contact routes so there is exactly
 * one place where a code becomes a status:
 *
 *   1. The status comes from `M23_ERROR_HTTP`. There is no default branch,
 *      so a code the table has never been told about becomes a 500 AND a log
 *      line naming it — a loud unknown rather than a quiet 400.
 *   2. The body is projected through `publicErrorBody`.
 */
export function sendDomainError(res, out, where) {
  const status = httpStatusFor(out?.error);
  if (status === null) {
    console.error(`M23 ${where} UNMAPPED_ERROR ${out?.error} — ${JSON.stringify(out)}`);
    return res.status(500).json({
      ok: false,
      error: 'LIFECYCLE_INTERNAL',
      message: 'The recruitment journey cannot be served for this case. This has been recorded.',
    });
  }
  if (status === 500) console.error(`M23 ${where} ${out.error} — ${JSON.stringify(out)}`);
  return res.status(status).json(publicErrorBody(out));
}
