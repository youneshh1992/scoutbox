//// The migration runner. These are the checks the TypeScript server moved from the platform/contracts battery
//// (§10) to its scripts/testDataLayer.mjs, made of this server's own runner.

import gleam/dynamic/decode
import gleam/list
import gleam/regexp
import gleam/set
import gleam/string
import scoutbox/identity/sessions
import scoutbox/platform/migrations
import scoutbox/platform/secrets
import scoutbox/platform/store
import simplifile
import sqlight

fn fresh() -> store.Store {
  let dir = "build/test-dbs"
  let assert Ok(_) = simplifile.create_directory_all(dir)
  let assert Ok(s) =
    store.open(
      path: dir <> "/" <> secrets.random_hex(8) <> ".db",
      readers: 1,
      dispatch: fn(_) { Nil },
    )
  s
}

fn recorded(s: store.Store) -> List(String) {
  let assert Ok(ids) =
    store.read(s, store.query(
      _,
      "SELECT id FROM data_migrations ORDER BY id",
      [],
      decode.at([0], decode.string),
    ))
  ids
}

fn has_table(s: store.Store, name: String) -> Bool {
  let assert Ok(found) =
    store.read(s, store.query(
      _,
      "SELECT 1 FROM sqlite_master WHERE name = ?",
      [sqlight.text(name)],
      decode.success(Nil),
    ))
  found != []
}

pub fn ordered_idempotent_and_recorded_once_test() {
  let assert Ok(known) = migrations.known()
  let s = fresh()
  let assert Ok(first) = migrations.run(s, session_ttl_ms: sessions.ttl_ms)
  // A fresh database runs every migration, in id order.
  assert first == known
  assert first == list.sort(known, string.compare)
  // A second run applies nothing, and each migration is recorded once.
  let assert Ok([]) = migrations.run(s, session_ttl_ms: sessions.ttl_ms)
  assert recorded(s) == known
  assert migrations.up_to_date(recorded(s), known)
}

pub fn every_migration_has_a_stable_numbered_id_test() {
  let assert Ok(known) = migrations.known()
  let assert Ok(shape) = regexp.from_string("^\\d{4}_[a-z0-9_]+$")
  assert list.all(known, regexp.check(shape, _))
  assert set.size(set.from_list(known)) == list.length(known)
  assert migrations.version(known) >= 40
}

/// A failing migration names itself, and its transaction is rolled back: no table it created, no record of it.
pub fn a_failing_migration_changes_nothing_test() {
  let assert Ok(known) = migrations.known()
  let dir = "build/test-migrations/" <> secrets.random_hex(8)
  let assert Ok(_) = simplifile.create_directory_all(dir)
  list.each(known, fn(id) {
    let assert Ok(_) =
      simplifile.copy_file(
        "priv/migrations/" <> id <> ".sql",
        dir <> "/" <> id <> ".sql",
      )
  })
  let assert Ok(_) =
    simplifile.write(
      dir <> "/9999_broken_on_purpose.sql",
      "CREATE TABLE broken_on_purpose (x TEXT);\nSELECT * FROM no_such_table;",
    )
  let s = fresh()
  let assert Ok(_) = migrations.run(s, session_ttl_ms: sessions.ttl_ms)
  let assert Error(message) =
    migrations.run_from(s, dir, session_ttl_ms: sessions.ttl_ms)
  assert string.starts_with(message, "9999_broken_on_purpose failed")
  assert string.contains(message, "not modified")
  assert !has_table(s, "broken_on_purpose")
  assert recorded(s) == known
}

/// The latest id recorded without the rest is not every migration applied.
pub fn the_latest_alone_is_not_up_to_date_test() {
  let assert Ok(known) = migrations.known()
  let assert Ok(latest) = list.last(known)
  assert !migrations.up_to_date([latest], known)
  assert !migrations.up_to_date(list.take(known, list.length(known) - 1), known)
}
