//// Random tokens, hashes and constant-time comparison.

import gleam/bit_array
import gleam/crypto
import gleam/string

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

/// Equal text, compared in time that does not depend on where they differ.
pub fn equal(a: String, b: String) -> Bool {
  crypto.secure_compare(bit_array.from_string(a), bit_array.from_string(b))
}
