//// The Combine's records (domains/development/boxcam/combine.mjs): a player's attempts, each bound to a server-minted
//// Box Cam session, the measurement worked out when that session finishes, a club's requests that a player complete
//// some protocols, and who may see a player's results.
////
//// An attempt's live state is read with its bound session's: invalidating the session stops a Combine Verified
//// result counting, and a restore brings it back, without rewriting the attempt.

import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/development/box_cam_rules as box_rules
import scoutbox/development/combine_rules.{type Protocol} as rules
import scoutbox/identity/players.{type Player}
import scoutbox/identity/staff.{type Staff}
import scoutbox/messaging/notifications
import scoutbox/platform/json_text
import scoutbox/platform/live_event
import scoutbox/platform/live_pings
import scoutbox/platform/metrics
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/platform/temporal
import scoutbox/rows/box_sessions as session_row
import scoutbox/rows/combine_attempts as attempt_row
import scoutbox/rows/combine_requests as row
import scoutbox/rows/id
import scoutbox/rows/orgs
import scoutbox/safety/ledger
import scoutbox/vocab/audience
import scoutbox/vocab/capture_context
import sqlight

fn count(tx: Tx, name: String) -> Result(Nil, Fail(e)) {
  metrics.count(tx, "boxCam", name)
}

// ------------------------------------------------------------------------------------------------ attempts

/// An attempt with its reasons and calibration checks in order, and its bound session's verification state.
pub type Attempt {
  Attempt(
    row: attempt_row.Row,
    reasons: List(String),
    checks: List(String),
    session_state: Option(session_row.VerificationState),
  )
}

/// The state that counts now: the bound session's invalidation shows through.
pub fn live_state(a: Attempt) -> attempt_row.CombineState {
  rules.live_state(a.row.combine_state, a.session_state)
}

fn attempts_where(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(List(Attempt), Fail(e)) {
  let decoder = {
    use r <- decode.then(attempt_row.decoder())
    use state <- decode.field(
      attempt_row.width,
      decode.optional(session_row.verification_state_decoder()),
    )
    decode.success(#(r, state))
  }
  use found <- result.try(store.query(
    read,
    "SELECT "
      <> attempt_row.qualified("a")
      <> ", s.verification_state FROM combine_attempts a LEFT JOIN box_sessions s ON s.id = a.box_session_id "
      <> where,
    args,
    decoder,
  ))
  list.try_map(found, fn(pair) {
    let #(r, state) = pair
    use reasons <- result.try(store.query(
      read,
      "SELECT code FROM combine_attempt_reasons WHERE attempt_id = ? ORDER BY ord",
      [id.combine_attempt_sql(r.id)],
      decode.at([0], decode.string),
    ))
    use checks <- result.map(store.query(
      read,
      "SELECT check_name FROM combine_attempt_calibration_checks WHERE attempt_id = ? ORDER BY ord",
      [id.combine_attempt_sql(r.id)],
      decode.at([0], decode.string),
    ))
    Attempt(r, reasons, checks, state)
  })
}

pub fn attempt_by_id(
  read: Read,
  attempt: id.CombineAttemptId,
) -> Result(Option(Attempt), Fail(e)) {
  attempts_where(read, "WHERE a.id = ?", [id.combine_attempt_sql(attempt)])
  |> result.map(fn(found) { list.first(found) |> option.from_result })
}

/// The player's own attempt, or None (another player's is never found).
pub fn own_attempt(
  read: Read,
  player: id.PlayerId,
  attempt: id.CombineAttemptId,
) -> Result(Option(Attempt), Fail(e)) {
  use found <- result.map(attempt_by_id(read, attempt))
  option.then(found, fn(a) {
    case a.row.player_id == player {
      True -> Some(a)
      False -> None
    }
  })
}

/// The player's attempts, newest created first.
pub fn attempts_for_player(
  read: Read,
  player: id.PlayerId,
) -> Result(List(Attempt), Fail(e)) {
  attempts_where(
    read,
    "WHERE a.player_id = ? ORDER BY a.created_at DESC, a.id DESC",
    [id.player_sql(player)],
  )
}

pub fn attempt_by_session(
  read: Read,
  session: id.BoxSessionId,
) -> Result(Option(Attempt), Fail(e)) {
  attempts_where(read, "WHERE a.box_session_id = ?", [
    id.box_session_sql(session),
  ])
  |> result.map(fn(found) { list.first(found) |> option.from_result })
}

/// How many of the player's attempts at this protocol, in one mode or any, since a moment or ever.
pub fn attempt_count(
  read: Read,
  player: id.PlayerId,
  protocol_id: String,
  mode: Option(attempt_row.Mode),
  since: Option(Int),
) -> Result(Int, Fail(e)) {
  let mode = option.map(mode, attempt_row.mode_to_string)
  store.one(
    read,
    "SELECT count(*) FROM combine_attempts WHERE player_id = ? AND protocol_id = ? AND (? IS NULL OR mode = ?) AND (? IS NULL OR created_at >= ?)",
    [
      id.player_sql(player),
      sqlight.text(protocol_id),
      sqlight.nullable(sqlight.text, mode),
      sqlight.nullable(sqlight.text, mode),
      sqlight.nullable(sqlight.int, since),
      sqlight.nullable(sqlight.int, since),
    ],
    decode.at([0], decode.int),
  )
  |> result.map(result.unwrap(_, 0))
}

/// Combine Verified attempts with a value whose session still stands, newest created first.
pub fn verified_attempts(
  read: Read,
  player: id.PlayerId,
) -> Result(List(Attempt), Fail(e)) {
  use all <- result.map(attempts_for_player(read, player))
  list.filter(all, fn(a) {
    a.row.combine_state == attempt_row.CombineVerified
    && a.row.measured_value != None
    && live_state(a) == attempt_row.CombineVerified
  })
}

fn key(a: Attempt) -> String {
  a.row.protocol_id <> "@" <> int.to_string(a.row.protocol_version)
}

/// The best verified attempt per protocol@version, in the order each protocol first appears (newest first).
pub fn bests_of(verified: List(Attempt)) -> List(Attempt) {
  let keys = list.map(verified, key) |> list.unique
  list.filter_map(keys, fn(k) {
    list.filter(verified, fn(a) { key(a) == k })
    |> list.map(fn(a) {
      rules.Scored(a, a.row.measured_value, a.row.direction, live_state(a))
    })
    |> rules.personal_best
    |> option.map(fn(s) { s.item })
    |> option.to_result(Nil)
  })
}

pub fn bests(
  read: Read,
  player: id.PlayerId,
) -> Result(List(Attempt), Fail(e)) {
  verified_attempts(read, player) |> result.map(bests_of)
}

pub fn title_of(protocol_id: String, version: Int) -> String {
  case rules.protocol(protocol_id, version) {
    Some(p) -> p.title
    None -> protocol_id
  }
}

pub fn display(a: Attempt) -> String {
  case rules.protocol(a.row.protocol_id, a.row.protocol_version) {
    Some(p) -> rules.format(p, a.row.measured_value)
    None ->
      case a.row.measured_value {
        Some(v) -> json.to_string(json_text.number(v))
        None -> "—"
      }
  }
}

// ---------------------------------------------------------------------------------------------- projection

pub const projection_note =
  "Combine Verified: measured from a standardized ScoutBox protocol during a live Box Cam session. Powered by Box Cam. Real numbers, not a talent score."

/// The Passport's own wording of the note.
pub const passport_note =
  "Combine Verified — standardized ScoutBox protocol, live Box Cam capture. Powered by Box Cam. Real numbers, not a talent score."

/// A player's personal bests, the latest completed first.
pub fn projection_results(
  read: Read,
  player: id.PlayerId,
) -> Result(List(Attempt), Fail(e)) {
  use bests <- result.map(bests(read, player))
  list.sort(bests, fn(x, y) {
    int.compare(
      option.unwrap(y.row.completed_at, 0),
      option.unwrap(x.row.completed_at, 0),
    )
  })
}

fn result_json(a: Attempt) -> Json {
  json.object([
    #("protocolId", json.string(a.row.protocol_id)),
    #("protocolVersion", json.int(a.row.protocol_version)),
    #(
      "protocolTitle",
      json.string(title_of(a.row.protocol_id, a.row.protocol_version)),
    ),
    #("metricUnit", json.string(a.row.metric_unit)),
    #("measuredValue", json.nullable(a.row.measured_value, json_text.number)),
    #("display", json.string(display(a))),
    #("combineVerified", json.bool(True)),
    #("capturedBy", json.string("box_cam")),
    #("completedAt", json.nullable(a.row.completed_at, json.int)),
  ])
}

/// The recruitment-safe projection of a player's Combine results: no raw video, date of birth, private notes or
/// integrity internals.
pub fn projection_fields(
  read: Read,
  player: id.PlayerId,
  note: String,
) -> Result(List(#(String, Json)), Fail(e)) {
  projection_results(read, player) |> result.map(projection_of(_, note))
}

/// The projection of results already read (`projection_results`).
pub fn projection_of(
  results: List(Attempt),
  note: String,
) -> List(#(String, Json)) {
  [
    #("results", json.array(results, result_json)),
    #("hasCombineVerifiedResults", json.bool(results != [])),
    #("note", json.string(note)),
  ]
}

/// Which tests had a verified result (`protocol@version`), never the measured values.
pub fn result_keys(
  read: Read,
  player: id.PlayerId,
) -> Result(List(String), Fail(e)) {
  projection_results(read, player) |> result.map(list.map(_, key))
}

// ------------------------------------------------------------------------------------------------ requests

/// A request with its protocols in order and the ones Combine Verified inside its window.
pub type Request {
  Request(row: row.Row, protocol_ids: List(String), done: List(String))
}

/// The protocols asked for that were Combine Verified between the request and the end of its deadline's day. An
/// unreadable deadline is a closed window, not an open one.
fn done_of(
  r: row.Row,
  protocol_ids: List(String),
  verified: List(Attempt),
) -> List(String) {
  let deadline = case r.deadline_date {
    None -> Ok(None)
    Some(d) ->
      temporal.parse_day(d)
      |> result.map(fn(d) { Some(temporal.day_end(d)) })
  }
  list.filter(protocol_ids, fn(pid) {
    list.any(verified, fn(a) {
      let at = option.unwrap(a.row.completed_at, 0)
      a.row.protocol_id == pid
      && at >= r.created_at
      && case deadline {
        Ok(None) -> True
        Ok(Some(end)) -> at <= end
        Error(_) -> False
      }
    })
  })
}

fn with_protocols(read: Read, r: row.Row) -> Result(Request, Fail(e)) {
  use ids <- result.try(store.query(
    read,
    "SELECT protocol_id FROM combine_request_protocols WHERE request_id = ? ORDER BY ord",
    [id.combine_request_sql(r.id)],
    decode.at([0], decode.string),
  ))
  use verified <- result.map(verified_attempts(read, r.player_id))
  Request(r, ids, done_of(r, ids, verified))
}

fn requests_where(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(List(Request), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT " <> row.columns <> " FROM combine_requests " <> where,
    args,
    row.decoder(),
  ))
  list.try_map(rows, with_protocols(read, _))
}

pub fn request_by_id(
  read: Read,
  request: id.CombineRequestId,
) -> Result(Option(Request), Fail(e)) {
  requests_where(read, "WHERE id = ?", [id.combine_request_sql(request)])
  |> result.map(fn(found) { list.first(found) |> option.from_result })
}

/// The player's requests, oldest first.
pub fn for_player(
  read: Read,
  player: id.PlayerId,
) -> Result(List(Request), Fail(e)) {
  requests_where(read, "WHERE player_id = ? ORDER BY rowid", [
    id.player_sql(player),
  ])
}

/// The organisation's requests, for one player or all, newest first.
pub fn for_org(
  read: Read,
  org_id: id.OrgId,
  player: Option(id.PlayerId),
) -> Result(List(Request), Fail(e)) {
  requests_where(
    read,
    "WHERE org_id = ? AND (? IS NULL OR player_id = ?) ORDER BY created_at DESC, id DESC",
    [
      id.org_sql(org_id),
      sqlight.nullable(id.player_sql, player),
      sqlight.nullable(id.player_sql, player),
    ],
  )
}

/// The organisation's requests to a player, newest first.
pub fn for_org_player(
  read: Read,
  org_id: id.OrgId,
  player_id: id.PlayerId,
) -> Result(List(Request), Fail(e)) {
  requests_where(
    read,
    "WHERE org_id = ? AND player_id = ? ORDER BY rowid DESC",
    [id.org_sql(org_id), id.player_sql(player_id)],
  )
}

/// The players with a completed request from the organisation.
pub fn completed_players(
  read: Read,
  org_id: id.OrgId,
) -> Result(List(id.PlayerId), Fail(e)) {
  store.query(
    read,
    "SELECT DISTINCT player_id FROM combine_requests WHERE org_id = ? AND state = 'completed'",
    [id.org_sql(org_id)],
    decode.at([0], id.player_decoder()),
  )
}

/// Results need the standing gates (checked by the caller) and either the player's recruitment opt-in or a live
/// request from this organisation: answering a request implies consent. A Room is not consent.
pub fn org_may_see_results(
  read: Read,
  org_id: id.OrgId,
  player_id: id.PlayerId,
) -> Result(Bool, Fail(e)) {
  use rows <- result.map(store.query(
    read,
    "SELECT 1 FROM box_cam_prefs WHERE player_id = ? AND share_development_activity = 'recruitment' UNION ALL SELECT 1 FROM combine_requests WHERE org_id = ? AND player_id = ? AND state <> 'cancelled' LIMIT 1",
    [id.player_sql(player_id), id.org_sql(org_id), id.player_sql(player_id)],
    decode.at([0], decode.int),
  ))
  rows != []
}

/// Whether the player shares development activity for recruitment (their Box Cam preference).
pub fn shares_development(
  read: Read,
  player_id: id.PlayerId,
) -> Result(Bool, Fail(e)) {
  use rows <- result.map(store.query(
    read,
    "SELECT 1 FROM box_cam_prefs WHERE player_id = ? AND share_development_activity = 'recruitment'",
    [id.player_sql(player_id)],
    decode.at([0], decode.int),
  ))
  rows != []
}

/// The protocol's latest version is active in the registry: a club can only select from it, never invent one.
pub fn protocol_active(protocol_id: String) -> Bool {
  case rules.latest_protocol(protocol_id) {
    Some(p) -> p.active
    None -> False
  }
}

/// Worked out at read time from the verified attempts, not from the stored state: an invalidation reopens it.
pub fn request_state(r: Request) -> String {
  case r.row.state {
    row.Cancelled -> "cancelled"
    _ ->
      case list.length(r.done) >= list.length(r.protocol_ids) {
        True -> "completed"
        False -> "requested"
      }
  }
}

pub fn request_view(r: Request) -> Json {
  json.object([
    #("id", id.combine_request_json(r.row.id)),
    #("orgId", id.org_json(r.row.org_id)),
    #("orgName", json.nullable(r.row.org_name, json.string)),
    #("title", json.nullable(r.row.title, json.string)),
    #(
      "requestedBy",
      json.object([
        #("userId", id.org_user_json(r.row.requested_by_user_id)),
        #("name", json.nullable(r.row.requested_by_name, json.string)),
        #("role", json.nullable(r.row.requested_by_role, json.string)),
        #("at", json.int(r.row.requested_at)),
      ]),
    ),
    #("playerId", id.player_json(r.row.player_id)),
    #(
      "protocols",
      json.array(r.protocol_ids, fn(pid) {
        json.object([
          #("protocolId", json.string(pid)),
          #(
            "protocolTitle",
            json.string(case rules.latest_protocol(pid) {
              Some(p) -> p.title
              None -> pid
            }),
          ),
          #("completed", json.bool(list.contains(r.done, pid))),
        ])
      }),
    ),
    #("deadline", json.nullable(r.row.deadline_date, json.string)),
    #("instructions", json.nullable(r.row.instructions, json.string)),
    #("state", json.string(request_state(r))),
    #("createdAt", json.int(r.row.created_at)),
    #("completedCount", json.int(list.length(r.done))),
    #("requiredCount", json.int(list.length(r.protocol_ids))),
    #(
      "note",
      json.string(
        "Completing a Club Combine means the standardized tests were completed and Combine Verified. It does not mean the club has selected, endorsed or rejected the player.",
      ),
    ),
  ])
}

pub type NewRequest {
  NewRequest(
    protocol_ids: List(String),
    title: Option(String),
    deadline: Option(String),
    instructions: Option(String),
  )
}

/// Creates the request for a player the organisation may already see (the caller has checked), with its ledger
/// row and the player's notice (a minor's guardian's), inside the caller's unit.
pub fn create(
  tx: Tx,
  org: orgs.Row,
  user: Staff,
  p: Player,
  new: NewRequest,
  now: Int,
) -> Result(Request, Fail(e)) {
  use request_id <- result.try(id.next_combine_request(tx))
  let r =
    row.Row(
      id: request_id,
      org_id: org.id,
      org_name: Some(org.name),
      requested_by_user_id: user.id,
      requested_by_name: Some(user.name),
      requested_by_role: Some(user.role),
      requested_at: now,
      player_id: p.row.id,
      title: new.title,
      deadline_date: new.deadline,
      instructions: new.instructions,
      state: row.Requested,
      created_at: now,
      completed_at: None,
    )
  use _ <- result.try(row.insert(tx, r))
  use _ <- result.try(
    list.index_map(new.protocol_ids, fn(pid, i) { #(pid, i) })
    |> list.try_each(fn(pair) {
      store.run(
        tx,
        "INSERT INTO combine_request_protocols (request_id, ord, protocol_id) VALUES (?, ?, ?)",
        [
          id.combine_request_sql(request_id),
          sqlight.int(pair.1),
          sqlight.text(pair.0),
        ],
      )
    }),
  )
  use _ <- result.try(ledger.append(
    tx,
    ledger.Entry(
      event: ledger.CombineRequestCreated(request_id, new.protocol_ids),
      player_id: Some(p.row.id),
      org_id: Some(org.id),
      org_name: Some(org.name),
      user_id: Some(user.id),
      actor_name: Some(user.name),
    ),
    now,
  ))
  let n = list.length(new.protocol_ids)
  let msg =
    org.name
    <> " requested an At-Home Combine"
    <> case new.title {
      Some(t) -> ": " <> t
      None -> ""
    }
    <> " ("
    <> int.to_string(n)
    <> " test"
    <> case n > 1 {
      True -> "s"
      False -> ""
    }
    <> "). Powered by Box Cam."
  use _ <- result.try(case players.is_adult(p, now), p.row.guardian_id {
    False, Some(g) ->
      notifications.notify(
        tx,
        to: audience.Guardian,
        id: id.guardian_to_string(g),
        type_: "combine",
        text: p.row.name <> ": " <> msg,
        ref_id: Some(id.combine_request_to_string(request_id)),
        at: now,
      )
    _, _ ->
      notifications.notify(
        tx,
        to: audience.Player,
        id: id.player_to_string(p.row.id),
        type_: "combine",
        text: msg,
        ref_id: Some(id.combine_request_to_string(request_id)),
        at: now,
      )
  })
  with_protocols(store.reading(tx), r)
}

/// The club withdraws a request not yet completed.
pub fn cancel_request(
  tx: Tx,
  request: id.CombineRequestId,
) -> Result(Nil, Fail(e)) {
  use moved <- result.try(store.write(
    tx,
    "UPDATE combine_requests SET state = 'cancelled' WHERE id = ? AND state <> 'completed' RETURNING id",
    [id.combine_request_sql(request)],
    decode.at([0], decode.string),
  ))
  case moved {
    [] -> store.stale("combine request")
    _ -> Ok(Nil)
  }
}

// -------------------------------------------------------------------------------------- attempts' writes

pub type NewAttempt {
  NewAttempt(
    player: id.PlayerId,
    protocol: Protocol,
    session: session_row.Row,
    attempt_number: Int,
    mode: attempt_row.Mode,
    capture_context: capture_context.CaptureContext,
    request: Option(id.CombineRequestId),
    provider: box_rules.Provider,
  )
}

/// A new attempt bound to its freshly minted session. A protocol that needs no physical-scale calibration has
/// passed the standardised geometry check already.
pub fn create_attempt(
  tx: Tx,
  new: NewAttempt,
  now: Int,
) -> Result(Attempt, Fail(e)) {
  use attempt_id <- result.try(id.next_combine_attempt(tx))
  let calibrated = new.protocol.calibration_requirements == []
  let r =
    attempt_row.Row(
      ..attempt_row.new(
        id: attempt_id,
        player_id: new.player,
        protocol_id: new.protocol.id,
        protocol_version: new.protocol.version,
        box_session_id: new.session.id,
        attempt_number: new.attempt_number,
        mode: new.mode,
        capture_context: new.capture_context,
        metric_type: new.protocol.metric_type,
        metric_unit: new.protocol.metric_unit,
        direction: new.protocol.direction,
        measurement_algorithm_version: new.protocol.measurement_algorithm_version,
        provider_id: new.provider.id,
        provider_version: new.provider.version,
        combine_state: attempt_row.Ready,
        created_at: now,
      ),
      request_id: new.request,
      calibration_passed: case calibrated {
        True -> Some(True)
        False -> None
      },
      calibrated_at: case calibrated {
        True -> Some(now)
        False -> None
      },
    )
  use _ <- result.try(attempt_row.insert(tx, r))
  let checks = case calibrated {
    True -> ["geometry_ready_check"]
    False -> []
  }
  use _ <- result.try(write_checks(tx, attempt_id, checks))
  Ok(Attempt(r, [], checks, new.session.verification_state))
}

fn write_checks(
  tx: Tx,
  attempt: id.CombineAttemptId,
  checks: List(String),
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(
    store.run(
      tx,
      "DELETE FROM combine_attempt_calibration_checks WHERE attempt_id = ?",
      [id.combine_attempt_sql(attempt)],
    ),
  )
  list.index_map(checks, fn(c, i) { #(c, i) })
  |> list.try_each(fn(pair) {
    store.run(
      tx,
      "INSERT INTO combine_attempt_calibration_checks (attempt_id, ord, check_name) VALUES (?, ?, ?)",
      [
        id.combine_attempt_sql(attempt),
        sqlight.int(pair.1),
        sqlight.text(pair.0),
      ],
    )
  })
}

/// An update of an attempt that is still `ready`; another request finishing it first is a lost race.
fn while_ready(
  tx: Tx,
  attempt: id.CombineAttemptId,
  set: String,
  args: List(sqlight.Value),
) -> Result(Nil, Fail(e)) {
  use moved <- result.try(store.write(
    tx,
    "UPDATE combine_attempts SET "
      <> set
      <> " WHERE id = ? AND combine_state = 'ready' RETURNING id",
    list.append(args, [id.combine_attempt_sql(attempt)]),
    decode.at([0], decode.string),
  ))
  case moved {
    [] -> store.stale("combine attempt")
    _ -> Ok(Nil)
  }
}

/// The calibration checks the player ran, replacing any earlier run.
pub fn calibrate(
  tx: Tx,
  attempt: id.CombineAttemptId,
  passed: Bool,
  checks: List(String),
  at: Int,
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(
    while_ready(tx, attempt, "calibration_passed = ?, calibrated_at = ?", [
      sqlight.bool(passed),
      sqlight.int(at),
    ]),
  )
  write_checks(tx, attempt, checks)
}

/// The bound session's recording start, copied when the player submits the attempt.
pub fn mark_started(
  tx: Tx,
  attempt: id.CombineAttemptId,
  started_at: Option(Int),
) -> Result(Nil, Fail(e)) {
  while_ready(tx, attempt, "started_at = ?", [
    sqlight.nullable(sqlight.int, started_at),
  ])
}

/// The player abandons the attempt.
pub fn cancel_attempt(
  tx: Tx,
  attempt: id.CombineAttemptId,
  at: Int,
) -> Result(Nil, Fail(e)) {
  while_ready(
    tx,
    attempt,
    "combine_state = 'cancelled', measurement_state = 'cancelled', completed_at = ?",
    [sqlight.int(at)],
  )
}

// ----------------------------------------------------------------------------------- the measurement hook

/// Works out the measurement of the attempt bound to a session that has just finished, inside the session's
/// completion unit, and moves on the requests it completes. A session bound to no attempt, or to a finished one,
/// is left alone.
pub fn apply_progress(
  tx: Tx,
  session: session_row.Row,
  player: Player,
  now: Int,
) -> Result(Nil, Fail(e)) {
  let read = store.reading(tx)
  use found <- result.try(attempt_by_session(read, session.id))
  case found {
    Some(a) if a.row.combine_state == attempt_row.Ready ->
      measure(tx, a, session, player, now)
    _ -> Ok(Nil)
  }
}

fn measure(
  tx: Tx,
  a: Attempt,
  session: session_row.Row,
  player: Player,
  now: Int,
) -> Result(Nil, Fail(e)) {
  let proto = rules.protocol(a.row.protocol_id, a.row.protocol_version)
  let calibration_passed = case a.row.calibration_passed, proto {
    Some(passed), _ -> passed
    None, Some(p) -> p.calibration_requirements == []
    None, None -> True
  }
  let m =
    rules.measure(
      protocol: proto,
      session: Some(rules.finished(session)),
      calibration_passed:,
      // The Combine list, not the observation list.
      capabilities: rules.combine_capabilities(session.provider_id),
      practice: a.row.mode == attempt_row.ModePractice,
    )
  let hash =
    rules.result_hash(rules.Hashed(
      player_id: id.player_to_string(a.row.player_id),
      attempt_id: id.combine_attempt_to_string(a.row.id),
      protocol_id: a.row.protocol_id,
      protocol_version: a.row.protocol_version,
      box_session_id: id.box_session_to_string(a.row.box_session_id),
      metric_type: a.row.metric_type,
      measured_value: m.measured_value,
      provider: a.row.provider_id,
      provider_version: a.row.provider_version,
      measurement_algorithm_version: a.row.measurement_algorithm_version,
      completed_at: Some(now),
      combine_state: m.combine_state,
    ))
  use _ <- result.try(
    while_ready(
      tx,
      a.row.id,
      "measured_value = ?, measurement_state = ?, combine_state = ?, completed_at = ?, result_hash = ?",
      [
        sqlight.nullable(sqlight.float, m.measured_value),
        sqlight.text(attempt_row.measurement_state_to_string(
          m.measurement_state,
        )),
        sqlight.text(attempt_row.combine_state_to_string(m.combine_state)),
        sqlight.int(now),
        sqlight.text(hash),
      ],
    ),
  )
  use _ <- result.try(
    store.run(tx, "DELETE FROM combine_attempt_reasons WHERE attempt_id = ?", [
      id.combine_attempt_sql(a.row.id),
    ]),
  )
  use _ <- result.try(
    list.index_map(m.reasons, fn(r, i) { #(rules.reason_to_string(r), i) })
    |> list.try_each(fn(pair) {
      store.run(
        tx,
        "INSERT INTO combine_attempt_reasons (attempt_id, ord, code) VALUES (?, ?, ?)",
        [
          id.combine_attempt_sql(a.row.id),
          sqlight.int(pair.1),
          sqlight.text(pair.0),
        ],
      )
    }),
  )
  use _ <- result.try(count(tx, "combine_attempt_completed"))
  use _ <- result.try(case m.combine_state {
    attempt_row.CombineVerified -> count(tx, "combine_attempt_verified")
    attempt_row.CombineStatePartiallyMeasured ->
      count(tx, "combine_attempt_incomplete")
    _ -> Ok(Nil)
  })
  use _ <- result.try(ledger.append(
    tx,
    ledger.Entry(
      event: ledger.CombineAttemptCompleted(
        a.row.id,
        a.row.protocol_id <> "@" <> int.to_string(a.row.protocol_version),
        m.combine_state,
      ),
      player_id: Some(player.row.id),
      org_id: None,
      org_name: None,
      user_id: None,
      actor_name: None,
    ),
    now,
  ))
  live_pings.catalogue(
    tx,
    live_event.PlayerDevelopmentEvidenceChanged(id.player_to_string(
      player.row.id,
    )),
  )
  let label = case proto {
    Some(p) -> p.title
    None -> a.row.protocol_id
  }
  let notify = fn(text) {
    notifications.notify(
      tx,
      to: audience.Player,
      id: id.player_to_string(player.row.id),
      type_: "combine",
      text:,
      ref_id: Some(id.combine_attempt_to_string(a.row.id)),
      at: now,
    )
  }
  case a.row.mode, m.combine_state {
    attempt_row.Verified, attempt_row.CombineVerified -> {
      let shown = case proto {
        Some(p) -> rules.format(p, m.measured_value)
        None -> "—"
      }
      use _ <- result.try(notify(
        "Combine Verified: "
        <> label
        <> " — "
        <> shown
        <> " "
        <> a.row.metric_unit
        <> ". Record it. Prove it.",
      ))
      apply_request_progress(tx, player, now)
    }
    attempt_row.Verified, state ->
      notify(
        label <> ": " <> option.unwrap(rules.state_copy(state), "recorded"),
      )
    attempt_row.ModePractice, _ -> Ok(Nil)
  }
}

/// Every open request whose protocols are now all Combine Verified completes, once, and tells the colleague who
/// asked, while they still work there.
fn apply_request_progress(
  tx: Tx,
  player: Player,
  now: Int,
) -> Result(Nil, Fail(e)) {
  let read = store.reading(tx)
  use requests <- result.try(for_player(read, player.row.id))
  list.filter(requests, fn(r) { r.row.state == row.Requested })
  |> list.try_each(fn(r) {
    case list.length(r.done) >= list.length(r.protocol_ids) {
      False -> Ok(Nil)
      True -> {
        use moved <- result.try(store.write(
          tx,
          "UPDATE combine_requests SET state = 'completed', completed_at = ? WHERE id = ? AND state = 'requested' RETURNING id",
          [sqlight.int(now), id.combine_request_sql(r.row.id)],
          decode.at([0], decode.string),
        ))
        use <- bool_guard(moved == [])
        use _ <- result.try(count(tx, "combine_request_completed"))
        use lead <- result.try(staff.by_id(read, r.row.requested_by_user_id))
        use _ <- result.try(case lead {
          Some(u) if u.removed_at == None ->
            notifications.notify(
              tx,
              to: audience.OrgUser,
              id: id.org_user_to_string(u.id),
              type_: "combine",
              text: player.row.name
                <> " completed your Club Combine"
                <> case r.row.title {
                Some(t) -> ": " <> t
                None -> ""
              }
                <> ".",
              ref_id: Some(id.combine_request_to_string(r.row.id)),
              at: now,
            )
          _ -> Ok(Nil)
        })
        ledger.append(
          tx,
          ledger.Entry(
            event: ledger.CombineRequestCompleted(r.row.id),
            player_id: Some(player.row.id),
            org_id: Some(r.row.org_id),
            org_name: r.row.org_name,
            user_id: None,
            actor_name: None,
          ),
          now,
        )
        |> result.replace(Nil)
      }
    }
  })
}

fn bool_guard(
  skip: Bool,
  next: fn() -> Result(Nil, Fail(e)),
) -> Result(Nil, Fail(e)) {
  case skip {
    True -> Ok(Nil)
    False -> next()
  }
}
