//// The recruitment analytics checks the recorder can't turn into generated cases, ported by hand from the
//// TypeScript rules suite of recruitment/analytics (scripts/rules/):
////
//// - `assertMetricRegistry` throwing: here the registry is a constant, so its problems are a value
////   (`registry_problems`), checked on a registry changed the way the suite changes it.
//// - `stagesReached` returns a Set: here a list without repeats.
//// - `buildReportingContext` and `buildDashboard` take closures (`findPlayer`, `orgCanSee`) and a database of
////   plain arrays. Here the context is built from `Sources`, whose `visible` map is what the closures answered;
////   the organisation scope is the SQL read's (`context.read`), which the battery checks over HTTP (N34, N35).
////   A note, a rationale or an actor's name has no field in any source record, so it can't reach a payload.

import gleam/dict
import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleam/string
import scoutbox/recruitment/analytics/context.{Decision, Entry, Filters, Sources}
import scoutbox/recruitment/analytics/dashboard
import scoutbox/recruitment/analytics/metrics
import scoutbox/rows/id

const day = 86_400_000

/// 15 June 2026, 12:00 UTC, as the suite's NOW.
const now = 1_781_524_800_000

fn entry(at: Int, action: String, from: String, to: String) -> context.Entry {
  Entry(at:, action:, from: Some(from), to: Some(to), status: None)
}

fn created(at: Int) -> context.Entry {
  Entry(
    at:,
    action: "room_created",
    from: None,
    to: None,
    status: Some("watching"),
  )
}

fn room(
  case_id: String,
  created_at: Int,
  status: String,
  source: String,
  history: List(context.Entry),
) -> context.Room {
  context.room(
    id: id.recruitment_case(case_id),
    player_id: id.player("pl-" <> case_id),
    created_at:,
    status:,
    priority: "normal",
    source_context: source,
    history: [created(created_at), ..history],
  )
}

// ------------------------------------------------------------------ the registry

pub fn the_registry_is_sound_test() {
  assert metrics.registry_problems(metrics.metrics) == []
  assert list.length(metrics.metrics) == 27
}

/// N8: a forbidden name is refused rather than served.
pub fn a_forbidden_name_is_a_registry_problem_test() {
  let renamed =
    list.map(metrics.metrics, fn(m) {
      case m.id {
        "pipeline_stage_counts" ->
          metrics.Metric(..m, name: "Club Intelligence Score")
        _ -> m
      }
    })
  assert metrics.registry_problems(renamed)
    == [
      "pipeline_stage_counts carries the forbidden name club intelligence score",
    ]
}

/// N23: a metric declaring it reads a note is refused.
pub fn a_metric_reading_a_note_is_a_registry_problem_test() {
  let reading =
    list.map(metrics.metrics, fn(m) {
      case m.id {
        "exit_reason_mix" -> metrics.Metric(..m, reads: ["reasonCodes", "note"])
        _ -> m
      }
    })
  assert metrics.registry_problems(reading)
    == ["exit_reason_mix declares it reads note"]
}

// ------------------------------------------------------------------ stages reached

pub fn every_stage_the_room_reached_is_counted_test() {
  let r =
    room("r1", now - 60 * day, "shortlisted", "search", [
      entry(now - 50 * day, "room_status_changed", "watching", "under_review"),
      entry(
        now - 40 * day,
        "room_status_changed",
        "under_review",
        "shortlisted",
      ),
    ])
  assert list.sort(context.stages_reached(r), string.compare)
    == ["shortlisted", "under_review", "watching"]
}

/// P3: a stage reached twice (archived, then reopened to it) is counted once.
pub fn a_stage_reached_twice_is_counted_once_test() {
  let r =
    room("r2", now - 90 * day, "shortlisted", "search", [
      entry(now - 80 * day, "room_status_changed", "watching", "under_review"),
      entry(now - 70 * day, "room_status_changed", "under_review", "archived"),
      entry(now - 60 * day, "room_reopened", "archived", "under_review"),
      entry(
        now - 50 * day,
        "room_status_changed",
        "under_review",
        "shortlisted",
      ),
    ])
  assert list.count(context.stages_reached(r), fn(s) { s == "under_review" })
    == 1
}

// ------------------------------------------------------------------ the dashboard

fn sources(visible: List(#(id.PlayerId, String))) -> context.Sources {
  let c1 =
    room("c1", now - 60 * day, "shortlisted", "search", [
      entry(now - 30 * day, "room_status_changed", "watching", "shortlisted"),
    ])
  Sources(
    rooms: [c1],
    decisions: [
      Decision(
        id: id.room_decision("d1"),
        room_id: id.recruitment_case("c1"),
        created_at: now - 25 * day,
        reason_codes: ["technical_fit"],
        superseded_by_id: None,
        formal: False,
        draft: False,
        outcome: None,
      ),
    ],
    invitations: [],
    trials: [],
    contacts: [],
    assessments: [],
    offers: [],
    packages: [],
    signings: [],
    briefs: [],
    reviews: [],
    second_look: [],
    watchlist_statuses: [],
    membership_events: [],
    visible: dict.from_list(visible),
  )
}

fn window() -> metrics.Window {
  let assert Ok(w) =
    metrics.resolve_window(Some("last_90_days"), None, None, now)
  w
}

fn no_filters() -> context.Filters {
  Filters(source_context: None, priority: None, brief_id: None)
}

fn build(
  s: context.Sources,
  filters: context.Filters,
  fault: option.Option(String),
) -> String {
  let ctx = context.build(s, window(), now, filters)
  dashboard.build(ctx, metrics.family_ids(), 30, fault) |> json.to_string
}

fn has(text: String, part: String) -> Bool {
  string.contains(text, part)
}

/// P1, P2: the payload declares its policy version and every family, and the stage counts match the rooms.
pub fn a_clean_dashboard_declares_itself_and_counts_the_rooms_test() {
  let out = build(sources([]), no_filters(), None)
  assert has(out, "\"policyVersion\":1,")
  assert has(
    out,
    "\"families\":[\"pipeline\",\"duration\",\"aging\",\"decision_record\",\"coverage\",\"source\",\"watchlist\"]",
  )
  assert has(out, "\"partial\":false,\"unavailable\":[]")
  assert has(
    out,
    "{\"status\":\"shortlisted\",\"terminal\":false,\"n\":1,\"value\":1,",
  )
  assert has(out, "do not measure any player")
  assert has(out, "\"smallNMinimum\":5")
}

/// N60, N57: one family failing names itself, carries a reason and no stack, and leaves every other panel.
pub fn a_failing_family_names_itself_and_leaves_the_others_test() {
  let out = build(sources([]), no_filters(), Some("duration"))
  assert has(out, "\"partial\":true,\"unavailable\":[\"duration\"]")
  assert has(
    out,
    "\"duration\":{\"family\":\"duration\",\"label\":\"How long the process takes\",\"error\":\"FAMILY_UNAVAILABLE\",\"detail\":\"injected fault in family \\\"duration\\\"\"}",
  )
  assert !has(out, "at Object")
  assert list.all(
    ["pipeline", "aging", "decision_record", "coverage", "source", "watchlist"],
    fn(f) { has(out, "\"" <> f <> "\":{\"family\":\"" <> f <> "\",\"label\"") },
  )
}

/// N58, P10: a filter a family can't honour is declared, and the source mix marks its residual bucket.
pub fn a_filter_a_family_cannot_honour_is_declared_test() {
  let out =
    build(
      sources([]),
      Filters(source_context: Some("search"), priority: None, brief_id: None),
      None,
    )
  assert has(
    out,
    "\"coverage\":{\"family\":\"coverage\",\"label\":\"Coverage of your stated demand\",\"filtersHonoured\":[\"briefId\"],\"filtersNotApplicable\":[\"sourceContext\"]",
  )
  assert has(out, "{\"source\":\"search\",\"residual\":false,")
}

/// N27: a player the organisation may not see is never named, even in a drill-down row, and is still counted.
pub fn a_hidden_player_is_counted_but_never_named_test() {
  let stalled = fn(visible) {
    context.build(sources(visible), window(), now, no_filters())
  }
  let hidden = stalled([])
  let seen = stalled([#(id.player("pl-c1"), "Seen Player")])
  let rows = fn(ctx) {
    dashboard.family_metrics(ctx, "aging", 14) |> json.to_string
  }
  assert has(rows(hidden), "\"playerId\":null,\"playerName\":null")
  assert has(
    rows(seen),
    "\"playerId\":\"pl-c1\",\"playerName\":\"Seen Player\"",
  )
  assert has(
    build(sources([]), no_filters(), None),
    "\"pipeline_stage_counts\":{\"id\":\"pipeline_stage_counts\"",
  )
  assert has(
    build(sources([]), no_filters(), None),
    "\"total\":{\"n\":1,\"value\":1,\"empty\":false,\"suppressed\":false}",
  )
}
