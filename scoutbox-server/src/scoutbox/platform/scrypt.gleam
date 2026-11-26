//// scrypt (RFC 7914) in pure Gleam: OTP's crypto has no scrypt, and the stored password hashes are the TypeScript
//// server's (`adapters.mjs`: Node's `crypto.scryptSync` with its defaults, N = 16384, r = 8, p = 1).
////
//// The BEAM has no mutable arrays, so ROMix's table V is one binary, read with constant-time slices. It is built as
//// a list of blocks joined once: appending each block to the growing binary copies it every time here (16 s a
//// hash, not 0.3), because BlockMix builds other binaries between the appends. A XOR of two blocks is one XOR of
//// two big integers.

import gleam/bit_array
import gleam/crypto
import gleam/int
import gleam/list

pub type Params {
  Params(n: Int, r: Int, p: Int)
}

/// Node's `scryptSync` defaults.
pub const node_defaults = Params(n: 16_384, r: 8, p: 1)

/// The derived key of `length` bytes. `params.n` must be a power of two greater than 1.
pub fn derive_key(
  password: BitArray,
  salt: BitArray,
  params: Params,
  length: Int,
) -> BitArray {
  let Params(n:, r:, p:) = params
  let block = 128 * r
  let b = pbkdf2_sha256_once(password, salt, p * block)
  let mixed = mix_blocks(b, block, r, n, <<>>)
  pbkdf2_sha256_once(password, mixed, length)
}

fn mix_blocks(
  b: BitArray,
  block: Int,
  r: Int,
  n: Int,
  acc: BitArray,
) -> BitArray {
  case b {
    <<chunk:bytes-size(block), rest:bytes>> ->
      mix_blocks(rest, block, r, n, <<acc:bits, ro_mix(chunk, r, n):bits>>)
    _ -> acc
  }
}

/// PBKDF2-HMAC-SHA256 with one iteration, which is all scrypt uses.
fn pbkdf2_sha256_once(
  password: BitArray,
  salt: BitArray,
  length: Int,
) -> BitArray {
  pbkdf2_blocks(password, salt, length, 1, <<>>)
}

fn pbkdf2_blocks(
  password: BitArray,
  salt: BitArray,
  length: Int,
  i: Int,
  acc: BitArray,
) -> BitArray {
  case bit_array.byte_size(acc) >= length {
    True -> {
      let assert <<out:bytes-size(length), _:bytes>> = acc
      out
    }
    False -> {
      let t = crypto.hmac(<<salt:bits, i:32>>, crypto.Sha256, password)
      pbkdf2_blocks(password, salt, length, i + 1, <<acc:bits, t:bits>>)
    }
  }
}

fn ro_mix(b: BitArray, r: Int, n: Int) -> BitArray {
  let #(x, v) = fill(b, r, n, [])
  let block = 128 * r
  lookups(x, v, r, n, block, n)
}

/// V[0..n-1] as one binary, and X after the last of them.
fn fill(
  x: BitArray,
  r: Int,
  i: Int,
  v: List(BitArray),
) -> #(BitArray, BitArray) {
  case i {
    0 -> #(x, bit_array.concat(list.reverse(v)))
    _ -> fill(block_mix(x, r), r, i - 1, [x, ..v])
  }
}

fn lookups(
  x: BitArray,
  v: BitArray,
  r: Int,
  n: Int,
  block: Int,
  i: Int,
) -> BitArray {
  case i {
    0 -> x
    _ -> {
      let j = integerify(x, block) % n
      let assert Ok(vj) = bit_array.slice(v, j * block, block)
      lookups(block_mix(xor(x, vj), r), v, r, n, block, i - 1)
    }
  }
}

/// The first 32-bit word of the last 64-byte chunk, little-endian. It is the low half of RFC 7914's 64-bit
/// Integerify, which is all that `mod n` reads when n is at most 2^32.
fn integerify(x: BitArray, block: Int) -> Int {
  let skip = block - 64
  let assert <<_:bytes-size(skip), word:32-little, _:bytes>> = x
  word
}

fn xor(a: BitArray, b: BitArray) -> BitArray {
  let size = bit_array.bit_size(a)
  let assert <<x:size(size)>> = a
  let assert <<y:size(size)>> = b
  <<int.bitwise_exclusive_or(x, y):size(size)>>
}

/// BlockMix with Salsa20/8: the even-numbered outputs, then the odd.
fn block_mix(b: BitArray, r: Int) -> BitArray {
  let skip = { 2 * r - 1 } * 64
  let assert <<_:bytes-size(skip), last:bytes-size(64)>> = b
  block_mix_chunks(b, last, <<>>, <<>>, True)
}

fn block_mix_chunks(
  b: BitArray,
  x: BitArray,
  even: BitArray,
  odd: BitArray,
  is_even: Bool,
) -> BitArray {
  case b {
    <<chunk:bytes-size(64), rest:bytes>> -> {
      let y = salsa20_8(xor(x, chunk))
      case is_even {
        True -> block_mix_chunks(rest, y, <<even:bits, y:bits>>, odd, False)
        False -> block_mix_chunks(rest, y, even, <<odd:bits, y:bits>>, True)
      }
    }
    _ -> <<even:bits, odd:bits>>
  }
}

const mask = 0xFFFFFFFF

fn bxor(a: Int, b: Int) -> Int {
  int.bitwise_exclusive_or(a, b)
}

fn rotl(v: Int, c: Int) -> Int {
  let v = int.bitwise_and(v, mask)
  int.bitwise_and(
    int.bitwise_or(
      int.bitwise_shift_left(v, c),
      int.bitwise_shift_right(v, 32 - c),
    ),
    mask,
  )
}

/// The Salsa20/8 core over one 64-byte chunk: sixteen little-endian words, four double rounds, the input added back.
fn salsa20_8(chunk: BitArray) -> BitArray {
  let assert <<
    a0:32-little,
    a1:32-little,
    a2:32-little,
    a3:32-little,
    a4:32-little,
    a5:32-little,
    a6:32-little,
    a7:32-little,
    a8:32-little,
    a9:32-little,
    a10:32-little,
    a11:32-little,
    a12:32-little,
    a13:32-little,
    a14:32-little,
    a15:32-little,
  >> = chunk
  let #(x0, x1, x2, x3, x4, x5, x6, x7, x8, x9, x10, x11, x12, x13, x14, x15) =
    double_rounds(
      4,
      a0,
      a1,
      a2,
      a3,
      a4,
      a5,
      a6,
      a7,
      a8,
      a9,
      a10,
      a11,
      a12,
      a13,
      a14,
      a15,
    )
  <<
    int.bitwise_and(x0 + a0, mask):32-little,
    int.bitwise_and(x1 + a1, mask):32-little,
    int.bitwise_and(x2 + a2, mask):32-little,
    int.bitwise_and(x3 + a3, mask):32-little,
    int.bitwise_and(x4 + a4, mask):32-little,
    int.bitwise_and(x5 + a5, mask):32-little,
    int.bitwise_and(x6 + a6, mask):32-little,
    int.bitwise_and(x7 + a7, mask):32-little,
    int.bitwise_and(x8 + a8, mask):32-little,
    int.bitwise_and(x9 + a9, mask):32-little,
    int.bitwise_and(x10 + a10, mask):32-little,
    int.bitwise_and(x11 + a11, mask):32-little,
    int.bitwise_and(x12 + a12, mask):32-little,
    int.bitwise_and(x13 + a13, mask):32-little,
    int.bitwise_and(x14 + a14, mask):32-little,
    int.bitwise_and(x15 + a15, mask):32-little,
  >>
}

/// Salsa20's column round then row round, `n` times (RFC 7914 section 3).
fn double_rounds(
  n: Int,
  x0: Int,
  x1: Int,
  x2: Int,
  x3: Int,
  x4: Int,
  x5: Int,
  x6: Int,
  x7: Int,
  x8: Int,
  x9: Int,
  x10: Int,
  x11: Int,
  x12: Int,
  x13: Int,
  x14: Int,
  x15: Int,
) -> #(
  Int,
  Int,
  Int,
  Int,
  Int,
  Int,
  Int,
  Int,
  Int,
  Int,
  Int,
  Int,
  Int,
  Int,
  Int,
  Int,
) {
  case n {
    0 -> #(x0, x1, x2, x3, x4, x5, x6, x7, x8, x9, x10, x11, x12, x13, x14, x15)
    _ -> {
      let x4 = bxor(x4, rotl(x0 + x12, 7))
      let x8 = bxor(x8, rotl(x4 + x0, 9))
      let x12 = bxor(x12, rotl(x8 + x4, 13))
      let x0 = bxor(x0, rotl(x12 + x8, 18))
      let x9 = bxor(x9, rotl(x5 + x1, 7))
      let x13 = bxor(x13, rotl(x9 + x5, 9))
      let x1 = bxor(x1, rotl(x13 + x9, 13))
      let x5 = bxor(x5, rotl(x1 + x13, 18))
      let x14 = bxor(x14, rotl(x10 + x6, 7))
      let x2 = bxor(x2, rotl(x14 + x10, 9))
      let x6 = bxor(x6, rotl(x2 + x14, 13))
      let x10 = bxor(x10, rotl(x6 + x2, 18))
      let x3 = bxor(x3, rotl(x15 + x11, 7))
      let x7 = bxor(x7, rotl(x3 + x15, 9))
      let x11 = bxor(x11, rotl(x7 + x3, 13))
      let x15 = bxor(x15, rotl(x11 + x7, 18))
      let x1 = bxor(x1, rotl(x0 + x3, 7))
      let x2 = bxor(x2, rotl(x1 + x0, 9))
      let x3 = bxor(x3, rotl(x2 + x1, 13))
      let x0 = bxor(x0, rotl(x3 + x2, 18))
      let x6 = bxor(x6, rotl(x5 + x4, 7))
      let x7 = bxor(x7, rotl(x6 + x5, 9))
      let x4 = bxor(x4, rotl(x7 + x6, 13))
      let x5 = bxor(x5, rotl(x4 + x7, 18))
      let x11 = bxor(x11, rotl(x10 + x9, 7))
      let x8 = bxor(x8, rotl(x11 + x10, 9))
      let x9 = bxor(x9, rotl(x8 + x11, 13))
      let x10 = bxor(x10, rotl(x9 + x8, 18))
      let x12 = bxor(x12, rotl(x15 + x14, 7))
      let x13 = bxor(x13, rotl(x12 + x15, 9))
      let x14 = bxor(x14, rotl(x13 + x12, 13))
      let x15 = bxor(x15, rotl(x14 + x13, 18))
      double_rounds(
        n - 1,
        x0,
        x1,
        x2,
        x3,
        x4,
        x5,
        x6,
        x7,
        x8,
        x9,
        x10,
        x11,
        x12,
        x13,
        x14,
        x15,
      )
    }
  }
}
