//// The Trust & Safety console's reads, behind the admin key.

import gleam/json
import scoutbox/app.{type Ctx}
import scoutbox/messaging/dev_mail
import scoutbox/messaging/outbox
import scoutbox/platform/http
import scoutbox/platform/paging
import scoutbox/platform/store
import wisp.{type Request, type Response}

/// `GET /admin/outbox`, newest first. On the dev transport the outbox is the delivery.
pub fn outbox(ctx: Ctx, req: Request) -> Response {
  use query <- http.query(req, paging.query_shape(), [])
  case paging.read(query, [paging.IntKind]) {
    Error(e) -> {
      let #(code, message) = paging.error_body(e)
      http.error_message(400, code, message)
    }
    Ok(page) ->
      case store.read(ctx.store, outbox.page(_, page)) {
        Error(failure) -> http.internal(failure)
        Ok(#(items, next)) ->
          http.json(
            200,
            json.object([
              // On the dev transport the outbox is the delivery: a mail whose code the stored row withholds is
              // shown in full while this process holds it.
              #(
                "items",
                json.array(items, fn(m) {
                  outbox.view(dev_mail.shown(ctx.dev_mail, m))
                }),
              ),
              #("nextCursor", json.nullable(next, json.string)),
            ]),
          )
      }
  }
}
