//// `GET /player/opportunity-board` (domains/scouting/journeys.mjs): the player's board, paged by (deadline, id)
//// after the per-player visibility filter.

import gleam/json
import gleam/list
import gleam/option.{Some}
import gleam/order
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type PlayerAccess}
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/paging
import scoutbox/platform/store
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
          opportunity_board.for_player(r, p.player, now)
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
            json.object([
              #(
                "items",
                json.array(items, fn(x) {
                  json.object(opportunity_board.fields(x))
                }),
              ),
              #("nextCursor", json.nullable(next, json.string)),
              #("minor", json.bool(p.minor)),
              #("note", case p.minor {
                True ->
                  json.string(
                    "Applications for under-18s are made by your parent/guardian.",
                  )
                False -> json.null()
              }),
            ]),
          )
        }
      }
    }
  }
}
