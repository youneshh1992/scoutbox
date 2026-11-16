//// What leaves an act: asked for inside a unit with `store.emit`, dispatched after COMMIT, never sent by a
//// refused or crashed unit.

import scoutbox/vocab/audience.{type Audience}

pub type Effect {
  /// A mail, recorded in the outbox (the dev transport: the outbox is the delivery).
  SendMail(to: String, subject: String, text: String)
  /// A push to a person's devices, recorded in the push log (the dev transport: the record is the delivery).
  SendPush(to: Audience, id: String, title: String, body: String)
}
