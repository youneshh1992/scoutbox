//// Signings (`signings`, repositories/signingsFollowUps.ts), as far as a Recruitment Room reads them: whether a
//// signing belongs to the organisation and the player, so a Room can link it.
////
//// `GET /org/signings` lists the records as stored.
////
//// Not ported yet: the signings domain (packages, documents, parties, completion); no route here creates one.

import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/platform/http
import scoutbox/platform/pages
import scoutbox/platform/paging.{IntKind}
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/rows/id
import scoutbox/rows/signing_parties as party_row
import scoutbox/rows/signings as row
import scoutbox/vocab/recruitment_actor_kind
import scoutbox/vocab/signing_method
import scoutbox/vocab/signing_party_type
import sqlight
import wisp.{type Request, type Response}

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

fn parties(
  read: Read,
  signing_id: id.SigningId,
) -> Result(List(party_row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> party_row.columns
      <> " FROM signing_parties WHERE signing_id = ? ORDER BY position",
    [id.signing_sql(signing_id)],
    party_row.decoder(),
  )
}

/// A signing as the repository decodes it.
fn record_json(s: row.Row, parties: List(party_row.Row)) -> Json {
  let opt = json.nullable(_, json.string)
  json.object([
    #("id", id.signing_json(s.id)),
    #("playerId", id.player_json(s.player_id)),
    #("playerName", opt(s.player_name)),
    #("orgId", id.org_json(s.org_id)),
    #("orgName", opt(s.org_name)),
    #("userId", json.nullable(s.user_id, id.org_user_json)),
    #("scoutName", opt(s.scout_name)),
    #("ts", json.int(s.ts)),
    #("signedAt", json.nullable(s.signed_at, json.int)),
    #(
      "firstQualifyingInteraction",
      case
        s.first_qualifying_ledger_id,
        s.first_qualifying_at,
        s.first_qualifying_type
      {
        None, None, None -> json.null()
        ledger_id, at, type_ ->
          json.object([
            #("id", json.nullable(ledger_id, id.ledger_entry_json)),
            #("ts", json.nullable(at, json.int)),
            #("type", opt(type_)),
          ])
      },
    ),
    #(
      "attributionWindowMonths",
      json.nullable(s.attribution_window_months, json.int),
    ),
    #("insideAttributionWindow", json.bool(s.inside_attribution_window)),
    #("method", row.method_to_json(s.method)),
    #("note", opt(s.note)),
    #(
      "signingPackageId",
      json.nullable(s.signing_package_id, id.signing_package_json),
    ),
    #(
      "signingRevisionId",
      json.nullable(s.signing_revision_id, id.signing_revision_json),
    ),
    #(
      "signingRevisionNumber",
      json.nullable(s.signing_revision_number, json.int),
    ),
    #("caseId", json.nullable(s.case_id, id.recruitment_case_json)),
    #("offerId", json.nullable(s.offer_id, id.offer_json)),
    #("offerRevisionId", opt(s.offer_revision_id)),
    #("transactionId", opt(s.transaction_id)),
    #("documentSha256", opt(s.document_sha256)),
    #("documentEvidenceId", opt(s.document_evidence_id)),
    #("executedDocumentEvidenceId", opt(s.executed_document_evidence_id)),
    #("contract", case s.contract_start_date, s.contract_end_date {
      None, None -> json.null()
      start, end ->
        json.object([#("startDate", opt(start)), #("endDate", opt(end))])
    }),
    #(
      "parties",
      json.array(parties, fn(p) {
        json.object([
          #("partyType", signing_party_type.to_json(p.party_type)),
          #("method", json.nullable(p.method, signing_method.to_json)),
          #("completedAt", json.nullable(p.completed_at, json.int)),
          #("byKind", json.nullable(p.by_kind, recruitment_actor_kind.to_json)),
        ])
      }),
    ),
    #("policyVersion", json.nullable(s.policy_version, json.int)),
  ])
}

/// `GET /org/signings`: the club's signing records, newest first, by cursor.
pub fn org_page(ctx: Ctx, req: Request, org_id: id.OrgId) -> Response {
  use page <- pages.lenient(req, [IntKind])
  let before = case page.after {
    Some([paging.IntKey(rid)]) -> Some(rid)
    _ -> None
  }
  let listed =
    store.read(ctx.store, fn(read) {
      use rows <- result.try(
        store.query(
          read,
          "SELECT "
            <> row.columns
            <> ", rowid FROM signings WHERE org_id = ?"
            <> case before {
            Some(_) -> " AND rowid < ?"
            None -> ""
          }
            <> " ORDER BY rowid DESC LIMIT ?",
          list.flatten([
            [id.org_sql(org_id)],
            option.values([option.map(before, sqlight.int)]),
            [sqlight.int(page.limit + 1)],
          ]),
          {
            use s <- decode.then(row.decoder())
            use rid <- decode.field(row.width, decode.int)
            decode.success(#(s, rid))
          },
        ),
      )
      let #(items, next) =
        paging.page_of(rows, page.limit, fn(r) { [paging.IntKey(r.1)] })
      use views <- result.map(
        list.try_map(items, fn(r) {
          use ps <- result.map(parties(read, { r.0 }.id))
          record_json(r.0, ps)
        }),
      )
      #(views, next)
    })
  case listed {
    Ok(#(views, next)) ->
      http.json(
        200,
        json.object([
          #("items", json.preprocessed_array(views)),
          #("nextCursor", json.nullable(next, json.string)),
        ]),
      )
    Error(failure) -> http.internal(failure)
  }
}
