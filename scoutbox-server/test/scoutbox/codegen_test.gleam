//// The row generator. A schema or generator change shows up as a snapshot diff: review it with
//// `gleam run -m birdie`.

import birdie
import exception
import gleam/list
import gleam/option.{None, Some}
import gleam/string
import scoutbox/codegen.{Generated, Ided, RefersTo, Shared, Untyped}
import scoutbox_dev

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
  let assert [
    Generated("scoutbox/rows/id", _),
    Generated("scoutbox/vocab/party", party),
    Generated(_, trials),
  ] =
    codegen.generate(
      edge_cases,
      [Shared("Party", ["player", "guardian"])],
      tables: ["trials"],
      ided: [Ided("trials", "Trial", None)],
      id_columns: [],
    )
  birdie.snap(party, title: "a shared vocabulary")
  birdie.snap(trials, title: "a table with every column shape")
}

/// A vocabulary named after a prelude type would shadow it in its row module.
pub fn prelude_named_vocabulary_test() {
  let schema =
    "CREATE TABLE codes (list TEXT NOT NULL CHECK (list IN ('a', 'b'))) STRICT;"
  let assert [_, Generated(_, source)] =
    codegen.generate(schema, [], tables: ["codes"], ided: [], id_columns: [])
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
  let assert [_, Generated(_, source)] =
    codegen.generate(schema, [], tables: ["codes"], ided: [], id_columns: [])
  assert string.contains(source, "#(\"NO_SOURCE\", NoSource)")
  assert string.contains(source, "#(\"GK\", GK)")
  assert string.contains(source, "#(\"LICENCE\", Licence)")
  assert string.contains(source, "#(\"SELF_CHECK\", SelfCheck)")
}

/// A shared vocabulary that no column matches is a mistake in the declarations, not something to skip.
pub fn unused_shared_vocabulary_test() {
  let schema = "CREATE TABLE t (id TEXT PRIMARY KEY) STRICT;"
  let assert Error(_) =
    exception_of(fn() {
      codegen.generate(
        schema,
        [Shared("Party", ["a"])],
        tables: ["t"],
        ided: [Ided("t", "T", None)],
        id_columns: [],
      )
    })
}

/// The real `orgs` table, from the migrations.
pub fn orgs_module_test() {
  let assert Ok(Generated(_, source)) =
    codegen.generate(
      scoutbox_dev.schema(),
      scoutbox_dev.shared,
      scoutbox_dev.tables,
      ided: scoutbox_dev.ided,
      id_columns: scoutbox_dev.id_columns,
    )
    |> list.find(fn(g) { g.module == "scoutbox/rows/orgs" })
  birdie.snap(source, title: "the orgs row module")
}

fn exception_of(f: fn() -> a) -> Result(a, Nil) {
  case exception.rescue(f) {
    Ok(v) -> Ok(v)
    Error(_) -> Error(Nil)
  }
}

const id_schema =
  "
CREATE TABLE clubs (id TEXT PRIMARY KEY) STRICT;
CREATE TABLE trials (
  id         TEXT PRIMARY KEY,
  club_id    TEXT NOT NULL REFERENCES clubs(id),
  host_id    TEXT,
  subject_id TEXT
) STRICT;"

fn generate_ids(
  ided: List(codegen.Ided),
  id_columns: List(codegen.IdColumn),
) -> List(codegen.Generated) {
  codegen.generate(
    id_schema,
    [],
    tables: ["clubs", "trials"],
    ided:,
    id_columns:,
  )
}

/// A table's own id, a foreign key and a column mapped by name are typed; a polymorphic one is declared untyped.
pub fn typed_ids_test() {
  let assert [Generated("scoutbox/rows/id", ids), _, Generated(_, trials)] =
    generate_ids(
      [Ided("clubs", "Club", Some("club")), Ided("trials", "Trial", None)],
      [
        RefersTo("trials.host_id", "clubs"),
        Untyped("subject_id", "polymorphic: its kind is another column"),
      ],
    )
  birdie.snap(ids, title: "the id module")
  birdie.snap(trials, title: "a table with typed ids")
}

/// An id column nothing types is refused, so every new one is decided.
pub fn an_undecided_id_column_is_refused_test() {
  let assert Error(_) =
    exception_of(fn() {
      generate_ids(
        [Ided("clubs", "Club", None), Ided("trials", "Trial", None)],
        [RefersTo("trials.host_id", "clubs")],
      )
    })
}

/// A foreign key to a table whose ids aren't typed is refused too.
pub fn a_key_to_an_untyped_table_is_refused_test() {
  let assert Error(_) =
    exception_of(fn() {
      generate_ids([Ided("trials", "Trial", None)], [
        Untyped("host_id", "test"),
        Untyped("subject_id", "test"),
      ])
    })
}
