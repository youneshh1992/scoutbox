//// Checks of the rules from the rules suites of platform/dates, first generated from the TypeScript server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import scoutbox/agents/handoffs
import scoutbox/battery/base
import scoutbox/rows/case_transaction_handoffs

// dates: effectiveHandoffStatus — K12 a handoff invitation expires at its TTL
pub fn k12_a_handoff_invitation_expires_at_its_ttl_test() {
  assert handoffs.effective_status(
      case_transaction_handoffs.Row(
        ..base.handoff(),
        status: case_transaction_handoffs.Invited,
        invited_at: 1_790_078_400_000,
      ),
      1_790_164_800_000,
    )
    == "invited"
}

// dates: effectiveHandoffStatus — K12 a handoff invitation expires at its TTL
pub fn k12_a_handoff_invitation_expires_at_its_ttl_2_test() {
  assert handoffs.effective_status(
      case_transaction_handoffs.Row(
        ..base.handoff(),
        status: case_transaction_handoffs.Invited,
        invited_at: 1_787_572_800_000,
      ),
      1_790_164_800_000,
    )
    == "expired"
}
