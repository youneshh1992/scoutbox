//// Saved searches (`saved_searches`, domains/discovery/savedSearches.mjs). A filter that is an empty or blank
//// string, `false` or null means "no filter", as the apps send it; only the set ones are stored.
////
//// Not ported yet: the list (`GET /org/searches`), deleting one, and the new-player match that notifies a
//// search's owner.

import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/float
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
import scoutbox/platform/store
import scoutbox/rows/id
import scoutbox/rows/saved_searches as row
import scoutbox/vocab/availability
import scoutbox/vocab/foot
import scoutbox/vocab/position
import wisp.{type Request, type Response}

const name_max = 120

const q_max = 120

const country_max = 60

const new_days_max = 3650

/// The filters a search takes, in the order they are stored and shown (SAVED_SEARCH_FILTERS).
const filter_names = [
  "q", "position", "foot", "availability", "country", "academyPlus", "ageGroup",
  "newDays",
]

type Body {
  Body(name: Option(String), filters: Option(List(#(String, Option(Dynamic)))))
}

fn shape() -> input.Shape(Body) {
  use name <- input.field("name", input.nullish(input.text(name_max)))
  // Each filter's value is judged after the shape, which reads false, null and blank as "no filter".
  use filters <- input.field("filters", input.nullish(input.object(filters())))
  input.done(Body(name:, filters:))
}

fn filters() -> input.Shape(List(#(String, Option(Dynamic)))) {
  read_filters(filter_names, [])
}

fn read_filters(
  names: List(String),
  acc: List(#(String, Option(Dynamic))),
) -> input.Shape(List(#(String, Option(Dynamic)))) {
  case names {
    [] -> input.done(list.reverse(acc))
    [name, ..rest] -> {
      use value <- input.field(name, input.optional(input.anything()))
      read_filters(rest, [#(name, value), ..acc])
    }
  }
}

/// `POST /org/searches`.
pub fn create(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use body <- http.body(req, shape(), [])
  case input.filled(body.name) {
    None -> http.required("NAME_REQUIRED", "name")
    Some(name) ->
      case judge(option.unwrap(body.filters, [])) {
        Error(field) ->
          http.json(
            400,
            json.object([
              #("error", json.string("FIELD_INVALID")),
              #("field", json.string(field)),
              #(
                "message",
                json.string(
                  field <> " is not a search filter this build accepts.",
                ),
              ),
            ]),
          )
        Ok(set) -> {
          let now = clock.now_ms()
          let created =
            store.unit(ctx.store, fn(tx) {
              use id <- result.try(id.next_saved_search(tx))
              let search =
                apply(
                  row.new(
                    id:,
                    org_id: a.org.id,
                    user_id: a.user.id,
                    name:,
                    created_at: now,
                  ),
                  set,
                )
              row.insert(tx, search) |> result.replace(search)
            })
          case created {
            Ok(search) -> http.json(201, view(search, a.user.name))
            Error(failure) -> http.internal(failure)
          }
        }
      }
  }
}

/// A filter that is set, judged.
type Filter {
  Q(String)
  Position(position.Position)
  Foot(foot.Foot)
  Availability(availability.Availability)
  Country(String)
  AcademyPlus
  AgeGroup(row.AgeGroup)
  NewDays(Int)
}

/// The set filters, or the first junk one's field (`filters.position`). The TypeScript server names the first in
/// the order sent; an Erlang map has no order, so here it is the first in the filters' own order.
fn judge(
  sent: List(#(String, Option(Dynamic))),
) -> Result(List(Filter), String) {
  list.try_fold(sent, [], fn(acc, entry) {
    let #(name, value) = entry
    case value {
      None -> Ok(acc)
      Some(v) ->
        case unset(v) {
          True -> Ok(acc)
          False ->
            case filter(name, v) {
              Ok(f) -> Ok([f, ..acc])
              Error(Nil) -> Error("filters." <> name)
            }
        }
    }
  })
  |> result.map(list.reverse)
}

fn unset(v: Dynamic) -> Bool {
  case decode.run(v, decode.optional(decode.dynamic)) {
    Ok(None) -> True
    _ ->
      case decode.run(v, decode.bool), decode.run(v, decode.string) {
        Ok(False), _ -> True
        _, Ok(s) -> string.trim(s) == ""
        _, _ -> False
      }
  }
}

fn filter(name: String, v: Dynamic) -> Result(Filter, Nil) {
  let text = fn(max) {
    case decode.run(v, decode.string) {
      Ok(s) ->
        case string.trim(s) != "" && input.utf16_length(s) <= max {
          True -> Ok(s)
          False -> Error(Nil)
        }
      Error(_) -> Error(Nil)
    }
  }
  case name {
    "q" -> text(q_max) |> result.map(Q)
    "country" -> text(country_max) |> result.map(Country)
    "position" -> one_of(v, position.pairs) |> result.map(Position)
    "foot" -> one_of(v, foot.pairs) |> result.map(Foot)
    "availability" -> one_of(v, availability.pairs) |> result.map(Availability)
    "ageGroup" -> one_of(v, row.age_group_pairs) |> result.map(AgeGroup)
    "academyPlus" ->
      case decode.run(v, decode.bool) {
        Ok(True) -> Ok(AcademyPlus)
        _ -> Error(Nil)
      }
    "newDays" ->
      whole(v)
      |> result.try(fn(n) {
        case n >= 1 && n <= new_days_max {
          True -> Ok(NewDays(n))
          False -> Error(Nil)
        }
      })
    _ -> Error(Nil)
  }
}

fn one_of(v: Dynamic, pairs: List(#(String, a))) -> Result(a, Nil) {
  decode.run(v, decode.string)
  |> result.replace_error(Nil)
  |> result.try(list.key_find(pairs, _))
}

/// A whole number as JSON sends it: `7` and `7.0` alike (Number.isSafeInteger).
fn whole(v: Dynamic) -> Result(Int, Nil) {
  case decode.run(v, decode.int), decode.run(v, decode.float) {
    Ok(n), _ -> Ok(n)
    _, Ok(f) ->
      case float.floor(f) == f {
        True -> Ok(float.round(f))
        False -> Error(Nil)
      }
    _, _ -> Error(Nil)
  }
}

fn apply(search: row.Row, set: List(Filter)) -> row.Row {
  list.fold(set, search, fn(s, f) {
    case f {
      Q(q) -> row.Row(..s, q: Some(q))
      Position(p) -> row.Row(..s, position: Some(p))
      Foot(x) -> row.Row(..s, foot: Some(x))
      Availability(x) -> row.Row(..s, availability: Some(x))
      Country(c) -> row.Row(..s, country: Some(c))
      AcademyPlus -> row.Row(..s, academy_plus: Some(True))
      AgeGroup(g) -> row.Row(..s, age_group: Some(g))
      NewDays(n) -> row.Row(..s, new_days: Some(n))
    }
  })
}

fn view(s: row.Row, scout_name: String) -> Json {
  json.object([
    #("id", id.saved_search_json(s.id)),
    #("orgId", id.org_json(s.org_id)),
    #("userId", id.org_user_json(s.user_id)),
    #("scoutName", json.string(scout_name)),
    #("name", json.string(s.name)),
    #("filters", json.object(set_filters(s))),
    #("createdAt", json.int(s.created_at)),
  ])
}

fn set_filters(s: row.Row) -> List(#(String, Json)) {
  option.values([
    option.map(s.q, fn(q) { #("q", json.string(q)) }),
    option.map(s.position, fn(p) { #("position", position.to_json(p)) }),
    option.map(s.foot, fn(x) { #("foot", foot.to_json(x)) }),
    option.map(s.availability, fn(x) {
      #("availability", availability.to_json(x))
    }),
    option.map(s.country, fn(c) { #("country", json.string(c)) }),
    option.map(s.academy_plus, fn(b) { #("academyPlus", json.bool(b)) }),
    option.map(s.age_group, fn(g) { #("ageGroup", row.age_group_to_json(g)) }),
    option.map(s.new_days, fn(n) { #("newDays", json.int(n)) }),
  ])
}
