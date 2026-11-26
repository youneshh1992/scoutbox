//// The order a request's JSON objects named their keys in. A decoded JSON object is an Erlang map, which has no
//// order, but the TypeScript server reads bodies in the order sent: it names the first unknown field as sent, and
//// a policy version's rules keep the order they were sent in (docs/known-issues.md). This reads the order from
//// the body's raw text, so `input` can follow it.

import gleam/dict
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/platform/json_text

/// The keys of an object as sent, each with its value's order; a list's items; or nothing known.
pub type KeyOrder {
  Keys(List(#(String, KeyOrder)))
  Items(List(KeyOrder))
  Unknown
}

/// One step into a body: an object's key, or a list's index.
pub type Step {
  Key(String)
  Index(Int)
}

/// The order of the JSON `text`, or `Unknown` when it is not JSON this can read.
pub fn of(text: String) -> KeyOrder {
  case value(json_text.skip_space(text)) {
    Ok(#(order, _)) -> order
    Error(Nil) -> Unknown
  }
}

fn value(s: String) -> Result(#(KeyOrder, String), Nil) {
  case s {
    "{" <> r -> object(json_text.skip_space(r), [])
    "[" <> r -> array(json_text.skip_space(r), [])
    "\"" <> r ->
      json_text.read_string(r) |> result.map(fn(x) { #(Unknown, x.1) })
    _ -> Ok(#(Unknown, scalar(s)))
  }
}

/// A number or a literal, skipped.
fn scalar(s: String) -> String {
  case string.pop_grapheme(s) {
    Ok(#(g, r)) ->
      case string.contains(",]} \n\r\t", g) {
        True -> s
        False -> scalar(r)
      }
    Error(Nil) -> s
  }
}

fn object(
  s: String,
  acc: List(#(String, KeyOrder)),
) -> Result(#(KeyOrder, String), Nil) {
  case s, acc {
    "}" <> r, [] -> Ok(#(Keys([]), r))
    "\"" <> r, _ -> {
      use #(key, rest) <- result.try(json_text.read_string(r))
      use rest <- result.try(case json_text.skip_space(rest) {
        ":" <> r -> Ok(json_text.skip_space(r))
        _ -> Error(Nil)
      })
      use #(v, rest) <- result.try(value(rest))
      let acc = [#(key, v), ..acc]
      case json_text.skip_space(rest) {
        "," <> r -> object(json_text.skip_space(r), acc)
        "}" <> r -> Ok(#(Keys(list.reverse(acc)), r))
        _ -> Error(Nil)
      }
    }
    _, _ -> Error(Nil)
  }
}

fn array(s: String, acc: List(KeyOrder)) -> Result(#(KeyOrder, String), Nil) {
  case s, acc {
    "]" <> r, [] -> Ok(#(Items([]), r))
    _, _ -> {
      use #(v, rest) <- result.try(value(s))
      let acc = [v, ..acc]
      case json_text.skip_space(rest) {
        "," <> r -> array(json_text.skip_space(r), acc)
        "]" <> r -> Ok(#(Items(list.reverse(acc)), r))
        _ -> Error(Nil)
      }
    }
  }
}

/// The order at `path`. A key sent twice is read at its first place.
pub fn at(order: KeyOrder, path: List(Step)) -> KeyOrder {
  case path, order {
    [], _ -> order
    [Key(k), ..rest], Keys(entries) ->
      case list.key_find(entries, k) {
        Ok(inner) -> at(inner, rest)
        Error(Nil) -> Unknown
      }
    [Index(i), ..rest], Items(items) ->
      case list.drop(items, i) {
        [inner, ..] -> at(inner, rest)
        [] -> Unknown
      }
    _, _ -> Unknown
  }
}

/// The keys of the object at `path` in the order sent, if it was an object.
pub fn keys(order: KeyOrder, path: List(Step)) -> Option(List(String)) {
  case at(order, path) {
    Keys(entries) -> Some(list.map(entries, fn(e) { e.0 }) |> list.unique)
    _ -> None
  }
}

/// A refusal's field path (`parties[0].guardianConsent`) as steps. A key containing `.` or `[` reads wrongly, and
/// its order is then simply not found.
pub fn steps(path: String) -> List(Step) {
  string.split(path, ".")
  |> list.flat_map(fn(part) {
    case string.split(part, "[") {
      [key, ..indexes] ->
        list.append(
          case key {
            "" -> []
            _ -> [Key(key)]
          },
          list.filter_map(indexes, fn(x) {
            int.parse(string.replace(x, "]", "")) |> result.map(Index)
          }),
        )
      [] -> []
    }
  })
}

/// `items`, sorted by where each key was sent; a key the order doesn't know goes last, in its own order.
pub fn sort(
  items: List(#(String, a)),
  sent: Option(List(String)),
) -> List(#(String, a)) {
  case sent {
    None -> items
    Some(sent) -> {
      let known =
        list.filter_map(sent, fn(k) {
          list.key_find(items, k) |> result.map(fn(v) { #(k, v) })
        })
      let rest = list.filter(items, fn(x) { !list.contains(sent, x.0) })
      list.append(known, rest)
    }
  }
}

/// A JSON value read from a body, written back as JavaScript's `JSON.stringify` writes it after `JSON.parse`: each
/// object's keys in the order sent (`order`), except that keys which are array indexes (`"0"`, `"12"`) come first,
/// in ascending order, as JavaScript orders an object's properties. For a value a route stores as sent (a
/// drawing it never reads).
pub fn to_json(value: Dynamic, order: KeyOrder) -> Json {
  case
    dynamic.classify(value),
    decode.run(value, decode.int),
    decode.run(value, decode.float)
  {
    "Nil", _, _ | "Null", _, _ -> json.null()
    _, Ok(n), _ -> json.int(n)
    _, _, Ok(f) -> json_text.number(f)
    _, _, _ ->
      case decode.run(value, decode.string), decode.run(value, decode.bool) {
        Ok(s), _ -> json.string(s)
        _, Ok(b) -> json.bool(b)
        _, _ ->
          case
            decode.run(value, decode.list(decode.dynamic)),
            decode.run(value, decode.dict(decode.string, decode.dynamic))
          {
            Ok(items), _ ->
              json.preprocessed_array(
                list.index_map(items, fn(item, i) {
                  to_json(item, at(order, [Index(i)]))
                }),
              )
            _, Ok(fields) -> object_json(dict.to_list(fields), order)
            _, _ -> json.null()
          }
      }
  }
}

/// An object's entries written as `to_json` writes an object. `order` may be a list's (`Items`): an object read
/// from a list (valibot's `record` takes one) finds each value's order by its index.
pub fn object_json(entries: List(#(String, Dynamic)), order: KeyOrder) -> Json {
  let entries =
    entries
    |> list.sort(fn(a, b) { string.compare(a.0, b.0) })
    |> sort(keys(order, []))
  let #(indexes, named) =
    list.partition(entries, fn(e) { array_index(e.0) != Error(Nil) })
  let indexes =
    list.sort(indexes, fn(a, b) {
      int.compare(
        result.unwrap(array_index(a.0), 0),
        result.unwrap(array_index(b.0), 0),
      )
    })
  json.object(
    list.map(list.append(indexes, named), fn(e) {
      let inner = case order, array_index(e.0) {
        Items(_), Ok(i) -> at(order, [Index(i)])
        _, _ -> at(order, [Key(e.0)])
      }
      #(e.0, to_json(e.1, inner))
    }),
  )
}

/// A key JavaScript treats as an array index: a canonical whole number below 2^32 - 1.
fn array_index(key: String) -> Result(Int, Nil) {
  case int.parse(key) {
    Ok(n) if n >= 0 && n < 4_294_967_295 ->
      case int.to_string(n) == key {
        True -> Ok(n)
        False -> Error(Nil)
      }
    _ -> Error(Nil)
  }
}
