//// The next action (journey_model.pick and finish) gives the blessed answer on every input in
//// test/fixtures/next_action_matrix.json (first blessed from the TypeScript nextActionFor). journey_model.next_action
//// is finish(pick(…)), so each half is checked over its own matrix:
////
//// - pick: every status with every combination of the facts it reads, and with every value of each other fact,
////   one at a time. The code and the resources are compared, as JSON.
//// - finish: every code × no role and every Room role × blocked × subject removed × integrity error. The envelope
////   is compared whole, as JSON.
////
//// The inputs are frozen in the fixture: each row's numbers index its axes (`statuses`, `values`, `codes`, `roles`)
//// and its last number is its answer's index in `results` or `finishResults`. The axes are inputs, so a new status
//// or fact value needs rows written for it; the_matrix_covers_what_this_server_has_test says when.

import gleam/dict.{type Dict}
import gleam/dynamic/decode.{type Dynamic}
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/string
import scoutbox/blessed
import scoutbox/recruitment/journey_model.{
  NextContact, NextFacts, NextOffer, NextSigning, NextTrial,
}
import scoutbox/recruitment/room_rules.{
  Contributor, RecruitmentAdmin, RoomLead, Viewer,
}
import scoutbox/recruitment/signing_rules
import scoutbox/rows/id
import scoutbox/rows/recruitment_contacts as contact_row
import scoutbox/vocab/offer_status
import scoutbox/vocab/room_status.{type RoomStatus}
import simplifile

type Matrix {
  Matrix(
    now: Int,
    statuses: List(String),
    dims: List(String),
    values: Dict(String, List(Dynamic)),
    codes: List(String),
    roles: List(Option(String)),
  )
}

fn matrix() -> Matrix {
  let assert Ok(text) = simplifile.read("test/fixtures/next_action_matrix.json")
  let decoder = {
    use now <- decode.field("now", decode.int)
    use statuses <- decode.field("statuses", decode.list(decode.string))
    use dims <- decode.field("dims", decode.list(decode.string))
    use values <- decode.field(
      "values",
      decode.dict(decode.string, decode.list(decode.dynamic)),
    )
    use codes <- decode.field("codes", decode.list(decode.string))
    use roles <- decode.field(
      "roles",
      decode.list(decode.optional(decode.string)),
    )
    decode.success(Matrix(now:, statuses:, dims:, values:, codes:, roles:))
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

fn statuses() -> List(RoomStatus) {
  list.map(room_status.pairs, fn(p) { p.1 })
}

/// The value at `i` of fact `dim`, read with `decoder`.
fn value(m: Matrix, dim: String, i: Int, decoder: decode.Decoder(a)) -> a {
  let assert Ok(values) = dict.get(m.values, dim)
  let assert Ok(v) = list.drop(values, i) |> list.first
  let assert Ok(a) = decode.run(v, decoder)
  a
}

fn offer_status_decoder() -> decode.Decoder(offer_status.OfferStatus) {
  use text <- decode.then(decode.string)
  case offer_status.from_string(text) {
    Ok(s) -> decode.success(s)
    Error(Nil) -> decode.failure(offer_status.Draft, "an Offer status")
  }
}

fn signing_status_decoder() -> decode.Decoder(signing_rules.Status) {
  use text <- decode.then(decode.string)
  case
    list.find(signing_rules.statuses, fn(s) {
      signing_rules.status_name(s) == text
    })
  {
    Ok(s) -> decode.success(s)
    Error(Nil) -> decode.failure(signing_rules.Draft, "a signing status")
  }
}

fn contact_status_decoder() -> decode.Decoder(contact_row.Status) {
  use text <- decode.then(decode.string)
  case list.key_find(contact_row.status_pairs, text) {
    Ok(s) -> decode.success(s)
    Error(Nil) -> decode.failure(contact_row.Draft, "a contact status")
  }
}

/// The row's facts, as the generator built the TypeScript records: one id per kind of record.
fn facts(m: Matrix, row: List(Int)) -> journey_model.NextFacts {
  let assert [
    assessed,
    decision,
    contact,
    trial,
    request,
    offer,
    signing,
    signing_row,
  ] = row
  let ends = fn(class) {
    case class {
      "no_sessions" -> 0
      "ended" -> m.now - 1
      "ends_now" -> m.now
      _ -> m.now + 1
    }
  }
  NextFacts(
    assessed: value(m, "assessed", assessed, decode.bool),
    decision: value(m, "decision", decision, decode.optional(decode.string))
      |> option.map(id.room_decision),
    contact: value(
      m,
      "contact",
      contact,
      decode.optional(contact_status_decoder()),
    )
      |> option.map(NextContact(id.contact("rct-m"), _)),
    trial: value(m, "trial", trial, decode.optional(decode.string))
      |> option.map(fn(class) { NextTrial(id.trial("trl-m"), ends(class)) }),
    trial_request: value(m, "request", request, decode.optional(decode.string))
      |> option.map(id.request),
    offer: value(
      m,
      "offer",
      offer,
      decode.optional({
        use status <- decode.field(0, decode.optional(offer_status_decoder()))
        use live <- decode.field(1, decode.optional(offer_status_decoder()))
        use revision <- decode.field(2, decode.bool)
        decode.success(NextOffer(
          id: id.offer("rof-m"),
          revision: case revision {
            True -> Some(id.offer_revision("rrev-m"))
            False -> None
          },
          status:,
          live_status: live,
        ))
      }),
    ),
    signing: value(
      m,
      "signing",
      signing,
      decode.optional({
        use status <- decode.field(0, signing_status_decoder())
        use club <- decode.field(1, decode.bool)
        use others <- decode.field(2, decode.bool)
        use done <- decode.field(3, decode.bool)
        decode.success(
          NextSigning(
            id: id.signing_package("spk-m"),
            status:,
            club_pending: club,
            others_pending: others,
            completed_signing: case done {
              True -> Some(id.signing("sg-m"))
              False -> None
            },
          ),
        )
      }),
    ),
    signing_row: value(
      m,
      "signingRow",
      signing_row,
      decode.optional(decode.string),
    )
      |> option.map(id.signing),
  )
}

fn at(items: List(a), i: Int) -> a {
  let assert Ok(x) = list.drop(items, i) |> list.first
  x
}

fn row_text(row: List(Int)) -> String {
  string.join(list.map(row, int.to_string), " ")
}

pub fn the_matrix_covers_what_this_server_has_test() {
  let m = matrix()
  assert m.statuses == list.map(room_status.pairs, fn(p) { p.0 })
  assert m.dims
    == [
      "assessed", "decision", "contact", "trial", "request", "offer", "signing",
      "signingRow",
    ]
  assert m.roles == list.map(roles, option.map(_, room_rules.role_code))
  // Every package status a stored package can read as (SUPERSEDED belongs to revisions only).
  let assert Ok(signings) = dict.get(m.values, "signing")
  assert list.length(signings) == 1 + 7 * 8
}

fn rows(f: blessed.Fixture, name: String) -> List(#(List(Int), blessed.Item)) {
  blessed.items(blessed.field(blessed.root(f), name))
  |> list.map(fn(item) { #(blessed.read(item, decode.list(decode.int)), item) })
}

pub fn pick_is_blessed_test() {
  let f = blessed.load("next_action_matrix")
  let m = matrix()
  let results = blessed.pool(blessed.field(blessed.root(f), "results"))
  list.map(rows(f, "pick"), fn(r) {
    let #(row, item) = r
    let assert [status, ..rest] = row
    let facts_row = list.take(rest, 8)
    let status = at(statuses(), status)
    let #(code, refs) = journey_model.pick(status, facts(m, facts_row), m.now)
    blessed.answer(
      blessed.index(item, 9),
      room_status.to_string(status) <> " " <> row_text(facts_row),
      json.string(
        json.to_string(
          json.object([
            #("code", json.string(code)),
            #("resources", json.object(refs)),
          ]),
        ),
      ),
    )
    |> blessed.interned(results)
  })
  |> blessed.check(f, _)
}

pub fn finish_is_blessed_test() {
  let f = blessed.load("next_action_matrix")
  let m = matrix()
  let results = blessed.pool(blessed.field(blessed.root(f), "finishResults"))
  list.map(rows(f, "finish"), fn(r) {
    let #(row, item) = r
    let assert [code, role, blocked, removed, integrity, _] = row
    blessed.answer(
      blessed.index(item, 5),
      row_text(list.take(row, 5)),
      journey_model.finish(
        at(m.codes, code),
        [],
        at(roles, role),
        blocked == 1,
        removed == 1,
        integrity == 1,
      )
        |> json.to_string
        |> json.string,
    )
    |> blessed.interned(results)
  })
  |> blessed.check(f, _)
}
