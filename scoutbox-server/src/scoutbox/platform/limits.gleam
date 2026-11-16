//// Per-process limits, as the TypeScript server keeps them:
////
//// - every `/auth` request, per client address: 40 a minute;
//// - wrong sign-in guesses, per identifier tried: 20 in 15 minutes. A success costs nothing, and the budget is
////   tested before the credential, so a correct guess after it is spent is refused;
//// - wrong second-factor codes, per staff member: five lock the account's code checks for five minutes;
//// - the acts RATE_LIMIT_POLICY bounds per owner (`Action`), each in its own window.

import gleam/option.{None, Some}
import gleam/result
import gleam/string
import scoutbox/platform/table.{type Table}
import scoutbox/rows/id

type Window {
  Window(count: Int, started: Int)
}

type Codes {
  Codes(fails: Int, locked_until: Int)
}

pub opaque type Limits {
  Limits(
    auth: Table(Window),
    login: Table(Window),
    mfa: Table(Codes),
    acts: Table(Window),
  )
}

/// A budget: at most `max` in any `window_ms`.
pub type Policy {
  Policy(max: Int, window_ms: Int)
}

/// The `/auth` limiter. The TypeScript server sets it in identity/sessions.mjs, not in RATE_LIMIT_POLICY.
const auth_policy = Policy(max: 40, window_ms: 60_000)

/// The budgets that are entries of RATE_LIMIT_POLICY (domains/platform/rateLimit.mjs), by action.
/// `test/scoutbox/spec_test.gleam` proves each equals its entry in e2e/support/spec/platform/rateLimit.json.
pub const policy = [
  #("login_failure", login_policy),
  #("email_challenge_request", email_challenge_request_policy),
  #("room_create", room_create_policy),
  #("room_comment", room_comment_policy),
  #("room_combine_request", room_combine_request_policy),
]

/// An act bounded per owner. Its budget is its entry in `policy`.
pub type Action {
  /// Club e-mail-domain verification codes requested, per organisation (each one sends a mail).
  EmailChallengeRequest
  /// New Recruitment Rooms, per organisation.
  RoomCreate
  /// Room discussion messages, per room and staff member.
  RoomComment
  /// Combine requests raised from a Room, per organisation.
  RoomCombineRequest
}

const email_challenge_request_policy = Policy(max: 5, window_ms: 3_600_000)

const room_create_policy = Policy(max: 60, window_ms: 3_600_000)

const room_comment_policy = Policy(max: 20, window_ms: 60_000)

const room_combine_request_policy = Policy(max: 60, window_ms: 3_600_000)

fn action_name(action: Action) -> String {
  case action {
    EmailChallengeRequest -> "email_challenge_request"
    RoomCreate -> "room_create"
    RoomComment -> "room_comment"
    RoomCombineRequest -> "room_combine_request"
  }
}

fn action_policy(action: Action) -> Policy {
  case action {
    EmailChallengeRequest -> email_challenge_request_policy
    RoomCreate -> room_create_policy
    RoomComment -> room_comment_policy
    RoomCombineRequest -> room_combine_request_policy
  }
}

const login_policy = Policy(max: 20, window_ms: 900_000)

pub fn start() -> Result(Limits, String) {
  use auth <- result.try(table.start())
  use login <- result.try(table.start())
  use mfa <- result.try(table.start())
  use acts <- result.map(table.start())
  Limits(auth:, login:, mfa:, acts:)
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
    let w = current(entry, now, auth_policy.window_ms)
    let w = Window(..w, count: w.count + 1)
    let answer = case w.count > auth_policy.max {
      True -> Error(auth_policy.window_ms - { now - w.started })
      False -> Ok(Nil)
    }
    #(Some(w), answer)
  })
}

/// Spends one of `owner`'s budget for `action`. True when it was already spent: the act is refused.
pub fn limited(
  limits: Limits,
  action: Action,
  owner: String,
  now: Int,
) -> Bool {
  let p = action_policy(action)
  table.update(limits.acts, action_name(action) <> ":" <> owner, fn(entry) {
    let w = current(entry, now, p.window_ms)
    let w = Window(..w, count: w.count + 1)
    #(Some(w), w.count > p.max)
  })
}

/// The 429 body for an act over its budget (rateLimitedBody).
pub fn limited_body(action: Action) -> List(#(String, String)) {
  [
    #("error", "RATE_LIMITED"),
    #("action", action_name(action)),
    #(
      "message",
      "Too many requests in a short window — wait a moment and try again.",
    ),
  ]
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
    let w = current(entry, now, login_policy.window_ms)
    #(entry, w.count >= login_policy.max)
  })
}

pub fn login_failed(limits: Limits, identifier: String, now: Int) -> Nil {
  table.update(limits.login, login_key(identifier), fn(entry) {
    let w = current(entry, now, login_policy.window_ms)
    #(Some(Window(..w, count: w.count + 1)), Nil)
  })
}

pub fn mfa_locked(limits: Limits, user_id: id.OrgUserId, now: Int) -> Bool {
  table.update(limits.mfa, id.org_user_to_string(user_id), fn(entry) {
    #(entry, case entry {
      Some(c) -> c.locked_until > now
      None -> False
    })
  })
}

pub fn mfa_failed(limits: Limits, user_id: id.OrgUserId, now: Int) -> Nil {
  table.update(limits.mfa, id.org_user_to_string(user_id), fn(entry) {
    let c = option.unwrap(entry, Codes(0, 0))
    let fails = c.fails + 1
    let c = case fails >= 5 {
      True -> Codes(fails: 0, locked_until: now + 300_000)
      False -> Codes(..c, fails:)
    }
    #(Some(c), Nil)
  })
}

pub fn mfa_clear(limits: Limits, user_id: id.OrgUserId) -> Nil {
  table.update(limits.mfa, id.org_user_to_string(user_id), fn(_) {
    #(None, Nil)
  })
}
