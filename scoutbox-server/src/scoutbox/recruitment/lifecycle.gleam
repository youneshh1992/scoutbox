//// The recruitment lifecycle's vocabulary (domains/recruitment/lifecycle/lifecycle.mjs): each named action, the
//// Room status it moves a case to, who may take it, and whether it needs reason codes.
////
//// Not ported yet: taking an action (`POST /org/recruitment/cases/:id/lifecycle`) belongs to the recruitment
//// Rooms. Only the read-only vocabulary is served.

import gleam/json
import gleam/list
import scoutbox/app.{type Ctx}
import scoutbox/platform/http
import wisp.{type Response}

pub const policy_version = 1

/// A member's role in a recruitment Room.
pub type RoomRole {
  Contributor
  RoomLead
  RecruitmentAdmin
}

pub fn role_to_string(role: RoomRole) -> String {
  case role {
    Contributor -> "contributor"
    RoomLead -> "room_lead"
    RecruitmentAdmin -> "recruitment_admin"
  }
}

pub type Action {
  Action(
    name: String,
    to: String,
    roles: List(RoomRole),
    reasons_required: Bool,
  )
}

pub const actions = [
  Action(
    "startReview",
    "under_review",
    [Contributor, RoomLead, RecruitmentAdmin],
    False,
  ),
  Action("planContact", "contact_planned", [RoomLead, RecruitmentAdmin], False),
  Action("recordContact", "contacted", [RoomLead, RecruitmentAdmin], False),
  Action(
    "shortlist",
    "shortlisted",
    [Contributor, RoomLead, RecruitmentAdmin],
    False,
  ),
  Action("prioritise", "priority", [RoomLead, RecruitmentAdmin], False),
  Action("planTrial", "trial_requested", [RoomLead, RecruitmentAdmin], False),
  Action("confirmTrial", "trial_scheduled", [RoomLead, RecruitmentAdmin], False),
  Action(
    "completeTrial",
    "trial_completed",
    [RoomLead, RecruitmentAdmin],
    False,
  ),
  Action(
    "considerOffer",
    "offer_consideration",
    [RoomLead, RecruitmentAdmin],
    False,
  ),
  Action("sendOffer", "offer_made", [RoomLead, RecruitmentAdmin], False),
  Action(
    "recordOfferAccepted",
    "offer_accepted",
    [RoomLead, RecruitmentAdmin],
    False,
  ),
  Action(
    "recordOfferDeclined",
    "offer_declined",
    [RoomLead, RecruitmentAdmin],
    False,
  ),
  Action("confirmSignedOutcome", "signed", [RecruitmentAdmin], False),
  Action("holdCase", "on_hold", [RoomLead, RecruitmentAdmin], False),
  Action("resumeCase", "under_review", [RoomLead, RecruitmentAdmin], False),
  Action("rejectCase", "archived", [RoomLead, RecruitmentAdmin], True),
  Action("withdrawCase", "withdrawn", [RoomLead, RecruitmentAdmin], True),
  Action("closeCase", "closed", [RoomLead, RecruitmentAdmin], True),
  Action("reopenCase", "under_review", [RoomLead, RecruitmentAdmin], False),
]

pub const reason_codes = [
  "contact_planned",
  "contact_made",
  "player_responded",
  "trial_progression",
  "trial_completed",
  "club_decision",
  "player_declined",
  "offer_progression",
  "offer_accepted_in_scoutbox",
  "signed_outcome",
  "rejected",
  "withdrawn",
  "on_hold",
  "hold_resumed",
  "case_closed",
  "case_reopened",
]

/// `GET /org/recruitment/lifecycle`.
pub fn vocabulary(_ctx: Ctx) -> Response {
  http.json(
    200,
    json.object([
      #("policyVersion", json.int(policy_version)),
      #(
        "actions",
        json.array(actions, fn(a) {
          json.object([
            #("action", json.string(a.name)),
            #("to", json.string(a.to)),
            #(
              "roles",
              json.array(list.map(a.roles, role_to_string), json.string),
            ),
            #("reasonCodesRequired", json.bool(a.reasons_required)),
          ])
        }),
      ),
      #("reasonCodes", json.array(reason_codes, json.string)),
    ]),
  )
}
