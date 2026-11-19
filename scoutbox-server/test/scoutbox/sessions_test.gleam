//// A session lives for the lifetime the server was started with, counted from its creation, so a shorter
//// lifetime also expires sessions minted under a longer one (platform/sessionsAndPorts S9).

import gleam/list
import gleam/option.{None, Some}
import gleam/string
import scoutbox/identity/sessions
import scoutbox/identity/staff
import scoutbox/platform/store
import scoutbox/rows/id
import scoutbox/rows/sessions as session_row
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

/// `POST /org/sessions/revoke` ends only the member's own session: another member's sid ends nothing.
pub fn a_member_ends_only_their_own_sessions_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let org = id.org("org-eastport")
  let member = fn(name) {
    let assert Ok(u) =
      store.unit(s, staff.create(
        _,
        staff.NewStaff(
          org_id: org,
          name:,
          role: "Scout",
          email: None,
          provenance: None,
          created_at: 1,
        ),
      ))
    u
  }
  let maria = member("Maria")
  let tom = member("Tom")
  let mint = fn(user_id, via) {
    let assert Ok(token) =
      store.unit(s, sessions.create_via(
        _,
        sessions.OrgStaff(org, user_id),
        1_000_000_000,
        30 * day,
        via,
      ))
    token
  }
  let first = mint(maria.id, None)
  let _ = mint(maria.id, Some(session_row.Sso))
  let _ = mint(tom.id, None)
  let assert Ok([a, b]) = store.read(s, sessions.of_org_user(_, maria.id))
  assert sessions.is_token_of(a, first) != sessions.is_token_of(b, first)
  assert !sessions.is_token_of(a, "")
  assert list.sort([a.via, b.via], fn(x, y) {
      string.compare(string.inspect(x), string.inspect(y))
    })
    == [None, Some(session_row.Sso)]
  let assert Ok([toms]) = store.read(s, sessions.of_org_user(_, tom.id))
  assert store.unit(s, sessions.revoke_own(_, maria.id, toms.sid)) == Ok(0)
  assert store.unit(s, sessions.revoke_own(_, maria.id, a.sid)) == Ok(1)
  let assert Ok([left]) = store.read(s, sessions.of_org_user(_, maria.id))
  assert left.sid == b.sid
}
