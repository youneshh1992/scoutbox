//// Signings (`signings`, repositories/signingsFollowUps.ts), as far as a Recruitment Room reads them: whether a
//// signing belongs to the organisation and the player, so a Room can link it.
////
//// Not ported yet: the signings domain (packages, documents, parties, completion). No route here creates a signing,
//// so `GET /org/signings` answers an empty page until it is ported.

import gleam/json
import gleam/option.{type Option}
import gleam/result
import scoutbox/platform/http
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/rows/id
import scoutbox/rows/signings as row
import wisp.{type Response}

pub fn by_id(
  read: Read,
  signing_id: id.SigningId,
) -> Result(Option(row.Row), Fail(e)) {
  store.one(
    read,
    "SELECT " <> row.columns <> " FROM signings WHERE id = ?",
    [id.signing_sql(signing_id)],
    row.decoder(),
  )
  |> result.map(option.from_result)
}

/// `GET /org/signings`. Not ported yet: the signing records' view and their paging; no route here creates one.
pub fn org_page() -> Response {
  http.json(
    200,
    json.object([
      #("items", json.preprocessed_array([])),
      #("nextCursor", json.null()),
    ]),
  )
}
