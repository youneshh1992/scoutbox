//// The player's own record: what they see of it, and the switches and figures they set
//// (domains/development/record.mjs, grassroots.mjs; identity/players.mjs `/me`; messaging/notify.mjs prefs). A
//// write answers with the stored record, read back after the act.
////
//// A child's settings are the guardian's: the routes that change one refuse a minor with GUARDIAN_MANAGED, and
//// the guardian sets them from `/guardian/children/:id`.

import gleam/dynamic/decode
import gleam/float
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/development/activity
import scoutbox/development/benchmarks
import scoutbox/identity/access.{type PlayerAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/players.{type Player}
import scoutbox/media/uploads
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/ids
import scoutbox/platform/input
import scoutbox/platform/json_text
import scoutbox/platform/live_pings
import scoutbox/platform/store.{type Tx}
import scoutbox/platform/temporal
import scoutbox/platform/zones
import scoutbox/recruitment/signing_reads
import scoutbox/rows/id
import scoutbox/rows/ledger as ledger_row
import scoutbox/rows/player_drill_results as drill_result_row
import scoutbox/rows/players as row
import scoutbox/rows/upload_intents as upload_row
import scoutbox/rules/journey
import scoutbox/safety/audit
import scoutbox/safety/ledger
import scoutbox/safety/moderate
import scoutbox/verification/vouch_view
import scoutbox/vocab/availability
import scoutbox/vocab/playing_level
import sqlight
import wisp.{type Request, type Response}

const fresh_start = "Fresh Start"

const badges_max = 6

const badge_max = 60

/// Runs an act on the player's record, pings the player catalogue, and answers with what `view` makes of the
/// stored record.
fn act(
  ctx: Ctx,
  work: fn(Tx) -> Result(Player, store.Fail(Nil)),
  view: fn(Player) -> json.Json,
) -> Response {
  quiet_act(
    ctx,
    fn(tx) {
      use p <- result.map(work(tx))
      live_pings.player(tx, p.row.id)
      p
    },
    view,
  )
}

/// An act no catalogue ping follows (the notification preferences are the player's alone).
fn quiet_act(
  ctx: Ctx,
  work: fn(Tx) -> Result(Player, store.Fail(Nil)),
  view: fn(Player) -> json.Json,
) -> Response {
  case store.unit(ctx.store, work) {
    Ok(p) -> http.json(200, view(p))
    Error(store.Lost(what)) -> http.stale(what)
    Error(failure) -> http.internal(failure)
  }
}

/// `GET /player/me`.
pub fn me(p: PlayerAccess) -> Response {
  let now = clock.now_ms()
  let player = p.player
  let score = players.profile_signal(player)
  http.json(
    200,
    json.object(
      list.append(players.self_fields(player), [
        #("age", json.int(players.age_now(player, now))),
        #("trustScore", json.int(score)),
        #("trust", players.trust_breakdown(player)),
        #("tier", json.string(journey.tier(score))),
        #("streak", json.int(journey.streak(player.activity_log, now))),
        #("weeklyGoal", journey.weekly_goal(player.activity_log, now)),
        #("nextActions", journey.next_actions(player)),
        #("agingUp", case !p.minor && player.row.guardian_id != None {
          True -> json.object([#("eligible", json.bool(True))])
          False -> json.null()
        }),
        #("pathway", journey.pathway(player)),
        #("programme", journey.programme(player, now)),
        #("vouches", json.array(player.vouches, vouch_view.view)),
      ]),
    ),
  )
}

fn enabled_shape(field: String) -> input.Shape(Bool) {
  use on <- input.field(field, input.required(input.boolean()))
  input.done(on)
}

/// `POST /player/first-team-seeker`: part of the Grassroots journey.
pub fn first_team_seeker(ctx: Ctx, req: Request, p: PlayerAccess) -> Response {
  case p.player.row.level {
    playing_level.Pro ->
      http.error_message(
        403,
        "GRASSROOTS_ONLY",
        "This is part of the Grassroots journey — pro-level players have moved past it.",
      )
    _ -> {
      use <- access.guardian_managed_only(p)
      set_seeker(ctx, req, p.player)
    }
  }
}

/// `POST /guardian/children/:id/first-team-seeker`: the guardian sets it for a grassroots child.
pub fn child_first_team_seeker(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  id: id.PlayerId,
) -> Response {
  use child <- own_child(ctx, g, id)
  case child.row.level {
    playing_level.Pro -> http.error(403, "GRASSROOTS_ONLY")
    _ -> set_seeker(ctx, req, child)
  }
}

fn set_seeker(ctx: Ctx, req: Request, p: Player) -> Response {
  use on <- http.body(req, enabled_shape("enabled"), [])
  act(ctx, players.set_switch(_, p.row.id, players.FirstTeamSeeker, on), fn(s) {
    json.object([#("firstTeamSeeker", json.bool(s.row.first_team_seeker))])
  })
}

/// `POST /player/academyplus`: the Fresh Start badge comes and goes with it.
pub fn academy_plus(ctx: Ctx, req: Request, p: PlayerAccess) -> Response {
  use <- access.guardian_managed_only(p)
  use on <- http.body(req, enabled_shape("enabled"), [])
  let id = p.player.row.id
  act(
    ctx,
    fn(tx) {
      use stored <- result.try(players.set_switch(
        tx,
        id,
        players.AcademyPlus,
        on,
      ))
      let has = list.contains(stored.badges, fresh_start)
      case on, has {
        True, False ->
          players.set_badges(tx, id, list.append(stored.badges, [fresh_start]))
        False, True ->
          players.set_badges(
            tx,
            id,
            list.filter(stored.badges, fn(b) { b != fresh_start }),
          )
        _, _ -> Ok(stored)
      }
    },
    fn(s) {
      json.object([
        #("academyPlus", json.bool(s.row.academy_plus)),
        #("badges", json.array(s.badges, json.string)),
      ])
    },
  )
}

fn share(ctx: Ctx, req: Request, id: id.PlayerId) -> Response {
  use on <- http.body(req, enabled_shape("shared"), [])
  act(ctx, players.set_switch(_, id, players.MedicalShared, on), fn(s) {
    json.object([#("shared", json.bool(s.row.medical_shared))])
  })
}

/// `POST /player/medical/share`: the player's call by data-protection law; for a child, the guardian's.
pub fn medical_share(ctx: Ctx, req: Request, p: PlayerAccess) -> Response {
  use <- access.guardian_managed_only(p)
  share(ctx, req, p.player.row.id)
}

type Availability {
  Availability(
    availability: Option(availability.Availability),
    contract_status: Option(row.ContractStatus),
  )
}

/// `POST /player/availability`. A contract a completed signing records makes the status canonical: no word
/// replaces it here while that contract stands.
pub fn availability(ctx: Ctx, req: Request, p: PlayerAccess) -> Response {
  use <- access.guardian_managed_only(p)
  let shape = {
    use availability <- input.field(
      "availability",
      input.nullish(input.one_of(availability.pairs)),
    )
    use contract_status <- input.field(
      "contractStatus",
      input.nullish(input.one_of(row.contract_status_pairs)),
    )
    input.done(Availability(availability:, contract_status:))
  }
  use body <- http.body(req, shape, [
    #("availability", "BAD_AVAILABILITY"),
    #("contractStatus", "BAD_CONTRACT_STATUS"),
  ])
  case body.contract_status {
    Some(row.UnderContract) ->
      http.json(
        403,
        json.object([
          #("error", json.string("CONTRACT_STATUS_NOT_SELF_DECLARABLE")),
          #(
            "message",
            json.string(
              "Under contract is recorded when a signing completes in ScoutBox; it cannot be declared here.",
            ),
          ),
          #(
            "allowed",
            json.array(
              row.contract_status_pairs
                |> list.filter(fn(p) { p.1 != row.UnderContract }),
              fn(p) { json.string(p.0) },
            ),
          ),
        ]),
      )
    Some(_) ->
      case
        store.read(ctx.store, signing_reads.canonical_contract(
          _,
          p.player.row.id,
          clock.now_ms(),
          None,
        ))
      {
        Error(failure) -> http.internal(failure)
        Ok(Some(end)) ->
          http.json(
            409,
            json.object([
              #("error", json.string("CONTRACT_STATUS_CANONICAL")),
              #(
                "message",
                json.string(
                  "Your contract status is set by a signing completed in ScoutBox and cannot be changed here while that contract stands.",
                ),
              ),
              #(
                "contractStatus",
                row.contract_status_to_json(p.player.row.contract_status),
              ),
              #("endDate", json.nullable(end, json.string)),
            ]),
          )
        Ok(None) -> set_availability(ctx, p, body)
      }
    None -> set_availability(ctx, p, body)
  }
}

fn set_availability(ctx: Ctx, p: PlayerAccess, body: Availability) -> Response {
  act(
    ctx,
    players.set_availability(
      _,
      p.player.row.id,
      body.availability,
      body.contract_status,
    ),
    fn(s) {
      json.object([
        #("availability", availability.to_json(s.row.availability)),
        #("contractStatus", row.contract_status_to_json(s.row.contract_status)),
      ])
    },
  )
}

/// A figure as sent: a number, judged by the route (BAD_STAT) rather than the shape.
type Figure =
  Option(Float)

type StatsInput {
  StatsInput(
    appearances: Figure,
    goals: Figure,
    assists: Figure,
    pace_kmh: Figure,
    pass_completion_pct: Figure,
    duel_success_pct: Figure,
    clean_sheets: Figure,
    season: Option(String),
  )
}

/// `POST /player/stats`.
pub fn stats(ctx: Ctx, req: Request, p: PlayerAccess) -> Response {
  let figure = fn(name, next) {
    input.field(
      name,
      input.optional(input.number(-1_000_000_000, 1_000_000_000)),
      next,
    )
  }
  let shape = {
    use appearances <- figure("appearances")
    use goals <- figure("goals")
    use assists <- figure("assists")
    use pace_kmh <- figure("paceKmh")
    use pass_completion_pct <- figure("passCompletionPct")
    use duel_success_pct <- figure("duelSuccessPct")
    use clean_sheets <- figure("cleanSheets")
    use season <- input.field("season", input.nullish(input.text(20)))
    input.done(StatsInput(
      appearances:,
      goals:,
      assists:,
      pace_kmh:,
      pass_completion_pct:,
      duel_success_pct:,
      clean_sheets:,
      season:,
    ))
  }
  let codes =
    list.map(
      [
        "appearances", "goals", "assists", "paceKmh", "passCompletionPct",
        "duelSuccessPct", "cleanSheets",
      ],
      fn(f) { #(f, "BAD_STAT") },
    )
  use body <- http.body(req, shape, codes)
  let count = fn(name, v: Figure) {
    case v {
      None -> Ok(None)
      Some(f) ->
        case f >=. 0.0 && whole(f) {
          True -> Ok(Some(float_to_int(f)))
          False -> Error(name)
        }
    }
  }
  let real = fn(name, v: Figure, pct: Bool) {
    case v {
      None -> Ok(None)
      Some(f) ->
        case f >=. 0.0 && { !pct || f <=. 100.0 } {
          True -> Ok(Some(f))
          False -> Error(name)
        }
    }
  }
  let judged = {
    use appearances <- result.try(count("appearances", body.appearances))
    use goals <- result.try(count("goals", body.goals))
    use assists <- result.try(count("assists", body.assists))
    use pace_kmh <- result.try(real("paceKmh", body.pace_kmh, False))
    use pass <- result.try(real(
      "passCompletionPct",
      body.pass_completion_pct,
      True,
    ))
    use duel <- result.try(real("duelSuccessPct", body.duel_success_pct, True))
    use clean_sheets <- result.map(count("cleanSheets", body.clean_sheets))
    players.Stats(
      appearances,
      goals,
      assists,
      pace_kmh,
      pass,
      duel,
      clean_sheets,
    )
  }
  case judged, input.filled(body.season) {
    Error(field), _ ->
      http.json(
        400,
        json.object([
          #("error", json.string("BAD_STAT")),
          #("field", json.string(field)),
        ]),
      )
    Ok(figures), season ->
      act(
        ctx,
        fn(tx) {
          let id = p.player.row.id
          use _ <- result.try(case season {
            // `season` (e.g. "2024/25") files the figures into the season history instead of the current season.
            Some(season) -> players.file_season(tx, id, season, figures)
            None -> players.record_stats(tx, id, figures)
          })
          use _ <- result.try(store.seam(tx, "stats.after_row"))
          activity.record(tx, id, clock.now_ms())
        },
        fn(s) {
          json.object([
            #("stats", players.stats_json(players.stats(s.row))),
            #("seasonHistory", players.season_history_json(s)),
          ])
        },
      )
  }
}

fn whole(f: Float) -> Bool {
  float.floor(f) == f
}

fn float_to_int(f: Float) -> Int {
  float.truncate(f)
}

/// `POST /player/badges`: replaces them, in order.
pub fn badges(ctx: Ctx, req: Request, p: PlayerAccess) -> Response {
  let shape = {
    use badges <- input.field(
      "badges",
      input.required(input.items_between(
        input.required_text(badge_max),
        0,
        badges_max,
      )),
    )
    input.done(badges)
  }
  use badges <- http.body(req, shape, [#("badges", "BADGES_MUST_BE_ARRAY")])
  act(ctx, players.set_badges(_, p.player.row.id, badges), fn(s) {
    json.object([#("badges", json.array(s.badges, json.string))])
  })
}

type PrefsInput {
  PrefsInput(
    quiet_start: Option(Option(String)),
    quiet_end: Option(Option(String)),
    school_hours_mute: Option(Option(Bool)),
    timezone: Option(Option(String)),
  )
}

const prefs_note =
  "Quiet hours and the school-hours mute apply to push delivery; the in-app feed always keeps the record."

/// `POST /player/prefs`. An absent field keeps its value; null or empty clears it.
pub fn prefs(ctx: Ctx, req: Request, p: PlayerAccess) -> Response {
  use body <- prefs_body(req)
  quiet_act(
    ctx,
    players.set_prefs(
      _,
      p.player.row.id,
      merge_prefs(players.prefs(p.player), body),
    ),
    fn(s) { prefs_view(players.prefs(s)) },
  )
}

/// `POST /guardian/prefs`: as the player's.
pub fn guardian_prefs(ctx: Ctx, req: Request, g: Guardian) -> Response {
  use body <- prefs_body(req)
  let saved =
    store.unit(ctx.store, fn(tx) {
      guardians.set_prefs(
        tx,
        g.row.id,
        merge_prefs(guardians.prefs_of(g), body),
      )
    })
  case saved {
    Ok(Some(stored)) -> http.json(200, prefs_view(guardians.prefs_of(stored)))
    Ok(None) -> http.error(404, "GUARDIAN_NOT_FOUND")
    Error(failure) -> http.internal(failure)
  }
}

/// The body of either prefs write, refused when its time zone is not one.
fn prefs_body(req: Request, next: fn(PrefsInput) -> Response) -> Response {
  let time_or_blank = fn(v) {
    case input.text(5)(v) {
      Ok("") -> Ok("")
      _ -> input.time_of_day()(v)
    }
  }
  let shape = {
    use quiet_start <- input.field("quietStart", input.clearable(time_or_blank))
    use quiet_end <- input.field("quietEnd", input.clearable(time_or_blank))
    use school_hours_mute <- input.field(
      "schoolHoursMute",
      input.clearable(input.boolean()),
    )
    use timezone <- input.field("timezone", input.clearable(input.text(64)))
    input.done(PrefsInput(
      quiet_start:,
      quiet_end:,
      school_hours_mute:,
      timezone:,
    ))
  }
  use body <- http.body(req, shape, [])
  case body.timezone {
    Some(Some(z)) if z != "" ->
      case zones.parse(z) {
        Error(Nil) ->
          http.error_message(
            400,
            "TIMEZONE_INVALID",
            "timezone must be an IANA time zone name, for example Europe/London.",
          )
        Ok(_) -> next(body)
      }
    _ -> next(body)
  }
}

/// A null mute keeps the stored one, as TypeScript's `??` reads it: once set, it can't return to unset.
fn merge_prefs(was: players.Prefs, body: PrefsInput) -> players.Prefs {
  let pick = fn(sent: Option(Option(String)), old: Option(String)) {
    case sent {
      None -> old
      Some(Some("")) | Some(None) -> None
      Some(v) -> v
    }
  }
  players.Prefs(
    quiet_start: pick(body.quiet_start, was.quiet_start),
    quiet_end: pick(body.quiet_end, was.quiet_end),
    school_hours_mute: case body.school_hours_mute {
      None | Some(None) -> was.school_hours_mute
      Some(v) -> v
    },
    timezone: pick(body.timezone, was.timezone),
  )
}

/// `GET /player/prefs`.
pub fn show_prefs(p: PlayerAccess) -> Response {
  http.json(200, prefs_view(players.prefs(p.player)))
}

/// `GET /guardian/prefs`.
pub fn show_guardian_prefs(g: Guardian) -> Response {
  http.json(200, prefs_view(guardians.prefs_of(g)))
}

fn prefs_view(p: players.Prefs) -> json.Json {
  json.object([
    #(
      "prefs",
      players.prefs_json(
        p.quiet_start,
        p.quiet_end,
        p.school_hours_mute,
        p.timezone,
      ),
    ),
    #("note", json.string(prefs_note)),
  ])
}

// ----------------------------------------------------------------------------------- a guardian's child

/// The guardian's own child, or a 404 that does not say whether the child exists.
pub fn own_child(
  ctx: Ctx,
  g: Guardian,
  id: id.PlayerId,
  next: fn(Player) -> Response,
) -> Response {
  case list.contains(g.child_ids, id) {
    False -> http.error(404, "CHILD_NOT_FOUND")
    True ->
      case store.read(ctx.store, players.by_id(_, id)) {
        Ok(Some(child)) -> next(child)
        Ok(None) -> http.error(404, "CHILD_NOT_FOUND")
        Error(failure) -> http.internal(failure)
      }
  }
}

/// A child's availability is one of three: the transfer-market values belong to adults.
pub fn child_availability(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  id: id.PlayerId,
) -> Response {
  use child <- own_child(ctx, g, id)
  let shape = {
    use availability <- input.field(
      "availability",
      input.required(
        input.one_of_these(availability.pairs, [
          availability.AvailableNow,
          availability.EndOfSeason,
          availability.NotSeeking,
        ]),
      ),
    )
    input.done(availability)
  }
  use availability <- http.body(req, shape, [
    #("availability", "BAD_AVAILABILITY"),
  ])
  act(
    ctx,
    players.set_availability(_, child.row.id, Some(availability), None),
    fn(s) {
      json.object([
        #("availability", availability.to_json(s.row.availability)),
      ])
    },
  )
}

pub fn child_medical_share(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  id: id.PlayerId,
) -> Response {
  use child <- own_child(ctx, g, id)
  share(ctx, req, child.row.id)
}

// ------------------------------------------------------------------------------------------- media and medical

const media_title_max = 160

const media_kind_max = 20

type NewMedia {
  NewMedia(
    title: Option(String),
    kind: Option(String),
    upload_id: Option(id.UploadIntentId),
    attendance_id: Option(String),
  )
}

/// `POST /player/media`: a clip. With an upload (`uploadId`, from `POST /player/uploads`) it carries its file, and
/// with an attendance of the player's own as well, the Verified Clip seal, which needs the footage. Naming an
/// upload already made into a clip answers with that clip.
pub fn media(ctx: Ctx, req: Request, p: PlayerAccess) -> Response {
  let shape = {
    use title <- input.field(
      "title",
      input.nullish(input.text(media_title_max)),
    )
    use kind <- input.field("kind", input.optional(input.text(media_kind_max)))
    use upload_id <- input.field(
      "uploadId",
      input.nullish(uploads.upload_id_field()),
    )
    use attendance_id <- input.field(
      "attendanceId",
      input.nullish(input.text(80)),
    )
    input.done(NewMedia(title:, kind:, upload_id:, attendance_id:))
  }
  use body <- http.body(req, shape, [])
  let player_id = p.player.row.id
  case input.filled(body.title) {
    None -> http.required("TITLE_REQUIRED", "title")
    Some(_) -> {
      // The title is moderated and stored as sent; only a blank one is refused.
      let title = option.unwrap(body.title, "")
      use <- moderate.or_refuse(
        ctx,
        title,
        audit.Context(
          kind: "media_title",
          player_id: Some(player_id),
          org_id: None,
          user_id: None,
          channel_id: None,
          request_id: None,
        ),
      )
      let attendance = case option.unwrap(body.attendance_id, "") {
        "" -> Ok(None)
        named ->
          list.find(p.player.attendance, fn(a) {
            id.attendance_to_string(a.id) == named
          })
          |> result.map(fn(a) { Some(a.id) })
      }
      case attendance, body.upload_id {
        Error(Nil), _ ->
          http.error_message(
            400,
            "ATTENDANCE_NOT_FOUND",
            "A verified clip must link one of YOUR verified attendances.",
          )
        Ok(None), None ->
          add_media(
            ctx,
            player_id,
            title,
            option.unwrap(body.kind, "video"),
            None,
          )
        Ok(Some(_)), None ->
          http.error_message(
            400,
            "FILE_REQUIRED_FOR_VERIFIED_CLIP",
            "Attach the actual footage to claim the Verified Clip seal.",
          )
        Ok(verified), Some(upload_id) ->
          case
            uploads.verify(
              ctx,
              upload_id,
              upload_row.PlayerClip,
              uploads.Player(player_id),
            )
          {
            Error(refusal) -> uploads.refused(refusal)
            Ok(uploads.AlreadyUsed(record_id)) ->
              stored_clip(ctx, player_id, id.media(record_id))
            Ok(uploads.Fresh(upload:, ..)) -> {
              let kind = case string.starts_with(upload.mime, "video/") {
                True -> "video"
                False -> "image"
              }
              add_media(
                ctx,
                player_id,
                title,
                kind,
                Some(#(
                  upload.id,
                  players.ClipFile(
                    blob_key: id.upload_intent_to_string(upload.id),
                    size_bytes: upload.size_bytes,
                    verified:,
                  ),
                )),
              )
            }
          }
      }
    }
  }
}

const fixture_max = 160

const venue_max = 160

const device_id_max = 120

type AttendanceInput {
  AttendanceInput(
    fixture: Option(String),
    venue: Option(String),
    date: Option(temporal.Day),
    gps: Option(#(Option(Float), Option(Float))),
    device_id: Option(String),
  )
}

/// `POST /player/attendance`: verified match attendance needs the fixture, venue, date, GPS and the device.
pub fn attendance(ctx: Ctx, req: Request, p: PlayerAccess) -> Response {
  let shape = {
    use fixture <- input.field(
      "fixture",
      input.nullish(input.text(fixture_max)),
    )
    use venue <- input.field("venue", input.nullish(input.text(venue_max)))
    use date <- input.field("date", input.nullish(input.day_or_blank()))
    use gps <- input.field(
      "gps",
      input.nullish(
        input.object({
          use lat <- input.field("lat", input.optional(input.number(-90, 90)))
          use lng <- input.field("lng", input.optional(input.number(-180, 180)))
          input.done(#(lat, lng))
        }),
      ),
    )
    use device_id <- input.field(
      "deviceId",
      input.nullish(input.text(device_id_max)),
    )
    input.done(AttendanceInput(
      fixture:,
      venue:,
      date: option.flatten(date),
      gps:,
      device_id:,
    ))
  }
  use body <- http.body(req, shape, [
    #("gps", "GPS_INVALID"),
    #("gps.*", "GPS_INVALID"),
  ])
  let gps = case body.gps {
    Some(#(Some(lat), Some(lng))) -> Some(#(lat, lng))
    _ -> None
  }
  let device =
    option.then(body.device_id, fn(d) {
      case d {
        "" -> None
        d -> Some(d)
      }
    })
  case
    input.filled(body.fixture),
    input.filled(body.venue),
    body.date,
    gps,
    device
  {
    Some(_), Some(_), Some(date), Some(#(lat, lng)), Some(_) ->
      add_attendance(
        ctx,
        p.player.row.id,
        // Stored as sent: only a blank one is refused.
        players.NewAttendance(
          fixture: option.unwrap(body.fixture, ""),
          venue: option.unwrap(body.venue, ""),
          match_date: temporal.day_text(date),
          lat:,
          lng:,
        ),
      )
    fixture, venue, date, gps, device -> {
      let missing =
        list.flatten([
          when_none(fixture, "fixture"),
          when_none(venue, "venue"),
          when_none(date, "date"),
          when_none(gps, "gps{lat,lng}"),
          when_none(device, "deviceId"),
        ])
      http.json(
        400,
        json.object([
          #("error", json.string("ATTENDANCE_UNVERIFIABLE")),
          #(
            "message",
            json.string(
              "Verified attendance needs fixture, venue, date, GPS and device data.",
            ),
          ),
          #("missing", json.array(missing, json.string)),
        ]),
      )
    }
  }
}

fn when_none(value: Option(a), name: String) -> List(String) {
  case value {
    None -> [name]
    Some(_) -> []
  }
}

fn add_attendance(
  ctx: Ctx,
  player_id: id.PlayerId,
  new: players.NewAttendance,
) -> Response {
  let now = clock.now_ms()
  let added =
    store.unit(ctx.store, fn(tx) {
      use #(item, _) <- result.try(players.add_attendance(tx, player_id, new))
      use _ <- result.try(store.seam(tx, "attendance.after_row"))
      use p <- result.try(activity.record(tx, player_id, now))
      use _ <- result.map(ledger.append(
        tx,
        ledger.Entry(
          event: ledger.Plain(ledger_row.AttendanceVerified),
          player_id: Some(player_id),
          org_id: None,
          org_name: Some("ScoutBox"),
          user_id: None,
          actor_name: Some("system"),
        ),
        now,
      ))
      live_pings.player(tx, player_id)
      #(item, p)
    })
  case added {
    Ok(#(item, p)) ->
      http.json(
        201,
        json.object([
          // The item as the TypeScript server builds it in the route, not the stored view's key order.
          #(
            "attendance",
            json.object([
              #("id", id.attendance_json(item.id)),
              #("fixture", json.string(new.fixture)),
              #("venue", json.string(new.venue)),
              #("date", json.string(new.match_date)),
              #(
                "gps",
                json.object([
                  #("lat", json_text.number(new.lat)),
                  #("lng", json_text.number(new.lng)),
                ]),
              ),
              #("deviceConfirmed", json.bool(True)),
              #("verified", json.bool(True)),
            ]),
          ),
          #("trustScore", json.int(players.profile_signal(p))),
        ]),
      )
    Error(failure) -> http.internal(failure)
  }
}

fn add_media(
  ctx: Ctx,
  player_id: id.PlayerId,
  title: String,
  kind: String,
  upload: Option(#(id.UploadIntentId, players.ClipFile)),
) -> Response {
  let now = clock.now_ms()
  let added =
    store.unit(ctx.store, fn(tx) {
      use #(clip, _) <- result.try(players.add_media(
        tx,
        player_id,
        title:,
        kind:,
        uploaded_at: clock.iso(now),
        file: option.map(upload, fn(u) { u.1 }),
      ))
      use _ <- result.try(case upload {
        Some(#(upload_id, _)) ->
          uploads.mark_used(tx, upload_id, id.media_to_string(clip.id), now)
        None -> Ok(Nil)
      })
      use _ <- result.try(store.seam(tx, "media.after_row"))
      use p <- result.map(activity.record(tx, player_id, now))
      live_pings.player(tx, player_id)
      #(clip, p)
    })
  case added, upload {
    Ok(#(clip, p)), None ->
      http.json(
        201,
        json.object([
          // The clip as the TypeScript server builds it in the route, not the stored view's key order.
          #(
            "media",
            json.object([
              #("id", id.media_json(clip.id)),
              #("title", json.string(clip.title)),
              #("kind", json.string(kind)),
              #("uploadedAt", json.string(clock.iso(now))),
              #("url", json.null()),
              #("views", json.int(0)),
              #("tags", json.object([])),
              #("verifiedClip", json.null()),
            ]),
          ),
          #("trustScore", json.int(players.profile_signal(p))),
        ]),
      )
    Ok(#(clip, p)), Some(_) -> clip_answer(p, clip.id)
    Error(store.Lost(what)), _ -> http.stale(what)
    Error(failure), _ -> http.internal(failure)
  }
}

/// A clip with its file, as the player's record shows it: what naming its upload answers, the first time or again.
fn clip_answer(p: Player, media_id: id.MediaId) -> Response {
  case list.find(p.media, fn(m) { m.clip.id == media_id }) {
    // The upload's clip is gone: removed since, so the upload names nothing now.
    Error(Nil) -> http.error(404, "UPLOAD_NOT_FOUND")
    Ok(m) ->
      http.json(
        201,
        json.object([
          #("media", players.media_json(m)),
          #("trustScore", json.int(players.profile_signal(p))),
        ]),
      )
  }
}

fn stored_clip(
  ctx: Ctx,
  player_id: id.PlayerId,
  media_id: id.MediaId,
) -> Response {
  case store.read(ctx.store, players.by_id(_, player_id)) {
    Ok(Some(p)) -> clip_answer(p, media_id)
    Ok(None) -> http.error(404, "UPLOAD_NOT_FOUND")
    Error(failure) -> http.internal(failure)
  }
}

const medical_type_max = 40

const medical_title_max = 160

const max_layoff_weeks = 520

const condition_status_max = 40

type MedicalRecord {
  MedicalRecord(
    type_: Option(String),
    title: Option(String),
    date: Option(temporal.Day),
    layoff_weeks: Option(Float),
    cleared: Option(Bool),
    condition_status: Option(String),
  )
}

/// `POST /player/medical/records`: a record, the condition status, or both. Answers with the medical record.
pub fn medical_record(ctx: Ctx, req: Request, p: PlayerAccess) -> Response {
  let shape = {
    use type_ <- input.field(
      "type",
      input.nullish(input.text(medical_type_max)),
    )
    use title <- input.field(
      "title",
      input.nullish(input.text(medical_title_max)),
    )
    use date <- input.field("date", input.nullish(input.day_or_blank()))
    use layoff_weeks <- input.field(
      "layoffWeeks",
      input.nullish(input.number(0, max_layoff_weeks)),
    )
    use cleared <- input.field("cleared", input.nullish(input.boolean()))
    use condition_status <- input.field(
      "conditionStatus",
      input.nullish(input.text(condition_status_max)),
    )
    input.done(MedicalRecord(
      type_:,
      title:,
      date: option.flatten(date),
      layoff_weeks:,
      cleared:,
      condition_status:,
    ))
  }
  use body <- http.body(req, shape, [])
  let id = p.player.row.id
  let now = clock.now_ms()
  let stored =
    store.unit(ctx.store, fn(tx) {
      use _ <- result.try(case body.condition_status {
        None | Some("") -> Ok(Nil)
        Some(status) ->
          players.set_condition_status(tx, id, status) |> result.replace(Nil)
      })
      use _ <- result.try(store.seam(tx, "medical.records.after_row"))
      use _ <- result.try(case body.title {
        None | Some("") -> Ok(Nil)
        Some(title) ->
          players.add_medical_record(
            tx,
            id,
            players.NewMedicalRecord(
              type_: case body.type_ {
                None | Some("") -> "note"
                Some(t) -> t
              },
              title:,
              date: body.date
                |> option.unwrap(temporal.day_of(now))
                |> temporal.day_text,
              layoff_weeks: body.layoff_weeks,
              cleared: body.cleared,
            ),
          )
          |> result.replace(Nil)
      })
      use found <- result.map(players.by_id(store.reading(tx), id))
      let assert Some(p) = found as "the signed-in player is live"
      live_pings.player(tx, id)
      p
    })
  case stored {
    Ok(p) -> http.json(201, players.medical_view(p))
    Error(failure) -> http.internal(failure)
  }
}

type Point {
  Point(lat: Float, lng: Float)
}

/// `POST /player/location`: the point the Grassroots radius is measured from.
pub fn location(ctx: Ctx, req: Request, p: PlayerAccess) -> Response {
  let shape = {
    use lat <- input.field("lat", input.required(input.number(-90, 90)))
    use lng <- input.field("lng", input.required(input.number(-180, 180)))
    input.done(Point(lat:, lng:))
  }
  use at <- http.body(req, shape, [
    #("lat", "BAD_COORDINATES"),
    #("lng", "BAD_COORDINATES"),
  ])
  act(ctx, players.set_location(_, p.player.row.id, at.lat, at.lng), fn(_) {
    json.object([#("ok", json.bool(True))])
  })
}

type DrillDone {
  DrillDone(value: Option(Float), clip: Option(id.MediaId))
}

/// `POST /player/drills/:id/complete`: the drill is done, and a measured result is kept, verified when it names
/// a clip of the player's own that carries its footage (`mediaId`). The result doesn't keep the clip.
pub fn complete_drill(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  drill_id: String,
) -> Response {
  case list.find(benchmarks.drills, fn(d) { d.id == drill_id }) {
    Error(_) -> http.error(404, "DRILL_NOT_FOUND")
    Ok(drill) -> {
      let shape = {
        use value <- input.field(
          "value",
          input.nullish(input.number_at_least(0)),
        )
        use clip <- input.field("mediaId", input.nullish(input.text(80)))
        input.done(DrillDone(value:, clip: option.map(clip, id.media)))
      }
      use body <- http.body(req, shape, [#("value", "BAD_VALUE")])
      use <- drill_clip_or_refuse(p.player, body.clip)
      let me = p.player.row.id
      let now = clock.now_ms()
      act(
        ctx,
        fn(tx) {
          use _ <- result.try(drill_clip_stands(tx, me, body.clip))
          use _ <- result.try(case list.contains(p.player.drills, drill.id) {
            True -> Ok(Nil)
            False -> players.record_drill(tx, me, drill.id)
          })
          use _ <- result.try(case body.value {
            None -> Ok(Nil)
            Some(value) -> {
              use result_id <- result.try(ids.next(tx, "combine"))
              players.add_drill_result(
                tx,
                me,
                drill_result_row.Row(
                  id: id.drill_result(result_id),
                  player_id: me,
                  position: 0,
                  drill_id: drill.id,
                  drill_name: Some(drill.name),
                  metric: drill.metric,
                  unit: Some(drill.unit),
                  value:,
                  verified: body.clip != None,
                  recorded_at: now,
                ),
              )
            }
          })
          activity.record(tx, me, now)
        },
        fn(stored) {
          json.object([
            #("drills", json.array(stored.drills, json.string)),
            #(
              "drillResults",
              json.array(stored.drill_results, players.drill_result_json),
            ),
          ])
        },
      )
    }
  }
}

/// A clip named to verify a drill result is one of the player's own, with its file.
fn drill_clip_or_refuse(
  player: Player,
  clip: Option(id.MediaId),
  next: fn() -> Response,
) -> Response {
  case clip {
    None -> next()
    Some(mid) ->
      case list.find(player.media, fn(m) { m.clip.id == mid }) {
        Error(Nil) -> http.error(404, "MEDIA_NOT_FOUND")
        Ok(m) if m.clip.blob_key == None ->
          http.error_message(
            400,
            "FILE_REQUIRED_FOR_VERIFIED_RESULT",
            "Name a clip with its footage to verify the result.",
          )
        Ok(_) -> next()
      }
  }
}

/// Inside the unit: the clip checked before it is still there (erasure may have removed it since).
fn drill_clip_stands(
  tx: Tx,
  player_id: id.PlayerId,
  clip: Option(id.MediaId),
) -> Result(Nil, store.Fail(Nil)) {
  case clip {
    None -> Ok(Nil)
    Some(mid) -> {
      use found <- result.try(store.one(
        store.reading(tx),
        "SELECT 1 FROM player_media WHERE id = ? AND player_id = ? AND blob_key IS NOT NULL",
        [id.media_sql(mid), id.player_sql(player_id)],
        decode.at([0], decode.int),
      ))
      case found {
        Ok(_) -> Ok(Nil)
        Error(Nil) -> store.stale("drill clip")
      }
    }
  }
}

/// `POST /player/media/:id/captions`: a WebVTT caption track for one of the player's own clips, stored as sent.
pub fn captions(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  media_id: String,
) -> Response {
  // The path names the clip.
  let mid = id.media(media_id)
  case list.find(p.player.media, fn(m) { m.clip.id == mid }) {
    Error(Nil) -> http.error(404, "MEDIA_NOT_FOUND")
    Ok(m) -> {
      let shape = {
        use vtt <- input.field("vtt", input.nullish(input.text(100_000_000)))
        input.done(option.unwrap(vtt, ""))
      }
      use vtt <- http.body(req, shape, [])
      case
        string.starts_with(string.trim(vtt), "WEBVTT"),
        input.utf16_length(vtt) > 200_000
      {
        False, _ ->
          http.error_message(
            400,
            "VTT_REQUIRED",
            "Captions are a WebVTT track (starts with \"WEBVTT\").",
          )
        True, True -> http.error(413, "CAPTIONS_TOO_LARGE")
        True, False -> {
          let saved =
            store.unit(ctx.store, fn(tx) {
              live_pings.player(tx, p.player.row.id)
              store.run(
                tx,
                "UPDATE player_media SET captions = ? WHERE id = ?",
                [
                  sqlight.text(vtt),
                  id.media_sql(m.clip.id),
                ],
              )
            })
          case saved {
            Error(failure) -> http.internal(failure)
            Ok(Nil) ->
              http.json(
                200,
                json.object([
                  #(
                    "media",
                    json.object([
                      #("id", id.media_json(m.clip.id)),
                      #("captions", json.bool(True)),
                    ]),
                  ),
                ]),
              )
          }
        }
      }
    }
  }
}
