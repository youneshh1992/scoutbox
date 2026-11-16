//// The process's counters, as `/admin/metrics` shows them by group (`verification`, `rooms`): counts only, never a
//// player, organisation or person.
////
//// They live for the process, like the TypeScript server's in-memory ones: in a temporary table of the writer's
//// connection, so they are not part of the schema, start at zero on every boot, and a refused act's count rolls
//// back with the act.

import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/result
import scoutbox/platform/store.{type Fail, type Tx}
import sqlight

const table =
  "CREATE TEMP TABLE IF NOT EXISTS process_metrics (grp TEXT NOT NULL, name TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (grp, name))"

/// Counts one occurrence of `name` in `group`.
pub fn count(tx: Tx, group: String, name: String) -> Result(Nil, Fail(e)) {
  use _ <- result.try(store.exec(tx, table))
  store.run(
    tx,
    "INSERT INTO process_metrics (grp, name, n) VALUES (?, ?, 1) ON CONFLICT (grp, name) DO UPDATE SET n = n + 1",
    [sqlight.text(group), sqlight.text(name)],
  )
}

/// A group's counters as an object with exactly `names`, in that order (a name never counted is 0). Read on the
/// writer's connection, which holds them.
pub fn group(
  tx: Tx,
  group: String,
  names: List(String),
) -> Result(Json, Fail(e)) {
  use _ <- result.try(store.exec(tx, table))
  use rows <- result.map(
    store.query(
      store.reading(tx),
      "SELECT name, n FROM process_metrics WHERE grp = ?",
      [sqlight.text(group)],
      {
        use name <- decode.field(0, decode.string)
        use n <- decode.field(1, decode.int)
        decode.success(#(name, n))
      },
    ),
  )
  json.object(
    list.map(names, fn(name) {
      #(name, json.int(list.key_find(rows, name) |> result.unwrap(0)))
    }),
  )
}
