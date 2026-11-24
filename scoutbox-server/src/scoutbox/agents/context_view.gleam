//// What a compliance context and its evaluations look like when read back (repositories/complianceRecords.mjs
//// `decodeEvaluations` and `decodeContexts`, with conflict.mjs `derivedOfEvaluation`), and the agent's view of a
//// context (shared.mjs `contextForAgent`).

import gleam/dict
import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/agents/compliance_store.{type Context}
import scoutbox/agents/conflict
import scoutbox/identity/orgs
import scoutbox/identity/players
import scoutbox/platform/rev
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/rows/compliance_context_history as event_row
import scoutbox/rows/compliance_contexts as context_row
import scoutbox/rows/compliance_evaluation_reason_items as item_row
import scoutbox/rows/compliance_evaluation_reasons as reason_row
import scoutbox/rows/compliance_evaluations as evaluation_row
import scoutbox/rows/id
import scoutbox/vocab/compliance_actor_kind
import scoutbox/vocab/context_outcome.{type ContextOutcome}
import scoutbox/vocab/context_type
import scoutbox/vocab/declared_representation_status
import scoutbox/vocab/party_role
import scoutbox/vocab/rule_status
import scoutbox/vocab/subject_kind

/// Reason codes that name a missing fact (conflict.mjs `MISSING_EVIDENCE_CODES`).
const missing_evidence_codes = [
  "POLICY_NOT_ENCODED", "SCOPE_UNRESOLVED", "TYPE_UNKNOWN", "PARTY_REMOVED",
  "MINOR_PARTY", "REPRESENTATION_UNVERIFIED", "AGENT_STATE_INVALID",
  "INSUFFICIENT_DATA",
]

const review_codes = [
  "RULE_STATUS_UNCERTAIN", "POLICY_NOT_ENCODED", "SCOPE_MIXED",
  "REPRESENTATION_UNVERIFIED", "OTHER_SERVICES_PRESUMPTION", "INTEREST_DECLARED",
  "NO_ACTIVE_RULE_DECIDES",
]

const supply_codes = [
  "TYPE_UNKNOWN", "SCOPE_UNRESOLVED", "POLICY_NOT_ENCODED", "PARTY_REMOVED",
  "MINOR_PARTY", "AGENT_STATE_INVALID",
]

const withdraw_codes = ["PROHIBITED_COMBINATION", "COMBINATION_NOT_PERMITTED"]

/// A stored reason with its listed values.
pub type Reason {
  Reason(
    row: reason_row.Row,
    party_roles: List(String),
    jurisdictions: List(String),
  )
}

pub type Outstanding {
  Outstanding(
    party_role: String,
    agent_user_id: Option(String),
    consent_kind: String,
    reason_code: String,
  )
}

/// An evaluation as stored, with the parties and representations it saw.
pub type Evaluation {
  Evaluation(
    row: evaluation_row.Row,
    reasons: List(Reason),
    outstanding: List(Outstanding),
    policy_versions: List(id.PolicyId),
    parties: List(#(String, String, String)),
    representations: List(#(String, String, String)),
  )
}

// ------------------------------------------------------------------------------------------------- reading

pub fn evaluation(
  read: Read,
  evaluation_id: id.EvaluationId,
) -> Result(Option(Evaluation), Fail(e)) {
  let eid = id.evaluation_sql(evaluation_id)
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> evaluation_row.columns
      <> " FROM compliance_evaluations WHERE id = ?",
    [eid],
    evaluation_row.decoder(),
  ))
  case rows {
    [] -> Ok(None)
    [row, ..] -> load(read, row) |> result.map(Some)
  }
}

/// The context's latest evaluation, and how many it has had.
pub fn latest(
  read: Read,
  context_id: id.ComplianceContextId,
) -> Result(#(Option(Evaluation), Int), Fail(e)) {
  let cid = id.compliance_context_sql(context_id)
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> evaluation_row.columns
      <> " FROM compliance_evaluations WHERE context_id = ? ORDER BY position DESC LIMIT 1",
    [cid],
    evaluation_row.decoder(),
  ))
  use count <- result.try(
    store.one(
      read,
      "SELECT COUNT(*) FROM compliance_evaluations WHERE context_id = ?",
      [cid],
      decode.at([0], decode.int),
    )
    |> result.map(result.unwrap(_, 0)),
  )
  case rows {
    [] -> Ok(#(None, count))
    [row, ..] -> load(read, row) |> result.map(fn(e) { #(Some(e), count) })
  }
}

fn load(read: Read, row: evaluation_row.Row) -> Result(Evaluation, Fail(e)) {
  let eid = id.evaluation_sql(row.id)
  use reasons <- result.try(store.query(
    read,
    "SELECT "
      <> reason_row.columns
      <> " FROM compliance_evaluation_reasons WHERE evaluation_id = ? ORDER BY ord",
    [eid],
    reason_row.decoder(),
  ))
  use items <- result.try(store.query(
    read,
    "SELECT "
      <> item_row.columns
      <> " FROM compliance_evaluation_reason_items WHERE evaluation_id = ? ORDER BY reason_ord, list, ord",
    [eid],
    item_row.decoder(),
  ))
  use outstanding <- result.try(
    store.query(
      read,
      "SELECT party_role, agent_user_id, consent_kind, reason_code FROM compliance_evaluation_consents_outstanding WHERE evaluation_id = ? ORDER BY ord",
      [eid],
      {
        use role <- decode.field(0, decode.string)
        use agent <- decode.field(1, decode.optional(decode.string))
        use kind <- decode.field(2, decode.string)
        use code <- decode.field(3, decode.string)
        decode.success(Outstanding(role, agent, kind, code))
      },
    ),
  )
  use versions <- result.try(store.query(
    read,
    "SELECT policy_version_id FROM compliance_evaluation_policy_versions WHERE evaluation_id = ? ORDER BY ord",
    [eid],
    decode.at([0], id.policy_decoder()),
  ))
  use parties <- result.try(store.query(
    read,
    "SELECT party_role, subject_kind, subject_id FROM compliance_evaluation_snapshot_parties WHERE evaluation_id = ? ORDER BY ord",
    [eid],
    triple(),
  ))
  use reps <- result.map(store.query(
    read,
    "SELECT agent_user_id, party_role, status FROM compliance_evaluation_snapshot_representations WHERE evaluation_id = ? ORDER BY ord",
    [eid],
    triple(),
  ))
  let listed = fn(ord, which) {
    list.filter(items, fn(x) { x.reason_ord == ord && x.list == which })
    |> list.map(fn(x) { x.value })
  }
  Evaluation(
    row:,
    reasons: list.map(reasons, fn(r) {
      Reason(
        r,
        listed(r.ord, item_row.Partyroles),
        listed(r.ord, item_row.Jurisdictions),
      )
    }),
    outstanding:,
    policy_versions: versions,
    parties:,
    representations: reps,
  )
}

fn triple() -> decode.Decoder(#(String, String, String)) {
  use a <- decode.field(0, decode.string)
  use b <- decode.field(1, decode.string)
  use c <- decode.field(2, decode.string)
  decode.success(#(a, b, c))
}

// ------------------------------------------------------------------------------------------------- views

fn opt(v: Option(String)) -> Json {
  json.nullable(v, json.string)
}

/// A stored reason's columns, from an evaluation or a review.
pub type ReasonFields {
  ReasonFields(
    code: String,
    rule_id: Option(String),
    rule_status: Option(rule_status.RuleStatus),
    regulator: Option(String),
    jurisdiction: Option(String),
    policy_version: Option(id.PolicyId),
    facet: Option(String),
    member_association: Option(String),
    state: Option(String),
    agent_user_id: Option(String),
    party_role: Option(String),
    party_roles: Option(List(String)),
    consent_kind: Option(String),
    detail: Option(String),
    reason: Option(String),
    override_rule_id: Option(String),
    kind: Option(String),
    via_connected_agent: Bool,
    jurisdictions: Option(List(String)),
  )
}

pub fn evaluation_reason(r: Reason) -> ReasonFields {
  let x = r.row
  ReasonFields(
    code: x.code,
    rule_id: x.rule_id,
    rule_status: x.rule_status,
    regulator: x.regulator,
    jurisdiction: x.jurisdiction,
    policy_version: x.policy_version_id,
    facet: x.facet,
    member_association: x.member_association,
    state: x.state,
    agent_user_id: option.map(x.agent_user_id, id.org_user_to_string),
    party_role: x.party_role,
    party_roles: case x.has_party_roles {
      True -> Some(r.party_roles)
      False -> None
    },
    consent_kind: x.consent_kind,
    detail: x.detail_text,
    reason: x.reason_text,
    override_rule_id: x.override_rule_id,
    kind: x.kind_text,
    via_connected_agent: x.via_connected_agent == Some(1),
    jurisdictions: case x.has_jurisdictions {
      True -> Some(r.jurisdictions)
      False -> None
    },
  )
}

/// A stored reason (complianceRecords.mjs `readReason`): the rule's fields, then each set detail in order.
pub fn reason_fields_json(x: ReasonFields) -> Json {
  let scalar = fn(name, v: Option(String)) {
    case v {
      Some(v) -> [#(name, json.string(v))]
      None -> []
    }
  }
  json.object(
    list.flatten([
      [
        #("code", json.string(x.code)),
        #("ruleId", opt(x.rule_id)),
        #("ruleStatus", json.nullable(x.rule_status, rule_status.to_json)),
        #("regulator", opt(x.regulator)),
        #("jurisdiction", opt(x.jurisdiction)),
        #("policyVersion", json.nullable(x.policy_version, id.policy_json)),
      ],
      scalar("facet", x.facet),
      scalar("memberAssociation", x.member_association),
      scalar("state", x.state),
      scalar("agentUserId", x.agent_user_id),
      scalar("partyRole", x.party_role),
      case x.party_roles {
        Some(roles) -> [#("partyRoles", json.array(roles, json.string))]
        None -> []
      },
      scalar("consentKind", x.consent_kind),
      scalar("detail", x.detail),
      scalar("reason", x.reason),
      scalar("overrideRuleId", x.override_rule_id),
      scalar("kind", x.kind),
      case x.via_connected_agent {
        True -> [#("viaConnectedAgent", json.bool(True))]
        False -> []
      },
      case x.jurisdictions {
        Some(js) -> [#("jurisdictions", json.array(js, json.string))]
        None -> []
      },
    ]),
  )
}

/// A reason as a refusal shows it (errors.mjs `publicReason`): the rule, and the party roles it concerns.
pub fn public_reason_json(r: Reason) -> Json {
  let x = evaluation_reason(r)
  json.object(
    list.flatten([
      [
        #("code", json.string(x.code)),
        #("ruleId", opt(x.rule_id)),
        #("ruleStatus", json.nullable(x.rule_status, rule_status.to_json)),
        #("regulator", opt(x.regulator)),
        #("jurisdiction", opt(x.jurisdiction)),
        #("policyVersion", json.nullable(x.policy_version, id.policy_json)),
      ],
      case x.party_roles {
        Some(roles) -> [#("partyRoles", json.array(roles, json.string))]
        None -> []
      },
      case x.party_role {
        Some(role) -> [#("partyRole", json.string(role))]
        None -> []
      },
    ]),
  )
}

pub fn reason_json(r: Reason) -> Json {
  reason_fields_json(evaluation_reason(r))
}

/// An outstanding consent as a refusal names it: whose consent and of what kind, never which agent is waiting.
pub fn public_outstanding_json(o: Outstanding) -> Json {
  json.object([
    #("partyRole", json.string(o.party_role)),
    #("consentKind", json.string(o.consent_kind)),
    #("reasonCode", json.string(o.reason_code)),
  ])
}

fn outstanding_json(o: Outstanding) -> Json {
  json.object([
    #("partyRole", json.string(o.party_role)),
    #("agentUserId", opt(o.agent_user_id)),
    #("consentKind", json.string(o.consent_kind)),
    #("reasonCode", json.string(o.reason_code)),
  ])
}

fn codes_among(codes: List(String), wanted: List(String)) -> List(String) {
  codes
  |> list.filter(list.contains(wanted, _))
  |> list.unique
}

fn codes_of(e: Evaluation) -> List(String) {
  list.map(e.reasons, fn(r) { r.row.code })
}

/// conflict.mjs `requiredActionsFor`, over an evaluation's outcome, its reasons' codes in order, and its
/// outstanding consents.
pub fn required_actions(
  outcome: ContextOutcome,
  codes: List(String),
  outstanding: List(Outstanding),
) -> List(Json) {
  let action = fn(action, wanted) {
    json.object([
      #("action", json.string(action)),
      #("reasonCodes", json.array(codes_among(codes, wanted), json.string)),
    ])
  }
  case outcome {
    context_outcome.PermittedDualRepresentationConsentRequired ->
      list.map(outstanding, fn(o) {
        json.object([
          #("action", json.string("obtain_consent")),
          #("partyRole", json.string(o.party_role)),
          #("consentKind", json.string(o.consent_kind)),
          #("reasonCode", json.string(o.reason_code)),
        ])
      })
    context_outcome.ManualRegulatoryReviewRequired -> [
      action("attributed_regulatory_review", review_codes),
    ]
    context_outcome.InsufficientData -> [
      action("supply_missing_facts", supply_codes),
    ]
    context_outcome.ProhibitedConflict -> [
      action("withdraw_a_representation", withdraw_codes),
    ]
    context_outcome.Clear -> []
  }
}

/// conflict.mjs `missingEvidenceOf`: the codes that name a missing fact, in order, repeats kept.
pub fn missing_evidence(codes: List(String)) -> List(String) {
  list.filter(codes, list.contains(missing_evidence_codes, _))
}

fn evaluation_actions(e: Evaluation) -> Json {
  json.preprocessed_array(required_actions(
    e.row.outcome,
    codes_of(e),
    e.outstanding,
  ))
}

/// `Object.fromEntries` over each rule a reason names: a rule named twice keeps its first place and its last
/// status.
fn rule_statuses(reasons: List(Reason)) -> Json {
  let named =
    list.filter_map(reasons, fn(r) {
      case r.row.rule_id {
        Some(rule) -> Ok(#(rule, r.row.rule_status))
        None -> Error(Nil)
      }
    })
  let last = dict.from_list(named)
  named
  |> list.map(fn(p) { p.0 })
  |> list.unique
  |> list.map(fn(rule) {
    #(
      rule,
      json.nullable(
        dict.get(last, rule) |> result.unwrap(None),
        rule_status.to_json,
      ),
    )
  })
  |> json.object
}

pub fn alias(outcome: ContextOutcome) -> Option(String) {
  case outcome {
    context_outcome.PermittedDualRepresentationConsentRequired ->
      Some("PERMITTED_WITH_CONSENT")
    _ -> None
  }
}

/// The stored evaluation with what is worked out from it on read.
pub fn evaluation_json(e: Evaluation) -> Json {
  json.object(evaluation_json_fields(e))
}

/// The evaluation's `proposed` representation, or null.
pub fn proposed_json(e: Evaluation) -> Json {
  case e.row.proposed_party_role, e.row.proposed_agent_user_id {
    Some(role), Some(agent) ->
      json.object([
        #("partyRole", party_role.to_json(role)),
        #("agentUserId", id.org_user_json(agent)),
      ])
    _, _ -> json.null()
  }
}

pub fn evaluation_json_fields(e: Evaluation) -> List(#(String, Json)) {
  let r = e.row
  [
    #("outcome", context_outcome.to_json(r.outcome)),
    #("alias", opt(alias(r.outcome))),
    #("reasons", json.array(e.reasons, reason_json)),
    #("consentsOutstanding", json.array(e.outstanding, outstanding_json)),
    #("requiredActions", evaluation_actions(e)),
    #("missingEvidence", json.array(missing_evidence(codes_of(e)), json.string)),
    #("policyVersions", json.array(e.policy_versions, id.policy_json)),
    #("evaluatedAt", json.int(r.evaluated_at)),
    #("inputHash", json.string(r.input_hash)),
    #(
      "snapshotOf",
      json.object([
        #(
          "parties",
          json.array(e.parties, fn(p) {
            json.object([
              #("partyRole", json.string(p.0)),
              #("subjectKind", json.string(p.1)),
              #("subjectId", json.string(p.2)),
            ])
          }),
        ),
        #(
          "representations",
          json.array(e.representations, fn(p) {
            json.object([
              #("agentUserId", json.string(p.0)),
              #("partyRole", json.string(p.1)),
              #("status", json.string(p.2)),
            ])
          }),
        ),
        #("proposed", case r.proposed_party_role, r.proposed_agent_user_id {
          Some(role), Some(agent) ->
            json.object([
              #("partyRole", party_role.to_json(role)),
              #("agentUserId", id.org_user_json(agent)),
            ])
          _, _ -> json.null()
        }),
      ]),
    ),
    #("ruleStatuses", rule_statuses(e.reasons)),
    #("evaluationId", id.evaluation_json(r.id)),
    #("contextId", id.compliance_context_json(r.context_id)),
    #("position", json.int(r.position)),
  ]
}

fn scope_name(jurisdictions: List(String)) -> String {
  case conflict.resolve_scope(jurisdictions) {
    conflict.Unresolved -> "unknown"
    conflict.National(_) -> "national"
    conflict.International(_) -> "international"
  }
}

/// A history entry's detail fields, as the repository decodes them; none is a null detail.
pub fn event_fields(
  read: Read,
  c: Context,
  h: event_row.Row,
) -> Result(List(#(String, Json)), Fail(e)) {
  let role = fn() { json.nullable(h.detail_party_role, party_role.to_json) }
  let linked = fn() {
    case h.detail_evaluation_id {
      Some(eid) -> evaluation(read, eid)
      None -> Ok(None)
    }
  }
  case h.action {
    event_row.ComplianceContextOpened -> {
      use versions <- result.map(store.query(
        read,
        "SELECT policy_version_id FROM compliance_context_history_policy_versions WHERE history_id = ? ORDER BY ord",
        [id.context_event_sql(h.id)],
        decode.at([0], id.policy_decoder()),
      ))
      [
        #("type", context_type.to_json(c.row.type_)),
        #("policyVersions", json.array(versions, id.policy_json)),
      ]
    }
    event_row.ComplianceContextPartyAdded ->
      Ok([
        #("partyRole", role()),
        #("kind", json.nullable(h.detail_subject_kind, subject_kind.to_json)),
      ])
    event_row.ComplianceContextPartyRemoved -> Ok([#("partyRole", role())])
    event_row.ComplianceRepresentationDeclared ->
      case h.detail_status {
        Some(declared_representation_status.PendingReview) ->
          Ok([
            #("partyRole", role()),
            #("status", json.string("pending_review")),
          ])
        _ -> {
          use ev <- result.map(linked())
          [
            #("partyRole", role()),
            #("status", json.string("verified")),
            #(
              "outcome",
              json.nullable(ev, fn(e) { context_outcome.to_json(e.row.outcome) }),
            ),
            #(
              "policyVersions",
              json.nullable(ev, fn(e) {
                json.array(e.policy_versions, id.policy_json)
              }),
            ),
          ]
        }
      }
    event_row.ComplianceRepresentationVerified ->
      Ok([
        #("partyRole", role()),
        #(
          "reviewId",
          json.nullable(h.detail_review_id, id.regulatory_review_json),
        ),
      ])
    event_row.ComplianceRepresentationWithdrawn ->
      Ok([
        #("partyRole", role()),
        ..case h.detail_review_id {
          Some(r) -> [#("reviewId", id.regulatory_review_json(r))]
          None -> []
        }
      ])
    event_row.ComplianceContextEvaluated ->
      case h.detail_review_id {
        Some(r) ->
          Ok([
            #("reviewId", id.regulatory_review_json(r)),
            #(
              "outcome",
              json.nullable(
                h.detail_review_outcome,
                event_row.detail_review_outcome_to_json,
              ),
            ),
          ])
        None -> {
          use ev <- result.map(linked())
          case ev {
            None -> []
            Some(e) -> [
              #("outcome", context_outcome.to_json(e.row.outcome)),
              #(
                "reasonCodes",
                json.array(list.unique(codes_of(e)), json.string),
              ),
              #("policyVersions", json.array(e.policy_versions, id.policy_json)),
            ]
          }
        }
      }
    event_row.ComplianceContextPolicyChanged ->
      Ok([
        #(
          "policyVersions",
          json.array(
            option.values([h.detail_policy_version_id]),
            id.policy_json,
          ),
        ),
      ])
    event_row.ComplianceContextClosed -> Ok([])
  }
}

fn history(read: Read, c: Context) -> Result(List(Json), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> event_row.columns
      <> " FROM compliance_context_history WHERE context_id = ? ORDER BY ord",
    [id.compliance_context_sql(c.row.id)],
    event_row.decoder(),
  ))
  list.try_map(rows, fn(h) {
    use detail <- result.map(event_fields(read, c, h))
    json.object([
      #("id", id.context_event_json(h.id)),
      #("at", json.int(h.at)),
      #("action", event_row.action_to_json(h.action)),
      #("byKind", compliance_actor_kind.to_json(h.by_kind)),
      #("detail", case detail {
        [] -> json.null()
        _ -> json.object(detail)
      }),
    ])
  })
}

/// A party's name as the agency may see it: a club's, or a player's the agency can see.
fn party_name(
  read: Read,
  agency: Option(orgs.Org),
  kind: subject_kind.SubjectKind,
  subject: String,
  now: Int,
) -> Result(Option(String), Fail(e)) {
  case agency, kind {
    None, _ -> Ok(None)
    Some(_), subject_kind.Club ->
      orgs.by_id(read, id.org(subject))
      |> result.map(option.map(_, fn(o) { o.name }))
    Some(org), subject_kind.Player -> {
      use found <- result.map(players.for_org(
        read,
        id.player(subject),
        org,
        now,
      ))
      case found {
        Some(#(p, access)) if access.visible && !access.blocked ->
          Some(p.row.name)
        _ -> None
      }
    }
  }
}

/// shared.mjs `contextForAgent`.
pub fn for_agent(read: Read, c: Context, now: Int) -> Result(Json, Fail(e)) {
  use agency <- result.try(orgs.by_id(read, c.row.agency_org_id))
  use parties <- result.try(
    list.try_map(c.parties, fn(p) {
      use name <- result.map(party_name(
        read,
        agency,
        p.subject_kind,
        p.subject_id,
        now,
      ))
      json.object([
        #("id", id.transaction_party_json(p.id)),
        #("partyRole", party_role.to_json(p.party_role)),
        #("subjectKind", subject_kind.to_json(p.subject_kind)),
        #("subjectId", json.string(p.subject_id)),
        #("name", opt(name)),
        #("removed", json.bool(p.removed)),
      ])
    }),
  )
  use #(last, count) <- result.try(latest(read, c.row.id))
  use events <- result.map(history(read, c))
  let pending = c.row.re_evaluation_pending
  json.object([
    #("id", id.compliance_context_json(c.row.id)),
    #("type", context_type.to_json(c.row.type_)),
    #("status", context_row.status_to_json(c.row.status)),
    #("jurisdictions", json.array(c.jurisdictions, json.string)),
    #("scope", json.string(scope_name(c.jurisdictions))),
    #("parties", json.preprocessed_array(parties)),
    #(
      "representations",
      json.array(c.representations, fn(r) {
        json.object([
          #("id", id.representation_json(r.id)),
          #("agentUserId", id.org_user_json(r.agent_user_id)),
          #("partyRole", party_role.to_json(r.party_role)),
          #("agreementId", json.nullable(r.agreement_id, id.agreement_json)),
          #("status", declared_representation_status.to_json(r.status)),
          #("declaredOnly", json.bool(r.declared_only)),
          #("reviewId", json.nullable(r.review_id, id.regulatory_review_json)),
          #("firstActAt", json.nullable(r.first_act_at, json.int)),
        ])
      }),
    ),
    #("clearance", case last {
      None -> json.null()
      Some(e) ->
        json.object([
          #("outcome", context_outcome.to_json(e.row.outcome)),
          #("alias", opt(alias(e.row.outcome))),
          #("reasons", json.array(e.reasons, reason_json)),
          #("consentsOutstanding", json.array(e.outstanding, outstanding_json)),
          #("requiredActions", evaluation_actions(e)),
          #("policyVersions", json.array(e.policy_versions, id.policy_json)),
          #("evaluatedAt", json.int(e.row.evaluated_at)),
          #("inputHash", json.string(e.row.input_hash)),
          #("current", json.bool(!pending)),
        ])
    }),
    #("reEvaluationPending", json.bool(pending)),
    #("evaluationCount", json.int(count)),
    #("openedAt", json.int(c.row.opened_at)),
    #("closedAt", json.nullable(c.row.closed_at, json.int)),
    ..list.append(
      rev.meta(rev.Rev(c.row.rev, c.row.rev_at, c.row.rev_by_name)),
      [
        #("history", json.preprocessed_array(events)),
        #(
          "honest",
          json.string(
            "A compliance context is a minimal record for conflict evaluation. It is not a Transaction Room: no negotiation, no terms, no offer and no signing happen here.",
          ),
        ),
      ],
    )
  ])
}

/// The reason codes, once each, in the order first given.
pub fn reason_codes(e: Evaluation) -> List(String) {
  list.map(e.reasons, fn(r) { r.row.code }) |> list.unique
}
