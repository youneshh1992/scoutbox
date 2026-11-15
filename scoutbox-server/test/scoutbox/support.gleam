//// A fresh migrated database per test, under build/ so it never lands in the source tree.

import gleam/result
import scoutbox/platform/migrations
import scoutbox/platform/secrets
import scoutbox/platform/store.{type Store}
import scoutbox/seed
import simplifile

pub fn fresh_store(dispatch: fn(effect) -> Nil) -> Store(effect) {
  let dir = "build/test-dbs"
  let assert Ok(_) = simplifile.create_directory_all(dir)
  let path = dir <> "/" <> secrets.random_hex(8) <> ".db"
  let assert Ok(s) = store.open(path:, readers: 2, dispatch:)
  let assert Ok(_) = migrations.run(s)
  let assert Ok(True) = seed.run(s, 1_000_000) |> result.map_error(fn(e) { e })
  s
}
