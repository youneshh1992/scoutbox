//// One-click reports and blocks from players, guardians and staff (domains/safety/safety.mjs `registerReporting`).
////
//// An urgent report against an organisation suspends communication with the reporter's players at once, pending
//// review: a suspension block per player and their pending requests frozen, in the report's own unit.

import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess, type PlayerAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/orgs
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/live_pings
import scoutbox/platform/store.{type Tx}
import scoutbox/recruitment/requests
import scoutbox/rows/id
import scoutbox/rows/ledger as ledger_row
import scoutbox/rows/reports
import scoutbox/safety/audit
import scoutbox/safety/ledger
import scoutbox/vocab/party.{type Party}
import wisp.{type Request, type Response}

const target_max = 200

const reason_max = 2000

const block_reason_max = 500

type ReportInput {
  ReportInput(
    target_kind: Option(reports.TargetKind),
    target_org_id: Option(String),
    target_scout_name: Option(String),
    target_player_id: Option(String),
    reason: Option(String),
    urgent: Option(Bool),
  )
}

fn report_shape() -> input.Shape(ReportInput) {
  let opt_text = fn(max) { input.nullish(input.text(max)) }
  use target_kind <- input.field(
    "targetKind",
    input.nullish(input.one_of(reports.target_kind_pairs)),
  )
  use target_org_id <- input.field("targetOrgId", opt_text(target_max))
  use target_scout_name <- input.field("targetScoutName", opt_text(target_max))
  use target_player_id <- input.field("targetPlayerId", opt_text(target_max))
  use reason <- input.field("reason", opt_text(reason_max))
  use urgent <- input.field("urgent", input.nullish(input.boolean()))
  input.done(ReportInput(
    target_kind:,
    target_org_id:,
    target_scout_name:,
    target_player_id:,
    reason:,
    urgent:,
  ))
}

/// Who files a report: the kind, the id, and for staff the organisation.
type Reporter {
  ByPlayer(id: id.PlayerId)
  ByGuardian(guardian: Guardian)
  ByStaff(id: id.OrgUserId, org_id: id.OrgId)
}

/// Empty text is no value (schemas.mjs `filled`).
fn nonempty(s: Option(String)) -> Option(String) {
  case s {
    Some("") -> None
    other -> other
  }
}

fn handle_report(ctx: Ctx, req: Request, reporter: Reporter) -> Response {
  use body <- http.body(req, report_shape(), [
    #("targetKind", "TARGET_KIND_REQUIRED"),
  ])
  case body.target_kind, input.filled(body.reason) {
    None, _ ->
      http.json(
        400,
        json.object([
          #("error", json.string("TARGET_KIND_REQUIRED")),
          #("field", json.string("targetKind")),
          #("problem", json.string("required")),
          #(
            "allowed",
            json.array(reports.target_kind_pairs, fn(p) { json.string(p.0) }),
          ),
        ]),
      )
    _, None -> http.required("REASON_REQUIRED", "reason")
    Some(target_kind), Some(reason) -> {
      // Ids from the request body.
      let target_org_id = nonempty(body.target_org_id) |> option.map(id.org)
      let now = clock.now_ms()
      let urgent = body.urgent == Some(True)
      let suspend = urgent && target_org_id != None
      let #(by, by_id, by_org_id) = case reporter {
        // `by_id` is polymorphic: `by` says whose id it is.
        ByPlayer(p) -> #(reports.ByKindPlayer, id.player_to_string(p), None)
        ByGuardian(g) -> #(
          reports.Guardian,
          id.guardian_to_string(g.row.id),
          None,
        )
        ByStaff(u, org_id) -> #(
          reports.OrgUser,
          id.org_user_to_string(u),
          Some(org_id),
        )
      }
      // A guardian's report covers every child; a player's, the player; a staff member's, nobody.
      let suspended_players = case suspend, reporter {
        False, _ -> []
        True, ByPlayer(p) -> [#(p, party.Player)]
        True, ByGuardian(g) ->
          list.map(g.child_ids, fn(c) { #(c, party.Guardian) })
        True, ByStaff(..) -> []
      }
      let outcome =
        store.unit(ctx.store, fn(tx) {
          use _ <- result.try(org_exists(tx, target_org_id))
          use report <- result.try(audit.file_report(
            tx,
            by:,
            by_id:,
            by_org_id:,
            target_kind:,
            target_org_id:,
            target_scout_name: nonempty(body.target_scout_name),
            // The target player is not checked against the players (Q4, docs/decisions.md).
            target_player_id: nonempty(body.target_player_id)
              |> option.map(id.player),
            reason:,
            urgent:,
            at: now,
          ))
          use _ <- result.map(case target_org_id {
            None -> Ok(Nil)
            Some(org_id) ->
              list.try_each(suspended_players, fn(p) {
                use _ <- result.try(audit.add_block(
                  tx,
                  player_id: p.0,
                  org_id:,
                  by: p.1,
                  reason: "suspended_pending_review",
                  at: now,
                ))
                requests.suspend_pending(tx, org_id, p.0)
              })
          })
          case suspend {
            True -> live_pings.players(tx)
            False -> Nil
          }
          report
        })
      case outcome {
        Ok(report) ->
          http.json(
            201,
            json.object([
              #("reportId", id.report_json(report.id)),
              #("status", reports.status_to_json(report.status)),
              #("suspended", json.bool(suspend)),
            ]),
          )
        Error(store.Refused(OrgNotFound)) -> http.error(404, "ORG_NOT_FOUND")
        Error(failure) -> http.internal(failure)
      }
    }
  }
}

type Refusal {
  OrgNotFound
}

fn org_exists(
  tx: Tx,
  org_id: Option(id.OrgId),
) -> Result(Nil, store.Fail(Refusal)) {
  case org_id {
    None -> Ok(Nil)
    Some(org_id) -> {
      use found <- result.try(orgs.by_id(store.reading(tx), org_id))
      case found {
        Some(_) -> Ok(Nil)
        None -> store.refuse(OrgNotFound)
      }
    }
  }
}

/// A block and its ledger row, in one unit.
fn add_block(
  ctx: Ctx,
  player_id: id.PlayerId,
  org_id: id.OrgId,
  by: Party,
  reason: Option(String),
) -> Response {
  let now = clock.now_ms()
  let outcome =
    store.unit(ctx.store, fn(tx) {
      use found <- result.try(orgs.by_id(store.reading(tx), org_id))
      case found {
        None -> store.refuse(OrgNotFound)
        Some(org) -> {
          live_pings.players(tx)
          use _ <- result.try(audit.add_block(
            tx,
            player_id:,
            org_id:,
            by:,
            reason: option.unwrap(reason, ""),
            at: now,
          ))
          use _ <- result.map(ledger.append(
            tx,
            ledger.Entry(
              entry_type: case by {
                party.Player -> ledger_row.OrgBlockedByPlayer
                party.Guardian -> ledger_row.OrgBlockedByGuardian
              },
              player_id: Some(player_id),
              org_id: Some(org_id),
              org_name: Some(org.name),
              user_id: None,
              actor_name: Some(party.to_string(by)),
            ),
            now,
          ))
          Nil
        }
      }
    })
  case outcome {
    Ok(Nil) -> http.json(201, json.object([#("blocked", json.bool(True))]))
    Error(store.Refused(OrgNotFound)) -> http.error(404, "ORG_NOT_FOUND")
    Error(failure) -> http.internal(failure)
  }
}

fn reports_of(ctx: Ctx, by: reports.ByKind, by_id: String) -> Response {
  case store.read(ctx.store, audit.reports_by(_, by, by_id)) {
    Error(failure) -> http.internal(failure)
    Ok(found) -> http.json(200, json.array(found, audit.report_view))
  }
}

// -------------------------------------------------------------------------------------------- players

pub fn player_report(ctx: Ctx, req: Request, p: PlayerAccess) -> Response {
  handle_report(ctx, req, ByPlayer(p.player.row.id))
}

pub fn player_reports(ctx: Ctx, p: PlayerAccess) -> Response {
  reports_of(ctx, reports.ByKindPlayer, id.player_to_string(p.player.row.id))
}

type PlayerBlock {
  PlayerBlock(org_id: Option(String), reason: Option(String))
}

pub fn player_block(ctx: Ctx, req: Request, p: PlayerAccess) -> Response {
  let shape = {
    use org_id <- input.field("orgId", input.nullish(input.text(target_max)))
    use reason <- input.field(
      "reason",
      input.nullish(input.text(block_reason_max)),
    )
    input.done(PlayerBlock(org_id:, reason:))
  }
  use body <- http.body(req, shape, [])
  case nonempty(body.org_id) {
    None -> http.required("ORG_REQUIRED", "orgId")
    Some(org_id) ->
      add_block(
        ctx,
        p.player.row.id,
        // From the request body.
        id.org(org_id),
        party.Player,
        body.reason,
      )
  }
}

// ------------------------------------------------------------------------------------------ guardians

pub fn guardian_report(ctx: Ctx, req: Request, g: Guardian) -> Response {
  handle_report(ctx, req, ByGuardian(g))
}

pub fn guardian_reports(ctx: Ctx, g: Guardian) -> Response {
  reports_of(ctx, reports.Guardian, id.guardian_to_string(g.row.id))
}

type GuardianBlock {
  GuardianBlock(
    org_id: Option(String),
    player_id: Option(String),
    reason: Option(String),
  )
}

/// A child that is not this guardian's is refused, never swapped for another; with no child named, a guardian
/// of exactly one child means that child.
pub fn guardian_block(ctx: Ctx, req: Request, g: Guardian) -> Response {
  let shape = {
    use org_id <- input.field("orgId", input.nullish(input.text(target_max)))
    use player_id <- input.field(
      "playerId",
      input.nullish(input.text(target_max)),
    )
    use reason <- input.field(
      "reason",
      input.nullish(input.text(block_reason_max)),
    )
    input.done(GuardianBlock(org_id:, player_id:, reason:))
  }
  use body <- http.body(req, shape, [])
  // Ids from the request body.
  let named = nonempty(body.player_id) |> option.map(id.player)
  let child = case named, g.child_ids {
    Some(child), _ ->
      case list.contains(g.child_ids, child) {
        True -> Ok(Some(child))
        False -> Error(Nil)
      }
    None, [only] -> Ok(Some(only))
    None, _ -> Ok(None)
  }
  case child, nonempty(body.org_id) {
    Error(Nil), _ -> http.error(404, "CHILD_NOT_FOUND")
    Ok(Some(child)), Some(org_id) ->
      add_block(ctx, child, id.org(org_id), party.Guardian, body.reason)
    Ok(_), _ ->
      http.json(
        400,
        json.object(
          list.flatten([
            [#("error", json.string("ORG_AND_CHILD_REQUIRED"))],
            case named {
              Some(_) -> []
              None -> [
                #(
                  "message",
                  json.string("Name which child the block is for (playerId)."),
                ),
              ]
            },
          ]),
        ),
      )
  }
}

// ---------------------------------------------------------------------------------------------- staff

pub fn org_report(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  handle_report(ctx, req, ByStaff(a.user.id, a.org.id))
}

pub fn org_reports(ctx: Ctx, a: OrgAccess) -> Response {
  reports_of(ctx, reports.OrgUser, id.org_user_to_string(a.user.id))
}
