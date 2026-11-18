//// The agent core rules' checks that the recorder can't turn into generated cases, ported by hand from the
//// TypeScript rules suites of agents/core, agents/corePersistence and platform/dates (scripts/rules/). Two kinds:
////
//// - Values Gleam's types can't hold: an unknown role, facet state or stored status (`constructor`, `approved`,
////   `signed`), a missing record, a missing agent, and a boundary instant that is text, a boolean, an object, NaN
////   or ±Infinity. The TypeScript rules read each as nothing (no role, MANUAL_REVIEW_REQUIRED, no access, no
////   transition, not started or already over). Here they can't be read from text (the closed vocabularies) and
////   can't be stored (the STRICT schema refuses them), so the checks run against both, and against the typed
////   values nearest them.
//// - The projections' recorded agreement has no jurisdiction, term or proposal time, which every stored agreement
////   has; their checks run here on a whole agreement.

import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleam/string
import scoutbox/agents/agent_rules
import scoutbox/platform/store
import scoutbox/rows/agent_profile_facets as facet_row
import scoutbox/rows/agent_profiles as profile_row
import scoutbox/rows/agreement_history as event_row
import scoutbox/rows/id
import scoutbox/rows/representation_agreements as agreement_row
import scoutbox/support
import scoutbox/vocab/agency_tier
import scoutbox/vocab/agent_actor_kind
import scoutbox/vocab/agent_facet
import scoutbox/vocab/agreement_status
import scoutbox/vocab/facet_state
import scoutbox/vocab/jurisdiction
import scoutbox/vocab/terminator

const now = 1_800_000_000_000

/// Text a boundary instant can't be, as SQL: the TypeScript suites' strings, booleans aside (SQLite has none), and
/// ±Infinity. NaN can't be written: SQLite reads it as NULL, and an Erlang float is never NaN.
const not_instants = [
  "'soon'", "''", "'2020-01-01'", "'2020-01-01T00:00:00.000Z'", "'2030-01-01'",
  "'{}'", "'[]'", "1e999", "-1e999", "0.5",
]

/// A store holding an agency, its member, their profile and a player, which the refused rows would refer to.
fn planted() -> store.Store {
  let s = support.fresh_store(fn(_) { Nil })
  let assert Ok(_) =
    store.unit(s, fn(tx) {
      store.exec(
        tx,
        "INSERT INTO orgs (id, name, type, level, plan, created_at) VALUES ('org-ag', 'Agency', 'agency', 'agency', 'Agency', 1);"
          <> "INSERT INTO org_users (id, org_id, name, name_key, role, created_at) VALUES ('usr-lead', 'org-ag', 'Lead', 'lead', 'Director', 1);"
          <> "INSERT INTO players (id, name, birth_date, country, profile_signal) VALUES ('pl-a', 'A', '1999-01-01', 'GB', 30);"
          <> "INSERT INTO agent_profiles (id, user_id, agency_org_id, display_name, created_at, updated_at, rev) VALUES ('agp-lead', 'usr-lead', 'org-ag', 'Lead', 1, 1, 1);",
      )
    })
  s
}

fn stores(s: store.Store, sql: String) -> Bool {
  case store.unit(s, fn(tx) { store.exec(tx, sql) }) {
    Ok(_) -> True
    Error(_) -> False
  }
}

fn facet_sql(state: String, recheck_at: String) -> String {
  "INSERT INTO agent_profile_facets (profile_id, facet, member_association, state, recheck_at) VALUES ('agp-lead', 'fifa_licence', 'INT', "
  <> state
  <> ", "
  <> recheck_at
  <> ")"
}

fn affiliation_sql(id: String, started_at: String, ended_at: String) -> String {
  "INSERT INTO agency_affiliations (id, agency_org_id, user_id, started_at, ended_at, ended_reason, created_at, rev) VALUES ('"
  <> id
  <> "', 'org-ag', 'usr-lead', "
  <> started_at
  <> ", "
  <> ended_at
  <> ", "
  <> case ended_at {
    "NULL" -> "NULL"
    _ -> "'left'"
  }
  <> ", 1, 1)"
}

fn agreement_sql(
  id: String,
  agent: String,
  status: String,
  start_at: String,
  end_at: String,
) -> String {
  "INSERT INTO representation_agreements (id, agent_user_id, agency_org_id, client_kind, client_id, jurisdiction, exclusive, term_months, start_at, end_at, status, proposed_at, confirmed_at, confirmed_by_player_id, share_with_agency_staff, disclosure_club_presence, disclosure_contact_routing, disclosure_trial_visibility, created_at, rev) VALUES ('"
  <> id
  <> "', "
  <> agent
  <> ", 'org-ag', 'player', 'pl-a', 'INT', 0, 12, "
  <> start_at
  <> ", "
  <> end_at
  <> ", "
  <> status
  <> ", 1, 1, 'pl-a', 0, 0, 0, 0, 1, 1)"
}

fn agreement() -> agreement_row.Row {
  agreement_row.Row(
    ..agreement_row.new(
      id: id.agreement("r9"),
      agent_user_id: id.org_user("a1"),
      agency_org_id: id.org("o1"),
      client_kind: agreement_row.Player,
      client_id: "p1",
      jurisdiction: jurisdiction.INT,
      exclusive: False,
      term_months: 12,
      status: agreement_row.Active,
      proposed_at: now - 10,
      share_with_agency_staff: False,
      disclosure_club_presence: False,
      disclosure_contact_routing: False,
      disclosure_trial_visibility: False,
      created_at: now - 10,
      rev: 1,
    ),
    confirmed_at: Some(now - 5),
    start_at: Some(now - 5),
    end_at: Some(now + 86_400_000),
  )
}

// ------------------------------------------------------------------------------------------------ roles (can)

/// B8 and the prototype-key checks: no roles, or roles that aren't roles, hold nothing.
pub fn unknown_or_absent_roles_hold_nothing_test() {
  let tricks = [
    "constructor", "toString", "__proto__", "hasOwnProperty", "prototype",
  ]
  list.each(tricks, fn(t) {
    assert agency_tier.from_string(t) == Error(Nil)
  })
  assert agent_rules.normalise_tiers(tricks) == []
  // `can(undefined, c)` and `can(null, c)`: Gleam's roles are always a list, and an empty one holds nothing.
  list.each(agent_rules.permissions(), fn(p) {
    assert !agent_rules.can([], p.0)
  })
  assert agent_rules.capabilities_of([]) == []
  // `normaliseTiers("licensed_agent")`: a role that isn't in a list is not a list of roles.
  assert agent_rules.normalise_tiers([]) == []
  let s = planted()
  let assert True = stores(s, affiliation_sql("aff-1", "1", "NULL"))
  list.each(tricks, fn(t) {
    assert !stores(
      s,
      "INSERT INTO agency_affiliation_tiers (affiliation_id, tier) VALUES ('aff-1', '"
        <> t
        <> "')",
    )
  })
}

// ------------------------------------------------------------------------------------------------ facets

/// A5, A7 and the corePersistence check: a facet state outside the vocabulary reads MANUAL_REVIEW_REQUIRED in
/// TypeScript (never better). Here it can't be read or stored, so no profile has one.
pub fn a_facet_state_outside_the_vocabulary_is_never_held_test() {
  assert facet_state.from_string("approved") == Error(Nil)
  assert facet_state.from_string("constructor") == Error(Nil)
  let s = planted()
  assert !stores(s, facet_sql("'approved'", "NULL"))
  assert !stores(s, facet_sql("'constructor'", "NULL"))
  assert stores(s, facet_sql("'MANUAL_REVIEW_REQUIRED'", "NULL"))
}

/// A recheck clock that isn't an instant reads STALE in TypeScript. Here a recheck clock is an Int or absent: the
/// schema refuses anything else, and an absent one is no shelf life.
pub fn a_recheck_clock_is_an_instant_or_absent_test() {
  let s = planted()
  list.each(not_instants, fn(v) {
    assert !stores(s, facet_sql("'VERIFIED'", v))
  })
  let verified = fn(recheck_at) {
    Some(
      facet_row.Row(
        ..facet_row.new(
          profile_id: id.agent_profile("agp-lead"),
          facet: agent_facet.FifaLicence,
          member_association: jurisdiction.INT,
          state: facet_state.Verified,
        ),
        recheck_at:,
      ),
    )
  }
  assert agent_rules.effective_facet_state(verified(None), now)
    == facet_state.Verified
  assert agent_rules.effective_facet_state(verified(Some(now)), now)
    == facet_state.Stale
  assert agent_rules.effective_facet_state(verified(Some(now + 1)), now)
    == facet_state.Verified
  // verificationGap over a profile whose licence clock is NaN: the nearest typed profile is one that is due now.
  let profile =
    agent_rules.Profile(
      row: profile_row.new(
        id: id.agent_profile("agp-lead"),
        user_id: id.org_user("usr-lead"),
        agency_org_id: id.org("org-ag"),
        display_name: "Lead",
        created_at: 1,
        updated_at: 1,
        rev: 1,
      ),
      jurisdictions: [jurisdiction.INT],
      facets: option.values([verified(Some(now))]),
      history: [],
    )
  assert agent_rules.verification_gap(Some(profile), jurisdiction.INT, now)
    == Some(agent_rules.VerificationRequired(
      agent_facet.FifaLicence,
      None,
      facet_state.Stale,
    ))
}

// ------------------------------------------------------------------------------------------------ affiliations

/// C1 and the dates checks: a membership with no start, or a start or end that isn't an instant, is not active in
/// TypeScript. Here a start is required and both are instants; the schema refuses anything else.
pub fn an_affiliation_starts_and_ends_at_instants_test() {
  let s = planted()
  assert !stores(s, affiliation_sql("aff-none", "NULL", "NULL"))
  list.each(not_instants, fn(v) {
    assert !stores(s, affiliation_sql("aff-s", v, "NULL"))
    assert !stores(s, affiliation_sql("aff-e", "1", v))
  })
  assert agent_rules.affiliation_active(now, None, now)
  assert !agent_rules.affiliation_active(now + 1, None, now)
  assert !agent_rules.affiliation_active(now, Some(now), now)
}

// ------------------------------------------------------------------------------------------------ agreements

/// The status and access checks over agreements Gleam can't hold: no agreement, no named agent, a stored status
/// outside the vocabulary (`signed`, `constructor`), and a term boundary that isn't an instant. TypeScript grants
/// nothing and moves nothing for each.
pub fn an_agreement_names_its_agent_and_holds_a_known_status_test() {
  list.each(["signed", "constructor", "__proto__", "toString"], fn(t) {
    assert agreement_row.status_from_string(t) == Error(Nil)
  })
  let s = planted()
  assert !stores(s, agreement_sql("r1", "NULL", "'active'", "1", "NULL"))
  assert !stores(s, agreement_sql("r2", "''", "'active'", "1", "NULL"))
  assert !stores(s, agreement_sql("r3", "'usr-lead'", "'signed'", "1", "NULL"))
  assert !stores(
    s,
    agreement_sql("r4", "'usr-lead'", "'constructor'", "1", "NULL"),
  )
  list.each(not_instants, fn(v) {
    assert !stores(s, agreement_sql("r5", "'usr-lead'", "'active'", v, "NULL"))
    assert !stores(s, agreement_sql("r6", "'usr-lead'", "'active'", "1", v))
  })
  assert stores(s, agreement_sql("r7", "'usr-lead'", "'active'", "1", "NULL"))
  // The typed boundaries nearest them: an end at `now` is over, a start after `now` has not come.
  let a = agreement()
  assert agent_rules.grants_access(a, id.org_user("a1"), now)
  assert !agent_rules.grants_access(a, id.org_user("a2"), now)
  let over = agreement_row.Row(..a, end_at: Some(now))
  assert agent_rules.effective_status(over, now) == agreement_status.Expired
  assert !agent_rules.grants_access(over, id.org_user("a1"), now)
  assert !agent_rules.client_transition_allowed(
    over,
    agreement_status.TerminatedByClient,
    now,
  )
  assert !agent_rules.agent_transition_allowed(
    over,
    agreement_status.TerminatedByAgent,
    now,
  )
  let later = agreement_row.Row(..a, start_at: Some(now + 1))
  assert agent_rules.effective_status(later, now) == agreement_status.Active
  assert !agent_rules.grants_access(later, id.org_user("a1"), now)
}

/// D33, D34, D36 and D37: the agent never sees the client's dispute reason, the client does, and every record says
/// it is not a representation contract.
pub fn the_projections_keep_the_dispute_reason_for_the_client_test() {
  let row =
    agreement_row.Row(
      ..agreement(),
      status: agreement_row.Disputed,
      disputed_at: Some(now),
      dispute_reason: Some("PRIVATE_REASON_TEXT"),
    )
  let disputed =
    event_row.Row(
      ..event_row.new(
        id: id.agreement_event("h1"),
        agreement_id: row.id,
        ord: 0,
        at: now,
        by_kind: agent_actor_kind.Player,
        action: event_row.RepresentationDisputed,
      ),
      by_name: Some("P"),
      detail_by: Some(terminator.Client),
      detail_from: Some(agreement_status.Active),
      detail_to: Some(agreement_status.Disputed),
      detail_had_reason: Some(True),
    )
  let a =
    agent_rules.Agreement(row:, scope: [], policy_versions: [], history: [
      disputed,
    ])
  let for_agent = agent_rules.agreement_for_agent(a, now)
  let agent_text = json.to_string(json.object(for_agent))
  assert !string.contains(agent_text, "PRIVATE_REASON_TEXT")
  assert string.contains(agent_text, "\"hadReason\":true")
  let assert Ok(honest) = list.key_find(for_agent, "honest")
  let honest = json.to_string(honest)
  assert string.contains(honest, "not a representation contract")
  assert string.contains(honest, "has not assessed")
  assert string.contains(honest, "client confirmed it")
  assert list.key_find(for_agent, "legacy") == Error(Nil)
  let for_client = agent_rules.agreement_for_client(a, now)
  assert list.key_find(for_client, "disputeReason")
    == Ok(json.string("PRIVATE_REASON_TEXT"))
  assert list.key_find(for_client, "pending") == Ok(json.bool(False))
}
