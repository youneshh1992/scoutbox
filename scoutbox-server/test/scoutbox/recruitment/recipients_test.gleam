//// Who a club's contact reaches (`recipients.resolve`), hand-ported from the resolveContactRecipient calls of the
//// TypeScript rules suite (scripts/rules/recruitment/contacts.mjs, section U), which pass the visibility rule, the
//// blocks and the age rule as closures.
////
//// Here `resolve` fetches and `judge` decides. The judgement is tested over rows: the player with what the
//// visibility rule and the blocks said, and the guardians whose link rows name the player. The suite's guardians
//// that don't list the child, or whose `childIds` isn't a list, are not fetched at all: the link is a
//// `guardian_children` row, and a guardian is a row or nothing, so there is no removed one either. The visibility
//// the TypeScript closure computes is SQL here, so the agency and unverified-club calls run against the seed.

import gleam/option.{type Option, None, Some}
import scoutbox/identity/orgs
import scoutbox/platform/store
import scoutbox/platform/temporal
import scoutbox/recruitment/recipients.{
  Blocked, GuardianRequired, Recipient, Unavailable,
}
import scoutbox/rows/guardians as guardian_row
import scoutbox/rows/id
import scoutbox/rows/players as player_row
import scoutbox/rules/visibility.{Access}
import scoutbox/support
import scoutbox/vocab/party

/// 2026-09-16T00:00:00Z.
const now = 1_789_516_800_000

const seen = Access(visible: True, blocked: False, distance_tenths: None)

fn player(
  pid: String,
  dob: String,
  country: String,
  guardian: Option(String),
) -> player_row.Row {
  let assert Ok(day) = temporal.parse_day(dob)
  player_row.Row(
    ..player_row.new(
      id: id.player(pid),
      name: "Player",
      birth_date: day,
      country:,
      profile_signal: 0,
    ),
    guardian_id: option.map(guardian, id.guardian),
  )
}

/// A guardian who has passed the identity and disclaimer gates.
fn verified(gid: String) -> guardian_row.Row {
  guardian_row.Row(
    ..guardian_row.new(id: id.guardian(gid), name: "G", email: gid <> "@x"),
    id_verified: True,
    disclaimer_accepted: True,
  )
}

const adult = #("p-a", "2000-01-01", "GB")

fn minor() -> player_row.Row {
  player("p-m", "2012-01-01", "GB", Some("g1"))
}

fn judge(p: player_row.Row, linked: List(guardian_row.Row)) {
  recipients.judge(Some(#(p, seen)), linked, now)
}

pub fn an_adult_is_contacted_directly_test() {
  assert judge(player(adult.0, adult.1, adult.2, None), [verified("g1")])
    == Ok(Recipient(party.Player, id.player("p-a"), None, False))
}

pub fn a_minor_routes_to_the_verified_guardian_test() {
  assert judge(minor(), [verified("g1")])
    == Ok(Recipient(
      party.Guardian,
      id.player("p-m"),
      Some(id.guardian("g1")),
      True,
    ))
}

pub fn a_minor_with_no_guardian_fails_closed_test() {
  assert judge(minor(), []) == Error(GuardianRequired)
}

pub fn an_unverified_guardian_is_not_a_route_test() {
  assert judge(minor(), [guardian_row.Row(..verified("g1"), id_verified: False)])
    == Error(GuardianRequired)
}

pub fn a_guardian_without_the_disclaimer_is_not_a_route_test() {
  assert judge(minor(), [
      guardian_row.Row(..verified("g1"), disclaimer_accepted: False),
    ])
    == Error(GuardianRequired)
}

pub fn two_guardians_the_players_own_link_decides_test() {
  assert judge(minor(), [verified("g1"), verified("g2")])
    == Ok(Recipient(
      party.Guardian,
      id.player("p-m"),
      Some(id.guardian("g1")),
      True,
    ))
}

pub fn two_guardians_and_a_link_to_neither_fails_closed_test() {
  assert judge(player("p-m", "2012-01-01", "GB", Some("g9")), [
      verified("g1"),
      verified("g2"),
    ])
    == Error(GuardianRequired)
}

pub fn a_block_refuses_by_name_test() {
  let blocked = Access(..seen, blocked: True)
  assert recipients.judge(
      Some(#(player(adult.0, adult.1, adult.2, None), blocked)),
      [],
      now,
    )
    == Error(Blocked)
}

pub fn a_missing_or_removed_player_is_unavailable_test() {
  // A removed player is not fetched: the read skips a deleted row.
  assert recipients.judge(None, [], now)
    == Error(Unavailable("This player is not available to contact."))
}

pub fn the_country_decides_the_age_of_majority_test() {
  // 18 on the day: a minor in KR (majority 19), an adult in GB.
  let gk = verified("g1")
  let assert Ok(kr) = judge(player("p-k", "2008-06-01", "KR", Some("g1")), [gk])
  assert kr.kind == party.Guardian
  let assert Ok(gb) = judge(player("p-k", "2008-06-01", "GB", Some("g1")), [gk])
  assert gb.kind == party.Player
}

pub fn the_age_at_send_decides_test() {
  let turning = player("p-t", "2008-09-20", "GB", Some("g1"))
  let at = fn(t) {
    recipients.judge(Some(#(turning, seen)), [verified("g1")], t)
  }
  let assert Ok(before) = at(now)
  assert before.kind == party.Guardian
  // 2026-09-21T00:00:00Z
  let assert Ok(after) = at(1_789_948_800_000)
  assert after.kind == party.Player
}

// ------------------------------------------------------------------------------------------ against the seed

/// Who `org` reaches for `player` in the seeded store.
fn resolve(org: String, player: String) {
  let s = support.fresh_store(fn(_) { Nil })
  store.read(s, fn(r) {
    let assert Ok(Some(o)) = orgs.by_id(r, id.org(org))
    let assert Ok(found) = recipients.resolve(r, id.player(player), o, now)
    found
  })
}

const standing =
  "This player is not available to your organisation under the standing rules."

pub fn a_verified_club_reaches_a_minor_through_their_guardian_test() {
  // Guni is twelve; Amara is her verified guardian.
  assert resolve("org-eastport", "pl-guni")
    == Ok(Recipient(
      party.Guardian,
      id.player("pl-guni"),
      Some(id.guardian("gd-amara")),
      True,
    ))
}

pub fn an_agency_can_never_contact_a_minor_test() {
  assert resolve("org-northstar", "pl-guni") == Error(Unavailable(standing))
}

pub fn an_unverified_club_can_never_contact_a_minor_test() {
  assert resolve("org-harbour", "pl-guni") == Error(Unavailable(standing))
}

pub fn an_agency_may_contact_an_adult_test() {
  assert resolve("org-northstar", "pl-adeyemi")
    == Ok(Recipient(party.Player, id.player("pl-adeyemi"), None, False))
}

pub fn a_player_who_is_not_there_is_unavailable_test() {
  assert resolve("org-eastport", "pl-nobody")
    == Error(Unavailable("This player is not available to contact."))
}
