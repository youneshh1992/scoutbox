//// Checks of the rules from the rules suites of recruitment/trialDatesMinorsAndErasure, first generated from the
//// TypeScript server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import gleam/option.{Some}
import scoutbox/messaging/notification_prefs
import scoutbox/vocab/notification_category

// trialDatesMinorsAndErasure: categoryOf — C0a guardian_decision → messages ("Messages and requests")
pub fn c0a_guardian_decision_messages_messages_and_requests_test() {
  assert option.map(
      notification_prefs.category_of("guardian_decision", ""),
      notification_category.to_string,
    )
    == Some("messages")
}
