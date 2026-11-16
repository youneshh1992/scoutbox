//// The demo world a first development boot loads: `priv/seed.sql`, the TypeScript server's own seed for the
//// tables this server has (written by `node dev/seed_sql.mjs`). Its timestamps are `NOW_MS + offset`, so the
//// world is as fresh on a first boot here as there. Staff accounts are not seeded; a demo organisation's first
//// sign-in under a name creates the account.

import gleam/dynamic/decode
import gleam/int
import gleam/result
import gleam/string
import scoutbox/platform/store.{type Store}
import simplifile
import wisp

/// The first boot of a database: loads the demo world when `demo` is set, and marks the database installed either
/// way, as the TypeScript server does (`meta.orgsInit` and `meta.coreIdentityInit` go from `pending`, which the
/// migrations write, to `done`). An installed database is never seeded again, nor is one a fixture wrote.
pub fn run(store: Store, now: Int, demo demo: Bool) -> Result(Bool, String) {
  use priv <- result.try(
    wisp.priv_directory("scoutbox") |> result.replace_error("no priv directory"),
  )
  use sql <- result.try(
    simplifile.read(priv <> "/seed.sql") |> result.map_error(string.inspect),
  )
  store.unit(store, fn(tx) {
    use state <- result.try(store.query(
      store.reading(tx),
      "SELECT value FROM meta WHERE key = 'orgsInit'",
      [],
      decode.at([0], decode.string),
    ))
    case state, demo {
      ["pending"], True -> {
        use _ <- result.try(store.exec(
          tx,
          string.replace(sql, "NOW_MS", int.to_string(now)),
        ))
        use _ <- result.try(installed(tx))
        Ok(True)
      }
      ["pending"], False -> {
        use _ <- result.try(installed(tx))
        Ok(False)
      }
      _, _ -> Ok(False)
    }
  })
  |> result.map_error(fn(e) { "seed: " <> string.inspect(e) })
}

fn installed(tx: store.Tx) -> Result(Nil, store.Fail(e)) {
  store.exec(
    tx,
    "UPDATE meta SET value = 'done' WHERE key IN ('orgsInit', 'coreIdentityInit')",
  )
}
