//// The notification feeds and what a person does with them (domains/messaging/notify.mjs): `GET /…/notifications`,
//// marking it read, and registering the Player app's device for push (`POST /push/register`).

import gleam/json
import gleam/option.{None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/identity/sessions
import scoutbox/messaging/notifications
import scoutbox/messaging/push
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/store
import scoutbox/rows/id
import scoutbox/vocab/audience.{type Audience}
import scoutbox/vocab/party
import wisp.{type Request, type Response}

pub fn feed(ctx: Ctx, kind: Audience, id: String) -> Response {
  case store.read(ctx.store, notifications.feed(_, kind, id)) {
    Ok(rows) -> http.json(200, json.array(rows, notifications.view))
    Error(failure) -> http.internal(failure)
  }
}

/// `POST /…/notifications/read`: every row of this person's feed.
pub fn read(ctx: Ctx, req: Request, kind: Audience, id: String) -> Response {
  use _ <- http.body(req, input.nothing(), [])
  case
    store.unit(ctx.store, fn(tx) {
      notifications.mark_read(tx, kind, id) |> result.replace(Nil)
    })
  {
    Ok(Nil) -> http.json(200, json.object([#("ok", json.bool(True))]))
    Error(failure) -> http.internal(failure)
  }
}

/// `POST /push/register`: players and guardians only; club staff are notified in their portal and by e-mail. A
/// token another account registered moves to this one, so a shared phone gets only the latest sign-in's notices.
pub fn register_device(ctx: Ctx, req: Request) -> Response {
  let now = clock.now_ms()
  let holder = case http.bearer(req) {
    Ok(token) ->
      store.read(ctx.store, sessions.by_token(
        _,
        token,
        now,
        ctx.config.session_ttl_ms,
      ))
      |> result.map(option.map(_, fn(s) { s.holder }))
    Error(Nil) -> Ok(None)
  }
  case holder {
    Error(failure) -> http.internal(failure)
    Ok(None) -> http.error(401, "AUTH_REQUIRED")
    Ok(Some(holder)) -> {
      let shape = {
        use token <- input.field("token", input.nullish(input.text(200)))
        input.done(token)
      }
      use token <- http.body(req, shape, [#("token", "TOKEN_INVALID")])
      case token, holder {
        None, _ | Some(""), _ -> http.required("TOKEN_REQUIRED", "token")
        Some(token), sessions.Player(p) ->
          register(ctx, party.Player, id.player_to_string(p), token, now)
        Some(token), sessions.Guardian(g) ->
          register(ctx, party.Guardian, id.guardian_to_string(g), token, now)
        Some(_), sessions.OrgStaff(..) | Some(_), sessions.Reviewer(..) ->
          http.error_message(
            403,
            "PUSH_NOT_AVAILABLE",
            "Push notifications go to the Player app's players and guardians.",
          )
      }
    }
  }
}

fn register(
  ctx: Ctx,
  kind: party.Party,
  ref_id: String,
  token: String,
  now: Int,
) -> Response {
  case
    store.unit(ctx.store, fn(tx) { push.register(tx, kind, ref_id, token, now) })
  {
    Ok(moved) ->
      http.json(
        201,
        json.object([
          #("registered", json.bool(True)),
          #("moved", json.bool(moved)),
        ]),
      )
    Error(failure) -> http.internal(failure)
  }
}
