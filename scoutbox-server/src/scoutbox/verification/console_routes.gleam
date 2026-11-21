//// The club's Verification console (domains/verification/claims/consoleRoutes.mjs): the dashboard, the prepared
//// requests and their decisions, the staff register and departures. An administrator decides other people's
//// claims, never their own.

import gleam/bool
import gleam/dict
import gleam/dynamic/decode
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/staff
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/platform/temporal
import scoutbox/rows/id
import scoutbox/rows/ver_claims as claim_row
import scoutbox/rows/ver_events as event_row
import scoutbox/safety/ledger
import scoutbox/verification/claims.{type Claim}
import scoutbox/verification/core.{act, reply, stop}
import scoutbox/verification/records
import scoutbox/vocab/audience
import scoutbox/vocab/claim_type
import scoutbox/vocab/ver_code
import scoutbox/vocab/ver_level
import scoutbox/vocab/verification_method
import wisp.{type Request, type Response}

const day_ms = 86_400_000

fn awaiting(c: Claim) -> Bool {
  c.status == claim_row.Pending || c.status == claim_row.AutomatedChecksPassed
}

/// `GET /org/verification/dashboard`. A raw `verified` does not count when the organisation's standing, the
/// account's removal or an expiry suppresses it.
pub fn dashboard(ctx: Ctx, access: OrgAccess) -> Response {
  let now = clock.now_ms()
  use read <- core.look(ctx)
  use <- guard(read, access, ver_level.VerificationViewer)
  use theirs <- result.try(records.staff_claims(read, access.org.id))
  use removed <- result.try(removed_users(read, theirs))
  use status <- result.try(core.org_status(read, Some(access.org)))
  use disputed <- result.try(store.one(
    read,
    "SELECT COUNT(*) FROM ver_disputes d JOIN ver_claims c ON c.id = d.claim_id WHERE d.status = 'open' AND c.organisation_id = ? AND c.subject_kind = 'user'",
    [id.org_sql(access.org.id)],
    decode.at([0], decode.int),
  ))
  use domains <- result.try(records.domains_of(read, access.org.id))
  use admins <- result.map(records.active_admins_of(read, access.org.id))
  let verified_staff =
    theirs
    |> list.filter(fn(c) {
      claims.effective_status(
        c,
        org: Some(access.org),
        subject_removed: dict.get(removed, c.subject_id) |> result.unwrap(True),
        now:,
      ).current
    })
    |> list.map(fn(c) { c.subject_id })
    |> list.unique
    |> list.length
  let count = fn(p) { json.int(list.count(theirs, p)) }
  http.json(
    200,
    json.object([
      #("organisationStatus", json.string(claims.org_status_code(status))),
      #(
        "counts",
        json.object([
          #("verifiedStaff", json.int(verified_staff)),
          #("pending", count(awaiting)),
          #(
            "humanReview",
            count(fn(c) { c.status == claim_row.RequiresHumanReview }),
          ),
          #(
            "expiringSoon",
            count(fn(c) {
              case c.status, c.valid_until {
                claim_row.Verified, Some(u) if u != 0 ->
                  u > now && u < now + 30 * day_ms
                _, _ -> False
              }
            }),
          ),
          #("disputed", json.int(result.unwrap(disputed, 0))),
          #("revoked", count(fn(c) { c.status == claim_row.Revoked })),
          #("domains", json.int(list.length(domains))),
          #("administrators", json.int(list.length(admins))),
        ]),
      ),
    ]),
  )
}

/// Each claim subject: whether their account is gone (removed, or never there).
fn removed_users(
  read: Read,
  theirs: List(Claim),
) -> Result(dict.Dict(String, Bool), Fail(e)) {
  theirs
  |> list.map(fn(c) { c.subject_id })
  |> list.unique
  |> list.try_map(fn(subject) {
    // `subject_id` is polymorphic text; these are users' claims.
    use u <- result.map(staff.by_id(read, id.org_user(subject)))
    #(subject, case u {
      Some(u) -> u.removed_at != None
      None -> True
    })
  })
  |> result.map(dict.from_list)
}

fn guard(
  read: Read,
  access: OrgAccess,
  level: ver_level.VerLevel,
  next: fn() -> Result(Response, Fail(Response)),
) -> Result(Response, Fail(Response)) {
  use admins <- result.try(records.admins_of(read, access.org.id))
  case claims.has_ver_level(admins, access.org.id, access.user.id, level) {
    True -> next()
    False -> Ok(core.require_ver_refusal(level))
  }
}

fn request_row(read: Read, claim: Claim) -> Result(json.Json, Fail(e)) {
  // `subject_id` is polymorphic text; a request's claim is about a user.
  use user <- result.try(staff.by_id(read, id.org_user(claim.subject_id)))
  use theirs <- result.try(records.claims_for(
    read,
    claim_row.User,
    claim.subject_id,
  ))
  use flags <- result.map(records.codes(read, claim.id, records.RiskFlags))
  let identity =
    list.find(theirs, fn(c) { c.claim_type == claim_type.PersonIdentity })
  json.object([
    #("claimId", id.claim_json(claim.id)),
    #("claimType", claim_type.to_json(claim.claim_type)),
    #("pairId", json.nullable(claim.pair_id, json.string)),
    #(
      "person",
      json.object(case user {
        Some(u) -> [
          #("id", id.org_user_json(u.id)),
          #("name", json.string(u.name)),
          #("email", json.nullable(u.email, json.string)),
          #("accountCreatedAt", json.int(u.created_at)),
          #("removed", json.bool(u.removed_at != None)),
        ]
        None -> [
          #("email", json.null()),
          #("accountCreatedAt", json.null()),
          #("removed", json.bool(False)),
        ]
      }),
    ),
    #("claimedRole", json.nullable(claim.role, json.string)),
    #("requestedStart", json.nullable(claim.requested_start, json.int)),
    #(
      "identityStatus",
      json.string(case identity {
        Ok(c) -> claim_row.status_to_string(c.status)
        Error(Nil) -> "unverified"
      }),
    ),
    #(
      "emailStatus",
      json.string(case claim.domain_control, claim.domain_covered_by_org {
        Some(claim_row.Passed), Some(True) -> "work_email_on_verified_domain"
        Some(claim_row.Passed), _ -> "work_email_on_other_domain"
        None, _ -> "not_proved"
      }),
    ),
    #("riskFlags", json.array(flags, ver_code.to_json)),
    #("status", claim_row.status_to_json(claim.status)),
    #("requestedAt", json.int(claim.created_at)),
    #(
      "priorClaims",
      json.array(
        list.filter(theirs, fn(c) {
          c.id != claim.id && c.status == claim_row.Verified
        }),
        fn(c) {
          json.object([
            #("claimType", claim_type.to_json(c.claim_type)),
            #("organisationId", json.nullable(c.organisation_id, id.org_json)),
            #("role", json.nullable(c.role, json.string)),
            #("current", json.bool(c.current)),
          ])
        },
      ),
    ),
  ])
}

/// `GET /org/verification/requests`: the prepared cases awaiting a decision.
pub fn requests(ctx: Ctx, access: OrgAccess) -> Response {
  use read <- core.look(ctx)
  use <- guard(read, access, ver_level.VerificationViewer)
  use theirs <- result.try(records.staff_claims(read, access.org.id))
  use rows <- result.map(
    list.try_map(list.filter(theirs, awaiting), request_row(read, _)),
  )
  http.json(
    200,
    json.object([
      #("items", json.preprocessed_array(rows)),
      #(
        "note",
        json.string(
          "Decisions are audited. You cannot decide your own request.",
        ),
      ),
    ]),
  )
}

type Decision {
  Confirm
  CorrectRole
  MarkFormer
  Reject
  RequestInfo
}

const decisions = [
  #("confirm", Confirm),
  #("correct_role", CorrectRole),
  #("mark_former", MarkFormer),
  #("reject", Reject),
  #("request_info", RequestInfo),
]

type Body {
  Body(
    action: Decision,
    role: Option(String),
    valid_from: Option(temporal.Due),
    valid_until: Option(temporal.Due),
    reason: Option(String),
  )
}

fn action_text(d: Decision) -> String {
  let assert Ok(#(text, _)) = list.find(decisions, fn(p) { p.1 == d })
  text
}

/// `POST /org/verification/requests/:claimId/decide`: confirm, correct the role, mark as former, reject or ask
/// for more. Every claim of the pair moves or none does.
pub fn decide(
  ctx: Ctx,
  req: Request,
  access: OrgAccess,
  claim_id: id.ClaimId,
) -> Response {
  let now = clock.now_ms()
  let actor = core.staff_actor(access, req)
  let shape = {
    use action <- input.field("action", input.required(input.one_of(decisions)))
    use role <- input.field("role", input.nullish(input.text(60)))
    use valid_from <- input.field("validFrom", input.optional(input.due_date()))
    use valid_until <- input.field(
      "validUntil",
      input.optional(input.due_date()),
    )
    use reason <- input.field("reason", input.nullish(input.text(600)))
    input.done(Body(
      action:,
      role:,
      valid_from: option.flatten(valid_from),
      valid_until: option.flatten(valid_until),
      reason:,
    ))
  }
  // Read before the unit (which runs elsewhere), answered in the TypeScript server's order.
  let parsed = http.parse_body(req, shape, [#("action", "ACTION_UNKNOWN")])
  use tx <- act(ctx)
  let read = store.reading(tx)
  use admins <- result.try(records.admins_of(read, access.org.id))
  use <- bool.lazy_guard(
    !claims.has_ver_level(
      admins,
      access.org.id,
      access.user.id,
      ver_level.VerificationReviewer,
    ),
    fn() { stop(core.require_ver_refusal(ver_level.VerificationReviewer)) },
  )
  use found <- result.try(records.claim(read, claim_id))
  let ours = Some(access.org.id)
  case found {
    Some(claim)
      if claim.organisation_id == ours && claim.subject_kind == claim_row.User
    -> {
      use <- self_check(tx, claim, access, actor, now)
      use <- bool.lazy_guard(!awaiting(claim), fn() {
        stop(http.error_message(
          409,
          "CLAIM_NOT_DECIDABLE",
          "The request is "
            <> claim_row.status_to_string(claim.status)
            <> " — it may already be decided, withdrawn or escalated.",
        ))
      })
      use status <- result.try(core.org_status(read, Some(access.org)))
      use <- bool.lazy_guard(status != claims.OrgVerified, fn() {
        stop(http.error_message(
          403,
          "ORG_NOT_ELIGIBLE",
          "This organisation is "
            <> claims.org_status_code(status)
            <> " and cannot confirm staff verification right now.",
        ))
      })
      case parsed {
        Error(response) -> stop(response)
        Ok(body) -> deciding(tx, access, actor, claim, body, now)
      }
    }
    _ -> stop(http.error(404, "CLAIM_NOT_FOUND"))
  }
}

/// Nobody is the authoritative confirmer of their own claim; the attempt is recorded.
fn self_check(
  tx: Tx,
  claim: Claim,
  access: OrgAccess,
  actor: core.Actor,
  now: Int,
  next: fn() -> core.Done,
) -> core.Done {
  case claim.subject_id == id.org_user_to_string(access.user.id) {
    False -> next()
    True -> {
      use _ <- result.try(core.event(
        tx,
        event_row.SecuritySelfVerificationBlocked,
        actor,
        core.About(
          ..core.claim_about(claim),
          org_id: Some(access.org.id),
          reason: Some("reviewer attempted to decide own claim"),
        ),
        now,
      ))
      reply(http.error_message(
        403,
        "SELF_VERIFICATION_FORBIDDEN",
        "You cannot be the authoritative confirmer of your own claim. Another authorised administrator must decide it.",
      ))
    }
  }
}

fn deciding(
  tx: Tx,
  access: OrgAccess,
  actor: core.Actor,
  claim: Claim,
  body: Body,
  now: Int,
) -> core.Done {
  let read = store.reading(tx)
  let role = input.filled(body.role)
  let reason = input.filled(body.reason)
  use pair <- result.try(case claim.pair_id {
    Some(pair_id) ->
      records.claims_by_pair(read, pair_id)
      |> result.map(list.filter(_, awaiting))
    None -> Ok([])
  })
  let targets = case pair {
    [] -> [claim]
    _ -> pair
  }
  // The decision, its notice to the person and its ledger row commit together.
  let announce = fn(text) {
    use _ <- result.try(notifications.notify(
      tx,
      to: audience.OrgUser,
      id: claim.subject_id,
      type_: "verification",
      text:,
      ref_id: Some(id.claim_to_string(claim.id)),
      at: now,
    ))
    ledger.append(
      tx,
      ledger.Entry(
        event: ledger.VerificationDecision(claim.id, action_text(body.action)),
        player_id: None,
        org_id: Some(access.org.id),
        org_name: None,
        user_id: None,
        actor_name: Some(access.user.name),
      ),
      now,
    )
    |> result.replace(Nil)
  }
  let decide = fn(to, text, set: fn(Claim) -> Claim) {
    use _ <- result.try(
      list.try_each(targets, fn(c) {
        use moved <- result.try(core.transition(
          tx,
          c.id,
          to,
          core.How(
            actor:,
            method: Some(verification_method.OrganisationAdminConfirmation),
            reason:,
            attribution: None,
            event: Some(case to {
              claim_row.Verified -> event_row.ReviewApproved
              _ -> event_row.ReviewRejected
            }),
          ),
          core.Also(..core.no_more(), set: fn(moved) {
            let moved = set(moved)
            case to {
              claim_row.Verified ->
                claim_row.Row(
                  ..moved,
                  authority_kind: Some(claim_row.OrgAdmin),
                  authority_id: Some(id.org_user_to_string(access.user.id)),
                )
              _ -> moved
            }
          }),
          now,
        ))
        case moved {
          Ok(_) -> Ok(Nil)
          Error(e) -> stop(http.error(409, core.move_error_code(e)))
        }
      }),
    )
    announce(text)
  }
  use _ <- result.try(case body.action {
    Confirm | CorrectRole | MarkFormer -> {
      let role_claim =
        list.find(targets, fn(c) {
          string.contains(claim_type.to_string(c.claim_type), "ROLE")
        })
        |> option.from_result
      use role_now <- result.try(case body.action, role, role_claim {
        CorrectRole, None, _ -> stop(http.required("ROLE_REQUIRED", "role"))
        CorrectRole, Some(r), Some(rc) -> {
          use _ <- result.try(core.event(
            tx,
            event_row.ClaimCorrected,
            actor,
            core.About(
              ..core.claim_about(rc),
              subject_id: Some(claim.subject_id),
              org_id: Some(access.org.id),
              detail: records.detail([#("role", rc.role)], [#("role", Some(r))]),
            ),
            now,
          ))
          use _ <- result.map(records.update_claim(
            tx,
            claim_row.Row(..rc, role: Some(r)),
          ))
          Some(r)
        }
        _, _, Some(rc) -> Ok(rc.role)
        _, _, None -> Ok(None)
      })
      let from =
        option.map(body.valid_from, temporal.start) |> option.unwrap(now)
      // A day given as the end means the end of that day.
      let until = case body.valid_until, body.action {
        Some(u), _ -> Some(temporal.end(u))
        None, MarkFormer -> Some(now)
        None, _ -> None
      }
      // Checked only when the club stated both ends: a defaulted start is "now" by convention, not a claim.
      use <- bool.lazy_guard(
        case body.valid_from, body.valid_until {
          Some(_), Some(u) -> from >= temporal.end(u)
          _, _ -> False
        },
        fn() {
          stop(http.json(
            400,
            json.object([
              #("error", json.string("INTERVAL_INVALID")),
              #("field", json.string("validUntil")),
              #("message", json.string("The period must end after it starts.")),
            ]),
          ))
        },
      )
      decide(
        claim_row.Verified,
        access.org.name
          <> " confirmed your "
          <> case body.action {
          MarkFormer -> "historical "
          _ -> ""
        }
          <> "affiliation"
          <> case role_claim {
          Some(_) -> " as " <> option.unwrap(role_now, "null")
          None -> ""
        }
          <> ". ✓",
        fn(c) {
          claim_row.Row(
            ..c,
            valid_from: Some(from),
            valid_until: until,
            current: body.action != MarkFormer,
          )
        },
      )
    }
    Reject ->
      case reason {
        None ->
          stop(http.json(
            400,
            json.object([
              #("error", json.string("REASON_REQUIRED")),
              #("field", json.string("reason")),
              #("problem", json.string("required")),
              #(
                "message",
                json.string(
                  "A rejection needs a reason — it is shown to the person and audited.",
                ),
              ),
            ]),
          ))
        Some(r) ->
          decide(
            claim_row.Rejected,
            access.org.name
              <> " declined the verification request: "
              <> input.utf16_take(r, 140),
            fn(c) { c },
          )
      }
    RequestInfo -> {
      use _ <- result.try(
        list.try_each(targets, fn(c) {
          core.transition(
            tx,
            c.id,
            claim_row.CollectingEvidence,
            core.How(
              actor:,
              method: None,
              reason:,
              attribution: None,
              event: None,
            ),
            core.no_more(),
            now,
          )
          |> result.replace(Nil)
        }),
      )
      announce(
        access.org.name
        <> " asks for more information on your verification request"
        <> case reason {
          Some(r) -> ": " <> input.utf16_take(r, 140)
          None -> ""
        }
        <> ".",
      )
    }
  })
  use views <- result.try(
    list.try_map(targets, fn(c) {
      use found <- result.try(records.claim(read, c.id))
      let assert Some(fresh) = found as "a decided claim exists"
      core.subject_claim_view(read, fresh, now)
    }),
  )
  reply(http.json(
    200,
    json.object([
      #("decided", json.string(action_text(body.action))),
      #("claims", json.preprocessed_array(views)),
    ]),
  ))
}

// ------------------------------------------------------------------------------------------- the register

type StaffQuery {
  StaffQuery(
    state: Option(claim_row.Status),
    current: Option(Bool),
    method: Option(verification_method.VerificationMethod),
    role: Option(String),
  )
}

/// `GET /org/verification/staff`: the organisation's staff claims, filtered.
pub fn staff_register(ctx: Ctx, req: Request, access: OrgAccess) -> Response {
  let shape = {
    use state <- input.field(
      "state",
      input.optional(input.one_of(claim_row.status_pairs)),
    )
    use current <- input.field(
      "current",
      input.optional(input.one_of([#("true", True), #("false", False)])),
    )
    use method <- input.field(
      "method",
      input.optional(input.one_of(verification_method.pairs)),
    )
    use role <- input.field("role", input.optional(input.text(60)))
    input.done(StaffQuery(state:, current:, method:, role:))
  }
  use q <- http.query(req, shape, [])
  let now = clock.now_ms()
  use read <- core.look(ctx)
  use <- guard(read, access, ver_level.VerificationViewer)
  use theirs <- result.try(records.staff_claims(read, access.org.id))
  let rows =
    theirs
    |> list.filter(fn(c) { c.status != claim_row.Unverified })
    |> list.filter(fn(c) {
      option.map(q.state, fn(s) { s == c.status }) |> option.unwrap(True)
    })
    |> list.filter(fn(c) {
      option.map(q.current, fn(b) { b == c.current }) |> option.unwrap(True)
    })
    |> list.filter(fn(c) {
      option.map(q.method, fn(m) { c.verification_method == Some(m) })
      |> option.unwrap(True)
    })
    |> list.filter(fn(c) {
      option.map(q.role, fn(r) {
        string.contains(
          string.lowercase(option.unwrap(c.role, "")),
          string.lowercase(r),
        )
      })
      |> option.unwrap(True)
    })
  use items <- result.map(
    list.try_map(rows, fn(c) {
      // `subject_id` is polymorphic text; these are users' claims.
      use u <- result.map(staff.by_id(read, id.org_user(c.subject_id)))
      let eff =
        claims.effective_status(
          c,
          org: Some(access.org),
          subject_removed: False,
          now:,
        )
      json.object([
        #("claimId", id.claim_json(c.id)),
        #(
          "person",
          json.object(case u {
            Some(u) -> [
              #("id", id.org_user_json(u.id)),
              #("name", json.string(u.name)),
            ]
            None -> []
          }),
        ),
        #("claimType", claim_type.to_json(c.claim_type)),
        #("role", json.nullable(c.role, json.string)),
        #("status", claim_row.status_to_json(c.status)),
        #("effective", effective_json(eff)),
        #("current", json.bool(c.current)),
        #("validFrom", json.nullable(c.valid_from, json.int)),
        #("validUntil", json.nullable(c.valid_until, json.int)),
        #(
          "verificationMethod",
          json.nullable(c.verification_method, verification_method.to_json),
        ),
        #("verifiedAt", json.nullable(c.verified_at, json.int)),
      ])
    }),
  )
  http.json(200, json.object([#("items", json.preprocessed_array(items))]))
}

pub fn effective_json(eff: claims.Effective) -> json.Json {
  json.object([
    #("status", claim_row.status_to_json(eff.status)),
    #("displayable", json.bool(eff.displayable)),
    #("current", json.bool(eff.current)),
    #("historical", json.bool(eff.historical)),
    #(
      "reasons",
      json.array(eff.reasons, fn(r) {
        json.string(claims.effective_reason_code(r))
      }),
    ),
  ])
}

/// `POST /org/verification/staff/:userId/departed`: the period closes, the history stays, and powers tied to the
/// relationship end at once.
pub fn departed(
  ctx: Ctx,
  req: Request,
  access: OrgAccess,
  user_id: id.OrgUserId,
) -> Response {
  let now = clock.now_ms()
  let actor = core.staff_actor(access, req)
  let shape = {
    use until <- input.field("validUntil", input.optional(input.due_date()))
    input.done(option.flatten(until))
  }
  let parsed = http.parse_body(req, shape, [])
  use tx <- act(ctx)
  let read = store.reading(tx)
  use admins <- result.try(records.admins_of(read, access.org.id))
  use <- bool.lazy_guard(
    !claims.has_ver_level(
      admins,
      access.org.id,
      access.user.id,
      ver_level.VerificationReviewer,
    ),
    fn() { stop(core.require_ver_refusal(ver_level.VerificationReviewer)) },
  )
  use <- bool.lazy_guard(user_id == access.user.id, fn() {
    stop(http.error_message(
      403,
      "SELF_VERIFICATION_FORBIDDEN",
      "Ask another administrator to record your own departure.",
    ))
  })
  use theirs <- result.try(records.staff_claims(read, access.org.id))
  let current =
    list.filter(theirs, fn(c) {
      c.subject_id == id.org_user_to_string(user_id)
      && c.status == claim_row.Verified
      && c.current
    })
  case current {
    [] -> stop(http.error(404, "NO_CURRENT_VERIFIED_CLAIMS"))
    [first, ..] -> {
      case parsed {
        Error(response) -> stop(response)
        Ok(until) -> {
          let until = option.map(until, temporal.end) |> option.unwrap(now)
          use _ <- result.try(
            list.try_each(current, fn(c) {
              use _ <- result.try(core.event(
                tx,
                event_row.ClaimCorrected,
                actor,
                core.About(
                  ..core.claim_about(c),
                  org_id: Some(access.org.id),
                  detail: records.detail([#("current", Some("true"))], [
                    #("current", Some("false")),
                    #("validUntil", Some(int.to_string(until))),
                  ]),
                  reason: Some("marked departed"),
                ),
                now,
              ))
              records.update_claim(
                tx,
                claim_row.Row(
                  ..c,
                  current: False,
                  valid_until: option.or(c.valid_until, Some(until)),
                  updated_at: now,
                ),
              )
            }),
          )
          use grants <- result.try(records.active_admins_of(read, access.org.id))
          use _ <- result.try(
            grants
            |> list.filter(fn(a) { a.user_id == user_id })
            |> list.try_each(fn(a) {
              use _ <- result.try(records.revoke_admin(
                tx,
                a.id,
                now,
                access.user.id,
              ))
              core.event(
                tx,
                event_row.AdminRevoked,
                actor,
                core.About(
                  ..core.nothing,
                  org_id: Some(access.org.id),
                  subject_id: Some(id.org_user_to_string(a.user_id)),
                  reason: Some("departed"),
                ),
                now,
              )
            }),
          )
          use _ <- result.try(notifications.notify(
            tx,
            to: audience.OrgUser,
            id: id.org_user_to_string(user_id),
            type_: "verification",
            text: access.org.name
              <> " recorded you as departed. Your verified history stays on your profile; if this is wrong you can dispute it from Verification.",
            ref_id: Some(id.claim_to_string(first.id)),
            at: now,
          ))
          reply(http.json(
            200,
            json.object([
              #("closed", json.int(list.length(current))),
              #(
                "note",
                json.string(
                  "Current badges end now; the historical verified period remains. The person can dispute this.",
                ),
              ),
            ]),
          ))
        }
      }
    }
  }
}
