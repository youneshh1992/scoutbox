//// The conflict-of-interest engine (domains/agents/compliance/conflict.mjs): pure and deterministic, with a stable
//// `input_hash` for the same inputs and clock.
////
//// It evaluates the licensed individual (plus connected agents), never the agency. Where the deciding rule is under
//// legal review or unknown, or the policies contradict, it answers review rather than a guess.
////
//// Other services and declared interests are not inputs: no route records either, on either server. A context's
//// type is always one of the four, so TYPE_UNKNOWN cannot arise here.

import gleam/int
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/agents/approach_policy.{type Policy, type Rule}
import scoutbox/platform/canonical.{type Value}
import scoutbox/platform/secrets
import scoutbox/vocab/context_outcome.{
  type ContextOutcome, Clear, InsufficientData, ManualRegulatoryReviewRequired,
  PermittedDualRepresentationConsentRequired, ProhibitedConflict,
}
import scoutbox/vocab/context_type.{type ContextType}
import scoutbox/vocab/jurisdiction
import scoutbox/vocab/party_role.{type PartyRole, ReleasingEntity}
import scoutbox/vocab/rule_status.{type RuleStatus}
import scoutbox/vocab/subject_kind.{type SubjectKind}

// ------------------------------------------------------------------------------------------------- input

pub type Party {
  Party(
    party_role: PartyRole,
    subject_kind: SubjectKind,
    subject_id: String,
    removed: Bool,
    is_minor: Bool,
  )
}

/// A representation as the engine reads it: `status` is `declared`, `verified` or `withdrawn`, and `declared_only`
/// means it waits on review. `via_colleague` marks a colleague's representation attributed to the agent.
pub type Representation {
  Representation(
    agent_user_id: String,
    party_role: PartyRole,
    agreement_id: Option(String),
    declared_only: Bool,
    status: String,
    first_act_at: Option(Int),
    via_colleague: Bool,
  )
}

/// An evaluated agent: its FIFA licence state (or `NO_AFFILIATION`) and the agents connected to it.
pub type Agent {
  Agent(licence_state: String, connected: List(String))
}

/// A regulatory consent as the engine reads it.
pub type Consent {
  Consent(
    kind: String,
    status: String,
    revoked_at: Option(Int),
    granted_at: Option(Int),
    context_id: String,
    agent_user_id: String,
    party_role: Option(PartyRole),
    subject_id: Option(String),
    signatory: Option(Bool),
    policy_versions: List(String),
    full_particulars: Bool,
    legal_advice: Bool,
  )
}

pub type Input {
  Input(
    context_id: String,
    context_type: ContextType,
    jurisdictions: List(String),
    parties: List(Party),
    representations: List(Representation),
    evaluate_agent_user_ids: List(String),
    agents: List(#(String, Agent)),
    consents: List(Consent),
    policies: List(Policy),
    missing: List(String),
    now: Int,
  )
}

// ------------------------------------------------------------------------------------------------- output

pub type Reason {
  Reason(
    code: String,
    rule_id: Option(String),
    rule_status: RuleStatus,
    regulator: Option(String),
    jurisdiction: Option(String),
    policy_version: Option(String),
    override_rule_id: Option(String),
    agent_user_id: Option(String),
    party_role: Option(PartyRole),
    state: Option(String),
    party_roles: Option(List(PartyRole)),
    jurisdictions: Option(List(String)),
    via_connected_agent: Bool,
  )
}

pub type ConsentOutstanding {
  ConsentOutstanding(
    party_role: PartyRole,
    agent_user_id: String,
    consent_kind: String,
    reason_code: String,
  )
}

pub type Evaluation {
  Evaluation(
    outcome: ContextOutcome,
    reasons: List(Reason),
    consents_outstanding: List(ConsentOutstanding),
    policy_versions: List(String),
    evaluated_at: Int,
    input_hash: String,
  )
}

// ------------------------------------------------------------------------------------------------- rules

/// A rule as the engine reads it. A rule id the policy set lacks is UNKNOWN; a missing national rule has no id.
type Entry {
  Entry(
    rule_id: Option(String),
    rule: Option(Rule),
    policy: Option(Policy),
    status: RuleStatus,
  )
}

fn rule_at(policies: List(Policy), rule_id: String, now: Int) -> Entry {
  case approach_policy.find_rule(policies, rule_id) {
    Ok(#(r, p)) ->
      Entry(Some(rule_id), Some(r), Some(p), approach_policy.status_at(r, now))
    Error(Nil) -> Entry(Some(rule_id), None, None, rule_status.Unknown)
  }
}

fn reason(code: String, e: Option(Entry)) -> Reason {
  let policy = option.then(e, fn(e) { e.policy })
  Reason(
    code:,
    rule_id: option.then(e, fn(e) { e.rule_id }),
    rule_status: option.map(e, fn(e) { e.status })
      |> option.unwrap(rule_status.Unknown),
    regulator: option.map(policy, fn(p) { p.row.regulator }),
    jurisdiction: option.map(policy, fn(p) {
      jurisdiction.to_string(p.row.jurisdiction)
    }),
    policy_version: option.map(policy, approach_policy.policy_id),
    override_rule_id: None,
    agent_user_id: None,
    party_role: None,
    state: None,
    party_roles: None,
    jurisdictions: None,
    via_connected_agent: False,
  )
}

fn severity(o: ContextOutcome) -> Int {
  case o {
    ProhibitedConflict -> 4
    InsufficientData -> 3
    ManualRegulatoryReviewRequired -> 2
    PermittedDualRepresentationConsentRequired -> 1
    Clear -> 0
  }
}

/// The most severe outcome wins. A prohibition under an active rule is a definite answer; review and insufficient
/// data are the absence of one, so neither may soften it.
pub fn most_severe(a: ContextOutcome, b: ContextOutcome) -> ContextOutcome {
  case severity(a) >= severity(b) {
    True -> a
    False -> b
  }
}

/// `national` for a single association other than INT; `international` for INT or several; none is unresolved.
pub type Scope {
  Unresolved
  National(String)
  International(List(String))
}

pub fn resolve_scope(jurisdictions: List(String)) -> Scope {
  case list.unique(list.filter(jurisdictions, fn(j) { j != "" })) {
    [] -> Unresolved
    [ma] if ma != "INT" -> National(ma)
    mas -> International(mas)
  }
}

// ------------------------------------------------------------------------------------------------- consents

/// Whether a dual-representation consent suffices: unrevoked, granted in advance of the agent's first act for the
/// other party, by the party itself (or its signatory), naming a policy version in which the deciding rule was
/// active, and, where the rule asks, with full particulars and the legal-advice offer.
fn sufficiency(
  c: Consent,
  context_id: String,
  first_act_at: Option(Int),
  require_particulars: Bool,
  active_policy_ids: List(String),
) -> Result(Nil, String) {
  let granted = c.status == "granted" && option.is_some(c.granted_at)
  case c.kind == "dual_representation" {
    False -> Error("CONSENT_MISSING")
    True if c.revoked_at != None || c.status == "revoked" ->
      Error("CONSENT_REVOKED")
    True if !granted ->
      case c.status {
        "declined" -> Error("CONSENT_DECLINED")
        _ -> Error("CONSENT_MISSING")
      }
    True if c.context_id != context_id -> Error("CONSENT_WRONG_CONTEXT")
    True if c.signatory == Some(False) -> Error("SIGNATORY_REQUIRED")
    True -> {
      let late = case first_act_at, c.granted_at {
        Some(first), Some(at) -> at > first
        _, _ -> False
      }
      let stale =
        active_policy_ids != []
        && !list.any(c.policy_versions, list.contains(active_policy_ids, _))
      case late, stale, require_particulars {
        True, _, _ -> Error("CONSENT_NOT_IN_ADVANCE")
        _, True, _ -> Error("CONSENT_POLICY_VERSION_STALE")
        _, _, True if !c.full_particulars -> Error("PARTICULARS_MISSING")
        _, _, True if !c.legal_advice -> Error("LEGAL_ADVICE_NOT_OFFERED")
        _, _, _ -> Ok(Nil)
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------- the engine

type Acc {
  Acc(
    outcome: ContextOutcome,
    reasons: List(Reason),
    outstanding: List(ConsentOutstanding),
  )
}

fn push(acc: Acc, r: Reason) -> Acc {
  Acc(..acc, reasons: [r, ..acc.reasons])
}

fn raise(acc: Acc, o: ContextOutcome) -> Acc {
  Acc(..acc, outcome: most_severe(acc.outcome, o))
}

fn for_agent(r: Reason, agent_user_id: String) -> Reason {
  Reason(..r, agent_user_id: Some(agent_user_id))
}

fn with_roles(r: Reason, roles: List(PartyRole)) -> Reason {
  Reason(..r, party_roles: Some(roles))
}

pub fn evaluate(input: Input) -> Evaluation {
  let now = input.now
  let policies = input.policies
  let done = fn(acc: Acc) {
    Evaluation(
      outcome: acc.outcome,
      reasons: list.reverse(acc.reasons),
      // A consent is owed by a party, once, whichever connected agent's evaluation surfaced it.
      consents_outstanding: acc.outstanding
        |> list.reverse
        |> list.fold([], fn(seen, c: ConsentOutstanding) {
          case
            list.any(seen, fn(x: ConsentOutstanding) {
              x.party_role == c.party_role && x.consent_kind == c.consent_kind
            })
          {
            True -> seen
            False -> list.append(seen, [c])
          }
        }),
      policy_versions: list.unique(list.map(policies, approach_policy.policy_id)),
      evaluated_at: now,
      input_hash: input_hash(input),
    )
  }
  let acc = Acc(Clear, [], [])

  // 1. Scope.
  let scope = resolve_scope(input.jurisdictions)
  let acc = case scope {
    Unresolved ->
      raise(acc, InsufficientData) |> push(reason("SCOPE_UNRESOLVED", None))
    _ -> acc
  }
  let acc =
    list.fold(input.missing, acc, fn(acc, ma) {
      raise(acc, InsufficientData)
      |> push(
        Reason(..reason("POLICY_NOT_ENCODED", None), jurisdiction: Some(ma)),
      )
    })
  use <- bool_guard(acc.outcome == InsufficientData, done(acc))

  // 2. Parties.
  let acc =
    list.fold(input.parties, acc, fn(acc, p) {
      let acc = case p.removed {
        True ->
          raise(acc, InsufficientData)
          |> push(
            Reason(
              ..reason("PARTY_REMOVED", None),
              party_role: Some(p.party_role),
            ),
          )
        False -> acc
      }
      let guardian_agreed =
        list.any(input.consents, fn(c) {
          c.kind == "guardian_agreement"
          && c.status == "granted"
          && c.revoked_at == None
          && c.subject_id == Some(p.subject_id)
          && c.context_id == input.context_id
        })
      case p.is_minor && !guardian_agreed {
        True ->
          raise(acc, InsufficientData)
          |> push(
            Reason(
              ..reason("MINOR_PARTY", None),
              party_role: Some(p.party_role),
            ),
          )
        False -> acc
      }
    })

  // 3. Which table decides.
  let national = case scope {
    National(ma) -> Some(ma)
    _ -> None
  }
  let national_policy =
    option.then(national, fn(ma) {
      list.find(policies, fn(p) {
        jurisdiction.to_string(p.row.jurisdiction) == ma
      })
      |> option.from_result
    })
  let national_rule = fn(matches: fn(Rule) -> Bool, fifa: String) {
    case national_policy {
      None -> Some(fifa)
      Some(p) ->
        list.find(p.rules, matches)
        |> result.map(fn(r) { r.id })
        |> option.from_result
    }
  }
  let entry_of = fn(rule_id: Option(String)) {
    case rule_id {
      Some(id) -> rule_at(policies, id, now)
      None -> Entry(None, None, national_policy, rule_status.Unknown)
    }
  }
  let multi_rule =
    entry_of(national_rule(
      fn(r) {
        approach_policy.flag(r, "permittedMultiple")
        || list.key_find(r.sets, "permittedSets") |> result.is_ok
      },
      "FIFA-12.8",
    ))
  let prohibit_rule =
    entry_of(national_rule(
      fn(r) { list.key_find(r.texts, "prohibitedWith") |> result.is_ok },
      "FIFA-12.9",
    ))
  let connected_rule =
    entry_of(national_rule(
      fn(r) { approach_policy.flag(r, "connectedAgentsAreOne") },
      "FIFA-12.10",
    ))
  // For a national transaction the FIFA entries give way to the national ones; say so in the reasons.
  let acc = case national {
    None -> acc
    Some(ma) ->
      list.fold(["FIFA-12.8", "FIFA-12.9", "FIFA-12.10"], acc, fn(acc, fifa_id) {
        let f = rule_at(policies, fifa_id, now)
        let over =
          option.then(f.rule, fn(r) {
            list.find(r.overrides, fn(o) { jurisdiction.to_string(o.0) == ma })
            |> option.from_result
          })
        case over {
          Some(#(_, override_rule_id)) ->
            push(
              acc,
              Reason(
                ..reason("NATIONAL_RULE_APPLIES", Some(f)),
                rule_status: rule_status.JurisdictionOverride,
                override_rule_id: Some(override_rule_id),
              ),
            )
          None -> acc
        }
      })
  }
  // A mixed case: an international transaction whose parties span more than one association is not national.
  let acc = case scope {
    International(mas) -> {
      let national_ones = list.filter(mas, fn(m) { m != "INT" })
      let any_active_national =
        list.any(national_ones, fn(m) {
          case
            list.find(policies, fn(p) {
              jurisdiction.to_string(p.row.jurisdiction) == m
            })
          {
            Ok(p) ->
              list.any(p.rules, fn(r) {
                approach_policy.flag(r, "permittedMultiple")
                && r.status == rule_status.Active
              })
            Error(Nil) -> False
          }
        })
      case list.length(national_ones) > 1 && any_active_national {
        True ->
          raise(acc, ManualRegulatoryReviewRequired)
          |> push(
            Reason(
              ..reason("SCOPE_MIXED", Some(multi_rule)),
              jurisdictions: Some(national_ones),
            ),
          )
        False -> acc
      }
    }
    _ -> acc
  }

  // 4. Connected agents, and the set of parties each evaluated agent acts for. A colleague's representation is an
  //    input to attribution, never a subject the colleague is judged on here.
  let reps =
    list.filter(input.representations, fn(r) {
      r.agent_user_id != "" && r.status != "withdrawn"
    })
  let agent_ids =
    case input.evaluate_agent_user_ids {
      [] -> list.unique(list.map(reps, fn(r) { r.agent_user_id }))
      ids -> ids
    }
    |> list.filter(fn(id) {
      list.any(reps, fn(r) { r.agent_user_id == id })
      || list.contains(input.evaluate_agent_user_ids, id)
    })
  let connected_of = fn(id) {
    case list.key_find(input.agents, id) {
      Ok(a) -> [id, ..list.filter(a.connected, fn(x) { x != "" })]
      Error(Nil) -> [id]
    }
  }
  let rule_flag = fn(e: Entry, name) {
    option.map(e.rule, approach_policy.flag(_, name)) == Some(True)
  }
  let rule_text = fn(e: Entry, name) {
    option.then(e.rule, fn(r) {
      list.key_find(r.texts, name) |> option.from_result
    })
  }
  let require_particulars = rule_flag(multi_rule, "fullParticularsRequired")
  let active_policy_ids =
    policies
    |> list.filter(fn(p) {
      jurisdiction.to_string(p.row.jurisdiction)
      == option.unwrap(national, "INT")
    })
    |> list.map(approach_policy.policy_id)

  let acc =
    list.fold(agent_ids, acc, fn(acc, agent_id) {
      case list.key_find(input.agents, agent_id) {
        Ok(Agent("VERIFIED", _)) -> {
          let conn = connected_of(agent_id)
          let own = list.filter(reps, fn(r) { r.agent_user_id == agent_id })
          let via =
            list.filter(reps, fn(r) {
              r.agent_user_id != agent_id
              && list.contains(conn, r.agent_user_id)
            })
          case own, via {
            [], [] ->
              push(acc, for_agent(reason("NO_REPRESENTATION", None), agent_id))
            _, _ ->
              agent_parties(
                acc,
                agent_id,
                own,
                via,
                conn,
                multi_rule,
                prohibit_rule,
                connected_rule,
                rule_flag,
                rule_text,
                input,
                require_particulars,
                active_policy_ids,
              )
          }
        }
        found -> {
          let state = case found {
            Ok(a) -> a.licence_state
            Error(Nil) -> "UNKNOWN"
          }
          raise(acc, InsufficientData)
          |> push(
            Reason(
              ..for_agent(reason("AGENT_STATE_INVALID", None), agent_id),
              state: Some(state),
            ),
          )
        }
      }
    })
  done(acc)
}

fn bool_guard(when: Bool, then: a, otherwise: fn() -> a) -> a {
  case when {
    True -> then
    False -> otherwise()
  }
}

fn add_role(roles: List(PartyRole), role: PartyRole) -> List(PartyRole) {
  case list.contains(roles, role) {
    True -> roles
    False -> list.append(roles, [role])
  }
}

/// One evaluated agent with at least one representation, own or attributed.
fn agent_parties(
  acc: Acc,
  agent_id: String,
  own: List(Representation),
  via: List(Representation),
  conn: List(String),
  multi_rule: Entry,
  prohibit_rule: Entry,
  connected_rule: Entry,
  rule_flag: fn(Entry, String) -> Bool,
  rule_text: fn(Entry, String) -> Option(String),
  input: Input,
  require_particulars: Bool,
  active_policy_ids: List(String),
) -> Acc {
  let acc =
    list.fold(own, acc, fn(acc, r) {
      case r.declared_only {
        True ->
          raise(acc, ManualRegulatoryReviewRequired)
          |> push(
            Reason(
              ..for_agent(reason("REPRESENTATION_UNVERIFIED", None), agent_id),
              party_role: Some(r.party_role),
            ),
          )
        False -> acc
      }
    })
  let roles = list.fold(own, [], fn(s, r) { add_role(s, r.party_role) })
  let #(acc, roles, attributed) = case via {
    [] -> #(acc, roles, False)
    _ ->
      case connected_rule.status {
        rule_status.Active
        | rule_status.UnderLegalReview
        | rule_status.Unknown -> {
          let roles =
            list.fold(via, roles, fn(s, r) { add_role(s, r.party_role) })
          let acc =
            push(
              acc,
              for_agent(
                reason("CONNECTED_AGENT_ATTRIBUTION", Some(connected_rule)),
                agent_id,
              )
                |> with_roles(
                  list.fold(via, [], fn(s, r) { add_role(s, r.party_role) }),
                ),
            )
          let acc = case connected_rule.status {
            rule_status.Active -> acc
            rule_status.Unknown ->
              raise(acc, ManualRegulatoryReviewRequired)
              |> push(for_agent(
                reason("POLICY_NOT_ENCODED", Some(connected_rule)),
                agent_id,
              ))
            _ ->
              raise(acc, ManualRegulatoryReviewRequired)
              |> push(for_agent(
                reason("RULE_STATUS_UNCERTAIN", Some(connected_rule)),
                agent_id,
              ))
          }
          #(acc, roles, True)
        }
        rule_status.Suspended -> #(
          push(
            acc,
            for_agent(reason("RULE_SUSPENDED", Some(connected_rule)), agent_id),
          ),
          roles,
          False,
        )
        _ -> #(
          push(
            acc,
            for_agent(
              reason("RULE_NOT_YET_IN_FORCE", Some(connected_rule)),
              agent_id,
            ),
          ),
          roles,
          False,
        )
      }
  }
  let multi = Some(multi_rule)
  case roles {
    [] | [_] -> {
      let deciding = case multi_rule.rule {
        Some(_) -> multi_rule
        None -> prohibit_rule
      }
      push(
        acc,
        for_agent(reason("SINGLE_PARTY", Some(deciding)), agent_id)
          |> with_roles(roles),
      )
    }
    _ ->
      // Multiple parties: the deciding rule's status governs everything below.
      case multi_rule.status {
        rule_status.UnderLegalReview -> {
          let acc =
            raise(acc, ManualRegulatoryReviewRequired)
            |> push(
              for_agent(reason("RULE_STATUS_UNCERTAIN", multi), agent_id)
              |> with_roles(roles),
            )
          case list.contains(roles, ReleasingEntity) {
            True ->
              push(
                acc,
                for_agent(
                  reason("RULE_STATUS_UNCERTAIN", Some(prohibit_rule)),
                  agent_id,
                )
                  |> with_roles(roles),
              )
            False -> acc
          }
        }
        rule_status.Unknown ->
          raise(acc, ManualRegulatoryReviewRequired)
          |> push(
            for_agent(reason("POLICY_NOT_ENCODED", multi), agent_id)
            |> with_roles(roles),
          )
        // A suspended rule is not a permission: with no active rule deciding the question, review.
        rule_status.Suspended | rule_status.PendingImplementation -> {
          let code = case multi_rule.status {
            rule_status.Suspended -> "RULE_SUSPENDED"
            _ -> "RULE_NOT_YET_IN_FORCE"
          }
          push(acc, for_agent(reason(code, multi), agent_id))
          |> raise(ManualRegulatoryReviewRequired)
          |> push(
            for_agent(reason("NO_ACTIVE_RULE_DECIDES", multi), agent_id)
            |> with_roles(roles),
          )
        }
        _ ->
          decided(
            acc,
            agent_id,
            own,
            via,
            conn,
            roles,
            attributed,
            multi_rule,
            prohibit_rule,
            rule_flag,
            rule_text,
            input,
            require_particulars,
            active_policy_ids,
          )
      }
  }
}

/// An active deciding rule (or an active limb of a partially suspended one).
fn decided(
  acc: Acc,
  agent_id: String,
  own: List(Representation),
  via: List(Representation),
  conn: List(String),
  roles: List(PartyRole),
  attributed: Bool,
  multi_rule: Entry,
  prohibit_rule: Entry,
  rule_flag: fn(Entry, String) -> Bool,
  rule_text: fn(Entry, String) -> Option(String),
  input: Input,
  require_particulars: Bool,
  active_policy_ids: List(String),
) -> Acc {
  let role_named = fn(name) {
    case name {
      Some(text) -> list.any(roles, fn(r) { party_role.to_string(r) == text })
      None -> False
    }
  }
  let prohibited_with = case prohibit_rule.status {
    rule_status.Active -> rule_text(prohibit_rule, "prohibitedWith")
    _ -> None
  }
  let permitted = case rule_flag(multi_rule, "permittedMultiple") {
    True -> !role_named(rule_text(multi_rule, "excludedRole"))
    False ->
      option.then(multi_rule.rule, fn(r) {
        list.key_find(r.sets, "permittedSets") |> option.from_result
      })
      |> option.unwrap([])
      |> list.any(fn(set) {
        list.length(set) == list.length(roles)
        && list.all(set, fn(name) { role_named(Some(name)) })
      })
  }
  case role_named(prohibited_with), permitted {
    True, _ ->
      raise(acc, ProhibitedConflict)
      |> push(
        Reason(
          ..for_agent(
            reason("PROHIBITED_COMBINATION", Some(prohibit_rule)),
            agent_id,
          )
          |> with_roles(roles),
          via_connected_agent: attributed,
        ),
      )
    False, False ->
      raise(acc, ProhibitedConflict)
      |> push(
        for_agent(
          reason("COMBINATION_NOT_PERMITTED", Some(multi_rule)),
          agent_id,
        )
        |> with_roles(roles),
      )
    False, True -> {
      // Permitted with consent from every represented party, given in advance of the agent's first act for more
      // than one party: the second-earliest first act.
      let acts =
        list.append(own, via)
        |> list.filter_map(fn(r) { option.to_result(r.first_act_at, Nil) })
        |> list.sort(int.compare)
      let dual_at = case acts {
        [_, second, ..] -> Some(second)
        _ -> None
      }
      let #(acc, all_consented) =
        list.fold(roles, #(acc, True), fn(state, role) {
          let #(acc, all) = state
          let best =
            input.consents
            |> list.filter(fn(c) {
              c.kind == "dual_representation"
              && c.context_id == input.context_id
              && c.party_role == Some(role)
              && {
                c.agent_user_id == agent_id
                || list.contains(conn, c.agent_user_id)
              }
            })
            |> list.fold_until(Error("CONSENT_MISSING"), fn(best, c) {
              case
                sufficiency(
                  c,
                  input.context_id,
                  dual_at,
                  require_particulars,
                  active_policy_ids,
                )
              {
                Ok(Nil) -> list.Stop(Ok(Nil))
                Error(code) ->
                  case best {
                    Error("CONSENT_MISSING") -> list.Continue(Error(code))
                    _ -> list.Continue(best)
                  }
              }
            })
          case best {
            Ok(Nil) -> #(acc, all)
            Error(code) -> #(
              Acc(..acc, outstanding: [
                ConsentOutstanding(role, agent_id, "dual_representation", code),
                ..acc.outstanding
              ]),
              False,
            )
          }
        })
      case all_consented {
        True ->
          push(
            acc,
            for_agent(reason("DUAL_CONSENTED", Some(multi_rule)), agent_id)
              |> with_roles(roles),
          )
        False ->
          raise(acc, PermittedDualRepresentationConsentRequired)
          |> push(
            for_agent(reason("CONSENT_REQUIRED", Some(multi_rule)), agent_id)
            |> with_roles(roles),
          )
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------- hashing

/// The SHA-256 of the input's canonical JSON, as `inputHashOf` in conflict.mjs computes it over the same shape.
pub fn input_hash(input: Input) -> String {
  let opt_text = canonical.text
  let transaction =
    canonical.Object([
      #("id", canonical.Str(input.context_id)),
      #("type", canonical.Str(context_type.to_string(input.context_type))),
      #(
        "jurisdictions",
        canonical.Array(
          list.map(input.jurisdictions, fn(ma) {
            canonical.Object([#("memberAssociation", canonical.Str(ma))])
          }),
        ),
      ),
      #(
        "parties",
        canonical.Array(
          list.map(input.parties, fn(p) {
            canonical.Object([
              #("partyRole", canonical.Str(party_role.to_string(p.party_role))),
              #(
                "subjectKind",
                canonical.Str(subject_kind.to_string(p.subject_kind)),
              ),
              #("subjectId", canonical.Str(p.subject_id)),
              #("removed", canonical.Bool(p.removed)),
              #("isMinor", canonical.Bool(p.is_minor)),
            ])
          }),
        ),
      ),
      #(
        "representations",
        canonical.Array(
          list.map(input.representations, fn(r) {
            canonical.Object(
              list.append(
                [
                  #("agentUserId", canonical.Str(r.agent_user_id)),
                  #(
                    "partyRole",
                    canonical.Str(party_role.to_string(r.party_role)),
                  ),
                  #("agreementId", opt_text(r.agreement_id)),
                  #("declaredOnly", canonical.Bool(r.declared_only)),
                  #("status", canonical.Str(r.status)),
                  #("firstActAt", canonical.int(r.first_act_at)),
                ],
                case r.via_colleague {
                  True -> [#("viaColleague", canonical.Bool(True))]
                  False -> []
                },
              ),
            )
          }),
        ),
      ),
      #("otherServices", canonical.Array([])),
      #(
        "evaluateAgentUserIds",
        canonical.strings(input.evaluate_agent_user_ids),
      ),
    ])
  let agents =
    canonical.Object(
      list.map(input.agents, fn(a) {
        #(
          a.0,
          canonical.Object([
            #("licenceState", canonical.Str({ a.1 }.licence_state)),
            #("connectedAgentUserIds", canonical.strings({ a.1 }.connected)),
          ]),
        )
      }),
    )
  canonical.Object([
    #("transaction", transaction),
    #("agents", agents),
    // Not ported yet: regulatory consents (the consent routes), so a context has none to hash.
    #("consents", canonical.Array(list.map(input.consents, consent_value))),
    #("interests", canonical.Array([])),
    #(
      "policyVersions",
      canonical.strings(list.map(input.policies, approach_policy.policy_id)),
    ),
    #("missingPolicies", canonical.strings(input.missing)),
    #("now", canonical.Int(input.now)),
  ])
  |> canonical.to_string
  |> secrets.sha256_hex
}

fn consent_value(c: Consent) -> Value {
  canonical.Object([
    #("kind", canonical.Str(c.kind)),
    #("status", canonical.Str(c.status)),
    #("revokedAt", canonical.int(c.revoked_at)),
    #("grantedAt", canonical.int(c.granted_at)),
    #("contextId", canonical.Str(c.context_id)),
    #("agentUserId", canonical.Str(c.agent_user_id)),
  ])
}

/// The distinct reason codes, in order.
pub fn reason_codes(reasons: List(Reason)) -> List(String) {
  list.unique(list.map(reasons, fn(r) { r.code }))
}
