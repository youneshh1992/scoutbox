//// The verification rules (domains/verification/claims/shared.mjs). Verification is a set of independent claims,
//// each recording what was established, how, by whom and on what evidence; there is no account-level `verified`.
//// An uploaded document is evidence, never the method of a verified claim, and nobody can be the authoritative
//// confirmer of their own claim.
////
//// A claim is its stored row. The rules that read the clock take `now`.
////
//// Not ported yet: the token functions (`mintToken`, `peekToken`, `consumeToken`) work on the `ver_tokens` table
//// and arrive with the repository; `bootstrapVerification` is a migration step.

import gleam/bit_array
import gleam/dict.{type Dict}
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/regexp
import gleam/string
import gleam/time/calendar
import gleam/time/timestamp
import scoutbox/platform/input
import scoutbox/rows/id
import scoutbox/rows/orgs
import scoutbox/rows/ver_admins
import scoutbox/rows/ver_claims.{type Status}
import scoutbox/rows/ver_evidence
import scoutbox/vocab/actor_kind.{type ActorKind}
import scoutbox/vocab/claim_type.{type ClaimType}
import scoutbox/vocab/ver_code.{type VerCode}
import scoutbox/vocab/ver_level.{type VerLevel}
import scoutbox/vocab/verification_method.{type VerificationMethod}

pub type Claim =
  ver_claims.Row

/// VERIFICATION_LIMITS.reason
const reason_max = 600

// ------------------------------------------------------------------------------------------- state machine

/// CLAIM_TRANSITIONS (repositories/verification.ts): where a claim may move from each status.
pub fn transitions(from: Status) -> List(Status) {
  case from {
    ver_claims.Unverified -> [ver_claims.CollectingEvidence, ver_claims.Pending]
    ver_claims.CollectingEvidence -> [ver_claims.Pending, ver_claims.Unverified]
    ver_claims.Pending -> [
      ver_claims.AutomatedChecksPassed,
      ver_claims.RequiresHumanReview,
      ver_claims.Rejected,
      ver_claims.CollectingEvidence,
    ]
    ver_claims.AutomatedChecksPassed -> [
      ver_claims.Verified,
      ver_claims.RequiresHumanReview,
      ver_claims.Rejected,
      ver_claims.CollectingEvidence,
    ]
    ver_claims.RequiresHumanReview -> [
      ver_claims.Verified,
      ver_claims.Rejected,
      ver_claims.CollectingEvidence,
      ver_claims.Suspended,
    ]
    ver_claims.Verified -> [
      ver_claims.Expired,
      ver_claims.Suspended,
      ver_claims.Revoked,
      ver_claims.Disputed,
      ver_claims.Superseded,
    ]
    // Reconfirmation restarts the pipeline.
    ver_claims.Expired -> [ver_claims.Pending]
    // Reinstate or revoke: Trust & Safety or policy only.
    ver_claims.Suspended -> [ver_claims.Verified, ver_claims.Revoked]
    ver_claims.Disputed -> [
      ver_claims.Verified,
      ver_claims.Suspended,
      ver_claims.Revoked,
    ]
    // Terminal: a resubmission is a new claim.
    ver_claims.Rejected -> []
    // Reinstated where policy permits (Trust & Safety only, audited).
    ver_claims.Revoked -> [ver_claims.Verified]
    ver_claims.Superseded -> []
  }
}

pub fn can_transition(from: Status, to: Status) -> Bool {
  list.contains(transitions(from), to)
}

/// Methods that may accompany a move into `verified`. `document_submitted` is evidence collection, not one.
pub fn authoritative(method: VerificationMethod) -> Bool {
  case method {
    verification_method.OfficialDomainEmail
    | verification_method.OrganisationAdminConfirmation
    | verification_method.AuthoritativeRegistry
    | verification_method.FederationConfirmation
    | verification_method.ExistingVerifiedOrgAdmin
    | verification_method.ScoutboxManualReview
    | verification_method.Migration -> True
    verification_method.DocumentSubmitted
    | verification_method.ReferenceConfirmation -> False
  }
}

pub type TransitionError {
  AlreadyInState
  IllegalTransition
  MethodNotAuthoritative
  DomainControlInsufficient
  ReasonRequired
}

pub fn transition_error_code(e: TransitionError) -> String {
  case e {
    AlreadyInState -> "ALREADY_IN_STATE"
    IllegalTransition -> "ILLEGAL_TRANSITION"
    MethodNotAuthoritative -> "METHOD_NOT_AUTHORITATIVE"
    DomainControlInsufficient -> "DOMAIN_CONTROL_INSUFFICIENT"
    ReasonRequired -> "REASON_REQUIRED"
  }
}

/// Who moves a claim, by what method, and why.
pub type By {
  By(
    actor_kind: Option(ActorKind),
    actor_id: Option(String),
    method: Option(VerificationMethod),
    reason: Option(String),
  )
}

pub const nobody =
  By(actor_kind: None, actor_id: None, method: None, reason: None)

/// The claim moved to `to`, with the fields the move sets (transitionChanges + applyTransition).
pub fn transition(
  claim: Claim,
  to: Status,
  by: By,
  now: Int,
) -> Result(Claim, TransitionError) {
  let method = option.or(by.method, claim.verification_method)
  let reason = input.filled(by.reason)
  let verifying = to == ver_claims.Verified
  use <- refuse_if(claim.status == to, AlreadyInState)
  use <- refuse_if(!can_transition(claim.status, to), IllegalTransition)
  use <- refuse_if(
    verifying && !{ option.map(method, authoritative) |> option.unwrap(False) },
    MethodNotAuthoritative,
  )
  // Domain control alone does not prove employment or identity.
  use <- refuse_if(
    verifying
      && method == Some(verification_method.OfficialDomainEmail)
      && claim.claim_type != claim_type.OrganisationDomain,
    DomainControlInsufficient,
  )
  use <- refuse_if(
    list.contains(
      [ver_claims.Revoked, ver_claims.Suspended, ver_claims.Rejected],
      to,
    )
      && reason == None,
    ReasonRequired,
  )
  let why = option.map(reason, input.utf16_take(_, reason_max))
  let claim = ver_claims.Row(..claim, status: to, updated_at: now)
  Ok(case to {
    ver_claims.Verified ->
      ver_claims.Row(
        ..claim,
        verification_method: method,
        verified_at: option.or(claim.verified_at, Some(now)),
        verified_by_kind: Some(option.unwrap(by.actor_kind, actor_kind.System)),
        verified_by_id: by.actor_id,
        suspended_at: None,
        disputed_at: None,
      )
    ver_claims.Revoked ->
      ver_claims.Row(
        ..claim,
        revoked_at: Some(now),
        revoked_by_kind: by.actor_kind,
        revoked_by_id: by.actor_id,
        revocation_reason: why,
        current: False,
      )
    ver_claims.Suspended ->
      ver_claims.Row(..claim, suspended_at: Some(now), suspend_reason: why)
    ver_claims.Disputed -> ver_claims.Row(..claim, disputed_at: Some(now))
    ver_claims.Expired -> ver_claims.Row(..claim, expired_at: Some(now))
    ver_claims.Superseded -> ver_claims.Row(..claim, current: False)
    _ -> claim
  })
}

fn refuse_if(
  refused: Bool,
  error: e,
  next: fn() -> Result(a, e),
) -> Result(a, e) {
  case refused {
    True -> Error(error)
    False -> next()
  }
}

// ------------------------------------------------------------------------------------ effective engine

/// Why a claim does not display as currently verified.
pub type EffectiveReason {
  ValidUntilPassed
  SubjectAccountInactive
  OrganisationMissing
  OrganisationSuspended
  OrganisationRevoked
}

pub fn effective_reason_code(r: EffectiveReason) -> String {
  case r {
    ValidUntilPassed -> "VALID_UNTIL_PASSED"
    SubjectAccountInactive -> "SUBJECT_ACCOUNT_INACTIVE"
    OrganisationMissing -> "ORGANISATION_MISSING"
    OrganisationSuspended -> "ORGANISATION_SUSPENDED"
    OrganisationRevoked -> "ORGANISATION_REVOKED"
  }
}

pub type Effective {
  Effective(
    status: Status,
    displayable: Bool,
    current: Bool,
    historical: Bool,
    reasons: List(EffectiveReason),
  )
}

/// A claim displays as verified only if every condition holds at read time. Expiry applies to current claims: a
/// closed period stays a verified past fact. `valid_until` is exclusive. A closed verified period stays displayable
/// as history after the person left, unless the organisation's verification was revoked (fraud stops lending
/// history).
pub fn effective_status(
  claim: Claim,
  org org: Option(orgs.Row),
  subject_removed subject_removed: Bool,
  now now: Int,
) -> Effective {
  let expired =
    claim.status == ver_claims.Verified
    && claim.current
    && case claim.valid_until {
      Some(until) -> now >= until
      None -> False
    }
  let status = case expired {
    True -> ver_claims.Expired
    False -> claim.status
  }
  let org_reasons = case claim.organisation_id {
    None -> []
    Some(_) ->
      case org {
        None -> [OrganisationMissing]
        Some(o) ->
          list.append(
            when(o.suspended, OrganisationSuspended),
            when(o.verification_revoked_at != None, OrganisationRevoked),
          )
      }
  }
  let reasons =
    list.flatten([
      when(expired, ValidUntilPassed),
      when(subject_removed && claim.current, SubjectAccountInactive),
      org_reasons,
    ])
  let verified_now = status == ver_claims.Verified && reasons == []
  let verified_historical =
    status == ver_claims.Verified
    && !claim.current
    && present(claim.valid_until)
    && !list.contains(reasons, OrganisationRevoked)
  let current = verified_now && claim.current
  Effective(
    status:,
    displayable: verified_now || verified_historical,
    current:,
    historical: verified_historical && !current,
    reasons:,
  )
}

fn when(condition: Bool, value: a) -> List(a) {
  case condition {
    True -> [value]
    False -> []
  }
}

/// A JavaScript-truthy instant: set and not zero.
fn present(ms: Option(Int)) -> Bool {
  case ms {
    Some(0) | None -> False
    Some(_) -> True
  }
}

// ---------------------------------------------------------------------------------- email and domains

pub type EmailProblem {
  EmailSyntax
  EmailTooLong
}

pub fn email_problem_code(p: EmailProblem) -> String {
  case p {
    EmailSyntax -> "EMAIL_SYNTAX"
    EmailTooLong -> "EMAIL_TOO_LONG"
  }
}

/// JavaScript's `\s`, which PCRE's differs from.
const js_space =
  "\\t\\n\\x{0B}\\f\\r \\x{A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}"

pub fn email_problem(email: String) -> Option(EmailProblem) {
  let e = string.trim(email)
  let assert Ok(shape) =
    regexp.compile(
      "^[^@"
        <> js_space
        <> "]+@[^@"
        <> js_space
        <> "]+\\.[^@"
        <> js_space
        <> "]{2,}$",
      regexp.Options(case_insensitive: False, multi_line: False),
    )
  case regexp.check(shape, e), input.utf16_length(e) > 254 {
    False, _ -> Some(EmailSyntax)
    True, True -> Some(EmailTooLong)
    True, False -> None
  }
}

/// `https://www.Club.com/x` → `club.com`.
pub fn normalize_domain(domain: String) -> String {
  let d = domain |> string.trim |> string.lowercase
  let d = case d {
    "https://" <> rest | "http://" <> rest -> rest
    _ -> d
  }
  let d = case d {
    "www." <> rest -> rest
    _ -> d
  }
  d |> before("/") |> before(":")
}

fn before(s: String, separator: String) -> String {
  case string.split_once(s, separator) {
    Ok(#(head, _)) -> head
    Error(Nil) -> s
  }
}

pub fn domain_of_email(email: String) -> String {
  case string.split(email, "@") {
    [_, domain, ..] -> normalize_domain(domain)
    _ -> ""
  }
}

pub fn is_free_mail(domain: String) -> Bool {
  let assert Ok(free) =
    regexp.compile(
      "^(gmail|googlemail|hotmail|outlook|yahoo|icloud|aol|proton|protonmail|gmx|live|msn|mail|yandex|zoho)\\.",
      regexp.Options(case_insensitive: True, multi_line: False),
    )
  let d = normalize_domain(domain)
  regexp.check(free, d <> ".") || regexp.check(free, d)
}

const disposable_domains = [
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.dev",
  "yopmail.com", "sharklasers.com", "trashmail.com", "dispostable.com",
]

pub fn is_disposable(domain: String) -> Bool {
  list.contains(disposable_domains, normalize_domain(domain))
}

/// True when `candidate` is the organisation's domain or a subdomain of it.
pub fn domain_covered(candidate: String, org_domain: String) -> Bool {
  let c = normalize_domain(candidate)
  let o = normalize_domain(org_domain)
  c != "" && o != "" && { c == o || string.ends_with(c, "." <> o) }
}

// --------------------------------------------------------------------------------------- risk signals

/// What is known about an application when its risk is read.
pub type Risk {
  Risk(
    email: Option(String),
    org_domains: List(String),
    applicant_had_recent_revocation: Bool,
    duplicate_evidence_hash: Bool,
    competing_org_claims: Int,
    org_suspended: Bool,
    conflicting_active_roles: Int,
    requests_last_day: Int,
    actor_is_subject: Bool,
    email_challenge_fails: Int,
    credential_reused_by_others: Bool,
  )
}

pub const no_risk =
  Risk(
    email: None,
    org_domains: [],
    applicant_had_recent_revocation: False,
    duplicate_evidence_hash: False,
    competing_org_claims: 0,
    org_suspended: False,
    conflicting_active_roles: 0,
    requests_last_day: 0,
    actor_is_subject: False,
    email_challenge_fails: 0,
    credential_reused_by_others: False,
  )

/// Signals, not conclusions: nothing downstream may describe a flag as fraud, and no flag alone rejects anything.
pub fn risk_flags(r: Risk) -> List(VerCode) {
  let email = input.filled(r.email)
  let has_email = email != None
  let domain = domain_of_email(option.unwrap(email, ""))
  list.flatten([
    when(has_email && is_disposable(domain), ver_code.DisposableEmail),
    when(has_email && is_free_mail(domain), ver_code.FreeEmailProvider),
    when(
      has_email
        && r.org_domains != []
        && !list.any(r.org_domains, domain_covered(domain, _)),
      ver_code.OrgDomainMismatch,
    ),
    when(r.email_challenge_fails >= 3, ver_code.RepeatedEmailChallengeFailures),
    when(r.competing_org_claims > 0, ver_code.CompetingOrganisationClaims),
    when(r.credential_reused_by_others, ver_code.CredentialReusedAcrossUsers),
    when(r.duplicate_evidence_hash, ver_code.DuplicateEvidenceHash),
    when(r.applicant_had_recent_revocation, ver_code.RecentRevocationReapply),
    when(r.org_suspended, ver_code.OrganisationSuspended),
    when(r.conflicting_active_roles > 0, ver_code.ConflictingActiveRoles),
    when(r.requests_last_day >= 25, ver_code.UnusualMassActivity),
    when(r.actor_is_subject, ver_code.SelfVerificationAttempt),
  ])
}

// --------------------------------------------------------------------------------- human-review decision

pub type RegistryAnswer {
  RegistryMatch
  RegistryAmbiguous
}

pub fn registry_answer_code(a: RegistryAnswer) -> String {
  case a {
    RegistryMatch -> "match"
    RegistryAmbiguous -> "ambiguous"
  }
}

/// What a review decision is made from.
pub type Case {
  Case(
    claim_type: Option(ClaimType),
    org_has_active_authority: Bool,
    is_first_org_admin: Bool,
    duplicate_org: Bool,
    conflicting_evidence: Bool,
    identity_mismatch: Bool,
    domain_ambiguous: Bool,
    registry_result: Option(RegistryAnswer),
    disputed: Bool,
    high_risk_admin_change: Bool,
    manual_exception: Bool,
    risk_flag_count: Int,
    document_only: Bool,
  )
}

pub const plain_case =
  Case(
    claim_type: None,
    org_has_active_authority: False,
    is_first_org_admin: False,
    duplicate_org: False,
    conflicting_evidence: False,
    identity_mismatch: False,
    domain_ambiguous: False,
    registry_result: None,
    disputed: False,
    high_risk_admin_change: False,
    manual_exception: False,
    risk_flag_count: 0,
    document_only: False,
  )

pub type Decision {
  RequiresHumanReview
  CanAutoComplete
}

pub fn decision_code(d: Decision) -> String {
  case d {
    RequiresHumanReview -> "REQUIRES_HUMAN_REVIEW"
    CanAutoComplete -> "CAN_AUTO_COMPLETE"
  }
}

pub type Review {
  Review(decision: Decision, reasons: List(VerCode))
}

/// "Auto" means no Trust & Safety human is needed: an authorised organisation administrator confirming their own
/// staff is the authoritative source, not a fallback.
pub fn decide_review(c: Case) -> Review {
  let affiliation_like = case c.claim_type {
    Some(claim_type.ClubAffiliation)
    | Some(claim_type.ClubRole)
    | Some(claim_type.AgencyAffiliation)
    | Some(claim_type.AgencyRole)
    | Some(claim_type.GrassrootsAffiliation)
    | Some(claim_type.FederationAffiliation) -> True
    _ -> False
  }
  let document_claim = case c.claim_type {
    Some(claim_type.PersonIdentity) | Some(claim_type.Licence) -> True
    _ -> False
  }
  let reasons =
    list.flatten([
      when(c.is_first_org_admin, ver_code.RootOrganisationBootstrap),
      when(c.duplicate_org, ver_code.DuplicateOrganisation),
      when(c.conflicting_evidence, ver_code.ConflictingEvidence),
      when(c.identity_mismatch, ver_code.IdentityMismatch),
      when(c.domain_ambiguous, ver_code.DomainOwnershipAmbiguous),
      when(
        c.registry_result == Some(RegistryAmbiguous),
        ver_code.RegistryAmbiguousMatch,
      ),
      when(c.disputed, ver_code.DisputedClaim),
      when(c.high_risk_admin_change, ver_code.HighRiskAdminChange),
      when(c.manual_exception, ver_code.ManualExceptionRequested),
      when(c.risk_flag_count >= 3, ver_code.SuspectedFraudSignals),
      when(
        affiliation_like && !c.org_has_active_authority,
        ver_code.NoAuthoritativeSource,
      ),
      when(
        document_claim
          && c.document_only
          && c.registry_result != Some(RegistryMatch),
        ver_code.DocumentAuthenticityUnconfirmed,
      ),
    ])
  Review(
    decision: case reasons {
      [] -> CanAutoComplete
      _ -> RequiresHumanReview
    },
    reasons:,
  )
}

// ------------------------------------------------------------------------------------------- evidence

/// EVIDENCE_MAX_BYTES
pub const evidence_max_bytes = 8_388_608

pub type FileProblem {
  FileTypeNotAllowed
  FileTooLarge
  FilenameInvalid
  FileContentUnrecognised
  FileSignatureMismatch
}

pub fn file_problem_code(p: FileProblem) -> String {
  case p {
    FileTypeNotAllowed -> "FILE_TYPE_NOT_ALLOWED"
    FileTooLarge -> "FILE_TOO_LARGE"
    FilenameInvalid -> "FILENAME_INVALID"
    FileContentUnrecognised -> "FILE_CONTENT_UNRECOGNISED"
    FileSignatureMismatch -> "FILE_SIGNATURE_MISMATCH"
  }
}

/// An evidence file as sent: the claimed type and name, its size, and its bytes when they are in play.
pub type File {
  File(mime: String, bytes: Int, filename: String, buffer: Option(BitArray))
}

/// The format the leading bytes say a file is. The claimed type and extension are the sender's; the bytes are not.
/// Format identification only, not malware scanning.
pub fn sniff_file_signature(bytes: BitArray) -> Option(ver_evidence.Mime) {
  case bit_array.byte_size(bytes) >= 12, bytes {
    False, _ -> None
    True, <<"%PDF-", _:bits>> -> Some(ver_evidence.ApplicationPdf)
    True, <<0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, _:bits>> ->
      Some(ver_evidence.ImagePng)
    True, <<0xff, 0xd8, 0xff, _:bits>> -> Some(ver_evidence.ImageJpeg)
    True, <<"RIFF", _:bytes-size(4), "WEBP", _:bits>> ->
      Some(ver_evidence.ImageWebp)
    True, _ -> None
  }
}

pub fn evidence_file_problem(file: File) -> Option(FileProblem) {
  let assert Ok(traversal) = regexp.from_string("[\\\\/]|\\.\\.")
  let assert Ok(executable) =
    regexp.compile(
      "\\.(exe|js|sh|bat|cmd|com|scr|msi|dll|svg|html?)$",
      regexp.Options(case_insensitive: True, multi_line: False),
    )
  let claimed = list.key_find(ver_evidence.mime_pairs, file.mime)
  case claimed {
    Error(Nil) -> Some(FileTypeNotAllowed)
    Ok(claimed) ->
      case file.bytes <= 0 || file.bytes > evidence_max_bytes {
        True -> Some(FileTooLarge)
        False ->
          case
            regexp.check(traversal, file.filename),
            regexp.check(executable, file.filename)
          {
            True, _ -> Some(FilenameInvalid)
            _, True -> Some(FileTypeNotAllowed)
            False, False ->
              case option.map(file.buffer, sniff_file_signature) {
                None -> None
                Some(None) -> Some(FileContentUnrecognised)
                Some(Some(detected)) if detected != claimed ->
                  Some(FileSignatureMismatch)
                Some(Some(_)) -> None
              }
          }
      }
  }
}

pub type Completeness {
  Completeness(complete: Bool, missing: List(ver_evidence.Type))
}

/// Whether a claim has the evidence its type needs before it is submitted.
pub fn evidence_completeness(
  claim_type: ClaimType,
  have: List(ver_evidence.Type),
) -> Completeness {
  let need = case claim_type {
    claim_type.PersonIdentity
    | claim_type.OrganisationIdentity
    | claim_type.Licence -> [ver_evidence.Document]
    claim_type.ClubAffiliation
    | claim_type.ClubRole
    | claim_type.AgencyAffiliation
    | claim_type.AgencyRole
    | claim_type.OrganisationDomain -> [ver_evidence.OfficialEmail]
    claim_type.GrassrootsAffiliation
    | claim_type.FederationAffiliation
    | claim_type.OrganisationAdmin -> []
  }
  let missing = list.filter(need, fn(t) { !list.contains(have, t) })
  Completeness(complete: missing == [], missing:)
}

// -------------------------------------------------------------------------- administrator hierarchy

fn rank(level: VerLevel) -> Int {
  case level {
    ver_level.VerificationViewer -> 0
    ver_level.VerificationReviewer -> 1
    ver_level.VerificationAdmin -> 2
    ver_level.VerificationRootAdmin -> 3
  }
}

/// The highest active verification level `user_id` holds at `org_id`.
pub fn ver_level_for(
  admins: List(ver_admins.Row),
  org_id: id.OrgId,
  user_id: id.OrgUserId,
) -> Option(VerLevel) {
  admins
  |> list.filter(fn(a) {
    a.org_id == org_id && a.user_id == user_id && a.status == ver_admins.Active
  })
  |> list.fold(None, fn(best, a) {
    case best {
      Some(b) ->
        case rank(a.level) > rank(b) {
          True -> Some(a.level)
          False -> best
        }
      None -> Some(a.level)
    }
  })
}

pub fn has_ver_level(
  admins: List(ver_admins.Row),
  org_id: id.OrgId,
  user_id: id.OrgUserId,
  at_least: VerLevel,
) -> Bool {
  case ver_level_for(admins, org_id, user_id) {
    Some(level) -> rank(level) >= rank(at_least)
    None -> False
  }
}

// ---------------------------------------------------------------------------- organisation lifecycle

pub type OrgStatus {
  OrgUnverified
  OrgPending
  OrgVerified
  OrgSuspended
  OrgRevoked
}

pub fn org_status_code(s: OrgStatus) -> String {
  case s {
    OrgUnverified -> "unverified"
    OrgPending -> "pending"
    OrgVerified -> "verified"
    OrgSuspended -> "suspended"
    OrgRevoked -> "revoked"
  }
}

/// `pending`: whether a root application is still open.
pub fn org_verification_status(
  org: Option(orgs.Row),
  pending: Bool,
) -> OrgStatus {
  case org {
    None -> OrgUnverified
    Some(o) if o.verification_revoked_at != None -> OrgRevoked
    Some(o) if o.suspended -> OrgSuspended
    Some(o) if o.verified -> OrgVerified
    Some(_) if pending -> OrgPending
    Some(_) -> OrgUnverified
  }
}

/// Whether an organisation can currently mint new effective verified affiliation claims.
pub fn org_can_attest(org: Option(orgs.Row), pending: Bool) -> Bool {
  org_verification_status(org, pending) == OrgVerified
}

// ------------------------------------------------------------------------------------ public projection

/// Who stands behind a verified claim.
pub type Assurance {
  /// An external authoritative source confirmed it.
  Authoritative
  /// An authorised organisation administrator confirmed it.
  OrganisationAttested
  /// ScoutBox reviewed documents; not confirmed with any issuing authority.
  ScoutboxDocumentReview
}

pub fn assurance_code(a: Assurance) -> String {
  case a {
    Authoritative -> "authoritative"
    OrganisationAttested -> "organisation_attested"
    ScoutboxDocumentReview -> "scoutbox_document_review"
  }
}

pub fn assurance_for_claim(claim: Claim) -> Option(Assurance) {
  case claim.verification_method {
    Some(verification_method.AuthoritativeRegistry)
    | Some(verification_method.FederationConfirmation) -> Some(Authoritative)
    // Authoritative for what it proves: domain control only.
    Some(verification_method.OfficialDomainEmail) -> Some(Authoritative)
    Some(verification_method.OrganisationAdminConfirmation)
    | Some(verification_method.ExistingVerifiedOrgAdmin) ->
      Some(OrganisationAttested)
    // Carried-forward facts trace back to a ScoutBox review.
    Some(verification_method.ScoutboxManualReview)
    | Some(verification_method.Migration) -> Some(ScoutboxDocumentReview)
    _ -> None
  }
}

pub fn claim_provenance_label(
  claim: Claim,
  org_name: Option(String),
) -> String {
  let org = option.unwrap(org_name, "organisation")
  case claim.claim_type, claim.verification_method {
    // A manual review of a licence document must not read like an issuing-authority confirmation.
    claim_type.Licence, Some(verification_method.ScoutboxManualReview) ->
      "Document reviewed by ScoutBox Trust & Safety — not independently confirmed with the issuing authority."
    _, Some(verification_method.OrganisationAdminConfirmation) ->
      "Confirmed by an authorised " <> org <> " administrator"
    _, Some(verification_method.ExistingVerifiedOrgAdmin) ->
      "Confirmed by an existing verified " <> org <> " administrator"
    _, Some(verification_method.AuthoritativeRegistry) ->
      "Confirmed against an authoritative registry"
    _, Some(verification_method.FederationConfirmation) ->
      "Confirmed by the governing federation"
    _, Some(verification_method.OfficialDomainEmail) ->
      "Confirmed control of the official organisation domain"
    _, Some(verification_method.ScoutboxManualReview) ->
      "Reviewed and confirmed by ScoutBox Trust & Safety"
    _, Some(verification_method.Migration) ->
      "Carried forward from a previously established ScoutBox verification"
    _, _ -> "Not independently verified"
  }
}

fn badge_kind(t: ClaimType) -> String {
  case t {
    claim_type.PersonIdentity -> "identity"
    claim_type.OrganisationIdentity -> "organisation"
    claim_type.OrganisationDomain -> "domain"
    claim_type.OrganisationAdmin -> "admin"
    claim_type.ClubRole | claim_type.AgencyRole -> "role"
    claim_type.Licence -> "licence"
    claim_type.ClubAffiliation
    | claim_type.AgencyAffiliation
    | claim_type.GrassrootsAffiliation
    | claim_type.FederationAffiliation -> "affiliation"
  }
}

pub fn badge_label(
  claim: Claim,
  org: Option(orgs.Row),
  effective: Effective,
) -> String {
  let org_name =
    option.map(org, fn(o) { o.name }) |> option.unwrap("organisation")
  let role = option.unwrap(claim.role, "staff")
  let licence = option.unwrap(claim.licence_type, "credential")
  case claim.claim_type {
    claim_type.OrganisationIdentity -> "Verified organisation"
    claim_type.OrganisationDomain -> "Official domain verified"
    claim_type.OrganisationAdmin ->
      "Authorised " <> org_name <> " administrator"
    claim_type.ClubAffiliation
    | claim_type.GrassrootsAffiliation
    | claim_type.FederationAffiliation
    | claim_type.AgencyAffiliation ->
      case effective.historical {
        True ->
          "Former "
          <> org_name
          <> option.map(claim.role, fn(r) { " " <> r }) |> option.unwrap("")
          <> " · Verified history"
        False -> "Verified at " <> org_name
      }
    claim_type.ClubRole | claim_type.AgencyRole ->
      case effective.historical {
        True -> "Former " <> org_name <> " " <> role <> " · Verified history"
        False -> "Role verified: " <> role
      }
    // Only an authoritative source may put "verified" next to a licence; anything else is a reviewed credential.
    claim_type.Licence ->
      case assurance_for_claim(claim) {
        Some(Authoritative) -> "Licence verified: " <> licence
        _ -> "Credential reviewed: " <> licence
      }
    claim_type.PersonIdentity -> "Verified claim"
  }
}

/// The UTC year of an instant.
fn year(ms: Int) -> Int {
  let seconds = int.floor_divide(ms, 1000) |> result_or(0)
  let #(date, _) =
    timestamp.from_unix_seconds(seconds)
    |> timestamp.to_calendar(calendar.utc_offset)
  date.year
}

fn result_or(r: Result(a, e), default: a) -> a {
  case r {
    Ok(v) -> v
    Error(_) -> default
  }
}

fn nullable_int(v: Option(Int)) -> Json {
  json.nullable(v, json.int)
}

/// Everything any client shows publicly about a subject's verification. Only displayable claims appear, and
/// nothing about emails, evidence or risk.
pub fn public_profile(
  subject_kind subject_kind: ver_claims.SubjectKind,
  subject_id subject_id: String,
  claims claims: List(Claim),
  orgs orgs: Dict(id.OrgId, orgs.Row),
  subject_removed subject_removed: Bool,
  now now: Int,
) -> Json {
  json.object(public_profile_fields(
    subject_kind:,
    subject_id:,
    claims:,
    orgs:,
    subject_removed:,
    now:,
  ))
}

/// The public profile's fields, for a view that adds its own.
pub fn public_profile_fields(
  subject_kind subject_kind: ver_claims.SubjectKind,
  subject_id subject_id: String,
  claims claims: List(Claim),
  orgs orgs: Dict(id.OrgId, orgs.Row),
  subject_removed subject_removed: Bool,
  now now: Int,
) -> List(#(String, Json)) {
  let #(identity, badges) =
    list.fold(claims, #(None, []), fn(acc, claim) {
      let #(identity, badges) = acc
      let org = case claim.organisation_id {
        Some(id) -> dict.get(orgs, id) |> option.from_result
        None -> None
      }
      let eff = effective_status(claim, org:, subject_removed:, now:)
      case eff.displayable, claim.claim_type {
        False, _ -> acc
        // A manual document review must be distinguishable from an authoritative identity provider.
        True, claim_type.PersonIdentity -> {
          let assurance = assurance_for_claim(claim)
          let #(label, provenance) = case assurance {
            Some(Authoritative) -> #(
              "Identity confirmed by an authoritative provider",
              claim_provenance_label(claim, option.map(org, fn(o) { o.name })),
            )
            _ -> #(
              "Identity confirmed by ScoutBox review",
              "Reviewed and confirmed by ScoutBox Trust & Safety — a document review, not an authoritative identity check",
            )
          }
          #(
            Some(
              json.object([
                #("confirmed", json.bool(True)),
                #("assurance", json.nullable(assurance, assurance_json)),
                #("label", json.string(label)),
                #("verifiedAt", nullable_int(claim.verified_at)),
                #("provenance", json.string(provenance)),
              ]),
            ),
            badges,
          )
        }
        True, _ -> {
          let badge =
            json.object([
              #("kind", json.string(badge_kind(claim.claim_type))),
              #("claimType", claim_type.to_json(claim.claim_type)),
              #("label", json.string(badge_label(claim, org, eff))),
              #(
                "organisation",
                json.nullable(org, fn(o) {
                  json.object([
                    #("id", id.org_json(o.id)),
                    #("name", json.string(o.name)),
                  ])
                }),
              ),
              #("role", json.nullable(claim.role, json.string)),
              #("current", json.bool(eff.current)),
              #("historical", json.bool(eff.historical)),
              #(
                "assurance",
                json.nullable(assurance_for_claim(claim), assurance_json),
              ),
              #("period", case claim.valid_from {
                Some(from) if from != 0 ->
                  json.object([
                    #("from", json.int(year(from))),
                    #("to", case claim.valid_until {
                      Some(until) if until != 0 -> json.int(year(until))
                      _ -> json.null()
                    }),
                  ])
                _ -> json.null()
              }),
              #("verifiedAt", nullable_int(claim.verified_at)),
              #(
                "provenance",
                json.string(claim_provenance_label(
                  claim,
                  option.map(org, fn(o) { o.name }),
                )),
              ),
            ])
          #(identity, [badge, ..badges])
        }
      }
    })
  // identityVerified is for existing clients; `identity` is the full representation.
  [
    #("subjectType", ver_claims.subject_kind_to_json(subject_kind)),
    #("subjectId", json.string(subject_id)),
    #("identityVerified", json.bool(identity != None)),
    #("identity", option.unwrap(identity, json.null())),
    #("badges", json.preprocessed_array(list.reverse(badges))),
  ]
}

fn assurance_json(a: Assurance) -> Json {
  json.string(assurance_code(a))
}
