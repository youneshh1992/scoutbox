//// The organisation's staff: the list, and removal.

import gleam/json
import gleam/option.{None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/sessions
import scoutbox/identity/staff
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/store
import scoutbox/rows/ledger as ledger_row
import scoutbox/safety/ledger
import wisp.{type Response}

/// `GET /org/staff`: removed accounts included, so history stays attributable.
pub fn list(ctx: Ctx, access: OrgAccess) -> Response {
  case
    store.read(ctx.store, staff.for_org(_, access.org.id, active_only: False))
  {
    Error(failure) -> http.internal(failure)
    Ok(members) ->
      http.json(
        200,
        json.array(members, fn(u) {
          json.object([
            #("id", json.string(u.id)),
            #("name", json.string(u.name)),
            #("role", json.string(u.role)),
            #("lead", json.bool(access.is_lead(u))),
            #("removedAt", json.nullable(u.removed_at, json.int)),
          ])
        }),
      )
  }
}

/// `POST /org/staff/:userId/remove`: access ends at once (sessions revoked in the same commit), but the account
/// stays so decisions and history remain attributed to the named person.
pub fn remove(ctx: Ctx, access: OrgAccess, user_id: String) -> Response {
  use <- access.require_lead(access)
  case user_id == access.user.id {
    True -> http.error(400, "CANNOT_REMOVE_SELF")
    False -> {
      let now = clock.now_ms()
      let outcome =
        store.unit(ctx.store, fn(tx) {
          use found <- result.try(staff.by_id(store.reading(tx), user_id))
          case found {
            Some(u) if u.org_id == access.org.id -> {
              use removed <- result.try(staff.remove(
                tx,
                u.id,
                at: now,
                by: access.user.id,
              ))
              use _ <- result.try(sessions.revoke_org_user(tx, u.id))
              use _ <- result.try(ledger.append(
                tx,
                ledger.Entry(
                  entry_type: ledger_row.StaffRemoved,
                  player_id: None,
                  org_id: Some(access.org.id),
                  org_name: Some(access.org.name),
                  user_id: Some(access.user.id),
                  actor_name: Some(access.user.name),
                ),
                now,
              ))
              // Not ported yet: the TypeScript server also closes the removed member's live event streams
              // after the commit. This server has no live streams.
              Ok(removed)
            }
            _ -> store.refuse(staff.NotFound)
          }
        })
      case outcome {
        Ok(removed) ->
          http.json(
            200,
            json.object([
              #(
                "removed",
                json.object([
                  #("id", json.string(removed.id)),
                  #("name", json.string(removed.name)),
                  #("removedAt", json.nullable(removed.removed_at, json.int)),
                ]),
              ),
              #(
                "note",
                json.string(
                  "Sessions revoked, event streams silenced, media links dead on next fetch. History stays attributed to the named person.",
                ),
              ),
            ]),
          )
        Error(store.Refused(staff.NotFound)) ->
          http.error(404, "STAFF_NOT_FOUND")
        Error(store.Refused(staff.AlreadyRemoved)) ->
          http.error(409, "ALREADY_REMOVED")
        Error(failure) -> http.internal(failure)
      }
    }
  }
}
