//// Checks of the rules from the rules suites of discovery/matchingAndWatchlists, first generated from the TypeScript
//// server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import gleam/list
import scoutbox/platform/live_event

// matchingAndWatchlists: isRegistered — watchlist_created is in the event registry
pub fn watchlist_created_is_in_the_event_registry_test() {
  assert list.contains(live_event.registered, "watchlist_created") == True
}

// matchingAndWatchlists: isRegistered — watchlist_updated is in the event registry
pub fn watchlist_updated_is_in_the_event_registry_test() {
  assert list.contains(live_event.registered, "watchlist_updated") == True
}

// matchingAndWatchlists: isRegistered — watchlist_membership_changed is in the event registry
pub fn watchlist_membership_changed_is_in_the_event_registry_test() {
  assert list.contains(live_event.registered, "watchlist_membership_changed")
    == True
}

// matchingAndWatchlists: isRegistered — watchlist_archived is in the event registry
pub fn watchlist_archived_is_in_the_event_registry_test() {
  assert list.contains(live_event.registered, "watchlist_archived") == True
}

// matchingAndWatchlists: isRegistered — matching_room_created is in the event registry
pub fn matching_room_created_is_in_the_event_registry_test() {
  assert list.contains(live_event.registered, "matching_room_created") == True
}
