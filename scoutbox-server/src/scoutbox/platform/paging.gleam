//// Cursor paging: `?limit=<1..100>&cursor=<opaque>` → `{ items, nextCursor }`. The cursor is the last row's sort
//// key, so a row inserted mid-paging never shifts what the client has not seen. Junk is refused, never clamped.

import gleam/bit_array
import gleam/dynamic/decode
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/platform/input.{type Shape}

pub const default_limit = 50

pub const max_limit = 100

/// One part of a sort key.
pub type Key {
  IntKey(Int)
  TextKey(String)
}

pub type KeyKind {
  IntKind
  TextKind
}

pub type Page {
  Page(limit: Int, after: Option(List(Key)))
}

pub type PageError {
  LimitInvalid
  CursorInvalid
}

pub type Query {
  Query(limit: Option(String), cursor: Option(String))
}

/// `?limit=&cursor=`, each once, as text. `read` judges them.
pub fn query_shape() -> Shape(Query) {
  use limit <- input.field("limit", input.nullish(input.text(1000)))
  use cursor <- input.field("cursor", input.nullish(input.text(100_000)))
  input.done(Query(limit:, cursor:))
}

/// The page asked for, with `shape` the kinds of the list's sort key in order.
pub fn read(query: Query, shape: List(KeyKind)) -> Result(Page, PageError) {
  use limit <- result.try(case query.limit {
    None | Some("") -> Ok(default_limit)
    Some(text) ->
      case all_digits(text), int.parse(text) {
        True, Ok(n) if n >= 1 && n <= max_limit -> Ok(n)
        _, _ -> Error(LimitInvalid)
      }
  })
  use after <- result.map(case query.cursor {
    None | Some("") -> Ok(None)
    Some(cursor) -> decode_cursor(cursor, shape) |> result.map(Some)
  })
  Page(limit:, after:)
}

fn all_digits(s: String) -> Bool {
  s != ""
  && list.all(string.to_graphemes(s), fn(g) { string.contains("0123456789", g) })
}

fn decode_cursor(
  cursor: String,
  shape: List(KeyKind),
) -> Result(List(Key), PageError) {
  let key = {
    use <- bool_guard(string.length(cursor) <= 512)
    use bits <- result.try(bit_array.base64_url_decode(cursor))
    use text <- result.try(bit_array.to_string(bits))
    use parts <- result.try(
      json.parse(text, decode.list(decode.dynamic)) |> result.replace_error(Nil),
    )
    case list.length(parts) == list.length(shape) {
      False -> Error(Nil)
      True ->
        list.zip(parts, shape)
        |> list.try_map(fn(pair) {
          case pair.1 {
            IntKind -> decode.run(pair.0, decode.int) |> result.map(IntKey)
            TextKind -> decode.run(pair.0, decode.string) |> result.map(TextKey)
          }
          |> result.replace_error(Nil)
        })
    }
  }
  result.replace_error(key, CursorInvalid)
}

fn bool_guard(ok: Bool, next: fn() -> Result(a, Nil)) -> Result(a, Nil) {
  case ok {
    True -> next()
    False -> Error(Nil)
  }
}

pub fn encode_cursor(key: List(Key)) -> String {
  json.array(key, fn(k) {
    case k {
      IntKey(n) -> json.int(n)
      TextKey(s) -> json.string(s)
    }
  })
  |> json.to_string
  |> bit_array.from_string
  |> bit_array.base64_url_encode(False)
}

/// `rows` holds up to `limit + 1` rows in page order; `key_of(row)` is the row's sort key.
pub fn page_of(
  rows: List(a),
  limit: Int,
  key_of: fn(a) -> List(Key),
) -> #(List(a), Option(String)) {
  let items = list.take(rows, limit)
  case list.length(rows) > limit, list.last(items) {
    True, Ok(last) -> #(items, Some(encode_cursor(key_of(last))))
    _, _ -> #(items, None)
  }
}

/// `{ error, message }` for a page that cannot be read.
pub fn error_body(error: PageError) -> #(String, String) {
  case error {
    LimitInvalid -> #(
      "PAGE_LIMIT_INVALID",
      "limit must be a whole number from 1 to " <> int.to_string(max_limit),
    )
    CursorInvalid -> #(
      "PAGE_CURSOR_INVALID",
      "cursor is not a cursor this list handed out",
    )
  }
}
