//// The verification tokens, ported by hand from the TypeScript rules suites of verification/organisationsAndStaff
//// and verification/organisationsAndStaffAdversarial (scripts/rules/). Those suites check the token functions
//// over an array-backed store, which the recorder can't keep; here they run against the `ver_tokens` table.

import gleam/dynamic/decode
import gleam/erlang/process
import gleam/option.{None, Some}
import gleam/result
import gleam/string
import scoutbox/platform/store
import scoutbox/rows/ver_tokens as token_row
import scoutbox/support
import scoutbox/verification/core
import scoutbox/verification/records
import sqlight

const now = 1_800_000_000_000

fn fresh() {
  let sent = process.new_subject()
  support.fresh_store(process.send(sent, _))
}

fn mint(s, purpose, email, subject_id, ttl_ms) -> String {
  let assert Ok(secret) =
    store.unit(s, fn(tx) {
      core.mint_token(
        tx,
        purpose,
        email,
        None,
        subject_id,
        None,
        None,
        ttl_ms,
        now,
      )
      |> result.map(fn(secret) { #(secret, []) })
    })
  secret
}

fn peek(s, purpose, secret, email, subject_id) {
  let assert Ok(out) =
    store.read(s, core.peek_token(
      _,
      purpose,
      Some(secret),
      email,
      subject_id,
      now,
    ))
  out
}

/// consumeToken: peek, then spend on success only.
fn consume(s, purpose, secret, email, subject_id) {
  let assert Ok(out) =
    store.unit(s, fn(tx) {
      use out <- result.try(core.peek_token(
        store.reading(tx),
        purpose,
        Some(secret),
        email,
        subject_id,
        now,
      ))
      case out {
        Ok(t) ->
          records.use_token(tx, t.id, now) |> result.map(fn(_) { #(Ok(t), []) })
        Error(code) -> Ok(#(Error(code), []))
      }
    })
  out
}

fn stored_hashes(s) -> List(String) {
  let assert Ok(hashes) =
    store.read(s, store.query(
      _,
      "SELECT token_hash FROM ver_tokens",
      [],
      decode.at([0], decode.string),
    ))
  hashes
}

fn used(s, id: String) -> Bool {
  let assert Ok([used]) =
    store.read(s, store.query(
      _,
      "SELECT used_at IS NOT NULL FROM ver_tokens WHERE id = ?",
      [sqlight.text(id)],
      decode.at([0], sqlight.decode_bool()),
    ))
  used
}

const ttl = 1_800_000

// organisationsAndStaff: tokens are stored hashed, never in plain text
pub fn tokens_are_stored_hashed_never_in_plain_text_test() {
  let s = fresh()
  let secret = mint(s, token_row.WorkEmail, Some("a@club.com"), Some("u1"), ttl)
  let assert [hash] = stored_hashes(s)
  assert !string.contains(hash, secret)
  assert string.length(hash) == 64
}

// organisationsAndStaff: purpose binding enforced
pub fn purpose_binding_enforced_test() {
  let s = fresh()
  let secret = mint(s, token_row.WorkEmail, Some("a@club.com"), Some("u1"), ttl)
  assert consume(s, token_row.PlayerInvite, secret, None, None)
    == Error("TOKEN_WRONG_PURPOSE")
}

// organisationsAndStaff: account binding enforced (Alice token refused for Bob), address binding enforced,
// correct bindings consume the token, single use: replay refused (security case 5/11)
pub fn bindings_then_single_use_test() {
  let s = fresh()
  let secret = mint(s, token_row.WorkEmail, Some("a@club.com"), Some("u1"), ttl)
  assert consume(s, token_row.WorkEmail, secret, None, Some("u2"))
    == Error("TOKEN_WRONG_ACCOUNT")
  assert consume(s, token_row.WorkEmail, secret, Some("other@club.com"), None)
    == Error("TOKEN_WRONG_ADDRESS")
  let assert Ok(_) =
    consume(s, token_row.WorkEmail, secret, Some("a@club.com"), Some("u1"))
  assert consume(s, token_row.WorkEmail, secret, None, None)
    == Error("TOKEN_ALREADY_USED")
}

// organisationsAndStaff: expired token refused
pub fn expired_token_refused_test() {
  let s = fresh()
  let secret = mint(s, token_row.WorkEmail, None, None, -1)
  assert consume(s, token_row.WorkEmail, secret, None, None)
    == Error("TOKEN_EXPIRED")
}

// organisationsAndStaff: unknown token refused
pub fn unknown_token_refused_test() {
  let s = fresh()
  let _ = mint(s, token_row.WorkEmail, None, None, ttl)
  assert consume(s, token_row.WorkEmail, "guess", None, None)
    == Error("TOKEN_UNKNOWN")
}

// organisationsAndStaffAdversarial: peek validates WITHOUT consuming, peek enforces subject binding, consume marks
// used on success
pub fn peek_then_consume_test() {
  let s = fresh()
  let secret = mint(s, token_row.PlayerInvite, None, Some("alice"), ttl)
  let assert Ok(t) = peek(s, token_row.PlayerInvite, secret, None, None)
  assert !used(s, t.id)
  assert peek(s, token_row.PlayerInvite, secret, None, Some("bob"))
    == Error("TOKEN_WRONG_ACCOUNT")
  let assert Ok(_) =
    consume(s, token_row.PlayerInvite, secret, None, Some("alice"))
  assert used(s, t.id)
}

// organisationsAndStaffAdversarial: expired invite token refused
pub fn expired_invite_token_refused_test() {
  let s = fresh()
  let secret = mint(s, token_row.PlayerInvite, None, None, -1)
  assert peek(s, token_row.PlayerInvite, secret, None, None)
    == Error("TOKEN_EXPIRED")
}
