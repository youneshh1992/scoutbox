//// Staff invitations: a lead invites by e-mail, and the emailed code is the proof of invitation.

import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/invites.{type Invite}
import scoutbox/identity/orgs.{type Org}
import scoutbox/identity/sessions
import scoutbox/identity/staff.{type Staff}
import scoutbox/integrations/imports
import scoutbox/platform/clock
import scoutbox/platform/effect.{SendMail}
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/pages
import scoutbox/platform/paging
import scoutbox/platform/secrets
import scoutbox/platform/store
import scoutbox/rows/id
import scoutbox/rows/org_invites
import wisp.{type Request, type Response}

type NewInvite {
  NewInvite(email: String, name: Option(String), role: Option(String))
}

fn invite_shape() -> input.Shape(NewInvite) {
  use email <- input.field(
    "email",
    input.required(input.email(staff.email_max)),
  )
  use name <- input.field("name", input.nullish(input.text(invites.name_max)))
  use role <- input.field(
    "role",
    input.nullish(input.required_text(staff.role_max)),
  )
  input.done(NewInvite(email:, name:, role:))
}

type InviteRefusal {
  AlreadyStaff
}

/// `POST /org/invites`
pub fn create(ctx: Ctx, req: Request, access: OrgAccess) -> Response {
  use <- access.require_lead(access)
  use body <- http.body(req, invite_shape(), [#("email", "EMAIL_INVALID")])
  case input.filled(body.name) {
    None -> http.required("NAME_REQUIRED", "name")
    Some(name) -> {
      let code = secrets.random_hex(18)
      let org = access.org
      let outcome =
        store.unit(ctx.store, fn(tx) {
          use existing <- result.try(staff.active_by_email(
            store.reading(tx),
            org.id,
            body.email,
          ))
          use <- refuse_if(existing != None, AlreadyStaff)
          use invite <- result.try(invites.create(
            tx,
            invites.NewInvite(
              org_id: org.id,
              email: body.email,
              name:,
              role: input.filled(body.role) |> option.unwrap("Scout"),
              token_hash: secrets.sha256_hex(code),
              invited_by: Some(access.user.name),
              at: clock.now_ms(),
            ),
          ))
          store.emit(
            tx,
            SendMail(
              to: body.email,
              subject: org.name <> " invited you to ScoutBox",
              text: "Hi "
                <> invite.name
                <> ",\n\n"
                <> access.user.name
                <> " invited you to join "
                <> org.name
                <> " on ScoutBox as "
                <> invite.role
                <> ".\n\nAccept with invite code: "
                <> code
                <> "\n\nThe code expires in 7 days.",
              secrets: [],
            ),
          )
          Ok(invite)
        })
      case outcome {
        Ok(invite) ->
          http.json(
            201,
            json.object([
              #("invite", invites.view(invite)),
              #(
                "note",
                json.string(
                  "The invite code went to their email (dev outbox in this environment).",
                ),
              ),
            ]),
          )
        Error(store.Refused(AlreadyStaff)) ->
          http.error_message(
            409,
            "ALREADY_STAFF",
            "Someone with this email is already on your staff.",
          )
        Error(failure) -> http.internal(failure)
      }
    }
  }
}

/// `GET /org/invites`: the organisation's invites, newest first by cursor.
pub fn page(ctx: Ctx, req: Request, access: OrgAccess) -> Response {
  use page <- pages.strict(req, [paging.IntKind])
  case store.read(ctx.store, invites.page(_, access.org.id, page)) {
    Ok(#(items, next)) -> pages.respond(items, next, invites.view)
    Error(failure) -> http.internal(failure)
  }
}

/// `POST /org/invites/:id/revoke`: a pending invite's code stops working; any other invite is answered as it is.
pub fn revoke(
  ctx: Ctx,
  req: Request,
  access: OrgAccess,
  invite_id: id.OrgInviteId,
) -> Response {
  use <- access.require_lead(access)
  use _ <- http.body(req, input.nothing(), [])
  let outcome =
    store.unit(ctx.store, fn(tx) {
      use found <- result.try(invites.by_id(store.reading(tx), invite_id))
      case found {
        Some(invite) if invite.org_id == access.org.id ->
          invites.revoke(tx, invite.id, clock.now_ms())
        _ -> store.refuse(http.error(404, "INVITE_NOT_FOUND"))
      }
    })
  case outcome {
    Ok(invite) ->
      http.json(200, json.object([#("invite", invites.view(invite))]))
    Error(store.Refused(response)) -> response
    Error(failure) -> http.internal(failure)
  }
}

/// `GET /org/onboarding`: the checklist with each task's live state, and help for the member's role.
pub fn onboarding_view(ctx: Ctx, access: OrgAccess) -> Response {
  case store.read(ctx.store, onboarding(_, access.org, access.user)) {
    Ok(body) -> http.json(200, body)
    Error(failure) -> http.internal(failure)
  }
}

fn refuse_if(
  condition: Bool,
  refusal: e,
  next: fn() -> Result(a, store.Fail(e)),
) -> Result(a, store.Fail(e)) {
  case condition {
    True -> store.refuse(refusal)
    False -> next()
  }
}

type Acceptance {
  Acceptance(token: Option(String), scout_name: Option(String))
}

fn accept_shape() -> input.Shape(Acceptance) {
  use token <- input.field("token", input.nullish(input.text(128)))
  use scout_name <- input.field(
    "scoutName",
    input.nullish(input.text(staff.name_max)),
  )
  input.done(Acceptance(token:, scout_name:))
}

type AcceptRefusal {
  StaffRefused(staff.StaffError)
  InviteRefused(invites.InviteError)
}

type Lookup {
  Invalid
  Unavailable
  Found(Invite, Org)
}

/// `POST /auth/org/accept-invite`. Staff sign in by name, so a name belongs to one account of the organisation
/// (removed ones included): the invited name's account is bound when current and restored when removed, with the
/// invite's role. Any other taken name is refused, and the refusal writes nothing.
pub fn accept(ctx: Ctx, req: Request) -> Response {
  use body <- http.body(req, accept_shape(), [])
  let now = clock.now_ms()
  let lookup =
    store.read(ctx.store, fn(read) {
      use invite <- result.try(case body.token {
        Some(token) -> invites.by_token_hash(read, secrets.sha256_hex(token))
        None -> Ok(None)
      })
      case invite {
        Some(invite) if invite.status == org_invites.Pending -> {
          use org <- result.map(orgs.by_id(read, invite.org_id))
          case org {
            Some(org) if !org.suspended -> Found(invite, org)
            _ -> Unavailable
          }
        }
        _ -> Ok(Invalid)
      }
    })
  case lookup {
    Error(failure) -> http.internal(failure)
    Ok(Invalid) -> http.error(404, "INVITE_INVALID")
    Ok(Found(invite, _)) if invite.expires_at < now -> {
      let _ = store.unit(ctx.store, fn(tx) { invites.expire(tx, invite.id) })
      http.error(410, "INVITE_EXPIRED")
    }
    Ok(Unavailable) -> http.error(403, "ORG_UNAVAILABLE")
    Ok(Found(invite, org)) -> accepting(ctx, invite, org, body, now)
  }
}

fn accepting(
  ctx: Ctx,
  invite: Invite,
  org: Org,
  body: Acceptance,
  now: Int,
) -> Response {
  let name = input.filled(body.scout_name) |> option.unwrap(invite.name)
  let outcome =
    store.unit(ctx.store, fn(tx) {
      use existing <- result.try(staff.by_org_and_name(
        store.reading(tx),
        org.id,
        invite.name,
      ))
      use #(user, restored) <- result.try(
        bind_account(tx, org, invite, existing, name, now)
        |> store.map_refusal(StaffRefused),
      )
      use _ <- result.try(
        invites.accept(tx, invite.id, user_id: user.id, at: now)
        |> store.map_refusal(InviteRefused),
      )
      use token <- result.try(sessions.create(
        tx,
        sessions.OrgStaff(org.id, user.id),
        now,
        ctx.config.session_ttl_ms,
      ))
      use onboarding <- result.try(onboarding(store.reading(tx), org, user))
      use setup <- result.try(orgs.setup(store.reading(tx), org.id))
      Ok(#(user, restored, token, onboarding, setup))
    })
  case outcome {
    Ok(#(user, restored, token, onboarding, setup)) ->
      http.json(
        201,
        json.object(
          list.flatten([
            [
              #("userId", id.org_user_json(user.id)),
              #("role", json.string(user.role)),
              #("org", json.object(orgs.view(org, setup))),
              #("token", json.string(token)),
            ],
            case restored {
              True -> [#("restored", json.bool(True))]
              False -> []
            },
            [#("onboarding", onboarding)],
          ]),
        ),
      )
    Error(store.Refused(StaffRefused(staff.NameTaken))) ->
      http.error_message(
        409,
        "STAFF_NAME_TAKEN",
        "Someone with this name is already on the staff — sign in with a different name (a middle initial, for example).",
      )
    Error(store.Refused(StaffRefused(staff.EmailTaken))) ->
      http.error_message(
        409,
        "ALREADY_STAFF",
        "Someone with this email is already on the staff.",
      )
    // Another acceptance of the same code committed first.
    Error(store.Refused(InviteRefused(invites.NotPending))) ->
      http.error(404, "INVITE_INVALID")
    Error(failure) -> http.internal(failure)
  }
}

/// The account the invitation lands on, and whether it was restored.
fn bind_account(
  tx: store.Tx,
  org: Org,
  invite: Invite,
  existing: Option(Staff),
  name: String,
  now: Int,
) -> Result(#(Staff, Bool), store.Fail(staff.StaffError)) {
  case existing {
    Some(removed) if removed.removed_at != None -> {
      // A restored account starts without its old authenticator (the person may no longer have it).
      use _ <- result.try(case staff.mfa(removed) {
        staff.NoMfa -> Ok(removed)
        _ -> staff.disable_mfa(tx, removed.id)
      })
      use user <- result.map(staff.restore(
        tx,
        removed.id,
        role: invite.role,
        email: Some(invite.email),
      ))
      #(user, True)
    }
    // The invite's e-mail is bound to the account: the basis for SSO linking.
    Some(current) ->
      staff.set_email(tx, current.id, Some(invite.email))
      |> result.map(fn(user) { #(user, False) })
    None ->
      staff.create(
        tx,
        staff.NewStaff(
          org_id: org.id,
          name:,
          role: invite.role,
          email: Some(invite.email),
          provenance: None,
          created_at: now,
        ),
      )
      |> result.map(fn(user) { #(user, False) })
  }
}

fn onboarding(
  read: store.Read,
  org: Org,
  user: Staff,
) -> Result(Json, store.Fail(e)) {
  use members <- result.try(staff.for_org(read, org.id, active_only: True))
  use imported <- result.try(imports.has_imported(read, org.id))
  use plans <- result.map(store.one(
    read,
    "SELECT COUNT(*) FROM coverage_plans WHERE org_id = ?",
    [id.org_sql(org.id)],
    decode.at([0], decode.int),
  ))
  let leads = list.filter(members, access.is_lead)
  let task = fn(id, label, done, help) {
    #(
      done,
      json.object([
        #("id", json.string(id)),
        #("label", json.string(label)),
        #("done", json.bool(done)),
        #("help", json.string(help)),
      ]),
    )
  }
  let tasks = [
    task(
      "verify_org",
      "Verify your organisation (company email domain)",
      org.verified,
      "Trust & Safety reviews verification — required before any under-18 visibility.",
    ),
    task(
      "safeguarding",
      "Sign the safeguarding contract",
      org.safeguarding_contract_signed,
      "Required for under-18 access. The club safeguarding officer signs.",
    ),
    task(
      "invite_staff",
      "Invite your staff",
      list.length(members) > 1,
      "Each person works under their own named account — no shared logins.",
    ),
    task(
      "mfa_leads",
      "Enable MFA for privileged accounts",
      list.all(leads, fn(u) {
        case staff.mfa(u) {
          staff.MfaEnabled(_) -> True
          _ -> False
        }
      }),
      "Leads approve signings and manage staff — protect those accounts first.",
    ),
    task(
      "first_import",
      "Import or add your player records",
      imported,
      "CSV import with dry-run preview, or add prospects by hand.",
    ),
    task(
      "coverage_plan",
      "Set up a coverage plan",
      plans != Ok(0),
      "Fixtures, assignments and observation tracking live under Coverage.",
    ),
  ]
  json.object([
    #("tasks", json.preprocessed_array(list.map(tasks, fn(t) { t.1 }))),
    #("complete", json.bool(list.all(tasks, fn(t) { t.0 }))),
    #(
      "roleHelp",
      json.string(case access.is_lead(user) {
        True ->
          "As a lead you approve signings, manage staff and see restricted cases."
        False ->
          "As a scout you file assessments and observations; a lead reviews decisions."
      }),
    ),
  ])
}
