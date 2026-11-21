//// A player's Box Cam privacy preferences (domains/development/boxcam/training.mjs `applyPrefs`): whether their
//// development activity is shared for recruitment (the Combine consent rule reads it), and whether clips are
//// kept. An adult sets their own; a child's are the guardian's.
////
//// Not ported yet: the ledger row's detail.

import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type PlayerAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/players
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/recruitment/room_routes
import scoutbox/rows/box_cam_prefs as row
import scoutbox/rows/id
import scoutbox/rows/ledger as ledger_row
import scoutbox/safety/ledger
import scoutbox/vocab/party
import sqlight
import wisp.{type Request, type Response}

/// A player's preferences, or the defaults when none are stored (nothing shared, no clips kept).
fn prefs_for(read: Read, player_id: id.PlayerId) -> Result(row.Row, Fail(e)) {
  use found <- result.map(store.one(
    read,
    "SELECT " <> row.columns <> " FROM box_cam_prefs WHERE player_id = ?",
    [id.player_sql(player_id)],
    row.decoder(),
  ))
  case found {
    Ok(r) -> r
    Error(_) ->
      row.new(
        player_id: player_id,
        share_development_activity: row.Private,
        retain_clips: False,
      )
  }
}

/// Whether a player's Box Clips may be kept (a guardian's choice for a child).
pub fn retains_clips(
  read: Read,
  player_id: id.PlayerId,
) -> Result(Bool, Fail(e)) {
  prefs_for(read, player_id) |> result.map(fn(r) { r.retain_clips })
}

fn view(r: row.Row) -> Json {
  json.object([
    #(
      "prefs",
      json.object([
        #("playerId", id.player_json(r.player_id)),
        #(
          "shareDevelopmentActivity",
          row.share_development_activity_to_json(r.share_development_activity),
        ),
        #("retainClips", json.bool(r.retain_clips)),
        #("updatedAt", json.nullable(r.updated_at, json.int)),
        #("updatedBy", case r.updated_by_kind, r.updated_by_id {
          Some(kind), Some(who) ->
            json.object([
              #("kind", party.to_json(kind)),
              #("id", json.string(who)),
            ])
          _, _ -> json.null()
        }),
      ]),
    ),
  ])
}

/// `GET /player/box-cam/prefs`.
pub fn show(ctx: Ctx, p: PlayerAccess) -> Response {
  case store.read(ctx.store, prefs_for(_, p.player.row.id)) {
    Ok(r) -> http.json(200, view(r))
    Error(e) -> http.internal(e)
  }
}

type Body {
  Body(share: Option(row.ShareDevelopmentActivity), retain_clips: Option(Bool))
}

fn apply(
  ctx: Ctx,
  req: Request,
  player_id: id.PlayerId,
  by: party.Party,
  by_id: String,
) -> Response {
  let shape = {
    use share <- input.field(
      "shareDevelopmentActivity",
      input.optional(input.one_of(row.share_development_activity_pairs)),
    )
    use retain_clips <- input.field(
      "retainClips",
      input.optional(input.boolean()),
    )
    input.done(Body(share:, retain_clips:))
  }
  use b <- http.body(req, shape, [
    #("shareDevelopmentActivity", "SHARE_INVALID"),
  ])
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    use current <- result.try(
      prefs_for(store.reading(tx), player_id) |> room_routes.storage,
    )
    let next =
      row.Row(
        player_id: player_id,
        share_development_activity: option.unwrap(
          b.share,
          current.share_development_activity,
        ),
        retain_clips: option.unwrap(b.retain_clips, current.retain_clips),
        updated_at: Some(now),
        updated_by_kind: Some(by),
        updated_by_id: Some(by_id),
      )
    use _ <- result.try(
      store.run(
        tx,
        "INSERT INTO box_cam_prefs (player_id, share_development_activity, retain_clips, updated_at, updated_by_kind, updated_by_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (player_id) DO UPDATE SET share_development_activity = excluded.share_development_activity, retain_clips = excluded.retain_clips, updated_at = excluded.updated_at, updated_by_kind = excluded.updated_by_kind, updated_by_id = excluded.updated_by_id",
        [
          id.player_sql(next.player_id),
          sqlight.text(row.share_development_activity_to_string(
            next.share_development_activity,
          )),
          sqlight.bool(next.retain_clips),
          sqlight.int(now),
          sqlight.text(party.to_string(by)),
          sqlight.text(by_id),
        ],
      )
      |> room_routes.storage,
    )
    use _ <- result.map(
      ledger.append(
        tx,
        ledger.Entry(
          entry_type: ledger_row.BoxPrefsChanged,
          player_id: Some(player_id),
          org_id: None,
          org_name: None,
          user_id: None,
          actor_name: None,
        ),
        now,
      )
      |> room_routes.storage,
    )
    http.json(200, view(next))
  })
  |> room_routes.answer
}

/// `PATCH /player/box-cam/prefs`: an adult's own.
pub fn update(ctx: Ctx, req: Request, p: PlayerAccess) -> Response {
  case players.is_adult(p.player, clock.now_ms()) {
    False ->
      http.error_message(
        403,
        "GUARDIAN_MANAGED",
        "Your parent/guardian manages Box Cam privacy settings.",
      )
    True ->
      apply(
        ctx,
        req,
        p.player.row.id,
        party.Player,
        id.player_to_string(p.player.row.id),
      )
  }
}

/// `PATCH /guardian/children/:id/box-cam/prefs`.
pub fn update_child(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  child: id.PlayerId,
) -> Response {
  case list.contains(g.child_ids, child) {
    False -> http.error(404, "CHILD_NOT_FOUND")
    True ->
      apply(ctx, req, child, party.Guardian, id.guardian_to_string(g.row.id))
  }
}
