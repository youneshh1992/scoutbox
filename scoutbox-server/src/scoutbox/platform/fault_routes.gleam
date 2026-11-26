//// `GET /__faults` and `POST /__faults` (development only): read the fault rules with how often each was
//// reached, or replace them.

import gleam/http.{Get, Post}
import gleam/json
import gleam/option
import scoutbox/app.{type Ctx}
import scoutbox/platform/faults
import scoutbox/platform/http as contract
import scoutbox/platform/input
import wisp.{type Request, type Response}

const rules_max = 2000

pub fn handle(ctx: Ctx, req: Request) -> Response {
  case req.method {
    Get ->
      contract.json(
        200,
        json.object([
          #(
            "rules",
            json.array(faults.rules(ctx.faults), faults.rule_json(_, True)),
          ),
        ]),
      )
    Post -> {
      let shape = {
        use rules <- input.field("rules", input.optional(input.text(rules_max)))
        input.done(rules)
      }
      use rules <- contract.body(req, shape, [])
      case faults.replace_all(ctx.faults, option.unwrap(rules, "")) {
        Ok(rules) ->
          contract.json(
            200,
            json.object([
              #("ok", json.bool(True)),
              #("rules", json.array(rules, faults.rule_json(_, False))),
            ]),
          )
        Error(message) ->
          contract.error_message(400, "FAULT_RULE_INVALID", message)
      }
    }
    _ -> contract.error(404, "NOT_FOUND")
  }
}
