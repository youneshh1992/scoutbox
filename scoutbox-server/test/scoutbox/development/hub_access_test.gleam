//// The Development Hub's access rule (`hub_rules.plan_access`), hand-ported from the `planAccess` calls of the
//// TypeScript rules suite (scripts/rules/development/hub.mjs), which pass `orgCanSee` as a function: here it is the
//// live gate's answer, a Bool.

import gleam/option.{None, Some}
import scoutbox/development/hub_rules.{
  type PlanFacts, GuardianOf, PlanFacts, PlayerSelf, StaffOf,
}
import scoutbox/rows/id
import scoutbox/vocab/plan_visibility

fn player_plan() -> PlanFacts {
  PlanFacts(
    player_id: id.player("p1"),
    owner_org_id: None,
    visibility: plan_visibility.Private,
    shared_with: [],
  )
}

fn org_plan() -> PlanFacts {
  PlanFacts(
    player_id: id.player("p1"),
    owner_org_id: Some(id.org("org-a")),
    visibility: plan_visibility.OrgPrivate,
    shared_with: [],
  )
}

fn shared_with_a() -> PlanFacts {
  PlanFacts(
    ..player_plan(),
    visibility: plan_visibility.SharedWithOrg,
    shared_with: [id.org("org-a")],
  )
}

fn minors_plan() -> PlanFacts {
  PlanFacts(..player_plan(), player_id: id.player("p2"))
}

const me = PlayerSelf

fn adult(viewer, plan) {
  hub_rules.plan_access(viewer, plan, False, True)
}

fn minor(viewer, plan) {
  hub_rules.plan_access(viewer, plan, True, True)
}

fn guardian() {
  GuardianOf(id.guardian("g1"), [id.player("p2")])
}

fn staff_a() {
  StaffOf(id.org("org-a"), False)
}

fn lead_a() {
  StaffOf(id.org("org-a"), True)
}

fn staff_b() {
  StaffOf(id.org("org-b"), True)
}

pub fn an_adult_manages_their_own_plan_test() {
  let a = adult(me(id.player("p1"), False), player_plan())
  assert a.write_goals && a.manage
}

pub fn a_player_cannot_read_another_players_plan_test() {
  assert !adult(me(id.player("p9"), False), player_plan()).read
}

pub fn a_minor_reads_their_own_plan_and_does_not_write_it_test() {
  let a = minor(me(id.player("p2"), True), minors_plan())
  assert !a.write_goals
  assert a.read
}

pub fn the_guardian_of_a_minor_manages_their_plan_test() {
  assert minor(guardian(), minors_plan()).manage
}

pub fn a_guardian_cannot_read_an_unrelated_players_plan_test() {
  assert !adult(guardian(), player_plan()).read
}

pub fn a_guardian_who_no_longer_owns_the_child_gets_nothing_test() {
  assert !minor(GuardianOf(id.guardian("g1"), []), minors_plan()).read
}

pub fn an_adults_guardian_gets_nothing_whatever_the_stored_list_says_test() {
  assert !adult(guardian(), minors_plan()).read
}

pub fn club_staff_work_their_own_clubs_plan_test() {
  let a = adult(staff_a(), org_plan())
  assert a.write_goals && a.read_internal
}

pub fn a_foreign_organisation_cannot_read_this_clubs_plan_test() {
  assert !adult(staff_b(), org_plan()).read
}

pub fn a_club_the_plan_was_not_shared_with_gets_nothing_test() {
  assert !adult(staff_b(), shared_with_a()).read
}

pub fn a_club_the_player_shared_with_reads_and_only_reads_test() {
  let a = adult(staff_a(), shared_with_a())
  assert a.read
  assert !a.write_goals
  assert !a.read_internal
}

pub fn archiving_and_visibility_are_lead_decisions_test() {
  assert adult(lead_a(), org_plan()).manage
  assert !adult(staff_a(), org_plan()).manage
}

pub fn a_blocked_or_invisible_player_removes_access_test() {
  assert !hub_rules.plan_access(staff_a(), org_plan(), False, False).read
}

pub fn a_club_private_plan_does_not_exist_for_the_player_test() {
  assert !adult(me(id.player("p1"), False), org_plan()).read
}

pub fn a_shared_club_plan_is_readable_by_the_player_and_not_editable_test() {
  let shown =
    PlanFacts(..org_plan(), visibility: plan_visibility.PlayerGuardian)
  let a = adult(me(id.player("p1"), False), shown)
  assert a.read
  assert !a.write_goals
}
