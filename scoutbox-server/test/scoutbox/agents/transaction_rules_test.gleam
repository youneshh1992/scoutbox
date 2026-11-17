//// The ported transaction rules agree with domains/agents/transactions/transaction.mjs on every case in
//// test/fixtures/transaction_cases.json (written by `node dev/transaction_cases.mjs`): the compliance state and the
//// status it asks for, the Offer readiness, room roles, the visibility classes a viewer may read and file into, and
//// the party-revision hash.

import gleam/dict
import gleam/dynamic/decode
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleam/string
import scoutbox/agents/transaction_rules.{
  AgencyViewer, ClubViewer, PlayerViewer, ReviewerViewer, State,
}
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
import simplifile

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

type Case {
  Case(checks: List(#(String, Bool, String)))
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
  use want_state <- decode.field("state", {
    use outcome <- decode.field(
      "outcome",
      decode.optional(context_outcome.decoder()),
    )
    use codes <- decode.field("reasonCodes", decode.list(decode.string))
    use pending <- decode.field(
      "pendingReason",
      decode.optional(pending_reason.decoder()),
    )
    use blocked <- decode.field("blocked", decode.bool)
    use clear <- decode.field("clear", decode.bool)
    decode.success(State(outcome, codes, pending, blocked, clear))
  })
  use status_for <- decode.field("statusFor", transaction_status.decoder())
  use status <- decode.field("status", transaction_status.decoder())
  use stale <- decode.field("staleness", decode.optional(staleness.decoder()))
  use sees_state <- decode.field("readinessSeesState", decode.bool)
  use can_start <- decode.subfield(
    ["readiness", "canStartOfferWorkflow"],
    decode.bool,
  )
  use blockers <- decode.subfield(
    ["readiness", "blockers"],
    decode.list(decode.string),
  )
  use viewer <- decode.field("viewer", viewer())
  use roles <- decode.field("roles", decode.list(decode.string))
  use side <- decode.field("partyRole", decode.optional(party_role.decoder()))
  use can_see <- decode.field(
    "canSee",
    decode.list(document_visibility.decoder()),
  )
  use uploadable <- decode.field(
    "uploadable",
    decode.list(document_visibility.decoder()),
  )
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
  use revision <- decode.field("revision", decode.string)

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
  decode.success(
    Case([
      #("state", state == want_state, string.inspect(#(state, want_state))),
      #(
        "status",
        transaction_rules.status_for(state) == status_for,
        string.inspect(transaction_rules.status_for(state)),
      ),
      #(
        "readiness",
        readiness.can_start == can_start && readiness.blockers == blockers,
        string.inspect(#(readiness, blockers)),
      ),
      #(
        "roles",
        list.map(got_roles, transaction_rules.room_role_to_string) == roles,
        string.inspect(#(got_roles, roles)),
      ),
      #("side", got_side == side, string.inspect(#(got_side, side))),
      #(
        "can see",
        list.filter(document_visibility.pairs |> list.map(fn(p) { p.1 }), fn(v) {
          transaction_rules.can_see(v, got_roles, got_side)
        })
          == can_see,
        string.inspect(can_see),
      ),
      #(
        "uploadable",
        transaction_rules.uploadable(got_roles, got_side) == uploadable,
        string.inspect(uploadable),
      ),
      #(
        "revision",
        got_revision == revision,
        string.inspect(#(got_revision, revision)),
      ),
    ]),
  )
}

pub fn the_ported_rules_agree_with_typescript_on_every_case_test() {
  let assert Ok(text) = simplifile.read("test/fixtures/transaction_cases.json")
  let assert Ok(cases) = json.parse(text, decode.list(case_decoder()))
  let failures =
    cases
    |> list.index_map(fn(c, i) {
      list.filter_map(c.checks, fn(check) {
        case check.1 {
          True -> Error(Nil)
          False ->
            Ok("case " <> int.to_string(i) <> ": " <> check.0 <> " " <> check.2)
        }
      })
    })
    |> list.flatten
  case failures {
    [] -> Nil
    [first, ..] ->
      panic as {
        int.to_string(list.length(failures)) <> " mismatches; first " <> first
      }
  }
}
