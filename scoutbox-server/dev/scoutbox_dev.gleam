//// `gleam dev [out]`: regenerate the row and vocabulary modules from priv/migrations into `out` (default
//// `src`). Use `npm run codegen`, which also formats them; `npm run codegen:check` fails when the committed
//// modules differ from what the migrations generate. Developer tooling only: nothing under dev/ ships.

import argv
import gleam/io
import gleam/list
import gleam/string
import scoutbox/codegen.{Shared}
import simplifile

/// The vocabularies several tables share, declared once. Each must be exactly some column's CHECK list.
pub const shared = [Shared("OrgType", ["club", "agency"])]

pub fn main() -> Nil {
  let out = case argv.load().arguments {
    [out, ..] -> out
    [] -> "src"
  }
  let assert Ok(files) = simplifile.read_directory("priv/migrations")
  let schema =
    files
    |> list.filter(string.ends_with(_, ".sql"))
    |> list.sort(string.compare)
    |> list.map(fn(f) {
      let assert Ok(sql) = simplifile.read("priv/migrations/" <> f)
      sql
    })
    |> string.join("\n")
  let _ = simplifile.delete_all([out <> "/scoutbox/rows", out <> "/scoutbox/vocab"])
  let assert Ok(_) = simplifile.create_directory_all(out <> "/scoutbox/rows")
  let assert Ok(_) = simplifile.create_directory_all(out <> "/scoutbox/vocab")
  list.each(codegen.generate(schema, shared), fn(g) {
    let path = out <> "/" <> g.module <> ".gleam"
    let assert Ok(_) = simplifile.write(path, g.source)
    io.println("wrote " <> path)
  })
}
