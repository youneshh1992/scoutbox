//// A player's own account: sign-up, their record, the timeline and the data export.
////
//// Under-18 profiles are owned by a verified guardian and created from the guardian's account; the sign-up
//// refuses a minor.

import gleam/bool
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type PlayerAccess}
import scoutbox/identity/guardians
import scoutbox/identity/players
import scoutbox/identity/sessions
import scoutbox/identity/sign_in
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/limits
import scoutbox/platform/store
import scoutbox/recruitment/requests
import scoutbox/rows/players as row
import scoutbox/rules/age
import scoutbox/safety/audit
import scoutbox/safety/ledger
import scoutbox/safety/moderate
import scoutbox/vocab/audience
import scoutbox/vocab/position
import wisp.{type Request, type Response}

const name_max = 120

const password_min = 8

const password_max = 256

/// Not ported yet: password hashing (scrypt) is out of this slice's scope. A new account's hash is this marker,
/// which no password verifies, so the account can't be signed in to by password, and isn't mistaken for a
/// passwordless demo identity either.
const unhashed = "!unported:scrypt"

type Signup {
  Signup(
    name: Option(String),
    dob: Option(String),
    country: Option(String),
    city: Option(String),
    position: Option(position.Position),
    foot: Option(row.Foot),
    height_cm: Option(Int),
    weight_kg: Option(Int),
    lat: Option(Float),
    lng: Option(Float),
    password: Option(String),
  )
}

/// One of `pairs`, or `''` for none (the forms send an empty choice).
fn blank_or(pairs: List(#(String, a))) -> input.Rule(Option(a)) {
  let rule =
    input.nullish(
      input.one_of([#("", None), ..list.map(pairs, fn(p) { #(p.0, Some(p.1)) })]),
    )
  fn(value) { rule(value) |> result.map(option.flatten) }
}

/// A new player's profile (identity/schemas.mjs PROFILE) and a password.
fn signup_shape() -> input.Shape(Signup) {
  profile_shape(True)
}

/// A new player's profile, with a password field or (a guardian's child) without one.
fn profile_shape(with_password: Bool) -> input.Shape(Signup) {
  use name <- input.field("name", input.nullish(input.text(name_max)))
  use dob <- input.field("dob", input.nullish(input.text(10)))
  use country <- input.field("country", input.optional(input.required_text(40)))
  use city <- input.field("city", input.nullish(input.text(80)))
  use position <- input.field("position", blank_or(position.pairs))
  use foot <- input.field("foot", blank_or(row.foot_pairs))
  use height_cm <- input.field(
    "heightCm",
    input.nullish(input.whole_number(50, 250)),
  )
  use weight_kg <- input.field(
    "weightKg",
    input.nullish(input.whole_number(15, 200)),
  )
  use lat <- input.field("lat", input.nullish(input.number(-90, 90)))
  use lng <- input.field("lng", input.nullish(input.number(-180, 180)))
  use password <- maybe_field(
    with_password,
    "password",
    input.nullish(input.text(password_max)),
  )
  input.done(Signup(
    name:,
    dob:,
    country:,
    city:,
    position:,
    foot:,
    height_cm:,
    weight_kg:,
    lat:,
    lng:,
    password:,
  ))
}

fn maybe_field(
  present: Bool,
  name: String,
  rule: input.Rule(Option(a)),
  next: fn(Option(a)) -> input.Shape(b),
) -> input.Shape(b) {
  case present {
    True -> input.field(name, rule, next)
    False -> next(None)
  }
}

/// `POST /guardian/children`: a guardian onboards their child, once their e-mail and identity are verified and
/// the safeguarding disclaimer is accepted. Adults make their own accounts.
pub fn create_child(ctx: Ctx, req: Request, g: guardians.Guardian) -> Response {
  case g.row.email_verified, g.row.id_verified, g.row.disclaimer_accepted {
    False, _, _ ->
      http.error_message(
        403,
        "EMAIL_UNVERIFIED",
        "Verify your email address first — the code is in your inbox.",
      )
    _, False, _ ->
      http.error_message(
        403,
        "GUARDIAN_ID_UNVERIFIED",
        "Verify your identity before onboarding a child.",
      )
    _, _, False ->
      http.error_message(
        403,
        "DISCLAIMER_REQUIRED",
        "Accept the safeguarding disclaimer before onboarding a child.",
      )
    True, True, True -> {
      use body <- http.body(req, profile_shape(False), [#("dob", "DOB_INVALID")])
      let now = clock.now_ms()
      let country = option.unwrap(body.country, "GB")
      case body.name, body.dob {
        None, _ | _, None | Some(""), _ | _, Some("") ->
          http.error(400, "NAME_AND_DOB_REQUIRED")
        Some(name), Some(dob) ->
          case string.trim(name), age.parse_dob(dob, now) {
            "", _ ->
              http.json(
                400,
                json.object([
                  #("error", json.string("FIELD_INVALID")),
                  #("field", json.string("name")),
                  #("problem", json.string("blank")),
                  #("message", json.string("name must not be blank.")),
                ]),
              )
            _, Error(Nil) ->
              http.error_message(
                400,
                "DOB_INVALID",
                "Enter a date of birth as YYYY-MM-DD.",
              )
            _, Ok(_) ->
              case age.is_adult(dob, country, now) {
                True ->
                  http.error_message(
                    400,
                    "NOT_A_MINOR",
                    "Adults create their own account with player sign-up.",
                  )
                False -> {
                  let created =
                    store.unit(ctx.store, fn(tx) {
                      use p <- result.map(players.create(
                        tx,
                        players.NewPlayer(
                          name:,
                          dob:,
                          country:,
                          city: case body.city {
                            Some("") -> None
                            other -> other
                          },
                          position: body.position,
                          foot: body.foot,
                          height_cm: body.height_cm,
                          weight_kg: body.weight_kg,
                          location: case body.lat, body.lng {
                            Some(lat), Some(lng) -> Some(#(lat, lng))
                            _, _ -> None
                          },
                          password_hash: None,
                          guardian_id: Some(g.row.id),
                          created_at: now,
                        ),
                      ))
                      // Not ported yet: the saved-search check (discovery) and the live 'players' event.
                      #(p, [])
                    })
                  case created {
                    Ok(p) ->
                      http.json(
                        201,
                        json.object([
                          #("playerId", json.string(p.row.id)),
                          #("player", players.guardian_child_view(p, now)),
                        ]),
                      )
                    Error(failure) -> http.internal(failure)
                  }
                }
              }
          }
      }
    }
  }
}

/// `POST /auth/player/signup`.
pub fn signup(ctx: Ctx, req: Request) -> Response {
  use body <- http.body(req, signup_shape(), [#("dob", "DOB_INVALID")])
  let now = clock.now_ms()
  let country = option.unwrap(body.country, "GB")
  case body.name, body.dob {
    None, _ | _, None | Some(""), _ | _, Some("") ->
      http.error(400, "NAME_AND_DOB_REQUIRED")
    Some(name), Some(dob) ->
      case string.trim(name), age.parse_dob(dob, now), body.password {
        "", _, _ ->
          http.json(
            400,
            json.object([
              #("error", json.string("FIELD_INVALID")),
              #("field", json.string("name")),
              #("problem", json.string("blank")),
              #("message", json.string("name must not be blank.")),
            ]),
          )
        _, Error(Nil), _ ->
          http.error_message(
            400,
            "DOB_INVALID",
            "Enter a date of birth as YYYY-MM-DD.",
          )
        _, _, password ->
          case option.map(password, input.utf16_length) {
            None -> password_required()
            Some(n) if n < password_min -> password_required()
            Some(_) ->
              case age.is_adult(dob, country, now) {
                False -> {
                  let required = age.adult_age_for(country)
                  http.error_message(
                    403,
                    "GUARDIAN_REQUIRED",
                    "Under-"
                      <> int.to_string(required)
                      <> " profiles are owned by a parent or guardian. A guardian must verify their ID, accept the safeguarding disclaimer, and create the profile from their own account.",
                  )
                }
                True -> create(ctx, body, name, dob, country, now)
              }
          }
      }
  }
}

fn password_required() -> Response {
  http.error_message(
    400,
    "PASSWORD_REQUIRED",
    "Pick a password of at least 8 characters — your profile is yours alone.",
  )
}

fn create(
  ctx: Ctx,
  body: Signup,
  name: String,
  dob: String,
  country: String,
  now: Int,
) -> Response {
  let created =
    store.unit(ctx.store, fn(tx) {
      use p <- result.try(players.create(
        tx,
        players.NewPlayer(
          name:,
          dob:,
          country:,
          city: case body.city {
            Some("") -> None
            other -> other
          },
          position: body.position,
          foot: body.foot,
          height_cm: body.height_cm,
          weight_kg: body.weight_kg,
          // Without coordinates the player is not visible to grassroots clubs: the radius rule fails closed.
          location: case body.lat, body.lng {
            Some(lat), Some(lng) -> Some(#(lat, lng))
            _, _ -> None
          },
          password_hash: Some(unhashed),
          guardian_id: None,
          created_at: now,
        ),
      ))
      // Not ported yet: the saved-search check (discovery) and the live 'players' event.
      use token <- result.map(sessions.create(
        tx,
        sessions.Player(p.row.id),
        now,
      ))
      #(#(p, token), [])
    })
  case created {
    Ok(#(p, token)) ->
      http.json(
        201,
        json.object([
          #("playerId", json.string(p.row.id)),
          #("player", players.self_view(p)),
          #("token", json.string(token)),
        ]),
      )
    Error(failure) -> http.internal(failure)
  }
}

type Timeline {
  Timeline(year: Option(String), event: Option(String))
}

/// `POST /player/timeline`: an entry on the player's football timeline, moderated.
pub fn add_timeline(ctx: Ctx, req: Request, p: PlayerAccess) -> Response {
  let shape = {
    use year <- input.field("year", input.nullish(input.text(20)))
    use event <- input.field("event", input.nullish(input.text(300)))
    input.done(Timeline(year:, event:))
  }
  use body <- http.body(req, shape, [])
  case input.filled(body.year), input.filled(body.event) {
    Some(year), Some(event) -> {
      use <- moderate.or_refuse(
        ctx,
        event,
        audit.Context(
          kind: "timeline_event",
          player_id: Some(p.player.row.id),
          org_id: None,
          user_id: None,
        ),
      )
      let written =
        store.unit(ctx.store, fn(tx) {
          use _ <- result.try(players.add_timeline_entry(
            tx,
            p.player.row.id,
            year,
            event,
          ))
          use found <- result.map(players.by_id(
            store.reading(tx),
            p.player.row.id,
          ))
          #(found, [])
        })
      case written {
        Ok(Some(player)) ->
          http.json(
            201,
            json.object([
              #(
                "timeline",
                json.array(player.timeline, fn(t) {
                  json.object([
                    #("year", json.string(t.year)),
                    #("event", json.string(t.event)),
                  ])
                }),
              ),
            ]),
          )
        Ok(None) -> http.error(404, "PLAYER_NOT_FOUND")
        Error(failure) -> http.internal(failure)
      }
    }
    _, _ -> http.error(400, "YEAR_AND_EVENT_REQUIRED")
  }
}

/// `GET /player/export`: everything held about the player.
pub fn export(ctx: Ctx, p: PlayerAccess) -> Response {
  let id = p.player.row.id
  let found =
    store.read(ctx.store, fn(read) {
      use reqs <- result.try(requests.for_player(read, id))
      use feed <- result.try(notifications.feed(read, audience.Player, id))
      use events <- result.map(ledger.for_player(read, id))
      json.object([
        #("exportedAt", json.string(clock.iso(clock.now_ms()))),
        #("profile", players.self_view(p.player)),
        #("requests", json.array(reqs, requests.recipient_view)),
        // Not ported yet: message threads (messaging) and insights (discovery).
        #("threads", json.preprocessed_array([])),
        #("notifications", json.array(feed, notifications.view)),
        #("insights", json.null()),
        #("ledgerEvents", json.array(events, ledger.view)),
      ])
    })
  case found {
    Ok(body) -> http.json(200, body)
    Error(failure) -> http.internal(failure)
  }
}

/// `POST /auth/player/login`: a demo sign-in by player id. The wrong-guess budget is checked before the lookup,
/// so an unknown id and a real one are refused alike once it is spent.
pub fn login(ctx: Ctx, req: Request) -> Response {
  let shape = {
    use player_id <- input.field("playerId", input.nullish(input.text(80)))
    use _password <- input.field("password", input.nullish(input.text(256)))
    input.done(player_id)
  }
  use player_id <- http.body(req, shape, [])
  let now = clock.now_ms()
  let tried = "player:" <> option.unwrap(player_id, "undefined")
  use <- bool.guard(
    limits.login_locked(ctx.limits, tried, now),
    sign_in.locked_out(),
  )
  let found = case player_id {
    Some(id) -> store.read(ctx.store, players.by_id(_, id))
    None -> Ok(None)
  }
  case found {
    Error(failure) -> http.internal(failure)
    Ok(None) -> {
      limits.login_failed(ctx.limits, tried, now)
      http.error(404, "PLAYER_NOT_FOUND")
    }
    // Not ported yet: password-protected players need scrypt (out of this slice's scope).
    Ok(Some(p)) ->
      case p.row.password_hash, ctx.config.dev_logins {
        Some(_), _ ->
          http.error_message(
            501,
            "NOT_PORTED",
            "Password-protected player accounts are not supported by this server yet.",
          )
        None, False ->
          http.error_message(
            403,
            "DEV_LOGIN_DISABLED",
            "Passwordless demo logins are disabled outside development. Use a credentialed account.",
          )
        None, True ->
          case
            store.unit(ctx.store, fn(tx) {
              sessions.create(tx, sessions.Player(p.row.id), now)
              |> result.map(fn(token) { #(token, []) })
            })
          {
            Ok(token) ->
              http.json(
                200,
                json.object([
                  #("playerId", json.string(p.row.id)),
                  #("name", json.string(p.row.name)),
                  #("token", json.string(token)),
                ]),
              )
            Error(failure) -> http.internal(failure)
          }
      }
  }
}
