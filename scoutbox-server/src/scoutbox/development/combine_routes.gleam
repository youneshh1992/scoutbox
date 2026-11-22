//// The At-Home Combine's routes (domains/development/boxcam/combine.mjs).
////
//// Every attempt binds a server-minted Box Cam session and completes through Box Cam's own completion, where the
//// measurement is worked out (`combine.apply_progress`): a client never supplies a value, a state or a
//// provenance. A protocol can be Combine Verified only when the provider can certify every capability it needs:
//// web capture certifies none of the ball protocols, `production_cv` none at all until real-world validation
//// passes, so the count and interval protocols run under the test provider, always labelled simulated.

import gleam/dict
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/development/box_cam_rules as box_rules
import scoutbox/development/box_session_routes
import scoutbox/development/box_sessions
import scoutbox/development/box_training
import scoutbox/development/combine.{type Attempt, type Request}
import scoutbox/development/combine_rules.{type Protocol} as rules
import scoutbox/identity/access.{type OrgAccess, type PlayerAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/players.{type Player}
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/json_text
import scoutbox/platform/limits
import scoutbox/platform/metrics
import scoutbox/platform/paging
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/platform/temporal
import scoutbox/recruitment/room_routes
import scoutbox/rows/box_sessions as session_row
import scoutbox/rows/combine_attempts as attempt_row
import scoutbox/rows/combine_requests as request_row
import scoutbox/rows/id
import scoutbox/vocab/box_provider
import scoutbox/vocab/capture_context
import scoutbox/vocab/org_type
import scoutbox/vocab/position
import wisp.{type Request as HttpRequest, type Response}

/// The best honest production provider here. Not `production_cv`: comparing against it would hand
/// `production_cv`'s observation list to the gate.
const production_provider = box_provider.WebClient

const day_ms = 86_400_000

const title_max = 120

const instructions_max = 300

const protocols_max = 20

fn storage(r: Result(a, Fail(e))) -> Result(a, Fail(Response)) {
  room_routes.storage(r)
}

fn refuse(response: Response) -> Result(a, Fail(Response)) {
  store.refuse(response)
}

fn count(tx: Tx, name: String) -> Result(Nil, Fail(e)) {
  metrics.count(tx, "boxCam", name)
}

fn read(ctx: Ctx, f: fn(Read) -> Result(Response, Fail(Response))) -> Response {
  store.read(ctx.store, f) |> room_routes.read_answer
}

fn limited_response(action: limits.Action) -> Response {
  http.json(
    429,
    json.object(
      list.map(limits.limited_body(action), fn(kv) {
        #(kv.0, json.string(kv.1))
      }),
    ),
  )
}

/// The player a guardian holds, or the guardian's 404s.
fn child(
  ctx: Ctx,
  g: Guardian,
  child: id.PlayerId,
  next: fn(Player) -> Response,
) -> Response {
  case list.contains(g.child_ids, child) {
    False -> http.error(404, "CHILD_NOT_FOUND")
    True ->
      case store.read(ctx.store, players.by_id(_, child)) {
        Error(e) -> http.internal(e)
        Ok(None) -> http.error(404, "PLAYER_NOT_FOUND")
        Ok(Some(p)) -> next(p)
      }
  }
}

// ---------------------------------------------------------------------------------------------------- views

fn caps_json(caps: List(box_rules.Capability)) -> Json {
  json.array(caps, fn(c) { json.string(box_rules.capability_to_string(c)) })
}

fn protocol_json(ctx: Ctx, p: Protocol) -> Json {
  let local_test = box_rules.provider(box_provider.LocalTest).capabilities
  let web = box_rules.provider(production_provider).capabilities
  let optional = fn(key, value: Option(a), to_json: fn(a) -> Json) {
    case value {
      Some(v) -> [#(key, to_json(v))]
      None -> []
    }
  }
  json.object(
    list.flatten([
      [
        #("id", json.string(p.id)),
        #("version", json.int(p.version)),
        #("title", json.string(p.title)),
        #("category", json.string(p.category)),
        #("description", json.string(p.description)),
        #("metricType", attempt_row.metric_type_to_json(p.metric_type)),
        #("metricUnit", json.string(p.metric_unit)),
        #("direction", attempt_row.direction_to_json(p.direction)),
        #("precision", json.string(rules.precision_to_string(p.precision))),
        #("protocolWindowMs", json.int(p.protocol_window_ms)),
        #(
          "requiredCapabilities",
          json.array(p.required_capabilities, fn(r) {
            json.string(rules.required_to_string(r))
          }),
        ),
        // production_cv contributes its Combine list, not its observation list, so the ball protocols stay
        // not_configured.
        #(
          "measurementCapability",
          json.string(rules.measurement_capability(
            p,
            list.append(
              rules.combine_capabilities(production_provider),
              rules.combine_capabilities(box_provider.ProductionCv),
            ),
          )),
        ),
        // Reported apart from measurement: what the CV engine can see.
        #(
          "observationCapability",
          json.string(rules.measurement_capability(
            p,
            box_rules.provider(box_provider.ProductionCv).capabilities,
          )),
        ),
        #(
          "demoSupported",
          json.bool(
            ctx.config.box_cam_test_provider
            && rules.measurement_supported(p, local_test),
          ),
        ),
        #("setupRequirements", json.string(p.setup_requirements)),
      ],
      optional("cameraRequirements", p.camera_requirements, json.string),
      optional("spaceRequirements", p.space_requirements, json.string),
      optional("equipmentRequirements", p.equipment_requirements, fn(e) {
        json.array(e, json.string)
      }),
      [
        #(
          "calibrationRequirements",
          json.array(p.calibration_requirements, json.string),
        ),
      ],
      optional("startRule", p.start_rule, json.string),
      optional("finishRule", p.finish_rule, json.string),
      optional("validAttemptRules", p.valid_attempt_rules, json.string),
      [
        #("scoringMethod", json.string(p.scoring_method)),
        #("maxVerifiedPerWindow", json.int(p.max_verified_per_window)),
        #("practiceAllowed", json.bool(p.practice_allowed)),
        #("safetyNotes", json.string(p.safety_notes)),
        #("status", json.string("active")),
        #("unsupportedNote", case rules.measurement_supported(p, web) {
          False ->
            json.string(
              "Combine measurement is not yet supported on this device. ScoutBox will not estimate or fabricate a result for this test.",
            )
          True -> json.null()
        }),
      ],
    ]),
  )
}

fn protocols_json(ctx: Ctx) -> Json {
  json.array(rules.protocols, protocol_json(ctx, _))
}

fn checklist(a: Attempt, p: Protocol) -> Json {
  let item = fn(label, ok) {
    json.object([#("label", json.string(label)), #("ok", json.bool(ok))])
  }
  json.preprocessed_array([
    json.object([
      #("label", json.string("Standardized ScoutBox protocol")),
      #("ok", json.bool(True)),
      #(
        "detail",
        json.string(p.title <> " v" <> json.to_string(json.int(p.version))),
      ),
    ]),
    item("Live Box Cam capture", True),
    item("Liveness passed", True),
    item(
      "Required camera setup passed",
      option.unwrap(a.row.calibration_passed, True),
    ),
    item("Result calculated by ScoutBox", True),
    item("Detector supported this metric", True),
    item("Attempt integrity passed", True),
  ])
}

pub fn attempt_view(a: Attempt, integrity: Bool) -> Json {
  let r = a.row
  let proto = case rules.protocol(r.protocol_id, r.protocol_version) {
    Some(p) -> Some(p)
    None -> rules.latest_protocol(r.protocol_id)
  }
  let state = combine.live_state(a)
  let verified = state == attempt_row.CombineVerified
  let display = case proto {
    Some(p) -> rules.format(p, r.measured_value)
    None -> combine.display(a)
  }
  let required = case rules.protocol(r.protocol_id, r.protocol_version) {
    Some(p) -> p.calibration_requirements
    None -> []
  }
  json.object(
    list.append(
      [
        #("id", id.combine_attempt_json(r.id)),
        #("playerId", id.player_json(r.player_id)),
        #("protocolId", json.string(r.protocol_id)),
        #("protocolVersion", json.int(r.protocol_version)),
        #(
          "protocolTitle",
          json.string(case proto {
            Some(p) -> p.title
            None -> r.protocol_id
          }),
        ),
        #("metricType", attempt_row.metric_type_to_json(r.metric_type)),
        #("metricUnit", json.string(r.metric_unit)),
        #("direction", attempt_row.direction_to_json(r.direction)),
        #("mode", attempt_row.mode_to_json(r.mode)),
        #("captureContext", capture_context.to_json(r.capture_context)),
        #("requestId", json.nullable(r.request_id, id.combine_request_json)),
        #("attemptNumber", json.int(r.attempt_number)),
        #("measuredValue", json.nullable(r.measured_value, json_text.number)),
        #("display", json.string(display)),
        #("unit", json.string(r.metric_unit)),
        #(
          "measurementState",
          json.nullable(
            r.measurement_state,
            attempt_row.measurement_state_to_json,
          ),
        ),
        #("combineState", attempt_row.combine_state_to_json(state)),
        #("stateCopy", json.nullable(rules.state_copy(state), json.string)),
        #("reasons", json.array(a.reasons, json.string)),
        #("provider", box_provider.to_json(r.provider_id)),
        #("providerVersion", json.int(r.provider_version)),
        #("simulated", json.bool(box_rules.provider(r.provider_id).test_only)),
        #("calibration", case r.calibration_passed, r.calibrated_at {
          Some(passed), Some(at) ->
            json.object([
              #("required", json.array(required, json.string)),
              #("passed", json.bool(passed)),
              #("checks", json.array(a.checks, json.string)),
              #("at", json.int(at)),
            ])
          _, _ -> json.null()
        }),
        #("startedAt", json.nullable(r.started_at, json.int)),
        #("completedAt", json.nullable(r.completed_at, json.int)),
        #("createdAt", json.int(r.created_at)),
        #("provenance", case verified {
          True -> json.string("box_cam_observed")
          False -> json.null()
        }),
        #("provenanceLabel", case verified {
          True -> json.string("Combine Verified")
          False -> json.null()
        }),
        #("verificationExplained", case verified, proto {
          True, Some(p) -> checklist(a, p)
          _, _ -> json.null()
        }),
      ],
      case integrity {
        True -> [
          #("boxSessionId", id.box_session_json(r.box_session_id)),
          #("resultHash", json.nullable(r.result_hash, json.string)),
          #(
            "measurementAlgorithmVersion",
            json.int(r.measurement_algorithm_version),
          ),
        ]
        False -> []
      },
    ),
  )
}

fn attempt_json(a: Attempt) -> Response {
  http.json(200, json.object([#("attempt", attempt_view(a, True))]))
}

// ---------------------------------------------------------------------------------------------- protocols

/// `GET /org/combine/protocols`: a club selects from the registry and can never alter a protocol's rules.
pub fn org_protocols(ctx: Ctx) -> Response {
  http.json(
    200,
    json.object([
      #("protocols", protocols_json(ctx)),
      #(
        "note",
        json.string(
          "Standardized protocols. A club selects from this registry and can never alter a protocol’s rules.",
        ),
      ),
    ]),
  )
}

/// `GET /player/combine/protocols`.
pub fn player_protocols(ctx: Ctx) -> Response {
  let prod = box_rules.provider(production_provider)
  http.json(
    200,
    json.object([
      #("protocols", protocols_json(ctx)),
      #(
        "productionProvider",
        json.object([
          #("id", box_provider.to_json(prod.id)),
          #("status", json.string(prod.status)),
          #("label", json.string(option.unwrap(prod.label, prod.status))),
          #("capabilities", caps_json(prod.capabilities)),
        ]),
      ),
      #("testProviderEnabled", json.bool(ctx.config.box_cam_test_provider)),
      #(
        "note",
        json.string(
          "A Combine test can be Combine Verified only when the active detector genuinely supports its metric. Unsupported tests are labelled honestly and never estimated.",
        ),
      ),
    ]),
  )
}

// ------------------------------------------------------------------------------------------- player reads

fn my_combine(read: Read, player: id.PlayerId) -> Result(Response, Fail(e)) {
  use attempts <- result.try(combine.attempts_for_player(read, player))
  use bests <- result.try(combine.bests(read, player))
  use requests <- result.map(combine.for_player(read, player))
  http.json(
    200,
    json.object([
      #("verifiedResults", json.array(bests, attempt_view(_, False))),
      #("personalBests", json.int(list.length(bests))),
      #("attempts", json.array(list.take(attempts, 50), attempt_view(_, False))),
      #(
        "activeRequests",
        json.array(
          list.filter(requests, fn(r) {
            r.row.state != request_row.Cancelled
            && r.row.state != request_row.Completed
          }),
          combine.request_view,
        ),
      ),
      #(
        "capabilityNote",
        json.string(
          "Real numbers. Real evidence. From anywhere. Some tests are not yet measurable on this device — those are marked, never estimated.",
        ),
      ),
    ]),
  )
}

/// `GET /player/combine`.
pub fn mine(ctx: Ctx, p: PlayerAccess) -> Response {
  read(ctx, fn(r) { my_combine(r, p.player.row.id) |> storage })
}

/// `GET /guardian/children/:id/combine`.
pub fn child_combine(ctx: Ctx, g: Guardian, child_id: id.PlayerId) -> Response {
  use p <- child(ctx, g, child_id)
  read(ctx, fn(r) { my_combine(r, p.row.id) |> storage })
}

/// `GET /player/combine/card`: standardised measurements, not an overall rating.
pub fn card(ctx: Ctx, p: PlayerAccess) -> Response {
  let now = clock.now_ms()
  let player = p.player
  use r <- read(ctx)
  use bests <- result.map(combine.bests(r, player.row.id) |> storage)
  http.json(
    200,
    json.object([
      #(
        "player",
        json.object([
          #("id", id.player_json(player.row.id)),
          #("name", json.string(player.row.name)),
          #("age", json.int(players.age_now(player, now))),
          #("position", json.nullable(player.row.position, position.to_json)),
        ]),
      ),
      #(
        "results",
        json.array(bests, fn(a) {
          json.object([
            #("protocolId", json.string(a.row.protocol_id)),
            #(
              "protocolTitle",
              json.string(combine.title_of(
                a.row.protocol_id,
                a.row.protocol_version,
              )),
            ),
            #("display", json.string(combine.display(a))),
            #("unit", json.string(a.row.metric_unit)),
            #("combineVerified", json.bool(True)),
            #("protocolVersion", json.int(a.row.protocol_version)),
            #("completedAt", json.nullable(a.row.completed_at, json.int)),
          ])
        }),
      ),
      #("capturedBy", json.string("box_cam")),
      #("updatedAt", json.int(now)),
      #(
        "note",
        json.string(
          "This card is a collection of standardized measurements captured with Box Cam. It is not an overall rating — clubs decide what matters.",
        ),
      ),
    ]),
  )
}

/// `GET /player/combine/attempts`: the latest hundred, with their integrity fields.
pub fn attempts(ctx: Ctx, p: PlayerAccess) -> Response {
  use r <- read(ctx)
  use all <- result.map(
    combine.attempts_for_player(r, p.player.row.id) |> storage,
  )
  http.json(
    200,
    json.object([
      #("items", json.array(list.take(all, 100), attempt_view(_, True))),
    ]),
  )
}

/// `GET /player/combine/attempts/:id`.
pub fn attempt(
  ctx: Ctx,
  p: PlayerAccess,
  aid: id.CombineAttemptId,
) -> Response {
  use r <- read(ctx)
  use found <- result.map(
    combine.own_attempt(r, p.player.row.id, aid) |> storage,
  )
  case found {
    Some(a) -> attempt_json(a)
    None -> http.error(404, "ATTEMPT_NOT_FOUND")
  }
}

// ------------------------------------------------------------------------------------------- new attempts

type AttemptBody {
  AttemptBody(
    protocol_id: Option(String),
    mode: Option(attempt_row.Mode),
    provider: Option(String),
    capture_context: Option(capture_context.CaptureContext),
    request_id: Option(String),
  )
}

/// `POST /player/combine/attempts`: the server mints the bound Box Cam session, its nonce and its liveness
/// challenge in one unit with the attempt. A body naming a session is refused as an unknown field.
pub fn create_attempt(ctx: Ctx, req: HttpRequest, p: PlayerAccess) -> Response {
  let shape = {
    use protocol_id <- input.field("protocolId", input.optional(input.text(80)))
    use mode <- input.field(
      "mode",
      input.optional(input.one_of(attempt_row.mode_pairs)),
    )
    use provider <- input.field("provider", input.optional(input.text(80)))
    use capture_context <- input.field(
      "captureContext",
      input.optional(input.one_of(capture_context.pairs)),
    )
    use request_id <- input.field("requestId", input.nullish(input.text(80)))
    input.done(AttemptBody(
      protocol_id:,
      mode:,
      provider:,
      capture_context:,
      request_id:,
    ))
  }
  use b <- http.body(req, shape, [
    #("mode", "MODE_INVALID"),
    #("captureContext", "CAPTURE_CONTEXT_INVALID"),
  ])
  let player = p.player
  let now = clock.now_ms()
  let mode = option.unwrap(b.mode, attempt_row.Verified)
  case
    limits.limited(
      ctx.limits,
      limits.CombineAttempt,
      id.player_to_string(player.row.id),
      now,
    )
  {
    True -> limited_response(limits.CombineAttempt)
    False ->
      case rules.latest_protocol(option.unwrap(b.protocol_id, "")) {
        Some(proto) if proto.active ->
          case mode, proto.practice_allowed, proto.adult_only {
            attempt_row.ModePractice, False, _ ->
              http.error(400, "PRACTICE_NOT_ALLOWED")
            _, _, True ->
              case players.is_adult(player, now) {
                True -> with_provider(ctx, player, proto, mode, b, now)
                False -> http.error(403, "ADULT_ONLY")
              }
            _, _, False -> with_provider(ctx, player, proto, mode, b, now)
          }
        _ -> http.error(404, "PROTOCOL_UNKNOWN")
      }
  }
}

fn with_provider(
  ctx: Ctx,
  player: Player,
  proto: Protocol,
  mode: attempt_row.Mode,
  b: AttemptBody,
  now: Int,
) -> Response {
  case
    box_rules.provider_for(
      option.unwrap(b.provider, box_provider.to_string(production_provider)),
      ctx.config.box_cam_test_provider,
    )
  {
    None -> http.error(403, "PROVIDER_UNAVAILABLE")
    Some(provider) -> {
      // A provider that cannot measure the metric gets no verified or practice attempt.
      let combine_caps = rules.combine_capabilities(provider.id)
      case rules.measurement_supported(proto, combine_caps) {
        False -> unsupported(ctx, proto, provider, combine_caps)
        True -> mint(ctx, player, proto, mode, provider, b, now)
      }
    }
  }
}

fn unsupported(
  ctx: Ctx,
  proto: Protocol,
  provider: box_rules.Provider,
  combine_caps: List(box_rules.Capability),
) -> Response {
  // "Cannot see this" and "sees it but may not certify it" have different remedies.
  let observation_only =
    rules.measurement_supported(proto, provider.capabilities)
  let body =
    json.object([
      #("error", json.string("MEASUREMENT_NOT_SUPPORTED")),
      #(
        "message",
        json.string(case observation_only {
          True ->
            "Box Cam can observe this activity, but Combine verification is not available yet for this protocol. Real-world validation has not been completed."
          False ->
            "This Combine measurement is not yet supported on this device. ScoutBox does not estimate or fabricate a result."
        }),
      ),
      #(
        "reason",
        json.string(case observation_only {
          True -> "REAL_WORLD_VALIDATION_NOT_COMPLETED"
          False -> "MEASUREMENT_NOT_SUPPORTED"
        }),
      ),
      #("observationSupported", json.bool(observation_only)),
      #(
        "missingCapabilities",
        json.array(rules.missing_capabilities(proto, combine_caps), fn(r) {
          json.string(rules.required_to_string(r))
        }),
      ),
    ])
  store.unit(ctx.store, fn(tx) {
    count(tx, "combine_measurement_provider_error")
    |> storage
    |> result.replace(http.json(422, body))
  })
  |> room_routes.answer
}

fn mint(
  ctx: Ctx,
  player: Player,
  proto: Protocol,
  mode: attempt_row.Mode,
  provider: box_rules.Provider,
  b: AttemptBody,
  now: Int,
) -> Response {
  let pid = player.row.id
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    // Attempt limits apply to verified attempts; practice is capped generously.
    use <- within_limits(read, pid, proto, mode, now)
    use request <- result.try(case b.request_id {
      None | Some("") -> Ok(None)
      Some(rid) -> {
        use found <- result.try(
          combine.request_by_id(read, id.combine_request(rid)) |> storage,
        )
        case found {
          Some(r)
            if r.row.player_id == pid && r.row.state != request_row.Cancelled
          ->
            case list.contains(r.protocol_ids, proto.id) {
              True -> Ok(Some(r.row.id))
              False -> refuse(http.error(400, "PROTOCOL_NOT_IN_REQUEST"))
            }
          _ -> refuse(http.error(404, "REQUEST_NOT_FOUND"))
        }
      }
    })
    let drill = option.then(proto.drill_id, box_rules.latest_drill)
    case drill, proto.drill_target {
      Some(drill), Some(target) -> {
        use before <- result.try(
          combine.attempt_count(read, pid, proto.id, None, None) |> storage,
        )
        let context = option.unwrap(b.capture_context, capture_context.AtHome)
        use #(session, nonce) <- result.try(
          box_sessions.mint(
            tx,
            pid,
            drill,
            target,
            provider,
            None,
            None,
            Some(context),
            now,
          )
          |> storage,
        )
        use _ <- result.try(count(tx, "box_sessions_started") |> storage)
        use a <- result.try(
          combine.create_attempt(
            tx,
            combine.NewAttempt(
              player: pid,
              protocol: proto,
              session:,
              attempt_number: before + 1,
              mode:,
              capture_context: context,
              request:,
              provider:,
            ),
            now,
          )
          |> storage,
        )
        use _ <- result.try(count(tx, "combine_attempt_started") |> storage)
        use _ <- result.try(case mode {
          attempt_row.ModePractice ->
            count(tx, "combine_practice_started") |> storage
          attempt_row.Verified -> Ok(Nil)
        })
        Ok(minted(ctx, a, session, nonce, proto))
      }
      _, _ -> refuse(http.error(500, "PROTOCOL_DRILL_MISSING"))
    }
  })
  |> room_routes.answer
}

fn within_limits(
  read: Read,
  player: id.PlayerId,
  proto: Protocol,
  mode: attempt_row.Mode,
  now: Int,
  next: fn() -> Result(Response, Fail(Response)),
) -> Result(Response, Fail(Response)) {
  case mode {
    attempt_row.Verified -> {
      use recent <- result.try(
        combine.attempt_count(
          read,
          player,
          proto.id,
          Some(attempt_row.Verified),
          Some(now - proto.window_ms),
        )
        |> storage,
      )
      case recent >= proto.max_verified_per_window {
        True ->
          refuse(http.json(
            429,
            json.object([
              #("error", json.string("ATTEMPT_LIMIT_REACHED")),
              #("maxVerifiedPerWindow", json.int(proto.max_verified_per_window)),
              #(
                "message",
                json.string(
                  "You have used your verified attempts for this Combine. Practice attempts remain available.",
                ),
              ),
            ]),
          ))
        False -> next()
      }
    }
    attempt_row.ModePractice -> {
      use recent <- result.try(
        combine.attempt_count(
          read,
          player,
          proto.id,
          Some(attempt_row.ModePractice),
          Some(now - day_ms),
        )
        |> storage,
      )
      case recent >= 20 {
        True -> refuse(http.error(429, "RATE_LIMITED"))
        False -> next()
      }
    }
  }
}

fn minted(
  ctx: Ctx,
  a: Attempt,
  session: session_row.Row,
  nonce: String,
  proto: Protocol,
) -> Response {
  // The nonce and the liveness challenge exist only in this response.
  http.json(
    201,
    json.object([
      #("attempt", attempt_view(a, True)),
      #(
        "boxSession",
        box_sessions.view(box_sessions.Session(session, []), False),
      ),
      #("nonce", json.string(nonce)),
      #(
        "livenessChallenge",
        session_row.liveness_challenge_to_json(session.liveness_challenge),
      ),
      #(
        "livenessNote",
        json.string(
          "The liveness check establishes live-session presence. It is not identity verification.",
        ),
      ),
      #("expiresAt", json.int(session.expires_at)),
      #("protocol", protocol_json(ctx, proto)),
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
      #(
        "calibration",
        json.object([
          #("required", json.array(proto.calibration_requirements, json.string)),
          #(
            "note",
            json.string(case proto.calibration_requirements {
              [] ->
                "No physical-scale calibration required — standardized geometry only."
              _ ->
                "This protocol needs a Box Marker for physical-scale calibration."
            }),
          ),
        ]),
      ),
    ]),
  )
}

// ------------------------------------------------------------------------------------ an attempt's acts

/// The player's own attempt that is not finished yet, inside a unit.
fn open_attempt(
  read: Read,
  player: id.PlayerId,
  aid: id.CombineAttemptId,
  finished: fn() -> Response,
) -> Result(Attempt, Fail(Response)) {
  use found <- result.try(combine.own_attempt(read, player, aid) |> storage)
  case found {
    None -> refuse(http.error(404, "ATTEMPT_NOT_FOUND"))
    Some(a) ->
      case rules.is_terminal(a.row.combine_state) {
        True -> refuse(finished())
        False -> Ok(a)
      }
  }
}

fn body_or_refuse(body: Result(a, Response)) -> Result(a, Fail(Response)) {
  result.map_error(body, store.Refuse)
}

fn reread(read: Read, aid: id.CombineAttemptId) -> Result(Attempt, Fail(e)) {
  use found <- result.map(combine.attempt_by_id(read, aid))
  let assert Some(a) = found
  a
}

type CalibrateBody {
  CalibrateBody(checks: Option(List(String)))
}

/// `POST /player/combine/attempts/:id/calibrate`. The current protocols need standardised geometry only; physical
/// scale (a Box Marker) is for future protocols, which are unsupported anyway.
pub fn calibrate(
  ctx: Ctx,
  req: HttpRequest,
  p: PlayerAccess,
  aid: id.CombineAttemptId,
) -> Response {
  let body =
    http.parse_body(
      req,
      {
        use checks <- input.field(
          "checks",
          input.optional(input.items(input.text_between(1, 60), 10)),
        )
        input.done(CalibrateBody(checks:))
      },
      [],
    )
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use a <- result.try(
      open_attempt(read, p.player.row.id, aid, fn() {
        http.error(409, "ALREADY_FINALIZED")
      }),
    )
    use b <- result.try(body_or_refuse(body))
    let checks = option.unwrap(b.checks, [])
    let required = case
      rules.protocol(a.row.protocol_id, a.row.protocol_version)
    {
      Some(proto) -> proto.calibration_requirements
      None -> []
    }
    let passed = list.all(required, list.contains(checks, _))
    use _ <- result.try(
      combine.calibrate(tx, aid, passed, checks, now) |> storage,
    )
    use a <- result.map(reread(read, aid) |> storage)
    http.json(
      200,
      json.object([
        #("attempt", attempt_view(a, True)),
        #("calibrationPassed", json.bool(passed)),
      ]),
    )
  })
  |> room_routes.answer
}

type NonceBody {
  NonceBody(nonce: Option(String))
}

/// `POST /player/combine/attempts/:id/complete`: the bound session completes through Box Cam, which works out the
/// measurement. A body naming a value, a state or a provenance is refused as an unknown field.
pub fn complete(
  ctx: Ctx,
  req: HttpRequest,
  p: PlayerAccess,
  aid: id.CombineAttemptId,
) -> Response {
  let body =
    http.parse_body(
      req,
      {
        use nonce <- input.field("nonce", input.optional(input.text(256)))
        input.done(NonceBody(nonce:))
      },
      [],
    )
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use a <- result.try(
      open_attempt(read, p.player.row.id, aid, fn() {
        http.error_message(
          409,
          "ALREADY_FINALIZED",
          "A completed Combine Attempt cannot be submitted again.",
        )
      }),
    )
    use b <- result.try(body_or_refuse(body))
    use found <- result.try(
      box_sessions.by_id(read, a.row.box_session_id) |> storage,
    )
    use s <- result.try(case found {
      Some(s) -> Ok(s)
      None -> refuse(http.error(404, "SESSION_NOT_FOUND"))
    })
    use <- guard(!box_sessions.nonce_matches(s.row, b.nonce), fn() {
      http.error(403, "NONCE_INVALID")
    })
    use <- guard(s.row.status != session_row.Recording, fn() {
      http.json(
        409,
        json.object([
          #("error", json.string("SESSION_NOT_RECORDING")),
          #("status", session_row.status_to_json(s.row.status)),
        ]),
      )
    })
    use _ <- result.try(
      combine.mark_started(tx, aid, s.row.started_at) |> storage,
    )
    use done <- result.try(
      box_session_routes.complete_session(tx, s, p.player, now) |> storage,
    )
    use a <- result.map(reread(read, aid) |> storage)
    http.json(
      200,
      json.object([
        #("attempt", attempt_view(a, True)),
        #("boxSession", box_sessions.view(done, False)),
      ]),
    )
  })
  |> room_routes.answer
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

/// `POST /player/combine/attempts/:id/cancel`: a recording bound session is cancelled with it.
pub fn cancel(
  ctx: Ctx,
  req: HttpRequest,
  p: PlayerAccess,
  aid: id.CombineAttemptId,
) -> Response {
  use _ <- http.body(req, input.nothing(), [])
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use a <- result.try(
      open_attempt(read, p.player.row.id, aid, fn() {
        http.error(409, "ALREADY_FINALIZED")
      }),
    )
    use found <- result.try(
      box_sessions.by_id(read, a.row.box_session_id) |> storage,
    )
    use _ <- result.try(case found {
      Some(s) if s.row.status == session_row.Recording ->
        box_sessions.cancel(tx, s.row.id) |> storage
      _ -> Ok(Nil)
    })
    use _ <- result.try(combine.cancel_attempt(tx, aid, now) |> storage)
    use a <- result.map(reread(read, aid) |> storage)
    http.json(200, json.object([#("attempt", attempt_view(a, False))]))
  })
  |> room_routes.answer
}

/// `GET /admin/combine/attempts/:id`: T&S reviews the bound session; it can invalidate it, never type a number.
pub fn admin_attempt(ctx: Ctx, aid: id.CombineAttemptId) -> Response {
  use r <- read(ctx)
  use found <- result.try(combine.attempt_by_id(r, aid) |> storage)
  case found {
    None -> Ok(http.error(404, "ATTEMPT_NOT_FOUND"))
    Some(a) -> {
      use session <- result.map(
        box_sessions.by_id(r, a.row.box_session_id) |> storage,
      )
      http.json(
        200,
        json.object([
          #("attempt", attempt_view(a, True)),
          #("boxSession", case session {
            Some(s) -> box_sessions.view(s, True)
            None -> json.object([])
          }),
        ]),
      )
    }
  }
}

// ----------------------------------------------------------------------------------------------- requests

fn open_requests(read: Read, player: id.PlayerId) -> Result(Response, Fail(e)) {
  use requests <- result.map(combine.for_player(read, player))
  http.json(
    200,
    json.object([
      #(
        "items",
        json.array(
          list.filter(requests, fn(r) { r.row.state != request_row.Cancelled }),
          combine.request_view,
        ),
      ),
    ]),
  )
}

/// `GET /player/combine/requests`.
pub fn player_requests(ctx: Ctx, p: PlayerAccess) -> Response {
  read(ctx, fn(r) { open_requests(r, p.player.row.id) |> storage })
}

/// `GET /guardian/children/:id/combine/requests`.
pub fn child_requests(ctx: Ctx, g: Guardian, child: id.PlayerId) -> Response {
  case list.contains(g.child_ids, child) {
    False -> http.error(404, "CHILD_NOT_FOUND")
    True -> read(ctx, fn(r) { open_requests(r, child) |> storage })
  }
}

type RequestBody {
  RequestBody(
    title: Option(String),
    protocol_ids: Option(List(String)),
    deadline: Option(Option(temporal.Day)),
    instructions: Option(String),
    player_ids: Option(List(String)),
    player_id: Option(String),
  )
}

/// `POST /org/combine/requests`: a verified organisation that is not an agency selects standardised protocols for
/// players it can already see. A body carrying protocol rules is refused as unknown fields.
pub fn create_requests(ctx: Ctx, req: HttpRequest, a: OrgAccess) -> Response {
  let shape = {
    use title <- input.field("title", input.nullish(input.text(title_max)))
    use protocol_ids <- input.field(
      "protocolIds",
      input.optional(input.items(input.id(), protocols_max)),
    )
    use deadline <- input.field("deadline", input.nullish(input.day_or_blank()))
    use instructions <- input.field(
      "instructions",
      input.nullish(input.text(instructions_max)),
    )
    use player_ids <- input.field(
      "playerIds",
      input.optional(input.items(input.text(80), 1_000_000)),
    )
    use player_id <- input.field("playerId", input.nullish(input.text(80)))
    input.done(RequestBody(
      title:,
      protocol_ids:,
      deadline:,
      instructions:,
      player_ids:,
      player_id:,
    ))
  }
  use b <- http.body(req, shape, [])
  let now = clock.now_ms()
  let org = a.org
  use <- when(
    limits.limited(
      ctx.limits,
      limits.RoomCombineRequest,
      id.org_to_string(org.id),
      now,
    ),
    fn() { limited_response(limits.RoomCombineRequest) },
  )
  use <- when(org.type_ == org_type.Agency, fn() {
    http.error_message(
      403,
      "AGENCY_NOT_ELIGIBLE",
      "Agencies cannot request At-Home Combines.",
    )
  })
  use <- when(org.suspended, fn() { http.error(403, "ORG_SUSPENDED") })
  use <- when(!org.verified, fn() {
    http.error_message(
      403,
      "ORG_NOT_ELIGIBLE",
      "Only a verified organisation can create a Club Combine.",
    )
  })
  let ids = list.unique(option.unwrap(b.protocol_ids, []))
  use <- when(ids == [], fn() {
    http.required("PROTOCOLS_REQUIRED", "protocolIds")
  })
  case list.find(ids, fn(pid) { !combine.protocol_active(pid) }) {
    Ok(unknown) ->
      http.json(
        404,
        json.object([
          #("error", json.string("PROTOCOL_UNKNOWN")),
          #("protocolId", json.string(unknown)),
        ]),
      )
    Error(Nil) -> {
      let player_ids = case b.player_ids, b.player_id {
        Some(listed), _ -> listed
        None, Some(one) if one != "" -> [one]
        None, _ -> []
      }
      use <- when(player_ids == [], fn() {
        http.required("PLAYERS_REQUIRED", "playerIds")
      })
      // An empty text is no instructions; anything else is kept as written.
      let instructions = case b.instructions {
        Some("") -> None
        other -> other
      }
      use <- room_routes.moderated(ctx, a, instructions, "combine_request")
      let new =
        combine.NewRequest(
          protocol_ids: ids,
          title: option.unwrap(b.title, "")
            |> string.trim
            |> input.utf16_take(title_max)
            |> Some
            |> input.filled,
          deadline: option.flatten(b.deadline) |> option.map(temporal.day_text),
          instructions: option.map(instructions, input.utf16_take(
            _,
            instructions_max,
          )),
        )
      store.unit(ctx.store, fn(tx) { create_for(tx, a, player_ids, new, now) })
      |> room_routes.answer
    }
  }
}

fn when(
  refused: Bool,
  response: fn() -> Response,
  next: fn() -> Response,
) -> Response {
  case refused {
    True -> response()
    False -> next()
  }
}

/// One unit: every request, its ledger row and its notice commit together. A request doesn't widen access: a
/// player the organisation cannot see is skipped.
fn create_for(
  tx: Tx,
  a: OrgAccess,
  player_ids: List(String),
  new: combine.NewRequest,
  now: Int,
) -> Result(Response, Fail(Response)) {
  let read = store.reading(tx)
  use outcomes <- result.try(
    list.try_map(player_ids, fn(pid) {
      use found <- result.try(
        players.for_org(read, id.player(pid), a.org, now) |> storage,
      )
      case found {
        Some(#(p, access)) if access.visible && !access.blocked ->
          combine.create(tx, a.org, a.user, p, new, now)
          |> storage
          |> result.map(Ok)
        Some(_) -> Ok(Error(#(pid, "NOT_VISIBLE")))
        None -> Ok(Error(#(pid, "PLAYER_NOT_FOUND")))
      }
    }),
  )
  let created = result.values(outcomes)
  let skipped =
    list.filter_map(outcomes, fn(o) {
      case o {
        Error(s) -> Ok(s)
        Ok(_) -> Error(Nil)
      }
    })
  use _ <- result.try(
    list.try_each(created, fn(_) { count(tx, "combine_request_created") })
    |> storage,
  )
  use _ <- result.try(
    case list.length(created) > 1 || list.length(player_ids) > 1 {
      True -> count(tx, "club_combine_created") |> storage
      False -> Ok(Nil)
    },
  )
  Ok(http.json(
    case created {
      [] -> 409
      _ -> 201
    },
    json.object([
      #("requests", json.array(created, combine.request_view)),
      #(
        "skipped",
        json.array(skipped, fn(s) {
          json.object([
            #("playerId", json.string(s.0)),
            #("reason", json.string(s.1)),
          ])
        }),
      ),
    ]),
  ))
}

type OrgListQuery {
  OrgListQuery(page: paging.Query, player_id: Option(String))
}

/// `GET /org/combine/requests`: the organisation's requests to players it may still see, newest first.
pub fn org_requests(ctx: Ctx, req: HttpRequest, a: OrgAccess) -> Response {
  let shape = {
    use limit <- input.field("limit", input.optional(input.text(1000)))
    use cursor <- input.field("cursor", input.optional(input.text(100_000)))
    use player_id <- input.field("playerId", input.optional(input.text(80)))
    input.done(OrgListQuery(page: paging.Query(limit:, cursor:), player_id:))
  }
  use q <- http.query(req, shape, [])
  let now = clock.now_ms()
  let filter = case q.player_id {
    Some(pid) if pid != "" -> Some(id.player(pid))
    _ -> None
  }
  use r <- read(ctx)
  use all <- result.try(combine.for_org(r, a.org.id, filter) |> storage)
  use mine <- result.try(
    list.try_map(all, fn(x) {
      players.for_org(r, x.row.player_id, a.org, now)
      |> result.map(fn(found) {
        case found {
          Some(#(_, access)) if access.visible && !access.blocked -> Ok(x)
          _ -> Error(Nil)
        }
      })
    })
    |> result.map(result.values)
    |> storage,
  )
  case paging.read(q.page, [paging.IntKind, paging.TextKind]) {
    Error(e) -> refuse(box_training.page_refusal(e))
    Ok(page) -> {
      let #(items, next) =
        box_training.page_newest_first(page, mine, fn(x: Request) {
          #(x.row.created_at, id.combine_request_to_string(x.row.id))
        })
      Ok(http.json(
        200,
        json.object([
          #("items", json.array(items, combine.request_view)),
          #("nextCursor", json.nullable(next, json.string)),
        ]),
      ))
    }
  }
}

/// `POST /org/combine/requests/:id/cancel`.
pub fn cancel_request(
  ctx: Ctx,
  req: HttpRequest,
  a: OrgAccess,
  rid: id.CombineRequestId,
) -> Response {
  use _ <- http.body(req, input.nothing(), [])
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use found <- result.try(combine.request_by_id(read, rid) |> storage)
    case found {
      Some(r) if r.row.org_id == a.org.id ->
        case r.row.state {
          request_row.Completed -> refuse(http.error(409, "ALREADY_COMPLETED"))
          _ -> {
            use _ <- result.try(combine.cancel_request(tx, rid) |> storage)
            use found <- result.map(combine.request_by_id(read, rid) |> storage)
            let assert Some(r) = found
            http.json(200, json.object([#("request", combine.request_view(r))]))
          }
        }
      _ -> refuse(http.error(404, "REQUEST_NOT_FOUND"))
    }
  })
  |> room_routes.answer
}

// --------------------------------------------------------------------------------------- results, compare

/// Whom the organisation may show results of: the standing gates, then the Combine's consent.
fn may_see(
  read: Read,
  a: OrgAccess,
  player: id.PlayerId,
  now: Int,
) -> Result(Option(#(Player, Bool)), Fail(e)) {
  use found <- result.try(players.for_org(read, player, a.org, now))
  case found {
    Some(#(p, access)) if access.visible && !access.blocked ->
      combine.org_may_see_results(read, a.org.id, p.row.id)
      |> result.map(fn(may) { Some(#(p, may)) })
    _ -> Ok(None)
  }
}

/// `GET /org/combine/players/:id`.
pub fn player_results(
  ctx: Ctx,
  a: OrgAccess,
  player_id: id.PlayerId,
) -> Response {
  let now = clock.now_ms()
  use r <- read(ctx)
  use found <- result.try(players.for_org(r, player_id, a.org, now) |> storage)
  case found {
    None -> Ok(http.error(404, "PLAYER_NOT_FOUND"))
    Some(#(_, access)) if !access.visible || access.blocked ->
      Ok(http.error(403, "NOT_VISIBLE"))
    Some(#(p, _)) -> {
      use may <- result.try(
        combine.org_may_see_results(r, a.org.id, p.row.id) |> storage,
      )
      case may {
        False ->
          Ok(http.json(
            200,
            json.object([
              #("playerId", id.player_json(p.row.id)),
              #("results", json.preprocessed_array([])),
              #("shared", json.bool(False)),
              #(
                "note",
                json.string(
                  "This player has not shared Combine results with your organisation. Request an At-Home Combine or ask them to share development activity.",
                ),
              ),
            ]),
          ))
        True -> {
          use fields <- result.map(
            combine.projection_fields(r, p.row.id, combine.projection_note)
            |> storage,
          )
          http.json(
            200,
            json.object([
              #("playerId", id.player_json(p.row.id)),
              #("playerName", json.string(p.row.name)),
              #("shared", json.bool(True)),
              ..fields
            ]),
          )
        }
      }
    }
  }
}

type CompareQuery {
  CompareQuery(
    player_ids: Option(List(String)),
    protocols: Option(List(String)),
  )
}

/// `GET /org/combine/compare?playerIds=a,b&protocols=x,y`: a player the organisation may not see results of is
/// left out silently, with no leak and no ranking.
pub fn compare(ctx: Ctx, req: HttpRequest, a: OrgAccess) -> Response {
  let shape = {
    use player_ids <- input.field(
      "playerIds",
      input.optional(input.ids_text(30)),
    )
    use protocols <- input.field(
      "protocols",
      input.optional(input.ids_text(protocols_max)),
    )
    input.done(CompareQuery(player_ids:, protocols:))
  }
  use q <- http.query(req, shape, [])
  let now = clock.now_ms()
  let local_test = box_rules.provider(box_provider.LocalTest).capabilities
  let protocols = case option.unwrap(q.protocols, []) {
    [] ->
      list.filter(rules.protocols, fn(p) {
        rules.measurement_supported(p, local_test)
      })
    listed ->
      list.filter_map(listed, fn(pid) {
        rules.latest_protocol(pid) |> option.to_result(Nil)
      })
  }
  use r <- read(ctx)
  use seen <- result.map(
    list.try_map(option.unwrap(q.player_ids, []), fn(pid) {
      use found <- result.try(may_see(r, a, id.player(pid), now))
      case found {
        Some(#(p, True)) -> {
          use bests <- result.map(combine.bests(r, p.row.id))
          Some(#(p, bests))
        }
        _ -> Ok(None)
      }
    })
    |> storage,
  )
  let seen = option.values(seen)
  let cells =
    list.flat_map(seen, fn(entry) {
      let #(p, bests) = entry
      let pid = id.player_to_string(p.row.id)
      list.filter_map(protocols, fn(proto) {
        list.find(bests, fn(b) {
          b.row.protocol_id == proto.id
          && b.row.protocol_version == proto.version
        })
        |> result.map(fn(b) {
          #(
            rules.cell_key(pid, proto),
            rules.Cell(
              option.unwrap(b.row.measured_value, 0.0),
              b.row.completed_at,
            ),
          )
        })
      })
    })
  http.json(
    200,
    rules.comparison(
      list.map(seen, fn(entry) {
        #(id.player_to_string({ entry.0 }.row.id), { entry.0 }.row.name)
      }),
      protocols,
      dict.from_list(cells),
    ),
  )
}
