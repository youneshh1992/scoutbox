//// Unicode normalisation and character categories, the one thing here written as Erlang FFI. They need the Unicode
//// Character Database's decomposition, composition and category tables; no maintained Gleam package carries them,
//// and OTP's `unicode` and `unicode_util` modules do. The type checker can't see across the calls, so
//// test/scoutbox/platform/unicode_test.gleam checks them directly.

import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/erlang/atom
import gleam/list
import gleam/string

/// `text` in Normalization Form C, as JavaScript's `String.prototype.normalize('NFC')`. A Gleam string is always
/// valid UTF-8, so OTP's conversion can't answer its error tuples here.
@external(erlang, "unicode", "characters_to_nfc_binary")
pub fn nfc(text: String) -> String

@external(erlang, "unicode", "characters_to_nfd_binary")
fn nfd(text: String) -> String

/// `{Major, Minor}`, such as `{mark, non_spacing}`.
@external(erlang, "unicode_util", "category")
fn category(codepoint: Int) -> Dynamic

fn is_mark(c: UtfCodepoint) -> Bool {
  decode.run(
    category(string.utf_codepoint_to_int(c)),
    decode.at([0], atom.decoder()),
  )
  == Ok(atom.create("mark"))
}

/// A name's sort key, with case and accents folded so "Émile" sorts with "Emile": JavaScript's
/// `v.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()`.
pub fn fold_name(text: String) -> String {
  nfd(text)
  |> string.to_utf_codepoints
  |> list.filter(fn(c) { !is_mark(c) })
  |> string.from_utf_codepoints
  |> string.lowercase
}
