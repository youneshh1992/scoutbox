//// The lifecycle validator (case_lifecycle.check and available) gives the blessed answer on every input in
//// test/fixtures/lifecycle_matrix.json (first blessed from the TypeScript canTransitionRecruitmentCase and
//// availableActions): every status × action × role × mode × evidence, and for resumeCase every state the case was
//// held from. Each answer is compared whole, as JSON text: the code, the message, and the allowed moves or the
//// evidence asked for. The inputs are this server's vocabularies, so a new status or action gains its rows at the
//// next bless; the axes are blessed too, so the change shows.

import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/string
import scoutbox/battery/base
import scoutbox/blessed
import scoutbox/recruitment/case_lifecycle
import scoutbox/recruitment/lifecycle
import scoutbox/recruitment/room_rules.{
  Contributor, RecruitmentAdmin, RoomLead, Viewer,
}
import scoutbox/vocab/room_status.{type RoomStatus}

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

fn strings(items: List(String)) -> json.Json {
  json.array(items, json.string)
}

fn nullable_strings(items: List(Option(String))) -> json.Json {
  json.array(items, json.nullable(_, json.string))
}

pub fn the_axes_are_blessed_test() {
  let f = blessed.load("lifecycle_matrix")
  let at = fn(name) { blessed.field(blessed.root(f), name) }
  [
    blessed.answer(
      at("statuses"),
      "statuses",
      strings(list.map(room_status.pairs, fn(p) { p.0 })),
    ),
    blessed.answer(
      at("actions"),
      "actions",
      strings(list.map(lifecycle.actions, fn(a) { a.name })),
    ),
    blessed.answer(
      at("roles"),
      "roles",
      nullable_strings(list.map(roles, option.map(_, room_rules.role_code))),
    ),
    blessed.answer(
      at("modes"),
      "modes",
      strings(list.map(modes, fn(x) { x.0 })),
    ),
    blessed.answer(
      at("evidence"),
      "evidence",
      strings(list.map(providers(), fn(p) { p.0 })),
    ),
    blessed.answer(
      at("held"),
      "held",
      nullable_strings(list.map(held(), option.map(_, room_status.to_string))),
    ),
  ]
  |> blessed.check(f, _)
}

pub fn check_is_blessed_test() {
  let f = blessed.load("lifecycle_matrix")
  let results = blessed.pool(blessed.field(blessed.root(f), "results"))
  let answers = blessed.table(blessed.field(blessed.root(f), "check"))
  {
    use action <- list.flat_map(lifecycle.actions)
    let held = case action.name {
      "resumeCase" -> held()
      _ -> [None]
    }
    use h <- list.flat_map(held)
    use status <- list.flat_map(statuses())
    use role <- list.flat_map(roles)
    use #(mode, reasons, for_availability) <- list.flat_map(modes)
    use #(ev, provider) <- list.map(providers())
    let key =
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
    let assert Ok(verdict) =
      case_lifecycle.check(
        room(status, h),
        action,
        role,
        reasons,
        for_availability,
        provider,
      )
    blessed.entry(
      answers,
      key,
      json.string(json.to_string(case_lifecycle.verdict_json(verdict))),
    )
    |> blessed.interned(results)
  }
  |> blessed.check(f, _)
}

pub fn available_is_blessed_test() {
  let f = blessed.load("lifecycle_matrix")
  let results = blessed.pool(blessed.field(blessed.root(f), "results"))
  let answers = blessed.table(blessed.field(blessed.root(f), "available"))
  {
    use h <- list.flat_map(held())
    use status <- list.flat_map(statuses())
    use role <- list.flat_map(roles)
    use #(ev, provider) <- list.map(providers())
    let key =
      string.join(
        [
          room_status.to_string(status),
          role_text(role),
          ev,
          "held from " <> held_text(h),
        ],
        " / ",
      )
    let assert Ok(names) =
      case_lifecycle.available(room(status, h), role, provider)
    blessed.entry(answers, key, json.string(json.to_string(strings(names))))
    |> blessed.interned(results)
  }
  |> blessed.check(f, _)
}
