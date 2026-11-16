//// Canonical JSON (`canonicalJson` in domains/platform/values.ts): objects with their keys sorted, arrays in order,
//// no spaces. An idempotency key's payload fingerprint (`payloadFingerprint`) is this text, so a retry with the
//// same content matches the fingerprint either server stored.

import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/string

pub type Value {
  Null
  Bool(Bool)
  Int(Int)
  Str(String)
  Array(List(Value))
  Object(List(#(String, Value)))
}

pub fn to_string(value: Value) -> String {
  case value {
    Null -> "null"
    Bool(True) -> "true"
    Bool(False) -> "false"
    Int(n) -> int.to_string(n)
    Str(s) -> json.to_string(json.string(s))
    Array(items) -> "[" <> string.join(list.map(items, to_string), ",") <> "]"
    Object(fields) ->
      "{"
      <> fields
      |> list.sort(fn(a, b) { string.compare(a.0, b.0) })
      |> list.map(fn(f) {
        json.to_string(json.string(f.0)) <> ":" <> to_string(f.1)
      })
      |> string.join(",")
      <> "}"
  }
}

pub fn text(s: Option(String)) -> Value {
  case s {
    Some(s) -> Str(s)
    None -> Null
  }
}

pub fn int(n: Option(Int)) -> Value {
  case n {
    Some(n) -> Int(n)
    None -> Null
  }
}

pub fn strings(items: List(String)) -> Value {
  Array(list.map(items, Str))
}
