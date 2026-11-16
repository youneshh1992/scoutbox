//// What leaves an act: asked for inside a unit with `store.emit`, dispatched after COMMIT, never sent by a
//// refused or crashed unit.

import scoutbox/platform/live_event
import scoutbox/vocab/audience.{type Audience}

pub type Effect {
  /// A mail, recorded in the outbox (the dev transport: the outbox is the delivery). `secrets` are one-time codes
  /// in `text`: the outbox record is persisted and copied into every backup, so it keeps the mail with each one
  /// replaced by `outbox.withheld_placeholder`.
  SendMail(to: String, subject: String, text: String, secrets: List(String))
  /// A push to a person's devices, recorded in the push log (the dev transport: the record is the delivery).
  SendPush(to: Audience, id: String, title: String, body: String)
  /// A live event to every stream allowed to see it.
  Live(event: live_event.Event)
}
