//// Recruitment analytics: how long the process takes, and what has stopped moving
//// (domains/recruitment/analytics/timeSeries.mjs). Medians, never means. Durations cover only finished records,
//// which flatters a club whose work is stuck, so each one ships with the count it excluded and the aging family
//// covers what durations cannot see.

import gleam/dict
import gleam/float
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{None, Some}
import gleam/order
import gleam/string
import scoutbox/recruitment/analytics/context.{type Context, type Room}
import scoutbox/recruitment/analytics/funnels
import scoutbox/recruitment/analytics/metrics.{count, count_json, wire}
import scoutbox/rows/id

pub fn last_activity_at(room: Room) -> Int {
  list.fold(room.history, room.created_at, fn(m, h) { int.max(m, h.at) })
}

pub type Visit {
  Visit(status: String, from: Int, to: Int, ms: Int)
}

/// Completed visits only: the current visit has not finished, and guessing its length would invent a timestamp.
pub fn stage_visits(room: Room) -> List(Visit) {
  let #(visits, _, _) =
    list.fold(
      room.transitions,
      #([], context.opened_status(room), room.created_at),
      fn(acc, t) {
        let #(out, status, since) = acc
        let out = case status {
          Some(s) -> [
            Visit(status: s, from: since, to: t.at, ms: t.at - since),
            ..out
          ]
          None -> out
        }
        #(out, Some(t.to), t.at)
      },
    )
  list.reverse(visits) |> list.filter(fn(v) { v.ms >= 0 })
}

fn decisions_of(ctx: Context, room: Room) -> List(context.Decision) {
  case dict.get(ctx.decisions_by_room, room.id) {
    Ok(ds) -> ds
    Error(Nil) -> []
  }
}

fn object(parts: List(List(#(String, Json)))) -> Json {
  json.object(list.flatten(parts))
}

fn open_statuses() -> List(String) {
  list.filter(funnels.room_statuses(), fn(s) { !context.is_terminal(s) })
}

fn is_open(room: Room) -> Bool {
  list.contains(open_statuses(), room.status)
}

// -------------------------------------------------- T1 · time to a decision

pub fn time_to_first_decision(ctx: Context) -> Json {
  let values =
    list.filter_map(ctx.rooms, fn(r) {
      // decisions_by_room is sorted by creation
      case decisions_of(ctx, r) {
        [first, ..] ->
          case metrics.in_window(first.created_at, ctx.window) {
            True -> Ok(metrics.days(r.created_at, first.created_at))
            False -> Error(Nil)
          }
        [] -> Error(Nil)
      }
    })
  let excluded = list.count(ctx.rooms, fn(r) { decisions_of(ctx, r) == [] })
  object([
    wire("time_to_first_decision"),
    metrics.distribution_fields(metrics.distribution(values, excluded)),
    [
      #(
        "excludedMeans",
        json.string(
          "Rooms with no recorded decision at all. They cannot contribute a duration, so this figure describes the rooms that reached a decision — not all of your rooms.",
        ),
      ),
    ],
  ])
}

// ----------------------------------------------------- T2 · time in a stage

pub fn time_in_stage(ctx: Context) -> Json {
  let visits =
    list.flat_map(ctx.rooms, stage_visits)
    // the exit falls in the window
    |> list.filter(fn(v) { metrics.in_window(v.to, ctx.window) })
  let still_in = list.count(ctx.rooms, is_open)
  object([
    wire("time_in_stage"),
    [
      // Vocabulary order: sorting by duration would give a "slowest stage" ranking the exclusion makes untrue.
      #(
        "rows",
        json.preprocessed_array(
          list.filter_map(funnels.room_statuses(), fn(status) {
            let values =
              list.filter_map(visits, fn(v) {
                case v.status == status {
                  True -> Ok(int.to_float(v.ms) /. int.to_float(metrics.day_ms))
                  False -> Error(Nil)
                }
              })
            case values {
              [] -> Error(Nil)
              _ ->
                Ok(
                  object([
                    [#("status", json.string(status))],
                    metrics.distribution_fields(metrics.distribution(values, 0)),
                  ]),
                )
            }
          }),
        ),
      ),
      #("stillInAStage", count_json(still_in)),
      #(
        "excludedMeans",
        json.string(
          "Only visits that ENDED are measured. A stage where everything is stuck looks fast here, because the rooms still sitting in it are not counted. Read this next to Rooms with no recent activity.",
        ),
      ),
    ],
  ])
}

// ------------------------------------------------------ T3/T4 · trial timing

pub fn time_to_trial_requested(ctx: Context) -> Json {
  let values =
    list.filter_map(ctx.rooms, fn(r) {
      case context.first_reached_at(r, "trial_requested") {
        Some(at) ->
          case metrics.in_window(at, ctx.window) {
            True -> Ok(metrics.days(r.created_at, at))
            False -> Error(Nil)
          }
        None -> Error(Nil)
      }
    })
  let excluded =
    list.count(ctx.rooms, fn(r) {
      context.first_reached_at(r, "trial_requested") == None
    })
  object([
    wire("time_to_trial_requested"),
    metrics.distribution_fields(metrics.distribution(values, excluded)),
    [
      #(
        "excludedMeans",
        json.string(
          "Rooms that never reached a trial request. Most rooms never will, and that is not a fault in the club or in any player.",
        ),
      ),
    ],
  ])
}

pub fn time_trial_requested_to_completed(ctx: Context) -> Json {
  let #(values, unfinished) =
    list.fold(ctx.rooms, #([], 0), fn(acc, r) {
      let #(values, unfinished) = acc
      case
        context.first_reached_at(r, "trial_requested"),
        context.first_reached_at(r, "trial_completed")
      {
        None, _ -> acc
        Some(_), None -> #(values, unfinished + 1)
        Some(req), Some(done) ->
          // a reopened room can reach these out of order
          case metrics.in_window(done, ctx.window) && done >= req {
            True -> #([metrics.days(req, done), ..values], unfinished)
            False -> acc
          }
      }
    })
  object([
    wire("time_trial_requested_to_completed"),
    metrics.distribution_fields(metrics.distribution(values, unfinished)),
    [
      #(
        "excludedMeans",
        json.string("Trials requested but not yet recorded as completed."),
      ),
    ],
  ])
}

// ------------------------------------------------------- T5 · age of the open

/// Buckets show where work piles up, which a median hides: a median of 20 days hides four rooms at 200.
/// The last has no upper bound.
pub const age_buckets = [
  #("0_7", "0–7 days", 0, Some(7)),
  #("8_14", "8–14 days", 8, Some(14)),
  #("15_30", "15–30 days", 15, Some(30)),
  #("31_60", "31–60 days", 31, Some(60)),
  #("60_plus", "Over 60 days", 61, None),
]

pub fn open_room_age(ctx: Context) -> Json {
  let open = list.filter(ctx.rooms, is_open)
  let ages = list.map(open, fn(r) { metrics.days(r.created_at, ctx.now) })
  object([
    wire("open_room_age"),
    metrics.distribution_fields(metrics.distribution(ages, 0)),
    [
      #("openRooms", count_json(list.length(open))),
      // Counts, so never suppressed.
      #(
        "buckets",
        json.array(age_buckets, fn(b) {
          let #(bucket, label, min, max) = b
          let n =
            list.count(ages, fn(a) {
              let d = float.floor(a)
              d >=. int.to_float(min)
              && case max {
                Some(m) -> d <=. int.to_float(m)
                None -> True
              }
            })
          object([
            [#("id", json.string(bucket)), #("label", json.string(label))],
            count(n),
          ])
        }),
      ),
    ],
  ])
}

// -------------------------------------------------------- A1 · stalled work

pub const stall_thresholds = [14, 30, 90]

pub const default_stall_days = 30

fn threshold(threshold_days: Int) -> Int {
  case list.contains(stall_thresholds, threshold_days) {
    True -> threshold_days
    False -> default_stall_days
  }
}

/// Each open room with the days since its last activity.
fn idle(ctx: Context) -> List(#(Room, Float)) {
  list.filter(ctx.rooms, is_open)
  |> list.map(fn(r) { #(r, metrics.days(last_activity_at(r), ctx.now)) })
}

/// The stalled rooms, most idle first, then id: stable across reads.
pub fn stalled_rows(ctx: Context, threshold_days: Int) -> List(Json) {
  let threshold = threshold(threshold_days)
  idle(ctx)
  |> list.filter(fn(a) { a.1 >=. int.to_float(threshold) })
  |> list.sort(fn(a, b) {
    case float.compare(b.1, a.1) {
      order.Eq ->
        string.compare(
          id.recruitment_case_to_string({ a.0 }.id),
          id.recruitment_case_to_string({ b.0 }.id),
        )
      o -> o
    }
  })
  |> list.map(fn(a) {
    let #(room, idle) = a
    object([
      [
        #("roomId", id.recruitment_case_json(room.id)),
        #("status", json.string(room.status)),
        #("idleDays", json.int(float.truncate(float.floor(idle)))),
      ],
      context.subject_of(ctx, room),
    ])
  })
}

pub fn stalled_rooms(ctx: Context, threshold_days: Int) -> Json {
  let aged = idle(ctx)
  let rows = stalled_rows(ctx, threshold_days)
  object([
    wire("stalled_rooms"),
    [
      #("thresholdDays", json.int(threshold(threshold_days))),
      #(
        "thresholds",
        json.array(stall_thresholds, fn(d) {
          object([
            [#("days", json.int(d))],
            count(list.count(aged, fn(a) { a.1 >=. int.to_float(d) })),
          ])
        }),
      ),
      #("openRooms", count_json(list.length(aged))),
    ],
    count(list.length(rows)),
    [#("rows", json.preprocessed_array(rows))],
  ])
}

// --------------------------------------------------- A2 · overdue obligations

fn awaiting_report(ctx: Context) -> List(context.Trial) {
  // A missing deadline is unknown, not overdue, and a subject who removed their account leaves no obligation
  // anyone can meet.
  list.filter(ctx.trials, fn(t) {
    t.status == "awaiting_report" && t.subject_removed_at == None
  })
}

/// The overdue reports, the longest overdue first, then id.
pub fn overdue_rows(ctx: Context) -> List(Json) {
  awaiting_report(ctx)
  |> list.filter_map(fn(t) {
    case t.report_due_at {
      Some(due) if due < ctx.now -> Ok(#(t, due))
      _ -> Error(Nil)
    }
  })
  |> list.sort(fn(a, b) {
    case int.compare(a.1, b.1) {
      order.Eq ->
        string.compare(
          id.trial_to_string({ a.0 }.id),
          id.trial_to_string({ b.0 }.id),
        )
      o -> o
    }
  })
  |> list.map(fn(x) {
    json.object([
      #("trialId", id.trial_json({ x.0 }.id)),
      #(
        "overdueDays",
        json.int(float.truncate(float.floor(metrics.days(x.1, ctx.now)))),
      ),
    ])
  })
}

pub fn overdue_trial_reports(ctx: Context) -> Json {
  let rows = overdue_rows(ctx)
  object([
    wire("overdue_trial_reports"),
    count(list.length(rows)),
    [
      #("awaitingReport", count_json(list.length(awaiting_report(ctx)))),
      #("rows", json.preprocessed_array(rows)),
      #(
        "note",
        json.string(
          "Unfiled trial reports already block new trial requests. This is the same rule, seen from the top.",
        ),
      ),
    ],
  ])
}

// ----------------------------------------------------- A3 · decision missing

/// The statuses the Room lifecycle treats as owing a decision.
pub const decision_owed_statuses = ["offer_consideration", "offer_made"]

fn owed(ctx: Context) -> List(Room) {
  list.filter(ctx.rooms, fn(r) {
    list.contains(decision_owed_statuses, r.status)
  })
}

/// The rooms at an offer stage with no decision, oldest first, then id.
pub fn outstanding_rows(ctx: Context) -> List(Json) {
  owed(ctx)
  |> list.filter(fn(r) { decisions_of(ctx, r) == [] })
  |> list.sort(fn(a, b) {
    case int.compare(a.created_at, b.created_at) {
      order.Eq ->
        string.compare(
          id.recruitment_case_to_string(a.id),
          id.recruitment_case_to_string(b.id),
        )
      o -> o
    }
  })
  |> list.map(fn(r) {
    object([
      [
        #("roomId", id.recruitment_case_json(r.id)),
        #("status", json.string(r.status)),
      ],
      context.subject_of(ctx, r),
    ])
  })
}

pub fn decision_outstanding(ctx: Context) -> Json {
  let rows = outstanding_rows(ctx)
  object([
    wire("decision_outstanding"),
    count(list.length(rows)),
    [
      #("atOfferStage", count_json(list.length(owed(ctx)))),
      #("rows", json.preprocessed_array(rows)),
    ],
  ])
}
