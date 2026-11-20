//// The boot integrity report (`operator.integrity`), over rows written past the handlers, as the TypeScript
//// rules suite feeds `integrityReport` its collections (scripts/rules/platform/contracts.mjs §7). A Room's
//// organisation is a foreign key here, so ROOM_ORPHAN_ORG can't happen, and ids are primary keys, so neither can
//// CASE_ID_DUPLICATE or PLAYER_ID_DUPLICATE.

import gleam/dynamic/decode
import gleam/json
import scoutbox/platform/operator
import scoutbox/platform/store.{type Store}
import scoutbox/support
import sqlight

type Report {
  Report(ok: Bool, violations: Int, duplicates: Int)
}

fn report(s: Store) -> Report {
  let assert Ok(j) = store.read(s, operator.integrity)
  let assert Ok(r) =
    json.parse(json.to_string(j), {
      use ok <- decode.field("ok", decode.bool)
      use violations <- decode.field("violations", decode.int)
      use duplicates <- decode.optional_field(
        "byCode",
        0,
        decode.optional_field(
          "ROOM_OPEN_DUPLICATE",
          0,
          decode.int,
          decode.success,
        ),
      )
      decode.success(Report(ok:, violations:, duplicates:))
    })
  r
}

/// A Room for the seed's first organisation and first player, written past the handlers, led by a scout the test
/// adds (the seed has no staff until someone signs in).
fn room(s: Store, id: String, status: String) -> Nil {
  let assert Ok(Nil) =
    store.unit(s, fn(tx) {
      let assert Ok(Nil) =
        store.run(
          tx,
          "INSERT OR IGNORE INTO org_users (id, org_id, name, name_key, role, created_at)
           SELECT 'u-integrity', MIN(id), 'Integrity Scout', 'integrity scout', 'Scout', 1 FROM orgs",
          [],
        )
      store.run(
        tx,
        "INSERT INTO recruitment_cases (id, org_id, player_id, owner_user_id, stage, priority, restricted, created_at, room_status, room_priority, room_updated_at, room_rev)
         SELECT ?, u.org_id, (SELECT MIN(id) FROM players), u.id, 'identified', 'medium', 0, 1, ?, 'normal', 1, 1
         FROM org_users u WHERE u.id = 'u-integrity'",
        [sqlight.text(id), sqlight.text(status)],
      )
    })
  Nil
}

pub fn an_empty_database_is_clean_test() {
  let r = report(support.fresh_store(fn(_) { Nil }))
  assert r.ok && r.violations == 0
}

pub fn a_closed_room_may_repeat_an_open_one_test() {
  let s = support.fresh_store(fn(_) { Nil })
  room(s, "rc-open", "watching")
  room(s, "rc-archived", "archived")
  assert report(s).ok
}

pub fn two_open_rooms_for_one_organisation_and_player_are_one_violation_test() {
  let s = support.fresh_store(fn(_) { Nil })
  room(s, "rc-open", "watching")
  room(s, "rc-open-2", "shortlisted")
  let r = report(s)
  assert !r.ok
  assert r.duplicates == 1
  assert r.violations == 1
}

pub fn each_further_open_room_is_one_more_test() {
  let s = support.fresh_store(fn(_) { Nil })
  room(s, "rc-open", "watching")
  room(s, "rc-open-2", "shortlisted")
  room(s, "rc-open-3", "priority")
  assert report(s).duplicates == 2
}
