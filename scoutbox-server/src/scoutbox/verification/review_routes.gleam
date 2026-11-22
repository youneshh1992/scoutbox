//// Trust & Safety's verification surface (domains/verification/claims/review.mjs), behind the admin key.
////
//// The admin surface may authenticate with one shared key, which identifies no individual. A request may declare
//// its reviewer in headers; with none declared, events say `shared_admin_key` rather than invent a person.

import gleam/bit_array
import gleam/bool
import gleam/dynamic/decode
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/orgs
import scoutbox/identity/staff
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/config
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/media
import scoutbox/platform/store
import scoutbox/platform/temporal
import scoutbox/rows/id
import scoutbox/rows/ver_admins as admin_row
import scoutbox/rows/ver_claims as claim_row
import scoutbox/rows/ver_disputes as dispute_row
import scoutbox/rows/ver_domain_requests as domain_request_row
import scoutbox/rows/ver_events as event_row
import scoutbox/rows/ver_evidence as evidence_row
import scoutbox/verification/applications
import scoutbox/verification/claims
import scoutbox/verification/conflicts
import scoutbox/verification/core.{act, reply, stop}
import scoutbox/verification/org_admin_routes as org_admin
import scoutbox/verification/personal_routes as personal
import scoutbox/verification/records
import scoutbox/verification/reviewer
import scoutbox/verification/views
import scoutbox/vocab/actor_kind
import scoutbox/vocab/audience
import scoutbox/vocab/claim_type
import scoutbox/vocab/ver_code
import scoutbox/vocab/ver_level
import scoutbox/vocab/verification_method
import sqlight
import wisp.{type Request, type Response}

/// The decision body's reason, required: a manual decision always says why.
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

/// `POST /admin/verification/orgs/:id/appoint-root`: Trust & Safety establishes a verified organisation's first
/// root verification administrator, audited.
pub fn appoint_root(ctx: Ctx, req: Request, org_id: id.OrgId) -> Response {
  let shape = {
    use reason <- input.field("reason", input.nullish(input.text(300)))
    use user_id <- input.field("userId", input.nullish(input.id()))
    // From the request body.
    input.done(#(reason, option.map(user_id, id.org_user)))
  }
  let parsed = http.parse_body(req, shape, [])
  let now = clock.now_ms()
  let reviewer = reviewer.of(req)
  use tx <- act(ctx)
  let read = store.reading(tx)
  use found <- result.try(orgs.by_id(read, org_id))
  case found {
    None -> stop(http.error(404, "ORG_NOT_FOUND"))
    Some(org) ->
      case parsed {
        Error(response) -> stop(response)
        Ok(#(reason, user_id)) ->
          case input.filled(reason) {
            None -> stop(reason_required())
            Some(reason) -> {
              use <- bool.lazy_guard(!org.verified, fn() {
                stop(http.error_message(
                  409,
                  "ORG_NOT_VERIFIED",
                  "Verify the organisation first — root authority only exists inside a verified organisation.",
                ))
              })
              use user <- result.try(case user_id {
                Some(user_id) -> staff.by_id(read, user_id)
                None -> Ok(None)
              })
              case user {
                Some(u) if u.org_id == org.id && u.removed_at == None -> {
                  use grants <- result.try(records.active_admins_of(
                    read,
                    org.id,
                  ))
                  use <- bool.lazy_guard(
                    list.any(grants, fn(a) {
                      a.user_id == u.id
                      && a.level == ver_level.VerificationRootAdmin
                    }),
                    fn() { stop(http.error(409, "ALREADY_ROOT_ADMIN")) },
                  )
                  use id <- result.try(id.next_ver_admin(tx))
                  use _ <- result.try(records.create_admin(
                    tx,
                    admin_row.Row(
                      id:,
                      org_id: org.id,
                      user_id: u.id,
                      level: ver_level.VerificationRootAdmin,
                      status: admin_row.Active,
                      invited_by: "trust_safety",
                      created_at: now,
                      accepted_at: Some(now),
                      revoked_at: None,
                      revoked_by: None,
                    ),
                  ))
                  use _ <- result.try(core.create_claim(
                    tx,
                    fn(id) {
                      claim_row.Row(
                        ..core.blank_claim(
                          id,
                          claim_row.User,
                          id.org_user_to_string(u.id),
                          claim_type.OrganisationAdmin,
                          now,
                        ),
                        organisation_id: Some(org.id),
                        status: claim_row.Verified,
                        verification_method: Some(
                          verification_method.ScoutboxManualReview,
                        ),
                        verified_at: Some(now),
                        verified_by_kind: Some(actor_kind.TrustSafety),
                        verified_by_id: Some(reviewer.id),
                        appointed_reason: Some(reason),
                      )
                    },
                    core.system_actor(None),
                    now,
                  ))
                  use _ <- result.try(notifications.notify(
                    tx,
                    to: audience.OrgUser,
                    id: id.org_user_to_string(u.id),
                    type_: "verification",
                    text: "Trust & Safety appointed you root verification administrator for "
                      <> org.name
                      <> ".",
                    ref_id: Some(id.org_to_string(org.id)),
                    at: now,
                  ))
                  reply(http.json(
                    201,
                    json.object([
                      #("orgId", id.org_json(org.id)),
                      #("rootAdminUserId", id.org_user_json(u.id)),
                    ]),
                  ))
                }
                _ -> stop(http.error(404, "USER_NOT_FOUND"))
              }
            }
          }
      }
  }
}

// ------------------------------------------------------------------------------------------- licences

type Provider {
  Provider(id: String, name: String, state: String)
}

/// The interface a governing-body register implements. Nothing here fakes a network call: providers ship
/// `not_configured`, and only the local test register (TEST_LICENCE_REGISTRY) exercises the adapter.
fn providers(ctx: Ctx) -> List(Provider) {
  [
    Provider(
      "fa-england",
      "The FA coaching qualifications register",
      "not_configured",
    ),
    Provider("uefa", "UEFA coaching licence register", "not_configured"),
    Provider(
      "local-test-registry",
      "Local test registry (fixture — test environments only)",
      case ctx.config.licence_registry {
        config.RegistryUp -> "configured"
        config.RegistryDown -> "temporarily_unavailable"
        config.NoRegistry -> "not_configured"
      },
    ),
  ]
}

type RegistryRow {
  RegistryRow(
    identifier: String,
    holder_name: String,
    licence_type: String,
    valid_until: String,
  )
}

/// The match, ambiguous and no-match paths, for tests only.
const test_registry = [
  RegistryRow("UEFA-A-12345", "diane okafor", "UEFA A Licence", "2028-06-30"),
  RegistryRow("UEFA-B-77777", "sam cole", "UEFA B Licence", "2027-01-31"),
  RegistryRow("AMBIG-001", "alex taylor", "UEFA B Licence", "2027-01-31"),
  RegistryRow("AMBIG-001", "alexis taylor", "UEFA B Licence", "2026-01-31"),
]

type Lookup {
  /// The provider is unknown, unconfigured or unavailable: no answer.
  NoAnswer(state: String)
  Match(RegistryRow)
  Ambiguous
  NoMatch
}

fn lookup(
  ctx: Ctx,
  provider_id: String,
  identifier: Option(String),
  holder: String,
) -> Lookup {
  case list.find(providers(ctx), fn(p) { p.id == provider_id }) {
    Error(Nil) -> NoAnswer("unsupported")
    Ok(p) if p.state != "configured" -> NoAnswer(p.state)
    Ok(_) -> {
      let wanted = string.trim(option.unwrap(identifier, ""))
      let rows = list.filter(test_registry, fn(r) { r.identifier == wanted })
      let holder = holder |> string.trim |> string.lowercase
      case rows, list.filter(rows, fn(r) { r.holder_name == holder }) {
        [], _ -> NoMatch
        [_], [row] -> Match(row)
        _, _ -> Ambiguous
      }
    }
  }
}

/// `GET /org/verification/licence-providers`.
pub fn licence_providers(ctx: Ctx) -> Response {
  http.json(
    200,
    json.object([
      #(
        "providers",
        json.array(providers(ctx), fn(p) {
          json.object([
            #("id", json.string(p.id)),
            #("name", json.string(p.name)),
            #("state", json.string(p.state)),
          ])
        }),
      ),
      #(
        "note",
        json.string(
          "No production governing-body register is connected. Providers listed not_configured are real integration points, not working integrations.",
        ),
      ),
    ]),
  )
}

type NewLicence {
  NewLicence(
    licence_type: Option(String),
    issuer: Option(String),
    identifier: Option(String),
    holder_name: Option(String),
    issue_date: Option(temporal.Due),
    expiry: Option(temporal.Due),
    data_url: Option(String),
    filename: Option(String),
  )
}

/// `POST /org/verification/licence`: a credential, submitted. An upload is a document, never a verified licence.
pub fn new_licence(ctx: Ctx, req: Request, access: OrgAccess) -> Response {
  let shape = {
    use licence_type <- input.field(
      "licenceType",
      input.nullish(input.text(80)),
    )
    use issuer <- input.field("issuer", input.nullish(input.text(80)))
    use identifier <- input.field("identifier", input.nullish(input.text(60)))
    use holder_name <- input.field("holderName", input.nullish(input.text(80)))
    use issue_date <- input.field("issueDate", input.optional(input.due_date()))
    use expiry <- input.field("expiry", input.optional(input.due_date()))
    use data_url <- input.field(
      "dataUrl",
      input.nullish(input.text(100_000_000)),
    )
    use filename <- input.field("filename", input.nullish(input.text(120)))
    input.done(NewLicence(
      licence_type:,
      issuer:,
      identifier:,
      holder_name:,
      issue_date: option.flatten(issue_date),
      expiry: option.flatten(expiry),
      data_url:,
      filename:,
    ))
  }
  use body <- http.body(req, shape, [])
  let licence_type = input.filled(body.licence_type)
  let issuer = input.filled(body.issuer)
  let missing =
    list.flatten([
      case licence_type {
        None -> ["licenceType"]
        Some(_) -> []
      },
      case issuer {
        None -> ["issuer"]
        Some(_) -> []
      },
    ])
  // A day-only expiry covers the whole day.
  let expires = option.map(body.expiry, temporal.end)
  let issued = option.map(body.issue_date, temporal.start)
  let file = case body.data_url {
    Some(url) if url != "" -> Some(core.evidence_file(ctx, url, body.filename))
    _ -> None
  }
  case missing, issued, expires, file {
    [_, ..], _, _, _ ->
      http.json(
        400,
        json.object([
          #("error", json.string("FIELDS_REQUIRED")),
          #("missing", json.array(missing, json.string)),
          #("problem", json.string("required")),
          #("message", json.string("licenceType and issuer are required.")),
        ]),
      )
    _, Some(i), Some(e), _ if i >= e ->
      http.json(
        400,
        json.object([
          #("error", json.string("INTERVAL_INVALID")),
          #("field", json.string("expiry")),
          #(
            "message",
            json.string("A licence cannot expire before it was issued."),
          ),
        ]),
      )
    // The file is checked first, so a refused file leaves no claim behind.
    _, _, _, Some(Error(code)) -> http.error(422, code)
    _, _, _, _ -> {
      let now = clock.now_ms()
      let actor = core.staff_actor(access, req)
      let display = "Credential submitted — verification pending"
      use tx <- act(ctx)
      use claim <- result.try(core.create_claim(
        tx,
        fn(id) {
          claim_row.Row(
            ..core.blank_claim(
              id,
              claim_row.User,
              id.org_user_to_string(access.user.id),
              claim_type.Licence,
              now,
            ),
            status: claim_row.CollectingEvidence,
            verification_method: Some(verification_method.DocumentSubmitted),
            valid_from: issued,
            valid_until: expires,
            licence_type:,
            issuer:,
            identifier: input.filled(body.identifier),
            // The account's name, which no schema has read, may be longer than a holder name.
            holder_name: Some(option.unwrap(
              input.filled(body.holder_name),
              input.utf16_take(access.user.name, 80),
            )),
            display: Some(display),
          )
        },
        actor,
        now,
      ))
      use _ <- result.try(case file {
        Some(Ok(f)) ->
          core.add_evidence(
            tx,
            fn(id) {
              evidence_row.Row(
                ..core.blank_evidence(
                  id,
                  evidence_row.Document,
                  "subject_upload",
                  evidence_row.OrgUser,
                  now,
                ),
                supplied_by_id: Some(id.org_user_to_string(access.user.id)),
                org_id: Some(access.org.id),
              )
              |> core.with_file(f)
            },
            [claim.id],
            actor,
            now,
          )
          |> result.replace(Nil)
        _ -> Ok(Nil)
      })
      reply(http.json(
        201,
        json.object([
          #("claim", licence_view(claim)),
          #(
            "note",
            json.string(
              "An uploaded credential is a document, not a verified licence. Submit it to run the registry check (where a register is configured) or route it to review.",
            ),
          ),
        ]),
      ))
    }
  }
}

fn licence_view(c: records.Claim) -> json.Json {
  json.object([
    #("id", id.claim_json(c.id)),
    #("status", claim_row.status_to_json(c.status)),
    #("display", json.nullable(c.display, json.string)),
  ])
}

/// `POST /org/verification/licence/:id/submit`: the register is asked before anything is written; its answer
/// and the claim's moves then commit together.
pub fn submit_licence(
  ctx: Ctx,
  req: Request,
  access: OrgAccess,
  claim_id: id.ClaimId,
) -> Response {
  let shape = {
    use provider <- input.field("providerId", input.nullish(input.text(60)))
    input.done(provider)
  }
  let parsed = http.parse_body(req, shape, [])
  let now = clock.now_ms()
  let actor = core.staff_actor(access, req)
  let system = core.Actor(..actor, kind: event_row.System, id: None, name: None)
  use tx <- act(ctx)
  let read = store.reading(tx)
  use found <- result.try(records.claim(read, claim_id))
  // A claim's `subject_id` is polymorphic text.
  let me = id.org_user_to_string(access.user.id)
  case found {
    Some(claim)
      if claim.subject_id == me && claim.claim_type == claim_type.Licence
    ->
      case claim.status {
        claim_row.CollectingEvidence | claim_row.Pending ->
          case parsed {
            Error(response) -> stop(response)
            Ok(provider) -> {
              let provider_id = option.unwrap(provider, "local-test-registry")
              let answer =
                lookup(
                  ctx,
                  provider_id,
                  claim.identifier,
                  option.unwrap(claim.holder_name, ""),
                )
              registry_checked(
                tx,
                claim,
                provider_id,
                answer,
                actor,
                system,
                access,
                now,
              )
            }
          }
        _ -> stop(http.error(409, "ALREADY_SUBMITTED"))
      }
    _ -> stop(http.error(404, "CLAIM_NOT_FOUND"))
  }
}

fn move(
  tx: store.Tx,
  claim_id: id.ClaimId,
  to: claim_row.Status,
  actor: core.Actor,
  method: Option(verification_method.VerificationMethod),
  reason: Option(String),
  event: Option(event_row.Type),
  also: core.Also,
  now: Int,
) -> Result(Nil, store.Fail(Response)) {
  use moved <- result.try(core.transition(
    tx,
    claim_id,
    to,
    core.How(actor:, method:, reason:, attribution: None, event:),
    also,
    now,
  ))
  case moved {
    Ok(_) -> Ok(Nil)
    Error(e) -> stop(http.error(409, core.move_error_code(e)))
  }
}

fn registry_checked(
  tx: store.Tx,
  claim: records.Claim,
  provider_id: String,
  answer: Lookup,
  actor: core.Actor,
  system: core.Actor,
  access: OrgAccess,
  now: Int,
) -> core.Done {
  use _ <- result.try(case claim.status {
    claim_row.CollectingEvidence ->
      move(
        tx,
        claim.id,
        claim_row.Pending,
        actor,
        None,
        None,
        None,
        core.no_more(),
        now,
      )
    _ -> Ok(Nil)
  })
  let #(state, result_text) = case answer {
    NoAnswer(state) -> #(state, None)
    Match(_) -> #("configured", Some("match"))
    Ambiguous -> #("configured", Some("ambiguous"))
    NoMatch -> #("configured", Some("no_match"))
  }
  use _ <- result.try(core.event(
    tx,
    case result_text {
      Some(_) -> event_row.AutomatedCheckPassed
      None -> event_row.AutomatedCheckFailed
    },
    actor,
    core.About(
      ..core.claim_about(claim),
      org_id: None,
      detail: records.detail([], [
        #("provider", Some(provider_id)),
        #("state", Some(state)),
        #("result", result_text),
      ]),
    ),
    now,
  ))
  let to_review = fn(reason, set: fn(records.Claim) -> records.Claim, reasons) {
    // A route to review that the claim's state refuses leaves it where it is, as in the TypeScript server.
    core.transition(
      tx,
      claim.id,
      claim_row.RequiresHumanReview,
      core.How(
        actor: system,
        method: None,
        reason: Some(reason),
        attribution: None,
        event: None,
      ),
      core.Also(..core.no_more(), set:, add_review_reasons: reasons),
      now,
    )
  }
  let registry = fn(c: records.Claim, result_value, state_value, reference) {
    claim_row.Row(
      ..c,
      registry_provider: Some(provider_id),
      registry_state: state_value,
      registry_result: result_value,
      registry_checked_at: Some(now),
      registry_reference: reference,
    )
  }
  let finish = fn(
    provider: json.Json,
    routed: Bool,
    note: Option(String),
    extra,
  ) {
    use fresh <- result.try(records.claim(store.reading(tx), claim.id))
    let assert Some(fresh) = fresh as "a checked claim exists"
    let _ = routed
    reply(http.json(
      200,
      json.object(
        list.flatten([
          [#("claim", licence_view(fresh)), #("provider", provider)],
          case note {
            Some(n) -> [#("note", json.string(n))]
            None -> []
          },
          extra,
        ]),
      ),
    ))
  }
  case answer {
    NoAnswer(state) -> {
      // An unavailable or unconfigured register leaves the claim neither verified nor rejected.
      use routed <- result.try(
        to_review(
          "no authoritative register available",
          fn(c) {
            registry(
              c,
              None,
              list.key_find(claim_row.registry_state_pairs, state)
                |> option.from_result,
              None,
            )
          },
          [
            ver_code.NoAuthoritativeSource,
            ver_code.DocumentAuthenticityUnconfirmed,
          ],
        ),
      )
      finish(
        json.object([
          #("id", json.string(provider_id)),
          #("state", json.string(state)),
        ]),
        True,
        Some(case state {
          "temporarily_unavailable" ->
            "Verification provider unavailable — verification remains pending."
          _ ->
            "No authoritative register is configured for this issuer — a reviewer can perform a document review, which is labelled as a document review."
        }),
        [
          #("routed", case routed {
            Ok(_) -> json.string("requires_human_review")
            Error(_) -> json.null()
          }),
        ],
      )
    }
    Match(row) -> {
      // The register's own expiry, never the self-declared one.
      let until =
        temporal.parse_day(row.valid_until)
        |> result.map(temporal.day_end)
      use _ <- result.try(core.add_evidence(
        tx,
        fn(id) {
          evidence_row.Row(
            ..core.blank_evidence(
              id,
              evidence_row.RegistryResult,
              provider_id,
              evidence_row.System,
              now,
            ),
            org_id: Some(access.org.id),
            identifier: Some(row.identifier),
            licence_type: Some(row.licence_type),
            registry_valid_until: Some(row.valid_until),
          )
        },
        [claim.id],
        actor,
        now,
      ))
      use _ <- result.try(move(
        tx,
        claim.id,
        claim_row.AutomatedChecksPassed,
        system,
        None,
        None,
        None,
        core.Also(..core.no_more(), set: fn(c) {
          let c = registry(c, Some(claim_row.Match), None, Some(row.identifier))
          claim_row.Row(
            ..c,
            valid_until: case until {
              Ok(u) -> Some(u)
              Error(_) -> c.valid_until
            },
            display: Some("Licence verified: " <> row.licence_type),
          )
        }),
        now,
      ))
      use _ <- result.try(move(
        tx,
        claim.id,
        claim_row.Verified,
        system,
        Some(verification_method.AuthoritativeRegistry),
        None,
        Some(event_row.ClaimVerified),
        core.no_more(),
        now,
      ))
      finish(
        json.object([
          #("id", json.string(provider_id)),
          #("result", json.string("match")),
        ]),
        False,
        None,
        [],
      )
    }
    Ambiguous -> {
      use _ <- result.try(
        to_review("registry returned an ambiguous match", fn(c) { c }, [
          ver_code.RegistryAmbiguousMatch,
        ]),
      )
      finish(
        json.object([
          #("id", json.string(provider_id)),
          #("result", json.string("ambiguous")),
        ]),
        True,
        Some(
          "The register returned more than one plausible record — a human resolves ambiguity, never a guess.",
        ),
        [],
      )
    }
    NoMatch -> {
      // No record verifies nothing and proves nothing.
      use _ <- result.try(
        to_review(
          "registry found no matching record",
          fn(c) { registry(c, Some(claim_row.NoMatch), None, None) },
          [ver_code.DocumentAuthenticityUnconfirmed],
        ),
      )
      finish(
        json.object([
          #("id", json.string(provider_id)),
          #("result", json.string("no_match")),
        ]),
        True,
        Some(
          "No register record matched. The credential stays unverified; a reviewer can examine the evidence.",
        ),
        [],
      )
    }
  }
}

// ------------------------------------------------------------------------------------------- evidence access

/// `GET /admin/verification/evidence/:id`: Trust & Safety sees everything, every read logged.
pub fn admin_evidence(
  ctx: Ctx,
  req: Request,
  evidence_id: id.EvidenceId,
) -> Response {
  let now = clock.now_ms()
  let _ = req
  use tx <- act(ctx)
  let read = store.reading(tx)
  use found <- result.try(records.evidence(read, evidence_id))
  case found {
    None -> stop(http.error(404, "EVIDENCE_NOT_FOUND"))
    Some(ev) -> {
      use record <- result.try(views.evidence_record(read, ev))
      use linked <- result.try(store.one(
        read,
        "SELECT claim_id FROM ver_claim_evidence WHERE evidence_id = ? ORDER BY rowid",
        [id.evidence_sql(ev.id)],
        decode.at([0], id.claim_decoder()),
      ))
      use _ <- result.try(core.event(
        tx,
        event_row.EvidenceAccessed,
        core.system_actor(None),
        core.About(
          ..core.nothing,
          claim_id: option.from_result(linked),
          subject_id: ev.supplied_by_id,
          org_id: ev.org_id,
          detail: records.detail([], [
            #("evidenceId", Some(id.evidence_to_string(ev.id))),
            #("by", Some("trust_safety")),
          ]),
        ),
        now,
      ))
      reply(http.json(
        200,
        json.object([
          #("evidence", record),
          #(
            "file",
            case option.map(ev.media_id, media.read(ctx.config.data_dir, _)) {
              Some(Ok(#(content_type, bytes))) ->
                json.object([
                  #("mime", json.string(content_type)),
                  #("base64", json.string(bit_array.base64_encode(bytes, True))),
                ])
              _ -> json.null()
            },
          ),
        ]),
      ))
    }
  }
}

/// `GET /org/verification/evidence/:id`: an organisation's reviewers see their own organisation's internal
/// evidence only.
pub fn org_evidence(
  ctx: Ctx,
  req: Request,
  access: OrgAccess,
  evidence_id: id.EvidenceId,
) -> Response {
  let now = clock.now_ms()
  use tx <- act(ctx)
  let read = store.reading(tx)
  use found <- result.try(records.evidence(read, evidence_id))
  let ours = Some(access.org.id)
  case found {
    Some(ev)
      if ev.org_id == ours && ev.visibility == evidence_row.OrganisationInternal
    -> {
      use admins <- result.try(records.admins_of(read, access.org.id))
      case
        claims.has_ver_level(
          admins,
          access.org.id,
          access.user.id,
          ver_level.VerificationReviewer,
        )
      {
        False -> stop(core.require_ver_refusal(ver_level.VerificationReviewer))
        True -> {
          use record <- result.try(views.evidence_record(read, ev))
          let _ = record
          use _ <- result.try(core.event(
            tx,
            event_row.EvidenceAccessed,
            core.staff_actor(access, req),
            core.About(
              ..core.nothing,
              subject_id: ev.supplied_by_id,
              org_id: ev.org_id,
              detail: records.detail([], [
                #("evidenceId", Some(id.evidence_to_string(ev.id))),
                #("by", Some(id.org_user_to_string(access.user.id))),
              ]),
            ),
            now,
          ))
          use claim_ids <- result.try(store.query(
            read,
            "SELECT claim_id FROM ver_claim_evidence WHERE evidence_id = ? ORDER BY rowid",
            [id.evidence_sql(ev.id)],
            decode.at([0], decode.string),
          ))
          reply(http.json(
            200,
            json.object([
              #(
                "evidence",
                json.object(
                  list.append(views.evidence_fields(ev, include_media: False), [
                    #("claimIds", json.array(claim_ids, json.string)),
                  ]),
                ),
              ),
            ]),
          ))
        }
      }
    }
    _ -> stop(http.error(404, "EVIDENCE_NOT_FOUND"))
  }
}

// ------------------------------------------------------------------------------------------- cases

/// `GET /admin/verification/cases/:id`: everything a reviewer decides from.
pub fn case_view(ctx: Ctx, claim_id: id.ClaimId) -> Response {
  use read <- core.look(ctx)
  use found <- result.try(records.claim(read, claim_id))
  case found {
    None -> Ok(http.error(404, "CASE_NOT_FOUND"))
    Some(c) -> {
      use record <- result.try(views.claim_record(read, c))
      use row <- result.try(views.admin_claim_row(read, c))
      use evidence <- result.try(records.claim_evidence(read, c.id))
      use evidence <- result.try(
        list.try_map(evidence, views.evidence_record(read, _)),
      )
      use prior <- result.try(records.claims_for(
        read,
        c.subject_kind,
        c.subject_id,
      ))
      use prior <- result.try(
        list.try_map(
          list.filter(prior, fn(x) { x.id != c.id }),
          views.claim_record(read, _),
        ),
      )
      use conflicts <- result.try(case c.subject_kind {
        claim_row.User ->
          conflicts.active_for_user(read, id.org_user(c.subject_id))
        claim_row.Org -> Ok([])
      })
      use disputes <- result.try(records.disputes_for_claim(read, c.id))
      use reasons <- result.try(records.codes(read, c.id, records.ReviewReasons))
      use events <- result.map(records.events_for_claim(read, c.id))
      http.json(
        200,
        json.object([
          #("claim", record),
          #("row", row),
          #("evidence", json.preprocessed_array(evidence)),
          #("priorClaims", json.preprocessed_array(prior)),
          #("conflicts", json.array(conflicts, conflicts.record)),
          #("disputes", json.array(disputes, personal.dispute_json)),
          #("whyHumanReview", json.array(reasons, ver_code.to_json)),
          // Chronological: events are only appended.
          #("events", json.array(events, views.event_record)),
        ]),
      )
    }
  }
}

fn claim_reply(tx: store.Tx, claim_id: id.ClaimId) -> core.Done {
  let read = store.reading(tx)
  use found <- result.try(records.claim(read, claim_id))
  let assert Some(c) = found as "a decided claim exists"
  use record <- result.try(views.claim_record(read, c))
  reply(http.json(200, json.object([#("claim", record)])))
}

fn reason_body(
  req: Request,
  max: Int,
) -> Result(#(String, Option(verification_method.VerificationMethod)), Response) {
  let shape = {
    use reason <- input.field("reason", input.nullish(input.text(max)))
    use method <- input.field(
      "method",
      input.optional(
        input.one_of_these(verification_method.pairs, [
          verification_method.ScoutboxManualReview,
          verification_method.FederationConfirmation,
          verification_method.AuthoritativeRegistry,
        ]),
      ),
    )
    input.done(#(reason, method))
  }
  case http.parse_body(req, shape, []) {
    Error(response) -> Error(response)
    Ok(#(reason, method)) ->
      case input.filled(reason) {
        None -> Error(reason_required())
        Some(r) -> Ok(#(r, method))
      }
  }
}

fn reason_only(req: Request) -> Result(String, Response) {
  let shape = {
    use reason <- input.field("reason", input.nullish(input.text(600)))
    input.done(reason)
  }
  case http.parse_body(req, shape, []) {
    Error(response) -> Error(response)
    Ok(reason) ->
      case input.filled(reason) {
        None -> Error(reason_required())
        Some(r) -> Ok(r)
      }
  }
}

fn decidable(s: claim_row.Status) -> Bool {
  s == claim_row.RequiresHumanReview
  || s == claim_row.AutomatedChecksPassed
  || s == claim_row.Pending
}

fn notify_subject(
  tx: store.Tx,
  c: records.Claim,
  text: String,
  now: Int,
) -> Result(Nil, store.Fail(e)) {
  case c.subject_kind {
    claim_row.User ->
      notifications.notify(
        tx,
        to: audience.OrgUser,
        id: c.subject_id,
        type_: "verification",
        text:,
        ref_id: Some(id.claim_to_string(c.id)),
        at: now,
      )
    claim_row.Org -> Ok(Nil)
  }
}

fn admin_how(
  req: Request,
  method: Option(verification_method.VerificationMethod),
  reason: Option(String),
  event: Option(event_row.Type),
) -> core.How {
  core.How(
    actor: reviewer.actor(req),
    method:,
    reason:,
    attribution: Some(reviewer.of(req).attribution),
    event:,
  )
}

fn admin_move(
  tx: store.Tx,
  claim_id: id.ClaimId,
  to: claim_row.Status,
  how: core.How,
  also: core.Also,
  now: Int,
) -> Result(Nil, store.Fail(Response)) {
  use moved <- result.try(core.transition(tx, claim_id, to, how, also, now))
  case moved {
    Ok(_) -> Ok(Nil)
    Error(e) -> stop(http.error(409, core.move_error_code(e)))
  }
}

/// `POST /admin/verification/claims/:id/approve`. A licence is only ever verified by a register, never by a
/// reviewer naming one; a manual review of its document is labelled as one.
pub fn approve(ctx: Ctx, req: Request, claim_id: id.ClaimId) -> Response {
  let body = reason_body(req, 600)
  let now = clock.now_ms()
  use tx <- act(ctx)
  use found <- result.try(records.claim(store.reading(tx), claim_id))
  case found, body {
    None, _ -> stop(http.error(404, "CLAIM_NOT_FOUND"))
    _, Error(response) -> stop(response)
    Some(c), Ok(#(reason, method)) ->
      case decidable(c.status) {
        False ->
          stop(http.error_message(
            409,
            "CLAIM_NOT_DECIDABLE",
            "Claim is " <> claim_row.status_to_string(c.status) <> ".",
          ))
        True -> {
          let method = case c.claim_type {
            claim_type.Licence -> verification_method.ScoutboxManualReview
            _ -> option.unwrap(method, verification_method.ScoutboxManualReview)
          }
          use _ <- result.try(case c.status {
            claim_row.Pending ->
              admin_move(
                tx,
                c.id,
                claim_row.RequiresHumanReview,
                admin_how(
                  req,
                  None,
                  Some("escalated for manual decision"),
                  None,
                ),
                core.no_more(),
                now,
              )
            _ -> Ok(Nil)
          })
          let licence = option.unwrap(c.licence_type, "undefined")
          let display = case c.claim_type, method {
            claim_type.Licence, verification_method.AuthoritativeRegistry ->
              Some("Licence verified: " <> licence)
            claim_type.Licence, _ ->
              Some(input.utf16_take(
                licence
                  <> ": confirmed by Trust & Safety document review (not an independent register check)",
                300,
              ))
            _, _ -> None
          }
          use _ <- result.try(admin_move(
            tx,
            c.id,
            claim_row.Verified,
            admin_how(
              req,
              Some(method),
              Some(reason),
              Some(event_row.ReviewApproved),
            ),
            core.Also(..core.no_more(), set: fn(moved) {
              claim_row.Row(
                ..moved,
                authority_kind: Some(claim_row.TrustSafety),
                authority_id: Some("admin"),
                display: option.or(display, moved.display),
              )
            }),
            now,
          ))
          use _ <- result.try(notify_subject(
            tx,
            c,
            "Trust & Safety approved your "
              <> string.lowercase(string.replace(
              claim_type.to_string(c.claim_type),
              "_",
              " ",
            ))
              <> " verification. ✓",
            now,
          ))
          claim_reply(tx, c.id)
        }
      }
  }
}

/// `POST /admin/verification/claims/:id/reject`.
pub fn reject(ctx: Ctx, req: Request, claim_id: id.ClaimId) -> Response {
  let body = reason_only(req)
  let now = clock.now_ms()
  use tx <- act(ctx)
  use found <- result.try(records.claim(store.reading(tx), claim_id))
  case found, body {
    None, _ -> stop(http.error(404, "CLAIM_NOT_FOUND"))
    _, Error(response) -> stop(response)
    Some(c), Ok(reason) ->
      case decidable(c.status) {
        False -> stop(http.error(409, "CLAIM_NOT_DECIDABLE"))
        True -> {
          use _ <- result.try(case c.status {
            claim_row.Pending ->
              admin_move(
                tx,
                c.id,
                claim_row.RequiresHumanReview,
                admin_how(req, None, Some("escalated"), None),
                core.no_more(),
                now,
              )
            _ -> Ok(Nil)
          })
          use _ <- result.try(admin_move(
            tx,
            c.id,
            claim_row.Rejected,
            admin_how(req, None, Some(reason), Some(event_row.ReviewRejected)),
            core.no_more(),
            now,
          ))
          use _ <- result.try(notify_subject(
            tx,
            c,
            "Trust & Safety declined a verification request: "
              <> input.utf16_take(reason, 140),
            now,
          ))
          claim_reply(tx, c.id)
        }
      }
  }
}

/// `POST /admin/verification/claims/:id/request-info`.
pub fn request_info(ctx: Ctx, req: Request, claim_id: id.ClaimId) -> Response {
  let body = reason_only(req)
  let now = clock.now_ms()
  use tx <- act(ctx)
  use found <- result.try(records.claim(store.reading(tx), claim_id))
  case found, body {
    None, _ -> stop(http.error(404, "CLAIM_NOT_FOUND"))
    _, Error(response) -> stop(response)
    Some(c), Ok(reason) -> {
      use _ <- result.try(admin_move(
        tx,
        c.id,
        claim_row.CollectingEvidence,
        admin_how(req, None, Some(reason), None),
        core.no_more(),
        now,
      ))
      use _ <- result.try(notify_subject(
        tx,
        c,
        "Trust & Safety needs more evidence: " <> input.utf16_take(reason, 140),
        now,
      ))
      claim_reply(tx, c.id)
    }
  }
}

const reviewer_max = 60

/// `POST /admin/verification/cases/:id/assign`: the case is given to a reviewer, or to the team when none is named.
/// Only the assignment changes; the claim's status and `updatedAt` stay.
pub fn assign(ctx: Ctx, req: Request, claim_id: id.ClaimId) -> Response {
  let shape = {
    use reviewer <- input.field(
      "reviewer",
      input.nullish(input.text(reviewer_max)),
    )
    input.done(reviewer)
  }
  let body = http.parse_body(req, shape, [])
  let now = clock.now_ms()
  use tx <- act(ctx)
  use found <- result.try(records.claim(store.reading(tx), claim_id))
  case found, body {
    None, _ -> stop(http.error(404, "CASE_NOT_FOUND"))
    _, Error(response) -> stop(response)
    Some(c), Ok(reviewer) -> {
      let assigned = option.unwrap(input.filled(reviewer), "Trust & Safety")
      use _ <- result.try(
        store.run(tx, "UPDATE ver_claims SET assigned_to = ? WHERE id = ?", [
          sqlight.text(assigned),
          id.claim_sql(c.id),
        ]),
      )
      use _ <- result.try(core.event(
        tx,
        event_row.ReviewAssigned,
        core.system_actor(None),
        core.About(
          ..core.nothing,
          claim_id: Some(c.id),
          detail: records.detail([], [#("reviewer", Some(assigned))]),
        ),
        now,
      ))
      reply(http.json(200, json.object([#("assigned", json.string(assigned))])))
    }
  }
}

/// `POST /admin/verification/claims/:id/suspend` and `…/revoke`. Effective badges change at once; the audit
/// trail stays.
pub fn suspend_or_revoke(
  ctx: Ctx,
  req: Request,
  claim_id: id.ClaimId,
  to: claim_row.Status,
) -> Response {
  let body = reason_only(req)
  let now = clock.now_ms()
  use tx <- act(ctx)
  use found <- result.try(records.claim(store.reading(tx), claim_id))
  case found, body {
    None, _ -> stop(http.error(404, "CLAIM_NOT_FOUND"))
    _, Error(response) -> stop(response)
    Some(c), Ok(reason) -> {
      let target = claim_row.status_to_string(to)
      use _ <- result.try(admin_move(
        tx,
        c.id,
        to,
        admin_how(req, None, Some(reason), None),
        core.no_more(),
        now,
      ))
      use _ <- result.try(notify_subject(
        tx,
        c,
        "A verification claim was "
          <> target
          <> " by Trust & Safety: "
          <> input.utf16_take(reason, 140)
          <> ". You can dispute this.",
        now,
      ))
      let read = store.reading(tx)
      use found <- result.try(records.claim(read, c.id))
      let assert Some(fresh) = found as "a moved claim exists"
      use record <- result.try(views.claim_record(read, fresh))
      reply(http.json(
        200,
        json.object([
          #("claim", record),
          #(
            "note",
            json.string(
              "Effective badges change immediately; the historical audit trail is preserved.",
            ),
          ),
        ]),
      ))
    }
  }
}

/// `POST /admin/verification/claims/:id/reinstate`.
pub fn reinstate(ctx: Ctx, req: Request, claim_id: id.ClaimId) -> Response {
  let body = reason_only(req)
  let now = clock.now_ms()
  use tx <- act(ctx)
  use found <- result.try(records.claim(store.reading(tx), claim_id))
  case found, body {
    None, _ -> stop(http.error(404, "CLAIM_NOT_FOUND"))
    _, Error(response) -> stop(response)
    Some(c), Ok(reason) ->
      case c.status {
        claim_row.Suspended | claim_row.Revoked | claim_row.Disputed -> {
          use _ <- result.try(admin_move(
            tx,
            c.id,
            claim_row.Verified,
            admin_how(
              req,
              c.verification_method,
              Some(reason),
              Some(event_row.ClaimReinstated),
            ),
            core.no_more(),
            now,
          ))
          claim_reply(tx, c.id)
        }
        _ -> stop(http.error(409, "NOT_REINSTATABLE"))
      }
  }
}

// ------------------------------------------------------------------------------------------- the queue

const day_ms = 86_400_000

type QueueQuery {
  QueueQuery(
    org_id: Option(String),
    country: Option(String),
    claim_type: Option(claim_type.ClaimType),
    status: Option(claim_row.Status),
  )
}

/// `GET /admin/verification/queue`: everything awaiting Trust & Safety.
pub fn queue(ctx: Ctx, req: Request) -> Response {
  let shape = {
    use org_id <- input.field("orgId", input.optional(input.id()))
    use country <- input.field("country", input.optional(input.text(40)))
    use claim_type <- input.field(
      "claimType",
      input.optional(input.one_of(claim_type.pairs)),
    )
    use status <- input.field(
      "status",
      input.optional(
        input.one_of_these(claim_row.status_pairs, [
          claim_row.RequiresHumanReview,
          claim_row.Disputed,
          claim_row.Suspended,
        ]),
      ),
    )
    input.done(QueueQuery(org_id:, country:, claim_type:, status:))
  }
  use q <- http.query(req, shape, [])
  let now = clock.now_ms()
  use read <- core.look(ctx)
  let statuses = case q.status {
    Some(s) -> [s]
    None -> [
      claim_row.RequiresHumanReview,
      claim_row.Disputed,
      claim_row.Suspended,
    ]
  }
  use queued <- result.try(records.claims_where(
    read,
    "status IN ("
      <> list.map(statuses, fn(_) { "?" }) |> string.join(", ")
      <> ") AND (? IS NULL OR organisation_id = ?) AND (? IS NULL OR claim_type = ?)",
    list.flatten([
      list.map(statuses, fn(s) { sqlight.text(claim_row.status_to_string(s)) }),
      [
        sqlight.nullable(sqlight.text, q.org_id),
        sqlight.nullable(sqlight.text, q.org_id),
        sqlight.nullable(
          sqlight.text,
          option.map(q.claim_type, claim_type.to_string),
        ),
        sqlight.nullable(
          sqlight.text,
          option.map(q.claim_type, claim_type.to_string),
        ),
      ],
    ]),
  ))
  let rows = fn(status) {
    list.filter(queued, fn(c) { c.status == status })
    |> list.try_map(views.admin_claim_row(read, _))
  }
  use human <- result.try(rows(claim_row.RequiresHumanReview))
  use suspended <- result.try(rows(claim_row.Suspended))
  use disputed <- result.try(rows(claim_row.Disputed))
  use roots <- result.try(applications.queue_rows(read, q.country))
  use open <- result.try(records.disputes(read))
  use domain_requests <- result.try(org_admin.awaiting_review(read))
  use domain_requests <- result.try(
    list.try_map(domain_requests, org_admin.request_record(read, _)),
  )
  use expiring <- result.try(
    records.claims_where(
      read,
      "status = 'verified' AND valid_until > ? AND valid_until < ?",
      [sqlight.int(now), sqlight.int(now + 30 * day_ms)],
    ),
  )
  use expiring <- result.try(
    list.try_map(expiring, views.admin_claim_row(read, _)),
  )
  use revoked <- result.try(
    records.claims_where(read, "status = 'revoked' AND revoked_at > ?", [
      sqlight.int(now - 14 * day_ms),
    ]),
  )
  use revoked <- result.map(
    list.try_map(revoked, views.admin_claim_row(read, _)),
  )
  let ages =
    queued
    |> list.filter(fn(c) { c.status == claim_row.RequiresHumanReview })
    |> list.map(fn(c) { now - c.updated_at })
  http.json(
    200,
    json.object([
      #("humanReview", json.preprocessed_array(human)),
      #("rootRequests", json.preprocessed_array(roots)),
      #(
        "disputes",
        json.array(
          list.filter(open, fn(d) { d.status == dispute_row.Open }),
          personal.dispute_json,
        ),
      ),
      #("suspended", json.preprocessed_array(suspended)),
      #("disputedClaims", json.preprocessed_array(disputed)),
      #("domainRequests", json.preprocessed_array(domain_requests)),
      #("expiring", json.preprocessed_array(expiring)),
      #("recentlyRevoked", json.preprocessed_array(revoked)),
      #("queueOldestMs", json.int(list.fold(ages, 0, int.max))),
    ]),
  )
}

// ------------------------------------------------------------------------------------------- domain requests

/// `GET /admin/verification/domain-requests`: escalated domain changes (root or contested).
pub fn domain_requests(ctx: Ctx) -> Response {
  use read <- core.look(ctx)
  use items <- result.try(org_admin.awaiting_review(read))
  use items <- result.map(
    list.try_map(items, org_admin.request_record(read, _)),
  )
  http.json(200, json.object([#("items", json.preprocessed_array(items))]))
}

/// `POST /admin/verification/domain-requests/:id/decide`.
pub fn decide_domain(
  ctx: Ctx,
  req: Request,
  request_id: id.DomainRequestId,
) -> Response {
  let shape = {
    use reason <- input.field("reason", input.nullish(input.text(600)))
    use approve <- input.field("approve", input.required(input.boolean()))
    input.done(#(reason, approve))
  }
  let parsed = http.parse_body(req, shape, [])
  let now = clock.now_ms()
  let rev = reviewer.of(req)
  use tx <- act(ctx)
  let read = store.reading(tx)
  use found <- result.try(org_admin.domain_request(read, request_id))
  case found, parsed {
    None, _ -> stop(http.error(404, "DOMAIN_REQUEST_NOT_FOUND"))
    _, Error(response) -> stop(response)
    Some(r), Ok(#(reason, approve)) ->
      case input.filled(reason), r.status {
        None, _ -> stop(reason_required())
        Some(_), s if s != domain_request_row.RequiresHumanReview ->
          stop(http.error(409, "NOT_DECIDABLE"))
        Some(reason), _ -> {
          use org <- result.try(orgs.by_id(read, r.org_id))
          let approve = approve && org != None
          use _ <- result.try(case approve, org {
            True, Some(o) -> {
              use mine <- result.try(core.verified_domains_of(read, o.id))
              use _ <- result.try(case list.contains(mine, r.domain) {
                True -> Ok(Nil)
                False ->
                  records.add_domain(
                    tx,
                    records.verified_domain(
                      o.id,
                      r.domain,
                      records.DomainByReview,
                      now,
                      "trust_safety",
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
                      id.org_to_string(o.id),
                      claim_type.OrganisationDomain,
                      now,
                    ),
                    organisation_id: Some(o.id),
                    status: claim_row.Verified,
                    verification_method: Some(
                      verification_method.ScoutboxManualReview,
                    ),
                    verified_at: Some(now),
                    verified_by_kind: Some(actor_kind.TrustSafety),
                    verified_by_id: Some(rev.id),
                    domain: Some(r.domain),
                  )
                },
                core.system_actor(None),
                now,
              ))
              core.event(
                tx,
                event_row.OrganisationDomainVerified,
                reviewer.actor(req),
                core.About(
                  ..core.nothing,
                  org_id: Some(o.id),
                  detail: records.detail([], [
                    #("domain", Some(r.domain)),
                    #("via", Some("trust_safety")),
                  ]),
                  reason: Some(reason),
                  attribution: Some(rev.attribution),
                ),
                now,
              )
            }
            _, _ ->
              core.event(
                tx,
                event_row.ReviewRejected,
                core.system_actor(None),
                core.About(
                  ..core.nothing,
                  org_id: Some(r.org_id),
                  detail: records.detail([], [
                    #("domainRequest", Some(id.domain_request_to_string(r.id))),
                  ]),
                  reason: Some(reason),
                ),
                now,
              )
          })
          let decided =
            domain_request_row.Row(
              ..r,
              status: case approve {
                True -> domain_request_row.Verified
                False -> domain_request_row.Rejected
              },
              method: case approve {
                True -> Some(domain_request_row.ScoutboxManualReview)
                False -> r.method
              },
              decided_at: Some(now),
              decided_by_name: Some(rev.name),
              decided_by_id: Some(rev.id),
            )
          use _ <- result.try(org_admin.update_request(
            tx,
            decided,
            domain_request_row.RequiresHumanReview,
          ))
          use record <- result.try(org_admin.request_record(read, decided))
          reply(http.json(200, json.object([#("request", record)])))
        }
      }
  }
}

// ------------------------------------------------------------------------------------------- disputes

/// `GET /admin/verification/disputes`.
pub fn disputes(ctx: Ctx) -> Response {
  use read <- core.look(ctx)
  use all <- result.try(records.disputes(read))
  use items <- result.map(
    list.try_map(all, fn(d) {
      use found <- result.try(records.claim(read, d.claim_id))
      use row <- result.map(case found {
        Some(c) -> views.admin_claim_row(read, c)
        None -> Ok(json.null())
      })
      json.object(list.append(personal.dispute_fields(d), [#("claim", row)]))
    }),
  )
  http.json(200, json.object([#("items", json.preprocessed_array(items))]))
}

type Resolution {
  Reinstate
  RevokeClaim
  Correct
  Dismiss
}

type ResolutionBody {
  ResolutionBody(
    reason: Option(String),
    action: Resolution,
    role: Option(String),
    current: Option(Bool),
    valid_until: Option(Option(temporal.Due)),
  )
}

/// `POST /admin/verification/disputes/:id/resolve`. A refused outcome (the person opened a new claim meanwhile)
/// leaves the dispute open and nothing half-done.
pub fn resolve_dispute(
  ctx: Ctx,
  req: Request,
  dispute_id: id.DisputeId,
) -> Response {
  let shape = {
    use reason <- input.field("reason", input.nullish(input.text(300)))
    use action <- input.field(
      "action",
      input.required(
        input.one_of([
          #("reinstate", Reinstate),
          #("revoke", RevokeClaim),
          #("correct", Correct),
          #("dismiss", Dismiss),
        ]),
      ),
    )
    use role <- input.field("role", input.nullish(input.text(60)))
    use current <- input.field("current", input.optional(input.boolean()))
    use valid_until <- input.field(
      "validUntil",
      input.optional(input.due_date()),
    )
    input.done(ResolutionBody(reason:, action:, role:, current:, valid_until:))
  }
  let parsed = http.parse_body(req, shape, [])
  let now = clock.now_ms()
  let rev = reviewer.of(req)
  use tx <- act(ctx)
  let read = store.reading(tx)
  use found <- result.try(records.dispute(read, dispute_id))
  case found {
    None -> stop(http.error(404, "DISPUTE_NOT_FOUND"))
    Some(d) if d.status != dispute_row.Open ->
      stop(http.error(409, "ALREADY_RESOLVED"))
    Some(d) ->
      case parsed {
        Error(response) -> stop(response)
        Ok(body) ->
          case input.filled(body.reason) {
            None -> stop(reason_required())
            Some(reason) -> resolving(tx, req, d, body, reason, rev, now)
          }
      }
  }
}

fn resolving(
  tx: store.Tx,
  req: Request,
  d: records.Dispute,
  body: ResolutionBody,
  reason: String,
  rev: reviewer.Reviewer,
  now: Int,
) -> core.Done {
  let read = store.reading(tx)
  use claim <- result.try(records.claim(read, d.claim_id))
  let role = input.filled(body.role)
  // Sent as null or "", the expiry is cleared.
  let period = fn(c: records.Claim) {
    let c = case body.valid_until {
      Some(until) ->
        claim_row.Row(..c, valid_until: option.map(until, temporal.end))
      None -> c
    }
    case body.current {
      Some(b) -> claim_row.Row(..c, current: b)
      None -> c
    }
  }
  let corrected = fn(c: records.Claim) {
    let c = period(c)
    case role {
      Some(r) -> claim_row.Row(..c, role: Some(r))
      None -> c
    }
  }
  use _ <- result.try(case claim, body.action {
    Some(c), action if c.status == claim_row.Disputed ->
      case action {
        Reinstate | Dismiss ->
          admin_move(
            tx,
            c.id,
            claim_row.Verified,
            admin_how(
              req,
              c.verification_method,
              Some(reason),
              Some(event_row.ClaimReinstated),
            ),
            core.no_more(),
            now,
          )
        RevokeClaim ->
          admin_move(
            tx,
            c.id,
            claim_row.Revoked,
            admin_how(req, None, Some(reason), None),
            core.no_more(),
            now,
          )
        Correct ->
          admin_move(
            tx,
            c.id,
            claim_row.Verified,
            admin_how(
              req,
              c.verification_method,
              Some(reason),
              Some(event_row.ClaimCorrected),
            ),
            core.Also(..core.no_more(), set: corrected),
            now,
          )
      }
    Some(c), Correct -> {
      use _ <- result.try(records.update_claim(tx, period(c)))
      core.event(
        tx,
        event_row.ClaimCorrected,
        core.Actor(..core.system_actor(None), kind: event_row.TrustSafety),
        core.About(..core.claim_about(c), reason: Some(reason)),
        now,
      )
    }
    _, _ -> Ok(Nil)
  })
  let action = case body.action {
    Reinstate -> "reinstate"
    RevokeClaim -> "revoke"
    Correct -> "correct"
    Dismiss -> "dismiss"
  }
  let resolution = input.utf16_take(action <> ": " <> reason, 320)
  let done =
    dispute_row.Row(
      ..d,
      status: dispute_row.Resolved,
      resolution: Some(resolution),
      resolved_at: Some(now),
      resolved_by_name: Some(rev.name),
      resolved_by_id: Some(rev.id),
      resolution_attribution: Some(rev.attribution),
    )
  use _ <- result.try(records.update_dispute(tx, done, dispute_row.Open))
  use _ <- result.try(notifications.notify(
    tx,
    to: audience.OrgUser,
    id: d.by_id,
    type_: "verification",
    text: "Your verification dispute was resolved: "
      <> input.utf16_take(resolution, 140),
    ref_id: Some(id.claim_to_string(d.claim_id)),
    at: now,
  ))
  use claim_json <- result.try(case claim {
    Some(c) -> {
      use fresh <- result.try(records.claim(read, c.id))
      let assert Some(fresh) = fresh as "a disputed claim exists"
      views.claim_record(read, fresh)
    }
    None -> Ok(json.null())
  })
  reply(http.json(
    200,
    json.object([
      #("dispute", personal.dispute_json(done)),
      #("claim", claim_json),
    ]),
  ))
}

// ------------------------------------------------------------------------------------------- authorities

/// `GET /admin/verification/authorities/:userId/claims`: what an authority approved. Revoking an authority never
/// silently destroys these.
pub fn authority_claims(ctx: Ctx, user_id: String) -> Response {
  use read <- core.look(ctx)
  use theirs <- result.try(records.claims_by_authority(read, user_id))
  use items <- result.map(list.try_map(theirs, views.admin_claim_row(read, _)))
  http.json(
    200,
    json.object([
      #("items", json.preprocessed_array(items)),
      #(
        "note",
        json.string(
          "Claims this authority approved. Revoking an authority never silently destroys them — flag or suspend per policy after analysis.",
        ),
      ),
    ]),
  )
}

/// `POST /admin/verification/authorities/:userId/flag`: flag what an authority approved, suspending the named ones.
pub fn flag_authority(ctx: Ctx, req: Request, user_id: String) -> Response {
  let shape = {
    use reason <- input.field("reason", input.nullish(input.text(300)))
    use ids <- input.field(
      "suspendClaimIds",
      input.nullish(input.list_of(input.id(), 500)),
    )
    // From the request body.
    input.done(#(reason, option.unwrap(ids, []) |> list.map(id.claim)))
  }
  let parsed = http.parse_body(req, shape, [])
  let now = clock.now_ms()
  use tx <- act(ctx)
  case parsed {
    Error(response) -> stop(response)
    Ok(#(reason, to_suspend)) ->
      case input.filled(reason) {
        None -> stop(reason_required())
        Some(reason) -> {
          use affected <- result.try(records.claims_by_authority(
            store.reading(tx),
            user_id,
          ))
          use #(flagged, suspended) <- result.try(
            list.try_fold(affected, #(0, 0), fn(acc, c) {
              case
                list.contains(to_suspend, c.id)
                && c.status == claim_row.Verified,
                c.flagged_at
              {
                True, _ -> {
                  use moved <- result.map(core.transition(
                    tx,
                    c.id,
                    claim_row.Suspended,
                    admin_how(req, None, Some(reason), None),
                    core.no_more(),
                    now,
                  ))
                  case moved {
                    Ok(_) -> #(acc.0, acc.1 + 1)
                    Error(_) -> acc
                  }
                }
                False, None -> {
                  use _ <- result.try(records.update_claim(
                    tx,
                    claim_row.Row(
                      ..c,
                      flagged_at: Some(now),
                      flagged_reason: Some(reason),
                    ),
                  ))
                  use _ <- result.map(core.event(
                    tx,
                    event_row.ReviewRequested,
                    core.Actor(
                      ..core.system_actor(None),
                      kind: event_row.TrustSafety,
                    ),
                    core.About(
                      ..core.claim_about(c),
                      reason: Some("authority cascade flag"),
                    ),
                    now,
                  ))
                  #(acc.0 + 1, acc.1)
                }
                False, Some(_) -> Ok(acc)
              }
            }),
          )
          reply(http.json(
            200,
            json.object([
              #("affected", json.int(list.length(affected))),
              #("flagged", json.int(flagged)),
              #("suspended", json.int(suspended)),
            ]),
          ))
        }
      }
  }
}

/// `POST /admin/verification/orgs/:id/revoke`: verification-specific revocation (suspension is the ordinary one).
/// Staff claims verified through the organisation stop displaying at once; their history stays.
pub fn revoke_org(ctx: Ctx, req: Request, org_id: id.OrgId) -> Response {
  let body = reason_only(req)
  let now = clock.now_ms()
  use tx <- act(ctx)
  let read = store.reading(tx)
  use found <- result.try(orgs.by_id(read, org_id))
  case found, body {
    None, _ -> stop(http.error(404, "ORG_NOT_FOUND"))
    _, Error(response) -> stop(response)
    Some(org), Ok(reason) -> {
      use _ <- result.try(
        store.run(
          tx,
          "UPDATE orgs SET verification_revoked_at = ? WHERE id = ?",
          [sqlight.int(now), id.org_sql(org.id)],
        ),
      )
      use theirs <- result.try(records.claims_for(
        read,
        claim_row.Org,
        id.org_to_string(org.id),
      ))
      use _ <- result.try(
        list.try_each(
          list.filter(theirs, fn(c) { c.status == claim_row.Verified }),
          fn(c) {
            core.transition(
              tx,
              c.id,
              claim_row.Revoked,
              admin_how(req, None, Some(reason), None),
              core.no_more(),
              now,
            )
            |> result.replace(Nil)
          },
        ),
      )
      use _ <- result.try(core.event(
        tx,
        event_row.ClaimRevoked,
        core.Actor(..core.system_actor(None), kind: event_row.TrustSafety),
        core.About(
          ..core.nothing,
          org_id: Some(org.id),
          reason: Some(reason),
          detail: records.detail([], [#("organisation", Some("revoked"))]),
        ),
        now,
      ))
      use fresh <- result.try(orgs.by_id(read, org.id))
      use status <- result.try(core.org_status(read, fresh))
      reply(http.json(
        200,
        json.object([
          #("orgId", id.org_json(org.id)),
          #("status", json.string(claims.org_status_code(status))),
          #(
            "note",
            json.string(
              "Staff claims verified through this organisation stop displaying (engine re-checks at read time); their audit history is preserved.",
            ),
          ),
        ]),
      ))
    }
  }
}

// ------------------------------------------------------------------------------------------- the legacy toggle

/// Gives the Trust & Safety console's verification toggle (POST /admin/clubs/:id/verification) claim-level
/// provenance, inside its unit.
pub fn sync_legacy_toggle(
  tx: store.Tx,
  org_id: id.OrgId,
  verified: Option(Bool),
  now: Int,
) -> Result(Nil, store.Fail(e)) {
  let read = store.reading(tx)
  let ts =
    core.Actor(
      ..core.system_actor(None),
      kind: event_row.TrustSafety,
      name: Some("Trust & Safety"),
    )
  use theirs <- result.try(records.claims_for(
    read,
    claim_row.Org,
    id.org_to_string(org_id),
  ))
  let existing =
    list.find(theirs, fn(c) { c.claim_type == claim_type.OrganisationIdentity })
    |> option.from_result
  case verified, existing {
    Some(True), Some(c) if c.status == claim_row.Verified -> Ok(Nil)
    Some(True), _ -> {
      use _ <- result.try(case existing {
        Some(c)
          if c.status == claim_row.Revoked || c.status == claim_row.Suspended
        ->
          core.transition(
            tx,
            c.id,
            claim_row.Verified,
            core.How(
              actor: ts,
              method: Some(verification_method.ScoutboxManualReview),
              reason: Some("legacy admin verification toggle"),
              attribution: None,
              event: Some(event_row.ClaimReinstated),
            ),
            core.no_more(),
            now,
          )
          |> result.replace(Nil)
        Some(_) -> Ok(Nil)
        None ->
          core.create_claim(
            tx,
            fn(id) {
              claim_row.Row(
                ..core.blank_claim(
                  id,
                  claim_row.Org,
                  id.org_to_string(org_id),
                  claim_type.OrganisationIdentity,
                  now,
                ),
                organisation_id: Some(org_id),
                status: claim_row.Verified,
                verification_method: Some(
                  verification_method.ScoutboxManualReview,
                ),
                verified_at: Some(now),
                verified_by_kind: Some(actor_kind.TrustSafety),
                verified_by_id: Some("admin"),
                via: Some("legacy admin route"),
              )
            },
            core.system_actor(None),
            now,
          )
          |> result.replace(Nil)
      })
      store.run(
        tx,
        "UPDATE orgs SET verification_revoked_at = NULL WHERE id = ?",
        [id.org_sql(org_id)],
      )
    }
    Some(False), Some(c) if c.status == claim_row.Verified ->
      core.transition(
        tx,
        c.id,
        claim_row.Revoked,
        core.How(
          actor: ts,
          method: None,
          reason: Some("legacy admin verification toggle removed verification"),
          attribution: None,
          event: None,
        ),
        core.no_more(),
        now,
      )
      |> result.replace(Nil)
    _, _ -> Ok(Nil)
  }
}

// ------------------------------------------------------------------------------------------- the expiry sweep

/// Verified current claims past their expiry become expired, and claims expiring within 30 days are warned once.
/// Each claim in its own unit, as the TypeScript sweep does. Returns how many changed.
pub fn sweep(ctx: Ctx) -> Int {
  let now = clock.now_ms()
  let found =
    store.read(ctx.store, fn(read) {
      use expired <- result.try(
        records.claims_where(
          read,
          "status = 'verified' AND current = 1 AND valid_until IS NOT NULL AND valid_until < ?",
          [sqlight.int(now)],
        ),
      )
      use warn <- result.map(
        records.claims_where(
          read,
          "status = 'verified' AND valid_until > ? AND valid_until < ? AND expiry_warned_at IS NULL",
          [sqlight.int(now), sqlight.int(now + 30 * day_ms)],
        ),
      )
      #(expired, warn)
    })
  case found {
    Error(_) -> 0
    Ok(#(expired, warn)) -> {
      let system = core.system_actor(None)
      let expire = fn(c: records.Claim) {
        store.unit(ctx.store, fn(tx) {
          use _ <- result.try(core.transition(
            tx,
            c.id,
            claim_row.Expired,
            core.How(
              actor: system,
              method: None,
              reason: None,
              attribution: None,
              event: Some(event_row.ClaimExpired),
            ),
            core.no_more(),
            now,
          ))
          use _ <- result.map(notify_subject(
            tx,
            c,
            "A verification claim expired ("
              <> string.lowercase(string.replace(
              claim_type.to_string(c.claim_type),
              "_",
              " ",
            ))
              <> case c.licence_type {
              Some(l) -> ": " <> l
              None -> ""
            }
              <> "). Reconfirm it from Verification.",
            now,
          ))
          Nil
        })
      }
      let warned = fn(c: records.Claim) {
        store.unit(ctx.store, fn(tx) {
          use _ <- result.try(records.update_claim(
            tx,
            claim_row.Row(..c, expiry_warned_at: Some(now)),
          ))
          use _ <- result.map(notify_subject(
            tx,
            c,
            "A verification claim expires soon — reconfirm before "
              <> clock.date_string(option.unwrap(c.valid_until, now))
              <> ".",
            now,
          ))
          Nil
        })
      }
      list.each(expired, fn(c) {
        let _ = expire(c)
      })
      list.each(warn, fn(c) {
        let _ = warned(c)
      })
      list.length(expired) + list.length(warn)
    }
  }
}
