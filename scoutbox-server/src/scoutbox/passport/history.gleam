//// A player's club history as the Passport assembles it (clubHistory in domains/passport/shared.mjs, over
//// historyInputs in passport.mjs): signings, squad rows and accepted squad invitations, then the player's own
//// career entries, each folded into an authoritative row for the same club when there is one.
////
//// The Trust Score reads these rows (their keys, provenance and whether they are current). Not ported yet: the
//// rest of the Passport, which shows them, and verified affiliation claims, which the TypeScript history is also
//// built from but which historyFor passes as none.

import gleam/dynamic/decode
import gleam/int
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/result
import gleam/string
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/platform/temporal
import scoutbox/rows/id
import scoutbox/rows/org_squad_members as squad_row
import scoutbox/rows/orgs
import scoutbox/rows/outcome_reports as outcome_row
import scoutbox/rows/passport_career_entries as career_row
import scoutbox/rows/signings as signing_row
import scoutbox/rows/ver_player_invites as invite_row
import scoutbox/vocab/party

pub type Row {
  Row(
    key: String,
    org_id: Option(id.OrgId),
    org_name: Option(String),
    from: Option(Int),
    current: Bool,
    provenance: String,
    source_type: String,
    source_id: String,
  )
}

fn all(
  read: Read,
  columns: String,
  table: String,
  where: String,
  player_id: id.PlayerId,
  decoder: decode.Decoder(a),
) -> Result(List(a), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> columns
      <> " FROM "
      <> table
      <> " WHERE "
      <> where
      <> " ORDER BY rowid",
    [id.player_sql(player_id)],
    decoder,
  )
}

fn org_of(read: Read, org_id: id.OrgId) -> Result(Option(orgs.Row), Fail(e)) {
  store.one(
    read,
    "SELECT " <> orgs.columns <> " FROM orgs WHERE id = ?",
    [id.org_sql(org_id)],
    orgs.decoder(),
  )
  |> result.map(option.from_result)
}

/// An instant a history row starts at, as normWhen reads it (only its sort position matters here).
fn when_text(s: String) -> Option(Int) {
  let start = fn(day) { temporal.day_start_ms(day) |> option.from_result }
  case string.length(s) {
    4 -> start(s <> "-01-01")
    7 -> start(s <> "-01")
    _ -> start(string.slice(s, 0, 10))
  }
}

pub fn for_player(
  read: Read,
  player_id: id.PlayerId,
) -> Result(List(Row), Fail(e)) {
  use signings <- result.try(all(
    read,
    signing_row.columns,
    "signings",
    "player_id = ?",
    player_id,
    signing_row.decoder(),
  ))
  use outcomes <- result.try(all(
    read,
    outcome_row.columns,
    "outcome_reports",
    "player_id = ?",
    player_id,
    outcome_row.decoder(),
  ))
  use squad <- result.try(all(
    read,
    squad_row.columns,
    "org_squad_members",
    "player_id = ?",
    player_id,
    squad_row.decoder(),
  ))
  use invites <- result.try(all(
    read,
    invite_row.columns,
    "ver_player_invites",
    "player_id = ? AND status = 'accepted'",
    player_id,
    invite_row.decoder(),
  ))
  use careers <- result.try(all(
    read,
    career_row.columns,
    "passport_career_entries",
    "player_id = ?",
    player_id,
    career_row.decoder(),
  ))
  // A suspended organisation lends no current relationship.
  use squads <- result.try(
    list.try_fold(squad, [], fn(acc, s) {
      use o <- result.map(org_of(read, s.org_id))
      case o {
        Some(o) if !o.suspended -> [
          #(o, id.squad_entry_to_string(s.id), s.added_at),
          ..acc
        ]
        _ -> acc
      }
    })
    |> result.map(list.reverse),
  )
  use squads <- result.try(
    list.try_fold(invites, squads, fn(acc, inv) {
      case list.any(acc, fn(s) { { s.0 }.id == inv.org_id }) {
        True -> Ok(acc)
        False -> {
          use o <- result.map(org_of(read, inv.org_id))
          case o {
            Some(o) if !o.suspended ->
              list.append(acc, [
                #(
                  o,
                  id.player_invite_to_string(inv.id),
                  option.unwrap(inv.accepted_at, 0),
                ),
              ])
            _ -> acc
          }
        }
      }
    }),
  )
  use signing_rows <- result.try(
    list.try_map(signings, fn(s) {
      use o <- result.map(org_of(read, s.org_id))
      let ended =
        list.find(outcomes, fn(r) {
          r.signing_id == s.id
          && list.contains(
            ["released", "ended", "left"],
            outcome_row.registration_status_to_string(r.registration_status),
          )
        })
      let suspended = case o {
        Some(o) -> o.suspended
        None -> False
      }
      Row(
        key: "signing:" <> id.signing_to_string(s.id),
        org_id: Some(s.org_id),
        org_name: s.org_name,
        from: Some(s.ts),
        current: result.is_error(ended) && !suspended,
        provenance: "verified_club_confirmed",
        source_type: "signing",
        source_id: id.signing_to_string(s.id),
      )
    }),
  )
  let rows =
    list.fold(squads, signing_rows, fn(rows, s) {
      let #(o, row_id, added_at) = s
      // A claim or a signing already covers it.
      case list.any(rows, fn(r) { r.org_id == Some(o.id) && r.current }) {
        True -> rows
        False ->
          list.append(rows, [
            Row(
              key: "squad:" <> id.org_to_string(o.id),
              org_id: Some(o.id),
              org_name: Some(o.name),
              from: Some(added_at),
              current: True,
              provenance: case o.verified {
                True -> "verified_club_confirmed"
                False -> "system_recorded"
              },
              source_type: "squad_row",
              source_id: id.org_to_string(o.id) <> ":" <> row_id,
            ),
          ])
      }
    })
  let norm = fn(s: Option(String)) {
    option.unwrap(s, "") |> string.trim |> string.lowercase
  }
  let rows =
    list.fold(careers, rows, fn(rows, c) {
      let folded =
        list.any(rows, fn(r) { norm(r.org_name) == norm(Some(c.org_name)) })
      case c.withdrawn_at, folded {
        Some(_), _ | None, True -> rows
        None, False ->
          list.append(rows, [
            Row(
              key: "career:" <> id.career_entry_to_string(c.id),
              org_id: None,
              org_name: Some(c.org_name),
              from: when_text(c.from_date),
              current: c.to_date == None,
              provenance: case c.submitted_by {
                party.Guardian -> "guardian_submitted"
                party.Player -> "player_submitted"
              },
              source_type: "career_entry",
              source_id: id.career_entry_to_string(c.id),
            ),
          ])
      }
    })
  Ok(
    list.sort(rows, fn(a, b) {
      case int.compare(option.unwrap(b.from, 0), option.unwrap(a.from, 0)) {
        order.Eq ->
          case string.compare(a.key, b.key) {
            order.Lt -> order.Lt
            _ -> order.Gt
          }
        other -> other
      }
    }),
  )
}
