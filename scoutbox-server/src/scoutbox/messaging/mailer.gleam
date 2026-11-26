//// One mail send (adapters.mjs `createMailer`): the outbox record first, in a unit of its own, then the provider.
//// Runs after the act's unit committed (`effect.SendMail`, or a route's own follow-up write), never inside one.
////
//// On the dev transport the record is the delivery, and the full text of a mail whose record withholds a code is
//// kept in this process's memory (`dev_mail`). On SendGrid the record is durable before this returns, and the
//// provider call runs in a process of its own, so a slow provider never holds up a response; its answer is
//// written to the record when it comes.

import gleam/erlang/process
import gleam/string
import scoutbox/messaging/dev_mail.{type Deliveries}
import scoutbox/messaging/outbox
import scoutbox/messaging/transport
import scoutbox/platform/store.{type Store}
import scoutbox/rows/id
import scoutbox/rows/outbox as row
import wisp

pub type Mail {
  Mail(to: String, subject: String, text: String, secrets: List(String))
}

/// What became of a recorded mail.
pub type Outcome {
  /// The dev transport: the outbox record is the delivery.
  Recorded
  /// The provider accepted it.
  Accepted
  /// The provider refused it, failed or didn't answer in time.
  NotAccepted
}

pub type Sent {
  Sent(mail: id.MailId, at: Int, outcome: Outcome)
}

/// Records `mail` and hands it to the provider. `then` hears the outcome: at once on the dev transport, from the
/// provider's process on SendGrid, and `Error(Nil)` when the mail could not even be recorded (nothing is sent).
pub fn send(
  store: Store,
  via: transport.Mail,
  dev_mail: Deliveries,
  mail: Mail,
  at: Int,
  then: fn(Result(Sent, Nil)) -> Nil,
) -> Nil {
  let Mail(to:, subject:, text:, secrets:) = mail
  let recorded =
    store.unit(store, outbox.append(
      _,
      transport: case via {
        transport.DevOutbox -> row.DevOutbox
        transport.SendGrid(..) -> row.Sendgrid
      },
      to:,
      subject:,
      text:,
      secrets:,
      at:,
    ))
  case recorded, via {
    Error(e), _ -> {
      wisp.log_error("mail not recorded: " <> string.inspect(e))
      then(Error(Nil))
    }
    Ok(mail_id), transport.DevOutbox -> {
      case secrets {
        [] -> Nil
        _ -> dev_mail.keep(dev_mail, mail_id, text)
      }
      then(Ok(Sent(mail_id, at, Recorded)))
    }
    Ok(mail_id), transport.SendGrid(..) -> {
      process.spawn_unlinked(fn() {
        let accepted = transport.send_mail(via, to:, subject:, text:)
        case store.unit(store, outbox.mark_delivered(_, mail_id, accepted)) {
          Ok(Nil) -> Nil
          Error(e) ->
            wisp.log_error(
              "mail "
              <> id.mail_to_string(mail_id)
              <> ": the provider's answer was not recorded: "
              <> string.inspect(e),
            )
        }
        then(
          Ok(
            Sent(mail_id, at, case accepted {
              True -> Accepted
              False -> NotAccepted
            }),
          ),
        )
      })
      Nil
    }
  }
}
