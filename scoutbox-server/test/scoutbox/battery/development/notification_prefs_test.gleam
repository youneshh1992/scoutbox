//// Checks of the rules from the rules suites of development/hub, first generated from the TypeScript server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import gleam/option.{Some}
import scoutbox/messaging/notification_prefs
import scoutbox/vocab/notification_category

// hub: categoryOf — the development notification type maps to it
pub fn the_development_notification_type_maps_to_it_test() {
  assert option.map(
      notification_prefs.category_of("development", ""),
      notification_category.to_string,
    )
    == Some("development_updates")
}
