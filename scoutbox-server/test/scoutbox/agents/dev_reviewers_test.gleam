import gleam/dynamic/decode
import gleam/list
import scoutbox/agents/dev_reviewers
import scoutbox/identity/passwords
import scoutbox/platform/store
import scoutbox/support

const now = 1_800_000_000_000

fn reviewers(s: store.Store) -> List(#(String, String)) {
  let assert Ok(rows) =
    store.read(s, fn(r) {
      store.query(
        r,
        "SELECT r.id, h.by_name FROM ts_reviewers r JOIN ts_reviewer_history h ON h.reviewer_id = r.id ORDER BY r.rowid",
        [],
        {
          use id <- decode.field(0, decode.string)
          use by <- decode.field(1, decode.string)
          decode.success(#(id, by))
        },
      )
    })
  rows
}

/// A migrated store with no reviewer (the demo seed's are removed), as a database a fixture wrote.
fn without_reviewers() -> store.Store {
  let s = support.fresh_store(fn(_) { Nil })
  let assert Ok(_) =
    store.unit(s, fn(tx) {
      store.exec(
        tx,
        "DELETE FROM ts_reviewer_history; DELETE FROM ts_reviewers;",
      )
    })
  s
}

pub fn each_stored_hash_is_its_secret_test() {
  let assert True =
    list.all(dev_reviewers.all, fn(r) {
      passwords.verify(r.secret, r.secret_hash)
    })
}

pub fn an_empty_reviewer_table_gets_the_three_test() {
  let s = without_reviewers()
  let assert Ok(True) = dev_reviewers.seed(s, now, dev_logins: True)
  let assert [
    #("tsr-dev-admin", "dev seed"),
    #("tsr-dev-reviewer", "dev seed"),
    #("tsr-dev-admin2", "dev seed"),
  ] = reviewers(s)
  // A second boot finds them and seeds nothing.
  let assert Ok(False) = dev_reviewers.seed(s, now, dev_logins: True)
  let assert 3 = list.length(reviewers(s))
}

pub fn a_table_with_any_reviewer_is_left_alone_test() {
  let s = without_reviewers()
  let assert Ok(_) =
    store.unit(s, fn(tx) {
      store.exec(
        tx,
        "INSERT INTO ts_reviewers (id, name, role, status, secret_hash, created_at, created_by_kind, rev) VALUES ('tsr-op', 'Operator', 'trust_safety_admin', 'active', 'x', 1, 'system', 1);"
          <> "INSERT INTO ts_reviewer_history (id, reviewer_id, ord, at, by_kind, by_name, action, detail_role) VALUES ('aud-op', 'tsr-op', 0, 1, 'system', 'bootstrap env', 'reviewer_created', 'trust_safety_admin');",
      )
    })
  let assert Ok(False) = dev_reviewers.seed(s, now, dev_logins: True)
  let assert [#("tsr-op", "bootstrap env")] = reviewers(s)
}

pub fn no_dev_logins_no_reviewers_test() {
  let s = without_reviewers()
  let assert Ok(False) = dev_reviewers.seed(s, now, dev_logins: False)
  let assert [] = reviewers(s)
}
