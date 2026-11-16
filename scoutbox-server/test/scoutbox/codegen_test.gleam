//// The row generator. A schema or generator change shows up as a snapshot diff: review it with
//// `gleam run -m birdie`.

import birdie
import exception
import gleam/list
import gleam/string
import scoutbox/codegen.{Generated, Shared}
import scoutbox_dev
import simplifile

const edge_cases =
  "
CREATE TABLE trials (
  seq      INTEGER PRIMARY KEY,
  id       TEXT NOT NULL UNIQUE,
  status   TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  venue    TEXT CHECK (venue IS NULL OR venue IN ('open', 'indoor', '5-a-side')),
  \"type\"   TEXT,
  by_kind  TEXT NOT NULL CHECK (by_kind IN ('player','guardian')),
  urgent   INTEGER NOT NULL DEFAULT 0 CHECK (urgent IN (0,1)),
  seen     INTEGER,
  note     TEXT CHECK (note IS NULL OR status IN ('closed')),
  shown    TEXT GENERATED ALWAYS AS (CASE WHEN seen = 1 THEN id END) STORED,
  CHECK (seen IS NULL OR seen IN (0, 1))
) STRICT;"

/// A rowid and a generated column (so a `New`), two enums sharing a value, a shared vocabulary, a keyword
/// column, defaults, a table-level boolean, and a CHECK naming another column that must not become `note`'s
/// vocabulary.
pub fn edge_cases_test() {
  let assert [Generated("scoutbox/vocab/party", party), Generated(_, trials)] =
    codegen.generate(edge_cases, [Shared("Party", ["player", "guardian"])])
  birdie.snap(party, title: "a shared vocabulary")
  birdie.snap(trials, title: "a table with every column shape")
}

/// A vocabulary named after a prelude type would shadow it in its row module.
pub fn prelude_named_vocabulary_test() {
  let schema =
    "CREATE TABLE codes (list TEXT NOT NULL CHECK (list IN ('a', 'b'))) STRICT;"
  let assert [Generated(_, source)] = codegen.generate(schema, [])
  assert string.contains(source, "pub type ListValue {")
  assert !string.contains(source, "pub type List {")
}

/// A CHECK allowing a different list in each case has all of them as its vocabulary, and upper-case codes of
/// several words read as words.
pub fn several_lists_in_one_check_test() {
  let schema =
    "CREATE TABLE codes (
  kind TEXT NOT NULL CHECK (kind IN ('a', 'b')),
  code TEXT NOT NULL CHECK ((kind = 'a' AND code IN ('NO_SOURCE', 'GK', 'LICENCE')) OR (kind = 'b' AND code IN ('SELF_CHECK')))
) STRICT;"
  let assert [Generated(_, source)] = codegen.generate(schema, [])
  assert string.contains(source, "#(\"NO_SOURCE\", NoSource)")
  assert string.contains(source, "#(\"GK\", GK)")
  assert string.contains(source, "#(\"LICENCE\", Licence)")
  assert string.contains(source, "#(\"SELF_CHECK\", SelfCheck)")
}

/// A shared vocabulary that no column matches is a mistake in the declarations, not something to skip.
pub fn unused_shared_vocabulary_test() {
  let schema = "CREATE TABLE t (id TEXT PRIMARY KEY) STRICT;"
  let assert Error(_) =
    exception_of(fn() { codegen.generate(schema, [Shared("Party", ["a"])]) })
}

/// The real `orgs` table, from the migrations.
pub fn orgs_module_test() {
  let assert Ok(files) = simplifile.read_directory("priv/migrations")
  let schema =
    files
    |> list.sort(string.compare)
    |> list.map(fn(f) {
      let assert Ok(sql) = simplifile.read("priv/migrations/" <> f)
      sql
    })
    |> string.join("\n")
  let assert Ok(Generated(_, source)) =
    codegen.generate(schema, scoutbox_dev.shared)
    |> list.find(fn(g) { g.module == "scoutbox/rows/orgs" })
  birdie.snap(source, title: "the orgs row module")
}

fn exception_of(f: fn() -> a) -> Result(a, Nil) {
  case exception.rescue(f) {
    Ok(v) -> Ok(v)
    Error(_) -> Error(Nil)
  }
}
