//// Invoices (repositories/invoices.mjs, the billing adapter in adapters.mjs): the success fee of one signing made
//// inside the attribution window, stored exactly in minor units, one per signing. The dev-ledger provider records it
//// locally; it keeps its own copy of the player's name, as a billing record does.

import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/operator
import scoutbox/platform/pages
import scoutbox/platform/paging.{IntKind}
import scoutbox/platform/store.{type Fail, type Tx}
import scoutbox/rows/id
import scoutbox/rows/invoices as row
import scoutbox/rows/orgs
import scoutbox/rows/signings as signing_row
import scoutbox/vocab/org_type
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
  listed(ctx, Some(org_id), page)
}

/// `GET /admin/invoices`: every club's, newest first; the query takes only the page.
pub fn admin_page(ctx: Ctx, req: Request) -> Response {
  use page <- pages.strict(req, [IntKind])
  listed(ctx, None, page)
}

fn listed(ctx: Ctx, org_id: Option(id.OrgId), page: paging.Page) -> Response {
  let before = case page.after {
    Some([paging.IntKey(rid)]) -> Some(rid)
    _ -> None
  }
  let where = case org_id, before {
    Some(_), Some(_) -> " WHERE org_id = ? AND rowid < ?"
    Some(_), None -> " WHERE org_id = ?"
    None, Some(_) -> " WHERE rowid < ?"
    None, None -> ""
  }
  let read =
    store.read(ctx.store, fn(read) {
      use rows <- result.map(
        store.query(
          read,
          "SELECT "
            <> row.columns
            <> ", rowid FROM invoices"
            <> where
            <> " ORDER BY rowid DESC LIMIT ?",
          list.flatten([
            option.values([option.map(org_id, id.org_sql)]),
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
  case read {
    Ok(#(items, next)) -> pages.respond(items, next, fn(r) { view(r.0) })
    Error(failure) -> http.internal(failure)
  }
}

const fee_protection =
  "Discovery attribution is evidenced by the append-only ledger and Proof Packs. Fees attach to the first qualifying interaction inside the window."

/// `GET /org/plan`: the club's plan, and the terms its fees follow.
pub fn plan(a: OrgAccess) -> Response {
  let org = a.org
  let p = operator.plan(orgs.plan_to_string(org.plan))
  http.json(
    200,
    json.object([
      #(
        "org",
        json.object([
          #("id", id.org_json(org.id)),
          #("name", json.string(org.name)),
          #("type", org_type.to_json(org.type_)),
          #("trustedPartner", json.bool(org.trusted_partner)),
        ]),
      ),
      #("plan", operator.plan_json(p)),
      #(
        "compliance",
        json.object([
          #("attributionWindowMonths", json.int(p.attribution_window_months)),
          #("antiCircumvention", json.string(p.anti_circumvention)),
          #("feeProtection", json.string(fee_protection)),
        ]),
      ),
    ]),
  )
}
