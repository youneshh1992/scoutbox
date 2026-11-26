//// TOTP (RFC 6238 over HOTP, RFC 4226: SHA-1, 6 digits, 30 s step) for staff MFA, with base32 secrets.
//// Tested against the RFC test vectors.

import gleam/bit_array
import gleam/crypto
import gleam/int
import gleam/list
import gleam/string
import scoutbox/platform/secrets

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

pub fn b32encode(bits: BitArray) -> String {
  let chars = string.to_graphemes(alphabet)
  encode_loop(bits, chars, "")
}

fn encode_loop(bits: BitArray, chars: List(String), acc: String) -> String {
  case bits {
    <<i:size(5), rest:bits>> ->
      encode_loop(rest, chars, acc <> char_at(chars, i))
    <<>> -> acc
    _ -> {
      // Fewer than five bits left: pad them on the right with zeros.
      let size = bit_array.bit_size(bits)
      let assert <<i:size(size)>> = bits
      acc <> char_at(chars, int.bitwise_shift_left(i, 5 - size))
    }
  }
}

fn char_at(chars: List(String), i: Int) -> String {
  let assert Ok(c) = list.drop(chars, i) |> list.first
  c
}

/// The bytes of a base32 secret. Characters outside the alphabet are skipped; trailing bits are dropped.
pub fn b32decode(text: String) -> BitArray {
  let values =
    string.uppercase(text)
    |> string.to_graphemes
    |> list.filter_map(fn(g) {
      case string.split_once(alphabet, g) {
        Ok(#(before, _)) -> Ok(string.length(before))
        Error(Nil) -> Error(Nil)
      }
    })
  let bits = list.fold(values, <<>>, fn(acc, v) { <<acc:bits, v:size(5)>> })
  let whole = bit_array.bit_size(bits) / 8
  let assert <<bytes:bytes-size(whole), _:bits>> = bits
  bytes
}

pub fn hotp(key: BitArray, counter: Int) -> String {
  let h = crypto.hmac(<<counter:size(64)>>, crypto.Sha1, key)
  let assert <<_:bytes-size(19), last>> = h
  let offset = int.bitwise_and(last, 0xf)
  let assert Ok(<<_:size(1), code:size(31)>>) = bit_array.slice(h, offset, 4)
  int.to_string(code % 1_000_000) |> string.pad_start(6, "0")
}

pub fn totp(secret_b32: String, now_ms: Int) -> String {
  hotp(b32decode(secret_b32), now_ms / 1000 / 30)
}

/// The current step or the one either side (clock drift), compared in constant time.
pub fn valid(secret_b32: String, code: String, now_ms: Int) -> Bool {
  list.any([-1, 0, 1], fn(skew) {
    secrets.equal(totp(secret_b32, now_ms + skew * 30_000), code)
  })
}
