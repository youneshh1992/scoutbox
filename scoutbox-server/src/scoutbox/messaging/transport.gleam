//// The outbound mail and push providers (adapters.mjs `createMailer`, `createPushSender`). SENDGRID_API_KEY switches
//// mail to SendGrid, otherwise the outbox is the delivery; EXPO_ACCESS_TOKEN switches push to Expo, otherwise the
//// push log is. Each provider holds its endpoint, so a test can point it at a local receiver; `from_env` always
//// gives the real one.
////
//// The calls here only speak to the provider. Recording happens around them (`mailer`, the push dispatch), and
//// they run in a process of their own, after the act's response is decided.

import gleam/http
import gleam/http/request
import gleam/httpc
import gleam/json
import gleam/result
import gleam/string

pub type Mail {
  /// The outbox is the delivery: nothing leaves the machine.
  DevOutbox
  SendGrid(url: String, api_key: String, from: String)
}

pub type Push {
  /// The push log is the delivery: nothing leaves the machine.
  DevLog
  Expo(url: String, access_token: String)
}

const sendgrid_url = "https://api.sendgrid.com/v3/mail/send"

const expo_url = "https://exp.host/--/api/v2/push/send"

const default_from = "noreply@scoutbox.app"

/// How long a provider call may take before it counts as failed.
const timeout_ms = 10_000

/// SENDGRID_API_KEY and MAIL_FROM, as `get` reads them. A blank key is unset.
pub fn mail_from_env(get: fn(String) -> Result(String, Nil)) -> Mail {
  case set(get, "SENDGRID_API_KEY") {
    Error(Nil) -> DevOutbox
    Ok(api_key) ->
      SendGrid(
        url: sendgrid_url,
        api_key:,
        from: get("MAIL_FROM") |> result.unwrap(default_from) |> or_default,
      )
  }
}

/// EXPO_ACCESS_TOKEN, as `get` reads it. A blank token is unset.
pub fn push_from_env(get: fn(String) -> Result(String, Nil)) -> Push {
  case set(get, "EXPO_ACCESS_TOKEN") {
    Error(Nil) -> DevLog
    Ok(access_token) -> Expo(url: expo_url, access_token:)
  }
}

fn set(
  get: fn(String) -> Result(String, Nil),
  name: String,
) -> Result(String, Nil) {
  case get(name) {
    Ok(value) ->
      case string.trim(value) {
        "" -> Error(Nil)
        _ -> Ok(value)
      }
    Error(Nil) -> Error(Nil)
  }
}

fn or_default(from: String) -> String {
  case from {
    "" -> default_from
    _ -> from
  }
}

/// Hands a mail to SendGrid, with its full text (the outbox record is what withholds the codes). True when the
/// provider accepted it; a refusal, an error or no answer in time is False.
pub fn send_mail(
  sendgrid: Mail,
  to to: String,
  subject subject: String,
  text text: String,
) -> Bool {
  case sendgrid {
    DevOutbox -> True
    SendGrid(url:, api_key:, from:) ->
      json.object([
        #(
          "personalizations",
          json.preprocessed_array([
            json.object([
              #(
                "to",
                json.preprocessed_array([
                  json.object([#("email", json.string(to))]),
                ]),
              ),
            ]),
          ]),
        ),
        #("from", json.object([#("email", json.string(from))])),
        #("subject", json.string(subject)),
        #(
          "content",
          json.preprocessed_array([
            json.object([
              #("type", json.string("text/plain")),
              #("value", json.string(text)),
            ]),
          ]),
        ),
      ])
      |> post(url, api_key, _)
  }
}

/// Hands one push to Expo for one device token. Its answer is not kept: the push log already holds the record.
pub fn send_push(
  expo: Push,
  token token: String,
  title title: String,
  body body: String,
) -> Nil {
  case expo {
    DevLog -> Nil
    Expo(url:, access_token:) -> {
      let _ =
        json.object([
          #("to", json.string(token)),
          #("title", json.string(title)),
          #("body", json.string(body)),
        ])
        |> post(url, access_token, _)
      Nil
    }
  }
}

fn post(url: String, bearer: String, body: json.Json) -> Bool {
  case request.to(url) {
    Error(Nil) -> False
    Ok(req) ->
      req
      |> request.set_method(http.Post)
      |> request.set_header("authorization", "Bearer " <> bearer)
      |> request.set_header("content-type", "application/json")
      |> request.set_body(json.to_string(body))
      |> httpc.dispatch(httpc.configure() |> httpc.timeout(timeout_ms), _)
      |> result.map(fn(resp) { resp.status >= 200 && resp.status < 300 })
      |> result.unwrap(False)
  }
}
