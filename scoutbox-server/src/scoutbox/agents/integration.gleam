//// The cross-app rules for "can this agent see or do this?" (domains/agents/integration/integration.mjs and the
//// `decide` seam in index.mjs): facts read from canonical records, a decision with a reason code out. Every surface
//// fails closed: a missing fact or an unrecognised scope denies.
////
//// Not ported yet: the compliance answer for a regulated surface (`compliance.clearFor`), so a regulated surface
//// reads it as "not evaluated", which is not clear; and the explicit Passport and evidence shares, which nothing
//// writes, so a surface that needs one refuses with SHARE_REQUIRED, as on the TypeScript server.

import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/agents/agent_rules
import scoutbox/agents/agent_store
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

/// The decision for a surface, every fact resolved from the records (agentSurfaceDecision).
pub fn decide(
  read: Read,
  surface: Surface,
  client_id: String,
  agent: id.OrgUserId,
  viewer_org: Option(id.OrgId),
  now: Int,
) -> Result(Decision, Fail(e)) {
  let s = spec(surface)
  use agreements <- result.try(agent_store.agreements_for_client(
    read,
    client_id,
  ))
  case basis(agreements, agent, client_id, now) {
    Basis(None, status) ->
      Ok(Denied(
        case status {
          Some(_) -> "REPRESENTATION_NOT_ACTIVE"
          None -> "NO_REPRESENTATION"
        },
        "BASIS",
      ))
    Basis(Some(a), _) -> {
      use player <- result.try(players.by_id(read, id.player(client_id)))
      case player {
        None -> Ok(Denied("SUBJECT_UNAVAILABLE", "SUBJECT_PRESENT"))
        Some(_) if a.row.subject_removed_at != None ->
          Ok(Denied("SUBJECT_UNAVAILABLE", "SUBJECT_PRESENT"))
        Some(p) -> {
          // No minor pathway is enabled in production in any jurisdiction (DR-49).
          use <- guard(
            players.is_adult(p, now),
            Denied("MINOR_PATHWAY_DISABLED", "MINOR_PATHWAY"),
          )
          use agency_block <- result.try(audit.is_blocked(
            read,
            p.row.id,
            a.row.agency_org_id,
          ))
          use viewer_block <- result.try(case viewer_org {
            Some(org) -> audit.is_blocked(read, p.row.id, org)
            None -> Ok(False)
          })
          use <- guard(
            !agency_block && !viewer_block,
            Denied("BLOCKED", "BLOCK"),
          )
          use <- guard(
            case s.scopes {
              Some(need) -> list.any(need, list.contains(a.scope, _))
              None -> True
            },
            Denied("SCOPE_INSUFFICIENT", "SCOPE"),
          )
          use <- guard(
            case s.needs_disclosure {
              None -> True
              Some(ClubPresence) -> a.row.disclosure_club_presence
              Some(ContactRouting) -> a.row.disclosure_contact_routing
              Some(TrialVisibility) -> a.row.disclosure_trial_visibility
            },
            Denied("DISCLOSURE_WITHHELD", "DISCLOSURE"),
          )
          use <- guard(!s.needs_share, Denied("SHARE_REQUIRED", "SHARE"))
          case s.regulated {
            False -> Ok(Allowed(a))
            True -> {
              use current <- result.map(licence_current(
                read,
                agent,
                a.row.jurisdiction,
                now,
              ))
              case current {
                False -> Denied("LICENCE_NOT_CURRENT", "LICENCE")
                // Not ported yet: the compliance layer's answer; "not evaluated" is not clear.
                True -> Denied("COMPLIANCE_NOT_CLEAR", "COMPLIANCE")
              }
            }
          }
        }
      }
    }
  }
}

fn guard(
  ok: Bool,
  denied: Decision,
  next: fn() -> Result(Decision, Fail(e)),
) -> Result(Decision, Fail(e)) {
  case ok {
    True -> next()
    False -> Ok(denied)
  }
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
