//// The Grassroots journey, for amateur and semi-pro players (domains/development/grassroots.mjs): the training
//// programme and the season wrap. The opportunity radar is `open_days`. Pro-level players have moved past it.

import gleam/dynamic/decode
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/development/activity
import scoutbox/development/benchmarks
import scoutbox/identity/access.{type PlayerAccess}
import scoutbox/identity/players
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/json_text
import scoutbox/platform/store
import scoutbox/rows/id
import scoutbox/rules/journey
import scoutbox/vocab/playing_level
import scoutbox/vocab/position
import wisp.{type Request, type Response}

const programme_track_max = 60

/// Answers 403 for a pro-level player.
pub fn grassroots_only(p: PlayerAccess, next: fn() -> Response) -> Response {
  case p.player.row.level {
    playing_level.Pro ->
      http.error_message(
        403,
        "GRASSROOTS_ONLY",
        "This is part of the Grassroots journey — pro-level players have moved past it.",
      )
    _ -> next()
  }
}

fn current(p: players.Player, now: Int) -> json.Json {
  json.object([#("current", journey.programme(p, now))])
}

/// `GET /player/programme`: the player's track this week, every track, and the one their position suggests.
pub fn programme(p: PlayerAccess) -> Response {
  use <- grassroots_only(p)
  let now = clock.now_ms()
  http.json(
    200,
    json.object([
      #("current", journey.programme(p.player, now)),
      #(
        "tracks",
        json.array(journey.tracks(), fn(t) {
          json.object([
            #("key", json.string(t.key)),
            #("label", json.string(t.label)),
            #(
              "positions",
              json.array(
                list.key_find(benchmarks.tracks, t.key) |> result.unwrap([]),
                position.to_json,
              ),
            ),
            #("sessionsPerWeek", json.int(list.length(t.sessions))),
          ])
        }),
      ),
      #("suggested", json.string(benchmarks.track_for(p.player.row.position))),
    ]),
  )
}

/// `POST /player/programme`: starts (or switches to) a track; the previous track's sessions go with it.
pub fn select_programme(ctx: Ctx, req: Request, p: PlayerAccess) -> Response {
  use <- grassroots_only(p)
  let shape = {
    use track <- input.field(
      "track",
      input.optional(input.text(programme_track_max)),
    )
    input.done(track)
  }
  use track <- http.body(req, shape, [])
  let found =
    list.find(journey.tracks(), fn(t) { Some(t.key) == track })
    |> option.from_result
  case found {
    None -> http.error(400, "TRACK_NOT_FOUND")
    Some(t) -> {
      let now = clock.now_ms()
      // Not ported yet: the live 'players' event.
      case
        store.unit(ctx.store, players.start_programme(
          _,
          p.player.row.id,
          t.key,
          now,
        ))
      {
        Ok(stored) -> http.json(201, current(stored, now))
        Error(failure) -> http.internal(failure)
      }
    }
  }
}

/// `POST /player/programme/sessions/:id/complete`: a session of the current track done, which feeds the streak.
pub fn complete_session(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  session_id: String,
) -> Response {
  use <- grassroots_only(p)
  use _ <- http.body(req, input.nothing(), [])
  case p.player.row.programme_track {
    None ->
      http.error_message(409, "NO_PROGRAMME", "Pick a training track first.")
    Some(key) -> {
      let session =
        list.find(journey.tracks(), fn(t) { t.key == key })
        |> result.try(fn(t) {
          list.find(t.sessions, fn(s) { s.id == session_id })
        })
      case session {
        Error(_) -> http.error(404, "SESSION_NOT_FOUND")
        Ok(s) -> {
          let now = clock.now_ms()
          // Not ported yet: the live 'players' event.
          let done =
            store.unit(ctx.store, fn(tx) {
              use _ <- result.try(players.complete_programme_session(
                tx,
                p.player.row.id,
                s.id,
                now,
              ))
              activity.record(tx, p.player.row.id, now)
            })
          case done {
            Ok(stored) -> http.json(200, current(stored, now))
            Error(failure) -> http.internal(failure)
          }
        }
      }
    }
  }
}

const day_ms = 86_400_000

/// `GET /player/season-wrap`: the verified year, every number backed by the ledger.
pub fn season_wrap(ctx: Ctx, p: PlayerAccess) -> Response {
  use <- grassroots_only(p)
  let me = p.player
  let views =
    store.read(ctx.store, fn(read) {
      store.one(
        read,
        "SELECT COUNT(*) FROM ledger WHERE player_id = ? AND type = 'view'",
        [id.player_sql(me.row.id)],
        decode.at([0], decode.int),
      )
    })
  case views {
    Error(failure) -> http.internal(failure)
    Ok(views) -> {
      let days =
        list.map(me.activity_log, fn(ts) {
          int.floor_divide(ts, day_ms) |> result.unwrap(0)
        })
        |> list.unique
        |> list.sort(int.compare)
      let best_streak =
        list.fold(days, #(0, 0, None), fn(acc, d) {
          let #(best, run, previous) = acc
          let run = case previous {
            Some(prev) if d == prev + 1 -> run + 1
            _ -> 1
          }
          #(int.max(best, run), run, Some(d))
        }).0
      let verified = list.filter(me.drill_results, fn(r) { r.verified })
      let recent = list.drop(verified, int.max(0, list.length(verified) - 4))
      http.json(
        200,
        json.object([
          #("generatedAt", json.string(clock.iso(clock.now_ms()))),
          #(
            "player",
            json.object([
              #("name", json.string(me.row.name)),
              #("position", json.nullable(me.row.position, position.to_json)),
              #("level", playing_level.to_json(me.row.level)),
            ]),
          ),
          #("season", players.stats_json(players.stats(me.row))),
          #("verifiedAttendances", json.int(list.length(me.attendance))),
          #(
            "verifiedClips",
            json.int(
              list.count(me.media, fn(m) {
                m.clip.verified_clip_attendance_id != None
              }),
            ),
          ),
          #("bestStreak", json.int(best_streak)),
          #(
            "combineBests",
            json.array(recent, fn(r) {
              json.object([
                #("drillName", json.nullable(r.drill_name, json.string)),
                #("metric", json.string(r.metric)),
                #("value", json_text.number(r.value)),
                #("unit", json.nullable(r.unit, json.string)),
              ])
            }),
          ),
          #("badges", json.array(me.badges, json.string)),
          #(
            "coachVouches",
            json.int(list.length(players.published_vouches(me))),
          ),
          #("scoutViews", json.int(result.unwrap(views, 0))),
          #(
            "note",
            json.string(
              "Your season, verified. Every number above is backed by the ledger — no vanity metrics.",
            ),
          ),
        ]),
      )
    }
  }
}
