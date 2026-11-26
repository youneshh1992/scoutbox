//// The rule every act with a `clientKey` shares (domains/platform/idempotency.mjs): what counts as a key. Each
//// domain keeps its own error code, and decides what makes a retry "the same request".

import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/int
import gleam/option.{type Option, None, Some}
import gleam/string
import scoutbox/platform/input

pub const client_key_max = 64

/// Absent, null or empty is no key; anything other than text is refused, never coerced. Error(message).
pub fn client_key(raw: Option(Dynamic)) -> Result(Option(String), String) {
  case raw {
    None -> Ok(None)
    Some(v) ->
      case dynamic.classify(v), decode.run(v, decode.string) {
        "Nil", _ -> Ok(None)
        _, Ok("") -> Ok(None)
        _, Ok(text) -> {
          let k = string.trim(text)
          case k == "" || input.utf16_length(k) > client_key_max {
            True ->
              Error(
                "clientKey must be 1–"
                <> int.to_string(client_key_max)
                <> " characters.",
              )
            False -> Ok(Some(k))
          }
        }
        _, Error(_) -> Error("clientKey must be text.")
      }
  }
}
