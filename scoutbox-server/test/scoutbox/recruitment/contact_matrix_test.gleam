//// The contact validator (contact_rules.can_act) gives the blessed answer on every input in
//// test/fixtures/contact_matrix.json (first blessed from the TypeScript canContactAction): every contact status ×
//// action × role. The club's actions (edit, send, cancel) are compared whole, as JSON text.
////
//// `respond` is the recipient's act. The recipient's answer moves a contact only in a state that
//// contact_rules.accepts_response allows, and leaves any other alone rather than refusing. So its rows bless only
//// whether the answer moves the contact, and to what.
////
//// The recorded calls Gleam's types can't hold are refused before the validator: a contact's status is a typed
//// column (its vocabulary is generated from the migration's CHECK, so text outside it neither decodes nor is
//// stored), each route names its own action, and a Room role is decided from membership, never read from text
//// (see case_lifecycle_test).

import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/battery/base
import scoutbox/blessed
import scoutbox/recruitment/contact_rules
import scoutbox/recruitment/room_rules.{
  Contributor, RecruitmentAdmin, RoomLead, Viewer,
}
import scoutbox/rows/recruitment_contacts as row

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

pub fn the_axes_are_blessed_test() {
  let f = blessed.load("contact_matrix")
  let at = fn(name) { blessed.field(blessed.root(f), name) }
  [
    blessed.answer(
      at("statuses"),
      "statuses",
      json.array(row.status_pairs, fn(p) { json.string(p.0) }),
    ),
    blessed.answer(
      at("actions"),
      "actions",
      json.array(["edit", "send", "cancel", "respond"], json.string),
    ),
    blessed.answer(
      at("roles"),
      "roles",
      json.array(roles, fn(r) {
        json.nullable(option.map(r, room_rules.role_code), json.string)
      }),
    ),
  ]
  |> blessed.check(f, _)
}

/// The club's actions, and the recipient's response, all under `answers`.
pub fn can_act_is_blessed_test() {
  let f = blessed.load("contact_matrix")
  let answers = blessed.table(blessed.field(blessed.root(f), "answers"))
  let club = {
    use status <- list.flat_map(statuses())
    use #(name, action) <- list.flat_map(actions)
    use role <- list.map(roles)
    let c = base.contact()
    let c = contact_rules.Contact(..c, row: row.Row(..c.row, status:))
    blessed.entry(
      answers,
      key(status, name, role),
      json.string(verdict_json(contact_rules.can_act(c, action, role))),
    )
  }
  let respond = {
    use status <- list.flat_map(statuses())
    use role <- list.map(roles)
    let outcome = case contact_rules.accepts_response(status) {
      True ->
        json.object([
          #("ok", json.bool(True)),
          #("to", row.status_to_json(row.Responded)),
        ])
      False -> json.object([#("ok", json.bool(False)), #("to", json.null())])
    }
    blessed.entry(
      answers,
      key(status, "respond", role),
      json.string(json.to_string(outcome)),
    )
  }
  blessed.check(f, list.append(club, respond))
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
