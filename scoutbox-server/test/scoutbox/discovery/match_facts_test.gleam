import gleam/dynamic/decode
import gleam/option.{None, Some}
import gleeunit/should
import scoutbox/discovery/match_facts
import scoutbox/platform/store.{type Store}
import scoutbox/support
import sqlight

fn hooked() -> Store {
  let s =
    support.fresh_store(fn(_) { Nil })
    |> store.with_before_commit(match_facts.drain)
  let assert Ok(Nil) = match_facts.start(s)
  s
}

fn count(s: Store, sql: String) -> Int {
  let assert Ok(Ok(n)) =
    store.read(s, store.one(_, sql, [], decode.at([0], decode.int)))
  n
}

fn last_evidence_at(s: Store, player_id: String) -> option.Option(Int) {
  let assert Ok(Ok(at)) =
    store.read(s, store.one(
      _,
      "SELECT last_evidence_at FROM player_match_facts WHERE player_id = ?",
      [sqlight.text(player_id)],
      decode.at([0], decode.optional(decode.int)),
    ))
  at
}

pub fn start_derives_every_live_player_test() {
  let s = hooked()
  count(s, "SELECT COUNT(*) FROM player_match_facts")
  |> should.equal(count(
    s,
    "SELECT COUNT(*) FROM players WHERE deleted_at IS NULL",
  ))
  count(s, "SELECT COUNT(*) FROM player_match_facts_dirty") |> should.equal(0)
  count(s, "SELECT COUNT(*) FROM player_match_facts WHERE trust_band IS NULL")
  |> should.equal(0)
}

pub fn a_unit_leaves_the_facts_current_at_its_commit_test() {
  let s = hooked()
  let assert Ok(Ok(pid)) =
    store.read(s, store.one(
      _,
      "SELECT id FROM players WHERE deleted_at IS NULL ORDER BY id LIMIT 1",
      [],
      decode.at([0], decode.string),
    ))
  let assert Ok(Nil) =
    store.unit(s, fn(tx) {
      store.run(
        tx,
        "INSERT INTO evidence (id, player_id, claim_type, label, source_kind, source_id, source_name, recorded_at, verification_status) VALUES ('ev-facts-test', ?, 'footage', 'Full match', 'org', 'org-eastport', 'Eastport', 4102444800000, 'self_reported')",
        [sqlight.text(pid)],
      )
    })
  last_evidence_at(s, pid) |> should.equal(Some(4_102_444_800_000))
  count(s, "SELECT COUNT(*) FROM player_match_facts_dirty") |> should.equal(0)
}

pub fn a_deleted_player_loses_their_facts_test() {
  let s = hooked()
  let assert Ok(Ok(pid)) =
    store.read(s, store.one(
      _,
      "SELECT id FROM players WHERE deleted_at IS NULL ORDER BY id LIMIT 1",
      [],
      decode.at([0], decode.string),
    ))
  let assert Ok(Nil) =
    store.unit(s, fn(tx) {
      store.run(tx, "UPDATE players SET deleted_at = 1 WHERE id = ?", [
        sqlight.text(pid),
      ])
    })
  count(
    s,
    "SELECT COUNT(*) FROM player_match_facts WHERE player_id = '" <> pid <> "'",
  )
  |> should.equal(0)
  let _ = None
}

fn refresh_due_at(s: Store, player_id: String) -> option.Option(Int) {
  let assert Ok(Ok(at)) =
    store.read(s, store.one(
      _,
      "SELECT refresh_due_at FROM player_match_facts WHERE player_id = ?",
      [sqlight.text(player_id)],
      decode.at([0], decode.optional(decode.int)),
    ))
  at
}

pub fn an_expiry_is_the_next_time_only_change_test() {
  let s = hooked()
  let assert Ok(Ok(pid)) =
    store.read(s, store.one(
      _,
      "SELECT id FROM players WHERE deleted_at IS NULL AND birth_date < '2004-01-01' ORDER BY id LIMIT 1",
      [],
      decode.at([0], decode.string),
    ))
  let assert Ok(Nil) =
    store.unit(s, fn(tx) {
      store.run(
        tx,
        "INSERT INTO evidence (id, player_id, claim_type, label, source_kind, source_id, source_name, recorded_at, verification_status, expires_at) VALUES ('ev-expiring', ?, 'footage', 'Full match', 'org', 'org-eastport', 'Eastport', 1000, 'self_reported', 4102444800000)",
        [sqlight.text(pid)],
      )
    })
  refresh_due_at(s, pid) |> should.equal(Some(4_102_444_800_001))
}
