//// The contact validator (contact_rules.can_act) agrees with the TypeScript one (canContactAction) on every input
//// in test/fixtures/contact_matrix.json, written by `node dev/matrix_cases.mjs`: every contact status × action ×
//// role. The club's actions (edit, send, cancel) are compared whole, as JSON.
////
//// `respond` is the recipient's act. No TypeScript route asks canContactAction about it (it is listed so the
//// transition graph is total); here the recipient's answer moves a contact only in a state that
//// contact_rules.accepts_response allows, and leaves any other alone rather than refusing. So its rows are
//// compared on whether the answer moves the contact, and to what.
////
//// The recorded calls Gleam's types can't hold are refused before the validator: a contact's status is a typed
//// column (its vocabulary is generated from the migration's CHECK, so text outside it neither decodes nor is
//// stored), each route names its own action, and a Room role is decided from membership, never read from text
//// (see case_lifecycle_test).

import gleam/dict.{type Dict}
import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/battery/base
import scoutbox/matrix
import scoutbox/recruitment/contact_rules
import scoutbox/recruitment/room_rules.{
  Contributor, RecruitmentAdmin, RoomLead, Viewer,
}
import scoutbox/rows/recruitment_contacts as row
import simplifile

type Fixture {
  Fixture(
    statuses: List(String),
    actions: List(String),
    roles: List(Option(String)),
    answers: Dict(String, String),
  )
}

fn fixture() -> Fixture {
  let assert Ok(text) = simplifile.read("test/fixtures/contact_matrix.json")
  let assert Ok(f) =
    json.parse(text, {
      use statuses <- decode.field("statuses", decode.list(decode.string))
      use actions <- decode.field("actions", decode.list(decode.string))
      use roles <- decode.field(
        "roles",
        decode.list(decode.optional(decode.string)),
      )
      use answers <- decode.field(
        "answers",
        decode.dict(decode.string, decode.string),
      )
      decode.success(Fixture(statuses:, actions:, roles:, answers:))
    })
  f
}

const roles = [
  None,
  Some(Viewer),
  Some(Contributor),
  Some(RoomLead),
  Some(RecruitmentAdmin),
]

const actions = [
  #("edit", contact_rules.Edit),
  #("send", contact_rules.Send),
  #("cancel", contact_rules.Cancel),
]

fn statuses() -> List(row.Status) {
  list.map(row.status_pairs, fn(p) { p.1 })
}

fn key(status: row.Status, action: String, role: Option(room_rules.RoomRole)) {
  row.status_to_string(status)
  <> " "
  <> action
  <> " "
  <> option.map(role, room_rules.role_code) |> option.unwrap("none")
}

fn expected(f: Fixture, key: String) -> String {
  let assert Ok(answer) = dict.get(f.answers, key)
  answer
}

/// An answer as `{ok, to}` only: whether it moves the contact, and to what.
fn outcome(answer: String) -> String {
  let assert Ok(#(ok, to)) =
    json.parse(answer, {
      use ok <- decode.field("ok", decode.bool)
      use to <- decode.optional_field(
        "to",
        None,
        decode.optional(decode.string),
      )
      decode.success(#(ok, to))
    })
  json.to_string(
    json.object([
      #("ok", json.bool(ok)),
      #("to", json.nullable(to, json.string)),
    ]),
  )
}

fn verdict_json(verdict: Result(row.Status, contact_rules.Refusal)) -> String {
  json.to_string(case verdict {
    Ok(to) ->
      json.object([#("ok", json.bool(True)), #("to", row.status_to_json(to))])
    Error(r) ->
      json.object([
        #("ok", json.bool(False)),
        #("error", json.string(r.error)),
        #("message", json.string(r.message)),
        ..r.fields
      ])
  })
}

pub fn the_matrix_covers_what_this_server_has_test() {
  let f = fixture()
  assert f.statuses == list.map(row.status_pairs, fn(p) { p.0 })
  assert f.actions == ["edit", "send", "cancel", "respond"]
  assert f.roles == list.map(roles, option.map(_, room_rules.role_code))
  assert dict.size(f.answers)
    == list.length(f.statuses) * list.length(f.actions) * list.length(f.roles)
}

pub fn can_act_agrees_with_can_contact_action_test() {
  let f = fixture()
  {
    use status <- list.flat_map(statuses())
    use #(name, action) <- list.flat_map(actions)
    use role <- list.map(roles)
    let k = key(status, name, role)
    let c = base.contact()
    let c = contact_rules.Contact(..c, row: row.Row(..c.row, status:))
    matrix.Row(what: k, expected: expected(f, k), actual: fn() {
      verdict_json(contact_rules.can_act(c, action, role))
    })
  }
  |> matrix.check("canContactAction")
}

pub fn a_response_moves_a_contact_as_can_contact_action_says_test() {
  let f = fixture()
  {
    use status <- list.flat_map(statuses())
    use role <- list.map(roles)
    let k = key(status, "respond", role)
    matrix.Row(what: k, expected: outcome(expected(f, k)), actual: fn() {
      outcome(case contact_rules.accepts_response(status) {
        True -> verdict_json(Ok(row.Responded))
        False -> "{\"ok\":false}"
      })
    })
  }
  |> matrix.check("canContactAction's respond")
}

pub fn text_that_is_not_a_contact_status_does_not_decode_as_one_test() {
  list.each(
    ["__proto__", "constructor", "hasOwnProperty", "prototype", "toString", ""],
    fn(text) {
      assert json.parse(json.to_string(json.string(text)), row.status_decoder())
        |> result.is_error
    },
  )
}
