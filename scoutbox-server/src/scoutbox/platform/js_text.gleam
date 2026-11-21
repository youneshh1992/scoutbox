//// Text as JavaScript treats it, where a route must agree with the TypeScript server character for character.

import gleam/list
import gleam/string

/// JavaScript's `toLowerCase`: Unicode's full lowercase mapping, which the BEAM's `string.lowercase` also applies,
/// plus the one context rule JavaScript adds, Final_Sigma: a capital sigma that ends a word lowers to ς, not σ
/// ("ΟΔΥΣΣΕΑΣ" is "οδυσσεας").
///
/// Which characters are cased and which are case-ignorable is approximated: a cased character is one that case
/// mapping changes either way; the case-ignorable ones are the combining marks and the apostrophes, periods,
/// colons and middle dots that can sit inside a word. Text the directory searches (names, places) is covered.
pub fn lower(s: String) -> String {
  case string.contains(s, "Σ") {
    False -> string.lowercase(s)
    True -> {
      let chars =
        string.to_utf_codepoints(s)
        |> list.map(fn(c) { string.from_utf_codepoints([c]) })
      lower_sigmas(chars, [], [])
    }
  }
}

/// Walks the code points; `before` holds those already seen, nearest first.
fn lower_sigmas(
  rest: List(String),
  before: List(String),
  out: List(String),
) -> String {
  case rest {
    [] -> out |> list.reverse |> string.concat
    ["Σ", ..after] -> {
      let final = cased_beyond(before) && !cased_beyond(after)
      let lowered = case final {
        True -> "ς"
        False -> "σ"
      }
      lower_sigmas(after, ["Σ", ..before], [lowered, ..out])
    }
    [c, ..after] ->
      lower_sigmas(after, [c, ..before], [string.lowercase(c), ..out])
  }
}

/// Whether, skipping case-ignorable characters, the next character in `chars` is cased.
fn cased_beyond(chars: List(String)) -> Bool {
  case list.drop_while(chars, case_ignorable) {
    [c, ..] -> cased(c)
    [] -> False
  }
}

fn cased(c: String) -> Bool {
  string.lowercase(c) != c || string.uppercase(c) != c
}

fn case_ignorable(c: String) -> Bool {
  case string.to_utf_codepoints(c) {
    [cp] -> {
      let n = string.utf_codepoint_to_int(cp)
      list.contains(
        [0x27, 0x2E, 0x3A, 0xAD, 0xB7, 0x2018, 0x2019, 0x2024, 0x200C, 0x200D],
        n,
      )
      || { n >= 0x300 && n <= 0x36F }
      || { n >= 0x1AB0 && n <= 0x1AFF }
      || { n >= 0x1DC0 && n <= 0x1DFF }
      || { n >= 0x20D0 && n <= 0x20FF }
      || { n >= 0xFE20 && n <= 0xFE2F }
    }
    _ -> False
  }
}
