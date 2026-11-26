//// A club's tactical setup (domains/scouting/scouting.mjs "tactical fit", repositories/clubSetup.ts `tactical`): its
//// formation, its planning horizon, its transfer windows, and its roles, each with the criteria a candidate is
//// judged by (required and preferred).
////
//// A save replaces the whole setup and diffs the roles by id: a kept role keeps its row, so its vacancies and shadow
//// entries keep their role; a role left out is deleted, and what named it loses its role (`ON DELETE SET NULL`).
////
//// The route reads a role and a window loosely, as the TypeScript route does, and the setup's typing judges their
//// other fields, refusing with the repository's own reasons (`roles[0].positionGroup must be one of …`).

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
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/platform/temporal
import scoutbox/rows/id
import scoutbox/rows/org_tactical_role_criteria as criterion_row
import scoutbox/rows/org_tactical_roles as role_row
import scoutbox/rows/org_tactical_setups as setup_row
import scoutbox/rows/org_tactical_windows as window_row
import scoutbox/scouting/evidence
import scoutbox/vocab/availability
import scoutbox/vocab/foot
import scoutbox/vocab/playing_level
import sqlight
import wisp.{type Request, type Response}

const formation_max = 20

const planning_horizon_max = 40

const roles_max = 15

const windows_max = 4

const criteria_max = 8

const role_name_max = 60

const description_max = 300

const window_name_max = 40

// ------------------------------------------------------------------------------------------------------ records

/// A criterion's value: a word of its key's vocabulary, or a whole number in its range.
pub type Value {
  Word(String)
  Number(Int)
}

pub type Criterion {
  Criterion(key: criterion_row.Key, value: Value)
}

pub type Role {
  Role(
    id: id.RoleId,
    name: String,
    position_group: role_row.PositionGroup,
    /// "" when the club wrote none.
    description: String,
    category: role_row.Category,
    required: List(Criterion),
    preferred: List(Criterion),
  )
}

pub type Window {
  Window(name: String, opens: Option(String), closes: Option(String))
}

pub type Setup {
  Setup(
    org_id: id.OrgId,
    formation: String,
    planning_horizon: Option(String),
    windows: List(Window),
    roles: List(Role),
    updated_at: Int,
    updated_by: String,
  )
}

// -------------------------------------------------------------------------------------------------------- reads

fn criterion_of(r: criterion_row.Row) -> Criterion {
  // The columns hold a number exactly for the numeric keys (a CHECK), so the pair is a criterion as typed.
  Criterion(r.key, case r.value_number, r.value_text {
    Some(n), _ -> Number(n)
    None, Some(t) -> Word(t)
    None, None -> panic as "a criterion row holds no value"
  })
}

/// The club's setup, or `None` when it has saved none.
pub fn for_org(read: Read, org_id: id.OrgId) -> Result(Option(Setup), Fail(e)) {
  use found <- result.try(store.query(
    read,
    "SELECT "
      <> setup_row.columns
      <> " FROM org_tactical_setups WHERE org_id = ?",
    [id.org_sql(org_id)],
    setup_row.decoder(),
  ))
  case found {
    [] -> Ok(None)
    [s, ..] -> {
      use roles <- result.try(store.query(
        read,
        "SELECT "
          <> role_row.columns
          <> " FROM org_tactical_roles WHERE org_id = ? ORDER BY ordinal",
        [id.org_sql(org_id)],
        role_row.decoder(),
      ))
      use criteria <- result.try(store.query(
        read,
        "SELECT "
          <> criterion_row.columns
          <> " FROM org_tactical_role_criteria WHERE role_id IN (SELECT id FROM org_tactical_roles WHERE org_id = ?) ORDER BY role_id, kind, ordinal",
        [id.org_sql(org_id)],
        criterion_row.decoder(),
      ))
      use windows <- result.map(store.query(
        read,
        "SELECT "
          <> window_row.columns
          <> " FROM org_tactical_windows WHERE org_id = ? ORDER BY ordinal",
        [id.org_sql(org_id)],
        window_row.decoder(),
      ))
      let of_kind = fn(role_id, kind) {
        criteria
        |> list.filter(fn(c) { c.role_id == role_id && c.kind == kind })
        |> list.map(criterion_of)
      }
      Some(Setup(
        org_id: s.org_id,
        formation: s.formation,
        planning_horizon: s.planning_horizon,
        windows: list.map(windows, fn(w) { Window(w.name, w.opens, w.closes) }),
        roles: list.map(roles, fn(r) {
          Role(
            id: r.id,
            name: r.name,
            position_group: r.position_group,
            description: r.description,
            category: r.category,
            required: of_kind(r.id, criterion_row.Required),
            preferred: of_kind(r.id, criterion_row.Preferred),
          )
        }),
        updated_at: s.updated_at,
        updated_by: s.updated_by_name,
      ))
    }
  }
}

/// One of the club's current roles.
pub fn role_of(
  read: Read,
  org_id: id.OrgId,
  role_id: String,
) -> Result(Option(Role), Fail(e)) {
  use setup <- result.map(for_org(read, org_id))
  case setup {
    None -> None
    Some(s) ->
      list.find(s.roles, fn(r) { id.role_to_string(r.id) == role_id })
      |> option.from_result
  }
}

fn role_ids(read: Read, org_id: id.OrgId) -> Result(List(String), Fail(e)) {
  store.query(
    read,
    "SELECT id FROM org_tactical_roles WHERE org_id = ? ORDER BY ordinal",
    [id.org_sql(org_id)],
    decode.at([0], decode.string),
  )
}

// -------------------------------------------------------------------------------------------------------- views

fn value_json(v: Value) -> Json {
  case v {
    Word(w) -> json.string(w)
    Number(n) -> json.int(n)
  }
}

pub fn criterion_fields(c: Criterion) -> List(#(String, Json)) {
  [
    #("key", criterion_row.key_to_json(c.key)),
    #("value", value_json(c.value)),
  ]
}

pub fn role_json(r: Role) -> Json {
  let criteria = fn(list) {
    json.array(list, fn(c) { json.object(criterion_fields(c)) })
  }
  json.object([
    #("id", id.role_json(r.id)),
    #("name", json.string(r.name)),
    #("positionGroup", role_row.position_group_to_json(r.position_group)),
    #("description", json.string(r.description)),
    #("category", role_row.category_to_json(r.category)),
    #("required", criteria(r.required)),
    #("preferred", criteria(r.preferred)),
  ])
}

pub fn window_json(w: Window) -> Json {
  json.object([
    #("name", json.string(w.name)),
    #("opens", json.nullable(w.opens, json.string)),
    #("closes", json.nullable(w.closes, json.string)),
  ])
}

fn setup_json(s: Option(Setup)) -> Json {
  case s {
    None -> json.null()
    Some(s) ->
      json.object([
        #("formation", json.string(s.formation)),
        #("planningHorizon", json.nullable(s.planning_horizon, json.string)),
        #("windows", json.array(s.windows, window_json)),
        #("roles", json.array(s.roles, role_json)),
        #("updatedAt", json.int(s.updated_at)),
        #("updatedBy", json.string(s.updated_by)),
      ])
  }
}

// ------------------------------------------------------------------------------------------------------- typing

/// Why a value was refused, as the repository's typing words it: a path from the setup, and what is wrong.
type Bad {
  Bad(path: String, what: String)
}

fn bad(at: String, field: String, what: String) -> Result(a, Bad) {
  Error(Bad(at <> "." <> field, what))
}

/// fieldSpecs.ts `describe`: what a value is, for a refusal.
fn describe(v: Dynamic) -> String {
  case dynamic.classify(v) {
    "Nil" | "Null" -> "null"
    "List" | "Array" -> "an array"
    "Dict" | "Object" -> "an object"
    "String" -> "a string"
    "Int" | "Float" -> "a number"
    "Bool" -> "a boolean"
    other -> "a " <> string.lowercase(other)
  }
}

fn null(v: Dynamic) -> Bool {
  case dynamic.classify(v) {
    "Nil" | "Null" -> True
    _ -> False
  }
}

fn fields_of(v: Dynamic) -> Result(Dict(String, Dynamic), Nil) {
  decode.run(v, decode.dict(decode.string, decode.dynamic))
  |> result.replace_error(Nil)
}

/// A whole number, as `Number.isSafeInteger` reads one (`23.0` is 23).
fn whole(v: Dynamic) -> Option(Int) {
  case decode.run(v, decode.int) {
    Ok(n) -> Some(n)
    Error(_) ->
      case decode.run(v, decode.float) {
        Ok(f) ->
          case float.floor(f) == f {
            True -> Some(float.truncate(f))
            False -> None
          }
        Error(_) -> None
      }
  }
}

fn unknown_fields(
  fields: Dict(String, Dynamic),
  at: String,
  known: List(String),
) -> Result(Nil, Bad) {
  // The TypeScript server lists them in the order sent; a decoded object here has none, so they are sorted.
  case
    dict.keys(fields)
    |> list.filter(fn(k) { !list.contains(known, k) })
    |> list.sort(string.compare)
  {
    [] -> Ok(Nil)
    extra ->
      Error(Bad(
        at,
        "carries field(s) this build does not store: "
          <> string.join(extra, ", "),
      ))
  }
}

fn text_of(v: Option(Dynamic)) -> Option(String) {
  case v {
    Some(v) -> decode.run(v, decode.string) |> option.from_result
    None -> None
  }
}

fn opt_text(
  fields: Dict(String, Dynamic),
  at: String,
  field: String,
  max: Int,
) -> Result(Option(String), Bad) {
  case dict.get(fields, field) {
    Error(_) -> Ok(None)
    Ok(v) ->
      case null(v), decode.run(v, decode.string) {
        True, _ -> Ok(None)
        False, Error(_) ->
          bad(at, field, "must be text or null (got " <> describe(v) <> ")")
        False, Ok(s) ->
          case input.utf16_length(s) > max {
            True ->
              bad(at, field, "exceeds " <> int.to_string(max) <> " characters")
            False -> Ok(Some(s))
          }
      }
  }
}

fn req_text(
  fields: Dict(String, Dynamic),
  at: String,
  field: String,
  max: Int,
) -> Result(String, Bad) {
  let v = dict.get(fields, field)
  case
    result.try(v, fn(v) {
      decode.run(v, decode.string) |> result.replace_error(Nil)
    })
  {
    Ok(s) if s != "" ->
      case input.utf16_length(s) > max {
        True ->
          bad(at, field, "exceeds " <> int.to_string(max) <> " characters")
        False -> Ok(s)
      }
    _ ->
      bad(
        at,
        field,
        "must be non-empty text (got "
          <> case v {
          Ok(v) -> describe(v)
          Error(_) -> "nothing"
        }
          <> ")",
      )
  }
}

fn one_of(
  pairs: List(#(String, a)),
  v: Option(Dynamic),
  at: String,
  field: String,
  for: String,
) -> Result(a, Bad) {
  let sent =
    option.then(v, fn(v) { decode.run(v, decode.string) |> option.from_result })
  case
    option.then(sent, fn(s) { list.key_find(pairs, s) |> option.from_result })
  {
    Some(a) -> Ok(a)
    None ->
      bad(
        at,
        field,
        "must be one of "
          <> string.join(list.map(pairs, fn(p) { p.0 }), "|")
          <> for
          <> " (got "
          <> case v {
          Some(v) -> describe(v)
          None -> "nothing"
        }
          <> ")",
      )
  }
}

/// What each key's value may be: a vocabulary, or a whole-number range.
type Rule {
  Words(List(String))
  Range(min: Int, max: Int)
}

fn rule_for(key: criterion_row.Key) -> Rule {
  let words = fn(pairs: List(#(String, a))) {
    Words(list.map(pairs, fn(p) { p.0 }))
  }
  case key {
    criterion_row.Positiongroup -> words(role_row.position_group_pairs)
    criterion_row.Foot -> words(foot.pairs)
    criterion_row.Availability -> words(availability.pairs)
    criterion_row.Maxlevel -> words(playing_level.pairs)
    criterion_row.Category -> words(role_row.category_pairs)
    criterion_row.Minage | criterion_row.Maxage -> Range(5, 60)
    criterion_row.Minappearances -> Range(0, 1000)
  }
}

fn type_criterion(v: Dynamic, at: String) -> Result(Criterion, Bad) {
  case fields_of(v) {
    Error(_) -> Error(Bad(at, "is not an object (" <> describe(v) <> ")"))
    Ok(fields) -> {
      use _ <- result.try(unknown_fields(fields, at, ["key", "value"]))
      use key <- result.try(one_of(
        criterion_row.key_pairs,
        dict.get(fields, "key") |> option.from_result,
        at,
        "key",
        "",
      ))
      let sent = dict.get(fields, "value") |> option.from_result
      let got = fn() {
        "(got "
        <> case sent {
          Some(v) -> describe(v)
          None -> "nothing"
        }
        <> ")"
      }
      case rule_for(key) {
        Words(words) ->
          case text_of(sent) {
            Some(w) ->
              case list.contains(words, w) {
                True -> Ok(Criterion(key, Word(w)))
                False ->
                  bad(
                    at,
                    "value",
                    "must be one of "
                      <> string.join(words, "|")
                      <> " for "
                      <> criterion_row.key_to_string(key)
                      <> " "
                      <> got(),
                  )
              }
            None ->
              bad(
                at,
                "value",
                "must be one of "
                  <> string.join(words, "|")
                  <> " for "
                  <> criterion_row.key_to_string(key)
                  <> " "
                  <> got(),
              )
          }
        Range(min, max) ->
          case option.then(sent, whole) {
            Some(n) if n >= min && n <= max -> Ok(Criterion(key, Number(n)))
            _ ->
              bad(
                at,
                "value",
                "must be a whole number from "
                  <> int.to_string(min)
                  <> " to "
                  <> int.to_string(max)
                  <> " for "
                  <> criterion_row.key_to_string(key)
                  <> " "
                  <> got(),
              )
          }
      }
    }
  }
}

fn type_criteria(
  v: Option(Dynamic),
  at: String,
) -> Result(List(Criterion), Bad) {
  case v {
    None -> Ok([])
    Some(v) ->
      case null(v), decode.run(v, decode.list(decode.dynamic)) {
        True, _ -> Ok([])
        False, Error(_) ->
          Error(Bad(at, "must be an array (got " <> describe(v) <> ")"))
        False, Ok(items) ->
          case list.length(items) > criteria_max {
            // The repository's own wording, stray dot included (`bad(at, '', …)`).
            True ->
              bad(
                at,
                "",
                "holds more than " <> int.to_string(criteria_max) <> " criteria",
              )
            False ->
              list.index_map(items, fn(item, i) { #(item, i) })
              |> list.try_fold([], fn(acc, pair) {
                let item_at = at <> "[" <> int.to_string(pair.1) <> "]"
                use c <- result.try(type_criterion(pair.0, item_at))
                case list.any(acc, fn(x: Criterion) { x.key == c.key }) {
                  True ->
                    bad(
                      item_at,
                      "key",
                      "repeats " <> criterion_row.key_to_string(c.key),
                    )
                  False -> Ok([c, ..acc])
                }
              })
              |> result.map(list.reverse)
          }
      }
  }
}

const role_fields = [
  "id", "name", "positionGroup", "description", "category", "required",
  "preferred",
]

/// A role as the route shaped it: the fields sent, with the route's defaults in place of absent or null ones.
type RoleIn {
  RoleIn(id: String, name: String, fields: Dict(String, Dynamic))
}

fn type_role(r: RoleIn, at: String) -> Result(#(String, Role), Bad) {
  let fields = r.fields
  use _ <- result.try(unknown_fields(fields, at, role_fields))
  use name <- result.try(req_text(
    dict.insert(fields, "name", dynamic.string(r.name)),
    at,
    "name",
    role_name_max,
  ))
  use description <- result.try(opt_text(
    fields,
    at,
    "description",
    description_max,
  ))
  let or_default = fn(field, default) {
    case dict.get(fields, field) {
      Ok(v) ->
        case null(v) {
          True -> Some(dynamic.string(default))
          False -> Some(v)
        }
      Error(_) -> Some(dynamic.string(default))
    }
  }
  use position_group <- result.try(one_of(
    role_row.position_group_pairs,
    or_default("positionGroup", "MID"),
    at,
    "positionGroup",
    "",
  ))
  use category <- result.try(one_of(
    role_row.category_pairs,
    or_default("category", "mixed"),
    at,
    "category",
    "",
  ))
  use required <- result.try(type_criteria(
    dict.get(fields, "required") |> option.from_result,
    at <> ".required",
  ))
  use preferred <- result.try(type_criteria(
    dict.get(fields, "preferred") |> option.from_result,
    at <> ".preferred",
  ))
  let age = fn(key) {
    list.find_map(required, fn(c) {
      case c.key == key, c.value {
        True, Number(n) -> Ok(n)
        _, _ -> Error(Nil)
      }
    })
  }
  case age(criterion_row.Minage), age(criterion_row.Maxage) {
    Ok(lo), Ok(hi) if lo > hi ->
      bad(
        at <> ".required",
        "maxAge",
        "is below minAge (the role could match nobody)",
      )
    _, _ ->
      Ok(#(
        r.id,
        Role(
          // A placeholder until the save mints the ids of new roles.
          id: id.role(r.id),
          name:,
          position_group:,
          description: option.unwrap(description, ""),
          category:,
          required:,
          preferred:,
        ),
      ))
  }
}

fn opt_day(
  fields: Dict(String, Dynamic),
  at: String,
  field: String,
) -> Result(Option(String), Bad) {
  case dict.get(fields, field) {
    Error(_) -> Ok(None)
    Ok(v) ->
      case null(v), decode.run(v, decode.string) {
        True, _ -> Ok(None)
        False, Ok(s) ->
          case temporal.parse_day(s) {
            Ok(_) -> Ok(Some(s))
            Error(_) ->
              bad(
                at,
                field,
                "must be a YYYY-MM-DD day or null (got " <> describe(v) <> ")",
              )
          }
        False, Error(_) ->
          bad(
            at,
            field,
            "must be a YYYY-MM-DD day or null (got " <> describe(v) <> ")",
          )
      }
  }
}

fn type_window(
  fields: Dict(String, Dynamic),
  at: String,
) -> Result(Window, Bad) {
  use _ <- result.try(unknown_fields(fields, at, ["name", "opens", "closes"]))
  use name <- result.try(opt_text(fields, at, "name", window_name_max))
  use opens <- result.try(opt_day(fields, at, "opens"))
  use closes <- result.try(opt_day(fields, at, "closes"))
  case opens, closes {
    Some(o), Some(c) ->
      case string.compare(o, c) {
        order.Gt -> bad(at, "closes", "is before opens")
        _ -> Ok(Window(option.unwrap(name, ""), opens, closes))
      }
    _, _ -> Ok(Window(option.unwrap(name, ""), opens, closes))
  }
}

// --------------------------------------------------------------------------------------------------------- save

fn criterion_rows(
  role_id: id.RoleId,
  kind: criterion_row.Kind,
  list: List(Criterion),
) -> List(criterion_row.Row) {
  list.index_map(list, fn(c, i) {
    let #(n, t) = case c.value {
      Number(n) -> #(Some(n), None)
      Word(w) -> #(None, Some(w))
    }
    criterion_row.Row(
      role_id:,
      kind:,
      ordinal: i,
      key: c.key,
      value_number: n,
      value_text: t,
    )
  })
}

/// Saves the whole setup. Every role id is one of this club's or newly minted.
fn save(tx: Tx, s: Setup) -> Result(Nil, Fail(e)) {
  use _ <- result.try(
    store.run(
      tx,
      "INSERT INTO org_tactical_setups (org_id, formation, planning_horizon, updated_at, updated_by_name) VALUES (?, ?, ?, ?, ?) ON CONFLICT (org_id) DO UPDATE SET formation = excluded.formation, planning_horizon = excluded.planning_horizon, updated_at = excluded.updated_at, updated_by_name = excluded.updated_by_name",
      [
        id.org_sql(s.org_id),
        sqlight.text(s.formation),
        sqlight.nullable(sqlight.text, s.planning_horizon),
        sqlight.int(s.updated_at),
        sqlight.text(s.updated_by),
      ],
    ),
  )
  let kept = json.array(s.roles, fn(r) { id.role_json(r.id) }) |> json.to_string
  use _ <- result.try(
    store.run(
      tx,
      "DELETE FROM org_tactical_role_criteria WHERE role_id IN (SELECT id FROM org_tactical_roles WHERE org_id = ?)",
      [id.org_sql(s.org_id)],
    ),
  )
  use _ <- result.try(
    store.run(
      tx,
      "DELETE FROM org_tactical_roles WHERE org_id = ? AND id NOT IN (SELECT value FROM json_each(?))",
      [id.org_sql(s.org_id), sqlight.text(kept)],
    ),
  )
  use _ <- result.try(
    list.index_map(s.roles, fn(r, i) { #(r, i) })
    |> list.try_each(fn(pair) {
      let #(r, i) = pair
      use _ <- result.try(
        store.run(
          tx,
          "INSERT INTO org_tactical_roles (id, org_id, ordinal, name, position_group, description, category) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET ordinal = excluded.ordinal, name = excluded.name, position_group = excluded.position_group, description = excluded.description, category = excluded.category",
          [
            id.role_sql(r.id),
            id.org_sql(s.org_id),
            sqlight.int(i),
            sqlight.text(r.name),
            sqlight.text(role_row.position_group_to_string(r.position_group)),
            sqlight.text(r.description),
            sqlight.text(role_row.category_to_string(r.category)),
          ],
        ),
      )
      list.append(
        criterion_rows(r.id, criterion_row.Required, r.required),
        criterion_rows(r.id, criterion_row.Preferred, r.preferred),
      )
      |> list.try_each(criterion_row.insert(tx, _))
    }),
  )
  use _ <- result.try(
    store.run(tx, "DELETE FROM org_tactical_windows WHERE org_id = ?", [
      id.org_sql(s.org_id),
    ]),
  )
  list.index_map(s.windows, fn(w, i) {
    window_row.Row(
      org_id: s.org_id,
      ordinal: i,
      name: w.name,
      opens: w.opens,
      closes: w.closes,
    )
  })
  |> list.try_each(window_row.insert(tx, _))
}

// ------------------------------------------------------------------------------------------------------- routes

/// `GET /org/tactical`: the setup, or null, with the criteria a role may name.
pub fn get(ctx: Ctx, a: OrgAccess) -> Response {
  case store.read(ctx.store, for_org(_, a.org.id)) {
    Error(e) -> http.internal(e)
    Ok(s) ->
      http.json(
        200,
        json.object([
          #("tactical", setup_json(s)),
          #(
            "criteriaKeys",
            json.array(criterion_row.key_pairs, fn(p) { json.string(p.0) }),
          ),
        ]),
      )
  }
}

type RoleBody {
  RoleBody(id: Option(String), name: String)
}

type SaveBody {
  SaveBody(
    formation: String,
    planning_horizon: Option(String),
    roles: List(#(RoleBody, Dict(String, Dynamic))),
    windows: Option(List(Dict(String, Dynamic))),
  )
}

/// The object `check` reads, with every field sent.
fn with_fields(
  check: input.Check(a),
) -> input.Check(#(a, Dict(String, Dynamic))) {
  fn(v) {
    use a <- result.try(check(v))
    let assert Ok(fields) = fields_of(v) as "an object just read"
    Ok(#(a, fields))
  }
}

fn save_shape() -> input.Shape(SaveBody) {
  let role = {
    use id <- input.field("id", input.nullish(input.id()))
    use name <- input.field(
      "name",
      input.required(input.required_text(role_name_max)),
    )
    use _ <- input.field(
      "description",
      input.nullish(input.text(description_max)),
    )
    input.loose(RoleBody(id:, name:))
  }
  let window = {
    use _ <- input.field("name", input.nullish(input.text(window_name_max)))
    input.loose(Nil)
  }
  use formation <- input.field(
    "formation",
    input.required(input.required_text(formation_max)),
  )
  use planning_horizon <- input.field(
    "planningHorizon",
    input.nullish(input.text(planning_horizon_max)),
  )
  use roles <- input.field(
    "roles",
    input.required(input.items(with_fields(input.object(role)), roles_max)),
  )
  use windows <- input.field(
    "windows",
    input.nullish(input.items(with_fields(input.object(window)), windows_max)),
  )
  input.done(SaveBody(
    formation:,
    planning_horizon:,
    roles:,
    windows: option.map(windows, list.map(_, fn(w) { w.1 })),
  ))
}

fn refused(b: Bad) -> Response {
  let reason = b.path <> " " <> b.what
  // The field is the reason's first word, as the TypeScript route reads it back.
  let field = case string.split_once(reason, " ") {
    Ok(#(f, _)) -> f
    Error(_) -> reason
  }
  let field = case string.ends_with(field, ".") {
    True -> string.drop_end(field, 1)
    False -> field
  }
  let code = case
    string.ends_with(field, ".opens") || string.ends_with(field, ".closes")
  {
    True -> "DATE_INVALID"
    False -> "FIELD_INVALID"
  }
  http.json(
    400,
    json.object([
      #("error", json.string(code)),
      #("field", json.string(field)),
      #("message", json.string(reason)),
    ]),
  )
}

/// `POST /org/tactical`: a recruitment lead saves the whole setup. A role keeps its id across saves; a supplied id
/// must be one of this club's current roles.
pub fn save_route(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use <- access.require_lead(a)
  use body <- http.body(req, save_shape(), [])
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    use current <- result.try(role_ids(store.reading(tx), a.org.id) |> storage)
    use _ <- result.try(
      list.index_map(body.roles, fn(r, i) { #(r.0, i) })
      |> list.try_each(fn(pair) {
        case { pair.0 }.id {
          Some(rid) ->
            case list.contains(current, rid) {
              True -> Ok(Nil)
              False ->
                store.refuse(http.json(
                  400,
                  json.object([
                    #("error", json.string("FIELD_INVALID")),
                    #(
                      "field",
                      json.string("roles[" <> int.to_string(pair.1) <> "].id"),
                    ),
                    #(
                      "message",
                      json.string(
                        "A role id must be one of this club's current roles; leave it out for a new role.",
                      ),
                    ),
                  ]),
                ))
            }
          None -> Ok(Nil)
        }
      }),
    )
    let typed = {
      use _ <- result.try(req_text(
        dict.from_list([
          #("formation", dynamic.string(string.trim(body.formation))),
        ]),
        "",
        "formation",
        formation_max,
      ))
      use roles <- result.try(
        list.index_map(body.roles, fn(r, i) { #(r, i) })
        |> list.try_fold([], fn(acc, pair) {
          let #(#(role, fields), i) = pair
          let at = ".roles[" <> int.to_string(i) <> "]"
          // A new role's id is minted after typing; an empty one stands in, as no sent id is empty.
          let rid = option.unwrap(role.id, "")
          use typed <- result.try(type_role(
            RoleIn(id: rid, name: string.trim(role.name), fields:),
            at,
          ))
          case
            rid != "" && list.any(acc, fn(x: #(String, Role)) { x.0 == rid })
          {
            True -> bad(at, "id", "repeats " <> rid)
            False -> Ok([typed, ..acc])
          }
        })
        |> result.map(list.reverse),
      )
      use windows <- result.map(
        option.unwrap(body.windows, [])
        |> list.index_map(fn(w, i) { #(w, i) })
        |> list.try_map(fn(pair) {
          type_window(pair.0, ".windows[" <> int.to_string(pair.1) <> "]")
        }),
      )
      #(roles, windows)
    }
    case typed {
      // Reasons are written from the setup (`.roles[0]…`); the route names the field without the leading dot.
      Error(b) ->
        store.refuse(refused(Bad(string.drop_start(b.path, 1), b.what)))
      Ok(#(roles, windows)) -> {
        use roles <- result.try(
          list.try_map(roles, fn(pair) {
            case pair.0 {
              "" ->
                id.next_role(tx)
                |> result.map(fn(rid) { Role(..pair.1, id: rid) })
              _ -> Ok(pair.1)
            }
          })
          |> storage,
        )
        let setup =
          Setup(
            org_id: a.org.id,
            formation: string.trim(body.formation),
            // `planningHorizon || null`: an empty one is none.
            planning_horizon: case body.planning_horizon {
              Some("") -> None
              h -> h
            },
            windows:,
            roles:,
            updated_at: now,
            updated_by: evidence.stored_name(a.user.name),
          )
        use _ <- result.try(save(tx, setup) |> storage)
        use stored <- result.map(
          for_org(store.reading(tx), a.org.id) |> storage,
        )
        http.json(200, json.object([#("tactical", setup_json(stored))]))
      }
    }
  })
  |> answer
}

fn storage(r: Result(a, Fail(e))) -> Result(a, Fail(Response)) {
  case r {
    Ok(a) -> Ok(a)
    Error(store.Storage(e)) -> Error(store.Storage(e))
    Error(store.Stale(what)) -> Error(store.Stale(what))
    Error(store.Refuse(_)) -> panic as "a read refused"
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
