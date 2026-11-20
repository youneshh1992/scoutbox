//// The compliance ledger's routes (domains/agents/compliance): the attributed reviewer's sign-in and session, the
//// review queue and the decision on each kind of item (a facet, a dispute, a declared binding, a conflict
//// evaluation), and regulatory consents (the request, both parties' answers and their lists).

import gleam/bool
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/agents/agent_rules
import scoutbox/agents/agent_store
import scoutbox/agents/approach_policy
import scoutbox/agents/compliance_store.{type By}
import scoutbox/agents/conflict
import scoutbox/agents/consent_store.{type Consent}
import scoutbox/agents/context_view
import scoutbox/agents/reviews.{type Review}
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess, type PlayerAccess}
import scoutbox/identity/orgs
import scoutbox/identity/passwords
import scoutbox/identity/sessions
import scoutbox/identity/sign_in
import scoutbox/messaging/notifications
import scoutbox/platform/canonical
import scoutbox/platform/clock
import scoutbox/platform/effect
import scoutbox/platform/http
import scoutbox/platform/idempotency
import scoutbox/platform/input
import scoutbox/platform/key_order
import scoutbox/platform/limits
import scoutbox/platform/live_event
import scoutbox/platform/paging
import scoutbox/platform/rev
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/recruitment/domain_errors.{Contract}
import scoutbox/rows/agent_profile_facets as facet_row
import scoutbox/rows/agreement_history as agreement_event_row
import scoutbox/rows/compliance_context_history as context_event_row
import scoutbox/rows/compliance_context_parties as context_party_row
import scoutbox/rows/compliance_contexts as context_row
import scoutbox/rows/id
import scoutbox/rows/regulatory_consents as consent_row
import scoutbox/rows/regulatory_review_history as review_event_row
import scoutbox/rows/regulatory_review_reasons as review_reason_row
import scoutbox/rows/regulatory_reviews as review_row
import scoutbox/rows/representation_agreements as agreement_row
import scoutbox/rows/ts_reviewer_history as reviewer_event_row
import scoutbox/rows/ts_reviewers as reviewer_row
import scoutbox/verification/claims
import scoutbox/verification/records
import scoutbox/vocab/agent_actor_kind
import scoutbox/vocab/agent_facet
import scoutbox/vocab/agreement_status
import scoutbox/vocab/audience
import scoutbox/vocab/compliance_actor_kind
import scoutbox/vocab/context_outcome
import scoutbox/vocab/context_type
import scoutbox/vocab/declared_representation_status
import scoutbox/vocab/facet_state
import scoutbox/vocab/jurisdiction
import scoutbox/vocab/org_type
import scoutbox/vocab/party_role.{type PartyRole}
import scoutbox/vocab/review_status
import scoutbox/vocab/reviewer_role
import scoutbox/vocab/rule_status
import scoutbox/vocab/subject_kind
import scoutbox/vocab/terminator
import scoutbox/vocab/ver_level
import sqlight
import wisp.{type Request, type Response}

// ------------------------------------------------------------------------------------------------- refusals

/// COMPLIANCE_ERROR_HTTP (domains/agents/compliance/errors.mjs).
pub const statuses = [
  #("COMPLIANCE_INPUT_INVALID", 400),
  #("CONTEXT_INPUT_INVALID", 400),
  #("POLICY_INPUT_INVALID", 400),
  #("CONSENT_INPUT_INVALID", 400),
  #("REVIEW_INPUT_INVALID", 400),
  #("COMPLIANCE_CLIENT_KEY_INVALID", 400),
  #("EXPECTED_REV_INVALID", 400),
  #("REVIEWER_AUTH_REQUIRED", 401),
  #("REVIEWER_REVOKED", 401),
  #("REVIEWER_CREDENTIALS_INVALID", 401),
  #("REVIEWER_ROLE_REQUIRED", 403),
  #("AGENT_LICENCE_INACTIVE", 403),
  #("AGENT_VERIFICATION_STALE", 403),
  #("AGENT_VERIFICATION_REQUIRED", 403),
  #("AGENT_NATIONAL_REGISTRATION_REQUIRED", 403),
  #("AGENT_DOMESTIC_AUTHORISATION_REQUIRED", 403),
  #("AGENT_MINOR_AUTHORISATION_REQUIRED", 403),
  #("REPRESENTATION_REQUIRED", 403),
  #("REPRESENTATION_EXPIRED", 403),
  #("REPRESENTATION_SCOPE_INSUFFICIENT", 403),
  #("REPRESENTATION_CONFLICT", 403),
  #("MINOR_APPROACH_NOT_PERMITTED", 403),
  #("SIGNATORY_REQUIRED", 403),
  #("POLICY_DUAL_CONTROL_REQUIRED", 403),
  #("COMPLIANCE_ACTION_NOT_PERMITTED", 403),
  #("CONTEXT_NOT_FOUND", 404),
  #("REVIEW_NOT_FOUND", 404),
  #("CONSENT_NOT_FOUND", 404),
  #("PARTY_NOT_FOUND", 404),
  #("POLICY_NOT_FOUND", 404),
  #("REVIEWER_NOT_FOUND", 404),
  #("CONTEXT_CLOSED", 409),
  #("CONTEXT_VERSION_CONFLICT", 409),
  #("CONTEXT_IDEMPOTENCY_CONFLICT", 409),
  #("CONTEXT_PARTY_EXISTS", 409),
  #("REVIEW_NOT_PENDING", 409),
  #("REVIEW_VERSION_CONFLICT", 409),
  #("REVIEW_IDEMPOTENCY_CONFLICT", 409),
  #("REVIEW_CANNOT_OVERRIDE_ACTIVE_RULE", 409),
  #("REVIEW_REQUIRES_POLICY_VERSION", 409),
  #("REVIEW_ALREADY_EXISTS", 409),
  #("CONSENT_NOT_PENDING", 409),
  #("CONSENT_VERSION_CONFLICT", 409),
  #("CONSENT_IDEMPOTENCY_CONFLICT", 409),
  #("CONSENT_ALREADY_REQUESTED", 409),
  #("POLICY_VERSION_EXISTS", 409),
  #("POLICY_NOT_PROPOSED", 409),
  #("REVIEWER_EXISTS", 409),
  #("REVIEWER_VERSION_CONFLICT", 409),
  #("LAST_REVIEWER_ADMIN", 409),
  #("CONSENT_REQUIRED", 422),
  #("CONSENT_REVOKED", 422),
  #("GUARDIAN_CONSENT_REQUIRED", 422),
  #("REGULATORY_REVIEW_REQUIRED", 422),
  #("JURISDICTION_UNSUPPORTED", 422),
  #("COMPLIANCE_INSUFFICIENT_DATA", 422),
  #("REGULATORY_PROVIDER_UNAVAILABLE", 503),
  #("POLICY_UNAVAILABLE", 503),
  #("COMPLIANCE_STATE_UNKNOWN", 500),
]

pub const contract =
  Contract(
    statuses: statuses,
    public_fields: [
      "message", "allowed", "facet", "memberAssociation", "state", "code",
      "expectedRev", "currentRev", "updatedBy", "updatedAt", "retryAfter",
      "status", "agreementId", "field", "problem", "min", "max", "expected",
      "required", "reasons", "policyVersions", "consentsOutstanding",
      "consentKind", "reviewId", "contextId", "outcome", "reason", "role",
    ],
    internal_message: "The compliance service cannot serve this request. This has been recorded.",
    unmapped: "COMPLIANCE_STATE_UNKNOWN",
  )

fn err(
  code: String,
  message: String,
  fields: List(#(String, Json)),
) -> Response {
  domain_errors.refuse(contract, code, message, fields)
}

/// A refusal in this domain's format, for a compliance route another module serves. An empty message sends none.
pub fn refusal(
  code: String,
  message: String,
  fields: List(#(String, Json)),
) -> Response {
  case message {
    "" -> bare(code, fields)
    _ -> err(code, message, fields)
  }
}

pub fn bare(code: String, fields: List(#(String, Json))) -> Response {
  domain_errors.send(contract, code, fields)
}

pub fn storage(r: Result(a, Fail(e))) -> Result(a, Fail(Response)) {
  store.map_refusal(r, fn(_) { http.error(500, "INTERNAL") })
}

pub fn answer_unit(r: Result(Response, store.UnitError(Response))) -> Response {
  case r {
    Ok(response) -> response
    Error(store.Refused(response)) -> response
    Error(store.Lost(what)) -> http.stale(what)
    Error(e) -> http.internal(e)
  }
}

pub fn reading(
  ctx: Ctx,
  f: fn(Read) -> Result(a, Fail(e)),
  next: fn(a) -> Response,
) -> Response {
  case store.read(ctx.store, f) {
    Ok(v) -> next(v)
    Error(e) -> http.internal(e)
  }
}

const field_codes = [
  #("clientKey", "COMPLIANCE_CLIENT_KEY_INVALID"),
  #("expectedRev", "EXPECTED_REV_INVALID"),
  #("expectedVersion", "EXPECTED_REV_INVALID"),
]

fn parsed(
  shape: input.Shape(a),
  raw: Dynamic,
  root: String,
  default: String,
  next: fn(a) -> Response,
) -> Response {
  parsed_in_order(shape, raw, key_order.Unknown, root, default, next)
}

fn parsed_in_order(
  shape: input.Shape(a),
  raw: Dynamic,
  order: key_order.KeyOrder,
  root: String,
  default: String,
  next: fn(a) -> Response,
) -> Response {
  case
    input.parse_in_order(shape, raw, order, root:, codes: field_codes, default:)
  {
    Ok(v) -> next(v)
    Error(r) -> input_refusal(r, default)
  }
}

/// A refusal of the input under this domain's codes: a date's own DATE_INVALID is the schema's code here
/// (schemas.mjs `complianceParseOptions`).
pub fn input_refusal(r: input.Refusal, default: String) -> Response {
  let code = case r.error {
    "DATE_INVALID" -> default
    other -> other
  }
  domain_errors.send(contract, code, input.refusal_fields(r))
}

pub fn body(
  req: Request,
  shape: input.Shape(a),
  default: String,
  next: fn(a, Dynamic) -> Response,
) -> Response {
  use raw, order <- http.json_body_in_order(req)
  use v <- parsed_in_order(shape, raw, order, "body", default)
  next(v, raw)
}

/// The JSON body read with `shape` under this domain's refusal format, for a compliance route another module serves.
pub fn parsed_body(
  req: Request,
  shape: input.Shape(a),
  default: String,
  next: fn(a) -> Response,
) -> Response {
  use v, _ <- body(req, shape, default)
  next(v)
}

pub fn client_key(
  raw: Option(String),
  next: fn(Option(String)) -> Response,
) -> Response {
  case idempotency.client_key(option.map(raw, dynamic.string)) {
    Ok(k) -> next(k)
    Error(message) -> err("COMPLIANCE_CLIENT_KEY_INVALID", message, [])
  }
}

fn rate_limited(action: limits.Action) -> Response {
  http.json(
    429,
    json.object(
      list.map(limits.limited_body(action), fn(p) { #(p.0, json.string(p.1)) }),
    ),
  )
}

pub fn limited(
  ctx: Ctx,
  req: Request,
  action: limits.Action,
  key: String,
  next: fn() -> Response,
) -> Response {
  case
    !http.rerun(req) && limits.limited(ctx.limits, action, key, clock.now_ms())
  {
    True -> rate_limited(action)
    False -> next()
  }
}

pub fn fingerprint(fields: List(#(String, canonical.Value))) -> String {
  canonical.Object(fields) |> canonical.to_string
}

pub fn guard_rev(
  raw: Dynamic,
  current: rev.Rev,
  code: String,
  fields: List(#(String, Json)),
  next: fn() -> Response,
) -> Response {
  case rev.expected(raw) {
    Error(response) -> response
    Ok(expected) -> rev.guard(expected, current, code, fields, next)
  }
}

// ------------------------------------------------------------------------------------------------- reviewers

fn public_reviewer(r: reviewer_row.Row) -> Json {
  json.object([
    #("id", id.reviewer_json(r.id)),
    #("name", json.string(r.name)),
    #("role", reviewer_role.to_json(r.role)),
    #("status", reviewer_row.status_to_json(r.status)),
    #("createdAt", json.int(r.created_at)),
    #("revokedAt", json.nullable(r.revoked_at, json.int)),
    ..rev.meta(rev.Rev(r.rev, r.rev_at, r.rev_by_name))
  ])
}

fn active_reviewer(
  read: Read,
  reviewer_id: String,
) -> Result(Option(reviewer_row.Row), Fail(e)) {
  store.one(
    read,
    "SELECT "
      <> reviewer_row.columns
      <> " FROM ts_reviewers WHERE id = ? AND status = 'active'",
    [sqlight.text(reviewer_id)],
    reviewer_row.decoder(),
  )
  |> result.map(option.from_result)
}

/// `POST /auth/reviewer/login`: one refusal for an unknown id, a wrong secret and a revoked reviewer. The failed
/// sign-in budget is checked before the secret, keyed by the identifier whatever its state.
pub fn login(ctx: Ctx, req: Request) -> Response {
  let shape = {
    use reviewer_id <- input.field("reviewerId", input.required(input.text(40)))
    use secret <- input.field("secret", input.required(input.text(200)))
    input.done(#(reviewer_id, secret))
  }
  use b, _ <- body(req, shape, "COMPLIANCE_INPUT_INVALID")
  let reviewer_id = string.trim(b.0)
  let now = clock.now_ms()
  let bucket = "reviewer:" <> string.lowercase(reviewer_id)
  case limits.login_locked(ctx.limits, bucket, now) {
    True -> sign_in.locked_out()
    False -> {
      use found <- reading(ctx, active_reviewer(_, reviewer_id))
      case found {
        Some(r) ->
          case passwords.verify(b.1, r.secret_hash) {
            True -> {
              let minted =
                store.unit(ctx.store, fn(tx) {
                  sessions.create(
                    tx,
                    sessions.Reviewer(id.reviewer_to_string(r.id)),
                    now,
                    ctx.config.session_ttl_ms,
                  )
                  |> storage
                })
              case minted {
                Ok(token) ->
                  http.json(
                    200,
                    json.object([
                      #("token", json.string(token)),
                      #("reviewer", public_reviewer(r)),
                    ]),
                  )
                Error(e) -> http.internal(e)
              }
            }
            False -> refused_login(ctx, bucket, now)
          }
        None -> refused_login(ctx, bucket, now)
      }
    }
  }
}

fn refused_login(ctx: Ctx, bucket: String, now: Int) -> Response {
  limits.login_failed(ctx.limits, bucket, now)
  err(
    "REVIEWER_CREDENTIALS_INVALID",
    "Reviewer id and secret do not match an active reviewer.",
    [],
  )
}

/// The reviewer comes from the session, never from a body field, a header or the shared admin key.
pub fn reviewer_session(
  ctx: Ctx,
  req: Request,
  next: fn(reviewer_row.Row) -> Response,
) -> Response {
  let now = clock.now_ms()
  let required = fn() {
    err(
      "REVIEWER_AUTH_REQUIRED",
      "An authenticated Trust & Safety reviewer session is required. The shared admin key is not a reviewer.",
      [],
    )
  }
  case http.bearer(req) {
    Error(Nil) -> required()
    Ok(token) -> {
      use found <- reading(ctx, fn(r) {
        use session <- result.try(sessions.by_token(
          r,
          token,
          now,
          ctx.config.session_ttl_ms,
        ))
        case session {
          Some(sessions.Session(sid:, holder: sessions.Reviewer(rid), ..)) ->
            active_reviewer(r, rid) |> result.map(fn(x) { Some(#(sid, x)) })
          _ -> Ok(None)
        }
      })
      case found {
        None -> required()
        Some(#(_, Some(r))) -> next(r)
        Some(#(sid, None)) -> {
          let _ =
            store.unit(ctx.store, fn(tx) {
              sessions.revoke_sid(tx, sid) |> storage
            })
          err(
            "REVIEWER_REVOKED",
            "This reviewer's access has been revoked.",
            [],
          )
        }
      }
    }
  }
}

pub fn by_reviewer(r: reviewer_row.Row) -> By {
  compliance_store.By(
    kind: compliance_actor_kind.TsReviewer,
    id: Some(id.reviewer_to_string(r.id)),
    name: Some(r.name),
    role: Some(reviewer_role.to_string(r.role)),
    org_id: None,
  )
}

// --------------------------------------------------------------------------------------- reviewer administration

/// How records made through the shared admin key are kept (reviewers.mjs `REVIEWER_LEGACY_NOTE`).
pub const legacy_note =
  "Records made through the shared admin key before reviewers had their own sign-in carry attribution \"shared_admin_key\" and are preserved as legacy/unattributed. They were never rewritten and are not authoritative compliance decisions."

/// The reviewer holds `role`; an administrator holds the reviewer's role too.
fn require_role(
  reviewer: reviewer_row.Row,
  role: reviewer_role.ReviewerRole,
  next: fn() -> Response,
) -> Response {
  case reviewer.role == role || role == reviewer_role.TrustSafetyReviewer {
    True -> next()
    False -> {
      let name = reviewer_role.to_string(role)
      err(
        "REVIEWER_ROLE_REQUIRED",
        "This action needs the " <> name <> " role.",
        [
          #("role", json.string(name)),
        ],
      )
    }
  }
}

/// `GET /ts/me`.
pub fn me(reviewer: reviewer_row.Row) -> Response {
  http.json(
    200,
    json.object([
      #("reviewer", public_reviewer(reviewer)),
      #("attribution", json.string("authenticated_reviewer")),
      #(
        "note",
        json.string(
          "Every authoritative compliance action is recorded against this identity.",
        ),
      ),
    ]),
  )
}

fn reviewer_by_id(
  read: Read,
  reviewer_id: id.ReviewerId,
) -> Result(Option(reviewer_row.Row), Fail(e)) {
  store.one(
    read,
    "SELECT " <> reviewer_row.columns <> " FROM ts_reviewers WHERE id = ?",
    [id.reviewer_sql(reviewer_id)],
    reviewer_row.decoder(),
  )
  |> result.map(option.from_result)
}

/// `GET /ts/reviewers`: the Trust & Safety team, oldest first. Administrators only.
pub fn reviewers(ctx: Ctx, reviewer: reviewer_row.Row) -> Response {
  use <- require_role(reviewer, reviewer_role.TrustSafetyAdmin)
  use all <- reading(ctx, fn(r) {
    store.query(
      r,
      "SELECT " <> reviewer_row.columns <> " FROM ts_reviewers ORDER BY rowid",
      [],
      reviewer_row.decoder(),
    )
  })
  http.json(
    200,
    json.object([
      #("items", json.array(all, public_reviewer)),
      #("legacyNote", json.string(legacy_note)),
    ]),
  )
}

fn reviewer_event(
  tx: Tx,
  reviewer_id: id.ReviewerId,
  by: reviewer_row.Row,
  action: reviewer_event_row.Action,
  detail_role: Option(reviewer_role.ReviewerRole),
  detail_reason: Option(String),
  at: Int,
) -> Result(Nil, Fail(e)) {
  use event_id <- result.try(id.next_reviewer_event(tx))
  use ord <- result.try(store.one(
    store.reading(tx),
    "SELECT COUNT(*) FROM ts_reviewer_history WHERE reviewer_id = ?",
    [id.reviewer_sql(reviewer_id)],
    decode.at([0], decode.int),
  ))
  reviewer_event_row.insert(
    tx,
    reviewer_event_row.Row(
      id: event_id,
      reviewer_id:,
      ord: result.unwrap(ord, 0),
      at:,
      by_kind: reviewer_event_row.TsReviewer,
      by_id: Some(id.reviewer_to_string(by.id)),
      by_name: Some(by.name),
      by_role: Some(by.role),
      action:,
      detail_role:,
      detail_reason:,
    ),
  )
}

/// `POST /ts/reviewers`: an administrator provisions a reviewer. The secret is hashed before the unit.
pub fn create_reviewer(
  ctx: Ctx,
  req: Request,
  reviewer: reviewer_row.Row,
) -> Response {
  use <- require_role(reviewer, reviewer_role.TrustSafetyAdmin)
  let shape = {
    use new_id <- input.field(
      "id",
      input.required(input.matching_said(
        "[a-zA-Z0-9][a-zA-Z0-9-]{2,39}",
        "must be 3 to 40 letters, digits or dashes",
      )),
    )
    use name <- input.field("name", input.required(input.required_text(80)))
    use role <- input.field(
      "role",
      input.optional(input.one_of(reviewer_role.pairs)),
    )
    use secret <- input.field(
      "secret",
      input.required(input.text_between(12, 200)),
    )
    input.done(#(new_id, string.trim(name), role, secret))
  }
  use b, _ <- body(req, shape, "COMPLIANCE_INPUT_INVALID")
  let #(new_id, name, role, secret) = b
  let role = option.unwrap(role, reviewer_role.TrustSafetyReviewer)
  use existing <- reading(ctx, reviewer_by_id(_, id.reviewer(new_id)))
  case existing {
    Some(_) -> bare("REVIEWER_EXISTS", [])
    None -> {
      let secret_hash = passwords.hash(secret)
      let now = clock.now_ms()
      let created =
        store.unit(ctx.store, fn(tx) {
          let r =
            reviewer_row.Row(
              id: id.reviewer(new_id),
              name:,
              role:,
              status: reviewer_row.Active,
              secret_hash:,
              created_at: now,
              created_by_kind: reviewer_row.TsReviewer,
              created_by_id: Some(id.reviewer_to_string(reviewer.id)),
              created_by_name: Some(reviewer.name),
              created_by_role: Some(reviewer_role.to_string(reviewer.role)),
              revoked_at: None,
              revoked_by_id: None,
              revoked_by_name: None,
              rev: 1,
              rev_at: Some(now),
              rev_by_name: None,
              rev_by_id: None,
            )
          use _ <- result.try(reviewer_row.insert(tx, r))
          use _ <- result.map(reviewer_event(
            tx,
            r.id,
            reviewer,
            reviewer_event_row.ReviewerCreated,
            Some(role),
            None,
            now,
          ))
          r
        })
      case created {
        Ok(r) ->
          http.json(201, json.object([#("reviewer", public_reviewer(r))]))
        Error(e) -> http.internal(e)
      }
    }
  }
}

/// `POST /ts/reviewers/:id/revoke`: final, and the reviewer's sessions end with it. The last administrator stays.
pub fn revoke_reviewer(
  ctx: Ctx,
  req: Request,
  reviewer: reviewer_row.Row,
  target_id: String,
) -> Response {
  use <- require_role(reviewer, reviewer_role.TrustSafetyAdmin)
  use target <- reading(ctx, reviewer_by_id(_, id.reviewer(target_id)))
  case target {
    None -> bare("REVIEWER_NOT_FOUND", [])
    Some(t) -> {
      let shape = {
        use reason <- input.field("reason", input.nullish(input.text(200)))
        use <- rev.fields
        input.done(reason)
      }
      use reason, raw <- body(req, shape, "COMPLIANCE_INPUT_INVALID")
      case t.status {
        reviewer_row.Revoked ->
          http.json(
            200,
            json.object([
              #("reviewer", public_reviewer(t)),
              #("idempotent", json.bool(True)),
            ]),
          )
        reviewer_row.Active -> {
          use admins <- reading(ctx, fn(r) {
            store.one(
              r,
              "SELECT COUNT(*) FROM ts_reviewers WHERE status = 'active' AND role = 'trust_safety_admin'",
              [],
              decode.at([0], decode.int),
            )
            |> result.map(result.unwrap(_, 0))
          })
          case t.role == reviewer_role.TrustSafetyAdmin && admins <= 1 {
            True ->
              err(
                "LAST_REVIEWER_ADMIN",
                "At least one Trust & Safety administrator must remain.",
                [],
              )
            False -> {
              use <- guard_rev(
                raw,
                rev.Rev(t.rev, t.rev_at, t.rev_by_name),
                "REVIEWER_VERSION_CONFLICT",
                [],
              )
              let now = clock.now_ms()
              answer_unit(
                store.unit(ctx.store, fn(tx) {
                  use revoked <- result.try(
                    store.write(
                      tx,
                      "UPDATE ts_reviewers SET status = 'revoked', revoked_at = ?, revoked_by_id = ?, revoked_by_name = ? WHERE id = ? AND status = 'active' RETURNING 1",
                      [
                        sqlight.int(now),
                        id.reviewer_sql(reviewer.id),
                        sqlight.text(reviewer.name),
                        id.reviewer_sql(t.id),
                      ],
                      decode.at([0], decode.int),
                    )
                    |> storage,
                  )
                  // Another administrator revoked them first: answer from the new state.
                  use <- bool.guard(revoked == [], store.stale("a reviewer"))
                  // Two administrators revoking each other at once would leave none: the later one re-runs and is
                  // refused as the last.
                  use admins_left <- result.try(
                    store.one(
                      store.reading(tx),
                      "SELECT COUNT(*) FROM ts_reviewers WHERE status = 'active' AND role = 'trust_safety_admin'",
                      [],
                      decode.at([0], decode.int),
                    )
                    |> storage,
                  )
                  use <- bool.guard(
                    admins_left == Ok(0),
                    store.stale("the last administrator"),
                  )
                  use _ <- result.try(
                    store.run(
                      tx,
                      "UPDATE ts_reviewers SET rev = rev + 1, rev_at = ?, rev_by_id = ?, rev_by_name = ? WHERE id = ?",
                      [
                        sqlight.int(now),
                        id.reviewer_sql(reviewer.id),
                        sqlight.text(reviewer.name),
                        id.reviewer_sql(t.id),
                      ],
                    )
                    |> storage,
                  )
                  use _ <- result.try(
                    reviewer_event(
                      tx,
                      t.id,
                      reviewer,
                      reviewer_event_row.ReviewerRevoked,
                      None,
                      input.filled(reason),
                      now,
                    )
                    |> storage,
                  )
                  use _ <- result.try(
                    sessions.revoke_reviewer(tx, id.reviewer_to_string(t.id))
                    |> storage,
                  )
                  use after <- result.map(
                    reviewer_by_id(store.reading(tx), t.id)
                    |> storage,
                  )
                  let assert Some(after) = after
                  http.json(
                    200,
                    json.object([#("reviewer", public_reviewer(after))]),
                  )
                }),
              )
            }
          }
        }
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------- reviews

fn subject_json(r: review_row.Row) -> Json {
  let text = json.nullable(_, json.string)
  case r.kind {
    review_row.VerificationFacet ->
      json.object([
        #(
          "profileId",
          json.nullable(r.subject_profile_id, id.agent_profile_json),
        ),
        #("userId", json.nullable(r.subject_user_id, id.org_user_json)),
        #("facet", json.nullable(r.subject_facet, agent_facet.to_json)),
        #("memberAssociation", text(r.subject_member_association)),
      ])
    review_row.RepresentationDispute ->
      json.object([
        #(
          "agreementId",
          json.nullable(r.subject_agreement_id, id.agreement_json),
        ),
      ])
    _ ->
      case r.subject_is_approach {
        True ->
          json.object([
            #("approach", json.bool(True)),
            #("playerId", json.nullable(r.subject_player_id, id.player_json)),
            #("jurisdiction", text(r.subject_jurisdiction)),
          ])
        False ->
          json.object(
            list.flatten([
              [#("contextId", text(r.subject_context_id))],
              case r.subject_transaction_id {
                Some(t) -> [#("transactionId", json.string(t))]
                None -> []
              },
              [
                #("representationId", text(r.subject_representation_id)),
                #(
                  "partyRole",
                  json.nullable(r.subject_party_role, party_role.to_json),
                ),
              ],
            ]),
          )
      }
  }
}

/// A decision's prior or resulting state, by the kind of thing the review was about (reviewRoutes.mjs
/// `reviewEffectState` and `applyReviewDecision`).
fn state_json(
  r: review_row.Row,
  status: Option(review_status.ReviewStatus),
  facet: Option(facet_state.FacetState),
  agreement: Option(agreement_status.AgreementStatus),
  context: Option(context_outcome.ContextOutcome),
  representation: Option(
    declared_representation_status.DeclaredRepresentationStatus,
  ),
  note: Option(review_row.ResultNote),
) -> Json {
  let status_field = case status {
    Some(s) -> [#("status", review_status.to_json(s))]
    None -> []
  }
  let state = case r.kind, note {
    review_row.VerificationFacet, _ -> [
      #("facetState", json.nullable(facet, facet_state.to_json)),
    ]
    review_row.RepresentationDispute, _ -> [
      #("agreementStatus", json.nullable(agreement, agreement_status.to_json)),
    ]
    _, Some(review_row.ContextGone) -> [#("contextOutcome", json.null())]
    _, _ -> [
      #("contextOutcome", json.nullable(context, context_outcome.to_json)),
      #(
        "representationStatus",
        json.nullable(representation, declared_representation_status.to_json),
      ),
    ]
  }
  let note_field = case note {
    Some(n) -> [#("note", review_row.result_note_to_json(n))]
    None -> []
  }
  json.object(list.flatten([status_field, state, note_field]))
}

/// A review's reason in full, as the reviewer reads it.
fn review_reason(
  rv: Review,
  x: review_reason_row.Row,
) -> context_view.ReasonFields {
  let listed = fn(which) {
    list.filter_map(rv.reason_items, fn(i) {
      case i.0 == x.ord && i.1 == which {
        True -> Ok(i.2)
        False -> Error(Nil)
      }
    })
  }
  context_view.ReasonFields(
    code: x.code,
    rule_id: x.rule_id,
    rule_status: x.rule_status,
    regulator: x.regulator,
    jurisdiction: x.jurisdiction,
    policy_version: x.policy_version_id,
    facet: x.facet,
    member_association: x.member_association,
    state: x.state,
    agent_user_id: option.map(x.agent_user_id, id.org_user_to_string),
    party_role: x.party_role,
    party_roles: case x.has_party_roles {
      True -> Some(listed("partyRoles"))
      False -> None
    },
    consent_kind: x.consent_kind,
    detail: x.detail_text,
    reason: x.reason_text,
    override_rule_id: x.override_rule_id,
    kind: x.kind_text,
    via_connected_agent: x.via_connected_agent == Some(1),
    jurisdictions: case x.has_jurisdictions {
      True -> Some(listed("jurisdictions"))
      False -> None
    },
  )
}

/// The reviewer's view of a review: its snapshot is the evaluation it was raised on, read back.
pub fn reviewer_view(read: Read, rv: Review) -> Result(Json, Fail(e)) {
  let r = rv.row
  case r.snapshot_outcome, r.snapshot_evaluation_id {
    Some(_), Some(eid) -> {
      use ev <- result.map(context_view.evaluation(read, id.evaluation(eid)))
      review_object(rv, True, case ev {
        Some(e) -> snapshot_of_evaluation(e)
        None -> reviewer_snapshot(rv)
      })
    }
    _, _ -> Ok(review_json(rv, True))
  }
}

fn snapshot_of_evaluation(e: context_view.Evaluation) -> Json {
  let full = context_view.evaluation_json_fields(e)
  let keys = [
    "outcome", "alias", "reasons", "consentsOutstanding", "requiredActions",
    "missingEvidence", "policyVersions", "evaluatedAt", "inputHash",
  ]
  json.object(
    list.flatten([
      list.filter_map(keys, fn(k) {
        list.key_find(full, k) |> result.map(fn(v) { #(k, v) })
      }),
      [
        #("proposed", context_view.proposed_json(e)),
        #("evaluationId", id.evaluation_json(e.row.id)),
      ],
    ]),
  )
}

/// A snapshot with no evaluation to read back: the outcome, the review's own reasons and versions.
fn reviewer_snapshot(rv: Review) -> Json {
  let r = rv.row
  case r.snapshot_outcome {
    Some(outcome) ->
      json.object([
        #("outcome", context_outcome.to_json(outcome)),
        #(
          "reasons",
          json.array(rv.reasons, fn(x) {
            context_view.reason_fields_json(review_reason(rv, x))
          }),
        ),
        #("policyVersions", json.array(rv.policy_versions, id.policy_json)),
        #("evaluatedAt", json.nullable(r.snapshot_evaluated_at, json.int)),
      ])
    None -> json.null()
  }
}

/// A review item: the agent's projection, or with `for_reviewer` the reviewer's (the decision's reason, evidence and
/// states, and the full snapshot).
pub fn review_json(rv: Review, for_reviewer: Bool) -> Json {
  let r = rv.row
  review_object(rv, for_reviewer, case for_reviewer, r.snapshot_outcome {
    True, _ -> reviewer_snapshot(rv)
    False, Some(outcome) ->
      json.object([
        #("outcome", context_outcome.to_json(outcome)),
        #("evaluatedAt", json.nullable(r.snapshot_evaluated_at, json.int)),
        #("policyVersions", json.array(rv.policy_versions, id.policy_json)),
      ])
    False, None -> json.null()
  })
}

fn review_object(rv: Review, for_reviewer: Bool, snapshot: Json) -> Json {
  let r = rv.row
  let pvs = json.array(rv.policy_versions, id.policy_json)
  json.object([
    #("id", id.regulatory_review_json(r.id)),
    #("kind", review_row.kind_to_json(r.kind)),
    #("status", review_status.to_json(r.status)),
    #("agencyOrgId", id.org_json(r.agency_org_id)),
    #("agentUserId", json.nullable(r.agent_user_id, id.org_user_json)),
    #("subject", subject_json(r)),
    #(
      "reasons",
      json.array(rv.reasons, fn(x) {
        json.object([
          #("code", json.string(x.code)),
          #("ruleId", json.nullable(x.rule_id, json.string)),
          #("ruleStatus", json.nullable(x.rule_status, rule_status.to_json)),
          #("policyVersion", json.nullable(x.policy_version_id, id.policy_json)),
        ])
      }),
    ),
    #("policyVersions", pvs),
    #("requestedAt", json.int(r.requested_at)),
    #("startedAt", json.nullable(r.started_at, json.int)),
    #("decidedAt", json.nullable(r.decided_at, json.int)),
    #("decision", case r.decision_reviewer_id, r.decision_outcome {
      Some(reviewer), Some(outcome) ->
        json.object(
          list.flatten([
            [
              #("outcome", review_row.decision_outcome_to_json(outcome)),
              #(
                "reasonCode",
                json.nullable(r.decision_reason_code, json.string),
              ),
              #(
                "reviewer",
                json.object([
                  #("id", json.string(reviewer)),
                  #(
                    "name",
                    json.nullable(r.decision_reviewer_name, json.string),
                  ),
                  #(
                    "role",
                    json.nullable(
                      r.decision_reviewer_role,
                      reviewer_role.to_json,
                    ),
                  ),
                ]),
              ),
              #("evidenceCount", json.int(list.length(rv.evidence_refs))),
            ],
            case for_reviewer {
              True if outcome == review_row.Cancelled -> [
                #("reason", json.nullable(r.decision_reason, json.string)),
                #("evidenceRefs", json.array(rv.evidence_refs, json.string)),
                #("priorState", json.null()),
                #("resultingState", json.null()),
              ]
              True -> [
                #("reason", json.nullable(r.decision_reason, json.string)),
                #("evidenceRefs", json.array(rv.evidence_refs, json.string)),
                #(
                  "priorState",
                  state_json(
                    r,
                    r.prior_status,
                    r.prior_facet_state,
                    r.prior_agreement_status,
                    r.prior_context_outcome,
                    r.prior_representation_status,
                    None,
                  ),
                ),
                #(
                  "resultingState",
                  state_json(
                    r,
                    None,
                    r.result_facet_state,
                    r.result_agreement_status,
                    r.result_context_outcome,
                    r.result_representation_status,
                    r.result_note,
                  ),
                ),
              ]
              False -> []
            },
            [
              #("policyVersions", pvs),
              #("at", json.nullable(r.decision_at, json.int)),
            ],
          ]),
        )
      _, _ -> json.null()
    }),
    #("startedBy", case r.started_by_id {
      Some(sid) ->
        json.object([
          #("id", json.string(sid)),
          #("name", json.nullable(r.started_by_name, json.string)),
        ])
      None -> json.null()
    }),
    #("supersedes", json.nullable(r.supersedes_id, id.regulatory_review_json)),
    #(
      "supersededBy",
      json.nullable(rv.superseded_by, id.regulatory_review_json),
    ),
    #("snapshot", snapshot),
    ..list.append(rev.meta(rev.Rev(r.rev, r.rev_at, r.rev_by_name)), [
      #(
        "honest",
        json.string(
          "A ScoutBox reviewer decides whether the ScoutBox workflow may proceed under the encoded rules. This is not a legal determination and no governing body has approved anything.",
        ),
      ),
    ])
  ])
}

/// `GET /ts/compliance/reviews`: open items first, each part oldest first.
pub fn review_queue(
  ctx: Ctx,
  req: Request,
  reviewer: reviewer_row.Row,
) -> Response {
  use items, next <- queue(ctx, req, True)
  http.json(
    200,
    json.object([
      #("items", items),
      #("nextCursor", json.nullable(next, json.string)),
      #("statuses", json.array(review_status.pairs, fn(x) { json.string(x.0) })),
      #("kinds", json.array(review_row.kind_pairs, fn(x) { json.string(x.0) })),
      #("reviewer", public_reviewer(reviewer)),
    ]),
  )
}

/// `GET /admin/compliance/reviews`: the shared key reads the queue, and can adjudicate nothing.
pub fn admin_review_queue(ctx: Ctx, req: Request) -> Response {
  use items, next <- queue(ctx, req, False)
  http.json(
    200,
    json.object([
      #("items", items),
      #("nextCursor", json.nullable(next, json.string)),
      #("readOnly", json.bool(True)),
      #(
        "note",
        json.string(
          "Read-only. Starting, resolving, cancelling or superseding a review requires an authenticated reviewer session (/ts). The shared key can adjudicate nothing.",
        ),
      ),
    ]),
  )
}

/// A page of the queue, each review as `for_reviewer` sees it.
fn queue(
  ctx: Ctx,
  req: Request,
  for_reviewer: Bool,
  next: fn(Json, Option(String)) -> Response,
) -> Response {
  let shape = {
    use status <- input.field(
      "status",
      input.optional(input.one_of(review_status.pairs)),
    )
    use limit <- input.field("limit", input.optional(input.text(1_000_000)))
    use cursor <- input.field("cursor", input.optional(input.text(1_000_000)))
    input.done(#(status, limit, cursor))
  }
  use q <- parsed(shape, http.query_input(req), "query", "REVIEW_INPUT_INVALID")
  case
    paging.read(paging.Query(limit: q.1, cursor: q.2), [
      paging.IntKind,
      paging.IntKind,
      paging.IntKind,
    ])
  {
    Error(e) -> {
      let #(code, message) = paging.error_body(e)
      http.error_message(400, code, message)
    }
    Ok(p) -> {
      let after = case p.after {
        Some([paging.IntKey(a), paging.IntKey(b), paging.IntKey(c)]) ->
          Some(#(a, b, c))
        _ -> None
      }
      use rows <- reading(ctx, reviews.queue_page(_, q.0, after, p.limit))
      let #(items, cursor) =
        paging.page_of(rows, p.limit, fn(x) {
          let #(a, b, c) = x.0
          [paging.IntKey(a), paging.IntKey(b), paging.IntKey(c)]
        })
      use views <- reading(ctx, fn(read) {
        list.try_map(items, fn(x) {
          case for_reviewer {
            True -> reviewer_view(read, x.1)
            False -> Ok(review_json(x.1, False))
          }
        })
      })
      next(json.preprocessed_array(views), cursor)
    }
  }
}

/// Reason codes only a policy version can settle: a reviewer may not approve past them.
const policy_level_reasons = [
  "RULE_STATUS_UNCERTAIN", "POLICY_NOT_ENCODED", "NO_ACTIVE_RULE_DECIDES",
  "SCOPE_MIXED", "EXCLUSIVITY_WINDOW_DOUBTFUL",
]

type Resolution {
  Resolution(
    outcome: review_row.DecisionOutcome,
    reason_code: Option(String),
    reason: Option(String),
    evidence_refs: Option(List(String)),
    client_key: Option(String),
  )
}

/// What a decision on a declared binding lands on: the transaction's own binding row, its re-check, and the
/// context's evaluation. The transaction lane provides it, so this module does not depend on the workspace.
pub type BindingDecided =
  fn(Tx, String, String, Bool, By, id.RegulatoryReviewId, Int) ->
    Result(Nil, Fail(Response))

/// `POST /ts/compliance/reviews/:id/resolve`: a reviewer resolves missing or uncertain facts, never active policy.
pub fn resolve_review(
  ctx: Ctx,
  req: Request,
  reviewer: reviewer_row.Row,
  review_id: String,
  binding_decided: BindingDecided,
) -> Response {
  use <- limited(
    ctx,
    req,
    limits.TsReviewDecision,
    id.reviewer_to_string(reviewer.id),
  )
  use found <- reading(ctx, reviews.by_id(_, id.regulatory_review(review_id)))
  case found {
    None -> bare("REVIEW_NOT_FOUND", [])
    Some(rv) -> {
      let shape = {
        use outcome <- input.field(
          "outcome",
          input.required(
            input.one_of([
              #("APPROVED", review_row.Approved),
              #("REJECTED", review_row.Rejected),
            ]),
          ),
        )
        use reason_code <- input.field(
          "reasonCode",
          input.nullish(input.text(60)),
        )
        use reason <- input.field("reason", input.nullish(input.text(1000)))
        use refs <- input.field(
          "evidenceRefs",
          input.nullish(input.items_between(input.text(200), 0, 10)),
        )
        use client_key <- input.field(
          "clientKey",
          input.nullish(input.text(1_000_000)),
        )
        use <- rev.fields
        input.done(Resolution(outcome, reason_code, reason, refs, client_key))
      }
      use b, raw <- body(req, shape, "REVIEW_INPUT_INVALID")
      use key <- client_key(b.client_key)
      let reason_code = input.filled(b.reason_code) |> option.unwrap("")
      let reason = input.filled(b.reason) |> option.unwrap("")
      let refs =
        option.unwrap(b.evidence_refs, [])
        |> list.filter_map(fn(x) {
          input.filled(Some(x)) |> option.to_result(Nil)
        })
        |> list.unique
      let approved = b.outcome == review_row.Approved
      let fp =
        fingerprint([
          #(
            "outcome",
            canonical.Str(review_row.decision_outcome_to_string(b.outcome)),
          ),
          #("reasonCode", canonical.Str(reason_code)),
          #("reason", canonical.Str(reason)),
          #("evidenceRefs", canonical.strings(refs)),
        ])
      let r = rv.row
      let is_open =
        r.status == review_status.Pending || r.status == review_status.InReview
      let codes = list.map(rv.reasons, fn(x) { x.code })
      case key, r.resolve_key {
        Some(k), Some(stored) if k == stored ->
          case r.resolve_fp == Some(fp) {
            True -> {
              use reviewed <- reading(ctx, reviewer_view(_, rv))
              http.json(
                200,
                json.object([
                  #("review", reviewed),
                  #("idempotent", json.bool(True)),
                ]),
              )
            }
            False -> bare("REVIEW_IDEMPOTENCY_CONFLICT", [])
          }
        _, _ ->
          case reason_code, reason, approved && refs == [], is_open {
            "", _, _, _ | _, "", _, _ ->
              err(
                "REVIEW_INPUT_INVALID",
                "A reason code and a written reason are required.",
                [
                  #(
                    "field",
                    json.string(case reason_code {
                      "" -> "reasonCode"
                      _ -> "reason"
                    }),
                  ),
                  #("problem", json.string("required")),
                ],
              )
            _, _, True, _ ->
              err(
                "REVIEW_INPUT_INVALID",
                "An approval must cite at least one evidence reference.",
                [
                  #("field", json.string("evidenceRefs")),
                  #("problem", json.string("required")),
                ],
              )
            _, _, _, False ->
              bare("REVIEW_NOT_PENDING", [
                #("status", review_status.to_json(r.status)),
              ])
            _, _, _, True ->
              case
                approved
                && {
                  r.snapshot_outcome == Some(context_outcome.ProhibitedConflict)
                  || list.any(codes, fn(c) {
                    c == "PROHIBITED_COMBINATION"
                    || c == "COMBINATION_NOT_PERMITTED"
                  })
                },
                approved
                && r.kind == review_row.ConflictEvaluation
                && list.any(codes, list.contains(policy_level_reasons, _))
              {
                True, _ ->
                  err(
                    "REVIEW_CANNOT_OVERRIDE_ACTIVE_RULE",
                    "An objectively prohibited combination under an ACTIVE rule cannot be approved by review.",
                    [],
                  )
                _, True ->
                  err(
                    "REVIEW_REQUIRES_POLICY_VERSION",
                    "The deciding rule's status is uncertain or not encoded. Only a published policy version (dual control) can settle that; a review cannot approve past it. It may be rejected (the workflow does not proceed) or left pending.",
                    [
                      #(
                        "reasons",
                        json.array(
                          list.filter(rv.reasons, fn(x) {
                            list.contains(policy_level_reasons, x.code)
                          }),
                          fn(x) {
                            json.object([
                              #("code", json.string(x.code)),
                              #("ruleId", json.nullable(x.rule_id, json.string)),
                              #(
                                "ruleStatus",
                                json.nullable(
                                  x.rule_status,
                                  rule_status.to_json,
                                ),
                              ),
                              #(
                                "regulator",
                                json.nullable(x.regulator, json.string),
                              ),
                              #(
                                "jurisdiction",
                                json.nullable(x.jurisdiction, json.string),
                              ),
                              #(
                                "policyVersion",
                                json.nullable(
                                  x.policy_version_id,
                                  id.policy_json,
                                ),
                              ),
                            ])
                          },
                        ),
                      ),
                    ],
                  )
                False, False -> {
                  use <- guard_rev(
                    raw,
                    rev.Rev(r.rev, r.rev_at, r.rev_by_name),
                    "REVIEW_VERSION_CONFLICT",
                    [
                      #(
                        "current",
                        json.object([
                          #("status", review_status.to_json(r.status)),
                        ]),
                      ),
                    ],
                  )
                  decide(
                    ctx,
                    reviewer,
                    rv,
                    b.outcome,
                    reason_code,
                    reason,
                    refs,
                    option.map(key, fn(k) { #(k, fp) }),
                    binding_decided,
                  )
                }
              }
          }
      }
    }
  }
}

fn context_state(
  read: Read,
  r: review_row.Row,
) -> Result(
  #(
    Option(context_outcome.ContextOutcome),
    Option(declared_representation_status.DeclaredRepresentationStatus),
  ),
  Fail(e),
) {
  case r.subject_context_id {
    None -> Ok(#(None, None))
    Some(cid) -> {
      use c <- result.try(compliance_store.by_id(
        read,
        id.compliance_context(cid),
      ))
      case c {
        None -> Ok(#(None, None))
        Some(c) -> {
          use last <- result.map(store.one(
            read,
            "SELECT outcome FROM compliance_evaluations WHERE context_id = ? ORDER BY position DESC LIMIT 1",
            [id.compliance_context_sql(c.row.id)],
            decode.at([0], context_outcome.decoder()),
          ))
          let rep =
            list.find(c.representations, fn(x) {
              Some(id.representation_to_string(x.id))
              == r.subject_representation_id
            })
            |> result.map(fn(x) { x.status })
            |> option.from_result
          #(option.from_result(last), rep)
        }
      }
    }
  }
}

/// The state a decision is taken from, or leaves, by the kind of thing the review is about.
type Effect {
  Effect(
    facet: Option(facet_state.FacetState),
    agreement: Option(agreement_status.AgreementStatus),
    context: Option(context_outcome.ContextOutcome),
    representation: Option(
      declared_representation_status.DeclaredRepresentationStatus,
    ),
    note: Option(review_row.ResultNote),
  )
}

const no_effect = Effect(None, None, None, None, None)

fn subject_ma(r: review_row.Row) -> Option(jurisdiction.Jurisdiction) {
  option.then(r.subject_member_association, fn(m) {
    jurisdiction.from_string(m) |> option.from_result
  })
}

/// `reviewEffectState`.
fn effect_state(
  read: Read,
  r: review_row.Row,
  now: Int,
) -> Result(Effect, Fail(e)) {
  case r.kind {
    review_row.VerificationFacet ->
      case r.subject_profile_id, r.subject_facet {
        Some(pid), Some(facet) -> {
          use p <- result.map(agent_store.profile_by_id(read, pid))
          let rec =
            option.then(p, agent_rules.facet_of(_, facet, subject_ma(r)))
          Effect(
            ..no_effect,
            facet: option.map(rec, fn(f) {
              agent_rules.effective_facet_state(Some(f), now)
            }),
          )
        }
        _, _ -> Ok(no_effect)
      }
    review_row.RepresentationDispute ->
      case r.subject_agreement_id {
        Some(aid) -> {
          use a <- result.map(agent_store.agreement_by_id(read, aid))
          Effect(
            ..no_effect,
            agreement: option.map(a, fn(a) {
              agent_rules.effective_status(a.row, now)
            }),
          )
        }
        None -> Ok(no_effect)
      }
    _ -> {
      use #(context, rep) <- result.map(context_state(read, r))
      Effect(..no_effect, context:, representation: rep)
    }
  }
}

fn reviewer_actor(reviewer: reviewer_row.Row) -> agent_store.Actor {
  agent_store.Actor(
    kind: agent_actor_kind.TsReviewer,
    id: Some(id.reviewer_to_string(reviewer.id)),
    name: Some(reviewer.name),
  )
}

/// A facet review: VERIFIED under attributed review against the cited evidence, or not verified.
fn apply_facet(
  tx: Tx,
  reviewer: reviewer_row.Row,
  r: review_row.Row,
  approved: Bool,
  now: Int,
) -> Result(Effect, Fail(Response)) {
  let read = store.reading(tx)
  case r.subject_profile_id, r.subject_facet {
    Some(pid), Some(facet) -> {
      use p <- result.try(agent_store.profile_by_id(read, pid) |> storage)
      case p {
        None -> Ok(Effect(..no_effect, note: Some(review_row.ProfileGone)))
        Some(p) -> {
          let ma = subject_ma(r)
          let cur = agent_rules.facet_of(p, facet, ma)
          let prev = agent_rules.effective_facet_state(cur, now)
          let base = case cur {
            Some(f) -> f
            None ->
              facet_row.new(
                profile_id: p.row.id,
                facet:,
                member_association: option.unwrap(ma, jurisdiction.INT),
                state: facet_state.Unverified,
              )
          }
          let provenance = fn(f: facet_row.Row) {
            facet_row.Row(
              ..f,
              provenance_provider: Some(facet_row.AttributedReview),
              provenance_kind: Some(facet_row.HumanReview),
              provenance_at: Some(now),
              provenance_reviewer_id: Some(id.reviewer_to_string(reviewer.id)),
              provenance_review_id: Some(r.id),
              stale_notified_at: None,
            )
          }
          let next = case approved {
            True ->
              provenance(
                facet_row.Row(
                  ..base,
                  state: facet_state.Verified,
                  verified_at: Some(now),
                  recheck_at: Some(now + agent_rules.recheck_ms),
                  note: Some(
                    "Verified by attributed Trust & Safety review against the cited evidence. Re-check due in 30 days.",
                  ),
                ),
              )
            False ->
              provenance(
                facet_row.Row(
                  ..base,
                  state: facet_state.Unverified,
                  verified_at: None,
                  recheck_at: None,
                  note: Some(
                    "Attributed Trust & Safety review could not verify this reference.",
                  ),
                ),
              )
          }
          let by = reviewer_actor(reviewer)
          use _ <- result.try(agent_store.set_facet(tx, next) |> storage)
          use _ <- result.try(
            agent_store.bump_profile(
              tx,
              p.row.id,
              agent_store.bump_by(now, by),
              True,
            )
            |> storage,
          )
          use _ <- result.try(
            agent_store.profile_event(
              tx,
              p.row.id,
              now,
              by,
              agent_store.FacetReviewed(facet, ma, prev, next.state, r.id),
            )
            |> storage,
          )
          let org = id.org_to_string(p.row.agency_org_id)
          let user = id.org_user_to_string(p.row.user_id)
          let state = facet_state.to_string(next.state)
          store.emit(
            tx,
            effect.Live(live_event.AgentVerificationStateChanged(
              org,
              user,
              agent_facet.to_string(facet),
              state,
            )),
          )
          store.emit(
            tx,
            effect.Live(live_event.AgentAuthorisationStateChanged(
              org,
              user,
              state,
            )),
          )
          Ok(Effect(..no_effect, facet: Some(next.state)))
        }
      }
    }
    _, _ -> Ok(Effect(..no_effect, note: Some(review_row.ProfileGone)))
  }
}

/// A dispute review: reinstating lifts only the dispute suspension (an expired term stays expired); upholding ends
/// the relationship.
fn apply_dispute(
  tx: Tx,
  reviewer: reviewer_row.Row,
  r: review_row.Row,
  approved: Bool,
  now: Int,
) -> Result(Effect, Fail(Response)) {
  let read = store.reading(tx)
  use found <- result.try(case r.subject_agreement_id {
    Some(aid) -> agent_store.agreement_by_id(read, aid) |> storage
    None -> Ok(None)
  })
  case found {
    Some(a) if a.row.status == agreement_row.Disputed -> {
      let by = reviewer_actor(reviewer)
      let row = a.row
      let set = case approved {
        True ->
          case row.end_at, row.confirmed_at {
            None, Some(confirmed) -> [
              #("status", sqlight.text("active")),
              #(
                "end_at",
                sqlight.int(agent_rules.term_end_at(
                  option.unwrap(row.start_at, confirmed),
                  row.term_months,
                )),
              ),
            ]
            _, _ -> [#("status", sqlight.text("active"))]
          }
        False -> [
          #("status", sqlight.text("terminated_by_client")),
          #("terminated_at", sqlight.int(now)),
          #("terminated_by", sqlight.text("trust_safety")),
          #("termination_reason_code", sqlight.text("dispute_upheld")),
        ]
      }
      let set =
        list.append(set, [
          #("dispute_resolved_at", sqlight.int(now)),
          #("dispute_review_id", id.regulatory_review_sql(r.id)),
          #(
            "dispute_outcome",
            sqlight.text(case approved {
              True -> "reinstated"
              False -> "ended"
            }),
          ),
        ])
      use _ <- result.try(
        store.run(
          tx,
          "UPDATE representation_agreements SET "
            <> string.join(list.map(set, fn(x) { x.0 <> " = ?" }), ", ")
            <> " WHERE id = ? AND status = 'disputed'",
          list.append(list.map(set, fn(x) { x.1 }), [id.agreement_sql(row.id)]),
        )
        |> storage,
      )
      use _ <- result.try(
        agent_store.bump_agreement(tx, row.id, agent_store.bump_by(now, by))
        |> storage,
      )
      use _ <- result.try(
        agent_store.agreement_event(
          tx,
          row.id,
          now,
          by,
          fn(e) {
            agreement_event_row.Row(
              ..e,
              detail_by: Some(terminator.TrustSafety),
              detail_phase: Some(agreement_status.Disputed),
              detail_review_id: Some(r.id),
              detail_reason_code: Some(case approved {
                True -> "dispute_reinstated"
                False -> "dispute_upheld"
              }),
            )
          },
          case approved {
            True -> agreement_event_row.RepresentationConfirmed
            False -> agreement_event_row.RepresentationTerminated
          },
        )
        |> storage,
      )
      store.emit(
        tx,
        effect.Live(live_event.Representation(
          change: case approved {
            True -> live_event.RepresentationConfirmed
            False -> live_event.RepresentationTerminated
          },
          org_id: id.org_to_string(row.agency_org_id),
          agreement_id: id.agreement_to_string(row.id),
          agent_user_id: id.org_user_to_string(row.agent_user_id),
        )),
      )
      use _ <- result.try(
        notifications.notify(
          tx,
          to: audience.Player,
          id: row.client_id,
          type_: "representation_disputed",
          text: case approved {
            True ->
              "Attributed Trust & Safety review resolved your dispute: the relationship record is reinstated. You can still end it at any time."
            False ->
              "Attributed Trust & Safety review resolved your dispute: the relationship record has been ended."
          },
          ref_id: Some(id.agreement_to_string(row.id)),
          at: now,
        )
        |> storage,
      )
      use _ <- result.try(
        notifications.notify(
          tx,
          to: audience.OrgUser,
          id: id.org_user_to_string(row.agent_user_id),
          type_: "representation_disputed",
          text: case approved {
            True ->
              "A disputed relationship was reinstated by attributed review."
            False -> "A disputed relationship was ended by attributed review."
          },
          ref_id: Some(id.agreement_to_string(row.id)),
          at: now,
        )
        |> storage,
      )
      use after <- result.map(
        agent_store.agreement_by_id(read, row.id) |> storage,
      )
      Effect(
        ..no_effect,
        agreement: option.map(after, fn(a) {
          agent_rules.effective_status(a.row, now)
        }),
      )
    }
    other ->
      Ok(
        Effect(
          ..no_effect,
          agreement: option.map(other, fn(a) {
            agent_rules.effective_status(a.row, now)
          }),
          note: Some(review_row.NotDisputedAnyMore),
        ),
      )
  }
}

/// A conflict or declaration review: the context records the decision, is evaluated again when open, and moves.
fn apply_context(
  tx: Tx,
  reviewer: reviewer_row.Row,
  r: review_row.Row,
  approved: Bool,
  binding_decided: BindingDecided,
  now: Int,
) -> Result(Effect, Fail(Response)) {
  let read = store.reading(tx)
  let by = by_reviewer(reviewer)
  case r.subject_context_id {
    None -> Ok(Effect(..no_effect, note: Some(review_row.ContextGone)))
    Some(cid) -> {
      let context_id = id.compliance_context(cid)
      use c <- result.try(compliance_store.by_id(read, context_id) |> storage)
      case c {
        None -> Ok(Effect(..no_effect, note: Some(review_row.ContextGone)))
        Some(_) -> {
          use _ <- result.try(case r.kind {
            review_row.RepresentationDeclared -> {
              // For a transaction, its representation row is the truth and the context only projects it.
              use _ <- result.try(
                case r.subject_transaction_id, r.subject_representation_id {
                  Some(t), Some(rep) ->
                    binding_decided(tx, t, rep, approved, by, r.id, now)
                  _, _ -> Ok(Nil)
                },
              )
              use live <- result.try(
                compliance_store.by_id(read, context_id) |> storage,
              )
              let pending =
                option.then(live, fn(c) {
                  list.find(c.representations, fn(x) {
                    Some(id.representation_to_string(x.id))
                    == r.subject_representation_id
                    && x.status == declared_representation_status.PendingReview
                  })
                  |> option.from_result
                })
              case pending {
                None -> Ok(Nil)
                Some(rep) -> {
                  use _ <- result.try(
                    case approved {
                      True ->
                        store.run(
                          tx,
                          "UPDATE compliance_context_representations SET status = 'verified', declared_only = 0, verified_by_review_id = ?, verified_at = ? WHERE context_id = ? AND id = ? AND status = 'pending_review'",
                          [
                            id.regulatory_review_sql(r.id),
                            sqlight.int(now),
                            id.compliance_context_sql(context_id),
                            id.representation_sql(rep.id),
                          ],
                        )
                      False ->
                        store.run(
                          tx,
                          "UPDATE compliance_context_representations SET status = 'withdrawn', withdrawn_at = ? WHERE context_id = ? AND id = ? AND status = 'pending_review'",
                          [
                            sqlight.int(now),
                            id.compliance_context_sql(context_id),
                            id.representation_sql(rep.id),
                          ],
                        )
                    }
                    |> storage,
                  )
                  compliance_store.event(
                    tx,
                    context_id,
                    case approved {
                      True -> context_event_row.ComplianceRepresentationVerified
                      False ->
                        context_event_row.ComplianceRepresentationWithdrawn
                    },
                    by,
                    now,
                    compliance_store.Detail(
                      ..compliance_store.no_detail,
                      party_role: Some(rep.party_role),
                      review_id: Some(r.id),
                    ),
                  )
                  |> storage
                }
              }
            }
            review_row.ConflictEvaluation -> {
              use _ <- result.try(case approved {
                True -> {
                  let codes =
                    list.filter(
                      list.map(r_reasons(read, r) |> result.unwrap([]), fn(x) {
                        x.code
                      }),
                      list.contains(
                        [
                          "OTHER_SERVICES_PRESUMPTION", "INTEREST_DECLARED",
                          "REPRESENTATION_UNVERIFIED",
                        ],
                        _,
                      ),
                    )
                  list.try_each(codes, fn(code) {
                    store.run(
                      tx,
                      "INSERT INTO compliance_context_resolved_facts (context_id, ord, code) SELECT ?, (SELECT COALESCE(MAX(ord) + 1, 0) FROM compliance_context_resolved_facts WHERE context_id = ?), ? WHERE NOT EXISTS (SELECT 1 FROM compliance_context_resolved_facts WHERE context_id = ? AND code = ?)",
                      [
                        id.compliance_context_sql(context_id),
                        id.compliance_context_sql(context_id),
                        sqlight.text(code),
                        id.compliance_context_sql(context_id),
                        sqlight.text(code),
                      ],
                    )
                  })
                  |> storage
                }
                False ->
                  store.run(
                    tx,
                    "UPDATE compliance_contexts SET review_rejected_at = ? WHERE id = ?",
                    [sqlight.int(now), id.compliance_context_sql(context_id)],
                  )
                  |> storage
              })
              compliance_store.event(
                tx,
                context_id,
                context_event_row.ComplianceContextEvaluated,
                by,
                now,
                compliance_store.Detail(
                  ..compliance_store.no_detail,
                  review_id: Some(r.id),
                  review_outcome: Some(case approved {
                    True -> context_event_row.ReviewApproved
                    False -> context_event_row.ReviewRejected
                  }),
                ),
              )
              |> storage
            }
            _ -> Ok(Nil)
          })
          use c <- result.try(
            compliance_store.by_id(read, context_id) |> storage,
          )
          let assert Some(c) = c
          use _ <- result.try(case c.row.status {
            context_row.Open -> evaluate_context(tx, c, by, now)
            context_row.Closed -> Ok(Nil)
          })
          use _ <- result.try(
            store.run(
              tx,
              "UPDATE compliance_contexts SET rev = rev + 1, rev_at = ?, rev_by_id = ?, rev_by_name = ? WHERE id = ?",
              [
                sqlight.int(now),
                sqlight.text(id.reviewer_to_string(reviewer.id)),
                sqlight.text(reviewer.name),
                id.compliance_context_sql(context_id),
              ],
            )
            |> storage,
          )
          use #(context, rep) <- result.map(context_state(read, r) |> storage)
          Effect(..no_effect, context:, representation: rep)
        }
      }
    }
  }
}

fn r_reasons(
  read: Read,
  r: review_row.Row,
) -> Result(List(review_reason_row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> review_reason_row.columns
      <> " FROM regulatory_review_reasons WHERE review_id = ? ORDER BY ord",
    [id.regulatory_review_sql(r.id)],
    review_reason_row.decoder(),
  )
}

/// `applyReviewDecision` and the decision it records, in one unit.
fn decide(
  ctx: Ctx,
  reviewer: reviewer_row.Row,
  rv: Review,
  outcome: review_row.DecisionOutcome,
  reason_code: String,
  reason: String,
  refs: List(String),
  key: Option(#(String, String)),
  binding_decided: BindingDecided,
) -> Response {
  let r = rv.row
  let now = clock.now_ms()
  let approved = outcome == review_row.Approved
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use current <- result.try(reviews.by_id(read, r.id) |> storage)
    case option.map(current, fn(c) { c.row.rev }) == Some(r.rev) {
      False -> store.stale("the review moved")
      True -> {
        use prior <- result.try(effect_state(read, r, now) |> storage)
        use after <- result.try(case r.kind {
          review_row.VerificationFacet ->
            apply_facet(tx, reviewer, r, approved, now)
          review_row.RepresentationDispute ->
            apply_dispute(tx, reviewer, r, approved, now)
          _ -> apply_context(tx, reviewer, r, approved, binding_decided, now)
        })
        let decision =
          reviews.Decision(
            reviewer_id: id.reviewer_to_string(reviewer.id),
            reviewer_name: reviewer.name,
            reviewer_role: reviewer.role,
            outcome:,
            reason_code:,
            reason:,
            evidence_refs: refs,
            prior_status: r.status,
            prior_facet_state: prior.facet,
            prior_agreement_status: prior.agreement,
            prior_context_outcome: prior.context,
            prior_representation_status: prior.representation,
            result_facet_state: after.facet,
            result_agreement_status: after.agreement,
            result_context_outcome: after.context,
            result_representation_status: after.representation,
            result_note: after.note,
            at: now,
          )
        use _ <- result.try(reviews.resolve(tx, rv, decision, key) |> storage)
        store.emit(
          tx,
          effect.Live(live_event.RegulatoryReviewResolved(
            org_id: id.org_to_string(r.agency_org_id),
            review_id: id.regulatory_review_to_string(r.id),
            outcome: review_row.decision_outcome_to_string(outcome),
          )),
        )
        use _ <- result.try(case r.agent_user_id {
          Some(agent) ->
            notifications.notify(
              tx,
              to: audience.OrgUser,
              id: id.org_user_to_string(agent),
              type_: "regulatory_review_completed",
              text: "Attributed Trust & Safety review "
                <> case approved {
                True -> "approved"
                False -> "did not approve"
              }
                <> " a "
                <> string.replace(review_row.kind_to_string(r.kind), "_", " ")
                <> " item under ScoutBox policy. This is a platform decision, not a legal determination.",
              ref_id: Some(id.regulatory_review_to_string(r.id)),
              at: now,
            )
            |> storage
          None -> Ok(Nil)
        })
        use stored <- result.try(reviews.by_id(read, r.id) |> storage)
        let assert Some(stored) = stored
        use view <- result.map(reviewer_view(read, stored) |> storage)
        http.json(200, json.object([#("review", view)]))
      }
    }
  })
  |> answer_unit
}

/// `evaluateAndRecord`: the context's own evaluation, from its projection and its consents.
pub fn evaluate_context(
  tx: Tx,
  c: compliance_store.Context,
  by: By,
  now: Int,
) -> Result(Nil, Fail(Response)) {
  let read = store.reading(tx)
  use policies <- result.try(approach_policy.published(read) |> storage)
  use consents <- result.try(
    consent_store.engine_consents(read, c.row.id) |> storage,
  )
  use input <- result.try(
    compliance_store.engine_input(read, c, policies, now, None, consents)
    |> storage,
  )
  compliance_store.record_evaluation(
    tx,
    c,
    conflict.evaluate(input),
    None,
    by,
    now,
  )
  |> storage
  |> result.replace(Nil)
}

// ------------------------------------------------------------------------------------------------- consents

fn particulars_json(r: consent_row.Row) -> Json {
  json.object([
    #("fullParticularsProvided", json.bool(r.full_particulars_provided)),
    #("legalAdviceOffered", json.bool(r.legal_advice_offered)),
    #("proposedFeeDisclosed", json.bool(r.proposed_fee_disclosed)),
    #("acknowledged", case r.acknowledged_at {
      Some(at) ->
        json.object([
          #("particulars", json.bool(True)),
          #("legalAdvice", json.bool(True)),
          #("at", json.int(at)),
        ])
      None -> json.null()
    }),
  ])
}

fn consent_rev(r: consent_row.Row) -> List(#(String, Json)) {
  rev.meta(rev.Rev(r.rev, r.rev_at, r.rev_by_name))
}

/// The agent's view of a consent it asked for.
pub fn consent_for_agent(k: Consent) -> Json {
  let r = k.row
  json.object([
    #("id", id.consent_json(r.id)),
    #("kind", consent_row.kind_to_json(r.kind)),
    #("status", json.string(consent_store.status(k))),
    #("contextId", id.compliance_context_json(r.context_id)),
    #("partyRole", party_role.to_json(r.party_role)),
    #("subjectKind", subject_kind.to_json(r.subject_kind)),
    #("requestedAt", json.int(r.requested_at)),
    #("grantedAt", json.nullable(r.granted_at, json.int)),
    #("declinedAt", json.nullable(r.declined_at, json.int)),
    #("revokedAt", json.nullable(consent_store.revoked_at(k), json.int)),
    #("policyVersions", json.array(k.policy_versions, id.policy_json)),
    #("ruleIds", json.array(k.rule_ids, json.string)),
    #("particulars", particulars_json(r)),
    ..consent_rev(r)
  ])
}

/// The asked party's view: who asks, in what context, and what they were told.
fn consent_for_party(
  read: Read,
  k: Consent,
  now: Int,
) -> Result(Json, Fail(e)) {
  let r = k.row
  use c <- result.try(compliance_store.by_id(read, r.context_id))
  use profile <- result.try(agent_store.profile_for_user(read, r.agent_user_id))
  use agency <- result.try(orgs.by_id(read, r.agency_org_id))
  use parties <- result.map(case c {
    None -> Ok(None)
    Some(c) ->
      c.parties
      |> list.filter(fn(p) { !p.removed })
      |> list.try_map(fn(p) {
        use name <- result.map(case p.subject_kind {
          subject_kind.Club ->
            orgs.by_id(read, id.org(p.subject_id))
            |> result.map(option.map(_, fn(o) { o.name }))
          subject_kind.Player ->
            Ok(case p.subject_id == r.subject_id {
              True -> Some("You")
              False -> None
            })
        })
        json.object([
          #("partyRole", party_role.to_json(p.party_role)),
          #("subjectKind", subject_kind.to_json(p.subject_kind)),
          #("name", json.nullable(name, json.string)),
        ])
      })
      |> result.map(fn(ps) { Some(#(c, ps)) })
  })
  json.object([
    #("id", id.consent_json(r.id)),
    #("kind", consent_row.kind_to_json(r.kind)),
    #("status", json.string(consent_store.status(k))),
    #("partyRole", party_role.to_json(r.party_role)),
    #(
      "agent",
      json.object([
        #("userId", id.org_user_json(r.agent_user_id)),
        #(
          "displayName",
          json.nullable(
            option.map(profile, fn(p) { p.row.display_name }),
            json.string,
          ),
        ),
        #(
          "agency",
          json.nullable(option.map(agency, fn(o) { o.name }), json.string),
        ),
        #("licence", case profile {
          Some(p) ->
            facet_state.to_json(agent_rules.effective_facet_state(
              agent_rules.facet_of(p, agent_facet.FifaLicence, None),
              now,
            ))
          None -> json.string("UNVERIFIED")
        }),
      ]),
    ),
    #("context", case parties {
      Some(#(c, ps)) ->
        json.object([
          #("id", id.compliance_context_json(c.row.id)),
          #("type", context_type.to_json(c.row.type_)),
          #("jurisdictions", json.array(c.jurisdictions, json.string)),
          #("parties", json.preprocessed_array(ps)),
        ])
      None -> json.null()
    }),
    #("otherPartyRoles", json.array(k.regarding, party_role.to_json)),
    #("particulars", particulars_json(r)),
    #("policyVersions", json.array(k.policy_versions, id.policy_json)),
    #("ruleIds", json.array(k.rule_ids, json.string)),
    #("requestedAt", json.int(r.requested_at)),
    #("grantedAt", json.nullable(r.granted_at, json.int)),
    #("declinedAt", json.nullable(r.declined_at, json.int)),
    #("revokedAt", json.nullable(consent_store.revoked_at(k), json.int)),
    ..list.append(consent_rev(r), [
      #(
        "honest",
        json.string(
          "You may decline. Consent is specific to this agent, this transaction context and these parties; it can be revoked at any time, and a revocation stops any future regulated action that needs it. ScoutBox records your answer; it does not advise you.",
        ),
      ),
    ])
  ])
}

pub fn public_reason(r: approach_policy.Reason) -> Json {
  json.object([
    #("code", json.string(r.code)),
    #("ruleId", json.nullable(r.rule_id, json.string)),
    #("ruleStatus", rule_status.to_json(r.rule_status)),
    #("regulator", json.nullable(r.regulator, json.string)),
    #("jurisdiction", json.nullable(r.jurisdiction, jurisdiction.to_json)),
    #("policyVersion", json.nullable(r.policy_version, id.policy_json)),
  ])
}

type ConsentRequest {
  ConsentRequest(
    party_role: PartyRole,
    full_particulars: Bool,
    legal_advice: Bool,
    fee_disclosed: Bool,
    client_key: Option(String),
  )
}

fn flag(name: String, next: fn(Bool) -> input.Shape(a)) -> input.Shape(a) {
  use v <- input.field(name, input.optional(input.boolean()))
  next(v == Some(True))
}

/// A party's prior written consent to multiple representation, asked by the agent. The transaction workspace asks
/// through this, with the context projected from the transaction first.
pub fn request_consent(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  c: compliance_store.Context,
) -> Response {
  case c.row.status {
    context_row.Closed -> bare("CONTEXT_CLOSED", [])
    context_row.Open -> {
      let shape = {
        use role <- input.field(
          "partyRole",
          input.required(input.one_of(party_role.pairs)),
        )
        use full <- flag("fullParticularsProvided")
        use advice <- flag("legalAdviceOffered")
        use fee <- flag("proposedFeeDisclosed")
        use client_key <- input.field(
          "clientKey",
          input.nullish(input.text(1_000_000)),
        )
        input.done(ConsentRequest(role, full, advice, fee, client_key))
      }
      use b, _ <- body(req, shape, "COMPLIANCE_INPUT_INVALID")
      use key <- client_key(b.client_key)
      case
        list.find(c.parties, fn(p) {
          p.party_role == b.party_role && !p.removed
        })
      {
        Error(Nil) -> bare("PARTY_NOT_FOUND", [])
        Ok(party) -> {
          let fp =
            fingerprint([
              #("partyRole", canonical.Str(party_role.to_string(b.party_role))),
            ])
          use hit <- reading(ctx, fn(r) {
            case key {
              Some(k) -> consent_store.by_request_key(r, c.row.id, a.user.id, k)
              None -> Ok(None)
            }
          })
          case hit {
            Some(k) ->
              case k.row.request_fp == Some(fp) {
                True ->
                  http.json(
                    200,
                    json.object([
                      #("consent", consent_for_agent(k)),
                      #("idempotent", json.bool(True)),
                    ]),
                  )
                False -> bare("CONSENT_IDEMPOTENCY_CONFLICT", [])
              }
            None -> {
              use <- limited(
                ctx,
                req,
                limits.ComplianceConsentRequest,
                id.org_user_to_string(a.user.id),
              )
              request_checked(ctx, a, c, party, b, key, fp)
            }
          }
        }
      }
    }
  }
}

/// The refusal a facet gate problem answers (shared.mjs `facetGate`).
pub fn gate_refusal(problem: compliance_store.GateProblem) -> Response {
  case problem {
    compliance_store.NoProfile ->
      err("AGENT_VERIFICATION_REQUIRED", "Create your agent profile first.", [])
    compliance_store.FacetMissing(g) ->
      err(
        g.code,
        "A regulated action needs a VERIFIED "
          <> agent_facet.to_string(g.facet)
          <> case g.member_association {
          Some(ma) -> " (" <> jurisdiction.to_string(ma) <> ")"
          None -> ""
        }
          <> "; it is "
          <> facet_state.to_string(g.state)
          <> ".",
        [
          #("facet", agent_facet.to_json(g.facet)),
          #(
            "memberAssociation",
            json.nullable(g.member_association, jurisdiction.to_json),
          ),
          #("state", facet_state.to_json(g.state)),
        ],
      )
    compliance_store.Unsupported(reasons:, policy_versions:) ->
      err(
        "JURISDICTION_UNSUPPORTED",
        "No encoded policy covers this jurisdiction. The workflow cannot proceed without attributed review under an encoded policy version.",
        [
          #("reasons", json.array(reasons, public_reason)),
          #("policyVersions", json.array(policy_versions, id.policy_json)),
        ],
      )
  }
}

fn request_checked(
  ctx: Ctx,
  a: OrgAccess,
  c: compliance_store.Context,
  party: context_party_row.Row,
  b: ConsentRequest,
  key: Option(String),
  fp: String,
) -> Response {
  let now = clock.now_ms()
  use #(profile, gate, policies) <- reading(ctx, fn(r) {
    use profile <- result.try(agent_store.profile_for_user(r, a.user.id))
    use gate <- result.try(compliance_store.facet_gate(
      r,
      a.user.id,
      c.jurisdictions,
      now,
    ))
    use policies <- result.map(approach_policy.published(r))
    #(profile, gate, policies)
  })
  case profile, gate {
    None, _ ->
      err("AGENT_VERIFICATION_REQUIRED", "Create your agent profile first.", [])
    _, Some(compliance_store.FacetMissing(g)) ->
      err(
        g.code,
        "A regulated action needs a VERIFIED "
          <> agent_facet.to_string(g.facet)
          <> case g.member_association {
          Some(ma) -> " (" <> jurisdiction.to_string(ma) <> ")"
          None -> ""
        }
          <> "; it is "
          <> facet_state.to_string(g.state)
          <> ".",
        [
          #("facet", agent_facet.to_json(g.facet)),
          #(
            "memberAssociation",
            json.nullable(g.member_association, jurisdiction.to_json),
          ),
          #("state", facet_state.to_json(g.state)),
        ],
      )
    _, Some(compliance_store.Unsupported(reasons:, policy_versions:)) ->
      err(
        "JURISDICTION_UNSUPPORTED",
        "No encoded policy covers this jurisdiction. The workflow cannot proceed without attributed review under an encoded policy version.",
        [
          #("reasons", json.array(reasons, public_reason)),
          #("policyVersions", json.array(policy_versions, id.policy_json)),
        ],
      )
    _, Some(compliance_store.NoProfile) ->
      err("AGENT_VERIFICATION_REQUIRED", "Create your agent profile first.", [])
    Some(p), None -> {
      // Consent exists only where an active encoded rule makes it the permitted route.
      let set = approach_policy.applicable(policies, c.jurisdictions, now)
      let versions = list.map(set.policies, approach_policy.policy_id)
      let national = case conflict.resolve_scope(c.jurisdictions) {
        conflict.National(ma) ->
          list.find(set.policies, fn(x) {
            jurisdiction.to_string(x.row.jurisdiction) == ma
          })
          |> option.from_result
        _ -> None
      }
      let rule_id = case national {
        Some(np) ->
          list.find(np.rules, fn(rule) {
            list.key_find(rule.texts, "consentKind")
            == Ok("dual_representation")
          })
          |> result.map(fn(rule) { rule.id })
          |> option.from_result
        None -> Some("FIFA-12.8")
      }
      let found =
        option.then(rule_id, fn(rid) {
          approach_policy.find_rule(set.policies, rid) |> option.from_result
        })
      let status = case found {
        Some(#(rule, _)) -> approach_policy.status_at(rule, now)
        None -> rule_status.Unknown
      }
      case status {
        rule_status.Active ->
          request_in_unit(
            ctx,
            a,
            p,
            c,
            party,
            b,
            key,
            fp,
            versions,
            rule_id,
            now,
          )
        _ ->
          err(
            "REGULATORY_REVIEW_REQUIRED",
            "Consent can only be requested under an ACTIVE encoded rule. The deciding rule's status is uncertain or not encoded; consent would not cure that.",
            [
              #(
                "reasons",
                json.array(
                  [
                    json.object([
                      #(
                        "code",
                        json.string(case status {
                          rule_status.Unknown -> "POLICY_NOT_ENCODED"
                          _ -> "RULE_STATUS_UNCERTAIN"
                        }),
                      ),
                      #("ruleId", json.nullable(rule_id, json.string)),
                      #("ruleStatus", rule_status.to_json(status)),
                      #("regulator", json.null()),
                      #("jurisdiction", json.null()),
                      #(
                        "policyVersion",
                        json.nullable(
                          option.map(found, fn(f) {
                            approach_policy.policy_id({ f.1 })
                          }),
                          id.policy_json,
                        ),
                      ),
                    ]),
                  ],
                  fn(x) { x },
                ),
              ),
              #("policyVersions", json.array(versions, id.policy_json)),
            ],
          )
      }
    }
  }
}

fn request_in_unit(
  ctx: Ctx,
  a: OrgAccess,
  profile: agent_rules.Profile,
  c: compliance_store.Context,
  party: context_party_row.Row,
  b: ConsentRequest,
  key: Option(String),
  fp: String,
  versions: List(id.PolicyId),
  rule_id: Option(String),
  now: Int,
) -> Response {
  use existing <- reading(ctx, consent_store.for_context(_, c.row.id))
  case
    list.find(existing, fn(k) {
      k.row.kind == consent_row.DualRepresentation
      && k.row.agent_user_id == a.user.id
      && k.row.party_role == b.party_role
      && {
        consent_store.status(k) == "requested"
        || consent_store.status(k) == "granted"
      }
    })
  {
    Ok(k) ->
      bare("CONSENT_ALREADY_REQUESTED", [
        #("status", json.string(consent_store.status(k))),
      ])
    Error(Nil) -> {
      let by =
        compliance_store.By(
          kind: compliance_actor_kind.Org,
          id: Some(id.org_user_to_string(a.user.id)),
          name: Some(a.user.name),
          role: None,
          org_id: None,
        )
      store.unit(ctx.store, fn(tx) {
        use consent_id <- result.try(id.next_consent(tx) |> storage)
        let row =
          consent_row.Row(
            ..consent_row.new(
              id: consent_id,
              kind: consent_row.DualRepresentation,
              context_id: c.row.id,
              agent_user_id: a.user.id,
              agency_org_id: c.row.agency_org_id,
              party_role: b.party_role,
              subject_kind: party.subject_kind,
              subject_id: party.subject_id,
              status: consent_row.Requested,
              requested_at: now,
              requested_by_kind: compliance_actor_kind.Org,
              full_particulars_provided: b.full_particulars,
              legal_advice_offered: b.legal_advice,
              proposed_fee_disclosed: b.fee_disclosed,
              rev: 1,
            ),
            requested_by_id: by.id,
            requested_by_name: by.name,
            request_key: key,
            request_fp: option.map(key, fn(_) { fp }),
            rev_at: Some(now),
          )
        let regarding =
          c.parties
          |> list.filter(fn(x) { !x.removed && x.party_role != b.party_role })
          |> list.map(fn(x) { x.party_role })
        use _ <- result.try(
          consent_store.create(
            tx,
            row,
            regarding,
            versions,
            option.values([rule_id]),
            by,
          )
          |> storage,
        )
        store.emit(
          tx,
          effect.Live(live_event.RegulatoryConsentChanged(
            change: live_event.ConsentRequested,
            org_id: id.org_to_string(c.row.agency_org_id),
            consent_id: id.consent_to_string(consent_id),
            ctx_id: id.compliance_context_to_string(c.row.id),
          )),
        )
        let agent_name = profile.row.display_name
        let what = string.replace(context_type.to_string(c.row.type_), "_", " ")
        let ref = Some(id.consent_to_string(consent_id))
        use _ <- result.try(
          case party.subject_kind {
            subject_kind.Player ->
              notifications.notify(
                tx,
                to: audience.Player,
                id: party.subject_id,
                type_: "regulatory_consent_requested",
                text: agent_name
                  <> " ("
                  <> a.org.name
                  <> ") asks your written consent to also act for another party in a "
                  <> what
                  <> " involving you. You may decline. Nothing changes until you answer.",
                ref_id: ref,
                at: now,
              )
            subject_kind.Club -> {
              use admins <- result.try(records.active_admins_of(
                store.reading(tx),
                id.org(party.subject_id),
              ))
              list.try_each(admins, fn(admin) {
                notifications.notify(
                  tx,
                  to: audience.OrgUser,
                  id: id.org_user_to_string(admin.user_id),
                  type_: "regulatory_consent_requested",
                  text: agent_name
                    <> " ("
                    <> a.org.name
                    <> ") asks your club's written consent to act for more than one party in a "
                    <> what
                    <> ". Only a recorded signatory may answer.",
                  ref_id: ref,
                  at: now,
                )
              })
            }
          }
          |> storage,
        )
        use stored <- result.map(
          consent_store.by_id(store.reading(tx), consent_id) |> storage,
        )
        let assert Some(stored) = stored
        http.json(201, json.object([#("consent", consent_for_agent(stored))]))
      })
      |> answer_unit
    }
  }
}

/// Which answer a party gives.
pub type Action {
  GrantIt
  DeclineIt
  RevokeIt
}

fn action_name(a: Action) -> String {
  case a {
    GrantIt -> "grant"
    DeclineIt -> "decline"
    RevokeIt -> "revoke"
  }
}

/// Who may answer: the party itself; for a club, only its recorded signatory. An error is the refusal.
type Authority {
  Authority(by: By, signatory: Bool, rate_key: String)
}

fn consent_answer(
  ctx: Ctx,
  req: Request,
  consent_id: String,
  action: Action,
  who: fn(Consent) -> Result(Authority, Response),
) -> Response {
  use found <- reading(ctx, consent_store.by_id(_, id.consent(consent_id)))
  case found {
    None -> bare("CONSENT_NOT_FOUND", [])
    Some(k) ->
      case who(k) {
        Error(response) -> response
        Ok(authority) -> {
          use <- limited(
            ctx,
            req,
            limits.ComplianceConsentResponse,
            authority.rate_key,
          )
          let shape = {
            use ack_particulars <- flag("acknowledgedParticulars")
            use ack_advice <- flag("acknowledgedLegalAdvice")
            use client_key <- input.field(
              "clientKey",
              input.nullish(input.text(1_000_000)),
            )
            use <- rev.fields
            input.done(#(ack_particulars, ack_advice, client_key))
          }
          let shape = case action {
            GrantIt -> shape
            _ -> {
              use client_key <- input.field(
                "clientKey",
                input.nullish(input.text(1_000_000)),
              )
              use <- rev.fields
              input.done(#(False, False, client_key))
            }
          }
          use b, raw <- body(req, shape, "CONSENT_INPUT_INVALID")
          use key <- client_key(b.2)
          let fp =
            fingerprint([#("action", canonical.Str(action_name(action)))])
          let r = k.row
          let slot = case action {
            GrantIt -> #(r.grant_key, r.grant_fp)
            DeclineIt -> #(r.decline_key, r.decline_fp)
            RevokeIt -> #(r.revoke_key, r.revoke_fp)
          }
          let now = clock.now_ms()
          case key, slot {
            Some(kk), #(Some(stored), stored_fp) if kk == stored ->
              case stored_fp == Some(fp) {
                True -> {
                  use view <- reading(ctx, consent_for_party(_, k, now))
                  http.json(
                    200,
                    json.object([
                      #("consent", view),
                      #("idempotent", json.bool(True)),
                    ]),
                  )
                }
                False -> bare("CONSENT_IDEMPOTENCY_CONFLICT", [])
              }
            _, _ -> {
              let st = consent_store.status(k)
              let current = rev.Rev(r.rev, r.rev_at, r.rev_by_name)
              let conflict_fields = [
                #("current", json.object([#("status", json.string(st))])),
              ]
              let keyed = option.map(key, fn(kk) { #(kk, fp) })
              case action, st {
                RevokeIt, "granted" -> {
                  use <- guard_rev(
                    raw,
                    current,
                    "CONSENT_VERSION_CONFLICT",
                    conflict_fields,
                  )
                  answer_in_unit(ctx, k, action, authority, keyed, now)
                }
                RevokeIt, _ ->
                  err(
                    "CONSENT_NOT_PENDING",
                    "Only a granted consent can be revoked.",
                    [
                      #("status", json.string(st)),
                    ],
                  )
                _, "requested" -> {
                  use <- guard_rev(
                    raw,
                    current,
                    "CONSENT_VERSION_CONFLICT",
                    conflict_fields,
                  )
                  case action, b.0, b.1 {
                    GrantIt, False, _ | GrantIt, _, False ->
                      err(
                        "CONSENT_INPUT_INVALID",
                        "To grant, confirm you received the full particulars and were told you may take independent legal advice.",
                        [
                          #(
                            "field",
                            json.string(case b.0 {
                              False -> "acknowledgedParticulars"
                              True -> "acknowledgedLegalAdvice"
                            }),
                          ),
                        ],
                      )
                    _, _, _ ->
                      answer_in_unit(ctx, k, action, authority, keyed, now)
                  }
                }
                _, _ ->
                  bare("CONSENT_NOT_PENDING", [#("status", json.string(st))])
              }
            }
          }
        }
      }
  }
}

fn answer_in_unit(
  ctx: Ctx,
  k: Consent,
  action: Action,
  authority: Authority,
  key: Option(#(String, String)),
  now: Int,
) -> Response {
  let by = authority.by
  let r = k.row
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use current <- result.try(consent_store.by_id(read, r.id) |> storage)
    case option.map(current, fn(c) { c.row.rev }) == Some(r.rev) {
      False -> store.stale("the consent moved")
      True -> {
        use _ <- result.try(
          case action {
            GrantIt ->
              consent_store.answer(
                tx,
                k,
                consent_store.Grant(authority.signatory),
                by,
                key,
                now,
              )
            DeclineIt ->
              consent_store.answer(tx, k, consent_store.Decline, by, key, now)
            RevokeIt -> consent_store.revoke(tx, k, by, key, now)
          }
          |> storage,
        )
        use c <- result.try(
          compliance_store.by_id(read, r.context_id) |> storage,
        )
        use _ <- result.try(case c {
          Some(c) if c.row.status == context_row.Open ->
            evaluate_context(tx, c, by, now)
          _ -> Ok(Nil)
        })
        store.emit(
          tx,
          effect.Live(live_event.RegulatoryConsentChanged(
            change: case action {
              GrantIt -> live_event.ConsentGranted
              DeclineIt -> live_event.ConsentDeclined
              RevokeIt -> live_event.ConsentRevoked
            },
            org_id: id.org_to_string(r.agency_org_id),
            consent_id: id.consent_to_string(r.id),
            ctx_id: id.compliance_context_to_string(r.context_id),
          )),
        )
        use _ <- result.try(
          notifications.notify(
            tx,
            to: audience.OrgUser,
            id: id.org_user_to_string(r.agent_user_id),
            type_: case action {
              GrantIt -> "regulatory_consent_granted"
              DeclineIt -> "regulatory_consent_declined"
              RevokeIt -> "regulatory_consent_revoked"
            },
            text: case action {
              GrantIt ->
                "A party granted written consent to multiple representation for one transaction context. It is specific to that context and can be revoked."
              DeclineIt ->
                "A party declined consent to multiple representation. You may continue to act for your first party only."
              RevokeIt ->
                "A party revoked their consent to multiple representation. Any future regulated action that needs it will be refused; the record of what happened before stays."
            },
            ref_id: Some(id.consent_to_string(r.id)),
            at: now,
          )
          |> storage,
        )
        use stored <- result.try(consent_store.by_id(read, r.id) |> storage)
        let assert Some(stored) = stored
        use view <- result.map(consent_for_party(read, stored, now) |> storage)
        http.json(200, json.object([#("consent", view)]))
      }
    }
  })
  |> answer_unit
}

/// `POST /player/agent/consents/:id/{grant,decline,revoke}`.
pub fn player_answer(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  consent_id: String,
  action: Action,
) -> Response {
  let me = id.player_to_string(p.player.row.id)
  consent_answer(ctx, req, consent_id, action, fn(k) {
    case
      p.minor,
      k.row.subject_kind == subject_kind.Player && k.row.subject_id == me
    {
      True, _ ->
        Error(
          err(
            "COMPLIANCE_ACTION_NOT_PERMITTED",
            "Guardian-managed accounts cannot answer agent consents in ScoutBox.",
            [],
          ),
        )
      False, False -> Error(bare("CONSENT_NOT_FOUND", []))
      False, True ->
        Ok(Authority(
          by: compliance_store.By(
            kind: compliance_actor_kind.Player,
            id: Some(me),
            name: Some(p.player.row.name),
            role: None,
            org_id: None,
          ),
          signatory: False,
          rate_key: me,
        ))
    }
  })
}

fn is_signatory(read: Read, a: OrgAccess) -> Result(Bool, Fail(e)) {
  use admins <- result.map(records.admins_of(read, a.org.id))
  claims.has_ver_level(admins, a.org.id, a.user.id, ver_level.VerificationAdmin)
}

/// `POST /org/compliance/consents/:id/{grant,decline,revoke}`: only the recorded signatory binds the club.
pub fn club_answer(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  consent_id: String,
  action: Action,
) -> Response {
  use signatory <- reading(ctx, is_signatory(_, a))
  let org = id.org_to_string(a.org.id)
  consent_answer(ctx, req, consent_id, action, fn(k) {
    case
      a.org.type_ == org_type.Club
      && k.row.subject_kind == subject_kind.Club
      && k.row.subject_id == org,
      signatory
    {
      False, _ -> Error(bare("CONSENT_NOT_FOUND", []))
      True, False ->
        Error(
          err(
            "SIGNATORY_REQUIRED",
            "Only a recorded club signatory (a verification administrator) may answer for the club.",
            [],
          ),
        )
      True, True ->
        Ok(Authority(
          by: compliance_store.By(
            kind: compliance_actor_kind.ClubUser,
            id: Some(id.org_user_to_string(a.user.id)),
            name: Some(a.user.name),
            role: None,
            org_id: Some(a.org.id),
          ),
          signatory: True,
          rate_key: id.org_user_to_string(a.user.id),
        ))
    }
  })
}

/// `GET /player/agent/consents`.
pub fn player_consents(ctx: Ctx, p: PlayerAccess) -> Response {
  case p.minor {
    True ->
      http.json(
        200,
        json.object([
          #("items", json.array([], json.string)),
          #("minor", json.bool(True)),
          #(
            "note",
            json.string(
              "Agent representation and its consents are not available for under-18 accounts in ScoutBox.",
            ),
          ),
        ]),
      )
    False -> {
      let now = clock.now_ms()
      use items <- reading(ctx, fn(r) {
        use ks <- result.try(consent_store.for_subject(
          r,
          subject_kind.Player,
          id.player_to_string(p.player.row.id),
        ))
        ks
        |> list.filter(fn(k) { k.row.kind == consent_row.DualRepresentation })
        |> list.try_map(consent_for_party(r, _, now))
      })
      http.json(200, json.object([#("items", json.preprocessed_array(items))]))
    }
  }
}

/// `GET /org/compliance/consents`.
pub fn club_consents(ctx: Ctx, a: OrgAccess) -> Response {
  case a.org.type_ {
    org_type.Club -> {
      let now = clock.now_ms()
      use #(items, signatory) <- reading(ctx, fn(r) {
        use ks <- result.try(consent_store.for_subject(
          r,
          subject_kind.Club,
          id.org_to_string(a.org.id),
        ))
        use items <- result.try(
          ks
          |> list.filter(fn(k) { k.row.kind == consent_row.DualRepresentation })
          |> list.try_map(consent_for_party(r, _, now)),
        )
        use s <- result.map(is_signatory(r, a))
        #(items, s)
      })
      http.json(
        200,
        json.object([
          #("items", json.preprocessed_array(items)),
          #("signatory", json.bool(signatory)),
        ]),
      )
    }
    _ -> bare("COMPLIANCE_ACTION_NOT_PERMITTED", [])
  }
}

// ------------------------------------------------------------------------------------------------- audit, metrics

/// One decision entry's detail, as the repository decodes it.
fn decision_detail(
  rv: Review,
  h: review_event_row.Row,
) -> List(#(String, Json)) {
  let r = rv.row
  let pvs = json.array(rv.policy_versions, id.policy_json)
  let rev = #("rev", json.nullable(h.detail_rev, json.int))
  case h.action {
    review_event_row.RegulatoryReviewStarted -> [rev]
    review_event_row.RegulatoryReviewResolved -> [
      #(
        "outcome",
        json.nullable(r.decision_outcome, review_row.decision_outcome_to_json),
      ),
      #("reasonCode", json.nullable(r.decision_reason_code, json.string)),
      #("evidenceRefs", json.array(rv.evidence_refs, json.string)),
      #("policyVersions", pvs),
      #(
        "priorState",
        state_json(
          r,
          r.prior_status,
          r.prior_facet_state,
          r.prior_agreement_status,
          r.prior_context_outcome,
          r.prior_representation_status,
          None,
        ),
      ),
      #(
        "resultingState",
        state_json(
          r,
          None,
          r.result_facet_state,
          r.result_agreement_status,
          r.result_context_outcome,
          r.result_representation_status,
          r.result_note,
        ),
      ),
      rev,
    ]
    review_event_row.RegulatoryReviewCancelled ->
      case h.detail_rev {
        None -> [#("reasonCode", json.string("context_closed"))]
        Some(_) -> [
          #("outcome", json.string("CANCELLED")),
          #("reasonCode", json.string("cancelled")),
          rev,
        ]
      }
    review_event_row.RegulatoryReviewSuperseded -> [
      #("reasonCode", json.string("superseded")),
      #(
        "priorState",
        json.object([
          #(
            "status",
            json.nullable(h.detail_prior_status, review_status.to_json),
          ),
        ]),
      ),
      rev,
    ]
    review_event_row.RegulatoryReviewRequested -> []
  }
}

/// `GET /ts/compliance/audit`: the newest 200 decision entries with the reviewer who made each (audit.mjs
/// `reviewerDecisionRows`).
pub fn audit(ctx: Ctx) -> Response {
  use rows <- reading(ctx, fn(r) {
    use entries <- result.try(store.query(
      r,
      "SELECT "
        <> review_event_row.columns
        <> " FROM regulatory_review_history WHERE action <> 'regulatory_review_requested' ORDER BY at DESC, id DESC LIMIT 200",
      [],
      review_event_row.decoder(),
    ))
    list.try_map(entries, fn(h) {
      use rv <- result.map(reviews.by_id(r, h.review_id))
      let assert Some(rv) = rv
      #(h, rv)
    })
  })
  let item = fn(pair: #(review_event_row.Row, Review)) {
    let #(h, rv) = pair
    let detail = decision_detail(rv, h)
    let pick = fn(k, default) {
      list.key_find(detail, k) |> result.unwrap(default)
    }
    json.object([
      #("id", id.review_event_json(h.id)),
      #("at", json.int(h.at)),
      #("action", review_event_row.action_to_json(h.action)),
      #("reviewId", id.regulatory_review_json(rv.row.id)),
      #("kind", review_row.kind_to_json(rv.row.kind)),
      #("reviewer", case h.by_kind {
        compliance_actor_kind.TsReviewer ->
          json.object([
            #("reviewerId", json.nullable(h.by_id, json.string)),
            #("name", json.nullable(h.by_name, json.string)),
            #("role", json.nullable(h.by_role, json.string)),
            #("attribution", json.string("authenticated_reviewer")),
          ])
        kind ->
          json.object([
            #("reviewerId", json.null()),
            #("name", json.nullable(h.by_name, json.string)),
            #("role", json.null()),
            #(
              "attribution",
              json.string(case kind {
                compliance_actor_kind.System -> "system"
                _ -> "legacy_unattributed"
              }),
            ),
          ])
      }),
      #("subject", subject_json(rv.row)),
      #("agencyOrgId", id.org_json(rv.row.agency_org_id)),
      #("outcome", pick("outcome", json.null())),
      #("reasonCode", pick("reasonCode", json.null())),
      #("evidenceRefs", pick("evidenceRefs", json.preprocessed_array([]))),
      #(
        "policyVersions",
        pick("policyVersions", json.array(rv.policy_versions, id.policy_json)),
      ),
      #("priorState", pick("priorState", json.null())),
      #("resultingState", pick("resultingState", json.null())),
      #("rev", pick("rev", json.null())),
    ])
  }
  http.json(
    200,
    json.object([
      #("items", json.array(rows, item)),
      #("legacyNote", json.string(legacy_note)),
    ]),
  )
}

fn counts_by(read: Read, sql: String) -> Result(List(#(String, Int)), Fail(e)) {
  store.query(read, sql, [], {
    use k <- decode.field(0, decode.string)
    use n <- decode.field(1, decode.int)
    decode.success(#(k, n))
  })
}

/// `GET /ts/compliance/metrics`: counts and durations only; no person, no ranking.
pub fn metrics(ctx: Ctx) -> Response {
  let now = clock.now_ms()
  use m <- reading(ctx, fn(r) {
    use statuses <- result.try(counts_by(
      r,
      "SELECT status, COUNT(*) FROM regulatory_reviews GROUP BY status",
    ))
    use kinds <- result.try(counts_by(
      r,
      "SELECT kind, COUNT(*) FROM regulatory_reviews GROUP BY kind",
    ))
    use decided <- result.try(store.query(
      r,
      "SELECT decided_at - requested_at FROM regulatory_reviews WHERE decided_at IS NOT NULL ORDER BY 1",
      [],
      decode.at([0], decode.int),
    ))
    use outcomes <- result.try(counts_by(
      r,
      "SELECT outcome, COUNT(*) FROM compliance_evaluations GROUP BY outcome ORDER BY outcome",
    ))
    use consents <- result.try(
      store.query(
        r,
        "SELECT COUNT(*), COALESCE(SUM(CASE WHEN c.status = 'granted' AND v.id IS NULL THEN 1 ELSE 0 END), 0), COALESCE(SUM(CASE WHEN c.status = 'declined' THEN 1 ELSE 0 END), 0), COALESCE(SUM(CASE WHEN v.id IS NOT NULL THEN 1 ELSE 0 END), 0) FROM regulatory_consents c LEFT JOIN regulatory_consent_revocations v ON v.consent_id = c.id WHERE c.kind = 'dual_representation'",
        [],
        {
          use a <- decode.field(0, decode.int)
          use b <- decode.field(1, decode.int)
          use c <- decode.field(2, decode.int)
          use d <- decode.field(3, decode.int)
          decode.success(#(a, b, c, d))
        },
      ),
    )
    use stale <- result.map(store.query(
      r,
      "SELECT COUNT(*) FROM agent_profile_facets WHERE state = 'VERIFIED' AND recheck_at IS NOT NULL AND recheck_at <= ?",
      [sqlight.int(now)],
      decode.at([0], decode.int),
    ))
    #(statuses, kinds, decided, outcomes, consents, stale)
  })
  let #(statuses, kinds, decided, outcomes, consents, stale) = m
  let counted = fn(pairs: List(#(String, a)), found: List(#(String, Int))) {
    json.object(
      list.map(pairs, fn(p) {
        #(p.0, json.int(list.key_find(found, p.0) |> result.unwrap(0)))
      }),
    )
  }
  let median = case decided {
    [] -> json.null()
    _ ->
      list.drop(decided, list.length(decided) / 2)
      |> list.first
      |> result.map(json.int)
      |> result.unwrap(json.null())
  }
  let consents = case consents {
    [#(a, b, c, d), ..] -> #(a, b, c, d)
    [] -> #(0, 0, 0, 0)
  }
  http.json(
    200,
    json.object([
      #(
        "reviews",
        json.object([
          #("byStatus", counted(review_status.pairs, statuses)),
          #("byKind", counted(review_row.kind_pairs, kinds)),
          #("medianDurationMs", median),
        ]),
      ),
      #(
        "conflictOutcomes",
        json.object(list.map(outcomes, fn(p) { #(p.0, json.int(p.1)) })),
      ),
      #(
        "consents",
        json.object([
          #("requested", json.int(consents.0)),
          #("granted", json.int(consents.1)),
          #("declined", json.int(consents.2)),
          #("revoked", json.int(consents.3)),
        ]),
      ),
      #("staleFacets", json.int(list.first(stale) |> result.unwrap(0))),
      #(
        "note",
        json.string(
          "Process metrics only. No agent is ranked and no subscription or payment status enters any compliance outcome.",
        ),
      ),
    ]),
  )
}
