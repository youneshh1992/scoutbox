//// The specification tables this server declares in Gleam equal the TypeScript server's, as snapshotted in
//// e2e/support/spec/ (written by its scripts/specSnapshot.mjs and copied here by e2e/sync.mjs). A table ported
//// in part is checked entry by entry, so a ported entry can't drift.

import gleam/dict
import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/string
import scoutbox/messaging/notifications
import scoutbox/platform/limits.{Policy}
import scoutbox/rows/notifications as notification_row
import simplifile

fn snapshot(file: String, decoder: decode.Decoder(a)) -> a {
  let assert Ok(text) = simplifile.read("e2e/support/spec/" <> file)
  let assert Ok(value) = json.parse(text, decoder)
  value
}

pub fn rate_limit_policy_test() {
  let policy =
    snapshot(
      "platform/rateLimit.json",
      decode.at(
        ["RATE_LIMIT_POLICY"],
        decode.dict(decode.string, {
          use max <- decode.field("max", decode.int)
          use window_ms <- decode.field("windowMs", decode.int)
          decode.success(Policy(max:, window_ms:))
        }),
      ),
    )
  list.each(limits.policy, fn(entry) {
    let #(action, ported) = entry
    assert dict.get(policy, action) == Ok(ported)
  })
}

pub fn notification_type_categories_test() {
  let type_category =
    snapshot(
      "platform/notificationPrefs.json",
      decode.at(["TYPE_CATEGORY"], decode.dict(decode.string, decode.string)),
    )
  list.each(notifications.type_category, fn(entry) {
    let #(type_, category) = entry
    assert dict.get(type_category, type_)
      == Ok(notification_row.category_to_string(category))
  })
}

/// The `notifications.category` CHECK (from the migrations) allows exactly the categories CATEGORIES names.
pub fn notification_categories_test() {
  let categories =
    snapshot(
      "platform/notificationPrefs.json",
      decode.at(["CATEGORIES"], decode.dict(decode.string, decode.dynamic)),
    )
  assert list.sort(dict.keys(categories), string.compare)
    == list.sort(
      list.map(notification_row.category_pairs, fn(p) { p.0 }),
      string.compare,
    )
}
