//// The Contact engine (domains/recruitment/lifecycle/contact.mjs): pure rules over a Contact, the club's internal
//// record of one communication with a player or, for a minor, their guardian. A draft is not contact; delivered,
//// failed and responded are facts about an attempt, never case states; an attested external contact creates
//// nothing in anyone's Inbox.

import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/regexp
import gleam/string
import scoutbox/platform/input
import scoutbox/platform/temporal
import scoutbox/platform/unicode
import scoutbox/recruitment/recipients.{type Recipient}
import scoutbox/recruitment/room_rules.{type RoomRole}
import scoutbox/recruitment/trial_rules
import scoutbox/rows/contact_attempts as attempt_row
import scoutbox/rows/contact_history as history_row
import scoutbox/rows/id
import scoutbox/rows/recruitment_contacts as row
import scoutbox/vocab/contact_mode.{type ContactMode}
import scoutbox/vocab/party
import scoutbox/vocab/room_status.{type RoomStatus}

pub const policy_version = 1

pub const subject_max = 120

pub const body_max = 2000

pub const summary_max = 500

pub const reply_max = 500

const occurred_at_skew_ms = 900_000

const occurred_at_max_age_ms = 15_552_000_000

/// One delivered in-app contact per organisation and player per window, unless answered.
pub const cooldown_ms = 259_200_000

pub type Contact {
  Contact(
    row: row.Row,
    attempts: List(attempt_row.Row),
    history: List(history_row.Row),
  )
}

pub type Refusal {
  Refusal(error: String, message: String, fields: List(#(String, Json)))
}

fn refusal(error: String, message: String) -> Refusal {
  Refusal(error, message, [])
}

// ------------------------------------------------------------------------------------------------- vocabulary

pub const statuses = [
  row.Draft,
  row.Delivered,
  row.StatusFailed,
  row.Responded,
  row.Recorded,
  row.Cancelled,
]

pub fn status_label(s: row.Status) -> String {
  case s {
    row.Draft -> "Draft"
    row.Delivered -> "Delivered"
    row.StatusFailed -> "Send failed"
    row.Responded -> "Response received"
    row.Recorded -> "Recorded (external)"
    row.Cancelled -> "Cancelled"
  }
}

pub const channels = [
  row.InApp,
  row.Phone,
  row.InPerson,
  row.EmailExternal,
  row.Agent,
  row.Other,
]

pub fn channel_label(c: row.Channel) -> String {
  case c {
    row.InApp -> "ScoutBox message"
    row.Phone -> "Telephone"
    row.InPerson -> "In person"
    row.EmailExternal -> "Email (outside ScoutBox)"
    row.Agent -> "Via agent or guardian conversation"
    row.Other -> "Other"
  }
}

/// `in_app` is the one transport ScoutBox operates; the rest are attested after the fact.
pub fn external(c: row.Channel) -> Bool {
  c != row.InApp
}

pub fn external_channels() -> List(row.Channel) {
  list.filter(channels, external)
}

/// The case states from which a contact may be created, sent or recorded.
pub const case_statuses = [room_status.ContactPlanned, room_status.Contacted]

pub fn accepts_case(status: RoomStatus) -> Bool {
  list.contains(case_statuses, status)
}

/// Whether the recipient's answer moves a contact in this state (to `responded`). It is the recipient's act, not
/// the club's: no role is asked, and an answer that reaches a contact in any other state leaves it alone.
pub fn accepts_response(s: row.Status) -> Bool {
  s == row.Delivered
}

/// States that count as "the recipient could have received it".
pub fn is_evidence(s: row.Status) -> Bool {
  s == row.Delivered || s == row.Responded || s == row.Recorded
}

// -------------------------------------------------------------------------------------------- roles, actions

pub type Need {
  ContactView
  ContactWrite
}

/// contact_write is room_lead and above; a contributor proposes through tasks and comments.
pub fn role_allows(role: Option(RoomRole), need: Need) -> Bool {
  let rank = case role {
    Some(room_rules.Viewer) -> 0
    Some(room_rules.Contributor) -> 1
    Some(room_rules.RoomLead) -> 2
    Some(room_rules.RecruitmentAdmin) -> 3
    None -> -1
  }
  let needed = case need {
    ContactView -> 0
    ContactWrite -> 2
  }
  rank >= needed
}

pub type Action {
  Edit
  Send
  Cancel
}

/// Validation before the rev guard, so a stale rev on an impossible action reports the impossibility. Allowed,
/// it answers the state the action leaves the contact in (canContactAction's `to`).
pub fn can_act(
  c: Contact,
  action: Action,
  role: Option(RoomRole),
) -> Result(row.Status, Refusal) {
  let status = c.row.status
  let from_ok = status == row.Draft || status == row.StatusFailed
  case role_allows(role, ContactWrite), from_ok {
    False, _ ->
      Error(refusal(
        "CONTACT_NOT_PERMITTED",
        "Your role cannot do this with a contact.",
      ))
    True, True ->
      Ok(case action {
        Edit -> status
        Send -> row.Delivered
        Cancel -> row.Cancelled
      })
    True, False ->
      case status, action {
        row.Delivered, Send ->
          Error(refusal(
            "CONTACT_ALREADY_SENT",
            "This contact has already been delivered.",
          ))
        _, _ ->
          Error(refusal(
            "CONTACT_INVALID_STATE",
            "A contact that is "
              <> string.lowercase(status_label(status))
              <> " cannot be "
              <> case action {
              Edit -> "edited"
              Cancel -> "cancelled"
              Send -> "sended"
            }
              <> ".",
          ))
      }
  }
}

// ---------------------------------------------------------------------------------------------------- content

/// Shared content is stored inert: NFC-normalised, markup removed, control characters dropped, trimmed and cut to
/// `max` UTF-16 units, so no renderer can execute it. (A Gleam string can hold no lone surrogate: the JSON body's
/// are dropped as it is parsed, `http.without_lone_surrogates`.)
pub fn plain_shared(text: String, max: Int) -> String {
  let assert Ok(tags) = regexp.from_string("<[^>]*>|[<>]")
  let assert Ok(controls) =
    regexp.from_string("[\\x{0}-\\x{8}\\x{B}\\x{C}\\x{E}-\\x{1F}\\x{7F}]")
  regexp.replace(tags, unicode.nfc(text), "")
  |> regexp.replace(controls, _, "")
  |> string.trim
  |> input.utf16_take(max)
}

/// What the contact routes' shapes refuse a field under, unless the field names its own code.
pub const input_default = "CONTACT_CONTENT_INVALID"

/// Shape and type only: `validate_content` cleans the words and judges their length (markup is stripped first,
/// so the raw text may run longer than the limit).
pub const words_max = 1_000_000

/// A field of words as the contact routes' shapes read it: text, or absent or null.
pub fn words_check() -> input.Rule(Option(String)) {
  input.nullish(input.text(words_max))
}

pub type Content {
  Content(subject: Option(String), body: String)
}

/// The words as sent (text or absent; the route's shape refuses anything else).
pub fn validate_content(
  subject: Option(String),
  body: Option(String),
) -> Result(Content, Refusal) {
  let s = plain_shared(option.unwrap(subject, ""), subject_max)
  let b = plain_shared(option.unwrap(body, ""), body_max)
  case body {
    Some(raw) if raw != "" ->
      case input.utf16_length(raw) > body_max * 4 {
        True ->
          Error(refusal(
            "CONTACT_CONTENT_TOO_LONG",
            "Keep the message under "
              <> int.to_string(body_max)
              <> " characters.",
          ))
        False -> content(s, b)
      }
    _ -> content(s, b)
  }
}

fn content(s: String, b: String) -> Result(Content, Refusal) {
  case b {
    "" ->
      Error(refusal(
        "CONTACT_CONTENT_INVALID",
        "Write the message the player or guardian will read.",
      ))
    _ ->
      Ok(Content(
        subject: case s {
          "" -> None
          _ -> Some(s)
        },
        body: b,
      ))
  }
}

/// The short reply a request's answer may carry, as sent: `Ok(None)` for none (absent, null or empty), the cleaned
/// text, or the refusal when it isn't text or the request isn't a contact.
pub fn validate_reply(
  raw: Option(Dynamic),
  is_contact: Bool,
) -> Result(Option(String), Refusal) {
  let as_text = option.map(raw, decode.run(_, decode.string))
  let is_nothing = case raw {
    None -> True
    Some(v) -> dynamic.classify(v) == "Nil" || as_text == Some(Ok(""))
  }
  case is_nothing, as_text, is_contact {
    True, _, _ -> Ok(None)
    False, Some(Ok(text)), True ->
      case plain_shared(text, reply_max) {
        "" -> Ok(None)
        reply -> Ok(Some(reply))
      }
    False, _, _ ->
      Error(refusal(
        "CONTACT_RESPONSE_INVALID",
        "A reply must be text, and only a contact can carry one.",
      ))
  }
}

// -------------------------------------------------------------------------------------------------- recipient

/// The recipient rule in Contact vocabulary: derived from the live records, never trusted from a client.
pub fn recipient_refusal(r: recipients.Unresolved) -> Refusal {
  case r {
    recipients.Blocked ->
      refusal(
        "CONTACT_BLOCKED",
        "This player (or their guardian) has blocked your organisation.",
      )
    recipients.GuardianRequired ->
      refusal(
        "CONTACT_GUARDIAN_REQUIRED",
        "This player is under the age of majority and no valid guardian route exists. Contact cannot proceed.",
      )
    recipients.Unavailable(m) -> refusal("CONTACT_RECIPIENT_UNAVAILABLE", m)
  }
}

// ----------------------------------------------------------------------------------------------- the routing

/// Who a send reaches: the recipient, and the player's agent beside them when `both` was asked for and the agent's
/// authority holds. No mode reaches an agent instead of the player.
pub type Routing {
  Routing(
    mode: ContactMode,
    agent: Option(RoutedAgent),
    agent_refusal: Option(String),
  )
}

pub type RoutedAgent {
  RoutedAgent(agent_user_id: id.OrgUserId, agreement_id: id.AgreementId)
}

/// The routing view a club sees: the refusal code names a category, never a person.
pub fn routing_view(
  recipient: Result(Recipient, Refusal),
  routing: Option(Routing),
) -> Json {
  let modes = json.array(contact_mode.pairs, fn(p) { json.string(p.0) })
  case recipient {
    Ok(r) ->
      json.object([
        #("available", json.bool(True)),
        #("type", party.to_json(r.kind)),
        #("minor", json.bool(r.minor)),
        #(
          "mode",
          contact_mode.to_json(case routing {
            Some(x) -> x.mode
            None -> contact_mode.PlayerOnly
          }),
        ),
        #(
          "agentParty",
          json.bool(case routing {
            Some(Routing(agent: Some(_), ..)) -> True
            _ -> False
          }),
        ),
        #(
          "agentRefusal",
          json.nullable(
            option.then(routing, fn(x) { x.agent_refusal }),
            json.string,
          ),
        ),
        #("modes", modes),
      ])
    Error(r) ->
      json.object([
        #("available", json.bool(False)),
        #("type", json.null()),
        #("minor", json.null()),
        #("reason", json.string(r.error)),
        #("mode", json.null()),
        #("agentParty", json.bool(False)),
        #("agentRefusal", json.null()),
        #("modes", modes),
      ])
  }
}

pub const routing_honest =
  "Who was validly routed when this contact was recorded. A later change to the relationship does not rewrite it, and the next contact is routed from the authority in force then."

/// `contactRouting`: the player is always a target, and the agent is added beside them only when `both` was asked
/// for and the agent decision allowed them (`agent` is their ids, or the code it refused with). A refused agent
/// falls back to the player rather than failing the contact. A minor's route is the guardian's; an agent is never
/// substituted for one.
pub fn routing(
  minor: Bool,
  mode: ContactMode,
  agent: Result(RoutedAgent, String),
) -> Routing {
  case minor, mode, agent {
    True, _, _ ->
      Routing(contact_mode.PlayerOnly, None, Some("MINOR_PATHWAY_DISABLED"))
    False, contact_mode.Both, Ok(a) -> Routing(contact_mode.Both, Some(a), None)
    False, _, Error(code) -> Routing(contact_mode.PlayerOnly, None, Some(code))
    False, contact_mode.PlayerOnly, Ok(_) ->
      Routing(contact_mode.PlayerOnly, None, None)
  }
}

/// Who was validly routed when a contact was sent (`contactTargetSnapshot`); a later relationship change does not
/// rewrite it. Its words are `routing_honest`.
pub type Snapshot {
  Snapshot(
    at: Int,
    mode: ContactMode,
    /// The recipient is always the player or their guardian.
    player: Bool,
    guardian: Bool,
    agent: Option(RoutedAgent),
  )
}

pub fn snapshot(routing: Routing, recipient: party.Party, at: Int) -> Snapshot {
  Snapshot(
    at:,
    mode: routing.mode,
    player: True,
    guardian: recipient == party.Guardian,
    agent: routing.agent,
  )
}

// ---------------------------------------------------------------------------------------------- external record

pub type External {
  External(channel: row.Channel, occurred_at: Int, summary: Option(String))
}

/// The recipient type the club states must equal the derived one: "I phoned the player" about a minor is refused,
/// not corrected.
pub fn validate_external(
  channel: Option(Dynamic),
  occurred_at: Option(Dynamic),
  summary: Option(String),
  recipient_type: Option(String),
  now: Int,
  derived: party.Party,
) -> Result(External, Refusal) {
  let ext = external_channels()
  let named =
    option.then(channel, fn(v) {
      case decode.run(v, decode.string) {
        Ok(text) ->
          list.find(row.channel_pairs, fn(p) { p.0 == text })
          |> option.from_result
          |> option.map(fn(p) { p.1 })
        Error(_) -> None
      }
    })
  case named {
    Some(c) ->
      case external(c) {
        True ->
          external_when(c, occurred_at, summary, recipient_type, now, derived)
        False -> Error(channel_refusal(ext))
      }
    None -> Error(channel_refusal(ext))
  }
}

fn channel_refusal(ext: List(row.Channel)) -> Refusal {
  let names = list.map(ext, row.channel_to_string)
  Refusal(
    "CONTACT_CHANNEL_INVALID",
    "Channel must be one of " <> string.join(names, ", ") <> ".",
    [#("allowed", json.array(names, json.string))],
  )
}

fn external_when(
  channel: row.Channel,
  occurred_at: Option(Dynamic),
  summary: Option(String),
  recipient_type: Option(String),
  now: Int,
  derived: party.Party,
) -> Result(External, Refusal) {
  let parsed = case occurred_at {
    Some(v) -> temporal.instant(v, 1900, 2100)
    None -> Error(temporal.NotADateTime)
  }
  case parsed {
    Error(_) ->
      Error(refusal(
        "CONTACT_OCCURRED_AT_INVALID",
        "occurredAt must be a date and time: ISO 8601 with an explicit offset or Z, or a millisecond timestamp.",
      ))
    Ok(ts) if ts > now + occurred_at_skew_ms ->
      Error(refusal(
        "CONTACT_OCCURRED_AT_INVALID",
        "A contact cannot be recorded before it has happened.",
      ))
    Ok(ts) if ts < now - occurred_at_max_age_ms ->
      Error(refusal(
        "CONTACT_OCCURRED_AT_INVALID",
        "A contact this old cannot be recorded as recruitment evidence.",
      ))
    Ok(ts) -> {
      let derived_text = party.to_string(derived)
      case recipient_type {
        Some(t) if t != derived_text ->
          Error(
            refusal("CONTACT_RECIPIENT_MISMATCH", case derived {
              party.Guardian ->
                "This player is under the age of majority: a recorded contact must be with the guardian."
              party.Player ->
                "This player is an adult: the recorded contact is with the player."
            }),
          )
        _ -> {
          let s = plain_shared(option.unwrap(summary, ""), summary_max)
          Ok(
            External(channel:, occurred_at: ts, summary: case s {
              "" -> None
              _ -> Some(s)
            }),
          )
        }
      }
    }
  }
}

// -------------------------------------------------------------------------------------------------- cooldown

/// At most one delivered in-app contact per organisation and player within the window, unless answered: the
/// moment the pair may be contacted again, or `None`.
pub fn cooldown_until(
  contacts: List(Contact),
  org_id: id.OrgId,
  player_id: id.PlayerId,
  now: Int,
  except: Option(id.ContactId),
) -> Option(Int) {
  contacts
  |> list.filter_map(fn(c) {
    let r = c.row
    case
      r.org_id == org_id
      && r.player_id == player_id
      && Some(r.id) != except
      && r.channel == row.InApp
      && r.status == row.Delivered,
      r.delivered_at
    {
      True, Some(at) if now - at < cooldown_ms -> Ok(at)
      _, _ -> Error(Nil)
    }
  })
  |> list.max(int.compare)
  |> option.from_result
  |> option.map(fn(latest) { latest + cooldown_ms })
}

// ------------------------------------------------------------------------------------------------ projections

fn seq(entry_id: String) -> Int {
  case string.split(entry_id, "-") |> list.last {
    Ok(last) -> int.parse(last) |> option.from_result |> option.unwrap(0)
    Error(Nil) -> 0
  }
}

/// Time, then the monotonic id part, so two entries in one millisecond never swap.
pub fn by_at_then_id(a: history_row.Row, b: history_row.Row) -> order.Order {
  case int.compare(a.at, b.at) {
    order.Eq ->
      int.compare(
        seq(id.contact_event_to_string(a.id)),
        seq(id.contact_event_to_string(b.id)),
      )
    other -> other
  }
}

fn history_view(c: Contact) -> Json {
  c.history
  |> list.sort(by_at_then_id)
  |> json.array(fn(h) {
    json.object([
      #("id", id.contact_event_json(h.id)),
      #("at", json.int(h.at)),
      #("action", json.string(h.action)),
      #("by", case h.by_kind, h.by_name {
        None, None -> json.null()
        kind, name ->
          json.object([
            #("name", json.nullable(name, json.string)),
            #("kind", json.nullable(kind, history_row.by_kind_to_json)),
          ])
      }),
      #("detail", trial_rules.detail_json(h.detail_json)),
    ])
  })
}

fn named(user: Option(id.OrgUserId), name: Option(String)) -> Json {
  case user, name {
    None, None -> json.null()
    _, _ -> json.object([#("name", json.nullable(name, json.string))])
  }
}

fn lifecycle_json(r: row.Row) -> Json {
  case r.lifecycle_applied {
    None -> json.null()
    Some(True) ->
      json.object([
        #("applied", json.bool(True)),
        #("from", json.nullable(r.lifecycle_from, json.string)),
        #("to", json.nullable(r.lifecycle_to, json.string)),
        #("at", json.nullable(r.lifecycle_at, json.int)),
      ])
    Some(False) ->
      json.object([
        #("applied", json.bool(False)),
        #("reason", json.nullable(r.lifecycle_reason, json.string)),
        #("at", json.nullable(r.lifecycle_at, json.int)),
      ])
  }
}

/// The club wrote the body, so it sees it; the reply is shown because it was addressed to the club. Keys and
/// fingerprints stay out.
pub fn view(c: Contact) -> Json {
  let r = c.row
  let opt_int = json.nullable(_, json.int)
  let opt = json.nullable(_, json.string)
  json.object([
    #("id", id.contact_json(r.id)),
    #("caseId", id.recruitment_case_json(r.case_id)),
    #("playerId", id.player_json(r.player_id)),
    #("status", row.status_to_json(r.status)),
    #("statusLabel", json.string(status_label(r.status))),
    #("channel", row.channel_to_json(r.channel)),
    #("channelLabel", json.string(channel_label(r.channel))),
    #("external", json.bool(external(r.channel))),
    #("recipient", case r.recipient_type {
      Some(t) ->
        json.object([
          #("type", party.to_json(t)),
          #("minor", json.bool(r.recipient_minor == Some(True))),
        ])
      None -> json.null()
    }),
    #("contactMode", contact_mode.to_json(r.contact_mode)),
    #("routedToAgent", json.bool(routed_to_agent(r))),
    #("routedAt", opt_int(r.routing_at)),
    #("subject", opt(r.subject)),
    #("body", opt(r.body)),
    #("summary", opt(r.summary)),
    #("createdBy", named(Some(r.created_by_user_id), r.created_by_name)),
    #("createdAt", json.int(r.created_at)),
    #("updatedAt", json.int(r.updated_at)),
    #("sentBy", named(r.sent_by_user_id, r.sent_by_name)),
    #("sentAt", opt_int(r.sent_at)),
    #("deliveredAt", opt_int(r.delivered_at)),
    #("failedAt", opt_int(r.failed_at)),
    #("failureCode", opt(r.failure_code)),
    #("attempts", json.int(list.length(c.attempts))),
    #("occurredAt", opt_int(r.occurred_at)),
    #("recordedBy", named(r.recorded_by_user_id, r.recorded_by_name)),
    #("recordedAt", opt_int(r.recorded_at)),
    #("respondedAt", opt_int(r.responded_at)),
    #("response", case r.response_kind, r.response_by {
      Some(kind), Some(by) ->
        json.object([
          #("kind", row.response_kind_to_json(kind)),
          #("message", opt(r.response_message)),
          #("by", party.to_json(by)),
          #("at", opt_int(r.response_at)),
        ])
      _, _ -> json.null()
    }),
    #("emailCopy", case r.email_copy_state, r.email_copy_to {
      Some(state), Some(to) ->
        json.object([
          #("state", row.email_copy_state_to_json(state)),
          #("to", row.email_copy_to_to_json(to)),
          #("outboxId", opt(r.email_copy_outbox_id)),
          #("at", opt_int(r.email_copy_at)),
        ])
      _, _ -> json.null()
    }),
    #("lifecycle", lifecycle_json(r)),
    #("cancelledAt", opt_int(r.cancelled_at)),
    #("rev", json.int(r.rev)),
    #("revAt", opt_int(r.rev_at)),
    #("revBy", opt(r.rev_by_name)),
    #("history", history_view(c)),
    #(
      "transportNote",
      json.string(case r.channel {
        row.InApp ->
          "Delivered means the message is in the recipient's ScoutBox Inbox. ScoutBox does not track whether it was read."
        _ ->
          "Recorded by a named member of staff. ScoutBox did not observe this contact."
      }),
    ),
    #("policyVersion", json.int(policy_version)),
  ])
}

pub fn routed_to_agent(r: row.Row) -> Bool {
  r.routing_agent_user_id != None
}

/// Never a body, a summary or a reply.
pub fn milestone(c: Contact) -> Json {
  let r = c.row
  json.object([
    #("id", id.contact_json(r.id)),
    #("status", row.status_to_json(r.status)),
    #("channel", row.channel_to_json(r.channel)),
    #("recipientType", json.nullable(r.recipient_type, party.to_json)),
    #("routedToAgent", json.bool(routed_to_agent(r))),
    #("initiatedAt", json.nullable(initiated_at(r), json.int)),
    #("respondedAt", json.nullable(r.responded_at, json.int)),
    #("responseKind", json.nullable(r.response_kind, row.response_kind_to_json)),
  ])
}

pub fn initiated_at(r: row.Row) -> Option(Int) {
  case r.status {
    row.Recorded -> option.or(r.occurred_at, r.recorded_at)
    _ -> r.delivered_at
  }
}

/// Reports, never repairs: a corrupt record is excluded from projections and named in the log. The stored
/// vocabularies are already checked by the schema; what is left is the record's own coherence.
pub fn integrity(
  c: Contact,
  org_id: Option(id.OrgId),
  case_id: Option(id.RecruitmentCaseId),
) -> List(String) {
  let r = c.row
  let sent = r.status == row.Delivered || r.status == row.Responded
  [
    #("org_mismatch", case org_id {
      Some(o) -> o != r.org_id
      None -> False
    }),
    #("case_mismatch", case case_id {
      Some(k) -> k != r.case_id
      None -> False
    }),
    #("recipient_missing", is_evidence(r.status) && r.recipient_type == None),
    #(
      "routing_snapshot_malformed",
      { r.routing_mode == None } != { r.routing_at == None },
    ),
    #("routing_snapshot_unsent", routed_to_agent(r) && !sent),
    #(
      "timestamp_malformed",
      { sent && r.delivered_at == None }
        || { r.status == row.Recorded && r.occurred_at == None },
    ),
  ]
  |> list.filter_map(fn(p) {
    case p.1 {
      True -> Ok(p.0)
      False -> Error(Nil)
    }
  })
}
