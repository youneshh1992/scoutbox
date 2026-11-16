//// The acts every verification route is built from (domains/verification/claims/index.mjs and organisations.mjs):
//// the only claim creator, every status change, evidence, the audit events, the permission guard, and the
//// views. Verification proves facts; authorisation decides access, and nothing here loosens a visibility rule.

import gleam/bit_array
import gleam/crypto
import gleam/dict
import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/regexp
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/orgs.{type Org}
import scoutbox/identity/staff
import scoutbox/messaging/notifications
import scoutbox/platform/http
import scoutbox/platform/ids
import scoutbox/platform/input
import scoutbox/platform/media
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/ver_claims.{type Status} as claim_row
import scoutbox/rows/ver_events as event_row
import scoutbox/rows/ver_evidence as evidence_row
import scoutbox/rows/ver_tokens as token_row
import scoutbox/verification/claims.{type Claim}
import scoutbox/verification/records.{type Evidence, type Token}
import scoutbox/vocab/actor_kind.{type ActorKind}
import scoutbox/vocab/attribution.{type Attribution}
import scoutbox/vocab/audience
import scoutbox/vocab/claim_type.{type ClaimType}
import scoutbox/vocab/org_type
import scoutbox/vocab/ver_code.{type VerCode}
import scoutbox/vocab/ver_level.{type VerLevel}
import scoutbox/vocab/verification_method.{type VerificationMethod}
import sqlight
import wisp.{type Request, type Response}

/// The statuses a claim is still being decided in.
pub const open_states = [
  claim_row.Unverified,
  claim_row.CollectingEvidence,
  claim_row.Pending,
  claim_row.AutomatedChecksPassed,
  claim_row.RequiresHumanReview,
]

fn open_or_verified(s: Status) -> Bool {
  s == claim_row.Verified || list.contains(open_states, s)
}

// ------------------------------------------------------------------------------------------------ who acts

/// Who an event is attributed to, and the request it came from.
pub type Actor {
  Actor(
    kind: event_row.ActorKind,
    id: Option(String),
    name: Option(String),
    org_id: Option(String),
    request_id: Option(String),
  )
}

/// The request's correlation id: the client's `x-request-id` when it is a sensible one, else a fresh one.
pub fn request_id(req: Request) -> String {
  let assert Ok(sensible) = regexp.from_string("^[a-zA-Z0-9_-]{6,64}$")
  case http.header(req, "x-request-id") {
    Ok(id) ->
      case regexp.check(sensible, id) {
        True -> id
        False -> fresh_request_id()
      }
    Error(Nil) -> fresh_request_id()
  }
}

fn fresh_request_id() -> String {
  "req_"
  <> string.lowercase(bit_array.base16_encode(crypto.strong_random_bytes(8)))
}

pub fn staff_actor(access: OrgAccess, req: Request) -> Actor {
  Actor(
    kind: event_row.OrgUser,
    id: Some(access.user.id),
    name: Some(access.user.name),
    org_id: Some(access.org.id),
    request_id: Some(request_id(req)),
  )
}

pub fn system_actor(req: Option(Request)) -> Actor {
  Actor(
    kind: event_row.System,
    id: None,
    name: None,
    org_id: None,
    request_id: option.map(req, request_id),
  )
}

/// The claims' own vocabulary for who acted, from an event's.
pub fn claim_actor_kind(kind: event_row.ActorKind) -> ActorKind {
  case kind {
    event_row.OrgUser -> actor_kind.OrgUser
    event_row.System -> actor_kind.System
    event_row.TrustSafety -> actor_kind.TrustSafety
  }
}

// ------------------------------------------------------------------------------------------------ events

/// What an event says about its subject.
pub type About {
  About(
    claim_id: Option(String),
    subject_id: Option(String),
    org_id: Option(String),
    detail: Option(String),
    reason: Option(String),
    attribution: Option(Attribution),
  )
}

pub const nothing =
  About(
    claim_id: None,
    subject_id: None,
    org_id: None,
    detail: None,
    reason: None,
    attribution: None,
  )

pub fn event(
  tx: Tx,
  type_: event_row.Type,
  actor: Actor,
  about: About,
  now: Int,
) -> Result(Nil, Fail(e)) {
  use id <- result.try(ids.next(tx, "vevt"))
  records.append_event(
    tx,
    id,
    now,
    type_,
    records.Event(
      actor_kind: actor.kind,
      actor_id: actor.id,
      actor_name: actor.name,
      actor_org_id: actor.org_id,
      request_id: actor.request_id,
      attribution: about.attribution,
      claim_id: about.claim_id,
      subject_id: about.subject_id,
      org_id: about.org_id,
      detail: about.detail,
      reason: about.reason,
    ),
  )
}

pub fn claim_about(claim: Claim) -> About {
  About(
    ..nothing,
    claim_id: Some(claim.id),
    subject_id: Some(claim.subject_id),
    org_id: claim.organisation_id,
  )
}

// ------------------------------------------------------------------------------------------------ claims

/// A new claim: `unverified`, current, nothing established yet. Callers set what they know.
pub fn blank_claim(
  id: String,
  subject_kind: claim_row.SubjectKind,
  subject_id: String,
  claim_type: ClaimType,
  now: Int,
) -> Claim {
  claim_row.new(
    id:,
    subject_kind:,
    subject_id:,
    claim_type:,
    status: claim_row.Unverified,
    current: True,
    created_at: now,
    updated_at: now,
  )
}

/// The only claim creator: stores the claim and records `claim.created`.
pub fn create_claim(
  tx: Tx,
  make: fn(String) -> Claim,
  actor: Actor,
  now: Int,
) -> Result(Claim, Fail(e)) {
  use id <- result.try(ids.next(tx, "vclm"))
  use claim <- result.try(records.create_claim(tx, make(id)))
  use _ <- result.try(event(
    tx,
    event_row.ClaimCreated,
    actor,
    About(
      ..claim_about(claim),
      detail: records.detail([], [
        #("claimType", Some(claim_type.to_string(claim.claim_type))),
        #("status", Some(claim_row.status_to_string(claim.status))),
      ]),
    ),
    now,
  ))
  use _ <- result.try(count(tx, "requestsCreated"))
  Ok(claim)
}

/// Why a move was refused.
pub type MoveError {
  /// The person opened another claim of the kind meanwhile.
  Clash(code: String)
  Refused(claims.TransitionError)
}

pub fn move_error_code(e: MoveError) -> String {
  case e {
    Clash(code) -> code
    Refused(t) -> claims.transition_error_code(t)
  }
}

/// What a move records besides its own effects.
pub type Also {
  Also(
    /// Corrected fields, applied after the move's own.
    set: fn(Claim) -> Claim,
    /// Replaces the review reasons.
    review_reasons: Option(List(VerCode)),
    add_review_reasons: List(VerCode),
    add_risk_flags: List(VerCode),
  )
}

pub fn no_more() -> Also {
  Also(
    set: fn(c) { c },
    review_reasons: None,
    add_review_reasons: [],
    add_risk_flags: [],
  )
}

/// How a claim is moved: who moves it, by what method and why, and the event that records it (`claim.<status>`
/// unless given).
pub type How {
  How(
    actor: Actor,
    method: Option(VerificationMethod),
    reason: Option(String),
    attribution: Option(Attribution),
    event: Option(event_row.Type),
  )
}

const affiliation_types = [
  claim_type.ClubAffiliation,
  claim_type.ClubRole,
  claim_type.AgencyAffiliation,
  claim_type.AgencyRole,
  claim_type.GrassrootsAffiliation,
]

/// A claim may not return to an open or verified state while the person has opened another in the meantime.
fn open_clash(
  read: Read,
  claim: Claim,
  to: Status,
) -> Result(Option(String), Fail(e)) {
  case
    claim.subject_kind != claim_row.User
    || !open_or_verified(to)
    || open_or_verified(claim.status)
  {
    True -> Ok(None)
    False -> {
      use theirs <- result.map(records.claims_for(
        read,
        claim_row.User,
        claim.subject_id,
      ))
      let others =
        list.filter(theirs, fn(x) {
          x.id != claim.id
          && x.claim_type == claim.claim_type
          && open_or_verified(x.status)
        })
      case claim.claim_type {
        claim_type.PersonIdentity if others != [] ->
          Some("IDENTITY_CLAIM_EXISTS")
        t ->
          case
            list.contains(affiliation_types, t)
            && claim.current
            && list.any(others, fn(x) {
              x.current && x.organisation_id == claim.organisation_id
            })
          {
            True -> Some("AFFILIATION_CLAIM_EXISTS")
            False -> None
          }
      }
    }
  }
}

/// Every status change: guarded in SQL from the status read here, recorded as an event.
pub fn transition(
  tx: Tx,
  claim_id: String,
  to: Status,
  how: How,
  also: Also,
  now: Int,
) -> Result(Result(Claim, MoveError), Fail(e)) {
  let read = store.reading(tx)
  use found <- result.try(records.claim(read, claim_id))
  let assert Some(current) = found as "a claim is moved only after it was found"
  use clash <- result.try(open_clash(read, current, to))
  case clash {
    Some(code) -> Ok(Error(Clash(code)))
    None -> {
      let by =
        claims.By(
          actor_kind: Some(claim_actor_kind(how.actor.kind)),
          actor_id: how.actor.id,
          method: how.method,
          reason: how.reason,
        )
      case claims.transition(current, to, by, now) {
        Error(e) -> Ok(Error(Refused(e)))
        Ok(moved) -> {
          let moved = also.set(moved)
          use done <- result.try(records.move_claim(tx, moved, current.status))
          let assert True = done
            as "a claim moves from the status this unit read"
          use _ <- result.try(case also.review_reasons {
            Some(codes) ->
              records.set_codes(tx, claim_id, records.ReviewReasons, codes)
            None -> Ok(Nil)
          })
          use _ <- result.try(records.add_codes(
            tx,
            claim_id,
            records.ReviewReasons,
            also.add_review_reasons,
          ))
          use _ <- result.try(records.add_codes(
            tx,
            claim_id,
            records.RiskFlags,
            also.add_risk_flags,
          ))
          use _ <- result.try(event(
            tx,
            option.unwrap(how.event, status_event(to)),
            how.actor,
            About(
              ..claim_about(moved),
              detail: records.detail(
                [#("status", Some(claim_row.status_to_string(current.status)))],
                [
                  #("status", Some(claim_row.status_to_string(to))),
                  #(
                    "method",
                    option.map(
                      moved.verification_method,
                      verification_method.to_string,
                    ),
                  ),
                ],
              ),
              reason: how.reason,
              attribution: how.attribution,
            ),
            now,
          ))
          use _ <- result.try(case to {
            claim_row.Verified -> count(tx, "approvals")
            claim_row.Rejected -> count(tx, "rejections")
            claim_row.Revoked -> count(tx, "revocations")
            claim_row.Expired -> count(tx, "expiries")
            claim_row.Disputed -> count(tx, "disputes")
            _ -> Ok(Nil)
          })
          Ok(Ok(moved))
        }
      }
    }
  }
}

fn status_event(s: Status) -> event_row.Type {
  case s {
    claim_row.Unverified -> event_row.ClaimUnverified
    claim_row.CollectingEvidence -> event_row.ClaimCollectingEvidence
    claim_row.Pending -> event_row.ClaimPending
    claim_row.AutomatedChecksPassed -> event_row.ClaimAutomatedChecksPassed
    claim_row.RequiresHumanReview -> event_row.ClaimRequiresHumanReview
    claim_row.Verified -> event_row.ClaimVerified
    claim_row.Rejected -> event_row.ClaimRejected
    claim_row.Expired -> event_row.ClaimExpired
    claim_row.Suspended -> event_row.ClaimSuspended
    claim_row.Revoked -> event_row.ClaimRevoked
    claim_row.Disputed -> event_row.ClaimDisputed
    claim_row.Superseded -> event_row.ClaimSuperseded
  }
}

// ------------------------------------------------------------------------------------------------ evidence

/// Records evidence (never on a public path; retrieval is an authorised route) and `evidence.added`.
pub fn add_evidence(
  tx: Tx,
  make: fn(String) -> Evidence,
  claim_ids: List(String),
  actor: Actor,
  now: Int,
) -> Result(Evidence, Fail(e)) {
  use id <- result.try(ids.next(tx, "vevd"))
  use ev <- result.try(records.add_evidence(tx, make(id), claim_ids))
  use _ <- result.try(event(
    tx,
    event_row.EvidenceAdded,
    actor,
    About(
      ..nothing,
      claim_id: list.first(claim_ids) |> option.from_result,
      subject_id: ev.supplied_by_id,
      org_id: ev.org_id,
      detail: records.detail([], [
        #("type", Some(evidence_row.type_to_string(ev.type_))),
        #("sha256", ev.sha256),
      ]),
    ),
    now,
  ))
  Ok(ev)
}

/// Evidence as it is first received: nothing scanned (no scanner exists; never pretend one ran), kept until the
/// claim is resolved, for Trust & Safety only unless the caller says otherwise.
pub fn blank_evidence(
  id: String,
  type_: evidence_row.Type,
  source: String,
  supplied_by_kind: evidence_row.SuppliedByKind,
  now: Int,
) -> Evidence {
  evidence_row.new(
    id:,
    type_:,
    source:,
    supplied_by_kind:,
    received_at: now,
    check_malware_scan: evidence_row.NotConfigured,
    retention: evidence_row.UntilClaimResolution,
    visibility: evidence_row.TrustAndSafety,
  )
}

/// A file sent as a data URL, checked and ready to store.
pub type File {
  File(
    media_id: String,
    bytes: BitArray,
    mime: evidence_row.Mime,
    sha256: String,
    filename: String,
  )
}

/// A data URL's file, if it is one the evidence rules accept, stored under an id of our own (storeEvidenceFile):
/// before the unit that records it, as the TypeScript server does. Error: the refusal's code.
pub fn evidence_file(
  ctx: Ctx,
  data_url: String,
  filename: Option(String),
) -> Result(File, String) {
  let assert Ok(shape) = regexp.from_string("^data:([\\w/+.-]+);base64,(.+)$")
  case regexp.scan(shape, data_url) {
    [regexp.Match(submatches: [Some(mime), Some(payload)], ..)] ->
      case bit_array.base64_decode(payload) {
        Error(Nil) -> Error("BAD_DATA_URL")
        Ok(bytes) -> {
          let name = option.unwrap(filename, "evidence")
          case
            claims.evidence_file_problem(claims.File(
              mime:,
              bytes: bit_array.byte_size(bytes),
              filename: name,
              buffer: Some(bytes),
            ))
          {
            Some(problem) -> Error(claims.file_problem_code(problem))
            None -> {
              let assert Ok(m) = list.key_find(evidence_row.mime_pairs, mime)
                as "an accepted file has an accepted type"
              let media_id =
                "vfil-"
                <> string.lowercase(
                  bit_array.base16_encode(crypto.strong_random_bytes(8)),
                )
              // A file the disk refuses is a broken store, not the sender's fault.
              let assert Ok(Nil) =
                media.save(ctx.config.data_dir, media_id, mime, bytes)
                as "the media directory accepts files"
              Ok(File(
                media_id:,
                bytes:,
                mime: m,
                sha256: string.lowercase(
                  bit_array.base16_encode(crypto.hash(crypto.Sha256, bytes)),
                ),
                filename: input.utf16_take(option.unwrap(filename, ""), 120),
              ))
            }
          }
        }
      }
    _ -> Error("BAD_DATA_URL")
  }
}

/// The fields a stored file sets on its evidence record.
pub fn with_file(ev: Evidence, file: File) -> Evidence {
  evidence_row.Row(
    ..ev,
    media_id: Some(file.media_id),
    sha256: Some(file.sha256),
    mime: Some(file.mime),
    bytes: Some(bit_array.byte_size(file.bytes)),
    filename: Some(file.filename),
    check_content_signature: Some(evidence_row.MatchedClaimedType),
  )
}

pub fn evidence_checks(ev: Evidence) -> Json {
  json.object(
    list.flatten([
      [
        #(
          "malwareScan",
          evidence_row.check_malware_scan_to_json(ev.check_malware_scan),
        ),
      ],
      case ev.check_content_signature {
        Some(s) -> [
          #("contentSignature", evidence_row.check_content_signature_to_json(s)),
        ]
        None -> []
      },
    ]),
  )
}

// ------------------------------------------------------------------------------------------------ tokens

pub const work_email_ttl_ms = 1_800_000

pub fn sha256_hex(s: String) -> String {
  string.lowercase(
    bit_array.base16_encode(crypto.hash(crypto.Sha256, bit_array.from_string(s))),
  )
}

/// Mints a single-use secret, stored only as its hash. The plain secret exists only in the mail that carries it.
pub fn mint_token(
  tx: Tx,
  purpose: token_row.Purpose,
  email: Option(String),
  subject_kind: Option(token_row.SubjectKind),
  subject_id: Option(String),
  org_id: Option(String),
  ref_id: Option(String),
  ttl_ms: Int,
  now: Int,
) -> Result(String, Fail(e)) {
  let secret =
    bit_array.base64_url_encode(crypto.strong_random_bytes(24), False)
  use id <- result.try(ids.next(tx, "vtk"))
  use _ <- result.try(records.create_token(
    tx,
    token_row.Row(
      id:,
      token_hash: sha256_hex(secret),
      purpose:,
      email: option.map(email, fn(e) { e |> string.trim |> string.lowercase }),
      subject_kind:,
      subject_id:,
      org_id:,
      ref_id:,
      created_at: now,
      expires_at: now + ttl_ms,
      used_at: None,
      attempts_failed: 0,
    ),
  ))
  Ok(secret)
}

/// A token checked without spending it (peekToken). Callers with extra binding checks peek first and spend the
/// token only after them, so a failed binding doesn't burn the rightful recipient's secret.
pub fn peek_token(
  read: Read,
  purpose: token_row.Purpose,
  secret: Option(String),
  email: Option(String),
  subject_id: Option(String),
  now: Int,
) -> Result(Result(Token, String), Fail(e)) {
  use found <- result.map(records.token_by_hash(
    read,
    sha256_hex(option.unwrap(secret, "")),
  ))
  case found {
    None -> Error("TOKEN_UNKNOWN")
    Some(t) if t.purpose != purpose -> Error("TOKEN_WRONG_PURPOSE")
    Some(t) if t.used_at != None -> Error("TOKEN_ALREADY_USED")
    Some(t) if t.expires_at < now -> Error("TOKEN_EXPIRED")
    Some(t) ->
      case t.email, email, t.subject_id, subject_id {
        Some(a), Some(b), _, _ if a != b -> Error("TOKEN_WRONG_ADDRESS")
        _, _, Some(a), Some(b) if a != b -> Error("TOKEN_WRONG_ACCOUNT")
        _, _, _, _ -> Ok(t)
      }
  }
}

// ------------------------------------------------------------------------------------------------ authority

pub fn admins_level(
  read: Read,
  org_id: String,
  user_id: String,
) -> Result(Option(VerLevel), Fail(e)) {
  use admins <- result.map(records.admins_of(read, org_id))
  claims.ver_level_for(admins, org_id, user_id)
}

/// The permission guard. Root operations also need an account with MFA enabled.
pub fn require_ver(
  read: Read,
  access: OrgAccess,
  at_least: VerLevel,
  root: Bool,
  next: fn() -> Response,
) -> Response {
  case records.admins_of(read, access.org.id) {
    Error(failure) -> http.internal(failure)
    Ok(admins) ->
      case
        claims.has_ver_level(admins, access.org.id, access.user.id, at_least),
        root && access.user.mfa_enabled_at == None
      {
        False, _ -> require_ver_refusal(at_least)
        True, True ->
          http.error_message(
            403,
            "MFA_REQUIRED_FOR_ROOT_OPERATION",
            "Sensitive verification-authority operations require an account with MFA enabled (Organisation → Security).",
          )
        True, False -> next()
      }
  }
}

pub fn require_ver_refusal(at_least: VerLevel) -> Response {
  http.error_message(
    403,
    "VERIFICATION_PERMISSION_REQUIRED",
    "This needs "
      <> string.replace(ver_level.to_string(at_least), "_", " ")
      <> " authority for your organisation.",
  )
}

/// The active administrators of an organisation at `at_least` or above, as staff who are still there.
pub fn reviewers_of(
  read: Read,
  org_id: String,
  at_least: VerLevel,
) -> Result(List(staff.Staff), Fail(e)) {
  use admins <- result.try(records.active_admins_of(read, org_id))
  admins
  |> list.filter(fn(a) {
    claims.has_ver_level([a], org_id, a.user_id, at_least)
  })
  |> list.try_map(fn(a) { staff.by_id(read, a.user_id) })
  |> result.map(fn(found) {
    list.filter_map(found, fn(s) {
      case s {
        Some(u) if u.removed_at == None -> Ok(u)
        _ -> Error(Nil)
      }
    })
  })
}

pub fn notify_reviewers(
  tx: Tx,
  org_id: String,
  text: String,
  ref_id: String,
  now: Int,
) -> Result(Nil, Fail(e)) {
  use reviewers <- result.try(reviewers_of(
    store.reading(tx),
    org_id,
    ver_level.VerificationReviewer,
  ))
  list.try_each(reviewers, fn(u) {
    notifications.notify(
      tx,
      to: audience.OrgUser,
      id: u.id,
      type_: "verification",
      text:,
      ref_id: Some(ref_id),
      at: now,
    )
  })
}

pub fn verified_domains_of(
  read: Read,
  org_id: String,
) -> Result(List(String), Fail(e)) {
  records.domains_of(read, org_id)
  |> result.map(list.map(_, fn(d) { d.domain }))
}

/// Whether a root application for the organisation is still open.
pub fn root_pending(read: Read, org_id: String) -> Result(Bool, Fail(e)) {
  store.one(
    read,
    "SELECT 1 FROM ver_root_requests WHERE (existing_org_id = ? OR result_org_id = ?) AND status IN ('requires_human_review','collecting_evidence') LIMIT 1",
    [sqlight.text(org_id), sqlight.text(org_id)],
    decode.success(Nil),
  )
  |> result.map(result.is_ok)
}

pub fn org_status(
  read: Read,
  org: Option(Org),
) -> Result(claims.OrgStatus, Fail(e)) {
  case org {
    None -> Ok(claims.org_verification_status(None, False))
    Some(o) -> {
      use pending <- result.map(root_pending(read, o.id))
      claims.org_verification_status(Some(o), pending)
    }
  }
}

/// The two claims an affiliation request makes, for an organisation of this kind.
pub fn affiliation_types_of(org: Org) -> #(ClaimType, ClaimType) {
  case org.type_, orgs.is_grassroots(org) {
    org_type.Agency, _ -> #(claim_type.AgencyAffiliation, claim_type.AgencyRole)
    _, True -> #(claim_type.GrassrootsAffiliation, claim_type.ClubRole)
    _, False -> #(claim_type.ClubAffiliation, claim_type.ClubRole)
  }
}

// ------------------------------------------------------------------------------------------------ views

fn orgs_for(
  read: Read,
  claims: List(Claim),
) -> Result(dict.Dict(String, Org), Fail(e)) {
  claims
  |> list.filter_map(fn(c) { option.to_result(c.organisation_id, Nil) })
  |> list.unique
  |> list.try_map(fn(id) { orgs.by_id(read, id) })
  |> result.map(fn(found) {
    found
    |> list.filter_map(fn(o) { option.to_result(o, Nil) })
    |> list.map(fn(o) { #(o.id, o) })
    |> dict.from_list
  })
}

/// A user's public verification. A removed account loses current public verification at once; closed historical
/// periods stay visible.
pub fn public_user(
  read: Read,
  user_id: String,
  now: Int,
) -> Result(Json, Fail(e)) {
  use user <- result.try(staff.by_id(read, user_id))
  use theirs <- result.try(records.claims_for(read, claim_row.User, user_id))
  use by_id <- result.map(orgs_for(read, theirs))
  claims.public_profile(
    subject_kind: claim_row.User,
    subject_id: user_id,
    claims: theirs,
    orgs: by_id,
    subject_removed: case user {
      Some(u) -> u.removed_at != None
      None -> True
    },
    now:,
  )
}

/// An organisation's public verification, with its lifecycle status.
pub fn public_org(
  read: Read,
  org_id: String,
  now: Int,
) -> Result(Json, Fail(e)) {
  use org <- result.try(orgs.by_id(read, org_id))
  use theirs <- result.try(records.claims_for(read, claim_row.Org, org_id))
  use by_id <- result.try(orgs_for(read, theirs))
  use status <- result.map(org_status(read, org))
  claims.public_profile_fields(
    subject_kind: claim_row.Org,
    subject_id: org_id,
    claims: theirs,
    orgs: by_id,
    subject_removed: False,
    now:,
  )
  |> list.append([
    #("organisationStatus", json.string(claims.org_status_code(status))),
  ])
  |> json.object
}

fn human_review_note(reasons: List(VerCode)) -> String {
  // Plain language, without leaking internal security rules.
  let bits =
    list.flatten([
      when(
        list.contains(reasons, ver_code.RootOrganisationBootstrap),
        "an authorised organisation administrator has not yet been established for this organisation",
      ),
      when(
        list.contains(reasons, ver_code.NoAuthoritativeSource),
        "no authorised administrator or authoritative registry can confirm this automatically",
      ),
      when(
        list.contains(reasons, ver_code.DocumentAuthenticityUnconfirmed),
        "an uploaded document is evidence, not proof — a reviewer checks it against authoritative sources",
      ),
      when(
        list.contains(reasons, ver_code.DisputedClaim),
        "the claim is under dispute",
      ),
    ])
  "ScoutBox needs to review this request"
  <> case bits {
    [] -> ""
    _ -> " because " <> string.join(bits, "; ")
  }
  <> "."
}

fn when(c: Bool, v: a) -> List(a) {
  case c {
    True -> [v]
    False -> []
  }
}

fn nullable_int(v: Option(Int)) -> Json {
  json.nullable(v, json.int)
}

/// A claim as its subject sees it: never someone else's evidence, never reviewer notes.
pub fn subject_claim_view(
  read: Read,
  claim: Claim,
  now: Int,
) -> Result(Json, Fail(e)) {
  use org <- result.try(case claim.organisation_id {
    Some(id) -> orgs.by_id(read, id)
    None -> Ok(None)
  })
  use reasons <- result.try(records.codes(read, claim.id, records.ReviewReasons))
  use evidence <- result.map(records.claim_evidence(read, claim.id))
  let eff = claims.effective_status(claim, org:, subject_removed: False, now:)
  json.object([
    #("id", json.string(claim.id)),
    #("claimType", claim_type.to_json(claim.claim_type)),
    #("status", claim_row.status_to_json(claim.status)),
    #(
      "effective",
      json.object([
        #("status", claim_row.status_to_json(eff.status)),
        #("current", json.bool(eff.current)),
        #("historical", json.bool(eff.historical)),
      ]),
    ),
    #(
      "organisation",
      json.nullable(org, fn(o) {
        json.object([#("id", json.string(o.id)), #("name", json.string(o.name))])
      }),
    ),
    #("role", json.nullable(claim.role, json.string)),
    #("validFrom", nullable_int(claim.valid_from)),
    #("validUntil", nullable_int(claim.valid_until)),
    #("current", json.bool(claim.current)),
    #(
      "verificationMethod",
      json.nullable(claim.verification_method, verification_method.to_json),
    ),
    #("verifiedAt", nullable_int(claim.verified_at)),
    #("provenance", case claim.status {
      claim_row.Verified ->
        json.string(claims.claim_provenance_label(
          claim,
          option.map(org, fn(o) { o.name }),
        ))
      _ -> json.null()
    }),
    #("reviewReasons", json.array(reasons, ver_code.to_json)),
    #("createdAt", json.int(claim.created_at)),
    #("updatedAt", json.int(claim.updated_at)),
    #("revocationReason", json.nullable(claim.revocation_reason, json.string)),
    #("disputedAt", nullable_int(claim.disputed_at)),
    #(
      "evidence",
      json.array(evidence, fn(e) {
        json.object([
          #("id", json.string(e.id)),
          #("type", evidence_row.type_to_json(e.type_)),
          #("receivedAt", json.int(e.received_at)),
          #("filename", json.nullable(e.filename, json.string)),
          #("checks", evidence_checks(e)),
          #("note", json.nullable(e.note, json.string)),
        ])
      }),
    ),
    #("humanReviewNote", case claim.status {
      claim_row.RequiresHumanReview -> json.string(human_review_note(reasons))
      _ -> json.null()
    }),
  ])
}

// ------------------------------------------------------------------------------------------------ acting

/// What a route's unit ends in: the response, or a refusal that rolls the unit back.
pub type Done =
  Result(Response, Fail(Response))

/// Runs a route's work in one unit. A refusal (`stop`) is the response, and rolls back everything the work wrote;
/// a response the work returns commits, even an error that follows a write the act keeps (a failed attempt counted).
pub fn act(ctx: Ctx, work: fn(Tx) -> Done) -> Response {
  case store.unit(ctx.store, work) {
    Ok(response) -> response
    Error(store.Refused(response)) -> response
    Error(failure) -> http.internal(failure)
  }
}

/// A refusal: the unit rolls back and this is the response.
pub fn stop(response: Response) -> Result(a, Fail(Response)) {
  store.refuse(response)
}

pub fn reply(response: Response) -> Done {
  Ok(response)
}

/// A read-only route.
pub fn look(
  ctx: Ctx,
  work: fn(Read) -> Result(Response, Fail(Response)),
) -> Response {
  case store.read(ctx.store, work) {
    Ok(response) -> response
    Error(store.Refuse(response)) -> response
    Error(store.Storage(e)) -> http.internal(e)
  }
}

/// A storage failure inside an act keeps its meaning; an act's own refusals are responses.
pub fn storage(r: Result(a, Fail(e))) -> Result(a, Fail(Response)) {
  store.map_refusal(r, fn(_) { http.error(500, "INTERNAL") })
}

// ------------------------------------------------------------------------------------------------ metrics

/// The verification counters `/admin/metrics` shows, in its order: counts only, never names or e-mails.
pub const metric_names = [
  "requestsCreated", "autoPrechecksPassed", "routedToHumanReview", "approvals",
  "rejections", "disputes", "expiries", "revocations", "emailChallengeFailures",
]

const metrics_table =
  "CREATE TEMP TABLE IF NOT EXISTS ver_metrics (name TEXT PRIMARY KEY, n INTEGER NOT NULL)"

/// Counts one occurrence. The counters live for the process, like the TypeScript server's in-memory ones: in a
/// temporary table of the writer's connection, so they are not part of the schema, start at zero on every boot,
/// and a refused act's count rolls back with it.
pub fn count(tx: Tx, metric: String) -> Result(Nil, Fail(e)) {
  use _ <- result.try(store.exec(tx, metrics_table))
  store.run(
    tx,
    "INSERT INTO ver_metrics (name, n) VALUES (?, 1) ON CONFLICT (name) DO UPDATE SET n = n + 1",
    [sqlight.text(metric)],
  )
}

/// The counters, read on the writer's connection, which holds them.
pub fn metrics(tx: Tx) -> Result(Json, Fail(e)) {
  use _ <- result.try(store.exec(tx, metrics_table))
  use rows <- result.map(
    store.query(store.reading(tx), "SELECT name, n FROM ver_metrics", [], {
      use name <- decode.field(0, decode.string)
      use n <- decode.field(1, decode.int)
      decode.success(#(name, n))
    }),
  )
  json.object(
    list.map(metric_names, fn(name) {
      #(name, json.int(list.key_find(rows, name) |> result.unwrap(0)))
    }),
  )
}
