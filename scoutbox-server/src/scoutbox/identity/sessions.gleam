//// Bearer sessions (`sessions`). A row holds only the token's sha-256; the token exists once server side, in the
//// value `create` returns, which the sign-in puts in its response.
////
//// A session is live while `now - created_at < ttl`, the lifetime the server was started with
//// (`config.session_ttl_ms`), so a shorter lifetime also expires sessions minted under a longer one. Expired rows
//// stay until the next mint prunes them: a read never writes.

import gleam/dynamic/decode
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/platform/effect
import scoutbox/platform/secrets
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/id
import scoutbox/rows/sessions as row
import sqlight

/// The default lifetime: 30 days.
pub const default_ttl_ms = 2_592_000_000

/// Who a session signs in. Only staff sessions are minted by the routes this server runs so far.
pub type Holder {
  Player(id: id.PlayerId)
  Guardian(id: id.GuardianId)
  OrgStaff(org_id: id.OrgId, user_id: id.OrgUserId)
  /// A Trust & Safety reviewer, who has no table here.
  Reviewer(id: String)
}

pub type Session {
  Session(sid: String, holder: Holder, created_at: Int, expires_at: Int)
}

/// `ref_id` is polymorphic: `kind` says whose id it is.
fn session(r: row.Row) -> Result(Session, Nil) {
  let holder = case r.kind, r.org_user_id {
    row.Org, Some(user_id) -> Ok(OrgStaff(id.org(r.ref_id), user_id))
    row.Player, None -> Ok(Player(id.player(r.ref_id)))
    row.Guardian, None -> Ok(Guardian(id.guardian(r.ref_id)))
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
pub fn create(
  tx: Tx,
  holder: Holder,
  now: Int,
  ttl_ms: Int,
) -> Result(String, Fail(e)) {
  create_via(tx, holder, now, ttl_ms, None)
}

/// Mints a session signed in another way than a password (`Some(row.Sso)`), and returns its token.
pub fn create_via(
  tx: Tx,
  holder: Holder,
  now: Int,
  ttl_ms: Int,
  via: Option(row.Via),
) -> Result(String, Fail(e)) {
  let token = secrets.random_hex(24)
  let #(kind, ref_id, user_id) = case holder {
    Player(p) -> #(row.Player, id.player_to_string(p), None)
    Guardian(g) -> #(row.Guardian, id.guardian_to_string(g), None)
    OrgStaff(org_id, user_id) -> #(
      row.Org,
      id.org_to_string(org_id),
      Some(user_id),
    )
    Reviewer(reviewer) -> #(row.TsReviewer, reviewer, None)
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
      via:,
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
  ttl_ms: Int,
) -> Result(Option(Session), Fail(e)) {
  use found <- result.map(store.one(
    read,
    "SELECT " <> row.columns <> " FROM sessions WHERE token_hash = ?",
    [sqlight.text(secrets.sha256_hex(token))],
    row.decoder(),
  ))
  live(found, now, ttl_ms)
}

/// The live session with this sid: an event-stream ticket names its session by sid, never by token.
pub fn by_sid(
  read: Read,
  sid: String,
  now: Int,
  ttl_ms: Int,
) -> Result(Option(Session), Fail(e)) {
  use found <- result.map(store.one(
    read,
    "SELECT " <> row.columns <> " FROM sessions WHERE sid = ?",
    [sqlight.text(sid)],
    row.decoder(),
  ))
  live(found, now, ttl_ms)
}

fn live(found: Result(row.Row, Nil), now: Int, ttl_ms: Int) -> Option(Session) {
  case result.try(found, session) {
    Ok(s) if s.created_at > 0 && now - s.created_at < ttl_ms -> Some(s)
    _ -> None
  }
}

/// A staff member's sessions, oldest first, expired ones not yet pruned included (`GET /org/sessions`).
pub fn of_org_user(
  read: Read,
  user_id: id.OrgUserId,
) -> Result(List(row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> row.columns
      <> " FROM sessions WHERE kind = 'org' AND org_user_id = ? ORDER BY created_at, sid",
    [id.org_user_sql(user_id)],
    row.decoder(),
  )
}

/// Whether `token` is the session's own.
pub fn is_token_of(session: row.Row, token: String) -> Bool {
  token != "" && session.token_hash == secrets.sha256_hex(token)
}

/// Ends one of a staff member's own sessions by sid, and says how many ended (0 or 1).
pub fn revoke_own(
  tx: Tx,
  user_id: id.OrgUserId,
  sid: String,
) -> Result(Int, Fail(e)) {
  store.write(
    tx,
    "DELETE FROM sessions WHERE kind = 'org' AND org_user_id = ? AND sid = ? RETURNING sid",
    [id.org_user_sql(user_id), sqlight.text(sid)],
    decode.at([0], decode.string),
  )
  |> result.map(list.length)
}

/// Ends one session: a sign-out. Its event-stream tickets and media links stop working with it.
pub fn revoke_sid(tx: Tx, sid: String) -> Result(Nil, Fail(e)) {
  store.run(tx, "DELETE FROM sessions WHERE sid = ?", [sqlight.text(sid)])
}

/// Ends every session of a Trust & Safety reviewer.
pub fn revoke_reviewer(tx: Tx, reviewer_id: String) -> Result(Nil, Fail(e)) {
  store.run(
    tx,
    "DELETE FROM sessions WHERE kind = 'ts_reviewer' AND ref_id = ?",
    [sqlight.text(reviewer_id)],
  )
}

/// Ends every session of a staff member, and (after COMMIT) closes their open streams.
pub fn revoke_org_user(tx: Tx, user_id: id.OrgUserId) -> Result(Nil, Fail(e)) {
  use Nil <- result.map(
    store.run(
      tx,
      "DELETE FROM sessions WHERE kind = 'org' AND org_user_id = ?",
      [id.org_user_sql(user_id)],
    ),
  )
  store.emit(tx, effect.CloseStreams(id.org_user_to_string(user_id)))
}
