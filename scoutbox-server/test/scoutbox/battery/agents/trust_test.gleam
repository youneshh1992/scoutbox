//// Checks of the rules from the rules suites of agents/crossApp, first generated from the TypeScript server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import gleam/option.{None, Some}
import scoutbox/battery/base
import scoutbox/passport/trust
import scoutbox/rows/id
import scoutbox/rows/representation_agreements

// crossApp: agreementInForce — #37d and it requires confirmedAt AND an active status
pub fn t_37d_and_it_requires_confirmedat_and_an_active_status_test() {
  assert trust.agreement_in_force(
      representation_agreements.Row(
        ..base.agreement(),
        id: id.agreement("r"),
        agent_user_id: id.org_user("u"),
        client_id: "p",
        status: representation_agreements.Active,
        confirmed_at: Some(1_789_689_600_000),
        start_at: Some(1_789_689_600_000),
        end_at: Some(1_792_368_000_000),
      ),
      1_789_776_000_000,
    )
    == True
}

// crossApp: agreementInForce — #37d and it requires confirmedAt AND an active status
pub fn t_37d_and_it_requires_confirmedat_and_an_active_status_2_test() {
  assert trust.agreement_in_force(
      representation_agreements.Row(
        ..base.agreement(),
        id: id.agreement("r"),
        agent_user_id: id.org_user("u"),
        client_id: "p",
        status: representation_agreements.Active,
        confirmed_at: None,
        start_at: Some(1_789_689_600_000),
        end_at: Some(1_792_368_000_000),
      ),
      1_789_776_000_000,
    )
    == False
}

// crossApp: agreementInForce — #37d and it requires confirmedAt AND an active status
pub fn t_37d_and_it_requires_confirmedat_and_an_active_status_3_test() {
  assert trust.agreement_in_force(
      representation_agreements.Row(
        ..base.agreement(),
        id: id.agreement("r"),
        agent_user_id: id.org_user("u"),
        client_id: "p",
        status: representation_agreements.Disputed,
        confirmed_at: Some(1_789_689_600_000),
        start_at: Some(1_789_689_600_000),
        end_at: Some(1_792_368_000_000),
      ),
      1_789_776_000_000,
    )
    == False
}

// crossApp: agreementInForce — #37d and it requires confirmedAt AND an active status
pub fn t_37d_and_it_requires_confirmedat_and_an_active_status_4_test() {
  assert trust.agreement_in_force(
      representation_agreements.Row(
        ..base.agreement(),
        id: id.agreement("r"),
        agent_user_id: id.org_user("u"),
        client_id: "p",
        status: representation_agreements.TerminatedByClient,
        confirmed_at: Some(1_789_689_600_000),
        start_at: Some(1_789_689_600_000),
        end_at: Some(1_792_368_000_000),
      ),
      1_789_776_000_000,
    )
    == False
}

// crossApp: agreementInForce — #37e and a term covering now, so a lapsed agreement (or one not yet started) contributes nothing
pub fn t_37e_and_a_term_covering_now_so_a_lapsed_agreement_or_one_not_yet_started_test() {
  assert trust.agreement_in_force(
      representation_agreements.Row(
        ..base.agreement(),
        id: id.agreement("r"),
        agent_user_id: id.org_user("u"),
        client_id: "p",
        status: representation_agreements.Active,
        confirmed_at: Some(1_789_689_600_000),
        start_at: Some(1_789_689_600_000),
        end_at: Some(1_789_775_999_999),
      ),
      1_789_776_000_000,
    )
    == False
}

// crossApp: agreementInForce — #37e and a term covering now, so a lapsed agreement (or one not yet started) contributes nothing
pub fn t_37e_and_a_term_covering_now_so_a_lapsed_agreement_or_one_not_yet_started_2_test() {
  assert trust.agreement_in_force(
      representation_agreements.Row(
        ..base.agreement(),
        id: id.agreement("r"),
        agent_user_id: id.org_user("u"),
        client_id: "p",
        status: representation_agreements.Active,
        confirmed_at: Some(1_789_689_600_000),
        start_at: Some(1_789_862_400_000),
        end_at: Some(1_792_368_000_000),
      ),
      1_789_776_000_000,
    )
    == False
}
