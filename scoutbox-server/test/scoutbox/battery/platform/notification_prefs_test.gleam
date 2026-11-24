//// Checks of the rules from the rules suites of platform/contracts, first generated from the TypeScript server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import gleam/option.{None, Some}
import scoutbox/messaging/notification_prefs
import scoutbox/vocab/notification_category

// contracts: categoryOf — a mention is a mention
pub fn a_mention_is_a_mention_test() {
  assert option.map(
      notification_prefs.category_of(
        "recruitment_room",
        "Maria Keane mentioned you in the Recruitment Room for K.",
      ),
      notification_category.to_string,
    )
    == Some("mentions")
}

// contracts: categoryOf — an assignment is an assignment
pub fn an_assignment_is_an_assignment_test() {
  assert option.map(
      notification_prefs.category_of(
        "recruitment_room",
        "Maria Keane assigned you a task in the Recruitment Room for K.",
      ),
      notification_category.to_string,
    )
    == Some("assignments")
}

// contracts: categoryOf — an ordinary room change is room_changes
pub fn an_ordinary_room_change_is_room_changes_test() {
  assert option.map(
      notification_prefs.category_of(
        "recruitment_room",
        "Room moved to shortlisted",
      ),
      notification_category.to_string,
    )
    == Some("room_changes")
}

// contracts: categoryOf — [neg] user text saying "mentioned you" in another type is NOT a mention
pub fn neg_user_text_saying_mentioned_you_in_another_type_is_not_a_mention_test() {
  assert option.map(
      notification_prefs.category_of(
        "message",
        "someone wrote \"mentioned you\" in a message",
      ),
      notification_category.to_string,
    )
    == Some("messages")
}

// contracts: categoryOf — [neg] a club's evidence request is an evidence request: the person who switched those off is not sent one
pub fn neg_a_club_s_evidence_request_is_an_evidence_request_the_person_who_swit_test() {
  assert option.map(
      notification_prefs.category_of("evidence_request", ""),
      notification_category.to_string,
    )
    == Some("evidence_requests")
}

// contracts: categoryOf — [neg] an unknown type is unclassified (and, below, the gate lets it through)
pub fn neg_an_unknown_type_is_unclassified_and_below_the_gate_lets_it_through_test() {
  assert option.map(
      notification_prefs.category_of("never_seen_type", ""),
      notification_category.to_string,
    )
    == None
}
