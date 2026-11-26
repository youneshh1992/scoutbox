//// Recruitment analytics routes (domains/recruitment/analytics/index.mjs): the Director Dashboard, its
//// catalogue and the drill-down rows. Leads only. Figures carry no note, comment, assessment or free text and
//// are never broken down by colleague. Drill-down is cursor-paged in a stable order. Nothing is stored: every
//// figure is projected from other modules' records, and its reads are counted in `platform/request_metrics`.

import gleam/float
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/limits
import scoutbox/platform/request_metrics.{type Snapshot}
import scoutbox/platform/store
import scoutbox/recruitment/analytics/cohorts
import scoutbox/recruitment/analytics/context.{type Filters, Filters}
import scoutbox/recruitment/analytics/dashboard
import scoutbox/recruitment/analytics/funnels
import scoutbox/recruitment/analytics/metrics.{type Window}
import scoutbox/recruitment/analytics/time_series
import scoutbox/rows/id
import scoutbox/rows/recruitment_cases as case_row
import wisp.{type Request, type Response}

/// The metrics whose rows a director can page through.
pub const drilldown_metrics = [
  "stalled_rooms", "decision_outstanding", "terminal_with_recorded_decision",
  "overdue_trial_reports",
]

const page_max = 50

const page_default = 25

const codes = [
  #("limit", "PAGE_LIMIT_INVALID"),
  #("cursor", "PAGE_CURSOR_INVALID"),
]

fn priorities() -> List(String) {
  list.map(case_row.room_priority_pairs, fn(p) { p.0 })
}

// ------------------------------------------------------------- the query

/// The parameters every analytics read takes, each once, as text: a repeated `?window=a&window=b` arrives as a
/// list and is refused. Their values are judged by `read_query`.
type Params {
  Params(
    group_by: Option(String),
    group_by_snake: Option(String),
    window: Option(String),
    from: Option(String),
    to: Option(String),
    source: Option(String),
    priority: Option(String),
    brief: Option(String),
    families: Option(String),
    stall_days: Option(String),
  )
}

fn param(
  name: String,
  next: fn(Option(String)) -> input.Shape(a),
) -> input.Shape(a) {
  input.field(name, input.optional(input.text(100_000)), next)
}

fn params(next: fn(Params) -> input.Shape(a)) -> input.Shape(a) {
  use group_by <- param("groupBy")
  use group_by_snake <- param("group_by")
  use window <- param("window")
  use from <- param("from")
  use to <- param("to")
  use source <- param("source")
  use priority <- param("priority")
  use brief <- param("brief")
  use families <- param("families")
  use stall_days <- param("stallDays")
  next(Params(
    group_by:,
    group_by_snake:,
    window:,
    from:,
    to:,
    source:,
    priority:,
    brief:,
    families:,
    stall_days:,
  ))
}

type Parsed {
  Parsed(
    window: Window,
    filters: Filters,
    families: List(String),
    stall_days: Int,
  )
}

fn refusal(error: String, detail: String, allowed: Json) -> Response {
  http.json(
    400,
    json.object([
      #("error", json.string(error)),
      #("status", json.int(400)),
      #("detail", json.string(detail)),
      #("allowed", allowed),
    ]),
  )
}

fn filled(v: Option(String)) -> Option(String) {
  case v {
    Some("") -> None
    other -> other
  }
}

/// JavaScript's `Number(text)` for the decimal forms a client sends: surrounding blanks are ignored.
fn js_number(text: String) -> Result(Float, Nil) {
  let t = string.trim(text)
  case int.parse(t) {
    Ok(n) -> Ok(int.to_float(n))
    Error(Nil) -> float.parse(t)
  }
}

/// Nothing is silently repaired: an unknown source context is a 400, not "everything instead".
fn read_query(p: Params, now: Int) -> Result(Parsed, Response) {
  let group_by = case p.group_by {
    Some(g) -> Some(g)
    None -> p.group_by_snake
  }
  let dimensions = json.array(metrics.group_dimensions, json.string)
  use _ <- result.try(case filled(group_by) {
    None -> Ok(Nil)
    Some(g) ->
      case
        list.contains(metrics.person_dimensions, g),
        list.contains(metrics.group_dimensions, g)
      {
        True, _ ->
          Error(refusal(
            "GROUPING_BY_PERSON_REFUSED",
            "ScoutBox does not break recruitment analytics down by person. These figures measure the process, not any colleague’s performance, and a per-person breakdown of them would be a scout leaderboard.",
            dimensions,
          ))
        False, False ->
          Error(refusal(
            "GROUPING_UNKNOWN",
            "Unknown grouping \"" <> g <> "\".",
            dimensions,
          ))
        False, True -> Ok(Nil)
      }
  })
  use window <- result.try(
    metrics.resolve_window(p.window, p.from, p.to, now)
    |> result.map_error(fn(w) {
      http.json(
        400,
        json.object(
          list.flatten([
            [
              #("error", json.string(w.error)),
              #("detail", json.string(w.detail)),
            ],
            case w.allowed {
              Some(a) -> [#("allowed", json.array(a, json.string))]
              None -> []
            },
            [#("status", json.int(400))],
          ]),
        ),
      )
    }),
  )
  use source <- result.try(case filled(p.source) {
    Some(s) ->
      case list.contains(funnels.source_contexts(), s) {
        True -> Ok(Some(s))
        False ->
          Error(refusal(
            "SOURCE_CONTEXT_UNKNOWN",
            "Unknown source context \"" <> s <> "\".",
            json.array(funnels.source_contexts(), json.string),
          ))
      }
    None -> Ok(None)
  })
  use priority <- result.try(case filled(p.priority) {
    Some(s) ->
      case list.contains(priorities(), s) {
        True -> Ok(Some(s))
        False ->
          Error(refusal(
            "ROOM_PRIORITY_UNKNOWN",
            "Unknown priority \"" <> s <> "\".",
            json.array(priorities(), json.string),
          ))
      }
    None -> Ok(None)
  })
  use families <- result.try(case filled(p.families) {
    None -> Ok(metrics.family_ids())
    Some(text) -> {
      let asked =
        string.split(text, ",")
        |> list.map(string.trim)
        |> list.filter(fn(s) { s != "" })
      case
        list.filter(asked, fn(f) { !list.contains(metrics.family_ids(), f) })
      {
        [] -> Ok(asked)
        unknown ->
          Error(refusal(
            "FAMILY_UNKNOWN",
            "Unknown family: " <> string.join(unknown, ", ") <> ".",
            json.array(metrics.family_ids(), json.string),
          ))
      }
    }
  })
  use stall_days <- result.try(case filled(p.stall_days) {
    None -> Ok(time_series.default_stall_days)
    Some(text) -> {
      let known =
        js_number(text)
        |> result.try(fn(n) {
          list.find(time_series.stall_thresholds, fn(t) { int.to_float(t) == n })
        })
      case known {
        Ok(n) -> Ok(n)
        Error(Nil) ->
          Error(refusal(
            "STALL_THRESHOLD_UNKNOWN",
            "Stall threshold must be one of "
              <> string.join(
              list.map(time_series.stall_thresholds, int.to_string),
              ", ",
            )
              <> " days.",
            json.array(time_series.stall_thresholds, json.int),
          ))
      }
    }
  })
  Ok(Parsed(
    window:,
    filters: Filters(
      source_context: source,
      priority:,
      brief_id: filled(p.brief),
    ),
    families:,
    stall_days:,
  ))
}

fn limited(ctx: Ctx, a: OrgAccess, next: fn() -> Response) -> Response {
  let action = limits.AnalyticsRead
  case
    limits.limited(
      ctx.limits,
      action,
      id.org_to_string(a.org.id),
      clock.now_ms(),
    )
  {
    True ->
      http.json(
        429,
        json.object(
          list.map(limits.limited_body(action), fn(p) {
            #(p.0, json.string(p.1))
          }),
        ),
      )
    False -> next()
  }
}

fn with_context(
  ctx: Ctx,
  a: OrgAccess,
  parsed: Parsed,
  now: Int,
  next: fn(context.Context) -> Response,
) -> Response {
  case store.read(ctx.store, context.read(_, a.org, now)) {
    Error(e) -> http.internal(e)
    Ok(sources) ->
      next(context.build(sources, parsed.window, now, parsed.filters))
  }
}

// ------------------------------------------------------------- the catalogue

/// `GET /org/recruitment-analytics/catalogue`. Served so clients render definitions from the server's registry
/// rather than a copy that can drift.
pub fn catalogue(a: OrgAccess) -> Response {
  use <- access.require_lead(a)
  http.json(
    200,
    json.object([
      #("policyVersion", json.int(metrics.policy_version)),
      #(
        "principle",
        json.string(
          "Measure the recruitment process, not the worth of the player or the scout.",
        ),
      ),
      #(
        "families",
        json.array(metrics.families, fn(f) {
          json.object([
            #("id", json.string(f.id)),
            #("label", json.string(f.label)),
          ])
        }),
      ),
      #("timeSemantics", metrics.time_semantics_json()),
      #("smallNMinimum", json.int(metrics.small_n_min)),
      #(
        "smallNNote",
        json.string(
          "A rate or a median over fewer than "
          <> int.to_string(metrics.small_n_min)
          <> " records is withheld and shown as raw counts instead. Counts themselves are never hidden.",
        ),
      ),
      #("groupDimensions", json.array(metrics.group_dimensions, json.string)),
      #(
        "windows",
        json.array(metrics.window_presets, fn(p) { json.string(p.0) }),
      ),
      #("defaultWindow", json.string(metrics.default_window)),
      #("sourceContexts", json.array(funnels.source_contexts(), json.string)),
      #("priorities", json.array(priorities(), json.string)),
      #("stallThresholds", json.array(time_series.stall_thresholds, json.int)),
      #(
        "registry",
        json.object([
          #("metrics", json.int(list.length(metrics.metrics))),
          #("families", json.int(list.length(metrics.families))),
        ]),
      ),
      #(
        "metrics",
        json.array(metrics.metrics, fn(m) {
          json.object([
            #("id", json.string(m.id)),
            #("family", json.string(m.family)),
            #("name", json.string(m.name)),
            #("unit", json.string(m.unit)),
            #("semantics", json.string(m.semantics)),
            #("sources", json.array(m.sources, json.string)),
            #(
              "kind",
              json.string(case m.measure {
                metrics.IsDistribution -> "distribution"
                metrics.IsRatio(True) -> "ratio"
                metrics.IsRatio(False) -> "count"
              }),
            ),
            #("associationOnly", json.bool(m.association)),
            #("limitation", json.string(m.limitation)),
          ])
        }),
      ),
      #(
        "neverBuilt",
        json.object([
          #(
            "note",
            json.string("These do not exist in ScoutBox and are not planned."),
          ),
          #("names", json.array(metrics.forbidden_metric_names, json.string)),
          #(
            "reason",
            json.string(
              "A single blended figure invites a decision it cannot support, and a per-person breakdown of process counts is a ranking of colleagues however it is labelled.",
            ),
          ),
        ]),
      ),
    ]),
  )
}

// -------------------------------------------------------------- the dashboard

type DashboardQuery {
  DashboardQuery(params: Params, simulate_failure: Option(String))
}

/// `GET /org/recruitment-analytics`.
/// Two counters only, neither of which could be read as a measure of anybody. A read writes nothing, so they are
/// kept outside any unit.
const metric_group = "analytics"

fn read_counted(ctx: Ctx, name: String) -> Nil {
  request_metrics.count(ctx.request_metrics, metric_group, name)
}

/// The `analytics` group of `/admin/metrics`.
pub fn metrics_json(s: Snapshot) -> Json {
  json.object([
    #(
      "recruitment_analytics_read",
      json.int(request_metrics.counter(
        s,
        metric_group,
        "recruitment_analytics_read",
      )),
    ),
    #(
      "recruitment_analytics_rows_read",
      json.int(request_metrics.counter(
        s,
        metric_group,
        "recruitment_analytics_rows_read",
      )),
    ),
    #("policyVersion", json.int(metrics.policy_version)),
  ])
}

pub fn dashboard(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use <- access.require_lead(a)
  use <- limited(ctx, a)
  let shape = {
    use p <- params
    use simulate_failure <- param("simulateFailure")
    input.done(DashboardQuery(params: p, simulate_failure:))
  }
  use q <- http.query(req, shape, codes)
  let now = clock.now_ms()
  case read_query(q.params, now) {
    Error(refused) -> refused
    Ok(parsed) -> {
      // Fault injection for the partial-failure test; unavailable in production.
      let fault = case ctx.config.dev_faults {
        True -> filled(q.simulate_failure)
        False -> None
      }
      use c <- with_context(ctx, a, parsed, now)
      let body = dashboard.build(c, parsed.families, parsed.stall_days, fault)
      read_counted(ctx, "recruitment_analytics_read")
      // Declared on the wire, as Discover and Matching do: nothing here is ordered by merit.
      http.json(200, body)
      |> wisp.set_header(
        "x-scoutbox-ordering",
        "fixed_vocabulary_then_stable_id",
      )
    }
  }
}

// --------------------------------------------------------------- drill-down

type RowsQuery {
  RowsQuery(
    params: Params,
    metric: Option(String),
    limit: Option(Int),
    cursor: Option(Int),
  )
}

/// `GET /org/recruitment-analytics/rows`: the rows behind one figure, paged. The cursor is the next row's
/// index; the order is stable, so unchanged data never skips or repeats a row.
pub fn rows(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use <- access.require_lead(a)
  use <- limited(ctx, a)
  let shape = {
    use p <- params
    use metric <- param("metric")
    use limit <- input.field(
      "limit",
      input.optional(input.whole_number_text(1, page_max)),
    )
    use cursor <- input.field(
      "cursor",
      input.optional(input.whole_number_text(0, 9_007_199_254_740_991)),
    )
    input.done(RowsQuery(params: p, metric:, limit:, cursor:))
  }
  use q <- http.query(req, shape, codes)
  let metric = option.unwrap(q.metric, "")
  case list.contains(drilldown_metrics, metric) {
    False ->
      http.json(
        400,
        json.object([
          #("error", json.string("METRIC_HAS_NO_ROWS")),
          #(
            "detail",
            json.string("\"" <> metric <> "\" has no row-level view."),
          ),
          #("allowed", json.array(drilldown_metrics, json.string)),
        ]),
      )
    True -> {
      let now = clock.now_ms()
      case read_query(q.params, now) {
        Error(refused) -> refused
        Ok(parsed) -> {
          use c <- with_context(ctx, a, parsed, now)
          let all = case metric {
            "stalled_rooms" -> time_series.stalled_rows(c, parsed.stall_days)
            "decision_outstanding" -> time_series.outstanding_rows(c)
            "terminal_with_recorded_decision" ->
              cohorts.terminal_missing_rows(c)
            _ -> time_series.overdue_rows(c)
          }
          let total = list.length(all)
          read_counted(ctx, "recruitment_analytics_rows_read")
          let limit = option.unwrap(q.limit, page_default)
          let cursor = option.unwrap(q.cursor, 0)
          http.json(
            200,
            json.object([
              #("policyVersion", json.int(metrics.policy_version)),
              #("metric", json.string(metric)),
              #("limitation", json.string(metrics.metric(metric).limitation)),
              #("total", json.int(total)),
              #("limit", json.int(limit)),
              #("cursor", json.int(cursor)),
              #("nextCursor", case cursor + limit < total {
                True -> json.int(cursor + limit)
                False -> json.null()
              }),
              #(
                "rows",
                json.preprocessed_array(
                  all |> list.drop(cursor) |> list.take(limit),
                ),
              ),
            ]),
          )
          |> wisp.set_header(
            "x-scoutbox-ordering",
            "stable_oldest_first_then_id",
          )
        }
      }
    }
  }
}
