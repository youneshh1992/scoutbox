//// The Recruitment Room routes (domains/recruitment/rooms/rooms.mjs). A Room is the club's decision layer; the
//// Football Passport stays the player's truth layer. A Room never widens visibility, never leaks across clubs,
//// never reaches the player or their guardian, and never lets a Trust Score or a Combine number move a decision by
//// itself.
////
//// Not ported yet: the evidence gate behind statuses that record something that must have happened (contacts,
//// trials, offers, decisions and signings are not ported, so such a move is refused as unsatisfied); a Room's
//// vacancy; the live events (`recruitment_case_moved`, `recruitment_room_archived`); and the lifecycle's own
//// routes, reopen through Second Look and room creation through Nobody Missed, which share this module's rules.

import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/regexp
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/development/combine
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/players
import scoutbox/identity/staff
import scoutbox/insight/evidence_gaps
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/idempotency
import scoutbox/platform/input
import scoutbox/platform/limits
import scoutbox/platform/metrics
import scoutbox/platform/pages
import scoutbox/platform/paging.{IntKey, IntKind, TextKey, TextKind}
import scoutbox/platform/rev
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/platform/temporal
import scoutbox/recruitment/case_lifecycle
import scoutbox/recruitment/cases.{type Room}
import scoutbox/recruitment/lifecycle
import scoutbox/recruitment/requests
import scoutbox/recruitment/room_records
import scoutbox/recruitment/room_rules.{type RoomAction}
import scoutbox/recruitment/room_view
import scoutbox/recruitment/signings
import scoutbox/recruitment/trials
import scoutbox/rows/case_tasks as task_row
import scoutbox/rows/evidence_suggestions as suggestion_row
import scoutbox/rows/id
import scoutbox/rows/ledger as ledger_row
import scoutbox/rows/recruitment_cases as case_row
import scoutbox/rows/room_decisions as decision_row
import scoutbox/rows/room_evidence_states as review_row
import scoutbox/rows/trials as trial_row
import scoutbox/safety/audit
import scoutbox/safety/ledger
import scoutbox/safety/moderate
import scoutbox/scouting/evidence
import scoutbox/vocab/audience
import scoutbox/vocab/case_outcome
import scoutbox/vocab/org_type
import scoutbox/vocab/party
import scoutbox/vocab/position as positions
import scoutbox/vocab/room_status.{type RoomStatus}
import scoutbox/vocab/source_context
import scoutbox/vocab/task_state
import wisp.{type Request, type Response}

const note_max = 2000

const evidence_note_max = 1000

const assessment_kind_max = 60

const combine_title_max = 120

const combine_instructions_max = 300

const combine_protocols_max = 20

/// The counters `/admin/metrics` shows under `rooms`: counts only, never a player or organisation.
pub const metric_names = [
  "recruitment_room_created", "recruitment_room_status_changed",
  "recruitment_room_archived", "recruitment_room_reopened",
  "recruitment_room_signed", "room_assessment_assigned", "room_task_created",
  "room_decision_recorded", "room_trial_requested", "room_combine_requested",
  "room_evidence_requested", "room_comment_added",
]

fn count(tx: Tx, name: String) -> Result(Nil, Fail(e)) {
  metrics.count(tx, "rooms", name)
}

pub fn metrics_json(tx: Tx) -> Result(Json, Fail(e)) {
  metrics.group(tx, "rooms", metric_names)
}

// ------------------------------------------------------------------------------------------------------ helpers

/// Markup is stripped on write, so no renderer, present or future, can execute it.
fn plain_text(s: Option(String), max: Int) -> String {
  let assert Ok(tags) = regexp.from_string("<[^>]*>")
  let assert Ok(angles) = regexp.from_string("[<>]")
  option.unwrap(s, "")
  |> regexp.replace(tags, _, "")
  |> regexp.replace(angles, _, "")
  |> string.trim
  |> input.utf16_take(max)
}

fn some_text(s: String) -> Option(String) {
  case s {
    "" -> None
    _ -> Some(s)
  }
}

fn by(a: OrgAccess) -> cases.By {
  cases.by_staff(a.user.id, a.user.name)
}

fn context(a: OrgAccess, kind: String) -> audit.Context {
  audit.Context(
    kind:,
    player_id: None,
    org_id: Some(a.org.id),
    user_id: None,
    channel_id: None,
    request_id: None,
  )
}

pub fn moderated(
  ctx: Ctx,
  a: OrgAccess,
  text: Option(String),
  kind: String,
  next: fn() -> Response,
) -> Response {
  case text {
    Some(t) -> moderate.or_refuse(ctx, t, context(a, kind), next)
    None -> next()
  }
}

pub fn notify_staff(
  tx: Tx,
  user_id: id.OrgUserId,
  text: String,
  room_id: id.RecruitmentCaseId,
  at: Int,
) -> Result(Nil, Fail(e)) {
  notifications.notify(
    tx,
    to: audience.OrgUser,
    id: id.org_user_to_string(user_id),
    type_: "recruitment_room",
    text:,
    ref_id: Some(id.recruitment_case_to_string(room_id)),
    at:,
  )
}

pub fn player_name(room: Room) -> String {
  option.unwrap(room.row.player_name, "a removed player")
}

pub fn answer(r: Result(Response, store.UnitError(Response))) -> Response {
  case r {
    Ok(response) -> response
    Error(store.Refused(response)) -> response
    Error(store.Lost(what)) -> http.stale(what)
    Error(e) -> http.internal(e)
  }
}

pub fn read_answer(r: Result(Response, Fail(Response))) -> Response {
  case r {
    Ok(response) -> response
    Error(store.Refuse(response)) -> response
    Error(store.Storage(e)) -> http.internal(e)
    Error(store.Stale(what)) -> http.stale(what)
  }
}

pub fn storage(r: Result(a, Fail(e))) -> Result(a, Fail(Response)) {
  store.map_refusal(r, fn(_) { http.error(500, "INTERNAL") })
}

/// A room of another club gets the same 404 as one that does not exist; a restricted room is open only to its
/// lead, its assignees and recruitment leads.
pub fn find(
  read: Read,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
) -> Result(Room, Fail(Response)) {
  use found <- result.try(storage(cases.room(read, room_id)))
  case found {
    Some(room) if room.row.org_id == a.org.id ->
      case room.row.restricted, room_view.role(a, room) {
        True, None ->
          store.refuse(http.error_message(
            403,
            "ROOM_RESTRICTED",
            "This room is restricted to its lead, its assignees and recruitment leads.",
          ))
        _, _ -> Ok(room)
      }
    _ -> store.refuse(http.error(404, "ROOM_NOT_FOUND"))
  }
}

pub fn with_room(
  ctx: Ctx,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
  next: fn(Room) -> Response,
) -> Response {
  case store.read(ctx.store, find(_, a, room_id)) {
    Ok(room) -> next(room)
    Error(store.Refuse(response)) -> response
    Error(store.Storage(e)) -> http.internal(e)
    Error(store.Stale(what)) -> http.stale(what)
  }
}

fn can(
  a: OrgAccess,
  room: Room,
  action: RoomAction,
  next: fn() -> Response,
) -> Response {
  let role = room_view.role(a, room)
  case room_rules.room_can(role, action) {
    True -> next()
    False ->
      http.json(
        403,
        json.object([
          #("error", json.string("ROOM_PERMISSION_REQUIRED")),
          #(
            "message",
            json.string("Your role in this room does not allow that."),
          ),
          #(
            "role",
            json.nullable(option.map(role, room_rules.role_code), json.string),
          ),
          #("action", json.string(room_rules.action_code(action))),
        ]),
      )
  }
}

fn limited(
  ctx: Ctx,
  action: limits.Action,
  owner: String,
  next: fn() -> Response,
) -> Response {
  case limits.limited(ctx.limits, action, owner, clock.now_ms()) {
    True ->
      http.json(
        429,
        json.object(
          list.map(limits.limited_body(action), fn(p) {
            #(p.0, json.string(p.1))
          }),
        ),
      )
    False -> next()
  }
}

/// The room's history gets the entries, and its last activity moves to now.
fn touched(
  tx: Tx,
  a: OrgAccess,
  room: Room,
  entries: List(cases.Entry),
  at: Int,
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(cases.record(tx, room.row.id, by(a), entries, at))
  cases.touch(tx, room.row.id, at)
}

fn reread(tx: Tx, a: OrgAccess, room_id: id.RecruitmentCaseId) {
  find(store.reading(tx), a, room_id)
}

/// Inside a unit, the Room as an act's checks read it before the unit: another request that moved it first makes
/// this act stale, and its route runs again from the new state (`http.rerun_on_stale`).
pub fn still_at(
  tx: Tx,
  a: OrgAccess,
  room: Room,
) -> Result(Room, Fail(Response)) {
  use now_at <- result.try(reread(tx, a, room.row.id))
  case room_view.rev_of(now_at).rev == room_view.rev_of(room).rev {
    True -> Ok(now_at)
    False ->
      store.stale(
        "the Room moved from rev " <> int.to_string(room_view.rev_of(room).rev),
      )
  }
}

fn room_body(
  tx: Tx,
  a: OrgAccess,
  room: Room,
  now: Int,
  allow_simulated: Bool,
) {
  room_view.build(tx, a, room, now, allow_simulated) |> storage
}

fn body_of(
  req: Request,
  shape: input.Shape(b),
  codes: List(#(String, String)),
  next: fn(b, Dynamic) -> Response,
) -> Response {
  use raw <- http.json_body(req)
  case input.parse(shape, raw, root: "body", codes:) {
    Ok(value) -> next(value, raw)
    Error(refusal) -> http.refused(refusal)
  }
}

fn reason_codes_field(next: fn(Option(List(String))) -> input.Shape(a)) {
  use codes <- input.field(
    "reasonCodes",
    input.nullish(input.items(input.text(1_000_000), 1_000_000)),
  )
  next(codes)
}

const reason_codes_code = #("reasonCodes.*", "ROOM_REASONS_INVALID")

fn colleague(read: Read, a: OrgAccess, user_id: String) {
  room_view.colleague(read, a.org.id, id.org_user(user_id)) |> storage
}

// ------------------------------------------------------------------------------------------------------ the list

fn query_value(req: Request, name: String) -> Option(String) {
  wisp.get_query(req)
  |> list.key_find(name)
  |> option.from_result
}

fn view_statuses(view: String) -> Option(List(RoomStatus)) {
  case view {
    "shortlisted" -> Some([room_status.Shortlisted, room_status.Priority])
    "trials" ->
      Some([
        room_status.TrialRequested,
        room_status.TrialScheduled,
        room_status.TrialCompleted,
      ])
    "offers" -> Some([room_status.OfferConsideration, room_status.OfferMade])
    "archived" ->
      Some([room_status.Archived, room_status.Closed, room_status.Withdrawn])
    "active" -> Some(room_rules.open_statuses())
    _ -> None
  }
}

fn viewer(a: OrgAccess) -> cases.Viewer {
  cases.Viewer(a.user.id, access.is_lead(a.user))
}

fn last_activity(room: Room) -> Int {
  list.fold(room.history, room.row.created_at, fn(m, h) { int.max(m, h.at) })
}

/// `GET /org/rooms`: by most recent activity, never ordered by Trust Score. The access rule, the view and the
/// filters are SQL; the search needs the player's visibility, so it is the one filter applied in code.
pub fn list_rooms(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use page <- pages.lenient(req, [IntKind, TextKind])
  let now = clock.now_ms()
  let view = query_value(req, "view") |> option.unwrap("all")
  let filter =
    cases.Filter(
      statuses: view_statuses(view),
      status: query_value(req, "status") |> option.then(some_text),
      mine_of: case view {
        "mine" -> Some(a.user.id)
        _ -> None
      },
      assigned_to: case view {
        "assigned" -> Some(a.user.id)
        _ -> None
      },
      tag: query_value(req, "tag") |> option.then(some_text),
      assignee: query_value(req, "assignee") |> option.then(some_text),
    )
  let q =
    query_value(req, "q")
    |> option.unwrap("")
    |> string.trim
    |> string.lowercase
  let after = case page.after {
    Some([IntKey(at), TextKey(cid)]) -> Some(#(at, cid))
    _ -> None
  }
  let found =
    store.read(ctx.store, fn(read) {
      let accept = case q {
        "" -> None
        _ ->
          Some(fn(r: case_row.Row, tags: List(String)) {
            let visible = case players.for_org(read, r.player_id, a.org, now) {
              Ok(Some(#(_, access))) -> access.visible && !access.blocked
              _ -> False
            }
            let label = case r.room_status {
              Some(s) -> string.lowercase(room_rules.status_label(s))
              None -> ""
            }
            {
              visible
              && string.contains(
                string.lowercase(option.unwrap(r.player_name, "")),
                q,
              )
            }
            || list.any(tags, fn(t) { string.contains(string.lowercase(t), q) })
            || string.contains(label, q)
          })
      }
      use rooms <- result.try(cases.page_for_viewer(
        read,
        a.org.id,
        viewer(a),
        filter,
        page.limit,
        after,
        accept,
      ))
      let #(rooms, next) =
        paging.page_of(rooms, page.limit, fn(r: Room) {
          [
            IntKey(r.updated_at),
            TextKey(id.recruitment_case_to_string(r.row.id)),
          ]
        })
      use decided <- result.try(room_records.decided_rooms(read, a.org.id))
      use items <- result.try(
        list.try_map(rooms, fn(room) {
          use srcs <- result.map(room_view.sources(
            read,
            a.org,
            room,
            now,
            ctx.config.box_cam_test_provider,
          ))
          let health =
            room_rules.room_health(
              None,
              list.contains(decided, room.row.id),
              room.status,
            )
          room_rules.room_summary(
            summary_room(room),
            player: option.map(srcs, fn(s) {
              room_rules.SummaryPlayer(
                position: option.map(s.player.row.position, positions.to_string),
                age: players.age_now(s.player, now),
                current_club: None,
              )
            }),
            trust: option.then(srcs, room_view.summary_trust(a.org, _)),
            open_tasks: room_view.open_tasks(room),
            health: Some(health),
            last_activity_at: Some(last_activity(room)),
            visible: option.is_some(srcs),
          )
        }),
      )
      use counts <- result.map(cases.status_counts(
        read,
        a.org.id,
        Some(viewer(a)),
      ))
      http.json(
        200,
        json.object([
          #("items", json.preprocessed_array(items)),
          #("nextCursor", json.nullable(next, json.string)),
          #("funnel", room_rules.funnel_from_counts(counts)),
          #(
            "statuses",
            json.array(room_rules.statuses(), fn(s) {
              json.object([
                #("id", room_status.to_json(s)),
                #("label", json.string(room_rules.status_label(s))),
              ])
            }),
          ),
          #(
            "note",
            json.string(
              "Rooms are listed by most recent activity. ScoutBox never orders players by Trust Score.",
            ),
          ),
        ]),
      )
    })
  case found {
    Ok(response) -> response
    Error(e) -> http.internal(e)
  }
}

pub fn summary_room(room: Room) -> room_rules.SummaryRoom {
  room_rules.SummaryRoom(
    room_id: room.row.id,
    player_id: room.row.player_id,
    player_name: room.row.player_name,
    status: room.status,
    stage: room.row.stage,
    priority: room.priority,
    tags: room.tags,
    owner_user_id: room.row.owner_user_id,
    owner_name: room.row.owner_name,
    lead_scout_user_id: room.row.room_lead_scout_user_id,
    updated_at: room.updated_at,
    created_at: room.row.created_at,
  )
}

/// `GET /org/rooms/needs-attention`: deterministic workflow signals, read as sets, never ranked or scored.
pub fn needs_attention(ctx: Ctx, a: OrgAccess) -> Response {
  let now = clock.now_ms()
  let found =
    store.read(ctx.store, fn(read) {
      let org_id = a.org.id
      use open <- result.try(cases.rows_for_viewer(
        read,
        org_id,
        viewer(a),
        cases.Filter(
          ..cases.no_filter,
          statuses: Some(room_rules.open_statuses()),
        ),
      ))
      use overdue <- result.try(cases.overdue_task_counts(read, org_id, now))
      use supplied <- result.try(evidence_gaps.players_with_status(
        read,
        org_id,
        suggestion_row.Supplied,
      ))
      use done_combine <- result.try(combine.completed_players(read, org_id))
      use reported <- result.try(trials.players_with_status(
        read,
        org_id,
        trial_row.Reported,
      ))
      use decided <- result.map(room_records.decided_rooms(read, org_id))
      let items =
        list.filter_map(open, fn(c) {
          let status = option.unwrap(c.room_status, room_status.Watching)
          let reasons =
            option.values([
              case list.key_find(overdue, c.id) {
                Ok(n) if n > 0 ->
                  Some(#(
                    "TASK_OVERDUE",
                    int.to_string(n) <> " task(s) past their due date.",
                  ))
                _ -> None
              },
              case list.contains(supplied, c.player_id) {
                True ->
                  Some(#("EVIDENCE_RETURNED", "Requested evidence has arrived."))
                False -> None
              },
              case list.contains(done_combine, c.player_id) {
                True ->
                  Some(#(
                    "COMBINE_COMPLETED",
                    "A requested Combine has been completed.",
                  ))
                False -> None
              },
              case
                list.contains(reported, c.player_id)
                && status == room_status.TrialScheduled
              {
                True -> Some(#("TRIAL_REPORTED", "A trial report is in."))
                False -> None
              },
              case
                list.contains(
                  [room_status.OfferConsideration, room_status.OfferMade],
                  status,
                )
                && !list.contains(decided, c.id)
              {
                True ->
                  Some(#(
                    "DECISION_OUTSTANDING",
                    "No decision has been recorded yet.",
                  ))
                False -> None
              },
            ])
          case reasons {
            [] -> Error(Nil)
            _ ->
              Ok(
                json.object([
                  #("roomId", id.recruitment_case_json(c.id)),
                  #("playerId", id.player_json(c.player_id)),
                  #("playerName", json.nullable(c.player_name, json.string)),
                  #("status", room_status.to_json(status)),
                  #(
                    "reasons",
                    json.array(reasons, fn(r) {
                      json.object([
                        #("code", json.string(r.0)),
                        #("text", json.string(r.1)),
                      ])
                    }),
                  ),
                ]),
              )
          }
        })
      http.json(
        200,
        json.object([
          #("items", json.preprocessed_array(items)),
          #(
            "note",
            json.string(
              "Deterministic workflow signals only. ScoutBox does not rank or score these for you.",
            ),
          ),
        ]),
      )
    })
  case found {
    Ok(response) -> response
    Error(e) -> http.internal(e)
  }
}

/// `GET /org/rooms/summaries?playerIds=`: which of these players already have an open room (the search screen).
pub fn summaries(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  let ids =
    query_value(req, "playerIds")
    |> option.unwrap("")
    |> string.split(",")
    |> list.map(string.trim)
    |> list.filter(fn(s) { s != "" })
    |> list.take(100)
  let found =
    store.read(ctx.store, fn(read) {
      list.try_map(ids, fn(pid) {
        use room <- result.map(cases.open_room_for(
          read,
          a.org.id,
          id.player(pid),
        ))
        case room {
          Some(r) ->
            case r.row.restricted && room_view.role(a, r) == None {
              True -> None
              False -> Some(r)
            }
          None -> None
        }
        |> fn(r) {
          case r {
            Some(r) ->
              json.object([
                #("playerId", json.string(pid)),
                #("roomId", id.recruitment_case_json(r.row.id)),
                #("status", room_status.to_json(r.status)),
                #("statusLabel", json.string(room_rules.status_label(r.status))),
              ])
            None ->
              json.object([
                #("playerId", json.string(pid)),
                #("roomId", json.null()),
                #("status", json.null()),
              ])
          }
        }
      })
    })
  case found {
    Ok(items) ->
      http.json(200, json.object([#("items", json.preprocessed_array(items))]))
    Error(e) -> http.internal(e)
  }
}

// ---------------------------------------------------------------------------------------------------- create

type NewRoom {
  NewRoom(
    player_id: String,
    source_context: Option(source_context.SourceContext),
    priority: Option(case_row.RoomPriority),
    restricted: Option(Bool),
    vacancy_id: Option(String),
  )
}

/// `POST /org/rooms`. A room cannot bookmark a player the club may not see. It adopts the club's open case for the
/// player when there is one, so a case and a room never disagree.
pub fn create(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use <- limited(ctx, limits.RoomCreate, id.org_to_string(a.org.id))
  let shape = {
    use player_id <- input.field("playerId", input.required(input.id()))
    use source_context <- input.field(
      "sourceContext",
      input.nullish(input.one_of(source_context.pairs)),
    )
    use priority <- input.field(
      "priority",
      input.nullish(input.one_of(case_row.room_priority_pairs)),
    )
    use restricted <- input.field("restricted", input.nullish(input.boolean()))
    use vacancy_id <- input.field("vacancyId", input.nullish(input.id()))
    input.done(NewRoom(
      player_id:,
      source_context:,
      priority:,
      restricted:,
      vacancy_id:,
    ))
  }
  use body <- http.body(req, shape, [#("priority", "ROOM_PRIORITY_UNKNOWN")])
  let now = clock.now_ms()
  let result =
    store.unit(ctx.store, fn(tx) {
      let read = store.reading(tx)
      use found <- result.try(
        storage(players.for_org(read, id.player(body.player_id), a.org, now)),
      )
      use p <- result.try(case found {
        None -> store.refuse(http.error(404, "PLAYER_NOT_FOUND"))
        Some(#(_, access)) if !access.visible || access.blocked ->
          store.refuse(http.error_message(
            403,
            "NOT_VISIBLE",
            "This player is not visible to your organisation under the standing rules.",
          ))
        Some(#(p, _)) -> Ok(p)
      })
      use _ <- result.try(case body.vacancy_id {
        Some(v) -> {
          use rows <- result.try(
            storage(store.query(
              read,
              "SELECT 1 FROM vacancies WHERE id = ? AND org_id = ?",
              [id.vacancy_sql(id.vacancy(v)), id.org_sql(a.org.id)],
              decode.at([0], decode.int),
            )),
          )
          case rows {
            [] -> store.refuse(http.error(404, "VACANCY_NOT_FOUND"))
            _ -> Ok(Nil)
          }
        }
        None -> Ok(Nil)
      })
      use existing <- result.try(
        storage(cases.open_room_for(read, a.org.id, p.row.id)),
      )
      use _ <- result.try(case existing {
        Some(r) ->
          store.refuse(http.json(
            409,
            json.object([
              #("error", json.string("ROOM_EXISTS")),
              #("existingRoomId", id.recruitment_case_json(r.row.id)),
              #("status", room_status.to_json(r.status)),
              #(
                "message",
                json.string(
                  "Your organisation already has an active Recruitment Room for this player.",
                ),
              ),
            ]),
          ))
        None -> Ok(Nil)
      })
      use #(room_id, adopted) <- result.try(
        open_room(
          tx,
          a,
          p,
          option.unwrap(body.source_context, source_context.Direct),
          None,
          option.unwrap(body.priority, case_row.Normal),
          option.unwrap(body.restricted, False),
          now,
        )
        |> storage,
      )
      use _ <- result.try(
        ledger.append(
          tx,
          ledger.Entry(
            entry_type: ledger_row.RecruitmentRoomCreated,
            player_id: Some(p.row.id),
            org_id: Some(a.org.id),
            org_name: Some(a.org.name),
            user_id: Some(a.user.id),
            actor_name: Some(a.user.name),
          ),
          now,
        )
        |> storage,
      )
      use _ <- result.try(count(tx, "recruitment_room_created") |> storage)
      use room <- result.try(reread(tx, a, room_id))
      use view <- result.map(room_body(
        tx,
        a,
        room,
        now,
        ctx.config.box_cam_test_provider,
      ))
      http.json(
        201,
        json.object([
          #("room", view),
          #("adoptedExistingCase", json.bool(adopted)),
        ]),
      )
    })
  answer(result)
}

/// Opens a Room inside the caller's unit: adopts the club's open plain case, keeping its stage (without asserting
/// unproven facts), or creates the case with its Room in one write.
fn open_room(
  tx: Tx,
  a: OrgAccess,
  p: players.Player,
  source: source_context.SourceContext,
  source_ref: Option(#(String, Option(Int))),
  priority: case_row.RoomPriority,
  restricted: Bool,
  now: Int,
) -> Result(#(id.RecruitmentCaseId, Bool), Fail(e)) {
  let level = room_view.level(a.org)
  use plain <- result.try(cases.open_plain_case(
    store.reading(tx),
    a.org.id,
    p.row.id,
  ))
  let status = case plain {
    Some(c) -> room_rules.adoption_status_for_stage(c.stage, level)
    None -> room_rules.initial
  }
  let opening =
    cases.Opening(
      status:,
      priority:,
      lead_scout: a.user.id,
      source_context: source,
      source_ref:,
      opened_by: #(a.user.id, a.user.name),
      at: now,
    )
  let entry = fn(adopted, inherited) {
    cases.entry("room_created", [
      #("status", room_status.to_json(status)),
      #("sourceContext", source_context.to_json(source)),
      #("adoptedExistingCase", json.bool(adopted)),
      #("inheritedStage", json.nullable(inherited, case_row.stage_to_json)),
    ])
  }
  case plain {
    Some(c) -> {
      use _ <- result.try(cases.adopt(tx, c, opening, level))
      use _ <- result.map(cases.record(
        tx,
        c.id,
        by(a),
        [entry(True, Some(c.stage))],
        now,
      ))
      #(c.id, True)
    }
    None -> {
      use case_id <- result.try(cases.create(
        tx,
        cases.NewCase(
          org_id: a.org.id,
          player_id: p.row.id,
          player_name: p.row.name,
          owner: #(a.user.id, a.user.name),
          restricted:,
          level:,
        ),
        opening,
      ))
      use _ <- result.map(cases.record(
        tx,
        case_id,
        by(a),
        [entry(False, None)],
        now,
      ))
      #(case_id, False)
    }
  }
}

/// A Room the caller may already have opened, as `create_for_player` answers.
pub type Created {
  Created(room_id: id.RecruitmentCaseId, existed: Bool, view: Json)
}

/// The Room creator for other domains (rooms.mjs `createRoomForPlayer`, for Nobody Missed): the same visibility
/// check and adoption as `POST /org/rooms`, inside the caller's unit. An open Room for the player is answered as it
/// is, so a double click adds the player once.
pub fn create_for_player(
  tx: Tx,
  a: OrgAccess,
  player_id: id.PlayerId,
  source: source_context.SourceContext,
  source_ref: Option(#(String, Option(Int))),
  now: Int,
  allow_simulated: Bool,
) -> Result(Created, Fail(Response)) {
  let read = store.reading(tx)
  use found <- result.try(storage(players.for_org(read, player_id, a.org, now)))
  use p <- result.try(case found {
    Some(#(p, access)) if access.visible && !access.blocked -> Ok(p)
    _ -> store.refuse(refusal(403, "NOT_VISIBLE", []))
  })
  use existing <- result.try(
    storage(cases.open_room_for(read, a.org.id, p.row.id)),
  )
  case existing {
    Some(r) -> {
      use view <- result.map(room_body(tx, a, r, now, allow_simulated))
      Created(r.row.id, True, view)
    }
    None -> {
      use #(room_id, _) <- result.try(
        open_room(tx, a, p, source, source_ref, case_row.Normal, False, now)
        |> storage,
      )
      use _ <- result.try(
        ledger.append(
          tx,
          ledger.Entry(
            entry_type: ledger_row.RecruitmentRoomCreated,
            player_id: Some(p.row.id),
            org_id: Some(a.org.id),
            org_name: Some(a.org.name),
            user_id: Some(a.user.id),
            actor_name: Some(a.user.name),
          ),
          now,
        )
        |> storage,
      )
      use _ <- result.try(count(tx, "recruitment_room_created") |> storage)
      use room <- result.try(reread(tx, a, room_id))
      use view <- result.map(room_body(tx, a, room, now, allow_simulated))
      Created(room_id, False, view)
    }
  }
}

/// The body another domain answers when a shared Room act refuses: `{ ok: false, status, error, … }`, as the
/// TypeScript acts return their refusals and the calling route sends them whole.
fn refusal(
  status: Int,
  error: String,
  fields: List(#(String, Json)),
) -> Response {
  http.json(
    status,
    json.object([
      #("ok", json.bool(False)),
      #("status", json.int(status)),
      #("error", json.string(error)),
      ..fields
    ]),
  )
}

fn source_ref_json(source_ref: Option(#(String, Option(Int)))) -> Json {
  case source_ref {
    Some(#(ref_id, version)) ->
      json.object(
        list.append([#("id", json.string(ref_id))], case version {
          Some(v) -> [#("version", json.int(v))]
          None -> []
        }),
      )
    None -> json.null()
  }
}

/// The one reopen path (rooms.mjs `reopenRoom`), shared with Second Look: the same transition table, reason
/// requirement, evidence gate, snapshot and decision memory as a recruiter's move, inside the caller's unit. The
/// caller supplies only where the reopen came from. Answers the reopened Room's view.
pub fn reopen(
  tx: Tx,
  a: OrgAccess,
  room: Room,
  to: RoomStatus,
  reason_codes: List(String),
  source: source_context.SourceContext,
  source_ref: Option(#(String, Option(Int))),
  now: Int,
  allow_simulated: Bool,
) -> Result(Json, Fail(Response)) {
  let from = room.status
  use _ <- result.try(
    case room_rules.room_can(room_view.role(a, room), room_rules.Reopen) {
      True -> Ok(Nil)
      False -> store.refuse(refusal(403, "ROOM_PERMISSION_REQUIRED", []))
    },
  )
  // Only closed rooms reopen; pulling a live room back under a "reopened" label would rewrite a live case.
  use _ <- result.try(case list.contains(room_rules.reopened_from, from) {
    True -> Ok(Nil)
    False ->
      store.refuse(
        refusal(409, "ROOM_NOT_REOPENABLE", [
          #(
            "message",
            json.string(
              "A room at "
              <> room_rules.status_label(from)
              <> " is not closed, so it cannot be reopened.",
            ),
          ),
          #("current", json.object([#("status", room_status.to_json(from))])),
        ]),
      )
  })
  use codes <- result.try(case room_rules.validate_reason_codes(reason_codes) {
    Ok(codes) -> Ok(codes)
    Error(r) ->
      store.refuse(http.json(
        400,
        json.object(
          list.flat_map(room_rules.reason_refusal_fields(r), fn(f) {
            case f.0 {
              "ok" -> [f, #("status", json.int(400))]
              _ -> [f]
            }
          }),
        ),
      ))
  })
  use check <- result.try(case room_rules.validate_transition(from, to, codes) {
    Ok(check) -> Ok(check)
    Error(r) -> {
      let status = case r {
        room_rules.Invalid(..) -> 409
        _ -> 400
      }
      store.refuse(http.json(
        status,
        json.object([
          #("ok", json.bool(False)),
          #("status", json.int(status)),
          ..room_rules.transition_refusal_fields(r)
        ]),
      ))
    }
  })
  use _ <- result.try(case check.requires_evidence {
    None -> Ok(Nil)
    Some(kind) ->
      case
        storage(case_lifecycle.evidence(store.reading(tx), room, kind, now))
      {
        Error(e) -> Error(e)
        Ok(case_lifecycle.Holds(..)) -> Ok(Nil)
        Ok(case_lifecycle.Lacks(why)) ->
          store.refuse(
            refusal(422, "ROOM_EVIDENCE_REQUIRED", [
              #("requires", json.string(room_rules.evidence_code(kind))),
              #("evidenceReason", json.string(why)),
            ]),
          )
      }
  })
  use _ <- result.try(case check.snapshot {
    True ->
      room_view.capture_snapshot(
        tx,
        a.org,
        room,
        "status:" <> room_status.to_string(to),
        now,
        allow_simulated,
      )
      |> storage
      |> result.replace(Nil)
    False -> Ok(Nil)
  })
  let staff_id = Some(id.org_user_to_string(a.user.id))
  use _ <- result.try(
    cases.move(
      tx,
      room.row.id,
      room_view.level(a.org),
      cases.Move(
        to:,
        at: now,
        by_id: staff_id,
        by_name: Some(a.user.name),
        resume: False,
        reopened: Some(cases.Reopened(
          by_id: staff_id,
          by_name: Some(a.user.name),
          from:,
          reason_codes: codes,
          source_context: Some(source),
          source_ref:,
        )),
        source_context: Some(source),
      ),
    )
    |> storage,
  )
  use _ <- result.try(
    cases.record(
      tx,
      room.row.id,
      by(a),
      [
        cases.entry("room_reopened", [
          #("from", room_status.to_json(from)),
          #("to", room_status.to_json(to)),
          #("reasonCodes", json.array(codes, json.string)),
          #("sourceContext", source_context.to_json(source)),
          #("sourceRef", source_ref_json(source_ref)),
        ]),
      ],
      now,
    )
    |> storage,
  )
  use _ <- result.try(count(tx, "recruitment_room_reopened") |> storage)
  store.emit(
    tx,
    case_lifecycle.moved_event(room.row.org_id, room.row.id, from, to),
  )
  use moved <- result.try(reread(tx, a, room.row.id))
  room_body(tx, a, moved, now, allow_simulated)
}

// ------------------------------------------------------------------------------------------------------- read

/// `GET /org/rooms/:id`.
pub fn get(ctx: Ctx, a: OrgAccess, room_id: id.RecruitmentCaseId) -> Response {
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    use room <- result.try(reread(tx, a, room_id))
    use view <- result.map(room_body(
      tx,
      a,
      room,
      now,
      ctx.config.box_cam_test_provider,
    ))
    http.json(200, json.object([#("room", view)]))
  })
  |> answer
}

// ------------------------------------------------------------------------------------------------------- edit

type RoomEdit {
  RoomEdit(
    priority: Option(case_row.RoomPriority),
    tags: Option(List(String)),
    lead_scout: Option(Option(String)),
    owner: Option(String),
    restricted: Option(Bool),
    deadline: Option(Option(temporal.Due)),
  )
}

/// `PATCH /org/rooms/:id`. Only the fields where a lost update changes who is responsible or how urgent the room is
/// are guarded by revision; demanding one for tags teaches people to send whatever number makes the error go away.
pub fn edit(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
) -> Response {
  use room <- with_room(ctx, a, room_id)
  let shape = {
    use <- rev.fields
    use priority <- input.field(
      "priority",
      input.optional(input.one_of(case_row.room_priority_pairs)),
    )
    use tags <- input.field(
      "tags",
      input.optional(input.items(input.text(room_rules.tag_length), 1_000_000)),
    )
    use lead_scout <- input.field(
      "leadScoutUserId",
      input.clearable(input.id()),
    )
    use owner <- input.field("ownerUserId", input.optional(input.id()))
    use restricted <- input.field("restricted", input.optional(input.boolean()))
    use deadline <- input.field("deadline", input.optional(input.due_date()))
    input.done(RoomEdit(
      priority:,
      tags:,
      lead_scout:,
      owner:,
      restricted:,
      deadline:,
    ))
  }
  use body, raw <- body_of(
    req,
    shape,
    list.append(rev.codes, [
      #("priority", "ROOM_PRIORITY_UNKNOWN"),
      #("tags.*", "ROOM_TAGS_INVALID"),
    ]),
  )
  let workflow =
    option.is_some(body.priority)
    || option.is_some(body.lead_scout)
    || option.is_some(body.owner)
    || option.is_some(body.restricted)
  use expected <- rev_or_refuse(raw)
  let expected = case workflow {
    True -> expected
    False -> rev.Unguarded
  }
  use <- rev.guard(expected, room_view.rev_of(room), "ROOM_VERSION_CONFLICT", [
    #(
      "current",
      json.object([
        #("status", room_status.to_json(room.status)),
        #("priority", case_row.room_priority_to_json(room.priority)),
        #("updatedAt", json.int(room.updated_at)),
      ]),
    ),
  ])
  // Every field is judged before anything is written.
  use <- when(option.is_some(body.priority), fn(next) {
    can(a, room, room_rules.SetStatus, next)
  })
  use tags <- clean_tags(body.tags)
  use <- when(option.is_some(body.lead_scout), fn(next) {
    can(a, room, room_rules.Assign, next)
  })
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use lead <- result.try(case body.lead_scout {
      Some(Some(u)) -> {
        use found <- result.try(colleague(read, a, u))
        case found {
          Some(s) -> Ok(Some(Some(s.id)))
          None -> store.refuse(http.error(404, "USER_NOT_IN_ORG"))
        }
      }
      Some(None) -> Ok(Some(None))
      None -> Ok(None)
    })
    use owner <- result.try(case body.owner {
      Some(u) ->
        case
          room_rules.room_can(room_view.role(a, room), room_rules.ReassignOwner)
        {
          False -> store.refuse(permission(a, room, room_rules.ReassignOwner))
          True -> {
            use found <- result.try(colleague(read, a, u))
            case found {
              Some(s) -> Ok(Some(#(s.id, s.name)))
              None -> store.refuse(http.error(404, "USER_NOT_IN_ORG"))
            }
          }
        }
      None -> Ok(None)
    })
    use _ <- result.try(
      case
        option.is_some(body.restricted)
        && !room_rules.room_can(room_view.role(a, room), room_rules.SetStatus)
      {
        True -> store.refuse(permission(a, room, room_rules.SetStatus))
        False -> Ok(Nil)
      },
    )
    let entries =
      option.values([
        option.map(body.priority, fn(p) {
          cases.entry("room_priority_changed", [
            #("priority", case_row.room_priority_to_json(p)),
          ])
        }),
        option.map(tags, fn(t) {
          cases.entry("room_tag_changed", [#("count", json.int(list.length(t)))])
        }),
        option.map(lead, fn(l) {
          cases.entry("room_member_assigned", [
            #("leadScoutUserId", json.nullable(l, id.org_user_json)),
          ])
        }),
        option.map(owner, fn(o) {
          cases.entry("room_owner_changed", [
            #("ownerUserId", id.org_user_json(o.0)),
          ])
        }),
      ])
    use _ <- result.try(
      cases.edit(
        tx,
        room.row.id,
        cases.Edit(
          priority: body.priority,
          tags:,
          lead_scout: lead,
          owner:,
          restricted: body.restricted,
          deadline: body.deadline,
        ),
      )
      |> storage,
    )
    use _ <- result.try(touched(tx, a, room, entries, now) |> storage)
    use _ <- result.try(case workflow {
      True ->
        cases.bump(
          tx,
          room.row.id,
          now,
          Some(id.org_user_to_string(a.user.id)),
          Some(a.user.name),
        )
        |> storage
      False -> Ok(Nil)
    })
    use fresh <- result.try(reread(tx, a, room.row.id))
    use view <- result.map(room_body(
      tx,
      a,
      fresh,
      now,
      ctx.config.box_cam_test_provider,
    ))
    http.json(200, json.object([#("room", view)]))
  })
  |> answer
}

fn permission(a: OrgAccess, room: Room, action: RoomAction) -> Response {
  can(a, room, action, fn() { wisp.ok() })
}

fn when(
  condition: Bool,
  check: fn(fn() -> Response) -> Response,
  next: fn() -> Response,
) -> Response {
  case condition {
    True -> check(next)
    False -> next()
  }
}

fn rev_or_refuse(raw: Dynamic, next: fn(rev.Expected) -> Response) -> Response {
  case rev.expected(raw) {
    Ok(e) -> next(e)
    Error(response) -> response
  }
}

fn clean_tags(
  tags: Option(List(String)),
  next: fn(Option(List(String))) -> Response,
) -> Response {
  case tags {
    None -> next(None)
    Some(ts) ->
      case list.length(ts) > room_rules.tags_per_room {
        True -> http.error(400, "ROOM_TAGS_TOO_MANY")
        False ->
          case list.try_map(ts, room_rules.validate_tag) {
            Ok(clean) -> next(Some(list.unique(clean)))
            Error(refusal) ->
              http.json(
                400,
                json.object(room_rules.tag_refusal_fields(refusal)),
              )
          }
      }
  }
}

// ----------------------------------------------------------------------------------------------- status move

type StatusMove {
  StatusMove(
    status: RoomStatus,
    reason_codes: Option(List(String)),
    note: Option(String),
  )
}

/// `POST /org/rooms/:id/status`. Shortlisting and archiving race, so the move is guarded by revision; a status a
/// lifecycle action reaches needs that action's role here too, so a room lead cannot reach `signed`.
pub fn move_status(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
) -> Response {
  use room <- with_room(ctx, a, room_id)
  use <- can(a, room, room_rules.SetStatus)
  use raw <- http.json_body(req)
  use expected <- rev_or_refuse(raw)
  use <- rev.guard(expected, room_view.rev_of(room), "ROOM_VERSION_CONFLICT", [
    #(
      "current",
      json.object([
        #("status", room_status.to_json(room.status)),
        #("statusLabel", json.string(room_rules.status_label(room.status))),
        #("updatedAt", json.int(room.updated_at)),
      ]),
    ),
  ])
  let shape = {
    use <- rev.fields
    use status <- input.field(
      "status",
      input.required(input.one_of(room_status.pairs)),
    )
    use reason_codes <- reason_codes_field
    use note <- input.field("note", input.nullish(input.text(note_max)))
    input.done(StatusMove(status:, reason_codes:, note:))
  }
  case
    input.parse(
      shape,
      raw,
      root: "body",
      codes: list.append(rev.codes, [
        #("status", "ROOM_STATUS_UNKNOWN"),
        reason_codes_code,
      ]),
    )
  {
    Error(refusal) -> http.refused(refusal)
    Ok(body) -> move_body(ctx, a, room, body)
  }
}

fn move_body(ctx: Ctx, a: OrgAccess, room: Room, body: StatusMove) -> Response {
  let to = body.status
  let role = room_view.role(a, room)
  let naming =
    list.filter(lifecycle.actions, fn(x) { x.to == room_status.to_string(to) })
  let rank = fn(r) {
    case r {
      lifecycle.Contributor -> 1
      lifecycle.RoomLead -> 2
      lifecycle.RecruitmentAdmin -> 3
    }
  }
  let allowed =
    list.any(naming, fn(x) {
      list.any(x.roles, fn(r) {
        case role {
          Some(mine) -> room_rules.role_rank(mine) >= rank(r)
          None -> False
        }
      })
    })
  case naming != [] && !allowed {
    True ->
      http.json(
        403,
        json.object([
          #("error", json.string("ROOM_PERMISSION_REQUIRED")),
          #(
            "message",
            json.string("Your role cannot move the room to that state."),
          ),
          #(
            "required",
            json.array(
              list.unique(list.flat_map(naming, fn(x) { x.roles })),
              fn(r) { json.string(lifecycle.role_to_string(r)) },
            ),
          ),
        ]),
      )
    False ->
      case
        room_rules.validate_reason_codes(option.unwrap(body.reason_codes, []))
      {
        Error(refusal) ->
          http.json(400, json.object(room_rules.reason_refusal_fields(refusal)))
        Ok(codes) -> {
          let note = some_text(plain_text(body.note, note_max))
          use <- moderated(ctx, a, note, "recruitment_room")
          case room_rules.validate_transition(room.status, to, codes) {
            Error(refusal) ->
              http.json(
                case refusal {
                  room_rules.Invalid(..) -> 409
                  _ -> 400
                },
                json.object(room_rules.transition_refusal_fields(refusal)),
              )
            Ok(check) ->
              case check.requires_evidence {
                Some(kind) ->
                  case
                    store.read(ctx.store, case_lifecycle.evidence(
                      _,
                      room,
                      kind,
                      clock.now_ms(),
                    ))
                  {
                    Error(e) -> http.internal(e)
                    Ok(case_lifecycle.Holds(..)) ->
                      apply_move(ctx, a, room, to, codes, note, check)
                    Ok(case_lifecycle.Lacks(why)) ->
                      http.json(
                        422,
                        json.object([
                          #("error", json.string("ROOM_EVIDENCE_REQUIRED")),
                          #(
                            "message",
                            json.string(
                              "\""
                              <> room_status.to_string(to)
                              <> "\" records something that must actually have happened; no supporting record was found.",
                            ),
                          ),
                          #(
                            "requires",
                            json.string(room_rules.evidence_code(kind)),
                          ),
                          #("evidenceReason", json.string(why)),
                        ]),
                      )
                  }
                None -> apply_move(ctx, a, room, to, codes, note, check)
              }
          }
        }
      }
  }
}

fn apply_move(
  ctx: Ctx,
  a: OrgAccess,
  room: Room,
  to: RoomStatus,
  codes: List(String),
  note: Option(String),
  check: room_rules.Transition,
) -> Response {
  let now = clock.now_ms()
  let from = room.status
  let ends =
    list.contains(
      [room_status.Archived, room_status.Closed, room_status.Withdrawn],
      to,
    )
  store.unit(ctx.store, fn(tx) {
    use _ <- result.try(still_at(tx, a, room))
    use snapshot <- result.try(case check.snapshot {
      True ->
        room_view.capture_snapshot(
          tx,
          a.org,
          room,
          "status:" <> room_status.to_string(to),
          now,
          ctx.config.box_cam_test_provider,
        )
        |> storage
      False -> Ok(None)
    })
    let staff_id = Some(id.org_user_to_string(a.user.id))
    use _ <- result.try(
      cases.move(
        tx,
        room.row.id,
        room_view.level(a.org),
        cases.Move(
          to:,
          at: now,
          by_id: staff_id,
          by_name: Some(a.user.name),
          resume: False,
          reopened: case check.reopen {
            True ->
              Some(cases.Reopened(
                by_id: staff_id,
                by_name: Some(a.user.name),
                from:,
                reason_codes: codes,
                source_context: None,
                source_ref: None,
              ))
            False -> None
          },
          source_context: None,
        ),
      )
      |> storage,
    )
    // Development-only fault seam: the unit is refused whole, so nothing from the status write survives.
    use _ <- result.try(store.seam(tx, "lifecycle.after_status") |> storage)
    let codes_json = json.array(codes, json.string)
    use _ <- result.try(
      cases.record(
        tx,
        room.row.id,
        by(a),
        list.flatten([
          case check.reopen {
            True -> [
              cases.entry("room_reopened", [
                #("from", room_status.to_json(from)),
                #("to", room_status.to_json(to)),
                #("reasonCodes", codes_json),
              ]),
            ]
            False -> []
          },
          [
            cases.entry("room_status_changed", [
              #("from", room_status.to_json(from)),
              #("to", room_status.to_json(to)),
              #("reasonCodes", codes_json),
              #("note", json.bool(option.is_some(note))),
            ]),
          ],
        ]),
        now,
      )
      |> storage,
    )
    // Keeps the case's sign-off consistent, so "closing needs a decision" holds.
    use _ <- result.try(case to == room_status.Signed, ends {
      True, _ ->
        cases.record_sign_off(
          tx,
          room.row.id,
          cases.SignOff(
            case_outcome.Sign,
            case codes {
              [] -> "signed"
              _ -> string.join(codes, ", ")
            },
            #(a.user.id, a.user.name),
            now,
          ),
        )
        |> storage
      False, True ->
        cases.record_sign_off(
          tx,
          room.row.id,
          cases.SignOff(
            case_outcome.Pass,
            string.join(codes, ", "),
            #(a.user.id, a.user.name),
            now,
          ),
        )
        |> storage
      False, False -> Ok(Nil)
    })
    // Recorded as a decision, so the reason survives as machine-readable decision memory.
    use _ <- result.try(case ends {
      True ->
        record_decision(
          tx,
          a,
          room,
          decision_row.Archive,
          codes,
          note,
          snapshot,
          "status:" <> room_status.to_string(to),
          None,
          now,
        )
        |> result.replace(Nil)
      False -> Ok(Nil)
    })
    use moved <- result.try(reread(tx, a, room.row.id))
    use staff_list <- result.try(
      staff.for_org(store.reading(tx), a.org.id, active_only: True) |> storage,
    )
    use _ <- result.try(
      list.try_each(staff_list, fn(u) {
        case
          u.id != a.user.id
          && {
            u.id == moved.row.owner_user_id
            || Some(u.id) == moved.row.room_lead_scout_user_id
          }
        {
          True ->
            notify_staff(
              tx,
              u.id,
              "Recruitment Room — "
                <> player_name(moved)
                <> ": "
                <> room_rules.status_label(to)
                <> ".",
              moved.row.id,
              now,
            )
          False -> Ok(Nil)
        }
      })
      |> storage,
    )
    use _ <- result.try(case check.reopen {
      True -> count(tx, "recruitment_room_reopened") |> storage
      False -> Ok(Nil)
    })
    use _ <- result.try(count(tx, "recruitment_room_status_changed") |> storage)
    use _ <- result.try(case ends {
      True -> count(tx, "recruitment_room_archived") |> storage
      False -> Ok(Nil)
    })
    use _ <- result.try(case to == room_status.Signed {
      True -> count(tx, "recruitment_room_signed") |> storage
      False -> Ok(Nil)
    })
    store.emit(
      tx,
      case_lifecycle.moved_event(room.row.org_id, room.row.id, from, to),
    )
    use moved <- result.try(reread(tx, a, room.row.id))
    use view <- result.map(room_body(
      tx,
      a,
      moved,
      now,
      ctx.config.box_cam_test_provider,
    ))
    http.json(
      200,
      json.object([
        #("room", view),
        #("snapshot", json.nullable(snapshot, room_records.snapshot_json)),
      ]),
    )
  })
  |> answer
}

fn record_decision(
  tx: Tx,
  a: OrgAccess,
  room: Room,
  recommendation: decision_row.Recommendation,
  codes: List(String),
  note: Option(String),
  snapshot: Option(room_records.Snapshot),
  trigger: String,
  client_key: Option(String),
  now: Int,
) -> Result(room_records.Decision, Fail(Response)) {
  let read = store.reading(tx)
  use previous <- result.try(
    room_records.decisions(read, room.row.id) |> storage,
  )
  use saved <- result.try(
    room_records.add_decision(
      tx,
      room_records.NewDecision(
        room_id: room.row.id,
        org_id: room.row.org_id,
        player_id: room.row.player_id,
        recommendation:,
        reason_codes: codes,
        note:,
        by: #(a.user.id, a.user.name, a.user.role),
        trigger:,
        client_key:,
        supersedes: list.last(previous)
          |> option.from_result
          |> option.map(fn(d) { d.row.id }),
        snapshot:,
        at: now,
      ),
    )
    |> storage,
  )
  use _ <- result.try(
    cases.record(
      tx,
      room.row.id,
      by(a),
      [
        cases.entry("room_decision_recorded", [
          #("decisionId", id.room_decision_json(saved.row.id)),
          #(
            "recommendation",
            decision_row.recommendation_to_json(recommendation),
          ),
          #("reasonCodes", json.array(codes, json.string)),
        ]),
      ],
      now,
    )
    |> storage,
  )
  use now_at <- result.try(reread(tx, a, room.row.id))
  case
    list.contains(
      [room_status.Archived, room_status.Closed, room_status.Withdrawn],
      now_at.status,
    )
  {
    True ->
      store.emit(
        tx,
        case_lifecycle.archived_event(room.row.org_id, room.row.id),
      )
    False -> Nil
  }
  use _ <- result.map(count(tx, "room_decision_recorded") |> storage)
  // The superseded predecessor is rewritten, so the decision reads back as stored.
  saved
}

// ------------------------------------------------------------------------------------------------- snapshots

/// `GET /org/rooms/:id/snapshots`: newest first.
pub fn snapshots(
  ctx: Ctx,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
) -> Response {
  store.read(ctx.store, fn(read) {
    use room <- result.try(find(read, a, room_id))
    use items <- result.map(
      room_records.snapshots(read, room.row.id) |> storage,
    )
    http.json(
      200,
      json.object([#("items", json.array(items, room_records.snapshot_json))]),
    )
  })
  |> read_answer
}

/// `GET /org/rooms/:id/activity`.
pub fn activity(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
) -> Response {
  use room <- with_room(ctx, a, room_id)
  http.json(
    200,
    room_rules.activity_json(room_rules.room_activity(
      cases.events(room),
      room_rules.clamp_page(query_value(req, "limit")),
      query_value(req, "cursor"),
    )),
  )
}

// -------------------------------------------------------------------------------------------------- comments

/// `GET /org/rooms/:id/comments`: newest first, by index cursor.
pub fn comments(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
) -> Response {
  store.read(ctx.store, fn(read) {
    use room <- result.try(find(read, a, room_id))
    use all <- result.try(room_records.comments(read, room.row.id) |> storage)
    let page =
      room_rules.after_cursor(
        room_view.newest_first(all),
        fn(c: room_records.Comment) { id.room_comment_to_string(c.row.id) },
        room_rules.clamp_page(query_value(req, "limit")),
        query_value(req, "cursor"),
      )
    use items <- result.map(
      list.try_map(page.items, room_view.comment_json(read, a.org.id, _))
      |> storage,
    )
    http.json(
      200,
      json.object([
        #("items", json.preprocessed_array(items)),
        #("nextCursor", json.nullable(page.next_cursor, json.string)),
        #("total", json.int(page.total)),
        #("note", json.string(room_rules.privacy_note)),
      ]),
    )
  })
  |> read_answer
}

type NewComment {
  NewComment(
    body: Option(String),
    reply_to: Option(String),
    mentions: Option(List(String)),
  )
}

/// `POST /org/rooms/:id/comments`. Mentions notify colleagues in this organisation only.
pub fn add_comment(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
) -> Response {
  use room <- with_room(ctx, a, room_id)
  use <- can(a, room, room_rules.Comment)
  use <- limited(
    ctx,
    limits.RoomComment,
    id.recruitment_case_to_string(room.row.id)
      <> ":"
      <> id.org_user_to_string(a.user.id),
  )
  let shape = {
    use body <- input.field(
      "body",
      input.nullish(input.text(room_rules.comment_body_max)),
    )
    use reply_to <- input.field("replyToId", input.nullish(input.id()))
    use mentions <- input.field(
      "mentions",
      input.nullish(input.items(input.id(), room_rules.mentions_per_comment)),
    )
    input.done(NewComment(body:, reply_to:, mentions:))
  }
  use body <- http.body(req, shape, [])
  case plain_text(body.body, room_rules.comment_body_max) {
    "" -> http.error(400, "ROOM_COMMENT_EMPTY")
    text -> {
      use <- moderated(ctx, a, Some(text), "recruitment_room_comment")
      let now = clock.now_ms()
      store.unit(ctx.store, fn(tx) {
        let read = store.reading(tx)
        use reply_to <- result.try(case body.reply_to {
          Some(r) -> {
            // A comment id from another room is a 404 here, not a cross-room reply.
            use parent <- result.try(
              room_records.comment(read, room.row.id, id.room_comment(r))
              |> storage,
            )
            case parent {
              Some(c) -> Ok(Some(c.row.id))
              None -> store.refuse(http.error(404, "ROOM_COMMENT_NOT_FOUND"))
            }
          }
          None -> Ok(None)
        })
        use mentions <- result.try(
          option.unwrap(body.mentions, [])
          |> list.unique
          |> list.try_map(fn(u) { colleague(read, a, u) })
          |> result.map(option.values),
        )
        let mention_ids = list.map(mentions, fn(m) { m.id })
        use saved <- result.try(
          room_records.add_comment(
            tx,
            room_records.NewComment(
              room_id: room.row.id,
              org_id: a.org.id,
              author: #(a.user.id, a.user.name),
              body: text,
              reply_to:,
              mentions: mention_ids,
              at: now,
            ),
          )
          |> storage,
        )
        use _ <- result.try(
          touched(
            tx,
            a,
            room,
            [
              cases.entry("room_comment_added", [
                #("commentId", id.room_comment_json(saved.row.id)),
                #("replyToId", json.nullable(reply_to, id.room_comment_json)),
              ]),
            ],
            now,
          )
          |> storage,
        )
        use _ <- result.try(
          list.try_each(mention_ids, fn(u) {
            case u == a.user.id {
              True -> Ok(Nil)
              False ->
                notify_staff(
                  tx,
                  u,
                  a.user.name
                    <> " mentioned you in the Recruitment Room for "
                    <> player_name(room)
                    <> ".",
                  room.row.id,
                  now,
                )
            }
          })
          |> storage,
        )
        use _ <- result.try(count(tx, "room_comment_added") |> storage)
        use view <- result.map(
          room_view.comment_json(read, a.org.id, saved) |> storage,
        )
        http.json(201, json.object([#("comment", view)]))
      })
      |> answer
    }
  }
}

fn own_comment(
  read: Read,
  room: Room,
  comment_id: String,
) -> Result(room_records.Comment, Fail(Response)) {
  use found <- result.try(
    room_records.comment(read, room.row.id, id.room_comment(comment_id))
    |> storage,
  )
  case found {
    Some(c) -> Ok(c)
    None -> store.refuse(http.error(404, "ROOM_COMMENT_NOT_FOUND"))
  }
}

/// `PATCH /org/rooms/:id/comments/:cid`: only the author edits, and a deleted comment stays deleted.
pub fn edit_comment(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
  comment_id: String,
) -> Response {
  use room <- with_room(ctx, a, room_id)
  let found = store.read(ctx.store, own_comment(_, room, comment_id))
  case found {
    Error(store.Refuse(r)) -> r
    Error(store.Storage(e)) -> http.internal(e)
    Error(store.Stale(what)) -> http.stale(what)
    Ok(c) if c.row.author_user_id != a.user.id ->
      http.error_message(
        403,
        "ROOM_COMMENT_NOT_AUTHOR",
        "Only the author can edit a comment.",
      )
    Ok(c) if c.row.deleted_at != None -> http.error(409, "ROOM_COMMENT_DELETED")
    Ok(c) -> {
      let shape = {
        use body <- input.field(
          "body",
          input.nullish(input.text(room_rules.comment_body_max)),
        )
        input.done(body)
      }
      use body <- http.body(req, shape, [])
      case plain_text(body, room_rules.comment_body_max) {
        "" -> http.error(400, "ROOM_COMMENT_EMPTY")
        text -> {
          use <- moderated(ctx, a, Some(text), "recruitment_room_comment")
          let now = clock.now_ms()
          store.unit(ctx.store, fn(tx) {
            use _ <- result.try(
              room_records.edit_comment(tx, c.row.id, text, now) |> storage,
            )
            use _ <- result.try(
              cases.record(
                tx,
                room.row.id,
                by(a),
                [
                  cases.entry("room_comment_edited", [
                    #("commentId", id.room_comment_json(c.row.id)),
                  ]),
                ],
                now,
              )
              |> storage,
            )
            use saved <- result.try(own_comment(
              store.reading(tx),
              room,
              comment_id,
            ))
            use view <- result.map(
              room_view.comment_json(store.reading(tx), a.org.id, saved)
              |> storage,
            )
            http.json(200, json.object([#("comment", view)]))
          })
          |> answer
        }
      }
    }
  }
}

/// `DELETE /org/rooms/:id/comments/:cid`: the author or a recruitment lead; tombstoned, never erased.
pub fn delete_comment(
  ctx: Ctx,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
  comment_id: String,
) -> Response {
  use room <- with_room(ctx, a, room_id)
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    use c <- result.try(own_comment(store.reading(tx), room, comment_id))
    use _ <- result.try(
      case c.row.author_user_id == a.user.id || access.is_lead(a.user) {
        True -> Ok(Nil)
        False -> store.refuse(http.error(403, "ROOM_COMMENT_NOT_AUTHOR"))
      },
    )
    use _ <- result.try(
      room_records.remove_comment(tx, c.row.id, #(a.user.id, a.user.name), now)
      |> storage,
    )
    use _ <- result.try(
      cases.record(
        tx,
        room.row.id,
        by(a),
        [
          cases.entry("room_comment_deleted", [
            #("commentId", id.room_comment_json(c.row.id)),
          ]),
        ],
        now,
      )
      |> storage,
    )
    use saved <- result.try(own_comment(store.reading(tx), room, comment_id))
    use view <- result.map(
      room_view.comment_json(store.reading(tx), a.org.id, saved) |> storage,
    )
    http.json(200, json.object([#("comment", view)]))
  })
  |> answer
}

// ----------------------------------------------------------------------------------------------------- tasks

type NewTask {
  NewTask(
    title: Option(String),
    description: Option(String),
    assignee: Option(String),
    linked_type: Option(task_row.LinkedResourceType),
    linked_id: Option(String),
    due: Option(Option(temporal.Due)),
  )
}

/// `POST /org/rooms/:id/tasks`: staff work only. A player-facing ask goes through the evidence-request or Combine
/// request workflow.
pub fn add_task(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
) -> Response {
  use room <- with_room(ctx, a, room_id)
  use <- can(a, room, room_rules.CreateTask)
  case list.length(room.tasks) >= room_rules.tasks_per_room {
    True -> http.error(409, "ROOM_TASKS_FULL")
    False -> {
      let shape = {
        use title <- input.field(
          "title",
          input.nullish(input.text(room_rules.task_title_max)),
        )
        use description <- input.field(
          "description",
          input.nullish(input.text(room_rules.task_description_max)),
        )
        use assignee <- input.field("assigneeUserId", input.nullish(input.id()))
        use linked_type <- input.field(
          "linkedResourceType",
          input.nullish(input.one_of(task_row.linked_resource_type_pairs)),
        )
        use linked_id <- input.field(
          "linkedResourceId",
          input.nullish(input.id()),
        )
        use due <- input.field("dueAt", input.optional(input.due_date()))
        input.done(NewTask(
          title:,
          description:,
          assignee:,
          linked_type:,
          linked_id:,
          due:,
        ))
      }
      use body <- http.body(req, shape, [])
      case plain_text(body.title, room_rules.task_title_max) {
        "" -> http.error(400, "ROOM_TASK_TITLE_REQUIRED")
        title -> {
          use <- moderated(ctx, a, Some(title), "recruitment_room_task")
          let description = case body.description {
            Some(_) ->
              some_text(plain_text(
                body.description,
                room_rules.task_description_max,
              ))
            None -> None
          }
          let now = clock.now_ms()
          store.unit(ctx.store, fn(tx) {
            use assignee <- result.try(case body.assignee {
              Some(u) -> {
                use found <- result.try(colleague(store.reading(tx), a, u))
                case found {
                  Some(s) -> Ok(Some(#(s.id, s.name)))
                  None -> store.refuse(http.error(404, "USER_NOT_IN_ORG"))
                }
              }
              None -> Ok(None)
            })
            use t <- result.try(
              cases.add_task(
                tx,
                room.row.id,
                cases.NewTask(
                  title:,
                  description:,
                  assignee:,
                  due: option.flatten(body.due),
                  linked_type: body.linked_type,
                  linked_id: case body.linked_type {
                    Some(_) -> body.linked_id
                    None -> None
                  },
                  created_by: #(a.user.id, a.user.name),
                  at: now,
                ),
              )
              |> storage,
            )
            use _ <- result.try(
              touched(
                tx,
                a,
                room,
                [
                  cases.entry("room_task_created", [
                    #("taskId", id.task_json(t.id)),
                    #(
                      "assigneeUserId",
                      json.nullable(t.assignee_user_id, id.org_user_json),
                    ),
                  ]),
                ],
                now,
              )
              |> storage,
            )
            use _ <- result.try(case assignee {
              Some(#(u, _)) if u != a.user.id ->
                notify_staff(
                  tx,
                  u,
                  a.user.name
                    <> " assigned you a task in the Recruitment Room for "
                    <> player_name(room)
                    <> ": "
                    <> title,
                  room.row.id,
                  now,
                )
                |> storage
              _ -> Ok(Nil)
            })
            use _ <- result.map(count(tx, "room_task_created") |> storage)
            http.json(201, json.object([#("task", room_view.task_json(t))]))
          })
          |> answer
        }
      }
    }
  }
}

type TaskEdit {
  TaskEdit(
    status: Option(task_state.TaskState),
    assignee: Option(Option(String)),
  )
}

/// `PATCH /org/rooms/:id/tasks/:tid`: the assignee, the creator or a room lead.
pub fn edit_task(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
  task_id: String,
) -> Response {
  use room <- with_room(ctx, a, room_id)
  case list.find(room.tasks, fn(t) { id.task_to_string(t.id) == task_id }) {
    Error(_) -> http.error(404, "ROOM_TASK_NOT_FOUND")
    Ok(t) -> {
      let role = room_view.role(a, room)
      let me = Some(a.user.id)
      let mine = t.assignee_user_id == me || t.created_by_user_id == me
      let may_assign = room_rules.room_can(role, room_rules.Assign)
      case mine || room_rules.room_can(role, room_rules.Assign) {
        False ->
          http.error_message(
            403,
            "ROOM_PERMISSION_REQUIRED",
            "Only the assignee, the creator or a room lead can change this task.",
          )
        True -> {
          let shape = {
            use status <- input.field(
              "status",
              input.optional(input.one_of(task_state.pairs)),
            )
            use assignee <- input.field(
              "assigneeUserId",
              input.clearable(input.id()),
            )
            input.done(TaskEdit(status:, assignee:))
          }
          use body <- http.body(req, shape, [
            #("status", "ROOM_TASK_STATE_UNKNOWN"),
          ])
          let moved = case body.status {
            Some(to) if to != t.status ->
              case room_rules.can_task_transition(t.status, to) {
                True -> Ok(Nil)
                False ->
                  Error(http.json(
                    409,
                    json.object([
                      #("error", json.string("ROOM_TASK_TRANSITION_INVALID")),
                      #("from", task_state.to_json(t.status)),
                      #("to", task_state.to_json(to)),
                    ]),
                  ))
              }
            _ -> Ok(Nil)
          }
          case moved {
            Error(r) -> r
            Ok(Nil) -> {
              let now = clock.now_ms()
              store.unit(ctx.store, fn(tx) {
                use assignee <- result.try(case body.assignee {
                  None -> Ok(None)
                  Some(_) if !may_assign ->
                    store.refuse(http.error(403, "ROOM_PERMISSION_REQUIRED"))
                  Some(None) -> Ok(Some(None))
                  Some(Some(u)) -> {
                    use found <- result.try(colleague(store.reading(tx), a, u))
                    case found {
                      Some(s) -> Ok(Some(Some(#(s.id, s.name))))
                      None -> store.refuse(http.error(404, "USER_NOT_IN_ORG"))
                    }
                  }
                })
                use _ <- result.try(
                  cases.update_task(
                    tx,
                    room.row.id,
                    t.id,
                    option.map(body.status, fn(s) {
                      #(s, case s {
                        task_state.Done -> Some(now)
                        _ -> None
                      })
                    }),
                    None,
                    assignee,
                  )
                  |> storage,
                )
                use _ <- result.try(
                  touched(
                    tx,
                    a,
                    room,
                    [
                      cases.entry("room_task_updated", [
                        #("taskId", id.task_json(t.id)),
                        #(
                          "status",
                          task_state.to_json(option.unwrap(
                            body.status,
                            t.status,
                          )),
                        ),
                      ]),
                    ],
                    now,
                  )
                  |> storage,
                )
                use fresh <- result.try(reread(tx, a, room.row.id))
                let assert Ok(saved) =
                  list.find(fresh.tasks, fn(x) { x.id == t.id })
                Ok(http.json(
                  200,
                  json.object([#("task", room_view.task_json(saved))]),
                ))
              })
              |> answer
            }
          }
        }
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------- decisions

type NewDecision {
  NewDecision(
    client_key: Option(Dynamic),
    recommendation: decision_row.Recommendation,
    reason_codes: Option(List(String)),
    note: Option(String),
  )
}

/// `POST /org/rooms/:id/decisions`: an advisory recommendation with its reasons and the evidence confidence the
/// club saw. Pinned to the room's revision, so two colleagues deciding at once get one decision and one conflict;
/// the same `clientKey` returns the same decision.
pub fn add_decision(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
) -> Response {
  use room <- with_room(ctx, a, room_id)
  use <- can(a, room, room_rules.RecordDecision)
  let shape = {
    use <- rev.fields
    use client_key <- input.field("clientKey", input.optional(input.anything()))
    use recommendation <- input.field(
      "recommendation",
      input.required(input.one_of(decision_row.recommendation_pairs)),
    )
    use reason_codes <- reason_codes_field
    // validateDecision judges the length, as ROOM_NOTE_TOO_LONG.
    use note <- input.field("note", input.nullish(input.text(1_000_000_000)))
    input.done(NewDecision(client_key:, recommendation:, reason_codes:, note:))
  }
  use body, raw <- body_of(
    req,
    shape,
    list.append(rev.codes, [
      #("recommendation", "ROOM_RECOMMENDATION_UNKNOWN"),
      reason_codes_code,
    ]),
  )
  case idempotency.client_key(body.client_key) {
    Error(message) ->
      http.error_message(400, "ROOM_CLIENT_KEY_INVALID", message)
    Ok(key) -> {
      let dup =
        store.read(ctx.store, fn(read) {
          use all <- result.map(room_records.decisions(read, room.row.id))
          case key {
            Some(k) ->
              list.find(all, fn(d) { d.row.client_key == Some(k) })
              |> option.from_result
            None -> None
          }
        })
      case dup {
        Error(e) -> http.internal(e)
        Ok(Some(d)) -> {
          let codes_of = fn(xs) {
            xs |> list.unique |> list.sort(string.compare) |> string.join(",")
          }
          let same =
            d.row.kind != Some(decision_row.Formal)
            && d.row.recommendation == body.recommendation
            && codes_of(d.reason_codes)
            == codes_of(option.unwrap(body.reason_codes, []))
          case same {
            False ->
              http.error_message(
                409,
                "DECISION_IDEMPOTENCY_CONFLICT",
                "This clientKey was already used for a different decision.",
              )
            True ->
              http.json(
                200,
                json.object([
                  #("decision", room_records.decision_json(d)),
                  #("idempotent", json.bool(True)),
                ]),
              )
          }
        }
        Ok(None) -> {
          use expected <- rev_or_refuse(raw)
          use <- rev.guard(
            expected,
            room_view.rev_of(room),
            "ROOM_VERSION_CONFLICT",
            [
              #(
                "current",
                json.object([
                  #("status", room_status.to_json(room.status)),
                  #("updatedAt", json.int(room.updated_at)),
                ]),
              ),
            ],
          )
          case
            room_rules.validate_decision(
              body.recommendation,
              option.unwrap(body.reason_codes, []),
              body.note,
            )
          {
            Error(refusal) ->
              http.json(
                400,
                json.object(room_rules.decision_refusal_fields(refusal)),
              )
            Ok(check) -> {
              let note = case check.note {
                Some(_) -> some_text(plain_text(check.note, note_max))
                None -> None
              }
              use <- moderated(ctx, a, note, "recruitment_room_decision")
              let now = clock.now_ms()
              store.unit(ctx.store, fn(tx) {
                use room <- result.try(still_at(tx, a, room))
                use snapshot <- result.try(
                  room_view.capture_snapshot(
                    tx,
                    a.org,
                    room,
                    "decision",
                    now,
                    ctx.config.box_cam_test_provider,
                  )
                  |> storage,
                )
                use d <- result.try(record_decision(
                  tx,
                  a,
                  room,
                  check.recommendation,
                  check.codes,
                  note,
                  snapshot,
                  "decision",
                  key,
                  now,
                ))
                use _ <- result.try(
                  cases.touch(tx, room.row.id, now) |> storage,
                )
                use _ <- result.try(
                  cases.bump(
                    tx,
                    room.row.id,
                    now,
                    Some(id.org_user_to_string(a.user.id)),
                    Some(a.user.name),
                  )
                  |> storage,
                )
                use fresh <- result.map(reread(tx, a, room.row.id))
                http.json(
                  201,
                  json.object([
                    #("decision", room_records.decision_json(d)),
                    #(
                      "snapshot",
                      json.nullable(snapshot, room_records.snapshot_json),
                    ),
                    #("rev", json.int(fresh.rev)),
                  ]),
                )
              })
              |> answer
            }
          }
        }
      }
    }
  }
}

/// `GET /org/rooms/:id/decisions`: append-only; a revision supersedes its predecessor.
pub fn decisions(
  ctx: Ctx,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
) -> Response {
  store.read(ctx.store, fn(read) {
    use room <- result.try(find(read, a, room_id))
    use history <- result.map(
      room_records.decisions(read, room.row.id) |> storage,
    )
    http.json(
      200,
      json.object([
        #(
          "current",
          json.nullable(
            list.last(history) |> option.from_result,
            room_records.decision_json,
          ),
        ),
        #("history", json.array(history, room_records.decision_json)),
        #(
          "taxonomy",
          json.object([
            #(
              "categories",
              json.object(
                list.map(room_rules.reason_codes, fn(c) {
                  #(c.0, json.array(c.1, json.string))
                }),
              ),
            ),
            #(
              "recommendations",
              json.array(
                room_rules.recommendations(),
                decision_row.recommendation_to_json,
              ),
            ),
          ]),
        ),
        #(
          "note",
          json.string(
            "Decisions are append-only. A revision supersedes its predecessor; nothing is rewritten.",
          ),
        ),
      ]),
    )
  })
  |> read_answer
}

// ------------------------------------------------------------------------------------------- evidence review

type EvidenceReview {
  EvidenceReview(state: review_row.State, note: Option(String))
}

/// `POST /org/rooms/:id/evidence/:eid/review`: the review belongs to the Room; the player's record is untouched.
pub fn review_evidence(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
  evidence_id: String,
) -> Response {
  use room <- with_room(ctx, a, room_id)
  use <- can(a, room, room_rules.Comment)
  let shape = {
    use state <- input.field(
      "state",
      input.required(input.one_of(review_row.state_pairs)),
    )
    use note <- input.field(
      "note",
      input.nullish(input.text(evidence_note_max)),
    )
    input.done(EvidenceReview(state:, note:))
  }
  use body <- http.body(req, shape, [#("state", "ROOM_EVIDENCE_STATE_UNKNOWN")])
  let found =
    store.read(ctx.store, fn(read) {
      evidence.by_id(read, id.scouting_evidence(evidence_id))
    })
  case found {
    Error(e) -> http.internal(e)
    Ok(Some(e)) if e.row.player_id == room.row.player_id -> {
      let note = case body.note {
        Some(_) -> some_text(plain_text(body.note, evidence_note_max))
        None -> None
      }
      use <- moderated(ctx, a, note, "recruitment_room_evidence_note")
      let now = clock.now_ms()
      store.unit(ctx.store, fn(tx) {
        use existing <- result.try(
          room_records.reviews(store.reading(tx), room.row.id) |> storage,
        )
        let existing =
          list.find(existing, fn(r) { r.evidence_id == evidence_id })
          |> option.from_result
        use saved <- result.try(
          room_records.review(
            tx,
            existing,
            room.row.id,
            a.org.id,
            evidence_id,
            body.state,
            note,
            #(a.user.id, a.user.name),
            now,
          )
          |> storage,
        )
        use _ <- result.map(
          touched(
            tx,
            a,
            room,
            [
              cases.entry("room_evidence_reviewed", [
                #("evidenceId", json.string(evidence_id)),
                #("state", review_row.state_to_json(body.state)),
              ]),
            ],
            now,
          )
          |> storage,
        )
        http.json(
          200,
          json.object([
            #(
              "review",
              json.object([
                #("evidenceId", json.string(evidence_id)),
                #("state", review_row.state_to_json(saved.state)),
                #("note", json.nullable(saved.note, json.string)),
                #("by", json.nullable(saved.by_name, json.string)),
                #("at", json.int(saved.at)),
              ]),
            ),
            #(
              "note",
              json.string(
                "Internal review state only — the evidence record itself is unchanged.",
              ),
            ),
          ]),
        )
      })
      |> answer
    }
    Ok(_) -> http.error(404, "EVIDENCE_NOT_FOUND")
  }
}

// ------------------------------------------------------------------------------------------------- bridges

type AssessmentAssignment {
  AssessmentAssignment(
    user_id: String,
    kind: Option(String),
    due: Option(Option(temporal.Due)),
  )
}

/// `POST /org/rooms/:id/assessment-assignments`: an assessment as a named piece of work on the room.
pub fn assign_assessment(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
) -> Response {
  use room <- with_room(ctx, a, room_id)
  use <- can(a, room, room_rules.Assign)
  let shape = {
    use user_id <- input.field("userId", input.required(input.id()))
    use kind <- input.field(
      "kind",
      input.nullish(input.text(assessment_kind_max)),
    )
    use due <- input.field("dueAt", input.optional(input.due_date()))
    input.done(AssessmentAssignment(user_id:, kind:, due:))
  }
  use body <- http.body(req, shape, [])
  let kind = case plain_text(body.kind, assessment_kind_max) {
    "" -> "Assessment"
    k -> k
  }
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    use found <- result.try(colleague(store.reading(tx), a, body.user_id))
    use u <- result.try(case found {
      Some(u) -> Ok(u)
      None -> store.refuse(http.error(404, "USER_NOT_IN_ORG"))
    })
    use assignment <- result.try(
      cases.add_assignment(
        tx,
        room.row.id,
        #(u.id, u.name),
        kind <> " assessment",
        option.flatten(body.due),
        now,
      )
      |> storage,
    )
    use _ <- result.try(
      touched(
        tx,
        a,
        room,
        [
          cases.entry("room_assessment_assigned", [
            #("assignmentId", id.assignment_json(assignment.id)),
            #("userId", id.org_user_json(u.id)),
            #("kind", json.string(kind)),
          ]),
        ],
        now,
      )
      |> storage,
    )
    use _ <- result.try(case u.id != a.user.id {
      True ->
        notify_staff(
          tx,
          u.id,
          a.user.name
            <> " assigned you a "
            <> string.lowercase(kind)
            <> " assessment for "
            <> player_name(room)
            <> ".",
          room.row.id,
          now,
        )
        |> storage
      False -> Ok(Nil)
    })
    use _ <- result.map(count(tx, "room_assessment_assigned") |> storage)
    http.json(
      201,
      json.object([
        #(
          "assignment",
          json.object([
            #("id", id.assignment_json(assignment.id)),
            #("userId", id.org_user_json(u.id)),
            #("name", json.string(u.name)),
            #("task", json.string(assignment.task)),
            #("dueAt", cases.due_json(assignment.due_day, assignment.due_at)),
            #("status", task_state.to_json(assignment.status)),
            #("createdAt", json.int(assignment.created_at)),
          ]),
        ),
      ]),
    )
  })
  |> answer
}

/// `POST /org/rooms/:id/evidence-requests`: through the evidence-request rules. There is no free text: a scout's
/// own words never reach a player or guardian from a private room, only the rule's wording.
pub fn request_evidence(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
) -> Response {
  use room <- with_room(ctx, a, room_id)
  use <- can(a, room, room_rules.RequestEvidence)
  let shape = {
    use suggestion_id <- input.field("suggestionId", input.required(input.id()))
    input.done(suggestion_id)
  }
  use suggestion_id <- http.body(req, shape, [])
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    use out <- result.try(
      evidence_gaps.request(
        tx,
        a.org,
        id.evidence_suggestion(suggestion_id),
        Some(room.row.player_id),
        now,
      )
      |> storage,
    )
    case out {
      Error(refusal) -> Ok(evidence_gaps.refusal_response(refusal))
      Ok(#(s, routed)) -> {
        use _ <- result.try(
          touched(
            tx,
            a,
            room,
            [
              cases.entry("room_evidence_requested", [
                #("suggestionId", json.string(suggestion_id)),
                #("ruleId", suggestion_row.rule_id_to_json(s.row.rule_id)),
                #("routedTo", party.to_json(routed)),
              ]),
            ],
            now,
          )
          |> storage,
        )
        use _ <- result.map(count(tx, "room_evidence_requested") |> storage)
        http.json(
          201,
          json.object([
            #("suggestion", evidence_gaps.view(s)),
            #("routedTo", party.to_json(routed)),
            #(
              "note",
              json.string(
                "Routed through the standing evidence-request rules, including guardian routing for under-18s.",
              ),
            ),
          ]),
        )
      }
    }
  })
  |> answer
}

type CombineRequest {
  CombineRequest(
    protocol_ids: Option(List(String)),
    title: Option(String),
    deadline: Option(Option(String)),
    instructions: Option(String),
  )
}

/// `POST /org/rooms/:id/combine-requests`: standardised protocols from the registry, which a room can neither
/// invent nor change, through the Combine's own creator.
pub fn request_combine(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
) -> Response {
  use room <- with_room(ctx, a, room_id)
  use <- can(a, room, room_rules.RequestCombine)
  case a.org.type_, a.org.verified {
    org_type.Agency, _ -> http.error(403, "AGENCY_NOT_ELIGIBLE")
    _, False ->
      http.error_message(
        403,
        "ORG_NOT_ELIGIBLE",
        "Only a verified organisation can create a Club Combine.",
      )
    _, True -> {
      use <- limited(ctx, limits.RoomCombineRequest, id.org_to_string(a.org.id))
      let shape = {
        use protocol_ids <- input.field(
          "protocolIds",
          input.nullish(input.items(input.id(), combine_protocols_max * 5)),
        )
        use title <- input.field(
          "title",
          input.nullish(input.text(combine_title_max)),
        )
        use deadline <- input.field(
          "deadline",
          input.nullish(input.day_or_blank()),
        )
        use instructions <- input.field(
          "instructions",
          input.nullish(input.text(combine_instructions_max)),
        )
        input.done(CombineRequest(
          protocol_ids:,
          title:,
          deadline:,
          instructions:,
        ))
      }
      use body <- http.body(req, shape, [])
      // Duplicates are dropped before the protocol count is judged.
      let ids = list.unique(option.unwrap(body.protocol_ids, []))
      case ids, list.length(ids) > combine_protocols_max {
        [], _ -> http.error(400, "PROTOCOLS_REQUIRED")
        _, True ->
          http.json(
            400,
            json.object([
              #("error", json.string("FIELD_INVALID")),
              #("field", json.string("protocolIds")),
              #("problem", json.string("too_long")),
              #("max", json.int(combine_protocols_max)),
              #(
                "message",
                json.string(
                  "A Club Combine asks for at most "
                  <> int.to_string(combine_protocols_max)
                  <> " protocols.",
                ),
              ),
            ]),
          )
        _, False ->
          case list.find(ids, fn(pid) { !combine.protocol_active(pid) }) {
            Ok(unknown) ->
              http.json(
                404,
                json.object([
                  #("error", json.string("PROTOCOL_UNKNOWN")),
                  #("protocolId", json.string(unknown)),
                ]),
              )
            Error(_) -> {
              let instructions =
                option.unwrap(body.instructions, "") |> string.trim |> some_text
              use <- moderated(ctx, a, instructions, "combine_request")
              let now = clock.now_ms()
              store.unit(ctx.store, fn(tx) {
                use found <- result.try(
                  players.for_org(
                    store.reading(tx),
                    room.row.player_id,
                    a.org,
                    now,
                  )
                  |> storage,
                )
                case found {
                  Some(#(p, access)) if access.visible && !access.blocked -> {
                    use r <- result.try(
                      combine.create(
                        tx,
                        a.org,
                        a.user,
                        p,
                        combine.NewRequest(
                          protocol_ids: ids,
                          title: option.unwrap(body.title, "")
                            |> string.trim
                            |> input.utf16_take(combine_title_max)
                            |> some_text,
                          deadline: option.flatten(body.deadline),
                          instructions: option.map(
                            instructions,
                            input.utf16_take(_, combine_instructions_max),
                          ),
                        ),
                        now,
                      )
                      |> storage,
                    )
                    use _ <- result.try(
                      touched(
                        tx,
                        a,
                        room,
                        [
                          cases.entry("room_combine_requested", [
                            #("requestId", id.combine_request_json(r.row.id)),
                            #("protocols", json.array(ids, json.string)),
                          ]),
                        ],
                        now,
                      )
                      |> storage,
                    )
                    use _ <- result.map(
                      count(tx, "room_combine_requested") |> storage,
                    )
                    http.json(
                      201,
                      json.object([#("request", combine.request_view(r))]),
                    )
                  }
                  // A request doesn't widen access.
                  other ->
                    Ok(http.json(
                      409,
                      json.object([
                        #("error", json.string("NOT_VISIBLE")),
                        #(
                          "skipped",
                          json.preprocessed_array([
                            json.object([
                              #("playerId", id.player_json(room.row.player_id)),
                              #(
                                "reason",
                                json.string(case other {
                                  Some(_) -> "NOT_VISIBLE"
                                  None -> "PLAYER_NOT_FOUND"
                                }),
                              ),
                            ]),
                          ]),
                        ),
                      ]),
                    ))
                }
              })
              |> answer
            }
          }
      }
    }
  }
}

type RoomLinks {
  RoomLinks(
    trial: Option(String),
    signing: Option(String),
    request: Option(String),
  )
}

/// `POST /org/rooms/:id/link`: trials, contact requests and signings are created by their own workflows; the room
/// only links them, each of this club and this player.
pub fn link(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
) -> Response {
  use room <- with_room(ctx, a, room_id)
  use <- can(a, room, room_rules.Assign)
  let shape = {
    use trial <- input.field("trialId", input.nullish(input.id()))
    use signing <- input.field("signingId", input.nullish(input.id()))
    use request <- input.field("requestId", input.nullish(input.id()))
    input.done(RoomLinks(trial:, signing:, request:))
  }
  use body <- http.body(req, shape, [])
  let now = clock.now_ms()
  let ours = fn(org_id, player_id) {
    org_id == a.org.id && player_id == room.row.player_id
  }
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use trial <- result.try(case body.trial {
      Some(t) -> {
        use found <- result.try(trials.by_id(read, id.trial(t)) |> storage)
        case found {
          Some(t)
            if t.row.org_id == a.org.id && t.row.player_id == room.row.player_id
          -> Ok(Some(t.row))
          _ -> store.refuse(http.error(404, "TRIAL_NOT_FOUND"))
        }
      }
      None -> Ok(None)
    })
    use request <- result.try(case body.request {
      Some(q) -> {
        use found <- result.try(requests.by_id(read, id.request(q)) |> storage)
        case found {
          Some(r) ->
            case ours(r.org_id, r.player_id) {
              True -> Ok(Some(r))
              False -> store.refuse(http.error(404, "REQUEST_NOT_FOUND"))
            }
          None -> store.refuse(http.error(404, "REQUEST_NOT_FOUND"))
        }
      }
      None -> Ok(None)
    })
    use signing <- result.try(case body.signing {
      Some(s) -> {
        use found <- result.try(signings.by_id(read, id.signing(s)) |> storage)
        case found {
          Some(r) ->
            case ours(r.org_id, r.player_id) {
              True -> Ok(Some(r))
              False -> store.refuse(http.error(404, "SIGNING_NOT_FOUND"))
            }
          None -> store.refuse(http.error(404, "SIGNING_NOT_FOUND"))
        }
      }
      None -> Ok(None)
    })
    use _ <- result.try(
      cases.link(
        tx,
        room.row.id,
        option.map(trial, fn(t) { t.id }),
        option.map(request, fn(r) { r.id }),
        option.map(signing, fn(s) { id.signing_to_string(s.id) }),
      )
      |> storage,
    )
    let entries =
      option.values([
        option.map(trial, fn(t) {
          cases.entry("room_trial_linked", [
            #("trialId", id.trial_json(t.id)),
            #("status", trial_row.status_to_json(t.status)),
          ])
        }),
        option.map(signing, fn(s) {
          cases.entry("room_signing_linked", [
            #("signingId", id.signing_json(s.id)),
          ])
        }),
      ])
    use _ <- result.try(touched(tx, a, room, entries, now) |> storage)
    use _ <- result.try(case trial {
      Some(_) -> count(tx, "room_trial_requested") |> storage
      None -> Ok(None) |> result.replace(Nil)
    })
    use fresh <- result.map(reread(tx, a, room.row.id))
    http.json(200, json.object([#("links", room_view.links(fresh))]))
  })
  |> answer
}

// ------------------------------------------------------------------------------------------------ the funnel

/// `GET /org/rooms-funnel`: the organisation's own; there is no cross-club league table.
pub fn funnel(ctx: Ctx, a: OrgAccess) -> Response {
  case store.read(ctx.store, cases.status_counts(_, a.org.id, None)) {
    Ok(counts) -> http.json(200, room_rules.funnel_from_counts(counts))
    Error(e) -> http.internal(e)
  }
}

/// `GET /admin/rooms/overview`: platform counts only, nothing from inside any room.
pub fn admin_overview(ctx: Ctx) -> Response {
  let found =
    store.read(ctx.store, fn(read) {
      use rooms <- result.try(cases.room_count(read))
      use #(comments, decisions, snapshots) <- result.map(room_records.counts(
        read,
      ))
      json.object([
        #("rooms", json.int(rooms)),
        #("comments", json.int(comments)),
        #("decisions", json.int(decisions)),
        #("snapshots", json.int(snapshots)),
        #(
          "note",
          json.string(
            "Recruitment Rooms are private to the organisation that owns them. Trust & Safety has no routine read access to their contents — an investigation needs an explicit, audited, reasoned support grant.",
          ),
        ),
      ])
    })
  case found {
    Ok(body) -> http.json(200, body)
    Error(e) -> http.internal(e)
  }
}
