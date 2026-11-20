//// Box Sessions' routes (domains/development/boxcam/sessions.mjs).
////
//// Clients stream aggregated observation events bound to the session's nonce, with a strictly monotonic sequence
//// and drift-bounded timestamps. A result is derived only from accepted observations and the server's clock; a body
//// naming a result, a state or a provenance is refused as an unknown field. An uploaded video can never become
//// `box_cam_observed`.
////
//// Not ported yet: keeping a clip (`/box-cam/sessions/:id/clip`, which tags an existing `/player/media` row and
//// uploads nothing), and the player_development_evidence_changed live event.

import gleam/float
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/development/box_cam_rules as rules
import scoutbox/development/box_sessions.{type Session}
import scoutbox/development/box_training
import scoutbox/development/combine
import scoutbox/identity/access.{type PlayerAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/players.{type Player}
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/json_text
import scoutbox/platform/limits
import scoutbox/platform/live_event
import scoutbox/platform/live_pings
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/recruitment/room_routes
import scoutbox/rows/box_assignments as assignment_row
import scoutbox/rows/box_challenge_entries as entry_row
import scoutbox/rows/box_session_observations as obs_row
import scoutbox/rows/box_sessions as row
import scoutbox/rows/id
import scoutbox/safety/audit
import scoutbox/safety/moderate
import scoutbox/vocab/audience
import scoutbox/vocab/box_provider
import scoutbox/vocab/box_quality
import scoutbox/vocab/box_target_type
import wisp.{type Request, type Response}

fn storage(r: Result(a, Fail(e))) -> Result(a, Fail(Response)) {
  room_routes.storage(r)
}

fn refuse(response: Response) -> Result(a, Fail(Response)) {
  store.refuse(response)
}

fn guard(
  refused: Bool,
  response: fn() -> Response,
  next: fn() -> Result(Response, Fail(Response)),
) -> Result(Response, Fail(Response)) {
  case refused {
    True -> refuse(response())
    False -> next()
  }
}

fn session_json(s: Session) -> Response {
  http.json(200, json.object([#("session", box_sessions.view(s, False))]))
}

/// The player's own session inside a unit, or the 404.
fn own(
  read: Read,
  player: id.PlayerId,
  sid: id.BoxSessionId,
) -> Result(Session, Fail(Response)) {
  use found <- result.try(box_sessions.own(read, player, sid) |> storage)
  case found {
    Some(s) -> Ok(s)
    None -> refuse(http.error(404, "SESSION_NOT_FOUND"))
  }
}

fn body_or_refuse(body: Result(a, Response)) -> Result(a, Fail(Response)) {
  case body {
    Ok(b) -> Ok(b)
    Error(response) -> refuse(response)
  }
}

// ------------------------------------------------------------------------------------------------- discovery

fn drill_json(d: rules.Drill) -> Json {
  json.object([
    #("id", json.string(d.id)),
    #("version", json.int(d.version)),
    #("title", json.string(d.title)),
    #("category", json.string(d.category)),
    #("summary", json.string(d.summary)),
    #("targetTypes", json.array(d.target_types, box_target_type.to_json)),
    #(
      "verificationCapabilities",
      json.array(d.verification_capabilities, fn(c) {
        json.string(rules.capability_to_string(c))
      }),
    ),
    #(
      "repSupport",
      json.string(case d.rep_support {
        True -> "configured"
        False -> "not_configured"
      }),
    ),
    #("repSupportNote", json.nullable(d.rep_support_note, json.string)),
    #("setup", setup_json(d.setup)),
    #("safetyNotes", json.string(d.safety_notes)),
    #("restGuidance", json.nullable(d.rest_guidance, json.string)),
    #("ageAppropriateness", json.string(d.age_appropriateness)),
  ])
}

fn setup_json(s: rules.Setup) -> Json {
  json.object([
    #("orientation", json.string(s.orientation)),
    #("distanceM", json_text.number(s.distance_m)),
    #("space", json.string(s.space)),
    #("equipment", json.array(s.equipment, json.string)),
    #("framing", json.string(s.framing)),
    #("demo", json.string(s.demo)),
  ])
}

/// `GET /player/box-cam/drills`: the drills, and the providers this environment offers.
pub fn drills(ctx: Ctx) -> Response {
  let providers =
    list.filter(rules.providers, fn(p) {
      !p.test_only || ctx.config.box_cam_test_provider
    })
  http.json(
    200,
    json.object([
      #("drills", json.array(rules.drills, drill_json)),
      #(
        "providers",
        json.array(providers, fn(p) {
          json.object([
            #("id", box_provider.to_json(p.id)),
            #("status", json.string(p.status)),
            #("label", json.string(option.unwrap(p.label, p.status))),
            #(
              "capabilities",
              json.array(p.capabilities, fn(c) {
                json.string(rules.capability_to_string(c))
              }),
            ),
            #("testOnly", json.bool(p.test_only)),
            #("note", json.string(p.note)),
          ])
        }),
      ),
      #(
        "note",
        json.string(
          "A drill only verifies what its detector and the active observation provider can genuinely observe.",
        ),
      ),
    ]),
  )
}

// ---------------------------------------------------------------------------------------------------- create

type Target {
  Target(type_: Option(String), value: Option(Float))
}

type CreateBody {
  CreateBody(
    drill_id: Option(String),
    target: Option(Target),
    provider: Option(String),
    assignment_id: Option(String),
    challenge_entry_id: Option(String),
  )
}

fn bounds(t: box_target_type.BoxTargetType) -> #(Int, Int) {
  case t {
    box_target_type.Duration -> #(60_000, 7_200_000)
    box_target_type.Repetitions -> #(1, 2000)
    box_target_type.Sets -> #(1, 20)
  }
}

/// `POST /player/box-cam/sessions`: the server mints a session, its nonce and its liveness challenge.
pub fn create(ctx: Ctx, req: Request, p: PlayerAccess) -> Response {
  let shape = {
    use drill_id <- input.field("drillId", input.optional(input.id()))
    use target <- input.field(
      "target",
      input.nullish(
        input.object({
          use type_ <- input.field(
            "type",
            input.optional(input.text(1_000_000)),
          )
          use value <- input.field("value", input.optional(input.any_number()))
          input.done(Target(type_:, value:))
        }),
      ),
    )
    use provider <- input.field("provider", input.optional(input.id()))
    use assignment_id <- input.field("assignmentId", input.nullish(input.id()))
    use challenge_entry_id <- input.field(
      "challengeEntryId",
      input.nullish(input.id()),
    )
    input.done(CreateBody(
      drill_id:,
      target:,
      provider:,
      assignment_id:,
      challenge_entry_id:,
    ))
  }
  use b <- http.body(req, shape, [
    #("target", "TARGET_VALUE_INVALID"),
    #("target.type", "TARGET_TYPE_UNSUPPORTED"),
    #("target.*", "TARGET_VALUE_INVALID"),
  ])
  let player = p.player.row.id
  let now = clock.now_ms()
  case
    limits.limited(
      ctx.limits,
      limits.BoxSessionCreate,
      id.player_to_string(player),
      now,
    )
  {
    True ->
      http.json(
        429,
        json.object(
          list.map(limits.limited_body(limits.BoxSessionCreate), fn(kv) {
            #(kv.0, json.string(kv.1))
          }),
        ),
      )
    False -> create_session(ctx, p, b, now)
  }
}

fn create_session(
  ctx: Ctx,
  p: PlayerAccess,
  b: CreateBody,
  now: Int,
) -> Response {
  let player = p.player.row.id
  case rules.latest_drill(option.unwrap(b.drill_id, "")) {
    None -> http.error(404, "DRILL_UNKNOWN")
    Some(drill) ->
      case
        rules.provider_for(
          option.unwrap(b.provider, "web_client"),
          ctx.config.box_cam_test_provider,
        )
      {
        None ->
          http.error_message(
            403,
            "PROVIDER_UNAVAILABLE",
            "The requested observation provider is not available in this environment.",
          )
        Some(provider) -> {
          let t = option.unwrap(b.target, Target(None, None))
          let offered =
            list.find(drill.target_types, fn(tt) {
              Some(box_target_type.to_string(tt)) == t.type_
            })
          case offered {
            Error(Nil) ->
              http.json(
                400,
                json.object([
                  #("error", json.string("TARGET_TYPE_UNSUPPORTED")),
                  #(
                    "allowed",
                    json.array(drill.target_types, box_target_type.to_json),
                  ),
                ]),
              )
            Ok(tt) -> {
              let #(min, max) = bounds(tt)
              let lo = int.to_float(min)
              let hi = int.to_float(max)
              case t.value {
                Some(v) if v >=. lo && v <=. hi ->
                  mint(
                    ctx,
                    player,
                    drill,
                    rules.Target(tt, v),
                    provider,
                    b,
                    now,
                  )
                _ ->
                  http.json(
                    400,
                    json.object([
                      #("error", json.string("TARGET_VALUE_INVALID")),
                      #("min", json.int(min)),
                      #("max", json.int(max)),
                    ]),
                  )
              }
            }
          }
        }
      }
  }
}

fn mint(
  ctx: Ctx,
  player: id.PlayerId,
  drill: rules.Drill,
  target: rules.Target,
  provider: rules.Provider,
  b: CreateBody,
  now: Int,
) -> Response {
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use assignment <- result.try(case b.assignment_id {
      None | Some("") -> Ok(None)
      Some(aid) -> {
        use found <- result.try(
          store.one(
            read,
            "SELECT "
              <> assignment_row.columns
              <> " FROM box_assignments WHERE id = ?",
            [id.box_assignment_sql(id.box_assignment(aid))],
            assignment_row.decoder(),
          )
          |> storage,
        )
        case found {
          Ok(a) if a.player_id == player ->
            case a.state, a.drill_id == drill.id {
              assignment_row.Cancelled, _ ->
                refuse(http.error_message(
                  409,
                  "ASSIGNMENT_CANCELLED",
                  "This assignment is no longer active.",
                ))
              _, False -> refuse(http.error(400, "ASSIGNMENT_DRILL_MISMATCH"))
              _, True -> Ok(Some(a.id))
            }
          _ -> refuse(http.error(404, "ASSIGNMENT_NOT_FOUND"))
        }
      }
    })
    use entry <- result.try(case b.challenge_entry_id {
      None | Some("") -> Ok(None)
      Some(eid) -> {
        use found <- result.try(
          store.one(
            read,
            "SELECT "
              <> entry_row.columns
              <> " FROM box_challenge_entries WHERE id = ?",
            [id.box_challenge_entry_sql(id.box_challenge_entry(eid))],
            entry_row.decoder(),
          )
          |> storage,
        )
        case found {
          Ok(e) if e.player_id == player && e.status == entry_row.Active ->
            Ok(Some(e.id))
          _ -> refuse(http.error(404, "CHALLENGE_ENTRY_NOT_FOUND"))
        }
      }
    })
    use #(r, nonce) <- result.try(
      box_sessions.mint(
        tx,
        player,
        drill,
        target,
        provider,
        assignment,
        entry,
        None,
        now,
      )
      |> storage,
    )
    use _ <- result.map(
      box_training.count(tx, "box_sessions_started") |> storage,
    )
    // The nonce and the liveness challenge exist only in this response.
    http.json(
      201,
      json.object([
        #("session", box_sessions.view(box_sessions.Session(r, []), False)),
        #("nonce", json.string(nonce)),
        #(
          "livenessChallenge",
          row.liveness_challenge_to_json(r.liveness_challenge),
        ),
        #(
          "livenessNote",
          json.string(
            "The liveness check establishes live-session presence. It is not identity verification.",
          ),
        ),
        #("expiresAt", json.int(r.expires_at)),
        #("drillSetup", setup_json(drill.setup)),
        #(
          "readyCheck",
          json.object([
            #(
              "automated",
              json.array(
                ["camera_permission", "camera_stream", "device_orientation"],
                json.string,
              ),
            ),
            #(
              "unableToCheckAutomatically",
              json.array(
                ["lighting", "framing", "space", "single_participant"],
                json.string,
              ),
            ),
          ]),
        ),
      ]),
    )
  })
  |> room_routes.answer
}

// ----------------------------------------------------------------------------------------------------- start

type StartBody {
  StartBody(nonce: Option(String), liveness: Option(String))
}

/// `POST /player/box-cam/sessions/:id/start`: liveness passed, recording starts.
pub fn start(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  sid: id.BoxSessionId,
) -> Response {
  let body =
    http.parse_body(
      req,
      {
        use nonce <- input.field("nonce", input.optional(input.text(256)))
        use liveness <- input.field("liveness", input.nullish(input.id()))
        input.done(StartBody(nonce:, liveness:))
      },
      [],
    )
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    use s <- result.try(own(store.reading(tx), p.player.row.id, sid))
    use <- guard(s.row.status != row.SetupRequired, fn() {
      http.json(
        409,
        json.object([
          #("error", json.string("SESSION_NOT_STARTABLE")),
          #("status", row.status_to_json(s.row.status)),
        ]),
      )
    })
    case now > s.row.expires_at {
      // The expiry is written, so it commits with the refusal's answer.
      True -> {
        use _ <- result.map(box_sessions.expire(tx, sid) |> storage)
        http.error(410, "SESSION_EXPIRED")
      }
      False -> {
        use b <- result.try(body_or_refuse(body))
        use <- guard(!box_sessions.nonce_matches(s.row, b.nonce), fn() {
          http.error(403, "NONCE_INVALID")
        })
        let challenge =
          row.liveness_challenge_to_string(s.row.liveness_challenge)
        case b.liveness {
          None | Some("") ->
            refuse(http.json(
              403,
              json.object([
                #("error", json.string("LIVENESS_REQUIRED")),
                #("challenge", json.string(challenge)),
              ]),
            ))
          Some(l) if l != challenge ->
            refuse(http.error_message(
              403,
              "LIVENESS_MISMATCH",
              "Complete the liveness action the server asked for.",
            ))
          Some(_) -> {
            use _ <- result.try(box_sessions.start(tx, sid, now) |> storage)
            use started <- result.map(own(
              store.reading(tx),
              p.player.row.id,
              sid,
            ))
            session_json(started)
          }
        }
      }
    }
  })
  |> room_routes.answer
}

// ---------------------------------------------------------------------------------------------------- events

type Event {
  Event(
    seq: Float,
    type_: String,
    at_ms: Option(Float),
    from_ms: Option(Float),
    to_ms: Option(Float),
    quality: Option(String),
    confidence: Option(Float),
  )
}

type EventsBody {
  EventsBody(nonce: Option(String), batch: Option(List(Event)))
}

fn event_shape() -> input.Check(Event) {
  input.object({
    use seq <- input.field("seq", input.required(input.any_number()))
    use type_ <- input.field("type", input.required(input.text(1_000_000)))
    use at_ms <- input.field("atMs", input.nullish(input.any_number()))
    use from_ms <- input.field("fromMs", input.nullish(input.any_number()))
    use to_ms <- input.field("toMs", input.nullish(input.any_number()))
    use quality <- input.field("quality", input.nullish(input.text(1_000_000)))
    use confidence <- input.field(
      "confidence",
      input.nullish(input.any_number()),
    )
    input.done(Event(
      seq:,
      type_:,
      at_ms:,
      from_ms:,
      to_ms:,
      quality:,
      confidence:,
    ))
  })
}

const event_types = [
  "active_interval", "presence_interval", "ball_interval", "rep",
  "set_completed", "pause", "resume", "camera_interrupted", "multi_person",
  "observation_gap",
]

const max_safe_integer = 9_007_199_254_740_991.0

/// The observation an accepted event becomes, as the TypeScript server reads it: a field the kind doesn't carry is
/// left out, so only the kind's own fields are judged.
type Observation {
  Observation(
    kind: obs_row.Kind,
    from_ms: Option(Float),
    to_ms: Option(Float),
    at_ms: Option(Float),
    quality: Option(String),
    confidence: Option(Float),
  )
}

fn observation_of(e: Event) -> Result(Observation, Nil) {
  let o = fn(kind) { Observation(kind, None, None, None, None, None) }
  case e.type_ {
    "active_interval" ->
      Ok(
        Observation(
          ..o(obs_row.Active),
          from_ms: e.from_ms,
          to_ms: e.to_ms,
          quality: e.quality,
        ),
      )
    "presence_interval" ->
      Ok(
        Observation(
          ..o(obs_row.Presence),
          from_ms: e.from_ms,
          to_ms: e.to_ms,
          quality: e.quality,
        ),
      )
    "ball_interval" ->
      Ok(Observation(..o(obs_row.Ball), from_ms: e.from_ms, to_ms: e.to_ms))
    "rep" ->
      Ok(
        Observation(..o(obs_row.Rep), at_ms: e.at_ms, confidence: e.confidence),
      )
    "set_completed" -> Ok(Observation(..o(obs_row.Set), at_ms: e.at_ms))
    "pause" -> Ok(Observation(..o(obs_row.Pause), from_ms: e.at_ms))
    "camera_interrupted" | "observation_gap" ->
      Ok(
        Observation(
          ..o(obs_row.Interruption),
          from_ms: e.from_ms,
          to_ms: e.to_ms,
        ),
      )
    "multi_person" ->
      Ok(
        Observation(
          ..o(obs_row.MultiPerson),
          from_ms: e.from_ms,
          to_ms: e.to_ms,
        ),
      )
    _ -> Error(Nil)
  }
}

/// The stored row of an observation the engine can read, or why it can't (typeObservation).
fn type_observation(o: Observation, at: String) -> Result(obs_row.Row, String) {
  let bad = fn(field, what) { Error(at <> "." <> field <> " " <> what) }
  let interval = case o.kind {
    obs_row.Active
    | obs_row.Presence
    | obs_row.Ball
    | obs_row.Interruption
    | obs_row.MultiPerson -> True
    _ -> False
  }
  let point = o.kind == obs_row.Rep || o.kind == obs_row.Set
  let quality = case o.quality {
    None -> Ok(None)
    Some(q) ->
      case
        o.kind == obs_row.Active || o.kind == obs_row.Presence,
        box_quality.from_string(q)
      {
        True, Ok(q) -> Ok(Some(q))
        _, _ -> Error(Nil)
      }
  }
  case o {
    _
      if interval && { o.from_ms == None || o.to_ms == None || o.at_ms != None }
    -> bad("fromMs", "and toMs are required on an interval (and atMs is not)")
    _ if point && { o.at_ms == None || o.from_ms != None || o.to_ms != None } ->
      bad(
        "atMs",
        "is required on a point observation (and fromMs/toMs are not)",
      )
    _ if o.kind == obs_row.Pause && { o.from_ms == None || o.at_ms != None } ->
      bad("fromMs", "is required on a pause")
    _ ->
      case quality, o.confidence {
        Error(Nil), _ ->
          bad(
            "quality",
            "must be one of good|degraded|insufficient on an active or presence interval",
          )
        _, Some(c) if o.kind != obs_row.Rep || c <. 0.0 || c >. 1.0 ->
          bad("confidence", "must be a number from 0 to 1 on a rep")
        Ok(q), c ->
          Ok(
            obs_row.Row(
              ..obs_row.new(
                session_id: id.box_session(""),
                ord: 0,
                kind: o.kind,
              ),
              from_ms: o.from_ms,
              to_ms: o.to_ms,
              at_ms: o.at_ms,
              quality: q,
              confidence: c,
            ),
          )
      }
  }
}

fn seq_text(n: Float) -> String {
  case float.floor(n) == n {
    True -> int.to_string(float.truncate(n))
    False -> float.to_string(n)
  }
}

/// Each event judged in order: the first one that fails refuses the whole batch, so replays never merge silently.
fn accept_batch(
  events: List(Event),
  last_seq: Int,
  max_ms: Float,
  accepted: List(box_sessions.Accepted),
) -> Result(#(List(box_sessions.Accepted), Int), Response) {
  case events {
    [] -> Ok(#(list.reverse(accepted), last_seq))
    [e, ..rest] -> {
      let whole =
        float.floor(e.seq) == e.seq
        && float.absolute_value(e.seq) <=. max_safe_integer
      use <- refuse_when(!whole || e.seq <=. int.to_float(last_seq), fn() {
        http.json(
          409,
          json.object([
            #("error", json.string("SEQUENCE_INVALID")),
            #("lastSeq", json.int(last_seq)),
          ]),
        )
      })
      let n = float.truncate(e.seq)
      use <- refuse_when(!list.contains(event_types, e.type_), fn() {
        http.json(
          400,
          json.object([
            #("error", json.string("EVENT_TYPE_UNKNOWN")),
            #("type", json.string(e.type_)),
          ]),
        )
      })
      let out_of_range =
        [#("atMs", e.at_ms), #("fromMs", e.from_ms), #("toMs", e.to_ms)]
        |> list.find(fn(pair) {
          case pair.1 {
            Some(v) -> v <. 0.0 || v >. max_ms
            None -> False
          }
        })
      use <- refuse_when(result.is_ok(out_of_range), fn() {
        let assert Ok(#(field, _)) = out_of_range
        http.json(
          422,
          json.object([
            #("error", json.string("TIMESTAMP_OUT_OF_RANGE")),
            #("field", json.string(field)),
            #("maxMs", json_text.number(max_ms)),
          ]),
        )
      })
      let invalid = fn(message) {
        Error(http.json(
          400,
          json.object([
            #("error", json.string("EVENT_INVALID")),
            #("seq", json.int(n)),
            #("message", json.string(message)),
          ]),
        ))
      }
      case e.type_, observation_of(e) {
        "resume", _ ->
          case e.at_ms {
            Some(at) ->
              accept_batch(rest, n, max_ms, [
                box_sessions.Resume(at),
                ..accepted
              ])
            None ->
              Error(http.json(
                400,
                json.object([
                  #("error", json.string("EVENT_INVALID")),
                  #("seq", json.int(n)),
                  #("field", json.string("atMs")),
                  #("message", json.string("A resume needs atMs.")),
                ]),
              ))
          }
        _, Ok(o) ->
          case type_observation(o, "event " <> seq_text(e.seq)) {
            Ok(r) ->
              accept_batch(rest, n, max_ms, [
                box_sessions.Observe(r),
                ..accepted
              ])
            Error(message) -> invalid(message)
          }
        _, Error(Nil) ->
          invalid("event " <> seq_text(e.seq) <> " is not an observation")
      }
    }
  }
}

fn refuse_when(
  refused: Bool,
  response: fn() -> Response,
  next: fn() -> Result(a, Response),
) -> Result(a, Response) {
  case refused {
    True -> Error(response())
    False -> next()
  }
}

/// `POST /player/box-cam/sessions/:id/events`: one ordered batch of observations.
pub fn events(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  sid: id.BoxSessionId,
) -> Response {
  let body =
    http.parse_body(
      req,
      {
        use nonce <- input.field("nonce", input.optional(input.text(256)))
        use batch <- input.field(
          "batch",
          input.optional(input.items(event_shape(), 1_000_000)),
        )
        input.done(EventsBody(nonce:, batch:))
      },
      [#("batch", "BATCH_INVALID"), #("batch.*", "EVENT_INVALID")],
    )
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use s <- result.try(own(read, p.player.row.id, sid))
    use b <- result.try(body_or_refuse(body))
    use <- guard(!box_sessions.nonce_matches(s.row, b.nonce), fn() {
      http.error(403, "NONCE_INVALID")
    })
    use <- guard(s.row.status != row.Recording, fn() {
      http.json(
        409,
        json.object([
          #("error", json.string("SESSION_NOT_RECORDING")),
          #("status", row.status_to_json(s.row.status)),
        ]),
      )
    })
    use <- guard(now > s.row.expires_at, fn() {
      http.error(410, "SESSION_EXPIRED")
    })
    let batch = option.unwrap(b.batch, [])
    let size = list.length(batch)
    use <- guard(size == 0 || size > box_sessions.max_events_per_batch, fn() {
      http.json(
        400,
        json.object([
          #("error", json.string("BATCH_INVALID")),
          #("maxEvents", json.int(box_sessions.max_events_per_batch)),
        ]),
      )
    })
    use <- guard(s.row.batches >= box_sessions.max_batches_per_session, fn() {
      http.error_message(
        429,
        "RATE_LIMITED",
        "Observation batch limit reached for this session.",
      )
    })
    use stored <- result.try(
      box_sessions.stored_intervals(read, sid) |> storage,
    )
    use <- guard(stored > box_sessions.max_stored_intervals, fn() {
      http.error_message(
        429,
        "RATE_LIMITED",
        "Observation storage limit reached.",
      )
    })
    // A real provider is bound to the server's clock plus bounded drift. The test-only fixture provider simulates
    // time through its observation stream (bounded by the session lifetime); its sessions are labelled simulated.
    let max_ms = case rules.provider(s.row.provider_id).test_only {
      True -> int.to_float(box_sessions.ttl_ms)
      False ->
        int.to_float(
          now - option.unwrap(s.row.started_at, now) + box_sessions.drift_ms,
        )
    }
    use #(accepted, last_seq) <- result.try(
      accept_batch(batch, s.row.last_seq, max_ms, [])
      |> result.map_error(store.Refuse),
    )
    use count <- result.try(
      box_sessions.observation_count(read, sid) |> storage,
    )
    // A resume counts towards the limit too, as the TypeScript server counts it.
    use <- guard(
      count + list.length(accepted) > box_sessions.max_observations,
      fn() {
        http.error_message(
          429,
          "RATE_LIMITED",
          "Observation storage limit reached.",
        )
      },
    )
    use _ <- result.map(
      box_sessions.record_batch(tx, s, accepted, last_seq) |> storage,
    )
    http.json(
      200,
      json.object([
        #("accepted", json.int(size)),
        #("lastSeq", json.int(last_seq)),
      ]),
    )
  })
  |> room_routes.answer
}

// -------------------------------------------------------------------------------------------------- complete

type NonceBody {
  NonceBody(nonce: Option(String))
}

fn nonce_shape() -> input.Shape(NonceBody) {
  use nonce <- input.field("nonce", input.optional(input.text(256)))
  input.done(NonceBody(nonce:))
}

/// Finishes a recording and moves on what it counts towards: its assignment, the player's challenges and the
/// Combine attempt bound to it. Shared with the Combine's complete route, inside the caller's unit.
pub fn complete_session(
  tx: store.Tx,
  s: Session,
  player: Player,
  now: Int,
) -> Result(Session, Fail(e)) {
  let read = store.reading(tx)
  use obs <- result.try(box_sessions.observations_of(read, s.row.id))
  let f = box_sessions.finalize(s.row, obs, False, now)
  use _ <- result.try(box_sessions.finish(tx, s.row.id, f))
  let drill = box_sessions.drill_title(s.row.drill_id)
  let pid = id.player_to_string(player.row.id)
  let ref = Some(id.box_session_to_string(s.row.id))
  use _ <- result.try(case f.state {
    row.VerificationStateVerified | row.VerificationStatePartiallyVerified -> {
      use _ <- result.try(notifications.notify(
        tx,
        to: audience.Player,
        id: pid,
        type_: "box_cam",
        text: "Your work counts. "
          <> rules.fmt_ms(f.verified_active_ms)
          <> " of "
          <> drill
          <> " was recorded in your training history.",
        ref_id: ref,
        at: now,
      ))
      case players.is_adult(player, now), player.row.guardian_id {
        False, Some(gid) ->
          notifications.notify(
            tx,
            to: audience.Guardian,
            id: id.guardian_to_string(gid),
            type_: "box_cam",
            text: player.row.name
              <> " completed a Box Session ("
              <> rules.fmt_ms(f.verified_active_ms)
              <> " Box Cam verified).",
            ref_id: ref,
            at: now,
          )
        _, _ -> Ok(Nil)
      }
    }
    state ->
      notifications.notify(
        tx,
        to: audience.Player,
        id: pid,
        type_: "box_cam",
        text: rules.state_copy(state),
        ref_id: ref,
        at: now,
      )
  })
  use done <- result.try(box_sessions.by_id(read, s.row.id))
  let assert Some(done) = done
  use _ <- result.try(box_training.apply_assignment_progress(tx, done.row, now))
  use _ <- result.try(box_training.apply_challenge_progress(tx, done.row, now))
  use _ <- result.try(combine.apply_progress(tx, done.row, player, now))
  use _ <- result.try(box_training.count(tx, "box_sessions_completed"))
  use _ <- result.try(case f.state {
    row.VerificationStateVerified ->
      box_training.count(tx, "box_sessions_verified")
    row.VerificationStatePartiallyVerified ->
      box_training.count(tx, "box_sessions_partial")
    row.VerificationStateUnableToVerify ->
      box_training.count(tx, "box_sessions_unverifiable")
    _ -> Ok(Nil)
  })
  use _ <- result.try(box_training.count_by(
    tx,
    "box_session_active_seconds",
    float.truncate(float.floor(f.verified_active_ms /. 1000.0)),
  ))
  live_pings.catalogue(tx, live_event.PlayerDevelopmentEvidenceChanged(pid))
  Ok(done)
}

/// `POST /player/box-cam/sessions/:id/complete`.
pub fn complete(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  sid: id.BoxSessionId,
) -> Response {
  let body = http.parse_body(req, nonce_shape(), [])
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    use s <- result.try(own(store.reading(tx), p.player.row.id, sid))
    use b <- result.try(body_or_refuse(body))
    use <- guard(!box_sessions.nonce_matches(s.row, b.nonce), fn() {
      http.error(403, "NONCE_INVALID")
    })
    use <- guard(box_sessions.is_terminal(s.row.status), fn() {
      http.error_message(
        409,
        "ALREADY_FINALIZED",
        "A completed Box Session cannot be submitted again.",
      )
    })
    use <- guard(s.row.status != row.Recording, fn() {
      http.json(
        409,
        json.object([
          #("error", json.string("SESSION_NOT_RECORDING")),
          #("status", row.status_to_json(s.row.status)),
        ]),
      )
    })
    complete_session(tx, s, p.player, now)
    |> storage
    |> result.map(session_json)
  })
  |> room_routes.answer
}

/// `POST /player/box-cam/sessions/:id/cancel`. The nonce is read but, as in the TypeScript server, not compared.
pub fn cancel(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  sid: id.BoxSessionId,
) -> Response {
  use _ <- http.body(req, nonce_shape(), [])
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use s <- result.try(own(read, p.player.row.id, sid))
    use <- guard(box_sessions.is_terminal(s.row.status), fn() {
      http.error(409, "ALREADY_FINALIZED")
    })
    use _ <- result.try(
      case s.row.status {
        row.Recording -> {
          use obs <- result.try(box_sessions.observations_of(read, sid))
          box_sessions.finish(
            tx,
            sid,
            box_sessions.finalize(s.row, obs, True, now),
          )
        }
        _ -> box_sessions.cancel(tx, sid)
      }
      |> storage,
    )
    own(read, p.player.row.id, sid) |> result.map(session_json)
  })
  |> room_routes.answer
}

// ----------------------------------------------------------------------------------------------- notes, reads

type NoteBody {
  NoteBody(note: Option(String))
}

/// `POST /player/box-cam/sessions/:id/note`: the player's words, apart from the observations.
pub fn note(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  sid: id.BoxSessionId,
) -> Response {
  case store.read(ctx.store, box_sessions.own(_, p.player.row.id, sid)) {
    Error(e) -> http.internal(e)
    Ok(Some(s)) ->
      case box_sessions.is_terminal(s.row.status) {
        False -> http.error(404, "SESSION_NOT_FOUND")
        True -> {
          use b <- http.body(
            req,
            {
              use note <- input.field("note", input.nullish(input.text(300)))
              input.done(NoteBody(note:))
            },
            [],
          )
          let text = option.unwrap(b.note, "")
          case string.trim(text) {
            "" -> http.required("NOTE_REQUIRED", "note")
            _ -> {
              use <- moderate.or_refuse(
                ctx,
                text,
                audit.Context(
                  kind: "box_cam_note",
                  player_id: Some(p.player.row.id),
                  org_id: None,
                  user_id: None,
                  channel_id: None,
                  request_id: None,
                ),
              )
              store.unit(ctx.store, fn(tx) {
                use _ <- result.try(
                  box_sessions.set_note(tx, sid, text) |> storage,
                )
                own(store.reading(tx), p.player.row.id, sid)
                |> result.map(session_json)
              })
              |> room_routes.answer
            }
          }
        }
      }
    Ok(None) -> http.error(404, "SESSION_NOT_FOUND")
  }
}

fn list_json(
  read: Read,
  player: id.PlayerId,
) -> Result(Response, Fail(Response)) {
  use sessions <- result.map(
    box_sessions.finished_for_player(read, player, Some(50)) |> storage,
  )
  http.json(
    200,
    json.object([
      #("items", json.array(sessions, box_sessions.view(_, False))),
    ]),
  )
}

/// `GET /player/box-cam/sessions`: the player's finished sessions, newest first.
pub fn list(ctx: Ctx, p: PlayerAccess) -> Response {
  store.read(ctx.store, list_json(_, p.player.row.id))
  |> room_routes.read_answer
}

/// `GET /guardian/children/:id/box-cam/sessions`.
pub fn child_list(ctx: Ctx, g: Guardian, child: id.PlayerId) -> Response {
  case list.contains(g.child_ids, child) {
    False -> http.error(404, "CHILD_NOT_FOUND")
    True ->
      store.read(ctx.store, list_json(_, child)) |> room_routes.read_answer
  }
}

/// `GET /player/box-cam/sessions/:id`.
pub fn show(ctx: Ctx, p: PlayerAccess, sid: id.BoxSessionId) -> Response {
  case store.read(ctx.store, box_sessions.own(_, p.player.row.id, sid)) {
    Error(e) -> http.internal(e)
    Ok(Some(s)) -> session_json(s)
    Ok(None) -> http.error(404, "SESSION_NOT_FOUND")
  }
}

/// `GET /admin/box-cam/sessions/:id`: with the integrity fields.
pub fn admin_show(ctx: Ctx, sid: id.BoxSessionId) -> Response {
  case store.read(ctx.store, box_sessions.by_id(_, sid)) {
    Error(e) -> http.internal(e)
    Ok(Some(s)) ->
      http.json(200, json.object([#("session", box_sessions.view(s, True))]))
    Ok(None) -> http.error(404, "SESSION_NOT_FOUND")
  }
}

// ------------------------------------------------------------------------------------------------- dashboards

fn dashboard_json(
  read: Read,
  player: id.PlayerId,
  now: Int,
) -> Result(Response, Fail(Response)) {
  use all <- result.try(
    box_sessions.finished_for_player(read, player, None) |> storage,
  )
  let sessions =
    list.filter(all, fn(s) {
      s.row.verification_state != Some(row.VerificationStateCancelled)
      && s.row.verification_state != Some(row.VerificationStateInvalidated)
    })
  use assignments <- result.try(
    box_sessions.assignments_for_player(read, player) |> storage,
  )
  let assignments =
    list.filter(assignments, fn(a) { a.state != assignment_row.Cancelled })
  use views <- result.map(
    list.try_map(assignments, box_training.assignment_view(read, _)) |> storage,
  )
  let finished = list.map(sessions, box_sessions.finished)
  http.json(
    200,
    json.object([
      #("streakWeeks", json.int(rules.box_streak_weeks(finished, now))),
      #(
        "streakNote",
        json.string(
          "A Box Streak is consistency against your planned training weeks. Rest days never break a streak.",
        ),
      ),
      #(
        "bests",
        json.array(rules.box_bests(finished), fn(b) {
          json.object([
            #("drillId", json.string(b.drill_id)),
            #("drillVersion", json.int(b.drill_version)),
            #("bestActiveMs", json_text.number(b.best_active_ms)),
            #("bestReps", json.nullable(b.best_reps, json.int)),
            #("bestActive", json.string(rules.fmt_ms(b.best_active_ms))),
          ])
        }),
      ),
      #(
        "recent",
        json.array(list.take(sessions, 10), box_sessions.view(_, False)),
      ),
      #("assignments", json.preprocessed_array(views)),
    ]),
  )
}

/// `GET /player/box-cam/dashboard`.
pub fn dashboard(ctx: Ctx, p: PlayerAccess) -> Response {
  let now = clock.now_ms()
  store.read(ctx.store, dashboard_json(_, p.player.row.id, now))
  |> room_routes.read_answer
}

/// `GET /guardian/children/:id/box-cam/dashboard`.
pub fn child_dashboard(ctx: Ctx, g: Guardian, child: id.PlayerId) -> Response {
  let now = clock.now_ms()
  case list.contains(g.child_ids, child) {
    False -> http.error(404, "CHILD_NOT_FOUND")
    True ->
      store.read(ctx.store, fn(read) {
        use found <- result.try(players.by_id(read, child) |> storage)
        case found {
          Some(_) -> dashboard_json(read, child, now)
          None -> refuse(http.error(404, "PLAYER_NOT_FOUND"))
        }
      })
      |> room_routes.read_answer
  }
}
