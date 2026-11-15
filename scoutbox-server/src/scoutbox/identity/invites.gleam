//// Staff invitations (`org_invites`). The emailed code is stored only as its sha-256, and no response carries
//// the hash. A status moves only from `pending`, guarded in SQL, so two accepts of one code cannot both win.

import gleam/dynamic/decode.{type Decoder}
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option}
import gleam/result
import scoutbox/platform/ids
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/platform/vocabulary.{type Vocabulary}
import sqlight

pub const name_max = 80

pub const validity_ms = 604_800_000

pub type Status {
  Pending
  Accepted
  Revoked
  Expired
}

fn statuses() -> Vocabulary(Status) {
  vocabulary.new([
    #("pending", Pending),
    #("accepted", Accepted),
    #("revoked", Revoked),
    #("expired", Expired),
  ])
}

pub type Invite {
  Invite(
    id: String,
    org_id: String,
    email: String,
    name: String,
    role: String,
    status: Status,
    invited_by: Option(String),
    created_at: Int,
    expires_at: Int,
    accepted_at: Option(Int),
    revoked_at: Option(Int),
    user_id: Option(String),
  )
}

pub type InviteError {
  NotPending
}

const columns =
  "id, org_id, email, name, role, status, invited_by_name, created_at, expires_at, accepted_at, revoked_at, user_id"

fn decoder() -> Decoder(Invite) {
  use id <- decode.field(0, decode.string)
  use org_id <- decode.field(1, decode.string)
  use email <- decode.field(2, decode.string)
  use name <- decode.field(3, decode.string)
  use role <- decode.field(4, decode.string)
  use status <- decode.field(5, vocabulary.decoder(statuses()))
  use invited_by <- decode.field(6, decode.optional(decode.string))
  use created_at <- decode.field(7, decode.int)
  use expires_at <- decode.field(8, decode.int)
  use accepted_at <- decode.field(9, decode.optional(decode.int))
  use revoked_at <- decode.field(10, decode.optional(decode.int))
  use user_id <- decode.field(11, decode.optional(decode.string))
  decode.success(Invite(
    id:,
    org_id:,
    email:,
    name:,
    role:,
    status:,
    invited_by:,
    created_at:,
    expires_at:,
    accepted_at:,
    revoked_at:,
    user_id:,
  ))
}

pub type NewInvite {
  NewInvite(
    org_id: String,
    email: String,
    name: String,
    role: String,
    token_hash: String,
    invited_by: Option(String),
    at: Int,
  )
}

pub fn create(tx: Tx, new: NewInvite) -> Result(Invite, Fail(e)) {
  use id <- result.try(ids.next(tx, "inv"))
  use rows <- result.try(store.write(
    tx,
    "INSERT INTO org_invites (id, org_id, email, name, role, token_hash, status, invited_by_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?) RETURNING "
      <> columns,
    [
      sqlight.text(id),
      sqlight.text(new.org_id),
      sqlight.text(new.email),
      sqlight.text(new.name),
      sqlight.text(new.role),
      sqlight.text(new.token_hash),
      sqlight.nullable(sqlight.text, new.invited_by),
      sqlight.int(new.at),
      sqlight.int(new.at + validity_ms),
    ],
    decoder(),
  ))
  let assert [invite] = rows as "an INSERT … RETURNING returns its row"
  Ok(invite)
}

pub fn by_token_hash(
  read: Read,
  hash: String,
) -> Result(Option(Invite), Fail(e)) {
  store.one(
    read,
    "SELECT " <> columns <> " FROM org_invites WHERE token_hash = ?",
    [sqlight.text(hash)],
    decoder(),
  )
  |> result.map(option.from_result)
}

fn move(
  tx: Tx,
  id: String,
  set: String,
  args: List(sqlight.Value),
) -> Result(Invite, Fail(InviteError)) {
  use rows <- result.try(store.write(
    tx,
    "UPDATE org_invites SET "
      <> set
      <> " WHERE id = ? AND status = 'pending' RETURNING "
      <> columns,
    list.append(args, [sqlight.text(id)]),
    decoder(),
  ))
  case rows {
    [invite] -> Ok(invite)
    _ -> store.refuse(NotPending)
  }
}

pub fn accept(
  tx: Tx,
  id: String,
  user_id user_id: String,
  at at: Int,
) -> Result(Invite, Fail(InviteError)) {
  move(tx, id, "status = 'accepted', user_id = ?, accepted_at = ?", [
    sqlight.text(user_id),
    sqlight.int(at),
  ])
}

pub fn expire(tx: Tx, id: String) -> Result(Invite, Fail(InviteError)) {
  move(tx, id, "status = 'expired'", [])
}

pub fn view(i: Invite) -> Json {
  let opt_int = json.nullable(_, json.int)
  json.object([
    #("id", json.string(i.id)),
    #("orgId", json.string(i.org_id)),
    #("email", json.string(i.email)),
    #("name", json.string(i.name)),
    #("role", json.string(i.role)),
    #("status", json.string(vocabulary.name(statuses(), i.status))),
    #("invitedBy", json.nullable(i.invited_by, json.string)),
    #("createdAt", json.int(i.created_at)),
    #("expiresAt", json.int(i.expires_at)),
    #("acceptedAt", opt_int(i.accepted_at)),
    #("revokedAt", opt_int(i.revoked_at)),
    #("userId", json.nullable(i.user_id, json.string)),
  ])
}
