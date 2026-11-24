//// An act bounded per owner (RATE_LIMIT_POLICY): its budget is spent per owner, within its window. The first test is
//// also the port of the TypeScript memory provider's checks (`memoryRateLimitProvider`, productionHardening §15).

import gleam/int
import gleam/option.{type Option, None, Some}
import scoutbox/platform/limits.{EmailChallengeRequest}
import scoutbox/platform/table
import scoutbox/rows/id

const hour = 3_600_000

pub fn five_challenge_requests_an_hour_per_club_test() {
  let assert Ok(l) = limits.start()
  let spend = fn(owner, now) {
    limits.limited(l, EmailChallengeRequest, owner, now)
  }
  assert [spend("org-a", 0), spend("org-a", 1), spend("org-a", 2)]
    == [False, False, False]
  assert [spend("org-a", 3), spend("org-a", 4)] == [False, False]
  assert spend("org-a", 5)
  // Another club has a budget of its own.
  assert !spend("org-b", 6)
  // A fresh window starts once the hour is over.
  assert !spend("org-a", hour)
}

/// As the TypeScript limiter: 20 wrong guesses are all answered, and only past them is the identifier locked, by
/// any spelling of its case.
pub fn twenty_wrong_guesses_then_locked_test() {
  let assert Ok(l) = limits.start()
  repeat(20, fn() {
    assert !limits.login_locked(l, "guardian:gd-1", 0)
    limits.login_failed(l, "guardian:gd-1", 0)
  })
  assert !limits.login_locked(l, "guardian:gd-1", 0)
  limits.login_failed(l, "guardian:gd-1", 0)
  assert limits.login_locked(l, " GUARDIAN:GD-1", 0)
  assert !limits.login_locked(l, "guardian:gd-2", 0)
}

/// The port of the TypeScript eviction check (testPlatformHelpers, U5 of journeyAdversarial): a flood of made-up
/// sign-in names past the cap evicts them, never a live budget. Here the live identifier is locked, so a reset
/// would reopen guessing against it.
pub fn a_flood_of_made_up_names_does_not_reset_a_locked_identifier_test() {
  let assert Ok(l) = limits.start()
  repeat(21, fn() { limits.login_failed(l, "player:real", 0) })
  assert limits.login_locked(l, "player:real", 0)
  flood(table.max_keys + 5, fn(i) {
    limits.login_failed(l, "made-up-" <> int.to_string(i), 1)
  })
  assert limits.login_locked(l, "player:real", 2)
}

/// A second-factor lock survives a flood of other staff members' wrong codes.
pub fn a_flood_of_wrong_codes_does_not_lift_a_second_factor_lock_test() {
  let assert Ok(l) = limits.start()
  repeat(5, fn() { limits.mfa_failed(l, id.org_user("u-real"), 0) })
  assert limits.mfa_locked(l, id.org_user("u-real"), 0)
  flood(table.max_keys + 5, fn(i) {
    limits.mfa_failed(l, id.org_user("u-" <> int.to_string(i)), 1)
  })
  assert limits.mfa_locked(l, id.org_user("u-real"), 2)
}

/// At the cap, ended entries go before any live one, and the table never grows past it.
pub fn a_full_table_drops_ended_entries_first_then_the_lightest_test() {
  // An entry's value is its weight; it has ended once its weight is negative.
  let assert Ok(t) =
    table.start(
      table.Bounded(expired: fn(_, v, _) { v < 0 }, weight: fn(v, _) { #(v, 0) }),
    )
  let put = fn(key, v) { table.update(t, key, 0, fn(_) { #(Some(v), Nil) }) }
  put("heavy", 2)
  put("ended", -1)
  flood(table.max_keys - 2, fn(i) { put("light-" <> int.to_string(i), 1) })
  assert table.size(t) == table.max_keys
  // The first new key past the cap takes only the ended entry.
  put("new-1", 1)
  assert table.size(t) == table.max_keys
  assert get(t, "ended") == None
  // The next evicts a quarter, all of it light.
  put("new-2", 1)
  assert table.size(t) == table.max_keys - table.max_keys / 4 + 1
  assert get(t, "heavy") == Some(2)
}

fn get(t: table.Table(Int), key: String) -> Option(Int) {
  table.update(t, key, 0, fn(entry) { #(entry, entry) })
}

fn flood(n: Int, f: fn(Int) -> Nil) -> Nil {
  case n {
    0 -> Nil
    _ -> {
      f(n)
      flood(n - 1, f)
    }
  }
}

fn repeat(n: Int, f: fn() -> Nil) -> Nil {
  case n {
    0 -> Nil
    _ -> {
      f()
      repeat(n - 1, f)
    }
  }
}
