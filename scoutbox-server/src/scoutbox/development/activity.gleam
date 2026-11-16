//// Football activity feeds the streak and the weekly goal, and the Grassroots journey badges are awarded as the
//// record grows (domains/development/activity.mjs).

import gleam/list
import gleam/option.{Some}
import gleam/result
import scoutbox/app.{type Effect}
import scoutbox/identity/players.{type Player}
import scoutbox/messaging/notifications
import scoutbox/platform/store.{type Fail, type Tx}
import scoutbox/rules/journey
import scoutbox/vocab/audience
import scoutbox/vocab/playing_level

/// Logs the activity, then awards each journey badge newly earned, with a notice. Returns the stored record and
/// the notices' pushes.
pub fn record(
  tx: Tx,
  id: String,
  now: Int,
) -> Result(#(Player, List(Effect)), Fail(e)) {
  use _ <- result.try(players.log_activity(tx, id, now))
  use found <- result.try(players.by_id(store.reading(tx), id))
  let assert Some(p) = found as "activity is recorded for a live player"
  case p.row.level {
    playing_level.Pro -> Ok(#(p, []))
    _ -> {
      let new =
        journey.earned_badges(p, journey.streak(p.activity_log, now))
        |> list.filter(fn(b) { !list.contains(p.badges, b) })
      case new {
        [] -> Ok(#(p, []))
        _ -> {
          use pushes <- result.try(
            notifications.each(new, fn(badge) {
              notifications.notify(
                tx,
                to: audience.Player,
                id:,
                type_: "badge",
                text: "🏅 Badge earned: "
                  <> badge
                  <> ". It's on your profile — recognition that never depends on being scouted.",
                ref_id: Some(id),
                at: now,
              )
            }),
          )
          players.set_badges(tx, id, list.append(p.badges, new))
          |> result.map(fn(p) { #(p, pushes) })
        }
      }
    }
  }
}
