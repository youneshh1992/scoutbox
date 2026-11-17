//// A Recruitment Room's case routes (domains/recruitment/lifecycle/index.mjs and decisionRoutes.mjs): the
//// journey, the lifecycle act, and the formal decision with its single draft. There is no stage setter: the
//// client names an action and the server decides whether it is possible, permitted and supported by evidence.
//// A positive decision ends at `offer_consideration`; nothing here writes an Offer or tells the player.

import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/io
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess, type PlayerAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/players
import scoutbox/messaging/delivery
import scoutbox/messaging/notifications
import scoutbox/platform/canonical
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/idempotency
import scoutbox/platform/input
import scoutbox/platform/limits
import scoutbox/platform/rev
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/recruitment/case_lifecycle
import scoutbox/recruitment/cases.{type Room}
import scoutbox/recruitment/decisions.{type Decision, type Draft}
import scoutbox/recruitment/domain_errors
import scoutbox/recruitment/journey
import scoutbox/recruitment/lifecycle
import scoutbox/recruitment/room_routes
import scoutbox/recruitment/room_rules
import scoutbox/recruitment/room_view
import scoutbox/rows/assessments as assessment_row
import scoutbox/rows/id
import scoutbox/rows/orgs
import scoutbox/safety/audit
import scoutbox/vocab/audience
import scoutbox/vocab/decision_evidence_kind
import scoutbox/vocab/decision_outcome.{type DecisionOutcome}
import scoutbox/vocab/room_status
import wisp.{type Request, type Response}

fn refuse(
  code: String,
  message: String,
  fields: List(#(String, Json)),
) -> Response {
  domain_errors.refuse(domain_errors.lifecycle, code, message, fields)
}

fn refused(r: input.Refusal) -> Response {
  domain_errors.send(domain_errors.lifecycle, r.error, input.refusal_fields(r))
}

fn rate_limited(action: limits.Action) -> Response {
  http.json(
    429,
    json.object(
      list.map(limits.limited_body(action), fn(p) { #(p.0, json.string(p.1)) }),
    ),
  )
}

fn storage(r: Result(a, Fail(e))) -> Result(a, Fail(Response)) {
  room_routes.storage(r)
}

fn read(ctx: Ctx, f: fn(Read) -> Result(a, Fail(e))) -> Result(a, Response) {
  store.read(ctx.store, f) |> result.map_error(http.internal)
}

fn role(a: OrgAccess, room: Room) -> Option(room_rules.RoomRole) {
  room_view.role(a, room)
}

fn subject_removed(ctx: Ctx, room: Room) -> Result(Bool, Response) {
  use found <- result.map(read(ctx, players.by_id(_, room.row.player_id)))
  room.row.subject_removed_at != None || found == None
}

// ---------------------------------------------------------------------------------------------- journey

/// `GET /org/rooms/:id/journey`.
pub fn journey(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
) -> Response {
  use room <- room_routes.with_room(ctx, a, room_id)
  let now = clock.request_ms(ctx.config, req)
  let query = wisp.get_query(req)
  let built =
    store.read(ctx.store, fn(r) {
      use blocked <- result.try(audit.is_blocked(
        r,
        room.row.player_id,
        room.row.org_id,
      ))
      use player <- result.try(players.by_id(r, room.row.player_id))
      journey.build(
        r,
        room,
        journey.Viewer(
          grassroots: room_view.level(a.org) == orgs.LevelGrassroots,
          role: role(a, room),
        ),
        journey.Paging(
          limit: list.key_find(query, "limit") |> option.from_result,
          cursor: list.key_find(query, "cursor") |> option.from_result,
        ),
        blocked,
        player != None,
        now,
      )
    })
  case built {
    Ok(body) -> http.json(200, body)
    Error(e) -> http.internal(e)
  }
}

// ------------------------------------------------------------------------------------------------ lifecycle

type Act {
  Act(
    action: String,
    reason_codes: Option(List(String)),
    client_key: Option(Dynamic),
  )
}

fn action_names() -> Json {
  json.array(lifecycle.actions, fn(x) { json.string(x.name) })
}

/// Lifecycle reasons say why a case moved; decision codes say what a club concluded about a player. The sets do
/// not overlap. The prohibited set is shared with decisions, and keeps the Rooms' error code.
fn validate_lifecycle_reasons(
  codes: List(String),
) -> Result(List(String), #(String, String, List(#(String, Json)))) {
  let clean =
    codes
    |> list.map(fn(c) { c |> string.trim |> string.lowercase })
    |> list.filter(fn(c) { c != "" })
    |> list.unique
  let prohibited =
    list.filter(clean, list.contains(room_rules.prohibited_reason_codes, _))
  let unknown =
    list.filter(clean, fn(c) { !list.contains(lifecycle.reason_codes, c) })
  case list.length(clean) > 6, prohibited, unknown {
    True, _, _ ->
      Error(#("LIFECYCLE_REASONS_TOO_MANY", "Record up to 6 reasons.", []))
    _, [_, ..], _ ->
      Error(
        #(
          "ROOM_REASON_PROHIBITED",
          "A protected characteristic can never be recorded as a recruitment reason.",
          [],
        ),
      )
    _, _, [_, ..] ->
      Error(
        #(
          "LIFECYCLE_REASON_UNKNOWN",
          "Reasons must come from the recruitment LIFECYCLE taxonomy, which describes why a case moved — not from the decision taxonomy, which describes what a club concluded about a player.",
          [#("allowed", json.array(lifecycle.reason_codes, json.string))],
        ),
      )
    _, _, _ -> Ok(clean)
  }
}

/// `POST /org/rooms/:id/lifecycle`.
pub fn lifecycle_act(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
) -> Response {
  use room <- room_routes.with_room(ctx, a, room_id)
  use raw <- http.json_body(req)
  let has = fn(name) {
    case decode.run(raw, decode.at([name], decode.dynamic)) {
      Ok(_) -> True
      Error(_) -> False
    }
  }
  use <- when(has("stage") || has("status"), fn() {
    refuse(
      "LIFECYCLE_STAGE_NOT_SETTABLE",
      "The recruitment stage is not settable directly. Name a recruitment action instead.",
      [#("actions", action_names())],
    )
  })
  let shape = {
    use <- rev.fields
    use action <- input.field(
      "action",
      input.required(
        input.one_of(list.map(lifecycle.actions, fn(x) { #(x.name, x.name) })),
      ),
    )
    use reason_codes <- input.field(
      "reasonCodes",
      input.nullish(input.items(input.text(1_000_000), 1_000_000)),
    )
    use client_key <- input.field("clientKey", input.optional(input.anything()))
    input.done(Act(action:, reason_codes:, client_key:))
  }
  case
    input.parse_coded(
      shape,
      raw,
      root: "body",
      codes: [
        #("expectedRev", "EXPECTED_REV_INVALID"),
        #("expectedVersion", "EXPECTED_REV_INVALID"),
        #("action", "LIFECYCLE_ACTION_UNKNOWN"),
        #("reasonCodes.*", "LIFECYCLE_REASONS_INVALID"),
      ],
      default: "LIFECYCLE_INPUT_INVALID",
    )
  {
    Error(r) if r.error == "LIFECYCLE_ACTION_UNKNOWN" ->
      domain_errors.send(
        domain_errors.lifecycle,
        r.error,
        list.append(input.refusal_fields(r), [#("actions", action_names())]),
      )
    Error(r) -> refused(r)
    Ok(body) ->
      case idempotency.client_key(body.client_key) {
        Error(message) -> refuse("LIFECYCLE_CLIENT_KEY_INVALID", message, [])
        Ok(key) ->
          case
            validate_lifecycle_reasons(option.unwrap(body.reason_codes, []))
          {
            Error(#(code, message, fields)) -> refuse(code, message, fields)
            Ok(codes) -> act(ctx, req, a, room, raw, body.action, codes, key)
          }
      }
  }
}

fn when(
  cond: Bool,
  then: fn() -> Response,
  otherwise: fn() -> Response,
) -> Response {
  case cond {
    True -> then()
    False -> otherwise()
  }
}

/// The earlier move this client key made with this action, if any: keyed on the request identity, not the
/// stage pair, so `closed → reopened → closed` is three transitions and the third is not swallowed.
fn prior_move(
  room: Room,
  action: String,
  key: Option(String),
) -> Option(#(Json, Json)) {
  case key {
    None -> None
    Some(k) ->
      list.find_map(room.history, fn(h) {
        case h.action == "room_status_changed", h.detail_json {
          True, Some(text) ->
            case
              json.parse(text, {
                use key <- decode.optional_field(
                  "clientKey",
                  None,
                  decode.optional(decode.string),
                )
                use act <- decode.optional_field(
                  "lifecycleAction",
                  None,
                  decode.optional(decode.string),
                )
                use from <- decode.optional_field(
                  "from",
                  None,
                  decode.optional(decode.string),
                )
                use to <- decode.optional_field(
                  "to",
                  None,
                  decode.optional(decode.string),
                )
                decode.success(#(key, act, from, to))
              })
            {
              Ok(#(Some(hk), Some(ha), from, to)) if hk == k && ha == action ->
                Ok(#(
                  json.nullable(from, json.string),
                  json.nullable(to, json.string),
                ))
              _ -> Error(Nil)
            }
          _, _ -> Error(Nil)
        }
      })
      |> option.from_result
  }
}

fn act(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room: Room,
  raw: Dynamic,
  action_name: String,
  codes: List(String),
  key: Option(String),
) -> Response {
  let assert Some(action) = case_lifecycle.action_named(action_name)
    as "the schema accepts only named actions"
  let role = role(a, room)
  let now = clock.request_ms(ctx.config, req)
  // Permission is checked before a replay answers: a replay is still an action.
  case prior_move(room, action_name, key) {
    Some(#(from, to)) ->
      case case_lifecycle.permitted(action, role) {
        False ->
          refuse(
            "LIFECYCLE_NOT_PERMITTED",
            "Your role cannot take this recruitment action.",
            [],
          )
        True ->
          http.json(
            200,
            json.object([
              #("idempotent", json.bool(True)),
              #("from", from),
              #("to", to),
              ..rev.meta(room_view.rev_of(room))
            ]),
          )
      }
    None ->
      case
        read(ctx, case_lifecycle.check(_, room, action, role, codes, now, False))
      {
        Error(response) -> response
        Ok(Error(r)) -> refuse(r.error, r.message, r.fields)
        Ok(Ok(allowed)) -> {
          // Concurrency after validation, so a stale rev on an impossible action reports the impossibility.
          case rev.expected(raw) {
            Error(response) -> response
            Ok(expected) -> {
              use <- rev.guard(
                expected,
                room_view.rev_of(room),
                "ROOM_VERSION_CONFLICT",
                [#("status", room_status.to_json(room.status))],
              )
              store.unit(ctx.store, fn(tx) {
                use _ <- result.try(
                  case_lifecycle.apply(
                    tx,
                    room,
                    room_view.level(a.org),
                    allowed.to,
                    codes,
                    "lifecycle:" <> action_name,
                    case_lifecycle.StaffMover(a.user.id, a.user.name),
                    case_lifecycle.status_detail(action_name, key, []),
                    now,
                  )
                  |> storage,
                )
                use fresh <- result.map(room_routes.find(
                  store.reading(tx),
                  a,
                  room.row.id,
                ))
                http.json(
                  200,
                  json.object([
                    #("ok", json.bool(True)),
                    #("action", json.string(action_name)),
                    #("from", room_status.to_json(allowed.from)),
                    #("to", room_status.to_json(allowed.to)),
                    ..rev.meta(room_view.rev_of(fresh))
                  ]),
                )
              })
              |> room_routes.answer
            }
          }
        }
      }
  }
}

// ------------------------------------------------------------------------------------------------- decision

fn decision_permission(
  a: OrgAccess,
  room: Room,
  need: room_rules.RoomAction,
  next: fn(Option(room_rules.RoomRole)) -> Response,
) -> Response {
  let r = role(a, room)
  case room_rules.room_can(r, need) {
    True -> next(r)
    False ->
      refuse(
        "DECISION_NOT_PERMITTED",
        case need {
          room_rules.DecisionView ->
            "Your role cannot read decisions in this room."
          _ ->
            "Only a room lead or recruitment lead can draft or finalize a recruitment decision."
        },
        [],
      )
  }
}

/// `GET /org/rooms/:id/decision`.
///
/// Not ported yet: trials and Box Cam sessions, so the evidence candidates and completed-trial count list none.
pub fn decision(
  ctx: Ctx,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
) -> Response {
  use room <- room_routes.with_room(ctx, a, room_id)
  use role <- decision_permission(a, room, room_rules.DecisionView)
  let r = room.row
  let gathered =
    store.read(ctx.store, fn(read) {
      use rows <- result.try(decisions.rows_of(read, r.id, r.org_id))
      use draft <- result.try(decisions.draft(read, r.id))
      use counted <- result.try(decisions.assessments_for(
        read,
        r.org_id,
        r.player_id,
      ))
      use blocked <- result.try(audit.is_blocked(read, r.player_id, r.org_id))
      use player <- result.try(players.by_id(read, r.player_id))
      use passport <- result.map(
        store.query(
          read,
          "SELECT id, claim_type, label, verification_status, recorded_at FROM evidence WHERE player_id = ? AND superseded_by_id IS NULL ORDER BY recorded_at DESC, id DESC LIMIT 40",
          [id.player_sql(r.player_id)],
          {
            use eid <- decode.field(0, decode.string)
            use claim <- decode.field(1, decode.string)
            use label <- decode.field(2, decode.string)
            use status <- decode.field(3, decode.string)
            use at <- decode.field(4, decode.int)
            decode.success(
              json.object([
                #("id", json.string(eid)),
                #("claimType", json.string(claim)),
                #("label", json.string(label)),
                #("provenance", json.string(status)),
                #("recordedAt", json.int(at)),
              ]),
            )
          },
        ),
      )
      #(rows, draft, counted, blocked, player, passport)
    })
  case gathered {
    Error(e) -> http.internal(e)
    Ok(#(rows, draft, counted, blocked, player, passport)) -> {
      log_rows(room, rows)
      case rows.duplicate_heads {
        [_, ..] ->
          refuse(
            "DECISION_STATE_UNKNOWN",
            "This case's decision record cannot be read.",
            [],
          )
        [] -> {
          let head = decisions.chain_head(rows.rows)
          let current = keep(head, decisions.is_formal)
          let advisory = keep(head, fn(d) { !decisions.is_formal(d) })
          let #(shown, withheld) =
            decisions.visible(counted, a.user.id, access.is_lead(a.user))
          let summary = decisions.summarise(shown, withheld)
          let removed = r.subject_removed_at != None || player == None
          let can_finalize =
            room_rules.room_can(role, room_rules.DecisionFinalize)
          http.json(
            200,
            json.object([
              #("current", json.nullable(current, decisions.view(_, False))),
              #("advisory", json.nullable(advisory, decisions.view(_, False))),
              #("draft", decisions.draft_view(draft)),
              #(
                "history",
                json.array(list.reverse(rows.rows), decisions.view(_, False)),
              ),
              #("omitted", json.int(rows.omitted)),
              #("duplicateHeads", json.preprocessed_array([])),
              #("assessments", decisions.summary_json(summary)),
              #(
                "evidence",
                json.object([
                  #(
                    "assessments",
                    json.array(summary.submitted, fn(c) {
                      json.object([
                        #("id", id.assessment_json(c.row.id)),
                        #("scoutName", json.string(c.row.scout_name)),
                        #(
                          "submittedAt",
                          json.nullable(c.row.submitted_at, json.int),
                        ),
                        #(
                          "verdict",
                          json.nullable(
                            c.row.recommendation_verdict,
                            assessment_verdict_json,
                          ),
                        ),
                        #(
                          "trialId",
                          json.nullable(c.row.context_trial_id, json.string),
                        ),
                      ])
                    }),
                  ),
                  #("trials", json.preprocessed_array([])),
                  #("boxCam", json.preprocessed_array([])),
                  #("passport", json.preprocessed_array(passport)),
                  #(
                    "note",
                    json.string(
                      "References only. A decision cites these records; it copies none of them, and none of them decides anything.",
                    ),
                  ),
                ]),
              ),
              #(
                "requirements",
                json.object([
                  #("canDraft", json.bool(can_finalize && !removed)),
                  #("canFinalize", json.bool(can_finalize && !removed)),
                  #(
                    "role",
                    json.nullable(
                      option.map(role, room_rules.role_code),
                      json.string,
                    ),
                  ),
                  #("blocked", json.bool(blocked)),
                  #("subjectRemoved", json.bool(removed)),
                  #("hasDraft", json.bool(draft != None)),
                  #("hasFinal", json.bool(current != None)),
                  #(
                    "inputs",
                    json.object([
                      #(
                        "submittedAssessments",
                        json.int(list.length(summary.submitted)),
                      ),
                      #("completedTrials", json.int(0)),
                      #(
                        "note",
                        json.string(
                          "Inputs are counts of what exists. None of them is required by policy, and none of them decides anything.",
                        ),
                      ),
                    ]),
                  ),
                  #(
                    "outcomes",
                    json.preprocessed_array(availability(room, role)),
                  ),
                  #("status", room_status.to_json(room.status)),
                  #(
                    "note",
                    json.string(
                      "A formal decision is an explicit human act by a room lead or recruitment lead. ScoutBox never takes it.",
                    ),
                  ),
                ]),
              ),
              #("blocked", json.bool(blocked)),
              #("subjectRemoved", json.bool(removed)),
              #(
                "vocabulary",
                json.object([
                  #(
                    "outcomes",
                    json.array(decisions.outcomes, decision_outcome.to_json),
                  ),
                  #(
                    "outcomeLabels",
                    json.object(
                      list.map(decisions.outcomes, fn(o) {
                        #(
                          decision_outcome.to_string(o),
                          json.string(decisions.mapping(o).label),
                        )
                      }),
                    ),
                  ),
                  #("reasonCategories", room_rules.reason_codes_json()),
                  #(
                    "evidenceRefKinds",
                    json.array(
                      decisions.evidence_kinds,
                      decision_evidence_kind_json,
                    ),
                  ),
                ]),
              ),
              #("limits", decisions.limits_json()),
              #("policyVersion", json.int(decisions.policy_version)),
              #(
                "note",
                json.string(
                  "A formal decision is the club's internal decision about this case. It is not an offer, it is not sent to the player, and nothing in ScoutBox infers it from evidence.",
                ),
              ),
            ]),
          )
        }
      }
    }
  }
}

fn assessment_verdict_json(v) -> Json {
  assessment_row.recommendation_verdict_to_json(v)
}

fn decision_evidence_kind_json(k) -> Json {
  decision_evidence_kind.to_json(k)
}

/// Edge and role only: the evidence a progress needs is the decision itself.
fn availability(room: Room, role: Option(room_rules.RoomRole)) -> List(Json) {
  list.map(decisions.outcomes, fn(outcome) {
    let m = decisions.mapping(outcome)
    let assert Some(action) = case_lifecycle.action_named(m.action)
      as "an outcome names a lifecycle action"
    let to = case_lifecycle.target(action)
    let role_ok = case_lifecycle.permitted(action, role)
    let already = room.status == to
    let edge = already || room_rules.can_transition(room.status, to)
    let applicable = case m.action {
      "holdCase" | "considerOffer" | "rejectCase" -> True
      _ -> True
    }
    json.object([
      #("outcome", decision_outcome.to_json(outcome)),
      #("action", json.string(m.action)),
      #("to", room_status.to_json(to)),
      #("toLabel", json.string(room_rules.status_label(to))),
      #("possible", json.bool(role_ok && edge && applicable)),
      #("alreadyThere", json.bool(already)),
      #("reason", case role_ok, edge {
        False, _ -> json.string("role")
        True, False -> json.string("transition")
        True, True -> json.null()
      }),
    ])
  })
}

// ---------------------------------------------------------------------------------------------------- drafts

type Content {
  Content(
    outcome: Option(Option(DecisionOutcome)),
    reason_codes: Option(Option(List(String))),
    note: Option(Option(String)),
    refs: Option(Option(List(decisions.RefShape))),
    client_key: Option(Dynamic),
  )
}

const decision_codes = [
  #("expectedRev", "DECISION_REV_REQUIRED"),
  #("expectedVersion", "DECISION_REV_REQUIRED"),
  #("outcome", "DECISION_OUTCOME_INVALID"),
  #("reasonCodes.*", "DECISION_REASON_INVALID"),
  #("evidenceRefs.*", "DECISION_EVIDENCE_INVALID"),
]

fn content_shape(with_key: Bool, with_rev: Bool) -> input.Shape(Content) {
  let rest = fn() {
    use outcome <- input.field(
      "outcome",
      input.clearable(input.one_of(decision_outcome.pairs)),
    )
    use reason_codes <- input.field(
      "reasonCodes",
      input.clearable(input.items(input.text(1_000_000), 1_000_000)),
    )
    use note <- input.field(
      "note",
      input.clearable(input.text(decisions.note_max)),
    )
    use refs <- input.field(
      "evidenceRefs",
      input.clearable(input.items(
        decisions.refs_shape(),
        decisions.evidence_refs_max,
      )),
    )
    case with_key {
      True -> {
        use client_key <- input.field(
          "clientKey",
          input.optional(input.anything()),
        )
        input.done(Content(outcome:, reason_codes:, note:, refs:, client_key:))
      }
      False ->
        input.done(Content(
          outcome:,
          reason_codes:,
          note:,
          refs:,
          client_key: None,
        ))
    }
  }
  case with_rev {
    True -> rev.fields(rest)
    False -> rest()
  }
}

/// The content checked: the outcome, the decision reasons, the note cleaned and the references' shapes.
type Checked {
  Checked(
    outcome: Option(DecisionOutcome),
    reason_codes: List(String),
    note: Option(String),
    refs: List(decisions.RefShape),
  )
}

fn check_content(
  c: Content,
  require_outcome: Bool,
) -> Result(Checked, decisions.Refusal) {
  let outcome = option.flatten(c.outcome)
  use _ <- result.try(case require_outcome, outcome {
    True, None ->
      Error(
        decisions.Refusal(
          "DECISION_OUTCOME_INVALID",
          "A decision needs an outcome: progress, hold or reject.",
          [
            #(
              "allowed",
              json.array(decisions.outcomes, decision_outcome.to_json),
            ),
          ],
        ),
      )
    _, _ -> Ok(Nil)
  })
  use codes <- result.try(
    decisions.validate_reasons(
      option.flatten(c.reason_codes) |> option.unwrap([]),
      case require_outcome {
        True -> outcome
        False -> None
      },
    ),
  )
  use note <- result.map(decisions.validate_note(
    option.flatten(c.note),
    "note",
    decisions.note_max,
  ))
  Checked(outcome, codes, note, decisions.ref_shapes(option.flatten(c.refs)))
}

fn decision_refusal(r: decisions.Refusal) -> Response {
  domain_errors.send(domain_errors.lifecycle, r.error, case r.message {
    "" -> r.fields
    m -> [#("message", json.string(m)), ..r.fields]
  })
}

fn fingerprint(c: Checked, extra: List(#(String, canonical.Value))) -> String {
  canonical.Object([
    #(
      "outcome",
      canonical.text(option.map(c.outcome, decision_outcome.to_string)),
    ),
    #("reasonCodes", canonical.strings(c.reason_codes)),
    #("note", canonical.text(c.note)),
    #(
      "refs",
      canonical.strings(
        list.map(c.refs, fn(r) {
          decision_evidence_kind.to_string(r.kind) <> ":" <> r.id
        }),
      ),
    ),
    ..extra
  ])
  |> canonical.to_string
}

fn actor(a: OrgAccess) -> decisions.Actor {
  #(a.user.id, a.user.name, Some(a.user.role))
}

fn draft_body(
  req: Request,
  with_key: Bool,
  with_rev: Bool,
  next: fn(Content, Dynamic) -> Response,
) -> Response {
  use raw <- http.json_body(req)
  case
    input.parse_coded(
      content_shape(with_key, with_rev),
      raw,
      root: "body",
      codes: decision_codes,
      default: "DECISION_CONTENT_INVALID",
    )
  {
    Error(r) -> refused(r)
    Ok(c) -> next(c, raw)
  }
}

/// `POST /org/rooms/:id/decision/draft`.
pub fn start_draft(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
) -> Response {
  use room <- room_routes.with_room(ctx, a, room_id)
  use _ <- decision_permission(a, room, room_rules.DecisionDraft)
  use body, _ <- draft_body(req, True, False)
  case idempotency.client_key(body.client_key) {
    Error(m) -> refuse("DECISION_CLIENT_KEY_INVALID", m, [])
    Ok(key) ->
      case check_content(body, False) {
        Error(r) -> decision_refusal(r)
        Ok(c) -> {
          let fp = fingerprint(c, [])
          let r = room.row
          case
            read(ctx, fn(read) {
              use draft <- result.try(decisions.draft(read, r.id))
              use all <- result.map(decisions.all(read, r.id))
              #(draft, all)
            })
          {
            Error(response) -> response
            Ok(#(draft, all)) -> {
              let replay = case key {
                None -> None
                Some(k) ->
                  case draft {
                    Some(dr) if dr.row.create_key == Some(k) ->
                      Some(case dr.row.create_fp == Some(fp) {
                        True ->
                          http.json(
                            200,
                            json.object([
                              #("draft", decisions.draft_view(draft)),
                              #("idempotent", json.bool(True)),
                            ]),
                          )
                        False ->
                          conflict(
                            "This clientKey was already used for a different draft.",
                          )
                      })
                    _ ->
                      case
                        list.find(all, fn(d) {
                          d.base.row.org_id == r.org_id
                          && d.base.row.draft_key == Some(k)
                        })
                      {
                        Ok(became) ->
                          Some(case became.base.row.draft_fp == Some(fp) {
                            True ->
                              http.json(
                                200,
                                json.object([
                                  #("draft", json.null()),
                                  #("decision", decisions.view(became, False)),
                                  #("idempotent", json.bool(True)),
                                ]),
                              )
                            False ->
                              conflict(
                                "This clientKey was already used for a different draft.",
                              )
                          })
                        Error(Nil) -> None
                      }
                  }
              }
              case replay {
                Some(response) -> response
                None -> open_draft(ctx, a, room, draft, c, key, fp)
              }
            }
          }
        }
      }
  }
}

fn conflict(message: String) -> Response {
  refuse("DECISION_IDEMPOTENCY_CONFLICT", message, [])
}

fn open_draft(
  ctx: Ctx,
  a: OrgAccess,
  room: Room,
  existing: Option(Draft),
  c: Checked,
  key: Option(String),
  fp: String,
) -> Response {
  let r = room.row
  case subject_removed(ctx, room), existing {
    Error(response), _ -> response
    Ok(True), _ ->
      refuse(
        "DECISION_SUBJECT_REMOVED",
        "This player removed their ScoutBox account. The case stays on record; no new decision is written about a person who left.",
        [],
      )
    Ok(False), Some(dr) ->
      refuse(
        "DECISION_INVALID_STATE",
        "This case already has a draft. Edit it or discard it.",
        [
          #(
            "current",
            json.object([
              #("draftId", id.decision_draft_json(dr.row.id)),
              #("rev", json.int(dr.row.rev)),
            ]),
          ),
        ],
      )
    Ok(False), None -> {
      let now = clock.now_ms()
      case
        limits.limited(
          ctx.limits,
          limits.DecisionDraft,
          id.org_to_string(a.org.id),
          now,
        )
      {
        True -> rate_limited(limits.DecisionDraft)
        False ->
          case
            read(ctx, decisions.resolve_refs(_, c.refs, r.org_id, r.player_id))
          {
            Error(response) -> response
            Ok(Error(refusal)) -> decision_refusal(refusal)
            Ok(Ok(refs)) -> {
              use <- room_routes.moderated(
                ctx,
                a,
                c.note,
                "recruitment_decision",
              )
              store.unit(ctx.store, fn(tx) {
                use draft_id <- result.try(
                  decisions.start_draft(
                    tx,
                    r.id,
                    decisions.NewDraft(
                      outcome: c.outcome,
                      reason_codes: c.reason_codes,
                      note: c.note,
                      refs:,
                      by: actor(a),
                      create_key: option.map(key, fn(k) { #(k, fp) }),
                      at: now,
                    ),
                  )
                  |> storage,
                )
                use _ <- result.try(
                  cases.record(
                    tx,
                    r.id,
                    cases.by_staff(a.user.id, a.user.name),
                    [
                      cases.entry("room_decision_drafted", [
                        #("draftId", id.decision_draft_json(draft_id)),
                        #(
                          "outcome",
                          json.nullable(c.outcome, decision_outcome.to_json),
                        ),
                        #("note", json.bool(c.note != None)),
                      ]),
                    ],
                    now,
                  )
                  |> storage,
                )
                use fresh <- result.map(
                  decisions.draft(store.reading(tx), r.id) |> storage,
                )
                http.json(
                  201,
                  json.object([#("draft", decisions.draft_view(fresh))]),
                )
              })
              |> room_routes.answer
            }
          }
      }
    }
  }
}

/// Corrupt formal rows are omitted and named in the log, never repaired; two current formal rows are corruption.
fn log_rows(room: Room, rows: decisions.Rows) -> Nil {
  list.each(rows.problems, fn(p) {
    io.println_error(
      "DECISION integrity "
      <> id.room_decision_to_string(p.0)
      <> ": "
      <> string.join(p.1, ","),
    )
  })
  case rows.duplicate_heads {
    [] -> Nil
    heads ->
      io.println_error(
        "DECISION integrity case="
        <> id.recruitment_case_to_string(room.row.id)
        <> " duplicate_final_heads "
        <> string.join(list.map(heads, id.room_decision_to_string), ","),
      )
  }
}

/// The draft's own revision, required and an integer (the Trial routes' rule).
fn rev_gate(raw: Dynamic, draft: Draft, next: fn() -> Response) -> Response {
  let current = draft.row.rev
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
  let sent = option.or(named("expectedRev"), named("expectedVersion"))
  case sent {
    None ->
      refuse(
        "DECISION_REV_REQUIRED",
        "expectedRev is required: send the rev you were looking at.",
        [],
      )
    Some(v) ->
      case decode.run(v, decode.int) {
        Ok(n) if n >= 0 ->
          rev.guard(
            rev.Expected(n),
            rev.Rev(current, draft.row.rev_at, None),
            "DECISION_VERSION_CONFLICT",
            [#("rev", json.int(current))],
            next,
          )
        _ ->
          refuse(
            "DECISION_REV_REQUIRED",
            "expectedRev must be a non-negative integer.",
            [
              #("field", json.string("expectedRev")),
              #("expected", json.string("integer")),
            ],
          )
      }
  }
}

/// `PATCH /org/rooms/:id/decision/draft`.
pub fn edit_draft(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
) -> Response {
  use room <- room_routes.with_room(ctx, a, room_id)
  use _ <- decision_permission(a, room, room_rules.DecisionDraft)
  let r = room.row
  case read(ctx, decisions.draft(_, r.id)) {
    Error(response) -> response
    Ok(None) ->
      refuse("DECISION_NOT_FOUND", "This case has no draft decision.", [])
    Ok(Some(dr)) ->
      case subject_removed(ctx, room) {
        Error(response) -> response
        Ok(True) ->
          refuse(
            "DECISION_SUBJECT_REMOVED",
            "This player removed their ScoutBox account. The draft can no longer be changed.",
            [],
          )
        Ok(False) -> {
          use body, raw <- draft_body(req, False, True)
          case check_content(body, False) {
            Error(refusal) -> decision_refusal(refusal)
            Ok(c) -> {
              use <- rev_gate(raw, dr)
              let now = clock.now_ms()
              case
                limits.limited(
                  ctx.limits,
                  limits.DecisionDraft,
                  id.org_to_string(a.org.id),
                  now,
                )
              {
                True -> rate_limited(limits.DecisionDraft)
                False -> {
                  let refs = case body.refs {
                    Some(_) ->
                      read(ctx, decisions.resolve_refs(
                        _,
                        c.refs,
                        r.org_id,
                        r.player_id,
                      ))
                      |> result.map(fn(x) { x |> result.map(Some) })
                    None -> Ok(Ok(None))
                  }
                  case refs {
                    Error(response) -> response
                    Ok(Error(refusal)) -> decision_refusal(refusal)
                    Ok(Ok(refs)) -> {
                      let note_given = case body.note {
                        Some(_) -> c.note
                        None -> None
                      }
                      use <- room_routes.moderated(
                        ctx,
                        a,
                        note_given,
                        "recruitment_decision",
                      )
                      store.unit(ctx.store, fn(tx) {
                        use _ <- result.try(
                          decisions.edit_draft(
                            tx,
                            r.id,
                            option.map(body.outcome, fn(_) { c.outcome }),
                            option.map(body.reason_codes, fn(_) {
                              c.reason_codes
                            }),
                            option.map(body.note, fn(_) { c.note }),
                            refs,
                            actor(a),
                            now,
                          )
                          |> storage,
                        )
                        use fresh <- result.map(
                          decisions.draft(store.reading(tx), r.id) |> storage,
                        )
                        http.json(
                          200,
                          json.object([#("draft", decisions.draft_view(fresh))]),
                        )
                      })
                      |> room_routes.answer
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

/// `DELETE /org/rooms/:id/decision/draft`.
pub fn discard_draft(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
) -> Response {
  use room <- room_routes.with_room(ctx, a, room_id)
  use _ <- decision_permission(a, room, room_rules.DecisionDraft)
  let r = room.row
  case read(ctx, decisions.draft(_, r.id)) {
    Error(response) -> response
    Ok(None) ->
      refuse("DECISION_NOT_FOUND", "This case has no draft decision.", [])
    Ok(Some(dr)) -> {
      use raw <- http.json_body(req)
      case
        input.parse_coded(
          rev.fields(fn() { input.nothing() }),
          raw,
          root: "body",
          codes: decision_codes,
          default: "DECISION_CONTENT_INVALID",
        )
      {
        Error(refusal) -> refused(refusal)
        Ok(_) -> {
          use <- rev_gate(raw, dr)
          let now = clock.now_ms()
          store.unit(ctx.store, fn(tx) {
            use _ <- result.try(decisions.discard_draft(tx, r.id) |> storage)
            use _ <- result.map(
              cases.record(
                tx,
                r.id,
                cases.by_staff(a.user.id, a.user.name),
                [
                  cases.entry("room_decision_draft_discarded", [
                    #("draftId", id.decision_draft_json(dr.row.id)),
                    #(
                      "outcome",
                      json.nullable(dr.row.outcome, decision_outcome.to_json),
                    ),
                  ]),
                ],
                now,
              )
              |> storage,
            )
            http.json(
              200,
              json.object([
                #("draft", json.null()),
                #(
                  "discarded",
                  json.object([#("id", id.decision_draft_json(dr.row.id))]),
                ),
              ]),
            )
          })
          |> room_routes.answer
        }
      }
    }
  }
}

// -------------------------------------------------------------------------------------------------- finalize

type Finalize {
  Finalize(
    client_key: Option(Dynamic),
    supersedes: Option(String),
    supersedes_rev: Option(Dynamic),
    supersession_reason: Option(String),
  )
}

/// `POST /org/rooms/:id/decision/finalize`, and `/supersede` (`supersede: True`), which needs a formal decision
/// to replace.
pub fn finalize(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
  supersede: Bool,
) -> Response {
  use room <- room_routes.with_room(ctx, a, room_id)
  use role <- decision_permission(a, room, room_rules.DecisionFinalize)
  use raw <- http.json_body(req)
  let shape = {
    use <- rev.fields
    use client_key <- input.field("clientKey", input.optional(input.anything()))
    use supersedes <- input.field("supersedes", input.nullish(input.id()))
    use supersedes_rev <- input.field(
      "supersedesRev",
      input.nullish(fn(v) {
        input.whole_number(0, 9_007_199_254_740_991)(v)
        |> result.map(fn(_) { v })
      }),
    )
    use supersession_reason <- input.field(
      "supersessionReason",
      input.nullish(input.text(decisions.supersession_reason_max)),
    )
    input.done(Finalize(
      client_key:,
      supersedes:,
      supersedes_rev:,
      supersession_reason:,
    ))
  }
  case
    input.parse_coded(
      shape,
      raw,
      root: "body",
      codes: list.append(decision_codes, [
        #("supersedesRev", "DECISION_REV_REQUIRED"),
      ]),
      default: "DECISION_CONTENT_INVALID",
    )
  {
    Error(refusal) -> refused(refusal)
    Ok(body) ->
      case idempotency.client_key(body.client_key) {
        Error(m) -> refuse("DECISION_CLIENT_KEY_INVALID", m, [])
        Ok(key) -> finalize_body(ctx, a, room, role, raw, body, key, supersede)
      }
  }
}

fn finalize_body(
  ctx: Ctx,
  a: OrgAccess,
  room: Room,
  role: Option(room_rules.RoomRole),
  raw: Dynamic,
  body: Finalize,
  key: Option(String),
  supersede: Bool,
) -> Response {
  let r = room.row
  let now = clock.now_ms()
  case
    read(ctx, fn(read) {
      use rows <- result.try(decisions.rows_of(read, r.id, r.org_id))
      use draft <- result.map(decisions.draft(read, r.id))
      #(rows, draft)
    })
  {
    Error(response) -> response
    Ok(#(rows, draft)) -> {
      log_rows(room, rows)
      finalize_rows(
        ctx,
        a,
        room,
        role,
        raw,
        body,
        key,
        supersede,
        rows,
        draft,
        now,
      )
    }
  }
}

fn finalize_rows(
  ctx: Ctx,
  a: OrgAccess,
  room: Room,
  role: Option(room_rules.RoomRole),
  raw: Dynamic,
  body: Finalize,
  key: Option(String),
  supersede: Bool,
  rows: decisions.Rows,
  draft: Option(Draft),
  now: Int,
) -> Response {
  let r = room.row
  case rows.duplicate_heads != [] {
    True ->
      refuse(
        "DECISION_STATE_UNKNOWN",
        "This case's decision record cannot be read; nothing new is written on top of it.",
        [],
      )
    False -> {
      let checked_draft =
        option.map(draft, fn(dr) {
          #(
            dr,
            Checked(
              dr.row.outcome,
              dr.reason_codes,
              dr.row.note,
              list.map(dr.refs, fn(x) { decisions.RefShape(x.kind, x.id) }),
            ),
          )
        })
      let fp =
        option.map(checked_draft, fn(x) {
          fingerprint(x.1, [
            #(
              "draftId",
              canonical.Str(id.decision_draft_to_string({ x.0 }.row.id)),
            ),
            #("supersedes", canonical.text(body.supersedes)),
          ])
          |> fn(s) { s }
        })
      let replay = case key {
        None -> None
        Some(k) ->
          case
            list.find(rows.rows, fn(d) {
              decisions.is_formal(d) && d.base.row.finalize_key == Some(k)
            })
          {
            Error(Nil) -> None
            Ok(prior) ->
              Some(case draft == None || prior.base.row.finalize_fp == fp {
                True ->
                  http.json(
                    200,
                    json.object([
                      #("decision", decisions.view(prior, False)),
                      #("lifecycle", decisions.lifecycle_json(prior.base.row)),
                      #("idempotent", json.bool(True)),
                    ]),
                  )
                False ->
                  conflict(
                    "This clientKey was already used for a different decision.",
                  )
              })
          }
      }
      case replay {
        Some(response) -> response
        None ->
          case subject_removed(ctx, room), checked_draft {
            Error(response), _ -> response
            Ok(True), _ ->
              refuse(
                "DECISION_SUBJECT_REMOVED",
                "This player removed their ScoutBox account. The case stays on record; no new decision is written about a person who left.",
                [],
              )
            Ok(False), None ->
              refuse(
                "DECISION_INVALID_STATE",
                "There is no draft to finalize. Open a draft, then finalize it.",
                [],
              )
            Ok(False), Some(#(dr, stored)) -> {
              use <- rev_gate(raw, dr)
              let content =
                Content(
                  outcome: Some(stored.outcome),
                  reason_codes: Some(Some(stored.reason_codes)),
                  note: Some(stored.note),
                  refs: Some(Some(stored.refs)),
                  client_key: None,
                )
              case check_content(content, True) {
                Error(refusal) -> decision_refusal(refusal)
                Ok(c) -> {
                  let assert Some(outcome) = c.outcome
                  case
                    read(ctx, decisions.resolve_refs(
                      _,
                      c.refs,
                      r.org_id,
                      r.player_id,
                    ))
                  {
                    Error(response) -> response
                    Ok(Error(refusal)) -> decision_refusal(refusal)
                    Ok(Ok(refs)) ->
                      supersession(
                        rows,
                        body,
                        supersede,
                        fn(head, head_formal, supersession) {
                          finalize_write(
                            ctx,
                            a,
                            room,
                            role,
                            dr,
                            c,
                            outcome,
                            refs,
                            head,
                            head_formal,
                            supersession,
                            key,
                            fp,
                            now,
                          )
                        },
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

/// A current formal decision must be named and its rev matched; an advisory head is simply superseded.
fn supersession(
  rows: decisions.Rows,
  body: Finalize,
  supersede: Bool,
  next: fn(
    Option(Decision),
    Option(Decision),
    Option(#(id.RoomDecisionId, String)),
  ) -> Response,
) -> Response {
  let head = decisions.chain_head(rows.rows)
  let head_formal = keep(head, decisions.is_formal)
  case head_formal {
    Some(hf) -> {
      let hid = id.room_decision_to_string(hf.base.row.id)
      let head_rev = option.unwrap(hf.base.row.rev, 1)
      case body.supersedes {
        Some(s) if s == hid ->
          case option.map(body.supersedes_rev, decode.run(_, decode.int)) {
            Some(Ok(sr)) if sr >= 0 ->
              case sr == head_rev {
                False ->
                  refuse(
                    "DECISION_VERSION_CONFLICT",
                    "The formal decision changed while you were looking. Reload and try again.",
                    [
                      #(
                        "current",
                        json.object([
                          #("decisionId", id.room_decision_json(hf.base.row.id)),
                          #("rev", json.int(head_rev)),
                        ]),
                      ),
                    ],
                  )
                True ->
                  case
                    decisions.validate_note(
                      body.supersession_reason,
                      "supersessionReason",
                      decisions.supersession_reason_max,
                    )
                  {
                    Error(refusal) -> decision_refusal(refusal)
                    Ok(None) ->
                      refuse(
                        "DECISION_CONTENT_INVALID",
                        "Replacing a formal decision needs a reason the history will keep.",
                        [#("field", json.string("supersessionReason"))],
                      )
                    Ok(Some(reason)) ->
                      next(head, head_formal, Some(#(hf.base.row.id, reason)))
                  }
              }
            _ ->
              refuse(
                "DECISION_REV_REQUIRED",
                "supersedesRev must be the current decision's rev, as an integer.",
                [
                  #("field", json.string("supersedesRev")),
                  #("expected", json.string("integer")),
                ],
              )
          }
        _ ->
          refuse(
            "DECISION_ALREADY_FINAL",
            "This case already has a formal decision. To replace it, name it as `supersedes` with its current `supersedesRev` and a reason.",
            [
              #(
                "current",
                json.object([
                  #("decisionId", id.room_decision_json(hf.base.row.id)),
                  #("rev", json.int(head_rev)),
                  #(
                    "outcome",
                    json.nullable(hf.base.row.outcome, decision_outcome.to_json),
                  ),
                ]),
              ),
            ],
          )
      }
    }
    None ->
      case supersede, body.supersedes {
        True, _ ->
          refuse(
            "DECISION_INVALID_STATE",
            "There is no formal decision to supersede on this case.",
            [],
          )
        False, Some(s) if s != "" ->
          refuse(
            "DECISION_INVALID_STATE",
            "There is no formal decision with that id to supersede.",
            [#("supersedes", json.string(s))],
          )
        False, _ -> next(head, None, None)
      }
  }
}

fn finalize_write(
  ctx: Ctx,
  a: OrgAccess,
  room: Room,
  role: Option(room_rules.RoomRole),
  dr: Draft,
  c: Checked,
  outcome: DecisionOutcome,
  refs: List(decisions.Ref),
  head: Option(Decision),
  head_formal: Option(Decision),
  supersession: Option(#(id.RoomDecisionId, String)),
  key: Option(String),
  fp: Option(String),
  now: Int,
) -> Response {
  let r = room.row
  let m = decisions.mapping(outcome)
  // A hold or a rejection is internal; progressing toward an offer is not taken while a block stands.
  case
    outcome == decision_outcome.Progress
    && read(ctx, audit.is_blocked(_, r.player_id, r.org_id)) == Ok(True)
  {
    True ->
      refuse(
        "DECISION_BLOCKED",
        "This player (or their guardian) has blocked your organisation. A decision to progress is not recorded while the block stands; a hold or a rejection may be.",
        [],
      )
    False ->
      case
        limits.limited(
          ctx.limits,
          limits.DecisionFinalize,
          id.org_to_string(a.org.id),
          now,
        )
      {
        True -> rate_limited(limits.DecisionFinalize)
        False -> {
          use <- room_routes.moderated(ctx, a, c.note, "recruitment_decision")
          use <- room_routes.moderated(
            ctx,
            a,
            option.map(supersession, fn(s) { s.1 }),
            "recruitment_decision",
          )
          // The write refuses before anything is recorded.
          case store.unit(ctx.store, delivery.consume_injected(_, "decision")) {
            Ok(True) ->
              refuse(
                "DECISION_TRANSPORT_REFUSED",
                "The decision could not be recorded. Nothing was changed; try again.",
                [],
              )
            Error(e) -> http.internal(e)
            Ok(False) ->
              write_formal(
                ctx,
                a,
                room,
                role,
                dr,
                c,
                outcome,
                m,
                refs,
                head,
                head_formal,
                supersession,
                key,
                fp,
                now,
              )
          }
        }
      }
  }
}

fn write_formal(
  ctx: Ctx,
  a: OrgAccess,
  room: Room,
  role: Option(room_rules.RoomRole),
  dr: Draft,
  c: Checked,
  outcome: DecisionOutcome,
  m: decisions.Mapping,
  refs: List(decisions.Ref),
  head: Option(Decision),
  head_formal: Option(Decision),
  supersession: Option(#(id.RoomDecisionId, String)),
  key: Option(String),
  fp: Option(String),
  now: Int,
) -> Response {
  let r = room.row
  let from = room.status
  let assert Some(action) = case_lifecycle.action_named(m.action)
    as "an outcome names a lifecycle action"
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use counted <- result.try(
      decisions.assessments_for(read, r.org_id, r.player_id) |> storage,
    )
    let #(shown, withheld) =
      decisions.visible(counted, a.user.id, access.is_lead(a.user))
    let summary = decisions.summarise(shown, withheld)
    use snapshot <- result.try(
      room_view.capture_snapshot(tx, a.org, room, "decision:finalize", now)
      |> storage,
    )
    use decision_id <- result.try(
      decisions.create_formal(
        tx,
        decisions.NewFormal(
          room_id: r.id,
          org_id: r.org_id,
          player_id: r.player_id,
          outcome:,
          reason_codes: c.reason_codes,
          note: c.note,
          by: actor(a),
          client_key: key,
          supersedes: option.map(head, fn(h) { h.base.row.id }),
          supersession:,
          refs:,
          assessments: decisions.snapshot_of(summary),
          snapshot: option.map(snapshot, fn(s) { s.row.id }),
          finalize_key: case key, fp {
            Some(k), Some(f) -> Some(#(k, f))
            _, _ -> None
          },
          draft_key: case dr.row.create_key, dr.row.create_fp {
            Some(k), Some(f) -> Some(#(k, f))
            _, _ -> None
          },
          draft_id: id.decision_draft_to_string(dr.row.id),
          at: now,
        ),
      )
      |> storage,
    )
    use _ <- result.try(case head {
      Some(h) ->
        decisions.mark_superseded(tx, h.base.row.id, decision_id) |> storage
      None -> Ok(Nil)
    })
    let to = case_lifecycle.target(action)
    // The validator now sees this row as the evidence a progress needs.
    use lc <- result.try(case from == to {
      True ->
        Ok(#(
          decisions.Lifecycle(
            m.action,
            from,
            from,
            False,
            Some("already_there"),
            now,
          ),
          json.object([
            #("action", json.string(m.action)),
            #("from", room_status.to_json(from)),
            #("to", room_status.to_json(from)),
            #("applied", json.bool(False)),
            #("reason", json.string("already_there")),
            #("at", json.int(now)),
          ]),
        ))
      False -> {
        use verdict <- result.try(
          case_lifecycle.check(
            read,
            room,
            action,
            role,
            m.lifecycle_reasons,
            now,
            False,
          )
          |> storage,
        )
        case verdict {
          // A refusal rolls the whole unit back: no row, no snapshot, no supersession.
          Error(refusal) ->
            store.refuse(
              refuse(
                "DECISION_LIFECYCLE_CONFLICT",
                string.trim(
                  "The case at \""
                  <> room_rules.status_label(from)
                  <> "\" cannot take the step this decision asks for ("
                  <> m.action
                  <> "). "
                  <> refusal.message,
                ),
                [
                  #("lifecycle", json.string(refusal.error)),
                  #(
                    "allowed",
                    list.key_find(refusal.fields, "allowed")
                      |> result.unwrap(json.preprocessed_array([])),
                  ),
                  #(
                    "current",
                    json.object([#("status", room_status.to_json(from))]),
                  ),
                ],
              ),
            )
          Ok(allowed) -> {
            use moved <- result.map(
              case_lifecycle.apply(
                tx,
                room,
                room_view.level(a.org),
                allowed.to,
                m.lifecycle_reasons,
                "decision:finalize:" <> id.room_decision_to_string(decision_id),
                case_lifecycle.StaffMover(a.user.id, a.user.name),
                case_lifecycle.status_detail(m.action, None, [
                  #("decisionId", id.room_decision_json(decision_id)),
                ]),
                now,
              )
              |> storage,
            )
            #(
              decisions.Lifecycle(m.action, moved.0, moved.1, True, None, now),
              json.object([
                #("action", json.string(m.action)),
                #("from", room_status.to_json(moved.0)),
                #("to", room_status.to_json(moved.1)),
                #("applied", json.bool(True)),
                #("at", json.int(now)),
              ]),
            )
          }
        }
      }
    })
    let #(lifecycle_row, lifecycle_view) = lc
    use _ <- result.try(
      decisions.record_lifecycle(tx, decision_id, lifecycle_row) |> storage,
    )
    use _ <- result.try(case head_formal {
      Some(hf) -> decisions.bump(tx, hf.base.row.id, now) |> storage
      None -> Ok(Nil)
    })
    use _ <- result.try(decisions.discard_draft(tx, r.id) |> storage)
    use _ <- result.try(
      cases.record(
        tx,
        r.id,
        cases.by_staff(a.user.id, a.user.name),
        [
          cases.entry(
            case head_formal {
              Some(_) -> "room_decision_superseded"
              None -> "room_decision_finalized"
            },
            list.flatten([
              [
                #("decisionId", id.room_decision_json(decision_id)),
                #("outcome", decision_outcome.to_json(outcome)),
                #(
                  "supersedes",
                  json.nullable(
                    option.map(head_formal, fn(h) { h.base.row.id }),
                    id.room_decision_json,
                  ),
                ),
                #("reasonCodes", json.array(c.reason_codes, json.string)),
                #("note", json.bool(c.note != None)),
              ],
              case lifecycle_row.applied {
                True -> [#("to", room_status.to_json(lifecycle_row.to))]
                False -> []
              },
            ]),
          ),
        ],
        now,
      )
      |> storage,
    )
    use fresh <- result.try(room_routes.find(store.reading(tx), a, r.id))
    // Not ported yet: the `room_decision_finalized`/`_superseded` and `recruitment_room_archived` live events.
    use _ <- result.try(
      [Some(fresh.row.owner_user_id), fresh.row.room_lead_scout_user_id]
      |> option.values
      |> list.unique
      |> list.filter(fn(u) { u != a.user.id })
      |> list.try_each(fn(u) {
        notifications.notify(
          tx,
          to: audience.OrgUser,
          id: id.org_user_to_string(u),
          type_: "recruitment_room",
          text: "Recruitment Room — "
            <> option.unwrap(r.player_name, "a removed player")
            <> ": formal decision recorded ("
            <> m.label
            <> ").",
          ref_id: Some(id.recruitment_case_to_string(r.id)),
          at: now,
        )
      })
      |> storage,
    )
    use saved <- result.map(decisions.all(store.reading(tx), r.id) |> storage)
    let assert Ok(row) =
      list.find(saved, fn(d) { d.base.row.id == decision_id })
      as "the formal decision reads back"
    http.json(
      201,
      json.object([
        #("decision", decisions.view(row, False)),
        #("lifecycle", lifecycle_view),
        #("case", case lifecycle_row.applied {
          True ->
            json.object([
              #("from", room_status.to_json(lifecycle_row.from)),
              #("to", room_status.to_json(lifecycle_row.to)),
            ])
          False ->
            json.object([
              #("unchanged", json.bool(True)),
              #("status", room_status.to_json(fresh.status)),
            ])
        }),
        #("rev", json.int(fresh.rev)),
      ]),
    )
  })
  |> room_routes.answer
}

fn keep(value: Option(a), pred: fn(a) -> Bool) -> Option(a) {
  case value {
    Some(v) ->
      case pred(v) {
        True -> Some(v)
        False -> None
      }
    None -> None
  }
}

fn recipient_journeys(
  ctx: Ctx,
  req: Request,
  who: journey.Recipient,
) -> Response {
  let now = clock.request_ms(ctx.config, req)
  case store.read(ctx.store, journey.for_recipient(_, who, now)) {
    Ok(items) ->
      http.json(
        200,
        json.object([
          #("items", json.preprocessed_array(items)),
          #("generatedAt", json.int(now)),
        ]),
      )
    Error(failure) -> http.internal(failure)
  }
}

/// `GET /player/journeys`: every club's journey with this player, as far as it was shared with them.
pub fn player_journeys(ctx: Ctx, req: Request, p: PlayerAccess) -> Response {
  recipient_journeys(ctx, req, journey.PlayerSelf(p.player.row.id))
}

/// `GET /guardian/children/:id/journeys`: the journeys shared with this guardian about their child.
pub fn guardian_journeys(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  child: id.PlayerId,
) -> Response {
  case list.contains(g.child_ids, child) {
    False -> http.error(404, "CHILD_NOT_FOUND")
    True -> recipient_journeys(ctx, req, journey.GuardianOf(child, g.row.id))
  }
}
