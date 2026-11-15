//// Bearer sessions (`sessions`). A row holds only the token's sha-256; the token exists once server side, in the
//// value `create` returns, which the sign-in puts in its response.
////
//// A session is live while `now - created_at < ttl`. Expired rows stay until the next mint prunes them: a read
//// never writes.

import gleam/dynamic/decode.{type Decoder}
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/platform/secrets
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import sqlight

pub const ttl_ms = 2_592_000_000

/// Who a session signs in. Only staff sessions are minted by the routes this server runs so far.
pub type Holder {
  Player(id: String)
  Guardian(id: String)
  OrgStaff(org_id: String, user_id: String)
  Reviewer(id: String)
}

pub type Session {
  Session(sid: String, holder: Holder, created_at: Int, expires_at: Int)
}

fn decoder() -> Decoder(Session) {
  use sid <- decode.field(0, decode.string)
  use kind <- decode.field(1, decode.string)
  use ref_id <- decode.field(2, decode.string)
  use user_id <- decode.field(3, decode.optional(decode.string))
  use created_at <- decode.field(4, decode.int)
  use expires_at <- decode.field(5, decode.int)
  let holder = case kind, user_id {
    "org", Some(user_id) -> Ok(OrgStaff(ref_id, user_id))
    "player", None -> Ok(Player(ref_id))
    "guardian", None -> Ok(Guardian(ref_id))
    "ts_reviewer", None -> Ok(Reviewer(ref_id))
    _, _ -> Error(Nil)
  }
  case holder {
    Ok(holder) ->
      decode.success(Session(sid:, holder:, created_at:, expires_at:))
    Error(Nil) ->
      decode.failure(
        Session("", Player(""), 0, 0),
        "a session kind with its staff member on org sessions only",
      )
  }
}

/// Mints a session and returns its token.
pub fn create(tx: Tx, holder: Holder, now: Int) -> Result(String, Fail(e)) {
  let token = secrets.random_hex(24)
  let #(kind, ref_id, user_id) = case holder {
    Player(id) -> #("player", id, None)
    Guardian(id) -> #("guardian", id, None)
    OrgStaff(org_id, user_id) -> #("org", org_id, Some(user_id))
    Reviewer(id) -> #("ts_reviewer", id, None)
  }
  use _ <- result.try(
    store.run(
      tx,
      "DELETE FROM sessions WHERE created_at <= 0 OR created_at <= ?",
      [
        sqlight.int(now - ttl_ms),
      ],
    ),
  )
  use _ <- result.try(
    store.run(
      tx,
      "INSERT INTO sessions (token_hash, sid, kind, ref_id, org_user_id, via, created_at, expires_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
      [
        sqlight.text(secrets.sha256_hex(token)),
        sqlight.text(secrets.random_hex(6)),
        sqlight.text(kind),
        sqlight.text(ref_id),
        sqlight.nullable(sqlight.text, user_id),
        sqlight.int(now),
        sqlight.int(now + ttl_ms),
      ],
    ),
  )
  Ok(token)
}

/// The live session for a presented token.
pub fn by_token(
  read: Read,
  token: String,
  now: Int,
) -> Result(Option(Session), Fail(e)) {
  use found <- result.map(store.one(
    read,
    "SELECT sid, kind, ref_id, org_user_id, created_at, expires_at FROM sessions WHERE token_hash = ?",
    [sqlight.text(secrets.sha256_hex(token))],
    decoder(),
  ))
  case found {
    Ok(s) if s.created_at > 0 && now - s.created_at < ttl_ms -> Some(s)
    _ -> None
  }
}

/// Ends every session of a staff member.
pub fn revoke_org_user(tx: Tx, user_id: String) -> Result(Nil, Fail(e)) {
  store.run(tx, "DELETE FROM sessions WHERE kind = 'org' AND org_user_id = ?", [
    sqlight.text(user_id),
  ])
}
