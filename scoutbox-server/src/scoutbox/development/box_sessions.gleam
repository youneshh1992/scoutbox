//// Box Sessions' records (repositories/boxCam.mjs `sessions`) and what the routes show of them
//// (domains/development/boxcam/sessions.mjs `sessionView`, `finalize`).
////
//// The server mints every session (id, nonce, liveness challenge, expiry). Clients stream aggregated observations,
//// never frames or video; the result is derived only from the accepted observations and the server's clock. The
//// nonce is stored only as its hash.

import gleam/bit_array
import gleam/crypto
import gleam/dynamic/decode
import gleam/float
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/development/box_cam_rules.{
  type Drill, type Interval, type Span, Interval, Span,
} as rules
import scoutbox/platform/json_text
import scoutbox/platform/secrets
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/box_assignments as assignment_row
import scoutbox/rows/box_challenge_entries as entry_row
import scoutbox/rows/box_challenges as challenge_row
import scoutbox/rows/box_session_observations as obs_row
import scoutbox/rows/box_session_reasons as reason_row
import scoutbox/rows/box_sessions as row
import scoutbox/rows/id
import scoutbox/vocab/box_provider
import scoutbox/vocab/box_quality
import scoutbox/vocab/box_target_type
import sqlight

/// Allowed drift between a real provider's clock and the server's.
pub const drift_ms = 7000

pub const ttl_ms = 7_200_000

pub const max_events_per_batch = 200

pub const max_batches_per_session = 500

pub const max_stored_intervals = 2000

pub const max_observations = 4000

/// A session and the reasons for its verification state, in order.
pub type Session {
  Session(row: row.Row, reasons: List(String))
}

fn reasons_of(
  read: Read,
  session: id.BoxSessionId,
) -> Result(List(String), Fail(e)) {
  store.query(
    read,
    "SELECT code FROM box_session_reasons WHERE session_id = ? ORDER BY ord",
    [id.box_session_sql(session)],
    decode.at([0], decode.string),
  )
}

fn with_reasons(
  read: Read,
  rows: List(row.Row),
) -> Result(List(Session), Fail(e)) {
  list.try_map(rows, fn(r) {
    reasons_of(read, r.id) |> result.map(Session(r, _))
  })
}

pub fn by_id(
  read: Read,
  session: id.BoxSessionId,
) -> Result(Option(Session), Fail(e)) {
  use found <- result.try(store.one(
    read,
    "SELECT " <> row.columns <> " FROM box_sessions WHERE id = ?",
    [id.box_session_sql(session)],
    row.decoder(),
  ))
  case found {
    Ok(r) ->
      reasons_of(read, r.id) |> result.map(fn(rs) { Some(Session(r, rs)) })
    Error(Nil) -> Ok(None)
  }
}

/// The player's own session, or None (another player's is never found).
pub fn own(
  read: Read,
  player: id.PlayerId,
  session: id.BoxSessionId,
) -> Result(Option(Session), Fail(e)) {
  by_id(read, session)
  |> result.map(
    option.then(_, fn(s) {
      case s.row.player_id == player {
        True -> Some(s)
        False -> None
      }
    }),
  )
}

pub fn by_ids(
  read: Read,
  ids: List(id.BoxSessionId),
) -> Result(List(Session), Fail(e)) {
  list.try_map(ids, by_id(read, _))
  |> result.map(option.values)
}

const finished_sql =
  "status IN ('verified','partially_verified','unable_to_verify','completed_unverified','cancelled','invalidated')"

/// The player's finished sessions (a terminal status), newest ended first; `limit` caps the list.
pub fn finished_for_player(
  read: Read,
  player: id.PlayerId,
  limit: Option(Int),
) -> Result(List(Session), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> row.columns
      <> " FROM box_sessions WHERE player_id = ? AND "
      <> finished_sql
      <> " ORDER BY ended_at IS NULL, ended_at DESC, id DESC LIMIT ?",
    [id.player_sql(player), sqlight.int(option.unwrap(limit, -1))],
    row.decoder(),
  ))
  with_reasons(read, rows)
}

/// The sessions run against an assignment, in the order they were minted.
pub fn for_assignment(
  read: Read,
  assignment: id.BoxAssignmentId,
) -> Result(List(Session), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> row.columns
      <> " FROM box_sessions WHERE assignment_id = ? ORDER BY rowid",
    [id.box_assignment_sql(assignment)],
    row.decoder(),
  ))
  with_reasons(read, rows)
}

pub fn observation_count(
  read: Read,
  session: id.BoxSessionId,
) -> Result(Int, Fail(e)) {
  store.one(
    read,
    "SELECT count(*) FROM box_session_observations WHERE session_id = ?",
    [id.box_session_sql(session)],
    decode.at([0], decode.int),
  )
  |> result.map(result.unwrap(_, 0))
}

/// The observations of the four bounded kinds (the storage limit).
pub fn stored_intervals(
  read: Read,
  session: id.BoxSessionId,
) -> Result(Int, Fail(e)) {
  store.one(
    read,
    "SELECT count(*) FROM box_session_observations WHERE session_id = ? AND kind IN ('active','presence','ball','rep')",
    [id.box_session_sql(session)],
    decode.at([0], decode.int),
  )
  |> result.map(result.unwrap(_, 0))
}

// ------------------------------------------------------------------------------------------------ the stream

/// The accepted stream as the engine reads it. A pause still open has no end.
pub type Observations {
  Observations(
    active: List(Interval),
    presence: List(Interval),
    ball: List(Span),
    reps: List(rules.Rep),
    sets: List(Float),
    pauses: List(#(Float, Option(Float))),
    interruptions: List(Span),
    multi_person: List(Span),
  )
}

pub fn observations_of(
  read: Read,
  session: id.BoxSessionId,
) -> Result(Observations, Fail(e)) {
  use rows <- result.map(store.query(
    read,
    "SELECT "
      <> obs_row.columns
      <> " FROM box_session_observations WHERE session_id = ? ORDER BY ord",
    [id.box_session_sql(session)],
    obs_row.decoder(),
  ))
  let empty = Observations([], [], [], [], [], [], [], [])
  let o =
    list.fold(rows, empty, fn(o, r) {
      let from = option.unwrap(r.from_ms, 0.0)
      let to = option.unwrap(r.to_ms, 0.0)
      let at = option.unwrap(r.at_ms, 0.0)
      let quality = option.unwrap(r.quality, box_quality.Good)
      case r.kind {
        obs_row.Active ->
          Observations(..o, active: [Interval(from, to, quality), ..o.active])
        obs_row.Presence ->
          Observations(..o, presence: [
            Interval(from, to, quality),
            ..o.presence
          ])
        obs_row.Ball -> Observations(..o, ball: [Span(from, to), ..o.ball])
        obs_row.Rep ->
          Observations(..o, reps: [rules.Rep(at, r.confidence), ..o.reps])
        obs_row.Set -> Observations(..o, sets: [at, ..o.sets])
        obs_row.Pause ->
          Observations(..o, pauses: [#(from, r.to_ms), ..o.pauses])
        obs_row.Interruption ->
          Observations(..o, interruptions: [Span(from, to), ..o.interruptions])
        obs_row.MultiPerson ->
          Observations(..o, multi_person: [Span(from, to), ..o.multi_person])
      }
    })
  Observations(
    active: list.reverse(o.active),
    presence: list.reverse(o.presence),
    ball: list.reverse(o.ball),
    reps: list.reverse(o.reps),
    sets: list.reverse(o.sets),
    pauses: list.reverse(o.pauses),
    interruptions: list.reverse(o.interruptions),
    multi_person: list.reverse(o.multi_person),
  )
}

/// An accepted observation, or a `resume` that closes the earliest open pause.
pub type Accepted {
  Observe(obs_row.Row)
  Resume(at_ms: Float)
}

/// Appends one accepted batch, then moves the sequence on and counts the batch. A session that stopped recording
/// or whose sequence moved since it was read is stale.
pub fn record_batch(
  tx: Tx,
  session: Session,
  accepted: List(Accepted),
  last_seq: Int,
) -> Result(Nil, Fail(e)) {
  let sid = session.row.id
  use moved <- result.try(store.write(
    tx,
    "UPDATE box_sessions SET last_seq = ?, batches = batches + 1 WHERE id = ? AND status = 'recording' AND last_seq = ? RETURNING id",
    [
      sqlight.int(last_seq),
      id.box_session_sql(sid),
      sqlight.int(session.row.last_seq),
    ],
    decode.at([0], decode.string),
  ))
  use <- guard_moved(moved, "box session")
  use start <- result.try(observation_count(store.reading(tx), sid))
  list.try_fold(accepted, start, fn(ord, a) {
    case a {
      Observe(o) ->
        obs_row.insert(tx, obs_row.Row(..o, session_id: sid, ord:))
        |> result.replace(ord + 1)
      Resume(at_ms) ->
        store.run(
          tx,
          "UPDATE box_session_observations SET to_ms = ? WHERE session_id = ? AND ord = (SELECT ord FROM box_session_observations WHERE session_id = ? AND kind = 'pause' AND to_ms IS NULL ORDER BY ord LIMIT 1)",
          [
            sqlight.float(at_ms),
            id.box_session_sql(sid),
            id.box_session_sql(sid),
          ],
        )
        |> result.replace(ord)
    }
  })
  |> result.replace(Nil)
}

fn guard_moved(
  rows: List(a),
  what: String,
  next: fn() -> Result(Nil, Fail(e)),
) -> Result(Nil, Fail(e)) {
  case rows {
    [] -> store.stale(what)
    _ -> next()
  }
}

// ---------------------------------------------------------------------------------------------- minting

/// A new server-minted session and its plain nonce, which only the response that mints it carries.
pub fn mint(
  tx: Tx,
  player: id.PlayerId,
  drill: Drill,
  target: rules.Target,
  provider: rules.Provider,
  assignment: Option(id.BoxAssignmentId),
  challenge_entry: Option(id.BoxChallengeEntryId),
  capture_context: Option(_),
  now: Int,
) -> Result(#(row.Row, String), Fail(e)) {
  use sid <- result.try(id.next_box_session(tx))
  let nonce =
    crypto.strong_random_bytes(18) |> bit_array.base64_url_encode(False)
  let challenges = row.liveness_challenge_pairs
  let assert Ok(#(_, challenge)) =
    list.drop(challenges, int.random(list.length(challenges))) |> list.first
  let r =
    row.Row(
      ..row.new(
        id: sid,
        player_id: player,
        drill_id: drill.id,
        drill_version: drill.version,
        target_type: target.type_,
        target_value: target.value,
        nonce_hash: secrets.sha256_hex(nonce),
        liveness_challenge: challenge,
        provider_id: provider.id,
        provider_version: provider.version,
        status: row.SetupRequired,
        created_at: now,
        expires_at: now + ttl_ms,
        last_seq: 0,
        batches: 0,
      ),
      assignment_id: assignment,
      challenge_entry_id: challenge_entry,
      capture_context:,
    )
  row.insert(tx, r) |> result.replace(#(r, nonce))
}

/// Does the plain nonce a client sent match the stored hash? A missing nonce never matches.
pub fn nonce_matches(r: row.Row, nonce: Option(String)) -> Bool {
  case nonce {
    Some(n) if n != "" -> secrets.equal(secrets.sha256_hex(n), r.nonce_hash)
    _ -> False
  }
}

pub fn is_terminal(status: row.Status) -> Bool {
  case status {
    row.SetupRequired | row.Recording | row.Processing -> False
    _ -> True
  }
}

fn guarded_update(
  tx: Tx,
  set: String,
  args: List(sqlight.Value),
  session: id.BoxSessionId,
  condition: String,
) -> Result(Nil, Fail(e)) {
  use moved <- result.try(store.write(
    tx,
    "UPDATE box_sessions SET "
      <> set
      <> " WHERE id = ? AND "
      <> condition
      <> " RETURNING id",
    list.append(args, [id.box_session_sql(session)]),
    decode.at([0], decode.string),
  ))
  guard_moved(moved, "box session", fn() { Ok(Nil) })
}

/// Liveness passed: recording starts.
pub fn start(
  tx: Tx,
  session: id.BoxSessionId,
  at: Int,
) -> Result(Nil, Fail(e)) {
  guarded_update(
    tx,
    "status = 'recording', liveness_passed_at = ?, started_at = ?",
    [sqlight.int(at), sqlight.int(at)],
    session,
    "status = 'setup_required'",
  )
}

/// The session expired before it started.
pub fn expire(tx: Tx, session: id.BoxSessionId) -> Result(Nil, Fail(e)) {
  guarded_update(
    tx,
    "status = 'cancelled'",
    [],
    session,
    "status = 'setup_required'",
  )
}

/// Cancelled with no result to work out.
pub fn cancel(tx: Tx, session: id.BoxSessionId) -> Result(Nil, Fail(e)) {
  guarded_update(
    tx,
    "status = 'cancelled', verification_state = 'cancelled'",
    [],
    session,
    "NOT " <> finished_sql,
  )
}

/// The player's note on a finished session.
pub fn set_note(
  tx: Tx,
  session: id.BoxSessionId,
  note: String,
) -> Result(Nil, Fail(e)) {
  guarded_update(tx, "note = ?", [sqlight.text(note)], session, finished_sql)
}

/// The player's kept clip of a finished session: one of their own media items.
pub fn attach_clip(
  tx: Tx,
  session: id.BoxSessionId,
  media: id.MediaId,
) -> Result(Nil, Fail(e)) {
  guarded_update(
    tx,
    "clip_media_id = ?",
    [sqlight.text(id.media_to_string(media))],
    session,
    finished_sql,
  )
}

// ---------------------------------------------------------------------------------------------- finalizing

/// What `finalize` works out from the accepted stream.
pub type Outcome {
  Outcome(
    ended_at: Int,
    session_duration_ms: Float,
    verified_active_ms: Float,
    verified_reps: Option(Int),
    sets_completed: Option(Int),
    target_completed: Option(Bool),
    quality: box_quality.BoxQuality,
    interruptions_count: Int,
    state: row.VerificationState,
    reasons: List(rules.Reason),
    result_hash: String,
  )
}

pub fn status_of(state: row.VerificationState) -> row.Status {
  case state {
    row.VerificationStateVerified -> row.StatusVerified
    row.VerificationStatePartiallyVerified -> row.StatusPartiallyVerified
    row.VerificationStateUnableToVerify -> row.StatusUnableToVerify
    row.VerificationStateCompletedUnverified -> row.StatusCompletedUnverified
    row.VerificationStateCancelled -> row.StatusCancelled
    row.VerificationStateInvalidated -> row.StatusInvalidated
  }
}

fn latest(spans: List(Float)) -> Float {
  list.fold(spans, 0.0, float.max)
}

/// The result of a recording, from the accepted stream and the server's clock. For the test-only fixture provider
/// the session lasted as long as its observation stream (within the session lifetime); otherwise from its start to
/// now.
pub fn finalize(
  r: row.Row,
  o: Observations,
  cancelled: Bool,
  now: Int,
) -> Outcome {
  let drill = rules.drill_by_id_version(r.drill_id, r.drill_version)
  let provider = rules.provider(r.provider_id)
  let capabilities = rules.session_capabilities(drill, r.provider_id)
  let duration = case provider.test_only {
    True ->
      list.flatten([
        list.map(o.active, fn(iv) { iv.to_ms }),
        list.map(o.presence, fn(iv) { iv.to_ms }),
        list.map(o.ball, fn(s) { s.to_ms }),
        list.map(o.interruptions, fn(s) { s.to_ms }),
        list.map(o.multi_person, fn(s) { s.to_ms }),
        list.map(o.reps, fn(rep) { rep.at_ms }),
        o.sets,
        list.flat_map(o.pauses, fn(p) { [option.unwrap(p.1, 0.0), p.0] }),
      ])
      |> latest
      |> float.min(int.to_float(ttl_ms))
    False ->
      case r.started_at {
        Some(started) -> int.to_float(int.max(0, now - started))
        None -> 0.0
      }
  }
  let cuts =
    list.flatten([
      o.interruptions,
      // Several people in frame pause observation: no face recognition, no guessing.
      o.multi_person,
      list.map(o.pauses, fn(p) { Span(p.0, option.unwrap(p.1, duration)) }),
    ])
  let ball_required = case drill {
    Some(d) ->
      list.contains(d.setup.equipment, "ball")
      && list.contains(capabilities, rules.BallPresence)
    None -> False
  }
  let active_ms =
    rules.verified_active_ms(
      active: o.active,
      pauses: [],
      interruptions: cuts,
      session_duration_ms: duration,
      required: case ball_required {
        True -> Some(o.ball)
        False -> None
      },
    )
  let presence_ms =
    rules.norm_intervals(o.presence, Some(duration))
    |> list.map(fn(iv) { Span(iv.from_ms, iv.to_ms) })
    |> rules.merge_intervals
    |> rules.sum_intervals
  let #(gap, confidence) = case drill {
    Some(d) -> #(d.rep_min_gap_ms, d.rep_min_confidence)
    None -> #(250.0, 0.5)
  }
  let reps = case list.contains(capabilities, rules.RepCount) {
    True ->
      Some(
        list.length(rules.dedupe_reps(
          o.reps,
          session_duration_ms: Some(duration),
          min_gap_ms: gap,
          min_confidence: confidence,
        )),
      )
    False -> None
  }
  let sets = case list.contains(capabilities, rules.IntervalCompletion) {
    True -> Some(list.length(o.sets))
    False -> None
  }
  let target = rules.Target(r.target_type, r.target_value)
  let completed =
    rules.target_completed(
      target,
      active_ms: active_ms,
      reps: reps,
      sets_completed: option.unwrap(sets, 0),
      capabilities: capabilities,
    )
  let quality =
    rules.detection_quality(
      observed_ms: float.max(presence_ms, active_ms),
      session_duration_ms: duration,
    )
  let interruptions = list.length(o.interruptions) + list.length(o.multi_person)
  let #(state, reasons) =
    rules.derive_verification(rules.Observed(
      cancelled:,
      liveness_passed: option.is_some(r.liveness_passed_at),
      provider_available: True,
      active_ms:,
      completed:,
      quality: Some(quality),
      interruptions_count: interruptions,
      unsupported_target_metric: completed == None,
    ))
  let rep_unsupported = case drill {
    Some(d) -> !d.rep_support && r.target_type == box_target_type.Repetitions
    None -> False
  }
  let reasons = case
    rep_unsupported && !list.contains(reasons, rules.RepCountNotConfigured)
  {
    True -> list.append(reasons, [rules.RepCountNotConfigured])
    False -> reasons
  }
  let hash =
    rules.result_hash(rules.Hashed(
      id: id.box_session_to_string(r.id),
      player_id: id.player_to_string(r.player_id),
      drill_id: r.drill_id,
      drill_version: r.drill_version,
      target:,
      started_at: r.started_at,
      ended_at: Some(now),
      session_duration_ms: duration,
      verified_active_ms: active_ms,
      verified_reps: reps,
      sets_completed: sets,
      state:,
      provider: r.provider_id,
      provider_version: r.provider_version,
    ))
  Outcome(
    ended_at: now,
    session_duration_ms: duration,
    verified_active_ms: active_ms,
    verified_reps: reps,
    sets_completed: sets,
    target_completed: completed,
    quality:,
    interruptions_count: interruptions,
    state:,
    reasons:,
    result_hash: hash,
  )
}

/// Records the result, once: the recording ends. A session no longer recording is stale.
pub fn finish(
  tx: Tx,
  session: id.BoxSessionId,
  f: Outcome,
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(guarded_update(
    tx,
    "status = ?, ended_at = ?, session_duration_ms = ?, verified_active_ms = ?, verified_reps = ?, sets_completed = ?, target_completed = ?, quality = ?, interruptions_count = ?, verification_state = ?, result_hash = ?, finalized_at = ?",
    [
      sqlight.text(row.status_to_string(status_of(f.state))),
      sqlight.int(f.ended_at),
      sqlight.float(f.session_duration_ms),
      sqlight.float(f.verified_active_ms),
      sqlight.nullable(sqlight.int, f.verified_reps),
      sqlight.nullable(sqlight.int, f.sets_completed),
      sqlight.nullable(sqlight.bool, f.target_completed),
      sqlight.text(box_quality.to_string(f.quality)),
      sqlight.int(f.interruptions_count),
      sqlight.text(row.verification_state_to_string(f.state)),
      sqlight.text(f.result_hash),
      sqlight.int(f.ended_at),
    ],
    session,
    "status = 'recording'",
  ))
  use _ <- result.try(
    store.run(tx, "DELETE FROM box_session_reasons WHERE session_id = ?", [
      id.box_session_sql(session),
    ]),
  )
  list.index_map(f.reasons, fn(reason, i) { #(reason, i) })
  |> list.try_each(fn(pair) {
    reason_row.insert(
      tx,
      reason_row.Row(
        session_id: session,
        ord: pair.1,
        code: rules.reason_to_string(pair.0),
      ),
    )
  })
}

// ---------------------------------------------------------------------------------------------------- views

fn number(value: Option(Float)) -> Json {
  json.nullable(value, json_text.number)
}

fn counts(state: Option(row.VerificationState)) -> Bool {
  state == Some(row.VerificationStateVerified)
  || state == Some(row.VerificationStatePartiallyVerified)
}

pub fn target_json(r: row.Row) -> Json {
  json.object([
    #("type", box_target_type.to_json(r.target_type)),
    #("value", json_text.number(r.target_value)),
  ])
}

pub fn drill_title(drill_id: String) -> String {
  case rules.latest_drill(drill_id) {
    Some(d) -> d.title
    None -> drill_id
  }
}

/// A session as its player, their guardian and their club see it; Trust & Safety also sees its integrity fields.
pub fn view(s: Session, integrity: Bool) -> Json {
  let r = s.row
  let observed = counts(r.verification_state)
  json.object(
    list.flatten([
      [
        #("id", id.box_session_json(r.id)),
        #("playerId", id.player_json(r.player_id)),
        #("drillId", json.string(r.drill_id)),
        #("drillVersion", json.int(r.drill_version)),
        #("drillTitle", json.string(drill_title(r.drill_id))),
        #(
          "assignmentId",
          json.nullable(r.assignment_id, id.box_assignment_json),
        ),
        #(
          "challengeEntryIds",
          json.array(
            option.values([r.challenge_entry_id]),
            id.box_challenge_entry_json,
          ),
        ),
        #("target", target_json(r)),
        #("status", row.status_to_json(r.status)),
        #("startedAt", json.nullable(r.started_at, json.int)),
        #("endedAt", json.nullable(r.ended_at, json.int)),
        #("sessionDurationMs", number(r.session_duration_ms)),
        #("verifiedActiveMs", number(r.verified_active_ms)),
        #("verifiedReps", json.nullable(r.verified_reps, json.int)),
        #("setsCompleted", json.nullable(r.sets_completed, json.int)),
        #("targetCompleted", json.nullable(r.target_completed, json.bool)),
        #(
          "verificationState",
          json.nullable(r.verification_state, row.verification_state_to_json),
        ),
        #("verificationReasons", json.array(s.reasons, json.string)),
        #(
          "stateCopy",
          json.nullable(
            option.map(r.verification_state, rules.state_copy),
            json.string,
          ),
        ),
        #("quality", json.nullable(r.quality, box_quality.to_json)),
        #("interruptions", json.int(option.unwrap(r.interruptions_count, 0))),
        #("provider", box_provider.to_json(r.provider_id)),
        #("providerVersion", json.int(r.provider_version)),
        // Never hide that a fixture drove this.
        #("simulated", json.bool(rules.provider(r.provider_id).test_only)),
        #("note", json.nullable(r.note, json.string)),
        #("provenance", case observed {
          True -> json.string("box_cam_observed")
          False -> json.null()
        }),
        #("provenanceLabel", case r.verification_state {
          Some(row.VerificationStateVerified) -> json.string("Box Cam Verified")
          Some(row.VerificationStatePartiallyVerified) ->
            json.string("Captured by Box Cam")
          _ -> json.null()
        }),
        #("provenanceDetail", case observed {
          True ->
            json.string(rules.box_cam_detail(
              option.unwrap(r.verified_active_ms, 0.0),
              r.verified_reps,
            ))
          False -> json.null()
        }),
        #("createdAt", json.int(r.created_at)),
      ],
      case integrity {
        False -> []
        True -> [
          #("resultHash", json.nullable(r.result_hash, json.string)),
          #(
            "integrity",
            json.object([
              #("minted", json.string("server")),
              #("drift", json.int(drift_ms)),
            ]),
          ),
          #("lastSeq", json.int(r.last_seq)),
          #("batches", json.int(r.batches)),
        ]
      },
    ]),
  )
}

/// A finished session as the streak, the bests and challenge progress read it.
pub fn finished(s: Session) -> rules.Finished {
  let r = s.row
  rules.Finished(
    id: id.box_session_to_string(r.id),
    drill_id: r.drill_id,
    drill_version: r.drill_version,
    state: r.verification_state,
    verified_active_ms: option.unwrap(r.verified_active_ms, 0.0),
    verified_reps: r.verified_reps,
    at: option.or(r.ended_at, r.started_at) |> option.unwrap(0),
  )
}

/// Finished and still standing: neither cancelled nor invalidated.
pub fn standing(s: Session) -> Bool {
  is_terminal(s.row.status)
  && s.row.verification_state != Some(row.VerificationStateCancelled)
  && s.row.verification_state != Some(row.VerificationStateInvalidated)
}

// --------------------------------------------------------------------------- the player's assignments, challenges

/// The player's assignments, oldest first.
pub fn assignments_for_player(
  read: Read,
  player: id.PlayerId,
) -> Result(List(assignment_row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> assignment_row.columns
      <> " FROM box_assignments WHERE player_id = ? ORDER BY rowid",
    [id.player_sql(player)],
    assignment_row.decoder(),
  )
}

/// The player's entries, oldest first.
pub fn entries_for_player(
  read: Read,
  player: id.PlayerId,
) -> Result(List(entry_row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> entry_row.columns
      <> " FROM box_challenge_entries WHERE player_id = ? ORDER BY rowid",
    [id.player_sql(player)],
    entry_row.decoder(),
  )
}

/// The player's completed challenges, as the Passport's timeline shows them.
pub type Completion {
  Completion(
    entry_id: id.BoxChallengeEntryId,
    completed_at: Option(Int),
    title: String,
    publisher_org: Option(#(id.OrgId, Option(String))),
  )
}

pub fn completions(
  read: Read,
  player: id.PlayerId,
) -> Result(List(Completion), Fail(e)) {
  use entries <- result.try(entries_for_player(read, player))
  list.filter(entries, fn(e) { e.status == entry_row.Completed })
  |> list.try_map(fn(e) {
    use found <- result.map(
      store.one(
        read,
        "SELECT "
          <> challenge_row.columns
          <> " FROM box_challenges WHERE id = ?",
        [id.box_challenge_sql(e.challenge_id)],
        challenge_row.decoder(),
      )
      |> result.map(option.from_result),
    )
    case found {
      Some(c) ->
        Ok(
          Completion(
            entry_id: e.id,
            completed_at: e.completed_at,
            title: c.title,
            publisher_org: case c.publisher_kind, c.publisher_org_id {
              challenge_row.Org, Some(o) -> Some(#(o, c.publisher_org_name))
              _, _ -> None
            },
          ),
        )
      None -> Error(Nil)
    }
  })
  |> result.map(result.values)
}
