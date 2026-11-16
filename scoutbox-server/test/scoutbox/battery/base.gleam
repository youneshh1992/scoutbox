//// The records the generated battery tests (test/scoutbox/battery/<domain>/) start from. A recorded JavaScript
//// record names only some fields; the test updates one of these with them. Each field here stands for "not given":
//// None, False, zero or a placeholder, whichever the TypeScript rule reads an absent field as.

import gleam/option.{None}
import scoutbox/rows/orgs
import scoutbox/rows/ver_admins
import scoutbox/rows/ver_claims
import scoutbox/vocab/claim_type
import scoutbox/vocab/org_type
import scoutbox/vocab/ver_level

/// A current, unverified claim about a user, with nothing else known.
pub const claim =
  ver_claims.Row(
    id: "c",
    subject_kind: ver_claims.User,
    subject_id: "u",
    claim_type: claim_type.ClubRole,
    organisation_id: None,
    role: None,
    status: ver_claims.Unverified,
    valid_from: None,
    valid_until: None,
    current: True,
    verification_method: None,
    authority_kind: None,
    authority_id: None,
    created_at: 0,
    updated_at: 0,
    verified_at: None,
    verified_by_kind: None,
    verified_by_id: None,
    revoked_at: None,
    revoked_by_kind: None,
    revoked_by_id: None,
    revocation_reason: None,
    suspended_at: None,
    suspend_reason: None,
    disputed_at: None,
    expired_at: None,
    declared_name: None,
    pair_id: None,
    requested_start: None,
    work_email: None,
    domain_control: None,
    domain_covered_by_org: None,
    domain: None,
    licence_type: None,
    issuer: None,
    identifier: None,
    holder_name: None,
    display: None,
    registry_provider: None,
    registry_state: None,
    registry_result: None,
    registry_checked_at: None,
    registry_reference: None,
    root_request_id: None,
    org_type: None,
    website: None,
    admin_level: None,
    identity_link: None,
    appointed_reason: None,
    via: None,
    flagged_at: None,
    flagged_reason: None,
    migrated_from: None,
    note: None,
    representation_id: None,
    document_reviewed: None,
    assigned_to: None,
    expiry_warned_at: None,
  )

/// An unverified, unsuspended club.
pub const org =
  orgs.Row(
    id: "o",
    name: "Org",
    type_: org_type.Club,
    level: None,
    plan: orgs.PlanPro,
    country: None,
    city: None,
    lat: None,
    lng: None,
    federation: None,
    federation_registration_id: None,
    trusted_partner: False,
    verified: False,
    verified_domain: None,
    safeguarding_contract_signed: False,
    suspended: False,
    password_hash: None,
    email_domain: None,
    email_domain_verified: False,
    mfa_required_for_leads: False,
    verification_revoked_at: None,
    created_at: 0,
  )

/// An active viewer grant.
pub const admin =
  ver_admins.Row(
    id: "a",
    org_id: "o",
    user_id: "u",
    level: ver_level.VerificationViewer,
    status: ver_admins.Active,
    invited_by: "system",
    created_at: 0,
    accepted_at: None,
    revoked_at: None,
    revoked_by: None,
  )
