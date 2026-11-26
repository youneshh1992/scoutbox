//// The Trust Score rules' calls the recorder can't keep (scripts/rules/passport/trustScore.mjs in the TypeScript
//// tree): an agreement that names no licensed individual, and projections for viewers this server has no type for.

import gleam/json
import gleam/option.{None, Some}
import gleam/string
import scoutbox/battery/base
import scoutbox/passport/trust
import scoutbox/passport/trust_rules
import scoutbox/rows/representation_agreements

/// "and it refuses a row that names no licensed individual". A stored agreement always names one (`agent_user_id`
/// is NOT NULL and typed), so the rule is left with the rest: confirmed, active and within its term.
pub fn an_agreement_counts_only_when_confirmed_and_active_test() {
  let active =
    representation_agreements.Row(
      ..base.agreement(),
      status: representation_agreements.Active,
      confirmed_at: Some(1),
      start_at: Some(1),
    )
  assert trust.agreement_in_force(active, 2)
  assert !trust.agreement_in_force(
    representation_agreements.Row(..active, confirmed_at: None),
    2,
  )
  assert !trust.agreement_in_force(
    representation_agreements.Row(..active, start_at: Some(3)),
    2,
  )
}

/// U13: "a blocked public projection is null", "an allowed public projection carries score and band only" and "an
/// unknown viewer receives nothing". No route asks for a public projection, so the viewers here have none, and no
/// other viewer can be named. The narrowest that exists, a club's, carries no component, gap or record.
pub fn a_club_projection_carries_no_records_test() {
  let p =
    trust_rules.calculate(trust_rules.Input(
      is_adult: True,
      identity: Some(trust_rules.Authoritative),
      history: [trust_rules.HistoryRow("h1", "verified_club_confirmed", True)],
      relationships: [],
      evidence: [],
      box_sessions: [],
      combine: [],
      references: [],
      assessments: [],
      allow_simulated: False,
    ))
  let club =
    trust_rules.projection(p, trust_rules.ProClubViewer)
    |> json.to_string
  assert !string.contains(club, "\"components\"")
  assert !string.contains(club, "\"gaps\"")
  assert !string.contains(club, "\"detail\"")
  assert string.contains(club, "\"score\"")
}
