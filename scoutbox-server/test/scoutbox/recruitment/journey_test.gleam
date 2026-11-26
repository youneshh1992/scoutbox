//// The journey projection over stored rows (`journey.build`, and `for_recipient` for the player's and a guardian's
//// views), hand-ported from the buildRecruitmentJourney calls of the TypeScript rules suites: lifecycle U3, U4, H7,
//// H8, H13, H14c, H18–H20 and X3–X6; contacts V; storeGuarantees §4. The TypeScript projector runs over plain
//// records; here each call runs against rows written for it.
////
//// Not ported, because nothing here can hold them:
////
//// - A missing or malformed store (U3, X1, X2, X2b, Y7, Z4, H23, and contacts' and contactsPersistence's
////   "requires the contacts"): the projector reads one store through SQL, so there is no query object to be absent
////   or not a list, and the Offers are always read (`offer.available` is always true).
//// - Viewer kinds no route builds: `agency`, `analyst` and the Trust & Safety viewer. A club's staff, the player, a
////   guardian and an agent each have their own entry point.
//// - Which case a viewer may open (U3 #1/#2 and #13/#14, A36): the route finds the Room (`room_routes.with_room`)
////   before the projector runs, and a foreign club's case answers the same 404 as one that doesn't exist. The
////   batteries check that over HTTP.
//// - Corrupt values on the case the schema or the row types can't hold (X2c, X2d, X3, X4, X7, X8, H14): no room,
////   a status outside the vocabulary or a prototype key, a missing, text or negative rev, a history that isn't a
////   list, null entries or entries with no action, and timestamps that aren't numbers. The history is rows of
////   `case_history`, whose `at` is an INTEGER and whose `action` is NOT NULL. An unknown action is storable, and is
////   ported (X5, X6, H14c).

import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleam/string
import scoutbox/platform/store.{type Store}
import scoutbox/recruitment/case_records.{
  contact, delivered, history, q, room, room_at, store_with,
}
import scoutbox/recruitment/cases
import scoutbox/recruitment/journey
import scoutbox/recruitment/room_rules
import scoutbox/rows/id
import scoutbox/vocab/room_status

/// The club's journey of `case_id` for a room lead, at `now`.
fn club(s: Store, case_id: String, now: Int) -> String {
  let assert Ok(body) =
    store.read(s, fn(r) {
      let assert Ok(Some(room)) = cases.room(r, id.recruitment_case(case_id))
      journey.build(
        r,
        room,
        journey.Viewer(grassroots: False, role: Some(room_rules.RoomLead)),
        journey.Paging(limit: None, cursor: None),
        False,
        True,
        now,
      )
    })
  json.to_string(body)
}

fn at(body: String, path: List(String), decoder: decode.Decoder(a)) -> a {
  let assert Ok(value) = json.parse(body, decode.at(path, decoder))
  value
}

/// The kinds of the timeline's entries, in order.
fn kinds(body: String) -> List(String) {
  at(
    body,
    ["history", "entries"],
    decode.list(decode.at(["kind"], decode.string)),
  )
}

fn entries(body: String) -> Int {
  at(body, ["history", "entries"], decode.list(decode.dynamic)) |> list.length
}

const status_changed = "room_status_changed"

fn moved(from: String, to: String) -> String {
  "{\"from\":\"" <> from <> "\",\"to\":\"" <> to <> "\"}"
}

// --------------------------------------------------------------------------------------------- the lifecycle

/// storeGuarantees §4 and lifecycle H13: every state projects with its own status, label and terminality.
pub fn every_lifecycle_state_projects_as_itself_test() {
  let statuses = list.map(room_status.pairs, fn(p) { p.0 })
  let s =
    store_with(
      list.index_map(statuses, fn(st, i) {
        [
          room("case-" <> st, st, 1000 + i, []),
          history(
            "case-" <> st,
            0,
            1000 + i,
            "room_created",
            "{\"status\":\"" <> st <> "\"}",
          ),
        ]
      })
      |> list.flatten,
    )
  list.each(room_status.pairs, fn(p) {
    let body = club(s, "case-" <> p.0, 2000)
    assert at(body, ["ok"], decode.bool)
    assert at(body, ["lifecycle", "currentStage"], decode.string) == p.0
    let label = at(body, ["lifecycle", "label"], decode.string)
    assert label == room_rules.status_label(p.1)
    assert label != "" && label != p.0
    assert at(body, ["lifecycle", "terminal"], decode.bool)
      == list.contains(room_rules.terminal, p.1)
  })
}

pub fn a_signed_case_shows_no_invented_signing_and_only_its_own_history_test() {
  let s =
    store_with([
      room("old-signed", "signed", 1000, []),
      history(
        "old-signed",
        0,
        1000,
        "room_created",
        "{\"status\":\"watching\"}",
      ),
      history(
        "old-signed",
        1,
        1100,
        status_changed,
        moved("watching", "signed"),
      ),
    ])
  let body = club(s, "old-signed", 3000)
  assert at(body, ["lifecycle", "currentStage"], decode.string) == "signed"
  assert at(body, ["outcome", "signing"], decode.optional(decode.dynamic))
    == None
  assert entries(body) == 2
}

/// lifecycle X3: a stage that disagrees with the status is storable, and the journey still answers.
pub fn a_stage_disagreeing_with_the_status_still_projects_test() {
  let s =
    store_with([room("case-X", "under_review", 1, [#("stage", q("closed"))])])
  let body = club(s, "case-X", 1_767_225_600_000)
  assert at(body, ["lifecycle", "currentStage"], decode.string)
    == "under_review"
  assert at(body, ["lifecycle", "stage"], decode.string) == "closed"
}

// ---------------------------------------------------------------------------------------------- the history

/// lifecycle H8: three entries at the same millisecond keep one order, whatever order they were written in, and
/// none is merged into another.
pub fn entries_at_the_same_millisecond_keep_one_order_test() {
  let rows = [
    #(status_changed, moved("archived", "under_review")),
    #("room_reopened", moved("archived", "under_review")),
    #("room_created", "{\"status\":\"watching\"}"),
  ]
  let written = fn(rows) {
    let s =
      store_with([
        room_at("case-S", "under_review", 1),
        ..list.index_map(rows, fn(r: #(String, String), i) {
          history("case-S", i, 1_769_904_000_000, r.0, r.1)
        })
      ])
    kinds(club(s, "case-S", 5))
  }
  let once = written(rows)
  assert list.length(once) == 3
  assert written(list.reverse(rows)) == once
}

/// lifecycle H14c, X5 and X6: an unknown action is not a timeline event, and its destination doesn't leak.
pub fn an_unknown_history_action_is_omitted_test() {
  let s =
    store_with([
      room_at("case-WH", "under_review", 1),
      history(
        "case-WH",
        0,
        2,
        status_changed,
        moved("watching", "under_review"),
      ),
      history("case-WH", 1, 3, "teleported", moved("under_review", "signed")),
    ])
  let body = club(s, "case-WH", 5)
  assert kinds(body) == [status_changed]
  let assert Ok(entries) =
    json.parse(body, decode.at(["history", "entries"], decode.dynamic))
  let entries = string.inspect(entries)
  assert !string.contains(entries, "teleported")
  assert !string.contains(entries, "signed")
}

// -------------------------------------------------------------------------------------------- the decisions

/// lifecycle U4: a decision's note is never projected; that it has one, and its structured reasons, are.
pub fn a_decision_note_never_reaches_the_journey_test() {
  let s =
    store_with([
      room_at("c1", "under_review", 1),
      "INSERT INTO room_decisions (id, room_id, org_id, player_id, recommendation, note, by_name, created_at) VALUES ('d1', 'c1', 'o1', 'p1', 'archive', 'HIS ATTITUDE IS THE PROBLEM', 'Maria', 1767225600000)",
      "INSERT INTO room_decision_reason_codes (decision_id, position, code) VALUES ('d1', 0, 'squad_space')",
    ])
  let body = club(s, "c1", 1_767_312_000_000)
  assert !string.contains(body, "ATTITUDE")
  assert at(
      body,
      ["decisions", "all"],
      decode.list(decode.at(["hasNote"], decode.bool)),
    )
    == [True]
  assert at(
      body,
      ["decisions", "all"],
      decode.list(decode.at(["reasonCodes"], decode.list(decode.string))),
    )
    == [["squad_space"]]
}

/// lifecycle H20: only this case's own decision attaches, not another case's, nor one naming this case for
/// another club.
pub fn only_this_cases_own_decision_attaches_test() {
  let s =
    store_with([
      room_at("case-T", "under_review", 1),
      room_at("case-Y", "archived", 1),
      "INSERT INTO room_decisions (id, room_id, org_id, player_id, recommendation, by_name, created_at) VALUES ('d-mine', 'case-T', 'o1', 'p1', 'shortlist', 'A', 5), ('d-othercase', 'case-Y', 'o1', 'p1', 'archive', 'B', 5), ('d-otherorg', 'case-T', 'o2', 'p1', 'offer', 'C', 5)",
    ])
  let body = club(s, "case-T", 10)
  assert at(
      body,
      ["decisions", "all"],
      decode.list(decode.at(["id"], decode.string)),
    )
    == ["d-mine"]
  assert !string.contains(body, "d-othercase")
  assert !string.contains(body, "d-otherorg")
}

// ----------------------------------------------------------------------------------------------- isolation

/// lifecycle H7, H18 and H19: other cases, of another club or another player of this club, neither change the
/// journey however they were written nor appear in it.
pub fn unrelated_cases_neither_change_nor_leak_into_the_journey_test() {
  let target = [
    room_at("case-T", "under_review", 1_767_225_600_000),
    history(
      "case-T",
      0,
      1_767_225_600_000,
      "room_created",
      "{\"status\":\"watching\"}",
    ),
    history(
      "case-T",
      1,
      1_767_312_000_000,
      status_changed,
      moved("watching", "under_review"),
    ),
  ]
  let noise_a = [
    room("case-X", "signed", 1, [
      #("org_id", q("o2")),
      #("owner_user_id", q("u2")),
      #("player_id", q("pOTHER")),
    ]),
    history(
      "case-X",
      0,
      1_767_398_400_000,
      status_changed,
      moved("offer_made", "signed"),
    ),
  ]
  let noise_b = [
    room("case-Y", "archived", 1, [#("player_id", q("pOTHER2"))]),
    history(
      "case-Y",
      0,
      1_767_484_800_000,
      status_changed,
      moved("watching", "archived"),
    ),
  ]
  let built = fn(groups) { club(store_with(list.flatten(groups)), "case-T", 5) }
  let one = built([noise_a, target, noise_b])
  assert built([noise_b, noise_a, target]) == one
  assert built([target, noise_b, noise_a]) == one
  list.each(["case-X", "o2", "pOTHER", "case-Y", "pOTHER2", "signed"], fn(x) {
    assert !string.contains(one, x)
  })
}

// ------------------------------------------------------------------------------------------------- contacts

const sentinel = "PRIVATE_CONTACT_TEXT_9182"

/// contacts V's case k1 at `contacted`, with its contacts: one answered, a draft, one recorded by phone, a
/// delivered one with no recipient, and another club's.
fn contacts_store(with_request: Bool) -> Store {
  store_with(
    list.flatten([
      [
        room_at("k1", "contacted", 1),
        history(
          "k1",
          0,
          10,
          status_changed,
          moved("contact_planned", "contacted"),
        ),
      ],
      case with_request {
        True -> [
          "INSERT INTO recruitment_requests (id, player_id, org_id, org_name, org_verified, org_safeguarding_certified, user_id, type, status, created_at, routed_to, contact_id, message) VALUES ('r1', 'p1', 'o1', 'Club One', 0, 0, 'u1', 'contact', 'accepted', 10, 'player', 'cA', "
          <> q(sentinel <> " shared body")
          <> ")",
        ]
        False -> []
      },
      [
        contact("cA", [
          #("status", q("responded")),
          #("body", q(sentinel <> " draft body")),
          #("recipient_type", q("player")),
          #("recipient_player_id", q("p1")),
          #("recipient_minor", "0"),
          #("delivered_at", "10"),
          #("responded_at", "20"),
          #("response_kind", q("accepted")),
          #("response_message", q(sentinel <> " reply")),
          #("response_by", q("player")),
          #("response_at", "20"),
        ]),
        contact("cB", [#("body", q(sentinel <> " draft body"))]),
        contact("cC", [
          #("status", q("recorded")),
          #("channel", q("phone")),
          #("recipient_type", q("player")),
          #("recipient_player_id", q("p1")),
          #("recipient_minor", "0"),
          #("occurred_at", "5"),
          #("recorded_at", "6"),
          #("summary", q(sentinel <> " summary")),
        ]),
        contact("cX", [#("status", q("delivered")), #("delivered_at", "3")]),
        contact("cO", [#("org_id", q("o2")), ..delivered]),
      ],
    ]),
  )
}

pub fn the_club_journey_lists_sound_contacts_as_milestones_never_words_test() {
  let s = contacts_store(True)
  let body = club(s, "k1", 100)
  assert at(
      body,
      ["contact", "contacts"],
      decode.list(decode.at(["id"], decode.string)),
    )
    == ["cA", "cB", "cC"]
  assert at(body, ["contact", "omitted"], decode.int) == 1
  assert !string.contains(body, "cO")
  assert !string.contains(body, sentinel)
  let k = kinds(body)
  assert list.contains(k, "contact_response_received")
  assert !list.contains(k, "contact_created")
  assert list.count(k, fn(x) { x == "contact_initiated" }) == 2
  assert club(s, "k1", 100) == body
}

pub fn contacts_initiated_in_the_same_millisecond_keep_one_order_test() {
  let line = fn(contacts) {
    let s =
      store_with([
        room_at("k1", "contacted", 1),
        ..list.map(contacts, fn(cid) {
          contact(cid, list.key_set(delivered, "delivered_at", "10"))
        })
      ])
    at(
      club(s, "k1", 100),
      ["history", "entries"],
      decode.list(decode.at(["contactId"], decode.string)),
    )
  }
  let once = line(["c9", "c8"])
  assert once == ["c8", "c9"]
  assert line(["c8", "c9"]) == once
}

fn recipient(s: Store, who: journey.Recipient) -> String {
  let assert Ok(found) = store.read(s, journey.for_recipient(_, who, 100))
  json.to_string(json.preprocessed_array(found))
}

pub fn the_player_sees_only_the_request_sent_to_them_test() {
  let player = journey.PlayerSelf(id.player("p1"))
  let body = recipient(contacts_store(True), player)
  assert string.contains(body, "\"r1\"")
  list.each(["k1", "cA", "cB"], fn(x) {
    assert !string.contains(body, x)
  })
  // With drafts and contacts only, nothing was shared: the same answer as for a player no club has a case on.
  assert recipient(contacts_store(False), player) == "[]"
  assert recipient(
      contacts_store(True),
      journey.PlayerSelf(id.player("p-none")),
    )
    == "[]"
}

pub fn a_guardian_with_no_share_gets_nothing_test() {
  assert recipient(
      contacts_store(True),
      journey.GuardianOf(id.player("p1"), id.guardian("g9")),
    )
    == "[]"
}

// ------------------------------------------------------------------------------------------------ the clock

pub fn the_projection_is_deterministic_for_the_same_rows_and_clock_test() {
  let s =
    store_with([
      room_at("case-1", "watching", 1),
      history("case-1", 0, 1, "room_created", "{\"status\":\"watching\"}"),
    ])
  let body = club(s, "case-1", 1000)
  assert club(s, "case-1", 1000) == body
  // lifecycle U3 #30: no score of any kind.
  list.each(
    ["score", "readiness", "probability", "percentage", "quality", "rating"],
    fn(word) {
      assert !string.contains(string.lowercase(body), word)
    },
  )
}
