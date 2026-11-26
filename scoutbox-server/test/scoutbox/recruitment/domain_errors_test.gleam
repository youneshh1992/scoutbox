//// A code missing from a refusal table, hand-ported from the `sendDomainError` and `sendOfferError` calls of the
//// TypeScript rules suites (recruitment/lifecycle Y2, recruitment/offers A22b), which pass a fake response
//// object. Here `domain_errors.send` builds the response itself.

import gleam/json
import gleam/string
import scoutbox/recruitment/domain_errors
import wisp/simulate

pub fn an_unmapped_lifecycle_code_fails_closed_test() {
  let r =
    domain_errors.send(domain_errors.lifecycle, "LIFECYCLE_NOT_A_REAL_CODE", [
      #("message", json.string("secret detail")),
      #("caseId", json.string("case-x")),
    ])
  assert r.status == 500
  let body = simulate.read_body(r)
  assert body
    == "{\"ok\":false,\"error\":\"LIFECYCLE_INTERNAL\",\"message\":\"The recruitment journey cannot be served for this case. This has been recorded.\"}"
  assert !string.contains(body, "secret") && !string.contains(body, "case-x")
}

pub fn an_unmapped_offer_code_fails_closed_test() {
  let r =
    domain_errors.send(domain_errors.offer, "OFFER_NOT_A_CODE", [
      #("message", json.string("secret detail")),
    ])
  assert r.status == 500
  let body = simulate.read_body(r)
  assert string.contains(body, "\"error\":\"OFFER_STATE_UNKNOWN\"")
  assert !string.contains(body, "secret")
}
