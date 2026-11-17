//// Dynamic Watchlists (domains/discovery/matching/index.mjs): saved criteria whose membership is derived when they
//// are read. Only the list is here, so a battery can see that no watchlist acquired a case.
////
//// Not ported yet: creating, editing and reading a watchlist, its membership and history, and the criteria view
//// a listed watchlist carries (matching/criteria.mjs `describeCriteria`). No route here creates one, so a page that
//// holds one is refused as not supported rather than shown without its criteria.

import gleam/dynamic/decode
import gleam/json
import gleam/option.{type Option}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/paging.{IntKind, TextKind}
import scoutbox/platform/store
import scoutbox/rows/dynamic_watchlists as row
import scoutbox/rows/id
import sqlight
import wisp.{type Request, type Response}

type ListQuery {
  ListQuery(status: Option(row.Status), page: paging.Query)
}

/// `GET /org/watchlists`: the organisation's watchlists, most recently updated first, by cursor.
pub fn list(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  let shape = {
    use status <- input.field(
      "status",
      input.optional(input.one_of(row.status_pairs)),
    )
    use limit <- input.field("limit", input.nullish(input.text(1000)))
    use cursor <- input.field("cursor", input.nullish(input.text(100_000)))
    input.done(ListQuery(status:, page: paging.Query(limit:, cursor:)))
  }
  use q <- http.query(req, shape, [#("status", "WATCHLIST_STATUS_UNKNOWN")])
  case paging.read(q.page, [IntKind, TextKind]) {
    Error(e) -> {
      let #(code, message) = paging.error_body(e)
      http.error_message(400, code, message)
    }
    // The page is judged as the TypeScript route judges it; with no watchlist here, every page is empty.
    Ok(_) -> {
      let status = option.map(q.status, row.status_to_string)
      let found =
        store.read(ctx.store, fn(read) {
          let status_arg = sqlight.nullable(sqlight.text, status)
          use total <- result.try(store.one(
            read,
            "SELECT COUNT(*) FROM dynamic_watchlists WHERE org_id = ? AND (? IS NULL OR status = ?)",
            [id.org_sql(a.org.id), status_arg, status_arg],
            decode.at([0], decode.int),
          ))
          use first <- result.map(store.query(
            read,
            "SELECT id FROM dynamic_watchlists WHERE org_id = ? AND (? IS NULL OR status = ?) LIMIT 1",
            [id.org_sql(a.org.id), status_arg, status_arg],
            decode.at([0], decode.string),
          ))
          #(result.unwrap(total, 0), first)
        })
      case found {
        Error(e) -> http.internal(e)
        Ok(#(_, [_, ..])) ->
          http.error_message(
            501,
            "NOT_PORTED",
            "Listing saved watchlists is not supported by this server yet.",
          )
        Ok(#(total, [])) ->
          http.json(
            200,
            json.object([
              #("items", json.preprocessed_array([])),
              #("nextCursor", json.null()),
              #("total", json.int(total)),
              #("modes", json.array(row.mode_pairs, fn(p) { json.string(p.0) })),
              #(
                "statuses",
                json.array(row.status_pairs, fn(p) { json.string(p.0) }),
              ),
              #(
                "note",
                json.string(
                  "A Dynamic Watchlist is saved criteria. Membership is derived when it is read.",
                ),
              ),
            ]),
          )
      }
    }
  }
}
