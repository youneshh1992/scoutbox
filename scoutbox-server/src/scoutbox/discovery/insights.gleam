//// "Who's watching you" (domains/discovery/insights.mjs): the player's side of the Discovery Ledger, counted from
//// its rows. `GET /player/insights`.

import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option}
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/development/record_routes as record
import scoutbox/identity/access.{type PlayerAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/rows/id
import scoutbox/rows/ledger as ledger_row
import scoutbox/safety/ledger
import wisp.{type Response}

const insight_types = [
  "view", "save", "shortlist", "contact_request", "trial_request",
  "contact_request_to_guardian", "trial_request_to_guardian",
]

const week_ms = 604_800_000

const month_ms = 2_592_000_000

type Event {
  Event(
    kind: String,
    org_name: Option(String),
    scout_name: Option(String),
    at: Int,
  )
}

type OrgTally {
  OrgTally(
    org_name: Option(String),
    views: Int,
    saves: Int,
    shortlists: Int,
    requests: Int,
    last_seen: Int,
  )
}

fn events(read: Read, player_id: id.PlayerId) -> Result(List(Event), Fail(e)) {
  use rows <- result_map(ledger.for_player(read, player_id))
  rows
  |> list.map(fn(l: ledger.Logged) {
    let r = l.row
    Event(
      ledger_row.type_to_string(r.type_),
      r.org_name,
      r.actor_name,
      r.occurred_at,
    )
  })
  |> list.filter(fn(e) { list.contains(insight_types, e.kind) })
}

fn result_map(r: Result(a, b), f: fn(a) -> c) -> Result(c, b) {
  case r {
    Ok(v) -> Ok(f(v))
    Error(e) -> Error(e)
  }
}

fn counts(events: List(Event)) -> Json {
  let count = fn(kind) {
    list.count(events, fn(e) { string.starts_with(e.kind, kind) })
  }
  json.object([
    #("views", json.int(count("view"))),
    #("saves", json.int(count("save"))),
    #("shortlists", json.int(count("shortlist"))),
  ])
}

/// One tally per organisation name, in the order each first appears.
fn by_org(events: List(Event)) -> List(OrgTally) {
  list.fold(events, [], fn(acc: List(OrgTally), e: Event) {
    let bump = fn(t: OrgTally) {
      OrgTally(
        ..t,
        views: t.views + bool_int(e.kind == "view"),
        saves: t.saves + bool_int(e.kind == "save"),
        shortlists: t.shortlists + bool_int(e.kind == "shortlist"),
        requests: t.requests + bool_int(string.contains(e.kind, "request")),
        last_seen: int.max(t.last_seen, e.at),
      )
    }
    case list.any(acc, fn(t: OrgTally) { t.org_name == e.org_name }) {
      True ->
        list.map(acc, fn(t: OrgTally) {
          case t.org_name == e.org_name {
            True -> bump(t)
            False -> t
          }
        })
      False -> list.append(acc, [bump(OrgTally(e.org_name, 0, 0, 0, 0, 0))])
    }
  })
  |> list.sort(fn(a, b) { int.compare(b.last_seen, a.last_seen) })
}

fn bool_int(b: Bool) -> Int {
  case b {
    True -> 1
    False -> 0
  }
}

/// A player's views and shortlists this week, as `for_player`'s `thisWeek` counts them.
pub fn this_week(
  read: Read,
  player_id: id.PlayerId,
  now: Int,
) -> Result(#(Int, Int), Fail(e)) {
  use events <- result_map(events(read, player_id))
  let weekly = list.filter(events, fn(e) { e.at >= now - week_ms })
  let count = fn(kind) {
    list.count(weekly, fn(e) { string.starts_with(e.kind, kind) })
  }
  #(count("view"), count("shortlist"))
}

pub fn for_player(
  read: Read,
  player_id: id.PlayerId,
  now: Int,
) -> Result(Json, Fail(e)) {
  use events <- result_map(events(read, player_id))
  let weekly = list.filter(events, fn(e) { e.at >= now - week_ms })
  let monthly = list.filter(events, fn(e) { e.at >= now - month_ms })
  // Eight weeks of views, oldest first.
  let series =
    [7, 6, 5, 4, 3, 2, 1, 0]
    |> list.map(fn(i) {
      let end = now - i * week_ms
      list.count(events, fn(e) {
        e.kind == "view" && e.at >= end - week_ms && e.at < end
      })
    })
  let recent =
    events
    |> list.reverse
    |> list.take(12)
  json.object([
    #("thisWeek", counts(weekly)),
    #("thisMonth", counts(monthly)),
    #("weeklySeries", json.array(series, json.int)),
    #(
      "byOrg",
      json.array(by_org(events), fn(t) {
        json.object([
          #("orgName", json.nullable(t.org_name, json.string)),
          #("views", json.int(t.views)),
          #("saves", json.int(t.saves)),
          #("shortlists", json.int(t.shortlists)),
          #("requests", json.int(t.requests)),
          #("lastSeen", json.int(t.last_seen)),
        ])
      }),
    ),
    #(
      "recent",
      json.array(recent, fn(e) {
        json.object([
          #("type", json.string(e.kind)),
          #("orgName", json.nullable(e.org_name, json.string)),
          #("scoutName", json.nullable(e.scout_name, json.string)),
          #("ts", json.int(e.at)),
        ])
      }),
    ),
  ])
}

/// `GET /guardian/children/:id/insights`: the same view of the guardian's own child.
pub fn child(ctx: Ctx, g: Guardian, child_id: id.PlayerId) -> Response {
  use child <- record.own_child(ctx, g, child_id)
  case store.read(ctx.store, for_player(_, child.row.id, clock.now_ms())) {
    Ok(body) -> http.json(200, body)
    Error(e) -> http.internal(e)
  }
}

pub fn show(ctx: Ctx, p: PlayerAccess) -> Response {
  case store.read(ctx.store, for_player(_, p.player.row.id, clock.now_ms())) {
    Ok(body) -> http.json(200, body)
    Error(e) -> http.internal(e)
  }
}
