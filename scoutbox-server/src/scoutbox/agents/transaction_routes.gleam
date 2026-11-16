//// The agent's transaction workspaces (domains/agents/transactions): opening one, its notes, its projection, the
//// compliance re-check every material act runs, and the readiness the Offer workflow reads.
////
//// A workspace is permissioned, not an offer or a signing. Only the licensed agent opens one; creation grants no
//// authority, because the parties are named, not confirmed.
////
//// Not ported yet: every other route of the agent, club, player and Trust & Safety lanes (lists, reads, parties,
//// representations, status moves, terms, documents, links, timelines, confirmations), so a workspace stays at
//// DRAFT here with its parties unconfirmed.

import gleam/dynamic.{type Dynamic}
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/agents/agent_rules
import scoutbox/agents/agent_store
import scoutbox/agents/approach_policy
import scoutbox/agents/compliance_store.{type By}
import scoutbox/agents/conflict
import scoutbox/agents/core_routes.{type Member}
import scoutbox/agents/handoffs
import scoutbox/agents/transaction_rules.{
  type RoomRole, type State, type Viewer, AgencyViewer, RepresentingAgent,
}
import scoutbox/agents/transaction_store.{type Transaction}
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/orgs
import scoutbox/identity/players
import scoutbox/messaging/notifications
import scoutbox/platform/canonical
import scoutbox/platform/clock
import scoutbox/platform/effect
import scoutbox/platform/http
import scoutbox/platform/idempotency
import scoutbox/platform/input
import scoutbox/platform/limits
import scoutbox/platform/live_event
import scoutbox/platform/rev
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/recruitment/domain_errors.{Contract}
import scoutbox/rows/agent_transactions as tx_row
import scoutbox/rows/id
import scoutbox/rows/transaction_history as event_row
import scoutbox/rows/transaction_notes as note_row
import scoutbox/rows/transaction_parties as party_row
import scoutbox/verification/records
import scoutbox/vocab/agent_facet
import scoutbox/vocab/audience
import scoutbox/vocab/compliance_actor_kind
import scoutbox/vocab/context_outcome
import scoutbox/vocab/context_type.{type ContextType}
import scoutbox/vocab/document_visibility
import scoutbox/vocab/facet_state
import scoutbox/vocab/jurisdiction
import scoutbox/vocab/org_type
import scoutbox/vocab/party_role.{type PartyRole}
import scoutbox/vocab/pending_reason
import scoutbox/vocab/rule_status
import scoutbox/vocab/staleness
import scoutbox/vocab/subject_kind.{type SubjectKind}
import scoutbox/vocab/transaction_status
import wisp.{type Request, type Response}

// ------------------------------------------------------------------------------------------------- refusals

/// TRANSACTION_ERROR_HTTP (domains/agents/transactions/errors.mjs). `test/scoutbox/spec_test.gleam` proves it
/// equals the snapshot.
pub const statuses = [
  #("TRANSACTION_INPUT_INVALID", 400),
  #("TRANSACTION_CLIENT_KEY_INVALID", 400),
  #("EXPECTED_REV_INVALID", 400),
  #("DOCUMENT_INPUT_INVALID", 400),
  #("NOTE_INPUT_INVALID", 400),
  #("TERMS_INPUT_INVALID", 400),
  #("TRANSACTION_ACTION_NOT_PERMITTED", 403),
  #("TRANSACTION_PARTY_CONFIRMATION_NOT_PERMITTED", 403),
  #("DOCUMENT_VISIBILITY_NOT_PERMITTED", 403),
  #("SIGNATORY_REQUIRED", 403),
  #("AGENT_VERIFICATION_REQUIRED", 403),
  #("AGENT_LICENCE_INACTIVE", 403),
  #("AGENT_VERIFICATION_STALE", 403),
  #("AGENT_NATIONAL_REGISTRATION_REQUIRED", 403),
  #("AGENT_DOMESTIC_AUTHORISATION_REQUIRED", 403),
  #("AGENT_MINOR_AUTHORISATION_REQUIRED", 403),
  #("REPRESENTATION_REQUIRED", 403),
  #("REPRESENTATION_SCOPE_INSUFFICIENT", 403),
  #("REPRESENTATION_CONFLICT", 403),
  #("TRANSACTION_NOT_FOUND", 404),
  #("TRANSACTION_PARTY_NOT_FOUND", 404),
  #("DOCUMENT_NOT_FOUND", 404),
  #("NOTE_NOT_FOUND", 404),
  #("MESSAGE_THREAD_NOT_FOUND", 404),
  #("TRANSACTION_VERSION_CONFLICT", 409),
  #("TRANSACTION_IDEMPOTENCY_CONFLICT", 409),
  #("TRANSACTION_DUPLICATE_CONTEXT", 409),
  #("HANDOFF_NOT_FOUND", 409),
  #("HANDOFF_NOT_OPEN", 409),
  #("HANDOFF_SUBJECT_MISMATCH", 409),
  #("HANDOFF_NOT_ADDRESSED", 409),
  #("TRANSACTION_PARTY_EXISTS", 409),
  #("TRANSACTION_TRANSITION_NOT_ALLOWED", 409),
  #("TRANSACTION_NOT_LIVE", 409),
  #("TRANSACTION_ARCHIVED", 409),
  #("TRANSACTION_ALREADY_CONFIRMED", 409),
  #("DOCUMENT_SUPERSEDED", 409),
  #("DOCUMENT_VERSION_CONFLICT", 409),
  #("TRANSACTION_PARTIES_NOT_CONFIRMED", 422),
  #("TRANSACTION_COMPLIANCE_PENDING", 422),
  #("TRANSACTION_COMPLIANCE_BLOCKED", 422),
  #("TRANSACTION_COMPLIANCE_STALE", 422),
  #("TRANSACTION_PARTY_UNAVAILABLE", 422),
  #("CONSENT_REQUIRED", 422),
  #("REGULATORY_REVIEW_REQUIRED", 422),
  #("JURISDICTION_UNSUPPORTED", 422),
  #("REGULATORY_PROVIDER_UNAVAILABLE", 503),
  #("TRANSACTION_STATE_UNKNOWN", 500),
]

pub const contract =
  Contract(
    statuses: statuses,
    public_fields: [
      "message", "field", "problem", "min", "max", "expected", "allowed",
      "status", "from", "to", "expectedRev", "currentRev", "updatedBy",
      "updatedAt", "retryAfter", "partyRole", "awaiting", "pendingReason",
      "reasons", "policyVersions", "consentsOutstanding", "staleness",
      "visibility", "documentType", "contextId", "outcome",
    ],
    internal_message: "The transaction service cannot serve this request. This has been recorded.",
    unmapped: "TRANSACTION_STATE_UNKNOWN",
  )

fn err(
  code: String,
  message: String,
  fields: List(#(String, Json)),
) -> Response {
  domain_errors.refuse(contract, code, message, fields)
}

fn not_found() -> Response {
  err(
    "TRANSACTION_NOT_FOUND",
    "No transaction with that reference is available to you.",
    [],
  )
}

fn rate_limited(action: limits.Action) -> Response {
  http.json(
    429,
    json.object(
      list.map(limits.limited_body(action), fn(p) { #(p.0, json.string(p.1)) }),
    ),
  )
}

fn storage(r: Result(a, Fail(e))) -> Result(a, Fail(Response)) {
  store.map_refusal(r, fn(_) { http.error(500, "INTERNAL") })
}

fn answer(r: Result(Response, store.UnitError(Response))) -> Response {
  case r {
    Ok(response) -> response
    Error(store.Refused(response)) -> response
    Error(store.Lost(what)) -> http.stale(what)
    Error(e) -> http.internal(e)
  }
}

fn reading(
  ctx: Ctx,
  f: fn(Read) -> Result(a, Fail(e)),
  next: fn(a) -> Response,
) -> Response {
  case store.read(ctx.store, f) {
    Ok(v) -> next(v)
    Error(e) -> http.internal(e)
  }
}

const field_codes = [
  #("clientKey", "TRANSACTION_CLIENT_KEY_INVALID"),
  #("expectedRev", "EXPECTED_REV_INVALID"),
  #("expectedVersion", "EXPECTED_REV_INVALID"),
]

fn body(
  req: Request,
  shape: input.Shape(a),
  default: String,
  next: fn(a, Dynamic) -> Response,
) -> Response {
  use raw <- http.json_body(req)
  case
    input.parse_coded(shape, raw, root: "body", codes: field_codes, default:)
  {
    Ok(v) -> next(v, raw)
    Error(r) -> domain_errors.send(contract, r.error, input.refusal_fields(r))
  }
}

// ------------------------------------------------------------------------------------------------- actors

fn by_agent(a: OrgAccess) -> By {
  compliance_store.By(
    kind: compliance_actor_kind.Org,
    id: Some(id.org_user_to_string(a.user.id)),
    name: Some(a.user.name),
    role: None,
    org_id: None,
  )
}

fn agent_viewer(m: Member) -> Viewer {
  AgencyViewer(
    org_id: id.org_to_string(m.access.org.id),
    user_id: id.org_user_to_string(m.access.user.id),
    agency_admin: agent_rules.can(m.affiliation.tiers, "agency.compliance.read"),
  )
}

// ------------------------------------------------------------------------------------------------- compliance

fn stored_of(row: tx_row.Row) -> Option(transaction_rules.Stored) {
  use at <- option.then(row.compliance_evaluated_at)
  use revision <- option.map(row.compliance_party_revision)
  transaction_rules.Stored(
    evaluation_id: option.map(
      row.compliance_evaluation_id,
      id.evaluation_to_string,
    ),
    gate: option.then(row.compliance_gate, fn(g) {
      pending_reason.from_string(tx_row.compliance_gate_to_string(g))
      |> option.from_result
    }),
    evaluated_at: at,
    pending_reason: row.compliance_pending_reason,
    party_revision: revision,
  )
}

/// The snapshot as it reads now: what it says, read back from the evaluation it names.
fn compliance_of(
  read: Read,
  t: Transaction,
) -> Result(Option(transaction_rules.View), Fail(e)) {
  use evaluated <- result.map(case t.row.compliance_evaluation_id {
    Some(eid) -> compliance_store.evaluated(read, eid)
    None -> Ok(None)
  })
  transaction_rules.snapshot_view(
    id.transaction_to_string(t.row.id),
    stored_of(t.row),
    evaluated,
  )
}

fn live_players(t: Transaction) -> List(party_row.Row) {
  list.filter(t.parties, fn(p) {
    !p.removed && p.subject_kind == subject_kind.Player
  })
}

/// The hash staleness is measured against, from live records every time: a cached revision is exactly the stale
/// fact it exists to detect.
fn current_party_revision(
  read: Read,
  t: Transaction,
  now: Int,
) -> Result(String, Fail(e)) {
  use agency <- result.try(orgs.by_id(read, t.row.agency_org_id))
  use subjects <- result.try(
    list.try_map(live_players(t), fn(p) {
      case agency {
        Some(org) -> players.for_org(read, id.player(p.subject_id), org, now)
        None -> Ok(None)
      }
      |> result.map(fn(found) { #(p.subject_id, found) })
    }),
  )
  let blocked =
    list.filter_map(subjects, fn(s) {
      case s.1 {
        None -> Ok(s.0)
        Some(#(_, access)) if access.blocked -> Ok(s.0)
        Some(_) -> Error(Nil)
      }
    })
  let minors =
    list.filter_map(subjects, fn(s) {
      case s.1 {
        Some(#(p, _)) ->
          case players.is_adult(p, now) {
            True -> Error(Nil)
            False -> Ok(s.0)
          }
        None -> Error(Nil)
      }
    })
  use profile <- result.try(agent_store.profile_for_user(
    read,
    t.row.agent_user_id,
  ))
  use versions <- result.map(compliance_store.last_policy_versions(
    read,
    t.row.context_id,
  ))
  transaction_rules.party_revision(
    t.parties,
    id.org_user_to_string(t.row.agent_user_id),
    // Not ported yet: representations and consents, so the workspace has none.
    [],
    [],
    case profile {
      Some(p) -> compliance_store.facet_states(p, now)
      None -> canonical.Object([])
    },
    versions,
    blocked,
    minors,
  )
}

/// Reported on a read, never repaired. A new policy version flags the context, which reads as POLICY_CHANGED.
fn staleness_of(
  read: Read,
  t: Transaction,
  view: Option(transaction_rules.View),
  now: Int,
) -> Result(Option(staleness.Staleness), Fail(e)) {
  use current <- result.try(current_party_revision(read, t, now))
  use flagged <- result.map(compliance_store.re_evaluation_pending(
    read,
    t.row.context_id,
  ))
  transaction_rules.staleness(
    view,
    current,
    t.row.re_evaluation_pending || flagged,
  )
}

/// Checked before relationship scope and the engine, so a regulatory clear cannot override it.
fn safeguarding_problem(
  read: Read,
  t: Transaction,
  now: Int,
) -> Result(Option(String), Fail(e)) {
  use agency <- result.try(orgs.by_id(read, t.row.agency_org_id))
  list.try_fold(live_players(t), None, fn(found, p) {
    case found, agency {
      Some(_), _ -> Ok(found)
      None, None -> Ok(Some("NOT_VISIBLE"))
      None, Some(org) -> {
        use player <- result.map(players.for_org(
          read,
          id.player(p.subject_id),
          org,
          now,
        ))
        case player {
          None -> Some("SUBJECT_GONE")
          Some(#(pl, access)) ->
            case access.blocked, players.is_adult(pl, now), access.visible {
              True, _, _ -> Some("BLOCKED")
              // No minor transaction pathway is enabled in any jurisdiction.
              False, False, _ -> Some("MINOR")
              False, True, False -> Some("NOT_VISIBLE")
              False, True, True -> None
            }
        }
      }
    }
  })
}

fn gate_pending(
  problem: compliance_store.GateProblem,
) -> pending_reason.PendingReason {
  case problem {
    compliance_store.Unsupported(..) -> pending_reason.JurisdictionUnsupported
    _ -> pending_reason.FacetNotVerified
  }
}

/// Run after every material act, so an old evaluation can never authorise a new one. The status moves through
/// the compliance transition map only.
pub fn recheck(
  tx: Tx,
  transaction_id: id.TransactionId,
  by: By,
  now: Int,
) -> Result(Nil, Fail(e)) {
  let read = store.reading(tx)
  use found <- result.try(transaction_store.by_id(read, transaction_id))
  let assert Some(t) = found as "the transaction was just written"
  use guard <- result.try(safeguarding_problem(read, t, now))
  case guard {
    // Not a compliance verdict: the snapshot is not refreshed.
    Some(_) -> Ok(Nil)
    None -> {
      let confirmed =
        transaction_rules.parties_confirmed(t.row.type_, t.parties)
      use gate <- result.try(compliance_store.facet_gate(
        read,
        t.row.agent_user_id,
        t.jurisdictions,
        now,
      ))
      case gate {
        Some(problem) -> {
          let codes = case problem {
            compliance_store.Unsupported(reasons:, ..) ->
              list.map(reasons, fn(r) { r.code })
            _ -> []
          }
          let state =
            transaction_rules.state_from(
              None,
              Some(gate_pending(problem)),
              codes,
              0,
              confirmed,
            )
          snapshot(tx, t, state, None, [], by, now)
        }
        None -> {
          use ctx <- result.try(compliance_store.by_id(read, t.row.context_id))
          let assert Some(ctx) = ctx as "a transaction has its context"
          use _ <- result.try(compliance_store.project(
            tx,
            ctx.row.id,
            t.parties,
          ))
          use ctx <- result.try(compliance_store.by_id(read, t.row.context_id))
          let assert Some(ctx) = ctx as "a transaction has its context"
          use policies <- result.try(approach_policy.published(read))
          use engine <- result.try(compliance_store.engine_input(
            read,
            ctx,
            policies,
            now,
          ))
          let result = conflict.evaluate(engine)
          use evaluation_id <- result.try(compliance_store.record_evaluation(
            tx,
            ctx,
            result,
            by,
            now,
          ))
          let state =
            transaction_rules.state_from(
              Some(result.outcome),
              None,
              conflict.reason_codes(result.reasons),
              // Not ported yet: representations, so none is counted.
              0,
              confirmed,
            )
          snapshot(
            tx,
            t,
            state,
            Some(evaluation_id),
            result.policy_versions,
            by,
            now,
          )
        }
      }
    }
  }
}

fn snapshot(
  tx: Tx,
  t: Transaction,
  state: State,
  evaluation_id: Option(id.EvaluationId),
  policy_versions: List(String),
  by: By,
  now: Int,
) -> Result(Nil, Fail(e)) {
  let read = store.reading(tx)
  use prev <- result.try(compliance_of(read, t))
  use revision <- result.try(current_party_revision(read, t, now))
  use profile <- result.try(agent_store.profile_for_user(
    read,
    t.row.agent_user_id,
  ))
  let freshness =
    option.map(profile, fn(p) {
      agent_rules.effective_facet_state(
        agent_rules.facet_of(p, agent_facet.FifaLicence, None),
        now,
      )
    })
  let stored =
    transaction_rules.Stored(
      evaluation_id: option.map(evaluation_id, id.evaluation_to_string),
      gate: case evaluation_id {
        Some(_) -> None
        None -> state.pending_reason
      },
      evaluated_at: now,
      pending_reason: state.pending_reason,
      party_revision: revision,
    )
  let want = transaction_rules.status_for(state)
  let to = case
    want != t.row.status
    && transaction_rules.compliance_transition_allowed(t.row.status, want)
  {
    True -> Some(want)
    False -> None
  }
  use _ <- result.try(case to {
    Some(to) ->
      transaction_store.history(
        tx,
        t.row.id,
        event_row.TransactionStatusChanged,
        by,
        transaction_store.Detail(
          ..transaction_store.no_detail,
          from: Some(t.row.status),
          to: Some(to),
          pending_reason: state.pending_reason,
          outcome: state.outcome,
        ),
        now,
      )
    None -> Ok(Nil)
  })
  use _ <- result.try(transaction_store.history(
    tx,
    t.row.id,
    event_row.TransactionComplianceEvaluated,
    by,
    transaction_store.Detail(
      ..transaction_store.no_detail,
      outcome: state.outcome,
      pending_reason: state.pending_reason,
      reason_codes: Some(state.reason_codes),
      policy_versions: Some(policy_versions),
    ),
    now,
  ))
  use _ <- result.try(transaction_store.record_compliance(
    tx,
    t.row.id,
    stored,
    freshness,
    to,
    now,
  ))
  let org_id = id.org_to_string(t.row.agency_org_id)
  let tx_id = id.transaction_to_string(t.row.id)
  case to {
    Some(to) ->
      store.emit(
        tx,
        effect.Live(live_event.AgentTransactionStatusChanged(
          org_id:,
          tx_id:,
          status: transaction_status.to_string(to),
        )),
      )
    None -> Nil
  }
  case option.map(prev, fn(v) { v.state }) == Some(state) {
    True -> Ok(Nil)
    False -> {
      store.emit(
        tx,
        effect.Live(live_event.AgentTransactionComplianceUpdated(
          org_id:,
          tx_id:,
          outcome: option.map(state.outcome, context_outcome.to_string)
            |> option.unwrap("NONE"),
        )),
      )
      notifications.notify(
        tx,
        to: audience.OrgUser,
        id: id.org_user_to_string(t.row.agent_user_id),
        type_: "agent_transaction_compliance",
        text: case state.blocked, state.clear {
          True, _ ->
            "A transaction is blocked by an encoded ACTIVE rule. It cannot progress; only changed facts or a new policy version produce a different answer."
          _, True ->
            "A transaction is compliance-clear under the currently encoded rules. Nothing has been approved, agreed or signed."
          _, _ ->
            "A transaction cannot currently progress: "
            <> {
              option.map(state.pending_reason, pending_reason.to_string)
              |> option.unwrap("compliance pending")
              |> string.replace("_", " ")
              |> string.lowercase
            }
            <> "."
        },
        ref_id: Some(tx_id),
        at: now,
      )
    }
  }
}

// ------------------------------------------------------------------------------------------------- projection

fn party_name(
  read: Read,
  p: party_row.Row,
  viewer: Viewer,
  now: Int,
) -> Result(Option(String), Fail(e)) {
  case p.subject_kind, viewer {
    subject_kind.Club, _ ->
      orgs.by_id(read, id.org(p.subject_id))
      |> result.map(option.map(_, fn(o) { o.name }))
    subject_kind.Player, transaction_rules.PlayerViewer(me) ->
      case me == p.subject_id {
        True ->
          players.by_id(read, id.player(p.subject_id))
          |> result.map(option.map(_, fn(pl) { pl.row.name }))
        False -> Ok(None)
      }
    subject_kind.Player, transaction_rules.ReviewerViewer -> Ok(None)
    subject_kind.Player, AgencyViewer(org_id:, ..)
    | subject_kind.Player, transaction_rules.ClubViewer(org_id:, ..)
    -> {
      use org <- result.try(orgs.by_id(read, id.org(org_id)))
      case org {
        None -> Ok(None)
        Some(org) -> {
          use found <- result.map(players.for_org(
            read,
            id.player(p.subject_id),
            org,
            now,
          ))
          case found {
            Some(#(pl, access)) if access.visible -> Some(pl.row.name)
            _ -> None
          }
        }
      }
    }
  }
}

fn note_visibility(
  v: note_row.Visibility,
) -> document_visibility.DocumentVisibility {
  let assert Ok(d) =
    document_visibility.from_string(note_row.visibility_to_string(v))
    as "every note class is a document class"
  d
}

/// One workspace, projected for one viewer from the roles the server derived.
pub fn project(
  read: Read,
  t: Transaction,
  viewer: Viewer,
  now: Int,
) -> Result(Json, Fail(e)) {
  let r = t.row
  let roles =
    transaction_rules.room_roles(
      id.org_to_string(r.agency_org_id),
      id.org_user_to_string(r.agent_user_id),
      t.parties,
      viewer,
    )
  let side = case viewer {
    transaction_rules.ClubViewer(org_id:, ..) ->
      transaction_rules.club_party_role(t.parties, org_id)
    transaction_rules.PlayerViewer(_) -> Some(party_role.Individual)
    _ -> None
  }
  let is_agent = list.contains(roles, RepresentingAgent)
  use view <- result.try(compliance_of(read, t))
  use stale <- result.try(staleness_of(read, t, view, now))
  use agency <- result.try(orgs.by_id(read, r.agency_org_id))
  use names <- result.map(
    list.try_map(t.parties, party_name(read, _, viewer, now)),
  )
  let live = list.filter(t.parties, fn(p) { !p.removed })
  let subject = fn(role) {
    list.find(live, fn(p) { p.party_role == role })
    |> result.map(fn(p) { p.subject_id })
    |> option.from_result
  }
  let state = option.map(view, fn(v) { v.state })
  let roles_json = fn(rs: List(RoomRole)) {
    json.array(rs, fn(x) {
      json.string(transaction_rules.room_role_to_string(x))
    })
  }
  json.object([
    #("id", id.transaction_json(r.id)),
    #("type", context_type.to_json(r.type_)),
    #("status", transaction_status.to_json(r.status)),
    #("jurisdictions", json.array(t.jurisdictions, json.string)),
    #("playerId", json.nullable(subject(party_role.Individual), json.string)),
    #(
      "engagingOrgId",
      json.nullable(subject(party_role.EngagingEntity), json.string),
    ),
    #(
      "releasingOrgId",
      json.nullable(subject(party_role.ReleasingEntity), json.string),
    ),
    #("viewerRoles", roles_json(roles)),
    #("viewerPartyRole", json.nullable(side, party_role.to_json)),
    // Every party is entitled to know who represents whom.
    #("agency", case is_agent || roles != [] {
      True ->
        json.object([
          #("id", id.org_json(r.agency_org_id)),
          #(
            "name",
            json.nullable(option.map(agency, fn(o) { o.name }), json.string),
          ),
        ])
      False -> json.null()
    }),
    #(
      "parties",
      json.array(list.zip(t.parties, names), fn(pn) {
        let #(p, name) = pn
        json.object([
          #("id", id.transaction_party_json(p.id)),
          #("partyRole", party_role.to_json(p.party_role)),
          #("subjectKind", subject_kind.to_json(p.subject_kind)),
          #("subjectId", json.string(p.subject_id)),
          #("name", json.nullable(name, json.string)),
          #("removed", json.bool(p.removed)),
          #("removedAt", json.nullable(p.removed_at, json.int)),
          #("confirmedAt", json.nullable(p.confirmed_at, json.int)),
          #(
            "confirmedByKind",
            json.nullable(
              p.confirmed_by_kind,
              party_row.confirmed_by_kind_to_json,
            ),
          ),
          #("addedAt", json.int(p.added_at)),
          #("subjectRemovedAt", json.nullable(p.subject_removed_at, json.int)),
        ])
      }),
    ),
    #(
      "requiredPartyRoles",
      json.array(
        transaction_rules.required_party_roles(r.type_),
        party_role.to_json,
      ),
    ),
    #(
      "awaitingConfirmation",
      json.array(
        transaction_rules.awaiting_confirmation(r.type_, t.parties),
        party_role.to_json,
      ),
    ),
    #(
      "partiesConfirmed",
      json.bool(transaction_rules.parties_confirmed(r.type_, t.parties)),
    ),
    // Not ported yet: representations, consents and documents (their routes).
    #("representations", json.array([], json.string)),
    #("compliance", compliance_json(view, stale, is_agent, r)),
    #("consents", json.array([], json.string)),
    #("documents", json.array([], json.string)),
    // Absent, not redacted, so a hidden note's existence is not disclosed.
    #(
      "notes",
      t.notes
        |> list.filter(fn(n) {
          transaction_rules.can_see(note_visibility(n.visibility), roles, side)
        })
        |> json.array(note_json),
    ),
    #("linkedThreads", json.array([], json.string)),
    // The recruitment case is club-private: only the agent (and the club owning it) sees the reference.
    #(
      "links",
      json.object([
        #("trialId", json.nullable(r.link_trial_id, id.trial_json)),
        #("opportunityId", json.nullable(r.link_opportunity_id, json.string)),
        ..case r.link_recruitment_case_id, is_agent {
          Some(case_id), True -> [
            #("recruitmentCaseId", id.recruitment_case_json(case_id)),
          ]
          _, _ -> []
        }
      ]),
    ),
    #("terms", json.object([#("versions", json.array([], json.string))])),
    #(
      "offerBoundary",
      transaction_rules.readiness_json(transaction_rules.offer_readiness(
        r.status,
        t.parties,
        state,
        stale,
      )),
    ),
    #("hold", case r.status {
      transaction_status.OnHold ->
        json.object([
          #(
            "reasonCode",
            json.nullable(r.hold_reason_code, tx_row.hold_reason_code_to_json),
          ),
          #("reason", case roles {
            [] -> json.null()
            _ -> json.nullable(r.hold_reason, json.string)
          }),
          #("at", json.nullable(r.held_at, json.int)),
        ])
      _ -> json.null()
    }),
    #(
      "cancelReasonCode",
      json.nullable(r.cancel_reason_code, tx_row.cancel_reason_code_to_json),
    ),
    #(
      "closeReasonCode",
      json.nullable(r.close_reason_code, tx_row.close_reason_code_to_json),
    ),
    #("allowedTransitions", case is_agent {
      True ->
        json.array(
          transaction_rules.actor_transitions(r.status),
          transaction_status.to_json,
        )
      False -> json.array([], json.string)
    }),
    // Only an agent opens a workspace.
    #("initiatedBy", json.string("org")),
    #("initiatedAt", json.int(r.created_at)),
    #("createdAt", json.int(r.created_at)),
    #("updatedAt", json.int(r.updated_at)),
    ..list.append(rev.meta(rev.Rev(r.rev, r.rev_at, r.rev_by_label)), [
      #("honest", json.string(transaction_rules.honest)),
    ])
  ])
}

fn note_json(n: note_row.Row) -> Json {
  json.object([
    #("id", id.transaction_note_json(n.id)),
    #("visibility", note_row.visibility_to_json(n.visibility)),
    #("text", json.string(n.text)),
    #("at", json.int(n.at)),
    #(
      "actor",
      transaction_rules.actor_label(
        note_row.by_kind_to_string(n.by_kind),
        n.by_name,
      ),
    ),
  ])
}

/// `clear` is the current answer, so a client reading only it is never told a stale snapshot clears the workspace;
/// `snapshotClear` keeps what the last evaluation said.
fn compliance_json(
  view: Option(transaction_rules.View),
  stale: Option(staleness.Staleness),
  is_agent: Bool,
  r: tx_row.Row,
) -> Json {
  let honest =
    "ScoutBox has evaluated its own encoded rules. It has not determined anyone's legal rights and no governing body has approved anything."
  case view {
    None ->
      json.object([
        #("outcome", json.null()),
        #("pendingReason", json.string("PARTIES_NOT_CONFIRMED")),
        #("blocked", json.bool(False)),
        #("clear", json.bool(False)),
        #("reasonCodes", json.array([], json.string)),
        #("consentRequirements", json.array([], json.string)),
        #("evaluatedAt", json.null()),
        #("stale", json.string("NO_SNAPSHOT")),
        #("staleness", json.string("NO_SNAPSHOT")),
        #(
          "honest",
          json.string(
            "No compliance evaluation has been recorded for this transaction yet.",
          ),
        ),
      ])
    Some(v) -> {
      let s = v.state
      let pending = option.map(s.pending_reason, pending_reason.to_string)
      let stale_json = json.nullable(stale, staleness.to_json)
      json.object(
        list.flatten([
          [
            #("outcome", json.nullable(s.outcome, context_outcome.to_json)),
            #(
              "pendingReason",
              json.nullable(
                case stale {
                  Some(_) -> option.or(pending, Some("SNAPSHOT_STALE"))
                  None -> pending
                },
                json.string,
              ),
            ),
            #("blocked", json.bool(s.blocked)),
            #("clear", json.bool(s.clear && stale == None)),
            #("snapshotClear", json.bool(s.clear)),
            #("reasonCodes", json.array(s.reason_codes, json.string)),
            #(
              "consentRequirements",
              json.array(v.consent_requirements, fn(c) {
                json.object([
                  #("partyRole", party_role.to_json(c.party_role)),
                  #("consentKind", json.string(c.consent_kind)),
                  #("reasonCode", json.string(c.reason_code)),
                ])
              }),
            ),
            #("evaluatedAt", json.int(v.evaluated_at)),
            #("stale", stale_json),
            #("staleness", stale_json),
          ],
          case is_agent {
            True -> [
              #("evaluationId", json.nullable(v.evaluation_id, json.string)),
              #("contextId", id.compliance_context_json(r.context_id)),
              #("policyVersions", json.array(v.policy_versions, json.string)),
              #(
                "verificationFreshness",
                json.nullable(
                  r.compliance_verification_freshness,
                  facet_state.to_json,
                ),
              ),
            ]
            False -> []
          },
          [#("honest", json.string(honest))],
        ]),
      )
    }
  }
}

// ------------------------------------------------------------------------------------------------- create

type PartyInput {
  PartyInput(role: PartyRole, kind: SubjectKind, subject_id: String)
}

type CreateBody {
  CreateBody(
    type_: ContextType,
    jurisdictions: List(String),
    parties: Option(List(PartyInput)),
    case_id: Option(String),
    client_key: Option(String),
  )
}

/// AGENT_TRANSACTION_LIMITS and TRANSACTION_LIMITS.
const id_max = 80

const jurisdictions_max = 10

const parties_max = 4

const note_max = 2000

const notes_max = 200

fn create_shape() -> input.Shape(CreateBody) {
  let party = {
    use role <- input.field(
      "partyRole",
      input.required(input.one_of(party_role.pairs)),
    )
    use kind <- input.field(
      "subjectKind",
      input.required(input.one_of(subject_kind.pairs)),
    )
    use subject_id <- input.field("subjectId", input.required(input.id()))
    input.done(PartyInput(role, kind, subject_id))
  }
  use type_ <- input.field(
    "type",
    input.required(input.one_of(context_type.pairs)),
  )
  use jurisdictions <- input.field(
    "jurisdictions",
    input.required(input.items_between(
      input.matching("[A-Za-z]{3}"),
      1,
      jurisdictions_max,
    )),
  )
  use parties <- input.field(
    "parties",
    input.nullish(input.items_between(input.object(party), 0, parties_max)),
  )
  // '' cites no case, as an absent one does.
  use case_id <- input.field(
    "recruitmentCaseId",
    input.nullish(input.text(id_max)),
  )
  use client_key <- input.field(
    "clientKey",
    input.nullish(input.text(1_000_000)),
  )
  input.done(CreateBody(type_:, jurisdictions:, parties:, case_id:, client_key:))
}

fn client_key(
  raw: Option(String),
  next: fn(Option(String)) -> Response,
) -> Response {
  case idempotency.client_key(option.map(raw, dynamic.string)) {
    Ok(k) -> next(k)
    Error(message) -> err("TRANSACTION_CLIENT_KEY_INVALID", message, [])
  }
}

/// `POST /org/agent/transactions`.
pub fn create(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use m <- core_routes.membership(ctx, a)
  use <- core_routes.require(m, "transactions.write")
  use b, _ <- body(req, create_shape(), "TRANSACTION_INPUT_INVALID")
  use key <- client_key(b.client_key)
  let now = clock.now_ms()
  let jurisdictions = list.unique(list.map(b.jurisdictions, string.uppercase))
  let raw_parties = option.unwrap(b.parties, [])
  let fp =
    canonical.Object([
      #("type", canonical.Str(context_type.to_string(b.type_))),
      #("jurisdictions", canonical.strings(jurisdictions)),
      #(
        "parties",
        canonical.Array(
          list.map(raw_parties, fn(p) {
            canonical.Object([
              #("partyRole", canonical.Str(party_role.to_string(p.role))),
              #("subjectKind", canonical.Str(subject_kind.to_string(p.kind))),
              #("subjectId", canonical.Str(p.subject_id)),
            ])
          }),
        ),
      ),
    ])
    |> canonical.to_string
  let viewer = agent_viewer(m)
  use hit <- reading(ctx, fn(r) {
    case key {
      Some(k) -> transaction_store.by_create_key(r, a.org.id, a.user.id, k)
      None -> Ok(None)
    }
  })
  case hit {
    Some(t) ->
      case t.row.create_fp == Some(fp) {
        True -> {
          use view <- reading(ctx, project(_, t, viewer, now))
          http.json(
            200,
            json.object([
              #("transaction", view),
              #("idempotent", json.bool(True)),
            ]),
          )
        }
        False ->
          err(
            "TRANSACTION_IDEMPOTENCY_CONFLICT",
            "That idempotency key was used for a different request.",
            [],
          )
      }
    None ->
      case
        limits.limited(
          ctx.limits,
          limits.TransactionWrite,
          id.org_user_to_string(a.user.id),
          now,
        )
      {
        True -> rate_limited(limits.TransactionWrite)
        False -> {
          // An unverified licence does not open a transaction.
          use gate <- reading(ctx, compliance_store.facet_gate(
            _,
            a.user.id,
            jurisdictions,
            now,
          ))
          case gate {
            Some(problem) -> gate_refusal(problem)
            None -> {
              use resolved <- reading(ctx, resolve_parties(
                _,
                a,
                raw_parties,
                b.type_,
                now,
              ))
              case resolved {
                Error(response) -> response
                Ok(parties) ->
                  create_checked(
                    ctx,
                    a,
                    viewer,
                    b,
                    key,
                    fp,
                    jurisdictions,
                    parties,
                    now,
                  )
              }
            }
          }
        }
      }
  }
}

fn gate_refusal(problem: compliance_store.GateProblem) -> Response {
  case problem {
    compliance_store.Unsupported(reasons:, policy_versions:) ->
      err(
        "JURISDICTION_UNSUPPORTED",
        "No encoded policy covers this jurisdiction. A transaction cannot be opened for it.",
        [
          #(
            "reasons",
            json.array(reasons, fn(r) {
              json.object([
                #("code", json.string(r.code)),
                #("ruleId", json.nullable(r.rule_id, json.string)),
                #("ruleStatus", rule_status.to_json(r.rule_status)),
                #("policyVersion", json.nullable(r.policy_version, json.string)),
              ])
            }),
          ),
          #("policyVersions", json.array(policy_versions, json.string)),
        ],
      )
    compliance_store.FacetMissing(g) ->
      err(
        g.code,
        "A regulated action needs a VERIFIED "
          <> agent_facet.to_string(g.facet)
          <> case g.member_association {
          Some(ma) -> " (" <> jurisdiction.to_string(ma) <> ")"
          None -> ""
        }
          <> "; it is "
          <> facet_state.to_string(g.state)
          <> ".",
        [],
      )
    // The TypeScript server builds this message from the facet fields a missing profile does not have.
    compliance_store.NoProfile ->
      err(
        "AGENT_VERIFICATION_REQUIRED",
        "A regulated action needs a VERIFIED undefined; it is undefined.",
        [],
      )
  }
}

/// A missing player, a minor, an invisible player and one who blocked the agency all answer the same 404, so the
/// route is not an age or a block oracle.
fn resolve_parties(
  read: Read,
  a: OrgAccess,
  raw: List(PartyInput),
  type_: ContextType,
  now: Int,
) -> Result(Result(List(PartyInput), Response), Fail(e)) {
  let unavailable = fn() {
    err("TRANSACTION_PARTY_NOT_FOUND", "No such party is available to you.", [])
  }
  let invalid = fn(message) {
    err("TRANSACTION_INPUT_INVALID", message, [
      #("field", json.string("partyRole")),
    ])
  }
  list.try_fold(raw, Ok([]), fn(acc, p) {
    case acc {
      Error(_) -> Ok(acc)
      Ok(seen) -> {
        use checked <- result.map(
          case
            p.role == party_role.ReleasingEntity
            && !transaction_rules.has_releasing_party(type_),
            p.kind,
            p.role
          {
            True, _, _ ->
              Ok(
                Error(invalid(
                  "A releasing entity exists only in a transfer or a loan.",
                )),
              )
            False, subject_kind.Player, party_role.Individual -> {
              use found <- result.map(players.for_org(
                read,
                id.player(p.subject_id),
                a.org,
                now,
              ))
              case found {
                Some(#(pl, access)) if access.visible && !access.blocked ->
                  case players.is_adult(pl, now) {
                    True -> Ok(p)
                    False -> Error(unavailable())
                  }
                _ -> Error(unavailable())
              }
            }
            False, subject_kind.Player, _ ->
              Ok(Error(invalid("A player is the individual party.")))
            False, subject_kind.Club, party_role.Individual ->
              Ok(Error(invalid("A club is an engaging or a releasing entity.")))
            False, subject_kind.Club, _ -> {
              use org <- result.map(orgs.by_id(read, id.org(p.subject_id)))
              case org {
                Some(o) if o.type_ == org_type.Club -> Ok(p)
                _ -> Error(unavailable())
              }
            }
          },
        )
        case checked {
          Error(response) -> Error(response)
          Ok(p) ->
            case list.any(seen, fn(x: PartyInput) { x.role == p.role }) {
              True ->
                Error(
                  err(
                    "TRANSACTION_PARTY_EXISTS",
                    "A "
                      <> party_role.to_string(p.role)
                      <> " party is already named.",
                    [#("partyRole", party_role.to_json(p.role))],
                  ),
                )
              False -> Ok(list.append(seen, [p]))
            }
        }
      }
    }
  })
}

fn create_checked(
  ctx: Ctx,
  a: OrgAccess,
  viewer: Viewer,
  b: CreateBody,
  key: Option(String),
  fp: String,
  jurisdictions: List(String),
  parties: List(PartyInput),
  now: Int,
) -> Response {
  let subject = fn(role) {
    list.find(parties, fn(p) { p.role == role })
    |> result.map(fn(p) { p.subject_id })
    |> option.from_result
  }
  let individual = subject(party_role.Individual)
  use dup <- reading(ctx, fn(r) {
    case individual {
      Some(player) ->
        transaction_store.duplicate_of(
          r,
          player,
          b.type_,
          subject(party_role.EngagingEntity),
          subject(party_role.ReleasingEntity),
        )
      None -> Ok(None)
    }
  })
  case dup {
    // A loan beside a transfer, or a second engaging club, is a separate transaction and is not refused.
    Some(_) ->
      err(
        "TRANSACTION_DUPLICATE_CONTEXT",
        "A live transaction already covers this individual, this type and these clubs. Continue in that one, or end it first.",
        [],
      )
    None -> {
      // A reference only: nothing about the recruitment case is copied in.
      let case_ref = input.filled(b.case_id)
      let by = by_agent(a)
      store.unit(ctx.store, fn(tx) {
        use transaction_id <- result.try(id.next_transaction(tx) |> storage)
        // A cited case must have invited this agency. Bound in the same unit, so a citation that does not check
        // out creates no transaction at all.
        use problem <- result.try(
          case case_ref {
            Some(case_id) ->
              handoffs.bind(
                tx,
                case_id,
                transaction_id,
                a.org.id,
                a.user.id,
                individual,
                now,
              )
            None -> Ok(None)
          }
          |> storage,
        )
        case problem {
          Some(code) ->
            store.refuse(
              err(
                code,
                "No open invitation from that recruitment case is addressed to you. A club invites a workspace; citing a case you were not invited to does not open one.",
                [],
              ),
            )
          None -> {
            use policies <- result.try(
              approach_policy.published(store.reading(tx)) |> storage,
            )
            let set = approach_policy.applicable(policies, jurisdictions, now)
            use context_id <- result.try(
              compliance_store.open(
                tx,
                a.org.id,
                a.user.id,
                b.type_,
                jurisdictions,
                transaction_id,
                list.map(set.policies, approach_policy.policy_id),
                by,
                now,
              )
              |> storage,
            )
            use rows <- result.try(
              list.index_map(parties, fn(p, i) { #(p, i) })
              |> list.try_map(fn(pi) {
                let #(p, ord) = pi
                use party_id <- result.map(id.next_transaction_party(tx))
                party_row.Row(
                  ..party_row.new(
                    id: party_id,
                    transaction_id:,
                    transaction_type: b.type_,
                    ord:,
                    party_role: p.role,
                    subject_kind: p.kind,
                    subject_id: p.subject_id,
                    added_at: now,
                    added_by_id: a.user.id,
                    removed: False,
                  ),
                  added_by_name: Some(a.user.name),
                )
              })
              |> storage,
            )
            use _ <- result.try(
              transaction_store.create(
                tx,
                transaction_store.New(
                  id: transaction_id,
                  agency_org_id: a.org.id,
                  agent_user_id: a.user.id,
                  agent_name: a.user.name,
                  type_: b.type_,
                  jurisdictions:,
                  context_id:,
                  recruitment_case_id: option.map(case_ref, id.recruitment_case),
                  parties: rows,
                  create_key: option.map(key, fn(k) { #(k, fp) }),
                ),
                by,
                now,
              )
              |> storage,
            )
            use _ <- result.try(recheck(tx, transaction_id, by, now) |> storage)
            store.emit(
              tx,
              effect.Live(live_event.AgentTransactionCreated(
                org_id: id.org_to_string(a.org.id),
                tx_id: id.transaction_to_string(transaction_id),
              )),
            )
            use _ <- result.try(
              list.try_each(rows, fn(p) {
                notify_party(
                  tx,
                  transaction_id,
                  p,
                  "A transaction workspace has been opened naming you as the "
                    <> string.replace(
                    party_role.to_string(p.party_role),
                    "_",
                    " ",
                  )
                    <> ". Confirm your participation to let it proceed. Confirming does not agree to any terms.",
                  now,
                )
              })
              |> storage,
            )
            let read = store.reading(tx)
            use stored <- result.try(
              transaction_store.by_id(read, transaction_id) |> storage,
            )
            let assert Some(stored) = stored
              as "the transaction was just written"
            use view <- result.map(
              project(read, stored, viewer, now) |> storage,
            )
            http.json(201, json.object([#("transaction", view)]))
          }
        }
      })
      |> answer
    }
  }
}

/// A player hears directly; a club through its recorded signatories (its verification administrators).
fn notify_party(
  tx: Tx,
  transaction_id: id.TransactionId,
  p: party_row.Row,
  text: String,
  now: Int,
) -> Result(Nil, Fail(e)) {
  let ref = Some(id.transaction_to_string(transaction_id))
  case p.subject_kind {
    subject_kind.Player ->
      notifications.notify(
        tx,
        to: audience.Player,
        id: p.subject_id,
        type_: "agent_transaction_action",
        text:,
        ref_id: ref,
        at: now,
      )
    subject_kind.Club -> {
      use admins <- result.try(records.active_admins_of(
        store.reading(tx),
        id.org(p.subject_id),
      ))
      list.try_each(admins, fn(admin) {
        notifications.notify(
          tx,
          to: audience.OrgUser,
          id: id.org_user_to_string(admin.user_id),
          type_: "agent_transaction_action",
          text:,
          ref_id: ref,
          at: now,
        )
      })
    }
  }
}

// ------------------------------------------------------------------------------------------------- notes

type NoteBody {
  NoteBody(text: Option(String), visibility: Option(String))
}

/// The agent's own workspace. A colleague's is 404, not 403, so a colleague's client work is not disclosed.
fn own_transaction(
  ctx: Ctx,
  m: Member,
  transaction_id: String,
  next: fn(Transaction) -> Response,
) -> Response {
  use found <- reading(ctx, transaction_store.by_id(
    _,
    id.transaction(transaction_id),
  ))
  case found {
    Some(t)
      if t.row.agency_org_id == m.access.org.id
      && t.row.agent_user_id == m.access.user.id
    -> next(t)
    _ -> not_found()
  }
}

/// The record stays readable; a write stops with one answer for removed, invisible, blocked and minor, so the
/// refusal is not an oracle.
fn writable(ctx: Ctx, t: Transaction, next: fn() -> Response) -> Response {
  let now = clock.now_ms()
  use guard <- reading(ctx, safeguarding_problem(_, t, now))
  let status = [#("status", transaction_status.to_json(t.row.status))]
  case guard, t.row.status, transaction_rules.is_live(t.row.status) {
    Some(_), _, _ ->
      err(
        "TRANSACTION_PARTY_UNAVAILABLE",
        "A party to this transaction is no longer available to your organisation. Nothing further can be written to it; its record stays.",
        [],
      )
    None, transaction_status.Archived, _ ->
      err(
        "TRANSACTION_ARCHIVED",
        "An archived transaction is read-only.",
        status,
      )
    None, _, False ->
      err(
        "TRANSACTION_NOT_LIVE",
        "This transaction has ended. Its record stays; nothing further can be written to it.",
        status,
      )
    None, _, True -> next()
  }
}

/// `POST /org/agent/transactions/:id/notes`.
pub fn add_note(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  transaction_id: String,
) -> Response {
  use m <- core_routes.membership(ctx, a)
  use <- core_routes.require(m, "transactions.write")
  use t <- own_transaction(ctx, m, transaction_id)
  use <- writable(ctx, t)
  let now = clock.now_ms()
  case
    !http.rerun(req)
    && limits.limited(
      ctx.limits,
      limits.TransactionNoteWrite,
      id.org_user_to_string(a.user.id),
      now,
    )
  {
    True -> rate_limited(limits.TransactionNoteWrite)
    False -> {
      let shape = {
        use text <- input.field("text", input.nullish(input.text(note_max)))
        use visibility <- input.field(
          "visibility",
          input.optional(input.text(60)),
        )
        use <- rev.fields
        input.done(NoteBody(text, visibility))
      }
      use b, raw <- body(req, shape, "NOTE_INPUT_INVALID")
      let viewer = agent_viewer(m)
      let roles =
        transaction_rules.room_roles(
          id.org_to_string(t.row.agency_org_id),
          id.org_user_to_string(t.row.agent_user_id),
          t.parties,
          viewer,
        )
      let allowed =
        transaction_rules.uploadable(roles, None)
        |> list.filter(fn(v) { v != document_visibility.TAndSOnly })
      let visibility = option.unwrap(b.visibility, "")
      case option.map(b.text, string.trim) |> option.unwrap("") {
        "" ->
          err("NOTE_INPUT_INVALID", "A note needs text.", [
            #("field", json.string("text")),
            #("problem", json.string("required")),
          ])
        text ->
          case
            list.find(allowed, fn(v) {
              document_visibility.to_string(v) == visibility
            }),
            note_row.visibility_from_string(visibility)
          {
            Ok(_), Ok(class) ->
              case list.length(t.notes) >= notes_max {
                True ->
                  err(
                    "NOTE_INPUT_INVALID",
                    "This transaction already holds the maximum number of notes.",
                    [#("field", json.string("text"))],
                  )
                False -> {
                  use expected <- rev_expected(raw)
                  use <- rev.guard(
                    expected,
                    rev.Rev(t.row.rev, t.row.rev_at, t.row.rev_by_label),
                    "TRANSACTION_VERSION_CONFLICT",
                    [
                      #(
                        "current",
                        json.object([
                          #("status", transaction_status.to_json(t.row.status)),
                        ]),
                      ),
                    ],
                  )
                  write_note(ctx, a, t, class, text, now)
                }
              }
            _, _ ->
              domain_errors.send(contract, "DOCUMENT_VISIBILITY_NOT_PERMITTED", [
                #("visibility", case visibility {
                  "" -> json.null()
                  v -> json.string(v)
                }),
                #("allowed", json.array(allowed, document_visibility.to_json)),
              ])
          }
      }
    }
  }
}

fn rev_expected(raw: Dynamic, next: fn(rev.Expected) -> Response) -> Response {
  case rev.expected(raw) {
    Ok(e) -> next(e)
    Error(response) -> response
  }
}

fn write_note(
  ctx: Ctx,
  a: OrgAccess,
  t: Transaction,
  class: note_row.Visibility,
  text: String,
  now: Int,
) -> Response {
  let by = by_agent(a)
  store.unit(ctx.store, fn(tx) {
    // The rev the checks read must still hold: two notes at once take ords in turn, never the same one.
    use current <- result.try(
      transaction_store.by_id(store.reading(tx), t.row.id) |> storage,
    )
    case option.map(current, fn(c) { c.row.rev }) == Some(t.row.rev) {
      False ->
        store.stale(
          "the transaction moved from rev " <> string.inspect(t.row.rev),
        )
      True -> {
        use note <- result.map(
          transaction_store.add_note(
            tx,
            t.row.id,
            class,
            text,
            by,
            note_row.Org,
            now,
          )
          |> storage,
        )
        http.json(201, json.object([#("note", note_json(note))]))
      }
    }
  })
  |> answer
}

// ------------------------------------------------------------------------------------------------- the Offer seam

/// What the Offer workflow reads. None unless the asking club is the engaging entity and the workspace is linked
/// to exactly the Offer's case, so a club cannot probe for a workspace by id from an unrelated case.
pub fn offer_readiness_for(
  read: Read,
  transaction_id: String,
  org_id: id.OrgId,
  case_id: id.RecruitmentCaseId,
  now: Int,
) -> Result(Option(#(Transaction, transaction_rules.Readiness)), Fail(e)) {
  use found <- result.try(case transaction_id {
    "" -> Ok(None)
    _ -> transaction_store.by_id(read, id.transaction(transaction_id))
  })
  case found {
    Some(t) if t.row.link_recruitment_case_id == Some(case_id) ->
      case
        transaction_rules.club_party_role(t.parties, id.org_to_string(org_id))
      {
        Some(party_role.EngagingEntity) -> {
          use view <- result.try(compliance_of(read, t))
          use stale <- result.map(staleness_of(read, t, view, now))
          Some(#(
            t,
            transaction_rules.offer_readiness(
              t.row.status,
              t.parties,
              option.map(view, fn(v) { v.state }),
              stale,
            ),
          ))
        }
        _ -> Ok(None)
      }
    _ -> Ok(None)
  }
}
