import gleam/dynamic/decode
import gleam/int
import scoutbox/platform/store
import scoutbox/support
import scoutbox/verification/transitions

const day = 86_400_000

const now = 1_800_000_000_000

/// An adult and a child with a guardian, and five cases: one open past its period, one open within it, two placed
/// with their check-ins due (the adult's and the child's), and one placed whose check-in is not yet due.
fn planted() -> store.Store {
  let s = support.fresh_store(fn(_) { Nil })
  let case_row = fn(cid, player, status, period_end, due) {
    let placed = status == "placed"
    let placement = case placed {
      True -> "'org-c', 'Club', " <> int.to_string(now - 70 * day) <> ", NULL"
      False -> "NULL, NULL, NULL, NULL"
    }
    "INSERT INTO transition_cases (id, player_id, player_name, started_by_kind, started_by_id, started_by_name, note, period_ends_at, status, placement_org_id, placement_org_name, placement_at, placement_note, follow_up_due_at, follow_up_notified_at, created_at) VALUES ('"
    <> cid
    <> "', '"
    <> player
    <> "', 'P', 'player', '"
    <> player
    <> "', 'P', NULL, "
    <> int.to_string(period_end)
    <> ", '"
    <> status
    <> "', "
    <> placement
    <> ", "
    <> due
    <> ", NULL, 1);"
  }
  let assert Ok(_) =
    store.unit(s, fn(tx) {
      store.exec(
        tx,
        "INSERT INTO orgs (id, name, type, level, plan, created_at) VALUES ('org-c', 'Club', 'club', 'pro', 'Pro', 1);"
          <> "INSERT INTO guardians (id, name, email) VALUES ('gd-g', 'G', 'g@example.test');"
          <> "INSERT INTO players (id, name, birth_date, country, profile_signal) VALUES ('pl-adult', 'A', '1990-01-01', 'GB', 30);"
          <> "INSERT INTO players (id, name, birth_date, country, profile_signal, guardian_id) VALUES ('pl-kid', 'K', '2015-01-01', 'GB', 30, 'gd-g');"
          <> case_row("trn-over", "pl-adult", "open", now - day, "NULL")
          <> case_row("trn-live", "pl-adult", "open", now + day, "NULL")
          <> case_row(
          "trn-adult",
          "pl-adult",
          "placed",
          now - 80 * day,
          int.to_string(now - day),
        )
          <> case_row(
          "trn-kid",
          "pl-kid",
          "placed",
          now - 80 * day,
          int.to_string(now - day),
        )
          <> case_row(
          "trn-later",
          "pl-adult",
          "placed",
          now - 80 * day,
          int.to_string(now + day),
        ),
      )
    })
  s
}

fn texts(s: store.Store, sql: String) -> List(String) {
  let assert Ok(found) =
    store.read(s, fn(read) {
      store.query(read, sql, [], decode.at([0], decode.string))
    })
  found
}

pub fn the_sweep_expires_and_checks_in_once_test() {
  let s = planted()
  transitions.sweep(s, now)
  transitions.sweep(s, now)
  let assert ["trn-over:expired", "trn-live:open"] =
    texts(
      s,
      "SELECT id || ':' || status FROM transition_cases WHERE id IN ('trn-over', 'trn-live') ORDER BY rowid",
    )
  let assert ["trn-over:system:sweep:system:expired"] =
    texts(
      s,
      "SELECT transition_case_id || ':' || by_kind || ':' || by_id || ':' || by_name || ':' || action FROM transition_case_history",
    )
  let assert [
    "player:pl-adult:trn-adult:How is the placement at Club going? A quick check-in is due on the transition case.",
    "guardian:gd-g:trn-kid:How is the placement at Club going? A quick check-in is due on the transition case.",
  ] =
    texts(
      s,
      "SELECT audience_kind || ':' || audience_id || ':' || ref_id || ':' || text FROM notifications ORDER BY seq",
    )
  let assert ["trn-adult", "trn-kid"] =
    texts(
      s,
      "SELECT id FROM transition_cases WHERE follow_up_notified_at = "
        <> int.to_string(now)
        <> " ORDER BY rowid",
    )
}
