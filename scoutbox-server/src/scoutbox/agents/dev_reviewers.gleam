//// The three Trust & Safety reviewers a development server signs in with, seeded at boot into an empty reviewer
//// table when dev logins are on, as the TypeScript server does (`reviewers.mjs`). A demo first boot already has
//// them from the seed; a database a fixture wrote gets them here. A table with any reviewer is left alone.
////
//// The secrets are the published dev logins, so their hashes are no secret either. They are stored precomputed
//// because scrypt here takes about half a second a hash, and every fixture boot would pay it three times.

import gleam/dynamic/decode
import gleam/list
import gleam/option.{None, Some}
import gleam/result
import scoutbox/platform/store.{type Fail, type Store, type UnitError}
import scoutbox/rows/id
import scoutbox/rows/ts_reviewer_history as reviewer_event_row
import scoutbox/rows/ts_reviewers as reviewer_row
import scoutbox/vocab/reviewer_role

/// A dev reviewer: id, name, role, secret, and the stored hash of that secret.
pub type DevReviewer {
  DevReviewer(
    id: String,
    name: String,
    role: reviewer_role.ReviewerRole,
    secret: String,
    secret_hash: String,
  )
}

/// The dev reviewers, in the order they are created.
pub const all = [
  DevReviewer(
    id: "tsr-dev-admin",
    name: "Priya Shah",
    role: reviewer_role.TrustSafetyAdmin,
    secret: "dev-reviewer-admin",
    secret_hash: "scrypt$379244c5d2906edee5b33048214e944f$6a2f393df29203ea1712622f26daf8f85d5fbbc2eb59546da88c6e6fa8cd8d59",
  ),
  DevReviewer(
    id: "tsr-dev-reviewer",
    name: "Marcus Bell",
    role: reviewer_role.TrustSafetyReviewer,
    secret: "dev-reviewer",
    secret_hash: "scrypt$420a00ae65c73e6e3cb5fa3b7a1ced10$f5a149a1f01ca49d3233ecdd061967dfb8a71f808141f7bd2fe55bc72efd8ed3",
  ),
  DevReviewer(
    id: "tsr-dev-admin2",
    name: "Léa Fontaine",
    role: reviewer_role.TrustSafetyAdmin,
    secret: "dev-reviewer-admin2",
    secret_hash: "scrypt$96148b1f3db2b69b1f25916a19645b80$165f24dc3835057d5cbb2a3e4b95d21688a805e1429f6099e8ec36383902ff4a",
  ),
]

/// Seed the dev reviewers when `dev_logins` is on and no reviewer exists. Returns whether it seeded them.
pub fn seed(
  store: Store,
  now: Int,
  dev_logins dev_logins: Bool,
) -> Result(Bool, UnitError(e)) {
  case dev_logins {
    False -> Ok(False)
    True ->
      store.unit(store, fn(tx) {
        use count <- result.try(store.one(
          store.reading(tx),
          "SELECT COUNT(*) FROM ts_reviewers",
          [],
          decode.at([0], decode.int),
        ))
        case count {
          Ok(0) -> {
            use _ <- result.map(list.try_each(all, create(tx, _, now)))
            True
          }
          _ -> Ok(False)
        }
      })
  }
}

fn create(tx: store.Tx, r: DevReviewer, now: Int) -> Result(Nil, Fail(e)) {
  let reviewer_id = id.reviewer(r.id)
  use _ <- result.try(reviewer_row.insert(
    tx,
    reviewer_row.Row(
      id: reviewer_id,
      name: r.name,
      role: r.role,
      status: reviewer_row.Active,
      secret_hash: r.secret_hash,
      created_at: now,
      created_by_kind: reviewer_row.System,
      created_by_id: None,
      created_by_name: Some("dev seed"),
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
      by_name: Some("dev seed"),
      by_role: None,
      action: reviewer_event_row.ReviewerCreated,
      detail_role: Some(r.role),
      detail_reason: None,
    ),
  )
}
