//// Recruitment analytics: decision record hygiene, coverage of the club's own stated demand, and dynamic
//// watchlists (domains/recruitment/analytics/cohorts.mjs). Hygiene is about whether the club wrote down what it
//// did, never whether a decision was right.

import gleam/dict
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order.{type Order}
import gleam/result
import gleam/set
import gleam/string
import scoutbox/platform/temporal.{type Day}
import scoutbox/recruitment/analytics/context.{type Context, type Room}
import scoutbox/recruitment/analytics/metrics.{count, count_json, wire}
import scoutbox/recruitment/room_rules
import scoutbox/rows/id

pub fn evidence_reason_codes() -> List(String) {
  list.key_find(room_rules.reason_codes, "evidence") |> result.unwrap([])
}

fn object(parts: List(List(#(String, Json)))) -> Json {
  json.object(list.flatten(parts))
}

fn ended_in_window(ctx: Context, r: Room) -> Option(Int) {
  case context.first_terminal_at(r) {
    Some(at) ->
      case metrics.in_window(at, ctx.window) {
        True -> Some(at)
        False -> None
      }
    None -> None
  }
}

fn decisions_of(ctx: Context, r: Room) -> List(context.Decision) {
  dict.get(ctx.decisions_by_room, r.id) |> result.unwrap([])
}

// -------------------------------------------- D1 · did the ending get written

/// The rooms that ended in the window with no recorded decision, by room id.
pub fn terminal_missing_rows(ctx: Context) -> List(Json) {
  ctx.rooms
  |> list.filter(fn(r) {
    ended_in_window(ctx, r) != None && decisions_of(ctx, r) == []
  })
  |> list.sort(fn(a, b) {
    string.compare(
      id.recruitment_case_to_string(a.id),
      id.recruitment_case_to_string(b.id),
    )
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

pub fn terminal_with_recorded_decision(ctx: Context) -> Json {
  let ended = list.filter(ctx.rooms, fn(r) { ended_in_window(ctx, r) != None })
  let recorded = list.count(ended, fn(r) { decisions_of(ctx, r) != [] })
  object([
    wire("terminal_with_recorded_decision"),
    metrics.ratio_fields(metrics.ratio(recorded, list.length(ended))),
    [
      #("ended", count_json(list.length(ended))),
      #("rows", json.preprocessed_array(terminal_missing_rows(ctx))),
    ],
  ])
}

// ------------------------------------------------------ D2 · revised endings

pub fn superseded_decision_rate(ctx: Context) -> Json {
  let in_window =
    list.filter(ctx.decisions, fn(d) {
      metrics.in_window(d.created_at, ctx.window)
    })
  let superseded = list.count(in_window, fn(d) { d.superseded_by_id != None })
  object([
    wire("superseded_decision_rate"),
    metrics.ratio_fields(metrics.ratio(superseded, list.length(in_window))),
    // No good/bad colour: changing your mind on new information is what Second Look is for.
    [#("neutral", json.bool(True))],
  ])
}

// ------------------------------------------- D3 · endings limited by evidence

/// Points at the club's evidence pipeline rather than its judgement, so acting on it changes a process.
pub fn evidence_limited_exits(ctx: Context) -> Json {
  let codes_of_ended =
    list.filter_map(ctx.rooms, fn(r) {
      case ended_in_window(ctx, r), decisions_of(ctx, r) {
        Some(_), [_, ..] as ds ->
          Ok(set.from_list(list.flat_map(ds, fn(d) { d.reason_codes })))
        _, _ -> Error(Nil)
      }
    })
  let evidence = evidence_reason_codes()
  let limited =
    list.count(codes_of_ended, fn(codes) {
      list.any(evidence, set.contains(codes, _))
    })
  object([
    wire("evidence_limited_exits"),
    metrics.ratio_fields(metrics.ratio(limited, list.length(codes_of_ended))),
    [
      #("ended", count_json(list.length(codes_of_ended))),
      #(
        "rows",
        json.array(evidence, fn(code) {
          object([
            [#("code", json.string(code))],
            count(list.count(codes_of_ended, set.contains(_, code))),
          ])
        }),
      ),
    ],
  ])
}

// ---------------------------------------------------------- D4 · reopening

pub fn reopen_rate(ctx: Context) -> Json {
  let ended =
    list.filter_map(ctx.rooms, fn(r) {
      ended_in_window(ctx, r)
      |> option.map(fn(at) { #(r, at) })
      |> option.to_result(Nil)
    })
  // Any transition after the first ending is a reopening, by either reopen path.
  let reopened =
    list.count(ended, fn(e) {
      list.any({ e.0 }.transitions, fn(t) { t.at > e.1 })
    })
  object([
    wire("reopen_rate"),
    metrics.ratio_fields(metrics.ratio(reopened, list.length(ended))),
    [
      #("ended", count_json(list.length(ended))),
      #("neutral", json.bool(True)),
    ],
  ])
}

// ---------------------------------------------------------- C1 · live briefs

/// A brief is live on `today` when it is active and the day is within its bounds (briefIsLiveOn).
pub fn brief_is_live_on(b: context.Brief, today: Day) -> Bool {
  b.status == "active"
  && temporal.is_day_within(today, b.active_from, b.active_until)
}

/// Titles in the order JavaScript's `localeCompare` gives for the titles a club writes: letters before case,
/// then lower case first. (Accents and punctuation follow code points here, which the ICU order does not.)
fn title_order(a: String, b: String) -> Order {
  case string.compare(string.lowercase(a), string.lowercase(b)) {
    order.Eq -> string.compare(b, a)
    o -> o
  }
}

fn live_briefs(ctx: Context) -> List(context.Brief) {
  list.filter(ctx.briefs, brief_is_live_on(_, ctx.today))
}

pub fn briefs_live(ctx: Context) -> Json {
  // Point-in-time: liveness is asked of today, never of the window's end.
  let live = live_briefs(ctx)
  object([
    wire("briefs_live"),
    count(list.length(live)),
    [
      #("total", count_json(list.length(ctx.briefs))),
      #(
        "byStatus",
        json.array(
          ["draft", "active", "paused", "closed", "archived"],
          fn(status) {
            object([
              [#("status", json.string(status))],
              count(list.count(ctx.briefs, fn(b) { b.status == status })),
            ])
          },
        ),
      ),
      #(
        "rows",
        json.array(
          list.sort(live, fn(a, b) { title_order(a.title, b.title) }),
          fn(b) {
            json.object([
              #("briefId", id.brief_json(b.id)),
              #("title", json.string(b.title)),
              #("version", json.int(b.version)),
            ])
          },
        ),
      ),
    ],
  ])
}

// -------------------------------------------- C2/C3 · is the demand worked

/// Players eligible under the club's own live briefs who have not entered its workflow. Dismissing a candidate
/// counts as reviewing: the question is whether the club looked, not what it concluded.
pub fn nobody_missed_coverage(ctx: Context) -> #(Json, Json) {
  let live = live_briefs(ctx)
  let live_ids = set.from_list(list.map(live, fn(b) { b.id }))
  let rel =
    list.filter(ctx.reviews, fn(r) { set.contains(live_ids, r.brief_id) })
  let open = list.count(rel, fn(r) { r.state == "open" })
  let per_brief =
    list.map(live, fn(b) {
      let for_brief = list.filter(rel, fn(r) { r.brief_id == b.id })
      let open = list.count(for_brief, fn(r) { r.state == "open" })
      #(
        b.title,
        object([
          [#("briefId", id.brief_json(b.id)), #("title", json.string(b.title))],
          count(open),
          [
            #(
              "reviewed",
              metrics.ratio_json(metrics.ratio(
                list.length(for_brief) - open,
                list.length(for_brief),
              )),
            ),
          ],
        ]),
      )
    })
    |> list.sort(fn(a, b) { title_order(a.0, b.0) })
    |> list.map(fn(p) { p.1 })
  #(
    object([
      wire("nobody_missed_backlog"),
      count(open),
      [
        #("liveBriefs", count_json(set.size(live_ids))),
        #("rows", json.preprocessed_array(per_brief)),
      ],
    ]),
    object([
      wire("nobody_missed_review_rate"),
      metrics.ratio_fields(metrics.ratio(
        list.length(rel) - open,
        list.length(rel),
      )),
    ]),
  )
}

// ------------------------------------------------------------- C4/C5 · Second Look

pub fn second_look_coverage(ctx: Context) -> #(Json, Json) {
  let items = ctx.second_look
  let open = list.filter(items, fn(i) { i.status == "open" })
  let values =
    items
    |> list.filter(fn(i) {
      i.status != "open"
      && i.updated_at > i.created_at
      && metrics.in_window(i.updated_at, ctx.window)
    })
    |> list.map(fn(i) { metrics.days(i.created_at, i.updated_at) })
  #(
    object([
      wire("second_look_backlog"),
      count(list.length(open)),
      [
        // Expiry is a designed outcome, not neglect, so it is counted apart.
        #(
          "expired",
          count_json(list.count(items, fn(i) { i.status == "expired" })),
        ),
        #(
          "reopenedRoom",
          count_json(list.count(items, fn(i) { i.status == "reopened_room" })),
        ),
        #(
          "age",
          metrics.distribution_json(metrics.distribution(
            list.map(open, fn(i) { metrics.days(i.created_at, ctx.now) }),
            0,
          )),
        ),
      ],
    ]),
    object([
      wire("second_look_response_time"),
      metrics.distribution_fields(metrics.distribution(
        values,
        list.length(open),
      )),
      [
        #(
          "excludedMeans",
          json.string(
            "Second Look items nobody has touched yet. They have no response time to measure, which is exactly why the backlog is shown next to this.",
          ),
        ),
      ],
    ]),
  )
}

// ------------------------------------------------------------- W1/W2 · lists

pub fn watchlist_activity(ctx: Context) -> #(Json, Json) {
  let statuses = ctx.watchlist_statuses
  let events =
    list.filter(ctx.membership_events, fn(e) {
      metrics.in_window(e.at, ctx.window)
    })
  #(
    object([
      wire("active_watchlists"),
      count(list.count(statuses, fn(s) { s == "active" })),
      [
        #("total", count_json(list.length(statuses))),
        #(
          "byStatus",
          json.array(["active", "paused", "archived"], fn(status) {
            object([
              [#("status", json.string(status))],
              count(list.count(statuses, fn(s) { s == status })),
            ])
          }),
        ),
      ],
    ]),
    object([
      wire("watchlist_membership_churn"),
      count(list.length(events)),
      [
        #(
          "entered",
          count_json(list.count(events, fn(e) { e.transition == "entered" })),
        ),
        #(
          "left",
          count_json(list.count(events, fn(e) { e.transition == "left" })),
        ),
        // Watchlists have no scheduler: membership is recalculated when someone opens a list, so this counts
        // recalculations, not players whose situation changed.
        #("derivedOnRead", json.bool(True)),
        #(
          "refreshNote",
          json.string(
            "ScoutBox does not recompute watchlists in the background. These are the changes found when someone opened a list — a list nobody opened records nothing.",
          ),
        ),
      ],
    ]),
  )
}
