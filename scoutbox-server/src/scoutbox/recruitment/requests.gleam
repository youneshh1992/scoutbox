//// Scout Inbox requests (`recruitment_requests`): an organisation asks to talk to a player, and contact unlocks
//// only on acceptance. A minor's request goes to the guardian, never the child.
////
//// Not ported yet: trial requests (their details, slots and the trials) and the Contact a recruitment Room
//// links to a request. This slice writes contact requests, answers them and suspends them.

import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/platform/ids
import scoutbox/platform/paging.{type Page, IntKey}
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/recruitment_requests as row
import scoutbox/vocab/org_type
import scoutbox/vocab/party
import sqlight

pub type Request =
  row.Row

pub type NewContact {
  NewContact(
    player_id: String,
    player_name: String,
    org_id: String,
    org_name: String,
    org_type: org_type.OrgType,
    org_verified: Bool,
    org_safeguarding_certified: Bool,
    org_trusted_partner: Bool,
    user_id: String,
    scout_name: String,
    scout_role: String,
    message: String,
    /// The guardian a minor's request goes to; `None` for an adult, who answers their own.
    guardian_id: Option(String),
    at: Int,
  )
}

pub fn create_contact(tx: Tx, new: NewContact) -> Result(Request, Fail(e)) {
  use id <- result.try(ids.next(tx, "req"))
  let routed_to = case new.guardian_id {
    Some(_) -> party.Guardian
    None -> party.Player
  }
  use rows <- result.map(store.write(
    tx,
    row.insert_sql <> " RETURNING " <> row.columns,
    row.values(
      row.Row(
        ..row.new(
          id:,
          player_id: new.player_id,
          org_id: new.org_id,
          org_name: new.org_name,
          org_verified: new.org_verified,
          org_safeguarding_certified: new.org_safeguarding_certified,
          user_id: new.user_id,
          type_: row.Contact,
          status: row.Pending,
          created_at: new.at,
          routed_to:,
        ),
        player_name: Some(new.player_name),
        org_type: Some(new.org_type),
        org_trusted_partner: Some(new.org_trusted_partner),
        scout_name: Some(new.scout_name),
        scout_role: Some(new.scout_role),
        message: Some(new.message),
        guardian_id: new.guardian_id,
      ),
    ),
    row.decoder(),
  ))
  let assert [request] = rows as "an INSERT … RETURNING returns its row"
  request
}

/// A pending request of this type from the organisation to the player, if one is still awaiting an answer.
pub fn pending_between(
  read: Read,
  org_id: String,
  player_id: String,
  type_: row.Type,
) -> Result(Option(Request), Fail(e)) {
  store.one(
    read,
    "SELECT "
      <> row.columns
      <> " FROM recruitment_requests WHERE org_id = ? AND player_id = ? AND type = ? AND status = 'pending' AND subject_removed_at IS NULL ORDER BY rowid LIMIT 1",
    [
      sqlight.text(org_id),
      sqlight.text(player_id),
      sqlight.text(row.type_to_string(type_)),
    ],
    row.decoder(),
  )
  |> result.map(option.from_result)
}

/// A club reported for safeguarding has its pending requests to the player suspended.
pub fn suspend_pending(
  tx: Tx,
  org_id: String,
  player_id: String,
) -> Result(Nil, Fail(e)) {
  store.run(
    tx,
    "UPDATE recruitment_requests SET status = 'suspended' WHERE org_id = ? AND player_id = ? AND status = 'pending'",
    [sqlight.text(org_id), sqlight.text(player_id)],
  )
}

/// Newest first, keyed by rowid.
fn page_where(
  read: Read,
  where: String,
  args: List(sqlight.Value),
  page: Page,
) -> Result(#(List(Request), Option(String)), Fail(e)) {
  let #(after, after_args) = case page.after {
    Some([IntKey(rid)]) -> #(" AND rowid < ?", [sqlight.int(rid)])
    _ -> #("", [])
  }
  use rows <- result.map(
    store.query(
      read,
      "SELECT "
        <> row.columns
        <> ", rowid FROM recruitment_requests WHERE "
        <> where
        <> after
        <> " ORDER BY rowid DESC LIMIT ?",
      list.flatten([args, after_args, [sqlight.int(page.limit + 1)]]),
      {
        use r <- decode.then(row.decoder())
        use rid <- decode.field(row.width, decode.int)
        decode.success(#(r, rid))
      },
    ),
  )
  let #(items, next) = paging.page_of(rows, page.limit, fn(p) { [IntKey(p.1)] })
  #(list.map(items, fn(p) { p.0 }), next)
}

/// A guardian's Inbox: the requests routed to the guardian about any of these players.
pub fn page_for_guardian_of(
  read: Read,
  player_ids: List(String),
  page: Page,
) -> Result(#(List(Request), Option(String)), Fail(e)) {
  case player_ids {
    [] -> Ok(#([], None))
    _ ->
      page_where(
        read,
        "player_id IN (SELECT value FROM json_each(?)) AND routed_to = 'guardian'",
        [json.array(player_ids, json.string) |> json.to_string |> sqlight.text],
        page,
      )
  }
}

/// A player's requests, oldest first (the data export).
pub fn for_player(
  read: Read,
  player_id: String,
) -> Result(List(Request), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> row.columns
      <> " FROM recruitment_requests WHERE player_id = ? ORDER BY rowid",
    [sqlight.text(player_id)],
    row.decoder(),
  )
}

pub fn count_for_org(
  read: Read,
  org_id: String,
  status: Option(row.Status),
) -> Result(Int, Fail(e)) {
  let #(filter, args) = case status {
    Some(s) -> #(" AND status = ?", [sqlight.text(row.status_to_string(s))])
    None -> #("", [])
  }
  store.one(
    read,
    "SELECT COUNT(*) FROM recruitment_requests WHERE org_id = ?" <> filter,
    [sqlight.text(org_id), ..args],
    decode.at([0], decode.int),
  )
  |> result.map(result.unwrap(_, 0))
}

/// What the recipient sees (requestForRecipient): no organisation id, staff id, Contact link or case id.
pub fn recipient_view(r: Request) -> Json {
  let opt = json.nullable(_, json.string)
  json.object([
    #("id", json.string(r.id)),
    #("playerId", json.string(r.player_id)),
    #("playerName", opt(r.player_name)),
    #("orgName", json.string(r.org_name)),
    #("orgType", opt(option.map(r.org_type, org_type.to_string))),
    #("orgVerified", json.bool(r.org_verified)),
    #("orgSafeguardingCertified", json.bool(r.org_safeguarding_certified)),
    #("trustedPartner", json.nullable(r.org_trusted_partner, json.bool)),
    #("scoutName", opt(r.scout_name)),
    #("scoutRole", opt(r.scout_role)),
    #("type", json.string(row.type_to_string(r.type_))),
    #("message", opt(r.message)),
    #("subject", opt(r.subject)),
    // Not ported yet: a trial request's details.
    #("trialDetails", json.null()),
    #("status", json.string(row.status_to_string(r.status))),
    #("createdAt", json.int(r.created_at)),
    #("respondedAt", json.nullable(r.responded_at, json.int)),
    #("respondedBy", opt(option.map(r.responded_by, party.to_string))),
    #("routedTo", json.string(party.to_string(r.routed_to))),
    #("guardianId", opt(r.guardian_id)),
    #("contactChannel", opt(r.contact_channel_id)),
    #("subjectRemovedAt", json.nullable(r.subject_removed_at, json.int)),
    #("trialId", opt(r.trial_id)),
  ])
}

pub fn by_id(read: Read, id: String) -> Result(Option(Request), Fail(e)) {
  store.one(
    read,
    "SELECT " <> row.columns <> " FROM recruitment_requests WHERE id = ?",
    [sqlight.text(id)],
    row.decoder(),
  )
  |> result.map(option.from_result)
}

/// Records the recipient's answer to a pending request.
pub fn record_response(
  tx: Tx,
  id: String,
  accept: Bool,
  by: party.Party,
  at: Int,
) -> Result(Nil, Fail(e)) {
  let status = case accept {
    True -> row.Accepted
    False -> row.Declined
  }
  store.run(
    tx,
    "UPDATE recruitment_requests SET status = ?, responded_at = ?, responded_by = ? WHERE id = ?",
    [
      sqlight.text(row.status_to_string(status)),
      sqlight.int(at),
      sqlight.text(party.to_string(by)),
      sqlight.text(id),
    ],
  )
}

/// Links the thread an accepted request opened.
pub fn attach_channel(
  tx: Tx,
  id: String,
  channel_id: String,
) -> Result(Nil, Fail(e)) {
  store.run(
    tx,
    "UPDATE recruitment_requests SET contact_channel_id = ? WHERE id = ?",
    [sqlight.text(channel_id), sqlight.text(id)],
  )
}
