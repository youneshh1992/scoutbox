//// Organisation applications (domains/verification/claims/applicationRoutes.mjs, and review.mjs's root-request
//// decisions): a public application to have an organisation verified with its first administrator, proved by
//// a work mailbox and evidence, and always decided by Trust & Safety. The applicant secret binds the follow-up
//// calls; a wrong one reads as no such application.
////
//// Identity is never established by a name: two people can share one. Only the proven work e-mail links an
//// existing account; a name match only surfaces candidates.

import gleam/bit_array
import gleam/bool
import gleam/crypto
import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/orgs
import scoutbox/identity/staff
import scoutbox/media/uploads
import scoutbox/platform/clock
import scoutbox/platform/effect.{SendMail}
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/id
import scoutbox/rows/orgs as org_row
import scoutbox/rows/upload_intents as upload_row
import scoutbox/rows/ver_admins as admin_row
import scoutbox/rows/ver_claims as claim_row
import scoutbox/rows/ver_events as event_row
import scoutbox/rows/ver_evidence as evidence_row
import scoutbox/rows/ver_root_request_codes as code_row
import scoutbox/rows/ver_root_requests as row
import scoutbox/rows/ver_tokens as token_row
import scoutbox/safety/ledger
import scoutbox/verification/claims
import scoutbox/verification/core.{act, reply, stop}
import scoutbox/verification/records
import scoutbox/verification/reviewer
import scoutbox/vocab/actor_kind
import scoutbox/vocab/attribution
import scoutbox/vocab/check_outcome
import scoutbox/vocab/claim_type
import scoutbox/vocab/identity_link
import scoutbox/vocab/org_type
import scoutbox/vocab/ver_code.{type VerCode}
import scoutbox/vocab/ver_level
import scoutbox/vocab/ver_org_type
import scoutbox/vocab/verification_method
import sqlight
import wisp.{type Request, type Response}

pub type Application =
  row.Row

// ------------------------------------------------------------------------------------------- the table

pub fn by_id(
  read: Read,
  request_id: id.RootRequestId,
) -> Result(Option(Application), Fail(e)) {
  store.one(
    read,
    "SELECT " <> row.columns <> " FROM ver_root_requests WHERE id = ?",
    [id.root_request_sql(request_id)],
    row.decoder(),
  )
  |> result.map(option.from_result)
}

/// Applications awaiting Trust & Safety, optionally of one country.
pub fn awaiting_review(
  read: Read,
  country: Option(String),
) -> Result(List(Application), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> row.columns
      <> " FROM ver_root_requests WHERE status IN ('requires_human_review','collecting_evidence') AND (? IS NULL OR country = ?) ORDER BY rowid",
    [
      sqlight.nullable(sqlight.text, country),
      sqlight.nullable(sqlight.text, country),
    ],
    row.decoder(),
  )
}

fn codes(
  read: Read,
  id: id.RootRequestId,
  l: code_row.ListValue,
) -> Result(List(VerCode), Fail(e)) {
  store.query(
    read,
    "SELECT code FROM ver_root_request_codes WHERE root_request_id = ? AND list = ? ORDER BY position",
    [id.root_request_sql(id), sqlight.text(code_row.list_value_to_string(l))],
    decode.at([0], ver_code.decoder()),
  )
}

fn add_codes(
  tx: Tx,
  id: id.RootRequestId,
  l: code_row.ListValue,
  new: List(VerCode),
) -> Result(Nil, Fail(e)) {
  use have <- result.try(codes(store.reading(tx), id, l))
  new
  |> list.filter(fn(c) { !list.contains(have, c) })
  |> list.unique
  |> list.index_map(fn(c, i) { #(c, list.length(have) + i) })
  |> list.try_each(fn(p) {
    store.run(
      tx,
      code_row.insert_sql,
      code_row.values(code_row.Row(
        root_request_id: id,
        list: l,
        position: p.1,
        code: p.0,
      )),
    )
  })
}

fn rewrite(tx: Tx, a: Application, guard: String) -> Result(Bool, Fail(e)) {
  let marks = list.map(row.values(a), fn(_) { "?" }) |> string.join(", ")
  store.write(
    tx,
    "UPDATE ver_root_requests SET ("
      <> row.columns
      <> ") = ("
      <> marks
      <> ") WHERE id = ? AND "
      <> guard
      <> " RETURNING 1",
    list.append(row.values(a), [id.root_request_sql(a.id)]),
    decode.success(Nil),
  )
  |> result.map(fn(rows) { rows != [] })
}

fn evidence_ids(
  read: Read,
  id: id.RootRequestId,
) -> Result(List(id.EvidenceId), Fail(e)) {
  store.query(
    read,
    "SELECT id FROM ver_evidence WHERE root_request_id = ? ORDER BY rowid",
    [id.root_request_sql(id)],
    decode.at([0], id.evidence_decoder()),
  )
}

/// An application as Trust & Safety reads it, without the applicant secret's hash.
pub fn record(read: Read, a: Application) -> Result(Json, Fail(e)) {
  use reasons <- result.try(codes(read, a.id, code_row.ReviewReason))
  use flags <- result.try(codes(read, a.id, code_row.RiskFlag))
  use evidence <- result.map(evidence_ids(read, a.id))
  let text = fn(v) { json.nullable(v, json.string) }
  json.object([
    #("id", id.root_request_json(a.id)),
    #("status", row.status_to_json(a.status)),
    #("orgName", json.string(a.org_name)),
    #("orgType", ver_org_type.to_json(a.org_type)),
    #("country", json.string(a.country)),
    #("federation", text(a.federation)),
    #("website", json.string(a.website)),
    #("domain", json.string(a.domain)),
    #("applicantName", json.string(a.applicant_name)),
    #("applicantRole", json.string(a.applicant_role)),
    #("workEmail", json.string(a.work_email)),
    #("officialContact", text(a.official_contact)),
    #("declarations", case a.declared_authorised {
      Some(b) -> json.object([#("authorised", json.bool(b))])
      None -> json.null()
    }),
    #("checks", checks_json(a)),
    #("emailProved", json.bool(a.email_proved)),
    #("existingOrgId", json.nullable(a.existing_org_id, id.org_json)),
    #("createdAt", json.int(a.created_at)),
    #("decidedAt", json.nullable(a.decided_at, json.int)),
    #("decidedBy", text(a.decided_by_name)),
    #("decidedById", text(a.decided_by_id)),
    #(
      "decisionAttribution",
      json.nullable(a.decision_attribution, attribution.to_json),
    ),
    #("decisionReason", text(a.decision_reason)),
    #("resultOrgId", json.nullable(a.result_org_id, id.org_json)),
    #("resultUserId", json.nullable(a.result_user_id, id.org_user_json)),
    #("identityLink", json.nullable(a.identity_link, identity_link.to_json)),
    #("reviewReasons", json.array(reasons, ver_code.to_json)),
    #("riskFlags", json.array(flags, ver_code.to_json)),
    #("evidenceIds", json.array(evidence, id.evidence_json)),
  ])
}

fn checks_json(a: Application) -> Json {
  let outcome = check_outcome.to_json
  json.object([
    #("emailSyntax", row.check_email_syntax_to_json(a.check_email_syntax)),
    #(
      "emailDomainAlignment",
      row.check_email_domain_alignment_to_json(a.check_email_domain_alignment),
    ),
    #("freeEmailProvider", outcome(a.check_free_email_provider)),
    #("disposableEmail", outcome(a.check_disposable_email)),
    #("domainNormalized", json.string(a.check_domain_normalized)),
    #("dnsOwnership", row.check_dns_ownership_to_json(a.check_dns_ownership)),
    #("duplicateOrganisation", outcome(a.check_duplicate_organisation)),
    #("duplicateRequest", outcome(a.check_duplicate_request)),
    #(
      "domainAlreadyVerifiedElsewhere",
      outcome(a.check_domain_already_verified_elsewhere),
    ),
    #(
      "evidenceCompleteness",
      row.check_evidence_completeness_to_json(a.check_evidence_completeness),
    ),
  ])
}

// ------------------------------------------------------------------------------------------- the applicant

type Form {
  Form(
    org_name: Option(String),
    org_type: Option(ver_org_type.VerOrgType),
    country: Option(String),
    website: Option(String),
    applicant_name: Option(String),
    applicant_role: Option(String),
    work_email: Option(String),
    federation: Option(String),
    domain: Option(String),
    official_contact: Option(String),
    authorised: Option(Bool),
  )
}

fn secret_hex() -> String {
  string.lowercase(bit_array.base16_encode(crypto.strong_random_bytes(18)))
}

fn by_org_name(read: Read, name: String) -> Result(Option(orgs.Org), Fail(e)) {
  case string.trim(name) {
    "" -> Ok(None)
    trimmed ->
      store.one(
        read,
        "SELECT id FROM orgs WHERE lower(name) = lower(?) ORDER BY rowid LIMIT 1",
        [sqlight.text(trimmed)],
        decode.at([0], id.org_decoder()),
      )
      |> result.try(fn(found) {
        case found {
          Ok(id) -> orgs.by_id(read, id)
          Error(Nil) -> Ok(None)
        }
      })
  }
}

/// `POST /auth/org/verification/apply`: a public application, with its automated checks. DNS and https probing
/// are not implemented, so they are recorded as `not_configured`, never faked.
pub fn apply(ctx: Ctx, req: Request) -> Response {
  let shape = {
    use org_name <- input.field("orgName", input.nullish(input.text(120)))
    use org_type <- input.field(
      "orgType",
      input.nullish(input.one_of(ver_org_type.pairs)),
    )
    use country <- input.field("country", input.nullish(input.text(40)))
    use website <- input.field("website", input.nullish(input.text(200)))
    use applicant_name <- input.field(
      "applicantName",
      input.nullish(input.text(80)),
    )
    use applicant_role <- input.field(
      "applicantRole",
      input.nullish(input.text(60)),
    )
    use work_email <- input.field("workEmail", input.nullish(input.text(254)))
    use federation <- input.field("federation", input.nullish(input.text(80)))
    use domain <- input.field("domain", input.nullish(input.text(253)))
    use official_contact <- input.field(
      "officialContact",
      input.nullish(input.text(200)),
    )
    use declarations <- input.field(
      "declarations",
      input.nullish(
        input.object({
          use authorised <- input.field(
            "authorised",
            input.required(input.boolean()),
          )
          input.done(authorised)
        }),
      ),
    )
    input.done(Form(
      org_name:,
      org_type:,
      country:,
      website:,
      applicant_name:,
      applicant_role:,
      work_email:,
      federation:,
      domain:,
      official_contact:,
      authorised: declarations,
    ))
  }
  use b <- http.body(req, shape, [#("orgType", "ORG_TYPE_UNKNOWN")])
  let missing =
    [
      #("orgName", b.org_name),
      #("orgType", option.map(b.org_type, ver_org_type.to_string)),
      #("country", b.country),
      #("website", b.website),
      #("applicantName", b.applicant_name),
      #("applicantRole", b.applicant_role),
      #("workEmail", b.work_email),
    ]
    |> list.filter_map(fn(p) {
      case input.filled(p.1) {
        None -> Ok(p.0)
        Some(_) -> Error(Nil)
      }
    })
  case missing, b.org_type, b.work_email {
    [_, ..], _, _ | _, None, _ | _, _, None ->
      http.json(
        400,
        json.object([
          #("error", json.string("FIELDS_REQUIRED")),
          #("missing", json.array(missing, json.string)),
          #("problem", json.string("required")),
        ]),
      )
    [], Some(org_type), Some(work_email) ->
      case claims.email_problem(work_email) {
        Some(p) ->
          http.json(
            400,
            json.object([
              #("error", json.string(claims.email_problem_code(p))),
              #("field", json.string("workEmail")),
            ]),
          )
        None -> applying(ctx, req, b, org_type, work_email)
      }
  }
}

fn applying(
  ctx: Ctx,
  req: Request,
  b: Form,
  org_type: ver_org_type.VerOrgType,
  work_email: String,
) -> Response {
  let now = clock.now_ms()
  let unwrap = fn(v) { option.unwrap(v, "") }
  let org_name = unwrap(b.org_name)
  let domain =
    claims.normalize_domain(case b.domain {
      Some(d) if d != "" -> d
      _ -> unwrap(b.website)
    })
  let email_domain = claims.domain_of_email(work_email)
  let secret = secret_hex()
  let flag = fn(c) {
    case c {
      True -> check_outcome.Flagged
      False -> check_outcome.Passed
    }
  }
  use tx <- act(ctx)
  let read = store.reading(tx)
  use dup_org <- result.try(by_org_name(read, org_name))
  use dup_domain_org <- result.try(case domain {
    "" -> Ok(None)
    d -> records.domain_verified_elsewhere(read, d, None)
  })
  use dup_request <- result.try(store.one(
    read,
    "SELECT 1 FROM ver_root_requests WHERE status IN ('requires_human_review','collecting_evidence') AND (domain = ? OR lower(trim(org_name)) = ?)",
    [
      sqlight.text(domain),
      sqlight.text(string.lowercase(string.trim(org_name))),
    ],
    decode.success(Nil),
  ))
  let application =
    row.Row(
      // Not stored: the checks run on the application before it has an id.
      id: id.root_request(""),
      status: row.CollectingEvidence,
      org_name: string.trim(org_name),
      org_type:,
      country: unwrap(b.country),
      federation: input.filled(b.federation)
        |> option.map(fn(_) { unwrap(b.federation) }),
      website: unwrap(b.website),
      domain:,
      applicant_name: string.trim(unwrap(b.applicant_name)),
      applicant_role: string.trim(unwrap(b.applicant_role)),
      work_email: string.lowercase(work_email),
      official_contact: case b.official_contact {
        Some("") | None -> None
        some -> some
      },
      declared_authorised: b.authorised,
      check_email_syntax: row.CheckEmailSyntaxPassed,
      check_email_domain_alignment: case
        claims.domain_covered(email_domain, domain)
      {
        True -> row.CheckEmailDomainAlignmentPassed
        False -> row.Mismatch
      },
      check_free_email_provider: flag(claims.is_free_mail(email_domain)),
      check_disposable_email: flag(claims.is_disposable(email_domain)),
      check_domain_normalized: case domain {
        "" -> "(none)"
        d -> d
      },
      check_dns_ownership: row.NotConfigured,
      check_duplicate_organisation: flag(dup_org != None),
      check_duplicate_request: flag(result.is_ok(dup_request)),
      check_domain_already_verified_elsewhere: flag(dup_domain_org != None),
      check_evidence_completeness: row.PendingEmailProof,
      email_proved: False,
      existing_org_id: option.map(dup_org, fn(o) { o.id }),
      applicant_secret_hash: core.sha256_hex(secret),
      created_at: now,
      decided_at: None,
      decided_by_name: None,
      decided_by_id: None,
      decision_attribution: None,
      decision_reason: None,
      result_org_id: None,
      result_user_id: None,
      identity_link: None,
    )
  use id <- result.try(id.next_root_request(tx))
  let application = row.Row(..application, id:)
  use _ <- result.try(store.run(tx, row.insert_sql, row.values(application)))
  let flags =
    claims.risk_flags(
      claims.Risk(
        ..claims.no_risk,
        email: Some(work_email),
        org_domains: case domain {
          "" -> []
          d -> [d]
        },
      ),
    )
  use _ <- result.try(add_codes(tx, id, code_row.RiskFlag, flags))
  use code <- result.try(core.mint_token(
    tx,
    token_row.RootEmail,
    Some(application.work_email),
    None,
    None,
    None,
    Some(id.root_request_to_string(id)),
    core.work_email_ttl_ms,
    now,
  ))
  use _ <- result.try(core.event(
    tx,
    event_row.ReviewRequested,
    core.system_actor(Some(req)),
    core.About(
      ..core.nothing,
      detail: records.detail([], [
        #("rootRequest", Some(id.root_request_to_string(id))),
        #("checks", Some(checks_line(application))),
      ]),
    ),
    now,
  ))
  store.emit(
    tx,
    SendMail(
      to: application.work_email,
      subject: "Verify your email for the "
        <> application.org_name
        <> " ScoutBox application",
      text: "Your ScoutBox organisation-application code is "
        <> code
        <> "\n\nSingle use, expires in 30 minutes.",
      secrets: [],
    ),
  )
  Ok(http.json(
    201,
    json.object([
      #("requestId", id.root_request_json(id)),
      #("applicantSecret", json.string(secret)),
      #("checks", checks_json(application)),
      #(
        "note",
        json.string(
          "Confirm the emailed code, add supporting evidence, then submit. Domain/email control is evidence of mailbox control — it does not by itself verify the organisation.",
        ),
      ),
    ]),
  ))
}

/// The checks as an event's detail shows an object: `key=value` pairs.
fn checks_line(a: Application) -> String {
  let outcome = check_outcome.to_string
  [
    #("emailSyntax", row.check_email_syntax_to_string(a.check_email_syntax)),
    #(
      "emailDomainAlignment",
      row.check_email_domain_alignment_to_string(a.check_email_domain_alignment),
    ),
    #("freeEmailProvider", outcome(a.check_free_email_provider)),
    #("disposableEmail", outcome(a.check_disposable_email)),
    #("domainNormalized", a.check_domain_normalized),
    #("dnsOwnership", row.check_dns_ownership_to_string(a.check_dns_ownership)),
    #("duplicateOrganisation", outcome(a.check_duplicate_organisation)),
    #("duplicateRequest", outcome(a.check_duplicate_request)),
    #(
      "domainAlreadyVerifiedElsewhere",
      outcome(a.check_domain_already_verified_elsewhere),
    ),
    #(
      "evidenceCompleteness",
      row.check_evidence_completeness_to_string(a.check_evidence_completeness),
    ),
  ]
  |> list.map(fn(p) { p.0 <> "=" <> p.1 })
  |> string.join(" ")
}

/// The application the id names, when the secret is its own (in the body, or an older client's query string).
fn with_secret(
  read: Read,
  req: Request,
  request_id: id.RootRequestId,
  body_secret: Option(String),
) -> Result(Option(Application), Fail(e)) {
  let query_secret =
    wisp.get_query(req) |> list.key_find("applicantSecret") |> result.unwrap("")
  let secret = case body_secret {
    Some(s) -> s
    None -> query_secret
  }
  let hash = core.sha256_hex(secret)
  use found <- result.map(by_id(read, request_id))
  case found {
    Some(a) if a.applicant_secret_hash == hash -> found
    _ -> None
  }
}

fn not_found() -> Response {
  http.error(404, "REQUEST_NOT_FOUND")
}

/// `POST /auth/org/verification/apply/:id/confirm-email`.
pub fn confirm_email(
  ctx: Ctx,
  req: Request,
  request_id: id.RootRequestId,
) -> Response {
  let shape = {
    use secret <- input.field("applicantSecret", input.nullish(input.text(64)))
    use code <- input.field("code", input.nullish(input.text(64)))
    input.done(#(secret, code))
  }
  use #(secret, code) <- http.body(req, shape, [])
  let now = clock.now_ms()
  use tx <- act(ctx)
  let read = store.reading(tx)
  use found <- result.try(with_secret(read, req, request_id, secret))
  case found {
    None -> stop(not_found())
    Some(a) -> {
      use peek <- result.try(core.peek_token(
        read,
        token_row.RootEmail,
        code,
        Some(a.work_email),
        None,
        now,
      ))
      // A token's `ref_id` is polymorphic text.
      let own = Some(id.root_request_to_string(a.id))
      case peek {
        Error(code) -> {
          use _ <- result.try(core.count(tx, "emailChallengeFailures"))
          reply(http.error(401, code))
        }
        Ok(t) if t.ref_id != own -> {
          // A code for another application is spent and refused.
          use _ <- result.try(records.use_token(tx, t.id, now))
          use _ <- result.try(core.count(tx, "emailChallengeFailures"))
          reply(http.error(401, "TOKEN_WRONG_PURPOSE"))
        }
        Ok(t) -> {
          use _ <- result.try(records.use_token(tx, t.id, now))
          use _ <- result.try(rewrite(
            tx,
            row.Row(
              ..a,
              email_proved: True,
              check_evidence_completeness: row.EmailProved,
            ),
            "1 = 1",
          ))
          use _ <- result.try(core.event(
            tx,
            event_row.EmailChallengePassed,
            core.system_actor(Some(req)),
            core.About(
              ..core.nothing,
              detail: records.detail([], [
                #("rootRequest", Some(id.root_request_to_string(a.id))),
              ]),
            ),
            now,
          ))
          reply(http.json(200, json.object([#("emailProved", json.bool(True))])))
        }
      }
    }
  }
}

/// `POST /auth/org/verification/apply/:id/uploads`: an applicant's document, to name to the evidence route.
pub fn upload(
  ctx: Ctx,
  req: Request,
  request_id: id.RootRequestId,
) -> Response {
  let shape = {
    use secret <- input.field("applicantSecret", input.nullish(input.text(64)))
    use d <- uploads.declared([upload_row.VerificationEvidence])
    input.done(#(secret, d))
  }
  use #(secret, d) <- http.body(req, shape, uploads.codes)
  case
    store.read(ctx.store, fn(read) {
      with_secret(read, req, request_id, secret)
    })
  {
    Error(failure) -> http.internal(failure)
    Ok(None) -> not_found()
    Ok(Some(a)) -> uploads.open(ctx, uploads.Applicant(a.id), d)
  }
}

/// `POST /auth/org/verification/apply/:id/evidence`.
pub fn evidence(
  ctx: Ctx,
  req: Request,
  request_id: id.RootRequestId,
) -> Response {
  let shape = {
    use secret <- input.field("applicantSecret", input.nullish(input.text(64)))
    use data_url <- input.field(
      "dataUrl",
      input.nullish(input.text(100_000_000)),
    )
    use filename <- input.field("filename", input.nullish(input.text(120)))
    use note <- input.field("note", input.nullish(input.text(400)))
    input.done(#(secret, data_url, filename, note))
  }
  use #(secret, data_url, filename, note) <- http.body(req, shape, [])
  let now = clock.now_ms()
  let note = input.filled(note)
  let file = case data_url {
    Some(url) if url != "" -> Some(core.evidence_file(ctx, url, filename))
    _ -> None
  }
  use tx <- act(ctx)
  let read = store.reading(tx)
  use found <- result.try(with_secret(read, req, request_id, secret))
  case found {
    None -> stop(not_found())
    Some(a) ->
      case a.status, file, note {
        row.CollectingEvidence, Some(Error(code)), _
        | row.RequiresHumanReview, Some(Error(code)), _
        -> stop(http.error(422, code))
        row.CollectingEvidence, None, None
        | row.RequiresHumanReview, None, None
        -> stop(http.error(400, "EVIDENCE_REQUIRED"))
        row.CollectingEvidence, _, _ | row.RequiresHumanReview, _, _ -> {
          let file = case file {
            Some(Ok(f)) -> Some(f)
            _ -> None
          }
          use dup <- result.try(case file {
            Some(f) -> records.digest_seen(read, f.sha256, None)
            None -> Ok(False)
          })
          use ev <- result.try(core.add_evidence(
            tx,
            fn(evidence_id) {
              let ev =
                evidence_row.Row(
                  ..core.blank_evidence(
                    evidence_id,
                    evidence_row.Document,
                    "root_application",
                    evidence_row.Applicant,
                    now,
                  ),
                  supplied_by_id: Some(id.root_request_to_string(a.id)),
                  note: Some(option.unwrap(note, "")),
                  root_request_id: Some(a.id),
                )
              case file {
                Some(f) -> core.with_file(ev, f)
                None -> ev
              }
            },
            [],
            core.system_actor(Some(req)),
            now,
          ))
          use _ <- result.try(case dup {
            True ->
              add_codes(tx, a.id, code_row.RiskFlag, [
                ver_code.DuplicateEvidenceHash,
              ])
            False -> Ok(Nil)
          })
          reply(http.json(
            201,
            json.object([
              #(
                "evidence",
                json.object([
                  #("id", id.evidence_json(ev.id)),
                  #("checks", core.evidence_checks(ev)),
                ]),
              ),
            ]),
          ))
        }
        _, _, _ -> stop(http.error(409, "REQUEST_CLOSED"))
      }
  }
}

/// `POST /auth/org/verification/apply/:id/submit`: a first administrator with no ScoutBox authority behind them is
/// always a human decision.
pub fn submit(
  ctx: Ctx,
  req: Request,
  request_id: id.RootRequestId,
) -> Response {
  let shape = {
    use secret <- input.field("applicantSecret", input.nullish(input.text(64)))
    input.done(secret)
  }
  use secret <- http.body(req, shape, [])
  let now = clock.now_ms()
  use tx <- act(ctx)
  let read = store.reading(tx)
  use found <- result.try(with_secret(read, req, request_id, secret))
  case found {
    None -> stop(not_found())
    Some(a) if a.status != row.CollectingEvidence ->
      stop(http.error(409, "ALREADY_SUBMITTED"))
    Some(a) if !a.email_proved ->
      stop(http.error_message(
        422,
        "EMAIL_NOT_PROVED",
        "Confirm the emailed code first.",
      ))
    Some(a) -> {
      use flags <- result.try(codes(read, a.id, code_row.RiskFlag))
      let review =
        claims.decide_review(
          claims.Case(
            ..claims.plain_case,
            claim_type: Some(claim_type.OrganisationIdentity),
            is_first_org_admin: True,
            duplicate_org: a.check_duplicate_organisation
              == check_outcome.Flagged
              || a.check_domain_already_verified_elsewhere
              == check_outcome.Flagged,
            domain_ambiguous: a.check_email_domain_alignment == row.Mismatch,
            risk_flag_count: list.length(flags),
          ),
        )
      use moved <- result.try(rewrite(
        tx,
        row.Row(..a, status: row.RequiresHumanReview),
        "status = 'collecting_evidence'",
      ))
      let assert True = moved as "a collecting application moves to review"
      use _ <- result.try(
        store.run(
          tx,
          "DELETE FROM ver_root_request_codes WHERE root_request_id = ? AND list = 'review_reason'",
          [id.root_request_sql(a.id)],
        ),
      )
      use _ <- result.try(add_codes(
        tx,
        a.id,
        code_row.ReviewReason,
        review.reasons,
      ))
      use _ <- result.try(core.event(
        tx,
        event_row.ReviewRequested,
        core.system_actor(Some(req)),
        core.About(
          ..core.nothing,
          detail: records.detail([], [
            #("rootRequest", Some(id.root_request_to_string(a.id))),
            #(
              "reasons",
              Some(string.join(
                list.map(review.reasons, ver_code.to_string),
                ", ",
              )),
            ),
          ]),
        ),
        now,
      ))
      use _ <- result.try(core.count(tx, "routedToHumanReview"))
      reply(http.json(
        200,
        json.object([
          #("status", json.string("requires_human_review")),
          #("reasons", json.array(review.reasons, ver_code.to_json)),
          #(
            "explanation",
            json.string(
              "ScoutBox has confirmed control of a "
              <> claims.domain_of_email(a.work_email)
              <> " mailbox, but an authorised organisation administrator has not yet been established — Trust & Safety reviews the application and the evidence before the first administrator is appointed.",
            ),
          ),
        ]),
      ))
    }
  }
}

/// `GET /auth/org/verification/apply/:id/status?applicantSecret=…`.
pub fn status(
  ctx: Ctx,
  req: Request,
  request_id: id.RootRequestId,
) -> Response {
  let shape = {
    use secret <- input.field("applicantSecret", input.optional(input.text(64)))
    input.done(secret)
  }
  use secret <- http.query(req, shape, [])
  let hash = core.sha256_hex(option.unwrap(secret, ""))
  use read <- core.look(ctx)
  use found <- result.try(by_id(read, request_id))
  case found {
    Some(a) if a.applicant_secret_hash == hash -> {
      use reasons <- result.map(codes(read, a.id, code_row.ReviewReason))
      http.json(
        200,
        json.object([
          #("id", id.root_request_json(a.id)),
          #("status", row.status_to_json(a.status)),
          #("checks", checks_json(a)),
          #("reviewReasons", json.array(reasons, ver_code.to_json)),
          #("decisionReason", json.nullable(a.decision_reason, json.string)),
          #("resultOrgId", json.nullable(a.result_org_id, id.org_json)),
        ]),
      )
    }
    _ -> Ok(not_found())
  }
}

// ------------------------------------------------------------------------------------------- Trust & Safety

type Approval {
  Approval(reason: String, link_user_id: Option(String), provision: Bool)
}

fn reason_required() -> Response {
  http.json(
    400,
    json.object([
      #("error", json.string("REASON_REQUIRED")),
      #("field", json.string("reason")),
      #("problem", json.string("required")),
      #(
        "message",
        json.string(
          "Manual verification decisions require a written reason — it is audited.",
        ),
      ),
    ]),
  )
}

/// `POST /admin/verification/root-requests/:id/approve`: the organisation is verified and its first root
/// administrator established.
pub fn approve(
  ctx: Ctx,
  req: Request,
  request_id: id.RootRequestId,
) -> Response {
  let shape = {
    use reason <- input.field("reason", input.nullish(input.text(400)))
    use link <- input.field("linkUserId", input.nullish(input.id()))
    use provision <- input.field(
      "provisionNewUser",
      input.optional(input.boolean()),
    )
    input.done(#(reason, link, provision))
  }
  let parsed = http.parse_body(req, shape, [])
  let now = clock.now_ms()
  let reviewer = reviewer.of(req)
  use tx <- act(ctx)
  let read = store.reading(tx)
  use found <- result.try(by_id(read, request_id))
  case found, parsed {
    None, _ -> stop(not_found())
    _, Error(response) -> stop(response)
    Some(a), Ok(#(reason, link, provision)) ->
      case input.filled(reason) {
        None -> stop(reason_required())
        Some(reason) ->
          case a.status {
            row.RequiresHumanReview ->
              approving(
                tx,
                req,
                a,
                Approval(
                  reason:,
                  link_user_id: link,
                  provision: provision == Some(True),
                ),
                reviewer,
                now,
              )
            s ->
              stop(http.error_message(
                409,
                "REQUEST_NOT_DECIDABLE",
                "Request is " <> row.status_to_string(s) <> ".",
              ))
          }
      }
  }
}

fn norm(s: String) -> String {
  s |> string.trim |> string.lowercase
}

fn approving(
  tx: Tx,
  req: Request,
  a: Application,
  body: Approval,
  reviewer: reviewer.Reviewer,
  now: Int,
) -> core.Done {
  let read = store.reading(tx)
  use existing <- result.try(case a.existing_org_id {
    Some(org_id) -> orgs.by_id(read, org_id)
    None -> Ok(None)
  })
  use active <- result.try(case existing {
    Some(o) -> staff.for_org(read, o.id, active_only: True)
    None -> Ok([])
  })
  let email_matches = case a.email_proved {
    True ->
      list.filter(active, fn(u) {
        option.map(u.email, string.lowercase) == Some(a.work_email)
      })
    False -> []
  }
  let name_candidates =
    list.filter(active, fn(u) {
      norm(u.name) == norm(a.applicant_name) && !list.contains(email_matches, u)
    })
  use #(user, link) <- result.try(
    case body.link_user_id, body.provision, email_matches {
      Some(link_id), _, _ ->
        // From the request body.
        case list.find(active, fn(u) { u.id == id.org_user(link_id) }) {
          Ok(u) -> Ok(#(Some(u), Some(identity_link.TrustSafetySelection)))
          Error(Nil) ->
            stop(http.error_message(
              404,
              "LINK_USER_NOT_FOUND",
              "linkUserId must be an active user of the target organisation.",
            ))
        }
      None, True, _ -> Ok(#(None, Some(identity_link.ProvisionedNewUser)))
      None, False, [u] -> Ok(#(Some(u), Some(identity_link.VerifiedWorkEmail)))
      None, False, matches ->
        case matches, name_candidates {
          [], [] -> Ok(#(None, None))
          _, _ ->
            stop(http.json(
              409,
              json.object([
                #("error", json.string("AMBIGUOUS_APPLICANT_IDENTITY")),
                #(
                  "message",
                  json.string(
                    "Existing accounts could be the applicant. A name match never links identity automatically — choose the intended account explicitly (linkUserId) or provision a new one (provisionNewUser: true).",
                  ),
                ),
                #(
                  "candidates",
                  json.array(list.append(matches, name_candidates), fn(u) {
                    json.object([
                      #("id", id.org_user_json(u.id)),
                      #("name", json.string(u.name)),
                      #(
                        "matched",
                        json.string(case list.contains(matches, u) {
                          True -> "verified_work_email"
                          False -> "name_similarity_only"
                        }),
                      ),
                    ])
                  }),
                ),
              ]),
            ))
        }
    },
  )
  // Staff sign in by name, so a new account cannot take a name an account of the organisation already has
  // (removed accounts included).
  use name_taken <- result.try(case user, existing {
    None, Some(o) ->
      staff.by_org_and_name(read, o.id, a.applicant_name)
      |> result.map(option.is_some)
    _, _ -> Ok(False)
  })
  use <- bool.lazy_guard(name_taken, fn() {
    stop(http.error_message(
      409,
      "STAFF_NAME_TAKEN",
      "An account of this organisation (current or removed) already has the applicant's name. Link it (linkUserId) if it is a current account and the applicant's; otherwise reject the request and ask the applicant to re-apply under a name that tells them apart.",
    ))
  })
  // A work e-mail belongs to one current staff member of the organisation.
  use holder <- result.try(case existing {
    Some(o) -> staff.active_by_email(read, o.id, a.work_email)
    None -> Ok(None)
  })
  let user_id = option.map(user, fn(u) { u.id })
  let user_has_email = case user {
    Some(u) -> u.email != None
    None -> False
  }
  use <- bool.lazy_guard(
    case holder {
      Some(h) -> Some(h.id) != user_id && !user_has_email
      None -> False
    },
    fn() {
      stop(http.error_message(
        409,
        "STAFF_EMAIL_TAKEN",
        "Another current staff member of this organisation has the applicant's work e-mail. Link that account (linkUserId) if it is the applicant's.",
      ))
    },
  )
  let link = option.unwrap(link, identity_link.ProvisionedNewUser)
  use org <- result.try(case existing {
    Some(o) -> Ok(o)
    None -> register(tx, a, now)
  })
  use user <- result.try(case user {
    None ->
      staff.create(
        tx,
        staff.NewStaff(
          org_id: org.id,
          name: string.trim(a.applicant_name),
          role: case string.trim(a.applicant_role) {
            "" -> "Manager"
            r -> r
          },
          email: Some(a.work_email),
          provenance: None,
          created_at: now,
        ),
      )
      |> store.map_refusal(fn(_) { http.error(500, "INTERNAL") })
    Some(u) ->
      case u.email {
        None ->
          staff.set_email(tx, u.id, Some(a.work_email))
          |> store.map_refusal(fn(_) { http.error(500, "INTERNAL") })
        Some(_) -> Ok(u)
      }
  })
  let trust_safety = fn(c: claims.Claim) {
    claim_row.Row(
      ..c,
      status: claim_row.Verified,
      verified_at: Some(now),
      verified_by_kind: Some(actor_kind.TrustSafety),
      verified_by_id: Some(reviewer.id),
      root_request_id: Some(a.id),
    )
  }
  use evidence <- result.try(evidence_ids(read, a.id))
  use identity_claim <- result.try(core.create_claim(
    tx,
    fn(claim_id) {
      claim_row.Row(
        ..trust_safety(core.blank_claim(
          claim_id,
          claim_row.Org,
          id.org_to_string(org.id),
          claim_type.OrganisationIdentity,
          now,
        )),
        organisation_id: Some(org.id),
        verification_method: Some(verification_method.ScoutboxManualReview),
        org_type: Some(a.org_type),
        website: Some(a.website),
      )
    },
    core.system_actor(None),
    now,
  ))
  use _ <- result.try(
    list.try_each(evidence, fn(ev_id) {
      use have <- result.try(records.evidence_ids(read, identity_claim.id))
      store.run(
        tx,
        "INSERT INTO ver_claim_evidence (claim_id, position, evidence_id) VALUES (?, ?, ?)",
        [
          id.claim_sql(identity_claim.id),
          sqlight.int(list.length(have)),
          id.evidence_sql(ev_id),
        ],
      )
    }),
  )
  // Minors still also need the safeguarding contract.
  use _ <- result.try(orgs.set_standing(
    tx,
    org.id,
    orgs.Standing(
      verified: Some(True),
      safeguarding_contract_signed: None,
      suspended: None,
      verified_domain: None,
    ),
  ))
  // A domain claim only where the mailbox proof aligns with the stated domain.
  use _ <- result.try(
    case
      a.email_proved
      && a.domain != ""
      && claims.domain_covered(claims.domain_of_email(a.work_email), a.domain)
    {
      False -> Ok(Nil)
      True -> {
        use domains <- result.try(core.verified_domains_of(read, org.id))
        use _ <- result.try(case list.contains(domains, a.domain) {
          True -> Ok(Nil)
          False ->
            records.add_domain(tx, org_verified_domain(org.id, a.domain, now))
        })
        core.create_claim(
          tx,
          fn(claim_id) {
            claim_row.Row(
              ..trust_safety(core.blank_claim(
                claim_id,
                claim_row.Org,
                id.org_to_string(org.id),
                claim_type.OrganisationDomain,
                now,
              )),
              organisation_id: Some(org.id),
              verification_method: Some(verification_method.OfficialDomainEmail),
              domain: Some(a.domain),
            )
          },
          core.system_actor(None),
          now,
        )
        |> result.replace(Nil)
      }
    },
  )
  use _ <- result.try(core.create_claim(
    tx,
    fn(claim_id) {
      claim_row.Row(
        ..trust_safety(core.blank_claim(
          claim_id,
          claim_row.User,
          id.org_user_to_string(user.id),
          claim_type.OrganisationAdmin,
          now,
        )),
        organisation_id: Some(org.id),
        verification_method: Some(verification_method.ScoutboxManualReview),
        admin_level: Some(ver_level.VerificationRootAdmin),
        identity_link: Some(link),
      )
    },
    core.system_actor(None),
    now,
  ))
  use grants <- result.try(records.active_admins_of(read, org.id))
  use _ <- result.try(
    case
      list.any(grants, fn(g) {
        g.user_id == user.id && g.level == ver_level.VerificationRootAdmin
      })
    {
      True -> Ok(Nil)
      False -> {
        use admin_id <- result.try(id.next_ver_admin(tx))
        records.create_admin(
          tx,
          admin_row.Row(
            id: admin_id,
            org_id: org.id,
            user_id: user.id,
            level: ver_level.VerificationRootAdmin,
            status: admin_row.Active,
            invited_by: "trust_safety",
            created_at: now,
            accepted_at: Some(now),
            revoked_at: None,
            revoked_by: None,
          ),
        )
        |> result.replace(Nil)
      }
    },
  )
  let decided =
    row.Row(
      ..a,
      status: row.Approved,
      decided_at: Some(now),
      decided_by_name: Some(reviewer.name),
      decided_by_id: Some(reviewer.id),
      decision_attribution: Some(reviewer.attribution),
      decision_reason: Some(body.reason),
      identity_link: Some(link),
      result_org_id: Some(org.id),
      result_user_id: Some(user.id),
    )
  use moved <- result.try(rewrite(
    tx,
    decided,
    "status = 'requires_human_review'",
  ))
  let assert True = moved as "an application awaiting review is decided once"
  use _ <- result.try(core.event(
    tx,
    event_row.ReviewApproved,
    reviewer.actor(req),
    core.About(
      ..core.nothing,
      org_id: Some(org.id),
      subject_id: Some(id.org_user_to_string(user.id)),
      detail: records.detail([], [
        #("rootRequest", Some(id.root_request_to_string(a.id))),
        #("org", Some(id.org_to_string(org.id))),
        #("rootAdmin", Some(id.org_user_to_string(user.id))),
        #("identityLink", Some(identity_link.to_string(link))),
      ]),
      reason: Some(body.reason),
      attribution: Some(reviewer.attribution),
    ),
    now,
  ))
  use _ <- result.try(ledger.append(
    tx,
    ledger.Entry(
      event: ledger.VerificationRootApproved(a.id),
      player_id: None,
      org_id: Some(org.id),
      org_name: None,
      user_id: None,
      actor_name: None,
    ),
    now,
  ))
  use request <- result.try(record(read, decided))
  reply(http.json(
    200,
    json.object([
      #("request", request),
      #("orgId", id.org_json(org.id)),
      #("rootAdminUserId", id.org_user_json(user.id)),
      #("identityLink", identity_link.to_json(link)),
      #(
        "note",
        json.string(
          "The organisation is verified and its first root administrator is established. Staff verification is now self-service through the club. Sign-in credentials are provisioned separately (POST /admin/clubs/:id/credentials).",
        ),
      ),
    ]),
  ))
}

fn org_verified_domain(org_id: id.OrgId, domain: String, now: Int) {
  records.verified_domain(
    org_id,
    domain,
    records.DomainByEmail,
    now,
    "root_request",
  )
}

/// A new organisation for an approved application. The placeholder ground of a grassroots club is a known issue
/// of the TypeScript server, kept as it is.
fn register(tx: Tx, a: Application, now: Int) -> Result(orgs.Org, Fail(e)) {
  use id <- result.try(id.next_org(tx))
  let grassroots = a.org_type == ver_org_type.GrassrootsClub
  let federation =
    option.map(a.federation, string.trim)
    |> option.then(fn(f) {
      case f {
        "" -> None
        f -> Some(f)
      }
    })
  let org =
    org_row.Row(
      ..org_row.new(
        id:,
        name: string.trim(a.org_name),
        type_: case a.org_type {
          ver_org_type.Agency -> org_type.Agency
          _ -> org_type.Club
        },
        plan: case grassroots {
          True -> org_row.PlanGrassroots
          False -> org_row.PlanPro
        },
        created_at: now,
      ),
      level: case grassroots {
        True -> Some(org_row.LevelGrassroots)
        False -> None
      },
      country: case string.trim(a.country) {
        "" -> None
        c -> Some(c)
      },
      lat: case grassroots {
        True -> Some(51.5)
        False -> None
      },
      lng: case grassroots {
        True -> Some(-0.1)
        False -> None
      },
      federation: case grassroots {
        True -> federation
        False -> None
      },
      federation_registration_id: case grassroots, federation {
        True, Some(_) -> Some("pending")
        _, _ -> None
      },
    )
  use _ <- result.try(org_row.insert(tx, org))
  use found <- result.map(orgs.by_id(store.reading(tx), id))
  let assert Some(org) = found as "an organisation just registered exists"
  org
}

/// `POST /admin/verification/root-requests/:id/reject`.
pub fn reject(
  ctx: Ctx,
  req: Request,
  request_id: id.RootRequestId,
) -> Response {
  let shape = {
    use reason <- input.field("reason", input.nullish(input.text(400)))
    input.done(reason)
  }
  let parsed = http.parse_body(req, shape, [])
  let now = clock.now_ms()
  let reviewer = reviewer.of(req)
  use tx <- act(ctx)
  let read = store.reading(tx)
  use found <- result.try(by_id(read, request_id))
  case found, parsed {
    None, _ -> stop(not_found())
    _, Error(response) -> stop(response)
    Some(a), Ok(reason) ->
      case input.filled(reason) {
        None -> stop(reason_required())
        Some(reason) ->
          case a.status {
            row.RequiresHumanReview | row.CollectingEvidence -> {
              let decided =
                row.Row(
                  ..a,
                  status: row.Rejected,
                  decided_at: Some(now),
                  decided_by_name: Some(reviewer.name),
                  decided_by_id: Some(reviewer.id),
                  decision_attribution: Some(reviewer.attribution),
                  decision_reason: Some(reason),
                )
              use _ <- result.try(rewrite(
                tx,
                decided,
                "status IN ('requires_human_review','collecting_evidence')",
              ))
              use _ <- result.try(core.event(
                tx,
                event_row.ReviewRejected,
                reviewer.actor(req),
                core.About(
                  ..core.nothing,
                  detail: records.detail([], [
                    #("rootRequest", Some(id.root_request_to_string(a.id))),
                  ]),
                  reason: Some(reason),
                  attribution: Some(reviewer.attribution),
                ),
                now,
              ))
              use request <- result.try(record(read, decided))
              reply(http.json(200, json.object([#("request", request)])))
            }
            _ -> stop(http.error(409, "REQUEST_NOT_DECIDABLE"))
          }
      }
  }
}

/// The applications awaiting Trust & Safety, as its queue shows them.
pub fn queue_rows(
  read: Read,
  country: Option(String),
) -> Result(List(Json), Fail(e)) {
  use pending <- result.try(awaiting_review(read, country))
  list.try_map(pending, record(read, _))
}
