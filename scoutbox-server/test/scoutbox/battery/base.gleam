//// The records the generated battery tests (test/scoutbox/battery/<domain>/) start from. A recorded JavaScript
//// record names only some fields; the test updates one of these with them. Each field here stands for "not given":
//// None, False, zero or a placeholder, whichever the TypeScript rule reads an absent field as.

import gleam/option.{None}
import scoutbox/rows/agency_affiliations
import scoutbox/rows/agent_profile_facets
import scoutbox/rows/agent_profiles
import scoutbox/rows/id
import scoutbox/rows/orgs
import scoutbox/rows/representation_agreements
import scoutbox/rows/ver_admins
import scoutbox/rows/ver_claims
import scoutbox/vocab/agent_facet
import scoutbox/vocab/claim_type
import scoutbox/vocab/facet_state
import scoutbox/vocab/jurisdiction
import scoutbox/vocab/org_type
import scoutbox/vocab/ver_level

/// A current, unverified claim about a user, with nothing else known.
pub fn claim() -> ver_claims.Row {
  ver_claims.Row(
    id: id.claim("c"),
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
}

/// An unverified, unsuspended club.
pub fn org() -> orgs.Row {
  orgs.Row(
    id: id.org("o"),
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
}

/// An active viewer grant.
pub fn admin() -> ver_admins.Row {
  ver_admins.Row(
    id: id.ver_admin("a"),
    org_id: id.org("o"),
    user_id: id.org_user("u"),
    level: ver_level.VerificationViewer,
    status: ver_admins.Active,
    invited_by: "system",
    created_at: 0,
    accepted_at: None,
    revoked_at: None,
    revoked_by: None,
  )
}

/// An agent profile with nothing declared.
pub fn agent_profile() -> agent_profiles.Row {
  agent_profiles.new(
    id: id.agent_profile("agp"),
    user_id: id.org_user("u"),
    agency_org_id: id.org("o"),
    display_name: "Agent",
    created_at: 0,
    updated_at: 0,
    rev: 1,
  )
}

/// An UNVERIFIED FIFA licence with nothing submitted (the TypeScript rules read a facet with no state as UNVERIFIED).
pub fn facet() -> agent_profile_facets.Row {
  agent_profile_facets.new(
    profile_id: id.agent_profile("agp"),
    facet: agent_facet.FifaLicence,
    member_association: jurisdiction.INT,
    state: facet_state.Unverified,
  )
}

/// A membership started at zero and never ended, with no roles.
pub fn affiliation() -> agency_affiliations.Row {
  agency_affiliations.new(
    id: id.affiliation("aff"),
    agency_org_id: id.org("o"),
    user_id: id.org_user("u"),
    started_at: 0,
    created_at: 0,
    rev: 1,
  )
}

/// An unconfirmed proposal with an open term, nothing shared and nothing disclosed.
pub fn agreement() -> representation_agreements.Row {
  representation_agreements.new(
    id: id.agreement("r"),
    agent_user_id: id.org_user("a"),
    agency_org_id: id.org("o"),
    client_kind: representation_agreements.Player,
    client_id: "p",
    jurisdiction: jurisdiction.INT,
    exclusive: False,
    term_months: 12,
    status: representation_agreements.Proposed,
    proposed_at: 0,
    share_with_agency_staff: False,
    disclosure_club_presence: False,
    disclosure_contact_routing: False,
    disclosure_trial_visibility: False,
    created_at: 0,
    rev: 1,
  )
}
