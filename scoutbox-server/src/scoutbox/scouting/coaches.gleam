//// Coach affiliations (domains/scouting/passport.mjs, `coach_affiliations`): a club confirms that a named coach
//// works with it. A confirmed affiliation grants one privilege, the coach-confirmed evidence tier at that club; not
//// discovery access, player-data editing, or any contact channel with minors.

import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/platform/temporal
import scoutbox/rows/coach_affiliation_history as history_row
import scoutbox/rows/coach_affiliations as row
import scoutbox/rows/id
import scoutbox/rows/ledger as ledger_row
import scoutbox/safety/ledger
import scoutbox/scouting/evidence
import sqlight
import wisp.{type Request, type Response}

pub type Affiliation =
  row.Row

const coach_name_max = 80

const coach_email_max = 120

const role_max = 60

const conflict_max = 200

const close_reason_max = 200

pub fn by_id(
  read: Read,
  affiliation_id: id.CoachAffiliationId,
) -> Result(Option(Affiliation), Fail(e)) {
  store.one(
    read,
    "SELECT " <> row.columns <> " FROM coach_affiliations WHERE id = ?",
    [id.coach_affiliation_sql(affiliation_id)],
    row.decoder(),
  )
  |> result.map(option.from_result)
}

/// The confirmed affiliation at `org_id` whose coach name is `user_name`, ignoring case. A known defect, kept until
/// the Founder decides: it is matched by the coach's name, not by a staff account.
pub fn active_for(
  read: Read,
  org_id: id.OrgId,
  user_name: String,
) -> Result(Option(Affiliation), Fail(e)) {
  use rows <- result.map(store.query(
    read,
    "SELECT "
      <> row.columns
      <> " FROM coach_affiliations WHERE org_id = ? AND status = 'confirmed' ORDER BY rowid",
    [id.org_sql(org_id)],
    row.decoder(),
  ))
  let want = string.lowercase(user_name)
  list.find(rows, fn(a) { string.lowercase(a.coach_name) == want })
  |> option.from_result
}

fn log(
  tx: Tx,
  affiliation_id: id.CoachAffiliationId,
  org_id: id.OrgId,
  by_name: String,
  action: String,
  detail: Option(String),
  at: Int,
) -> Result(Nil, Fail(e)) {
  use event_id <- result.try(id.next_coach_affiliation_event(tx))
  store.run(
    tx,
    "INSERT INTO coach_affiliation_history (id, affiliation_id, position, at, by_kind, by_id, by_name, action, detail) SELECT ?, ?, COALESCE(MAX(position) + 1, 0), ?, ?, ?, ?, ?, ? FROM coach_affiliation_history WHERE affiliation_id = ?",
    [
      id.coach_affiliation_event_sql(event_id),
      id.coach_affiliation_sql(affiliation_id),
      sqlight.int(at),
      sqlight.text(history_row.by_kind_to_string(history_row.Org)),
      id.org_sql(org_id),
      sqlight.text(evidence.stored_name(by_name)),
      sqlight.text(action),
      sqlight.nullable(
        sqlight.text,
        option.map(detail, string.slice(_, 0, 500)),
      ),
      id.coach_affiliation_sql(affiliation_id),
    ],
  )
}

pub fn view(a: Affiliation) -> Json {
  json.object([
    #("id", id.coach_affiliation_json(a.id)),
    #("orgId", id.org_json(a.org_id)),
    #("orgName", json.string(a.org_name)),
    #("coachName", json.string(a.coach_name)),
    #("coachEmail", json.nullable(a.coach_email, json.string)),
    #("role", json.string(a.role)),
    #("from", json.string(a.from_date)),
    #("to", json.nullable(a.to_date, json.string)),
    #("status", row.status_to_json(a.status)),
    #(
      "confirmedBy",
      json.object([
        #("userId", id.org_user_json(a.confirmed_by_user_id)),
        #("name", json.string(a.confirmed_by_name)),
      ]),
    ),
    #("conflictOfInterest", json.nullable(a.conflict_of_interest, json.string)),
    #("createdAt", json.int(a.created_at)),
    #("current", json.bool(a.status == row.Confirmed)),
  ])
}

/// `GET /org/coaches`: the club's affiliations, oldest first.
pub fn list_for_org(ctx: Ctx, a: OrgAccess) -> Response {
  let found =
    store.read(ctx.store, fn(read) {
      store.query(
        read,
        "SELECT "
          <> row.columns
          <> " FROM coach_affiliations WHERE org_id = ? ORDER BY rowid",
        [id.org_sql(a.org.id)],
        row.decoder(),
      )
    })
  case found {
    Ok(rows) -> http.json(200, json.array(rows, view))
    Error(failure) -> http.internal(failure)
  }
}

type NewAffiliation {
  NewAffiliation(
    coach_name: Option(String),
    role: Option(String),
    coach_email: Option(String),
    conflict: Option(String),
    from: Option(Option(temporal.Day)),
  )
}

/// `POST /org/coaches`: the club confirms a coach. The club is the confirmer, since the route runs under its session.
pub fn create(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  let shape = {
    use coach_name <- input.field(
      "coachName",
      input.nullish(input.text(coach_name_max)),
    )
    use role <- input.field("role", input.nullish(input.text(role_max)))
    use coach_email <- input.field(
      "coachEmail",
      input.nullish(input.text(coach_email_max)),
    )
    use conflict <- input.field(
      "conflictOfInterest",
      input.nullish(input.text(conflict_max)),
    )
    use from <- input.field("from", input.nullish(input.day_or_blank()))
    input.done(NewAffiliation(
      coach_name:,
      role:,
      coach_email:,
      conflict:,
      from:,
    ))
  }
  use body <- http.body(req, shape, [])
  case input.filled(body.coach_name), input.filled(body.role) {
    None, _ -> http.required("COACH_NAME_REQUIRED", "coachName")
    _, None -> http.required("ROLE_REQUIRED", "role")
    Some(coach_name), Some(role) -> {
      let now = clock.now_ms()
      let from = case option.flatten(body.from) {
        Some(day) -> temporal.day_text(day)
        None -> clock.iso_day(now)
      }
      let saved =
        store.unit(ctx.store, fn(tx) {
          use affiliation_id <- result.try(id.next_coach_affiliation(tx))
          let r =
            row.Row(
              id: affiliation_id,
              org_id: a.org.id,
              org_name: evidence.stored_name(a.org.name),
              coach_name:,
              coach_email: input.filled(body.coach_email),
              role:,
              from_date: from,
              to_date: None,
              status: row.Confirmed,
              confirmed_by_user_id: a.user.id,
              confirmed_by_name: evidence.stored_name(a.user.name),
              conflict_of_interest: input.filled(body.conflict),
              created_at: now,
            )
          use _ <- result.try(row.insert(tx, r))
          use _ <- result.try(log(
            tx,
            affiliation_id,
            a.org.id,
            a.user.name,
            "confirmed",
            Some(role),
            now,
          ))
          use _ <- result.map(ledger.append(
            tx,
            ledger.Entry(
              entry_type: ledger_row.CoachAffiliationConfirmed,
              player_id: None,
              org_id: Some(a.org.id),
              org_name: Some(a.org.name),
              user_id: Some(a.user.id),
              actor_name: Some(a.user.name),
            ),
            now,
          ))
          r
        })
      case saved {
        Ok(r) -> http.json(201, json.object([#("affiliation", view(r))]))
        Error(failure) -> http.internal(failure)
      }
    }
  }
}

/// `POST /org/coaches/:id/end` and `/revoke`: either is final. "ended" keeps a clean history; "revoked" flags cause.
pub fn close(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  affiliation_id: id.CoachAffiliationId,
  status: row.Status,
) -> Response {
  case store.read(ctx.store, by_id(_, affiliation_id)) {
    Error(failure) -> http.internal(failure)
    Ok(Some(found)) if found.org_id != a.org.id ->
      http.error(404, "AFFILIATION_NOT_FOUND")
    Ok(None) -> http.error(404, "AFFILIATION_NOT_FOUND")
    Ok(Some(found)) if found.status != row.Confirmed ->
      http.json(
        409,
        json.object([
          #("error", json.string("NOT_CURRENT")),
          #("status", row.status_to_json(found.status)),
        ]),
      )
    Ok(Some(found)) -> {
      let shape = {
        use reason <- input.field(
          "reason",
          input.nullish(input.text(close_reason_max)),
        )
        input.done(reason)
      }
      use reason <- http.body(req, shape, [])
      let now = clock.now_ms()
      let saved =
        store.unit(ctx.store, fn(tx) {
          use rows <- result.try(store.write(
            tx,
            "UPDATE coach_affiliations SET status = ?, to_date = ? WHERE id = ? AND status = 'confirmed' RETURNING "
              <> row.columns,
            [
              sqlight.text(row.status_to_string(status)),
              sqlight.text(clock.iso_day(now)),
              id.coach_affiliation_sql(found.id),
            ],
            row.decoder(),
          ))
          case rows {
            [closed] -> {
              use _ <- result.map(log(
                tx,
                found.id,
                a.org.id,
                a.user.name,
                row.status_to_string(status),
                input.filled(reason),
                now,
              ))
              closed
            }
            _ -> store.stale("coach affiliation")
          }
        })
      case saved {
        Ok(closed) ->
          http.json(
            200,
            json.object([
              #("affiliation", view(closed)),
              #(
                "note",
                json.string(
                  "Historical references stay attributed; current coach privileges are removed immediately.",
                ),
              ),
            ]),
          )
        Error(failure) -> failed(failure)
      }
    }
  }
}

/// The count and a page of every organisation's affiliations, newest first (the admin list).
pub fn page(read: Read, limit: Int, offset: Int) -> Result(Json, Fail(e)) {
  use total <- result.try(store.one(
    read,
    "SELECT COUNT(*) FROM coach_affiliations",
    [],
    decode.at([0], decode.int),
  ))
  use rows <- result.map(store.query(
    read,
    "SELECT "
      <> row.columns
      <> " FROM coach_affiliations ORDER BY created_at DESC, rowid LIMIT ? OFFSET ?",
    [sqlight.int(limit), sqlight.int(offset)],
    row.decoder(),
  ))
  json.object([
    #("total", json.int(result.unwrap(total, 0))),
    #("limit", json.int(limit)),
    #("offset", json.int(offset)),
    #("items", json.array(rows, view)),
  ])
}

/// A unit's failure as a route answers it: a lost race runs the route again.
pub fn failed(e: store.UnitError(a)) -> Response {
  case e {
    store.Lost(what) -> http.stale(what)
    e -> http.internal(e)
  }
}
