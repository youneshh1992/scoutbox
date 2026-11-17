//// Unicode normalisation, the one thing here written as Erlang FFI. NFC needs the Unicode Character Database's
//// decomposition and composition tables; no maintained Gleam package carries them, and OTP's `unicode` module
//// does. The type checker can't see across the call, so test/scoutbox/platform/unicode_test.gleam checks it
//// directly.

/// `text` in Normalization Form C, as JavaScript's `String.prototype.normalize('NFC')`. A Gleam string is always
/// valid UTF-8, so OTP's conversion can't answer its error tuples here.
@external(erlang, "unicode", "characters_to_nfc_binary")
pub fn nfc(text: String) -> String
