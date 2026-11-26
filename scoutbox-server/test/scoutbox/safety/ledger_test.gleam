//// The ledger's and the ops events' detail: the keys each type carries equal the TypeScript server's tables
//// (`spec/repositories/safetyAudit.json`), a detailed type can't be written as `Plain`, and an event's detail reads
//// back as the TypeScript server writes it.

import gleam/dict
import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleam/string
import scoutbox/platform/store
import scoutbox/rows/box_cam_prefs as prefs_row
import scoutbox/rows/id
import scoutbox/rows/ledger as ledger_row
import scoutbox/rows/ops_events as ops_row
import scoutbox/safety/audit
import scoutbox/safety/ledger
import scoutbox/support
import scoutbox/vocab/box_target_type
import scoutbox/vocab/party
import simplifile

fn snapshot(table: String) -> dict.Dict(String, List(String)) {
  let assert Ok(text) =
    simplifile.read("e2e/support/spec/repositories/safetyAudit.json")
  let assert Ok(value) =
    json.parse(
      text,
      decode.at([table], decode.dict(decode.string, decode.list(decode.string))),
    )
  value
}

fn declared(
  pairs: List(#(String, a)),
  keys: fn(a) -> List(String),
) -> dict.Dict(String, List(String)) {
  pairs
  |> list.filter_map(fn(p) {
    case keys(p.1) {
      [] -> Error(Nil)
      ks -> Ok(#(p.0, ks))
    }
  })
  |> dict.from_list
}

pub fn ledger_detail_keys_equal_the_snapshot_test() {
  assert declared(ledger_row.type_pairs, ledger.detail_keys)
    == snapshot("LEDGER_DETAIL")
}

pub fn ops_detail_keys_equal_the_snapshot_test() {
  assert declared(ops_row.kind_pairs, audit.ops_detail_keys)
    == snapshot("OPS_DETAIL")
}

pub fn plain_is_refused_for_a_detailed_type_test() {
  assert ledger.plain_problem(ledger_row.BoxClipSaved)
    == Some(
      "ledger.append was given Plain(ledger_row.BoxClipSaved), but a box_clip_saved row carries a detail (sessionId, mediaId). Build the entry with ledger.BoxClipSaved(…) instead, so its detail is written and the row reads back as the TypeScript server's does.",
    )
  assert ledger.plain_problem(ledger_row.View) == None
}

/// Every type with a detail is refused as `Plain`, and names a constructor that writes it as that type.
pub fn every_detailed_type_has_its_constructor_test() {
  let detailed =
    list.filter(ledger_row.type_pairs, fn(p) { ledger.detail_keys(p.1) != [] })
  assert list.length(detailed) == 17
  list.each(detailed, fn(p) {
    let assert Some(problem) = ledger.plain_problem(p.1)
    assert string.contains(problem, p.0)
  })
}

fn detail_text(event: ledger.Event) -> String {
  let s = support.fresh_store(fn(_) { Nil })
  let assert Ok(_) =
    store.unit(s, fn(tx) {
      ledger.append(
        tx,
        ledger.Entry(
          event:,
          player_id: Some(id.player("pl-adeyemi")),
          org_id: None,
          org_name: None,
          user_id: None,
          actor_name: None,
        ),
        1000,
      )
    })
  let assert Ok(rows) =
    store.read(s, ledger.for_player(_, id.player("pl-adeyemi")))
  let assert Ok(last) = list.last(rows)
  let text = ledger.view(last) |> json.to_string
  let assert [_, detail] = string.split(text, "\"detail\":")
  string.drop_end(detail, 1)
}

pub fn a_detail_is_written_in_the_typescript_order_test() {
  assert detail_text(ledger.Plain(ledger_row.View)) == "null"
  assert detail_text(ledger.PassportRecruitmentView(through_share: False))
    == "null"
  assert detail_text(ledger.PassportRecruitmentView(through_share: True))
    == "{\"via\":\"share\"}"
  assert detail_text(ledger.BoxAssignmentCreated(
      "box-wall",
      box_target_type.Repetitions,
      150.0,
    ))
    == "{\"drillId\":\"box-wall\",\"target\":{\"type\":\"repetitions\",\"value\":150}}"
  assert detail_text(
      ledger.CombineRequestCreated(id.combine_request("cmbr-9"), [
        "combine-box-footwork",
        "combine-box-control-60",
      ]),
    )
    == "{\"requestId\":\"cmbr-9\",\"protocols\":[\"combine-box-footwork\",\"combine-box-control-60\"]}"
  assert detail_text(ledger.BoxPrefsChanged(
      party.Guardian,
      prefs_row.Private,
      True,
    ))
    == "{\"by\":\"guardian\",\"share\":\"private\",\"retainClips\":true}"
}
