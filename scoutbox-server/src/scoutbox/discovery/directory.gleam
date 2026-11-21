//// The club's lists of players: the Discover directory, the Film Room deck and the fixture graph
//// (domains/discovery/search.mjs, filmRoom.mjs; repositories/players.ts `directoryPage`, `clipPage`,
//// `fixturePage`). Visibility, the blocks, the filters and the order are all the query's, so every page is
//// exact: nobody is lost or repeated between pages.

import gleam/dict
import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/orgs.{type Org}
import scoutbox/identity/players
import scoutbox/platform/clock
import scoutbox/platform/distance.{At, Columns}
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/js_text
import scoutbox/platform/keyset.{Asc, Desc, OrderKey}
import scoutbox/platform/pages
import scoutbox/platform/paging.{type Page, IntKind, Page, TextKey, TextKind}
import scoutbox/platform/sql.{type Fragment}
import scoutbox/platform/store.{type Read}
import scoutbox/platform/temporal
import scoutbox/rows/id
import scoutbox/rows/players as row
import scoutbox/rules/age
import scoutbox/rules/visibility
import scoutbox/vocab/position as positions
import sqlight
import wisp.{type Request, type Response}

const day_ms = 86_400_000

pub type Filter {
  Filter(
    q: Option(String),
    position: Option(String),
    availability: Option(String),
    country: Option(String),
    academy_plus: Option(String),
    age_group: Option(String),
    new_days: Option(Option(Int)),
    limit: Option(String),
    cursor: Option(String),
  )
}

/// `?…` as discovery/schemas.mjs `directoryQuery` reads it: each filter once, as text.
fn filter_shape() -> input.Shape(Filter) {
  let text = fn(max) { input.optional(input.text(max)) }
  use q <- input.field("q", text(120))
  use position <- input.field("position", text(80))
  use availability <- input.field("availability", text(80))
  use country <- input.field("country", text(40))
  use academy_plus <- input.field(
    "academyPlus",
    input.optional(
      input.one_of([#("true", "true"), #("false", "false"), #("", "")]),
    ),
  )
  use age_group <- input.field(
    "ageGroup",
    input.optional(
      input.one_of([
        #("u16", "u16"),
        #("u18", "u18"),
        #("18-21", "18-21"),
        #("senior", "senior"),
        #("", ""),
      ]),
    ),
  )
  use new_days <- input.field("newDays", input.optional(day_count()))
  use limit <- input.field("limit", text(1000))
  use cursor <- input.field("cursor", text(100_000))
  input.done(Filter(
    q:,
    position:,
    availability:,
    country:,
    academy_plus:,
    age_group:,
    new_days:,
    limit:,
    cursor:,
  ))
}

/// A whole number of days written as text (1 to 99999), or empty for none.
fn day_count() -> input.Check(Option(Int)) {
  let days = input.whole_number_text(1, 99_999)
  fn(v) {
    case decode.run(v, decode.string) {
      Ok("") -> Ok(None)
      _ -> days(v) |> result.map(Some)
    }
  }
}

fn nonempty(v: Option(String)) -> Option(String) {
  case v {
    Some("") -> None
    other -> other
  }
}

/// The conditions on `p` the directory's filters add.
fn filter_sql(f: Filter, now: Int) -> List(Fragment) {
  let today = temporal.day_of(now)
  let equal = fn(column, v) {
    case nonempty(v) {
      Some(v) ->
        Some(sql.concat([sql.text(column <> " = "), sql.arg(sqlight.text(v))]))
      None -> None
    }
  }
  let born_before = fn(years) {
    sql.concat([
      sql.text("p.birth_date > "),
      sql.arg(sqlight.text(age.born_by(today, years))),
    ])
  }
  let born_by = fn(years) {
    sql.concat([
      sql.text("p.birth_date <= "),
      sql.arg(sqlight.text(age.born_by(today, years))),
    ])
  }
  option.values([
    equal("p.position", f.position),
    equal("p.availability", f.availability),
    equal("p.country", f.country),
    case f.academy_plus {
      Some("true") -> Some(sql.text("p.academy_plus = 1"))
      _ -> None
    },
    case option.flatten(f.new_days) {
      Some(days) ->
        Some(
          sql.concat([
            sql.text("p.created_at >= "),
            sql.arg(sqlight.int(now - days * day_ms)),
          ]),
        )
      None -> None
    },
  ])
  |> list.append(case f.age_group {
    Some("u16") -> [born_before(16)]
    Some("u18") -> [born_before(18)]
    Some("18-21") -> [born_by(18), born_before(22)]
    Some("senior") -> [born_by(22)]
    _ -> []
  })
}

/// The players `org` may see, live and not blocked, with `extra` conditions.
fn admitted(org: Org, now: Int, extra: List(Fragment)) -> Fragment {
  sql.join(
    [
      sql.text("p.deleted_at IS NULL"),
      visibility.can_see_sql(org, now),
      ..extra
    ],
    " AND ",
  )
}

/// The directory's order: Academy+ first (an opted-in cohort), then profile completeness. A Grassroots club
/// sees First Team Seekers first (need-based, not purchasable), then the nearest ground (to 0.1 km, as shown).
fn directory_order(org: Org) -> List(keyset.OrderKey) {
  case orgs.is_grassroots(org), org.lat, org.lng {
    True, Some(lat), Some(lng) -> [
      OrderKey(sql.text("p.first_team_seeker"), Desc, IntKind),
      OrderKey(
        distance.tenths(At(lat, lng), Columns("p.lat", "p.lng")),
        Asc,
        IntKind,
      ),
      OrderKey(sql.text("p.profile_signal"), Desc, IntKind),
      OrderKey(sql.text("p.id"), Asc, TextKind),
    ]
    _, _, _ -> [
      OrderKey(sql.text("p.academy_plus"), Desc, IntKind),
      OrderKey(sql.text("p.profile_signal"), Desc, IntKind),
      OrderKey(sql.text("p.id"), Asc, TextKind),
    ]
  }
}

fn directory_page(
  read: Read,
  org: Org,
  f: Filter,
  page: Page,
  now: Int,
) -> Result(#(List(id.PlayerId), Option(String)), store.Fail(e)) {
  let order = directory_order(org)
  let from =
    sql.concat([
      sql.text("players p WHERE "),
      admitted(org, now, filter_sql(f, now)),
    ])
  case nonempty(f.q) {
    None -> {
      let query = keyset.query("p.id", from, order, page)
      use rows <- result.map(
        store.query(read, query.sql, query.args, {
          use id <- decode.field(0, id.player_decoder())
          use keys <- decode.then(keyset.keys_decoder(1, order))
          decode.success(#(id, keys))
        }),
      )
      let #(items, next) = paging.page_of(rows, page.limit, fn(r) { r.1 })
      #(list.map(items, fn(r) { r.0 }), next)
    }
    // The text search matches the name or the country, and the city of an adult only (a minor's city is never
    // shown to a club, so it is never matched), lowered as JavaScript lowers text; SQLite's lower() is ASCII only,
    // so the search runs over every admitted player past the cursor, in order.
    Some(q) -> {
      let needle = js_text.lower(q)
      let query =
        keyset.query(
          "p.id, p.name, p.country, p.city, p.birth_date",
          from,
          order,
          Page(..page, limit: everyone),
        )
      use rows <- result.map(
        store.query(read, query.sql, query.args, {
          use id <- decode.field(0, id.player_decoder())
          use name <- decode.field(1, decode.string)
          use country <- decode.field(2, decode.string)
          use city <- decode.field(3, decode.optional(decode.string))
          use dob <- decode.field(4, decode.string)
          use keys <- decode.then(keyset.keys_decoder(5, order))
          let found = fn(text) { string.contains(js_text.lower(text), needle) }
          let matches =
            found(name)
            || found(country)
            || case city {
              Some(c) -> found(c) && age.is_adult(dob, country, now)
              None -> False
            }
          decode.success(#(id, keys, matches))
        }),
      )
      let #(items, next) =
        rows
        |> list.filter(fn(r) { r.2 })
        |> paging.page_of(page.limit, fn(r) { r.1 })
      #(list.map(items, fn(r) { r.0 }), next)
    }
  }
}

/// Every admitted player: the text search reads them all.
const everyone = 1_000_000_000

/// `GET /org/players`.
pub fn directory(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use f <- http.query(req, filter_shape(), [])
  let now = clock.now_ms()
  case
    paging.read(
      paging.Query(f.limit, f.cursor),
      keyset.kinds(directory_order(a.org)),
    )
  {
    Error(e) -> page_refused(e)
    Ok(page) -> {
      let found =
        store.read(ctx.store, fn(read) {
          use #(ids, next) <- result.try(directory_page(
            read,
            a.org,
            f,
            page,
            now,
          ))
          use rows <- result.map(players.for_org_many(read, ids, a.org, now))
          #(rows, next)
        })
      case found {
        Error(failure) -> http.internal(failure)
        Ok(#(rows, next)) ->
          pages.respond(
            list.filter_map(rows, fn(r) {
              players.org_view(r.0, a.org, r.1, now) |> option.to_result(Nil)
            }),
            next,
            fn(j) { j },
          )
          |> wisp.set_header(
            "x-scoutbox-ordering",
            case orgs.is_grassroots(a.org) {
              True ->
                "first_team_seeker,distance,profile_completeness,player_id"
              False -> "academy_plus,profile_completeness,player_id"
            },
          )
      }
    }
  }
}

fn page_refused(e: paging.PageError) -> Response {
  let #(code, message) = paging.error_body(e)
  http.error_message(400, code, message)
}

// ---------------------------------------------------------------------------------------------- film room

const clip_order_sql = "(m.verified_clip_attendance_id IS NOT NULL)"

fn clip_order() -> List(keyset.OrderKey) {
  [
    OrderKey(sql.text(clip_order_sql), Desc, IntKind),
    OrderKey(sql.text("m.views"), Desc, IntKind),
    OrderKey(sql.text("m.player_id"), Asc, TextKind),
    OrderKey(sql.text("m.position"), Asc, IntKind),
  ]
}

/// `GET /org/filmroom`: the playable clips of the players the club may see, verified clips first, then the most
/// viewed.
pub fn film_room(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  let order = clip_order()
  use page <- pages.strict(req, keyset.kinds(order))
  let now = clock.now_ms()
  let found =
    store.read(ctx.store, fn(read) {
      let query =
        keyset.query(
          "m.player_id, m.id",
          sql.concat([
            sql.text(
              "player_media m JOIN players p ON p.id = m.player_id WHERE m.url IS NOT NULL AND ",
            ),
            admitted(a.org, now, []),
          ]),
          order,
          page,
        )
      use rows <- result.try(
        store.query(read, query.sql, query.args, {
          use player_id <- decode.field(0, id.player_decoder())
          use media_id <- decode.field(1, id.media_decoder())
          use keys <- decode.then(keyset.keys_decoder(2, order))
          decode.success(#(player_id, media_id, keys))
        }),
      )
      let #(items, next) = paging.page_of(rows, page.limit, fn(r) { r.2 })
      use seen <- result.map(players.for_org_many(
        read,
        list.map(items, fn(r) { r.0 }) |> list.unique,
        a.org,
        now,
      ))
      let by_id = dict.from_list(list.map(seen, fn(s) { #({ s.0 }.row.id, s) }))
      let clips =
        list.filter_map(items, fn(r) {
          use #(p, access) <- result.try(dict.get(by_id, r.0))
          use media <- result.try(
            list.find(p.media, fn(m) { m.clip.id == r.1 }),
          )
          use view <- result.map(
            players.org_view(p, a.org, access, now) |> option.to_result(Nil),
          )
          clip_json(p, media, view, now)
        })
      #(clips, next)
    })
  case found {
    Ok(#(clips, next)) -> pages.respond(clips, next, fn(j) { j })
    Error(failure) -> http.internal(failure)
  }
}

fn clip_json(
  p: players.Player,
  m: players.Media,
  _view: Json,
  now: Int,
) -> Json {
  let r = p.row
  json.object([
    #(
      "media",
      json.object([
        #("id", id.media_json(m.clip.id)),
        #("title", json.string(m.clip.title)),
        #("url", json.nullable(m.clip.url, json.string)),
        #("views", json.int(m.clip.views)),
        #(
          "verifiedClip",
          json.nullable(m.clip.verified_clip_attendance_id, id.attendance_json),
        ),
        #(
          "tags",
          json.object(list.map(m.tags, fn(t) { #(t.0, json.int(t.1)) })),
        ),
      ]),
    ),
    #(
      "player",
      json.object([
        #("id", id.player_json(r.id)),
        #("name", json.string(r.name)),
        #(
          "position",
          json.nullable(
            option.map(r.position, positions.to_string),
            json.string,
          ),
        ),
        #("age", json.nullable(age.age_on(r.birth_date, now), json.int)),
        #("trustScore", json.int(players.profile_signal(p))),
        #("academyPlus", json.bool(r.academy_plus)),
        #("guardianManaged", json.bool(!players.is_adult(p, now))),
      ]),
    ),
  ])
}

// ----------------------------------------------------------------------------------------------- fixtures

/// `GET /org/fixtures`: the (date, fixture) groups of the attendances of the players the club may see, the
/// newest date first. Each group lists its attendances in the players' creation order, with the first venue.
pub fn fixtures(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use page <- pages.strict(req, [TextKind, TextKind])
  let now = clock.now_ms()
  let found =
    store.read(ctx.store, fn(read) {
      let beyond = case page.after {
        Some([TextKey(date), TextKey(fixture)]) ->
          sql.concat([
            sql.text(" AND (a.match_date < "),
            sql.arg(sqlight.text(date)),
            sql.text(" OR (a.match_date = "),
            sql.arg(sqlight.text(date)),
            sql.text(" AND a.fixture > "),
            sql.arg(sqlight.text(fixture)),
            sql.text("))"),
          ])
        _ -> sql.text("")
      }
      let groups =
        sql.concat([
          sql.text(
            "SELECT a.match_date, a.fixture FROM player_attendance a JOIN players p ON p.id = a.player_id WHERE ",
          ),
          admitted(a.org, now, []),
          beyond,
          sql.text(
            " GROUP BY a.match_date, a.fixture ORDER BY a.match_date DESC, a.fixture ASC LIMIT ",
          ),
          sql.arg(sqlight.int(page.limit + 1)),
        ])
      use rows <- result.try(
        store.query(read, groups.sql, groups.args, {
          use date <- decode.field(0, decode.string)
          use fixture <- decode.field(1, decode.string)
          decode.success(#(date, fixture))
        }),
      )
      let #(items, next) =
        paging.page_of(rows, page.limit, fn(g) { [TextKey(g.0), TextKey(g.1)] })
      let members =
        sql.concat([
          sql.text(
            "SELECT "
            <> row.qualified("p")
            <> ", a.match_date, a.fixture, a.venue FROM json_each(",
          ),
          sql.arg(
            json.array(items, fn(g) {
              json.preprocessed_array([json.string(g.0), json.string(g.1)])
            })
            |> json.to_string
            |> sqlight.text,
          ),
          sql.text(
            ") j CROSS JOIN player_attendance a ON a.match_date = j.value ->> 0 AND a.fixture = j.value ->> 1 JOIN players p ON p.id = a.player_id WHERE ",
          ),
          admitted(a.org, now, []),
          sql.text(" ORDER BY p.rowid, a.position"),
        ])
      use member_rows <- result.map(
        store.query(read, members.sql, members.args, {
          use player <- decode.then(row.decoder())
          use date <- decode.field(row.width, decode.string)
          use fixture <- decode.field(row.width + 1, decode.string)
          use venue <- decode.field(
            row.width + 2,
            decode.optional(decode.string),
          )
          decode.success(#(date, fixture, venue, player))
        }),
      )
      let groups_json =
        list.map(items, fn(g) {
          let in_group =
            list.filter(member_rows, fn(m) { m.0 == g.0 && m.1 == g.1 })
          let venue = case in_group {
            [first, ..] -> first.2
            [] -> None
          }
          json.object([
            #("fixture", json.string(g.1)),
            #("venue", json.nullable(venue, json.string)),
            #("date", json.string(g.0)),
            #(
              "players",
              json.array(in_group, fn(m) {
                let p = m.3
                json.object([
                  #("id", id.player_json(p.id)),
                  #("name", json.string(p.name)),
                  #(
                    "position",
                    json.nullable(
                      option.map(p.position, positions.to_string),
                      json.string,
                    ),
                  ),
                  #(
                    "age",
                    json.nullable(age.age_on(p.birth_date, now), json.int),
                  ),
                  #("trustScore", json.int(p.profile_signal)),
                ])
              }),
            ),
          ])
        })
      #(groups_json, next)
    })
  case found {
    Ok(#(groups, next)) -> pages.respond(groups, next, fn(j) { j })
    Error(failure) -> http.internal(failure)
  }
}
