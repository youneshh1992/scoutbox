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
import scoutbox/platform/metrics
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/recruitment/cases.{type Room}
import scoutbox/recruitment/lifecycle.{type Action}
import scoutbox/recruitment/offer_rules
import scoutbox/recruitment/offers
import scoutbox/recruitment/room_rules.{type RoomRole}
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

/// Is there a record that supports `kind` for this case? From stores the lifecycle does not own and never
/// writes.
///
/// Not ported yet: contacts and trials. No route here records a contact or a Trial, so those kinds have no
/// record to find.
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
    room_rules.ContactDelivered -> Ok(Lacks("no_contact_delivered"))
    room_rules.TrialConfirmed -> Ok(Lacks("no_confirmed_schedule"))
    room_rules.TrialCompletedEvidence -> Ok(Lacks("no_completed_trial"))
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
    // A signing of this player with this club, recorded when the case existed. Not ported yet: a row naming a
    // signing package, which proves only its completed package's case; packages aren't ported, so such a row
    // proves nothing here.
    room_rules.ConfirmedJoin ->
      store.query(
        read,
        "SELECT id FROM signings WHERE org_id = ? AND player_id = ? AND signing_package_id IS NULL AND ts >= ? ORDER BY rowid",
        [
          id.org_sql(r.org_id),
          id.player_sql(r.player_id),
          sqlight.int(r.created_at),
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
  read: Read,
  room: Room,
  action: Action,
  now: Int,
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
                  use verdict <- result.map(evidence(read, room, kind, now))
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
  read: Read,
  room: Room,
  action: Action,
  role: Option(RoomRole),
  reason_codes: List(String),
  now: Int,
  for_availability: Bool,
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
      use to <- result.try(target_for(read, room, action, now))
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
                      use verdict <- result.map(evidence(read, room, kind, now))
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
  read: Read,
  room: Room,
  role: Option(RoomRole),
  now: Int,
) -> Result(List(String), Fail(e)) {
  list.try_fold(lifecycle.actions, [], fn(out, action) {
    use verdict <- result.map(check(read, room, action, role, [], now, True))
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
  now: Int,
) -> Result(#(RoomStatus, RoomStatus), Fail(e)) {
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
  // Not ported yet: the `recruitment_case_moved` live event.
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
