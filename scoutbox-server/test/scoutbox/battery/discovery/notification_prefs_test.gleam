//// Checks of the rules from the rules suites of discovery/matchingAndWatchlists, first generated from the TypeScript
//// server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import gleam/option.{Some}
import scoutbox/messaging/notification_prefs
import scoutbox/vocab/notification_category

// matchingAndWatchlists: categoryOf — a watchlist notification maps to that category
pub fn a_watchlist_notification_maps_to_that_category_test() {
  assert option.map(
      notification_prefs.category_of("watchlist", ""),
      notification_category.to_string,
    )
    == Some("watchlist_changes")
}
