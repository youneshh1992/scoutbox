//// The recruitment lifecycle as semantic actions over one transition table (domains/recruitment/lifecycle/
//// lifecycle.mjs and evidence.mjs): the one validator, the evidence provider it asks, and the one writer
//// (`applyLifecycleTransition`) every domain moves a case through.
////
//// Causation runs one way: record → lifecycle. A target state that records something that happened (a contact
//// delivered, an Offer issued, a signing) needs a durable record behind it, asked of the stores here, never
//// trusted from the request.

import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/platform/clock
import scoutbox/platform/effect
import scoutbox/platform/live_event
import scoutbox/platform/metrics
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/recruitment/cases.{type Room}
import scoutbox/recruitment/contact_rules
import scoutbox/recruitment/contacts
import scoutbox/recruitment/lifecycle.{type Action}
import scoutbox/recruitment/offer_rules
import scoutbox/recruitment/offers
import scoutbox/recruitment/room_rules.{type RoomRole}
import scoutbox/recruitment/trial_rules
import scoutbox/recruitment/trials
import scoutbox/rows/case_history as history_row
import scoutbox/rows/id
import scoutbox/rows/orgs
import scoutbox/vocab/room_status.{type RoomStatus}
import sqlight

// ------------------------------------------------------------------------------------------------- evidence

/// The provider's answer: the record that supports the state, or why there is none.
pub type Evidence {
  Holds(source_type: String, source_id: String)
  Lacks(reason: String)
}

/// What the validator asks whether a record supports a state (the TypeScript evidence provider). The
/// validator itself reads nothing: routes pass `provider`, over the stores; tests pass their own answers.
pub type Provider(e) =
  fn(room_rules.Evidence) -> Result(Evidence, Fail(e))

/// The provider over the stores: `evidence` for this case, at `now`.
pub fn provider(read: Read, room: Room, now: Int) -> Provider(e) {
  fn(kind) { evidence(read, room, kind, now) }
}

/// Is there a record that supports `kind` for this case? From stores the lifecycle does not own and never
/// writes.
///
pub fn evidence(
  read: Read,
  room: Room,
  kind: room_rules.Evidence,
  now: Int,
) -> Result(Evidence, Fail(e)) {
  let r = room.row
  let first = fn(rows, source_type, reason) {
    case rows {
      [found, ..] -> Holds(source_type, found)
      [] -> Lacks(reason)
    }
  }
  case kind {
    // Delivered in-app, answered, or recorded as happening outside ScoutBox, by this organisation to this player.
    // Drafts, failed attempts and corrupt records are not evidence.
    room_rules.ContactDelivered -> {
      use found <- result.map(contacts.for_org_player(
        read,
        r.org_id,
        r.player_id,
      ))
      case
        list.find(found, fn(c) {
          contact_rules.is_evidence(c.row.status)
          && c.row.cancelled_at == None
          && contact_rules.integrity(c, None, None) == []
        })
      {
        Ok(c) -> Holds("recruitment_contact", id.contact_to_string(c.row.id))
        Error(Nil) -> Lacks("no_contact_delivered")
      }
    }
    // `legacy_accepted` never satisfies `trial_confirmed` (no confirmed schedule) and `reported` never satisfies
    // `trial_completed` (a report is not completion). A tombstoned trial still answers, so history stays honest.
    room_rules.TrialConfirmed | room_rules.TrialCompletedEvidence -> {
      use found <- result.map(trials.for_case(read, r.id))
      let own =
        list.filter(found, fn(t) {
          t.row.case_id == Some(r.id)
          && t.row.org_id == r.org_id
          && t.row.player_id == r.player_id
          && trial_rules.integrity(t, Some(r.org_id), Some(r.id)) == []
        })
      let #(holds, reason) = case kind {
        room_rules.TrialConfirmed -> #(
          trial_rules.confirms,
          "no_confirmed_schedule",
        )
        _ -> #(trial_rules.completes, "no_completed_trial")
      }
      case list.find(own, holds) {
        Ok(t) -> Holds("trial", id.trial_to_string(t.row.id))
        Error(Nil) -> Lacks(reason)
      }
    }
    // A delivered `trial` request tied to this case, still pending or accepted.
    room_rules.TrialInvited ->
      store.query(
        read,
        "SELECT id FROM recruitment_requests WHERE case_id = ? AND org_id = ? AND player_id = ? AND type = 'trial' AND status IN ('pending', 'accepted') AND subject_removed_at IS NULL ORDER BY rowid",
        [
          id.recruitment_case_sql(r.id),
          id.org_sql(r.org_id),
          id.player_sql(r.player_id),
        ],
        decode.at([0], decode.string),
      )
      |> result.map(first(_, "trial_request", "no_invitation"))
    // A finalised, current, formal decision to progress. Drafts and advisory recommendations do not count.
    room_rules.DecisionProgress ->
      store.query(
        read,
        "SELECT id FROM room_decisions WHERE room_id = ? AND org_id = ? AND player_id = ? AND kind = 'formal' AND (state IS NULL OR state <> 'draft') AND outcome = 'progress' AND superseded_by_id IS NULL ORDER BY created_at, rowid",
        [
          id.recruitment_case_sql(r.id),
          id.org_sql(r.org_id),
          id.player_sql(r.player_id),
        ],
        decode.at([0], decode.string),
      )
      |> result.map(first(_, "decision", "no_finalized_progress_decision"))
    room_rules.OfferSent
    | room_rules.OfferAcceptedByRecipient
    | room_rules.OfferDeclinedByRecipient -> {
      use found <- result.map(offers.for_case(read, r.id))
      let k = case kind {
        room_rules.OfferSent -> offer_rules.OfferSent
        room_rules.OfferAcceptedByRecipient -> offer_rules.AcceptedByRecipient
        _ -> offer_rules.DeclinedByRecipient
      }
      case offer_rules.evidence(found, r.org_id, r.id, r.player_id, k, now) {
        offer_rules.Satisfied(o, _) ->
          Holds("recruitment_offer", id.offer_to_string(o))
        offer_rules.Unsatisfied(reason) -> Lacks(reason)
      }
    }
    // A signing of this player with this club (signingSupports): a row with no package, recorded when the case
    // existed; or a row naming a package, which proves the joining only when that package completed with it, for
    // this club and player, on this case.
    room_rules.ConfirmedJoin ->
      store.query(
        read,
        "SELECT s.id FROM signings s LEFT JOIN signing_packages p ON p.id = s.signing_package_id WHERE s.org_id = ? AND s.player_id = ? AND ((s.signing_package_id IS NULL AND s.ts >= ?) OR (p.status = 'COMPLETED' AND p.completion_signing_id = s.id AND p.org_id = s.org_id AND p.player_id = s.player_id AND p.case_id = ?)) ORDER BY s.rowid",
        [
          id.org_sql(r.org_id),
          id.player_sql(r.player_id),
          sqlight.int(r.created_at),
          id.recruitment_case_sql(r.id),
        ],
        decode.at([0], decode.string),
      )
      |> result.map(first(_, "signing", "no_confirmed_join"))
  }
}

// ------------------------------------------------------------------------------------------------ validator

pub fn action_named(name: String) -> Option(Action) {
  list.find(lifecycle.actions, fn(a) { a.name == name }) |> option.from_result
}

pub fn target(action: Action) -> RoomStatus {
  let assert Ok(to) = room_status.from_string(action.to)
    as "a lifecycle action names a Room status"
  to
}

fn rank(r: lifecycle.RoomRole) -> Int {
  case r {
    lifecycle.Contributor -> 1
    lifecycle.RoomLead -> 2
    lifecycle.RecruitmentAdmin -> 3
  }
}

/// May this role perform this action at all, wherever the case is?
pub fn permitted(action: Action, role: Option(RoomRole)) -> Bool {
  case role {
    None -> False
    Some(role) ->
      list.any(action.roles, fn(r) { room_rules.role_rank(role) >= rank(r) })
  }
}

/// Narrows which edges an action may describe: three actions land on `under_review`, and without this each
/// would be offered from a withdrawn case, writing a different reason into the history.
fn applicable_from(action: Action, from: RoomStatus) -> Bool {
  case action.name {
    "startReview" ->
      !list.contains(room_rules.terminal, from) && from != room_status.OnHold
    "resumeCase" -> from == room_status.OnHold
    "reopenCase" -> list.contains(room_rules.reopened_from, from)
    _ -> True
  }
}

/// The state a held case was held from, per the newest `on_hold` history entry.
pub fn held_from(room: Room) -> Option(RoomStatus) {
  room.history
  |> list.reverse
  |> list.find_map(fn(h) {
    case h.action == "room_status_changed", h.detail_json {
      True, Some(detail) ->
        case
          json.parse(detail, {
            use to <- decode.field("to", decode.string)
            use from <- decode.optional_field(
              "from",
              None,
              decode.optional(decode.string),
            )
            decode.success(#(to, from))
          })
        {
          Ok(#("on_hold", from)) -> Ok(from)
          _ -> Error(Nil)
        }
      _, _ -> Error(Nil)
    }
  })
  |> option.from_result
  |> option.flatten
  |> option.then(fn(s) { room_status.from_string(s) |> option.from_result })
}

/// Where an action takes this case: static for every action but `resumeCase`, which returns to the held-from
/// state when it is live and its evidence still stands (asked of the provider, not trusted from history).
pub fn target_for(
  room: Room,
  action: Action,
  evidence: Provider(e),
) -> Result(RoomStatus, Fail(e)) {
  case action.name {
    "resumeCase" ->
      case held_from(room) {
        Some(from) ->
          case
            from == room_status.OnHold
            || list.contains(room_rules.terminal, from)
          {
            True -> Ok(room_status.UnderReview)
            False ->
              case room_rules.evidence_required(from) {
                None -> Ok(from)
                Some(kind) -> {
                  use verdict <- result.map(evidence(kind))
                  case verdict {
                    Holds(..) -> from
                    Lacks(..) -> room_status.UnderReview
                  }
                }
              }
          }
        None -> Ok(room_status.UnderReview)
      }
    _ -> Ok(target(action))
  }
}

/// A move the validator agreed to.
pub type Allowed {
  Allowed(from: RoomStatus, to: RoomStatus, reason: String)
}

/// A refusal: its code, message and public fields.
pub type Refusal {
  Refusal(error: String, message: String, fields: List(#(String, Json)))
}

/// A verdict as canTransitionRecruitmentCase returns it: `{ok, to, from, reason}`, or `{ok, error, message}` and
/// the refusal's public fields.
pub fn verdict_json(verdict: Result(Allowed, Refusal)) -> Json {
  case verdict {
    Ok(Allowed(from:, to:, reason:)) ->
      json.object([
        #("ok", json.bool(True)),
        #("to", room_status.to_json(to)),
        #("from", room_status.to_json(from)),
        #("reason", json.string(reason)),
      ])
    Error(Refusal(error:, message:, fields:)) ->
      json.object([
        #("ok", json.bool(False)),
        #("error", json.string(error)),
        #("message", json.string(message)),
        ..fields
      ])
  }
}

fn allowed_json(from: RoomStatus) -> #(String, Json) {
  #("allowed", json.array(room_rules.transitions(from), room_status.to_json))
}

/// The reason code an action writes into the history.
pub fn reason_of(action: Action) -> String {
  case action.name {
    "startReview" | "shortlist" | "prioritise" | "considerOffer" ->
      "club_decision"
    "planContact" -> "contact_planned"
    "recordContact" -> "contact_made"
    "planTrial" | "confirmTrial" -> "trial_progression"
    "completeTrial" -> "trial_completed"
    "sendOffer" -> "offer_progression"
    "recordOfferAccepted" -> "offer_accepted_in_scoutbox"
    "recordOfferDeclined" -> "player_declined"
    "confirmSignedOutcome" -> "signed_outcome"
    "holdCase" -> "on_hold"
    "resumeCase" -> "hold_resumed"
    "rejectCase" -> "rejected"
    "withdrawCase" -> "withdrawn"
    "closeCase" -> "case_closed"
    _ -> "case_reopened"
  }
}

/// The one validator (canTransitionRecruitmentCase), used by routes and the journey's next-action list.
/// `for_availability` asks "could this be taken, given a reason?": a reason is supplied when the action is
/// performed, not when it is offered.
pub fn check(
  room: Room,
  action: Action,
  role: Option(RoomRole),
  reason_codes: List(String),
  for_availability: Bool,
  evidence: Provider(e),
) -> Result(Result(Allowed, Refusal), Fail(e)) {
  let from = room.status
  case permitted(action, role) {
    False ->
      Ok(
        Error(
          Refusal(
            "LIFECYCLE_NOT_PERMITTED",
            "Your role cannot take this recruitment action.",
            [],
          ),
        ),
      )
    True -> {
      use to <- result.try(target_for(room, action, evidence))
      let resume = action.name == "resumeCase"
      let own_edge = resume && !list.contains(room_rules.terminal, to)
      case from == to, room_rules.can_transition(from, to) || own_edge {
        True, _ ->
          Ok(
            Error(
              Refusal(
                "LIFECYCLE_NO_CHANGE",
                "The case is already in that state.",
                [allowed_json(from)],
              ),
            ),
          )
        False, False ->
          Ok(
            Error(
              Refusal(
                "LIFECYCLE_TRANSITION_INVALID",
                "A case at \""
                  <> room_status.to_string(from)
                  <> "\" cannot move to \""
                  <> room_status.to_string(to)
                  <> "\".",
                [allowed_json(from)],
              ),
            ),
          )
        False, True ->
          case applicable_from(action, from) {
            False ->
              Ok(
                Error(
                  Refusal(
                    "LIFECYCLE_ACTION_NOT_APPLICABLE",
                    "\""
                      <> action.name
                      <> "\" does not describe what happens to a case at \""
                      <> room_status.to_string(from)
                      <> "\".",
                    [allowed_json(from)],
                  ),
                ),
              )
            True ->
              case
                action.reasons_required
                && !for_availability
                && reason_codes == []
              {
                True ->
                  Ok(
                    Error(
                      Refusal(
                        "LIFECYCLE_REASON_REQUIRED",
                        "Ending a recruitment case requires a recorded reason.",
                        [],
                      ),
                    ),
                  )
                False ->
                  case room_rules.evidence_required(to) {
                    None -> Ok(Ok(Allowed(from, to, reason_of(action))))
                    Some(kind) -> {
                      use verdict <- result.map(evidence(kind))
                      case verdict {
                        Holds(..) -> Ok(Allowed(from, to, reason_of(action)))
                        Lacks(why) ->
                          Error(
                            Refusal(
                              "LIFECYCLE_EVIDENCE_REQUIRED",
                              "This step needs a record to support it: "
                                <> evidence_note(kind)
                                <> ".",
                              [
                                #(
                                  "requires",
                                  json.string(room_rules.evidence_code(kind)),
                                ),
                                #("evidenceReason", json.string(why)),
                              ],
                            ),
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

/// STATUS_EVIDENCE_REQUIRED's notes.
fn evidence_note(kind: room_rules.Evidence) -> String {
  case kind {
    room_rules.ContactDelivered ->
      "a contact must have been delivered or recorded"
    room_rules.TrialInvited ->
      "a trial invitation must have been sent to the player or their guardian"
    room_rules.TrialConfirmed ->
      "a trial schedule must have been confirmed with at least one concrete session"
    room_rules.TrialCompletedEvidence -> "a trial must have been completed"
    room_rules.DecisionProgress ->
      "a finalized recruitment decision to progress must exist for this case"
    room_rules.OfferSent -> "an offer must have been sent"
    room_rules.OfferAcceptedByRecipient ->
      "the recipient must have accepted their own offer"
    room_rules.OfferDeclinedByRecipient ->
      "the recipient must have declined their own offer"
    room_rules.ConfirmedJoin ->
      "a confirmed joining or registration record must exist"
  }
}

/// Which actions are available right now, for this role.
pub fn available(
  room: Room,
  role: Option(RoomRole),
  evidence: Provider(e),
) -> Result(List(String), Fail(e)) {
  list.try_fold(lifecycle.actions, [], fn(out, action) {
    use verdict <- result.map(check(room, action, role, [], True, evidence))
    case verdict {
      Ok(_) -> [action.name, ..out]
      Error(_) -> out
    }
  })
  |> result.map(list.reverse)
}

// --------------------------------------------------------------------------------------------------- writer

/// Who moved the case: a club member, or the recipient whose act moved it (a player accepting an Offer).
pub type Mover {
  StaffMover(user_id: id.OrgUserId, name: String)
  RecipientMover(kind: history_row.ByKind, id: String, name: Option(String))
}

fn mover_by(m: Mover) -> cases.By {
  case m {
    StaffMover(user, name) -> cases.by_staff(user, name)
    RecipientMover(kind, who, name) -> cases.By(kind, Some(who), name)
  }
}

/// The lifecycle write seam. The caller has already validated the transition; the status and its history entry
/// are written together.
pub fn apply(
  tx: Tx,
  room: Room,
  level: orgs.Level,
  to: RoomStatus,
  reason_codes: List(String),
  trigger: String,
  mover: Mover,
  detail: List(#(String, Json)),
) -> Result(#(RoomStatus, RoomStatus), Fail(e)) {
  // The move and its history entry carry the server's own time, never a request's pinned test clock, as in the
  // TypeScript writer: a case's moves stay in the order they were made, whatever instant each act was judged at.
  let now = clock.now_ms()
  let from = room.status
  let reopens =
    list.contains(room_rules.reopened_from, from) && room_rules.is_open(to)
  let by = mover_by(mover)
  // The lifecycle's resume is its own edge out of on_hold, beside the transition table.
  let resume =
    from == room_status.OnHold && !room_rules.can_transition(from, to)
  use _ <- result.try(cases.move(
    tx,
    room.row.id,
    level,
    cases.Move(
      to:,
      at: now,
      by_id: by.id,
      by_name: by.name,
      resume:,
      reopened: case reopens {
        True ->
          Some(cases.Reopened(
            by_id: by.id,
            by_name: by.name,
            from:,
            reason_codes:,
            source_context: None,
            source_ref: None,
          ))
        False -> None
      },
      source_context: None,
    ),
  ))
  // Development-only fault seam: the unit is refused whole, so nothing from the status write survives.
  use _ <- result.try(store.seam(tx, "lifecycle.after_status"))
  let codes = json.array(reason_codes, json.string)
  use _ <- result.try(cases.record(
    tx,
    room.row.id,
    by,
    list.flatten([
      case reopens {
        True -> [
          cases.entry("room_reopened", [
            #("from", room_status.to_json(from)),
            #("to", room_status.to_json(to)),
            #("reasonCodes", codes),
          ]),
        ]
        False -> []
      },
      [
        cases.entry("room_status_changed", [
          #("from", room_status.to_json(from)),
          #("to", room_status.to_json(to)),
          #("reasonCodes", codes),
          #("trigger", json.string(trigger)),
          ..detail
        ]),
      ],
    ]),
    now,
  ))
  use _ <- result.try(case reopens {
    True -> metrics.count(tx, "rooms", "recruitment_room_reopened")
    False -> Ok(Nil)
  })
  store.emit(tx, moved_event(room.row.org_id, room.row.id, from, to))
  use _ <- result.map(metrics.count(
    tx,
    "rooms",
    "recruitment_room_status_changed",
  ))
  #(from, to)
}

/// The detail every lifecycle move records beside its trigger, so a replay can find it.
pub fn status_detail(
  action: String,
  client_key: Option(String),
  extra: List(#(String, Json)),
) -> List(#(String, Json)) {
  [
    #("lifecycleAction", json.string(action)),
    #("clientKey", json.nullable(client_key, json.string)),
    #("policyVersion", json.int(lifecycle.policy_version)),
    ..extra
  ]
}

// ------------------------------------------------------------------------------------------------ advance

/// What the case did with an act's step (the Offer and signing acts' `advanceCase`): moved, already there, or
/// refused with the lifecycle's reason. `to` is None when it did not move.
pub type Advanced {
  Advanced(
    applied: Bool,
    action: String,
    from: String,
    to: Option(String),
    at: Int,
    reason: Option(String),
    message: Option(String),
    allowed: Option(List(String)),
  )
}

/// The step as the acts answer it, in the TypeScript server's key order for each outcome.
pub fn advanced_json(a: Advanced) -> Json {
  case a.applied, a.message {
    True, _ ->
      json.object([
        #("applied", json.bool(True)),
        #("action", json.string(a.action)),
        #("from", json.string(a.from)),
        #("to", json.nullable(a.to, json.string)),
        #("at", json.int(a.at)),
      ])
    False, None ->
      json.object([
        #("applied", json.bool(False)),
        #("action", json.string(a.action)),
        #("reason", json.nullable(a.reason, json.string)),
        #("from", json.string(a.from)),
        #("to", json.nullable(a.to, json.string)),
        #("at", json.int(a.at)),
      ])
    False, Some(message) ->
      json.object([
        #("applied", json.bool(False)),
        #("action", json.string(a.action)),
        #("reason", json.nullable(a.reason, json.string)),
        #("message", json.string(message)),
        #("allowed", json.array(option.unwrap(a.allowed, []), json.string)),
        #("from", json.string(a.from)),
        #("to", json.null()),
        #("at", json.int(a.at)),
      ])
  }
}

/// Validates with the real evidence provider, then writes through the lifecycle writer. A refusal is returned,
/// not raised: the caller decides whether it rolls the act back.
pub fn advance(
  tx: Tx,
  room: Room,
  level: orgs.Level,
  action_name: String,
  role: Option(RoomRole),
  mover: Mover,
  trigger: String,
  key_detail: List(#(String, Json)),
  at: Int,
) -> Result(Advanced, Fail(e)) {
  let assert Some(action) = action_named(action_name)
    as "an act names a lifecycle action"
  let from = room_status.to_string(room.status)
  use verdict <- result.try(check(
    room,
    action,
    role,
    [],
    False,
    provider(store.reading(tx), room, at),
  ))
  case verdict {
    Ok(allowed) -> {
      use moved <- result.map(apply(
        tx,
        room,
        level,
        allowed.to,
        [],
        trigger,
        mover,
        status_detail(action_name, None, key_detail),
      ))
      Advanced(
        True,
        action_name,
        room_status.to_string(moved.0),
        Some(room_status.to_string(moved.1)),
        at,
        None,
        None,
        None,
      )
    }
    Error(r) if r.error == "LIFECYCLE_NO_CHANGE" ->
      Ok(Advanced(
        False,
        action_name,
        from,
        Some(from),
        at,
        Some("already_there"),
        None,
        None,
      ))
    Error(r) -> {
      let allowed =
        list.key_find(r.fields, "allowed")
        |> result.map(fn(_) {
          room_rules.transitions(room.status) |> list.map(room_status.to_string)
        })
        |> result.unwrap([])
      Ok(Advanced(
        False,
        action_name,
        from,
        None,
        at,
        Some(r.error),
        Some(r.message),
        Some(allowed),
      ))
    }
  }
}

/// The `recruitment_case_moved` live event.
pub fn moved_event(
  org_id: id.OrgId,
  room_id: id.RecruitmentCaseId,
  from: RoomStatus,
  to: RoomStatus,
) -> effect.Effect {
  effect.Live(live_event.RecruitmentCaseMoved(
    org_id: id.org_to_string(org_id),
    room_id: id.recruitment_case_to_string(room_id),
    from: room_status.to_string(from),
    to: room_status.to_string(to),
  ))
}

/// The `recruitment_room_archived` live event: the Second Look contract.
pub fn archived_event(
  org_id: id.OrgId,
  room_id: id.RecruitmentCaseId,
) -> effect.Effect {
  effect.Live(live_event.RecruitmentRoomArchived(
    org_id: id.org_to_string(org_id),
    room_id: id.recruitment_case_to_string(room_id),
  ))
}
