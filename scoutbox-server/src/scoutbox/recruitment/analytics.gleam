//// The Director Dashboard (`GET /org/recruitment-analytics`, domains/recruitment/analytics): figures about a club's
//// recruitment process, for leads only. They measure how work moves, never a player's ability or a colleague's
//// performance.
////
//// Not ported yet: every family but `aging`, and every metric of it but `overdue_trial_reports` (the same rule
//// that blocks new trial requests, seen from the top); the window, filters, trend, time semantics and group
//// dimensions; the drill-down rows route and the `analytics_read` budget.

import gleam/float
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{None, Some}
import gleam/order
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/store
import scoutbox/recruitment/trials
import scoutbox/rows/id
import scoutbox/rows/trials as trial_row
import wisp.{type Response}

const day_ms = 86_400_000

fn count(n: Int) -> List(#(String, Json)) {
  [
    #("n", json.int(n)),
    #("value", json.int(n)),
    #("empty", json.bool(False)),
    #("suppressed", json.bool(False)),
  ]
}

/// `GET /org/recruitment-analytics`.
pub fn dashboard(ctx: Ctx, a: OrgAccess) -> Response {
  use <- access.require_lead(a)
  let now = clock.now_ms()
  case store.read(ctx.store, trials.for_org(_, a.org.id)) {
    Error(e) -> http.internal(e)
    Ok(all) -> {
      // A missing deadline is unknown, not overdue, and a subject who removed their account leaves no obligation
      // anyone can meet.
      let awaiting =
        list.filter(all, fn(t) {
          t.row.status == trial_row.AwaitingReport
          && t.row.subject_removed_at == None
        })
      let late =
        awaiting
        |> list.filter_map(fn(t) {
          case t.row.report_due_at {
            Some(due) if due < now -> Ok(#(t, due))
            _ -> Error(Nil)
          }
        })
        |> list.sort(fn(x, y) {
          case int.compare(x.1, y.1) {
            order.Eq ->
              string.compare(
                id.trial_to_string({ x.0 }.row.id),
                id.trial_to_string({ y.0 }.row.id),
              )
            other -> other
          }
        })
      let metric =
        json.object(
          list.flatten([
            [
              #("id", json.string("overdue_trial_reports")),
              #("family", json.string("aging")),
              #("name", json.string("Trial reports past due")),
              #("unit", json.string("trials")),
              #("semantics", json.string("point_in_time")),
              #("sources", json.array(["trials"], json.string)),
              #("ratio", json.bool(False)),
              #(
                "limitation",
                json.string(
                  "This surfaces an obligation the server already enforces — unfiled reports block new trial requests. It adds no new judgement.",
                ),
              ),
            ],
            count(list.length(late)),
            [
              #("awaitingReport", json.object(count(list.length(awaiting)))),
              #(
                "rows",
                json.array(late, fn(x) {
                  json.object([
                    #("trialId", id.trial_json({ x.0 }.row.id)),
                    #(
                      "overdueDays",
                      json.int(float.truncate(
                        int.to_float(now - x.1) /. int.to_float(day_ms),
                      )),
                    ),
                  ])
                }),
              ),
              #(
                "note",
                json.string(
                  "Unfiled trial reports already block new trial requests. This is the same rule, seen from the top.",
                ),
              ),
            ],
          ]),
        )
      wisp.set_header(
        http.json(
          200,
          json.object([
            #("policyVersion", json.int(1)),
            #("generatedAt", json.int(now)),
            #("calculatedAt", json.int(now)),
            #("liveStream", json.bool(False)),
            #("families", json.array(["aging"], json.string)),
            #("partial", json.bool(False)),
            #("unavailable", json.preprocessed_array([])),
            #(
              "note",
              json.string(
                "These figures measure your recruitment process — how work moves, how long it takes and what is waiting. They do not measure any player’s ability or potential, and they do not measure any colleague’s performance.",
              ),
            ),
            #(
              "data",
              json.object([
                #(
                  "aging",
                  json.object([
                    #("family", json.string("aging")),
                    #("label", json.string("Work that has stopped moving")),
                    #(
                      "metrics",
                      json.object([#("overdue_trial_reports", metric)]),
                    ),
                  ]),
                ),
              ]),
            ),
          ]),
        ),
        "x-scoutbox-ordering",
        "fixed_vocabulary_then_stable_id",
      )
    }
  }
}
