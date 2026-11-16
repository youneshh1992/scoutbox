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
import scoutbox/app.{type Ctx}
import scoutbox/development/activity
import scoutbox/identity/access.{type PlayerAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/players.{type Player}
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/store.{type Tx}
import scoutbox/rows/players as row
import scoutbox/rules/journey
import scoutbox/rules/time_zones
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
  case
    store.unit(ctx.store, fn(tx) { work(tx) |> result.map(fn(p) { #(p, []) }) })
  {
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
        #("vouches", json.preprocessed_array([])),
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

fn share(ctx: Ctx, req: Request, id: String) -> Response {
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
    availability: Option(row.Availability),
    contract_status: Option(row.ContractStatus),
  )
}

/// `POST /player/availability`.
///
/// Not ported yet: a contract a completed signing records (recruitment's signings) makes the status canonical
/// and refuses a change here; this server has no signings, so none is.
pub fn availability(ctx: Ctx, req: Request, p: PlayerAccess) -> Response {
  use <- access.guardian_managed_only(p)
  let shape = {
    use availability <- input.field(
      "availability",
      input.nullish(input.one_of(row.availability_pairs)),
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
    _ ->
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
            #(
              "availability",
              json.string(row.availability_to_string(s.row.availability)),
            ),
            #(
              "contractStatus",
              json.string(row.contract_status_to_string(s.row.contract_status)),
            ),
          ])
        },
      )
  }
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
      case list.contains(time_zones.names, z) {
        False ->
          http.error_message(
            400,
            "TIMEZONE_INVALID",
            "timezone must be an IANA time zone name, for example Europe/London.",
          )
        True -> save_prefs(ctx, p.player, body)
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
  act(ctx, players.set_prefs(_, p.row.id, next), fn(s) {
    json.object([
      #(
        "prefs",
        players.prefs_json(
          s.row.prefs_quiet_start,
          s.row.prefs_quiet_end,
          s.row.prefs_school_hours_mute,
          s.row.prefs_timezone,
        ),
      ),
      #("note", json.string(prefs_note)),
    ])
  })
}

// ----------------------------------------------------------------------------------- a guardian's child

/// The guardian's own child, or a 404 that does not say whether the child exists.
pub fn own_child(
  ctx: Ctx,
  g: Guardian,
  id: String,
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
  id: String,
) -> Response {
  use child <- own_child(ctx, g, id)
  let shape = {
    use availability <- input.field(
      "availability",
      input.required(
        input.one_of([
          #("available_now", row.AvailableNow),
          #("end_of_season", row.EndOfSeason),
          #("not_seeking", row.NotSeeking),
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
        #(
          "availability",
          json.string(row.availability_to_string(s.row.availability)),
        ),
      ])
    },
  )
}

pub fn child_medical_share(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  id: String,
) -> Response {
  use child <- own_child(ctx, g, id)
  share(ctx, req, child.row.id)
}
