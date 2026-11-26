//// The At-Home Combine's rules (domains/development/boxcam/combineShared.mjs): the standardised protocol registry,
//// the honesty gate, the measurement worked out from a finished Box Cam session, the display at a protocol's
//// precision, personal bests, the club comparison and the result hash.
////
//// "Combine Verified" means: measured from a standardised protocol during a live Box Cam session, by a provider that
//// supports the metric, with liveness and calibration passed, derived by the server, integrity intact. The registry
//// is declared here as the TypeScript server holds it; spec_test proves it equals the snapshot.

import gleam/dict.{type Dict}
import gleam/float
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/string
import scoutbox/development/box_cam_rules as rules
import scoutbox/platform/json_text
import scoutbox/platform/secrets
import scoutbox/rows/box_sessions as session_row
import scoutbox/rows/combine_attempts as row
import scoutbox/vocab/box_provider.{type BoxProvider}
import scoutbox/vocab/box_quality.{type BoxQuality}
import scoutbox/vocab/box_target_type
import scoutbox/vocab/capture_context.{type CaptureContext}

// ------------------------------------------------------------------------------------------------- the registry

/// What a protocol needs observed: a Box Cam capability, or one that future athletic protocols need and no provider
/// has, not even the test one.
pub type Required {
  Observes(rules.Capability)
  SpatialScale
  TimingGate
  TargetZone
}

pub const future_capabilities = [SpatialScale, TimingGate, TargetZone]

pub fn required_to_string(r: Required) -> String {
  case r {
    Observes(c) -> rules.capability_to_string(c)
    SpatialScale -> "spatial_scale"
    TimingGate -> "timing_gate"
    TargetZone -> "target_zone"
  }
}

/// The precision a protocol's value is shown at, never more.
pub type Precision {
  Integer
  Tenths
  Hundredths
  Centimetres
}

pub fn precision_to_string(p: Precision) -> String {
  case p {
    Integer -> "integer"
    Tenths -> "tenths"
    Hundredths -> "hundredths"
    Centimetres -> "centimetres"
  }
}

/// A standardised protocol. An attempt pins its id, version and measurement algorithm version: a rule change is a
/// new version. The `Option` texts are the ones the future athletic protocols leave out.
pub type Protocol {
  Protocol(
    id: String,
    version: Int,
    title: String,
    category: String,
    description: String,
    drill_id: Option(String),
    drill_target: Option(rules.Target),
    metric_type: row.MetricType,
    metric_unit: String,
    direction: row.Direction,
    precision: Precision,
    protocol_window_ms: Int,
    required_capabilities: List(Required),
    setup_requirements: String,
    camera_requirements: Option(String),
    space_requirements: Option(String),
    equipment_requirements: Option(List(String)),
    start_rule: Option(String),
    finish_rule: Option(String),
    valid_attempt_rules: Option(String),
    scoring_method: String,
    safety_notes: String,
    /// The registry's `status: 'active'`.
    active: Bool,
    capture_contexts: List(CaptureContext),
    max_verified_per_window: Int,
    /// The attempt-limit window.
    window_ms: Int,
    practice_allowed: Bool,
    calibration_requirements: List(String),
    measurement_algorithm_version: Int,
    /// The registry's `ageRestrictions: 'adult'`.
    adult_only: Bool,
  )
}

pub fn protocol(id: String, version: Int) -> Option(Protocol) {
  list.find(protocols, fn(p) { p.id == id && p.version == version })
  |> option.from_result
}

pub fn latest_protocol(id: String) -> Option(Protocol) {
  list.filter(protocols, fn(p) { p.id == id })
  |> list.max(fn(a, b) { int.compare(a.version, b.version) })
  |> option.from_result
}

// ------------------------------------------------------------------------------------------- the honesty gate

pub fn measurement_supported(
  p: Protocol,
  capabilities: List(rules.Capability),
) -> Bool {
  list.all(p.required_capabilities, fn(r) {
    case r {
      Observes(c) -> list.contains(capabilities, c)
      _ -> False
    }
  })
}

/// `configured` or `not_configured`.
pub fn measurement_capability(
  p: Protocol,
  capabilities: List(rules.Capability),
) -> String {
  case measurement_supported(p, capabilities) {
    True -> "configured"
    False -> "not_configured"
  }
}

pub fn missing_capabilities(
  p: Protocol,
  capabilities: List(rules.Capability),
) -> List(Required) {
  list.filter(p.required_capabilities, fn(r) {
    case r {
      Observes(c) -> !list.contains(capabilities, c)
      _ -> True
    }
  })
}

/// What a provider may certify for the Combine. Its observation list is what it can see; a Combine measurement is a
/// comparable number, a claim about the real world, so `production_cv`'s comes from the real-world validation
/// record instead (cv/eligibility.mjs), where no protocol has passed: the registry's `combineVerifiedProtocols` is
/// empty.
pub fn combine_capabilities(provider: BoxProvider) -> List(rules.Capability) {
  case provider {
    box_provider.ProductionCv -> []
    _ -> rules.provider(provider).capabilities
  }
}

// --------------------------------------------------------------------------------------------------- the copy

/// The player copy per state; `ready` has none.
pub fn state_copy(state: row.CombineState) -> Option(String) {
  case state {
    row.Ready -> None
    row.CombineVerified ->
      Some(
        "Measured from a standardized ScoutBox Combine Protocol during a live Box Cam session, with a supported detector, and passed the required integrity checks.",
      )
    row.CombineStatePartiallyMeasured ->
      Some(
        "The standardized measurement window was not fully observed, so this attempt is recorded as a measurement but is not Combine Verified. No value is projected or estimated.",
      )
    row.CombineStateMeasurementUnavailable ->
      Some(
        "This Combine measurement is not yet supported on this device. ScoutBox does not estimate or fabricate a result.",
      )
    row.CombineStateProtocolInvalid ->
      Some(
        "The attempt did not follow the standardized protocol, so no verified measurement was produced.",
      )
    row.CombineStateInvalidated ->
      Some(
        "This Combine result was invalidated after review and no longer counts as Combine Verified.",
      )
    row.CombineStateCancelled ->
      Some("This Combine Attempt was cancelled before completion.")
  }
}

/// Every state but `ready` is terminal: the attempt is finished.
pub fn is_terminal(state: row.CombineState) -> Bool {
  state != row.Ready
}

/// The live state of a stored attempt: when T&S invalidates the bound session its measurement stops counting, and a
/// restore brings it back without rewriting the attempt.
pub fn live_state(
  state: row.CombineState,
  session: Option(session_row.VerificationState),
) -> row.CombineState {
  case state, session {
    row.CombineVerified, Some(session_row.VerificationStateInvalidated)
    | row.CombineStatePartiallyMeasured,
      Some(session_row.VerificationStateInvalidated)
    -> row.CombineStateInvalidated
    _, _ -> state
  }
}

// ---------------------------------------------------------------------------------------------- measurement

pub type Reason {
  ProtocolUnknown
  SessionMissing
  MeasurementNotSupported
  SessionInvalidated
  SessionCancelled
  LivenessOrProviderMissing
  NoReliableObservation
  SessionNotFinalized
  CountNotSupported
  IntervalNotSupported
  MetricNotSupported
  CalibrationNotPassed
  PracticeAttempt
  MeasurementWindowIncomplete
  ObservationQualityDegraded
}

pub fn reason_to_string(r: Reason) -> String {
  case r {
    ProtocolUnknown -> "PROTOCOL_UNKNOWN"
    SessionMissing -> "SESSION_MISSING"
    MeasurementNotSupported -> "MEASUREMENT_NOT_SUPPORTED"
    SessionInvalidated -> "SESSION_INVALIDATED"
    SessionCancelled -> "SESSION_CANCELLED"
    LivenessOrProviderMissing -> "LIVENESS_OR_PROVIDER_MISSING"
    NoReliableObservation -> "NO_RELIABLE_OBSERVATION"
    SessionNotFinalized -> "SESSION_NOT_FINALIZED"
    CountNotSupported -> "COUNT_NOT_SUPPORTED"
    IntervalNotSupported -> "INTERVAL_NOT_SUPPORTED"
    MetricNotSupported -> "METRIC_NOT_SUPPORTED"
    CalibrationNotPassed -> "CALIBRATION_NOT_PASSED"
    PracticeAttempt -> "PRACTICE_ATTEMPT"
    MeasurementWindowIncomplete -> "MEASUREMENT_WINDOW_INCOMPLETE"
    ObservationQualityDegraded -> "OBSERVATION_QUALITY_DEGRADED"
  }
}

/// What the measurement reads of the finished session: only its server-derived values.
pub type Finished {
  Finished(
    state: Option(session_row.VerificationState),
    session_duration_ms: Option(Float),
    verified_active_ms: Option(Float),
    verified_reps: Option(Int),
    sets_completed: Option(Int),
    quality: Option(BoxQuality),
  )
}

pub fn finished(s: session_row.Row) -> Finished {
  Finished(
    state: s.verification_state,
    session_duration_ms: s.session_duration_ms,
    verified_active_ms: s.verified_active_ms,
    verified_reps: s.verified_reps,
    sets_completed: s.sets_completed,
    quality: s.quality,
  )
}

/// The measurement. `observed_ms` and `window_ms` are set once a value was read; `missing` only when the provider
/// cannot measure the protocol.
pub type Measurement {
  Measurement(
    combine_state: row.CombineState,
    measurement_state: row.MeasurementState,
    measured_value: Option(Float),
    reasons: List(Reason),
    observed_ms: Option(Float),
    window_ms: Option(Int),
    missing: List(Required),
  )
}

fn failed(
  state: row.CombineState,
  reason: Reason,
  value: Option(Float),
) -> Measurement {
  let measurement = case state {
    row.CombineStateInvalidated -> row.MeasurementStateInvalidated
    row.CombineStateCancelled -> row.MeasurementStateCancelled
    row.CombineStateMeasurementUnavailable ->
      row.MeasurementStateMeasurementUnavailable
    _ -> row.MeasurementStateProtocolInvalid
  }
  Measurement(state, measurement, value, [reason], None, None, [])
}

/// From the finished session's server-derived values only. A window observed short is partial, never scaled up; a
/// practice attempt is never Combine Verified.
pub fn measure(
  protocol p: Option(Protocol),
  session s: Option(Finished),
  calibration_passed calibration_passed: Bool,
  capabilities capabilities: List(rules.Capability),
  practice practice: Bool,
) -> Measurement {
  case p, s {
    None, _ -> failed(row.CombineStateProtocolInvalid, ProtocolUnknown, None)
    _, None -> failed(row.CombineStateProtocolInvalid, SessionMissing, None)
    Some(p), Some(s) ->
      case measurement_supported(p, capabilities) {
        False ->
          Measurement(
            ..failed(
              row.CombineStateMeasurementUnavailable,
              MeasurementNotSupported,
              None,
            ),
            missing: missing_capabilities(p, capabilities),
          )
        True -> measure_session(p, s, calibration_passed, practice)
      }
  }
}

fn measure_session(
  p: Protocol,
  s: Finished,
  calibration_passed: Bool,
  practice: Bool,
) -> Measurement {
  // The session's drill target is irrelevant to a Combine, which has its own window, so `verified` and
  // `partially_verified` are alike.
  case s.state {
    Some(session_row.VerificationStateInvalidated) ->
      failed(row.CombineStateInvalidated, SessionInvalidated, None)
    Some(session_row.VerificationStateCancelled) ->
      failed(row.CombineStateCancelled, SessionCancelled, None)
    Some(session_row.VerificationStateCompletedUnverified) ->
      failed(row.CombineStateProtocolInvalid, LivenessOrProviderMissing, None)
    Some(session_row.VerificationStateUnableToVerify) ->
      failed(
        row.CombineStateMeasurementUnavailable,
        NoReliableObservation,
        None,
      )
    None -> failed(row.CombineStateProtocolInvalid, SessionNotFinalized, None)
    Some(session_row.VerificationStateVerified)
    | Some(session_row.VerificationStatePartiallyVerified) ->
      measure_value(p, s, calibration_passed, practice)
  }
}

fn measure_value(
  p: Protocol,
  s: Finished,
  calibration_passed: Bool,
  practice: Bool,
) -> Measurement {
  let window = int.to_float(p.protocol_window_ms)
  let duration = option.unwrap(s.session_duration_ms, 0.0)
  let observed = float.min(duration, window)
  let value = case p.metric_type, s.verified_reps, s.sets_completed {
    row.Count, Some(n), _ -> Ok(int.to_float(n))
    row.Count, None, _ -> Error(CountNotSupported)
    row.Duration, _, _ -> {
      // Verified active seconds inside the window, in tenths.
      let ms = float.min(option.unwrap(s.verified_active_ms, 0.0), window)
      Ok(js_round(ms /. 100.0) /. 10.0)
    }
    row.Set, _, Some(n) -> Ok(int.to_float(n))
    row.Set, _, None -> Error(IntervalNotSupported)
    _, _, _ -> Error(MetricNotSupported)
  }
  let measured = fn(state, measurement, reasons) {
    Measurement(
      state,
      measurement,
      result_value(value),
      reasons,
      Some(observed),
      Some(p.protocol_window_ms),
      [],
    )
  }
  case value {
    Error(reason) ->
      failed(row.CombineStateMeasurementUnavailable, reason, None)
    Ok(v) ->
      case p.calibration_requirements != [] && !calibration_passed {
        True ->
          failed(row.CombineStateProtocolInvalid, CalibrationNotPassed, Some(v))
        False ->
          case practice, duration >=. window -. 1.0, s.quality {
            True, _, _ ->
              measured(
                row.CombineStatePartiallyMeasured,
                row.MeasurementStatePractice,
                [PracticeAttempt],
              )
            False, False, _ ->
              measured(
                row.CombineStatePartiallyMeasured,
                row.MeasurementStatePartiallyMeasured,
                [MeasurementWindowIncomplete],
              )
            False, True, Some(box_quality.Good) ->
              measured(row.CombineVerified, row.Measured, [])
            False, True, _ ->
              measured(
                row.CombineStatePartiallyMeasured,
                row.MeasurementStatePartiallyMeasured,
                [ObservationQualityDegraded],
              )
          }
      }
  }
}

fn result_value(r: Result(Float, a)) -> Option(Float) {
  option.from_result(r)
}

/// JavaScript's `Math.round`: halves go up.
fn js_round(x: Float) -> Float {
  float.floor(x +. 0.5)
}

/// JavaScript's `toFixed`, for the small positive values a measurement holds.
fn fixed(value: Float, places: Int) -> String {
  let scale = int.product(list.repeat(10, places))
  let n =
    float.truncate(js_round(float.absolute_value(value) *. int.to_float(scale)))
  let sign = case value <. 0.0 && n > 0 {
    True -> "-"
    False -> ""
  }
  let whole = int.to_string(n / scale)
  let part = int.to_string(n % scale) |> string.pad_start(places, "0")
  sign <> whole <> "." <> part
}

/// At the protocol's declared precision, never more; a missing value is a dash.
pub fn format(p: Protocol, value: Option(Float)) -> String {
  case value {
    None -> "—"
    Some(v) ->
      case p.precision {
        Integer | Centimetres -> int.to_string(float.truncate(js_round(v)))
        Tenths -> fixed(v, 1)
        Hundredths -> fixed(v, 2)
      }
  }
}

// --------------------------------------------------------------------------------------- bests and comparison

/// An attempt as a personal best reads it: its value, its metric's direction and its live state.
pub type Scored(a) {
  Scored(
    item: a,
    measured_value: Option(Float),
    direction: row.Direction,
    live_state: row.CombineState,
  )
}

/// The best Combine Verified attempt whose session still stands, in the metric's direction (the first one's). A
/// tie keeps the earlier attempt.
pub fn personal_best(attempts: List(Scored(a))) -> Option(Scored(a)) {
  let verified =
    list.filter(attempts, fn(a) {
      a.live_state == row.CombineVerified && a.measured_value != None
    })
  case verified {
    [] -> None
    [first, ..rest] ->
      Some(
        list.fold(rest, first, fn(best, a) {
          let v = option.unwrap(a.measured_value, 0.0)
          let b = option.unwrap(best.measured_value, 0.0)
          case first.direction {
            row.Lower if v <. b -> a
            row.Higher if v >. b -> a
            _ -> best
          }
        }),
      )
  }
}

/// A player's best in a comparison.
pub type Cell {
  Cell(value: Float, at: Option(Int))
}

/// The key of a player's best at a protocol in `comparison`'s bests.
pub fn cell_key(player_id: String, p: Protocol) -> String {
  player_id <> "::" <> p.id <> "@" <> int.to_string(p.version)
}

/// Verified numbers only: a missing result is null, never zero, and there is no overall ranking (clubs sort the
/// columns themselves).
pub fn comparison(
  players: List(#(String, String)),
  protocols: List(Protocol),
  bests: Dict(String, Cell),
) -> Json {
  json.object([
    #(
      "protocols",
      json.array(protocols, fn(p) {
        json.object([
          #("id", json.string(p.id)),
          #("version", json.int(p.version)),
          #("title", json.string(p.title)),
          #("metricUnit", json.string(p.metric_unit)),
          #("direction", row.direction_to_json(p.direction)),
        ])
      }),
    ),
    #(
      "rows",
      json.array(players, fn(pl) {
        json.object([
          #("playerId", json.string(pl.0)),
          #("playerName", json.string(pl.1)),
          #(
            "cells",
            json.array(protocols, fn(p) {
              case dict.get(bests, cell_key(pl.0, p)) {
                Ok(b) ->
                  json.object([
                    #("value", json_text.number(b.value)),
                    #("display", json.string(format(p, Some(b.value)))),
                    #("verified", json.bool(True)),
                    #("at", json.nullable(b.at, json.int)),
                  ])
                Error(Nil) -> json.null()
              }
            }),
          ),
        ])
      }),
    ),
    #(
      "note",
      json.string(
        "Verified numbers only (✓). A blank cell means no verified result — not zero. ScoutBox does not rank players overall.",
      ),
    ),
  ])
}

// ------------------------------------------------------------------------------------------- the result hash

/// What an attempt's result hash covers.
pub type Hashed {
  Hashed(
    player_id: String,
    attempt_id: String,
    protocol_id: String,
    protocol_version: Int,
    box_session_id: String,
    metric_type: row.MetricType,
    measured_value: Option(Float),
    provider: BoxProvider,
    provider_version: Int,
    measurement_algorithm_version: Int,
    completed_at: Option(Int),
    combine_state: row.CombineState,
  )
}

/// The SHA-256 of the attempt's canonical JSON, as the TypeScript server writes it.
pub fn result_hash(h: Hashed) -> String {
  json.object([
    #("playerId", json.string(h.player_id)),
    #("attemptId", json.string(h.attempt_id)),
    #("protocolId", json.string(h.protocol_id)),
    #("protocolVersion", json.int(h.protocol_version)),
    #("boxSessionId", json.string(h.box_session_id)),
    #("metricType", row.metric_type_to_json(h.metric_type)),
    #("measuredValue", json.nullable(h.measured_value, json_text.number)),
    #("provider", box_provider.to_json(h.provider)),
    #("providerVersion", json.int(h.provider_version)),
    #("measurementAlgorithmVersion", json.int(h.measurement_algorithm_version)),
    #("completedAt", json.nullable(h.completed_at, json.int)),
    #("combineState", row.combine_state_to_json(h.combine_state)),
  ])
  |> json.to_string
  |> secrets.sha256_hex
}

// -------------------------------------------------------------------------------------------- the protocols

pub const protocols = [
  Protocol(
    id: "combine-box-touch-60",
    version: 1,
    title: "Box Touch 60",
    category: "ball_mastery",
    description: "As many controlled alternating touches on top of the ball as possible in 60 seconds.",
    drill_id: Some("box-touches"),
    drill_target: Some(rules.Target(box_target_type.Repetitions, 2000.0)),
    metric_type: row.Count,
    metric_unit: "touches",
    direction: row.Higher,
    precision: Integer,
    protocol_window_ms: 60_000,
    required_capabilities: [
      Observes(rules.PlayerPresence),
      Observes(rules.BallPresence),
      Observes(rules.RepCount),
    ],
    setup_requirements: "Full body and ball in frame, stable phone, 2m × 2m clear area.",
    camera_requirements: Some(
      "Portrait, ~2.5m distance, whole body and ball visible throughout.",
    ),
    space_requirements: Some("2m × 2m clear, level surface."),
    equipment_requirements: Some(["ball"]),
    start_rule: Some(
      "The 60-second measurement window begins when the attempt starts.",
    ),
    finish_rule: Some(
      "The window closes at 60 seconds. Only touches observed inside the window count.",
    ),
    valid_attempt_rules: Some(
      "Player and ball must remain observable. If observation is lost, the attempt is partially measured, never estimated.",
    ),
    scoring_method: "Verified, de-duplicated touch count inside the 60-second window.",
    safety_notes: "Warm up first. Stop on any pain — recorded work still counts.",
    active: True,
    capture_contexts: [
      capture_context.AtHome,
      capture_context.Club,
      capture_context.Event,
    ],
    max_verified_per_window: 3,
    window_ms: 86_400_000,
    practice_allowed: True,
    calibration_requirements: [],
    measurement_algorithm_version: 1,
    adult_only: False,
  ),
  Protocol(
    id: "combine-box-juggle",
    version: 1,
    title: "Box Juggle",
    category: "ball_mastery",
    description: "Total verified juggles (keepy-uppies) within a 60-second window.",
    drill_id: Some("box-juggles"),
    drill_target: Some(rules.Target(box_target_type.Repetitions, 2000.0)),
    metric_type: row.Count,
    metric_unit: "juggles",
    direction: row.Higher,
    precision: Integer,
    protocol_window_ms: 60_000,
    required_capabilities: [
      Observes(rules.PlayerPresence),
      Observes(rules.BallPresence),
      Observes(rules.RepCount),
    ],
    setup_requirements: "Full body in frame, ball never leaves the frame vertically.",
    camera_requirements: Some(
      "Portrait, ~3m distance, high ceiling or outdoors preferred.",
    ),
    space_requirements: Some("2m × 2m clear area."),
    equipment_requirements: Some(["ball"]),
    start_rule: Some("The 60-second window begins when the attempt starts."),
    finish_rule: Some(
      "Total verified juggles inside the window. Maximum-consecutive is not measured (no reliable detector).",
    ),
    valid_attempt_rules: Some(
      "Player and ball must remain observable throughout.",
    ),
    scoring_method: "Verified, de-duplicated juggle count inside the window.",
    safety_notes: "Warm up first. Stop on any pain — recorded work still counts.",
    active: True,
    capture_contexts: [
      capture_context.AtHome,
      capture_context.Club,
      capture_context.Event,
    ],
    max_verified_per_window: 3,
    window_ms: 86_400_000,
    practice_allowed: True,
    calibration_requirements: [],
    measurement_algorithm_version: 1,
    adult_only: False,
  ),
  Protocol(
    id: "combine-box-control-60",
    version: 1,
    title: "Box Control 60",
    category: "close_control",
    description: "Verified active close-control time inside a fixed 60-second protocol.",
    drill_id: Some("box-control"),
    drill_target: Some(rules.Target(box_target_type.Duration, 60_000.0)),
    metric_type: row.Duration,
    metric_unit: "seconds",
    direction: row.Higher,
    precision: Tenths,
    protocol_window_ms: 60_000,
    required_capabilities: [
      Observes(rules.PlayerPresence),
      Observes(rules.BallPresence),
      Observes(rules.ActiveDuration),
    ],
    setup_requirements: "Whole 3m × 3m training area in frame.",
    camera_requirements: Some("Landscape, ~4m distance, entire area visible."),
    space_requirements: Some("3m × 3m clear, level surface."),
    equipment_requirements: Some(["ball"]),
    start_rule: Some("The 60-second window begins when the attempt starts."),
    finish_rule: Some(
      "Verified active control time observed inside the window (max 60.0s).",
    ),
    valid_attempt_rules: Some(
      "If the ball or player leaves frame, that time does not count; a short-observed window is partially measured.",
    ),
    scoring_method: "Verified active-control seconds ∩ ball-visible, inside the window.",
    safety_notes: "Warm up first. Stop on any pain — recorded work still counts.",
    active: True,
    capture_contexts: [
      capture_context.AtHome,
      capture_context.Club,
      capture_context.Event,
    ],
    max_verified_per_window: 3,
    window_ms: 86_400_000,
    practice_allowed: True,
    calibration_requirements: [],
    measurement_algorithm_version: 1,
    adult_only: False,
  ),
  Protocol(
    id: "combine-box-footwork",
    version: 1,
    title: "Box Footwork",
    category: "footwork",
    description: "Completed standardized lateral footwork intervals.",
    drill_id: Some("box-footwork"),
    drill_target: Some(rules.Target(box_target_type.Sets, 5.0)),
    metric_type: row.Set,
    metric_unit: "intervals",
    direction: row.Higher,
    precision: Integer,
    protocol_window_ms: 300_000,
    required_capabilities: [
      Observes(rules.PlayerPresence),
      Observes(rules.ActiveDuration),
      Observes(rules.IntervalCompletion),
    ],
    setup_requirements: "Feet clearly visible between two markers.",
    camera_requirements: Some("Portrait, ~3m distance, feet visible."),
    space_requirements: Some("2m × 2m clear area."),
    equipment_requirements: Some([]),
    start_rule: Some("Intervals begin when the attempt starts."),
    finish_rule: Some("Number of completed intervals out of the target."),
    valid_attempt_rules: Some(
      "Player must remain observable during work intervals; rest intervals never count against the result.",
    ),
    scoring_method: "Count of completed intervals.",
    safety_notes: "Rest 30–60s between sets. Stop on any pain.",
    active: True,
    capture_contexts: [
      capture_context.AtHome,
      capture_context.Club,
      capture_context.Event,
    ],
    max_verified_per_window: 3,
    window_ms: 86_400_000,
    practice_allowed: True,
    calibration_requirements: [],
    measurement_algorithm_version: 1,
    adult_only: False,
  ),
  Protocol(
    id: "combine-box-strength-60",
    version: 1,
    title: "Box Strength 60",
    category: "strength",
    description: "Valid observed bodyweight squat repetitions in 60 seconds. General physical-development evidence — not a measure of football ability.",
    drill_id: Some("box-strength"),
    drill_target: Some(rules.Target(box_target_type.Repetitions, 2000.0)),
    metric_type: row.Count,
    metric_unit: "reps",
    direction: row.Higher,
    precision: Integer,
    protocol_window_ms: 60_000,
    required_capabilities: [
      Observes(rules.PlayerPresence),
      Observes(rules.ActiveMotion),
      Observes(rules.RepCount),
    ],
    setup_requirements: "Full body side-on in frame.",
    camera_requirements: Some("Portrait, ~2.5m distance, side-on."),
    space_requirements: Some("2m × 1m clear area."),
    equipment_requirements: Some([]),
    start_rule: Some("The 60-second window begins when the attempt starts."),
    finish_rule: Some("Valid observed repetitions inside the window."),
    valid_attempt_rules: Some(
      "Controlled tempo; partial-range reps are not counted.",
    ),
    scoring_method: "Verified, de-duplicated squat count inside the window.",
    safety_notes: "Bodyweight only. Stop on any pain. Not medical advice.",
    active: True,
    capture_contexts: [
      capture_context.AtHome,
      capture_context.Club,
      capture_context.Event,
    ],
    max_verified_per_window: 3,
    window_ms: 86_400_000,
    practice_allowed: True,
    calibration_requirements: [],
    measurement_algorithm_version: 1,
    adult_only: False,
  ),
  Protocol(
    id: "combine-agility-5-10-5",
    version: 1,
    title: "5-10-5 Agility",
    category: "athletic",
    description: "Standardized 5-10-5 pro-agility shuttle. Requires spatial calibration and automated timing gates.",
    drill_id: None,
    drill_target: None,
    metric_type: row.Time,
    metric_unit: "seconds",
    direction: row.Lower,
    precision: Hundredths,
    protocol_window_ms: 60_000,
    required_capabilities: [TimingGate, SpatialScale],
    setup_requirements: "Three markers exactly 5 metres apart (Box Marker).",
    camera_requirements: None,
    space_requirements: None,
    equipment_requirements: None,
    start_rule: None,
    finish_rule: None,
    valid_attempt_rules: None,
    scoring_method: "Automated start/finish timing — not available in this environment.",
    safety_notes: "Requires a large, flat, clear surface.",
    active: True,
    capture_contexts: [
      capture_context.AtHome,
      capture_context.Club,
      capture_context.Event,
    ],
    max_verified_per_window: 3,
    window_ms: 86_400_000,
    practice_allowed: False,
    calibration_requirements: ["box_marker_5m"],
    measurement_algorithm_version: 1,
    adult_only: False,
  ),
  Protocol(
    id: "combine-accel-10m",
    version: 1,
    title: "10 m Acceleration",
    category: "athletic",
    description: "Standardized 10-metre acceleration. Requires spatial calibration and automated timing gates.",
    drill_id: None,
    drill_target: None,
    metric_type: row.Time,
    metric_unit: "seconds",
    direction: row.Lower,
    precision: Hundredths,
    protocol_window_ms: 60_000,
    required_capabilities: [TimingGate, SpatialScale],
    setup_requirements: "Two markers exactly 10 metres apart (Box Marker).",
    camera_requirements: None,
    space_requirements: None,
    equipment_requirements: None,
    start_rule: None,
    finish_rule: None,
    valid_attempt_rules: None,
    scoring_method: "Automated start/finish timing — not available in this environment.",
    safety_notes: "Requires a straight, flat, clear 15m+ run.",
    active: True,
    capture_contexts: [
      capture_context.AtHome,
      capture_context.Club,
      capture_context.Event,
    ],
    max_verified_per_window: 3,
    window_ms: 86_400_000,
    practice_allowed: False,
    calibration_requirements: ["box_marker_10m"],
    measurement_algorithm_version: 1,
    adult_only: False,
  ),
  Protocol(
    id: "combine-broad-jump",
    version: 1,
    title: "Standing Broad Jump",
    category: "athletic",
    description: "Standardized standing broad jump. Requires physical-scale calibration.",
    drill_id: None,
    drill_target: None,
    metric_type: row.Distance,
    metric_unit: "centimetres",
    direction: row.Higher,
    precision: Centimetres,
    protocol_window_ms: 60_000,
    required_capabilities: [SpatialScale],
    setup_requirements: "Calibration marker of known size in frame (Box Marker).",
    camera_requirements: None,
    space_requirements: None,
    equipment_requirements: None,
    start_rule: None,
    finish_rule: None,
    valid_attempt_rules: None,
    scoring_method: "Calibrated distance measurement — not available in this environment.",
    safety_notes: "Land safely on a soft, clear surface.",
    active: True,
    capture_contexts: [
      capture_context.AtHome,
      capture_context.Club,
      capture_context.Event,
    ],
    max_verified_per_window: 3,
    window_ms: 86_400_000,
    practice_allowed: False,
    calibration_requirements: ["box_marker_scale"],
    measurement_algorithm_version: 1,
    adult_only: False,
  ),
  Protocol(
    id: "combine-passing-target",
    version: 1,
    title: "Passing Target",
    category: "technical",
    description: "Successful passes into a defined target zone out of attempts. Requires target-zone detection.",
    drill_id: None,
    drill_target: None,
    metric_type: row.Percentage,
    metric_unit: "%",
    direction: row.Higher,
    precision: Integer,
    protocol_window_ms: 120_000,
    required_capabilities: [TargetZone, SpatialScale],
    setup_requirements: "Defined target zone visible in frame.",
    camera_requirements: None,
    space_requirements: None,
    equipment_requirements: None,
    start_rule: None,
    finish_rule: None,
    valid_attempt_rules: None,
    scoring_method: "Objective successful/attempted ratio — not available in this environment.",
    safety_notes: "Clear the area around the target.",
    active: True,
    capture_contexts: [
      capture_context.AtHome,
      capture_context.Club,
      capture_context.Event,
    ],
    max_verified_per_window: 3,
    window_ms: 86_400_000,
    practice_allowed: False,
    calibration_requirements: ["box_marker_target"],
    measurement_algorithm_version: 1,
    adult_only: False,
  ),
]
