//// The agent core's pure layer (domains/agents/core/shared.mjs): verification facets, affiliations, permissions and
//// agreements. The licence belongs to the person (a staff member with an agent profile), never the agency, and
//// membership alone authorises no regulated action. A self-entered licence number is never a verified licence.
////
//// Proved against the TypeScript rules by the generated tests in `test/scoutbox/battery/agents/`.

import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/string
import scoutbox/rows/agency_affiliations as affiliation_row
import scoutbox/rows/agent_profile_facets as facet_row
import scoutbox/rows/agent_profile_history as profile_event_row
import scoutbox/rows/agent_profiles as profile_row
import scoutbox/rows/agreement_history as event_row
import scoutbox/rows/agreement_scopes as scope_row
import scoutbox/rows/id
import scoutbox/rows/representation_agreements as agreement_row
import scoutbox/vocab/agency_tier.{
  type AgencyTier, AgencyAdmin, Analyst, Assistant, Finance, LicensedAgent,
}
import scoutbox/vocab/agent_actor_kind
import scoutbox/vocab/agent_facet.{
  type AgentFacet, FifaLicence, NationalRegistration,
}
import scoutbox/vocab/agreement_status.{
  type AgreementStatus, Active, Declined, Disputed, Expired, Proposed,
  TerminatedByAgent, TerminatedByClient,
}
import scoutbox/vocab/facet_state.{
  type FacetState, Inactive, ManualReviewRequired, Stale, Unverified, Verified,
}
import scoutbox/vocab/jurisdiction.{type Jurisdiction, ENG, INT}
import scoutbox/vocab/share_via
import scoutbox/vocab/terminator

pub const policy_version = 1

/// How long a VERIFIED facet stays current before it must be re-checked.
pub const recheck_ms = 2_592_000_000

/// FFAR 12(3) / FA 4.3: a player agreement may not exceed two years.
pub const max_term_months = 24

pub const default_term_months = 12

const month_ms = 2_592_000_000

/// After a decline or a termination, the same agent may not re-request the same player within this window.
pub const request_cooldown_ms = 2_592_000_000

/// Home alerts a relationship that ends within this window.
pub const expiry_alert_ms = 2_592_000_000

// ------------------------------------------------------------------------------------------------ records

/// An agent profile with its declared jurisdictions (in order), its facets (in the order first recorded) and its
/// history.
pub type Profile {
  Profile(
    row: profile_row.Row,
    jurisdictions: List(Jurisdiction),
    facets: List(facet_row.Row),
    history: List(profile_event_row.Row),
  )
}

/// A membership of an agency with its roles, in order.
pub type Affiliation {
  Affiliation(row: affiliation_row.Row, tiers: List(AgencyTier))
}

/// A representation agreement with its ordered scope, the policy versions it was requested under, and its history.
pub type Agreement {
  Agreement(
    row: agreement_row.Row,
    scope: List(scope_row.Scope),
    policy_versions: List(id.PolicyId),
    history: List(event_row.Row),
  )
}

// ------------------------------------------------------------------------------------------- verification

/// The facet stored for `facet` (the FIFA licence is kept under INT).
pub fn facet_of(
  p: Profile,
  facet: AgentFacet,
  ma: Option(Jurisdiction),
) -> Option(facet_row.Row) {
  let ma = case facet {
    FifaLicence -> INT
    _ -> option.unwrap(ma, INT)
  }
  list.find(p.facets, fn(f) { f.facet == facet && f.member_association == ma })
  |> option.from_result
}

/// The facets of one kind, keyed by member association, in the order first recorded.
pub fn facets_by_association(
  p: Profile,
  facet: AgentFacet,
) -> List(#(Jurisdiction, facet_row.Row)) {
  p.facets
  |> list.filter(fn(f) { f.facet == facet })
  |> list.map(fn(f) { #(f.member_association, f) })
}

/// VERIFIED decays to STALE once `recheckAt` is reached. An absent recheck clock means no shelf life.
pub fn effective_facet_state(
  facet: Option(facet_row.Row),
  now: Int,
) -> FacetState {
  case facet {
    None -> Unverified
    Some(f) ->
      case f.state, f.recheck_at {
        Verified, Some(at) if at <= now -> Stale
        state, _ -> state
      }
  }
}

pub type Provider {
  NoProvider
  SyntheticProvider
}

/// What a submission's evaluation recorded.
pub type Submission {
  Submission(
    state: FacetState,
    verified_at: Option(Int),
    recheck_at: Option(Int),
    provider: Provider,
    at: Int,
    note: String,
  )
}

/// Production has no provider: a submission goes to MANUAL_REVIEW_REQUIRED. The synthetic test provider is
/// switched on by an environment flag and named in its provenance.
pub fn evaluate_submission(
  facet: AgentFacet,
  reference: String,
  test_provider: Bool,
  now: Int,
) -> Submission {
  let ref = string.trim(reference) |> string.uppercase
  case test_provider {
    True ->
      case string.starts_with(ref, "TEST-VERIFIED-") {
        True ->
          Submission(
            Verified,
            Some(now),
            Some(now + recheck_ms),
            SyntheticProvider,
            now,
            "Verified by the LOCAL SYNTHETIC test provider. This is not a FIFA, FA or U.S. Soccer register check and never exists in production.",
          )
        False ->
          case string.starts_with(ref, "TEST-INACTIVE-") {
            True ->
              Submission(
                Inactive,
                None,
                None,
                SyntheticProvider,
                now,
                "Reported inactive by the LOCAL SYNTHETIC test provider.",
              )
            False -> manual(facet, now)
          }
      }
    False -> manual(facet, now)
  }
}

fn manual(facet: AgentFacet, now: Int) -> Submission {
  let register = case facet {
    FifaLicence -> "FIFA"
    _ -> "national"
  }
  Submission(
    ManualReviewRequired,
    None,
    None,
    NoProvider,
    now,
    "No "
      <> register
      <> " register integration exists in this build. A submitted reference is a declaration, not a verification; it is queued for attributed Trust & Safety review (G-C0), and nothing is verified until a named reviewer decides.",
  )
}

/// The facets a regulated action in a jurisdiction requires.
pub fn required_facets_for(
  j: Jurisdiction,
) -> List(#(AgentFacet, Option(Jurisdiction))) {
  case j {
    ENG -> [#(FifaLicence, None), #(NationalRegistration, Some(ENG))]
    _ -> [#(FifaLicence, None)]
  }
}

pub type Gap {
  ProfileRequired
  VerificationRequired(
    facet: AgentFacet,
    member_association: Option(Jurisdiction),
    state: FacetState,
  )
}

/// The first required facet not VERIFIED now, or None.
pub fn verification_gap(
  profile: Option(Profile),
  j: Jurisdiction,
  now: Int,
) -> Option(Gap) {
  case profile {
    None -> Some(ProfileRequired)
    Some(p) ->
      required_facets_for(j)
      |> list.find_map(fn(req) {
        let state = effective_facet_state(facet_of(p, req.0, req.1), now)
        case state {
          Verified -> Error(Nil)
          _ -> Ok(VerificationRequired(req.0, req.1, state))
        }
      })
      |> option.from_result
  }
}

pub fn gap_code(g: Gap) -> String {
  case g {
    ProfileRequired -> "AGENT_PROFILE_REQUIRED"
    VerificationRequired(..) -> "AGENT_VERIFICATION_REQUIRED"
  }
}

// -------------------------------------------------------------------------------------------- affiliation

/// The agency staff roles, in their declared order.
pub const tiers = [LicensedAgent, AgencyAdmin, Analyst, Assistant, Finance]

/// The roles named, each once, unknown ones dropped.
pub fn normalise_tiers(raw: List(String)) -> List(AgencyTier) {
  list.fold(raw, [], fn(out, t) {
    case agency_tier.from_string(t) {
      Ok(tier) ->
        case list.contains(out, tier) {
          True -> out
          False -> [tier, ..out]
        }
      Error(Nil) -> out
    }
  })
  |> list.reverse
}

/// Started by `now` and not yet ended.
pub fn affiliation_active(
  started_at: Int,
  ended_at: Option(Int),
  now: Int,
) -> Bool {
  started_at <= now
  && case ended_at {
    None -> True
    Some(end) -> end > now
  }
}

pub fn active(a: Affiliation, now: Int) -> Bool {
  affiliation_active(a.row.started_at, a.row.ended_at, now)
}

/// Capability → the roles that hold it, in the TypeScript table's order. A capability absent here is held by
/// nobody. Agency staff see only a summary row of a client who chose to share with them, never the client's data.
pub fn permissions() -> List(#(String, List(AgencyTier))) {
  let staff = [AgencyAdmin, Analyst, Assistant, Finance]
  [
    #("me.read", tiers),
    #("profile.write.own", [LicensedAgent]),
    #("verification.submit", [LicensedAgent]),
    #("clients.read.own", [LicensedAgent]),
    #("clients.read.shared_summary", staff),
    #("clients.request", [LicensedAgent]),
    #("clients.terminate", [LicensedAgent]),
    #("clients.opportunities.read", [LicensedAgent]),
    #("clients.opportunities.share", [LicensedAgent]),
    #("players.lookup", [LicensedAgent]),
    #("inbox.read", tiers),
    #("agency.read", tiers),
    #("agency.team.read", tiers),
    #("agency.team.write", [AgencyAdmin]),
    #("agency.settings.write", [AgencyAdmin]),
    #("agency.audit.read", [AgencyAdmin]),
    #("agency.compliance.read", [AgencyAdmin, LicensedAgent]),
    #("compliance.read", tiers),
    #("compliance.contexts.write", [LicensedAgent]),
    #("transactions.read", tiers),
    #("transactions.write", [LicensedAgent]),
  ]
}

pub fn can(held: List(AgencyTier), capability: String) -> Bool {
  case list.key_find(permissions(), capability) {
    Ok(allowed) -> list.any(held, list.contains(allowed, _))
    Error(Nil) -> False
  }
}

/// For the client's convenience only; `can` is enforced on every route.
pub fn capabilities_of(held: List(AgencyTier)) -> List(String) {
  permissions()
  |> list.filter(fn(p) { list.any(held, list.contains(p.1, _)) })
  |> list.map(fn(p) { p.0 })
}

pub type ChangeProblem {
  SelfPromotionBlocked
  LastAdmin
}

pub fn change_problem_code(p: ChangeProblem) -> String {
  case p {
    SelfPromotionBlocked -> "SELF_PROMOTION_BLOCKED"
    LastAdmin -> "LAST_ADMIN"
  }
}

/// Nobody grants themselves agency_admin, and the last admin cannot be demoted or removed.
pub fn affiliation_change_problem(
  affiliations: List(Affiliation),
  target: Affiliation,
  actor: id.OrgUserId,
  next_tiers: List(AgencyTier),
  ending: Bool,
  now: Int,
) -> Option(ChangeProblem) {
  let admins =
    list.count(affiliations, fn(a) {
      active(a, now) && list.contains(a.tiers, AgencyAdmin)
    })
  let target_is_admin = list.contains(target.tiers, AgencyAdmin)
  let will_be_admin = !ending && list.contains(next_tiers, AgencyAdmin)
  case target.row.user_id == actor && will_be_admin && !target_is_admin {
    True -> Some(SelfPromotionBlocked)
    False ->
      case target_is_admin && !will_be_admin && admins <= 1 {
        True -> Some(LastAdmin)
        False -> None
      }
  }
}

// ------------------------------------------------------------------------------------------------ agreements

/// A stored status as the vocabulary of every status (which adds the derived `expired`).
pub fn stored(s: agreement_row.Status) -> AgreementStatus {
  case s {
    agreement_row.Proposed -> Proposed
    agreement_row.Active -> Active
    agreement_row.Declined -> Declined
    agreement_row.TerminatedByClient -> TerminatedByClient
    agreement_row.TerminatedByAgent -> TerminatedByAgent
    agreement_row.Disputed -> Disputed
  }
}

/// An agreement's scope as the rules read it (`normaliseScope`): one with none stored reads as employment, the scope
/// a request is given when it names none. No route stores an agreement without a scope.
pub fn scope_of(stored: List(scope_row.Scope)) -> List(scope_row.Scope) {
  case stored {
    [] -> [scope_row.Employment]
    _ -> stored
  }
}

pub fn term_end_at(start_at: Int, months: Int) -> Int {
  start_at + months * month_ms
}

fn end_passed(end_at: Option(Int), now: Int) -> Bool {
  case end_at {
    None -> False
    Some(end) -> end <= now
  }
}

fn start_reached(start_at: Option(Int), now: Int) -> Bool {
  case start_at {
    None -> True
    Some(start) -> start <= now
  }
}

/// An active agreement past its end reads as expired.
pub fn effective_status(a: agreement_row.Row, now: Int) -> AgreementStatus {
  case a.status {
    agreement_row.Active ->
      case end_passed(a.end_at, now) {
        True -> Expired
        False -> Active
      }
    s -> stored(s)
  }
}

/// A mandate that has not started still reads `active` but grants no access.
pub fn term_covers_now(a: agreement_row.Row, now: Int) -> Bool {
  start_reached(a.start_at, now) && !end_passed(a.end_at, now)
}

/// Names an agent, client-confirmed, active and within its term.
pub fn in_force(a: agreement_row.Row, now: Int) -> Bool {
  option.is_some(a.confirmed_at)
  && effective_status(a, now) == Active
  && start_reached(a.start_at, now)
}

/// Private client access, for the agent named on an agreement in force. The caller applies block and visibility.
pub fn grants_access(
  a: agreement_row.Row,
  agent: id.OrgUserId,
  now: Int,
) -> Bool {
  in_force(a, now) && a.agent_user_id == agent
}

pub type Conflict {
  AlreadyExists(agreement_id: id.AgreementId, status: AgreementStatus)
  Cooldown(retry_at: Int)
}

/// An open relationship with this agent refuses a new request, and a recent end starts a cool-down.
pub fn request_conflict(
  agreements: List(agreement_row.Row),
  agent: id.OrgUserId,
  player_id: String,
  now: Int,
) -> Option(Conflict) {
  let mine =
    list.filter(agreements, fn(a) {
      a.agent_user_id == agent && a.client_id == player_id
    })
  let open =
    list.find_map(mine, fn(a) {
      let st = effective_status(a, now)
      case st {
        Proposed | Active | Disputed -> Ok(AlreadyExists(a.id, st))
        _ -> Error(Nil)
      }
    })
  case open {
    Ok(c) -> Some(c)
    Error(Nil) -> {
      let latest =
        list.fold(mine, None, fn(latest, a) {
          let ended = case effective_status(a, now) {
            Declined -> a.declined_at
            TerminatedByClient | TerminatedByAgent -> a.terminated_at
            Expired -> a.end_at
            _ -> None
          }
          case ended {
            Some(at) if now - at < request_cooldown_ms ->
              Some(int.max(option.unwrap(latest, 0), at))
            _ -> latest
          }
        })
      option.map(latest, fn(at) { Cooldown(at + request_cooldown_ms) })
    }
  }
}

/// The client may confirm, decline or dispute a proposal, and end or dispute an active agreement.
pub fn client_transition_allowed(
  a: agreement_row.Row,
  to: AgreementStatus,
  now: Int,
) -> Bool {
  case effective_status(a, now), to {
    Proposed, Active | Proposed, Declined | Proposed, Disputed -> True
    Active, TerminatedByClient | Active, Disputed -> True
    _, _ -> False
  }
}

/// The agent may withdraw a proposal or end an active agreement.
pub fn agent_transition_allowed(
  a: agreement_row.Row,
  to: AgreementStatus,
  now: Int,
) -> Bool {
  case effective_status(a, now), to {
    Proposed, TerminatedByAgent | Active, TerminatedByAgent -> True
    _, _ -> False
  }
}

// ------------------------------------------------------------------------------------------------ projections

fn disclosure(a: agreement_row.Row) -> Json {
  json.object([
    #("clubPresence", json.bool(a.disclosure_club_presence)),
    #("contactRouting", json.bool(a.disclosure_contact_routing)),
    #("trialVisibility", json.bool(a.disclosure_trial_visibility)),
  ])
}

fn opt_int(v: Option(Int)) -> Json {
  json.nullable(v, json.int)
}

fn event_detail(a: Agreement, h: event_row.Row) -> Json {
  let flag = fn(name, v: Option(Bool)) {
    option.map(v, fn(b) { #(name, json.bool(b)) })
  }
  case h.action {
    event_row.RepresentationRequested ->
      json.object([
        #("scope", json.array(a.scope, scope_row.scope_to_json)),
        #("termMonths", json.int(a.row.term_months)),
        #("jurisdiction", jurisdiction.to_json(a.row.jurisdiction)),
        #("policyVersions", json.array(a.policy_versions, id.policy_json)),
      ])
    event_row.RepresentationSharingChanged ->
      json.object(
        option.values([
          flag("shareWithAgencyStaff", h.detail_share_with_agency_staff),
          flag("clubPresence", h.detail_club_presence),
          flag("contactRouting", h.detail_contact_routing),
          flag("trialVisibility", h.detail_trial_visibility),
        ]),
      )
    event_row.OpportunityShared ->
      json.object([
        #(
          "shareId",
          json.nullable(
            option.map(h.detail_share_id, id.opportunity_share_to_string),
            json.string,
          ),
        ),
        #("via", json.nullable(h.detail_via, share_via.to_json)),
      ])
    event_row.OpportunityShareWithdrawn ->
      json.object([
        #(
          "shareId",
          json.nullable(
            option.map(h.detail_share_id, id.opportunity_share_to_string),
            json.string,
          ),
        ),
      ])
    _ ->
      case h.detail_by {
        Some(terminator.Client) ->
          json.object([
            #("from", json.nullable(h.detail_from, agreement_status.to_json)),
            #("to", json.nullable(h.detail_to, agreement_status.to_json)),
            #("by", json.string("client")),
            #("hadReason", json.bool(h.detail_had_reason == Some(True))),
          ])
        Some(terminator.TrustSafety) ->
          json.object([
            #("by", json.string("trust_safety")),
            #("phase", json.nullable(h.detail_phase, agreement_status.to_json)),
            #(
              "reviewId",
              json.nullable(
                option.map(h.detail_review_id, id.regulatory_review_to_string),
                json.string,
              ),
            ),
            #("reasonCode", json.nullable(h.detail_reason_code, json.string)),
          ])
        by ->
          json.object([
            #("by", json.nullable(by, terminator.to_json)),
            #("phase", json.nullable(h.detail_phase, agreement_status.to_json)),
            #("reasonCode", json.nullable(h.detail_reason_code, json.string)),
          ])
      }
  }
}

/// No client PII beyond the id: the caller adds the live client identity it may show.
pub fn agreement_for_agent(a: Agreement, now: Int) -> List(#(String, Json)) {
  let r = a.row
  [
    #("id", id.agreement_json(r.id)),
    #("agentUserId", id.org_user_json(r.agent_user_id)),
    #("agencyOrgId", id.org_json(r.agency_org_id)),
    #("clientKind", agreement_row.client_kind_to_json(r.client_kind)),
    #("clientId", json.string(r.client_id)),
    #("status", agreement_status.to_json(effective_status(r, now))),
    #("storedStatus", agreement_row.status_to_json(r.status)),
    #("scope", json.array(a.scope, scope_row.scope_to_json)),
    #("exclusive", json.bool(r.exclusive)),
    #("jurisdiction", jurisdiction.to_json(r.jurisdiction)),
    #("termMonths", json.int(r.term_months)),
    #("startAt", opt_int(r.start_at)),
    #("endAt", opt_int(r.end_at)),
    #("proposedAt", json.int(r.proposed_at)),
    #("confirmedAt", opt_int(r.confirmed_at)),
    #("declinedAt", opt_int(r.declined_at)),
    #("terminatedAt", opt_int(r.terminated_at)),
    #("terminatedBy", json.nullable(r.terminated_by, terminator.to_json)),
    #(
      "terminationReasonCode",
      json.nullable(r.termination_reason_code, json.string),
    ),
    #("disputedAt", opt_int(r.disputed_at)),
    #("shareWithAgencyStaff", json.bool(r.share_with_agency_staff)),
    #("disclosure", disclosure(r)),
    #("subjectRemovedAt", opt_int(r.subject_removed_at)),
    #("policyVersion", json.int(policy_version)),
    #("rev", json.int(r.rev)),
    #("revAt", opt_int(r.rev_at)),
    #(
      "history",
      json.array(a.history, fn(h) {
        json.object([
          #("id", id.agreement_event_json(h.id)),
          #("at", json.int(h.at)),
          #("action", event_row.action_to_json(h.action)),
          #("byKind", agent_actor_kind.to_json(h.by_kind)),
          #("byName", json.nullable(h.by_name, json.string)),
          #("detail", event_detail(a, h)),
        ])
      }),
    ),
    #(
      "honest",
      json.string(
        "A ScoutBox relationship record. It is not a representation contract and ScoutBox has not assessed its legal validity; the client confirmed it in ScoutBox.",
      ),
    ),
  ]
}

/// The agent's projection without its history: the shared-key oversight list.
pub fn agreement_for_oversight(
  a: Agreement,
  now: Int,
) -> List(#(String, Json)) {
  agreement_for_agent(a, now) |> list.filter(fn(f) { f.0 != "history" })
}

/// The client's own projection adds whether it waits on them, and their own dispute reason.
pub fn agreement_for_client(a: Agreement, now: Int) -> List(#(String, Json)) {
  list.append(agreement_for_agent(a, now), [
    #("pending", json.bool(effective_status(a.row, now) == Proposed)),
    #("disputeReason", json.nullable(a.row.dispute_reason, json.string)),
  ])
}

/// The summary a same-agency colleague may see when the client allows it.
pub fn summary_for_staff(
  a: agreement_row.Row,
  now: Int,
) -> List(#(String, Json)) {
  [
    #("id", id.agreement_json(a.id)),
    #("agentUserId", id.org_user_json(a.agent_user_id)),
    #("clientId", json.string(a.client_id)),
    #("status", agreement_status.to_json(effective_status(a, now))),
    #("startAt", opt_int(a.start_at)),
    #("endAt", opt_int(a.end_at)),
    #("summaryOnly", json.bool(True)),
  ]
}
