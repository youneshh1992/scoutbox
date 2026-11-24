//// Checks of the rules from the rules suites of platform/dates, first generated from the TypeScript server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import gleam/option.{None, Some}
import scoutbox/battery/base
import scoutbox/rows/id
import scoutbox/rows/orgs
import scoutbox/rows/ver_claims
import scoutbox/verification/claims
import scoutbox/vocab/verification_method

// dates: effectiveStatus — I1 control: no expiry, verified
pub fn i1_control_no_expiry_verified_test() {
  assert claims.effective_status(
      ver_claims.Row(
        ..base.claim(),
        status: ver_claims.Verified,
        current: True,
        valid_from: Some(1),
        valid_until: None,
        organisation_id: Some(id.org("o1")),
        verification_method: Some(
          verification_method.OrganisationAdminConfirmation,
        ),
      ),
      org: Some(orgs.Row(..base.org(), id: id.org("o1"), suspended: False)),
      subject_removed: False,
      now: 1_790_164_800_000,
    )
    == claims.Effective(
      status: ver_claims.Verified,
      displayable: True,
      current: True,
      historical: False,
      reasons: [],
    )
}

// dates: effectiveStatus — I2 expires in 1ms: still verified
pub fn i2_expires_in_1ms_still_verified_test() {
  assert claims.effective_status(
      ver_claims.Row(
        ..base.claim(),
        status: ver_claims.Verified,
        current: True,
        valid_from: Some(1),
        valid_until: Some(1_790_164_800_001),
        organisation_id: Some(id.org("o1")),
        verification_method: Some(
          verification_method.OrganisationAdminConfirmation,
        ),
      ),
      org: Some(orgs.Row(..base.org(), id: id.org("o1"), suspended: False)),
      subject_removed: False,
      now: 1_790_164_800_000,
    )
    == claims.Effective(
      status: ver_claims.Verified,
      displayable: True,
      current: True,
      historical: False,
      reasons: [],
    )
}

// dates: effectiveStatus — [neg] I3 expires now: expired (exclusive end)
pub fn neg_i3_expires_now_expired_exclusive_end_test() {
  assert claims.effective_status(
      ver_claims.Row(
        ..base.claim(),
        status: ver_claims.Verified,
        current: True,
        valid_from: Some(1),
        valid_until: Some(1_790_164_800_000),
        organisation_id: Some(id.org("o1")),
        verification_method: Some(
          verification_method.OrganisationAdminConfirmation,
        ),
      ),
      org: Some(orgs.Row(..base.org(), id: id.org("o1"), suspended: False)),
      subject_removed: False,
      now: 1_790_164_800_000,
    )
    == claims.Effective(
      status: ver_claims.Expired,
      displayable: False,
      current: False,
      historical: False,
      reasons: [claims.ValidUntilPassed],
    )
}

// dates: effectiveStatus — [neg] I3b expired yesterday
pub fn neg_i3b_expired_yesterday_test() {
  assert claims.effective_status(
      ver_claims.Row(
        ..base.claim(),
        status: ver_claims.Verified,
        current: True,
        valid_from: Some(1),
        valid_until: Some(1_790_078_400_000),
        organisation_id: Some(id.org("o1")),
        verification_method: Some(
          verification_method.OrganisationAdminConfirmation,
        ),
      ),
      org: Some(orgs.Row(..base.org(), id: id.org("o1"), suspended: False)),
      subject_removed: False,
      now: 1_790_164_800_000,
    )
    == claims.Effective(
      status: ver_claims.Expired,
      displayable: False,
      current: False,
      historical: False,
      reasons: [claims.ValidUntilPassed],
    )
}

// dates: effectiveStatus — I5 a closed period stays history (frozen rule untouched)
pub fn i5_a_closed_period_stays_history_frozen_rule_untouched_test() {
  assert claims.effective_status(
      ver_claims.Row(
        ..base.claim(),
        status: ver_claims.Verified,
        current: False,
        valid_from: Some(1),
        valid_until: Some(99),
        organisation_id: Some(id.org("o1")),
        verification_method: Some(
          verification_method.OrganisationAdminConfirmation,
        ),
      ),
      org: Some(orgs.Row(..base.org(), id: id.org("o1"), suspended: False)),
      subject_removed: False,
      now: 1_790_164_800_000,
    )
    == claims.Effective(
      status: ver_claims.Verified,
      displayable: True,
      current: False,
      historical: True,
      reasons: [],
    )
}
