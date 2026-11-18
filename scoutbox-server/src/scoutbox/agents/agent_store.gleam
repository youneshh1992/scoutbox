//// The agent core's records as repositories/agentCore.mjs keeps them: agent profiles (their declared jurisdictions,
//// facets and history), agency memberships (their roles and history), representation agreements (their scope,
//// policy versions, per-act keys and history) and agency settings.
////
//// A record changes through named acts. An act that moves a status is guarded by the statuses it may move from:
//// a row anywhere else means a route's gate let through a move it should have refused, so the unit stops. History
//// entries are only ever appended, each at the owner's next position.

import gleam/dynamic/decode
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/agents/agent_rules.{
  type Affiliation, type Agreement, type Profile, Affiliation, Agreement,
  Profile,
}
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/agency_affiliation_history as affiliation_event_row
import scoutbox/rows/agency_affiliation_history_tiers as tier_row
import scoutbox/rows/agency_affiliations as affiliation_row
import scoutbox/rows/agent_profile_facets as facet_row
import scoutbox/rows/agent_profile_history as profile_event_row
import scoutbox/rows/agent_profiles as profile_row
import scoutbox/rows/agreement_history as event_row
import scoutbox/rows/agreement_scopes as scope_row
import scoutbox/rows/id
import scoutbox/rows/representation_agreements as agreement_row
import scoutbox/vocab/agency_tier.{type AgencyTier}
import scoutbox/vocab/agent_actor_kind.{type AgentActorKind}
import scoutbox/vocab/agent_facet.{type AgentFacet}
import scoutbox/vocab/facet_state
import scoutbox/vocab/jurisdiction.{type Jurisdiction}
import sqlight

/// Who did something, as a history entry records them.
pub type Actor {
  Actor(kind: AgentActorKind, id: Option(String), name: Option(String))
}

/// A rev bump: when, and who (their id and name).
pub type Bump {
  Bump(at: Int, by_id: Option(String), by_name: Option(String))
}

pub fn bump_by(at: Int, actor: Actor) -> Bump {
  Bump(at, actor.id, actor.name)
}

fn children(
  read: Read,
  columns: String,
  table: String,
  owner: String,
  owner_id: sqlight.Value,
  order: String,
  decoder: decode.Decoder(a),
) -> Result(List(a), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> columns
      <> " FROM "
      <> table
      <> " WHERE "
      <> owner
      <> " = ? ORDER BY "
      <> order,
    [owner_id],
    decoder,
  )
}

fn next_ord(
  tx: Tx,
  table: String,
  owner: String,
  owner_id: sqlight.Value,
) -> Result(Int, Fail(e)) {
  store.one(
    store.reading(tx),
    "SELECT COALESCE(MAX(ord) + 1, 0) FROM "
      <> table
      <> " WHERE "
      <> owner
      <> " = ?",
    [owner_id],
    decode.at([0], decode.int),
  )
  |> result.map(result.unwrap(_, 0))
}

/// A guarded UPDATE that must change exactly one row: anything else is a gate that let a move through.
fn guarded(
  tx: Tx,
  sql: String,
  args: List(sqlight.Value),
  what: String,
) -> Result(Nil, Fail(e)) {
  use changed <- result.try(store.write(
    tx,
    sql <> " RETURNING 1",
    args,
    decode.at([0], decode.int),
  ))
  case changed {
    [_] -> Ok(Nil)
    _ -> panic as { "AGENT_CORE_STATE_CONFLICT: " <> what }
  }
}

fn bump_row(
  tx: Tx,
  table: String,
  key: sqlight.Value,
  bump: Bump,
) -> Result(Nil, Fail(e)) {
  store.run(
    tx,
    "UPDATE "
      <> table
      <> " SET rev = rev + 1, rev_at = ?, rev_by_id = ?, rev_by_name = ? WHERE id = ?",
    [
      sqlight.int(bump.at),
      sqlight.nullable(sqlight.text, bump.by_id),
      sqlight.nullable(sqlight.text, bump.by_name),
      key,
    ],
  )
}

/// Newest first by rowid, `limit + 1` of them when there is a next page: `#(rowid, row)`.
fn page_of(
  read: Read,
  table: String,
  columns: String,
  width: Int,
  after: Option(Int),
  limit: Int,
  decoder: decode.Decoder(a),
) -> Result(List(#(Int, a)), Fail(e)) {
  let after = case after {
    Some(n) -> sqlight.int(n)
    None -> sqlight.null()
  }
  store.query(
    read,
    "SELECT "
      <> columns
      <> ", rowid FROM "
      <> table
      <> " WHERE (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?",
    [after, after, sqlight.int(limit + 1)],
    {
      use rowid <- decode.field(width, decode.int)
      use r <- decode.then(decoder)
      decode.success(#(rowid, r))
    },
  )
}

// ---------------------------------------------------------------------------------------------- profiles

fn profile(read: Read, row: profile_row.Row) -> Result(Profile, Fail(e)) {
  let pid = id.agent_profile_sql(row.id)
  use jurisdictions <- result.try(children(
    read,
    "jurisdiction",
    "agent_profile_jurisdictions",
    "profile_id",
    pid,
    "ord",
    decode.at([0], jurisdiction.decoder()),
  ))
  use facets <- result.try(children(
    read,
    facet_row.columns,
    "agent_profile_facets",
    "profile_id",
    pid,
    "rowid",
    facet_row.decoder(),
  ))
  use history <- result.map(children(
    read,
    profile_event_row.columns,
    "agent_profile_history",
    "profile_id",
    pid,
    "ord",
    profile_event_row.decoder(),
  ))
  Profile(row:, jurisdictions:, facets:, history:)
}

fn profiles_where(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(List(Profile), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT " <> profile_row.columns <> " FROM agent_profiles WHERE " <> where,
    args,
    profile_row.decoder(),
  ))
  list.try_map(rows, profile(read, _))
}

fn first(r: Result(List(a), Fail(e))) -> Result(Option(a), Fail(e)) {
  result.map(r, fn(xs) { list.first(xs) |> option.from_result })
}

pub fn profile_for_user(
  read: Read,
  user: id.OrgUserId,
) -> Result(Option(Profile), Fail(e)) {
  profiles_where(read, "user_id = ?", [id.org_user_sql(user)]) |> first
}

pub fn profile_by_id(
  read: Read,
  profile_id: id.AgentProfileId,
) -> Result(Option(Profile), Fail(e)) {
  profiles_where(read, "id = ?", [id.agent_profile_sql(profile_id)]) |> first
}

/// The agency's profiles, oldest first.
pub fn profiles_for_agency(
  read: Read,
  org: id.OrgId,
) -> Result(List(Profile), Fail(e)) {
  profiles_where(read, "agency_org_id = ? ORDER BY rowid", [id.org_sql(org)])
}

/// Profiles holding a VERIFIED facet whose re-check date passed by `now` and whose agent was not yet told (the
/// sweep).
pub fn profiles_stale_unnotified(
  read: Read,
  now: Int,
) -> Result(List(Profile), Fail(e)) {
  profiles_where(
    read,
    "id IN (SELECT profile_id FROM agent_profile_facets WHERE state = 'VERIFIED' AND stale_notified_at IS NULL AND recheck_at IS NOT NULL AND recheck_at <= ?) ORDER BY rowid",
    [sqlight.int(now)],
  )
}

/// The sweep told the agent this facet went STALE: whether this call marked it (False when it was already marked).
pub fn mark_stale_notified(
  tx: Tx,
  facet: facet_row.Row,
  at: Int,
) -> Result(Bool, Fail(e)) {
  store.write(
    tx,
    "UPDATE agent_profile_facets SET stale_notified_at = ? WHERE profile_id = ? AND facet = ? AND member_association = ? AND stale_notified_at IS NULL RETURNING 1",
    [
      sqlight.int(at),
      id.agent_profile_sql(facet.profile_id),
      sqlight.text(agent_facet.to_string(facet.facet)),
      sqlight.text(jurisdiction.to_string(facet.member_association)),
    ],
    decode.at([0], decode.int),
  )
  |> result.map(fn(changed) { changed != [] })
}

/// Every profile, newest first, by cursor (the shared-key oversight list).
pub fn profile_page(
  read: Read,
  after: Option(Int),
  limit: Int,
) -> Result(List(#(Int, Profile)), Fail(e)) {
  use rows <- result.try(page_of(
    read,
    "agent_profiles",
    profile_row.columns,
    profile_row.width,
    after,
    limit,
    profile_row.decoder(),
  ))
  list.try_map(rows, fn(p) {
    profile(read, p.1) |> result.map(fn(x) { #(p.0, x) })
  })
}

/// What a profile history entry says.
pub type ProfileDetail {
  ProfileCreated
  /// Which declared details changed.
  ProfileUpdated(display_name: Bool, jurisdictions: Bool, licence_number: Bool)
  FacetSubmitted(facet: AgentFacet, ma: Option(Jurisdiction))
  FacetStateChanged(
    facet: AgentFacet,
    ma: Option(Jurisdiction),
    from: facet_state.FacetState,
    to: facet_state.FacetState,
  )
  /// A recheck against the register: the effective states before and after it.
  FacetRechecked(
    facet: AgentFacet,
    ma: Option(Jurisdiction),
    from: facet_state.FacetState,
    to: facet_state.FacetState,
  )
  /// A recheck that changed the effective state: `state` is the stored one it left.
  FacetRecheckChanged(
    facet: AgentFacet,
    ma: Option(Jurisdiction),
    from: facet_state.FacetState,
    to: facet_state.FacetState,
    state: facet_state.FacetState,
  )
}

pub fn profile_event(
  tx: Tx,
  profile_id: id.AgentProfileId,
  at: Int,
  by: Actor,
  detail: ProfileDetail,
) -> Result(Nil, Fail(e)) {
  use event_id <- result.try(id.next_profile_event(tx))
  use ord <- result.try(next_ord(
    tx,
    "agent_profile_history",
    "profile_id",
    id.agent_profile_sql(profile_id),
  ))
  let action = case detail {
    ProfileCreated -> profile_event_row.AgentProfileCreated
    ProfileUpdated(..) -> profile_event_row.AgentProfileUpdated
    FacetSubmitted(..) -> profile_event_row.AgentVerificationSubmitted
    FacetStateChanged(..) | FacetRecheckChanged(..) ->
      profile_event_row.AgentVerificationStateChanged
    FacetRechecked(..) -> profile_event_row.AgentFacetRechecked
  }
  let base =
    profile_event_row.Row(
      ..profile_event_row.new(
        id: event_id,
        profile_id:,
        ord:,
        at:,
        by_kind: by.kind,
        action:,
      ),
      by_id: by.id,
      by_name: by.name,
    )
  profile_event_row.insert(tx, case detail {
    ProfileCreated -> base
    ProfileUpdated(display_name:, jurisdictions:, licence_number:) ->
      profile_event_row.Row(
        ..base,
        detail_display_name: Some(display_name),
        detail_jurisdictions: Some(jurisdictions),
        detail_licence_number: Some(licence_number),
      )
    FacetSubmitted(facet:, ma:) ->
      profile_event_row.Row(..base, detail_facet: Some(facet), detail_ma: ma)
    FacetStateChanged(facet:, ma:, from:, to:) ->
      profile_event_row.Row(
        ..base,
        detail_facet: Some(facet),
        detail_ma: ma,
        detail_from: Some(from),
        detail_to: Some(to),
        detail_state: Some(to),
      )
    FacetRechecked(facet:, ma:, from:, to:) ->
      profile_event_row.Row(
        ..base,
        detail_facet: Some(facet),
        detail_ma: ma,
        detail_from: Some(from),
        detail_to: Some(to),
      )
    FacetRecheckChanged(facet:, ma:, from:, to:, state:) ->
      profile_event_row.Row(
        ..base,
        detail_facet: Some(facet),
        detail_ma: ma,
        detail_from: Some(from),
        detail_to: Some(to),
        detail_state: Some(state),
      )
  })
}

/// A new profile: the row, its jurisdictions, an empty FIFA licence facet and the creation entry.
pub fn create_profile(
  tx: Tx,
  row: profile_row.Row,
  jurisdictions: List(Jurisdiction),
  by: Actor,
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(profile_row.insert(tx, row))
  use _ <- result.try(set_jurisdictions(tx, row.id, jurisdictions))
  use _ <- result.try(set_facet(
    tx,
    facet_row.new(
      profile_id: row.id,
      facet: agent_facet.FifaLicence,
      member_association: jurisdiction.INT,
      state: facet_state.Unverified,
    ),
  ))
  profile_event(tx, row.id, row.created_at, by, ProfileCreated)
}

fn set_jurisdictions(
  tx: Tx,
  profile_id: id.AgentProfileId,
  jurisdictions: List(Jurisdiction),
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(
    store.run(
      tx,
      "DELETE FROM agent_profile_jurisdictions WHERE profile_id = ?",
      [id.agent_profile_sql(profile_id)],
    ),
  )
  list.index_map(jurisdictions, fn(j, i) { #(i, j) })
  |> list.try_each(fn(p) {
    store.run(
      tx,
      "INSERT INTO agent_profile_jurisdictions (profile_id, ord, jurisdiction) VALUES (?, ?, ?)",
      [
        id.agent_profile_sql(profile_id),
        sqlight.int(p.0),
        sqlight.text(jurisdiction.to_string(p.1)),
      ],
    )
  })
}

/// The declared details the agent changed; `None` leaves one as it is.
pub fn update_declared(
  tx: Tx,
  profile_id: id.AgentProfileId,
  display_name: Option(String),
  jurisdictions: Option(List(Jurisdiction)),
  licence_number: Option(Option(String)),
) -> Result(Nil, Fail(e)) {
  let key = id.agent_profile_sql(profile_id)
  use _ <- result.try(case display_name {
    Some(name) ->
      store.run(tx, "UPDATE agent_profiles SET display_name = ? WHERE id = ?", [
        sqlight.text(name),
        key,
      ])
    None -> Ok(Nil)
  })
  use _ <- result.try(case licence_number {
    Some(n) ->
      store.run(
        tx,
        "UPDATE agent_profiles SET declared_fifa_licence_number = ? WHERE id = ?",
        [sqlight.nullable(sqlight.text, n), key],
      )
    None -> Ok(Nil)
  })
  case jurisdictions {
    Some(js) -> set_jurisdictions(tx, profile_id, js)
    None -> Ok(Nil)
  }
}

/// A facet's new state, in place (it keeps its position); a stored facet keeps no stale marker from before.
pub fn set_facet(tx: Tx, row: facet_row.Row) -> Result(Nil, Fail(e)) {
  store.run(
    tx,
    facet_row.insert_sql
      <> " ON CONFLICT(profile_id, facet, member_association) DO UPDATE SET state = excluded.state, reference = excluded.reference, provenance_provider = excluded.provenance_provider, provenance_kind = excluded.provenance_kind, provenance_at = excluded.provenance_at, provenance_reviewer_id = excluded.provenance_reviewer_id, provenance_review_id = excluded.provenance_review_id, submitted_at = excluded.submitted_at, verified_at = excluded.verified_at, recheck_at = excluded.recheck_at, note = excluded.note, stale_notified_at = excluded.stale_notified_at",
    facet_row.values(facet_row.Row(..row, stale_notified_at: None)),
  )
}

/// The rev bump, and with `touch` the `updatedAt`, of an act on a profile.
pub fn bump_profile(
  tx: Tx,
  profile_id: id.AgentProfileId,
  bump: Bump,
  touch: Bool,
) -> Result(Nil, Fail(e)) {
  let key = id.agent_profile_sql(profile_id)
  use _ <- result.try(bump_row(tx, "agent_profiles", key, bump))
  case touch {
    True ->
      store.run(tx, "UPDATE agent_profiles SET updated_at = ? WHERE id = ?", [
        sqlight.int(bump.at),
        key,
      ])
    False -> Ok(Nil)
  }
}

// ------------------------------------------------------------------------------------------- affiliations

fn affiliation(
  read: Read,
  row: affiliation_row.Row,
) -> Result(Affiliation, Fail(e)) {
  children(
    read,
    "tier",
    "agency_affiliation_tiers",
    "affiliation_id",
    id.affiliation_sql(row.id),
    "ord",
    decode.at([0], agency_tier.decoder()),
  )
  |> result.map(Affiliation(row, _))
}

fn affiliations_where(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(List(Affiliation), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> affiliation_row.columns
      <> " FROM agency_affiliations WHERE "
      <> where,
    args,
    affiliation_row.decoder(),
  ))
  list.try_map(rows, affiliation(read, _))
}

const active_at = "(started_at <= ? AND (ended_at IS NULL OR ended_at > ?))"

/// The member's membership of the agency that is active at `now`.
pub fn active_affiliation(
  read: Read,
  user: id.OrgUserId,
  org: id.OrgId,
  now: Int,
) -> Result(Option(Affiliation), Fail(e)) {
  affiliations_where(
    read,
    "user_id = ? AND agency_org_id = ? AND "
      <> active_at
      <> " ORDER BY rowid LIMIT 1",
    [id.org_user_sql(user), id.org_sql(org), sqlight.int(now), sqlight.int(now)],
  )
  |> first
}

/// Whether the agency has any membership active at `now`.
pub fn any_active_in(
  read: Read,
  org: id.OrgId,
  now: Int,
) -> Result(Bool, Fail(e)) {
  store.one(
    read,
    "SELECT 1 FROM agency_affiliations WHERE agency_org_id = ? AND "
      <> active_at
      <> " LIMIT 1",
    [id.org_sql(org), sqlight.int(now), sqlight.int(now)],
    decode.at([0], decode.int),
  )
  |> result.map(result.is_ok)
}

/// The agency's memberships, oldest first.
pub fn affiliations_for_agency(
  read: Read,
  org: id.OrgId,
) -> Result(List(Affiliation), Fail(e)) {
  affiliations_where(read, "agency_org_id = ? ORDER BY rowid", [id.org_sql(org)])
}

pub fn affiliation_by_create_key(
  read: Read,
  org: id.OrgId,
  key: String,
) -> Result(Option(Affiliation), Fail(e)) {
  affiliations_where(read, "agency_org_id = ? AND create_key = ?", [
    id.org_sql(org),
    sqlight.text(key),
  ])
  |> first
}

pub fn affiliation_history(
  read: Read,
  affiliation_id: id.AffiliationId,
) -> Result(List(affiliation_event_row.Row), Fail(e)) {
  children(
    read,
    affiliation_event_row.columns,
    "agency_affiliation_history",
    "affiliation_id",
    id.affiliation_sql(affiliation_id),
    "ord",
    affiliation_event_row.decoder(),
  )
}

/// A history entry's role lists: `from` and `to`.
pub fn affiliation_event_tiers(
  read: Read,
  event_id: id.AffiliationEventId,
) -> Result(#(List(AgencyTier), List(AgencyTier)), Fail(e)) {
  use rows <- result.map(
    store.query(
      read,
      "SELECT list, tier FROM agency_affiliation_history_tiers WHERE history_id = ? ORDER BY list, ord",
      [id.affiliation_event_sql(event_id)],
      {
        use l <- decode.field(0, decode.string)
        use t <- decode.field(1, agency_tier.decoder())
        decode.success(#(l, t))
      },
    ),
  )
  #(
    list.filter_map(rows, fn(r) {
      case r.0 {
        "from" -> Ok(r.1)
        _ -> Error(Nil)
      }
    }),
    list.filter_map(rows, fn(r) {
      case r.0 {
        "to" -> Ok(r.1)
        _ -> Error(Nil)
      }
    }),
  )
}

pub type AffiliationDetail {
  AffiliationCreated(tiers: List(AgencyTier), bootstrap: Bool)
  AffiliationUpdated(from: List(AgencyTier), to: List(AgencyTier))
  AffiliationEnded(reason_code: String)
}

pub fn affiliation_event(
  tx: Tx,
  affiliation_id: id.AffiliationId,
  at: Int,
  by: Actor,
  detail: AffiliationDetail,
) -> Result(Nil, Fail(e)) {
  use event_id <- result.try(id.next_affiliation_event(tx))
  use ord <- result.try(next_ord(
    tx,
    "agency_affiliation_history",
    "affiliation_id",
    id.affiliation_sql(affiliation_id),
  ))
  let base =
    affiliation_event_row.Row(
      ..affiliation_event_row.new(
        id: event_id,
        affiliation_id:,
        ord:,
        at:,
        by_kind: by.kind,
        action: affiliation_event_row.AgencyAffiliationCreated,
      ),
      by_id: by.id,
      by_name: by.name,
    )
  let #(row, from, to) = case detail {
    AffiliationCreated(tiers:, bootstrap:) -> #(
      affiliation_event_row.Row(..base, detail_bootstrap: case bootstrap {
        True -> Some(1)
        False -> None
      }),
      [],
      tiers,
    )
    AffiliationUpdated(from:, to:) -> #(
      affiliation_event_row.Row(
        ..base,
        action: affiliation_event_row.AgencyAffiliationUpdated,
      ),
      from,
      to,
    )
    AffiliationEnded(reason_code:) -> #(
      affiliation_event_row.Row(
        ..base,
        action: affiliation_event_row.AgencyAffiliationEnded,
        detail_reason_code: Some(reason_code),
      ),
      [],
      [],
    )
  }
  use _ <- result.try(affiliation_event_row.insert(tx, row))
  let tier_rows =
    list.append(
      list.index_map(from, fn(t, i) { #(tier_row.From, i, t) }),
      list.index_map(to, fn(t, i) { #(tier_row.To, i, t) }),
    )
  list.try_each(tier_rows, fn(t) {
    store.run(
      tx,
      "INSERT INTO agency_affiliation_history_tiers (history_id, list, ord, tier) VALUES (?, ?, ?, ?)",
      [
        id.affiliation_event_sql(event_id),
        sqlight.text(tier_row.list_value_to_string(t.0)),
        sqlight.int(t.1),
        sqlight.text(agency_tier.to_string(t.2)),
      ],
    )
  })
}

fn set_tiers_rows(
  tx: Tx,
  affiliation_id: id.AffiliationId,
  tiers: List(AgencyTier),
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(
    store.run(
      tx,
      "DELETE FROM agency_affiliation_tiers WHERE affiliation_id = ?",
      [id.affiliation_sql(affiliation_id)],
    ),
  )
  list.index_map(tiers, fn(t, i) { #(i, t) })
  |> list.try_each(fn(p) {
    store.run(
      tx,
      "INSERT INTO agency_affiliation_tiers (affiliation_id, ord, tier) VALUES (?, ?, ?)",
      [
        id.affiliation_sql(affiliation_id),
        sqlight.int(p.0),
        sqlight.text(agency_tier.to_string(p.1)),
      ],
    )
  })
}

/// A new membership with its roles and its creation entry.
pub fn create_affiliation(
  tx: Tx,
  row: affiliation_row.Row,
  tiers: List(AgencyTier),
  by: Actor,
  bootstrap: Bool,
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(affiliation_row.insert(tx, row))
  use _ <- result.try(set_tiers_rows(tx, row.id, tiers))
  affiliation_event(
    tx,
    row.id,
    row.created_at,
    by,
    AffiliationCreated(tiers, bootstrap),
  )
}

/// The member's roles, replaced; an ended membership does not change.
pub fn set_tiers(
  tx: Tx,
  affiliation_id: id.AffiliationId,
  tiers: List(AgencyTier),
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(guarded(
    tx,
    "UPDATE agency_affiliations SET id = id WHERE id = ? AND ended_at IS NULL",
    [id.affiliation_sql(affiliation_id)],
    "the membership has ended",
  ))
  set_tiers_rows(tx, affiliation_id, tiers)
}

/// An ended membership does not reopen.
pub fn end_affiliation(
  tx: Tx,
  affiliation_id: id.AffiliationId,
  at: Int,
  reason: String,
) -> Result(Nil, Fail(e)) {
  guarded(
    tx,
    "UPDATE agency_affiliations SET ended_at = ?, ended_reason = ? WHERE id = ? AND ended_at IS NULL",
    [sqlight.int(at), sqlight.text(reason), id.affiliation_sql(affiliation_id)],
    "the membership has already ended",
  )
}

pub fn bump_affiliation(
  tx: Tx,
  affiliation_id: id.AffiliationId,
  bump: Bump,
) -> Result(Nil, Fail(e)) {
  bump_row(tx, "agency_affiliations", id.affiliation_sql(affiliation_id), bump)
}

// --------------------------------------------------------------------------------------------- agreements

fn agreement(read: Read, row: agreement_row.Row) -> Result(Agreement, Fail(e)) {
  let aid = id.agreement_sql(row.id)
  use scope <- result.try(children(
    read,
    "scope",
    "agreement_scopes",
    "agreement_id",
    aid,
    "ord",
    decode.at([0], scope_row.scope_decoder()),
  ))
  use policy_versions <- result.try(children(
    read,
    "policy_version_id",
    "agreement_policy_versions",
    "agreement_id",
    aid,
    "ord",
    decode.at([0], id.policy_decoder()),
  ))
  use history <- result.map(children(
    read,
    event_row.columns,
    "agreement_history",
    "agreement_id",
    aid,
    "ord",
    event_row.decoder(),
  ))
  Agreement(row:, scope:, policy_versions:, history:)
}

fn agreements_where(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(List(Agreement), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> agreement_row.columns
      <> " FROM representation_agreements WHERE "
      <> where,
    args,
    agreement_row.decoder(),
  ))
  list.try_map(rows, agreement(read, _))
}

pub fn agreement_by_id(
  read: Read,
  agreement_id: id.AgreementId,
) -> Result(Option(Agreement), Fail(e)) {
  agreements_where(read, "id = ?", [id.agreement_sql(agreement_id)]) |> first
}

/// The agency's agreements, oldest first.
pub fn agreements_for_agency(
  read: Read,
  org: id.OrgId,
) -> Result(List(Agreement), Fail(e)) {
  agreements_where(read, "agency_org_id = ? ORDER BY rowid", [id.org_sql(org)])
}

/// Every agreement naming this client, oldest first.
pub fn agreements_for_client(
  read: Read,
  client_id: String,
) -> Result(List(Agreement), Fail(e)) {
  agreements_where(
    read,
    "client_kind = 'player' AND client_id = ? ORDER BY rowid",
    [sqlight.text(client_id)],
  )
}

/// One agent's agreements with one client, oldest first.
pub fn agreements_for_agent_client(
  read: Read,
  agent: id.OrgUserId,
  client_id: String,
) -> Result(List(Agreement), Fail(e)) {
  agreements_where(
    read,
    "agent_user_id = ? AND client_kind = 'player' AND client_id = ? ORDER BY rowid",
    [id.org_user_sql(agent), sqlight.text(client_id)],
  )
}

pub fn agreement_by_request_key(
  read: Read,
  org: id.OrgId,
  agent: id.OrgUserId,
  key: String,
) -> Result(Option(Agreement), Fail(e)) {
  agreements_where(
    read,
    "agency_org_id = ? AND agent_user_id = ? AND request_key = ?",
    [id.org_sql(org), id.org_user_sql(agent), sqlight.text(key)],
  )
  |> first
}

/// Active agreements ending within `window` of `now` whose agent was not yet told (the sweep), soonest first.
pub fn agreements_expiring_unnotified(
  read: Read,
  now: Int,
  window: Int,
) -> Result(List(Agreement), Fail(e)) {
  agreements_where(
    read,
    "status = 'active' AND expiry_notified_at IS NULL AND end_at IS NOT NULL AND end_at > ? AND end_at <= ? ORDER BY end_at",
    [sqlight.int(now), sqlight.int(now + window)],
  )
}

/// The sweep told the agent the relationship ends soon: whether this call marked it (False when it was already
/// marked).
pub fn mark_expiry_notified(
  tx: Tx,
  agreement_id: id.AgreementId,
  at: Int,
) -> Result(Bool, Fail(e)) {
  store.write(
    tx,
    "UPDATE representation_agreements SET expiry_notified_at = ? WHERE id = ? AND expiry_notified_at IS NULL RETURNING 1",
    [sqlight.int(at), id.agreement_sql(agreement_id)],
    decode.at([0], decode.int),
  )
  |> result.map(fn(changed) { changed != [] })
}

/// Every agreement, newest first, by cursor (the shared-key oversight list).
pub fn agreement_page(
  read: Read,
  after: Option(Int),
  limit: Int,
) -> Result(List(#(Int, Agreement)), Fail(e)) {
  use rows <- result.try(page_of(
    read,
    "representation_agreements",
    agreement_row.columns,
    agreement_row.width,
    after,
    limit,
    agreement_row.decoder(),
  ))
  list.try_map(rows, fn(p) {
    agreement(read, p.1) |> result.map(fn(x) { #(p.0, x) })
  })
}

/// A new agreement: the row, its scope and policy versions, and its request entry.
pub fn create_agreement(
  tx: Tx,
  row: agreement_row.Row,
  scope: List(scope_row.Scope),
  policy_versions: List(id.PolicyId),
  by: Actor,
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(agreement_row.insert(tx, row))
  use _ <- result.try(
    list.index_map(scope, fn(s, i) { #(i, s) })
    |> list.try_each(fn(p) {
      store.run(
        tx,
        "INSERT INTO agreement_scopes (agreement_id, ord, scope) VALUES (?, ?, ?)",
        [
          id.agreement_sql(row.id),
          sqlight.int(p.0),
          sqlight.text(scope_row.scope_to_string(p.1)),
        ],
      )
    }),
  )
  use _ <- result.try(
    list.index_map(policy_versions, fn(v, i) { #(i, v) })
    |> list.try_each(fn(p) {
      store.run(
        tx,
        "INSERT INTO agreement_policy_versions (agreement_id, ord, policy_version_id) VALUES (?, ?, ?)",
        [id.agreement_sql(row.id), sqlight.int(p.0), id.policy_sql(p.1)],
      )
    }),
  )
  agreement_event(
    tx,
    row.id,
    row.proposed_at,
    by,
    fn(r) { r },
    event_row.RepresentationRequested,
  )
}

/// Appends an entry; `detail` fills its detail columns.
pub fn agreement_event(
  tx: Tx,
  agreement_id: id.AgreementId,
  at: Int,
  by: Actor,
  detail: fn(event_row.Row) -> event_row.Row,
  action: event_row.Action,
) -> Result(Nil, Fail(e)) {
  use event_id <- result.try(id.next_agreement_event(tx))
  use ord <- result.try(next_ord(
    tx,
    "agreement_history",
    "agreement_id",
    id.agreement_sql(agreement_id),
  ))
  event_row.insert(
    tx,
    detail(
      event_row.Row(
        ..event_row.new(
          id: event_id,
          agreement_id:,
          ord:,
          at:,
          by_kind: by.kind,
          action:,
        ),
        by_id: by.id,
        by_name: by.name,
      ),
    ),
  )
}

/// A guarded status move: `set` (its columns and values) only while the status is one of `from`.
pub fn move_agreement(
  tx: Tx,
  agreement_id: id.AgreementId,
  from: List(String),
  set: List(#(String, sqlight.Value)),
  what: String,
) -> Result(Nil, Fail(e)) {
  let assignments = list.map(set, fn(c) { c.0 <> " = ?" }) |> string.join(", ")
  let statuses = list.map(from, fn(s) { "'" <> s <> "'" }) |> string.join(", ")
  guarded(
    tx,
    "UPDATE representation_agreements SET "
      <> assignments
      <> " WHERE id = ? AND status IN ("
      <> statuses
      <> ")",
    list.append(list.map(set, fn(c) { c.1 }), [id.agreement_sql(agreement_id)]),
    what,
  )
}

/// Columns set without a guard (the sharing choices).
pub fn set_agreement(
  tx: Tx,
  agreement_id: id.AgreementId,
  set: List(#(String, sqlight.Value)),
) -> Result(Nil, Fail(e)) {
  case set {
    [] -> Ok(Nil)
    _ ->
      store.run(
        tx,
        "UPDATE representation_agreements SET "
          <> { list.map(set, fn(c) { c.0 <> " = ?" }) |> string.join(", ") }
          <> " WHERE id = ?",
        list.append(list.map(set, fn(c) { c.1 }), [
          id.agreement_sql(agreement_id),
        ]),
      )
  }
}

pub fn bump_agreement(
  tx: Tx,
  agreement_id: id.AgreementId,
  bump: Bump,
) -> Result(Nil, Fail(e)) {
  bump_row(
    tx,
    "representation_agreements",
    id.agreement_sql(agreement_id),
    bump,
  )
}

/// A client's account removal: each of their agreements becomes an id-only tombstone (the removal instant, no
/// dispute text, a pending request declined) and the client's name leaves its history.
pub fn redact_client(
  tx: Tx,
  client_id: String,
  at: Int,
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(
    store.run(
      tx,
      "UPDATE representation_agreements SET subject_removed_at = ?, dispute_reason = NULL,
       declined_at = CASE WHEN status = 'proposed' THEN ? ELSE declined_at END,
       status = CASE WHEN status = 'proposed' THEN 'declined' ELSE status END
     WHERE client_kind = 'player' AND client_id = ?",
      [sqlight.int(at), sqlight.int(at), sqlight.text(client_id)],
    ),
  )
  store.run(
    tx,
    "UPDATE agreement_history SET by_id = NULL, by_name = NULL WHERE by_kind = 'player' AND agreement_id IN
       (SELECT id FROM representation_agreements WHERE client_kind = 'player' AND client_id = ?)",
    [sqlight.text(client_id)],
  )
}

// ----------------------------------------------------------------------------------------------- settings

/// The agency's settings: its jurisdictions, in order, and its description; empty when none were saved.
pub fn settings(
  read: Read,
  org: id.OrgId,
) -> Result(#(List(Jurisdiction), String), Fail(e)) {
  use description <- result.try(store.one(
    read,
    "SELECT description FROM org_agency_settings WHERE org_id = ?",
    [id.org_sql(org)],
    decode.at([0], decode.string),
  ))
  case description {
    Error(Nil) -> Ok(#([], ""))
    Ok(d) ->
      children(
        read,
        "jurisdiction",
        "org_agency_jurisdictions",
        "org_id",
        id.org_sql(org),
        "ord",
        decode.at([0], jurisdiction.decoder()),
      )
      |> result.map(fn(js) { #(js, d) })
  }
}

/// Replaces the agency's settings.
pub fn save_settings(
  tx: Tx,
  org: id.OrgId,
  jurisdictions: List(Jurisdiction),
  description: String,
  now: Int,
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(
    store.run(
      tx,
      "INSERT INTO org_agency_settings (org_id, description, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(org_id) DO UPDATE SET description = excluded.description, updated_at = excluded.updated_at",
      [id.org_sql(org), sqlight.text(description), sqlight.int(now)],
    ),
  )
  use _ <- result.try(
    store.run(tx, "DELETE FROM org_agency_jurisdictions WHERE org_id = ?", [
      id.org_sql(org),
    ]),
  )
  list.index_map(jurisdictions, fn(j, i) { #(i, j) })
  |> list.try_each(fn(p) {
    store.run(
      tx,
      "INSERT INTO org_agency_jurisdictions (org_id, ord, jurisdiction) VALUES (?, ?, ?)",
      [
        id.org_sql(org),
        sqlight.int(p.0),
        sqlight.text(jurisdiction.to_string(p.1)),
      ],
    )
  })
}
