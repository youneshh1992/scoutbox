//// The public club directory (`GET /orgs/directory`, domains/identity/orgs.mjs): verified identity and how clubs
//// actually behave (trials run, reports filed, report turnaround), and a Grassroots club's pathway record.
//// Aggregates only: no trial is named.

import gleam/float
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/development/grassroots_club
import scoutbox/identity/orgs.{type Org}
import scoutbox/platform/http
import scoutbox/platform/pages
import scoutbox/platform/paging.{IntKind}
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/recruitment/trials
import scoutbox/rows/id
import scoutbox/rows/orgs as org_row
import scoutbox/rows/trials as trial_row
import scoutbox/vocab/org_type
import wisp.{type Request, type Response}

const day_ms = 86_400_000

/// Days to one decimal, as JavaScript's `Math.round(x * 10) / 10` writes it (a whole number without a point).
fn tenths(x: Float) -> Json {
  let t = float.floor(x *. 10.0 +. 0.5) |> float.truncate
  case t % 10 {
    0 -> json.int(t / 10)
    _ -> json.float(int.to_float(t) /. 10.0)
  }
}

fn entry(read: Read, o: Org) -> Result(Json, Fail(e)) {
  use all <- result.try(trials.for_org(read, o.id))
  use certified <- result.try(orgs.safeguarding_certified(read, o))
  use pathway <- result.map(case orgs.is_grassroots(o) {
    True ->
      grassroots_club.pathway_record(read, o.id)
      |> result.map(grassroots_club.pathway_fields)
    False -> Ok([])
  })
  let reported =
    list.filter_map(all, fn(t) {
      case t.row.status, t.report {
        trial_row.Reported, Some(r) -> Ok(r.filed_at - t.row.accepted_at)
        _, _ -> Error(Nil)
      }
    })
  let avg: Option(Json) = case reported {
    [] -> None
    _ ->
      Some(tenths(
        int.to_float(int.sum(reported))
        /. int.to_float(list.length(reported))
        /. int.to_float(day_ms),
      ))
  }
  json.object([
    #("id", id.org_json(o.id)),
    #("name", json.string(o.name)),
    #("plan", org_row.plan_to_json(o.plan)),
    #("verified", json.bool(o.verified)),
    #("trustedPartner", json.bool(o.trusted_partner)),
    #("safeguardingCertified", json.bool(certified)),
    #("trialsRun", json.int(list.length(all))),
    #("reportsFiled", json.int(list.length(reported))),
    #("avgReportDays", option.unwrap(avg, json.null())),
    ..pathway
  ])
}

/// `GET /orgs/directory`: the clubs, oldest first, by cursor.
pub fn directory(ctx: Ctx, req: Request) -> Response {
  use page <- pages.strict(req, [IntKind])
  case
    store.read(ctx.store, fn(read) {
      use #(clubs, next) <- result.try(orgs.page_of_type(
        read,
        org_type.Club,
        page,
      ))
      use items <- result.map(list.try_map(clubs, entry(read, _)))
      #(items, next)
    })
  {
    Ok(#(items, next)) ->
      http.json(
        200,
        json.object([
          #("nextCursor", json.nullable(next, json.string)),
          #("items", json.preprocessed_array(items)),
        ]),
      )
    Error(failure) -> http.internal(failure)
  }
}
