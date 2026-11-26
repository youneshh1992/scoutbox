//// Refusal bodies that carry reasons or outstanding consents, hand-ported from the `publicErrorBody` calls of the
//// TypeScript rules suites (agents/compliance Z5, agents/transactions Z-p4) that pass them. There the allowlist
//// reshapes each reason; here each route writes them already shaped, from types with no place for prose, so the
//// body is the contract's allowlist over what the route's shapers write.

import gleam/json
import gleam/option.{None, Some}
import scoutbox/agents/compliance_routes
import scoutbox/agents/conflict
import scoutbox/agents/context_view
import scoutbox/agents/transaction_routes
import scoutbox/recruitment/domain_errors
import scoutbox/rows/compliance_evaluation_reasons as reason_row
import scoutbox/rows/id
import scoutbox/vocab/rule_status
import wisp/simulate

pub fn reasons_and_outstanding_consents_shed_prose_and_agents_test() {
  let reason =
    context_view.Reason(
      row: reason_row.Row(
        ..reason_row.new(
          evaluation_id: id.evaluation("ev"),
          ord: 0,
          code: "CONSENT_REQUIRED",
        ),
        rule_id: Some("ENG-6.3"),
        rule_status: Some(rule_status.Active),
        agent_user_id: Some(id.org_user("A")),
        detail_text: Some("prose"),
      ),
      party_roles: [],
      jurisdictions: [],
    )
  let outstanding =
    context_view.Outstanding(
      party_role: "individual",
      agent_user_id: Some("A"),
      consent_kind: "dual_representation",
      reason_code: "CONSENT_MISSING",
    )
  let body =
    domain_errors.send(compliance_routes.contract, "CONSENT_REQUIRED", [
      #("stack", json.string("x")),
      #("reviewerNote", json.string("private")),
      #("reasons", json.array([reason], context_view.public_reason_json)),
      #(
        "consentsOutstanding",
        json.array([outstanding], context_view.public_outstanding_json),
      ),
    ])
  assert simulate.read_body(body)
    == "{\"ok\":false,\"error\":\"CONSENT_REQUIRED\",\"reasons\":[{\"code\":\"CONSENT_REQUIRED\",\"ruleId\":\"ENG-6.3\",\"ruleStatus\":\"ACTIVE\",\"regulator\":null,\"jurisdiction\":null,\"policyVersion\":null}],\"consentsOutstanding\":[{\"partyRole\":\"individual\",\"consentKind\":\"dual_representation\",\"reasonCode\":\"CONSENT_MISSING\"}]}"
}

/// The suite's reason has no rule status, which the TypeScript body writes as null; a conflict reason here always
/// has one (UNKNOWN when no rule decided it), so that is what this body carries.
pub fn the_transaction_allowlist_drops_everything_it_does_not_name_test() {
  let reason =
    conflict.Reason(
      code: "C",
      rule_id: Some("R"),
      rule_status: rule_status.Unknown,
      regulator: Some("FIFA"),
      jurisdiction: Some("ENG"),
      policy_version: None,
      override_rule_id: Some("O"),
      agent_user_id: Some("Ana"),
      party_role: None,
      state: Some("s"),
      party_roles: None,
      jurisdictions: None,
      via_connected_agent: True,
    )
  let body =
    domain_errors.send(transaction_routes.contract, "TRANSACTION_NOT_FOUND", [
      #("message", json.string("No transaction")),
      #("stack", json.string("x")),
      #("internalNote", json.string("Ana")),
      #("text", json.string("secret")),
      #("fee", json.string("12%")),
      #("reasons", json.array([reason], transaction_routes.public_reason)),
    ])
  assert simulate.read_body(body)
    == "{\"ok\":false,\"error\":\"TRANSACTION_NOT_FOUND\",\"message\":\"No transaction\",\"reasons\":[{\"code\":\"C\",\"ruleId\":\"R\",\"ruleStatus\":\"UNKNOWN\",\"policyVersion\":null}]}"
}
