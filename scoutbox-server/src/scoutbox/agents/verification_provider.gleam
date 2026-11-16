//// The regulatory verification provider (domains/agents/compliance/provider.mjs). There is no live FIFA, FA or U.S.
//// Soccer register integration: the production provider is `none` (every answer goes to attributed review), and
//// the synthetic one (AGENT_VERIFICATION_TEST_PROVIDER=1) is a test double that verifies only its own tagged
//// references and names itself in every provenance record.
////
//// UNAVAILABLE never permits anything: the route answers 503 and writes nothing.

import gleam/option.{type Option, None, Some}
import gleam/string
import scoutbox/agents/agent_rules
import scoutbox/rows/agent_profile_facets as facet_row
import scoutbox/rows/id
import scoutbox/vocab/agent_facet.{type AgentFacet, FifaLicence}
import scoutbox/vocab/facet_state
import scoutbox/vocab/jurisdiction.{type Jurisdiction}

pub type AnswerState {
  AnswerVerified
  AnswerNotVerified
  AnswerInactive
  AnswerStale
  AnswerUnavailable
  AnswerManualReview
}

pub type Answer {
  Answer(
    state: AnswerState,
    verified_at: Option(Int),
    recheck_at: Option(Int),
    synthetic: Bool,
    at: Int,
    note: String,
  )
}

const base =
  "This is not a FIFA, FA or U.S. Soccer register check and never exists in production."

fn manual(facet: AgentFacet, now: Int) -> Answer {
  Answer(
    AnswerManualReview,
    None,
    None,
    False,
    now,
    "No "
      <> case facet {
      FifaLicence -> "FIFA"
      _ -> "national"
    }
      <> " register integration exists in this build. A submitted reference is a declaration, not a verification; it has been queued for attributed Trust & Safety review (G-C0).",
  )
}

/// The provider's answer for a reference.
pub fn answer(
  synthetic: Bool,
  facet: AgentFacet,
  reference: String,
  now: Int,
) -> Answer {
  let ref = string.trim(reference) |> string.uppercase
  let tagged = fn(tag) { string.starts_with(ref, tag) }
  case synthetic {
    False -> manual(facet, now)
    True ->
      case
        tagged("TEST-VERIFIED-"),
        tagged("TEST-INACTIVE-"),
        tagged("TEST-STALE-"),
        tagged("TEST-UNAVAILABLE-"),
        tagged("TEST-NOTVERIFIED-")
      {
        True, _, _, _, _ ->
          Answer(
            AnswerVerified,
            Some(now),
            Some(now + agent_rules.recheck_ms),
            True,
            now,
            "Verified by the LOCAL SYNTHETIC test provider. " <> base,
          )
        _, True, _, _, _ ->
          Answer(
            AnswerInactive,
            None,
            None,
            True,
            now,
            "Reported inactive by the LOCAL SYNTHETIC test provider. " <> base,
          )
        _, _, True, _, _ ->
          Answer(
            AnswerStale,
            Some(now - agent_rules.recheck_ms - 1),
            Some(now - 1),
            True,
            now,
            "Verified in the past by the LOCAL SYNTHETIC test provider; its recheck window has lapsed. "
              <> base,
          )
        _, _, _, True, _ ->
          Answer(
            AnswerUnavailable,
            None,
            None,
            True,
            now,
            "The LOCAL SYNTHETIC test provider simulated an outage.",
          )
        _, _, _, _, True ->
          Answer(
            AnswerNotVerified,
            None,
            None,
            True,
            now,
            "No matching record at the LOCAL SYNTHETIC test provider. " <> base,
          )
        _, _, _, _, _ -> manual(facet, now)
      }
  }
}

/// The facet an answer records (facetFromProviderAnswer), or None for an outage, which stores nothing.
pub fn facet_record(
  a: Answer,
  profile_id: id.AgentProfileId,
  facet: AgentFacet,
  ma: Option(Jurisdiction),
  reference: String,
  now: Int,
) -> Option(facet_row.Row) {
  let state = case a.state {
    AnswerUnavailable -> Error(Nil)
    AnswerStale | AnswerVerified -> Ok(facet_state.Verified)
    AnswerNotVerified -> Ok(facet_state.Unverified)
    AnswerInactive -> Ok(facet_state.Inactive)
    AnswerManualReview -> Ok(facet_state.ManualReviewRequired)
  }
  case state {
    Error(Nil) -> None
    Ok(state) ->
      Some(
        facet_row.Row(
          ..facet_row.new(
            profile_id:,
            facet:,
            member_association: case facet {
              FifaLicence -> jurisdiction.INT
              _ -> option.unwrap(ma, jurisdiction.INT)
            },
            state:,
          ),
          reference: Some(reference),
          provenance_provider: Some(case a.synthetic {
            True -> facet_row.LocalSyntheticTestProvider
            False -> facet_row.ProvenanceProviderNone
          }),
          provenance_kind: Some(case a.synthetic {
            True -> facet_row.Synthetic
            False -> facet_row.ProvenanceKindNone
          }),
          provenance_at: Some(a.at),
          submitted_at: Some(now),
          verified_at: a.verified_at,
          recheck_at: a.recheck_at,
          note: Some(a.note),
        ),
      )
  }
}
