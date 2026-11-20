//// A grassroots club's own operations (domains/development/grassrootsClub.mjs): its squad, its match days, the
//// positions it is looking for, its pathway record and the friendlies board. Its open days are `open_days`. Only
//// a club on ScoutBox Grassroots has them.
////

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
import scoutbox/platform/distance.{At, Columns}
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/json_text
import scoutbox/platform/live_event
import scoutbox/platform/live_pings
import scoutbox/platform/pages
import scoutbox/platform/paging
import scoutbox/platform/sql
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/platform/temporal.{type Day}
import scoutbox/recruitment/signing_reads
import scoutbox/rows/friendlies as friendly_row
import scoutbox/rows/friendly_responses as response_row
import scoutbox/rows/id
import scoutbox/rows/ledger as ledger_row
import scoutbox/rows/matchday_players as matchday_player_row
import scoutbox/rows/matchdays as matchday_row
import scoutbox/rows/org_squad_members as squad_row
import scoutbox/rows/orgs as org_row
import scoutbox/rows/players as player_row
import scoutbox/rows/vouches as vouch_row
import scoutbox/safety/audit
import scoutbox/safety/ledger
import scoutbox/safety/moderate
import scoutbox/vocab/audience
import scoutbox/vocab/availability
import scoutbox/vocab/position
import sqlight
import wisp.{type Request, type Response}

const venue_max = 160

const age_group_max = 40

const notes_max = 2000

const squad_name_max = 120

const squad_position_max = 40

/// Answers 403 for a club not on ScoutBox Grassroots.
pub fn grassroots_only(a: OrgAccess, next: fn() -> Response) -> Response {
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

pub fn context(kind: String, a: OrgAccess) -> audit.Context {
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
pub fn moderated(
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
pub fn trimmed_or(text: Option(String), default: String) -> String {
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

// ---------------------------------------------------------------------------------------------- friendlies

type Friendly {
  Friendly(
    age_group: Option(String),
    date: Option(Day),
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
      let date = temporal.day_text(date)
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
          live_pings.catalogue(tx, live_event.Friendlies)
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
    date: Option(Day),
    result: Option(String),
    player_ids: List(String),
  )
}

/// `POST /org/matchday`: a fixture the club played. Each named player on its squad whom it may see is credited
/// with a verified, coach-signed attendance; anyone else named is skipped, a shadowed player included.
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
      let date = temporal.day_text(date)
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
                  live_pings.player(tx, p.row.id)
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

// ------------------------------------------------------------------------------------------- looking for

const looking_for_max = 5

/// `POST /org/looking-for`: position codes only, which the players' opportunity radar matches against their own.
pub fn looking_for(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use <- grassroots_only(a)
  let shape = {
    use positions <- input.field(
      "positions",
      input.required(input.items_between(
        input.one_of(position.pairs),
        0,
        looking_for_max,
      )),
    )
    input.done(positions)
  }
  use positions <- http.body(req, shape, [])
  let positions = list.unique(positions)
  let saved =
    store.unit(ctx.store, fn(tx) {
      live_pings.catalogue(tx, live_event.Orgs)
      orgs.set_looking_for(tx, a.org.id, positions)
    })
  case saved {
    Ok(_) ->
      http.json(
        200,
        json.object([#("lookingFor", json.array(positions, position.to_json))]),
      )
    Error(failure) -> http.internal(failure)
  }
}

// --------------------------------------------------------------------------------------------- release

const reference_max = 400

const coach_name_max = 100

const role_max = 200

const vouch_player_name_max = 200

type ReleaseRefusal {
  EntryNotFound
}

/// `POST /org/squad/:id/release`: the player leaves the squad and is marked available again (unless a contract
/// another club completed still stands), with the club's reference published on the way out.
pub fn release(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  entry_id: id.SquadEntryId,
) -> Response {
  use <- grassroots_only(a)
  let shape = {
    use text <- input.field(
      "referenceText",
      input.nullish(input.text(reference_max)),
    )
    input.done(text)
  }
  use text <- http.body(req, shape, [])
  let found =
    store.read(ctx.store, fn(read) {
      store.one(
        read,
        "SELECT " <> squad_row.columns <> " FROM org_squad_members WHERE id = ?",
        [id.squad_entry_sql(entry_id)],
        squad_row.decoder(),
      )
    })
  case found {
    Error(failure) -> http.internal(failure)
    Ok(Ok(entry)) if entry.org_id == a.org.id -> {
      let reference = input.filled(text)
      use <- moderated(ctx, reference, context("release_reference", a))
      let now = clock.now_ms()
      let released =
        store.unit(ctx.store, fn(tx) {
          use gone <- result.try(store.write(
            tx,
            "DELETE FROM org_squad_members WHERE id = ? AND org_id = ? RETURNING id",
            [id.squad_entry_sql(entry.id), id.org_sql(a.org.id)],
            decode.at([0], decode.string),
          ))
          use _ <- result.try(case gone {
            [] -> store.refuse(EntryNotFound)
            _ -> Ok(Nil)
          })
          use _ <- result.try(case entry.player_id {
            Some(pid) -> {
              live_pings.player(tx, pid)
              released_player(tx, a, pid, reference, now)
            }
            None -> Ok(Nil)
          })
          squad_view(store.reading(tx), a.org.id)
        })
      case released {
        Ok(view) -> http.json(200, view)
        Error(store.Refused(EntryNotFound)) ->
          http.error(404, "SQUAD_ENTRY_NOT_FOUND")
        Error(failure) -> http.internal(failure)
      }
    }
    Ok(_) -> http.error(404, "SQUAD_ENTRY_NOT_FOUND")
  }
}

fn released_player(
  tx: Tx,
  a: OrgAccess,
  player_id: id.PlayerId,
  reference: Option(String),
  now: Int,
) -> Result(Nil, Fail(e)) {
  let read = store.reading(tx)
  use found <- result.try(players.by_id(read, player_id))
  case found {
    None -> Ok(Nil)
    Some(p) -> {
      use other <- result.try(signing_reads.canonical_contract(
        read,
        p.row.id,
        now,
        Some(a.org.id),
      ))
      use _ <- result.try(case other {
        Some(_) -> Ok(Nil)
        None ->
          players.set_availability(
            tx,
            p.row.id,
            Some(availability.AvailableNow),
            Some(player_row.FreeAgent),
          )
          |> result.replace(Nil)
      })
      use _ <- result.try(case reference {
        None -> Ok(Nil)
        Some(text) -> {
          use vouch_id <- result.try(id.next_vouch(tx))
          vouch_row.insert(
            tx,
            vouch_row.Row(
              id: vouch_id,
              player_id: p.row.id,
              player_name: Some(input.utf16_take(
                p.row.name,
                vouch_player_name_max,
              )),
              coach_name: input.utf16_take(a.user.name, coach_name_max),
              coach_email: None,
              role: input.utf16_take(
                case a.user.role {
                  "" -> "Manager"
                  role -> role
                }
                  <> ", "
                  <> a.org.name,
                role_max,
              ),
              status: vouch_row.Published,
              code_hash: None,
              text: Some(text),
              seasons: None,
              created_at: now,
              published_at: Some(now),
              conflict_of_interest: None,
              withdrawn_at: None,
              withdrawn_by: None,
              withdrawn_reason: None,
            ),
          )
        }
      })
      use _ <- result.try(ledger.append(
        tx,
        ledger.Entry(
          entry_type: ledger_row.ReleasedByClub,
          player_id: Some(p.row.id),
          org_id: Some(a.org.id),
          org_name: Some(a.org.name),
          user_id: Some(a.user.id),
          actor_name: Some(a.user.name),
        ),
        now,
      ))
      let with_reference = reference != None
      use _ <- result.try(notifications.notify(
        tx,
        to: audience.Player,
        id: id.player_to_string(p.row.id),
        type_: "released",
        text: a.org.name
          <> " has released you"
          <> case with_reference {
          True -> " — with a reference now on your profile"
          False -> ""
        }
          <> ". You're marked available to every local club; the First Team Seeker flag is yours to switch on.",
        ref_id: Some(id.player_to_string(p.row.id)),
        at: now,
      ))
      case p.row.guardian_id {
        None -> Ok(Nil)
        Some(g) ->
          notifications.notify(
            tx,
            to: audience.Guardian,
            id: id.guardian_to_string(g),
            type_: "released",
            text: a.org.name
              <> " released "
              <> p.row.name
              <> case with_reference {
              True -> " with a reference"
              False -> ""
            }
              <> ". Their profile is marked available again.",
            ref_id: Some(id.player_to_string(p.row.id)),
            at: now,
          )
      }
    }
  }
}

// ------------------------------------------------------------------------------------------ match days

/// `GET /org/matchdays`: the club's match days, newest first.
pub fn matchdays(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use <- grassroots_only(a)
  use page <- pages.strict(req, [paging.IntKind])
  let before = case page.after {
    Some([paging.IntKey(rowid)]) -> Some(rowid)
    _ -> None
  }
  let listed =
    store.read(ctx.store, fn(read) {
      use rows <- result.try(
        store.query(
          read,
          "SELECT "
            <> matchday_row.columns
            <> ", rowid FROM matchdays WHERE org_id = ? AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?",
          [
            id.org_sql(a.org.id),
            sqlight.nullable(sqlight.int, before),
            sqlight.nullable(sqlight.int, before),
            sqlight.int(page.limit + 1),
          ],
          {
            use m <- decode.then(matchday_row.decoder())
            use rowid <- decode.field(matchday_row.width, decode.int)
            decode.success(#(m, rowid))
          },
        ),
      )
      let #(items, next) =
        paging.page_of(rows, page.limit, fn(r) { [paging.IntKey(r.1)] })
      use credited <- result.map(store.query(
        read,
        "SELECT "
          <> matchday_player_row.columns
          <> " FROM matchday_players WHERE matchday_id IN (SELECT value FROM json_each(?)) ORDER BY matchday_id, ord",
        [
          sqlight.text(
            json.to_string(
              json.array(items, fn(r) { id.matchday_json({ r.0 }.id) }),
            ),
          ),
        ],
        matchday_player_row.decoder(),
      ))
      #(items, next, credited)
    })
  case listed {
    Error(failure) -> http.internal(failure)
    Ok(#(items, next, credited)) ->
      pages.respond(items, next, fn(r) {
        let m = r.0
        json.object([
          #("id", id.matchday_json(m.id)),
          #("orgId", id.org_json(m.org_id)),
          #("fixture", json.string(m.fixture)),
          #("venue", json.string(m.venue)),
          #("date", json.string(m.match_date)),
          #("result", json.nullable(m.result, json.string)),
          #(
            "playerIds",
            json.array(
              list.filter(credited, fn(c) { c.matchday_id == m.id }),
              fn(c) { id.player_json(c.player_id) },
            ),
          ),
          #("loggedByUserId", id.org_user_json(m.logged_by_user_id)),
          #("ts", json.int(m.created_at)),
        ])
      })
  }
}

// ------------------------------------------------------------------------------------- pathway record

/// Players the club signed, rostered or hosted at an open day who later signed for a club not on Grassroots:
/// how many, and whether that makes it a Pathway Club.
pub fn pathway_record(
  read: Read,
  org_id: id.OrgId,
) -> Result(#(Int, Bool), Fail(e)) {
  let pair = {
    use p <- decode.field(0, id.player_decoder())
    use at <- decode.field(1, decode.int)
    decode.success(#(p, at))
  }
  use signed <- result.try(store.query(
    read,
    "SELECT player_id, ts FROM signings WHERE org_id = ? ORDER BY rowid",
    [id.org_sql(org_id)],
    pair,
  ))
  use rostered <- result.try(squad_player_ids(read, org_id))
  use registrants <- result.try(store.query(
    read,
    "SELECT r.player_id, r.registered_at FROM open_trial_registrations r JOIN open_trials t ON t.id = r.open_trial_id WHERE t.org_id = ? AND t.deleted_at IS NULL ORDER BY r.rowid",
    [id.org_sql(org_id)],
    pair,
  ))
  let involved =
    list.flatten([
      list.map(signed, fn(s) { s.0 }),
      rostered,
      list.map(registrants, fn(r) { r.0 }),
    ])
    |> list.unique
  use progressed <- result.map(
    list.try_fold(involved, 0, fn(n, pid) {
      let first =
        list.append(signed, registrants)
        |> list.filter_map(fn(x) {
          case x.0 == pid {
            True -> Ok(x.1)
            False -> Error(Nil)
          }
        })
        |> list.reduce(int.min)
      // The first signing elsewhere, outside Grassroots; a rostered player with no other involvement never counts.
      use upward <- result.map(store.one(
        read,
        "SELECT s.ts FROM signings s LEFT JOIN orgs o ON o.id = s.org_id WHERE s.player_id = ? AND s.org_id <> ? AND COALESCE(o.level, '') <> 'grassroots' ORDER BY s.rowid LIMIT 1",
        [id.player_sql(pid), id.org_sql(org_id)],
        decode.at([0], decode.int),
      ))
      case upward, first {
        Ok(ts), Ok(first) if ts > first -> n + 1
        _, _ -> n
      }
    }),
  )
  #(progressed, progressed >= 1)
}

fn squad_player_ids(
  read: Read,
  org_id: id.OrgId,
) -> Result(List(id.PlayerId), Fail(e)) {
  store.query(
    read,
    "SELECT player_id FROM org_squad_members WHERE org_id = ? AND player_id IS NOT NULL ORDER BY rowid",
    [id.org_sql(org_id)],
    decode.at([0], id.player_decoder()),
  )
}

/// `progressed` and `pathwayClub`, as the directory and the radar carry them.
pub fn pathway_fields(record: #(Int, Bool)) -> List(#(String, Json)) {
  [
    #("progressed", json.int(record.0)),
    #("pathwayClub", json.bool(record.1)),
  ]
}

fn count(read: Read, sql: String, org_id: id.OrgId) -> Result(Int, Fail(e)) {
  store.one(read, sql, [id.org_sql(org_id)], decode.at([0], decode.int))
  |> result.map(result.unwrap(_, 0))
}

/// `GET /org/pathway-record`.
pub fn pathway(ctx: Ctx, a: OrgAccess) -> Response {
  use <- grassroots_only(a)
  let read =
    store.read(ctx.store, fn(read) {
      use record <- result.try(pathway_record(read, a.org.id))
      use open_days <- result.try(count(
        read,
        "SELECT COUNT(*) FROM open_trials WHERE org_id = ? AND deleted_at IS NULL",
        a.org.id,
      ))
      use matchdays <- result.map(count(
        read,
        "SELECT COUNT(*) FROM matchdays WHERE org_id = ?",
        a.org.id,
      ))
      #(record, open_days, matchdays)
    })
  case read {
    Error(failure) -> http.internal(failure)
    Ok(#(record, open_days, matchdays)) ->
      http.json(
        200,
        json.object(
          list.append(pathway_fields(record), [
            #("openDaysRun", json.int(open_days)),
            #("matchdaysLogged", json.int(matchdays)),
            #(
              "note",
              json.string(
                "Progressed = players your club signed or hosted who later signed for an academy or pro club. Development is the reputation that matters here.",
              ),
            ),
          ]),
        ),
      )
  }
}

// ---------------------------------------------------------------------------------------- friendlies board

const message_max = 200

fn friendly_view(
  f: friendly_row.Row,
  poster: String,
  tenths: Option(Int),
  responses: List(#(response_row.Row, String)),
  viewer: id.OrgId,
) -> Json {
  let mine = f.org_id == viewer
  json.object([
    #("id", id.friendly_json(f.id)),
    #("orgId", id.org_json(f.org_id)),
    #("orgName", json.string(poster)),
    #("postedByUserId", id.org_user_json(f.posted_by_user_id)),
    #("ageGroup", json.string(f.age_group)),
    #("date", json.string(f.match_date)),
    #("venue", json.string(f.venue)),
    #("notes", json.string(f.notes)),
    #("status", json.string("open")),
    #("createdAt", json.int(f.created_at)),
    #("mine", json.bool(mine)),
    #("distanceKm", case mine, tenths {
      False, Some(t) -> json_text.number(int.to_float(t) /. 10.0)
      _, _ -> json.int(0)
    }),
    // The responders' messages are the poster's alone.
    #(
      "responses",
      json.array(responses, fn(pair) {
        let #(r, name) = pair
        json.object([
          #("orgId", id.org_json(r.org_id)),
          #("orgName", json.string(name)),
          #(
            "message",
            json.string(case mine {
              True -> r.message
              False -> ""
            }),
          ),
          #("respondedByUserId", id.org_user_json(r.responded_by_user_id)),
          #("ts", json.int(r.responded_at)),
        ])
      }),
    ),
  ])
}

/// `GET /org/friendlies`: the club's own friendlies and those posted by clubs within the radius, by match date.
pub fn friendlies(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use <- grassroots_only(a)
  use page <- pages.strict(req, [paging.TextKind, paging.TextKind])
  let after = case page.after {
    Some([paging.TextKey(date), paging.TextKey(fid)]) -> Some(#(date, fid))
    _ -> None
  }
  let near = case orgs.location(a.org) {
    Some(here) ->
      sql.concat([
        sql.text(" OR "),
        distance.within_grassroots_radius(
          Columns("o.lat", "o.lng"),
          At(here.lat, here.lng),
        ),
      ])
    None -> sql.text("")
  }
  let tenths = case orgs.location(a.org) {
    Some(here) ->
      distance.tenths(Columns("o.lat", "o.lng"), At(here.lat, here.lng))
    None -> sql.text("NULL")
  }
  let after_date =
    sqlight.nullable(sqlight.text, option.map(after, fn(x) { x.0 }))
  let q =
    sql.concat([
      sql.text("SELECT " <> friendly_row.qualified("f") <> ", o.name, "),
      tenths,
      sql.text(
        " FROM friendlies f JOIN orgs o ON o.id = f.org_id WHERE (f.org_id = ",
      ),
      sql.arg(id.org_sql(a.org.id)),
      near,
      sql.text(") AND ("),
      sql.arg(after_date),
      sql.text(" IS NULL OR f.match_date > "),
      sql.arg(after_date),
      sql.text(" OR (f.match_date = "),
      sql.arg(after_date),
      sql.text(" AND f.id > "),
      sql.arg(sqlight.nullable(sqlight.text, option.map(after, fn(x) { x.1 }))),
      sql.text(")) ORDER BY f.match_date, f.id LIMIT "),
      sql.arg(sqlight.int(page.limit + 1)),
    ])
  let listed =
    store.read(ctx.store, fn(read) {
      use rows <- result.try(
        store.query(read, q.sql, q.args, {
          use f <- decode.then(friendly_row.decoder())
          use name <- decode.field(friendly_row.width, decode.string)
          use tenths <- decode.field(
            friendly_row.width + 1,
            decode.optional(decode.int),
          )
          decode.success(#(f, name, tenths))
        }),
      )
      let #(items, next) =
        paging.page_of(rows, page.limit, fn(r) {
          [
            paging.TextKey({ r.0 }.match_date),
            paging.TextKey(id.friendly_to_string({ r.0 }.id)),
          ]
        })
      use responses <- result.map(responses_of(
        read,
        list.map(items, fn(r) { { r.0 }.id }),
      ))
      #(items, next, responses)
    })
  case listed {
    Error(failure) -> http.internal(failure)
    Ok(#(items, next, responses)) ->
      pages.respond(items, next, fn(r) {
        let #(f, name, tenths) = r
        friendly_view(
          f,
          name,
          tenths,
          list.filter(responses, fn(x) { { x.0 }.friendly_id == f.id }),
          a.org.id,
        )
      })
  }
}

fn responses_of(
  read: Read,
  friendly_ids: List(id.FriendlyId),
) -> Result(List(#(response_row.Row, String)), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> response_row.qualified("r")
      <> ", o.name FROM friendly_responses r JOIN orgs o ON o.id = r.org_id WHERE r.friendly_id IN (SELECT value FROM json_each(?)) ORDER BY r.rowid",
    [sqlight.text(json.to_string(json.array(friendly_ids, id.friendly_json)))],
    {
      use r <- decode.then(response_row.decoder())
      use name <- decode.field(response_row.width, decode.string)
      decode.success(#(r, name))
    },
  )
}

type RespondRefusal {
  AlreadyResponded
}

/// `POST /org/friendlies/:id/respond`: another club is up for it, once. The poster is told.
pub fn respond(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  friendly_id: id.FriendlyId,
) -> Response {
  use <- grassroots_only(a)
  let found =
    store.read(ctx.store, fn(read) {
      store.one(
        read,
        "SELECT " <> friendly_row.columns <> " FROM friendlies WHERE id = ?",
        [id.friendly_sql(friendly_id)],
        friendly_row.decoder(),
      )
    })
  case found {
    Error(failure) -> http.internal(failure)
    Ok(Error(_)) -> http.error(404, "FRIENDLY_NOT_FOUND")
    Ok(Ok(f)) if f.org_id == a.org.id -> http.error(400, "OWN_POST")
    Ok(Ok(f)) -> {
      let shape = {
        use message <- input.field(
          "message",
          input.nullish(input.text(message_max)),
        )
        input.done(message)
      }
      use message <- http.body(req, shape, [])
      use <- moderated(ctx, message, context("friendly_response", a))
      let now = clock.now_ms()
      let answered =
        store.unit(ctx.store, fn(tx) {
          use taken <- result.try(store.one(
            store.reading(tx),
            "SELECT 1 FROM friendly_responses WHERE friendly_id = ? AND org_id = ?",
            [id.friendly_sql(f.id), id.org_sql(a.org.id)],
            decode.at([0], decode.int),
          ))
          case taken {
            Ok(_) -> store.refuse(AlreadyResponded)
            Error(_) -> {
              use _ <- result.try(response_row.insert(
                tx,
                response_row.Row(
                  friendly_id: f.id,
                  org_id: a.org.id,
                  message: option.unwrap(input.filled(message), ""),
                  responded_by_user_id: a.user.id,
                  responded_at: now,
                ),
              ))
              live_pings.catalogue(tx, live_event.Friendlies)
              notifications.notify(
                tx,
                to: audience.OrgUser,
                id: id.org_user_to_string(f.posted_by_user_id),
                type_: "friendly",
                text: a.org.name
                  <> " is up for your friendly on "
                  <> f.match_date
                  <> ".",
                ref_id: Some(id.friendly_to_string(f.id)),
                at: now,
              )
            }
          }
        })
      case answered {
        Ok(_) -> http.json(201, json.object([#("responded", json.bool(True))]))
        Error(store.Refused(AlreadyResponded)) ->
          http.error(409, "ALREADY_RESPONDED")
        Error(failure) -> http.internal(failure)
      }
    }
  }
}
