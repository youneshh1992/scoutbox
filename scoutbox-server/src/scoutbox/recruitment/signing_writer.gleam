//// `recordCompletedSigning` (domains/recruitment/signings/shared.mjs): the only place a recruitment signing records a
//// completed signing and sets a player's contract status, level, timeline, squad row and availability. Called by a
//// package's completion and, for a recruitment with no Offer, the legacy route. Every write and notice runs inside
//// the caller's unit.
////
//// Not ported yet: the live 'players' event.

import gleam/int
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import gleam/time/calendar
import gleam/time/timestamp
import scoutbox/development/activity
import scoutbox/identity/players.{type Player}
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/ids
import scoutbox/platform/operator
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/recruitment/invoices
import scoutbox/recruitment/signing_rules.{type Package, type Revision}
import scoutbox/rows/id
import scoutbox/rows/ledger as ledger_row
import scoutbox/rows/org_squad_members as squad_row
import scoutbox/rows/orgs
import scoutbox/rows/players as player_row
import scoutbox/rows/signing_parties as signing_party_row
import scoutbox/rows/signings as signing_row
import scoutbox/safety/ledger
import scoutbox/scouting/squad
import scoutbox/vocab/audience
import scoutbox/vocab/availability
import scoutbox/vocab/playing_level
import scoutbox/vocab/position
import sqlight

/// What the signing completes: a package's revision, or a legacy recording with its note.
pub type Completion {
  FromPackage(package: Package, revision: Revision)
  Legacy(note: Option(String))
}

/// The squad row's name limit (clubSetup.ts CLUB_SETUP_LIMITS.name).
pub type Written {
  Written(signing: signing_row.Row, duplicate: Bool)
}

fn one_signing(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(Option(signing_row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT " <> signing_row.columns <> " FROM signings WHERE " <> where,
    args,
    signing_row.decoder(),
  )
  |> result.map(fn(rows) { list.first(rows) |> option.from_result })
}

/// The row a package's completion wrote (one per package), or none.
pub fn for_package(
  read: Read,
  package_id: id.SigningPackageId,
) -> Result(Option(signing_row.Row), Fail(e)) {
  one_signing(read, "signing_package_id = ?", [
    id.signing_package_sql(package_id),
  ])
}

/// The row recorded for an Offer (one per Offer), or none.
pub fn for_offer(
  read: Read,
  offer_id: id.OfferId,
) -> Result(Option(signing_row.Row), Fail(e)) {
  one_signing(read, "offer_id = ?", [id.offer_sql(offer_id)])
}

/// The rows recorded for a club and player, in insertion order.
pub fn for_org_player(
  read: Read,
  org_id: id.OrgId,
  player_id: id.PlayerId,
) -> Result(List(signing_row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> signing_row.columns
      <> " FROM signings WHERE org_id = ? AND player_id = ? ORDER BY rowid",
    [id.org_sql(org_id), id.player_sql(player_id)],
    signing_row.decoder(),
  )
}

/// The rows recorded for a player, in insertion order.
pub fn for_player(
  read: Read,
  player_id: id.PlayerId,
) -> Result(List(signing_row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> signing_row.columns
      <> " FROM signings WHERE player_id = ? ORDER BY rowid",
    [id.player_sql(player_id)],
    signing_row.decoder(),
  )
}

fn first_event(
  read: Read,
  player_id: id.PlayerId,
  org_id: id.OrgId,
) -> Result(Option(ledger_row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> ledger_row.columns
      <> " FROM ledger WHERE player_id = ? AND org_id = ? ORDER BY seq LIMIT 1",
    [id.player_sql(player_id), id.org_sql(org_id)],
    ledger_row.decoder(),
  )
  |> result.map(fn(rows) { list.first(rows) |> option.from_result })
}

/// The UTC calendar year of an instant, as text.
fn year_of(ms: Int) -> String {
  let #(date, _) =
    timestamp.from_unix_seconds_and_nanoseconds(ms / 1000, 0)
    |> timestamp.to_calendar(calendar.utc_offset)
  int.to_string(date.year)
}

fn notify_player(
  tx: Tx,
  player: id.PlayerId,
  type_: String,
  text: String,
  ref_id: String,
  at: Int,
) -> Result(Nil, Fail(e)) {
  notifications.notify(
    tx,
    to: audience.Player,
    id: id.player_to_string(player),
    type_:,
    text:,
    ref_id: Some(ref_id),
    at:,
  )
}

fn notify_guardian(
  tx: Tx,
  guardian: Option(id.GuardianId),
  type_: String,
  text: String,
  ref_id: String,
  at: Int,
) -> Result(Nil, Fail(e)) {
  case guardian {
    None -> Ok(Nil)
    Some(g) ->
      notifications.notify(
        tx,
        to: audience.Guardian,
        id: id.guardian_to_string(g),
        type_:,
        text:,
        ref_id: Some(ref_id),
        at:,
      )
  }
}

/// Idempotent per package and per Offer: a row already there is returned as a duplicate and nothing is written.
pub fn record_completed(
  tx: Tx,
  player: Player,
  org: orgs.Row,
  actor: Option(#(id.OrgUserId, String)),
  at: Int,
  completion: Completion,
) -> Result(Written, Fail(e)) {
  let read = store.reading(tx)
  use existing <- result.try(case completion {
    FromPackage(package: p, ..) -> {
      use by_package <- result.try(for_package(read, p.row.id))
      case by_package {
        Some(s) -> Ok(Some(s))
        None -> for_offer(read, p.row.offer_id)
      }
    }
    Legacy(_) -> Ok(None)
  })
  case existing {
    Some(s) -> Ok(Written(s, True))
    None -> write(tx, player, org, actor, at, completion)
  }
}

fn write(
  tx: Tx,
  player: Player,
  org: orgs.Row,
  actor: Option(#(id.OrgUserId, String)),
  at: Int,
  completion: Completion,
) -> Result(Written, Fail(e)) {
  let read = store.reading(tx)
  let p = player.row
  use first <- result.try(first_event(read, p.id, org.id))
  let assert Ok(plan) =
    list.find(operator.plans, fn(x) { x.name == orgs.plan_to_string(org.plan) })
    as "orgs.plan has a CHECK against the catalogue"
  let window_months = plan.attribution_window_months
  let appended_at = clock.now_ms()
  use _ <- result.try(ledger.append(
    tx,
    ledger.Entry(
      entry_type: ledger_row.Signing,
      player_id: Some(p.id),
      org_id: Some(org.id),
      org_name: Some(org.name),
      user_id: option.map(actor, fn(a) { a.0 }),
      actor_name: option.map(actor, fn(a) { a.1 }),
    ),
    appended_at,
  ))
  let ts = case completion {
    FromPackage(..) -> at
    Legacy(_) -> appended_at
  }
  let inside = case first {
    Some(f) ->
      int.to_float(ts)
      <=. int.to_float(f.occurred_at)
      +. int.to_float(window_months)
      *. 30.44
      *. 24.0
      *. 3600.0
      *. 1000.0
    None -> False
  }
  use signing_id <- result.try(sign_id(tx))
  let base =
    signing_row.Row(
      ..signing_row.new(id: signing_id, player_id: p.id, org_id: org.id, ts:),
      player_name: Some(p.name),
      org_name: Some(org.name),
      user_id: option.map(actor, fn(a) { a.0 }),
      scout_name: option.map(actor, fn(a) { a.1 }),
      signed_at: Some(ts),
      first_qualifying_ledger_id: option.map(first, fn(f) { f.id }),
      first_qualifying_at: option.map(first, fn(f) { f.occurred_at }),
      first_qualifying_type: option.map(first, fn(f) {
        ledger_row.type_to_string(f.type_)
      }),
      attribution_window_months: Some(window_months),
      inside_attribution_window: inside,
      policy_version: Some(signing_rules.policy_version),
    )
  let #(signing, parties) = case completion {
    FromPackage(package: pkg, revision: rev) -> #(
      signing_row.Row(
        ..base,
        method: signing_row.CanonicalCompletion,
        signing_package_id: Some(pkg.row.id),
        signing_revision_id: Some(rev.row.id),
        signing_revision_number: Some(rev.row.revision_number),
        case_id: Some(pkg.row.case_id),
        offer_id: Some(pkg.row.offer_id),
        offer_revision_id: Some(pkg.row.offer_revision_id),
        transaction_id: option.map(
          pkg.row.transaction_id,
          id.transaction_to_string,
        ),
        document_sha256: option.map(rev.document, fn(d) { d.sha256 }),
        document_evidence_id: option.map(rev.document, fn(d) {
          id.evidence_to_string(d.evidence_id)
        }),
        executed_document_evidence_id: option.map(rev.executed, fn(d) {
          id.evidence_to_string(d.evidence_id)
        }),
        contract_start_date: rev.row.contract_start_date,
        contract_end_date: rev.row.contract_end_date,
      ),
      list.map(rev.parties, fn(q) {
        signing_party_row.Row(
          ..signing_party_row.new(
            signing_id:,
            position: q.position,
            party_type: q.party_type,
          ),
          method: q.method,
          completed_at: q.completed_at,
          by_kind: q.completed_by_kind,
        )
      }),
    )
    Legacy(note) -> #(
      signing_row.Row(..base, method: signing_row.LegacyRecorded, note:),
      [],
    )
  }
  use _ <- result.try(signing_row.insert(tx, signing))
  use _ <- result.try(list.try_each(parties, signing_party_row.insert(tx, _)))
  // The dev-ledger provider records the success fee locally, so it is written in the unit: a completion that rolls
  // back issues no invoice, as the TypeScript server's after-commit call guarantees.
  use _ <- result.try(case signing.inside_attribution_window {
    True -> invoices.issue_for_signing(tx, signing, org)
    False -> Ok(Nil)
  })
  // Grassroots signings make semi-pros; academy/pro signings make pros.
  let level_after = case org.level {
    Some(orgs.LevelGrassroots) -> playing_level.SemiPro
    _ -> playing_level.Pro
  }
  let year = year_of(ts)
  let level_lines = case p.level, level_after {
    playing_level.Amateur, playing_level.SemiPro -> [
      #(
        "Levelled up: amateur → semi-pro with " <> org.name,
        "⬆️ You're semi-pro. "
          <> org.name
          <> " signed you — one step up the ladder, recorded forever on your pathway.",
        p.name <> " levelled up: amateur → semi-pro with " <> org.name <> ".",
      ),
    ]
    before, playing_level.Pro if before != playing_level.Pro -> [
      #(
        "Levelled up: "
          <> string.replace(playing_level.to_string(before), "_", "-")
          <> " → pro with "
          <> org.name,
        "⬆️ Academy/pro level reached with "
          <> org.name
          <> ". Your grassroots journey got you here.",
        p.name <> " reached academy/pro level with " <> org.name <> ".",
      ),
    ]
    _, _ -> []
  }
  use _ <- result.try(case org.level {
    Some(orgs.LevelGrassroots) -> join_squad(tx, org.id, player, ts)
    _ -> Ok(Nil)
  })
  let timeline =
    list.append(list.map(level_lines, fn(l) { l.0 }), [
      case completion {
        FromPackage(..) ->
          "Signed with " <> org.name <> " — signing completed in ScoutBox"
        Legacy(_) -> "Signed by " <> org.name <> " — discovered on ScoutBox"
      },
    ])
  // Written here and nowhere else for a recruitment signing.
  use _ <- result.try(players.set_level(tx, p.id, level_after))
  use _ <- result.try(players.set_availability(
    tx,
    p.id,
    Some(availability.NotSeeking),
    Some(player_row.UnderContract),
  ))
  use _ <- result.try(
    list.try_each(timeline, players.add_timeline_entry(tx, p.id, year, _)),
  )
  use _ <- result.try(activity.refresh_badges(tx, p.id, at))
  let pid = id.player_to_string(p.id)
  use _ <- result.try(
    list.try_each(level_lines, fn(l) {
      use _ <- result.try(notify_player(tx, p.id, "level_up", l.1, pid, at))
      notify_guardian(tx, p.guardian_id, "level_up", l.2, pid, at)
    }),
  )
  let sid = id.signing_to_string(signing_id)
  use _ <- result.try(notify_player(
    tx,
    p.id,
    "signing",
    case completion {
      FromPackage(..) ->
        "🎉 "
        <> org.name
        <> ": your signing is completed. It's on your timeline."
      Legacy(_) ->
        "🎉 "
        <> org.name
        <> " recorded your signing. Congratulations — it's on your timeline."
    },
    sid,
    at,
  ))
  use _ <- result.try(notify_guardian(
    tx,
    p.guardian_id,
    "signing",
    org.name
      <> " "
      <> case completion {
      FromPackage(..) -> "completed"
      Legacy(_) -> "recorded"
    }
      <> " "
      <> p.name
      <> "'s signing.",
    sid,
    at,
  ))
  Ok(Written(signing, False))
}

fn sign_id(tx: Tx) -> Result(id.SigningId, Fail(e)) {
  ids.next(tx, "sign") |> result.map(id.signing)
}

/// A grassroots signing adds the squad row (joinSquad), once.
fn join_squad(
  tx: Tx,
  org_id: id.OrgId,
  player: Player,
  at: Int,
) -> Result(Nil, Fail(e)) {
  squad.join(
    tx,
    org_id,
    player.row.id,
    player.row.name,
    option.map(player.row.position, position.to_string),
    squad_row.Signing,
    None,
    at,
  )
}
