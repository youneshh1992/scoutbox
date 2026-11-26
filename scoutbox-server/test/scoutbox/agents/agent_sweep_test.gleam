import gleam/dynamic/decode
import gleam/int
import gleam/list
import gleam/option.{type Option}
import scoutbox/agents/agent_sweep
import scoutbox/platform/store
import scoutbox/support

const day = 86_400_000

const now = 1_800_000_000_000

/// An agency with a current member (usr-lead) and one whose membership ended (usr-gone), two players, the lead's
/// profile with three facets, and four active agreements: two ending within 30 days, one later, one already ended.
fn planted() -> store.Store {
  let s = support.fresh_store(fn(_) { Nil })
  let t0 = now - 400 * day
  let agreement = fn(rid: String, agent: String, client: String, end_at: Int) {
    "INSERT INTO representation_agreements (id, agent_user_id, agency_org_id, client_kind, client_id, jurisdiction, exclusive, term_months, start_at, end_at, status, proposed_at, confirmed_at, confirmed_by_player_id, share_with_agency_staff, disclosure_club_presence, disclosure_contact_routing, disclosure_trial_visibility, created_at, rev) VALUES ('"
    <> rid
    <> "', '"
    <> agent
    <> "', 'org-ag', 'player', '"
    <> client
    <> "', 'INT', 0, 12, "
    <> int.to_string(t0)
    <> ", "
    <> int.to_string(end_at)
    <> ", 'active', "
    <> int.to_string(t0)
    <> ", "
    <> int.to_string(t0)
    <> ", '"
    <> client
    <> "', 0, 0, 0, 0, "
    <> int.to_string(t0)
    <> ", 1);"
  }
  let facet = fn(facet: String, ma: String, recheck_at: Int) {
    "INSERT INTO agent_profile_facets (profile_id, facet, member_association, state, recheck_at) VALUES ('agp-lead', '"
    <> facet
    <> "', '"
    <> ma
    <> "', 'VERIFIED', "
    <> int.to_string(recheck_at)
    <> ");"
  }
  let assert Ok(_) =
    store.unit(s, fn(tx) {
      store.exec(
        tx,
        "INSERT INTO orgs (id, name, type, level, plan, created_at) VALUES ('org-ag', 'Agency', 'agency', 'agency', 'Agency', 1);"
          <> "INSERT INTO org_users (id, org_id, name, name_key, role, created_at) VALUES ('usr-lead', 'org-ag', 'Lead', 'lead', 'Director', 1), ('usr-gone', 'org-ag', 'Gone', 'gone', 'Scout', 1);"
          <> "INSERT INTO players (id, name, birth_date, country, profile_signal) VALUES ('pl-a', 'A', '1999-01-01', 'GB', 30), ('pl-b', 'B', '1998-01-01', 'GB', 30);"
          <> "INSERT INTO agency_affiliations (id, agency_org_id, user_id, started_at, ended_at, ended_reason, created_at, rev) VALUES ('aff-lead', 'org-ag', 'usr-lead', 1, NULL, NULL, 1, 1), ('aff-gone', 'org-ag', 'usr-gone', 1, 5, 'left', 1, 1);"
          <> agreement("rep-live", "usr-lead", "pl-a", now + 10 * day)
          <> agreement("rep-left", "usr-gone", "pl-b", now + 20 * day)
          <> agreement("rep-later", "usr-lead", "pl-b", now + 31 * day)
          <> agreement("rep-over", "usr-lead", "pl-a", now - day)
          <> "INSERT INTO agent_profiles (id, user_id, agency_org_id, display_name, created_at, updated_at, rev) VALUES ('agp-lead', 'usr-lead', 'org-ag', 'Lead', 1, 1, 1);"
          <> facet("fifa_licence", "INT", now - day)
          <> facet("national_registration", "ENG", now)
          <> facet("minors_authorisation", "ENG", now + day),
      )
    })
  s
}

fn notices(s: store.Store) -> List(#(String, String, String, Option(String))) {
  let assert Ok(found) =
    store.read(s, fn(read) {
      store.query(
        read,
        "SELECT audience_id, type, text, ref_id FROM notifications ORDER BY seq",
        [],
        {
          use who <- decode.field(0, decode.string)
          use type_ <- decode.field(1, decode.string)
          use text <- decode.field(2, decode.string)
          use ref <- decode.field(3, decode.optional(decode.string))
          decode.success(#(who, type_, text, ref))
        },
      )
    })
  found
}

fn marked(s: store.Store, sql: String) -> List(String) {
  let assert Ok(found) =
    store.read(s, fn(read) {
      store.query(read, sql, [], decode.at([0], decode.string))
    })
  found
}

pub fn the_sweep_tells_a_current_member_once_test() {
  let s = planted()
  assert agent_sweep.sweep(s, now) == 3
  assert notices(s)
    == [
      #(
        "usr-lead",
        "representation_expiring",
        "A client relationship ends within 30 days. A new relationship needs a new client confirmation.",
        option.Some("rep-live"),
      ),
      #(
        "usr-lead",
        "agent_verification_stale",
        "Verification of fifa_licence has gone STALE. Re-check it or request attributed review before any regulated action.",
        option.Some("agp-lead"),
      ),
      #(
        "usr-lead",
        "agent_verification_stale",
        "Verification of national_registration (ENG) has gone STALE. Re-check it or request attributed review before any regulated action.",
        option.Some("agp-lead"),
      ),
    ]
  // An agent who left is not told, but their agreement is marked; one ending later, or already ended, is untouched.
  assert marked(
      s,
      "SELECT id FROM representation_agreements WHERE expiry_notified_at IS NOT NULL ORDER BY id",
    )
    == ["rep-left", "rep-live"]
  assert marked(
      s,
      "SELECT facet FROM agent_profile_facets WHERE stale_notified_at IS NOT NULL ORDER BY facet",
    )
    == ["fifa_licence", "national_registration"]
  // A second pass finds nothing new.
  assert agent_sweep.sweep(s, now) == 0
  assert list.length(notices(s)) == 3
}
