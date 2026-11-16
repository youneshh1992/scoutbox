//// Random tokens, hashes and constant-time comparison.

import gleam/bit_array
import gleam/crypto
import gleam/list
import gleam/string

/// No 0/O, 1/I/L: a one-time code is read off a screen and typed.
const code_alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

/// `bytes` random bytes as lowercase hex.
pub fn random_hex(bytes: Int) -> String {
  crypto.strong_random_bytes(bytes) |> hex
}

pub fn sha256_hex(value: String) -> String {
  crypto.hash(crypto.Sha256, bit_array.from_string(value)) |> hex
}

pub fn hex(bits: BitArray) -> String {
  bit_array.base16_encode(bits) |> string.lowercase
}

/// A one-time code of `length` characters from the code alphabet, as the TypeScript server mints them (each
/// random byte modulo the alphabet's size).
pub fn random_code(length: Int) -> String {
  let alphabet = string.to_graphemes(code_alphabet)
  code_chars(crypto.strong_random_bytes(length), alphabet, "")
}

fn code_chars(bytes: BitArray, alphabet: List(String), acc: String) -> String {
  case bytes {
    <<b, rest:bytes>> -> {
      let assert [char, ..] = list.drop(alphabet, b % list.length(alphabet))
        as "a remainder is inside the alphabet"
      code_chars(rest, alphabet, acc <> char)
    }
    _ -> acc
  }
}

/// The stored form of a one-time code: the sha-256 of its trimmed, upper-cased text, so a code typed in lower
/// case or with spaces around it still matches.
pub fn code_hash(code: String) -> String {
  code |> string.trim |> string.uppercase |> sha256_hex
}

/// Equal text, compared in time that does not depend on where they differ.
pub fn equal(a: String, b: String) -> Bool {
  crypto.secure_compare(bit_array.from_string(a), bit_array.from_string(b))
}
