//// The dashboard (`buildDashboard`, domains/recruitment/analytics/dashboard.mjs): each family computed from the
//// one reporting context, a period-over-period trend, and the declarations a client needs to read the figures
//// honestly. A family that can't be computed shows a named failure in its slot instead of a shorter page.

import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, Some}
import scoutbox/recruitment/analytics/cohorts
import scoutbox/recruitment/analytics/context.{type Context}
import scoutbox/recruitment/analytics/funnels
import scoutbox/recruitment/analytics/metrics
import scoutbox/recruitment/analytics/time_series

/// Which filters each family can honour. One that cannot apply is reported as not applied, so a director who
/// filtered to one brief never sees a whole-club number under that label.
fn family_filters(family: String) -> List(String) {
  case family {
    "pipeline" | "duration" | "aging" | "decision_record" -> [
      "sourceContext", "priority",
    ]
    "coverage" -> ["briefId"]
    "source" -> ["priority"]
    _ -> []
  }
}

/// The metrics of one family, in the order the TypeScript server lists them.
pub fn family_metrics(ctx: Context, family: String, stall_days: Int) -> Json {
  json.object(case family {
    "pipeline" -> [
      #("pipeline_stage_counts", funnels.pipeline_stage_counts(ctx)),
      #("funnel_progression", funnels.funnel_progression(ctx)),
      #("exit_reason_mix", funnels.exit_reason_mix(ctx)),
      #("trial_process", funnels.trial_process(ctx)),
      #("decision_outcomes", funnels.decision_outcomes(ctx)),
      #("journey_evidence_funnel", funnels.journey_evidence_funnel(ctx)),
    ]
    "duration" -> [
      #("time_to_first_decision", time_series.time_to_first_decision(ctx)),
      #("time_in_stage", time_series.time_in_stage(ctx)),
      #("time_to_trial_requested", time_series.time_to_trial_requested(ctx)),
      #(
        "time_trial_requested_to_completed",
        time_series.time_trial_requested_to_completed(ctx),
      ),
      #("open_room_age", time_series.open_room_age(ctx)),
    ]
    "aging" -> [
      #("stalled_rooms", time_series.stalled_rooms(ctx, stall_days)),
      #("overdue_trial_reports", time_series.overdue_trial_reports(ctx)),
      #("decision_outstanding", time_series.decision_outstanding(ctx)),
    ]
    "decision_record" -> [
      #(
        "terminal_with_recorded_decision",
        cohorts.terminal_with_recorded_decision(ctx),
      ),
      #("superseded_decision_rate", cohorts.superseded_decision_rate(ctx)),
      #("evidence_limited_exits", cohorts.evidence_limited_exits(ctx)),
      #("reopen_rate", cohorts.reopen_rate(ctx)),
    ]
    "coverage" -> {
      let #(backlog, review_rate) = cohorts.nobody_missed_coverage(ctx)
      let #(second_look, response_time) = cohorts.second_look_coverage(ctx)
      [
        #("briefs_live", cohorts.briefs_live(ctx)),
        #("nobody_missed_backlog", backlog),
        #("nobody_missed_review_rate", review_rate),
        #("second_look_backlog", second_look),
        #("second_look_response_time", response_time),
      ]
    }
    "source" -> [
      #("room_source_mix", funnels.room_source_mix(ctx)),
      #("source_stage_reach", funnels.source_stage_reach(ctx)),
    ]
    "watchlist" -> {
      let #(active, churn) = cohorts.watchlist_activity(ctx)
      [#("active_watchlists", active), #("watchlist_membership_churn", churn)]
    }
    _ -> []
  })
}

/// Period-over-period on three period-activity counts only. A trend on a point-in-time figure is meaningless
/// (the window does not apply), and one on a rate compounds two small samples.
fn trend(ctx: Context) -> Json {
  let prev = metrics.previous_window(ctx.window)
  // Each instant counts in the window, else in the previous period, else nowhere.
  let tally = fn(ats: List(Int)) {
    list.fold(ats, #(0, 0), fn(acc, at) {
      case metrics.in_window(at, ctx.window), metrics.in_window(at, prev) {
        True, _ -> #(acc.0 + 1, acc.1)
        False, True -> #(acc.0, acc.1 + 1)
        False, False -> acc
      }
    })
  }
  let comparison = fn(ats) {
    let #(now, then) = tally(ats)
    metrics.comparison_json(metrics.compare(now, then))
  }
  json.object([
    #("previousWindow", metrics.window_json(prev)),
    #(
      "note",
      json.string(
        "Compared with the previous period of the same length. Only period activity is compared — a trend on a current-state figure would be meaningless, because the period does not apply to it.",
      ),
    ),
    #("rooms_opened", comparison(list.map(ctx.rooms, fn(r) { r.created_at }))),
    #(
      "rooms_ended",
      comparison(
        list.filter_map(ctx.rooms, fn(r) {
          option.to_result(context.first_terminal_at(r), Nil)
        }),
      ),
    ),
    #(
      "decisions_recorded",
      comparison(list.map(ctx.decisions, fn(d) { d.created_at })),
    ),
  ])
}

pub fn filters_json(filters: List(#(String, String))) -> Json {
  json.array(filters, fn(f) {
    json.object([#("filter", json.string(f.0)), #("value", json.string(f.1))])
  })
}

/// `families` are the ones asked for, in that order; `fault` names one to fail, the fault-injection hook that
/// lets a test exercise the partial page.
pub fn build(
  ctx: Context,
  families: List(String),
  stall_days: Int,
  fault: Option(String),
) -> Json {
  let wanted = list.filter(families, list.contains(metrics.family_ids(), _))
  let slots =
    list.map(wanted, fn(family) {
      let head = [
        #("family", json.string(family)),
        #("label", json.string(metrics.family_label(family))),
      ]
      case fault == Some(family) {
        True -> #(
          family,
          False,
          json.object(
            list.append(head, [
              #("error", json.string("FAMILY_UNAVAILABLE")),
              #(
                "detail",
                json.string("injected fault in family \"" <> family <> "\""),
              ),
            ]),
          ),
        )
        False -> {
          let honoured = family_filters(family)
          #(
            family,
            True,
            json.object(
              list.append(head, [
                #("filtersHonoured", json.array(honoured, json.string)),
                #(
                  "filtersNotApplicable",
                  json.array(
                    list.filter_map(ctx.filters, fn(f) {
                      case list.contains(honoured, f.0) {
                        True -> Error(Nil)
                        False -> Ok(f.0)
                      }
                    }),
                    json.string,
                  ),
                ),
                #("metrics", family_metrics(ctx, family, stall_days)),
              ]),
            ),
          )
        }
      }
    })
  let failed =
    list.filter_map(slots, fn(s) {
      case s.1 {
        True -> Error(Nil)
        False -> Ok(s.0)
      }
    })
  json.object([
    #("policyVersion", json.int(metrics.policy_version)),
    #("generatedAt", json.int(ctx.now)),
    #("window", metrics.window_json(ctx.window)),
    #("filters", filters_json(ctx.filters)),
    #("smallNMinimum", json.int(metrics.small_n_min)),
    // Computed when the request was served, not refreshed; the client says "calculated at …".
    #("calculatedAt", json.int(ctx.now)),
    #("liveStream", json.bool(False)),
    #("trend", trend(ctx)),
    #("timeSemantics", metrics.time_semantics_json()),
    #("groupDimensions", json.array(metrics.group_dimensions, json.string)),
    #("families", json.array(wanted, json.string)),
    #("partial", json.bool(failed != [])),
    #("unavailable", json.array(failed, json.string)),
    // On the wire, not only in the client, so an integrator cannot drop it by accident.
    #(
      "note",
      json.string(
        "These figures measure your recruitment process — how work moves, how long it takes and what is waiting. They do not measure any player’s ability or potential, and they do not measure any colleague’s performance.",
      ),
    ),
    #("data", json.object(dedupe(list.map(slots, fn(s) { #(s.0, s.2) })))),
  ])
}

/// A family asked for twice has one slot, at its first place (as a JavaScript object keeps a key).
fn dedupe(entries: List(#(String, Json))) -> List(#(String, Json)) {
  list.fold(entries, [], fn(acc, e) {
    case list.key_find(acc, e.0) {
      Ok(_) -> acc
      Error(Nil) -> [e, ..acc]
    }
  })
  |> list.reverse
}
