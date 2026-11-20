//// Trial routes (domains/recruitment/lifecycle/trialRoutes.mjs): the club side of the workflow, and the
//// recipient's confirmation, decline or cancellation of it.
////
//// There is no acceptance route here. The recipient accepts through the existing respond route, which calls
//// `accept_gate` before the answer and `accepted` in the answer's unit (the trial is born there, and the case
//// advances in the same unit). Every recipient is re-derived from the live player, organisation, guardian records
//// and clock, never trusted from a client.
////
//// An invitation is not a trial; an acceptance is not a schedule; a schedule is not attendance; attendance is not
//// completion; completion is not an assessment; an assessment is not a decision.
////
//// A linked Box Cam session's observation is its latest recorded CV result, read live (Box Cam's analysis records
//// it; it is moving to a service of its own).
////
//// Not ported yet: Box Cam's test provider (`BOX_CAM_TEST_PROVIDER`): a `local_test` session is never citable here.

import gleam/dict
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/int
import gleam/io
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/development/combine
import scoutbox/identity/access.{type OrgAccess, type PlayerAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/orgs as org_store
import scoutbox/identity/players
import scoutbox/messaging/delivery
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
import scoutbox/platform/zones.{type Zone}
import scoutbox/recruitment/case_lifecycle
import scoutbox/recruitment/cases.{type Room}
import scoutbox/recruitment/domain_errors
import scoutbox/recruitment/recipients.{type Recipient}
import scoutbox/recruitment/requests.{type Request as Invitation}
import scoutbox/recruitment/room_routes
import scoutbox/recruitment/room_rules
import scoutbox/recruitment/room_view
import scoutbox/recruitment/trial_rules.{
  type Planned, type Session, type Trial, type ValidSession, type VenueInput,
  SessionInput, VenueInput,
}
import scoutbox/recruitment/trials
import scoutbox/rows/assessments as assessment_row
import scoutbox/rows/box_cam_cv_results as cv_row
import scoutbox/rows/box_sessions as box_row
import scoutbox/rows/case_history as history_row
import scoutbox/rows/delivery_fail_injections as injection_row
import scoutbox/rows/id
import scoutbox/rows/ledger as ledger_row
import scoutbox/rows/orgs
import scoutbox/rows/recruitment_requests as request_row
import scoutbox/rows/request_trial_slots as slot_row
import scoutbox/rows/trial_attendance as attendance_row
import scoutbox/rows/trial_keys as key_row
import scoutbox/rows/trials as trial_row
import scoutbox/safety/audit
import scoutbox/safety/ledger
import scoutbox/safety/moderate
import scoutbox/vocab/audience
import scoutbox/vocab/box_provider
import scoutbox/vocab/party
import scoutbox/vocab/room_status.{type RoomStatus}
import scoutbox/vocab/trial_workflow_state
import sqlight
import wisp.{type Request, type Response}

// --------------------------------------------------------------------------------------------------- helpers

fn err(
  code: String,
  message: String,
  fields: List(#(String, Json)),
) -> Response {
  domain_errors.refuse(domain_errors.lifecycle, code, message, fields)
}

fn fail(r: trial_rules.Refusal) -> Response {
  err(r.error, r.message, r.fields)
}

fn read(ctx: Ctx, f: fn(Read) -> Result(a, Fail(e))) -> Result(a, Response) {
  store.read(ctx.store, f) |> result.map_error(http.internal)
}

fn with_read(
  ctx: Ctx,
  f: fn(Read) -> Result(a, Fail(e)),
  next: fn(a) -> Response,
) -> Response {
  case read(ctx, f) {
    Ok(a) -> next(a)
    Error(response) -> response
  }
}

fn storage(r: Result(a, Fail(e))) -> Result(a, Fail(Response)) {
  room_routes.storage(r)
}

fn rate_limited(action: limits.Action) -> Response {
  http.json(
    429,
    json.object(
      list.map(limits.limited_body(action), fn(p) { #(p.0, json.string(p.1)) }),
    ),
  )
}

/// A re-run after a lost race was charged on its first run.
fn limited(
  ctx: Ctx,
  req: Request,
  action: limits.Action,
  owner: String,
  next: fn() -> Response,
) -> Response {
  case
    !http.rerun(req)
    && limits.limited(ctx.limits, action, owner, clock.now_ms())
  {
    True -> rate_limited(action)
    False -> next()
  }
}

const codes = [
  #("expectedRev", "TRIAL_REV_REQUIRED"),
  #("expectedVersion", "TRIAL_REV_REQUIRED"),
  #("timezone", "TRIAL_TIMEZONE_INVALID"),
  #("venue.*", "TRIAL_VENUE_INVALID"),
  #("slots.*", "TRIAL_SLOTS_INVALID"),
  #("sessions.*", "TRIAL_SCHEDULE_INVALID"),
  #("sessions.venue.*", "TRIAL_VENUE_INVALID"),
  #("state", "TRIAL_ATTENDANCE_INVALID"),
  #("note", "TRIAL_ATTENDANCE_INVALID"),
  #("boxSessionId", "TRIAL_EVIDENCE_REF_INVALID"),
]

/// The request body read with its shape, or the refusal (TRIAL_CONTENT_INVALID unless a field names its own).
fn body(
  req: Request,
  shape: input.Shape(a),
  next: fn(a, Dynamic) -> Response,
) -> Response {
  use raw <- http.json_body(req)
  case
    input.parse_coded(
      shape,
      raw,
      root: "body",
      codes:,
      default: "TRIAL_CONTENT_INVALID",
    )
  {
    Error(r) ->
      domain_errors.send(
        domain_errors.lifecycle,
        r.error,
        input.refusal_fields(r),
      )
    Ok(v) -> next(v, raw)
  }
}

fn client_key(
  raw: Option(Dynamic),
  next: fn(Option(String)) -> Response,
) -> Response {
  case idempotency.client_key(raw) {
    Ok(k) -> next(k)
    Error(m) -> err("TRIAL_CLIENT_KEY_INVALID", m, [])
  }
}

const words_max = 1_000_000

fn words() -> input.Rule(Option(String)) {
  input.nullish(input.text(words_max))
}

fn rev_fields(next: fn() -> input.Shape(a)) -> input.Shape(a) {
  rev.fields(next)
}

fn venue_shape() -> input.Shape(VenueInput) {
  use name <- input.field("name", words())
  use town <- input.field("town", words())
  use address <- input.field("address", words())
  input.done(VenueInput(name:, town:, address:))
}

fn state_json(t: Trial) -> List(#(String, Json)) {
  [
    #(
      "current",
      json.object([
        #(
          "workflowState",
          trial_workflow_state.to_json(trial_rules.workflow_state(t)),
        ),
      ]),
    ),
  ]
}

fn now_of(ctx: Ctx, req: Request) -> Int {
  clock.request_ms(ctx.config, req)
}

fn staff(a: OrgAccess) -> trials.Actor {
  trials.Staff(a.user.id, a.user.name)
}

fn acted(
  a: OrgAccess,
  at: Int,
  history: List(trials.Entry),
  key: Option(#(key_row.Act, String, String)),
) -> trials.Acted {
  trials.Acted(at:, rev_by: Some(#(a.user.id, a.user.name)), history:, key:)
}

fn key_of(
  act: key_row.Act,
  key: Option(String),
  fp: String,
) -> Option(#(key_row.Act, String, String)) {
  option.map(key, fn(k) { #(act, k, fp) })
}

type KeyCheck {
  Fresh
  Replay
  Conflict
}

/// Per act, bounded, with a payload fingerprint.
fn key_check(
  t: Trial,
  act: key_row.Act,
  key: Option(String),
  fp: String,
) -> KeyCheck {
  case key {
    None -> Fresh
    Some(k) ->
      case list.find(t.keys, fn(x) { x.act == act && x.key == k }) {
        Error(Nil) -> Fresh
        Ok(prior) if prior.fp == fp -> Replay
        Ok(_) -> Conflict
      }
  }
}

fn fingerprint(fields: List(#(String, canonical.Value))) -> String {
  canonical.to_string(canonical.Object(fields))
}

fn log_integrity(t: Trial, problems: List(String)) -> Nil {
  io.println_error(
    "TRIAL integrity "
    <> id.trial_to_string(t.row.id)
    <> ": "
    <> string.join(problems, ","),
  )
}

// ---------------------------------------------------------------------------------------------------- lookups

/// The statuses a case may request a trial from: every in-edge of `trial_requested`, and itself (a second
/// invitation after a decline).
pub fn case_statuses() -> List(RoomStatus) {
  list.filter(list.map(room_status.pairs, fn(p) { p.1 }), fn(s) {
    list.contains(room_rules.transitions(s), room_status.TrialRequested)
  })
  |> list.append([room_status.TrialRequested])
}

fn refused_permission(need: trial_rules.Need) -> Response {
  err(
    "TRIAL_NOT_PERMITTED",
    case need {
      trial_rules.TrialWrite ->
        "Only a room lead or recruitment lead can invite, schedule, cancel, record attendance, complete or link evidence for a trial."
      trial_rules.TrialAssess -> "Your role cannot assess in this room."
      trial_rules.TrialView -> "Your role cannot read trials in this room."
    },
    [],
  )
}

/// A Room of this organisation the member may act on for `need`.
fn room_for(
  ctx: Ctx,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
  need: trial_rules.Need,
  next: fn(Room, Option(room_rules.RoomRole)) -> Response,
) -> Response {
  use room <- room_routes.with_room(ctx, a, room_id)
  let role = room_view.role(a, room)
  case trial_rules.role_allows(role, need) {
    True -> next(room, role)
    False -> refused_permission(need)
  }
}

/// This case's trials plus this organisation's legacy trials for the player (read-only), corrupt rows omitted,
/// named in the log and counted.
pub fn trials_of(
  read: Read,
  room: Room,
) -> Result(#(List(Trial), Int), Fail(e)) {
  use all <- result.map(trials.for_org_player(
    read,
    room.row.org_id,
    room.row.player_id,
  ))
  let #(good, omitted) =
    list.fold(all, #([], 0), fn(acc, t) {
      let #(good, omitted) = acc
      case t.row.case_id {
        Some(c) if c != room.row.id -> acc
        _ -> {
          let problems =
            trial_rules.integrity(
              t,
              Some(room.row.org_id),
              option.map(t.row.case_id, fn(_) { room.row.id }),
            )
          case problems {
            [] -> #([t, ..good], omitted)
            _ -> {
              log_integrity(t, problems)
              #(good, omitted + 1)
            }
          }
        }
      }
    })
  #(
    list.sort(good, fn(a, b) {
      case int.compare(a.row.accepted_at, b.row.accepted_at) {
        order.Eq ->
          string.compare(
            id.trial_to_string(a.row.id),
            id.trial_to_string(b.row.id),
          )
        other -> other
      }
    }),
    omitted,
  )
}

type Found {
  Missing
  Unreadable
  FoundTrial(Trial)
}

fn find_trial(read: Read, room: Room, tid: String) -> Result(Found, Fail(e)) {
  use found <- result.map(trials.by_id(read, id.trial(tid)))
  case found {
    Some(t)
      if t.row.org_id == room.row.org_id && t.row.player_id == room.row.player_id
    ->
      case t.row.case_id {
        Some(c) if c != room.row.id -> Missing
        _ ->
          case
            trial_rules.integrity(
              t,
              Some(room.row.org_id),
              option.map(t.row.case_id, fn(_) { room.row.id }),
            )
          {
            [] -> FoundTrial(t)
            problems -> {
              log_integrity(t, problems)
              Unreadable
            }
          }
      }
    _ -> Missing
  }
}

fn with_trial(
  ctx: Ctx,
  room: Room,
  tid: String,
  next: fn(Trial) -> Response,
) -> Response {
  use found <- with_read(ctx, find_trial(_, room, tid))
  case found {
    Missing -> err("TRIAL_NOT_FOUND", "No such trial.", [])
    Unreadable -> err("TRIAL_STATE_UNKNOWN", "This trial cannot be read.", [])
    FoundTrial(t) -> next(t)
  }
}

fn find_session(t: Trial, sid: String) -> Option(Session) {
  list.find(t.sessions, fn(s) { id.trial_session_to_string(s.row.id) == sid })
  |> option.from_result
}

fn with_session(
  t: Trial,
  sid: String,
  next: fn(Session) -> Response,
) -> Response {
  case find_session(t, sid) {
    Some(s) -> next(s)
    None -> err("TRIAL_SESSION_NOT_FOUND", "No such session on this trial.", [])
  }
}

/// The recipient rule in Trial vocabulary, computed now and never trusted from a client.
fn recipient_for(
  read: Read,
  org: orgs.Row,
  player_id: id.PlayerId,
) -> Result(Result(Recipient, trial_rules.Refusal), Fail(e)) {
  use r <- result.map(recipients.resolve(read, player_id, org, clock.now_ms()))
  case r {
    Ok(rec) -> Ok(rec)
    Error(recipients.Blocked) ->
      Error(
        trial_rules.Refusal(
          "TRIAL_BLOCKED",
          "This player (or their guardian) has blocked your organisation.",
          [],
        ),
      )
    Error(recipients.GuardianRequired) ->
      Error(
        trial_rules.Refusal(
          "TRIAL_GUARDIAN_REQUIRED",
          "This player is under the age of majority and no valid guardian route exists. The trial cannot proceed.",
          [],
        ),
      )
    Error(recipients.Unavailable(m)) ->
      Error(trial_rules.Refusal("TRIAL_RECIPIENT_UNAVAILABLE", m, []))
  }
}

fn routing_view(r: Result(Recipient, trial_rules.Refusal)) -> Json {
  case r {
    Ok(rec) ->
      json.object([
        #("available", json.bool(True)),
        #("type", party.to_json(rec.kind)),
        #("minor", json.bool(rec.minor)),
      ])
    Error(refusal) ->
      json.object([
        #("available", json.bool(False)),
        #("type", json.null()),
        #("minor", json.null()),
        #("reason", json.string(refusal.error)),
      ])
  }
}

/// Re-authorisation on every club act, after the role check: the subject removed, the block policy, the
/// recipient for acts that reach them, then the trial's state.
fn reauth(
  ctx: Ctx,
  a: OrgAccess,
  room: Room,
  t: Option(Trial),
  act: Option(trial_rules.Act),
  next: fn(Option(Recipient)) -> Response,
) -> Response {
  let removed = case t {
    Some(t) -> t.row.subject_removed_at != None
    None -> False
  }
  use <- bool_guard(removed, fn() {
    err(
      "TRIAL_SUBJECT_REMOVED",
      "This player removed their ScoutBox account. The trial stays on record; it can no longer be changed.",
      [],
    )
  })
  use blocked <- with_read(ctx, audit.is_blocked(
    _,
    room.row.player_id,
    room.row.org_id,
  ))
  use <- bool_guard(blocked && !trial_rules.blocked_allows(act), fn() {
    err(
      "TRIAL_BLOCKED",
      "This player (or their guardian) has blocked your organisation. You may cancel the trial; nothing else.",
      [],
    )
  })
  let needs_recipient = case act {
    None
    | Some(trial_rules.ScheduleAct)
    | Some(trial_rules.RescheduleAct)
    | Some(trial_rules.LinkAct) -> True
    _ -> False
  }
  let state_check = fn(recipient) {
    case t, act {
      Some(t), Some(act) ->
        case trial_rules.state_allows(t, act) {
          True -> next(recipient)
          False -> {
            let state = trial_rules.workflow_state(t)
            err(
              "TRIAL_INVALID_STATE",
              "A trial that is "
                <> string.replace(
                trial_workflow_state.to_string(state),
                "_",
                " ",
              )
                <> " cannot take this action.",
              state_json(t),
            )
          }
        }
      _, _ -> next(recipient)
    }
  }
  case needs_recipient {
    False -> state_check(None)
    True -> {
      use r <- with_read(ctx, recipient_for(_, a.org, room.row.player_id))
      case r {
        Error(refusal) -> fail(refusal)
        Ok(rec) -> state_check(Some(rec))
      }
    }
  }
}

fn bool_guard_unit(
  raced: Bool,
  what: String,
  next: fn() -> Result(a, Fail(e)),
) -> Result(a, Fail(e)) {
  case raced {
    True -> store.stale(what)
    False -> next()
  }
}

fn bool_guard(bad: Bool, refusal: fn() -> Response, next: fn() -> Response) {
  case bad {
    True -> refusal()
    False -> next()
  }
}

/// Required on an act on an existing trial: absent is refused, never coerced. A rev is a JSON integer, never "3",
/// 3.5 or -1.
fn rev_gate(raw: Dynamic, t: Trial, next: fn() -> Response) -> Response {
  case named_rev(raw) {
    None ->
      err(
        "TRIAL_REV_REQUIRED",
        "expectedRev is required: send the rev you were looking at.",
        [],
      )
    Some(v) -> rev_value(v, t, next)
  }
}

fn named_rev(raw: Dynamic) -> Option(Dynamic) {
  let named = fn(key) {
    case decode.run(raw, decode.at([key], decode.dynamic)) {
      Ok(v) ->
        case dynamic.classify(v) {
          "Nil" -> None
          _ -> Some(v)
        }
      Error(_) -> None
    }
  }
  option.or(named("expectedRev"), named("expectedVersion"))
}

fn rev_value(v: Dynamic, t: Trial, next: fn() -> Response) -> Response {
  case decode.run(v, decode.int) {
    Ok(n) if n >= 0 ->
      rev.guard(
        rev.Expected(n),
        rev.Rev(t.row.rev, t.row.rev_at, t.row.rev_by_name),
        "TRIAL_VERSION_CONFLICT",
        [
          #(
            "workflowState",
            trial_workflow_state.to_json(trial_rules.workflow_state(t)),
          ),
        ],
        next,
      )
    _ ->
      err("TRIAL_REV_REQUIRED", "expectedRev must be a non-negative integer.", [
        #("field", json.string("expectedRev")),
        #("expected", json.string("integer")),
      ])
  }
}

/// Inside a unit: the trial is still at the rev the route read it at, or the act lost a race.
fn unchanged(tx: Tx, t: Trial) -> Result(Nil, Fail(e)) {
  use found <- result.try(store.one(
    store.reading(tx),
    "SELECT rev FROM trials WHERE id = ?",
    [id.trial_sql(t.row.id)],
    decode.at([0], decode.int),
  ))
  case found {
    Ok(rev) if rev == t.row.rev -> Ok(Nil)
    _ -> store.stale("the trial moved from rev " <> int.to_string(t.row.rev))
  }
}

fn transport_failed(
  ctx: Ctx,
  message: String,
  next: fn() -> Response,
) -> Response {
  case
    store.unit(ctx.store, delivery.consume_injected(_, injection_row.Trial))
  {
    Ok(True) -> err("TRIAL_TRANSPORT_REFUSED", message, [])
    _ -> next()
  }
}

// ------------------------------------------------------------------------------------------- the case moves

/// What the case's lifecycle did with a trial act.
pub type Moved {
  MovedCase(from: RoomStatus, to: RoomStatus, at: Int)
  NotMoved(reason: String, at: Int)
}

fn lifecycle_of(m: Moved) -> trials.Lifecycle {
  case m {
    MovedCase(from, to, at) ->
      trials.Applied(room_status.to_string(from), room_status.to_string(to), at)
    NotMoved(reason, at) -> trials.NotApplied(reason, at)
  }
}

/// The Trial writes no case status: it asks the validator (whose evidence provider now sees this request or trial)
/// and writes through the lifecycle writer. A recipient-driven advance names the recipient as the mover.
fn advance(
  tx: Tx,
  room: Room,
  level: orgs.Level,
  action_name: String,
  role: Option(room_rules.RoomRole),
  mover: case_lifecycle.Mover,
  trigger: String,
  key_detail: List(#(String, Json)),
  at: Int,
) -> Result(Moved, Fail(e)) {
  let assert Some(action) = case_lifecycle.action_named(action_name)
    as "a trial act names a lifecycle action"
  use verdict <- result.try(case_lifecycle.check(
    store.reading(tx),
    room,
    action,
    role,
    [],
    at,
    False,
  ))
  case verdict {
    Ok(allowed) -> {
      use moved <- result.map(case_lifecycle.apply(
        tx,
        room,
        level,
        allowed.to,
        [],
        trigger,
        mover,
        case_lifecycle.status_detail(action_name, None, key_detail),
      ))
      MovedCase(moved.0, moved.1, at)
    }
    Error(r) -> {
      case r.error {
        "LIFECYCLE_NO_CHANGE" -> Nil
        other ->
          io.println_error(
            "TRIAL lifecycle_not_applied "
            <> id.recruitment_case_to_string(room.row.id)
            <> " "
            <> action_name
            <> " "
            <> other,
          )
      }
      Ok(NotMoved(r.error, at))
    }
  }
}

fn case_json(m: Moved, room: Room) -> Json {
  case m {
    MovedCase(from, to, _) ->
      json.object([
        #("from", room_status.to_json(from)),
        #("to", room_status.to_json(to)),
      ])
    NotMoved(..) ->
      json.object([
        #("unchanged", json.bool(True)),
        #("status", room_status.to_json(room.status)),
      ])
  }
}

// ---------------------------------------------------------------------------------------------- notifications

/// The recipient a trial's notices reach: the player, or the guardian for a minor.
fn recipient_audience(
  read: Read,
  t: Trial,
) -> Result(Option(#(audience.Audience, String)), Fail(e)) {
  use p <- result.try(players.by_id(read, t.row.player_id))
  case p {
    None -> Ok(None)
    Some(p) ->
      case players.is_adult(p, clock.now_ms()) {
        True -> Ok(Some(#(audience.Player, id.player_to_string(p.row.id))))
        False -> {
          use org <- result.try(org_store.by_id(read, t.row.org_id))
          use r <- result.map(case org {
            Some(org) -> recipient_for(read, org, p.row.id)
            None -> Ok(Error(trial_rules.Refusal("", "", [])))
          })
          case r, t.row.recipient_guardian_id {
            Ok(recipients.Recipient(
              kind: party.Guardian,
              guardian_id: Some(g),
              ..,
            )),
              _
            -> Some(#(audience.Guardian, id.guardian_to_string(g)))
            // No valid guardian route: the child's own device carries the outcome line only.
            _, Some(g) -> Some(#(audience.Guardian, id.guardian_to_string(g)))
            _, None -> None
          }
        }
      }
  }
}

fn notify_recipient(
  tx: Tx,
  t: Trial,
  text: String,
  at: Int,
) -> Result(Nil, Fail(e)) {
  use to <- result.try(recipient_audience(store.reading(tx), t))
  case to {
    Some(#(kind, who)) ->
      notifications.notify(
        tx,
        to: kind,
        id: who,
        type_: "trial_day",
        text:,
        ref_id: Some(id.trial_to_string(t.row.id)),
        at:,
      )
    None -> Ok(Nil)
  }
}

/// The club's people on a trial: whoever sent the invitation, the case owner and the Room lead.
fn notify_club(
  tx: Tx,
  t: Trial,
  text: String,
  at: Int,
) -> Result(Nil, Fail(e)) {
  let read = store.reading(tx)
  use room <- result.try(case t.row.case_id {
    Some(c) -> cases.room(read, c)
    None -> Ok(None)
  })
  use request <- result.try(requests.by_id(read, t.row.request_id))
  let ids =
    list.flatten([
      case request {
        Some(r) -> [r.user_id]
        None -> []
      },
      case room {
        Some(k) -> [
          k.row.owner_user_id,
          ..option.values([k.row.room_lead_scout_user_id])
        ]
        None -> []
      },
    ])
    |> list.unique
  list.try_each(ids, fn(uid) {
    notifications.notify(
      tx,
      to: audience.OrgUser,
      id: id.org_user_to_string(uid),
      type_: "trial_day",
      text:,
      ref_id: Some(id.trial_to_string(t.row.id)),
      at:,
    )
  })
}

fn live(tx: Tx, event: live_event.Event) -> Result(Nil, Fail(e)) {
  store.emit(tx, effect.Live(event))
  Ok(Nil)
}

fn trial_live(
  tx: Tx,
  change: live_event.TrialChange,
  room: Room,
  t: Trial,
) -> Result(Nil, Fail(e)) {
  live(
    tx,
    live_event.TrialChanged(
      change,
      id.org_to_string(room.row.org_id),
      id.recruitment_case_to_string(room.row.id),
      id.trial_to_string(t.row.id),
    ),
  )
}

// ------------------------------------------------------------------------------------------------------ views

pub fn invitation_view(r: Invitation, slots: List(slot_row.Row)) -> Json {
  json.object([
    #("id", id.request_json(r.id)),
    #("status", request_row.status_to_json(r.status)),
    #("createdAt", json.int(r.created_at)),
    #("respondedAt", json.nullable(r.responded_at, json.int)),
    #("respondedBy", json.nullable(r.responded_by, party.to_json)),
    #("routedTo", party.to_json(r.routed_to)),
    #("trialId", json.nullable(r.trial_id, id.trial_json)),
    #(
      "slots",
      json.array(slots, fn(s) {
        json.object([
          #("id", id.trial_slot_json(s.id)),
          #("day", json.string(s.day)),
          #("startsAt", json.int(s.starts_at)),
          #("endsAt", json.int(s.ends_at)),
          #("timezone", json.string(s.timezone)),
          #("kind", json.string(trial_rules.session_kind_text(s.kind))),
          #("venue", case s.venue_name {
            Some(name) ->
              json.object([
                #("name", json.string(name)),
                #("town", json.nullable(s.venue_town, json.string)),
              ])
            None -> json.null()
          }),
        ])
      }),
    ),
    #("proposedDate", json.nullable(r.trial_proposed_date, json.string)),
    #("altSlots", json.array(requests.alt_days(r), json.string)),
  ])
}

/// The case's trial invitations from this organisation.
fn invitations_of(read: Read, room: Room) -> Result(List(Invitation), Fail(e)) {
  use all <- result.map(requests.for_case(read, room.row.id))
  list.filter(all, fn(r) {
    r.type_ == request_row.Trial && r.org_id == room.row.org_id
  })
}

fn latest_invitation(all: List(Invitation)) -> Option(Invitation) {
  list.sort(all, fn(a, b) {
    case int.compare(b.created_at, a.created_at) {
      order.Eq ->
        string.compare(id.request_to_string(b.id), id.request_to_string(a.id))
      other -> other
    }
  })
  |> list.first
  |> option.from_result
}

fn vocabulary_json() -> Json {
  json.object([
    #(
      "workflowStates",
      json.array(trial_rules.workflow_states, trial_workflow_state.to_json),
    ),
    #("sessionKinds", json.array(trial_rules.session_kinds(), json.string)),
    #(
      "attendanceStates",
      json.array(trial_rules.attendance_states(), json.string),
    ),
  ])
}

// ----------------------------------------------------------------------------------------------------- list

/// `GET /org/rooms/:id/trials`.
pub fn list_trials(
  ctx: Ctx,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
) -> Response {
  use room, role <- room_for(ctx, a, room_id, trial_rules.TrialView)
  use gathered <- with_read(ctx, fn(rd) {
    use #(list_, omitted) <- result.try(trials_of(rd, room))
    use routing <- result.try(recipient_for(rd, a.org, room.row.player_id))
    use invitations <- result.try(invitations_of(rd, room))
    let latest = latest_invitation(invitations)
    use slots <- result.try(case latest {
      Some(r) -> requests.slots_of(rd, r.id)
      None -> Ok([])
    })
    use blocked <- result.map(audit.is_blocked(
      rd,
      room.row.player_id,
      room.row.org_id,
    ))
    #(list_, omitted, routing, latest, slots, blocked)
  })
  let #(list_, omitted, routing, latest, slots, blocked) = gathered
  http.json(
    200,
    json.object([
      #("items", json.array(list_, trial_rules.club_view)),
      #("omitted", json.int(omitted)),
      #("routing", routing_view(routing)),
      #("invitation", case latest {
        Some(r) -> invitation_view(r, slots)
        None -> json.null()
      }),
      #(
        "case",
        json.object([
          #("status", room_status.to_json(room.status)),
          #(
            "acceptsInvitation",
            json.bool(list.contains(case_statuses(), room.status)),
          ),
          #("planAction", json.string("planTrial")),
        ]),
      ),
      #(
        "canWrite",
        json.bool(trial_rules.role_allows(role, trial_rules.TrialWrite)),
      ),
      #(
        "canAssess",
        json.bool(trial_rules.role_allows(role, trial_rules.TrialAssess)),
      ),
      #("blocked", json.bool(blocked)),
      #("limits", trial_rules.limits_json()),
      #("vocabulary", vocabulary_json()),
      #("policyVersion", json.int(trial_rules.policy_version)),
      #(
        "note",
        json.string(
          "An invitation is not a trial. A trial exists once the player or guardian accepts; it is scheduled once a concrete schedule is confirmed; it is completed only after recorded attendance and the last session has ended.",
        ),
      ),
    ]),
  )
}

// ----------------------------------------------------------------------------------------------- invitation

type SlotInput {
  SlotInput(
    kind: Option(String),
    starts_at: Option(Dynamic),
    ends_at: Option(Dynamic),
  )
}

type InviteBody {
  InviteBody(
    client_key: Option(Dynamic),
    timezone: Option(String),
    venue: Option(VenueInput),
    slots: Option(List(SlotInput)),
    message: Option(String),
    instructions: Option(String),
  )
}

fn invite_shape() -> input.Shape(InviteBody) {
  use client_key <- input.field("clientKey", input.optional(input.anything()))
  use timezone <- input.field("timezone", words())
  use venue <- input.field("venue", input.optional(input.object(venue_shape())))
  use slots <- input.field(
    "slots",
    input.nullish(input.items(input.object(slot_shape()), words_max)),
  )
  use message <- input.field("message", words())
  use instructions <- input.field("instructions", words())
  input.done(InviteBody(
    client_key:,
    timezone:,
    venue:,
    slots:,
    message:,
    instructions:,
  ))
}

fn slot_shape() -> input.Shape(SlotInput) {
  use kind <- input.field("kind", words())
  use starts_at <- input.field("startsAt", input.optional(input.anything()))
  use ends_at <- input.field("endsAt", input.optional(input.anything()))
  input.done(SlotInput(kind:, starts_at:, ends_at:))
}

type ValidInvitation {
  ValidInvitation(
    timezone: Zone,
    slots: List(#(String, ValidSession)),
    venue: trial_rules.Venue,
    message: String,
    instructions: Option(String),
  )
}

/// Every slot lands on a distinct day in the organiser zone, because the recipient picks a day through the Inbox
/// (`chosenSlot`). The venue name and town are shared now; the address only after acceptance.
fn validate_invitation(
  b: InviteBody,
  now: Int,
) -> Result(ValidInvitation, trial_rules.Refusal) {
  use tz <- result.try(trial_rules.valid_timezone(b.timezone))
  case b.slots {
    None | Some([]) ->
      bad_field("TRIAL_SLOTS_INVALID", "Offer at least one slot.", "slots")
    Some(raw) ->
      case list.length(raw) > trial_rules.limit_slots {
        True ->
          bad_field(
            "TRIAL_SLOTS_INVALID",
            "Offer at most "
              <> int.to_string(trial_rules.limit_slots)
              <> " slots.",
            "slots",
          )
        False -> {
          use venue <- result.try(trial_rules.validate_venue(b.venue))
          use slots <- result.try(
            list.try_fold(raw, [], fn(acc, s) {
              use v <- result.try(trial_rules.validate_session(
                SessionInput(
                  id: None,
                  kind: s.kind,
                  starts_at: s.starts_at,
                  ends_at: s.ends_at,
                  venue: Some(VenueInput(Some(venue.name), venue.town, None)),
                  instructions: None,
                ),
                now,
                False,
              ))
              let day = trial_rules.local_day(v.starts_at, tz)
              case
                list.any(acc, fn(x: #(String, ValidSession)) { x.0 == day })
              {
                True ->
                  Error(
                    trial_rules.Refusal(
                      "TRIAL_SLOTS_INVALID",
                      "Each offered slot must fall on a different day.",
                      [#("field", json.string("slots"))],
                    ),
                  )
                False -> Ok([#(day, v), ..acc])
              }
            }),
          )
          let slots =
            list.sort(slots, fn(x, y) {
              int.compare({ x.1 }.starts_at, { y.1 }.starts_at)
            })
          case b.message {
            None ->
              bad_field(
                "TRIAL_CONTENT_INVALID",
                "Write the message the player or guardian will read.",
                "message",
              )
            Some(m) ->
              case string.trim(m) {
                "" ->
                  bad_field(
                    "TRIAL_CONTENT_INVALID",
                    "Write the message the player or guardian will read.",
                    "message",
                  )
                trimmed ->
                  case input.utf16_length(m) > trial_rules.limit_message {
                    True ->
                      bad_field(
                        "TRIAL_CONTENT_INVALID",
                        "Keep the message under "
                          <> int.to_string(trial_rules.limit_message)
                          <> " characters.",
                        "message",
                      )
                    False -> {
                      let instructions = case b.instructions {
                        None | Some("") -> Ok(None)
                        Some(i) ->
                          case
                            input.utf16_length(i)
                            > trial_rules.limit_instructions
                          {
                            True ->
                              bad_field(
                                "TRIAL_CONTENT_INVALID",
                                "Keep the instructions under "
                                  <> int.to_string(
                                  trial_rules.limit_instructions,
                                )
                                  <> " characters.",
                                "instructions",
                              )
                            False ->
                              case string.trim(i) {
                                "" -> Ok(None)
                                t -> Ok(Some(t))
                              }
                          }
                      }
                      use instructions <- result.map(instructions)
                      ValidInvitation(
                        timezone: tz,
                        slots:,
                        venue:,
                        message: trimmed,
                        instructions:,
                      )
                    }
                  }
              }
          }
        }
      }
  }
}

fn bad_field(
  error: String,
  message: String,
  field: String,
) -> Result(a, trial_rules.Refusal) {
  Error(trial_rules.Refusal(error, message, [#("field", json.string(field))]))
}

/// `POST /org/rooms/:id/trials`.
pub fn invite(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
) -> Response {
  use room, role <- room_for(ctx, a, room_id, trial_rules.TrialWrite)
  let at = now_of(ctx, req)
  use b, _raw <- body(req, invite_shape())
  use key <- client_key(b.client_key)
  case validate_invitation(b, at) {
    Error(r) -> fail(r)
    Ok(inv) -> {
      let fp =
        fingerprint([
          #(
            "slots",
            canonical.Array(
              list.map(inv.slots, fn(s) {
                canonical.Array([
                  canonical.Int({ s.1 }.starts_at),
                  canonical.Int({ s.1 }.ends_at),
                ])
              }),
            ),
          ),
          #("venue", canonical.Str(inv.venue.name)),
          #("message", canonical.Str(inv.message)),
        ])
      use mine <- with_read(ctx, invitations_of(_, room))
      let prior = case key {
        Some(k) ->
          list.find(mine, fn(r) { r.invite_key == Some(k) })
          |> option.from_result
        None -> None
      }
      case prior {
        Some(p) if p.invite_fp == Some(fp) -> {
          use slots <- with_read(ctx, requests.slots_of(_, p.id))
          http.json(
            200,
            json.object([
              #("invitation", invitation_view(p, slots)),
              #("idempotent", json.bool(True)),
              #(
                "case",
                json.object([
                  #("unchanged", json.bool(True)),
                  #("status", room_status.to_json(room.status)),
                ]),
              ),
            ]),
          )
        }
        Some(_) ->
          err(
            "TRIAL_IDEMPOTENCY_CONFLICT",
            "This clientKey was already used for a different invitation.",
            [],
          )
        None -> invite_fresh(ctx, req, a, room, role, inv, key, fp, mine, at)
      }
    }
  }
}

fn invite_fresh(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room: Room,
  role: Option(room_rules.RoomRole),
  inv: ValidInvitation,
  key: Option(String),
  fp: String,
  mine: List(Invitation),
  at: Int,
) -> Response {
  use <- bool_guard(!list.contains(case_statuses(), room.status), fn() {
    err(
      "TRIAL_CASE_STATE",
      "A case at \""
        <> room_rules.status_label(room.status)
        <> "\" cannot request a trial.",
      [#("allowed", json.array(case_statuses(), room_status.to_json))],
    )
  })
  case list.find(mine, fn(r) { r.status == request_row.Pending }) {
    Ok(pending) ->
      err(
        "TRIAL_ALREADY_INVITED",
        "An invitation is already waiting for an answer.",
        [
          #(
            "current",
            json.object([#("requestId", id.request_json(pending.id))]),
          ),
        ],
      )
    Error(Nil) -> {
      use #(list_, _) <- with_read(ctx, trials_of(_, room))
      let open =
        list.find(list_, fn(t) {
          t.row.case_id == Some(room.row.id)
          && !trial_rules.is_final(trial_rules.workflow_state(t))
        })
      case open {
        Ok(t) ->
          err(
            "TRIAL_INVALID_STATE",
            "This case already has an open trial. Complete or cancel it before inviting again.",
            [
              #(
                "current",
                json.object([
                  #("trialId", id.trial_json(t.row.id)),
                  #(
                    "workflowState",
                    trial_workflow_state.to_json(trial_rules.workflow_state(t)),
                  ),
                ]),
              ),
            ],
          )
        Error(Nil) -> {
          // A declined invitation cannot be followed by another within the Contact cooldown.
          let cooldown = 259_200_000
          let declined =
            list.filter_map(mine, fn(r) {
              case r.status, r.responded_at {
                request_row.Declined, Some(t) if at - t < cooldown -> Ok(t)
                _, _ -> Error(Nil)
              }
            })
          case list.reduce(declined, int.max) {
            Ok(latest) ->
              err(
                "TRIAL_INVITE_COOLDOWN",
                "This player declined a trial invitation recently. Wait before inviting again.",
                [#("retryAt", json.int(latest + cooldown))],
              )
            Error(Nil) -> {
              use <- limited(
                ctx,
                req,
                limits.TrialInvite,
                id.org_to_string(a.org.id),
              )
              use recipient <- reauth(ctx, a, room, None, None)
              let assert Some(recipient) = recipient
              use <- room_routes.moderated(
                ctx,
                a,
                Some(inv.message),
                "trial_invitation",
              )
              use <- room_routes.moderated(
                ctx,
                a,
                inv.instructions,
                "trial_instructions",
              )
              use <- transport_failed(
                ctx,
                "The invitation could not be delivered. Nothing was sent; try again.",
              )
              send_invitation(ctx, a, room, role, inv, key, fp, recipient, at)
            }
          }
        }
      }
    }
  }
}

fn send_invitation(
  ctx: Ctx,
  a: OrgAccess,
  room: Room,
  role: Option(room_rules.RoomRole),
  inv: ValidInvitation,
  key: Option(String),
  fp: String,
  recipient: Recipient,
  at: Int,
) -> Response {
  store.unit(ctx.store, fn(tx) {
    let rd = store.reading(tx)
    // Another invitation (this one's retry, say) may have been sent meanwhile: the route re-runs and answers from
    // it.
    use now_mine <- result.try(invitations_of(rd, room) |> storage)
    use <- bool_guard_unit(
      list.any(now_mine, fn(r) {
        r.status == request_row.Pending
        || { key != None && r.invite_key == key }
      }),
      "another trial invitation was sent meanwhile",
    )
    use player <- result.try(players.by_id(rd, room.row.player_id) |> storage)
    use player <- result.try(case player {
      Some(p) -> Ok(p)
      None ->
        store.refuse(
          err(
            "TRIAL_RECIPIENT_UNAVAILABLE",
            "This player is not available to contact.",
            [],
          ),
        )
    })
    use certified <- result.try(
      org_store.safeguarding_certified(rd, a.org) |> storage,
    )
    let minor = recipient.minor
    let venue_line = case inv.venue.town {
      Some(town) -> inv.venue.name <> ", " <> town
      None -> inv.venue.name
    }
    use r <- result.try(
      requests.create_trial(
        tx,
        requests.NewTrialInvitation(
          contact: requests.NewContact(
            player_id: player.row.id,
            player_name: player.row.name,
            org_id: a.org.id,
            org_name: a.org.name,
            org_type: a.org.type_,
            org_verified: a.org.verified,
            org_safeguarding_certified: certified,
            org_trusted_partner: a.org.trusted_partner,
            user_id: a.user.id,
            scout_name: a.user.name,
            scout_role: a.user.role,
            message: inv.message,
            guardian_id: recipient.guardian_id,
            at:,
            subject: None,
            contact_id: None,
          ),
          case_id: room.row.id,
          slots: list.map(inv.slots, fn(s) {
            requests.NewSlot(
              day: s.0,
              kind: { s.1 }.kind,
              starts_at: { s.1 }.starts_at,
              ends_at: { s.1 }.ends_at,
              timezone: zones.name(inv.timezone),
              venue_name: inv.venue.name,
              venue_town: inv.venue.town,
            )
          }),
          venue: venue_line,
          private_address: inv.venue.address,
          private_instructions: inv.instructions,
          recipient_kind: recipient.kind,
          recipient_guardian_id: recipient.guardian_id,
          recipient_minor: recipient.minor,
          invite_key: option.map(key, fn(k) { #(k, fp) }),
        ),
      )
      |> storage,
    )
    use _ <- result.try(request_notices(tx, a, player, r, minor, at) |> storage)
    use _ <- result.try(
      cases.link(tx, room.row.id, None, Some(r.id), None) |> storage,
    )
    use _ <- result.try(
      cases.record(
        tx,
        room.row.id,
        cases.by_staff(a.user.id, a.user.name),
        [
          cases.entry("room_trial_invited", [
            #("requestId", id.request_json(r.id)),
            #("recipientType", party.to_json(recipient.kind)),
            #("slotCount", json.int(list.length(inv.slots))),
          ]),
        ],
        at,
      )
      |> storage,
    )
    use moved <- result.try(
      advance(
        tx,
        room,
        room_view.level(a.org),
        "planTrial",
        role,
        case_lifecycle.StaffMover(a.user.id, a.user.name),
        "trial:invite:" <> id.request_to_string(r.id),
        [#("requestId", id.request_json(r.id))],
        at,
      )
      |> storage,
    )
    use _ <- result.try(
      live(
        tx,
        live_event.TrialInvited(
          id.org_to_string(room.row.org_id),
          id.recruitment_case_to_string(room.row.id),
          id.request_to_string(r.id),
        ),
      )
      |> storage,
    )
    use slots <- result.map(requests.slots_of(rd, r.id) |> storage)
    http.json(
      201,
      json.object([
        #("invitation", invitation_view(r, slots)),
        #("routing", routing_view(Ok(recipient))),
        #("case", case_json(moved, room)),
      ]),
    )
  })
  |> room_routes.answer
}

/// issueRecruitmentRequest's ledger row and notices for a trial invitation: a minor's goes to the guardian, and the
/// child hears only that the guardian was contacted.
pub fn request_notices(
  tx: Tx,
  a: OrgAccess,
  player: players.Player,
  r: Invitation,
  minor: Bool,
  at: Int,
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(ledger.append(
    tx,
    ledger.Entry(
      entry_type: case minor {
        True -> ledger_row.TrialRequestToGuardian
        False -> ledger_row.TrialRequest
      },
      player_id: Some(player.row.id),
      org_id: Some(a.org.id),
      org_name: Some(a.org.name),
      user_id: Some(a.user.id),
      actor_name: Some(a.user.name),
    ),
    at,
  ))
  let notice = fn(kind, to, text) {
    notifications.notify(
      tx,
      to: kind,
      id: to,
      type_: "request",
      text:,
      ref_id: Some(id.request_to_string(r.id)),
      at:,
    )
  }
  case minor, r.guardian_id {
    True, Some(g) -> {
      use _ <- result.try(notice(
        audience.Guardian,
        id.guardian_to_string(g),
        a.org.name
          <> " has requested to discuss a trial for "
          <> player.row.name
          <> ".",
      ))
      notice(
        audience.Player,
        id.player_to_string(player.row.id),
        a.org.name <> " contacted your parent/guardian about a trial.",
      )
    }
    _, _ ->
      notice(
        audience.Player,
        id.player_to_string(player.row.id),
        a.org.name <> " sent you a trial request.",
      )
  }
}

// -------------------------------------------------------------------------------------------------- one trial

/// `GET /org/rooms/:id/trials/:tid`.
pub fn get(
  ctx: Ctx,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
  tid: String,
) -> Response {
  use room, role <- room_for(ctx, a, room_id, trial_rules.TrialView)
  use t <- with_trial(ctx, room, tid)
  use gathered <- with_read(ctx, fn(rd) {
    use evidence <- result.try(evidence_views(rd, t))
    use assessments <- result.try(assessments_for(rd, a, t))
    use blocked <- result.map(audit.is_blocked(
      rd,
      t.row.player_id,
      t.row.org_id,
    ))
    #(evidence, assessments, blocked)
  })
  let #(evidence, assessments, blocked) = gathered
  http.json(
    200,
    json.object([
      #("trial", trial_rules.club_view(t)),
      #("evidence", json.preprocessed_array(evidence)),
      #("assessments", json.preprocessed_array(assessments)),
      #(
        "canWrite",
        json.bool(trial_rules.role_allows(role, trial_rules.TrialWrite)),
      ),
      #(
        "canAssess",
        json.bool(trial_rules.role_allows(role, trial_rules.TrialAssess)),
      ),
      #("blocked", json.bool(blocked)),
    ]),
  )
}

/// Assessments in this trial's context that this member may see (the blind rule). Existence and state only.
fn assessments_for(
  rd: Read,
  a: OrgAccess,
  t: Trial,
) -> Result(List(Json), Fail(e)) {
  use rows <- result.map(store.query(
    rd,
    "SELECT "
      <> assessment_row.columns
      <> " FROM assessments WHERE org_id = ? AND player_id = ? AND context_trial_id = ? ORDER BY rowid",
    [
      id.org_sql(t.row.org_id),
      id.player_sql(t.row.player_id),
      id.trial_sql(t.row.id),
    ],
    assessment_row.decoder(),
  ))
  let lead = access.is_lead(a.user)
  let i_submitted =
    list.any(rows, fn(x) {
      x.scout_user_id == a.user.id && x.state != assessment_row.Draft
    })
  rows
  |> list.filter(fn(x) {
    lead
    || x.scout_user_id == a.user.id
    || { i_submitted && x.state != assessment_row.Draft }
  })
  |> list.map(fn(x) {
    json.object([
      #("id", id.assessment_json(x.id)),
      #("state", assessment_row.state_to_json(x.state)),
      #("scoutName", json.string(x.scout_name)),
      #("scoutUserId", id.org_user_json(x.scout_user_id)),
      #("submittedAt", json.nullable(x.submitted_at, json.int)),
      #(
        "trialSessionId",
        json.nullable(x.context_trial_session_id, json.string),
      ),
      #("published", json.bool(x.published_feedback_at != None)),
    ])
  })
}

// --------------------------------------------------------------------------------------------------- schedule

type ScheduleBody {
  ScheduleBody(
    client_key: Option(Dynamic),
    timezone: Option(String),
    sessions: Option(List(trial_rules.SessionInput)),
    reason: Option(String),
  )
}

fn session_shape() -> input.Shape(trial_rules.SessionInput) {
  use sid <- input.field("id", words())
  use kind <- input.field("kind", words())
  use starts_at <- input.field("startsAt", input.optional(input.anything()))
  use ends_at <- input.field("endsAt", input.optional(input.anything()))
  use venue <- input.field("venue", input.optional(input.object(venue_shape())))
  use instructions <- input.field("instructions", words())
  input.done(SessionInput(
    id: sid,
    kind:,
    starts_at:,
    ends_at:,
    venue:,
    instructions:,
  ))
}

fn schedule_shape() -> input.Shape(ScheduleBody) {
  use client_key <- input.field("clientKey", input.optional(input.anything()))
  use <- rev_fields
  use timezone <- input.field("timezone", words())
  use sessions <- input.field(
    "sessions",
    input.nullish(input.items(input.object(session_shape()), words_max)),
  )
  use reason <- input.field(
    "reason",
    input.nullish(input.text(trial_rules.limit_reason)),
  )
  input.done(ScheduleBody(client_key:, timezone:, sessions:, reason:))
}

fn session_compared(
  sid: id.TrialSessionId,
  s: ValidSession,
) -> trial_rules.Compared {
  trial_rules.Compared(
    id: id.trial_session_to_string(sid),
    starts_at: s.starts_at,
    ends_at: s.ends_at,
    name: s.venue.name,
    town: option.unwrap(s.venue.town, ""),
  )
}

/// `POST /org/rooms/:id/trials/:tid/schedule` and `…/reschedule`.
pub fn schedule(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
  tid: String,
) -> Response {
  use room, _role <- room_for(ctx, a, room_id, trial_rules.TrialWrite)
  use t <- with_trial(ctx, room, tid)
  let at = now_of(ctx, req)
  use b, raw <- body(req, schedule_shape())
  use key <- client_key(b.client_key)
  let existing = list.map(t.sessions, fn(s) { s.row.id })
  case trial_rules.validate_schedule(b.timezone, b.sessions, at, existing) {
    Error(r) -> fail(r)
    Ok(#(tz, planned)) -> {
      // The fingerprint names a new session by its place, as no id is minted until the act.
      let fp =
        fingerprint([
          #("timezone", canonical.Str(zones.name(tz))),
          #(
            "sessions",
            canonical.Array(
              list.map(planned, fn(p: Planned) {
                let s = p.session
                canonical.Array([
                  case p.id {
                    Some(sid) -> canonical.Str(id.trial_session_to_string(sid))
                    None -> canonical.Null
                  },
                  canonical.Int(s.starts_at),
                  canonical.Int(s.ends_at),
                  canonical.Str(s.venue.name),
                  canonical.text(s.venue.town),
                  canonical.Str(trial_rules.session_kind_text(s.kind)),
                  canonical.text(s.instructions),
                ])
              }),
            ),
          ),
        ])
      case key_check(t, key_row.Schedule, key, fp) {
        Conflict ->
          err(
            "TRIAL_IDEMPOTENCY_CONFLICT",
            "This clientKey was already used for a different schedule.",
            [],
          )
        Replay -> idempotent(t)
        Fresh -> {
          let is_revision = trial_rules.has_schedule(t)
          let act = case is_revision {
            True -> trial_rules.RescheduleAct
            False -> trial_rules.ScheduleAct
          }
          use _ <- reauth(ctx, a, room, Some(t), Some(act))
          use <- rev_gate(raw, t)
          use <- limited(
            ctx,
            req,
            limits.TrialSchedule,
            id.org_to_string(a.org.id),
          )
          use <- bool_guard(
            list.length(t.revisions) >= trial_rules.limit_revisions,
            fn() {
              err(
                "TRIAL_INVALID_STATE",
                "A trial schedule may be revised at most "
                  <> int.to_string(trial_rules.limit_revisions)
                  <> " times.",
                [],
              )
            },
          )
          // A revision must carry every ended or attendance-recorded session unchanged.
          let att = trial_rules.current_attendance(t)
          let moved =
            list.find(t.sessions, fn(prev) {
              let ended = prev.row.ends_at <= at
              let recorded = dict.has_key(att, prev.row.id)
              case ended || recorded {
                False -> False
                True ->
                  case list.find(planned, fn(p) { p.id == Some(prev.row.id) }) {
                    Ok(kept) ->
                      kept.session.starts_at != prev.row.starts_at
                      || kept.session.ends_at != prev.row.ends_at
                    Error(Nil) -> True
                  }
              }
            })
          case moved {
            Ok(prev) ->
              err(
                "TRIAL_INVALID_STATE",
                "A session that has ended or has attendance recorded cannot be removed or moved. Cancel the trial if it will not go ahead.",
                [
                  #(
                    "current",
                    json.object([
                      #("sessionId", id.trial_session_json(prev.row.id)),
                    ]),
                  ),
                ],
              )
            Error(Nil) ->
              moderate_all(
                ctx,
                a,
                list.filter_map(planned, fn(p) {
                  option.to_result(p.session.instructions, Nil)
                }),
                fn() {
                  propose(
                    ctx,
                    a,
                    room,
                    t,
                    tz,
                    planned,
                    b.reason,
                    key,
                    fp,
                    is_revision,
                    at,
                  )
                },
              )
          }
        }
      }
    }
  }
}

fn moderate_all(
  ctx: Ctx,
  a: OrgAccess,
  texts: List(String),
  next: fn() -> Response,
) -> Response {
  case texts {
    [] -> next()
    [first, ..rest] -> {
      use <- room_routes.moderated(ctx, a, Some(first), "trial_instructions")
      moderate_all(ctx, a, rest, next)
    }
  }
}

fn idempotent(t: Trial) -> Response {
  http.json(
    200,
    json.object([
      #("trial", trial_rules.club_view(t)),
      #("idempotent", json.bool(True)),
    ]),
  )
}

fn propose(
  ctx: Ctx,
  a: OrgAccess,
  room: Room,
  t: Trial,
  tz: Zone,
  planned: List(Planned),
  reason: Option(String),
  key: Option(String),
  fp: String,
  is_revision: Bool,
  at: Int,
) -> Response {
  store.unit(ctx.store, fn(tx) {
    use _ <- result.try(unchanged(tx, t) |> storage)
    // A new session's id is minted now.
    use with_ids <- result.try(
      list.try_map(planned, fn(p) {
        case p.id {
          Some(sid) -> Ok(#(sid, p.session))
          None ->
            id.next_trial_session(tx)
            |> result.map(fn(sid) { #(sid, p.session) })
        }
      })
      |> storage,
    )
    use sessions <- result.try(case trial_rules.order_sessions(with_ids) {
      Ok(s) -> Ok(s)
      Error(r) -> store.refuse(fail(r))
    })
    let material =
      trial_rules.material_change(trial_rules.compared(t), #(
        zones.name(tz),
        list.map(sessions, fn(s) { session_compared(s.0, s.1) }),
      ))
    let revision = option.unwrap(t.row.schedule_revision, 0) + 1
    let was_confirmed = t.row.schedule_confirmed_at != None
    let keeps = was_confirmed && !material
    let reason =
      option.then(reason, fn(r) {
        case string.trim(r) {
          "" -> None
          x -> Some(x)
        }
      })
    let state = trial_rules.derive_with(t, keeps, list.length(sessions))
    let by = staff(a)
    use e <- result.try(
      trials.entry(
        tx,
        case is_revision {
          True -> "trial_rescheduled"
          False -> "trial_schedule_proposed"
        },
        by,
        [
          #("revision", json.int(revision)),
          #("sessionCount", json.int(list.length(sessions))),
          #("material", json.bool(material)),
          #("requiresConfirmation", json.bool(!keeps)),
        ],
        at,
      )
      |> storage,
    )
    use fresh <- result.try(
      trials.propose_schedule(
        tx,
        t,
        revision,
        zones.name(tz),
        sessions,
        at,
        by,
        keeps,
        reason,
        material,
        state,
        acted(a, at, [e], key_of(key_row.Schedule, key, fp)),
      )
      |> storage,
    )
    use _ <- result.try(
      trial_live(
        tx,
        case is_revision {
          True -> live_event.TrialRescheduled
          False -> live_event.TrialScheduled
        },
        room,
        t,
      )
      |> storage,
    )
    use _ <- result.map(
      notify_recipient(
        tx,
        fresh,
        case keeps, is_revision {
          True, _ ->
            fresh.row.org_name
            <> " updated the details of your trial (times unchanged)."
          False, True ->
            fresh.row.org_name
            <> " proposed new times for your trial — please confirm the updated schedule."
          False, False ->
            fresh.row.org_name
            <> " proposed a schedule for your trial — please confirm it."
        },
        at,
      )
      |> storage,
    )
    http.json(
      200,
      json.object([
        #("trial", trial_rules.club_view(fresh)),
        #("requiresConfirmation", json.bool(!keeps)),
        #("material", json.bool(material)),
      ]),
    )
  })
  |> room_routes.answer
}

// ------------------------------------------------------------------------------------------------------ cancel

type CancelBody {
  CancelBody(client_key: Option(Dynamic), reason: Option(String))
}

/// `POST /org/rooms/:id/trials/:tid/cancel`. Allowed while blocked: a safety notice, not solicitation.
pub fn cancel(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
  tid: String,
) -> Response {
  use room, _role <- room_for(ctx, a, room_id, trial_rules.TrialWrite)
  use t <- with_trial(ctx, room, tid)
  let at = now_of(ctx, req)
  let shape = {
    use client_key <- input.field("clientKey", input.optional(input.anything()))
    use <- rev_fields
    use reason <- input.field("reason", words())
    input.done(CancelBody(client_key:, reason:))
  }
  use b, raw <- body(req, shape)
  use key <- client_key(b.client_key)
  let reason_field = [#("field", json.string("reason"))]
  case b.reason {
    None ->
      err(
        "TRIAL_CONTENT_INVALID",
        "A cancellation needs a reason the family will read.",
        reason_field,
      )
    Some(raw_reason) ->
      case
        string.trim(raw_reason),
        input.utf16_length(raw_reason) > trial_rules.limit_reason
      {
        "", _ ->
          err(
            "TRIAL_CONTENT_INVALID",
            "A cancellation needs a reason the family will read.",
            reason_field,
          )
        _, True ->
          err(
            "TRIAL_CONTENT_INVALID",
            "Keep the reason under "
              <> int.to_string(trial_rules.limit_reason)
              <> " characters.",
            reason_field,
          )
        reason, False -> {
          let fp = fingerprint([#("reason", canonical.Str(reason))])
          case key_check(t, key_row.Cancel, key, fp) {
            Conflict ->
              err(
                "TRIAL_IDEMPOTENCY_CONFLICT",
                "This clientKey was already used for a different cancellation.",
                [],
              )
            Replay -> idempotent(t)
            Fresh -> {
              use _ <- reauth(
                ctx,
                a,
                room,
                Some(t),
                Some(trial_rules.CancelAct),
              )
              use <- rev_gate(raw, t)
              use <- limited(
                ctx,
                req,
                limits.TrialSchedule,
                id.org_to_string(a.org.id),
              )
              use <- room_routes.moderated(
                ctx,
                a,
                Some(reason),
                "trial_cancellation",
              )
              let phase = trial_rules.workflow_state(t)
              store.unit(ctx.store, fn(tx) {
                use _ <- result.try(unchanged(tx, t) |> storage)
                let by = staff(a)
                use e <- result.try(
                  trials.entry(
                    tx,
                    "trial_cancelled",
                    by,
                    [
                      #("phase", trial_workflow_state.to_json(phase)),
                      #("cancelledBy", json.string("club")),
                      #(
                        "attendedSessions",
                        json.int(trial_rules.attended_count(t)),
                      ),
                    ],
                    at,
                  )
                  |> storage,
                )
                use fresh <- result.try(
                  trials.cancel(
                    tx,
                    t,
                    at,
                    by,
                    Some(reason),
                    phase,
                    trial_row.Club,
                    acted(a, at, [e], key_of(key_row.Cancel, key, fp)),
                  )
                  |> storage,
                )
                use _ <- result.try(
                  trial_live(tx, live_event.TrialCancelled, room, t) |> storage,
                )
                use _ <- result.map(
                  notify_recipient(
                    tx,
                    fresh,
                    fresh.row.org_name <> " cancelled the trial: " <> reason,
                    at,
                  )
                  |> storage,
                )
                http.json(
                  200,
                  json.object([#("trial", trial_rules.club_view(fresh))]),
                )
              })
              |> room_routes.answer
            }
          }
        }
      }
  }
}

// -------------------------------------------------------------------------------------------------- attendance

type AttendanceBody {
  AttendanceBody(
    client_key: Option(Dynamic),
    state: attendance_row.State,
    note: Option(String),
  )
}

/// `POST /org/rooms/:id/trials/:tid/sessions/:sid/attendance`: what happened, never how it went.
pub fn attendance(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
  tid: String,
  sid: String,
) -> Response {
  use room, _role <- room_for(ctx, a, room_id, trial_rules.TrialWrite)
  use t <- with_trial(ctx, room, tid)
  let at = now_of(ctx, req)
  let shape = {
    use client_key <- input.field("clientKey", input.optional(input.anything()))
    use <- rev_fields
    use state <- input.field(
      "state",
      input.required(input.one_of(attendance_row.state_pairs)),
    )
    use note <- input.field("note", words())
    input.done(AttendanceBody(client_key:, state:, note:))
  }
  use b, raw <- body(req, shape)
  use key <- client_key(b.client_key)
  let too_long = case b.note {
    Some(n) -> input.utf16_length(n) > trial_rules.limit_note
    None -> False
  }
  case too_long {
    True ->
      err(
        "TRIAL_ATTENDANCE_INVALID",
        "A note is text under "
          <> int.to_string(trial_rules.limit_note)
          <> " characters.",
        [],
      )
    False -> attendance_checked(ctx, req, a, room, t, sid, b, raw, key, at)
  }
}

fn attendance_checked(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room: Room,
  t: Trial,
  sid: String,
  b: AttendanceBody,
  raw: Dynamic,
  key: Option(String),
  at: Int,
) -> Response {
  let note =
    option.then(b.note, fn(n) {
      case string.trim(n) {
        "" -> None
        x -> Some(x)
      }
    })
  let fp =
    fingerprint([
      #("sessionId", canonical.Str(sid)),
      #("state", canonical.Str(attendance_row.state_to_string(b.state))),
      #("note", canonical.text(note)),
    ])
  case key_check(t, key_row.Attendance, key, fp) {
    Conflict ->
      err(
        "TRIAL_IDEMPOTENCY_CONFLICT",
        "This clientKey was already used for a different attendance record.",
        [],
      )
    Replay -> idempotent(t)
    Fresh -> {
      use _ <- reauth(ctx, a, room, Some(t), Some(trial_rules.AttendanceAct))
      use s <- with_session(t, sid)
      use <- bool_guard(s.row.starts_at > at, fn() {
        err(
          "TRIAL_INVALID_STATE",
          "Attendance is recorded once a session has started.",
          [
            #(
              "current",
              json.object([
                #("sessionId", id.trial_session_json(s.row.id)),
                #("startsAt", json.int(s.row.starts_at)),
              ]),
            ),
          ],
        )
      })
      use <- rev_gate(raw, t)
      use <- limited(
        ctx,
        req,
        limits.TrialAttendance,
        id.org_to_string(a.org.id),
      )
      use <- room_routes.moderated(ctx, a, note, "trial_attendance_note")
      store.unit(ctx.store, fn(tx) {
        use _ <- result.try(unchanged(tx, t) |> storage)
        let by = staff(a)
        use e <- result.try(
          trials.entry(
            tx,
            "trial_attendance_recorded",
            by,
            [
              #("sessionId", id.trial_session_json(s.row.id)),
              #("state", attendance_row.state_to_json(b.state)),
              #("source", json.string("manual")),
            ],
            at,
          )
          |> storage,
        )
        use fresh <- result.try(
          trials.record_attendance(
            tx,
            t,
            s.row.id,
            b.state,
            by,
            at,
            note,
            acted(a, at, [e], key_of(key_row.Attendance, key, fp)),
          )
          |> storage,
        )
        use _ <- result.map(
          live(
            tx,
            live_event.TrialSessionChanged(
              live_event.TrialAttendanceRecorded,
              id.org_to_string(room.row.org_id),
              id.recruitment_case_to_string(room.row.id),
              id.trial_to_string(t.row.id),
              id.trial_session_to_string(s.row.id),
            ),
          )
          |> storage,
        )
        http.json(200, json.object([#("trial", trial_rules.club_view(fresh))]))
      })
      |> room_routes.answer
    }
  }
}

// ---------------------------------------------------------------------------------------------------- complete

/// `POST /org/rooms/:id/trials/:tid/complete`.
pub fn complete(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
  tid: String,
) -> Response {
  use room, role <- room_for(ctx, a, room_id, trial_rules.TrialWrite)
  use t <- with_trial(ctx, room, tid)
  let at = now_of(ctx, req)
  let shape = {
    use client_key <- input.field("clientKey", input.optional(input.anything()))
    use <- rev_fields
    input.done(client_key)
  }
  use raw_key, raw <- body(req, shape)
  use key <- client_key(raw_key)
  let fp =
    fingerprint([#("complete", canonical.Str(id.trial_to_string(t.row.id)))])
  case key_check(t, key_row.Complete, key, fp) {
    Conflict ->
      err(
        "TRIAL_IDEMPOTENCY_CONFLICT",
        "This clientKey was already used differently.",
        [],
      )
    Replay -> idempotent(t)
    Fresh -> {
      use _ <- reauth(ctx, a, room, Some(t), Some(trial_rules.CompleteAct))
      case trial_rules.can_complete(t, at) {
        Error(r) -> fail(r)
        Ok(Nil) -> {
          use <- rev_gate(raw, t)
          use <- limited(
            ctx,
            req,
            limits.TrialAttendance,
            id.org_to_string(a.org.id),
          )
          use <- transport_failed(
            ctx,
            "The completion could not be recorded. Nothing was changed; try again.",
          )
          store.unit(ctx.store, fn(tx) {
            use _ <- result.try(unchanged(tx, t) |> storage)
            let by = staff(a)
            use e <- result.try(
              trials.entry(
                tx,
                "trial_completed",
                by,
                [
                  #("sessionCount", json.int(list.length(t.sessions))),
                  #("attendedSessions", json.int(trial_rules.attended_count(t))),
                ],
                at,
              )
              |> storage,
            )
            use _ <- result.try(
              trials.complete(
                tx,
                t,
                at,
                by,
                acted(a, at, [e], key_of(key_row.Complete, key, fp)),
              )
              |> storage,
            )
            // The evidence provider reads the completed trial.
            use moved <- result.try(case t.row.case_id {
              Some(_) ->
                advance(
                  tx,
                  room,
                  room_view.level(a.org),
                  "completeTrial",
                  role,
                  case_lifecycle.StaffMover(a.user.id, a.user.name),
                  "trial:complete:" <> id.trial_to_string(t.row.id),
                  [#("trialId", id.trial_json(t.row.id))],
                  at,
                )
                |> storage
              None -> Ok(NotMoved("legacy_no_case", at))
            })
            use fresh <- result.try(
              trials.record_lifecycle(tx, t.row.id, lifecycle_of(moved))
              |> storage,
            )
            use _ <- result.try(
              trial_live(tx, live_event.TrialCompleted, room, t) |> storage,
            )
            use _ <- result.map(
              notify_recipient(
                tx,
                fresh,
                fresh.row.org_name
                  <> " recorded the trial as completed. Thank you for taking part.",
                at,
              )
              |> storage,
            )
            http.json(
              200,
              json.object([
                #("trial", trial_rules.club_view(fresh)),
                #("case", case moved {
                  MovedCase(..) -> case_json(moved, room)
                  NotMoved(reason, _) ->
                    json.object([
                      #("unchanged", json.bool(True)),
                      #("status", room_status.to_json(room.status)),
                      #("reason", json.string(reason)),
                    ])
                }),
              ]),
            )
          })
          |> room_routes.answer
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------- Box Cam evidence

const combine_disabled = "REAL_WORLD_VALIDATION_NOT_COMPLETED"

fn box_session(
  rd: Read,
  sid: id.BoxSessionId,
) -> Result(Option(box_row.Row), Fail(e)) {
  store.one(
    rd,
    "SELECT " <> box_row.columns <> " FROM box_sessions WHERE id = ?",
    [id.box_session_sql(sid)],
    box_row.decoder(),
  )
  |> result.map(option.from_result)
}

fn test_only(s: box_row.Row) -> Bool {
  s.provider_id == box_provider.LocalTest
}

fn withdrawn(s: box_row.Row) -> Bool {
  s.status == box_row.StatusCancelled
  || s.verification_state == Some(box_row.VerificationStateCancelled)
  || s.verification_state == Some(box_row.VerificationStateInvalidated)
}

/// Read live; never a trace, a nonce or a numeric confidence. A missing session shows as unavailable, an
/// invalidated one as withdrawn. The link row is history either way.
fn evidence_views(rd: Read, t: Trial) -> Result(List(Json), Fail(e)) {
  trial_rules.sorted_sessions(t)
  |> list.flat_map(fn(s) { list.map(s.evidence, fn(e) { #(s, e) }) })
  |> list.try_map(fn(pair) {
    let #(s, e) = pair
    use found <- result.try(box_session(rd, e.box_session_id))
    use cv <- result.map(latest_cv(
      rd,
      id.box_session_to_string(e.box_session_id),
    ))
    let bs = case found {
      Some(b) if b.player_id == t.row.player_id -> Some(b)
      _ -> None
    }
    let base = [
      #("id", id.trial_evidence_json(e.id)),
      #("kind", json.string("box_cam_session")),
      #("trialSessionId", id.trial_session_json(s.row.id)),
      #("linkedAt", json.int(e.linked_at)),
      #(
        "linkedBy",
        json.object([#("name", json.nullable(e.linked_by_name, json.string))]),
      ),
      #("removedAt", json.nullable(e.removed_at, json.int)),
      #("provenance", json.string("box_cam_observed")),
      #("combineVerified", json.bool(False)),
      #("combineVerifiedBlockedBy", json.string(combine_disabled)),
    ]
    let observation = fn(state, copy) {
      json.object([
        #("state", json.string(state)),
        #("copy", json.string(copy)),
        #("qualityState", json.null()),
        #("experimental", json.null()),
      ])
    }
    case bs {
      None ->
        json.object(
          list.append(base, [
            #("session", json.null()),
            #(
              "observation",
              observation(
                "unavailable",
                "This Box Cam session is no longer available.",
              ),
            ),
            #("providerVersion", json.null()),
            #("engineVersion", json.null()),
            #("cvPolicyVersion", json.null()),
          ]),
        )
      Some(b) -> {
        let invalidated = withdrawn(b)
        let session =
          json.object([
            #("id", id.box_session_json(b.id)),
            #("drillId", json.string(b.drill_id)),
            #("protocolId", json.null()),
            #(
              "capturedAt",
              json.int(option.unwrap(
                option.or(b.ended_at, b.started_at),
                b.created_at,
              )),
            ),
            #(
              "verificationState",
              json.nullable(
                b.verification_state,
                box_row.verification_state_to_json,
              ),
            ),
            #("simulated", json.bool(test_only(b))),
            #("invalidated", json.bool(invalidated)),
          ])
        json.object(
          list.append(base, [
            #("session", session),
            #("observation", case invalidated, cv {
              True, _ ->
                observation(
                  "evidence_withdrawn",
                  "This Box Cam session was withdrawn after review; no observation is available.",
                )
              False, None ->
                observation(
                  "no_cv_result",
                  "No reliable observation available for this session.",
                )
              False, Some(r) -> cv_observation(r)
            }),
            #("providerVersion", case invalidated, cv {
              False, Some(r) -> json.int(r.provider_version)
              _, _ -> json.int(b.provider_version)
            }),
            #("engineVersion", case invalidated, cv {
              False, Some(r) -> json.int(r.engine_version)
              _, _ -> json.null()
            }),
            #("cvPolicyVersion", case invalidated, cv {
              False, Some(r) -> json.int(r.cv_policy_version)
              _, _ -> json.null()
            }),
          ]),
        )
      }
    }
  })
}

/// The latest CV result recorded for a Box Cam session (Box Cam's analysis records it; it is read here, never
/// written).
fn latest_cv(rd: Read, sid: String) -> Result(Option(cv_row.Row), Fail(e)) {
  store.one(
    rd,
    "SELECT "
      <> cv_row.columns
      <> " FROM box_cam_cv_results WHERE session_id = ? ORDER BY rowid DESC LIMIT 1",
    [sqlight.text(sid)],
    cv_row.decoder(),
  )
  |> result.map(option.from_result)
}

/// The player-facing sentence for a CV refusal, under a neutral state: a refusal means no reliable observation,
/// never poor performance.
fn refusal_copy(reason: String) -> String {
  case reason {
    "accepted" -> "This attempt was observed and measured."
    "insufficient_confidence" ->
      "Could not verify this attempt — not enough visual confidence in what was observed."
    "insufficient_visibility" ->
      "Could not verify this attempt — the lighting was too low to track the ball reliably."
    "ball_not_detected" ->
      "Could not verify this attempt — the ball was not visible for enough of the attempt."
    "person_not_detected" ->
      "Could not verify this attempt — no player was visible in the capture area."
    "protocol_violation" ->
      "Could not verify this attempt — the capture did not follow the standardised protocol."
    "liveness_failed" ->
      "Could not verify this attempt — the live-session check did not pass."
    "provider_unavailable" ->
      "Production observation is not available right now, so this attempt was not verified."
    "unsupported_protocol" ->
      "Production observation is not available for this test on this device."
    "unsupported_event_cadence" ->
      "Could not verify this attempt — the touches came faster than ScoutBox can reliably count, so no exact result was produced."
    _ -> ""
  }
}

fn cv_observation(r: cv_row.Row) -> Json {
  let quality = json.nullable(r.oq_state, cv_row.oq_state_to_json)
  case r.outcome {
    cv_row.Accepted ->
      json.object([
        #("state", json.string("accepted")),
        #("copy", json.string("This session was observed by Box Cam.")),
        #("qualityState", quality),
        #(
          "experimental",
          json.object([
            #(
              "status",
              cv_row.experimental_status_to_json(r.experimental_status),
            ),
          ]),
        ),
      ])
    cv_row.Refused -> {
      let reason = option.unwrap(r.refusal_reason, "unknown")
      json.object([
        #("state", json.string(reason)),
        #(
          "copy",
          json.string(string.trim(
            "No reliable observation available. " <> refusal_copy(reason),
          )),
        ),
        #("qualityState", quality),
        #("experimental", json.null()),
      ])
    }
  }
}

/// `GET /org/rooms/:id/trials/:tid/evidence`.
pub fn evidence(
  ctx: Ctx,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
  tid: String,
) -> Response {
  use room, _role <- room_for(ctx, a, room_id, trial_rules.TrialView)
  use t <- with_trial(ctx, room, tid)
  use views <- with_read(ctx, evidence_views(_, t))
  http.json(
    200,
    json.object([
      #("items", json.preprocessed_array(views)),
      #(
        "note",
        json.string(
          "Machine observation, referenced live from the player's own Box Cam record. A refusal means no reliable observation is available; it is never a statement about the player.",
        ),
      ),
    ]),
  )
}

/// Whether the organisation may see the player and their Box Cam activity (the Combine consent rule).
fn consent(
  rd: Read,
  a: OrgAccess,
  player_id: id.PlayerId,
) -> Result(Result(Nil, String), Fail(e)) {
  use found <- result.try(players.for_org(rd, player_id, a.org, clock.now_ms()))
  case found {
    None -> Ok(Error("TRIAL_RECIPIENT_UNAVAILABLE"))
    Some(#(_, access)) if !access.visible ->
      Ok(Error("TRIAL_RECIPIENT_UNAVAILABLE"))
    Some(_) -> {
      use may <- result.map(combine.org_may_see_results(rd, a.org.id, player_id))
      case may {
        True -> Ok(Nil)
        False -> Error("EVIDENCE_CONSENT_REQUIRED")
      }
    }
  }
}

/// `GET /org/rooms/:id/trials/:tid/evidence/candidates`: ids and neutral metadata only.
pub fn candidates(
  ctx: Ctx,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
  tid: String,
) -> Response {
  use room, _role <- room_for(ctx, a, room_id, trial_rules.TrialView)
  use t <- with_trial(ctx, room, tid)
  let none = fn(reason) {
    http.json(
      200,
      json.object([
        #("items", json.preprocessed_array([])),
        #("consent", json.bool(False)),
        #("reason", json.string(reason)),
      ]),
    )
  }
  use gathered <- with_read(ctx, fn(rd) {
    use player <- result.try(players.by_id(rd, t.row.player_id))
    use blocked <- result.try(audit.is_blocked(
      rd,
      t.row.player_id,
      t.row.org_id,
    ))
    use consented <- result.try(consent(rd, a, t.row.player_id))
    use sessions <- result.map(store.query(
      rd,
      "SELECT "
        <> box_row.columns
        <> " FROM box_sessions WHERE player_id = ? AND finalized_at IS NOT NULL ORDER BY rowid",
      [id.player_sql(t.row.player_id)],
      box_row.decoder(),
    ))
    #(player, blocked, consented, sessions)
  })
  let #(player, blocked, consented, sessions) = gathered
  case player == None || t.row.subject_removed_at != None, blocked, consented {
    True, _, _ -> none("TRIAL_SUBJECT_REMOVED")
    _, True, _ -> none("TRIAL_BLOCKED")
    _, _, Error(reason) -> none(reason)
    _, _, Ok(Nil) -> {
      let linked =
        list.flat_map(t.sessions, fn(s) {
          list.filter_map(s.evidence, fn(e) {
            case e.removed_at {
              None -> Ok(e.box_session_id)
              Some(_) -> Error(Nil)
            }
          })
        })
      let captured = fn(b: box_row.Row) {
        option.unwrap(option.or(b.ended_at, b.finalized_at), 0)
      }
      let items =
        sessions
        |> list.filter(fn(b) { !withdrawn(b) && !test_only(b) })
        |> list.sort(fn(x, y) {
          case int.compare(captured(y), captured(x)) {
            order.Eq ->
              string.compare(
                id.box_session_to_string(y.id),
                id.box_session_to_string(x.id),
              )
            other -> other
          }
        })
        |> list.take(50)
        |> list.map(fn(b) {
          json.object([
            #("id", id.box_session_json(b.id)),
            #("drillId", json.string(b.drill_id)),
            #("protocolId", json.null()),
            #(
              "capturedAt",
              json.nullable(option.or(b.ended_at, b.finalized_at), json.int),
            ),
            #(
              "verificationState",
              json.nullable(
                b.verification_state,
                box_row.verification_state_to_json,
              ),
            ),
            #("simulated", json.bool(test_only(b))),
            #("linked", json.bool(list.contains(linked, b.id))),
          ])
        })
      http.json(
        200,
        json.object([
          #("items", json.preprocessed_array(items)),
          #("consent", json.bool(True)),
          #("reason", json.null()),
        ]),
      )
    }
  }
}

type LinkBody {
  LinkBody(client_key: Option(Dynamic), box_session_id: Option(String))
}

/// `POST /org/rooms/:id/trials/:tid/sessions/:sid/evidence`: a Box Cam session cited by reference.
pub fn link(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
  tid: String,
  sid: String,
) -> Response {
  use room, _role <- room_for(ctx, a, room_id, trial_rules.TrialWrite)
  use t <- with_trial(ctx, room, tid)
  let at = now_of(ctx, req)
  let shape = {
    use client_key <- input.field("clientKey", input.optional(input.anything()))
    use <- rev_fields
    use box_session_id <- input.field("boxSessionId", input.nullish(input.id()))
    input.done(LinkBody(client_key:, box_session_id:))
  }
  use b, raw <- body(req, shape)
  use key <- client_key(b.client_key)
  let fp =
    fingerprint([
      #("trialSessionId", canonical.Str(sid)),
      #("boxSessionId", canonical.text(b.box_session_id)),
    ])
  let views = fn(t2) {
    use v <- with_read(ctx, evidence_views(_, t2))
    http.json(
      200,
      json.object([
        #("trial", trial_rules.club_view(t2)),
        #("evidence", json.preprocessed_array(v)),
        #("idempotent", json.bool(True)),
      ]),
    )
  }
  case key_check(t, key_row.Link, key, fp) {
    Conflict ->
      err(
        "TRIAL_IDEMPOTENCY_CONFLICT",
        "This clientKey was already used for a different evidence link.",
        [],
      )
    Replay -> views(t)
    Fresh -> {
      use _ <- reauth(ctx, a, room, Some(t), Some(trial_rules.LinkAct))
      use s <- with_session(t, sid)
      use authorised <- link_authorisation(ctx, a, room, b.box_session_id)
      use <- rev_gate(raw, t)
      let existing =
        list.find(s.evidence, fn(e) {
          e.box_session_id == authorised.id && e.removed_at == None
        })
      case existing {
        Ok(_) -> views(t)
        Error(Nil) -> {
          use <- bool_guard(
            list.count(s.evidence, fn(e) { e.removed_at == None })
              >= trial_rules.limit_evidence_per_session,
            fn() {
              err(
                "TRIAL_INVALID_STATE",
                "A session cites at most "
                  <> int.to_string(trial_rules.limit_evidence_per_session)
                  <> " Box Cam sessions.",
                [],
              )
            },
          )
          use <- limited(
            ctx,
            req,
            limits.TrialEvidenceLink,
            id.org_to_string(a.org.id),
          )
          store.unit(ctx.store, fn(tx) {
            use _ <- result.try(unchanged(tx, t) |> storage)
            let by = staff(a)
            use evidence_id <- result.try(id.next_trial_evidence(tx) |> storage)
            use e <- result.try(
              trials.entry(
                tx,
                "trial_evidence_linked",
                by,
                [
                  #("trialSessionId", id.trial_session_json(s.row.id)),
                  #("kind", json.string("box_cam_session")),
                  #("sessionId", id.box_session_json(authorised.id)),
                ],
                at,
              )
              |> storage,
            )
            use fresh <- result.try(
              trials.link_evidence(
                tx,
                t,
                s.row.id,
                evidence_id,
                authorised.id,
                at,
                by,
                acted(a, at, [e], key_of(key_row.Link, key, fp)),
              )
              |> storage,
            )
            use _ <- result.try(
              live(
                tx,
                live_event.TrialSessionChanged(
                  live_event.TrialEvidenceLinked,
                  id.org_to_string(room.row.org_id),
                  id.recruitment_case_to_string(room.row.id),
                  id.trial_to_string(t.row.id),
                  id.trial_session_to_string(s.row.id),
                ),
              )
              |> storage,
            )
            use v <- result.map(
              evidence_views(store.reading(tx), fresh) |> storage,
            )
            http.json(
              201,
              json.object([
                #("trial", trial_rules.club_view(fresh)),
                #("evidence", json.preprocessed_array(v)),
              ]),
            )
          })
          |> room_routes.answer
        }
      }
    }
  }
}

/// Checked now against the live session, player and organisation. A failure answers `TRIAL_BOXCAM_INCOMPATIBLE`
/// (so "not yours" and "does not exist" look alike), except not-final and withdrawn, which a club may learn about
/// a session it may see. Consent is decided before the session lookup, so a refusal never confirms footage exists.
fn link_authorisation(
  ctx: Ctx,
  a: OrgAccess,
  room: Room,
  box_session_id: Option(String),
  next: fn(box_row.Row) -> Response,
) -> Response {
  let incompatible = fn() {
    err(
      "TRIAL_BOXCAM_INCOMPATIBLE",
      "No Box Cam session of this player with that id is available to your organisation.",
      [],
    )
  }
  case box_session_id {
    None | Some("") ->
      err(
        "TRIAL_EVIDENCE_REF_INVALID",
        "boxSessionId must be a session id.",
        [],
      )
    Some(bsid) -> {
      use gathered <- with_read(ctx, fn(rd) {
        use consented <- result.try(consent(rd, a, room.row.player_id))
        // The request names the session: its text is the boundary.
        use s <- result.map(box_session(rd, id.box_session(bsid)))
        #(consented, s)
      })
      case gathered {
        #(Error("EVIDENCE_CONSENT_REQUIRED"), _) ->
          err(
            "EVIDENCE_CONSENT_REQUIRED",
            "This player has not shared Box Cam activity with your organisation.",
            [],
          )
        #(Error(_), _) -> incompatible()
        #(Ok(Nil), None) -> incompatible()
        #(Ok(Nil), Some(s)) if s.player_id != room.row.player_id ->
          incompatible()
        #(Ok(Nil), Some(s)) ->
          case test_only(s), withdrawn(s), s.finalized_at {
            True, _, _ -> incompatible()
            _, True, _ ->
              err(
                "EVIDENCE_WITHDRAWN",
                "This Box Cam session was withdrawn or invalidated and cannot be cited.",
                [],
              )
            _, _, None ->
              err(
                "EVIDENCE_NOT_FINAL",
                "This Box Cam session has not finished; only a finalised session can be cited.",
                [],
              )
            _, _, Some(_) -> next(s)
          }
      }
    }
  }
}

/// `POST /org/rooms/:id/trials/:tid/evidence/:eid/unlink`.
pub fn unlink(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
  tid: String,
  eid: String,
) -> Response {
  use room, _role <- room_for(ctx, a, room_id, trial_rules.TrialWrite)
  use t <- with_trial(ctx, room, tid)
  let at = now_of(ctx, req)
  let shape = {
    use <- rev_fields
    input.done(Nil)
  }
  use _, raw <- body(req, shape)
  use _ <- reauth(ctx, a, room, Some(t), Some(trial_rules.LinkAct))
  let hit =
    list.find_map(t.sessions, fn(s) {
      list.find(s.evidence, fn(e) { id.trial_evidence_to_string(e.id) == eid })
      |> result.map(fn(e) { #(s, e) })
    })
  case hit {
    Error(Nil) ->
      err("TRIAL_SESSION_NOT_FOUND", "No such evidence link on this trial.", [])
    Ok(#(s, e)) -> {
      use <- rev_gate(raw, t)
      case e.removed_at {
        Some(_) -> {
          use v <- with_read(ctx, evidence_views(_, t))
          http.json(
            200,
            json.object([
              #("trial", trial_rules.club_view(t)),
              #("evidence", json.preprocessed_array(v)),
              #("idempotent", json.bool(True)),
            ]),
          )
        }
        None ->
          store.unit(ctx.store, fn(tx) {
            use _ <- result.try(unchanged(tx, t) |> storage)
            let by = staff(a)
            use h <- result.try(
              trials.entry(
                tx,
                "trial_evidence_unlinked",
                by,
                [
                  #("trialSessionId", id.trial_session_json(s.row.id)),
                  #("sessionId", id.box_session_json(e.box_session_id)),
                ],
                at,
              )
              |> storage,
            )
            use fresh <- result.try(
              trials.unlink_evidence(
                tx,
                t,
                e.id,
                at,
                by,
                acted(a, at, [h], None),
              )
              |> storage,
            )
            use v <- result.map(
              evidence_views(store.reading(tx), fresh) |> storage,
            )
            http.json(
              200,
              json.object([
                #("trial", trial_rules.club_view(fresh)),
                #("evidence", json.preprocessed_array(v)),
              ]),
            )
          })
          |> room_routes.answer
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------- hooks

/// What a respond route asks before it records the acceptance of a case-tied trial invitation: the recipient is
/// re-derived now and must be the person answering. Also the acceptance's failure-injection point. Error: the
/// refusal to answer with.
pub fn accept_gate(
  ctx: Ctx,
  request: Invitation,
  by: party.Party,
  actor_id: String,
) -> Result(Nil, Response) {
  let refuse = fn(code, message) { Error(err(code, message, [])) }
  use #(room, org) <- result.try(
    read(ctx, fn(rd) {
      use room <- result.try(case request.case_id {
        Some(c) -> cases.room(rd, c)
        None -> Ok(None)
      })
      use org <- result.map(org_store.by_id(rd, request.org_id))
      #(room, org)
    }),
  )
  case room, org {
    Some(_), Some(org) -> {
      use r <- result.try(read(ctx, recipient_for(_, org, request.player_id)))
      case r {
        Error(refusal) -> Error(fail(refusal))
        Ok(rec) ->
          case rec.kind == by {
            False ->
              refuse("TRIAL_RECIPIENT_UNAVAILABLE", case by {
                party.Guardian ->
                  "This player is now the recipient of their own trial invitations; the club needs to re-invite."
                party.Player ->
                  "This invitation is managed by the player's guardian."
              })
            True -> {
              let as_guardian = Some(id.guardian(actor_id))
              let as_player = id.player(actor_id)
              case by {
                party.Guardian if rec.guardian_id != as_guardian ->
                  refuse(
                    "TRIAL_GUARDIAN_REQUIRED",
                    "You are no longer the verified guardian route for this player.",
                  )
                party.Player if rec.player_id != as_player ->
                  refuse(
                    "TRIAL_RECIPIENT_UNAVAILABLE",
                    "This invitation is not yours to accept.",
                  )
                _ ->
                  case
                    store.unit(ctx.store, delivery.consume_injected(
                      _,
                      injection_row.Trial,
                    ))
                  {
                    Ok(True) ->
                      refuse(
                        "TRIAL_TRANSPORT_REFUSED",
                        "The acceptance could not be recorded. Nothing was changed; try again.",
                      )
                    _ -> Ok(Nil)
                  }
              }
            }
          }
      }
    }
    _, _ ->
      refuse(
        "TRIAL_RECIPIENT_UNAVAILABLE",
        "This invitation can no longer be accepted.",
      )
  }
}

/// The recipient who answered an invitation.
pub type Answerer {
  Answerer(kind: party.Party, id: String, name: String)
}

fn family(who: Answerer) -> trials.Actor {
  trials.Family(who.kind, who.id, Some(who.name))
}

fn history_kind(k: party.Party) -> history_row.ByKind {
  case k {
    party.Player -> history_row.Player
    party.Guardian -> history_row.Guardian
  }
}

/// The only writer of an accepted trial (issueAcceptedTrial), in the respond route's unit, and what follows from
/// it: the invitation names the trial, the case links it, and a concrete slot confirms `trial_scheduled`.
/// Accepting a concrete slot is the schedule confirmation: the trial is born `scheduled`, revision 1 confirmed by
/// the recipient. A date-only or undated invitation is born `accepted` with no schedule.
pub fn accepted(
  tx: Tx,
  request: Invitation,
  player: players.Player,
  trial_date: Option(String),
  who: Answerer,
  at: Int,
) -> Result(Trial, Fail(e)) {
  let rd = store.reading(tx)
  use slots <- result.try(requests.slots_of(rd, request.id))
  let slot =
    list.find(slots, fn(s) { Some(s.day) == trial_date }) |> option.from_result
  use trial_id <- result.try(id.next_trial(tx))
  use born <- result.try(case slot {
    None -> Ok(None)
    Some(s) -> {
      use sid <- result.map(id.next_trial_session(tx))
      Some(trials.Born(
        timezone: s.timezone,
        session_id: sid,
        session: trial_rules.ValidSession(
          kind: s.kind,
          starts_at: s.starts_at,
          ends_at: s.ends_at,
          venue: trial_rules.Venue(
            name: option.unwrap(s.venue_name, ""),
            town: s.venue_town,
            address: request.trial_private_venue_address,
          ),
          instructions: request.trial_private_instructions,
        ),
        proposed_at: request.created_at,
        proposed_by: trials.Staff(
          request.user_id,
          option.unwrap(request.scout_name, ""),
        ),
      ))
    }
  })
  let by = family(who)
  use first <- result.try(trials.entry(
    tx,
    "trial_accepted",
    by,
    [
      #("recipientType", party.to_json(who.kind)),
      #(
        "slotId",
        json.nullable(option.map(slot, fn(s) { s.id }), id.trial_slot_json),
      ),
      #("day", json.nullable(trial_date, json.string)),
    ],
    at,
  ))
  use confirmed <- result.try(case born {
    Some(_) ->
      trials.entry(
        tx,
        "trial_schedule_confirmed",
        by,
        [#("revision", json.int(1)), #("sessionCount", json.int(1))],
        at,
      )
      |> result.map(fn(e) { [e] })
    None -> Ok([])
  })
  trials.create(
    tx,
    trials.NewTrial(
      id: trial_id,
      request_id: request.id,
      case_id: request.case_id,
      player_id: player.row.id,
      player_name: Some(player.row.name),
      org_id: request.org_id,
      org_name: request.org_name,
      scout_name: request.scout_name,
      accepted_at: at,
      accepted_by: who.kind,
      proposed_date: trial_date,
      venue: case request.trial_venue {
        Some("") -> None
        v -> v
      },
      notes: option.unwrap(request.trial_notes, ""),
      recipient_guardian_id: case who.kind {
        party.Guardian -> Some(id.guardian(who.id))
        party.Player -> None
      },
      by:,
      schedule: born,
      history: [first, ..confirmed],
    ),
  )
}

/// What follows from an accepted trial, in the answer's unit: the invitation names it, the case links it, and a
/// born-scheduled trial confirms `trial_scheduled`. The club's people hear of it.
pub fn on_accepted(
  tx: Tx,
  request: Invitation,
  t: Trial,
  who: Answerer,
  at: Int,
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(
    store.run(
      tx,
      "UPDATE recruitment_requests SET trial_id = ? WHERE id = ? AND type = 'trial' AND trial_id IS NULL",
      [id.trial_sql(t.row.id), id.request_sql(request.id)],
    ),
  )
  let rd = store.reading(tx)
  use room <- result.try(case request.case_id {
    Some(c) -> cases.room(rd, c)
    None -> Ok(None)
  })
  case room {
    None -> Ok(Nil)
    Some(room) -> {
      let scheduled =
        trial_rules.workflow_state(t) == trial_workflow_state.Scheduled
      use _ <- result.try(cases.link(
        tx,
        room.row.id,
        Some(t.row.id),
        None,
        None,
      ))
      use _ <- result.try(cases.record(
        tx,
        room.row.id,
        cases.By(history_kind(who.kind), Some(who.id), Some(who.name)),
        [
          cases.entry("room_trial_accepted", [
            #("trialId", id.trial_json(t.row.id)),
            #("requestId", id.request_json(request.id)),
            #("recipientType", party.to_json(who.kind)),
            #("scheduled", json.bool(scheduled)),
          ]),
        ],
        at,
      ))
      use moved <- result.try(case scheduled {
        False -> Ok(NotMoved("not_scheduled", at))
        True -> {
          use org <- result.try(org_store.by_id(rd, room.row.org_id))
          let assert Some(org) = org as "a case's organisation exists"
          advance(
            tx,
            room,
            room_view.level(org),
            "confirmTrial",
            Some(room_rules.RecruitmentAdmin),
            case_lifecycle.RecipientMover(
              history_kind(who.kind),
              who.id,
              Some(who.name),
            ),
            "trial:accept:" <> id.trial_to_string(t.row.id),
            [#("trialId", id.trial_json(t.row.id))],
            at,
          )
        }
      })
      use _ <- result.try(trials.record_lifecycle(
        tx,
        t.row.id,
        lifecycle_of(moved),
      ))
      let staff_ids =
        [
          room.row.owner_user_id,
          ..option.values([room.row.room_lead_scout_user_id])
        ]
        |> list.unique
        |> list.filter(fn(u) { u != request.user_id })
      use _ <- result.try(
        list.try_each(staff_ids, fn(uid) {
          notifications.notify(
            tx,
            to: audience.OrgUser,
            id: id.org_user_to_string(uid),
            type_: "trial_day",
            text: "Recruitment Room — "
              <> room_routes.player_name(room)
              <> ": the "
              <> party.to_string(who.kind)
              <> " accepted the trial invitation"
              <> case scheduled {
              True -> " and confirmed the schedule"
              False -> ""
            }
              <> ".",
            ref_id: Some(id.trial_to_string(t.row.id)),
            at:,
          )
        }),
      )
      live(
        tx,
        live_event.TrialAccepted(
          id.org_to_string(room.row.org_id),
          id.recruitment_case_to_string(room.row.id),
          id.trial_to_string(t.row.id),
          id.request_to_string(request.id),
        ),
      )
    }
  }
}

/// A declined trial invitation: the case records it and the club's people hear of it.
pub fn on_declined(
  tx: Tx,
  request: Invitation,
  who: Answerer,
  at: Int,
) -> Result(Nil, Fail(e)) {
  use room <- result.try(case request.case_id {
    Some(c) -> cases.room(store.reading(tx), c)
    None -> Ok(None)
  })
  case room {
    None -> Ok(Nil)
    Some(room) -> {
      use _ <- result.try(cases.record(
        tx,
        room.row.id,
        cases.By(history_kind(who.kind), Some(who.id), Some(who.name)),
        [
          cases.entry("room_trial_declined", [
            #("requestId", id.request_json(request.id)),
            #("recipientType", party.to_json(who.kind)),
          ]),
        ],
        at,
      ))
      let staff_ids =
        [
          room.row.owner_user_id,
          ..option.values([room.row.room_lead_scout_user_id])
        ]
        |> list.unique
        |> list.filter(fn(u) { u != request.user_id })
      use _ <- result.try(
        list.try_each(staff_ids, fn(uid) {
          notifications.notify(
            tx,
            to: audience.OrgUser,
            id: id.org_user_to_string(uid),
            type_: "trial_day",
            text: "Recruitment Room — "
              <> room_routes.player_name(room)
              <> ": the "
              <> party.to_string(who.kind)
              <> " declined the trial invitation.",
            ref_id: Some(id.request_to_string(request.id)),
            at:,
          )
        }),
      )
      live(
        tx,
        live_event.TrialDeclined(
          id.org_to_string(room.row.org_id),
          id.recruitment_case_to_string(room.row.id),
          id.request_to_string(request.id),
        ),
      )
    }
  }
}

// -------------------------------------------------------------------------------------------- recipient routes

/// Who is answering: the player themself, or a guardian for their children.
pub type Recipient2 {
  PlayerSide(p: PlayerAccess)
  GuardianSide(g: Guardian)
}

fn side_kind(r: Recipient2) -> party.Party {
  case r {
    PlayerSide(_) -> party.Player
    GuardianSide(_) -> party.Guardian
  }
}

fn side_answerer(r: Recipient2) -> Answerer {
  case r {
    PlayerSide(p) ->
      Answerer(
        party.Player,
        id.player_to_string(p.player.row.id),
        p.player.row.name,
      )
    GuardianSide(g) ->
      Answerer(party.Guardian, id.guardian_to_string(g.row.id), g.row.name)
  }
}

fn side_players(r: Recipient2) -> List(id.PlayerId) {
  case r {
    PlayerSide(p) -> [p.player.row.id]
    GuardianSide(g) -> g.child_ids
  }
}

/// A recipient's trial, and whether they have blocked its organisation (they may still cancel it).
fn recipient_trial(
  ctx: Ctx,
  r: Recipient2,
  tid: String,
  next: fn(Trial, Bool) -> Response,
) -> Response {
  let guardian_side = side_kind(r) == party.Guardian
  use found <- with_read(ctx, fn(rd) {
    use t <- result.try(trials.by_id(rd, id.trial(tid)))
    case t {
      Some(t) ->
        case list.contains(side_players(r), t.row.player_id) {
          False -> Ok(None)
          True -> {
            use org <- result.try(org_store.by_id(rd, t.row.org_id))
            use rec <- result.map(case org {
              Some(org) ->
                recipients.resolve(rd, t.row.player_id, org, clock.now_ms())
              None -> Ok(Error(recipients.Unavailable("")))
            })
            Some(#(t, rec))
          }
        }
      None -> Ok(None)
    }
  })
  case found {
    None -> err("TRIAL_NOT_FOUND", "No such trial.", [])
    Some(#(t, _)) if t.row.subject_removed_at != None ->
      err("TRIAL_SUBJECT_REMOVED", "This trial can no longer be changed.", [])
    Some(#(t, Error(recipients.Blocked))) -> next(t, True)
    Some(#(_, Error(e))) ->
      err(
        case e {
          recipients.GuardianRequired -> "TRIAL_GUARDIAN_REQUIRED"
          _ -> "TRIAL_RECIPIENT_UNAVAILABLE"
        },
        case guardian_side {
          True ->
            "You are no longer the verified guardian route for this player."
          False -> "This trial is not yours to act on."
        },
        [],
      )
    Some(#(t, Ok(rec))) -> {
      let wrong_guardian = case r {
        GuardianSide(g) -> rec.guardian_id != Some(g.row.id)
        PlayerSide(_) -> False
      }
      case rec.kind == side_kind(r), wrong_guardian {
        False, _ ->
          err(
            "TRIAL_RECIPIENT_UNAVAILABLE",
            case guardian_side {
              True -> "This player now manages their own trials."
              False -> "This trial is managed by your parent or guardian."
            },
            [],
          )
        True, True ->
          err(
            "TRIAL_GUARDIAN_REQUIRED",
            "You are no longer the verified guardian route for this player.",
            [],
          )
        True, False -> next(t, False)
      }
    }
  }
}

fn managed(r: Recipient2, next: fn() -> Response) -> Response {
  case r {
    PlayerSide(p) -> access.guardian_managed_only(p, next)
    GuardianSide(_) -> next()
  }
}

fn family_json(t: Trial) -> Response {
  http.json(200, json.object([#("trial", trial_rules.family_view(t))]))
}

fn family_idempotent(t: Trial, idempotent: Bool) -> Response {
  http.json(
    200,
    json.object([
      #("trial", trial_rules.family_view(t)),
      #("idempotent", json.bool(idempotent)),
    ]),
  )
}

fn response_limited(
  ctx: Ctx,
  req: Request,
  r: Recipient2,
  next: fn() -> Response,
) -> Response {
  let who = side_answerer(r)
  limited(
    ctx,
    req,
    limits.TrialResponse,
    party.to_string(who.kind) <> ":" <> who.id,
    next,
  )
}

fn optional_rev(raw: Dynamic, t: Trial, next: fn() -> Response) -> Response {
  case named_rev(raw) {
    None -> next()
    Some(v) -> rev_value(v, t, next)
  }
}

/// `POST /player/trials/:id/confirm-schedule`, `POST /guardian/trials/:id/confirm-schedule`.
pub fn confirm(ctx: Ctx, req: Request, r: Recipient2, tid: String) -> Response {
  use <- managed(r)
  use t, blocked <- recipient_trial(ctx, r, tid)
  let shape = {
    use <- rev_fields
    input.done(Nil)
  }
  use _, raw <- body(req, shape)
  use <- bool_guard(blocked, fn() {
    err(
      "TRIAL_BLOCKED",
      "You have blocked this organisation. Lift the block before confirming a trial with it.",
      [],
    )
  })
  let at = now_of(ctx, req)
  use <- bool_guard(!trial_rules.has_schedule(t), fn() {
    err("TRIAL_INVALID_STATE", "There is no schedule to confirm yet.", [])
  })
  use <- bool_guard(trial_rules.is_final(trial_rules.workflow_state(t)), fn() {
    err("TRIAL_INVALID_STATE", "This trial has ended.", [])
  })
  case t.row.schedule_confirmed_at {
    Some(_) -> family_idempotent(t, True)
    None -> {
      use <- response_limited(ctx, req, r)
      use <- optional_rev(raw, t)
      let who = side_answerer(r)
      store.unit(ctx.store, fn(tx) {
        use _ <- result.try(unchanged(tx, t) |> storage)
        let by = family(who)
        let rd = store.reading(tx)
        use room <- result.try(case t.row.case_id {
          Some(c) -> cases.room(rd, c) |> storage
          None -> Ok(None)
        })
        use e <- result.try(
          trials.entry(
            tx,
            "trial_schedule_confirmed",
            by,
            [
              #("revision", json.nullable(t.row.schedule_revision, json.int)),
              #("sessionCount", json.int(list.length(t.sessions))),
            ],
            at,
          )
          |> storage,
        )
        use _ <- result.try(
          trials.confirm_schedule(
            tx,
            t,
            at,
            by,
            who.kind,
            case who.kind {
              party.Guardian -> Some(id.guardian(who.id))
              party.Player -> None
            },
            trial_rules.derive_with(t, True, list.length(t.sessions)),
            trials.Acted(at:, rev_by: None, history: [e], key: None),
          )
          |> storage,
        )
        // The evidence provider reads the confirmed trial.
        use moved <- result.try(case room {
          Some(room) -> {
            use org <- result.try(
              org_store.by_id(rd, room.row.org_id) |> storage,
            )
            let assert Some(org) = org as "a case's organisation exists"
            advance(
              tx,
              room,
              room_view.level(org),
              "confirmTrial",
              Some(room_rules.RecruitmentAdmin),
              case_lifecycle.RecipientMover(
                history_kind(who.kind),
                who.id,
                Some(who.name),
              ),
              "trial:confirm:" <> id.trial_to_string(t.row.id),
              [#("trialId", id.trial_json(t.row.id))],
              at,
            )
            |> storage
          }
          None -> Ok(NotMoved("legacy_no_case", at))
        })
        use fresh <- result.try(
          trials.record_lifecycle(tx, t.row.id, lifecycle_of(moved)) |> storage,
        )
        use _ <- result.try(case room {
          Some(room) ->
            trial_live(tx, live_event.TrialScheduled, room, t) |> storage
          None -> Ok(Nil)
        })
        use _ <- result.map(
          notify_club(
            tx,
            fresh,
            who.name
              <> " confirmed the trial schedule for "
              <> option.unwrap(fresh.row.player_name, "the player")
              <> " (revision "
              <> int.to_string(option.unwrap(fresh.row.schedule_revision, 0))
              <> ").",
            at,
          )
          |> storage,
        )
        family_json(fresh)
      })
      |> room_routes.answer
    }
  }
}

type AnswerBody {
  AnswerBody(reason: Option(String))
}

fn answer_shape() -> input.Shape(AnswerBody) {
  use <- rev_fields
  use reason <- input.field("reason", words())
  input.done(AnswerBody(reason:))
}

fn answer_reason(
  b: AnswerBody,
  next: fn(Option(String)) -> Response,
) -> Response {
  case b.reason {
    Some(r) ->
      case input.utf16_length(r) > trial_rules.limit_reason {
        True ->
          err(
            "TRIAL_CONTENT_INVALID",
            "A reason is text under "
              <> int.to_string(trial_rules.limit_reason)
              <> " characters.",
            [#("field", json.string("reason"))],
          )
        False ->
          next(case string.trim(r) {
            "" -> None
            x -> Some(x)
          })
      }
    None -> next(None)
  }
}

fn recipient_moderated(
  ctx: Ctx,
  t: Trial,
  reason: Option(String),
  kind: String,
  next: fn() -> Response,
) -> Response {
  case reason {
    None -> next()
    Some(text) ->
      moderate.or_refuse(
        ctx,
        text,
        audit.Context(
          kind:,
          player_id: Some(t.row.player_id),
          org_id: None,
          user_id: None,
          channel_id: None,
          request_id: None,
        ),
        next,
      )
  }
}

/// `POST /player/trials/:id/decline-schedule`, `POST /guardian/trials/:id/decline-schedule`.
pub fn decline(ctx: Ctx, req: Request, r: Recipient2, tid: String) -> Response {
  use <- managed(r)
  use t, _blocked <- recipient_trial(ctx, r, tid)
  use b, _raw <- body(req, answer_shape())
  let at = now_of(ctx, req)
  use <- bool_guard(
    !trial_rules.has_schedule(t) || t.row.schedule_confirmed_at != None,
    fn() {
      err(
        "TRIAL_INVALID_STATE",
        "There is no proposed schedule awaiting your answer.",
        [],
      )
    },
  )
  use <- bool_guard(trial_rules.is_final(trial_rules.workflow_state(t)), fn() {
    err("TRIAL_INVALID_STATE", "This trial has ended.", [])
  })
  case t.row.schedule_declined_at {
    Some(_) -> family_idempotent(t, True)
    None -> {
      use <- response_limited(ctx, req, r)
      use reason <- answer_reason(b)
      use <- recipient_moderated(ctx, t, reason, "trial_schedule_decline")
      let who = side_answerer(r)
      store.unit(ctx.store, fn(tx) {
        use _ <- result.try(unchanged(tx, t) |> storage)
        let by = family(who)
        use e <- result.try(
          trials.entry(
            tx,
            "trial_schedule_declined",
            by,
            [
              #("revision", json.nullable(t.row.schedule_revision, json.int)),
              #("hadReason", json.bool(reason != None)),
            ],
            at,
          )
          |> storage,
        )
        use fresh <- result.try(
          trials.decline_schedule(
            tx,
            t,
            at,
            by,
            trials.Acted(at:, rev_by: None, history: [e], key: None),
          )
          |> storage,
        )
        use _ <- result.map(
          notify_club(
            tx,
            fresh,
            who.name
              <> " declined the proposed trial schedule for "
              <> option.unwrap(fresh.row.player_name, "the player")
              <> " (revision "
              <> int.to_string(option.unwrap(fresh.row.schedule_revision, 0))
              <> ")"
              <> case reason {
              Some(x) -> ": " <> x
              None -> "."
            },
            at,
          )
          |> storage,
        )
        family_json(fresh)
      })
      |> room_routes.answer
    }
  }
}

/// `POST /player/trials/:id/cancel`, `POST /guardian/trials/:id/cancel`. The recipient may cancel even a blocked
/// organisation's trial.
pub fn recipient_cancel(
  ctx: Ctx,
  req: Request,
  r: Recipient2,
  tid: String,
) -> Response {
  use <- managed(r)
  use t, _blocked <- recipient_trial(ctx, r, tid)
  use b, _raw <- body(req, answer_shape())
  let at = now_of(ctx, req)
  let state = trial_rules.workflow_state(t)
  case trial_rules.is_final(state) {
    True -> family_idempotent(t, state == trial_workflow_state.Cancelled)
    False -> {
      use <- response_limited(ctx, req, r)
      use reason <- answer_reason(b)
      use <- recipient_moderated(ctx, t, reason, "trial_cancellation")
      let who = side_answerer(r)
      store.unit(ctx.store, fn(tx) {
        use _ <- result.try(unchanged(tx, t) |> storage)
        let by = family(who)
        use e <- result.try(
          trials.entry(
            tx,
            "trial_cancelled",
            by,
            [
              #("phase", trial_workflow_state.to_json(state)),
              #("cancelledBy", party.to_json(who.kind)),
              #("attendedSessions", json.int(trial_rules.attended_count(t))),
            ],
            at,
          )
          |> storage,
        )
        use fresh <- result.try(
          trials.cancel(
            tx,
            t,
            at,
            by,
            reason,
            state,
            case who.kind {
              party.Player -> trial_row.Player
              party.Guardian -> trial_row.Guardian
            },
            trials.Acted(at:, rev_by: None, history: [e], key: None),
          )
          |> storage,
        )
        let rd = store.reading(tx)
        use room <- result.try(case fresh.row.case_id {
          Some(c) -> cases.room(rd, c) |> storage
          None -> Ok(None)
        })
        use _ <- result.try(case room {
          Some(room) ->
            trial_live(tx, live_event.TrialCancelled, room, t) |> storage
          None -> Ok(Nil)
        })
        use _ <- result.map(
          notify_club(
            tx,
            fresh,
            who.name
              <> " cancelled the trial for "
              <> option.unwrap(fresh.row.player_name, "the player")
              <> case reason {
              Some(x) -> ": " <> x
              None -> "."
            },
            at,
          )
          |> storage,
        )
        family_json(fresh)
      })
      |> room_routes.answer
    }
  }
}

// --------------------------------------------------------------------------------------------------- vocabulary

/// `GET /org/recruitment/trial-policy`.
pub fn policy() -> Response {
  http.json(
    200,
    json.object([
      #("policyVersion", json.int(trial_rules.policy_version)),
      #(
        "workflowStates",
        json.array(trial_rules.workflow_states, trial_workflow_state.to_json),
      ),
      #("sessionKinds", json.array(trial_rules.session_kinds(), json.string)),
      #(
        "attendanceStates",
        json.array(trial_rules.attendance_states(), json.string),
      ),
      #("cancelActors", json.array(trial_rules.cancel_actors, json.string)),
      #("caseStatuses", json.array(case_statuses(), room_status.to_json)),
      #("limits", trial_rules.limits_json()),
      #(
        "note",
        json.string(
          "An invitation is not a trial; acceptance is not a schedule; a schedule is not attendance; attendance is not completion; completion is not an assessment; an assessment is not a decision. Box Cam observation is machine evidence, never an assessment; a refusal means no reliable observation, never poor performance.",
        ),
      ),
    ]),
  )
}

// ---------------------------------------------------------------------------------------------------- reminders

/// The trial reminders of the follow-up sweep: a confirmed session within 48 hours reminds the recipient (the
/// guardian for a minor) once per session per revision, and a trial whose last session ended a day ago without
/// completion reminds the club lead once. A blocked club sends the family nothing. The markers are rows, so a
/// restart re-sends nothing.
pub fn remind(ctx: Ctx, now: Int) -> Int {
  let due = store.read(ctx.store, trials.reminders_due)
  case due {
    Error(_) -> 0
    Ok(due) ->
      list.fold(due, 0, fn(n, t) {
        case remind_one(ctx, t, now) {
          Ok(True) -> n + 1
          _ -> n
        }
      })
  }
}

fn remind_one(
  ctx: Ctx,
  t: Trial,
  now: Int,
) -> Result(Bool, store.UnitError(Nil)) {
  case
    t.row.subject_removed_at != None
    || t.row.schedule_confirmed_at == None
    || trial_rules.workflow_state(t) != trial_workflow_state.Scheduled
  {
    True -> Ok(False)
    False ->
      store.unit(ctx.store, fn(tx) {
        let rd = store.reading(tx)
        let marked = list.map(t.reminders, fn(r) { r.marker })
        let revision = option.unwrap(t.row.schedule_revision, 0)
        let session_marks =
          list.filter_map(t.sessions, fn(s) {
            let key =
              "t48:"
              <> id.trial_session_to_string(s.row.id)
              <> ":"
              <> int.to_string(revision)
            case
              list.contains(marked, key)
              || s.row.starts_at <= now
              || s.row.starts_at - now > 48 * 3_600_000
            {
              True -> Error(Nil)
              False -> Ok(key)
            }
          })
        use player <- result.try(players.by_id(rd, t.row.player_id))
        use blocked <- result.try(audit.is_blocked(
          rd,
          t.row.player_id,
          t.row.org_id,
        ))
        use _ <- result.try(case player, blocked, session_marks {
          Some(p), False, [_, ..] ->
            list.try_each(session_marks, fn(_) {
              let to_guardian =
                t.row.recipient_type == Some(party.Guardian)
                || { !players.is_adult(p, now) && p.row.guardian_id != None }
              case to_guardian, p.row.guardian_id {
                True, Some(g) ->
                  notifications.notify(
                    tx,
                    to: audience.Guardian,
                    id: id.guardian_to_string(g),
                    type_: "trial_day",
                    text: "⏰ "
                      <> p.row.name
                      <> "'s trial session with "
                      <> t.row.org_name
                      <> " is within 48 hours.",
                    ref_id: Some(id.trial_to_string(t.row.id)),
                    at: now,
                  )
                _, _ ->
                  notifications.notify(
                    tx,
                    to: audience.Player,
                    id: id.player_to_string(p.row.id),
                    type_: "trial_day",
                    text: "⏰ Your trial session with "
                      <> t.row.org_name
                      <> " is within 48 hours.",
                    ref_id: Some(id.trial_to_string(t.row.id)),
                    at: now,
                  )
              }
            })
          _, _, _ -> Ok(Nil)
        })
        let completion_mark = case trial_rules.last_session_end(t) {
          Some(end) if now - end > 24 * 3_600_000 ->
            case list.contains(marked, "completionPending") {
              True -> []
              False -> ["completionPending"]
            }
          _ -> []
        }
        use _ <- result.try(case completion_mark {
          [] -> Ok(Nil)
          _ -> {
            use lead <- result.try(store.one(
              rd,
              "SELECT id FROM org_users WHERE org_id = ? AND removed_at IS NULL ORDER BY rowid LIMIT 1",
              [id.org_sql(t.row.org_id)],
              decode.at([0], decode.string),
            ))
            case lead {
              Ok(uid) ->
                notifications.notify(
                  tx,
                  to: audience.OrgUser,
                  id: uid,
                  type_: "trial_day",
                  text: "The trial for "
                    <> option.unwrap(t.row.player_name, "the player")
                    <> " has ended — record attendance and complete it.",
                  ref_id: Some(id.trial_to_string(t.row.id)),
                  at: now,
                )
              Error(_) -> Ok(Nil)
            }
          }
        })
        let markers =
          list.map(list.append(session_marks, completion_mark), fn(m) {
            #(m, now)
          })
        use _ <- result.map(trials.mark_reminders(tx, t.row.id, markers))
        markers != []
      })
  }
}
