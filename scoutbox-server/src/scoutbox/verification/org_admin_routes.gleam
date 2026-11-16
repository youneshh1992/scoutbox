//// An organisation's verification administration (domains/verification/claims/orgAdminRoutes.mjs): its official
//// domains, its verification administrators (root changes need two people), and conflict declarations.

import gleam/bool
import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx, SendMail}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/staff
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/ids
import scoutbox/platform/input
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/org_verified_domains as domain_row
import scoutbox/rows/ver_admins as admin_row
import scoutbox/rows/ver_claims as claim_row
import scoutbox/rows/ver_conflicts as conflict_row
import scoutbox/rows/ver_domain_request_codes as code_row
import scoutbox/rows/ver_domain_requests as request_row
import scoutbox/rows/ver_events as event_row
import scoutbox/rows/ver_root_transfers as transfer_row
import scoutbox/rows/ver_tokens as token_row
import scoutbox/verification/claims
import scoutbox/verification/conflicts
import scoutbox/verification/core.{act, reply, stop}
import scoutbox/verification/records
import scoutbox/vocab/actor_kind
import scoutbox/vocab/audience
import scoutbox/vocab/claim_type
import scoutbox/vocab/ver_code.{type VerCode}
import scoutbox/vocab/ver_level.{type VerLevel}
import scoutbox/vocab/verification_method
import sqlight
import wisp.{type Request, type Response}

// ------------------------------------------------------------------------------------------- domain requests

pub type DomainRequest =
  request_row.Row

pub fn domain_request(
  read: Read,
  id: String,
) -> Result(Option(DomainRequest), Fail(e)) {
  requests_where(read, "id = ?", [sqlight.text(id)])
  |> result.map(fn(rows) { list.first(rows) |> option.from_result })
}

fn requests_where(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(List(DomainRequest), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> request_row.columns
      <> " FROM ver_domain_requests WHERE "
      <> where
      <> " ORDER BY rowid",
    args,
    request_row.decoder(),
  )
}

pub fn awaiting_review(read: Read) -> Result(List(DomainRequest), Fail(e)) {
  requests_where(read, "status = 'requires_human_review'", [])
}

fn request_reasons(read: Read, id: String) -> Result(List(VerCode), Fail(e)) {
  store.query(
    read,
    "SELECT code FROM ver_domain_request_codes WHERE domain_request_id = ? AND list = 'review_reason' ORDER BY position",
    [sqlight.text(id)],
    decode.at([0], ver_code.decoder()),
  )
}

pub fn request_record(read: Read, r: DomainRequest) -> Result(Json, Fail(e)) {
  use reasons <- result.map(request_reasons(read, r.id))
  json.object([
    #("id", json.string(r.id)),
    #("orgId", json.string(r.org_id)),
    #("domain", json.string(r.domain)),
    #("requestedBy", json.string(r.requested_by)),
    #("status", json.string(request_row.status_to_string(r.status))),
    #(
      "method",
      json.nullable(r.method, fn(m) {
        json.string(request_row.method_to_string(m))
      }),
    ),
    #("createdAt", json.int(r.created_at)),
    #("decidedAt", json.nullable(r.decided_at, json.int)),
    #("decidedBy", json.nullable(r.decided_by_name, json.string)),
    #("decidedById", json.nullable(r.decided_by_id, json.string)),
    #(
      "reviewReasons",
      json.array(reasons, fn(c) { json.string(ver_code.to_string(c)) }),
    ),
  ])
}

/// Writes `r` back over the stored request, whose status must still be `from`.
pub fn update_request(
  tx: Tx,
  r: DomainRequest,
  from: request_row.Status,
) -> Result(Bool, Fail(e)) {
  let marks =
    list.map(request_row.values(r), fn(_) { "?" }) |> string.join(", ")
  store.write(
    tx,
    "UPDATE ver_domain_requests SET ("
      <> request_row.columns
      <> ") = ("
      <> marks
      <> ") WHERE id = ? AND status = ? RETURNING 1",
    list.append(request_row.values(r), [
      sqlight.text(r.id),
      sqlight.text(request_row.status_to_string(from)),
    ]),
    decode.success(Nil),
  )
  |> result.map(fn(rows) { rows != [] })
}

pub fn domain_record(d: domain_row.Row) -> Json {
  json.object([
    #("domain", json.string(d.domain)),
    #("status", json.string(domain_row.status_to_string(d.status))),
    #("method", json.string(domain_row.method_to_string(d.method))),
    #("verifiedAt", json.int(d.verified_at)),
    #("addedBy", json.string(d.added_by)),
  ])
}

pub fn admin_record(a: admin_row.Row) -> List(#(String, Json)) {
  [
    #("id", json.string(a.id)),
    #("orgId", json.string(a.org_id)),
    #("userId", json.string(a.user_id)),
    #("level", json.string(ver_level.to_string(a.level))),
    #("status", json.string(admin_row.status_to_string(a.status))),
    #("invitedBy", json.string(a.invited_by)),
    #("createdAt", json.int(a.created_at)),
    #("acceptedAt", json.nullable(a.accepted_at, json.int)),
    #("revokedAt", json.nullable(a.revoked_at, json.int)),
    #("revokedBy", json.nullable(a.revoked_by, json.string)),
  ]
}

fn transfer_record(t: transfer_row.Row) -> Json {
  json.object([
    #("id", json.string(t.id)),
    #("orgId", json.string(t.org_id)),
    #("toUserId", json.string(t.to_user_id)),
    #("proposedBy", json.string(t.proposed_by)),
    #("status", json.string(transfer_row.status_to_string(t.status))),
    #("createdAt", json.int(t.created_at)),
    #("approvedBy", json.nullable(t.approved_by, json.string)),
    #("approvedAt", json.nullable(t.approved_at, json.int)),
  ])
}

fn transfers_of(
  read: Read,
  org_id: String,
) -> Result(List(transfer_row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> transfer_row.columns
      <> " FROM ver_root_transfers WHERE org_id = ? ORDER BY rowid",
    [sqlight.text(org_id)],
    transfer_row.decoder(),
  )
}

// ------------------------------------------------------------------------------------------- guards

/// The permission check inside a unit: the refusal rolls it back.
fn guard(
  read: Read,
  access: OrgAccess,
  level: VerLevel,
  root: Bool,
  next: fn() -> core.Done,
) -> core.Done {
  use admins <- result.try(records.admins_of(read, access.org.id))
  case
    claims.has_ver_level(admins, access.org.id, access.user.id, level),
    root && access.user.mfa_enabled_at == None
  {
    False, _ -> stop(core.require_ver_refusal(level))
    True, True ->
      stop(http.error_message(
        403,
        "MFA_REQUIRED_FOR_ROOT_OPERATION",
        "Sensitive verification-authority operations require an account with MFA enabled (Organisation → Security).",
      ))
    True, False -> next()
  }
}

fn look_guard(
  read: Read,
  access: OrgAccess,
  level: VerLevel,
  next: fn() -> Result(Response, Fail(Response)),
) -> Result(Response, Fail(Response)) {
  use admins <- result.try(records.admins_of(read, access.org.id))
  case claims.has_ver_level(admins, access.org.id, access.user.id, level) {
    False -> Ok(core.require_ver_refusal(level))
    True -> next()
  }
}

// ------------------------------------------------------------------------------------------- domains

/// `GET /org/verification/domains`.
pub fn domains(ctx: Ctx, access: OrgAccess) -> Response {
  use read <- core.look(ctx)
  use <- look_guard(read, access, ver_level.VerificationViewer)
  use ds <- result.try(records.domains_of(read, access.org.id))
  use rs <- result.try(
    requests_where(read, "org_id = ?", [sqlight.text(access.org.id)]),
  )
  use rs <- result.map(list.try_map(rs, request_record(read, _)))
  http.json(
    200,
    json.object([
      #("domains", json.array(ds, domain_record)),
      #("requests", json.preprocessed_array(rs)),
    ]),
  )
}

/// `POST /org/verification/domains`: a new official domain. A first (root) or contested domain goes to Trust &
/// Safety; a subdomain of a verified one is proved by a mailbox on it.
pub fn add_domain(ctx: Ctx, req: Request, access: OrgAccess) -> Response {
  let shape = {
    use domain <- input.field("domain", input.nullish(input.text(253)))
    use email <- input.field("challengeEmail", input.nullish(input.text(254)))
    input.done(#(domain, email))
  }
  let parsed = http.parse_body(req, shape, [#("domain", "DOMAIN_INVALID")])
  let now = clock.now_ms()
  let actor = core.staff_actor(access, req)
  use tx <- act(ctx)
  let read = store.reading(tx)
  use <- guard(read, access, ver_level.VerificationAdmin, False)
  case parsed {
    Error(response) -> stop(response)
    Ok(#(domain, email)) -> {
      let domain = claims.normalize_domain(option.unwrap(domain, ""))
      let email = email |> option.unwrap("") |> string.trim |> string.lowercase
      use <- bool.lazy_guard(
        domain == ""
          || !string.contains(domain, ".")
          || input.utf16_length(domain) > 253,
        fn() { stop(http.error(400, "DOMAIN_INVALID")) },
      )
      use <- bool.lazy_guard(
        claims.is_free_mail(domain) || claims.is_disposable(domain),
        fn() {
          stop(http.error_message(
            422,
            "SHARED_PROVIDER_DOMAIN",
            "Free/shared email providers cannot be organisation domains.",
          ))
        },
      )
      use mine <- result.try(core.verified_domains_of(read, access.org.id))
      use <- bool.lazy_guard(list.contains(mine, domain), fn() {
        stop(http.error(409, "DOMAIN_EXISTS"))
      })
      use other <- result.try(records.domain_verified_elsewhere(
        read,
        domain,
        Some(access.org.id),
      ))
      let root = list.find(mine, fn(d) { claims.domain_covered(domain, d) })
      let high_risk = result.is_error(root) || other != None
      let reasons =
        list.flatten([
          case other {
            Some(_) -> [ver_code.DomainOwnershipAmbiguous]
            None -> []
          },
          case root {
            Error(Nil) -> [ver_code.HighRiskAdminChange]
            Ok(_) -> []
          },
        ])
      let challenge_ok =
        !high_risk
        && claims.email_problem(email) == None
        && claims.domain_of_email(email) == domain
      let #(status, reasons) = case high_risk, challenge_ok {
        True, _ -> #(request_row.RequiresHumanReview, reasons)
        False, True -> #(request_row.EmailChallenge, reasons)
        False, False -> #(
          request_row.RequiresHumanReview,
          list.append(
            reasons,
            case list.contains(reasons, ver_code.DomainOwnershipAmbiguous) {
              True -> []
              False -> [ver_code.DomainOwnershipAmbiguous]
            },
          ),
        )
      }
      use id <- result.try(ids.next(tx, "vdom"))
      let r =
        request_row.Row(
          id:,
          org_id: access.org.id,
          domain:,
          requested_by: access.user.id,
          status:,
          method: None,
          created_at: now,
          decided_at: None,
          decided_by_name: None,
          decided_by_id: None,
        )
      use _ <- result.try(store.run(
        tx,
        request_row.insert_sql,
        request_row.values(r),
      ))
      use _ <- result.try(
        reasons
        |> list.index_map(fn(c, i) { #(c, i) })
        |> list.try_each(fn(p) {
          store.run(
            tx,
            code_row.insert_sql,
            code_row.values(
              code_row.Row(
                domain_request_id: id,
                list: code_row.ReviewReason,
                position: p.1,
                code: case code_row.code_from_string(ver_code.to_string(p.0)) {
                  Ok(c) -> c
                  Error(Nil) ->
                    panic as "a domain request's reasons are review reasons"
                },
              ),
            ),
          )
        }),
      )
      use _ <- result.try(core.event(
        tx,
        event_row.OrganisationDomainAdded,
        actor,
        core.About(
          ..core.nothing,
          org_id: Some(access.org.id),
          detail: records.detail([], [
            #("domain", Some(domain)),
            #(
              "status",
              Some(case high_risk {
                True -> "requires_human_review"
                False -> "email_challenge"
              }),
            ),
          ]),
        ),
        now,
      ))
      use effects <- result.try(case challenge_ok {
        False -> Ok([])
        True -> {
          use secret <- result.map(core.mint_token(
            tx,
            token_row.DomainEmail,
            Some(email),
            None,
            None,
            Some(access.org.id),
            Some(id),
            core.work_email_ttl_ms,
            now,
          ))
          [
            SendMail(
              to: email,
              subject: "Confirm "
                <> domain
                <> " for "
                <> access.org.name
                <> " on ScoutBox",
              text: "Confirmation code for adding "
                <> domain
                <> " as an official "
                <> access.org.name
                <> " domain: "
                <> secret
                <> "\n\nSingle use, expires in 30 minutes.",
            ),
          ]
        }
      })
      use record <- result.try(request_record(read, r))
      Ok(#(
        http.json(
          201,
          json.object([
            #("request", record),
            #(
              "note",
              json.string(case status {
                request_row.RequiresHumanReview ->
                  "Root or contested domain changes are reviewed by Trust & Safety before they take effect."
                _ -> "A confirmation code went to the mailbox on that domain."
              }),
            ),
          ]),
        ),
        effects,
      ))
    }
  }
}

/// `POST /org/verification/domains/:id/confirm`: the code from the domain's mailbox.
pub fn confirm_domain(
  ctx: Ctx,
  req: Request,
  access: OrgAccess,
  id: String,
) -> Response {
  let shape = {
    use code <- input.field("code", input.nullish(input.text(64)))
    input.done(code)
  }
  let parsed = http.parse_body(req, shape, [])
  let now = clock.now_ms()
  let actor = core.staff_actor(access, req)
  use tx <- act(ctx)
  let read = store.reading(tx)
  use <- guard(read, access, ver_level.VerificationAdmin, False)
  use found <- result.try(domain_request(read, id))
  case found {
    Some(r) if r.org_id == access.org.id ->
      case r.status, parsed {
        request_row.EmailChallenge, Error(response) -> stop(response)
        request_row.EmailChallenge, Ok(code) -> {
          use peek <- result.try(core.peek_token(
            read,
            token_row.DomainEmail,
            code,
            None,
            None,
            now,
          ))
          let own = Some(r.id)
          case peek {
            Error(code) -> reply(http.error(401, code))
            Ok(t) if t.ref_id != own -> {
              // A valid code for another request is spent.
              use _ <- result.try(records.use_token(tx, t.id, now))
              reply(http.error(401, "TOKEN_WRONG_PURPOSE"))
            }
            Ok(t) -> {
              use _ <- result.try(records.use_token(tx, t.id, now))
              use _ <- result.try(update_request(
                tx,
                request_row.Row(
                  ..r,
                  status: request_row.Verified,
                  method: Some(request_row.OfficialDomainEmail),
                  decided_at: Some(now),
                ),
                request_row.EmailChallenge,
              ))
              use mine <- result.try(core.verified_domains_of(
                read,
                access.org.id,
              ))
              use _ <- result.try(case list.contains(mine, r.domain) {
                True -> Ok(Nil)
                False ->
                  records.add_domain(
                    tx,
                    records.verified_domain(
                      access.org.id,
                      r.domain,
                      records.DomainByEmail,
                      now,
                      access.user.id,
                    ),
                  )
              })
              use _ <- result.try(core.create_claim(
                tx,
                fn(claim_id) {
                  claim_row.Row(
                    ..core.blank_claim(
                      claim_id,
                      claim_row.Org,
                      access.org.id,
                      claim_type.OrganisationDomain,
                      now,
                    ),
                    organisation_id: Some(access.org.id),
                    status: claim_row.Verified,
                    verification_method: Some(
                      verification_method.OfficialDomainEmail,
                    ),
                    verified_at: Some(now),
                    verified_by_kind: Some(actor_kind.OrgAdmin),
                    verified_by_id: Some(access.user.id),
                    domain: Some(r.domain),
                  )
                },
                actor,
                now,
              ))
              use _ <- result.try(core.event(
                tx,
                event_row.OrganisationDomainVerified,
                actor,
                core.About(
                  ..core.nothing,
                  org_id: Some(access.org.id),
                  detail: records.detail([], [#("domain", Some(r.domain))]),
                ),
                now,
              ))
              reply(http.json(
                200,
                json.object([
                  #("domain", json.string(r.domain)),
                  #("status", json.string("verified")),
                ]),
              ))
            }
          }
        }
        _, _ -> stop(http.error(409, "NOT_IN_EMAIL_CHALLENGE"))
      }
    _ -> stop(http.error(404, "DOMAIN_REQUEST_NOT_FOUND"))
  }
}

// ------------------------------------------------------------------------------------------- administrators

/// `GET /org/verification/admins`.
pub fn admins(ctx: Ctx, access: OrgAccess) -> Response {
  use read <- core.look(ctx)
  use <- look_guard(read, access, ver_level.VerificationViewer)
  use grants <- result.try(records.admins_of(read, access.org.id))
  use items <- result.try(
    list.try_map(grants, fn(a) {
      use u <- result.map(staff.by_id(read, a.user_id))
      json.object(
        list.append(admin_record(a), [
          #(
            "person",
            json.object([
              #("id", json.string(a.user_id)),
              #(
                "name",
                json.string(
                  option.map(u, fn(u) { u.name }) |> option.unwrap("(removed)"),
                ),
              ),
            ]),
          ),
        ]),
      )
    }),
  )
  use transfers <- result.map(transfers_of(read, access.org.id))
  http.json(
    200,
    json.object([
      #("items", json.preprocessed_array(items)),
      #("transfers", json.array(transfers, transfer_record)),
    ]),
  )
}

/// `POST /org/verification/admins`: a grant. Root authority needs a second approval.
pub fn grant(ctx: Ctx, req: Request, access: OrgAccess) -> Response {
  let shape = {
    use user_id <- input.field("userId", input.required(input.id()))
    use level <- input.field(
      "level",
      input.required(input.one_of(ver_level.pairs)),
    )
    input.done(#(user_id, level))
  }
  use #(user_id, level) <- http.body(req, shape, [#("level", "LEVEL_UNKNOWN")])
  let now = clock.now_ms()
  let actor = core.staff_actor(access, req)
  let needs_root =
    level == ver_level.VerificationAdmin
    || level == ver_level.VerificationRootAdmin
  use tx <- act(ctx)
  let read = store.reading(tx)
  use <- guard(
    read,
    access,
    case needs_root {
      True -> ver_level.VerificationRootAdmin
      False -> ver_level.VerificationAdmin
    },
    needs_root,
  )
  case user_id == access.user.id {
    True -> {
      use _ <- result.try(core.event(
        tx,
        event_row.SecuritySelfVerificationBlocked,
        actor,
        core.About(
          ..core.nothing,
          org_id: Some(access.org.id),
          subject_id: Some(user_id),
          reason: Some("self-promotion attempt"),
        ),
        now,
      ))
      reply(http.error_message(
        403,
        "SELF_PROMOTION_FORBIDDEN",
        "You cannot change your own verification authority.",
      ))
    }
    False -> {
      use target <- result.try(staff.by_id(read, user_id))
      case target {
        Some(u) if u.org_id == access.org.id && u.removed_at == None ->
          case level {
            ver_level.VerificationRootAdmin -> {
              use transfers <- result.try(transfers_of(read, access.org.id))
              use <- bool.lazy_guard(
                list.any(transfers, fn(t) { t.status == transfer_row.Pending }),
                fn() { stop(http.error(409, "TRANSFER_ALREADY_PENDING")) },
              )
              use id <- result.try(ids.next(tx, "vrtx"))
              let t =
                transfer_row.Row(
                  id:,
                  org_id: access.org.id,
                  to_user_id: user_id,
                  proposed_by: access.user.id,
                  status: transfer_row.Pending,
                  created_at: now,
                  approved_by: None,
                  approved_at: None,
                )
              use _ <- result.try(store.run(
                tx,
                transfer_row.insert_sql,
                transfer_row.values(t),
              ))
              use _ <- result.try(core.event(
                tx,
                event_row.AdminInvited,
                actor,
                core.About(
                  ..core.nothing,
                  org_id: Some(access.org.id),
                  subject_id: Some(user_id),
                  detail: records.detail([], [
                    #("level", Some(ver_level.to_string(level))),
                    #("dualControl", Some("pending")),
                  ]),
                ),
                now,
              ))
              reply(http.json(
                202,
                json.object([
                  #("transfer", transfer_record(t)),
                  #(
                    "note",
                    json.string(
                      "Root authority changes need a second approval: another root administrator, or Trust & Safety.",
                    ),
                  ),
                ]),
              ))
            }
            _ -> {
              use grants <- result.try(records.active_admins_of(
                read,
                access.org.id,
              ))
              use <- bool.lazy_guard(
                list.any(grants, fn(a) {
                  a.user_id == user_id && a.level == level
                }),
                fn() { stop(http.error(409, "ALREADY_GRANTED")) },
              )
              use id <- result.try(ids.next(tx, "vadm"))
              use a <- result.try(records.create_admin(
                tx,
                admin_row.Row(
                  id:,
                  org_id: access.org.id,
                  user_id:,
                  level:,
                  status: admin_row.Active,
                  invited_by: access.user.id,
                  created_at: now,
                  accepted_at: Some(now),
                  revoked_at: None,
                  revoked_by: None,
                ),
              ))
              use _ <- result.try(core.event(
                tx,
                event_row.AdminAccepted,
                actor,
                core.About(
                  ..core.nothing,
                  org_id: Some(access.org.id),
                  subject_id: Some(user_id),
                  detail: records.detail([], [
                    #("level", Some(ver_level.to_string(level))),
                  ]),
                ),
                now,
              ))
              use _ <- result.try(notifications.notify(
                tx,
                to: audience.OrgUser,
                id: user_id,
                type_: "verification",
                text: "You now hold "
                  <> string.replace(ver_level.to_string(level), "_", " ")
                  <> " authority for "
                  <> access.org.name
                  <> ".",
                ref_id: Some(a.id),
                at: now,
              ))
              reply(http.json(
                201,
                json.object([#("admin", json.object(admin_record(a)))]),
              ))
            }
          }
        _ -> stop(http.error(404, "USER_NOT_FOUND"))
      }
    }
  }
}

/// `POST /org/verification/root-transfers/:id/approve`: the second person of a root change.
pub fn approve_transfer(
  ctx: Ctx,
  req: Request,
  access: OrgAccess,
  id: String,
) -> Response {
  let now = clock.now_ms()
  let actor = core.staff_actor(access, req)
  use tx <- act(ctx)
  let read = store.reading(tx)
  use <- guard(read, access, ver_level.VerificationRootAdmin, True)
  use transfers <- result.try(transfers_of(read, access.org.id))
  case list.find(transfers, fn(t) { t.id == id }) {
    Error(Nil) -> stop(http.error(404, "TRANSFER_NOT_FOUND"))
    Ok(t) if t.status != transfer_row.Pending ->
      stop(http.error(409, "TRANSFER_NOT_PENDING"))
    Ok(t) if t.proposed_by == access.user.id ->
      stop(http.error_message(
        403,
        "DUAL_CONTROL_REQUIRED",
        "The approver must be a different root administrator than the proposer.",
      ))
    Ok(t) if t.to_user_id == access.user.id ->
      stop(http.error_message(
        403,
        "SELF_PROMOTION_FORBIDDEN",
        "The beneficiary cannot approve their own root authority.",
      ))
    Ok(t) -> {
      let approved =
        transfer_row.Row(
          ..t,
          status: transfer_row.Approved,
          approved_by: Some(access.user.id),
          approved_at: Some(now),
        )
      use _ <- result.try(
        store.run(
          tx,
          "UPDATE ver_root_transfers SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ? AND status = 'pending'",
          [sqlight.text(access.user.id), sqlight.int(now), sqlight.text(t.id)],
        ),
      )
      use grants <- result.try(records.active_admins_of(read, access.org.id))
      use grant <- result.try(
        case
          list.find(grants, fn(a) {
            a.user_id == t.to_user_id
            && a.level == ver_level.VerificationRootAdmin
          })
        {
          Ok(held) -> Ok(held)
          Error(Nil) -> {
            use admin_id <- result.try(ids.next(tx, "vadm"))
            records.create_admin(
              tx,
              admin_row.Row(
                id: admin_id,
                org_id: access.org.id,
                user_id: t.to_user_id,
                level: ver_level.VerificationRootAdmin,
                status: admin_row.Active,
                invited_by: t.proposed_by,
                created_at: now,
                accepted_at: Some(now),
                revoked_at: None,
                revoked_by: None,
              ),
            )
          }
        },
      )
      use _ <- result.try(core.event(
        tx,
        event_row.AdminAccepted,
        actor,
        core.About(
          ..core.nothing,
          org_id: Some(access.org.id),
          subject_id: Some(t.to_user_id),
          detail: records.detail([], [
            #("level", Some("verification_root_admin")),
            #("dualControl", Some("approved by " <> access.user.id)),
          ]),
        ),
        now,
      ))
      reply(http.json(
        200,
        json.object([
          #("transfer", transfer_record(approved)),
          #("admin", json.object(admin_record(grant))),
        ]),
      ))
    }
  }
}

/// `POST /org/verification/admins/:id/revoke`: authority ends at once; what the person approved keeps its
/// provenance. An organisation cannot remove its last root administrator itself.
pub fn revoke(
  ctx: Ctx,
  req: Request,
  access: OrgAccess,
  id: String,
) -> Response {
  let shape = {
    use reason <- input.field("reason", input.nullish(input.text(600)))
    input.done(reason)
  }
  let parsed = http.parse_body(req, shape, [])
  let now = clock.now_ms()
  let actor = core.staff_actor(access, req)
  use tx <- act(ctx)
  let read = store.reading(tx)
  use found <- result.try(records.admin(read, id))
  case found {
    Some(a) if a.org_id == access.org.id -> {
      let root = a.level == ver_level.VerificationRootAdmin
      use <- guard(
        read,
        access,
        case root {
          True -> ver_level.VerificationRootAdmin
          False -> ver_level.VerificationAdmin
        },
        root,
      )
      use <- bool.lazy_guard(a.user_id == access.user.id, fn() {
        stop(http.error_message(
          403,
          "SELF_REVOKE_FORBIDDEN",
          "Another administrator (or Trust & Safety) must change your authority.",
        ))
      })
      use <- bool.lazy_guard(a.status != admin_row.Active, fn() {
        stop(http.error(409, "ALREADY_REVOKED"))
      })
      case parsed {
        Error(response) -> stop(response)
        Ok(reason) -> {
          use grants <- result.try(records.active_admins_of(read, access.org.id))
          use <- bool.lazy_guard(
            root
              && list.count(grants, fn(g) {
              g.level == ver_level.VerificationRootAdmin
            })
              <= 1,
            fn() {
              stop(http.error_message(
                409,
                "LAST_ROOT_ADMIN",
                "An organisation cannot remove its final root administrator itself — Trust & Safety handles root recovery so the organisation is never orphaned.",
              ))
            },
          )
          use _ <- result.try(records.revoke_admin(
            tx,
            a.id,
            now,
            access.user.id,
          ))
          use _ <- result.try(core.event(
            tx,
            event_row.AdminRevoked,
            actor,
            core.About(
              ..core.nothing,
              org_id: Some(access.org.id),
              subject_id: Some(a.user_id),
              reason: Some(option.unwrap(
                input.filled(reason),
                "revoked by organisation",
              )),
            ),
            now,
          ))
          use after <- result.try(records.admin(read, a.id))
          let assert Some(after) = after as "a revoked grant exists"
          reply(http.json(
            200,
            json.object([
              #("admin", json.object(admin_record(after))),
              #(
                "note",
                json.string(
                  "Authority ends immediately. Claims this person previously approved keep their provenance and can be reviewed (Trust & Safety cascade tools).",
                ),
              ),
            ]),
          ))
        }
      }
    }
    _ -> stop(http.error(404, "ADMIN_NOT_FOUND"))
  }
}

// ------------------------------------------------------------------------------------------- conflicts

/// `POST /org/verification/conflicts`: an explicit declaration, visible to the organisation's verification
/// administrators and Trust & Safety, never inferred and never public.
pub fn declare(ctx: Ctx, req: Request, access: OrgAccess) -> Response {
  let shape = {
    use kind <- input.field(
      "kind",
      input.required(input.one_of(conflict_row.kind_pairs)),
    )
    use subject <- input.field("subject", input.nullish(input.text(120)))
    use note <- input.field("note", input.nullish(input.text(400)))
    input.done(#(kind, subject, note))
  }
  use #(kind, subject, note) <- http.body(req, shape, [
    #("kind", "KIND_UNKNOWN"),
  ])
  let now = clock.now_ms()
  use tx <- act(ctx)
  use id <- result.try(ids.next(tx, "vcoi"))
  let c =
    conflict_row.Row(
      id:,
      user_id: access.user.id,
      org_id: access.org.id,
      kind:,
      subject: option.unwrap(subject, ""),
      note: option.unwrap(note, ""),
      created_at: now,
      withdrawn_at: None,
    )
  use _ <- result.try(conflicts.create(tx, c))
  reply(http.json(
    201,
    json.object([
      #("conflict", conflicts.record(c)),
      #(
        "note",
        json.string(
          "Declarations are explicit and visible to your organisation’s verification administrators and Trust & Safety — never inferred, never public.",
        ),
      ),
    ]),
  ))
}

/// `GET /org/verification/conflicts`: all of the organisation's for a reviewer, else one's own.
pub fn list_conflicts(ctx: Ctx, access: OrgAccess) -> Response {
  use read <- core.look(ctx)
  use admins <- result.try(records.admins_of(read, access.org.id))
  use items <- result.map(
    case
      claims.has_ver_level(
        admins,
        access.org.id,
        access.user.id,
        ver_level.VerificationReviewer,
      )
    {
      True -> conflicts.for_org(read, access.org.id)
      False -> conflicts.for_org_user(read, access.org.id, access.user.id)
    },
  )
  http.json(200, json.object([#("items", json.array(items, conflicts.record))]))
}

/// `POST /org/verification/conflicts/:id/withdraw`.
pub fn withdraw_conflict(ctx: Ctx, access: OrgAccess, id: String) -> Response {
  let now = clock.now_ms()
  use tx <- act(ctx)
  use found <- result.try(conflicts.by_id(store.reading(tx), id))
  case found {
    Some(c) if c.org_id == access.org.id && c.user_id == access.user.id ->
      case c.withdrawn_at {
        Some(_) -> stop(http.error(409, "ALREADY_WITHDRAWN"))
        None -> {
          use _ <- result.try(conflicts.withdraw(tx, c.id, now))
          reply(http.json(
            200,
            json.object([
              #(
                "conflict",
                conflicts.record(conflict_row.Row(..c, withdrawn_at: Some(now))),
              ),
            ]),
          ))
        }
      }
    _ -> stop(http.error(404, "CONFLICT_NOT_FOUND"))
  }
}
