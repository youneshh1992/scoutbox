//// A child's pairing code (repositories/oneTimeCodes.ts): one live code per child, for 15 minutes, used once.

import gleam/option.{None, Some}
import scoutbox/identity/pairing
import scoutbox/platform/limits.{PairingAttempt}
import scoutbox/platform/store
import scoutbox/rows/id
import scoutbox/support

const guni = "pl-guni"

pub fn a_code_pairs_its_child_once_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let assert Ok(issued) = store.unit(s, pairing.issue(_, id.player(guni), 0))
  assert issued.expires_at == pairing.ttl_ms
  // Compared as typed, whatever its case and spacing.
  assert store.read(s, pairing.live(_, " " <> issued.code <> " ", 1))
    == Ok(Some(id.player(guni)))
  assert store.unit(s, pairing.consume(_, issued.code, 1))
    == Ok(Some(id.player(guni)))
  assert store.unit(s, pairing.consume(_, issued.code, 2)) == Ok(None)
  assert store.read(s, pairing.live(_, issued.code, 2)) == Ok(None)
}

pub fn a_fresh_code_replaces_the_last_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let assert Ok(first) = store.unit(s, pairing.issue(_, id.player(guni), 0))
  let assert Ok(second) = store.unit(s, pairing.issue(_, id.player(guni), 1))
  assert store.read(s, pairing.live(_, first.code, 2)) == Ok(None)
  assert store.read(s, pairing.live(_, second.code, 2))
    == Ok(Some(id.player(guni)))
}

pub fn an_expired_code_pairs_nothing_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let assert Ok(issued) = store.unit(s, pairing.issue(_, id.player(guni), 0))
  assert store.read(s, pairing.live(_, issued.code, pairing.ttl_ms)) == Ok(None)
  assert store.unit(s, pairing.consume(_, issued.code, pairing.ttl_ms))
    == Ok(None)
}

/// Only a wrong code is charged: reading the budget spends none of it, and the 20th wrong code spends the last.
pub fn twenty_wrong_codes_per_address_test() {
  let assert Ok(l) = limits.start()
  assert !limits.spent(l, PairingAttempt, "10.0.0.1", 0)
  repeat(19, fn() {
    let _ = limits.limited(l, PairingAttempt, "10.0.0.1", 0)
    Nil
  })
  assert !limits.spent(l, PairingAttempt, "10.0.0.1", 0)
  let _ = limits.limited(l, PairingAttempt, "10.0.0.1", 0)
  assert limits.spent(l, PairingAttempt, "10.0.0.1", 0)
  assert !limits.spent(l, PairingAttempt, "10.0.0.2", 0)
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
