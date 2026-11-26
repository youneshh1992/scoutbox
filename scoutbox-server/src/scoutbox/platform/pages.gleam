//// Cursor paging at the route: read the page asked for, refuse junk, answer `{ items, nextCursor }`.

import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import scoutbox/platform/http
import scoutbox/platform/paging.{type KeyKind, type Page}
import wisp.{type Request, type Response}

fn refuse(e: paging.PageError) -> Response {
  let #(code, message) = paging.error_body(e)
  http.error_message(400, code, message)
}

/// `?limit=&cursor=` and nothing else: another parameter is refused, as the console's routes do.
pub fn strict(
  req: Request,
  kinds: List(KeyKind),
  next: fn(Page) -> Response,
) -> Response {
  use query <- http.query(req, paging.query_shape(), [])
  case paging.read(query, kinds) {
    Error(e) -> refuse(e)
    Ok(page) -> next(page)
  }
}

/// `?limit=&cursor=`, other parameters ignored. Either sent twice is junk.
pub fn lenient(
  req: Request,
  kinds: List(KeyKind),
  next: fn(Page) -> Response,
) -> Response {
  let query = wisp.get_query(req)
  let one = fn(name) {
    case list.filter(query, fn(pair) { pair.0 == name }) {
      [] -> Ok(None)
      [#(_, value)] -> Ok(Some(value))
      _ -> Error(Nil)
    }
  }
  case one("limit"), one("cursor") {
    Error(Nil), _ -> refuse(paging.LimitInvalid)
    _, Error(Nil) -> refuse(paging.CursorInvalid)
    Ok(limit), Ok(cursor) ->
      case paging.read(paging.Query(limit:, cursor:), kinds) {
        Error(e) -> refuse(e)
        Ok(page) -> next(page)
      }
  }
}

pub fn respond(
  items: List(a),
  next: Option(String),
  view: fn(a) -> Json,
) -> Response {
  http.json(
    200,
    json.object([
      #("items", json.array(items, view)),
      #("nextCursor", json.nullable(next, json.string)),
    ]),
  )
}
