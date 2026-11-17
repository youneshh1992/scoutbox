import gleam/string
import gleeunit/should
import scoutbox/platform/unicode

pub fn composes_a_decomposed_accent_test() {
  // "e" followed by U+0301 COMBINING ACUTE ACCENT becomes the one code point U+00E9.
  unicode.nfc("cafe\u{0301}") |> should.equal("caf\u{00E9}")
  unicode.nfc("cafe\u{0301}") |> string.length |> should.equal(4)
}

pub fn leaves_composed_and_plain_text_alone_test() {
  unicode.nfc("caf\u{00E9}") |> should.equal("caf\u{00E9}")
  unicode.nfc("") |> should.equal("")
  unicode.nfc("plain ascii") |> should.equal("plain ascii")
}

pub fn orders_combining_marks_canonically_test() {
  // A dot below (ccc 220) sorts before a dot above (ccc 230); "q" has no precomposed form with either.
  unicode.nfc("q\u{0307}\u{0323}") |> should.equal("q\u{0323}\u{0307}")
}

pub fn keeps_compatibility_characters_test() {
  // NFC is canonical only: the "ﬁ" ligature is not split into "fi" (that is NFKC).
  unicode.nfc("\u{FB01}") |> should.equal("\u{FB01}")
}
