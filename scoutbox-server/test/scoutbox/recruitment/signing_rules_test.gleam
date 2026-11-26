//// The signing rules' calls that Gleam's types can't hold (scripts/rules/recruitment/signings.mjs and
//// signingsAdversarial.mjs), and the club and recipient views, whose fixtures leave out columns every stored row has.
////
//// The TypeScript rules read a package whose status or instants are junk as unknown or corrupt. Here none of those
//// can be read, so none reaches a rule:
////
//// - a package's, a revision's and a party's status, and a party's type, are typed columns: the schema refuses a value
////   outside the vocabulary, and text that isn't one doesn't decode as one. That covers effectiveStatus's SIGNED,
////   signed, EXPIRED (derived, never stored) and "", and signingIntegrity's SIGNED, countersigned and WITNESS;
//// - an instant is an INTEGER column in a STRICT table: signingIntegrity's createdAt "yesterday", readyAt "later",
////   expiresAt "soon" and a party's completedAt "yesterday" are refused, and so is effectiveStatus's "soon";
//// - a jurisdiction is never absent at the pathway rule: the routes read an organisation with no country as GB;
//// - a contract day is read by the route's shape (`input.day_or_blank`) before validateContractDates, which refuses
////   one that isn't text under the contract's code;
//// - an expiry the write leaves out is None, which validate_expiry defaults;
//// - both callers of signingConsistency read the package's completed rows, so a COMPLETED package is always checked
////   against them (A40 passes none).

import gleam/dynamic
import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleam/result
import scoutbox/battery/base
import scoutbox/platform/input
import scoutbox/platform/store
import scoutbox/recruitment/signing_routes
import scoutbox/recruitment/signing_rules
import scoutbox/rows/id
import scoutbox/rows/signing_documents as doc_row
import scoutbox/rows/signing_packages as pkg_row
import scoutbox/rows/signing_revision_parties as party_row
import scoutbox/rows/signing_revisions as rev_row
import scoutbox/rows/signings as signing_row
import scoutbox/support
import scoutbox/vocab/recruitment_actor_kind
import scoutbox/vocab/room_status
import scoutbox/vocab/signing_party_type
import sqlight

const created = 1_773_576_000_000

const sha = "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8"

pub fn text_that_is_no_status_or_party_type_does_not_decode_as_one_test() {
  list.each(["SIGNED", "signed", "EXPIRED", ""], fn(text) {
    assert pkg_row.status_from_string(text) == Error(Nil)
  })
  assert rev_row.status_from_string("countersigned") == Error(Nil)
  assert signing_party_type.from_string("WITNESS") == Error(Nil)
  assert decode.run(dynamic.int(1), pkg_row.status_decoder()) |> result.is_error
  assert decode.run(dynamic.nil(), rev_row.status_decoder()) |> result.is_error
}

pub fn the_schema_refuses_what_no_stored_package_can_be_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let assert Ok(Nil) = store.unit(s, setup)
  let write = fn(f) { store.unit(s, f) }
  let text = sqlight.text
  let good = text("READY")
  let at = sqlight.int(created)
  // The same rows with good values are written, so each refusal below is the bad value's.
  assert write(package(_, "spk-ok", good, at, at)) == Ok(Nil)
  assert write(revision(_, "spk-ok", "spr-ok", text("READY"), at)) == Ok(Nil)
  assert write(party(_, "spr-ok", text("PLAYER"), text("COMPLETED"), at))
    == Ok(Nil)
  list.each(["SIGNED", "signed", "EXPIRED", ""], fn(t) {
    assert write(package(_, "spk-x", text(t), at, at)) |> result.is_error
  })
  assert write(package(_, "spk-x", good, text("yesterday"), at))
    |> result.is_error
  assert write(package(_, "spk-x", good, at, text("soon"))) |> result.is_error
  assert write(revision(_, "spk-ok", "spr-x", text("countersigned"), at))
    |> result.is_error
  assert write(revision(_, "spk-ok", "spr-x", text("READY"), text("later")))
    |> result.is_error
  assert write(party(
      _,
      "spr-ok",
      text("WITNESS"),
      text("PENDING"),
      sqlight.null(),
    ))
    |> result.is_error
  assert write(party(
      _,
      "spr-ok",
      text("CLUB_SIGNATORY"),
      text("COMPLETED"),
      text("yesterday"),
    ))
    |> result.is_error
  // A second party of a type the revision already has.
  assert write(party(
      _,
      "spr-ok",
      text("PLAYER"),
      text("PENDING"),
      sqlight.null(),
    ))
    |> result.is_error
}

fn setup(tx: store.Tx) -> Result(Nil, store.Fail(e)) {
  use _ <- result.try(
    store.run(
      tx,
      "INSERT INTO org_users (id, org_id, name, name_key, role, created_at)
     SELECT 'u-sign', MIN(id), 'Signing Lead', 'signing lead', 'Scout', 1 FROM orgs",
      [],
    ),
  )
  use _ <- result.try(
    store.run(
      tx,
      "INSERT INTO recruitment_cases (id, org_id, player_id, owner_user_id, stage, priority, restricted, created_at, room_status, room_priority, room_updated_at, room_rev)
     SELECT 'rc-sign', u.org_id, (SELECT MIN(id) FROM players), u.id, 'identified', 'medium', 0, 1, 'offer_accepted', 'normal', 1, 1
     FROM org_users u WHERE u.id = 'u-sign'",
      [],
    ),
  )
  use _ <- result.try(
    store.run(
      tx,
      "INSERT INTO recruitment_offers (id, org_id, case_id, player_id, type, status, current_revision_id, created_at, created_by_user_id, updated_at, rev, policy_version)
     SELECT 'of-sign', c.org_id, c.id, c.player_id, 'direct_recruitment', 'ACCEPTED', 'orv-sign', 1, 'u-sign', 1, 1, 1 FROM recruitment_cases c WHERE c.id = 'rc-sign'",
      [],
    ),
  )
  store.run(
    tx,
    "INSERT INTO offer_revisions (id, offer_id, position, revision_number, status, term_offer_type, issued_at, created_at, updated_at, rev)
     VALUES ('orv-sign', 'of-sign', 0, 1, 'ACCEPTED', 'direct_recruitment', 1, 1, 1, 1)",
    [],
  )
}

fn package(
  tx: store.Tx,
  package_id: String,
  status: sqlight.Value,
  created_at: sqlight.Value,
  expires_at: sqlight.Value,
) -> Result(Nil, store.Fail(e)) {
  store.run(
    tx,
    "INSERT INTO signing_packages (id, org_id, case_id, player_id, offer_id, offer_revision_id, status, current_revision_id, expires_at, created_at, created_by_user_id, updated_at)
     SELECT ?, c.org_id, c.id, c.player_id, 'of-sign', 'orv-sign', ?, 'spr-ok', ?, ?, 'u-sign', 1 FROM recruitment_cases c WHERE c.id = 'rc-sign'",
    [sqlight.text(package_id), status, expires_at, created_at],
  )
}

fn revision(
  tx: store.Tx,
  package_id: String,
  revision_id: String,
  status: sqlight.Value,
  ready_at: sqlight.Value,
) -> Result(Nil, store.Fail(e)) {
  store.run(
    tx,
    "INSERT INTO signing_revisions (id, package_id, position, revision_number, status, created_at, ready_at)
     VALUES (?, ?, 0, 1, ?, 1, ?)",
    [sqlight.text(revision_id), sqlight.text(package_id), status, ready_at],
  )
}

fn party(
  tx: store.Tx,
  revision_id: String,
  party_type: sqlight.Value,
  status: sqlight.Value,
  completed_at: sqlight.Value,
) -> Result(Nil, store.Fail(e)) {
  store.run(
    tx,
    "INSERT INTO signing_revision_parties (revision_id, position, party_type, status, completed_at)
     VALUES (?, (SELECT COUNT(*) FROM signing_revision_parties WHERE revision_id = ?), ?, ?, ?)",
    [
      sqlight.text(revision_id),
      sqlight.text(revision_id),
      party_type,
      status,
      completed_at,
    ],
  )
}

pub fn an_organisation_with_no_country_is_asked_about_gb_test() {
  // signing_routes reads `option.unwrap(org.country, "GB")`.
  assert !signing_rules.minor_pathway_open(option.unwrap(None, "GB"))
}

pub fn a_contract_day_that_is_not_text_is_refused_by_the_shape_test() {
  // signing_routes reads `contract` as an object whose `startDate` is `input.day_or_blank`, under its codes.
  let shape = {
    use start <- input.field(
      "contract",
      input.nullish(
        input.object({
          use start <- input.field(
            "startDate",
            input.nullish(input.day_or_blank()),
          )
          input.done(start)
        }),
      ),
    )
    input.done(start)
  }
  let assert Error(r) =
    input.parse_coded(
      shape,
      base.body("{\"contract\":{\"startDate\":1720000000000}}"),
      root: "body",
      codes: signing_routes.input_codes,
      default: "SIGNING_INPUT_INVALID",
    )
  assert r.error == "SIGNING_CONTRACT_DATES_INVALID"
  assert r.field == "contract.startDate"
}

pub fn an_absent_expiry_is_the_default_test() {
  assert signing_rules.validate_expiry(None, created)
    == Ok(#(created + signing_rules.default_expiry_ms, True))
}

pub fn a_completed_package_is_checked_against_its_rows_test() {
  let p = completed()
  let kase =
    Some(base.kase(
      id.recruitment_case("c1"),
      id.org("o1"),
      id.player("p1"),
      room_status.OfferAccepted,
    ))
  let row =
    signing_row.Row(
      ..signing_row.new(
        id: id.signing("s"),
        player_id: id.player("p1"),
        org_id: id.org("o1"),
        ts: created,
      ),
      signing_package_id: Some(id.signing_package("spk-1")),
    )
  // signings.mjs A40: its own completed row, on a case still at Offer accepted.
  assert signing_rules.consistency(p, None, kase, [row], None, created)
    == ["COMPLETED_BUT_CASE_NOT_SIGNED"]
  assert signing_rules.consistency(p, None, kase, [], None, created)
    == [
      "COMPLETED_WITHOUT_ROW", "COMPLETION_ROW_MISMATCH",
      "COMPLETED_BUT_CASE_NOT_SIGNED",
    ]
}

fn completed() -> signing_rules.Package {
  let p = a32()
  signing_rules.Package(
    ..p,
    row: pkg_row.Row(
      ..p.row,
      status: pkg_row.Completed,
      completion_signing_id: Some(id.signing("s")),
      completion_completed_at: Some(created),
    ),
  )
}

// ------------------------------------------------------------------------------------------------------ views

// The views of signings.mjs A42, over the same package as stored. Each expected view is the TypeScript one with the
// columns the fixture left out as the stored row has them: the document's id, and the package's creator.

/// signings.mjs A32's package: one presented revision, both parties pending, with the club's internal note.
fn a32() -> signing_rules.Package {
  let p = base.signing_package()
  let rid = id.signing_revision("spr-1")
  let pending = fn(position, party_type, entity) {
    party_row.Row(
      ..party_row.new(revision_id: rid, position:, party_type:),
      for_entity_id: Some(entity),
      for_player_id: Some(id.player("p1")),
    )
  }
  signing_rules.Package(
    ..p,
    row: pkg_row.Row(
      ..p.row,
      id: id.signing_package("spk-1"),
      org_id: id.org("o1"),
      case_id: id.recruitment_case("c1"),
      player_id: id.player("p1"),
      offer_id: id.offer("rof-1"),
      offer_revision_id: "rofr-1",
      status: pkg_row.Ready,
      current_revision_id: rid,
      expires_at: Some(1_774_180_800_000),
      internal_note: Some("PRIVATE_SIGNING_NOTE_8811"),
      created_at: created,
      created_by_kind: Some(recruitment_actor_kind.Org),
      created_by_name: Some("Coach"),
      updated_at: created,
    ),
    revisions: [
      signing_rules.Revision(
        row: rev_row.Row(
          ..base.signing_revision(),
          id: rid,
          package_id: id.signing_package("spk-1"),
          status: rev_row.Ready,
          created_at: created,
          ready_at: Some(1_773_579_600_000),
          contract_start_date: Some("2027-07-01"),
        ),
        document: Some(
          doc_row.Row(
            ..base.signing_document(),
            id: id.signing_document("sd-1"),
            revision_id: rid,
            evidence_id: id.evidence("vevd-1"),
            sha256: sha,
          ),
        ),
        executed: None,
        parties: [
          pending(0, signing_party_type.Player, "p1"),
          pending(1, signing_party_type.ClubSignatory, "o1"),
        ],
      ),
    ],
  )
}

pub fn the_club_view_test() {
  assert json.to_string(
      json.object(signing_rules.club_view(a32(), created, None)),
    )
    == "{\"id\":\"spk-1\",\"orgId\":\"o1\",\"orgName\":null,\"caseId\":\"c1\",\"playerId\":\"p1\",\"offerId\":\"rof-1\",\"offerRevisionId\":\"rofr-1\",\"transactionId\":null,\"status\":\"READY\",\"storedStatus\":\"READY\",\"statusLabel\":\"Presented — awaiting signatures\",\"terminal\":false,\"currentRevisionId\":\"spr-1\",\"currentRevision\":{\"id\":\"spr-1\",\"revisionNumber\":1,\"status\":\"READY\",\"statusLabel\":\"Presented — awaiting signatures\",\"createdAt\":1773576000000,\"readyAt\":1773579600000,\"completedAt\":null,\"document\":{\"id\":\"sd-1\",\"label\":null,\"filename\":null,\"mime\":null,\"bytes\":null,\"sha256\":\"33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8\"},\"executedDocument\":null,\"contract\":{\"startDate\":\"2027-07-01\",\"endDate\":null},\"requiredParties\":[{\"partyType\":\"PLAYER\",\"status\":\"PENDING\",\"completedAt\":null,\"method\":null,\"completedBy\":null},{\"partyType\":\"CLUB_SIGNATORY\",\"status\":\"PENDING\",\"completedAt\":null,\"method\":null,\"completedBy\":null}],\"supersedesRevisionId\":null,\"supersededByRevisionId\":null,\"createdBy\":null,\"readyBy\":null},\"revisions\":[{\"id\":\"spr-1\",\"revisionNumber\":1,\"status\":\"READY\",\"statusLabel\":\"Presented — awaiting signatures\",\"createdAt\":1773576000000,\"readyAt\":1773579600000,\"completedAt\":null,\"document\":{\"id\":\"sd-1\",\"label\":null,\"filename\":null,\"mime\":null,\"bytes\":null,\"sha256\":\"33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8\"},\"executedDocument\":null,\"contract\":{\"startDate\":\"2027-07-01\",\"endDate\":null},\"requiredParties\":[{\"partyType\":\"PLAYER\",\"status\":\"PENDING\",\"completedAt\":null,\"method\":null,\"completedBy\":null},{\"partyType\":\"CLUB_SIGNATORY\",\"status\":\"PENDING\",\"completedAt\":null,\"method\":null,\"completedBy\":null}],\"supersedesRevisionId\":null,\"supersededByRevisionId\":null,\"createdBy\":null,\"readyBy\":null}],\"expiresAt\":1774180800000,\"internalNote\":\"PRIVATE_SIGNING_NOTE_8811\",\"completion\":null,\"cancelledAt\":null,\"cancelReason\":null,\"voidedAt\":null,\"voidReason\":null,\"createdAt\":1773576000000,\"createdBy\":{\"kind\":\"org\",\"name\":\"Coach\"},\"updatedAt\":1773576000000,\"rev\":1,\"policyVersion\":1,\"honest\":\"ScoutBox records the signing workflow and the evidence each party gives against the exact document. It does not execute the agreement and claims no legal effect beyond what it records.\"}"
}

pub fn the_recipient_view_test() {
  assert json.to_string(
      json.object(signing_rules.recipient_view(
        a32(),
        created,
        None,
        signing_party_type.Player,
        "p1",
      )),
    )
    == "{\"id\":\"spk-1\",\"playerId\":\"p1\",\"club\":{\"id\":\"o1\",\"name\":null},\"offerId\":\"rof-1\",\"offerRevisionId\":\"rofr-1\",\"status\":\"READY\",\"statusLabel\":\"Presented — awaiting signatures\",\"terminal\":false,\"currentRevisionId\":\"spr-1\",\"currentRevision\":{\"id\":\"spr-1\",\"revisionNumber\":1,\"status\":\"READY\",\"statusLabel\":\"Presented — awaiting signatures\",\"createdAt\":1773576000000,\"readyAt\":1773579600000,\"completedAt\":null,\"document\":{\"id\":\"sd-1\",\"label\":null,\"filename\":null,\"mime\":null,\"bytes\":null,\"sha256\":\"33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8\"},\"executedDocument\":null,\"contract\":{\"startDate\":\"2027-07-01\",\"endDate\":null},\"requiredParties\":[{\"partyType\":\"PLAYER\",\"status\":\"PENDING\",\"completedAt\":null,\"method\":null,\"completedBy\":null},{\"partyType\":\"CLUB_SIGNATORY\",\"status\":\"PENDING\",\"completedAt\":null,\"method\":null,\"completedBy\":null}],\"supersedesRevisionId\":null,\"supersededByRevisionId\":null},\"revisions\":[{\"id\":\"spr-1\",\"revisionNumber\":1,\"status\":\"READY\",\"statusLabel\":\"Presented — awaiting signatures\",\"createdAt\":1773576000000,\"readyAt\":1773579600000,\"completedAt\":null,\"document\":{\"id\":\"sd-1\",\"label\":null,\"filename\":null,\"mime\":null,\"bytes\":null,\"sha256\":\"33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8\"},\"executedDocument\":null,\"contract\":{\"startDate\":\"2027-07-01\",\"endDate\":null},\"requiredParties\":[{\"partyType\":\"PLAYER\",\"status\":\"PENDING\",\"completedAt\":null,\"method\":null,\"completedBy\":null},{\"partyType\":\"CLUB_SIGNATORY\",\"status\":\"PENDING\",\"completedAt\":null,\"method\":null,\"completedBy\":null}],\"supersedesRevisionId\":null,\"supersededByRevisionId\":null}],\"expiresAt\":1774180800000,\"nextAction\":{\"action\":\"COMPLETE_SIGNATURE\",\"revisionId\":\"spr-1\",\"documentSha256\":\"33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8\"},\"completion\":null,\"policyVersion\":1,\"honest\":\"Completing your signature here records that you, as the authenticated account holder, confirm the exact document shown. ScoutBox records the workflow and the evidence; it does not execute the agreement for you.\"}"
}
