//// Checking a rule against the blessed answers in a fixture (test/fixtures/<name>.json).
////
//// A fixture holds inputs and, beside them, the answers the rule gave when they were last blessed. A test reads the
//// inputs, works out this server's answers, and hands them to `check` with where each one is stored. `check` fails
//// once, naming every answer that differs, rather than at the first.
////
//// To change a rule on purpose: change the code, run `npm run fixtures:bless`, review the answers it says changed,
//// and commit them with the code. Under bless (`SCOUTBOX_BLESS=1`) `check` never fails: it writes this server's
//// answers to build/bless/<name>.jsonl, and dev/bless.mjs writes those into the fixture. So what is blessed is
//// exactly what is checked.
////
//// An answer is stored in one of three ways:
//// - `answer`: at a place in the fixture (`at`, `field`, `items`), beside its input.
//// - `entry`: under a key of an object (`table`). Bless rebuilds the whole object from the entries it is given, so
////   an input this server gains or loses gains or loses its key. The key names the input.
//// - `interned`: either of those, holding the index of the answer in a shared list (`pool`) rather than the answer,
////   for a large matrix with few distinct answers. Bless rebuilds the pool from the answers it is given.

import envoy
import gleam/dict.{type Dict}
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/string
import simplifile

pub opaque type Key {
  Field(String)
  Index(Int)
}

/// A fixture as read: its name and its whole JSON.
pub opaque type Fixture {
  Fixture(name: String, data: Dynamic)
}

/// A place in a fixture and the JSON stored there.
pub opaque type Item {
  Item(at: List(Key), value: Dynamic)
}

/// An object of answers, read once, whose keys name the inputs.
pub opaque type Table {
  Table(at: List(Key), entries: Dict(String, Dynamic))
}

/// A list of distinct answers that interned answers point into.
pub opaque type Pool {
  Pool(at: List(Key), values: Dict(Int, Dynamic))
}

type Place {
  At(List(Key))
  Entry(table: List(Key), key: String)
}

pub opaque type Answer {
  Answer(
    what: String,
    place: Place,
    pool: Option(Pool),
    stored: Option(Dynamic),
    actual: Json,
  )
}

/// Reads test/fixtures/<name>.json.
pub fn load(name: String) -> Fixture {
  let path = "test/fixtures/" <> name <> ".json"
  let assert Ok(text) = simplifile.read(path)
  let assert Ok(data) = json.parse(text, decode.dynamic)
  Fixture(name:, data:)
}

pub fn root(f: Fixture) -> Item {
  Item([], f.data)
}

/// The value at `name` in an object. Panics when there is none: a fixture's shape is the test's to know.
pub fn field(item: Item, name: String) -> Item {
  case decode.run(item.value, decode.at([name], decode.dynamic)) {
    Ok(value) -> Item(list.append(item.at, [Field(name)]), value)
    Error(_) -> panic as { "the fixture has no " <> path_text(item.at, name) }
  }
}

/// The elements of a list, in order.
pub fn items(item: Item) -> List(Item) {
  let assert Ok(values) = decode.run(item.value, decode.list(decode.dynamic))
  list.index_map(values, fn(value, i) {
    Item(list.append(item.at, [Index(i)]), value)
  })
}

/// The element at `i` of a list.
pub fn index(item: Item, i: Int) -> Item {
  let assert Ok(found) = list.drop(items(item), i) |> list.first
  found
}

/// The item's JSON, read with `decoder`.
pub fn read(item: Item, decoder: decode.Decoder(a)) -> a {
  case decode.run(item.value, decoder) {
    Ok(a) -> a
    Error(e) ->
      panic as {
        "the fixture's " <> path_text(item.at, "") <> " " <> string.inspect(e)
      }
  }
}

pub fn table(item: Item) -> Table {
  // Before a first bless, the place may hold something else: then no entry is stored yet.
  let entries =
    decode.run(item.value, decode.dict(decode.string, decode.dynamic))
    |> option.from_result
    |> option.unwrap(dict.new())
  Table(item.at, entries)
}

pub fn pool(item: Item) -> Pool {
  let values =
    decode.run(item.value, decode.list(decode.dynamic))
    |> option.from_result
    |> option.unwrap([])
  Pool(item.at, list.index_map(values, fn(v, i) { #(i, v) }) |> dict.from_list)
}

/// This server's answer for the input described by `what`, stored at `item`.
pub fn answer(item: Item, what: String, actual: Json) -> Answer {
  Answer(
    what:,
    place: At(item.at),
    pool: None,
    stored: Some(item.value),
    actual:,
  )
}

/// This server's answer for the input named `key`, stored in `t` under it.
pub fn entry(t: Table, key: String, actual: Json) -> Answer {
  Answer(
    what: key,
    place: Entry(t.at, key),
    pool: None,
    stored: dict.get(t.entries, key) |> option.from_result,
    actual:,
  )
}

/// The same answer, stored as its index in `p`.
pub fn interned(a: Answer, p: Pool) -> Answer {
  let stored = case a.stored {
    Some(slot) ->
      case decode.run(slot, decode.int) {
        Ok(i) -> dict.get(p.values, i) |> option.from_result
        Error(_) -> None
      }
    None -> None
  }
  Answer(..a, pool: Some(p), stored:)
}

/// Fails, naming the first twenty answers that differ from the blessed ones. Under bless, records them instead.
pub fn check(f: Fixture, answers: List(Answer)) -> Nil {
  case envoy.get("SCOUTBOX_BLESS") {
    Ok(_) -> record(f, answers)
    Error(Nil) -> compare(f, answers)
  }
}

fn compare(f: Fixture, answers: List(Answer)) -> Nil {
  let differ =
    list.filter_map(answers, fn(a) {
      let actual = as_dynamic(a.actual)
      case a.stored {
        Some(stored) ->
          case same(stored, actual) {
            True -> Error(Nil)
            False -> Ok(#(a.what, text(stored), json.to_string(a.actual)))
          }
        None -> Ok(#(a.what, "(nothing blessed)", json.to_string(a.actual)))
      }
    })
  case differ {
    [] -> Nil
    _ ->
      panic as {
        int.to_string(list.length(differ))
        <> " of "
        <> int.to_string(list.length(answers))
        <> " answers differ from the blessed ones in test/fixtures/"
        <> f.name
        <> ".json. If the change is meant, run `npm run fixtures:bless` and review what it says changed.\n  "
        <> list.take(differ, 20)
        |> list.map(fn(d) {
          d.0 <> "\n    blessed " <> d.1 <> "\n    got     " <> d.2
        })
        |> string.join("\n  ")
      }
  }
}

fn record(f: Fixture, answers: List(Answer)) -> Nil {
  let lines =
    list.map(answers, fn(a) {
      let place = case a.place {
        At(at) -> [#("at", keys_json(at))]
        Entry(t, key) -> [#("table", keys_json(t)), #("key", json.string(key))]
      }
      let pool = case a.pool {
        Some(p) -> [#("pool", keys_json(p.at))]
        None -> []
      }
      json.object(
        list.flatten([
          [#("what", json.string(a.what))],
          place,
          pool,
          [#("answer", a.actual)],
        ]),
      )
      |> json.to_string
      |> string.append("\n")
    })
  let assert Ok(Nil) = simplifile.create_directory_all("build/bless")
  let assert Ok(Nil) =
    simplifile.append(
      "build/bless/" <> f.name <> ".jsonl",
      string.concat(lines),
    )
  Nil
}

fn keys_json(keys: List(Key)) -> Json {
  json.array(keys, fn(k) {
    case k {
      Field(name) -> json.string(name)
      Index(i) -> json.int(i)
    }
  })
}

fn as_dynamic(j: Json) -> Dynamic {
  let assert Ok(d) = json.parse(json.to_string(j), decode.dynamic)
  d
}

/// Equal as JSON: objects in any key order, and a whole float equal to the same integer (JavaScript wrote `1` where
/// Gleam writes `1.0`).
fn same(a: Dynamic, b: Dynamic) -> Bool {
  a == b
  || case number(a), number(b) {
    Ok(x), Ok(y) -> x == y
    _, _ ->
      case
        decode.run(a, decode.list(decode.dynamic)),
        decode.run(b, decode.list(decode.dynamic))
      {
        Ok(xs), Ok(ys) ->
          list.length(xs) == list.length(ys)
          && list.all(list.zip(xs, ys), fn(p) { same(p.0, p.1) })
        _, _ ->
          case
            decode.run(a, decode.dict(decode.string, decode.dynamic)),
            decode.run(b, decode.dict(decode.string, decode.dynamic))
          {
            Ok(x), Ok(y) ->
              dict.size(x) == dict.size(y)
              && list.all(dict.to_list(x), fn(kv) {
                case dict.get(y, kv.0) {
                  Ok(v) -> same(kv.1, v)
                  Error(Nil) -> False
                }
              })
            _, _ -> False
          }
      }
  }
}

fn number(d: Dynamic) -> Result(Float, Nil) {
  case decode.run(d, decode.float) {
    Ok(x) -> Ok(x)
    Error(_) ->
      decode.run(d, decode.int)
      |> option.from_result
      |> option.map(int.to_float)
      |> option.to_result(Nil)
  }
}

/// A stored value as JSON text, for a failure message.
fn text(d: Dynamic) -> String {
  json.to_string(to_json(d))
}

fn to_json(d: Dynamic) -> Json {
  let decoder =
    decode.one_of(decode.string |> decode.map(json.string), [
      decode.bool |> decode.map(json.bool),
      decode.int |> decode.map(json.int),
      decode.float |> decode.map(json.float),
      decode.list(decode.dynamic) |> decode.map(json.array(_, to_json)),
      decode.dict(decode.string, decode.dynamic)
        |> decode.map(fn(d) {
          json.object(
            dict.to_list(d) |> list.map(fn(kv) { #(kv.0, to_json(kv.1)) }),
          )
        }),
    ])
  case decode.run(d, decoder) {
    Ok(j) -> j
    Error(_) -> json.null()
  }
}

fn path_text(at: List(Key), last: String) -> String {
  list.map(at, fn(k) {
    case k {
      Field(name) -> name
      Index(i) -> int.to_string(i)
    }
  })
  |> list.append(case last {
    "" -> []
    _ -> [last]
  })
  |> string.join(".")
}
