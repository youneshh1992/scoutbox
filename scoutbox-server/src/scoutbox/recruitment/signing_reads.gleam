//// What another domain reads of a signing package: whether a package is sound (its Offer, case and completed
//// record agree with it), and an Offer's signing summary (summaryForOffer).

import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/result
import gleam/string
import scoutbox/identity/players.{type Player}
import scoutbox/platform/clock
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/recruitment/cases.{type Room}
import scoutbox/recruitment/offer_rules.{type Offer}
import scoutbox/recruitment/offers
import scoutbox/recruitment/signing_packages
import scoutbox/recruitment/signing_rules.{type Package}
import scoutbox/recruitment/signing_writer
import scoutbox/rows/id
import scoutbox/rows/signing_packages as pkg_row
import scoutbox/rows/signings as signing_row

/// What the reads around a package found: its case and Offer (when they are its club's), its completed row and
/// its player.
pub type Around {
  Around(
    room: Option(Room),
    offer: Option(Offer),
    rows: List(signing_row.Row),
    player: Option(Player),
  )
}

pub fn around(read: Read, p: Package) -> Result(Around, Fail(e)) {
  use room <- result.try(cases.room(read, p.row.case_id))
  use offer <- result.try(offers.by_id(read, p.row.offer_id))
  use row <- result.try(signing_writer.for_package(read, p.row.id))
  use player <- result.map(players.by_id(read, p.row.player_id))
  Around(
    room: case room {
      Some(r) if r.row.org_id == p.row.org_id -> Some(r)
      _ -> None
    },
    offer: case offer {
      Some(o) if o.row.org_id == p.row.org_id -> Some(o)
      _ -> None
    },
    rows: option.values([row]),
    player:,
  )
}

pub fn consistency(p: Package, a: Around, now: Int) -> List(String) {
  signing_rules.consistency(
    p,
    a.offer,
    a.room,
    a.rows,
    option.map(a.player, fn(x) { x.row }),
    now,
  )
}

/// Omitted from every projection unless its Offer, case and completed record agree with it.
pub fn sound(read: Read, p: Package, now: Int) -> Result(Bool, Fail(e)) {
  case signing_rules.integrity(p, None) {
    [_, ..] -> Ok(False)
    [] -> {
      use a <- result.map(around(read, p))
      case a.offer, a.room {
        Some(_), Some(_) -> !signing_rules.corrupt(consistency(p, a, now))
        _, _ -> False
      }
    }
  }
}

fn newest(ps: List(Package)) -> Option(Package) {
  list.sort(ps, fn(x, y) { int.compare(y.row.created_at, x.row.created_at) })
  |> list.first
  |> option.from_result
}

/// The current package (currentSigningForOffer): the newest live one, else the newest completed, else the newest.
pub fn current(ps: List(Package), now: Int) -> Option(Package) {
  newest(list.filter(ps, signing_rules.is_live(_, now)))
  |> option.lazy_or(fn() {
    newest(
      list.filter(ps, fn(p) {
        signing_rules.effective_status(p, now) == signing_rules.Completed
      }),
    )
  })
  |> option.lazy_or(fn() { newest(ps) })
}

/// An Offer's signing, ids and the status word only; null when no sound package was opened over it.
pub fn summary_for_offer(
  read: Read,
  offer_id: id.OfferId,
  org_id: id.OrgId,
  now: Int,
) -> Result(Json, Fail(e)) {
  use all <- result.try(signing_packages.for_offer(read, offer_id))
  use kept <- result.map(
    list.try_fold(all, [], fn(out, p) {
      case p.row.org_id == org_id {
        False -> Ok(out)
        True -> {
          use ok <- result.map(sound(read, p, now))
          case ok {
            True -> [p, ..out]
            False -> out
          }
        }
      }
    }),
  )
  case current(kept, now) {
    None -> json.null()
    Some(p) -> {
      let rev = signing_rules.current_revision(p)
      json.object([
        #("signingPackageId", id.signing_package_json(p.row.id)),
        #(
          "status",
          json.string(
            signing_rules.status_name(signing_rules.effective_status(p, now)),
          ),
        ),
        #(
          "revisionNumber",
          json.nullable(
            option.map(rev, fn(r) { r.row.revision_number }),
            json.int,
          ),
        ),
        #(
          "presented",
          json.bool(case rev {
            Some(r) -> r.row.ready_at != None
            None -> False
          }),
        ),
        #("completedAt", json.nullable(p.row.completion_completed_at, json.int)),
        #(
          "signingId",
          json.nullable(p.row.completion_signing_id, id.signing_json),
        ),
      ])
    }
  }
}

/// `view` with its `signing` entry set to `summary`.
pub fn with_signing(
  view: List(#(String, Json)),
  summary: Json,
) -> List(#(String, Json)) {
  list.map(view, fn(e) {
    case e.0 {
      "signing" -> #("signing", summary)
      _ -> e
    }
  })
}

/// The player's live contract (createContractLookup): a completed-signing row over a COMPLETED package that names it
/// back, whose contract end has not passed. Some(end) when one stands; this record owns `under_contract`.
///
/// `except` leaves out that club's signings: a contract another club completed still stands after it releases the
/// player.
pub fn canonical_contract(
  read: Read,
  player_id: id.PlayerId,
  now: Int,
  except: Option(id.OrgId),
) -> Result(Option(Option(String)), Fail(e)) {
  let today = clock.iso_day(now)
  use rows <- result.try(signing_writer.for_player(read, player_id))
  let rows = list.filter(rows, fn(s) { Some(s.org_id) != except })
  list.try_fold(rows, None, fn(found, s) {
    case found, s.signing_package_id {
      Some(_), _ | None, None -> Ok(found)
      None, Some(pid) -> {
        use pkg <- result.map(signing_packages.by_id(read, pid))
        let mine = Some(s.id)
        case pkg {
          Some(p)
            if p.row.status == pkg_row.Completed
            && p.row.completion_signing_id == mine
          -> {
            let end =
              option.or(s.contract_end_date, p.row.completion_contract_end_date)
            let ended = case end {
              Some(e) -> string.compare(e, today) == order.Lt
              None -> False
            }
            case ended {
              True -> None
              False -> Some(end)
            }
          }
          _ -> None
        }
      }
    }
  })
}
