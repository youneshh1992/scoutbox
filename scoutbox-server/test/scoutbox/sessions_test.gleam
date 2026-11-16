//// A session lives for the lifetime the server was started with, counted from its creation, so a shorter
//// lifetime also expires sessions minted under a longer one (platform/sessionsAndPorts S9).

import gleam/option.{None, Some}
import scoutbox/identity/sessions
import scoutbox/platform/store
import scoutbox/rows/id
import scoutbox/support

const day = 86_400_000

pub fn a_session_expires_by_the_lifetime_it_is_read_with_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let minted = 1_000_000_000
  let assert Ok(token) =
    store.unit(s, sessions.create(
      _,
      sessions.Player(id.player("pl-adeyemi")),
      minted,
      30 * day,
    ))
  let read = fn(now, ttl) {
    let assert Ok(found) = store.read(s, sessions.by_token(_, token, now, ttl))
    found
  }
  let assert Some(session) = read(minted + 2 * day, 30 * day)
  assert session.holder == sessions.Player(id.player("pl-adeyemi"))
  assert read(minted + 2 * day, day) == None
  assert read(minted + day - 1, day) != None
  assert read(minted + day, day) == None
  let assert Some(by_sid) = read(minted, day)
  let assert Ok(None) =
    store.read(s, sessions.by_sid(_, by_sid.sid, minted + 2 * day, day))
}

pub fn a_mint_prunes_sessions_past_its_lifetime_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let holder = sessions.Player(id.player("pl-kim"))
  let assert Ok(old) = store.unit(s, sessions.create(_, holder, 0 + day, day))
  let assert Ok(_) = store.unit(s, sessions.create(_, holder, 3 * day, day))
  // Read with a long lifetime: the row itself is gone, not just expired.
  let assert Ok(None) =
    store.read(s, sessions.by_token(_, old, 3 * day, 30 * day))
}
