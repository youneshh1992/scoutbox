//// The Offer rules' calls that Gleam's types can't hold (scripts/rules/recruitment/offers.mjs and
//// offersAdversarial.mjs), and the views, whose fixtures leave out columns every stored row has.
////
//// The TypeScript rules read a revision whose status or expiry is junk as unknown or EXPIRED, and an Offer with a
//// forged type or pointer as corrupt. Here none of those can be read, so none reaches a rule:
////
//// - a revision's status is a typed column: the schema refuses a value outside the vocabulary, and text that isn't a
////   status doesn't decode as one. That covers effectiveRevisionStatus, liveStatus and canRespondToRevision's
////   unknown-status sweep (VIEWED, signed, Issued, "ISSUED ", "", null, 1, {} and no status at all);
//// - an expiry is an INTEGER column in a STRICT table, and every writer binds an Int: text that is no number
////   ("soon", "2026-02-30T00:00:00Z", "{}") is refused, and "1e12", NaN, Infinity and false are not values a writer
////   has. An absent one is None, which `effective` reads as EXPIRED, like the TypeScript rule;
//// - an Offer's type is a vocabulary column ("loan" is refused), a revision's id is the primary key (two can't share
////   one), and the current-revision pointer is TEXT with a deferred foreign key to the Offer's own revisions, so a
////   dangling pointer can't be committed. A number is no pointer: 7 is the text "7", which names no revision;
//// - a responder is a `party.Party`: there is no agent to name, so an agent never answers an Offer;
//// - an evidence kind is `offer_rules.EvidenceKind`: case_lifecycle asks the Offer rule only about offer_sent and the
////   recipient's answer, and confirmed_join is read from signings, so the Offer rule is never asked about it. With
////   no store the TypeScript rule answers offers_store_unavailable; here a failed read fails the request;
//// - a jurisdiction is never absent at the pathway rule: the routes read an organisation with no country as GB;
//// - an expiry is sent in a JSON body, which can't carry NaN or Infinity; an absent one is None.

import gleam/dynamic
import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleam/result
import scoutbox/battery/base
import scoutbox/platform/store
import scoutbox/recruitment/offer_rules
import scoutbox/rows/id
import scoutbox/rows/offer_read_receipts as receipt_row
import scoutbox/rows/offer_revision_documents as document_row
import scoutbox/rows/offer_revisions as revision_row
import scoutbox/rows/recruitment_offers as offer_row
import scoutbox/support
import scoutbox/vocab/offer_status
import scoutbox/vocab/party
import sqlight

const not_statuses = ["VIEWED", "signed", "Issued", "ISSUED ", ""]

const now = 1_800_000_000_000

pub fn text_that_is_not_a_status_does_not_decode_as_one_test() {
  list.each(not_statuses, fn(text) {
    assert offer_status.from_string(text) == Error(Nil)
  })
  assert decode.run(dynamic.int(1), offer_status.decoder()) |> result.is_error
  assert decode.run(dynamic.nil(), offer_status.decoder()) |> result.is_error
}

pub fn the_schema_refuses_what_no_stored_offer_can_be_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let assert Ok(Nil) =
    store.unit(s, fn(tx) {
      use _ <- result.try(
        store.run(
          tx,
          "INSERT INTO org_users (id, org_id, name, name_key, role, created_at)
         SELECT 'u-offer', MIN(id), 'Offer Scout', 'offer scout', 'Scout', 1 FROM orgs",
          [],
        ),
      )
      use _ <- result.try(
        store.run(
          tx,
          "INSERT INTO recruitment_cases (id, org_id, player_id, owner_user_id, stage, priority, restricted, created_at, room_status, room_priority, room_updated_at, room_rev)
         SELECT 'rc-offer', u.org_id, (SELECT MIN(id) FROM players), u.id, 'identified', 'medium', 0, 1, 'offer_made', 'normal', 1, 1
         FROM org_users u WHERE u.id = 'u-offer'",
          [],
        ),
      )
      use _ <- result.try(offer(tx, "of-1", "direct_recruitment", "orv-1"))
      revision(tx, "orv-1", 0, sqlight.text("ISSUED"), sqlight.int(now))
    })
  let write = fn(f) { store.unit(s, f) }
  // The same rows with good values are written, so each refusal below is the bad value's.
  assert write(revision(_, "orv-2", 1, sqlight.text("ISSUED"), sqlight.int(now)))
    == Ok(Nil)
  list.each(not_statuses, fn(text) {
    assert write(revision(_, "orv-x", 9, sqlight.text(text), sqlight.int(now)))
      |> result.is_error
  })
  assert write(revision(_, "orv-x", 9, sqlight.null(), sqlight.int(now)))
    |> result.is_error
  assert write(revision(_, "orv-x", 9, sqlight.int(1), sqlight.int(now)))
    |> result.is_error
  list.each(["soon", "2026-02-30T00:00:00Z", "{}"], fn(text) {
    assert write(revision(
        _,
        "orv-x",
        9,
        sqlight.text("ISSUED"),
        sqlight.text(text),
      ))
      |> result.is_error
  })
  assert write(revision(
      _,
      "orv-x",
      9,
      sqlight.text("ISSUED"),
      sqlight.float(1.5),
    ))
    |> result.is_error
  // A second revision under an id the Offer already has.
  assert write(revision(_, "orv-1", 9, sqlight.text("ISSUED"), sqlight.int(now)))
    |> result.is_error
  assert write(offer(_, "of-2", "direct_recruitment", "orv-3"))
    |> result.is_error
  assert write(fn(tx) {
      use _ <- result.try(offer(tx, "of-2", "loan", "orv-3"))
      revision_of(
        tx,
        "of-2",
        "orv-3",
        0,
        sqlight.text("ISSUED"),
        sqlight.int(now),
      )
    })
    |> result.is_error
  assert write(fn(tx) {
      use _ <- result.try(offer(tx, "of-2", "direct_recruitment", "orv-3"))
      revision_of(
        tx,
        "of-2",
        "orv-3",
        0,
        sqlight.text("ISSUED"),
        sqlight.int(now),
      )
    })
    == Ok(Nil)
}

fn offer(
  tx: store.Tx,
  offer_id: String,
  type_: String,
  current: String,
) -> Result(Nil, store.Fail(e)) {
  store.run(
    tx,
    "INSERT INTO recruitment_offers (id, org_id, case_id, player_id, type, status, current_revision_id, created_at, created_by_user_id, updated_at, rev, policy_version)
     SELECT ?, c.org_id, c.id, c.player_id, ?, 'ISSUED', ?, 1, 'u-offer', 1, 1, 1 FROM recruitment_cases c WHERE c.id = 'rc-offer'",
    [sqlight.text(offer_id), sqlight.text(type_), sqlight.text(current)],
  )
}

fn revision(
  tx: store.Tx,
  revision_id: String,
  position: Int,
  status: sqlight.Value,
  expires_at: sqlight.Value,
) -> Result(Nil, store.Fail(e)) {
  revision_of(tx, "of-1", revision_id, position, status, expires_at)
}

fn revision_of(
  tx: store.Tx,
  offer_id: String,
  revision_id: String,
  position: Int,
  status: sqlight.Value,
  expires_at: sqlight.Value,
) -> Result(Nil, store.Fail(e)) {
  store.run(
    tx,
    "INSERT INTO offer_revisions (id, offer_id, position, revision_number, status, term_offer_type, expires_at, issued_at, created_at, updated_at, rev)
     VALUES (?, ?, ?, ?, ?, 'direct_recruitment', ?, 1, 1, 1, 1)",
    [
      sqlight.text(revision_id),
      sqlight.text(offer_id),
      sqlight.int(position),
      sqlight.int(position + 1),
      status,
      expires_at,
    ],
  )
}

pub fn an_issued_revision_with_no_expiry_reads_expired_test() {
  let r =
    revision_row.Row(
      ..base.offer_revision(),
      status: offer_status.Issued,
      issued_at: Some(now),
      expires_at: None,
    )
  assert offer_rules.effective(r, now) == offer_status.Expired
}

pub fn a_number_names_no_revision_test() {
  let o = issued_offer()
  let forged =
    offer_rules.Offer(
      ..o,
      row: offer_row.Row(..o.row, current_revision_id: id.offer_revision("7")),
    )
  assert offer_rules.integrity(forged, None, None) == ["current_revision"]
}

pub fn an_agent_is_no_responder_test() {
  assert party.from_string("agent") == Error(Nil)
}

pub fn an_organisation_with_no_country_is_asked_about_gb_test() {
  // offer_routes reads `option.unwrap(org.country, "GB")`.
  assert !offer_rules.minor_pathway_open(option.unwrap(None, "GB"))
}

pub fn an_absent_expiry_is_none_and_json_carries_no_nan_test() {
  assert offer_rules.validate_expiry(None, Some(now), False) == Ok(None)
  assert offer_rules.validate_expiry(None, Some(now), True)
    |> result.map_error(base.offer_refusal)
    == Error(
      "{\"error\":\"OFFER_EXPIRY_INVALID\",\"field\":\"expiresAt\",\"problem\":\"required\",\"message\":\"An issued Offer needs an expiry.\"}",
    )
  assert json.parse("NaN", decode.dynamic) |> result.is_error
  assert json.parse("Infinity", decode.dynamic) |> result.is_error
}

// ------------------------------------------------------------------------------------------------------ views

// The views of offers.mjs A87 and offersAdversarial P-p5, over the same Offer as stored. Each expected view is the
// TypeScript one with the columns the fixture left out as the stored row has them: a revision's createdAt (0 here),
// its terms (every term null when none were set), the readiness snapshot's four fields, and the Offer's createdAt and
// updatedAt. `signing` is set by the routes, not the view.

/// offers.mjs A87's Offer: one issued revision, with every field the views choose between.
fn a87() -> offer_rules.Offer {
  let o = issued_offer()
  let assert [r] = o.revisions
  let revision =
    offer_rules.Revision(
      row: revision_row.Row(
        ..r.row,
        term_role: Some("W"),
        term_start_date: Some("2027-07-01"),
        internal_note: Some("PRIVATE_OFFER_INTERNAL_NOTE_SENTINEL_7731"),
        recipient_message: Some("RECIPIENT_MESSAGE_VISIBLE_4402"),
        withdraw_reason: Some("PRIVATE_WITHDRAW_REASON_SENTINEL_2210"),
        readiness_blockers_json: Some("[\"X\"]"),
      ),
      documents: [
        document_row.Row(
          ..document_row.new(
            id: id.offer_document("d1"),
            revision_id: id.offer_revision("r1"),
            position: 0,
            evidence_id: id.evidence("vevd-1"),
          ),
          label: Some("L"),
        ),
      ],
    )
  offer_rules.Offer(
    ..o,
    row: offer_row.Row(
      ..o.row,
      decision_id: Some(id.room_decision("dec-1")),
      transaction_id: Some("atx-1"),
      agent_share_user_id: Some(id.org_user("u")),
      agent_share_at: Some(now),
    ),
    revisions: [revision],
    receipts: [
      receipt_row.new(
        offer_id: id.offer("o1"),
        position: 0,
        revision_id: id.offer_revision("r1"),
        viewer_kind: party.Player,
        viewer_id: "p1",
        first_viewed_at: now + 1,
      ),
    ],
  )
}

/// Offer o1 of org-A's case c1 for p1, with revision r1 issued to the player at `now` until a day later.
fn issued_offer() -> offer_rules.Offer {
  let o = base.offer()
  offer_rules.Offer(
    ..o,
    row: offer_row.Row(
      ..o.row,
      id: id.offer("o1"),
      org_id: id.org("org-A"),
      case_id: id.recruitment_case("c1"),
      player_id: id.player("p1"),
      current_revision_id: id.offer_revision("r1"),
    ),
    revisions: [
      offer_rules.Revision(
        row: revision_row.Row(
          ..base.offer_revision(),
          id: id.offer_revision("r1"),
          offer_id: id.offer("o1"),
          status: offer_status.Issued,
          issued_at: Some(now),
          expires_at: Some(now + 86_400_000),
          recipient_type: Some(party.Player),
          recipient_player_id: Some(id.player("p1")),
          recipient_at: Some(now),
        ),
        documents: [],
      ),
    ],
  )
}

/// offersAdversarial P-p5's Offer: A87's revision with no terms, created an hour before it was issued.
fn p_p5() -> offer_rules.Offer {
  let o = issued_offer()
  let assert [r] = o.revisions
  offer_rules.Offer(..o, revisions: [
    offer_rules.Revision(
      ..r,
      row: revision_row.Row(..r.row, created_at: now - 3_600_000),
    ),
  ])
}

fn shown(view: List(#(String, json.Json))) -> String {
  json.object(list.filter(view, fn(f) { f.0 != "signing" })) |> json.to_string
}

pub fn the_club_view_test() {
  assert shown(offer_rules.club_view(a87(), now))
    == "{\"id\":\"o1\",\"caseId\":\"c1\",\"playerId\":\"p1\",\"orgId\":\"org-A\",\"type\":\"direct_recruitment\",\"status\":\"ISSUED\",\"statusLabel\":\"Issued — awaiting response\",\"currentRevisionId\":\"r1\",\"liveRevisionId\":\"r1\",\"liveStatus\":\"ISSUED\",\"awaitingResponse\":true,\"currentRevision\":{\"id\":\"r1\",\"revisionNumber\":1,\"status\":\"ISSUED\",\"storedStatus\":\"ISSUED\",\"statusLabel\":\"Issued — awaiting response\",\"terms\":{\"offerType\":\"direct_recruitment\",\"role\":\"W\",\"squad\":null,\"startDate\":\"2027-07-01\",\"endDate\":null,\"conditions\":null},\"recipientMessage\":\"RECIPIENT_MESSAGE_VISIBLE_4402\",\"documents\":[{\"id\":\"d1\",\"label\":\"L\"}],\"expiresAt\":1800086400000,\"issuedAt\":1800000000000,\"createdAt\":0,\"supersedesRevisionId\":null,\"supersededByRevisionId\":null,\"withdrawnAt\":null,\"respondedAt\":null,\"rev\":1,\"internalNote\":\"PRIVATE_OFFER_INTERNAL_NOTE_SENTINEL_7731\",\"issuedBy\":null,\"createdBy\":null,\"withdrawnBy\":null,\"withdrawReason\":\"PRIVATE_WITHDRAW_REASON_SENTINEL_2210\",\"recipient\":{\"type\":\"player\",\"minor\":false},\"readiness\":{\"transactionId\":null,\"evaluatedAt\":null,\"status\":null,\"blockers\":[\"X\"]}},\"revisions\":[{\"id\":\"r1\",\"revisionNumber\":1,\"status\":\"ISSUED\",\"storedStatus\":\"ISSUED\",\"statusLabel\":\"Issued — awaiting response\",\"terms\":{\"offerType\":\"direct_recruitment\",\"role\":\"W\",\"squad\":null,\"startDate\":\"2027-07-01\",\"endDate\":null,\"conditions\":null},\"recipientMessage\":\"RECIPIENT_MESSAGE_VISIBLE_4402\",\"documents\":[{\"id\":\"d1\",\"label\":\"L\"}],\"expiresAt\":1800086400000,\"issuedAt\":1800000000000,\"createdAt\":0,\"supersedesRevisionId\":null,\"supersededByRevisionId\":null,\"withdrawnAt\":null,\"respondedAt\":null,\"rev\":1,\"internalNote\":\"PRIVATE_OFFER_INTERNAL_NOTE_SENTINEL_7731\",\"issuedBy\":null,\"createdBy\":null,\"withdrawnBy\":null,\"withdrawReason\":\"PRIVATE_WITHDRAW_REASON_SENTINEL_2210\"}],\"responses\":[],\"firstViewedAt\":1800000000001,\"agentShared\":true,\"decisionId\":\"dec-1\",\"transactionId\":\"atx-1\",\"lifecycle\":null,\"createdAt\":0,\"updatedAt\":0,\"rev\":1,\"policyVersion\":1,\"honest\":\"An Offer is the club's proposal, issued as an exact revision. An acceptance in ScoutBox is the recipient saying yes to that revision; it is not a signing, not a registration and not an executed contract.\"}"
}

pub fn the_recipient_view_test() {
  assert shown(offer_rules.recipient_view(a87(), now, None, True))
    == "{\"id\":\"o1\",\"playerId\":\"p1\",\"club\":{\"id\":\"org-A\",\"name\":null},\"type\":\"direct_recruitment\",\"status\":\"ISSUED\",\"statusLabel\":\"Issued — awaiting response\",\"currentRevisionId\":\"r1\",\"currentRevision\":{\"id\":\"r1\",\"revisionNumber\":1,\"status\":\"ISSUED\",\"storedStatus\":\"ISSUED\",\"statusLabel\":\"Issued — awaiting response\",\"terms\":{\"offerType\":\"direct_recruitment\",\"role\":\"W\",\"squad\":null,\"startDate\":\"2027-07-01\",\"endDate\":null,\"conditions\":null},\"recipientMessage\":\"RECIPIENT_MESSAGE_VISIBLE_4402\",\"documents\":[{\"id\":\"d1\",\"label\":\"L\"}],\"expiresAt\":1800086400000,\"issuedAt\":1800000000000,\"createdAt\":0,\"supersedesRevisionId\":null,\"supersededByRevisionId\":null,\"withdrawnAt\":null,\"respondedAt\":null,\"rev\":1},\"revisions\":[{\"id\":\"r1\",\"revisionNumber\":1,\"status\":\"ISSUED\",\"storedStatus\":\"ISSUED\",\"statusLabel\":\"Issued — awaiting response\",\"terms\":{\"offerType\":\"direct_recruitment\",\"role\":\"W\",\"squad\":null,\"startDate\":\"2027-07-01\",\"endDate\":null,\"conditions\":null},\"recipientMessage\":\"RECIPIENT_MESSAGE_VISIBLE_4402\",\"documents\":[{\"id\":\"d1\",\"label\":\"L\"}],\"expiresAt\":1800086400000,\"issuedAt\":1800000000000,\"createdAt\":0,\"supersedesRevisionId\":null,\"supersededByRevisionId\":null,\"withdrawnAt\":null,\"respondedAt\":null,\"rev\":1}],\"awaitingYourResponse\":true,\"answerable\":true,\"notAnswerableReason\":null,\"responses\":[],\"agentShared\":true,\"policyVersion\":1,\"honest\":\"Accepting an Offer in ScoutBox tells the club you say yes to exactly these terms. It is not a signature, not a registration and not a contract; nothing is signed here.\"}"
}

pub fn the_agent_view_test() {
  assert shown(offer_rules.agent_view(a87(), now, None))
    == "{\"id\":\"o1\",\"clientId\":\"p1\",\"club\":{\"id\":\"org-A\",\"name\":null},\"type\":\"direct_recruitment\",\"status\":\"ISSUED\",\"statusLabel\":\"Issued — awaiting response\",\"currentRevision\":{\"id\":\"r1\",\"revisionNumber\":1,\"status\":\"ISSUED\",\"storedStatus\":\"ISSUED\",\"statusLabel\":\"Issued — awaiting response\",\"terms\":{\"offerType\":\"direct_recruitment\",\"role\":\"W\",\"squad\":null,\"startDate\":\"2027-07-01\",\"endDate\":null,\"conditions\":null},\"recipientMessage\":\"RECIPIENT_MESSAGE_VISIBLE_4402\",\"documents\":[],\"expiresAt\":1800086400000,\"issuedAt\":1800000000000,\"createdAt\":0,\"supersedesRevisionId\":null,\"supersededByRevisionId\":null,\"withdrawnAt\":null,\"respondedAt\":null,\"rev\":1},\"revisions\":[{\"id\":\"r1\",\"revisionNumber\":1,\"status\":\"ISSUED\",\"storedStatus\":\"ISSUED\",\"statusLabel\":\"Issued — awaiting response\",\"terms\":{\"offerType\":\"direct_recruitment\",\"role\":\"W\",\"squad\":null,\"startDate\":\"2027-07-01\",\"endDate\":null,\"conditions\":null},\"recipientMessage\":\"RECIPIENT_MESSAGE_VISIBLE_4402\",\"documents\":[],\"expiresAt\":1800086400000,\"issuedAt\":1800000000000,\"createdAt\":0,\"supersedesRevisionId\":null,\"supersededByRevisionId\":null,\"withdrawnAt\":null,\"respondedAt\":null,\"rev\":1}],\"awaitingClientResponse\":true,\"responses\":[],\"sharedAt\":1800000000000,\"honest\":\"Your client shared this Offer with you. Accepting or declining is your client's own act; ScoutBox does not let you answer on their behalf, and nothing here is a negotiation, a fee or a signing.\"}"
}

pub fn a_paused_case_is_not_answerable_test() {
  assert shown(offer_rules.recipient_view(p_p5(), now, None, False))
    == "{\"id\":\"o1\",\"playerId\":\"p1\",\"club\":{\"id\":\"org-A\",\"name\":null},\"type\":\"direct_recruitment\",\"status\":\"ISSUED\",\"statusLabel\":\"Issued — awaiting response\",\"currentRevisionId\":\"r1\",\"currentRevision\":{\"id\":\"r1\",\"revisionNumber\":1,\"status\":\"ISSUED\",\"storedStatus\":\"ISSUED\",\"statusLabel\":\"Issued — awaiting response\",\"terms\":{\"offerType\":\"direct_recruitment\",\"role\":null,\"squad\":null,\"startDate\":null,\"endDate\":null,\"conditions\":null},\"recipientMessage\":null,\"documents\":[],\"expiresAt\":1800086400000,\"issuedAt\":1800000000000,\"createdAt\":1799996400000,\"supersedesRevisionId\":null,\"supersededByRevisionId\":null,\"withdrawnAt\":null,\"respondedAt\":null,\"rev\":1},\"revisions\":[{\"id\":\"r1\",\"revisionNumber\":1,\"status\":\"ISSUED\",\"storedStatus\":\"ISSUED\",\"statusLabel\":\"Issued — awaiting response\",\"terms\":{\"offerType\":\"direct_recruitment\",\"role\":null,\"squad\":null,\"startDate\":null,\"endDate\":null,\"conditions\":null},\"recipientMessage\":null,\"documents\":[],\"expiresAt\":1800086400000,\"issuedAt\":1800000000000,\"createdAt\":1799996400000,\"supersedesRevisionId\":null,\"supersededByRevisionId\":null,\"withdrawnAt\":null,\"respondedAt\":null,\"rev\":1}],\"awaitingYourResponse\":false,\"answerable\":false,\"notAnswerableReason\":\"CASE_PAUSED\",\"responses\":[],\"agentShared\":false,\"policyVersion\":1,\"honest\":\"Accepting an Offer in ScoutBox tells the club you say yes to exactly these terms. It is not a signature, not a registration and not a contract; nothing is signed here.\"}"
  assert shown(offer_rules.recipient_view(p_p5(), now, None, True))
    == "{\"id\":\"o1\",\"playerId\":\"p1\",\"club\":{\"id\":\"org-A\",\"name\":null},\"type\":\"direct_recruitment\",\"status\":\"ISSUED\",\"statusLabel\":\"Issued — awaiting response\",\"currentRevisionId\":\"r1\",\"currentRevision\":{\"id\":\"r1\",\"revisionNumber\":1,\"status\":\"ISSUED\",\"storedStatus\":\"ISSUED\",\"statusLabel\":\"Issued — awaiting response\",\"terms\":{\"offerType\":\"direct_recruitment\",\"role\":null,\"squad\":null,\"startDate\":null,\"endDate\":null,\"conditions\":null},\"recipientMessage\":null,\"documents\":[],\"expiresAt\":1800086400000,\"issuedAt\":1800000000000,\"createdAt\":1799996400000,\"supersedesRevisionId\":null,\"supersededByRevisionId\":null,\"withdrawnAt\":null,\"respondedAt\":null,\"rev\":1},\"revisions\":[{\"id\":\"r1\",\"revisionNumber\":1,\"status\":\"ISSUED\",\"storedStatus\":\"ISSUED\",\"statusLabel\":\"Issued — awaiting response\",\"terms\":{\"offerType\":\"direct_recruitment\",\"role\":null,\"squad\":null,\"startDate\":null,\"endDate\":null,\"conditions\":null},\"recipientMessage\":null,\"documents\":[],\"expiresAt\":1800086400000,\"issuedAt\":1800000000000,\"createdAt\":1799996400000,\"supersedesRevisionId\":null,\"supersededByRevisionId\":null,\"withdrawnAt\":null,\"respondedAt\":null,\"rev\":1}],\"awaitingYourResponse\":true,\"answerable\":true,\"notAnswerableReason\":null,\"responses\":[],\"agentShared\":false,\"policyVersion\":1,\"honest\":\"Accepting an Offer in ScoutBox tells the club you say yes to exactly these terms. It is not a signature, not a registration and not a contract; nothing is signed here.\"}"
}
