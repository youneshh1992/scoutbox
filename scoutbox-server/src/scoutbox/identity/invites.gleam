//// Staff invitations (`org_invites`). The emailed code is stored only as its sha-256, and no response carries
//// the hash. A status moves only from `pending`, guarded in SQL, so two accepts of one code cannot both win.

import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option}
import gleam/result
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/id
import scoutbox/rows/org_invites as row
import sqlight

pub const name_max = 80

pub const validity_ms = 604_800_000

pub type Status =
  row.Status

/// The row: the code's hash is on it, and no response carries it.
pub type Invite =
  row.Row

pub type InviteError {
  NotPending
}

pub type NewInvite {
  NewInvite(
    org_id: id.OrgId,
    email: String,
    name: String,
    role: String,
    token_hash: String,
    invited_by: Option(String),
    at: Int,
  )
}

pub fn create(tx: Tx, new: NewInvite) -> Result(Invite, Fail(e)) {
  use id <- result.try(id.next_org_invite(tx))
  use rows <- result.try(store.write(
    tx,
    row.insert_sql <> " RETURNING " <> row.columns,
    row.values(
      row.Row(
        ..row.new(
          id:,
          org_id: new.org_id,
          email: new.email,
          name: new.name,
          role: new.role,
          token_hash: new.token_hash,
          status: row.Pending,
          created_at: new.at,
          expires_at: new.at + validity_ms,
        ),
        invited_by_name: new.invited_by,
      ),
    ),
    row.decoder(),
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
    "SELECT " <> row.columns <> " FROM org_invites WHERE token_hash = ?",
    [sqlight.text(hash)],
    row.decoder(),
  )
  |> result.map(option.from_result)
}

fn move(
  tx: Tx,
  id: id.OrgInviteId,
  set: String,
  args: List(sqlight.Value),
) -> Result(Invite, Fail(InviteError)) {
  use rows <- result.try(store.write(
    tx,
    "UPDATE org_invites SET "
      <> set
      <> " WHERE id = ? AND status = 'pending' RETURNING "
      <> row.columns,
    list.append(args, [id.org_invite_sql(id)]),
    row.decoder(),
  ))
  case rows {
    [invite] -> Ok(invite)
    _ -> store.refuse(NotPending)
  }
}

pub fn accept(
  tx: Tx,
  id: id.OrgInviteId,
  user_id user_id: id.OrgUserId,
  at at: Int,
) -> Result(Invite, Fail(InviteError)) {
  move(tx, id, "status = 'accepted', user_id = ?, accepted_at = ?", [
    id.org_user_sql(user_id),
    sqlight.int(at),
  ])
}

pub fn expire(tx: Tx, id: id.OrgInviteId) -> Result(Invite, Fail(InviteError)) {
  move(tx, id, "status = 'expired'", [])
}

pub fn view(i: Invite) -> Json {
  let opt_int = json.nullable(_, json.int)
  json.object([
    #("id", id.org_invite_json(i.id)),
    #("orgId", id.org_json(i.org_id)),
    #("email", json.string(i.email)),
    #("name", json.string(i.name)),
    #("role", json.string(i.role)),
    #("status", row.status_to_json(i.status)),
    #("invitedBy", json.nullable(i.invited_by_name, json.string)),
    #("createdAt", json.int(i.created_at)),
    #("expiresAt", json.int(i.expires_at)),
    #("acceptedAt", opt_int(i.accepted_at)),
    #("revokedAt", opt_int(i.revoked_at)),
    #("userId", json.nullable(i.user_id, id.org_user_json)),
  ])
}
