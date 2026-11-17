//// The SQL check (`gleam dev sql-check`): which queries it can read from the source, and what it refuses.

import gleam/list
import gleam/option.{None, Some}
import scoutbox/sql_check.{Problem, Report, Site}

const schema =
  "CREATE TABLE things (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL);"

const row_module =
  "
pub const table = \"things\"

pub const columns = \"id, name, kind\"
"

/// `body` as the module `scoutbox/a`, with the row module `scoutbox/rows/things` beside it.
fn check(body: String) -> sql_check.Report {
  let source = "import scoutbox/platform/store
import scoutbox/rows/things as thing_row
import sqlight
" <> body
  let assert Ok(report) =
    sql_check.check(
      [
        #("src/scoutbox/a.gleam", source),
        #("src/scoutbox/rows/things.gleam", row_module),
      ],
      schema,
    )
  report
}

fn messages(report: sql_check.Report) -> List(String) {
  list.map(report.problems, fn(p) { p.message })
}

pub fn a_literal_query_is_prepared_test() {
  let report =
    check(
      "
pub fn f(read, id) {
  store.query(read, \"SELECT name FROM things WHERE id = ?\", [sqlight.text(id)], d)
}
",
    )
  assert report == Report(checked: 1, problems: [], unresolved: [])
}

pub fn a_misspelt_column_is_refused_with_its_line_test() {
  let report =
    check(
      "
pub fn f(read) {
  store.query(read, \"SELECT nmae FROM things\", [], d)
}
",
    )
  assert report.problems
    == [
      Problem(
        Site("src/scoutbox/a.gleam", 6, None),
        "SELECT nmae FROM things",
        "no such column: nmae",
      ),
    ]
}

pub fn an_argument_list_must_bind_every_placeholder_test() {
  let report =
    check(
      "
pub fn f(tx, id) {
  store.run(tx, \"UPDATE things SET name = ? WHERE id = ?\", [sqlight.text(id)])
}
",
    )
  assert messages(report) == ["2 placeholders, 1 arguments"]
}

pub fn a_row_modules_constants_and_qualified_columns_resolve_test() {
  let report =
    check(
      "
pub fn f(read) {
  store.query(read, \"SELECT \" <> thing_row.columns <> \" FROM \" <> thing_row.table, [], d)
}

pub fn g(read) {
  store.query(read, \"SELECT \" <> thing_row.qualified(\"t\") <> \" FROM things t WHERE t.nope = 1\", [], d)
}
",
    )
  assert report.checked == 2
  assert messages(report) == ["no such column: t.nope"]
}

pub fn lets_and_module_constants_resolve_test() {
  let report =
    check(
      "
const where = \" WHERE kind = ?\"

pub fn f(read, kind) {
  let sql = \"SELECT id FROM things\" <> where
  let args = [sqlight.text(kind), sqlight.text(kind)]
  store.query(read, sql, args, d)
}
",
    )
  assert messages(report) == ["1 placeholders, 2 arguments"]
}

pub fn a_helper_is_checked_for_each_call_test() {
  let report =
    check(
      "
fn select(read, where, args) {
  store.query(read, \"SELECT \" <> thing_row.columns <> \" FROM things WHERE \" <> where, args, d)
}

pub fn by_id(read, id) {
  select(read, \"id = ?\", [sqlight.text(id)])
}

pub fn by_kind(read, kind) {
  select(read, \"knid = ?\", [sqlight.text(kind)])
}
",
    )
  assert report.checked == 2
  assert report.unresolved == []
  let assert [Problem(site:, message:, ..)] = report.problems
  assert site == Site("src/scoutbox/a.gleam", 6, Some(14))
  assert message == "no such column: knid"
}

pub fn a_call_used_as_the_sql_is_evaluated_test() {
  let report =
    check(
      "
fn select(where) {
  let from = \" FROM things \"
  \"SELECT id\" <> from <> where
}

pub fn f(read, id) {
  store.query(read, select(\"WHERE id = ?\"), [sqlight.text(id)], d)
}
",
    )
  assert report == Report(checked: 1, problems: [], unresolved: [])
}

pub fn a_parameter_is_unresolved_and_hides_a_constant_test() {
  let report =
    check(
      "
const table = \"things\"

pub fn f(read, table) {
  store.query(read, \"SELECT id FROM \" <> table, [], d)
}
",
    )
  assert report
    == Report(checked: 0, problems: [], unresolved: [
      #(Site("src/scoutbox/a.gleam", 8, None), "table"),
    ])
}

pub fn a_temporary_table_is_made_before_the_checks_test() {
  let report =
    check(
      "
pub fn f(tx) {
  let _ = store.exec(tx, \"CREATE TEMP TABLE IF NOT EXISTS counts (n INTEGER NOT NULL)\")
  store.run(tx, \"UPDATE counts SET n = n + 1\", [])
}
",
    )
  assert report == Report(checked: 1, problems: [], unresolved: [])
}

pub fn escapes_in_a_literal_are_read_as_gleam_reads_them_test() {
  let report =
    check(
      "
pub fn f(read) {
  store.query(read, \"SELECT \\\"name\\\" FROM things WHERE kind = 'a\\\\b'\", [], d)
}
",
    )
  assert report == Report(checked: 1, problems: [], unresolved: [])
}

pub fn placeholders_outside_strings_and_comments_are_counted_test() {
  assert sql_check.placeholders("SELECT ? FROM t WHERE a = ? AND b IN (?, ?)")
    == Ok(4)
  assert sql_check.placeholders(
      "SELECT '?', \"a?\" FROM t -- why?\n WHERE /* ? */ a = ?",
    )
    == Ok(1)
  assert sql_check.placeholders("SELECT 'it''s ?' FROM t WHERE a = ?") == Ok(1)
  // Numbered and named parameters bind by name: their count says nothing about the argument list's length.
  assert sql_check.placeholders("SELECT ?1, ?1") == Error(Nil)
  assert sql_check.placeholders("SELECT :id") == Error(Nil)
  assert sql_check.placeholders("SELECT @id") == Error(Nil)
}
