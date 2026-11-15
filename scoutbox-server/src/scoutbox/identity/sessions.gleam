//// Bearer sessions (`sessions`). A row holds only the token's sha-256; the token exists once server side, in the
//// value `create` returns, which the sign-in puts in its response.
////
//// A session is live while `now - created_at < ttl`. Expired rows stay until the next mint prunes them: a read
//// never writes.

import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/platform/secrets
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/sessions as row
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

fn session(r: row.Row) -> Result(Session, Nil) {
  let holder = case r.kind, r.org_user_id {
    row.Org, Some(user_id) -> Ok(OrgStaff(r.ref_id, user_id))
    row.Player, None -> Ok(Player(r.ref_id))
    row.Guardian, None -> Ok(Guardian(r.ref_id))
    row.TsReviewer, None -> Ok(Reviewer(r.ref_id))
    _, _ -> Error(Nil)
  }
  use holder <- result.map(holder)
  Session(
    sid: r.sid,
    holder:,
    created_at: r.created_at,
    expires_at: r.expires_at,
  )
}

/// Mints a session and returns its token.
pub fn create(tx: Tx, holder: Holder, now: Int) -> Result(String, Fail(e)) {
  let token = secrets.random_hex(24)
  let #(kind, ref_id, user_id) = case holder {
    Player(id) -> #(row.Player, id, None)
    Guardian(id) -> #(row.Guardian, id, None)
    OrgStaff(org_id, user_id) -> #(row.Org, org_id, Some(user_id))
    Reviewer(id) -> #(row.TsReviewer, id, None)
  }
  use _ <- result.try(
    store.run(
      tx,
      "DELETE FROM sessions WHERE created_at <= 0 OR created_at <= ?",
      [sqlight.int(now - ttl_ms)],
    ),
  )
  use _ <- result.try(row.insert(
    tx,
    row.Row(
      token_hash: secrets.sha256_hex(token),
      sid: secrets.random_hex(6),
      kind:,
      ref_id:,
      org_user_id: user_id,
      via: None,
      created_at: now,
      expires_at: now + ttl_ms,
    ),
  ))
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
    "SELECT " <> row.columns <> " FROM sessions WHERE token_hash = ?",
    [sqlight.text(secrets.sha256_hex(token))],
    row.decoder(),
  ))
  case result.try(found, session) {
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
