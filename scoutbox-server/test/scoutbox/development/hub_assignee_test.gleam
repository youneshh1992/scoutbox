//// Who may be assigned a Development action (`hub_routes.assignee`), hand-ported from the `canAssign` calls of
//// the TypeScript rules suite (scripts/rules/development/hub.mjs, assignment), which pass staff as a closure.
//// Here they are rows of the seeded store: Eastport owns the plan, Harbour is another club, and Marek is
//// Tomasz's guardian.

import gleam/option.{None, Some}
import scoutbox/development/hub_routes.{type Assignee}
import scoutbox/identity/players
import scoutbox/identity/staff
import scoutbox/platform/store.{type Store}
import scoutbox/rows/development_plans as plan_row
import scoutbox/rows/id
import scoutbox/support
import scoutbox/vocab/audience
import scoutbox/vocab/plan_visibility

fn hire(s: Store, org: String, name: String) -> staff.Staff {
  let assert Ok(u) =
    store.unit(s, staff.create(
      _,
      staff.NewStaff(
        org_id: id.org(org),
        name:,
        role: "Coach",
        email: None,
        provenance: None,
        created_at: 1,
      ),
    ))
  u
}

/// Eastport's plan for `player`.
fn org_plan(player: String) -> plan_row.Row {
  plan_row.Row(
    ..plan_row.new(
      id: id.dev_plan("pl2"),
      player_id: id.player(player),
      owner_kind: plan_row.OwnerKindOrg,
      created_by_kind: plan_row.CreatedByKindOrg,
      created_by_id: "",
      title: "Plan",
      status: plan_row.Active,
      visibility: plan_visibility.OrgPrivate,
      start_at: 0,
      created_at: 0,
      updated_at: 0,
      rev: 1,
    ),
    owner_org_id: Some(id.org("org-eastport")),
  )
}

/// The assignee `kind` and `who` name on Eastport's plan for `player`, treated as an adult.
fn assign(
  s: Store,
  kind: String,
  who: String,
  player: String,
) -> Result(Assignee, String) {
  store.read(s, fn(r) {
    let assert Ok(Some(p)) = players.by_id(r, id.player(player))
    let assert Ok(found) =
      hub_routes.assignee(
        r,
        Some(kind),
        Some(who),
        plan: org_plan(player),
        player: p,
        minor: False,
      )
    found
  })
}

pub fn staff_of_another_club_cannot_be_assigned_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let other = hire(s, "org-harbour", "Other Coach")
  let assert Error(_) =
    assign(s, "org_user", id.org_user_to_string(other.id), "pl-adeyemi")
}

pub fn removed_staff_are_not_assignees_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let lead = hire(s, "org-eastport", "Lead Coach")
  let gone = hire(s, "org-eastport", "Gone Coach")
  let assert Ok(_) = store.unit(s, staff.remove(_, gone.id, at: 5, by: lead.id))
  let assert Error(_) =
    assign(s, "org_user", id.org_user_to_string(gone.id), "pl-adeyemi")
}

pub fn current_staff_of_the_owning_club_can_be_assigned_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let u = hire(s, "org-eastport", "Current Coach")
  let who = id.org_user_to_string(u.id)
  let assert Ok(a) = assign(s, "org_user", who, "pl-adeyemi")
  assert a.kind == audience.OrgUser && a.id == who
}

pub fn the_player_can_be_the_assignee_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let assert Ok(a) = assign(s, "player", "pl-adeyemi", "pl-adeyemi")
  assert a.kind == audience.Player
}

pub fn a_guardian_cannot_be_assigned_an_adult_players_actions_test() {
  let s = support.fresh_store(fn(_) { Nil })
  // Marek is Tomasz's guardian: the refusal is the player's age, not the relationship.
  assert assign(s, "guardian", "gd-marek", "pl-tomasz")
    == Error(
      "This player is an adult; a guardian cannot be assigned their actions.",
    )
}
