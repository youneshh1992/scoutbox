//// The specification tables this server declares in Gleam equal the TypeScript server's, as snapshotted in
//// e2e/support/spec/ (written by its scripts/specSnapshot.mjs and copied here by e2e/sync.mjs). A table ported
//// in part is checked entry by entry, so a ported entry can't drift.

import gleam/dict
import gleam/dynamic/decode
import gleam/json
import gleam/list
import scoutbox/agents/core_routes
import scoutbox/agents/transaction_routes
import scoutbox/messaging/notification_prefs
import scoutbox/platform/limits.{Policy}
import scoutbox/recruitment/domain_errors
import scoutbox/vocab/notification_category
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
  list.each(notification_prefs.type_category, fn(entry) {
    let #(type_, category) = entry
    assert dict.get(type_category, type_)
      == Ok(notification_category.to_string(category))
  })
}

/// CATEGORIES, entry by entry, and the `notifications.category` CHECK (from the migrations) in the same order.
pub fn notification_categories_test() {
  let categories =
    snapshot(
      "platform/notificationPrefs.json",
      decode.at(
        ["CATEGORIES"],
        decode.dict(decode.string, {
          use label <- decode.field("label", decode.string)
          use default <- decode.field("default", decode.bool)
          use mandatory <- decode.field("mandatory", decode.bool)
          decode.success(#(label, default, mandatory))
        }),
      ),
    )
  let ported =
    list.map(notification_prefs.categories, fn(c: notification_prefs.Category) {
      #(
        notification_category.to_string(c.id),
        #(c.label, c.default, c.mandatory),
      )
    })
  assert dict.from_list(ported) == categories
  assert list.map(ported, fn(p) { p.0 })
    == list.map(notification_category.pairs, fn(p) { p.0 })
}

/// An error table declared whole equals its snapshot, entry for entry and no more.
fn error_table(
  file: String,
  name: String,
  ported: List(#(String, Int)),
) -> Nil {
  let table =
    snapshot(file, decode.at([name], decode.dict(decode.string, decode.int)))
  assert dict.from_list(ported) == table
}

pub fn agent_core_error_table_test() {
  error_table(
    "agents/core/errors.json",
    "AGENT_CORE_ERROR_HTTP",
    core_routes.statuses,
  )
}

pub fn transaction_error_table_test() {
  error_table(
    "agents/transactions/errors.json",
    "TRANSACTION_ERROR_HTTP",
    transaction_routes.statuses,
  )
}

pub fn signing_error_table_test() {
  error_table(
    "recruitment/signings/errors.json",
    "SIGNING_ERROR_HTTP",
    domain_errors.signing_statuses,
  )
}
