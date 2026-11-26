//// A club's own verification submissions (domains/verification/clubChecks.mjs): control of its company mailbox,
//// or the federation route for a Grassroots club on free e-mail. Either is one of the safeguarding requirements
//// before a club can see under-18 players; the decision is Trust & Safety's.

import gleam/bool
import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/regexp
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/development/grassroots_club
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/orgs
import scoutbox/platform/clock
import scoutbox/platform/effect.{SendMail}
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/limits
import scoutbox/platform/live_event
import scoutbox/platform/live_pings
import scoutbox/platform/secrets
import scoutbox/platform/store
import scoutbox/rows/email_challenges as challenge_row
import scoutbox/rows/id
import scoutbox/rows/org_federation_checks as federation_row
import sqlight
import wisp.{type Request, type Response}

const email_max = 254

const federation_max = 120

const registration_id_max = 60

const contact_email_max = 120

const email_shape = "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$"

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

/// `POST /org/verification/email/confirm`. Only a wrong code is charged against the budget, and the budget is
/// tested before the code is judged, so a correct guess after it is gone is refused rather than rewarded. Run
/// through `http.rerun_on_stale`: a challenge another request used first is judged again on the rerun.
pub fn confirm_email_challenge(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
) -> Response {
  let shape = {
    use code <- input.field("code", input.nullish(input.text(64)))
    input.done(code)
  }
  use code <- http.body(req, shape, [])
  let hash = secrets.code_hash(option.unwrap(code, ""))
  let now = clock.now_ms()
  let org = a.org.id
  let owner = id.org_to_string(org)
  use <- bool.guard(
    limits.spent(ctx.limits, limits.EmailChallengeConfirm, owner, now),
    http.json(429, limits.limited_json(limits.EmailChallengeConfirm)),
  )
  let charge = fn() {
    case http.rerun(req) {
      True -> Nil
      False -> {
        let _ =
          limits.limited(ctx.limits, limits.EmailChallengeConfirm, owner, now)
        Nil
      }
    }
  }
  let found =
    store.read(ctx.store, fn(read) {
      store.one(
        read,
        "SELECT "
          <> challenge_row.columns
          <> " FROM email_challenges WHERE org_id = ? AND expires_at > ? AND attempts < ?",
        [id.org_sql(org), sqlight.int(now), sqlight.int(challenge_max_attempts)],
        challenge_row.decoder(),
      )
    })
  case found {
    Error(failure) -> http.internal(failure)
    Ok(Error(Nil)) -> {
      charge()
      http.error_message(
        404,
        "CHALLENGE_NOT_FOUND",
        "Request a fresh code — none is active for this club.",
      )
    }
    Ok(Ok(challenge)) ->
      case secrets.equal(hash, challenge.code_hash) {
        False -> {
          charge()
          wrong_code(ctx, org, now)
        }
        True -> confirm(ctx, org, hash, now)
      }
  }
}

/// A wrong code counts against the live challenge; the one that reaches the limit cancels it.
fn wrong_code(ctx: Ctx, org: id.OrgId, now: Int) -> Response {
  let counted =
    store.unit(ctx.store, fn(tx) {
      use attempts <- result.try(store.write(
        tx,
        "UPDATE email_challenges SET attempts = attempts + 1 WHERE org_id = ? AND expires_at > ? AND attempts < ? RETURNING attempts",
        [id.org_sql(org), sqlight.int(now), sqlight.int(challenge_max_attempts)],
        decode.at([0], decode.int),
      ))
      case attempts {
        [n, ..] if n >= challenge_max_attempts -> {
          use _ <- result.map(
            store.run(tx, "DELETE FROM email_challenges WHERE org_id = ?", [
              id.org_sql(org),
            ]),
          )
          #(0, True)
        }
        [n, ..] -> Ok(#(challenge_max_attempts - n, False))
        [] -> Ok(#(0, False))
      }
    })
  case counted {
    Ok(#(remaining, invalidated)) ->
      http.json(
        400,
        json.object([
          #("error", json.string("CODE_INVALID")),
          #(
            "message",
            json.string(case invalidated {
              True ->
                "That code doesn't match, and this challenge is now cancelled after too many wrong codes — request a fresh one."
              False -> "That code doesn't match — check the email."
            }),
          ),
          #("attemptsRemaining", json.int(remaining)),
        ]),
      )
    Error(failure) -> http.internal(failure)
  }
}

/// The challenge goes in the unit that verifies the domain, so a failure anywhere keeps it live for the retry.
fn confirm(ctx: Ctx, org: id.OrgId, hash: String, now: Int) -> Response {
  let confirmed =
    store.unit(ctx.store, fn(tx) {
      use consumed <- result.try(store.write(
        tx,
        "DELETE FROM email_challenges WHERE org_id = ? AND code_hash = ? AND expires_at > ? AND attempts < ? RETURNING email",
        [
          id.org_sql(org),
          sqlight.text(hash),
          sqlight.int(now),
          sqlight.int(challenge_max_attempts),
        ],
        decode.at([0], decode.string),
      ))
      case consumed {
        [] -> store.stale("email challenge")
        [email, ..] -> {
          use _ <- result.try(store.seam(
            tx,
            "email_challenge.confirm.after_consume",
          ))
          let domain =
            string.split(email, "@")
            |> list.drop(1)
            |> list.first
            |> result.unwrap("")
          live_pings.catalogue(tx, live_event.Orgs)
          use _ <- result.map(orgs.verify_email_domain(tx, org, domain))
          domain
        }
      }
    })
  case confirmed {
    Ok(domain) ->
      http.json(
        200,
        json.object([
          #("emailDomainVerified", json.bool(True)),
          #("emailDomain", json.string(domain)),
        ]),
      )
    Error(store.Lost(what)) -> http.stale(what)
    Error(failure) -> http.internal(failure)
  }
}

type Federation {
  Federation(
    federation: Option(String),
    registration_id: Option(String),
    contact_email: Option(String),
  )
}

/// `POST /org/verification/federation`: the club's federation registration, for Trust & Safety to cross-check.
/// A resubmission replaces it.
pub fn submit_federation(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use <- grassroots_club.grassroots_only(a)
  let shape = {
    use federation <- input.field(
      "federation",
      input.nullish(input.text(federation_max)),
    )
    use registration_id <- input.field(
      "registrationId",
      input.nullish(input.text(registration_id_max)),
    )
    use contact_email <- input.field(
      "contactEmail",
      input.nullish(input.text(contact_email_max)),
    )
    input.done(Federation(federation:, registration_id:, contact_email:))
  }
  use body <- http.body(req, shape, [])
  let assert Ok(shape) = regexp.from_string(email_shape)
  case input.filled(body.federation), input.filled(body.registration_id) {
    Some(federation), Some(registration_id) -> {
      let email = input.filled(body.contact_email)
      case email {
        Some(e) ->
          case regexp.check(shape, e) {
            True -> file_federation(ctx, a, federation, registration_id, email)
            False ->
              http.json(
                400,
                json.object([
                  #("error", json.string("FIELD_INVALID")),
                  #("field", json.string("contactEmail")),
                  #("problem", json.string("invalid")),
                  #(
                    "message",
                    json.string("contactEmail is an e-mail address."),
                  ),
                ]),
              )
          }
        None -> file_federation(ctx, a, federation, registration_id, None)
      }
    }
    federation, _ ->
      http.json(
        400,
        json.object([
          #("error", json.string("FEDERATION_REQUIRED")),
          #(
            "field",
            json.string(case federation {
              Some(_) -> "registrationId"
              None -> "federation"
            }),
          ),
          #("problem", json.string("required")),
        ]),
      )
  }
}

fn file_federation(
  ctx: Ctx,
  a: OrgAccess,
  federation: String,
  registration_id: String,
  contact_email: Option(String),
) -> Response {
  let check =
    federation_row.Row(
      org_id: a.org.id,
      federation:,
      registration_id:,
      contact_email:,
      status: federation_row.Pending,
      submitted_at: clock.now_ms(),
    )
  let filed =
    store.unit(ctx.store, fn(tx) {
      live_pings.catalogue(tx, live_event.Orgs)
      orgs.submit_federation_check(tx, check)
    })
  case filed {
    Ok(_) ->
      http.json(
        201,
        json.object([
          #("submitted", json.bool(True)),
          #(
            "note",
            json.string(
              "Trust & Safety cross-checks the registration with your federation. Verification (and with the safeguarding contract, U18 visibility) follows their approval.",
            ),
          ),
        ]),
      )
    Error(failure) -> http.internal(failure)
  }
}
