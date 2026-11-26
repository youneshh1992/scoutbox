//// The recruitment refusal contracts (domains/recruitment/lifecycle/errors.mjs and offers/errors.mjs): a code's
//// HTTP status comes from a table with no default, and only allowlisted fields reach the client, in the table's
//// order, after `ok: false`. A 500-class code is reduced to the code and a fixed message.

import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import scoutbox/platform/http
import wisp.{type Response}

pub type Contract {
  Contract(
    statuses: List(#(String, Int)),
    public_fields: List(String),
    internal_message: String,
    /// What an unmapped code is answered as.
    unmapped: String,
  )
}

/// Answers `code` with `fields` (any order; only the contract's public fields are sent).
pub fn send(
  contract: Contract,
  code: String,
  fields: List(#(String, Json)),
) -> Response {
  case list.key_find(contract.statuses, code) {
    Error(Nil) -> internal(contract, contract.unmapped)
    Ok(500) -> internal(contract, code)
    Ok(status) ->
      http.json(
        status,
        json.object([
          #("ok", json.bool(False)),
          #("error", json.string(code)),
          ..list.filter_map(contract.public_fields, fn(name) {
            list.key_find(fields, name) |> result_map(fn(v) { #(name, v) })
          })
        ]),
      )
  }
}

/// `send` with a message.
pub fn refuse(
  contract: Contract,
  code: String,
  message: String,
  fields: List(#(String, Json)),
) -> Response {
  send(contract, code, [#("message", json.string(message)), ..fields])
}

fn result_map(r: Result(a, Nil), f: fn(a) -> b) -> Result(b, Nil) {
  case r {
    Ok(a) -> Ok(f(a))
    Error(Nil) -> Error(Nil)
  }
}

fn internal(contract: Contract, code: String) -> Response {
  http.json(
    500,
    json.object([
      #("ok", json.bool(False)),
      #("error", json.string(code)),
      #("message", json.string(contract.internal_message)),
    ]),
  )
}

/// The status a contract gives `code`, if it has one.
pub fn status_of(contract: Contract, code: String) -> Option(Int) {
  case list.key_find(contract.statuses, code) {
    Ok(s) -> Some(s)
    Error(Nil) -> None
  }
}

// ----------------------------------------------------------------------------------------------- lifecycle

/// LIFECYCLE_ERROR_HTTP: the lifecycle, journey, contact, trial and decision codes.
pub const lifecycle_statuses = [
  #("LIFECYCLE_STAGE_NOT_SETTABLE", 400),
  #("LIFECYCLE_ACTION_UNKNOWN", 400),
  #("LIFECYCLE_INPUT_INVALID", 400),
  #("LIFECYCLE_CLIENT_KEY_INVALID", 400),
  #("LIFECYCLE_REASONS_INVALID", 400),
  #("LIFECYCLE_REASONS_TOO_MANY", 400),
  #("LIFECYCLE_REASON_UNKNOWN", 400),
  #("LIFECYCLE_REASON_REQUIRED", 400),
  #("EXPECTED_REV_INVALID", 400),
  #("ROOM_REASON_PROHIBITED", 400),
  #("LIFECYCLE_NOT_PERMITTED", 403),
  #("AGENT_ACTION_NOT_PERMITTED", 403),
  #("CASE_NOT_FOUND", 404),
  #("CASE_NOT_A_ROOM", 404),
  #("CHILD_NOT_FOUND", 404),
  #("LIFECYCLE_CASE_NOT_A_ROOM", 404),
  #("LIFECYCLE_TRANSITION_INVALID", 409),
  #("LIFECYCLE_NO_CHANGE", 409),
  #("LIFECYCLE_ACTION_NOT_APPLICABLE", 409),
  #("ROOM_VERSION_CONFLICT", 409),
  #("LIFECYCLE_EVIDENCE_REQUIRED", 422),
  #("LIFECYCLE_STATE_UNKNOWN", 500),
  #("JOURNEY_STORE_MISSING", 500),
  #("CASE_HISTORY_CORRUPT", 500),
  #("JOURNEY_VIEWER_UNKNOWN", 500),
  #("LIFECYCLE_INTERNAL", 500),
  #("CONTACT_CONTENT_INVALID", 400),
  #("CONTACT_CONTENT_TOO_LONG", 400),
  #("CONTACT_CLIENT_KEY_INVALID", 400),
  #("CONTACT_REV_REQUIRED", 400),
  #("CONTACT_CHANNEL_INVALID", 400),
  #("CONTACT_OCCURRED_AT_INVALID", 400),
  #("CONTACT_RECIPIENT_MISMATCH", 400),
  #("CONTACT_ACTION_UNKNOWN", 400),
  #("CONTACT_RESPONSE_INVALID", 400),
  #("CONTACT_MODE_INVALID", 400),
  #("CONTACT_NOT_PERMITTED", 403),
  #("CONTACT_BLOCKED", 403),
  #("CONTACT_NOT_FOUND", 404),
  #("CONTACT_INVALID_STATE", 409),
  #("CONTACT_ALREADY_SENT", 409),
  #("CONTACT_CASE_STATE", 409),
  #("CONTACT_VERSION_CONFLICT", 409),
  #("CONTACT_IDEMPOTENCY_CONFLICT", 409),
  #("CONTACT_RECIPIENT_UNAVAILABLE", 422),
  #("CONTACT_GUARDIAN_REQUIRED", 422),
  #("CONTACT_COOLDOWN", 429),
  #("CONTACT_STATE_UNKNOWN", 500),
  #("TRIAL_SCHEDULE_INVALID", 400),
  #("TRIAL_TIMEZONE_INVALID", 400),
  #("TRIAL_VENUE_INVALID", 400),
  #("TRIAL_SLOTS_INVALID", 400),
  #("TRIAL_CONTENT_INVALID", 400),
  #("TRIAL_CLIENT_KEY_INVALID", 400),
  #("TRIAL_REV_REQUIRED", 400),
  #("TRIAL_ATTENDANCE_INVALID", 400),
  #("TRIAL_EVIDENCE_REF_INVALID", 400),
  #("TRIAL_NOT_PERMITTED", 403),
  #("TRIAL_BLOCKED", 403),
  #("EVIDENCE_CONSENT_REQUIRED", 403),
  #("TRIAL_NOT_FOUND", 404),
  #("TRIAL_SESSION_NOT_FOUND", 404),
  #("TRIAL_BOXCAM_INCOMPATIBLE", 404),
  #("TRIAL_INVALID_STATE", 409),
  #("TRIAL_CASE_STATE", 409),
  #("TRIAL_VERSION_CONFLICT", 409),
  #("TRIAL_IDEMPOTENCY_CONFLICT", 409),
  #("TRIAL_COMPLETION_REQUIREMENTS_NOT_MET", 409),
  #("TRIAL_SUBJECT_REMOVED", 409),
  #("TRIAL_ALREADY_INVITED", 409),
  #("EVIDENCE_NOT_FINAL", 409),
  #("EVIDENCE_WITHDRAWN", 409),
  #("TRIAL_RECIPIENT_UNAVAILABLE", 422),
  #("TRIAL_GUARDIAN_REQUIRED", 422),
  #("TRIAL_INVITE_COOLDOWN", 429),
  #("TRIAL_STATE_UNKNOWN", 500),
  #("TRIAL_TRANSPORT_REFUSED", 500),
  #("DECISION_OUTCOME_INVALID", 400),
  #("DECISION_REASON_INVALID", 400),
  #("DECISION_CONTENT_INVALID", 400),
  #("DECISION_EVIDENCE_INVALID", 400),
  #("DECISION_CASE_MISMATCH", 400),
  #("DECISION_CLIENT_KEY_INVALID", 400),
  #("DECISION_REV_REQUIRED", 400),
  #("DECISION_NOT_PERMITTED", 403),
  #("DECISION_BLOCKED", 403),
  #("DECISION_NOT_FOUND", 404),
  #("DECISION_INVALID_STATE", 409),
  #("DECISION_ALREADY_FINAL", 409),
  #("DECISION_VERSION_CONFLICT", 409),
  #("DECISION_IDEMPOTENCY_CONFLICT", 409),
  #("DECISION_LIFECYCLE_CONFLICT", 409),
  #("DECISION_SUBJECT_REMOVED", 409),
  #("DECISION_STATE_UNKNOWN", 500),
  #("DECISION_TRANSPORT_REFUSED", 500),
]

pub const lifecycle =
  Contract(
    statuses: lifecycle_statuses,
    public_fields: [
      "message", "allowed", "to", "actions", "requires", "evidenceReason",
      "current", "expectedRev", "rev", "retryAt", "field", "offered", "expected",
      "reasons", "lifecycle", "ref", "supersedes", "problem", "min", "max",
    ],
    internal_message: "The recruitment journey cannot be served for this case. This has been recorded.",
    unmapped: "LIFECYCLE_INTERNAL",
  )

// ------------------------------------------------------------------------------------------------- offers

/// OFFER_ERROR_HTTP.
pub const offer_statuses = [
  #("OFFER_INPUT_INVALID", 400),
  #("OFFER_TERMS_INVALID", 400),
  #("OFFER_EXPIRY_INVALID", 400),
  #("OFFER_DOCUMENT_INVALID", 400),
  #("OFFER_CLIENT_KEY_INVALID", 400),
  #("OFFER_REV_REQUIRED", 400),
  #("OFFER_NOT_PERMITTED", 403),
  #("OFFER_BLOCKED", 403),
  #("OFFER_NOT_FOUND", 404),
  #("OFFER_DOCUMENT_NOT_FOUND", 404),
  #("OFFER_STATE_INVALID", 409),
  #("OFFER_REV_CONFLICT", 409),
  #("OFFER_EXPIRED", 409),
  #("OFFER_SUPERSEDED", 409),
  #("OFFER_WITHDRAWN", 409),
  #("OFFER_ALREADY_RESPONDED", 409),
  #("OFFER_IDEMPOTENCY_CONFLICT", 409),
  #("OFFER_LIFECYCLE_CONFLICT", 409),
  #("OFFER_SUBJECT_REMOVED", 409),
  #("OFFER_ISSUE_NOT_ALLOWED", 422),
  #("OFFER_RECIPIENT_INVALID", 422),
  #("OFFER_COMPLIANCE_BLOCKED", 422),
  #("OFFER_STATE_UNKNOWN", 500),
]

pub const offer =
  Contract(
    statuses: offer_statuses,
    public_fields: [
      "message", "field", "problem", "min", "max", "allowed", "expected",
      "current", "expectedRev", "currentRev", "updatedBy", "updatedAt",
      "reasons", "blockers", "lifecycle", "status",
    ],
    internal_message: "The Offer service cannot serve this request. This has been recorded.",
    unmapped: "OFFER_STATE_UNKNOWN",
  )

/// The Signing error table (domains/recruitment/signings/errors.mjs).
pub const signing_statuses = [
  #("SIGNING_INPUT_INVALID", 400),
  #("SIGNING_CONTRACT_DATES_INVALID", 400),
  #("SIGNING_EXPIRY_INVALID", 400),
  #("SIGNING_DOCUMENT_INVALID", 400),
  #("SIGNING_CLIENT_KEY_INVALID", 400),
  #("SIGNING_REV_REQUIRED", 400),
  #("SIGNING_METHOD_UNKNOWN", 400),
  #("SIGNING_NOT_PERMITTED", 403),
  #("SIGNING_BLOCKED", 403),
  #("SIGNING_AUTHORITY_LOST", 403),
  #("SIGNING_NOT_FOUND", 404),
  #("SIGNING_DOCUMENT_NOT_FOUND", 404),
  #("SIGNING_STATE_INVALID", 409),
  #("SIGNING_REV_CONFLICT", 409),
  #("SIGNING_NOT_READY", 409),
  #("SIGNING_ALREADY_COMPLETED", 409),
  #("SIGNING_EXPIRED", 409),
  #("SIGNING_CANCELLED", 409),
  #("SIGNING_VOIDED", 409),
  #("SIGNING_SUPERSEDED", 409),
  #("SIGNING_PARTY_NOT_REQUIRED", 409),
  #("SIGNING_PARTY_ALREADY_COMPLETED", 409),
  #("SIGNING_PARTIES_INCOMPLETE", 409),
  #("SIGNING_DOCUMENT_MISMATCH", 409),
  #("SIGNING_IDEMPOTENCY_CONFLICT", 409),
  #("SIGNING_LIFECYCLE_CONFLICT", 409),
  #("SIGNING_CONFLICT", 409),
  #("SIGNING_OFFER_NOT_ACCEPTED", 409),
  #("SIGNING_PACKAGE_EXISTS", 409),
  #("SIGNING_CANONICAL_REQUIRED", 409),
  #("SIGNING_SUBJECT_REMOVED", 409),
  #("SIGNING_DOCUMENT_REQUIRED", 422),
  #("SIGNING_EVIDENCE_INVALID", 422),
  #("SIGNING_PATHWAY_CLOSED", 422),
  #("SIGNING_RECIPIENT_INVALID", 422),
  #("SIGNING_STATE_UNKNOWN", 500),
  #("SIGNING_STORE_MISSING", 500),
]

pub const signing =
  Contract(
    statuses: signing_statuses,
    public_fields: [
      "message", "field", "problem", "min", "max", "allowed", "expected",
      "current", "expectedRev", "currentRev", "updatedBy", "updatedAt",
      "reasons", "blockers", "lifecycle", "status", "parties",
    ],
    internal_message: "The Signing service cannot serve this request. This has been recorded.",
    unmapped: "SIGNING_STATE_UNKNOWN",
  )
