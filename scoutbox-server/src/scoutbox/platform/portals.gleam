//// The web portals this server hosts: each one a built single-page app in a folder under PUBLIC_DIR, served at its
//// own path, as the TypeScript server's `registerAppHosting` does. The server never builds them; the deploy image
//// puts each build in its folder.
////
//// A path with a file in the build is that file. Any other GET under the portal's path is its `index.html`, so the
//// app's own routes work on a reload or a deep link, except a path whose last segment names a file (has a `.`):
//// that answers 404, so a stale tab asking for an asset a new deploy replaced fails visibly instead of being given
//// HTML. Vite's hashed assets (`assets/`) may be cached for good; everything else is revalidated, so a deploy shows
//// at once.

import gleam/http.{Get}
import gleam/http/request
import gleam/http/response
import gleam/list
import gleam/string
import simplifile
import wisp.{type Request, type Response}

pub type Portal {
  /// Served at `/<segment>` from the build in `dir`.
  Portal(segment: String, dir: String)
}

/// Each portal's path and the folder under PUBLIC_DIR its build is in.
const layout = [
  #("app", "club"),
  #("console", "admin"),
  #("grassroots", "grassroots"),
  #("agent", "agent"),
]

/// The portals whose build is present (its folder holds an `index.html`), read once at boot. A portal that wasn't
/// built isn't served.
pub fn mounted(public_dir: String) -> List(Portal) {
  list.filter_map(layout, fn(pair) {
    let dir = public_dir <> "/" <> pair.1
    case simplifile.is_file(dir <> "/index.html") {
      Ok(True) -> Ok(Portal(segment: pair.0, dir:))
      _ -> Error(Nil)
    }
  })
}

/// A line for the boot log naming what is served where.
pub fn describe(portals: List(Portal)) -> String {
  case portals {
    [] -> "no web portals built: none served"
    _ ->
      "serving web portals: "
      <> string.join(
        list.map(portals, fn(p) { "/" <> p.segment <> " from " <> p.dir }),
        ", ",
      )
  }
}

/// Answers a GET under a mounted portal's path, or runs `otherwise`. The router calls it after every API route has
/// had its chance, as the TypeScript server registers its hosting last.
pub fn serve(
  portals: List(Portal),
  req: Request,
  segments: List(String),
  otherwise: fn() -> Response,
) -> Response {
  case req.method, segments {
    Get, [first, ..rest] ->
      case list.find(portals, fn(p) { p.segment == first }) {
        Ok(portal) -> serve_portal(portal, req, rest, otherwise)
        Error(Nil) -> otherwise()
      }
    _, _ -> otherwise()
  }
}

fn serve_portal(
  portal: Portal,
  req: Request,
  rest: List(String),
  otherwise: fn() -> Response,
) -> Response {
  let under = "/" <> portal.segment
  let answer = {
    use <- wisp.serve_static(req, under:, from: portal.dir)
    case names_a_file(rest) {
      True -> otherwise()
      False -> {
        let index = request.Request(..req, path: under <> "/index.html")
        use <- wisp.serve_static(index, under:, from: portal.dir)
        otherwise()
      }
    }
  }
  cached(answer, rest)
}

/// Whether a path's last segment names a file (`main.js`, `favicon.ico`) rather than an app route.
fn names_a_file(rest: List(String)) -> Bool {
  case list.last(rest) {
    Ok(last) -> string.contains(last, ".")
    Error(Nil) -> False
  }
}

fn cached(answer: Response, rest: List(String)) -> Response {
  case answer.status, rest {
    200, ["assets", _, ..] | 206, ["assets", _, ..] | 304, ["assets", _, ..] ->
      response.set_header(
        answer,
        "cache-control",
        "public, max-age=31536000, immutable",
      )
    200, _ | 206, _ | 304, _ ->
      response.set_header(answer, "cache-control", "no-cache")
    _, _ -> answer
  }
}
