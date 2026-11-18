//// A club's opportunities (domains/scouting/journeys.mjs, the opportunity board): publishing one, the club's own
//// list, and the eligibility the board applies (routeHelpers.mjs `checkEligibility`). The board itself is
//// `scouting/opportunity_board`; applications and closing are `scouting/opportunity_applications`.
////
//// Not ported yet: the structured requirements' route (`PUT /org/opportunities/:id/structured-requirements`) and
//// the `opportunities` live event.

import gleam/dict.{type Dict}
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/float
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/players.{type Player}
import scoutbox/platform/clock
import scoutbox/platform/distance
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/json_text
import scoutbox/platform/pages
import scoutbox/platform/paging.{IntKey, IntKind}
import scoutbox/platform/sql
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/rows/id
import scoutbox/rows/opportunities as row
import scoutbox/rows/opportunity_texts as text_row
import scoutbox/rows/opportunity_training_slots as slot_row
import scoutbox/rows/orgs as org_row
import scoutbox/rules/age
import scoutbox/safety/audit
import scoutbox/safety/moderate
import scoutbox/vocab/playing_level.{type PlayingLevel}
import scoutbox/vocab/position
import sqlight
import wisp.{type Request, type Response}

// OPPORTUNITIES_CAMPAIGNS_LIMITS (repositories/opportunitiesCampaigns.ts).
const title_max = 120

const team_max = 60

const age_group_max = 20

const role_max = 60

const description_max = 500

const schedule_max = 200

const requirement_max = 120

const requirements_max = 6

const min_age = 4

const max_age = 99

const radius_km_max = 1000

const name_max = 200

/// JavaScript's largest safe integer: `wholeNumber()`'s default bound.
const max_safe_integer = 9_007_199_254_740_991

const min_safe_integer = -9_007_199_254_740_991

/// An opportunity with its child rows.
pub type Opportunity {
  Opportunity(
    row: row.Row,
    requirements: List(String),
    environment: List(String),
    accommodations: List(String),
    slots: List(slot_row.Row),
  )
}

// ------------------------------------------------------------------------------------------------- reads

/// The opportunities of `rows`, in that order, with their child rows.
pub fn with_children(
  read: Read,
  rows: List(row.Row),
) -> Result(List(Opportunity), Fail(e)) {
  let ids =
    json.array(rows, fn(r) { id.opportunity_json(r.id) })
    |> json.to_string
    |> sqlight.text
  use texts <- result.try(store.query(
    read,
    "SELECT "
      <> text_row.columns
      <> " FROM opportunity_texts WHERE opportunity_id IN (SELECT value FROM json_each(?)) ORDER BY ordinal",
    [ids],
    text_row.decoder(),
  ))
  use slots <- result.map(store.query(
    read,
    "SELECT "
      <> slot_row.columns
      <> " FROM opportunity_training_slots WHERE opportunity_id IN (SELECT value FROM json_each(?)) ORDER BY ordinal",
    [ids],
    slot_row.decoder(),
  ))
  let texts = list.group(texts, fn(t) { t.opportunity_id })
  let slots = list.group(slots, fn(s) { s.opportunity_id })
  list.map(rows, fn(r) {
    // `list.group` prepends, so each group is in reverse of the query's order.
    let mine = dict.get(texts, r.id) |> result.unwrap([]) |> list.reverse
    let of = fn(kind) {
      list.filter(mine, fn(t) { t.kind == kind }) |> list.map(fn(t) { t.text })
    }
    Opportunity(
      row: r,
      requirements: of(text_row.Requirement),
      environment: of(text_row.Environment),
      accommodations: of(text_row.Accommodation),
      slots: dict.get(slots, r.id) |> result.unwrap([]) |> list.reverse,
    )
  })
}

/// Published opportunities whose deadline is `today` or later, soonest first (repository `openOn`), each with the
/// distance in km from its club, as the club is now, to `from`; `None` when either place is unknown.
pub fn open_on(
  read: Read,
  today: String,
  from: Option(#(Float, Float)),
) -> Result(List(#(Opportunity, Option(Float))), Fail(e)) {
  let km = case from {
    Some(#(lat, lng)) ->
      distance.km(distance.Columns("o.lat", "o.lng"), distance.At(lat, lng))
    None -> sql.text("NULL")
  }
  let q =
    sql.concat([
      sql.text("SELECT " <> row.qualified("p") <> ", "),
      km,
      sql.text(
        " FROM opportunities p JOIN orgs o ON o.id = p.org_id WHERE p.status = 'published' AND p.deadline >= ",
      ),
      sql.arg(sqlight.text(today)),
      sql.text(" ORDER BY p.deadline, p.rowid"),
    ])
  use found <- result.try(
    store.query(read, q.sql, q.args, {
      use r <- decode.then(row.decoder())
      use km <- decode.field(row.width, decode.optional(decode.float))
      decode.success(#(r, km))
    }),
  )
  use opps <- result.map(with_children(read, list.map(found, fn(f) { f.0 })))
  list.zip(opps, list.map(found, fn(f) { f.1 }))
}

/// The club's opportunities, newest first, by cursor (the key is the rowid).
fn page_for_org(
  read: Read,
  org_id: id.OrgId,
  page: paging.Page,
) -> Result(List(#(Opportunity, Int)), Fail(e)) {
  let before = case page.after {
    Some([IntKey(rowid)]) -> sqlight.int(rowid)
    _ -> sqlight.null()
  }
  use found <- result.try(
    store.query(
      read,
      "SELECT "
        <> row.columns
        <> ", rowid FROM opportunities WHERE org_id = ? AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?",
      [id.org_sql(org_id), before, before, sqlight.int(page.limit + 1)],
      {
        use r <- decode.then(row.decoder())
        use rowid <- decode.field(row.width, decode.int)
        decode.success(#(r, rowid))
      },
    ),
  )
  use opps <- result.map(with_children(read, list.map(found, fn(f) { f.0 })))
  list.zip(opps, list.map(found, fn(f) { f.1 }))
}

/// Per opportunity, its live (not withdrawn) applications and the unanswered ones (repository
/// `applicationCounts`). An opportunity nobody applied to is absent: read it as 0 and 0.
pub fn application_counts(
  read: Read,
  ids: List(id.OpportunityId),
) -> Result(Dict(id.OpportunityId, #(Int, Int)), Fail(e)) {
  use rows <- result.map(
    store.query(
      read,
      "SELECT opportunity_id, SUM(status <> 'withdrawn'), SUM(status = 'submitted') FROM applications WHERE opportunity_id IN (SELECT value FROM json_each(?)) GROUP BY opportunity_id",
      [
        json.array(ids, id.opportunity_json)
        |> json.to_string
        |> sqlight.text,
      ],
      {
        use oid <- decode.field(0, id.opportunity_decoder())
        use live <- decode.field(1, decode.int)
        use outstanding <- decode.field(2, decode.int)
        decode.success(#(oid, #(live, outstanding)))
      },
    ),
  )
  dict.from_list(rows)
}

// ------------------------------------------------------------------------------------------------- eligibility

/// Who may apply. An opportunity's always carries its category.
pub type Eligibility {
  Eligibility(
    min_age: Option(Int),
    max_age: Option(Int),
    position_group: row.EligPositionGroup,
    category: row.EligCategory,
    max_level: Option(PlayingLevel),
    radius_km: Option(Float),
  )
}

pub fn eligibility(r: row.Row) -> Eligibility {
  Eligibility(
    min_age: r.elig_min_age,
    max_age: r.elig_max_age,
    position_group: r.elig_position_group,
    category: r.elig_category,
    max_level: r.elig_max_level,
    radius_km: r.elig_radius_km,
  )
}

fn positions_of(group: row.EligPositionGroup) -> List(position.Position) {
  case group {
    row.Any -> []
    row.GK -> [position.GK]
    row.DEF -> [
      position.CB,
      position.RB,
      position.LB,
      position.RWB,
      position.LWB,
    ]
    row.MID -> [position.CDM, position.CM, position.CAM]
    row.ATT -> [position.ST, position.CF, position.RW, position.LW]
  }
}

/// Why `p` may not apply, empty when they may (routeHelpers.mjs `checkEligibility`). `km` is the distance from the
/// club to the player, `None` when either place is unknown. Missing data fails closed: an unreadable date of birth
/// fails both age bounds, and an unknown place fails a radius.
pub fn reasons(
  e: Eligibility,
  p: Player,
  km: Option(Float),
  now: Int,
) -> List(String) {
  let age = age.age_on(p.row.birth_date, now)
  let below = case e.min_age, age {
    Some(m), Some(a) if a >= m -> []
    Some(m), _ -> ["minimum age " <> int.to_string(m)]
    None, _ -> []
  }
  let above = case e.max_age, age {
    Some(m), Some(a) if a <= m -> []
    Some(m), _ -> ["maximum age " <> int.to_string(m)]
    None, _ -> []
  }
  let level = case e.max_level, p.row.level {
    Some(playing_level.SemiPro), playing_level.Pro -> ["amateur/semi-pro only"]
    _, _ -> []
  }
  let group = case e.position_group {
    row.Any -> []
    g ->
      case p.row.position {
        Some(pos) ->
          case list.contains(positions_of(g), pos) {
            True -> []
            False -> ["position group " <> row.elig_position_group_to_string(g)]
          }
        None -> ["position group " <> row.elig_position_group_to_string(g)]
      }
  }
  let category = case e.category, p.row.football_category {
    row.EligCategoryMixed, _ | _, None | _, Some("") -> []
    c, Some(theirs) ->
      case theirs == row.elig_category_to_string(c) {
        True -> []
        False -> [
          "this is a " <> row.elig_category_to_string(c) <> " team/competition",
        ]
      }
  }
  let radius = case e.radius_km, km {
    None, _ -> []
    Some(_), None -> [
      "location required (fail-closed: set your ground/home area)",
    ]
    Some(r), Some(k) if k >. r -> ["within " <> number_text(r) <> " km"]
    Some(_), Some(_) -> []
  }
  list.flatten([below, above, level, group, category, radius])
}

/// A number as JavaScript prints it in text: an integral one without a fraction.
fn number_text(f: Float) -> String {
  case float.floor(f) == f {
    True -> int.to_string(float.truncate(f))
    False -> float.to_string(f)
  }
}

/// fieldSpecs.ts `describe`.
fn describe(v: Dynamic) -> String {
  case dynamic.classify(v) {
    "Nil" | "Null" -> "null"
    "List" | "Array" -> "an array"
    "Dict" -> "an object"
    "String" -> "a string"
    "Int" | "Float" -> "a number"
    "Bool" -> "a boolean"
    _ -> "an object"
  }
}

fn is_null(v: Dynamic) -> Bool {
  case dynamic.classify(v) {
    "Nil" | "Null" -> True
    _ -> False
  }
}

/// A JSON number that is a safe integer (`16.0` is 16, as JavaScript reads it).
fn whole(v: Dynamic) -> Option(Int) {
  case decode.run(v, decode.int), decode.run(v, decode.float) {
    Ok(n), _ if n <= max_safe_integer && n >= min_safe_integer -> Some(n)
    _, Ok(f) ->
      case
        float.floor(f) == f && float.absolute_value(f) <=. 9.007199254740991e15
      {
        True -> Some(float.truncate(f))
        False -> None
      }
    _, _ -> None
  }
}

fn finite(v: Dynamic) -> Option(Float) {
  case decode.run(v, decode.int), decode.run(v, decode.float) {
    Ok(n), _ -> Some(int.to_float(n))
    _, Ok(f) -> Some(f)
    _, _ -> None
  }
}

/// A refusal of the eligibility: the field it names (`eligibility.minAge`) and its message.
type Bad {
  Bad(field: String, message: String)
}

fn bad(field: String, what: String) -> Bad {
  Bad("eligibility." <> field, "eligibility: " <> field <> " " <> what <> ".")
}

/// The eligibility sent with an opportunity, typed (journeys.mjs `eligibilityOrRefuse` and repository
/// `typeEligibility`). A Grassroots club's is forced to amateur and semi-pro players within the Grassroots radius.
/// Its category is the opportunity's: one sent inside the eligibility is taken as a field and then ignored, as the
/// TypeScript server does.
fn type_eligibility(
  raw: Option(Dynamic),
  grassroots: Bool,
  category: row.Category,
) -> Result(Eligibility, Bad) {
  use fields <- result.try(case raw {
    None -> Ok(dict.new())
    Some(v) ->
      case is_null(v) {
        True -> Ok(dict.new())
        False ->
          decode.run(v, decode.dict(decode.string, decode.dynamic))
          |> result.replace_error(Bad(
            "eligibility",
            "eligibility is an object.",
          ))
      }
  })
  let known = [
    "minAge", "maxAge", "positionGroup", "maxLevel", "radiusKm", "category",
  ]
  // The TypeScript server names the first unknown field in the order sent; a map has no order, so here it is the
  // first in key order, as `input` does.
  use <- unknown_first(
    dict.keys(fields)
    |> list.sort(string.compare)
    |> list.find(fn(k) { !list.contains(known, k) }),
  )
  // `?? null`: absent and null are both no value.
  let get = fn(k) {
    case dict.get(fields, k) {
      Ok(v) ->
        case is_null(v) {
          True -> None
          False -> Some(v)
        }
      Error(Nil) -> None
    }
  }
  let age_in = fn(k) {
    case get(k) {
      None -> Ok(None)
      Some(v) ->
        case whole(v) {
          Some(n) if n >= min_age && n <= max_age -> Ok(Some(n))
          _ ->
            Error(bad(
              k,
              "must be a whole number from "
                <> int.to_string(min_age)
                <> " to "
                <> int.to_string(max_age)
                <> " or null (got "
                <> describe(v)
                <> ")",
            ))
        }
    }
  }
  use min <- result.try(age_in("minAge"))
  use max <- result.try(age_in("maxAge"))
  use group <- result.try(case get("positionGroup") {
    None -> Ok(row.Any)
    Some(v) ->
      decode.run(v, decode.string)
      |> result.replace_error(Nil)
      |> result.try(row.elig_position_group_from_string)
      |> result.replace_error(bad(
        "positionGroup",
        "must be one of any|GK|DEF|MID|ATT (got " <> describe(v) <> ")",
      ))
  })
  use level <- result.try(case grassroots, get("maxLevel") {
    True, _ -> Ok(Some(playing_level.SemiPro))
    False, None -> Ok(None)
    False, Some(v) ->
      decode.run(v, decode.string)
      |> result.replace_error(Nil)
      |> result.try(playing_level.from_string)
      |> result.map(Some)
      |> result.replace_error(bad(
        "maxLevel",
        "must be one of amateur|semi_pro|pro or null (got "
          <> describe(v)
          <> ")",
      ))
  })
  use radius <- result.try(case grassroots, get("radiusKm") {
    True, _ -> Ok(Some(distance.grassroots_radius_km))
    False, None -> Ok(None)
    False, Some(v) ->
      case finite(v) {
        Some(km) if km >=. 0.0 && km <=. 1000.0 -> Ok(Some(km))
        _ ->
          Error(bad(
            "radiusKm",
            "must be a number from 0 to "
              <> int.to_string(radius_km_max)
              <> " or null (got "
              <> describe(v)
              <> ")",
          ))
      }
  })
  use <- below_min(min, max)
  let assert Ok(category) =
    row.elig_category_from_string(row.category_to_string(category))
  Ok(Eligibility(
    min_age: min,
    max_age: max,
    position_group: group,
    category:,
    max_level: level,
    radius_km: radius,
  ))
}

fn unknown_first(
  found: Result(String, Nil),
  next: fn() -> Result(Eligibility, Bad),
) -> Result(Eligibility, Bad) {
  case found {
    Ok(k) ->
      Error(Bad("eligibility." <> k, "eligibility has no field " <> k <> "."))
    Error(Nil) -> next()
  }
}

fn below_min(
  min: Option(Int),
  max: Option(Int),
  next: fn() -> Result(Eligibility, Bad),
) -> Result(Eligibility, Bad) {
  case min, max {
    Some(lo), Some(hi) if lo > hi ->
      Error(bad("maxAge", "is below minAge (nobody could be eligible)"))
    _, _ -> next()
  }
}

// ------------------------------------------------------------------------------------------------- views

fn eligibility_json(e: Eligibility) -> Json {
  json.object([
    #("minAge", json.nullable(e.min_age, json.int)),
    #("maxAge", json.nullable(e.max_age, json.int)),
    #("positionGroup", row.elig_position_group_to_json(e.position_group)),
    #("category", row.elig_category_to_json(e.category)),
    #("maxLevel", json.nullable(e.max_level, playing_level.to_json)),
    #("radiusKm", json.nullable(e.radius_km, json_text.number)),
  ])
}

fn structured_json(o: Opportunity) -> Json {
  case o.row.structured_declared {
    False -> json.null()
    True ->
      json.object([
        #(
          "trainingSlots",
          json.array(o.slots, fn(s) {
            json.object([
              #("day", slot_row.day_to_json(s.day)),
              #("start", json.string(s.start_time)),
              #("end", json.string(s.end_time)),
              #("tz", json.string(s.tz)),
            ])
          }),
        ),
        #("relocationRequired", json.bool(o.row.relocation_required)),
        #("feeMinor", json.nullable(o.row.fee_minor, json.int)),
        #("currency", json.nullable(o.row.currency, json.string)),
        #("expensesCovered", json.bool(o.row.expenses_covered)),
        #("environment", json.array(o.environment, json.string)),
        #("accommodations", json.array(o.accommodations, json.string)),
      ])
  }
}

/// views.mjs `opportunityView`, as fields: the board extends it.
pub fn fields(o: Opportunity) -> List(#(String, Json)) {
  let r = o.row
  [
    #("id", id.opportunity_json(r.id)),
    #("orgId", id.org_json(r.org_id)),
    #("orgName", json.string(r.org_name)),
    #("orgLevel", row.org_level_to_json(r.org_level)),
    #("type", row.type_to_json(r.type_)),
    #("title", json.string(r.title)),
    #("team", json.nullable(r.team, json.string)),
    #("category", row.category_to_json(r.category)),
    #("ageGroup", json.nullable(r.age_group, json.string)),
    #("role", json.nullable(r.role, json.string)),
    #("description", json.nullable(r.description, json.string)),
    #("schedule", json.nullable(r.schedule, json.string)),
    #("deadline", json.string(r.deadline)),
    #("capacity", json.nullable(r.capacity, json.int)),
    #("eligibility", eligibility_json(eligibility(r))),
    #("requirements", json.array(o.requirements, json.string)),
    #("status", row.status_to_json(r.status)),
    #("createdBy", json.string(r.created_by_name)),
    #("createdAt", json.int(r.created_at)),
    #("closedAt", json.nullable(r.closed_at, json.int)),
    #("structured", structured_json(o)),
  ]
}

/// Open to applications: published and not past its deadline.
pub fn is_open(r: row.Row, today: String) -> Bool {
  r.status == row.Published && string.compare(r.deadline, today) != order.Lt
}

// ------------------------------------------------------------------------------------------------- routes

type NewOpportunity {
  NewOpportunity(
    type_: row.Type,
    title: Option(String),
    deadline: Option(String),
    team: Option(String),
    age_group: Option(String),
    role: Option(String),
    description: Option(String),
    schedule: Option(String),
    category: Option(row.Category),
    capacity: Option(Int),
    requirements: Option(List(String)),
    eligibility: Option(Dynamic),
  )
}

/// `|| null`: empty text is no value.
fn or_none(s: Option(String)) -> Option(String) {
  case s {
    Some("") -> None
    other -> other
  }
}

/// `POST /org/opportunities`: published at once, open until its deadline.
pub fn create(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  let shape = {
    use type_ <- input.field(
      "type",
      input.required(input.one_of(row.type_pairs)),
    )
    use title <- input.field("title", input.nullish(input.text(title_max)))
    use deadline <- input.field(
      "deadline",
      input.optional(input.day_or_blank()),
    )
    use team <- input.field("team", input.nullish(input.text(team_max)))
    use age_group <- input.field(
      "ageGroup",
      input.nullish(input.text(age_group_max)),
    )
    use role <- input.field("role", input.nullish(input.text(role_max)))
    use description <- input.field(
      "description",
      input.nullish(input.text(description_max)),
    )
    use schedule <- input.field(
      "schedule",
      input.nullish(input.text(schedule_max)),
    )
    use category <- input.field(
      "category",
      input.nullish(input.one_of(row.category_pairs)),
    )
    use capacity <- input.field(
      "capacity",
      input.nullish(input.whole_number(1, max_safe_integer)),
    )
    use requirements <- input.field(
      "requirements",
      input.nullish(input.items_between(
        input.required_text(requirement_max),
        0,
        requirements_max,
      )),
    )
    use eligibility <- input.field(
      "eligibility",
      input.optional(input.anything()),
    )
    input.done(NewOpportunity(
      type_:,
      title:,
      deadline: option.flatten(deadline),
      team:,
      age_group:,
      role:,
      description:,
      schedule:,
      category:,
      capacity:,
      requirements:,
      eligibility:,
    ))
  }
  use b <- http.body(req, shape, [#("type", "TYPE_INVALID")])
  case input.filled(b.title), b.title, b.deadline {
    None, _, _ | _, None, _ -> http.required("TITLE_REQUIRED", "title")
    _, _, None -> http.required("DEADLINE_REQUIRED", "deadline")
    Some(_), Some(title), Some(deadline) -> {
      use <- moderated(ctx, a, or_none(b.description))
      let category = option.unwrap(b.category, row.CategoryMixed)
      let grassroots = a.org.level == Some(org_row.LevelGrassroots)
      case type_eligibility(b.eligibility, grassroots, category) {
        Error(Bad(field:, message:)) ->
          http.json(
            400,
            json.object([
              #("error", json.string("FIELD_INVALID")),
              #("field", json.string(field)),
              #("message", json.string(message)),
            ]),
          )
        Ok(e) -> publish(ctx, a, b, title, deadline, category, e)
      }
    }
  }
}

fn moderated(
  ctx: Ctx,
  a: OrgAccess,
  description: Option(String),
  next: fn() -> Response,
) -> Response {
  case description {
    None -> next()
    Some(text) ->
      moderate.or_refuse(
        ctx,
        text,
        audit.Context(
          kind: "opportunity",
          player_id: None,
          org_id: Some(a.org.id),
          user_id: None,
          channel_id: None,
          request_id: None,
        ),
        next,
      )
  }
}

fn publish(
  ctx: Ctx,
  a: OrgAccess,
  b: NewOpportunity,
  title: String,
  deadline: String,
  category: row.Category,
  e: Eligibility,
) -> Response {
  let now = clock.now_ms()
  let org_level =
    a.org.level
    |> option.map(org_row.level_to_string)
    |> option.unwrap("pro")
    |> row.org_level_from_string
    |> result.unwrap(row.Pro)
  let requirements = option.unwrap(b.requirements, [])
  let published =
    store.unit(ctx.store, fn(tx) {
      use oid <- result.try(id.next_opportunity(tx))
      let r =
        row.Row(
          ..row.new(
            id: oid,
            org_id: a.org.id,
            org_name: input.utf16_take(a.org.name, name_max),
            org_level:,
            type_: b.type_,
            title:,
            category:,
            deadline:,
            elig_position_group: e.position_group,
            elig_category: e.category,
            status: row.Published,
            created_by_name: input.utf16_take(a.user.name, name_max),
            created_at: now,
            structured_declared: False,
            relocation_required: False,
            expenses_covered: False,
          ),
          team: or_none(b.team),
          age_group: or_none(b.age_group),
          role: or_none(b.role),
          description: or_none(b.description),
          schedule: or_none(b.schedule),
          capacity: b.capacity,
          elig_min_age: e.min_age,
          elig_max_age: e.max_age,
          elig_max_level: e.max_level,
          elig_radius_km: e.radius_km,
        )
      use _ <- result.try(row.insert(tx, r))
      use _ <- result.map(
        list.index_map(requirements, fn(t, i) { #(i, t) })
        |> list.try_each(fn(entry) {
          text_row.insert(
            tx,
            text_row.Row(
              opportunity_id: oid,
              kind: text_row.Requirement,
              ordinal: entry.0,
              text: entry.1,
            ),
          )
        }),
      )
      Opportunity(
        row: r,
        requirements:,
        environment: [],
        accommodations: [],
        slots: [],
      )
    })
  // Not ported yet: the `opportunities` live event.
  case published {
    Ok(o) ->
      http.json(201, json.object([#("opportunity", json.object(fields(o)))]))
    Error(failure) -> http.internal(failure)
  }
}

/// `GET /org/opportunities`: the club's own, newest first, by cursor. Opportunities are closed, never deleted, so the
/// list grows without limit.
pub fn list_for_org(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use page <- pages.strict(req, [IntKind])
  let read =
    store.read(ctx.store, fn(r) {
      use found <- result.try(page_for_org(r, a.org.id, page))
      let #(items, next) =
        paging.page_of(found, page.limit, fn(f) { [IntKey(f.1)] })
      use counts <- result.map(application_counts(
        r,
        list.map(items, fn(f) { { f.0 }.row.id }),
      ))
      #(items, next, counts)
    })
  case read {
    Error(failure) -> http.internal(failure)
    Ok(#(items, next, counts)) -> {
      let today = clock.iso_day(clock.now_ms())
      pages.respond(items, next, fn(f) {
        let o = f.0
        let #(live, outstanding) =
          dict.get(counts, o.row.id) |> result.unwrap(#(0, 0))
        json.object(
          list.append(fields(o), [
            #("open", json.bool(is_open(o.row, today))),
            #("applications", json.int(live)),
            #("outstanding", json.int(outstanding)),
          ]),
        )
      })
    }
  }
}
