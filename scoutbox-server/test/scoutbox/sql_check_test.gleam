//// The SQL check (`gleam dev sql-check`): which queries it can read from the source, what it ties their arguments
//// to, and what it refuses.

import gleam/list
import gleam/option.{None, Some}
import scoutbox/sql_check.{Problem}
import scoutbox/sql_source.{Site}
import scoutbox/sql_text

const schema =
  "
CREATE TABLE things (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, org_id TEXT NOT NULL, note TEXT,
  n INTEGER NOT NULL);
CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL);
"

const things_module =
  "
import gleam/option.{type Option}
import scoutbox/rows/id

pub const table = \"things\"

pub const columns = \"id, name, kind, org_id, note, n\"

pub type Kind {
  Big
  Small
}

pub fn kind_to_string(value: Kind) -> String {
  \"big\"
}

pub type Row {
  Row(id: id.ThingId, name: String, kind: Kind, org_id: id.OrgId, note: Option(String), n: Int)
}
"

const orgs_module =
  "
import scoutbox/rows/id

pub const table = \"orgs\"

pub const columns = \"id, name\"

pub type Row {
  Row(id: id.OrgId, name: String)
}
"

const id_module =
  "
pub fn thing_sql(id: ThingId) -> Value { v(id) }

pub fn org_sql(id: OrgId) -> Value { v(id) }
"

const colour_module =
  "
pub fn to_string(value: Colour) -> String { \"red\" }
"

/// `body` as the module `scoutbox/a`, beside the row modules for `things` and `orgs`, their ids and a vocabulary.
fn check(body: String) -> sql_check.Report {
  let source = "import scoutbox/platform/store
import scoutbox/rows/id
import scoutbox/rows/things as thing_row
import scoutbox/vocab/colour
import sqlight
" <> body
  let assert Ok(report) =
    sql_check.check(
      [
        #("src/scoutbox/a.gleam", source),
        #("src/scoutbox/rows/things.gleam", things_module),
        #("src/scoutbox/rows/orgs.gleam", orgs_module),
        #("src/scoutbox/rows/id.gleam", id_module),
        #("src/scoutbox/vocab/colour.gleam", colour_module),
      ],
      schema,
    )
  report
}

fn messages(report: sql_check.Report) -> List(String) {
  list.map(report.problems, fn(p) { p.message })
}

// --- Reading the queries -----------------------------------------------------------------------------------------

pub fn a_literal_query_is_prepared_test() {
  let report =
    check(
      "
pub fn f(read, t) {
  store.query(read, \"SELECT name FROM things WHERE id = ?\", [id.thing_sql(t)], d)
}
",
    )
  assert report.checked == 1
  assert report.problems == []
  assert report.unresolved == []
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
        Site("src/scoutbox/a.gleam", 8, None),
        "SELECT nmae FROM things",
        "no such column: nmae",
      ),
    ]
}

pub fn an_argument_list_must_bind_every_placeholder_test() {
  let report =
    check(
      "
pub fn f(tx, t) {
  store.run(tx, \"UPDATE things SET name = ? WHERE id = ?\", [id.thing_sql(t)])
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
const where = \" WHERE name = ?\"

pub fn f(read, name) {
  let sql = \"SELECT id FROM things\" <> where
  let args = [sqlight.text(name), sqlight.text(name)]
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

pub fn by_id(read, t) {
  select(read, \"id = ?\", [id.thing_sql(t)])
}

pub fn by_org(read, t) {
  select(read, \"org_id = ?\", [id.thing_sql(t)])
}

pub fn by_name(read, name) {
  select(read, \"nmae = ?\", [sqlight.text(name)])
}
",
    )
  assert report.checked == 3
  assert report.unresolved == []
  assert list.map(report.problems, fn(p) { #(p.site, p.message) })
    == [
      #(
        Site("src/scoutbox/a.gleam", 8, Some(16)),
        "argument 1 binds a thing id to things.org_id, which holds org ids",
      ),
      #(Site("src/scoutbox/a.gleam", 8, Some(20)), "no such column: nmae"),
    ]
}

pub fn a_call_used_as_the_sql_is_evaluated_test() {
  let report =
    check(
      "
fn select(where) {
  let from = \" FROM things \"
  \"SELECT id\" <> from <> where
}

pub fn f(read, t) {
  store.query(read, select(\"WHERE id = ?\"), [id.thing_sql(t)], d)
}
",
    )
  assert report.checked == 1
  assert report.problems == []
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
  assert report.checked == 0
  assert report.unresolved
    == [#(Site("src/scoutbox/a.gleam", 10, None), "table")]
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
  assert report.checked == 1
  assert report.problems == []
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
  assert report.checked == 1
  assert report.problems == []
}

// --- Arguments and the columns they bind -------------------------------------------------------------------------

pub fn swapped_ids_are_refused_test() {
  let report =
    check(
      "
pub fn f(read, t, o) {
  store.query(read, \"SELECT name FROM things WHERE id = ? AND org_id = ?\", [id.org_sql(o), id.thing_sql(t)], d)
}
",
    )
  assert report.tied == 2
  assert messages(report)
    == [
      "argument 1 binds an org id to things.id, which holds thing ids",
      "argument 2 binds a thing id to things.org_id, which holds org ids",
    ]
}

pub fn an_insert_ties_each_value_to_its_column_test() {
  let report =
    check(
      "
pub fn f(tx, t, o, n) {
  store.run(tx, \"INSERT INTO things (id, name, kind, org_id, note, n) VALUES (?, ?, 'big', ?, ?, ?)\", [
    id.thing_sql(t), sqlight.null(), id.org_sql(o), sqlight.null(), sqlight.text(n),
  ])
}
",
    )
  assert report.tied == 5
  assert messages(report)
    == [
      "argument 2 binds NULL to things.name, which is NOT NULL",
      "argument 5 binds text to things.n, which holds integers",
    ]
}

pub fn a_set_may_not_bind_null_to_a_not_null_column_test() {
  let report =
    check(
      "
pub fn f(tx, t, note, n) {
  store.run(tx, \"UPDATE things SET note = ?, n = ? WHERE id = ?\", [
    sqlight.nullable(sqlight.text, note), sqlight.nullable(sqlight.int, n), id.thing_sql(t),
  ])
}
",
    )
  assert messages(report)
    == ["argument 2 can bind NULL to things.n, which is NOT NULL"]
}

pub fn comparing_with_null_needs_is_test() {
  let report =
    check(
      "
pub fn f(read) {
  store.query(read, \"SELECT id FROM things WHERE note = ? OR note IS ?\", [sqlight.null(), sqlight.null()], d)
}
",
    )
  assert messages(report)
    == [
      "argument 1 compares things.note with NULL using =, which is never true",
    ]
}

pub fn a_vocabulary_column_takes_its_own_vocabulary_test() {
  let report =
    check(
      "
pub fn f(tx, k, c, s) {
  store.run(tx, \"UPDATE things SET kind = ? WHERE kind = ? OR kind = ?\", [
    sqlight.text(thing_row.kind_to_string(k)), sqlight.text(colour.to_string(c)), sqlight.text(s),
  ])
}
",
    )
  assert messages(report)
    == [
      "argument 2 binds a Colour (scoutbox/vocab/colour) to things.kind, which holds Kind values (scoutbox/rows/things)",
    ]
  assert list.map(report.untyped, fn(u) { u.1 })
    == ["argument 3 binds text to things.kind"]
}

pub fn an_alias_names_its_table_and_an_ambiguous_column_is_skipped_test() {
  let report =
    check(
      "
pub fn f(read, t) {
  store.query(read, \"SELECT o.name FROM orgs AS o WHERE o.id = ? AND o.name IN (SELECT t.name FROM things t WHERE name = ?)\", [
    id.thing_sql(t), sqlight.int(1),
  ], d)
}
",
    )
  // SQLite reads the subquery's bare `name` as `things.name`, but both tables have one, so this check doesn't
  // guess: the int bound to it isn't compared.
  assert report.tied == 1
  assert messages(report)
    == ["argument 1 binds a thing id to orgs.id, which holds org ids"]
}

pub fn only_a_placeholder_standing_alone_is_tied_test() {
  let report =
    check(
      "
pub fn f(read, a, b) {
  store.query(read, \"SELECT id FROM things WHERE n + 1 = ? AND name = ? || 'x' AND n IN (?, ?)\", [
    sqlight.text(a), sqlight.int(1), sqlight.text(b), sqlight.int(2),
  ], d)
}
",
    )
  assert report.tied == 2
  assert messages(report)
    == ["argument 3 binds text to things.n, which holds integers"]
}

pub fn a_bare_column_beside_a_cte_is_not_tied_test() {
  let report =
    check(
      "
pub fn f(read) {
  store.query(read, \"WITH x AS (SELECT id FROM things) SELECT id FROM x WHERE id = ?\", [sqlight.int(1)], d)
}
",
    )
  assert report.tied == 0
  assert report.problems == []
}

pub fn a_module_shared_with_a_local_name_is_still_read_test() {
  // Gleam reaches the module through `id.thing_sql` even with a local `id` in scope.
  let report =
    check(
      "
pub fn f(read) {
  let id = make()
  store.query(read, \"SELECT name FROM things WHERE org_id = ?\", [id.thing_sql(id)], d)
}
",
    )
  assert messages(report)
    == ["argument 1 binds a thing id to things.org_id, which holds org ids"]
}

// --- Tokens ------------------------------------------------------------------------------------------------------

pub fn placeholders_outside_strings_and_comments_are_counted_test() {
  assert sql_text.placeholders("SELECT ? FROM t WHERE a = ? AND b IN (?, ?)")
    == Ok(4)
  assert sql_text.placeholders(
      "SELECT '?', \"a?\" FROM t -- why?\n WHERE /* ? */ a = ?",
    )
    == Ok(1)
  assert sql_text.placeholders("SELECT 'it''s ?' FROM t WHERE a = ?") == Ok(1)
  // Numbered and named parameters bind by name: their count says nothing about the argument list's length.
  assert sql_text.placeholders("SELECT ?1, ?1") == Error(Nil)
  assert sql_text.placeholders("SELECT :id") == Error(Nil)
  assert sql_text.placeholders("SELECT @id") == Error(Nil)
}

pub fn quoted_names_are_words_test() {
  assert sql_text.tokens("SELECT \"order\", [key] FROM t WHERE a <> 'x'")
    == Ok([
      sql_text.Word("SELECT"),
      sql_text.Word("order"),
      sql_text.Symbol(","),
      sql_text.Word("key"),
      sql_text.Word("FROM"),
      sql_text.Word("t"),
      sql_text.Word("WHERE"),
      sql_text.Word("a"),
      sql_text.Symbol("<>"),
      sql_text.Text,
    ])
}
