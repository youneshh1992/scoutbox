//// The cross-app rules for "can this agent see or do this?" (domains/agents/integration/integration.mjs and the
//// `decide` seam in index.mjs): facts read from canonical records, a decision with a reason code out. Every surface
//// fails closed: a missing fact or an unrecognised scope denies.
////
//// A regulated surface asks the compliance engine whether the agent is clear for its policy action in the
//// agreement's jurisdiction (`compliance.clearFor`). Every surface's action (`approach_adult`, or
//// `declare_representation` for a transaction) is evaluated there without an exclusivity window, so both are
//// `compliance_store.clear_to_declare`.
////
//// The explicit Passport and evidence shares are written by nothing, so a surface that needs one refuses with
//// SHARE_REQUIRED, as on the TypeScript server.

import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/agents/agent_rules
import scoutbox/agents/agent_store
import scoutbox/agents/compliance_store
import scoutbox/identity/players
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/rows/agreement_scopes as scope_row
import scoutbox/rows/id
import scoutbox/safety/audit
import scoutbox/vocab/agreement_status.{type AgreementStatus}
import scoutbox/vocab/jurisdiction.{type Jurisdiction}

pub type Surface {
  /// The agent reading their own client's private record.
  ClientPrivate
  /// The identity and football basics an agent may see without a further share.
  PassportBasic
  PassportShared
  EvidenceShared
  /// Being a routable party on a canonical Contact.
  ContactParticipation
  /// Seeing that a Trial exists and its scheduling, never its assessment.
  TrialProjection
  TrialCoordination
  /// Sharing an opportunity with a represented client.
  OpportunityShare
  /// The transactions module owns the rest of this decision.
  TransactionInitiation
  /// The club-facing "represented by" badge: the player's disclosure choice.
  ClubAgentPresence
}

/// Each surface with its name in the TypeScript seam (`SURFACE_NAMES`), in its order.
pub const surfaces = [
  #("client_private", ClientPrivate),
  #("passport_basic", PassportBasic),
  #("passport_shared", PassportShared),
  #("evidence_shared", EvidenceShared),
  #("contact_participation", ContactParticipation),
  #("trial_projection", TrialProjection),
  #("trial_coordination", TrialCoordination),
  #("opportunity_share", OpportunityShare),
  #("transaction_initiation", TransactionInitiation),
  #("club_agent_presence", ClubAgentPresence),
]

type Disclosure {
  ClubPresence
  ContactRouting
  TrialVisibility
}

type Spec {
  Spec(
    regulated: Bool,
    scopes: Option(List(scope_row.Scope)),
    needs_disclosure: Option(Disclosure),
    needs_share: Bool,
  )
}

const employment_or_transfer = [scope_row.Employment, scope_row.Transfer]

fn spec(s: Surface) -> Spec {
  case s {
    ClientPrivate | PassportBasic -> Spec(False, None, None, False)
    PassportShared | EvidenceShared -> Spec(False, None, None, True)
    ContactParticipation ->
      Spec(True, Some(employment_or_transfer), Some(ContactRouting), False)
    TrialProjection ->
      Spec(False, Some(employment_or_transfer), Some(TrialVisibility), False)
    TrialCoordination ->
      Spec(True, Some(employment_or_transfer), Some(TrialVisibility), False)
    OpportunityShare | TransactionInitiation ->
      Spec(True, Some(employment_or_transfer), None, False)
    ClubAgentPresence -> Spec(False, None, Some(ClubPresence), False)
  }
}

/// Which agreement, if any, makes this agent this player's representative now (agentClientBasis). When none is
/// active, `status` names the most informative non-active state, for the agent only.
pub type Basis {
  Basis(
    agreement: Option(agent_rules.Agreement),
    status: Option(AgreementStatus),
  )
}

pub fn basis(
  agreements: List(agent_rules.Agreement),
  agent: id.OrgUserId,
  client_id: String,
  now: Int,
) -> Basis {
  let mine =
    list.filter(agreements, fn(a) {
      a.row.client_id == client_id && a.row.agent_user_id == agent
    })
  case list.find(mine, fn(a) { agent_rules.grants_access(a.row, agent, now) }) {
    Ok(a) -> Basis(Some(a), Some(agreement_status.Active))
    Error(Nil) -> {
      let rank = fn(st) {
        case st {
          agreement_status.Disputed -> 3
          agreement_status.Expired -> 2
          _ -> 1
        }
      }
      let fallback =
        list.fold(mine, None, fn(best, a) {
          let st = agent_rules.effective_status(a.row, now)
          case best {
            Some(b) ->
              case rank(b) >= rank(st) {
                True -> best
                False -> Some(st)
              }
            None -> Some(st)
          }
        })
      Basis(None, fallback)
    }
  }
}

pub type Decision {
  Allowed(basis: agent_rules.Agreement)
  Denied(code: String, rule: String)
}

/// The facts a surface is decided on, each resolved by `decide` from canonical records, never from a request body.
/// No minor pathway is enabled in any jurisdiction (DR-49), so a client who isn't an adult is refused; an agreement
/// is never a regulatory minor's (the request route refuses one before it exists).
pub type Facts {
  Facts(
    /// Present, not removed, and the agreement's subject not removed.
    subject_present: Bool,
    is_adult: Bool,
    /// A block between the player and the agent's agency, or the club viewing.
    blocked: Bool,
    /// The client's disclosure choice for the surface's key; no recorded answer is not consent.
    disclosed: Bool,
    /// An explicit Passport or evidence share. Nothing writes one, so `decide` always passes False.
    shared: Bool,
    licence_current: Bool,
    /// The compliance layer's answer for a regulated surface; None is "not evaluated", which is not clear.
    compliance_clear: Option(Bool),
  )
}

/// `agentSurfaceDecision`: the first rule that refuses, in `RULE_ORDER`.
pub fn judge(surface: Surface, basis: Basis, f: Facts) -> Decision {
  let s = spec(surface)
  case basis {
    Basis(None, status) ->
      Denied(
        case status {
          Some(_) -> "REPRESENTATION_NOT_ACTIVE"
          None -> "NO_REPRESENTATION"
        },
        "BASIS",
      )
    Basis(Some(a), _) -> {
      use <- refuse(f.subject_present, "SUBJECT_UNAVAILABLE", "SUBJECT_PRESENT")
      use <- refuse(f.is_adult, "MINOR_PATHWAY_DISABLED", "MINOR_PATHWAY")
      // Before scope and compliance, so a compliance answer never overrides a block.
      use <- refuse(!f.blocked, "BLOCKED", "BLOCK")
      use <- refuse(
        case s.scopes {
          Some(need) ->
            list.any(need, list.contains(agent_rules.scope_of(a.scope), _))
          None -> True
        },
        "SCOPE_INSUFFICIENT",
        "SCOPE",
      )
      use <- refuse(
        s.needs_disclosure == None || f.disclosed,
        "DISCLOSURE_WITHHELD",
        "DISCLOSURE",
      )
      use <- refuse(!s.needs_share || f.shared, "SHARE_REQUIRED", "SHARE")
      use <- refuse(
        !s.regulated || f.licence_current,
        "LICENCE_NOT_CURRENT",
        "LICENCE",
      )
      use <- refuse(
        !s.regulated || f.compliance_clear == Some(True),
        "COMPLIANCE_NOT_CLEAR",
        "COMPLIANCE",
      )
      Allowed(a)
    }
  }
}

fn refuse(
  ok: Bool,
  code: String,
  rule: String,
  next: fn() -> Decision,
) -> Decision {
  case ok {
    True -> next()
    False -> Denied(code, rule)
  }
}

/// `surfaceIsRegulated`: a regulated surface needs a current licence and a compliance answer.
pub fn is_regulated(surface: Surface) -> Bool {
  spec(surface).regulated
}

/// `surfaceScopes`: the scopes of which the agreement must carry one, or None when knowing the representative is
/// enough.
pub fn scopes(surface: Surface) -> Option(List(scope_row.Scope)) {
  spec(surface).scopes
}

/// The client's disclosure choice the surface needs, from the agreement's own columns (True when it needs none).
pub fn disclosed(surface: Surface, a: agent_rules.Agreement) -> Bool {
  case spec(surface).needs_disclosure {
    None -> True
    Some(ClubPresence) -> a.row.disclosure_club_presence
    Some(ContactRouting) -> a.row.disclosure_contact_routing
    Some(TrialVisibility) -> a.row.disclosure_trial_visibility
  }
}

/// The decision for a surface: the basis and the facts read from the records, then `judge`.
pub fn decide(
  read: Read,
  surface: Surface,
  client_id: String,
  agent: id.OrgUserId,
  viewer_org: Option(id.OrgId),
  now: Int,
) -> Result(Decision, Fail(e)) {
  use agreements <- result.try(agent_store.agreements_for_client(
    read,
    client_id,
  ))
  let b = basis(agreements, agent, client_id, now)
  case b.agreement {
    // `judge` refuses at the basis before it reads a fact.
    None ->
      Ok(judge(
        surface,
        b,
        Facts(False, False, False, False, False, False, None),
      ))
    Some(a) -> {
      use f <- result.map(facts(read, surface, a, agent, viewer_org, now))
      judge(surface, b, f)
    }
  }
}

fn facts(
  read: Read,
  surface: Surface,
  a: agent_rules.Agreement,
  agent: id.OrgUserId,
  viewer_org: Option(id.OrgId),
  now: Int,
) -> Result(Facts, Fail(e)) {
  use player <- result.try(players.by_id(read, id.player(a.row.client_id)))
  use blocked <- result.try(case player {
    None -> Ok(False)
    Some(p) -> {
      use agency <- result.try(audit.is_blocked(
        read,
        p.row.id,
        a.row.agency_org_id,
      ))
      case agency, viewer_org {
        True, _ | False, None -> Ok(agency)
        False, Some(org) -> audit.is_blocked(read, p.row.id, org)
      }
    }
  })
  // Asked only of a regulated surface, the only one `judge` reads them for.
  use #(licence, clear) <- result.map(case is_regulated(surface) {
    False -> Ok(#(False, None))
    True -> {
      use licence <- result.try(licence_current(
        read,
        agent,
        a.row.jurisdiction,
        now,
      ))
      use clear <- result.map(compliance_store.clear_to_declare(
        read,
        agent,
        jurisdiction.to_string(a.row.jurisdiction),
        now,
      ))
      #(licence, Some(clear))
    }
  })
  Facts(
    subject_present: player != None && a.row.subject_removed_at == None,
    is_adult: case player {
      Some(p) -> players.is_adult(p, now)
      None -> False
    },
    blocked:,
    disclosed: disclosed(surface, a),
    shared: False,
    licence_current: licence,
    compliance_clear: clear,
  )
}

/// The agent's required facets for the jurisdiction are VERIFIED now.
pub fn licence_current(
  read: Read,
  agent: id.OrgUserId,
  j: Jurisdiction,
  now: Int,
) -> Result(Bool, Fail(e)) {
  use p <- result.map(agent_store.profile_for_user(read, agent))
  case p {
    None -> False
    Some(p) -> agent_rules.verification_gap(Some(p), j, now) == None
  }
}
