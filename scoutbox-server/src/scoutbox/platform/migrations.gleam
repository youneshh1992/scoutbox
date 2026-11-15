//// Numbered migrations: `priv/migrations/NNNN_name.sql`, each applied once, in order, in its own unit, and
//// recorded in `data_migrations`. The tables are what the TypeScript server's migrations leave.

import gleam/dynamic/decode
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

/// Applies every migration not yet recorded. Returns the ids applied now.
pub fn run(store: Store(effect)) -> Result(List(String), String) {
  use dir <- result.try(
    wisp.priv_directory("scoutbox")
    |> result.replace_error("the priv directory is missing")
    |> result.map(fn(priv) { priv <> "/migrations" }),
  )
  use files <- result.try(
    simplifile.read_directory(dir) |> result.map_error(string.inspect),
  )
  let files =
    files
    |> list.filter(string.ends_with(_, ".sql"))
    |> list.sort(string.compare)
  use _ <- result.try(
    store.unit(store, fn(tx) {
      store.exec(tx, bookkeeping) |> result.map(fn(_) { #(Nil, []) })
    })
    |> result.map_error(string.inspect),
  )
  list.try_fold(files, [], fn(applied, file) {
    let id = string.drop_end(file, 4)
    use sql <- result.try(
      simplifile.read(dir <> "/" <> file) |> result.map_error(string.inspect),
    )
    store.unit(store, fn(tx) {
      use done <- result.try(store.query(
        store.reading(tx),
        "SELECT 1 FROM data_migrations WHERE id = ?",
        [sqlight.text(id)],
        decode.success(Nil),
      ))
      case done {
        [_] -> Ok(#(applied, []))
        _ -> {
          use _ <- result.try(store.exec(tx, sql))
          use _ <- result.try(
            store.run(
              tx,
              "INSERT INTO data_migrations (id, applied_at) VALUES (?, ?)",
              [sqlight.text(id), sqlight.int(clock.now_ms())],
            ),
          )
          Ok(#([id, ..applied], []))
        }
      }
    })
    |> result.map_error(fn(e) { id <> ": " <> string.inspect(e) })
  })
  |> result.map(list.reverse)
}
