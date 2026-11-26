import gleam/erlang/process
import gleam/list
import gleam/option.{None, Some}
import gleam/result
import scoutbox/identity/invites
import scoutbox/identity/staff
import scoutbox/platform/secrets
import scoutbox/platform/store
import scoutbox/rows/id
import scoutbox/support

fn new(name: String, email: option.Option(String)) -> staff.NewStaff {
  staff.NewStaff(
    org_id: id.org("org-eastport"),
    name:,
    role: "Scout",
    email:,
    provenance: None,
    created_at: 1,
  )
}

fn act(
  s: store.Store,
  work: fn(store.Tx) -> Result(a, store.Fail(f)),
) -> Result(a, store.UnitError(f)) {
  store.unit(s, fn(tx) { work(tx) })
}

pub fn a_name_is_unique_whatever_its_case_and_after_removal_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let assert Ok(lead) = act(s, staff.create(_, new("Maria Keane", None)))
  let assert Ok(tom) = act(s, staff.create(_, new("Tom Reid", None)))
  let assert Ok(_) = act(s, staff.remove(_, tom.id, at: 5, by: lead.id))
  assert act(s, staff.create(_, new("TOM REID", None)))
    == Error(store.Refused(staff.NameTaken))
  assert act(s, staff.remove(_, tom.id, at: 6, by: lead.id))
    == Error(store.Refused(staff.AlreadyRemoved))
}

pub fn an_email_is_unique_among_current_staff_only_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let assert Ok(lead) = act(s, staff.create(_, new("Lead", None)))
  let assert Ok(a) = act(s, staff.create(_, new("A", Some("a@x.example"))))
  assert act(s, staff.create(_, new("B", Some("A@X.example"))))
    == Error(store.Refused(staff.EmailTaken))
  let assert Ok(_) = act(s, staff.remove(_, a.id, at: 5, by: lead.id))
  let assert Ok(_) = act(s, staff.create(_, new("B", Some("A@X.example"))))
}

pub fn a_recovery_code_works_once_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let assert Ok(u) = act(s, staff.create(_, new("U", None)))
  let hash = secrets.sha256_hex("code")
  let assert Ok(_) = act(s, staff.start_mfa(_, u.id, "ABCDEFGHIJKLMNOP"))
  let assert Ok(_) =
    act(s, staff.enable_mfa(_, u.id, at: 9, recovery_hashes: [hash]))
  assert act(s, staff.use_recovery_code(_, u.id, hash)) == Ok(True)
  assert act(s, staff.use_recovery_code(_, u.id, hash)) == Ok(False)
}

pub fn of_two_racing_acceptances_one_wins_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let assert Ok(u) = act(s, staff.create(_, new("U", None)))
  let assert Ok(invite) =
    act(s, invites.create(
      _,
      invites.NewInvite(
        org_id: id.org("org-eastport"),
        email: "n@x.example",
        name: "N",
        role: "Scout",
        token_hash: secrets.sha256_hex("t"),
        invited_by: None,
        at: 1,
      ),
    ))
  let results = process.new_subject()
  list.each([1, 2, 3, 4], fn(_) {
    process.spawn(fn() {
      process.send(
        results,
        act(s, invites.accept(_, invite.id, user_id: u.id, at: 2)),
      )
    })
  })
  let outcomes =
    list.map([1, 2, 3, 4], fn(_) {
      let assert Ok(r) = process.receive(results, 5000)
      r
    })
  assert list.count(outcomes, result.is_ok) == 1
  assert list.count(outcomes, fn(r) {
      r == Error(store.Refused(invites.NotPending))
    })
    == 3
}

pub fn an_sso_subject_links_one_account_of_the_organisation_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let assert Ok(a) = act(s, staff.create(_, new("A", Some("a@x.example"))))
  let assert Ok(b) = act(s, staff.create(_, new("B", Some("b@x.example"))))
  let assert Ok(linked) = act(s, staff.link_sso(_, a.id, "idp-1"))
  assert linked.sso_subject == Some("idp-1")
  assert act(s, staff.link_sso(_, b.id, "idp-1"))
    == Error(store.Refused(staff.SsoTaken))
  // Linking again to the subject it holds is not a clash with itself.
  let assert Ok(_) = act(s, staff.link_sso(_, a.id, "idp-1"))
  let assert Ok(Some(found)) =
    store.read(s, staff.by_sso_subject(_, id.org("org-eastport"), "idp-1"))
  assert found.id == a.id
  let assert Ok(None) =
    store.read(s, staff.by_sso_subject(_, id.org("org-eastport"), ""))
}

pub fn a_revoked_invite_stays_revoked_and_an_accepted_one_accepted_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let assert Ok(u) = act(s, staff.create(_, new("U", None)))
  let invite = fn(hash) {
    let assert Ok(i) =
      act(s, invites.create(
        _,
        invites.NewInvite(
          org_id: id.org("org-eastport"),
          email: "n@x.example",
          name: "N",
          role: "Scout",
          token_hash: secrets.sha256_hex(hash),
          invited_by: None,
          at: 1,
        ),
      ))
    i
  }
  let pending = invite("p")
  let assert Ok(revoked) = act(s, invites.revoke(_, pending.id, 5))
  assert revoked.revoked_at == Some(5)
  let assert Ok(again) = act(s, invites.revoke(_, pending.id, 9))
  assert again.revoked_at == Some(5)
  assert act(s, invites.accept(_, pending.id, user_id: u.id, at: 10))
    == Error(store.Refused(invites.NotPending))
  let taken = invite("q")
  let assert Ok(_) = act(s, invites.accept(_, taken.id, user_id: u.id, at: 3))
  let assert Ok(still) = act(s, invites.revoke(_, taken.id, 4))
  assert still.revoked_at == None
}
