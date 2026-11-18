//// A club's vacancies (domains/scouting/scouting.mjs, repositories/clubSetup.ts): a role in its tactical setup
//// the club means to fill, which a recruitment case may name.
////
//// Not ported yet: opening and closing a vacancy, its candidates, and the tactical setup it names a role of.

import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/option.{Some}
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/platform/http
import scoutbox/platform/pages
import scoutbox/platform/paging.{IntKey, IntKind}
import scoutbox/platform/store
import scoutbox/rows/id
import scoutbox/rows/vacancies as row
import sqlight
import wisp.{type Request, type Response}

pub fn view(v: row.Row) -> Json {
  json.object([
    #("id", id.vacancy_json(v.id)),
    #("orgId", id.org_json(v.org_id)),
    #("roleId", json.nullable(v.role_id, json.string)),
    #("roleName", json.string(v.role_name)),
    #("window", json.nullable(v.window_name, json.string)),
    #("notes", json.nullable(v.notes, json.string)),
    #("status", row.status_to_json(v.status)),
    #("createdBy", json.string(v.created_by_name)),
    #("createdAt", json.int(v.created_at)),
    #("closedAt", json.nullable(v.closed_at, json.int)),
  ])
}

/// `GET /org/vacancies`: the club's vacancies, newest first, by cursor. A parameter the list does not take is
/// refused.
pub fn list_for(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use page <- pages.strict(req, [IntKind])
  let before = case page.after {
    Some([IntKey(rowid)]) -> sqlight.int(rowid)
    _ -> sqlight.null()
  }
  let found =
    store.read(ctx.store, fn(read) {
      store.query(
        read,
        "SELECT "
          <> row.columns
          <> ", rowid FROM vacancies WHERE org_id = ? AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?",
        [id.org_sql(a.org.id), before, before, sqlight.int(page.limit + 1)],
        {
          use r <- decode.then(row.decoder())
          use rowid <- decode.field(row.width, decode.int)
          decode.success(#(r, rowid))
        },
      )
    })
  case found {
    Error(e) -> http.internal(e)
    Ok(rows) -> {
      let #(items, next) =
        paging.page_of(rows, page.limit, fn(f) { [IntKey(f.1)] })
      pages.respond(items, next, fn(f) { view(f.0) })
    }
  }
}
