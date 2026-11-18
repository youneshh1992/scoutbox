//// Video segments and playlists (domains/scouting/scouting.mjs, repositories/scoutingAssessments.ts). A segment
//// annotates a player's footage by reference (no copied file) and is private to the club that made it: never
//// public, never a channel to a child. A segment is never edited, so a rating may check one it cites before its
//// own unit. A playlist collects the club's segments, each once.

import gleam/bool
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/players.{type Player}
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/json_text
import scoutbox/platform/key_order
import scoutbox/platform/sql
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/recruitment/room_routes
import scoutbox/rows/id
import scoutbox/rows/playlists as playlist_row
import scoutbox/rows/video_segments as row
import scoutbox/rules/visibility
import scoutbox/safety/audit
import scoutbox/safety/moderate
import scoutbox/scouting/evidence
import sqlight
import wisp.{type Request, type Response}

const labels_max = 8

const label_max = 30

const event_type_max = 40

const note_max = 300

const drawing_max = 4000

const segment_seconds = 600

const playlist_name_max = 80

pub type Segment {
  Segment(row: row.Row, labels: List(String))
}

fn assemble(read: Read, r: row.Row) -> Result(Segment, Fail(e)) {
  use labels <- result.map(store.query(
    read,
    "SELECT label FROM video_segment_labels WHERE segment_id = ? ORDER BY position",
    [id.segment_sql(r.id)],
    decode.at([0], decode.string),
  ))
  Segment(r, labels)
}

fn by_id(read: Read, sid: id.SegmentId) -> Result(Option(Segment), Fail(e)) {
  use found <- result.try(store.one(
    read,
    "SELECT " <> row.columns <> " FROM video_segments WHERE id = ?",
    [id.segment_sql(sid)],
    row.decoder(),
  ))
  case found {
    Ok(r) -> assemble(read, r) |> result.map(Some)
    Error(Nil) -> Ok(None)
  }
}

/// The stored record, with the path its footage is served at (signed on the way out).
fn segment_json(s: Segment) -> Json {
  let r = s.row
  json.object([
    #("id", id.segment_json(r.id)),
    #("mediaId", id.media_json(r.media_id)),
    #("playerId", id.player_json(r.player_id)),
    #("orgId", id.org_json(r.org_id)),
    #(
      "createdBy",
      json.object([
        #("userId", id.org_user_json(r.created_by_user_id)),
        #("name", json.string(r.created_by_name)),
      ]),
    ),
    #("startS", json_text.number(r.start_s)),
    #("endS", json_text.number(r.end_s)),
    #("labels", json.array(s.labels, json.string)),
    #("eventType", json.nullable(r.event_type, json.string)),
    #("note", json.nullable(r.note, json.string)),
    #("drawing", case r.drawing_json {
      Some(text) -> json_text.parse(text) |> result.unwrap(json.null())
      None -> json.null()
    }),
    #("createdAt", json.int(r.created_at)),
    #("mediaUrl", json.string("/media/" <> id.media_to_string(r.media_id))),
  ])
}

// ------------------------------------------------------------------------------------------------- creating

type NewSegment {
  NewSegment(
    start_s: Float,
    end_s: Float,
    labels: Option(List(String)),
    event_type: Option(String),
    note: Option(String),
    drawing: Option(List(#(String, Dynamic))),
  )
}

fn segment_shape() -> input.Shape(NewSegment) {
  let any_number = input.number(-9_007_199_254_740_991, 9_007_199_254_740_991)
  use start_s <- input.field(
    "startS",
    input.required(input.number(0, 9_007_199_254_740_991)),
  )
  use end_s <- input.field("endS", input.required(any_number))
  // Checked as one list, so the refusal names `labels`.
  use labels <- input.field(
    "labels",
    input.nullish(
      input.list_of(input.anything(), 1_000_000)
      |> input.refine(
        fn(ls) {
          list.length(ls) <= labels_max
          && list.all(ls, fn(l) {
            case decode.run(l, decode.string) {
              Ok(s) -> input.utf16_length(s) <= label_max
              Error(_) -> False
            }
          })
        },
        "must be a list of at most 8 short texts of at most 30 characters",
      )
      |> fn(check) {
        fn(v) {
          check(v)
          |> result.map(
            list.map(_, fn(l) {
              decode.run(l, decode.string) |> result.unwrap("")
            }),
          )
        }
      },
    ),
  )
  use event_type <- input.field(
    "eventType",
    input.nullish(input.text(event_type_max)),
  )
  use note <- input.field("note", input.nullish(input.text(note_max)))
  use drawing <- input.field(
    "drawing",
    input.nullish(
      input.record(input.text(1_000_000), input.anything())
      |> input.refine(
        fn(entries) {
          let text =
            key_order.object_json(entries, key_order.Unknown) |> json.to_string
          input.utf16_length(text) <= drawing_max
        },
        "must be an object of overlay shapes of at most 4000 characters",
      ),
    ),
  )
  input.done(NewSegment(start_s:, end_s:, labels:, event_type:, note:, drawing:))
}

/// The player whose footage `media_id` is, as `org` may see them.
fn owner(
  read: Read,
  media_id: id.MediaId,
  a: OrgAccess,
  now: Int,
) -> Result(Option(#(Player, visibility.Access)), Fail(e)) {
  use found <- result.try(store.one(
    read,
    "SELECT player_id FROM player_media WHERE id = ?",
    [id.media_sql(media_id)],
    decode.at([0], id.player_decoder()),
  ))
  case found {
    Ok(pid) -> players.for_org(read, pid, a.org, now)
    Error(Nil) -> Ok(None)
  }
}

/// `POST /org/media/:id/segments`: a timestamped clip of footage the club may see.
pub fn create(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  media_id: id.MediaId,
) -> Response {
  let now = clock.now_ms()
  case store.read(ctx.store, owner(_, media_id, a, now)) {
    Error(e) -> http.internal(e)
    Ok(None) -> http.error(404, "MEDIA_NOT_FOUND")
    Ok(Some(#(_, seen))) if !seen.visible || seen.blocked ->
      http.error(403, "NOT_VISIBLE")
    Ok(Some(#(p, _))) -> {
      use raw, order <- http.json_body_in_order(req)
      case
        input.parse_in_order(
          segment_shape(),
          raw,
          order,
          root: "body",
          codes: [
            #("startS", "TIMESTAMPS_INVALID"),
            #("endS", "TIMESTAMPS_INVALID"),
          ],
          default: "FIELD_INVALID",
        )
      {
        Error(refusal) -> http.refused(refusal)
        Ok(b) ->
          case
            b.end_s >. b.start_s
            && b.end_s -. b.start_s <=. int.to_float(segment_seconds)
          {
            False ->
              http.error_message(
                400,
                "TIMESTAMPS_INVALID",
                "start ≥ 0, end > start, segment ≤ 10 minutes.",
              )
            True -> {
              let note = blank_to_none(b.note)
              let drawing =
                option.map(b.drawing, fn(d) {
                  key_order.object_json(
                    d,
                    key_order.at(order, [key_order.Key("drawing")]),
                  )
                  |> json.to_string
                })
              let write = fn() {
                store.unit(ctx.store, fn(tx) {
                  use sid <- result.try(
                    id.next_segment(tx) |> room_routes.storage,
                  )
                  let r =
                    row.Row(
                      ..row.new(
                        id: sid,
                        media_id:,
                        player_id: p.row.id,
                        org_id: a.org.id,
                        created_by_user_id: a.user.id,
                        created_by_name: evidence.stored_name(a.user.name),
                        start_s: b.start_s,
                        end_s: b.end_s,
                        created_at: now,
                      ),
                      event_type: blank_to_none(b.event_type),
                      note:,
                      drawing_json: drawing,
                    )
                  use _ <- result.try(row.insert(tx, r) |> room_routes.storage)
                  let labels =
                    option.unwrap(b.labels, [])
                    |> list.map(string.trim)
                    |> list.filter(fn(l) { l != "" })
                  use _ <- result.try(
                    list.index_map(labels, fn(l, i) { #(i, l) })
                    |> list.try_each(fn(x) {
                      store.run(
                        tx,
                        "INSERT INTO video_segment_labels (segment_id, position, label) VALUES (?, ?, ?)",
                        [
                          id.segment_sql(sid),
                          sqlight.int(x.0),
                          sqlight.text(x.1),
                        ],
                      )
                    })
                    |> room_routes.storage,
                  )
                  Ok(http.json(
                    201,
                    json.object([#("segment", segment_json(Segment(r, labels)))]),
                  ))
                })
                |> room_routes.answer
              }
              case note {
                None -> write()
                Some(text) -> {
                  use <- moderate.or_refuse(
                    ctx,
                    text,
                    audit.Context(
                      kind: "segment_note",
                      player_id: Some(p.row.id),
                      org_id: Some(a.org.id),
                      user_id: None,
                      channel_id: None,
                      request_id: None,
                    ),
                  )
                  write()
                }
              }
            }
          }
      }
    }
  }
}

/// Blank text is no text; anything else is kept as sent (scouting.mjs `blankToNull`).
fn blank_to_none(s: Option(String)) -> Option(String) {
  case s {
    Some(t) ->
      case string.trim(t) {
        "" -> None
        _ -> Some(t)
      }
    None -> None
  }
}

// ---------------------------------------------------------------------------------------------------- reading

type Query {
  Query(
    player_id: Option(String),
    media_id: Option(String),
    limit: Option(Int),
    offset: Option(Int),
  )
}

/// `GET /org/segments`: the club's segments, oldest first, of players it may still see (a segment on a player
/// no longer visible does not travel).
pub fn list_for(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  let shape = {
    use player_id <- input.field("playerId", input.optional(input.id()))
    use media_id <- input.field("mediaId", input.optional(input.id()))
    use limit <- input.field(
      "limit",
      input.optional(input.whole_number_text(1, 200)),
    )
    use offset <- input.field(
      "offset",
      input.optional(input.whole_number_text(0, 9_007_199_254_740_991)),
    )
    input.done(Query(player_id:, media_id:, limit:, offset:))
  }
  use q <- http.query(req, shape, [#("limit", "PAGE_LIMIT_INVALID")])
  let now = clock.now_ms()
  let condition =
    sql.concat([
      sql.text(
        "SELECT "
        <> row.qualified("s")
        <> " FROM video_segments s JOIN players p ON p.id = s.player_id WHERE s.org_id = ",
      ),
      sql.arg(id.org_sql(a.org.id)),
      narrow(" AND s.player_id = ", q.player_id),
      narrow(" AND s.media_id = ", q.media_id),
      sql.text(" AND "),
      visibility.can_see_sql(a.org, now),
      sql.text(" ORDER BY s.rowid"),
    ])
  let found =
    store.read(ctx.store, fn(read) {
      use rows <- result.try(store.query(
        read,
        condition.sql,
        condition.args,
        row.decoder(),
      ))
      list.try_map(rows, assemble(read, _))
    })
  case found {
    Error(e) -> http.internal(e)
    Ok(all) -> {
      let limit = option.unwrap(q.limit, 50)
      let offset = option.unwrap(q.offset, 0)
      http.json(
        200,
        json.object([
          #("total", json.int(list.length(all))),
          #("limit", json.int(limit)),
          #("offset", json.int(offset)),
          #(
            "items",
            json.array(
              all |> list.drop(offset) |> list.take(limit),
              segment_json,
            ),
          ),
        ]),
      )
    }
  }
}

fn narrow(condition: String, value: Option(String)) -> sql.Fragment {
  case value {
    Some(v) -> sql.concat([sql.text(condition), sql.arg(sqlight.text(v))])
    None -> sql.text("")
  }
}

/// `GET /org/segments/:id`: the club's own segment, with the footage it annotates.
pub fn one(ctx: Ctx, a: OrgAccess, sid: id.SegmentId) -> Response {
  let now = clock.now_ms()
  let found =
    store.read(ctx.store, fn(read) {
      use s <- result.try(by_id(read, sid))
      case s {
        Some(s) if s.row.org_id == a.org.id -> {
          use p <- result.map(players.for_org(read, s.row.player_id, a.org, now))
          Some(#(s, p))
        }
        _ -> Ok(None)
      }
    })
  case found {
    Error(e) -> http.internal(e)
    Ok(None) -> http.error(404, "SEGMENT_NOT_FOUND")
    Ok(Some(#(s, Some(#(p, seen))))) if seen.visible && !seen.blocked -> {
      let media =
        list.find(p.media, fn(m) { m.clip.id == s.row.media_id })
        |> option.from_result
      http.json(
        200,
        json.object([
          #("segment", segment_json(s)),
          #("media", case media {
            Some(m) ->
              json.object(
                list.flatten([
                  [
                    #("id", id.media_json(m.clip.id)),
                    #("title", json.string(m.clip.title)),
                  ],
                  case m.clip.kind {
                    Some(k) -> [#("kind", json.string(k))]
                    None -> []
                  },
                  [
                    #(
                      "verifiedClip",
                      json.nullable(
                        m.clip.verified_clip_attendance_id,
                        id.attendance_json,
                      ),
                    ),
                    #(
                      "captions",
                      json.bool(blank_to_none(m.clip.captions) != None),
                    ),
                  ],
                ]),
              )
            None -> json.null()
          }),
        ]),
      )
    }
    Ok(Some(_)) -> http.error(403, "NOT_VISIBLE")
  }
}

// -------------------------------------------------------------------------------------------------- playlists

pub type Playlist {
  Playlist(row: playlist_row.Row, segment_ids: List(id.SegmentId))
}

fn playlist(read: Read, r: playlist_row.Row) -> Result(Playlist, Fail(e)) {
  use segment_ids <- result.map(store.query(
    read,
    "SELECT segment_id FROM playlist_segments WHERE playlist_id = ? ORDER BY position",
    [id.playlist_sql(r.id)],
    decode.at([0], id.segment_decoder()),
  ))
  Playlist(r, segment_ids)
}

fn playlist_json(p: Playlist) -> Json {
  let r = p.row
  json.object([
    #("id", id.playlist_json(r.id)),
    #("orgId", id.org_json(r.org_id)),
    #("name", json.string(r.name)),
    #(
      "createdBy",
      json.object([
        #("userId", id.org_user_json(r.created_by_user_id)),
        #("name", json.string(r.created_by_name)),
      ]),
    ),
    #("segmentIds", json.array(p.segment_ids, id.segment_json)),
    #("createdAt", json.int(r.created_at)),
  ])
}

fn playlist_answer(status: Int, p: Playlist) -> Response {
  http.json(status, json.object([#("playlist", playlist_json(p))]))
}

/// `POST /org/playlists`.
pub fn create_playlist(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  let shape = {
    use name <- input.field(
      "name",
      input.nullish(input.text(playlist_name_max)),
    )
    input.done(name)
  }
  use name <- http.body(req, shape, [])
  case input.filled(name) {
    None -> http.error(400, "NAME_REQUIRED")
    Some(name) ->
      store.unit(ctx.store, fn(tx) {
        use pid <- result.try(id.next_playlist(tx) |> room_routes.storage)
        let r =
          playlist_row.new(
            id: pid,
            org_id: a.org.id,
            name:,
            created_by_user_id: a.user.id,
            created_by_name: evidence.stored_name(a.user.name),
            created_at: clock.now_ms(),
          )
        use _ <- result.map(playlist_row.insert(tx, r) |> room_routes.storage)
        playlist_answer(201, Playlist(r, []))
      })
      |> room_routes.answer
  }
}

/// `POST /org/playlists/:id/segments`: adding a segment it holds already keeps it once.
pub fn add_segment(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  pid: id.PlaylistId,
) -> Response {
  let shape = {
    use segment_id <- input.field("segmentId", input.required(input.id()))
    input.done(id.segment(segment_id))
  }
  let body = http.parse_body(req, shape, [])
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use found <- result.try(
      store.one(
        read,
        "SELECT " <> playlist_row.columns <> " FROM playlists WHERE id = ?",
        [id.playlist_sql(pid)],
        playlist_row.decoder(),
      )
      |> room_routes.storage,
    )
    use r <- result.try(case found {
      Ok(r) if r.org_id == a.org.id -> Ok(r)
      _ -> store.refuse(http.error(404, "PLAYLIST_NOT_FOUND"))
    })
    use sid <- result.try(case body {
      Ok(sid) -> Ok(sid)
      Error(refused) -> store.refuse(refused)
    })
    use owner <- result.try(
      store.one(
        read,
        "SELECT org_id FROM video_segments WHERE id = ?",
        [id.segment_sql(sid)],
        decode.at([0], id.org_decoder()),
      )
      |> room_routes.storage,
    )
    use <- bool.lazy_guard(owner != Ok(a.org.id), fn() {
      store.refuse(http.error(404, "SEGMENT_NOT_FOUND"))
    })
    use p <- result.try(playlist(read, r) |> room_routes.storage)
    case list.contains(p.segment_ids, sid) {
      True -> Ok(playlist_answer(200, p))
      False -> {
        use _ <- result.map(
          store.run(
            tx,
            "INSERT INTO playlist_segments (playlist_id, position, segment_id) VALUES (?, ?, ?)",
            [
              id.playlist_sql(r.id),
              sqlight.int(list.length(p.segment_ids)),
              id.segment_sql(sid),
            ],
          )
          |> room_routes.storage,
        )
        playlist_answer(200, Playlist(r, list.append(p.segment_ids, [sid])))
      }
    }
  })
  |> room_routes.answer
}

/// `GET /org/playlists`: the club's playlists, oldest first, as a bare list.
pub fn playlists(ctx: Ctx, a: OrgAccess) -> Response {
  let found =
    store.read(ctx.store, fn(read) {
      use rows <- result.try(store.query(
        read,
        "SELECT "
          <> playlist_row.columns
          <> " FROM playlists WHERE org_id = ? ORDER BY rowid",
        [id.org_sql(a.org.id)],
        playlist_row.decoder(),
      ))
      list.try_map(rows, playlist(read, _))
    })
  case found {
    Error(e) -> http.internal(e)
    Ok(ps) -> http.json(200, json.array(ps, playlist_json))
  }
}
