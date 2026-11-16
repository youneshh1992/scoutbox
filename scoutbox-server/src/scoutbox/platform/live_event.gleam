//// The live events (domains/platform/eventRegistry.mjs), apart from the hub (`platform/live`) so that an effect
//// can carry one: `rows/id` imports the store, which imports the effects, so ids here are text. Build an event
//// from typed ids with `messaging/live_routes` (`live_routes.messages(channel_id)`), never from text.

import gleam/json.{type Json}
import scoutbox/vocab/audience.{type Audience}

/// An event, by its name in the event registry (e2e/support/spec/platform/eventRegistry.json). Its fields are the
/// registry's payload keys and nothing else; `test/scoutbox/platform/live_test.gleam` proves they agree.
pub type Event {
  /// A thread changed: a message, or a read receipt.
  Messages(channel_id: String)
  /// Someone is typing in a thread. Never replayed.
  Typing(channel_id: String, side: TypingSide)
  /// A notice reached an audience's feed.
  Notify(audience_kind: Audience, audience_id: String)
}

pub type TypingSide {
  OrgTyping
  CounterpartyTyping
}

pub fn name(event: Event) -> String {
  case event {
    Messages(..) -> "messages"
    Typing(..) -> "typing"
    Notify(..) -> "notify"
  }
}

/// The registry's payload, in its key order.
pub fn payload(event: Event) -> List(#(String, Json)) {
  case event {
    Messages(channel_id:) -> [#("channelId", json.string(channel_id))]
    Typing(channel_id:, side:) -> [
      #("channelId", json.string(channel_id)),
      #(
        "side",
        json.string(case side {
          OrgTyping -> "org"
          CounterpartyTyping -> "counterparty"
        }),
      ),
    ]
    Notify(audience_kind:, audience_id:) -> [
      #("audienceKind", audience.to_json(audience_kind)),
      #("audienceId", json.string(audience_id)),
    ]
  }
}

/// Whether a reconnect replays it (the registry's `replayPolicy`).
pub fn replays(event: Event) -> Bool {
  case event {
    Typing(..) -> False
    _ -> True
  }
}
