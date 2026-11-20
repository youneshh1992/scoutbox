//// A player who joins is matched against the saved searches of current staff, as each club sees them
//// (domains/discovery/savedSearches.mjs `checkSavedSearches`).

import gleam/list
import gleam/option.{None, Some}
import scoutbox/discovery/saved_searches
import scoutbox/identity/players
import scoutbox/identity/staff
import scoutbox/messaging/notifications
import scoutbox/platform/store
import scoutbox/rows/id
import scoutbox/rows/saved_searches as row
import scoutbox/support
import scoutbox/vocab/audience
import scoutbox/vocab/position

/// 1 September 2026: Kola Adeyemi (a striker in GB, born 2004) is 22.
const now = 1_788_220_800_000

pub fn a_new_player_alerts_each_search_they_match_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let assert Ok(scout) =
    store.unit(s, staff.create(
      _,
      staff.NewStaff(
        org_id: id.org("org-eastport"),
        name: "Maria Keane",
        role: "Scout",
        email: None,
        provenance: None,
        created_at: 1,
      ),
    ))
  let search = fn(n, name, f: fn(row.Row) -> row.Row) {
    f(row.new(
      id: id.saved_search("ss-" <> n),
      org_id: id.org("org-eastport"),
      user_id: scout.id,
      name:,
      created_at: 1,
    ))
  }
  let searches = [
    search("1", "Strikers in GB", fn(r) {
      row.Row(..r, position: Some(position.ST), country: Some("GB"))
    }),
    search("2", "Wingers", fn(r) { row.Row(..r, position: Some(position.RW)) }),
    search("3", "Under-18s", fn(r) { row.Row(..r, age_group: Some(row.U18)) }),
    search("4", "Named Kola", fn(r) { row.Row(..r, q: Some("kOLA")) }),
  ]
  let assert Ok(Nil) =
    store.unit(s, fn(tx) {
      let assert Ok(Nil) = list.try_each(searches, row.insert(tx, _))
      let assert Ok(Some(kola)) =
        players.by_id(store.reading(tx), id.player("pl-adeyemi"))
      saved_searches.alert_new_player(tx, kola, now)
    })
  let assert Ok(sent) =
    store.read(s, notifications.for_audience(
      _,
      audience.OrgUser,
      id.org_user_to_string(scout.id),
    ))
  assert list.map(sent, fn(n) { n.text })
    == [
      "New match for your saved search “Named Kola”: Kola Adeyemi (ST) just joined.",
      "New match for your saved search “Strikers in GB”: Kola Adeyemi (ST) just joined.",
    ]
}
