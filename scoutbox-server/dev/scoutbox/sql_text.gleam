//// SQL text as tokens, for the SQL check: enough of SQLite's lexer to find placeholders and the names around them,
//// never to understand a statement.

import gleam/list
import gleam/string

pub type Token {
  /// A keyword or a name, quoted or not, without its quotes.
  Word(String)
  /// An anonymous `?`.
  Param
  /// A string literal.
  Text
  Number
  /// An operator or punctuation: `=`, `<>`, `||`, `(`, `,`, `.`, ….
  Symbol(String)
}

/// `sql`'s tokens. `Error` when it has numbered or named parameters (`?1`, `:name`, `@name`, `$name`), which bind
/// by name rather than by position.
pub fn tokens(sql: String) -> Result(List(Token), Nil) {
  lex(string.to_graphemes(sql), [])
}

/// How many anonymous `?` placeholders `sql` has, outside strings, quoted names and comments. `Error` when it has
/// numbered or named ones, whose count says nothing about how many arguments bind.
pub fn placeholders(sql: String) -> Result(Int, Nil) {
  case tokens(sql) {
    Ok(tokens) -> Ok(list.count(tokens, fn(t) { t == Param }))
    Error(Nil) -> Error(Nil)
  }
}

/// Whether `token` is the keyword `keyword` (given in upper case).
pub fn is(token: Token, keyword: String) -> Bool {
  case token {
    Word(w) -> string.uppercase(w) == keyword
    _ -> False
  }
}

const two_character_symbols = ["==", "!=", "<>", "<=", ">=", "||", "<<", ">>"]

fn lex(chars: List(String), acc: List(Token)) -> Result(List(Token), Nil) {
  case chars {
    [] -> Ok(list.reverse(acc))
    ["'", ..rest] -> lex(skip_quoted(rest, "'").1, [Text, ..acc])
    ["\"", ..rest] -> quoted(rest, "\"", acc)
    ["`", ..rest] -> quoted(rest, "`", acc)
    ["[", ..rest] -> quoted(rest, "]", acc)
    ["-", "-", ..rest] -> lex(list.drop_while(rest, fn(c) { c != "\n" }), acc)
    ["/", "*", ..rest] -> lex(skip_block_comment(rest), acc)
    ["?", next, ..] ->
      case is_digit(next) {
        True -> Error(Nil)
        False -> lex(list.drop(chars, 1), [Param, ..acc])
      }
    ["?"] -> lex([], [Param, ..acc])
    [":", next, ..] | ["@", next, ..] | ["$", next, ..] ->
      case is_word_start(next) {
        True -> Error(Nil)
        False -> lex(list.drop(chars, 1), [Symbol(":"), ..acc])
      }
    [c, ..rest] ->
      case is_space(c), is_digit(c), is_word_start(c) {
        True, _, _ -> lex(rest, acc)
        _, True, _ -> {
          let rest = list.drop_while(rest, is_number_char)
          lex(rest, [Number, ..acc])
        }
        _, _, True -> {
          let #(word, rest) = take_while(chars, is_word_char, "")
          lex(rest, [Word(word), ..acc])
        }
        _, _, _ ->
          case rest {
            [d, ..after] ->
              case list.contains(two_character_symbols, c <> d) {
                True -> lex(after, [Symbol(c <> d), ..acc])
                False -> lex(rest, [Symbol(c), ..acc])
              }
            [] -> lex(rest, [Symbol(c), ..acc])
          }
      }
  }
}

fn quoted(
  chars: List(String),
  close: String,
  acc: List(Token),
) -> Result(List(Token), Nil) {
  let #(name, rest) = skip_quoted(chars, close)
  lex(rest, [Word(name), ..acc])
}

/// After an opening quote: what it quotes, and the rest past its closing one. A doubled closing quote is an
/// escaped one.
fn skip_quoted(chars: List(String), close: String) -> #(String, List(String)) {
  skip_quoted_loop(chars, close, "")
}

fn skip_quoted_loop(
  chars: List(String),
  close: String,
  acc: String,
) -> #(String, List(String)) {
  case chars {
    [] -> #(acc, [])
    [c, d, ..rest] if c == close && d == close ->
      skip_quoted_loop(rest, close, acc <> c)
    [c, ..rest] if c == close -> #(acc, rest)
    [c, ..rest] -> skip_quoted_loop(rest, close, acc <> c)
  }
}

fn skip_block_comment(chars: List(String)) -> List(String) {
  case chars {
    [] -> []
    ["*", "/", ..rest] -> rest
    [_, ..rest] -> skip_block_comment(rest)
  }
}

fn take_while(
  chars: List(String),
  keep: fn(String) -> Bool,
  acc: String,
) -> #(String, List(String)) {
  case chars {
    [c, ..rest] ->
      case keep(c) {
        True -> take_while(rest, keep, acc <> c)
        False -> #(acc, chars)
      }
    [] -> #(acc, [])
  }
}

fn is_space(c: String) -> Bool {
  c == " " || c == "\n" || c == "\t" || c == "\r"
}

fn is_digit(c: String) -> Bool {
  string.contains("0123456789", c)
}

fn is_number_char(c: String) -> Bool {
  string.contains("0123456789.eExXabcdefABCDEF_", c)
}

fn is_word_start(c: String) -> Bool {
  string.contains("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_", c)
}

fn is_word_char(c: String) -> Bool {
  is_word_start(c) || is_digit(c) || c == "$"
}
