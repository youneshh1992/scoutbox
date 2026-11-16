//// Stored JSON text read back as `Json`, keeping each object's keys in the order they were written.
////
//// A JSON column (a history entry's detail, say) holds what the TypeScript server's `JSON.stringify` wrote, and a
//// response re-emits it. Decoding to a Dict would lose the key order the batteries compare, so this reads the text
//// itself. Integers stay integers; other numbers are floats.

import gleam/float
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/result
import gleam/string

pub fn parse(text: String) -> Result(Json, Nil) {
  use #(value, rest) <- result.try(value(skip(text)))
  case skip(rest) {
    "" -> Ok(value)
    _ -> Error(Nil)
  }
}

fn skip(s: String) -> String {
  case s {
    " " <> r | "\n" <> r | "\r" <> r | "\t" <> r -> skip(r)
    _ -> s
  }
}

fn value(s: String) -> Result(#(Json, String), Nil) {
  case s {
    "null" <> r -> Ok(#(json.null(), r))
    "true" <> r -> Ok(#(json.bool(True), r))
    "false" <> r -> Ok(#(json.bool(False), r))
    "\"" <> r -> {
      use #(text, rest) <- result.map(string_body(r, ""))
      #(json.string(text), rest)
    }
    "[" <> r -> array(skip(r), [])
    "{" <> r -> object(skip(r), [])
    _ -> number(s)
  }
}

fn array(s: String, acc: List(Json)) -> Result(#(Json, String), Nil) {
  case s, acc {
    "]" <> r, [] -> Ok(#(json.preprocessed_array([]), r))
    _, _ -> {
      use #(v, rest) <- result.try(value(s))
      let acc = [v, ..acc]
      case skip(rest) {
        "," <> r -> array(skip(r), acc)
        "]" <> r -> Ok(#(json.preprocessed_array(list.reverse(acc)), r))
        _ -> Error(Nil)
      }
    }
  }
}

fn object(
  s: String,
  acc: List(#(String, Json)),
) -> Result(#(Json, String), Nil) {
  case s, acc {
    "}" <> r, [] -> Ok(#(json.object([]), r))
    "\"" <> r, _ -> {
      use #(key, rest) <- result.try(string_body(r, ""))
      use rest <- result.try(case skip(rest) {
        ":" <> r -> Ok(skip(r))
        _ -> Error(Nil)
      })
      use #(v, rest) <- result.try(value(rest))
      let acc = [#(key, v), ..acc]
      case skip(rest) {
        "," <> r -> object(skip(r), acc)
        "}" <> r -> Ok(#(json.object(list.reverse(acc)), r))
        _ -> Error(Nil)
      }
    }
    _, _ -> Error(Nil)
  }
}

fn string_body(s: String, acc: String) -> Result(#(String, String), Nil) {
  case string.pop_grapheme(s) {
    Error(Nil) -> Error(Nil)
    Ok(#("\"", r)) -> Ok(#(acc, r))
    Ok(#("\\", r)) ->
      case r {
        "\"" <> r -> string_body(r, acc <> "\"")
        "\\" <> r -> string_body(r, acc <> "\\")
        "/" <> r -> string_body(r, acc <> "/")
        "b" <> r -> string_body(r, acc <> "\u{08}")
        "f" <> r -> string_body(r, acc <> "\u{0C}")
        "n" <> r -> string_body(r, acc <> "\n")
        "r" <> r -> string_body(r, acc <> "\r")
        "t" <> r -> string_body(r, acc <> "\t")
        "u" <> r -> {
          use #(unit, r) <- result.try(hex4(r))
          case unit >= 0xD800 && unit <= 0xDBFF, r {
            True, "\\u" <> r2 -> {
              use #(low, r3) <- result.try(hex4(r2))
              let code = 0x10000 + { unit - 0xD800 } * 0x400 + { low - 0xDC00 }
              use c <- result.try(string.utf_codepoint(code))
              string_body(r3, acc <> string.from_utf_codepoints([c]))
            }
            _, _ -> {
              use c <- result.try(string.utf_codepoint(unit))
              string_body(r, acc <> string.from_utf_codepoints([c]))
            }
          }
        }
        _ -> Error(Nil)
      }
    Ok(#(g, r)) -> string_body(r, acc <> g)
  }
}

fn hex4(s: String) -> Result(#(Int, String), Nil) {
  let digits = string.slice(s, 0, 4)
  case string.length(digits) == 4, int.base_parse(digits, 16) {
    True, Ok(n) -> Ok(#(n, string.drop_start(s, 4)))
    _, _ -> Error(Nil)
  }
}

fn number(s: String) -> Result(#(Json, String), Nil) {
  let #(text, rest) = take_number(s, "")
  case text {
    "" -> Error(Nil)
    _ ->
      case int.parse(text) {
        Ok(n) -> Ok(#(json.int(n), rest))
        Error(_) ->
          case float.parse(text) {
            Ok(f) -> Ok(#(json.float(f), rest))
            // `1e5` and `2E-3`: Gleam's parser wants a fraction before the exponent.
            Error(_) ->
              case string.split_once(string.lowercase(text), "e") {
                Ok(#(m, e)) -> {
                  let m = case string.contains(m, ".") {
                    True -> m
                    False -> m <> ".0"
                  }
                  float.parse(m <> "e" <> e)
                  |> result.map(fn(f) { #(json.float(f), rest) })
                }
                Error(_) -> Error(Nil)
              }
          }
      }
  }
}

fn take_number(s: String, acc: String) -> #(String, String) {
  case string.pop_grapheme(s) {
    Ok(#(g, r)) ->
      case string.contains("0123456789+-.eE", g) {
        True -> take_number(r, acc <> g)
        False -> #(acc, s)
      }
    Error(Nil) -> #(acc, s)
  }
}
