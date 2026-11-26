//// Checks of the rules from the rules suites of recruitment/signings, recruitment/signingsAdversarial, first generated
//// from the TypeScript server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import gleam/json
import gleam/option.{None, Some}
import gleam/result
import scoutbox/battery/base
import scoutbox/recruitment/offer_rules
import scoutbox/recruitment/signing_rules
import scoutbox/rows/id
import scoutbox/rows/offer_revisions
import scoutbox/rows/recruitment_offers
import scoutbox/rows/signing_documents
import scoutbox/rows/signing_packages
import scoutbox/rows/signing_revision_parties
import scoutbox/rows/signing_revisions
import scoutbox/rows/signings
import scoutbox/vocab/offer_status
import scoutbox/vocab/recruitment_actor_kind
import scoutbox/vocab/room_status
import scoutbox/vocab/signing_method
import scoutbox/vocab/signing_party_type

// signings: minorSigningPathwayOpen — [neg] #15 A7 the minor signing pathway is closed in every jurisdiction, including unknown and prototype keys
pub fn neg_15_a7_the_minor_signing_pathway_is_closed_in_every_jurisdiction_incl_test() {
  assert signing_rules.minor_pathway_open("GB") == False
}

// signings: minorSigningPathwayOpen — [neg] #15 A7 the minor signing pathway is closed in every jurisdiction, including unknown and prototype keys
pub fn neg_15_a7_the_minor_signing_pathway_is_closed_in_every_jurisdiction_incl_2_test() {
  assert signing_rules.minor_pathway_open("ENG") == False
}

// signings: minorSigningPathwayOpen — [neg] #15 A7 the minor signing pathway is closed in every jurisdiction, including unknown and prototype keys
pub fn neg_15_a7_the_minor_signing_pathway_is_closed_in_every_jurisdiction_incl_3_test() {
  assert signing_rules.minor_pathway_open("INT") == False
}

// signings: minorSigningPathwayOpen — [neg] #15 A7 the minor signing pathway is closed in every jurisdiction, including unknown and prototype keys
pub fn neg_15_a7_the_minor_signing_pathway_is_closed_in_every_jurisdiction_incl_4_test() {
  assert signing_rules.minor_pathway_open("USA") == False
}

// signings: minorSigningPathwayOpen — [neg] #15 A7 the minor signing pathway is closed in every jurisdiction, including unknown and prototype keys
pub fn neg_15_a7_the_minor_signing_pathway_is_closed_in_every_jurisdiction_incl_5_test() {
  assert signing_rules.minor_pathway_open("FR") == False
}

// signings: minorSigningPathwayOpen — [neg] #15 A7 the minor signing pathway is closed in every jurisdiction, including unknown and prototype keys
pub fn neg_15_a7_the_minor_signing_pathway_is_closed_in_every_jurisdiction_incl_6_test() {
  assert signing_rules.minor_pathway_open("KR") == False
}

// signings: minorSigningPathwayOpen — [neg] #15 A7 the minor signing pathway is closed in every jurisdiction, including unknown and prototype keys
pub fn neg_15_a7_the_minor_signing_pathway_is_closed_in_every_jurisdiction_incl_7_test() {
  assert signing_rules.minor_pathway_open("ZZ") == False
}

// signings: minorSigningPathwayOpen — [neg] #15 A7 the minor signing pathway is closed in every jurisdiction, including unknown and prototype keys
pub fn neg_15_a7_the_minor_signing_pathway_is_closed_in_every_jurisdiction_incl_8_test() {
  assert signing_rules.minor_pathway_open("") == False
}

// signings: minorSigningPathwayOpen — [neg] #15 A7 the minor signing pathway is closed in every jurisdiction, including unknown and prototype keys
pub fn neg_15_a7_the_minor_signing_pathway_is_closed_in_every_jurisdiction_incl_9_test() {
  assert signing_rules.minor_pathway_open("__proto__") == False
}

// signings: minorSigningPathwayOpen — [neg] #15 A7 the minor signing pathway is closed in every jurisdiction, including unknown and prototype keys
pub fn neg_15_a7_the_minor_signing_pathway_is_closed_in_every_jurisdiction_incl_10_test() {
  assert signing_rules.minor_pathway_open("constructor") == False
}

// signings: validateContractDates — A12 contract days validate as DATE_ONLY
pub fn a12_contract_days_validate_as_date_only_test() {
  assert signing_rules.validate_contract_dates(
      Some("2027-07-01"),
      Some("2029-06-30"),
    )
    == Ok(signing_rules.Contract("2027-07-01", Some("2029-06-30")))
}

// signings: validateContractDates — [neg] #44 A13 an impossible day, an end before the start, an eleven-year contract, an instant, and no start are all refused
pub fn neg_44_a13_an_impossible_day_an_end_before_the_start_an_eleven_year_cont_test() {
  assert result.map_error(
      signing_rules.validate_contract_dates(Some("2027-02-30"), None),
      base.signing_refusal,
    )
    == Error(
      "{\"error\":\"SIGNING_CONTRACT_DATES_INVALID\",\"field\":\"contract.startDate\",\"problem\":\"not_a_date\",\"message\":\"The contract start must be a real calendar day (YYYY-MM-DD).\"}",
    )
}

// signings: validateContractDates — [neg] #44 A13 an impossible day, an end before the start, an eleven-year contract, an instant, and no start are all refused
pub fn neg_44_a13_an_impossible_day_an_end_before_the_start_an_eleven_year_cont_2_test() {
  assert result.map_error(
      signing_rules.validate_contract_dates(
        Some("2027-07-01"),
        Some("2027-06-30"),
      ),
      base.signing_refusal,
    )
    == Error(
      "{\"error\":\"SIGNING_CONTRACT_DATES_INVALID\",\"field\":\"contract.endDate\",\"problem\":\"invalid\",\"message\":\"The contract cannot end before it starts.\"}",
    )
}

// signings: validateContractDates — [neg] #44 A13 an impossible day, an end before the start, an eleven-year contract, an instant, and no start are all refused
pub fn neg_44_a13_an_impossible_day_an_end_before_the_start_an_eleven_year_cont_3_test() {
  assert result.map_error(
      signing_rules.validate_contract_dates(
        Some("2027-07-01"),
        Some("2040-07-01"),
      ),
      base.signing_refusal,
    )
    == Error(
      "{\"error\":\"SIGNING_CONTRACT_DATES_INVALID\",\"field\":\"contract.endDate\",\"problem\":\"invalid\",\"message\":\"A contract longer than 10 years cannot be recorded here.\"}",
    )
}

// signings: validateContractDates — [neg] #44 A13 an impossible day, an end before the start, an eleven-year contract, an instant, and no start are all refused
pub fn neg_44_a13_an_impossible_day_an_end_before_the_start_an_eleven_year_cont_4_test() {
  assert result.map_error(
      signing_rules.validate_contract_dates(None, None),
      base.signing_refusal,
    )
    == Error(
      "{\"error\":\"SIGNING_CONTRACT_DATES_INVALID\",\"field\":\"contract.startDate\",\"problem\":\"required\",\"message\":\"The contract start is required.\"}",
    )
}

// signings: validateExpiry — [neg] A14 expiry: ≥1 h, ≤90 d, an instant; absent → the default
pub fn neg_a14_expiry_1_h_90_d_an_instant_absent_the_default_test() {
  assert result.map_error(
      signing_rules.validate_expiry(
        Some(base.body("1773577800000")),
        1_773_576_000_000,
      ),
      base.signing_refusal,
    )
    == Error(
      "{\"error\":\"SIGNING_EXPIRY_INVALID\",\"field\":\"expiresAt\",\"problem\":\"too_small\",\"message\":\"A signing must stay open for at least one hour.\"}",
    )
}

// signings: validateExpiry — [neg] A14 expiry: ≥1 h, ≤90 d, an instant; absent → the default
pub fn neg_a14_expiry_1_h_90_d_an_instant_absent_the_default_2_test() {
  assert result.map_error(
      signing_rules.validate_expiry(
        Some(base.body("1781438400000")),
        1_773_576_000_000,
      ),
      base.signing_refusal,
    )
    == Error(
      "{\"error\":\"SIGNING_EXPIRY_INVALID\",\"field\":\"expiresAt\",\"problem\":\"too_large\",\"message\":\"A signing cannot stay open for more than 90 days.\"}",
    )
}

// signings: validateExpiry — [neg] A14 expiry: ≥1 h, ≤90 d, an instant; absent → the default
pub fn neg_a14_expiry_1_h_90_d_an_instant_absent_the_default_3_test() {
  assert result.map_error(
      signing_rules.validate_expiry(
        Some(base.body("\"tomorrow\"")),
        1_773_576_000_000,
      ),
      base.signing_refusal,
    )
    == Error(
      "{\"error\":\"SIGNING_EXPIRY_INVALID\",\"field\":\"expiresAt\",\"problem\":\"not_a_timestamp\",\"message\":\"The expiry must be an ISO 8601 instant with an offset or a millisecond timestamp.\",\"expected\":\"instant\"}",
    )
}

// signings: validateExpiry — [neg] A14 expiry: ≥1 h, ≤90 d, an instant; absent → the default
pub fn neg_a14_expiry_1_h_90_d_an_instant_absent_the_default_4_test() {
  assert signing_rules.validate_expiry(
      Some(base.body("1773583200000")),
      1_773_576_000_000,
    )
    == Ok(#(1_773_583_200_000, False))
}

// signings: requiredPartiesFor — A15 required parties for an adult: the player and the club signatory, both pending
pub fn a15_required_parties_for_an_adult_the_player_and_the_club_signatory_both_test() {
  assert signing_rules.required_parties_for(None, id.player("p1"), id.org("o1"))
    == [
      signing_rules.PartySpec(signing_party_type.Player, "p1", id.player("p1")),
      signing_rules.PartySpec(
        signing_party_type.ClubSignatory,
        "o1",
        id.player("p1"),
      ),
    ]
}

// signings: effectiveStatus — A16 lazy expiry: READY 1 ms before, EXPIRED at the instant, a COMPLETED package never expires
pub fn a16_lazy_expiry_ready_1_ms_before_expired_at_the_instant_a_completed_pac_test() {
  assert signing_rules.effective_status(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-1"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.Ready,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-1"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.Ready,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
            ],
          ),
        ],
      ),
      1_774_180_799_999,
    )
    == signing_rules.Ready
}

// signings: effectiveStatus — A16 lazy expiry: READY 1 ms before, EXPIRED at the instant, a COMPLETED package never expires
pub fn a16_lazy_expiry_ready_1_ms_before_expired_at_the_instant_a_completed_pac_2_test() {
  assert signing_rules.effective_status(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-1"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.Ready,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-1"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.Ready,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
            ],
          ),
        ],
      ),
      1_774_180_800_000,
    )
    == signing_rules.Expired
}

// signings: effectiveStatus — A16 lazy expiry: READY 1 ms before, EXPIRED at the instant, a COMPLETED package never expires
pub fn a16_lazy_expiry_ready_1_ms_before_expired_at_the_instant_a_completed_pac_3_test() {
  assert signing_rules.effective_status(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-1"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.Completed,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-1"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.Ready,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
            ],
          ),
        ],
      ),
      1_774_267_200_000,
    )
    == signing_rules.Completed
}

// signings: canStart — [neg] #1 A18 no package over a DRAFT Offer
pub fn neg_1_a18_no_package_over_a_draft_offer_test() {
  assert result.map_error(
      signing_rules.can_start(
        signing_rules.StartFacts(
          offer_status: Some(offer_status.Draft),
          offer_revision_status: Some(offer_status.Draft),
          case_status: Some(room_status.OfferAccepted),
          recipient: Some("player"),
          jurisdiction: "GB",
          existing: [],
        ),
        1_773_576_000_000,
      ),
      base.signing_refusal,
    )
    == Error(
      "{\"error\":\"SIGNING_OFFER_NOT_ACCEPTED\",\"message\":\"A signing can only be opened over an accepted Offer revision.\"}",
    )
}

// signings: canStart — [neg] #1 A18 no package over a ISSUED Offer
pub fn neg_1_a18_no_package_over_a_issued_offer_test() {
  assert result.map_error(
      signing_rules.can_start(
        signing_rules.StartFacts(
          offer_status: Some(offer_status.Issued),
          offer_revision_status: Some(offer_status.Issued),
          case_status: Some(room_status.OfferAccepted),
          recipient: Some("player"),
          jurisdiction: "GB",
          existing: [],
        ),
        1_773_576_000_000,
      ),
      base.signing_refusal,
    )
    == Error(
      "{\"error\":\"SIGNING_OFFER_NOT_ACCEPTED\",\"message\":\"A signing can only be opened over an accepted Offer revision.\"}",
    )
}

// signings: canStart — [neg] #1 A18 no package over a DECLINED Offer
pub fn neg_1_a18_no_package_over_a_declined_offer_test() {
  assert result.map_error(
      signing_rules.can_start(
        signing_rules.StartFacts(
          offer_status: Some(offer_status.Declined),
          offer_revision_status: Some(offer_status.Declined),
          case_status: Some(room_status.OfferAccepted),
          recipient: Some("player"),
          jurisdiction: "GB",
          existing: [],
        ),
        1_773_576_000_000,
      ),
      base.signing_refusal,
    )
    == Error(
      "{\"error\":\"SIGNING_OFFER_NOT_ACCEPTED\",\"message\":\"A signing can only be opened over an accepted Offer revision.\"}",
    )
}

// signings: canStart — [neg] #1 A18 no package over a WITHDRAWN Offer
pub fn neg_1_a18_no_package_over_a_withdrawn_offer_test() {
  assert result.map_error(
      signing_rules.can_start(
        signing_rules.StartFacts(
          offer_status: Some(offer_status.Withdrawn),
          offer_revision_status: Some(offer_status.Withdrawn),
          case_status: Some(room_status.OfferAccepted),
          recipient: Some("player"),
          jurisdiction: "GB",
          existing: [],
        ),
        1_773_576_000_000,
      ),
      base.signing_refusal,
    )
    == Error(
      "{\"error\":\"SIGNING_OFFER_NOT_ACCEPTED\",\"message\":\"A signing can only be opened over an accepted Offer revision.\"}",
    )
}

// signings: canStart — [neg] #1 A18 no package over a EXPIRED Offer
pub fn neg_1_a18_no_package_over_a_expired_offer_test() {
  assert result.map_error(
      signing_rules.can_start(
        signing_rules.StartFacts(
          offer_status: Some(offer_status.Expired),
          offer_revision_status: Some(offer_status.Expired),
          case_status: Some(room_status.OfferAccepted),
          recipient: Some("player"),
          jurisdiction: "GB",
          existing: [],
        ),
        1_773_576_000_000,
      ),
      base.signing_refusal,
    )
    == Error(
      "{\"error\":\"SIGNING_OFFER_NOT_ACCEPTED\",\"message\":\"A signing can only be opened over an accepted Offer revision.\"}",
    )
}

// signings: canStart — [neg] #1 A18 no package over a SUPERSEDED Offer
pub fn neg_1_a18_no_package_over_a_superseded_offer_test() {
  assert result.map_error(
      signing_rules.can_start(
        signing_rules.StartFacts(
          offer_status: Some(offer_status.Superseded),
          offer_revision_status: Some(offer_status.Superseded),
          case_status: Some(room_status.OfferAccepted),
          recipient: Some("player"),
          jurisdiction: "GB",
          existing: [],
        ),
        1_773_576_000_000,
      ),
      base.signing_refusal,
    )
    == Error(
      "{\"error\":\"SIGNING_OFFER_NOT_ACCEPTED\",\"message\":\"A signing can only be opened over an accepted Offer revision.\"}",
    )
}

// signings: canStart — [neg] A19 the case must be at offer_accepted
pub fn neg_a19_the_case_must_be_at_offer_accepted_test() {
  assert result.map_error(
      signing_rules.can_start(
        signing_rules.StartFacts(
          offer_status: Some(offer_status.Accepted),
          offer_revision_status: Some(offer_status.Accepted),
          case_status: Some(room_status.OfferMade),
          recipient: Some("player"),
          jurisdiction: "GB",
          existing: [],
        ),
        1_773_576_000_000,
      ),
      base.signing_refusal,
    )
    == Error(
      "{\"error\":\"SIGNING_LIFECYCLE_CONFLICT\",\"message\":\"The case is not at Offer accepted.\",\"current\":{\"status\":\"offer_made\"}}",
    )
}

// signings: canStart — [neg] #15 A20 a guardian-addressed Offer opens no package while the pathway is closed
pub fn neg_15_a20_a_guardian_addressed_offer_opens_no_package_while_the_pathway_test() {
  assert result.map_error(
      signing_rules.can_start(
        signing_rules.StartFacts(
          offer_status: Some(offer_status.Accepted),
          offer_revision_status: Some(offer_status.Accepted),
          case_status: Some(room_status.OfferAccepted),
          recipient: Some("guardian"),
          jurisdiction: "GB",
          existing: [],
        ),
        1_773_576_000_000,
      ),
      base.signing_refusal,
    )
    == Error(
      "{\"error\":\"SIGNING_PATHWAY_CLOSED\",\"message\":\"Signing for a player under the age of majority is not open in this jurisdiction.\"}",
    )
}

// signings: canStart — [neg] A21 one live package per Offer; a completed one blocks another
pub fn neg_a21_one_live_package_per_offer_a_completed_one_blocks_another_test() {
  assert result.map_error(
      signing_rules.can_start(
        signing_rules.StartFacts(
          offer_status: Some(offer_status.Accepted),
          offer_revision_status: Some(offer_status.Accepted),
          case_status: Some(room_status.OfferAccepted),
          recipient: Some("player"),
          jurisdiction: "GB",
          existing: [
            signing_rules.Package(
              ..base.signing_package(),
              row: signing_packages.Row(
                ..base.signing_package().row,
                id: id.signing_package("spk-1"),
                org_id: id.org("o1"),
                player_id: id.player("p1"),
                case_id: id.recruitment_case("c1"),
                offer_id: id.offer("rof-1"),
                offer_revision_id: "rofr-1",
                status: signing_packages.Ready,
                current_revision_id: id.signing_revision("spr-1"),
                created_at: 1_773_576_000_000,
                expires_at: Some(1_774_180_800_000),
              ),
              revisions: [
                signing_rules.Revision(
                  row: signing_revisions.Row(
                    ..signing_revisions.Row(
                      ..base.signing_revision(),
                      id: id.signing_revision("spr-1"),
                      package_id: id.signing_package("spk-1"),
                      position: 0,
                    ),
                    revision_number: 1,
                    status: signing_revisions.Ready,
                    created_at: 1_773_576_000_000,
                    ready_at: Some(1_773_579_600_000),
                    contract_start_date: Some("2027-07-01"),
                    contract_end_date: None,
                  ),
                  document: Some(
                    signing_documents.Row(
                      ..signing_documents.Row(
                        ..base.signing_document(),
                        revision_id: id.signing_revision("spr-1"),
                        kind: signing_documents.Signing,
                      ),
                      evidence_id: id.evidence("vevd-1"),
                      sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
                    ),
                  ),
                  executed: None,
                  parties: [
                    signing_revision_parties.Row(
                      ..signing_revision_parties.Row(
                        ..base.signing_party(),
                        revision_id: id.signing_revision("spr-1"),
                        position: 0,
                      ),
                      party_type: signing_party_type.Player,
                      for_entity_id: Some("p1"),
                      for_player_id: Some(id.player("p1")),
                      status: signing_revision_parties.Pending,
                      completed_at: None,
                      method: None,
                    ),
                    signing_revision_parties.Row(
                      ..signing_revision_parties.Row(
                        ..base.signing_party(),
                        revision_id: id.signing_revision("spr-1"),
                        position: 1,
                      ),
                      party_type: signing_party_type.ClubSignatory,
                      for_entity_id: Some("o1"),
                      for_player_id: Some(id.player("p1")),
                      status: signing_revision_parties.Pending,
                      completed_at: None,
                      method: None,
                    ),
                  ],
                ),
              ],
            ),
          ],
        ),
        1_773_576_000_000,
      ),
      base.signing_refusal,
    )
    == Error(
      "{\"error\":\"SIGNING_PACKAGE_EXISTS\",\"message\":\"A signing is already open for this Offer.\",\"current\":{\"signingPackageId\":\"spk-1\",\"status\":\"READY\"}}",
    )
}

// signings: canStart — [neg] A21 one live package per Offer; a completed one blocks another
pub fn neg_a21_one_live_package_per_offer_a_completed_one_blocks_another_2_test() {
  assert result.map_error(
      signing_rules.can_start(
        signing_rules.StartFacts(
          offer_status: Some(offer_status.Accepted),
          offer_revision_status: Some(offer_status.Accepted),
          case_status: Some(room_status.OfferAccepted),
          recipient: Some("player"),
          jurisdiction: "GB",
          existing: [
            signing_rules.Package(
              ..base.signing_package(),
              row: signing_packages.Row(
                ..signing_packages.Row(
                  ..base.signing_package().row,
                  id: id.signing_package("spk-1"),
                  org_id: id.org("o1"),
                  player_id: id.player("p1"),
                  case_id: id.recruitment_case("c1"),
                  offer_id: id.offer("rof-1"),
                  offer_revision_id: "rofr-1",
                  status: signing_packages.Completed,
                  current_revision_id: id.signing_revision("spr-1"),
                  created_at: 1_773_576_000_000,
                  expires_at: Some(1_774_180_800_000),
                ),
                completion_signing_id: Some(id.signing("s")),
                completion_completed_at: Some(1_773_576_000_000),
              ),
              revisions: [
                signing_rules.Revision(
                  row: signing_revisions.Row(
                    ..signing_revisions.Row(
                      ..base.signing_revision(),
                      id: id.signing_revision("spr-1"),
                      package_id: id.signing_package("spk-1"),
                      position: 0,
                    ),
                    revision_number: 1,
                    status: signing_revisions.Ready,
                    created_at: 1_773_576_000_000,
                    ready_at: Some(1_773_579_600_000),
                    contract_start_date: Some("2027-07-01"),
                    contract_end_date: None,
                  ),
                  document: Some(
                    signing_documents.Row(
                      ..signing_documents.Row(
                        ..base.signing_document(),
                        revision_id: id.signing_revision("spr-1"),
                        kind: signing_documents.Signing,
                      ),
                      evidence_id: id.evidence("vevd-1"),
                      sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
                    ),
                  ),
                  executed: None,
                  parties: [
                    signing_revision_parties.Row(
                      ..signing_revision_parties.Row(
                        ..base.signing_party(),
                        revision_id: id.signing_revision("spr-1"),
                        position: 0,
                      ),
                      party_type: signing_party_type.Player,
                      for_entity_id: Some("p1"),
                      for_player_id: Some(id.player("p1")),
                      status: signing_revision_parties.Pending,
                      completed_at: None,
                      method: None,
                    ),
                    signing_revision_parties.Row(
                      ..signing_revision_parties.Row(
                        ..base.signing_party(),
                        revision_id: id.signing_revision("spr-1"),
                        position: 1,
                      ),
                      party_type: signing_party_type.ClubSignatory,
                      for_entity_id: Some("o1"),
                      for_player_id: Some(id.player("p1")),
                      status: signing_revision_parties.Pending,
                      completed_at: None,
                      method: None,
                    ),
                  ],
                ),
              ],
            ),
          ],
        ),
        1_773_576_000_000,
      ),
      base.signing_refusal,
    )
    == Error(
      "{\"error\":\"SIGNING_ALREADY_COMPLETED\",\"message\":\"A completed signing already exists for this Offer.\",\"current\":{\"signingPackageId\":\"spk-1\"}}",
    )
}

// signings: canCompleteParty — [neg] #10 A22 an org actor cannot complete the PLAYER party (the pure gate)
pub fn neg_10_a22_an_org_actor_cannot_complete_the_player_party_the_pure_gate_test() {
  assert result.map_error(
      signing_rules.can_complete_party(
        signing_rules.Package(
          ..base.signing_package(),
          row: signing_packages.Row(
            ..base.signing_package().row,
            id: id.signing_package("spk-1"),
            org_id: id.org("o1"),
            player_id: id.player("p1"),
            case_id: id.recruitment_case("c1"),
            offer_id: id.offer("rof-1"),
            offer_revision_id: "rofr-1",
            status: signing_packages.Ready,
            current_revision_id: id.signing_revision("spr-1"),
            created_at: 1_773_576_000_000,
            expires_at: Some(1_774_180_800_000),
          ),
          revisions: [
            signing_rules.Revision(
              row: signing_revisions.Row(
                ..signing_revisions.Row(
                  ..base.signing_revision(),
                  id: id.signing_revision("spr-1"),
                  package_id: id.signing_package("spk-1"),
                  position: 0,
                ),
                revision_number: 1,
                status: signing_revisions.Ready,
                created_at: 1_773_576_000_000,
                ready_at: Some(1_773_579_600_000),
                contract_start_date: Some("2027-07-01"),
                contract_end_date: None,
              ),
              document: Some(
                signing_documents.Row(
                  ..signing_documents.Row(
                    ..base.signing_document(),
                    revision_id: id.signing_revision("spr-1"),
                    kind: signing_documents.Signing,
                  ),
                  evidence_id: id.evidence("vevd-1"),
                  sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
                ),
              ),
              executed: None,
              parties: [
                signing_revision_parties.Row(
                  ..signing_revision_parties.Row(
                    ..base.signing_party(),
                    revision_id: id.signing_revision("spr-1"),
                    position: 0,
                  ),
                  party_type: signing_party_type.Player,
                  for_entity_id: Some("p1"),
                  for_player_id: Some(id.player("p1")),
                  status: signing_revision_parties.Pending,
                  completed_at: None,
                  method: None,
                ),
                signing_revision_parties.Row(
                  ..signing_revision_parties.Row(
                    ..base.signing_party(),
                    revision_id: id.signing_revision("spr-1"),
                    position: 1,
                  ),
                  party_type: signing_party_type.ClubSignatory,
                  for_entity_id: Some("o1"),
                  for_player_id: Some(id.player("p1")),
                  status: signing_revision_parties.Pending,
                  completed_at: None,
                  method: None,
                ),
              ],
            ),
          ],
        ),
        signing_party_type.Player,
        recruitment_actor_kind.Org,
        "p1",
        "spr-1",
        "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
        1_773_576_000_000,
      ),
      base.signing_refusal,
    )
    == Error(
      "{\"error\":\"SIGNING_NOT_PERMITTED\",\"message\":\"You cannot sign for that party.\"}",
    )
}

// signings: canCompleteParty — [neg] A23 a player cannot complete the club signatory
pub fn neg_a23_a_player_cannot_complete_the_club_signatory_test() {
  assert result.map_error(
      signing_rules.can_complete_party(
        signing_rules.Package(
          ..base.signing_package(),
          row: signing_packages.Row(
            ..base.signing_package().row,
            id: id.signing_package("spk-1"),
            org_id: id.org("o1"),
            player_id: id.player("p1"),
            case_id: id.recruitment_case("c1"),
            offer_id: id.offer("rof-1"),
            offer_revision_id: "rofr-1",
            status: signing_packages.Ready,
            current_revision_id: id.signing_revision("spr-1"),
            created_at: 1_773_576_000_000,
            expires_at: Some(1_774_180_800_000),
          ),
          revisions: [
            signing_rules.Revision(
              row: signing_revisions.Row(
                ..signing_revisions.Row(
                  ..base.signing_revision(),
                  id: id.signing_revision("spr-1"),
                  package_id: id.signing_package("spk-1"),
                  position: 0,
                ),
                revision_number: 1,
                status: signing_revisions.Ready,
                created_at: 1_773_576_000_000,
                ready_at: Some(1_773_579_600_000),
                contract_start_date: Some("2027-07-01"),
                contract_end_date: None,
              ),
              document: Some(
                signing_documents.Row(
                  ..signing_documents.Row(
                    ..base.signing_document(),
                    revision_id: id.signing_revision("spr-1"),
                    kind: signing_documents.Signing,
                  ),
                  evidence_id: id.evidence("vevd-1"),
                  sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
                ),
              ),
              executed: None,
              parties: [
                signing_revision_parties.Row(
                  ..signing_revision_parties.Row(
                    ..base.signing_party(),
                    revision_id: id.signing_revision("spr-1"),
                    position: 0,
                  ),
                  party_type: signing_party_type.Player,
                  for_entity_id: Some("p1"),
                  for_player_id: Some(id.player("p1")),
                  status: signing_revision_parties.Pending,
                  completed_at: None,
                  method: None,
                ),
                signing_revision_parties.Row(
                  ..signing_revision_parties.Row(
                    ..base.signing_party(),
                    revision_id: id.signing_revision("spr-1"),
                    position: 1,
                  ),
                  party_type: signing_party_type.ClubSignatory,
                  for_entity_id: Some("o1"),
                  for_player_id: Some(id.player("p1")),
                  status: signing_revision_parties.Pending,
                  completed_at: None,
                  method: None,
                ),
              ],
            ),
          ],
        ),
        signing_party_type.ClubSignatory,
        recruitment_actor_kind.Player,
        "p1",
        "spr-1",
        "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
        1_773_576_000_000,
      ),
      base.signing_refusal,
    )
    == Error(
      "{\"error\":\"SIGNING_NOT_PERMITTED\",\"message\":\"You cannot sign for that party.\"}",
    )
}

// signings: canCompleteParty — [neg] #9 A24 another player is not a required party
pub fn neg_9_a24_another_player_is_not_a_required_party_test() {
  assert result.map_error(
      signing_rules.can_complete_party(
        signing_rules.Package(
          ..base.signing_package(),
          row: signing_packages.Row(
            ..base.signing_package().row,
            id: id.signing_package("spk-1"),
            org_id: id.org("o1"),
            player_id: id.player("p1"),
            case_id: id.recruitment_case("c1"),
            offer_id: id.offer("rof-1"),
            offer_revision_id: "rofr-1",
            status: signing_packages.Ready,
            current_revision_id: id.signing_revision("spr-1"),
            created_at: 1_773_576_000_000,
            expires_at: Some(1_774_180_800_000),
          ),
          revisions: [
            signing_rules.Revision(
              row: signing_revisions.Row(
                ..signing_revisions.Row(
                  ..base.signing_revision(),
                  id: id.signing_revision("spr-1"),
                  package_id: id.signing_package("spk-1"),
                  position: 0,
                ),
                revision_number: 1,
                status: signing_revisions.Ready,
                created_at: 1_773_576_000_000,
                ready_at: Some(1_773_579_600_000),
                contract_start_date: Some("2027-07-01"),
                contract_end_date: None,
              ),
              document: Some(
                signing_documents.Row(
                  ..signing_documents.Row(
                    ..base.signing_document(),
                    revision_id: id.signing_revision("spr-1"),
                    kind: signing_documents.Signing,
                  ),
                  evidence_id: id.evidence("vevd-1"),
                  sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
                ),
              ),
              executed: None,
              parties: [
                signing_revision_parties.Row(
                  ..signing_revision_parties.Row(
                    ..base.signing_party(),
                    revision_id: id.signing_revision("spr-1"),
                    position: 0,
                  ),
                  party_type: signing_party_type.Player,
                  for_entity_id: Some("p1"),
                  for_player_id: Some(id.player("p1")),
                  status: signing_revision_parties.Pending,
                  completed_at: None,
                  method: None,
                ),
                signing_revision_parties.Row(
                  ..signing_revision_parties.Row(
                    ..base.signing_party(),
                    revision_id: id.signing_revision("spr-1"),
                    position: 1,
                  ),
                  party_type: signing_party_type.ClubSignatory,
                  for_entity_id: Some("o1"),
                  for_player_id: Some(id.player("p1")),
                  status: signing_revision_parties.Pending,
                  completed_at: None,
                  method: None,
                ),
              ],
            ),
          ],
        ),
        signing_party_type.Player,
        recruitment_actor_kind.Player,
        "p2",
        "spr-1",
        "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
        1_773_576_000_000,
      ),
      base.signing_refusal,
    )
    == Error(
      "{\"error\":\"SIGNING_PARTY_NOT_REQUIRED\",\"message\":\"This signing does not require your signature.\"}",
    )
}

// signings: canCompleteParty — [neg] A25 confirming a different digest than the presented revision is a mismatch
pub fn neg_a25_confirming_a_different_digest_than_the_presented_revision_is_a_m_test() {
  assert result.map_error(
      signing_rules.can_complete_party(
        signing_rules.Package(
          ..base.signing_package(),
          row: signing_packages.Row(
            ..base.signing_package().row,
            id: id.signing_package("spk-1"),
            org_id: id.org("o1"),
            player_id: id.player("p1"),
            case_id: id.recruitment_case("c1"),
            offer_id: id.offer("rof-1"),
            offer_revision_id: "rofr-1",
            status: signing_packages.Ready,
            current_revision_id: id.signing_revision("spr-1"),
            created_at: 1_773_576_000_000,
            expires_at: Some(1_774_180_800_000),
          ),
          revisions: [
            signing_rules.Revision(
              row: signing_revisions.Row(
                ..signing_revisions.Row(
                  ..base.signing_revision(),
                  id: id.signing_revision("spr-1"),
                  package_id: id.signing_package("spk-1"),
                  position: 0,
                ),
                revision_number: 1,
                status: signing_revisions.Ready,
                created_at: 1_773_576_000_000,
                ready_at: Some(1_773_579_600_000),
                contract_start_date: Some("2027-07-01"),
                contract_end_date: None,
              ),
              document: Some(
                signing_documents.Row(
                  ..signing_documents.Row(
                    ..base.signing_document(),
                    revision_id: id.signing_revision("spr-1"),
                    kind: signing_documents.Signing,
                  ),
                  evidence_id: id.evidence("vevd-1"),
                  sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
                ),
              ),
              executed: None,
              parties: [
                signing_revision_parties.Row(
                  ..signing_revision_parties.Row(
                    ..base.signing_party(),
                    revision_id: id.signing_revision("spr-1"),
                    position: 0,
                  ),
                  party_type: signing_party_type.Player,
                  for_entity_id: Some("p1"),
                  for_player_id: Some(id.player("p1")),
                  status: signing_revision_parties.Pending,
                  completed_at: None,
                  method: None,
                ),
                signing_revision_parties.Row(
                  ..signing_revision_parties.Row(
                    ..base.signing_party(),
                    revision_id: id.signing_revision("spr-1"),
                    position: 1,
                  ),
                  party_type: signing_party_type.ClubSignatory,
                  for_entity_id: Some("o1"),
                  for_player_id: Some(id.player("p1")),
                  status: signing_revision_parties.Pending,
                  completed_at: None,
                  method: None,
                ),
              ],
            ),
          ],
        ),
        signing_party_type.Player,
        recruitment_actor_kind.Player,
        "p1",
        "spr-1",
        "c3d4f54b9e362b92b89b77a7caa082aeb63c43d46a0cf44afd390df561eddec5",
        1_773_576_000_000,
      ),
      base.signing_refusal,
    )
    == Error(
      "{\"error\":\"SIGNING_DOCUMENT_MISMATCH\",\"message\":\"Confirm the exact document you read: its digest does not match the revision presented.\"}",
    )
}

// signings: canCompleteParty — [neg] #18 A26 a signature against a superseded revision is refused
pub fn neg_18_a26_a_signature_against_a_superseded_revision_is_refused_test() {
  assert result.map_error(
      signing_rules.can_complete_party(
        signing_rules.Package(
          ..base.signing_package(),
          row: signing_packages.Row(
            ..base.signing_package().row,
            id: id.signing_package("spk-1"),
            org_id: id.org("o1"),
            player_id: id.player("p1"),
            case_id: id.recruitment_case("c1"),
            offer_id: id.offer("rof-1"),
            offer_revision_id: "rofr-1",
            status: signing_packages.Ready,
            current_revision_id: id.signing_revision("spr-2"),
            created_at: 1_773_576_000_000,
            expires_at: Some(1_774_180_800_000),
          ),
          revisions: [
            signing_rules.Revision(
              row: signing_revisions.Row(
                ..signing_revisions.Row(
                  ..base.signing_revision(),
                  id: id.signing_revision("spr-1"),
                  package_id: id.signing_package("spk-1"),
                  position: 0,
                ),
                revision_number: 1,
                status: signing_revisions.Superseded,
                created_at: 1_773_576_000_000,
                ready_at: Some(1_773_579_600_000),
                contract_start_date: Some("2027-07-01"),
                contract_end_date: None,
              ),
              document: Some(
                signing_documents.Row(
                  ..signing_documents.Row(
                    ..base.signing_document(),
                    revision_id: id.signing_revision("spr-1"),
                    kind: signing_documents.Signing,
                  ),
                  evidence_id: id.evidence("vevd-1"),
                  sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
                ),
              ),
              executed: None,
              parties: [
                signing_revision_parties.Row(
                  ..signing_revision_parties.Row(
                    ..base.signing_party(),
                    revision_id: id.signing_revision("spr-1"),
                    position: 0,
                  ),
                  party_type: signing_party_type.Player,
                  for_entity_id: Some("p1"),
                  for_player_id: Some(id.player("p1")),
                  status: signing_revision_parties.Pending,
                  completed_at: None,
                  method: None,
                ),
                signing_revision_parties.Row(
                  ..signing_revision_parties.Row(
                    ..base.signing_party(),
                    revision_id: id.signing_revision("spr-1"),
                    position: 1,
                  ),
                  party_type: signing_party_type.ClubSignatory,
                  for_entity_id: Some("o1"),
                  for_player_id: Some(id.player("p1")),
                  status: signing_revision_parties.Pending,
                  completed_at: None,
                  method: None,
                ),
              ],
            ),
            signing_rules.Revision(
              row: signing_revisions.Row(
                ..signing_revisions.Row(
                  ..base.signing_revision(),
                  id: id.signing_revision("spr-2"),
                  package_id: id.signing_package("spk-1"),
                  position: 1,
                ),
                revision_number: 2,
                status: signing_revisions.Ready,
                created_at: 1_773_576_000_000,
                ready_at: Some(1_773_579_600_000),
                contract_start_date: Some("2027-07-01"),
                contract_end_date: None,
              ),
              document: Some(
                signing_documents.Row(
                  ..signing_documents.Row(
                    ..base.signing_document(),
                    revision_id: id.signing_revision("spr-2"),
                    kind: signing_documents.Signing,
                  ),
                  evidence_id: id.evidence("vevd-1"),
                  sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
                ),
              ),
              executed: None,
              parties: [
                signing_revision_parties.Row(
                  ..signing_revision_parties.Row(
                    ..base.signing_party(),
                    revision_id: id.signing_revision("spr-2"),
                    position: 0,
                  ),
                  party_type: signing_party_type.Player,
                  for_entity_id: Some("p1"),
                  for_player_id: Some(id.player("p1")),
                  status: signing_revision_parties.Pending,
                  completed_at: None,
                  method: None,
                ),
                signing_revision_parties.Row(
                  ..signing_revision_parties.Row(
                    ..base.signing_party(),
                    revision_id: id.signing_revision("spr-2"),
                    position: 1,
                  ),
                  party_type: signing_party_type.ClubSignatory,
                  for_entity_id: Some("o1"),
                  for_player_id: Some(id.player("p1")),
                  status: signing_revision_parties.Pending,
                  completed_at: None,
                  method: None,
                ),
              ],
            ),
          ],
        ),
        signing_party_type.Player,
        recruitment_actor_kind.Player,
        "p1",
        "spr-1",
        "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
        1_773_576_000_000,
      ),
      base.signing_refusal,
    )
    == Error(
      "{\"error\":\"SIGNING_SUPERSEDED\",\"message\":\"That signing revision was replaced. Sign the current revision once it is presented.\",\"current\":{\"revisionId\":\"spr-2\"}}",
    )
}

// signings: canCompleteParty — [neg] A27 no party completes an expired package
pub fn neg_a27_no_party_completes_an_expired_package_test() {
  assert result.map_error(
      signing_rules.can_complete_party(
        signing_rules.Package(
          ..base.signing_package(),
          row: signing_packages.Row(
            ..base.signing_package().row,
            id: id.signing_package("spk-1"),
            org_id: id.org("o1"),
            player_id: id.player("p1"),
            case_id: id.recruitment_case("c1"),
            offer_id: id.offer("rof-1"),
            offer_revision_id: "rofr-1",
            status: signing_packages.Ready,
            current_revision_id: id.signing_revision("spr-1"),
            created_at: 1_773_576_000_000,
            expires_at: Some(1_774_180_800_000),
          ),
          revisions: [
            signing_rules.Revision(
              row: signing_revisions.Row(
                ..signing_revisions.Row(
                  ..base.signing_revision(),
                  id: id.signing_revision("spr-1"),
                  package_id: id.signing_package("spk-1"),
                  position: 0,
                ),
                revision_number: 1,
                status: signing_revisions.Ready,
                created_at: 1_773_576_000_000,
                ready_at: Some(1_773_579_600_000),
                contract_start_date: Some("2027-07-01"),
                contract_end_date: None,
              ),
              document: Some(
                signing_documents.Row(
                  ..signing_documents.Row(
                    ..base.signing_document(),
                    revision_id: id.signing_revision("spr-1"),
                    kind: signing_documents.Signing,
                  ),
                  evidence_id: id.evidence("vevd-1"),
                  sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
                ),
              ),
              executed: None,
              parties: [
                signing_revision_parties.Row(
                  ..signing_revision_parties.Row(
                    ..base.signing_party(),
                    revision_id: id.signing_revision("spr-1"),
                    position: 0,
                  ),
                  party_type: signing_party_type.Player,
                  for_entity_id: Some("p1"),
                  for_player_id: Some(id.player("p1")),
                  status: signing_revision_parties.Pending,
                  completed_at: None,
                  method: None,
                ),
                signing_revision_parties.Row(
                  ..signing_revision_parties.Row(
                    ..base.signing_party(),
                    revision_id: id.signing_revision("spr-1"),
                    position: 1,
                  ),
                  party_type: signing_party_type.ClubSignatory,
                  for_entity_id: Some("o1"),
                  for_player_id: Some(id.player("p1")),
                  status: signing_revision_parties.Pending,
                  completed_at: None,
                  method: None,
                ),
              ],
            ),
          ],
        ),
        signing_party_type.Player,
        recruitment_actor_kind.Player,
        "p1",
        "spr-1",
        "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
        1_774_267_200_000,
      ),
      base.signing_refusal,
    )
    == Error(
      "{\"error\":\"SIGNING_EXPIRED\",\"message\":\"This signing is Expired — not completed in time.\",\"current\":{\"status\":\"EXPIRED\"}}",
    )
}

// signings: completionGate — [neg] #16 #26 A28 a package with no party complete cannot complete
pub fn neg_16_26_a28_a_package_with_no_party_complete_cannot_complete_test() {
  assert signing_rules.completion_gate(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-1"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.Ready,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-1"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.Ready,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
            ],
          ),
        ],
      ),
      signing_rules.GateFacts(
        now: 1_773_583_200_000,
        offer: Some(signing_rules.GateOffer(
          id: id.offer("rof-1"),
          status: Some(offer_status.Accepted),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
        )),
        offer_revision: Some(signing_rules.GateRevision(
          id: id.offer_revision("rofr-1"),
          status: offer_status.Accepted,
        )),
        kase: Some(base.kase(
          id.recruitment_case("c1"),
          id.org("o1"),
          id.player("p1"),
          room_status.OfferAccepted,
        )),
        other_completed: False,
        blocked: False,
        document_problem: None,
      ),
    )
    == ["PARTIES_INCOMPLETE"]
}

// signings: completionGate — A29 every party complete against the exact digest: the gate is empty
pub fn a29_every_party_complete_against_the_exact_digest_the_gate_is_empty_test() {
  assert signing_rules.completion_gate(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-1"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.InProgress,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-1"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.InProgress,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Completed,
                completed_at: Some(1_773_581_400_000),
                completed_by_kind: Some(recruitment_actor_kind.Player),
                completed_by_id: Some("x"),
                completed_by_name: None,
                evidence_ref_kind: Some(
                  signing_revision_parties.PlatformAcknowledgment,
                ),
                evidence_ref_id: Some("sgev-x"),
                evidence_revision_id: Some(id.signing_revision("spr-1")),
                evidence_document_sha256: Some(
                  "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
                ),
                evidence_at: Some(1_773_581_400_000),
                evidence_actor_kind: Some("player"),
                evidence_actor_id: Some("x"),
                evidence_session: Some("authenticated"),
                method: Some(signing_method.PlatformAcknowledgment),
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Completed,
                completed_at: Some(1_773_581_400_000),
                completed_by_kind: Some(recruitment_actor_kind.Org),
                completed_by_id: Some("x"),
                completed_by_name: None,
                evidence_ref_kind: Some(
                  signing_revision_parties.PlatformAcknowledgment,
                ),
                evidence_ref_id: Some("sgev-x"),
                evidence_revision_id: Some(id.signing_revision("spr-1")),
                evidence_document_sha256: Some(
                  "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
                ),
                evidence_at: Some(1_773_581_400_000),
                evidence_actor_kind: Some("org"),
                evidence_actor_id: Some("x"),
                evidence_session: Some("authenticated"),
                method: Some(signing_method.PlatformAcknowledgment),
              ),
            ],
          ),
        ],
      ),
      signing_rules.GateFacts(
        now: 1_773_583_200_000,
        offer: Some(signing_rules.GateOffer(
          id: id.offer("rof-1"),
          status: Some(offer_status.Accepted),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
        )),
        offer_revision: Some(signing_rules.GateRevision(
          id: id.offer_revision("rofr-1"),
          status: offer_status.Accepted,
        )),
        kase: Some(base.kase(
          id.recruitment_case("c1"),
          id.org("o1"),
          id.player("p1"),
          room_status.OfferAccepted,
        )),
        other_completed: False,
        blocked: False,
        document_problem: None,
      ),
    )
    == []
}

// signings: completionGate — [neg] A30 a block, a conflicting completed signing, a paused case and a player mismatch each close the gate
pub fn neg_a30_a_block_a_conflicting_completed_signing_a_paused_case_and_a_play_test() {
  assert signing_rules.completion_gate(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-1"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.InProgress,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-1"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.InProgress,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Completed,
                completed_at: Some(1_773_581_400_000),
                completed_by_kind: Some(recruitment_actor_kind.Player),
                completed_by_id: Some("x"),
                completed_by_name: None,
                evidence_ref_kind: Some(
                  signing_revision_parties.PlatformAcknowledgment,
                ),
                evidence_ref_id: Some("sgev-x"),
                evidence_revision_id: Some(id.signing_revision("spr-1")),
                evidence_document_sha256: Some(
                  "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
                ),
                evidence_at: Some(1_773_581_400_000),
                evidence_actor_kind: Some("player"),
                evidence_actor_id: Some("x"),
                evidence_session: Some("authenticated"),
                method: Some(signing_method.PlatformAcknowledgment),
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Completed,
                completed_at: Some(1_773_581_400_000),
                completed_by_kind: Some(recruitment_actor_kind.Org),
                completed_by_id: Some("x"),
                completed_by_name: None,
                evidence_ref_kind: Some(
                  signing_revision_parties.PlatformAcknowledgment,
                ),
                evidence_ref_id: Some("sgev-x"),
                evidence_revision_id: Some(id.signing_revision("spr-1")),
                evidence_document_sha256: Some(
                  "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
                ),
                evidence_at: Some(1_773_581_400_000),
                evidence_actor_kind: Some("org"),
                evidence_actor_id: Some("x"),
                evidence_session: Some("authenticated"),
                method: Some(signing_method.PlatformAcknowledgment),
              ),
            ],
          ),
        ],
      ),
      signing_rules.GateFacts(
        now: 1_773_583_200_000,
        offer: Some(signing_rules.GateOffer(
          id: id.offer("rof-1"),
          status: Some(offer_status.Accepted),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
        )),
        offer_revision: Some(signing_rules.GateRevision(
          id: id.offer_revision("rofr-1"),
          status: offer_status.Accepted,
        )),
        kase: Some(base.kase(
          id.recruitment_case("c1"),
          id.org("o1"),
          id.player("p1"),
          room_status.OfferAccepted,
        )),
        other_completed: False,
        blocked: True,
        document_problem: None,
      ),
    )
    == ["BLOCKED"]
}

// signings: completionGate — [neg] A30 a block, a conflicting completed signing, a paused case and a player mismatch each close the gate
pub fn neg_a30_a_block_a_conflicting_completed_signing_a_paused_case_and_a_play_2_test() {
  assert signing_rules.completion_gate(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-1"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.InProgress,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-1"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.InProgress,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Completed,
                completed_at: Some(1_773_581_400_000),
                completed_by_kind: Some(recruitment_actor_kind.Player),
                completed_by_id: Some("x"),
                completed_by_name: None,
                evidence_ref_kind: Some(
                  signing_revision_parties.PlatformAcknowledgment,
                ),
                evidence_ref_id: Some("sgev-x"),
                evidence_revision_id: Some(id.signing_revision("spr-1")),
                evidence_document_sha256: Some(
                  "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
                ),
                evidence_at: Some(1_773_581_400_000),
                evidence_actor_kind: Some("player"),
                evidence_actor_id: Some("x"),
                evidence_session: Some("authenticated"),
                method: Some(signing_method.PlatformAcknowledgment),
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Completed,
                completed_at: Some(1_773_581_400_000),
                completed_by_kind: Some(recruitment_actor_kind.Org),
                completed_by_id: Some("x"),
                completed_by_name: None,
                evidence_ref_kind: Some(
                  signing_revision_parties.PlatformAcknowledgment,
                ),
                evidence_ref_id: Some("sgev-x"),
                evidence_revision_id: Some(id.signing_revision("spr-1")),
                evidence_document_sha256: Some(
                  "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
                ),
                evidence_at: Some(1_773_581_400_000),
                evidence_actor_kind: Some("org"),
                evidence_actor_id: Some("x"),
                evidence_session: Some("authenticated"),
                method: Some(signing_method.PlatformAcknowledgment),
              ),
            ],
          ),
        ],
      ),
      signing_rules.GateFacts(
        now: 1_773_583_200_000,
        offer: Some(signing_rules.GateOffer(
          id: id.offer("rof-1"),
          status: Some(offer_status.Accepted),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
        )),
        offer_revision: Some(signing_rules.GateRevision(
          id: id.offer_revision("rofr-1"),
          status: offer_status.Accepted,
        )),
        kase: Some(base.kase(
          id.recruitment_case("c1"),
          id.org("o1"),
          id.player("p1"),
          room_status.OfferAccepted,
        )),
        other_completed: True,
        blocked: False,
        document_problem: None,
      ),
    )
    == ["CONFLICTING_COMPLETED_SIGNING"]
}

// signings: completionGate — [neg] A30 a block, a conflicting completed signing, a paused case and a player mismatch each close the gate
pub fn neg_a30_a_block_a_conflicting_completed_signing_a_paused_case_and_a_play_3_test() {
  assert signing_rules.completion_gate(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-1"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.InProgress,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-1"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.InProgress,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Completed,
                completed_at: Some(1_773_581_400_000),
                completed_by_kind: Some(recruitment_actor_kind.Player),
                completed_by_id: Some("x"),
                completed_by_name: None,
                evidence_ref_kind: Some(
                  signing_revision_parties.PlatformAcknowledgment,
                ),
                evidence_ref_id: Some("sgev-x"),
                evidence_revision_id: Some(id.signing_revision("spr-1")),
                evidence_document_sha256: Some(
                  "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
                ),
                evidence_at: Some(1_773_581_400_000),
                evidence_actor_kind: Some("player"),
                evidence_actor_id: Some("x"),
                evidence_session: Some("authenticated"),
                method: Some(signing_method.PlatformAcknowledgment),
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Completed,
                completed_at: Some(1_773_581_400_000),
                completed_by_kind: Some(recruitment_actor_kind.Org),
                completed_by_id: Some("x"),
                completed_by_name: None,
                evidence_ref_kind: Some(
                  signing_revision_parties.PlatformAcknowledgment,
                ),
                evidence_ref_id: Some("sgev-x"),
                evidence_revision_id: Some(id.signing_revision("spr-1")),
                evidence_document_sha256: Some(
                  "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
                ),
                evidence_at: Some(1_773_581_400_000),
                evidence_actor_kind: Some("org"),
                evidence_actor_id: Some("x"),
                evidence_session: Some("authenticated"),
                method: Some(signing_method.PlatformAcknowledgment),
              ),
            ],
          ),
        ],
      ),
      signing_rules.GateFacts(
        now: 1_773_583_200_000,
        offer: Some(signing_rules.GateOffer(
          id: id.offer("rof-1"),
          status: Some(offer_status.Accepted),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
        )),
        offer_revision: Some(signing_rules.GateRevision(
          id: id.offer_revision("rofr-1"),
          status: offer_status.Accepted,
        )),
        kase: Some(base.kase(
          id.recruitment_case("c1"),
          id.org("o1"),
          id.player("p1"),
          room_status.OnHold,
        )),
        other_completed: False,
        blocked: False,
        document_problem: None,
      ),
    )
    == ["LIFECYCLE_CONFLICT"]
}

// signings: completionGate — [neg] A30 a block, a conflicting completed signing, a paused case and a player mismatch each close the gate
pub fn neg_a30_a_block_a_conflicting_completed_signing_a_paused_case_and_a_play_4_test() {
  assert signing_rules.completion_gate(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-1"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.InProgress,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-1"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.InProgress,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Completed,
                completed_at: Some(1_773_581_400_000),
                completed_by_kind: Some(recruitment_actor_kind.Player),
                completed_by_id: Some("x"),
                completed_by_name: None,
                evidence_ref_kind: Some(
                  signing_revision_parties.PlatformAcknowledgment,
                ),
                evidence_ref_id: Some("sgev-x"),
                evidence_revision_id: Some(id.signing_revision("spr-1")),
                evidence_document_sha256: Some(
                  "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
                ),
                evidence_at: Some(1_773_581_400_000),
                evidence_actor_kind: Some("player"),
                evidence_actor_id: Some("x"),
                evidence_session: Some("authenticated"),
                method: Some(signing_method.PlatformAcknowledgment),
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Completed,
                completed_at: Some(1_773_581_400_000),
                completed_by_kind: Some(recruitment_actor_kind.Org),
                completed_by_id: Some("x"),
                completed_by_name: None,
                evidence_ref_kind: Some(
                  signing_revision_parties.PlatformAcknowledgment,
                ),
                evidence_ref_id: Some("sgev-x"),
                evidence_revision_id: Some(id.signing_revision("spr-1")),
                evidence_document_sha256: Some(
                  "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
                ),
                evidence_at: Some(1_773_581_400_000),
                evidence_actor_kind: Some("org"),
                evidence_actor_id: Some("x"),
                evidence_session: Some("authenticated"),
                method: Some(signing_method.PlatformAcknowledgment),
              ),
            ],
          ),
        ],
      ),
      signing_rules.GateFacts(
        now: 1_773_583_200_000,
        offer: Some(signing_rules.GateOffer(
          id: id.offer("rof-1"),
          status: Some(offer_status.Accepted),
          org_id: id.org("o1"),
          player_id: id.player("p2"),
          case_id: id.recruitment_case("c1"),
        )),
        offer_revision: Some(signing_rules.GateRevision(
          id: id.offer_revision("rofr-1"),
          status: offer_status.Accepted,
        )),
        kase: Some(base.kase(
          id.recruitment_case("c1"),
          id.org("o1"),
          id.player("p1"),
          room_status.OfferAccepted,
        )),
        other_completed: False,
        blocked: False,
        document_problem: None,
      ),
    )
    == ["REFERENCE_MISMATCH"]
}

// signings: completionGate — [neg] A31 evidence against another digest closes the gate
pub fn neg_a31_evidence_against_another_digest_closes_the_gate_test() {
  assert signing_rules.completion_gate(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-1"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.InProgress,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-1"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.InProgress,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Completed,
                completed_at: Some(1_773_581_400_000),
                completed_by_kind: Some(recruitment_actor_kind.Player),
                completed_by_id: Some("x"),
                completed_by_name: None,
                evidence_ref_kind: Some(
                  signing_revision_parties.PlatformAcknowledgment,
                ),
                evidence_ref_id: Some("sgev-x"),
                evidence_revision_id: Some(id.signing_revision("spr-1")),
                evidence_document_sha256: Some(
                  "c3d4f54b9e362b92b89b77a7caa082aeb63c43d46a0cf44afd390df561eddec5",
                ),
                evidence_at: Some(1_773_581_400_000),
                evidence_actor_kind: Some("player"),
                evidence_actor_id: Some("x"),
                evidence_session: Some("authenticated"),
                method: Some(signing_method.PlatformAcknowledgment),
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Completed,
                completed_at: Some(1_773_581_400_000),
                completed_by_kind: Some(recruitment_actor_kind.Org),
                completed_by_id: Some("x"),
                completed_by_name: None,
                evidence_ref_kind: Some(
                  signing_revision_parties.PlatformAcknowledgment,
                ),
                evidence_ref_id: Some("sgev-x"),
                evidence_revision_id: Some(id.signing_revision("spr-1")),
                evidence_document_sha256: Some(
                  "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
                ),
                evidence_at: Some(1_773_581_400_000),
                evidence_actor_kind: Some("org"),
                evidence_actor_id: Some("x"),
                evidence_session: Some("authenticated"),
                method: Some(signing_method.PlatformAcknowledgment),
              ),
            ],
          ),
        ],
      ),
      signing_rules.GateFacts(
        now: 1_773_583_200_000,
        offer: Some(signing_rules.GateOffer(
          id: id.offer("rof-1"),
          status: Some(offer_status.Accepted),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
        )),
        offer_revision: Some(signing_rules.GateRevision(
          id: id.offer_revision("rofr-1"),
          status: offer_status.Accepted,
        )),
        kase: Some(base.kase(
          id.recruitment_case("c1"),
          id.org("o1"),
          id.player("p1"),
          room_status.OfferAccepted,
        )),
        other_completed: False,
        blocked: False,
        document_problem: None,
      ),
    )
    == ["DOCUMENT_MISMATCH"]
}

// signings: signingIntegrity — A32 sound rows pass integrity
pub fn a32_sound_rows_pass_integrity_test() {
  assert signing_rules.integrity(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-1"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.Ready,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-1"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.Ready,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
            ],
          ),
        ],
      ),
      None,
    )
    == []
}

// signings: signingIntegrity — A32 sound rows pass integrity
pub fn a32_sound_rows_pass_integrity_2_test() {
  assert signing_rules.integrity(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-1"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.InProgress,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-1"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.InProgress,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Completed,
                completed_at: Some(1_773_581_400_000),
                completed_by_kind: Some(recruitment_actor_kind.Player),
                completed_by_id: Some("x"),
                completed_by_name: None,
                evidence_ref_kind: Some(
                  signing_revision_parties.PlatformAcknowledgment,
                ),
                evidence_ref_id: Some("sgev-x"),
                evidence_revision_id: Some(id.signing_revision("spr-1")),
                evidence_document_sha256: Some(
                  "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
                ),
                evidence_at: Some(1_773_581_400_000),
                evidence_actor_kind: Some("player"),
                evidence_actor_id: Some("x"),
                evidence_session: Some("authenticated"),
                method: Some(signing_method.PlatformAcknowledgment),
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Completed,
                completed_at: Some(1_773_581_400_000),
                completed_by_kind: Some(recruitment_actor_kind.Org),
                completed_by_id: Some("x"),
                completed_by_name: None,
                evidence_ref_kind: Some(
                  signing_revision_parties.PlatformAcknowledgment,
                ),
                evidence_ref_id: Some("sgev-x"),
                evidence_revision_id: Some(id.signing_revision("spr-1")),
                evidence_document_sha256: Some(
                  "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
                ),
                evidence_at: Some(1_773_581_400_000),
                evidence_actor_kind: Some("org"),
                evidence_actor_id: Some("x"),
                evidence_session: Some("authenticated"),
                method: Some(signing_method.PlatformAcknowledgment),
              ),
            ],
          ),
        ],
      ),
      None,
    )
    == []
}

// signings: signingIntegrity — [neg] #45 A34 presented before created is corruption
pub fn neg_45_a34_presented_before_created_is_corruption_test() {
  assert signing_rules.integrity(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-1"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.Ready,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-1"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.Ready,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_572_400_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
            ],
          ),
        ],
      ),
      None,
    )
    == ["ready_before_created"]
}

// signings: signingIntegrity — [neg] #45 A35 a party completed before the revision was presented is corruption
pub fn neg_45_a35_a_party_completed_before_the_revision_was_presented_is_corrup_test() {
  assert signing_rules.integrity(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-1"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.InProgress,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-1"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.InProgress,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Completed,
                completed_at: Some(1_773_576_000_000),
                completed_by_kind: Some(recruitment_actor_kind.Player),
                completed_by_id: Some("x"),
                completed_by_name: None,
                evidence_ref_kind: Some(
                  signing_revision_parties.PlatformAcknowledgment,
                ),
                evidence_ref_id: Some("sgev-x"),
                evidence_revision_id: Some(id.signing_revision("spr-1")),
                evidence_document_sha256: Some(
                  "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
                ),
                evidence_at: Some(1_773_581_400_000),
                evidence_actor_kind: Some("player"),
                evidence_actor_id: Some("x"),
                evidence_session: Some("authenticated"),
                method: Some(signing_method.PlatformAcknowledgment),
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Completed,
                completed_at: Some(1_773_581_400_000),
                completed_by_kind: Some(recruitment_actor_kind.Org),
                completed_by_id: Some("x"),
                completed_by_name: None,
                evidence_ref_kind: Some(
                  signing_revision_parties.PlatformAcknowledgment,
                ),
                evidence_ref_id: Some("sgev-x"),
                evidence_revision_id: Some(id.signing_revision("spr-1")),
                evidence_document_sha256: Some(
                  "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
                ),
                evidence_at: Some(1_773_581_400_000),
                evidence_actor_kind: Some("org"),
                evidence_actor_id: Some("x"),
                evidence_session: Some("authenticated"),
                method: Some(signing_method.PlatformAcknowledgment),
              ),
            ],
          ),
        ],
      ),
      None,
    )
    == ["party_before_ready", "party_evidence_instant"]
}

// signings: signingIntegrity — [neg] #46 A36 completed before the final party is corruption
pub fn neg_46_a36_completed_before_the_final_party_is_corruption_test() {
  assert signing_rules.integrity(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..signing_packages.Row(
            ..base.signing_package().row,
            id: id.signing_package("spk-1"),
            org_id: id.org("o1"),
            player_id: id.player("p1"),
            case_id: id.recruitment_case("c1"),
            offer_id: id.offer("rof-1"),
            offer_revision_id: "rofr-1",
            status: signing_packages.Completed,
            current_revision_id: id.signing_revision("spr-1"),
            created_at: 1_773_576_000_000,
            expires_at: Some(1_774_180_800_000),
          ),
          completion_signing_id: Some(id.signing("s")),
          completion_completed_at: Some(1_773_579_600_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-1"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.Completed,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
              completed_at: Some(1_773_579_600_000),
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Completed,
                completed_at: Some(1_773_581_400_000),
                completed_by_kind: Some(recruitment_actor_kind.Player),
                completed_by_id: Some("x"),
                completed_by_name: None,
                evidence_ref_kind: Some(
                  signing_revision_parties.PlatformAcknowledgment,
                ),
                evidence_ref_id: Some("sgev-x"),
                evidence_revision_id: Some(id.signing_revision("spr-1")),
                evidence_document_sha256: Some(
                  "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
                ),
                evidence_at: Some(1_773_581_400_000),
                evidence_actor_kind: Some("player"),
                evidence_actor_id: Some("x"),
                evidence_session: Some("authenticated"),
                method: Some(signing_method.PlatformAcknowledgment),
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Completed,
                completed_at: Some(1_773_581_400_000),
                completed_by_kind: Some(recruitment_actor_kind.Org),
                completed_by_id: Some("x"),
                completed_by_name: None,
                evidence_ref_kind: Some(
                  signing_revision_parties.PlatformAcknowledgment,
                ),
                evidence_ref_id: Some("sgev-x"),
                evidence_revision_id: Some(id.signing_revision("spr-1")),
                evidence_document_sha256: Some(
                  "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
                ),
                evidence_at: Some(1_773_581_400_000),
                evidence_actor_kind: Some("org"),
                evidence_actor_id: Some("x"),
                evidence_session: Some("authenticated"),
                method: Some(signing_method.PlatformAcknowledgment),
              ),
            ],
          ),
        ],
      ),
      None,
    )
    == ["completed_before_parties"]
}

// signings: signingIntegrity — [neg] A37 a COMPLETED package without its completion record is corruption
pub fn neg_a37_a_completed_package_without_its_completion_record_is_corruption_test() {
  assert signing_rules.integrity(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-1"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.Completed,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-1"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.Completed,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
              completed_at: Some(1_773_583_200_000),
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Completed,
                completed_at: Some(1_773_581_400_000),
                completed_by_kind: Some(recruitment_actor_kind.Player),
                completed_by_id: Some("x"),
                completed_by_name: None,
                evidence_ref_kind: Some(
                  signing_revision_parties.PlatformAcknowledgment,
                ),
                evidence_ref_id: Some("sgev-x"),
                evidence_revision_id: Some(id.signing_revision("spr-1")),
                evidence_document_sha256: Some(
                  "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
                ),
                evidence_at: Some(1_773_581_400_000),
                evidence_actor_kind: Some("player"),
                evidence_actor_id: Some("x"),
                evidence_session: Some("authenticated"),
                method: Some(signing_method.PlatformAcknowledgment),
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Completed,
                completed_at: Some(1_773_581_400_000),
                completed_by_kind: Some(recruitment_actor_kind.Org),
                completed_by_id: Some("x"),
                completed_by_name: None,
                evidence_ref_kind: Some(
                  signing_revision_parties.PlatformAcknowledgment,
                ),
                evidence_ref_id: Some("sgev-x"),
                evidence_revision_id: Some(id.signing_revision("spr-1")),
                evidence_document_sha256: Some(
                  "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
                ),
                evidence_at: Some(1_773_581_400_000),
                evidence_actor_kind: Some("org"),
                evidence_actor_id: Some("x"),
                evidence_session: Some("authenticated"),
                method: Some(signing_method.PlatformAcknowledgment),
              ),
            ],
          ),
        ],
      ),
      None,
    )
    == ["completion"]
}

// signings: signingIntegrity — [neg] A38 a pointer at a non-latest revision is corruption
pub fn neg_a38_a_pointer_at_a_non_latest_revision_is_corruption_test() {
  assert signing_rules.integrity(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-1"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.Ready,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-1"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.Ready,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
            ],
          ),
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-2"),
                package_id: id.signing_package("spk-1"),
                position: 1,
              ),
              revision_number: 2,
              status: signing_revisions.Ready,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-2"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-2"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-2"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
            ],
          ),
        ],
      ),
      None,
    )
    == ["current_revision_not_latest"]
}

// signings: signingIntegrity — [neg] #10 A39 a PLAYER party completed by an org actor is corruption on the record too
pub fn neg_10_a39_a_player_party_completed_by_an_org_actor_is_corruption_on_the_test() {
  assert signing_rules.integrity(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-1"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.InProgress,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-1"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.InProgress,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Completed,
                completed_at: Some(1_773_581_400_000),
                completed_by_kind: Some(recruitment_actor_kind.Org),
                completed_by_id: Some("agent"),
                completed_by_name: None,
                evidence_ref_kind: Some(
                  signing_revision_parties.PlatformAcknowledgment,
                ),
                evidence_ref_id: Some("sgev-x"),
                evidence_revision_id: Some(id.signing_revision("spr-1")),
                evidence_document_sha256: Some(
                  "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
                ),
                evidence_at: Some(1_773_581_400_000),
                evidence_actor_kind: Some("player"),
                evidence_actor_id: Some("x"),
                evidence_session: Some("authenticated"),
                method: Some(signing_method.PlatformAcknowledgment),
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Completed,
                completed_at: Some(1_773_581_400_000),
                completed_by_kind: Some(recruitment_actor_kind.Org),
                completed_by_id: Some("x"),
                completed_by_name: None,
                evidence_ref_kind: Some(
                  signing_revision_parties.PlatformAcknowledgment,
                ),
                evidence_ref_id: Some("sgev-x"),
                evidence_revision_id: Some(id.signing_revision("spr-1")),
                evidence_document_sha256: Some(
                  "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
                ),
                evidence_at: Some(1_773_581_400_000),
                evidence_actor_kind: Some("org"),
                evidence_actor_id: Some("x"),
                evidence_session: Some("authenticated"),
                method: Some(signing_method.PlatformAcknowledgment),
              ),
            ],
          ),
        ],
      ),
      None,
    )
    == ["party_actor_kind", "party_evidence_actor"]
}

// signings: signingRecipientView — [neg] #8 A41 the recipient view of an unpresented revision carries no revision
pub fn neg_8_a41_the_recipient_view_of_an_unpresented_revision_carries_no_revis_test() {
  assert json.to_string(
      json.object(signing_rules.recipient_view(
        signing_rules.Package(
          ..base.signing_package(),
          row: signing_packages.Row(
            ..base.signing_package().row,
            id: id.signing_package("spk-1"),
            org_id: id.org("o1"),
            player_id: id.player("p1"),
            case_id: id.recruitment_case("c1"),
            offer_id: id.offer("rof-1"),
            offer_revision_id: "rofr-1",
            status: signing_packages.Ready,
            current_revision_id: id.signing_revision("spr-1"),
            created_at: 1_773_576_000_000,
            expires_at: Some(1_774_180_800_000),
          ),
          revisions: [
            signing_rules.Revision(
              row: signing_revisions.Row(
                ..signing_revisions.Row(
                  ..base.signing_revision(),
                  id: id.signing_revision("spr-1"),
                  package_id: id.signing_package("spk-1"),
                  position: 0,
                ),
                revision_number: 1,
                status: signing_revisions.Draft,
                created_at: 1_773_576_000_000,
                ready_at: None,
                contract_start_date: Some("2027-07-01"),
                contract_end_date: None,
              ),
              document: Some(
                signing_documents.Row(
                  ..signing_documents.Row(
                    ..base.signing_document(),
                    revision_id: id.signing_revision("spr-1"),
                    kind: signing_documents.Signing,
                  ),
                  evidence_id: id.evidence("vevd-1"),
                  sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
                ),
              ),
              executed: None,
              parties: [
                signing_revision_parties.Row(
                  ..signing_revision_parties.Row(
                    ..base.signing_party(),
                    revision_id: id.signing_revision("spr-1"),
                    position: 0,
                  ),
                  party_type: signing_party_type.Player,
                  for_entity_id: Some("p1"),
                  for_player_id: Some(id.player("p1")),
                  status: signing_revision_parties.Pending,
                  completed_at: None,
                  method: None,
                ),
                signing_revision_parties.Row(
                  ..signing_revision_parties.Row(
                    ..base.signing_party(),
                    revision_id: id.signing_revision("spr-1"),
                    position: 1,
                  ),
                  party_type: signing_party_type.ClubSignatory,
                  for_entity_id: Some("o1"),
                  for_player_id: Some(id.player("p1")),
                  status: signing_revision_parties.Pending,
                  completed_at: None,
                  method: None,
                ),
              ],
            ),
          ],
        ),
        1_773_576_000_000,
        Some("X"),
        signing_party_type.Player,
        "p1",
      )),
    )
    == "{\"id\":\"spk-1\",\"playerId\":\"p1\",\"club\":{\"id\":\"o1\",\"name\":\"X\"},\"offerId\":\"rof-1\",\"offerRevisionId\":\"rofr-1\",\"status\":\"READY\",\"statusLabel\":\"Presented — awaiting signatures\",\"terminal\":false,\"currentRevisionId\":null,\"currentRevision\":null,\"revisions\":[],\"expiresAt\":1774180800000,\"nextAction\":{\"action\":\"COMPLETE_SIGNATURE\",\"revisionId\":\"spr-1\",\"documentSha256\":\"33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8\"},\"completion\":null,\"policyVersion\":1,\"honest\":\"Completing your signature here records that you, as the authenticated account holder, confirm the exact document shown. ScoutBox records the workflow and the evidence; it does not execute the agreement for you.\"}"
}

// signings: signingAgentView — [neg] #39 A42 the note reaches the club view only; the agent view carries no digest
pub fn neg_39_a42_the_note_reaches_the_club_view_only_the_agent_view_carries_no_test() {
  assert json.to_string(
      json.object(signing_rules.agent_view(
        signing_rules.Package(
          ..base.signing_package(),
          row: signing_packages.Row(
            ..base.signing_package().row,
            id: id.signing_package("spk-1"),
            org_id: id.org("o1"),
            player_id: id.player("p1"),
            case_id: id.recruitment_case("c1"),
            offer_id: id.offer("rof-1"),
            offer_revision_id: "rofr-1",
            status: signing_packages.Ready,
            current_revision_id: id.signing_revision("spr-1"),
            created_at: 1_773_576_000_000,
            expires_at: Some(1_774_180_800_000),
            internal_note: Some("PRIVATE_SIGNING_NOTE_8811"),
          ),
          revisions: [
            signing_rules.Revision(
              row: signing_revisions.Row(
                ..signing_revisions.Row(
                  ..base.signing_revision(),
                  id: id.signing_revision("spr-1"),
                  package_id: id.signing_package("spk-1"),
                  position: 0,
                ),
                revision_number: 1,
                status: signing_revisions.Ready,
                created_at: 1_773_576_000_000,
                ready_at: Some(1_773_579_600_000),
                contract_start_date: Some("2027-07-01"),
                contract_end_date: None,
              ),
              document: Some(
                signing_documents.Row(
                  ..signing_documents.Row(
                    ..base.signing_document(),
                    revision_id: id.signing_revision("spr-1"),
                    kind: signing_documents.Signing,
                  ),
                  evidence_id: id.evidence("vevd-1"),
                  sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
                ),
              ),
              executed: None,
              parties: [
                signing_revision_parties.Row(
                  ..signing_revision_parties.Row(
                    ..base.signing_party(),
                    revision_id: id.signing_revision("spr-1"),
                    position: 0,
                  ),
                  party_type: signing_party_type.Player,
                  for_entity_id: Some("p1"),
                  for_player_id: Some(id.player("p1")),
                  status: signing_revision_parties.Pending,
                  completed_at: None,
                  method: None,
                ),
                signing_revision_parties.Row(
                  ..signing_revision_parties.Row(
                    ..base.signing_party(),
                    revision_id: id.signing_revision("spr-1"),
                    position: 1,
                  ),
                  party_type: signing_party_type.ClubSignatory,
                  for_entity_id: Some("o1"),
                  for_player_id: Some(id.player("p1")),
                  status: signing_revision_parties.Pending,
                  completed_at: None,
                  method: None,
                ),
              ],
            ),
          ],
        ),
        1_773_576_000_000,
        None,
      )),
    )
    == "{\"id\":\"spk-1\",\"clientId\":\"p1\",\"club\":{\"id\":\"o1\",\"name\":null},\"offerId\":\"rof-1\",\"status\":\"READY\",\"statusLabel\":\"Presented — awaiting signatures\",\"terminal\":false,\"currentRevisionNumber\":1,\"presented\":true,\"expiresAt\":1774180800000,\"requiredParties\":[{\"partyType\":\"PLAYER\",\"status\":\"PENDING\",\"completedAt\":null},{\"partyType\":\"CLUB_SIGNATORY\",\"status\":\"PENDING\",\"completedAt\":null}],\"clientActionRequired\":true,\"contract\":{\"startDate\":\"2027-07-01\",\"endDate\":null},\"completedAt\":null,\"honest\":\"Read-only. Your client signs as themselves; ScoutBox does not let you sign, acknowledge or complete for a client.\"}"
}

// signings: cleanText — [neg] A43 bidi controls stripped; limits enforced
pub fn neg_a43_bidi_controls_stripped_limits_enforced_test() {
  assert signing_rules.clean_text(Some("a‮b"), 100) == Ok(Some("ab"))
}

// signings: cleanText — [neg] A43 bidi controls stripped; limits enforced
pub fn neg_a43_bidi_controls_stripped_limits_enforced_2_test() {
  assert signing_rules.clean_text(
      Some(
        "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      ),
      100,
    )
    == Error(Nil)
}

// signings: signingConsistency — AD0 a sound package over its accepted Offer revision has no consistency problem
pub fn ad0_a_sound_package_over_its_accepted_offer_revision_has_no_consistency_test() {
  assert signing_rules.consistency(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-x"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.Ready,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_773_662_400_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-x"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.Ready,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_576_000_001),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("ev"),
                sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                status: signing_revision_parties.Pending,
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                status: signing_revision_parties.Pending,
              ),
            ],
          ),
        ],
      ),
      Some(
        offer_rules.Offer(
          ..base.offer(),
          row: recruitment_offers.Row(
            ..base.offer().row,
            id: id.offer("rof-1"),
            org_id: id.org("o1"),
            player_id: id.player("p1"),
            case_id: id.recruitment_case("c1"),
          ),
          revisions: [
            offer_rules.Revision(
              row: offer_revisions.Row(
                ..offer_revisions.Row(
                  ..base.offer_revision(),
                  position: 0,
                  revision_number: 1,
                ),
                id: id.offer_revision("rofr-1"),
                status: offer_status.Accepted,
              ),
              documents: [],
            ),
          ],
          responses: [],
        ),
      ),
      Some(base.kase(
        id.recruitment_case("c1"),
        id.org("o1"),
        id.player("p1"),
        room_status.OfferAccepted,
      )),
      [],
      None,
      1_773_576_000_000,
    )
    == []
}

// signings: signingConsistency — [neg] #5 AD1 a package whose Offer names another player is corruption
pub fn neg_5_ad1_a_package_whose_offer_names_another_player_is_corruption_test() {
  assert signing_rules.consistency(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-x"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.Ready,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_773_662_400_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-x"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.Ready,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_576_000_001),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("ev"),
                sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                status: signing_revision_parties.Pending,
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                status: signing_revision_parties.Pending,
              ),
            ],
          ),
        ],
      ),
      Some(
        offer_rules.Offer(
          ..base.offer(),
          row: recruitment_offers.Row(
            ..base.offer().row,
            id: id.offer("rof-1"),
            org_id: id.org("o1"),
            player_id: id.player("p2"),
            case_id: id.recruitment_case("c1"),
          ),
          revisions: [
            offer_rules.Revision(
              row: offer_revisions.Row(
                ..offer_revisions.Row(
                  ..base.offer_revision(),
                  position: 0,
                  revision_number: 1,
                ),
                id: id.offer_revision("rofr-1"),
                status: offer_status.Accepted,
              ),
              documents: [],
            ),
          ],
          responses: [],
        ),
      ),
      Some(base.kase(
        id.recruitment_case("c1"),
        id.org("o1"),
        id.player("p1"),
        room_status.OfferAccepted,
      )),
      [],
      None,
      1_773_576_000_000,
    )
    == ["OFFER_REFERENCE_MISMATCH"]
}

// signings: signingCorrupt — [neg] #5 AD1 a package whose Offer names another player is corruption
pub fn neg_5_ad1_a_package_whose_offer_names_another_player_is_corruption_2_test() {
  assert signing_rules.corrupt(["OFFER_REFERENCE_MISMATCH"]) == True
}

// signings: signingConsistency — [neg] #6 AD2 a package whose case names another player, or whose Offer belongs to another case, is corruption
pub fn neg_6_ad2_a_package_whose_case_names_another_player_or_whose_offer_belon_test() {
  assert signing_rules.consistency(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-x"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.Ready,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_773_662_400_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-x"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.Ready,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_576_000_001),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("ev"),
                sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                status: signing_revision_parties.Pending,
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                status: signing_revision_parties.Pending,
              ),
            ],
          ),
        ],
      ),
      Some(
        offer_rules.Offer(
          ..base.offer(),
          row: recruitment_offers.Row(
            ..base.offer().row,
            id: id.offer("rof-1"),
            org_id: id.org("o1"),
            player_id: id.player("p1"),
            case_id: id.recruitment_case("c1"),
          ),
          revisions: [
            offer_rules.Revision(
              row: offer_revisions.Row(
                ..offer_revisions.Row(
                  ..base.offer_revision(),
                  position: 0,
                  revision_number: 1,
                ),
                id: id.offer_revision("rofr-1"),
                status: offer_status.Accepted,
              ),
              documents: [],
            ),
          ],
          responses: [],
        ),
      ),
      Some(base.kase(
        id.recruitment_case("c1"),
        id.org("o1"),
        id.player("p2"),
        room_status.OfferAccepted,
      )),
      [],
      None,
      1_773_576_000_000,
    )
    == ["CASE_REFERENCE_MISMATCH"]
}

// signings: signingConsistency — [neg] #6 AD2 a package whose case names another player, or whose Offer belongs to another case, is corruption
pub fn neg_6_ad2_a_package_whose_case_names_another_player_or_whose_offer_belon_2_test() {
  assert signing_rules.consistency(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-x"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.Ready,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_773_662_400_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-x"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.Ready,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_576_000_001),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("ev"),
                sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                status: signing_revision_parties.Pending,
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                status: signing_revision_parties.Pending,
              ),
            ],
          ),
        ],
      ),
      Some(
        offer_rules.Offer(
          ..base.offer(),
          row: recruitment_offers.Row(
            ..base.offer().row,
            id: id.offer("rof-1"),
            org_id: id.org("o1"),
            player_id: id.player("p1"),
            case_id: id.recruitment_case("c9"),
          ),
          revisions: [
            offer_rules.Revision(
              row: offer_revisions.Row(
                ..offer_revisions.Row(
                  ..base.offer_revision(),
                  position: 0,
                  revision_number: 1,
                ),
                id: id.offer_revision("rofr-1"),
                status: offer_status.Accepted,
              ),
              documents: [],
            ),
          ],
          responses: [],
        ),
      ),
      Some(base.kase(
        id.recruitment_case("c1"),
        id.org("o1"),
        id.player("p1"),
        room_status.OfferAccepted,
      )),
      [],
      None,
      1_773_576_000_000,
    )
    == ["OFFER_REFERENCE_MISMATCH"]
}

// signings: signingConsistency — [neg] #7 AD3 a package bound to a superseded or unknown Offer revision is corruption; bound to the accepted one it is sound
pub fn neg_7_ad3_a_package_bound_to_a_superseded_or_unknown_offer_revision_is_c_test() {
  assert signing_rules.consistency(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-x"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-0",
          status: signing_packages.Ready,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_773_662_400_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-x"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.Ready,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_576_000_001),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("ev"),
                sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                status: signing_revision_parties.Pending,
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                status: signing_revision_parties.Pending,
              ),
            ],
          ),
        ],
      ),
      Some(
        offer_rules.Offer(
          ..base.offer(),
          row: recruitment_offers.Row(
            ..base.offer().row,
            id: id.offer("rof-1"),
            org_id: id.org("o1"),
            player_id: id.player("p1"),
            case_id: id.recruitment_case("c1"),
          ),
          revisions: [
            offer_rules.Revision(
              row: offer_revisions.Row(
                ..offer_revisions.Row(
                  ..base.offer_revision(),
                  position: 0,
                  revision_number: 1,
                ),
                id: id.offer_revision("rofr-0"),
                status: offer_status.Superseded,
                superseded_by_revision_id: Some(id.offer_revision("rofr-1")),
              ),
              documents: [],
            ),
            offer_rules.Revision(
              row: offer_revisions.Row(
                ..offer_revisions.Row(
                  ..base.offer_revision(),
                  position: 1,
                  revision_number: 2,
                ),
                id: id.offer_revision("rofr-1"),
                status: offer_status.Accepted,
              ),
              documents: [],
            ),
          ],
          responses: [],
        ),
      ),
      Some(base.kase(
        id.recruitment_case("c1"),
        id.org("o1"),
        id.player("p1"),
        room_status.OfferAccepted,
      )),
      [],
      None,
      1_773_576_000_000,
    )
    == ["OFFER_REVISION_MISMATCH"]
}

// signings: signingConsistency — [neg] #7 AD3 a package bound to a superseded or unknown Offer revision is corruption; bound to the accepted one it is sound
pub fn neg_7_ad3_a_package_bound_to_a_superseded_or_unknown_offer_revision_is_c_2_test() {
  assert signing_rules.consistency(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-x"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-9",
          status: signing_packages.Ready,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_773_662_400_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-x"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.Ready,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_576_000_001),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("ev"),
                sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                status: signing_revision_parties.Pending,
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                status: signing_revision_parties.Pending,
              ),
            ],
          ),
        ],
      ),
      Some(
        offer_rules.Offer(
          ..base.offer(),
          row: recruitment_offers.Row(
            ..base.offer().row,
            id: id.offer("rof-1"),
            org_id: id.org("o1"),
            player_id: id.player("p1"),
            case_id: id.recruitment_case("c1"),
          ),
          revisions: [
            offer_rules.Revision(
              row: offer_revisions.Row(
                ..offer_revisions.Row(
                  ..base.offer_revision(),
                  position: 0,
                  revision_number: 1,
                ),
                id: id.offer_revision("rofr-0"),
                status: offer_status.Superseded,
                superseded_by_revision_id: Some(id.offer_revision("rofr-1")),
              ),
              documents: [],
            ),
            offer_rules.Revision(
              row: offer_revisions.Row(
                ..offer_revisions.Row(
                  ..base.offer_revision(),
                  position: 1,
                  revision_number: 2,
                ),
                id: id.offer_revision("rofr-1"),
                status: offer_status.Accepted,
              ),
              documents: [],
            ),
          ],
          responses: [],
        ),
      ),
      Some(base.kase(
        id.recruitment_case("c1"),
        id.org("o1"),
        id.player("p1"),
        room_status.OfferAccepted,
      )),
      [],
      None,
      1_773_576_000_000,
    )
    == ["OFFER_REVISION_MISMATCH"]
}

// signings: signingConsistency — [neg] #7 AD3 a package bound to a superseded or unknown Offer revision is corruption; bound to the accepted one it is sound
pub fn neg_7_ad3_a_package_bound_to_a_superseded_or_unknown_offer_revision_is_c_3_test() {
  assert signing_rules.consistency(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-x"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.Ready,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_773_662_400_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-x"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.Ready,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_576_000_001),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("ev"),
                sha256: "33acdf25330b1603185a5acdc7af6875b30256c4d3cd676939c03f0800a458f8",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                status: signing_revision_parties.Pending,
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                status: signing_revision_parties.Pending,
              ),
            ],
          ),
        ],
      ),
      Some(
        offer_rules.Offer(
          ..base.offer(),
          row: recruitment_offers.Row(
            ..base.offer().row,
            id: id.offer("rof-1"),
            org_id: id.org("o1"),
            player_id: id.player("p1"),
            case_id: id.recruitment_case("c1"),
          ),
          revisions: [
            offer_rules.Revision(
              row: offer_revisions.Row(
                ..offer_revisions.Row(
                  ..base.offer_revision(),
                  position: 0,
                  revision_number: 1,
                ),
                id: id.offer_revision("rofr-0"),
                status: offer_status.Superseded,
                superseded_by_revision_id: Some(id.offer_revision("rofr-1")),
              ),
              documents: [],
            ),
            offer_rules.Revision(
              row: offer_revisions.Row(
                ..offer_revisions.Row(
                  ..base.offer_revision(),
                  position: 1,
                  revision_number: 2,
                ),
                id: id.offer_revision("rofr-1"),
                status: offer_status.Accepted,
              ),
              documents: [],
            ),
          ],
          responses: [],
        ),
      ),
      Some(base.kase(
        id.recruitment_case("c1"),
        id.org("o1"),
        id.player("p1"),
        room_status.OfferAccepted,
      )),
      [],
      None,
      1_773_576_000_000,
    )
    == []
}

// signingsAdversarial: signingIntegrity — A1 a genuine completed party passes
pub fn a1_a_genuine_completed_party_passes_test() {
  assert signing_rules.integrity(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-1"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.InProgress,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-1"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.InProgress,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Completed,
                completed_at: Some(1_773_583_200_000),
                completed_by_kind: Some(recruitment_actor_kind.Player),
                completed_by_id: Some("p1"),
                completed_by_name: Some("P"),
                evidence_ref_kind: Some(
                  signing_revision_parties.PlatformAcknowledgment,
                ),
                evidence_ref_id: Some("sgev-1"),
                evidence_revision_id: Some(id.signing_revision("spr-1")),
                evidence_document_sha256: Some(
                  "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
                ),
                evidence_at: Some(1_773_583_200_000),
                evidence_actor_kind: Some("player"),
                evidence_actor_id: Some("p1"),
                evidence_session: Some("authenticated"),
                method: Some(signing_method.PlatformAcknowledgment),
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
            ],
          ),
        ],
      ),
      None,
    )
    == []
}

// signingsAdversarial: signingIntegrity — [neg] A2 the actor on the party changed → party_evidence_actor
pub fn neg_a2_the_actor_on_the_party_changed_party_evidence_actor_test() {
  assert signing_rules.integrity(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-1"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.InProgress,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-1"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.InProgress,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Completed,
                completed_at: Some(1_773_583_200_000),
                completed_by_kind: Some(recruitment_actor_kind.Player),
                completed_by_id: Some("p2"),
                completed_by_name: Some("P"),
                evidence_ref_kind: Some(
                  signing_revision_parties.PlatformAcknowledgment,
                ),
                evidence_ref_id: Some("sgev-1"),
                evidence_revision_id: Some(id.signing_revision("spr-1")),
                evidence_document_sha256: Some(
                  "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
                ),
                evidence_at: Some(1_773_583_200_000),
                evidence_actor_kind: Some("player"),
                evidence_actor_id: Some("p1"),
                evidence_session: Some("authenticated"),
                method: Some(signing_method.PlatformAcknowledgment),
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
            ],
          ),
        ],
      ),
      None,
    )
    == ["party_evidence_actor"]
}

// signingsAdversarial: signingIntegrity — [neg] A3 the actor TYPE changed (an org actor on the player party) → party_actor_kind and party_evidence_actor
pub fn neg_a3_the_actor_type_changed_an_org_actor_on_the_player_party_party_act_test() {
  assert signing_rules.integrity(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-1"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.InProgress,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-1"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.InProgress,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Completed,
                completed_at: Some(1_773_583_200_000),
                completed_by_kind: Some(recruitment_actor_kind.Org),
                completed_by_id: Some("p1"),
                completed_by_name: Some("P"),
                evidence_ref_kind: Some(
                  signing_revision_parties.PlatformAcknowledgment,
                ),
                evidence_ref_id: Some("sgev-1"),
                evidence_revision_id: Some(id.signing_revision("spr-1")),
                evidence_document_sha256: Some(
                  "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
                ),
                evidence_at: Some(1_773_583_200_000),
                evidence_actor_kind: Some("player"),
                evidence_actor_id: Some("p1"),
                evidence_session: Some("authenticated"),
                method: Some(signing_method.PlatformAcknowledgment),
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
            ],
          ),
        ],
      ),
      None,
    )
    == ["party_actor_kind", "party_evidence_actor"]
}

// signingsAdversarial: signingIntegrity — [neg] A4 the evidence reference removed → party_evidence
pub fn neg_a4_the_evidence_reference_removed_party_evidence_test() {
  assert signing_rules.integrity(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-1"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.InProgress,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-1"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.InProgress,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Completed,
                completed_at: Some(1_773_583_200_000),
                completed_by_kind: Some(recruitment_actor_kind.Player),
                completed_by_id: Some("p1"),
                completed_by_name: Some("P"),
                method: Some(signing_method.PlatformAcknowledgment),
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
            ],
          ),
        ],
      ),
      None,
    )
    == ["party_evidence"]
}

// signingsAdversarial: signingIntegrity — [neg] A6 evidence that names another revision → party_evidence_revision
pub fn neg_a6_evidence_that_names_another_revision_party_evidence_revision_test() {
  assert signing_rules.integrity(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-1"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.InProgress,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-1"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.InProgress,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Completed,
                completed_at: Some(1_773_583_200_000),
                completed_by_kind: Some(recruitment_actor_kind.Player),
                completed_by_id: Some("p1"),
                completed_by_name: Some("P"),
                evidence_ref_kind: Some(
                  signing_revision_parties.PlatformAcknowledgment,
                ),
                evidence_ref_id: Some("sgev-1"),
                evidence_revision_id: Some(id.signing_revision("spr-0")),
                evidence_document_sha256: Some(
                  "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
                ),
                evidence_at: Some(1_773_583_200_000),
                evidence_actor_kind: Some("player"),
                evidence_actor_id: Some("p1"),
                evidence_session: Some("authenticated"),
                method: Some(signing_method.PlatformAcknowledgment),
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
            ],
          ),
        ],
      ),
      None,
    )
    == ["party_evidence_revision"]
}

// signingsAdversarial: signingIntegrity — [neg] A7 evidence that names another digest → party_evidence_digest
pub fn neg_a7_evidence_that_names_another_digest_party_evidence_digest_test() {
  assert signing_rules.integrity(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-1"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.InProgress,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-1"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.InProgress,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Completed,
                completed_at: Some(1_773_583_200_000),
                completed_by_kind: Some(recruitment_actor_kind.Player),
                completed_by_id: Some("p1"),
                completed_by_name: Some("P"),
                evidence_ref_kind: Some(
                  signing_revision_parties.PlatformAcknowledgment,
                ),
                evidence_ref_id: Some("sgev-1"),
                evidence_revision_id: Some(id.signing_revision("spr-1")),
                evidence_document_sha256: Some(
                  "069154ac1fe0d4febdff6fe2cc158a904cd18f327792b53eb6f7bb119c60d9b2",
                ),
                evidence_at: Some(1_773_583_200_000),
                evidence_actor_kind: Some("player"),
                evidence_actor_id: Some("p1"),
                evidence_session: Some("authenticated"),
                method: Some(signing_method.PlatformAcknowledgment),
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
            ],
          ),
        ],
      ),
      None,
    )
    == ["party_evidence_digest"]
}

// signingsAdversarial: signingIntegrity — [neg] A8 evidence whose instant differs from the party's → party_evidence_instant
pub fn neg_a8_evidence_whose_instant_differs_from_the_party_s_party_evidence_in_test() {
  assert signing_rules.integrity(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-1"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.InProgress,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-1"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.InProgress,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Completed,
                completed_at: Some(1_773_583_200_000),
                completed_by_kind: Some(recruitment_actor_kind.Player),
                completed_by_id: Some("p1"),
                completed_by_name: Some("P"),
                evidence_ref_kind: Some(
                  signing_revision_parties.PlatformAcknowledgment,
                ),
                evidence_ref_id: Some("sgev-1"),
                evidence_revision_id: Some(id.signing_revision("spr-1")),
                evidence_document_sha256: Some(
                  "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
                ),
                evidence_at: Some(1_773_586_800_000),
                evidence_actor_kind: Some("player"),
                evidence_actor_id: Some("p1"),
                evidence_session: Some("authenticated"),
                method: Some(signing_method.PlatformAcknowledgment),
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
            ],
          ),
        ],
      ),
      None,
    )
    == ["party_evidence_instant"]
}

// signingsAdversarial: signingIntegrity — [neg] A9 a party marked complete with no evidence → party_evidence
pub fn neg_a9_a_party_marked_complete_with_no_evidence_party_evidence_test() {
  assert signing_rules.integrity(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-1"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.InProgress,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-1"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.InProgress,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Completed,
                completed_at: Some(1_773_583_200_000),
                completed_by_kind: Some(recruitment_actor_kind.Player),
                completed_by_id: Some("p1"),
                completed_by_name: Some("P"),
                method: None,
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
            ],
          ),
        ],
      ),
      None,
    )
    == ["party_evidence"]
}

// signingsAdversarial: signingIntegrity — [neg] A10 a PENDING party carrying evidence → party_pending_with_evidence
pub fn neg_a10_a_pending_party_carrying_evidence_party_pending_with_evidence_test() {
  assert signing_rules.integrity(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-1"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.InProgress,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-1"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.InProgress,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Completed,
                completed_at: Some(1_773_583_200_000),
                completed_by_kind: Some(recruitment_actor_kind.Player),
                completed_by_id: Some("p1"),
                completed_by_name: Some("P"),
                evidence_ref_kind: Some(
                  signing_revision_parties.PlatformAcknowledgment,
                ),
                evidence_ref_id: Some("sgev-1"),
                evidence_revision_id: Some(id.signing_revision("spr-1")),
                evidence_document_sha256: Some(
                  "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
                ),
                evidence_at: Some(1_773_583_200_000),
                evidence_actor_kind: Some("player"),
                evidence_actor_id: Some("p1"),
                evidence_session: Some("authenticated"),
                method: Some(signing_method.PlatformAcknowledgment),
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                evidence_ref_kind: Some(
                  signing_revision_parties.PlatformAcknowledgment,
                ),
                evidence_ref_id: Some("x"),
                evidence_revision_id: Some(id.signing_revision("spr-1")),
                evidence_document_sha256: Some(
                  "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
                ),
                evidence_at: Some(1_773_583_200_000),
                evidence_actor_kind: Some("org"),
                evidence_actor_id: Some("u"),
                evidence_session: None,
                method: None,
              ),
            ],
          ),
        ],
      ),
      None,
    )
    == ["party_pending_with_evidence"]
}

// signingsAdversarial: completionGate — [neg] A11 the completion gate names the forged digest and the missing club party
pub fn neg_a11_the_completion_gate_names_the_forged_digest_and_the_missing_club_test() {
  assert signing_rules.completion_gate(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-1"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.InProgress,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-1"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.InProgress,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Completed,
                completed_at: Some(1_773_583_200_000),
                completed_by_kind: Some(recruitment_actor_kind.Player),
                completed_by_id: Some("p1"),
                completed_by_name: Some("P"),
                evidence_ref_kind: Some(
                  signing_revision_parties.PlatformAcknowledgment,
                ),
                evidence_ref_id: Some("sgev-1"),
                evidence_revision_id: Some(id.signing_revision("spr-1")),
                evidence_document_sha256: Some(
                  "069154ac1fe0d4febdff6fe2cc158a904cd18f327792b53eb6f7bb119c60d9b2",
                ),
                evidence_at: Some(1_773_583_200_000),
                evidence_actor_kind: Some("player"),
                evidence_actor_id: Some("p1"),
                evidence_session: Some("authenticated"),
                method: Some(signing_method.PlatformAcknowledgment),
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
            ],
          ),
        ],
      ),
      signing_rules.GateFacts(
        now: 1_773_586_800_000,
        offer: Some(signing_rules.GateOffer(
          id: id.offer("rof-1"),
          status: Some(offer_status.Accepted),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
        )),
        offer_revision: Some(signing_rules.GateRevision(
          id: id.offer_revision("rofr-1"),
          status: offer_status.Accepted,
        )),
        kase: Some(base.kase(
          id.recruitment_case("c1"),
          id.org("o1"),
          id.player("p1"),
          room_status.OfferAccepted,
        )),
        other_completed: False,
        blocked: False,
        document_problem: None,
      ),
    )
    == ["PARTIES_INCOMPLETE", "DOCUMENT_MISMATCH"]
}

// signingsAdversarial: completionGate — [neg] A12 a document-bytes problem the caller verified is a gate problem of its own
pub fn neg_a12_a_document_bytes_problem_the_caller_verified_is_a_gate_problem_o_test() {
  assert signing_rules.completion_gate(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-1"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.InProgress,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-1"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.InProgress,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
            ],
          ),
        ],
      ),
      signing_rules.GateFacts(
        now: 1_773_576_000_000,
        offer: None,
        offer_revision: None,
        kase: None,
        other_completed: False,
        blocked: False,
        document_problem: Some("bytes_mismatch"),
      ),
    )
    == [
      "DOCUMENT_BYTES_BYTES_MISMATCH",
      "PARTIES_INCOMPLETE",
      "OFFER_NOT_ACCEPTED",
      "OFFER_REVISION_MISMATCH",
      "CASE_MISMATCH",
    ]
}

// signingsAdversarial: signingIntegrity — [neg] D1 empty requiredParties → parties
pub fn neg_d1_empty_requiredparties_parties_test() {
  assert signing_rules.integrity(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-d"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.Ready,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-d"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.Ready,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
              ),
            ),
            executed: None,
            parties: [],
          ),
        ],
      ),
      None,
    )
    == ["parties"]
}

// signingsAdversarial: signingIntegrity — [neg] D2 a duplicate required party → party_duplicate
pub fn neg_d2_a_duplicate_required_party_party_duplicate_test() {
  assert signing_rules.integrity(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-d"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.Ready,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-d"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.Ready,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 2,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
            ],
          ),
        ],
      ),
      None,
    )
    == ["party_duplicate"]
}

// signingsAdversarial: signingIntegrity — [neg] D4 a PLAYER party naming another player → party_entity_mismatch
pub fn neg_d4_a_player_party_naming_another_player_party_entity_mismatch_test() {
  assert signing_rules.integrity(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-d"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.Ready,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-d"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.Ready,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p2"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
            ],
          ),
        ],
      ),
      None,
    )
    == ["party_entity_mismatch"]
}

// signingsAdversarial: signingIntegrity — [neg] D4b a party for another player → party_player_mismatch
pub fn neg_d4b_a_party_for_another_player_party_player_mismatch_test() {
  assert signing_rules.integrity(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-d"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.Ready,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-d"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.Ready,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p2")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
            ],
          ),
        ],
      ),
      None,
    )
    == ["party_player_mismatch"]
}

// signingsAdversarial: signingIntegrity — [neg] D5 a CLUB_SIGNATORY naming another organisation → party_entity_mismatch
pub fn neg_d5_a_club_signatory_naming_another_organisation_party_entity_mismatc_test() {
  assert signing_rules.integrity(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-d"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.Ready,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-d"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.Ready,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o2"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
            ],
          ),
        ],
      ),
      None,
    )
    == ["party_entity_mismatch"]
}

// signingsAdversarial: signingIntegrity — [neg] D6 no player party → party_recipient_missing
pub fn neg_d6_no_player_party_party_recipient_missing_test() {
  assert signing_rules.integrity(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-d"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.Ready,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-d"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.Ready,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
            ],
          ),
        ],
      ),
      None,
    )
    == ["party_recipient_missing"]
}

// signingsAdversarial: signingIntegrity — [neg] D6b no club signatory → party_club_missing
pub fn neg_d6b_no_club_signatory_party_club_missing_test() {
  assert signing_rules.integrity(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-d"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.Ready,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-d"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.Ready,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
            ],
          ),
        ],
      ),
      None,
    )
    == ["party_club_missing"]
}

// signingsAdversarial: signingIntegrity — [neg] D7 a guardian added beside the adult player → party_recipient_duplicate
pub fn neg_d7_a_guardian_added_beside_the_adult_player_party_recipient_duplicat_test() {
  assert signing_rules.integrity(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-d"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.Ready,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-d"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.Ready,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 2,
                ),
                party_type: signing_party_type.Guardian,
                for_entity_id: Some("gd-1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
            ],
          ),
        ],
      ),
      None,
    )
    == ["party_recipient_duplicate"]
}

// signingsAdversarial: canCompleteParty — [neg] D8 an agent (org actor) substituted for the player is refused by the party gate
pub fn neg_d8_an_agent_org_actor_substituted_for_the_player_is_refused_by_the_p_test() {
  assert result.map_error(
      signing_rules.can_complete_party(
        signing_rules.Package(
          ..base.signing_package(),
          row: signing_packages.Row(
            ..base.signing_package().row,
            id: id.signing_package("spk-d"),
            org_id: id.org("o1"),
            player_id: id.player("p1"),
            case_id: id.recruitment_case("c1"),
            offer_id: id.offer("rof-1"),
            offer_revision_id: "rofr-1",
            status: signing_packages.Ready,
            current_revision_id: id.signing_revision("spr-1"),
            created_at: 1_773_576_000_000,
            expires_at: Some(1_774_180_800_000),
          ),
          revisions: [
            signing_rules.Revision(
              row: signing_revisions.Row(
                ..signing_revisions.Row(
                  ..base.signing_revision(),
                  id: id.signing_revision("spr-1"),
                  package_id: id.signing_package("spk-d"),
                  position: 0,
                ),
                revision_number: 1,
                status: signing_revisions.Ready,
                created_at: 1_773_576_000_000,
                ready_at: Some(1_773_579_600_000),
                contract_start_date: Some("2027-07-01"),
                contract_end_date: None,
              ),
              document: Some(
                signing_documents.Row(
                  ..signing_documents.Row(
                    ..base.signing_document(),
                    revision_id: id.signing_revision("spr-1"),
                    kind: signing_documents.Signing,
                  ),
                  evidence_id: id.evidence("vevd-1"),
                  sha256: "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
                ),
              ),
              executed: None,
              parties: [
                signing_revision_parties.Row(
                  ..signing_revision_parties.Row(
                    ..base.signing_party(),
                    revision_id: id.signing_revision("spr-1"),
                    position: 0,
                  ),
                  party_type: signing_party_type.Player,
                  for_entity_id: Some("p1"),
                  for_player_id: Some(id.player("p1")),
                  status: signing_revision_parties.Pending,
                  completed_at: None,
                  method: None,
                ),
                signing_revision_parties.Row(
                  ..signing_revision_parties.Row(
                    ..base.signing_party(),
                    revision_id: id.signing_revision("spr-1"),
                    position: 1,
                  ),
                  party_type: signing_party_type.ClubSignatory,
                  for_entity_id: Some("o1"),
                  for_player_id: Some(id.player("p1")),
                  status: signing_revision_parties.Pending,
                  completed_at: None,
                  method: None,
                ),
              ],
            ),
          ],
        ),
        signing_party_type.Player,
        recruitment_actor_kind.Org,
        "agent-1",
        "spr-1",
        "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
        1_773_583_200_000,
      ),
      base.signing_refusal,
    )
    == Error(
      "{\"error\":\"SIGNING_NOT_PERMITTED\",\"message\":\"You cannot sign for that party.\"}",
    )
}

// signingsAdversarial: canStart — [neg] H2 a guardian recipient cannot open a package in a known or an unknown jurisdiction
pub fn neg_h2_a_guardian_recipient_cannot_open_a_package_in_a_known_or_an_unkno_test() {
  assert result.map_error(
      signing_rules.can_start(
        signing_rules.StartFacts(
          offer_status: Some(offer_status.Accepted),
          offer_revision_status: Some(offer_status.Accepted),
          case_status: Some(room_status.OfferAccepted),
          recipient: Some("guardian"),
          jurisdiction: "ENG",
          existing: [],
        ),
        1_773_576_000_000,
      ),
      base.signing_refusal,
    )
    == Error(
      "{\"error\":\"SIGNING_PATHWAY_CLOSED\",\"message\":\"Signing for a player under the age of majority is not open in this jurisdiction.\"}",
    )
}

// signingsAdversarial: canStart — [neg] H2 a guardian recipient cannot open a package in a known or an unknown jurisdiction
pub fn neg_h2_a_guardian_recipient_cannot_open_a_package_in_a_known_or_an_unkno_2_test() {
  assert result.map_error(
      signing_rules.can_start(
        signing_rules.StartFacts(
          offer_status: Some(offer_status.Accepted),
          offer_revision_status: Some(offer_status.Accepted),
          case_status: Some(room_status.OfferAccepted),
          recipient: Some("guardian"),
          jurisdiction: "ZZ",
          existing: [],
        ),
        1_773_576_000_000,
      ),
      base.signing_refusal,
    )
    == Error(
      "{\"error\":\"SIGNING_PATHWAY_CLOSED\",\"message\":\"Signing for a player under the age of majority is not open in this jurisdiction.\"}",
    )
}

// signingsAdversarial: signingConsistency — [neg] P15 (pure) a completion that names a row id the store does not hold for it → COMPLETION_ROW_MISMATCH
pub fn neg_p15_pure_a_completion_that_names_a_row_id_the_store_does_not_hold_fo_test() {
  assert signing_rules.consistency(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..signing_packages.Row(
            ..base.signing_package().row,
            id: id.signing_package("x"),
            org_id: id.org("o"),
            player_id: id.player("p"),
            case_id: id.recruitment_case("c"),
            offer_id: id.offer("f"),
            offer_revision_id: "r",
            status: signing_packages.Completed,
          ),
          completion_signing_id: Some(id.signing("s1")),
          completion_completed_at: Some(1_773_576_000_000),
        ),
        revisions: [],
      ),
      None,
      None,
      [
        signings.Row(
          ..signings.new(
            id: id.signing("s2"),
            player_id: id.player("pl-base"),
            org_id: id.org("org-base"),
            ts: 0,
          ),
          signing_package_id: Some(id.signing_package("x")),
        ),
      ],
      None,
      1_773_576_000_000,
    )
    == ["COMPLETION_ROW_MISMATCH"]
}

// signingsAdversarial: signingCorrupt — [neg] P15 (pure) a completion that names a row id the store does not hold for it → COMPLETION_ROW_MISMATCH
pub fn neg_p15_pure_a_completion_that_names_a_row_id_the_store_does_not_hold_fo_2_test() {
  assert signing_rules.corrupt(["COMPLETION_ROW_MISMATCH"]) == True
}

// signingsAdversarial: signingIntegrity — [neg] S4 an expiry no act could have set (400 days out) is corruption — a package cannot be made immortal by editing the store
pub fn neg_s4_an_expiry_no_act_could_have_set_400_days_out_is_corruption_a_pack_test() {
  assert signing_rules.integrity(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-s"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.Ready,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_808_136_000_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-s"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.Ready,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
            ],
          ),
        ],
      ),
      None,
    )
    == ["expiry_beyond_max"]
}

// signingsAdversarial: signingIntegrity — [neg] S5 expiry before creation
pub fn neg_s5_expiry_before_creation_test() {
  assert signing_rules.integrity(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-s"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.Ready,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_773_575_999_999),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-s"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.Ready,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
            ],
          ),
        ],
      ),
      None,
    )
    == ["expiry_before_created"]
}

// signingsAdversarial: signingIntegrity — [neg] S7 a revision created before its package
pub fn neg_s7_a_revision_created_before_its_package_test() {
  assert signing_rules.integrity(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-s"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.Ready,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-s"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.Ready,
              created_at: 1_773_575_999_999,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
            ],
          ),
        ],
      ),
      None,
    )
    == ["revision_before_package"]
}

// signingsAdversarial: signingIntegrity — [neg] S8 presented before created
pub fn neg_s8_presented_before_created_test() {
  assert signing_rules.integrity(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-s"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.Ready,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-s"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.Ready,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_575_999_999),
              contract_start_date: Some("2027-07-01"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
            ],
          ),
        ],
      ),
      None,
    )
    == ["ready_before_created"]
}

// signingsAdversarial: signingIntegrity — [neg] S9 an impossible contract day on the record is corruption
pub fn neg_s9_an_impossible_contract_day_on_the_record_is_corruption_test() {
  assert signing_rules.integrity(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-s"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.Ready,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-s"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.Ready,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-02-30"),
              contract_end_date: None,
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
            ],
          ),
        ],
      ),
      None,
    )
    == ["contract_dates"]
}

// signingsAdversarial: signingIntegrity — [neg] S9 an impossible contract day on the record is corruption
pub fn neg_s9_an_impossible_contract_day_on_the_record_is_corruption_2_test() {
  assert signing_rules.integrity(
      signing_rules.Package(
        ..base.signing_package(),
        row: signing_packages.Row(
          ..base.signing_package().row,
          id: id.signing_package("spk-s"),
          org_id: id.org("o1"),
          player_id: id.player("p1"),
          case_id: id.recruitment_case("c1"),
          offer_id: id.offer("rof-1"),
          offer_revision_id: "rofr-1",
          status: signing_packages.Ready,
          current_revision_id: id.signing_revision("spr-1"),
          created_at: 1_773_576_000_000,
          expires_at: Some(1_774_180_800_000),
        ),
        revisions: [
          signing_rules.Revision(
            row: signing_revisions.Row(
              ..signing_revisions.Row(
                ..base.signing_revision(),
                id: id.signing_revision("spr-1"),
                package_id: id.signing_package("spk-s"),
                position: 0,
              ),
              revision_number: 1,
              status: signing_revisions.Ready,
              created_at: 1_773_576_000_000,
              ready_at: Some(1_773_579_600_000),
              contract_start_date: Some("2027-01-01"),
              contract_end_date: Some("2026-01-01"),
            ),
            document: Some(
              signing_documents.Row(
                ..signing_documents.Row(
                  ..base.signing_document(),
                  revision_id: id.signing_revision("spr-1"),
                  kind: signing_documents.Signing,
                ),
                evidence_id: id.evidence("vevd-1"),
                sha256: "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
              ),
            ),
            executed: None,
            parties: [
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 0,
                ),
                party_type: signing_party_type.Player,
                for_entity_id: Some("p1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
              signing_revision_parties.Row(
                ..signing_revision_parties.Row(
                  ..base.signing_party(),
                  revision_id: id.signing_revision("spr-1"),
                  position: 1,
                ),
                party_type: signing_party_type.ClubSignatory,
                for_entity_id: Some("o1"),
                for_player_id: Some(id.player("p1")),
                status: signing_revision_parties.Pending,
                completed_at: None,
                method: None,
              ),
            ],
          ),
        ],
      ),
      None,
    )
    == []
}

// signingsAdversarial: canStart — [neg] ZC an issued Offer cannot open a package (pure)
pub fn neg_zc_an_issued_offer_cannot_open_a_package_pure_test() {
  assert result.map_error(
      signing_rules.can_start(
        signing_rules.StartFacts(
          offer_status: Some(offer_status.Issued),
          offer_revision_status: Some(offer_status.Issued),
          case_status: Some(room_status.OfferMade),
          recipient: Some("player"),
          jurisdiction: "GB",
          existing: [],
        ),
        1_773_576_000_000,
      ),
      base.signing_refusal,
    )
    == Error(
      "{\"error\":\"SIGNING_OFFER_NOT_ACCEPTED\",\"message\":\"A signing can only be opened over an accepted Offer revision.\"}",
    )
}

// signingsAdversarial: canCompleteParty — [neg] ZF an agent cannot sign as the player
pub fn neg_zf_an_agent_cannot_sign_as_the_player_test() {
  assert result.map_error(
      signing_rules.can_complete_party(
        signing_rules.Package(
          ..base.signing_package(),
          row: signing_packages.Row(
            ..base.signing_package().row,
            id: id.signing_package("x"),
            org_id: id.org("o1"),
            player_id: id.player("p1"),
            status: signing_packages.Ready,
            current_revision_id: id.signing_revision("r"),
            created_at: 1_773_576_000_000,
          ),
          revisions: [
            signing_rules.Revision(
              row: signing_revisions.Row(
                ..signing_revisions.Row(
                  ..base.signing_revision(),
                  id: id.signing_revision("r"),
                  package_id: id.signing_package("x"),
                  position: 0,
                ),
                status: signing_revisions.Ready,
                ready_at: Some(1_773_576_000_000),
              ),
              document: Some(
                signing_documents.Row(
                  ..signing_documents.Row(
                    ..base.signing_document(),
                    revision_id: id.signing_revision("r"),
                    kind: signing_documents.Signing,
                  ),
                  sha256: "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
                ),
              ),
              executed: None,
              parties: [
                signing_revision_parties.Row(
                  ..signing_revision_parties.Row(
                    ..base.signing_party(),
                    revision_id: id.signing_revision("r"),
                    position: 0,
                  ),
                  party_type: signing_party_type.Player,
                  for_entity_id: Some("p1"),
                  for_player_id: Some(id.player("p1")),
                  status: signing_revision_parties.Pending,
                  completed_at: None,
                  method: None,
                ),
                signing_revision_parties.Row(
                  ..signing_revision_parties.Row(
                    ..base.signing_party(),
                    revision_id: id.signing_revision("r"),
                    position: 1,
                  ),
                  party_type: signing_party_type.ClubSignatory,
                  for_entity_id: Some("o1"),
                  for_player_id: Some(id.player("p1")),
                  status: signing_revision_parties.Pending,
                  completed_at: None,
                  method: None,
                ),
              ],
            ),
          ],
        ),
        signing_party_type.Player,
        recruitment_actor_kind.Org,
        "agent",
        "r",
        "cfaff94074f7141323ab83b39e5114812354c42f75c20d8a0883521f07a59b86",
        1_773_576_000_001,
      ),
      base.signing_refusal,
    )
    == Error(
      "{\"error\":\"SIGNING_NOT_PERMITTED\",\"message\":\"You cannot sign for that party.\"}",
    )
}
