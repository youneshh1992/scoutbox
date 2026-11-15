//// The HTTP contract every route shares: JSON responses, the error body, reading a JSON body and a query.

import gleam/bit_array
import gleam/dict
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/http/request
import gleam/json.{type Json}
import gleam/list
import gleam/result
import gleam/string
import scoutbox/platform/input.{type Refusal, type Shape}
import wisp.{type Request, type Response}

pub fn json(status: Int, body: Json) -> Response {
  wisp.json_response(json.to_string(body), status)
}

/// A 500 with fixed text; the detail goes to the log, never to the client.
pub fn internal(detail: a) -> Response {
  wisp.log_error("internal error: " <> string.inspect(detail))
  json(
    500,
    json.object([
      #("error", json.string("INTERNAL")),
      #("message", json.string("Something went wrong handling that request.")),
      #("requestId", json.null()),
    ]),
  )
}

/// `{ error }`: a refusal whose code says it all.
pub fn error(status: Int, code: String) -> Response {
  json(status, json.object([#("error", json.string(code))]))
}

/// `{ error, message }`. The message is English for developers; clients read the code.
pub fn error_message(status: Int, code: String, message: String) -> Response {
  json(
    status,
    json.object([
      #("error", json.string(code)),
      #("message", json.string(message)),
    ]),
  )
}

pub fn refused(refusal: Refusal) -> Response {
  json(400, input.refusal_json(refusal))
}

/// A field a domain requires under a code of its own: `{ error, field, problem: "required" }`.
pub fn required(code: String, field: String) -> Response {
  json(
    400,
    json.object([
      #("error", json.string(code)),
      #("field", json.string(field)),
      #("problem", json.string("required")),
    ]),
  )
}

fn malformed_json() -> Response {
  json(
    400,
    json.object([
      #("error", json.string("MALFORMED_JSON")),
      #("message", json.string("The request body is not valid JSON.")),
      #("requestId", json.null()),
    ]),
  )
}

/// The JSON body, as sent. No body (or one that is not JSON-typed) reads as `{}`; a body that does not parse, or
/// is a bare string or number, is MALFORMED_JSON, as the Express server's strict JSON parser has it.
pub fn json_body(req: Request, next: fn(Dynamic) -> Response) -> Response {
  let is_json = case request.get_header(req, "content-type") {
    Ok(ct) -> string.starts_with(string.lowercase(ct), "application/json")
    Error(Nil) -> False
  }
  case is_json, wisp.read_body_bits(req) {
    False, _ -> next(empty_object())
    True, Error(Nil) -> malformed_json()
    True, Ok(bits) ->
      case bit_array.to_string(bits) {
        Error(Nil) -> malformed_json()
        Ok(text) ->
          case string.trim(text) {
            "" -> next(empty_object())
            _ ->
              case json.parse(text, decode.dynamic) {
                Error(_) -> malformed_json()
                Ok(value) ->
                  case dynamic.classify(value) {
                    "Dict" | "List" -> next(value)
                    _ -> malformed_json()
                  }
              }
          }
      }
  }
}

fn empty_object() -> Dynamic {
  dynamic.properties([])
}

/// The JSON body read with `shape`, or the 400 that refuses it.
pub fn body(
  req: Request,
  shape: Shape(a),
  codes: List(#(String, String)),
  next: fn(a) -> Response,
) -> Response {
  use raw <- json_body(req)
  case input.parse(shape, raw, root: "body", codes:) {
    Ok(value) -> next(value)
    Error(refusal) -> refused(refusal)
  }
}

/// The query string read with `shape`. A parameter sent twice arrives as a list, so a text field refuses it.
pub fn query(
  req: Request,
  shape: Shape(a),
  codes: List(#(String, String)),
  next: fn(a) -> Response,
) -> Response {
  let grouped =
    wisp.get_query(req)
    |> list.group(fn(pair) { pair.0 })
    |> dict.to_list
    |> list.map(fn(entry) {
      let #(key, pairs) = entry
      let values =
        list.reverse(pairs) |> list.map(fn(pair) { dynamic.string(pair.1) })
      case values {
        [one] -> #(dynamic.string(key), one)
        many -> #(dynamic.string(key), dynamic.list(many))
      }
    })
  case input.parse(shape, dynamic.properties(grouped), root: "query", codes:) {
    Ok(value) -> next(value)
    Error(refusal) -> refused(refusal)
  }
}

pub fn header(req: Request, name: String) -> Result(String, Nil) {
  request.get_header(req, name)
}

/// The bearer token presented, if any.
pub fn bearer(req: Request) -> Result(String, Nil) {
  use value <- result.try(request.get_header(req, "authorization"))
  case value {
    "Bearer " <> token -> Ok(token)
    _ -> Error(Nil)
  }
}

pub fn nullable(value: Result(a, Nil), to_json: fn(a) -> Json) -> Json {
  case value {
    Ok(v) -> to_json(v)
    Error(Nil) -> json.null()
  }
}
