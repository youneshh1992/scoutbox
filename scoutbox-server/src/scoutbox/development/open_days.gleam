//// A Grassroots club's open trial days (domains/development/grassrootsClub.mjs, grassroots.mjs): the club posts,
//// lists, deletes and answers them; a local player registers, or a guardian registers their child. Every
//// registrant gets an answer: an unanswered past one blocks the club's next posting.

import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/development/grassroots_club.{grassroots_only, moderated}
import scoutbox/development/grassroots_journey
import scoutbox/identity/access.{type OrgAccess, type PlayerAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/orgs.{type Org}
import scoutbox/identity/players.{type Player}
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
import scoutbox/platform/sql.{type Fragment}
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/platform/temporal.{type Day}
import scoutbox/recruitment/requests
import scoutbox/rows/id
import scoutbox/rows/ledger as ledger_row
import scoutbox/rows/open_trial_positions as position_row
import scoutbox/rows/open_trial_registrations as reg_row
import scoutbox/rows/open_trials as trial_row
import scoutbox/safety/ledger
import scoutbox/vocab/audience
import scoutbox/vocab/position
import sqlight
import wisp.{type Request, type Response}

const title_max = 160

const venue_max = 160

const age_group_max = 40

const notes_max = 2000

const position_max = 40

const positions_max = 20

const outcome_note_max = 200

const player_name_max = 200

/// A live open day with its host's name (read live, not copied when it posted), its positions and its
/// registrations.
pub type Trial {
  Trial(
    row: trial_row.Row,
    org_name: String,
    positions: List(String),
    registrations: List(reg_row.Row),
    rowid: Int,
  )
}

/// Live open days joined to their host (`o`), filtered and ordered by `rest` (after `WHERE … AND`).
fn trials(read: Read, rest: Fragment) -> Result(List(Trial), Fail(e)) {
  let q =
    sql.concat([
      sql.text(
        "SELECT "
        <> trial_row.qualified("t")
        <> ", o.name, t.rowid FROM open_trials t JOIN orgs o ON o.id = t.org_id WHERE t.deleted_at IS NULL AND ",
      ),
      rest,
    ])
  use found <- result.try(
    store.query(read, q.sql, q.args, {
      use t <- decode.then(trial_row.decoder())
      use name <- decode.field(trial_row.width, decode.string)
      use rowid <- decode.field(trial_row.width + 1, decode.int)
      decode.success(#(t, name, rowid))
    }),
  )
  let ids =
    json.array(found, fn(f) { id.open_trial_json({ f.0 }.id) })
    |> json.to_string
    |> sqlight.text
  use positions <- result.try(store.query(
    read,
    "SELECT "
      <> position_row.columns
      <> " FROM open_trial_positions WHERE open_trial_id IN (SELECT value FROM json_each(?)) ORDER BY open_trial_id, ord",
    [ids],
    position_row.decoder(),
  ))
  use registrations <- result.map(store.query(
    read,
    "SELECT "
      <> reg_row.columns
      <> " FROM open_trial_registrations WHERE open_trial_id IN (SELECT value FROM json_each(?)) ORDER BY rowid",
    [ids],
    reg_row.decoder(),
  ))
  list.map(found, fn(f) {
    let #(t, org_name, rowid) = f
    Trial(
      row: t,
      org_name:,
      positions: list.filter_map(positions, fn(p) {
        case p.open_trial_id == t.id {
          True -> Ok(p.position)
          False -> Error(Nil)
        }
      }),
      registrations: list.filter(registrations, fn(r) {
        r.open_trial_id == t.id
      }),
      rowid:,
    )
  })
}

fn by_id(
  read: Read,
  trial_id: id.OpenTrialId,
) -> Result(Option(Trial), Fail(e)) {
  trials(
    read,
    sql.concat([sql.text("t.id = "), sql.arg(id.open_trial_sql(trial_id))]),
  )
  |> result.map(fn(found) { list.first(found) |> option.from_result })
}

/// An open day as every list shows it (openTrialView), without its registrations.
pub fn fields(t: Trial) -> List(#(String, Json)) {
  let r = t.row
  [
    #("id", id.open_trial_json(r.id)),
    #("orgId", id.org_json(r.org_id)),
    #("orgName", json.string(t.org_name)),
    #("title", json.string(r.title)),
    #("date", json.string(r.trial_date)),
    #("venue", json.string(r.venue)),
    #("ageGroup", json.string(r.age_group)),
    #("positions", json.array(t.positions, json.string)),
    #("notes", json.string(r.notes)),
    #("createdByUserId", id.org_user_json(r.created_by_user_id)),
    #("createdAt", json.int(r.created_at)),
  ]
}

fn registration_fields(r: reg_row.Row) -> List(#(String, Json)) {
  list.flatten([
    [
      #("id", id.open_trial_registration_json(r.id)),
      #("playerId", id.player_json(r.player_id)),
      #("playerName", json.nullable(r.player_name, json.string)),
      #("byGuardian", json.bool(r.by_guardian)),
    ],
    case r.guardian_id {
      Some(g) -> [#("guardianId", id.guardian_json(g))]
      None -> []
    },
    [
      #("ts", json.int(r.registered_at)),
      #("outcome", json.nullable(r.outcome, reg_row.outcome_to_json)),
      #("outcomeNote", json.nullable(r.outcome_note, json.string)),
      #("outcomeAt", json.nullable(r.outcome_at, json.int)),
    ],
  ])
}

/// Whether `player_id` is registered for the open day.
pub fn registered(t: Trial, player_id: id.PlayerId) -> Bool {
  list.any(t.registrations, fn(r) { r.player_id == player_id })
}

/// The upcoming open days (on or after `today`) of these clubs, by date.
pub fn upcoming_for_orgs(
  read: Read,
  org_ids: List(id.OrgId),
  today: String,
) -> Result(List(Trial), Fail(e)) {
  case org_ids {
    [] -> Ok([])
    _ ->
      trials(
        read,
        sql.concat([
          sql.text("t.trial_date >= "),
          sql.arg(sqlight.text(today)),
          sql.text(" AND t.org_id IN (SELECT value FROM json_each("),
          sql.arg(
            sqlight.text(json.to_string(json.array(org_ids, id.org_json))),
          ),
          sql.text(")) ORDER BY t.trial_date, t.id"),
        ]),
      )
  }
}

// --------------------------------------------------------------------------------------------- the club's side

type Posting {
  Posting(
    title: Option(String),
    date: Option(Day),
    venue: Option(String),
    age_group: Option(String),
    positions: Option(List(String)),
    notes: Option(String),
  )
}

/// `POST /org/open-trials`. No ghosting: registrants of a past open day still waiting for an answer block the
/// next posting, as unfiled trial reports block new trials.
pub fn post(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
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
      input.nullish(input.items_between(
        input.required_text(position_max),
        0,
        positions_max,
      )),
    )
    use notes <- input.field("notes", input.nullish(input.text(notes_max)))
    input.done(Posting(
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
          let date = temporal.day_text(date)
          use <- moderated(
            ctx,
            body.notes,
            grassroots_club.context("open_trial_notes", a),
          )
          let wanted =
            option.unwrap(body.positions, [])
            |> list.map(string.trim)
            |> list.unique
          let posted =
            store.unit(ctx.store, fn(tx) {
              live_pings.catalogue(tx, live_event.OpenTrials)
              use trial_id <- result.try(id.next_open_trial(tx))
              let trial =
                trial_row.Row(
                  id: trial_id,
                  org_id: a.org.id,
                  title: grassroots_club.trimmed_or(body.title, ""),
                  trial_date: date,
                  venue: grassroots_club.trimmed_or(body.venue, ""),
                  age_group: grassroots_club.trimmed_or(body.age_group, "open"),
                  notes: option.unwrap(body.notes, ""),
                  created_by_user_id: a.user.id,
                  created_at: now,
                  deleted_at: None,
                )
              use _ <- result.try(trial_row.insert(tx, trial))
              use _ <- result.try(
                list.index_map(wanted, fn(p, i) {
                  position_row.Row(open_trial_id: trial_id, ord: i, position: p)
                })
                |> list.try_each(position_row.insert(tx, _)),
              )
              use _ <- result.map(ledger.append(
                tx,
                ledger.Entry(
                  event: ledger.OpenTrialPosted,
                  player_id: None,
                  org_id: Some(a.org.id),
                  org_name: Some(a.org.name),
                  user_id: Some(a.user.id),
                  actor_name: Some(a.user.name),
                ),
                now,
              ))
              Trial(
                row: trial,
                org_name: a.org.name,
                positions: wanted,
                registrations: [],
                rowid: 0,
              )
            })
          case posted {
            Ok(trial) ->
              http.json(
                201,
                json.object([
                  #(
                    "openTrial",
                    json.object(
                      list.append(fields(trial), [
                        #("registrations", json.preprocessed_array([])),
                      ]),
                    ),
                  ),
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
) -> Result(Int, Fail(e)) {
  use found <- result.map(store.one(
    read,
    "SELECT COUNT(*) FROM open_trial_registrations r JOIN open_trials t ON t.id = r.open_trial_id WHERE t.org_id = ? AND t.deleted_at IS NULL AND t.trial_date < ? AND r.outcome IS NULL",
    [id.org_sql(org_id), sqlight.text(today)],
    decode.at([0], decode.int),
  ))
  result.unwrap(found, 0)
}

/// `GET /org/open-trials`: the club's open days, newest first, with their registrations. A club that cannot see a
/// minor never received their registration in the first place, so the player's figures are null.
pub fn list_for_org(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use <- grassroots_only(a)
  use page <- pages.strict(req, [paging.IntKind])
  let now = clock.now_ms()
  let before = case page.after {
    Some([paging.IntKey(rowid)]) -> Some(rowid)
    _ -> None
  }
  let listed =
    store.read(ctx.store, fn(read) {
      use found <- result.try(trials(
        read,
        sql.concat([
          sql.text("t.org_id = "),
          sql.arg(id.org_sql(a.org.id)),
          sql.text(" AND ("),
          sql.arg(sqlight.nullable(sqlight.int, before)),
          sql.text(" IS NULL OR t.rowid < "),
          sql.arg(sqlight.nullable(sqlight.int, before)),
          sql.text(") ORDER BY t.rowid DESC LIMIT "),
          sql.arg(sqlight.int(page.limit + 1)),
        ]),
      ))
      let #(items, next) =
        paging.page_of(found, page.limit, fn(t) { [paging.IntKey(t.rowid)] })
      let player_ids =
        list.flat_map(items, fn(t) {
          list.map(t.registrations, fn(r) { r.player_id })
        })
        |> list.unique
      use seen <- result.map(players.for_org_many(read, player_ids, a.org, now))
      #(items, next, seen)
    })
  case listed {
    Error(failure) -> http.internal(failure)
    Ok(#(items, next, seen)) ->
      pages.respond(items, next, fn(t) {
        json.object(
          list.append(fields(t), [
            #(
              "registrations",
              json.array(t.registrations, fn(r) {
                let view =
                  list.find(seen, fn(s) { { s.0 }.row.id == r.player_id })
                  |> result.try(fn(s) {
                    case { s.1 }.visible && !{ s.1 }.blocked {
                      True -> Ok(s.0)
                      False -> Error(Nil)
                    }
                  })
                  |> option.from_result
                json.object(
                  list.append(registration_fields(r), [
                    #(
                      "age",
                      json.nullable(
                        option.map(view, players.age_now(_, now)),
                        json.int,
                      ),
                    ),
                    #(
                      "position",
                      json.nullable(
                        option.then(view, fn(p) { p.row.position }),
                        position.to_json,
                      ),
                    ),
                    #(
                      "trustScore",
                      json.nullable(
                        option.map(view, players.profile_signal),
                        json.int,
                      ),
                    ),
                    #(
                      "guardianManaged",
                      json.bool(case view {
                        Some(p) -> !players.is_adult(p, now)
                        None -> False
                      }),
                    ),
                  ]),
                )
              }),
            ),
          ]),
        )
      })
  }
}

/// `DELETE /org/open-trials/:id`: a soft delete, so a coverage assignment naming it keeps its key. It leaves every
/// list.
pub fn delete(ctx: Ctx, a: OrgAccess, trial_id: id.OpenTrialId) -> Response {
  use <- grassroots_only(a)
  let removed =
    store.unit(ctx.store, fn(tx) {
      use gone <- result.map(store.write(
        tx,
        "UPDATE open_trials SET deleted_at = ? WHERE id = ? AND org_id = ? AND deleted_at IS NULL RETURNING id",
        [
          sqlight.int(clock.now_ms()),
          id.open_trial_sql(trial_id),
          id.org_sql(a.org.id),
        ],
        decode.at([0], decode.string),
      ))
      case gone {
        [] -> Nil
        _ -> live_pings.catalogue(tx, live_event.OpenTrials)
      }
      gone
    })
  case removed {
    Ok([]) -> http.error(404, "OPEN_TRIAL_NOT_FOUND")
    Ok(_) -> http.json(200, json.object([#("deleted", json.bool(True))]))
    Error(failure) -> http.internal(failure)
  }
}

type Answer {
  Answer(outcome: Option(reg_row.Outcome), note: Option(String))
}

type AnswerRefusal {
  RegistrationNotFound
  AlreadyResolved
}

/// `POST /org/open-trials/:id/registrations/:regId/outcome`: the club's answer, once. An invitation is a real trial
/// request, written by the one request writer (a minor's goes to the guardian); a kind no reaches the player, and
/// a child's guardian too. A registrant the club may no longer see is answered on the record only.
pub fn outcome(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  trial_id: id.OpenTrialId,
  registration_id: id.OpenTrialRegistrationId,
) -> Response {
  use <- grassroots_only(a)
  let shape = {
    use outcome <- input.field(
      "outcome",
      input.optional(input.one_of(reg_row.outcome_pairs)),
    )
    use note <- input.field("note", input.nullish(input.text(outcome_note_max)))
    input.done(Answer(outcome:, note:))
  }
  use body <- http.body(req, shape, [#("outcome", "OUTCOME_INVALID")])
  let found =
    store.read(ctx.store, fn(read) {
      use t <- result.map(by_id(read, trial_id))
      option.then(t, fn(t) {
        case t.row.org_id == a.org.id {
          True ->
            list.find(t.registrations, fn(r) { r.id == registration_id })
            |> result.map(fn(r) { #(t, r) })
            |> option.from_result
          False -> None
        }
      })
    })
  case found {
    Error(failure) -> http.internal(failure)
    Ok(None) -> http.error(404, "REGISTRATION_NOT_FOUND")
    Ok(Some(#(_, r))) if r.outcome != None -> http.error(409, "ALREADY_RESOLVED")
    Ok(Some(#(t, r))) ->
      case body.outcome {
        None ->
          http.json(
            400,
            json.object([
              #("error", json.string("OUTCOME_INVALID")),
              #("field", json.string("outcome")),
              #("problem", json.string("required")),
              #(
                "allowed",
                json.array(reg_row.outcome_pairs, fn(p) { json.string(p.0) }),
              ),
            ]),
          )
        Some(outcome) -> {
          use <- moderated(
            ctx,
            body.note,
            grassroots_club.context("open_day_outcome", a),
          )
          let note = input.filled(body.note)
          let now = clock.now_ms()
          let answered =
            store.unit(ctx.store, fn(tx) {
              use rows <- result.try(store.write(
                tx,
                "UPDATE open_trial_registrations SET outcome = ?, outcome_note = ?, outcome_at = ? WHERE id = ? AND open_trial_id = ? AND outcome IS NULL RETURNING "
                  <> reg_row.columns,
                [
                  sqlight.text(reg_row.outcome_to_string(outcome)),
                  sqlight.nullable(sqlight.text, note),
                  sqlight.int(now),
                  id.open_trial_registration_sql(r.id),
                  id.open_trial_sql(t.row.id),
                ],
                reg_row.decoder(),
              ))
              case rows {
                [answered] -> {
                  use _ <- result.map(tell(
                    tx,
                    a,
                    t,
                    answered,
                    outcome,
                    note,
                    now,
                  ))
                  live_pings.catalogue(tx, live_event.OpenTrials)
                  answered
                }
                _ -> store.refuse(AlreadyResolved)
              }
            })
          case answered {
            Ok(r) ->
              http.json(
                200,
                json.object([
                  #("registration", json.object(registration_fields(r))),
                ]),
              )
            Error(store.Refused(AlreadyResolved)) ->
              http.error(409, "ALREADY_RESOLVED")
            Error(store.Refused(RegistrationNotFound)) ->
              http.error(404, "REGISTRATION_NOT_FOUND")
            Error(failure) -> http.internal(failure)
          }
        }
      }
  }
}

/// The answer's effects on a registrant the club may see: the invitation, or the kind no.
fn tell(
  tx: Tx,
  a: OrgAccess,
  t: Trial,
  r: reg_row.Row,
  outcome: reg_row.Outcome,
  note: Option(String),
  now: Int,
) -> Result(Nil, Fail(AnswerRefusal)) {
  let read = store.reading(tx)
  use seen <- result.try(players.for_org(read, r.player_id, a.org, now))
  case seen {
    Some(#(p, access)) if access.visible ->
      case outcome {
        reg_row.InviteTrial -> invite(tx, a, t, p, note, now)
        reg_row.Declined -> {
          let kind_no =
            option.unwrap(
              note,
              "Thanks for coming — not this time, but keep playing and keep logging your football.",
            )
          let notice = fn(kind, to, text) {
            notifications.notify(
              tx,
              to: kind,
              id: to,
              type_: "open_trial",
              text:,
              ref_id: Some(id.open_trial_to_string(t.row.id)),
              at: now,
            )
          }
          use _ <- result.try(case players.is_adult(p, now), p.row.guardian_id {
            False, Some(g) ->
              notice(
                audience.Guardian,
                id.guardian_to_string(g),
                a.org.name <> " on " <> p.row.name <> "'s open day: " <> kind_no,
              )
            _, _ -> Ok(Nil)
          })
          notice(
            audience.Player,
            id.player_to_string(p.row.id),
            a.org.name <> ": " <> kind_no,
          )
        }
      }
    _ -> Ok(Nil)
  }
}

/// The trial invitation after an open day (issueRecruitmentRequest): the request row, its ledger entry and the
/// notices in the open-day wording. Several pending invitations per player are allowed.
fn invite(
  tx: Tx,
  a: OrgAccess,
  t: Trial,
  p: Player,
  note: Option(String),
  now: Int,
) -> Result(Nil, Fail(e)) {
  let read = store.reading(tx)
  let adult = players.is_adult(p, now)
  let guardian_id = case adult {
    True -> None
    False -> p.row.guardian_id
  }
  use certified <- result.try(orgs.safeguarding_certified(read, a.org))
  use request <- result.try(requests.create_direct_trial(
    tx,
    requests.NewContact(
      player_id: p.row.id,
      player_name: p.row.name,
      org_id: a.org.id,
      org_name: a.org.name,
      org_type: a.org.type_,
      org_verified: a.org.verified,
      org_safeguarding_certified: certified,
      org_trusted_partner: a.org.trusted_partner,
      user_id: a.user.id,
      scout_name: a.user.name,
      scout_role: case a.user.role {
        "" -> "Scout"
        role -> role
      },
      message: option.unwrap(
        note,
        "We liked what we saw at \""
          <> t.row.title
          <> "\" — come for a proper trial.",
      ),
      guardian_id:,
      at: now,
      subject: None,
      contact_id: None,
    ),
    None,
    [],
    Some(t.row.venue),
    "Follow-up from open day \"" <> t.row.title <> "\".",
  ))
  use _ <- result.try(ledger.append(
    tx,
    ledger.Entry(
      event: ledger.Plain(case adult {
        True -> ledger_row.TrialRequest
        False -> ledger_row.TrialRequestToGuardian
      }),
      player_id: Some(p.row.id),
      org_id: Some(a.org.id),
      org_name: Some(a.org.name),
      user_id: Some(a.user.id),
      actor_name: Some(a.user.name),
    ),
    now,
  ))
  let notice = fn(kind, to, text) {
    notifications.notify(
      tx,
      to: kind,
      id: to,
      type_: "open_trial",
      text:,
      ref_id: Some(id.request_to_string(request.id)),
      at: now,
    )
  }
  use _ <- result.try(case adult, request.guardian_id {
    False, Some(g) ->
      notice(
        audience.Guardian,
        id.guardian_to_string(g),
        "Good news: "
          <> a.org.name
          <> " would like to invite "
          <> p.row.name
          <> " for a trial after the open day.",
      )
    _, _ -> Ok(Nil)
  })
  notice(audience.Player, id.player_to_string(p.row.id), case adult {
    True ->
      a.org.name
      <> " liked what they saw at \""
      <> t.row.title
      <> "\" — trial invitation in your inbox."
    False ->
      a.org.name
      <> " liked what they saw at the open day — they've contacted your parent/guardian about a trial."
  })
}

// ----------------------------------------------------------------------------------- registering for one

type RegisterRefusal {
  AlreadyRegistered
}

fn register(
  ctx: Ctx,
  t: Trial,
  child: Player,
  guardian: Option(Guardian),
  notices: fn(Tx, Int) -> Result(Nil, Fail(RegisterRefusal)),
) -> Response {
  let now = clock.now_ms()
  let done =
    store.unit(ctx.store, fn(tx) {
      use taken <- result.try(store.one(
        store.reading(tx),
        "SELECT 1 FROM open_trial_registrations WHERE open_trial_id = ? AND player_id = ?",
        [id.open_trial_sql(t.row.id), id.player_sql(child.row.id)],
        decode.at([0], decode.int),
      ))
      case taken {
        Ok(_) -> store.refuse(AlreadyRegistered)
        Error(_) -> {
          use reg_id <- result.try(id.next_open_trial_registration(tx))
          use _ <- result.try(reg_row.insert(
            tx,
            reg_row.Row(
              ..reg_row.new(
                id: reg_id,
                open_trial_id: t.row.id,
                player_id: child.row.id,
                by_guardian: guardian != None,
                registered_at: now,
              ),
              player_name: Some(input.utf16_take(
                child.row.name,
                player_name_max,
              )),
              guardian_id: option.map(guardian, fn(g) { g.row.id }),
            ),
          ))
          use _ <- result.try(ledger.append(
            tx,
            ledger.Entry(
              event: ledger.Plain(case guardian {
                Some(_) -> ledger_row.OpenTrialRegistrationByGuardian
                None -> ledger_row.OpenTrialRegistration
              }),
              player_id: Some(child.row.id),
              org_id: Some(t.row.org_id),
              org_name: Some(t.org_name),
              user_id: Some(t.row.created_by_user_id),
              actor_name: Some("open day"),
            ),
            now,
          ))
          notices(tx, now)
        }
      }
    })
  case done {
    Ok(_) -> http.json(201, json.object([#("registered", json.bool(True))]))
    Error(store.Refused(AlreadyRegistered)) ->
      http.error(409, "ALREADY_REGISTERED")
    Error(failure) -> http.internal(failure)
  }
}

fn tell_host(tx: Tx, t: Trial, text: String, now: Int) -> Result(Nil, Fail(e)) {
  notifications.notify(
    tx,
    to: audience.OrgUser,
    id: id.org_user_to_string(t.row.created_by_user_id),
    type_: "open_trial",
    text:,
    ref_id: Some(id.open_trial_to_string(t.row.id)),
    at: now,
  )
}

/// `POST /player/open-trials/:id/register`: an adult registers for a local open day (within the radius of them).
pub fn player_register(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  trial_id: id.OpenTrialId,
) -> Response {
  use <- grassroots_journey.grassroots_only(p)
  use <- access.guardian_managed_only(p)
  use _ <- http.body(req, input.nothing(), [])
  let me = p.player.row
  let found =
    store.read(ctx.store, fn(read) {
      use t <- result.try(by_id(read, trial_id))
      case t {
        None -> Ok(None)
        Some(t) -> {
          use near <- result.map(host_near(read, t.row.org_id, me.lat, me.lng))
          Some(#(t, near))
        }
      }
    })
  case found {
    Error(failure) -> http.internal(failure)
    Ok(None) -> http.error(404, "OPEN_TRIAL_NOT_FOUND")
    Ok(Some(#(_, False))) ->
      http.error_message(
        403,
        "OUT_OF_RADIUS",
        "Open days are local — this one is beyond 50km of you.",
      )
    Ok(Some(#(t, True))) ->
      case registered(t, me.id) {
        True -> http.error(409, "ALREADY_REGISTERED")
        False -> register_self(ctx, t, p.player)
      }
  }
}

fn register_self(ctx: Ctx, t: Trial, me: Player) -> Response {
  use tx, now <- register(ctx, t, me, None)
  tell_host(
    tx,
    t,
    me.row.name <> " registered for \"" <> t.row.title <> "\".",
    now,
  )
}

/// Whether the host club has a location within the Grassroots radius of the point; false when either is unknown.
fn host_near(
  read: Read,
  org_id: id.OrgId,
  lat: Option(Float),
  lng: Option(Float),
) -> Result(Bool, Fail(e)) {
  case lat, lng {
    Some(lat), Some(lng) -> {
      let q =
        sql.concat([
          sql.text("SELECT "),
          distance.within_grassroots_radius(
            Columns("o.lat", "o.lng"),
            At(lat, lng),
          ),
          sql.text(" FROM orgs o WHERE o.id = "),
          sql.arg(id.org_sql(org_id)),
        ])
      store.one(read, q.sql, q.args, decode.at([0], decode.int))
      |> result.map(fn(found) { found == Ok(1) })
    }
    _, _ -> Ok(False)
  }
}

/// `GET /guardian/children/:id/open-trials`: the open days near the child, only from Grassroots clubs allowed to
/// see the child at all. Past days stay listed, so a parent still sees the one their child registered for.
pub fn for_child(ctx: Ctx, child: Player) -> Response {
  case child.row.lat, child.row.lng {
    Some(lat), Some(lng) -> {
      let now = clock.now_ms()
      let here = At(lat, lng)
      let listed =
        store.read(ctx.store, fn(read) {
          use found <- result.try(trials(
            read,
            sql.concat([
              sql.text("o.level = 'grassroots' AND "),
              distance.within_grassroots_radius(Columns("o.lat", "o.lng"), here),
              sql.text(" ORDER BY t.trial_date, t.id"),
            ]),
          ))
          let org_ids = list.map(found, fn(t) { t.row.org_id }) |> list.unique
          use hosts <- result.map(
            list.try_map(org_ids, fn(oid) {
              host_view(read, oid, child, here, now)
            }),
          )
          let hosts = result.values(hosts)
          list.filter_map(found, fn(t) {
            list.key_find(hosts, t.row.org_id)
            |> result.map(fn(host) { #(t, host) })
          })
        })
      case listed {
        Error(failure) -> http.internal(failure)
        Ok(found) ->
          http.json(
            200,
            json.object([
              #(
                "openTrials",
                json.array(found, fn(pair) {
                  let #(t, #(org, certified, tenths)) = pair
                  json.object([
                    #("id", id.open_trial_json(t.row.id)),
                    #("title", json.string(t.row.title)),
                    #("date", json.string(t.row.trial_date)),
                    #("venue", json.string(t.row.venue)),
                    #("ageGroup", json.string(t.row.age_group)),
                    #("positions", json.array(t.positions, json.string)),
                    #("orgName", json.string(org.name)),
                    #("verified", json.bool(org.verified)),
                    #("safeguardingCertified", json.bool(certified)),
                    #("distanceKm", km(tenths)),
                    #("registered", json.bool(registered(t, child.row.id))),
                  ])
                }),
              ),
            ]),
          )
      }
    }
    _, _ ->
      http.json(
        200,
        json.object([
          #("openTrials", json.preprocessed_array([])),
          #(
            "note",
            json.string("Set a location on the profile to see local open days."),
          ),
        ]),
      )
  }
}

/// A distance in tenths of a km, as JavaScript writes `Math.round(km * 10) / 10`.
pub fn km(tenths: Int) -> Json {
  json_text.number(int.to_float(tenths) /. 10.0)
}

/// The host, if it may see the child: the club, whether it is safeguarding-certified, its distance in tenths.
fn host_view(
  read: Read,
  org_id: id.OrgId,
  child: Player,
  here: distance.Point,
  now: Int,
) -> Result(Result(#(id.OrgId, #(Org, Bool, Int)), Nil), Fail(e)) {
  use org <- result.try(orgs.by_id(read, org_id))
  case org {
    None -> Ok(Error(Nil))
    Some(org) -> {
      use seen <- result.try(players.for_org(read, child.row.id, org, now))
      case seen {
        Some(#(_, access)) if access.visible -> {
          use certified <- result.try(orgs.safeguarding_certified(read, org))
          let q =
            sql.concat([
              sql.text("SELECT "),
              distance.tenths(Columns("o.lat", "o.lng"), here),
              sql.text(" FROM orgs o WHERE o.id = "),
              sql.arg(id.org_sql(org_id)),
            ])
          use tenths <- result.map(store.one(
            read,
            q.sql,
            q.args,
            decode.at([0], decode.int),
          ))
          Ok(#(org_id, #(org, certified, result.unwrap(tenths, 0))))
        }
        _ -> Ok(Error(Nil))
      }
    }
  }
}

type Found {
  NoChild
  NoTrial
  NotVisible
  Found(child: Player, trial: Trial, host: Org)
}

/// `POST /guardian/open-trials/:id/register`: the guardian registers their child, with a club allowed to see them.
pub fn guardian_register(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  trial_id: id.OpenTrialId,
) -> Response {
  let shape = {
    use child_id <- input.field("childId", input.nullish(input.id()))
    input.done(child_id)
  }
  use child_id <- http.body(req, shape, [])
  let now = clock.now_ms()
  let found = case option.map(child_id, id.player) {
    Some(cid) ->
      case list.contains(g.child_ids, cid) {
        True -> store.read(ctx.store, find(_, cid, trial_id, now))
        False -> Ok(NoChild)
      }
    None -> Ok(NoChild)
  }
  case found {
    Error(failure) -> http.internal(failure)
    Ok(NoChild) -> http.error(404, "CHILD_NOT_FOUND")
    Ok(NoTrial) -> http.error(404, "OPEN_TRIAL_NOT_FOUND")
    Ok(NotVisible) ->
      http.error_message(
        403,
        "VERIFIED_CLUBS_ONLY",
        "Only verified, local clubs can receive an under-18 registration.",
      )
    Ok(Found(child, t, org)) ->
      case registered(t, child.row.id) {
        True -> http.error(409, "ALREADY_REGISTERED")
        False -> {
          use tx, now <- register(ctx, t, child, Some(g))
          use _ <- result.try(tell_host(
            tx,
            t,
            child.row.name
              <> " (via guardian) registered for \""
              <> t.row.title
              <> "\".",
            now,
          ))
          notifications.notify(
            tx,
            to: audience.Player,
            id: id.player_to_string(child.row.id),
            type_: "open_trial",
            text: "Your parent/guardian registered you for "
              <> org.name
              <> "'s open day \""
              <> t.row.title
              <> "\" — good luck!",
            ref_id: Some(id.open_trial_to_string(t.row.id)),
            at: now,
          )
        }
      }
  }
}

fn find(
  read: Read,
  child_id: id.PlayerId,
  trial_id: id.OpenTrialId,
  now: Int,
) -> Result(Found, Fail(e)) {
  use child <- result.try(players.by_id(read, child_id))
  use t <- result.try(by_id(read, trial_id))
  case child, t {
    None, _ -> Ok(NoChild)
    _, None -> Ok(NoTrial)
    Some(child), Some(t) -> {
      use org <- result.try(orgs.by_id(read, t.row.org_id))
      case org {
        None -> Ok(NotVisible)
        Some(org) -> {
          use seen <- result.map(players.for_org(read, child_id, org, now))
          case seen {
            Some(#(_, access)) if access.visible -> Found(child, t, org)
            _ -> NotVisible
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------- the radar

/// `GET /player/opportunities`: the Grassroots clubs within the radius, nearest first, with what each is looking
/// for, its development record and its upcoming open days.
pub fn radar(ctx: Ctx, p: PlayerAccess) -> Response {
  use <- grassroots_journey.grassroots_only(p)
  let me = p.player.row
  case me.lat, me.lng {
    Some(lat), Some(lng) -> {
      let here = At(lat, lng)
      let today = clock.iso_day(clock.now_ms())
      let q =
        sql.concat([
          sql.text("SELECT id, "),
          distance.tenths(Columns("o.lat", "o.lng"), here),
          sql.text(" AS tenths FROM orgs o WHERE o.level = 'grassroots' AND "),
          distance.within_grassroots_radius(Columns("o.lat", "o.lng"), here),
          sql.text(" ORDER BY tenths, o.rowid"),
        ])
      let found =
        store.read(ctx.store, fn(read) {
          use near <- result.try(
            store.query(read, q.sql, q.args, {
              use oid <- decode.field(0, id.org_decoder())
              use tenths <- decode.field(1, decode.int)
              decode.success(#(oid, tenths))
            }),
          )
          use upcoming <- result.try(upcoming_for_orgs(
            read,
            list.map(near, fn(n) { n.0 }),
            today,
          ))
          list.try_map(near, fn(n) {
            let #(oid, tenths) = n
            use org <- result.try(orgs.by_id(read, oid))
            let assert Some(org) = org as "the query read this club"
            use certified <- result.try(orgs.safeguarding_certified(read, org))
            use record <- result.try(grassroots_club.pathway_record(read, oid))
            use looking_for <- result.map(orgs.looking_for(read, oid))
            #(
              org,
              tenths,
              certified,
              record,
              looking_for,
              list.filter(upcoming, fn(t) { t.row.org_id == oid }),
            )
          })
        })
      case found {
        Error(failure) -> http.internal(failure)
        Ok(clubs) ->
          http.json(
            200,
            json.object([
              #("radiusKm", json.int(50)),
              #(
                "clubs",
                json.array(clubs, fn(c) {
                  let #(org, tenths, certified, record, looking_for, days) = c
                  json.object(
                    list.flatten([
                      [
                        #("id", id.org_json(org.id)),
                        #("name", json.string(org.name)),
                        #("city", json.string(option.unwrap(org.city, ""))),
                        #("distanceKm", km(tenths)),
                        #("verified", json.bool(org.verified)),
                        #("safeguardingCertified", json.bool(certified)),
                      ],
                      grassroots_club.pathway_fields(record),
                      [
                        #(
                          "lookingFor",
                          json.array(looking_for, position.to_json),
                        ),
                        #(
                          "openTrials",
                          json.array(days, fn(t) {
                            json.object(
                              list.append(fields(t), [
                                #("registered", json.bool(registered(t, me.id))),
                              ]),
                            )
                          }),
                        ),
                      ],
                    ]),
                  )
                }),
              ),
              #(
                "lookingForYou",
                json.int(
                  list.count(clubs, fn(c) {
                    case me.position {
                      Some(mine) -> list.contains(c.4, mine)
                      None -> False
                    }
                  }),
                ),
              ),
            ]),
          )
      }
    }
    _, _ ->
      http.json(
        200,
        json.object([
          #("clubs", json.preprocessed_array([])),
          #("note", json.string("Set your location to see clubs within reach.")),
        ]),
      )
  }
}
