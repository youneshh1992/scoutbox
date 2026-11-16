//// Deterministic fault injection for development and test (domains/platform/faults.mjs; the contract is
//// e2e/support/CONTRACT.md). Inert in production, where SCOUTBOX_FAULTS is also refused at boot.
////
//// Rules are `kind:pattern[:arg]` separated by `;`; `*` in a pattern matches one path segment.
////
////   delay:PATH:MS         answer normally after MS ms (default 1000)
////   unavailable:PATH      503 SOURCE_UNAVAILABLE, retryable
////   timeout:PATH:MS       hold MS ms (default 3000), then 504 SOURCE_TIMEOUT, retryable
////   retryable:PATH[:N]    503 for the first N hits (default 1)
////   fatal:PATH            500 INTERNAL, not retryable
////   internal:STEP[:N]     the named step inside a unit fails for its first N hits (default 1), so the unit rolls
////                         back; with N = 0 it only counts the hits

import gleam/erlang/process
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, Some}
import gleam/result
import gleam/string
import scoutbox/platform/table.{type Table}

pub type Kind {
  Delay
  Unavailable
  Timeout
  Retryable
  Fatal
  Internal
}

const kinds = [
  #("delay", Delay),
  #("unavailable", Unavailable),
  #("timeout", Timeout),
  #("retryable", Retryable),
  #("fatal", Fatal),
  #("internal", Internal),
]

pub type Rule {
  Rule(kind: Kind, pattern: String, arg: Option(Int), hits: Int)
}

pub opaque type Faults {
  Faults(enabled: Bool, rules: Table(List(Rule)))
}

const key = "rules"

/// The fault layer. `enabled` is false in production: no rule ever applies and `/__faults` does not exist.
pub fn start(enabled: Bool, spec: String) -> Result(Faults, String) {
  use rules <- result.try(case enabled {
    True -> parse(spec)
    False -> Ok([])
  })
  use t <- result.map(table.start())
  let faults = Faults(enabled:, rules: t)
  set(faults, rules)
  faults
}

pub fn enabled(faults: Faults) -> Bool {
  faults.enabled
}

fn set(faults: Faults, rules: List(Rule)) -> Nil {
  table.update(faults.rules, key, fn(_) { #(Some(rules), Nil) })
}

pub fn rules(faults: Faults) -> List(Rule) {
  table.update(faults.rules, key, fn(entry) {
    #(entry, option.unwrap(entry, []))
  })
}

/// Parses rules as the TypeScript server does: an unknown kind or a missing pattern refuses the whole spec. An
/// argument that is not a number is kept as none.
pub fn parse(spec: String) -> Result(List(Rule), String) {
  spec
  |> string.split(";")
  |> list.map(string.trim)
  |> list.filter(fn(s) { s != "" })
  |> list.try_map(fn(rule) {
    let parts = string.split(rule, ":")
    let kind =
      list.first(parts)
      |> result.try(list.key_find(kinds, _))
    let pattern = list.drop(parts, 1) |> list.first
    case kind, pattern {
      Ok(kind), Ok(pattern) if pattern != "" ->
        Ok(Rule(
          kind:,
          pattern:,
          arg: list.drop(parts, 2)
            |> list.first
            |> result.try(int.parse)
            |> option.from_result,
          hits: 0,
        ))
      _, _ -> Error("bad fault rule \"" <> rule <> "\"")
    }
  })
}

pub fn kind_name(kind: Kind) -> String {
  let assert Ok(#(name, _)) = list.find(kinds, fn(k) { k.1 == kind })
  name
}

fn matches(pattern: String, path: String) -> Bool {
  let p = string.split(pattern, "/")
  let q = string.split(path, "/")
  list.length(p) == list.length(q)
  && list.all(list.zip(p, q), fn(pair) { pair.0 == "*" || pair.0 == pair.1 })
}

/// What a route fault does to a request.
pub type Outcome {
  /// Handle the request normally.
  Pass
  /// Handle it normally after a pause.
  Pause(ms: Int)
  /// Answer with a simulated failure instead, after `after_ms`.
  Fail(
    after_ms: Int,
    status: Int,
    error: String,
    retryable: Bool,
    message: String,
  )
}

/// The first route rule matching `path`, counted as reached.
pub fn for_path(faults: Faults, path: String) -> Outcome {
  case faults.enabled {
    False -> Pass
    True ->
      table.update(faults.rules, key, fn(entry) {
        let rules = option.unwrap(entry, [])
        case
          list.find(rules, fn(r) {
            r.kind != Internal && matches(r.pattern, path)
          })
        {
          Error(Nil) -> #(entry, Pass)
          Ok(found) -> {
            let hit = Rule(..found, hits: found.hits + 1)
            #(Some(replace(rules, found, hit)), outcome(hit))
          }
        }
      })
  }
}

fn replace(rules: List(Rule), old: Rule, new: Rule) -> List(Rule) {
  let #(before, after) = list.split_while(rules, fn(r) { r != old })
  list.append(before, [new, ..list.drop(after, 1)])
}

const unavailable_message =
  "A source this request depends on is temporarily unavailable. Try again shortly."

fn outcome(rule: Rule) -> Outcome {
  case rule.kind {
    Delay -> Pause(option.unwrap(rule.arg, 1000))
    Unavailable -> Fail(0, 503, "SOURCE_UNAVAILABLE", True, unavailable_message)
    Timeout ->
      Fail(
        option.unwrap(rule.arg, 3000),
        504,
        "SOURCE_TIMEOUT",
        True,
        "A source this request depends on did not answer in time. Try again shortly.",
      )
    Retryable ->
      case rule.hits <= option.unwrap(rule.arg, 1) {
        True -> Fail(0, 503, "SOURCE_UNAVAILABLE", True, unavailable_message)
        False -> Pass
      }
    Fatal ->
      Fail(
        0,
        500,
        "INTERNAL",
        False,
        "Something went wrong handling that request.",
      )
    Internal -> Pass
  }
}

/// Whether the named step inside a unit fails now; every call is counted as a hit.
pub fn should_fail(faults: Faults, step: String) -> Bool {
  case faults.enabled {
    False -> False
    True ->
      table.update(faults.rules, key, fn(entry) {
        let rules = option.unwrap(entry, [])
        case
          list.find(rules, fn(r) { r.kind == Internal && r.pattern == step })
        {
          Error(Nil) -> #(entry, False)
          Ok(found) -> {
            let hit = Rule(..found, hits: found.hits + 1)
            #(
              Some(replace(rules, found, hit)),
              hit.hits <= option.unwrap(found.arg, 1),
            )
          }
        }
      })
  }
}

/// Replaces the rules (`POST /__faults`).
pub fn replace_all(faults: Faults, spec: String) -> Result(List(Rule), String) {
  use rules <- result.map(parse(spec))
  set(faults, rules)
  rules
}

pub fn rule_json(rule: Rule, with_hits: Bool) -> json.Json {
  json.object(
    list.flatten([
      [
        #("kind", json.string(kind_name(rule.kind))),
        #("pattern", json.string(rule.pattern)),
        #("arg", json.nullable(rule.arg, json.int)),
      ],
      case with_hits {
        True -> [#("hits", json.int(rule.hits))]
        False -> []
      },
    ]),
  )
}

/// Waits `ms` in the request's own process.
pub fn pause(ms: Int) -> Nil {
  process.sleep(ms)
}
