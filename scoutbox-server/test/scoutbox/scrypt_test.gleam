//// scrypt agrees with Node's `crypto.scryptSync` on every key in test/fixtures/scrypt_cases.json (test vectors,
//// kept as they are), and verifies hashes the TypeScript server's `hashPassword` stored.

import gleam/bit_array
import gleam/dynamic/decode
import gleam/json
import gleam/list
import scoutbox/identity/passwords
import scoutbox/platform/scrypt.{Params}
import simplifile

type Derived {
  Derived(
    why: String,
    password: BitArray,
    salt: BitArray,
    params: scrypt.Params,
    length: Int,
    key: BitArray,
  )
}

type Stored {
  Stored(password: String, stored: String)
}

fn hex() -> decode.Decoder(BitArray) {
  use text <- decode.then(decode.string)
  case bit_array.base16_decode(text) {
    Ok(bits) -> decode.success(bits)
    Error(Nil) -> decode.failure(<<>>, "hex")
  }
}

fn cases() -> #(List(Derived), List(Stored)) {
  let assert Ok(text) = simplifile.read("test/fixtures/scrypt_cases.json")
  let derived = {
    use why <- decode.field("why", decode.string)
    use password <- decode.field("password", hex())
    use salt <- decode.field("salt", hex())
    use n <- decode.field("n", decode.int)
    use r <- decode.field("r", decode.int)
    use p <- decode.field("p", decode.int)
    use length <- decode.field("length", decode.int)
    use key <- decode.field("key", hex())
    decode.success(Derived(
      why:,
      password:,
      salt:,
      params: Params(n:, r:, p:),
      length:,
      key:,
    ))
  }
  let stored = {
    use password <- decode.field("password", hex())
    use stored <- decode.field("stored", decode.string)
    let assert Ok(password) = bit_array.to_string(password)
    decode.success(Stored(password:, stored:))
  }
  let assert Ok(cases) =
    json.parse(text, {
      use d <- decode.field("derived", decode.list(derived))
      use s <- decode.field("stored", decode.list(stored))
      decode.success(#(d, s))
    })
  cases
}

pub fn derived_keys_agree_with_node_test() {
  let #(derived, _) = cases()
  assert list.length(derived) > 40
  list.each(derived, fn(c) {
    let key = scrypt.derive_key(c.password, c.salt, c.params, c.length)
    assert #(c.why, key) == #(c.why, c.key)
  })
}

pub fn hashes_the_typescript_server_stored_verify_test() {
  let #(_, stored) = cases()
  list.each(stored, fn(s) {
    assert passwords.verify(s.password, s.stored)
    assert !passwords.verify(s.password <> "x", s.stored)
  })
}

pub fn a_hash_verifies_its_own_password_only_test() {
  let stored = passwords.hash("Synthetic-secret-1")
  assert passwords.verify("Synthetic-secret-1", stored)
  assert !passwords.verify("synthetic-secret-1", stored)
  assert !passwords.verify("Synthetic-secret-1", "plain text")
  assert stored != passwords.hash("Synthetic-secret-1")
}
