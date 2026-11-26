//// Coach references (domains/development/grassroots.mjs, `vouches`). The coach proves control of the mailbox with
//// a one-time code, stored only as its hash; the reference text is moderated when it is submitted. Trust &
//// Safety withdraws a reference from every profile view (domains/scouting/passport.mjs); the record stays.

import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/regexp
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/development/record_routes
import scoutbox/identity/access.{type PlayerAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/players.{type Player}
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/effect
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/live_pings
import scoutbox/platform/pages
import scoutbox/platform/paging
import scoutbox/platform/secrets
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/rows/id
import scoutbox/rows/vouches as row
import scoutbox/safety/audit
import scoutbox/safety/moderate
import scoutbox/scouting/coaches
import scoutbox/verification/vouch_view
import scoutbox/vocab/audience
import scoutbox/vocab/playing_level
import sqlight
import wisp.{type Request, type Response}

const coach_name_max = 100

const coach_email_max = 254

const role_max = 200

const text_max = 400

const seasons_max = 40

const conflict_max = 200

const code_max = 64

const name_max = 200

const withdrawal_reason_max = 200

pub fn by_id(
  read: Read,
  vouch_id: id.VouchId,
) -> Result(Option(row.Row), Fail(e)) {
  store.one(
    read,
    "SELECT " <> row.columns <> " FROM vouches WHERE id = ?",
    [id.vouch_sql(vouch_id)],
    row.decoder(),
  )
  |> result.map(option.from_result)
}

type VouchRequest {
  VouchRequest(
    coach_name: Option(String),
    coach_email: Option(String),
    role: Option(String),
  )
}

/// `POST /player/vouches/request`.
pub fn player_request(ctx: Ctx, req: Request, p: PlayerAccess) -> Response {
  case p.player.row.level {
    playing_level.Pro ->
      http.error_message(
        403,
        "GRASSROOTS_ONLY",
        "This is part of the Grassroots journey — pro-level players have moved past it.",
      )
    _ -> {
      use <- access.guardian_managed_only(p)
      request(ctx, req, p.player)
    }
  }
}

/// `POST /guardian/children/:id/vouches/request`.
pub fn guardian_request(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  child_id: id.PlayerId,
) -> Response {
  use child <- record_routes.own_child(ctx, g, child_id)
  case child.row.level {
    playing_level.Pro -> http.error(403, "GRASSROOTS_ONLY")
    _ -> request(ctx, req, child)
  }
}

fn request(ctx: Ctx, req: Request, p: Player) -> Response {
  let shape = {
    use coach_name <- input.field(
      "coachName",
      input.nullish(input.text(coach_name_max)),
    )
    use coach_email <- input.field(
      "coachEmail",
      input.nullish(input.text(coach_email_max)),
    )
    use role <- input.field("role", input.nullish(input.text(role_max)))
    input.done(VouchRequest(coach_name:, coach_email:, role:))
  }
  use body <- http.body(req, shape, [])
  let name = string.trim(option.unwrap(body.coach_name, ""))
  let email = string.trim(option.unwrap(body.coach_email, ""))
  let assert Ok(mailbox) = regexp.from_string("^[^\\s@]+@[^\\s@]+$")
  case name == "" || email == "" || !regexp.check(mailbox, email) {
    True ->
      http.error_message(
        400,
        "COACH_DETAILS_REQUIRED",
        "Name the coach and their email address.",
      )
    False -> {
      let code = secrets.random_code(8)
      let now = clock.now_ms()
      let role = case string.trim(option.unwrap(body.role, "")) {
        "" -> "Coach"
        role -> role
      }
      let player_name = p.row.name
      // The code is the coach's credential, so the mail carries it: the dev transport keeps the mail as sent.
      let saved =
        store.unit(ctx.store, fn(tx) {
          use vouch_id <- result.try(id.next_vouch(tx))
          use _ <- result.try(row.insert(
            tx,
            row.Row(
              id: vouch_id,
              player_id: p.row.id,
              player_name: Some(input.utf16_take(player_name, name_max)),
              coach_name: name,
              coach_email: Some(email),
              role:,
              status: row.Pending,
              code_hash: Some(secrets.code_hash(code)),
              text: None,
              seasons: None,
              created_at: now,
              published_at: None,
              conflict_of_interest: None,
              withdrawn_at: None,
              withdrawn_by: None,
              withdrawn_reason: None,
            ),
          ))
          // Sent once the request is durable, as every mail is.
          store.emit(
            tx,
            effect.SendMail(
              to: email,
              subject: "Reference request for " <> player_name <> " on ScoutBox",
              text: "Hi "
                <> name
                <> ",\n\n"
                <> player_name
                <> " has asked you for a coach reference on ScoutBox Grassroots.\n\nYour one-time reference code is "
                <> code
                <> ". Submitting with it confirms this mailbox is yours; your name and role will appear with the reference on "
                <> player_name
                <> "'s profile.\n\nReferences are screened by moderation and reviewed by Trust & Safety.",
              secrets: [],
            ),
          )
          Ok(vouch_id)
        })
      case saved {
        Ok(vouch_id) ->
          http.json(
            201,
            json.object([
              #("requested", json.bool(True)),
              #("vouchId", id.vouch_json(vouch_id)),
            ]),
          )
        Error(failure) -> coaches.failed(failure)
      }
    }
  }
}

type Submission {
  Submission(
    code: Option(String),
    text: Option(String),
    seasons: Option(String),
    conflict: Option(String),
  )
}

fn trimmed(s: Option(String)) -> Option(String) {
  case option.map(s, string.trim) {
    Some("") -> None
    other -> other
  }
}

/// `POST /vouch/submit`: the code from the e-mailed request is the coach's only credential.
pub fn submit(ctx: Ctx, req: Request) -> Response {
  use req <- http.rerun_on_stale(req)
  let shape = {
    use code <- input.field("code", input.nullish(input.text(code_max)))
    use text <- input.field("text", input.nullish(input.text(text_max)))
    use seasons <- input.field(
      "seasons",
      input.nullish(input.text(seasons_max)),
    )
    use conflict <- input.field(
      "conflictOfInterest",
      input.nullish(input.text(conflict_max)),
    )
    input.done(Submission(code:, text:, seasons:, conflict:))
  }
  use body <- http.body(req, shape, [])
  let pending = case trimmed(body.code) {
    None -> Ok(None)
    Some(code) ->
      store.read(ctx.store, fn(read) {
        store.one(
          read,
          "SELECT "
            <> row.columns
            <> " FROM vouches WHERE code_hash = ? AND status = 'pending'",
          [sqlight.text(secrets.code_hash(code))],
          row.decoder(),
        )
        |> result.map(option.from_result)
      })
  }
  case pending {
    Error(failure) -> http.internal(failure)
    Ok(None) ->
      http.error_message(
        404,
        "CODE_INVALID",
        "That reference code is wrong or already used.",
      )
    Ok(Some(v)) ->
      case trimmed(body.text) {
        None -> http.error(400, "TEXT_REQUIRED")
        Some(_) -> {
          let assert Some(text) = body.text
          use <- moderate.or_refuse(
            ctx,
            text,
            audit.Context(
              kind: "coach_vouch",
              player_id: Some(v.player_id),
              org_id: None,
              user_id: None,
              channel_id: None,
              request_id: None,
            ),
          )
          publish(ctx, v, string.trim(text), body)
        }
      }
  }
}

fn publish(ctx: Ctx, v: row.Row, text: String, body: Submission) -> Response {
  let now = clock.now_ms()
  // Publishing clears the code (single use); the reference and both notifications commit together. A declared
  // relationship to the player ("my son", "I run their agency") must be visible, not discoverable.
  let saved =
    store.unit(ctx.store, fn(tx) {
      live_pings.player(tx, v.player_id)
      use changed <- result.try(store.write(
        tx,
        "UPDATE vouches SET status = 'published', text = ?, seasons = ?, conflict_of_interest = ?, published_at = ?, code_hash = NULL WHERE id = ? AND status = 'pending' RETURNING id",
        [
          sqlight.text(text),
          sqlight.nullable(sqlight.text, trimmed(body.seasons)),
          sqlight.nullable(sqlight.text, trimmed(body.conflict)),
          sqlight.int(now),
          id.vouch_sql(v.id),
        ],
        decode.at([0], id.vouch_decoder()),
      ))
      case changed {
        [] -> store.stale("coach reference")
        _ -> {
          use p <- result.try(players.by_id(store.reading(tx), v.player_id))
          let ref_id = Some(id.vouch_to_string(v.id))
          use _ <- result.try(notifications.notify(
            tx,
            to: audience.Player,
            id: id.player_to_string(v.player_id),
            type_: "vouch",
            text: "⭐ "
              <> v.coach_name
              <> " published a coach reference on your profile.",
            ref_id:,
            at: now,
          ))
          case p {
            Some(p) ->
              case p.row.guardian_id {
                Some(guardian_id) ->
                  notifications.notify(
                    tx,
                    to: audience.Guardian,
                    id: id.guardian_to_string(guardian_id),
                    type_: "vouch",
                    text: v.coach_name
                      <> " published a coach reference on "
                      <> p.row.name
                      <> "'s profile.",
                    ref_id:,
                    at: now,
                  )
                None -> Ok(Nil)
              }
            None -> Ok(Nil)
          }
        }
      }
    })
  case saved {
    Ok(Nil) -> http.json(201, json.object([#("published", json.bool(True))]))
    Error(failure) -> coaches.failed(failure)
  }
}

/// `POST /admin/vouches/:id/withdraw`: the record is kept for history and leaves every profile view.
pub fn withdraw(ctx: Ctx, req: Request, vouch_id: id.VouchId) -> Response {
  use req <- http.rerun_on_stale(req)
  case store.read(ctx.store, by_id(_, vouch_id)) {
    Error(failure) -> http.internal(failure)
    Ok(None) -> http.error(404, "VOUCH_NOT_FOUND")
    Ok(Some(v)) if v.withdrawn_at != None -> http.error(409, "ALREADY_WITHDRAWN")
    Ok(Some(v)) -> {
      let shape = {
        use reason <- input.field(
          "reason",
          input.nullish(input.text(withdrawal_reason_max)),
        )
        input.done(reason)
      }
      use reason <- http.body(req, shape, [])
      let reason =
        option.unwrap(input.filled(reason), "withdrawn by Trust & Safety")
      let now = clock.now_ms()
      let saved =
        store.unit(ctx.store, fn(tx) {
          use rows <- result.try(store.write(
            tx,
            "UPDATE vouches SET withdrawn_at = ?, withdrawn_by = 'admin', withdrawn_reason = ? WHERE id = ? AND withdrawn_at IS NULL RETURNING id",
            [sqlight.int(now), sqlight.text(reason), id.vouch_sql(v.id)],
            decode.at([0], id.vouch_decoder()),
          ))
          case rows {
            [] -> store.stale("coach reference withdrawal")
            _ -> Ok(live_pings.player(tx, v.player_id))
          }
        })
      case saved {
        Ok(Nil) ->
          http.json(
            200,
            json.object([
              #(
                "withdrawn",
                json.object([
                  #("at", json.int(now)),
                  #("by", json.string("admin")),
                  #("reason", json.string(reason)),
                ]),
              ),
              #(
                "note",
                json.string(
                  "The record is kept for history; it no longer appears on any profile view.",
                ),
              ),
            ]),
          )
        Error(failure) -> coaches.failed(failure)
      }
    }
  }
}

/// `POST /admin/vouches/:id/revoke`: the reference is revoked and its code can never be spent. Unlike a withdrawal it
/// may be repeated, as in TypeScript.
pub fn revoke(ctx: Ctx, req: Request, vouch_id: id.VouchId) -> Response {
  case store.read(ctx.store, by_id(_, vouch_id)) {
    Error(failure) -> http.internal(failure)
    Ok(None) -> http.error(404, "VOUCH_NOT_FOUND")
    Ok(Some(v)) -> {
      use _ <- http.body(req, input.nothing(), [])
      let saved =
        store.unit(ctx.store, fn(tx) {
          use _ <- result.map(
            store.run(
              tx,
              "UPDATE vouches SET status = 'revoked', code_hash = NULL WHERE id = ?",
              [id.vouch_sql(v.id)],
            ),
          )
          live_pings.player(tx, v.player_id)
        })
      case saved {
        Ok(Nil) -> http.json(200, json.object([#("revoked", json.bool(True))]))
        Error(failure) -> coaches.failed(failure)
      }
    }
  }
}

/// `GET /admin/vouches`: every reference, newest first. Trust & Safety sees the coach's e-mail, never the code.
pub fn admin_list(ctx: Ctx, req: Request) -> Response {
  use page <- pages.strict(req, [paging.IntKind])
  let before = case page.after {
    Some([paging.IntKey(rowid)]) -> Some(rowid)
    _ -> None
  }
  let listed =
    store.read(ctx.store, fn(read) {
      store.query(
        read,
        "SELECT "
          <> row.columns
          <> ", rowid FROM vouches WHERE (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?",
        [
          sqlight.nullable(sqlight.int, before),
          sqlight.nullable(sqlight.int, before),
          sqlight.int(page.limit + 1),
        ],
        {
          use v <- decode.then(row.decoder())
          use rowid <- decode.field(row.width, decode.int)
          decode.success(#(v, rowid))
        },
      )
    })
  case listed {
    Error(failure) -> http.internal(failure)
    Ok(rows) -> {
      let #(items, next) =
        paging.page_of(rows, page.limit, fn(r) { [paging.IntKey(r.1)] })
      pages.respond(items, next, fn(r) {
        let v = r.0
        json.object(
          list.append(vouch_view.fields(v), [
            #("coachEmail", json.nullable(v.coach_email, json.string)),
          ]),
        )
      })
    }
  }
}
