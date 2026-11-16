//// Numbered migrations: `priv/migrations/NNNN_name.sql`, each applied once, in order, in its own unit, and
//// recorded in `data_migrations`. They are the TypeScript server's own migrations, recorded as SQL by
//// `dev/migrations_sql.mjs`, so a database either server creates is the same file. `__NOW__` in a file is the
//// clock and `__SESSION_TTL_MS__` the session lifetime; a file marked `-- foreign_keys: off` rebuilds a table
//// others reference, so it runs with foreign keys off and must leave `foreign_key_check` empty.

import gleam/dynamic/decode
import gleam/int
import gleam/list
import gleam/result
import gleam/string
import scoutbox/platform/clock
import scoutbox/platform/store.{type Store}
import simplifile
import sqlight
import wisp

const bookkeeping =
  "
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS data_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);"

/// The ids of every migration this build has, in order.
pub fn known() -> Result(List(String), String) {
  use dir <- result.try(directory())
  use files <- result.try(
    simplifile.read_directory(dir) |> result.map_error(string.inspect),
  )
  files
  |> list.filter(string.ends_with(_, ".sql"))
  |> list.sort(string.compare)
  |> list.map(string.drop_end(_, 4))
  |> Ok
}

/// The schema version: the number of the latest migration (`0040_match_facts` is 40), as the TypeScript server
/// reports it.
pub fn version(known: List(String)) -> Int {
  case list.last(known) {
    Ok(id) -> string.slice(id, 0, 4) |> int.parse |> result.unwrap(0)
    Error(Nil) -> 0
  }
}

/// Ids are minted from one counter row. Without it the server refuses to start rather than run until the first
/// act that needs an id.
pub fn counter_present(store: Store) -> Result(Nil, String) {
  let found =
    store.read(store, fn(read) {
      store.query(
        read,
        "SELECT 1 FROM counters WHERE name = 'id'",
        [],
        decode.success(Nil),
      )
    })
  case found {
    Ok([_]) -> Ok(Nil)
    Ok(_) ->
      Error(
        "COUNTER_MISSING: the counters table has no 'id' row, so no id could be minted",
      )
    Error(e) -> Error(string.inspect(e))
  }
}

fn directory() -> Result(String, String) {
  wisp.priv_directory("scoutbox")
  |> result.replace_error("the priv directory is missing")
  |> result.map(fn(priv) { priv <> "/migrations" })
}

/// Whether every known migration is recorded and the latest recorded is the latest known. The latest id
/// recorded without the rest is not up to date.
pub fn up_to_date(applied: List(String), known: List(String)) -> Bool {
  version(list.sort(applied, string.compare)) == version(known)
  && list.length(list.filter(known, list.contains(applied, _)))
  == list.length(known)
}

/// Applies every migration not yet recorded. Returns the ids applied now.
pub fn run(
  store: Store,
  session_ttl_ms session_ttl_ms: Int,
) -> Result(List(String), String) {
  use dir <- result.try(directory())
  run_from(store, dir, session_ttl_ms:)
}

/// `run`, with the migrations read from `dir`.
pub fn run_from(
  store: Store,
  dir: String,
  session_ttl_ms session_ttl_ms: Int,
) -> Result(List(String), String) {
  use files <- result.try(
    simplifile.read_directory(dir) |> result.map_error(string.inspect),
  )
  let files =
    files
    |> list.filter(string.ends_with(_, ".sql"))
    |> list.sort(string.compare)
  use _ <- result.try(
    store.unit(store, fn(tx) {
      store.exec(tx, bookkeeping) |> result.replace(Nil)
    })
    |> result.map_error(string.inspect),
  )
  list.try_fold(files, [], fn(applied, file) {
    let id = string.drop_end(file, 4)
    use sql <- result.try(
      simplifile.read(dir <> "/" <> file) |> result.map_error(string.inspect),
    )
    let now = clock.now_ms()
    let fk_off = string.contains(sql, "\n-- foreign_keys: off\n")
    let sql =
      sql
      |> string.replace("__NOW__", int.to_string(now))
      |> string.replace("__SESSION_TTL_MS__", int.to_string(session_ttl_ms))
    use _ <- result.try(case fk_off {
      True -> store.writer_pragma(store, "PRAGMA foreign_keys = OFF")
      False -> Ok(Nil)
    })
    let applied_now =
      store.unit(store, fn(tx) {
        use done <- result.try(store.query(
          store.reading(tx),
          "SELECT 1 FROM data_migrations WHERE id = ?",
          [sqlight.text(id)],
          decode.success(Nil),
        ))
        case done {
          [_] -> Ok(applied)
          _ -> {
            use _ <- result.try(store.exec(tx, sql))
            use broken <- result.try(store.query(
              store.reading(tx),
              "SELECT 1 FROM pragma_foreign_key_check",
              [],
              decode.success(Nil),
            ))
            case broken {
              [] -> {
                use _ <- result.try(
                  store.run(
                    tx,
                    "INSERT INTO data_migrations (id, applied_at) VALUES (?, ?)",
                    [sqlight.text(id), sqlight.int(now)],
                  ),
                )
                Ok([id, ..applied])
              }
              _ -> store.refuse("foreign_key_check found broken references")
            }
          }
        }
      })
      |> result.map_error(fn(e) {
        id
        <> " failed and was rolled back; the database was not modified by it: "
        <> string.inspect(e)
      })
    use _ <- result.try(case fk_off {
      True -> store.writer_pragma(store, "PRAGMA foreign_keys = ON")
      False -> Ok(Nil)
    })
    applied_now
  })
  |> result.map(list.reverse)
}
