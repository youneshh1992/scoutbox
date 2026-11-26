//// The matching engine's calls the generated cases can't hold (scripts/rules/discovery/matchingAndWatchlists.mjs).

import gleam/json
import gleam/option.{None, Some}
import scoutbox/discovery/matching/criteria

/// A42: a criterion type that somehow reaches the engine unvalidated fails closed. Here the engine takes only typed
/// criteria, and no `criteria.Test` is an unknown type, so such a criterion can only arrive as an editor's raw one,
/// which `validate` refuses by name.
pub fn an_unknown_criterion_type_never_reaches_the_engine_test() {
  let raw =
    criteria.Raw(
      ..criteria.blank,
      type_: Some("not_a_type"),
      operator: Some("equals"),
      value: Some(criteria.Number(1.0)),
    )
  let assert Error(refusal) =
    criteria.validate(
      [raw],
      [],
      criteria.Context(grassroots: False, protocols: None),
    )
  assert json.to_string(criteria.refusal_json(refusal))
    == "{\"ok\":false,\"error\":\"CRITERIA_INVALID\",\"details\":[{\"index\":0,\"class\":\"required\",\"type\":\"not_a_type\",\"error\":\"CRITERION_TYPE_UNKNOWN\"}],\"message\":\"These criteria cannot be saved as written.\"}"
}
