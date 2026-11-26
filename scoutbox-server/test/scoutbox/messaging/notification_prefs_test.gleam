//// Notification preferences are applied before a notice is created (`createNotificationPrefs`' `allows` in the
//// TypeScript rules suite, contracts §24). The suite's people are staff; these are players, whose preferences
//// need no staff row, and the rule is the same for every audience.

import gleam/option.{Some}
import scoutbox/messaging/notification_prefs
import scoutbox/platform/store.{type Store}
import scoutbox/support
import scoutbox/vocab/audience.{Player}
import scoutbox/vocab/notification_category.{Mentions, SecurityAccount}
import sqlight

fn allows(s: Store, id: String, category) -> Bool {
  let assert Ok(on) =
    store.read(s, notification_prefs.allows(_, Player, id, Some(category)))
  on
}

/// Stores Tom's choice to turn mentions and security notices off, past the route.
fn mute(s: Store, id: String) -> Nil {
  let assert Ok(Nil) =
    store.unit(s, fn(tx) {
      let assert Ok(Nil) =
        store.run(
          tx,
          "INSERT INTO notification_prefs (audience_kind, audience_id, email_intent, updated_at) VALUES ('player', ?, 0, 1)",
          [sqlight.text(id)],
        )
      store.run(
        tx,
        "INSERT INTO notification_pref_categories (audience_kind, audience_id, category, enabled) VALUES ('player', ?, 'mentions', 0), ('player', ?, 'security_account', 0)",
        [sqlight.text(id), sqlight.text(id)],
      )
    })
  Nil
}

pub fn a_mention_is_delivered_by_default_test() {
  let s = support.fresh_store(fn(_) { Nil })
  assert allows(s, "pl-tom", Mentions)
}

pub fn a_muted_category_is_not_created_and_mutes_nobody_else_test() {
  let s = support.fresh_store(fn(_) { Nil })
  mute(s, "pl-tom")
  assert !allows(s, "pl-tom", Mentions)
  // Isolation: Tom's choice is his own.
  assert allows(s, "pl-maria", Mentions)
  // A mandatory category is delivered whatever is stored.
  assert allows(s, "pl-tom", SecurityAccount)
}
