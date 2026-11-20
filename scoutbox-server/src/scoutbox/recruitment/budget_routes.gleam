//// The budget routes of a case (domains/recruitment/budgets.mjs): `/org/cases/:id/budget…`. Deal amounts are for
//// leads and finance roles only, on a case the member may open. Each act reads the case and its scenario inside
//// its own unit, so it answers from the state it writes over.

import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/set
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/roles
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/platform/temporal
import scoutbox/recruitment/budgets.{type Scenario}
import scoutbox/recruitment/case_workspace
import scoutbox/recruitment/cases
import scoutbox/rows/case_budget_actuals as actual_row
import scoutbox/rows/case_budget_fx_assumptions as fx_row
import scoutbox/rows/case_budget_lines as line_row
import scoutbox/rows/case_budget_scenarios as scenario_row
import scoutbox/rows/case_history as history_row
import scoutbox/rows/id
import scoutbox/rows/recruitment_cases as case_row
import scoutbox/vocab/currency.{type Currency}
import sqlight
import wisp.{type Request, type Response}

const label_max = 80

const assumption_max = 200

const source_max = 80

const lines_max = 30

const fx_max = 6

const term_months_max = 72

const scenarios_max = 8

const safe_max = 9_007_199_254_740_991

const safe_min = -9_007_199_254_740_991

const codes = [#("lines.*", "LINES_INVALID"), #("amountMinor", "AMOUNT_INVALID")]

// ---------------------------------------------------------------------------------------------------------- input

type Line {
  Line(
    id: Option(String),
    kind: line_row.Kind,
    label: Option(String),
    amount_minor: Int,
    currency: Option(Currency),
    schedule: line_row.Schedule,
    confirmed: Option(Bool),
    assumption: Option(String),
  )
}

type Fx {
  Fx(
    from: Currency,
    to: Currency,
    rate: String,
    source: Option(String),
    date: Option(temporal.Day),
  )
}

type Fields {
  Fields(
    label: Option(String),
    term_months: Option(Int),
    lines: Option(List(Line)),
    fx: Option(List(Fx)),
  )
}

type NewScenario {
  NewScenario(fields: Fields, currency: Option(Currency))
}

type Actual {
  Actual(line_id: String, amount_minor: Int)
}

fn line_shape() -> input.Shape(Line) {
  use id <- input.field("id", input.nullish(input.id()))
  use kind <- input.field(
    "kind",
    input.required(input.one_of(line_row.kind_pairs)),
  )
  use label <- input.field("label", input.nullish(input.text(label_max)))
  use amount_minor <- input.field(
    "amountMinor",
    input.required(input.whole_number(0, safe_max)),
  )
  use currency <- input.field(
    "currency",
    input.nullish(input.one_of(currency.pairs)),
  )
  use schedule <- input.field(
    "schedule",
    input.required(input.one_of(line_row.schedule_pairs)),
  )
  use confirmed <- input.field("confirmed", input.nullish(input.boolean()))
  use assumption <- input.field(
    "conditional",
    input.nullish(
      input.object({
        use a <- input.field(
          "assumption",
          input.required(input.required_text(assumption_max)),
        )
        input.done(a)
      }),
    ),
  )
  input.done(Line(
    id:,
    kind:,
    label:,
    amount_minor:,
    currency:,
    schedule:,
    confirmed:,
    assumption:,
  ))
}

/// A stated rate is a decimal string, never a float that has already lost digits.
fn is_rate(s: String) -> Bool {
  budgets.convert_minor(0, s) |> result.is_ok
}

fn fx_shape() -> input.Shape(Fx) {
  use from <- input.field("from", input.required(input.one_of(currency.pairs)))
  use to <- input.field("to", input.required(input.one_of(currency.pairs)))
  use rate <- input.field(
    "rate",
    input.required(input.refine(
      input.text(1_000_000_000),
      is_rate,
      "must be a decimal with at most six places",
    )),
  )
  use source <- input.field("source", input.nullish(input.text(source_max)))
  use date <- input.field("date", input.nullish(input.date_only()))
  input.done(Fx(from:, to:, rate:, source:, date:))
}

fn fields_shape(next: fn(Fields) -> input.Shape(a)) -> input.Shape(a) {
  use label <- input.field("label", input.nullish(input.text(label_max)))
  use term_months <- input.field(
    "termMonths",
    input.nullish(input.whole_number(1, term_months_max)),
  )
  use lines <- input.field(
    "lines",
    input.nullish(input.items_between(input.object(line_shape()), 0, lines_max)),
  )
  use fx <- input.field(
    "fxAssumptions",
    input.nullish(input.items_between(input.object(fx_shape()), 0, fx_max)),
  )
  next(Fields(label:, term_months:, lines:, fx:))
}

fn new_shape() -> input.Shape(NewScenario) {
  use fields <- fields_shape
  use currency <- input.field(
    "currency",
    input.nullish(input.one_of(currency.pairs)),
  )
  input.done(NewScenario(fields:, currency:))
}

fn edit_shape() -> input.Shape(Fields) {
  use fields <- fields_shape
  input.done(fields)
}

fn actual_shape() -> input.Shape(Actual) {
  use line_id <- input.field("lineId", input.required(input.id()))
  use amount_minor <- input.field(
    "amountMinor",
    input.required(input.whole_number(safe_min, safe_max)),
  )
  input.done(Actual(line_id:, amount_minor:))
}

/// Text as stored: trimmed, and absent when nothing is left.
fn trimmed(s: Option(String)) -> Option(String) {
  case option.map(s, string.trim) {
    Some("") -> None
    other -> other
  }
}

// ---------------------------------------------------------------------------------------------------------- guards

fn storage(r: Result(a, Fail(e))) -> Result(a, Fail(Response)) {
  case r {
    Ok(a) -> Ok(a)
    Error(store.Storage(e)) -> Error(store.Storage(e))
    Error(store.Stale(what)) -> Error(store.Stale(what))
    Error(store.Refuse(_)) -> panic as "a read refused"
  }
}

/// The case, if the member may open it and see its deal amounts.
fn case_for(
  read: Read,
  a: OrgAccess,
  case_id: String,
) -> Result(case_row.Row, Fail(Response)) {
  use c <- result.try(case_workspace.find(read, a, case_id))
  case roles.is_finance_role(a.user.role) {
    True -> Ok(c)
    False ->
      store.refuse(http.error_message(
        403,
        "FINANCE_ROLE_REQUIRED",
        "Deal amounts are visible to leads and finance roles only.",
      ))
  }
}

fn scenario_of(
  read: Read,
  c: case_row.Row,
  scenario_id: String,
) -> Result(Scenario, Fail(Response)) {
  use found <- result.try(
    budgets.by_id(read, c.id, id.budget_scenario(scenario_id)) |> storage,
  )
  case found {
    Some(s) -> Ok(s)
    None -> store.refuse(http.error(404, "SCENARIO_NOT_FOUND"))
  }
}

fn body_or_refuse(body: Result(a, Response)) -> Result(a, Fail(Response)) {
  case body {
    Ok(b) -> Ok(b)
    Error(refused) -> store.refuse(refused)
  }
}

fn answer(r: Result(Response, store.UnitError(Response))) -> Response {
  case r {
    Ok(resp) -> resp
    Error(store.Refused(resp)) -> resp
    Error(store.Lost(what)) -> http.stale(what)
    Error(e) -> http.internal(e)
  }
}

/// One history entry on the case, by this member.
fn record(
  tx: Tx,
  a: OrgAccess,
  c: case_row.Row,
  action: String,
  detail: List(#(String, Json)),
  now: Int,
) -> Result(Nil, Fail(Response)) {
  cases.record(
    tx,
    c.id,
    cases.By(
      history_row.OrgUser,
      Some(id.org_user_to_string(a.user.id)),
      Some(a.user.name),
    ),
    [cases.entry(action, detail)],
    now,
  )
}

fn reread(
  tx: Tx,
  c: case_row.Row,
  scenario_id: id.BudgetScenarioId,
) -> Result(Scenario, Fail(Response)) {
  use found <- result.try(
    budgets.by_id(store.reading(tx), c.id, scenario_id) |> storage,
  )
  case found {
    Some(s) -> Ok(s)
    None -> panic as "a scenario just written is gone"
  }
}

// ---------------------------------------------------------------------------------------------------------- writes

fn insert_lines(
  tx: Tx,
  c: case_row.Row,
  scenario_id: id.BudgetScenarioId,
  lines: List(#(id.BudgetLineId, Line)),
) -> Result(Nil, Fail(e)) {
  list.index_map(lines, fn(pair, i) { #(i, pair) })
  |> list.try_each(fn(entry) {
    let #(position, #(line_id, l)) = entry
    line_row.insert(
      tx,
      line_row.Row(
        ..line_row.new(
          case_id: c.id,
          scenario_id:,
          position:,
          id: line_id,
          kind: l.kind,
          label: option.unwrap(
            trimmed(l.label),
            line_row.kind_to_string(l.kind),
          ),
          amount_minor: l.amount_minor,
          currency: option.unwrap(l.currency, currency.GBP),
          schedule: l.schedule,
          confirmed: l.confirmed == Some(True),
        ),
        conditional_assumption: option.map(l.assumption, string.trim),
      ),
    )
  })
}

/// Stated rates as stored: a manual entry, dated today when no day is given.
fn insert_fx(
  tx: Tx,
  c: case_row.Row,
  scenario_id: id.BudgetScenarioId,
  fx: List(Fx),
  now: Int,
) -> Result(Nil, Fail(e)) {
  list.index_map(fx, fn(a, i) { #(i, a) })
  |> list.try_each(fn(entry) {
    let #(position, a) = entry
    fx_row.insert(
      tx,
      fx_row.Row(
        ..fx_row.new(
          case_id: c.id,
          scenario_id:,
          position:,
          from_currency: a.from,
          to_currency: a.to,
          rate: a.rate,
          date: a.date
            |> option.unwrap(temporal.day_of(now))
            |> temporal.day_text,
          manual: True,
        ),
        source: Some(option.unwrap(trimmed(a.source), "manual entry")),
      ),
    )
  })
}

fn line_id(i: Int) -> id.BudgetLineId {
  id.budget_line("ln-" <> int.to_string(i + 1))
}

// ---------------------------------------------------------------------------------------------------------- routes

/// `GET /org/cases/:id/budget`: the case's scenarios, each with its totals.
pub fn get(ctx: Ctx, a: OrgAccess, case_id: String) -> Response {
  let read =
    store.read(ctx.store, fn(read) {
      use c <- result.try(case_for(read, a, case_id))
      use scenarios <- result.map(budgets.of_case(read, c.id) |> storage)
      http.json(
        200,
        json.object([
          #("scenarios", json.array(scenarios, budgets.with_totals_json)),
          #(
            "note",
            json.string(
              "Amounts are integer minor units (pence/cents). Mixed currencies combine only under explicitly stated manual rates.",
            ),
          ),
        ]),
      )
    })
  case read {
    Ok(resp) -> resp
    Error(store.Refuse(resp)) -> resp
    Error(e) -> http.internal(e)
  }
}

/// `POST /org/cases/:id/budget/scenarios`: a new scenario, at most eight a case.
pub fn create(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  case_id: String,
) -> Response {
  let body = http.parse_body(req, new_shape(), codes)
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use c <- result.try(case_for(read, a, case_id))
    use b <- result.try(body_or_refuse(body))
    use held <- result.try(
      store.one(
        read,
        "SELECT COUNT(*), COALESCE(MAX(position) + 1, 0) FROM case_budget_scenarios WHERE case_id = ?",
        [id.recruitment_case_sql(c.id)],
        {
          use n <- decode.field(0, decode.int)
          use next <- decode.field(1, decode.int)
          decode.success(#(n, next))
        },
      )
      |> storage,
    )
    let #(count, position) = result.unwrap(held, #(0, 0))
    use _ <- result.try(case count >= scenarios_max {
      True -> store.refuse(http.error(409, "TOO_MANY_SCENARIOS"))
      False -> Ok(Nil)
    })
    use scenario_id <- result.try(id.next_budget_scenario(tx))
    let f = b.fields
    use _ <- result.try(scenario_row.insert(
      tx,
      scenario_row.Row(
        ..scenario_row.new(
          case_id: c.id,
          position:,
          id: scenario_id,
          version: 1,
          label: option.unwrap(
            trimmed(f.label),
            "Scenario " <> int.to_string(count + 1),
          ),
          currency: option.unwrap(b.currency, currency.GBP),
          term_months: option.unwrap(f.term_months, 12),
          created_at: now,
          updated_at: now,
        ),
        created_by_name: Some(a.user.name),
      ),
    ))
    use _ <- result.try(insert_lines(
      tx,
      c,
      scenario_id,
      list.index_map(option.unwrap(f.lines, []), fn(l, i) { #(line_id(i), l) }),
    ))
    use _ <- result.try(insert_fx(
      tx,
      c,
      scenario_id,
      option.unwrap(f.fx, []),
      now,
    ))
    use _ <- result.try(record(
      tx,
      a,
      c,
      "budget_scenario_created",
      [#("scenarioId", id.budget_scenario_json(scenario_id))],
      now,
    ))
    use s <- result.map(reread(tx, c, scenario_id))
    http.json(
      201,
      json.object([
        #("scenario", budgets.scenario_json(s)),
        #("totals", budgets.totals_json(budgets.scenario_totals(s))),
        #(
          "honest",
          json.string(
            "All figures are user-entered. ScoutBox never invents market values, resale projections or “expected returns”, and a scenario is planning support — not legal or financial approval.",
          ),
        ),
      ]),
    )
  })
  |> answer
}

/// `PUT /org/cases/:id/budget/scenarios/:sid`: a new version. `lines` and `fxAssumptions` replace the lists; an
/// approval of an earlier version stays, marked superseded.
pub fn edit(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  case_id: String,
  scenario_id: String,
) -> Response {
  let body = http.parse_body(req, edit_shape(), codes)
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use c <- result.try(case_for(read, a, case_id))
    use held <- result.try(scenario_of(read, c, scenario_id))
    use f <- result.try(body_or_refuse(body))
    let lines =
      option.map(f.lines, fn(lines) {
        list.index_map(lines, fn(l, i) {
          #(option.map(l.id, id.budget_line) |> option.unwrap(line_id(i)), l)
        })
      })
    use _ <- result.try(case lines {
      Some(lines) ->
        case
          set.size(set.from_list(list.map(lines, fn(p) { p.0 })))
          != list.length(lines)
        {
          True ->
            store.refuse(http.error_message(
              400,
              "LINES_INVALID",
              "Each budget line needs its own id.",
            ))
          False -> Ok(Nil)
        }
      None -> Ok(Nil)
    })
    let sid = held.row.id
    let keys = [id.recruitment_case_sql(c.id), id.budget_scenario_sql(sid)]
    use _ <- result.try(
      store.run(
        tx,
        "UPDATE case_budget_scenarios SET label = COALESCE(?, label), term_months = COALESCE(?, term_months),"
          <> " updated_at = ?, version = version + 1,"
          <> " approval_superseded = CASE WHEN approval_at IS NULL THEN NULL ELSE 1 END"
          <> " WHERE case_id = ? AND id = ?",
        [
          sqlight.nullable(sqlight.text, trimmed(f.label)),
          sqlight.nullable(sqlight.int, f.term_months),
          sqlight.int(now),
          ..keys
        ],
      ),
    )
    use _ <- result.try(case lines {
      Some(lines) -> {
        use _ <- result.try(store.run(
          tx,
          "DELETE FROM case_budget_lines WHERE case_id = ? AND scenario_id = ?",
          keys,
        ))
        insert_lines(tx, c, sid, lines)
      }
      None -> Ok(Nil)
    })
    use _ <- result.try(case f.fx {
      Some(fx) -> {
        use _ <- result.try(store.run(
          tx,
          "DELETE FROM case_budget_fx_assumptions WHERE case_id = ? AND scenario_id = ?",
          keys,
        ))
        insert_fx(tx, c, sid, fx, now)
      }
      None -> Ok(Nil)
    })
    use _ <- result.try(record(
      tx,
      a,
      c,
      "budget_scenario_edited",
      [
        #("scenarioId", id.budget_scenario_json(sid)),
        #("version", json.int(held.row.version + 1)),
      ],
      now,
    ))
    use s <- result.map(reread(tx, c, sid))
    http.json(
      200,
      json.object([
        #("scenario", budgets.scenario_json(s)),
        #("totals", budgets.totals_json(budgets.scenario_totals(s))),
      ]),
    )
  })
  |> answer
}

/// `POST /org/cases/:id/budget/scenarios/:sid/approve`: a lead's approval of the scenario's current version.
pub fn approve(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  case_id: String,
  scenario_id: String,
) -> Response {
  let body = http.parse_body(req, input.nothing(), [])
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use c <- result.try(case_for(read, a, case_id))
    use _ <- result.try(case access.is_lead(a.user) {
      True -> Ok(Nil)
      False -> store.refuse(access.lead_required())
    })
    use held <- result.try(scenario_of(read, c, scenario_id))
    use _ <- result.try(body_or_refuse(body))
    let sid = held.row.id
    use _ <- result.try(
      store.run(
        tx,
        "UPDATE case_budget_scenarios SET approval_by_name = ?, approval_by_user_id = ?, approval_at = ?,"
          <> " approval_superseded = 0, approval_version = version WHERE case_id = ? AND id = ?",
        [
          sqlight.text(a.user.name),
          id.org_user_sql(a.user.id),
          sqlight.int(now),
          id.recruitment_case_sql(c.id),
          id.budget_scenario_sql(sid),
        ],
      ),
    )
    use _ <- result.try(record(
      tx,
      a,
      c,
      "budget_scenario_approved",
      [
        #("scenarioId", id.budget_scenario_json(sid)),
        #("version", json.int(held.row.version)),
      ],
      now,
    ))
    use s <- result.map(reread(tx, c, sid))
    http.json(
      200,
      json.object([
        #("scenario", budgets.scenario_json(s)),
        #(
          "note",
          json.string(
            "Internal planning approval by a named lead for THIS version. It is not legal, regulatory or financial-services approval.",
          ),
        ),
      ]),
    )
  })
  |> answer
}

/// `POST /org/cases/:id/budget/scenarios/:sid/actuals`: what was actually paid against one of its lines.
pub fn record_actual(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  case_id: String,
  scenario_id: String,
) -> Response {
  let body = http.parse_body(req, actual_shape(), codes)
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use c <- result.try(case_for(read, a, case_id))
    use held <- result.try(scenario_of(read, c, scenario_id))
    use b <- result.try(body_or_refuse(body))
    let line = id.budget_line(b.line_id)
    use _ <- result.try(case list.any(held.lines, fn(l) { l.id == line }) {
      True -> Ok(Nil)
      False -> store.refuse(http.error(404, "LINE_NOT_FOUND"))
    })
    let sid = held.row.id
    use actual_id <- result.try(id.next_budget_actual(tx))
    use _ <- result.try(actual_row.insert(
      tx,
      actual_row.Row(
        ..actual_row.new(
          case_id: c.id,
          scenario_id: sid,
          position: list.length(held.actuals),
          id: actual_id,
          line_id: line,
          amount_minor: b.amount_minor,
          at: now,
        ),
        recorded_by_name: Some(a.user.name),
      ),
    ))
    use s <- result.map(reread(tx, c, sid))
    http.json(
      200,
      json.object([#("actuals", json.array(s.actuals, budgets.actual_json))]),
    )
  })
  |> answer
}
