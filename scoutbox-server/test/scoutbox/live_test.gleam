//// The live-sync hub: its events agree with the TypeScript server's registry, and a reconnect is replayed what it
//// missed, or told to resync when that is gone.

import gleam/dict
import gleam/dynamic/decode
import gleam/erlang/process
import gleam/json
import gleam/list
import gleam/option.{None}
import scoutbox/platform/live.{Nobody}
import scoutbox/platform/live_event.{
  CounterpartyTyping, Messages, Notify, OrgTyping, Typing,
}
import scoutbox/vocab/audience
import simplifile

/// One of every event, with each variant of its fields.
const samples = [
  Messages("ch-1"),
  Typing("ch-1", OrgTyping),
  Typing("ch-1", CounterpartyTyping),
  Notify(audience.Player, "pl-1"),
  Notify(audience.Guardian, "gd-1"),
  Notify(audience.OrgUser, "u-1"),
  live_event.AgentProfileCreated("org-1", "u-1"),
  live_event.AgentVerificationStateChanged(
    "org-1",
    "u-1",
    "fifa_licence",
    "VERIFIED",
  ),
  live_event.AgencyAffiliationCreated("org-1", "u-1"),
  live_event.AgencyAffiliationEnded("org-1", "u-1"),
  live_event.Representation(
    live_event.RepresentationRequested,
    "org-1",
    "rep-1",
    "u-1",
  ),
  live_event.Representation(
    live_event.RepresentationConfirmed,
    "org-1",
    "rep-1",
    "u-1",
  ),
  live_event.Representation(
    live_event.RepresentationRejected,
    "org-1",
    "rep-1",
    "u-1",
  ),
  live_event.Representation(
    live_event.RepresentationTerminated,
    "org-1",
    "rep-1",
    "u-1",
  ),
  live_event.Representation(
    live_event.RepresentationDisputed,
    "org-1",
    "rep-1",
    "u-1",
  ),
  live_event.Representation(
    live_event.RepresentationDisclosureChanged,
    "org-1",
    "rep-1",
    "u-1",
  ),
  live_event.RegulatoryReviewRequested("org-1", "rrv-1", "verification_facet"),
  live_event.OfferChanged(
    live_event.OfferDraftCreated,
    "org-1",
    "case-1",
    "rof-1",
  ),
  live_event.OfferChanged(
    live_event.OfferDraftUpdated,
    "org-1",
    "case-1",
    "rof-1",
  ),
  live_event.OfferChanged(live_event.OfferIssued, "org-1", "case-1", "rof-1"),
  live_event.OfferChanged(
    live_event.OfferSuperseded,
    "org-1",
    "case-1",
    "rof-1",
  ),
  live_event.OfferChanged(live_event.OfferWithdrawn, "org-1", "case-1", "rof-1"),
  live_event.OfferResponded("org-1", "case-1", "rof-1", None),
  live_event.AssessmentSubmitted("org-1", "ass-1"),
  live_event.Feedback("pl-1"),
  live_event.WatchlistChanged(live_event.WatchlistCreated, "org-1", "wl-1"),
  live_event.WatchlistChanged(live_event.WatchlistUpdated, "org-1", "wl-1"),
  live_event.WatchlistChanged(
    live_event.WatchlistMembershipChanged,
    "org-1",
    "wl-1",
  ),
  live_event.WatchlistChanged(live_event.WatchlistArchived, "org-1", "wl-1"),
  live_event.MatchingRoomCreated("org-1", "case-1"),
  live_event.TrialInvited("org-1", "case-1", "req-1"),
  live_event.TrialAccepted("org-1", "case-1", "trial-1", "req-1"),
  live_event.TrialDeclined("org-1", "case-1", "req-1"),
  live_event.TrialChanged(
    live_event.TrialScheduled,
    "org-1",
    "case-1",
    "trial-1",
  ),
  live_event.TrialChanged(
    live_event.TrialRescheduled,
    "org-1",
    "case-1",
    "trial-1",
  ),
  live_event.TrialChanged(
    live_event.TrialCancelled,
    "org-1",
    "case-1",
    "trial-1",
  ),
  live_event.TrialChanged(
    live_event.TrialCompleted,
    "org-1",
    "case-1",
    "trial-1",
  ),
  live_event.TrialSessionChanged(
    live_event.TrialAttendanceRecorded,
    "org-1",
    "case-1",
    "trial-1",
    "tses-1",
  ),
  live_event.TrialSessionChanged(
    live_event.TrialEvidenceLinked,
    "org-1",
    "case-1",
    "trial-1",
    "tses-1",
  ),
  live_event.TransactionHandoffInvited("org-1", "case-1", "hof-1"),
  live_event.ConflictEvaluated("org-1", "ctx-1", "CLEAR"),
  live_event.AgentTransactionCreated("org-1", "atx-1"),
  live_event.AgentTransactionComplianceUpdated("org-1", "atx-1", "CLEAR"),
  live_event.AgentTransactionStatusChanged("org-1", "atx-1", "READY"),
]

type Entry {
  Entry(payload: List(String), replays: Bool)
}

fn registry() -> dict.Dict(String, Entry) {
  let assert Ok(text) =
    simplifile.read("e2e/support/spec/platform/eventRegistry.json")
  let entry = {
    use payload <- decode.field("payload", decode.list(decode.string))
    use replay <- decode.field("replayPolicy", decode.string)
    decode.success(Entry(payload:, replays: replay == "replay"))
  }
  let assert Ok(registry) =
    json.parse(
      text,
      decode.at(["EVENT_REGISTRY"], decode.dict(decode.string, entry)),
    )
  registry
}

pub fn events_carry_their_registered_payload_test() {
  let registry = registry()
  list.each(samples, fn(event) {
    let assert Ok(entry) = dict.get(registry, live_event.name(event))
    assert list.map(live_event.payload(event), fn(field) { field.0 })
      == entry.payload
    assert live_event.replays(event) == entry.replays
  })
}

pub fn a_frame_is_its_name_payload_and_time_test() {
  let frame =
    live.Frame(id: 7, event: Typing("ch-1", OrgTyping), route: Nobody, at: 99)
  assert live.data(frame)
    == "{\"event\":\"typing\",\"channelId\":\"ch-1\",\"side\":\"org\",\"ts\":99}"
}

fn ids(joined: live.Joined) -> List(Int) {
  case joined {
    live.Replay(frames) -> list.map(frames, fn(f) { f.id })
    _ -> []
  }
}

/// Publishing is asynchronous: a call to the hub after it has handled what was sent before.
fn settle(hub: live.Hub) -> Nil {
  let _ = live.streams(hub)
  Nil
}

pub fn a_reconnect_replays_what_it_missed_test() {
  let assert Ok(hub) = live.start()
  list.each([Messages("a"), Typing("a", OrgTyping), Messages("b")], fn(e) {
    live.publish(hub, e, Nobody, 0)
  })
  settle(hub)
  let frames = process.new_subject()
  // Typing (#2) is never kept.
  assert ids(live.join(hub, frames, 1)) == [3]
  assert live.join(hub, frames, 0) == live.Fresh
  // Up to date: nothing missed, but still a replay, so the client hears it is caught up.
  assert live.join(hub, frames, 3) == live.Replay([])
  // From the future (a restart reset the ids).
  assert live.join(hub, frames, 4) == live.Resync
}

pub fn an_evicted_cursor_is_told_to_resync_test() {
  let assert Ok(hub) = live.start()
  list.each(list.repeat(Messages("a"), 501), fn(e) {
    live.publish(hub, e, Nobody, 0)
  })
  settle(hub)
  let frames = process.new_subject()
  // #1 is gone; a client that saw #1 missed only #2.., which are kept.
  assert list.length(ids(live.join(hub, frames, 1))) == 500
  assert live.join(hub, frames, 0) == live.Fresh
  let assert Ok(hub) = live.start()
  list.each(list.repeat(Messages("a"), 502), fn(e) {
    live.publish(hub, e, Nobody, 0)
  })
  settle(hub)
  assert live.join(hub, frames, 1) == live.Resync
}

pub fn a_joined_stream_receives_what_is_published_test() {
  let assert Ok(hub) = live.start()
  let frames = process.new_subject()
  assert live.join(hub, frames, 0) == live.Fresh
  live.publish(hub, Messages("a"), Nobody, 5)
  let assert Ok(frame) = process.receive(frames, 1000)
  assert frame == live.Frame(id: 1, event: Messages("a"), route: Nobody, at: 5)
  assert live.streams(hub) == 1
  live.leave(hub)
  assert live.streams(hub) == 0
}

pub fn a_stream_leaves_when_its_process_ends_test() {
  let assert Ok(hub) = live.start()
  let joined = process.new_subject()
  process.spawn(fn() {
    let frames = process.new_subject()
    process.send(joined, live.join(hub, frames, 0))
  })
  let assert Ok(live.Fresh) = process.receive(joined, 1000)
  process.sleep(50)
  assert live.streams(hub) == 0
}

pub fn a_ticket_names_its_session_until_it_expires_test() {
  let assert Ok(hub) = live.start()
  let ticket = live.mint_ticket(hub, "sid-1", 1000)
  assert live.redeem_ticket(hub, ticket, 1000) == Ok("sid-1")
  // Usable again within its lifetime.
  assert live.redeem_ticket(hub, ticket, 1000 + live.ticket_ttl_ms)
    == Ok("sid-1")
  assert live.redeem_ticket(hub, ticket, 1001 + live.ticket_ttl_ms)
    == Error(Nil)
  assert live.redeem_ticket(hub, "forged", 1000) == Error(Nil)
}
