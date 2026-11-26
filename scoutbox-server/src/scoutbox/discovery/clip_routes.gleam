//// A club's views and scout tags on a player's clip (domains/discovery/filmRoom.mjs). Tags are structured, never free
//// text, and counted for the player without saying which club gave them; each tagging is a row in the club's
//// Discovery Ledger. Only a club that may see the player, and isn't blocked, reaches the clip.

import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/option.{Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/players.{type Media, type Player}
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/live_pings
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/id
import scoutbox/rows/ledger as ledger_row
import scoutbox/rows/player_media_tags as tag_row
import scoutbox/safety/ledger
import sqlight
import wisp.{type Request, type Response}

/// filmRoom.mjs `SCOUT_TAGS`, in its order.
pub const scout_tags = [
  "first_touch", "pace", "positioning", "work_rate", "left_foot", "right_foot",
  "aerial", "composure", "vision", "pressing", "finishing", "distribution",
]

/// `GET /org/tags`.
pub fn tags(_ctx: Ctx) -> Response {
  http.json(200, json.array(scout_tags, json.string))
}

fn visible_clip(
  ctx: Ctx,
  a: OrgAccess,
  player_id: id.PlayerId,
  media_id: id.MediaId,
  next: fn(Player, Media) -> Response,
) -> Response {
  case
    store.read(ctx.store, players.for_org(_, player_id, a.org, clock.now_ms()))
  {
    Error(failure) -> http.internal(failure)
    Ok(Some(#(p, access))) if access.visible && !access.blocked ->
      case list.find(p.media, fn(m) { m.clip.id == media_id }) {
        Ok(m) -> next(p, m)
        Error(Nil) -> http.error(404, "MEDIA_NOT_FOUND")
      }
    Ok(_) -> http.error(404, "NOT_FOUND")
  }
}

/// `POST /org/players/:pid/media/:mid/view`: one more view of the clip; answers the count.
pub fn view(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  player_id: id.PlayerId,
  media_id: id.MediaId,
) -> Response {
  use p, m <- visible_clip(ctx, a, player_id, media_id)
  use _ <- http.body(req, input.nothing(), [])
  let counted =
    store.unit(ctx.store, fn(tx) {
      live_pings.player(tx, p.row.id)
      use _ <- result.try(
        store.run(tx, "UPDATE player_media SET views = views + 1 WHERE id = ?", [
          id.media_sql(m.clip.id),
        ]),
      )
      store.one(
        store.reading(tx),
        "SELECT views FROM player_media WHERE id = ?",
        [id.media_sql(m.clip.id)],
        decode.at([0], decode.int),
      )
      |> result.map(result.unwrap(_, 0))
    })
  case counted {
    Error(failure) -> http.internal(failure)
    Ok(views) -> http.json(200, json.object([#("views", json.int(views))]))
  }
}

fn tags_shape() -> input.Shape(List(String)) {
  use tags <- input.field(
    "tags",
    input.nullish(input.distinct_list(input.text(1_000_000), 0)),
  )
  input.done(option.unwrap(tags, []))
}

fn refused_tags(code: String, extra: List(#(String, json.Json))) -> Response {
  http.json(
    400,
    json.object(
      list.flatten([
        [#("error", json.string(code))],
        extra,
        [#("allowed", json.array(scout_tags, json.string))],
      ]),
    ),
  )
}

/// `POST /org/players/:pid/media/:mid/tags`: one more of each tag named; answers every tag's count, in the order
/// each was first given.
pub fn tag(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  player_id: id.PlayerId,
  media_id: id.MediaId,
) -> Response {
  use p, m <- visible_clip(ctx, a, player_id, media_id)
  use tags <- http.body(req, tags_shape(), [])
  let invalid = list.filter(tags, fn(t) { !list.contains(scout_tags, t) })
  case tags, invalid {
    [], _ -> refused_tags("TAGS_REQUIRED", [])
    _, [_, ..] ->
      refused_tags("UNKNOWN_TAGS", [
        #("invalid", json.array(invalid, json.string)),
      ])
    _, [] -> {
      let now = clock.now_ms()
      let stored =
        store.unit(ctx.store, fn(tx) {
          use _ <- result.try(list.try_each(tags, add_tag(tx, m.clip.id, _)))
          use _ <- result.try(ledger.append(
            tx,
            ledger.Entry(
              event: ledger.Plain(ledger_row.ClipTagged),
              player_id: Some(p.row.id),
              org_id: Some(a.org.id),
              org_name: Some(a.org.name),
              user_id: Some(a.user.id),
              actor_name: Some(a.user.name),
            ),
            now,
          ))
          live_pings.player(tx, p.row.id)
          counts(store.reading(tx), m.clip.id)
        })
      case stored {
        Error(failure) -> http.internal(failure)
        Ok(counted) ->
          http.json(
            200,
            json.object([
              #(
                "tags",
                json.object(
                  list.map(counted, fn(r) { #(r.tag, json.int(r.count)) }),
                ),
              ),
            ]),
          )
      }
    }
  }
}

/// One more of `tag`; a tag the clip hasn't had goes after the others.
fn add_tag(tx: Tx, media_id: id.MediaId, tag: String) -> Result(Nil, Fail(e)) {
  store.run(
    tx,
    "INSERT INTO player_media_tags (media_id, position, tag, count) SELECT ?, COALESCE(MAX(position) + 1, 0), ?, 1 FROM player_media_tags WHERE media_id = ? ON CONFLICT (media_id, tag) DO UPDATE SET count = count + 1",
    [id.media_sql(media_id), sqlight.text(tag), id.media_sql(media_id)],
  )
}

fn counts(
  read: Read,
  media_id: id.MediaId,
) -> Result(List(tag_row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> tag_row.columns
      <> " FROM player_media_tags WHERE media_id = ? ORDER BY position",
    [id.media_sql(media_id)],
    tag_row.decoder(),
  )
}
