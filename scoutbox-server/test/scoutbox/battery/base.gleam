//// The records the generated battery tests (test/scoutbox/battery/<domain>/) start from. A recorded JavaScript
//// record names only some fields; the test updates one of these with them. Each field here stands for "not given":
//// None, False, zero or a placeholder, whichever the TypeScript rule reads an absent field as.

import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/key_order
import scoutbox/platform/temporal
import scoutbox/platform/zones
import scoutbox/recruitment/cases
import scoutbox/recruitment/contact_rules
import scoutbox/recruitment/decisions
import scoutbox/recruitment/offer_rules
import scoutbox/recruitment/room_records
import scoutbox/recruitment/signing_rules
import scoutbox/recruitment/trial_rules
import scoutbox/rows/agency_affiliations
import scoutbox/rows/agent_profile_facets
import scoutbox/rows/agent_profiles
import scoutbox/rows/assessments
import scoutbox/rows/case_budget_fx_assumptions
import scoutbox/rows/case_budget_lines
import scoutbox/rows/case_history
import scoutbox/rows/development_actions
import scoutbox/rows/development_evidence_links
import scoutbox/rows/development_goals
import scoutbox/rows/development_reviews
import scoutbox/rows/id
import scoutbox/rows/offer_responses
import scoutbox/rows/offer_revisions
import scoutbox/rows/orgs
import scoutbox/rows/recruitment_briefs
import scoutbox/rows/recruitment_cases
import scoutbox/rows/recruitment_contacts
import scoutbox/rows/recruitment_offers
import scoutbox/rows/representation_agreements
import scoutbox/rows/room_decisions
import scoutbox/rows/signing_documents
import scoutbox/rows/signing_packages
import scoutbox/rows/signing_revision_parties
import scoutbox/rows/signing_revisions
import scoutbox/rows/trial_attendance
import scoutbox/rows/trial_schedule_sessions
import scoutbox/rows/trials
import scoutbox/rows/ver_admins
import scoutbox/rows/ver_claims
import scoutbox/vocab/agent_facet
import scoutbox/vocab/brief_status
import scoutbox/vocab/claim_type
import scoutbox/vocab/contact_mode
import scoutbox/vocab/currency
import scoutbox/vocab/decision_outcome.{type DecisionOutcome}
import scoutbox/vocab/evidence_source
import scoutbox/vocab/facet_state
import scoutbox/vocab/goal_category
import scoutbox/vocab/goal_status
import scoutbox/vocab/jurisdiction
import scoutbox/vocab/offer_status
import scoutbox/vocab/org_type
import scoutbox/vocab/party
import scoutbox/vocab/room_status.{type RoomStatus}
import scoutbox/vocab/signing_party_type
import scoutbox/vocab/trial_session_kind
import scoutbox/vocab/trial_workflow_state
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
  let assert Ok(d) =
    json.parse(http.without_lone_surrogates(text), decode.dynamic)
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

/// A legacy trial awaiting its report, with nothing else known: a TypeScript trial without a workflow state is a
/// legacy one, and its absent rev reads as 1.
pub fn trial() -> trial_rules.Trial {
  trial_rules.Trial(
    row: trials.new(
      id: id.trial("t-base"),
      request_id: id.request("req-base"),
      player_id: id.player("pl-base"),
      org_id: id.org("org-base"),
      org_name: "Org",
      accepted_at: 0,
      status: trials.AwaitingReport,
      reminder_sent: False,
      workflow_state: trial_workflow_state.LegacyAccepted,
      rev: 1,
    ),
    sessions: [],
    revisions: [],
    attendance: [],
    history: [],
    keys: [],
    reminders: [],
    report: None,
    day: trial_rules.Day(
      staff: [],
      consents: [],
      checkins: [],
      status_events: [],
    ),
  )
}

/// A training session of the base trial with no venue or instructions.
pub fn trial_session() -> trial_schedule_sessions.Row {
  trial_schedule_sessions.new(
    trial_id: id.trial("t-base"),
    position: 0,
    id: id.trial_session("ts-base"),
    kind: trial_session_kind.Training,
    starts_at: 0,
    ends_at: 1,
  )
}

/// A manual attendance record of the base session, recorded at 0.
pub fn trial_attendance() -> trial_attendance.Row {
  trial_attendance.new(
    trial_id: id.trial("t-base"),
    position: 0,
    session_id: id.trial_session("ts-base"),
    state: trial_attendance.Attended,
    source: trial_attendance.Manual,
    recorded_at: 0,
  )
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

/// A contact's words as the contact routes read them: their shape (`contact_rules.words_check`, under the routes'
/// default code), then `validate_content`. Each is its field's JSON text, or None when the write leaves it out.
pub fn contact_content(
  subject: Option(String),
  words: Option(String),
) -> Result(contact_rules.Content, DecisionRefused) {
  let fields =
    [#("subject", subject), #("body", words)]
    |> list.filter_map(fn(f) {
      case f.1 {
        Some(v) -> Ok(json.to_string(json.string(f.0)) <> ":" <> v)
        None -> Error(Nil)
      }
    })
  let shape = {
    use s <- input.field("subject", contact_rules.words_check())
    use b <- input.field("body", contact_rules.words_check())
    input.done(#(s, b))
  }
  use #(s, b) <- result.try(
    input.parse_coded(
      shape,
      body("{" <> string.join(fields, ",") <> "}"),
      root: "body",
      codes: [],
      default: contact_rules.input_default,
    )
    |> result.map_error(fn(r) { ByShape(r.error) }),
  )
  contact_rules.validate_content(s, b)
  |> result.map_error(fn(r) {
    ByRule(
      json.to_string(
        json.object([
          #("error", json.string(r.error)),
          #("message", json.string(r.message)),
        ]),
      ),
    )
  })
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

/// An Offer with no revisions, responses, receipts or history: a recorded Offer names its parties and revisions.
pub fn offer() -> offer_rules.Offer {
  offer_rules.Offer(
    row: recruitment_offers.new(
      id: id.offer("o-base"),
      org_id: id.org("org-base"),
      case_id: id.recruitment_case("case-base"),
      player_id: id.player("pl-base"),
      type_: recruitment_offers.DirectRecruitment,
      status: offer_status.Draft,
      current_revision_id: id.offer_revision("rev-base"),
      created_at: 0,
      created_by_user_id: id.org_user("u-base"),
      updated_at: 0,
      rev: 1,
      policy_version: offer_rules.policy_version,
    ),
    revisions: [],
    responses: [],
    receipts: [],
    history: [],
    keys: [],
  )
}

/// Revision 1 of the base Offer, a draft with no terms, created at 0: a recorded revision names its number, status
/// and instants.
pub fn offer_revision() -> offer_revisions.Row {
  offer_revisions.new(
    id: id.offer_revision("rev-base"),
    offer_id: id.offer("o-base"),
    position: 0,
    revision_number: 1,
    status: offer_status.Draft,
    term_offer_type: offer_revisions.DirectRecruitment,
    created_at: 0,
    updated_at: 0,
    rev: 1,
  )
}

/// The player's acceptance of revision 1 of the base Offer: a recorded response names its revision, type and actor.
pub fn offer_response() -> offer_responses.Row {
  offer_responses.new(
    id: id.offer_response("resp-base"),
    offer_id: id.offer("o-base"),
    position: 0,
    revision_id: id.offer_revision("rev-base"),
    response_type: offer_responses.Accepted,
    actor_type: party.Player,
    actor_id: "pl-base",
    for_player_id: id.player("pl-base"),
    occurred_at: 0,
  )
}

/// An Offer rule's refusal as the TypeScript rule reports one, as JSON in its key order: the error, the field and
/// problem when it names them, the message, then its other fields.
pub fn offer_refusal(r: offer_rules.Refusal) -> String {
  let named = fn(key) { list.filter(r.fields, fn(f) { f.0 == key }) }
  let rest = list.filter(r.fields, fn(f) { f.0 != "field" && f.0 != "problem" })
  json.object(
    list.flatten([
      [#("error", json.string(r.error))],
      named("field"),
      named("problem"),
      [#("message", json.string(r.message))],
      rest,
    ]),
  )
  |> json.to_string
}

/// One field of an Offer write, read as offer_routes reads the body: `check` under the Offer contract's codes. `raw`
/// is the field's JSON text, or None when the write leaves it out; a refusal is its JSON.
pub fn offer_field(
  name: String,
  check: input.Rule(a),
  raw: Option(String),
) -> Result(a, String) {
  let text = case raw {
    Some(v) -> "{" <> json.to_string(json.string(name)) <> ":" <> v <> "}"
    None -> "{}"
  }
  let shape = {
    use v <- input.field(name, check)
    input.done(v)
  }
  input.parse_in_order(
    shape,
    body(text),
    key_order.of(text),
    root: "body",
    codes: offer_rules.input_codes,
    default: "OFFER_INPUT_INVALID",
  )
  |> result.map_error(fn(r) { json.to_string(input.refusal_json(r)) })
}

/// An Offer write's terms as validateTerms reads them: the route's shape, then the terms' own rules.
pub fn offer_terms(
  raw: Option(String),
  require_complete: Bool,
) -> Result(offer_rules.Terms, String) {
  use t <- result.try(offer_field("terms", offer_rules.terms_check(), raw))
  offer_rules.validate_terms(
    t |> option.flatten |> option.unwrap(offer_rules.no_terms),
    require_complete,
  )
  |> result.map_error(offer_refusal)
}

/// An Offer write's two messages as validateMessages reads them, each the field's JSON text or None.
pub fn offer_messages(
  recipient_message: Option(String),
  internal_note: Option(String),
) -> Result(offer_rules.Messages, String) {
  use m <- result.try(offer_field(
    "recipientMessage",
    offer_rules.message_check(),
    recipient_message,
  ))
  use n <- result.try(offer_field(
    "internalNote",
    offer_rules.message_check(),
    internal_note,
  ))
  offer_rules.validate_messages(option.flatten(m), option.flatten(n))
  |> result.map_error(offer_refusal)
}

/// An Offer write's document references as validateDocumentRefs reads them.
pub fn offer_documents(
  raw: Option(String),
) -> Result(Option(List(offer_rules.DocumentRef)), String) {
  use refs <- result.try(offer_field(
    "documents",
    offer_rules.documents_check(),
    raw,
  ))
  offer_rules.validate_documents(refs) |> result.map_error(offer_refusal)
}

/// A case's Room naming its own organisation and player: what the signing rules compare a package's references with.
pub fn kase(
  case_id: id.RecruitmentCaseId,
  org_id: id.OrgId,
  player_id: id.PlayerId,
  status: RoomStatus,
) -> cases.Room {
  let r = room(status, [])
  cases.Room(
    ..r,
    row: recruitment_cases.Row(..r.row, id: case_id, org_id:, player_id:),
  )
}

/// A DRAFT package with no revisions, created at 0: a recorded package names its parties, status and revisions.
pub fn signing_package() -> signing_rules.Package {
  signing_rules.Package(
    row: signing_packages.new(
      id: id.signing_package("spk-base"),
      org_id: id.org("org-base"),
      case_id: id.recruitment_case("case-base"),
      player_id: id.player("pl-base"),
      offer_id: id.offer("o-base"),
      offer_revision_id: "rev-base",
      status: signing_packages.Draft,
      current_revision_id: id.signing_revision("spr-base"),
      created_at: 0,
      created_by_user_id: id.org_user("u-base"),
      updated_at: 0,
    ),
    revisions: [],
    history: [],
    keys: [],
  )
}

/// Revision 1 of the base package, a draft created at 0 with no document or parties.
pub fn signing_revision() -> signing_revisions.Row {
  signing_revisions.new(
    id: id.signing_revision("spr-base"),
    package_id: id.signing_package("spk-base"),
    position: 0,
    revision_number: 1,
    status: signing_revisions.Draft,
    created_at: 0,
  )
}

/// A pending player party of the base revision, naming no one: a recorded party names its type and entities.
pub fn signing_party() -> signing_revision_parties.Row {
  signing_revision_parties.new(
    revision_id: id.signing_revision("spr-base"),
    position: 0,
    party_type: signing_party_type.Player,
  )
}

/// The base revision's document, uploaded at 0: a recorded document names its digest.
pub fn signing_document() -> signing_documents.Row {
  signing_documents.new(
    id: id.signing_document("sd-base"),
    revision_id: id.signing_revision("spr-base"),
    kind: signing_documents.Signing,
    evidence_id: id.evidence("vevd-base"),
    sha256: "",
    uploaded_at: 0,
  )
}

/// A signing rule's refusal as the TypeScript rule reports one, as JSON in its key order: the error, the field and
/// problem when it names them, the message, then its other fields.
pub fn signing_refusal(r: signing_rules.Refusal) -> String {
  offer_refusal(offer_rules.Refusal(r.error, r.message, r.fields))
}

/// How the decision contract refused one field: by the route's shape, before any rule (its code: both servers' schemas
/// refuse these under the rule's own code, so the rule's message is never sent), or by the rule (its JSON).
pub type DecisionRefused {
  ByShape(String)
  ByRule(String)
}

/// One field of a decision write, read as case_routes reads the body: `check` under the decision contract's codes.
/// `raw` is the field's JSON text, or None when the write leaves it out.
pub fn decision_field(
  name: String,
  check: input.Rule(a),
  raw: Option(String),
) -> Result(a, DecisionRefused) {
  let text = case raw {
    Some(v) -> "{" <> json.to_string(json.string(name)) <> ":" <> v <> "}"
    None -> "{}"
  }
  let shape = {
    use v <- input.field(name, check)
    input.done(v)
  }
  input.parse_coded(
    shape,
    body(text),
    root: "body",
    codes: decisions.input_codes,
    default: decisions.input_default,
  )
  |> result.map_error(fn(r) { ByShape(r.error) })
}

/// A decision rule's refusal as the TypeScript rule reports one, in its key order: the error, the message, then its
/// other fields (validate_reasons carries the taxonomy's message among them).
pub fn decision_refusal(r: decisions.Refusal) -> DecisionRefused {
  ByRule(
    json.object([
      #("error", json.string(r.error)),
      ..case r.message {
        "" -> r.fields
        m -> [#("message", json.string(m)), ..r.fields]
      }
    ])
    |> json.to_string,
  )
}

/// A write's outcome as validateOutcome judges it: the route's shape alone (a null outcome is none).
pub fn decision_outcome(
  raw: Option(String),
) -> Result(Option(DecisionOutcome), DecisionRefused) {
  decision_field("outcome", decisions.outcome_check(), raw)
  |> result.map(option.flatten)
}

/// A write's reasons as validateDecisionReasons judges them, for an act that requires `outcome`.
pub fn decision_reasons(
  raw: Option(String),
  outcome: Option(DecisionOutcome),
) -> Result(List(String), DecisionRefused) {
  use codes <- result.try(decision_field(
    "reasonCodes",
    decisions.reasons_check(),
    raw,
  ))
  decisions.validate_reasons(
    codes |> option.flatten |> option.unwrap([]),
    outcome,
  )
  |> result.map_error(decision_refusal)
}

/// A write's note (or supersession reason, `field` with its `max`) as validateNote judges it.
pub fn decision_note(
  field: String,
  max: Int,
  raw: Option(String),
) -> Result(Option(String), DecisionRefused) {
  use note <- result.try(decision_field(field, decisions.note_check(max), raw))
  decisions.validate_note(option.flatten(note), field, max)
  |> result.map_error(decision_refusal)
}

/// A write's evidence references as validateEvidenceRefShapes judges them: deduplicated and trimmed.
pub fn decision_refs(
  raw: Option(String),
) -> Result(List(decisions.RefShape), DecisionRefused) {
  use refs <- result.map(decision_field(
    "evidenceRefs",
    decisions.refs_check(),
    raw,
  ))
  decisions.ref_shapes(option.flatten(refs))
}

/// A legacy recommendation of the base case, written at 0 by no one: a recorded row names its own fields.
pub fn decision() -> decisions.Decision {
  decisions.Decision(
    base: room_records.Decision(
      row: room_decisions.new(
        id: id.room_decision("rdec-base"),
        room_id: id.recruitment_case("case-base"),
        org_id: id.org("org-base"),
        player_id: id.player("pl-base"),
        recommendation: room_decisions.NoDecision,
        created_at: 0,
      ),
      reason_codes: [],
      snapshot: None,
    ),
    refs: [],
    assessment_ids: [],
  )
}

/// A submitted assessment of the base player, counted as rating nothing: a recorded summary names its own fields.
pub fn counted() -> decisions.Counted {
  decisions.Counted(
    row: assessments.new(
      id: id.assessment("a-base"),
      org_id: id.org("org-base"),
      player_id: id.player("pl-base"),
      scout_user_id: id.org_user("u-base"),
      scout_name: "",
      template_id: "t-base",
      template_version: 1,
      state: assessments.Submitted,
      created_at: 0,
    ),
    rated: 0,
    not_observed: 0,
    confidence: #(0, 0, 0),
    evidence_refs: 0,
  )
}
