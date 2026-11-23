//// The contact rules' calls the generated cases can't make (scripts/rules/recruitment/contacts.mjs,
//// contactsPersistence.mjs and agents/crossApp.mjs), ported by hand.
////
//// The TypeScript rules judge values no request or stored row here can carry:
////
//// - a Room role is derived from a membership, never read from text, and the needs are a closed type, so
////   "constructor" is neither;
//// - words (a subject, a body, an external record's summary) that aren't text are refused by the routes' shapes
////   (`contact_rules.words_check`) under the rule's own code, and absent words are the empty text;
//// - a contact's status, channel and mode are typed columns of a STRICT table, so "sent", "constructor" and
////   "agent_only" can't be stored, nor can text in a timestamp; its history is child rows, always a list, and a
////   Contact is always a record, never null;
//// - a routing snapshot's agent is its user id column, so an agent naming nobody is no agent.
////
//// The crossApp fixtures leave out the organisation and case every contact row has; their checks run here over the
//// base contact. The views' fixtures leave out those and the creation time; the views run over complete contacts
//// with the TypeScript views' answers for them.

import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/option.{None, Some}
import scoutbox/battery/base
import scoutbox/platform/input
import scoutbox/recruitment/contact_rules.{Contact}
import scoutbox/recruitment/room_rules
import scoutbox/rows/contact_attempts as attempt_row
import scoutbox/rows/id
import scoutbox/rows/recruitment_contacts as row
import scoutbox/vocab/contact_mode
import scoutbox/vocab/party

// ------------------------------------------------------------------------------------------------ out of reach

pub fn no_role_is_read_from_text_test() {
  let codes =
    [
      room_rules.Viewer,
      room_rules.Contributor,
      room_rules.RoomLead,
      room_rules.RecruitmentAdmin,
    ]
    |> list.map(room_rules.role_code)
  assert !list.contains(codes, "constructor")
}

pub fn absent_words_are_empty_test() {
  assert contact_rules.plain_shared("", 10) == ""
}

pub fn words_that_are_not_text_are_refused_by_the_shape_test() {
  assert base.contact_content(None, Some("5"))
    == Error(base.ByShape("CONTACT_CONTENT_INVALID"))
  assert base.contact_content(Some("5"), Some("\"hi\""))
    == Error(base.ByShape("CONTACT_CONTENT_INVALID"))
}

/// An external record's summary passes the same shape before validate_external (validateExternalRecord's
/// `summary: ["x"]`).
pub fn a_summary_that_is_not_text_is_refused_by_the_shape_test() {
  let summary = {
    use s <- input.field("summary", contact_rules.words_check())
    input.done(s)
  }
  let assert Error(r) =
    input.parse_coded(
      summary,
      base.body("{\"summary\":[\"x\"]}"),
      root: "body",
      codes: [],
      default: contact_rules.input_default,
    )
  assert r.error == "CONTACT_CONTENT_INVALID"
}

pub fn values_no_contact_row_can_hold_test() {
  assert row.status_from_string("sent") == Error(Nil)
  assert row.channel_from_string("constructor") == Error(Nil)
  assert contact_mode.from_string("agent_only") == Error(Nil)
}

// ---------------------------------------------------------------------------------------------- the integrity

fn draft() -> row.Row {
  base.contact().row
}

fn integrity(r: row.Row) -> List(String) {
  contact_rules.integrity(Contact(..base.contact(), row: r), None, None)
}

/// AO-p7: a routed agent on a contact that never left the building.
pub fn a_routed_agent_on_an_unsent_contact_is_named_test() {
  assert integrity(
      row.Row(
        ..draft(),
        routing_at: Some(1_789_776_000_000),
        routing_mode: Some(contact_mode.Both),
        routing_agent_user_id: Some(id.org_user("usr-ana")),
      ),
    )
    == ["routing_snapshot_unsent"]
}

/// A snapshot with a time and no mode, or a mode and no time, can't say who it reached.
pub fn a_snapshot_missing_its_time_or_mode_is_malformed_test() {
  assert integrity(row.Row(..draft(), routing_at: Some(1)))
    == ["routing_snapshot_malformed"]
  assert integrity(row.Row(..draft(), routing_mode: Some(contact_mode.Both)))
    == ["routing_snapshot_malformed"]
}

// --------------------------------------------------------------------------------------------------- the views

/// A guardian's answered in-app contact, routed to the player's agent beside them.
fn responded() -> contact_rules.Contact {
  let r =
    row.Row(
      ..row.new(
        id: id.contact("rct-1"),
        org_id: id.org("org-x"),
        case_id: id.recruitment_case("case-x"),
        player_id: id.player("pl-x"),
        status: row.Responded,
        channel: row.InApp,
        contact_mode: contact_mode.Both,
        created_by_user_id: id.org_user("usr-owner"),
        created_at: 2000,
        updated_at: 2003,
        rev: 3,
        policy_version: 1,
      ),
      recipient_type: Some(party.Guardian),
      recipient_player_id: Some(id.player("pl-x")),
      recipient_guardian_id: Some(id.guardian("gd-1")),
      recipient_minor: Some(True),
      routing_at: Some(2001),
      routing_mode: Some(contact_mode.Both),
      routing_player: Some(False),
      routing_guardian: Some(True),
      routing_agent_user_id: Some(id.org_user("usr-ana")),
      routing_agent_agreement_id: Some(id.agreement("agr-1")),
      subject: Some("Hello"),
      body: Some("Hi Xavier."),
      created_by_name: Some("Owner"),
      sent_by_user_id: Some(id.org_user("usr-owner")),
      sent_by_name: Some("Owner"),
      sent_at: Some(2001),
      delivered_at: Some(2001),
      email_copy_state: Some(row.Queued),
      email_copy_to: Some(row.Guardian),
      email_copy_outbox_id: Some("ob-1"),
      email_copy_at: Some(2001),
      responded_at: Some(2003),
      response_kind: Some(row.Accepted),
      response_message: Some("Thanks"),
      response_by: Some(party.Guardian),
      response_at: Some(2003),
      rev_at: Some(2003),
      rev_by_user_id: Some(id.org_user("usr-owner")),
      rev_by_name: Some("Owner"),
    )
  Contact(
    row: r,
    attempts: [
      attempt_row.new(contact_id: r.id, position: 0, at: 2001, ok: True),
    ],
    history: [],
  )
}

/// A telephone call a member of staff recorded.
fn recorded() -> contact_rules.Contact {
  let c = responded()
  let r =
    row.Row(
      ..c.row,
      status: row.Recorded,
      channel: row.Phone,
      contact_mode: contact_mode.PlayerOnly,
      recipient_type: Some(party.Player),
      recipient_guardian_id: None,
      recipient_minor: Some(False),
      routing_at: None,
      routing_mode: None,
      routing_player: None,
      routing_guardian: None,
      routing_agent_user_id: None,
      routing_agent_agreement_id: None,
      subject: None,
      body: None,
      summary: Some("Spoke to Xavier."),
      sent_by_user_id: None,
      sent_by_name: None,
      sent_at: None,
      delivered_at: None,
      email_copy_state: None,
      email_copy_to: None,
      email_copy_outbox_id: None,
      email_copy_at: None,
      occurred_at: Some(1500),
      recorded_by_user_id: Some(id.org_user("usr-owner")),
      recorded_by_name: Some("Owner"),
      recorded_at: Some(2000),
      responded_at: None,
      response_kind: None,
      response_message: None,
      response_by: None,
      response_at: None,
      rev: 1,
      rev_at: None,
      rev_by_user_id: None,
      rev_by_name: None,
    )
  Contact(..c, row: r, attempts: [])
}

pub fn the_view_of_a_routed_response_test() {
  assert json.to_string(contact_rules.view(responded()))
    == "{\"id\":\"rct-1\",\"caseId\":\"case-x\",\"playerId\":\"pl-x\",\"status\":\"responded\",\"statusLabel\":\"Response received\",\"channel\":\"in_app\",\"channelLabel\":\"ScoutBox message\",\"external\":false,\"recipient\":{\"type\":\"guardian\",\"minor\":true},\"contactMode\":\"both\",\"routedToAgent\":true,\"routedAt\":2001,\"subject\":\"Hello\",\"body\":\"Hi Xavier.\",\"summary\":null,\"createdBy\":{\"name\":\"Owner\"},\"createdAt\":2000,\"updatedAt\":2003,\"sentBy\":{\"name\":\"Owner\"},\"sentAt\":2001,\"deliveredAt\":2001,\"failedAt\":null,\"failureCode\":null,\"attempts\":1,\"occurredAt\":null,\"recordedBy\":null,\"recordedAt\":null,\"respondedAt\":2003,\"response\":{\"kind\":\"accepted\",\"message\":\"Thanks\",\"by\":\"guardian\",\"at\":2003},\"emailCopy\":{\"state\":\"queued\",\"to\":\"guardian\",\"outboxId\":\"ob-1\",\"at\":2001},\"lifecycle\":null,\"cancelledAt\":null,\"rev\":3,\"revAt\":2003,\"revBy\":\"Owner\",\"history\":[],\"transportNote\":\"Delivered means the message is in the recipient's ScoutBox Inbox. ScoutBox does not track whether it was read.\",\"policyVersion\":1}"
}

pub fn the_view_of_a_recorded_call_test() {
  assert json.to_string(contact_rules.view(recorded()))
    == "{\"id\":\"rct-1\",\"caseId\":\"case-x\",\"playerId\":\"pl-x\",\"status\":\"recorded\",\"statusLabel\":\"Recorded (external)\",\"channel\":\"phone\",\"channelLabel\":\"Telephone\",\"external\":true,\"recipient\":{\"type\":\"player\",\"minor\":false},\"contactMode\":\"player_only\",\"routedToAgent\":false,\"routedAt\":null,\"subject\":null,\"body\":null,\"summary\":\"Spoke to Xavier.\",\"createdBy\":{\"name\":\"Owner\"},\"createdAt\":2000,\"updatedAt\":2003,\"sentBy\":null,\"sentAt\":null,\"deliveredAt\":null,\"failedAt\":null,\"failureCode\":null,\"attempts\":0,\"occurredAt\":1500,\"recordedBy\":{\"name\":\"Owner\"},\"recordedAt\":2000,\"respondedAt\":null,\"response\":null,\"emailCopy\":null,\"lifecycle\":null,\"cancelledAt\":null,\"rev\":1,\"revAt\":null,\"revBy\":null,\"history\":[],\"transportNote\":\"Recorded by a named member of staff. ScoutBox did not observe this contact.\",\"policyVersion\":1}"
}

/// AO-p11: the routing is a boolean, never a name.
pub fn the_milestone_of_a_routed_response_test() {
  assert json.to_string(contact_rules.milestone(responded()))
    == "{\"id\":\"rct-1\",\"status\":\"responded\",\"channel\":\"in_app\",\"recipientType\":\"guardian\",\"routedToAgent\":true,\"initiatedAt\":2001,\"respondedAt\":2003,\"responseKind\":\"accepted\"}"
}

pub fn the_milestone_of_a_recorded_call_test() {
  assert json.to_string(contact_rules.milestone(recorded()))
    == "{\"id\":\"rct-1\",\"status\":\"recorded\",\"channel\":\"phone\",\"recipientType\":\"player\",\"routedToAgent\":false,\"initiatedAt\":1500,\"respondedAt\":null,\"responseKind\":null}"
}

/// AO-p9: a draft asked for both shows the mode it asked for and that nothing was routed.
pub fn a_drafts_view_shows_the_mode_asked_for_and_no_routing_test() {
  let c = base.contact()
  let assert Ok(v) =
    json.parse(json.to_string(contact_rules.view(c)), {
      use mode <- decode.field("contactMode", decode.string)
      use routed <- decode.field("routedToAgent", decode.bool)
      decode.success(#(mode, routed))
    })
  assert c.row.contact_mode == contact_mode.Both
  assert v == #("both", False)
}
