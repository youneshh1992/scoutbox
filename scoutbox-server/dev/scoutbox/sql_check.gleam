//// `gleam dev sql-check` (`npm run sql:check`): every query whose SQL the source spells out, prepared against the
//// migrated schema, and its arguments checked against the columns they bind, so a misspelt column, a dropped
//// table or an id bound to the wrong column fails here rather than in whichever request reaches it.
////
//// - `sql_source` reads the queries from the source: their SQL, and their arguments when the source writes them
////   out. A query it can't read is counted as unresolved, never failed.
//// - Each statement is prepared with `EXPLAIN`. When its arguments are known, the number of `?` placeholders must
////   be their count: SQLite binds NULL for a missing argument without complaint.
//// - `sql_bindings` ties each `?` it can to a column and compares its argument with the column's generated type.
////   Plain text bound to an id or a vocabulary column is reported as untyped, not failed.
////
//// Temporary tables a module makes with a literal `store.exec(tx, "CREATE TEMP …")` are made first.

import gleam/dynamic/decode
import gleam/int
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/result
import gleam/set
import gleam/string
import scoutbox/sql_bindings
import scoutbox/sql_source.{type Arg, type Site, Site}
import scoutbox/sql_text
import sqlight

pub type Problem {
  Problem(site: Site, sql: String, message: String)
}

pub type Report {
  /// `checked`: how many statements were prepared (a helper's query once for each distinct SQL its calls make).
  /// `arguments`: how many arguments those statements bind that the source writes out. `tied`: how many of them
  /// were tied to a column and compared with it.
  /// `untyped`: each argument bound as plain text to an id or vocabulary column.
  /// `unresolved`: each query no call resolves, with the first piece of its SQL the source doesn't spell out.
  Report(
    checked: Int,
    arguments: Int,
    tied: Int,
    problems: List(Problem),
    untyped: List(#(Site, String)),
    unresolved: List(#(Site, String)),
  )
}

/// The queries of `sources` (each `#(path, source)`, the path as `src/scoutbox/…`), checked against `schema`.
/// Fails with the path of a source glance can't parse.
pub fn check(
  sources: List(#(String, String)),
  schema: String,
) -> Result(Report, String) {
  use source <- result.try(sql_source.read(sources))
  let columns = sql_bindings.schema(source.modules)
  use conn <- sqlight.with_connection(":memory:")
  let assert Ok(_) = sqlight.exec(schema, conn)
  list.each(source.setups, fn(sql) {
    let assert Ok(_) = sqlight.exec(sql, conn)
    Nil
  })
  // One statement per query and SQL text: a helper called several times with the same text is checked once.
  let resolved =
    list.filter_map(source.queries, fn(q) {
      case q.sql {
        Ok(sql) -> Ok(#(q.site, sql, q.args))
        Error(_) -> Error(Nil)
      }
    })
    |> unique_by(fn(q) { #(q.0.file, q.0.line, q.1, q.2) })
    |> list.sort(fn(a, b) { compare_sites(a.0, b.0) })
  let resolved_at =
    set.from_list(list.map(resolved, fn(q) { #(q.0.file, q.0.line) }))
  let unresolved =
    list.filter_map(source.queries, fn(q) {
      case q.sql, set.contains(resolved_at, #(q.site.file, q.site.line)) {
        Error(piece), False -> Ok(#(Site(..q.site, via: None), piece))
        _, _ -> Error(Nil)
      }
    })
    |> unique_by(fn(u) { #(u.0.file, u.0.line) })
  let results =
    list.map(resolved, fn(q) {
      let #(site, sql, args) = q
      statement(conn, columns, site, sql, args)
    })
  Ok(Report(
    checked: list.length(resolved),
    arguments: int.sum(list.map(results, fn(r) { r.3 })),
    tied: int.sum(list.map(results, fn(r) { r.0 })),
    problems: list.flat_map(results, fn(r) { r.1 }),
    untyped: list.flat_map(results, fn(r) { r.2 }),
    unresolved:,
  ))
}

/// One statement: how many `?`s were tied, its problems, its untyped arguments, and how many arguments it binds
/// that the source writes out.
fn statement(
  conn: sqlight.Connection,
  columns: sql_bindings.Schema,
  site: Site,
  sql: String,
  args: Option(List(Arg)),
) -> #(Int, List(Problem), List(#(Site, String)), Int) {
  case sqlight.query("EXPLAIN " <> sql, conn, [], decode.success(Nil)) {
    Error(e) -> #(0, [Problem(site, sql, e.message)], [], 0)
    Ok(_) ->
      case args, sql_text.placeholders(sql) {
        Some(args), Ok(p) ->
          case list.length(args) {
            n if n != p -> #(
              0,
              [
                Problem(
                  site,
                  sql,
                  int.to_string(p)
                    <> " placeholders, "
                    <> int.to_string(n)
                    <> " arguments",
                ),
              ],
              [],
              0,
            )
            n -> {
              let outcome = sql_bindings.check(columns, sql, args)
              #(
                outcome.tied,
                list.map(outcome.wrong, Problem(site, sql, _)),
                list.map(outcome.untyped, fn(u) { #(site, u) }),
                n,
              )
            }
          }
        _, _ -> #(0, [], [], 0)
      }
  }
}

/// Source order: by file, then line, then the line of the call that made the SQL.
fn compare_sites(a: Site, b: Site) -> order.Order {
  use <- order.lazy_break_tie(string.compare(a.file, b.file))
  use <- order.lazy_break_tie(int.compare(a.line, b.line))
  int.compare(option.unwrap(a.via, 0), option.unwrap(b.via, 0))
}

/// `items` without the later ones whose `key` an earlier one has, in order.
fn unique_by(items: List(a), key: fn(a) -> k) -> List(a) {
  list.fold(items, #(set.new(), []), fn(state, item) {
    let #(seen, kept) = state
    let k = key(item)
    case set.contains(seen, k) {
      True -> state
      False -> #(set.insert(seen, k), [item, ..kept])
    }
  }).1
  |> list.reverse
}
