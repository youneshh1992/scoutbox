//// A child's device pairing codes (`pairing_codes`, repositories/oneTimeCodes.ts): one live code per child, for 15
//// minutes, used once. Only the code's hash is stored; the plain code exists in the guardian's response only.

import gleam/dynamic/decode
import gleam/list
import gleam/option.{type Option}
import gleam/result
import scoutbox/platform/secrets
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/id
import scoutbox/rows/pairing_codes as row
import sqlight

pub const ttl_ms = 900_000

/// A fresh code, returned once.
pub type Issued {
  Issued(code: String, expires_at: Int)
}

/// Replaces the child's code with a fresh one. The code is the lookup key, so a draw that equals another child's
/// live code is drawn again, never shared.
pub fn issue(tx: Tx, player: id.PlayerId, now: Int) -> Result(Issued, Fail(e)) {
  use _ <- result.try(
    store.run(tx, "DELETE FROM pairing_codes WHERE expires_at <= ?", [
      sqlight.int(now),
    ]),
  )
  use _ <- result.try(revoke_for(tx, player))
  draw(tx, player, now + ttl_ms, 8)
}

fn draw(
  tx: Tx,
  player: id.PlayerId,
  expires_at: Int,
  left: Int,
) -> Result(Issued, Fail(e)) {
  let code = secrets.random_code(6)
  let hash = secrets.code_hash(code)
  use taken <- result.try(by_hash(store.reading(tx), hash))
  case taken, left {
    Ok(_), 1 -> panic as "pairing codes: eight draws all matched a live code"
    Ok(_), _ -> draw(tx, player, expires_at, left - 1)
    Error(Nil), _ -> {
      use _ <- result.map(row.insert(
        tx,
        row.new(code_hash: hash, player_id: player, expires_at:),
      ))
      Issued(code:, expires_at:)
    }
  }
}

fn by_hash(read: Read, hash: String) -> Result(Result(row.Row, Nil), Fail(e)) {
  store.one(
    read,
    "SELECT " <> row.columns <> " FROM pairing_codes WHERE code_hash = ?",
    [sqlight.text(hash)],
    row.decoder(),
  )
}

/// The child a live code pairs, without using it.
pub fn live(
  read: Read,
  code: String,
  now: Int,
) -> Result(Option(id.PlayerId), Fail(e)) {
  use found <- result.map(by_hash(read, secrets.code_hash(code)))
  case found {
    Ok(r) if r.expires_at > now -> option.Some(r.player_id)
    _ -> option.None
  }
}

/// Uses a live code: its row goes, and the child it paired is returned. Meant for the pairing unit, so the code goes
/// exactly when the session it buys commits.
pub fn consume(
  tx: Tx,
  code: String,
  now: Int,
) -> Result(Option(id.PlayerId), Fail(e)) {
  store.write(
    tx,
    "DELETE FROM pairing_codes WHERE code_hash = ? AND expires_at > ? RETURNING player_id",
    [sqlight.text(secrets.code_hash(code)), sqlight.int(now)],
    decode.at([0], id.player_decoder()),
  )
  |> result.map(list.first)
  |> result.map(option.from_result)
}

/// Removes the child's codes, live or not.
pub fn revoke_for(tx: Tx, player: id.PlayerId) -> Result(Nil, Fail(e)) {
  store.run(tx, "DELETE FROM pairing_codes WHERE player_id = ?", [
    id.player_sql(player),
  ])
}
