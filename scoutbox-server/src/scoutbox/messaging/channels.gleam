//// Message threads (`channels`, `messages`, `message_attachments`; repositories/channels.ts). A thread exists only
//// because a request was accepted, one per request. For a minor the counterparty is the guardian; the child is
//// never in the thread.
////
//// A thread's `last_activity_at` is its creation time, then its newest message's, and orders the inboxes.

import gleam/dict
import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/platform/input
import scoutbox/platform/paging.{type Page, IntKey}
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/recruitment/requests.{type Request}
import scoutbox/rows/channels as row
import scoutbox/rows/id
import scoutbox/rows/message_attachments as attachment_row
import scoutbox/rows/messages as message_row
import scoutbox/vocab/audience.{type Audience}
import scoutbox/vocab/party
import sqlight

pub const text_max = 4000

pub const client_msg_id_max = 64

pub const id_max = 80

const name_max = 200

pub type Message {
  Message(row: message_row.Row, attachment: Option(attachment_row.Row))
}

pub type Thread {
  Thread(row: row.Row, messages: List(Message))
}

/// Who wrote a message: a staff member (`OrgUser`), the player or the guardian.
pub type Sender {
  Sender(kind: Audience, id: String, name: String)
}

/// Which receipt a reader stamps.
pub type Side {
  OrgSide
  CounterpartySide
}

/// Names have no limit at sign-up: a thread keeps them shortened, never refused.
fn thread_name(name: String) -> String {
  case input.utf16_length(name) > name_max {
    True -> input.utf16_take(name, name_max)
    False -> name
  }
}

/// Opens the thread of an accepted request, inside the answer's unit.
pub fn open(tx: Tx, request: Request, at: Int) -> Result(row.Row, Fail(e)) {
  use id <- result.try(id.next_channel(tx))
  use _ <- result.try(row.insert(
    tx,
    row.New(
      ..row.new(
        id:,
        request_id: request.id,
        player_id: request.player_id,
        org_id: request.org_id,
        org_name: thread_name(request.org_name),
        counterparty: request.routed_to,
        created_at: at,
        last_activity_at: at,
      ),
      player_name: option.map(request.player_name, thread_name),
      org_verified: Some(request.org_verified),
      scout_name: option.map(request.scout_name, thread_name),
      scout_role: option.map(request.scout_role, thread_name),
      guardian_id: request.guardian_id,
    ),
  ))
  use found <- result.map(by_id(store.reading(tx), id))
  let assert Some(t) = found as "a thread reads back in its own unit"
  t.row
}

fn select(where: String) -> String {
  "SELECT " <> row.columns <> " FROM channels " <> where
}

/// Ids as a JSON array, for `json_each(?)`.
fn ids_json(ids: List(a), to_json: fn(a) -> json.Json) -> sqlight.Value {
  json.array(ids, to_json) |> json.to_string |> sqlight.text
}

/// Thread rows with their messages and attachments, read in one batch each.
fn with_messages(
  read: Read,
  rows: List(row.Row),
) -> Result(List(Thread), Fail(e)) {
  let channel_ids = list.map(rows, fn(r) { r.id })
  use messages <- result.try(store.query(
    read,
    "SELECT "
      <> message_row.columns
      <> " FROM messages WHERE channel_id IN (SELECT value FROM json_each(?)) ORDER BY channel_id, position",
    [ids_json(channel_ids, id.channel_json)],
    message_row.decoder(),
  ))
  use attachments <- result.map(store.query(
    read,
    "SELECT "
      <> attachment_row.columns
      <> " FROM message_attachments WHERE message_id IN (SELECT value FROM json_each(?))",
    [ids_json(list.map(messages, fn(m) { m.id }), id.message_json)],
    attachment_row.decoder(),
  ))
  let attachment_of =
    list.map(attachments, fn(a) { #(a.message_id, a) }) |> dict.from_list
  let by_channel =
    list.group(messages, fn(m) { m.channel_id })
    |> dict.map_values(fn(_, ms) {
      list.reverse(ms)
      |> list.map(fn(m) {
        Message(m, dict.get(attachment_of, m.id) |> option.from_result)
      })
    })
  list.map(rows, fn(r) {
    Thread(r, dict.get(by_channel, r.id) |> result.unwrap([]))
  })
}

pub fn by_id(read: Read, id: id.ChannelId) -> Result(Option(Thread), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    select("WHERE id = ?"),
    [id.channel_sql(id)],
    row.decoder(),
  ))
  use threads <- result.map(with_messages(read, rows))
  list.first(threads) |> option.from_result
}

/// A thread without its messages: who its parties are (channels.mjs `parties`).
pub fn parties(
  read: Read,
  id: id.ChannelId,
) -> Result(Option(row.Row), Fail(e)) {
  store.one(read, select("WHERE id = ?"), [id.channel_sql(id)], row.decoder())
  |> result.map(option.from_result)
}

/// An adult player's own threads, oldest first.
pub fn for_player(
  read: Read,
  player_id: id.PlayerId,
) -> Result(List(Thread), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    select("WHERE player_id = ? AND counterparty = 'player' ORDER BY seq"),
    [id.player_sql(player_id)],
    row.decoder(),
  ))
  with_messages(read, rows)
}

/// A guardian's threads, oldest first.
pub fn for_guardian(
  read: Read,
  guardian_id: id.GuardianId,
) -> Result(List(Thread), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    select("WHERE guardian_id = ? ORDER BY seq"),
    [id.guardian_sql(guardian_id)],
    row.decoder(),
  ))
  with_messages(read, rows)
}

/// Most recently active first, keyed by `[last_activity_at, seq]`.
fn active_page(
  read: Read,
  where: String,
  args: List(sqlight.Value),
  page: Page,
) -> Result(#(List(Thread), Option(String)), Fail(e)) {
  let #(after, after_args) = case page.after {
    Some([IntKey(at), IntKey(seq)]) -> #(
      " AND (last_activity_at, seq) < (?, ?)",
      [sqlight.int(at), sqlight.int(seq)],
    )
    _ -> #("", [])
  }
  use rows <- result.try(store.query(
    read,
    select(
      "WHERE "
      <> where
      <> after
      <> " ORDER BY last_activity_at DESC, seq DESC LIMIT ?",
    ),
    list.flatten([args, after_args, [sqlight.int(page.limit + 1)]]),
    row.decoder(),
  ))
  let #(items, next) =
    paging.page_of(rows, page.limit, fn(r) {
      [IntKey(r.last_activity_at), IntKey(r.seq)]
    })
  use threads <- result.map(with_messages(read, items))
  #(threads, next)
}

/// One organisation's threads; `player_id` limits them to one player's (a Room's inbox panel).
pub fn page_for_org(
  read: Read,
  org_id: id.OrgId,
  player_id: Option(String),
  page: Page,
) -> Result(#(List(Thread), Option(String)), Fail(e)) {
  case player_id {
    Some(p) ->
      active_page(
        read,
        "org_id = ? AND player_id = ?",
        [id.org_sql(org_id), sqlight.text(p)],
        page,
      )
    None -> active_page(read, "org_id = ?", [id.org_sql(org_id)], page)
  }
}

/// Every thread (Trust & Safety's thread audit).
pub fn page_all(
  read: Read,
  page: Page,
) -> Result(#(List(Thread), Option(String)), Fail(e)) {
  active_page(read, "1 = 1", [], page)
}

pub fn count(read: Read) -> Result(Int, Fail(e)) {
  store.one(
    read,
    "SELECT COUNT(*) FROM channels",
    [],
    decode.at([0], decode.int),
  )
  |> result.map(result.unwrap(_, 0))
}

/// The organisation's threads, and the messages from players and guardians since it last opened each thread.
pub fn counts_for_org(
  read: Read,
  org_id: id.OrgId,
) -> Result(#(Int, Int), Fail(e)) {
  store.one(
    read,
    "SELECT (SELECT COUNT(*) FROM channels WHERE org_id = ?1), (SELECT COUNT(*) FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.org_id = ?1 AND m.sender_kind <> 'org_user' AND m.created_at > COALESCE(c.read_by_org_at, 0))",
    [id.org_sql(org_id)],
    {
      use threads <- decode.field(0, decode.int)
      use unread <- decode.field(1, decode.int)
      decode.success(#(threads, unread))
    },
  )
  |> result.map(result.unwrap(_, #(0, 0)))
}

/// The message this sender already sent with this retry id in this thread.
pub fn by_client_msg_id(
  read: Read,
  channel_id: id.ChannelId,
  sender: Sender,
  client_msg_id: String,
) -> Result(Option(Message), Fail(e)) {
  let id_column = case sender.kind {
    audience.OrgUser -> "sender_user_id"
    _ -> "sender_person_id"
  }
  use found <- result.try(store.one(
    read,
    "SELECT id FROM messages WHERE channel_id = ? AND client_msg_id = ? AND sender_kind = ? AND "
      <> id_column
      <> " = ?",
    [
      id.channel_sql(channel_id),
      sqlight.text(client_msg_id),
      sqlight.text(audience.to_string(sender.kind)),
      sqlight.text(sender.id),
    ],
    decode.at([0], id.message_decoder()),
  ))
  case found {
    Error(Nil) -> Ok(None)
    Ok(id) -> message_by_id(read, id)
  }
}

fn message_by_id(
  read: Read,
  id: id.MessageId,
) -> Result(Option(Message), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT " <> message_row.columns <> " FROM messages WHERE id = ?",
    [id.message_sql(id)],
    message_row.decoder(),
  ))
  case rows {
    [] -> Ok(None)
    [m, ..] -> {
      use a <- result.map(store.one(
        read,
        "SELECT "
          <> attachment_row.columns
          <> " FROM message_attachments WHERE message_id = ?",
        [id.message_sql(m.id)],
        attachment_row.decoder(),
      ))
      Some(Message(m, option.from_result(a)))
    }
  }
}

/// A clip from the player's media, attached to a message.
pub type Clip {
  Clip(
    media_id: id.MediaId,
    title: Option(String),
    url: Option(String),
    verified: Bool,
  )
}

/// A message at the end of the thread; the thread's activity time moves to it.
pub fn append(
  tx: Tx,
  channel_id: id.ChannelId,
  sender: Sender,
  text: String,
  clip: Option(Clip),
  client_msg_id: Option(String),
  at: Int,
) -> Result(Message, Fail(e)) {
  let read = store.reading(tx)
  use id <- result.try(id.next_message(tx))
  use position <- result.try(
    store.one(
      read,
      "SELECT COALESCE(MAX(position) + 1, 0) FROM messages WHERE channel_id = ?",
      [id.channel_sql(channel_id)],
      decode.at([0], decode.int),
    )
    |> result.map(result.unwrap(_, 0)),
  )
  let staff = sender.kind == audience.OrgUser
  use _ <- result.try(message_row.insert(
    tx,
    message_row.New(
      ..message_row.new(
        id:,
        channel_id:,
        position:,
        created_at: at,
        sender_kind: sender.kind,
        text:,
      ),
      // The sender's kind says whose id it is.
      sender_user_id: case staff {
        True -> Some(id.org_user(sender.id))
        False -> None
      },
      sender_person_id: case staff {
        True -> None
        False -> Some(sender.id)
      },
      sender_name: Some(thread_name(sender.name)),
      client_msg_id:,
    ),
  ))
  use _ <- result.try(case clip {
    None -> Ok(Nil)
    Some(c) ->
      attachment_row.insert(
        tx,
        attachment_row.Row(
          ..attachment_row.new(message_id: id, kind: attachment_row.Clip),
          media_id: Some(c.media_id),
          title: c.title,
          url: c.url,
          verified_clip: Some(c.verified),
        ),
      )
  })
  use _ <- result.try(
    store.run(
      tx,
      "UPDATE channels SET last_activity_at = MAX(last_activity_at, ?) WHERE id = ?",
      [sqlight.int(at), id.channel_sql(channel_id)],
    ),
  )
  use found <- result.map(message_by_id(read, id))
  let assert Some(m) = found as "a message reads back in its own unit"
  m
}

/// The staff who have written in a thread, in the order they first did.
pub fn staff_senders(
  read: Read,
  channel_id: id.ChannelId,
) -> Result(List(id.OrgUserId), Fail(e)) {
  store.query(
    read,
    "SELECT sender_user_id FROM messages WHERE channel_id = ? AND sender_user_id IS NOT NULL GROUP BY sender_user_id ORDER BY MIN(position)",
    [id.channel_sql(channel_id)],
    decode.at([0], id.org_user_decoder()),
  )
}

/// Stamps a read receipt; returns the stored receipts `#(org, counterparty)`.
pub fn mark_read(
  tx: Tx,
  channel_id: id.ChannelId,
  side: Side,
  at: Int,
) -> Result(#(Option(Int), Option(Int)), Fail(e)) {
  let column = case side {
    OrgSide -> "read_by_org_at"
    CounterpartySide -> "read_by_counterparty_at"
  }
  use rows <- result.map(
    store.write(
      tx,
      "UPDATE channels SET "
        <> column
        <> " = ? WHERE id = ? RETURNING read_by_org_at, read_by_counterparty_at",
      [sqlight.int(at), id.channel_sql(channel_id)],
      {
        use org <- decode.field(0, decode.optional(decode.int))
        use counterparty <- decode.field(1, decode.optional(decode.int))
        decode.success(#(org, counterparty))
      },
    ),
  )
  let assert [receipts] = rows as "the thread was found before its receipt"
  receipts
}

// ------------------------------------------------------------------------------------------------- views

/// Who sees a thread: the organisation's view carries its own id; the guardian's id is never in a view, except
/// the admin audit's.
pub type Viewer {
  ForOrg
  ForCounterparty
  ForAdmin
}

pub fn receipts_json(org: Option(Int), counterparty: Option(Int)) -> Json {
  json.object([
    #("org", json.nullable(org, json.int)),
    #("counterparty", json.nullable(counterparty, json.int)),
  ])
}

pub fn message_view(m: Message) -> Json {
  let r = m.row
  let sender_id = case r.sender_user_id, r.sender_person_id {
    Some(user), _ -> id.org_user_to_string(user)
    None, Some(person) -> person
    None, None -> panic as "a message row has one sender id (its CHECK)"
  }
  json.object(
    list.flatten([
      [
        #("id", id.message_json(r.id)),
        #("ts", json.int(r.created_at)),
        #(
          "sender",
          json.object([
            #("kind", audience.to_json(r.sender_kind)),
            #("id", json.string(sender_id)),
            #("name", json.nullable(r.sender_name, json.string)),
          ]),
        ),
        #("text", json.string(r.text)),
        #("attachment", case m.attachment {
          None -> json.null()
          Some(a) -> attachment_view(a)
        }),
      ],
      case r.client_msg_id {
        Some(c) -> [#("clientMsgId", json.string(c))]
        None -> []
      },
    ]),
  )
}

fn attachment_view(a: attachment_row.Row) -> Json {
  let opt = json.nullable(_, json.string)
  case a.kind {
    attachment_row.Clip ->
      json.object([
        #("kind", json.string("clip")),
        #("mediaId", json.nullable(a.media_id, id.media_json)),
        #("title", opt(a.title)),
        #("url", opt(a.url)),
        #("verifiedClip", json.bool(a.verified_clip == Some(True))),
      ])
    attachment_row.TrialReport ->
      json.object([
        #("kind", json.string("trial_report")),
        #("reportId", opt(a.report_id)),
        #("orgName", opt(a.org_name)),
        #("summary", opt(a.summary)),
      ])
  }
}

/// The view's fields, for a route to add its own after them (`closed`, `guardianId`).
pub fn view_fields(t: Thread, viewer: Viewer) -> List(#(String, Json)) {
  let c = t.row
  let opt = json.nullable(_, json.string)
  list.flatten([
    [
      #("id", id.channel_json(c.id)),
      #("requestId", id.request_json(c.request_id)),
      #("playerId", id.player_json(c.player_id)),
      #("playerName", opt(c.player_name)),
    ],
    case viewer {
      ForCounterparty -> []
      ForOrg | ForAdmin -> [#("orgId", id.org_json(c.org_id))]
    },
    [
      #("orgName", json.string(c.org_name)),
      #("orgVerified", json.nullable(c.org_verified, json.bool)),
      #("scoutName", opt(c.scout_name)),
      #("scoutRole", opt(c.scout_role)),
      #("counterparty", party.to_json(c.counterparty)),
      #("createdAt", json.int(c.created_at)),
      #("lastActivityAt", json.int(c.last_activity_at)),
      #("messages", json.array(t.messages, message_view)),
      #("readBy", receipts_json(c.read_by_org_at, c.read_by_counterparty_at)),
    ],
  ])
}

pub fn view(t: Thread, viewer: Viewer) -> Json {
  json.object(view_fields(t, viewer))
}
