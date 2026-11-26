//// The agent core's sweep (`agentSweep` in domains/agents/core/index.mjs), once at boot and then with the other
//// periodic sweeps: an active relationship ending within 30 days tells its agent once, and a VERIFIED facet whose
//// re-check date passed tells its agent once. Each marker commits with its notification, and only a current
//// member of the agency is told; the marker is written either way. A sweep, not a read, so reads never write.

import gleam/int
import gleam/list
import gleam/option.{None, Some}
import gleam/result
import scoutbox/agents/agent_rules.{type Agreement, type Profile}
import scoutbox/agents/agent_store
import scoutbox/messaging/notifications
import scoutbox/platform/store.{type Fail, type Store, type Tx}
import scoutbox/rows/agent_profile_facets as facet_row
import scoutbox/rows/id
import scoutbox/vocab/agent_facet
import scoutbox/vocab/audience
import scoutbox/vocab/facet_state
import scoutbox/vocab/jurisdiction

/// One pass at `now`: how many agreements and profiles it looked at.
pub fn sweep(store: Store, now: Int) -> Int {
  let found =
    store.read(store, fn(read) {
      use expiring <- result.try(agent_store.agreements_expiring_unnotified(
        read,
        now,
        agent_rules.expiry_alert_ms,
      ))
      use stale <- result.map(agent_store.profiles_stale_unnotified(read, now))
      #(expiring, stale)
    })
  case found {
    Error(_) -> 0
    Ok(#(expiring, stale)) -> {
      // A failed unit leaves its marker unwritten, so the next pass tries that record again.
      list.each(expiring, fn(a) {
        let _ = store.unit(store, fn(tx) { expiry_notice(tx, a, now) })
      })
      list.each(stale, fn(p) {
        let _ = store.unit(store, fn(tx) { stale_notice(tx, p, now) })
      })
      list.length(expiring) + list.length(stale)
    }
  }
}

fn expiry_notice(tx: Tx, a: Agreement, now: Int) -> Result(Nil, Fail(e)) {
  use marked <- result.try(agent_store.mark_expiry_notified(tx, a.row.id, now))
  use member <- result.try(current_member(
    tx,
    a.row.agent_user_id,
    a.row.agency_org_id,
    now,
  ))
  case marked && member {
    False -> Ok(Nil)
    True ->
      notifications.notify(
        tx,
        to: audience.OrgUser,
        id: id.org_user_to_string(a.row.agent_user_id),
        type_: "representation_expiring",
        text: "A client relationship ends within 30 days. A new relationship needs a new client confirmation.",
        ref_id: Some(id.agreement_to_string(a.row.id)),
        at: now,
      )
  }
}

fn stale_notice(tx: Tx, p: Profile, now: Int) -> Result(Nil, Fail(e)) {
  let due =
    list.filter(p.facets, fn(f) {
      f.state == facet_state.Verified
      && f.stale_notified_at == None
      && case f.recheck_at {
        Some(at) -> at <= now
        None -> False
      }
    })
    |> list.sort(fn(a, b) {
      int.compare(facet_order(a.facet), facet_order(b.facet))
    })
  use told <- result.try(
    list.try_map(due, fn(f) {
      agent_store.mark_stale_notified(tx, f, now)
      |> result.map(fn(marked) {
        case marked {
          True -> Some(f)
          False -> None
        }
      })
    })
    |> result.map(option.values),
  )
  use member <- result.try(current_member(
    tx,
    p.row.user_id,
    p.row.agency_org_id,
    now,
  ))
  case member {
    False -> Ok(Nil)
    True ->
      list.try_each(told, fn(f) {
        notifications.notify(
          tx,
          to: audience.OrgUser,
          id: id.org_user_to_string(p.row.user_id),
          type_: "agent_verification_stale",
          text: "Verification of "
            <> agent_facet.to_string(f.facet)
            <> member_association(f)
            <> " has gone STALE. Re-check it or request attributed review before any regulated action.",
          ref_id: Some(id.agent_profile_to_string(p.row.id)),
          at: now,
        )
      })
  }
}

/// The FIFA licence has one record, not one per member association, so its notice names none.
fn member_association(f: facet_row.Row) -> String {
  case f.facet {
    agent_facet.FifaLicence -> ""
    _ -> " (" <> jurisdiction.to_string(f.member_association) <> ")"
  }
}

/// The order the TypeScript sweep visits a profile's facets in.
fn facet_order(facet: agent_facet.AgentFacet) -> Int {
  case facet {
    agent_facet.FifaLicence -> 0
    agent_facet.NationalRegistration -> 1
    agent_facet.DomesticAuthorisation -> 2
    agent_facet.MinorsAuthorisation -> 3
  }
}

fn current_member(
  tx: Tx,
  user: id.OrgUserId,
  org: id.OrgId,
  now: Int,
) -> Result(Bool, Fail(e)) {
  agent_store.active_affiliation(store.reading(tx), user, org, now)
  |> result.map(option.is_some)
}
