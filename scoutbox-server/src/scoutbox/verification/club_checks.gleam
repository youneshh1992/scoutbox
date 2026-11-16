//// A club proves control of its company mailbox (domains/verification/clubChecks.mjs): one of the safeguarding
//// requirements before a club can see under-18 players. A code goes to the mailbox; the club enters it.
////
//// Not ported yet: confirming the code (`/org/verification/email/confirm`) and the federation check.

import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleam/regexp
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/platform/clock
import scoutbox/platform/effect.{SendMail}
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/limits
import scoutbox/platform/secrets
import scoutbox/platform/store
import scoutbox/rows/email_challenges as challenge_row
import scoutbox/rows/id
import sqlight
import wisp.{type Request, type Response}

const email_max = 254

const challenge_ttl_ms = 1_800_000

/// Wrong confirmations a challenge survives; the one that reaches this count invalidates it.
const challenge_max_attempts = 10

/// Free mail providers don't prove domain control.
const free_mail =
  "@(gmail|googlemail|hotmail|outlook|yahoo|icloud|aol|proton|protonmail|gmx|live|msn)\\."

/// `POST /org/verification/email`: sends a code to a company mailbox. A new request replaces the club's live
/// challenge.
pub fn request_email_challenge(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
) -> Response {
  let shape = {
    use email <- input.field("email", input.nullish(input.text(email_max)))
    input.done(email)
  }
  use email <- http.body(req, shape, [#("email", "EMAIL_REQUIRED")])
  let email = input.filled(email)
  let now = clock.now_ms()
  let assert Ok(free) =
    regexp.compile(
      free_mail,
      regexp.Options(case_insensitive: True, multi_line: False),
    )
  let address = case email {
    Some(email) ->
      case string.contains(email, "@") {
        True -> Ok(email)
        False -> Error("invalid")
      }
    None -> Error("required")
  }
  case address {
    Error(problem) -> email_required(problem)
    Ok(email) ->
      case regexp.check(free, email) {
        True ->
          http.error_message(
            422,
            "COMPANY_EMAIL_REQUIRED",
            "Free email providers don't prove domain control. No club domain? Use federation verification instead — your federation registration is checked by Trust & Safety.",
          )
        False ->
          case
            limits.limited(
              ctx.limits,
              limits.EmailChallengeRequest,
              id.org_to_string(a.org.id),
              now,
            )
          {
            True ->
              http.json(
                429,
                json.object(
                  list.map(
                    limits.limited_body(limits.EmailChallengeRequest),
                    fn(f) { #(f.0, json.string(f.1)) },
                  ),
                ),
              )
            False -> issue(ctx, a, email, now)
          }
      }
  }
}

fn email_required(problem: String) -> Response {
  http.json(
    400,
    json.object([
      #("error", json.string("EMAIL_REQUIRED")),
      #("field", json.string("email")),
      #("problem", json.string(problem)),
    ]),
  )
}

/// The challenge row is durable before the mail is sent, and the code is a secret of the mail, so the persisted
/// outbox record withholds it. A mail that fails to send leaves the row to expire or be replaced.
fn issue(ctx: Ctx, a: OrgAccess, email: String, now: Int) -> Response {
  let code = secrets.random_code(6)
  let issued =
    store.unit(ctx.store, fn(tx) {
      use _ <- result.try(
        store.run(
          tx,
          "DELETE FROM email_challenges WHERE expires_at <= ? OR attempts >= ?",
          [sqlight.int(now), sqlight.int(challenge_max_attempts)],
        ),
      )
      use _ <- result.try(
        store.run(
          tx,
          "INSERT INTO email_challenges ("
            <> challenge_row.columns
            <> ") VALUES (?, ?, ?, ?, 0) ON CONFLICT(org_id) DO UPDATE SET email = excluded.email, code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0",
          [
            id.org_sql(a.org.id),
            sqlight.text(email),
            sqlight.text(secrets.code_hash(code)),
            sqlight.int(now + challenge_ttl_ms),
          ],
        ),
      )
      store.emit(
        tx,
        SendMail(
          to: email,
          subject: "Verify " <> a.org.name <> " on ScoutBox",
          text: "Your ScoutBox club verification code is "
            <> code
            <> ".\n\nEntering it confirms "
            <> a.org.name
            <> " controls this company mailbox — one of the safeguarding requirements before a club can see under-18 players.",
          secrets: [code],
        ),
      )
      Ok(Nil)
    })
  case issued {
    Ok(Nil) ->
      http.json(
        201,
        json.object([
          #("sent", json.bool(True)),
          #(
            "note",
            json.string(
              "Enter the code from the mailbox to confirm domain control.",
            ),
          ),
        ]),
      )
    Error(failure) -> http.internal(failure)
  }
}
