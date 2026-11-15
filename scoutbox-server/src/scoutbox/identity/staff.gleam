//// Organisation staff (`org_users`, `org_user_recovery_codes`).
////
//// A `Staff` is the row, TOTP secret included; responses are allowlists, never the record, and only the code
//// checks read the secret. Recovery-code hashes are never read back: `use_recovery_code` spends a code.
////
//// Staff are removed softly (`removed_at`), never deleted. Staff sign in by name, so a name is unique in its
//// organisation (case-insensitive, removed staff included; this module writes `name_key`); an e-mail is unique
//// among an organisation's current staff. Each rule is checked before the write so the refusal can name it; the
//// table's unique indexes are the backstop.

import gleam/dynamic/decode
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/platform/ids
import scoutbox/platform/input
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/org_users as row
import sqlight

pub const name_max = 120

pub const role_max = 60

pub const email_max = 254

pub type Mfa {
  NoMfa
  /// Set up, awaiting the first code.
  MfaPending
  MfaEnabled(at: Int)
}

pub fn mfa(staff: Staff) -> Mfa {
  case staff.mfa_secret, staff.mfa_enabled_at {
    _, Some(at) -> MfaEnabled(at)
    Some(_), None -> MfaPending
    None, None -> NoMfa
  }
}

pub type DeliveryPrefs {
  DeliveryPrefs(
    quiet_start: Option(String),
    quiet_end: Option(String),
    email: Bool,
  )
}

pub const default_prefs = DeliveryPrefs(None, None, True)

pub fn prefs(staff: Staff) -> DeliveryPrefs {
  DeliveryPrefs(staff.quiet_start, staff.quiet_end, staff.email_enabled)
}

pub type Provenance =
  row.Provenance

/// The row, secret included: every response is an allowlist, and the secret only ever goes to the code checks.
pub type Staff =
  row.Row

pub type StaffError {
  NotFound
  NameTaken
  EmailTaken
  AlreadyRemoved
  NotRemoved
  MfaAlreadyEnabled
  MfaNotPending
  OrgMissing
  /// A value the table would refuse, by field: a bug in the caller, since routes check input first.
  Invalid(field: String)
}

/// The key a name is unique by in its organisation, and looked up by at sign-in.
pub fn name_key(name: String) -> String {
  name |> string.trim |> string.lowercase
}

fn select(where: String) -> String {
  "SELECT " <> row.columns <> " FROM org_users " <> where
}

fn first(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(Option(Staff), Fail(e)) {
  store.one(read, select(where), args, row.decoder())
  |> result.map(option.from_result)
}

// ----------------------------------------------------------------------------------------------- reads

pub fn by_id(read: Read, id: String) -> Result(Option(Staff), Fail(e)) {
  first(read, "WHERE id = ?", [sqlight.text(id)])
}

/// The account with this name in the organisation (case-insensitive; removed accounts included).
pub fn by_org_and_name(
  read: Read,
  org_id: String,
  name: String,
) -> Result(Option(Staff), Fail(e)) {
  case name_key(name) {
    "" -> Ok(None)
    key ->
      first(read, "WHERE org_id = ? AND name_key = ?", [
        sqlight.text(org_id),
        sqlight.text(key),
      ])
  }
}

/// The organisation's staff in creation order; `active_only` leaves out removed accounts.
pub fn for_org(
  read: Read,
  org_id: String,
  active_only active_only: Bool,
) -> Result(List(Staff), Fail(e)) {
  let filter = case active_only {
    True -> " AND removed_at IS NULL"
    False -> ""
  }
  store.query(
    read,
    select("WHERE org_id = ?" <> filter <> " ORDER BY rowid"),
    [sqlight.text(org_id)],
    row.decoder(),
  )
}

/// The organisation's first current staff member, in creation order.
pub fn first_active(
  read: Read,
  org_id: String,
) -> Result(Option(Staff), Fail(e)) {
  first(read, "WHERE org_id = ? AND removed_at IS NULL ORDER BY rowid LIMIT 1", [
    sqlight.text(org_id),
  ])
}

/// The current staff member with this e-mail (case-insensitive).
pub fn active_by_email(
  read: Read,
  org_id: String,
  email: String,
) -> Result(Option(Staff), Fail(e)) {
  first(
    read,
    "WHERE org_id = ? AND lower(email) = lower(?) AND removed_at IS NULL",
    [sqlight.text(org_id), sqlight.text(email)],
  )
}

/// The TOTP secret, for the code checks only.
pub fn mfa_secret_of(
  read: Read,
  id: String,
) -> Result(Option(String), Fail(e)) {
  by_id(read, id)
  |> result.map(option.then(_, fn(staff) { staff.mfa_secret }))
}

// ---------------------------------------------------------------------------------------------- writes

fn check_text(
  value: String,
  field: String,
  min: Int,
  max: Int,
) -> Result(Nil, Fail(StaffError)) {
  let length = string.length(value)
  case length >= min && length <= max && value == string.trim(value) {
    True -> Ok(Nil)
    False -> store.refuse(Invalid(field))
  }
}

fn check_email(email: Option(String)) -> Result(Nil, Fail(StaffError)) {
  case email {
    None -> Ok(Nil)
    Some(e) -> check_text(e, "email", 3, email_max)
  }
}

/// The uniqueness rules, named before the engine would refuse them. `id` is the row being written.
fn check_clashes(
  tx: Tx,
  id: String,
  org_id: String,
  name: String,
  email: Option(String),
  removed: Bool,
) -> Result(Nil, Fail(StaffError)) {
  let read = store.reading(tx)
  use name_clash <- result.try(store.one(
    read,
    "SELECT 1 FROM org_users WHERE org_id = ? AND name_key = ? AND id <> ?",
    [sqlight.text(org_id), sqlight.text(name_key(name)), sqlight.text(id)],
    decode.success(Nil),
  ))
  use <- refuse_when(name_clash == Ok(Nil), NameTaken)
  case email, removed {
    Some(email), False -> {
      use email_clash <- result.try(store.one(
        read,
        "SELECT 1 FROM org_users WHERE org_id = ? AND lower(email) = lower(?) AND removed_at IS NULL AND id <> ?",
        [sqlight.text(org_id), sqlight.text(email), sqlight.text(id)],
        decode.success(Nil),
      ))
      use <- refuse_when(email_clash == Ok(Nil), EmailTaken)
      Ok(Nil)
    }
    _, _ -> Ok(Nil)
  }
}

fn refuse_when(
  condition: Bool,
  error: StaffError,
  next: fn() -> Result(a, Fail(StaffError)),
) -> Result(a, Fail(StaffError)) {
  case condition {
    True -> store.refuse(error)
    False -> next()
  }
}

fn stored(tx: Tx, id: String) -> Result(Staff, Fail(StaffError)) {
  use found <- result.try(by_id(store.reading(tx), id))
  case found {
    Some(staff) -> Ok(staff)
    None -> store.refuse(NotFound)
  }
}

pub type NewStaff {
  NewStaff(
    org_id: String,
    name: String,
    role: String,
    email: Option(String),
    provenance: Option(Provenance),
    created_at: Int,
  )
}

/// Creates a staff account (its id minted here). Refuses a name or e-mail already taken.
pub fn create(tx: Tx, new: NewStaff) -> Result(Staff, Fail(StaffError)) {
  use _ <- result.try(check_text(new.name, "name", 1, name_max))
  use _ <- result.try(check_text(new.role, "role", 1, role_max))
  use _ <- result.try(check_email(new.email))
  use org <- result.try(store.one(
    store.reading(tx),
    "SELECT 1 FROM orgs WHERE id = ?",
    [sqlight.text(new.org_id)],
    decode.success(Nil),
  ))
  use <- refuse_when(org != Ok(Nil), OrgMissing)
  use id <- result.try(ids.next(tx, "usr"))
  use _ <- result.try(check_clashes(
    tx,
    id,
    new.org_id,
    new.name,
    new.email,
    False,
  ))
  use _ <- result.try(
    store.run(
      tx,
      "INSERT INTO org_users (id, org_id, name, name_key, role, email, created_at, provenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        sqlight.text(id),
        sqlight.text(new.org_id),
        sqlight.text(new.name),
        sqlight.text(name_key(new.name)),
        sqlight.text(new.role),
        sqlight.nullable(sqlight.text, new.email),
        sqlight.int(new.created_at),
        sqlight.nullable(
          fn(p) { sqlight.text(row.provenance_to_string(p)) },
          new.provenance,
        ),
      ],
    ),
  )
  stored(tx, id)
}

/// Restores a removed staff member with `role`, bound to `email`. Refuses a current account, and an e-mail
/// another current staff member has.
pub fn restore(
  tx: Tx,
  id: String,
  role role: String,
  email email: Option(String),
) -> Result(Staff, Fail(StaffError)) {
  use before <- result.try(stored(tx, id))
  use <- refuse_when(before.removed_at == None, NotRemoved)
  use _ <- result.try(check_text(role, "role", 1, role_max))
  use _ <- result.try(check_email(email))
  use _ <- result.try(check_clashes(
    tx,
    id,
    before.org_id,
    before.name,
    email,
    False,
  ))
  use _ <- result.try(
    store.run(
      tx,
      "UPDATE org_users SET removed_at = NULL, removed_by_id = NULL, role = ?, email = ? WHERE id = ?",
      [
        sqlight.text(role),
        sqlight.nullable(sqlight.text, email),
        sqlight.text(id),
      ],
    ),
  )
  stored(tx, id)
}

/// Sets the e-mail. Refuses one another current staff member has.
pub fn set_email(
  tx: Tx,
  id: String,
  email: Option(String),
) -> Result(Staff, Fail(StaffError)) {
  use before <- result.try(stored(tx, id))
  use _ <- result.try(check_email(email))
  use _ <- result.try(check_clashes(
    tx,
    id,
    before.org_id,
    before.name,
    email,
    before.removed_at != None,
  ))
  use _ <- result.try(
    store.run(tx, "UPDATE org_users SET email = ? WHERE id = ?", [
      sqlight.nullable(sqlight.text, email),
      sqlight.text(id),
    ]),
  )
  stored(tx, id)
}

pub fn set_role(
  tx: Tx,
  id: String,
  role: String,
) -> Result(Staff, Fail(StaffError)) {
  use _ <- result.try(check_text(role, "role", 1, role_max))
  use changed <- result.try(store.write(
    tx,
    "UPDATE org_users SET role = ? WHERE id = ? RETURNING id",
    [sqlight.text(role), sqlight.text(id)],
    decode.success(Nil),
  ))
  use <- refuse_when(changed == [], NotFound)
  stored(tx, id)
}

pub fn set_delivery_prefs(
  tx: Tx,
  id: String,
  prefs: DeliveryPrefs,
) -> Result(Staff, Fail(StaffError)) {
  let time_ok = fn(t) { option.map(t, input.is_hhmm) |> option.unwrap(True) }
  use <- refuse_when(!time_ok(prefs.quiet_start), Invalid("quietStart"))
  use <- refuse_when(!time_ok(prefs.quiet_end), Invalid("quietEnd"))
  use changed <- result.try(store.write(
    tx,
    "UPDATE org_users SET quiet_start = ?, quiet_end = ?, email_enabled = ? WHERE id = ? RETURNING id",
    [
      sqlight.nullable(sqlight.text, prefs.quiet_start),
      sqlight.nullable(sqlight.text, prefs.quiet_end),
      sqlight.bool(prefs.email),
      sqlight.text(id),
    ],
    decode.success(Nil),
  ))
  use <- refuse_when(changed == [], NotFound)
  stored(tx, id)
}

/// Ends a membership at `at`, by `by` (staff of the same organisation). The row stays, so history remains
/// attributed. Only the call that changed the row succeeds: a second removal is AlreadyRemoved.
pub fn remove(
  tx: Tx,
  id: String,
  at at: Int,
  by by: String,
) -> Result(Staff, Fail(StaffError)) {
  use before <- result.try(stored(tx, id))
  use remover <- result.try(by_id(store.reading(tx), by))
  use <- refuse_when(
    option.map(remover, fn(r) { r.org_id }) != Some(before.org_id),
    Invalid("removedById"),
  )
  use changed <- result.try(store.write(
    tx,
    "UPDATE org_users SET removed_at = ?, removed_by_id = ? WHERE id = ? AND removed_at IS NULL RETURNING id",
    [sqlight.int(at), sqlight.text(by), sqlight.text(id)],
    decode.success(Nil),
  ))
  use <- refuse_when(changed == [], AlreadyRemoved)
  stored(tx, id)
}

/// Begins MFA set-up with a new secret, replacing an unconfirmed one. Refused once MFA is enabled.
pub fn start_mfa(
  tx: Tx,
  id: String,
  secret_b32: String,
) -> Result(Staff, Fail(StaffError)) {
  use before <- result.try(stored(tx, id))
  use <- refuse_when(
    case mfa(before) {
      MfaEnabled(_) -> True
      _ -> False
    },
    MfaAlreadyEnabled,
  )
  use _ <- result.try(check_text(secret_b32, "mfaSecret", 16, 128))
  use _ <- result.try(
    store.run(
      tx,
      "UPDATE org_users SET mfa_secret = ?, mfa_enabled_at = NULL WHERE id = ?",
      [sqlight.text(secret_b32), sqlight.text(id)],
    ),
  )
  use _ <- result.try(
    store.run(tx, "DELETE FROM org_user_recovery_codes WHERE org_user_id = ?", [
      sqlight.text(id),
    ]),
  )
  stored(tx, id)
}

/// Confirms MFA: enabled from `at`, with these recovery-code hashes, each usable once.
pub fn enable_mfa(
  tx: Tx,
  id: String,
  at at: Int,
  recovery_hashes hashes: List(String),
) -> Result(Staff, Fail(StaffError)) {
  use before <- result.try(stored(tx, id))
  use <- refuse_when(mfa(before) != MfaPending, MfaNotPending)
  use <- refuse_when(
    list.unique(hashes) != hashes || !list.all(hashes, is_hash),
    Invalid("recoveryHashes"),
  )
  use _ <- result.try(
    store.run(tx, "UPDATE org_users SET mfa_enabled_at = ? WHERE id = ?", [
      sqlight.int(at),
      sqlight.text(id),
    ]),
  )
  use _ <- result.try(
    list.try_each(hashes, fn(hash) {
      store.run(
        tx,
        "INSERT INTO org_user_recovery_codes (org_user_id, code_hash) VALUES (?, ?)",
        [sqlight.text(id), sqlight.text(hash)],
      )
    }),
  )
  stored(tx, id)
}

/// Turns MFA off: the secret and the unused recovery codes go.
pub fn disable_mfa(tx: Tx, id: String) -> Result(Staff, Fail(StaffError)) {
  use _ <- result.try(stored(tx, id))
  use _ <- result.try(
    store.run(tx, "DELETE FROM org_user_recovery_codes WHERE org_user_id = ?", [
      sqlight.text(id),
    ]),
  )
  use _ <- result.try(
    store.run(
      tx,
      "UPDATE org_users SET mfa_secret = NULL, mfa_enabled_at = NULL WHERE id = ?",
      [sqlight.text(id)],
    ),
  )
  stored(tx, id)
}

/// Spends one recovery code, by its hash. True only for the call that deleted the row: a code works once.
pub fn use_recovery_code(
  tx: Tx,
  id: String,
  code_hash: String,
) -> Result(Bool, Fail(e)) {
  case is_hash(code_hash) {
    False -> Ok(False)
    True ->
      store.write(
        tx,
        "DELETE FROM org_user_recovery_codes WHERE org_user_id = ? AND code_hash = ? RETURNING 1",
        [sqlight.text(id), sqlight.text(code_hash)],
        decode.success(Nil),
      )
      |> result.map(fn(rows) { rows != [] })
  }
}

fn is_hash(s: String) -> Bool {
  string.length(s) == 64
  && list.all(string.to_graphemes(s), fn(g) {
    string.contains("0123456789abcdef", g)
  })
}
