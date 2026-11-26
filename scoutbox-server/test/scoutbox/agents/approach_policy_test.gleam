//// The policy layer's checks that the recorder can't turn into generated cases, ported by hand from the TypeScript
//// rules suites of agents/adversarial, agents/compliance and platform/dates (scripts/rules/). Each is a value
//// Gleam's types can't hold, so the check runs against the boundary that refuses it, and against the typed values
//// nearest it:
////
//// - A member association ScoutBox has no policy for (`SCO`) can't be a `Jurisdiction`, so `select_version` can't be
////   asked about it. Every caller asks `applicable`, which reports it missing (F3).
//// - A policy boundary that is a number or null can't be stored: the column is TEXT NOT NULL in a STRICT table
////   (J5b, J7). The TypeScript rule reads an integer boundary as an instant and a null one as never.
//// - `ruleStatusAt` is passed what `find_rule` found, so an entry without a rule is a lookup that found none:
////   `rule_at` answers UNKNOWN (F4).
//// - An action outside the four (`bribe`, F5) can't be asked for: each route calls the evaluation of its own act
////   (`approach_adult`, `approach_minor`, `declare_representation`), and no route evaluates `request_consent`.
//// - A context type outside the four (`offer`, J8) can't be stored or read from a request (the closed vocabulary),
////   and every type has the scopes that cover it (`scopes_for`).
//// - Jurisdictions passed as `{ memberAssociation }` objects or as null: every Gleam caller holds a context's
////   jurisdictions as text (E1–E3).

import gleam/list
import gleam/option.{None}
import scoutbox/agents/approach_policy
import scoutbox/agents/conflict
import scoutbox/platform/store
import scoutbox/rows/id
import scoutbox/support
import scoutbox/vocab/context_type
import scoutbox/vocab/jurisdiction
import scoutbox/vocab/rule_status

/// 18 September 2026, when the seeded policy versions are all in effect.
const now = 1_789_689_600_000

fn seeded() -> #(store.Store, List(approach_policy.Policy)) {
  let s = support.fresh_store(fn(_) { Nil })
  let assert Ok(policies) = store.read(s, approach_policy.published)
  #(s, policies)
}

fn stores(s: store.Store, sql: String) -> Bool {
  case store.unit(s, fn(tx) { store.exec(tx, sql) }) {
    Ok(_) -> True
    Error(_) -> False
  }
}

fn policy_sql(id: String, effective_from: String) -> String {
  "INSERT INTO jurisdiction_policies (id, regulator, jurisdiction, policy_version, effective_from_date, status, published_at, created_at, rev) VALUES ('"
  <> id
  <> "', 'FA', 'ENG', 9, "
  <> effective_from
  <> ", 'published', 1, 1, 1)"
}

// agents/adversarial F3: an unsupported jurisdiction selects nothing rather than borrowing another's rules.
pub fn an_unsupported_jurisdiction_is_missing_not_borrowed_test() {
  let #(_, policies) = seeded()
  assert jurisdiction.from_string("SCO") == Error(Nil)
  let set = approach_policy.applicable(policies, ["SCO"], now)
  assert set.missing == ["SCO"]
  assert list.map(set.policies, approach_policy.policy_id)
    == [id.policy("jp-fifa-2025-1")]
}

// platform/dates J5b, J7: a boundary that is a number or null can't be stored, so no stored version has one. One
// that is text in the right shape can.
pub fn a_policy_boundary_is_always_stored_as_a_day_test() {
  let #(s, _) = seeded()
  assert !stores(s, policy_sql("jp-num", "1790078400000"))
  assert !stores(s, policy_sql("jp-null", "NULL"))
  assert !stores(s, policy_sql("jp-text", "'garbage'"))
  assert stores(s, policy_sql("jp-day", "'2026-09-22'"))
}

// agents/adversarial F4: a rule no policy encodes is UNKNOWN, never active; a suspended one stays suspended.
pub fn a_rule_not_found_is_unknown_and_a_suspended_one_is_not_active_test() {
  let #(_, policies) = seeded()
  assert approach_policy.rule_at(policies, "NOPE-1", now)
    == approach_policy.Entry("NOPE-1", None, None, rule_status.Unknown)
  let suspended =
    approach_policy.Rule(
      id: "R",
      status: rule_status.Suspended,
      effective_from: None,
      flags: [],
      counts: [],
      texts: [],
      sets: [],
      overrides: [],
    )
  assert approach_policy.status_at(suspended, now) == rule_status.Suspended
}

// agents/compliance J8: an unknown context type is covered by nothing. No context has one, and every type it can
// have is covered by some scope.
pub fn an_unknown_context_type_can_not_be_held_test() {
  assert context_type.from_string("offer") == Error(Nil)
  assert list.all(
    [
      context_type.EmploymentContract,
      context_type.Transfer,
      context_type.Loan,
      context_type.OtherServices,
    ],
    fn(t) { approach_policy.scopes_for(t) != [] },
  )
}

// agents/compliance E1–E3: the jurisdictions the suite passes as objects, by the text each one names; nothing
// supplied is unresolved, never guessed.
pub fn jurisdictions_named_by_text_resolve_as_their_objects_do_test() {
  assert conflict.resolve_scope(["ENG", "ENG"]) == conflict.National("ENG")
  assert conflict.resolve_scope(["INT"]) == conflict.International(["INT"])
  assert conflict.resolve_scope([]) == conflict.Unresolved
}
