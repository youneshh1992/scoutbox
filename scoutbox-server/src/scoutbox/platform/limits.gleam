//// Per-process limits, as the TypeScript server keeps them:
////
//// - every `/auth` request, per client address: 40 a minute;
//// - wrong sign-in guesses, per identifier tried: 20 in 15 minutes. A success costs nothing, and the budget is
////   tested before the credential, so a correct guess after it is spent is refused;
//// - wrong second-factor codes, per staff member: five lock the account's code checks for five minutes.

import gleam/option.{None, Some}
import gleam/result
import gleam/string
import scoutbox/platform/table.{type Table}

type Window {
  Window(count: Int, started: Int)
}

type Codes {
  Codes(fails: Int, locked_until: Int)
}

pub opaque type Limits {
  Limits(auth: Table(Window), login: Table(Window), mfa: Table(Codes))
}

const auth_max = 40

const auth_window_ms = 60_000

const login_max = 20

const login_window_ms = 900_000

pub fn start() -> Result(Limits, String) {
  use auth <- result.try(table.start())
  use login <- result.try(table.start())
  use mfa <- result.map(table.start())
  Limits(auth:, login:, mfa:)
}

fn current(window: option.Option(Window), now: Int, length: Int) -> Window {
  case window {
    Some(w) if now - w.started < length -> w
    _ -> Window(0, now)
  }
}

/// Counts an `/auth` request from `address`. Error(retry after, ms) when over the limit.
pub fn auth_request(
  limits: Limits,
  address: String,
  now: Int,
) -> Result(Nil, Int) {
  table.update(limits.auth, address, fn(entry) {
    let w = current(entry, now, auth_window_ms)
    let w = Window(..w, count: w.count + 1)
    let answer = case w.count > auth_max {
      True -> Error(auth_window_ms - { now - w.started })
      False -> Ok(Nil)
    }
    #(Some(w), answer)
  })
}

/// The key a sign-in identifier is budgeted under.
pub fn login_key(identifier: String) -> String {
  case identifier |> string.trim |> string.lowercase {
    "" -> "unknown"
    key -> key
  }
}

/// True when the identifier's wrong-guess budget is spent.
pub fn login_locked(limits: Limits, identifier: String, now: Int) -> Bool {
  table.update(limits.login, login_key(identifier), fn(entry) {
    let w = current(entry, now, login_window_ms)
    #(entry, w.count >= login_max)
  })
}

pub fn login_failed(limits: Limits, identifier: String, now: Int) -> Nil {
  table.update(limits.login, login_key(identifier), fn(entry) {
    let w = current(entry, now, login_window_ms)
    #(Some(Window(..w, count: w.count + 1)), Nil)
  })
}

pub fn mfa_locked(limits: Limits, user_id: String, now: Int) -> Bool {
  table.update(limits.mfa, user_id, fn(entry) {
    #(entry, case entry {
      Some(c) -> c.locked_until > now
      None -> False
    })
  })
}

pub fn mfa_failed(limits: Limits, user_id: String, now: Int) -> Nil {
  table.update(limits.mfa, user_id, fn(entry) {
    let c = option.unwrap(entry, Codes(0, 0))
    let fails = c.fails + 1
    let c = case fails >= 5 {
      True -> Codes(fails: 0, locked_until: now + 300_000)
      False -> Codes(..c, fails:)
    }
    #(Some(c), Nil)
  })
}

pub fn mfa_clear(limits: Limits, user_id: String) -> Nil {
  table.update(limits.mfa, user_id, fn(_) { #(None, Nil) })
}
