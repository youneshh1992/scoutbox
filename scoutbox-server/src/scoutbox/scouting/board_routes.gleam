//// `GET /player/opportunity-board` and the guardian's view of a child's (domains/scouting/journeys.mjs): the
//// player's board, paged by (deadline, id) after the per-player visibility filter.

import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type PlayerAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/players.{type Player}
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/paging
import scoutbox/platform/store
import scoutbox/rows/id
import scoutbox/scouting/opportunity_board
import wisp.{type Request, type Response}

fn key(item: opportunity_board.Item) -> #(String, String) {
  #(opportunity_board.deadline(item), opportunity_board.item_id(item))
}

fn compare(a: #(String, String), b: #(String, String)) -> order.Order {
  case string.compare(a.0, b.0) {
    order.Eq -> string.compare(a.1, b.1)
    o -> o
  }
}

pub fn player_board(ctx: Ctx, req: Request, p: PlayerAccess) -> Response {
  use items, next <- board(ctx, req, p.player)
  json.object([
    #("items", items),
    #("nextCursor", json.nullable(next, json.string)),
    #("minor", json.bool(p.minor)),
    #("note", case p.minor {
      True ->
        json.string(
          "Applications for under-18s are made by your parent/guardian.",
        )
      False -> json.null()
    }),
  ])
}

/// `GET /guardian/children/:id/opportunity-board`: the child's board, as the child reads it, without the note.
pub fn child_board(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  child_id: id.PlayerId,
) -> Response {
  case list.contains(g.child_ids, child_id) {
    False -> http.error(403, "NOT_YOUR_CHILD")
    True ->
      case store.read(ctx.store, players.by_id(_, child_id)) {
        Error(failure) -> http.internal(failure)
        Ok(None) -> http.error(404, "PLAYER_NOT_FOUND")
        Ok(Some(child)) -> {
          use items, next <- board(ctx, req, child)
          json.object([
            #("items", items),
            #("nextCursor", json.nullable(next, json.string)),
          ])
        }
      }
  }
}

fn board(
  ctx: Ctx,
  req: Request,
  player: Player,
  view: fn(json.Json, Option(String)) -> json.Json,
) -> Response {
  use q <- http.query(req, paging.query_shape(), [])
  case paging.read(q, [paging.TextKind, paging.TextKind]) {
    Error(e) -> {
      let #(code, message) = paging.error_body(e)
      http.error_message(400, code, message)
    }
    Ok(page) -> {
      let now = clock.now_ms()
      case
        store.read(ctx.store, fn(r) {
          opportunity_board.for_player(r, player, now)
        })
      {
        Error(failure) -> http.internal(failure)
        Ok(items) -> {
          let sorted = list.sort(items, fn(a, b) { compare(key(a), key(b)) })
          let rest = case page.after {
            Some([paging.TextKey(d), paging.TextKey(i)]) ->
              list.filter(sorted, fn(x) { compare(key(x), #(d, i)) == order.Gt })
            _ -> sorted
          }
          let #(items, next) =
            paging.page_of(rest, page.limit, fn(x) {
              let #(d, i) = key(x)
              [paging.TextKey(d), paging.TextKey(i)]
            })
          http.json(
            200,
            view(
              json.array(items, fn(x) {
                json.object(opportunity_board.fields(x))
              }),
              next,
            ),
          )
        }
      }
    }
  }
}
