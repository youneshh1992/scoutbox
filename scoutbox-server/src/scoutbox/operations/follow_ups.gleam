//// Signing follow-ups and outcome reports (domains/operations/followUps.mjs): every signing gets 3, 6 and 12-month
//// follow-ups; when one comes due the club files an outcome report, which the player (a guardian for a child)
//// confirms or disputes. Scheduled behaviour is a row examined by an idempotent sweep at boot and every minute: the
//// marker that a reminder went out is in the database, so a restart loses and re-sends nothing.
////
//// Also here, as in the TypeScript server: the player's football category, and Trust & Safety's `/admin/sweep`.

import gleam/dynamic
import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess, type PlayerAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/orgs
import scoutbox/identity/players
import scoutbox/identity/staff
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/pages
import scoutbox/platform/paging.{IntKey, IntKind, TextKey, TextKind}
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/recruitment/trial_routes
import scoutbox/rows/follow_ups as row
import scoutbox/rows/id
import scoutbox/rows/opportunities as opportunity_row
import scoutbox/rows/outcome_report_confirmations as confirmation_row
import scoutbox/rows/outcome_reports as report_row
import scoutbox/rows/signings as signing_row
import scoutbox/safety/audit
import scoutbox/safety/moderate
import scoutbox/scouting/opportunity_applications
import scoutbox/vocab/audience
import scoutbox/vocab/party
import sqlight
import wisp.{type Request, type Response}

const day_ms = 86_400_000

/// Each milestone with the days after the signing it falls due.
const milestones = [#(row.V3m, 91), #(row.V6m, 182), #(row.V12m, 365)]

// OUTCOME_LIMITS (domains/operations/schemas.mjs).
const progression_max = 200

const end_reason_max = 200

const note_max = 300

const max_safe = 9_007_199_254_740_991

// ---------------------------------------------------------------------------------------------------- records

type Report {
  Report(row: report_row.Row, confirmations: List(confirmation_row.Row))
}

fn follow_up_by_id(
  read: Read,
  fid: id.FollowUpId,
) -> Result(Option(row.Row), Fail(e)) {
  store.one(
    read,
    "SELECT " <> row.columns <> " FROM follow_ups WHERE id = ?",
    [id.follow_up_sql(fid)],
    row.decoder(),
  )
  |> result.map(option.from_result)
}

fn report_for(
  read: Read,
  fid: id.FollowUpId,
) -> Result(Option(Report), Fail(e)) {
  use found <- result.try(store.one(
    read,
    "SELECT "
      <> report_row.columns
      <> " FROM outcome_reports WHERE follow_up_id = ?",
    [id.follow_up_sql(fid)],
    report_row.decoder(),
  ))
  case found {
    Error(Nil) -> Ok(None)
    Ok(r) -> {
      use confirmations <- result.map(store.query(
        read,
        "SELECT "
          <> confirmation_row.columns
          <> " FROM outcome_report_confirmations WHERE report_id = ? ORDER BY position",
        [id.outcome_report_sql(r.id)],
        confirmation_row.decoder(),
      ))
      Some(Report(row: r, confirmations:))
    }
  }
}

fn player_name(
  read: Read,
  pid: id.PlayerId,
) -> Result(Option(String), Fail(e)) {
  store.one(
    read,
    "SELECT name FROM players WHERE id = ? AND deleted_at IS NULL",
    [id.player_sql(pid)],
    decode.at([0], decode.string),
  )
  |> result.map(option.from_result)
}

// ------------------------------------------------------------------------------------------------------ views

fn report_json(r: Report) -> Json {
  let x = r.row
  json.object([
    #("id", id.outcome_report_json(x.id)),
    #("followUpId", id.follow_up_json(x.follow_up_id)),
    #("signingId", id.signing_json(x.signing_id)),
    #("playerId", id.player_json(x.player_id)),
    #("orgId", id.org_json(x.org_id)),
    #(
      "by",
      json.object([
        #("kind", json.string("org")),
        #("id", id.org_user_json(x.by_user_id)),
        #("name", json.nullable(x.by_name, json.string)),
      ]),
    ),
    #(
      "registrationStatus",
      report_row.registration_status_to_json(x.registration_status),
    ),
    #("matchesPlayed", json.nullable(x.matches_played, json.int)),
    #("progression", json.nullable(x.progression, json.string)),
    #("endReason", json.nullable(x.end_reason, json.string)),
    #("note", json.nullable(x.note, json.string)),
    #("status", report_row.status_to_json(x.status)),
    #(
      "confirmations",
      json.array(r.confirmations, fn(c) {
        json.object([
          #(
            "by",
            json.object([
              #("kind", party.to_json(c.by_kind)),
              #("id", json.string(c.by_id)),
              #("name", json.nullable(c.by_name, json.string)),
            ]),
          ),
          #("agree", json.bool(c.agree)),
          #("note", json.nullable(c.note, json.string)),
          #("experienceRating", json.nullable(c.experience_rating, json.int)),
          #("at", json.int(c.at)),
        ])
      }),
    ),
    #("at", json.int(x.at)),
  ])
}

fn outcome_state(f: row.Row, report: Option(Report)) -> String {
  case report {
    None ->
      case f.status {
        row.Due -> "unknown_pending"
        _ -> "not_due"
      }
    Some(r) ->
      case
        list.any(r.confirmations, fn(c) { !c.agree }),
        list.any(r.confirmations, fn(c) { c.agree })
      {
        True, _ -> "disputed"
        _, True -> "confirmed"
        _, _ -> "reported"
      }
  }
}

fn view(read: Read, f: row.Row) -> Result(Json, Fail(e)) {
  use report <- result.try(report_for(read, f.id))
  use name <- result.try(player_name(read, f.player_id))
  use org <- result.map(orgs.by_id(read, f.org_id))
  json.object([
    #("id", id.follow_up_json(f.id)),
    #("signingId", id.signing_json(f.signing_id)),
    #("playerId", id.player_json(f.player_id)),
    #("orgId", id.org_json(f.org_id)),
    #("milestone", row.milestone_to_json(f.milestone)),
    #("dueAt", json.int(f.due_at)),
    #("status", row.status_to_json(f.status)),
    #("notifiedAt", json.nullable(f.notified_at, json.int)),
    #("createdAt", json.int(f.created_at)),
    #("playerName", json.string(option.unwrap(name, "departed player"))),
    #(
      "orgName",
      json.string(case org {
        Some(o) -> o.name
        None -> id.org_to_string(f.org_id)
      }),
    ),
    #("report", json.nullable(report, report_json)),
    #("outcomeState", json.string(outcome_state(f, report))),
  ])
}

fn follow_up_answer(ctx: Ctx, status: Int, fid: id.FollowUpId) -> Response {
  let found =
    store.read(ctx.store, fn(read) {
      use f <- result.try(follow_up_by_id(read, fid))
      case f {
        Some(f) -> view(read, f) |> result.map(Some)
        None -> Ok(None)
      }
    })
  case found {
    Ok(Some(v)) -> http.json(status, json.object([#("followUp", v)]))
    Ok(None) -> http.error(404, "FOLLOWUP_NOT_FOUND")
    Error(failure) -> http.internal(failure)
  }
}

fn list_answer(
  ctx: Ctx,
  rows: fn(Read) -> Result(List(row.Row), Fail(e)),
) -> Response {
  let found =
    store.read(ctx.store, fn(read) {
      use rows <- result.try(rows(read))
      list.try_map(rows, view(read, _))
    })
  case found {
    Ok(items) -> http.json(200, json.preprocessed_array(items))
    Error(failure) -> http.internal(failure)
  }
}

fn finished(r: Result(Response, store.UnitError(Response))) -> Response {
  case r {
    Ok(response) -> response
    Error(store.Refused(response)) -> response
    Error(store.Lost(what)) -> http.stale(what)
    Error(e) -> http.internal(e)
  }
}

// ------------------------------------------------------------------------------------------------- the club

/// `GET /org/followups`: the organisation's follow-ups by due date, then id.
pub fn org_list(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use page <- pages.strict(req, [IntKind, TextKind])
  let #(after, args) = case page.after {
    Some([IntKey(due), TextKey(fid)]) -> #(
      " AND (due_at > ? OR (due_at = ? AND id > ?))",
      [sqlight.int(due), sqlight.int(due), sqlight.text(fid)],
    )
    _ -> #("", [])
  }
  let found =
    store.read(ctx.store, fn(read) {
      use rows <- result.try(store.query(
        read,
        "SELECT "
          <> row.columns
          <> " FROM follow_ups WHERE org_id = ?"
          <> after
          <> " ORDER BY due_at, id LIMIT ?",
        list.flatten([
          [id.org_sql(a.org.id)],
          args,
          [sqlight.int(page.limit + 1)],
        ]),
        row.decoder(),
      ))
      let #(items, next) =
        paging.page_of(rows, page.limit, fn(f) {
          [IntKey(f.due_at), TextKey(id.follow_up_to_string(f.id))]
        })
      use views <- result.map(list.try_map(items, view(read, _)))
      #(views, next)
    })
  case found {
    Ok(#(views, next)) -> pages.respond(views, next, fn(v) { v })
    Error(failure) -> http.internal(failure)
  }
}

type NewReport {
  NewReport(
    registration_status: report_row.RegistrationStatus,
    matches_played: Option(Int),
    progression: Option(String),
    end_reason: Option(String),
    note: Option(String),
  )
}

/// `|| null`: empty text is no value.
fn or_none(s: Option(String)) -> Option(String) {
  case s {
    Some("") -> None
    other -> other
  }
}

/// `POST /org/followups/:id/report`: the club's outcome report on a follow-up, once.
pub fn report(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  fid: id.FollowUpId,
) -> Response {
  let found =
    store.read(ctx.store, fn(read) {
      use f <- result.try(follow_up_by_id(read, fid))
      case f {
        Some(f) if f.org_id == a.org.id -> {
          use r <- result.map(report_for(read, f.id))
          Some(#(f, option.is_some(r)))
        }
        _ -> Ok(None)
      }
    })
  case found {
    Error(failure) -> http.internal(failure)
    Ok(None) -> http.error(404, "FOLLOWUP_NOT_FOUND")
    Ok(Some(#(_, True))) -> http.error(409, "ALREADY_REPORTED")
    Ok(Some(#(f, False))) -> {
      let shape = {
        use registration_status <- input.field(
          "registrationStatus",
          input.required(input.one_of(report_row.registration_status_pairs)),
        )
        use matches_played <- input.field(
          "matchesPlayed",
          input.nullish(input.whole_number(0, max_safe)),
        )
        use progression <- input.field(
          "progression",
          input.nullish(input.text(progression_max)),
        )
        use end_reason <- input.field(
          "endReason",
          input.nullish(input.text(end_reason_max)),
        )
        use note <- input.field("note", input.nullish(input.text(note_max)))
        input.done(NewReport(
          registration_status:,
          matches_played:,
          progression:,
          end_reason:,
          note:,
        ))
      }
      use b <- http.body(req, shape, [
        #("registrationStatus", "REGISTRATION_STATUS_INVALID"),
      ])
      use <- moderated(
        ctx,
        or_none(b.note),
        "outcome_report",
        f.player_id,
        Some(a.org.id),
      )
      file_report(ctx, a, f, b)
    }
  }
}

fn moderated(
  ctx: Ctx,
  note: Option(String),
  kind: String,
  pid: id.PlayerId,
  org_id: Option(id.OrgId),
  next: fn() -> Response,
) -> Response {
  case note {
    None -> next()
    Some(note) ->
      moderate.or_refuse(
        ctx,
        note,
        audit.Context(
          kind:,
          player_id: Some(pid),
          org_id:,
          user_id: None,
          channel_id: None,
          request_id: None,
        ),
        next,
      )
  }
}

fn file_report(ctx: Ctx, a: OrgAccess, f: row.Row, b: NewReport) -> Response {
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use existing <- result.try(report_for(read, f.id))
    case existing {
      Some(_) -> store.refuse(http.error(409, "ALREADY_REPORTED"))
      None -> {
        use rid <- result.try(id.next_outcome_report(tx))
        use _ <- result.try(report_row.insert(
          tx,
          report_row.Row(
            id: rid,
            follow_up_id: f.id,
            signing_id: f.signing_id,
            player_id: f.player_id,
            org_id: f.org_id,
            by_user_id: a.user.id,
            by_name: Some(a.user.name),
            registration_status: b.registration_status,
            matches_played: b.matches_played,
            progression: or_none(b.progression),
            end_reason: or_none(b.end_reason),
            note: or_none(b.note),
            status: report_row.Reported,
            at: now,
          ),
        ))
        use _ <- result.try(
          store.run(tx, "UPDATE follow_ups SET status = ? WHERE id = ?", [
            sqlight.text(row.status_to_string(row.Complete)),
            id.follow_up_sql(f.id),
          ]),
        )
        use _ <- result.try(notify_family(
          tx,
          f.player_id,
          "outcome",
          "📊 "
            <> a.org.name
            <> " filed the "
            <> row.milestone_to_string(f.milestone)
            <> " follow-up on the signing — please confirm or dispute it.",
          fn(_) {
            "📊 "
            <> a.org.name
            <> " filed the "
            <> row.milestone_to_string(f.milestone)
            <> " follow-up on the signing — please confirm or dispute it."
          },
          f.id,
          now,
        ))
        Ok(Nil)
      }
    }
  })
  |> result.map(fn(_) { follow_up_answer(ctx, 201, f.id) })
  |> finished
}

/// Notifies the family about a follow-up: a child's guardian, or the player. `to_guardian` writes the guardian's
/// text from the child's name.
fn notify_family(
  tx: Tx,
  pid: id.PlayerId,
  type_: String,
  to_player: String,
  to_guardian: fn(String) -> String,
  fid: id.FollowUpId,
  now: Int,
) -> Result(Nil, Fail(e)) {
  use found <- result.try(players.by_id(store.reading(tx), pid))
  let ref_id = Some(id.follow_up_to_string(fid))
  case found {
    None -> Ok(Nil)
    Some(p) ->
      case players.is_adult(p, now), p.row.guardian_id {
        False, Some(g) ->
          notifications.notify(
            tx,
            to: audience.Guardian,
            id: id.guardian_to_string(g),
            type_:,
            text: to_guardian(p.row.name),
            ref_id:,
            at: now,
          )
        _, _ ->
          notifications.notify(
            tx,
            to: audience.Player,
            id: id.player_to_string(p.row.id),
            type_:,
            text: to_player,
            ref_id:,
            at: now,
          )
      }
  }
}

// ----------------------------------------------------------------------------------------------- the family

/// `GET /player/followups`.
pub fn player_list(ctx: Ctx, p: PlayerAccess) -> Response {
  list_answer(ctx, fn(read) {
    store.query(
      read,
      "SELECT "
        <> row.columns
        <> " FROM follow_ups WHERE player_id = ? ORDER BY rowid",
      [id.player_sql(p.player.row.id)],
      row.decoder(),
    )
  })
}

/// `GET /guardian/followups`: the children's follow-ups, in insertion order.
pub fn guardian_list(ctx: Ctx, g: Guardian) -> Response {
  list_answer(ctx, fn(read) {
    store.query(
      read,
      "SELECT "
        <> row.columns
        <> " FROM follow_ups WHERE player_id IN (SELECT value FROM json_each(?)) ORDER BY rowid",
      [
        sqlight.text(json.to_string(json.array(g.child_ids, id.player_json))),
      ],
      row.decoder(),
    )
  })
}

type Actor {
  Actor(kind: party.Party, id: String, name: String)
}

/// `POST /player/followups/:id/respond`.
pub fn player_respond(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  fid: id.FollowUpId,
) -> Response {
  case p.minor {
    True ->
      http.error_message(
        403,
        "GUARDIAN_MANAGED",
        "Your parent/guardian confirms placement outcomes.",
      )
    False ->
      respond(
        ctx,
        req,
        fid,
        [p.player.row.id],
        Actor(
          party.Player,
          id.player_to_string(p.player.row.id),
          p.player.row.name,
        ),
      )
  }
}

/// `POST /guardian/followups/:id/respond`.
pub fn guardian_respond(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  fid: id.FollowUpId,
) -> Response {
  respond(
    ctx,
    req,
    fid,
    g.child_ids,
    Actor(party.Guardian, id.guardian_to_string(g.row.id), g.row.name),
  )
}

type Answer {
  Answer(agree: Bool, note: Option(String), experience_rating: Option(Int))
}

fn respond(
  ctx: Ctx,
  req: Request,
  fid: id.FollowUpId,
  player_ids: List(id.PlayerId),
  actor: Actor,
) -> Response {
  use req <- http.rerun_on_stale(req)
  let found =
    store.read(ctx.store, fn(read) {
      use f <- result.try(follow_up_by_id(read, fid))
      case f {
        Some(f) ->
          case list.contains(player_ids, f.player_id) {
            True ->
              report_for(read, f.id)
              |> result.map(option.map(_, fn(r) { #(f, r) }))
            False -> Ok(None)
          }
        None -> Ok(None)
      }
    })
  case found {
    Error(failure) -> http.internal(failure)
    Ok(None) -> http.error(404, "REPORT_NOT_FOUND")
    Ok(Some(#(f, r))) ->
      case list.any(r.confirmations, fn(c) { c.by_id == actor.id }) {
        True -> http.error(409, "ALREADY_RESPONDED")
        False -> {
          let shape = {
            use agree <- input.field("agree", input.required(input.boolean()))
            use note <- input.field("note", input.nullish(input.text(note_max)))
            use experience_rating <- input.field(
              "experienceRating",
              input.nullish(input.whole_number(1, 5)),
            )
            input.done(Answer(agree:, note:, experience_rating:))
          }
          use b <- http.body(req, shape, [#("agree", "AGREE_REQUIRED")])
          use <- moderated(
            ctx,
            or_none(b.note),
            "outcome_response",
            f.player_id,
            None,
          )
          let now = clock.now_ms()
          store.unit(ctx.store, fn(tx) {
            use fresh <- result.try(report_for(store.reading(tx), f.id))
            let confirmations = case fresh {
              Some(r) -> r.confirmations
              None -> []
            }
            use <- guard(
              !list.any(confirmations, fn(c) { c.by_id == actor.id }),
              "the outcome report's answers",
            )
            use _ <- result.try(confirmation_row.insert(
              tx,
              confirmation_row.Row(
                report_id: r.row.id,
                position: list.length(confirmations),
                by_kind: actor.kind,
                by_id: actor.id,
                by_name: Some(actor.name),
                agree: b.agree,
                note: or_none(b.note),
                experience_rating: b.experience_rating,
                at: now,
              ),
            ))
            store.run(tx, "UPDATE outcome_reports SET status = ? WHERE id = ?", [
              sqlight.text(
                report_row.status_to_string(case b.agree {
                  True -> report_row.Confirmed
                  False -> report_row.Disputed
                }),
              ),
              id.outcome_report_sql(r.row.id),
            ])
          })
          |> result.map(fn(_) { follow_up_answer(ctx, 200, f.id) })
          |> finished
        }
      }
  }
}

/// Stale unless `holds`.
fn guard(
  holds: Bool,
  what: String,
  next: fn() -> Result(a, Fail(e)),
) -> Result(a, Fail(e)) {
  case holds {
    True -> next()
    False -> store.stale(what)
  }
}

/// `POST /player/football-category`: the category the player competes in, or null to clear it.
pub fn football_category(ctx: Ctx, req: Request, p: PlayerAccess) -> Response {
  let shape = {
    use category <- input.field(
      "category",
      input.required(fn(v) {
        case dynamic.classify(v) {
          "Nil" | "Null" -> Ok(None)
          _ ->
            input.one_of(opportunity_row.category_pairs)(v) |> result.map(Some)
        }
      }),
    )
    input.done(category)
  }
  use category <- http.body(req, shape, [#("category", "CATEGORY_INVALID")])
  let text = option.map(category, opportunity_row.category_to_string)
  let saved =
    store.unit(ctx.store, fn(tx) {
      store.run(tx, "UPDATE players SET football_category = ? WHERE id = ?", [
        sqlight.nullable(sqlight.text, text),
        id.player_sql(p.player.row.id),
      ])
    })
  case saved {
    Ok(Nil) ->
      http.json(
        200,
        json.object([#("footballCategory", json.nullable(text, json.string))]),
      )
    Error(e) -> http.internal(e)
  }
}

// ------------------------------------------------------------------------------------------- Trust & Safety

/// `GET /admin/outcomes`: per organisation with a signing, defined denominators and missing data named; groups
/// under 3 signings are suppressed so no individual answer can be inferred.
pub fn admin_outcomes(ctx: Ctx) -> Response {
  let totals =
    store.read(ctx.store, fn(read) {
      store.query(
        read,
        "SELECT o.id, o.name, t.signings, t.due, t.reported, t.confirmed, t.disputed, t.retained FROM orgs o JOIN (SELECT s.org_id AS org_id, COUNT(*) AS signings, (SELECT COUNT(*) FROM follow_ups f WHERE f.org_id = s.org_id AND f.status <> 'scheduled') AS due, (SELECT COUNT(*) FROM outcome_reports r WHERE r.org_id = s.org_id) AS reported, (SELECT COUNT(*) FROM outcome_reports r WHERE r.org_id = s.org_id AND r.status = 'confirmed') AS confirmed, (SELECT COUNT(*) FROM outcome_reports r WHERE r.org_id = s.org_id AND r.status = 'disputed') AS disputed, (SELECT COUNT(*) FROM outcome_reports r WHERE r.org_id = s.org_id AND r.registration_status = 'registered') AS retained FROM signings s GROUP BY s.org_id) t ON t.org_id = o.id ORDER BY o.rowid",
        [],
        {
          use org_id <- decode.field(0, id.org_decoder())
          use name <- decode.field(1, decode.string)
          use counts <- decode.field(2, decode.int)
          use due <- decode.field(3, decode.int)
          use reported <- decode.field(4, decode.int)
          use confirmed <- decode.field(5, decode.int)
          use disputed <- decode.field(6, decode.int)
          use retained <- decode.field(7, decode.int)
          decode.success(
            #(org_id, name, [
              counts,
              due,
              reported,
              confirmed,
              disputed,
              retained,
            ]),
          )
        },
      )
    })
  case totals {
    Error(failure) -> http.internal(failure)
    Ok(rows) ->
      http.json(
        200,
        json.object([
          #(
            "rows",
            json.array(rows, fn(r) {
              let #(org_id, name, counts) = r
              let head = [
                #("orgId", id.org_json(org_id)),
                #("orgName", json.string(name)),
              ]
              case counts {
                [signings, due, reported, confirmed, disputed, retained]
                  if signings >= 3
                ->
                  json.object(
                    list.append(head, [
                      #("suppressed", json.bool(False)),
                      #("signings", json.int(signings)),
                      #("followUpsDue", json.int(due)),
                      #("reported", json.int(reported)),
                      #("confirmed", json.int(confirmed)),
                      #("disputed", json.int(disputed)),
                      #("unknown", json.int(due - reported)),
                      #("retained", json.int(retained)),
                      #(
                        "denominator",
                        json.string(
                          "retention counts confirmed+reported registrations over "
                          <> int.to_string(due)
                          <> " due follow-ups ("
                          <> int.to_string(due - reported)
                          <> " unknown)",
                        ),
                      ),
                    ]),
                  )
                _ ->
                  json.object(
                    list.append(head, [
                      #("suppressed", json.bool(True)),
                      #(
                        "note",
                        json.string(
                          "Fewer than 3 signings — details suppressed to protect individual responses.",
                        ),
                      ),
                    ]),
                  )
              }
            }),
          ),
          #(
            "note",
            json.string(
              "Missing data is counted as unknown, never as failure or success.",
            ),
          ),
        ]),
      )
  }
}

/// `POST /admin/followups/:id`: Trust & Safety moves a follow-up's due date. It changes when, never what.
pub fn admin_due_at(ctx: Ctx, req: Request, fid: id.FollowUpId) -> Response {
  case store.read(ctx.store, follow_up_by_id(_, fid)) {
    Error(failure) -> http.internal(failure)
    Ok(None) -> http.error(404, "FOLLOWUP_NOT_FOUND")
    Ok(Some(f)) -> {
      let shape = {
        use due_at <- input.field(
          "dueAt",
          input.required(input.whole_number(0 - max_safe, max_safe)),
        )
        input.done(due_at)
      }
      use due_at <- http.body(req, shape, [#("dueAt", "DUE_AT_REQUIRED")])
      let saved =
        store.unit(ctx.store, fn(tx) {
          store.run(tx, "UPDATE follow_ups SET due_at = ? WHERE id = ?", [
            sqlight.int(due_at),
            id.follow_up_sql(f.id),
          ])
        })
      case saved {
        Ok(Nil) -> follow_up_answer(ctx, 200, f.id)
        Error(e) -> http.internal(e)
      }
    }
  }
}

/// `POST /admin/sweep`: runs the scheduled work now. It changes when things happen, never what.
///
/// Out of scope: the TypeScript sweep's clean-up of abandoned upload sessions.
pub fn admin_sweep(ctx: Ctx, req: Request) -> Response {
  use _ <- http.body(req, input.nothing(), [])
  let now = clock.now_ms()
  let _ = sweep(ctx, now)
  let _ = trial_routes.remind(ctx, now)
  http.json(200, json.object([#("ok", json.bool(True))]))
}

// -------------------------------------------------------------------------------------------------- the sweep

/// The follow-ups' part of the sweep: schedule any a signing is missing, mark those whose time has come due, and
/// tell the club and the family once; then the week-old application reminders. Each step re-checks inside its unit,
/// so overlapping sweeps do nothing twice.
pub fn sweep(ctx: Ctx, now: Int) -> Result(Nil, Nil) {
  use _ <- result.try(backfill(ctx, now))
  use _ <- result.try(mark_due(ctx, now))
  use _ <- result.try(notify_due(ctx, now))
  opportunity_applications.remind(ctx, now)
}

fn ignore(r: Result(a, b)) -> Result(Nil, Nil) {
  result.replace(r, Nil) |> result.replace_error(Nil)
}

fn backfill(ctx: Ctx, now: Int) -> Result(Nil, Nil) {
  use missing <- result.try(
    store.read(ctx.store, fn(read) {
      store.query(
        read,
        "SELECT "
          <> signing_row.columns
          <> " FROM signings s WHERE (SELECT COUNT(*) FROM follow_ups f WHERE f.signing_id = s.id) < ? ORDER BY s.rowid",
        [sqlight.int(list.length(milestones))],
        signing_row.decoder(),
      )
    })
    |> ignore_value,
  )
  list.each(missing, fn(s) {
    store.unit(ctx.store, fn(tx) {
      use have <- result.try(store.query(
        store.reading(tx),
        "SELECT "
          <> row.columns
          <> " FROM follow_ups WHERE signing_id = ? ORDER BY rowid",
        [id.signing_sql(s.id)],
        row.decoder(),
      ))
      list.try_each(milestones, fn(m) {
        let #(milestone, days) = m
        case list.any(have, fn(f) { f.milestone == milestone }) {
          True -> Ok(Nil)
          False -> {
            use fid <- result.try(id.next_follow_up(tx))
            row.insert(
              tx,
              row.Row(
                id: fid,
                signing_id: s.id,
                player_id: s.player_id,
                org_id: s.org_id,
                milestone:,
                due_at: option.unwrap(s.signed_at, s.ts) + days * day_ms,
                status: row.Scheduled,
                notified_at: None,
                created_at: now,
              ),
            )
          }
        }
      })
    })
    |> ignore
  })
  Ok(Nil)
}

fn ignore_value(r: Result(a, b)) -> Result(a, Nil) {
  result.replace_error(r, Nil)
}

fn mark_due(ctx: Ctx, now: Int) -> Result(Nil, Nil) {
  store.unit(ctx.store, fn(tx) {
    store.run(
      tx,
      "UPDATE follow_ups SET status = 'due' WHERE status = 'scheduled' AND due_at <= ?",
      [sqlight.int(now)],
    )
  })
  |> ignore
}

fn notify_due(ctx: Ctx, now: Int) -> Result(Nil, Nil) {
  use due <- result.try(
    store.read(ctx.store, fn(read) {
      store.query(
        read,
        "SELECT "
          <> row.columns
          <> " FROM follow_ups WHERE status = 'due' AND notified_at IS NULL ORDER BY due_at, id",
        [],
        row.decoder(),
      )
    })
    |> ignore_value,
  )
  list.each(due, fn(f) {
    store.unit(ctx.store, fn(tx) {
      // The marker and the notices commit together: a restart can't send them twice.
      use marked <- result.try(store.write(
        tx,
        "UPDATE follow_ups SET notified_at = ? WHERE id = ? AND status = 'due' AND notified_at IS NULL RETURNING id",
        [sqlight.int(now), id.follow_up_sql(f.id)],
        decode.at([0], decode.string),
      ))
      case marked {
        [] -> Ok(Nil)
        _ -> notify_one(tx, f, now)
      }
    })
    |> ignore
  })
  Ok(Nil)
}

fn notify_one(tx: Tx, f: row.Row, now: Int) -> Result(Nil, Fail(e)) {
  let read = store.reading(tx)
  let milestone = row.milestone_to_string(f.milestone)
  use org <- result.try(orgs.by_id(read, f.org_id))
  use name <- result.try(player_name(read, f.player_id))
  use lead <- result.try(staff.first_active(read, f.org_id))
  let org_name = case org {
    Some(o) -> o.name
    None -> "undefined"
  }
  use _ <- result.try(case lead {
    Some(lead) ->
      notifications.notify(
        tx,
        to: audience.OrgUser,
        id: id.org_user_to_string(lead.id),
        type_: "outcome",
        text: "⏰ "
          <> milestone
          <> " follow-up due for "
          <> option.unwrap(name, "a signed player")
          <> " — file the outcome report.",
        ref_id: Some(id.follow_up_to_string(f.id)),
        at: now,
      )
    None -> Ok(Nil)
  })
  notify_family(
    tx,
    f.player_id,
    "outcome",
    "How is it going at "
      <> org_name
      <> "? Your "
      <> milestone
      <> " check-in is due.",
    fn(child) {
      "How is "
      <> child
      <> " getting on at "
      <> org_name
      <> "? A "
      <> milestone
      <> " check-in is due — you can confirm or dispute the club's report."
    },
    f.id,
    now,
  )
}
