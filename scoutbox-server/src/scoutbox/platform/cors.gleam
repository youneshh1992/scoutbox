//// Cross-origin access, as the TypeScript server's `cors` middleware answers it (domains/platform/http.mjs).
//// SCOUTBOX_ALLOWED_ORIGINS unset, any origin may read a response: the API takes bearer tokens, not cookies, so
//// a wildcard is not an open door on its own. Set, only a listed origin is echoed back, and an unlisted one gets
//// no CORS header at all, not even `Vary`, because the middleware passes it straight on.

import gleam/http
import gleam/http/request
import gleam/list
import gleam/result
import gleam/string
import wisp.{type Request, type Response}

/// The headers a browser client may read cross-origin.
const exposed_headers =
  "Retry-After,X-Request-Id,X-ScoutBox-Ordering,X-ScoutBox-Schema"

/// The `cors` package's default methods, which the TypeScript server doesn't change.
const allowed_methods = "GET,HEAD,PUT,PATCH,POST,DELETE"

/// In front of every route. A preflight (`OPTIONS`) from an origin it lets through is answered here with an empty
/// 204, before the HTTP baseline, as the TypeScript server answers it before its own.
pub fn handle(
  allowed: List(String),
  req: Request,
  next: fn() -> Response,
) -> Response {
  let origin = request.get_header(req, "origin")
  let allow_origin = case allowed, origin {
    [], _ -> Ok(Ok("*"))
    _, Error(Nil) -> Ok(Error(Nil))
    _, Ok(o) ->
      case list.contains(allowed, o) {
        True -> Ok(Ok(o))
        False -> Error(Nil)
      }
  }
  case allow_origin {
    // An unlisted origin: the middleware stepped aside.
    Error(Nil) -> next()
    Ok(allow_origin) -> {
      let with_origin = fn(response) {
        let response = case allow_origin {
          Ok(value) ->
            wisp.set_header(response, "access-control-allow-origin", value)
          // No Origin header to echo: a same-origin or non-browser caller.
          Error(Nil) -> response
        }
        case allowed {
          [] -> response
          _ -> vary(response, "Origin")
        }
      }
      case req.method {
        http.Options -> {
          let response =
            wisp.response(204)
            |> with_origin
            |> wisp.set_header("access-control-allow-methods", allowed_methods)
            |> vary("Access-Control-Request-Headers")
          let response = case
            request.get_header(req, "access-control-request-headers")
          {
            Ok(asked) if asked != "" ->
              wisp.set_header(response, "access-control-allow-headers", asked)
            _ -> response
          }
          wisp.set_header(
            response,
            "access-control-expose-headers",
            exposed_headers,
          )
        }
        _ ->
          next()
          |> with_origin
          |> wisp.set_header("access-control-expose-headers", exposed_headers)
      }
    }
  }
}

/// Adds a field to `Vary`, keeping any the response already names, as the `vary` package does.
fn vary(response: Response, field: String) -> Response {
  case list.key_find(response.headers, "vary") {
    Error(Nil) -> wisp.set_header(response, "vary", field)
    Ok(existing) -> {
      let named =
        string.split(existing, ",")
        |> list.map(fn(f) { string.lowercase(string.trim(f)) })
      case
        list.contains(named, "*")
        || list.contains(named, string.lowercase(field))
      {
        True -> response
        False -> wisp.set_header(response, "vary", existing <> ", " <> field)
      }
    }
  }
}

/// SCOUTBOX_ALLOWED_ORIGINS: comma-separated, each trimmed, empty entries dropped.
pub fn parse_allowed(setting: Result(String, Nil)) -> List(String) {
  setting
  |> result.unwrap("")
  |> string.split(",")
  |> list.map(string.trim)
  |> list.filter(fn(o) { o != "" })
}
