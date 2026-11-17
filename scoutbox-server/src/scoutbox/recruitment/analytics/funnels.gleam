//// Recruitment analytics: pipeline shape and where work comes from (domains/recruitment/analytics/funnels.mjs).
////
//// This is not a conversion funnel. Rooms can be reopened (Second Look exists to cause that), so a room counts
//// once for each stage it ever reached, not as a monotonic drop-off.

import gleam/dict.{type Dict}
import gleam/float
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/platform/json_text
import scoutbox/recruitment/analytics/context.{type Context, type Room}
import scoutbox/recruitment/analytics/metrics.{count, count_json, wire}
import scoutbox/recruitment/room_rules
import scoutbox/rows/id
import scoutbox/vocab/room_status
import scoutbox/vocab/source_context

/// The statuses, in the vocabulary's order.
pub fn room_statuses() -> List(String) {
  list.map(room_rules.statuses(), room_status.to_string)
}

pub fn source_contexts() -> List(String) {
  list.map(source_context.pairs, fn(p) { p.0 })
}

/// The statuses that are not progress: the three endings, `on_hold` (a paused case has not advanced) and
/// `offer_declined` (it already counted at offer_made, and a further row would read declining as a step
/// forward).
pub const non_progress_statuses = [
  "withdrawn", "archived", "closed", "on_hold", "offer_declined",
]

pub fn funnel_stages() -> List(String) {
  list.filter(room_statuses(), fn(s) {
    !list.contains(non_progress_statuses, s)
  })
}

/// The category a reason code is filed under, if any.
pub fn reason_category(code: String) -> Option(String) {
  list.find(room_rules.reason_codes, fn(c) { list.contains(c.1, code) })
  |> result.map(fn(c) { c.0 })
  |> option.from_result
}

fn in_window(ctx: Context, at: Int) -> Bool {
  metrics.in_window(at, ctx.window)
}

fn cohort(ctx: Context) -> List(Room) {
  list.filter(ctx.rooms, fn(r) { in_window(ctx, r.created_at) })
}

fn object(parts: List(List(#(String, Json)))) -> Json {
  json.object(list.flatten(parts))
}

// ------------------------------------------------------------ F1 · statuses

pub fn pipeline_stage_counts(ctx: Context) -> Json {
  object([
    wire("pipeline_stage_counts"),
    [
      #("total", count_json(list.length(ctx.rooms))),
      // Vocabulary order: ordering by size would turn a status list into a ranking.
      #(
        "rows",
        json.array(room_statuses(), fn(status) {
          object([
            [
              #("status", json.string(status)),
              #("terminal", json.bool(context.is_terminal(status))),
            ],
            count(list.count(ctx.rooms, fn(r) { r.status == status })),
          ])
        }),
      ),
    ],
  ])
}

// ------------------------------------------------------------- F2 · funnel

/// Of the rooms opened in the window, how many ever reached each later stage, including after the window
/// closed; `reachedOutsideWindow` says how many, since a recent cohort is a story still being written.
pub fn funnel_progression(ctx: Context) -> Json {
  let cohort = cohort(ctx)
  let n = list.length(cohort)
  let rows =
    list.map(funnel_stages(), fn(stage) {
      let reached =
        list.filter_map(cohort, fn(r) {
          option.to_result(context.first_reached_at(r, stage), Nil)
        })
      let outside = list.count(reached, fn(at) { !in_window(ctx, at) })
      object([
        [#("stage", json.string(stage))],
        count(list.length(reached)),
        [
          #("reachedOutsideWindow", json.int(outside)),
          #("share", metrics.ratio_json(metrics.ratio(list.length(reached), n))),
        ],
      ])
    })
  let reopened =
    list.count(cohort, fn(r) { list.any(r.transitions, fn(t) { t.reopen }) })
  object([
    wire("funnel_progression"),
    [
      #("cohort", count_json(n)),
      // Tells the client not to render this as a drop-off.
      #("monotonic", json.bool(False)),
      #("reopenedInCohort", count_json(reopened)),
      #(
        "cohortIncomplete",
        json.bool(metrics.cohort_incomplete(
          ctx.window,
          ctx.typical_days_to_terminal,
          ctx.now,
        )),
      ),
      #(
        "typicalDaysToTerminal",
        json.nullable(ctx.typical_days_to_terminal, json_text.number),
      ),
      #("rows", json.preprocessed_array(rows)),
    ],
  ])
}

// --------------------------------------------------------- F3 · exit reasons

/// For rooms that ended in the window, the reason categories recorded. A decision with codes in two
/// categories counts in both, so shares do not sum to 100 (`overlapping: true`).
pub fn exit_reason_mix(ctx: Context) -> Json {
  let decisions =
    list.flat_map(ctx.rooms, fn(r) {
      case context.first_terminal_at(r) {
        Some(at) ->
          case in_window(ctx, at) {
            True -> dict.get(ctx.decisions_by_room, r.id) |> result.unwrap([])
            False -> []
          }
        None -> []
      }
    })
  let n = list.length(decisions)
  let uncoded = list.count(decisions, fn(d) { d.reason_codes == [] })
  let categories = list.map(room_rules.reason_codes, fn(c) { c.0 })
  let by_category = fn(category) {
    list.count(decisions, fn(d) {
      list.any(d.reason_codes, fn(c) { reason_category(c) == Some(category) })
    })
  }
  let by_code = fn(code) {
    list.fold(decisions, 0, fn(acc, d) {
      acc + list.count(d.reason_codes, fn(c) { c == code })
    })
  }
  object([
    wire("exit_reason_mix"),
    [
      #("total", count_json(n)),
      #("overlapping", json.bool(True)),
      #("uncoded", count_json(uncoded)),
      #(
        "rows",
        json.array(categories, fn(category) {
          let k = by_category(category)
          object([
            [#("category", json.string(category))],
            count(k),
            [#("share", metrics.ratio_json(metrics.ratio(k, n)))],
          ])
        }),
      ),
      // Taxonomy order, never by frequency.
      #(
        "codes",
        json.preprocessed_array(
          list.flat_map(room_rules.reason_codes, fn(c) {
            list.filter_map(c.1, fn(code) {
              case by_code(code) {
                0 -> Error(Nil)
                k ->
                  Ok(
                    object([
                      [
                        #("code", json.string(code)),
                        #("category", json.string(c.0)),
                      ],
                      count(k),
                    ]),
                  )
              }
            })
          }),
        ),
      ),
    ],
  ])
}

// ------------------------------------------------------------ sources

pub fn room_source_mix(ctx: Context) -> Json {
  let cohort = cohort(ctx)
  let n = list.length(cohort)
  object([
    wire("room_source_mix"),
    [
      #("total", count_json(n)),
      #(
        "rows",
        json.preprocessed_array(
          list.filter_map(source_contexts(), fn(source) {
            case list.count(cohort, fn(r) { r.source_context == source }) {
              0 -> Error(Nil)
              k ->
                Ok(
                  object([
                    [
                      #("source", json.string(source)),
                      // An unrecognised context normalises to `direct`, so it is a residual bucket, not a
                      // surface anyone used.
                      #("residual", json.bool(source == "direct")),
                    ],
                    count(k),
                    [#("share", metrics.ratio_json(metrics.ratio(k, n)))],
                  ]),
                )
            }
          }),
        ),
      ),
    ],
  ])
}

// ------------------------------------------------- association, not cause

pub const reach_stages = ["trial_requested", "offer_made", "signed"]

/// Per source, how many rooms opened in the window later reached each stage. Suppressed below the small-n
/// minimum, ordered alphabetically so it never reads as a league table of surfaces, and shipped with the
/// association sentence.
pub fn source_stage_reach(ctx: Context) -> Json {
  let groups =
    cohort(ctx)
    |> list.group(fn(r) { r.source_context })
    |> dict.to_list
    |> list.sort(fn(a, b) { string.compare(a.0, b.0) })
  object([
    wire("source_stage_reach"),
    [
      #("associationOnly", json.bool(True)),
      #("associationNote", json.string(metrics.association_note)),
      #("ordering", json.string("source_name_asc")),
      #("minimum", json.int(metrics.small_n_min)),
      #(
        "rows",
        json.array(groups, fn(g) {
          let #(source, group) = g
          let n = list.length(group)
          json.object([
            #("source", json.string(source)),
            #("cohort", count_json(n)),
            #(
              "stages",
              json.array(reach_stages, fn(stage) {
                let reached =
                  list.count(group, fn(r) {
                    context.first_reached_at(r, stage) != None
                  })
                object([
                  [#("stage", json.string(stage))],
                  metrics.ratio_fields(metrics.ratio(reached, n)),
                ])
              }),
            ),
          ])
        }),
      ),
    ],
  ])
}

// ----------------------------------------------------- F4 · formal decisions

/// Formal decisions finalised in the window, by outcome. Reads only the outcome word and timestamps.
/// Superseded rows still count as decisions made; `superseded` says how many.
pub fn decision_outcomes(ctx: Context) -> Json {
  let rows =
    list.filter(ctx.decisions, fn(d) {
      d.formal && !d.draft && in_window(ctx, d.created_at)
    })
  let outcome = fn(o) { list.count(rows, fn(d) { d.outcome == Some(o) }) }
  object([
    wire("decision_outcomes"),
    count(list.length(rows)),
    [
      #(
        "outcomes",
        json.object(
          list.map(["progress", "hold", "reject"], fn(o) {
            #(o, count_json(outcome(o)))
          }),
        ),
      ),
      #(
        "superseded",
        count_json(list.count(rows, fn(d) { d.superseded_by_id != None })),
      ),
      #(
        "note",
        json.string(
          "Formal decisions finalized in the window, by outcome. Counts only; no rate, no ranking, no reason.",
        ),
      ),
    ],
  ])
}

/// Process counts per step, each keyed on when the step happened. No rate: a completion count beside an
/// invitation count invites dividing, and the limitation sentence says why not to.
pub fn trial_process(ctx: Context) -> Json {
  let w = ctx.window
  let invitations = list.filter(ctx.invitations, fn(r) { r.case_id != None })
  let trials = list.filter(ctx.trials, fn(t) { t.case_id != None })
  let completion = fn(state) {
    list.count(trials, fn(t) {
      t.completion_state == Some(state)
      && metrics.in_window_at(t.completion_at, w)
    })
  }
  let completed = completion("completed")
  let steps = [
    #(
      "invited",
      list.count(invitations, fn(r) { in_window(ctx, r.created_at) }),
    ),
    #(
      "declined",
      list.count(invitations, fn(r) {
        r.status == "declined" && metrics.in_window_at(r.responded_at, w)
      }),
    ),
    #("accepted", list.count(trials, fn(t) { in_window(ctx, t.accepted_at) })),
    #(
      "scheduled",
      list.count(trials, fn(t) { metrics.in_window_at(t.confirmed_at, w) }),
    ),
    #("completed", completed),
    #("cancelled", completion("cancelled")),
  ]
  object([
    wire("trial_process"),
    count(completed),
    [
      #(
        "steps",
        json.object(list.map(steps, fn(s) { #(s.0, count_json(s.1)) })),
      ),
      #(
        "note",
        json.string(
          "Each step is counted on the day it happened, so one trial can appear under several steps in one window and under none in another. Counts are never suppressed; no rate is offered.",
        ),
      ),
    ],
  ])
}

// ------------------------------------------------------------ journey funnel

/// The stages, each with the source whose record proves it and the status whose history entry is its "history
/// only" counterpart.
const journey_stages = [
  #("contacted", "recruitmentContacts", Some("contacted")),
  #("trial_requested", "requests", Some("trial_requested")),
  #("trial_scheduled", "trials", Some("trial_scheduled")),
  #("trial_completed", "trials", Some("trial_completed")),
  #("assessed", "assessments", None),
  #("decision_progress", "roomDecisions", Some("offer_consideration")),
  #("decision_hold", "roomDecisions", None),
  #("decision_reject", "roomDecisions", None),
  #("offer_issued", "recruitmentOffers", Some("offer_made")),
  #("offer_accepted", "recruitmentOffers", Some("offer_accepted")),
  #("offer_declined", "recruitmentOffers", Some("offer_declined")),
  #("signing_started", "signingPackages", None),
  #("signed", "signings", Some("signed")),
]

/// The earliest positive instant among `rows` that satisfy `pred`.
fn first_at(
  rows: List(a),
  pred: fn(a) -> Bool,
  at_of: fn(a) -> Option(Int),
) -> Option(Int) {
  list.fold(rows, None, fn(best, r) {
    case pred(r), at_of(r) {
      True, Some(t) if t > 0 ->
        case best {
          Some(b) if b <= t -> best
          _ -> Some(t)
        }
      _, _ -> best
    }
  })
}

fn grouped(rows: List(a), key: fn(a) -> k) -> Dict(k, List(a)) {
  list.group(rows, key) |> dict.map_values(fn(_, v) { list.reverse(v) })
}

/// The latest terminal transition if the case is terminal now; a reopened case is open again (None).
fn case_ended_at(k: Room) -> Option(Int) {
  case context.is_terminal(k.status) {
    False -> None
    True ->
      list.filter(k.transitions, fn(t) { context.is_terminal(t.to) })
      |> list.map(fn(t) { t.at })
      |> list.fold(0, int.max)
      |> Some
  }
}

/// Indexes of the context's records, built once for the journey funnel.
type Index {
  Index(
    contacts: Dict(id.RecruitmentCaseId, List(context.Contact)),
    invitations: Dict(Option(id.RecruitmentCaseId), List(context.Invitation)),
    trials: Dict(Option(id.RecruitmentCaseId), List(context.Trial)),
    trials_by_id: Dict(String, context.Trial),
    assessments: Dict(id.PlayerId, List(context.Assessment)),
    cases_by_player: Dict(id.PlayerId, List(Room)),
    decisions: Dict(id.RecruitmentCaseId, List(context.Decision)),
    offers: Dict(id.RecruitmentCaseId, List(context.Offer)),
    packages: Dict(id.RecruitmentCaseId, List(context.Package)),
    signings_by_id: Dict(id.SigningId, context.Signing),
    signings_by_player: Dict(id.PlayerId, List(context.Signing)),
  )
}

/// An assessment counts for one case: the one whose Trial it was written in, else the case open when it was
/// written. A second case never claims an ended case's assessment (journey.mjs's `ownedByAnotherCase`).
fn assessment_of_case(a: context.Assessment, k: Room, x: Index) -> Bool {
  case a.trial_id {
    Some(tid) if tid != "" ->
      case dict.get(x.trials_by_id, tid) {
        Ok(t) -> t.case_id == Some(k.id)
        Error(Nil) -> False
      }
    _ -> {
      let at = option.unwrap(a.submitted_at, a.created_at)
      !list.any(
        dict.get(x.cases_by_player, k.player_id) |> result.unwrap([]),
        fn(o) {
          o.id != k.id
          && o.created_at <= at
          && case case_ended_at(o) {
            None -> True
            Some(end) -> at <= end
          }
        },
      )
    }
  }
}

/// The standing formal decision (nothing supersedes it) with this outcome.
fn decision_at(rows: List(context.Decision), outcome: String) -> Option(Int) {
  list.filter(rows, fn(d) {
    d.formal
    && !d.draft
    && d.superseded_by_id == None
    && d.outcome == Some(outcome)
  })
  |> list.map(fn(d) { d.created_at })
  |> list.reduce(int.min)
  |> option.from_result
}

fn min_of(xs: List(Int)) -> Option(Int) {
  list.reduce(xs, int.min) |> option.from_result
}

fn of(d: Dict(k, List(a)), key: k) -> List(a) {
  dict.get(d, key) |> result.unwrap([])
}

/// The instant that proves `stage` for the case `k`, or None.
fn evidence(stage: String, k: Room, x: Index) -> Option(Int) {
  case stage {
    "contacted" ->
      first_at(
        of(x.contacts, k.id),
        fn(c) {
          list.contains(["delivered", "responded", "recorded"], c.status)
          && c.cancelled_at == None
        },
        fn(c) {
          c.delivered_at |> option.or(c.occurred_at) |> option.or(c.recorded_at)
        },
      )
    "trial_requested" ->
      first_at(of(x.invitations, Some(k.id)), fn(_) { True }, fn(r) {
        Some(r.created_at)
      })
    "trial_scheduled" ->
      first_at(
        of(x.trials, Some(k.id)),
        fn(t) {
          t.confirmed_at != None || t.completion_state == Some("completed")
        },
        fn(t) { t.confirmed_at |> option.or(t.completion_at) },
      )
    "trial_completed" ->
      first_at(
        of(x.trials, Some(k.id)),
        fn(t) { t.completion_state == Some("completed") },
        fn(t) { t.completion_at },
      )
    "assessed" ->
      first_at(
        of(x.assessments, k.player_id),
        fn(a) { !a.draft && assessment_of_case(a, k, x) },
        fn(a) { Some(option.unwrap(a.submitted_at, a.created_at)) },
      )
    "decision_progress" -> decision_at(of(x.decisions, k.id), "progress")
    "decision_hold" -> decision_at(of(x.decisions, k.id), "hold")
    "decision_reject" -> decision_at(of(x.decisions, k.id), "reject")
    "offer_issued" ->
      first_at(
        of(x.offers, k.id),
        fn(o) {
          list.any(o.revisions, fn(r) {
            r.issued_at != None && r.status != "DRAFT"
          })
        },
        fn(o) {
          min_of(
            list.filter_map(o.revisions, fn(r) {
              option.to_result(r.issued_at, Nil)
            }),
          )
        },
      )
    "offer_accepted" -> offer_answer(of(x.offers, k.id), "ACCEPTED")
    "offer_declined" -> offer_answer(of(x.offers, k.id), "DECLINED")
    "signing_started" ->
      first_at(of(x.packages, k.id), fn(_) { True }, fn(p) {
        Some(p.created_at)
      })
    "signed" -> signed_at(k, x)
    _ -> None
  }
}

fn offer_answer(offers: List(context.Offer), status: String) -> Option(Int) {
  first_at(
    offers,
    fn(o) { list.any(o.revisions, fn(r) { r.status == status }) },
    fn(o) {
      list.find(o.revisions, fn(r) { r.status == status })
      |> option.from_result
      |> option.then(fn(r) { r.responded_at })
    },
  )
}

/// A canonical row: a COMPLETED package on this case that names the row back. A legacy row: no package,
/// recorded after the case opened.
fn signed_at(k: Room, x: Index) -> Option(Int) {
  let canonical =
    dict.get(x.packages, k.id)
    |> result.unwrap([])
    |> list.find_map(fn(p) {
      let own = Some(p.id)
      case p.completed, p.signing_id {
        True, Some(sid) ->
          case dict.get(x.signings_by_id, sid) {
            Ok(row) if row.package_id == own ->
              case p.completed_at {
                Some(at) if at != 0 -> Ok(Some(at))
                _ if row.ts != 0 -> Ok(Some(row.ts))
                _ -> Ok(None)
              }
            _ -> Error(Nil)
          }
        _, _ -> Error(Nil)
      }
    })
  case canonical {
    Ok(at) -> at
    Error(Nil) ->
      dict.get(x.signings_by_player, k.player_id)
      |> result.unwrap([])
      |> list.filter(fn(s) { s.package_id == None && s.ts >= k.created_at })
      |> list.map(fn(s) { s.ts })
      |> min_of
  }
}

fn median(xs: List(Int)) -> Option(Float) {
  let a = list.sort(xs, int.compare) |> list.map(int.to_float)
  let n = list.length(a)
  let at = fn(i) { list.drop(a, i) |> list.first |> result.unwrap(0.0) }
  case n {
    0 -> None
    _ ->
      case n % 2 {
        1 -> Some(at(n / 2))
        _ -> Some({ at(n / 2 - 1) +. at(n / 2) } /. 2.0)
      }
  }
}

/// Days to one decimal place, as `Math.round(days * 10) / 10`.
fn tenths_of_days(ms: Float) -> Float {
  int.to_float(float.round(ms /. 86_400_000.0 *. 10.0)) /. 10.0
}

/// Cohort: cases opened in the window, the same rule as `funnel_progression`. A case counts once per stage.
/// `historyOnly` counts cohort cases whose history reached the stage with no record behind it, never added.
/// `intervals` are medians, in days, over cases with both ends recorded.
pub fn journey_evidence_funnel(ctx: Context) -> Json {
  let cohort = cohort(ctx)
  let x =
    Index(
      contacts: grouped(ctx.contacts, fn(c) { c.case_id }),
      invitations: grouped(ctx.invitations, fn(r) { r.case_id }),
      trials: grouped(ctx.trials, fn(t) { t.case_id }),
      trials_by_id: ctx.trials
        |> list.map(fn(t) { #(id.trial_to_string(t.id), t) })
        |> dict.from_list,
      assessments: grouped(ctx.assessments, fn(a) { a.player_id }),
      cases_by_player: grouped(ctx.rooms, fn(k) { k.player_id }),
      decisions: grouped(ctx.decisions, fn(d) { d.room_id }),
      offers: grouped(ctx.offers, fn(o) { o.case_id }),
      packages: grouped(ctx.packages, fn(p) { p.case_id }),
      signings_by_id: ctx.signings
        |> list.map(fn(s) { #(s.id, s) })
        |> dict.from_list,
      signings_by_player: grouped(ctx.signings, fn(s) { s.player_id }),
    )
  // The TypeScript rule reads `k.room?.status`, which a projected room doesn't have, so only a history entry
  // counts here: a case sitting in a stage it was created in is not "history only".
  let reached = fn(k: Room, status) {
    list.any(k.history, fn(h) {
      h.action == "room_status_changed" && h.to == Some(status)
    })
  }
  let stages =
    list.map(journey_stages, fn(s) {
      let #(stage, source, status) = s
      let instants =
        list.filter_map(cohort, fn(k) {
          case evidence(stage, k, x) {
            Some(at) -> Ok(#(k.id, at))
            None -> Error(Nil)
          }
        })
      let history_only = case status {
        Some(st) ->
          list.count(cohort, fn(k) {
            evidence(stage, k, x) == None && reached(k, st)
          })
        None -> 0
      }
      #(stage, source, instants, history_only)
    })
  let instants_of = fn(stage) {
    list.find(stages, fn(s) { s.0 == stage })
    |> result.map(fn(s) { dict.from_list(s.2) })
    |> result.unwrap(dict.new())
  }
  let between = fn(a, b) {
    let mb = instants_of(b)
    let xs =
      list.filter_map(dict.to_list(instants_of(a)), fn(e) {
        case dict.get(mb, e.0) {
          Ok(t2) if t2 >= e.1 -> Ok(t2 - e.1)
          _ -> Error(Nil)
        }
      })
    json.object([
      #("n", json.int(list.length(xs))),
      #(
        "medianDays",
        json.nullable(
          median(xs) |> option.map(tenths_of_days),
          json_text.number,
        ),
      ),
    ])
  }
  let n = list.length(cohort)
  object([
    wire("journey_evidence_funnel"),
    count(n),
    [
      #("cohort", count_json(n)),
      #(
        "rows",
        json.array(stages, fn(s) {
          json.object([
            #("stage", json.string(s.0)),
            #("value", json.int(list.length(s.2))),
            #("historyOnly", json.int(s.3)),
            #("basis", json.string("case")),
            #("source", json.string(s.1)),
          ])
        }),
      ),
      #(
        "intervals",
        json.object([
          #("contact_to_trial", between("contacted", "trial_scheduled")),
          #(
            "trial_completed_to_decision",
            between("trial_completed", "decision_progress"),
          ),
          #("decision_to_offer", between("decision_progress", "offer_issued")),
          #(
            "offer_issued_to_accepted",
            between("offer_issued", "offer_accepted"),
          ),
          #("accepted_to_signed", between("offer_accepted", "signed")),
        ]),
      ),
      #("counting", json.string("case")),
      #(
        "note",
        json.string(
          "Each stage counts cases with the record that proves it. \"History only\" counts cohort cases whose status history reached the stage with no such record (older cases), shown apart and never added. Intervals are medians of the records' own instants, in days.",
        ),
      ),
    ],
  ])
}
