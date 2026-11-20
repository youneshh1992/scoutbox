//// The compliance engine's policy layer as the agent core's request route uses it (domains/agents/compliance/
//// policy.mjs: `applicablePolicySet` and `evaluatePolicy` for `approach_adult`). Routes hand it the policy set,
//// the facet states and the clock rather than branching on country.
////
//// Objective mandatory conditions (licence, registration, authorisation) fail closed; uncertainty goes to
//// attributed review. Neither branch is permission.
////
//// `declare_representation` is the same evaluation without the exclusivity window. The conflict engine
//// (`agents/conflict`) reads the same policy set.
////
//// `approach_minor` is the agent's own readiness for a minor pathway, evaluated against no subject.
////
//// Not ported yet: `request_consent` and the minors gate, which belong to the consent routes and the minor
//// pathway.

import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/platform/temporal
import scoutbox/rows/id
import scoutbox/rows/jurisdiction_policies as policy_row
import scoutbox/rows/jurisdiction_policy_rule_overrides as override_row
import scoutbox/rows/jurisdiction_policy_rule_param_items as item_row
import scoutbox/rows/jurisdiction_policy_rule_params as param_row
import scoutbox/rows/jurisdiction_policy_rules as rule_row
import scoutbox/vocab/agent_facet.{
  type AgentFacet, DomesticAuthorisation, FifaLicence, MinorsAuthorisation,
  NationalRegistration,
}
import scoutbox/vocab/facet_state.{type FacetState, Inactive, Stale, Verified}
import scoutbox/vocab/jurisdiction.{type Jurisdiction}
import scoutbox/vocab/rule_status.{type RuleStatus}

const day_ms = 86_400_000

/// A rule of a policy version, with the parameters the policy layer reads.
pub type Rule {
  Rule(
    id: String,
    status: RuleStatus,
    effective_from: Option(String),
    flags: List(#(String, Bool)),
    counts: List(#(String, Int)),
    texts: List(#(String, String)),
    /// List parameters (`permittedSets`), each a list of sets of text.
    sets: List(#(String, List(List(String)))),
    /// Where this rule gives way to a national one: the jurisdiction and the overriding rule's id.
    overrides: List(#(Jurisdiction, String)),
  )
}

/// A policy version and its rules, in order.
pub type Policy {
  Policy(row: policy_row.Row, rules: List(Rule))
}

pub fn policy_id(p: Policy) -> id.PolicyId {
  p.row.id
}

/// The published policy versions, in the order they were stored.
pub fn published(read: Read) -> Result(List(Policy), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> policy_row.columns
      <> " FROM jurisdiction_policies WHERE status = 'published' ORDER BY rowid",
    [],
    policy_row.decoder(),
  ))
  list.try_map(rows, fn(p) {
    use rules <- result.try(store.query(
      read,
      "SELECT "
        <> rule_row.columns
        <> " FROM jurisdiction_policy_rules WHERE policy_id = ? ORDER BY ord",
      [id.policy_sql(p.id)],
      rule_row.decoder(),
    ))
    use params <- result.try(store.query(
      read,
      "SELECT "
        <> param_row.columns
        <> " FROM jurisdiction_policy_rule_params WHERE policy_id = ? ORDER BY rule_id, ord",
      [id.policy_sql(p.id)],
      param_row.decoder(),
    ))
    use items <- result.try(store.query(
      read,
      "SELECT "
        <> item_row.columns
        <> " FROM jurisdiction_policy_rule_param_items WHERE policy_id = ? ORDER BY rule_id, name, set_no, ord",
      [id.policy_sql(p.id)],
      item_row.decoder(),
    ))
    use overrides <- result.map(store.query(
      read,
      "SELECT "
        <> override_row.columns
        <> " FROM jurisdiction_policy_rule_overrides WHERE policy_id = ? ORDER BY rule_id, ord",
      [id.policy_sql(p.id)],
      override_row.decoder(),
    ))
    Policy(
      p,
      list.map(rules, fn(r) {
        let mine = list.filter(params, fn(x) { x.rule_id == r.rule_id })
        let named = fn(value: fn(param_row.Row) -> Option(a)) {
          list.filter_map(mine, fn(x) {
            case value(x) {
              Some(v) -> Ok(#(param_row.name_to_string(x.name), v))
              None -> Error(Nil)
            }
          })
        }
        Rule(
          id: r.rule_id,
          status: r.rule_status,
          effective_from: r.effective_from_date,
          flags: named(fn(x) { x.flag_value }),
          counts: named(fn(x) { x.count_value }),
          texts: named(fn(x) { x.text_value }),
          sets: sets_of(list.filter(items, fn(x) { x.rule_id == r.rule_id })),
          overrides: overrides
            |> list.filter(fn(o) { o.rule_id == r.rule_id })
            |> list.map(fn(o) { #(o.jurisdiction, o.override_rule_id) }),
        )
      }),
    )
  })
}

/// Text items grouped by parameter, then by set, in order.
fn sets_of(items: List(item_row.Row)) -> List(#(String, List(List(String)))) {
  items
  |> list.filter_map(fn(x) {
    case x.text_value {
      Some(t) -> Ok(#(x.name, x.set_no, t))
      None -> Error(Nil)
    }
  })
  |> list.chunk(fn(x) { x.0 })
  |> list.map(fn(by_name) {
    let assert [#(name, _, _), ..] = by_name
    #(
      name,
      by_name
        |> list.chunk(fn(x) { x.1 })
        |> list.map(fn(set) { list.map(set, fn(x) { x.2 }) }),
    )
  })
}

// ------------------------------------------------------------------------------------------------- versions

/// A day as an instant; an unreadable one is never in effect.
fn day_ms_of(s: String) -> Option(Int) {
  temporal.parse_day(s) |> option.from_result |> option.map(temporal.day_start)
}

/// The latest version among those in effect for `ma` at `now`.
pub fn select_version(
  policies: List(Policy),
  ma: Jurisdiction,
  now: Int,
) -> Option(Policy) {
  list.fold(policies, None, fn(best: Option(Policy), p) {
    let from = day_ms_of(p.row.effective_from_date)
    let to_ok = case p.row.effective_to_date {
      None -> True
      Some(to) ->
        case day_ms_of(to) {
          Some(t) -> now < t
          None -> False
        }
    }
    let in_effect = case from {
      Some(f) -> f <= now && to_ok
      None -> False
    }
    case p.row.jurisdiction == ma && in_effect {
      False -> best
      True ->
        case best {
          Some(b) if b.row.policy_version >= p.row.policy_version -> best
          _ -> Some(p)
        }
    }
  })
}

/// `missing` names, in order, each member association no version in effect covers: a code ScoutBox has no
/// policy for at all (`FRA`) as well as a known one with none in effect.
pub type PolicySet {
  PolicySet(policies: List(Policy), missing: List(String))
}

/// FIFA (`INT`) always applies. A missing national entry is reported, never skipped.
pub fn applicable(
  policies: List(Policy),
  mas: List(String),
  now: Int,
) -> PolicySet {
  let mas =
    ["INT", ..list.filter(mas, fn(m) { m != "INT" && m != "" })]
    |> list.unique
  list.fold(mas, PolicySet([], []), fn(set, ma) {
    case
      jurisdiction.from_string(ma)
      |> result.try(fn(j) {
        select_version(policies, j, now) |> option.to_result(Nil)
      })
    {
      Ok(p) -> PolicySet(..set, policies: list.append(set.policies, [p]))
      Error(Nil) -> PolicySet(..set, missing: list.append(set.missing, [ma]))
    }
  })
}

// ------------------------------------------------------------------------------------------------- reasons

/// A rule's status at `now`, or `None` for a rule no policy encodes (UNKNOWN).
type Entry {
  Entry(
    rule_id: String,
    rule: Option(Rule),
    policy: Option(Policy),
    status: Status,
  )
}

/// A rule's operative status: the stored one, with PENDING_IMPLEMENTATION read as ACTIVE from its own date.
pub type Status {
  Known(RuleStatus)
}

pub fn status_at(rule: Rule, now: Int) -> RuleStatus {
  case rule.status {
    rule_status.PendingImplementation -> {
      let from = case rule.effective_from {
        Some(d) -> Some(d)
        None -> list.key_find(rule.texts, "effectiveFrom") |> option.from_result
      }
      case option.then(from, day_ms_of) {
        Some(f) if f <= now -> rule_status.Active
        _ -> rule_status.PendingImplementation
      }
    }
    st -> st
  }
}

/// The first policy in the set that encodes `rule_id`, with the rule.
pub fn find_rule(
  policies: List(Policy),
  rule_id: String,
) -> Result(#(Rule, Policy), Nil) {
  list.find_map(policies, fn(p) {
    list.find(p.rules, fn(r) { r.id == rule_id })
    |> result.map(fn(r) { #(r, p) })
  })
}

fn rule_at(policies: List(Policy), rule_id: String, now: Int) -> Entry {
  let found = find_rule(policies, rule_id)
  case found {
    Ok(#(r, p)) -> Entry(rule_id, Some(r), Some(p), Known(status_at(r, now)))
    Error(Nil) -> Entry(rule_id, None, None, Known(rule_status.Unknown))
  }
}

pub type Reason {
  Reason(
    code: String,
    rule_id: Option(String),
    rule_status: RuleStatus,
    regulator: Option(String),
    jurisdiction: Option(Jurisdiction),
    policy_version: Option(id.PolicyId),
    facet: Option(AgentFacet),
    member_association: Option(Jurisdiction),
    state: Option(FacetState),
  )
}

fn reason_of(code: String, e: Entry) -> Reason {
  let Known(st) = e.status
  Reason(
    code:,
    rule_id: Some(e.rule_id),
    rule_status: st,
    regulator: option.map(e.policy, fn(p) { p.row.regulator }),
    jurisdiction: option.map(e.policy, fn(p) { p.row.jurisdiction }),
    policy_version: option.map(e.policy, policy_id),
    facet: None,
    member_association: None,
    state: None,
  )
}

fn unencoded(ma: String) -> Reason {
  Reason(
    code: "POLICY_NOT_ENCODED",
    rule_id: None,
    rule_status: rule_status.Unknown,
    regulator: None,
    jurisdiction: jurisdiction.from_string(ma) |> option.from_result,
    policy_version: None,
    facet: None,
    member_association: None,
    state: None,
  )
}

pub type FacetGap {
  FacetGap(
    facet: AgentFacet,
    member_association: Option(Jurisdiction),
    state: FacetState,
    code: String,
  )
}

pub type Decision {
  Decision(
    blocked: Bool,
    requires_manual_review: Bool,
    reasons: List(Reason),
    facet_gaps: List(FacetGap),
  )
}

/// The refusal a facet that is not VERIFIED gives.
pub fn facet_refusal_code(facet: AgentFacet, state: FacetState) -> String {
  case state, facet {
    Stale, _ -> "AGENT_VERIFICATION_STALE"
    Inactive, _ -> "AGENT_LICENCE_INACTIVE"
    _, NationalRegistration -> "AGENT_NATIONAL_REGISTRATION_REQUIRED"
    _, DomesticAuthorisation -> "AGENT_DOMESTIC_AUTHORISATION_REQUIRED"
    _, MinorsAuthorisation -> "AGENT_MINOR_AUTHORISATION_REQUIRED"
    _, FifaLicence -> "AGENT_VERIFICATION_REQUIRED"
  }
}

/// An active rule makes the facet mandatory; a non-active one only contributes a reason.
fn require_facet(
  d: Decision,
  e: Entry,
  facet: AgentFacet,
  ma: Option(Jurisdiction),
  state_of: fn(AgentFacet, Option(Jurisdiction)) -> FacetState,
) -> Decision {
  let Known(st) = e.status
  let add = fn(d: Decision, r: Reason) {
    Decision(..d, reasons: list.append(d.reasons, [r]))
  }
  case st {
    rule_status.Active | rule_status.JurisdictionOverride -> {
      let state = state_of(facet, ma)
      case state {
        Verified ->
          add(
            d,
            Reason(
              ..reason_of("FACET_VERIFIED", e),
              facet: Some(facet),
              member_association: ma,
            ),
          )
        _ -> {
          let code = facet_refusal_code(facet, state)
          Decision(
            ..add(
              d,
              Reason(
                ..reason_of(code, e),
                facet: Some(facet),
                member_association: ma,
                state: Some(state),
              ),
            ),
            facet_gaps: list.append(d.facet_gaps, [
              FacetGap(facet, ma, state, code),
            ]),
            // A national facet only flags its own requirement; the FIFA licence blocks.
              blocked: d.blocked || facet == FifaLicence,
          )
        }
      }
    }
    rule_status.Suspended | rule_status.PartiallySuspended ->
      add(d, reason_of("RULE_SUSPENDED", e))
    rule_status.PendingImplementation ->
      add(d, reason_of("RULE_NOT_YET_IN_FORCE", e))
    rule_status.UnderLegalReview ->
      Decision(
        ..add(d, reason_of("RULE_STATUS_UNCERTAIN", e)),
        requires_manual_review: True,
      )
    rule_status.Unknown ->
      Decision(
        ..add(d, reason_of("POLICY_NOT_ENCODED", e)),
        requires_manual_review: True,
      )
  }
}

/// An adult approach: the agent's own facets, the national overlays and the exclusive-agreement window.
/// `state_of` gives a facet's effective state; `other_exclusive_ends` are other agents' active exclusive
/// agreements, anonymised to their ends.
pub fn approach_adult(
  set: PolicySet,
  mas: List(String),
  state_of: fn(AgentFacet, Option(Jurisdiction)) -> FacetState,
  other_exclusive_ends: List(Option(Int)),
  now: Int,
) -> Decision {
  let policies = set.policies
  let d =
    list.fold(set.missing, Decision(False, False, [], []), fn(d, ma) {
      Decision(
        ..d,
        requires_manual_review: True,
        reasons: list.append(d.reasons, [unencoded(ma)]),
      )
    })
  let mas =
    ["INT", ..list.filter(mas, fn(m) { m != "INT" && m != "" })]
    |> list.unique
  // The FIFA licence is personal and required for every regulated act (FIFA-8.1 / 11.1 / 12.2).
  let d =
    require_facet(
      d,
      rule_at(policies, "FIFA-8.1", now),
      FifaLicence,
      None,
      state_of,
    )
  let approach = rule_at(policies, "FIFA-12.2", now)
  let d = case approach.status {
    Known(rule_status.Active) -> d
    Known(rule_status.Unknown) ->
      Decision(
        ..d,
        reasons: list.append(d.reasons, [
          reason_of("POLICY_NOT_ENCODED", approach),
        ]),
      )
    _ ->
      Decision(
        ..d,
        reasons: list.append(d.reasons, [
          reason_of("RULE_STATUS_UNCERTAIN", approach),
        ]),
      )
  }
  // National overlays: registration and domestic authorisation are separate facets (DR-53).
  let d =
    list.fold(mas, d, fn(d, ma) {
      case
        ma,
        list.find(policies, fn(p) {
          jurisdiction.to_string(p.row.jurisdiction) == ma
        })
      {
        "INT", _ | _, Error(Nil) -> d
        _, Ok(policy) -> {
          let ma = Some(policy.row.jurisdiction)
          list.fold(policy.rules, d, fn(d, r) {
            let e = Entry(r.id, Some(r), Some(policy), Known(status_at(r, now)))
            let d = case flag(r, "nationalRegistrationRequired") {
              True -> require_facet(d, e, NationalRegistration, ma, state_of)
              False -> d
            }
            case flag(r, "domesticAuthorisationRequired") {
              True -> require_facet(d, e, DomesticAuthorisation, ma, state_of)
              False -> d
            }
          })
        }
      }
    })
  // The exclusive-agreement approach window (FIFA-16.1b / ENG-8.1b): while under legal review, manual review
  // whenever the rule would decide, never a block and never the other agent's identity.
  case other_exclusive_ends {
    [] -> d
    _ -> {
      let ids = [
        "FIFA-16.1b",
        ..list.filter_map(mas, fn(m) {
          case m {
            "INT" -> Error(Nil)
            _ -> Ok(m <> "-8.1b")
          }
        })
      ]
      list.fold(ids, d, fn(d, rule_id) {
        let e = rule_at(policies, rule_id, now)
        case e.rule, e.status {
          None, _ -> d
          Some(r), Known(rule_status.Active) -> {
            let window =
              {
                list.key_find(r.counts, "exclusivityWindowMonths")
                |> result.unwrap(2)
              }
              * 30
              * day_ms
            let inside =
              list.all(other_exclusive_ends, fn(end) {
                case end {
                  Some(end) -> end - now <= window
                  None -> False
                }
              })
            case inside {
              False ->
                Decision(
                  ..d,
                  blocked: True,
                  reasons: list.append(d.reasons, [
                    reason_of("EXCLUSIVITY_WINDOW_CLOSED", e),
                  ]),
                )
              True ->
                Decision(
                  ..d,
                  reasons: list.append(d.reasons, [
                    reason_of("EXCLUSIVITY_WINDOW_OPEN", e),
                  ]),
                )
            }
          }
          Some(_), Known(rule_status.Suspended) ->
            Decision(
              ..d,
              reasons: list.append(d.reasons, [reason_of("RULE_SUSPENDED", e)]),
            )
          Some(_), Known(rule_status.PendingImplementation) ->
            Decision(
              ..d,
              reasons: list.append(d.reasons, [
                reason_of("RULE_NOT_YET_IN_FORCE", e),
              ]),
            )
          Some(_), _ ->
            Decision(
              ..d,
              requires_manual_review: True,
              reasons: list.append(d.reasons, [
                reason_of("EXCLUSIVITY_WINDOW_DOUBTFUL", e),
              ]),
            )
        }
      })
    }
  }
}

/// Approaching a minor (`approach_minor`): the agent's own facets, the national minors accreditation where a rule
/// asks for it, and the FIFA minors accreditation recorded on the INT scope. Evaluated against no subject, this is
/// the agent's own readiness.
pub fn approach_minor(
  set: PolicySet,
  mas: List(String),
  state_of: fn(AgentFacet, Option(Jurisdiction)) -> FacetState,
  now: Int,
) -> Decision {
  let policies = set.policies
  let d =
    list.fold(set.missing, Decision(False, False, [], []), fn(d, ma) {
      Decision(
        ..d,
        requires_manual_review: True,
        reasons: list.append(d.reasons, [unencoded(ma)]),
      )
    })
  let mas =
    ["INT", ..list.filter(mas, fn(m) { m != "INT" && m != "" })]
    |> list.unique
  let d =
    require_facet(
      d,
      rule_at(policies, "FIFA-8.1", now),
      FifaLicence,
      None,
      state_of,
    )
  let approach = rule_at(policies, "FIFA-13.1", now)
  let d = case approach.status {
    Known(rule_status.Active) -> d
    Known(rule_status.Unknown) ->
      Decision(
        ..d,
        reasons: list.append(d.reasons, [
          reason_of("POLICY_NOT_ENCODED", approach),
        ]),
      )
    _ ->
      Decision(
        ..d,
        reasons: list.append(d.reasons, [
          reason_of("RULE_STATUS_UNCERTAIN", approach),
        ]),
      )
  }
  let d =
    list.fold(mas, d, fn(d, ma) {
      case
        ma,
        list.find(policies, fn(p) {
          jurisdiction.to_string(p.row.jurisdiction) == ma
        })
      {
        "INT", _ | _, Error(Nil) -> d
        _, Ok(policy) -> {
          let ma = Some(policy.row.jurisdiction)
          list.fold(policy.rules, d, fn(d, r) {
            let e = Entry(r.id, Some(r), Some(policy), Known(status_at(r, now)))
            let d = case flag(r, "nationalRegistrationRequired") {
              True -> require_facet(d, e, NationalRegistration, ma, state_of)
              False -> d
            }
            let d = case flag(r, "domesticAuthorisationRequired") {
              True -> require_facet(d, e, DomesticAuthorisation, ma, state_of)
              False -> d
            }
            case flag(r, "minorsAuthorisationRequired") {
              True -> require_facet(d, e, MinorsAuthorisation, ma, state_of)
              False -> d
            }
          })
        }
      }
    })
  // FIFA minors accreditation is recorded as a facet on the INT scope.
  require_facet(
    d,
    rule_at(policies, "FIFA-13.2", now),
    MinorsAuthorisation,
    Some(jurisdiction.INT),
    state_of,
  )
}

/// The rule that times a minor approach in `ma`: FIFA-13.1 internationally, else the national rule that names a
/// formula. None when the national policy has none.
pub fn minor_timing_rule(
  policies: List(Policy),
  ma: String,
  now: Int,
) -> Option(#(String, RuleStatus, Option(String))) {
  let formula = fn(r: Rule) {
    list.key_find(r.texts, "formula") |> option.from_result
  }
  case ma {
    "INT" ->
      case find_rule(policies, "FIFA-13.1") {
        Ok(#(r, _)) -> Some(#("FIFA-13.1", status_at(r, now), formula(r)))
        Error(Nil) -> Some(#("FIFA-13.1", rule_status.Unknown, None))
      }
    _ ->
      list.find(policies, fn(p) {
        jurisdiction.to_string(p.row.jurisdiction) == ma
      })
      |> result.try(fn(p) { list.find(p.rules, fn(r) { formula(r) != None }) })
      |> result.map(fn(r) { #(r.id, status_at(r, now), formula(r)) })
      |> option.from_result
  }
}

/// Declaring a representation: the agent's own facets and the national overlays, as for an adult approach but
/// with no exclusive-agreement window.
pub fn declare_representation(
  set: PolicySet,
  mas: List(String),
  state_of: fn(AgentFacet, Option(Jurisdiction)) -> FacetState,
  now: Int,
) -> Decision {
  approach_adult(set, mas, state_of, [], now)
}

/// `allowed` in policy.mjs: nothing blocks, no facet is missing and nothing needs review.
pub fn allowed(d: Decision) -> Bool {
  !d.blocked && !d.requires_manual_review && d.facet_gaps == []
}

pub fn flag(r: Rule, name: String) -> Bool {
  list.key_find(r.flags, name) == Ok(True)
}

/// A reason's public form (codes and references only, never prose).
pub fn reason_fields(r: Reason) -> List(#(String, json.Json)) {
  [
    #("code", json.string(r.code)),
    #("ruleId", json.nullable(r.rule_id, json.string)),
    #("ruleStatus", rule_status.to_json(r.rule_status)),
    #("regulator", json.nullable(r.regulator, json.string)),
    #("jurisdiction", json.nullable(r.jurisdiction, jurisdiction.to_json)),
    #("policyVersion", json.nullable(r.policy_version, id.policy_json)),
  ]
}
