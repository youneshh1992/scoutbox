//// The three Trust & Safety reviewers a development server signs in with, seeded at boot into an empty reviewer
//// table when dev logins are on, as the TypeScript server does (`reviewers.mjs`). A demo first boot already has
//// them from the seed; a database a fixture wrote gets them here. A table with any reviewer is left alone.
////
//// The secrets are the published dev logins, so their hashes are no secret either. They are stored precomputed
//// because scrypt here takes about half a second a hash, and every fixture boot would pay it three times.

import gleam/dynamic/decode
import gleam/list
import gleam/result
import scoutbox/agents/reviewer_bootstrap
import scoutbox/platform/store.{type Fail, type Store, type UnitError}
import scoutbox/rows/id
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
  reviewer_bootstrap.insert_system(
    tx,
    id.reviewer(r.id),
    r.name,
    r.role,
    r.secret_hash,
    "dev seed",
    now,
  )
}
