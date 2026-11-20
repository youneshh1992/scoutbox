//// The catalogue pings (liveSync.mjs `broadcast('players')` and friends), asked for inside a unit from typed ids.
//// A ping carries no data: the refetch it triggers is authorisation-checked. `live_event` itself can't hold a
//// typed id (see its module doc), so the acts call these.

import gleam/option.{None, Some}
import scoutbox/platform/effect
import scoutbox/platform/live_event.{type Event}
import scoutbox/platform/store.{type Tx}
import scoutbox/rows/id

/// One player's record changed: the player, their guardian and every club that may see them.
pub fn player(tx: Tx, player_id: id.PlayerId) -> Nil {
  store.emit(
    tx,
    effect.Live(live_event.Players(Some(id.player_to_string(player_id)))),
  )
}

/// Who may see whom changed (a sign-up, an erasure, a block, a club's standing): every stream.
pub fn players(tx: Tx) -> Nil {
  store.emit(tx, effect.Live(live_event.Players(None)))
}

/// A catalogue ping naming nobody (`live_event.Orgs`, `OpenTrials`, …): every stream.
pub fn catalogue(tx: Tx, event: Event) -> Nil {
  store.emit(tx, effect.Live(event))
}
