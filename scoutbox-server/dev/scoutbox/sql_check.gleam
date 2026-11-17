//// `gleam dev sql-check` (`npm run sql:check`): every query whose SQL the source spells out, prepared against the
//// migrated schema, so a misspelt column or a dropped table fails here rather than in whichever request reaches it.
////
//// A call to `store.query`, `one`, `write` or `run` is checked when its SQL resolves to text from what the source
//// says: string literals joined with `<>`, constants (the module's own, or imported), a row module's `columns`,
//// `table` and `qualified("alias")`, and local `let`s of those. A call to a function of the same module is
//// followed with its parameters bound to what the call passes, up to three calls deep: the queries in its body
//// are checked for that call, and a call used as the SQL (`select("WHERE …")`) is evaluated. Names bound by `use`,
//// `case` or a destructuring `let` are not followed. A query no call resolves is counted as unresolved, never
//// failed.
////
//// Each resolved statement is prepared with `EXPLAIN`. When its arguments are a list the source writes out (here,
//// or at the call that bound them), the number of `?` placeholders must be its length: SQLite binds NULL for a
//// missing argument without complaint. Temporary tables a module makes with a literal
//// `store.exec(tx, "CREATE TEMP …")` are made first.

import glance
import gleam/bit_array
import gleam/dict.{type Dict}
import gleam/dynamic/decode
import gleam/int
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/set
import gleam/string
import sqlight

/// Where a query is. `via` is the line of the call, in the same file, whose arguments made its SQL.
pub type Site {
  Site(file: String, line: Int, via: Option(Int))
}

pub type Problem {
  Problem(site: Site, sql: String, message: String)
}

pub type Report {
  /// `checked`: how many statements were prepared (a helper's query once for each distinct SQL its calls make).
  /// `unresolved`: each query no call resolves, with the first piece of its SQL this check doesn't follow.
  Report(
    checked: Int,
    problems: List(Problem),
    unresolved: List(#(Site, String)),
  )
}

/// The queries of `sources` (each `#(path, source)`, the path as `src/scoutbox/…`), prepared against `schema`.
/// Fails with the path of a source glance can't parse.
pub fn check(
  sources: List(#(String, String)),
  schema: String,
) -> Result(Report, String) {
  use modules <- result.try(
    list.try_map(sources, fn(s) {
      let #(file, source) = s
      case glance.module(source) {
        Ok(ast) -> Ok(#(module_path(file), Parsed(file, source, ast)))
        Error(_) -> Error(file)
      }
    }),
  )
  let modules = dict.from_list(modules)
  let found =
    dict.values(modules)
    |> list.sort(fn(a, b) { string.compare(a.file, b.file) })
    |> list.flat_map(fn(m) { calls(Context(modules, m, 0, None)) })
  use conn <- sqlight.with_connection(":memory:")
  let assert Ok(_) = sqlight.exec(schema, conn)
  list.each(found, fn(f) {
    case f {
      Setup(sql) -> {
        let assert Ok(_) = sqlight.exec(sql, conn)
        Nil
      }
      Query(..) -> Nil
    }
  })
  let queries =
    list.filter_map(found, fn(f) {
      case f {
        Query(site, sql, args) -> Ok(#(site, sql, args))
        Setup(_) -> Error(Nil)
      }
    })
  // One statement per query and SQL text: a helper called several times with the same text is prepared once.
  let resolved =
    list.filter_map(queries, fn(q) {
      case q {
        #(site, Ok(sql), args) -> Ok(#(site, sql, args))
        #(_, Error(_), _) -> Error(Nil)
      }
    })
    |> unique_by(fn(q) { #(q.0.file, q.0.line, q.1, q.2) })
  let resolved_at =
    set.from_list(list.map(resolved, fn(q) { #(q.0.file, q.0.line) }))
  let unresolved =
    list.filter_map(queries, fn(q) {
      case q {
        #(site, Error(piece), _) ->
          case set.contains(resolved_at, #(site.file, site.line)) {
            True -> Error(Nil)
            False -> Ok(#(Site(..site, via: None), piece))
          }
        #(_, Ok(_), _) -> Error(Nil)
      }
    })
    |> unique_by(fn(u) { #(u.0.file, u.0.line) })
  Ok(Report(
    checked: list.length(resolved),
    problems: list.flat_map(resolved, fn(q) { problems(conn, q.0, q.1, q.2) }),
    unresolved:,
  ))
}

fn problems(
  conn: sqlight.Connection,
  site: Site,
  sql: String,
  args: Option(Int),
) -> List(Problem) {
  case sqlight.query("EXPLAIN " <> sql, conn, [], decode.success(Nil)) {
    Error(e) -> [Problem(site, sql, e.message)]
    Ok(_) ->
      case args, placeholders(sql) {
        Some(n), Ok(p) if n != p -> [
          Problem(
            site,
            sql,
            int.to_string(p)
              <> " placeholders, "
              <> int.to_string(n)
              <> " arguments",
          ),
        ]
        _, _ -> []
      }
  }
}

// --- Finding the calls -------------------------------------------------------------------------------------------

type Parsed {
  Parsed(file: String, source: String, ast: glance.Module)
}

/// `depth`: how many same-module calls deep the walk is; `via`: the line of the outermost of them.
type Context {
  Context(
    modules: Dict(String, Parsed),
    module: Parsed,
    depth: Int,
    via: Option(Int),
  )
}

const max_depth = 3

type Found {
  /// A query: its SQL if the source spells it out (else the first piece it doesn't), and how many arguments it
  /// binds, when they are a list the source writes out.
  Query(site: Site, sql: Result(String, String), args: Option(Int))
  /// A temporary table the module makes.
  Setup(sql: String)
}

/// What a local name stands for.
type Binding {
  Text(String)
  /// A list of this many items.
  Items(Int)
  /// Something this check doesn't follow (a parameter no call has bound, say). It hides a constant of the same
  /// name.
  Opaque
}

type Env =
  Dict(String, Binding)

const store_module = "scoutbox/platform/store"

fn module_path(file: String) -> String {
  let path = case string.starts_with(file, "src/") {
    True -> string.drop_start(file, 4)
    False -> file
  }
  case string.ends_with(path, ".gleam") {
    True -> string.drop_end(path, 6)
    False -> path
  }
}

fn calls(ctx: Context) -> List(Found) {
  ctx.module.ast.functions
  |> list.flat_map(fn(d) {
    let f = d.definition
    let env =
      list.fold(f.parameters, dict.new(), fn(env, p) {
        case p.name {
          glance.Named(n) -> dict.insert(env, n, Opaque)
          glance.Discarded(_) -> env
        }
      })
    walk_statements(ctx, env, f.body, []) |> list.reverse
  })
}

/// Walks `statements` in order, each `let` binding its name for the ones after it.
fn walk_statements(
  ctx: Context,
  env: Env,
  statements: List(glance.Statement),
  acc: List(Found),
) -> List(Found) {
  list.fold(statements, #(env, acc), fn(state, statement) {
    let #(env, acc) = state
    #(
      bind_statement(ctx, env, statement),
      walk_statement(ctx, env, statement, acc),
    )
  }).1
}

fn walk_statement(
  ctx: Context,
  env: Env,
  statement: glance.Statement,
  acc: List(Found),
) -> List(Found) {
  case statement {
    glance.Assignment(value:, ..) -> walk(ctx, env, value, acc)
    glance.Use(function:, ..) -> walk(ctx, env, function, acc)
    glance.Assert(expression:, ..) -> walk(ctx, env, expression, acc)
    glance.Expression(e) -> walk(ctx, env, e, acc)
  }
}

/// `env` for the statements after `statement`.
fn bind_statement(ctx: Context, env: Env, statement: glance.Statement) -> Env {
  case statement {
    glance.Assignment(pattern: glance.PatternVariable(_, name), value:, ..) ->
      dict.insert(env, name, binding(ctx, env, value))
    glance.Assignment(pattern:, ..) -> shadow(env, [pattern])
    glance.Use(patterns:, ..) ->
      shadow(env, list.map(patterns, fn(p) { p.pattern }))
    glance.Assert(..) | glance.Expression(_) -> env
  }
}

fn walk(
  ctx: Context,
  env: Env,
  e: glance.Expression,
  acc: List(Found),
) -> List(Found) {
  let e = unpipe(e)
  let acc = case store_call(ctx, env, e) {
    Some(found) -> [found, ..acc]
    None -> acc
  }
  let acc = follow_call(ctx, env, e, acc)
  let each = fn(acc, es) {
    list.fold(es, acc, fn(acc, e) { walk(ctx, env, e, acc) })
  }
  case e {
    glance.Block(_, statements) -> walk_statements(ctx, env, statements, acc)
    glance.Fn(_, arguments, _, body) -> {
      let env =
        list.fold(arguments, env, fn(env, a) {
          case a.name {
            glance.Named(n) -> dict.insert(env, n, Opaque)
            glance.Discarded(_) -> env
          }
        })
      walk_statements(ctx, env, body, acc)
    }
    glance.Call(_, function, arguments) ->
      each(acc, [function, ..field_items(arguments)])
    glance.FnCapture(_, _, function, before, after) ->
      each(acc, [function, ..field_items(list.append(before, after))])
    glance.Case(_, subjects, clauses) -> {
      let acc = each(acc, subjects)
      list.fold(clauses, acc, fn(acc, c) {
        let env = shadow(env, list.flatten(c.patterns))
        let acc = case c.guard {
          Some(g) -> walk(ctx, env, g, acc)
          None -> acc
        }
        walk(ctx, env, c.body, acc)
      })
    }
    glance.BinaryOperator(_, _, left, right) -> each(acc, [left, right])
    glance.NegateInt(_, value) | glance.NegateBool(_, value) ->
      walk(ctx, env, value, acc)
    glance.Tuple(_, elements) -> each(acc, elements)
    glance.List(_, elements, rest) ->
      each(acc, list.append(elements, optional(rest)))
    glance.RecordUpdate(_, _, _, record, fields) ->
      each(acc, [
        record,
        ..list.filter_map(fields, fn(f) { option.to_result(f.item, Nil) })
      ])
    glance.FieldAccess(_, container, _) -> walk(ctx, env, container, acc)
    glance.TupleIndex(_, tuple, _) -> walk(ctx, env, tuple, acc)
    glance.BitString(_, segments) ->
      each(acc, list.map(segments, fn(s) { s.0 }))
    glance.Panic(_, message) | glance.Todo(_, message) ->
      each(acc, optional(message))
    glance.Echo(_, expression, message) ->
      each(acc, list.append(optional(expression), optional(message)))
    glance.Int(..)
    | glance.Float(..)
    | glance.String(..)
    | glance.Variable(..) -> acc
  }
}

/// `x |> f(a)` as `f(x, a)`, and `x |> f` as `f(x)`.
fn unpipe(e: glance.Expression) -> glance.Expression {
  case e {
    glance.BinaryOperator(location, glance.Pipe, left, right) ->
      case right {
        glance.Call(_, function, arguments) ->
          glance.Call(location, function, [
            glance.UnlabelledField(left),
            ..arguments
          ])
        glance.Variable(..) | glance.FieldAccess(..) ->
          glance.Call(location, right, [glance.UnlabelledField(left)])
        _ -> e
      }
    _ -> e
  }
}

fn field_items(fields: List(glance.Field(t))) -> List(t) {
  list.filter_map(fields, fn(f) {
    case f {
      glance.LabelledField(item:, ..) | glance.UnlabelledField(item) -> Ok(item)
      glance.ShorthandField(..) -> Error(Nil)
    }
  })
}

/// `store.query/one/write/run(conn, sql, args, …)`, or a literal `store.exec(tx, "CREATE TEMP …")`.
fn store_call(ctx: Context, env: Env, e: glance.Expression) -> Option(Found) {
  case e {
    glance.Call(
      location:,
      function: glance.FieldAccess(_, glance.Variable(_, alias), name),
      arguments:,
    ) -> {
      let is_store =
        !dict.has_key(env, alias)
        && imported_module(ctx.module, alias) == Ok(store_module)
      case is_store, name, field_items(arguments) {
        True, "query", [_, sql, args, ..]
        | True, "one", [_, sql, args, ..]
        | True, "write", [_, sql, args, ..]
        | True, "run", [_, sql, args, ..]
        ->
          Some(Query(
            Site(
              ctx.module.file,
              line(ctx.module.source, location.start),
              ctx.via,
            ),
            resolve(ctx, env, sql),
            items(env, args),
          ))
        True, "exec", [_, sql] ->
          case resolve(ctx, env, sql) {
            Ok(text) ->
              case string.starts_with(string.uppercase(text), "CREATE TEMP") {
                True -> Some(Setup(text))
                False -> None
              }
            Error(_) -> None
          }
        _, _, _ -> None
      }
    }
    _ -> None
  }
}

/// A call to a function of this module that passes it something this check follows: the queries in its body,
/// walked with its parameters bound to what the call passes.
fn follow_call(
  ctx: Context,
  env: Env,
  e: glance.Expression,
  acc: List(Found),
) -> List(Found) {
  case e {
    glance.Call(location:, function: glance.Variable(_, name), arguments:) ->
      case bound_call(ctx, env, name, arguments) {
        Ok(#(f, bound)) -> {
          let via = case ctx.via {
            Some(_) -> ctx.via
            None -> Some(line(ctx.module.source, location.start))
          }
          walk_statements(
            Context(..ctx, depth: ctx.depth + 1, via:),
            bound,
            f.body,
            acc,
          )
        }
        Error(Nil) -> acc
      }
    _ -> acc
  }
}

/// The function of this module `name` calls, and its parameters bound to `arguments`, when the walk isn't too
/// deep and at least one of them is something this check follows.
fn bound_call(
  ctx: Context,
  env: Env,
  name: String,
  arguments: List(glance.Field(glance.Expression)),
) -> Result(#(glance.Function, Env), Nil) {
  use <- bool_guard(dict.has_key(env, name) || ctx.depth >= max_depth)
  use f <- result.try(
    list.find_map(ctx.module.ast.functions, fn(d) {
      case d.definition.name == name {
        True -> Ok(d.definition)
        False -> Error(Nil)
      }
    }),
  )
  let labelled =
    list.filter_map(arguments, fn(a) {
      case a {
        glance.LabelledField(label:, item:, ..) -> Ok(#(label, item))
        glance.ShorthandField(label:, location:) ->
          Ok(#(label, glance.Variable(location, label)))
        glance.UnlabelledField(_) -> Error(Nil)
      }
    })
    |> dict.from_list
  let unlabelled =
    list.filter_map(arguments, fn(a) {
      case a {
        glance.UnlabelledField(item) -> Ok(item)
        _ -> Error(Nil)
      }
    })
  // Labelled arguments go to their parameters; the rest fill the others in order.
  let #(bound, _) =
    list.fold(f.parameters, #(dict.new(), unlabelled), fn(state, p) {
      let #(bound, unlabelled) = state
      let given = case p.label {
        Some(label) -> dict.get(labelled, label)
        None -> Error(Nil)
      }
      let #(argument, unlabelled) = case given, unlabelled {
        Ok(a), _ -> #(Some(a), unlabelled)
        Error(Nil), [a, ..rest] -> #(Some(a), rest)
        Error(Nil), [] -> #(None, [])
      }
      case p.name {
        glance.Named(n) -> #(
          dict.insert(bound, n, case argument {
            Some(a) -> binding(ctx, env, a)
            None -> Opaque
          }),
          unlabelled,
        )
        glance.Discarded(_) -> #(bound, unlabelled)
      }
    })
  case list.any(dict.values(bound), fn(b) { b != Opaque }) {
    True -> Ok(#(f, bound))
    False -> Error(Nil)
  }
}

fn bool_guard(stop: Bool, continue: fn() -> Result(a, Nil)) -> Result(a, Nil) {
  case stop {
    True -> Error(Nil)
    False -> continue()
  }
}

fn shadow(env: Env, patterns: List(glance.Pattern)) -> Env {
  list.fold(list.flat_map(patterns, pattern_names), env, fn(env, n) {
    dict.insert(env, n, Opaque)
  })
}

fn pattern_names(p: glance.Pattern) -> List(String) {
  case p {
    glance.PatternVariable(_, name) -> [name]
    glance.PatternAssignment(_, pattern, name) -> [
      name,
      ..pattern_names(pattern)
    ]
    glance.PatternTuple(_, elements) -> list.flat_map(elements, pattern_names)
    glance.PatternList(_, elements, tail) ->
      list.flat_map(list.append(elements, optional(tail)), pattern_names)
    glance.PatternVariant(arguments:, ..) ->
      list.flat_map(arguments, fn(f) {
        case f {
          glance.LabelledField(item:, ..) | glance.UnlabelledField(item) ->
            pattern_names(item)
          glance.ShorthandField(label:, ..) -> [label]
        }
      })
    glance.PatternConcatenate(prefix_name:, rest_name:, ..) ->
      [prefix_name, Some(rest_name)]
      |> list.filter_map(fn(n) {
        case n {
          Some(glance.Named(n)) -> Ok(n)
          _ -> Error(Nil)
        }
      })
    glance.PatternBitString(_, segments) ->
      list.flat_map(segments, fn(s) { pattern_names(s.0) })
    glance.PatternInt(..)
    | glance.PatternFloat(..)
    | glance.PatternString(..)
    | glance.PatternDiscard(..) -> []
  }
}

/// The 1-based line of byte offset `at`.
fn line(source: String, at: Int) -> Int {
  let before =
    bit_array.from_string(source)
    |> bit_array.slice(0, at)
    |> result.try(bit_array.to_string)
    |> result.unwrap("")
  list.length(string.split(before, "\n"))
}

// --- Resolving SQL text ------------------------------------------------------------------------------------------

fn binding(ctx: Context, env: Env, e: glance.Expression) -> Binding {
  case resolve(ctx, env, e), items(env, e) {
    Ok(text), _ -> Text(text)
    Error(_), Some(n) -> Items(n)
    Error(_), None -> Opaque
  }
}

/// How many items the list `e` has, when the source writes it out.
fn items(env: Env, e: glance.Expression) -> Option(Int) {
  case e {
    glance.List(_, elements, None) -> Some(list.length(elements))
    glance.List(_, elements, Some(rest)) ->
      items(env, rest) |> option.map(fn(n) { n + list.length(elements) })
    glance.Variable(_, name) ->
      case dict.get(env, name) {
        Ok(Items(n)) -> Some(n)
        _ -> None
      }
    _ -> None
  }
}

/// The text `e` evaluates to, if it's built only from what this check follows; otherwise the first piece it
/// doesn't follow, as written.
fn resolve(
  ctx: Context,
  env: Env,
  e: glance.Expression,
) -> Result(String, String) {
  case unpipe(e) {
    glance.String(_, value) -> Ok(unescape(value))
    glance.BinaryOperator(_, glance.Concatenate, left, right) -> {
      use l <- result.try(resolve(ctx, env, left))
      use r <- result.try(resolve(ctx, env, right))
      Ok(l <> r)
    }
    glance.Variable(_, name) ->
      case dict.get(env, name) {
        Ok(Text(value)) -> Ok(value)
        Ok(_) -> Error(name)
        Error(Nil) ->
          case constant(ctx, ctx.module, name) {
            Ok(v) -> Ok(v)
            Error(Nil) ->
              case unqualified_import(ctx.module, name) {
                Ok(#(module, original)) ->
                  imported_constant(ctx, module, original)
                  |> result.replace_error(name)
                Error(Nil) -> Error(name)
              }
          }
      }
    glance.FieldAccess(_, glance.Variable(_, alias), label) -> {
      let written = alias <> "." <> label
      case dict.has_key(env, alias), imported_module(ctx.module, alias) {
        False, Ok(module) ->
          imported_constant(ctx, module, label) |> result.replace_error(written)
        _, _ -> Error(written)
      }
    }
    glance.Call(
      _,
      glance.FieldAccess(_, glance.Variable(_, alias), "qualified"),
      [glance.UnlabelledField(glance.String(_, prefix))],
    ) -> {
      let written = alias <> ".qualified(\"" <> prefix <> "\")"
      case dict.has_key(env, alias), imported_module(ctx.module, alias) {
        False, Ok("scoutbox/rows/" <> _ as module) ->
          imported_constant(ctx, module, "columns")
          |> result.map(fn(columns) {
            columns
            |> string.split(", ")
            |> list.map(fn(c) { prefix <> "." <> c })
            |> string.join(", ")
          })
          |> result.replace_error(written)
        _, _ -> Error(written)
      }
    }
    glance.Call(function: glance.Variable(_, name), arguments:, ..) ->
      case bound_call(ctx, env, name, arguments) {
        Ok(#(f, bound)) ->
          evaluate(Context(..ctx, depth: ctx.depth + 1), bound, f.body)
          |> result.replace_error(name <> "(…)")
        Error(Nil) -> Error(name <> "(…)")
      }
    glance.Block(_, statements) -> evaluate(ctx, env, statements)
    glance.Call(
      function: glance.FieldAccess(_, glance.Variable(_, module), name),
      ..,
    ) -> Error(module <> "." <> name <> "(…)")
    glance.FieldAccess(_, _, label) -> Error("…." <> label)
    _ -> Error("an expression")
  }
}

/// The text a function body or block evaluates to: its `let`s bound in order, then its last expression.
fn evaluate(
  ctx: Context,
  env: Env,
  statements: List(glance.Statement),
) -> Result(String, String) {
  case statements {
    [glance.Expression(e)] -> resolve(ctx, env, e)
    [statement, ..rest] ->
      evaluate(ctx, bind_statement(ctx, env, statement), rest)
    [] -> Error("an expression")
  }
}

fn imported_constant(
  ctx: Context,
  module: String,
  name: String,
) -> Result(String, Nil) {
  case dict.get(ctx.modules, module) {
    Ok(parsed) -> constant(ctx, parsed, name)
    Error(Nil) -> Error(Nil)
  }
}

/// `module`'s constant `name`, resolved in `module`.
fn constant(ctx: Context, module: Parsed, name: String) -> Result(String, Nil) {
  case list.find(module.ast.constants, fn(c) { c.definition.name == name }) {
    Ok(c) ->
      resolve(Context(..ctx, module: module), dict.new(), c.definition.value)
      |> result.replace_error(Nil)
    Error(Nil) -> Error(Nil)
  }
}

/// The module `alias` names in `module`'s imports.
fn imported_module(module: Parsed, alias: String) -> Result(String, Nil) {
  list.find_map(module.ast.imports, fn(d) {
    let i = d.definition
    let name = case i.alias {
      Some(glance.Named(a)) -> a
      Some(glance.Discarded(_)) -> ""
      None -> i.module |> string.split("/") |> list.last |> result.unwrap("")
    }
    case name == alias {
      True -> Ok(i.module)
      False -> Error(Nil)
    }
  })
}

/// The module and original name of a value `module` imports unqualified as `name`.
fn unqualified_import(
  module: Parsed,
  name: String,
) -> Result(#(String, String), Nil) {
  list.find_map(module.ast.imports, fn(d) {
    let i = d.definition
    list.find_map(i.unqualified_values, fn(u) {
      case option.unwrap(u.alias, u.name) == name {
        True -> Ok(#(i.module, u.name))
        False -> Error(Nil)
      }
    })
  })
}

/// A Gleam string literal's text, from glance's value (escapes as written).
fn unescape(value: String) -> String {
  unescape_loop(string.to_graphemes(value), "")
}

fn unescape_loop(chars: List(String), acc: String) -> String {
  case chars {
    [] -> acc
    ["\\", "n", ..rest] -> unescape_loop(rest, acc <> "\n")
    ["\\", "t", ..rest] -> unescape_loop(rest, acc <> "\t")
    ["\\", "r", ..rest] -> unescape_loop(rest, acc <> "\r")
    ["\\", "\"", ..rest] -> unescape_loop(rest, acc <> "\"")
    ["\\", "\\", ..rest] -> unescape_loop(rest, acc <> "\\")
    [c, ..rest] -> unescape_loop(rest, acc <> c)
  }
}

fn optional(value: Option(a)) -> List(a) {
  case value {
    Some(v) -> [v]
    None -> []
  }
}

// --- Placeholders ------------------------------------------------------------------------------------------------

/// How many anonymous `?` placeholders `sql` has, outside strings, quoted names and comments. `Error` when it has
/// numbered or named ones (`?1`, `:name`, `@name`, `$name`), which bind by name rather than by position.
pub fn placeholders(sql: String) -> Result(Int, Nil) {
  count(string.to_graphemes(sql), 0)
}

fn count(chars: List(String), n: Int) -> Result(Int, Nil) {
  case chars {
    [] -> Ok(n)
    ["'", ..rest] -> count(skip_quoted(rest, "'"), n)
    ["\"", ..rest] -> count(skip_quoted(rest, "\""), n)
    ["`", ..rest] -> count(skip_quoted(rest, "`"), n)
    ["[", ..rest] -> count(skip_quoted(rest, "]"), n)
    ["-", "-", ..rest] -> count(list.drop_while(rest, fn(c) { c != "\n" }), n)
    ["/", "*", ..rest] -> count(skip_block_comment(rest), n)
    ["?", next, ..rest] ->
      case is_digit(next) {
        True -> Error(Nil)
        False -> count([next, ..rest], n + 1)
      }
    ["?"] -> Ok(n + 1)
    [":", next, ..rest] | ["@", next, ..rest] | ["$", next, ..rest] ->
      case is_name_start(next) {
        True -> Error(Nil)
        False -> count([next, ..rest], n)
      }
    [_, ..rest] -> count(rest, n)
  }
}

/// After an opening quote: the rest past its closing one. A doubled closing quote is an escaped one.
fn skip_quoted(chars: List(String), close: String) -> List(String) {
  case chars {
    [] -> []
    [c, d, ..rest] if c == close && d == close -> skip_quoted(rest, close)
    [c, ..rest] if c == close -> rest
    [_, ..rest] -> skip_quoted(rest, close)
  }
}

fn skip_block_comment(chars: List(String)) -> List(String) {
  case chars {
    [] -> []
    ["*", "/", ..rest] -> rest
    [_, ..rest] -> skip_block_comment(rest)
  }
}

fn is_digit(c: String) -> Bool {
  string.contains("0123456789", c)
}

fn is_name_start(c: String) -> Bool {
  string.contains("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_", c)
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
