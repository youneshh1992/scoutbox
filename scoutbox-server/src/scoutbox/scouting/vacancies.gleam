//// A club's vacancies (domains/scouting/scouting.mjs, repositories/clubSetup.ts): a role in its tactical setup
//// the club means to fill, which a recruitment case may name.
////
//// A vacancy's candidates are judged by its role's criteria, rule by rule: met, not met or unknown, each with the
//// data it was read from. Never a fabricated percentage, potential rating, salary estimate or transfer value.

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
import scoutbox/platform/keyset.{Asc, Desc, OrderKey}
import scoutbox/platform/pages
import scoutbox/platform/paging.{IntKey, IntKind}
import scoutbox/platform/sql.{type Fragment}
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/platform/temporal
import scoutbox/rows/evidence as evidence_row
import scoutbox/rows/id
import scoutbox/rows/org_tactical_role_criteria as criterion_row
import scoutbox/rows/recruitment_cases as case_row
import scoutbox/rows/vacancies as row
import scoutbox/rules/age
import scoutbox/rules/visibility
import scoutbox/scouting/evidence
import scoutbox/scouting/tactical.{type Criterion, type Role, Number, Word}
import scoutbox/vocab/availability
import scoutbox/vocab/foot
import scoutbox/vocab/playing_level
import scoutbox/vocab/position as positions
import sqlight
import wisp.{type Request, type Response}

const notes_max = 300

const window_max = 40

pub fn view(v: row.Row) -> Json {
  json.object([
    #("id", id.vacancy_json(v.id)),
    #("orgId", id.org_json(v.org_id)),
    #("roleId", json.nullable(v.role_id, id.role_json)),
    #("roleName", json.string(v.role_name)),
    #("window", json.nullable(v.window_name, json.string)),
    #("notes", json.nullable(v.notes, json.string)),
    #("status", row.status_to_json(v.status)),
    #("createdBy", json.string(v.created_by_name)),
    #("createdAt", json.int(v.created_at)),
    #("closedAt", json.nullable(v.closed_at, json.int)),
  ])
}

/// `GET /org/vacancies`: the club's vacancies, newest first, by cursor. A parameter the list does not take is
/// refused.
pub fn list_for(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use page <- pages.strict(req, [IntKind])
  let before = case page.after {
    Some([IntKey(rowid)]) -> sqlight.int(rowid)
    _ -> sqlight.null()
  }
  let found =
    store.read(ctx.store, fn(read) {
      store.query(
        read,
        "SELECT "
          <> row.columns
          <> ", rowid FROM vacancies WHERE org_id = ? AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?",
        [id.org_sql(a.org.id), before, before, sqlight.int(page.limit + 1)],
        {
          use r <- decode.then(row.decoder())
          use rowid <- decode.field(row.width, decode.int)
          decode.success(#(r, rowid))
        },
      )
    })
  case found {
    Error(e) -> http.internal(e)
    Ok(rows) -> {
      let #(items, next) =
        paging.page_of(rows, page.limit, fn(f) { [IntKey(f.1)] })
      pages.respond(items, next, fn(f) { view(f.0) })
    }
  }
}

fn of_org(
  read: Read,
  vacancy_id: String,
  org_id: id.OrgId,
) -> Result(Option(row.Row), Fail(e)) {
  use found <- result.map(store.query(
    read,
    "SELECT " <> row.columns <> " FROM vacancies WHERE id = ? AND org_id = ?",
    [id.vacancy_sql(id.vacancy(vacancy_id)), id.org_sql(org_id)],
    row.decoder(),
  ))
  list.first(found) |> option.from_result
}

/// The club's open vacancies, oldest first: the squad planner.
pub fn open_for(
  read: Read,
  org_id: id.OrgId,
) -> Result(List(row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> row.columns
      <> " FROM vacancies WHERE org_id = ? AND status = 'open' ORDER BY rowid",
    [id.org_sql(org_id)],
    row.decoder(),
  )
}

type NewVacancy {
  NewVacancy(role_id: String, notes: Option(String), window: Option(String))
}

/// `|| null`: empty text is none.
fn or_none(text: Option(String)) -> Option(String) {
  case text {
    Some("") -> None
    t -> t
  }
}

/// `POST /org/vacancies`: a vacancy against one of the club's tactical roles.
pub fn create(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  let shape = {
    use role_id <- input.field("roleId", input.required(input.id()))
    use notes <- input.field("notes", input.nullish(input.text(notes_max)))
    use window <- input.field("window", input.nullish(input.text(window_max)))
    input.done(NewVacancy(role_id:, notes:, window:))
  }
  use body <- http.body(req, shape, [])
  let now = clock.now_ms()
  let done =
    store.unit(ctx.store, fn(tx) {
      use role <- result.try(tactical.role_of(
        store.reading(tx),
        a.org.id,
        body.role_id,
      ))
      case role {
        None ->
          store.refuse(http.error_message(
            404,
            "ROLE_NOT_FOUND",
            "Define the tactical role first.",
          ))
        Some(role) -> {
          use vacancy_id <- result.try(id.next_vacancy(tx))
          let v =
            row.Row(
              ..row.new(
                id: vacancy_id,
                org_id: a.org.id,
                role_name: role.name,
                status: row.Open,
                created_by_name: evidence.stored_name(a.user.name),
                created_at: now,
              ),
              role_id: Some(role.id),
              window_name: or_none(body.window),
              notes: or_none(body.notes),
            )
          use _ <- result.map(row.insert(tx, v))
          http.json(201, json.object([#("vacancy", view(v))]))
        }
      }
    })
  case done {
    Ok(resp) -> resp
    Error(store.Refused(resp)) -> resp
    Error(e) -> http.internal(e)
  }
}

/// `POST /org/vacancies/:id/close`. Closing twice keeps the first close.
pub fn close(ctx: Ctx, a: OrgAccess, vacancy_id: String) -> Response {
  let now = clock.now_ms()
  let done =
    store.unit(ctx.store, fn(tx) {
      use found <- result.try(of_org(store.reading(tx), vacancy_id, a.org.id))
      case found {
        None -> store.refuse(http.error(404, "VACANCY_NOT_FOUND"))
        Some(v) if v.status == row.Closed ->
          Ok(http.json(200, json.object([#("vacancy", view(v))])))
        Some(v) -> {
          use closed <- result.map(store.write(
            tx,
            "UPDATE vacancies SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open' RETURNING "
              <> row.columns,
            [sqlight.int(now), id.vacancy_sql(v.id)],
            row.decoder(),
          ))
          let assert [closed] = closed as "an open vacancy just closed"
          http.json(200, json.object([#("vacancy", view(closed))]))
        }
      }
    })
  case done {
    Ok(resp) -> resp
    Error(store.Refused(resp)) -> resp
    Error(e) -> http.internal(e)
  }
}

// ----------------------------------------------------------------------------------------------- candidates

/// The positions each of a role's position groups takes in.
fn group_positions(group: String) -> List(String) {
  case group {
    "GK" -> ["GK"]
    "DEF" -> ["CB", "RB", "LB", "RWB", "LWB"]
    "MID" -> ["CDM", "CM", "CAM"]
    "ATT" -> ["ST", "CF", "RW", "LW"]
    _ -> []
  }
}

fn word(v: tactical.Value) -> String {
  case v {
    Word(w) -> w
    Number(n) -> int.to_string(n)
  }
}

fn number(v: tactical.Value) -> Int {
  case v {
    Number(n) -> n
    Word(_) -> 0
  }
}

/// A criterion's verdict in SQL, as `evaluate` gives it below: 'm' (met), 'u' (unknown) or 'n' (not met). `now`
/// is the clock for the age cutoffs.
fn verdict_sql(c: Criterion, now: Int) -> Fragment {
  let today = temporal.day_of(now)
  let v = c.value
  let #(unknown, met) = case c.key {
    criterion_row.Positiongroup -> #(
      None,
      sql.concat([
        sql.text("p.position IN (SELECT value FROM json_each("),
        sql.arg(sqlight.text(
          json.array(group_positions(word(v)), json.string) |> json.to_string,
        )),
        sql.text("))"),
      ]),
    )
    criterion_row.Minage -> #(
      None,
      sql.concat([
        sql.text("p.birth_date <= "),
        sql.arg(sqlight.text(age.born_by(today, number(v)))),
      ]),
    )
    criterion_row.Maxage -> #(
      None,
      sql.concat([
        sql.text("p.birth_date > "),
        sql.arg(sqlight.text(age.born_by(today, number(v) + 1))),
      ]),
    )
    criterion_row.Foot -> #(
      Some("p.foot IS NULL"),
      sql.concat([sql.text("p.foot = "), sql.arg(sqlight.text(word(v)))]),
    )
    criterion_row.Availability -> #(
      Some("p.availability IS NULL"),
      sql.concat([
        sql.text("p.availability = "),
        sql.arg(sqlight.text(word(v))),
      ]),
    )
    criterion_row.Maxlevel -> #(
      None,
      sql.concat([
        sql.text("NOT (p.level = 'pro' AND "),
        sql.arg(sqlight.text(word(v))),
        sql.text(" <> 'pro')"),
      ]),
    )
    criterion_row.Minappearances -> #(
      Some("p.stats_appearances IS NULL"),
      sql.concat([
        sql.text("p.stats_appearances >= "),
        sql.arg(sqlight.int(number(v))),
      ]),
    )
    criterion_row.Category -> #(
      Some("p.football_category IS NULL"),
      sql.concat([
        sql.text("("),
        sql.arg(sqlight.text(word(v))),
        sql.text(" = 'mixed' OR p.football_category = "),
        sql.arg(sqlight.text(word(v))),
        sql.text(")"),
      ]),
    )
  }
  case unknown {
    Some(u) ->
      sql.concat([
        sql.text("(CASE WHEN " <> u <> " THEN 'u' WHEN "),
        met,
        sql.text(" THEN 'm' ELSE 'n' END)"),
      ])
    None ->
      sql.concat([
        sql.text("(CASE WHEN "),
        met,
        sql.text(" THEN 'm' ELSE 'n' END)"),
      ])
  }
}

/// How many of `verdicts` are `v`, in SQL.
fn count_sql(verdicts: List(Fragment), v: String) -> Fragment {
  case verdicts {
    [] -> sql.text("0")
    _ ->
      verdicts
      |> list.map(fn(f) {
        sql.concat([sql.text("("), f, sql.text(" = '" <> v <> "')")])
      })
      |> sql.join(" + ")
  }
}

/// Sorted by key, so the statement depends only on which criteria a role names; the sums and the AND are the same
/// in any order.
fn by_key(list: List(Criterion)) -> List(Criterion) {
  list.sort(list, fn(x, y) {
    string.compare(
      criterion_row.key_to_string(x.key),
      criterion_row.key_to_string(y.key),
    )
  })
}

type Verdict {
  Met
  NotMet
  Unknown
}

fn verdict_name(v: Verdict) -> String {
  case v {
    Met -> "met"
    NotMet -> "not_met"
    Unknown -> "unknown"
  }
}

fn met_if(ok: Bool) -> Verdict {
  case ok {
    True -> Met
    False -> NotMet
  }
}

/// A criterion's verdict for one player, with its data source. `corroborated` says whether the player has a
/// statistic evidence record that is not self-reported; it is read only for an appearances criterion.
fn evaluate(
  c: Criterion,
  p: Player,
  age_now: Int,
  corroborated: fn() -> Bool,
) -> #(Verdict, String) {
  let src = fn(field) { "profile field: " <> field }
  let r = p.row
  let v = c.value
  case c.key {
    criterion_row.Positiongroup -> #(
      met_if(case r.position {
        Some(pos) ->
          list.contains(group_positions(word(v)), positions.to_string(pos))
        None -> False
      }),
      src("position"),
    )
    criterion_row.Minage | criterion_row.Maxage -> #(
      met_if(case c.key == criterion_row.Minage {
        True -> age_now >= number(v)
        False -> age_now <= number(v)
      }),
      src("age"),
    )
    criterion_row.Foot ->
      case r.foot {
        None -> #(Unknown, "foot not recorded")
        Some(f) -> #(met_if(foot.to_string(f) == word(v)), src("foot"))
      }
    criterion_row.Availability -> #(
      met_if(availability.to_string(r.availability) == word(v)),
      src("availability"),
    )
    criterion_row.Maxlevel -> #(
      met_if(!{ r.level == playing_level.Pro && word(v) != "pro" }),
      src("level"),
    )
    criterion_row.Minappearances ->
      case r.stats_appearances {
        None -> #(Unknown, "no appearances statistic recorded")
        Some(apps) -> #(met_if(apps >= number(v)), case corroborated() {
          True -> "statistic (has corroborated evidence records)"
          False -> "self-reported statistic"
        })
      }
    criterion_row.Category ->
      case r.football_category {
        None -> #(Unknown, "football category not recorded")
        Some(cat) -> #(
          met_if(word(v) == "mixed" || cat == word(v)),
          src("footballCategory"),
        )
      }
  }
}

/// `GET /org/vacancies/:id/candidates`: the players the club may see who meet or may meet every required criterion,
/// those meeting the most first, then those with the fewest unknowns, by cursor.
pub fn candidates(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  vacancy_id: String,
) -> Response {
  let found =
    store.read(ctx.store, fn(read) {
      use v <- result.try(of_org(read, vacancy_id, a.org.id))
      case v {
        None -> Ok(None)
        Some(v) ->
          case v.role_id {
            None -> Ok(Some(#(v, None)))
            Some(rid) -> {
              use role <- result.map(tactical.role_of(
                read,
                a.org.id,
                id.role_to_string(rid),
              ))
              Some(#(v, role))
            }
          }
      }
    })
  case found {
    Error(e) -> http.internal(e)
    Ok(None) -> http.error(404, "VACANCY_NOT_FOUND")
    Ok(Some(#(_, None))) -> http.error(409, "ROLE_DELETED")
    Ok(Some(#(v, Some(role)))) -> {
      use page <- pages.strict(req, [IntKind, IntKind, IntKind])
      let now = clock.now_ms()
      let required = by_key(role.required) |> list.map(verdict_sql(_, now))
      let all =
        list.append(
          required,
          by_key(role.preferred) |> list.map(verdict_sql(_, now)),
        )
      let order = [
        OrderKey(count_sql(required, "m"), Desc, IntKind),
        OrderKey(count_sql(all, "u"), Asc, IntKind),
        OrderKey(sql.text("p.rowid"), Asc, IntKind),
      ]
      let admitted =
        sql.join(
          [
            sql.text("p.deleted_at IS NULL"),
            visibility.can_see_sql(a.org, now),
            ..list.map(required, fn(f) {
              sql.concat([sql.text("("), f, sql.text(" <> 'n')")])
            })
          ],
          " AND ",
        )
      let query =
        keyset.query(
          "p.id",
          sql.concat([sql.text("players p WHERE "), admitted]),
          order,
          page,
        )
      let read =
        store.read(ctx.store, fn(read) {
          use rows <- result.try(
            store.query(read, query.sql, query.args, {
              use pid <- decode.field(0, id.player_decoder())
              use keys <- decode.then(keyset.keys_decoder(1, order))
              decode.success(#(pid, keys))
            }),
          )
          let #(items, next) = paging.page_of(rows, page.limit, fn(r) { r.1 })
          use found <- result.try(players.for_org_many(
            read,
            list.map(items, fn(r) { r.0 }),
            a.org,
            now,
          ))
          use squad <- result.try(store.query(
            read,
            "SELECT player_id FROM org_squad_members WHERE org_id = ? AND player_id IS NOT NULL",
            [id.org_sql(a.org.id)],
            decode.at([0], id.player_decoder()),
          ))
          use shadowed <- result.try(store.query(
            read,
            "SELECT player_id FROM org_shadow_players WHERE org_id = ?",
            [id.org_sql(a.org.id)],
            decode.at([0], id.player_decoder()),
          ))
          use candidates <- result.map(
            found
            |> list.filter(fn(f) { { f.1 }.visible && !{ f.1 }.blocked })
            |> list.try_map(fn(f) {
              candidate(read, f.0, role, now, a.org.id, squad, shadowed)
            }),
          )
          #(option.values(candidates), next)
        })
      case read {
        Error(e) -> http.internal(e)
        Ok(#(candidates, next)) ->
          http.json(
            200,
            json.object([
              #("vacancy", view(v)),
              #("role", tactical.role_json(role)),
              #("candidates", json.preprocessed_array(candidates)),
              #("nextCursor", json.nullable(next, json.string)),
              #(
                "note",
                json.string(
                  "Rule-based comparison: criteria met / not met / unknown with the data source for each. Unknown stays unknown — no invented suitability scores, potential ratings or market values.",
                ),
              ),
            ]),
          )
      }
    }
  }
}

/// One candidate, or `None` when a required criterion is not met.
fn candidate(
  read: Read,
  p: Player,
  role: Role,
  now: Int,
  org_id: id.OrgId,
  squad: List(id.PlayerId),
  shadowed: List(id.PlayerId),
) -> Result(Option(Json), Fail(e)) {
  let age_now = age.age_on(p.row.birth_date, now)
  use statistics <- result.try(
    case
      list.any(list.append(role.required, role.preferred), fn(c) {
        c.key == criterion_row.Minappearances
      })
    {
      True -> evidence.current_for_player(read, p.row.id)
      False -> Ok([])
    },
  )
  let corroborated = fn() {
    list.any(statistics, fn(e) {
      e.row.claim_type == evidence_row.Statistic
      && e.row.verification_status != evidence_row.SelfReported
    })
  }
  let judge = fn(list) {
    list.map(list, fn(c) { #(c, evaluate(c, p, age_now, corroborated)) })
  }
  let required = judge(role.required)
  let preferred = judge(role.preferred)
  case list.any(required, fn(j) { j.1.0 == NotMet }) {
    True -> Ok(None)
    False -> {
      use cases <- result.map(store.query(
        read,
        "SELECT id FROM recruitment_cases WHERE org_id = ? AND player_id = ? AND stage <> ? ORDER BY rowid LIMIT 1",
        [
          id.org_sql(org_id),
          id.player_sql(p.row.id),
          sqlight.text(case_row.stage_to_string(case_row.Closed)),
        ],
        decode.at([0], id.recruitment_case_decoder()),
      ))
      let judged_json = fn(list) {
        json.array(list, fn(j: #(Criterion, #(Verdict, String))) {
          json.object(
            list.append(tactical.criterion_fields(j.0), [
              #("verdict", json.string(verdict_name(j.1.0))),
              #("source", json.string(j.1.1)),
            ]),
          )
        })
      }
      let count = fn(list, v) {
        list.count(list, fn(j: #(Criterion, #(Verdict, String))) { j.1.0 == v })
      }
      Some(
        json.object([
          #("playerId", id.player_json(p.row.id)),
          #("name", json.string(p.row.name)),
          #("position", json.nullable(p.row.position, positions.to_json)),
          #("age", json.int(age_now)),
          #("required", judged_json(required)),
          #("preferred", judged_json(preferred)),
          #("requiredMet", json.int(count(required, Met))),
          #("requiredTotal", json.int(list.length(required))),
          #(
            "unknowns",
            json.int(count(list.append(required, preferred), Unknown)),
          ),
          #("onSquad", json.bool(list.contains(squad, p.row.id))),
          #("shadowed", json.bool(list.contains(shadowed, p.row.id))),
          #("caseId", case cases {
            [c, ..] -> id.recruitment_case_json(c)
            [] -> json.null()
          }),
        ]),
      )
    }
  }
}
