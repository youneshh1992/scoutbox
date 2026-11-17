//// For the SQL check: each `?` tied to the column it binds, and its argument compared with that column's
//// generated type, so a `player` id bound to a `case_id`, or text bound to an INTEGER column, fails before it runs.
////
//// A `?` is tied to a column only in these shapes, and skipped in every other:
////
//// - `col = ?` and the other comparisons, `col IS ?` and `col IS NOT ?`, with `col` bare or `alias.col`,
////   standing alone on both sides (not `x + col = ?`, nor `col = ? || 'x'`);
//// - `col IN (?, ?, …)`;
//// - `SET col = ?` (a comparison's shape, in a SET clause, where it writes);
//// - `INSERT INTO t (a, b) VALUES (?, ?)`, each value a lone `?`.
////
//// A bare column is tied only when exactly one of the statement's tables has it and every table the statement
//// names is one this check knows (not a CTE). Column types come from the generated row modules' `Row` types, so a
//// table without a row module is never tied to.

import glance
import gleam/dict.{type Dict}
import gleam/int
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/sql_source.{
  type Arg, BoolArg, EnumArg, FloatArg, IdArg, IntArg, NullArg, NullableArg,
  TextArg, UnknownArg,
}
import scoutbox/sql_text.{type Token, Param, Symbol, Word}

pub type Kind {
  /// Ids of the `rows/id` name `name`.
  IdKind(name: String)
  /// A vocabulary: type `type_name` of `module`.
  EnumKind(module: String, type_name: String)
  TextKind
  IntKind
  FloatKind
  BoolKind
}

pub type Column {
  Column(kind: Kind, nullable: Bool)
}

/// Each table's columns, from its row module.
pub type Schema =
  Dict(String, Dict(String, Column))

/// What a statement's bindings came to.
pub type Outcome {
  /// `tied`: how many of its `?`s were tied to a column. `untyped`: those bound as plain text to an id or a
  /// vocabulary, whose value nothing checks. `wrong`: those whose argument the column can't hold.
  Outcome(tied: Int, untyped: List(String), wrong: List(String))
}

const id_module = "scoutbox/rows/id"

/// The schema the generated row modules describe.
pub fn schema(modules: Dict(String, glance.Module)) -> Schema {
  let ids = id_names(modules)
  modules
  |> dict.to_list
  |> list.filter_map(fn(m) {
    let #(path, module) = m
    case path {
      "scoutbox/rows/" <> _ if path != id_module -> table(path, module, ids)
      _ -> Error(Nil)
    }
  })
  |> dict.from_list
}

/// The `rows/id` name of each id type: `PlayerId` → `player`, from `player_sql(id: PlayerId)`.
fn id_names(modules: Dict(String, glance.Module)) -> Dict(String, String) {
  case dict.get(modules, id_module) {
    Ok(module) ->
      list.filter_map(module.functions, fn(d) {
        let f = d.definition
        case string.ends_with(f.name, "_sql"), f.parameters {
          True,
            [
              glance.FunctionParameter(
                type_: Some(glance.NamedType(name:, ..)),
                ..,
              ),
            ]
          -> Ok(#(name, string.drop_end(f.name, 4)))
          _, _ -> Error(Nil)
        }
      })
      |> dict.from_list
    Error(Nil) -> dict.new()
  }
}

fn table(
  path: String,
  module: glance.Module,
  ids: Dict(String, String),
) -> Result(#(String, Dict(String, Column)), Nil) {
  use name <- result.try(
    list.find_map(module.constants, fn(c) {
      case c.definition {
        glance.Constant(name: "table", value: glance.String(_, table), ..) ->
          Ok(table)
        _ -> Error(Nil)
      }
    }),
  )
  use fields <- result.try(
    list.find_map(module.custom_types, fn(t) {
      case t.definition {
        glance.CustomType(name: "Row", variants: [variant], ..) ->
          Ok(variant.fields)
        _ -> Error(Nil)
      }
    }),
  )
  let columns =
    list.filter_map(fields, fn(f) {
      case f {
        glance.LabelledVariantField(item:, label:) ->
          column(path, module, ids, item, False)
          |> result.map(fn(c) { #(label, c) })
        glance.UnlabelledVariantField(_) -> Error(Nil)
      }
    })
  Ok(#(name, dict.from_list(columns)))
}

fn column(
  path: String,
  module: glance.Module,
  ids: Dict(String, String),
  t: glance.Type,
  nullable: Bool,
) -> Result(Column, Nil) {
  case t {
    glance.NamedType(name: "Option", parameters: [inner], ..) ->
      column(path, module, ids, inner, True)
    glance.NamedType(name: "Int", module: None, ..) ->
      Ok(Column(IntKind, nullable))
    glance.NamedType(name: "Float", module: None, ..) ->
      Ok(Column(FloatKind, nullable))
    glance.NamedType(name: "String", module: None, ..) ->
      Ok(Column(TextKind, nullable))
    glance.NamedType(name: "Bool", module: None, ..) ->
      Ok(Column(BoolKind, nullable))
    glance.NamedType(name:, module: None, parameters: [], ..) ->
      Ok(Column(EnumKind(path, name), nullable))
    glance.NamedType(name:, module: Some(alias), parameters: [], ..) ->
      case sql_source.imported_module(module, alias) {
        Ok(m) if m == id_module ->
          dict.get(ids, name)
          |> result.map(fn(n) { Column(IdKind(n), nullable) })
        Ok("scoutbox/vocab/" <> _ as m) ->
          Ok(Column(EnumKind(m, name), nullable))
        _ -> Error(Nil)
      }
    _ -> Error(Nil)
  }
}

// --- Tying placeholders to columns -------------------------------------------------------------------------------

/// A token, and for a `?` its index among the statement's placeholders (else -1).
type Indexed =
  #(Token, Int)

type ColumnRef {
  Qualified(alias: String, column: String)
  Bare(column: String)
}

/// Where a `?` binds: the column, the operator that ties it (`=`, `IS`, `IN`, `VALUES`), and whether it writes.
type Tie {
  Tie(column: ColumnRef, table: Option(String), op: String, write: Bool)
}

const comparisons = ["=", "==", "!=", "<>", "<", "<=", ">", ">="]

/// Words a table's alias can't be: what may follow a table name in FROM, JOIN, UPDATE or INTO.
const not_aliases = [
  "WHERE", "SET", "ON", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "CROSS",
  "FULL", "NATURAL", "GROUP", "ORDER", "LIMIT", "OFFSET", "VALUES", "SELECT",
  "USING", "AS", "DEFAULT", "RETURNING", "UNION", "EXCEPT", "INTERSECT",
  "WINDOW", "HAVING", "INDEXED", "NOT", "DO", "WHEN", "THEN", "ELSE", "END",
  "AND", "OR",
]

/// What may stand just before a column for it to stand alone.
const boundaries = ["WHERE", "AND", "OR", "ON", "SET", "WHEN", "NOT", "HAVING"]

/// Operators that would make a `?` part of a larger expression when they follow it.
const operators = ["+", "-", "*", "/", "%", "||", "&", "|", "<<", ">>", "."]

/// The clause keywords that say whether a `=` writes (SET) or compares.
const clauses = [
  "SET", "WHERE", "ON", "VALUES", "SELECT", "FROM", "HAVING", "RETURNING",
  "JOIN",
]

/// The columns of the table-valued functions statements use: they may hold a bare column's name.
const json_columns = [
  "key", "value", "type", "atom", "id", "parent", "fullkey", "path",
]

/// The ties of `sql`'s placeholders to columns, and what binding `args` to them comes to. `args` must have one
/// argument per placeholder.
pub fn check(schema: Schema, sql: String, args: List(Arg)) -> Outcome {
  case sql_text.tokens(sql) {
    Error(Nil) -> Outcome(0, [], [])
    Ok(tokens) -> {
      let indexed = index(tokens)
      let tables = tables(tokens)
      let inserts = insert_ties(indexed)
      ties(indexed, [], inserts, [])
      |> list.fold(Outcome(0, [], []), fn(outcome, t) {
        let #(n, tie) = t
        case column_of(schema, tables, tie), list.drop(args, n) {
          Ok(#(table, name, column)), [arg, ..] -> {
            let place = table <> "." <> name
            let at = "argument " <> int.to_string(n + 1)
            case compare(arg, column, tie) {
              Fine -> Outcome(..outcome, tied: outcome.tied + 1)
              Untyped(what) ->
                Outcome(..outcome, tied: outcome.tied + 1, untyped: [
                  at <> " binds " <> what <> " to " <> place,
                  ..outcome.untyped
                ])
              Wrong(what) ->
                Outcome(..outcome, tied: outcome.tied + 1, wrong: [
                  at <> " " <> string.replace(what, "COLUMN", place),
                  ..outcome.wrong
                ])
            }
          }
          _, _ -> outcome
        }
      })
      |> fn(o) {
        Outcome(
          ..o,
          untyped: list.reverse(o.untyped),
          wrong: list.reverse(o.wrong),
        )
      }
    }
  }
}

fn index(tokens: List(Token)) -> List(Indexed) {
  list.map_fold(tokens, 0, fn(n, t) {
    case t {
      Param -> #(n + 1, #(t, n))
      _ -> #(n, #(t, -1))
    }
  }).1
}

/// Each placeholder's tie, by walking the tokens with those before the current one reversed (nearest first).
fn ties(
  tokens: List(Indexed),
  before: List(Indexed),
  inserts: Dict(Int, Tie),
  acc: List(#(Int, Tie)),
) -> List(#(Int, Tie)) {
  case tokens {
    [] -> list.reverse(acc)
    [#(Param, n) as t, ..after] -> {
      let tie = case dict.get(inserts, n) {
        Ok(tie) -> Ok(tie)
        Error(Nil) ->
          tie(list.map(before, fn(i) { i.0 }), list.map(after, fn(i) { i.0 }))
      }
      let acc = case tie {
        Ok(tie) -> [#(n, tie), ..acc]
        Error(Nil) -> acc
      }
      ties(after, [t, ..before], inserts, acc)
    }
    [t, ..after] -> ties(after, [t, ..before], inserts, acc)
  }
}

/// A placeholder's tie from the tokens before it (nearest first) and after it.
fn tie(before: List(Token), after: List(Token)) -> Result(Tie, Nil) {
  use <- guard(!stands_alone_after(after))
  let write = clause(before) == "SET"
  case before {
    [Symbol(op), ..rest] ->
      case list.contains(comparisons, op) {
        True ->
          column_ref(rest)
          |> result.map(fn(c) { Tie(c, None, op, write && op == "=") })
        False ->
          case op {
            "," | "(" -> in_list(before, after)
            _ -> Error(Nil)
          }
      }
    [Word(w), ..rest] ->
      case string.uppercase(w), rest {
        "IS", _ ->
          column_ref(rest) |> result.map(fn(c) { Tie(c, None, "IS", False) })
        "NOT", [Word(is), ..rest] ->
          case string.uppercase(is) {
            "IS" ->
              column_ref(rest)
              |> result.map(fn(c) { Tie(c, None, "IS NOT", False) })
            _ -> Error(Nil)
          }
        _, _ -> Error(Nil)
      }
    _ -> Error(Nil)
  }
}

/// `col IN (?, ?, …)`: the `?`s and commas back to `(`, then `IN` (or `NOT IN`) and the column.
fn in_list(before: List(Token), after: List(Token)) -> Result(Tie, Nil) {
  let rest = list.drop_while(before, fn(t) { t == Param || t == Symbol(",") })
  let closes = list.drop_while(after, fn(t) { t == Param || t == Symbol(",") })
  case rest, closes {
    [Symbol("("), Word(w), ..rest], [Symbol(")"), ..] ->
      case string.uppercase(w), rest {
        "IN", [Word(not), ..more] ->
          case string.uppercase(not) {
            "NOT" -> column_ref(more)
            _ -> column_ref(rest)
          }
          |> result.map(fn(c) { Tie(c, None, "IN", False) })
        "IN", _ ->
          column_ref(rest) |> result.map(fn(c) { Tie(c, None, "IN", False) })
        _, _ -> Error(Nil)
      }
    _, _ -> Error(Nil)
  }
}

/// The column the tokens before an operator (nearest first) end with, when it stands alone.
fn column_ref(before: List(Token)) -> Result(ColumnRef, Nil) {
  case before {
    [Word(c), Symbol("."), Word(q), ..rest] ->
      case stands_alone_before(rest) {
        True -> Ok(Qualified(string.lowercase(q), string.lowercase(c)))
        False -> Error(Nil)
      }
    [Word(c), ..rest] ->
      case is_keyword(c), stands_alone_before(rest) {
        False, True -> Ok(Bare(string.lowercase(c)))
        _, _ -> Error(Nil)
      }
    _ -> Error(Nil)
  }
}

fn stands_alone_before(before: List(Token)) -> Bool {
  case before {
    [] | [Symbol("("), ..] | [Symbol(","), ..] -> True
    [Word(w), ..] -> list.contains(boundaries, string.uppercase(w))
    _ -> False
  }
}

fn stands_alone_after(after: List(Token)) -> Bool {
  case after {
    [Symbol(s), ..] -> !list.contains(operators, s)
    [Word(w), ..] -> string.uppercase(w) != "COLLATE"
    _ -> True
  }
}

/// The nearest clause keyword before a placeholder.
fn clause(before: List(Token)) -> String {
  list.find_map(before, fn(t) {
    case t {
      Word(w) ->
        case list.contains(clauses, string.uppercase(w)) {
          True -> Ok(string.uppercase(w))
          False -> Error(Nil)
        }
      _ -> Error(Nil)
    }
  })
  |> result.unwrap("")
}

fn is_keyword(word: String) -> Bool {
  let w = string.uppercase(word)
  list.contains(not_aliases, w)
  || list.contains(["IS", "IN", "LIKE", "BETWEEN", "NULL", "CASE", "EXISTS"], w)
}

/// `INSERT INTO t (a, b, …) VALUES (?, ?, …), …`: each lone `?` in a row of values, by its index, tied to its
/// column.
fn insert_ties(tokens: List(Indexed)) -> Dict(Int, Tie) {
  case tokens {
    [] -> dict.new()
    [#(Word(into), _), #(Word(table), _), #(Symbol("("), _), ..rest] ->
      case string.uppercase(into) {
        "INTO" ->
          case names(rest, []) {
            Ok(#(columns, [#(Word(values), _), ..rows])) ->
              case string.uppercase(values) {
                "VALUES" ->
                  value_rows(rows, string.lowercase(table), columns, dict.new())
                _ -> dict.new()
              }
            _ -> dict.new()
          }
        _ -> insert_ties(list.drop(tokens, 1))
      }
    [_, ..rest] -> insert_ties(rest)
  }
}

/// The names in `a, b, c)`, and what follows the `)`.
fn names(
  tokens: List(Indexed),
  acc: List(String),
) -> Result(#(List(String), List(Indexed)), Nil) {
  case tokens {
    [#(Word(name), _), #(Symbol(","), _), ..rest] ->
      names(rest, [string.lowercase(name), ..acc])
    [#(Word(name), _), #(Symbol(")"), _), ..rest] ->
      Ok(#(list.reverse([string.lowercase(name), ..acc]), rest))
    _ -> Error(Nil)
  }
}

fn value_rows(
  tokens: List(Indexed),
  table: String,
  columns: List(String),
  acc: Dict(Int, Tie),
) -> Dict(Int, Tie) {
  case tokens {
    [#(Symbol("("), _), ..rest] -> {
      let #(items, rest) = row_items(rest, 0, [], [])
      let acc = case list.length(items) == list.length(columns) {
        True ->
          list.zip(items, columns)
          |> list.fold(acc, fn(acc, pair) {
            case pair {
              #([#(Param, n)], column) ->
                dict.insert(
                  acc,
                  n,
                  Tie(Bare(column), Some(table), "VALUES", True),
                )
              _ -> acc
            }
          })
        False -> acc
      }
      case rest {
        [#(Symbol(","), _), ..more] -> value_rows(more, table, columns, acc)
        _ -> acc
      }
    }
    _ -> acc
  }
}

/// A row of values' items (each its tokens), up to its closing `)`, and what follows it.
fn row_items(
  tokens: List(Indexed),
  depth: Int,
  item: List(Indexed),
  items: List(List(Indexed)),
) -> #(List(List(Indexed)), List(Indexed)) {
  case tokens {
    [] -> #(list.reverse([list.reverse(item), ..items]), [])
    [#(Symbol(")"), _), ..rest] if depth == 0 -> #(
      list.reverse([list.reverse(item), ..items]),
      rest,
    )
    [#(Symbol(","), _), ..rest] if depth == 0 ->
      row_items(rest, depth, [], [list.reverse(item), ..items])
    [#(Symbol("("), _) as t, ..rest] ->
      row_items(rest, depth + 1, [t, ..item], items)
    [#(Symbol(")"), _) as t, ..rest] ->
      row_items(rest, depth - 1, [t, ..item], items)
    [t, ..rest] -> row_items(rest, depth, [t, ..item], items)
  }
}

// --- Tables ------------------------------------------------------------------------------------------------------

/// The tables a statement names (in FROM, JOIN, UPDATE and INTO), with their aliases: `#(name or alias, table)`.
fn tables(tokens: List(Token)) -> List(#(String, String)) {
  case tokens {
    [] -> []
    [Word(w), ..rest] ->
      case
        list.contains(["FROM", "JOIN", "UPDATE", "INTO"], string.uppercase(w))
      {
        True -> {
          let #(named, rest) = table_list(rest, [])
          list.append(named, tables(rest))
        }
        False -> tables(rest)
      }
    [_, ..rest] -> tables(rest)
  }
}

/// `t [AS] [alias] [, t2 …]`.
fn table_list(
  tokens: List(Token),
  acc: List(#(String, String)),
) -> #(List(#(String, String)), List(Token)) {
  case tokens {
    [Word(t), ..rest] ->
      case is_keyword(t) {
        True -> #(acc, tokens)
        False -> {
          let table = string.lowercase(t)
          let acc = [#(table, table), ..acc]
          let rest = case rest {
            [Word(as_), ..more] ->
              case string.uppercase(as_) {
                "AS" -> more
                _ -> rest
              }
            _ -> rest
          }
          let #(acc, rest) = case rest {
            [Word(a), ..more] ->
              case is_keyword(a) {
                True -> #(acc, rest)
                False -> #([#(string.lowercase(a), table), ..acc], more)
              }
            _ -> #(acc, rest)
          }
          case rest {
            [Symbol(","), ..more] -> table_list(more, acc)
            _ -> #(acc, rest)
          }
        }
      }
    _ -> #(acc, tokens)
  }
}

/// The table, column and type a tie names, when exactly one is meant.
fn column_of(
  schema: Schema,
  tables: List(#(String, String)),
  tie: Tie,
) -> Result(#(String, String, Column), Nil) {
  case tie.table, tie.column {
    Some(table), Bare(name) -> lookup(schema, table, name)
    _, Qualified(alias, name) -> {
      use table <- result.try(list.key_find(tables, alias))
      lookup(schema, table, name)
    }
    None, Bare(name) -> {
      let named = list.unique(list.map(tables, fn(t) { t.1 }))
      let unknown =
        list.any(named, fn(t) {
          !dict.has_key(schema, t)
          && !list.contains(["json_each", "json_tree"], t)
        })
      let json =
        list.any(named, fn(t) { t == "json_each" || t == "json_tree" })
        && list.contains(json_columns, name)
      let having =
        list.filter(named, fn(t) {
          case dict.get(schema, t) {
            Ok(columns) -> dict.has_key(columns, name)
            Error(Nil) -> False
          }
        })
      case unknown, json, having {
        False, False, [table] -> lookup(schema, table, name)
        _, _, _ -> Error(Nil)
      }
    }
  }
}

fn lookup(
  schema: Schema,
  table: String,
  name: String,
) -> Result(#(String, String, Column), Nil) {
  use columns <- result.try(dict.get(schema, table))
  use column <- result.try(dict.get(columns, name))
  Ok(#(table, name, column))
}

// --- Comparing ---------------------------------------------------------------------------------------------------

type Comparison {
  Fine
  /// Bound as plain text where the column holds an id or a vocabulary value: what was bound.
  Untyped(String)
  /// What's wrong, with `COLUMN` where the column's name goes.
  Wrong(String)
}

fn compare(arg: Arg, column: Column, tie: Tie) -> Comparison {
  case arg {
    UnknownArg -> Fine
    NullArg ->
      case
        tie.write,
        column.nullable,
        list.contains(["IN", ..comparisons], tie.op)
      {
        True, False, _ -> Wrong("binds NULL to COLUMN, which is NOT NULL")
        False, _, True ->
          Wrong(
            "compares COLUMN with NULL using "
            <> tie.op
            <> ", which is never true",
          )
        _, _, _ -> Fine
      }
    NullableArg(inner) ->
      case tie.write, column.nullable {
        True, False -> Wrong("can bind NULL to COLUMN, which is NOT NULL")
        _, _ -> compare(inner, column, tie)
      }
    _ -> compare_kind(arg, column.kind)
  }
}

fn compare_kind(arg: Arg, kind: Kind) -> Comparison {
  let wrong =
    Wrong(
      "binds " <> describe(arg) <> " to COLUMN, which holds " <> holds(kind),
    )
  case kind, arg {
    IdKind(want), IdArg(got) if want == got -> Fine
    IdKind(_), TextArg -> Untyped("text")
    EnumKind(m, t), EnumArg(m2, t2) if m == m2 && t == t2 -> Fine
    EnumKind(_, _), TextArg -> Untyped("text")
    TextKind, TextArg | TextKind, IdArg(_) | TextKind, EnumArg(..) -> Fine
    IntKind, IntArg -> Fine
    FloatKind, FloatArg | FloatKind, IntArg -> Fine
    BoolKind, BoolArg -> Fine
    _, _ -> wrong
  }
}

fn describe(arg: Arg) -> String {
  case arg {
    IdArg(name) -> article(name) <> " " <> name <> " id"
    EnumArg(module, type_name) ->
      article(type_name) <> " " <> type_name <> " (" <> module <> ")"
    TextArg -> "text"
    IntArg -> "an Int"
    FloatArg -> "a Float"
    BoolArg -> "a Bool"
    NullArg -> "NULL"
    NullableArg(inner) -> describe(inner)
    UnknownArg -> "a value"
  }
}

fn holds(kind: Kind) -> String {
  case kind {
    IdKind(name) -> name <> " ids"
    EnumKind(module, type_name) -> type_name <> " values (" <> module <> ")"
    TextKind -> "text"
    IntKind -> "integers"
    FloatKind -> "reals"
    BoolKind -> "Bools"
  }
}

fn guard(stop: Bool, continue: fn() -> Result(a, Nil)) -> Result(a, Nil) {
  case stop {
    True -> Error(Nil)
    False -> continue()
  }
}

fn article(word: String) -> String {
  case string.contains("aeiouAEIOU", string.slice(word, 0, 1)) {
    True -> "an"
    False -> "a"
  }
}
