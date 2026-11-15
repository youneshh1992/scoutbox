//// The notification feeds: `GET /org/notifications`, `/player/notifications` and `/guardian/notifications`.

import gleam/json
import scoutbox/app.{type Ctx}
import scoutbox/messaging/notifications
import scoutbox/platform/http
import scoutbox/platform/store
import scoutbox/vocab/audience.{type Audience}
import wisp.{type Response}

pub fn feed(ctx: Ctx, kind: Audience, id: String) -> Response {
  case store.read(ctx.store, notifications.feed(_, kind, id)) {
    Ok(rows) -> http.json(200, json.array(rows, notifications.view))
    Error(failure) -> http.internal(failure)
  }
}
