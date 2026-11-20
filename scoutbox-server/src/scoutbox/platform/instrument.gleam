//// Request instrumentation, as the TypeScript server's `requestInstrumentation` (domains/platform/metrics.mjs) does
//// it in front of every route: a correlation id, the process's request counters, and one redacted log line.
////
//// It stands where the TypeScript server installs it: after CORS, the HTTP baseline and the fault layer, so a
//// preflight or a simulated fault has no correlation id and isn't counted or logged. Nor is a refusal of a body
//// that couldn't be read, which the TypeScript server gives before instrumentation (`http.correlate`).

import gleam/bool
import gleam/http
import gleam/http/request
import gleam/io
import gleam/json
import gleam/regexp
import gleam/result
import gleam/string
import scoutbox/platform/clock
import scoutbox/platform/http as contract
import scoutbox/platform/request_metrics.{type RequestMetrics}
import scoutbox/platform/secrets
import wisp.{type Request, type Response}

/// The longest path a log line names.
const logged_path_max = 120

pub fn handle(
  metrics: RequestMetrics,
  quiet_logs: Bool,
  req: Request,
  next: fn() -> Response,
) -> Response {
  let started = clock.now_ms()
  let request_id = correlation_id(req)
  case contract.correlate(next(), request_id) {
    contract.BeforeInstrumentation(answer) -> answer
    contract.Correlated(answer) -> {
      let ms = clock.now_ms() - started
      request_metrics.finished_request(
        metrics,
        path: req.path,
        status: answer.status,
        ms:,
      )
      use <- bool.lazy_guard(quiet_logs, fn() { answer })
      // Redacted: no headers, query, body or anything else the request carried but its path.
      io.println(
        json.to_string(
          json.object([
            #("t", json.int(clock.now_ms())),
            #("id", json.string(request_id)),
            #("m", json.string(http.method_to_string(req.method))),
            #("p", json.string(string.slice(req.path, 0, logged_path_max))),
            #("s", json.int(answer.status)),
            #("ms", json.int(ms)),
          ]),
        ),
      )
      answer
    }
  }
}

/// The caller's `X-Request-Id` when it is a plausible id, else a fresh one.
pub fn correlation_id(req: Request) -> String {
  let assert Ok(plausible) = regexp.from_string("^[a-zA-Z0-9_-]{6,64}$")
  request.get_header(req, "x-request-id")
  |> result.try(fn(sent) {
    case regexp.check(plausible, sent) {
      True -> Ok(sent)
      False -> Error(Nil)
    }
  })
  |> result.lazy_unwrap(fn() { "req_" <> secrets.random_hex(8) })
}
