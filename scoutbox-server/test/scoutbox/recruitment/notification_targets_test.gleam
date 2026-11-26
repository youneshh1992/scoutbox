//// Where a notification leads, for the branches recruitment/journey's section G doesn't reach: a Trial, a request
//// and a Contact, for staff of the case's club and of another, the player and two guardians.

import gleam/json
import gleam/option.{type Option, None, Some}
import scoutbox/platform/store.{type Store}
import scoutbox/recruitment/notification_targets
import scoutbox/rows/id
import scoutbox/rows/org_users as staff_row
import scoutbox/rows/recruitment_cases as case_row
import scoutbox/rows/recruitment_contacts as contact_row
import scoutbox/rows/recruitment_requests as request_row
import scoutbox/rows/trials as trial_row
import scoutbox/support
import scoutbox/vocab/audience.{type Audience}
import scoutbox/vocab/contact_mode
import scoutbox/vocab/party
import scoutbox/vocab/room_status
import scoutbox/vocab/trial_workflow_state

fn fixture() -> Store {
  let s = support.fresh_store(fn(_) { Nil })
  let eastport = id.org("org-eastport")
  let player = id.player("pl-guni")
  let maria = id.org_user("ou-maria")
  let assert Ok(_) =
    store.unit(s, fn(tx) {
      let assert Ok(_) =
        staff_row.insert(
          tx,
          staff_row.new(
            maria,
            eastport,
            "Maria",
            "maria",
            "recruitment_admin",
            1,
          ),
        )
      let assert Ok(_) =
        staff_row.insert(
          tx,
          staff_row.new(
            id.org_user("ou-other"),
            id.org("org-harbour"),
            "Other",
            "other",
            "recruitment_admin",
            1,
          ),
        )
      let kase = id.recruitment_case("case-t1")
      let assert Ok(_) =
        case_row.insert(
          tx,
          case_row.Row(
            ..case_row.new(
              kase,
              eastport,
              player,
              maria,
              case_row.Review,
              case_row.Medium,
              False,
              1,
            ),
            room_status: Some(room_status.TrialScheduled),
            room_priority: Some(case_row.Normal),
            room_updated_at: Some(1),
            room_rev: Some(1),
          ),
        )
      let request = id.request("req-t1")
      let assert Ok(_) =
        request_row.insert(
          tx,
          request_row.Row(
            ..request_row.new(
              request,
              player,
              eastport,
              "Eastport FC",
              True,
              True,
              maria,
              request_row.Trial,
              request_row.Accepted,
              1,
              party.Guardian,
            ),
            guardian_id: Some(id.guardian("gd-amara")),
            case_id: Some(kase),
            trial_alt_days_json: Some("[]"),
          ),
        )
      let assert Ok(_) =
        trial_row.insert(
          tx,
          trial_row.Row(
            ..trial_row.new(
              id.trial("trial-t1"),
              request,
              player,
              eastport,
              "Eastport FC",
              1,
              trial_row.AwaitingReport,
              False,
              trial_workflow_state.Accepted,
              1,
            ),
            case_id: Some(kase),
            recipient_type: Some(party.Guardian),
            recipient_guardian_id: Some(id.guardian("gd-amara")),
            recipient_minor: Some(True),
            recipient_at: Some(1),
          ),
        )
      contact_row.insert(
        tx,
        contact_row.Row(
          ..contact_row.new(
            id.contact("rct-t1"),
            eastport,
            kase,
            player,
            contact_row.Delivered,
            contact_row.InApp,
            contact_mode.PlayerOnly,
            maria,
            1,
            1,
            1,
            1,
          ),
          routing_agent_user_id: Some(id.org_user("ou-other")),
        ),
      )
    })
  s
}

fn target(
  s: Store,
  kind: Audience,
  who: String,
  ref: Option(String),
) -> String {
  let assert Ok(found) =
    store.read(s, notification_targets.target(_, kind, who, ref))
  case found {
    Some(j) -> json.to_string(j)
    None -> "none"
  }
}

fn room(tab: String) -> String {
  "{\"kind\":\"room\",\"roomId\":\"case-t1\",\"tab\":\"" <> tab <> "\"}"
}

pub fn staff_are_led_into_their_own_clubs_room_only_test() {
  let s = fixture()
  assert target(s, audience.OrgUser, "ou-maria", Some("case-t1"))
    == room("overview")
  assert target(s, audience.OrgUser, "ou-maria", Some("req-t1"))
    == room("trial")
  assert target(s, audience.OrgUser, "ou-maria", Some("trial-t1"))
    == room("trial")
  assert target(s, audience.OrgUser, "ou-maria", Some("rct-t1"))
    == room("contact")
  assert target(s, audience.OrgUser, "ou-other", Some("case-t1")) == "none"
  assert target(s, audience.OrgUser, "ou-other", Some("trial-t1")) == "none"
  // Routed to them, but no representation of the client: a share alone never grants a target.
  assert target(s, audience.OrgUser, "ou-other", Some("rct-t1")) == "none"
}

pub fn a_guardians_trial_and_request_lead_only_that_guardian_test() {
  let s = fixture()
  assert target(s, audience.Guardian, "gd-amara", Some("req-t1"))
    == "{\"kind\":\"inbox\",\"requestId\":\"req-t1\"}"
  assert target(s, audience.Guardian, "gd-amara", Some("trial-t1"))
    == "{\"kind\":\"trial\",\"trialId\":\"trial-t1\"}"
  assert target(s, audience.Guardian, "gd-marek", Some("req-t1")) == "none"
  assert target(s, audience.Guardian, "gd-marek", Some("trial-t1")) == "none"
  assert target(s, audience.Player, "pl-guni", Some("req-t1")) == "none"
  assert target(s, audience.Player, "pl-guni", Some("trial-t1")) == "none"
  assert target(s, audience.Player, "pl-guni", Some("case-t1")) == "none"
  assert target(s, audience.Guardian, "gd-amara", Some("rct-t1")) == "none"
}

pub fn an_unknown_or_missing_ref_leads_nowhere_test() {
  let s = fixture()
  assert target(s, audience.OrgUser, "ou-maria", None) == "none"
  assert target(s, audience.OrgUser, "ou-maria", Some("thing-1")) == "none"
  assert target(s, audience.OrgUser, "ou-maria", Some("rof-missing")) == "none"
  assert target(s, audience.Player, "pl-guni", Some("spk-missing")) == "none"
}
