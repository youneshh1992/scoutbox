//// The Box Cam development plan (training.mjs `developmentPlan`): a player's development objectives with the Box
//// Training set against each, every assignment that stands, and the last 30 days of recorded activity, which is the
//// Passport's own summary. Completing sessions never closes an objective.

import gleam/json.{type Json}
import gleam/list
import gleam/option.{None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/development/box_cam_rules as box_rules
import scoutbox/development/box_training
import scoutbox/development/objectives
import scoutbox/identity/access.{type PlayerAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/orgs
import scoutbox/identity/players
import scoutbox/passport/sources
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/recruitment/room_routes
import scoutbox/rows/box_assignments as assignment_row
import scoutbox/rows/dev_objectives as objective_row
import scoutbox/rows/id
import wisp.{type Response}

const note =
  "Completing sessions never automatically marks a development objective achieved — objectives close through their own existing flow."

/// `GET /player/box-cam/development-plan`.
pub fn player_plan(ctx: Ctx, p: PlayerAccess) -> Response {
  store.read(ctx.store, fn(read) {
    plan(read, p.player.row.id) |> room_routes.storage
  })
  |> room_routes.read_answer
}

/// `GET /guardian/children/:id/box-cam/development-plan`.
pub fn child_plan(ctx: Ctx, g: Guardian, child: id.PlayerId) -> Response {
  case list.contains(g.child_ids, child) {
    False -> http.error(404, "CHILD_NOT_FOUND")
    True ->
      store.read(ctx.store, fn(read) {
        use found <- result.try(
          players.by_id(read, child) |> room_routes.storage,
        )
        case found {
          None -> Ok(http.error(404, "PLAYER_NOT_FOUND"))
          Some(_) -> plan(read, child) |> room_routes.storage
        }
      })
      |> room_routes.read_answer
  }
}

fn plan(read: Read, pid: id.PlayerId) -> Result(Response, Fail(e)) {
  use mine <- result.try(objectives.for_player(read, pid))
  use box <- result.try(sources.box_cam(read, pid))
  let standing =
    list.filter(box.assignments, fn(a) { a.state != assignment_row.Cancelled })
  use views <- result.try(
    list.try_map(standing, fn(a) {
      box_training.assignment_view(read, a)
      |> result.map(fn(view) { #(a.objective_id, view) })
    }),
  )
  use objective_views <- result.map(
    list.try_map(mine, objective_json(read, _, views)),
  )
  http.json(
    200,
    json.object([
      #("objectives", json.preprocessed_array(objective_views)),
      #("assignments", json.preprocessed_array(list.map(views, fn(v) { v.1 }))),
      #(
        "activity",
        box_rules.activity_json(
          sources.box_activity(box, clock.now_ms()),
          box_rules.dev_activity_note,
        ),
      ),
      #("note", json.string(note)),
    ]),
  )
}

fn objective_json(
  read: Read,
  o: objectives.Objective,
  assignments: List(#(option.Option(id.ObjectiveId), Json)),
) -> Result(Json, Fail(e)) {
  let r = o.row
  use org <- result.map(orgs.by_id(read, r.org_id))
  let mine = Some(r.id)
  json.object([
    #("id", id.objective_json(r.id)),
    #("orgId", id.org_json(r.org_id)),
    #(
      "orgName",
      json.nullable(option.map(org, fn(org) { org.name }), json.string),
    ),
    #("status", objective_row.status_to_json(r.status)),
    #("createdAt", json.int(r.created_at)),
    #("objectives", json.array(o.items, fn(i) { json.string(i.row.text) })),
    #(
      "assignments",
      json.preprocessed_array(
        list.filter_map(assignments, fn(a) {
          case a.0 == mine {
            True -> Ok(a.1)
            False -> Error(Nil)
          }
        }),
      ),
    ),
  ])
}
