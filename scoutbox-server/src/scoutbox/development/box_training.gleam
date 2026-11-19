//// Box Training (domains/development/boxcam/training.mjs): club assignments, Box Challenges and Box Cam disputes,
//// and what a finished session moves on in each.
////
//// Assignments and challenges don't widen access: every club act passes the standing gates (the visibility rule
//// with the agency wall and the grassroots radius, blocks, verified, not suspended). Agencies cannot assign Box
//// Training or publish a challenge.
////
//// Not ported yet: the development plan (`/box-cam/development-plan`) and the club's drill list
//// (`GET /org/box-cam/drills`).

import gleam/dynamic/decode
import gleam/float
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/development/box_cam_rules as rules
import scoutbox/development/box_sessions.{type Session}
import scoutbox/identity/access.{type OrgAccess, type PlayerAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/orgs.{type Org}
import scoutbox/identity/players.{type Player}
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/json_text
import scoutbox/platform/limits
import scoutbox/platform/metrics
import scoutbox/platform/paging.{IntKey, TextKey}
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/recruitment/room_routes
import scoutbox/rows/box_assignments as assignment_row
import scoutbox/rows/box_cam_disputes as dispute_row
import scoutbox/rows/box_challenge_entries as entry_row
import scoutbox/rows/box_challenges as challenge_row
import scoutbox/rows/box_session_integrity_events as event_row
import scoutbox/rows/box_sessions as session_row
import scoutbox/rows/id
import scoutbox/rows/ledger as ledger_row
import scoutbox/safety/audit
import scoutbox/safety/ledger
import scoutbox/safety/moderate
import scoutbox/vocab/audience
import scoutbox/vocab/box_restorable_state
import scoutbox/vocab/box_target_type
import scoutbox/vocab/org_type
import scoutbox/vocab/party
import sqlight
import wisp.{type Request, type Response}

const metric_group = "boxCam"

/// Counts one occurrence of a Box Cam counter.
pub fn count(tx: Tx, name: String) -> Result(Nil, Fail(e)) {
  metrics.count(tx, metric_group, name)
}

/// The Box Cam counters `/admin/metrics` shows, in order. Counts only: no player labels.
pub const metric_names = [
  "box_sessions_started", "box_sessions_completed", "box_sessions_verified",
  "box_sessions_partial", "box_sessions_unverifiable",
  "box_session_active_seconds", "box_assignment_created",
  "box_assignment_completed", "box_challenge_started", "box_challenge_completed",
  "provider_errors", "combine_attempt_started", "combine_attempt_completed",
  "combine_attempt_verified", "combine_attempt_incomplete",
  "combine_attempt_invalidated", "combine_practice_started",
  "combine_request_created", "combine_request_completed", "club_combine_created",
  "combine_measurement_provider_error", "box_cam_cv_sessions_started",
  "box_cam_cv_accepted", "box_cam_cv_refused",
]

/// Adds `n` to a Box Cam counter.
pub fn count_by(tx: Tx, name: String, n: Int) -> Result(Nil, Fail(e)) {
  case n <= 0 {
    True -> Ok(Nil)
    False -> count(tx, name) |> result.try(fn(_) { count_by(tx, name, n - 1) })
  }
}

pub fn metrics_json(tx: Tx) -> Result(Json, Fail(e)) {
  metrics.group(tx, metric_group, metric_names)
}

fn storage(r: Result(a, Fail(e))) -> Result(a, Fail(Response)) {
  room_routes.storage(r)
}

fn refuse(response: Response) -> Result(a, Fail(Response)) {
  store.refuse(response)
}

fn read_or_500(
  ctx: Ctx,
  f: fn(Read) -> Result(Response, Fail(Response)),
) -> Response {
  store.read(ctx.store, f) |> room_routes.read_answer
}

fn owns_child(g: Guardian, child: id.PlayerId) -> Bool {
  list.contains(g.child_ids, child)
}

/// A player this organisation may see (orgCanSee): visible to it, and not blocking it.
fn org_sees(
  read: Read,
  org: Org,
  player: id.PlayerId,
  now: Int,
) -> Result(Option(#(Player, Bool)), Fail(e)) {
  players.for_org(read, player, org, now)
  |> result.map(
    option.map(_, fn(found) {
      let #(p, seen) = found
      #(p, seen.visible && !seen.blocked)
    }),
  )
}

// ----------------------------------------------------------------------------------------------- assignments

pub type Assignment =
  assignment_row.Row

fn assignment_by_id(
  read: Read,
  aid: id.BoxAssignmentId,
) -> Result(Option(Assignment), Fail(e)) {
  store.one(
    read,
    "SELECT " <> assignment_row.columns <> " FROM box_assignments WHERE id = ?",
    [id.box_assignment_sql(aid)],
    assignment_row.decoder(),
  )
  |> result.map(option.from_result)
}

/// An assignment as its club, its player and their guardian see it: with the best standing result against it.
pub fn assignment_view(read: Read, a: Assignment) -> Result(Json, Fail(e)) {
  use sessions <- result.map(box_sessions.for_assignment(read, a.id))
  let standing = list.filter(sessions, box_sessions.standing)
  let best =
    standing
    |> list.sort(fn(x, y) {
      float.compare(
        option.unwrap(y.row.verified_active_ms, 0.0),
        option.unwrap(x.row.verified_active_ms, 0.0),
      )
    })
    |> list.first
  json.object([
    #("id", id.box_assignment_json(a.id)),
    #("playerId", id.player_json(a.player_id)),
    #("orgId", id.org_json(a.org_id)),
    #("orgName", json.nullable(a.org_name, json.string)),
    #(
      "assignedBy",
      json.object([
        #("userId", id.org_user_json(a.assigned_by_user_id)),
        #("name", json.nullable(a.assigned_by_name, json.string)),
        #("role", json.nullable(a.assigned_by_role, json.string)),
        #("orgVerifiedAtAssignment", json.bool(a.assigned_by_org_verified)),
        #("at", json.int(a.assigned_at)),
      ]),
    ),
    #("drillId", json.string(a.drill_id)),
    #("drillTitle", json.string(box_sessions.drill_title(a.drill_id))),
    #(
      "target",
      json.object([
        #("type", box_target_type.to_json(a.target_type)),
        #("value", json_text.number(a.target_value)),
      ]),
    ),
    #("frequencyPerWeek", json.nullable(a.frequency_per_week, json.int)),
    #("dueDate", json.nullable(a.due_date, json.string)),
    #("instructions", json.nullable(a.instructions, json.string)),
    #("objectiveId", json.nullable(a.objective_id, id.objective_json)),
    #("state", assignment_row.state_to_json(a.state)),
    #("createdAt", json.int(a.created_at)),
    #("sessionsCompleted", json.int(list.length(standing))),
    #("lastResult", case best {
      Ok(s) -> {
        let active = option.unwrap(s.row.verified_active_ms, 0.0)
        json.object([
          #(
            "verifiedActiveMs",
            json.nullable(s.row.verified_active_ms, json_text.number),
          ),
          #("verifiedActive", json.string(rules.fmt_ms(active))),
          #("verifiedReps", json.nullable(s.row.verified_reps, json.int)),
          #("targetCompleted", json.nullable(s.row.target_completed, json.bool)),
          #(
            "verificationState",
            json.nullable(
              s.row.verification_state,
              session_row.verification_state_to_json,
            ),
          ),
          #(
            "statusLabel",
            json.string(case s.row.target_completed {
              Some(True) -> "Completed"
              _ -> "Target not yet completed"
            }),
          ),
        ])
      }
      Error(Nil) -> json.null()
    }),
  ])
}

fn assignment_views(
  read: Read,
  list: List(Assignment),
) -> Result(List(Json), Fail(e)) {
  list.try_map(list, assignment_view(read, _))
}

type TargetBody {
  TargetBody(type_: Option(String), value: Option(Float))
}

fn target_shape() -> input.Check(TargetBody) {
  input.object({
    use type_ <- input.field("type", input.optional(input.text(1_000_000)))
    use value <- input.field("value", input.optional(input.any_number()))
    input.done(TargetBody(type_:, value:))
  })
}

type AssignmentBody {
  AssignmentBody(
    player_id: Option(String),
    drill_id: Option(String),
    target: Option(TargetBody),
    frequency: Option(Int),
    due_date: Option(Option(String)),
    instructions: Option(String),
    objective_id: Option(String),
  )
}

/// The drill's target type, when the body names one it offers.
fn drill_target_type(
  drill: rules.Drill,
  t: Option(String),
) -> Option(box_target_type.BoxTargetType) {
  case t {
    Some(text) ->
      list.find(drill.target_types, fn(tt) {
        box_target_type.to_string(tt) == text
      })
      |> option.from_result
    None -> None
  }
}

fn allowed(drill: rules.Drill) -> Json {
  json.array(drill.target_types, box_target_type.to_json)
}

/// `POST /org/box-cam/assignments`.
pub fn create_assignment(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  let shape = {
    use player_id <- input.field("playerId", input.nullish(input.id()))
    use drill_id <- input.field("drillId", input.optional(input.id()))
    use target <- input.field("target", input.nullish(target_shape()))
    use frequency <- input.field(
      "frequencyPerWeek",
      input.nullish(input.whole_number(1, 14)),
    )
    use due_date <- input.field("dueDate", input.nullish(input.day_or_blank()))
    use instructions <- input.field(
      "instructions",
      input.nullish(input.text(300)),
    )
    use objective_id <- input.field("objectiveId", input.nullish(input.id()))
    input.done(AssignmentBody(
      player_id:,
      drill_id:,
      target:,
      frequency:,
      due_date:,
      instructions:,
      objective_id:,
    ))
  }
  use b <- http.body(req, shape, [
    #("target", "TARGET_INVALID"),
    #("target.*", "TARGET_INVALID"),
  ])
  let now = clock.now_ms()
  let org = a.org
  use <- eligible_org(
    org,
    "Only a verified organisation can assign Box Training.",
    True,
  )
  let found = case b.player_id {
    Some(pid) -> store.read(ctx.store, org_sees(_, org, id.player(pid), now))
    None -> Ok(None)
  }
  case found {
    Error(e) -> http.internal(e)
    Ok(None) -> http.error(404, "PLAYER_NOT_FOUND")
    Ok(Some(#(p, False))) ->
      http.error(403, case org.type_, players.is_adult(p, now) {
        org_type.Agency, False -> "UNDER_18_WALL"
        _, _ -> "NOT_VISIBLE"
      })
    Ok(Some(#(p, True))) ->
      case rules.latest_drill(option.unwrap(b.drill_id, "")) {
        None ->
          http.error_message(
            404,
            "DRILL_UNKNOWN",
            "Only supported Box Cam drills can be assigned as Box Training.",
          )
        Some(drill) -> {
          let t = option.unwrap(b.target, TargetBody(None, None))
          case drill_target_type(drill, t.type_), t.value {
            Some(tt), Some(value) if value >. 0.0 -> {
              let instructions =
                option.then(b.instructions, fn(i) {
                  case i {
                    "" -> None
                    _ -> Some(i)
                  }
                })
              let create = fn() {
                assignment_unit(
                  ctx,
                  a,
                  p,
                  drill,
                  tt,
                  value,
                  b,
                  instructions,
                  now,
                )
              }
              case instructions {
                Some(text) ->
                  moderate.or_refuse(
                    ctx,
                    text,
                    audit.Context(
                      kind: "box_assignment",
                      player_id: Some(p.row.id),
                      org_id: Some(org.id),
                      user_id: None,
                      channel_id: None,
                      request_id: None,
                    ),
                    create,
                  )
                None -> create()
              }
            }
            _, _ ->
              http.json(
                400,
                json.object([
                  #("error", json.string("TARGET_INVALID")),
                  #("allowed", allowed(drill)),
                ]),
              )
          }
        }
      }
  }
}

/// The club gates every Box Training act passes: not an agency, not suspended, verified.
fn eligible_org(
  org: Org,
  unverified: String,
  agency_message: Bool,
  next: fn() -> Response,
) -> Response {
  case org.type_, org.suspended, org.verified {
    org_type.Agency, _, _ ->
      case agency_message {
        True ->
          http.error_message(
            403,
            "AGENCY_NOT_ELIGIBLE",
            "Agencies cannot assign Box Training.",
          )
        False -> http.error(403, "AGENCY_NOT_ELIGIBLE")
      }
    _, True, _ -> http.error(403, "ORG_SUSPENDED")
    _, False, False -> http.error_message(403, "ORG_NOT_ELIGIBLE", unverified)
    _, False, True -> next()
  }
}

fn assignment_unit(
  ctx: Ctx,
  a: OrgAccess,
  p: Player,
  drill: rules.Drill,
  target_type: box_target_type.BoxTargetType,
  value: Float,
  b: AssignmentBody,
  instructions: Option(String),
  now: Int,
) -> Response {
  let org = a.org
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use objective <- result.try(case b.objective_id {
      None -> Ok(None)
      Some(oid) -> {
        use found <- result.try(
          store.one(
            read,
            "SELECT id FROM dev_objectives WHERE id = ? AND player_id = ? AND org_id = ?",
            [
              id.objective_sql(id.objective(oid)),
              id.player_sql(p.row.id),
              id.org_sql(org.id),
            ],
            decode.at([0], id.objective_decoder()),
          )
          |> storage,
        )
        case found {
          Ok(o) -> Ok(Some(o))
          Error(Nil) -> refuse(http.error(404, "OBJECTIVE_NOT_FOUND"))
        }
      }
    })
    use aid <- result.try(id.next_box_assignment(tx) |> storage)
    let row =
      assignment_row.Row(
        id: aid,
        player_id: p.row.id,
        org_id: org.id,
        org_name: Some(org.name),
        assigned_by_user_id: a.user.id,
        assigned_by_name: Some(a.user.name),
        assigned_by_role: Some(a.user.role),
        assigned_by_org_verified: True,
        assigned_at: now,
        drill_id: drill.id,
        drill_version: drill.version,
        target_type:,
        target_value: value,
        frequency_per_week: b.frequency,
        due_date: option.flatten(b.due_date),
        instructions:,
        objective_id: objective,
        state: assignment_row.Assigned,
        created_at: now,
        updated_at: now,
      )
    use _ <- result.try(assignment_row.insert(tx, row) |> storage)
    use _ <- result.try(
      ledger.append(
        tx,
        ledger.Entry(
          entry_type: ledger_row.BoxAssignmentCreated,
          player_id: Some(p.row.id),
          org_id: Some(org.id),
          org_name: Some(org.name),
          user_id: Some(a.user.id),
          actor_name: Some(a.user.name),
        ),
        now,
      )
      |> storage,
    )
    let ref = Some(id.box_assignment_to_string(aid))
    use _ <- result.try(
      case players.is_adult(p, now), p.row.guardian_id {
        False, Some(gid) ->
          notifications.notify(
            tx,
            to: audience.Guardian,
            id: id.guardian_to_string(gid),
            type_: "box_cam",
            text: org.name
              <> " assigned "
              <> p.row.name
              <> " Box Training: "
              <> drill.title
              <> ".",
            ref_id: ref,
            at: now,
          )
        _, _ ->
          notifications.notify(
            tx,
            to: audience.Player,
            id: id.player_to_string(p.row.id),
            type_: "box_cam",
            text: org.name
              <> " assigned you Box Training: "
              <> drill.title
              <> ". Train in the Box.",
            ref_id: ref,
            at: now,
          )
      }
      |> storage,
    )
    use _ <- result.try(count(tx, "box_assignment_created") |> storage)
    use view <- result.map(assignment_view(read, row) |> storage)
    http.json(201, json.object([#("assignment", view)]))
  })
  |> room_routes.answer
}

type OrgListQuery {
  OrgListQuery(page: paging.Query, player_id: Option(String))
}

pub fn page_refusal(e: paging.PageError) -> Response {
  let #(code, message) = paging.error_body(e)
  http.error_message(400, code, message)
}

/// A list the route has already filtered, newest first, paged by `[createdAt, id]`.
pub fn page_newest_first(
  page: paging.Page,
  items: List(a),
  key: fn(a) -> #(Int, String),
) -> #(List(a), Option(String)) {
  let rest = case page.after {
    Some([IntKey(at), TextKey(last)]) ->
      list.filter(items, fn(x) {
        let #(t, i) = key(x)
        t < at || { t == at && string.compare(i, last) == order.Lt }
      })
    _ -> items
  }
  paging.page_of(list.take(rest, page.limit + 1), page.limit, fn(x) {
    let #(t, i) = key(x)
    [IntKey(t), TextKey(i)]
  })
}

/// `GET /org/box-cam/assignments`: the club's assignments of players it may still see, newest first.
pub fn org_assignments(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  let shape = {
    use limit <- input.field("limit", input.optional(input.text(1000)))
    use cursor <- input.field("cursor", input.optional(input.text(100_000)))
    use player_id <- input.field("playerId", input.optional(input.text(80)))
    input.done(OrgListQuery(page: paging.Query(limit:, cursor:), player_id:))
  }
  use q <- http.query(req, shape, [])
  let now = clock.now_ms()
  use read <- read_or_500(ctx)
  let filter = case q.player_id {
    Some(pid) if pid != "" -> Some(id.player(pid))
    _ -> None
  }
  use rows <- result.try(
    store.query(
      read,
      "SELECT "
        <> assignment_row.columns
        <> " FROM box_assignments WHERE org_id = ? AND (? IS NULL OR player_id = ?) ORDER BY created_at DESC, id DESC",
      [
        id.org_sql(a.org.id),
        sqlight.nullable(id.player_sql, filter),
        sqlight.nullable(id.player_sql, filter),
      ],
      assignment_row.decoder(),
    )
    |> storage,
  )
  // A block or a visibility change after assignment hides the player again.
  use mine <- result.try(
    list.try_map(rows, fn(r) {
      org_sees(read, a.org, r.player_id, now)
      |> result.map(fn(found) {
        case found {
          Some(#(_, True)) -> Ok(r)
          _ -> Error(Nil)
        }
      })
    })
    |> result.map(result.values)
    |> storage,
  )
  case paging.read(q.page, [paging.IntKind, paging.TextKind]) {
    Error(e) -> refuse(page_refusal(e))
    Ok(page) -> {
      let #(items, next) =
        page_newest_first(page, mine, fn(r) {
          #(r.created_at, id.box_assignment_to_string(r.id))
        })
      use views <- result.map(assignment_views(read, items) |> storage)
      let in_state = fn(states) {
        list.count(mine, fn(r) { list.contains(states, r.state) })
      }
      http.json(
        200,
        json.object([
          #("items", json.preprocessed_array(views)),
          #("nextCursor", json.nullable(next, json.string)),
          #(
            "summary",
            json.object([
              #("assigned", json.int(list.length(mine))),
              #("completed", json.int(in_state([assignment_row.Completed]))),
              #(
                "partial",
                json.int(in_state([assignment_row.PartiallyCompleted])),
              ),
              #(
                "notStarted",
                json.int(
                  in_state([assignment_row.Assigned, assignment_row.Accepted]),
                ),
              ),
            ]),
          ),
          #(
            "note",
            json.string(
              "Coaches receive Box Session results. Raw home footage is never captured or shared by Box Cam.",
            ),
          ),
        ]),
      )
    }
  }
}

fn nothing_body(req: Request, next: fn() -> Response) -> Response {
  use _ <- http.body(req, input.nothing(), [])
  next()
}

/// `POST /org/box-cam/assignments/:id/cancel`.
pub fn cancel_assignment(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  aid: id.BoxAssignmentId,
) -> Response {
  use <- nothing_body(req)
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use found <- result.try(assignment_by_id(read, aid) |> storage)
    case found {
      Some(asg) if asg.org_id == a.org.id ->
        case asg.state {
          assignment_row.Cancelled ->
            refuse(http.error(409, "ALREADY_CANCELLED"))
          _ -> {
            use _ <- result.try(
              store.run(
                tx,
                "UPDATE box_assignments SET state = 'cancelled', updated_at = ? WHERE id = ?",
                [sqlight.int(now), id.box_assignment_sql(aid)],
              )
              |> storage,
            )
            use _ <- result.try(
              ledger.append(
                tx,
                ledger.Entry(
                  entry_type: ledger_row.BoxAssignmentCancelled,
                  player_id: Some(asg.player_id),
                  org_id: Some(a.org.id),
                  org_name: Some(a.org.name),
                  user_id: Some(a.user.id),
                  actor_name: Some(a.user.name),
                ),
                now,
              )
              |> storage,
            )
            let next =
              assignment_row.Row(
                ..asg,
                state: assignment_row.Cancelled,
                updated_at: now,
              )
            use view <- result.map(assignment_view(read, next) |> storage)
            http.json(200, json.object([#("assignment", view)]))
          }
        }
      _ -> refuse(http.error(404, "ASSIGNMENT_NOT_FOUND"))
    }
  })
  |> room_routes.answer
}

fn items(views: List(Json)) -> Response {
  http.json(200, json.object([#("items", json.preprocessed_array(views))]))
}

/// `GET /player/box-cam/assignments`.
pub fn player_assignments(ctx: Ctx, p: PlayerAccess) -> Response {
  use read <- read_or_500(ctx)
  use list <- result.try(
    box_sessions.assignments_for_player(read, p.player.row.id) |> storage,
  )
  assignment_views(read, list) |> storage |> result.map(items)
}

/// `GET /guardian/children/:id/box-cam/assignments`.
pub fn child_assignments(
  ctx: Ctx,
  g: Guardian,
  child: id.PlayerId,
) -> Response {
  case owns_child(g, child) {
    False -> http.error(404, "CHILD_NOT_FOUND")
    True -> {
      use read <- read_or_500(ctx)
      use list <- result.try(
        box_sessions.assignments_for_player(read, child) |> storage,
      )
      assignment_views(read, list) |> storage |> result.map(items)
    }
  }
}

fn accept(ctx: Ctx, player: id.PlayerId, aid: id.BoxAssignmentId) -> Response {
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use found <- result.try(assignment_by_id(read, aid) |> storage)
    case found {
      Some(asg) if asg.player_id == player ->
        case asg.state {
          assignment_row.Assigned -> {
            use _ <- result.try(
              store.run(
                tx,
                "UPDATE box_assignments SET state = 'accepted', updated_at = ? WHERE id = ? AND state = 'assigned'",
                [sqlight.int(now), id.box_assignment_sql(aid)],
              )
              |> storage,
            )
            let next =
              assignment_row.Row(
                ..asg,
                state: assignment_row.Accepted,
                updated_at: now,
              )
            use view <- result.map(assignment_view(read, next) |> storage)
            http.json(200, json.object([#("assignment", view)]))
          }
          state ->
            refuse(http.json(
              409,
              json.object([
                #("error", json.string("NOT_ACCEPTABLE")),
                #("state", assignment_row.state_to_json(state)),
              ]),
            ))
        }
      _ -> refuse(http.error(404, "ASSIGNMENT_NOT_FOUND"))
    }
  })
  |> room_routes.answer
}

/// `POST /player/box-cam/assignments/:id/accept`: an adult's own.
pub fn player_accept(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  aid: id.BoxAssignmentId,
) -> Response {
  use <- nothing_body(req)
  case players.is_adult(p.player, clock.now_ms()) {
    False ->
      http.error_message(
        403,
        "GUARDIAN_MANAGED",
        "Your parent/guardian accepts club-assigned training.",
      )
    True -> accept(ctx, p.player.row.id, aid)
  }
}

/// `POST /guardian/children/:id/box-cam/assignments/:aid/accept`.
pub fn child_accept(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  child: id.PlayerId,
  aid: id.BoxAssignmentId,
) -> Response {
  use <- nothing_body(req)
  case owns_child(g, child) {
    False -> http.error(404, "CHILD_NOT_FOUND")
    True -> accept(ctx, child, aid)
  }
}

/// A finished session moves its assignment on (inside the completion's unit). A cancelled assignment never moves.
pub fn apply_assignment_progress(
  tx: Tx,
  s: session_row.Row,
  now: Int,
) -> Result(Nil, Fail(e)) {
  let read = store.reading(tx)
  let counted =
    s.verification_state == Some(session_row.VerificationStateVerified)
    || s.verification_state
    == Some(session_row.VerificationStatePartiallyVerified)
  case s.assignment_id {
    None -> Ok(Nil)
    Some(aid) -> {
      use found <- result.try(assignment_by_id(read, aid))
      case found {
        Some(a) if a.state != assignment_row.Cancelled && counted -> {
          use next <- result.try(case s.target_completed {
            Some(True) -> {
              use sessions <- result.map(box_sessions.for_assignment(read, a.id))
              let done =
                list.count(sessions, fn(x) {
                  x.row.target_completed == Some(True)
                  && x.row.verification_state
                  != Some(session_row.VerificationStateCancelled)
                  && x.row.verification_state
                  != Some(session_row.VerificationStateInvalidated)
                })
              case a.frequency_per_week {
                Some(f) if done < f -> assignment_row.InProgress
                _ -> assignment_row.Completed
              }
            }
            _ ->
              Ok(case a.state {
                assignment_row.Assigned | assignment_row.Accepted ->
                  case option.unwrap(s.verified_active_ms, 0.0) >. 0.0 {
                    True -> assignment_row.PartiallyCompleted
                    False -> assignment_row.InProgress
                  }
                // The TypeScript server writes the state it already has back, and so moves only the time.
                other -> other
              })
          })
          use _ <- result.try(
            store.run(
              tx,
              "UPDATE box_assignments SET state = ?, updated_at = ? WHERE id = ? AND state <> 'cancelled'",
              [
                sqlight.text(assignment_row.state_to_string(next)),
                sqlight.int(now),
                id.box_assignment_sql(a.id),
              ],
            ),
          )
          case
            s.target_completed == Some(True) && next == assignment_row.Completed
          {
            False -> Ok(Nil)
            True -> {
              use _ <- result.try(count(tx, "box_assignment_completed"))
              use lead <- result.try(
                store.one(
                  read,
                  "SELECT u.id, p.name FROM org_users u, players p WHERE u.id = ? AND u.removed_at IS NULL AND p.id = ? AND p.deleted_at IS NULL",
                  [
                    id.org_user_sql(a.assigned_by_user_id),
                    id.player_sql(a.player_id),
                  ],
                  {
                    use uid <- decode.field(0, decode.string)
                    use name <- decode.field(1, decode.string)
                    decode.success(#(uid, name))
                  },
                ),
              )
              case lead {
                Error(Nil) -> Ok(Nil)
                Ok(#(uid, name)) ->
                  notifications.notify(
                    tx,
                    to: audience.OrgUser,
                    id: uid,
                    type_: "box_cam",
                    text: name
                      <> " completed Box Training: "
                      <> box_sessions.drill_title(a.drill_id)
                      <> " ("
                      <> case s.verified_reps {
                      Some(n) -> int.to_string(n) <> " verified"
                      None ->
                        rules.fmt_ms(option.unwrap(s.verified_active_ms, 0.0))
                    }
                      <> ").",
                    ref_id: Some(id.box_assignment_to_string(a.id)),
                    at: now,
                  )
              }
            }
          }
        }
        _ -> Ok(Nil)
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------ challenges

pub type Challenge =
  challenge_row.Row

pub type Entry =
  entry_row.Row

fn challenge_by_id(
  read: Read,
  cid: id.BoxChallengeId,
) -> Result(Option(Challenge), Fail(e)) {
  store.one(
    read,
    "SELECT " <> challenge_row.columns <> " FROM box_challenges WHERE id = ?",
    [id.box_challenge_sql(cid)],
    challenge_row.decoder(),
  )
  |> result.map(option.from_result)
}

fn participants(read: Read, cid: id.BoxChallengeId) -> Result(Int, Fail(e)) {
  store.one(
    read,
    "SELECT count(*) FROM box_challenge_entries WHERE challenge_id = ?",
    [id.box_challenge_sql(cid)],
    decode.at([0], decode.int),
  )
  |> result.map(result.unwrap(_, 0))
}

/// The challenge's publisher, with only the keys it has.
pub fn publisher_json(c: Challenge) -> Json {
  json.object(
    list.flatten([
      [#("kind", challenge_row.publisher_kind_to_json(c.publisher_kind))],
      case c.publisher_org_id {
        Some(o) -> [#("orgId", id.org_json(o))]
        None -> []
      },
      case c.publisher_org_name {
        Some(n) -> [#("orgName", json.string(n))]
        None -> []
      },
      case c.publisher_by_name {
        Some(n) -> [#("byName", json.string(n))]
        None -> []
      },
    ]),
  )
}

fn challenge_view(
  c: Challenge,
  entry: Option(Entry),
  participants: Int,
) -> Json {
  json.object([
    #("id", id.box_challenge_json(c.id)),
    #("title", json.string(c.title)),
    #("publisher", publisher_json(c)),
    #("drillId", json.string(c.drill_id)),
    #("drillTitle", json.string(box_sessions.drill_title(c.drill_id))),
    #("metric", challenge_row.metric_to_json(c.metric)),
    #("targetTotal", json.int(c.target_total)),
    #("startsAt", json.int(c.starts_at)),
    #("endsAt", json.int(c.ends_at)),
    #("adultOnly", json.bool(c.adult_only)),
    #("cap", json.nullable(c.cap, json.int)),
    #("participants", json.int(participants)),
    #("entry", case entry {
      Some(e) ->
        json.object([
          #("id", id.box_challenge_entry_json(e.id)),
          #("status", entry_row.status_to_json(e.status)),
          #("progress", json.int(e.progress)),
          #("joinedAt", json.int(e.joined_at)),
          #("completedAt", json.nullable(e.completed_at, json.int)),
        ])
      None -> json.null()
    }),
    #(
      "disclaimer",
      json.string(
        "Completing a Box Challenge does not mean the club has scouted, selected or endorsed you unless explicitly stated through a separate ScoutBox recruitment workflow.",
      ),
    ),
  ])
}

/// The open challenges this player may see and join: an adult-only one only for an adult, and an organisation's only
/// while it is not suspended and may see the player.
fn eligible_challenges(
  read: Read,
  p: Player,
  now: Int,
) -> Result(List(Challenge), Fail(e)) {
  use open <- result.try(store.query(
    read,
    "SELECT "
      <> challenge_row.columns
      <> " FROM box_challenges WHERE status = 'active' AND ends_at >= ? ORDER BY rowid",
    [sqlight.int(now)],
    challenge_row.decoder(),
  ))
  let adult = players.is_adult(p, now)
  list.try_map(open, fn(c) {
    use <- skip_when(c.adult_only && !adult, c)
    case c.publisher_org_id {
      None -> Ok(Ok(c))
      Some(oid) -> {
        use org <- result.try(orgs.by_id(read, oid))
        case org {
          Some(org) if !org.suspended -> {
            use seen <- result.map(org_sees(read, org, p.row.id, now))
            case seen {
              Some(#(_, True)) -> Ok(c)
              _ -> Error(Nil)
            }
          }
          _ -> Ok(Error(Nil))
        }
      }
    }
  })
  |> result.map(result.values)
}

fn skip_when(
  skip: Bool,
  _c: Challenge,
  next: fn() -> Result(Result(Challenge, Nil), Fail(e)),
) -> Result(Result(Challenge, Nil), Fail(e)) {
  case skip {
    True -> Ok(Error(Nil))
    False -> next()
  }
}

type ChallengeBody {
  ChallengeBody(
    title: Option(String),
    drill_id: Option(String),
    metric: Option(challenge_row.Metric),
    target_total: Option(Int),
    days: Option(Int),
    adult_only: Option(Bool),
    cap: Option(Int),
  )
}

/// `POST /org/box-cam/challenges`.
pub fn create_challenge(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  let shape = {
    use title <- input.field("title", input.nullish(input.text(120)))
    use drill_id <- input.field("drillId", input.optional(input.id()))
    use metric <- input.field(
      "metric",
      input.optional(input.one_of(challenge_row.metric_pairs)),
    )
    use target_total <- input.field(
      "targetTotal",
      input.optional(input.whole_number(1, 100_000)),
    )
    use days <- input.field("days", input.nullish(input.whole_number(1, 60)))
    use adult_only <- input.field("adultOnly", input.nullish(input.boolean()))
    use cap <- input.field(
      "cap",
      input.nullish(input.whole_number(1, 1_000_000)),
    )
    input.done(ChallengeBody(
      title:,
      drill_id:,
      metric:,
      target_total:,
      days:,
      adult_only:,
      cap:,
    ))
  }
  use b <- http.body(req, shape, [
    #("metric", "METRIC_INVALID"),
    #("targetTotal", "TARGET_INVALID"),
  ])
  let org = a.org
  use <- eligible_org(
    org,
    "Only a verified organisation can publish a Box Challenge.",
    False,
  )
  case rules.latest_drill(option.unwrap(b.drill_id, "")) {
    None -> http.error(404, "DRILL_UNKNOWN")
    Some(drill) ->
      case b.metric, b.target_total {
        None, _ ->
          http.json(
            400,
            json.object([
              #("error", json.string("METRIC_INVALID")),
              #("field", json.string("metric")),
              #("problem", json.string("required")),
              #(
                "allowed",
                json.array(challenge_row.metric_pairs, fn(p) {
                  json.string(p.0)
                }),
              ),
            ]),
          )
        Some(metric), total -> {
          let reps_unverifiable =
            metric == challenge_row.Reps
            && !list.contains(drill.verification_capabilities, rules.RepCount)
          case reps_unverifiable, total {
            True, _ ->
              http.error_message(
                400,
                "METRIC_NOT_SUPPORTED",
                drill.title
                  <> " cannot verify repetition counts — use active_minutes.",
              )
            False, None ->
              http.json(
                400,
                json.object([
                  #("error", json.string("TARGET_INVALID")),
                  #("field", json.string("targetTotal")),
                  #("problem", json.string("required")),
                ]),
              )
            False, Some(total) -> {
              let title = option.unwrap(b.title, "")
              use <- moderate.or_refuse(
                ctx,
                title,
                audit.Context(
                  kind: "box_challenge",
                  player_id: None,
                  org_id: Some(org.id),
                  user_id: None,
                  channel_id: None,
                  request_id: None,
                ),
              )
              publish_challenge(ctx, a, drill, metric, total, b)
            }
          }
        }
      }
  }
}

fn publish_challenge(
  ctx: Ctx,
  a: OrgAccess,
  drill: rules.Drill,
  metric: challenge_row.Metric,
  total: Int,
  b: ChallengeBody,
) -> Response {
  let now = clock.now_ms()
  let org = a.org
  store.unit(ctx.store, fn(tx) {
    use cid <- result.try(id.next_box_challenge(tx) |> storage)
    let title = case string.trim(option.unwrap(b.title, "")) {
      "" -> drill.title <> " Box Challenge"
      t -> t
    }
    let c =
      challenge_row.Row(
        id: cid,
        title:,
        publisher_kind: challenge_row.Org,
        publisher_org_id: Some(org.id),
        publisher_org_name: Some(org.name),
        publisher_by_name: Some(a.user.name),
        drill_id: drill.id,
        metric:,
        target_total: total,
        starts_at: now,
        ends_at: now + option.unwrap(b.days, 14) * 86_400_000,
        adult_only: b.adult_only == Some(True),
        cap: b.cap,
        status: challenge_row.Active,
        created_at: now,
      )
    use _ <- result.try(challenge_row.insert(tx, c) |> storage)
    use _ <- result.map(
      ledger.append(
        tx,
        ledger.Entry(
          entry_type: ledger_row.BoxChallengePublished,
          player_id: None,
          org_id: Some(org.id),
          org_name: Some(org.name),
          user_id: Some(a.user.id),
          actor_name: Some(a.user.name),
        ),
        now,
      )
      |> storage,
    )
    http.json(201, json.object([#("challenge", challenge_view(c, None, 0))]))
  })
  |> room_routes.answer
}

/// `GET /org/box-cam/challenges`: the club's own, newest first.
pub fn org_challenges(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use query <- http.query(req, paging.query_shape(), [])
  case paging.read(query, [paging.IntKind, paging.TextKind]) {
    Error(e) -> page_refusal(e)
    Ok(page) -> {
      use read <- read_or_500(ctx)
      use mine <- result.try(
        store.query(
          read,
          "SELECT "
            <> challenge_row.columns
            <> " FROM box_challenges WHERE publisher_kind = 'org' AND publisher_org_id = ? ORDER BY created_at DESC, id DESC",
          [id.org_sql(a.org.id)],
          challenge_row.decoder(),
        )
        |> storage,
      )
      let #(page_items, next) =
        page_newest_first(page, mine, fn(c) {
          #(c.created_at, id.box_challenge_to_string(c.id))
        })
      use views <- result.map(
        list.try_map(page_items, fn(c) {
          participants(read, c.id) |> result.map(challenge_view(c, None, _))
        })
        |> storage,
      )
      http.json(
        200,
        json.object([
          #("items", json.preprocessed_array(views)),
          #("nextCursor", json.nullable(next, json.string)),
        ]),
      )
    }
  }
}

/// `GET /player/box-cam/challenges`.
pub fn player_challenges(ctx: Ctx, p: PlayerAccess) -> Response {
  let now = clock.now_ms()
  use read <- read_or_500(ctx)
  use entries <- result.try(
    box_sessions.entries_for_player(read, p.player.row.id) |> storage,
  )
  use list <- result.try(eligible_challenges(read, p.player, now) |> storage)
  list.try_map(list, fn(c) {
    let entry =
      list.find(entries, fn(e) { e.challenge_id == c.id })
      |> option.from_result
    participants(read, c.id) |> result.map(challenge_view(c, entry, _))
  })
  |> storage
  |> result.map(items)
}

fn join(
  ctx: Ctx,
  p: Player,
  cid: String,
  by: party.Party,
  by_id: String,
) -> Response {
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use list <- result.try(eligible_challenges(read, p, now) |> storage)
    case list.find(list, fn(c) { id.box_challenge_to_string(c.id) == cid }) {
      Error(Nil) -> refuse(http.error(404, "CHALLENGE_NOT_FOUND"))
      Ok(c) -> {
        use entries <- result.try(
          box_sessions.entries_for_player(read, p.row.id) |> storage,
        )
        use joined <- result.try(participants(read, c.id) |> storage)
        case list.any(entries, fn(e) { e.challenge_id == c.id }), c.cap {
          True, _ -> refuse(http.error(409, "ALREADY_JOINED"))
          False, Some(cap) if joined >= cap ->
            refuse(http.error(409, "CHALLENGE_FULL"))
          False, _ -> {
            use eid <- result.try(id.next_box_challenge_entry(tx) |> storage)
            let e =
              entry_row.Row(
                id: eid,
                challenge_id: c.id,
                player_id: p.row.id,
                status: entry_row.Active,
                progress: 0,
                joined_at: now,
                joined_by_kind: by,
                joined_by_id: by_id,
                completed_at: None,
              )
            use _ <- result.try(entry_row.insert(tx, e) |> storage)
            use _ <- result.map(count(tx, "box_challenge_started") |> storage)
            http.json(
              201,
              json.object([
                #("challenge", challenge_view(c, Some(e), joined + 1)),
              ]),
            )
          }
        }
      }
    }
  })
  |> room_routes.answer
}

/// `POST /player/box-cam/challenges/:id/join`: an adult joins.
pub fn player_join(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  cid: String,
) -> Response {
  use <- nothing_body(req)
  case players.is_adult(p.player, clock.now_ms()) {
    False ->
      http.error_message(
        403,
        "GUARDIAN_MANAGED",
        "Your parent/guardian approves Box Challenge participation.",
      )
    True ->
      join(
        ctx,
        p.player,
        cid,
        party.Player,
        id.player_to_string(p.player.row.id),
      )
  }
}

/// `POST /guardian/children/:id/box-cam/challenges/:cid/join`.
pub fn child_join(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  child: id.PlayerId,
  cid: String,
) -> Response {
  use <- nothing_body(req)
  case owns_child(g, child) {
    False -> http.error(404, "CHILD_NOT_FOUND")
    True ->
      case store.read(ctx.store, players.by_id(_, child)) {
        Error(e) -> http.internal(e)
        Ok(None) -> http.error(404, "PLAYER_NOT_FOUND")
        Ok(Some(p)) ->
          join(ctx, p, cid, party.Guardian, id.guardian_to_string(g.row.id))
      }
  }
}

/// A finished session moves the player's active entries of challenges on its drill (inside the completion's unit).
/// An entry whose total reaches the target completes, once.
pub fn apply_challenge_progress(
  tx: Tx,
  s: session_row.Row,
  now: Int,
) -> Result(Nil, Fail(e)) {
  let read = store.reading(tx)
  use entries <- result.try(box_sessions.entries_for_player(read, s.player_id))
  let active = list.filter(entries, fn(e) { e.status == entry_row.Active })
  use <- skip_none(active == [])
  use sessions <- result.try(box_sessions.finished_for_player(
    read,
    s.player_id,
    None,
  ))
  let finished = list.map(sessions, box_sessions.finished)
  list.try_each(active, fn(entry) {
    use found <- result.try(challenge_by_id(read, entry.challenge_id))
    case found {
      Some(c) if c.drill_id == s.drill_id -> {
        let progress =
          rules.challenge_progress(
            rules.ChallengeWindow(
              drill_id: c.drill_id,
              metric: c.metric,
              target_total: c.target_total,
              starts_at: c.starts_at,
              ends_at: c.ends_at,
            ),
            finished,
          )
        use _ <- result.try(case progress.completed {
          True ->
            store.run(
              tx,
              "UPDATE box_challenge_entries SET progress = ?, status = 'completed', completed_at = ? WHERE id = ? AND status = 'active'",
              [
                sqlight.int(progress.total),
                sqlight.int(now),
                id.box_challenge_entry_sql(entry.id),
              ],
            )
          False ->
            store.run(
              tx,
              "UPDATE box_challenge_entries SET progress = ? WHERE id = ? AND status = 'active'",
              [
                sqlight.int(progress.total),
                id.box_challenge_entry_sql(entry.id),
              ],
            )
        })
        case progress.completed {
          False -> Ok(Nil)
          True -> {
            use _ <- result.try(count(tx, "box_challenge_completed"))
            // Not ported yet: the player_development_evidence_changed live event.
            notifications.notify(
              tx,
              to: audience.Player,
              id: id.player_to_string(s.player_id),
              type_: "box_cam",
              text: "Box Challenge complete: "
                <> c.title
                <> ". Your work counts.",
              ref_id: Some(id.box_challenge_entry_to_string(entry.id)),
              at: now,
            )
          }
        }
      }
      _ -> Ok(Nil)
    }
  })
}

fn skip_none(
  skip: Bool,
  next: fn() -> Result(Nil, Fail(e)),
) -> Result(Nil, Fail(e)) {
  case skip {
    True -> Ok(Nil)
    False -> next()
  }
}

// -------------------------------------------------------------------------------------------------- disputes

pub type Dispute =
  dispute_row.Row

fn dispute_view(d: Dispute) -> List(#(String, Json)) {
  [
    #("id", id.box_dispute_json(d.id)),
    #("sessionId", id.box_session_json(d.session_id)),
    #("playerId", id.player_json(d.player_id)),
    #(
      "by",
      json.object([
        #("kind", party.to_json(d.by_kind)),
        #("id", json.string(d.by_id)),
        #("name", json.nullable(d.by_name, json.string)),
      ]),
    ),
    #("reason", json.string(d.reason)),
    #("status", dispute_row.status_to_json(d.status)),
    #(
      "resolution",
      case d.resolution_outcome, d.resolution_reason, d.resolved_at {
        Some(outcome), Some(reason), Some(at) ->
          json.object([
            #("outcome", dispute_row.resolution_outcome_to_json(outcome)),
            #("reason", json.string(reason)),
            #("at", json.int(at)),
          ])
        _, _, _ -> json.null()
      },
    ),
    #("createdAt", json.int(d.created_at)),
  ]
}

type ReasonBody {
  ReasonBody(reason: Option(String))
}

fn file_dispute(
  ctx: Ctx,
  req: Request,
  player: id.PlayerId,
  sid: id.BoxSessionId,
  by: party.Party,
  by_id: String,
  by_name: String,
) -> Response {
  let shape = {
    use reason <- input.field("reason", input.nullish(input.text(500)))
    input.done(ReasonBody(reason:))
  }
  use b <- http.body(req, shape, [])
  let now = clock.now_ms()
  // Counted before anything is looked up, as the TypeScript server's own window counts every filing.
  case
    limits.limited(
      ctx.limits,
      limits.BoxDispute,
      id.player_to_string(player),
      now,
    )
  {
    True -> http.error(429, "RATE_LIMITED")
    False ->
      case store.read(ctx.store, box_sessions.own(_, player, sid)) {
        Error(e) -> http.internal(e)
        Ok(Some(s)) ->
          case box_sessions.is_terminal(s.row.status) {
            False -> http.error(404, "SESSION_NOT_FOUND")
            True ->
              case string.trim(option.unwrap(b.reason, "")) {
                "" -> http.required("REASON_REQUIRED", "reason")
                text -> {
                  use <- moderate.or_refuse(
                    ctx,
                    text,
                    audit.Context(
                      kind: "box_dispute",
                      player_id: Some(player),
                      org_id: None,
                      user_id: None,
                      channel_id: None,
                      request_id: None,
                    ),
                  )
                  store.unit(ctx.store, fn(tx) {
                    use did <- result.try(id.next_box_dispute(tx))
                    let d =
                      dispute_row.Row(
                        id: did,
                        session_id: sid,
                        player_id: player,
                        by_kind: by,
                        by_id:,
                        by_name: Some(by_name),
                        reason: text,
                        status: dispute_row.Open,
                        resolution_outcome: None,
                        resolution_reason: None,
                        resolved_at: None,
                        created_at: now,
                      )
                    use _ <- result.map(dispute_row.insert(tx, d))
                    http.json(
                      201,
                      json.object([
                        #("dispute", json.object(dispute_view(d))),
                        #(
                          "note",
                          json.string(
                            "Trust & Safety reviews Box Cam disputes. Verified results are never edited by hand — they can be invalidated or restored, not invented.",
                          ),
                        ),
                      ]),
                    )
                  })
                  |> room_routes.answer
                }
              }
          }
        Ok(None) -> http.error(404, "SESSION_NOT_FOUND")
      }
  }
}

/// `POST /player/box-cam/sessions/:id/dispute`.
pub fn player_dispute(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  sid: id.BoxSessionId,
) -> Response {
  file_dispute(
    ctx,
    req,
    p.player.row.id,
    sid,
    party.Player,
    id.player_to_string(p.player.row.id),
    p.player.row.name,
  )
}

/// `POST /guardian/children/:id/box-cam/sessions/:sid/dispute`.
pub fn child_dispute(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  child: id.PlayerId,
  sid: id.BoxSessionId,
) -> Response {
  case owns_child(g, child) {
    False -> http.error(404, "CHILD_NOT_FOUND")
    True ->
      case store.read(ctx.store, players.by_id(_, child)) {
        Error(e) -> http.internal(e)
        Ok(None) -> http.error(404, "PLAYER_NOT_FOUND")
        Ok(Some(_)) ->
          file_dispute(
            ctx,
            req,
            child,
            sid,
            party.Guardian,
            id.guardian_to_string(g.row.id),
            g.row.name,
          )
      }
  }
}

type QueueQuery {
  QueueQuery(page: paging.Query, all: Option(Bool))
}

/// `GET /admin/box-cam/disputes`: one page, oldest first; open ones unless `?all=1`.
pub fn dispute_queue(ctx: Ctx, req: Request) -> Response {
  let shape = {
    use limit <- input.field("limit", input.optional(input.text(1000)))
    use cursor <- input.field("cursor", input.optional(input.text(100_000)))
    use all <- input.field(
      "all",
      input.optional(input.one_of([#("0", False), #("1", True)])),
    )
    input.done(QueueQuery(page: paging.Query(limit:, cursor:), all:))
  }
  use q <- http.query(req, shape, [])
  case paging.read(q.page, [paging.IntKind, paging.TextKind]) {
    Error(e) -> page_refusal(e)
    Ok(page) -> {
      use read <- read_or_500(ctx)
      let #(after, args) = case page.after {
        Some([IntKey(at), TextKey(last)]) -> #(
          " AND (created_at, id) > (?, ?)",
          [sqlight.int(at), sqlight.text(last)],
        )
        _ -> #("", [])
      }
      let open = case q.all {
        Some(True) -> ""
        _ -> " AND status = 'open'"
      }
      use rows <- result.try(
        store.query(
          read,
          "SELECT "
            <> dispute_row.columns
            <> " FROM box_cam_disputes WHERE 1 = 1"
            <> open
            <> after
            <> " ORDER BY created_at, id LIMIT ?",
          list.append(args, [sqlight.int(page.limit + 1)]),
          dispute_row.decoder(),
        )
        |> storage,
      )
      let #(page_items, next) =
        paging.page_of(rows, page.limit, fn(d) {
          [IntKey(d.created_at), TextKey(id.box_dispute_to_string(d.id))]
        })
      use views <- result.map(
        list.try_map(page_items, fn(d) {
          use s <- result.map(box_sessions.by_id(read, d.session_id))
          json.object(
            list.append(dispute_view(d), [
              #("session", case s {
                Some(s) -> box_sessions.view(s, True)
                None -> json.object([])
              }),
            ]),
          )
        })
        |> storage,
      )
      http.json(
        200,
        json.object([
          #("items", json.preprocessed_array(views)),
          #("nextCursor", json.nullable(next, json.string)),
        ]),
      )
    }
  }
}

type ResolveBody {
  ResolveBody(
    outcome: Option(dispute_row.ResolutionOutcome),
    reason: Option(String),
  )
}

fn insert_integrity_event(tx: Tx, e: event_row.Row) -> Result(Nil, Fail(err)) {
  use ord <- result.try(
    store.one(
      store.reading(tx),
      "SELECT COALESCE(MAX(ord) + 1, 0) FROM box_session_integrity_events WHERE session_id = ?",
      [id.box_session_sql(e.session_id)],
      decode.at([0], decode.int),
    )
    |> result.map(result.unwrap(_, 0)),
  )
  event_row.insert(tx, event_row.Row(..e, ord:))
}

/// `POST /admin/box-cam/disputes/:id/resolve`.
pub fn resolve_dispute(
  ctx: Ctx,
  req: Request,
  did: id.BoxDisputeId,
) -> Response {
  let body =
    http.parse_body(
      req,
      {
        use outcome <- input.field(
          "outcome",
          input.optional(input.one_of(dispute_row.resolution_outcome_pairs)),
        )
        use reason <- input.field("reason", input.nullish(input.text(400)))
        input.done(ResolveBody(outcome:, reason:))
      },
      [#("outcome", "OUTCOME_REQUIRED")],
    )
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use found <- result.try(
      store.one(
        read,
        "SELECT "
          <> dispute_row.columns
          <> " FROM box_cam_disputes WHERE id = ?",
        [id.box_dispute_sql(did)],
        dispute_row.decoder(),
      )
      |> storage,
    )
    use d <- result.try(case found {
      Ok(d) -> Ok(d)
      Error(Nil) -> refuse(http.error(404, "DISPUTE_NOT_FOUND"))
    })
    use <- guard_refuse(
      d.status != dispute_row.Open,
      http.error(409, "ALREADY_RESOLVED"),
    )
    use b <- result.try(case body {
      Ok(b) -> Ok(b)
      Error(response) -> refuse(response)
    })
    let reason = string.trim(option.unwrap(b.reason, ""))
    use outcome <- result.try(case b.outcome {
      Some(o) -> Ok(o)
      None ->
        refuse(http.json(
          400,
          json.object([
            #("error", json.string("OUTCOME_REQUIRED")),
            #("field", json.string("outcome")),
            #("problem", json.string("required")),
            #(
              "allowed",
              json.array(dispute_row.resolution_outcome_pairs, fn(p) {
                json.string(p.0)
              }),
            ),
          ]),
        ))
    })
    use <- guard_refuse(
      reason == "",
      http.required("REASON_REQUIRED", "reason"),
    )
    use session <- result.try(box_sessions.by_id(read, d.session_id) |> storage)
    // A session with no result (it expired before it started) or one already invalidated has nothing to invalidate:
    // the dispute is resolved and the session left as it is.
    use _ <- result.try(case outcome, session {
      dispute_row.Stands, _ -> Ok(Nil)
      _, Some(s) ->
        case s.row.verification_state {
          Some(state) if state != session_row.VerificationStateInvalidated ->
            invalidate(tx, s, d, outcome, now) |> storage
          _ -> Ok(Nil)
        }
      _, None -> Ok(Nil)
    })
    use _ <- result.try(
      store.run(
        tx,
        "UPDATE box_cam_disputes SET status = 'resolved', resolution_outcome = ?, resolution_reason = ?, resolved_at = ? WHERE id = ? AND status = 'open'",
        [
          sqlight.text(dispute_row.resolution_outcome_to_string(outcome)),
          sqlight.text(reason),
          sqlight.int(now),
          id.box_dispute_sql(did),
        ],
      )
      |> storage,
    )
    let #(to, to_id) = case d.by_kind {
      party.Guardian -> #(audience.Guardian, d.by_id)
      party.Player -> #(audience.Player, id.player_to_string(d.player_id))
    }
    use _ <- result.map(
      notifications.notify(
        tx,
        to:,
        id: to_id,
        type_: "box_cam",
        text: "Trust & Safety resolved your Box Cam dispute: "
          <> case outcome {
          dispute_row.Stands -> "the result stands"
          _ -> "the result was invalidated"
        }
          <> ".",
        ref_id: Some(id.box_dispute_to_string(did)),
        at: now,
      )
      |> storage,
    )
    let resolved =
      dispute_row.Row(
        ..d,
        status: dispute_row.Resolved,
        resolution_outcome: Some(outcome),
        resolution_reason: Some(reason),
        resolved_at: Some(now),
      )
    http.json(
      200,
      json.object([#("dispute", json.object(dispute_view(resolved)))]),
    )
  })
  |> room_routes.answer
}

fn guard_refuse(
  refused: Bool,
  response: Response,
  next: fn() -> Result(Response, Fail(Response)),
) -> Result(Response, Fail(Response)) {
  case refused {
    True -> refuse(response)
    False -> next()
  }
}

/// Trust & Safety invalidates the result. The session's integrity history is append-only, so a later restore never
/// erases the fact or the moment of invalidation.
fn invalidate(
  tx: Tx,
  s: Session,
  d: Dispute,
  outcome: dispute_row.ResolutionOutcome,
  now: Int,
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(
    store.run(
      tx,
      "UPDATE box_sessions SET status = 'invalidated', invalidated_at = ?, previous_verification_state = verification_state, verification_state = 'invalidated' WHERE id = ? AND verification_state IS NOT NULL AND verification_state <> 'invalidated'",
      [sqlight.int(now), id.box_session_sql(s.row.id)],
    ),
  )
  use _ <- result.try(insert_integrity_event(
    tx,
    event_row.Row(
      session_id: s.row.id,
      ord: 0,
      type_: event_row.TypeInvalidated,
      at: now,
      dispute_id: Some(d.id),
      outcome: Some(case outcome {
        dispute_row.ProviderBug -> event_row.ProviderBug
        _ -> event_row.OutcomeInvalidated
      }),
      to_state: None,
    ),
  ))
  ledger.append(
    tx,
    ledger.Entry(
      entry_type: ledger_row.BoxResultInvalidated,
      player_id: Some(s.row.player_id),
      org_id: None,
      org_name: None,
      user_id: None,
      actor_name: None,
    ),
    now,
  )
  |> result.replace(Nil)
}

/// `POST /admin/box-cam/sessions/:id/restore`: the result an invalidation set aside comes back.
pub fn restore(ctx: Ctx, req: Request, sid: id.BoxSessionId) -> Response {
  let shape = {
    use reason <- input.field("reason", input.nullish(input.text(300)))
    input.done(ReasonBody(reason:))
  }
  use b <- http.body(req, shape, [])
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use found <- result.try(box_sessions.by_id(read, sid) |> storage)
    use s <- result.try(case found {
      Some(s) -> Ok(s)
      None -> refuse(http.error(404, "SESSION_NOT_FOUND"))
    })
    use previous <- result.try(
      case s.row.verification_state, s.row.previous_verification_state {
        Some(session_row.VerificationStateInvalidated), Some(p) -> Ok(p)
        _, _ -> refuse(http.error(409, "NOT_INVALIDATED"))
      },
    )
    let reason = string.trim(option.unwrap(b.reason, ""))
    use <- guard_refuse(
      reason == "",
      http.required("REASON_REQUIRED", "reason"),
    )
    let state = case previous {
      box_restorable_state.Verified -> session_row.VerificationStateVerified
      box_restorable_state.PartiallyVerified ->
        session_row.VerificationStatePartiallyVerified
      box_restorable_state.UnableToVerify ->
        session_row.VerificationStateUnableToVerify
      box_restorable_state.CompletedUnverified ->
        session_row.VerificationStateCompletedUnverified
      box_restorable_state.Cancelled -> session_row.VerificationStateCancelled
    }
    use _ <- result.try(
      store.run(
        tx,
        "UPDATE box_sessions SET status = ?, verification_state = ?, previous_verification_state = NULL, invalidated_at = NULL WHERE id = ? AND verification_state = 'invalidated'",
        [
          sqlight.text(
            session_row.status_to_string(box_sessions.status_of(state)),
          ),
          sqlight.text(session_row.verification_state_to_string(state)),
          id.box_session_sql(sid),
        ],
      )
      |> storage,
    )
    use _ <- result.try(
      insert_integrity_event(
        tx,
        event_row.Row(
          session_id: sid,
          ord: 0,
          type_: event_row.Restored,
          at: now,
          dispute_id: None,
          outcome: None,
          to_state: Some(previous),
        ),
      )
      |> storage,
    )
    use _ <- result.try(
      ledger.append(
        tx,
        ledger.Entry(
          entry_type: ledger_row.BoxResultRestored,
          player_id: Some(s.row.player_id),
          org_id: None,
          org_name: None,
          user_id: None,
          actor_name: None,
        ),
        now,
      )
      |> storage,
    )
    use restored <- result.try(box_sessions.by_id(read, sid) |> storage)
    case restored {
      Some(r) ->
        Ok(http.json(
          200,
          json.object([#("session", box_sessions.view(r, False))]),
        ))
      None -> refuse(http.error(404, "SESSION_NOT_FOUND"))
    }
  })
  |> room_routes.answer
}
