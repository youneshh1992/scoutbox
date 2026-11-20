//// Request instrumentation: a correlation id on every answer it hands on, and none on a refusal of a body that
//// couldn't be read, which the TypeScript server gives before its instrumentation.

import gleam/dynamic/decode
import gleam/http
import gleam/http/request
import gleam/http/response
import gleam/json
import gleam/option
import gleam/string
import scoutbox/platform/http as contract
import scoutbox/platform/instrument
import scoutbox/platform/request_metrics
import wisp
import wisp/simulate

fn run(req: wisp.Request, next: fn() -> wisp.Response) {
  let assert Ok(m) = request_metrics.start()
  let r = instrument.handle(m, True, req, next)
  #(r, request_metrics.snapshot(m).requests)
}

fn body_request_id(r: wisp.Response) -> Result(String, Nil) {
  let assert wisp.Text(text) = r.body
  let assert Ok(id) =
    json.parse(text, decode.at(["requestId"], decode.optional(decode.string)))
  case id {
    option.Some(id) -> Ok(id)
    option.None -> Error(Nil)
  }
}

pub fn an_answer_carries_a_fresh_correlation_id_test() {
  let #(r, counted) = run(simulate.request(http.Get, "/x"), wisp.ok)
  let assert Ok(id) = response.get_header(r, "x-request-id")
  assert string.starts_with(id, "req_") && string.length(id) == 20
  assert counted == 1
}

pub fn a_plausible_id_the_caller_sent_is_kept_test() {
  let req =
    simulate.request(http.Get, "/x")
    |> request.set_header("x-request-id", "trace_abc-123")
  let #(r, _) = run(req, wisp.ok)
  assert response.get_header(r, "x-request-id") == Ok("trace_abc-123")
}

pub fn an_implausible_id_is_replaced_test() {
  let req =
    simulate.request(http.Get, "/x")
    |> request.set_header("x-request-id", "short")
  let #(r, _) = run(req, wisp.ok)
  let assert Ok(id) = response.get_header(r, "x-request-id")
  assert string.starts_with(id, "req_")
}

pub fn an_internal_error_names_its_correlation_id_test() {
  let #(r, _) =
    run(simulate.request(http.Get, "/x"), fn() { contract.internal("boom") })
  assert r.status == 500
  let assert Ok(id) = response.get_header(r, "x-request-id")
  assert body_request_id(r) == Ok(id)
  assert response.get_header(r, "x-scoutbox-internal") == Error(Nil)
}

pub fn an_unreadable_body_is_refused_before_instrumentation_test() {
  let req =
    simulate.request(http.Post, "/x")
    |> simulate.string_body("{")
    |> request.set_header("content-type", "application/json")
  let #(r, counted) =
    run(req, fn() { contract.json_body(req, fn(_) { wisp.ok() }) })
  assert r.status == 400
  assert response.get_header(r, "x-request-id") == Error(Nil)
  assert response.get_header(r, "x-scoutbox-unread-body") == Error(Nil)
  assert body_request_id(r) == Error(Nil)
  assert counted == 0
}
