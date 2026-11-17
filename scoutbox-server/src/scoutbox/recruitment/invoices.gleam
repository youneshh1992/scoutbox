//// Invoices (repositories/invoices.mjs, the billing adapter in adapters.mjs): the success fee of one signing made
//// inside the attribution window, stored exactly in minor units, one per signing. The dev-ledger provider records it
//// locally; it keeps its own copy of the player's name, as a billing record does.

import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/pages
import scoutbox/platform/paging.{IntKind}
import scoutbox/platform/store.{type Fail, type Tx}
import scoutbox/rows/id
import scoutbox/rows/invoices as row
import scoutbox/rows/orgs
import scoutbox/rows/signings as signing_row
import sqlight
import wisp.{type Request, type Response}

/// The success fee by plan, in minor units (SUCCESS_FEE_MINOR_BY_PLAN); any other plan pays the default.
fn fee_minor(plan: orgs.Plan) -> Int {
  case plan {
    orgs.PlanPro -> 150_000
    orgs.PlanAcademy -> 50_000
    orgs.PlanAgency -> 200_000
    orgs.PlanGrassroots -> 100_000
  }
}

/// Issues the signing's invoice (invoiceForSigning): once; a second call for one signing changes nothing.
pub fn issue_for_signing(
  tx: Tx,
  signing: signing_row.Row,
  org: orgs.Row,
) -> Result(Nil, Fail(e)) {
  use existing <- result.try(store.query(
    store.reading(tx),
    "SELECT 1 FROM invoices WHERE signing_id = ?",
    [id.signing_sql(signing.id)],
    decode.success(Nil),
  ))
  case existing {
    [_, ..] -> Ok(Nil)
    [] -> {
      use invoice <- result.try(id.next_invoice(tx))
      let player = option.unwrap(signing.player_name, "")
      row.insert(
        tx,
        row.Row(
          id: invoice,
          created_at: clock.now_ms(),
          org_id: org.id,
          org_name: org.name,
          signing_id: signing.id,
          player_name: player,
          description: "Success fee — "
            <> player
            <> " signed inside the attribution window",
          amount_minor: fee_minor(org.plan),
          currency: "EUR",
          status: row.Issued,
          provider: row.DevLedger,
        ),
      )
    }
  }
}

/// An invoice as the API answers it: `amount` in major units.
fn view(i: row.Row) -> Json {
  json.object([
    #("id", id.invoice_json(i.id)),
    #("ts", json.int(i.created_at)),
    #("orgId", id.org_json(i.org_id)),
    #("orgName", json.string(i.org_name)),
    #("signingId", id.signing_json(i.signing_id)),
    #("playerName", json.string(i.player_name)),
    #("description", json.string(i.description)),
    #("amount", amount_json(i.amount_minor)),
    #("currency", json.string(i.currency)),
    #("status", row.status_to_json(i.status)),
    #("provider", row.provider_to_json(i.provider)),
  ])
}

/// Minor units over 100, as JavaScript divides: a whole number stays an integer.
fn amount_json(minor: Int) -> Json {
  case minor % 100 {
    0 -> json.int(minor / 100)
    _ -> json.float(int.to_float(minor) /. 100.0)
  }
}

/// `GET /org/invoices`: the club's invoices, newest first, by cursor.
pub fn org_page(ctx: Ctx, req: Request, org_id: id.OrgId) -> Response {
  use page <- pages.lenient(req, [IntKind])
  let before = case page.after {
    Some([paging.IntKey(rid)]) -> Some(rid)
    _ -> None
  }
  let listed =
    store.read(ctx.store, fn(read) {
      use rows <- result.map(
        store.query(
          read,
          "SELECT "
            <> row.columns
            <> ", rowid FROM invoices WHERE org_id = ?"
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
            use i <- decode.then(row.decoder())
            use rid <- decode.field(row.width, decode.int)
            decode.success(#(i, rid))
          },
        ),
      )
      paging.page_of(rows, page.limit, fn(r) { [paging.IntKey(r.1)] })
    })
  case listed {
    Ok(#(items, next)) ->
      http.json(
        200,
        json.object([
          #("items", json.array(items, fn(r) { view(r.0) })),
          #("nextCursor", json.nullable(next, json.string)),
        ]),
      )
    Error(failure) -> http.internal(failure)
  }
}
