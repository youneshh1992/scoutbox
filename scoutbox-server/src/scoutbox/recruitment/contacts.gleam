//// Recruitment contacts (`recruitment_contacts`, its attempts and history; repositories/recruitmentContactsOffers.ts):
//// a contact is created whole, then changes only through named acts, each guarded on the statuses
//// `CONTACT_TRANSITIONS` lead from. An act checked before its unit that finds the contact elsewhere lost a race:
//// it answers stale.

import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/messaging/notifications
import scoutbox/platform/sql
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/recruitment/cases
import scoutbox/recruitment/contact_rules.{type Contact, Contact}
import scoutbox/recruitment/recipients.{type Recipient}
import scoutbox/rows/contact_attempts as attempt_row
import scoutbox/rows/contact_history as history_row
import scoutbox/rows/id
import scoutbox/rows/recruitment_contacts as row
import scoutbox/vocab/audience
import scoutbox/vocab/contact_mode.{type ContactMode}
import scoutbox/vocab/party
import sqlight

// ------------------------------------------------------------------------------------------------------ reads

fn decorate(read: Read, rows: List(row.Row)) -> Result(List(Contact), Fail(e)) {
  list.try_map(rows, fn(r) {
    let cid = id.contact_sql(r.id)
    use attempts <- result.try(store.query(
      read,
      "SELECT "
        <> attempt_row.columns
        <> " FROM contact_attempts WHERE contact_id = ? ORDER BY position",
      [cid],
      attempt_row.decoder(),
    ))
    use history <- result.map(store.query(
      read,
      "SELECT "
        <> history_row.columns
        <> " FROM contact_history WHERE contact_id = ? ORDER BY position",
      [cid],
      history_row.decoder(),
    ))
    Contact(row: r, attempts:, history:)
  })
}

fn select(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(List(Contact), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> row.columns
      <> " FROM recruitment_contacts WHERE "
      <> where
      <> " ORDER BY rowid",
    args,
    row.decoder(),
  ))
  decorate(read, rows)
}

pub fn by_id(
  read: Read,
  contact_id: id.ContactId,
) -> Result(Option(Contact), Fail(e)) {
  use found <- result.map(select(read, "id = ?", [id.contact_sql(contact_id)]))
  list.first(found) |> option.from_result
}

pub fn for_case(
  read: Read,
  case_id: id.RecruitmentCaseId,
) -> Result(List(Contact), Fail(e)) {
  select(read, "case_id = ?", [id.recruitment_case_sql(case_id)])
}

/// The contacts of several cases (a player's journeys), in insertion order.
pub fn for_cases(
  read: Read,
  case_ids: List(id.RecruitmentCaseId),
) -> Result(List(Contact), Fail(e)) {
  case case_ids {
    [] -> Ok([])
    _ ->
      select(
        read,
        "case_id IN ("
          <> string.join(list.map(case_ids, fn(_) { "?" }), ", ")
          <> ")",
        list.map(case_ids, id.recruitment_case_sql),
      )
  }
}

pub fn for_org_player(
  read: Read,
  org_id: id.OrgId,
  player_id: id.PlayerId,
) -> Result(List(Contact), Fail(e)) {
  select(read, "org_id = ? AND player_id = ?", [
    id.org_sql(org_id),
    id.player_sql(player_id),
  ])
}

// ------------------------------------------------------------------------------------------------ bookkeeping

pub type Actor {
  Staff(user_id: id.OrgUserId, name: String)
  Recipient(kind: party.Party, name: String)
}

pub type Entry {
  Entry(
    id: id.ContactEventId,
    at: Int,
    action: String,
    by: Actor,
    detail: Option(Json),
  )
}

pub fn entry(
  tx: Tx,
  action: String,
  by: Actor,
  detail: Option(List(#(String, Json))),
  at: Int,
) -> Result(Entry, Fail(e)) {
  use event <- result.map(id.next_contact_event(tx))
  Entry(event, at, action, by, option.map(detail, json.object))
}

/// What an act leaves on its contact: `updated_at` touched, a rev bump (by a staff member, or nobody for the
/// recipient) and history.
pub type Acted {
  Acted(
    at: Int,
    rev_by: Option(#(id.OrgUserId, String)),
    touch: Bool,
    bump: Bool,
    history: List(Entry),
  )
}

fn next_position(
  tx: Tx,
  table: String,
  contact_id: id.ContactId,
) -> Result(Int, Fail(e)) {
  store.one(
    store.reading(tx),
    "SELECT COALESCE(MAX(position) + 1, 0) FROM "
      <> table
      <> " WHERE contact_id = ?",
    [id.contact_sql(contact_id)],
    decode.at([0], decode.int),
  )
  |> result.map(result.unwrap(_, 0))
}

fn append_history(
  tx: Tx,
  contact_id: id.ContactId,
  history: List(Entry),
) -> Result(Nil, Fail(e)) {
  list.try_each(history, fn(h) {
    use position <- result.try(next_position(tx, "contact_history", contact_id))
    let #(kind, user, name) = case h.by {
      Staff(user, name) -> #(history_row.Org, Some(user), name)
      Recipient(party.Player, name) -> #(history_row.Player, None, name)
      Recipient(party.Guardian, name) -> #(history_row.Guardian, None, name)
    }
    history_row.insert(
      tx,
      history_row.Row(
        ..history_row.new(
          id: h.id,
          contact_id:,
          position:,
          at: h.at,
          action: h.action,
        ),
        by_kind: Some(kind),
        by_user_id: user,
        by_name: Some(name),
        detail_json: option.map(h.detail, json.to_string),
      ),
    )
  })
}

fn apply(
  tx: Tx,
  contact_id: id.ContactId,
  acted: Acted,
) -> Result(Nil, Fail(e)) {
  let cid = id.contact_sql(contact_id)
  use _ <- result.try(case acted.bump {
    False -> Ok(Nil)
    True ->
      store.run(
        tx,
        "UPDATE recruitment_contacts SET rev = rev + 1, rev_at = ?, rev_by_user_id = ?, rev_by_name = ? WHERE id = ?",
        [
          sqlight.int(acted.at),
          case acted.rev_by {
            Some(#(user, _)) -> id.org_user_sql(user)
            None -> sqlight.null()
          },
          case acted.rev_by {
            Some(#(_, name)) -> sqlight.text(name)
            None -> sqlight.null()
          },
          cid,
        ],
      )
  })
  use _ <- result.try(case acted.touch {
    False -> Ok(Nil)
    True ->
      store.run(
        tx,
        "UPDATE recruitment_contacts SET updated_at = ? WHERE id = ?",
        [sqlight.int(acted.at), cid],
      )
  })
  append_history(tx, contact_id, acted.history)
}

fn reload(tx: Tx, contact_id: id.ContactId) -> Result(Contact, Fail(e)) {
  use found <- result.map(by_id(store.reading(tx), contact_id))
  let assert Some(c) = found as "an act's contact reads back"
  c
}

/// The act's own UPDATE, only while the contact's status is one of `from`; elsewhere a race moved it first.
fn move(
  tx: Tx,
  contact_id: id.ContactId,
  from: List(row.Status),
  set: sql.Fragment,
  acted: Acted,
) -> Result(Contact, Fail(e)) {
  let statuses =
    list.map(from, fn(s) { sql.arg(sqlight.text(row.status_to_string(s))) })
  let update =
    sql.concat([
      sql.text("UPDATE recruitment_contacts SET "),
      set,
      sql.text(" WHERE id = "),
      sql.arg(id.contact_sql(contact_id)),
      sql.text(" AND status IN ("),
      sql.join(statuses, ", "),
      sql.text(") RETURNING id"),
    ])
  use touched <- result.try(store.write(
    tx,
    update.sql,
    update.args,
    decode.at([0], decode.string),
  ))
  case touched {
    [_] -> {
      use _ <- result.try(apply(tx, contact_id, acted))
      reload(tx, contact_id)
    }
    _ ->
      store.stale(
        "recruitment_contacts " <> id.contact_to_string(contact_id) <> " moved",
      )
  }
}

fn assign(pairs: List(#(String, sqlight.Value))) -> sql.Fragment {
  pairs
  |> list.map(fn(p) { sql.concat([sql.text(p.0 <> " = "), sql.arg(p.1)]) })
  |> sql.join(", ")
}

fn text(v: Option(String)) -> sqlight.Value {
  option.map(v, sqlight.text) |> option.unwrap(sqlight.null())
}

fn staff_cols(prefix: String, by: Actor) -> List(#(String, sqlight.Value)) {
  case by {
    Staff(user, name) -> [
      #(prefix <> "_user_id", id.org_user_sql(user)),
      #(prefix <> "_name", sqlight.text(name)),
    ]
    Recipient(..) -> []
  }
}

fn recipient_cols(r: Recipient) -> List(#(String, sqlight.Value)) {
  [
    #("recipient_type", sqlight.text(party.to_string(r.kind))),
    #("recipient_player_id", id.player_sql(r.player_id)),
    #(
      "recipient_guardian_id",
      option.map(r.guardian_id, id.guardian_sql)
        |> option.unwrap(sqlight.null()),
    ),
    #("recipient_minor", sqlight.bool(r.minor)),
  ]
}

const editable = [row.Draft, row.StatusFailed]

// ----------------------------------------------------------------------------------------------------- writes

/// A new contact, whole: a club's draft or external record.
pub fn create(
  tx: Tx,
  r: row.Row,
  history: List(Entry),
) -> Result(Contact, Fail(e)) {
  use _ <- result.try(row.insert(tx, r))
  use _ <- result.try(append_history(tx, r.id, history))
  reload(tx, r.id)
}

/// Change the words or the mode of a contact that has not been delivered.
pub fn edit_draft(
  tx: Tx,
  contact_id: id.ContactId,
  subject: Option(String),
  body: String,
  mode: ContactMode,
  acted: Acted,
) -> Result(Contact, Fail(e)) {
  move(
    tx,
    contact_id,
    editable,
    assign([
      #("subject", text(subject)),
      #("body", sqlight.text(body)),
      #("contact_mode", sqlight.text(contact_mode.to_string(mode))),
    ]),
    acted,
  )
}

pub fn cancel(
  tx: Tx,
  contact_id: id.ContactId,
  by: Actor,
  acted: Acted,
) -> Result(Contact, Fail(e)) {
  move(
    tx,
    contact_id,
    editable,
    assign([
      #("status", sqlight.text("cancelled")),
      #("cancelled_at", sqlight.int(acted.at)),
      ..staff_cols("cancelled_by", by)
    ]),
    acted,
  )
}

fn add_attempt(
  tx: Tx,
  contact_id: id.ContactId,
  at: Int,
  ok: Bool,
  code: Option(String),
) -> Result(Nil, Fail(e)) {
  use position <- result.try(next_position(tx, "contact_attempts", contact_id))
  attempt_row.insert(
    tx,
    attempt_row.Row(contact_id:, position:, at:, ok:, code:),
  )
}

/// A send's key: the client's (if any) and the contact it was bound to.
pub type SendKey {
  SendKey(key: Option(String), fp: String)
}

/// A send the transport refused: the contact is `failed`, with the attempt.
pub fn record_send_failure(
  tx: Tx,
  contact_id: id.ContactId,
  send_key: SendKey,
  code: String,
  acted: Acted,
) -> Result(Contact, Fail(e)) {
  use _ <- result.try(add_attempt(tx, contact_id, acted.at, False, Some(code)))
  move(
    tx,
    contact_id,
    editable,
    assign([
      #("status", sqlight.text("failed")),
      #("failed_at", sqlight.int(acted.at)),
      #("failure_code", sqlight.text(code)),
      #("send_key", text(send_key.key)),
      #("send_fp", sqlight.text(send_key.fp)),
    ]),
    acted,
  )
}

pub type Delivery {
  Delivery(
    by: Actor,
    send_key: SendKey,
    recipient: Recipient,
    request_id: id.RequestId,
    routing: contact_rules.Routing,
    email_copy: Option(#(row.EmailCopyState, Int)),
  )
}

/// A delivered send: the recipient it reached, the request row that carries it, who was routed and the email
/// copy's first state.
pub fn record_delivery(
  tx: Tx,
  contact_id: id.ContactId,
  d: Delivery,
  acted: Acted,
) -> Result(Contact, Fail(e)) {
  let at = acted.at
  let guardian = d.recipient.kind == party.Guardian
  use _ <- result.try(add_attempt(tx, contact_id, at, True, None))
  move(
    tx,
    contact_id,
    editable,
    assign(
      list.flatten([
        [
          #("status", sqlight.text("delivered")),
          #("send_key", text(d.send_key.key)),
          #("send_fp", sqlight.text(d.send_key.fp)),
        ],
        recipient_cols(d.recipient),
        [#("request_id", id.request_sql(d.request_id))],
        staff_cols("sent_by", d.by),
        [
          #("sent_at", sqlight.int(at)),
          #("delivered_at", sqlight.int(at)),
          #("failed_at", sqlight.null()),
          #("failure_code", sqlight.null()),
          #("routing_at", sqlight.int(at)),
          #(
            "routing_mode",
            sqlight.text(contact_mode.to_string(d.routing.mode)),
          ),
          #("routing_player", sqlight.bool(True)),
          #("routing_guardian", sqlight.bool(guardian)),
          #(
            "routing_agent_user_id",
            option.map(d.routing.agent, fn(a) {
              id.org_user_sql(a.agent_user_id)
            })
              |> option.unwrap(sqlight.null()),
          ),
          #(
            "routing_agent_agreement_id",
            option.map(d.routing.agent, fn(a) {
              id.agreement_sql(a.agreement_id)
            })
              |> option.unwrap(sqlight.null()),
          ),
          #("routing_honest", sqlight.text(contact_rules.routing_honest)),
        ],
        email_copy_cols(d.email_copy),
      ]),
    ),
    acted,
  )
}

fn email_copy_cols(
  copy: Option(#(row.EmailCopyState, Int)),
) -> List(#(String, sqlight.Value)) {
  case copy {
    None -> [
      #("email_copy_state", sqlight.null()),
      #("email_copy_to", sqlight.null()),
      #("email_copy_outbox_id", sqlight.null()),
      #("email_copy_at", sqlight.null()),
    ]
    Some(#(state, at)) -> [
      #("email_copy_state", sqlight.text(row.email_copy_state_to_string(state))),
      #("email_copy_to", sqlight.text("guardian")),
      #("email_copy_outbox_id", sqlight.null()),
      #("email_copy_at", sqlight.int(at)),
    ]
  }
}

/// What the case's lifecycle did with the act that delivered or recorded a contact.
pub type Lifecycle {
  Applied(from: String, to: String, at: Int)
  NotApplied(reason: String, at: Int)
}

/// The second half of a send or a record: the lifecycle's answer, after the case was asked to move.
pub fn record_lifecycle(
  tx: Tx,
  contact_id: id.ContactId,
  lifecycle: Lifecycle,
) -> Result(Contact, Fail(e)) {
  let #(applied, from, to, reason, at) = case lifecycle {
    Applied(from, to, at) -> #(True, Some(from), Some(to), None, at)
    NotApplied(reason, at) -> #(False, None, None, Some(reason), at)
  }
  use _ <- result.try(
    store.run(
      tx,
      "UPDATE recruitment_contacts SET lifecycle_applied = ?, lifecycle_from = ?, lifecycle_to = ?, lifecycle_reason = ?, lifecycle_at = ? WHERE id = ?",
      [
        sqlight.bool(applied),
        text(from),
        text(to),
        text(reason),
        sqlight.int(at),
        id.contact_sql(contact_id),
      ],
    ),
  )
  reload(tx, contact_id)
}

/// The recipient's answer, through the request row the send created.
pub fn record_response(
  tx: Tx,
  contact_id: id.ContactId,
  kind: row.ResponseKind,
  message: Option(String),
  by: party.Party,
  acted: Acted,
) -> Result(Contact, Fail(e)) {
  move(
    tx,
    contact_id,
    [row.Delivered],
    assign([
      #("status", sqlight.text("responded")),
      #("responded_at", sqlight.int(acted.at)),
      #("response_kind", sqlight.text(row.response_kind_to_string(kind))),
      #("response_message", text(message)),
      #("response_by", sqlight.text(party.to_string(by))),
      #("response_at", sqlight.int(acted.at)),
    ]),
    acted,
  )
}

/// The mailer's answer about the guardian copy, after the send committed.
pub fn set_email_copy(
  tx: Tx,
  contact_id: id.ContactId,
  state: row.EmailCopyState,
  outbox_id: Option(String),
  at: Int,
) -> Result(Nil, Fail(e)) {
  store.run(
    tx,
    "UPDATE recruitment_contacts SET email_copy_state = ?, email_copy_to = 'guardian', email_copy_outbox_id = ?, email_copy_at = ? WHERE id = ?",
    [
      sqlight.text(row.email_copy_state_to_string(state)),
      text(outbox_id),
      sqlight.int(at),
      id.contact_sql(contact_id),
    ],
  )
}

/// The deletion unit: the player's own words leave the contacts about them (the reply message); the records stay.
pub fn redact_player(tx: Tx, player_id: id.PlayerId) -> Result(Nil, Fail(e)) {
  store.run(
    tx,
    "UPDATE recruitment_contacts SET response_message = NULL WHERE player_id = ? AND response_message IS NOT NULL",
    [id.player_sql(player_id)],
  )
}

/// The recipient never addresses the Contact: their answer to the request the send created reaches it in the
/// respond route's unit, so both commit together. A request that carries no contact, or one no longer awaiting an
/// answer, is left alone. The room's owner and lead scout hear, if they are not the sender (who hears through the
/// respond route); nobody else in the organisation does.
///
/// Not ported yet: the live 'contact_responded' event.
pub fn on_request_responded(
  tx: Tx,
  request_id: id.RequestId,
  contact_id: Option(id.ContactId),
  sender: id.OrgUserId,
  accept: Bool,
  message: Option(String),
  by: party.Party,
  at: Int,
) -> Result(Nil, Fail(e)) {
  case contact_id {
    None -> Ok(Nil)
    Some(cid) -> {
      use found <- result.try(by_id(store.reading(tx), cid))
      case found {
        Some(c)
          if c.row.request_id == Some(request_id)
          && c.row.status == row.Delivered
        -> {
          let #(kind, outcome) = case accept {
            True -> #(row.Accepted, "accepted")
            False -> #(row.Declined, "declined")
          }
          let name = case by {
            party.Guardian -> "Guardian"
            party.Player -> "Player"
          }
          use h <- result.try(entry(
            tx,
            "contact_responded",
            Recipient(by, name),
            Some([#("kind", json.string(outcome))]),
            at,
          ))
          use _ <- result.try(record_response(
            tx,
            cid,
            kind,
            message,
            by,
            Acted(at:, rev_by: None, touch: True, bump: True, history: [h]),
          ))
          use room <- result.try(cases.room(store.reading(tx), c.row.case_id))
          case room {
            None -> Ok(Nil)
            Some(room) -> {
              let told =
                [Some(room.row.owner_user_id), room.row.room_lead_scout_user_id]
                |> option.values
                |> list.unique
                |> list.filter(fn(u) { u != sender })
              list.try_each(told, fn(u) {
                notifications.notify(
                  tx,
                  to: audience.OrgUser,
                  id: id.org_user_to_string(u),
                  type_: "recruitment_room",
                  text: "Recruitment Room — "
                    <> option.unwrap(room.row.player_name, "a removed player")
                    <> ": the "
                    <> party.to_string(by)
                    <> " "
                    <> outcome
                    <> " your contact.",
                  ref_id: Some(id.recruitment_case_to_string(room.row.id)),
                  at:,
                )
              })
            }
          }
        }
        _ -> Ok(Nil)
      }
    }
  }
}
