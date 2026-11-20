//// Coverage planning (domains/insight/coverage.mjs): a club's own fixtures, plans with a goal of observations over a
//// window, and scouts assigned to fixtures. A club can also observe every friendly on the board and every open day,
//// read as one union with its own fixtures: nothing is scraped, nothing copied into new rows. Travel times are never
//// invented, and suggestions only ever name players the club can see.

import gleam/dynamic/decode
import gleam/float
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/players
import scoutbox/identity/staff
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/distance
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/pages
import scoutbox/platform/paging.{IntKey, IntKind, TextKey, TextKind}
import scoutbox/platform/sql
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/platform/temporal
import scoutbox/rows/coverage_assignment_targets as target_row
import scoutbox/rows/coverage_assignment_warnings as warning_row
import scoutbox/rows/coverage_assignments as row
import scoutbox/rows/coverage_plans as plan_row
import scoutbox/rows/fixtures as fixture_row
import scoutbox/rows/id
import scoutbox/vocab/audience
import scoutbox/vocab/currency
import sqlight
import wisp.{type Request, type Response}

const id_max = 80

const team_max = 80

const competition_max = 80

const city_max = 60

const label_max = 100

const region_max = 80

const fixture_label_max = 200

const targets_max = 200

const goal_min = 1

const goal_max = 200

const window_min = 7

const window_max = 365

const plan_label = "Coverage plan"

const plan_goal = 5

const plan_window = 60

const nearby_km = 30.0

const suggestions_max = 10

const day_ms = 86_400_000

/// The largest whole number JavaScript holds exactly (`Number.MAX_SAFE_INTEGER`).
const max_safe = 9_007_199_254_740_991

const travel_note =
  "Travel time/route estimates unavailable — no routing provider is configured. The budget figure is user-entered, not a confirmed cost."

fn answer(r: Result(Response, store.UnitError(Response))) -> Response {
  case r {
    Ok(response) -> response
    Error(store.Refused(response)) -> response
    Error(store.Lost(what)) -> http.stale(what)
    Error(e) -> http.internal(e)
  }
}

fn field_invalid(field: String, message: String) -> Response {
  http.json(
    400,
    json.object([
      #("error", json.string("FIELD_INVALID")),
      #("field", json.string(field)),
      #("message", json.string(message)),
    ]),
  )
}

/// A coordinate as JavaScript writes it: a whole number has no decimal point.
fn js_number(f: Float) -> Json {
  case float.floor(f) == f && float.absolute_value(f) <. 1.0e15 {
    True -> json.int(float.truncate(f))
    False -> json.float(f)
  }
}

fn location_json(
  lat: Option(Float),
  lng: Option(Float),
  city: Option(String),
) -> Json {
  case lat, lng {
    Some(lat), Some(lng) ->
      json.object([
        #("lat", js_number(lat)),
        #("lng", js_number(lng)),
        #("city", json.string(option.unwrap(city, ""))),
      ])
    _, _ -> json.null()
  }
}

// ------------------------------------------------------------------------------------------- what can be observed

/// A fixture the club can observe: its own, a friendly on the board, or an open day.
type Observable {
  Observable(
    kind: row.FixtureKind,
    ref: String,
    public_id: String,
    date: String,
    competition: Option(String),
    home: String,
    away: String,
    lat: Option(Float),
    lng: Option(Float),
    city: Option(String),
    org_id: Option(String),
    created_by: Option(String),
    created_at: Option(Int),
  )
}

/// The union, ordered by (date, public id). An event's location is its host club's.
fn observable_sql(org_id: id.OrgId) -> sql.Fragment {
  sql.concat([
    sql.text(
      "SELECT * FROM (SELECT 'own' AS kind, f.id AS ref, f.id AS public_id, f.fixture_date AS date, f.competition, f.home, f.away, f.lat, f.lng, f.city, f.org_id, f.created_by_name, f.created_at
        FROM fixtures f WHERE f.org_id = ",
    ),
    sql.arg(id.org_sql(org_id)),
    sql.text(
      "
      UNION ALL SELECT 'friendly_board', fr.id, 'fr-' || fr.id, fr.match_date, 'Friendly', o.name, 'open invitation', o.lat, o.lng, o.city, NULL, NULL, NULL
        FROM friendlies fr JOIN orgs o ON o.id = fr.org_id
      UNION ALL SELECT 'open_trial', t.id, 'tr-' || t.id, t.trial_date, 'Open trial', o.name, '—', o.lat, o.lng, o.city, NULL, NULL, NULL
        FROM open_trials t JOIN orgs o ON o.id = t.org_id WHERE t.deleted_at IS NULL) ",
    ),
  ])
}

fn observable_decoder() -> decode.Decoder(Observable) {
  use kind <- decode.field(0, row.fixture_kind_decoder())
  use ref <- decode.field(1, decode.string)
  use public_id <- decode.field(2, decode.string)
  use date <- decode.field(3, decode.string)
  use competition <- decode.field(4, decode.optional(decode.string))
  use home <- decode.field(5, decode.string)
  use away <- decode.field(6, decode.string)
  use lat <- decode.field(7, decode.optional(sqlight_number()))
  use lng <- decode.field(8, decode.optional(sqlight_number()))
  use city <- decode.field(9, decode.optional(decode.string))
  use org_id <- decode.field(10, decode.optional(decode.string))
  use created_by <- decode.field(11, decode.optional(decode.string))
  use created_at <- decode.field(12, decode.optional(decode.int))
  decode.success(Observable(
    kind:,
    ref:,
    public_id:,
    date:,
    competition:,
    home:,
    away:,
    lat:,
    lng:,
    city:,
    org_id:,
    created_by:,
    created_at:,
  ))
}

/// A REAL column, which SQLite hands back as an integer when the value is whole.
fn sqlight_number() -> decode.Decoder(Float) {
  decode.one_of(decode.float, [decode.int |> decode.map(int.to_float)])
}

fn observable(
  read: Read,
  org_id: id.OrgId,
  where: sql.Fragment,
) -> Result(List(Observable), Fail(e)) {
  let query =
    sql.concat([
      observable_sql(org_id),
      where,
    ])
  store.query(read, query.sql, query.args, observable_decoder())
}

fn observable_json(o: Observable) -> Json {
  case o.kind {
    row.Own ->
      json.object([
        #("id", json.string(o.public_id)),
        #("orgId", json.nullable(o.org_id, json.string)),
        #("source", json.string("own")),
        #("competition", json.nullable(o.competition, json.string)),
        #("home", json.string(o.home)),
        #("away", json.string(o.away)),
        #("date", json.string(o.date)),
        #("location", location_json(o.lat, o.lng, o.city)),
        #("createdBy", json.nullable(o.created_by, json.string)),
        #("createdAt", json.nullable(o.created_at, json.int)),
      ])
    kind ->
      json.object([
        #("id", json.string(o.public_id)),
        #("source", row.fixture_kind_to_json(kind)),
        #("competition", json.nullable(o.competition, json.string)),
        #("home", json.string(o.home)),
        #("away", json.string(o.away)),
        #("date", json.string(o.date)),
        #("location", location_json(o.lat, o.lng, o.city)),
      ])
  }
}

// ---------------------------------------------------------------------------------------------------- fixtures

type FixtureBody {
  FixtureBody(
    home: Option(String),
    away: Option(String),
    date: Option(temporal.Day),
    competition: Option(String),
    lat: Option(Float),
    lng: Option(Float),
    city: Option(String),
  )
}

fn fixture_shape() -> input.Shape(FixtureBody) {
  use home <- input.field("home", input.nullish(input.text(team_max)))
  use away <- input.field("away", input.nullish(input.text(team_max)))
  use date <- input.field("date", input.nullish(input.date_only()))
  use competition <- input.field(
    "competition",
    input.nullish(input.text(competition_max)),
  )
  use lat <- input.field("lat", input.nullish(input.number(-90, 90)))
  use lng <- input.field("lng", input.nullish(input.number(-180, 180)))
  use city <- input.field("city", input.nullish(input.text(city_max)))
  input.done(FixtureBody(home:, away:, date:, competition:, lat:, lng:, city:))
}

fn fixture_json(f: fixture_row.Row) -> Json {
  json.object([
    #("id", id.fixture_json(f.id)),
    #("orgId", id.org_json(f.org_id)),
    #("source", json.string("own")),
    #("competition", json.nullable(f.competition, json.string)),
    #("home", json.string(f.home)),
    #("away", json.string(f.away)),
    #("date", json.string(f.fixture_date)),
    #("location", location_json(f.lat, f.lng, f.city)),
    #("createdBy", json.nullable(f.created_by_name, json.string)),
    #("createdAt", json.int(f.created_at)),
  ])
}

/// `POST /org/coverage/fixtures`.
pub fn create_fixture(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use b <- http.body(req, fixture_shape(), [])
  let home = input.filled(b.home)
  let away = input.filled(b.away)
  case home, away, b.date {
    Some(home), Some(away), Some(date) ->
      case b.lat, b.lng, b.city {
        Some(_), None, _ | None, Some(_), _ ->
          field_invalid(
            case b.lat {
              None -> "lat"
              Some(_) -> "lng"
            },
            "A location needs both lat (−90 to 90) and lng (−180 to 180) as numbers.",
          )
        None, None, Some(_) ->
          field_invalid(
            "city",
            "city is recorded with a location (lat and lng).",
          )
        _, _, _ -> {
          let located = option.is_some(b.lat)
          let now = clock.now_ms()
          let created =
            store.unit(ctx.store, fn(tx) {
              use fixture_id <- result.try(id.next_fixture(tx))
              let f =
                fixture_row.Row(
                  ..fixture_row.new(
                    id: fixture_id,
                    org_id: a.org.id,
                    home:,
                    away:,
                    fixture_date: temporal.day_text(date),
                    created_at: now,
                  ),
                  competition: input.filled(b.competition),
                  lat: b.lat,
                  lng: b.lng,
                  city: case located {
                    True -> Some(trim(option.unwrap(b.city, "")))
                    False -> None
                  },
                  created_by_name: Some(a.user.name),
                )
              fixture_row.insert(tx, f) |> result.replace(f)
            })
          case created {
            Ok(f) ->
              http.json(201, json.object([#("fixture", fixture_json(f))]))
            Error(e) -> http.internal(e)
          }
        }
      }
    _, _, _ ->
      http.error_message(
        400,
        "FIXTURE_FIELDS",
        "home, away and date are required.",
      )
  }
}

fn trim(s: String) -> String {
  input.filled(Some(s)) |> option.unwrap("")
}

/// `GET /org/coverage/fixtures`: the club's own fixtures and the events it can see, by date then id.
pub fn list_fixtures(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use page <- pages.strict(req, [TextKind, TextKind])
  let after = case page.after {
    Some([TextKey(d), TextKey(p)]) ->
      sql.concat([
        sql.text("WHERE date > "),
        sql.arg(sqlight.text(d)),
        sql.text(" OR (date = "),
        sql.arg(sqlight.text(d)),
        sql.text(" AND public_id > "),
        sql.arg(sqlight.text(p)),
        sql.text(") "),
      ])
    _ -> sql.text("")
  }
  let found =
    store.read(ctx.store, observable(
      _,
      a.org.id,
      sql.concat([
        after,
        sql.text("ORDER BY date, public_id LIMIT "),
        sql.arg(sqlight.int(page.limit + 1)),
      ]),
    ))
  case found {
    Error(e) -> http.internal(e)
    Ok(rows) -> {
      let #(items, next) =
        paging.page_of(rows, page.limit, fn(o) {
          [TextKey(o.date), TextKey(o.public_id)]
        })
      pages.respond(items, next, observable_json)
    }
  }
}

// ------------------------------------------------------------------------------------------------------- plans

type PlanBody {
  PlanBody(
    label: Option(String),
    competition: Option(String),
    region: Option(String),
    goal: Option(Int),
    window: Option(Int),
  )
}

fn plan_shape() -> input.Shape(PlanBody) {
  use label <- input.field("label", input.nullish(input.text(label_max)))
  use competition <- input.field(
    "competition",
    input.nullish(input.text(competition_max)),
  )
  use region <- input.field("region", input.nullish(input.text(region_max)))
  use goal <- input.field(
    "goalObservations",
    input.nullish(input.whole_number(goal_min, goal_max)),
  )
  use window <- input.field(
    "windowDays",
    input.nullish(input.whole_number(window_min, window_max)),
  )
  input.done(PlanBody(label:, competition:, region:, goal:, window:))
}

fn plan_fields(p: plan_row.Row) -> List(#(String, Json)) {
  [
    #("id", id.coverage_plan_json(p.id)),
    #("orgId", id.org_json(p.org_id)),
    #("label", json.string(p.label)),
    #("competition", json.nullable(p.competition, json.string)),
    #("region", json.nullable(p.region, json.string)),
    #("goalObservations", json.int(p.goal_observations)),
    #("windowDays", json.int(p.window_days)),
    #("createdBy", json.nullable(p.created_by_name, json.string)),
    #("createdAt", json.int(p.created_at)),
  ]
}

/// `POST /org/coverage-plans`: lead-only.
pub fn create_plan(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use <- access.require_lead(a)
  use b <- http.body(req, plan_shape(), [])
  let now = clock.now_ms()
  let created =
    store.unit(ctx.store, fn(tx) {
      use plan_id <- result.try(id.next_coverage_plan(tx))
      let p =
        plan_row.Row(
          ..plan_row.new(
            id: plan_id,
            org_id: a.org.id,
            label: input.filled(b.label) |> option.unwrap(plan_label),
            goal_observations: option.unwrap(b.goal, plan_goal),
            window_days: option.unwrap(b.window, plan_window),
            created_at: now,
          ),
          competition: input.filled(b.competition),
          region: input.filled(b.region),
          created_by_name: Some(a.user.name),
        )
      plan_row.insert(tx, p) |> result.replace(p)
    })
  case created {
    Ok(p) ->
      http.json(201, json.object([#("plan", json.object(plan_fields(p)))]))
    Error(e) -> http.internal(e)
  }
}

/// `GET /org/coverage-plans`: not paged, as a club keeps a handful. Progress counts the observations completed in
/// the plan's window, of its competition when it names one.
pub fn list_plans(ctx: Ctx, a: OrgAccess) -> Response {
  let now = clock.now_ms()
  let found =
    store.read(ctx.store, fn(read) {
      store.query(
        read,
        "SELECT "
          <> plan_row.qualified("p")
          <> ", (SELECT COUNT(*) FROM coverage_assignments c WHERE c.org_id = p.org_id AND c.observed_at IS NOT NULL
              AND c.observed_at >= ? - p.window_days * ? AND (p.competition IS NULL OR c.fixture_competition = p.competition))
         FROM coverage_plans p WHERE p.org_id = ? ORDER BY p.rowid",
        [sqlight.int(now), sqlight.int(day_ms), id.org_sql(a.org.id)],
        {
          use p <- decode.then(plan_row.decoder())
          use done <- decode.field(plan_row.width, decode.int)
          decode.success(#(p, done))
        },
      )
    })
  case found {
    Error(e) -> http.internal(e)
    Ok(plans) ->
      http.json(
        200,
        json.object([
          #(
            "items",
            json.array(plans, fn(x) {
              let #(p, done) = x
              json.object(
                list.append(plan_fields(p), [
                  #(
                    "progress",
                    json.object([
                      #("done", json.int(done)),
                      #("goal", json.int(p.goal_observations)),
                      #("complete", json.bool(done >= p.goal_observations)),
                    ]),
                  ),
                ]),
              )
            }),
          ),
        ]),
      )
  }
}

// ------------------------------------------------------------------------------------------------- assignments

type Assignment {
  Assignment(
    row: row.Row,
    targets: List(id.PlayerId),
    warnings: List(warning_row.Row),
  )
}

fn public_fixture_id(r: row.Row) -> String {
  case r.fixture_kind, r.fixture_id, r.friendly_id, r.open_trial_id {
    row.Own, Some(f), _, _ -> id.fixture_to_string(f)
    row.FriendlyBoard, _, Some(f), _ -> "fr-" <> id.friendly_to_string(f)
    row.OpenTrial, _, _, Some(t) -> "tr-" <> id.open_trial_to_string(t)
    _, _, _, _ -> panic as "an assignment's fixture key matches its kind"
  }
}

fn assemble(read: Read, r: row.Row) -> Result(Assignment, Fail(e)) {
  let aid = [id.coverage_assignment_sql(r.id)]
  use targets <- result.try(store.query(
    read,
    "SELECT player_id FROM coverage_assignment_targets WHERE assignment_id = ? ORDER BY ord",
    aid,
    decode.at([0], id.player_decoder()),
  ))
  use warnings <- result.map(store.query(
    read,
    "SELECT "
      <> warning_row.columns
      <> " FROM coverage_assignment_warnings WHERE assignment_id = ? ORDER BY ord",
    aid,
    warning_row.decoder(),
  ))
  Assignment(r, targets, warnings)
}

fn by_id(
  read: Read,
  org_id: id.OrgId,
  assignment_id: id.CoverageAssignmentId,
) -> Result(Option(Assignment), Fail(e)) {
  use found <- result.try(store.one(
    read,
    "SELECT "
      <> row.columns
      <> " FROM coverage_assignments WHERE id = ? AND org_id = ?",
    [id.coverage_assignment_sql(assignment_id), id.org_sql(org_id)],
    row.decoder(),
  ))
  case found {
    Ok(r) -> assemble(read, r) |> result.map(Some)
    Error(Nil) -> Ok(None)
  }
}

fn warning_text(w: warning_row.Row, r: row.Row) -> String {
  case w.code {
    warning_row.DuplicateVisit ->
      "Duplicate visit: "
      <> option.unwrap(w.scout_name, "a scout")
      <> " is already assigned to this fixture."
    warning_row.ScoutClash ->
      "Conflict: "
      <> option.unwrap(w.scout_name, "the scout")
      <> " already has an assignment on "
      <> r.fixture_date
      <> "."
  }
}

fn warnings_json(a: Assignment) -> Json {
  json.array(a.warnings, fn(w) { json.string(warning_text(w, a.row)) })
}

fn assignment_json(a: Assignment) -> Json {
  let r = a.row
  json.object([
    #("id", id.coverage_assignment_json(r.id)),
    #("orgId", id.org_json(r.org_id)),
    #("fixtureId", json.string(public_fixture_id(r))),
    #("fixtureDate", json.string(r.fixture_date)),
    #("fixtureLabel", json.string(r.fixture_label)),
    #("fixtureCompetition", json.nullable(r.fixture_competition, json.string)),
    #("scoutUserId", id.org_user_json(r.scout_user_id)),
    #("scoutName", json.nullable(r.scout_name, json.string)),
    #("targetPlayerIds", json.array(a.targets, id.player_json)),
    #("travelBudget", case r.travel_budget_minor, r.travel_currency {
      Some(amount), Some(c) ->
        json.object([
          #("amountMinor", json.int(amount)),
          #("currency", currency.to_json(c)),
          #("enteredBy", json.nullable(r.travel_entered_by_name, json.string)),
        ])
      _, _ -> json.null()
    }),
    #("travelNote", json.string(travel_note)),
    #("warnings", warnings_json(a)),
    #("assignedBy", json.nullable(r.assigned_by_name, json.string)),
    #("createdAt", json.int(r.created_at)),
    #("observedAt", json.nullable(r.observed_at, json.int)),
    #("assessmentIds", case r.assessment_id {
      Some(x) -> json.preprocessed_array([id.assessment_json(x)])
      None -> json.preprocessed_array([])
    }),
    #("cancelledAt", json.nullable(r.cancelled_at, json.int)),
  ])
}

type AssignmentBody {
  AssignmentBody(
    fixture_id: Option(String),
    scout_user_id: Option(String),
    targets: Option(List(String)),
    budget: Option(Float),
    currency: Option(currency.Currency),
  )
}

fn assignment_shape() -> input.Shape(AssignmentBody) {
  use fixture_id <- input.field("fixtureId", input.nullish(input.text(id_max)))
  use scout_user_id <- input.field(
    "scoutUserId",
    input.nullish(input.text(id_max)),
  )
  use targets <- input.field(
    "targetPlayerIds",
    input.nullish(input.ids_once(targets_max, "player")),
  )
  // Judged after the shape, under AMOUNT_INVALID.
  use budget <- input.field(
    "travelBudgetMinor",
    input.nullish(input.number(-max_safe, max_safe)),
  )
  use currency <- input.field(
    "travelCurrency",
    input.nullish(input.one_of(currency.pairs)),
  )
  input.done(AssignmentBody(
    fixture_id:,
    scout_user_id:,
    targets:,
    budget:,
    currency:,
  ))
}

fn active_staff(
  read: Read,
  org_id: id.OrgId,
  user_id: id.OrgUserId,
) -> Result(Option(staff.Staff), Fail(e)) {
  use found <- result.map(staff.by_id(read, user_id))
  case found {
    Some(u) if u.org_id == org_id && u.removed_at == None -> Some(u)
    _ -> None
  }
}

/// The SQL that names a fixture of `kind` with key `ref` among an organisation's assignments.
fn fixture_cond(o: Observable) -> List(sqlight.Value) {
  [
    sqlight.text(row.fixture_kind_to_string(o.kind)),
    sqlight.text(o.ref),
  ]
}

fn refuse_unless(
  ok: Bool,
  otherwise: Response,
  next: fn() -> Result(Response, Fail(Response)),
) -> Result(Response, Fail(Response)) {
  case ok {
    True -> next()
    False -> store.refuse(otherwise)
  }
}

/// `POST /org/coverage/assignments`: lead-only. A target the club cannot see is dropped, never refused, so the
/// answer never says who is hidden.
pub fn create_assignment(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use <- access.require_lead(a)
  use b <- http.body(req, assignment_shape(), [
    #("travelBudgetMinor", "AMOUNT_INVALID"),
  ])
  let now = clock.now_ms()
  answer(
    store.unit(ctx.store, fn(tx) {
      let read = store.reading(tx)
      use fixture <- result.try(case b.fixture_id {
        Some(public_id) ->
          observable(
            read,
            a.org.id,
            sql.concat([
              sql.text("WHERE public_id = "),
              sql.arg(sqlight.text(public_id)),
              sql.text(" LIMIT 1"),
            ]),
          )
          |> result.map(list.first)
        None -> Ok(Error(Nil))
      })
      use fixture <- result.try(
        fixture
        |> result.replace_error(
          store.Refuse(http.error(404, "FIXTURE_NOT_FOUND")),
        ),
      )
      use scout <- result.try(case b.scout_user_id {
        Some(u) -> active_staff(read, a.org.id, id.org_user(u))
        None -> Ok(None)
      })
      use scout <- result.try(option.to_result(
        scout,
        store.Refuse(http.error(404, "SCOUT_NOT_FOUND")),
      ))
      use budget <- result.try(case b.budget, b.currency {
        Some(amount), _ ->
          case float.floor(amount) == amount && amount >=. 0.0 {
            True ->
              Ok(
                Some(#(
                  float.truncate(amount),
                  option.unwrap(b.currency, currency.GBP),
                )),
              )
            False ->
              store.refuse(http.json(
                400,
                json.object([
                  #("error", json.string("AMOUNT_INVALID")),
                  #("field", json.string("travelBudgetMinor")),
                  #(
                    "message",
                    json.string(
                      "travelBudgetMinor must be a non-negative whole number of minor units (pence/cents).",
                    ),
                  ),
                ]),
              ))
          }
        None, Some(_) ->
          store.refuse(field_invalid(
            "travelCurrency",
            "travelCurrency goes with travelBudgetMinor.",
          ))
        None, None -> Ok(None)
      })
      use seen <- result.try(players.for_org_many(
        read,
        list.map(option.unwrap(b.targets, []), id.player),
        a.org,
        now,
      ))
      let targets =
        list.filter_map(seen, fn(f) {
          let #(p, access) = f
          case access.visible && !access.blocked {
            True -> Ok(p.row.id)
            False -> Error(Nil)
          }
        })
      use dup <- result.try(store.one(
        read,
        "SELECT scout_user_id FROM coverage_assignments WHERE org_id = ? AND fixture_kind = ?
           AND COALESCE(fixture_id, friendly_id, open_trial_id) = ? AND cancelled_at IS NULL ORDER BY rowid LIMIT 1",
        [id.org_sql(a.org.id), ..fixture_cond(fixture)],
        decode.at([0], id.org_user_decoder()),
      ))
      use dup <- result.try(case dup {
        Ok(u) -> {
          use who <- result.map(staff.by_id(read, u))
          Some(option.map(who, fn(w) { w.name }))
        }
        Error(Nil) -> Ok(None)
      })
      use busy <- result.try(store.one(
        read,
        "SELECT 1 FROM coverage_assignments WHERE org_id = ? AND scout_user_id = ? AND fixture_date = ? AND cancelled_at IS NULL",
        [
          id.org_sql(a.org.id),
          id.org_user_sql(scout.id),
          sqlight.text(fixture.date),
        ],
        decode.success(Nil),
      ))
      let warnings =
        option.values([
          option.map(dup, fn(name) { #(warning_row.DuplicateVisit, name) }),
          case busy {
            Ok(Nil) -> Some(#(warning_row.ScoutClash, Some(scout.name)))
            Error(Nil) -> None
          },
        ])
      use assignment_id <- result.try(id.next_coverage_assignment(tx))
      let label =
        input.utf16_take(
          fixture.home <> " v " <> fixture.away,
          fixture_label_max,
        )
      let r =
        row.Row(
          ..row.new(
            id: assignment_id,
            org_id: a.org.id,
            fixture_kind: fixture.kind,
            fixture_date: fixture.date,
            fixture_label: label,
            scout_user_id: scout.id,
            created_at: now,
          ),
          fixture_id: case fixture.kind {
            row.Own -> Some(id.fixture(fixture.ref))
            _ -> None
          },
          friendly_id: case fixture.kind {
            row.FriendlyBoard -> Some(id.friendly(fixture.ref))
            _ -> None
          },
          open_trial_id: case fixture.kind {
            row.OpenTrial -> Some(id.open_trial(fixture.ref))
            _ -> None
          },
          fixture_competition: option.map(fixture.competition, input.utf16_take(
            _,
            competition_max,
          )),
          scout_name: Some(scout.name),
          travel_budget_minor: option.map(budget, fn(x) { x.0 }),
          travel_currency: option.map(budget, fn(x) { x.1 }),
          travel_entered_by_name: option.map(budget, fn(_) { a.user.name }),
          assigned_by_name: Some(a.user.name),
        )
      use _ <- result.try(row.insert(tx, r))
      use _ <- result.try(
        list.index_map(targets, fn(p, i) { #(p, i) })
        |> list.try_each(fn(p) {
          target_row.insert(
            tx,
            target_row.new(assignment_id:, ord: p.1, player_id: p.0),
          )
        }),
      )
      use _ <- result.try(
        list.index_map(warnings, fn(w, i) { #(w, i) })
        |> list.try_each(fn(p) {
          let #(#(code, name), i) = p
          warning_row.insert(
            tx,
            warning_row.Row(assignment_id:, ord: i, code:, scout_name: name),
          )
        }),
      )
      let n = list.length(targets)
      use _ <- result.try(notifications.notify(
        tx,
        to: audience.OrgUser,
        id: id.org_user_to_string(scout.id),
        type_: "coverage",
        text: "🧭 New observation assignment: "
          <> label
          <> " on "
          <> fixture.date
          <> case n {
          0 -> ""
          1 -> " (1 target)"
          _ -> " (" <> int.to_string(n) <> " targets)"
        }
          <> ".",
        ref_id: Some(id.coverage_assignment_to_string(assignment_id)),
        at: now,
      ))
      use found <- result.map(by_id(read, a.org.id, assignment_id))
      let assert Some(created) = found as "the unit just wrote the assignment"
      http.json(
        201,
        json.object([
          #("assignment", assignment_json(created)),
          #("warnings", warnings_json(created)),
        ]),
      )
    }),
  )
}

/// `GET /org/coverage/assignments`: live ones, newest first; a scout sees only their own, a lead every one.
pub fn list_assignments(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use page <- pages.strict(req, [IntKind, TextKind])
  let scout = case access.is_lead(a.user) {
    True -> sqlight.null()
    False -> id.org_user_sql(a.user.id)
  }
  let #(at, after) = case page.after {
    Some([IntKey(at), TextKey(aid)]) -> #(sqlight.int(at), sqlight.text(aid))
    _ -> #(sqlight.null(), sqlight.null())
  }
  let found =
    store.read(ctx.store, fn(read) {
      use rows <- result.try(store.query(
        read,
        "SELECT "
          <> row.columns
          <> " FROM coverage_assignments WHERE org_id = ? AND cancelled_at IS NULL AND (? IS NULL OR scout_user_id = ?)
          AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?",
        [
          id.org_sql(a.org.id),
          scout,
          scout,
          at,
          at,
          at,
          after,
          sqlight.int(page.limit + 1),
        ],
        row.decoder(),
      ))
      list.try_map(rows, assemble(read, _))
    })
  case found {
    Error(e) -> http.internal(e)
    Ok(rows) -> {
      let #(items, next) =
        paging.page_of(rows, page.limit, fn(x) {
          [
            IntKey(x.row.created_at),
            TextKey(id.coverage_assignment_to_string(x.row.id)),
          ]
        })
      pages.respond(items, next, assignment_json)
    }
  }
}

fn complete_shape() -> input.Shape(Option(String)) {
  use assessment_id <- input.field("assessmentId", input.nullish(input.id()))
  input.done(assessment_id)
}

/// `POST /org/coverage/assignments/:id/complete`: the scout (or a lead) observed the fixture, once.
pub fn complete(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  assignment_id: id.CoverageAssignmentId,
) -> Response {
  let body = http.parse_body(req, complete_shape(), [])
  let now = clock.now_ms()
  answer(
    store.unit(ctx.store, fn(tx) {
      let read = store.reading(tx)
      use found <- result.try(by_id(read, a.org.id, assignment_id))
      use x <- result.try(option.to_result(
        found,
        store.Refuse(http.error(404, "ASSIGNMENT_NOT_FOUND")),
      ))
      use <- refuse_unless(
        x.row.scout_user_id == a.user.id || access.is_lead(a.user),
        http.error(403, "NOT_YOUR_ASSIGNMENT"),
      )
      use <- refuse_unless(
        x.row.observed_at == None,
        http.error(409, "ALREADY_COMPLETED"),
      )
      use assessment_id <- result.try(body |> result.map_error(store.Refuse))
      use assessment_id <- result.try(case assessment_id {
        None -> Ok(None)
        Some(aid) -> {
          use ours <- result.try(store.one(
            read,
            "SELECT 1 FROM assessments WHERE id = ? AND org_id = ?",
            [id.assessment_sql(id.assessment(aid)), id.org_sql(a.org.id)],
            decode.success(Nil),
          ))
          case ours {
            Ok(Nil) -> Ok(Some(id.assessment(aid)))
            Error(Nil) ->
              store.refuse(field_invalid(
                "assessmentId",
                "assessmentId must name one of your organisation’s assessments.",
              ))
          }
        }
      })
      use _ <- result.try(
        store.run(
          tx,
          "UPDATE coverage_assignments SET observed_at = ?, assessment_id = ? WHERE id = ?",
          [
            sqlight.int(now),
            sqlight.nullable(id.assessment_sql, assessment_id),
            id.coverage_assignment_sql(assignment_id),
          ],
        ),
      )
      respond(tx, a, assignment_id)
    }),
  )
}

fn respond(
  tx: Tx,
  a: OrgAccess,
  assignment_id: id.CoverageAssignmentId,
) -> Result(Response, Fail(e)) {
  use found <- result.map(by_id(store.reading(tx), a.org.id, assignment_id))
  let assert Some(x) = found as "the unit just read the assignment"
  http.json(200, json.object([#("assignment", assignment_json(x))]))
}

/// `POST /org/coverage/assignments/:id/cancel`: lead-only; cancelling again changes nothing.
pub fn cancel(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  assignment_id: id.CoverageAssignmentId,
) -> Response {
  use <- access.require_lead(a)
  use _ <- http.body(req, input.nothing(), [])
  let now = clock.now_ms()
  answer(
    store.unit(ctx.store, fn(tx) {
      use found <- result.try(by_id(store.reading(tx), a.org.id, assignment_id))
      use _ <- result.try(option.to_result(
        found,
        store.Refuse(http.error(404, "ASSIGNMENT_NOT_FOUND")),
      ))
      use _ <- result.try(
        store.run(
          tx,
          "UPDATE coverage_assignments SET cancelled_at = ? WHERE id = ? AND cancelled_at IS NULL",
          [sqlight.int(now), id.coverage_assignment_sql(assignment_id)],
        ),
      )
      respond(tx, a, assignment_id)
    }),
  )
}

// ------------------------------------------------------------------------------------------------- suggestions

/// `GET /org/coverage/suggestions`: upcoming located fixtures within 30 km of two or more players the club is
/// actively interested in (an open case, or its shortlist), by their declared locations. A labelled heuristic.
pub fn suggestions(ctx: Ctx, a: OrgAccess) -> Response {
  let now = clock.now_ms()
  let today = clock.iso_day(now)
  let found =
    store.read(ctx.store, fn(read) {
      use interest <- result.try(store.query(
        read,
        "SELECT player_id FROM recruitment_cases WHERE org_id = ? AND stage <> 'closed'
         UNION SELECT player_id FROM ledger WHERE org_id = ? AND type = 'shortlist' AND player_id IS NOT NULL",
        [id.org_sql(a.org.id), id.org_sql(a.org.id)],
        decode.at([0], id.player_decoder()),
      ))
      use seen <- result.try(players.for_org_many(read, interest, a.org, now))
      let candidates =
        list.filter_map(seen, fn(f) {
          let #(p, access) = f
          case access.visible && !access.blocked, p.row.lat, p.row.lng {
            True, Some(_), Some(_) -> Ok(id.player_to_string(p.row.id))
            _, _, _ -> Error(Nil)
          }
        })
      use upcoming <- result.try(observable(
        read,
        a.org.id,
        sql.concat([
          sql.text("WHERE date >= "),
          sql.arg(sqlight.text(today)),
          sql.text(" AND lat IS NOT NULL ORDER BY date, public_id"),
        ]),
      ))
      use covered <- result.try(store.query(
        read,
        "SELECT DISTINCT fixture_kind || ':' || COALESCE(fixture_id, friendly_id, open_trial_id) FROM coverage_assignments
         WHERE org_id = ? AND cancelled_at IS NULL",
        [id.org_sql(a.org.id)],
        decode.at([0], decode.string),
      ))
      use items <- result.map(
        list.try_map(upcoming, fn(f) {
          near(read, f, candidates) |> result.map(fn(n) { #(f, n) })
        }),
      )
      #(items, covered)
    })
  case found {
    Error(e) -> http.internal(e)
    Ok(#(items, covered)) -> {
      let items =
        items
        |> list.filter(fn(x) { list.length(x.1) >= 2 })
        |> list.sort(fn(x, y) {
          int.compare(list.length(y.1), list.length(x.1))
        })
        |> list.take(suggestions_max)
      http.json(
        200,
        json.object([
          #(
            "items",
            json.array(items, fn(x) {
              let #(f, nearby) = x
              json.object([
                #("fixture", observable_json(f)),
                #(
                  "alreadyCovered",
                  json.bool(list.contains(
                    covered,
                    row.fixture_kind_to_string(f.kind) <> ":" <> f.ref,
                  )),
                ),
                #("nearbyTargets", json.preprocessed_array(nearby)),
                #(
                  "rationale",
                  json.string(
                    int.to_string(list.length(nearby))
                    <> " players you track are within 30 km of this fixture's location",
                  ),
                ),
              ])
            }),
          ),
          #(
            "note",
            json.string(
              "Location-proximity heuristic over your own tracked players and visible fixtures. It does not know who will actually play, and it never includes players outside your visibility rules.",
            ),
          ),
        ]),
      )
    }
  }
}

/// The candidates within 30 km of a located fixture, in the candidates' order, as `{ id, name, position }`.
fn near(
  read: Read,
  f: Observable,
  candidates: List(String),
) -> Result(List(Json), Fail(e)) {
  case f.lat, f.lng, candidates {
    Some(lat), Some(lng), [_, ..] -> {
      let query =
        sql.concat([
          sql.text(
            "SELECT p.id, p.name, p.position FROM players p JOIN json_each(",
          ),
          sql.arg(
            sqlight.text(json.to_string(json.array(candidates, json.string))),
          ),
          sql.text(") j ON j.value = p.id WHERE "),
          distance.km(distance.At(lat, lng), distance.Columns("p.lat", "p.lng")),
          sql.text(" <= "),
          sql.arg(sqlight.float(nearby_km)),
          sql.text(" ORDER BY j.key"),
        ])
      store.query(read, query.sql, query.args, {
        use pid <- decode.field(0, decode.string)
        use name <- decode.field(1, decode.string)
        use position <- decode.field(2, decode.optional(decode.string))
        decode.success(
          json.object([
            #("id", json.string(pid)),
            #("name", json.string(name)),
            #("position", json.nullable(position, json.string)),
          ]),
        )
      })
    }
    _, _, _ -> Ok([])
  }
}
