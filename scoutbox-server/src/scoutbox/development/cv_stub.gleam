//// The `production_cv` provider's routes (domains/development/boxcam/cv/routes.mjs), as a stub. Box Cam's video
//// analysis is moving to a service of its own, so here the provider's health is always `unavailable`: a provider
//// session's routes run their own checks (budget, refused fields, body, session, nonce) and then answer
//// `503 provider_unavailable`, which a client treats as an outage. The Ready Check reports the provider
//// unavailable, and T&S reads stored results.
////
//// The registry still lists `production_cv` as configured, as the TypeScript server's does: a deployment learns
//// that this server has no video analysis from the provider's health, not from a rewritten registry.
////
//// Out of scope: finalizing a session whose result is already stored answers 503 rather than that result.

import gleam/dict
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/float
import gleam/http/request
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/development/box_sessions
import scoutbox/identity/access.{type PlayerAccess}
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/json_text
import scoutbox/platform/limits
import scoutbox/platform/store
import scoutbox/rows/box_cam_cv_results as result_row
import scoutbox/rows/box_sessions as session_row
import scoutbox/rows/id
import scoutbox/vocab/box_provider
import sqlight
import wisp.{type Request, type Response}

// ------------------------------------------------------------------------------------------------- the policy

pub const policy_version = 1

pub const engine_version = 2

pub const provider_version = 1

pub const max_concurrent_sessions = 16

pub const frame_encoding = "gray8"

pub type FrameLimits {
  FrameLimits(
    min_width: Int,
    min_height: Int,
    max_width: Int,
    max_height: Int,
    max_bytes: Int,
    max_frames_per_batch: Int,
    max_batches_per_session: Int,
    max_queued_frames: Int,
  )
}

pub const frame_limits =
  FrameLimits(
    min_width: 160,
    min_height: 120,
    max_width: 320,
    max_height: 240,
    max_bytes: 76_800,
    max_frames_per_batch: 12,
    max_batches_per_session: 120,
    max_queued_frames: 24,
  )

/// The protocols the CV engine is a candidate for.
pub const candidate_protocols = [
  "combine-box-touch-60", "combine-box-juggle", "combine-box-control-60",
]

/// Fields only the provider derives: a body or frame envelope naming one is refused.
pub const forbidden_client_fields = [
  "touches", "touchCount", "reps", "repCount", "juggles", "juggleCount", "count",
  "measurement", "value", "result", "verified", "verifiedReps",
  "combineVerified", "confidence", "modelVersion", "providerVersion",
  "productionEligible", "accepted", "observationState", "score",
]

pub fn combine_disabled_reason() -> Json {
  json.object([
    #("code", json.string("REAL_WORLD_VALIDATION_NOT_COMPLETED")),
    #(
      "short",
      json.string(
        "Combine verification is not available yet for this protocol.",
      ),
    ),
    #(
      "detail",
      json.string(
        "Real-world validation has not been completed, so ScoutBox will not publish a standardised Combine measurement from computer vision.",
      ),
    ),
  ])
}

/// Always unavailable: this server has no video analysis.
pub fn health() -> Json {
  json.object([
    #("state", json.string("unavailable")),
    #("providerId", box_provider.to_json(box_provider.ProductionCv)),
    #("providerVersion", json.int(provider_version)),
    #("engineVersion", json.int(engine_version)),
    #("cvPolicyVersion", json.int(policy_version)),
    #("activeSessions", json.int(0)),
    #("maxConcurrentSessions", json.int(max_concurrent_sessions)),
    #("combineVerificationEligible", json.bool(False)),
    #("combineVerifiedProtocols", json.preprocessed_array([])),
    #(
      "note",
      json.string(
        "Provider health describes observation capability only. It is not Combine verification eligibility.",
      ),
    ),
  ])
}

// ---------------------------------------------------------------------------------------------- answering

/// The provider's own codes and the status each answers with (cv/routes.mjs `HTTP_FOR`); anything else is a 400.
fn status_for(code: String) -> Int {
  case code {
    "frame_too_large" -> 413
    "unsupported_frame_format" -> 415
    "invalid_frame_dimensions" -> 422
    "duplicate_frame" | "out_of_order_frame" -> 409
    "session_expired" -> 410
    "nonce_invalid" -> 403
    "provider_unavailable" | "provider_busy" -> 503
    "queue_overflow" | "rate_limited" -> 429
    "session_not_found" -> 404
    "invalid_state" | "already_finalized" -> 409
    "unsupported_protocol" | "client_field_refused" -> 422
    "engine_failure" -> 500
    _ -> 400
  }
}

/// The client learns the typed code only: no stack, path or engine message.
fn fail(code: String, extra: List(#(String, Json))) -> Response {
  http.json(
    status_for(code),
    json.object([#("error", json.string(code)), ..extra]),
  )
}

fn limited(
  ctx: Ctx,
  action: limits.Action,
  p: PlayerAccess,
  retry: Int,
  next: fn() -> Response,
) -> Response {
  let owner = id.player_to_string(p.player.row.id)
  case limits.limited(ctx.limits, action, owner, clock.now_ms()) {
    True -> fail("rate_limited", [#("retryAfterSeconds", json.int(retry))])
    False -> next()
  }
}

fn keys(value: Dynamic) -> List(String) {
  decode.run(value, decode.dict(decode.string, decode.dynamic))
  |> result.map(dict.keys)
  |> result.unwrap([])
}

/// A body or frame envelope naming a field the provider derives is refused, all such fields named once.
fn refuse_client_fields(
  objects: List(Dynamic),
  next: fn() -> Response,
) -> Response {
  let named = list.flat_map(objects, keys)
  case list.filter(forbidden_client_fields, list.contains(named, _)) {
    [] -> next()
    fields ->
      fail("client_field_refused", [
        #("fields", json.array(fields, json.string)),
      ])
  }
}

/// The body read with `shape`, refused with the provider's codes and statuses.
fn read_input(
  raw: Dynamic,
  shape: input.Shape(a),
  codes: List(#(String, String)),
  next: fn(a) -> Response,
) -> Response {
  case input.parse(shape, raw, root: "body", codes:) {
    Ok(value) -> next(value)
    Error(r) -> {
      let fields = input.refusal_fields(r)
      http.json(status_for(r.error), json.object(fields))
    }
  }
}

/// The player's own session whose nonce matches, or the provider's 404 or 403.
fn own_session(
  ctx: Ctx,
  p: PlayerAccess,
  sid: id.BoxSessionId,
  nonce: Option(String),
  next: fn(session_row.Row) -> Response,
) -> Response {
  case store.read(ctx.store, box_sessions.own(_, p.player.row.id, sid)) {
    Error(e) -> http.internal(e)
    Ok(None) -> fail("session_not_found", [])
    Ok(Some(s)) ->
      case box_sessions.nonce_matches(s.row, nonce) {
        False -> fail("nonce_invalid", [])
        True -> next(s.row)
      }
  }
}

fn unavailable() -> Response {
  fail("provider_unavailable", [])
}

// ---------------------------------------------------------------------------------------- provider sessions

type Begin {
  Begin(nonce: Option(String), protocol_id: Option(String))
}

/// `POST /player/box-cam/sessions/:id/cv/begin`: the binding comes from the server's record, and liveness is
/// checked first, so an attempt cannot be recorded and then rejected.
pub fn begin(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  sid: id.BoxSessionId,
) -> Response {
  use <- limited(ctx, limits.BoxCvSessionCreate, p, 30)
  use raw <- http.json_body(req)
  use <- refuse_client_fields([raw])
  let shape = {
    use nonce <- input.field("nonce", input.optional(input.text(256)))
    use protocol_id <- input.field("protocolId", input.optional(input.text(80)))
    input.done(Begin(nonce:, protocol_id:))
  }
  use b <- read_input(raw, shape, [])
  use s <- own_session(ctx, p, sid, b.nonce)
  let detail = fn(text) { [#("detail", json.string(text))] }
  case s.status, clock.now_ms() > s.expires_at, s.liveness_passed_at {
    status, _, _ if status != session_row.Recording ->
      fail("invalid_state", [#("status", session_row.status_to_json(status))])
    _, True, _ -> fail("session_expired", [])
    _, _, None ->
      fail(
        "invalid_state",
        detail("liveness has not been established for this session"),
      )
    _, _, Some(_) ->
      case s.provider_id {
        box_provider.ProductionCv -> unavailable()
        _ ->
          fail(
            "invalid_state",
            detail(
              "this Box Cam session is not bound to the production CV provider",
            ),
          )
      }
  }
}

type Frames {
  Frames(nonce: Option(String))
}

/// `POST /player/box-cam/sessions/:id/cv/frames`: bounded JSON batches, never a file upload.
pub fn frames(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  sid: id.BoxSessionId,
) -> Response {
  use <- limited(ctx, limits.BoxCvFrames, p, 5)
  let json_typed = case request.get_header(req, "content-type") {
    Ok(ct) -> string.contains(ct, "application/json")
    Error(Nil) -> False
  }
  case json_typed {
    False ->
      fail("unsupported_frame_format", [
        #(
          "detail",
          json.string(
            "frames are submitted as JSON envelopes; this endpoint is not a file upload",
          ),
        ),
      ])
    True -> {
      use raw <- http.json_body(req)
      let envelopes =
        decode.run(raw, decode.at(["frames"], decode.list(decode.dynamic)))
        |> result.unwrap([])
      use <- refuse_client_fields([raw, ..envelopes])
      let frame =
        input.object({
          use _ <- input.field(
            "encoding",
            input.optional(input.text(1_000_000)),
          )
          use _ <- input.field("seq", input.optional(input.any_number()))
          use _ <- input.field("atMs", input.optional(input.any_number()))
          use _ <- input.field("w", input.optional(input.any_number()))
          use _ <- input.field("h", input.optional(input.any_number()))
          use _ <- input.field("data", input.optional(input.text(100_000_000)))
          use _ <- input.field(
            "capturedAtMs",
            input.nullish(input.any_number()),
          )
          input.done(Nil)
        })
      let shape = {
        use nonce <- input.field("nonce", input.optional(input.text(256)))
        use _ <- input.field("providerSessionId", input.nullish(input.text(80)))
        use _ <- input.field(
          "frames",
          input.optional(input.items(frame, 1_000_000)),
        )
        input.done(Frames(nonce:))
      }
      use b <- read_input(raw, shape, [
        #("frames", "unsupported_frame_format"),
        #("frames.w", "invalid_frame_dimensions"),
        #("frames.h", "invalid_frame_dimensions"),
        #("frames.*", "unsupported_frame_format"),
      ])
      use _ <- own_session(ctx, p, sid, b.nonce)
      unavailable()
    }
  }
}

type Finalize {
  Finalize(nonce: Option(String))
}

/// `POST /player/box-cam/sessions/:id/cv/finalize`. The budget only bounds a retry loop.
pub fn finalize(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  sid: id.BoxSessionId,
) -> Response {
  use <- limited(ctx, limits.BoxCvFinalize, p, 5)
  use raw <- http.json_body(req)
  use <- refuse_client_fields([raw])
  let shape = {
    use nonce <- input.field("nonce", input.optional(input.text(256)))
    use _ <- input.field("providerSessionId", input.nullish(input.text(80)))
    use _ <- input.field(
      "protocolWindowMs",
      input.nullish(input.whole_number(1, 24 * 3_600_000)),
    )
    input.done(Finalize(nonce:))
  }
  use b <- read_input(raw, shape, [])
  use _ <- own_session(ctx, p, sid, b.nonce)
  unavailable()
}

/// `POST /player/box-cam/sessions/:id/cv/cancel`.
pub fn cancel(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  sid: id.BoxSessionId,
) -> Response {
  use raw <- http.json_body(req)
  use <- refuse_client_fields([raw])
  let shape = {
    use nonce <- input.field("nonce", input.optional(input.text(256)))
    use _ <- input.field("providerSessionId", input.nullish(input.text(80)))
    input.done(Finalize(nonce:))
  }
  use b <- read_input(raw, shape, [])
  use _ <- own_session(ctx, p, sid, b.nonce)
  unavailable()
}

// ------------------------------------------------------------------------------------------- the Ready Check

type ReadyCheck {
  ReadyCheck(
    camera_permission: Option(String),
    secure_context: Option(Bool),
    frame_width: Option(Float),
    frame_height: Option(Float),
    fps: Option(Float),
    person_detected: Option(Bool),
    ball_detected: Option(Bool),
    lighting_ok: Option(Bool),
    protocol_id: Option(String),
  )
}

fn check(id: String, pass: Bool, reason: Option(String), detail: Json) -> Json {
  json.object([
    #("id", json.string(id)),
    #(
      "state",
      json.string(case pass {
        True -> "pass"
        False -> "fail"
      }),
    ),
    #("reasonCode", json.nullable(reason, json.string)),
    #("detail", detail),
  ])
}

/// A check the client cannot self-assess is "unknown", not assumed to pass.
fn reported(id: String, value: Option(Bool), reason: String) -> #(Json, Bool) {
  let #(state, code) = case value {
    Some(True) -> #("pass", None)
    Some(False) -> #("fail", Some(reason))
    None -> #("unknown", None)
  }
  #(
    json.object([
      #("id", json.string(id)),
      #("state", json.string(state)),
      #("reasonCode", json.nullable(code, json.string)),
      #("detail", json.null()),
    ]),
    state == "fail",
  )
}

fn whole_between(v: Option(Float), min: Int, max: Int) -> Bool {
  case v {
    Some(x) ->
      float.floor(x) == x && x >=. int.to_float(min) && x <=. int.to_float(max)
    None -> False
  }
}

/// `POST /player/box-cam/cv/ready-check`: structured checks the client maps to copy. Observation readiness and
/// Combine availability are separate questions and both always appear. Client-reported facts only advise.
pub fn ready_check(ctx: Ctx, req: Request, p: PlayerAccess) -> Response {
  use <- limited(ctx, limits.BoxCvReadyCheck, p, 10)
  use raw <- http.json_body(req)
  use <- refuse_client_fields([raw])
  let shape = {
    use camera_permission <- input.field(
      "cameraPermission",
      input.nullish(input.text(80)),
    )
    use secure_context <- input.field(
      "secureContext",
      input.nullish(input.boolean()),
    )
    use frame_width <- input.field(
      "frameWidth",
      input.nullish(input.any_number()),
    )
    use frame_height <- input.field(
      "frameHeight",
      input.nullish(input.any_number()),
    )
    use fps <- input.field("fps", input.nullish(input.any_number()))
    use person_detected <- input.field(
      "personDetected",
      input.nullish(input.boolean()),
    )
    use ball_detected <- input.field(
      "ballDetected",
      input.nullish(input.boolean()),
    )
    use lighting_ok <- input.field("lightingOk", input.nullish(input.boolean()))
    use protocol_id <- input.field("protocolId", input.nullish(input.text(80)))
    input.done(ReadyCheck(
      camera_permission:,
      secure_context:,
      frame_width:,
      frame_height:,
      fps:,
      person_detected:,
      ball_detected:,
      lighting_ok:,
      protocol_id:,
    ))
  }
  use b <- read_input(raw, shape, [])
  let l = frame_limits
  let camera = option.unwrap(b.camera_permission, "unknown")
  let dims_ok =
    whole_between(b.frame_width, l.min_width, l.max_width)
    && whole_between(b.frame_height, l.min_height, l.max_height)
  let fps_ok = case b.fps {
    Some(f) -> f >=. 12.0
    None -> False
  }
  let supported =
    list.contains(candidate_protocols, option.unwrap(b.protocol_id, ""))
  let pair = fn(a, b) { json.preprocessed_array([json.int(a), json.int(b)]) }
  let judged = [
    #(
      check(
        "camera_permission",
        camera == "granted",
        case camera {
          "granted" -> None
          "denied" -> Some("CAMERA_DENIED")
          "unavailable" -> Some("CAMERA_UNAVAILABLE")
          "in_use" -> Some("CAMERA_IN_USE")
          "insecure_context" -> Some("INSECURE_CONTEXT")
          _ -> Some("CAMERA_UNKNOWN")
        },
        json.null(),
      ),
      camera != "granted",
    ),
    #(
      check(
        "secure_context",
        b.secure_context == Some(True),
        case b.secure_context {
          Some(True) -> None
          _ -> Some("INSECURE_CONTEXT")
        },
        json.null(),
      ),
      b.secure_context != Some(True),
    ),
    #(
      check(
        "frame_dimensions",
        dims_ok,
        case dims_ok {
          True -> None
          False -> Some("FRAME_DIMENSIONS_UNSUPPORTED")
        },
        json.object([
          #("min", pair(l.min_width, l.min_height)),
          #("max", pair(l.max_width, l.max_height)),
        ]),
      ),
      !dims_ok,
    ),
    #(
      check(
        "capture_cadence",
        fps_ok,
        case fps_ok {
          True -> None
          False -> Some("FRAME_RATE_TOO_LOW")
        },
        json.object([#("minSustainedFps", json.int(12))]),
      ),
      !fps_ok,
    ),
    #(
      check(
        "provider_health",
        False,
        Some("PROVIDER_UNAVAILABLE"),
        json.object([#("state", json.string("unavailable"))]),
      ),
      True,
    ),
    reported("person_region", b.person_detected, "PERSON_NOT_DETECTED"),
    reported("ball_detection", b.ball_detected, "BALL_NOT_DETECTED"),
    reported("lighting", b.lighting_ok, "INSUFFICIENT_LIGHT"),
    #(
      check(
        "protocol_observation_support",
        supported,
        case supported {
          True -> None
          False -> Some("UNSUPPORTED_PROTOCOL")
        },
        json.null(),
      ),
      !supported,
    ),
  ]
  http.json(
    200,
    json.object([
      #("checks", json.preprocessed_array(list.map(judged, fn(c) { c.0 }))),
      #("observationReady", json.bool(!list.any(judged, fn(c) { c.1 }))),
      #("combineVerificationAvailable", json.bool(False)),
      #("combineDisabledReason", combine_disabled_reason()),
      #("providerHealth", health()),
    ]),
  )
}

// ---------------------------------------------------------------------------------------------- T&S results

/// `GET /admin/box-cam/cv/results/:providerSessionId`: structured diagnostics of a stored result. There is no raw
/// frame viewer and no write route for the count.
pub fn admin_result(ctx: Ctx, provider_session: String) -> Response {
  let found =
    store.read(ctx.store, fn(read) {
      use r <- result.try(store.one(
        read,
        "SELECT "
          <> result_row.columns
          <> " FROM box_cam_cv_results WHERE provider_session_id = ?",
        [sqlight.text(provider_session)],
        result_row.decoder(),
      ))
      case r {
        Error(Nil) -> Ok(None)
        Ok(r) -> {
          use reasons <- result.map(
            store.query(
              read,
              "SELECT code, value, threshold FROM box_cam_cv_result_codes WHERE provider_session_id = ? AND list = 'quality' ORDER BY ord",
              [sqlight.text(provider_session)],
              {
                use code <- decode.field(0, decode.string)
                use value <- decode.field(1, decode.optional(decode.float))
                use threshold <- decode.field(2, decode.optional(decode.float))
                decode.success(#(code, value, threshold))
              },
            ),
          )
          Some(#(r, reasons))
        }
      }
    })
  case found {
    Error(e) -> http.internal(e)
    Ok(None) -> http.error(404, "NOT_FOUND")
    Ok(Some(#(r, reasons))) -> {
      let num = fn(v) { json.nullable(v, json_text.number) }
      http.json(
        200,
        json.object([
          #(
            "diagnostics",
            json.object([
              #("protocolId", result_row.protocol_id_to_json(r.protocol_id)),
              #("providerId", result_row.provider_id_to_json(r.provider_id)),
              #("providerVersion", json.int(r.provider_version)),
              #("engineVersion", json.int(r.engine_version)),
              #("cvPolicyVersion", json.int(r.cv_policy_version)),
              #("outcome", result_row.outcome_to_json(r.outcome)),
              #("refusalReason", json.nullable(r.refusal_reason, json.string)),
              #(
                "qualityReasons",
                json.array(reasons, fn(x) {
                  json.object([
                    #("code", json.string(x.0)),
                    #("value", num(x.1)),
                    #("threshold", num(x.2)),
                  ])
                }),
              ),
              #(
                "integrity",
                json.object([
                  #("ok", json.bool(r.integrity_ok)),
                  #("framesAccepted", json.int(r.frames_accepted)),
                  #("framesRejected", json.int(r.frames_rejected)),
                  #(
                    "framesDroppedByServer",
                    json.int(r.frames_dropped_by_server),
                  ),
                  #("duplicatesRejected", json.int(r.duplicates_rejected)),
                  #("outOfOrderRejected", json.int(r.out_of_order_rejected)),
                  #("clientClockAnomalies", json.int(r.client_clock_anomalies)),
                  #(
                    "framesAnalysed",
                    json.nullable(r.frames_analysed, json.int),
                  ),
                  #(
                    "duplicateFrames",
                    json.nullable(r.duplicate_frames, json.int),
                  ),
                  #("effectiveFps", num(r.effective_fps)),
                  #("maxBallGapMs", num(r.max_ball_gap_ms)),
                  #("nonceBound", json.bool(r.nonce_bound)),
                  #("serverTimeline", json.bool(r.server_timeline)),
                ]),
              ),
              #("serverStartedAt", json.nullable(r.server_started_at, json.int)),
              #("serverEndedAt", json.nullable(r.server_ended_at, json.int)),
            ]),
          ),
          #("rawFrameViewer", json.null()),
          #(
            "note",
            json.string(
              "Structured diagnostics only. ScoutBox never retains frames, so there is nothing to view. Observed counts cannot be edited.",
            ),
          ),
        ]),
      )
    }
  }
}
