//// A staff member's own verification (domains/verification/claims/personalRoutes.mjs): their claims and steps,
//// identity, evidence, submission and the automated pre-review, the affiliation request (a linked pair of
//// claims), work-email proof, disputes, and the safe public projections.
////
//// A person can never verify themselves. Domain control is evidence of mailbox control, not of employment.

import gleam/bool
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/orgs
import scoutbox/platform/clock
import scoutbox/platform/effect.{SendMail}
import scoutbox/platform/http
import scoutbox/platform/ids
import scoutbox/platform/input
import scoutbox/platform/store.{type Fail, type Tx}
import scoutbox/platform/temporal
import scoutbox/rows/ver_claims as claim_row
import scoutbox/rows/ver_disputes as dispute_row
import scoutbox/rows/ver_events as event_row
import scoutbox/rows/ver_evidence as evidence_row
import scoutbox/rows/ver_tokens as token_row
import scoutbox/verification/claims.{type Claim}
import scoutbox/verification/core.{type Actor, type Done, act, reply, stop}
import scoutbox/verification/records
import scoutbox/vocab/attribution
import scoutbox/vocab/claim_type
import scoutbox/vocab/ver_code
import scoutbox/vocab/ver_level
import wisp.{type Request, type Response}

const day_ms = 86_400_000

fn mine(access: OrgAccess, claim: Option(Claim)) -> Option(Claim) {
  case claim {
    Some(c)
      if c.subject_id == access.user.id && c.subject_kind == claim_row.User
    -> claim
    _ -> None
  }
}

fn claim_not_found() -> Response {
  http.error(404, "CLAIM_NOT_FOUND")
}

fn view(tx: Tx, claim_id: String, now: Int) -> Result(json.Json, Fail(e)) {
  let read = store.reading(tx)
  use found <- result.try(records.claim(read, claim_id))
  let assert Some(claim) = found as "a claim this act holds exists"
  core.subject_claim_view(read, claim, now)
}

/// A status change made by the staff member.
fn apply_status(
  tx: Tx,
  claim_id: String,
  to: claim_row.Status,
  actor: Actor,
  reason: Option(String),
  also: core.Also,
  now: Int,
) -> Result(Result(Claim, core.MoveError), Fail(e)) {
  core.transition(
    tx,
    claim_id,
    to,
    core.How(actor:, method: None, reason:, attribution: None, event: None),
    also,
    now,
  )
}

// ------------------------------------------------------------------------------------------- my verification

/// `GET /org/verification/me`: my claims, my level, and my steps, which persist because they derive from records.
pub fn me(ctx: Ctx, access: OrgAccess) -> Response {
  let now = clock.now_ms()
  use read <- core.look(ctx)
  use theirs <- result.try(records.claims_for(
    read,
    claim_row.User,
    access.user.id,
  ))
  use views <- result.try(
    list.try_map(theirs, core.subject_claim_view(read, _, now)),
  )
  use proved <- result.try(
    list.try_map(theirs, fn(c) { records.claim_evidence(read, c.id) }),
  )
  use level <- result.try(core.admins_level(read, access.org.id, access.user.id))
  use status <- result.try(core.org_status(read, Some(access.org)))
  use preview <- result.map(core.public_user(read, access.user.id, now))
  let #(aff_type, _) = core.affiliation_types_of(access.org)
  let identity =
    list.find(theirs, fn(c) { c.claim_type == claim_type.PersonIdentity })
    |> option.from_result
  let affiliation =
    list.find(theirs, fn(c) {
      c.claim_type == aff_type
      && c.organisation_id == Some(access.org.id)
      && c.current
    })
    |> option.from_result
  let email_proved =
    list.any(list.flatten(proved), fn(e) {
      e.type_ == evidence_row.OfficialEmail
    })
  let state = fn(c: Option(Claim)) {
    case c {
      Some(c) -> claim_row.status_to_string(c.status)
      None -> "not_started"
    }
  }
  let verified = fn(c: Option(Claim)) {
    case c {
      Some(c) -> c.status == claim_row.Verified
      None -> False
    }
  }
  let step = fn(id, label, done, state) {
    json.object([
      #("id", json.string(id)),
      #("label", json.string(label)),
      #("done", json.bool(done)),
      #("state", json.string(state)),
    ])
  }
  let done_or = fn(b) {
    case b {
      True -> "done"
      False -> "not_started"
    }
  }
  http.json(
    200,
    json.object([
      #("claims", json.preprocessed_array(views)),
      #(
        "verificationLevel",
        json.nullable(level, fn(l) { json.string(ver_level.to_string(l)) }),
      ),
      #("organisationStatus", json.string(claims.org_status_code(status))),
      #(
        "steps",
        json.preprocessed_array([
          step(
            "identity",
            "Verify identity",
            verified(identity),
            state(identity),
          ),
          step("organisation", "Select organisation", True, "done"),
          step(
            "role",
            "Add professional role",
            affiliation != None,
            done_or(affiliation != None),
          ),
          step(
            "work_email",
            "Verify work email",
            email_proved,
            done_or(email_proved),
          ),
          step(
            "confirmation",
            "Organisation confirmation",
            verified(affiliation),
            state(affiliation),
          ),
        ]),
      ),
      #("publicPreview", preview),
    ]),
  )
}

/// `POST /org/verification/identity`: opens a personal identity claim. A document is evidence; verification
/// happens in review, never on upload.
pub fn identity(ctx: Ctx, req: Request, access: OrgAccess) -> Response {
  // The body is never read: a forged `status` in it changes nothing.
  let now = clock.now_ms()
  use tx <- act(ctx)
  use open <- result.try(records.has_open_identity(
    store.reading(tx),
    access.user.id,
  ))
  use <- bool.lazy_guard(open, fn() {
    stop(http.error_message(
      409,
      "IDENTITY_CLAIM_EXISTS",
      "An identity verification is already open or complete.",
    ))
  })
  use claim <- result.try(core.create_claim(
    tx,
    fn(id) {
      claim_row.Row(
        ..core.blank_claim(
          id,
          claim_row.User,
          access.user.id,
          claim_type.PersonIdentity,
          now,
        ),
        status: claim_row.CollectingEvidence,
        declared_name: Some(input.utf16_take(access.user.name, 200)),
      )
    },
    core.staff_actor(access, req),
    now,
  ))
  use v <- result.try(view(tx, claim.id, now))
  reply(http.json(
    201,
    json.object([
      #("claim", v),
      #(
        "note",
        json.string(
          "Add an identity document as evidence, then submit. A document is evidence — verification happens in review, never on upload.",
        ),
      ),
    ]),
  ))
}

type Upload {
  Upload(
    data_url: Option(String),
    filename: Option(String),
    note: Option(String),
  )
}

/// `POST /org/verification/claims/:id/evidence`: a document or a note, before review completes.
pub fn evidence(
  ctx: Ctx,
  req: Request,
  access: OrgAccess,
  claim_id: String,
) -> Response {
  let now = clock.now_ms()
  let found = store.read(ctx.store, fn(read) { records.claim(read, claim_id) })
  case found {
    Error(failure) -> http.internal(failure)
    Ok(found) ->
      case mine(access, found) {
        None -> claim_not_found()
        Some(claim) ->
          case
            list.contains(
              [
                claim_row.Unverified,
                claim_row.CollectingEvidence,
                claim_row.Pending,
              ],
              claim.status,
            )
          {
            False ->
              http.error_message(
                409,
                "CLAIM_NOT_EDITABLE",
                "Evidence can only be added before review completes.",
              )
            True -> {
              let shape = {
                use data_url <- input.field(
                  "dataUrl",
                  input.nullish(input.text(100_000_000)),
                )
                use filename <- input.field(
                  "filename",
                  input.nullish(input.text(120)),
                )
                use note <- input.field("note", input.nullish(input.text(400)))
                input.done(Upload(data_url:, filename:, note:))
              }
              use body <- http.body(req, shape, [])
              add_evidence(ctx, req, access, claim, body, now)
            }
          }
      }
  }
}

fn add_evidence(
  ctx: Ctx,
  req: Request,
  access: OrgAccess,
  claim: Claim,
  body: Upload,
  now: Int,
) -> Response {
  let note = input.filled(body.note)
  let file = case body.data_url {
    Some(url) if url != "" -> Some(core.evidence_file(ctx, url, body.filename))
    _ -> None
  }
  case file, note {
    Some(Error(code)), _ -> http.error(422, code)
    None, None ->
      http.error_message(
        400,
        "EVIDENCE_REQUIRED",
        "Attach a document or a note.",
      )
    _, _ -> {
      let file = case file {
        Some(Ok(f)) -> Some(f)
        _ -> None
      }
      let actor = core.staff_actor(access, req)
      use tx <- act(ctx)
      let read = store.reading(tx)
      // A risk signal, not a verdict.
      use dup <- result.try(case file {
        Some(f) -> records.digest_seen(read, f.sha256, Some(access.user.id))
        None -> Ok(False)
      })
      use ev <- result.try(core.add_evidence(
        tx,
        fn(id) {
          let ev =
            evidence_row.Row(
              ..core.blank_evidence(
                id,
                evidence_row.Document,
                "subject_upload",
                evidence_row.OrgUser,
                now,
              ),
              supplied_by_id: Some(access.user.id),
              org_id: Some(access.org.id),
              note: Some(option.unwrap(note, "")),
              visibility: case claim.claim_type {
                claim_type.PersonIdentity | claim_type.Licence ->
                  evidence_row.TrustAndSafety
                _ -> evidence_row.OrganisationInternal
              },
            )
          case file {
            Some(f) -> core.with_file(ev, f)
            None -> ev
          }
        },
        [claim.id],
        actor,
        now,
      ))
      use _ <- result.try(case dup {
        True ->
          records.add_codes(tx, claim.id, records.RiskFlags, [
            ver_code.DuplicateEvidenceHash,
          ])
        False -> Ok(Nil)
      })
      use _ <- result.try(case claim.status {
        claim_row.Unverified ->
          apply_status(
            tx,
            claim.id,
            claim_row.CollectingEvidence,
            actor,
            None,
            core.no_more(),
            now,
          )
          |> result.replace(Nil)
        _ -> Ok(Nil)
      })
      use v <- result.try(view(tx, claim.id, now))
      reply(http.json(
        201,
        json.object([
          #("claim", v),
          #("evidenceChecks", core.evidence_checks(ev)),
        ]),
      ))
    }
  }
}

/// `POST /org/verification/claims/:id/submit`: complete evidence goes to the automated pre-review.
pub fn submit(
  ctx: Ctx,
  req: Request,
  access: OrgAccess,
  claim_id: String,
) -> Response {
  // The body is never read: a forged `status` in it changes nothing.
  let now = clock.now_ms()
  let actor = core.staff_actor(access, req)
  use tx <- act(ctx)
  let read = store.reading(tx)
  use found <- result.try(records.claim(read, claim_id))
  case mine(access, found) {
    None -> stop(claim_not_found())
    Some(claim) ->
      case
        list.contains(
          [claim_row.CollectingEvidence, claim_row.Unverified],
          claim.status,
        )
      {
        False -> stop(http.error(409, "ALREADY_SUBMITTED"))
        True -> {
          use evidence <- result.try(records.claim_evidence(read, claim.id))
          let completeness =
            claims.evidence_completeness(
              claim.claim_type,
              list.map(evidence, fn(e) { e.type_ }),
            )
          case completeness.complete {
            False ->
              stop(http.json(
                422,
                json.object([
                  #("error", json.string("EVIDENCE_INCOMPLETE")),
                  #(
                    "missing",
                    json.array(completeness.missing, fn(t) {
                      json.string(evidence_row.type_to_string(t))
                    }),
                  ),
                ]),
              ))
            True -> {
              use _ <- result.try(to_pending(tx, claim, actor, access, now))
              use v <- result.try(view(tx, claim.id, now))
              reply(http.json(200, json.object([#("claim", v)])))
            }
          }
        }
      }
  }
}

/// From evidence collection to pending, then the automated pre-review.
fn to_pending(
  tx: Tx,
  claim: Claim,
  actor: Actor,
  access: OrgAccess,
  now: Int,
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(case claim.status {
    claim_row.Unverified ->
      apply_status(
        tx,
        claim.id,
        claim_row.CollectingEvidence,
        actor,
        None,
        core.no_more(),
        now,
      )
      |> result.replace(Nil)
    _ -> Ok(Nil)
  })
  use _ <- result.try(apply_status(
    tx,
    claim.id,
    claim_row.Pending,
    actor,
    None,
    core.no_more(),
    now,
  ))
  route_claim(tx, claim.id, actor, Some(access.user.name), now)
}

/// The automated pre-review, on a claim just moved to pending: risk flags, then either human review or an
/// organisation administrator's confirmation.
pub fn route_claim(
  tx: Tx,
  claim_id: String,
  actor: Actor,
  asker: Option(String),
  now: Int,
) -> Result(Nil, Fail(e)) {
  let read = store.reading(tx)
  use found <- result.try(records.claim(read, claim_id))
  let assert Some(claim) = found as "a routed claim exists"
  use org <- result.try(case claim.organisation_id {
    Some(id) -> orgs.by_id(read, id)
    None -> Ok(None)
  })
  use domains <- result.try(case org {
    Some(o) -> core.verified_domains_of(read, o.id)
    None -> Ok([])
  })
  use theirs <- result.try(records.claims_for(
    read,
    claim_row.User,
    claim.subject_id,
  ))
  use fails <- result.try(records.failed_attempts(
    read,
    claim.subject_id,
    token_row.WorkEmail,
  ))
  use flags_now <- result.try(records.codes(read, claim.id, records.RiskFlags))
  let flags =
    claims.risk_flags(
      claims.Risk(
        ..claims.no_risk,
        email: claim.work_email,
        org_domains: domains,
        applicant_had_recent_revocation: list.any(theirs, fn(c) {
          c.status == claim_row.Revoked
          && option.unwrap(c.revoked_at, 0) > now - 30 * day_ms
        }),
        competing_org_claims: list.count(theirs, fn(c) {
          c.id != claim.id
          && c.claim_type == claim.claim_type
          && c.organisation_id != None
          && c.organisation_id != claim.organisation_id
          && list.contains(core.open_states, c.status)
        }),
        org_suspended: case org {
          Some(o) -> o.suspended
          None -> False
        },
        email_challenge_fails: fails,
        duplicate_evidence_hash: list.contains(
          flags_now,
          ver_code.DuplicateEvidenceHash,
        ),
      ),
    )
  use evidence <- result.try(records.claim_evidence(read, claim.id))
  use authority <- result.try(case org {
    Some(o) -> {
      use status <- result.try(core.org_status(read, Some(o)))
      use reviewers <- result.map(core.reviewers_of(
        read,
        o.id,
        ver_level.VerificationReviewer,
      ))
      status == claims.OrgVerified && reviewers != []
    }
    None -> Ok(False)
  })
  let review =
    claims.decide_review(
      claims.Case(
        ..claims.plain_case,
        claim_type: Some(claim.claim_type),
        org_has_active_authority: authority,
        document_only: list.all(evidence, fn(e) {
          e.type_ == evidence_row.Document
        }),
        risk_flag_count: list.length(flags),
        disputed: claim.disputed_at != None,
      ),
    )
  let record =
    core.Also(
      ..core.no_more(),
      add_risk_flags: flags,
      review_reasons: Some(review.reasons),
    )
  case review.decision {
    claims.RequiresHumanReview -> {
      use _ <- result.try(apply_status(
        tx,
        claim.id,
        claim_row.RequiresHumanReview,
        actor,
        None,
        record,
        now,
      ))
      core.count(tx, "routedToHumanReview") |> result.replace(Nil)
    }
    claims.CanAutoComplete -> {
      use _ <- result.try(core.count(tx, "autoPrechecksPassed"))
      use _ <- result.try(apply_status(
        tx,
        claim.id,
        claim_row.AutomatedChecksPassed,
        actor,
        None,
        record,
        now,
      ))
      use _ <- result.try(core.event(
        tx,
        event_row.AutomatedCheckPassed,
        actor,
        core.About(
          ..core.claim_about(claim),
          detail: records.detail([], [
            #(
              "riskFlags",
              Some(string.join(list.map(flags, ver_code.to_string), ", ")),
            ),
          ]),
        ),
        now,
      ))
      case claim.organisation_id, org {
        Some(org_id), Some(o) -> {
          let what = case claim.claim_type {
            claim_type.ClubRole | claim_type.AgencyRole ->
              "the role “" <> option.unwrap(claim.role, "null") <> "”"
            _ -> "their affiliation"
          }
          core.notify_reviewers(
            tx,
            org_id,
            option.unwrap(asker, "A colleague")
              <> " asks "
              <> o.name
              <> " to confirm "
              <> what
              <> ".",
            claim.id,
            now,
          )
        }
        _, _ -> Ok(Nil)
      }
    }
  }
}

// ------------------------------------------------------------------------------------------- affiliation

/// `POST /org/verification/affiliation`: the affiliation and role claims, linked as a pair.
pub fn affiliation(ctx: Ctx, req: Request, access: OrgAccess) -> Response {
  let shape = {
    use role <- input.field("role", input.nullish(input.text(60)))
    use valid_from <- input.field("validFrom", input.optional(input.due_date()))
    input.done(#(role, option.flatten(valid_from)))
  }
  use #(role_sent, valid_from) <- http.body(req, shape, [])
  // The account's own role, which no schema has read, may be longer than a claim's.
  let role = case role_sent {
    Some(r) -> input.filled(Some(r))
    None ->
      input.filled(Some(access.user.role))
      |> option.map(input.utf16_take(_, 60))
  }
  case role {
    None -> http.required("ROLE_REQUIRED", "role")
    Some(role) -> {
      let now = clock.now_ms()
      let actor = core.staff_actor(access, req)
      let #(aff_type, role_type) = core.affiliation_types_of(access.org)
      use tx <- act(ctx)
      use theirs <- result.try(records.claims_for(
        store.reading(tx),
        claim_row.User,
        access.user.id,
      ))
      let existing =
        list.any(theirs, fn(c) {
          c.organisation_id == Some(access.org.id)
          && { c.claim_type == aff_type || c.claim_type == role_type }
          && c.current
          && {
            c.status == claim_row.Verified
            || list.contains(core.open_states, c.status)
          }
        })
      use <- bool.lazy_guard(existing, fn() {
        stop(http.error_message(
          409,
          "AFFILIATION_CLAIM_EXISTS",
          "A current affiliation request or verification already exists for this organisation.",
        ))
      })
      use pair_id <- result.try(ids.next(tx, "vpair"))
      let base = fn(id, t) {
        claim_row.Row(
          ..core.blank_claim(id, claim_row.User, access.user.id, t, now),
          organisation_id: Some(access.org.id),
          status: claim_row.CollectingEvidence,
          pair_id: Some(pair_id),
          declared_name: Some(input.utf16_take(access.user.name, 200)),
          requested_start: option.map(valid_from, temporal.start),
        )
      }
      use aff <- result.try(core.create_claim(
        tx,
        fn(id) { base(id, aff_type) },
        actor,
        now,
      ))
      use role_claim <- result.try(core.create_claim(
        tx,
        fn(id) { claim_row.Row(..base(id, role_type), role: Some(role)) },
        actor,
        now,
      ))
      use a <- result.try(view(tx, aff.id, now))
      use r <- result.try(view(tx, role_claim.id, now))
      reply(http.json(
        201,
        json.object([
          #("affiliation", a),
          #("role", r),
          #(
            "next",
            json.string(
              "Prove control of your work email (POST /org/verification/work-email), then the organisation confirms the relationship. Email control alone never equals verified employment.",
            ),
          ),
        ]),
      ))
    }
  }
}

// ------------------------------------------------------------------------------------------- work email

const email_codes = [#("email", "EMAIL_SYNTAX")]

/// `POST /org/verification/work-email`: a challenge to a work mailbox. The code travels only in the mail.
pub fn work_email(ctx: Ctx, req: Request, access: OrgAccess) -> Response {
  let shape = {
    use email <- input.field("email", input.required(input.text(254)))
    input.done(email)
  }
  use email <- http.body(req, shape, email_codes)
  let email = email |> string.trim |> string.lowercase
  let domain = claims.domain_of_email(email)
  case claims.email_problem(email) {
    Some(problem) -> http.error(400, claims.email_problem_code(problem))
    None ->
      case claims.is_disposable(domain), claims.is_free_mail(domain) {
        True, _ ->
          http.error_message(
            422,
            "DISPOSABLE_EMAIL_REFUSED",
            "Disposable addresses cannot prove a working relationship.",
          )
        _, True ->
          http.error_message(
            422,
            "COMPANY_EMAIL_REQUIRED",
            "A free-provider address does not evidence organisation email control. If your organisation has no domain, ask the organisation to confirm you directly — or Trust & Safety reviews the case.",
          )
        False, False -> {
          let now = clock.now_ms()
          use tx <- act(ctx)
          use secret <- result.try(core.mint_token(
            tx,
            token_row.WorkEmail,
            Some(email),
            Some(token_row.OrgUser),
            Some(access.user.id),
            Some(access.org.id),
            None,
            core.work_email_ttl_ms,
            now,
          ))
          use _ <- result.try(core.event(
            tx,
            event_row.EmailChallengeSent,
            core.staff_actor(access, req),
            core.About(
              ..core.nothing,
              subject_id: Some(access.user.id),
              org_id: Some(access.org.id),
              detail: records.detail([], [#("domain", Some(domain))]),
            ),
            now,
          ))
          store.emit(
            tx,
            SendMail(
              to: email,
              subject: "Confirm your work email for ScoutBox verification",
              text: "Hi "
                <> access.user.name
                <> ",\n\nYour ScoutBox work-email confirmation code is "
                <> secret
                <> "\n\nEntering it proves control of this mailbox. It expires in 30 minutes and works once.\n\nIf you did not request this, ignore the email.",
            ),
          )
          Ok(http.json(
            201,
            json.object([
              #("sent", json.bool(True)),
              #(
                "note",
                json.string(
                  "Enter the code from the mailbox. Codes are single-use and expire in 30 minutes.",
                ),
              ),
            ]),
          ))
        }
      }
  }
}

/// `POST /org/verification/work-email/confirm`: the mailbox is proved, as evidence for the open affiliation
/// claims. The token is spent only together with the evidence and the claims it proves.
pub fn confirm_work_email(
  ctx: Ctx,
  req: Request,
  access: OrgAccess,
) -> Response {
  let shape = {
    use code <- input.field("code", input.nullish(input.text(64)))
    use email <- input.field("email", input.nullish(input.text(254)))
    input.done(#(code, email))
  }
  use #(code, email) <- http.body(req, shape, email_codes)
  let now = clock.now_ms()
  let actor = core.staff_actor(access, req)
  let me = Some(access.user.id)
  use tx <- act(ctx)
  let read = store.reading(tx)
  use peek <- result.try(core.peek_token(
    read,
    token_row.WorkEmail,
    code,
    email,
    Some(access.user.id),
    now,
  ))
  case peek {
    Error(code) -> {
      // A risk signal, kept although the request is refused.
      use _ <- result.try(records.record_failed_attempts(
        tx,
        access.user.id,
        token_row.WorkEmail,
      ))
      use _ <- result.try(core.count(tx, "emailChallengeFailures"))
      reply(http.error(
        case code {
          "TOKEN_EXPIRED" -> 410
          _ -> 401
        },
        code,
      ))
    }
    Ok(token) if token.subject_id != me ->
      reply(http.error(403, "TOKEN_WRONG_ACCOUNT"))
    Ok(token) -> {
      let address = option.unwrap(token.email, "")
      let domain = claims.domain_of_email(address)
      use domains <- result.try(core.verified_domains_of(read, access.org.id))
      let covered = list.any(domains, claims.domain_covered(domain, _))
      let #(aff_type, role_type) = core.affiliation_types_of(access.org)
      use theirs <- result.try(records.claims_for(
        read,
        claim_row.User,
        access.user.id,
      ))
      let open =
        list.filter(theirs, fn(c) {
          c.organisation_id == Some(access.org.id)
          && { c.claim_type == aff_type || c.claim_type == role_type }
          && list.contains(core.open_states, c.status)
        })
      use _ <- result.try(records.use_token(tx, token.id, now))
      case open {
        // A correct code is spent even when there is nothing to attach it to.
        [] ->
          reply(http.error_message(
            409,
            "NO_OPEN_AFFILIATION",
            "Request an affiliation first — the email proof attaches to it.",
          ))
        _ -> {
          use _ <- result.try(core.add_evidence(
            tx,
            fn(id) {
              evidence_row.Row(
                ..core.blank_evidence(
                  id,
                  evidence_row.OfficialEmail,
                  "email_challenge",
                  evidence_row.OrgUser,
                  now,
                ),
                supplied_by_id: Some(access.user.id),
                org_id: Some(access.org.id),
                visibility: evidence_row.OrganisationInternal,
                domain: Some(domain),
                domain_covered_by_org: Some(covered),
                // The address itself is not stored on the evidence record.
                address_hash: Some(core.sha256_hex(address)),
              )
            },
            list.map(open, fn(c) { c.id }),
            actor,
            now,
          ))
          use _ <- result.try(
            list.try_each(open, fn(c) {
              // Internal to the subject and the organisation, never public.
              use _ <- result.try(records.update_claim(
                tx,
                claim_row.Row(
                  ..c,
                  work_email: Some(address),
                  domain_control: Some(claim_row.Passed),
                  domain_covered_by_org: Some(covered),
                ),
              ))
              use _ <- result.try(core.event(
                tx,
                event_row.EmailChallengePassed,
                actor,
                core.About(
                  ..core.claim_about(c),
                  subject_id: Some(access.user.id),
                  org_id: Some(access.org.id),
                  detail: records.detail([], [
                    #("domain", Some(domain)),
                    #(
                      "covered",
                      Some(bool.to_string(covered) |> string.lowercase),
                    ),
                  ]),
                ),
                now,
              ))
              case c.status {
                claim_row.CollectingEvidence | claim_row.Unverified ->
                  to_pending(tx, c, actor, access, now)
                _ -> Ok(Nil)
              }
            }),
          )
          use views <- result.try(
            list.try_map(open, fn(c) { view(tx, c.id, now) }),
          )
          reply(http.json(
            200,
            json.object([
              #("domainControl", json.string("passed")),
              #("domainCoveredByOrg", json.bool(covered)),
              #("claims", json.preprocessed_array(views)),
              #(
                "note",
                json.string(
                  "Email control recorded as evidence. It does NOT by itself verify employment — an authorised organisation administrator confirms the relationship next.",
                ),
              ),
            ]),
          ))
        }
      }
    }
  }
}

// ------------------------------------------------------------------------------------------- disputes

/// `POST /org/verification/claims/:id/dispute`: the subject disputes their own claim.
pub fn dispute(
  ctx: Ctx,
  req: Request,
  access: OrgAccess,
  claim_id: String,
) -> Response {
  let now = clock.now_ms()
  let found = store.read(ctx.store, records.claim(_, claim_id))
  case found {
    Error(failure) -> http.internal(failure)
    Ok(found) ->
      case mine(access, found) {
        None -> claim_not_found()
        Some(claim) -> {
          let shape = {
            use reason <- input.field("reason", input.nullish(input.text(600)))
            input.done(reason)
          }
          use reason <- http.body(req, shape, [])
          case input.filled(reason) {
            None -> http.required("REASON_REQUIRED", "reason")
            Some(reason) ->
              act(ctx, fn(tx) {
                open_dispute(
                  tx,
                  claim,
                  dispute_row.OrgUser,
                  access.user.id,
                  Some(access.user.name),
                  reason,
                  core.staff_actor(access, req),
                  now,
                )
              })
          }
        }
      }
  }
}

pub fn open_dispute(
  tx: Tx,
  claim: Claim,
  by_kind: dispute_row.ByKind,
  by_id: String,
  by_name: Option(String),
  reason: String,
  actor: Actor,
  now: Int,
) -> Done {
  use open <- result.try(records.has_open_dispute(store.reading(tx), claim.id))
  use <- bool.lazy_guard(open, fn() {
    stop(http.error(409, "DISPUTE_ALREADY_OPEN"))
  })
  use id <- result.try(ids.next(tx, "vdsp"))
  use d <- result.try(records.create_dispute(
    tx,
    dispute_row.Row(
      id:,
      claim_id: claim.id,
      by_kind:,
      by_id:,
      by_name: option.map(by_name, input.utf16_take(_, 200)),
      reason: input.utf16_take(reason, 600),
      status: dispute_row.Open,
      resolution: None,
      created_at: now,
      resolved_at: None,
      resolved_by_name: None,
      resolved_by_id: None,
      resolution_attribution: None,
    ),
  ))
  use _ <- result.try(case claim.status {
    claim_row.Verified ->
      apply_status(
        tx,
        claim.id,
        claim_row.Disputed,
        actor,
        Some(reason),
        core.no_more(),
        now,
      )
      |> result.replace(Nil)
    _ ->
      records.add_codes(tx, claim.id, records.ReviewReasons, [
        ver_code.DisputedClaim,
      ])
  })
  use _ <- result.try(core.event(
    tx,
    event_row.ClaimDisputed,
    core.Actor(
      ..core.system_actor(None),
      kind: case by_kind {
        dispute_row.OrgUser -> event_row.OrgUser
      },
      id: Some(by_id),
      name: by_name,
    ),
    core.About(..core.claim_about(claim), reason: Some(reason)),
    now,
  ))
  use _ <- result.try(core.count(tx, "disputes"))
  reply(http.json(
    201,
    json.object([
      #("dispute", dispute_json(d)),
      #(
        "note",
        json.string(
          "The claim is flagged, its history is preserved, and Trust & Safety reviews the dispute. Disputed claims never silently disappear.",
        ),
      ),
    ]),
  ))
}

pub fn dispute_json(d: records.Dispute) -> json.Json {
  json.object(dispute_fields(d))
}

pub fn dispute_fields(d: records.Dispute) -> List(#(String, json.Json)) {
  [
    #("id", json.string(d.id)),
    #("claimId", json.string(d.claim_id)),
    #("byKind", json.string(dispute_row.by_kind_to_string(d.by_kind))),
    #("byId", json.string(d.by_id)),
    #("byName", json.nullable(d.by_name, json.string)),
    #("reason", json.string(d.reason)),
    #("status", json.string(dispute_row.status_to_string(d.status))),
    #("resolution", json.nullable(d.resolution, json.string)),
    #("createdAt", json.int(d.created_at)),
    #("resolvedAt", json.nullable(d.resolved_at, json.int)),
    #("resolvedBy", json.nullable(d.resolved_by_name, json.string)),
    #("resolvedById", json.nullable(d.resolved_by_id, json.string)),
    #(
      "resolutionAttribution",
      json.nullable(d.resolution_attribution, fn(a) {
        json.string(attribution_text(a))
      }),
    ),
  ]
}

fn attribution_text(a) -> String {
  attribution.to_string(a)
}

// ------------------------------------------------------------------------------------------- public

/// `GET /org/verification/public/user/:id`.
pub fn public_user(ctx: Ctx, user_id: String) -> Response {
  use read <- core.look(ctx)
  use profile <- result.map(core.public_user(read, user_id, clock.now_ms()))
  http.json(200, profile)
}

/// `GET /org/verification/public/org/:id`, and the player's and guardian's `/verification/org/:id`.
pub fn public_org(ctx: Ctx, org_id: String) -> Response {
  use read <- core.look(ctx)
  use profile <- result.map(core.public_org(read, org_id, clock.now_ms()))
  http.json(200, profile)
}

/// `GET /org/verification/public/users?ids=a,b`: so list screens make one call, not N.
pub fn public_users(ctx: Ctx, req: Request) -> Response {
  let shape = {
    use ids <- input.field("ids", input.optional(input.ids_text(100)))
    input.done(option.unwrap(ids, []))
  }
  use ids <- http.query(req, shape, [])
  let now = clock.now_ms()
  use read <- core.look(ctx)
  use profiles <- result.map(list.try_map(ids, core.public_user(read, _, now)))
  http.json(
    200,
    json.object([#("profiles", json.preprocessed_array(profiles))]),
  )
}
