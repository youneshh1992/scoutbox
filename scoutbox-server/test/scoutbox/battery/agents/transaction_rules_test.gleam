//// Checks of the rules from the rules suites of agents/transactions, agents/transactionsPersistence, first generated
//// from the TypeScript server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import gleam/json
import gleam/option.{None, Some}
import scoutbox/agents/transaction_rules
import scoutbox/battery/base
import scoutbox/platform/canonical
import scoutbox/rows/id
import scoutbox/rows/transaction_history
import scoutbox/rows/transaction_parties
import scoutbox/vocab/compliance_actor_kind
import scoutbox/vocab/context_outcome
import scoutbox/vocab/context_type
import scoutbox/vocab/party_role
import scoutbox/vocab/pending_reason
import scoutbox/vocab/staleness
import scoutbox/vocab/subject_kind
import scoutbox/vocab/transaction_status

// transactions: complianceStateFrom — D9c a confirmed transaction with no representation rests at PARTIES_CONFIRMED: nothing has been asked of compliance yet
pub fn d9c_a_confirmed_transaction_with_no_representation_rests_at_parties_conf_test() {
  assert transaction_rules.state_from(
      Some(context_outcome.Clear),
      None,
      [],
      0,
      True,
    )
    == transaction_rules.State(
      outcome: Some(context_outcome.Clear),
      reason_codes: [],
      pending_reason: Some(pending_reason.RepresentationMissing),
      blocked: False,
      clear: False,
    )
}

// transactions: statusForComplianceState — D9c a confirmed transaction with no representation rests at PARTIES_CONFIRMED: nothing has been asked of compliance yet
pub fn d9c_a_confirmed_transaction_with_no_representation_rests_at_parties_conf_2_test() {
  assert transaction_rules.status_for(transaction_rules.State(
      outcome: Some(context_outcome.Clear),
      reason_codes: [],
      pending_reason: Some(pending_reason.RepresentationMissing),
      blocked: False,
      clear: False,
    ))
    == transaction_status.PartiesConfirmed
}

// transactions: requiredPartyRoles — B-p3 required parties per type
pub fn b_p3_required_parties_per_type_test() {
  assert transaction_rules.required_party_roles(context_type.EmploymentContract)
    == [party_role.Individual, party_role.EngagingEntity]
}

// transactions: requiredPartyRoles — B-p3 required parties per type
pub fn b_p3_required_parties_per_type_2_test() {
  assert transaction_rules.required_party_roles(context_type.Transfer)
    == [
      party_role.Individual,
      party_role.EngagingEntity,
      party_role.ReleasingEntity,
    ]
}

// transactions: partiesConfirmed — [neg] C-p1 a transfer with no releasing entity is not party-confirmed
pub fn neg_c_p1_a_transfer_with_no_releasing_entity_is_not_party_confirmed_test() {
  assert transaction_rules.parties_confirmed(context_type.Transfer, [
      transaction_parties.Row(
        ..base.transaction_party(),
        id: id.transaction_party("p-individual"),
        party_role: party_role.Individual,
        subject_kind: subject_kind.Player,
        subject_id: "s-individual",
        confirmed_at: Some(1_789_689_600_000),
        removed: False,
      ),
      transaction_parties.Row(
        ..base.transaction_party(),
        id: id.transaction_party("p-engaging_entity"),
        party_role: party_role.EngagingEntity,
        subject_kind: subject_kind.Club,
        subject_id: "s-engaging_entity",
        confirmed_at: Some(1_789_689_600_000),
        removed: False,
      ),
    ])
    == False
}

// transactions: partiesConfirmed — [neg] C-p2 an unconfirmed engaging club is not confirmation — naming a party is not confirming it
pub fn neg_c_p2_an_unconfirmed_engaging_club_is_not_confirmation_naming_a_party_test() {
  assert transaction_rules.parties_confirmed(context_type.Transfer, [
      transaction_parties.Row(
        ..base.transaction_party(),
        id: id.transaction_party("p-individual"),
        party_role: party_role.Individual,
        subject_kind: subject_kind.Player,
        subject_id: "s-individual",
        confirmed_at: Some(1_789_689_600_000),
        removed: False,
      ),
      transaction_parties.Row(
        ..base.transaction_party(),
        id: id.transaction_party("p-engaging_entity"),
        party_role: party_role.EngagingEntity,
        subject_kind: subject_kind.Club,
        subject_id: "s-engaging_entity",
        confirmed_at: None,
        removed: False,
      ),
      transaction_parties.Row(
        ..base.transaction_party(),
        id: id.transaction_party("p-releasing_entity"),
        party_role: party_role.ReleasingEntity,
        subject_kind: subject_kind.Club,
        subject_id: "s-releasing_entity",
        confirmed_at: Some(1_789_689_600_000),
        removed: False,
      ),
    ])
    == False
}

// transactions: partiesConfirmed — C-p3 all three confirmed by their own side → party-confirmed
pub fn c_p3_all_three_confirmed_by_their_own_side_party_confirmed_test() {
  assert transaction_rules.parties_confirmed(context_type.Transfer, [
      transaction_parties.Row(
        ..base.transaction_party(),
        id: id.transaction_party("p-individual"),
        party_role: party_role.Individual,
        subject_kind: subject_kind.Player,
        subject_id: "s-individual",
        confirmed_at: Some(1_789_689_600_000),
        removed: False,
      ),
      transaction_parties.Row(
        ..base.transaction_party(),
        id: id.transaction_party("p-engaging_entity"),
        party_role: party_role.EngagingEntity,
        subject_kind: subject_kind.Club,
        subject_id: "s-engaging_entity",
        confirmed_at: Some(1_789_689_600_000),
        removed: False,
      ),
      transaction_parties.Row(
        ..base.transaction_party(),
        id: id.transaction_party("p-releasing_entity"),
        party_role: party_role.ReleasingEntity,
        subject_kind: subject_kind.Club,
        subject_id: "s-releasing_entity",
        confirmed_at: Some(1_789_689_600_000),
        removed: False,
      ),
    ])
    == True
}

// transactions: partiesConfirmed — [neg] C-p4 a removed party does not count, however confirmed it once was
pub fn neg_c_p4_a_removed_party_does_not_count_however_confirmed_it_once_was_test() {
  assert transaction_rules.parties_confirmed(context_type.Transfer, [
      transaction_parties.Row(
        ..base.transaction_party(),
        id: id.transaction_party("p-individual"),
        party_role: party_role.Individual,
        subject_kind: subject_kind.Player,
        subject_id: "s-individual",
        confirmed_at: Some(1_789_689_600_000),
        removed: True,
      ),
      transaction_parties.Row(
        ..base.transaction_party(),
        id: id.transaction_party("p-engaging_entity"),
        party_role: party_role.EngagingEntity,
        subject_kind: subject_kind.Club,
        subject_id: "s-engaging_entity",
        confirmed_at: Some(1_789_689_600_000),
        removed: False,
      ),
      transaction_parties.Row(
        ..base.transaction_party(),
        id: id.transaction_party("p-releasing_entity"),
        party_role: party_role.ReleasingEntity,
        subject_kind: subject_kind.Club,
        subject_id: "s-releasing_entity",
        confirmed_at: Some(1_789_689_600_000),
        removed: False,
      ),
    ])
    == False
}

// transactions: partiesAwaitingConfirmation — C-p5 the awaiting list names exactly what is missing
pub fn c_p5_the_awaiting_list_names_exactly_what_is_missing_test() {
  assert transaction_rules.awaiting_confirmation(context_type.Transfer, [
      transaction_parties.Row(
        ..base.transaction_party(),
        id: id.transaction_party("p-individual"),
        party_role: party_role.Individual,
        subject_kind: subject_kind.Player,
        subject_id: "s-individual",
        confirmed_at: Some(1_789_689_600_000),
        removed: False,
      ),
      transaction_parties.Row(
        ..base.transaction_party(),
        id: id.transaction_party("p-engaging_entity"),
        party_role: party_role.EngagingEntity,
        subject_kind: subject_kind.Club,
        subject_id: "s-engaging_entity",
        confirmed_at: None,
        removed: False,
      ),
    ])
    == [party_role.EngagingEntity, party_role.ReleasingEntity]
}

// transactions: complianceStateFrom — F-p1 CLEAR with a representation is clear
pub fn f_p1_clear_with_a_representation_is_clear_test() {
  assert transaction_rules.state_from(
      Some(context_outcome.Clear),
      None,
      [],
      1,
      True,
    )
    == transaction_rules.State(
      outcome: Some(context_outcome.Clear),
      reason_codes: [],
      pending_reason: None,
      blocked: False,
      clear: True,
    )
}

// transactions: complianceStateFrom — [neg] F-p3 unconfirmed parties come before any engine answer
pub fn neg_f_p3_unconfirmed_parties_come_before_any_engine_answer_test() {
  assert transaction_rules.state_from(
      Some(context_outcome.Clear),
      None,
      [],
      1,
      False,
    )
    == transaction_rules.State(
      outcome: Some(context_outcome.Clear),
      reason_codes: [],
      pending_reason: Some(pending_reason.PartiesNotConfirmed),
      blocked: False,
      clear: False,
    )
}

// transactions: complianceStateFrom — [neg] F-p4 PROHIBITED_CONFLICT is blocked, not pending
pub fn neg_f_p4_prohibited_conflict_is_blocked_not_pending_test() {
  assert transaction_rules.state_from(
      Some(context_outcome.ProhibitedConflict),
      None,
      [],
      1,
      True,
    )
    == transaction_rules.State(
      outcome: Some(context_outcome.ProhibitedConflict),
      reason_codes: [],
      pending_reason: None,
      blocked: True,
      clear: False,
    )
}

// transactions: complianceStateFrom — [neg] F-p5 consent outstanding is named CONSENT_REQUIRED, never a generic pending
pub fn neg_f_p5_consent_outstanding_is_named_consent_required_never_a_generic_p_test() {
  assert transaction_rules.state_from(
      Some(context_outcome.PermittedDualRepresentationConsentRequired),
      None,
      [],
      1,
      True,
    )
    == transaction_rules.State(
      outcome: Some(context_outcome.PermittedDualRepresentationConsentRequired),
      reason_codes: [],
      pending_reason: Some(pending_reason.ConsentRequired),
      blocked: False,
      clear: False,
    )
}

// transactions: complianceStateFrom — [neg] F-p6 manual review is named
pub fn neg_f_p6_manual_review_is_named_test() {
  assert transaction_rules.state_from(
      Some(context_outcome.ManualRegulatoryReviewRequired),
      None,
      [],
      1,
      True,
    )
    == transaction_rules.State(
      outcome: Some(context_outcome.ManualRegulatoryReviewRequired),
      reason_codes: [],
      pending_reason: Some(pending_reason.ManualReview),
      blocked: False,
      clear: False,
    )
}

// transactions: complianceStateFrom — [neg] F-p7 insufficient data is named
pub fn neg_f_p7_insufficient_data_is_named_test() {
  assert transaction_rules.state_from(
      Some(context_outcome.InsufficientData),
      None,
      [],
      1,
      True,
    )
    == transaction_rules.State(
      outcome: Some(context_outcome.InsufficientData),
      reason_codes: [],
      pending_reason: Some(pending_reason.InsufficientData),
      blocked: False,
      clear: False,
    )
}

// transactions: complianceStateFrom — [neg] F-p8 a gate refusal before the engine keeps its own reason
pub fn neg_f_p8_a_gate_refusal_before_the_engine_keeps_its_own_reason_test() {
  assert transaction_rules.state_from(
      None,
      Some(pending_reason.ProviderUnavailable),
      [],
      0,
      True,
    )
    == transaction_rules.State(
      outcome: None,
      reason_codes: [],
      pending_reason: Some(pending_reason.ProviderUnavailable),
      blocked: False,
      clear: False,
    )
}

// transactions: complianceStateFrom — [neg] F-p8 a gate refusal before the engine keeps its own reason
pub fn neg_f_p8_a_gate_refusal_before_the_engine_keeps_its_own_reason_2_test() {
  assert transaction_rules.state_from(
      None,
      Some(pending_reason.JurisdictionUnsupported),
      [],
      0,
      True,
    )
    == transaction_rules.State(
      outcome: None,
      reason_codes: [],
      pending_reason: Some(pending_reason.JurisdictionUnsupported),
      blocked: False,
      clear: False,
    )
}

// transactions: statusForComplianceState — F-p10 clear → READY, blocked → COMPLIANCE_BLOCKED
pub fn f_p10_clear_ready_blocked_compliance_blocked_test() {
  assert transaction_rules.status_for(transaction_rules.State(
      outcome: Some(context_outcome.Clear),
      reason_codes: [],
      pending_reason: None,
      blocked: False,
      clear: True,
    ))
    == transaction_status.Ready
}

// transactions: complianceStateFrom — F-p10 clear → READY, blocked → COMPLIANCE_BLOCKED
pub fn f_p10_clear_ready_blocked_compliance_blocked_2_test() {
  assert transaction_rules.state_from(
      Some(context_outcome.ProhibitedConflict),
      None,
      [],
      0,
      True,
    )
    == transaction_rules.State(
      outcome: Some(context_outcome.ProhibitedConflict),
      reason_codes: [],
      pending_reason: None,
      blocked: True,
      clear: False,
    )
}

// transactions: statusForComplianceState — F-p10 clear → READY, blocked → COMPLIANCE_BLOCKED
pub fn f_p10_clear_ready_blocked_compliance_blocked_3_test() {
  assert transaction_rules.status_for(transaction_rules.State(
      outcome: Some(context_outcome.ProhibitedConflict),
      reason_codes: [],
      pending_reason: None,
      blocked: True,
      clear: False,
    ))
    == transaction_status.ComplianceBlocked
}

// transactions: complianceStateFrom — F-p11 unconfirmed parties fall back to PARTIES_CONFIRMED; no state says nothing
pub fn f_p11_unconfirmed_parties_fall_back_to_parties_confirmed_no_state_says_n_test() {
  assert transaction_rules.state_from(
      Some(context_outcome.Clear),
      None,
      [],
      0,
      False,
    )
    == transaction_rules.State(
      outcome: Some(context_outcome.Clear),
      reason_codes: [],
      pending_reason: Some(pending_reason.PartiesNotConfirmed),
      blocked: False,
      clear: False,
    )
}

// transactions: statusForComplianceState — F-p11 unconfirmed parties fall back to PARTIES_CONFIRMED; no state says nothing
pub fn f_p11_unconfirmed_parties_fall_back_to_parties_confirmed_no_state_says_n_2_test() {
  assert transaction_rules.status_for(transaction_rules.State(
      outcome: Some(context_outcome.Clear),
      reason_codes: [],
      pending_reason: Some(pending_reason.PartiesNotConfirmed),
      blocked: False,
      clear: False,
    ))
    == transaction_status.PartiesConfirmed
}

// transactions: partyRevisionOf — G-p1 the revision is a stable hash of the inputs
pub fn g_p1_the_revision_is_a_stable_hash_of_the_inputs_test() {
  assert transaction_rules.party_revision(
      [
        transaction_parties.Row(
          ..base.transaction_party(),
          party_role: party_role.Individual,
          subject_kind: subject_kind.Player,
          subject_id: "pl-1",
          confirmed_at: Some(1_789_689_600_000),
        ),
      ],
      "a1",
      [#("a1", party_role.Individual, "verified", Some("ag1"))],
      [#("c1", "granted")],
      canonical.Object([#("fifa_licence", canonical.Str("VERIFIED"))]),
      [id.policy("jp-eng-2026-27-1")],
      [],
      [],
    )
    == "706be58cf0486f12f7ccf90b62f4bbdc04444550e2717f71edaf91372b6a4a9f"
}

// transactions: partyRevisionOf — [neg] G-p2 a change to parties changes the revision — so the old evaluation is stale by definition, not by heuristic
pub fn neg_g_p2_a_change_to_parties_changes_the_revision_so_the_old_evaluation_test() {
  assert transaction_rules.party_revision(
      [
        transaction_parties.Row(
          ..base.transaction_party(),
          party_role: party_role.Individual,
          subject_kind: subject_kind.Player,
          subject_id: "pl-1",
          confirmed_at: Some(1_789_689_600_000),
        ),
        transaction_parties.Row(
          ..base.transaction_party(),
          party_role: party_role.EngagingEntity,
          subject_kind: subject_kind.Club,
          subject_id: "org-1",
        ),
      ],
      "a1",
      [#("a1", party_role.Individual, "verified", Some("ag1"))],
      [#("c1", "granted")],
      canonical.Object([#("fifa_licence", canonical.Str("VERIFIED"))]),
      [id.policy("jp-eng-2026-27-1")],
      [],
      [],
    )
    == "690ec0be9b7c4ddb26d7fb3799478af213dd7dd29597af0b94cffc5bc2a0ec06"
}

// transactions: partyRevisionOf — [neg] G-p2 a change to the agent changes the revision — so the old evaluation is stale by definition, not by heuristic
pub fn neg_g_p2_a_change_to_the_agent_changes_the_revision_so_the_old_evaluatio_test() {
  assert transaction_rules.party_revision(
      [
        transaction_parties.Row(
          ..base.transaction_party(),
          party_role: party_role.Individual,
          subject_kind: subject_kind.Player,
          subject_id: "pl-1",
          confirmed_at: Some(1_789_689_600_000),
        ),
      ],
      "a2",
      [#("a1", party_role.Individual, "verified", Some("ag1"))],
      [#("c1", "granted")],
      canonical.Object([#("fifa_licence", canonical.Str("VERIFIED"))]),
      [id.policy("jp-eng-2026-27-1")],
      [],
      [],
    )
    == "5e2ceba6719dbef51122a0e1a1f5944897f07b61bfcf1619076e28e2e3acec0c"
}

// transactions: partyRevisionOf — [neg] G-p2 a change to representations changes the revision — so the old evaluation is stale by definition, not by heuristic
pub fn neg_g_p2_a_change_to_representations_changes_the_revision_so_the_old_eva_test() {
  assert transaction_rules.party_revision(
      [
        transaction_parties.Row(
          ..base.transaction_party(),
          party_role: party_role.Individual,
          subject_kind: subject_kind.Player,
          subject_id: "pl-1",
          confirmed_at: Some(1_789_689_600_000),
        ),
      ],
      "a1",
      [#("a1", party_role.Individual, "withdrawn", Some("ag1"))],
      [#("c1", "granted")],
      canonical.Object([#("fifa_licence", canonical.Str("VERIFIED"))]),
      [id.policy("jp-eng-2026-27-1")],
      [],
      [],
    )
    == "7b11d40f4bbba1ad451e8b2399ccb3b45a66e318720c608624b53de88ff6e355"
}

// transactions: partyRevisionOf — [neg] G-p2 a change to consents changes the revision — so the old evaluation is stale by definition, not by heuristic
pub fn neg_g_p2_a_change_to_consents_changes_the_revision_so_the_old_evaluation_test() {
  assert transaction_rules.party_revision(
      [
        transaction_parties.Row(
          ..base.transaction_party(),
          party_role: party_role.Individual,
          subject_kind: subject_kind.Player,
          subject_id: "pl-1",
          confirmed_at: Some(1_789_689_600_000),
        ),
      ],
      "a1",
      [#("a1", party_role.Individual, "verified", Some("ag1"))],
      [#("c1", "revoked")],
      canonical.Object([#("fifa_licence", canonical.Str("VERIFIED"))]),
      [id.policy("jp-eng-2026-27-1")],
      [],
      [],
    )
    == "0990ef846b1613595c139ef3bce87f117a904c52d8388a581216a550e03cc157"
}

// transactions: partyRevisionOf — [neg] G-p2 a change to licence facets changes the revision — so the old evaluation is stale by definition, not by heuristic
pub fn neg_g_p2_a_change_to_licence_facets_changes_the_revision_so_the_old_eval_test() {
  assert transaction_rules.party_revision(
      [
        transaction_parties.Row(
          ..base.transaction_party(),
          party_role: party_role.Individual,
          subject_kind: subject_kind.Player,
          subject_id: "pl-1",
          confirmed_at: Some(1_789_689_600_000),
        ),
      ],
      "a1",
      [#("a1", party_role.Individual, "verified", Some("ag1"))],
      [#("c1", "granted")],
      canonical.Object([#("fifa_licence", canonical.Str("STALE"))]),
      [id.policy("jp-eng-2026-27-1")],
      [],
      [],
    )
    == "06ea13ab95bcaf2c6e31d7e96a3438d844dca939409a8d0a5c26438a3857d53d"
}

// transactions: partyRevisionOf — [neg] G-p2 a change to policy versions changes the revision — so the old evaluation is stale by definition, not by heuristic
pub fn neg_g_p2_a_change_to_policy_versions_changes_the_revision_so_the_old_eva_test() {
  assert transaction_rules.party_revision(
      [
        transaction_parties.Row(
          ..base.transaction_party(),
          party_role: party_role.Individual,
          subject_kind: subject_kind.Player,
          subject_id: "pl-1",
          confirmed_at: Some(1_789_689_600_000),
        ),
      ],
      "a1",
      [#("a1", party_role.Individual, "verified", Some("ag1"))],
      [#("c1", "granted")],
      canonical.Object([#("fifa_licence", canonical.Str("VERIFIED"))]),
      [id.policy("jp-eng-2026-27-2")],
      [],
      [],
    )
    == "f2277598bc54990c58a1fc958033a2786309a873b4fb44c87ba556c0b78748b0"
}

// transactions: partyRevisionOf — [neg] G-p2 a change to safeguarding changes the revision — so the old evaluation is stale by definition, not by heuristic
pub fn neg_g_p2_a_change_to_safeguarding_changes_the_revision_so_the_old_evalua_test() {
  assert transaction_rules.party_revision(
      [
        transaction_parties.Row(
          ..base.transaction_party(),
          party_role: party_role.Individual,
          subject_kind: subject_kind.Player,
          subject_id: "pl-1",
          confirmed_at: Some(1_789_689_600_000),
        ),
      ],
      "a1",
      [#("a1", party_role.Individual, "verified", Some("ag1"))],
      [#("c1", "granted")],
      canonical.Object([#("fifa_licence", canonical.Str("VERIFIED"))]),
      [id.policy("jp-eng-2026-27-1")],
      ["pl-1"],
      [],
    )
    == "725b59ae0f8cfc0e0ef1432c34624f2429bfc6ad2970eacfa713155d17db51f9"
}

// transactions: partyRevisionOf — [neg] G-p2 a change to minor state changes the revision — so the old evaluation is stale by definition, not by heuristic
pub fn neg_g_p2_a_change_to_minor_state_changes_the_revision_so_the_old_evaluat_test() {
  assert transaction_rules.party_revision(
      [
        transaction_parties.Row(
          ..base.transaction_party(),
          party_role: party_role.Individual,
          subject_kind: subject_kind.Player,
          subject_id: "pl-1",
          confirmed_at: Some(1_789_689_600_000),
        ),
      ],
      "a1",
      [#("a1", party_role.Individual, "verified", Some("ag1"))],
      [#("c1", "granted")],
      canonical.Object([#("fifa_licence", canonical.Str("VERIFIED"))]),
      [id.policy("jp-eng-2026-27-1")],
      [],
      ["pl-1"],
    )
    == "749e266401c9659783c184d76b81af98e3c7da8388762352b644ec688ec41389"
}

// transactions: partyRevisionOf — [neg] G-p3 losing a party's confirmation changes it too
pub fn neg_g_p3_losing_a_party_s_confirmation_changes_it_too_test() {
  assert transaction_rules.party_revision(
      [
        transaction_parties.Row(
          ..base.transaction_party(),
          party_role: party_role.Individual,
          subject_kind: subject_kind.Player,
          subject_id: "pl-1",
          confirmed_at: None,
        ),
      ],
      "a1",
      [#("a1", party_role.Individual, "verified", Some("ag1"))],
      [#("c1", "granted")],
      canonical.Object([#("fifa_licence", canonical.Str("VERIFIED"))]),
      [id.policy("jp-eng-2026-27-1")],
      [],
      [],
    )
    == "52d59d24135dbdf818bc7deb8b9d8a6040d88cdb84cbea097a2a1e121bdc66c3"
}

// transactions: snapshotStaleness — [neg] G-p5 no snapshot is stale — the absence of an evaluation is never a clearance
pub fn neg_g_p5_no_snapshot_is_stale_the_absence_of_an_evaluation_is_never_a_cl_test() {
  assert transaction_rules.staleness(
      None,
      "706be58cf0486f12f7ccf90b62f4bbdc04444550e2717f71edaf91372b6a4a9f",
      False,
    )
    == Some(staleness.NoSnapshot)
}

// transactions: snapshotStaleness — [neg] G-p6 a different revision is INPUTS_CHANGED
pub fn neg_g_p6_a_different_revision_is_inputs_changed_test() {
  assert transaction_rules.staleness(
      transaction_rules.snapshot_view(
        "atx",
        Some(transaction_rules.Stored(
          evaluation_id: Some(id.evaluation("e1")),
          gate: None,
          evaluated_at: 0,
          pending_reason: None,
          party_revision: "other",
        )),
        None,
      ),
      "706be58cf0486f12f7ccf90b62f4bbdc04444550e2717f71edaf91372b6a4a9f",
      False,
    )
    == Some(staleness.InputsChanged)
}

// transactions: snapshotStaleness — [neg] G-p7 a policy publication flag is POLICY_CHANGED
pub fn neg_g_p7_a_policy_publication_flag_is_policy_changed_test() {
  assert transaction_rules.staleness(
      transaction_rules.snapshot_view(
        "atx",
        Some(transaction_rules.Stored(
          evaluation_id: Some(id.evaluation("e1")),
          gate: None,
          evaluated_at: 0,
          pending_reason: None,
          party_revision: "706be58cf0486f12f7ccf90b62f4bbdc04444550e2717f71edaf91372b6a4a9f",
        )),
        None,
      ),
      "706be58cf0486f12f7ccf90b62f4bbdc04444550e2717f71edaf91372b6a4a9f",
      True,
    )
    == Some(staleness.PolicyChanged)
}

// transactions: snapshotStaleness — G-p8 a matching revision with no flag is current
pub fn g_p8_a_matching_revision_with_no_flag_is_current_test() {
  assert transaction_rules.staleness(
      transaction_rules.snapshot_view(
        "atx",
        Some(transaction_rules.Stored(
          evaluation_id: Some(id.evaluation("e1")),
          gate: None,
          evaluated_at: 0,
          pending_reason: None,
          party_revision: "706be58cf0486f12f7ccf90b62f4bbdc04444550e2717f71edaf91372b6a4a9f",
        )),
        None,
      ),
      "706be58cf0486f12f7ccf90b62f4bbdc04444550e2717f71edaf91372b6a4a9f",
      False,
    )
    == None
}

// transactions: timelineAudienceOf — M-p2 a scoped note is audit-only: an internal note is not a club's timeline entry
pub fn m_p2_a_scoped_note_is_audit_only_an_internal_note_is_not_a_club_s_timeli_test() {
  assert transaction_rules.audience_to_string(transaction_rules.audience_of(
      transaction_history.TransactionNoteAdded,
    ))
    == "audit_only"
}

// transactions: timelineAudienceOf — M-p3 a representation is the agent's regulated act, in the agent's lane
pub fn m_p3_a_representation_is_the_agent_s_regulated_act_in_the_agent_s_lane_test() {
  assert transaction_rules.audience_to_string(transaction_rules.audience_of(
      transaction_history.TransactionRepresentationAttached,
    ))
    == "agent_only"
}

// transactions: timelineAudienceOf — M-p4 status and confirmation reach every party
pub fn m_p4_status_and_confirmation_reach_every_party_test() {
  assert transaction_rules.audience_to_string(transaction_rules.audience_of(
      transaction_history.TransactionStatusChanged,
    ))
    == "all_parties"
}

// transactions: timelineAudienceOf — M-p4 status and confirmation reach every party
pub fn m_p4_status_and_confirmation_reach_every_party_2_test() {
  assert transaction_rules.audience_to_string(transaction_rules.audience_of(
      transaction_history.TransactionPartyConfirmed,
    ))
    == "all_parties"
}

// transactions: timelineAudienceOf — M-p10 a document entry takes its audience from the document, not from "every party"
pub fn m_p10_a_document_entry_takes_its_audience_from_the_document_not_from_eve_test() {
  assert transaction_rules.audience_to_string(transaction_rules.audience_of(
      transaction_history.TransactionDocumentAdded,
    ))
    == "per_document"
}

// transactions: timelineAudienceOf — M-p10 a document entry takes its audience from the document, not from "every party"
pub fn m_p10_a_document_entry_takes_its_audience_from_the_document_not_from_eve_2_test() {
  assert transaction_rules.audience_to_string(transaction_rules.audience_of(
      transaction_history.TransactionDocumentSuperseded,
    ))
    == "per_document"
}

// transactions: actorLabel — M-p13 a reviewer appears as the attributed role, never by name
pub fn m_p13_a_reviewer_appears_as_the_attributed_role_never_by_name_test() {
  assert json.to_string(transaction_rules.actor_label(
      compliance_actor_kind.to_string(compliance_actor_kind.TsReviewer),
      Some("Priya Shah"),
    ))
    == "{\"kind\":\"trust_safety\",\"label\":\"Trust & Safety (attributed)\"}"
}

// transactions: actorLabel — M-p13 a reviewer appears as the attributed role, never by name
pub fn m_p13_a_reviewer_appears_as_the_attributed_role_never_by_name_2_test() {
  assert json.to_string(transaction_rules.actor_label(
      compliance_actor_kind.to_string(compliance_actor_kind.TsReviewer),
      Some("Priya Shah"),
    ))
    == "{\"kind\":\"trust_safety\",\"label\":\"Trust & Safety (attributed)\"}"
}

// transactions: actorLabel — M-p14 a club user and a player are labels too
pub fn m_p14_a_club_user_and_a_player_are_labels_too_test() {
  assert json.to_string(transaction_rules.actor_label(
      compliance_actor_kind.to_string(compliance_actor_kind.ClubUser),
      Some("Maria Keane"),
    ))
    == "{\"kind\":\"club\",\"label\":\"Club signatory\"}"
}

// transactions: actorLabel — M-p14 a club user and a player are labels too
pub fn m_p14_a_club_user_and_a_player_are_labels_too_2_test() {
  assert json.to_string(transaction_rules.actor_label(
      compliance_actor_kind.to_string(compliance_actor_kind.Player),
      Some("Kola"),
    ))
    == "{\"kind\":\"player\",\"label\":\"Player\"}"
}

// transactions: offerReadiness — O-p1 READY + clear + current → readiness true, and it says no offer exists
pub fn o_p1_ready_clear_current_readiness_true_and_it_says_no_offer_exists_test() {
  assert json.to_string(
      transaction_rules.readiness_json(transaction_rules.offer_readiness(
        transaction_status.Ready,
        [
          transaction_parties.Row(
            ..base.transaction_party(),
            party_role: party_role.Individual,
            removed: False,
            confirmed_at: Some(1_789_689_600_000),
          ),
          transaction_parties.Row(
            ..base.transaction_party(),
            party_role: party_role.EngagingEntity,
            removed: False,
            confirmed_at: Some(1_789_689_600_000),
          ),
        ],
        Some(transaction_rules.State(
          outcome: None,
          reason_codes: [],
          pending_reason: None,
          blocked: False,
          clear: True,
        )),
        None,
      )),
    )
    == "{\"canStartOfferWorkflow\":true,\"blockers\":[],\"honest\":\"Readiness means ScoutBox currently permits this workflow to proceed under the encoded rules. No offer exists, no offer can be created here, and nothing has been agreed, approved or signed.\"}"
}

// transactions: offerReadiness — [neg] O-p2 a draft is not ready for an offer
pub fn neg_o_p2_a_draft_is_not_ready_for_an_offer_test() {
  assert json.to_string(
      transaction_rules.readiness_json(transaction_rules.offer_readiness(
        transaction_status.Draft,
        [
          transaction_parties.Row(
            ..base.transaction_party(),
            party_role: party_role.Individual,
            removed: False,
            confirmed_at: Some(1_789_689_600_000),
          ),
          transaction_parties.Row(
            ..base.transaction_party(),
            party_role: party_role.EngagingEntity,
            removed: False,
            confirmed_at: Some(1_789_689_600_000),
          ),
        ],
        Some(transaction_rules.State(
          outcome: None,
          reason_codes: [],
          pending_reason: None,
          blocked: False,
          clear: True,
        )),
        None,
      )),
    )
    == "{\"canStartOfferWorkflow\":false,\"blockers\":[\"TRANSACTION_NOT_READY\"],\"honest\":\"Readiness means ScoutBox currently permits this workflow to proceed under the encoded rules. No offer exists, no offer can be created here, and nothing has been agreed, approved or signed.\"}"
}

// transactions: offerReadiness — [neg] O-p3 a stale snapshot blocks readiness (#11)
pub fn neg_o_p3_a_stale_snapshot_blocks_readiness_11_test() {
  assert json.to_string(
      transaction_rules.readiness_json(transaction_rules.offer_readiness(
        transaction_status.Ready,
        [
          transaction_parties.Row(
            ..base.transaction_party(),
            party_role: party_role.Individual,
            removed: False,
            confirmed_at: Some(1_789_689_600_000),
          ),
          transaction_parties.Row(
            ..base.transaction_party(),
            party_role: party_role.EngagingEntity,
            removed: False,
            confirmed_at: Some(1_789_689_600_000),
          ),
        ],
        Some(transaction_rules.State(
          outcome: None,
          reason_codes: [],
          pending_reason: None,
          blocked: False,
          clear: True,
        )),
        Some(staleness.InputsChanged),
      )),
    )
    == "{\"canStartOfferWorkflow\":false,\"blockers\":[\"COMPLIANCE_SNAPSHOT_STALE\"],\"honest\":\"Readiness means ScoutBox currently permits this workflow to proceed under the encoded rules. No offer exists, no offer can be created here, and nothing has been agreed, approved or signed.\"}"
}

// transactions: offerReadiness — [neg] O-p4 compliance that is not clear blocks readiness
pub fn neg_o_p4_compliance_that_is_not_clear_blocks_readiness_test() {
  assert json.to_string(
      transaction_rules.readiness_json(transaction_rules.offer_readiness(
        transaction_status.Ready,
        [
          transaction_parties.Row(
            ..base.transaction_party(),
            party_role: party_role.Individual,
            removed: False,
            confirmed_at: Some(1_789_689_600_000),
          ),
          transaction_parties.Row(
            ..base.transaction_party(),
            party_role: party_role.EngagingEntity,
            removed: False,
            confirmed_at: Some(1_789_689_600_000),
          ),
        ],
        Some(transaction_rules.State(
          outcome: None,
          reason_codes: [],
          pending_reason: None,
          blocked: False,
          clear: False,
        )),
        None,
      )),
    )
    == "{\"canStartOfferWorkflow\":false,\"blockers\":[\"COMPLIANCE_NOT_CLEAR\"],\"honest\":\"Readiness means ScoutBox currently permits this workflow to proceed under the encoded rules. No offer exists, no offer can be created here, and nothing has been agreed, approved or signed.\"}"
}

// transactions: offerReadiness — [neg] O-p5 an unconfirmed individual blocks readiness
pub fn neg_o_p5_an_unconfirmed_individual_blocks_readiness_test() {
  assert json.to_string(
      transaction_rules.readiness_json(transaction_rules.offer_readiness(
        transaction_status.Ready,
        [
          transaction_parties.Row(
            ..base.transaction_party(),
            party_role: party_role.Individual,
            removed: False,
            confirmed_at: None,
          ),
          transaction_parties.Row(
            ..base.transaction_party(),
            party_role: party_role.EngagingEntity,
            removed: False,
            confirmed_at: None,
          ),
        ],
        Some(transaction_rules.State(
          outcome: None,
          reason_codes: [],
          pending_reason: None,
          blocked: False,
          clear: True,
        )),
        None,
      )),
    )
    == "{\"canStartOfferWorkflow\":false,\"blockers\":[\"INDIVIDUAL_NOT_CONFIRMED\",\"ENGAGING_ENTITY_NOT_CONFIRMED\"],\"honest\":\"Readiness means ScoutBox currently permits this workflow to proceed under the encoded rules. No offer exists, no offer can be created here, and nothing has been agreed, approved or signed.\"}"
}

// transactions: offerReadiness — [neg] O-p7 the readiness object names no offer record, because none exists
pub fn neg_o_p7_the_readiness_object_names_no_offer_record_because_none_exists_test() {
  assert json.to_string(
      transaction_rules.readiness_json(transaction_rules.offer_readiness(
        transaction_status.Ready,
        [
          transaction_parties.Row(
            ..base.transaction_party(),
            party_role: party_role.Individual,
            removed: False,
            confirmed_at: Some(1_789_689_600_000),
          ),
          transaction_parties.Row(
            ..base.transaction_party(),
            party_role: party_role.EngagingEntity,
            removed: False,
            confirmed_at: Some(1_789_689_600_000),
          ),
        ],
        Some(transaction_rules.State(
          outcome: None,
          reason_codes: [],
          pending_reason: None,
          blocked: False,
          clear: True,
        )),
        None,
      )),
    )
    == "{\"canStartOfferWorkflow\":true,\"blockers\":[],\"honest\":\"Readiness means ScoutBox currently permits this workflow to proceed under the encoded rules. No offer exists, no offer can be created here, and nothing has been agreed, approved or signed.\"}"
}

// transactionsPersistence: partyRevisionOf — [neg] a snapshot taken under different inputs is INPUTS_CHANGED
pub fn neg_a_snapshot_taken_under_different_inputs_is_inputs_changed_test() {
  assert transaction_rules.party_revision(
      [],
      "a",
      [],
      [],
      canonical.Object([]),
      [],
      [],
      [],
    )
    == "1302ab56ba07729635ae9726331c736fc7964c872f193faea9ac048d7a0b6dc4"
}

// transactionsPersistence: snapshotStaleness — [neg] a snapshot taken under different inputs is INPUTS_CHANGED
pub fn neg_a_snapshot_taken_under_different_inputs_is_inputs_changed_2_test() {
  assert transaction_rules.staleness(
      transaction_rules.snapshot_view(
        "atx",
        Some(transaction_rules.Stored(
          evaluation_id: Some(id.evaluation("e")),
          gate: None,
          evaluated_at: 0,
          pending_reason: None,
          party_revision: "different",
        )),
        None,
      ),
      "1302ab56ba07729635ae9726331c736fc7964c872f193faea9ac048d7a0b6dc4",
      False,
    )
    == Some(staleness.InputsChanged)
}

// transactionsPersistence: snapshotStaleness — [neg] no snapshot at all is NO_SNAPSHOT — the absence of an evaluation is never a clearance
pub fn neg_no_snapshot_at_all_is_no_snapshot_the_absence_of_an_evaluation_is_ne_test() {
  assert transaction_rules.staleness(
      None,
      "1302ab56ba07729635ae9726331c736fc7964c872f193faea9ac048d7a0b6dc4",
      False,
    )
    == Some(staleness.NoSnapshot)
}
