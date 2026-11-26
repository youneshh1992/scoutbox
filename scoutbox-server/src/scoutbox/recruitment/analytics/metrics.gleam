//// Recruitment analytics: the metric registry and its statistics (domains/recruitment/analytics/metrics.mjs).
//// Metrics measure the recruitment process, never the worth of a player or a scout: each is a count or a
//// duration over workflow records.
////
//// The TypeScript server asserts the registry at boot (`assertMetricRegistry`); here it is a constant, so
//// `registry_problems` is asserted by a unit test instead, and `test/scoutbox/spec_test.gleam` proves the
//// registry equals the TypeScript one.

import gleam/float
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/result
import gleam/string
import scoutbox/platform/clock
import scoutbox/platform/json_text
import scoutbox/platform/temporal.{type Day}

pub const policy_version = 1

/// Below this many observations a ratio or median is withheld and the raw numbers shown instead; counts are
/// never suppressed.
pub const small_n_min = 5

pub type Family {
  Family(id: String, label: String)
}

/// In the order the dashboard renders.
pub const families = [
  Family("pipeline", "Pipeline shape"),
  Family("duration", "How long the process takes"),
  Family("aging", "Work that has stopped moving"),
  Family("decision_record", "Decision record hygiene"),
  Family("coverage", "Coverage of your stated demand"),
  Family("source", "Where work comes from"),
  Family("watchlist", "Dynamic watchlists"),
]

pub fn family_ids() -> List(String) {
  list.map(families, fn(f) { f.id })
}

pub fn family_label(id: String) -> String {
  list.find(families, fn(f) { f.id == id })
  |> result.map(fn(f) { f.label })
  |> result.unwrap(id)
}

/// Every metric declares one, because "how many rooms" means different things under each.
pub const time_semantics = [
  #("point_in_time", "The state of the world now. The window does not apply."),
  #(
    "window_entry",
    "Counted in the window the entry event happened in (a room opened, a decision written).",
  ),
  #(
    "window_completion",
    "Counted in the window the completing event happened in (a room reached a terminal status, a trial finished).",
  ),
]

pub fn time_semantics_json() -> Json {
  json.object(list.map(time_semantics, fn(t) { #(t.0, json.string(t.1)) }))
}

/// No person dimension: a per-person breakdown of process counts is a scout leaderboard.
pub const group_dimensions = [
  "status", "source_context", "priority", "reason_category", "brief",
]

/// Refused by name, so the refusal says why instead of reading like a typo.
pub const person_dimensions = [
  "scout", "user", "owner", "lead_scout", "leadScout", "assignee", "author",
  "created_by", "createdBy", "player",
]

pub const association_note =
  "ScoutBox observes that these records share this property and later reached this stage. It does not show that the property caused it: people choose where to look, and the players they find differ in ways ScoutBox does not measure."

/// Never built, under any of these names: synonyms are the failure mode.
pub const forbidden_metric_names = [
  "recruitment score", "scout score", "player success score",
  "recruitment efficiency score", "talent conversion score",
  "club intelligence score", "scouting score", "performance score",
  "overall score", "composite score", "leaderboard", "scout ranking",
  "top scout", "best scout", "player ranking", "talent score", "potential score",
  "success rate per scout",
]

// ---------------------------------------------------------------- registry

/// What a metric's figure is: a count or a rate (`ratio`, with whether it offers a rate), or a distribution.
pub type Measure {
  IsRatio(Bool)
  IsDistribution
}

/// `reads` lists every record field the projection may touch and never reaches a client. `limitation` is
/// rendered next to the number.
pub type Metric {
  Metric(
    id: String,
    family: String,
    name: String,
    unit: String,
    semantics: String,
    sources: List(String),
    reads: List(String),
    measure: Measure,
    association: Bool,
    limitation: String,
  )
}

pub const metrics = [
  Metric(
    id: "pipeline_stage_counts",
    family: "pipeline",
    name: "Rooms by status",
    unit: "rooms",
    semantics: "point_in_time",
    sources: ["recruitmentCases"],
    reads: ["room.status"],
    measure: IsRatio(False),
    association: False,
    limitation: "A status is where a room is, not how far it has travelled. A room that has sat in Watching for a year looks identical here to one opened this morning.",
  ),
  Metric(
    id: "funnel_progression",
    family: "pipeline",
    name: "Stages reached",
    unit: "rooms",
    semantics: "window_entry",
    sources: ["recruitmentCases"],
    reads: ["createdAt", "history.at", "history.action", "history.detail.to"],
    measure: IsRatio(True),
    association: False,
    limitation: "Rooms can be reopened, so this is not a one-way funnel: a room counts once for each stage it ever reached, not once per visit. A recent window is incomplete by construction — rooms opened last week have not had time to reach a signing.",
  ),
  Metric(
    id: "trial_process",
    family: "pipeline",
    name: "Trial process",
    unit: "trials",
    semantics: "window_entry",
    sources: ["requests", "trials"],
    reads: [
      "type",
      "caseId",
      "status",
      "createdAt",
      "respondedAt",
      "acceptedAt",
      "schedule.confirmedAt",
      "completion.state",
      "completion.at",
      "subjectRemovedAt",
    ],
    measure: IsRatio(False),
    association: False,
    limitation: "These are counts of process steps in the window — invitations sent, accepted, schedules confirmed, trials completed, cancelled or declined — never how a trial went. No rate is built on them: a club that invites five players and completes three has not \"converted 60%\", it has run three trials.",
  ),
  Metric(
    id: "decision_outcomes",
    family: "pipeline",
    name: "Formal decisions",
    unit: "decisions",
    semantics: "window_entry",
    sources: ["roomDecisions"],
    reads: ["kind", "state", "outcome", "createdAt", "supersededById", "roomId"],
    measure: IsRatio(False),
    association: False,
    limitation: "Counts of formal recruitment decisions finalized in the window, by outcome — progress, hold, reject — and how many were later superseded. A process count, never a verdict on anyone: a club that rejects nine players and progresses one has run ten decisions, not ranked ten people.",
  ),
  Metric(
    id: "journey_evidence_funnel",
    family: "pipeline",
    name: "Journey stages (from the records)",
    unit: "rooms",
    semantics: "window_entry",
    sources: [
      "recruitmentCases",
      "recruitmentContacts",
      "requests",
      "trials",
      "assessments",
      "roomDecisions",
      "recruitmentOffers",
      "signingPackages",
      "signings",
    ],
    reads: [
      "createdAt",
      "caseId",
      "orgId",
      "playerId",
      "status",
      "deliveredAt",
      "occurredAt",
      "recordedAt",
      "cancelledAt",
      "type",
      "acceptedAt",
      "schedule.confirmedAt",
      "completion.state",
      "completion.at",
      "state",
      "submittedAt",
      "kind",
      "outcome",
      "supersededById",
      "roomId",
      "revisions.status",
      "revisions.issuedAt",
      "revisions.respondedAt",
      "signingPackageId",
      "ts",
      "history.action",
      "history.detail.to",
    ],
    measure: IsRatio(False),
    association: False,
    limitation: "Each stage counts cases for which the record itself exists — a delivered contact, a completed trial, a submitted assessment, a finalized decision, an issued or answered Offer, a completed signing — not cases whose status merely says so. A case counts once per stage however many retries or revisions it carried. Cases whose history reached a stage with no record behind it are shown apart as \"history only\"; they are older cases, not progress. A recent window is incomplete by construction.",
  ),
  Metric(
    id: "exit_reason_mix",
    family: "pipeline",
    name: "Why rooms ended",
    unit: "decisions",
    semantics: "window_completion",
    sources: ["roomDecisions", "recruitmentCases"],
    reads: ["reasonCodes", "createdAt", "roomId"],
    measure: IsRatio(True),
    association: False,
    limitation: "This is the reason the club recorded, not the reason that operated. A decision carrying codes in two categories counts in both, so the shares add up to more than 100%.",
  ),
  Metric(
    id: "time_to_first_decision",
    family: "duration",
    name: "Time to first decision",
    unit: "days",
    semantics: "window_completion",
    sources: ["recruitmentCases", "roomDecisions"],
    reads: ["createdAt", "roomId"],
    measure: IsDistribution,
    association: False,
    limitation: "Rooms that never reached a decision are excluded, so this measures the rooms that got there. The number excluded is shown beside it.",
  ),
  Metric(
    id: "time_in_stage",
    family: "duration",
    name: "Time spent in each stage",
    unit: "days",
    semantics: "window_completion",
    sources: ["recruitmentCases"],
    reads: [
      "history.at",
      "history.action",
      "history.detail.from",
      "history.detail.to",
    ],
    measure: IsDistribution,
    association: False,
    limitation: "Only completed visits count. A stage where everything is stuck therefore looks fast, because only the rooms that escaped it are measured — Stalled rooms is the figure that catches that.",
  ),
  Metric(
    id: "time_to_trial_requested",
    family: "duration",
    name: "Time from opening to trial requested",
    unit: "days",
    semantics: "window_completion",
    sources: ["recruitmentCases"],
    reads: ["createdAt", "history.at", "history.detail.to"],
    measure: IsDistribution,
    association: False,
    limitation: "A club that opens rooms late in its own process looks fast here. This measures the ScoutBox record, not the club’s thinking.",
  ),
  Metric(
    id: "time_trial_requested_to_completed",
    family: "duration",
    name: "Trial requested to completed",
    unit: "days",
    semantics: "window_completion",
    sources: ["recruitmentCases"],
    reads: ["history.at", "history.detail.to"],
    measure: IsDistribution,
    association: False,
    limitation: "Guardian response, pitch availability and school holidays all live inside this number and cannot be separated from it.",
  ),
  Metric(
    id: "open_room_age",
    family: "duration",
    name: "Age of open rooms",
    unit: "days",
    semantics: "point_in_time",
    sources: ["recruitmentCases"],
    reads: ["createdAt", "room.status"],
    measure: IsDistribution,
    association: False,
    limitation: "Age is not neglect. A long-running room on a fourteen-year-old being tracked to sixteen is the product working as intended.",
  ),
  Metric(
    id: "stalled_rooms",
    family: "aging",
    name: "Rooms with no recent activity",
    unit: "rooms",
    semantics: "point_in_time",
    sources: ["recruitmentCases"],
    reads: ["room.status", "history.at"],
    measure: IsRatio(False),
    association: False,
    limitation: "No activity in ScoutBox is not no activity. A scout who watched a player on Saturday and did not write it down produces a stalled room. This is a prompt to look, not a finding.",
  ),
  Metric(
    id: "overdue_trial_reports",
    family: "aging",
    name: "Trial reports past due",
    unit: "trials",
    semantics: "point_in_time",
    sources: ["trials"],
    reads: ["status", "reportDueAt", "orgId"],
    measure: IsRatio(False),
    association: False,
    limitation: "This surfaces an obligation the server already enforces — unfiled reports block new trial requests. It adds no new judgement.",
  ),
  Metric(
    id: "decision_outstanding",
    family: "aging",
    name: "Offers with no recorded decision",
    unit: "rooms",
    semantics: "point_in_time",
    sources: ["recruitmentCases", "roomDecisions"],
    reads: ["room.status", "roomId"],
    measure: IsRatio(False),
    association: False,
    limitation: "This reuses the Recruitment Room’s own readiness rule. If that rule is wrong, this is wrong in exactly the same way — deliberately, so there is one definition rather than two.",
  ),
  Metric(
    id: "terminal_with_recorded_decision",
    family: "decision_record",
    name: "Endings with a recorded decision",
    unit: "rooms",
    semantics: "window_completion",
    sources: ["recruitmentCases", "roomDecisions"],
    reads: [
      "room.status",
      "history.at",
      "history.detail.to",
      "roomId",
      "createdAt",
    ],
    measure: IsRatio(True),
    association: False,
    limitation: "Ending a room for a reason-required status records a decision automatically, so this rate is high by construction. Its value is in the exceptions.",
  ),
  Metric(
    id: "superseded_decision_rate",
    family: "decision_record",
    name: "Decisions later revised",
    unit: "decisions",
    semantics: "window_entry",
    sources: ["roomDecisions"],
    reads: ["createdAt", "supersededById"],
    measure: IsRatio(True),
    association: False,
    limitation: "Revising a decision is healthy. A high figure here is not a fault and is never coloured as one.",
  ),
  Metric(
    id: "evidence_limited_exits",
    family: "decision_record",
    name: "Endings limited by evidence",
    unit: "decisions",
    semantics: "window_completion",
    sources: ["roomDecisions"],
    reads: ["reasonCodes", "createdAt"],
    measure: IsRatio(True),
    association: False,
    limitation: "Association only. It does not follow that collecting the missing evidence would have changed any of these decisions.",
  ),
  Metric(
    id: "reopen_rate",
    family: "decision_record",
    name: "Rooms reopened after ending",
    unit: "rooms",
    semantics: "window_entry",
    sources: ["recruitmentCases"],
    reads: [
      "history.at",
      "history.action",
      "history.detail.from",
      "history.detail.to",
    ],
    measure: IsRatio(True),
    association: False,
    limitation: "Reopening is intended behaviour — Second Look exists to cause it. High is not bad.",
  ),
  Metric(
    id: "briefs_live",
    family: "coverage",
    name: "Live recruitment briefs",
    unit: "briefs",
    semantics: "point_in_time",
    sources: ["recruitmentBriefs"],
    reads: ["status", "activeFrom", "activeUntil"],
    measure: IsRatio(False),
    association: False,
    limitation: "A brief being live says nothing about whether anyone is working it.",
  ),
  Metric(
    id: "nobody_missed_backlog",
    family: "coverage",
    name: "Unreviewed eligible players",
    unit: "reviews",
    semantics: "point_in_time",
    sources: ["nobodyMissedReviews", "recruitmentBriefs"],
    reads: ["state", "briefId"],
    measure: IsRatio(False),
    association: False,
    limitation: "The backlog is a function of how wide the brief is. Widening a brief creates backlog without anyone having done anything wrong.",
  ),
  Metric(
    id: "nobody_missed_review_rate",
    family: "coverage",
    name: "Eligible players reviewed",
    unit: "reviews",
    semantics: "point_in_time",
    sources: ["nobodyMissedReviews", "recruitmentBriefs"],
    reads: ["state", "briefId"],
    measure: IsRatio(True),
    association: False,
    limitation: "Dismissing a candidate counts as reviewing them. This measures that the club looked, not what it concluded.",
  ),
  Metric(
    id: "second_look_backlog",
    family: "coverage",
    name: "Open Second Look items",
    unit: "items",
    semantics: "point_in_time",
    sources: ["secondLookItems"],
    reads: ["status", "createdAt"],
    measure: IsRatio(False),
    association: False,
    limitation: "An expired item is not backlog — expiry is a designed outcome and is counted separately.",
  ),
  Metric(
    id: "second_look_response_time",
    family: "coverage",
    name: "Time to respond to Second Look",
    unit: "days",
    semantics: "window_completion",
    sources: ["secondLookItems"],
    reads: ["status", "createdAt", "updatedAt"],
    measure: IsDistribution,
    association: False,
    limitation: "Items never touched are absent from this figure. Their count is shown beside it.",
  ),
  Metric(
    id: "room_source_mix",
    family: "source",
    name: "Where rooms came from",
    unit: "rooms",
    semantics: "window_entry",
    sources: ["recruitmentCases"],
    reads: ["createdAt", "room.sourceContext"],
    measure: IsRatio(True),
    association: False,
    limitation: "Direct is the fallback ScoutBox assigns to anything it does not recognise, so it is a residual bucket rather than a surface people used.",
  ),
  Metric(
    id: "source_stage_reach",
    family: "source",
    name: "Stages reached, by source",
    unit: "rooms",
    semantics: "window_entry",
    sources: ["recruitmentCases"],
    reads: ["createdAt", "room.sourceContext", "history.detail.to"],
    measure: IsRatio(True),
    association: True,
    limitation: "Confounded by construction, and never a ranking of surfaces: sources are listed alphabetically. Most will be withheld for too few rooms, which is the correct outcome rather than a gap.",
  ),
  Metric(
    id: "active_watchlists",
    family: "watchlist",
    name: "Active dynamic watchlists",
    unit: "watchlists",
    semantics: "point_in_time",
    sources: ["dynamicWatchlists"],
    reads: ["status"],
    measure: IsRatio(False),
    association: False,
    limitation: "A big list is a wide set of criteria, nothing more.",
  ),
  Metric(
    id: "watchlist_membership_churn",
    family: "watchlist",
    name: "Players entering and leaving lists",
    unit: "changes",
    semantics: "window_entry",
    sources: ["watchlistHistory"],
    reads: ["at", "entered", "exited"],
    measure: IsRatio(False),
    association: False,
    limitation: "ScoutBox does not recompute watchlists in the background: membership is worked out when someone opens a list. This counts those recalculations, not the moment a player’s facts changed — a list nobody opens records no change at all.",
  ),
]

pub fn metric_ids() -> List(String) {
  list.map(metrics, fn(m) { m.id })
}

/// The metric `id`. Every caller names a registry entry, so a miss is a broken invariant.
pub fn metric(id: String) -> Metric {
  let assert Ok(m) = list.find(metrics, fn(m) { m.id == id })
  m
}

/// The metric as it travels with its figure: everything but `reads`, in the registry's key order.
pub fn wire(id: String) -> List(#(String, Json)) {
  let m = metric(id)
  list.flatten([
    [
      #("id", json.string(m.id)),
      #("family", json.string(m.family)),
      #("name", json.string(m.name)),
      #("unit", json.string(m.unit)),
      #("semantics", json.string(m.semantics)),
      #("sources", json.array(m.sources, json.string)),
    ],
    case m.measure {
      IsRatio(r) -> [#("ratio", json.bool(r))]
      IsDistribution -> [#("distribution", json.bool(True))]
    },
    case m.association {
      True -> [#("association", json.bool(True))]
      False -> []
    },
    [#("limitation", json.string(m.limitation))],
  ])
}

/// What `assertMetricRegistry` refuses at boot: a metric in an unknown family or time semantics, without a
/// limitation, declaring association without comparing anything, reading private text, or carrying a forbidden
/// name; and a person as a grouping dimension. Empty when the registry is sound.
pub fn registry_problems(registry: List(Metric)) -> List(String) {
  let private_fields = [
    "note", "notes", "comment", "body", "text", "byName", "byId", "scoutName",
    "ownerUserId",
  ]
  let per_metric =
    list.flat_map(registry, fn(m) {
      let reads_private =
        list.filter(m.reads, fn(f) {
          let leaf = string.split(f, ".") |> list.last |> result.unwrap(f)
          list.contains(private_fields, leaf)
        })
      let hay = string.lowercase(m.id <> " " <> m.name)
      let forbidden =
        list.filter(forbidden_metric_names, fn(bad) {
          string.contains(hay, bad)
        })
      list.flatten([
        case list.contains(family_ids(), m.family) {
          True -> []
          False -> [m.id <> " is in unknown family " <> m.family]
        },
        case list.key_find(time_semantics, m.semantics) {
          Ok(_) -> []
          Error(Nil) -> [
            m.id <> " declares unknown time semantics " <> m.semantics,
          ]
        },
        case string.length(m.limitation) < 40 {
          True -> [m.id <> " has no stated limitation"]
          False -> []
        },
        case m.association, m.measure {
          True, IsRatio(True) | False, _ -> []
          True, _ -> [m.id <> " declares association but compares nothing"]
        },
        list.map(reads_private, fn(f) { m.id <> " declares it reads " <> f }),
        list.map(forbidden, fn(bad) {
          m.id <> " carries the forbidden name " <> bad
        }),
      ])
    })
  let person_groupings =
    list.filter(group_dimensions, list.contains(person_dimensions, _))
    |> list.map(fn(d) { d <> " is a person and cannot be a grouping dimension" })
  list.append(per_metric, person_groupings)
}

// -------------------------------------------------------------- statistics

/// Keeps three outcomes apart: nothing happened (`empty`), it happened and none met (`value: 0`), and too few
/// to be a rate (`suppressed`). "No rooms ended" and "0% had a decision" must not both render as 0%.
pub type Ratio {
  Ratio(
    n: Int,
    numerator: Int,
    value: Option(Float),
    empty: Bool,
    suppressed: Bool,
  )
}

pub fn ratio(numerator: Int, denominator: Int) -> Ratio {
  case denominator {
    0 -> Ratio(n: 0, numerator: 0, value: None, empty: True, suppressed: False)
    n if n < small_n_min ->
      Ratio(n:, numerator:, value: None, empty: False, suppressed: True)
    n ->
      Ratio(
        n:,
        numerator:,
        value: Some(int.to_float(numerator) /. int.to_float(n)),
        empty: False,
        suppressed: False,
      )
  }
}

pub fn ratio_fields(r: Ratio) -> List(#(String, Json)) {
  list.flatten([
    [
      #("n", json.int(r.n)),
      #("numerator", json.int(r.numerator)),
      #("value", json.nullable(r.value, json_text.number)),
      #("empty", json.bool(r.empty)),
      #("suppressed", json.bool(r.suppressed)),
    ],
    case r.suppressed {
      True -> [#("minimum", json.int(small_n_min))]
      False -> []
    },
  ])
}

pub fn ratio_json(r: Ratio) -> Json {
  json.object(ratio_fields(r))
}

/// Median and interquartile range, never a mean: one eighteen-month room would move a mean. `excluded` counts
/// unfinished records and travels with the figure so the exclusion cannot hide.
pub type Distribution {
  Distribution(
    n: Int,
    median: Option(Float),
    p25: Option(Float),
    p75: Option(Float),
    min: Option(Float),
    max: Option(Float),
    empty: Bool,
    suppressed: Bool,
    excluded: Int,
  )
}

pub fn distribution(values: List(Float), excluded: Int) -> Distribution {
  let sorted = list.sort(values, float.compare)
  let n = list.length(sorted)
  let none =
    Distribution(
      n:,
      median: None,
      p25: None,
      p75: None,
      min: None,
      max: None,
      empty: n == 0,
      suppressed: n > 0,
      excluded:,
    )
  case n {
    0 -> none
    n if n < small_n_min -> none
    _ ->
      Distribution(
        n:,
        median: quantile(sorted, 0.5),
        p25: quantile(sorted, 0.25),
        p75: quantile(sorted, 0.75),
        min: list.first(sorted) |> option.from_result,
        max: list.last(sorted) |> option.from_result,
        empty: False,
        suppressed: False,
        excluded:,
      )
  }
}

fn quantile(sorted: List(Float), q: Float) -> Option(Float) {
  let pos = int.to_float(list.length(sorted) - 1) *. q
  let lo = float.truncate(float.floor(pos))
  let hi = float.truncate(float.ceiling(pos))
  case at(sorted, lo), at(sorted, hi) {
    Ok(a), Ok(_) if lo == hi -> Some(a)
    Ok(a), Ok(b) -> Some(a +. { b -. a } *. { pos -. int.to_float(lo) })
    _, _ -> None
  }
}

fn at(xs: List(a), i: Int) -> Result(a, Nil) {
  list.drop(xs, i) |> list.first
}

pub fn distribution_fields(d: Distribution) -> List(#(String, Json)) {
  let num = fn(v) { json.nullable(v, json_text.number) }
  list.flatten([
    [
      #("n", json.int(d.n)),
      #("median", num(d.median)),
      #("p25", num(d.p25)),
      #("p75", num(d.p75)),
    ],
    case d.empty || d.suppressed {
      True -> []
      False -> [#("min", num(d.min)), #("max", num(d.max))]
    },
    [#("empty", json.bool(d.empty)), #("suppressed", json.bool(d.suppressed))],
    case d.suppressed {
      True -> [#("minimum", json.int(small_n_min))]
      False -> []
    },
    [#("excluded", json.int(d.excluded))],
  ])
}

pub fn distribution_json(d: Distribution) -> Json {
  json.object(distribution_fields(d))
}

/// Never suppressed: a director may always see their own work.
pub fn count(n: Int) -> List(#(String, Json)) {
  [
    #("n", json.int(n)),
    #("value", json.int(n)),
    #("empty", json.bool(False)),
    #("suppressed", json.bool(False)),
  ]
}

pub fn count_json(n: Int) -> Json {
  json.object(count(n))
}

pub const day_ms = 86_400_000

/// As a float: durations are never rounded to zero.
pub fn days(from: Int, to: Int) -> Float {
  int.to_float(to - from) /. int.to_float(day_ms)
}

// ------------------------------------------------------------------ window

/// Windows are inclusive UTC calendar days; there is no local time.
pub fn utc_day(ms: Int) -> String {
  clock.iso_day(ms)
}

pub const window_presets = [
  #("last_7_days", 7),
  #("last_30_days", 30),
  #("last_90_days", 90),
  #("last_180_days", 180),
  #("last_365_days", 365),
]

pub const default_window = "last_90_days"

pub type Window {
  Window(preset: String, from: Day, to: Day, days: Int)
}

pub fn window_json(w: Window) -> Json {
  json.object([
    #("preset", json.string(w.preset)),
    #("from", temporal.day_json(w.from)),
    #("to", temporal.day_json(w.to)),
    #("days", json.int(w.days)),
  ])
}

/// A window refused: `WINDOW_INVALID` or `WINDOW_UNKNOWN`, with the presets when the preset was unknown.
pub type WindowRefusal {
  WindowRefusal(error: String, detail: String, allowed: Option(List(String)))
}

/// A custom range must be two real days in order; anything else is refused, because a quietly widened window
/// changes every number on the page. Blank bounds are no bounds, as JavaScript reads `from || to`.
pub fn resolve_window(
  preset: Option(String),
  from: Option(String),
  to: Option(String),
  now: Int,
) -> Result(Window, WindowRefusal) {
  let today = temporal.day_of(now)
  let given = fn(v) { v != None && v != Some("") }
  case given(from) || given(to) {
    True -> {
      let invalid = fn(detail) {
        Error(WindowRefusal(error: "WINDOW_INVALID", detail:, allowed: None))
      }
      let day = fn(v) {
        case v {
          Some(d) -> temporal.parse_day(d) |> result.replace_error(Nil)
          None -> Error(Nil)
        }
      }
      case day(from), day(to) {
        Ok(f), Ok(t) ->
          case temporal.compare_days(f, t), temporal.compare_days(f, today) {
            order.Gt, _ -> invalid("from must not be after to.")
            _, order.Gt -> invalid("from must not be in the future.")
            _, _ ->
              Ok(Window(
                preset: "custom",
                from: f,
                to: t,
                days: { temporal.day_start(t) - temporal.day_start(f) }
                  / day_ms
                  + 1,
              ))
          }
        _, _ -> invalid("from and to must both be calendar days as YYYY-MM-DD.")
      }
    }
    False -> {
      let key = option.unwrap(preset, default_window)
      case list.key_find(window_presets, key) {
        Ok(span) ->
          Ok(Window(
            preset: key,
            from: temporal.add_days(today, 1 - span),
            to: today,
            days: span,
          ))
        Error(Nil) ->
          Error(WindowRefusal(
            error: "WINDOW_UNKNOWN",
            detail: "Unknown window \"" <> key <> "\".",
            allowed: Some(list.map(window_presets, fn(p) { p.0 })),
          ))
      }
    }
  }
}

/// A resolved window, or its refusal, as `resolveWindow` returns either.
pub fn resolution_json(r: Result(Window, WindowRefusal)) -> Json {
  case r {
    Ok(w) -> window_json(w)
    Error(e) ->
      json.object(
        list.append(
          [#("error", json.string(e.error)), #("detail", json.string(e.detail))],
          case e.allowed {
            Some(a) -> [#("allowed", json.array(a, json.string))]
            None -> []
          },
        ),
      )
  }
}

pub fn in_window(ms: Int, w: Window) -> Bool {
  let d = temporal.day_of(ms)
  temporal.compare_days(d, w.from) != order.Lt
  && temporal.compare_days(d, w.to) != order.Gt
}

/// An absent instant is in no window. (JavaScript's `inWindow(null)` reads it as 1970-01-01, which no window a
/// lead can ask for reaches.)
pub fn in_window_at(ms: Option(Int), w: Window) -> Bool {
  case ms {
    Some(ms) -> in_window(ms, w)
    None -> False
  }
}

/// Equal length matters: a 7-day window against a 30-day one would make every figure look like a collapse.
pub fn previous_window(w: Window) -> Window {
  let span =
    { temporal.day_start(w.to) - temporal.day_start(w.from) } / day_ms + 1
  Window(
    preset: "previous",
    from: temporal.add_days(w.from, 0 - span),
    to: temporal.add_days(w.from, -1),
    days: span,
  )
}

/// A rise from zero has no percentage, so `percentChange` is null and `upFromZero` says what happened.
pub type Comparison {
  Comparison(
    current: Int,
    previous: Int,
    change: Int,
    percent_change: Option(Float),
    up_from_zero: Bool,
    unchanged_at_zero: Bool,
  )
}

pub fn compare(current: Int, previous: Int) -> Comparison {
  Comparison(
    current:,
    previous:,
    change: current - previous,
    percent_change: case previous {
      0 -> None
      p -> Some(int.to_float(current - p) /. int.to_float(p))
    },
    up_from_zero: previous == 0 && current > 0,
    unchanged_at_zero: previous == 0 && current == 0,
  )
}

pub fn comparison_json(c: Comparison) -> Json {
  json.object([
    #("current", json.int(c.current)),
    #("previous", json.int(c.previous)),
    #("change", json.int(c.change)),
    #("percentChange", json.nullable(c.percent_change, json_text.number)),
    #("upFromZero", json.bool(c.up_from_zero)),
    #("unchangedAtZero", json.bool(c.unchanged_at_zero)),
  ])
}

/// A caution, not a correction: true when the window is too young for journeys opened in it to have finished,
/// so a conversion-shaped figure over it reads low. Nothing is adjusted.
pub fn cohort_incomplete(
  w: Window,
  typical_days: Option(Float),
  now: Int,
) -> Bool {
  case typical_days {
    Some(t) if t >. 0.0 -> {
      let from = temporal.day_start(w.from)
      let to = temporal.day_start(w.to)
      let end = to + day_ms - 1000
      int.to_float(int.min(now, end) - from) <. t *. int.to_float(day_ms)
    }
    _ -> False
  }
}
