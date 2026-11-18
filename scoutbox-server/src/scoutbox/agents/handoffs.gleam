//// A club's transaction handoff (domains/agents/integration: `/org/rooms/:id/transaction-handoff`): an explicit
//// invitation, from a recruitment case at Offer consideration, for a licensed agent to open a transaction
//// workspace. It is not an offer, carries no terms and commits nobody. The workspace that cites the case accepts
//// it (`bind`), so one invitation opens one workspace.
////
//// Not ported yet: the minor pathway (closed in every jurisdiction, so a minor always meets
//// HANDOFF_MINOR_PATHWAY_DISABLED).

import gleam/dynamic
import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/agents/agent_store
import scoutbox/agents/compliance_store
import scoutbox/agents/core_routes
import scoutbox/agents/integration
import scoutbox/agents/representation
import scoutbox/agents/transaction_store
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/players
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/effect
import scoutbox/platform/http
import scoutbox/platform/idempotency
import scoutbox/platform/input
import scoutbox/platform/limits
import scoutbox/platform/live_event
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/recruitment/cases.{type Room}
import scoutbox/recruitment/decisions
import scoutbox/recruitment/room_routes
import scoutbox/recruitment/room_rules
import scoutbox/recruitment/room_view
import scoutbox/rows/case_history as history_row
import scoutbox/rows/case_transaction_handoffs as handoff_row
import scoutbox/rows/id
import scoutbox/rows/room_decisions as decision_row
import scoutbox/vocab/audience
import scoutbox/vocab/context_type
import scoutbox/vocab/decision_outcome
import scoutbox/vocab/jurisdiction
import scoutbox/vocab/room_status
import sqlight
import wisp.{type Request, type Response}

/// An invitation not taken up within 30 days has lapsed.
const ttl_ms = 2_592_000_000

const honest =
  "An invitation to open a transaction workspace. It is not an offer, it carries no terms and no fee, and it commits nobody to anything. The workspace itself is opened by a licensed agent, and every party confirms their own participation."

// ------------------------------------------------------------------------------------------------- rules

/// `effectiveHandoffStatus`: an open invitation lapses after its time.
pub fn effective_status(h: handoff_row.Row, now: Int) -> String {
  case h.status {
    handoff_row.Invited if now - h.invited_at >= ttl_ms -> "expired"
    status -> handoff_row.status_to_string(status)
  }
}

pub type Facts {
  Facts(
    can_write: Bool,
    has_final_progress_decision: Bool,
    case_status: room_status.RoomStatus,
    subject_present: Bool,
    is_adult: Bool,
    blocked: Bool,
    existing_status: Option(String),
    live_transaction: Bool,
    compliance_evaluable: Bool,
  )
}

/// `handoffBlockers`: every blocker at once, so a club sees the whole picture. The decision's rationale is not an
/// argument, so it cannot leak into a refusal.
pub fn blockers(f: Facts) -> List(String) {
  [
    #("HANDOFF_NOT_PERMITTED", !f.can_write),
    #("HANDOFF_DECISION_REQUIRED", !f.has_final_progress_decision),
    #("HANDOFF_CASE_STATE", f.case_status != room_status.OfferConsideration),
    #("HANDOFF_SUBJECT_UNAVAILABLE", !f.subject_present),
    #("HANDOFF_MINOR_PATHWAY_DISABLED", !f.is_adult),
    #("HANDOFF_BLOCKED", f.blocked),
    #(
      "HANDOFF_EXISTS",
      f.existing_status == Some("invited")
        || f.existing_status == Some("accepted"),
    ),
    #("HANDOFF_TRANSACTION_EXISTS", f.live_transaction),
    #("HANDOFF_COMPLIANCE_UNAVAILABLE", !f.compliance_evaluable),
  ]
  |> list.filter_map(fn(b) {
    case b.1 {
      True -> Ok(b.0)
      False -> Error(Nil)
    }
  })
}

// ------------------------------------------------------------------------------------------------- store

pub fn of_case(
  read: Read,
  case_id: id.RecruitmentCaseId,
) -> Result(Option(handoff_row.Row), Fail(e)) {
  store.one(
    read,
    "SELECT "
      <> handoff_row.columns
      <> " FROM case_transaction_handoffs WHERE case_id = ?",
    [id.recruitment_case_sql(case_id)],
    handoff_row.decoder(),
  )
  |> result.map(option.from_result)
}

/// Only this boolean crosses into the agent side, never the decision itself.
fn has_final_progress_decision(
  read: Read,
  room: Room,
) -> Result(Bool, Fail(e)) {
  use rows <- result.map(decisions.rows_of(read, room.row.id, room.row.org_id))
  case decisions.chain_head(rows.rows) {
    Some(d) ->
      decisions.is_formal(d)
      && d.base.row.state == Some(decision_row.Final)
      && d.base.row.outcome == Some(decision_outcome.Progress)
      && d.base.row.superseded_by_id == None
    None -> False
  }
}

fn view(h: handoff_row.Row, now: Int) -> Json {
  json.object([
    #("id", id.handoff_json(h.id)),
    #("status", json.string(effective_status(h, now))),
    #("storedStatus", handoff_row.status_to_json(h.status)),
    #("invitedAt", json.int(h.invited_at)),
    #("invitedByName", json.nullable(h.invited_by_name, json.string)),
    #("acceptedAt", json.nullable(h.accepted_at, json.int)),
    #("withdrawnAt", json.nullable(h.withdrawn_at, json.int)),
    #("transactionId", json.nullable(h.transaction_id, id.transaction_json)),
    #("representedAtInvitation", json.bool(h.represented_at_invitation)),
    #("caseId", id.recruitment_case_json(h.case_id)),
    #("rev", json.int(h.rev)),
    #("honest", json.string(honest)),
  ])
}

/// Binds the invitation to the workspace citing its case, inside the workspace's unit, so a citation that does
/// not check out opens nothing. A refusal code, or none.
pub fn bind(
  tx: Tx,
  case_id: String,
  transaction_id: id.TransactionId,
  agency: id.OrgId,
  agent: id.OrgUserId,
  client_id: Option(String),
  at: Int,
) -> Result(Option(String), Fail(e)) {
  let case_id = id.recruitment_case(case_id)
  use found <- result.try(of_case(store.reading(tx), case_id))
  case found {
    None -> Ok(Some("HANDOFF_NOT_FOUND"))
    Some(h) ->
      case
        Some(id.player_to_string(h.player_id)) == client_id,
        effective_status(h, at) == "invited",
        h.invited_agency_org_id == None
        || h.invited_agency_org_id == Some(agency),
        h.invited_agent_user_id == None
        || h.invited_agent_user_id == Some(agent)
      {
        False, _, _, _ -> Ok(Some("HANDOFF_SUBJECT_MISMATCH"))
        _, False, _, _ -> Ok(Some("HANDOFF_NOT_OPEN"))
        // Otherwise an invitation would become a general licence to open a workspace citing this club.
        _, _, False, _ | _, _, _, False -> Ok(Some("HANDOFF_NOT_ADDRESSED"))
        True, True, True, True -> {
          use _ <- result.try(
            store.run(
              tx,
              "UPDATE case_transaction_handoffs SET status = 'accepted', accepted_at = ?, transaction_id = ?, rev = rev + 1, rev_at = ? WHERE case_id = ? AND status = 'invited'",
              [
                sqlight.int(at),
                id.transaction_sql(transaction_id),
                sqlight.int(at),
                id.recruitment_case_sql(case_id),
              ],
            ),
          )
          use _ <- result.map(cases.record(
            tx,
            case_id,
            cases.By(history_row.Org, Some(id.org_user_to_string(agent)), None),
            [
              cases.entry("transaction_handoff_accepted", [
                #("handoffId", id.handoff_json(h.id)),
              ]),
            ],
            at,
          ))
          None
        }
      }
  }
}

// ------------------------------------------------------------------------------------------------- the route

type InviteBody {
  InviteBody(client_key: Option(String))
}

fn rate_limited(action: limits.Action) -> Response {
  http.json(
    429,
    json.object(
      list.map(limits.limited_body(action), fn(p) { #(p.0, json.string(p.1)) }),
    ),
  )
}

type Need {
  View
  Write
}

/// A handoff is a decision about the club's external conduct, so writing it needs the rank a formal decision
/// needs. Continues with the room and whether this caller may write.
fn room_for_handoff(
  ctx: Ctx,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
  need: Need,
  next: fn(Room, Bool) -> Response,
) -> Response {
  use room <- room_routes.with_room(ctx, a, room_id)
  let role = room_view.role(a, room)
  let can_write = room_rules.room_can(role, room_rules.DecisionFinalize)
  case room_rules.room_can(role, room_rules.DecisionView), need, can_write {
    False, _, _ ->
      http.error_message(
        403,
        "HANDOFF_NOT_PERMITTED",
        "Your role cannot read this case's handoff.",
      )
    True, Write, False ->
      http.error_message(
        403,
        "HANDOFF_NOT_PERMITTED",
        "Only a recruitment lead can invite a transaction workspace.",
      )
    True, _, _ -> next(room, can_write)
  }
}

/// `GET /org/rooms/:id/transaction-handoff`. The invite route asks the same `blockers`, so forcing the request
/// gets the answer the screen showed.
pub fn show(ctx: Ctx, a: OrgAccess, room_id: id.RecruitmentCaseId) -> Response {
  use room, can_write <- room_for_handoff(ctx, a, room_id, View)
  let now = clock.now_ms()
  case store.read(ctx.store, gather(_, a, room, can_write, now)) {
    Error(e) -> http.internal(e)
    Ok(#(existing, facts, _)) -> {
      let all = blockers(facts)
      http.json(
        200,
        json.object([
          #("handoff", json.nullable(existing, view(_, now))),
          #("available", json.bool(all == [])),
          // A viewer does not get a checklist of what a lead could do.
          #(
            "blockers",
            json.array(
              case can_write {
                True -> all
                False -> ["HANDOFF_NOT_PERMITTED"]
              },
              json.string,
            ),
          ),
          #("blockerVocabulary", json.array(blocker_codes, json.string)),
          #("action", json.string("inviteToTransaction")),
          #(
            "note",
            json.string(
              "Inviting a transaction is a separate, explicit decision. ScoutBox never creates one from a recruitment decision by itself, and this invitation is not an offer.",
            ),
          ),
        ]),
      )
    }
  }
}

/// `HANDOFF_BLOCKERS`, in the order `blockers` reports them.
const blocker_codes = [
  "HANDOFF_NOT_PERMITTED", "HANDOFF_DECISION_REQUIRED", "HANDOFF_CASE_STATE",
  "HANDOFF_SUBJECT_UNAVAILABLE", "HANDOFF_MINOR_PATHWAY_DISABLED",
  "HANDOFF_BLOCKED", "HANDOFF_EXISTS", "HANDOFF_TRANSACTION_EXISTS",
  "HANDOFF_COMPLIANCE_UNAVAILABLE",
]

/// `POST /org/rooms/:id/transaction-handoff`.
pub fn invite(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
) -> Response {
  use room, _ <- room_for_handoff(ctx, a, room_id, Write)
  let shape = {
    use raw <- input.field("clientKey", input.nullish(input.text(1_000_000)))
    input.done(InviteBody(raw))
  }
  use b <- core_routes.plain_body(req, shape)
  case idempotency.client_key(option.map(b.client_key, dynamic.string)) {
    Error(message) ->
      http.error_message(400, "AGENT_CLIENT_KEY_INVALID", message)
    Ok(key) -> invite_checked(ctx, a, room, key)
  }
}

/// The case's handoff, the facts `blockers` decides on, and the client's sole active agreement.
fn gather(
  read: Read,
  a: OrgAccess,
  room: Room,
  can_write: Bool,
  now: Int,
) -> Result(
  #(Option(handoff_row.Row), Facts, Option(representation.Agreement)),
  Fail(e),
) {
  let r = room.row
  use existing <- result.try(of_case(read, r.id))
  use decided <- result.try(has_final_progress_decision(read, room))
  use found <- result.try(players.for_org(read, r.player_id, a.org, now))
  use live <- result.try(transaction_store.duplicate_of(
    read,
    id.player_to_string(r.player_id),
    context_type.EmploymentContract,
    Some(id.org_to_string(r.org_id)),
    None,
  ))
  use #(agreement, _) <- result.try(representation.sole_active(
    read,
    id.player_to_string(r.player_id),
    now,
  ))
  // An unrepresented player has no agent to evaluate; the workspace's own gate asks whoever opens one.
  use evaluable <- result.map(case agreement {
    Some(ag) ->
      compliance_store.clear_to_declare(
        read,
        ag.row.agent_user_id,
        jurisdiction.to_string(ag.row.jurisdiction),
        now,
      )
    None -> Ok(True)
  })
  let facts =
    Facts(
      can_write:,
      has_final_progress_decision: decided,
      case_status: room.status,
      subject_present: case found {
        Some(#(_, access)) -> access.visible
        None -> False
      },
      is_adult: case found {
        Some(#(p, _)) -> players.is_adult(p, now)
        None -> False
      },
      blocked: case found {
        Some(#(_, access)) -> access.blocked
        None -> False
      },
      existing_status: option.map(existing, effective_status(_, now)),
      live_transaction: live != None,
      compliance_evaluable: evaluable,
    )
  #(existing, facts, agreement)
}

fn invite_checked(
  ctx: Ctx,
  a: OrgAccess,
  room: Room,
  key: Option(String),
) -> Response {
  let now = clock.now_ms()
  let r = room.row
  case store.read(ctx.store, gather(_, a, room, True, now)) {
    Error(e) -> http.internal(e)
    Ok(#(existing, facts, agreement)) ->
      case existing, key {
        Some(h), Some(k) if h.invite_key == Some(k) ->
          http.json(
            200,
            json.object([
              #("handoff", view(h, now)),
              #("idempotent", json.bool(True)),
            ]),
          )
        _, _ ->
          case blockers(facts) {
            [first, ..] as all ->
              http.json(
                case
                  first == "HANDOFF_NOT_PERMITTED",
                  list.contains(all, "HANDOFF_EXISTS")
                  || list.contains(all, "HANDOFF_TRANSACTION_EXISTS")
                {
                  True, _ -> 403
                  False, True -> 409
                  False, False -> 422
                },
                json.object([
                  #("error", json.string(first)),
                  #("blockers", json.array(all, json.string)),
                  #(
                    "message",
                    json.string(
                      "This case cannot be handed to a transaction workspace right now.",
                    ),
                  ),
                ]),
              )
            [] ->
              case
                limits.limited(
                  ctx.limits,
                  limits.TransactionHandoff,
                  id.org_to_string(r.org_id),
                  now,
                )
              {
                True -> rate_limited(limits.TransactionHandoff)
                False -> write(ctx, a, room, existing, agreement, key, now)
              }
          }
      }
  }
}

fn write(
  ctx: Ctx,
  a: OrgAccess,
  room: Room,
  existing: Option(handoff_row.Row),
  agreement: Option(representation.Agreement),
  key: Option(String),
  now: Int,
) -> Response {
  let r = room.row
  store.unit(ctx.store, fn(tx) {
    // What the checks read before the unit must still hold: no invitation stood up beside this one.
    use current <- result.try(
      of_case(store.reading(tx), r.id) |> room_routes.storage,
    )
    use <- stale_unless(current == existing)
    use handoff_id <- result.try(id.next_handoff(tx) |> room_routes.storage)
    let h =
      handoff_row.Row(
        ..handoff_row.new(
          case_id: r.id,
          id: handoff_id,
          org_id: r.org_id,
          player_id: r.player_id,
          status: handoff_row.Invited,
          invited_at: now,
          represented_at_invitation: agreement != None,
          rev: 1,
        ),
        invited_by_user_id: Some(a.user.id),
        invited_by_name: Some(a.user.name),
        // Whether, not who: the handoff must not become a back door to the agent's identity. The workspace that
        // answers it must come from this agency and agent.
        invited_agency_org_id: option.map(agreement, fn(ag) {
          ag.row.agency_org_id
        }),
        invited_agent_user_id: option.map(agreement, fn(ag) {
          ag.row.agent_user_id
        }),
        invite_key: key,
        rev_at: Some(now),
      )
    use _ <- result.try(
      store.run(tx, "DELETE FROM case_transaction_handoffs WHERE case_id = ?", [
        id.recruitment_case_sql(r.id),
      ])
      |> room_routes.storage,
    )
    use _ <- result.try(handoff_row.insert(tx, h) |> room_routes.storage)
    use _ <- result.try(
      cases.record(
        tx,
        r.id,
        cases.by_staff(a.user.id, a.user.name),
        [
          cases.entry("transaction_handoff_invited", [
            #("handoffId", id.handoff_json(handoff_id)),
            #("represented", json.bool(h.represented_at_invitation)),
          ]),
        ],
        now,
      )
      |> room_routes.storage,
    )
    store.emit(
      tx,
      effect.Live(live_event.TransactionHandoffInvited(
        org_id: id.org_to_string(r.org_id),
        room_id: id.recruitment_case_to_string(r.id),
        handoff_id: id.handoff_to_string(handoff_id),
      )),
    )
    let ref = Some(id.handoff_to_string(handoff_id))
    use _ <- result.try(
      case agreement {
        Some(ag) ->
          notifications.notify(
            tx,
            to: audience.OrgUser,
            id: id.org_user_to_string(ag.row.agent_user_id),
            type_: "representation_transaction",
            text: a.org.name
              <> " has invited a transaction workspace for one of your clients. Opening it is your action, and it commits nobody to anything.",
            ref_id: ref,
            at: now,
          )
        None -> Ok(Nil)
      }
      |> room_routes.storage,
    )
    // The player hears too: they should never learn a club is acting on them from their agent alone.
    use _ <- result.map(
      notifications.notify(
        tx,
        to: audience.Player,
        id: id.player_to_string(r.player_id),
        type_: "representation_transaction",
        text: a.org.name
          <> " has asked to open a transaction workspace about you. Nothing has been agreed and this is not an offer; you confirm your own participation if a workspace is opened.",
        ref_id: ref,
        at: now,
      )
      |> room_routes.storage,
    )
    http.json(
      201,
      json.object([
        #("handoff", view(h, now)),
        #(
          "note",
          json.string(
            "Invited. A licensed agent opens the workspace, and every party confirms for themselves.",
          ),
        ),
      ]),
    )
  })
  |> room_routes.answer
}

fn stale_unless(
  holds: Bool,
  next: fn() -> Result(a, Fail(e)),
) -> Result(a, Fail(e)) {
  case holds {
    True -> next()
    False -> store.stale("the case's handoff changed")
  }
}

/// `POST /org/rooms/:id/transaction-handoff/withdraw`. The record stays, marked withdrawn; a taken-up invitation
/// is refused, because withdrawing it would not close the workspace it opened.
pub fn withdraw(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
) -> Response {
  use room, _ <- room_for_handoff(ctx, a, room_id, Write)
  let r = room.row
  let now = clock.now_ms()
  case store.read(ctx.store, of_case(_, r.id)) {
    Error(e) -> http.internal(e)
    Ok(None) -> http.error(404, "HANDOFF_NOT_FOUND")
    Ok(Some(h)) -> {
      use _ <- core_routes.plain_body(req, input.done(Nil))
      case h.status {
        handoff_row.Withdrawn ->
          http.json(
            200,
            json.object([
              #("handoff", view(h, now)),
              #("idempotent", json.bool(True)),
            ]),
          )
        handoff_row.Accepted ->
          http.json(
            409,
            json.object([
              #("error", json.string("HANDOFF_ALREADY_ACCEPTED")),
              #(
                "transactionId",
                json.nullable(h.transaction_id, id.transaction_json),
              ),
              #(
                "message",
                json.string(
                  "A workspace has already been opened from this invitation. Withdrawing the invitation would not close it — act in the workspace instead.",
                ),
              ),
            ]),
          )
        // The other half of the invite/withdraw loop, on the same club budget.
        handoff_row.Invited ->
          case
            limits.limited(
              ctx.limits,
              limits.TransactionHandoff,
              id.org_to_string(r.org_id),
              now,
            )
          {
            True -> rate_limited(limits.TransactionHandoff)
            False -> withdrawing(ctx, a, room, h, now)
          }
      }
    }
  }
}

fn withdrawing(
  ctx: Ctx,
  a: OrgAccess,
  room: Room,
  h: handoff_row.Row,
  now: Int,
) -> Response {
  let r = room.row
  store.unit(ctx.store, fn(tx) {
    use rows <- result.try(
      store.write(
        tx,
        "UPDATE case_transaction_handoffs SET status = 'withdrawn', withdrawn_at = ?, rev = rev + 1, rev_at = ? WHERE case_id = ? AND status = 'invited' RETURNING "
          <> handoff_row.columns,
        [sqlight.int(now), sqlight.int(now), id.recruitment_case_sql(r.id)],
        handoff_row.decoder(),
      )
      |> room_routes.storage,
    )
    case rows {
      [] -> store.stale("the case's handoff changed")
      [fresh, ..] -> {
        use _ <- result.try(
          cases.record(
            tx,
            r.id,
            cases.by_staff(a.user.id, a.user.name),
            [
              cases.entry("transaction_handoff_withdrawn", [
                #("handoffId", id.handoff_json(h.id)),
              ]),
            ],
            now,
          )
          |> room_routes.storage,
        )
        store.emit(
          tx,
          effect.Live(live_event.TransactionHandoffWithdrawn(
            org_id: id.org_to_string(r.org_id),
            room_id: id.recruitment_case_to_string(r.id),
            handoff_id: id.handoff_to_string(h.id),
          )),
        )
        use _ <- result.map(
          case h.invited_agent_user_id {
            Some(agent) ->
              notifications.notify(
                tx,
                to: audience.OrgUser,
                id: id.org_user_to_string(agent),
                type_: "representation_transaction",
                text: "A club has withdrawn its invitation to open a transaction workspace. Nothing was opened and nothing was agreed.",
                ref_id: Some(id.handoff_to_string(h.id)),
                at: now,
              )
            None -> Ok(Nil)
          }
          |> room_routes.storage,
        )
        http.json(200, json.object([#("handoff", view(fresh, now))]))
      }
    }
  })
  |> room_routes.answer
}

/// The open invitations addressed to an agent, each only while the agent still represents the player: enough to
/// open a workspace from, and nothing of the club's recruitment thinking.
pub fn for_agent(
  read: Read,
  agent: id.OrgUserId,
  now: Int,
) -> Result(List(#(handoff_row.Row, id.AgreementId, Option(String))), Fail(e)) {
  use rows <- result.try(
    store.query(
      read,
      "SELECT "
        <> handoff_row.qualified("h")
        <> ", o.name FROM case_transaction_handoffs h JOIN recruitment_cases c ON c.id = h.case_id LEFT JOIN orgs o ON o.id = h.org_id WHERE h.invited_agent_user_id = ? ORDER BY c.rowid",
      [id.org_user_sql(agent)],
      {
        use h <- decode.then(handoff_row.decoder())
        use name <- decode.field(
          handoff_row.width,
          decode.optional(decode.string),
        )
        decode.success(#(h, name))
      },
    ),
  )
  list.try_fold(rows, [], fn(out, row) {
    let #(h, club_name) = row
    case effective_status(h, now) {
      "invited" -> {
        // An invitation sent while the relationship was active is not an entitlement after it ends.
        use agreements <- result.map(agent_store.agreements_for_client(
          read,
          id.player_to_string(h.player_id),
        ))
        case
          integration.basis(
            agreements,
            agent,
            id.player_to_string(h.player_id),
            now,
          )
        {
          integration.Basis(Some(ag), _) -> [#(h, ag.row.id, club_name), ..out]
          _ -> out
        }
      }
      _ -> Ok(out)
    }
  })
  |> result.map(list.reverse)
}

/// `GET /org/agent/handoffs`.
pub fn agent_list(ctx: Ctx, a: OrgAccess) -> Response {
  use m <- core_routes.membership(ctx, a)
  use <- core_routes.require(m, "transactions.read")
  let now = clock.now_ms()
  case store.read(ctx.store, for_agent(_, a.user.id, now)) {
    Error(e) -> http.internal(e)
    Ok(found) -> {
      let items =
        list.sort(found, fn(x, y) {
          int.compare({ y.0 }.invited_at, { x.0 }.invited_at)
        })
      http.json(
        200,
        json.object([
          #(
            "items",
            json.array(items, fn(item) {
              let #(h, agreement_id, club_name) = item
              json.object([
                #("handoffId", id.handoff_json(h.id)),
                #("recruitmentCaseId", id.recruitment_case_json(h.case_id)),
                #("clientId", id.player_json(h.player_id)),
                #("agreementId", id.agreement_json(agreement_id)),
                #(
                  "club",
                  json.object([
                    #("id", id.org_json(h.org_id)),
                    #("name", json.nullable(club_name, json.string)),
                  ]),
                ),
                #("invitedAt", json.int(h.invited_at)),
                #("expiresAt", json.int(h.invited_at + ttl_ms)),
              ])
            }),
          ),
          #(
            "note",
            json.string(
              "Clubs that have invited a transaction workspace for one of your clients. Their recruitment case, their assessment and their reasons are not here. Opening a workspace is your action and commits nobody to anything.",
            ),
          ),
        ]),
      )
    }
  }
}
