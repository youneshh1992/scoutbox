//// Staff second factor: set-up shows the secret once, the first good code enables it and hands out ten
//// one-time recovery codes, and turning it off needs a current code.

import gleam/bit_array
import gleam/crypto
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/staff
import scoutbox/identity/totp
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/limits
import scoutbox/platform/secrets
import scoutbox/platform/store
import wisp.{type Request, type Response}

fn code_shape() -> input.Shape(Option(String)) {
  use code <- input.field("code", input.nullish(input.text(128)))
  input.done(code)
}

fn enabled(user: staff.Staff) -> Bool {
  case staff.mfa(user) {
    staff.MfaEnabled(_) -> True
    _ -> False
  }
}

/// `POST /org/mfa/setup`
pub fn setup(ctx: Ctx, req: Request, access: OrgAccess) -> Response {
  use _ <- http.body(req, input.nothing(), [])
  case enabled(access.user) {
    True -> http.error(409, "MFA_ALREADY_ENABLED")
    False -> {
      let secret = totp.b32encode(crypto.strong_random_bytes(20))
      let outcome =
        store.unit(ctx.store, fn(tx) {
          staff.start_mfa(tx, access.user.id, secret)
          |> result.map(fn(u) { #(u, []) })
        })
      case outcome {
        Ok(_) ->
          http.json(
            200,
            json.object([
              #("secret", json.string(secret)),
              #(
                "otpauth",
                json.string(
                  "otpauth://totp/ScoutBox:"
                  <> uri_component(access.user.name)
                  <> "?secret="
                  <> secret
                  <> "&issuer=ScoutBox",
                ),
              ),
              #(
                "note",
                json.string(
                  "Scan into an authenticator app, then confirm with POST /org/mfa/verify {code}. The secret is shown once.",
                ),
              ),
            ]),
          )
        Error(store.Refused(staff.MfaAlreadyEnabled)) ->
          http.error(409, "MFA_ALREADY_ENABLED")
        Error(failure) -> http.internal(failure)
      }
    }
  }
}

/// `POST /org/mfa/verify`
pub fn verify(ctx: Ctx, req: Request, access: OrgAccess) -> Response {
  use code <- http.body(req, code_shape(), [])
  let user = access.user
  let now = clock.now_ms()
  case store.read(ctx.store, staff.mfa_secret_of(_, user.id)) {
    Error(failure) -> http.internal(failure)
    Ok(None) -> http.error(409, "MFA_NOT_PENDING")
    Ok(Some(_)) if user.mfa_enabled_at != None ->
      http.error(409, "MFA_NOT_PENDING")
    Ok(Some(secret)) ->
      case limits.mfa_locked(ctx.limits, user.id, now) {
        True ->
          http.error_message(
            429,
            "MFA_LOCKED",
            "Too many wrong codes — try again in a few minutes.",
          )
        False ->
          case code_valid(secret, code, now) {
            False -> {
              limits.mfa_failed(ctx.limits, user.id, now)
              http.error(401, "MFA_CODE_WRONG")
            }
            True -> {
              let plain =
                list.repeat(Nil, 10)
                |> list.map(fn(_) { secrets.random_hex(5) })
              let outcome =
                store.unit(ctx.store, fn(tx) {
                  staff.enable_mfa(
                    tx,
                    user.id,
                    at: now,
                    recovery_hashes: list.map(plain, secrets.sha256_hex),
                  )
                  |> result.map(fn(u) { #(u, []) })
                })
              case outcome {
                Ok(_) ->
                  http.json(
                    200,
                    json.object([
                      #("enabled", json.bool(True)),
                      #("recoveryCodes", json.array(plain, json.string)),
                      #(
                        "note",
                        json.string(
                          "Store these recovery codes now — each works once and they are never shown again.",
                        ),
                      ),
                    ]),
                  )
                Error(store.Refused(staff.MfaNotPending)) ->
                  http.error(409, "MFA_NOT_PENDING")
                Error(failure) -> http.internal(failure)
              }
            }
          }
      }
  }
}

/// `POST /org/mfa/disable`: proof of control first.
pub fn disable(ctx: Ctx, req: Request, access: OrgAccess) -> Response {
  use code <- http.body(req, code_shape(), [])
  let user = access.user
  case enabled(user) {
    False -> http.error(409, "MFA_NOT_ENABLED")
    True -> {
      let secret = store.read(ctx.store, staff.mfa_secret_of(_, user.id))
      case secret {
        Error(failure) -> http.internal(failure)
        Ok(secret) ->
          case
            option.map(secret, code_valid(_, code, clock.now_ms()))
            |> option.unwrap(False)
          {
            False -> http.error(401, "MFA_CODE_WRONG")
            True ->
              case
                store.unit(ctx.store, fn(tx) {
                  staff.disable_mfa(tx, user.id)
                  |> result.map(fn(u) { #(u, []) })
                })
              {
                Ok(_) ->
                  http.json(200, json.object([#("enabled", json.bool(False))]))
                Error(failure) -> http.internal(failure)
              }
          }
      }
    }
  }
}

fn code_valid(secret: String, code: Option(String), now: Int) -> Bool {
  case code {
    Some(code) -> totp.valid(secret, code, now)
    None -> False
  }
}

/// encodeURIComponent: everything but A–Z a–z 0–9 - _ . ! ~ * ' ( ) is percent-encoded, byte by byte in UTF-8.
pub fn uri_component(s: String) -> String {
  string.to_graphemes(s)
  |> list.map(fn(g) {
    case string.contains(unreserved, g) {
      True -> g
      False ->
        bit_array.from_string(g)
        |> bit_array.base16_encode
        |> string.to_graphemes
        |> list.sized_chunk(2)
        |> list.map(fn(pair) { "%" <> string.concat(pair) })
        |> string.concat
    }
  })
  |> string.concat
}

const unreserved =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
