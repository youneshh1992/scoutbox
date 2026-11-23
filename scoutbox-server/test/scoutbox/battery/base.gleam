//// The records the generated battery tests (test/scoutbox/battery/<domain>/) start from. A recorded JavaScript
//// record names only some fields; the test updates one of these with them. Each field here stands for "not given":
//// None, False, zero or a placeholder, whichever the TypeScript rule reads an absent field as.

import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{None, Some}
import scoutbox/platform/temporal
import scoutbox/platform/zones
import scoutbox/recruitment/cases
import scoutbox/recruitment/contact_rules
import scoutbox/recruitment/trial_rules
import scoutbox/rows/agency_affiliations
import scoutbox/rows/agent_profile_facets
import scoutbox/rows/agent_profiles
import scoutbox/rows/case_budget_fx_assumptions
import scoutbox/rows/case_budget_lines
import scoutbox/rows/case_history
import scoutbox/rows/development_actions
import scoutbox/rows/development_evidence_links
import scoutbox/rows/development_goals
import scoutbox/rows/development_reviews
import scoutbox/rows/id
import scoutbox/rows/orgs
import scoutbox/rows/recruitment_briefs
import scoutbox/rows/recruitment_cases
import scoutbox/rows/recruitment_contacts
import scoutbox/rows/representation_agreements
import scoutbox/rows/ver_admins
import scoutbox/rows/ver_claims
import scoutbox/vocab/agent_facet
import scoutbox/vocab/brief_status
import scoutbox/vocab/claim_type
import scoutbox/vocab/contact_mode
import scoutbox/vocab/currency
import scoutbox/vocab/evidence_source
import scoutbox/vocab/facet_state
import scoutbox/vocab/goal_category
import scoutbox/vocab/goal_status
import scoutbox/vocab/jurisdiction
import scoutbox/vocab/org_type
import scoutbox/vocab/room_status.{type RoomStatus}
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

/// A Development Review: a coach review of no plan, written by nobody, never shared.
pub fn dev_review() -> development_reviews.Row {
  development_reviews.new(
    id: id.dev_review(""),
    plan_id: id.dev_plan(""),
    player_id: id.player(""),
    reviewer_kind: development_reviews.CoachReview,
    reviewed_by_kind: development_reviews.Org,
    reviewed_by_id: "",
    reviewed_at: 0,
    created_at: 0,
    share_summary: False,
    share_goals: False,
    share_actions: False,
  )
}

/// A Development goal of no plan: an untitled technical goal not started, with no target, made by nobody.
pub fn dev_goal() -> development_goals.Row {
  development_goals.new(
    id: id.dev_goal(""),
    plan_id: id.dev_plan(""),
    player_id: id.player(""),
    title: "",
    category: goal_category.Technical,
    status: goal_status.NotStarted,
    created_by_kind: development_goals.Org,
    created_by_id: "",
    created_at: 0,
    updated_at: 0,
    rev: 1,
  )
}

/// A Development action of no goal: an untitled training action to do, made by nobody.
pub fn dev_action() -> development_actions.Row {
  development_actions.new(
    id: id.dev_action(""),
    plan_id: id.dev_plan(""),
    goal_id: id.dev_goal(""),
    player_id: id.player(""),
    type_: development_actions.Training,
    title: "",
    status: development_actions.Todo,
    created_by_kind: development_actions.Org,
    created_by_id: "",
    created_at: 0,
    updated_at: 0,
  )
}

/// An evidence link of no goal or action: an assessment of no id, linked by nobody.
pub fn dev_link() -> development_evidence_links.Row {
  development_evidence_links.new(
    id: id.dev_link(""),
    plan_id: id.dev_plan(""),
    player_id: id.player(""),
    source_type: evidence_source.Assessment,
    source_id: "",
    linked_by_kind: development_evidence_links.Org,
    linked_by_id: "",
    linked_at: 0,
  )
}

/// A budget line of no scenario: an unconfirmed one-off wage of nothing, in GBP.
pub fn budget_line() -> case_budget_lines.Row {
  case_budget_lines.new(
    case_id: id.recruitment_case(""),
    scenario_id: id.budget_scenario(""),
    position: 0,
    id: id.budget_line(""),
    kind: case_budget_lines.Wage,
    label: "",
    amount_minor: 0,
    currency: currency.GBP,
    schedule: case_budget_lines.OneOff,
    confirmed: False,
  )
}

/// A stated rate of no scenario: GBP to GBP at 1, undated.
pub fn budget_fx() -> case_budget_fx_assumptions.Row {
  case_budget_fx_assumptions.new(
    case_id: id.recruitment_case(""),
    scenario_id: id.budget_scenario(""),
    position: 0,
    from_currency: currency.GBP,
    to_currency: currency.GBP,
    rate: "1",
    date: "",
    manual: True,
  )
}

/// A draft brief with no window, nothing else known: a recorded brief names its status and window.
pub fn brief() -> recruitment_briefs.Row {
  recruitment_briefs.new(
    id: id.brief("brf-base"),
    org_id: id.org("org-base"),
    title: "",
    version: 1,
    status: brief_status.Draft,
    created_by_user_id: id.org_user("u-base"),
    created_at: 0,
    updated_at: 0,
    rev: 1,
  )
}

/// A request body as the route reads it, from its JSON text.
pub fn body(text: String) -> Dynamic {
  let assert Ok(d) = json.parse(text, decode.dynamic)
  d
}

/// A real calendar day the recording names (the printer refuses text that isn't one), whatever its year.
pub fn day(text: String) -> temporal.Day {
  let assert Ok(d) = temporal.parse_day_between(text, 0, 9999)
  d
}

/// A zone the recording names (the printer refuses a name the table doesn't know).
pub fn zone(name: String) -> zones.Zone {
  let assert Ok(z) = zones.parse(name)
  z
}

/// A trial rule's refusal as the TypeScript rule reports one: its error, its message and its other fields as JSON.
pub fn trial_refusal(r: trial_rules.Refusal) -> #(String, String, String) {
  #(r.error, r.message, json.to_string(json.object(r.fields)))
}

/// A drafted in-app contact with nothing else known: a recorded contact names its parties, channel and state.
pub fn contact() -> contact_rules.Contact {
  contact_rules.Contact(
    row: recruitment_contacts.new(
      id: id.contact("ct-base"),
      org_id: id.org("org-base"),
      case_id: id.recruitment_case("case-base"),
      player_id: id.player("pl-base"),
      status: recruitment_contacts.Draft,
      channel: recruitment_contacts.InApp,
      contact_mode: contact_mode.Both,
      created_by_user_id: id.org_user("u-base"),
      created_at: 0,
      updated_at: 0,
      rev: 1,
      policy_version: 1,
    ),
    attempts: [],
    history: [],
  )
}

/// A contact rule's refusal as the TypeScript rule reports one: its error, its message and its other fields as JSON.
pub fn contact_refusal(r: contact_rules.Refusal) -> #(String, String, String) {
  #(r.error, r.message, json.to_string(json.object(r.fields)))
}

/// A Room at `status` (rev 1), with these history entries in order: each an action and its detail as JSON text.
pub fn room(
  status: RoomStatus,
  history: List(#(String, String)),
) -> cases.Room {
  let case_id = id.recruitment_case("case-m")
  cases.Room(
    row: recruitment_cases.new(
      id: case_id,
      org_id: id.org("org-m"),
      player_id: id.player("pl-m"),
      owner_user_id: id.org_user("usr-m"),
      stage: recruitment_cases.Review,
      priority: recruitment_cases.Medium,
      restricted: False,
      created_at: 0,
    ),
    status:,
    priority: recruitment_cases.Normal,
    updated_at: 0,
    rev: 1,
    tags: [],
    assignments: [],
    tasks: [],
    history: list.index_map(history, fn(entry, i) {
      case_history.Row(
        ..case_history.new(
          case_id:,
          position: i,
          id: id.case_event("ev-" <> int.to_string(i)),
          at: 0,
          action: entry.0,
        ),
        detail_json: Some(entry.1),
      )
    }),
    request_ids: [],
    trial_ids: [],
  )
}
