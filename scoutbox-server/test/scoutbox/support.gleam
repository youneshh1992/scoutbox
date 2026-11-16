//// A fresh migrated database per test, under build/ so it never lands in the source tree.

import gleam/result
import scoutbox/identity/sessions
import scoutbox/platform/effect.{type Effect}
import scoutbox/platform/migrations
import scoutbox/platform/secrets
import scoutbox/platform/store.{type Store}
import scoutbox/seed
import simplifile

pub fn fresh_store(dispatch: fn(Effect) -> Nil) -> Store {
  let dir = "build/test-dbs"
  let assert Ok(_) = simplifile.create_directory_all(dir)
  let name = dir <> "/" <> secrets.random_hex(8)
  let path = name <> ".db"
  let assert Ok(s) = store.open(path:, readers: 2, dispatch:)
  let assert Ok(_) = migrations.run(s, session_ttl_ms: sessions.default_ttl_ms)
  let assert Ok(True) =
    seed.run(s, 1_000_000, demo: True, data_dir: name)
    |> result.map_error(fn(e) { e })
  s
}
