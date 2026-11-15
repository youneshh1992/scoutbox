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

/// Loads the demo world into an empty database. A database that has any organisation is left alone: later boots
/// never seed.
pub fn run(store: Store(effect), now: Int) -> Result(Bool, String) {
  use priv <- result.try(
    wisp.priv_directory("scoutbox") |> result.replace_error("no priv directory"),
  )
  use sql <- result.try(
    simplifile.read(priv <> "/seed.sql") |> result.map_error(string.inspect),
  )
  store.unit(store, fn(tx) {
    use existing <- result.try(store.query(
      store.reading(tx),
      "SELECT COUNT(*) FROM orgs",
      [],
      decode.at([0], decode.int),
    ))
    case existing {
      [0] -> {
        use _ <- result.try(store.exec(
          tx,
          string.replace(sql, "NOW_MS", int.to_string(now)),
        ))
        Ok(#(True, []))
      }
      _ -> Ok(#(False, []))
    }
  })
  |> result.map_error(fn(e) { "seed: " <> string.inspect(e) })
}
