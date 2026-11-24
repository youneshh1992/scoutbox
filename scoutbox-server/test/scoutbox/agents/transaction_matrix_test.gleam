//// The transaction state machine and the visibility classes (transaction_rules) agree with the TypeScript ones
//// (domains/agents/transactions/transaction.mjs) on every input in test/fixtures/transaction_matrix.json, written by
//// `node dev/matrix_cases.mjs`: every status × status for actorTransitionAllowed and complianceTransitionAllowed, and
//// every set of room roles × the viewer's side for canSeeVisibility, uploadableVisibilities and (per audience and
//// entry detail) timelineVisible; and timelineAudienceOf for every action a history row can hold.
////
//// The recorded calls Gleam's types can't hold are refused before these rules: a status is a typed column (its
//// vocabulary is generated from the migration's CHECK, so text outside it, `__proto__` included, neither decodes nor
//// is stored), a class is the same, the roles are decided by `room_roles` from the viewer, never read from a request
//// (so they are always a list, and never `party_guardian`: no minor transaction pathway is enabled), and every
//// history row's action is one the column allows. A call with no arguments at all has no Gleam counterpart: both
//// statuses are required.

import gleam/dict.{type Dict}
import gleam/dynamic/decode
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/agents/transaction_rules.{
  type Audience, type RoomRole, AgencyAdminObserver, AgentOnly, AllParties,
  AuditOnly, ClubSide, PartyClubMember, PartyClubSignatory, PartyIndividual,
  PerDocument, PlayerAndAgent, RepresentingAgent, TrustSafety,
}
import scoutbox/matrix
import scoutbox/rows/transaction_history as event_row
import scoutbox/vocab/document_visibility.{type DocumentVisibility}
import scoutbox/vocab/party_role.{type PartyRole}
import scoutbox/vocab/transaction_status
import simplifile

type Fixture {
  Fixture(
    statuses: List(String),
    transitions: Dict(String, #(Bool, Bool)),
    visibilities: List(String),
    roles: List(String),
    sides: List(Option(String)),
    audiences: List(String),
    can_see: Dict(String, String),
    uploadable: Dict(String, List(String)),
    timeline: Dict(String, String),
    audience_of: Dict(String, String),
  )
}

fn fixture() -> Fixture {
  let assert Ok(text) = simplifile.read("test/fixtures/transaction_matrix.json")
  let pair = {
    use actor <- decode.field(0, decode.bool)
    use compliance <- decode.field(1, decode.bool)
    decode.success(#(actor, compliance))
  }
  let strings = decode.list(decode.string)
  let assert Ok(f) =
    json.parse(text, {
      use statuses <- decode.field("statuses", strings)
      use transitions <- decode.field(
        "transitions",
        decode.dict(decode.string, pair),
      )
      use visibilities <- decode.field("visibilities", strings)
      use roles <- decode.field("roles", strings)
      use sides <- decode.field(
        "sides",
        decode.list(decode.optional(decode.string)),
      )
      use audiences <- decode.field("audiences", strings)
      use can_see <- decode.field(
        "canSee",
        decode.dict(decode.string, decode.string),
      )
      use uploadable <- decode.field(
        "uploadable",
        decode.dict(decode.string, strings),
      )
      use timeline <- decode.field(
        "timeline",
        decode.dict(decode.string, decode.string),
      )
      use audience_of <- decode.field(
        "audienceOf",
        decode.dict(decode.string, decode.string),
      )
      decode.success(Fixture(
        statuses:,
        transitions:,
        visibilities:,
        roles:,
        sides:,
        audiences:,
        can_see:,
        uploadable:,
        timeline:,
        audience_of:,
      ))
    })
  f
}

const roles = [
  RepresentingAgent,
  PartyIndividual,
  PartyClubSignatory,
  PartyClubMember,
  AgencyAdminObserver,
  TrustSafety,
]

const audiences = [
  AllParties,
  AgentOnly,
  PlayerAndAgent,
  ClubSide,
  PerDocument,
  AuditOnly,
]

fn statuses() {
  list.map(transaction_status.pairs, fn(p) { p.1 })
}

fn visibilities() -> List(DocumentVisibility) {
  list.map(document_visibility.pairs, fn(p) { p.1 })
}

fn sides() -> List(Option(PartyRole)) {
  [None, ..list.map(party_role.pairs, fn(p) { Some(p.1) })]
}

/// Every set of the roles, in the fixture's order: the set a mask's bits pick.
fn role_sets() -> List(List(RoomRole)) {
  let n = list.length(roles)
  int.range(
    from: 0,
    to: int.bitwise_shift_left(1, n),
    with: [],
    run: fn(acc, mask) {
      [
        list.index_fold(roles, [], fn(set, role, i) {
          case int.bitwise_and(mask, int.bitwise_shift_left(1, i)) {
            0 -> set
            _ -> [role, ..set]
          }
        })
          |> list.reverse,
        ..acc
      ]
    },
  )
  |> list.reverse
}

fn set_key(set: List(RoomRole), side: Option(PartyRole)) -> String {
  case set {
    [] -> "-"
    _ -> string.join(list.map(set, transaction_rules.room_role_to_string), "+")
  }
  <> " "
  <> option.map(side, party_role.to_string) |> option.unwrap("none")
}

fn bits(answers: List(Bool)) -> String {
  string.concat(
    list.map(answers, fn(b) {
      case b {
        True -> "1"
        False -> "0"
      }
    }),
  )
}

fn get(d: Dict(String, a), key: String) -> a {
  let assert Ok(v) = dict.get(d, key)
  v
}

fn status_key(from, to) {
  transaction_status.to_string(from) <> " " <> transaction_status.to_string(to)
}

pub fn the_matrix_covers_what_this_server_has_test() {
  let f = fixture()
  assert f.statuses == list.map(transaction_status.pairs, fn(p) { p.0 })
  assert f.visibilities == list.map(document_visibility.pairs, fn(p) { p.0 })
  assert f.roles == list.map(roles, transaction_rules.room_role_to_string)
  assert f.sides == list.map(sides(), option.map(_, party_role.to_string))
  assert f.audiences
    == list.map(audiences, transaction_rules.audience_to_string)
  assert dict.size(f.transitions) == 100
  assert dict.size(f.can_see) == list.length(role_sets()) * 4
  assert dict.size(f.uploadable) == dict.size(f.can_see)
  assert dict.size(f.timeline) == dict.size(f.can_see) * list.length(audiences)
}

pub fn the_state_machine_agrees_with_the_typescript_one_test() {
  let f = fixture()
  {
    use from <- list.flat_map(statuses())
    use to <- list.map(statuses())
    let k = status_key(from, to)
    let #(actor, compliance) = get(f.transitions, k)
    matrix.Row(what: k, expected: bits([actor, compliance]), actual: fn() {
      bits([
        transaction_rules.actor_transition_allowed(from, to),
        transaction_rules.compliance_transition_allowed(from, to),
      ])
    })
  }
  |> matrix.check("actorTransitionAllowed and complianceTransitionAllowed")
}

pub fn can_see_agrees_with_can_see_visibility_test() {
  let f = fixture()
  {
    use set <- list.flat_map(role_sets())
    use side <- list.map(sides())
    let k = set_key(set, side)
    matrix.Row(what: k, expected: get(f.can_see, k), actual: fn() {
      bits(list.map(visibilities(), transaction_rules.can_see(_, set, side)))
    })
  }
  |> matrix.check("canSeeVisibility")
}

pub fn uploadable_agrees_with_uploadable_visibilities_test() {
  let f = fixture()
  {
    use set <- list.flat_map(role_sets())
    use side <- list.map(sides())
    let k = set_key(set, side)
    matrix.Row(
      what: k,
      expected: string.join(get(f.uploadable, k), ","),
      actual: fn() {
        transaction_rules.uploadable(set, side)
        |> list.map(document_visibility.to_string)
        |> string.join(",")
      },
    )
  }
  |> matrix.check("uploadableVisibilities")
}

pub fn timeline_visible_agrees_with_the_typescript_rule_test() {
  let f = fixture()
  {
    use set <- list.flat_map(role_sets())
    use side <- list.flat_map(sides())
    use audience <- list.map(audiences)
    let k = audience_key(audience) <> " " <> set_key(set, side)
    matrix.Row(what: k, expected: get(f.timeline, k), actual: fn() {
      [None, ..list.map(visibilities(), Some)]
      |> list.map(transaction_rules.timeline_visible(audience, set, side, _))
      |> bits
    })
  }
  |> matrix.check("timelineVisible")
}

pub fn audience_of_agrees_with_timeline_audience_of_test() {
  let f = fixture()
  assert dict.size(f.audience_of) == list.length(event_row.action_pairs)
  {
    use #(text, action) <- list.map(event_row.action_pairs)
    matrix.Row(what: text, expected: get(f.audience_of, text), actual: fn() {
      transaction_rules.audience_to_string(transaction_rules.audience_of(action))
    })
  }
  |> matrix.check("timelineAudienceOf")
}

fn audience_key(a: Audience) -> String {
  transaction_rules.audience_to_string(a)
}

pub fn text_that_is_not_a_status_or_class_does_not_decode_as_one_test() {
  list.each(
    [
      "__proto__", "constructor", "SOMETHING_NOBODY_WROTE", "HALF_WRITTEN",
      "NOT_A_CLASS", "",
    ],
    fn(text) {
      let j = json.to_string(json.string(text))
      assert json.parse(j, transaction_status.decoder()) |> result.is_error
      assert json.parse(j, document_visibility.decoder()) |> result.is_error
    },
  )
}
