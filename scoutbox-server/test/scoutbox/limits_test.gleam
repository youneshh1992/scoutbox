//// An act bounded per owner (RATE_LIMIT_POLICY): its budget is spent per owner, within its window.

import scoutbox/platform/limits.{EmailChallengeRequest}

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

fn repeat(n: Int, f: fn() -> Nil) -> Nil {
  case n {
    0 -> Nil
    _ -> {
      f()
      repeat(n - 1, f)
    }
  }
}
