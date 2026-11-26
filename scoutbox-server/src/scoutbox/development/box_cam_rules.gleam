//// Box Cam's rules (domains/development/boxcam/shared.mjs and drills.mjs): the drill and observation-provider
//// registry, and the engine that turns a session's accepted observations into active time, repetitions and a
//// verification state.
////
//// The strongest claim Box Cam may make: "ScoutBox Box Cam observed activity consistent with this supported drill
//// for X active minutes/repetitions during a live capture session." It observes, it doesn't rate a player, and
//// elapsed clock time is not active-training time. Times are milliseconds into the session, as floats: a client
//// may report fractions, and the TypeScript server keeps them.

import gleam/bool
import gleam/dict
import gleam/float
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/set
import gleam/string
import scoutbox/platform/json_text
import scoutbox/platform/secrets
import scoutbox/rows/box_challenges as challenge_row
import scoutbox/rows/box_sessions as session_row
import scoutbox/vocab/box_provider.{type BoxProvider}
import scoutbox/vocab/box_quality.{type BoxQuality}
import scoutbox/vocab/box_target_type.{type BoxTargetType}

// ------------------------------------------------------------------------------------------------- the registry

/// What a detector or a provider can genuinely observe.
pub type Capability {
  PlayerPresence
  BallPresence
  ActiveMotion
  ActiveDuration
  RepCount
  FootClassification
  IntervalCompletion
  TechniqueSignals
}

pub const capabilities = [
  PlayerPresence,
  BallPresence,
  ActiveMotion,
  ActiveDuration,
  RepCount,
  FootClassification,
  IntervalCompletion,
  TechniqueSignals,
]

pub fn capability_to_string(c: Capability) -> String {
  case c {
    PlayerPresence -> "player_presence"
    BallPresence -> "ball_presence"
    ActiveMotion -> "active_motion"
    ActiveDuration -> "active_duration"
    RepCount -> "rep_count"
    FootClassification -> "foot_classification"
    IntervalCompletion -> "interval_completion"
    TechniqueSignals -> "technique_signals"
  }
}

pub type Setup {
  Setup(
    orientation: String,
    distance_m: Float,
    space: String,
    equipment: List(String),
    framing: String,
    demo: String,
  )
}

/// A versioned detector contract: it claims only the capabilities its detector really has. Sessions pin
/// `id@version`; a new detector version is a new measurement and doesn't rewrite history.
pub type Drill {
  Drill(
    id: String,
    version: Int,
    title: String,
    category: String,
    summary: String,
    target_types: List(BoxTargetType),
    verification_capabilities: List(Capability),
    /// False when the drill declares rep counting `not_configured`.
    rep_support: Bool,
    rep_support_note: Option(String),
    setup: Setup,
    safety_notes: String,
    rest_guidance: Option(String),
    age_appropriateness: String,
    rep_min_gap_ms: Float,
    rep_min_confidence: Float,
  )
}

const default_safety =
  "Train in a clear, dry space. Stop if you feel pain or dizziness — the recorded work still counts."

pub const drills = [
  Drill(
    id: "box-touches",
    version: 1,
    title: "Box Touches",
    category: "ball_mastery",
    summary: "Alternating-foot touches on top of the ball at a steady rhythm.",
    target_types: [box_target_type.Repetitions, box_target_type.Duration],
    verification_capabilities: [
      PlayerPresence,
      BallPresence,
      ActiveDuration,
      RepCount,
    ],
    rep_support: True,
    rep_support_note: None,
    setup: Setup(
      orientation: "portrait",
      distance_m: 2.5,
      space: "2m × 2m clear area",
      equipment: ["ball"],
      framing: "Full body and the ball in frame",
      demo: "alternating toe taps on the ball",
    ),
    safety_notes: default_safety,
    rest_guidance: None,
    age_appropriateness: "all",
    rep_min_gap_ms: 180.0,
    rep_min_confidence: 0.5,
  ),
  Drill(
    id: "box-control",
    version: 1,
    title: "Box Control",
    category: "close_control",
    summary: "Continuous close-control movement inside a defined area.",
    target_types: [box_target_type.Duration],
    verification_capabilities: [PlayerPresence, BallPresence, ActiveDuration],
    rep_support: True,
    rep_support_note: None,
    setup: Setup(
      orientation: "landscape",
      distance_m: 4.0,
      space: "3m × 3m clear area",
      equipment: ["ball"],
      framing: "Whole training area in frame",
      demo: "dribbling inside the box, both feet",
    ),
    safety_notes: default_safety,
    rest_guidance: None,
    age_appropriateness: "all",
    rep_min_gap_ms: 250.0,
    rep_min_confidence: 0.5,
  ),
  Drill(
    id: "box-juggles",
    version: 1,
    title: "Box Juggles",
    category: "ball_mastery",
    summary: "Keepy-uppies — keep the ball off the ground.",
    target_types: [box_target_type.Repetitions, box_target_type.Duration],
    verification_capabilities: [
      PlayerPresence,
      BallPresence,
      ActiveDuration,
      RepCount,
    ],
    rep_support: True,
    rep_support_note: None,
    setup: Setup(
      orientation: "portrait",
      distance_m: 3.0,
      space: "2m × 2m clear area, high ceiling outdoors preferred",
      equipment: ["ball"],
      framing: "Full body, ball never leaves frame vertically",
      demo: "continuous juggling, any surface",
    ),
    safety_notes: default_safety,
    rest_guidance: None,
    age_appropriateness: "all",
    rep_min_gap_ms: 300.0,
    rep_min_confidence: 0.5,
  ),
  Drill(
    id: "box-wall",
    version: 1,
    title: "Box Wall",
    category: "passing",
    summary: "Wall passes — pass, control, repeat.",
    target_types: [box_target_type.Repetitions],
    // Wall-pass rep counting isn't reliable from a single phone angle, so this drill verifies active duration only.
    verification_capabilities: [PlayerPresence, BallPresence, ActiveDuration],
    rep_support: False,
    rep_support_note: Some(
      "Automated wall-pass repetition counting is not configured for a single camera angle. Box Cam verifies your active training time; your repetition target is shown against active time, not fabricated counts.",
    ),
    setup: Setup(
      orientation: "landscape",
      distance_m: 5.0,
      space: "Wall + 4m run-off",
      equipment: ["ball", "wall"],
      framing: "Player and wall contact point in frame",
      demo: "two-touch wall passing",
    ),
    safety_notes: default_safety,
    rest_guidance: None,
    age_appropriateness: "all",
    rep_min_gap_ms: 250.0,
    rep_min_confidence: 0.5,
  ),
  Drill(
    id: "box-footwork",
    version: 1,
    title: "Box Footwork",
    category: "footwork",
    summary: "Football-relevant lateral footwork patterns.",
    target_types: [box_target_type.Duration, box_target_type.Sets],
    verification_capabilities: [
      PlayerPresence,
      ActiveMotion,
      ActiveDuration,
      IntervalCompletion,
    ],
    rep_support: True,
    rep_support_note: None,
    setup: Setup(
      orientation: "portrait",
      distance_m: 3.0,
      space: "2m × 2m clear area",
      equipment: [],
      framing: "Feet clearly visible",
      demo: "lateral shuffles between markers",
    ),
    safety_notes: default_safety,
    rest_guidance: Some("Rest 30–60 seconds between sets."),
    age_appropriateness: "all",
    rep_min_gap_ms: 250.0,
    rep_min_confidence: 0.5,
  ),
  Drill(
    id: "box-mobility",
    version: 1,
    title: "Box Mobility",
    category: "mobility",
    summary: "Supported bodyweight mobility movements.",
    target_types: [box_target_type.Duration],
    verification_capabilities: [PlayerPresence, ActiveDuration],
    rep_support: True,
    rep_support_note: None,
    setup: Setup(
      orientation: "landscape",
      distance_m: 3.0,
      space: "2m × 2m mat or soft ground",
      equipment: [],
      framing: "Full body in frame",
      demo: "guided mobility sequence",
    ),
    safety_notes: "Move within a comfortable range. This is general training guidance, not medical advice.",
    rest_guidance: None,
    age_appropriateness: "all",
    rep_min_gap_ms: 250.0,
    rep_min_confidence: 0.5,
  ),
  Drill(
    id: "box-strength",
    version: 1,
    title: "Box Strength",
    category: "strength",
    summary: "Controlled bodyweight squat/lunge repetitions.",
    target_types: [box_target_type.Repetitions, box_target_type.Sets],
    verification_capabilities: [
      PlayerPresence,
      ActiveMotion,
      ActiveDuration,
      RepCount,
      IntervalCompletion,
    ],
    rep_support: True,
    rep_support_note: None,
    setup: Setup(
      orientation: "portrait",
      distance_m: 2.5,
      space: "2m × 1m clear area",
      equipment: [],
      framing: "Full body side-on",
      demo: "bodyweight squats at controlled tempo",
    ),
    safety_notes: "Bodyweight only. Stop on any pain — recorded work still counts. Not medical advice.",
    rest_guidance: Some("Rest 60–90 seconds between sets."),
    age_appropriateness: "all",
    rep_min_gap_ms: 900.0,
    rep_min_confidence: 0.6,
  ),
  Drill(
    id: "box-interval",
    version: 1,
    title: "Box Interval",
    category: "conditioning",
    summary: "Timed work/rest intervals.",
    target_types: [box_target_type.Sets, box_target_type.Duration],
    verification_capabilities: [
      PlayerPresence,
      ActiveDuration,
      IntervalCompletion,
    ],
    rep_support: True,
    rep_support_note: None,
    setup: Setup(
      orientation: "landscape",
      distance_m: 5.0,
      space: "5m running lane",
      equipment: [],
      framing: "Whole lane in frame",
      demo: "60s work / 60s rest",
    ),
    safety_notes: default_safety,
    rest_guidance: Some(
      "Rest intervals are part of the drill — the rest clock never counts as active training and never breaks verification.",
    ),
    age_appropriateness: "all",
    rep_min_gap_ms: 250.0,
    rep_min_confidence: 0.5,
  ),
]

pub fn drill_by_id_version(id: String, version: Int) -> Option(Drill) {
  list.find(drills, fn(d) { d.id == id && d.version == version })
  |> option.from_result
}

/// The newest version of a drill.
pub fn latest_drill(id: String) -> Option(Drill) {
  drills
  |> list.filter(fn(d) { d.id == id })
  |> list.sort(fn(a, b) { int.compare(b.version, a.version) })
  |> list.first
  |> option.from_result
}

/// An observation provider. A session only verifies the capabilities its drill and its provider share.
pub type Provider {
  Provider(
    id: BoxProvider,
    version: Int,
    /// `configured` or `limited`; reported as the registry has it.
    status: String,
    label: Option(String),
    /// A test provider is never shown as real Box Cam evidence.
    test_only: Bool,
    capabilities: List(Capability),
    note: String,
  )
}

/// The registry as the TypeScript server declares it. `production_cv` is reported `configured`, as there: this server
/// has no video analysis (it is moving to a service of its own), and says so through its routes' answers and the
/// provider's health rather than by rewriting the registry.
pub const providers = [
  Provider(
    id: box_provider.ProductionCv,
    version: 1,
    status: "configured",
    label: None,
    test_only: False,
    capabilities: [
      PlayerPresence,
      BallPresence,
      ActiveMotion,
      ActiveDuration,
      RepCount,
    ],
    note: "Server-side computer vision observes supported Box Cam activity. Combine verification for these CV protocols remains disabled pending real-world validation.",
  ),
  Provider(
    id: box_provider.WebClient,
    version: 1,
    status: "limited",
    label: Some("web_limited"),
    test_only: False,
    capabilities: [PlayerPresence, ActiveDuration],
    note: "Web capture infers presence and activity from camera-stream availability and app foreground state only. It cannot count repetitions or classify technique.",
  ),
  Provider(
    id: box_provider.LocalTest,
    version: 1,
    status: "configured",
    label: None,
    test_only: True,
    capabilities: capabilities,
    note: "Deterministic test/demo fixture. Simulated observations are always labelled as simulated.",
  ),
]

pub fn provider(id: BoxProvider) -> Provider {
  let assert Ok(p) = list.find(providers, fn(p) { p.id == id })
  p
}

/// The provider a session may use: a test-only one exists only when the test provider is enabled.
pub fn provider_for(
  id: String,
  test_provider_enabled: Bool,
) -> Option(Provider) {
  case list.find(providers, fn(p) { box_provider.to_string(p.id) == id }) {
    Ok(p) if p.test_only && !test_provider_enabled -> None
    Ok(p) -> Some(p)
    Error(Nil) -> None
  }
}

/// What a session on this drill and provider can verify.
pub fn session_capabilities(
  drill: Option(Drill),
  provider_id: BoxProvider,
) -> List(Capability) {
  let offered = provider(provider_id).capabilities
  case drill {
    Some(d) ->
      list.filter(d.verification_capabilities, list.contains(offered, _))
    None -> []
  }
}

// ---------------------------------------------------------------------------------------------- the copy

/// Player copy per state: never "you didn't train" or "failed".
pub fn state_copy(state: session_row.VerificationState) -> String {
  case state {
    session_row.VerificationStateVerified ->
      "Box Cam observed activity consistent with this drill for the recorded duration."
    session_row.VerificationStatePartiallyVerified ->
      "Box Cam verified part of this session. Some activity could not be reliably observed because the player or ball left the camera view."
    session_row.VerificationStateUnableToVerify ->
      "ScoutBox could not reliably verify this session. Your training is not being marked as Box Cam Verified."
    session_row.VerificationStateCompletedUnverified ->
      "This session was recorded without Box Cam verification requirements being met, so it is not Box Cam Verified."
    session_row.VerificationStateCancelled ->
      "This Box Session was cancelled before completion."
    session_row.VerificationStateInvalidated ->
      "This Box Cam result was invalidated after review and no longer counts as Box Cam Verified evidence."
  }
}

pub const dev_activity_note =
  "This is evidence of recorded training activity. It is not proof of player ability."

// ------------------------------------------------------------------------------------------------- intervals

/// A span of the session, in milliseconds from its start.
pub type Span {
  Span(from_ms: Float, to_ms: Float)
}

/// An active or presence interval, with the quality the provider reported (good when it reported none).
pub type Interval {
  Interval(from_ms: Float, to_ms: Float, quality: BoxQuality)
}

/// Ordered and clamped to [0, max_ms] (no upper bound when None); empty spans are dropped.
pub fn norm_intervals(
  list: List(Interval),
  max_ms: Option(Float),
) -> List(Interval) {
  list
  |> list.filter_map(fn(iv) {
    let #(from, to) = case iv.to_ms <. iv.from_ms {
      True -> #(iv.to_ms, iv.from_ms)
      False -> #(iv.from_ms, iv.to_ms)
    }
    let from = float.max(0.0, from)
    let to = case max_ms {
      Some(m) -> float.min(m, to)
      None -> to
    }
    case to -. from <=. 0.0 {
      True -> Error(Nil)
      False -> Ok(Interval(from_ms: from, to_ms: to, quality: iv.quality))
    }
  })
  |> list.sort(fn(a, b) {
    float.compare(a.from_ms, b.from_ms)
    |> order.break_tie(float.compare(a.to_ms, b.to_ms))
  })
}

fn spans(list: List(Interval)) -> List(Span) {
  list.map(list, fn(iv) { Span(iv.from_ms, iv.to_ms) })
}

fn norm_spans(list: List(Span), max_ms: Option(Float)) -> List(Span) {
  list
  |> list.map(fn(s) { Interval(s.from_ms, s.to_ms, box_quality.Good) })
  |> norm_intervals(max_ms)
  |> spans
}

/// Quality-agnostic union: double-reported time doesn't double.
pub fn merge_intervals(list: List(Span)) -> List(Span) {
  list
  |> list.sort(fn(a, b) { float.compare(a.from_ms, b.from_ms) })
  |> list.fold([], fn(acc: List(Span), iv: Span) {
    case acc {
      [last, ..rest] if iv.from_ms <=. last.to_ms -> [
        Span(last.from_ms, float.max(last.to_ms, iv.to_ms)),
        ..rest
      ]
      _ -> [iv, ..acc]
    }
  })
  |> list.reverse
}

pub fn subtract_intervals(base: List(Span), cuts: List(Span)) -> List(Span) {
  list.fold(merge_intervals(cuts), merge_intervals(base), fn(current, cut) {
    list.flat_map(current, fn(iv) {
      case cut.to_ms <=. iv.from_ms || cut.from_ms >=. iv.to_ms {
        True -> [iv]
        False ->
          list.append(
            case cut.from_ms >. iv.from_ms {
              True -> [Span(iv.from_ms, cut.from_ms)]
              False -> []
            },
            case cut.to_ms <. iv.to_ms {
              True -> [Span(cut.to_ms, iv.to_ms)]
              False -> []
            },
          )
      }
    })
  })
}

pub fn sum_intervals(list: List(Span)) -> Float {
  list.fold(list, 0.0, fn(total, iv) { total +. { iv.to_ms -. iv.from_ms } })
}

pub fn intersect_intervals(a: List(Span), b: List(Span)) -> List(Span) {
  let b = merge_intervals(b)
  merge_intervals(a)
  |> list.flat_map(fn(x) {
    list.filter_map(b, fn(y) {
      let from = float.max(x.from_ms, y.from_ms)
      let to = float.min(x.to_ms, y.to_ms)
      case to >. from {
        True -> Ok(Span(from, to))
        False -> Error(Nil)
      }
    })
  })
  |> merge_intervals
}

/// Active intervals of acceptable quality, minus pauses and interruptions, clamped to the server-known session
/// duration. A ball-required drill passes the ball's intervals as `required`: activity only counts while the ball
/// was also visible.
pub fn verified_active_ms(
  active active: List(Interval),
  pauses pauses: List(Span),
  interruptions interruptions: List(Span),
  session_duration_ms duration: Float,
  required required: Option(List(Span)),
) -> Float {
  let usable =
    norm_intervals(active, Some(duration))
    |> list.filter(fn(iv) { iv.quality != box_quality.Insufficient })
    |> spans
  let usable = case required {
    Some(req) -> intersect_intervals(usable, norm_spans(req, Some(duration)))
    None -> usable
  }
  let cuts =
    list.append(
      norm_spans(pauses, Some(duration)),
      norm_spans(interruptions, Some(duration)),
    )
  sum_intervals(subtract_intervals(usable, cuts))
}

// ------------------------------------------------------------------------------------------------------ reps

pub type Rep {
  /// A rep with no reported confidence counts as certain.
  Rep(at_ms: Float, confidence: Option(Float))
}

pub type CountedRep {
  CountedRep(at_ms: Float, confidence: Float)
}

/// Confidence-gated, windowed reps (no upper bound when `session_duration_ms` is None), with physically impossible
/// rapid duplicates (under the drill's minimum gap) collapsed.
pub fn dedupe_reps(
  reps: List(Rep),
  session_duration_ms session_duration_ms: Option(Float),
  min_gap_ms min_gap_ms: Float,
  min_confidence min_confidence: Float,
) -> List(CountedRep) {
  reps
  |> list.filter_map(fn(r) {
    let r = CountedRep(r.at_ms, option.unwrap(r.confidence, 1.0))
    let in_window = case session_duration_ms {
      Some(d) -> r.at_ms <=. d
      None -> True
    }
    case r.at_ms >=. 0.0 && in_window && r.confidence >=. min_confidence {
      True -> Ok(r)
      False -> Error(Nil)
    }
  })
  |> list.sort(fn(a, b) { float.compare(a.at_ms, b.at_ms) })
  |> list.fold([], fn(acc: List(CountedRep), r: CountedRep) {
    case acc {
      [last, ..] if r.at_ms -. last.at_ms <. min_gap_ms -> acc
      _ -> [r, ..acc]
    }
  })
  |> list.reverse
}

// ------------------------------------------------------------------------------------------------ completion

pub type Target {
  Target(type_: BoxTargetType, value: Float)
}

/// Strictly from verified values: near misses aren't rounded up. None when the drill and provider cannot verify
/// the target's metric.
pub fn target_completed(
  target: Target,
  active_ms active_ms: Float,
  reps reps: Option(Int),
  sets_completed sets_completed: Int,
  capabilities capabilities: List(Capability),
) -> Option(Bool) {
  case target.type_, reps {
    box_target_type.Duration, _ -> Some(active_ms >=. target.value)
    box_target_type.Repetitions, Some(n) ->
      case list.contains(capabilities, RepCount) {
        True -> Some(int.to_float(n) >=. target.value)
        False -> None
      }
    box_target_type.Repetitions, None -> None
    box_target_type.Sets, _ ->
      case list.contains(capabilities, IntervalCompletion) {
        True -> Some(int.to_float(sets_completed) >=. target.value)
        False -> None
      }
  }
}

// --------------------------------------------------------------------------------------------------- quality

pub fn detection_quality(
  observed_ms observed_ms: Float,
  session_duration_ms duration: Float,
) -> BoxQuality {
  use <- bool.guard(duration <=. 0.0, box_quality.Insufficient)
  let ratio = observed_ms /. duration
  case ratio >=. 0.75, ratio >=. 0.2 {
    True, _ -> box_quality.Good
    False, True -> box_quality.Degraded
    False, False -> box_quality.Insufficient
  }
}

// ---------------------------------------------------------------------------------------- verification state

/// Why a session is in its verification state. Stored as text in `box_session_reasons`.
pub type Reason {
  SessionCancelled
  ProviderUnavailable
  LivenessNotEstablished
  NoActivityObserved
  ObservationInsufficient
  TargetMetricNotSupported
  ObservationGaps
  ObservationQualityDegraded
  TargetNotYetCompleted
  RepCountNotConfigured
}

pub fn reason_to_string(r: Reason) -> String {
  case r {
    SessionCancelled -> "SESSION_CANCELLED"
    ProviderUnavailable -> "PROVIDER_UNAVAILABLE"
    LivenessNotEstablished -> "LIVENESS_NOT_ESTABLISHED"
    NoActivityObserved -> "NO_ACTIVITY_OBSERVED"
    ObservationInsufficient -> "OBSERVATION_INSUFFICIENT"
    TargetMetricNotSupported -> "TARGET_METRIC_NOT_SUPPORTED"
    ObservationGaps -> "OBSERVATION_GAPS"
    ObservationQualityDegraded -> "OBSERVATION_QUALITY_DEGRADED"
    TargetNotYetCompleted -> "TARGET_NOT_YET_COMPLETED"
    RepCountNotConfigured -> "REP_COUNT_NOT_CONFIGURED"
  }
}

/// What the verification state is derived from. `quality` is None when nothing was judged.
pub type Observed {
  Observed(
    cancelled: Bool,
    liveness_passed: Bool,
    provider_available: Bool,
    active_ms: Float,
    completed: Option(Bool),
    quality: Option(BoxQuality),
    interruptions_count: Int,
    unsupported_target_metric: Bool,
  )
}

/// Partial observed work stays partially verified; only no reliable observation at all is unable to verify.
pub fn derive_verification(
  o: Observed,
) -> #(session_row.VerificationState, List(Reason)) {
  use <- bool.guard(
    o.cancelled,
    #(session_row.VerificationStateCancelled, [
      SessionCancelled,
    ]),
  )
  let blocked =
    list.flatten([
      case o.provider_available {
        True -> []
        False -> [ProviderUnavailable]
      },
      case o.liveness_passed {
        True -> []
        False -> [LivenessNotEstablished]
      },
    ])
  use <- bool.guard(blocked != [], #(
    session_row.VerificationStateCompletedUnverified,
    blocked,
  ))
  let insufficient = o.quality == Some(box_quality.Insufficient)
  use <- bool.guard(
    insufficient || o.active_ms <=. 0.0,
    #(session_row.VerificationStateUnableToVerify, [
      case o.active_ms <=. 0.0 {
        True -> NoActivityObserved
        False -> ObservationInsufficient
      },
    ]),
  )
  let reasons =
    list.flatten([
      case o.unsupported_target_metric {
        True -> [TargetMetricNotSupported]
        False -> []
      },
      case o.interruptions_count > 0 {
        True -> [ObservationGaps]
        False -> []
      },
      case o.quality == Some(box_quality.Degraded) {
        True -> [ObservationQualityDegraded]
        False -> []
      },
    ])
  case
    o.completed == Some(True)
    && o.quality == Some(box_quality.Good)
    && !o.unsupported_target_metric
  {
    True -> #(session_row.VerificationStateVerified, reasons)
    False -> #(
      session_row.VerificationStatePartiallyVerified,
      case o.completed == Some(True) {
        True -> reasons
        False -> list.append(reasons, [TargetNotYetCompleted])
      },
    )
  }
}

// ----------------------------------------------------------------------------------- finished sessions' rules

/// A finished session as the streak, the bests, challenge progress and the activity summary read it. `at` is when
/// it ended (when it started, if it never ended).
pub type Finished {
  Finished(
    id: String,
    drill_id: String,
    drill_version: Int,
    state: Option(session_row.VerificationState),
    verified_active_ms: Float,
    verified_reps: Option(Int),
    at: Int,
  )
}

fn counts(s: Finished) -> Bool {
  s.state == Some(session_row.VerificationStateVerified)
  || s.state == Some(session_row.VerificationStatePartiallyVerified)
}

const week_ms = 604_800_000

/// Consecutive weeks with verified activity, counting back from now. Rest days don't matter; only a whole week
/// without a session ends a streak, and the current week, still in progress, never does.
pub fn box_streak_weeks(sessions: List(Finished), now: Int) -> Int {
  let weeks =
    sessions
    |> list.filter(fn(s) { counts(s) && s.verified_active_ms >. 0.0 })
    |> list.map(fn(s) { int.floor_divide(s.at, week_ms) |> unwrap_int })
    |> set.from_list
  let this_week = int.floor_divide(now, week_ms) |> unwrap_int
  let current = case set.contains(weeks, this_week) {
    True -> 1
    False -> 0
  }
  current + run_back(weeks, this_week - 1)
}

fn run_back(weeks: set.Set(Int), w: Int) -> Int {
  case set.contains(weeks, w) {
    True -> 1 + run_back(weeks, w - 1)
    False -> 0
  }
}

fn unwrap_int(r: Result(Int, Nil)) -> Int {
  let assert Ok(n) = r
  n
}

pub type Best {
  Best(
    drill_id: String,
    drill_version: Int,
    best_active_ms: Float,
    best_reps: Option(Int),
  )
}

/// Per drill@version, in the order each was first seen: different detector versions are different measurements.
pub fn box_bests(sessions: List(Finished)) -> List(Best) {
  let #(order, bests) =
    list.fold(sessions, #([], dict.new()), fn(acc, s) {
      let #(order, bests) = acc
      use <- bool.guard(!counts(s), acc)
      let key = s.drill_id <> "@" <> int.to_string(s.drill_version)
      let #(order, b) = case dict.get(bests, key) {
        Ok(b) -> #(order, b)
        Error(Nil) -> #(
          [key, ..order],
          Best(s.drill_id, s.drill_version, 0.0, None),
        )
      }
      let b = case s.verified_active_ms >. b.best_active_ms {
        True -> Best(..b, best_active_ms: s.verified_active_ms)
        False -> b
      }
      let b = case s.verified_reps, b.best_reps {
        Some(n), None -> Best(..b, best_reps: Some(n))
        Some(n), Some(best) if n > best -> Best(..b, best_reps: Some(n))
        _, _ -> b
      }
      #(order, dict.insert(bests, key, b))
    })
  list.reverse(order)
  |> list.filter_map(dict.get(bests, _))
}

pub type ChallengeWindow {
  ChallengeWindow(
    drill_id: String,
    metric: challenge_row.Metric,
    target_total: Int,
    starts_at: Int,
    ends_at: Int,
  )
}

pub type Progress {
  Progress(total: Int, completed: Bool, session_ids: List(String))
}

/// A session counts once, however often it is offered (replay-safe). A window bound of 0 is no bound, as the
/// TypeScript server reads it.
pub fn challenge_progress(
  challenge: ChallengeWindow,
  sessions: List(Finished),
) -> Progress {
  let #(total, ids) =
    list.fold(sessions, #(0, []), fn(acc, s) {
      let #(total, ids) = acc
      let skip =
        list.contains(ids, s.id)
        || s.drill_id != challenge.drill_id
        || !counts(s)
        || { challenge.starts_at != 0 && s.at < challenge.starts_at }
        || { challenge.ends_at != 0 && s.at > challenge.ends_at }
      use <- bool.guard(skip, acc)
      let add = case challenge.metric {
        challenge_row.Reps -> option.unwrap(s.verified_reps, 0)
        challenge_row.ActiveMinutes ->
          float.truncate(float.floor(s.verified_active_ms /. 60_000.0))
      }
      #(total + add, [s.id, ..ids])
    })
  Progress(
    total:,
    completed: total >= challenge.target_total,
    session_ids: list.reverse(ids),
  )
}

// --------------------------------------------------------------------------------------------- the integrity hash

/// What a finalized session's integrity hash covers.
pub type Hashed {
  Hashed(
    id: String,
    player_id: String,
    drill_id: String,
    drill_version: Int,
    target: Target,
    started_at: Option(Int),
    ended_at: Option(Int),
    session_duration_ms: Float,
    verified_active_ms: Float,
    verified_reps: Option(Int),
    sets_completed: Option(Int),
    state: session_row.VerificationState,
    provider: BoxProvider,
    provider_version: Int,
  )
}

/// The SHA-256 of the session's canonical JSON, as the TypeScript server writes it.
pub fn result_hash(h: Hashed) -> String {
  json.object([
    #("id", json.string(h.id)),
    #("playerId", json.string(h.player_id)),
    #("drillId", json.string(h.drill_id)),
    #("drillVersion", json.int(h.drill_version)),
    #(
      "target",
      json.object([
        #("type", box_target_type.to_json(h.target.type_)),
        #("value", json_text.number(h.target.value)),
      ]),
    ),
    #("startedAt", json.nullable(h.started_at, json.int)),
    #("endedAt", json.nullable(h.ended_at, json.int)),
    #("sessionDurationMs", json_text.number(h.session_duration_ms)),
    #("verifiedActiveMs", json_text.number(h.verified_active_ms)),
    #("verifiedReps", json.nullable(h.verified_reps, json.int)),
    #("setsCompleted", json.int(option.unwrap(h.sets_completed, 0))),
    #("verificationState", session_row.verification_state_to_json(h.state)),
    #("provider", box_provider.to_json(h.provider)),
    #("providerVersion", json.int(h.provider_version)),
  ])
  |> json.to_string
  |> secrets.sha256_hex
}

// ------------------------------------------------------------------------------------------------------- copy

/// `m:ss` of whole seconds.
pub fn fmt_ms(ms: Float) -> String {
  let s = float.truncate(float.floor(ms /. 1000.0))
  int.to_string(int.floor_divide(s, 60) |> unwrap_int)
  <> ":"
  <> string.pad_start(
    int.to_string(int.modulo(s, 60) |> unwrap_int),
    to: 2,
    with: "0",
  )
}

pub fn box_cam_detail(
  verified_active_ms: Float,
  verified_reps: Option(Int),
) -> String {
  let base = "Recorded live through ScoutBox Box Cam."
  case verified_reps {
    Some(n) ->
      base
      <> " ScoutBox observed "
      <> int.to_string(n)
      <> " repetitions consistent with the selected supported drill across "
      <> fmt_ms(verified_active_ms)
      <> " of active capture."
    None ->
      base
      <> " ScoutBox observed activity consistent with the selected supported drill for "
      <> fmt_ms(verified_active_ms)
      <> "."
  }
}

// ------------------------------------------------------------------------------------------ development activity

/// An assignment as the activity summary counts it.
pub type ActivityAssignment {
  ActivityAssignment(created_at: Int, cancelled: Bool, completed: Bool)
}

/// The last `days` of recorded training: finished sessions that still stand, the verified time among them and
/// the categories it went to (at most three, most time first), and the assignments set in the window.
pub type Activity {
  Activity(
    days: Int,
    box_sessions: Int,
    verified_active_ms: Float,
    assigned: Int,
    assigned_completed: Int,
    focus: List(#(String, Float)),
  )
}

pub fn development_activity(
  sessions: List(Finished),
  assignments: List(ActivityAssignment),
  days: Int,
  now: Int,
) -> Activity {
  let since = now - days * 86_400_000
  let recent =
    list.filter(sessions, fn(s) {
      case s.state {
        Some(session_row.VerificationStateCancelled)
        | Some(session_row.VerificationStateInvalidated)
        | None -> False
        Some(_) -> s.at >= since
      }
    })
  let verified = list.filter(recent, counts)
  let #(order, by_category) =
    list.fold(verified, #([], dict.new()), fn(acc, s) {
      let #(order, totals) = acc
      let category = case latest_drill(s.drill_id) {
        Some(d) -> d.category
        None -> "training"
      }
      case dict.get(totals, category) {
        Ok(ms) -> #(
          order,
          dict.insert(totals, category, ms +. s.verified_active_ms),
        )
        Error(Nil) -> #(
          [category, ..order],
          dict.insert(totals, category, s.verified_active_ms),
        )
      }
    })
  let focus =
    list.reverse(order)
    |> list.filter_map(fn(c) {
      dict.get(by_category, c) |> result_map(fn(ms) { #(c, ms) })
    })
    |> list.sort(fn(a, b) { float.compare(b.1, a.1) })
    |> list.take(3)
  let assigned =
    list.filter(assignments, fn(a) { a.created_at >= since && !a.cancelled })
  Activity(
    days:,
    box_sessions: list.length(recent),
    verified_active_ms: list.fold(verified, 0.0, fn(t, s) {
      t +. s.verified_active_ms
    }),
    assigned: list.length(assigned),
    assigned_completed: list.count(assigned, fn(a) { a.completed }),
    focus:,
  )
}

fn result_map(r: Result(a, Nil), f: fn(a) -> b) -> Result(b, Nil) {
  case r {
    Ok(v) -> Ok(f(v))
    Error(Nil) -> Error(Nil)
  }
}

/// The summary under `note`: the Passport's own (`dev_activity_note`), or the Room's.
pub fn activity_json(a: Activity, note: String) -> json.Json {
  json.object([
    #("days", json.int(a.days)),
    #("boxSessions", json.int(a.box_sessions)),
    #("verifiedActiveMs", json_text.number(a.verified_active_ms)),
    #("assigned", json.int(a.assigned)),
    #("assignedCompleted", json.int(a.assigned_completed)),
    #(
      "focus",
      json.array(a.focus, fn(f) {
        json.object([
          #("category", json.string(f.0)),
          #("activeMs", json_text.number(f.1)),
        ])
      }),
    ),
    #("note", json.string(note)),
  ])
}
