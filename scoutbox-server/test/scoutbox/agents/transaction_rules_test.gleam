//// The transaction rules give the blessed answers on every case in test/fixtures/transaction_cases.json (first
//// blessed from the TypeScript server's domains/agents/transactions/transaction.mjs): the compliance state and the
//// status it asks for, the Offer readiness, room roles, the visibility classes a viewer may read and file into, and
//// the party-revision hash.
////
//// The rules suites' recorded calls are generated into test/scoutbox/battery/agents/ (and the state machine and
//// visibility classes proved over transaction_matrix_test). The calls Gleam's types can't hold are refused before
//// these rules:
////
//// - complianceStateFrom with an outcome outside the engine's: `state_from` takes the engine's ContextOutcome, which
////   is all `conflict.evaluate` can answer.
//// - statusForComplianceState with no state, offerReadiness with no transaction: every caller passes the state
////   `state_from` just made, and every route that reads readiness has found the transaction (or answered 404).
//// - snapshotStaleness with a maximum age: no route on either server passes one, so a snapshot is never stale by age
////   alone, and `staleness` has no such argument.
//// - timelineAudienceOf with an unregistered action: a history row's action is a typed column whose vocabulary is
////   the migration's CHECK, so no entry has one.
//// - actorLabel with no actor: every history row, note and document has its actor's kind (a NOT NULL column).
//// - transactionAuditRows with neither filter: every caller reads one agency's feed
////   (`transaction_ts_routes.agency_rows`) or one transaction's (`audit_rows`).

import gleam/dict
import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{None, Some}
import scoutbox/agents/transaction_rules.{
  AgencyViewer, ClubViewer, PlayerViewer, ReviewerViewer,
}
import scoutbox/blessed
import scoutbox/platform/canonical
import scoutbox/rows/id
import scoutbox/rows/transaction_parties as party_row
import scoutbox/vocab/context_outcome
import scoutbox/vocab/context_type
import scoutbox/vocab/document_visibility
import scoutbox/vocab/party_role
import scoutbox/vocab/pending_reason
import scoutbox/vocab/staleness
import scoutbox/vocab/subject_kind
import scoutbox/vocab/transaction_status

fn party() -> decode.Decoder(party_row.Row) {
  use role <- decode.field("partyRole", party_role.decoder())
  use kind <- decode.field("subjectKind", subject_kind.decoder())
  use subject <- decode.field("subjectId", decode.string)
  use removed <- decode.field("removed", decode.bool)
  use confirmed <- decode.field("confirmedAt", decode.optional(decode.int))
  decode.success(
    party_row.Row(
      ..party_row.new(
        id: id.transaction_party("txp-1"),
        transaction_id: id.transaction("atx-1"),
        transaction_type: context_type.Transfer,
        ord: 0,
        party_role: role,
        subject_kind: kind,
        subject_id: subject,
        added_at: 1,
        added_by_id: id.org_user("usr-a"),
        removed:,
      ),
      confirmed_at: confirmed,
    ),
  )
}

fn viewer() -> decode.Decoder(transaction_rules.Viewer) {
  use kind <- decode.field("kind", decode.string)
  case kind {
    "agency" -> {
      use org <- decode.field("orgId", decode.string)
      use user <- decode.field("userId", decode.string)
      use admin <- decode.field("agencyAdmin", decode.bool)
      decode.success(AgencyViewer(org, user, admin))
    }
    "club" -> {
      use org <- decode.field("orgId", decode.string)
      use user <- decode.field("userId", decode.string)
      use signatory <- decode.field("signatory", decode.bool)
      decode.success(ClubViewer(org, user, signatory))
    }
    "player" -> {
      use player <- decode.field("playerId", decode.string)
      decode.success(PlayerViewer(player))
    }
    _ -> decode.success(ReviewerViewer)
  }
}

fn facet_states() -> decode.Decoder(canonical.Value) {
  let states = decode.dict(decode.string, decode.string)
  let object = fn(d) {
    canonical.Object(
      dict.to_list(d) |> list.map(fn(kv) { #(kv.0, canonical.Str(kv.1)) }),
    )
  }
  use fifa <- decode.field("fifa_licence", decode.string)
  use national <- decode.field("national_registration", states)
  use domestic <- decode.field("domestic_authorisation", states)
  use minors <- decode.field("minors_authorisation", states)
  decode.success(
    canonical.Object([
      #("fifa_licence", canonical.Str(fifa)),
      #("national_registration", object(national)),
      #("domestic_authorisation", object(domestic)),
      #("minors_authorisation", object(minors)),
    ]),
  )
}

/// A case's answers, each with the field it is blessed in.
type Case {
  Case(answers: List(#(String, Json)))
}

fn case_decoder() -> decode.Decoder(Case) {
  let text = decode.optional(decode.string)
  use outcome <- decode.subfield(
    ["stateInput", "outcome"],
    decode.optional(context_outcome.decoder()),
  )
  use gate <- decode.subfield(
    ["stateInput", "gate"],
    decode.optional(pending_reason.decoder()),
  )
  use reasons <- decode.subfield(
    ["stateInput", "reasons"],
    decode.list(decode.string),
  )
  use rep_count <- decode.subfield(
    ["stateInput", "representationCount"],
    decode.int,
  )
  use confirmed <- decode.subfield(
    ["stateInput", "partiesConfirmed"],
    decode.bool,
  )
  use status <- decode.field("status", transaction_status.decoder())
  use stale <- decode.field("staleness", decode.optional(staleness.decoder()))
  use sees_state <- decode.field("readinessSeesState", decode.bool)
  use viewer <- decode.field("viewer", viewer())
  use parties <- decode.subfield(
    ["revisionInput", "parties"],
    decode.list(party()),
  )
  use agent <- decode.subfield(["revisionInput", "agentUserId"], decode.string)
  use reps <- decode.subfield(
    ["revisionInput", "representations"],
    decode.list({
      use a <- decode.field("agentUserId", decode.string)
      use r <- decode.field("partyRole", party_role.decoder())
      use s <- decode.field("status", decode.string)
      use g <- decode.field("agreementId", text)
      decode.success(#(a, r, s, g))
    }),
  )
  use consents <- decode.subfield(
    ["revisionInput", "consents"],
    decode.list({
      use i <- decode.field("id", decode.string)
      use s <- decode.field("status", decode.string)
      decode.success(#(i, s))
    }),
  )
  use facets <- decode.subfield(
    ["revisionInput", "facetStates"],
    facet_states(),
  )
  use versions <- decode.subfield(
    ["revisionInput", "policyVersions"],
    decode.list(id.policy_decoder()),
  )
  use blocked_ids <- decode.subfield(
    ["revisionInput", "blockedSubjectIds"],
    decode.list(decode.string),
  )
  use minor_ids <- decode.subfield(
    ["revisionInput", "minorSubjectIds"],
    decode.list(decode.string),
  )

  let state =
    transaction_rules.state_from(outcome, gate, reasons, rep_count, confirmed)
  let readiness =
    transaction_rules.offer_readiness(
      status,
      parties,
      case sees_state {
        True -> Some(state)
        False -> None
      },
      stale,
    )
  let got_roles =
    transaction_rules.room_roles("agency-1", "usr-a", parties, viewer)
  let got_side = case viewer {
    ClubViewer(org, ..) -> transaction_rules.club_party_role(parties, org)
    PlayerViewer(_) -> Some(party_role.Individual)
    _ -> None
  }
  let got_revision =
    transaction_rules.party_revision(
      parties,
      agent,
      reps,
      consents,
      facets,
      versions,
      blocked_ids,
      minor_ids,
    )
  let visibilities = fn(vs) { json.array(vs, document_visibility.to_json) }
  decode.success(
    Case([
      #(
        "state",
        json.object([
          #("outcome", json.nullable(state.outcome, context_outcome.to_json)),
          #("reasonCodes", json.array(state.reason_codes, json.string)),
          #(
            "pendingReason",
            json.nullable(state.pending_reason, pending_reason.to_json),
          ),
          #("blocked", json.bool(state.blocked)),
          #("clear", json.bool(state.clear)),
        ]),
      ),
      #(
        "statusFor",
        transaction_status.to_json(transaction_rules.status_for(state)),
      ),
      #(
        "readiness",
        json.object([
          #("canStartOfferWorkflow", json.bool(readiness.can_start)),
          #("blockers", json.array(readiness.blockers, json.string)),
        ]),
      ),
      #(
        "roles",
        json.array(got_roles, fn(r) {
          json.string(transaction_rules.room_role_to_string(r))
        }),
      ),
      #("partyRole", json.nullable(got_side, party_role.to_json)),
      #(
        "canSee",
        list.filter(document_visibility.pairs |> list.map(fn(p) { p.1 }), fn(v) {
          transaction_rules.can_see(v, got_roles, got_side)
        })
          |> visibilities,
      ),
      #(
        "uploadable",
        visibilities(transaction_rules.uploadable(got_roles, got_side)),
      ),
      #("revision", json.string(got_revision)),
    ]),
  )
}

pub fn the_rules_give_the_blessed_answers_test() {
  let f = blessed.load("transaction_cases")
  blessed.items(blessed.root(f))
  |> list.index_map(fn(item, i) {
    let c = blessed.read(item, case_decoder())
    list.map(c.answers, fn(a) {
      blessed.answer(
        blessed.field(item, a.0),
        "case " <> int.to_string(i) <> " " <> a.0,
        a.1,
      )
    })
  })
  |> list.flatten
  |> blessed.check(f, _)
}
