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
import scoutbox/discovery/insights
import scoutbox/discovery/saved_searches
import scoutbox/identity/access.{type PlayerAccess}
import scoutbox/identity/guardians
import scoutbox/identity/pairing
import scoutbox/identity/passwords
import scoutbox/identity/players
import scoutbox/identity/sessions
import scoutbox/identity/sign_in
import scoutbox/messaging/channels
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/limits
import scoutbox/platform/store
import scoutbox/platform/temporal
import scoutbox/recruitment/notification_targets
import scoutbox/recruitment/requests
import scoutbox/rows/id
import scoutbox/rows/ledger as ledger_row
import scoutbox/rules/age
import scoutbox/safety/audit
import scoutbox/safety/ledger
import scoutbox/safety/moderate
import scoutbox/vocab/audience
import scoutbox/vocab/foot
import scoutbox/vocab/position
import wisp.{type Request, type Response}

const name_max = 120

const password_min = 8

const password_max = 256

type Signup {
  Signup(
    name: Option(String),
    dob: Option(String),
    country: Option(String),
    city: Option(String),
    position: Option(position.Position),
    foot: Option(foot.Foot),
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
  use foot <- input.field("foot", blank_or(foot.pairs))
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
            _, Error(_) ->
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
                          location: case body.lat, body.lng {
                            Some(lat), Some(lng) -> Some(#(lat, lng))
                            _, _ -> None
                          },
                          password_hash: None,
                          guardian_id: Some(g.row.id),
                          created_at: now,
                        ),
                      ))
                      // Not ported yet: the live 'players' event.
                      saved_searches.alert_new_player(tx, p, now)
                      |> result.replace(p)
                    })
                  case created {
                    Ok(p) ->
                      http.json(
                        201,
                        json.object([
                          #("playerId", id.player_json(p.row.id)),
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
        _, Error(_), _ ->
          http.error_message(
            400,
            "DOB_INVALID",
            "Enter a date of birth as YYYY-MM-DD.",
          )
        _, _, password ->
          case password {
            None -> password_required()
            Some(password) ->
              case input.utf16_length(password) < password_min {
                True -> password_required()
                False ->
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
                    // Hashed before the unit: it takes about half a second, and a unit holds the only writer.
                    True ->
                      create(
                        ctx,
                        body,
                        name,
                        dob,
                        country,
                        passwords.hash(password),
                        now,
                      )
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
    "Pick a password of at least 8 characters — your profile is yours alone.",
  )
}

fn create(
  ctx: Ctx,
  body: Signup,
  name: String,
  dob: String,
  country: String,
  password_hash: String,
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
          password_hash: Some(password_hash),
          guardian_id: None,
          created_at: now,
        ),
      ))
      // Not ported yet: the live 'players' event.
      use _ <- result.try(saved_searches.alert_new_player(tx, p, now))
      use token <- result.map(sessions.create(
        tx,
        sessions.Player(p.row.id),
        now,
        ctx.config.session_ttl_ms,
      ))
      #(p, token)
    })
  case created {
    Ok(#(p, token)) ->
      http.json(
        201,
        json.object([
          #("playerId", id.player_json(p.row.id)),
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
          channel_id: None,
          request_id: None,
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
          found
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
  let exported_at = clock.iso(clock.now_ms())
  case store.read(ctx.store, bundle(_, p.player, exported_at)) {
    Ok(body) -> http.json(200, body)
    Error(failure) -> http.internal(failure)
  }
}

/// `GET /guardian/export`: the guardian's record and each child's export.
pub fn guardian_export(ctx: Ctx, g: guardians.Guardian) -> Response {
  let exported_at = clock.iso(clock.now_ms())
  let found =
    store.read(ctx.store, fn(read) {
      use kids <- result.try(players.by_ids(read, g.child_ids))
      use children <- result.map(
        list.try_map(kids, bundle(read, _, exported_at)),
      )
      json.object([
        #("exportedAt", json.string(exported_at)),
        #("guardian", guardians.self_view(g)),
        #("children", json.preprocessed_array(children)),
      ])
    })
  case found {
    Ok(body) -> http.json(200, body)
    Error(failure) -> http.internal(failure)
  }
}

/// Everything held about a player, as their export carries it.
fn bundle(
  read: store.Read,
  p: players.Player,
  exported_at: String,
) -> Result(json.Json, store.Fail(e)) {
  let id = p.row.id
  use reqs <- result.try(requests.for_player(read, id))
  use feed <- result.try(notifications.feed(
    read,
    audience.Player,
    id.player_to_string(id),
    notification_targets.target,
  ))
  use threads <- result.try(channels.every_for_player(read, id))
  use insight <- result.try(insights.for_player(read, id, clock.now_ms()))
  use events <- result.map(ledger.for_player(read, id))
  json.object([
    #("exportedAt", json.string(exported_at)),
    #("profile", players.self_view(p)),
    #("requests", json.array(reqs, requests.recipient_view)),
    #(
      "threads",
      json.array(threads, channels.view(_, channels.ForCounterparty)),
    ),
    #("notifications", json.array(feed, notifications.view)),
    #("insights", insight),
    #("ledgerEvents", json.array(events, ledger.view)),
  ])
}

/// `POST /auth/player/login`, by player id: with the password when the player has one, else a passwordless demo
/// sign-in (development only). The wrong-guess budget is checked before the lookup, so an unknown id and a real one
/// are refused alike once it is spent.
pub fn login(ctx: Ctx, req: Request) -> Response {
  let shape = {
    use player_id <- input.field("playerId", input.nullish(input.text(80)))
    use password <- input.field("password", input.nullish(input.text(256)))
    input.done(#(player_id, password))
  }
  use #(player_id, password) <- http.body(req, shape, [])
  let now = clock.now_ms()
  let tried = "player:" <> option.unwrap(player_id, "undefined")
  use <- bool.guard(
    limits.login_locked(ctx.limits, tried, now),
    sign_in.locked_out(),
  )
  let found = case player_id {
    // From the request body.
    Some(player_id) ->
      store.read(ctx.store, players.by_id(_, id.player(player_id)))
    None -> Ok(None)
  }
  case found {
    Error(failure) -> http.internal(failure)
    Ok(None) -> {
      limits.login_failed(ctx.limits, tried, now)
      http.error(404, "PLAYER_NOT_FOUND")
    }
    Ok(Some(p)) -> {
      // The hash is checked before the unit: it takes about half a second, and a unit holds the only writer.
      let refused = case p.row.password_hash, ctx.config.dev_logins {
        Some(stored), _ ->
          case passwords.verify(option.unwrap(password, ""), stored) {
            True -> None
            False -> {
              limits.login_failed(
                ctx.limits,
                "player:" <> id.player_to_string(p.row.id),
                now,
              )
              Some(http.error_message(
                401,
                "BAD_PASSWORD",
                "This profile is password-protected.",
              ))
            }
          }
        None, False ->
          Some(http.error_message(
            403,
            "DEV_LOGIN_DISABLED",
            "Passwordless demo logins are disabled outside development. Use a credentialed account.",
          ))
        None, True -> None
      }
      use <- option.lazy_unwrap(refused)
      case
        store.unit(ctx.store, fn(tx) {
          sessions.create(
            tx,
            sessions.Player(p.row.id),
            now,
            ctx.config.session_ttl_ms,
          )
        })
      {
        Ok(token) ->
          http.json(
            200,
            json.object([
              #("playerId", id.player_json(p.row.id)),
              #("name", json.string(p.row.name)),
              #("token", json.string(token)),
            ]),
          )
        Error(failure) -> http.internal(failure)
      }
    }
  }
}

/// `POST /auth/player/pair`: a child's device exchanges a guardian's pairing code for a session. A wrong code is
/// charged to the client's address, on top of the /auth limiter; a correct one costs nothing. The code is used up in
/// the unit that makes the session, so a failure anywhere keeps it live. Run through `http.rerun_on_stale`: a code
/// another device used first is a wrong code on the rerun.
pub fn pair(ctx: Ctx, req: Request, address: String) -> Response {
  let shape = {
    use code <- input.field("code", input.nullish(input.text(64)))
    input.done(code)
  }
  use code <- http.body(req, shape, [])
  let now = clock.now_ms()
  use <- bool.guard(
    limits.spent(ctx.limits, limits.PairingAttempt, address, now),
    http.json(429, limits.limited_json(limits.PairingAttempt)),
  )
  let code = option.unwrap(code, "")
  let found = {
    use child <- result.try(store.read(ctx.store, pairing.live(_, code, now)))
    case child {
      None -> Ok(#(None, None))
      Some(child) ->
        store.read(ctx.store, players.by_id(_, child))
        |> result.map(fn(p) { #(Some(child), p) })
    }
  }
  case found {
    Error(failure) -> http.internal(failure)
    Ok(#(live, None)) -> {
      // A live code for a child who is gone pairs nothing again.
      let revoked = case live {
        Some(child) -> store.unit(ctx.store, pairing.revoke_for(_, child))
        None -> Ok(Nil)
      }
      case revoked, http.rerun(req) {
        Error(failure), _ -> http.internal(failure)
        Ok(Nil), True -> code_invalid()
        Ok(Nil), False -> {
          let _ =
            limits.limited(ctx.limits, limits.PairingAttempt, address, now)
          code_invalid()
        }
      }
    }
    Ok(#(_, Some(p))) -> {
      let paired =
        store.unit(ctx.store, fn(tx) {
          use consumed <- result.try(pairing.consume(tx, code, now))
          use <- bool.guard(
            consumed != Some(p.row.id),
            store.stale("pairing code"),
          )
          use _ <- result.try(store.seam(tx, "pairing.after_consume"))
          sessions.create(
            tx,
            sessions.Player(p.row.id),
            now,
            ctx.config.session_ttl_ms,
          )
        })
      case paired {
        Ok(token) ->
          http.json(
            200,
            json.object([
              #("playerId", id.player_json(p.row.id)),
              #("name", json.string(p.row.name)),
              #("token", json.string(token)),
            ]),
          )
        Error(store.Lost(what)) -> http.stale(what)
        Error(failure) -> http.internal(failure)
      }
    }
  }
}

fn code_invalid() -> Response {
  http.error_message(
    404,
    "CODE_INVALID",
    "That pairing code is wrong or expired — ask your parent/guardian for a fresh one.",
  )
}

/// `POST /player/aging-up/complete`: on their 18th birthday (the age of majority in their country), a
/// guardian-owned player takes the account over, with their consent.
pub fn complete_aging_up(ctx: Ctx, req: Request, p: PlayerAccess) -> Response {
  use _ <- http.body(req, input.nothing(), [])
  let player = p.player.row
  case p.minor, player.guardian_id {
    True, _ ->
      http.error_message(
        403,
        "STILL_A_MINOR",
        "The transition unlocks on your 18th birthday (age of majority in your country).",
      )
    False, None ->
      http.error_message(400, "ALREADY_OWNED", "You already own this account.")
    False, Some(guardian_id) -> {
      let now = clock.now_ms()
      let year = int.to_string(temporal.day_year(temporal.day_of(now)))
      let player_ref = Some(id.player_to_string(player.id))
      let done =
        store.unit(ctx.store, fn(tx) {
          use guardian <- result.try(guardians.by_id(
            store.reading(tx),
            guardian_id,
          ))
          use _ <- result.try(players.age_up(tx, player.id, guardian_id))
          use _ <- result.try(case guardian {
            Some(g) ->
              notifications.notify(
                tx,
                to: audience.Guardian,
                id: id.guardian_to_string(g.row.id),
                type_: "aging_up",
                text: player.name
                  <> " is 18 — their account is now their own. Their history stays intact, and thank you for keeping it safe.",
                ref_id: player_ref,
                at: now,
              )
            None -> Ok(Nil)
          })
          use _ <- result.try(players.add_timeline_entry(
            tx,
            player.id,
            year,
            "Turned 18 — took ownership of this ScoutBox account",
          ))
          use _ <- result.try(ledger.append(
            tx,
            ledger.Entry(
              entry_type: ledger_row.AccountTransitioned,
              player_id: Some(player.id),
              org_id: None,
              org_name: Some("ScoutBox"),
              user_id: None,
              actor_name: Some("system"),
            ),
            now,
          ))
          // Not ported yet: the live 'players' event.
          notifications.notify(
            tx,
            to: audience.Player,
            id: id.player_to_string(player.id),
            type_: "aging_up",
            text: "Your account is now fully yours. Availability, medical sharing and club contact are your calls from here.",
            ref_id: player_ref,
            at: now,
          )
        })
      case done {
        Ok(Nil) ->
          http.json(
            200,
            json.object([
              #("ok", json.bool(True)),
              #("owned", json.bool(True)),
            ]),
          )
        Error(failure) -> http.internal(failure)
      }
    }
  }
}
