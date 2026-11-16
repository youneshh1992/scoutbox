//// Password hashes, stored as the TypeScript server stores them (`adapters.mjs`): `scrypt$<salt>$<hash>`, where the
//// salt is 16 random bytes as hex and that hex text itself is scrypt's salt, and the hash is 32 bytes as hex.
////
//// Not ported yet: the TypeScript server also accepts a stored value without the `scrypt$` prefix as plain text,
//// and upgrades it. No database this server opens holds one.

import gleam/bit_array
import gleam/string
import scoutbox/platform/scrypt
import scoutbox/platform/secrets

pub fn hash(password: String) -> String {
  let salt = secrets.random_hex(16)
  "scrypt$" <> salt <> "$" <> key_for(password, salt)
}

pub fn verify(password: String, stored: String) -> Bool {
  case string.split(stored, "$") {
    ["scrypt", salt, hash] -> secrets.equal(key_for(password, salt), hash)
    _ -> False
  }
}

fn key_for(password: String, salt: String) -> String {
  scrypt.derive_key(
    bit_array.from_string(password),
    bit_array.from_string(salt),
    scrypt.node_defaults,
    32,
  )
  |> secrets.hex
}
