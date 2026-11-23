//// The lifecycle validator (case_lifecycle.check and available) agrees with the TypeScript one
//// (canTransitionRecruitmentCase and availableActions) on every input in test/fixtures/lifecycle_matrix.json,
//// written by `node dev/lifecycle_cases.mjs`: every status × action × role × mode × evidence, and for resumeCase
//// every state the case was held from. Each answer is compared whole, as JSON: the code, the message, and the
//// allowed moves or the evidence asked for.

import gleam/dict.{type Dict}
import gleam/dynamic/decode
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/string
import scoutbox/battery/base
import scoutbox/recruitment/case_lifecycle
import scoutbox/recruitment/lifecycle
import scoutbox/recruitment/room_rules.{
  Contributor, RecruitmentAdmin, RoomLead, Viewer,
}
import scoutbox/vocab/room_status.{type RoomStatus}
import simplifile

type Matrix {
  Matrix(
    statuses: List(String),
    actions: List(String),
    roles: List(Option(String)),
    modes: List(String),
    evidence: List(String),
    held: List(Option(String)),
    results: Dict(Int, String),
    check: Dict(String, List(Int)),
    available: List(Int),
  )
}

fn matrix() -> Matrix {
  let assert Ok(text) = simplifile.read("test/fixtures/lifecycle_matrix.json")
  let decoder = {
    use statuses <- decode.field("statuses", decode.list(decode.string))
    use actions <- decode.field("actions", decode.list(decode.string))
    use roles <- decode.field(
      "roles",
      decode.list(decode.optional(decode.string)),
    )
    use modes <- decode.field("modes", decode.list(decode.string))
    use evidence <- decode.field("evidence", decode.list(decode.string))
    use held <- decode.field(
      "held",
      decode.list(decode.optional(decode.string)),
    )
    use results <- decode.field("results", decode.list(decode.string))
    use check <- decode.field(
      "check",
      decode.dict(decode.string, decode.list(decode.int)),
    )
    use available <- decode.field("available", decode.list(decode.int))
    decode.success(Matrix(
      statuses:,
      actions:,
      roles:,
      modes:,
      evidence:,
      held:,
      results: list.index_map(results, fn(r, i) { #(i, r) }) |> dict.from_list,
      check:,
      available:,
    ))
  }
  let assert Ok(m) = json.parse(text, decoder)
  m
}

const roles = [
  None,
  Some(Viewer),
  Some(Contributor),
  Some(RoomLead),
  Some(RecruitmentAdmin),
]

/// How the validator is asked: performed with a reason, performed without one, or for availability.
const modes = [
  #("reasons", ["club_decision"], False),
  #("none", [], False),
  #("available", [], True),
]

fn statuses() -> List(RoomStatus) {
  list.map(room_status.pairs, fn(p) { p.1 })
}

fn held() -> List(Option(RoomStatus)) {
  [None, ..list.map(statuses(), Some)]
}

/// A provider that holds every kind of record, or the TypeScript default, which holds none.
fn providers() -> List(#(String, case_lifecycle.Provider(Nil))) {
  [
    #("holds", fn(_) { Ok(case_lifecycle.Holds("fixture", "rec-m")) }),
    #("lacks", fn(_) { Ok(case_lifecycle.Lacks("not_implemented")) }),
  ]
}

fn room(status: RoomStatus, held: Option(RoomStatus)) {
  case held {
    None -> base.room(status, [])
    Some(from) ->
      base.room(status, [
        #(
          "room_status_changed",
          json.to_string(
            json.object([
              #("from", room_status.to_json(from)),
              #("to", json.string("on_hold")),
            ]),
          ),
        ),
      ])
  }
}

fn role_text(role: Option(room_rules.RoomRole)) -> String {
  option.map(role, room_rules.role_code) |> option.unwrap("none")
}

fn held_text(held: Option(RoomStatus)) -> String {
  option.map(held, room_status.to_string) |> option.unwrap("none")
}

/// Each answer that differs from the fixture's, described.
fn compare(
  m: Matrix,
  inputs: List(#(String, fn() -> String)),
  indexes: List(Int),
) -> List(String) {
  assert list.length(inputs) == list.length(indexes)
  list.zip(inputs, indexes)
  |> list.filter_map(fn(pair) {
    let #(#(what, answer), i) = pair
    let assert Ok(expected) = dict.get(m.results, i)
    let actual = answer()
    case actual == expected {
      True -> Error(Nil)
      False ->
        Ok(what <> "\n    expected " <> expected <> "\n    got      " <> actual)
    }
  })
}

fn report(mismatches: List(String)) -> Nil {
  case mismatches {
    [] -> Nil
    _ ->
      panic as {
        int.to_string(list.length(mismatches))
        <> " answers differ from the TypeScript validator:\n  "
        <> string.join(list.take(mismatches, 20), "\n  ")
      }
  }
}

pub fn the_matrix_covers_what_this_server_has_test() {
  let m = matrix()
  assert m.statuses == list.map(room_status.pairs, fn(p) { p.0 })
  assert m.actions == list.map(lifecycle.actions, fn(a) { a.name })
  assert m.roles == list.map(roles, option.map(_, room_rules.role_code))
  assert m.modes == list.map(modes, fn(x) { x.0 })
  assert m.evidence == list.map(providers(), fn(p) { p.0 })
  assert m.held == list.map(held(), option.map(_, room_status.to_string))
  assert dict.keys(m.check) |> list.sort(string.compare)
    == list.sort(m.actions, string.compare)
}

pub fn check_agrees_with_the_typescript_validator_test() {
  let m = matrix()
  list.flat_map(lifecycle.actions, fn(action) {
    let held = case action.name {
      "resumeCase" -> held()
      _ -> [None]
    }
    let inputs = {
      use h <- list.flat_map(held)
      use status <- list.flat_map(statuses())
      use role <- list.flat_map(roles)
      use #(mode, reasons, for_availability) <- list.flat_map(modes)
      use #(ev, provider) <- list.map(providers())
      let what =
        string.join(
          [
            action.name,
            room_status.to_string(status),
            role_text(role),
            mode,
            ev,
            "held from " <> held_text(h),
          ],
          " / ",
        )
      #(what, fn() {
        let assert Ok(verdict) =
          case_lifecycle.check(
            room(status, h),
            action,
            role,
            reasons,
            for_availability,
            provider,
          )
        json.to_string(case_lifecycle.verdict_json(verdict))
      })
    }
    let assert Ok(indexes) = dict.get(m.check, action.name)
    compare(m, inputs, indexes)
  })
  |> report
}

pub fn available_agrees_with_the_typescript_validator_test() {
  let m = matrix()
  let inputs = {
    use h <- list.flat_map(held())
    use status <- list.flat_map(statuses())
    use role <- list.flat_map(roles)
    use #(ev, provider) <- list.map(providers())
    let what =
      string.join(
        [
          room_status.to_string(status),
          role_text(role),
          ev,
          "held from " <> held_text(h),
        ],
        " / ",
      )
    #(what, fn() {
      let assert Ok(names) =
        case_lifecycle.available(room(status, h), role, provider)
      json.to_string(json.array(names, json.string))
    })
  }
  compare(m, inputs, m.available) |> report
}
