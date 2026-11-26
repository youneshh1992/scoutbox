//// Checks of the rules from the rules suites of platform/dates, first generated from the TypeScript server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import gleam/option.{None, Some}
import scoutbox/agents/conflict
import scoutbox/rows/id
import scoutbox/vocab/party_role

// dates: consentSufficiency — K9 control: consent granted a day before the first act
pub fn k9_control_consent_granted_a_day_before_the_first_act_test() {
  assert conflict.consent_sufficiency(
      conflict.Consent(
        kind: "dual_representation",
        status: "granted",
        revoked_at: None,
        granted_at: Some(1_790_078_400_000),
        context_id: "c",
        agent_user_id: "a",
        party_role: Some(party_role.Individual),
        subject_id: None,
        signatory: None,
        policy_versions: [id.policy("v1")],
        full_particulars: False,
        legal_advice: False,
      ),
      party_role.Individual,
      "a",
      "c",
      Some(1_790_164_800_000),
      False,
      [id.policy("v1")],
    )
    == Ok(Nil)
}

// dates: consentSufficiency — [neg] K10 consent after the first act is not in advance
pub fn neg_k10_consent_after_the_first_act_is_not_in_advance_test() {
  assert conflict.consent_sufficiency(
      conflict.Consent(
        kind: "dual_representation",
        status: "granted",
        revoked_at: None,
        granted_at: Some(1_790_164_800_001),
        context_id: "c",
        agent_user_id: "a",
        party_role: Some(party_role.Individual),
        subject_id: None,
        signatory: None,
        policy_versions: [id.policy("v1")],
        full_particulars: False,
        legal_advice: False,
      ),
      party_role.Individual,
      "a",
      "c",
      Some(1_790_164_800_000),
      False,
      [id.policy("v1")],
    )
    == Error("CONSENT_NOT_IN_ADVANCE")
}

// dates: consentSufficiency — [neg] K11 an undated grant null is not a grant (NaN used to pass typeof AND the in-advance test)
pub fn neg_k11_an_undated_grant_null_is_not_a_grant_nan_used_to_pass_typeof_and_test() {
  assert conflict.consent_sufficiency(
      conflict.Consent(
        kind: "dual_representation",
        status: "granted",
        revoked_at: None,
        granted_at: None,
        context_id: "c",
        agent_user_id: "a",
        party_role: Some(party_role.Individual),
        subject_id: None,
        signatory: None,
        policy_versions: [id.policy("v1")],
        full_particulars: False,
        legal_advice: False,
      ),
      party_role.Individual,
      "a",
      "c",
      Some(1_790_164_800_000),
      False,
      [id.policy("v1")],
    )
    == Error("CONSENT_MISSING")
}

// dates: consentSufficiency — [neg] K11 an undated grant undefined is not a grant (NaN used to pass typeof AND the in-advance test)
pub fn neg_k11_an_undated_grant_undefined_is_not_a_grant_nan_used_to_pass_typeo_test() {
  assert conflict.consent_sufficiency(
      conflict.Consent(
        kind: "dual_representation",
        status: "granted",
        revoked_at: None,
        granted_at: None,
        context_id: "c",
        agent_user_id: "a",
        party_role: Some(party_role.Individual),
        subject_id: None,
        signatory: None,
        policy_versions: [id.policy("v1")],
        full_particulars: False,
        legal_advice: False,
      ),
      party_role.Individual,
      "a",
      "c",
      Some(1_790_164_800_000),
      False,
      [id.policy("v1")],
    )
    == Error("CONSENT_MISSING")
}
