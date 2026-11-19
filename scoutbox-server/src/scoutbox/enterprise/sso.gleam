//// Staff SSO against the local test identity provider (domains/enterprise/enterprise.mjs, "SSO (local test IdP)").
//// No corporate provider is configured and the API says so; the test provider is HMAC-signed and exists only where
//// dev logins do. The browser gets the state and the nonce; `sso_states` keeps only their hashes, and a state is
//// spent once, even when the sign-in then fails.
////
//// Linking needs proof: an e-mail bound by an accepted invite, or a subject a previous SSO sign-in linked. An
//// assertion for an e-mail never invited links and creates nothing, and the provider's group claims never grant a
//// ScoutBox role.

import gleam/bit_array
import gleam/crypto
import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/orgs
import scoutbox/identity/sessions
import scoutbox/identity/staff.{type Staff}
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/secrets
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/rows/id
import scoutbox/rows/sessions as session_row
import scoutbox/rows/sso_configs as config_row
import scoutbox/rows/sso_states as state_row
import sqlight
import wisp.{type Request, type Response}

/// An emailed invite code, an SSO state and a session id are short hex; a signed test-IdP code is a little longer.
const code_max = 128

const signed_code_max = 4096

const state_ttl_ms = 600_000

const code_ttl_ms = 300_000

fn config_of(
  read: Read,
  org_id: id.OrgId,
) -> Result(Option(config_row.Row), Fail(e)) {
  store.one(
    read,
    "SELECT " <> config_row.columns <> " FROM sso_configs WHERE org_id = ?",
    [id.org_sql(org_id)],
    config_row.decoder(),
  )
  |> result.map(option.from_result)
}

fn config_json(c: config_row.Row) -> Json {
  json.object([
    #("id", id.sso_config_json(c.id)),
    #("orgId", id.org_json(c.org_id)),
    #("issuer", config_row.issuer_to_json(c.issuer)),
    #("clientId", json.string(c.client_id)),
    #("createdAt", json.int(c.created_at)),
    #("updatedAt", json.int(c.updated_at)),
  ])
}

/// `GET /org/sso`.
pub fn view(ctx: Ctx, a: OrgAccess) -> Response {
  case store.read(ctx.store, config_of(_, a.org.id)) {
    Error(failure) -> http.internal(failure)
    Ok(found) ->
      http.json(
        200,
        json.object([
          #("config", json.nullable(found, config_json)),
          #(
            "available",
            json.array(
              case ctx.config.dev_logins {
                True -> ["local-test-idp"]
                False -> []
              },
              json.string,
            ),
          ),
          #("note", case found {
            Some(_) -> json.null()
            None ->
              json.string(
                "No identity provider configured. In this environment only the local test IdP is available — a corporate provider requires real OIDC credentials.",
              )
          }),
        ]),
      )
  }
}

/// `PUT /org/sso`: a lead points the organisation at the test provider, the only one there is.
pub fn configure(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use <- access.require_lead(a)
  let shape = {
    use issuer <- input.field("issuer", input.nullish(input.text(200)))
    input.done(issuer)
  }
  use issuer <- http.body(req, shape, [])
  case issuer, ctx.config.dev_logins {
    Some("local-test-idp"), False -> http.error(403, "TEST_IDP_DEV_ONLY")
    Some("local-test-idp"), True -> {
      let now = clock.now_ms()
      let client_id = "scoutbox-" <> id.org_to_string(a.org.id)
      let stored =
        store.unit(ctx.store, fn(tx) {
          use current <- result.try(config_of(store.reading(tx), a.org.id))
          use _ <- result.try(case current {
            Some(c) ->
              store.run(
                tx,
                "UPDATE sso_configs SET issuer = ?, client_id = ?, updated_at = ? WHERE id = ?",
                [
                  sqlight.text(config_row.issuer_to_string(
                    config_row.LocalTestIdp,
                  )),
                  sqlight.text(client_id),
                  sqlight.int(now),
                  id.sso_config_sql(c.id),
                ],
              )
            None -> {
              use config_id <- result.try(id.next_sso_config(tx))
              config_row.insert(
                tx,
                config_row.new(
                  id: config_id,
                  org_id: a.org.id,
                  issuer: config_row.LocalTestIdp,
                  client_id:,
                  created_at: now,
                  updated_at: now,
                ),
              )
            }
          })
          use found <- result.map(config_of(store.reading(tx), a.org.id))
          let assert Some(c) = found as "the configuration was just written"
          c
        })
      case stored {
        Ok(c) -> http.json(200, json.object([#("config", config_json(c))]))
        Error(failure) -> http.internal(failure)
      }
    }
    _, _ ->
      http.error_message(
        400,
        "IDP_UNAVAILABLE",
        "Only the local test IdP exists in this environment. A real provider needs its issuer URL, client id and secret configured on the server.",
      )
  }
}

/// Outside development both sign-in steps refuse before reading anything.
fn test_idp_only(ctx: Ctx, next: fn() -> Response) -> Response {
  case ctx.config.dev_logins {
    True -> next()
    False ->
      http.error_message(
        403,
        "SSO_PROVIDER_UNAVAILABLE",
        "Only the local test identity provider exists, and it is disabled outside development. Staff sign in with their organisation credentials.",
      )
  }
}

/// `POST /auth/sso/start`: mints a state and a nonce for the organisation's provider.
pub fn start(ctx: Ctx, req: Request) -> Response {
  use <- test_idp_only(ctx)
  let shape = {
    use org_id <- input.field("orgId", input.nullish(input.text(80)))
    input.done(org_id)
  }
  use org_id <- http.body(req, shape, [])
  let state = secrets.random_hex(16)
  let nonce = secrets.random_hex(16)
  let now = clock.now_ms()
  let started =
    store.unit(ctx.store, fn(tx) {
      let read = store.reading(tx)
      use config <- result.try(case org_id {
        None | Some("") -> Ok(None)
        Some(org_id) -> {
          use org <- result.try(orgs.by_id(read, id.org(org_id)))
          case org {
            Some(org) -> config_of(read, org.id)
            None -> Ok(None)
          }
        }
      })
      case config {
        None ->
          store.refuse(http.error_message(
            404,
            "SSO_NOT_CONFIGURED",
            "This organisation has no identity provider configured.",
          ))
        Some(c) -> {
          use state_id <- result.try(id.next_sso_state(tx))
          use _ <- result.map(state_row.insert(
            tx,
            state_row.new(
              id: state_id,
              state_hash: secrets.sha256_hex(state),
              nonce_hash: secrets.sha256_hex(nonce),
              org_id: c.org_id,
              created_at: now,
              expires_at: now + state_ttl_ms,
            ),
          ))
          c
        }
      }
    })
  case started {
    Ok(c) ->
      http.json(
        200,
        json.object([
          #(
            "authUrl",
            json.string(
              "/testidp/authorize?client_id="
              <> c.client_id
              <> "&state="
              <> state
              <> "&nonce="
              <> nonce,
            ),
          ),
          #("state", json.string(state)),
        ]),
      )
    Error(store.Refused(response)) -> response
    Error(failure) -> http.internal(failure)
  }
}

type Authorize {
  Authorize(
    client_id: Option(String),
    state: Option(String),
    nonce: Option(String),
    email: Option(String),
    groups: Option(String),
  )
}

/// `GET /testidp/authorize` (development only): authenticates as whatever e-mail the tester picks, since it exists
/// to exercise the relying party.
pub fn authorize(ctx: Ctx, req: Request) -> Response {
  let shape = {
    use client_id <- input.field("client_id", input.optional(input.text(200)))
    use state <- input.field("state", input.optional(input.text(code_max)))
    use nonce <- input.field("nonce", input.optional(input.text(code_max)))
    use email <- input.field("email", input.optional(input.text(254)))
    use groups <- input.field("groups", input.optional(input.text(100_000)))
    input.done(Authorize(client_id:, state:, nonce:, email:, groups:))
  }
  use q <- http.query(req, shape, [])
  case input.filled(q.client_id), q.state, q.nonce, q.email {
    Some(_), Some(state), Some(nonce), Some(email)
      if state != "" && nonce != "" && email != ""
    -> {
      let now = clock.now_ms()
      let groups =
        option.unwrap(q.groups, "")
        |> string.split(",")
        |> list.filter(fn(g) { g != "" })
      let payload =
        json.object([
          #("typ", json.string("code")),
          #(
            "sub",
            json.string(
              "idp-" <> string.slice(secrets.sha256_hex(email), 0, 12),
            ),
          ),
          #("email", json.string(email)),
          #("nonce", json.string(nonce)),
          #("groups", json.array(groups, json.string)),
          #("iat", json.int(now)),
          #("exp", json.int(now + code_ttl_ms)),
        ])
      http.json(
        200,
        json.object([
          #("code", json.string(sign(ctx, json.to_string(payload)))),
          #("state", json.string(state)),
        ]),
      )
    }
    _, _, _, _ ->
      http.error_message(
        400,
        "IDP_PARAMS",
        "client_id, state, nonce, email required",
      )
  }
}

fn signature(ctx: Ctx, body: String) -> String {
  crypto.hmac(
    bit_array.from_string(body),
    crypto.Sha256,
    bit_array.from_string(ctx.config.test_idp_secret),
  )
  |> bit_array.base64_url_encode(False)
}

fn sign(ctx: Ctx, payload: String) -> String {
  let body = bit_array.base64_url_encode(bit_array.from_string(payload), False)
  body <> "." <> signature(ctx, body)
}

type Claims {
  Claims(
    typ: Option(String),
    sub: Option(String),
    email: Option(String),
    nonce: Option(String),
    groups: List(String),
    exp: Option(Int),
  )
}

/// The claims of a code this provider signed, or `Error` for any other text.
fn verify(ctx: Ctx, code: String) -> Result(Claims, Nil) {
  case string.split(code, ".") {
    [body, sig, ..] if body != "" && sig != "" -> {
      use <- bool_guard(secrets.equal(sig, signature(ctx, body)))
      use bits <- result.try(bit_array.base64_url_decode(body))
      use text <- result.try(bit_array.to_string(bits))
      let decoder = {
        use typ <- text_claim("typ")
        use sub <- text_claim("sub")
        use email <- text_claim("email")
        use nonce <- text_claim("nonce")
        use groups <- decode.optional_field(
          "groups",
          [],
          decode.one_of(decode.list(decode.string), [decode.success([])]),
        )
        use exp <- decode.optional_field(
          "exp",
          None,
          decode.one_of(decode.int |> decode.map(Some), [decode.success(None)]),
        )
        decode.success(Claims(typ:, sub:, email:, nonce:, groups:, exp:))
      }
      json.parse(text, decoder) |> result.replace_error(Nil)
    }
    _ -> Error(Nil)
  }
}

/// A claim read as JavaScript's `typeof x === 'string'` would: anything else is absent.
fn text_claim(
  name: String,
  next: fn(Option(String)) -> decode.Decoder(a),
) -> decode.Decoder(a) {
  decode.optional_field(
    name,
    None,
    decode.one_of(decode.string |> decode.map(Some), [decode.success(None)]),
    next,
  )
}

fn bool_guard(ok: Bool, next: fn() -> Result(a, Nil)) -> Result(a, Nil) {
  case ok {
    True -> next()
    False -> Error(Nil)
  }
}

type Callback {
  Callback(code: Option(String), state: Option(String))
}

/// `POST /auth/sso/callback`: spends the state, checks the code and its nonce, and signs in the linked account.
pub fn callback(ctx: Ctx, req: Request) -> Response {
  use <- test_idp_only(ctx)
  let shape = {
    use code <- input.field("code", input.nullish(input.text(signed_code_max)))
    use state <- input.field("state", input.nullish(input.text(code_max)))
    input.done(Callback(code:, state:))
  }
  use body <- http.body(req, shape, [])
  let now = clock.now_ms()
  case spend_state(ctx, body.state, now) {
    Error(failure) -> http.internal(failure)
    Ok(None) ->
      http.error_message(
        401,
        "SSO_STATE_INVALID",
        "Unknown, expired or already-used state — restart the sign-in.",
      )
    Ok(Some(st)) ->
      case verify(ctx, option.unwrap(body.code, "")) {
        Ok(claims) if claims.typ == Some("code") ->
          case claims.exp {
            Some(exp) if exp < now -> http.error(401, "SSO_TOKEN_INVALID")
            _ -> signed_in(ctx, st, claims, now)
          }
        _ -> http.error(401, "SSO_TOKEN_INVALID")
      }
  }
}

/// The state, spent in a unit of its own: single use even when the sign-in then fails, and decided in the database,
/// so two callbacks racing on one state cannot both pass.
fn spend_state(
  ctx: Ctx,
  state: Option(String),
  now: Int,
) -> Result(Option(state_row.Row), store.UnitError(e)) {
  case state {
    None | Some("") -> Ok(None)
    Some(state) ->
      store.unit(ctx.store, fn(tx) {
        use found <- result.try(store.one(
          store.reading(tx),
          "SELECT "
            <> state_row.columns
            <> " FROM sso_states WHERE state_hash = ?",
          [sqlight.text(secrets.sha256_hex(state))],
          state_row.decoder(),
        ))
        case found {
          Ok(st) if st.used_at == None && st.expires_at >= now -> {
            use spent <- result.map(store.write(
              tx,
              "UPDATE sso_states SET used_at = ? WHERE id = ? AND used_at IS NULL RETURNING id",
              [sqlight.int(now), id.sso_state_sql(st.id)],
              decode.at([0], decode.string),
            ))
            case spent {
              [_] -> Some(st)
              _ -> None
            }
          }
          _ -> Ok(None)
        }
      })
  }
}

type Refusal {
  NonceMismatch
  OrgUnavailable
  NotLinked
  LinkConflict
}

fn signed_in(
  ctx: Ctx,
  st: state_row.Row,
  claims: Claims,
  now: Int,
) -> Response {
  let nonce_ok = case claims.nonce {
    Some(nonce) -> secrets.sha256_hex(nonce) == st.nonce_hash
    None -> False
  }
  let outcome =
    store.unit(ctx.store, fn(tx) {
      let read = store.reading(tx)
      use <- refuse_unless(nonce_ok, NonceMismatch)
      use org <- result.try(orgs.by_id(read, st.org_id))
      case org {
        Some(org) if !org.suspended -> {
          use user <- result.try(linked_account(read, org.id, claims))
          case user {
            None -> store.refuse(NotLinked)
            Some(user) -> {
              let sub = option.unwrap(claims.sub, "")
              use _ <- result.try(case user.sso_subject == Some(sub) {
                True -> Ok(user)
                False ->
                  staff.link_sso(tx, user.id, sub)
                  |> store.map_refusal(fn(_) { LinkConflict })
              })
              use token <- result.map(sessions.create_via(
                tx,
                sessions.OrgStaff(org.id, user.id),
                now,
                ctx.config.session_ttl_ms,
                Some(session_row.Sso),
              ))
              #(org, user, token)
            }
          }
        }
        _ -> store.refuse(OrgUnavailable)
      }
    })
  case outcome {
    Ok(#(org, user, token)) ->
      http.json(
        200,
        json.object([
          #("userId", id.org_user_json(user.id)),
          #("role", json.string(user.role)),
          #("org", json.object(orgs.view(org))),
          #("token", json.string(token)),
          #("ignoredClaims", case claims.groups {
            [] -> json.null()
            groups ->
              json.object([
                #("groups", json.array(groups, json.string)),
                #(
                  "note",
                  json.string(
                    "Identity-provider groups are ignored for permissions.",
                  ),
                ),
              ])
          }),
        ]),
      )
    Error(store.Refused(NonceMismatch)) ->
      http.error_message(
        401,
        "SSO_NONCE_MISMATCH",
        "The token was not minted for this sign-in attempt.",
      )
    Error(store.Refused(OrgUnavailable)) -> http.error(403, "ORG_UNAVAILABLE")
    Error(store.Refused(NotLinked)) ->
      http.error_message(
        403,
        "SSO_NOT_LINKED",
        "No staff account with this email exists in the organisation. Ask a lead for an invitation — SSO never creates accounts by itself.",
      )
    Error(store.Refused(LinkConflict)) ->
      http.error_message(
        409,
        "SSO_LINK_CONFLICT",
        "This identity-provider account is linked to another staff account of the organisation.",
      )
    Error(failure) -> http.internal(failure)
  }
}

/// The subject's linked account wins over the e-mail match; a removed linked account falls back to the e-mail.
fn linked_account(
  read: Read,
  org_id: id.OrgId,
  claims: Claims,
) -> Result(Option(Staff), Fail(e)) {
  use linked <- result.try(case claims.sub {
    Some(sub) -> staff.by_sso_subject(read, org_id, sub)
    None -> Ok(None)
  })
  case linked, claims.email {
    Some(user), _ if user.removed_at == None -> Ok(Some(user))
    _, Some(email) -> staff.active_by_email(read, org_id, email)
    _, None -> Ok(None)
  }
}

fn refuse_unless(
  ok: Bool,
  refusal: e,
  next: fn() -> Result(a, Fail(e)),
) -> Result(a, Fail(e)) {
  case ok {
    True -> next()
    False -> store.refuse(refusal)
  }
}
