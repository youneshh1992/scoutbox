//// Keyset paging over any order (repositories/players.ts `keysetRows`): the cursor is the last row's keys, and
//// the next page is the rows beyond it — `(k0 beyond a0) OR (k0 = a0 AND k1 beyond a1) OR …`, where "beyond" is
//// `<` for a descending key and `>` for an ascending one. The last key must be unique.

import gleam/dynamic/decode
import gleam/int
import gleam/list
import gleam/option.{None, Some}
import gleam/string
import scoutbox/platform/paging.{
  type Key, type KeyKind, type Page, IntKey, IntKind, TextKey, TextKind,
}
import scoutbox/platform/sql.{type Fragment}
import sqlight

pub type Direction {
  Asc
  Desc
}

pub type OrderKey {
  OrderKey(expr: Fragment, direction: Direction, kind: KeyKind)
}

/// The cursor's shape for this order.
pub fn kinds(order: List(OrderKey)) -> List(KeyKind) {
  list.map(order, fn(k) { k.kind })
}

fn value(key: Key) -> sqlight.Value {
  case key {
    IntKey(n) -> sqlight.int(n)
    TextKey(s) -> sqlight.text(s)
  }
}

fn name(i: Int) -> String {
  "k" <> int.to_string(i)
}

/// `SELECT * FROM (SELECT <columns>, <keys> FROM <from>) [beyond the cursor] ORDER BY <keys> LIMIT <limit + 1>`.
/// `columns` and `from` are the caller's; the keys follow the columns, so `keys_decoder(width)` reads them.
pub fn query(
  columns: String,
  from: Fragment,
  order: List(OrderKey),
  page: Page,
) -> Fragment {
  let indexed = list.index_map(order, fn(k, i) { #(k, i) })
  let keys =
    indexed
    |> list.map(fn(p) {
      sql.concat([{ p.0 }.expr, sql.text(" AS " <> name(p.1))])
    })
    |> sql.join(", ")
  let beyond = case page.after {
    None -> sql.text("")
    Some(after) -> {
      let pairs = list.zip(indexed, after)
      let past = fn(p: #(#(OrderKey, Int), Key)) {
        let #(#(k, i), a) = p
        let op = case k.direction {
          Desc -> " < "
          Asc -> " > "
        }
        sql.concat([sql.text(name(i) <> op), sql.arg(value(a))])
      }
      let clauses =
        list.index_map(pairs, fn(p, i) {
          let equal_before =
            list.take(pairs, i)
            |> list.map(fn(q) {
              sql.concat([
                sql.text(name(q.0.1) <> " = "),
                sql.arg(value(q.1)),
              ])
            })
          sql.concat([
            sql.text("("),
            sql.join(list.append(equal_before, [past(p)]), " AND "),
            sql.text(")"),
          ])
        })
      sql.concat([sql.text(" WHERE "), sql.join(clauses, " OR ")])
    }
  }
  let ordering =
    indexed
    |> list.map(fn(p) {
      name(p.1)
      <> case { p.0 }.direction {
        Desc -> " DESC"
        Asc -> " ASC"
      }
    })
  sql.concat([
    sql.text("SELECT * FROM (SELECT " <> columns <> ", "),
    keys,
    sql.text(" FROM "),
    from,
    sql.text(")"),
    beyond,
    sql.text(" ORDER BY " <> string.join(ordering, ", ") <> " LIMIT "),
    sql.arg(sqlight.int(page.limit + 1)),
  ])
}

/// The keys `query` selected, which start at column `first`.
pub fn keys_decoder(
  first: Int,
  order: List(OrderKey),
) -> decode.Decoder(List(Key)) {
  list.index_map(order, fn(k, i) { #(k, i) })
  |> list.fold(decode.success([]), fn(acc, p) {
    use keys <- decode.then(acc)
    use key <- decode.field(first + p.1, case { p.0 }.kind {
      IntKind -> decode.int |> decode.map(IntKey)
      TextKind -> decode.string |> decode.map(TextKey)
    })
    decode.success(list.append(keys, [key]))
  })
}
