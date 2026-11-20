//// The player's own record: what they see of it, and the switches and figures they set
//// (domains/development/record.mjs, grassroots.mjs; identity/players.mjs `/me`; messaging/notify.mjs prefs). A
//// write answers with the stored record, read back after the act.
////
//// A child's settings are the guardian's: the routes that change one refuse a minor with GUARDIAN_MANAGED, and
//// the guardian sets them from `/guardian/children/:id`.

import gleam/float
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/development/activity
import scoutbox/identity/access.{type PlayerAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/players.{type Player}
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/json_text
import scoutbox/platform/store.{type Tx}
import scoutbox/platform/temporal
import scoutbox/platform/zones
import scoutbox/recruitment/signing_reads
import scoutbox/rows/id
import scoutbox/rows/ledger as ledger_row
import scoutbox/rows/players as row
import scoutbox/rules/journey
import scoutbox/safety/audit
import scoutbox/safety/ledger
import scoutbox/safety/moderate
import scoutbox/verification/vouch_view
import scoutbox/vocab/availability
import scoutbox/vocab/playing_level
import wisp.{type Request, type Response}

const fresh_start = "Fresh Start"

const badges_max = 6

const badge_max = 60

/// Runs an act on the player and answers with what `view` makes of the stored record.
fn act(
  ctx: Ctx,
  work: fn(Tx) -> Result(Player, store.Fail(Nil)),
  view: fn(Player) -> json.Json,
) -> Response {
  case store.unit(ctx.store, work) {
    Ok(p) -> http.json(200, view(p))
    Error(failure) -> http.internal(failure)
  }
}

/// `GET /player/me`.
///
/// Not ported yet: the published coach vouches (verification).
pub fn me(p: PlayerAccess) -> Response {
  let now = clock.now_ms()
  let player = p.player
  let score = players.profile_signal(player)
  http.json(
    200,
    json.object(
      list.append(players.self_fields(player), [
        #("age", json.nullable(players.age_now(player, now), json.int)),
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
      use on <- http.body(req, enabled_shape("enabled"), [])
      act(
        ctx,
        players.set_switch(_, p.player.row.id, players.FirstTeamSeeker, on),
        fn(s) {
          json.object([#("firstTeamSeeker", json.bool(s.row.first_team_seeker))])
        },
      )
    }
  }
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
///
/// Not ported yet: `season` files the figures into the season history; it is refused as not supported.
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
    Ok(_), Some(_) ->
      http.error_message(
        501,
        "NOT_PORTED",
        "Filing figures into a past season is not supported by this server yet.",
      )
    Ok(figures), None ->
      act(
        ctx,
        fn(tx) {
          use _ <- result.try(players.record_stats(tx, p.player.row.id, figures))
          activity.record(tx, p.player.row.id, clock.now_ms())
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
      input.required(input.list_of(input.required_text(badge_max), badges_max)),
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
  let blank_is_none = fn(v: Option(String)) {
    case v {
      Some("") -> None
      other -> other
    }
  }
  let zone =
    option.then(body.timezone, fn(z) { blank_is_none(z) |> option.map(Some) })
  case zone {
    Some(Some(z)) ->
      case zones.parse(z) {
        Error(Nil) ->
          http.error_message(
            400,
            "TIMEZONE_INVALID",
            "timezone must be an IANA time zone name, for example Europe/London.",
          )
        Ok(_) -> save_prefs(ctx, p.player, body)
      }
    _ -> save_prefs(ctx, p.player, body)
  }
}

fn save_prefs(ctx: Ctx, p: Player, body: PrefsInput) -> Response {
  let was = players.prefs(p)
  let pick = fn(sent: Option(Option(String)), old: Option(String)) {
    case sent {
      None -> old
      Some(Some("")) | Some(None) -> None
      Some(v) -> v
    }
  }
  let next =
    players.Prefs(
      quiet_start: pick(body.quiet_start, was.quiet_start),
      quiet_end: pick(body.quiet_end, was.quiet_end),
      school_hours_mute: case body.school_hours_mute {
        None | Some(None) -> was.school_hours_mute
        Some(v) -> v
      },
      timezone: pick(body.timezone, was.timezone),
    )
  act(ctx, players.set_prefs(_, p.row.id, next), prefs_view)
}

/// `GET /player/prefs`.
pub fn show_prefs(p: PlayerAccess) -> Response {
  http.json(200, prefs_view(p.player))
}

fn prefs_view(p: Player) -> json.Json {
  json.object([
    #(
      "prefs",
      players.prefs_json(
        p.row.prefs_quiet_start,
        p.row.prefs_quiet_end,
        p.row.prefs_school_hours_mute,
        p.row.prefs_timezone,
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

/// A data URL's length the TypeScript server accepts: about 12MB of video.
const data_url_max = 16_000_000

type NewMedia {
  NewMedia(
    title: Option(String),
    kind: Option(String),
    data_url: Option(String),
    attendance_id: Option(String),
  )
}

/// `POST /player/media`: a clip, and with an attendance of the player's own, the Verified Clip seal.
///
/// Not ported yet: the upload itself (`dataUrl`, which the storage adapter writes to disk), and so the Verified
/// Clip seal, which needs the footage; the `players` live event.
pub fn media(ctx: Ctx, req: Request, p: PlayerAccess) -> Response {
  let shape = {
    use title <- input.field(
      "title",
      input.nullish(input.text(media_title_max)),
    )
    use kind <- input.field("kind", input.optional(input.text(media_kind_max)))
    use data_url <- input.field(
      "dataUrl",
      input.nullish(input.text(data_url_max * 2)),
    )
    use attendance_id <- input.field(
      "attendanceId",
      input.nullish(input.text(80)),
    )
    input.done(NewMedia(title:, kind:, data_url:, attendance_id:))
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
      case
        option.unwrap(body.data_url, ""),
        option.unwrap(body.attendance_id, "")
      {
        "", "" ->
          add_media(ctx, player_id, title, option.unwrap(body.kind, "video"))
        "", attendance_id ->
          case
            list.any(p.player.attendance, fn(a) {
              id.attendance_to_string(a.id) == attendance_id
            })
          {
            False ->
              http.error_message(
                400,
                "ATTENDANCE_NOT_FOUND",
                "A verified clip must link one of YOUR verified attendances.",
              )
            True ->
              http.error_message(
                400,
                "FILE_REQUIRED_FOR_VERIFIED_CLIP",
                "Attach the actual footage to claim the Verified Clip seal.",
              )
          }
        data_url, _ ->
          case
            string.starts_with(data_url, "data:"),
            string.length(data_url) > data_url_max
          {
            False, _ -> http.error(400, "BAD_DATA_URL")
            True, True ->
              http.error_message(
                413,
                "FILE_TOO_LARGE",
                "Uploads are capped at ~12MB in this prototype.",
              )
            True, False ->
              http.error_message(
                501,
                "NOT_PORTED",
                "Uploads are not supported by this server yet.",
              )
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
///
/// Not ported yet: the `players` live event.
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
          entry_type: ledger_row.AttendanceVerified,
          player_id: Some(player_id),
          org_id: None,
          org_name: Some("ScoutBox"),
          user_id: None,
          actor_name: Some("system"),
        ),
        now,
      ))
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
      ))
      use _ <- result.try(store.seam(tx, "media.after_row"))
      use p <- result.map(activity.record(tx, player_id, now))
      #(clip, p)
    })
  case added {
    Ok(#(clip, p)) ->
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
///
/// Not ported yet: the `players` live event.
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
      p
    })
  case stored {
    Ok(p) -> http.json(201, players.medical_view(p))
    Error(failure) -> http.internal(failure)
  }
}
