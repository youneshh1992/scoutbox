//// The outbox record is persisted and backed up, so a mail's one-time codes are withheld from it (the TypeScript
//// server's mailer `secrets`).

import gleam/dynamic/decode
import gleam/string
import scoutbox/messaging/outbox
import scoutbox/platform/store
import scoutbox/rows/outbox as row
import scoutbox/support

fn stored(secrets: List(String), text: String) -> String {
  let s = support.fresh_store(fn(_) { Nil })
  let assert Ok(_) =
    store.unit(s, outbox.append(
      _,
      transport: row.DevOutbox,
      to: "club@eastport.example",
      subject: "Verify",
      text:,
      secrets:,
      at: 1,
    ))
  let assert Ok([text]) =
    store.read(s, store.query(
      _,
      "SELECT text FROM outbox WHERE to_address = 'club@eastport.example'",
      [],
      decode.at([0], decode.string),
    ))
  text
}

pub fn a_secret_is_withheld_wherever_it_appears_test() {
  let text = stored(["J5VFME"], "Your code is J5VFME. Again: J5VFME.")
  assert !string.contains(text, "J5VFME")
  assert text
    == "Your code is "
    <> outbox.withheld_placeholder
    <> ". Again: "
    <> outbox.withheld_placeholder
    <> "."
}

pub fn a_mail_without_secrets_is_kept_as_sent_test() {
  assert stored([], "Your code is J5VFME.") == "Your code is J5VFME."
  // An empty secret withholds nothing.
  assert stored([""], "Hello.") == "Hello."
}
