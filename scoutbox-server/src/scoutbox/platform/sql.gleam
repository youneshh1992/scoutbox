//// SQL built in pieces: each fragment carries the values its `?`s bind, so joining fragments can never put an
//// argument against the wrong placeholder.

import gleam/list
import gleam/string
import sqlight

pub type Fragment {
  Fragment(sql: String, args: List(sqlight.Value))
}

pub fn concat(parts: List(Fragment)) -> Fragment {
  Fragment(
    sql: list.map(parts, fn(p) { p.sql }) |> string.concat,
    args: list.flat_map(parts, fn(p) { p.args }),
  )
}

pub fn text(sql: String) -> Fragment {
  Fragment(sql, [])
}

/// One `?` and its value.
pub fn arg(value: sqlight.Value) -> Fragment {
  Fragment("?", [value])
}

/// `parts` joined by `separator`, e.g. conditions by " AND ".
pub fn join(parts: List(Fragment), separator: String) -> Fragment {
  parts |> list.intersperse(text(separator)) |> concat
}
