//// The transaction state machine and the visibility classes (transaction_rules) give the blessed answers on every
//// input in test/fixtures/transaction_matrix.json (first blessed from the TypeScript server's
//// domains/agents/transactions/transaction.mjs): every status × status for actorTransitionAllowed and complianceTransitionAllowed, and
//// every set of room roles × the viewer's side for canSeeVisibility, uploadableVisibilities and (per audience and
//// entry detail) timelineVisible; and timelineAudienceOf for every action a history row can hold.
////
//// The recorded calls Gleam's types can't hold are refused before these rules: a status is a typed column (its
//// vocabulary is generated from the migration's CHECK, so text outside it, `__proto__` included, neither decodes nor
//// is stored), a class is the same, the roles are decided by `room_roles` from the viewer, never read from a request
//// (so they are always a list, and never `party_guardian`: no minor transaction pathway is enabled), and every
//// history row's action is one the column allows. A call with no arguments at all has no Gleam counterpart: both
//// statuses are required.

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
import scoutbox/blessed
import scoutbox/rows/transaction_history as event_row
import scoutbox/vocab/document_visibility.{type DocumentVisibility}
import scoutbox/vocab/party_role.{type PartyRole}
import scoutbox/vocab/transaction_status

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

fn status_key(from, to) {
  transaction_status.to_string(from) <> " " <> transaction_status.to_string(to)
}

fn strings(items: List(String)) -> json.Json {
  json.array(items, json.string)
}

fn table(f: blessed.Fixture, name: String) -> blessed.Table {
  blessed.table(blessed.field(blessed.root(f), name))
}

pub fn the_axes_are_blessed_test() {
  let f = blessed.load("transaction_matrix")
  let at = fn(name) { blessed.field(blessed.root(f), name) }
  [
    blessed.answer(
      at("statuses"),
      "statuses",
      strings(list.map(transaction_status.pairs, fn(p) { p.0 })),
    ),
    blessed.answer(
      at("visibilities"),
      "visibilities",
      strings(list.map(document_visibility.pairs, fn(p) { p.0 })),
    ),
    blessed.answer(
      at("roles"),
      "roles",
      strings(list.map(roles, transaction_rules.room_role_to_string)),
    ),
    blessed.answer(
      at("sides"),
      "sides",
      json.array(sides(), fn(s) {
        json.nullable(option.map(s, party_role.to_string), json.string)
      }),
    ),
    blessed.answer(
      at("audiences"),
      "audiences",
      strings(list.map(audiences, transaction_rules.audience_to_string)),
    ),
  ]
  |> blessed.check(f, _)
}

pub fn the_state_machine_is_blessed_test() {
  let f = blessed.load("transaction_matrix")
  let t = table(f, "transitions")
  {
    use from <- list.flat_map(statuses())
    use to <- list.map(statuses())
    blessed.entry(
      t,
      status_key(from, to),
      json.array(
        [
          transaction_rules.actor_transition_allowed(from, to),
          transaction_rules.compliance_transition_allowed(from, to),
        ],
        json.bool,
      ),
    )
  }
  |> blessed.check(f, _)
}

pub fn can_see_is_blessed_test() {
  let f = blessed.load("transaction_matrix")
  let t = table(f, "canSee")
  {
    use set <- list.flat_map(role_sets())
    use side <- list.map(sides())
    blessed.entry(
      t,
      set_key(set, side),
      json.string(
        bits(list.map(visibilities(), transaction_rules.can_see(_, set, side))),
      ),
    )
  }
  |> blessed.check(f, _)
}

pub fn uploadable_is_blessed_test() {
  let f = blessed.load("transaction_matrix")
  let t = table(f, "uploadable")
  {
    use set <- list.flat_map(role_sets())
    use side <- list.map(sides())
    blessed.entry(
      t,
      set_key(set, side),
      transaction_rules.uploadable(set, side)
        |> list.map(document_visibility.to_string)
        |> strings,
    )
  }
  |> blessed.check(f, _)
}

pub fn timeline_visible_is_blessed_test() {
  let f = blessed.load("transaction_matrix")
  let t = table(f, "timeline")
  {
    use set <- list.flat_map(role_sets())
    use side <- list.flat_map(sides())
    use audience <- list.map(audiences)
    blessed.entry(
      t,
      audience_key(audience) <> " " <> set_key(set, side),
      [None, ..list.map(visibilities(), Some)]
        |> list.map(transaction_rules.timeline_visible(audience, set, side, _))
        |> bits
        |> json.string,
    )
  }
  |> blessed.check(f, _)
}

pub fn audience_of_is_blessed_test() {
  let f = blessed.load("transaction_matrix")
  let t = table(f, "audienceOf")
  {
    use #(text, action) <- list.map(event_row.action_pairs)
    blessed.entry(
      t,
      text,
      json.string(
        transaction_rules.audience_to_string(transaction_rules.audience_of(
          action,
        )),
      ),
    )
  }
  |> blessed.check(f, _)
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

fn audience_key(a: Audience) -> String {
  transaction_rules.audience_to_string(a)
}
