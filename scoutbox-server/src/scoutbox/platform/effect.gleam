//// What leaves an act: asked for inside a unit with `store.emit`, dispatched after COMMIT, never sent by a
//// refused or crashed unit.

import scoutbox/platform/live_event
import scoutbox/vocab/audience.{type Audience}

pub type Effect {
  /// A mail (`messaging/mailer`): recorded in the outbox, then handed to SendGrid when it is configured. `secrets`
  /// are one-time codes in `text`: the outbox record is persisted and copied into every backup, so it keeps the mail
  /// with each one replaced by `outbox.withheld_placeholder`; the provider gets the full text.
  SendMail(to: String, subject: String, text: String, secrets: List(String))
  /// A push to a person's devices: recorded in the push log, then handed to Expo when it is configured.
  SendPush(to: Audience, id: String, title: String, body: String)
  /// A live event to every stream allowed to see it.
  Live(event: live_event.Event)
  /// A staff member lost access: their open streams close (`rows/id` can't be imported here, so the id is text).
  CloseStreams(org_user_id: String)
  /// One occurrence of `name` in `group`, in the process's request counters (`platform/request_metrics`), which
  /// `/capabilities` reads without waiting for the writer. A refused act counts nothing.
  Count(group: String, name: String)
}
