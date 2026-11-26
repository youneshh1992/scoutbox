//// Checks of the rules from the rules suites of recruitment/journey, recruitment/journeyAdversarial, first generated
//// from the TypeScript server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import gleam/json
import gleam/option.{None, Some}
import scoutbox/battery/base
import scoutbox/recruitment/contact_rules
import scoutbox/recruitment/decisions
import scoutbox/recruitment/journey_model
import scoutbox/recruitment/offer_rules
import scoutbox/recruitment/room_records
import scoutbox/recruitment/signing_rules
import scoutbox/recruitment/trial_rules
import scoutbox/rows/assessments
import scoutbox/rows/id
import scoutbox/rows/offer_revisions
import scoutbox/rows/recruitment_contacts
import scoutbox/rows/recruitment_offers
import scoutbox/rows/recruitment_requests
import scoutbox/rows/room_decisions
import scoutbox/rows/signing_packages
import scoutbox/rows/signing_revisions
import scoutbox/rows/trial_schedule_sessions
import scoutbox/rows/trials
import scoutbox/vocab/offer_status
import scoutbox/vocab/room_status
import scoutbox/vocab/trial_workflow_state

// journey: canonicalStageFor — A4 stage refinements: assessed → decision, package → signing, hold → paused, terminal → ended
pub fn a4_stage_refinements_assessed_decision_package_signing_hold_paused_termi_test() {
  assert journey_model.stage_of(room_status.TrialCompleted, False, False)
    == "assessment"
}

// journey: canonicalStageFor — A4 stage refinements: assessed → decision, package → signing, hold → paused, terminal → ended
pub fn a4_stage_refinements_assessed_decision_package_signing_hold_paused_termi_2_test() {
  assert journey_model.stage_of(room_status.TrialCompleted, True, False)
    == "decision"
}

// journey: canonicalStageFor — A4 stage refinements: assessed → decision, package → signing, hold → paused, terminal → ended
pub fn a4_stage_refinements_assessed_decision_package_signing_hold_paused_termi_3_test() {
  assert journey_model.stage_of(room_status.OfferAccepted, False, False)
    == "acceptance"
}

// journey: canonicalStageFor — A4 stage refinements: assessed → decision, package → signing, hold → paused, terminal → ended
pub fn a4_stage_refinements_assessed_decision_package_signing_hold_paused_termi_4_test() {
  assert journey_model.stage_of(room_status.OfferAccepted, False, True)
    == "signing"
}

// journey: canonicalStageFor — A4 stage refinements: assessed → decision, package → signing, hold → paused, terminal → ended
pub fn a4_stage_refinements_assessed_decision_package_signing_hold_paused_termi_5_test() {
  assert journey_model.stage_of(room_status.OnHold, False, False) == "paused"
}

// journey: canonicalStageFor — A4 stage refinements: assessed → decision, package → signing, hold → paused, terminal → ended
pub fn a4_stage_refinements_assessed_decision_package_signing_hold_paused_termi_6_test() {
  assert journey_model.stage_of(room_status.Archived, False, False) == "ended"
}

// journey: currentSigningForOffer — [neg] #53 A6 a live package is current whatever its storage order; the expired one never masks it
pub fn neg_53_a6_a_live_package_is_current_whatever_its_storage_order_the_expir_test() {
  assert option.map(
      journey_model.current_signing(
        [
          signing_rules.Package(
            ..base.signing_package(),
            row: signing_packages.Row(
              ..base.signing_package().row,
              id: id.signing_package("spk-old"),
              status: signing_packages.Ready,
              created_at: 1_793_880_000_000,
              expires_at: Some(1_794_312_000_000),
              current_revision_id: id.signing_revision("spk-old-r1"),
            ),
            revisions: [
              signing_rules.Revision(
                row: signing_revisions.Row(
                  ..signing_revisions.Row(
                    ..base.signing_revision(),
                    id: id.signing_revision("spk-old-r1"),
                    package_id: id.signing_package("spk-old"),
                    position: 0,
                  ),
                  revision_number: 1,
                  status: signing_revisions.Ready,
                ),
                document: None,
                executed: None,
                parties: [],
              ),
            ],
          ),
          signing_rules.Package(
            ..base.signing_package(),
            row: signing_packages.Row(
              ..base.signing_package().row,
              id: id.signing_package("spk-new"),
              status: signing_packages.Ready,
              created_at: 1_794_657_600_000,
              expires_at: Some(1_795_176_000_000),
              current_revision_id: id.signing_revision("spk-new-r1"),
            ),
            revisions: [
              signing_rules.Revision(
                row: signing_revisions.Row(
                  ..signing_revisions.Row(
                    ..base.signing_revision(),
                    id: id.signing_revision("spk-new-r1"),
                    package_id: id.signing_package("spk-new"),
                    position: 0,
                  ),
                  revision_number: 1,
                  status: signing_revisions.Ready,
                ),
                document: None,
                executed: None,
                parties: [],
              ),
            ],
          ),
        ],
        1_794_744_000_000,
      ),
      fn(x) { x.row.id },
    )
    == Some(id.signing_package("spk-new"))
}

// journey: currentSigningForOffer — [neg] #53 A6 a live package is current whatever its storage order; the expired one never masks it
pub fn neg_53_a6_a_live_package_is_current_whatever_its_storage_order_the_expir_2_test() {
  assert option.map(
      journey_model.current_signing(
        [
          signing_rules.Package(
            ..base.signing_package(),
            row: signing_packages.Row(
              ..base.signing_package().row,
              id: id.signing_package("spk-new"),
              status: signing_packages.Ready,
              created_at: 1_794_657_600_000,
              expires_at: Some(1_795_176_000_000),
              current_revision_id: id.signing_revision("spk-new-r1"),
            ),
            revisions: [
              signing_rules.Revision(
                row: signing_revisions.Row(
                  ..signing_revisions.Row(
                    ..base.signing_revision(),
                    id: id.signing_revision("spk-new-r1"),
                    package_id: id.signing_package("spk-new"),
                    position: 0,
                  ),
                  revision_number: 1,
                  status: signing_revisions.Ready,
                ),
                document: None,
                executed: None,
                parties: [],
              ),
            ],
          ),
          signing_rules.Package(
            ..base.signing_package(),
            row: signing_packages.Row(
              ..base.signing_package().row,
              id: id.signing_package("spk-old"),
              status: signing_packages.Ready,
              created_at: 1_793_880_000_000,
              expires_at: Some(1_794_312_000_000),
              current_revision_id: id.signing_revision("spk-old-r1"),
            ),
            revisions: [
              signing_rules.Revision(
                row: signing_revisions.Row(
                  ..signing_revisions.Row(
                    ..base.signing_revision(),
                    id: id.signing_revision("spk-old-r1"),
                    package_id: id.signing_package("spk-old"),
                    position: 0,
                  ),
                  revision_number: 1,
                  status: signing_revisions.Ready,
                ),
                document: None,
                executed: None,
                parties: [],
              ),
            ],
          ),
        ],
        1_794_744_000_000,
      ),
      fn(x) { x.row.id },
    )
    == Some(id.signing_package("spk-new"))
}

// journey: currentSigningForOffer — A7 live → completed → newest terminal → null
pub fn a7_live_completed_newest_terminal_null_test() {
  assert option.map(
      journey_model.current_signing(
        [
          signing_rules.Package(
            ..base.signing_package(),
            row: signing_packages.Row(
              ..base.signing_package().row,
              id: id.signing_package("spk-old"),
              status: signing_packages.Ready,
              created_at: 1_793_880_000_000,
              expires_at: Some(1_794_312_000_000),
              current_revision_id: id.signing_revision("spk-old-r1"),
            ),
            revisions: [
              signing_rules.Revision(
                row: signing_revisions.Row(
                  ..signing_revisions.Row(
                    ..base.signing_revision(),
                    id: id.signing_revision("spk-old-r1"),
                    package_id: id.signing_package("spk-old"),
                    position: 0,
                  ),
                  revision_number: 1,
                  status: signing_revisions.Ready,
                ),
                document: None,
                executed: None,
                parties: [],
              ),
            ],
          ),
          signing_rules.Package(
            ..base.signing_package(),
            row: signing_packages.Row(
              ..base.signing_package().row,
              id: id.signing_package("spk-done"),
              status: signing_packages.Completed,
              created_at: 1_794_484_800_000,
              expires_at: None,
              current_revision_id: id.signing_revision("spk-done-r1"),
            ),
            revisions: [
              signing_rules.Revision(
                row: signing_revisions.Row(
                  ..signing_revisions.Row(
                    ..base.signing_revision(),
                    id: id.signing_revision("spk-done-r1"),
                    package_id: id.signing_package("spk-done"),
                    position: 0,
                  ),
                  revision_number: 1,
                  status: signing_revisions.Completed,
                ),
                document: None,
                executed: None,
                parties: [],
              ),
            ],
          ),
        ],
        1_794_744_000_000,
      ),
      fn(x) { x.row.id },
    )
    == Some(id.signing_package("spk-done"))
}

// journey: currentSigningForOffer — A7 live → completed → newest terminal → null
pub fn a7_live_completed_newest_terminal_null_2_test() {
  assert option.map(
      journey_model.current_signing(
        [
          signing_rules.Package(
            ..base.signing_package(),
            row: signing_packages.Row(
              ..base.signing_package().row,
              id: id.signing_package("spk-old"),
              status: signing_packages.Ready,
              created_at: 1_793_880_000_000,
              expires_at: Some(1_794_312_000_000),
              current_revision_id: id.signing_revision("spk-old-r1"),
            ),
            revisions: [
              signing_rules.Revision(
                row: signing_revisions.Row(
                  ..signing_revisions.Row(
                    ..base.signing_revision(),
                    id: id.signing_revision("spk-old-r1"),
                    package_id: id.signing_package("spk-old"),
                    position: 0,
                  ),
                  revision_number: 1,
                  status: signing_revisions.Ready,
                ),
                document: None,
                executed: None,
                parties: [],
              ),
            ],
          ),
        ],
        1_794_744_000_000,
      ),
      fn(x) { x.row.id },
    )
    == Some(id.signing_package("spk-old"))
}

// journey: currentSigningForOffer — A7 live → completed → newest terminal → null
pub fn a7_live_completed_newest_terminal_null_3_test() {
  assert option.map(journey_model.current_signing([], 1_794_744_000_000), fn(x) {
      x.row.id
    })
    == None
}

// journey: currentContactForCase — A8 the current Contact: delivered over answered over draft; cancelled never
pub fn a8_the_current_contact_delivered_over_answered_over_draft_cancelled_neve_test() {
  assert option.map(
      journey_model.current_contact([
        contact_rules.Contact(
          ..base.contact(),
          row: recruitment_contacts.Row(
            ..base.contact().row,
            id: id.contact("c1"),
            status: recruitment_contacts.Responded,
            created_at: 1,
            delivered_at: Some(1),
            responded_at: Some(2),
            updated_at: 1,
          ),
        ),
        contact_rules.Contact(
          ..base.contact(),
          row: recruitment_contacts.Row(
            ..base.contact().row,
            id: id.contact("c2"),
            status: recruitment_contacts.Delivered,
            created_at: 2,
            delivered_at: Some(2),
            updated_at: 2,
          ),
        ),
        contact_rules.Contact(
          ..base.contact(),
          row: recruitment_contacts.Row(
            ..base.contact().row,
            id: id.contact("c3"),
            status: recruitment_contacts.Draft,
            created_at: 3,
            updated_at: 3,
          ),
        ),
      ]),
      fn(x) { x.row.id },
    )
    == Some(id.contact("c2"))
}

// journey: currentContactForCase — A8 the current Contact: delivered over answered over draft; cancelled never
pub fn a8_the_current_contact_delivered_over_answered_over_draft_cancelled_neve_2_test() {
  assert option.map(
      journey_model.current_contact([
        contact_rules.Contact(
          ..base.contact(),
          row: recruitment_contacts.Row(
            ..base.contact().row,
            id: id.contact("c1"),
            status: recruitment_contacts.Responded,
            created_at: 1,
            delivered_at: Some(1),
            responded_at: Some(2),
            updated_at: 1,
          ),
        ),
        contact_rules.Contact(
          ..base.contact(),
          row: recruitment_contacts.Row(
            ..base.contact().row,
            id: id.contact("c3"),
            status: recruitment_contacts.Draft,
            created_at: 3,
            updated_at: 3,
          ),
        ),
      ]),
      fn(x) { x.row.id },
    )
    == Some(id.contact("c1"))
}

// journey: currentContactForCase — A8 the current Contact: delivered over answered over draft; cancelled never
pub fn a8_the_current_contact_delivered_over_answered_over_draft_cancelled_neve_3_test() {
  assert option.map(
      journey_model.current_contact([
        contact_rules.Contact(
          ..base.contact(),
          row: recruitment_contacts.Row(
            ..base.contact().row,
            id: id.contact("c4"),
            status: recruitment_contacts.Cancelled,
            created_at: 9,
            updated_at: 9,
          ),
        ),
      ]),
      fn(x) { x.row.id },
    )
    == None
}

// journey: currentTrialForCase — A9 the current Trial: live over completed over cancelled
pub fn a9_the_current_trial_live_over_completed_over_cancelled_test() {
  assert option.map(
      journey_model.current_trial([
        trial_rules.Trial(
          ..base.trial(),
          row: trials.Row(
            ..base.trial().row,
            id: id.trial("t1"),
            accepted_at: 1,
            workflow_state: trial_workflow_state.Completed,
            schedule_revision: Some(1),
            schedule_confirmed_at: Some(1),
            completion_state: Some(trials.Completed),
            completion_at: Some(3),
          ),
          sessions: [
            trial_rules.Session(
              row: trial_schedule_sessions.Row(
                ..base.trial_session(),
                position: 0,
                id: id.trial_session("s"),
                starts_at: 1,
                ends_at: 3_600_001,
              ),
              evidence: [],
            ),
          ],
        ),
        trial_rules.Trial(
          ..base.trial(),
          row: trials.Row(
            ..base.trial().row,
            id: id.trial("t2"),
            accepted_at: 5,
            workflow_state: trial_workflow_state.Cancelled,
            completion_state: Some(trials.Cancelled),
            completion_at: Some(7),
          ),
          sessions: [],
        ),
        trial_rules.Trial(
          ..base.trial(),
          row: trials.Row(
            ..base.trial().row,
            id: id.trial("t3"),
            accepted_at: 3,
            workflow_state: trial_workflow_state.Scheduled,
            schedule_revision: Some(1),
            schedule_confirmed_at: Some(3),
          ),
          sessions: [
            trial_rules.Session(
              row: trial_schedule_sessions.Row(
                ..base.trial_session(),
                position: 0,
                id: id.trial_session("s"),
                starts_at: 3,
                ends_at: 3_600_003,
              ),
              evidence: [],
            ),
          ],
        ),
      ]),
      fn(x) { x.row.id },
    )
    == Some(id.trial("t3"))
}

// journey: currentTrialForCase — A9 the current Trial: live over completed over cancelled
pub fn a9_the_current_trial_live_over_completed_over_cancelled_2_test() {
  assert option.map(
      journey_model.current_trial([
        trial_rules.Trial(
          ..base.trial(),
          row: trials.Row(
            ..base.trial().row,
            id: id.trial("t1"),
            accepted_at: 1,
            workflow_state: trial_workflow_state.Completed,
            schedule_revision: Some(1),
            schedule_confirmed_at: Some(1),
            completion_state: Some(trials.Completed),
            completion_at: Some(3),
          ),
          sessions: [
            trial_rules.Session(
              row: trial_schedule_sessions.Row(
                ..base.trial_session(),
                position: 0,
                id: id.trial_session("s"),
                starts_at: 1,
                ends_at: 3_600_001,
              ),
              evidence: [],
            ),
          ],
        ),
        trial_rules.Trial(
          ..base.trial(),
          row: trials.Row(
            ..base.trial().row,
            id: id.trial("t2"),
            accepted_at: 5,
            workflow_state: trial_workflow_state.Cancelled,
            completion_state: Some(trials.Cancelled),
            completion_at: Some(7),
          ),
          sessions: [],
        ),
      ]),
      fn(x) { x.row.id },
    )
    == Some(id.trial("t1"))
}

// journey: currentOfferForCase — A10 the current Offer: live over accepted over the rest; the LIVE revision, never a superseded one
pub fn a10_the_current_offer_live_over_accepted_over_the_rest_the_live_revision_test() {
  assert option.map(
      journey_model.current_offer(
        [
          {
            let o =
              offer_rules.Offer(
                ..base.offer(),
                row: recruitment_offers.Row(
                  ..base.offer().row,
                  id: id.offer("rof-c"),
                  current_revision_id: id.offer_revision("rc1"),
                ),
                revisions: [
                  offer_rules.Revision(
                    row: offer_revisions.Row(
                      ..base.offer_revision(),
                      id: id.offer_revision("rc1"),
                      revision_number: 1,
                      status: offer_status.Declined,
                      issued_at: Some(9),
                      expires_at: Some(1_795_608_000_000),
                    ),
                    documents: [],
                  ),
                ],
                responses: [],
              )
            offer_rules.Offer(
              ..o,
              row: recruitment_offers.Row(..o.row, updated_at: 9, created_at: 9),
            )
          },
          {
            let o =
              offer_rules.Offer(
                ..base.offer(),
                row: recruitment_offers.Row(
                  ..base.offer().row,
                  id: id.offer("rof-a"),
                  current_revision_id: id.offer_revision("ra1"),
                ),
                revisions: [
                  offer_rules.Revision(
                    row: offer_revisions.Row(
                      ..base.offer_revision(),
                      id: id.offer_revision("ra1"),
                      revision_number: 1,
                      status: offer_status.Accepted,
                      issued_at: Some(1),
                      expires_at: Some(1_795_608_000_000),
                    ),
                    documents: [],
                  ),
                ],
                responses: [],
              )
            offer_rules.Offer(
              ..o,
              row: recruitment_offers.Row(..o.row, updated_at: 1, created_at: 1),
            )
          },
          {
            let o =
              offer_rules.Offer(
                ..base.offer(),
                row: recruitment_offers.Row(
                  ..base.offer().row,
                  id: id.offer("rof-b"),
                  current_revision_id: id.offer_revision("rb2"),
                ),
                revisions: [
                  offer_rules.Revision(
                    row: offer_revisions.Row(
                      ..base.offer_revision(),
                      id: id.offer_revision("rb1"),
                      revision_number: 1,
                      status: offer_status.Superseded,
                      issued_at: Some(2),
                      expires_at: Some(1_795_608_000_000),
                    ),
                    documents: [],
                  ),
                  offer_rules.Revision(
                    row: offer_revisions.Row(
                      ..base.offer_revision(),
                      id: id.offer_revision("rb2"),
                      revision_number: 2,
                      status: offer_status.Issued,
                      issued_at: Some(3),
                      expires_at: Some(1_795_608_000_000),
                    ),
                    documents: [],
                  ),
                ],
                responses: [],
              )
            offer_rules.Offer(
              ..o,
              row: recruitment_offers.Row(..o.row, updated_at: 3, created_at: 3),
            )
          },
        ],
        1_794_744_000_000,
      ),
      journey_model.next_offer(_, 1_794_744_000_000),
    )
    == Some(journey_model.NextOffer(
      id: id.offer("rof-b"),
      revision: Some(id.offer_revision("rb2")),
      status: Some(offer_status.Issued),
      live_status: Some(offer_status.Issued),
    ))
}

// journey: currentOfferForCase — A10 the current Offer: live over accepted over the rest; the LIVE revision, never a superseded one
pub fn a10_the_current_offer_live_over_accepted_over_the_rest_the_live_revision_2_test() {
  assert option.map(
      journey_model.current_offer(
        [
          {
            let o =
              offer_rules.Offer(
                ..base.offer(),
                row: recruitment_offers.Row(
                  ..base.offer().row,
                  id: id.offer("rof-c"),
                  current_revision_id: id.offer_revision("rc1"),
                ),
                revisions: [
                  offer_rules.Revision(
                    row: offer_revisions.Row(
                      ..base.offer_revision(),
                      id: id.offer_revision("rc1"),
                      revision_number: 1,
                      status: offer_status.Declined,
                      issued_at: Some(9),
                      expires_at: Some(1_795_608_000_000),
                    ),
                    documents: [],
                  ),
                ],
                responses: [],
              )
            offer_rules.Offer(
              ..o,
              row: recruitment_offers.Row(..o.row, updated_at: 9, created_at: 9),
            )
          },
          {
            let o =
              offer_rules.Offer(
                ..base.offer(),
                row: recruitment_offers.Row(
                  ..base.offer().row,
                  id: id.offer("rof-a"),
                  current_revision_id: id.offer_revision("ra1"),
                ),
                revisions: [
                  offer_rules.Revision(
                    row: offer_revisions.Row(
                      ..base.offer_revision(),
                      id: id.offer_revision("ra1"),
                      revision_number: 1,
                      status: offer_status.Accepted,
                      issued_at: Some(1),
                      expires_at: Some(1_795_608_000_000),
                    ),
                    documents: [],
                  ),
                ],
                responses: [],
              )
            offer_rules.Offer(
              ..o,
              row: recruitment_offers.Row(..o.row, updated_at: 1, created_at: 1),
            )
          },
        ],
        1_794_744_000_000,
      ),
      journey_model.next_offer(_, 1_794_744_000_000),
    )
    == Some(journey_model.NextOffer(
      id: id.offer("rof-a"),
      revision: Some(id.offer_revision("ra1")),
      status: Some(offer_status.Accepted),
      live_status: Some(offer_status.Accepted),
    ))
}

// journey: currentOfferForCase — A10 the current Offer: live over accepted over the rest; the LIVE revision, never a superseded one
pub fn a10_the_current_offer_live_over_accepted_over_the_rest_the_live_revision_3_test() {
  assert option.map(
      journey_model.current_offer(
        [
          {
            let o =
              offer_rules.Offer(
                ..base.offer(),
                row: recruitment_offers.Row(
                  ..base.offer().row,
                  id: id.offer("rof-c"),
                  current_revision_id: id.offer_revision("rc1"),
                ),
                revisions: [
                  offer_rules.Revision(
                    row: offer_revisions.Row(
                      ..base.offer_revision(),
                      id: id.offer_revision("rc1"),
                      revision_number: 1,
                      status: offer_status.Declined,
                      issued_at: Some(9),
                      expires_at: Some(1_795_608_000_000),
                    ),
                    documents: [],
                  ),
                ],
                responses: [],
              )
            offer_rules.Offer(
              ..o,
              row: recruitment_offers.Row(..o.row, updated_at: 9, created_at: 9),
            )
          },
        ],
        1_794_744_000_000,
      ),
      journey_model.next_offer(_, 1_794_744_000_000),
    )
    == Some(journey_model.NextOffer(
      id: id.offer("rof-c"),
      revision: Some(id.offer_revision("rc1")),
      status: Some(offer_status.Declined),
      live_status: Some(offer_status.Declined),
    ))
}

// journey: currentDecisionForCase — A11 the current decision: the formal head, else the advisory head, never a draft or a superseded row
pub fn a11_the_current_decision_the_formal_head_else_the_advisory_head_never_a_test() {
  assert option.map(
      journey_model.current_decision([
        decisions.Decision(
          base: room_records.Decision(
            row: room_decisions.Row(
              ..base.decision().base.row,
              id: id.room_decision("d1"),
              kind: Some(room_decisions.Formal),
              state: Some(room_decisions.Final),
              created_at: 1,
              superseded_by_id: Some(id.room_decision("d2")),
            ),
            reason_codes: [],
            snapshot: None,
          ),
          refs: [],
          assessment_ids: [],
        ),
        decisions.Decision(
          base: room_records.Decision(
            row: room_decisions.Row(
              ..base.decision().base.row,
              id: id.room_decision("d2"),
              kind: Some(room_decisions.Formal),
              state: Some(room_decisions.Final),
              created_at: 2,
              superseded_by_id: None,
            ),
            reason_codes: [],
            snapshot: None,
          ),
          refs: [],
          assessment_ids: [],
        ),
        decisions.Decision(
          base: room_records.Decision(
            row: room_decisions.Row(
              ..base.decision().base.row,
              id: id.room_decision("d3"),
              kind: Some(room_decisions.Recommendation),
              state: Some(room_decisions.Final),
              created_at: 3,
              superseded_by_id: None,
            ),
            reason_codes: [],
            snapshot: None,
          ),
          refs: [],
          assessment_ids: [],
        ),
      ]),
      fn(d) { d.base.row.id },
    )
    == Some(id.room_decision("d2"))
}

// journey: currentDecisionForCase — A11 the current decision: the formal head, else the advisory head, never a draft or a superseded row
pub fn a11_the_current_decision_the_formal_head_else_the_advisory_head_never_a_2_test() {
  assert option.map(
      journey_model.current_decision([
        decisions.Decision(
          base: room_records.Decision(
            row: room_decisions.Row(
              ..base.decision().base.row,
              id: id.room_decision("d3"),
              kind: Some(room_decisions.Recommendation),
              state: Some(room_decisions.Final),
              created_at: 3,
              superseded_by_id: None,
            ),
            reason_codes: [],
            snapshot: None,
          ),
          refs: [],
          assessment_ids: [],
        ),
      ]),
      fn(d) { d.base.row.id },
    )
    == Some(id.room_decision("d3"))
}

// journey: currentDecisionForCase — A11 the current decision: the formal head, else the advisory head, never a draft or a superseded row
pub fn a11_the_current_decision_the_formal_head_else_the_advisory_head_never_a_3_test() {
  assert option.map(
      journey_model.current_decision([
        decisions.Decision(
          base: room_records.Decision(
            row: room_decisions.Row(
              ..base.decision().base.row,
              id: id.room_decision("x"),
              kind: Some(room_decisions.Formal),
              state: Some(room_decisions.Draft),
              created_at: 9,
            ),
            reason_codes: [],
            snapshot: None,
          ),
          refs: [],
          assessment_ids: [],
        ),
      ]),
      fn(d) { d.base.row.id },
    )
    == None
}

// journey: playerNextActionFor — A23 the player's action is the most consequential pending act
pub fn a23_the_player_s_action_is_the_most_consequential_pending_act_test() {
  assert json.to_string({
      let #(code, refs) =
        journey_model.player_next(
          Some(id.signing_package("s")),
          Some(#(id.offer("o"), Some(id.offer_revision("r")))),
          None,
          None,
          None,
        )
      json.object([
        #("code", json.string(code)),
        #("resources", json.object(refs)),
      ])
    })
    == "{\"code\":\"SIGN\",\"resources\":{\"signingPackageId\":\"s\"}}"
}

// journey: playerNextActionFor — A23 the player's action is the most consequential pending act
pub fn a23_the_player_s_action_is_the_most_consequential_pending_act_2_test() {
  assert json.to_string({
      let #(code, refs) =
        journey_model.player_next(
          None,
          Some(#(id.offer("o"), Some(id.offer_revision("r")))),
          None,
          None,
          Some(id.request("q")),
        )
      json.object([
        #("code", json.string(code)),
        #("resources", json.object(refs)),
      ])
    })
    == "{\"code\":\"RESPOND_TO_OFFER\",\"resources\":{\"offerId\":\"o\",\"offerRevisionId\":\"r\"}}"
}

// journey: playerNextActionFor — A23 the player's action is the most consequential pending act
pub fn a23_the_player_s_action_is_the_most_consequential_pending_act_3_test() {
  assert json.to_string({
      let #(code, refs) =
        journey_model.player_next(
          None,
          None,
          None,
          Some(id.request("q")),
          Some(id.request("q2")),
        )
      json.object([
        #("code", json.string(code)),
        #("resources", json.object(refs)),
      ])
    })
    == "{\"code\":\"RESPOND_TO_TRIAL_INVITATION\",\"resources\":{\"requestId\":\"q\"}}"
}

// journey: playerNextActionFor — A23 the player's action is the most consequential pending act
pub fn a23_the_player_s_action_is_the_most_consequential_pending_act_4_test() {
  assert json.to_string({
      let #(code, refs) =
        journey_model.player_next(None, None, None, None, None)
      json.object([
        #("code", json.string(code)),
        #("resources", json.object(refs)),
      ])
    })
    == "{\"code\":\"NONE\",\"resources\":{}}"
}

// journey: playerStageFor — A24 player stage words come only from records that reached the player
pub fn a24_player_stage_words_come_only_from_records_that_reached_the_player_test() {
  assert journey_model.player_stage(
      ["q"],
      [],
      [],
      None,
      None,
      False,
      1_794_744_000_000,
    )
    == "contacted"
}

// journey: playerStageFor — A24 player stage words come only from records that reached the player
pub fn a24_player_stage_words_come_only_from_records_that_reached_the_player_2_test() {
  assert journey_model.player_stage(
      ["q"],
      [
        recruitment_requests.Row(
          ..base.trial_request(),
          status: recruitment_requests.Pending,
        ),
      ],
      [],
      None,
      None,
      False,
      1_794_744_000_000,
    )
    == "trial_invited"
}

// journey: playerStageFor — A24 player stage words come only from records that reached the player
pub fn a24_player_stage_words_come_only_from_records_that_reached_the_player_3_test() {
  assert journey_model.player_stage(
      [],
      [],
      [],
      Some(offer_status.Issued),
      None,
      False,
      1_794_744_000_000,
    )
    == "offer_received"
}

// journey: playerStageFor — A24 player stage words come only from records that reached the player
pub fn a24_player_stage_words_come_only_from_records_that_reached_the_player_4_test() {
  assert journey_model.player_stage(
      [],
      [],
      [],
      Some(offer_status.Accepted),
      None,
      False,
      1_794_744_000_000,
    )
    == "offer_accepted"
}

// journey: playerStageFor — A24 player stage words come only from records that reached the player
pub fn a24_player_stage_words_come_only_from_records_that_reached_the_player_5_test() {
  assert journey_model.player_stage(
      [],
      [],
      [],
      None,
      None,
      True,
      1_794_744_000_000,
    )
    == "signed"
}

// journey: playerStageFor — A24 player stage words come only from records that reached the player
pub fn a24_player_stage_words_come_only_from_records_that_reached_the_player_6_test() {
  assert journey_model.player_stage(
      [],
      [],
      [],
      None,
      None,
      False,
      1_794_744_000_000,
    )
    == "none"
}

// journey: validateRecruitmentJourney — A27 contacted with no Contact and no claim on the history: legacy (history from before the records existed)
pub fn a27_contacted_with_no_contact_and_no_claim_on_the_history_legacy_history_test() {
  assert json.to_string(
      journey_model.verdict_json(
        journey_model.validate(journey_model.JourneyFacts(
          status: room_status.Contacted,
          created_at: 10,
          history: [
            base.history_entry(
              0,
              "room_created",
              10,
              Some("{\"status\":\"watching\"}"),
            ),
            base.history_entry(
              1,
              "room_status_changed",
              20,
              Some("{\"from\":\"watching\",\"to\":\"under_review\"}"),
            ),
            base.history_entry(
              2,
              "room_status_changed",
              30,
              Some("{\"from\":\"under_review\",\"to\":\"contacted\"}"),
            ),
          ],
          links_signing_id: option.None,
          contacts: [],
          trials: [],
          trial_requests: [],
          assessments: [],
          decisions: [],
          offers: [],
          packages: [],
          signing_row: None,
          signing_row_ids: [],
          corrupt: 0,
          foreign: [],
          domain_problems: [],
          now: 1_794_744_000_000,
        )),
      ),
    )
    == "{\"ok\":true,\"classification\":\"legacy\",\"problems\":[],\"backed\":0,\"unbacked\":1}"
}

// journey: validateRecruitmentJourney — A28 contacted with a delivered Contact: canonical
pub fn a28_contacted_with_a_delivered_contact_canonical_test() {
  assert json.to_string(
      journey_model.verdict_json(
        journey_model.validate(journey_model.JourneyFacts(
          status: room_status.Contacted,
          created_at: 10,
          history: [
            base.history_entry(
              0,
              "room_created",
              10,
              Some("{\"status\":\"watching\"}"),
            ),
            base.history_entry(
              1,
              "room_status_changed",
              20,
              Some("{\"from\":\"watching\",\"to\":\"under_review\"}"),
            ),
            base.history_entry(
              2,
              "room_status_changed",
              30,
              Some("{\"from\":\"under_review\",\"to\":\"contacted\"}"),
            ),
          ],
          links_signing_id: option.None,
          contacts: [
            contact_rules.Contact(
              ..base.contact(),
              row: recruitment_contacts.Row(
                ..base.contact().row,
                id: id.contact("c"),
                status: recruitment_contacts.Delivered,
                delivered_at: Some(25),
              ),
            ),
          ],
          trials: [],
          trial_requests: [],
          assessments: [],
          decisions: [],
          offers: [],
          packages: [],
          signing_row: None,
          signing_row_ids: [],
          corrupt: 0,
          foreign: [],
          domain_problems: [],
          now: 1_794_744_000_000,
        )),
      ),
    )
    == "{\"ok\":true,\"classification\":\"canonical\",\"problems\":[],\"backed\":1,\"unbacked\":0}"
}

// journey: validateRecruitmentJourney — [neg] #14 A29 contacted with a history entry that CLAIMS a Contact which is gone: integrity_error, STALE_POINTER and LIFECYCLE_AHEAD_OF_EVIDENCE
pub fn neg_14_a29_contacted_with_a_history_entry_that_claims_a_contact_which_is_test() {
  assert json.to_string(
      journey_model.verdict_json(
        journey_model.validate(journey_model.JourneyFacts(
          status: room_status.Contacted,
          created_at: 10,
          history: [
            base.history_entry(
              0,
              "room_created",
              10,
              Some("{\"status\":\"watching\"}"),
            ),
            base.history_entry(
              1,
              "room_status_changed",
              20,
              Some("{\"from\":\"watching\",\"to\":\"under_review\"}"),
            ),
            base.history_entry(
              2,
              "room_status_changed",
              30,
              Some(
                "{\"from\":\"under_review\",\"to\":\"contacted\",\"contactId\":\"rct-gone\",\"trigger\":\"contact:rct-gone\"}",
              ),
            ),
          ],
          links_signing_id: option.None,
          contacts: [],
          trials: [],
          trial_requests: [],
          assessments: [],
          decisions: [],
          offers: [],
          packages: [],
          signing_row: None,
          signing_row_ids: [],
          corrupt: 0,
          foreign: [],
          domain_problems: [],
          now: 1_794_744_000_000,
        )),
      ),
    )
    == "{\"ok\":false,\"classification\":\"integrity_error\",\"problems\":[\"LIFECYCLE_AHEAD_OF_EVIDENCE\",\"STALE_POINTER\"],\"backed\":0,\"unbacked\":0}"
}

// journey: validateRecruitmentJourney — A30 a legacy contact and a canonical Offer: partially_canonical
pub fn a30_a_legacy_contact_and_a_canonical_offer_partially_canonical_test() {
  assert json.to_string(
      journey_model.verdict_json(
        journey_model.validate(journey_model.JourneyFacts(
          status: room_status.OfferMade,
          created_at: 10,
          history: [
            base.history_entry(
              0,
              "room_created",
              10,
              Some("{\"status\":\"watching\"}"),
            ),
            base.history_entry(
              1,
              "room_status_changed",
              20,
              Some("{\"from\":\"watching\",\"to\":\"under_review\"}"),
            ),
            base.history_entry(
              2,
              "room_status_changed",
              30,
              Some("{\"from\":\"under_review\",\"to\":\"contacted\"}"),
            ),
            base.history_entry(
              3,
              "room_status_changed",
              40,
              Some(
                "{\"from\":\"contacted\",\"to\":\"offer_made\",\"offerId\":\"rof-1\",\"trigger\":\"offer:issue:rof-1\"}",
              ),
            ),
          ],
          links_signing_id: option.None,
          contacts: [],
          trials: [],
          trial_requests: [],
          assessments: [],
          decisions: [],
          offers: [
            offer_rules.Offer(
              ..base.offer(),
              row: recruitment_offers.Row(
                ..base.offer().row,
                id: id.offer("rof-1"),
                current_revision_id: id.offer_revision("r"),
              ),
              revisions: [
                offer_rules.Revision(
                  row: offer_revisions.Row(
                    ..base.offer_revision(),
                    id: id.offer_revision("r"),
                    status: offer_status.Issued,
                    issued_at: Some(39),
                    revision_number: 1,
                    expires_at: Some(1_794_830_400_000),
                  ),
                  documents: [],
                ),
              ],
              responses: [],
            ),
          ],
          packages: [],
          signing_row: None,
          signing_row_ids: [],
          corrupt: 0,
          foreign: [],
          domain_problems: [],
          now: 1_794_744_000_000,
        )),
      ),
    )
    == "{\"ok\":true,\"classification\":\"partially_canonical\",\"problems\":[],\"backed\":1,\"unbacked\":1}"
}

// journey: validateRecruitmentJourney — [neg] A32 a foreign reference, an unknown state and a malformed instant are each named
pub fn neg_a32_a_foreign_reference_an_unknown_state_and_a_malformed_instant_are_test() {
  assert json.to_string(
      journey_model.verdict_json(
        journey_model.validate(journey_model.JourneyFacts(
          status: room_status.Contacted,
          created_at: 10,
          history: [
            base.history_entry(
              0,
              "room_created",
              10,
              Some("{\"status\":\"watching\"}"),
            ),
            base.history_entry(
              1,
              "room_status_changed",
              20,
              Some("{\"from\":\"watching\",\"to\":\"under_review\"}"),
            ),
            base.history_entry(
              2,
              "room_status_changed",
              30,
              Some("{\"from\":\"under_review\",\"to\":\"contacted\"}"),
            ),
          ],
          links_signing_id: option.None,
          contacts: [],
          trials: [],
          trial_requests: [],
          assessments: [],
          decisions: [],
          offers: [],
          packages: [],
          signing_row: None,
          signing_row_ids: [],
          corrupt: 0,
          foreign: ["PLAYER_MISMATCH"],
          domain_problems: [],
          now: 1_794_744_000_000,
        )),
      ),
    )
    == "{\"ok\":false,\"classification\":\"integrity_error\",\"problems\":[\"PLAYER_MISMATCH\"],\"backed\":0,\"unbacked\":1}"
}

// journey: completedStagesFor — A33 completed stages carry their basis
pub fn a33_completed_stages_carry_their_basis_test() {
  assert json.to_string(
      json.preprocessed_array(
        journey_model.completed_stages(journey_model.JourneyFacts(
          status: room_status.Contacted,
          created_at: 10,
          history: [
            base.history_entry(
              0,
              "room_created",
              10,
              Some("{\"status\":\"watching\"}"),
            ),
            base.history_entry(
              1,
              "room_status_changed",
              20,
              Some("{\"from\":\"watching\",\"to\":\"under_review\"}"),
            ),
            base.history_entry(
              2,
              "room_status_changed",
              30,
              Some("{\"from\":\"under_review\",\"to\":\"contacted\"}"),
            ),
          ],
          links_signing_id: option.None,
          contacts: [
            contact_rules.Contact(
              ..base.contact(),
              row: recruitment_contacts.Row(
                ..base.contact().row,
                id: id.contact("c"),
                status: recruitment_contacts.Delivered,
                delivered_at: Some(25),
              ),
            ),
          ],
          trials: [],
          trial_requests: [],
          assessments: [],
          decisions: [],
          offers: [],
          packages: [],
          signing_row: None,
          signing_row_ids: [],
          corrupt: 0,
          foreign: [],
          domain_problems: [],
          now: 1_794_744_000_000,
        )),
      ),
    )
    == "[{\"stage\":\"watching\",\"basis\":\"lifecycle\",\"at\":10},{\"stage\":\"review\",\"basis\":\"lifecycle\",\"at\":20},{\"stage\":\"contact\",\"basis\":\"canonical\",\"at\":25,\"contactId\":\"c\"}]"
}

// journey: timelineVisibleTo — [neg] #16 #17 A34 decisions, assessments, drafts and internal moves are club-only; issued Offers and completed signings reach the player and an authorized agent
pub fn neg_16_17_a34_decisions_assessments_drafts_and_internal_moves_are_club_o_test() {
  assert journey_model.visible_to("decision_recorded", "player") == False
}

// journey: timelineVisibleTo — [neg] #16 #17 A34 decisions, assessments, drafts and internal moves are club-only; issued Offers and completed signings reach the player and an authorized agent
pub fn neg_16_17_a34_decisions_assessments_drafts_and_internal_moves_are_club_o_2_test() {
  assert journey_model.visible_to("room_status_changed", "agent") == False
}

// journey: timelineVisibleTo — [neg] #16 #17 A34 decisions, assessments, drafts and internal moves are club-only; issued Offers and completed signings reach the player and an authorized agent
pub fn neg_16_17_a34_decisions_assessments_drafts_and_internal_moves_are_club_o_3_test() {
  assert journey_model.visible_to("offer_issued", "player") == True
}

// journey: timelineVisibleTo — [neg] #16 #17 A34 decisions, assessments, drafts and internal moves are club-only; issued Offers and completed signings reach the player and an authorized agent
pub fn neg_16_17_a34_decisions_assessments_drafts_and_internal_moves_are_club_o_4_test() {
  assert journey_model.visible_to("signing_completed", "agent") == True
}

// journeyAdversarial: currentTrialForCase — F1 two live Trials with one instant: the id decides, in any order
pub fn f1_two_live_trials_with_one_instant_the_id_decides_in_any_order_test() {
  assert option.map(
      journey_model.current_trial([
        trial_rules.Trial(
          ..base.trial(),
          row: trials.Row(
            ..base.trial().row,
            id: id.trial("t1"),
            accepted_at: 1,
            workflow_state: trial_workflow_state.Completed,
            schedule_revision: Some(1),
            schedule_confirmed_at: Some(1),
            completion_state: Some(trials.Completed),
            completion_at: Some(3),
          ),
          sessions: [
            trial_rules.Session(
              row: trial_schedule_sessions.Row(
                ..base.trial_session(),
                position: 0,
                id: id.trial_session("s"),
                starts_at: 1,
                ends_at: 3_600_001,
              ),
              evidence: [],
            ),
          ],
        ),
        trial_rules.Trial(
          ..base.trial(),
          row: trials.Row(
            ..base.trial().row,
            id: id.trial("t2"),
            accepted_at: 3,
            workflow_state: trial_workflow_state.Scheduled,
            schedule_revision: Some(1),
            schedule_confirmed_at: Some(3),
          ),
          sessions: [
            trial_rules.Session(
              row: trial_schedule_sessions.Row(
                ..base.trial_session(),
                position: 0,
                id: id.trial_session("s"),
                starts_at: 3,
                ends_at: 3_600_003,
              ),
              evidence: [],
            ),
          ],
        ),
        trial_rules.Trial(
          ..base.trial(),
          row: trials.Row(
            ..base.trial().row,
            id: id.trial("t3"),
            accepted_at: 3,
            workflow_state: trial_workflow_state.Scheduled,
            schedule_revision: Some(1),
            schedule_confirmed_at: Some(3),
          ),
          sessions: [
            trial_rules.Session(
              row: trial_schedule_sessions.Row(
                ..base.trial_session(),
                position: 0,
                id: id.trial_session("s"),
                starts_at: 3,
                ends_at: 3_600_003,
              ),
              evidence: [],
            ),
          ],
        ),
      ]),
      fn(x) { x.row.id },
    )
    == Some(id.trial("t3"))
}

// journeyAdversarial: currentTrialForCase — F1 two live Trials with one instant: the id decides, in any order
pub fn f1_two_live_trials_with_one_instant_the_id_decides_in_any_order_2_test() {
  assert option.map(
      journey_model.current_trial([
        trial_rules.Trial(
          ..base.trial(),
          row: trials.Row(
            ..base.trial().row,
            id: id.trial("t3"),
            accepted_at: 3,
            workflow_state: trial_workflow_state.Scheduled,
            schedule_revision: Some(1),
            schedule_confirmed_at: Some(3),
          ),
          sessions: [
            trial_rules.Session(
              row: trial_schedule_sessions.Row(
                ..base.trial_session(),
                position: 0,
                id: id.trial_session("s"),
                starts_at: 3,
                ends_at: 3_600_003,
              ),
              evidence: [],
            ),
          ],
        ),
        trial_rules.Trial(
          ..base.trial(),
          row: trials.Row(
            ..base.trial().row,
            id: id.trial("t2"),
            accepted_at: 3,
            workflow_state: trial_workflow_state.Scheduled,
            schedule_revision: Some(1),
            schedule_confirmed_at: Some(3),
          ),
          sessions: [
            trial_rules.Session(
              row: trial_schedule_sessions.Row(
                ..base.trial_session(),
                position: 0,
                id: id.trial_session("s"),
                starts_at: 3,
                ends_at: 3_600_003,
              ),
              evidence: [],
            ),
          ],
        ),
        trial_rules.Trial(
          ..base.trial(),
          row: trials.Row(
            ..base.trial().row,
            id: id.trial("t1"),
            accepted_at: 1,
            workflow_state: trial_workflow_state.Completed,
            schedule_revision: Some(1),
            schedule_confirmed_at: Some(1),
            completion_state: Some(trials.Completed),
            completion_at: Some(3),
          ),
          sessions: [
            trial_rules.Session(
              row: trial_schedule_sessions.Row(
                ..base.trial_session(),
                position: 0,
                id: id.trial_session("s"),
                starts_at: 1,
                ends_at: 3_600_001,
              ),
              evidence: [],
            ),
          ],
        ),
      ]),
      fn(x) { x.row.id },
    )
    == Some(id.trial("t3"))
}

// journeyAdversarial: currentContactForCase — F2 two delivered Contacts at one instant: the higher id, in any order; an answered one is a lower tier
pub fn f2_two_delivered_contacts_at_one_instant_the_higher_id_in_any_order_an_a_test() {
  assert option.map(
      journey_model.current_contact([
        contact_rules.Contact(
          ..base.contact(),
          row: recruitment_contacts.Row(
            ..base.contact().row,
            id: id.contact("rct-2"),
            status: recruitment_contacts.Delivered,
            created_at: 5,
            delivered_at: Some(5),
            updated_at: 5,
          ),
        ),
        contact_rules.Contact(
          ..base.contact(),
          row: recruitment_contacts.Row(
            ..base.contact().row,
            id: id.contact("rct-9"),
            status: recruitment_contacts.Delivered,
            created_at: 5,
            delivered_at: Some(5),
            updated_at: 5,
          ),
        ),
        contact_rules.Contact(
          ..base.contact(),
          row: recruitment_contacts.Row(
            ..base.contact().row,
            id: id.contact("rct-1"),
            status: recruitment_contacts.Responded,
            created_at: 9,
            delivered_at: Some(9),
            updated_at: 9,
          ),
        ),
      ]),
      fn(x) { x.row.id },
    )
    == Some(id.contact("rct-9"))
}

// journeyAdversarial: currentContactForCase — F2 two delivered Contacts at one instant: the higher id, in any order; an answered one is a lower tier
pub fn f2_two_delivered_contacts_at_one_instant_the_higher_id_in_any_order_an_a_2_test() {
  assert option.map(
      journey_model.current_contact([
        contact_rules.Contact(
          ..base.contact(),
          row: recruitment_contacts.Row(
            ..base.contact().row,
            id: id.contact("rct-1"),
            status: recruitment_contacts.Responded,
            created_at: 9,
            delivered_at: Some(9),
            updated_at: 9,
          ),
        ),
        contact_rules.Contact(
          ..base.contact(),
          row: recruitment_contacts.Row(
            ..base.contact().row,
            id: id.contact("rct-9"),
            status: recruitment_contacts.Delivered,
            created_at: 5,
            delivered_at: Some(5),
            updated_at: 5,
          ),
        ),
        contact_rules.Contact(
          ..base.contact(),
          row: recruitment_contacts.Row(
            ..base.contact().row,
            id: id.contact("rct-2"),
            status: recruitment_contacts.Delivered,
            created_at: 5,
            delivered_at: Some(5),
            updated_at: 5,
          ),
        ),
      ]),
      fn(x) { x.row.id },
    )
    == Some(id.contact("rct-9"))
}

// journeyAdversarial: currentSigningForOffer — F3 two live packages at one instant: the higher id; a completed one never outranks a live one
pub fn f3_two_live_packages_at_one_instant_the_higher_id_a_completed_one_never_test() {
  assert option.map(
      journey_model.current_signing(
        [
          signing_rules.Package(
            ..base.signing_package(),
            row: signing_packages.Row(
              ..base.signing_package().row,
              id: id.signing_package("spk-a"),
              status: signing_packages.Ready,
              created_at: 1,
              expires_at: Some(1_794_830_400_000),
              current_revision_id: id.signing_revision("spk-a-r"),
            ),
            revisions: [
              signing_rules.Revision(
                row: signing_revisions.Row(
                  ..signing_revisions.Row(
                    ..base.signing_revision(),
                    id: id.signing_revision("spk-a-r"),
                    package_id: id.signing_package("spk-a"),
                    position: 0,
                  ),
                  revision_number: 1,
                  status: signing_revisions.Ready,
                ),
                document: None,
                executed: None,
                parties: [],
              ),
            ],
          ),
          signing_rules.Package(
            ..base.signing_package(),
            row: signing_packages.Row(
              ..base.signing_package().row,
              id: id.signing_package("spk-b"),
              status: signing_packages.Ready,
              created_at: 1,
              expires_at: Some(1_794_830_400_000),
              current_revision_id: id.signing_revision("spk-b-r"),
            ),
            revisions: [
              signing_rules.Revision(
                row: signing_revisions.Row(
                  ..signing_revisions.Row(
                    ..base.signing_revision(),
                    id: id.signing_revision("spk-b-r"),
                    package_id: id.signing_package("spk-b"),
                    position: 0,
                  ),
                  revision_number: 1,
                  status: signing_revisions.Ready,
                ),
                document: None,
                executed: None,
                parties: [],
              ),
            ],
          ),
          signing_rules.Package(
            ..base.signing_package(),
            row: signing_packages.Row(
              ..base.signing_package().row,
              id: id.signing_package("spk-c"),
              status: signing_packages.Completed,
              created_at: 9,
              expires_at: None,
              current_revision_id: id.signing_revision("spk-c-r"),
            ),
            revisions: [
              signing_rules.Revision(
                row: signing_revisions.Row(
                  ..signing_revisions.Row(
                    ..base.signing_revision(),
                    id: id.signing_revision("spk-c-r"),
                    package_id: id.signing_package("spk-c"),
                    position: 0,
                  ),
                  revision_number: 1,
                  status: signing_revisions.Completed,
                ),
                document: None,
                executed: None,
                parties: [],
              ),
            ],
          ),
        ],
        1_794_744_000_000,
      ),
      fn(x) { x.row.id },
    )
    == Some(id.signing_package("spk-b"))
}

// journeyAdversarial: currentSigningForOffer — F3 two live packages at one instant: the higher id; a completed one never outranks a live one
pub fn f3_two_live_packages_at_one_instant_the_higher_id_a_completed_one_never_2_test() {
  assert option.map(
      journey_model.current_signing(
        [
          signing_rules.Package(
            ..base.signing_package(),
            row: signing_packages.Row(
              ..base.signing_package().row,
              id: id.signing_package("spk-c"),
              status: signing_packages.Completed,
              created_at: 9,
              expires_at: None,
              current_revision_id: id.signing_revision("spk-c-r"),
            ),
            revisions: [
              signing_rules.Revision(
                row: signing_revisions.Row(
                  ..signing_revisions.Row(
                    ..base.signing_revision(),
                    id: id.signing_revision("spk-c-r"),
                    package_id: id.signing_package("spk-c"),
                    position: 0,
                  ),
                  revision_number: 1,
                  status: signing_revisions.Completed,
                ),
                document: None,
                executed: None,
                parties: [],
              ),
            ],
          ),
          signing_rules.Package(
            ..base.signing_package(),
            row: signing_packages.Row(
              ..base.signing_package().row,
              id: id.signing_package("spk-b"),
              status: signing_packages.Ready,
              created_at: 1,
              expires_at: Some(1_794_830_400_000),
              current_revision_id: id.signing_revision("spk-b-r"),
            ),
            revisions: [
              signing_rules.Revision(
                row: signing_revisions.Row(
                  ..signing_revisions.Row(
                    ..base.signing_revision(),
                    id: id.signing_revision("spk-b-r"),
                    package_id: id.signing_package("spk-b"),
                    position: 0,
                  ),
                  revision_number: 1,
                  status: signing_revisions.Ready,
                ),
                document: None,
                executed: None,
                parties: [],
              ),
            ],
          ),
          signing_rules.Package(
            ..base.signing_package(),
            row: signing_packages.Row(
              ..base.signing_package().row,
              id: id.signing_package("spk-a"),
              status: signing_packages.Ready,
              created_at: 1,
              expires_at: Some(1_794_830_400_000),
              current_revision_id: id.signing_revision("spk-a-r"),
            ),
            revisions: [
              signing_rules.Revision(
                row: signing_revisions.Row(
                  ..signing_revisions.Row(
                    ..base.signing_revision(),
                    id: id.signing_revision("spk-a-r"),
                    package_id: id.signing_package("spk-a"),
                    position: 0,
                  ),
                  revision_number: 1,
                  status: signing_revisions.Ready,
                ),
                document: None,
                executed: None,
                parties: [],
              ),
            ],
          ),
        ],
        1_794_744_000_000,
      ),
      fn(x) { x.row.id },
    )
    == Some(id.signing_package("spk-b"))
}

// journeyAdversarial: currentDecisionForCase — F5 the formal head in any order
pub fn f5_the_formal_head_in_any_order_test() {
  assert option.map(
      journey_model.current_decision([
        decisions.Decision(
          base: room_records.Decision(
            row: room_decisions.Row(
              ..base.decision().base.row,
              id: id.room_decision("d3"),
              kind: Some(room_decisions.Recommendation),
              state: Some(room_decisions.Final),
              created_at: 3,
              superseded_by_id: None,
            ),
            reason_codes: [],
            snapshot: None,
          ),
          refs: [],
          assessment_ids: [],
        ),
        decisions.Decision(
          base: room_records.Decision(
            row: room_decisions.Row(
              ..base.decision().base.row,
              id: id.room_decision("d2"),
              kind: Some(room_decisions.Formal),
              state: Some(room_decisions.Final),
              created_at: 2,
              superseded_by_id: None,
            ),
            reason_codes: [],
            snapshot: None,
          ),
          refs: [],
          assessment_ids: [],
        ),
        decisions.Decision(
          base: room_records.Decision(
            row: room_decisions.Row(
              ..base.decision().base.row,
              id: id.room_decision("d1"),
              kind: Some(room_decisions.Formal),
              state: Some(room_decisions.Final),
              created_at: 1,
              superseded_by_id: Some(id.room_decision("d2")),
            ),
            reason_codes: [],
            snapshot: None,
          ),
          refs: [],
          assessment_ids: [],
        ),
      ]),
      fn(d) { d.base.row.id },
    )
    == Some(id.room_decision("d2"))
}

// journeyAdversarial: currentOfferForCase — F6 the LIVE revision of the live Offer, in any order; a withdrawn Offer never masks it
pub fn f6_the_live_revision_of_the_live_offer_in_any_order_a_withdrawn_offer_ne_test() {
  assert option.map(
      journey_model.current_offer(
        [
          {
            let o =
              offer_rules.Offer(
                ..base.offer(),
                row: recruitment_offers.Row(
                  ..base.offer().row,
                  id: id.offer("rof-1"),
                  current_revision_id: id.offer_revision("r1"),
                ),
                revisions: [
                  offer_rules.Revision(
                    row: offer_revisions.Row(
                      ..base.offer_revision(),
                      id: id.offer_revision("r1"),
                      revision_number: 1,
                      status: offer_status.Withdrawn,
                      issued_at: Some(1),
                      expires_at: Some(1_795_608_000_000),
                    ),
                    documents: [],
                  ),
                ],
                responses: [],
              )
            offer_rules.Offer(
              ..o,
              row: recruitment_offers.Row(..o.row, updated_at: 1, created_at: 1),
            )
          },
          {
            let o =
              offer_rules.Offer(
                ..base.offer(),
                row: recruitment_offers.Row(
                  ..base.offer().row,
                  id: id.offer("rof-2"),
                  current_revision_id: id.offer_revision("r3"),
                ),
                revisions: [
                  offer_rules.Revision(
                    row: offer_revisions.Row(
                      ..base.offer_revision(),
                      id: id.offer_revision("r2"),
                      revision_number: 1,
                      status: offer_status.Superseded,
                      issued_at: Some(2),
                      expires_at: Some(1_795_608_000_000),
                    ),
                    documents: [],
                  ),
                  offer_rules.Revision(
                    row: offer_revisions.Row(
                      ..base.offer_revision(),
                      id: id.offer_revision("r3"),
                      revision_number: 2,
                      status: offer_status.Issued,
                      issued_at: Some(3),
                      expires_at: Some(1_795_608_000_000),
                    ),
                    documents: [],
                  ),
                ],
                responses: [],
              )
            offer_rules.Offer(
              ..o,
              row: recruitment_offers.Row(..o.row, updated_at: 3, created_at: 3),
            )
          },
        ],
        1_794_744_000_000,
      ),
      journey_model.next_offer(_, 1_794_744_000_000),
    )
    == Some(journey_model.NextOffer(
      id: id.offer("rof-2"),
      revision: Some(id.offer_revision("r3")),
      status: Some(offer_status.Issued),
      live_status: Some(offer_status.Issued),
    ))
}

// journeyAdversarial: currentOfferForCase — F6 the LIVE revision of the live Offer, in any order; a withdrawn Offer never masks it
pub fn f6_the_live_revision_of_the_live_offer_in_any_order_a_withdrawn_offer_ne_2_test() {
  assert option.map(
      journey_model.current_offer(
        [
          {
            let o =
              offer_rules.Offer(
                ..base.offer(),
                row: recruitment_offers.Row(
                  ..base.offer().row,
                  id: id.offer("rof-2"),
                  current_revision_id: id.offer_revision("r3"),
                ),
                revisions: [
                  offer_rules.Revision(
                    row: offer_revisions.Row(
                      ..base.offer_revision(),
                      id: id.offer_revision("r2"),
                      revision_number: 1,
                      status: offer_status.Superseded,
                      issued_at: Some(2),
                      expires_at: Some(1_795_608_000_000),
                    ),
                    documents: [],
                  ),
                  offer_rules.Revision(
                    row: offer_revisions.Row(
                      ..base.offer_revision(),
                      id: id.offer_revision("r3"),
                      revision_number: 2,
                      status: offer_status.Issued,
                      issued_at: Some(3),
                      expires_at: Some(1_795_608_000_000),
                    ),
                    documents: [],
                  ),
                ],
                responses: [],
              )
            offer_rules.Offer(
              ..o,
              row: recruitment_offers.Row(..o.row, updated_at: 3, created_at: 3),
            )
          },
          {
            let o =
              offer_rules.Offer(
                ..base.offer(),
                row: recruitment_offers.Row(
                  ..base.offer().row,
                  id: id.offer("rof-1"),
                  current_revision_id: id.offer_revision("r1"),
                ),
                revisions: [
                  offer_rules.Revision(
                    row: offer_revisions.Row(
                      ..base.offer_revision(),
                      id: id.offer_revision("r1"),
                      revision_number: 1,
                      status: offer_status.Withdrawn,
                      issued_at: Some(1),
                      expires_at: Some(1_795_608_000_000),
                    ),
                    documents: [],
                  ),
                ],
                responses: [],
              )
            offer_rules.Offer(
              ..o,
              row: recruitment_offers.Row(..o.row, updated_at: 1, created_at: 1),
            )
          },
        ],
        1_794_744_000_000,
      ),
      journey_model.next_offer(_, 1_794_744_000_000),
    )
    == Some(journey_model.NextOffer(
      id: id.offer("rof-2"),
      revision: Some(id.offer_revision("r3")),
      status: Some(offer_status.Issued),
      live_status: Some(offer_status.Issued),
    ))
}

// journeyAdversarial: currentAssessmentForCase — F7 two submissions at one instant: the higher id
pub fn f7_two_submissions_at_one_instant_the_higher_id_test() {
  assert option.map(
      journey_model.current_assessment([
        assessments.Row(
          ..base.assessment(),
          id: id.assessment("a2"),
          state: assessments.Submitted,
          submitted_at: Some(2),
        ),
        assessments.Row(
          ..base.assessment(),
          id: id.assessment("a1"),
          state: assessments.Submitted,
          submitted_at: Some(2),
        ),
      ]),
      fn(x) { x.id },
    )
    == Some(id.assessment("a2"))
}
