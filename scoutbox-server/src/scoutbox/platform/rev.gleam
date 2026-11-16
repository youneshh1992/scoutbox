//// Optimistic concurrency for collaborative records (domains/platform/concurrency.mjs). A request may send the
//// `expectedRev` (or `expectedVersion`) it was editing; when the record has moved on, the write is a 409 instead of
//// a lost update. Without one, the write is unguarded.
////
//// Comments, tags, tasks and notes are not versioned: a lost update there is an inconvenience, and demanding a rev
//// for trivial edits trains people to send whatever number makes the error go away.

import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/float
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/string
import scoutbox/platform/http
import scoutbox/platform/input.{type Shape}
import wisp.{type Response}

/// A record's revision, and who moved it last. A record with no revision is at 1.
pub type Rev {
  Rev(rev: Int, at: Option(Int), by_name: Option(String))
}

/// What the request asked for.
pub type Expected {
  Unguarded
  Expected(Int)
}

/// The revision the body names, read as sent and before its shape is judged, as `guardRev` reads it: absent, null
/// or empty is unguarded; a whole number of zero or more, or text that reads as one, is that revision.
pub fn expected(body: Dynamic) -> Result(Expected, Response) {
  let named = fn(key) {
    case decode.run(body, decode.at([key], decode.dynamic)) {
      Ok(v) ->
        case dynamic.classify(v) {
          "Nil" -> None
          _ -> Some(v)
        }
      Error(_) -> None
    }
  }
  let raw = case named("expectedRev") {
    Some(v) -> Some(v)
    None -> named("expectedVersion")
  }
  case raw {
    None -> Ok(Unguarded)
    Some(v) ->
      case
        decode.run(v, decode.int),
        decode.run(v, decode.float),
        decode.run(v, decode.string)
      {
        Ok(n), _, _ -> whole(n)
        _, Ok(f), _ ->
          case float.floor(f) == f {
            True -> whole(float.truncate(f))
            False -> Error(invalid())
          }
        _, _, Ok("") -> Ok(Unguarded)
        _, _, Ok(text) -> number_text(text)
        _, _, _ -> Error(invalid())
      }
  }
}

fn whole(n: Int) -> Result(Expected, Response) {
  case n >= 0 {
    True -> Ok(Expected(n))
    False -> Error(invalid())
  }
}

/// JavaScript's `Number(text)` for the forms a revision is sent in.
fn number_text(text: String) -> Result(Expected, Response) {
  case string.trim(text) {
    "" -> Ok(Expected(0))
    t ->
      case int.parse(t), float.parse(t) {
        Ok(n), _ -> whole(n)
        _, Ok(f) ->
          case float.floor(f) == f {
            True -> whole(float.truncate(f))
            False -> Error(invalid())
          }
        _, _ -> Error(invalid())
      }
  }
}

fn invalid() -> Response {
  http.error_message(
    400,
    "EXPECTED_REV_INVALID",
    "expectedRev must be a whole number.",
  )
}

/// Proceeds when the request is unguarded or names the current revision; otherwise the 409. The conflict names
/// who moved the record and when, and the caller's `current` fields, never the colleague's content: the caller
/// reloads through its own authorised read.
pub fn guard(
  expected: Expected,
  current: Rev,
  code: String,
  fields: List(#(String, Json)),
  next: fn() -> Response,
) -> Response {
  case expected {
    Unguarded -> next()
    Expected(n) if n == current.rev -> next()
    Expected(n) ->
      http.json(
        409,
        json.object(
          list.flatten([
            [
              #("error", json.string(code)),
              #("expectedRev", json.int(n)),
              #("currentRev", json.int(current.rev)),
              // A display name, never a user id.
              #("updatedBy", json.nullable(current.by_name, json.string)),
              #("updatedAt", json.nullable(current.at, json.int)),
            ],
            fields,
            [
              #(
                "message",
                json.string(
                  "Someone else changed this while you were working on it. Reload to see their change, then apply yours.",
                ),
              ),
            ],
          ]),
        ),
      )
  }
}

/// `rev`, `revAt` and `revBy` (a name), as a record's view carries them.
pub fn meta(r: Rev) -> List(#(String, Json)) {
  [
    #("rev", json.int(r.rev)),
    #("revAt", json.nullable(r.at, json.int)),
    #("revBy", json.nullable(r.by_name, json.string)),
  ]
}

/// The body fields `guard` reads, accepted by a shape so they are not unknown fields. Their own code is
/// EXPECTED_REV_INVALID (`codes`).
pub fn fields(next: fn() -> Shape(a)) -> Shape(a) {
  use _ <- input.field(
    "expectedRev",
    input.nullish(input.whole_number(0, 9_007_199_254_740_991)),
  )
  use _ <- input.field(
    "expectedVersion",
    input.nullish(input.whole_number(0, 9_007_199_254_740_991)),
  )
  next()
}

pub const codes = [
  #("expectedRev", "EXPECTED_REV_INVALID"),
  #("expectedVersion", "EXPECTED_REV_INVALID"),
]
