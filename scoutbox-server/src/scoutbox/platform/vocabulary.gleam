//// A fixed vocabulary: the text a column (or a request field) holds, paired with the Gleam value it means. One
//// list serves the decoder, the encoder and the input check, so they cannot drift apart.

import gleam/dynamic/decode.{type Decoder}
import gleam/list
import scoutbox/platform/input.{type Check}

pub opaque type Vocabulary(a) {
  Vocabulary(pairs: List(#(String, a)))
}

/// Panics on an empty list: a vocabulary has at least one value, which the decoder needs as a placeholder.
pub fn new(pairs: List(#(String, a))) -> Vocabulary(a) {
  let assert [_, ..] = pairs as "a vocabulary has at least one value"
  Vocabulary(pairs)
}

/// Decodes stored text. Text outside the vocabulary fails loudly; the table's CHECK should make it impossible.
pub fn decoder(v: Vocabulary(a)) -> Decoder(a) {
  let assert [#(_, zero), ..] = v.pairs
  use s <- decode.then(decode.string)
  case list.key_find(v.pairs, s) {
    Ok(value) -> decode.success(value)
    Error(Nil) -> decode.failure(zero, "one of the vocabulary's values")
  }
}

pub fn name(v: Vocabulary(a), value: a) -> String {
  let assert Ok(#(text, _)) = list.find(v.pairs, fn(pair) { pair.1 == value })
    as "every value of a vocabulary type is in its list"
  text
}

/// The request-input check: one of the vocabulary, refused with `allowed` otherwise.
pub fn check(v: Vocabulary(a)) -> Check(a) {
  input.one_of(v.pairs)
}
