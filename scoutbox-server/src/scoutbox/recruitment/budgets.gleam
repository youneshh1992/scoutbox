//// A case's budget scenarios (domains/recruitment/budgets.mjs): planned lines, stated exchange-rate assumptions, a
//// lead's approval of one version, and actuals recorded against lines. Money is integer minor units throughout,
//// and nothing here invents a market value: totals add only what was entered.

import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/rows/case_budget_actuals as actual_row
import scoutbox/rows/case_budget_fx_assumptions as fx_row
import scoutbox/rows/case_budget_lines as line_row
import scoutbox/rows/case_budget_scenarios as scenario_row
import scoutbox/rows/id
import scoutbox/vocab/currency.{type Currency}

pub type Scenario {
  Scenario(
    row: scenario_row.Row,
    lines: List(line_row.Row),
    fx: List(fx_row.Row),
    actuals: List(actual_row.Row),
  )
}

// ---------------------------------------------------------------------------------------------------------- reads

fn of_scenario(
  read: Read,
  columns: String,
  table: String,
  case_id: id.RecruitmentCaseId,
  scenario_id: id.BudgetScenarioId,
  decoder: decode.Decoder(a),
) -> Result(List(a), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> columns
      <> " FROM "
      <> table
      <> " WHERE case_id = ? AND scenario_id = ? ORDER BY position",
    [id.recruitment_case_sql(case_id), id.budget_scenario_sql(scenario_id)],
    decoder,
  )
}

fn whole(read: Read, s: scenario_row.Row) -> Result(Scenario, Fail(e)) {
  use lines <- result.try(of_scenario(
    read,
    line_row.columns,
    line_row.table,
    s.case_id,
    s.id,
    line_row.decoder(),
  ))
  use fx <- result.try(of_scenario(
    read,
    fx_row.columns,
    fx_row.table,
    s.case_id,
    s.id,
    fx_row.decoder(),
  ))
  use actuals <- result.map(of_scenario(
    read,
    actual_row.columns,
    actual_row.table,
    s.case_id,
    s.id,
    actual_row.decoder(),
  ))
  Scenario(row: s, lines:, fx:, actuals:)
}

/// The case's scenarios, in the order they were added.
pub fn of_case(
  read: Read,
  case_id: id.RecruitmentCaseId,
) -> Result(List(Scenario), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> scenario_row.columns
      <> " FROM case_budget_scenarios WHERE case_id = ? ORDER BY position",
    [id.recruitment_case_sql(case_id)],
    scenario_row.decoder(),
  ))
  list.try_map(rows, whole(read, _))
}

/// One scenario of the case, if it has it.
pub fn by_id(
  read: Read,
  case_id: id.RecruitmentCaseId,
  scenario_id: id.BudgetScenarioId,
) -> Result(Option(Scenario), Fail(e)) {
  use found <- result.try(store.one(
    read,
    "SELECT "
      <> scenario_row.columns
      <> " FROM case_budget_scenarios WHERE case_id = ? AND id = ?",
    [id.recruitment_case_sql(case_id), id.budget_scenario_sql(scenario_id)],
    scenario_row.decoder(),
  ))
  case found {
    Error(Nil) -> Ok(None)
    Ok(s) -> whole(read, s) |> result.map(Some)
  }
}

// ----------------------------------------------------------------------------------------------------------- json

pub fn line_json(l: line_row.Row) -> Json {
  json.object([
    #("id", id.budget_line_json(l.id)),
    #("kind", line_row.kind_to_json(l.kind)),
    #("label", json.string(l.label)),
    #("amountMinor", json.int(l.amount_minor)),
    #("currency", currency.to_json(l.currency)),
    #("schedule", line_row.schedule_to_json(l.schedule)),
    #("confirmed", json.bool(l.confirmed)),
    #("conditional", case l.conditional_assumption {
      Some(a) -> json.object([#("assumption", json.string(a))])
      None -> json.null()
    }),
  ])
}

pub fn fx_json(a: fx_row.Row) -> Json {
  json.object([
    #("from", currency.to_json(a.from_currency)),
    #("to", currency.to_json(a.to_currency)),
    #("rate", json.string(a.rate)),
    #("source", json.nullable(a.source, json.string)),
    #("date", json.string(a.date)),
    #("manual", json.bool(a.manual)),
  ])
}

pub fn actual_json(a: actual_row.Row) -> Json {
  json.object([
    #("id", id.budget_actual_json(a.id)),
    #("lineId", id.budget_line_json(a.line_id)),
    #("amountMinor", json.int(a.amount_minor)),
    #("at", json.int(a.at)),
    #("recordedBy", json.nullable(a.recorded_by_name, json.string)),
  ])
}

/// The scenario's own fields, as the case record stores them; `extra` follows them (a list's `totals`).
pub fn fields(s: Scenario) -> List(#(String, Json)) {
  let r = s.row
  [
    #("id", id.budget_scenario_json(r.id)),
    #("version", json.int(r.version)),
    #("label", json.string(r.label)),
    #("currency", currency.to_json(r.currency)),
    #("termMonths", json.int(r.term_months)),
    #("lines", json.array(s.lines, line_json)),
    #("fxAssumptions", json.array(s.fx, fx_json)),
    #("approval", case r.approval_at {
      None -> json.null()
      Some(at) ->
        json.object([
          #("by", json.nullable(r.approval_by_name, json.string)),
          #("byUserId", json.nullable(r.approval_by_user_id, id.org_user_json)),
          #("at", json.int(at)),
          #("version", json.nullable(r.approval_version, json.int)),
          #(
            "superseded",
            json.bool(option.unwrap(r.approval_superseded, False)),
          ),
        ])
    }),
    #("actuals", json.array(s.actuals, actual_json)),
    #("createdBy", json.nullable(r.created_by_name, json.string)),
    #("createdAt", json.int(r.created_at)),
    #("updatedAt", json.int(r.updated_at)),
  ]
}

pub fn scenario_json(s: Scenario) -> Json {
  json.object(fields(s))
}

/// The case record's `budget`: null until the case has a scenario.
pub fn budget_json(
  read: Read,
  case_id: id.RecruitmentCaseId,
) -> Result(Json, Fail(e)) {
  use scenarios <- result.map(of_case(read, case_id))
  case scenarios {
    [] -> json.null()
    _ -> json.object([#("scenarios", json.array(scenarios, scenario_json))])
  }
}

// --------------------------------------------------------------------------------------------------------- totals

/// What one currency's lines add up to.
pub type Bucket {
  Bucket(confirmed_minor: Int, estimated_minor: Int, conditional_count: Int)
}

/// The combined total: one currency's own, every currency converted under a stated rate, or unavailable.
pub type Combined {
  NoLines
  OneCurrency(currency: Currency, bucket: Bucket)
  ViaFx(
    currency: Currency,
    confirmed_minor: Int,
    estimated_minor: Int,
    applied: List(fx_row.Row),
  )
  Unavailable
}

pub type Totals {
  Totals(
    term_months: Int,
    per_currency: List(#(Currency, Bucket)),
    combined: Combined,
    conditional_lines: List(line_row.Row),
  )
}

/// How many times a line is paid over the term (budgets.mjs `occurrences`): weekly rounds half up.
pub fn occurrences(schedule: line_row.Schedule, term_months: Int) -> Int {
  case schedule {
    line_row.OneOff -> 1
    line_row.Monthly -> term_months
    line_row.Annual -> { term_months + 11 } / 12
    line_row.Weekly -> { term_months * 52 * 2 + 12 } / 24
  }
}

/// `amount_minor` at a stated decimal rate (money.mjs `convertMinor`): exact to six places, rounded half up.
/// Error when the rate is not a decimal with at most six places.
pub fn convert_minor(amount_minor: Int, rate: String) -> Result(Int, Nil) {
  use #(units, places) <- result.try(case string.split(rate, ".") {
    [u] -> Ok(#(u, ""))
    [u, p] if p != "" -> Ok(#(u, p))
    _ -> Error(Nil)
  })
  use <- bool_guard(
    units == ""
    || string.length(places) > 6
    || !all_digits(units)
    || !all_digits(places),
  )
  use u <- result.try(int.parse(units))
  use p <- result.try(case places {
    "" -> Ok(0)
    _ -> int.parse(string.pad_end(places, 6, "0"))
  })
  let num = amount_minor * { u * 1_000_000 + p }
  let q = num / 1_000_000
  let r = num % 1_000_000
  Ok(case r * 2 >= 1_000_000 {
    True -> q + 1
    False -> q
  })
}

fn bool_guard(refused: Bool, next: fn() -> Result(a, Nil)) -> Result(a, Nil) {
  case refused {
    True -> Error(Nil)
    False -> next()
  }
}

fn all_digits(s: String) -> Bool {
  string.to_graphemes(s)
  |> list.all(string.contains("0123456789", _))
}

/// Totals per currency, and a combined total only where explicit rates cover every currency
/// (budgets.mjs `computeScenarioTotals`). A conditional line is listed, never summed.
pub fn totals(
  term_months term: Int,
  currency target: Currency,
  lines lines: List(line_row.Row),
  fx fx: List(fx_row.Row),
) -> Totals {
  // Currencies in the order their first line names them, as the object's keys are.
  let per_currency =
    list.fold(lines, [], fn(acc, l) {
      let b =
        list.key_find(acc, l.currency)
        |> result.unwrap(Bucket(0, 0, 0))
      let b = case l.conditional_assumption, l.confirmed {
        Some(_), _ -> Bucket(..b, conditional_count: b.conditional_count + 1)
        None, True ->
          Bucket(
            ..b,
            confirmed_minor: b.confirmed_minor
              + l.amount_minor
              * occurrences(l.schedule, term),
          )
        None, False ->
          Bucket(
            ..b,
            estimated_minor: b.estimated_minor
              + l.amount_minor
              * occurrences(l.schedule, term),
          )
      }
      list.key_set(acc, l.currency, b)
    })
  let combined = case per_currency {
    [] -> NoLines
    [#(c, b)] -> OneCurrency(c, b)
    _ -> combine(per_currency, target, fx, 0, 0, [])
  }
  Totals(
    term_months: term,
    per_currency:,
    combined:,
    conditional_lines: list.filter(lines, fn(l) {
      option.is_some(l.conditional_assumption)
    }),
  )
}

fn combine(
  left: List(#(Currency, Bucket)),
  target: Currency,
  fx: List(fx_row.Row),
  confirmed: Int,
  estimated: Int,
  applied: List(fx_row.Row),
) -> Combined {
  case left {
    [] -> ViaFx(target, confirmed, estimated, list.reverse(applied))
    [#(c, b), ..rest] if c == target ->
      combine(
        rest,
        target,
        fx,
        confirmed + b.confirmed_minor,
        estimated + b.estimated_minor,
        applied,
      )
    [#(c, b), ..rest] -> {
      let rate =
        list.find(fx, fn(a) { a.from_currency == c && a.to_currency == target })
      case rate {
        Error(Nil) -> Unavailable
        Ok(a) ->
          case
            convert_minor(b.confirmed_minor, a.rate),
            convert_minor(b.estimated_minor, a.rate)
          {
            Ok(c1), Ok(c2) ->
              combine(rest, target, fx, confirmed + c1, estimated + c2, [
                a,
                ..applied
              ])
            _, _ -> Unavailable
          }
      }
    }
  }
}

fn bucket_fields(b: Bucket) -> List(#(String, Json)) {
  [
    #("confirmedMinor", json.int(b.confirmed_minor)),
    #("estimatedMinor", json.int(b.estimated_minor)),
    #("conditionalCount", json.int(b.conditional_count)),
  ]
}

pub fn totals_json(t: Totals) -> Json {
  json.object([
    #("termMonths", json.int(t.term_months)),
    #(
      "perCurrency",
      json.object(
        list.map(t.per_currency, fn(p) {
          #(currency.to_string(p.0), json.object(bucket_fields(p.1)))
        }),
      ),
    ),
    #("combined", case t.combined {
      NoLines -> json.null()
      OneCurrency(c, b) ->
        json.object(
          list.flatten([
            [#("currency", currency.to_json(c))],
            bucket_fields(b),
            [#("viaFx", json.bool(False))],
          ]),
        )
      ViaFx(c, confirmed, estimated, applied) ->
        json.object([
          #("currency", currency.to_json(c)),
          #("confirmedMinor", json.int(confirmed)),
          #("estimatedMinor", json.int(estimated)),
          #("viaFx", json.bool(True)),
          #("fxApplied", json.array(applied, fx_json)),
          #(
            "fxNote",
            json.string(
              "Converted with the stated manual assumptions — not market rates.",
            ),
          ),
        ])
      Unavailable ->
        json.object([
          #("unavailable", json.bool(True)),
          #(
            "reason",
            json.string(
              "Currencies mixed without a stated exchange-rate assumption for each — totals stay per-currency.",
            ),
          ),
        ])
    }),
    #(
      "conditionalLines",
      json.array(t.conditional_lines, fn(l) {
        json.object([
          #("label", json.string(l.label)),
          #("amountMinor", json.int(l.amount_minor)),
          #("currency", currency.to_json(l.currency)),
          #("schedule", line_row.schedule_to_json(l.schedule)),
          #(
            "assumption",
            json.string(option.unwrap(l.conditional_assumption, "")),
          ),
        ])
      }),
    ),
    #(
      "conditionalNote",
      json.string(
        "Conditional amounts are listed with their assumptions and EXCLUDED from every total.",
      ),
    ),
  ])
}

/// The scenario's totals.
pub fn scenario_totals(s: Scenario) -> Totals {
  totals(
    term_months: s.row.term_months,
    currency: s.row.currency,
    lines: s.lines,
    fx: s.fx,
  )
}

/// A scenario with its totals after its own fields, as the budget list serves it.
pub fn with_totals_json(s: Scenario) -> Json {
  json.object(
    list.append(fields(s), [#("totals", totals_json(scenario_totals(s)))]),
  )
}
