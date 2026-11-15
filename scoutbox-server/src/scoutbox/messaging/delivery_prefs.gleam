//// `PUT /org/delivery/prefs`: a staff member's quiet hours and e-mail switch. The write replaces the stored
//// preference; an absent field takes its default (no quiet hours, e-mail on).

import gleam/json
import gleam/option.{type Option}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/staff
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/store
import wisp.{type Request, type Response}

type Prefs {
  Prefs(
    quiet_start: Option(String),
    quiet_end: Option(String),
    email: Option(Bool),
  )
}

fn shape() -> input.Shape(Prefs) {
  use quiet_start <- input.field(
    "quietStart",
    input.nullish(input.time_of_day()),
  )
  use quiet_end <- input.field("quietEnd", input.nullish(input.time_of_day()))
  use email <- input.field("email", input.nullish(input.boolean()))
  input.done(Prefs(quiet_start:, quiet_end:, email:))
}

/// These times keep the general code rather than TIME_INVALID, as the apps already read them.
const codes = [#("quietStart", "FIELD_INVALID"), #("quietEnd", "FIELD_INVALID")]

pub fn put(ctx: Ctx, req: Request, access: OrgAccess) -> Response {
  use body <- http.body(req, shape(), codes)
  let prefs =
    staff.DeliveryPrefs(
      quiet_start: body.quiet_start,
      quiet_end: body.quiet_end,
      email: body.email != option.Some(False),
    )
  case
    store.unit(ctx.store, fn(tx) {
      staff.set_delivery_prefs(tx, access.user.id, prefs)
      |> result.map(fn(u) { #(u, []) })
    })
  {
    Error(failure) -> http.internal(failure)
    Ok(saved) ->
      http.json(
        200,
        json.object([
          #(
            "prefs",
            json.object([
              #(
                "quietStart",
                json.nullable(saved.prefs.quiet_start, json.string),
              ),
              #("quietEnd", json.nullable(saved.prefs.quiet_end, json.string)),
              #(
                "channels",
                json.object([#("email", json.bool(saved.prefs.email))]),
              ),
            ]),
          ),
        ]),
      )
  }
}
