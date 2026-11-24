//// Checks of the rules from the rules suites of agents/compliance, first generated from the TypeScript server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import gleam/option.{None, Some}
import scoutbox/agents/verification_provider
import scoutbox/rows/agent_profile_facets
import scoutbox/rows/id
import scoutbox/vocab/agent_facet
import scoutbox/vocab/facet_state
import scoutbox/vocab/jurisdiction

// compliance: facetFromProviderAnswer — [neg] H1 STALE stores a VERIFIED facet whose recheck date has already passed — it reads STALE, never VERIFIED
pub fn neg_h1_stale_stores_a_verified_facet_whose_recheck_date_has_already_pass_test() {
  assert verification_provider.facet_record(
      verification_provider.Answer(
        state: verification_provider.AnswerStale,
        verified_at: Some(1_787_097_599_999),
        recheck_at: Some(1_789_689_599_999),
        synthetic: True,
        at: 1_789_689_600_000,
        note: "Verified in the past by the LOCAL SYNTHETIC test provider; its recheck window has lapsed. This is not a FIFA, FA or U.S. Soccer register check and never exists in production.",
      ),
      id.agent_profile("ap"),
      agent_facet.FifaLicence,
      None,
      "x",
      1_789_689_600_000,
    )
    == Some(
      agent_profile_facets.Row(
        ..agent_profile_facets.new(
          profile_id: id.agent_profile("ap"),
          facet: agent_facet.FifaLicence,
          member_association: jurisdiction.INT,
          state: facet_state.Verified,
        ),
        reference: Some("x"),
        provenance_provider: Some(
          agent_profile_facets.LocalSyntheticTestProvider,
        ),
        provenance_kind: Some(agent_profile_facets.Synthetic),
        provenance_at: Some(1_789_689_600_000),
        submitted_at: Some(1_789_689_600_000),
        verified_at: Some(1_787_097_599_999),
        recheck_at: Some(1_789_689_599_999),
        note: Some(
          "Verified in the past by the LOCAL SYNTHETIC test provider; its recheck window has lapsed. This is not a FIFA, FA or U.S. Soccer register check and never exists in production.",
        ),
      ),
    )
}

// compliance: facetFromProviderAnswer — [neg] I1 UNAVAILABLE writes NOTHING to a facet
pub fn neg_i1_unavailable_writes_nothing_to_a_facet_test() {
  assert verification_provider.facet_record(
      verification_provider.Answer(
        state: verification_provider.AnswerUnavailable,
        verified_at: None,
        recheck_at: None,
        synthetic: True,
        at: 1_789_689_600_000,
        note: "The LOCAL SYNTHETIC test provider simulated an outage.",
      ),
      id.agent_profile("ap"),
      agent_facet.FifaLicence,
      None,
      "x",
      1_789_689_600_000,
    )
    == None
}

// compliance: facetFromProviderAnswer — [neg] I2 NOT_VERIFIED stores UNVERIFIED, never INACTIVE and never VERIFIED
pub fn neg_i2_not_verified_stores_unverified_never_inactive_and_never_verified_test() {
  assert verification_provider.facet_record(
      verification_provider.Answer(
        state: verification_provider.AnswerNotVerified,
        verified_at: None,
        recheck_at: None,
        synthetic: True,
        at: 1_789_689_600_000,
        note: "No matching record at the LOCAL SYNTHETIC test provider. This is not a FIFA, FA or U.S. Soccer register check and never exists in production.",
      ),
      id.agent_profile("ap"),
      agent_facet.FifaLicence,
      None,
      "x",
      1_789_689_600_000,
    )
    == Some(
      agent_profile_facets.Row(
        ..agent_profile_facets.new(
          profile_id: id.agent_profile("ap"),
          facet: agent_facet.FifaLicence,
          member_association: jurisdiction.INT,
          state: facet_state.Unverified,
        ),
        reference: Some("x"),
        provenance_provider: Some(
          agent_profile_facets.LocalSyntheticTestProvider,
        ),
        provenance_kind: Some(agent_profile_facets.Synthetic),
        provenance_at: Some(1_789_689_600_000),
        submitted_at: Some(1_789_689_600_000),
        verified_at: None,
        recheck_at: None,
        note: Some(
          "No matching record at the LOCAL SYNTHETIC test provider. This is not a FIFA, FA or U.S. Soccer register check and never exists in production.",
        ),
      ),
    )
}
