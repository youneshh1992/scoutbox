//// Who a Trust & Safety decision is attributed to. The admin surface may authenticate with one shared key, which
//// identifies no individual. A request may declare its reviewer in headers; with none declared, events say
//// `shared_admin_key` rather than invent a person.

import gleam/option.{None, Some}
import gleam/result
import gleam/string
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/rows/ver_events as event_row
import scoutbox/verification/core
import scoutbox/vocab/attribution.{type Attribution}
import wisp.{type Request}

/// Who decided, as far as the request says.
pub type Reviewer {
  Reviewer(id: String, name: String, attribution: Attribution)
}

pub fn of(req: Request) -> Reviewer {
  let header = fn(name, max) {
    http.header(req, name)
    |> result.unwrap("")
    |> string.trim
    |> input.utf16_take(max)
  }
  case header("x-admin-reviewer-id", 60), header("x-admin-reviewer-name", 80) {
    "", _ ->
      Reviewer(
        id: "admin",
        name: "Trust & Safety",
        attribution: attribution.SharedAdminKey,
      )
    id, "" -> Reviewer(id:, name: id, attribution: attribution.DeclaredReviewer)
    id, name -> Reviewer(id:, name:, attribution: attribution.DeclaredReviewer)
  }
}

pub fn actor(req: Request) -> core.Actor {
  let r = of(req)
  core.Actor(
    kind: event_row.TrustSafety,
    id: Some(r.id),
    name: Some(r.name),
    org_id: None,
    request_id: Some(core.request_id(req)),
  )
}
