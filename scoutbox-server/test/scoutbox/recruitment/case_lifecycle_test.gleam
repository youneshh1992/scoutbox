//// The lifecycle validator's calls that Gleam's types can't hold (scripts/rules/recruitment/lifecycle.mjs R3b,
//// the bogus-status and bogus-role sweeps, and the unknown action; journeyAdversarial's SIGNEDX). The TypeScript
//// validator refuses them itself (LIFECYCLE_STATE_UNKNOWN, LIFECYCLE_NOT_PERMITTED, LIFECYCLE_ACTION_UNKNOWN);
//// here each is refused before it can reach the validator:
////
//// - a Room's status is a typed column: the schema refuses a value outside the vocabulary, so no case is read
////   with one, and text that isn't a status doesn't decode as one;
//// - an action is named in a request and looked up with `action_named`, which knows only the vocabulary;
//// - a Room role is never read from text: `room_rules.room_role` decides it from the room's membership, so there
////   is no role string to be malformed. Text that names no role, or no role at all, is a staff member with no
////   role in the room: `None`, which the matrix shows refused (LIFECYCLE_NOT_PERMITTED) for every action.
////
//// The calls whose evidence provider is a closure are not here. Those that always answer yes are rows of
//// lifecycle_matrix_test; the fixture provider's calls test which records count as evidence, and go with
//// createEvidenceProvider's port.

import gleam/dynamic
import gleam/dynamic/decode
import gleam/list
import gleam/option.{None}
import scoutbox/platform/store
import scoutbox/recruitment/case_lifecycle
import scoutbox/support
import scoutbox/vocab/room_status
import sqlight

const not_statuses = [
  "SIGNEDX",
  "__unknown_old_status__",
  "",
  "identified",
  "IN_PROGRESS",
  "nonsense",
  "trial_in_progress",
]

pub fn an_unknown_action_is_not_a_lifecycle_action_test() {
  assert case_lifecycle.action_named("notAnAction") == None
  assert case_lifecycle.action_named("constructor") == None
  assert case_lifecycle.action_named("") == None
}

pub fn text_that_is_not_a_status_does_not_decode_as_one_test() {
  list.each(not_statuses, fn(text) {
    assert room_status.from_string(text) == Error(Nil)
  })
  assert decode.run(dynamic.int(42), room_status.decoder()) |> is_error
  assert decode.run(dynamic.nil(), room_status.decoder()) |> is_error
}

pub fn the_schema_refuses_a_room_at_a_status_that_is_not_one_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let assert Ok(Nil) =
    store.unit(s, fn(tx) {
      store.run(
        tx,
        "INSERT INTO org_users (id, org_id, name, name_key, role, created_at)
         SELECT 'u-lifecycle', MIN(id), 'Lifecycle Scout', 'lifecycle scout', 'Scout', 1 FROM orgs",
        [],
      )
    })
  let write = fn(id, status) {
    store.unit(s, fn(tx) {
      store.run(
        tx,
        "INSERT INTO recruitment_cases (id, org_id, player_id, owner_user_id, stage, priority, restricted, created_at, room_status, room_priority, room_updated_at, room_rev)
         SELECT ?, u.org_id, (SELECT MIN(id) FROM players), u.id, 'identified', 'medium', 0, 1, ?, 'normal', 1, 1
         FROM org_users u WHERE u.id = 'u-lifecycle'",
        [sqlight.text(id), sqlight.text(status)],
      )
    })
  }
  // The same row at a status is written, so each refusal below is the status's.
  assert write("rc-watching", "watching") == Ok(Nil)
  list.each(not_statuses, fn(text) {
    assert is_error(write("rc-bogus", text))
  })
}

fn is_error(r: Result(a, b)) -> Bool {
  case r {
    Ok(_) -> False
    Error(_) -> True
  }
}
