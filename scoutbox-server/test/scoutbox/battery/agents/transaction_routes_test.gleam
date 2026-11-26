//// Checks of the rules from the rules suites of agents/transactions, first generated from the TypeScript server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import gleam/json
import gleam/option.{Some}
import scoutbox/agents/transaction_routes
import scoutbox/agents/transaction_rules
import scoutbox/agents/transaction_store
import scoutbox/battery/base
import scoutbox/rows/id
import scoutbox/rows/transaction_history
import scoutbox/vocab/compliance_actor_kind
import scoutbox/vocab/document_visibility
import scoutbox/vocab/party_role

// transactions: timelineFor — M-p10 the club timeline holds the creation and not the note
pub fn m_p10_the_club_timeline_holds_the_creation_and_not_the_note_test() {
  assert json.to_string(transaction_routes.timeline_of(
      [
        transaction_store.Event(
          row: transaction_history.Row(
            ..base.transaction_event(),
            id: id.transaction_event("h1"),
            at: 1_789_689_600_000,
            action: transaction_history.TransactionCreated,
            by_kind: compliance_actor_kind.Org,
            by_id: Some("u1"),
            by_name: Some("Ana Costa"),
            detail_count: Some(2),
          ),
          reason_codes: [],
          policy_versions: [],
        ),
        transaction_store.Event(
          row: transaction_history.Row(
            ..base.transaction_event(),
            id: id.transaction_event("h2"),
            at: 1_789_689_600_001,
            action: transaction_history.TransactionNoteAdded,
            by_kind: compliance_actor_kind.Org,
            by_id: Some("u1"),
            by_name: Some("Ana"),
            detail_visibility: Some(document_visibility.AgentPrivate),
          ),
          reason_codes: [],
          policy_versions: [],
        ),
      ],
      [transaction_rules.PartyClubSignatory],
      Some(party_role.EngagingEntity),
    ))
    == "[{\"id\":\"h1\",\"at\":1789689600000,\"action\":\"transaction_created\",\"audience\":\"all_parties\",\"actor\":{\"kind\":\"agent\",\"label\":\"Representing agent\"},\"detail\":{\"count\":2}}]"
}
