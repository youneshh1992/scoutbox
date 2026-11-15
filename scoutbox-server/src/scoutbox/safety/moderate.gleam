//// Moderation at the route (domains/safety/moderation.mjs). A blocked text is logged, and grooming-pattern
//// language also escalates to a human at once as an urgent system report, in one unit of its own that commits
//// before the route refuses the request: the refusal undoes the act, never the record of it.

import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/store
import scoutbox/rows/moderation_flags
import scoutbox/rows/moderation_log
import scoutbox/rows/reports
import scoutbox/rules/moderation
import scoutbox/safety/audit.{type Context}
import wisp.{type Response}

pub fn or_refuse(
  ctx: Ctx,
  text: String,
  context: Context,
  next: fn() -> Response,
) -> Response {
  case moderation.check(text) {
    Ok(Nil) -> next()
    Error(hit) -> {
      let now = clock.now_ms()
      let flags = list.map(hit.flags, moderation_flags.flag_to_string)
      let logged =
        store.unit(ctx.store, fn(tx) {
          use _ <- result.try(audit.record_moderation(
            tx,
            context,
            hit,
            string.slice(text, 0, 140),
            now,
          ))
          use _ <- result.map(case hit.severity {
            moderation_log.Contact -> Ok(Nil)
            moderation_log.Grooming ->
              audit.file_report(
                tx,
                by: reports.System,
                by_id: "moderation",
                by_org_id: None,
                target_kind: case context.org_id {
                  Some(_) -> reports.Club
                  None -> reports.TargetKindPlayer
                },
                target_org_id: context.org_id,
                target_scout_name: None,
                target_player_id: None,
                reason: "Automatic escalation: grooming-pattern language blocked ("
                  <> string.join(flags, ", ")
                  <> ") in "
                  <> context.kind
                  <> ".",
                urgent: True,
                at: now,
              )
              |> result.replace(Nil)
          })
          #(Nil, [])
        })
      case logged {
        Error(failure) -> http.internal(failure)
        Ok(Nil) ->
          http.json(
            400,
            json.object([
              #("error", json.string("MODERATION_BLOCKED")),
              #(
                "message",
                json.string(
                  "This text was blocked by moderation: personal contact details and off-platform contact are not allowed.",
                ),
              ),
              #("flags", json.array(flags, json.string)),
            ]),
          )
      }
    }
  }
}
