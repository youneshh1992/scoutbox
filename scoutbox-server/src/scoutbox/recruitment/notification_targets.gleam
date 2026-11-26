//// Where a notification leads (journeyRoutes.mjs notificationTargetFor): its `ref_id` resolved at read time to the
//// current resource this audience may open, or nothing. A staff member is led into their own organisation's Room;
//// an agent to their client, re-derived through the same authority the client routes prove, so an agent whose
//// representation ended or licence lapsed keeps the row but loses the destination; a player or guardian to the
//// record that was shared with them. A superseded or expired signing package leads to the current one.

import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/agents/integration
import scoutbox/identity/staff
import scoutbox/platform/clock
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/recruitment/cases
import scoutbox/recruitment/contacts
import scoutbox/recruitment/journey_model
import scoutbox/recruitment/offers
import scoutbox/recruitment/requests
import scoutbox/recruitment/signing_packages
import scoutbox/recruitment/signing_rules
import scoutbox/recruitment/signings
import scoutbox/recruitment/trials
import scoutbox/rows/agreement_scopes as scope_row
import scoutbox/rows/id
import scoutbox/rows/recruitment_requests as request_row
import scoutbox/safety/audit
import scoutbox/vocab/audience.{type Audience}
import scoutbox/vocab/party
import scoutbox/vocab/signing_party_type

/// Where a feed row naming `ref_id` leads the audience `kind` / `who`.
pub fn target(
  read: Read,
  kind: Audience,
  who: String,
  ref_id: Option(String),
) -> Result(Option(Json), Fail(e)) {
  let now = clock.now_ms()
  use org <- result.try(case kind {
    audience.OrgUser ->
      staff.by_id(read, id.org_user(who))
      |> result.map(option.map(_, fn(s) { s.org_id }))
    _ -> Ok(None)
  })
  case ref_id {
    None -> Ok(None)
    Some("case-" <> _ as ref) ->
      case kind {
        audience.OrgUser ->
          room(read, Some(id.recruitment_case(ref)), org, "overview")
        _ -> Ok(None)
      }
    Some("req-" <> _ as ref) -> request(read, kind, who, org, ref)
    Some("trial-" <> _ as ref) -> trial(read, kind, who, org, ref)
    Some("rct-" <> _ as ref) -> contact(read, kind, who, org, ref, now)
    Some("rof-" <> _ as ref) -> offer(read, kind, who, org, ref, now)
    Some("spk-" <> _ as ref) -> signing(read, kind, who, org, ref, False, now)
    Some("sign-" <> _ as ref) -> signing(read, kind, who, org, ref, True, now)
    Some(_) -> Ok(None)
  }
}

/// The Room `case_id` names, when it is a Room of the staff member's organisation.
fn room(
  read: Read,
  case_id: Option(id.RecruitmentCaseId),
  org: Option(id.OrgId),
  tab: String,
) -> Result(Option(Json), Fail(e)) {
  case case_id {
    None -> Ok(None)
    Some(cid) -> {
      use found <- result.map(cases.room(read, cid))
      case found {
        Some(r) if org == None -> Some(room_json(r.row.id, tab))
        Some(r) ->
          case Some(r.row.org_id) == org {
            True -> Some(room_json(r.row.id, tab))
            False -> None
          }
        None -> None
      }
    }
  }
}

fn room_json(case_id: id.RecruitmentCaseId, tab: String) -> Json {
  json.object([
    #("kind", json.string("room")),
    #("roomId", id.recruitment_case_json(case_id)),
    #("tab", json.string(tab)),
  ])
}

fn kind_json(kind: String, fields: List(#(String, Json))) -> Option(Json) {
  Some(json.object([#("kind", json.string(kind)), ..fields]))
}

fn request(
  read: Read,
  kind: Audience,
  who: String,
  org: Option(id.OrgId),
  ref: String,
) -> Result(Option(Json), Fail(e)) {
  use found <- result.try(requests.by_id(read, id.request(ref)))
  case found, kind {
    None, _ -> Ok(None)
    Some(r), audience.OrgUser ->
      case Some(r.org_id) == org {
        True ->
          room(read, r.case_id, org, case r.type_ {
            request_row.Trial -> "trial"
            _ -> "contact"
          })
        False -> Ok(None)
      }
    Some(r), audience.Player ->
      Ok(
        case
          id.player_to_string(r.player_id) == who
          && r.routed_to != party.Guardian
        {
          True -> inbox(ref)
          False -> None
        },
      )
    Some(r), audience.Guardian ->
      Ok(case option.map(r.guardian_id, id.guardian_to_string) == Some(who) {
        True -> inbox(ref)
        False -> None
      })
  }
}

fn inbox(request_id: String) -> Option(Json) {
  kind_json("inbox", [#("requestId", json.string(request_id))])
}

fn trial(
  read: Read,
  kind: Audience,
  who: String,
  org: Option(id.OrgId),
  ref: String,
) -> Result(Option(Json), Fail(e)) {
  use found <- result.try(trials.by_id(read, id.trial(ref)))
  case found {
    None -> Ok(None)
    Some(t) -> {
      let r = t.row
      let lead = kind_json("trial", [#("trialId", id.trial_json(r.id))])
      case kind {
        audience.OrgUser ->
          case Some(r.org_id) == org {
            True -> room(read, r.case_id, org, "trial")
            False -> Ok(None)
          }
        audience.Player ->
          Ok(
            case
              id.player_to_string(r.player_id) == who
              && case r.recipient_type {
                Some(t) -> t == party.Player
                None -> r.accepted_by == Some(party.Player)
              }
            {
              True -> lead
              False -> None
            },
          )
        audience.Guardian ->
          Ok(
            case
              case r.recipient_type {
                Some(t) ->
                  t == party.Guardian
                  && option.map(r.recipient_guardian_id, id.guardian_to_string)
                  == Some(who)
                None -> r.accepted_by == Some(party.Guardian)
              }
            {
              True -> lead
              False -> None
            },
          )
      }
    }
  }
}

fn contact(
  read: Read,
  kind: Audience,
  who: String,
  org: Option(id.OrgId),
  ref: String,
  now: Int,
) -> Result(Option(Json), Fail(e)) {
  use found <- result.try(contacts.by_id(read, id.contact(ref)))
  case found, kind {
    Some(c), audience.OrgUser ->
      case Some(c.row.org_id) == org {
        True -> room(read, Some(c.row.case_id), org, "contact")
        // An agent the contact was routed to: their client's contacts tab.
        False ->
          case
            option.map(c.row.routing_agent_user_id, id.org_user_to_string)
            == Some(who)
          {
            True -> agent(read, who, c.row.player_id, "contacts", now)
            False -> Ok(None)
          }
      }
    _, _ -> Ok(None)
  }
}

fn offer(
  read: Read,
  kind: Audience,
  who: String,
  org: Option(id.OrgId),
  ref: String,
  now: Int,
) -> Result(Option(Json), Fail(e)) {
  use found <- result.try(offers.by_id(read, id.offer(ref)))
  case found {
    None -> Ok(None)
    Some(o) ->
      case kind {
        audience.OrgUser ->
          case Some(o.row.org_id) == org {
            True -> room(read, Some(o.row.case_id), org, "offer")
            False ->
              case
                option.map(o.row.agent_share_user_id, id.org_user_to_string)
                == Some(who)
              {
                True -> agent(read, who, o.row.player_id, "offers", now)
                False -> Ok(None)
              }
          }
        _ -> {
          let issued =
            o.revisions
            |> list.filter(fn(r) { option.is_some(r.row.issued_at) })
            |> list.sort(fn(a, b) {
              int.compare(b.row.revision_number, a.row.revision_number)
            })
            |> list.first
          case issued {
            Error(Nil) -> Ok(None)
            Ok(rev) -> {
              let r = rev.row
              let lead =
                kind_json("offer", [
                  #("offerId", id.offer_json(o.row.id)),
                  #("offerRevisionId", id.offer_revision_json(r.id)),
                ])
              case kind {
                audience.Player ->
                  case
                    r.recipient_type == Some(party.Player)
                    && option.map(r.recipient_player_id, id.player_to_string)
                    == Some(who)
                  {
                    True -> {
                      use blocked <- result.map(audit.is_blocked(
                        read,
                        o.row.player_id,
                        o.row.org_id,
                      ))
                      case blocked {
                        True -> None
                        False -> lead
                      }
                    }
                    False -> Ok(None)
                  }
                _ ->
                  Ok(
                    case
                      r.recipient_type == Some(party.Guardian)
                      && option.map(
                        r.recipient_guardian_id,
                        id.guardian_to_string,
                      )
                      == Some(who)
                    {
                      True -> lead
                      False -> None
                    },
                  )
              }
            }
          }
        }
      }
  }
}

/// `ref` is a package, or a signing row that names one (`by_row`).
fn signing(
  read: Read,
  kind: Audience,
  who: String,
  org: Option(id.OrgId),
  ref: String,
  by_row: Bool,
  now: Int,
) -> Result(Option(Json), Fail(e)) {
  use package_id <- result.try(case by_row {
    False -> Ok(Some(id.signing_package(ref)))
    True ->
      signings.by_id(read, id.signing(ref))
      |> result.map(option.then(_, fn(s) { s.signing_package_id }))
  })
  use found <- result.try(case package_id {
    Some(pid) -> signing_packages.by_id(read, pid)
    None -> Ok(None)
  })
  case found {
    None -> Ok(None)
    Some(p) -> {
      use siblings <- result.try(signing_packages.for_offer(
        read,
        p.row.offer_id,
      ))
      let current =
        siblings
        |> list.filter(fn(x) { x.row.org_id == p.row.org_id })
        |> journey_model.current_signing(now)
        |> option.unwrap(p)
      case kind {
        audience.OrgUser ->
          case Some(p.row.org_id) == org {
            True -> room(read, Some(p.row.case_id), org, "signing")
            False -> {
              use o <- result.try(offers.by_id(read, p.row.offer_id))
              case o {
                Some(o) ->
                  case
                    option.map(o.row.agent_share_user_id, id.org_user_to_string)
                    == Some(who)
                  {
                    True -> agent(read, who, p.row.player_id, "offers", now)
                    False -> Ok(None)
                  }
                None -> Ok(None)
              }
            }
          }
        _ -> {
          let party_type = case kind {
            audience.Guardian -> signing_party_type.Guardian
            _ -> signing_party_type.Player
          }
          // Never presented: nothing for a recipient to open.
          let party =
            signing_rules.current_revision(current)
            |> option.then(fn(rev) {
              case rev.row.ready_at {
                Some(_) -> signing_rules.find_party(rev, party_type, Some(who))
                None -> None
              }
            })
          case party {
            None -> Ok(None)
            Some(_) -> {
              use blocked <- result.map(case kind {
                audience.Player ->
                  audit.is_blocked(read, p.row.player_id, p.row.org_id)
                _ -> Ok(False)
              })
              case blocked {
                True -> None
                False ->
                  kind_json("signing", [
                    #(
                      "signingPackageId",
                      id.signing_package_json(current.row.id),
                    ),
                    #("superseded", json.bool(current.row.id != p.row.id)),
                  ])
              }
            }
          }
        }
      }
    }
  }
}

/// The agent's client, on `tab`, while the agent's authority over the client's private record holds; an Offer
/// also needs an employment or transfer scope and a current licence. A share alone never grants a target.
fn agent(
  read: Read,
  agent_user: String,
  client: id.PlayerId,
  tab: String,
  now: Int,
) -> Result(Option(Json), Fail(e)) {
  let client_id = id.player_to_string(client)
  let agent_id = id.org_user(agent_user)
  use decision <- result.try(integration.decide(
    read,
    integration.ClientPrivate,
    client_id,
    agent_id,
    None,
    now,
  ))
  case decision {
    integration.Denied(..) -> Ok(None)
    integration.Allowed(basis) -> {
      use open <- result.map(case tab {
        "offers" -> {
          let scope_ok =
            list.any(basis.scope, fn(s) {
              s == scope_row.Employment || s == scope_row.Transfer
            })
          use licence <- result.map(integration.licence_current(
            read,
            agent_id,
            basis.row.jurisdiction,
            now,
          ))
          scope_ok && licence
        }
        _ -> Ok(True)
      })
      case open {
        True ->
          kind_json("client", [
            #("clientId", json.string(client_id)),
            #("tab", json.string(tab)),
          ])
        False -> None
      }
    }
  }
}
