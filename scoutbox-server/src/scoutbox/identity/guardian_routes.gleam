//// A guardian's account: sign-in, their record, their children and the log of everything about them.

import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/development/record_routes as record
import scoutbox/discovery/insights
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/idv
import scoutbox/identity/pairing
import scoutbox/identity/passwords
import scoutbox/identity/players
import scoutbox/identity/sessions
import scoutbox/identity/sign_in
import scoutbox/platform/clock
import scoutbox/platform/effect.{SendMail}
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/limits
import scoutbox/platform/pages
import scoutbox/platform/paging.{IntKind}
import scoutbox/platform/secrets
import scoutbox/platform/store
import scoutbox/recruitment/requests
import scoutbox/rows/id
import scoutbox/rules/journey
import scoutbox/safety/ledger
import wisp.{type Request, type Response}

const password_min = 8

type Signup {
  Signup(name: Option(String), email: Option(String), password: Option(String))
}

/// `POST /auth/guardian/signup`. The account and its first session commit together; the verification code is
/// mailed after COMMIT.
pub fn signup(ctx: Ctx, req: Request) -> Response {
  let shape = {
    use name <- input.field("name", input.nullish(input.text(120)))
    use email <- input.field("email", input.nullish(input.text(254)))
    use password <- input.field("password", input.nullish(input.text(256)))
    input.done(Signup(name:, email:, password:))
  }
  use body <- http.body(req, shape, [])
  let email_in_use = fn() {
    http.error_message(
      409,
      "EMAIL_IN_USE",
      "A guardian account with this email already exists — log in instead.",
    )
  }
  let named = case input.filled(body.name), input.filled(body.email) {
    Some(name), Some(email) ->
      case string.contains(email, "@") {
        True -> Ok(#(name, email))
        False -> Error(Nil)
      }
    _, _ -> Error(Nil)
  }
  case named, body.password {
    Error(Nil), _ -> http.error(400, "NAME_AND_EMAIL_REQUIRED")
    Ok(_), None -> password_required()
    Ok(#(name, email)), Some(p) ->
      case input.utf16_length(p) < password_min {
        True -> password_required()
        False -> {
          case store.read(ctx.store, guardians.by_email(_, email)) {
            Error(failure) -> http.internal(failure)
            Ok(Some(_)) -> email_in_use()
            Ok(None) -> {
              // Before the unit: a hash takes about half a second, and the unit holds the only writer.
              let password_hash = passwords.hash(p)
              let code = secrets.random_code(6)
              let now = clock.now_ms()
              let created =
                store.unit(ctx.store, fn(tx) {
                  use id <- result.try(id.next_guardian(tx))
                  use g <- result.try(guardians.create(
                    tx,
                    id:,
                    name:,
                    email:,
                    password_hash:,
                    email_code_hash: secrets.code_hash(code),
                    at: now,
                  ))
                  use token <- result.map(sessions.create(
                    tx,
                    sessions.Guardian(g.row.id),
                    now,
                    ctx.config.session_ttl_ms,
                  ))
                  store.emit(
                    tx,
                    SendMail(
                      to: email,
                      subject: "Verify your ScoutBox guardian account",
                      text: "Hi "
                        <> name
                        <> ",\n\nYour ScoutBox verification code is "
                        <> code
                        <> ".\n\nGuardian accounts own every under-18 profile on ScoutBox — verifying your email is the first of the safeguarding gates (email → ID → disclaimer) before any child profile can exist.",
                      secrets: [],
                    ),
                  )
                  #(g, token)
                })
              case created {
                Ok(#(g, token)) ->
                  http.json(
                    201,
                    json.object([
                      #("guardianId", id.guardian_json(g.row.id)),
                      #("guardian", guardians.self_view(g)),
                      #("token", json.string(token)),
                      #("emailVerificationSent", json.bool(True)),
                      // Mail only ever reaches the local outbox here, which has no real inbox, so the code is
                      // returned to let the flow complete (the TypeScript server's dev transport).
                      #("devEmailCode", json.string(code)),
                    ]),
                  )
                Error(store.Refused(guardians.EmailInUse)) -> email_in_use()
                Error(failure) -> http.internal(failure)
              }
            }
          }
        }
      }
  }
}

fn password_required() -> Response {
  http.error_message(
    400,
    "PASSWORD_REQUIRED",
    "Pick a password of at least 8 characters.",
  )
}

type Login {
  Login(
    guardian_id: Option(String),
    email: Option(String),
    password: Option(String),
  )
}

/// `POST /auth/guardian/login`, by id or by e-mail. The failed-login budget is charged against both the
/// identifier tried and the account it resolved to, or alternating the two would give a guesser two budgets.
pub fn login(ctx: Ctx, req: Request) -> Response {
  let shape = {
    use guardian_id <- input.field("guardianId", input.nullish(input.text(80)))
    use email <- input.field("email", input.nullish(input.text(254)))
    use password <- input.field("password", input.nullish(input.text(256)))
    input.done(Login(guardian_id:, email:, password:))
  }
  use body <- http.body(req, shape, [])
  let now = clock.now_ms()
  let tried =
    "guardian:"
    <> case body.guardian_id, body.email {
      Some(id), _ -> id
      None, Some(email) -> email
      None, None -> "undefined"
    }
  case limits.login_locked(ctx.limits, tried, now) {
    True -> sign_in.locked_out()
    False -> {
      let found =
        store.read(ctx.store, fn(read) {
          use by_id <- result.try(case body.guardian_id {
            // From the request body.
            Some(guardian_id) -> guardians.by_id(read, id.guardian(guardian_id))
            None -> Ok(None)
          })
          case by_id, body.email {
            Some(g), _ -> Ok(Some(g))
            None, Some(email) -> guardians.by_email(read, email)
            None, None -> Ok(None)
          }
        })
      case found {
        Error(failure) -> http.internal(failure)
        Ok(None) -> {
          limits.login_failed(ctx.limits, tried, now)
          http.error(404, "GUARDIAN_NOT_FOUND")
        }
        Ok(Some(g)) -> {
          let canonical = "guardian:" <> id.guardian_to_string(g.row.id)
          let aliased = limits.login_key(canonical) != limits.login_key(tried)
          case aliased && limits.login_locked(ctx.limits, canonical, now) {
            True -> sign_in.locked_out()
            False ->
              signing_in(ctx, g, option.unwrap(body.password, ""), now, fn() {
                limits.login_failed(ctx.limits, tried, now)
                case aliased {
                  True -> limits.login_failed(ctx.limits, canonical, now)
                  False -> Nil
                }
              })
          }
        }
      }
    }
  }
}

/// The password is checked before the unit: scrypt is slow, and a unit holds the only writer.
fn signing_in(
  ctx: Ctx,
  g: Guardian,
  password: String,
  now: Int,
  failed: fn() -> Nil,
) -> Response {
  let checked = case g.row.password_hash {
    Some(stored) -> Some(passwords.verify(password, stored))
    None -> None
  }
  case checked, ctx.config.dev_logins {
    Some(False), _ -> {
      failed()
      http.error_message(
        401,
        "BAD_PASSWORD",
        "This account is password-protected.",
      )
    }
    None, False ->
      http.error_message(
        403,
        "DEV_LOGIN_DISABLED",
        "Passwordless demo logins are disabled outside development. Use a credentialed account.",
      )
    Some(True), _ | None, True -> {
      let minted =
        store.unit(ctx.store, fn(tx) {
          sessions.create(
            tx,
            sessions.Guardian(g.row.id),
            now,
            ctx.config.session_ttl_ms,
          )
        })
      case minted {
        Ok(token) ->
          http.json(
            200,
            json.object([
              #("guardianId", id.guardian_json(g.row.id)),
              #("guardian", guardians.self_view(g)),
              #("token", json.string(token)),
            ]),
          )
        Error(failure) -> http.internal(failure)
      }
    }
  }
}

/// `GET /guardian/me`.
pub fn me(g: Guardian) -> Response {
  http.json(200, guardians.self_view(g))
}

/// `GET /guardian/children`.
pub fn children(ctx: Ctx, g: Guardian) -> Response {
  let now = clock.now_ms()
  case store.read(ctx.store, players.by_ids(_, g.child_ids)) {
    Ok(kids) ->
      http.json(200, json.array(kids, players.guardian_child_view(_, now)))
    Error(failure) -> http.internal(failure)
  }
}

/// `GET /guardian/digest`: each child's week. Like TypeScript's, it reads the wall clock, not a test clock.
pub fn digest(ctx: Ctx, g: Guardian) -> Response {
  let now = clock.now_ms()
  let week = now - 7 * 24 * 3600 * 1000
  let found =
    store.read(ctx.store, fn(read) {
      use kids <- result.try(players.by_ids(read, g.child_ids))
      list.try_map(kids, fn(c) {
        let pid = c.row.id
        use #(views, shortlists) <- result.try(insights.this_week(
          read,
          pid,
          now,
        ))
        use reqs <- result.map(requests.for_player(read, pid))
        json.object([
          #("id", id.player_json(pid)),
          #("name", json.string(c.row.name)),
          #("views", json.int(views)),
          #("shortlists", json.int(shortlists)),
          #("streak", json.int(journey.streak(c.activity_log, now))),
          #("weeklyGoal", journey.weekly_goal(c.activity_log, now)),
          #(
            "newRequests",
            json.int(list.count(reqs, fn(r) { r.created_at >= week })),
          ),
          #(
            "activityThisWeek",
            json.int(list.count(c.activity_log, fn(ts) { ts >= week })),
          ),
        ])
      })
    })
  case found {
    Ok(children) ->
      http.json(
        200,
        json.object([
          #("generatedAt", json.string(clock.iso(now))),
          #("children", json.preprocessed_array(children)),
          #(
            "note",
            json.string(
              "Only verified clubs can see your children, and every action above is on the ledger.",
            ),
          ),
        ]),
      )
    Error(failure) -> http.internal(failure)
  }
}

/// `GET /guardian/log`: every communication about the children is on the ledger, and the guardian reads all of it.
pub fn log(ctx: Ctx, req: Request, g: Guardian) -> Response {
  use page <- pages.strict(req, [IntKind])
  case store.read(ctx.store, ledger.page_for_players(_, g.child_ids, page)) {
    Ok(#(items, next)) -> pages.respond(items, next, ledger.view)
    Error(failure) -> http.internal(failure)
  }
}

type CoGuardian {
  CoGuardian(name: Option(String), email: Option(String))
}

/// `POST /guardian/coguardian`: created with its links to the children in one unit. The co-guardian passes the
/// gates (ID check, disclaimer) themselves before they can act.
pub fn add_co_guardian(ctx: Ctx, req: Request, g: Guardian) -> Response {
  let shape = {
    use name <- input.field("name", input.nullish(input.text(120)))
    use email <- input.field("email", input.nullish(input.text(254)))
    input.done(CoGuardian(name:, email:))
  }
  use body <- http.body(req, shape, [])
  case input.filled(body.name), input.filled(body.email) {
    Some(name), Some(email) ->
      case string.contains(email, "@") {
        False ->
          http.json(
            400,
            json.object([
              #("error", json.string("FIELD_INVALID")),
              #("field", json.string("email")),
              #("problem", json.string("invalid")),
              #("message", json.string("email must be an e-mail address.")),
            ]),
          )
        True -> {
          let now = clock.now_ms()
          let created =
            store.unit(ctx.store, fn(tx) {
              use id <- result.try(id.next_guardian(tx))
              guardians.create_co_guardian(
                tx,
                id:,
                primary: g,
                name:,
                email:,
                at: now,
              )
            })
          case created {
            Ok(co) ->
              http.json(
                201,
                json.object([
                  #("guardianId", id.guardian_json(co.row.id)),
                  #(
                    "note",
                    json.string(
                      "The co-guardian must verify their ID and accept the disclaimer before they can act.",
                    ),
                  ),
                ]),
              )
            Error(store.Refused(guardians.EmailInUse)) ->
              http.error_message(
                409,
                "EMAIL_IN_USE",
                "A guardian account with this email already exists.",
              )
            Error(failure) -> http.internal(failure)
          }
        }
      }
    _, _ -> http.error(400, "NAME_AND_EMAIL_REQUIRED")
  }
}

/// `GET /admin/guardians`, oldest first, with the ID-check queue. An allowlist: never a hash.
pub fn admin_list(ctx: Ctx, req: Request) -> Response {
  use page <- pages.strict(req, [IntKind])
  let found =
    store.read(ctx.store, fn(read) {
      use #(items, next) <- result.try(guardians.page(read, page))
      use queue <- result.map(guardians.idv_queue(read))
      json.object([
        #("guardians", json.array(items, guardians.admin_view)),
        #("nextCursor", json.nullable(next, json.string)),
        #("idvQueue", json.array(queue, guardians.idv_view)),
      ])
    })
  case found {
    Ok(body) -> http.json(200, body)
    Error(failure) -> http.internal(failure)
  }
}

/// `POST /admin/guardians/:id/idv`.
pub fn review_id(ctx: Ctx, req: Request, id: id.GuardianId) -> Response {
  case store.read(ctx.store, guardians.by_id(_, id)) {
    Error(failure) -> http.internal(failure)
    Ok(None) -> http.error(404, "GUARDIAN_NOT_FOUND")
    Ok(Some(_)) -> {
      let shape = {
        use approved <- input.field("approved", input.required(input.boolean()))
        input.done(approved)
      }
      use approved <- http.body(req, shape, [])
      let reviewed =
        store.unit(ctx.store, fn(tx) {
          guardians.review_id_check(tx, id, approved)
        })
      case reviewed {
        Ok(g) -> http.json(200, guardians.admin_view(g))
        Error(failure) -> http.internal(failure)
      }
    }
  }
}

/// `POST /auth/guardian/verify-email`. A verified address stays verified, whatever code comes after.
pub fn verify_email(ctx: Ctx, req: Request) -> Response {
  let shape = {
    use guardian_id <- input.field("guardianId", input.nullish(input.text(80)))
    use code <- input.field("code", input.nullish(input.text(64)))
    input.done(#(guardian_id, code))
  }
  use #(guardian_id, code) <- http.body(req, shape, [])
  let found = case guardian_id {
    // From the request body.
    Some(guardian_id) ->
      store.read(ctx.store, guardians.by_id(_, id.guardian(guardian_id)))
    None -> Ok(None)
  }
  let verified = json.object([#("emailVerified", json.bool(True))])
  case found {
    Error(failure) -> http.internal(failure)
    Ok(None) -> http.error(404, "GUARDIAN_NOT_FOUND")
    Ok(Some(g)) if g.row.email_verified -> http.json(200, verified)
    Ok(Some(g)) -> {
      let matches = case code, g.row.email_code_hash {
        Some(code), Some(stored) ->
          secrets.equal(secrets.code_hash(code), stored)
        _, _ -> False
      }
      case matches {
        False ->
          http.error_message(
            400,
            "CODE_INVALID",
            "That code doesn't match — check the email we sent you.",
          )
        True ->
          case store.unit(ctx.store, guardians.verify_email(_, g.row.id)) {
            Ok(Nil) -> http.json(200, verified)
            Error(failure) -> http.internal(failure)
          }
      }
    }
  }
}

/// `POST /guardian/verify-id`. The provider answers before the unit: a unit never waits on one.
pub fn verify_id(ctx: Ctx, req: Request, g: Guardian) -> Response {
  let shape = {
    use document_type <- input.field(
      "documentType",
      input.nullish(input.text(60)),
    )
    use document_ref <- input.field(
      "documentRef",
      input.nullish(input.text(120)),
    )
    input.done(#(document_type, document_ref))
  }
  use #(document_type, document_ref) <- http.body(req, shape, [])
  case input.filled(document_type), input.filled(document_ref) {
    Some(document_type), Some(document_ref) -> {
      let attestation = idv.verify(document_ref)
      let recorded =
        store.unit(ctx.store, fn(tx) {
          guardians.record_id_check(
            tx,
            g,
            document_type,
            attestation,
            clock.now_ms(),
          )
        })
      case recorded {
        Ok(Nil) ->
          http.json(
            200,
            json.object([
              #("idVerified", json.bool(True)),
              #("reference", json.string(attestation.reference)),
            ]),
          )
        Error(failure) -> http.internal(failure)
      }
    }
    _, _ ->
      http.error_message(
        400,
        "DOCUMENT_REQUIRED",
        "ID verification needs a document type and reference.",
      )
  }
}

/// `POST /guardian/disclaimer`. Accepting again keeps the first acceptance's time.
pub fn disclaimer(ctx: Ctx, req: Request, g: Guardian) -> Response {
  let shape = {
    use accepted <- input.field("accepted", input.optional(input.boolean()))
    input.done(accepted)
  }
  use accepted <- http.body(req, shape, [
    #("accepted", "DISCLAIMER_NOT_ACCEPTED"),
  ])
  case accepted {
    Some(True) ->
      case
        store.unit(ctx.store, guardians.accept_disclaimer(
          _,
          g.row.id,
          clock.now_ms(),
        ))
      {
        Ok(Nil) ->
          http.json(
            200,
            json.object([#("disclaimerAccepted", json.bool(True))]),
          )
        Error(failure) -> http.internal(failure)
      }
    _ -> http.error(400, "DISCLAIMER_NOT_ACCEPTED")
  }
}

/// `POST /guardian/children/:id/pairing-code`: one live code per child, for 15 minutes. The plain code exists in
/// this response only.
pub fn pairing_code(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  child_id: id.PlayerId,
) -> Response {
  use child <- record.own_child(ctx, g, child_id)
  use _ <- http.body(req, input.nothing(), [])
  let now = clock.now_ms()
  let owner = id.guardian_to_string(g.row.id)
  case limits.limited(ctx.limits, limits.PairingCodeMint, owner, now) {
    True -> http.json(429, limits.limited_json(limits.PairingCodeMint))
    False ->
      case store.unit(ctx.store, pairing.issue(_, child.row.id, now)) {
        Ok(issued) ->
          http.json(
            201,
            json.object([
              #("code", json.string(issued.code)),
              #("expiresAt", json.int(issued.expires_at)),
            ]),
          )
        Error(failure) -> http.internal(failure)
      }
  }
}
