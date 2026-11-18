//// The drill library's guidance (domains/development/objectives.mjs): how to film each drill, and whether a named
//// reviewer has checked it. A drill counts as reviewed only once someone named reviewed it, and the player is told
//// honestly when it hasn't been.

import gleam/dict
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import scoutbox/app.{type Ctx}
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/rows/drill_guidance as row
import sqlight
import wisp.{type Request, type Response}

/// The drills' ids, in the library's order (record.mjs `DRILLS`; spec_test proves they agree).
pub const drill_ids = [
  "drill-sprint-ladder", "drill-passing-gates", "drill-shooting-arc",
  "drill-first-touch",
]

/// How every drill is filmed (objectives.mjs `DRILL_RECORDING`), as `#(key, text)` in its key order.
pub const recording = [
  #("equipment", "Any phone camera ≥ 720p"),
  #("distance", "Full drill area in frame"),
  #("surface", "Flat grass or turf"),
  #("camera", "Fixed position, side-on, no zooming during the attempt"),
]

const default_reviewer = "T&S football staff"

const reviewer_max = 60

fn reviews(read: Read) -> Result(List(row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT " <> row.columns <> " FROM drill_guidance ORDER BY rowid",
    [],
    row.decoder(),
  )
}

fn view(drill_id: String, review: Option(row.Row)) -> Json {
  json.object([
    #("drillId", json.string(drill_id)),
    #(
      "recording",
      json.object(list.map(recording, fn(r) { #(r.0, json.string(r.1)) })),
    ),
    #("coachReview", case review {
      Some(r) ->
        json.object([
          #("status", json.string("reviewed")),
          #("reviewer", json.string(r.reviewer)),
          #("at", json.int(r.reviewed_at)),
        ])
      None ->
        json.object([
          #("status", json.string("unreviewed")),
          #("reviewer", json.null()),
          #("at", json.null()),
        ])
    }),
  ])
}

fn guidance(ctx: Ctx, next: fn(Json) -> Response) -> Response {
  case store.read(ctx.store, reviews) {
    Error(failure) -> http.internal(failure)
    Ok(rows) -> {
      let by_drill = dict.from_list(list.map(rows, fn(r) { #(r.drill_id, r) }))
      next(
        json.array(drill_ids, fn(d) {
          view(d, dict.get(by_drill, d) |> option.from_result)
        }),
      )
    }
  }
}

/// `GET /player/drill-guidance`.
pub fn player_list(ctx: Ctx) -> Response {
  use items <- guidance(ctx)
  http.json(
    200,
    json.object([
      #("items", items),
      #(
        "note",
        json.string(
          "Coach review status is shown honestly — \"unreviewed\" guidance has not been validated by a professional.",
        ),
      ),
    ]),
  )
}

/// `GET /admin/drill-guidance`.
pub fn admin_list(ctx: Ctx) -> Response {
  use items <- guidance(ctx)
  http.json(200, json.object([#("items", items)]))
}

/// `POST /admin/drill-guidance/:drillId/review`: a named review, replacing any earlier one.
pub fn review(ctx: Ctx, req: Request, drill_id: String) -> Response {
  let shape = {
    use reviewer <- input.field(
      "reviewer",
      input.nullish(input.text(reviewer_max)),
    )
    input.done(reviewer)
  }
  use reviewer <- http.body(req, shape, [])
  case list.contains(drill_ids, drill_id) {
    False -> http.error(404, "DRILL_NOT_FOUND")
    True -> {
      let r =
        row.new(
          drill_id:,
          reviewer: input.filled(reviewer) |> option.unwrap(default_reviewer),
          reviewed_at: clock.now_ms(),
        )
      let saved =
        store.unit(ctx.store, fn(tx) {
          store.run(
            tx,
            "INSERT INTO drill_guidance (drill_id, reviewer, reviewed_at) VALUES (?, ?, ?) ON CONFLICT (drill_id) DO UPDATE SET reviewer = excluded.reviewer, reviewed_at = excluded.reviewed_at",
            [
              sqlight.text(r.drill_id),
              sqlight.text(r.reviewer),
              sqlight.int(r.reviewed_at),
            ],
          )
        })
      case saved {
        Ok(Nil) ->
          http.json(200, json.object([#("guidance", view(drill_id, Some(r)))]))
        Error(failure) -> http.internal(failure)
      }
    }
  }
}
