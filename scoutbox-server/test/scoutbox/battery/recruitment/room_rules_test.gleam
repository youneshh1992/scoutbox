//// Checks of the rules from the rules suites of recruitment/contacts, recruitment/decisions, recruitment/lifecycle,
//// recruitment/offers, recruitment/rooms, recruitment/trials, first generated from the TypeScript server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import gleam/json
import gleam/option.{None, Some}
import scoutbox/recruitment/room_rules
import scoutbox/rows/case_history
import scoutbox/rows/id
import scoutbox/rows/orgs
import scoutbox/rows/recruitment_cases
import scoutbox/rows/room_decisions
import scoutbox/vocab/room_status
import scoutbox/vocab/source_context
import scoutbox/vocab/task_state

// contacts: roomCan — the Rooms' roomCan carries the same two actions, so the Room has one permission table
pub fn the_rooms_roomcan_carries_the_same_two_actions_so_the_room_has_one_permi_test() {
  assert room_rules.room_can(Some(room_rules.RoomLead), room_rules.ContactWrite)
    == True
}

// contacts: roomCan — the Rooms' roomCan carries the same two actions, so the Room has one permission table
pub fn the_rooms_roomcan_carries_the_same_two_actions_so_the_room_has_one_permi_2_test() {
  assert room_rules.room_can(Some(room_rules.Viewer), room_rules.ContactView)
    == True
}

// contacts: roomCan — the Rooms' roomCan carries the same two actions, so the Room has one permission table
pub fn the_rooms_roomcan_carries_the_same_two_actions_so_the_room_has_one_permi_3_test() {
  assert room_rules.room_can(
      Some(room_rules.Contributor),
      room_rules.ContactWrite,
    )
    == False
}

// decisions: roomCan — P9 roomCan: everyone in the room reads; only a room lead or recruitment lead drafts or finalizes
pub fn p9_roomcan_everyone_in_the_room_reads_only_a_room_lead_or_recruitment_le_test() {
  assert room_rules.room_can(Some(room_rules.Viewer), room_rules.DecisionView)
    == True
}

// decisions: roomCan — P9 roomCan: everyone in the room reads; only a room lead or recruitment lead drafts or finalizes
pub fn p9_roomcan_everyone_in_the_room_reads_only_a_room_lead_or_recruitment_le_2_test() {
  assert room_rules.room_can(Some(room_rules.Viewer), room_rules.DecisionDraft)
    == False
}

// decisions: roomCan — P9 roomCan: everyone in the room reads; only a room lead or recruitment lead drafts or finalizes
pub fn p9_roomcan_everyone_in_the_room_reads_only_a_room_lead_or_recruitment_le_3_test() {
  assert room_rules.room_can(
      Some(room_rules.Contributor),
      room_rules.DecisionDraft,
    )
    == False
}

// decisions: roomCan — P9 roomCan: everyone in the room reads; only a room lead or recruitment lead drafts or finalizes
pub fn p9_roomcan_everyone_in_the_room_reads_only_a_room_lead_or_recruitment_le_4_test() {
  assert room_rules.room_can(
      Some(room_rules.Contributor),
      room_rules.DecisionFinalize,
    )
    == False
}

// decisions: roomCan — P9 roomCan: everyone in the room reads; only a room lead or recruitment lead drafts or finalizes
pub fn p9_roomcan_everyone_in_the_room_reads_only_a_room_lead_or_recruitment_le_5_test() {
  assert room_rules.room_can(
      Some(room_rules.RoomLead),
      room_rules.DecisionDraft,
    )
    == True
}

// decisions: roomCan — P9 roomCan: everyone in the room reads; only a room lead or recruitment lead drafts or finalizes
pub fn p9_roomcan_everyone_in_the_room_reads_only_a_room_lead_or_recruitment_le_6_test() {
  assert room_rules.room_can(
      Some(room_rules.RoomLead),
      room_rules.DecisionFinalize,
    )
    == True
}

// decisions: roomCan — P9 roomCan: everyone in the room reads; only a room lead or recruitment lead drafts or finalizes
pub fn p9_roomcan_everyone_in_the_room_reads_only_a_room_lead_or_recruitment_le_7_test() {
  assert room_rules.room_can(
      Some(room_rules.RecruitmentAdmin),
      room_rules.DecisionFinalize,
    )
    == True
}

// lifecycle: roomStatusForStage — [neg] H3 no legacy workspace stage maps to `signed` — the compatibility path cannot express it
pub fn neg_h3_no_legacy_workspace_stage_maps_to_signed_the_compatibility_path_c_test() {
  assert room_rules.room_status_for_stage(
      recruitment_cases.Identified,
      orgs.LevelAcademy,
    )
    == Some(room_status.Watching)
}

// lifecycle: roomStatusForStage — [neg] H3 no legacy workspace stage maps to `signed` — the compatibility path cannot express it
pub fn neg_h3_no_legacy_workspace_stage_maps_to_signed_the_compatibility_path_c_2_test() {
  assert room_rules.room_status_for_stage(
      recruitment_cases.Review,
      orgs.LevelAcademy,
    )
    == Some(room_status.UnderReview)
}

// lifecycle: roomStatusForStage — [neg] H3 no legacy workspace stage maps to `signed` — the compatibility path cannot express it
pub fn neg_h3_no_legacy_workspace_stage_maps_to_signed_the_compatibility_path_c_3_test() {
  assert room_rules.room_status_for_stage(
      recruitment_cases.Observation,
      orgs.LevelAcademy,
    )
    == Some(room_status.Shortlisted)
}

// lifecycle: roomStatusForStage — [neg] H3 no legacy workspace stage maps to `signed` — the compatibility path cannot express it
pub fn neg_h3_no_legacy_workspace_stage_maps_to_signed_the_compatibility_path_c_4_test() {
  assert room_rules.room_status_for_stage(
      recruitment_cases.Trial,
      orgs.LevelAcademy,
    )
    == Some(room_status.TrialRequested)
}

// lifecycle: roomStatusForStage — [neg] H3 no legacy workspace stage maps to `signed` — the compatibility path cannot express it
pub fn neg_h3_no_legacy_workspace_stage_maps_to_signed_the_compatibility_path_c_5_test() {
  assert room_rules.room_status_for_stage(
      recruitment_cases.Invited,
      orgs.LevelAcademy,
    )
    == None
}

// lifecycle: roomStatusForStage — [neg] H3 no legacy workspace stage maps to `signed` — the compatibility path cannot express it
pub fn neg_h3_no_legacy_workspace_stage_maps_to_signed_the_compatibility_path_c_6_test() {
  assert room_rules.room_status_for_stage(
      recruitment_cases.AwaitingResponse,
      orgs.LevelAcademy,
    )
    == None
}

// lifecycle: roomStatusForStage — [neg] H3 no legacy workspace stage maps to `signed` — the compatibility path cannot express it
pub fn neg_h3_no_legacy_workspace_stage_maps_to_signed_the_compatibility_path_c_7_test() {
  assert room_rules.room_status_for_stage(
      recruitment_cases.Decision,
      orgs.LevelAcademy,
    )
    == Some(room_status.OfferConsideration)
}

// lifecycle: roomStatusForStage — [neg] H3 no legacy workspace stage maps to `signed` — the compatibility path cannot express it
pub fn neg_h3_no_legacy_workspace_stage_maps_to_signed_the_compatibility_path_c_8_test() {
  assert room_rules.room_status_for_stage(
      recruitment_cases.Closed,
      orgs.LevelAcademy,
    )
    == Some(room_status.Archived)
}

// lifecycle: roomStatusForStage — [neg] H3b in either vocabulary
pub fn neg_h3b_in_either_vocabulary_test() {
  assert room_rules.room_status_for_stage(
      recruitment_cases.Identified,
      orgs.LevelGrassroots,
    )
    == None
}

// lifecycle: roomStatusForStage — [neg] H3b in either vocabulary
pub fn neg_h3b_in_either_vocabulary_2_test() {
  assert room_rules.room_status_for_stage(
      recruitment_cases.Review,
      orgs.LevelGrassroots,
    )
    == Some(room_status.UnderReview)
}

// lifecycle: roomStatusForStage — [neg] H3b in either vocabulary
pub fn neg_h3b_in_either_vocabulary_3_test() {
  assert room_rules.room_status_for_stage(
      recruitment_cases.Observation,
      orgs.LevelGrassroots,
    )
    == None
}

// lifecycle: roomStatusForStage — [neg] H3b in either vocabulary
pub fn neg_h3b_in_either_vocabulary_4_test() {
  assert room_rules.room_status_for_stage(
      recruitment_cases.Trial,
      orgs.LevelGrassroots,
    )
    == None
}

// lifecycle: roomStatusForStage — [neg] H3b in either vocabulary
pub fn neg_h3b_in_either_vocabulary_5_test() {
  assert room_rules.room_status_for_stage(
      recruitment_cases.Invited,
      orgs.LevelGrassroots,
    )
    == Some(room_status.TrialRequested)
}

// lifecycle: roomStatusForStage — [neg] H3b in either vocabulary
pub fn neg_h3b_in_either_vocabulary_6_test() {
  assert room_rules.room_status_for_stage(
      recruitment_cases.AwaitingResponse,
      orgs.LevelGrassroots,
    )
    == Some(room_status.TrialCompleted)
}

// lifecycle: roomStatusForStage — [neg] H3b in either vocabulary
pub fn neg_h3b_in_either_vocabulary_7_test() {
  assert room_rules.room_status_for_stage(
      recruitment_cases.Decision,
      orgs.LevelGrassroots,
    )
    == Some(room_status.OfferConsideration)
}

// lifecycle: roomStatusForStage — [neg] H3b in either vocabulary
pub fn neg_h3b_in_either_vocabulary_8_test() {
  assert room_rules.room_status_for_stage(
      recruitment_cases.Closed,
      orgs.LevelGrassroots,
    )
    == Some(room_status.Archived)
}

// lifecycle: adoptionStatusForStage — [neg] W2 but a Room adopting that case does NOT start at `trial_completed` — no trial is proven
pub fn neg_w2_but_a_room_adopting_that_case_does_not_start_at_trial_completed_n_test() {
  assert room_rules.adoption_status_for_stage(
      recruitment_cases.AwaitingResponse,
      orgs.LevelGrassroots,
    )
    == room_status.UnderReview
}

// lifecycle: adoptionStatusForStage — [neg] W3 no stage in either vocabulary starts a room at a status the records cannot prove
pub fn neg_w3_no_stage_in_either_vocabulary_starts_a_room_at_a_status_the_recor_test() {
  assert room_rules.adoption_status_for_stage(
      recruitment_cases.Identified,
      orgs.LevelPro,
    )
    == room_status.Watching
}

// lifecycle: adoptionStatusForStage — [neg] W3 no stage in either vocabulary starts a room at a status the records cannot prove
pub fn neg_w3_no_stage_in_either_vocabulary_starts_a_room_at_a_status_the_recor_2_test() {
  assert room_rules.adoption_status_for_stage(
      recruitment_cases.Review,
      orgs.LevelPro,
    )
    == room_status.UnderReview
}

// lifecycle: adoptionStatusForStage — [neg] W3 no stage in either vocabulary starts a room at a status the records cannot prove
pub fn neg_w3_no_stage_in_either_vocabulary_starts_a_room_at_a_status_the_recor_3_test() {
  assert room_rules.adoption_status_for_stage(
      recruitment_cases.Observation,
      orgs.LevelPro,
    )
    == room_status.Shortlisted
}

// lifecycle: adoptionStatusForStage — [neg] W3 no stage in either vocabulary starts a room at a status the records cannot prove
pub fn neg_w3_no_stage_in_either_vocabulary_starts_a_room_at_a_status_the_recor_4_test() {
  assert room_rules.adoption_status_for_stage(
      recruitment_cases.Trial,
      orgs.LevelPro,
    )
    == room_status.UnderReview
}

// lifecycle: adoptionStatusForStage — [neg] W3 no stage in either vocabulary starts a room at a status the records cannot prove
pub fn neg_w3_no_stage_in_either_vocabulary_starts_a_room_at_a_status_the_recor_5_test() {
  assert room_rules.adoption_status_for_stage(
      recruitment_cases.Decision,
      orgs.LevelPro,
    )
    == room_status.UnderReview
}

// lifecycle: adoptionStatusForStage — [neg] W3 no stage in either vocabulary starts a room at a status the records cannot prove
pub fn neg_w3_no_stage_in_either_vocabulary_starts_a_room_at_a_status_the_recor_6_test() {
  assert room_rules.adoption_status_for_stage(
      recruitment_cases.Closed,
      orgs.LevelPro,
    )
    == room_status.Archived
}

// lifecycle: adoptionStatusForStage — [neg] W3 no stage in either vocabulary starts a room at a status the records cannot prove
pub fn neg_w3_no_stage_in_either_vocabulary_starts_a_room_at_a_status_the_recor_7_test() {
  assert room_rules.adoption_status_for_stage(
      recruitment_cases.Review,
      orgs.LevelGrassroots,
    )
    == room_status.UnderReview
}

// lifecycle: adoptionStatusForStage — [neg] W3 no stage in either vocabulary starts a room at a status the records cannot prove
pub fn neg_w3_no_stage_in_either_vocabulary_starts_a_room_at_a_status_the_recor_8_test() {
  assert room_rules.adoption_status_for_stage(
      recruitment_cases.Invited,
      orgs.LevelGrassroots,
    )
    == room_status.UnderReview
}

// lifecycle: adoptionStatusForStage — [neg] W3 no stage in either vocabulary starts a room at a status the records cannot prove
pub fn neg_w3_no_stage_in_either_vocabulary_starts_a_room_at_a_status_the_recor_9_test() {
  assert room_rules.adoption_status_for_stage(
      recruitment_cases.Decision,
      orgs.LevelGrassroots,
    )
    == room_status.UnderReview
}

// lifecycle: adoptionStatusForStage — [neg] W3 no stage in either vocabulary starts a room at a status the records cannot prove
pub fn neg_w3_no_stage_in_either_vocabulary_starts_a_room_at_a_status_the_recor_10_test() {
  assert room_rules.adoption_status_for_stage(
      recruitment_cases.Closed,
      orgs.LevelGrassroots,
    )
    == room_status.Archived
}

// offers: roomCan — A12 roomCan: anyone who reads the room reads Offers; drafting and issuing sit with the room lead
pub fn a12_roomcan_anyone_who_reads_the_room_reads_offers_drafting_and_issuing_test() {
  assert room_rules.room_can(Some(room_rules.Viewer), room_rules.OfferView)
    == True
}

// offers: roomCan — A12 roomCan: anyone who reads the room reads Offers; drafting and issuing sit with the room lead
pub fn a12_roomcan_anyone_who_reads_the_room_reads_offers_drafting_and_issuing_2_test() {
  assert room_rules.room_can(Some(room_rules.Contributor), room_rules.OfferView)
    == True
}

// offers: roomCan — A12 roomCan: anyone who reads the room reads Offers; drafting and issuing sit with the room lead
pub fn a12_roomcan_anyone_who_reads_the_room_reads_offers_drafting_and_issuing_3_test() {
  assert room_rules.room_can(
      Some(room_rules.Contributor),
      room_rules.OfferDraft,
    )
    == False
}

// offers: roomCan — A12 roomCan: anyone who reads the room reads Offers; drafting and issuing sit with the room lead
pub fn a12_roomcan_anyone_who_reads_the_room_reads_offers_drafting_and_issuing_4_test() {
  assert room_rules.room_can(
      Some(room_rules.Contributor),
      room_rules.OfferIssue,
    )
    == False
}

// offers: roomCan — A12 roomCan: anyone who reads the room reads Offers; drafting and issuing sit with the room lead
pub fn a12_roomcan_anyone_who_reads_the_room_reads_offers_drafting_and_issuing_5_test() {
  assert room_rules.room_can(Some(room_rules.RoomLead), room_rules.OfferDraft)
    == True
}

// offers: roomCan — A12 roomCan: anyone who reads the room reads Offers; drafting and issuing sit with the room lead
pub fn a12_roomcan_anyone_who_reads_the_room_reads_offers_drafting_and_issuing_6_test() {
  assert room_rules.room_can(Some(room_rules.RoomLead), room_rules.OfferIssue)
    == True
}

// offers: roomCan — A12 roomCan: anyone who reads the room reads Offers; drafting and issuing sit with the room lead
pub fn a12_roomcan_anyone_who_reads_the_room_reads_offers_drafting_and_issuing_7_test() {
  assert room_rules.room_can(
      Some(room_rules.RecruitmentAdmin),
      room_rules.OfferIssue,
    )
    == True
}

// offers: roomCan — A12 roomCan: anyone who reads the room reads Offers; drafting and issuing sit with the room lead
pub fn a12_roomcan_anyone_who_reads_the_room_reads_offers_drafting_and_issuing_8_test() {
  assert room_rules.room_can(Some(room_rules.Viewer), room_rules.OfferDraft)
    == False
}

// rooms: stageForRoomStatus — watching maps to a real pro stage
pub fn watching_maps_to_a_real_pro_stage_test() {
  assert room_rules.stage_for_room_status(room_status.Watching, orgs.LevelPro)
    == recruitment_cases.Identified
}

// rooms: stageForRoomStatus — watching maps to a real grassroots stage
pub fn watching_maps_to_a_real_grassroots_stage_test() {
  assert room_rules.stage_for_room_status(
      room_status.Watching,
      orgs.LevelGrassroots,
    )
    == recruitment_cases.Review
}

// rooms: stageForRoomStatus — under_review maps to a real pro stage
pub fn under_review_maps_to_a_real_pro_stage_test() {
  assert room_rules.stage_for_room_status(
      room_status.UnderReview,
      orgs.LevelPro,
    )
    == recruitment_cases.Review
}

// rooms: stageForRoomStatus — under_review maps to a real grassroots stage
pub fn under_review_maps_to_a_real_grassroots_stage_test() {
  assert room_rules.stage_for_room_status(
      room_status.UnderReview,
      orgs.LevelGrassroots,
    )
    == recruitment_cases.Review
}

// rooms: stageForRoomStatus — contact_planned maps to a real pro stage
pub fn contact_planned_maps_to_a_real_pro_stage_test() {
  assert room_rules.stage_for_room_status(
      room_status.ContactPlanned,
      orgs.LevelPro,
    )
    == recruitment_cases.Review
}

// rooms: stageForRoomStatus — contact_planned maps to a real grassroots stage
pub fn contact_planned_maps_to_a_real_grassroots_stage_test() {
  assert room_rules.stage_for_room_status(
      room_status.ContactPlanned,
      orgs.LevelGrassroots,
    )
    == recruitment_cases.Review
}

// rooms: stageForRoomStatus — contacted maps to a real pro stage
pub fn contacted_maps_to_a_real_pro_stage_test() {
  assert room_rules.stage_for_room_status(room_status.Contacted, orgs.LevelPro)
    == recruitment_cases.Review
}

// rooms: stageForRoomStatus — contacted maps to a real grassroots stage
pub fn contacted_maps_to_a_real_grassroots_stage_test() {
  assert room_rules.stage_for_room_status(
      room_status.Contacted,
      orgs.LevelGrassroots,
    )
    == recruitment_cases.AwaitingResponse
}

// rooms: stageForRoomStatus — shortlisted maps to a real pro stage
pub fn shortlisted_maps_to_a_real_pro_stage_test() {
  assert room_rules.stage_for_room_status(
      room_status.Shortlisted,
      orgs.LevelPro,
    )
    == recruitment_cases.Observation
}

// rooms: stageForRoomStatus — shortlisted maps to a real grassroots stage
pub fn shortlisted_maps_to_a_real_grassroots_stage_test() {
  assert room_rules.stage_for_room_status(
      room_status.Shortlisted,
      orgs.LevelGrassroots,
    )
    == recruitment_cases.Review
}

// rooms: stageForRoomStatus — priority maps to a real pro stage
pub fn priority_maps_to_a_real_pro_stage_test() {
  assert room_rules.stage_for_room_status(room_status.Priority, orgs.LevelPro)
    == recruitment_cases.Observation
}

// rooms: stageForRoomStatus — priority maps to a real grassroots stage
pub fn priority_maps_to_a_real_grassroots_stage_test() {
  assert room_rules.stage_for_room_status(
      room_status.Priority,
      orgs.LevelGrassroots,
    )
    == recruitment_cases.Review
}

// rooms: stageForRoomStatus — trial_requested maps to a real pro stage
pub fn trial_requested_maps_to_a_real_pro_stage_test() {
  assert room_rules.stage_for_room_status(
      room_status.TrialRequested,
      orgs.LevelPro,
    )
    == recruitment_cases.Trial
}

// rooms: stageForRoomStatus — trial_requested maps to a real grassroots stage
pub fn trial_requested_maps_to_a_real_grassroots_stage_test() {
  assert room_rules.stage_for_room_status(
      room_status.TrialRequested,
      orgs.LevelGrassroots,
    )
    == recruitment_cases.Invited
}

// rooms: stageForRoomStatus — trial_scheduled maps to a real pro stage
pub fn trial_scheduled_maps_to_a_real_pro_stage_test() {
  assert room_rules.stage_for_room_status(
      room_status.TrialScheduled,
      orgs.LevelPro,
    )
    == recruitment_cases.Trial
}

// rooms: stageForRoomStatus — trial_scheduled maps to a real grassroots stage
pub fn trial_scheduled_maps_to_a_real_grassroots_stage_test() {
  assert room_rules.stage_for_room_status(
      room_status.TrialScheduled,
      orgs.LevelGrassroots,
    )
    == recruitment_cases.Invited
}

// rooms: stageForRoomStatus — trial_completed maps to a real pro stage
pub fn trial_completed_maps_to_a_real_pro_stage_test() {
  assert room_rules.stage_for_room_status(
      room_status.TrialCompleted,
      orgs.LevelPro,
    )
    == recruitment_cases.Trial
}

// rooms: stageForRoomStatus — trial_completed maps to a real grassroots stage
pub fn trial_completed_maps_to_a_real_grassroots_stage_test() {
  assert room_rules.stage_for_room_status(
      room_status.TrialCompleted,
      orgs.LevelGrassroots,
    )
    == recruitment_cases.AwaitingResponse
}

// rooms: stageForRoomStatus — offer_consideration maps to a real pro stage
pub fn offer_consideration_maps_to_a_real_pro_stage_test() {
  assert room_rules.stage_for_room_status(
      room_status.OfferConsideration,
      orgs.LevelPro,
    )
    == recruitment_cases.Decision
}

// rooms: stageForRoomStatus — offer_consideration maps to a real grassroots stage
pub fn offer_consideration_maps_to_a_real_grassroots_stage_test() {
  assert room_rules.stage_for_room_status(
      room_status.OfferConsideration,
      orgs.LevelGrassroots,
    )
    == recruitment_cases.Decision
}

// rooms: stageForRoomStatus — offer_made maps to a real pro stage
pub fn offer_made_maps_to_a_real_pro_stage_test() {
  assert room_rules.stage_for_room_status(room_status.OfferMade, orgs.LevelPro)
    == recruitment_cases.Decision
}

// rooms: stageForRoomStatus — offer_made maps to a real grassroots stage
pub fn offer_made_maps_to_a_real_grassroots_stage_test() {
  assert room_rules.stage_for_room_status(
      room_status.OfferMade,
      orgs.LevelGrassroots,
    )
    == recruitment_cases.Decision
}

// rooms: stageForRoomStatus — offer_accepted maps to a real pro stage
pub fn offer_accepted_maps_to_a_real_pro_stage_test() {
  assert room_rules.stage_for_room_status(
      room_status.OfferAccepted,
      orgs.LevelPro,
    )
    == recruitment_cases.Decision
}

// rooms: stageForRoomStatus — offer_accepted maps to a real grassroots stage
pub fn offer_accepted_maps_to_a_real_grassroots_stage_test() {
  assert room_rules.stage_for_room_status(
      room_status.OfferAccepted,
      orgs.LevelGrassroots,
    )
    == recruitment_cases.Decision
}

// rooms: stageForRoomStatus — offer_declined maps to a real pro stage
pub fn offer_declined_maps_to_a_real_pro_stage_test() {
  assert room_rules.stage_for_room_status(
      room_status.OfferDeclined,
      orgs.LevelPro,
    )
    == recruitment_cases.Decision
}

// rooms: stageForRoomStatus — offer_declined maps to a real grassroots stage
pub fn offer_declined_maps_to_a_real_grassroots_stage_test() {
  assert room_rules.stage_for_room_status(
      room_status.OfferDeclined,
      orgs.LevelGrassroots,
    )
    == recruitment_cases.Decision
}

// rooms: stageForRoomStatus — signed maps to a real pro stage
pub fn signed_maps_to_a_real_pro_stage_test() {
  assert room_rules.stage_for_room_status(room_status.Signed, orgs.LevelPro)
    == recruitment_cases.Closed
}

// rooms: stageForRoomStatus — signed maps to a real grassroots stage
pub fn signed_maps_to_a_real_grassroots_stage_test() {
  assert room_rules.stage_for_room_status(
      room_status.Signed,
      orgs.LevelGrassroots,
    )
    == recruitment_cases.Closed
}

// rooms: stageForRoomStatus — on_hold maps to a real pro stage
pub fn on_hold_maps_to_a_real_pro_stage_test() {
  assert room_rules.stage_for_room_status(room_status.OnHold, orgs.LevelPro)
    == recruitment_cases.Review
}

// rooms: stageForRoomStatus — on_hold maps to a real grassroots stage
pub fn on_hold_maps_to_a_real_grassroots_stage_test() {
  assert room_rules.stage_for_room_status(
      room_status.OnHold,
      orgs.LevelGrassroots,
    )
    == recruitment_cases.Review
}

// rooms: stageForRoomStatus — withdrawn maps to a real pro stage
pub fn withdrawn_maps_to_a_real_pro_stage_test() {
  assert room_rules.stage_for_room_status(room_status.Withdrawn, orgs.LevelPro)
    == recruitment_cases.Closed
}

// rooms: stageForRoomStatus — withdrawn maps to a real grassroots stage
pub fn withdrawn_maps_to_a_real_grassroots_stage_test() {
  assert room_rules.stage_for_room_status(
      room_status.Withdrawn,
      orgs.LevelGrassroots,
    )
    == recruitment_cases.Closed
}

// rooms: stageForRoomStatus — archived maps to a real pro stage
pub fn archived_maps_to_a_real_pro_stage_test() {
  assert room_rules.stage_for_room_status(room_status.Archived, orgs.LevelPro)
    == recruitment_cases.Closed
}

// rooms: stageForRoomStatus — archived maps to a real grassroots stage
pub fn archived_maps_to_a_real_grassroots_stage_test() {
  assert room_rules.stage_for_room_status(
      room_status.Archived,
      orgs.LevelGrassroots,
    )
    == recruitment_cases.Closed
}

// rooms: stageForRoomStatus — closed maps to a real pro stage
pub fn closed_maps_to_a_real_pro_stage_test() {
  assert room_rules.stage_for_room_status(room_status.Closed, orgs.LevelPro)
    == recruitment_cases.Closed
}

// rooms: stageForRoomStatus — closed maps to a real grassroots stage
pub fn closed_maps_to_a_real_grassroots_stage_test() {
  assert room_rules.stage_for_room_status(
      room_status.Closed,
      orgs.LevelGrassroots,
    )
    == recruitment_cases.Closed
}

// rooms: roomStatusForStage — pro stage identified round-trips through a room status
pub fn pro_stage_identified_round_trips_through_a_room_status_test() {
  assert room_rules.room_status_for_stage(
      recruitment_cases.Identified,
      orgs.LevelPro,
    )
    == Some(room_status.Watching)
}

// rooms: roomStatusForStage — pro stage review round-trips through a room status
pub fn pro_stage_review_round_trips_through_a_room_status_test() {
  assert room_rules.room_status_for_stage(
      recruitment_cases.Review,
      orgs.LevelPro,
    )
    == Some(room_status.UnderReview)
}

// rooms: roomStatusForStage — pro stage observation round-trips through a room status
pub fn pro_stage_observation_round_trips_through_a_room_status_test() {
  assert room_rules.room_status_for_stage(
      recruitment_cases.Observation,
      orgs.LevelPro,
    )
    == Some(room_status.Shortlisted)
}

// rooms: roomStatusForStage — pro stage trial round-trips through a room status
pub fn pro_stage_trial_round_trips_through_a_room_status_test() {
  assert room_rules.room_status_for_stage(
      recruitment_cases.Trial,
      orgs.LevelPro,
    )
    == Some(room_status.TrialRequested)
}

// rooms: roomStatusForStage — pro stage decision round-trips through a room status
pub fn pro_stage_decision_round_trips_through_a_room_status_test() {
  assert room_rules.room_status_for_stage(
      recruitment_cases.Decision,
      orgs.LevelPro,
    )
    == Some(room_status.OfferConsideration)
}

// rooms: roomStatusForStage — pro stage closed round-trips through a room status
pub fn pro_stage_closed_round_trips_through_a_room_status_test() {
  assert room_rules.room_status_for_stage(
      recruitment_cases.Closed,
      orgs.LevelPro,
    )
    == Some(room_status.Archived)
}

// rooms: canTransition — watching → under_review is allowed
pub fn watching_under_review_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.Watching,
      room_status.UnderReview,
    )
    == True
}

// rooms: canTransition — watching → shortlisted is allowed
pub fn watching_shortlisted_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.Watching,
      room_status.Shortlisted,
    )
    == True
}

// rooms: canTransition — watching → contact_planned is allowed
pub fn watching_contact_planned_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.Watching,
      room_status.ContactPlanned,
    )
    == True
}

// rooms: canTransition — watching → on_hold is allowed
pub fn watching_on_hold_is_allowed_test() {
  assert room_rules.can_transition(room_status.Watching, room_status.OnHold)
    == True
}

// rooms: canTransition — watching → withdrawn is allowed
pub fn watching_withdrawn_is_allowed_test() {
  assert room_rules.can_transition(room_status.Watching, room_status.Withdrawn)
    == True
}

// rooms: canTransition — watching → archived is allowed
pub fn watching_archived_is_allowed_test() {
  assert room_rules.can_transition(room_status.Watching, room_status.Archived)
    == True
}

// rooms: canTransition — under_review → watching is allowed
pub fn under_review_watching_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.UnderReview,
      room_status.Watching,
    )
    == True
}

// rooms: canTransition — under_review → shortlisted is allowed
pub fn under_review_shortlisted_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.UnderReview,
      room_status.Shortlisted,
    )
    == True
}

// rooms: canTransition — under_review → priority is allowed
pub fn under_review_priority_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.UnderReview,
      room_status.Priority,
    )
    == True
}

// rooms: canTransition — under_review → contact_planned is allowed
pub fn under_review_contact_planned_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.UnderReview,
      room_status.ContactPlanned,
    )
    == True
}

// rooms: canTransition — under_review → trial_requested is allowed
pub fn under_review_trial_requested_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.UnderReview,
      room_status.TrialRequested,
    )
    == True
}

// rooms: canTransition — under_review → on_hold is allowed
pub fn under_review_on_hold_is_allowed_test() {
  assert room_rules.can_transition(room_status.UnderReview, room_status.OnHold)
    == True
}

// rooms: canTransition — under_review → withdrawn is allowed
pub fn under_review_withdrawn_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.UnderReview,
      room_status.Withdrawn,
    )
    == True
}

// rooms: canTransition — under_review → archived is allowed
pub fn under_review_archived_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.UnderReview,
      room_status.Archived,
    )
    == True
}

// rooms: canTransition — contact_planned → contacted is allowed
pub fn contact_planned_contacted_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.ContactPlanned,
      room_status.Contacted,
    )
    == True
}

// rooms: canTransition — contact_planned → under_review is allowed
pub fn contact_planned_under_review_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.ContactPlanned,
      room_status.UnderReview,
    )
    == True
}

// rooms: canTransition — contact_planned → shortlisted is allowed
pub fn contact_planned_shortlisted_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.ContactPlanned,
      room_status.Shortlisted,
    )
    == True
}

// rooms: canTransition — contact_planned → priority is allowed
pub fn contact_planned_priority_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.ContactPlanned,
      room_status.Priority,
    )
    == True
}

// rooms: canTransition — contact_planned → on_hold is allowed
pub fn contact_planned_on_hold_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.ContactPlanned,
      room_status.OnHold,
    )
    == True
}

// rooms: canTransition — contact_planned → withdrawn is allowed
pub fn contact_planned_withdrawn_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.ContactPlanned,
      room_status.Withdrawn,
    )
    == True
}

// rooms: canTransition — contact_planned → archived is allowed
pub fn contact_planned_archived_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.ContactPlanned,
      room_status.Archived,
    )
    == True
}

// rooms: canTransition — contacted → shortlisted is allowed
pub fn contacted_shortlisted_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.Contacted,
      room_status.Shortlisted,
    )
    == True
}

// rooms: canTransition — contacted → priority is allowed
pub fn contacted_priority_is_allowed_test() {
  assert room_rules.can_transition(room_status.Contacted, room_status.Priority)
    == True
}

// rooms: canTransition — contacted → trial_requested is allowed
pub fn contacted_trial_requested_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.Contacted,
      room_status.TrialRequested,
    )
    == True
}

// rooms: canTransition — contacted → offer_consideration is allowed
pub fn contacted_offer_consideration_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.Contacted,
      room_status.OfferConsideration,
    )
    == True
}

// rooms: canTransition — contacted → under_review is allowed
pub fn contacted_under_review_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.Contacted,
      room_status.UnderReview,
    )
    == True
}

// rooms: canTransition — contacted → on_hold is allowed
pub fn contacted_on_hold_is_allowed_test() {
  assert room_rules.can_transition(room_status.Contacted, room_status.OnHold)
    == True
}

// rooms: canTransition — contacted → withdrawn is allowed
pub fn contacted_withdrawn_is_allowed_test() {
  assert room_rules.can_transition(room_status.Contacted, room_status.Withdrawn)
    == True
}

// rooms: canTransition — contacted → archived is allowed
pub fn contacted_archived_is_allowed_test() {
  assert room_rules.can_transition(room_status.Contacted, room_status.Archived)
    == True
}

// rooms: canTransition — shortlisted → under_review is allowed
pub fn shortlisted_under_review_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.Shortlisted,
      room_status.UnderReview,
    )
    == True
}

// rooms: canTransition — shortlisted → priority is allowed
pub fn shortlisted_priority_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.Shortlisted,
      room_status.Priority,
    )
    == True
}

// rooms: canTransition — shortlisted → contact_planned is allowed
pub fn shortlisted_contact_planned_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.Shortlisted,
      room_status.ContactPlanned,
    )
    == True
}

// rooms: canTransition — shortlisted → trial_requested is allowed
pub fn shortlisted_trial_requested_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.Shortlisted,
      room_status.TrialRequested,
    )
    == True
}

// rooms: canTransition — shortlisted → offer_consideration is allowed
pub fn shortlisted_offer_consideration_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.Shortlisted,
      room_status.OfferConsideration,
    )
    == True
}

// rooms: canTransition — shortlisted → on_hold is allowed
pub fn shortlisted_on_hold_is_allowed_test() {
  assert room_rules.can_transition(room_status.Shortlisted, room_status.OnHold)
    == True
}

// rooms: canTransition — shortlisted → withdrawn is allowed
pub fn shortlisted_withdrawn_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.Shortlisted,
      room_status.Withdrawn,
    )
    == True
}

// rooms: canTransition — shortlisted → archived is allowed
pub fn shortlisted_archived_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.Shortlisted,
      room_status.Archived,
    )
    == True
}

// rooms: canTransition — priority → shortlisted is allowed
pub fn priority_shortlisted_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.Priority,
      room_status.Shortlisted,
    )
    == True
}

// rooms: canTransition — priority → contact_planned is allowed
pub fn priority_contact_planned_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.Priority,
      room_status.ContactPlanned,
    )
    == True
}

// rooms: canTransition — priority → trial_requested is allowed
pub fn priority_trial_requested_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.Priority,
      room_status.TrialRequested,
    )
    == True
}

// rooms: canTransition — priority → offer_consideration is allowed
pub fn priority_offer_consideration_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.Priority,
      room_status.OfferConsideration,
    )
    == True
}

// rooms: canTransition — priority → on_hold is allowed
pub fn priority_on_hold_is_allowed_test() {
  assert room_rules.can_transition(room_status.Priority, room_status.OnHold)
    == True
}

// rooms: canTransition — priority → withdrawn is allowed
pub fn priority_withdrawn_is_allowed_test() {
  assert room_rules.can_transition(room_status.Priority, room_status.Withdrawn)
    == True
}

// rooms: canTransition — priority → archived is allowed
pub fn priority_archived_is_allowed_test() {
  assert room_rules.can_transition(room_status.Priority, room_status.Archived)
    == True
}

// rooms: canTransition — trial_requested → trial_scheduled is allowed
pub fn trial_requested_trial_scheduled_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.TrialRequested,
      room_status.TrialScheduled,
    )
    == True
}

// rooms: canTransition — trial_requested → shortlisted is allowed
pub fn trial_requested_shortlisted_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.TrialRequested,
      room_status.Shortlisted,
    )
    == True
}

// rooms: canTransition — trial_requested → priority is allowed
pub fn trial_requested_priority_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.TrialRequested,
      room_status.Priority,
    )
    == True
}

// rooms: canTransition — trial_requested → on_hold is allowed
pub fn trial_requested_on_hold_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.TrialRequested,
      room_status.OnHold,
    )
    == True
}

// rooms: canTransition — trial_requested → withdrawn is allowed
pub fn trial_requested_withdrawn_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.TrialRequested,
      room_status.Withdrawn,
    )
    == True
}

// rooms: canTransition — trial_requested → archived is allowed
pub fn trial_requested_archived_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.TrialRequested,
      room_status.Archived,
    )
    == True
}

// rooms: canTransition — trial_scheduled → trial_completed is allowed
pub fn trial_scheduled_trial_completed_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.TrialScheduled,
      room_status.TrialCompleted,
    )
    == True
}

// rooms: canTransition — trial_scheduled → trial_requested is allowed
pub fn trial_scheduled_trial_requested_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.TrialScheduled,
      room_status.TrialRequested,
    )
    == True
}

// rooms: canTransition — trial_scheduled → on_hold is allowed
pub fn trial_scheduled_on_hold_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.TrialScheduled,
      room_status.OnHold,
    )
    == True
}

// rooms: canTransition — trial_scheduled → withdrawn is allowed
pub fn trial_scheduled_withdrawn_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.TrialScheduled,
      room_status.Withdrawn,
    )
    == True
}

// rooms: canTransition — trial_scheduled → archived is allowed
pub fn trial_scheduled_archived_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.TrialScheduled,
      room_status.Archived,
    )
    == True
}

// rooms: canTransition — trial_completed → offer_consideration is allowed
pub fn trial_completed_offer_consideration_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.TrialCompleted,
      room_status.OfferConsideration,
    )
    == True
}

// rooms: canTransition — trial_completed → shortlisted is allowed
pub fn trial_completed_shortlisted_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.TrialCompleted,
      room_status.Shortlisted,
    )
    == True
}

// rooms: canTransition — trial_completed → priority is allowed
pub fn trial_completed_priority_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.TrialCompleted,
      room_status.Priority,
    )
    == True
}

// rooms: canTransition — trial_completed → on_hold is allowed
pub fn trial_completed_on_hold_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.TrialCompleted,
      room_status.OnHold,
    )
    == True
}

// rooms: canTransition — trial_completed → withdrawn is allowed
pub fn trial_completed_withdrawn_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.TrialCompleted,
      room_status.Withdrawn,
    )
    == True
}

// rooms: canTransition — trial_completed → archived is allowed
pub fn trial_completed_archived_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.TrialCompleted,
      room_status.Archived,
    )
    == True
}

// rooms: canTransition — offer_consideration → offer_made is allowed
pub fn offer_consideration_offer_made_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.OfferConsideration,
      room_status.OfferMade,
    )
    == True
}

// rooms: canTransition — offer_consideration → shortlisted is allowed
pub fn offer_consideration_shortlisted_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.OfferConsideration,
      room_status.Shortlisted,
    )
    == True
}

// rooms: canTransition — offer_consideration → priority is allowed
pub fn offer_consideration_priority_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.OfferConsideration,
      room_status.Priority,
    )
    == True
}

// rooms: canTransition — offer_consideration → on_hold is allowed
pub fn offer_consideration_on_hold_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.OfferConsideration,
      room_status.OnHold,
    )
    == True
}

// rooms: canTransition — offer_consideration → withdrawn is allowed
pub fn offer_consideration_withdrawn_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.OfferConsideration,
      room_status.Withdrawn,
    )
    == True
}

// rooms: canTransition — offer_consideration → archived is allowed
pub fn offer_consideration_archived_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.OfferConsideration,
      room_status.Archived,
    )
    == True
}

// rooms: canTransition — offer_made → offer_accepted is allowed
pub fn offer_made_offer_accepted_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.OfferMade,
      room_status.OfferAccepted,
    )
    == True
}

// rooms: canTransition — offer_made → offer_declined is allowed
pub fn offer_made_offer_declined_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.OfferMade,
      room_status.OfferDeclined,
    )
    == True
}

// rooms: canTransition — offer_made → signed is allowed
pub fn offer_made_signed_is_allowed_test() {
  assert room_rules.can_transition(room_status.OfferMade, room_status.Signed)
    == True
}

// rooms: canTransition — offer_made → offer_consideration is allowed
pub fn offer_made_offer_consideration_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.OfferMade,
      room_status.OfferConsideration,
    )
    == True
}

// rooms: canTransition — offer_made → on_hold is allowed
pub fn offer_made_on_hold_is_allowed_test() {
  assert room_rules.can_transition(room_status.OfferMade, room_status.OnHold)
    == True
}

// rooms: canTransition — offer_made → withdrawn is allowed
pub fn offer_made_withdrawn_is_allowed_test() {
  assert room_rules.can_transition(room_status.OfferMade, room_status.Withdrawn)
    == True
}

// rooms: canTransition — offer_made → archived is allowed
pub fn offer_made_archived_is_allowed_test() {
  assert room_rules.can_transition(room_status.OfferMade, room_status.Archived)
    == True
}

// rooms: canTransition — offer_accepted → signed is allowed
pub fn offer_accepted_signed_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.OfferAccepted,
      room_status.Signed,
    )
    == True
}

// rooms: canTransition — offer_accepted → on_hold is allowed
pub fn offer_accepted_on_hold_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.OfferAccepted,
      room_status.OnHold,
    )
    == True
}

// rooms: canTransition — offer_accepted → withdrawn is allowed
pub fn offer_accepted_withdrawn_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.OfferAccepted,
      room_status.Withdrawn,
    )
    == True
}

// rooms: canTransition — offer_accepted → archived is allowed
pub fn offer_accepted_archived_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.OfferAccepted,
      room_status.Archived,
    )
    == True
}

// rooms: canTransition — offer_accepted → closed is allowed
pub fn offer_accepted_closed_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.OfferAccepted,
      room_status.Closed,
    )
    == True
}

// rooms: canTransition — offer_declined → under_review is allowed
pub fn offer_declined_under_review_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.OfferDeclined,
      room_status.UnderReview,
    )
    == True
}

// rooms: canTransition — offer_declined → shortlisted is allowed
pub fn offer_declined_shortlisted_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.OfferDeclined,
      room_status.Shortlisted,
    )
    == True
}

// rooms: canTransition — offer_declined → priority is allowed
pub fn offer_declined_priority_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.OfferDeclined,
      room_status.Priority,
    )
    == True
}

// rooms: canTransition — offer_declined → on_hold is allowed
pub fn offer_declined_on_hold_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.OfferDeclined,
      room_status.OnHold,
    )
    == True
}

// rooms: canTransition — offer_declined → withdrawn is allowed
pub fn offer_declined_withdrawn_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.OfferDeclined,
      room_status.Withdrawn,
    )
    == True
}

// rooms: canTransition — offer_declined → archived is allowed
pub fn offer_declined_archived_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.OfferDeclined,
      room_status.Archived,
    )
    == True
}

// rooms: canTransition — offer_declined → closed is allowed
pub fn offer_declined_closed_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.OfferDeclined,
      room_status.Closed,
    )
    == True
}

// rooms: canTransition — signed → closed is allowed
pub fn signed_closed_is_allowed_test() {
  assert room_rules.can_transition(room_status.Signed, room_status.Closed)
    == True
}

// rooms: canTransition — on_hold → under_review is allowed
pub fn on_hold_under_review_is_allowed_test() {
  assert room_rules.can_transition(room_status.OnHold, room_status.UnderReview)
    == True
}

// rooms: canTransition — on_hold → shortlisted is allowed
pub fn on_hold_shortlisted_is_allowed_test() {
  assert room_rules.can_transition(room_status.OnHold, room_status.Shortlisted)
    == True
}

// rooms: canTransition — on_hold → priority is allowed
pub fn on_hold_priority_is_allowed_test() {
  assert room_rules.can_transition(room_status.OnHold, room_status.Priority)
    == True
}

// rooms: canTransition — on_hold → contact_planned is allowed
pub fn on_hold_contact_planned_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.OnHold,
      room_status.ContactPlanned,
    )
    == True
}

// rooms: canTransition — on_hold → trial_requested is allowed
pub fn on_hold_trial_requested_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.OnHold,
      room_status.TrialRequested,
    )
    == True
}

// rooms: canTransition — on_hold → offer_consideration is allowed
pub fn on_hold_offer_consideration_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.OnHold,
      room_status.OfferConsideration,
    )
    == True
}

// rooms: canTransition — on_hold → withdrawn is allowed
pub fn on_hold_withdrawn_is_allowed_test() {
  assert room_rules.can_transition(room_status.OnHold, room_status.Withdrawn)
    == True
}

// rooms: canTransition — on_hold → archived is allowed
pub fn on_hold_archived_is_allowed_test() {
  assert room_rules.can_transition(room_status.OnHold, room_status.Archived)
    == True
}

// rooms: canTransition — on_hold → closed is allowed
pub fn on_hold_closed_is_allowed_test() {
  assert room_rules.can_transition(room_status.OnHold, room_status.Closed)
    == True
}

// rooms: canTransition — withdrawn → under_review is allowed
pub fn withdrawn_under_review_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.Withdrawn,
      room_status.UnderReview,
    )
    == True
}

// rooms: canTransition — withdrawn → archived is allowed
pub fn withdrawn_archived_is_allowed_test() {
  assert room_rules.can_transition(room_status.Withdrawn, room_status.Archived)
    == True
}

// rooms: canTransition — withdrawn → closed is allowed
pub fn withdrawn_closed_is_allowed_test() {
  assert room_rules.can_transition(room_status.Withdrawn, room_status.Closed)
    == True
}

// rooms: canTransition — archived → under_review is allowed
pub fn archived_under_review_is_allowed_test() {
  assert room_rules.can_transition(
      room_status.Archived,
      room_status.UnderReview,
    )
    == True
}

// rooms: canTransition — archived → closed is allowed
pub fn archived_closed_is_allowed_test() {
  assert room_rules.can_transition(room_status.Archived, room_status.Closed)
    == True
}

// rooms: canTransition — closed → under_review is allowed
pub fn closed_under_review_is_allowed_test() {
  assert room_rules.can_transition(room_status.Closed, room_status.UnderReview)
    == True
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_test() {
  assert room_rules.can_transition(room_status.Watching, room_status.Contacted)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_2_test() {
  assert room_rules.can_transition(room_status.Watching, room_status.Priority)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_3_test() {
  assert room_rules.can_transition(
      room_status.Watching,
      room_status.TrialRequested,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_4_test() {
  assert room_rules.can_transition(
      room_status.Watching,
      room_status.TrialScheduled,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_5_test() {
  assert room_rules.can_transition(
      room_status.Watching,
      room_status.TrialCompleted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_6_test() {
  assert room_rules.can_transition(
      room_status.Watching,
      room_status.OfferConsideration,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_7_test() {
  assert room_rules.can_transition(room_status.Watching, room_status.OfferMade)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_8_test() {
  assert room_rules.can_transition(
      room_status.Watching,
      room_status.OfferAccepted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_9_test() {
  assert room_rules.can_transition(
      room_status.Watching,
      room_status.OfferDeclined,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_10_test() {
  assert room_rules.can_transition(room_status.Watching, room_status.Signed)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_11_test() {
  assert room_rules.can_transition(room_status.Watching, room_status.Closed)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_12_test() {
  assert room_rules.can_transition(
      room_status.UnderReview,
      room_status.Contacted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_13_test() {
  assert room_rules.can_transition(
      room_status.UnderReview,
      room_status.TrialScheduled,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_14_test() {
  assert room_rules.can_transition(
      room_status.UnderReview,
      room_status.TrialCompleted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_15_test() {
  assert room_rules.can_transition(
      room_status.UnderReview,
      room_status.OfferConsideration,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_16_test() {
  assert room_rules.can_transition(
      room_status.UnderReview,
      room_status.OfferMade,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_17_test() {
  assert room_rules.can_transition(
      room_status.UnderReview,
      room_status.OfferAccepted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_18_test() {
  assert room_rules.can_transition(
      room_status.UnderReview,
      room_status.OfferDeclined,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_19_test() {
  assert room_rules.can_transition(room_status.UnderReview, room_status.Signed)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_20_test() {
  assert room_rules.can_transition(room_status.UnderReview, room_status.Closed)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_21_test() {
  assert room_rules.can_transition(
      room_status.ContactPlanned,
      room_status.Watching,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_22_test() {
  assert room_rules.can_transition(
      room_status.ContactPlanned,
      room_status.TrialRequested,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_23_test() {
  assert room_rules.can_transition(
      room_status.ContactPlanned,
      room_status.TrialScheduled,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_24_test() {
  assert room_rules.can_transition(
      room_status.ContactPlanned,
      room_status.TrialCompleted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_25_test() {
  assert room_rules.can_transition(
      room_status.ContactPlanned,
      room_status.OfferConsideration,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_26_test() {
  assert room_rules.can_transition(
      room_status.ContactPlanned,
      room_status.OfferMade,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_27_test() {
  assert room_rules.can_transition(
      room_status.ContactPlanned,
      room_status.OfferAccepted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_28_test() {
  assert room_rules.can_transition(
      room_status.ContactPlanned,
      room_status.OfferDeclined,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_29_test() {
  assert room_rules.can_transition(
      room_status.ContactPlanned,
      room_status.Signed,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_30_test() {
  assert room_rules.can_transition(
      room_status.ContactPlanned,
      room_status.Closed,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_31_test() {
  assert room_rules.can_transition(room_status.Contacted, room_status.Watching)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_32_test() {
  assert room_rules.can_transition(
      room_status.Contacted,
      room_status.ContactPlanned,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_33_test() {
  assert room_rules.can_transition(
      room_status.Contacted,
      room_status.TrialScheduled,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_34_test() {
  assert room_rules.can_transition(
      room_status.Contacted,
      room_status.TrialCompleted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_35_test() {
  assert room_rules.can_transition(room_status.Contacted, room_status.OfferMade)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_36_test() {
  assert room_rules.can_transition(
      room_status.Contacted,
      room_status.OfferAccepted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_37_test() {
  assert room_rules.can_transition(
      room_status.Contacted,
      room_status.OfferDeclined,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_38_test() {
  assert room_rules.can_transition(room_status.Contacted, room_status.Signed)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_39_test() {
  assert room_rules.can_transition(room_status.Contacted, room_status.Closed)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_40_test() {
  assert room_rules.can_transition(
      room_status.Shortlisted,
      room_status.Watching,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_41_test() {
  assert room_rules.can_transition(
      room_status.Shortlisted,
      room_status.Contacted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_42_test() {
  assert room_rules.can_transition(
      room_status.Shortlisted,
      room_status.TrialScheduled,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_43_test() {
  assert room_rules.can_transition(
      room_status.Shortlisted,
      room_status.TrialCompleted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_44_test() {
  assert room_rules.can_transition(
      room_status.Shortlisted,
      room_status.OfferMade,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_45_test() {
  assert room_rules.can_transition(
      room_status.Shortlisted,
      room_status.OfferAccepted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_46_test() {
  assert room_rules.can_transition(
      room_status.Shortlisted,
      room_status.OfferDeclined,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_47_test() {
  assert room_rules.can_transition(room_status.Shortlisted, room_status.Signed)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_48_test() {
  assert room_rules.can_transition(room_status.Shortlisted, room_status.Closed)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_49_test() {
  assert room_rules.can_transition(room_status.Priority, room_status.Watching)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_50_test() {
  assert room_rules.can_transition(
      room_status.Priority,
      room_status.UnderReview,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_51_test() {
  assert room_rules.can_transition(room_status.Priority, room_status.Contacted)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_52_test() {
  assert room_rules.can_transition(
      room_status.Priority,
      room_status.TrialScheduled,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_53_test() {
  assert room_rules.can_transition(
      room_status.Priority,
      room_status.TrialCompleted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_54_test() {
  assert room_rules.can_transition(room_status.Priority, room_status.OfferMade)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_55_test() {
  assert room_rules.can_transition(
      room_status.Priority,
      room_status.OfferAccepted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_56_test() {
  assert room_rules.can_transition(
      room_status.Priority,
      room_status.OfferDeclined,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_57_test() {
  assert room_rules.can_transition(room_status.Priority, room_status.Signed)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_58_test() {
  assert room_rules.can_transition(room_status.Priority, room_status.Closed)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_59_test() {
  assert room_rules.can_transition(
      room_status.TrialRequested,
      room_status.Watching,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_60_test() {
  assert room_rules.can_transition(
      room_status.TrialRequested,
      room_status.UnderReview,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_61_test() {
  assert room_rules.can_transition(
      room_status.TrialRequested,
      room_status.ContactPlanned,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_62_test() {
  assert room_rules.can_transition(
      room_status.TrialRequested,
      room_status.Contacted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_63_test() {
  assert room_rules.can_transition(
      room_status.TrialRequested,
      room_status.TrialCompleted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_64_test() {
  assert room_rules.can_transition(
      room_status.TrialRequested,
      room_status.OfferConsideration,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_65_test() {
  assert room_rules.can_transition(
      room_status.TrialRequested,
      room_status.OfferMade,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_66_test() {
  assert room_rules.can_transition(
      room_status.TrialRequested,
      room_status.OfferAccepted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_67_test() {
  assert room_rules.can_transition(
      room_status.TrialRequested,
      room_status.OfferDeclined,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_68_test() {
  assert room_rules.can_transition(
      room_status.TrialRequested,
      room_status.Signed,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_69_test() {
  assert room_rules.can_transition(
      room_status.TrialRequested,
      room_status.Closed,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_70_test() {
  assert room_rules.can_transition(
      room_status.TrialScheduled,
      room_status.Watching,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_71_test() {
  assert room_rules.can_transition(
      room_status.TrialScheduled,
      room_status.UnderReview,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_72_test() {
  assert room_rules.can_transition(
      room_status.TrialScheduled,
      room_status.ContactPlanned,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_73_test() {
  assert room_rules.can_transition(
      room_status.TrialScheduled,
      room_status.Contacted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_74_test() {
  assert room_rules.can_transition(
      room_status.TrialScheduled,
      room_status.Shortlisted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_75_test() {
  assert room_rules.can_transition(
      room_status.TrialScheduled,
      room_status.Priority,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_76_test() {
  assert room_rules.can_transition(
      room_status.TrialScheduled,
      room_status.OfferConsideration,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_77_test() {
  assert room_rules.can_transition(
      room_status.TrialScheduled,
      room_status.OfferMade,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_78_test() {
  assert room_rules.can_transition(
      room_status.TrialScheduled,
      room_status.OfferAccepted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_79_test() {
  assert room_rules.can_transition(
      room_status.TrialScheduled,
      room_status.OfferDeclined,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_80_test() {
  assert room_rules.can_transition(
      room_status.TrialScheduled,
      room_status.Signed,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_81_test() {
  assert room_rules.can_transition(
      room_status.TrialScheduled,
      room_status.Closed,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_82_test() {
  assert room_rules.can_transition(
      room_status.TrialCompleted,
      room_status.Watching,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_83_test() {
  assert room_rules.can_transition(
      room_status.TrialCompleted,
      room_status.UnderReview,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_84_test() {
  assert room_rules.can_transition(
      room_status.TrialCompleted,
      room_status.ContactPlanned,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_85_test() {
  assert room_rules.can_transition(
      room_status.TrialCompleted,
      room_status.Contacted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_86_test() {
  assert room_rules.can_transition(
      room_status.TrialCompleted,
      room_status.TrialRequested,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_87_test() {
  assert room_rules.can_transition(
      room_status.TrialCompleted,
      room_status.TrialScheduled,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_88_test() {
  assert room_rules.can_transition(
      room_status.TrialCompleted,
      room_status.OfferMade,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_89_test() {
  assert room_rules.can_transition(
      room_status.TrialCompleted,
      room_status.OfferAccepted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_90_test() {
  assert room_rules.can_transition(
      room_status.TrialCompleted,
      room_status.OfferDeclined,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_91_test() {
  assert room_rules.can_transition(
      room_status.TrialCompleted,
      room_status.Signed,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_92_test() {
  assert room_rules.can_transition(
      room_status.TrialCompleted,
      room_status.Closed,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_93_test() {
  assert room_rules.can_transition(
      room_status.OfferConsideration,
      room_status.Watching,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_94_test() {
  assert room_rules.can_transition(
      room_status.OfferConsideration,
      room_status.UnderReview,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_95_test() {
  assert room_rules.can_transition(
      room_status.OfferConsideration,
      room_status.ContactPlanned,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_96_test() {
  assert room_rules.can_transition(
      room_status.OfferConsideration,
      room_status.Contacted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_97_test() {
  assert room_rules.can_transition(
      room_status.OfferConsideration,
      room_status.TrialRequested,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_98_test() {
  assert room_rules.can_transition(
      room_status.OfferConsideration,
      room_status.TrialScheduled,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_99_test() {
  assert room_rules.can_transition(
      room_status.OfferConsideration,
      room_status.TrialCompleted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_100_test() {
  assert room_rules.can_transition(
      room_status.OfferConsideration,
      room_status.OfferAccepted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_101_test() {
  assert room_rules.can_transition(
      room_status.OfferConsideration,
      room_status.OfferDeclined,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_102_test() {
  assert room_rules.can_transition(
      room_status.OfferConsideration,
      room_status.Signed,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_103_test() {
  assert room_rules.can_transition(
      room_status.OfferConsideration,
      room_status.Closed,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_104_test() {
  assert room_rules.can_transition(room_status.OfferMade, room_status.Watching)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_105_test() {
  assert room_rules.can_transition(
      room_status.OfferMade,
      room_status.UnderReview,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_106_test() {
  assert room_rules.can_transition(
      room_status.OfferMade,
      room_status.ContactPlanned,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_107_test() {
  assert room_rules.can_transition(room_status.OfferMade, room_status.Contacted)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_108_test() {
  assert room_rules.can_transition(
      room_status.OfferMade,
      room_status.Shortlisted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_109_test() {
  assert room_rules.can_transition(room_status.OfferMade, room_status.Priority)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_110_test() {
  assert room_rules.can_transition(
      room_status.OfferMade,
      room_status.TrialRequested,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_111_test() {
  assert room_rules.can_transition(
      room_status.OfferMade,
      room_status.TrialScheduled,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_112_test() {
  assert room_rules.can_transition(
      room_status.OfferMade,
      room_status.TrialCompleted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_113_test() {
  assert room_rules.can_transition(room_status.OfferMade, room_status.Closed)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_114_test() {
  assert room_rules.can_transition(
      room_status.OfferAccepted,
      room_status.Watching,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_115_test() {
  assert room_rules.can_transition(
      room_status.OfferAccepted,
      room_status.UnderReview,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_116_test() {
  assert room_rules.can_transition(
      room_status.OfferAccepted,
      room_status.ContactPlanned,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_117_test() {
  assert room_rules.can_transition(
      room_status.OfferAccepted,
      room_status.Contacted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_118_test() {
  assert room_rules.can_transition(
      room_status.OfferAccepted,
      room_status.Shortlisted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_119_test() {
  assert room_rules.can_transition(
      room_status.OfferAccepted,
      room_status.Priority,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_120_test() {
  assert room_rules.can_transition(
      room_status.OfferAccepted,
      room_status.TrialRequested,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_121_test() {
  assert room_rules.can_transition(
      room_status.OfferAccepted,
      room_status.TrialScheduled,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_122_test() {
  assert room_rules.can_transition(
      room_status.OfferAccepted,
      room_status.TrialCompleted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_123_test() {
  assert room_rules.can_transition(
      room_status.OfferAccepted,
      room_status.OfferConsideration,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_124_test() {
  assert room_rules.can_transition(
      room_status.OfferAccepted,
      room_status.OfferMade,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_125_test() {
  assert room_rules.can_transition(
      room_status.OfferAccepted,
      room_status.OfferDeclined,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_126_test() {
  assert room_rules.can_transition(
      room_status.OfferDeclined,
      room_status.Watching,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_127_test() {
  assert room_rules.can_transition(
      room_status.OfferDeclined,
      room_status.ContactPlanned,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_128_test() {
  assert room_rules.can_transition(
      room_status.OfferDeclined,
      room_status.Contacted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_129_test() {
  assert room_rules.can_transition(
      room_status.OfferDeclined,
      room_status.TrialRequested,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_130_test() {
  assert room_rules.can_transition(
      room_status.OfferDeclined,
      room_status.TrialScheduled,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_131_test() {
  assert room_rules.can_transition(
      room_status.OfferDeclined,
      room_status.TrialCompleted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_132_test() {
  assert room_rules.can_transition(
      room_status.OfferDeclined,
      room_status.OfferConsideration,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_133_test() {
  assert room_rules.can_transition(
      room_status.OfferDeclined,
      room_status.OfferMade,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_134_test() {
  assert room_rules.can_transition(
      room_status.OfferDeclined,
      room_status.OfferAccepted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_135_test() {
  assert room_rules.can_transition(
      room_status.OfferDeclined,
      room_status.Signed,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_136_test() {
  assert room_rules.can_transition(room_status.Signed, room_status.Watching)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_137_test() {
  assert room_rules.can_transition(room_status.Signed, room_status.UnderReview)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_138_test() {
  assert room_rules.can_transition(
      room_status.Signed,
      room_status.ContactPlanned,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_139_test() {
  assert room_rules.can_transition(room_status.Signed, room_status.Contacted)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_140_test() {
  assert room_rules.can_transition(room_status.Signed, room_status.Shortlisted)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_141_test() {
  assert room_rules.can_transition(room_status.Signed, room_status.Priority)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_142_test() {
  assert room_rules.can_transition(
      room_status.Signed,
      room_status.TrialRequested,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_143_test() {
  assert room_rules.can_transition(
      room_status.Signed,
      room_status.TrialScheduled,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_144_test() {
  assert room_rules.can_transition(
      room_status.Signed,
      room_status.TrialCompleted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_145_test() {
  assert room_rules.can_transition(
      room_status.Signed,
      room_status.OfferConsideration,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_146_test() {
  assert room_rules.can_transition(room_status.Signed, room_status.OfferMade)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_147_test() {
  assert room_rules.can_transition(
      room_status.Signed,
      room_status.OfferAccepted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_148_test() {
  assert room_rules.can_transition(
      room_status.Signed,
      room_status.OfferDeclined,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_149_test() {
  assert room_rules.can_transition(room_status.Signed, room_status.OnHold)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_150_test() {
  assert room_rules.can_transition(room_status.Signed, room_status.Withdrawn)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_151_test() {
  assert room_rules.can_transition(room_status.Signed, room_status.Archived)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_152_test() {
  assert room_rules.can_transition(room_status.OnHold, room_status.Watching)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_153_test() {
  assert room_rules.can_transition(room_status.OnHold, room_status.Contacted)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_154_test() {
  assert room_rules.can_transition(
      room_status.OnHold,
      room_status.TrialScheduled,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_155_test() {
  assert room_rules.can_transition(
      room_status.OnHold,
      room_status.TrialCompleted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_156_test() {
  assert room_rules.can_transition(room_status.OnHold, room_status.OfferMade)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_157_test() {
  assert room_rules.can_transition(
      room_status.OnHold,
      room_status.OfferAccepted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_158_test() {
  assert room_rules.can_transition(
      room_status.OnHold,
      room_status.OfferDeclined,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_159_test() {
  assert room_rules.can_transition(room_status.OnHold, room_status.Signed)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_160_test() {
  assert room_rules.can_transition(room_status.Withdrawn, room_status.Watching)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_161_test() {
  assert room_rules.can_transition(
      room_status.Withdrawn,
      room_status.ContactPlanned,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_162_test() {
  assert room_rules.can_transition(room_status.Withdrawn, room_status.Contacted)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_163_test() {
  assert room_rules.can_transition(
      room_status.Withdrawn,
      room_status.Shortlisted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_164_test() {
  assert room_rules.can_transition(room_status.Withdrawn, room_status.Priority)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_165_test() {
  assert room_rules.can_transition(
      room_status.Withdrawn,
      room_status.TrialRequested,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_166_test() {
  assert room_rules.can_transition(
      room_status.Withdrawn,
      room_status.TrialScheduled,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_167_test() {
  assert room_rules.can_transition(
      room_status.Withdrawn,
      room_status.TrialCompleted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_168_test() {
  assert room_rules.can_transition(
      room_status.Withdrawn,
      room_status.OfferConsideration,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_169_test() {
  assert room_rules.can_transition(room_status.Withdrawn, room_status.OfferMade)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_170_test() {
  assert room_rules.can_transition(
      room_status.Withdrawn,
      room_status.OfferAccepted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_171_test() {
  assert room_rules.can_transition(
      room_status.Withdrawn,
      room_status.OfferDeclined,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_172_test() {
  assert room_rules.can_transition(room_status.Withdrawn, room_status.Signed)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_173_test() {
  assert room_rules.can_transition(room_status.Withdrawn, room_status.OnHold)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_174_test() {
  assert room_rules.can_transition(room_status.Archived, room_status.Watching)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_175_test() {
  assert room_rules.can_transition(
      room_status.Archived,
      room_status.ContactPlanned,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_176_test() {
  assert room_rules.can_transition(room_status.Archived, room_status.Contacted)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_177_test() {
  assert room_rules.can_transition(
      room_status.Archived,
      room_status.Shortlisted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_178_test() {
  assert room_rules.can_transition(room_status.Archived, room_status.Priority)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_179_test() {
  assert room_rules.can_transition(
      room_status.Archived,
      room_status.TrialRequested,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_180_test() {
  assert room_rules.can_transition(
      room_status.Archived,
      room_status.TrialScheduled,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_181_test() {
  assert room_rules.can_transition(
      room_status.Archived,
      room_status.TrialCompleted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_182_test() {
  assert room_rules.can_transition(
      room_status.Archived,
      room_status.OfferConsideration,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_183_test() {
  assert room_rules.can_transition(room_status.Archived, room_status.OfferMade)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_184_test() {
  assert room_rules.can_transition(
      room_status.Archived,
      room_status.OfferAccepted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_185_test() {
  assert room_rules.can_transition(
      room_status.Archived,
      room_status.OfferDeclined,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_186_test() {
  assert room_rules.can_transition(room_status.Archived, room_status.Signed)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_187_test() {
  assert room_rules.can_transition(room_status.Archived, room_status.OnHold)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_188_test() {
  assert room_rules.can_transition(room_status.Archived, room_status.Withdrawn)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_189_test() {
  assert room_rules.can_transition(room_status.Closed, room_status.Watching)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_190_test() {
  assert room_rules.can_transition(
      room_status.Closed,
      room_status.ContactPlanned,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_191_test() {
  assert room_rules.can_transition(room_status.Closed, room_status.Contacted)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_192_test() {
  assert room_rules.can_transition(room_status.Closed, room_status.Shortlisted)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_193_test() {
  assert room_rules.can_transition(room_status.Closed, room_status.Priority)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_194_test() {
  assert room_rules.can_transition(
      room_status.Closed,
      room_status.TrialRequested,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_195_test() {
  assert room_rules.can_transition(
      room_status.Closed,
      room_status.TrialScheduled,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_196_test() {
  assert room_rules.can_transition(
      room_status.Closed,
      room_status.TrialCompleted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_197_test() {
  assert room_rules.can_transition(
      room_status.Closed,
      room_status.OfferConsideration,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_198_test() {
  assert room_rules.can_transition(room_status.Closed, room_status.OfferMade)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_199_test() {
  assert room_rules.can_transition(
      room_status.Closed,
      room_status.OfferAccepted,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_200_test() {
  assert room_rules.can_transition(
      room_status.Closed,
      room_status.OfferDeclined,
    )
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_201_test() {
  assert room_rules.can_transition(room_status.Closed, room_status.Signed)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_202_test() {
  assert room_rules.can_transition(room_status.Closed, room_status.OnHold)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_203_test() {
  assert room_rules.can_transition(room_status.Closed, room_status.Withdrawn)
    == False
}

// rooms: canTransition — [neg] 204 status pairs are refused by the table
pub fn neg_204_status_pairs_are_refused_by_the_table_204_test() {
  assert room_rules.can_transition(room_status.Closed, room_status.Archived)
    == False
}

// rooms: validateTransition — [neg] a no-op status change is refused
pub fn neg_a_no_op_status_change_is_refused_test() {
  assert json.to_string(
      room_rules.transition_json(
        room_rules.validate_transition(
          room_status.Watching,
          room_status.Watching,
          [],
        ),
      ),
    )
    == "{\"ok\":false,\"error\":\"ROOM_STATUS_UNCHANGED\",\"message\":\"This room is already Watching.\"}"
}

// rooms: validateTransition — [neg] an invalid jump is refused by the validator too
pub fn neg_an_invalid_jump_is_refused_by_the_validator_too_test() {
  assert json.to_string(
      room_rules.transition_json(
        room_rules.validate_transition(
          room_status.Watching,
          room_status.Signed,
          [],
        ),
      ),
    )
    == "{\"ok\":false,\"error\":\"ROOM_TRANSITION_INVALID\",\"message\":\"A room cannot move from Watching to Signed.\",\"allowed\":[\"under_review\",\"shortlisted\",\"contact_planned\",\"on_hold\",\"withdrawn\",\"archived\"]}"
}

// rooms: validateTransition — [neg] withdrawn cannot be recorded without a reason
pub fn neg_withdrawn_cannot_be_recorded_without_a_reason_test() {
  assert json.to_string(
      room_rules.transition_json(
        room_rules.validate_transition(
          room_status.Watching,
          room_status.Withdrawn,
          [],
        ),
      ),
    )
    == "{\"ok\":false,\"error\":\"ROOM_REASON_REQUIRED\",\"message\":\"Recording why keeps the decision useful later — Withdrawn needs at least one reason.\"}"
}

// rooms: validateTransition — withdrawn is accepted with a reason
pub fn withdrawn_is_accepted_with_a_reason_test() {
  assert json.to_string(
      room_rules.transition_json(
        room_rules.validate_transition(
          room_status.Watching,
          room_status.Withdrawn,
          ["budget"],
        ),
      ),
    )
    == "{\"ok\":true,\"reopen\":false,\"needsReason\":true,\"snapshot\":true,\"requiresEvidence\":null}"
}

// rooms: validateTransition — [neg] archived cannot be recorded without a reason
pub fn neg_archived_cannot_be_recorded_without_a_reason_test() {
  assert json.to_string(
      room_rules.transition_json(
        room_rules.validate_transition(
          room_status.Watching,
          room_status.Archived,
          [],
        ),
      ),
    )
    == "{\"ok\":false,\"error\":\"ROOM_REASON_REQUIRED\",\"message\":\"Recording why keeps the decision useful later — Archived needs at least one reason.\"}"
}

// rooms: validateTransition — archived is accepted with a reason
pub fn archived_is_accepted_with_a_reason_test() {
  assert json.to_string(
      room_rules.transition_json(
        room_rules.validate_transition(
          room_status.Watching,
          room_status.Archived,
          ["budget"],
        ),
      ),
    )
    == "{\"ok\":true,\"reopen\":false,\"needsReason\":true,\"snapshot\":true,\"requiresEvidence\":null}"
}

// rooms: validateTransition — [neg] closed cannot be recorded without a reason
pub fn neg_closed_cannot_be_recorded_without_a_reason_test() {
  assert json.to_string(
      room_rules.transition_json(
        room_rules.validate_transition(
          room_status.OfferAccepted,
          room_status.Closed,
          [],
        ),
      ),
    )
    == "{\"ok\":false,\"error\":\"ROOM_REASON_REQUIRED\",\"message\":\"Recording why keeps the decision useful later — Closed needs at least one reason.\"}"
}

// rooms: validateTransition — closed is accepted with a reason
pub fn closed_is_accepted_with_a_reason_test() {
  assert json.to_string(
      room_rules.transition_json(
        room_rules.validate_transition(
          room_status.OfferAccepted,
          room_status.Closed,
          ["budget"],
        ),
      ),
    )
    == "{\"ok\":true,\"reopen\":false,\"needsReason\":true,\"snapshot\":true,\"requiresEvidence\":null}"
}

// rooms: validateTransition — reopening is flagged as a reopen
pub fn reopening_is_flagged_as_a_reopen_test() {
  assert json.to_string(
      room_rules.transition_json(
        room_rules.validate_transition(
          room_status.Archived,
          room_status.UnderReview,
          ["continue_monitoring"],
        ),
      ),
    )
    == "{\"ok\":true,\"reopen\":true,\"needsReason\":false,\"snapshot\":false,\"requiresEvidence\":null}"
}

// rooms: validateTransition — shortlisting captures a snapshot
pub fn shortlisting_captures_a_snapshot_test() {
  assert json.to_string(
      room_rules.transition_json(
        room_rules.validate_transition(
          room_status.UnderReview,
          room_status.Shortlisted,
          [],
        ),
      ),
    )
    == "{\"ok\":true,\"reopen\":false,\"needsReason\":false,\"snapshot\":true,\"requiresEvidence\":null}"
}

// rooms: validateReasonCodes — valid codes from two categories are accepted
pub fn valid_codes_from_two_categories_are_accepted_test() {
  assert json.to_string(
      room_rules.reasons_json(
        room_rules.validate_reason_codes(["technical_fit", "budget"]),
      ),
    )
    == "{\"ok\":true,\"codes\":[\"technical_fit\",\"budget\"]}"
}

// rooms: validateReasonCodes — codes are normalised to lower case
pub fn codes_are_normalised_to_lower_case_test() {
  assert json.to_string(
      room_rules.reasons_json(
        room_rules.validate_reason_codes(["TECHNICAL_FIT"]),
      ),
    )
    == "{\"ok\":true,\"codes\":[\"technical_fit\"]}"
}

// rooms: validateReasonCodes — duplicate codes are folded
pub fn duplicate_codes_are_folded_test() {
  assert json.to_string(
      room_rules.reasons_json(
        room_rules.validate_reason_codes(["budget", "budget"]),
      ),
    )
    == "{\"ok\":true,\"codes\":[\"budget\"]}"
}

// rooms: validateReasonCodes — [neg] "race" can never be recorded as a recruitment reason
pub fn neg_race_can_never_be_recorded_as_a_recruitment_reason_test() {
  assert json.to_string(
      room_rules.reasons_json(room_rules.validate_reason_codes(["race"])),
    )
    == "{\"ok\":false,\"error\":\"ROOM_REASON_PROHIBITED\",\"message\":\"A protected characteristic can never be recorded as a recruitment reason.\",\"prohibited\":[\"race\"]}"
}

// rooms: validateReasonCodes — [neg] "nationality" can never be recorded as a recruitment reason
pub fn neg_nationality_can_never_be_recorded_as_a_recruitment_reason_test() {
  assert json.to_string(
      room_rules.reasons_json(room_rules.validate_reason_codes(["nationality"])),
    )
    == "{\"ok\":false,\"error\":\"ROOM_REASON_PROHIBITED\",\"message\":\"A protected characteristic can never be recorded as a recruitment reason.\",\"prohibited\":[\"nationality\"]}"
}

// rooms: validateReasonCodes — [neg] "religion" can never be recorded as a recruitment reason
pub fn neg_religion_can_never_be_recorded_as_a_recruitment_reason_test() {
  assert json.to_string(
      room_rules.reasons_json(room_rules.validate_reason_codes(["religion"])),
    )
    == "{\"ok\":false,\"error\":\"ROOM_REASON_PROHIBITED\",\"message\":\"A protected characteristic can never be recorded as a recruitment reason.\",\"prohibited\":[\"religion\"]}"
}

// rooms: validateReasonCodes — [neg] "disability" can never be recorded as a recruitment reason
pub fn neg_disability_can_never_be_recorded_as_a_recruitment_reason_test() {
  assert json.to_string(
      room_rules.reasons_json(room_rules.validate_reason_codes(["disability"])),
    )
    == "{\"ok\":false,\"error\":\"ROOM_REASON_PROHIBITED\",\"message\":\"A protected characteristic can never be recorded as a recruitment reason.\",\"prohibited\":[\"disability\"]}"
}

// rooms: validateReasonCodes — [neg] "sexuality" can never be recorded as a recruitment reason
pub fn neg_sexuality_can_never_be_recorded_as_a_recruitment_reason_test() {
  assert json.to_string(
      room_rules.reasons_json(room_rules.validate_reason_codes(["sexuality"])),
    )
    == "{\"ok\":false,\"error\":\"ROOM_REASON_PROHIBITED\",\"message\":\"A protected characteristic can never be recorded as a recruitment reason.\",\"prohibited\":[\"sexuality\"]}"
}

// rooms: validateReasonCodes — [neg] "socioeconomic" can never be recorded as a recruitment reason
pub fn neg_socioeconomic_can_never_be_recorded_as_a_recruitment_reason_test() {
  assert json.to_string(
      room_rules.reasons_json(
        room_rules.validate_reason_codes(["socioeconomic"]),
      ),
    )
    == "{\"ok\":false,\"error\":\"ROOM_REASON_PROHIBITED\",\"message\":\"A protected characteristic can never be recorded as a recruitment reason.\",\"prohibited\":[\"socioeconomic\"]}"
}

// rooms: validateReasonCodes — [neg] "postcode" can never be recorded as a recruitment reason
pub fn neg_postcode_can_never_be_recorded_as_a_recruitment_reason_test() {
  assert json.to_string(
      room_rules.reasons_json(room_rules.validate_reason_codes(["postcode"])),
    )
    == "{\"ok\":false,\"error\":\"ROOM_REASON_PROHIBITED\",\"message\":\"A protected characteristic can never be recorded as a recruitment reason.\",\"prohibited\":[\"postcode\"]}"
}

// rooms: validateReasonCodes — [neg] "pregnancy" can never be recorded as a recruitment reason
pub fn neg_pregnancy_can_never_be_recorded_as_a_recruitment_reason_test() {
  assert json.to_string(
      room_rules.reasons_json(room_rules.validate_reason_codes(["pregnancy"])),
    )
    == "{\"ok\":false,\"error\":\"ROOM_REASON_PROHIBITED\",\"message\":\"A protected characteristic can never be recorded as a recruitment reason.\",\"prohibited\":[\"pregnancy\"]}"
}

// rooms: validateReasonCodes — [neg] one prohibited code poisons the whole list
pub fn neg_one_prohibited_code_poisons_the_whole_list_test() {
  assert json.to_string(
      room_rules.reasons_json(
        room_rules.validate_reason_codes(["technical_fit", "ethnicity"]),
      ),
    )
    == "{\"ok\":false,\"error\":\"ROOM_REASON_PROHIBITED\",\"message\":\"A protected characteristic can never be recorded as a recruitment reason.\",\"prohibited\":[\"ethnicity\"]}"
}

// rooms: validateReasonCodes — [neg] the refusal names the prohibited code for the audit
pub fn neg_the_refusal_names_the_prohibited_code_for_the_audit_test() {
  assert json.to_string(
      room_rules.reasons_json(room_rules.validate_reason_codes(["ethnicity"])),
    )
    == "{\"ok\":false,\"error\":\"ROOM_REASON_PROHIBITED\",\"message\":\"A protected characteristic can never be recorded as a recruitment reason.\",\"prohibited\":[\"ethnicity\"]}"
}

// rooms: validateReasonCodes — [neg] a code outside the taxonomy is refused
pub fn neg_a_code_outside_the_taxonomy_is_refused_test() {
  assert json.to_string(
      room_rules.reasons_json(
        room_rules.validate_reason_codes(["made_up_code"]),
      ),
    )
    == "{\"ok\":false,\"error\":\"ROOM_REASON_UNKNOWN\",\"message\":\"Reasons must come from the ScoutBox recruitment reason taxonomy.\",\"unknown\":[\"made_up_code\"]}"
}

// rooms: validateReasonCodes — [neg] too many reasons are refused
pub fn neg_too_many_reasons_are_refused_test() {
  assert json.to_string(
      room_rules.reasons_json(
        room_rules.validate_reason_codes([
          "budget0",
          "budget1",
          "budget2",
          "budget3",
          "budget4",
          "budget5",
          "budget6",
          "budget7",
          "budget8",
        ]),
      ),
    )
    == "{\"ok\":false,\"error\":\"ROOM_REASONS_TOO_MANY\",\"message\":\"Record up to six reasons.\"}"
}

// rooms: validateDecision — a shortlist decision with a reason is valid
pub fn a_shortlist_decision_with_a_reason_is_valid_test() {
  assert json.to_string(
      room_rules.decision_json(room_rules.validate_decision(
        room_decisions.Shortlist,
        ["technical_fit"],
        None,
      )),
    )
    == "{\"ok\":true,\"recommendation\":\"shortlist\",\"codes\":[\"technical_fit\"],\"note\":null}"
}

// rooms: validateDecision — recording "no decision yet" is legitimate
pub fn recording_no_decision_yet_is_legitimate_test() {
  assert json.to_string(
      room_rules.decision_json(room_rules.validate_decision(
        room_decisions.NoDecision,
        [],
        None,
      )),
    )
    == "{\"ok\":true,\"recommendation\":\"no_decision\",\"codes\":[],\"note\":null}"
}

// rooms: validateDecision — [neg] archiving without a reason is refused
pub fn neg_archiving_without_a_reason_is_refused_test() {
  assert json.to_string(
      room_rules.decision_json(room_rules.validate_decision(
        room_decisions.Archive,
        [],
        None,
      )),
    )
    == "{\"ok\":false,\"error\":\"ROOM_REASON_REQUIRED\",\"message\":\"Archiving needs at least one reason so the decision stays useful later.\"}"
}

// rooms: validateDecision — [neg] archiving for a protected trait is refused
pub fn neg_archiving_for_a_protected_trait_is_refused_test() {
  assert json.to_string(
      room_rules.decision_json(room_rules.validate_decision(
        room_decisions.Archive,
        ["race"],
        None,
      )),
    )
    == "{\"ok\":false,\"error\":\"ROOM_REASON_PROHIBITED\",\"message\":\"A protected characteristic can never be recorded as a recruitment reason.\",\"prohibited\":[\"race\"]}"
}

// rooms: validateDecision — [neg] an oversized internal note is refused
pub fn neg_an_oversized_internal_note_is_refused_test() {
  assert json.to_string(
      room_rules.decision_json(room_rules.validate_decision(
        room_decisions.Offer,
        [],
        Some(
          "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        ),
      )),
    )
    == "{\"ok\":false,\"error\":\"ROOM_NOTE_TOO_LONG\",\"message\":\"Keep the internal note under 2000 characters.\"}"
}

// rooms: decisionReadiness — readiness reports six workflow items
pub fn readiness_reports_six_workflow_items_test() {
  assert json.to_string(
      room_rules.readiness_json(room_rules.decision_readiness(
        room_rules.no_readiness,
      )),
    )
    == "{\"items\":[{\"key\":\"assessments\",\"label\":\"Assessments\",\"value\":\"0/0 submitted\",\"complete\":false,\"outstanding\":\"None assigned yet\"},{\"key\":\"recent_full_match\",\"label\":\"Recent full match\",\"value\":\"Not available\",\"complete\":false,\"outstanding\":\"No recent full-match evidence on record\"},{\"key\":\"coach_reference\",\"label\":\"Coach reference\",\"value\":\"Not available\",\"complete\":false,\"outstanding\":\"No verified coach reference on record\"},{\"key\":\"combine\",\"label\":\"Combine\",\"value\":\"No verified result\",\"complete\":false,\"outstanding\":\"No production-supported Combine Verified result is currently available\"},{\"key\":\"trial\",\"label\":\"Trial\",\"value\":\"Not required yet\",\"complete\":false,\"outstanding\":null},{\"key\":\"open_tasks\",\"label\":\"Open tasks\",\"value\":\"0\",\"complete\":true,\"outstanding\":null}],\"complete\":1,\"total\":6,\"blockers\":[{\"key\":\"assessments\",\"text\":\"None assigned yet\"},{\"key\":\"recent_full_match\",\"text\":\"No recent full-match evidence on record\"},{\"key\":\"coach_reference\",\"text\":\"No verified coach reference on record\"},{\"key\":\"combine\",\"text\":\"No production-supported Combine Verified result is currently available\"}],\"openEvidenceRequests\":0,\"note\":\"Workflow completeness, not a recommendation. ScoutBox does not decide whether to sign a player.\"}"
}

// rooms: decisionReadiness — a complete workflow reports no blockers
pub fn a_complete_workflow_reports_no_blockers_test() {
  assert json.to_string(
      room_rules.readiness_json(room_rules.decision_readiness(
        room_rules.ReadinessInput(
          ..room_rules.no_readiness,
          assessments_assigned: 2,
          assessments_submitted: 2,
          recent_full_match: True,
          coach_reference: True,
          combine_verified: 2,
          trial_state: room_rules.Reported,
          open_tasks: 0,
        ),
      )),
    )
    == "{\"items\":[{\"key\":\"assessments\",\"label\":\"Assessments\",\"value\":\"2/2 submitted\",\"complete\":true,\"outstanding\":null},{\"key\":\"recent_full_match\",\"label\":\"Recent full match\",\"value\":\"Available\",\"complete\":true,\"outstanding\":null},{\"key\":\"coach_reference\",\"label\":\"Coach reference\",\"value\":\"Available\",\"complete\":true,\"outstanding\":null},{\"key\":\"combine\",\"label\":\"Combine\",\"value\":\"2 verified\",\"complete\":true,\"outstanding\":null},{\"key\":\"trial\",\"label\":\"Trial\",\"value\":\"Reported\",\"complete\":true,\"outstanding\":null},{\"key\":\"open_tasks\",\"label\":\"Open tasks\",\"value\":\"0\",\"complete\":true,\"outstanding\":null}],\"complete\":6,\"total\":6,\"blockers\":[],\"openEvidenceRequests\":0,\"note\":\"Workflow completeness, not a recommendation. ScoutBox does not decide whether to sign a player.\"}"
}

// rooms: roomHealth — an archived room with a decision reads as decision recorded
pub fn an_archived_room_with_a_decision_reads_as_decision_recorded_test() {
  assert room_rules.room_health(
      Some(room_rules.Readiness(
        items: [
          room_rules.Item(
            key: room_rules.AssessmentsItem,
            label: "Assessments",
            value: "2/2 submitted",
            complete: True,
            outstanding: None,
          ),
          room_rules.Item(
            key: room_rules.RecentFullMatchItem,
            label: "Recent full match",
            value: "Available",
            complete: True,
            outstanding: None,
          ),
          room_rules.Item(
            key: room_rules.CoachReferenceItem,
            label: "Coach reference",
            value: "Available",
            complete: True,
            outstanding: None,
          ),
          room_rules.Item(
            key: room_rules.CombineItem,
            label: "Combine",
            value: "2 verified",
            complete: True,
            outstanding: None,
          ),
          room_rules.Item(
            key: room_rules.TrialItem,
            label: "Trial",
            value: "Reported",
            complete: True,
            outstanding: None,
          ),
          room_rules.Item(
            key: room_rules.OpenTasksItem,
            label: "Open tasks",
            value: "0",
            complete: True,
            outstanding: None,
          ),
        ],
        open_evidence_requests: 0,
      )),
      True,
      room_status.Archived,
    )
    == room_rules.DecisionRecorded
}

// rooms: decisionReadiness — an outstanding assessment shows as such
pub fn an_outstanding_assessment_shows_as_such_test() {
  assert json.to_string(
      room_rules.readiness_json(room_rules.decision_readiness(
        room_rules.ReadinessInput(
          ..room_rules.no_readiness,
          assessments_assigned: 2,
          assessments_submitted: 1,
        ),
      )),
    )
    == "{\"items\":[{\"key\":\"assessments\",\"label\":\"Assessments\",\"value\":\"1/2 submitted\",\"complete\":false,\"outstanding\":\"Awaiting submissions\"},{\"key\":\"recent_full_match\",\"label\":\"Recent full match\",\"value\":\"Not available\",\"complete\":false,\"outstanding\":\"No recent full-match evidence on record\"},{\"key\":\"coach_reference\",\"label\":\"Coach reference\",\"value\":\"Not available\",\"complete\":false,\"outstanding\":\"No verified coach reference on record\"},{\"key\":\"combine\",\"label\":\"Combine\",\"value\":\"No verified result\",\"complete\":false,\"outstanding\":\"No production-supported Combine Verified result is currently available\"},{\"key\":\"trial\",\"label\":\"Trial\",\"value\":\"Not required yet\",\"complete\":false,\"outstanding\":null},{\"key\":\"open_tasks\",\"label\":\"Open tasks\",\"value\":\"0\",\"complete\":true,\"outstanding\":null}],\"complete\":1,\"total\":6,\"blockers\":[{\"key\":\"assessments\",\"text\":\"Awaiting submissions\"},{\"key\":\"recent_full_match\",\"text\":\"No recent full-match evidence on record\"},{\"key\":\"coach_reference\",\"text\":\"No verified coach reference on record\"},{\"key\":\"combine\",\"text\":\"No production-supported Combine Verified result is currently available\"}],\"openEvidenceRequests\":0,\"note\":\"Workflow completeness, not a recommendation. ScoutBox does not decide whether to sign a player.\"}"
}

// rooms: roomHealth — an outstanding assessment shows as such
pub fn an_outstanding_assessment_shows_as_such_2_test() {
  assert room_rules.room_health(
      Some(room_rules.Readiness(
        items: [
          room_rules.Item(
            key: room_rules.AssessmentsItem,
            label: "Assessments",
            value: "1/2 submitted",
            complete: False,
            outstanding: Some("Awaiting submissions"),
          ),
          room_rules.Item(
            key: room_rules.RecentFullMatchItem,
            label: "Recent full match",
            value: "Not available",
            complete: False,
            outstanding: Some("No recent full-match evidence on record"),
          ),
          room_rules.Item(
            key: room_rules.CoachReferenceItem,
            label: "Coach reference",
            value: "Not available",
            complete: False,
            outstanding: Some("No verified coach reference on record"),
          ),
          room_rules.Item(
            key: room_rules.CombineItem,
            label: "Combine",
            value: "No verified result",
            complete: False,
            outstanding: Some(
              "No production-supported Combine Verified result is currently available",
            ),
          ),
          room_rules.Item(
            key: room_rules.TrialItem,
            label: "Trial",
            value: "Not required yet",
            complete: False,
            outstanding: None,
          ),
          room_rules.Item(
            key: room_rules.OpenTasksItem,
            label: "Open tasks",
            value: "0",
            complete: True,
            outstanding: None,
          ),
        ],
        open_evidence_requests: 0,
      )),
      False,
      room_status.UnderReview,
    )
    == room_rules.AssessmentOutstanding
}

// rooms: roomHealth — a complete workflow reads as ready for review
pub fn a_complete_workflow_reads_as_ready_for_review_test() {
  assert room_rules.room_health(
      Some(room_rules.Readiness(
        items: [
          room_rules.Item(
            key: room_rules.AssessmentsItem,
            label: "Assessments",
            value: "2/2 submitted",
            complete: True,
            outstanding: None,
          ),
          room_rules.Item(
            key: room_rules.RecentFullMatchItem,
            label: "Recent full match",
            value: "Available",
            complete: True,
            outstanding: None,
          ),
          room_rules.Item(
            key: room_rules.CoachReferenceItem,
            label: "Coach reference",
            value: "Available",
            complete: True,
            outstanding: None,
          ),
          room_rules.Item(
            key: room_rules.CombineItem,
            label: "Combine",
            value: "2 verified",
            complete: True,
            outstanding: None,
          ),
          room_rules.Item(
            key: room_rules.TrialItem,
            label: "Trial",
            value: "Reported",
            complete: True,
            outstanding: None,
          ),
          room_rules.Item(
            key: room_rules.OpenTasksItem,
            label: "Open tasks",
            value: "0",
            complete: True,
            outstanding: None,
          ),
        ],
        open_evidence_requests: 0,
      )),
      False,
      room_status.UnderReview,
    )
    == room_rules.ReadyForReview
}

// rooms: roomRole — the owner is the room lead
pub fn the_owner_is_the_room_lead_test() {
  assert room_rules.room_role(
      room_rules.Membership(
        owner: id.org_user("u1"),
        lead_scout: Some(id.org_user("u1")),
        assignees: [id.org_user("u2")],
        restricted: False,
        status: room_status.UnderReview,
      ),
      id.org_user("u1"),
      False,
    )
    == Some(room_rules.RoomLead)
}

// rooms: roomRole — an assignee is a contributor
pub fn an_assignee_is_a_contributor_test() {
  assert room_rules.room_role(
      room_rules.Membership(
        owner: id.org_user("u1"),
        lead_scout: Some(id.org_user("u1")),
        assignees: [id.org_user("u2")],
        restricted: False,
        status: room_status.UnderReview,
      ),
      id.org_user("u2"),
      False,
    )
    == Some(room_rules.Contributor)
}

// rooms: roomRole — another colleague is a contributor on an open, unrestricted room
pub fn another_colleague_is_a_contributor_on_an_open_unrestricted_room_test() {
  assert room_rules.room_role(
      room_rules.Membership(
        owner: id.org_user("u1"),
        lead_scout: Some(id.org_user("u1")),
        assignees: [id.org_user("u2")],
        restricted: False,
        status: room_status.UnderReview,
      ),
      id.org_user("u9"),
      False,
    )
    == Some(room_rules.Contributor)
}

// rooms: roomRole — a filed-away room is read-only to a colleague — its discussion is institutional memory
pub fn a_filed_away_room_is_read_only_to_a_colleague_its_discussion_is_institut_test() {
  assert room_rules.room_role(
      room_rules.Membership(
        owner: id.org_user("u1"),
        lead_scout: Some(id.org_user("u1")),
        assignees: [id.org_user("u2")],
        restricted: False,
        status: room_status.Archived,
      ),
      id.org_user("u9"),
      False,
    )
    == Some(room_rules.Viewer)
}

// rooms: roomCan — [neg] a colleague cannot add to an archived room’s discussion
pub fn neg_a_colleague_cannot_add_to_an_archived_room_s_discussion_test() {
  assert room_rules.room_can(Some(room_rules.Viewer), room_rules.Comment)
    == False
}

// rooms: roomRole — a recruitment lead administers any room
pub fn a_recruitment_lead_administers_any_room_test() {
  assert room_rules.room_role(
      room_rules.Membership(
        owner: id.org_user("u1"),
        lead_scout: Some(id.org_user("u1")),
        assignees: [id.org_user("u2")],
        restricted: False,
        status: room_status.UnderReview,
      ),
      id.org_user("u9"),
      True,
    )
    == Some(room_rules.RecruitmentAdmin)
}

// rooms: roomRole — [neg] a restricted room admits no unrelated colleague
pub fn neg_a_restricted_room_admits_no_unrelated_colleague_test() {
  assert room_rules.room_role(
      room_rules.Membership(
        owner: id.org_user("u1"),
        lead_scout: Some(id.org_user("u1")),
        assignees: [id.org_user("u2")],
        restricted: True,
        status: room_status.UnderReview,
      ),
      id.org_user("u9"),
      False,
    )
    == None
}

// rooms: roomCan — a viewer can read
pub fn a_viewer_can_read_test() {
  assert room_rules.room_can(Some(room_rules.Viewer), room_rules.Read) == True
}

// rooms: roomCan — a contributor comments and creates tasks
pub fn a_contributor_comments_and_creates_tasks_test() {
  assert room_rules.room_can(Some(room_rules.Contributor), room_rules.Comment)
    == True
}

// rooms: roomCan — a contributor comments and creates tasks
pub fn a_contributor_comments_and_creates_tasks_2_test() {
  assert room_rules.room_can(
      Some(room_rules.Contributor),
      room_rules.CreateTask,
    )
    == True
}

// rooms: roomCan — [neg] a contributor cannot move the room status
pub fn neg_a_contributor_cannot_move_the_room_status_test() {
  assert room_rules.room_can(Some(room_rules.Contributor), room_rules.SetStatus)
    == False
}

// rooms: roomCan — [neg] a contributor cannot record the decision
pub fn neg_a_contributor_cannot_record_the_decision_test() {
  assert room_rules.room_can(
      Some(room_rules.Contributor),
      room_rules.RecordDecision,
    )
    == False
}

// rooms: roomCan — a room lead decides and archives
pub fn a_room_lead_decides_and_archives_test() {
  assert room_rules.room_can(
      Some(room_rules.RoomLead),
      room_rules.RecordDecision,
    )
    == True
}

// rooms: roomCan — a room lead decides and archives
pub fn a_room_lead_decides_and_archives_2_test() {
  assert room_rules.room_can(Some(room_rules.RoomLead), room_rules.ArchiveRoom)
    == True
}

// rooms: roomCan — [neg] a room lead does not administer other rooms
pub fn neg_a_room_lead_does_not_administer_other_rooms_test() {
  assert room_rules.room_can(
      Some(room_rules.RoomLead),
      room_rules.ManageAnyRoom,
    )
    == False
}

// rooms: roomCan — a recruitment admin does
pub fn a_recruitment_admin_does_test() {
  assert room_rules.room_can(
      Some(room_rules.RecruitmentAdmin),
      room_rules.ManageAnyRoom,
    )
    == True
}

// rooms: roomCan — [neg] no role means no access at all
pub fn neg_no_role_means_no_access_at_all_test() {
  assert room_rules.room_can(None, room_rules.Read) == False
}

// rooms: canTaskTransition — the ordinary task path works
pub fn the_ordinary_task_path_works_test() {
  assert room_rules.can_task_transition(task_state.Open, task_state.InProgress)
    == True
}

// rooms: canTaskTransition — the ordinary task path works
pub fn the_ordinary_task_path_works_2_test() {
  assert room_rules.can_task_transition(task_state.InProgress, task_state.Done)
    == True
}

// rooms: canTaskTransition — a task can be reopened
pub fn a_task_can_be_reopened_test() {
  assert room_rules.can_task_transition(task_state.Done, task_state.Open)
    == True
}

// rooms: canTaskTransition — [neg] a done task cannot slide back to in progress
pub fn neg_a_done_task_cannot_slide_back_to_in_progress_test() {
  assert room_rules.can_task_transition(task_state.Done, task_state.InProgress)
    == False
}

// rooms: canTaskTransition — [neg] a cancelled task cannot be completed
pub fn neg_a_cancelled_task_cannot_be_completed_test() {
  assert room_rules.can_task_transition(task_state.Cancelled, task_state.Done)
    == False
}

// rooms: roomActivity — activity is newest first
pub fn activity_is_newest_first_test() {
  assert json.to_string(
      room_rules.activity_json(room_rules.room_activity(
        [
          room_rules.Event(
            id: "aud-1",
            at: 1000,
            by_kind: Some(case_history.Org),
            by_id: Some("u1"),
            by_name: Some("Maria"),
            action: "room_created",
            detail: None,
          ),
          room_rules.Event(
            id: "aud-2",
            at: 1000,
            by_kind: Some(case_history.Org),
            by_id: Some("u1"),
            by_name: Some("Maria"),
            action: "room_status_changed",
            detail: Some(json.object([#("to", json.string("shortlisted"))])),
          ),
          room_rules.Event(
            id: "aud-3",
            at: 2000,
            by_kind: Some(case_history.Org),
            by_id: Some("u2"),
            by_name: Some("Tom"),
            action: "room_comment_added",
            detail: None,
          ),
        ],
        50,
        None,
      )),
    )
    == "{\"items\":[{\"id\":\"aud-3\",\"at\":2000,\"type\":\"room_comment_added\",\"actor\":{\"kind\":\"org\",\"id\":\"u2\",\"name\":\"Tom\"},\"detail\":null},{\"id\":\"aud-2\",\"at\":1000,\"type\":\"room_status_changed\",\"actor\":{\"kind\":\"org\",\"id\":\"u1\",\"name\":\"Maria\"},\"detail\":{\"to\":\"shortlisted\"}},{\"id\":\"aud-1\",\"at\":1000,\"type\":\"room_created\",\"actor\":{\"kind\":\"org\",\"id\":\"u1\",\"name\":\"Maria\"},\"detail\":null}],\"nextCursor\":null,\"total\":3}"
}

// rooms: roomActivity — activity paginates with a cursor
pub fn activity_paginates_with_a_cursor_test() {
  assert json.to_string(
      room_rules.activity_json(room_rules.room_activity(
        [
          room_rules.Event(
            id: "aud-1",
            at: 1000,
            by_kind: Some(case_history.Org),
            by_id: Some("u1"),
            by_name: Some("Maria"),
            action: "room_created",
            detail: None,
          ),
          room_rules.Event(
            id: "aud-2",
            at: 1000,
            by_kind: Some(case_history.Org),
            by_id: Some("u1"),
            by_name: Some("Maria"),
            action: "room_status_changed",
            detail: Some(json.object([#("to", json.string("shortlisted"))])),
          ),
          room_rules.Event(
            id: "aud-3",
            at: 2000,
            by_kind: Some(case_history.Org),
            by_id: Some("u2"),
            by_name: Some("Tom"),
            action: "room_comment_added",
            detail: None,
          ),
        ],
        2,
        None,
      )),
    )
    == "{\"items\":[{\"id\":\"aud-3\",\"at\":2000,\"type\":\"room_comment_added\",\"actor\":{\"kind\":\"org\",\"id\":\"u2\",\"name\":\"Tom\"},\"detail\":null},{\"id\":\"aud-2\",\"at\":1000,\"type\":\"room_status_changed\",\"actor\":{\"kind\":\"org\",\"id\":\"u1\",\"name\":\"Maria\"},\"detail\":{\"to\":\"shortlisted\"}}],\"nextCursor\":\"aud-2\",\"total\":3}"
}

// rooms: roomActivity — the cursor continues where the page ended
pub fn the_cursor_continues_where_the_page_ended_test() {
  assert json.to_string(
      room_rules.activity_json(room_rules.room_activity(
        [
          room_rules.Event(
            id: "aud-1",
            at: 1000,
            by_kind: Some(case_history.Org),
            by_id: Some("u1"),
            by_name: Some("Maria"),
            action: "room_created",
            detail: None,
          ),
          room_rules.Event(
            id: "aud-2",
            at: 1000,
            by_kind: Some(case_history.Org),
            by_id: Some("u1"),
            by_name: Some("Maria"),
            action: "room_status_changed",
            detail: Some(json.object([#("to", json.string("shortlisted"))])),
          ),
          room_rules.Event(
            id: "aud-3",
            at: 2000,
            by_kind: Some(case_history.Org),
            by_id: Some("u2"),
            by_name: Some("Tom"),
            action: "room_comment_added",
            detail: None,
          ),
        ],
        2,
        Some("aud-2"),
      )),
    )
    == "{\"items\":[{\"id\":\"aud-1\",\"at\":1000,\"type\":\"room_created\",\"actor\":{\"kind\":\"org\",\"id\":\"u1\",\"name\":\"Maria\"},\"detail\":null}],\"nextCursor\":null,\"total\":3}"
}

// rooms: roomActivity — a legacy case audit row is surfaced as a case event, not dropped
pub fn a_legacy_case_audit_row_is_surfaced_as_a_case_event_not_dropped_test() {
  assert json.to_string(
      room_rules.activity_json(room_rules.room_activity(
        [
          room_rules.Event(
            id: "aud-9",
            at: 5,
            by_kind: Some(case_history.Org),
            by_id: Some("u1"),
            by_name: Some("M"),
            action: "created",
            detail: None,
          ),
        ],
        50,
        None,
      )),
    )
    == "{\"items\":[{\"id\":\"aud-9\",\"at\":5,\"type\":\"case_created\",\"actor\":{\"kind\":\"org\",\"id\":\"u1\",\"name\":\"M\"},\"detail\":null}],\"nextCursor\":null,\"total\":1}"
}

// rooms: roomFunnel — the funnel counts each stage
pub fn the_funnel_counts_each_stage_test() {
  assert json.to_string(
      room_rules.room_funnel([
        room_status.Shortlisted,
        room_status.Signed,
        room_status.Archived,
        room_status.Watching,
      ]),
    )
    == "{\"total\":4,\"active\":2,\"shortlisted\":1,\"trials\":0,\"offers\":0,\"signed\":1,\"archived\":1,\"byStatus\":{\"watching\":1,\"under_review\":0,\"contact_planned\":0,\"contacted\":0,\"shortlisted\":1,\"priority\":0,\"trial_requested\":0,\"trial_scheduled\":0,\"trial_completed\":0,\"offer_consideration\":0,\"offer_made\":0,\"offer_accepted\":0,\"offer_declined\":0,\"signed\":1,\"on_hold\":0,\"withdrawn\":0,\"archived\":1,\"closed\":0},\"note\":\"Your organisation’s own recruitment activity. ScoutBox publishes no cross-club league table.\"}"
}

// rooms: secondLookEvent — the archive event is typed and marked revisitable
pub fn the_archive_event_is_typed_and_marked_revisitable_test() {
  assert json.to_string(room_rules.second_look_event(
      id.recruitment_case("case-1"),
      id.org("org-a"),
      id.player("pl-1"),
      room_status.Archived,
      9,
      Some(room_rules.SecondLookDecision(
        reason_codes: ["insufficient_recent_evidence"],
        created_at: 9,
        source_refs: Some(json.object([#("passportVersion", json.int(2))])),
      )),
    ))
    == "{\"type\":\"recruitment_room_archived\",\"roomId\":\"case-1\",\"orgId\":\"org-a\",\"playerId\":\"pl-1\",\"status\":\"archived\",\"reasonCodes\":[\"insufficient_recent_evidence\"],\"revisitable\":true,\"decisionAt\":9,\"sourceVersionRefs\":{\"passportVersion\":2}}"
}

// rooms: secondLookEvent — a squad-space archive is not marked revisitable
pub fn a_squad_space_archive_is_not_marked_revisitable_test() {
  assert json.to_string(room_rules.second_look_event(
      id.recruitment_case("c"),
      id.org("o"),
      id.player("p"),
      room_status.Archived,
      1,
      Some(room_rules.SecondLookDecision(
        reason_codes: ["squad_space"],
        created_at: 1,
        source_refs: None,
      )),
    ))
    == "{\"type\":\"recruitment_room_archived\",\"roomId\":\"c\",\"orgId\":\"o\",\"playerId\":\"p\",\"status\":\"archived\",\"reasonCodes\":[\"squad_space\"],\"revisitable\":false,\"decisionAt\":1,\"sourceVersionRefs\":null}"
}

// rooms: roomSummary — a list row carries the Trust disclaimer with the score
pub fn a_list_row_carries_the_trust_disclaimer_with_the_score_test() {
  assert json.to_string(room_rules.room_summary(
      room_rules.SummaryRoom(
        room_id: id.recruitment_case("case-1"),
        player_id: id.player("pl-1"),
        player_name: Some("A Player"),
        stage: recruitment_cases.Observation,
        owner_user_id: id.org_user("u1"),
        owner_name: Some("Maria"),
        created_at: 1,
        status: room_status.Shortlisted,
        priority: recruitment_cases.RoomPriorityHigh,
        tags: ["local"],
        lead_scout_user_id: Some(id.org_user("u1")),
        updated_at: 2,
      ),
      player: Some(room_rules.SummaryPlayer(
        position: Some("CM"),
        age: Some(17),
        current_club: None,
      )),
      trust: Some(room_rules.SummaryTrust(
        score: 80,
        band: "strong_evidence",
        band_label: "Strong evidence",
      )),
      open_tasks: 1,
      health: Some(room_rules.ReadyForReview),
      last_activity_at: None,
      visible: True,
    ))
    == "{\"roomId\":\"case-1\",\"playerId\":\"pl-1\",\"playerName\":\"A Player\",\"playerAvailable\":true,\"position\":\"CM\",\"age\":17,\"currentClub\":null,\"status\":\"shortlisted\",\"statusLabel\":\"Shortlisted\",\"stage\":\"observation\",\"priority\":\"high\",\"tags\":[\"local\"],\"ownerUserId\":\"u1\",\"ownerName\":\"Maria\",\"leadScoutUserId\":\"u1\",\"trust\":{\"score\":80,\"band\":\"strong_evidence\",\"bandLabel\":\"Strong evidence\",\"note\":\"Evidence confidence — not football ability.\"},\"openTasks\":1,\"health\":\"ready_for_review\",\"healthLabel\":\"Ready for review\",\"lastActivityAt\":null,\"updatedAt\":2,\"createdAt\":1}"
}

// rooms: validateTag — an ordinary internal tag is accepted
pub fn an_ordinary_internal_tag_is_accepted_test() {
  assert json.to_string(
      room_rules.tag_json(room_rules.validate_tag("Left-footed CB")),
    )
    == "{\"ok\":true,\"tag\":\"Left-footed CB\"}"
}

// rooms: validateTag — [neg] an empty tag is refused
pub fn neg_an_empty_tag_is_refused_test() {
  assert json.to_string(room_rules.tag_json(room_rules.validate_tag("")))
    == "{\"ok\":false,\"error\":\"ROOM_TAG_EMPTY\",\"message\":\"A tag needs some text.\"}"
}

// rooms: validateTag — [neg] a tag reading "nationality" is refused as a protected classification
pub fn neg_a_tag_reading_nationality_is_refused_as_a_protected_classification_test() {
  assert json.to_string(
      room_rules.tag_json(room_rules.validate_tag("nationality")),
    )
    == "{\"ok\":false,\"error\":\"ROOM_TAG_PROHIBITED\",\"message\":\"A tag cannot classify a player by a protected characteristic.\"}"
}

// rooms: validateTag — [neg] a tag reading "Religion" is refused as a protected classification
pub fn neg_a_tag_reading_religion_is_refused_as_a_protected_classification_test() {
  assert json.to_string(
      room_rules.tag_json(room_rules.validate_tag("Religion")),
    )
    == "{\"ok\":false,\"error\":\"ROOM_TAG_PROHIBITED\",\"message\":\"A tag cannot classify a player by a protected characteristic.\"}"
}

// rooms: validateTag — [neg] a tag reading "disability" is refused as a protected classification
pub fn neg_a_tag_reading_disability_is_refused_as_a_protected_classification_test() {
  assert json.to_string(
      room_rules.tag_json(room_rules.validate_tag("disability")),
    )
    == "{\"ok\":false,\"error\":\"ROOM_TAG_PROHIBITED\",\"message\":\"A tag cannot classify a player by a protected characteristic.\"}"
}

// rooms: validateTag — [neg] a tag reading "family income" is refused as a protected classification
pub fn neg_a_tag_reading_family_income_is_refused_as_a_protected_classification_test() {
  assert json.to_string(
      room_rules.tag_json(room_rules.validate_tag("family income")),
    )
    == "{\"ok\":false,\"error\":\"ROOM_TAG_PROHIBITED\",\"message\":\"A tag cannot classify a player by a protected characteristic.\"}"
}

// rooms: clampPage — page sizes are clamped
pub fn page_sizes_are_clamped_test() {
  assert room_rules.clamp_page(Some("10")) == 10
}

// rooms: clampPage — page sizes are clamped
pub fn page_sizes_are_clamped_2_test() {
  assert room_rules.clamp_page(Some("999")) == 100
}

// rooms: clampPage — page sizes are clamped
pub fn page_sizes_are_clamped_3_test() {
  assert room_rules.clamp_page(Some("x")) == 50
}

// rooms: normaliseSourceContext — source context is normalised, never free-form
pub fn source_context_is_normalised_never_free_form_test() {
  assert room_rules.normalise_source_context("watchlist")
    == source_context.Watchlist
}

// rooms: normaliseSourceContext — source context is normalised, never free-form
pub fn source_context_is_normalised_never_free_form_2_test() {
  assert room_rules.normalise_source_context("nonsense")
    == source_context.Direct
}

// trials: roomCan — U49 roomCan carries the same three actions (one permission table)
pub fn u49_roomcan_carries_the_same_three_actions_one_permission_table_test() {
  assert room_rules.room_can(
      Some(room_rules.Contributor),
      room_rules.TrialAssess,
    )
    == True
}

// trials: roomCan — U49 roomCan carries the same three actions (one permission table)
pub fn u49_roomcan_carries_the_same_three_actions_one_permission_table_2_test() {
  assert room_rules.room_can(
      Some(room_rules.Contributor),
      room_rules.TrialWrite,
    )
    == False
}

// trials: roomCan — U49 roomCan carries the same three actions (one permission table)
pub fn u49_roomcan_carries_the_same_three_actions_one_permission_table_3_test() {
  assert room_rules.room_can(Some(room_rules.RoomLead), room_rules.TrialWrite)
    == True
}
