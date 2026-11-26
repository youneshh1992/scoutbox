//// A staff member's own sessions, and the organisation's sign-in security (domains/enterprise/enterprise.mjs,
//// "MFA + sessions"). Sessions hold only their token's hash, so "current" is decided by hashing the bearer token.

import gleam/json
import gleam/option.{None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/orgs
import scoutbox/identity/sessions
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/store
import scoutbox/rows/sessions as session_row
import wisp.{type Request, type Response}

/// `GET /org/sessions`: the member's devices, with no token or hash.
pub fn list(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  let token = http.bearer(req) |> result.unwrap("")
  case store.read(ctx.store, sessions.of_org_user(_, a.user.id)) {
    Error(failure) -> http.internal(failure)
    Ok(mine) ->
      http.json(
        200,
        json.object([
          #(
            "items",
            json.array(mine, fn(s) {
              json.object([
                #("sid", json.string(s.sid)),
                #("createdAt", json.int(s.created_at)),
                #("current", json.bool(sessions.is_token_of(s, token))),
                #("via", case s.via {
                  Some(via) -> session_row.via_to_json(via)
                  None -> json.string("password")
                }),
              ])
            }),
          ),
        ]),
      )
  }
}

/// `POST /org/sessions/revoke`: ends one of the member's own sessions; another's sid ends nothing.
pub fn revoke(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  let shape = {
    use sid <- input.field("sid", input.nullish(input.text(128)))
    input.done(sid)
  }
  use sid <- http.body(req, shape, [])
  let ended = case sid {
    None | Some("") -> Ok(0)
    Some(sid) ->
      store.unit(ctx.store, fn(tx) { sessions.revoke_own(tx, a.user.id, sid) })
  }
  case ended {
    Ok(n) -> http.json(200, json.object([#("revoked", json.int(n))]))
    Error(failure) -> http.internal(failure)
  }
}

/// `PUT /org/security`: a lead switches the MFA requirement for leads.
pub fn put(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use <- access.require_lead(a)
  let shape = {
    use required <- input.field(
      "mfaRequiredForLeads",
      input.required(input.boolean()),
    )
    input.done(required)
  }
  use required <- http.body(req, shape, [])
  case
    store.unit(ctx.store, fn(tx) {
      orgs.require_mfa_for_leads(tx, a.org.id, required)
    })
  {
    Ok(Nil) ->
      http.json(
        200,
        json.object([
          #("mfaRequiredForLeads", json.bool(required)),
          #(
            "note",
            json.string(
              "Enforced at login: leads without MFA are asked to set it up before privileged actions.",
            ),
          ),
        ]),
      )
    Error(failure) -> http.internal(failure)
  }
}
