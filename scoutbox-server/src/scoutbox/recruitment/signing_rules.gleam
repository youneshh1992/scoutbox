//// The signing domain, pure (domains/recruitment/signings/signing.mjs): every function takes a package and answers.
////
//// A package is the workflow record, opened by a club act over an accepted Offer revision, with immutable revisions
//// (exact document, digest, required parties, contract dates). A completed signing is a separate record, written
//// once by the completion, that the lifecycle's `signed` state rests on. A partial, cancelled, voided, expired or
//// superseded package is not a signing; an agent never signs as anyone.
////
//// The rules read a package as the TypeScript repository assembles it from its rows: a party's `completedBy` is
//// absent only when its kind, id and name all are, its evidence reference only when its kind and id both are, and
//// a missing `for_player_id` names no player (so it is another player's).

import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/platform/input
import scoutbox/platform/temporal
import scoutbox/recruitment/cases.{type Room}
import scoutbox/recruitment/offer_rules.{type Offer}
import scoutbox/rows/id
import scoutbox/rows/idempotency_keys as key_row
import scoutbox/rows/offer_responses as response_row
import scoutbox/rows/players as player_row
import scoutbox/rows/signing_documents as doc_row
import scoutbox/rows/signing_history as event_row
import scoutbox/rows/signing_packages as pkg_row
import scoutbox/rows/signing_revision_parties as party_row
import scoutbox/rows/signing_revisions as rev_row
import scoutbox/rows/signings as signing_row
import scoutbox/vocab/offer_status
import scoutbox/vocab/recruitment_actor_kind.{type RecruitmentActorKind}
import scoutbox/vocab/room_status
import scoutbox/vocab/signing_method
import scoutbox/vocab/signing_party_type.{type SigningPartyType}

pub const policy_version = 1

pub const limit_label = 120

pub const limit_filename = 255

pub const limit_internal_note = 2000

pub const limit_reason = 500

const day_ms = 86_400_000

pub const min_expiry_ms = 3_600_000

pub const max_expiry_ms = 7_776_000_000

pub const default_expiry_ms = 2_592_000_000

const max_contract_years = 10

// ------------------------------------------------------------------------------------------------------ records

pub type Package {
  Package(
    row: pkg_row.Row,
    revisions: List(Revision),
    history: List(event_row.Row),
    keys: List(key_row.Row),
  )
}

pub type Revision {
  Revision(
    row: rev_row.Row,
    document: Option(doc_row.Row),
    executed: Option(doc_row.Row),
    parties: List(party_row.Row),
  )
}

/// A package's status as read: the stored word, or EXPIRED once a live package's expiry has passed (never written).
/// SUPERSEDED belongs to revisions only.
pub type Status {
  Draft
  Ready
  InProgress
  Completed
  Cancelled
  Voided
  Expired
  Superseded
}

pub const statuses = [
  Draft,
  Ready,
  InProgress,
  Completed,
  Cancelled,
  Voided,
  Expired,
  Superseded,
]

pub fn status_name(s: Status) -> String {
  case s {
    Draft -> "DRAFT"
    Ready -> "READY"
    InProgress -> "IN_PROGRESS"
    Completed -> "COMPLETED"
    Cancelled -> "CANCELLED"
    Voided -> "VOIDED"
    Expired -> "EXPIRED"
    Superseded -> "SUPERSEDED"
  }
}

pub fn status_label(s: Status) -> String {
  case s {
    Draft -> "Draft — not presented for signing"
    Ready -> "Presented — awaiting signatures"
    InProgress -> "In progress — some signatures recorded"
    Completed -> "Signing completed"
    Cancelled -> "Cancelled"
    Voided -> "Voided"
    Expired -> "Expired — not completed in time"
    Superseded -> "Superseded by a newer signing revision"
  }
}

pub fn stored(s: pkg_row.Status) -> Status {
  case s {
    pkg_row.Draft -> Draft
    pkg_row.Ready -> Ready
    pkg_row.InProgress -> InProgress
    pkg_row.Completed -> Completed
    pkg_row.Cancelled -> Cancelled
    pkg_row.Voided -> Voided
  }
}

pub fn revision_status(s: rev_row.Status) -> Status {
  case s {
    rev_row.Draft -> Draft
    rev_row.Ready -> Ready
    rev_row.InProgress -> InProgress
    rev_row.Completed -> Completed
    rev_row.Cancelled -> Cancelled
    rev_row.Voided -> Voided
    rev_row.Superseded -> Superseded
  }
}

pub fn is_terminal(s: Status) -> Bool {
  s == Completed || s == Cancelled || s == Voided || s == Expired
}

fn live(s: Status) -> Bool {
  s == Draft || s == Ready || s == InProgress
}

/// The stored status, or EXPIRED at and after a live package's expiry.
pub fn effective_status(p: Package, now: Int) -> Status {
  let st = stored(p.row.status)
  case live(st), p.row.expires_at {
    True, Some(exp) if now >= exp -> Expired
    _, _ -> st
  }
}

pub fn is_live(p: Package, now: Int) -> Bool {
  live(effective_status(p, now))
}

/// The minor signing pathway is closed in every jurisdiction in this build.
pub fn minor_pathway_open(_jurisdiction: String) -> Bool {
  False
}

pub const minor_pathway_jurisdictions = ["GB", "ENG", "INT", "USA", "DEFAULT"]

// ------------------------------------------------------------------------------------------------------ reading

pub fn current_revision(p: Package) -> Option(Revision) {
  list.find(p.revisions, fn(r) { r.row.id == p.row.current_revision_id })
  |> option.from_result
}

pub fn revision(p: Package, revision_id: String) -> Option(Revision) {
  list.find(p.revisions, fn(r) {
    id.signing_revision_to_string(r.row.id) == revision_id
  })
  |> option.from_result
}

pub fn next_revision_number(p: Package) -> Int {
  list.fold(p.revisions, 0, fn(m, r) { int.max(m, r.row.revision_number) }) + 1
}

pub fn parties_complete(r: Revision) -> Bool {
  r.parties != []
  && list.all(r.parties, fn(p) { p.status == party_row.Completed })
}

/// The party of `party_type` (naming `for_entity` when given).
pub fn find_party(
  r: Revision,
  party_type: SigningPartyType,
  for_entity: Option(String),
) -> Option(party_row.Row) {
  list.find(r.parties, fn(p) {
    p.party_type == party_type
    && { for_entity == None || p.for_entity_id == for_entity }
  })
  |> option.from_result
}

/// Who completed a party, as the record reads it: absent when its kind, id and name all are.
pub type PartyActor {
  PartyActor(
    kind: Option(RecruitmentActorKind),
    id: Option(String),
    name: Option(String),
  )
}

pub fn completed_by(p: party_row.Row) -> Option(PartyActor) {
  case p.completed_by_kind, p.completed_by_id, p.completed_by_name {
    None, None, None -> None
    kind, who, name -> Some(PartyActor(kind, who, name))
  }
}

fn has_evidence(p: party_row.Row) -> Bool {
  p.evidence_ref_kind != None || p.evidence_ref_id != None
}

/// The key row of `act` written with `key`.
pub fn key_row(p: Package, act: String, key: String) -> Option(key_row.Row) {
  list.find(p.keys, fn(k) { k.act == act && k.key == Some(key) })
  |> option.from_result
}

/// A field of a key row's entry (`actorId`, `revisionId`, `signingId`).
pub fn key_entry(k: key_row.Row, field: String) -> Option(String) {
  json.parse(k.entry_json, decode.at([field], decode.optional(decode.string)))
  |> result.unwrap(None)
}

// ------------------------------------------------------------------------------------------------------ refusals

pub type Refusal {
  Refusal(error: String, message: String, fields: List(#(String, Json)))
}

fn refusal(error: String, message: String) -> Refusal {
  Refusal(error, message, [])
}

fn with_current(r: Refusal, current: List(#(String, Json))) -> Refusal {
  Refusal(..r, fields: [#("current", json.object(current)), ..r.fields])
}

pub fn state_unknown() -> Refusal {
  refusal("SIGNING_STATE_UNKNOWN", "This signing cannot be read.")
}

// ------------------------------------------------------------------------------------------------------ input

/// Text as a signing stores it: control, directional and zero-width characters stripped, `\r\n?` folded to `\n`,
/// trimmed; empty is nothing. Error: it is longer than `max` (UTF-16 units) once cleaned.
pub fn clean_text(
  raw: Option(String),
  max: Int,
) -> Result(Option(String), Nil) {
  case raw {
    None | Some("") -> Ok(None)
    Some(s) -> {
      let kept =
        string.to_utf_codepoints(s)
        |> list.filter(fn(cp) { !control(string.utf_codepoint_to_int(cp)) })
        |> string.from_utf_codepoints
        |> string.replace("\r\n", "\n")
        |> string.replace("\r", "\n")
        |> string.trim
      case input.utf16_length(kept) > max, kept {
        True, _ -> Error(Nil)
        False, "" -> Ok(None)
        False, v -> Ok(Some(v))
      }
    }
  }
}

fn control(c: Int) -> Bool {
  { c >= 0x00 && c <= 0x08 }
  || c == 0x0B
  || c == 0x0C
  || { c >= 0x0E && c <= 0x1F }
  || { c >= 0x7F && c <= 0x9F }
  || { c >= 0x200B && c <= 0x200F }
  || { c >= 0x202A && c <= 0x202E }
  || { c >= 0x2060 && c <= 0x2064 }
  || { c >= 0x2066 && c <= 0x2069 }
  || c == 0xFEFF
}

pub type Contract {
  Contract(start: String, end: Option(String))
}

/// Contract days (validateContractDates): a real start, an end not before it and at most ten years after it.
pub fn validate_contract_dates(
  start: Option(String),
  end: Option(String),
) -> Result(Contract, Refusal) {
  let refuse = fn(field, problem, message) {
    Error(
      Refusal("SIGNING_CONTRACT_DATES_INVALID", message, [
        #("field", json.string("contract." <> field)),
        #("problem", json.string(problem)),
      ]),
    )
  }
  let day = fn(s: Option(String)) {
    case s {
      None | Some("") -> Error(True)
      Some(s) ->
        case temporal.parse_day(s) {
          Ok(d) -> Ok(#(s, temporal.day_start(d)))
          Error(_) -> Error(False)
        }
    }
  }
  case day(start) {
    Error(True) ->
      refuse("startDate", "required", "The contract start is required.")
    Error(False) ->
      refuse(
        "startDate",
        "not_a_date",
        "The contract start must be a real calendar day (YYYY-MM-DD).",
      )
    Ok(#(s, st)) ->
      case day(end) {
        Error(True) -> Ok(Contract(s, None))
        Error(False) ->
          refuse(
            "endDate",
            "not_a_date",
            "The contract end must be a real calendar day (YYYY-MM-DD).",
          )
        Ok(#(_, et)) if et < st ->
          refuse(
            "endDate",
            "invalid",
            "The contract cannot end before it starts.",
          )
        Ok(#(_, et)) if et - st > max_contract_years * 366 * day_ms ->
          refuse(
            "endDate",
            "invalid",
            "A contract longer than "
              <> int.to_string(max_contract_years)
              <> " years cannot be recorded here.",
          )
        Ok(#(e, _)) -> Ok(Contract(s, Some(e)))
      }
  }
}

/// The expiry (validateExpiry): absent is the default; an instant at least an hour and at most 90 days away.
/// Ok: the instant and whether it was defaulted.
pub fn validate_expiry(
  raw: Option(decode.Dynamic),
  now: Int,
) -> Result(#(Int, Bool), Refusal) {
  let refuse = fn(problem, message, extra) {
    Error(
      Refusal("SIGNING_EXPIRY_INVALID", message, [
        #("field", json.string("expiresAt")),
        #("problem", json.string(problem)),
        ..extra
      ]),
    )
  }
  case raw {
    None -> Ok(#(now + default_expiry_ms, True))
    Some(v) ->
      case temporal.instant(v, 1900, 2100) {
        Error(_) ->
          refuse(
            "not_a_timestamp",
            "The expiry must be an ISO 8601 instant with an offset or a millisecond timestamp.",
            [#("expected", json.string("instant"))],
          )
        Ok(ms) if ms < now + min_expiry_ms ->
          refuse(
            "too_small",
            "A signing must stay open for at least one hour.",
            [],
          )
        Ok(ms) if ms > now + max_expiry_ms ->
          refuse(
            "too_large",
            "A signing cannot stay open for more than 90 days.",
            [],
          )
        Ok(ms) -> Ok(#(ms, False))
      }
  }
}

/// A required party as a revision snapshots it.
pub type PartySpec {
  PartySpec(
    party_type: SigningPartyType,
    for_entity_id: String,
    for_player_id: id.PlayerId,
  )
}

/// The required parties (requiredPartiesFor): the recipient (the player, or their guardian) and the club signatory.
pub fn required_parties_for(
  guardian: Option(id.GuardianId),
  player_id: id.PlayerId,
  org_id: id.OrgId,
) -> List(PartySpec) {
  [
    case guardian {
      Some(g) ->
        PartySpec(
          signing_party_type.Guardian,
          id.guardian_to_string(g),
          player_id,
        )
      None ->
        PartySpec(
          signing_party_type.Player,
          id.player_to_string(player_id),
          player_id,
        )
    },
    PartySpec(
      signing_party_type.ClubSignatory,
      id.org_to_string(org_id),
      player_id,
    ),
  ]
}

// ------------------------------------------------------------------------------------------------------ gates

pub type StartFacts {
  StartFacts(
    offer_status: Option(offer_status.OfferStatus),
    offer_revision_status: Option(offer_status.OfferStatus),
    case_status: Option(room_status.RoomStatus),
    /// "player" or "guardian", from the accepted revision's recipient; None when it names neither.
    recipient: Option(String),
    jurisdiction: String,
    existing: List(Package),
  )
}

pub fn can_start(f: StartFacts, now: Int) -> Result(Nil, Refusal) {
  let completed =
    list.find(f.existing, fn(p) { effective_status(p, now) == Completed })
  let live_one = list.find(f.existing, fn(p) { is_live(p, now) })
  case completed, live_one {
    Ok(c), _ ->
      Error(
        refusal(
          "SIGNING_ALREADY_COMPLETED",
          "A completed signing already exists for this Offer.",
        )
        |> with_current([
          #("signingPackageId", id.signing_package_json(c.row.id)),
        ]),
      )
    _, Ok(l) ->
      Error(
        refusal(
          "SIGNING_PACKAGE_EXISTS",
          "A signing is already open for this Offer.",
        )
        |> with_current([
          #("signingPackageId", id.signing_package_json(l.row.id)),
          #("status", json.string(status_name(effective_status(l, now)))),
        ]),
      )
    _, _ ->
      case
        f.offer_status != Some(offer_status.Accepted)
        || f.offer_revision_status != Some(offer_status.Accepted)
      {
        True ->
          Error(refusal(
            "SIGNING_OFFER_NOT_ACCEPTED",
            "A signing can only be opened over an accepted Offer revision.",
          ))
        False ->
          case f.case_status {
            Some(room_status.OfferAccepted) ->
              case f.recipient {
                Some("guardian") ->
                  case minor_pathway_open(f.jurisdiction) {
                    True -> Ok(Nil)
                    False ->
                      Error(refusal(
                        "SIGNING_PATHWAY_CLOSED",
                        "Signing for a player under the age of majority is not open in this jurisdiction.",
                      ))
                  }
                Some("player") -> Ok(Nil)
                _ ->
                  Error(refusal(
                    "SIGNING_RECIPIENT_INVALID",
                    "The Offer names no valid signatory.",
                  ))
              }
            other ->
              Error(
                refusal(
                  "SIGNING_LIFECYCLE_CONFLICT",
                  "The case is not at Offer accepted.",
                )
                |> with_current([
                  #("status", json.nullable(other, room_status.to_json)),
                ]),
              )
          }
      }
  }
}

/// The package's status if it is one of `allowed`, or the refusal its status calls for.
pub fn state_refusal(
  p: Package,
  now: Int,
  allowed: List(Status),
) -> Result(Status, Refusal) {
  let st = effective_status(p, now)
  case list.contains(allowed, st) {
    True -> Ok(st)
    False ->
      Error(
        refusal(
          case st {
            Expired -> "SIGNING_EXPIRED"
            Cancelled -> "SIGNING_CANCELLED"
            Voided -> "SIGNING_VOIDED"
            Completed -> "SIGNING_ALREADY_COMPLETED"
            _ -> "SIGNING_STATE_INVALID"
          },
          "This signing is " <> status_label(st) <> ".",
        )
        |> with_current([#("status", json.string(status_name(st)))]),
      )
  }
}

pub fn can_attach_document(p: Package, now: Int) -> Result(Status, Refusal) {
  state_refusal(p, now, [Draft])
}

pub fn can_cancel(p: Package, now: Int) -> Result(Status, Refusal) {
  state_refusal(p, now, [Draft, Ready, InProgress])
}

pub fn can_void(p: Package, now: Int) -> Result(Status, Refusal) {
  state_refusal(p, now, [Ready, InProgress])
}

pub fn can_supersede(p: Package, now: Int) -> Result(Status, Refusal) {
  state_refusal(p, now, [Ready, InProgress])
}

pub fn can_mark_ready(p: Package, now: Int) -> Result(Revision, Refusal) {
  use _ <- result.try(state_refusal(p, now, [Draft]))
  case current_revision(p) {
    None -> Error(state_unknown())
    Some(r) ->
      case r.document, r.row.contract_start_date, r.parties {
        None, _, _ ->
          Error(refusal(
            "SIGNING_DOCUMENT_REQUIRED",
            "Attach the exact document the parties will sign before presenting it.",
          ))
        Some(d), _, _ if d.sha256 == "" ->
          Error(refusal(
            "SIGNING_DOCUMENT_REQUIRED",
            "Attach the exact document the parties will sign before presenting it.",
          ))
        _, None, _ | _, Some(""), _ ->
          Error(
            Refusal(
              "SIGNING_CONTRACT_DATES_INVALID",
              "The contract start day is required before presenting.",
              [#("field", json.string("startDate"))],
            ),
          )
        _, _, [] ->
          Error(refusal(
            "SIGNING_STATE_INVALID",
            "No required party is recorded.",
          ))
        _, _, _ -> Ok(r)
      }
  }
}

fn actor_kinds(party_type: SigningPartyType) -> RecruitmentActorKind {
  case party_type {
    signing_party_type.Player -> recruitment_actor_kind.Player
    signing_party_type.Guardian -> recruitment_actor_kind.Guardian
    signing_party_type.ClubSignatory -> recruitment_actor_kind.Org
  }
}

/// The actor is the authenticated session, and names the digest of the exact current revision.
pub fn can_complete_party(
  p: Package,
  party_type: SigningPartyType,
  actor_kind: RecruitmentActorKind,
  actor_id: String,
  revision_id: String,
  document_sha256: String,
  now: Int,
) -> Result(#(Revision, party_row.Row), Refusal) {
  let current_id = id.signing_revision_to_string(p.row.current_revision_id)
  let superseded_earlier = case is_live(p, now) && revision_id != current_id {
    True ->
      case revision(p, revision_id) {
        Some(r) if r.row.status == rev_row.Superseded -> True
        _ -> False
      }
    False -> False
  }
  case superseded_earlier {
    True ->
      Error(
        refusal(
          "SIGNING_SUPERSEDED",
          "That signing revision was replaced. Sign the current revision once it is presented.",
        )
        |> with_current([#("revisionId", json.string(current_id))]),
      )
    False -> {
      use _ <- result.try(state_refusal(p, now, [Ready, InProgress]))
      case current_revision(p) {
        None -> Error(state_unknown())
        Some(rev) -> {
          let rev_id = id.signing_revision_to_string(rev.row.id)
          case revision_id == rev_id {
            False ->
              case revision(p, revision_id) {
                Some(_) ->
                  Error(
                    refusal(
                      "SIGNING_SUPERSEDED",
                      "That signing revision was replaced. Sign the current revision.",
                    )
                    |> with_current([#("revisionId", json.string(rev_id))]),
                  )
                None ->
                  Error(
                    Refusal(
                      "SIGNING_INPUT_INVALID",
                      "Name the signing revision you are completing.",
                      [#("field", json.string("revisionId"))],
                    ),
                  )
              }
            True ->
              case actor_kinds(party_type) == actor_kind {
                False ->
                  Error(refusal(
                    "SIGNING_NOT_PERMITTED",
                    "You cannot sign for that party.",
                  ))
                True -> {
                  let entity = case party_type {
                    signing_party_type.ClubSignatory ->
                      id.org_to_string(p.row.org_id)
                    _ -> actor_id
                  }
                  case find_party(rev, party_type, Some(entity)) {
                    None ->
                      Error(refusal(
                        "SIGNING_PARTY_NOT_REQUIRED",
                        "This signing does not require your signature.",
                      ))
                    Some(party) if party.status == party_row.Completed ->
                      Error(refusal(
                        "SIGNING_PARTY_ALREADY_COMPLETED",
                        "Your signature is already recorded on this revision.",
                      ))
                    Some(party) -> {
                      let named = string.lowercase(document_sha256)
                      case
                        option.map(rev.document, fn(d) {
                          string.lowercase(d.sha256)
                        })
                      {
                        Some(sha) if sha != "" && sha == named ->
                          Ok(#(rev, party))
                        _ ->
                          Error(refusal(
                            "SIGNING_DOCUMENT_MISMATCH",
                            "Confirm the exact document you read: its digest does not match the revision presented.",
                          ))
                      }
                    }
                  }
                }
              }
          }
        }
      }
    }
  }
}

pub type GateFacts {
  GateFacts(
    now: Int,
    offer: Option(Offer),
    kase: Option(Room),
    other_completed: Bool,
    blocked: Bool,
    document_problem: Option(String),
  )
}

/// Every unmet condition, named; only an empty list lets completion run.
pub fn completion_gate(p: Package, f: GateFacts) -> List(String) {
  let now = f.now
  let doc = case f.document_problem {
    Some(dp) -> ["DOCUMENT_BYTES_" <> string.uppercase(dp)]
    None -> []
  }
  let state = case effective_status(p, now) {
    Completed -> ["ALREADY_COMPLETED"]
    Expired -> ["EXPIRED"]
    Ready | InProgress -> []
    other -> ["STATE_" <> status_name(other)]
  }
  let rev = case current_revision(p) {
    None -> ["REVISION_MISSING"]
    Some(r) -> {
      let active =
        r.row.status == rev_row.Ready || r.row.status == rev_row.InProgress
      let sha = option.map(r.document, fn(d) { d.sha256 })
      let r0 = option.unwrap(r.row.ready_at, r.row.created_at)
      list.flatten([
        case active {
          True -> []
          False -> ["REVISION_NOT_ACTIVE"]
        },
        case r.document {
          Some(d) if d.sha256 != "" -> []
          _ -> ["DOCUMENT_REQUIRED"]
        },
        case parties_complete(r) {
          True -> []
          False -> ["PARTIES_INCOMPLETE"]
        },
        list.flat_map(r.parties, fn(q) {
          case q.status {
            party_row.Pending -> []
            party_row.Completed ->
              list.flatten([
                case has_evidence(q) && q.method != None {
                  True -> []
                  False -> ["EVIDENCE_INVALID"]
                },
                case q.evidence_document_sha256, sha {
                  Some(e), Some(s) if e != s && e != "" && s != "" -> [
                    "DOCUMENT_MISMATCH",
                  ]
                  _, _ -> []
                },
                case q.completed_at {
                  None -> ["TEMPORAL_ORDER"]
                  Some(c) if c < r0 -> ["TEMPORAL_ORDER"]
                  Some(_) -> []
                },
              ])
          }
        }),
        case r.row.contract_start_date {
          None | Some("") -> ["CONTRACT_DATES_INVALID"]
          Some(_) -> []
        },
      ])
    }
  }
  let offer_id = p.row.offer_id
  let offer = case f.offer {
    Some(o) ->
      list.flatten([
        case
          offer_rules.status(o, now) == Some(offer_status.Accepted)
          && o.row.id == offer_id
        {
          True -> []
          False -> ["OFFER_NOT_ACCEPTED"]
        },
        case
          list.find(o.revisions, fn(r) {
            id.offer_revision_to_string(r.row.id) == p.row.offer_revision_id
          })
          |> result.map(fn(r) { offer_rules.effective(r.row, now) })
        {
          Ok(offer_status.Accepted) -> []
          _ -> ["OFFER_REVISION_MISMATCH"]
        },
        case
          o.row.org_id != p.row.org_id
          || o.row.player_id != p.row.player_id
          || o.row.case_id != p.row.case_id
        {
          True -> ["REFERENCE_MISMATCH"]
          False -> []
        },
      ])
    None -> ["OFFER_NOT_ACCEPTED", "OFFER_REVISION_MISMATCH"]
  }
  let kase = case f.kase {
    Some(k)
      if k.row.id == p.row.case_id
      && k.row.org_id == p.row.org_id
      && k.row.player_id == p.row.player_id
    ->
      case k.status == room_status.OfferAccepted {
        True -> []
        False -> ["LIFECYCLE_CONFLICT"]
      }
    _ -> ["CASE_MISMATCH"]
  }
  list.flatten([
    doc,
    state,
    rev,
    offer,
    kase,
    case f.other_completed {
      True -> ["CONFLICTING_COMPLETED_SIGNING"]
      False -> []
    },
    case f.blocked {
      True -> ["BLOCKED"]
      False -> []
    },
  ])
}

// ------------------------------------------------------------------------------------------------------ integrity

fn when(c: Bool, problem: String) -> List(String) {
  case c {
    True -> [problem]
    False -> []
  }
}

fn valid_day(s: Option(String)) -> Bool {
  case s {
    None | Some("") -> True
    Some(d) -> result.is_ok(temporal.parse_day(d))
  }
}

/// Is this a package this server could have written? A row with any problem is refused and never repaired.
pub fn integrity(p: Package, org_id: Option(id.OrgId)) -> List(String) {
  let r0 = p.row
  let c0 = r0.created_at
  let base =
    list.flatten([
      when(id.signing_package_to_string(r0.id) == "", "id"),
      when(org_id != None && org_id != Some(r0.org_id), "org_mismatch"),
      when(id.org_to_string(r0.org_id) == "", "orgId"),
      when(id.player_to_string(r0.player_id) == "", "playerId"),
      when(id.recruitment_case_to_string(r0.case_id) == "", "caseId"),
      when(id.offer_to_string(r0.offer_id) == "", "offerId"),
      when(r0.offer_revision_id == "", "offerRevisionId"),
      case r0.expires_at {
        Some(exp) ->
          list.flatten([
            when(exp <= c0, "expiry_before_created"),
            {
              let worked =
                list.fold(p.revisions, c0, fn(m, r) {
                  int.max(
                    m,
                    int.max(r.row.created_at, option.unwrap(r.row.ready_at, 0)),
                  )
                })
              when(
                worked > 0 && exp > worked + max_expiry_ms + day_ms,
                "expiry_beyond_max",
              )
            },
          ])
        None -> []
      },
    ])
  let revisions = case p.revisions {
    [] -> ["revisions"]
    revs -> {
      let player = id.player_to_string(r0.player_id)
      let org = id.org_to_string(r0.org_id)
      let per =
        list.flat_map(revs, fn(r) {
          let rc = r.row.created_at
          let rr = r.row.ready_at
          let presented_status =
            r.row.status == rev_row.Ready
            || r.row.status == rev_row.InProgress
            || r.row.status == rev_row.Completed
          let doc_ok = case r.document {
            Some(d) -> d.sha256 != ""
            None -> False
          }
          let types = list.map(r.parties, fn(q) { q.party_type })
          list.flatten([
            when(r.row.revision_number < 1, "revision_number"),
            when(rc < c0, "revision_before_package"),
            case rr {
              Some(rr) -> when(rr < rc, "ready_before_created")
              None -> []
            },
            when(
              presented_status && { rr == None || !doc_ok },
              "presented_without_document",
            ),
            case r.parties {
              [] -> ["parties"]
              parties ->
                list.flatten([
                  when(
                    list.length(list.unique(types)) != list.length(types),
                    "party_duplicate",
                  ),
                  when(
                    !list.contains(types, signing_party_type.Player)
                      && !list.contains(types, signing_party_type.Guardian),
                    "party_recipient_missing",
                  ),
                  when(
                    list.contains(types, signing_party_type.Player)
                      && list.contains(types, signing_party_type.Guardian),
                    "party_recipient_duplicate",
                  ),
                  when(
                    !list.contains(types, signing_party_type.ClubSignatory),
                    "party_club_missing",
                  ),
                  list.flat_map(parties, fn(q) {
                    party_integrity(q, r, rr, player, org)
                  }),
                ])
            },
            case r.row.status == rev_row.Completed {
              True ->
                list.flatten([
                  when(!parties_complete(r), "completed_without_parties"),
                  {
                    let max_party =
                      list.fold(r.parties, -1, fn(m, q) {
                        int.max(m, option.unwrap(q.completed_at, 0))
                      })
                    case r.row.completed_at {
                      None -> ["completed_before_parties"]
                      Some(c) -> when(c < max_party, "completed_before_parties")
                    }
                  },
                ])
              False -> []
            },
            when(!valid_day(r.row.contract_start_date), "contract_dates"),
            when(!valid_day(r.row.contract_end_date), "contract_dates"),
          ])
        })
      let current = case current_revision(p) {
        None -> ["current_revision"]
        Some(cur) ->
          list.flatten([
            when(
              list.any(revs, fn(r) {
                r.row.id != cur.row.id
                && r.row.revision_number > cur.row.revision_number
              }),
              "current_revision_not_latest",
            ),
            when(
              r0.status == pkg_row.Completed
                && cur.row.status != rev_row.Completed,
              "completed_package_revision_mismatch",
            ),
          ])
      }
      list.append(per, current)
    }
  }
  let completion = case r0.status, r0.completion_signing_id {
    pkg_row.Completed, None -> ["completion"]
    pkg_row.Completed, Some(_) ->
      when(r0.completion_completed_at == None, "completion")
    _, Some(_) -> ["completion_without_status"]
    _, None -> []
  }
  list.flatten([base, revisions, completion])
}

fn party_integrity(
  q: party_row.Row,
  r: Revision,
  rr: Option(Int),
  player: String,
  org: String,
) -> List(String) {
  let by = completed_by(q)
  list.flatten([
    when(
      option.map(q.for_player_id, id.player_to_string) != Some(player),
      "party_player_mismatch",
    ),
    when(
      q.party_type == signing_party_type.Player
        && q.for_entity_id != Some(player),
      "party_entity_mismatch",
    ),
    when(
      q.party_type == signing_party_type.ClubSignatory
        && q.for_entity_id != Some(org),
      "party_entity_mismatch",
    ),
    case q.status {
      party_row.Completed -> {
        let pc = q.completed_at
        list.flatten([
          when(
            pc == None || by == None || q.method == None || !has_evidence(q),
            "party_evidence",
          ),
          case pc, rr {
            Some(pc), Some(rr) -> when(pc < rr, "party_before_ready")
            _, _ -> []
          },
          case by {
            Some(b) ->
              when(
                b.kind != Some(actor_kinds(q.party_type)),
                "party_actor_kind",
              )
            None -> []
          },
          case has_evidence(q) {
            False -> []
            True ->
              list.flatten([
                when(
                  q.evidence_revision_id != Some(r.row.id),
                  "party_evidence_revision",
                ),
                case r.document {
                  Some(d) if d.sha256 != "" ->
                    when(
                      q.evidence_document_sha256 != Some(d.sha256),
                      "party_evidence_digest",
                    )
                  _ -> []
                },
                case by {
                  Some(b) ->
                    when(
                      q.evidence_actor_id != b.id
                        || q.evidence_actor_kind
                        != option.map(b.kind, recruitment_actor_kind.to_string),
                      "party_evidence_actor",
                    )
                  None -> []
                },
                case pc {
                  Some(pc) ->
                    when(q.evidence_at != Some(pc), "party_evidence_instant")
                  None -> []
                },
              ])
          },
        ])
      }
      party_row.Pending ->
        when(
          q.completed_at != None || by != None || has_evidence(q),
          "party_pending_with_evidence",
        )
    },
  ])
}

/// A package whose Offer, case or completed record contradicts it is corruption (signingConsistency). The
/// player's contract status may lawfully move later, so a divergence there is only a warning.
pub fn consistency(
  p: Package,
  offer: Option(Offer),
  kase: Option(Room),
  rows: List(signing_row.Row),
  player: Option(player_row.Row),
  now: Int,
) -> List(String) {
  let st = effective_status(p, now)
  let mine = list.filter(rows, fn(s) { s.signing_package_id == Some(p.row.id) })
  let row_problems =
    list.flatten([
      when(st == Completed && mine == [], "COMPLETED_WITHOUT_ROW"),
      when(list.length(mine) > 1, "DUPLICATE_SIGNING_ROWS"),
      when(st != Completed && mine != [], "ROW_WITHOUT_COMPLETION"),
      case st, p.row.completion_signing_id {
        Completed, Some(sid) ->
          when(
            !list.any(mine, fn(s) { s.id == sid }),
            "COMPLETION_ROW_MISMATCH",
          )
        _, _ -> []
      },
    ])
  let player_problem = case player {
    Some(pl) ->
      when(
        st == Completed && pl.contract_status != player_row.UnderContract,
        "PLAYER_CONTRACT_STATUS_DIVERGED",
      )
    None -> []
  }
  let offer_reference = case offer {
    None -> []
    Some(o) ->
      when(
        o.row.org_id != p.row.org_id
          || o.row.player_id != p.row.player_id
          || o.row.case_id != p.row.case_id,
        "OFFER_REFERENCE_MISMATCH",
      )
  }
  let case_reference = case kase {
    None -> []
    Some(k) ->
      when(
        k.row.org_id != p.row.org_id || k.row.player_id != p.row.player_id,
        "CASE_REFERENCE_MISMATCH",
      )
  }
  let offer_revision = case offer {
    None -> []
    Some(o) ->
      case o.revisions {
        [] -> []
        revs -> {
          let bound =
            list.find(revs, fn(r) {
              id.offer_revision_to_string(r.row.id) == p.row.offer_revision_id
            })
          let stale = case bound {
            Error(Nil) -> True
            Ok(b) -> {
              let answer =
                list.find(o.responses, fn(x) { x.revision_id == b.row.id })
              b.row.superseded_by_revision_id != None
              || b.row.withdrawn_at != None
              || case answer {
                Ok(a) -> a.response_type != response_row.Accepted
                Error(Nil) -> False
              }
              || {
                b.row.status != offer_status.Accepted
                && b.row.status != offer_status.Issued
              }
            }
          }
          when(stale, "OFFER_REVISION_MISMATCH")
        }
      }
  }
  let case_states = case kase {
    None -> []
    Some(k) ->
      list.flatten([
        when(
          st == Completed && k.status != room_status.Signed,
          "COMPLETED_BUT_CASE_NOT_SIGNED",
        ),
        when(
          live(st) && k.status != room_status.OfferAccepted,
          "LIVE_SIGNING_CASE_NOT_AT_OFFER_ACCEPTED",
        ),
      ])
  }
  list.flatten([
    row_problems,
    player_problem,
    offer_reference,
    case_reference,
    offer_revision,
    case_states,
  ])
}

pub const corruption = [
  "OFFER_REFERENCE_MISMATCH", "CASE_REFERENCE_MISMATCH",
  "OFFER_REVISION_MISMATCH", "COMPLETED_BUT_CASE_NOT_SIGNED",
  "COMPLETED_WITHOUT_ROW", "DUPLICATE_SIGNING_ROWS", "ROW_WITHOUT_COMPLETION",
  "COMPLETION_ROW_MISMATCH",
]

pub fn corrupt(problems: List(String)) -> Bool {
  list.any(problems, list.contains(corruption, _))
}

// ------------------------------------------------------------------------------------------------------ views

fn opt_text(s: Option(String)) -> Json {
  json.nullable(s, json.string)
}

fn opt_int(n: Option(Int)) -> Json {
  json.nullable(n, json.int)
}

fn actor_view(
  kind: Option(RecruitmentActorKind),
  who: Option(String),
  name: Option(String),
) -> Json {
  case kind, who, name {
    None, None, None -> json.null()
    kind, _, name ->
      json.object([
        #(
          "kind",
          recruitment_actor_kind.to_json(option.unwrap(
            kind,
            recruitment_actor_kind.Org,
          )),
        ),
        #("name", opt_text(name)),
      ])
  }
}

fn user_actor_view(
  kind: Option(RecruitmentActorKind),
  who: Option(id.OrgUserId),
  name: Option(String),
) -> Json {
  actor_view(kind, option.map(who, id.org_user_to_string), name)
}

fn party_view(q: party_row.Row, for_club: Bool) -> Json {
  json.object([
    #("partyType", signing_party_type.to_json(q.party_type)),
    #("status", party_row.status_to_json(q.status)),
    #("completedAt", opt_int(q.completed_at)),
    #("method", json.nullable(q.method, signing_method.to_json)),
    #("completedBy", case completed_by(q), for_club {
      None, _ -> json.null()
      Some(b), True ->
        json.object([
          #("kind", json.nullable(b.kind, recruitment_actor_kind.to_json)),
          #("name", opt_text(b.name)),
        ])
      Some(b), False ->
        json.object([
          #("kind", json.nullable(b.kind, recruitment_actor_kind.to_json)),
          #("name", json.null()),
        ])
    }),
  ])
}

fn document_view(d: Option(doc_row.Row)) -> Json {
  case d {
    None -> json.null()
    Some(d) ->
      json.object([
        #("id", id.signing_document_json(d.id)),
        #("label", opt_text(d.label)),
        #("filename", opt_text(d.filename)),
        #("mime", opt_text(d.mime)),
        #("bytes", opt_int(d.bytes)),
        #("sha256", json.string(d.sha256)),
      ])
  }
}

fn contract_view(start: Option(String), end: Option(String)) -> Json {
  case start, end {
    None, None -> json.null()
    s, e ->
      json.object([#("startDate", opt_text(s)), #("endDate", opt_text(e))])
  }
}

fn revision_view(r: Revision, for_club: Bool) -> Json {
  let st = revision_status(r.row.status)
  json.object(
    list.flatten([
      [
        #("id", id.signing_revision_json(r.row.id)),
        #("revisionNumber", json.int(r.row.revision_number)),
        #("status", json.string(status_name(st))),
        #("statusLabel", json.string(status_label(st))),
        #("createdAt", json.int(r.row.created_at)),
        #("readyAt", opt_int(r.row.ready_at)),
        #("completedAt", opt_int(r.row.completed_at)),
        #("document", document_view(r.document)),
        #("executedDocument", document_view(r.executed)),
        #(
          "contract",
          contract_view(r.row.contract_start_date, r.row.contract_end_date),
        ),
        #("requiredParties", json.array(r.parties, party_view(_, for_club))),
        #(
          "supersedesRevisionId",
          json.nullable(r.row.supersedes_revision_id, id.signing_revision_json),
        ),
        #(
          "supersededByRevisionId",
          json.nullable(
            r.row.superseded_by_revision_id,
            id.signing_revision_json,
          ),
        ),
      ],
      case for_club {
        True -> [
          #(
            "createdBy",
            user_actor_view(
              r.row.created_by_kind,
              r.row.created_by_user_id,
              r.row.created_by_name,
            ),
          ),
          #(
            "readyBy",
            user_actor_view(
              r.row.ready_by_kind,
              r.row.ready_by_user_id,
              r.row.ready_by_name,
            ),
          ),
        ]
        False -> []
      },
    ]),
  )
}

/// The recipient's next act: completing their signature on the presented revision.
pub fn next_action(
  p: Package,
  now: Int,
  party_type: SigningPartyType,
  for_entity: String,
) -> Json {
  let st = effective_status(p, now)
  case st == Ready || st == InProgress, current_revision(p) {
    True, Some(rev) ->
      case find_party(rev, party_type, Some(for_entity)) {
        Some(q) if q.status == party_row.Pending ->
          json.object([
            #("action", json.string("COMPLETE_SIGNATURE")),
            #("revisionId", id.signing_revision_json(rev.row.id)),
            #(
              "documentSha256",
              json.nullable(
                option.map(rev.document, fn(d) { d.sha256 }),
                json.string,
              ),
            ),
          ])
        _ -> json.null()
      }
    _, _ -> json.null()
  }
}

fn has_next_action(p: Package, now: Int) -> Bool {
  let st = effective_status(p, now)
  case st == Ready || st == InProgress, current_revision(p) {
    True, Some(rev) ->
      case
        find_party(
          rev,
          signing_party_type.Player,
          Some(id.player_to_string(p.row.player_id)),
        )
      {
        Some(q) -> q.status == party_row.Pending
        None -> False
      }
    _, _ -> False
  }
}

fn completion_contract(r: pkg_row.Row) -> Json {
  contract_view(
    r.completion_contract_start_date,
    r.completion_contract_end_date,
  )
}

const club_honest =
  "ScoutBox records the signing workflow and the evidence each party gives against the exact document. It does not execute the agreement and claims no legal effect beyond what it records."

/// The club's view (signingClubView), the internal note included.
pub fn club_view(
  p: Package,
  now: Int,
  org_name: Option(String),
) -> List(#(String, Json)) {
  let r = p.row
  let st = effective_status(p, now)
  [
    #("id", id.signing_package_json(r.id)),
    #("orgId", id.org_json(r.org_id)),
    #("orgName", opt_text(org_name)),
    #("caseId", id.recruitment_case_json(r.case_id)),
    #("playerId", id.player_json(r.player_id)),
    #("offerId", id.offer_json(r.offer_id)),
    #("offerRevisionId", json.string(r.offer_revision_id)),
    #("transactionId", json.nullable(r.transaction_id, id.transaction_json)),
    #("status", json.string(status_name(st))),
    #("storedStatus", pkg_row.status_to_json(r.status)),
    #("statusLabel", json.string(status_label(st))),
    #("terminal", json.bool(is_terminal(st))),
    #("currentRevisionId", id.signing_revision_json(r.current_revision_id)),
    #("currentRevision", case current_revision(p) {
      Some(rev) -> revision_view(rev, True)
      None -> json.null()
    }),
    #("revisions", json.array(p.revisions, revision_view(_, True))),
    #("expiresAt", opt_int(r.expires_at)),
    #("internalNote", opt_text(r.internal_note)),
    #("completion", case r.completion_signing_id {
      None -> json.null()
      Some(sid) ->
        json.object([
          #("signingId", id.signing_json(sid)),
          #("completedAt", opt_int(r.completion_completed_at)),
          #("contract", completion_contract(r)),
          #(
            "lifecycle",
            case
              r.completion_lifecycle_from,
              r.completion_lifecycle_to,
              r.completion_lifecycle_at
            {
              None, None, None -> json.null()
              from, to, at ->
                json.object([
                  #("from", opt_text(from)),
                  #("to", opt_text(to)),
                  #("at", opt_int(at)),
                ])
            },
          ),
        ])
    }),
    #("cancelledAt", opt_int(r.cancelled_at)),
    #("cancelReason", opt_text(r.cancel_reason)),
    #("voidedAt", opt_int(r.voided_at)),
    #("voidReason", opt_text(r.void_reason)),
    #("createdAt", json.int(r.created_at)),
    #(
      "createdBy",
      user_actor_view(
        r.created_by_kind,
        Some(r.created_by_user_id),
        r.created_by_name,
      ),
    ),
    #("updatedAt", json.int(r.updated_at)),
    #("rev", json.int(r.rev)),
    #("policyVersion", json.int(r.policy_version)),
    #("honest", json.string(club_honest)),
  ]
}

const recipient_honest =
  "Completing your signature here records that you, as the authenticated account holder, confirm the exact document shown. ScoutBox records the workflow and the evidence; it does not execute the agreement for you."

/// From READY only: the exact presented revision, never a draft or the note.
pub fn recipient_view(
  p: Package,
  now: Int,
  org_name: Option(String),
  party_type: SigningPartyType,
  for_entity: String,
) -> List(#(String, Json)) {
  let r = p.row
  let st = effective_status(p, now)
  let presented = list.filter(p.revisions, fn(x) { x.row.ready_at != None })
  let current = case current_revision(p) {
    Some(rev) if rev.row.ready_at != None -> Some(rev)
    _ -> None
  }
  [
    #("id", id.signing_package_json(r.id)),
    #("playerId", id.player_json(r.player_id)),
    #(
      "club",
      json.object([
        #("id", id.org_json(r.org_id)),
        #("name", opt_text(org_name)),
      ]),
    ),
    #("offerId", id.offer_json(r.offer_id)),
    #("offerRevisionId", json.string(r.offer_revision_id)),
    #("status", json.string(status_name(st))),
    #("statusLabel", json.string(status_label(st))),
    #("terminal", json.bool(is_terminal(st))),
    #(
      "currentRevisionId",
      json.nullable(
        option.map(current, fn(x) { x.row.id }),
        id.signing_revision_json,
      ),
    ),
    #("currentRevision", case current {
      Some(rev) -> revision_view(rev, False)
      None -> json.null()
    }),
    #("revisions", json.array(presented, revision_view(_, False))),
    #("expiresAt", opt_int(r.expires_at)),
    #("nextAction", next_action(p, now, party_type, for_entity)),
    #("completion", case r.completion_signing_id {
      None -> json.null()
      Some(_) ->
        json.object([
          #("completedAt", opt_int(r.completion_completed_at)),
          #("contract", completion_contract(r)),
        ])
    }),
    #("policyVersion", json.int(r.policy_version)),
    #("honest", json.string(recipient_honest)),
  ]
}

pub const agent_honest =
  "Read-only. Your client signs as themselves; ScoutBox does not let you sign, acknowledge or complete for a client."

/// State and progress only: no document bytes, no note, no signatory identity beyond the kind.
pub fn agent_view(
  p: Package,
  now: Int,
  org_name: Option(String),
) -> List(#(String, Json)) {
  let r = p.row
  let st = effective_status(p, now)
  let rev = current_revision(p)
  [
    #("id", id.signing_package_json(r.id)),
    #("clientId", id.player_json(r.player_id)),
    #(
      "club",
      json.object([
        #("id", id.org_json(r.org_id)),
        #("name", opt_text(org_name)),
      ]),
    ),
    #("offerId", id.offer_json(r.offer_id)),
    #("status", json.string(status_name(st))),
    #("statusLabel", json.string(status_label(st))),
    #("terminal", json.bool(is_terminal(st))),
    #(
      "currentRevisionNumber",
      json.nullable(option.map(rev, fn(x) { x.row.revision_number }), json.int),
    ),
    #(
      "presented",
      json.bool(case rev {
        Some(x) -> x.row.ready_at != None
        None -> False
      }),
    ),
    #("expiresAt", opt_int(r.expires_at)),
    #("requiredParties", case rev {
      Some(x) ->
        json.array(x.parties, fn(q) {
          json.object([
            #("partyType", signing_party_type.to_json(q.party_type)),
            #("status", party_row.status_to_json(q.status)),
            #("completedAt", opt_int(q.completed_at)),
          ])
        })
      None -> json.preprocessed_array([])
    }),
    #("clientActionRequired", json.bool(has_next_action(p, now))),
    #("contract", case rev {
      Some(x) ->
        contract_view(x.row.contract_start_date, x.row.contract_end_date)
      None -> json.null()
    }),
    #("completedAt", opt_int(r.completion_completed_at)),
    #("honest", json.string(agent_honest)),
  ]
}

fn detail_revision_id(detail: Option(String)) -> Json {
  case detail {
    None -> json.null()
    Some(text) ->
      json.parse(
        text,
        decode.at(["revisionId"], decode.optional(decode.string)),
      )
      |> result.unwrap(None)
      |> opt_text
  }
}

/// The package's history (signingHistoryView); a recipient sees no draft, note or internal entry and no club
/// member's name.
pub fn history_view(p: Package, for_recipient: Bool) -> Json {
  p.history
  |> list.filter(fn(h) {
    !for_recipient
    || !{
      string.contains(h.action, "draft")
      || string.contains(h.action, "note")
      || string.contains(h.action, "internal")
    }
  })
  |> json.array(fn(h) {
    json.object([
      #("id", id.signing_event_json(h.id)),
      #("at", json.int(h.at)),
      #("action", json.string(h.action)),
      #("by", case for_recipient {
        False -> actor_view(h.by_kind, h.by_id, h.by_name)
        True ->
          case h.by_kind, h.by_id, h.by_name {
            None, None, None ->
              json.object([#("kind", json.null()), #("name", json.null())])
            kind, _, name ->
              json.object([
                #(
                  "kind",
                  recruitment_actor_kind.to_json(option.unwrap(
                    kind,
                    recruitment_actor_kind.Org,
                  )),
                ),
                #("name", case option.unwrap(kind, recruitment_actor_kind.Org) {
                  recruitment_actor_kind.Org -> json.null()
                  _ -> opt_text(name)
                }),
              ])
          }
      }),
      #("revisionId", detail_revision_id(h.detail_json)),
    ])
  })
}

/// The vocabulary a club's signing surface names.
pub fn vocabulary_json() -> Json {
  json.object([
    #("statuses", json.array(statuses, fn(s) { json.string(status_name(s)) })),
    #(
      "statusLabels",
      json.object(
        list.map(statuses, fn(s) {
          #(status_name(s), json.string(status_label(s)))
        }),
      ),
    ),
    #(
      "partyTypes",
      json.array(
        [
          signing_party_type.Player, signing_party_type.Guardian,
          signing_party_type.ClubSignatory,
        ],
        signing_party_type.to_json,
      ),
    ),
    #(
      "methods",
      json.array(
        [
          signing_method.PlatformAcknowledgment,
          signing_method.UploadExecutedDocument,
        ],
        signing_method.to_json,
      ),
    ),
    #(
      "minorPathway",
      json.object(
        list.map(minor_pathway_jurisdictions, fn(j) { #(j, json.bool(False)) }),
      ),
    ),
  ])
}
