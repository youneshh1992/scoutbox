//// The agency's audit feed (domains/agents/core/audit.mjs and compliance/audit.mjs): what happened and who did it,
//// never what was said. A player is named only while the organisation may see them; a reviewer appears as a role.
////
//// The transaction workspace's rows come from its own module (`transaction_ts_routes.agency_rows`).

import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/result
import gleam/string
import scoutbox/agents/agent_rules.{type Agreement}
import scoutbox/agents/agent_store
import scoutbox/agents/compliance_store
import scoutbox/agents/context_view
import scoutbox/identity/orgs.{type Org}
import scoutbox/identity/players
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/rows/agency_affiliation_history as affiliation_event_row
import scoutbox/rows/agent_profile_history as profile_event_row
import scoutbox/rows/agreement_history as event_row
import scoutbox/rows/agreement_scopes as scope_row
import scoutbox/rows/compliance_context_history as context_event_row
import scoutbox/rows/id
import scoutbox/rows/regulatory_consent_history as consent_event_row
import scoutbox/rows/regulatory_consents as consent_row
import scoutbox/rows/regulatory_review_history as review_event_row
import scoutbox/rows/regulatory_reviews as review_row
import scoutbox/vocab/agency_tier
import scoutbox/vocab/agent_actor_kind.{type AgentActorKind}
import scoutbox/vocab/agent_facet
import scoutbox/vocab/agreement_status
import scoutbox/vocab/compliance_actor_kind
import scoutbox/vocab/facet_state
import scoutbox/vocab/jurisdiction
import scoutbox/vocab/party_role
import scoutbox/vocab/terminator

/// One row of the feed: its id and instant (the sort key) and its fields.
pub type Row {
  Row(id: String, at: Int, fields: List(#(String, Json)))
}

pub fn view(r: Row) -> Json {
  json.object(r.fields)
}

fn actor(
  kind: AgentActorKind,
  by_id: Option(String),
  name: Option(String),
) -> Json {
  case kind {
    agent_actor_kind.Org ->
      json.object([
        #("userId", json.nullable(by_id, json.string)),
        #("name", json.nullable(name, json.string)),
      ])
    agent_actor_kind.TsReviewer ->
      json.object([
        #("userId", json.null()),
        #("name", json.string("Trust & Safety (attributed)")),
      ])
    agent_actor_kind.Player ->
      json.object([#("userId", json.null()), #("name", json.string("Player"))])
    agent_actor_kind.System ->
      json.object([#("userId", json.null()), #("name", json.string("system"))])
  }
}

fn row(
  id: String,
  at: Int,
  action: Json,
  domain: String,
  actor: Json,
  target: Json,
  detail: List(#(String, Json)),
) -> Row {
  Row(id, at, [
    #("id", json.string(id)),
    #("at", json.int(at)),
    #("action", action),
    #("domain", json.string(domain)),
    #("actor", actor),
    #("target", target),
    #("detail", case detail {
      [] -> json.null()
      _ -> json.object(detail)
    }),
  ])
}

fn some(
  name: String,
  v: Option(a),
  to_json: fn(a) -> Json,
) -> List(#(String, Json)) {
  case v {
    Some(x) -> [#(name, to_json(x))]
    None -> []
  }
}

/// Every row, newest first (then id, descending).
pub fn rows(read: Read, org: Org, now: Int) -> Result(List(Row), Fail(e)) {
  use profiles <- result.try(agent_store.profiles_for_agency(read, org.id))
  use affiliations <- result.try(agent_store.affiliations_for_agency(
    read,
    org.id,
  ))
  use agreements <- result.try(agent_store.agreements_for_agency(read, org.id))
  use affiliation_rows <- result.try(
    list.try_map(affiliations, fn(a) {
      use history <- result.try(agent_store.affiliation_history(read, a.row.id))
      list.try_map(history, fn(h) {
        use #(from, to) <- result.map(agent_store.affiliation_event_tiers(
          read,
          h.id,
        ))
        let tiers = fn(t) { json.array(t, agency_tier.to_json) }
        row(
          id.affiliation_event_to_string(h.id),
          h.at,
          affiliation_event_row.action_to_json(h.action),
          "agency",
          actor(h.by_kind, h.by_id, h.by_name),
          json.object([
            #("type", json.string("agency_affiliation")),
            #("id", id.affiliation_json(a.row.id)),
            #("userId", id.org_user_json(a.row.user_id)),
          ]),
          case h.action {
            affiliation_event_row.AgencyAffiliationCreated -> [
              #("tiers", tiers(to)),
            ]
            affiliation_event_row.AgencyAffiliationUpdated -> [
              #("from", tiers(from)),
              #("to", tiers(to)),
              #("tiers", tiers(to)),
            ]
            affiliation_event_row.AgencyAffiliationEnded ->
              some("reasonCode", h.detail_reason_code, json.string)
          },
        )
      })
    }),
  )
  use agreement_rows <- result.try(
    list.try_map(agreements, fn(a) {
      use target <- result.map(agreement_target(read, org, a, now))
      list.filter_map(a.history, fn(h) {
        case h.action {
          event_row.OpportunityShared | event_row.OpportunityShareWithdrawn ->
            Error(Nil)
          _ ->
            Ok(row(
              id.agreement_event_to_string(h.id),
              h.at,
              event_row.action_to_json(h.action),
              "representation",
              actor(h.by_kind, h.by_id, h.by_name),
              target,
              agreement_detail(a, h),
            ))
        }
      })
    }),
  )
  use review_rows <- result.try(review_rows(read, org))
  use context_rows <- result.try(context_rows(read, org))
  use consent_rows <- result.map(consent_rows(read, org))
  let profile_rows =
    list.flat_map(profiles, fn(p) {
      list.map(p.history, fn(h) {
        row(
          id.profile_event_to_string(h.id),
          h.at,
          profile_event_row.action_to_json(h.action),
          "agent",
          actor(h.by_kind, h.by_id, h.by_name),
          json.object([
            #("type", json.string("agent_profile")),
            #("id", id.agent_profile_json(p.row.id)),
            #("userId", id.org_user_json(p.row.user_id)),
          ]),
          profile_detail(h),
        )
      })
    })
  list.flatten([
    profile_rows,
    list.flatten(affiliation_rows),
    list.flatten(agreement_rows),
    context_rows,
    review_rows,
    consent_rows,
  ])
  |> newest_first
}

pub fn newest_first(rows: List(Row)) -> List(Row) {
  list.sort(rows, fn(x, y) {
    case int.compare(y.at, x.at) {
      order.Eq -> string.compare(y.id, x.id)
      o -> o
    }
  })
}

/// safeDetail: the facet, its association and the move, never a reference.
fn profile_detail(h: profile_event_row.Row) -> List(#(String, Json)) {
  case h.action {
    profile_event_row.AgentProfileCreated
    | profile_event_row.AgentProfileUpdated -> []
    _ ->
      list.flatten([
        case h.detail_to {
          Some(to) -> [
            #("from", json.nullable(h.detail_from, facet_state.to_json)),
            #("to", facet_state.to_json(to)),
          ]
          None -> []
        },
        [
          #("facet", json.nullable(h.detail_facet, agent_facet.to_json)),
          #(
            "memberAssociation",
            json.nullable(h.detail_ma, jurisdiction.to_json),
          ),
        ],
        case h.action {
          profile_event_row.AgentVerificationStateChanged -> [
            #("state", json.nullable(h.detail_state, facet_state.to_json)),
          ]
          _ -> []
        },
      ])
  }
}

/// safeDetail of an agreement entry: the move, its phase and reason code, whether a reason was given; for a request,
/// its scope and term.
fn agreement_detail(a: Agreement, h: event_row.Row) -> List(#(String, Json)) {
  let status = fn(v) { json.nullable(v, agreement_status.to_json) }
  case h.action {
    event_row.RepresentationRequested -> [
      #("scope", json.array(a.scope, scope_row.scope_to_json)),
      #("termMonths", json.int(a.row.term_months)),
    ]
    event_row.RepresentationSharingChanged ->
      some("shareWithAgencyStaff", h.detail_share_with_agency_staff, json.bool)
    _ ->
      case h.detail_by {
        Some(terminator.Client) -> [
          #("from", status(h.detail_from)),
          #("to", status(h.detail_to)),
          #("by", json.string("client")),
          #("hadReason", json.bool(h.detail_had_reason == Some(True))),
        ]
        by -> [
          #("phase", status(h.detail_phase)),
          #("reasonCode", json.nullable(h.detail_reason_code, json.string)),
          #("by", json.nullable(by, terminator.to_json)),
        ]
      }
  }
}

/// The agreement as a target: its subject named only while the organisation may see them.
fn agreement_target(
  read: Read,
  org: Org,
  a: Agreement,
  now: Int,
) -> Result(Json, Fail(e)) {
  use found <- result.map(players.for_org(
    read,
    id.player(a.row.client_id),
    org,
    now,
  ))
  let #(pid, name) = case found {
    Some(#(p, access)) if access.visible && !access.blocked -> #(
      id.player_json(p.row.id),
      json.string(p.row.name),
    )
    _ -> #(json.null(), json.null())
  }
  json.object([
    #("type", json.string("representation")),
    #("id", id.agreement_json(a.row.id)),
    #("agentUserId", id.org_user_json(a.row.agent_user_id)),
    #("playerId", pid),
    #("playerName", name),
  ])
}

/// The agency's regulatory review entries (compliance/audit.mjs): actions, ids and policy versions, never a reason.
fn review_rows(read: Read, org: Org) -> Result(List(Row), Fail(e)) {
  use reviews <- result.try(store.query(
    read,
    "SELECT "
      <> review_row.columns
      <> " FROM regulatory_reviews WHERE agency_org_id = ? ORDER BY rowid",
    [id.org_sql(org.id)],
    review_row.decoder(),
  ))
  use per <- result.map(
    list.try_map(reviews, fn(r) {
      let rid = id.regulatory_review_sql(r.id)
      use history <- result.try(store.query(
        read,
        "SELECT "
          <> review_event_row.columns
          <> " FROM regulatory_review_history WHERE review_id = ? ORDER BY ord",
        [rid],
        review_event_row.decoder(),
      ))
      use codes <- result.try(store.query(
        read,
        "SELECT code FROM regulatory_review_reasons WHERE review_id = ? ORDER BY ord",
        [rid],
        decode.at([0], decode.string),
      ))
      use versions <- result.try(store.query(
        read,
        "SELECT policy_version_id FROM regulatory_review_policy_versions WHERE review_id = ? ORDER BY ord",
        [rid],
        decode.at([0], decode.string),
      ))
      use evidence <- result.map(
        store.one(
          read,
          "SELECT COUNT(*) FROM regulatory_review_evidence_refs WHERE review_id = ?",
          [rid],
          decode.at([0], decode.int),
        )
        |> result.map(result.unwrap(_, 0)),
      )
      list.map(history, fn(h) {
        row(
          id.review_event_to_string(h.id),
          h.at,
          review_event_row.action_to_json(h.action),
          "compliance",
          compliance_actor(h),
          json.object([
            #("type", json.string("regulatory_review")),
            #("id", id.regulatory_review_json(r.id)),
            #("kind", review_row.kind_to_json(r.kind)),
          ]),
          case h.action {
            review_event_row.RegulatoryReviewRequested ->
              case h.detail_review_id {
                Some(other) -> [#("reviewId", id.regulatory_review_json(other))]
                None -> [
                  #("kind", review_row.kind_to_json(r.kind)),
                  #("policyVersions", json.array(versions, json.string)),
                  #("reasonCodes", json.array(list.unique(codes), json.string)),
                ]
              }
            review_event_row.RegulatoryReviewResolved ->
              safe([
                #(
                  "outcome",
                  json.nullable(
                    r.decision_outcome,
                    review_row.decision_outcome_to_json,
                  ),
                ),
                #("policyVersions", json.array(versions, json.string)),
                #("evidenceCount", json.int(evidence)),
              ])
            review_event_row.RegulatoryReviewCancelled ->
              case h.detail_rev {
                Some(_) -> [#("outcome", json.string("CANCELLED"))]
                None -> []
              }
            review_event_row.RegulatoryReviewSuperseded ->
              case h.detail_review_id {
                Some(other) -> [#("reviewId", id.regulatory_review_json(other))]
                None -> []
              }
            review_event_row.RegulatoryReviewStarted -> []
          },
        )
      })
    }),
  )
  list.flatten(per)
}

fn compliance_actor(h: review_event_row.Row) -> Json {
  compliance_actor_of(h.by_kind, h.by_id, h.by_name)
}

fn compliance_actor_of(
  kind: compliance_actor_kind.ComplianceActorKind,
  by_id: Option(String),
  by_name: Option(String),
) -> Json {
  let h = #(by_id, by_name)
  let anon = fn(name) {
    json.object([#("userId", json.null()), #("name", json.string(name))])
  }
  case kind {
    compliance_actor_kind.Org ->
      json.object([
        #("userId", json.nullable(h.0, json.string)),
        #("name", json.nullable(h.1, json.string)),
      ])
    compliance_actor_kind.TsReviewer ->
      json.object([
        #("userId", json.null()),
        #("name", json.string("Trust & Safety (attributed)")),
        #("reviewerId", json.nullable(h.0, json.string)),
      ])
    compliance_actor_kind.Player -> anon("Player")
    compliance_actor_kind.ClubUser -> anon("Club signatory")
    compliance_actor_kind.System -> anon(option.unwrap(h.1, "system"))
  }
}

/// The detail keys the agency feed may carry, in this order (compliance/audit.mjs `safeDetail`): never a reason
/// text, a note or another party's agent.
const safe_keys = [
  "outcome", "partyRole", "kind", "status", "from", "to", "facet",
  "memberAssociation", "state", "policyVersions", "reasonCodes", "reviewId",
  "consentId", "contextId", "hadReason", "evidenceCount", "type",
]

fn safe(fields: List(#(String, Json))) -> List(#(String, Json)) {
  list.filter_map(safe_keys, fn(k) {
    list.key_find(fields, k) |> result.map(fn(v) { #(k, v) })
  })
}

/// The actions of a context or consent the feed shows (`COMPLIANCE_AUDIT_ACTIONS`).
fn shown(action: String) -> Bool {
  !list.contains(
    ["compliance_context_party_removed", "compliance_context_policy_changed"],
    action,
  )
}

/// The agency's compliance contexts' entries.
fn context_rows(read: Read, org: Org) -> Result(List(Row), Fail(e)) {
  use ids <- result.try(store.query(
    read,
    "SELECT id FROM compliance_contexts WHERE agency_org_id = ? ORDER BY rowid",
    [id.org_sql(org.id)],
    decode.at([0], id.compliance_context_decoder()),
  ))
  use per <- result.map(
    list.try_map(ids, fn(cid) {
      use found <- result.try(compliance_store.by_id(read, cid))
      case found {
        None -> Ok([])
        Some(c) -> {
          use history <- result.try(store.query(
            read,
            "SELECT "
              <> context_event_row.columns
              <> " FROM compliance_context_history WHERE context_id = ? ORDER BY ord",
            [id.compliance_context_sql(cid)],
            context_event_row.decoder(),
          ))
          list.filter(history, fn(h) {
            shown(context_event_row.action_to_string(h.action))
          })
          |> list.try_map(fn(h) {
            use fields <- result.map(context_view.event_fields(read, c, h))
            row(
              id.context_event_to_string(h.id),
              h.at,
              context_event_row.action_to_json(h.action),
              "compliance",
              compliance_actor_of(h.by_kind, h.by_id, h.by_name),
              json.object([
                #("type", json.string("compliance_context")),
                #("id", id.compliance_context_json(c.row.id)),
                #("agentUserId", id.org_user_json(c.row.agent_user_id)),
              ]),
              safe(fields),
            )
          })
        }
      }
    }),
  )
  list.flatten(per)
}

/// The agency's consents' entries. A revocation is recorded once, on its consent.
fn consent_rows(read: Read, org: Org) -> Result(List(Row), Fail(e)) {
  use consents <- result.try(store.query(
    read,
    "SELECT "
      <> consent_row.columns
      <> " FROM regulatory_consents WHERE agency_org_id = ? ORDER BY rowid",
    [id.org_sql(org.id)],
    consent_row.decoder(),
  ))
  use per <- result.map(
    list.try_map(consents, fn(k) {
      let kid = id.consent_sql(k.id)
      use history <- result.try(store.query(
        read,
        "SELECT "
          <> consent_event_row.columns
          <> " FROM regulatory_consent_history WHERE consent_id = ? ORDER BY ord",
        [kid],
        consent_event_row.decoder(),
      ))
      use versions <- result.map(store.query(
        read,
        "SELECT policy_version_id FROM regulatory_consent_policy_versions WHERE consent_id = ? ORDER BY ord",
        [kid],
        decode.at([0], decode.string),
      ))
      let role = #("partyRole", party_role.to_json(k.party_role))
      let pvs = #("policyVersions", json.array(versions, json.string))
      list.map(history, fn(h) {
        row(
          id.consent_event_to_string(h.id),
          h.at,
          consent_event_row.action_to_json(h.action),
          "compliance",
          compliance_actor_of(h.by_kind, h.by_id, h.by_name),
          json.object([
            #("type", json.string("regulatory_consent")),
            #("id", id.consent_json(k.id)),
            #("contextId", id.compliance_context_json(k.context_id)),
            #("partyRole", party_role.to_json(k.party_role)),
          ]),
          safe(case h.action {
            consent_event_row.RegulatoryConsentRequested -> [
              role,
              #("kind", consent_row.kind_to_json(k.kind)),
              pvs,
            ]
            consent_event_row.RegulatoryConsentGranted -> [role, pvs]
            consent_event_row.RegulatoryConsentDeclined -> [role]
            consent_event_row.RegulatoryConsentRevoked -> [
              #("consentId", id.consent_json(k.id)),
              role,
            ]
          }),
        )
      })
    }),
  )
  list.flatten(per)
}
