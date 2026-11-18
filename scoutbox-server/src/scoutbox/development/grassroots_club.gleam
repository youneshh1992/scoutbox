//// A grassroots club's own operations (domains/development/grassrootsClub.mjs): its squad, its open trial days
//// and the friendlies board. Only a club on ScoutBox Grassroots has them.
////
//// Not ported yet: the squad's release; the match days' list; listing, editing and deleting
//// open days, their registrations and outcomes; the friendlies board's list and responses; the `openTrials` and
//// `friendlies` live events.

import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/development/activity
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/orgs
import scoutbox/identity/players
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/store.{type Read}
import scoutbox/rows/friendlies as friendly_row
import scoutbox/rows/id
import scoutbox/rows/ledger as ledger_row
import scoutbox/rows/matchday_players as matchday_player_row
import scoutbox/rows/matchdays as matchday_row
import scoutbox/rows/open_trial_positions as position_row
import scoutbox/rows/open_trials as trial_row
import scoutbox/rows/org_squad_members as squad_row
import scoutbox/rows/orgs as org_row
import scoutbox/safety/audit
import scoutbox/safety/ledger
import scoutbox/safety/moderate
import scoutbox/vocab/audience
import sqlight
import wisp.{type Request, type Response}

const title_max = 160

const venue_max = 160

const age_group_max = 40

const notes_max = 2000

const position_max = 40

const positions_max = 20

const squad_name_max = 120

const squad_position_max = 40

fn grassroots_only(a: OrgAccess, next: fn() -> Response) -> Response {
  case a.org.level {
    Some(org_row.LevelGrassroots) -> next()
    _ ->
      http.error_message(
        403,
        "GRASSROOTS_ORGS_ONLY",
        "Open days are a ScoutBox Grassroots feature.",
      )
  }
}

fn context(kind: String, a: OrgAccess) -> audit.Context {
  audit.Context(
    kind:,
    player_id: None,
    org_id: Some(a.org.id),
    user_id: None,
    channel_id: None,
    request_id: None,
  )
}

/// Moderates `notes` when there are any.
fn moderated(
  ctx: Ctx,
  notes: Option(String),
  context: audit.Context,
  next: fn() -> Response,
) -> Response {
  case notes {
    None | Some("") -> next()
    Some(text) -> moderate.or_refuse(ctx, text, context, next)
  }
}

/// Trimmed, or `default` when nothing is left.
fn trimmed_or(text: Option(String), default: String) -> String {
  case option.map(text, string.trim) {
    Some("") | None -> default
    Some(t) -> t
  }
}

// ------------------------------------------------------------------------------------------------- squad

type SquadEntry {
  SquadEntry(
    name: Option(String),
    position: Option(String),
    player_id: Option(String),
  )
}

/// `POST /org/squad`: a player added by hand. A linked player must be one the club may see, and not on the
/// squad already.
pub fn add_to_squad(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use <- grassroots_only(a)
  let shape = {
    use name <- input.field("name", input.nullish(input.text(squad_name_max)))
    use position <- input.field(
      "position",
      input.nullish(input.text(squad_position_max)),
    )
    use player_id <- input.field("playerId", input.nullish(input.text(80)))
    input.done(SquadEntry(name:, position:, player_id:))
  }
  use body <- http.body(req, shape, [])
  let now = clock.now_ms()
  case input.filled(body.name) {
    None -> http.required("NAME_REQUIRED", "name")
    Some(name) -> {
      let player_id = case body.player_id {
        None | Some("") -> None
        // From the request body.
        Some(p) -> Some(id.player(p))
      }
      let added =
        store.unit(ctx.store, fn(tx) {
          let read = store.reading(tx)
          use _ <- result.try(case player_id {
            None -> Ok(Nil)
            Some(player_id) -> {
              use seen <- result.try(players.for_org(
                read,
                player_id,
                a.org,
                now,
              ))
              case seen {
                Some(#(_, access)) if access.visible -> {
                  use on <- result.try(on_squad(read, a.org.id, player_id))
                  case on {
                    True -> store.refuse(AlreadyOnSquad)
                    False -> Ok(Nil)
                  }
                }
                _ -> store.refuse(PlayerNotVisible)
              }
            }
          })
          use entry_id <- result.try(id.next_squad_entry(tx))
          use _ <- result.try(squad_row.insert(
            tx,
            squad_row.Row(
              id: entry_id,
              org_id: a.org.id,
              player_id:,
              name: string.trim(name),
              position: case body.position {
                Some("") -> None
                position -> position
              },
              source: squad_row.Manual,
              approved_by_label: None,
              added_at: now,
            ),
          ))
          squad_view(read, a.org.id)
        })
      case added {
        Ok(view) -> http.json(201, view)
        Error(store.Refused(PlayerNotVisible)) ->
          http.error(403, "PLAYER_NOT_VISIBLE")
        Error(store.Refused(AlreadyOnSquad)) ->
          http.error(409, "ALREADY_ON_SQUAD")
        Error(failure) -> http.internal(failure)
      }
    }
  }
}

type SquadRefusal {
  PlayerNotVisible
  AlreadyOnSquad
}

fn on_squad(
  read: Read,
  org_id: id.OrgId,
  player_id: id.PlayerId,
) -> Result(Bool, store.Fail(e)) {
  use found <- result.map(store.one(
    read,
    "SELECT 1 FROM org_squad_members WHERE org_id = ? AND player_id = ?",
    [id.org_sql(org_id), id.player_sql(player_id)],
    decode.at([0], decode.int),
  ))
  result.is_ok(found)
}

/// The position groups the squad's coverage is counted in. The Pro squad planner's shadow list is not part of
/// the squad.
const position_groups = [
  #("GK", ["GK"]),
  #("DEF", ["CB", "RB", "LB", "RWB", "LWB"]),
  #("MID", ["CDM", "CM", "CAM"]),
  #("ATT", ["ST", "CF", "RW", "LW"]),
]

fn squad_view(read: Read, org_id: id.OrgId) -> Result(Json, store.Fail(e)) {
  use entries <- result.try(store.query(
    read,
    "SELECT "
      <> squad_row.columns
      <> " FROM org_squad_members WHERE org_id = ? ORDER BY rowid",
    [id.org_sql(org_id)],
    squad_row.decoder(),
  ))
  use linked <- result.map(players.by_ids(
    read,
    list.filter_map(entries, fn(e) { option.to_result(e.player_id, Nil) }),
  ))
  let coverage =
    list.map(position_groups, fn(group) {
      let #(name, positions) = group
      #(
        name,
        list.count(entries, fn(e) {
          case e.position {
            Some(p) -> list.contains(positions, p)
            None -> False
          }
        }),
      )
    })
  let gaps =
    list.filter_map(coverage, fn(c) {
      case c.1 < 2 {
        True -> Ok(c.0)
        False -> Error(Nil)
      }
    })
  let suggested =
    list.flat_map(gaps, fn(g) {
      list.key_find(position_groups, g) |> result.unwrap([]) |> list.take(2)
    })
    |> list.take(5)
  json.object([
    #(
      "entries",
      json.array(entries, fn(e) {
        let player =
          option.then(e.player_id, fn(pid) {
            list.find(linked, fn(p) { p.row.id == pid }) |> option.from_result
          })
        json.object(
          list.flatten([
            [
              #("id", id.squad_entry_json(e.id)),
              #("name", json.string(e.name)),
              #("position", json.nullable(e.position, json.string)),
              #("playerId", json.nullable(e.player_id, id.player_json)),
              #("source", squad_row.source_to_json(e.source)),
            ],
            case e.approved_by_label {
              Some(label) -> [#("approvedBy", json.string(label))]
              None -> []
            },
            [
              #("addedAt", json.int(e.added_at)),
              #("onPlatform", json.bool(player != None)),
              #(
                "trustScore",
                json.nullable(
                  option.map(player, players.profile_signal),
                  json.int,
                ),
              ),
            ],
          ]),
        )
      }),
    ),
    #(
      "coverage",
      json.object(list.map(coverage, fn(c) { #(c.0, json.int(c.1)) })),
    ),
    #("gaps", json.array(gaps, json.string)),
    #("suggestedLookingFor", json.array(suggested, json.string)),
  ])
}

// ------------------------------------------------------------------------------------------- open trial days

type OpenTrial {
  OpenTrial(
    title: Option(String),
    date: Option(String),
    venue: Option(String),
    age_group: Option(String),
    positions: Option(List(String)),
    notes: Option(String),
  )
}

/// `POST /org/open-trials`. No ghosting: registrants of a past open day still waiting for an answer block the
/// next posting, as unfiled trial reports block new trials.
pub fn post_open_trial(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use <- grassroots_only(a)
  let shape = {
    use title <- input.field("title", input.nullish(input.text(title_max)))
    use date <- input.field("date", input.nullish(input.day_or_blank()))
    use venue <- input.field("venue", input.nullish(input.text(venue_max)))
    use age_group <- input.field(
      "ageGroup",
      input.nullish(input.text(age_group_max)),
    )
    use positions <- input.field(
      "positions",
      input.nullish(input.list_of(
        input.required_text(position_max),
        positions_max,
      )),
    )
    use notes <- input.field("notes", input.nullish(input.text(notes_max)))
    input.done(OpenTrial(
      title:,
      date: option.flatten(date),
      venue:,
      age_group:,
      positions:,
      notes:,
    ))
  }
  use body <- http.body(req, shape, [])
  let now = clock.now_ms()
  case
    store.read(ctx.store, unresolved_before(_, a.org.id, clock.iso_day(now)))
  {
    Error(failure) -> http.internal(failure)
    Ok(unresolved) if unresolved > 0 ->
      http.error_message(
        409,
        "OUTCOMES_OUTSTANDING",
        int.to_string(unresolved)
          <> " player(s) from your past open day(s) are still waiting for an answer. Resolve them (invite or a kind no) before posting the next one.",
      )
    Ok(_) ->
      case input.filled(body.title), body.date, input.filled(body.venue) {
        Some(_), Some(date), Some(_) -> {
          use <- moderated(ctx, body.notes, context("open_trial_notes", a))
          let wanted =
            option.unwrap(body.positions, [])
            |> list.map(string.trim)
            |> list.unique
          let posted =
            store.unit(ctx.store, fn(tx) {
              use trial_id <- result.try(id.next_open_trial(tx))
              let trial =
                trial_row.Row(
                  id: trial_id,
                  org_id: a.org.id,
                  title: trimmed_or(body.title, ""),
                  trial_date: date,
                  venue: trimmed_or(body.venue, ""),
                  age_group: trimmed_or(body.age_group, "open"),
                  notes: option.unwrap(body.notes, ""),
                  created_by_user_id: a.user.id,
                  created_at: now,
                  deleted_at: None,
                )
              use _ <- result.try(trial_row.insert(tx, trial))
              use _ <- result.try(
                list.index_map(wanted, fn(p, i) { #(i, p) })
                |> list.try_each(fn(entry) {
                  position_row.insert(
                    tx,
                    position_row.Row(
                      open_trial_id: trial_id,
                      ord: entry.0,
                      position: entry.1,
                    ),
                  )
                }),
              )
              use _ <- result.map(ledger.append(
                tx,
                ledger.Entry(
                  entry_type: ledger_row.OpenTrialPosted,
                  player_id: None,
                  org_id: Some(a.org.id),
                  org_name: Some(a.org.name),
                  user_id: Some(a.user.id),
                  actor_name: Some(a.user.name),
                ),
                now,
              ))
              trial
            })
          case posted {
            Ok(trial) ->
              http.json(
                201,
                json.object([
                  #("openTrial", open_trial_view(trial, a.org.name, wanted)),
                ]),
              )
            Error(failure) -> http.internal(failure)
          }
        }
        _, _, _ -> http.error(400, "TITLE_DATE_VENUE_REQUIRED")
      }
  }
}

fn unresolved_before(
  read: Read,
  org_id: id.OrgId,
  today: String,
) -> Result(Int, store.Fail(e)) {
  use found <- result.map(store.one(
    read,
    "SELECT COUNT(*) FROM open_trial_registrations r JOIN open_trials t ON t.id = r.open_trial_id WHERE t.org_id = ? AND t.deleted_at IS NULL AND t.trial_date < ? AND r.outcome IS NULL",
    [id.org_sql(org_id), sqlight.text(today)],
    decode.at([0], decode.int),
  ))
  result.unwrap(found, 0)
}

/// A new open day, with no registrations yet. A club's name is read live, not copied when it posted.
fn open_trial_view(
  t: trial_row.Row,
  org_name: String,
  positions: List(String),
) -> Json {
  json.object([
    #("id", id.open_trial_json(t.id)),
    #("orgId", id.org_json(t.org_id)),
    #("orgName", json.string(org_name)),
    #("title", json.string(t.title)),
    #("date", json.string(t.trial_date)),
    #("venue", json.string(t.venue)),
    #("ageGroup", json.string(t.age_group)),
    #("positions", json.array(positions, json.string)),
    #("notes", json.string(t.notes)),
    #("createdByUserId", id.org_user_json(t.created_by_user_id)),
    #("createdAt", json.int(t.created_at)),
    #("registrations", json.preprocessed_array([])),
  ])
}

// ---------------------------------------------------------------------------------------------- friendlies

type Friendly {
  Friendly(
    age_group: Option(String),
    date: Option(String),
    venue: Option(String),
    notes: Option(String),
  )
}

/// `POST /org/friendlies`: a friendly the club is looking for, on the board for clubs within the radius.
pub fn post_friendly(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use <- grassroots_only(a)
  let shape = {
    use age_group <- input.field(
      "ageGroup",
      input.nullish(input.text(age_group_max)),
    )
    use date <- input.field("date", input.nullish(input.day_or_blank()))
    use venue <- input.field("venue", input.nullish(input.text(venue_max)))
    use notes <- input.field("notes", input.nullish(input.text(notes_max)))
    input.done(Friendly(age_group:, date: option.flatten(date), venue:, notes:))
  }
  use body <- http.body(req, shape, [])
  case body.date {
    None -> http.required("DATE_REQUIRED", "date")
    Some(date) -> {
      use <- moderated(ctx, body.notes, context("friendly_notes", a))
      let now = clock.now_ms()
      let posted =
        store.unit(ctx.store, fn(tx) {
          use friendly_id <- result.try(id.next_friendly(tx))
          let friendly =
            friendly_row.Row(
              id: friendly_id,
              org_id: a.org.id,
              posted_by_user_id: a.user.id,
              age_group: trimmed_or(body.age_group, "open"),
              match_date: date,
              venue: trimmed_or(
                body.venue,
                input.utf16_take(option.unwrap(a.org.city, ""), venue_max),
              ),
              notes: option.unwrap(body.notes, ""),
              created_at: now,
            )
          friendly_row.insert(tx, friendly) |> result.replace(friendly)
        })
      case posted {
        Ok(f) ->
          http.json(
            201,
            json.object([#("friendly", own_friendly_view(f, a.org.name))]),
          )
        Error(failure) -> http.internal(failure)
      }
    }
  }
}

/// The poster's own friendly, just posted: no responses yet, and no distance to itself.
fn own_friendly_view(f: friendly_row.Row, org_name: String) -> Json {
  json.object([
    #("id", id.friendly_json(f.id)),
    #("orgId", id.org_json(f.org_id)),
    #("orgName", json.string(org_name)),
    #("postedByUserId", id.org_user_json(f.posted_by_user_id)),
    #("ageGroup", json.string(f.age_group)),
    #("date", json.string(f.match_date)),
    #("venue", json.string(f.venue)),
    #("notes", json.string(f.notes)),
    #("status", json.string("open")),
    #("createdAt", json.int(f.created_at)),
    #("mine", json.bool(True)),
    #("distanceKm", json.int(0)),
    #("responses", json.preprocessed_array([])),
  ])
}

/// `GET /org/squad`: the squad, its coverage by position group, its gaps and the positions to look for.
pub fn squad(ctx: Ctx, a: OrgAccess) -> Response {
  use <- grassroots_only(a)
  case store.read(ctx.store, squad_view(_, a.org.id)) {
    Ok(view) -> http.json(200, view)
    Error(e) -> http.internal(e)
  }
}

// ---------------------------------------------------------------------------------------------- match days

const fixture_max = 160

const result_max = 20

const matchday_players_max = 100

type Matchday {
  Matchday(
    fixture: Option(String),
    venue: Option(String),
    date: Option(String),
    result: Option(String),
    player_ids: List(String),
  )
}

/// `POST /org/matchday`: a fixture the club played. Each named player on its squad whom it may see is credited
/// with a verified, coach-signed attendance; anyone else named is skipped, a shadowed player included.
///
/// Not ported yet: the live 'players' event.
pub fn log_matchday(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use <- grassroots_only(a)
  let shape = {
    use fixture <- input.field(
      "fixture",
      input.nullish(input.text(fixture_max)),
    )
    use venue <- input.field("venue", input.nullish(input.text(venue_max)))
    use date <- input.field("date", input.nullish(input.day_or_blank()))
    use result <- input.field("result", input.nullish(input.text(result_max)))
    use player_ids <- input.field(
      "playerIds",
      input.nullish(input.items(input.id(), matchday_players_max)),
    )
    input.done(Matchday(
      fixture:,
      venue:,
      date: option.flatten(date),
      result:,
      player_ids: option.unwrap(player_ids, []),
    ))
  }
  use body <- http.body(req, shape, [])
  case input.filled(body.fixture), body.date {
    Some(fixture), Some(date) -> {
      let now = clock.now_ms()
      let venue = option.map(body.venue, string.trim)
      let logged =
        store.unit(ctx.store, fn(tx) {
          let read = store.reading(tx)
          use credited <- result.try(
            list.unique(body.player_ids)
            |> list.try_fold([], fn(credited, pid) {
              let pid = id.player(pid)
              use on <- result.try(on_squad(read, a.org.id, pid))
              use seen <- result.try(case on {
                True -> players.for_org(read, pid, a.org, now)
                False -> Ok(None)
              })
              case seen {
                Some(#(p, access)) if access.visible -> {
                  use _ <- result.try(players.add_club_attendance(
                    tx,
                    p.row.id,
                    fixture,
                    case venue {
                      Some("") | None -> option.unwrap(a.org.city, "")
                      Some(v) -> v
                    },
                    date,
                    option.map(orgs.location(a.org), fn(l) { #(l.lat, l.lng) }),
                    a.org.name,
                  ))
                  use _ <- result.try(activity.record(tx, p.row.id, now))
                  use _ <- result.map(notifications.notify(
                    tx,
                    to: audience.Player,
                    id: id.player_to_string(p.row.id),
                    type_: "matchday",
                    text: "📍 "
                      <> a.org.name
                      <> " logged your appearance in \""
                      <> fixture
                      <> "\" — verified, coach-signed attendance on your profile.",
                    ref_id: Some(id.player_to_string(p.row.id)),
                    at: now,
                  ))
                  [p.row.id, ..credited]
                }
                _ -> Ok(credited)
              }
            })
            |> result.map(list.reverse),
          )
          use matchday_id <- result.try(id.next_matchday(tx))
          use _ <- result.try(matchday_row.insert(
            tx,
            matchday_row.Row(
              id: matchday_id,
              org_id: a.org.id,
              fixture:,
              venue: option.unwrap(venue, ""),
              match_date: date,
              result: case option.map(body.result, string.trim) {
                Some("") -> None
                r -> r
              },
              logged_by_user_id: a.user.id,
              created_at: now,
            ),
          ))
          use _ <- result.try(
            list.index_map(credited, fn(pid, i) {
              matchday_player_row.Row(matchday_id:, ord: i, player_id: pid)
            })
            |> list.try_each(matchday_player_row.insert(tx, _)),
          )
          use _ <- result.try(ledger.append(
            tx,
            ledger.Entry(
              entry_type: ledger_row.MatchdayLogged,
              player_id: None,
              org_id: Some(a.org.id),
              org_name: Some(a.org.name),
              user_id: Some(a.user.id),
              actor_name: Some(a.user.name),
            ),
            now,
          ))
          use count <- result.map(store.query(
            store.reading(tx),
            "SELECT COUNT(*) FROM matchdays WHERE org_id = ?",
            [id.org_sql(a.org.id)],
            decode.at([0], decode.int),
          ))
          #(list.length(credited), count)
        })
      case logged {
        Ok(#(credited, [count])) ->
          http.json(
            201,
            json.object([
              #("credited", json.int(credited)),
              #("matchdays", json.int(count)),
            ]),
          )
        Ok(_) -> panic as "COUNT(*) gives one row"
        Error(e) -> http.internal(e)
      }
    }
    _, _ -> http.error(400, "FIXTURE_AND_DATE_REQUIRED")
  }
}
