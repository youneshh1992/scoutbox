//// The club's shadow list and its squad planner (domains/scouting/scouting.mjs, repositories/clubSetup.ts `shadow`).
////
//// The shadow list is its own table: a club considering a player is not that player's club, so nothing that reads
//// the squad (match days, release, the Passport, the Trust Score) sees a shadow entry.

import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/players
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/rows/id
import scoutbox/rows/org_shadow_players as row
import scoutbox/rows/org_squad_members as squad_row
import scoutbox/rules/visibility
import scoutbox/scouting/evidence
import scoutbox/scouting/tactical
import scoutbox/scouting/vacancies
import scoutbox/vocab/playing_level
import scoutbox/vocab/position as positions
import wisp.{type Request, type Response}

fn entry_fields(s: row.Row) -> List(#(String, Json)) {
  [
    #("id", id.shadow_entry_json(s.id)),
    #("playerId", id.player_json(s.player_id)),
    #("name", json.string(s.name)),
    #("source", json.string("shadow")),
    #("roleId", json.nullable(s.role_id, id.role_json)),
    #("addedBy", json.string(s.added_by_name)),
    #("addedAt", json.int(s.added_at)),
  ]
}

type NewShadow {
  NewShadow(player_id: String, role_id: Option(String))
}

/// `POST /org/squad/shadow`: a player the club may see, once, optionally for one of its tactical roles.
pub fn add(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  let shape = {
    use player_id <- input.field("playerId", input.required(input.id()))
    use role_id <- input.field("roleId", input.nullish(input.id()))
    input.done(NewShadow(player_id:, role_id:))
  }
  use body <- http.body(req, shape, [])
  let now = clock.now_ms()
  let done =
    store.unit(ctx.store, fn(tx) {
      let read = store.reading(tx)
      use found <- result.try(players.for_org(
        read,
        id.player(body.player_id),
        a.org,
        now,
      ))
      use p <- result.try(case found {
        None -> store.refuse(http.error(404, "PLAYER_NOT_FOUND"))
        Some(#(_, access)) if !access.visible || access.blocked ->
          store.refuse(http.error(403, "NOT_VISIBLE"))
        Some(#(p, _)) -> Ok(p)
      })
      use role <- result.try(case body.role_id {
        None -> Ok(None)
        Some(rid) -> {
          use role <- result.try(tactical.role_of(read, a.org.id, rid))
          case role {
            Some(role) -> Ok(Some(role.id))
            None ->
              store.refuse(http.error_message(
                404,
                "ROLE_NOT_FOUND",
                "roleId must be one of the club's tactical roles.",
              ))
          }
        }
      })
      use already <- result.try(store.query(
        read,
        "SELECT 1 FROM org_shadow_players WHERE org_id = ? AND player_id = ?",
        [id.org_sql(a.org.id), id.player_sql(p.row.id)],
        decode.at([0], decode.int),
      ))
      case already {
        [_, ..] -> store.refuse(http.error(409, "ALREADY_SHADOWED"))
        [] -> {
          use entry_id <- result.try(id.next_shadow_entry(tx))
          let entry =
            row.Row(
              ..row.new(
                id: entry_id,
                org_id: a.org.id,
                player_id: p.row.id,
                name: evidence.stored_name(p.row.name),
                added_by_name: evidence.stored_name(a.user.name),
                added_at: now,
              ),
              role_id: role,
            )
          use _ <- result.map(row.insert(tx, entry))
          http.json(
            201,
            json.object([#("entry", json.object(entry_fields(entry)))]),
          )
        }
      }
    })
  case done {
    Ok(resp) -> resp
    Error(store.Refused(resp)) -> resp
    Error(e) -> http.internal(e)
  }
}

fn shadow_of(read: Read, org_id: id.OrgId) -> Result(List(row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> row.columns
      <> " FROM org_shadow_players WHERE org_id = ? ORDER BY rowid",
    [id.org_sql(org_id)],
    row.decoder(),
  )
}

fn squad_of(
  read: Read,
  org_id: id.OrgId,
) -> Result(List(squad_row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> squad_row.columns
      <> " FROM org_squad_members WHERE org_id = ? ORDER BY rowid",
    [id.org_sql(org_id)],
    squad_row.decoder(),
  )
}

/// `GET /org/squad-planner`: the setup's formation, roles and windows, the squad and the shadow list (each entry
/// with the player's position, contract and level, and whether the club may see them), and the open vacancies.
pub fn planner(ctx: Ctx, a: OrgAccess) -> Response {
  let now = clock.now_ms()
  let read =
    store.read(ctx.store, fn(read) {
      use setup <- result.try(tactical.for_org(read, a.org.id))
      use squad <- result.try(squad_of(read, a.org.id))
      use shadow <- result.try(shadow_of(read, a.org.id))
      use open <- result.try(vacancies.open_for(read, a.org.id))
      let ids =
        list.append(
          list.filter_map(squad, fn(s) { option.to_result(s.player_id, Nil) }),
          list.map(shadow, fn(s) { s.player_id }),
        )
      use found <- result.map(players.for_org_many(read, ids, a.org, now))
      #(setup, squad, shadow, open, found)
    })
  case read {
    Error(e) -> http.internal(e)
    Ok(#(setup, squad, shadow, open, found)) -> {
      let enrich = fn(
        base: List(#(String, Json)),
        player_id: Option(id.PlayerId),
        position: Option(String),
      ) {
        let p =
          option.then(player_id, fn(pid) {
            list.find(found, fn(f) { { f.0 }.row.id == pid })
            |> option.from_result
          })
        json.object(
          list.append(base, [
            #("position", case p {
              Some(#(p, _)) ->
                case p.row.position {
                  Some(pos) -> positions.to_json(pos)
                  None -> json.nullable(position, json.string)
                }
              None -> json.nullable(position, json.string)
            }),
            #("contractUntil", case p {
              Some(#(p, _)) ->
                json.nullable(p.row.contract_until_date, json.string)
              None -> json.null()
            }),
            #("level", case p {
              Some(#(p, _)) -> playing_level.to_json(p.row.level)
              None -> json.null()
            }),
            #(
              "visible",
              json.bool(case p {
                Some(#(_, access)) -> can_see(access)
                None -> False
              }),
            ),
          ]),
        )
      }
      http.json(
        200,
        json.object([
          #("formation", case setup {
            Some(s) -> json.string(s.formation)
            None -> json.null()
          }),
          #(
            "roles",
            json.array(
              option.map(setup, fn(s) { s.roles }) |> option.unwrap([]),
              tactical.role_json,
            ),
          ),
          #(
            "windows",
            json.array(
              option.map(setup, fn(s) { s.windows }) |> option.unwrap([]),
              tactical.window_json,
            ),
          ),
          #(
            "current",
            json.array(squad, fn(s) {
              enrich(
                list.flatten([
                  [
                    #("id", id.squad_entry_json(s.id)),
                    #("playerId", json.nullable(s.player_id, id.player_json)),
                    #("name", json.string(s.name)),
                    #("source", squad_row.source_to_json(s.source)),
                  ],
                  case s.approved_by_label {
                    Some(by) if by != "" -> [#("approvedBy", json.string(by))]
                    _ -> []
                  },
                  [#("addedAt", json.int(s.added_at))],
                ]),
                s.player_id,
                s.position,
              )
            }),
          ),
          #(
            "shadow",
            json.array(shadow, fn(s) {
              enrich(entry_fields(s), Some(s.player_id), None)
            }),
          ),
          #("vacancies", json.array(open, vacancies.view)),
        ]),
      )
    }
  }
}

fn can_see(access: visibility.Access) -> Bool {
  access.visible && !access.blocked
}
