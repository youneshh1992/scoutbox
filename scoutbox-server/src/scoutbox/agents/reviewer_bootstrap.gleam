//// The Trust & Safety admin a deployment starts with (TS_REVIEWER_BOOTSTRAP_*, `config.ReviewerBootstrap`), created
//// at boot if no reviewer has its id, in any mode, before the dev reviewers are seeded. Only a reviewer can create
//// another, so this is how a production database not seeded with the demo world gets its first. A reviewer that
//// exists is never changed from the settings: its secret and name are managed through the console from then on.

import gleam/dynamic/decode
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/identity/passwords
import scoutbox/platform/config.{type ReviewerBootstrap}
import scoutbox/platform/store.{type Fail, type Store}
import scoutbox/rows/id.{type ReviewerId}
import scoutbox/rows/ts_reviewer_history as reviewer_event_row
import scoutbox/rows/ts_reviewers as reviewer_row
import scoutbox/vocab/reviewer_role.{type ReviewerRole}

/// Create the bootstrap reviewer unless its id is taken. Returns whether it created one; an error is for the boot log.
pub fn ensure(
  store: Store,
  now: Int,
  bootstrap: Option(ReviewerBootstrap),
) -> Result(Bool, String) {
  case bootstrap {
    None -> Ok(False)
    Some(b) -> {
      let reviewer_id = id.reviewer(b.id)
      use taken <- result.try(
        store.read(store, exists(_, reviewer_id))
        |> result.map_error(string.inspect),
      )
      case taken {
        True -> Ok(False)
        False -> {
          // scrypt takes about half a second here: hashed before the unit, so the writer isn't held for it.
          let secret_hash = passwords.hash(b.secret)
          store.unit(store, fn(tx) {
            use taken <- result.try(exists(store.reading(tx), reviewer_id))
            case taken {
              True -> Ok(False)
              False -> {
                use _ <- result.map(insert_system(
                  tx,
                  reviewer_id,
                  b.name,
                  reviewer_role.TrustSafetyAdmin,
                  secret_hash,
                  "bootstrap env",
                  now,
                ))
                True
              }
            }
          })
          |> result.map_error(string.inspect)
        }
      }
    }
  }
}

fn exists(read: store.Read, reviewer_id: ReviewerId) -> Result(Bool, Fail(e)) {
  store.one(
    read,
    "SELECT COUNT(*) FROM ts_reviewers WHERE id = ?",
    [id.reviewer_sql(reviewer_id)],
    decode.at([0], decode.int),
  )
  |> result.map(fn(count) { count == Ok(1) })
}

/// A reviewer the system creates (the bootstrap, the dev seed), with its `reviewer_created` history entry, both
/// attributed to the system under `by_name`.
pub fn insert_system(
  tx: store.Tx,
  reviewer_id: ReviewerId,
  name: String,
  role: ReviewerRole,
  secret_hash: String,
  by_name: String,
  now: Int,
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(reviewer_row.insert(
    tx,
    reviewer_row.Row(
      id: reviewer_id,
      name:,
      role:,
      status: reviewer_row.Active,
      secret_hash:,
      created_at: now,
      created_by_kind: reviewer_row.System,
      created_by_id: None,
      created_by_name: Some(by_name),
      created_by_role: None,
      revoked_at: None,
      revoked_by_id: None,
      revoked_by_name: None,
      rev: 1,
      rev_at: Some(now),
      rev_by_name: None,
      rev_by_id: None,
    ),
  ))
  use event_id <- result.try(id.next_reviewer_event(tx))
  reviewer_event_row.insert(
    tx,
    reviewer_event_row.Row(
      id: event_id,
      reviewer_id:,
      ord: 0,
      at: now,
      by_kind: reviewer_event_row.System,
      by_id: None,
      by_name: Some(by_name),
      by_role: None,
      action: reviewer_event_row.ReviewerCreated,
      detail_role: Some(role),
      detail_reason: None,
    ),
  )
}
