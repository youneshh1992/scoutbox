//// The Football Passport's sources, read from the stores (assemble and historyInputs in
//// domains/passport/passport.mjs): everything `passport_rules` builds the Passport from. The Passport owns only
//// its preferences, career entries, achievements, shares and corrections; the rest belongs to other domains.

import gleam/dict
import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/agents/agent_rules
import scoutbox/agents/agent_store
import scoutbox/development/combine
import scoutbox/identity/players.{type Player}
import scoutbox/identity/staff
import scoutbox/passport/passport_rules.{
  type Full, type History, type Prefs, type SigningRow, type SquadSource,
} as rules
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/recruitment/trial_rules
import scoutbox/recruitment/trials
import scoutbox/rows/applications as application_row
import scoutbox/rows/assessments as assessment_row
import scoutbox/rows/dev_objectives as objective_row
import scoutbox/rows/evidence as evidence_row
import scoutbox/rows/id
import scoutbox/rows/opportunities as opportunity_row
import scoutbox/rows/org_squad_members as squad_row
import scoutbox/rows/orgs
import scoutbox/rows/outcome_reports as outcome_row
import scoutbox/rows/passport_achievements as achievement_row
import scoutbox/rows/passport_career_entries as career_row
import scoutbox/rows/passport_position_history as position_history_row
import scoutbox/rows/passport_position_history_positions as history_position_row
import scoutbox/rows/passport_pref_positions as pref_position_row
import scoutbox/rows/passport_prefs as prefs_row
import scoutbox/rows/passport_public_selections as selection_row
import scoutbox/rows/signings as signing_row
import scoutbox/rows/transition_cases as transition_row
import scoutbox/rows/trial_attendance as attendance_row
import scoutbox/rows/ver_claims
import scoutbox/rows/ver_player_invites as invite_row
import scoutbox/rows/ver_references as reference_row
import scoutbox/rules/age
import sqlight

const day_ms = 86_400_000

fn rows(
  read: Read,
  columns: String,
  table: String,
  where: String,
  player_id: id.PlayerId,
  decoder: decode.Decoder(a),
) -> Result(List(a), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> columns
      <> " FROM "
      <> table
      <> " WHERE "
      <> where
      <> " ORDER BY rowid",
    [id.player_sql(player_id)],
    decoder,
  )
}

fn org_of(read: Read, org_id: id.OrgId) -> Result(Option(orgs.Row), Fail(e)) {
  store.one(
    read,
    "SELECT " <> orgs.columns <> " FROM orgs WHERE id = ?",
    [id.org_sql(org_id)],
    orgs.decoder(),
  )
  |> result.map(option.from_result)
}

fn org_name(read: Read, org_id: id.OrgId) -> Result(Option(String), Fail(e)) {
  org_of(read, org_id) |> result.map(option.map(_, fn(o) { o.name }))
}

// ------------------------------------------------------------------------------------------------ history

/// What club history and the timeline's club facts are built from (historyInputs).
pub type HistoryInputs {
  HistoryInputs(
    squads: List(SquadSource),
    signings: List(rules.SigningSource),
    outcomes: List(rules.OutcomeSource),
    signing_rows: List(SigningRow),
    career_entries: List(career_row.Row),
  )
}

pub fn history_inputs(
  read: Read,
  player_id: id.PlayerId,
) -> Result(HistoryInputs, Fail(e)) {
  use signings <- result.try(rows(
    read,
    signing_row.columns,
    "signings",
    "player_id = ?",
    player_id,
    signing_row.decoder(),
  ))
  use outcomes <- result.try(rows(
    read,
    outcome_row.columns,
    "outcome_reports",
    "player_id = ?",
    player_id,
    outcome_row.decoder(),
  ))
  use squad <- result.try(rows(
    read,
    squad_row.columns,
    "org_squad_members",
    "player_id = ?",
    player_id,
    squad_row.decoder(),
  ))
  use invites <- result.try(rows(
    read,
    invite_row.columns,
    "ver_player_invites",
    "player_id = ? AND status = 'accepted'",
    player_id,
    invite_row.decoder(),
  ))
  use careers <- result.try(rows(
    read,
    career_row.columns,
    "passport_career_entries",
    "player_id = ?",
    player_id,
    career_row.decoder(),
  ))
  // A club's shadow list is not a relationship, and a suspended organisation lends no current one.
  use squads <- result.try(
    list.try_fold(squad, [], fn(acc, s) {
      use o <- result.map(org_of(read, s.org_id))
      case o {
        Some(o) if !o.suspended -> [
          rules.SquadSource(
            org_id: o.id,
            org_name: o.name,
            row_id: id.squad_entry_to_string(s.id),
            added_at: s.added_at,
            org_verified: o.verified,
          ),
          ..acc
        ]
        _ -> acc
      }
    })
    |> result.map(list.reverse),
  )
  use squads <- result.try(
    list.try_fold(invites, squads, fn(acc, inv) {
      case list.any(acc, fn(s) { s.org_id == inv.org_id }) {
        True -> Ok(acc)
        False -> {
          use o <- result.map(org_of(read, inv.org_id))
          case o {
            Some(o) if !o.suspended ->
              list.append(acc, [
                rules.SquadSource(
                  org_id: o.id,
                  org_name: o.name,
                  row_id: id.player_invite_to_string(inv.id),
                  added_at: option.unwrap(inv.accepted_at, 0),
                  org_verified: o.verified,
                ),
              ])
            _ -> acc
          }
        }
      }
    }),
  )
  use outcome_sources <- result.try(
    list.try_map(outcomes, fn(o) {
      use name <- result.map(org_name(read, o.org_id))
      rules.OutcomeSource(
        id: o.id,
        org_id: o.org_id,
        org_name: name,
        at: o.at,
        note: option.or(
          o.progression,
          Some(outcome_row.registration_status_to_string(o.registration_status)),
        ),
      )
    }),
  )
  use signing_rows <- result.map(
    list.try_map(signings, fn(s) {
      use o <- result.map(org_of(read, s.org_id))
      let ended =
        list.find(outcomes, fn(r) {
          r.signing_id == s.id
          && list.contains(
            ["released", "ended", "left"],
            outcome_row.registration_status_to_string(r.registration_status),
          )
        })
      // Suspension suppresses the current relationship at read time; the historical signing fact is untouched.
      rules.SigningRow(
        id: s.id,
        org_id: s.org_id,
        org_name: s.org_name,
        ts: s.ts,
        ended_at: result.map(ended, fn(r) { r.at }) |> option.from_result,
        org_suspended: case o {
          Some(o) -> o.suspended
          None -> False
        },
      )
    }),
  )
  HistoryInputs(
    squads:,
    signings: list.map(signings, fn(s) {
      rules.SigningSource(
        id: s.id,
        org_id: s.org_id,
        org_name: s.org_name,
        ts: s.ts,
      )
    }),
    outcomes: outcome_sources,
    signing_rows:,
    career_entries: careers,
  )
}

/// A player's club history (historyFor), which the Trust Score and a Room's snapshot read too.
pub fn history(read: Read, player_id: id.PlayerId) -> Result(History, Fail(e)) {
  use h <- result.map(history_inputs(read, player_id))
  rules.club_history(h.signing_rows, h.squads, h.career_entries)
}

// ------------------------------------------------------------------------------------------------ preferences

/// A player's Passport preferences, or blank ones when they never saved any.
pub fn prefs(read: Read, player_id: id.PlayerId) -> Result(Prefs, Fail(e)) {
  use row <- result.try(
    store.one(
      read,
      "SELECT "
        <> prefs_row.columns
        <> " FROM passport_prefs WHERE player_id = ?",
      [id.player_sql(player_id)],
      prefs_row.decoder(),
    )
    |> result.map(option.from_result),
  )
  case row {
    None -> Ok(rules.blank_prefs)
    Some(row) -> {
      use secondary <- result.try(store.query(
        read,
        "SELECT "
          <> pref_position_row.columns
          <> " FROM passport_pref_positions WHERE player_id = ? ORDER BY ord",
        [id.player_sql(player_id)],
        pref_position_row.decoder(),
      ))
      use selections <- result.try(store.query(
        read,
        "SELECT "
          <> selection_row.columns
          <> " FROM passport_public_selections WHERE player_id = ? ORDER BY ord",
        [id.player_sql(player_id)],
        selection_row.decoder(),
      ))
      use entries <- result.try(rows(
        read,
        position_history_row.columns,
        "passport_position_history",
        "player_id = ?",
        player_id,
        position_history_row.decoder(),
      ))
      use history <- result.map(
        list.try_map(entries, fn(h) {
          use others <- result.map(store.query(
            read,
            "SELECT "
              <> history_position_row.columns
              <> " FROM passport_position_history_positions WHERE history_id = ? ORDER BY ord",
            [id.position_entry_sql(h.id)],
            history_position_row.decoder(),
          ))
          rules.PositionSource(
            id: h.id,
            from: h.from_date,
            primary: h.position_primary,
            secondary: list.map(others, fn(o) { o.code }),
          )
        }),
      )
      let secondary = list.map(secondary, fn(s) { s.code })
      rules.Prefs(
        bio: row.bio,
        // An object with neither is stored, and read back, as none.
        positions: case row.position_primary, secondary {
          None, [] -> None
          primary, secondary -> Some(rules.Positions(primary, secondary))
        },
        availability: row.availability,
        available_from: row.available_from,
        public_selections: list.map(selections, fn(s) { s.selection }),
        position_history: history,
      )
    }
  }
}

// ------------------------------------------------------------------------------------------------ the rest

fn trial_source(t: trial_rules.Trial) -> rules.TrialSource {
  let r = t.row
  let attendance = case trial_rules.is_legacy(t) {
    True -> rules.Legacy
    False -> {
      let attended =
        trial_rules.current_attendance(t)
        |> dict.values
        |> list.filter(fn(a) {
          a.state == attendance_row.Attended
          || a.state == attendance_row.Partial
        })
      let first =
        attended
        |> list.filter_map(fn(a) {
          list.find(t.sessions, fn(s) { s.row.id == a.session_id })
          |> result.map(fn(s) { s.row.starts_at })
        })
        |> list.sort(int.compare)
        |> list.first
      case attended {
        [] -> rules.NotAttended
        [one, ..] ->
          rules.AttendedFrom(
            at: result.unwrap(first, one.recorded_at),
            sessions: list.length(attended),
          )
      }
    }
  }
  rules.TrialSource(
    id: r.id,
    org_id: r.org_id,
    org_name: Some(r.org_name),
    proposed_date: r.proposed_date,
    accepted_at: r.accepted_at,
    attendance:,
    report_at: option.map(t.report, fn(rep) { rep.filed_at }),
  )
}

/// The representation in force, named by its agency and agent.
fn representation(
  read: Read,
  player_id: id.PlayerId,
  now: Int,
) -> Result(Option(rules.Representation), Fail(e)) {
  use agreements <- result.try(agent_store.agreements_for_client(
    read,
    id.player_to_string(player_id),
  ))
  case list.find(agreements, fn(a) { agent_rules.in_force(a.row, now) }) {
    Error(Nil) -> Ok(None)
    Ok(a) -> {
      use profile <- result.try(agent_store.profile_for_user(
        read,
        a.row.agent_user_id,
      ))
      use agent_name <- result.try(case profile {
        Some(p) -> Ok(Some(p.row.display_name))
        None ->
          staff.by_id(read, a.row.agent_user_id)
          |> result.map(option.map(_, fn(u) { u.name }))
      })
      use agency <- result.map(org_name(read, a.row.agency_org_id))
      Some(rules.Representation(
        agency_name: agency,
        agent_display_name: agent_name,
        scope: a.scope,
        since: option.or(a.row.confirmed_at, a.row.start_at),
      ))
    }
  }
}

/// What the self view shows of Box Cam for a player with none of it. Not ported yet: Box Cam's sessions,
/// assignments and Combine results, which fill these in.
fn development_activity() -> Json {
  json.object([
    #("days", json.int(30)),
    #("boxSessions", json.int(0)),
    #("verifiedActiveMs", json.int(0)),
    #("assigned", json.int(0)),
    #("assignedCompleted", json.int(0)),
    #("focus", json.preprocessed_array([])),
    #(
      "note",
      json.string(
        "This is evidence of recorded training activity. It is not proof of player ability.",
      ),
    ),
  ])
}

fn combine_projection() -> Json {
  json.object([
    #("results", json.preprocessed_array([])),
    #("hasCombineVerifiedResults", json.bool(False)),
    #(
      "note",
      json.string(
        "Combine Verified — standardized ScoutBox protocol, live Box Cam capture. Powered by Box Cam. Real numbers, not a talent score.",
      ),
    ),
  ])
}

/// The whole Passport of `p` (assemble). A `light` one, for batch summaries, has no timeline and so no temporal
/// conflicts.
pub fn assemble(
  read: Read,
  p: Player,
  light: Bool,
  now: Int,
) -> Result(Full, Fail(e)) {
  let pid = p.row.id
  use prefs <- result.try(prefs(read, pid))
  use h <- result.try(history_inputs(read, pid))
  use all_trials <- result.try(trials.for_player(read, pid))
  use assessments <- result.try(rows(
    read,
    assessment_row.columns,
    "assessments",
    "player_id = ? AND state <> 'draft'",
    pid,
    assessment_row.decoder(),
  ))
  use assessments <- result.try(
    list.try_map(assessments, fn(a) {
      use name <- result.map(org_name(read, a.org_id))
      rules.AssessmentSource(
        id: a.id,
        org_id: a.org_id,
        org_name: name,
        submitted_at: a.submitted_at,
        created_at: a.created_at,
        state: a.state,
      )
    }),
  )
  use refs <- result.try(rows(
    read,
    reference_row.columns,
    "ver_references",
    "player_id = ? AND status = 'active'",
    pid,
    reference_row.decoder(),
  ))
  use references <- result.try(
    list.try_map(refs, fn(r) {
      use claim <- result.map(
        store.one(
          read,
          "SELECT " <> ver_claims.columns <> " FROM ver_claims WHERE id = ?",
          [id.claim_sql(r.provenance_claim_id)],
          ver_claims.decoder(),
        )
        |> result.map(option.from_result),
      )
      rules.ReferenceSource(
        id: r.id,
        coach_name: r.coach_name,
        role_at_time: r.role_at_time,
        org_id: r.org_id,
        org_name: r.org_name,
        relationship: r.relationship,
        from_year: r.from_year,
        to_year: r.to_year,
        strengths: r.strengths,
        development: r.development,
        summary: r.summary,
        status: r.status,
        created_at: r.created_at,
        provenance_still_current: case claim {
          Some(c) -> c.status == ver_claims.Verified && c.current
          None -> False
        },
      )
    }),
  )
  use evidence <- result.try(rows(
    read,
    evidence_row.columns,
    "evidence",
    "player_id = ?",
    pid,
    evidence_row.decoder(),
  ))
  let evidence =
    list.map(evidence, fn(e) {
      rules.EvidenceSource(
        id: e.id,
        claim_type: e.claim_type,
        label: e.label,
        recorded_at: e.recorded_at,
        tier: e.verification_status,
        source_kind: e.source_kind,
        superseded: e.superseded_by_id != None,
        expired: case e.expires_at {
          Some(at) -> at < now
          None -> False
        },
      )
    })
  use objectives <- result.try(rows(
    read,
    objective_row.columns,
    "dev_objectives",
    "player_id = ?",
    pid,
    objective_row.decoder(),
  ))
  use objectives <- result.try(
    list.try_map(objectives, fn(o) {
      use name <- result.map(org_name(read, o.org_id))
      rules.ObjectiveSource(
        id: o.id,
        org_id: o.org_id,
        org_name: name,
        created_at: o.created_at,
        status: o.status,
      )
    }),
  )
  use applications <- result.try(rows(
    read,
    application_row.columns,
    "applications",
    "player_id = ?",
    pid,
    application_row.decoder(),
  ))
  use applications <- result.try(
    list.try_map(applications, fn(a) {
      use name <- result.try(org_name(read, a.org_id))
      use opportunity <- result.map(
        store.one(
          read,
          "SELECT "
            <> opportunity_row.columns
            <> " FROM opportunities WHERE id = ?",
          [id.opportunity_sql(a.opportunity_id)],
          opportunity_row.decoder(),
        )
        |> result.map(option.from_result),
      )
      rules.ApplicationSource(
        id: id.application_to_string(a.id),
        org_id: a.org_id,
        org_name: name,
        opportunity_title: option.map(opportunity, fn(o) { o.title }),
        created_at: a.created_at,
      )
    }),
  )
  use transitions <- result.try(rows(
    read,
    transition_row.columns,
    "transition_cases",
    "player_id = ?",
    pid,
    transition_row.decoder(),
  ))
  use achievements <- result.try(rows(
    read,
    achievement_row.columns,
    "passport_achievements",
    "player_id = ?",
    pid,
    achievement_row.decoder(),
  ))
  use vouches <- result.try(rows(
    read,
    "id",
    "vouches",
    "player_id = ? AND status = 'published' AND withdrawn_at IS NULL",
    pid,
    decode.at([0], decode.string),
  ))
  use representation <- result.try(representation(read, pid, now))
  use box_share <- result.try(combine.shares_development(read, pid))
  use sharing_active <- result.map(store.one(
    read,
    "SELECT COUNT(*) FROM passport_shares WHERE player_id = ? AND revoked_at IS NULL AND expires_at > ?",
    [id.player_sql(pid), sqlight.int(now)],
    decode.at([0], decode.int),
  ))
  let sharing_active = result.unwrap(sharing_active, 0)
  let history = rules.club_history(h.signing_rows, h.squads, h.career_entries)
  let identity = p.row.identity_verified
  let full_matches =
    list.filter(evidence, fn(e) {
      e.claim_type == evidence_row.Footage && !e.superseded
    })
  let clips = list.length(p.media)
  let reference_count = list.length(references) + list.length(vouches)
  let last_evidence_at =
    list.fold(evidence, 0, fn(m, e) { int.max(m, e.recorded_at) })
  let position =
    option.or(option.then(prefs.positions, fn(x) { x.primary }), p.row.position)
  let facts =
    rules.Facts(
      has_recent_full_match: list.any(full_matches, fn(e) {
        e.recorded_at > now - 180 * day_ms
      }),
      full_match_count: list.length(full_matches),
      clip_count: clips,
      reference_count:,
      has_confirmed_current_club: list.any(history.rows, fn(r) {
        r.current
        && list.contains(
          [
            rules.VerifiedClubConfirmed,
            rules.AuthoritativeRegistry,
            rules.ScoutboxReviewed,
          ],
          r.provenance,
        )
      }),
      has_recent_assessment: list.any(assessments, fn(a) {
        option.unwrap(a.submitted_at, a.created_at) > now - 365 * day_ms
      }),
      has_position: position != None,
      has_availability: prefs.availability != None,
      identity_confirmed: identity,
      history_rows: list.length(history.rows),
      // Not ported yet: Box Cam's recent verified sessions.
      has_recent_training_evidence: False,
    )
  let trial_sources = list.map(all_trials, trial_source)
  let timeline = case light {
    True -> []
    False ->
      rules.build_timeline(rules.Sources(
        career_entries: h.career_entries,
        squads: h.squads,
        trials: trial_sources,
        assessments:,
        references:,
        evidence:,
        objectives:,
        applications:,
        transitions: list.map(transitions, fn(t) {
          rules.TransitionSource(
            id: t.id,
            created_at: t.created_at,
            placement: option.map(t.placement_at, fn(at) {
              #(Some(at), t.placement_org_name)
            }),
          )
        }),
        signings: h.signings,
        outcomes: h.outcomes,
        achievements:,
        position_history: prefs.position_history,
      ))
  }
  rules.Full(
    player: rules.PlayerFacts(
      id: pid,
      name: p.row.name,
      // UTC, so the answer around a birthday does not depend on the server's zone.
      age: age.age_on(p.row.birth_date, now),
      minor: !players.is_adult(p, now),
      position:,
      city: p.row.city,
      level: Some(p.row.level),
    ),
    identity:,
    prefs: Some(prefs),
    history:,
    status: rules.current_status(history, Some(prefs), representation, identity),
    evidence_summary: rules.EvidenceSummary(
      full_matches: list.length(full_matches),
      clips:,
      assessments: list.length(assessments),
      references: reference_count,
      last_evidence_days: case last_evidence_at {
        0 -> None
        at -> Some({ now - at } / day_ms)
      },
      note: "Counts describe evidence coverage, not football ability.",
    ),
    references:,
    achievements:,
    development_summary: #(
      list.count(objectives, fn(o) { o.status == objective_row.Active }),
      list.count(objectives, fn(o) { o.status != objective_row.Active }),
    ),
    trials_summary: #(
      list.length(all_trials),
      list.count(all_trials, fn(t) { t.report != None }),
    ),
    completeness: rules.completeness(facts),
    development_activity: Some(development_activity()),
    combine: Some(combine_projection()),
    box_share_recruitment: box_share,
    sharing_active:,
    assessments:,
    trials: trial_sources,
    timeline:,
    temporal_conflicts: case light {
      True -> []
      False ->
        rules.temporal_conflicts(
          timeline,
          history.rows,
          Some(p.row.birth_date),
          now,
        )
    },
    revision_evidence: evidence,
    revision_careers: list.map(h.career_entries, fn(c) {
      rules.CareerMark(c.id, c.withdrawn_at != None)
    }),
  )
}

/// The revision of `p`'s Passport, which a decision snapshot records so it can say which Passport a club saw.
pub fn revision(read: Read, p: Player, now: Int) -> Result(String, Fail(e)) {
  assemble(read, p, False, now) |> result.map(rules.passport_revision)
}
