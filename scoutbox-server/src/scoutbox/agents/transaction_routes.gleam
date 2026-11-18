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
import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/agents/agent_rules
import scoutbox/agents/agent_store
import scoutbox/agents/approach_policy
import scoutbox/agents/compliance_routes
import scoutbox/agents/compliance_store.{type By}
import scoutbox/agents/conflict
import scoutbox/agents/consent_store
import scoutbox/agents/core_routes.{type Member}
import scoutbox/agents/handoffs
import scoutbox/agents/reviews
import scoutbox/agents/transaction_rules.{
  type RoomRole, type State, type Viewer, AgencyViewer, RepresentingAgent,
}
import scoutbox/agents/transaction_store.{type Transaction}
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/orgs
import scoutbox/identity/players
import scoutbox/messaging/channels
import scoutbox/messaging/notifications
import scoutbox/platform/canonical
import scoutbox/platform/clock
import scoutbox/platform/effect
import scoutbox/platform/http
import scoutbox/platform/idempotency
import scoutbox/platform/input
import scoutbox/platform/limits
import scoutbox/platform/live_event
import scoutbox/platform/paging
import scoutbox/platform/rev
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/platform/temporal
import scoutbox/recruitment/domain_errors.{Contract}
import scoutbox/rows/agent_transactions as tx_row
import scoutbox/rows/agreement_scopes as agreement_scope_row
import scoutbox/rows/id
import scoutbox/rows/regulatory_consents as consent_row
import scoutbox/rows/regulatory_reviews as review_row
import scoutbox/rows/transaction_documents as doc_row
import scoutbox/rows/transaction_history as event_row
import scoutbox/rows/transaction_keys as key_row
import scoutbox/rows/transaction_linked_threads as thread_row
import scoutbox/rows/transaction_notes as note_row
import scoutbox/rows/transaction_parties as party_row
import scoutbox/rows/transaction_representation_scopes as scope_row
import scoutbox/rows/transaction_representations as rep_row
import scoutbox/rows/transaction_terms_versions as terms_row
import scoutbox/verification/records
import scoutbox/vocab/agent_facet
import scoutbox/vocab/agreement_status
import scoutbox/vocab/audience
import scoutbox/vocab/compliance_actor_kind
import scoutbox/vocab/context_outcome
import scoutbox/vocab/context_type.{type ContextType}
import scoutbox/vocab/declared_representation_status
import scoutbox/vocab/document_visibility
import scoutbox/vocab/facet_state
import scoutbox/vocab/jurisdiction
import scoutbox/vocab/org_type
import scoutbox/vocab/party
import scoutbox/vocab/party_role.{type PartyRole}
import scoutbox/vocab/pending_reason
import scoutbox/vocab/rule_status
import scoutbox/vocab/staleness
import scoutbox/vocab/subject_kind.{type SubjectKind}
import scoutbox/vocab/transaction_status
import sqlight
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

pub fn err(
  code: String,
  message: String,
  fields: List(#(String, Json)),
) -> Response {
  domain_errors.refuse(contract, code, message, fields)
}

pub fn not_found() -> Response {
  err(
    "TRANSACTION_NOT_FOUND",
    "No transaction with that reference is available to you.",
    [],
  )
}

pub fn rate_limited(action: limits.Action) -> Response {
  http.json(
    429,
    json.object(
      list.map(limits.limited_body(action), fn(p) { #(p.0, json.string(p.1)) }),
    ),
  )
}

pub fn storage(r: Result(a, Fail(e))) -> Result(a, Fail(Response)) {
  store.map_refusal(r, fn(_) { http.error(500, "INTERNAL") })
}

pub fn answer(r: Result(Response, store.UnitError(Response))) -> Response {
  case r {
    Ok(response) -> response
    Error(store.Refused(response)) -> response
    Error(store.Lost(what)) -> http.stale(what)
    Error(e) -> http.internal(e)
  }
}

pub fn reading(
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

pub fn body(
  req: Request,
  shape: input.Shape(a),
  default: String,
  next: fn(a, Dynamic) -> Response,
) -> Response {
  body_coded(req, shape, default, field_codes, next)
}

fn body_coded(
  req: Request,
  shape: input.Shape(a),
  default: String,
  codes: List(#(String, String)),
  next: fn(a, Dynamic) -> Response,
) -> Response {
  use raw <- http.json_body(req)
  case input.parse_coded(shape, raw, root: "body", codes:, default:) {
    Ok(v) -> next(v, raw)
    Error(r) -> domain_errors.send(contract, r.error, input.refusal_fields(r))
  }
}

// ------------------------------------------------------------------------------------------------- actors

pub fn by_agent(a: OrgAccess) -> By {
  compliance_store.By(
    kind: compliance_actor_kind.Org,
    id: Some(id.org_user_to_string(a.user.id)),
    name: Some(a.user.name),
    role: None,
    org_id: None,
  )
}

pub fn agent_viewer(m: Member) -> Viewer {
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
    evaluation_id: row.compliance_evaluation_id,
    gate: row.compliance_gate,
    evaluated_at: at,
    pending_reason: row.compliance_pending_reason,
    party_revision: revision,
  )
}

/// The snapshot as it reads now: what it says, read back from the evaluation it names.
pub fn compliance_of(
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
  use reps <- result.try(transaction_store.representations(read, t.row.id))
  party_revision_with(read, t, reps, now)
}

fn party_revision_with(
  read: Read,
  t: Transaction,
  reps: List(transaction_store.Representation),
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
  use consents <- result.try(consent_store.for_context(read, t.row.context_id))
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
    list.map(reps, fn(r) {
      #(
        id.org_user_to_string(r.row.agent_user_id),
        r.row.party_role,
        declared_representation_status.to_string(r.row.status),
        option.map(r.row.agreement_id, id.agreement_to_string),
      )
    }),
    list.map(consents, fn(k) {
      #(id.consent_to_string(k.row.id), consent_store.status(k))
    }),
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
pub fn staleness_of(
  read: Read,
  t: Transaction,
  view: Option(transaction_rules.View),
  now: Int,
) -> Result(Option(staleness.Staleness), Fail(e)) {
  use reps <- result.try(transaction_store.representations(read, t.row.id))
  staleness_with(read, t, reps, view, now)
}

fn staleness_with(
  read: Read,
  t: Transaction,
  reps: List(transaction_store.Representation),
  view: Option(transaction_rules.View),
  now: Int,
) -> Result(Option(staleness.Staleness), Fail(e)) {
  use current <- result.try(party_revision_with(read, t, reps, now))
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
pub fn safeguarding_problem(
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

fn gate_of(problem: compliance_store.GateProblem) -> tx_row.ComplianceGate {
  case problem {
    compliance_store.Unsupported(..) -> tx_row.JurisdictionUnsupported
    _ -> tx_row.FacetNotVerified
  }
}

/// What a re-check found: a safeguarding problem (no compliance verdict is recorded), or the state it recorded and
/// the status the transaction is now at.
pub type Recheck {
  Guarded(String)
  Checked(state: State, status: transaction_status.TransactionStatus)
}

/// Run after every material act, so an old evaluation can never authorise a new one. The status moves through
/// the compliance transition map only.
pub fn recheck(
  tx: Tx,
  transaction_id: id.TransactionId,
  by: By,
  now: Int,
) -> Result(Recheck, Fail(e)) {
  let read = store.reading(tx)
  use found <- result.try(transaction_store.by_id(read, transaction_id))
  let assert Some(t) = found as "the transaction was just written"
  use guard <- result.try(safeguarding_problem(read, t, now))
  use reps <- result.try(transaction_store.representations(read, t.row.id))
  let live_reps =
    list.filter(reps, fn(r) {
      r.row.status != declared_representation_status.Withdrawn
    })
  let rep_count = list.length(live_reps)
  case guard {
    // Not a compliance verdict: the snapshot is not refreshed.
    Some(problem) -> Ok(Guarded(problem))
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
          let gate = gate_of(problem)
          let state =
            transaction_rules.state_from(
              None,
              Some(transaction_rules.gate_reason(gate)),
              codes,
              rep_count,
              confirmed,
            )
          snapshot(tx, t, state, Gated(gate), [], by, now)
          |> result.map(Checked(state, _))
        }
        None -> {
          use ctx <- result.try(compliance_store.by_id(read, t.row.context_id))
          let assert Some(ctx) = ctx as "a transaction has its context"
          use _ <- result.try(compliance_store.project(
            tx,
            ctx.row.id,
            t.parties,
            list.map(live_reps, fn(r) { r.row }),
          ))
          use ctx <- result.try(compliance_store.by_id(read, t.row.context_id))
          let assert Some(ctx) = ctx as "a transaction has its context"
          use policies <- result.try(approach_policy.published(read))
          use consents <- result.try(consent_store.engine_consents(
            read,
            ctx.row.id,
          ))
          use engine <- result.try(compliance_store.engine_input(
            read,
            ctx,
            policies,
            now,
            None,
            consents,
          ))
          let result = conflict.evaluate(engine)
          use evaluation_id <- result.try(compliance_store.record_evaluation(
            tx,
            ctx,
            result,
            None,
            by,
            now,
          ))
          let state =
            transaction_rules.state_from(
              Some(result.outcome),
              None,
              conflict.reason_codes(result.reasons),
              rep_count,
              confirmed,
            )
          snapshot(
            tx,
            t,
            state,
            Evaluated(evaluation_id),
            result.policy_versions,
            by,
            now,
          )
          |> result.map(Checked(state, _))
        }
      }
    }
  }
}

/// What a compliance snapshot rests on: an evaluation, or the gate that refused before one.
type Basis {
  Evaluated(id.EvaluationId)
  Gated(tx_row.ComplianceGate)
}

fn snapshot(
  tx: Tx,
  t: Transaction,
  state: State,
  basis: Basis,
  policy_versions: List(id.PolicyId),
  by: By,
  now: Int,
) -> Result(transaction_status.TransactionStatus, Fail(e)) {
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
      evaluation_id: case basis {
        Evaluated(evaluation_id) -> Some(evaluation_id)
        Gated(_) -> None
      },
      gate: case basis {
        Evaluated(_) -> None
        Gated(gate) -> Some(gate)
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
  let status = option.unwrap(to, t.row.status)
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
  use _ <- result.map(case option.map(prev, fn(v) { v.state }) == Some(state) {
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
  })
  status
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
            Some(#(pl, access)) if access.visible && !access.blocked ->
              Some(pl.row.name)
            _ -> None
          }
        }
      }
    }
  }
}

pub fn note_visibility(
  v: note_row.Visibility,
) -> document_visibility.DocumentVisibility {
  let assert Ok(d) =
    document_visibility.from_string(note_row.visibility_to_string(v))
    as "every note class is a document class"
  d
}

/// The viewer's side, for a club; the individual, for a player.
pub fn side_of(t: Transaction, viewer: Viewer) -> Option(PartyRole) {
  case viewer {
    transaction_rules.ClubViewer(org_id:, ..) ->
      transaction_rules.club_party_role(t.parties, org_id)
    transaction_rules.PlayerViewer(_) -> Some(party_role.Individual)
    _ -> None
  }
}

pub fn roles_of(t: Transaction, viewer: Viewer) -> List(RoomRole) {
  transaction_rules.room_roles(
    id.org_to_string(t.row.agency_org_id),
    id.org_user_to_string(t.row.agent_user_id),
    t.parties,
    viewer,
  )
}

/// Transaction membership does not make a linked thread readable: the Inbox's own gate decides.
fn channel_readable(
  read: Read,
  channel_id: id.ChannelId,
  viewer: Viewer,
) -> Result(Bool, Fail(e)) {
  use found <- result.map(channels.by_id(read, channel_id))
  case found, viewer {
    Some(ch), transaction_rules.PlayerViewer(player_id) ->
      id.player_to_string(ch.row.player_id) == player_id
      && ch.row.counterparty == party.Player
    Some(ch), transaction_rules.ClubViewer(org_id:, ..) ->
      id.org_to_string(ch.row.org_id) == org_id
    _, _ -> False
  }
}

pub fn thread_json(
  read: Read,
  th: thread_row.Row,
  viewer: Viewer,
) -> Result(Json, Fail(e)) {
  use readable <- result.map(channel_readable(read, th.channel_id, viewer))
  json.object([
    #("id", id.linked_thread_json(th.id)),
    #("channelId", id.channel_json(th.channel_id)),
    #("linkedAt", json.int(th.linked_at)),
    #("actor", transaction_rules.actor_label("club_user", th.linked_by_name)),
    #("readable", json.bool(readable)),
  ])
}

/// Asked before a club is shown a case reference, so it sees only its own case id.
fn case_belongs_to(
  read: Read,
  case_id: id.RecruitmentCaseId,
  org_id: String,
) -> Result(Bool, Fail(e)) {
  store.one(
    read,
    "SELECT org_id FROM recruitment_cases WHERE id = ?",
    [id.recruitment_case_sql(case_id)],
    decode.at([0], decode.string),
  )
  |> result.map(fn(found) { found == Ok(org_id) })
}

fn representation_json(
  r: transaction_store.Representation,
  is_agent: Bool,
) -> Json {
  let row = r.row
  json.object(
    list.append(
      [
        #("id", id.representation_json(row.id)),
        #("partyRole", party_role.to_json(row.party_role)),
        #("agentUserId", id.org_user_json(row.agent_user_id)),
        #("status", declared_representation_status.to_json(row.status)),
        #("declaredOnly", json.bool(row.declared_only)),
        #(
          "basis",
          json.string(case row.agreement_id {
            Some(_) -> "client_confirmed_agreement"
            None -> "declared"
          }),
        ),
        #("scope", json.array(r.scope, scope_row.scope_to_json)),
        #(
          "jurisdictions",
          json.array(option.values([row.jurisdiction]), json.string),
        ),
        #("verifiedAt", json.nullable(row.verified_at, json.int)),
        #("withdrawnAt", json.nullable(row.withdrawn_at, json.int)),
        #("createdAt", json.int(row.created_at)),
      ],
      case is_agent {
        True -> [
          #("agreementId", json.nullable(row.agreement_id, id.agreement_json)),
          #("reviewId", json.nullable(row.review_id, id.regulatory_review_json)),
          #("firstActAt", json.nullable(row.first_act_at, json.int)),
        ]
        False -> []
      },
    ),
  )
}

pub fn uploader_kind(d: doc_row.Row) -> String {
  doc_row.uploaded_by_kind_to_string(d.uploaded_by_kind)
}

/// An unreadable expiry reads expired, never "current"; none never expires.
pub fn expired(d: doc_row.Row, now: Int) -> Bool {
  case d.expires_at {
    Some(at) -> now >= at
    None -> False
  }
}

pub fn document_json(
  d: transaction_store.Document,
  roles: List(RoomRole),
  side: Option(PartyRole),
  now: Int,
) -> Json {
  let r = d.row
  json.object([
    #("id", id.transaction_document_json(r.id)),
    #("documentType", doc_row.document_type_to_json(r.document_type)),
    #("visibility", document_visibility.to_json(r.visibility)),
    #("version", json.int(r.version)),
    #("label", json.string(r.label)),
    #("ownerKind", doc_row.owner_kind_to_json(r.owner_kind)),
    #("ownerPartyRole", json.nullable(r.owner_party_role, party_role.to_json)),
    #("uploadedAt", json.int(r.created_at)),
    #(
      "actor",
      transaction_rules.actor_label(uploader_kind(r), r.uploaded_by_name),
    ),
    #("expiresAt", json.nullable(r.expires_at, json.int)),
    #("expired", json.bool(expired(r, now))),
    // No writer objectively knows a signature instant, so none is claimed.
    #("signedAt", json.null()),
    #(
      "supersedes",
      json.nullable(r.supersedes_id, id.transaction_document_json),
    ),
    #("evidence", case r.evidence_id {
      Some(_) ->
        json.object([
          #("kind", json.string("verification_evidence")),
          #("present", json.bool(True)),
        ])
      None -> json.null()
    }),
    #(
      "downloadable",
      json.bool(
        r.evidence_id != None
        && transaction_rules.can_see(r.visibility, roles, side),
      ),
    ),
    ..rev.meta(rev.Rev(r.rev, r.rev_at, r.rev_by_name))
  ])
}

fn terms_visibility(
  v: terms_row.Visibility,
) -> document_visibility.DocumentVisibility {
  let assert Ok(d) =
    document_visibility.from_string(terms_row.visibility_to_string(v))
    as "every terms class is a document class"
  d
}

fn consent_json(
  k: consent_store.Consent,
  viewer: Viewer,
  is_agent: Bool,
) -> Json {
  let r = k.row
  let mine = case viewer, r.subject_kind {
    transaction_rules.PlayerViewer(player_id), subject_kind.Player ->
      r.subject_id == player_id
    transaction_rules.ClubViewer(org_id:, ..), subject_kind.Club ->
      r.subject_id == org_id
    _, _ -> False
  }
  json.object(
    list.append(
      [
        #("id", case mine || is_agent {
          True -> id.consent_json(r.id)
          False -> json.null()
        }),
        #("kind", consent_row.kind_to_json(r.kind)),
        #("partyRole", party_role.to_json(r.party_role)),
        #("status", json.string(consent_store.status(k))),
        #("requestedAt", json.int(r.requested_at)),
        #("grantedAt", json.nullable(r.granted_at, json.int)),
        #("declinedAt", json.nullable(r.declined_at, json.int)),
        #("revokedAt", json.nullable(consent_store.revoked_at(k), json.int)),
        #("mine", json.bool(mine)),
      ],
      case mine {
        True -> [
          #("particulars", consent_particulars(r)),
          #("policyVersions", json.array(k.policy_versions, id.policy_json)),
        ]
        False -> []
      },
    ),
  )
}

pub fn consent_particulars(r: consent_row.Row) -> Json {
  json.object([
    #("fullParticularsProvided", json.bool(r.full_particulars_provided)),
    #("legalAdviceOffered", json.bool(r.legal_advice_offered)),
    #("proposedFeeDisclosed", json.bool(r.proposed_fee_disclosed)),
    #("acknowledged", case r.acknowledged_at {
      Some(at) ->
        json.object([
          #("particulars", json.bool(True)),
          #("legalAdvice", json.bool(True)),
          #("at", json.int(at)),
        ])
      None -> json.null()
    }),
  ])
}

/// One workspace, projected for one viewer from the roles the server derived.
pub fn project(
  read: Read,
  t: Transaction,
  viewer: Viewer,
  now: Int,
) -> Result(Json, Fail(e)) {
  let r = t.row
  let roles = roles_of(t, viewer)
  let side = side_of(t, viewer)
  let is_agent = list.contains(roles, RepresentingAgent)
  use reps <- result.try(transaction_store.representations(read, r.id))
  use docs <- result.try(transaction_store.documents(read, r.id))
  use consents <- result.try(consent_store.for_context(read, r.context_id))
  use view <- result.try(compliance_of(read, t))
  use stale <- result.try(staleness_with(read, t, reps, view, now))
  use agency <- result.try(orgs.by_id(read, r.agency_org_id))
  use names <- result.try(
    list.try_map(t.parties, party_name(read, _, viewer, now)),
  )
  use threads <- result.try(
    list.try_map(t.threads, thread_json(read, _, viewer)),
  )
  use own_case <- result.map(case r.link_recruitment_case_id, viewer, side {
    Some(case_id),
      transaction_rules.ClubViewer(org_id:, ..),
      Some(party_role.EngagingEntity)
    -> case_belongs_to(read, case_id, org_id)
    _, _, _ -> Ok(False)
  })
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
  let sees_terms =
    is_agent
    || list.contains(roles, transaction_rules.PartyClubSignatory)
    || list.contains(roles, transaction_rules.PartyIndividual)
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
    // Every party sees who represents which party and on what basis, never fee terms.
    #("representations", json.array(reps, representation_json(_, is_agent))),
    #("compliance", compliance_json(view, stale, is_agent, r)),
    // A party sees its own consent in full and another party's as a state only.
    #("consents", json.array(consents, consent_json(_, viewer, is_agent))),
    #(
      "documents",
      docs
        |> list.filter(fn(d) {
          transaction_rules.can_see(d.row.visibility, roles, side)
          && d.superseded_by == None
        })
        |> json.array(document_json(_, roles, side, now)),
    ),
    // Absent, not redacted, so a hidden note's existence is not disclosed.
    #(
      "notes",
      t.notes
        |> list.filter(fn(n) {
          transaction_rules.can_see(note_visibility(n.visibility), roles, side)
        })
        |> json.array(note_json),
    ),
    #("linkedThreads", json.preprocessed_array(threads)),
    // The recruitment case is club-private: only the agent and the club that owns it see the reference.
    #(
      "links",
      json.object([
        #("trialId", json.nullable(r.link_trial_id, id.trial_json)),
        #("opportunityId", json.nullable(r.link_opportunity_id, json.string)),
        ..case r.link_recruitment_case_id, is_agent || own_case {
          Some(case_id), True -> [
            #("recruitmentCaseId", id.recruitment_case_json(case_id)),
          ]
          _, _ -> []
        }
      ]),
    ),
    #(
      "terms",
      json.object([
        #("versions", case sees_terms {
          True ->
            t.terms
            |> list.filter(fn(v) {
              transaction_rules.can_see(
                terms_visibility(v.visibility),
                roles,
                side,
              )
            })
            |> json.array(fn(v) {
              json.object([
                #("id", id.terms_version_json(v.id)),
                #("at", json.int(v.recorded_at)),
                #("summary", json.string(v.summary)),
                #("visibility", terms_row.visibility_to_json(v.visibility)),
                #("recordedFor", party_role.to_json(v.recorded_for)),
                #(
                  "actor",
                  transaction_rules.actor_label("org", v.recorded_by_name),
                ),
              ])
            })
          False -> json.array([], json.string)
        }),
      ]),
    ),
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

pub fn note_json(n: note_row.Row) -> Json {
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
              #("policyVersions", json.array(v.policy_versions, id.policy_json)),
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
  gate_refusal_saying(
    problem,
    "No encoded policy covers this jurisdiction. A transaction cannot be opened for it.",
  )
}

fn gate_refusal_saying(
  problem: compliance_store.GateProblem,
  unsupported: String,
) -> Response {
  case problem {
    compliance_store.Unsupported(reasons:, policy_versions:) ->
      err("JURISDICTION_UNSUPPORTED", unsupported, [
        #(
          "reasons",
          json.array(reasons, fn(r) {
            json.object([
              #("code", json.string(r.code)),
              #("ruleId", json.nullable(r.rule_id, json.string)),
              #("ruleStatus", rule_status.to_json(r.rule_status)),
              #(
                "policyVersion",
                json.nullable(r.policy_version, id.policy_json),
              ),
            ])
          }),
        ),
        #("policyVersions", json.array(policy_versions, id.policy_json)),
      ])
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
pub fn notify_party(
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
pub fn own_transaction(
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
pub fn writable(ctx: Ctx, t: Transaction, next: fn() -> Response) -> Response {
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
  note_by(
    ctx,
    req,
    t,
    roles_of(t, agent_viewer(m)),
    None,
    by_agent(a),
    note_row.Org,
    id.org_user_to_string(a.user.id),
  )
}

/// Notes use the documents' visibility classes: each names its lane and is absent for anyone the lane excludes.
pub fn note_by(
  ctx: Ctx,
  req: Request,
  t: Transaction,
  roles: List(RoomRole),
  side: Option(PartyRole),
  by: By,
  by_kind: note_row.ByKind,
  rate_key: String,
) -> Response {
  use <- writable(ctx, t)
  let now = clock.now_ms()
  use <- limited(ctx, req, limits.TransactionNoteWrite, rate_key)
  let shape = {
    use text <- input.field("text", input.nullish(input.text(note_max)))
    use visibility <- input.field("visibility", input.optional(input.text(60)))
    use <- rev.fields
    input.done(NoteBody(text, visibility))
  }
  use b, raw <- body(req, shape, "NOTE_INPUT_INVALID")
  let allowed =
    transaction_rules.uploadable(roles, side)
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
              use <- guard_rev(raw, t)
              use tx <- acting(ctx, t)
              use note <- result.map(
                transaction_store.add_note(
                  tx,
                  t.row.id,
                  class,
                  text,
                  by,
                  by_kind,
                  now,
                )
                |> storage,
              )
              http.json(201, json.object([#("note", note_json(note))]))
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

pub fn rev_expected(
  raw: Dynamic,
  next: fn(rev.Expected) -> Response,
) -> Response {
  case rev.expected(raw) {
    Ok(e) -> next(e)
    Error(response) -> response
  }
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

// ------------------------------------------------------------------------------------------------- shared lane helpers

/// The query read with its shape, refused under the transaction contract.
pub fn query(
  req: Request,
  shape: input.Shape(a),
  next: fn(a) -> Response,
) -> Response {
  case
    input.parse_coded(
      shape,
      http.query_input(req),
      root: "query",
      codes: field_codes,
      default: "TRANSACTION_INPUT_INVALID",
    )
  {
    Ok(v) -> next(v)
    Error(r) -> domain_errors.send(contract, r.error, input.refusal_fields(r))
  }
}

/// `?limit=&cursor=`, judged as the platform's paging judges them.
pub fn page(
  limit: Option(String),
  cursor: Option(String),
  next: fn(paging.Page) -> Response,
) -> Response {
  case paging.read(paging.Query(limit:, cursor:), [paging.IntKind]) {
    Ok(p) -> next(p)
    Error(e) -> {
      let #(code, message) = paging.error_body(e)
      http.error_message(400, code, message)
    }
  }
}

pub fn after_of(p: paging.Page) -> Option(Int) {
  case p.after {
    Some([paging.IntKey(n)]) -> Some(n)
    _ -> None
  }
}

pub fn paged(
  rows: List(#(Int, Transaction)),
  p: paging.Page,
) -> #(List(Transaction), Option(String)) {
  let #(items, next) =
    paging.page_of(rows, p.limit, fn(x) { [paging.IntKey(x.0)] })
  #(list.map(items, fn(x) { x.1 }), next)
}

/// A body that may hold nothing but the rev fields.
pub fn rev_only(req: Request, next: fn(Dynamic) -> Response) -> Response {
  let shape = {
    use <- rev.fields
    input.done(Nil)
  }
  use _, raw <- body(req, shape, "TRANSACTION_INPUT_INVALID")
  next(raw)
}

pub fn guard_rev(
  raw: Dynamic,
  t: Transaction,
  next: fn() -> Response,
) -> Response {
  use expected <- rev_expected(raw)
  use <- rev.guard(expected, tx_rev(t), "TRANSACTION_VERSION_CONFLICT", [
    #(
      "current",
      json.object([#("status", transaction_status.to_json(t.row.status))]),
    ),
  ])
  next()
}

pub fn tx_rev(t: Transaction) -> rev.Rev {
  rev.Rev(t.row.rev, t.row.rev_at, t.row.rev_by_label)
}

/// A unit that acts on the transaction as the checks read it: another request that moved it first makes this a
/// lost race, re-run from the top.
pub fn acting(
  ctx: Ctx,
  t: Transaction,
  work: fn(Tx) -> Result(Response, Fail(Response)),
) -> Response {
  store.unit(ctx.store, fn(tx) {
    use current <- result.try(
      transaction_store.by_id(store.reading(tx), t.row.id) |> storage,
    )
    case option.map(current, fn(c) { c.row.rev }) == Some(t.row.rev) {
      False ->
        store.stale(
          "the transaction moved from rev " <> string.inspect(t.row.rev),
        )
      True -> work(tx)
    }
  })
  |> answer
}

/// The transaction re-read inside the unit, projected for the viewer.
pub fn projected(
  tx: Tx,
  transaction_id: id.TransactionId,
  viewer: Viewer,
  now: Int,
) -> Result(Json, Fail(Response)) {
  let read = store.reading(tx)
  use stored <- result.try(
    transaction_store.by_id(read, transaction_id) |> storage,
  )
  let assert Some(stored) = stored as "the transaction was just written"
  project(read, stored, viewer, now) |> storage
}

pub const document_type_pairs = doc_row.document_type_pairs

pub fn transaction_body(view: Json) -> Json {
  json.object([#("transaction", view)])
}

pub fn idempotent_body(view: Json) -> Json {
  json.object([#("transaction", view), #("idempotent", json.bool(True))])
}

pub fn limited(
  ctx: Ctx,
  req: Request,
  action: limits.Action,
  key: String,
  next: fn() -> Response,
) -> Response {
  case
    !http.rerun(req) && limits.limited(ctx.limits, action, key, clock.now_ms())
  {
    True -> rate_limited(action)
    False -> next()
  }
}

/// A transaction that loses its confirmation set falls back out of READY/ACTIVE; a draft whose parties all
/// confirmed moves to PARTIES_CONFIRMED; compliance is re-evaluated either way.
pub fn party_changed(
  tx: Tx,
  transaction_id: id.TransactionId,
  by: By,
  now: Int,
) -> Result(Recheck, Fail(e)) {
  let read = store.reading(tx)
  let reload = fn() {
    use found <- result.map(transaction_store.by_id(read, transaction_id))
    let assert Some(t) = found as "the transaction was just written"
    t
  }
  let fallback = fn(t: Transaction, pending) {
    use _ <- result.try(transaction_store.move_on_party_change(tx, t.row.id))
    use _ <- result.map(transaction_store.history(
      tx,
      t.row.id,
      event_row.TransactionStatusChanged,
      by,
      transaction_store.Detail(
        ..transaction_store.no_detail,
        from: Some(t.row.status),
        to: Some(transaction_status.PartiesConfirmed),
        pending_reason: pending,
      ),
      now,
    ))
    store.emit(
      tx,
      effect.Live(live_event.AgentTransactionStatusChanged(
        org_id: id.org_to_string(t.row.agency_org_id),
        tx_id: id.transaction_to_string(t.row.id),
        status: "PARTIES_CONFIRMED",
      )),
    )
  }
  use t <- result.try(reload())
  let confirmed = transaction_rules.parties_confirmed(t.row.type_, t.parties)
  use _ <- result.try(case confirmed, t.row.status {
    False, transaction_status.Ready
    | False, transaction_status.Active
    | False, transaction_status.CompliancePending
    | False, transaction_status.ComplianceBlocked
    -> fallback(t, Some(pending_reason.PartiesNotConfirmed))
    _, _ -> Ok(Nil)
  })
  use t <- result.try(reload())
  use _ <- result.try(case confirmed, t.row.status {
    True, transaction_status.Draft -> fallback(t, None)
    _, _ -> Ok(Nil)
  })
  recheck(tx, transaction_id, by, now)
}

/// One history entry, then the rev bump an act makes.
pub fn record_act(
  tx: Tx,
  t: Transaction,
  action: event_row.Action,
  by: By,
  detail: transaction_store.Detail,
  now: Int,
) -> Result(Nil, Fail(e)) {
  transaction_store.history(tx, t.row.id, action, by, detail, now)
}

// ------------------------------------------------------------------------------------------------- the agent's reads

pub fn list_shape() -> input.Shape(
  #(
    Option(transaction_status.TransactionStatus),
    Option(String),
    Option(String),
  ),
) {
  use status <- input.field(
    "status",
    input.optional(input.one_of(transaction_status.pairs)),
  )
  use limit <- input.field("limit", input.optional(input.text(1_000_000)))
  use cursor <- input.field("cursor", input.optional(input.text(1_000_000)))
  input.done(#(status, limit, cursor))
}

pub fn codes_json(pairs: List(#(String, a))) -> Json {
  json.array(pairs, fn(p) { json.string(p.0) })
}

/// `GET /org/agent/transactions`: a colleague's transactions are neither listed nor counted.
pub fn list_mine(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use m <- core_routes.membership(ctx, a)
  use <- core_routes.require(m, "transactions.read")
  use q <- query(req, list_shape())
  let #(status, limit, cursor) = q
  use p <- page(limit, cursor)
  let now = clock.now_ms()
  let viewer = agent_viewer(m)
  use #(items, next, counts) <- reading(ctx, fn(r) {
    use rows <- result.try(transaction_store.agent_page(
      r,
      a.org.id,
      a.user.id,
      status,
      after_of(p),
      p.limit,
    ))
    let #(items, next) = paged(rows, p)
    use views <- result.try(list.try_map(items, project(r, _, viewer, now)))
    use counts <- result.map(transaction_store.agent_counts(
      r,
      a.org.id,
      a.user.id,
    ))
    #(views, next, counts)
  })
  http.json(
    200,
    json.object([
      #("items", json.preprocessed_array(items)),
      #("nextCursor", json.nullable(next, json.string)),
      #("statuses", codes_json(transaction_status.pairs)),
      #("types", codes_json(context_type.pairs)),
      #("partyRoles", codes_json(party_role.pairs)),
      #("documentTypes", codes_json(doc_row.document_type_pairs)),
      #("visibilities", codes_json(document_visibility.pairs)),
      #(
        "roomRoles",
        json.array(
          [
            "representing_agent", "party_individual", "party_guardian",
            "party_club_signatory", "party_club_member", "agency_admin_observer",
            "trust_safety",
          ],
          json.string,
        ),
      ),
      #("holdReasonCodes", codes_json(tx_row.hold_reason_code_pairs)),
      #("cancelReasonCodes", codes_json(tx_row.cancel_reason_code_pairs)),
      #("closeReasonCodes", codes_json(tx_row.close_reason_code_pairs)),
      #("transitions", transaction_rules.all_transitions_json()),
      #("pendingReasons", codes_json(pending_reason.pairs)),
      #(
        "counts",
        json.object([
          #("live", json.int(counts.live)),
          #("blocked", json.int(counts.blocked)),
          #("pending", json.int(counts.pending)),
          #("ready", json.int(counts.ready)),
          #("awaitingConfirmation", json.int(counts.awaiting_confirmation)),
        ]),
      ),
      #("honest", json.string(transaction_rules.honest)),
    ]),
  )
}

/// `GET /org/agent/transactions/:id`.
pub fn get_mine(ctx: Ctx, a: OrgAccess, transaction_id: String) -> Response {
  use m <- core_routes.membership(ctx, a)
  use <- core_routes.require(m, "transactions.read")
  use t <- own_transaction(ctx, m, transaction_id)
  use view <- reading(ctx, project(_, t, agent_viewer(m), clock.now_ms()))
  http.json(200, transaction_body(view))
}

/// Codes, states and counts only: no prose, names or fees.
fn timeline_detail(e: transaction_store.Event) -> Json {
  let h = e.row
  let fields =
    [
      #("from", option.map(h.detail_from, transaction_status.to_json)),
      #("to", option.map(h.detail_to, transaction_status.to_json)),
      #("partyRole", option.map(h.detail_party_role, party_role.to_json)),
      #("subjectKind", option.map(h.detail_subject_kind, subject_kind.to_json)),
      #(
        "status",
        option.map(h.detail_status, declared_representation_status.to_json),
      ),
      #("outcome", option.map(h.detail_outcome, context_outcome.to_json)),
      #(
        "pendingReason",
        option.map(h.detail_pending_reason, pending_reason.to_json),
      ),
      #("reasonCodes", case h.has_reason_codes {
        True -> Some(json.array(e.reason_codes, json.string))
        False -> None
      }),
      #("policyVersions", case h.has_policy_versions {
        True -> Some(json.array(e.policy_versions, id.policy_json))
        False -> None
      }),
      #(
        "documentType",
        option.map(
          h.detail_document_type,
          event_row.detail_document_type_to_json,
        ),
      ),
      #(
        "visibility",
        option.map(h.detail_visibility, document_visibility.to_json),
      ),
      #("staleness", option.map(h.detail_staleness, staleness.to_json)),
      #(
        "holdReasonCode",
        option.map(h.detail_reason_code, event_row.detail_reason_code_to_json),
      ),
      #("version", option.map(h.detail_version, json.int)),
      #("count", option.map(h.detail_count, json.int)),
    ]
    |> list.filter_map(fn(f) {
      case f.1 {
        Some(v) -> Ok(#(f.0, v))
        None -> Error(Nil)
      }
    })
  case fields {
    [] -> json.null()
    _ -> json.object(fields)
  }
}

/// What these roles may see of what happened, newest first.
pub fn timeline(
  read: Read,
  t: Transaction,
  roles: List(RoomRole),
  side: Option(PartyRole),
) -> Result(Json, Fail(e)) {
  use events <- result.map(transaction_store.events(read, t.row.id))
  let visible =
    list.filter(events, fn(e) {
      transaction_rules.timeline_visible(
        transaction_rules.audience_of(e.row.action),
        roles,
        side,
        e.row.detail_visibility,
      )
    })
  let n = list.length(visible)
  visible
  |> list.drop(int.max(0, n - 200))
  |> list.reverse
  |> json.array(fn(e) {
    json.object([
      #("id", id.transaction_event_json(e.row.id)),
      #("at", json.int(e.row.at)),
      #("action", event_row.action_to_json(e.row.action)),
      #(
        "audience",
        json.string(
          transaction_rules.audience_to_string(transaction_rules.audience_of(
            e.row.action,
          )),
        ),
      ),
      #(
        "actor",
        transaction_rules.actor_label(
          compliance_actor_kind.to_string(e.row.by_kind),
          e.row.by_name,
        ),
      ),
      #("detail", timeline_detail(e)),
    ])
  })
}

/// `GET /org/agent/transactions/:id/timeline`.
pub fn timeline_mine(
  ctx: Ctx,
  a: OrgAccess,
  transaction_id: String,
) -> Response {
  use m <- core_routes.membership(ctx, a)
  use <- core_routes.require(m, "transactions.read")
  use t <- own_transaction(ctx, m, transaction_id)
  use items <- reading(ctx, timeline(_, t, roles_of(t, agent_viewer(m)), None))
  http.json(
    200,
    json.object([
      #("items", items),
      #(
        "note",
        json.string(
          "The timeline is what YOU may see of what happened. The platform audit holds more operational detail and is not this.",
        ),
      ),
    ]),
  )
}

// ------------------------------------------------------------------------------------------------- links

/// `POST /org/agent/transactions/:id/links`: an opportunity of the engaging club, by reference.
pub fn link_opportunity(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  transaction_id: String,
) -> Response {
  use m <- core_routes.membership(ctx, a)
  use <- core_routes.require(m, "transactions.write")
  use t <- own_transaction(ctx, m, transaction_id)
  use <- writable(ctx, t)
  let shape = {
    use opportunity_id <- input.field(
      "opportunityId",
      input.required(input.id()),
    )
    use <- rev.fields
    input.done(opportunity_id)
  }
  use opportunity_id, raw <- body(req, shape, "TRANSACTION_INPUT_INVALID")
  let opportunity_id = string.trim(opportunity_id)
  use owner <- reading(ctx, fn(r) {
    store.one(
      r,
      "SELECT org_id FROM opportunities WHERE id = ?",
      [sqlight.text(opportunity_id)],
      decode.at([0], decode.string),
    )
  })
  let engaging =
    list.find(t.parties, fn(p) {
      !p.removed && p.party_role == party_role.EngagingEntity
    })
  // An unknown and an invisible opportunity answer alike.
  case owner, engaging {
    Ok(org), Ok(p) if org == p.subject_id -> {
      use <- guard_rev(raw, t)
      let by = by_agent(a)
      let now = clock.now_ms()
      use tx <- acting(ctx, t)
      use _ <- result.try(
        transaction_store.link_opportunity(tx, t.row.id, opportunity_id)
        |> storage,
      )
      use _ <- result.try(transaction_store.touch(tx, t.row.id, now) |> storage)
      use _ <- result.try(
        record_act(
          tx,
          t,
          event_row.TransactionStatusChanged,
          by,
          transaction_store.Detail(
            ..transaction_store.no_detail,
            from: Some(t.row.status),
            to: Some(t.row.status),
          ),
          now,
        )
        |> storage,
      )
      use _ <- result.try(
        transaction_store.bump(tx, t.row.id, by, now) |> storage,
      )
      use view <- result.map(projected(tx, t.row.id, agent_viewer(m), now))
      http.json(200, transaction_body(view))
    }
    _, _ ->
      err(
        "TRANSACTION_INPUT_INVALID",
        "No opportunity of the engaging club matches that reference.",
        [#("field", json.string("opportunityId"))],
      )
  }
}

// ------------------------------------------------------------------------------------------------- representations

/// Reasons reach the wire as codes and rule references only.
pub fn public_reason(r: conflict.Reason) -> Json {
  json.object(
    list.flatten([
      [
        #("code", json.string(r.code)),
        #("ruleId", json.nullable(r.rule_id, json.string)),
        #("ruleStatus", rule_status.to_json(r.rule_status)),
        #("policyVersion", json.nullable(r.policy_version, id.policy_json)),
      ],
      case r.party_role {
        Some(role) -> [#("partyRole", party_role.to_json(role))]
        None -> []
      },
      case r.party_roles {
        Some(roles) -> [#("partyRoles", json.array(roles, party_role.to_json))]
        None -> []
      },
    ]),
  )
}

fn reasons_json(reasons: List(conflict.Reason)) -> Json {
  json.array(reasons, public_reason)
}

type RepresentationBody {
  RepresentationBody(
    party_role: PartyRole,
    agreement_id: Option(String),
    client_key: Option(String),
  )
}

/// What the agent's scope must cover, by the transaction's type (CONTEXT_TYPE_SCOPES).
fn needed_scopes(t: ContextType) -> List(String) {
  case t {
    context_type.EmploymentContract -> ["employment"]
    context_type.Transfer | context_type.Loan -> ["transfer", "employment"]
    context_type.OtherServices -> ["other_services", "commercial"]
  }
}

/// `representationScopeProblem`: the refusal code, or none. An agreement for one national association does not
/// authorise an act in another; INT covers only the international dimension.
fn scope_problem(
  a: agent_rules.Agreement,
  agent: id.OrgUserId,
  t: Transaction,
  now: Int,
) -> Option(String) {
  let status = agent_rules.effective_status(a.row, now)
  let confirmed =
    a.row.confirmed_at != None && agent_rules.grants_access(a.row, agent, now)
  let scope = list.map(a.scope, agreement_scope_row.scope_to_string)
  let ma = jurisdiction.to_string(a.row.jurisdiction)
  case status, confirmed {
    agreement_status.Expired, _ -> Some("REPRESENTATION_EXPIRED")
    agreement_status.Active, True ->
      case list.any(needed_scopes(t.row.type_), list.contains(scope, _)) {
        False -> Some("REPRESENTATION_SCOPE_INSUFFICIENT")
        True ->
          case
            list.any(t.jurisdictions, fn(m) {
              m != "INT" && ma != "INT" && m != ma
            })
          {
            True -> Some("REPRESENTATION_SCOPE_INSUFFICIENT")
            False -> None
          }
      }
    _, _ -> Some("REPRESENTATION_REQUIRED")
  }
}

/// `POST /org/agent/transactions/:id/representations`: an agreement active for this player is not by itself
/// authority here. Its scope must cover this type and every jurisdiction, and the conflict engine must answer with
/// this binding included.
pub fn attach_representation(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  transaction_id: String,
) -> Response {
  use m <- core_routes.membership(ctx, a)
  use <- core_routes.require(m, "transactions.write")
  use t <- own_transaction(ctx, m, transaction_id)
  use <- writable(ctx, t)
  let shape = {
    use role <- input.field(
      "partyRole",
      input.required(input.one_of(party_role.pairs)),
    )
    use agreement_id <- input.field("agreementId", input.nullish(input.id()))
    use client_key <- input.field(
      "clientKey",
      input.nullish(input.text(1_000_000)),
    )
    use <- rev.fields
    input.done(RepresentationBody(role, agreement_id, client_key))
  }
  use b, raw <- body(req, shape, "TRANSACTION_INPUT_INVALID")
  use key <- client_key(b.client_key)
  let now = clock.now_ms()
  let viewer = agent_viewer(m)
  case
    list.find(t.parties, fn(p) { !p.removed && p.party_role == b.party_role })
  {
    Error(Nil) ->
      domain_errors.send(contract, "TRANSACTION_PARTY_NOT_FOUND", [])
    Ok(party) -> {
      let fp =
        canonical.Object([
          #("partyRole", canonical.Str(party_role.to_string(b.party_role))),
          #("agreementId", canonical.text(b.agreement_id)),
        ])
        |> canonical.to_string
      use hit <- reading(ctx, fn(r) {
        case key {
          Some(k) ->
            transaction_store.representation_by_attach_key(r, t.row.id, k)
          None -> Ok(None)
        }
      })
      case hit {
        Some(h) ->
          case h.row.attach_fp == Some(fp) {
            True -> {
              use view <- reading(ctx, project(_, t, viewer, now))
              http.json(200, idempotent_body(view))
            }
            False ->
              domain_errors.send(
                contract,
                "TRANSACTION_IDEMPOTENCY_CONFLICT",
                [],
              )
          }
        None -> {
          use <- limited(
            ctx,
            req,
            limits.TransactionWrite,
            id.org_user_to_string(a.user.id),
          )
          attach_checked(ctx, a, m, t, party, b, raw, key, fp, now)
        }
      }
    }
  }
}

fn attach_checked(
  ctx: Ctx,
  a: OrgAccess,
  m: Member,
  t: Transaction,
  party: party_row.Row,
  b: RepresentationBody,
  raw: Dynamic,
  key: Option(String),
  fp: String,
  now: Int,
) -> Response {
  use reps <- reading(ctx, transaction_store.representations(_, t.row.id))
  let live =
    list.filter(reps, fn(r) {
      r.row.status != declared_representation_status.Withdrawn
    })
  case
    list.any(live, fn(r) {
      r.row.party_role == b.party_role && r.row.agent_user_id == a.user.id
    })
  {
    True ->
      err(
        "TRANSACTION_PARTY_EXISTS",
        "You already represent this party in this transaction.",
        [#("partyRole", party_role.to_json(b.party_role))],
      )
    False -> {
      // Safeguarding before scope, so a blocked party reads the same as an unknown one.
      use basis <- reading(ctx, fn(r) {
        case party.subject_kind {
          subject_kind.Club -> Ok(Ok(None))
          subject_kind.Player -> {
            use found <- result.try(players.for_org(
              r,
              id.player(party.subject_id),
              a.org,
              now,
            ))
            case found {
              Some(#(pl, access)) if access.visible && !access.blocked ->
                case players.is_adult(pl, now) {
                  False -> Ok(Error("TRANSACTION_PARTY_NOT_FOUND"))
                  True -> {
                    use named <- result.map(case b.agreement_id {
                      Some(aid) ->
                        agent_store.agreement_by_id(r, id.agreement(aid))
                      None -> Ok(None)
                    })
                    case named {
                      Some(ag)
                        if ag.row.agent_user_id == a.user.id
                        && ag.row.agency_org_id == a.org.id
                        && ag.row.client_id == party.subject_id
                      -> Ok(Some(ag))
                      _ -> Error("REPRESENTATION_REQUIRED")
                    }
                  }
                }
              _ -> Ok(Error("TRANSACTION_PARTY_NOT_FOUND"))
            }
          }
        }
      })
      case basis {
        Error("REPRESENTATION_REQUIRED") ->
          err(
            "REPRESENTATION_REQUIRED",
            "A client-confirmed, active relationship with this party is required (agreementId).",
            [],
          )
        Error(code) -> domain_errors.send(contract, code, [])
        Ok(agreement) -> {
          let problem = case agreement {
            Some(ag) -> scope_problem(ag, a.user.id, t, now)
            None -> None
          }
          case problem {
            Some(code) ->
              err(
                code,
                case code {
                  "REPRESENTATION_SCOPE_INSUFFICIENT" ->
                    "The relationship does not cover this transaction's scope or jurisdiction."
                  _ ->
                    "No active, client-confirmed relationship covers this party."
                },
                [],
              )
            None -> {
              use gate <- reading(ctx, compliance_store.facet_gate(
                _,
                a.user.id,
                t.jurisdictions,
                now,
              ))
              case gate {
                Some(problem) ->
                  gate_refusal_saying(
                    problem,
                    "No encoded policy covers this jurisdiction.",
                  )
                None ->
                  attach_in_unit(
                    ctx,
                    a,
                    m,
                    t,
                    b,
                    raw,
                    key,
                    fp,
                    agreement,
                    live,
                    now,
                  )
              }
            }
          }
        }
      }
    }
  }
}

fn attach_in_unit(
  ctx: Ctx,
  a: OrgAccess,
  m: Member,
  t: Transaction,
  b: RepresentationBody,
  raw: Dynamic,
  key: Option(String),
  fp: String,
  agreement: Option(agent_rules.Agreement),
  live: List(transaction_store.Representation),
  now: Int,
) -> Response {
  let declared_only = agreement == None
  let by = by_agent(a)
  let viewer = agent_viewer(m)
  use expected <- rev_expected(raw)
  use tx <- acting(ctx, t)
  let read = store.reading(tx)
  // A refusal records no binding, but the evaluation and the snapshot naming it commit.
  use found <- result.try(
    compliance_store.by_id(read, t.row.context_id) |> storage,
  )
  let assert Some(c) = found as "a transaction has its context"
  use _ <- result.try(
    compliance_store.project(
      tx,
      c.row.id,
      t.parties,
      list.map(live, fn(r) { r.row }),
    )
    |> storage,
  )
  use found <- result.try(
    compliance_store.by_id(read, t.row.context_id) |> storage,
  )
  let assert Some(c) = found as "a transaction has its context"
  let proposed =
    conflict.Representation(
      agent_user_id: id.org_user_to_string(a.user.id),
      party_role: b.party_role,
      agreement_id: option.map(agreement, fn(ag) {
        id.agreement_to_string(ag.row.id)
      }),
      declared_only:,
      status: case declared_only {
        True -> "declared"
        False -> "verified"
      },
      first_act_at: Some(now),
      via_colleague: False,
    )
  use policies <- result.try(approach_policy.published(read) |> storage)
  use consents <- result.try(
    consent_store.engine_consents(read, c.row.id) |> storage,
  )
  use engine <- result.try(
    compliance_store.engine_input(
      read,
      c,
      policies,
      now,
      Some(proposed),
      consents,
    )
    |> storage,
  )
  let result = conflict.evaluate(engine)
  use evaluation_id <- result.try(
    compliance_store.record_evaluation(
      tx,
      c,
      result,
      Some(#(b.party_role, a.user.id)),
      by,
      now,
    )
    |> storage,
  )
  let confirmed = transaction_rules.parties_confirmed(t.row.type_, t.parties)
  let state_of = fn() {
    transaction_rules.state_from(
      Some(result.outcome),
      None,
      conflict.reason_codes(result.reasons),
      list.length(live),
      confirmed,
    )
  }
  let context_id = id.compliance_context_json(c.row.id)
  let snapshot_and_answer = fn(response) {
    use current <- result.try(
      transaction_store.by_id(read, t.row.id) |> storage,
    )
    let assert Some(current) = current
    use _ <- result.try(
      snapshot(
        tx,
        current,
        state_of(),
        Evaluated(evaluation_id),
        result.policy_versions,
        by,
        now,
      )
      |> storage,
    )
    use _ <- result.map(
      transaction_store.bump(tx, t.row.id, by, now) |> storage,
    )
    response
  }
  let filtered = fn(codes) {
    list.filter(result.reasons, fn(r) { list.contains(codes, r.code) })
  }
  let policy_json = json.array(result.policy_versions, id.policy_json)
  let outcome_json = context_outcome.to_json(result.outcome)
  case result.outcome {
    context_outcome.ProhibitedConflict ->
      snapshot_and_answer(
        err(
          "REPRESENTATION_CONFLICT",
          "An encoded ACTIVE rule prohibits this combination of parties. Nothing was recorded.",
          [
            #(
              "reasons",
              reasons_json(
                filtered([
                  "PROHIBITED_COMBINATION", "COMBINATION_NOT_PERMITTED",
                  "CONNECTED_AGENT_ATTRIBUTION",
                ]),
              ),
            ),
            #("policyVersions", policy_json),
            #("outcome", outcome_json),
          ],
        ),
      )
    context_outcome.PermittedDualRepresentationConsentRequired ->
      snapshot_and_answer(
        err(
          "CONSENT_REQUIRED",
          "Prior, party-specific written consent is outstanding. Request it; nothing was recorded.",
          [
            #(
              "consentsOutstanding",
              json.array(result.consents_outstanding, fn(o) {
                json.object([
                  #("partyRole", party_role.to_json(o.party_role)),
                  #("consentKind", json.string(o.consent_kind)),
                  #("reasonCode", json.string(o.reason_code)),
                ])
              }),
            ),
            #("reasons", reasons_json(filtered(["CONSENT_REQUIRED"]))),
            #("policyVersions", policy_json),
            #("outcome", outcome_json),
            #("contextId", context_id),
          ],
        ),
      )
    _ -> {
      // A stale rev rolls the evaluation back with the rest.
      use _ <- result.try(
        case
          rev.check(expected, tx_rev(t), "TRANSACTION_VERSION_CONFLICT", [
            #(
              "current",
              json.object([
                #("status", transaction_status.to_json(t.row.status)),
              ]),
            ),
          ])
        {
          Ok(Nil) -> Ok(Nil)
          Error(conflict) -> store.refuse(conflict)
        },
      )
      let needs_review =
        result.outcome == context_outcome.ManualRegulatoryReviewRequired
        || result.outcome == context_outcome.InsufficientData
      let review_reasons =
        list.filter(result.reasons, fn(r) { r.code != "FACET_VERIFIED" })
      let requested_by =
        reviews.RequestedBy(
          kind: compliance_actor_kind.Org,
          id: Some(id.org_user_to_string(a.user.id)),
          name: Some(a.user.name),
        )
      let snap = #(result.outcome, Some(evaluation_id), result.evaluated_at)
      case needs_review && !declared_only {
        True -> {
          // A review item instead of the binding.
          use _ <- result.try(
            reviews.create_for_context(
              tx,
              review_row.ConflictEvaluation,
              t.row.agency_org_id,
              a.user.id,
              reviews.ContextSubject(
                context_id: c.row.id,
                transaction_id: id.transaction_to_string(t.row.id),
                representation_id: None,
                party_role: b.party_role,
              ),
              review_reasons,
              result.policy_versions,
              snap,
              requested_by,
              now,
            )
            |> storage,
          )
          snapshot_and_answer(
            err(
              "REGULATORY_REVIEW_REQUIRED",
              "The deciding rule's operative status is uncertain or not encoded. An attributed review item was created; nothing proceeds until it is resolved under a named policy version.",
              [
                #("reasons", reasons_json(review_reasons)),
                #("policyVersions", policy_json),
                #("outcome", outcome_json),
                #("contextId", context_id),
              ],
            ),
          )
        }
        False -> {
          use rep_id <- result.try(id.next_representation(tx) |> storage)
          use review_id <- result.try(case declared_only {
            True ->
              reviews.create_for_context(
                tx,
                review_row.RepresentationDeclared,
                t.row.agency_org_id,
                a.user.id,
                reviews.ContextSubject(
                  context_id: c.row.id,
                  transaction_id: id.transaction_to_string(t.row.id),
                  representation_id: Some(id.representation_to_string(rep_id)),
                  party_role: b.party_role,
                ),
                review_reasons,
                result.policy_versions,
                snap,
                requested_by,
                now,
              )
              |> result.map(Some)
              |> storage
            False -> Ok(None)
          })
          let status = case declared_only {
            True -> declared_representation_status.PendingReview
            False -> declared_representation_status.Verified
          }
          let row =
            rep_row.Row(
              ..rep_row.new(
                id: rep_id,
                transaction_id: t.row.id,
                agency_org_id: t.row.agency_org_id,
                agent_user_id: a.user.id,
                party_role: b.party_role,
                declared_only:,
                status:,
                created_at: now,
                rev: 1,
              ),
              agreement_id: option.map(agreement, fn(ag) { ag.row.id }),
              jurisdiction: option.map(agreement, fn(ag) {
                jurisdiction.to_string(ag.row.jurisdiction)
              }),
              review_id:,
              verified_at: case declared_only {
                True -> None
                False -> Some(now)
              },
              first_act_at: case declared_only {
                True -> None
                False -> Some(now)
              },
              attach_key: key,
              attach_fp: option.map(key, fn(_) { fp }),
              rev_at: Some(now),
            )
          let scope = case agreement {
            Some(ag) ->
              list.filter_map(ag.scope, fn(s) {
                scope_row.scope_from_string(agreement_scope_row.scope_to_string(
                  s,
                ))
              })
            None -> []
          }
          use _ <- result.try(
            transaction_store.create_representation(
              tx,
              row,
              scope,
              by,
              result.policy_versions,
            )
            |> storage,
          )
          use _ <- result.try(
            transaction_store.history(
              tx,
              t.row.id,
              event_row.TransactionRepresentationAttached,
              by,
              transaction_store.Detail(
                ..transaction_store.no_detail,
                party_role: Some(b.party_role),
                status: Some(status),
              ),
              now,
            )
            |> storage,
          )
          use _ <- result.try(recheck(tx, t.row.id, by, now) |> storage)
          use _ <- result.try(
            transaction_store.bump(tx, t.row.id, by, now) |> storage,
          )
          case declared_only {
            // Recorded but not effective until reviewed: 422 rather than 201, which would read as "now in force".
            True ->
              Ok(
                err(
                  "REGULATORY_REVIEW_REQUIRED",
                  "Representation of an entity with no ScoutBox agreement is recorded as declared and needs attributed review. It is not effective until a named reviewer confirms it.",
                  [
                    #("reasons", reasons_json(review_reasons)),
                    #("policyVersions", policy_json),
                    #("outcome", outcome_json),
                    #("contextId", context_id),
                    #("partyRole", party_role.to_json(b.party_role)),
                  ],
                ),
              )
            False -> {
              use view <- result.map(projected(tx, t.row.id, viewer, now))
              http.json(
                201,
                json.object([
                  #("transaction", view),
                  #(
                    "representation",
                    json.object([
                      #("id", id.representation_json(rep_id)),
                      #("partyRole", party_role.to_json(b.party_role)),
                      #(
                        "status",
                        declared_representation_status.to_json(status),
                      ),
                    ]),
                  ),
                ]),
              )
            }
          }
        }
      }
    }
  }
}

/// `POST /org/agent/transactions/:id/representations/:rid/withdraw`.
pub fn withdraw_representation(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  transaction_id: String,
  representation_id: String,
) -> Response {
  use m <- core_routes.membership(ctx, a)
  use <- core_routes.require(m, "transactions.write")
  use t <- own_transaction(ctx, m, transaction_id)
  use <- writable(ctx, t)
  use reps <- reading(ctx, transaction_store.representations(_, t.row.id))
  case
    list.find(reps, fn(r) {
      id.representation_to_string(r.row.id) == representation_id
      && r.row.agent_user_id == a.user.id
    })
  {
    Error(Nil) -> not_found()
    Ok(r) -> {
      use raw <- rev_only(req)
      let now = clock.now_ms()
      let viewer = agent_viewer(m)
      case r.row.status {
        declared_representation_status.Withdrawn -> {
          use view <- reading(ctx, project(_, t, viewer, now))
          http.json(200, idempotent_body(view))
        }
        _ -> {
          use <- guard_rev(raw, t)
          let by = by_agent(a)
          use tx <- acting(ctx, t)
          use _ <- result.try(
            transaction_store.withdraw_representation(
              tx,
              r.row,
              rep_row.AgentWithdrew,
              by,
              None,
              None,
              now,
            )
            |> storage,
          )
          use _ <- result.try(
            transaction_store.history(
              tx,
              t.row.id,
              event_row.TransactionRepresentationWithdrawn,
              by,
              transaction_store.Detail(
                ..transaction_store.no_detail,
                party_role: Some(r.row.party_role),
              ),
              now,
            )
            |> storage,
          )
          use _ <- result.try(recheck(tx, t.row.id, by, now) |> storage)
          use _ <- result.try(
            transaction_store.bump(tx, t.row.id, by, now) |> storage,
          )
          use view <- result.map(projected(tx, t.row.id, viewer, now))
          http.json(200, transaction_body(view))
        }
      }
    }
  }
}

/// `POST /org/agent/transactions/:id/evaluate`.
pub fn evaluate(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  transaction_id: String,
) -> Response {
  use m <- core_routes.membership(ctx, a)
  use <- core_routes.require(m, "transactions.write")
  use t <- own_transaction(ctx, m, transaction_id)
  use <- writable(ctx, t)
  let shape = input.done(Nil)
  use _, _ <- body(req, shape, "TRANSACTION_INPUT_INVALID")
  use <- limited(
    ctx,
    req,
    limits.TransactionWrite,
    id.org_user_to_string(a.user.id),
  )
  let now = clock.now_ms()
  let by = by_agent(a)
  use tx <- acting(ctx, t)
  use _ <- result.try(recheck(tx, t.row.id, by, now) |> storage)
  use _ <- result.try(transaction_store.bump(tx, t.row.id, by, now) |> storage)
  use view <- result.map(projected(tx, t.row.id, agent_viewer(m), now))
  http.json(200, transaction_body(view))
}

// ------------------------------------------------------------------------------------------------- status

type StatusBody {
  StatusBody(
    to: transaction_status.TransactionStatus,
    reason_code: Option(String),
    reason: Option(String),
    client_key: Option(String),
  )
}

/// A hold, cancellation or closure needs a code of its own kind; any other move takes none.
fn reason_codes_for(
  to: transaction_status.TransactionStatus,
) -> Option(List(String)) {
  let codes = fn(pairs: List(#(String, a))) {
    Some(list.map(pairs, fn(p) { p.0 }))
  }
  case to {
    transaction_status.OnHold -> codes(tx_row.hold_reason_code_pairs)
    transaction_status.Cancelled -> codes(tx_row.cancel_reason_code_pairs)
    transaction_status.Closed -> codes(tx_row.close_reason_code_pairs)
    _ -> None
  }
}

fn status_words(s: transaction_status.TransactionStatus) -> String {
  transaction_status.to_string(s)
  |> string.replace("_", " ")
  |> string.lowercase
}

fn transition_refusal(
  from: transaction_status.TransactionStatus,
  to: transaction_status.TransactionStatus,
  message: Option(String),
) -> Response {
  domain_errors.send(
    contract,
    "TRANSACTION_TRANSITION_NOT_ALLOWED",
    list.flatten([
      case message {
        Some(m) -> [#("message", json.string(m))]
        None -> []
      },
      [
        #("from", transaction_status.to_json(from)),
        #("to", transaction_status.to_json(to)),
        #(
          "allowed",
          json.array(
            transaction_rules.actor_transitions(from),
            transaction_status.to_json,
          ),
        ),
      ],
    ]),
  )
}

fn code_reasons(codes: List(String)) -> Json {
  json.array(codes, fn(code) {
    json.object([
      #("code", json.string(code)),
      #("ruleId", json.null()),
      #("ruleStatus", json.null()),
      #("policyVersion", json.null()),
    ])
  })
}

/// `POST /org/agent/transactions/:id/status`: a move to ACTIVE needs a snapshot that is clear and current,
/// recomputed in this request.
pub fn move_status(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  transaction_id: String,
) -> Response {
  use m <- core_routes.membership(ctx, a)
  use <- core_routes.require(m, "transactions.write")
  use t <- own_transaction(ctx, m, transaction_id)
  let shape = {
    use to <- input.field(
      "to",
      input.required(input.one_of(transaction_status.pairs)),
    )
    use reason_code <- input.field("reasonCode", input.nullish(input.text(60)))
    use reason <- input.field("reason", input.nullish(input.text(400)))
    use client_key <- input.field(
      "clientKey",
      input.nullish(input.text(1_000_000)),
    )
    use <- rev.fields
    input.done(StatusBody(to, reason_code, reason, client_key))
  }
  use b, raw <- body(req, shape, "TRANSACTION_INPUT_INVALID")
  let now = clock.now_ms()
  let to = b.to
  case t.row.status {
    transaction_status.Archived ->
      err("TRANSACTION_ARCHIVED", "An archived transaction is read-only.", [
        #("status", transaction_status.to_json(t.row.status)),
      ])
    _ -> {
      use guard <- reading(ctx, safeguarding_problem(_, t, now))
      // Archiving stays possible: shelving a record nobody can act on is the safe move.
      case guard != None && to != transaction_status.Archived {
        True ->
          err(
            "TRANSACTION_PARTY_UNAVAILABLE",
            "A party to this transaction is no longer available to your organisation. It can be archived; it cannot be progressed.",
            [],
          )
        False -> {
          use key <- client_key(b.client_key)
          let reason_code = input.filled(b.reason_code) |> option.unwrap("")
          let reason = input.filled(b.reason) |> option.unwrap("")
          let fp =
            canonical.Object([
              #("to", canonical.Str(transaction_status.to_string(to))),
              #("reasonCode", canonical.Str(reason_code)),
              #("reason", canonical.Str(reason)),
            ])
            |> canonical.to_string
          let viewer = agent_viewer(m)
          // Before the transition check: a replay must answer "already done", not "not allowed from here".
          let replay = case key {
            Some(k) -> transaction_store.key_fp(t, key_row.Status, k)
            None -> None
          }
          case replay {
            Some(stored) if stored == fp -> {
              use view <- reading(ctx, project(_, t, viewer, now))
              http.json(200, idempotent_body(view))
            }
            Some(_) ->
              domain_errors.send(
                contract,
                "TRANSACTION_IDEMPOTENCY_CONFLICT",
                [],
              )
            None ->
              case
                transaction_rules.actor_transition_allowed(t.row.status, to)
              {
                False ->
                  transition_refusal(
                    t.row.status,
                    to,
                    Some(
                      "That is not a transition this transaction can make from its current state.",
                    ),
                  )
                True -> {
                  use <- limited(
                    ctx,
                    req,
                    limits.TransactionStatusWrite,
                    id.org_user_to_string(a.user.id),
                  )
                  let awaiting =
                    transaction_rules.awaiting_confirmation(
                      t.row.type_,
                      t.parties,
                    )
                  case
                    to == transaction_status.PartiesConfirmed && awaiting != []
                  {
                    True ->
                      err(
                        "TRANSACTION_PARTIES_NOT_CONFIRMED",
                        "Every required party must confirm its own participation first. Naming a party is not confirming it.",
                        [
                          #(
                            "awaiting",
                            json.array(awaiting, party_role.to_json),
                          ),
                        ],
                      )
                    False -> {
                      let codes = reason_codes_for(to)
                      let code_ok = case codes {
                        Some(cs) -> list.contains(cs, reason_code)
                        None -> reason_code == ""
                      }
                      case code_ok {
                        False ->
                          domain_errors.send(
                            contract,
                            "TRANSACTION_INPUT_INVALID",
                            list.flatten([
                              case codes {
                                None -> [
                                  #(
                                    "message",
                                    json.string(
                                      "A move to "
                                      <> transaction_status.to_string(to)
                                      <> " takes no reason code.",
                                    ),
                                  ),
                                ]
                                Some(_) -> []
                              },
                              [
                                #("field", json.string("reasonCode")),
                                #(
                                  "allowed",
                                  json.array(
                                    option.unwrap(codes, []),
                                    json.string,
                                  ),
                                ),
                              ],
                            ]),
                          )
                        True ->
                          status_in_unit(
                            ctx,
                            a,
                            viewer,
                            t,
                            b,
                            raw,
                            key,
                            fp,
                            input.filled(b.reason_code),
                            input.filled(b.reason),
                            now,
                          )
                      }
                    }
                  }
                }
              }
          }
        }
      }
    }
  }
}

fn status_in_unit(
  ctx: Ctx,
  a: OrgAccess,
  viewer: Viewer,
  t: Transaction,
  b: StatusBody,
  raw: Dynamic,
  key: Option(String),
  fp: String,
  reason_code: Option(String),
  reason: Option(String),
  now: Int,
) -> Response {
  let to = b.to
  let by = by_agent(a)
  use expected <- rev_expected(raw)
  use tx <- acting(ctx, t)
  let read = store.reading(tx)
  let bump = fn() { transaction_store.bump(tx, t.row.id, by, now) |> storage }
  let rest = fn() {
    // A stale rev rolls back the re-evaluation above with the rest.
    use _ <- result.try(
      case
        rev.check(expected, tx_rev(t), "TRANSACTION_VERSION_CONFLICT", [
          #(
            "current",
            json.object([#("status", transaction_status.to_json(t.row.status))]),
          ),
        ])
      {
        Ok(Nil) -> Ok(Nil)
        Error(conflict) -> store.refuse(conflict)
      },
    )
    use current <- result.try(
      transaction_store.by_id(read, t.row.id) |> storage,
    )
    let assert Some(current) = current
    let from = current.row.status
    let action = case to {
      transaction_status.OnHold -> event_row.TransactionHeld
      transaction_status.Cancelled -> event_row.TransactionCancelled
      transaction_status.Closed -> event_row.TransactionClosed
      transaction_status.Archived -> event_row.TransactionArchived
      _ -> event_row.TransactionStatusChanged
    }
    use _ <- result.try(
      transaction_store.move_by_actor(
        tx,
        current,
        to,
        reason_code,
        reason,
        option.map(key, fn(k) { #(k, fp) }),
        now,
      )
      |> storage,
    )
    use _ <- result.try(transaction_store.touch(tx, t.row.id, now) |> storage)
    use _ <- result.try(
      transaction_store.history(
        tx,
        t.row.id,
        action,
        by,
        transaction_store.Detail(
          ..transaction_store.no_detail,
          from: Some(from),
          to: Some(to),
          reason_code: option.then(reason_code, fn(c) {
            event_row.detail_reason_code_from_string(c) |> option.from_result
          }),
        ),
        now,
      )
      |> storage,
    )
    use _ <- result.try(bump())
    use _ <- result.try(case to {
      transaction_status.Cancelled | transaction_status.Closed -> {
        use c <- result.try(
          compliance_store.by_id(read, t.row.context_id) |> storage,
        )
        case c {
          Some(c) -> compliance_store.close(tx, c, by, now) |> storage
          None -> Ok(Nil)
        }
      }
      _ -> Ok(Nil)
    })
    let org_id = id.org_to_string(t.row.agency_org_id)
    let tx_id = id.transaction_to_string(t.row.id)
    let status = transaction_status.to_string(to)
    store.emit(
      tx,
      effect.Live(case to {
        transaction_status.OnHold ->
          live_event.AgentTransactionHeld(org_id:, tx_id:, status:)
        transaction_status.Cancelled ->
          live_event.AgentTransactionCancelled(org_id:, tx_id:, status:)
        transaction_status.Closed ->
          live_event.AgentTransactionClosed(org_id:, tx_id:, status:)
        _ -> live_event.AgentTransactionStatusChanged(org_id:, tx_id:, status:)
      }),
    )
    use _ <- result.try(
      t.parties
      |> list.filter(fn(p) { !p.removed })
      |> list.try_each(fn(p) {
        notify_party_as(
          tx,
          t.row.id,
          p,
          "agent_transaction",
          "A transaction you are party to is now \""
            <> status_words(to)
            <> "\". Nothing has been agreed or signed.",
          now,
        )
      })
      |> storage,
    )
    use view <- result.map(projected(tx, t.row.id, viewer, now))
    http.json(200, transaction_body(view))
  }
  case to {
    transaction_status.Active -> {
      // Refused before the re-check, so the caller cannot enter the live workflow on facts they have not seen:
      // they must re-evaluate and read the answer first. The flag commits with the refusal.
      use view <- result.try(compliance_of(read, t) |> storage)
      use stale <- result.try(staleness_of(read, t, view, now) |> storage)
      case stale {
        Some(s) -> {
          use _ <- result.try(
            transaction_store.flag_stale(tx, t.row.id) |> storage,
          )
          use _ <- result.try(
            transaction_store.history(
              tx,
              t.row.id,
              event_row.TransactionComplianceStale,
              by,
              transaction_store.Detail(
                ..transaction_store.no_detail,
                staleness: Some(s),
              ),
              now,
            )
            |> storage,
          )
          use _ <- result.try(
            transaction_store.touch(tx, t.row.id, now) |> storage,
          )
          use _ <- result.map(bump())
          err(
            "TRANSACTION_COMPLIANCE_STALE",
            "The recorded compliance evaluation no longer matches the current facts. Re-evaluate and read the new answer before progressing.",
            [#("staleness", staleness.to_json(s))],
          )
        }
        None -> {
          use checked <- result.try(recheck(tx, t.row.id, by, now) |> storage)
          case checked {
            Guarded(_) -> Ok(not_found())
            Checked(state:, status:) -> {
              let allowed =
                transaction_rules.actor_transition_allowed(status, to)
              case state.blocked, state.clear, allowed {
                True, _, _ -> {
                  use _ <- result.map(bump())
                  err(
                    "TRANSACTION_COMPLIANCE_BLOCKED",
                    "An encoded ACTIVE rule prohibits this combination. A reviewer cannot approve past it; only changed facts or a new policy version can.",
                    [
                      #(
                        "outcome",
                        json.nullable(state.outcome, context_outcome.to_json),
                      ),
                      #("reasons", code_reasons(state.reason_codes)),
                    ],
                  )
                }
                _, False, _ -> {
                  use _ <- result.map(bump())
                  err(
                    "TRANSACTION_COMPLIANCE_PENDING",
                    "This transaction cannot progress while compliance is outstanding.",
                    [
                      #(
                        "pendingReason",
                        json.nullable(
                          state.pending_reason,
                          pending_reason.to_json,
                        ),
                      ),
                      #(
                        "outcome",
                        json.nullable(state.outcome, context_outcome.to_json),
                      ),
                      #("reasons", code_reasons(state.reason_codes)),
                    ],
                  )
                }
                // The re-evaluation may have moved the status.
                _, _, False -> {
                  use _ <- result.map(bump())
                  transition_refusal(status, to, None)
                }
                _, _, True -> rest()
              }
            }
          }
        }
      }
    }
    _ -> rest()
  }
}

/// A notice to a party: a player directly, a club through its recorded signatories.
pub fn notify_party_as(
  tx: Tx,
  transaction_id: id.TransactionId,
  p: party_row.Row,
  type_: String,
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
        type_:,
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
          type_:,
          text:,
          ref_id: ref,
          at: now,
        )
      })
    }
  }
}

// ------------------------------------------------------------------------------------------------- documents

/// Who files a document: the agent, a club or the player.
pub type Owner {
  AgentOwner(user_id: id.OrgUserId)
  ClubOwner(org_id: id.OrgId)
  PlayerOwner(player_id: id.PlayerId)
}

type DocumentBody {
  DocumentBody(
    document_type: doc_row.DocumentType,
    visibility: Option(String),
    label: Option(String),
    evidence_id: Option(String),
    expires_at: Option(temporal.Due),
    client_key: Option(String),
  )
}

fn document_shape() -> input.Shape(DocumentBody) {
  let evidence = {
    use _ <- input.field(
      "kind",
      input.required(input.one_of([#("verification_evidence", Nil)])),
    )
    use evidence_id <- input.field("id", input.required(input.id()))
    input.done(evidence_id)
  }
  use document_type <- input.field(
    "documentType",
    input.required(input.one_of(doc_row.document_type_pairs)),
  )
  use visibility <- input.field("visibility", input.optional(input.text(60)))
  use label <- input.field("label", input.nullish(input.text(120)))
  use evidence_id <- input.field(
    "evidenceRef",
    input.nullish(input.object(evidence)),
  )
  use expires_at <- input.field("expiresAt", input.optional(input.due_date()))
  use client_key <- input.field(
    "clientKey",
    input.nullish(input.text(1_000_000)),
  )
  use <- rev.fields
  input.done(DocumentBody(
    document_type:,
    visibility:,
    label:,
    evidence_id:,
    expires_at: option.flatten(expires_at),
    client_key:,
  ))
}

fn uploaded_kind(by: By) -> doc_row.UploadedByKind {
  case by.kind {
    compliance_actor_kind.ClubUser -> doc_row.ClubUser
    compliance_actor_kind.Player -> doc_row.UploadedByKindPlayer
    _ -> doc_row.Org
  }
}

/// No bytes are stored here: `evidenceRef` points into the evidence vault, and without one a document is a
/// placeholder.
pub fn add_document(
  ctx: Ctx,
  req: Request,
  t: Transaction,
  roles: List(RoomRole),
  side: Option(PartyRole),
  owner: Owner,
  by: By,
  rate_key: String,
) -> Response {
  use <- writable(ctx, t)
  use <- limited(ctx, req, limits.TransactionDocumentWrite, rate_key)
  // An unreadable date is refused under the route's own code (DATE_INVALID is renamed, as in TypeScript).
  use b, _ <- body_coded(req, document_shape(), "DOCUMENT_INPUT_INVALID", [
    #("expiresAt", "DOCUMENT_INPUT_INVALID"),
    ..field_codes
  ])
  use key <- client_key(b.client_key)
  let now = clock.now_ms()
  let label = input.filled(b.label) |> option.unwrap("")
  let allowed = transaction_rules.uploadable(roles, side)
  let visibility = option.unwrap(b.visibility, "")
  case
    list.find(allowed, fn(v) { document_visibility.to_string(v) == visibility })
  {
    Error(Nil) ->
      err(
        "DOCUMENT_VISIBILITY_NOT_PERMITTED",
        "You cannot file a document into a lane you do not sit in, and nobody may file into the Trust & Safety lane.",
        [
          #("visibility", case visibility {
            "" -> json.null()
            v -> json.string(v)
          }),
          #("allowed", json.array(allowed, document_visibility.to_json)),
        ],
      )
    Ok(class) ->
      case label {
        "" ->
          err(
            "DOCUMENT_INPUT_INVALID",
            "A document needs a label the other parties can read.",
            [
              #("field", json.string("label")),
              #("problem", json.string("required")),
            ],
          )
        _ -> {
          use evidence <- reading(ctx, fn(r) {
            case b.evidence_id {
              None -> Ok(Ok(None))
              Some(eid) -> {
                use ev <- result.map(records.evidence(
                  r,
                  id.evidence(string.trim(eid)),
                ))
                let agency = Some(t.row.agency_org_id)
                // The uploader must own the evidence; an unknown id and a foreign id answer alike.
                case ev, owner {
                  Some(e), ClubOwner(org) ->
                    case e.org_id == Some(org) {
                      True -> Ok(Some(e.id))
                      False -> Error(Nil)
                    }
                  Some(e), AgentOwner(_) if e.org_id == agency -> Ok(Some(e.id))
                  _, _ -> Error(Nil)
                }
              }
            }
          })
          case evidence {
            Error(Nil) ->
              err(
                "DOCUMENT_INPUT_INVALID",
                "No evidence record of yours matches that reference.",
                [
                  #("field", json.string("evidenceRef")),
                ],
              )
            Ok(evidence) -> {
              // A calendar day is valid through that day.
              let expires = option.map(b.expires_at, temporal.end)
              case expires {
                Some(at) if at <= now ->
                  err(
                    "DOCUMENT_INPUT_INVALID",
                    "An expiry must be a future timestamp.",
                    [
                      #("field", json.string("expiresAt")),
                    ],
                  )
                _ ->
                  add_document_checked(
                    ctx,
                    t,
                    roles,
                    side,
                    owner,
                    by,
                    b,
                    class,
                    label,
                    evidence,
                    expires,
                    key,
                    now,
                  )
              }
            }
          }
        }
      }
  }
}

fn add_document_checked(
  ctx: Ctx,
  t: Transaction,
  roles: List(RoomRole),
  side: Option(PartyRole),
  owner: Owner,
  by: By,
  b: DocumentBody,
  class: document_visibility.DocumentVisibility,
  label: String,
  evidence: Option(id.EvidenceId),
  expires: Option(Int),
  key: Option(String),
  now: Int,
) -> Response {
  let fp =
    canonical.Object([
      #(
        "documentType",
        canonical.Str(doc_row.document_type_to_string(b.document_type)),
      ),
      #("visibility", canonical.Str(document_visibility.to_string(class))),
      #("label", canonical.Str(label)),
      #("evidenceRef", case evidence {
        Some(e) ->
          canonical.Object([
            #("kind", canonical.Str("verification_evidence")),
            #("id", canonical.Str(id.evidence_to_string(e))),
          ])
        None -> canonical.Null
      }),
    ])
    |> canonical.to_string
  use found <- reading(ctx, fn(r) {
    use hit <- result.try(case key {
      Some(k) -> transaction_store.document_by_add_key(r, t.row.id, k)
      None -> Ok(None)
    })
    use docs <- result.map(transaction_store.documents(r, t.row.id))
    #(hit, list.length(docs))
  })
  case found {
    #(Some(hit), _) ->
      case hit.row.add_fp == Some(fp) {
        True ->
          http.json(
            200,
            json.object([
              #("document", document_json(hit, roles, side, now)),
              #("idempotent", json.bool(True)),
            ]),
          )
        False ->
          domain_errors.send(contract, "TRANSACTION_IDEMPOTENCY_CONFLICT", [])
      }
    #(None, count) if count >= 200 ->
      err(
        "DOCUMENT_INPUT_INVALID",
        "This transaction already holds the maximum number of documents.",
        [#("field", json.string("documentType"))],
      )
    #(None, _) -> {
      let #(owner_kind, owner_id) = case owner {
        AgentOwner(u) -> #(doc_row.Agent, id.org_user_to_string(u))
        ClubOwner(o) -> #(doc_row.Club, id.org_to_string(o))
        PlayerOwner(p) -> #(doc_row.OwnerKindPlayer, id.player_to_string(p))
      }
      use tx <- acting(ctx, t)
      use doc_id <- result.try(id.next_transaction_document(tx) |> storage)
      let d =
        doc_row.Row(
          ..doc_row.new(
            id: doc_id,
            transaction_id: t.row.id,
            document_type: b.document_type,
            visibility: class,
            label:,
            version: 1,
            owner_kind:,
            uploaded_by_kind: uploaded_kind(by),
            created_at: now,
            rev: 1,
          ),
          owner_id: Some(owner_id),
          owner_party_role: side,
          uploaded_by_id: by.id,
          uploaded_by_name: by.name,
          uploaded_by_org_id: by.org_id,
          expires_at: expires,
          evidence_id: evidence,
          add_key: key,
          add_fp: option.map(key, fn(_) { fp }),
          rev_at: Some(now),
        )
      use _ <- result.try(
        transaction_store.create_document(tx, d, by) |> storage,
      )
      use _ <- result.try(
        transaction_store.history(
          tx,
          t.row.id,
          event_row.TransactionDocumentAdded,
          by,
          transaction_store.Detail(
            ..transaction_store.no_detail,
            document_type: event_type(b.document_type),
            visibility: Some(class),
          ),
          now,
        )
        |> storage,
      )
      use _ <- result.try(transaction_store.touch(tx, t.row.id, now) |> storage)
      store.emit(
        tx,
        effect.Live(live_event.AgentTransactionDocumentAdded(
          org_id: id.org_to_string(t.row.agency_org_id),
          tx_id: id.transaction_to_string(t.row.id),
          doc_id: id.transaction_document_to_string(doc_id),
        )),
      )
      // A notification is a disclosure: only parties the visibility class admits hear of it.
      use _ <- result.try(case class {
        document_visibility.AgentPrivate -> Ok(Nil)
        _ -> {
          use _ <- result.try(
            t.parties
            |> list.filter(fn(p) { !p.removed })
            |> list.try_each(fn(p) {
              let other = case p.subject_kind {
                subject_kind.Player -> [transaction_rules.PartyIndividual]
                subject_kind.Club -> [transaction_rules.PartyClubSignatory]
              }
              let own = case p.subject_kind, owner {
                subject_kind.Player, PlayerOwner(me) ->
                  p.subject_id == id.player_to_string(me)
                subject_kind.Club, ClubOwner(me) ->
                  p.subject_id == id.org_to_string(me)
                _, _ -> False
              }
              case
                transaction_rules.can_see(class, other, Some(p.party_role))
                && !own
              {
                True ->
                  notify_party_as(
                    tx,
                    t.row.id,
                    p,
                    "agent_transaction",
                    "A document has been shared in a transaction you are party to: "
                      <> label
                      <> ".",
                    now,
                  )
                False -> Ok(Nil)
              }
            })
            |> storage,
          )
          case owner {
            AgentOwner(_) -> Ok(Nil)
            _ ->
              notifications.notify(
                tx,
                to: audience.OrgUser,
                id: id.org_user_to_string(t.row.agent_user_id),
                type_: "agent_transaction",
                text: "A party shared a document in a transaction: "
                  <> label
                  <> ".",
                ref_id: Some(id.transaction_to_string(t.row.id)),
                at: now,
              )
              |> storage
          }
        }
      })
      Ok(http.json(
        201,
        json.object([
          #(
            "document",
            document_json(transaction_store.Document(d, None), roles, side, now),
          ),
        ]),
      ))
    }
  }
}

fn event_type(t: doc_row.DocumentType) -> Option(event_row.DetailDocumentType) {
  event_row.detail_document_type_from_string(doc_row.document_type_to_string(t))
  |> option.from_result
}

/// A document's reference, reauthorised every time: a reference is never a standing permission.
pub fn document_reference(
  ctx: Ctx,
  t: Transaction,
  roles: List(RoomRole),
  side: Option(PartyRole),
  document_id: String,
) -> Response {
  let now = clock.now_ms()
  use docs <- reading(ctx, transaction_store.documents(_, t.row.id))
  let gone = fn() {
    err(
      "DOCUMENT_NOT_FOUND",
      "No document with that reference is available to you.",
      [],
    )
  }
  case
    list.find(docs, fn(d) {
      id.transaction_document_to_string(d.row.id) == document_id
    })
  {
    Ok(d) ->
      case
        transaction_rules.can_see(d.row.visibility, roles, side)
        && !expired(d.row, now)
      {
        False -> gone()
        True ->
          http.json(
            200,
            json.object(case d.row.evidence_id {
              None -> [
                #("document", document_json(d, roles, side, now)),
                #("reference", json.null()),
                #(
                  "note",
                  json.string(
                    "This document is a placeholder: no file has been attached to it in the evidence vault.",
                  ),
                ),
              ]
              Some(e) -> [
                #("document", document_json(d, roles, side, now)),
                #(
                  "reference",
                  json.object([
                    #("kind", json.string("verification_evidence")),
                    #("id", id.evidence_json(e)),
                  ]),
                ),
                #(
                  "note",
                  json.string(
                    "Fetch the file through the canonical evidence route, which authorises the download itself. Holding this reference is not authority to read the file.",
                  ),
                ),
              ]
            }),
          )
      }
    Error(Nil) -> gone()
  }
}

/// A party's list: what its lane admits, superseded versions left out.
pub fn party_documents(
  ctx: Ctx,
  t: Transaction,
  roles: List(RoomRole),
  side: Option(PartyRole),
) -> Response {
  let now = clock.now_ms()
  use docs <- reading(ctx, transaction_store.documents(_, t.row.id))
  http.json(
    200,
    json.object([
      #(
        "items",
        docs
          |> list.filter(fn(d) {
            transaction_rules.can_see(d.row.visibility, roles, side)
            && d.superseded_by == None
          })
          |> json.array(document_json(_, roles, side, now)),
      ),
      #(
        "uploadable",
        json.array(
          transaction_rules.uploadable(roles, side),
          document_visibility.to_json,
        ),
      ),
      #("documentTypes", codes_json(doc_row.document_type_pairs)),
    ]),
  )
}

/// `GET /org/agent/transactions/:id/documents`: every version the agent's lanes admit.
pub fn documents_mine(
  ctx: Ctx,
  a: OrgAccess,
  transaction_id: String,
) -> Response {
  use m <- core_routes.membership(ctx, a)
  use <- core_routes.require(m, "transactions.read")
  use t <- own_transaction(ctx, m, transaction_id)
  let roles = roles_of(t, agent_viewer(m))
  let now = clock.now_ms()
  use docs <- reading(ctx, transaction_store.documents(_, t.row.id))
  http.json(
    200,
    json.object([
      #(
        "items",
        docs
          |> list.filter(fn(d) {
            transaction_rules.can_see(d.row.visibility, roles, None)
          })
          |> json.array(document_json(_, roles, None, now)),
      ),
      #("documentTypes", codes_json(doc_row.document_type_pairs)),
      #(
        "uploadable",
        json.array(
          transaction_rules.uploadable(roles, None),
          document_visibility.to_json,
        ),
      ),
    ]),
  )
}

/// `POST /org/agent/transactions/:id/documents`.
pub fn add_document_mine(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  transaction_id: String,
) -> Response {
  use m <- core_routes.membership(ctx, a)
  use <- core_routes.require(m, "transactions.write")
  use t <- own_transaction(ctx, m, transaction_id)
  add_document(
    ctx,
    req,
    t,
    roles_of(t, agent_viewer(m)),
    None,
    AgentOwner(a.user.id),
    by_agent(a),
    id.org_user_to_string(a.user.id),
  )
}

/// `GET /org/agent/transactions/:id/documents/:docId/reference`.
pub fn document_reference_mine(
  ctx: Ctx,
  a: OrgAccess,
  transaction_id: String,
  document_id: String,
) -> Response {
  use m <- core_routes.membership(ctx, a)
  use <- core_routes.require(m, "transactions.read")
  use t <- own_transaction(ctx, m, transaction_id)
  document_reference(ctx, t, roles_of(t, agent_viewer(m)), None, document_id)
}

/// `POST /org/agent/transactions/:id/documents/:docId/supersede`: the old row is kept, untouched but for its
/// link.
pub fn supersede_document(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  transaction_id: String,
  document_id: String,
) -> Response {
  use m <- core_routes.membership(ctx, a)
  use <- core_routes.require(m, "transactions.write")
  use t <- own_transaction(ctx, m, transaction_id)
  use <- writable(ctx, t)
  let roles = roles_of(t, agent_viewer(m))
  let now = clock.now_ms()
  use docs <- reading(ctx, transaction_store.documents(_, t.row.id))
  case
    list.find(docs, fn(d) {
      id.transaction_document_to_string(d.row.id) == document_id
      && d.row.owner_kind == doc_row.Agent
      && transaction_rules.can_see(d.row.visibility, roles, None)
    })
  {
    Error(Nil) -> domain_errors.send(contract, "DOCUMENT_NOT_FOUND", [])
    Ok(old) if old.superseded_by != None ->
      err(
        "DOCUMENT_SUPERSEDED",
        "That version has already been superseded.",
        [],
      )
    Ok(old) -> {
      let shape = {
        use label <- input.field("label", input.nullish(input.text(120)))
        use <- rev.fields
        input.done(label)
      }
      use label, raw <- body(req, shape, "DOCUMENT_INPUT_INVALID")
      let label = input.filled(label) |> option.unwrap(old.row.label)
      use expected <- rev_expected(raw)
      use <- rev.guard(
        expected,
        rev.Rev(old.row.rev, old.row.rev_at, old.row.rev_by_name),
        "DOCUMENT_VERSION_CONFLICT",
        [#("current", json.object([#("version", json.int(old.row.version))]))],
      )
      let by = by_agent(a)
      use tx <- acting(ctx, t)
      use doc_id <- result.try(id.next_transaction_document(tx) |> storage)
      let next =
        doc_row.Row(
          ..old.row,
          id: doc_id,
          label:,
          version: old.row.version + 1,
          uploaded_by_kind: doc_row.Org,
          uploaded_by_id: by.id,
          uploaded_by_name: by.name,
          uploaded_by_org_id: None,
          created_at: now,
          supersedes_id: Some(old.row.id),
          removed_at: None,
          add_key: None,
          add_fp: None,
          rev: 1,
          rev_at: Some(now),
          rev_by_id: None,
          rev_by_name: None,
        )
      use _ <- result.try(
        transaction_store.supersede_document(tx, old.row, next, by, now)
        |> storage,
      )
      use _ <- result.try(
        transaction_store.history(
          tx,
          t.row.id,
          event_row.TransactionDocumentSuperseded,
          by,
          transaction_store.Detail(
            ..transaction_store.no_detail,
            document_type: event_type(next.document_type),
            version: Some(next.version),
          ),
          now,
        )
        |> storage,
      )
      use _ <- result.try(transaction_store.touch(tx, t.row.id, now) |> storage)
      Ok(http.json(
        201,
        json.object([
          #(
            "document",
            document_json(
              transaction_store.Document(next, None),
              roles,
              None,
              now,
            ),
          ),
        ]),
      ))
    }
  }
}

// ------------------------------------------------------------------------------------------------- terms

type TermsBody {
  TermsBody(
    summary: Option(String),
    recorded_for: PartyRole,
    visibility: Option(String),
  )
}

/// `POST /org/agent/transactions/:id/terms`: recorded as data, not validated. Validating a suspended fee rule
/// would be wrong, and proposing terms would make ScoutBox the negotiator.
pub fn record_terms(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  transaction_id: String,
) -> Response {
  use m <- core_routes.membership(ctx, a)
  use <- core_routes.require(m, "transactions.write")
  use t <- own_transaction(ctx, m, transaction_id)
  use <- writable(ctx, t)
  use <- limited(
    ctx,
    req,
    limits.TransactionWrite,
    id.org_user_to_string(a.user.id),
  )
  let shape = {
    use summary <- input.field("summary", input.nullish(input.text(note_max)))
    use recorded_for <- input.field(
      "recordedFor",
      input.required(input.one_of(party_role.pairs)),
    )
    use visibility <- input.field("visibility", input.optional(input.text(60)))
    use <- rev.fields
    input.done(TermsBody(summary, recorded_for, visibility))
  }
  use b, raw <- body(req, shape, "TERMS_INPUT_INVALID")
  let viewer = agent_viewer(m)
  let roles = roles_of(t, viewer)
  let allowed = transaction_rules.uploadable(roles, None)
  let visibility = option.unwrap(b.visibility, "")
  case input.filled(b.summary) {
    None ->
      err(
        "TERMS_INPUT_INVALID",
        "A terms version needs a written summary of what the parties recorded.",
        [
          #("field", json.string("summary")),
          #("problem", json.string("required")),
        ],
      )
    Some(summary) ->
      case
        list.find(allowed, fn(v) {
          document_visibility.to_string(v) == visibility
        }),
        terms_row.visibility_from_string(visibility)
      {
        Ok(class), Ok(stored) ->
          case list.length(t.terms) >= 50 {
            True ->
              err(
                "TERMS_INPUT_INVALID",
                "This transaction already holds the maximum number of recorded terms versions.",
                [#("field", json.string("summary"))],
              )
            False -> {
              use <- guard_rev(raw, t)
              let by = by_agent(a)
              let now = clock.now_ms()
              let version = list.length(t.terms) + 1
              use tx <- acting(ctx, t)
              use terms_id <- result.try(id.next_terms_version(tx) |> storage)
              use _ <- result.try(
                transaction_store.record_terms(
                  tx,
                  t,
                  terms_row.Row(
                    ..terms_row.new(
                      id: terms_id,
                      transaction_id: t.row.id,
                      version:,
                      recorded_at: now,
                      recorded_by_id: a.user.id,
                      recorded_for: b.recorded_for,
                      visibility: stored,
                      summary:,
                    ),
                    recorded_by_name: Some(a.user.name),
                  ),
                )
                |> storage,
              )
              use _ <- result.try(
                transaction_store.history(
                  tx,
                  t.row.id,
                  event_row.TransactionTermsRecorded,
                  by,
                  transaction_store.Detail(
                    ..transaction_store.no_detail,
                    party_role: Some(b.recorded_for),
                    visibility: Some(class),
                    version: Some(version),
                  ),
                  now,
                )
                |> storage,
              )
              use _ <- result.try(
                transaction_store.touch(tx, t.row.id, now) |> storage,
              )
              use _ <- result.try(
                transaction_store.bump(tx, t.row.id, by, now) |> storage,
              )
              use view <- result.map(projected(tx, t.row.id, viewer, now))
              http.json(201, transaction_body(view))
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

// ------------------------------------------------------------------------------------------------- parties

type PartyBody {
  PartyBody(party: PartyInput, client_key: Option(String))
}

/// `POST /org/agent/transactions/:id/parties`.
pub fn add_party(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  transaction_id: String,
) -> Response {
  use m <- core_routes.membership(ctx, a)
  use <- core_routes.require(m, "transactions.write")
  use t <- own_transaction(ctx, m, transaction_id)
  use <- writable(ctx, t)
  use <- limited(
    ctx,
    req,
    limits.TransactionWrite,
    id.org_user_to_string(a.user.id),
  )
  let shape = {
    use role <- input.field(
      "partyRole",
      input.required(input.one_of(party_role.pairs)),
    )
    use kind <- input.field(
      "subjectKind",
      input.required(input.one_of(subject_kind.pairs)),
    )
    use subject_id <- input.field("subjectId", input.required(input.id()))
    use client_key <- input.field(
      "clientKey",
      input.nullish(input.text(1_000_000)),
    )
    use <- rev.fields
    input.done(PartyBody(PartyInput(role, kind, subject_id), client_key))
  }
  use b, raw <- body(req, shape, "TRANSACTION_INPUT_INVALID")
  use key <- client_key(b.client_key)
  let now = clock.now_ms()
  use resolved <- reading(ctx, resolve_parties(
    _,
    a,
    [b.party],
    t.row.type_,
    now,
  ))
  case resolved {
    Error(response) -> response
    Ok(_) -> {
      let p = b.party
      let viewer = agent_viewer(m)
      let fp =
        canonical.Object([
          #("partyRole", canonical.Str(party_role.to_string(p.role))),
          #("subjectId", canonical.Str(p.subject_id)),
        ])
        |> canonical.to_string
      let replay = case key {
        Some(k) -> transaction_store.key_fp(t, key_row.Party, k)
        None -> None
      }
      case replay {
        Some(stored) if stored == fp -> {
          use view <- reading(ctx, project(_, t, viewer, now))
          http.json(200, idempotent_body(view))
        }
        Some(_) ->
          domain_errors.send(contract, "TRANSACTION_IDEMPOTENCY_CONFLICT", [])
        None ->
          case
            list.any(t.parties, fn(x) { !x.removed && x.party_role == p.role }),
            list.length(t.parties) >= parties_max * 3
          {
            True, _ ->
              domain_errors.send(contract, "TRANSACTION_PARTY_EXISTS", [
                #("partyRole", party_role.to_json(p.role)),
              ])
            _, True ->
              err(
                "TRANSACTION_INPUT_INVALID",
                "This transaction already holds the maximum number of party records.",
                [#("field", json.string("parties"))],
              )
            False, False -> {
              use <- guard_rev(raw, t)
              let by = by_agent(a)
              use tx <- acting(ctx, t)
              use party_id <- result.try(
                id.next_transaction_party(tx) |> storage,
              )
              let row =
                party_row.Row(
                  ..party_row.new(
                    id: party_id,
                    transaction_id: t.row.id,
                    transaction_type: t.row.type_,
                    ord: 0,
                    party_role: p.role,
                    subject_kind: p.kind,
                    subject_id: p.subject_id,
                    added_at: now,
                    added_by_id: a.user.id,
                    removed: False,
                  ),
                  added_by_name: Some(a.user.name),
                )
              use _ <- result.try(
                transaction_store.add_party(
                  tx,
                  t,
                  row,
                  option.map(key, fn(k) { #(k, fp) }),
                )
                |> storage,
              )
              use _ <- result.try(
                transaction_store.history(
                  tx,
                  t.row.id,
                  event_row.TransactionPartyAdded,
                  by,
                  transaction_store.Detail(
                    ..transaction_store.no_detail,
                    party_role: Some(p.role),
                    subject_kind: Some(p.kind),
                  ),
                  now,
                )
                |> storage,
              )
              use _ <- result.try(
                party_changed(tx, t.row.id, by, now) |> storage,
              )
              use _ <- result.try(
                transaction_store.bump(tx, t.row.id, by, now) |> storage,
              )
              store.emit(
                tx,
                effect.Live(live_event.AgentTransactionPartyChanged(
                  org_id: id.org_to_string(t.row.agency_org_id),
                  tx_id: id.transaction_to_string(t.row.id),
                  party_role: party_role.to_string(p.role),
                )),
              )
              use _ <- result.try(
                notify_party_as(
                  tx,
                  t.row.id,
                  row,
                  "agent_transaction_action",
                  "A transaction workspace now names you as the "
                    <> string.replace(party_role.to_string(p.role), "_", " ")
                    <> ". Confirm your participation to let it proceed. Confirming does not agree to any terms.",
                  now,
                )
                |> storage,
              )
              use view <- result.map(projected(tx, t.row.id, viewer, now))
              http.json(201, transaction_body(view))
            }
          }
      }
    }
  }
}

/// `POST /org/agent/transactions/:id/parties/:pid/remove`: the party row stays with its `removedAt`; every
/// representation naming that role is withdrawn.
pub fn remove_party(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  transaction_id: String,
  party_id: String,
) -> Response {
  use m <- core_routes.membership(ctx, a)
  use <- core_routes.require(m, "transactions.write")
  use t <- own_transaction(ctx, m, transaction_id)
  use <- writable(ctx, t)
  case
    list.find(t.parties, fn(p) {
      id.transaction_party_to_string(p.id) == party_id
    })
  {
    Error(Nil) ->
      domain_errors.send(contract, "TRANSACTION_PARTY_NOT_FOUND", [])
    Ok(party) -> {
      use raw <- rev_only(req)
      let viewer = agent_viewer(m)
      let now = clock.now_ms()
      case party.removed {
        True -> {
          use view <- reading(ctx, project(_, t, viewer, now))
          http.json(200, idempotent_body(view))
        }
        False -> {
          use <- guard_rev(raw, t)
          let by = by_agent(a)
          use tx <- acting(ctx, t)
          let read = store.reading(tx)
          use reps <- result.try(
            transaction_store.representations(read, t.row.id) |> storage,
          )
          use _ <- result.try(
            reps
            |> list.filter(fn(r) {
              r.row.party_role == party.party_role
              && r.row.status != declared_representation_status.Withdrawn
            })
            |> list.try_each(fn(r) {
              transaction_store.withdraw_representation(
                tx,
                r.row,
                rep_row.PartyRemoved,
                by,
                Some(declared_representation_status.Withdrawn),
                Some(#(a.user.id, a.user.name)),
                now,
              )
            })
            |> storage,
          )
          use _ <- result.try(
            transaction_store.remove_party(tx, t.row.id, party.id, now)
            |> storage,
          )
          use _ <- result.try(
            transaction_store.history(
              tx,
              t.row.id,
              event_row.TransactionPartyRemoved,
              by,
              transaction_store.Detail(
                ..transaction_store.no_detail,
                party_role: Some(party.party_role),
                subject_kind: Some(party.subject_kind),
              ),
              now,
            )
            |> storage,
          )
          use _ <- result.try(party_changed(tx, t.row.id, by, now) |> storage)
          use _ <- result.try(
            transaction_store.bump(tx, t.row.id, by, now) |> storage,
          )
          store.emit(
            tx,
            effect.Live(live_event.AgentTransactionPartyChanged(
              org_id: id.org_to_string(t.row.agency_org_id),
              tx_id: id.transaction_to_string(t.row.id),
              party_role: party_role.to_string(party.party_role),
            )),
          )
          use view <- result.map(projected(tx, t.row.id, viewer, now))
          http.json(200, transaction_body(view))
        }
      }
    }
  }
}

/// `GET /org/agent/transactions/:id/messages`.
pub fn messages_mine(
  ctx: Ctx,
  a: OrgAccess,
  transaction_id: String,
) -> Response {
  use m <- core_routes.membership(ctx, a)
  use <- core_routes.require(m, "transactions.read")
  use t <- own_transaction(ctx, m, transaction_id)
  let viewer = agent_viewer(m)
  use threads <- reading(ctx, fn(r) {
    list.try_map(t.threads, thread_json(r, _, viewer))
  })
  http.json(
    200,
    json.object([
      #("items", json.preprocessed_array(threads)),
      #(
        "note",
        json.string(
          "Correspondence lives in the canonical ScoutBox Inbox. A link records that a conversation exists and who shared it; reading it still needs the Inbox's own authorisation, which transaction membership alone does not give. ScoutBox never negotiates and never replies for anyone.",
        ),
      ),
    ]),
  )
}

// ------------------------------------------------------------------------------------------------- the compliance seams

/// `POST /org/agent/transactions/:id/consents/request`: through the compliance ledger's own request. The context is
/// re-projected from the transaction's rows first, as its own write.
pub fn request_consent(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  transaction_id: String,
) -> Response {
  use m <- core_routes.membership(ctx, a)
  use <- core_routes.require(m, "transactions.write")
  use t <- own_transaction(ctx, m, transaction_id)
  use <- writable(ctx, t)
  let projected =
    store.unit(ctx.store, fn(tx) {
      let read = store.reading(tx)
      use found <- result.try(compliance_store.by_id(read, t.row.context_id))
      case found {
        None -> Ok(None)
        Some(c) -> {
          use reps <- result.try(transaction_store.representations(
            read,
            t.row.id,
          ))
          let live =
            reps
            |> list.filter(fn(r) {
              r.row.status != declared_representation_status.Withdrawn
            })
            |> list.map(fn(r) { r.row })
          use _ <- result.try(compliance_store.project(
            tx,
            c.row.id,
            t.parties,
            live,
          ))
          compliance_store.by_id(read, c.row.id)
        }
      }
    })
  case projected {
    Ok(Some(c)) -> compliance_routes.request_consent(ctx, req, a, c)
    Ok(None) -> not_found()
    Error(e) -> http.internal(e)
  }
}

/// A reviewer decided a declared-only binding. An approval records no act by the agent: `first_act_at` stays
/// empty, so a later party-specific consent still counts as given in advance.
pub fn binding_decided(
  tx: Tx,
  transaction_id: String,
  representation_id: String,
  approved: Bool,
  by: By,
  review_id: id.RegulatoryReviewId,
  now: Int,
) -> Result(Nil, Fail(Response)) {
  let read = store.reading(tx)
  let tid = id.transaction(transaction_id)
  use t <- result.try(transaction_store.by_id(read, tid) |> storage)
  use rep <- result.try(
    transaction_store.representation_by_id(
      read,
      id.representation(representation_id),
    )
    |> storage,
  )
  case t, rep {
    Some(t), Some(r)
      if r.row.transaction_id == tid
      && r.row.status == declared_representation_status.PendingReview
    -> {
      let status = case approved {
        True -> declared_representation_status.Verified
        False -> declared_representation_status.Withdrawn
      }
      use _ <- result.try(
        case approved {
          True ->
            transaction_store.verify_representation(
              tx,
              r.row,
              review_id,
              by,
              now,
            )
          False ->
            transaction_store.withdraw_representation(
              tx,
              r.row,
              rep_row.ReviewRejected,
              by,
              Some(declared_representation_status.Withdrawn),
              None,
              now,
            )
        }
        |> storage,
      )
      use _ <- result.try(
        transaction_store.history(
          tx,
          tid,
          case approved {
            True -> event_row.TransactionRepresentationAttached
            False -> event_row.TransactionRepresentationWithdrawn
          },
          by,
          transaction_store.Detail(
            ..transaction_store.no_detail,
            party_role: Some(r.row.party_role),
            status: Some(status),
          ),
          now,
        )
        |> storage,
      )
      use _ <- result.try(transaction_store.touch(tx, tid, now) |> storage)
      case transaction_rules.is_live(t.row.status) {
        True -> recheck(tx, tid, by, now) |> storage |> result.replace(Nil)
        False -> Ok(Nil)
      }
    }
    _, _ -> Ok(Nil)
  }
}
