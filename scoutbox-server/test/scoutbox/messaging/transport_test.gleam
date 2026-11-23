//// The live mail and push transports, against a local receiver standing in for SendGrid and Expo (the TypeScript
//// server's testSendgridStub.mjs and testExpoStub.mjs): what the provider is handed, and what is recorded around
//// the call (scripts/testOutboxPushServer.mjs).

import ewe
import gleam/bit_array
import gleam/dynamic/decode
import gleam/erlang/process.{type Subject}
import gleam/http/request
import gleam/http/response
import gleam/int
import gleam/list
import gleam/result
import scoutbox/messaging/dev_mail
import scoutbox/messaging/mailer
import scoutbox/messaging/outbox
import scoutbox/messaging/push
import scoutbox/messaging/transport
import scoutbox/platform/store.{type Store}
import scoutbox/support
import scoutbox/vocab/audience
import scoutbox/vocab/party
import sqlight

pub type Received {
  Received(path: String, authorization: String, body: String)
}

/// A provider on a free local port that answers `status` to every call and tells `got` what it was sent.
fn receiver(status: Int) -> #(String, Subject(Received)) {
  let got = process.new_subject()
  let assert Ok(started) =
    ewe.new(fn(req) {
      let body =
        ewe.read_body(req, 1_000_000)
        |> result.map(fn(r) { r.body })
        |> result.unwrap(<<>>)
      let assert Ok(text) = bit_array.to_string(body)
      process.send(
        got,
        Received(
          path: req.path,
          authorization: request.get_header(req, "authorization")
            |> result.unwrap(""),
          body: text,
        ),
      )
      response.new(status) |> response.set_body(ewe.Text("{}"))
    })
    |> ewe.listening_random
    |> ewe.quiet
    |> ewe.start
  let assert ewe.TcpSocketAddress(port:, ..) = started.data
  #("http://127.0.0.1:" <> int.to_string(port) <> "/send", got)
}

fn send(
  s: Store,
  via: transport.Mail,
  mail: mailer.Mail,
) -> Result(mailer.Sent, Nil) {
  let assert Ok(deliveries) = dev_mail.start()
  let heard = process.new_subject()
  mailer.send(s, via, deliveries, mail, 1000, process.send(heard, _))
  let assert Ok(sent) = process.receive(heard, 15_000)
  sent
}

pub type Stored {
  Stored(transport: String, delivered: Int, text: String)
}

fn stored(s: Store, to: String) -> List(Stored) {
  let assert Ok(rows) =
    store.read(
      s,
      store.query(
        _,
        "SELECT transport, delivered, text FROM outbox WHERE to_address = ?",
        [sqlight.text(to)],
        {
          use transport <- decode.field(0, decode.string)
          use delivered <- decode.field(1, decode.int)
          use text <- decode.field(2, decode.string)
          decode.success(Stored(transport:, delivered:, text:))
        },
      ),
    )
  rows
}

const code_mail =
  mailer.Mail(
    to: "coach@eastport.example",
    subject: "Your code",
    text: "Your code is J5VFME.",
    secrets: ["J5VFME"],
  )

pub fn sendgrid_is_handed_the_full_mail_and_its_answer_is_recorded_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let #(url, got) = receiver(202)
  let via =
    transport.SendGrid(url:, api_key: "SG.test", from: "from@scoutbox.test")
  let assert Ok(mailer.Sent(outcome: mailer.Accepted, at: 1000, ..)) =
    send(s, via, code_mail)
  let assert Ok(call) = process.receive(got, 1000)
  assert call.path == "/send"
  assert call.authorization == "Bearer SG.test"
  // The provider gets the code; the record, which is backed up, withholds it.
  assert call.body
    == "{\"personalizations\":[{\"to\":[{\"email\":\"coach@eastport.example\"}]}],\"from\":{\"email\":\"from@scoutbox.test\"},\"subject\":\"Your code\",\"content\":[{\"type\":\"text/plain\",\"value\":\"Your code is J5VFME.\"}]}"
  assert stored(s, code_mail.to)
    == [
      Stored(
        transport: "sendgrid",
        delivered: 1,
        text: "Your code is " <> outbox.withheld_placeholder <> ".",
      ),
    ]
}

pub fn a_mail_sendgrid_refuses_is_recorded_undelivered_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let #(url, got) = receiver(500)
  let via = transport.SendGrid(url:, api_key: "SG.test", from: "f@x.test")
  let assert Ok(mailer.Sent(outcome: mailer.NotAccepted, ..)) =
    send(s, via, code_mail)
  // It was handed the mail, and refused it.
  let assert Ok(_) = process.receive(got, 1000)
  let assert [Stored(transport: "sendgrid", delivered: 0, ..)] =
    stored(s, code_mail.to)
}

pub fn a_provider_that_cannot_be_reached_leaves_the_mail_undelivered_test() {
  let s = support.fresh_store(fn(_) { Nil })
  // Nothing listens on port 1.
  let via =
    transport.SendGrid(url: "http://127.0.0.1:1/x", api_key: "k", from: "f")
  let assert Ok(mailer.Sent(outcome: mailer.NotAccepted, ..)) =
    send(s, via, code_mail)
  let assert [Stored(delivered: 0, ..)] = stored(s, code_mail.to)
}

pub fn on_the_dev_transport_the_record_is_the_delivery_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let assert Ok(mailer.Sent(outcome: mailer.Recorded, ..)) =
    send(s, transport.DevOutbox, code_mail)
  let assert [Stored(transport: "dev-outbox", delivered: 1, ..)] =
    stored(s, code_mail.to)
}

pub fn expo_is_handed_each_registered_token_of_the_audience_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let #(url, got) = receiver(200)
  let via = transport.Expo(url:, access_token: "expo-test")
  let assert Ok(_) =
    store.unit(s, fn(tx) {
      use _ <- result.try(push.register(
        tx,
        party.Player,
        "pl-adeyemi",
        "ExponentPushToken[a]",
        1,
      ))
      use _ <- result.try(push.register(
        tx,
        party.Player,
        "pl-adeyemi",
        "ExponentPushToken[b]",
        2,
      ))
      push.register(tx, party.Player, "pl-other", "ExponentPushToken[c]", 3)
    })
  let assert Ok(Nil) =
    store.unit(s, push.send(
      _,
      via,
      audience.Player,
      "pl-adeyemi",
      "New message",
      "Hello",
      1000,
    ))
  push.deliver(s, via, audience.Player, "pl-adeyemi", "New message", "Hello")
  let assert Ok(first) = process.receive(got, 5000)
  let assert Ok(second) = process.receive(got, 5000)
  // One call per token, oldest first, and none for another account's.
  assert first.authorization == "Bearer expo-test"
  assert list.map([first, second], fn(c) { c.body })
    == [
      "{\"to\":\"ExponentPushToken[a]\",\"title\":\"New message\",\"body\":\"Hello\"}",
      "{\"to\":\"ExponentPushToken[b]\",\"title\":\"New message\",\"body\":\"Hello\"}",
    ]
  assert process.receive(got, 300) == Error(Nil)
  let assert Ok(["expo"]) =
    store.read(s, store.query(
      _,
      "SELECT transport FROM push_log WHERE audience_id = 'pl-adeyemi'",
      [],
      decode.at([0], decode.string),
    ))
}

pub fn the_dev_push_log_calls_no_provider_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let assert Ok(Nil) =
    store.unit(s, push.send(
      _,
      transport.DevLog,
      audience.Player,
      "pl-adeyemi",
      "t",
      "b",
      1,
    ))
  // Nothing to call: `deliver` returns without starting anything.
  assert push.deliver(
      s,
      transport.DevLog,
      audience.Player,
      "pl-adeyemi",
      "t",
      "b",
    )
    == Nil
  let assert Ok(["dev-log"]) =
    store.read(s, store.query(
      _,
      "SELECT transport FROM push_log WHERE audience_id = 'pl-adeyemi'",
      [],
      decode.at([0], decode.string),
    ))
}

fn env(pairs: List(#(String, String))) -> fn(String) -> Result(String, Nil) {
  fn(name) { list.key_find(pairs, name) }
}

pub fn the_transports_come_from_their_settings_test() {
  assert transport.mail_from_env(env([])) == transport.DevOutbox
  assert transport.mail_from_env(env([#("SENDGRID_API_KEY", "  ")]))
    == transport.DevOutbox
  let assert transport.SendGrid(
    url: "https://api.sendgrid.com/v3/mail/send",
    api_key: "SG.k",
    from: "noreply@scoutbox.app",
  ) =
    transport.mail_from_env(
      env([#("SENDGRID_API_KEY", "SG.k"), #("MAIL_FROM", "")]),
    )
  let assert transport.SendGrid(from: "club@scoutbox.test", ..) =
    transport.mail_from_env(
      env([#("SENDGRID_API_KEY", "SG.k"), #("MAIL_FROM", "club@scoutbox.test")]),
    )
  assert transport.push_from_env(env([])) == transport.DevLog
  assert transport.push_from_env(env([#("EXPO_ACCESS_TOKEN", "")]))
    == transport.DevLog
  assert transport.push_from_env(env([#("EXPO_ACCESS_TOKEN", "e")]))
    == transport.Expo(
      url: "https://exp.host/--/api/v2/push/send",
      access_token: "e",
    )
}
