//// A guarded write names the revision it was editing (domains/platform/concurrency.mjs); a client key is text
//// (domains/platform/idempotency.mjs).

import gleam/dynamic/decode
import gleam/json
import gleam/option.{None, Some}
import scoutbox/platform/idempotency
import scoutbox/platform/rev.{Expected, Rev, Unguarded}
import wisp

fn body(text: String) {
  let assert Ok(d) = json.parse(text, decode.dynamic)
  d
}

pub fn absent_null_or_empty_is_unguarded_test() {
  assert rev.expected(body("{}")) == Ok(Unguarded)
  assert rev.expected(body("{\"expectedRev\":null}")) == Ok(Unguarded)
  assert rev.expected(body("{\"expectedRev\":\"\"}")) == Ok(Unguarded)
}

pub fn a_whole_number_or_its_text_is_the_revision_test() {
  assert rev.expected(body("{\"expectedRev\":3}")) == Ok(Expected(3))
  assert rev.expected(body("{\"expectedRev\":\"4\"}")) == Ok(Expected(4))
  assert rev.expected(body("{\"expectedRev\":2.0}")) == Ok(Expected(2))
  assert rev.expected(body("{\"expectedVersion\":5}")) == Ok(Expected(5))
  // expectedRev wins over the older spelling.
  assert rev.expected(body("{\"expectedRev\":1,\"expectedVersion\":5}"))
    == Ok(Expected(1))
}

pub fn anything_else_is_refused_test() {
  let refused = fn(text) {
    case rev.expected(body(text)) {
      Error(r) -> r.status == 400
      Ok(_) -> False
    }
  }
  // productionHardening §5: a non-numeric, fractional or negative token is malformed, never coerced to 0.
  assert refused("{\"expectedRev\":\"soon\"}")
  assert refused("{\"expectedRev\":2.5}")
  assert refused("{\"expectedRev\":-1}")
  assert refused("{\"expectedRev\":1.5}")
  assert refused("{\"expectedRev\":\"x\"}")
  assert refused("{\"expectedRev\":true}")
  assert refused("{\"expectedRev\":{\"toString\":1}}")
}

pub fn a_stale_revision_is_a_conflict_test() {
  let current = Rev(rev: 3, at: Some(10), by_name: Some("Maria"))
  assert { rev.guard(Unguarded, current, "X", [], wisp.ok) }.status == 200
  assert { rev.guard(Expected(3), current, "X", [], wisp.ok) }.status == 200
  assert { rev.guard(Expected(2), current, "X", [], wisp.ok) }.status == 409
}

pub fn a_client_key_is_trimmed_text_of_at_most_64_test() {
  let key = fn(text) {
    idempotency.client_key(Some(body("[" <> text <> "]") |> first))
  }
  assert idempotency.client_key(None) == Ok(None)
  assert key("null") == Ok(None)
  assert key("\"\"") == Ok(None)
  assert key("\" k1 \"") == Ok(Some("k1"))
  assert key("\"   \"") == Error("clientKey must be 1–64 characters.")
  assert key("12") == Error("clientKey must be text.")
}

fn first(d) {
  let assert Ok(x) = decode.run(d, decode.at([0], decode.dynamic))
  x
}
