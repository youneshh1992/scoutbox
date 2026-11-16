//// `notify` asks for its push with `store.emit`; `store.unit_effects` hands back what a unit asked for, so what
//// an act would push is asserted here directly. The unit sends it only once it commits.

import gleam/erlang/process
import gleam/option.{Some}
import gleam/result
import scoutbox/messaging/notifications
import scoutbox/platform/effect.{type Effect, SendPush}
import scoutbox/platform/store
import scoutbox/support
import scoutbox/vocab/audience
import sqlight

/// An adult in the demo seed with no quiet hours: a notice to them is pushed at once.
const adult = "pl-adeyemi"

fn notice(s: store.Store, text: String) -> List(Effect) {
  let assert Ok(#(Nil, pushes)) =
    store.unit_effects(s, fn(tx) {
      notifications.notify(
        tx,
        to: audience.Player,
        id: adult,
        type_: "message",
        text:,
        ref_id: Some("chan-test"),
        at: 2_000_000_000_000,
      )
    })
  pushes
}

pub fn a_new_notice_asks_for_one_push_test() {
  let s = support.fresh_store(fn(_) { Nil })
  assert notice(s, "Synthetic message.")
    == [
      SendPush(
        to: audience.Player,
        id: adult,
        title: "ScoutBox",
        body: "Synthetic message.",
      ),
    ]
}

pub fn a_repeated_unread_notice_is_counted_not_pushed_again_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let _ = notice(s, "Synthetic message.")
  assert notice(s, "Synthetic message.") == []
}

pub fn a_muted_category_asks_for_no_push_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let assert Ok(Nil) =
    store.unit(s, fn(tx) {
      use _ <- result.try(
        store.run(
          tx,
          "INSERT INTO notification_prefs (audience_kind, audience_id, email_intent, updated_at) VALUES ('player', ?, 0, 0)",
          [sqlight.text(adult)],
        ),
      )
      store.run(
        tx,
        "INSERT INTO notification_pref_categories (audience_kind, audience_id, category, enabled) VALUES ('player', ?, 'messages', 0)",
        [sqlight.text(adult)],
      )
      |> result.replace(Nil)
    })
  assert notice(s, "Synthetic message.") == []
}

pub fn the_push_is_sent_after_commit_and_never_by_a_refused_unit_test() {
  let sent = process.new_subject()
  let s = support.fresh_store(process.send(sent, _))
  let refused =
    store.unit(s, fn(tx) {
      use _ <- result.try(notifications.notify(
        tx,
        to: audience.Player,
        id: adult,
        type_: "message",
        text: "Refused.",
        ref_id: Some("chan-test"),
        at: 2_000_000_000_000,
      ))
      store.refuse("no")
    })
  assert refused == Error(store.Refused("no"))
  assert process.receive(sent, 50) == Error(Nil)
  let assert Ok(Nil) =
    store.unit(s, fn(tx) {
      notifications.notify(
        tx,
        to: audience.Player,
        id: adult,
        type_: "message",
        text: "Kept.",
        ref_id: Some("chan-test"),
        at: 2_000_000_000_000,
      )
    })
  let assert Ok(SendPush(body: "Kept.", ..)) = process.receive(sent, 100)
}
