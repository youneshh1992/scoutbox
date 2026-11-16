//// Trials (`trials`, repositories/recruitment.ts), as far as a Recruitment Room reads them: which trials of a
//// player an organisation runs, whether each has a report, and which players have a trial in a status.
////
//// Not ported yet: the trials domain itself (requests, scheduling, sessions, attendance, evidence, reports,
//// trial day). No route here creates a trial, so `GET /org/trials` answers an empty page until it is ported.

import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/option.{type Option}
import gleam/result
import scoutbox/platform/http
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/rows/id
import scoutbox/rows/trials as row
import sqlight
import wisp.{type Response}

pub type Trial {
  Trial(row: row.Row, has_report: Bool)
}

fn reported(read: Read, rows: List(row.Row)) -> Result(List(Trial), Fail(e)) {
  list.try_map(rows, fn(r) {
    use found <- result.map(store.query(
      read,
      "SELECT 1 FROM trial_reports WHERE trial_id = ?",
      [id.trial_sql(r.id)],
      decode.at([0], decode.int),
    ))
    Trial(r, found != [])
  })
}

pub fn for_org_player(
  read: Read,
  org_id: id.OrgId,
  player_id: id.PlayerId,
) -> Result(List(Trial), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> row.columns
      <> " FROM trials WHERE org_id = ? AND player_id = ? ORDER BY rowid",
    [id.org_sql(org_id), id.player_sql(player_id)],
    row.decoder(),
  ))
  reported(read, rows)
}

pub fn by_id(
  read: Read,
  trial_id: id.TrialId,
) -> Result(Option(row.Row), Fail(e)) {
  store.one(
    read,
    "SELECT " <> row.columns <> " FROM trials WHERE id = ?",
    [id.trial_sql(trial_id)],
    row.decoder(),
  )
  |> result.map(option.from_result)
}

/// The players with a trial of the organisation's in `status`.
pub fn players_with_status(
  read: Read,
  org_id: id.OrgId,
  status: row.Status,
) -> Result(List(id.PlayerId), Fail(e)) {
  store.query(
    read,
    "SELECT DISTINCT player_id FROM trials WHERE org_id = ? AND status = ?",
    [id.org_sql(org_id), sqlight.text(row.status_to_string(status))],
    decode.at([0], id.player_decoder()),
  )
}

/// `GET /org/trials`. Not ported yet: the trial records' view and their paging; no route here creates one.
pub fn org_page() -> Response {
  http.json(
    200,
    json.object([
      #("items", json.preprocessed_array([])),
      #("nextCursor", json.null()),
    ]),
  )
}
