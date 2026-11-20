//// Figures filed into a past season (`POST /player/stats` with `season`): the history is kept newest first.

import gleam/list
import gleam/option.{None, Some}
import scoutbox/identity/players
import scoutbox/platform/store
import scoutbox/rows/id
import scoutbox/support

fn figures(goals: Int) -> players.Stats {
  players.Stats(
    appearances: None,
    goals: Some(goals),
    assists: None,
    pace_kmh: None,
    pass_completion_pct: None,
    duel_success_pct: None,
    clean_sheets: None,
  )
}

/// Kola's seeded history is 2024/25 (14 goals) and 2023/24 (9).
pub fn a_past_season_files_into_the_history_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let kola = id.player("pl-adeyemi")
  let assert Ok(p) =
    store.unit(s, players.file_season(_, kola, "2022/23", figures(5)))
  assert list.map(p.season_history, fn(r) { r.season })
    == ["2024/25", "2023/24", "2022/23"]
  let assert [_, _, added] = p.season_history
  // A new season starts at nothing played.
  assert #(added.appearances, added.goals, added.assists)
    == #(Some(0.0), Some(5.0), Some(0.0))
  // Filing into a season it already has replaces only the figures given.
  let assert Ok(p) =
    store.unit(s, players.file_season(_, kola, "2024/25", figures(15)))
  let assert [latest, ..] = p.season_history
  assert latest.goals == Some(15.0)
  assert latest.appearances != Some(0.0)
}
