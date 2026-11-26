//// Cross-origin access, as the TypeScript server's `cors` middleware answers it.

import gleam/http
import gleam/http/request
import gleam/http/response
import gleam/list
import scoutbox/platform/cors
import wisp
import wisp/simulate

const listed = ["https://club.example", "https://agent.example"]

fn from(origin: String) {
  simulate.request(http.Get, "/healthz")
  |> request.set_header("origin", origin)
}

fn header(r: wisp.Response, name: String) -> Result(String, Nil) {
  response.get_header(r, name)
}

pub fn a_listed_origin_is_echoed_and_varies_test() {
  let r = cors.handle(listed, from("https://agent.example"), wisp.ok)
  assert header(r, "access-control-allow-origin") == Ok("https://agent.example")
  assert header(r, "vary") == Ok("Origin")
  assert header(r, "access-control-expose-headers")
    == Ok("Retry-After,X-Request-Id,X-ScoutBox-Ordering,X-ScoutBox-Schema")
}

pub fn an_unlisted_origin_gets_no_cors_header_at_all_test() {
  let r = cors.handle(listed, from("https://evil.example"), wisp.ok)
  assert r.status == 200
  assert list.filter(r.headers, fn(h) {
      h.0 == "vary"
      || h.0 == "access-control-allow-origin"
      || h.0 == "access-control-expose-headers"
    })
    == []
}

pub fn no_origin_is_let_through_without_one_to_echo_test() {
  let r = cors.handle(listed, simulate.request(http.Get, "/healthz"), wisp.ok)
  assert header(r, "access-control-allow-origin") == Error(Nil)
  assert header(r, "vary") == Ok("Origin")
}

pub fn with_no_list_any_origin_may_read_test() {
  let r = cors.handle([], from("https://evil.example"), wisp.ok)
  assert header(r, "access-control-allow-origin") == Ok("*")
  assert header(r, "vary") == Error(Nil)
}

pub fn a_preflight_is_answered_here_test() {
  let req =
    from("https://club.example")
    |> request.set_method(http.Options)
    |> request.set_header("access-control-request-headers", "authorization")
  let r =
    cors.handle(listed, req, fn() { panic as "a preflight reached a route" })
  assert r.status == 204
  assert header(r, "access-control-allow-origin") == Ok("https://club.example")
  assert header(r, "access-control-allow-methods")
    == Ok("GET,HEAD,PUT,PATCH,POST,DELETE")
  assert header(r, "access-control-allow-headers") == Ok("authorization")
  assert header(r, "vary") == Ok("Origin, Access-Control-Request-Headers")
}

pub fn a_route_s_own_vary_is_kept_test() {
  let r =
    cors.handle(listed, from("https://club.example"), fn() {
      wisp.ok() |> wisp.set_header("vary", "Accept-Encoding")
    })
  assert header(r, "vary") == Ok("Accept-Encoding, Origin")
}

pub fn the_setting_is_trimmed_and_empty_entries_dropped_test() {
  assert cors.parse_allowed(Ok(" https://a.example, ,https://b.example,"))
    == ["https://a.example", "https://b.example"]
  assert cors.parse_allowed(Error(Nil)) == []
}
