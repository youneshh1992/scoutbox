//// The verification provider's answers (createVerificationProvider in domains/agents/compliance/provider.mjs),
//// ported from the agents/compliance rules suite (G2 to I2). The TypeScript provider is an object of closures, one
//// per facet, which the recorder can't keep; here it is `verification_provider.answer`, called with the facet.
//// facetFromProviderAnswer's recorded calls are generated (battery/agents/verification_provider_test).

import gleam/json
import gleam/option.{None, Some}
import scoutbox/agents/agent_rules
import scoutbox/agents/verification_provider.{
  AnswerManualReview, AnswerNotVerified, AnswerStale, AnswerUnavailable,
  AnswerVerified,
}
import scoutbox/rows/id
import scoutbox/vocab/agent_facet.{
  DomesticAuthorisation, FifaLicence, MinorsAuthorisation, NationalRegistration,
}
import scoutbox/vocab/facet_state

const t0 = 1_789_689_600_000

pub fn production_has_no_provider_test() {
  // G2: even a TEST reference is manual review, and the status says no register is connected.
  let a =
    verification_provider.answer(False, FifaLicence, "TEST-VERIFIED-1", t0)
  assert a.state == AnswerManualReview
  assert !a.synthetic
  assert json.to_string(verification_provider.status_json(False))
    == "{\"provider\":\"none\",\"live\":false,\"registers\":{\"fifa\":\"not_connected\",\"fa\":\"not_connected\",\"ussf\":\"not_connected\"},\"note\":\"No governing-body register is connected. Submissions are queued for attributed Trust & Safety review; a cached VERIFIED facet is usable only until its own recheck date.\"}"
}

pub fn the_synthetic_provider_verifies_its_own_tagged_references_test() {
  // G3: and names itself.
  let a = verification_provider.answer(True, FifaLicence, "TEST-VERIFIED-1", t0)
  assert a.state == AnswerVerified
  assert a.synthetic
  assert a.verified_at == Some(t0)
  assert a.recheck_at == Some(t0 + agent_rules.recheck_ms)
}

pub fn a_real_looking_reference_is_still_manual_review_test() {
  // G4
  let a =
    verification_provider.answer(True, NationalRegistration, "FA-12345", t0)
  assert a.state == AnswerManualReview
  assert !a.synthetic
}

pub fn stale_stores_a_verified_facet_whose_recheck_has_passed_test() {
  // H1: it reads STALE, never VERIFIED.
  let a = verification_provider.answer(True, FifaLicence, "TEST-STALE-1", t0)
  assert a.state == AnswerStale
  let assert Some(f) =
    verification_provider.facet_record(
      a,
      id.agent_profile("ap"),
      FifaLicence,
      None,
      "x",
      t0,
    )
  assert f.state == facet_state.Verified
  let assert Some(recheck) = f.recheck_at
  assert recheck < t0
}

pub fn unavailable_writes_nothing_to_a_facet_test() {
  // I1
  let a =
    verification_provider.answer(
      True,
      DomesticAuthorisation,
      "TEST-UNAVAILABLE-1",
      t0,
    )
  assert a.state == AnswerUnavailable
  assert verification_provider.facet_record(
      a,
      id.agent_profile("ap"),
      DomesticAuthorisation,
      None,
      "x",
      t0,
    )
    == None
}

pub fn not_verified_stores_unverified_test() {
  // I2: never INACTIVE and never VERIFIED.
  let a =
    verification_provider.answer(
      True,
      MinorsAuthorisation,
      "TEST-NOTVERIFIED-1",
      t0,
    )
  assert a.state == AnswerNotVerified
  let assert Some(f) =
    verification_provider.facet_record(
      a,
      id.agent_profile("ap"),
      MinorsAuthorisation,
      None,
      "x",
      t0,
    )
  assert f.state == facet_state.Unverified
}
