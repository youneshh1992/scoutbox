# ScoutBox server operations (Milestone 13)

## Secrets
Secrets live in the **environment**, never in the database or backups:
- `ADMIN_KEY` — Trust & Safety console key (dev default `scoutbox-admin`; set a real one in production).
- `DELIVERY_CALLBACK_SECRET` — HMAC secret for provider delivery callbacks (dev default `local-fake-callback-secret`).
- `TEST_IDP_SECRET` — local test IdP signing secret. Development only: unset,
  a random secret is drawn per boot (there is no fixed default); the SSO routes
  refuse outside development; and setting it on a production instance refuses
  to boot (`TEST_IDP_IN_PRODUCTION`).
- Media-URL signing keys are generated per boot (M11).
Webhook endpoint secrets and API-key hashes are tenant data and DO live in the
database; API keys themselves are stored as SHA-256 hashes and shown once.

Flags: `ALLOW_LOCAL_WEBHOOKS=1` (loopback webhook destinations, tests only),
`M13_FAST_RETRY=1` (compressed retry ladders + fast verification sweep, tests
only), `M13_QUIET_LOGS=1` (suppresses per-request log lines),
`TEST_LICENCE_REGISTRY=1|down` (enables the LOCAL licence-register test
fixture / simulates its outage — test environments only; production registers
are `not_configured`), `ALLOW_DEV_LOGINS` / `NODE_ENV` (see M11).

## Runtime requirement: node:sqlite with transaction state
The server needs **Node.js 22.16 or later on the 22 line, or 24.0 or later**,
with the built-in `node:sqlite` module (on by default; `package.json`
declares `engines.node >= 22.16.0`, and `runtime.mjs` is the one definition of
the contract). The floor is set by `DatabaseSync.isTransaction`, which the data
layer uses to tell a save transaction from autocommit; it arrived in 22.16.0
and 24.0.0. There is **no JSON or in-memory fallback**: without the module the
process stops at startup with `SQLITE_REQUIRED`, and on an older Node.js (or a
build whose `node:sqlite` lacks the property, whatever its version says) with
`NODE_UNSUPPORTED` — in both cases before `DATA_DIR` is created, opened or
written, so an existing directory is byte-identical afterwards and an absent
one is not created. On such a runtime a server that did open the database
would fail every save and leave a transaction open, which is why the check
is refused up front rather than reported later. `npm test` runs the contract
check on the current Node.js and on a masked simulation of an older one;
`SCOUTBOX_TEST_NODE_BINS=/path/to/node:/other/node npm test` additionally runs
the same probe on real binaries (a supported one must save, roll a failed
save back and retry; an unsupported one must be refused with nothing written).
Sessions are stored only as token hashes in a table, which a JSON snapshot
could not hold without keeping plain tokens again.

## Data layer
`DATA_DIR/scoutbox.db` holds two kinds of data. Collections that have not yet
moved are stored as one JSON blob each in the `collections` table, saved as a
whole on a debounce. Collections that have moved to the relational data layer
(`scoutbox-server/repositories/`) are real tables, written one row at a time
inside a transaction the moment a change happens, and recorded in
`data_migrations`. `GET /capabilities` lists them under `dataLayer` (`tables`,
`migrations`, `domains`). Moved so far: staff accounts (`users` → `org_users`,
migration `0001`), sessions (`sessions`, migration `0003`, see "Sessions"
below) and organisations (`orgs`, migration `0004`, see "Organisations"
below). A first boot after a move imports the old blob into the table and
retires the blob. Tools that read or write the file as one snapshot
(`openStore(dir)` without options) see every collection in the shape the
server sees, tables included. Whether such a tool reads a collection from its
table or from its blob is decided by the domain's record in `data_migrations`,
never by whether the table exists or has rows: before the record the blob is
authoritative and the table is left alone (it may be an S1 shadow or a
rollback copy's emptied table); after it the blob is gone.

- **Legacy `db.json`.** A pre-SQLite snapshot found in `DATA_DIR` with an
  empty database is imported on the first boot: every collection it holds is
  written into the database first (table-backed collections as blobs when
  their domain has not cut over yet, so the cutover migrations import them
  from the file; into their tables when it has), and only after that commit is
  the file renamed `db.json.migrated`. Only a **genuinely absent** `db.json`
  means "first installation, run from seed". A file that exists but cannot be
  read, is not valid JSON, is not a snapshot envelope (`{ savedAt, idCounter,
  db: { players: [...], ... } }`), or carries a table-backed collection that is
  not an array stops the boot with `LEGACY_IMPORT_FAILED` **before it
  listens**: `db.json` stays in place byte for byte, nothing is written or
  renamed, and no seed data is saved. The same happens when the content fails
  the import itself (an unsupported session, say). Fix or move the file, then
  start again; the retry imports a repaired file.
- **Snapshot saves are strict.** A tool writing a snapshot back (restore,
  fixture) has every table-backed collection checked first. A collection that
  is present but not an array (an object, `null`, a string, a number) rejects
  the **whole save** before anything is dispatched to a table or a blob, so
  nothing it held (a plaintext token, say) can reach the file and no legacy
  blob is recreated after a cutover; a collection that is simply absent is a
  partial snapshot and leaves that table alone. Then every row is validated:
  one invalid or conflicting row (malformed session, duplicate session id or
  token, a staff relationship the snapshot itself breaks) rejects the whole
  save the same way. The transaction rolls back and every collection, sessions
  included, stays as it was. Nothing is coerced, repaired or dropped; the error
  names the session id and the reason, never a token. Removing a session is an
  explicit act (sign out, revocation, or a snapshot that no longer lists it).

A third kind exists during the migration: *shadow* tables (`orgs`, `guardians`,
`players`, `guardian_children` since migration `0002`). The blob is still the
source of truth for these and nothing reads the tables yet. They are filled by
a *projection* that rewrites all four from the snapshot, and that projection is
**off by default**: a normal save never touches them. The projection never
writes or deletes the live `sessions` table, whether or not it is switched on.

- `SCOUTBOX_SHADOW_VALIDATION=1` switches the projection on. It then runs inside
  every save transaction, in its own savepoint; a projection failure is counted
  and rolled back and never blocks the save. Cost: about ten times the blob save
  at 10k players (`npm run perf:data-layer`), so use it for controlled
  validation runs, not as a running default. `GET /capabilities` reports the
  switch under `shadow_validation`.
- `node scripts/validateShadow.mjs <data-dir>` runs the same projection against
  a copy of a database (the source is opened read-only and copied with
  `VACUUM INTO`; the copy is deleted afterwards) and prints the reconciliation
  with every refused row and its reason. Use it on a backup or on a copy of a
  running data directory; it never modifies the file it is pointed at. Without
  flags it is informational (exit 0 whether the result is `complete` or
  `partial`; exit 2 if the projection itself failed). With `--strict` it is the
  migration-readiness gate: exit 3 unless the result is `complete`, that is, no
  refused row and no adjusted relationship. Run the strict form before any
  cutover and treat a non-zero exit as "not ready".
- Freshness is a persisted save revision, not a timestamp. Every save of the
  snapshot advances `meta.saveSeq` (whether or not the projection ran); the
  projection records the revision it ran in. `GET /capabilities` →
  `dataLayer.shadow` reports `enabled`, `status` (`never`, `stale`, `failed`,
  `partial`, `complete`), `reconciled` (true only for `complete`), the totals
  `skipped` (rows the schema refused) and `findings` (relationships written as
  NULL because their target was missing: these also keep the result `partial`),
  `snapshotRevision` versus `lastProjectionRevision`, and per table the rows in
  the snapshot now, in the table now, and seen / refused / adjusted by the last
  projection. Any save made after the last projection, including one made with
  the switch off or one whose projection failed, makes the shadow `stale`, never
  reconciled. Counts and statuses only are public; `GET /admin/data-layer`
  (admin key) adds the refused row ids, the adjusted relationships and the last
  error text.
- No report carries a token, a password hash or a code.

### Sessions (live since migration `0003`)
Sessions are rows of the `sessions` table, owned by
`repositories/sessions.mjs`. A bearer token is returned to the client once and
stored only as its SHA-256 (`token_hash`); every lookup is by hash on the
primary key. Nothing in the file, the logs, `GET /capabilities`,
`GET /admin/data-layer`, `GET /org/sessions` or a snapshot export carries a
plain token. Existing tokens and session ids (`sid`, used in signed media links
and event-stream tickets) stay valid across the cutover and every restart.

- **Lifetime.** `SESSION_TTL_DAYS` (default 30). A session is live while less
  than that has passed since it was created, judged against the value configured
  *now*: changing the variable and restarting applies the new lifetime to every
  existing session at once (shortening it can sign users out; extending it
  revives none that were already deleted). The boot log records the change
  (`sessions: the configured lifetime changed …`), and `GET /capabilities` shows
  it under `dataLayer.domains.sessions.lifetimeMs`.
- **S2 cutover (first boot of this build on an older file).** The boot
  validates every entry of the old `sessions` blob and imports it with hashed
  tokens, retires the blob and records `0003_sessions_live`, all in one
  transaction. On a pre-S0 file (staff still in the `users` blob) it imports
  that blob into `org_users` first, in the same transaction. If any entry is
  unsupported (no token, unknown kind, no refId, bad creation time, an org
  session without a known staff row, an unknown field, a duplicate token or
  sid) the boot **refuses** with `SESSIONS_CUTOVER_BLOCKED` and lists each
  `sid` with its reason; the file is unchanged and the previous build still
  runs it. Nothing is dropped, repaired or revoked automatically. Dry-run first:
  copy the data directory (server stopped, or from a backup), boot this build
  with `DATA_DIR=<copy>` and read the log; the real directory is not touched.
  If it refuses, resolve each listed `sid` on the previous build with the
  server stopped (an unsupported entry cannot authenticate, so removing it
  changes nothing a user can observe), repeat the dry run, then upgrade.
- **After the cutover boot.** The plain tokens the blob once held are gone
  from every active row but may remain *physically* in free pages and in the
  WAL until, with the server stopped:
  `sqlite3 DATA_DIR/scoutbox.db "PRAGMA wal_checkpoint(TRUNCATE); VACUUM;"`
  (or the same two statements from `node -e` with `node:sqlite`). Every backup
  taken before the cutover still holds plain tokens and remains a usable
  credential store until `SESSION_TTL_DAYS` have passed since it was taken:
  keep such backups under the same controls as the live directory, or rotate
  them once a post-cutover backup exists. No tool deletes a backup for you.
- **Rollback to the previous build.** Do not restore a pre-cutover backup: it
  would revive every session revoked since and discard every later write. Run
  `node scripts/sessionsRollback.mjs <data-dir> <out-dir>` (server stopped):
  it copies the current file read-only into `<out-dir>`, removes the cutover
  record, empties the table and writes an empty legacy `sessions` blob, keeping
  every other collection as it is now; the source is never modified. Start the
  previous build on `<out-dir>`: every user signs in again (hashes cannot be
  turned back into tokens) and no revoked session can come back. The tool
  refuses (exit 4, no output file) a database that carries a later migration
  than `0003`, and refuses an output directory that already holds a database.
- **Concurrency.** Every connection the store opens sets
  `PRAGMA busy_timeout = 5000`, so a save meeting another writer (a backup
  tool, a second process) waits up to five seconds instead of failing.
- **Snapshot tools and backups.** In snapshot mode (`openStore(dir)` without
  options) `db.sessions` is the table's rows with `tokenHash`, never `token`,
  once the cutover record `0003_sessions_live` exists; before it (an S1 file,
  or a rollback copy before re-upgrade) the tool reads and writes the legacy
  `sessions` blob and ignores the table. Saving writes hashed rows back by
  hash and rejects the whole save on any invalid or conflicting row (see
  "Snapshot saves are strict" above). Writing the `users` collection back
  upserts staff rows and deletes only ids absent from the snapshot, so a
  restore cannot cascade-delete valid sessions through `sessions.org_user_id`;
  a snapshot that lists a session for a staff member it no longer contains is
  rejected as a whole.
- **Admin backups (`POST /admin/backup`).** The backup's `db.json` carries the
  sessions in their stored form, token hashes only (the hash-free in-memory
  view could not be restored), so a restore into an empty directory keeps
  every session alive exactly as a copy of the database file would. Before S2
  the same file carried plain tokens; a backup still deserves the same care as
  the live directory, as its manifest says.

### Organisations (live since migration `0004`)
Organisations are rows of the `orgs` table, owned by `repositories/orgs.mjs`.
The identity and policy fields (name, type, level, plan, country, trusted
partner, verified, verified domain, safeguarding contract, suspended, the
shared bootstrap password hash, e-mail domain and its verification, the MFA
requirement for leads, creation time, location and federation reference) are
columns, written the moment a route changes them. The nested facets that
still belong to later steps (`tactical`, `squad`, `lookingFor`,
`federationCheck`, `agencySettings`, the `verification` object and any field
the schema does not know) travel in the row's `facets_json` and are saved
together with the rest of the snapshot. `GET /capabilities` shows the domain
under `dataLayer.domains.orgs` (`mode: 'live'`, the row count and the
transitional column). Staff rows (`org_users`) now carry a real foreign key to
`orgs`: a staff row cannot name an organisation that does not exist, and an
organisation with staff cannot be deleted from the table.

- **S3 cutover (first boot of this build on an older file).** The boot reads
  the old `orgs` blob, validates every record, creates the `orgs` table, rebuilds
  `org_users` as a STRICT table with the foreign key (new table, copy, drop,
  rename — sessions keep pointing at `org_users` and no session row is touched),
  records `0004_orgs_live` and retires the blob, all in one transaction. If any
  record is unsupported (unknown type, level or plan, a non-boolean flag, a
  malformed location or federation reference, a duplicate id, or a staff row
  naming an organisation the blob does not hold) the boot **refuses** with
  `ORGS_CUTOVER_BLOCKED` and lists each organisation id with its reason; the
  file is unchanged and the previous build still runs it. Nothing is dropped,
  coerced or repaired automatically, and demo data is never used to fill a gap.
  Dry-run first exactly as for S2: copy the data directory, boot this build
  with `DATA_DIR=<copy>`, read the log. If it refuses, correct the listed
  records on the previous build with the server stopped, repeat the dry run,
  then upgrade.
- **What changed in how saves work.** Column-backed fields persist at once, in
  their own transaction, like sessions. Facet changes (a squad edit, a
  looking-for list, a verification domain) persist with the next debounced
  snapshot save, as every unmigrated collection does, so a crash inside the two
  second debounce window can lose a facet change while the column change made
  in the same request has already been written. Both live in the same database
  file and the same backup; this window closes as each facet moves to its own
  table (plan S9–S11). A facet change counts as persisted only once the save
  that carried it **committed**: if a save fails after the facets were written
  (another collection cannot be serialised, the disk is full at commit, any
  error inside the transaction) the whole save rolls back and the facet change
  is written again by the next save, so a failed save followed by a successful
  one never loses an organisation change. The boot log line `snapshot save
  failed:` therefore means "retry pending", not "data lost", as long as the
  process stays up for the next save.
- **First installation and the initialisation state.** `meta.orgsInit` records
  whether the organisations were initialised: the cutover migration writes
  `done` when it imported a blob (even an empty one) or found any saved
  snapshot, and `pending` only for a database nothing was ever saved to. Only
  while it is `pending` does the next boot import the in-memory records (the
  seed on a demo boot) — once, inside one transaction with the change to
  `done`, so a boot that dies during initialisation leaves it `pending` and
  the next boot does it again. On every other boot the table is authoritative
  **even when it is empty**: a seed array, a superseded blob copy or a stale
  `orgs` blob somebody wrote back into `collections` is never imported (the
  log says how many organisations were ignored, and the next save deletes a
  stale blob). A file cut over before this state existed reads as `done`.
- **Deletion.** There is still no route that deletes an organisation, and this
  step adds none: the policy for an organisation with open recruitment cases
  (schema open question O2) is undecided, so neither a tombstone nor a hard
  delete exists. `suspended` remains the only lifecycle flag.
- **Rollback to the previous build (S2).** Do not restore a pre-cutover backup
  (it would discard every later write). Run
  `node scripts/orgsRollback.mjs <data-dir> <out-dir>` (server stopped): it
  copies the current file read-only into `<out-dir>`, writes every organisation
  — including those created after the cutover, with every column and facet —
  back into the legacy `orgs` blob in the previous representation, rebuilds
  `org_users` with the previous (S0) definition keeping every staff row,
  leaves `sessions` untouched (nobody signs in again, and no revoked session
  comes back), removes the `0004_orgs_live` record, `meta.orgsCutover` and
  `meta.orgsInit`, and prints the counts. The source is never modified. The tool refuses (exit 4, no
  output file) a database that carries a migration later than `0004`, refuses
  (exit 5) one that never cut over, and refuses an output directory that
  already holds a database. To go back further than S2, run
  `scripts/sessionsRollback.mjs` on the result of this tool: each tool only
  undoes its own step.
- **Snapshot tools and backups.** In snapshot mode (`openStore(dir)` without
  options) `db.orgs` is read from the table once the cutover record exists —
  columns and facets merged back into the record shape the server sees — and
  written back as rows; a save with an unsupported record, a duplicate id or a
  staff row naming a missing organisation is rejected as a whole. Before the
  record (an S2 file, or a rollback copy) the tool reads and writes the legacy
  blob and leaves the table alone. `POST /admin/backup` exports the same shape;
  restoring it into an empty directory boots with every organisation, facet,
  staff row and session intact.

### Units of work (transaction foundation for S4)

An operation that touches a table-backed collection *and* the blob (today: an
organisation row, its facets and any blob collection; in S4a: players,
guardians and their links too) runs inside `store.unitOfWork(() => { … })`.
This is a second contract next to the ordinary save, not a replacement:

- **Commit scope.** One SQLite transaction holds the repository writes made
  inside the callback, the facet flush and the blob write. It commits or rolls
  back as a whole; no ordinary save happens inside it (a `save()` called in the
  callback is absorbed into the unit's own write).
- **Failure.** When the callback throws, or the write or COMMIT fails, the
  database is unchanged and the in-memory graph is restored *in place* to its
  pre-operation values: held references keep their identity, repository caches,
  facet bookkeeping and derived views are coherent again, and the error is
  re-thrown with `err.unitOfWork = 'rolled_back'`. Nothing is left pending: a
  later ordinary save persists no fragment of the failed operation.
- **Retry.** Explicit only — the caller reruns the whole operation. The
  ordinary save keeps the S3 contract (facets not yet committed stay pending
  and the next save retries them); a failed unit leaves nothing to retry.
- **Unrelated pending edits** made before the unit (blob or facet) survive a
  rollback and are persisted by the next ordinary save, as before.
- **Crash before COMMIT.** The journal rolls back on the next open; a restart
  sees the pre-operation database.
- **Rules.** The callback is synchronous: no transaction spans an `await` or a
  network call. An `async function` is refused **before it is invoked**, so
  nothing of it runs (top-level or nested). A plain function that returns a
  promise cannot be recognised beforehand: its synchronous part is rolled back
  with the unit, the unit refuses, and the promise is observed (a rejection is
  counted and logged, never unhandled) — but **its continuation is not
  cancelled** and runs later outside any unit; the escape is counted in
  `store.unitOfWorkState().strayAsyncWork`. Do not schedule asynchronous work
  inside a unit; the store cannot make it safe. A unit cannot start inside
  another open transaction. A nested `unitOfWork` joins the outer one, and an
  inner failure poisons the whole unit **even if the inner caller catches the
  error**: the outer unit fails at its end (the inner error is its `cause`) and
  everything rolls back. Side effects (broadcasts, pushes) are deferred with
  `store.afterCommit(fn)` and run only after COMMIT; `server.mjs` does this for
  `broadcast()` and the push half of `notify()` (which returns its promise). A
  side effect never fails the operation: a synchronous throw or a rejected
  returned promise is counted in `store.unitOfWorkState()` and logged, later
  callbacks still run, and the data stays committed. Outside a unit,
  `afterCommit` runs the function at once, observed the same way.
- **Setup and teardown are exception-safe.** A failed BEGIN opens no unit and
  runs no work (ordinary saves and later units are unaffected). A cleanup step
  that fails during a rollback (ROLLBACK itself, the memento, a participant's
  restore) is recorded in `unitOfWorkState().restoreFailures`, attached to the
  error as `unitOfWorkCleanup`, logged, and still closes the unit; memory may
  then differ from the database until the next restart, which the log says.
- **Participants.** Organisations join fully (rows, facets, bookkeeping, cache
  restore). Sessions are stateless and may be written inside a unit (a revoked
  session comes back on rollback). Staff (`org_users`) is **not** integrated:
  its insert/update refuse inside a unit with a clear error — make staff changes
  outside the unit. Snapshot mode has no units.
- **Tests.** `scripts/testUnitOfWork.mjs` (part of `npm test`) covers failure
  after row, facet and blob writes, failure at COMMIT, a crash before COMMIT
  (child process killed), the no-fragment and explicit-retry rules, unrelated
  pending edits and the S3 ordinary-save retry contract, and — after an
  independent review of the first commit — a failed BEGIN and a failing
  cleanup step, a swallowed nested failure, a facet changed inside a unit and
  changed back before COMMIT (the row update's intermediate value must not
  survive), async work refused before invocation and an escaped thenable, and
  asynchronous after-commit failures.

### S4a preparation: player/guardian mapping and the read-only preflight

Before the players and guardians cut over (plan step S4a, **not started**), the
mapping they will use and a read-only check of the data exist and are tested:

- `repositories/identityMapping.mjs` — `playerToRow` / `playerFromRow`,
  `guardianToRow` / `guardianFromRow`, `validatePlayerRecord`,
  `validateGuardianRecord`: the S3 organisation pattern for the two domains.
  Scalars and composites go to the columns of `docs/architecture/sql/01_identity.sql`;
  the nested arrays that wait for S5, the remainders of the split composites
  (`medical.records`, `programme.completed`), the guardian's `coGuardians` and
  its outstanding `emailCode` (kept plain, once, not hashed — readiness review
  §8.2), and any unknown field ride in the row's transitional `facets_json`
  with the record's shape, so a record reads back byte-identical (absent stays
  absent, null stays null). `childIds` becomes `guardian_children` rows. Nothing
  is coerced or invented; a refused value is reported with the field and reason.
- `node scripts/preflightCoreIdentity.mjs <data-dir | snapshot.json> [--json] [--now <ms>]`
  (`npm run preflight:core-identity -- …`) — validates the two blob collections
  and every relationship (duplicate ids, duplicate guardian e-mails compared
  case-insensitively, dangling references, a `guardianId` the guardian's
  `childIds` does not confirm, duplicate links, a self co-guardian, invalid
  dates) and reports by id and reason; counts what the cutover would carry as
  is (co links, adults still linked, co-guardian arrangements). A data
  directory is copied read-only (`VACUUM INTO` from a read-only connection)
  and only the copy is read; **no migration runs, nothing is written, no
  server starts**. Status is `complete` (exit 0: the data fits the intended
  schema — this is **not** an approval of the cutover) or `invalid` (exit 2).
  **A legacy minor with no guardian link at all is `invalid`** (the Founder's
  decision, readiness review §5.5: the cutover stops until the record is
  resolved by hand on the pre-S4 build); the report lists those ids under
  `legacyMinorsWithoutLink` and neither imports, omits, links, re-dates nor
  deletes them. Adults still linked and minors with co links only remain
  counted findings. The report never prints an e-mail address, a code, a hash
  or a record.
- The intended live DDL (the documented tables plus `facets_json`) is
  `CANDIDATE_DDL` in `repositories/identityPreflight.mjs`, used only to build
  temporary databases in tests; migration 0005 is **not** registered and the
  blob stays authoritative for players and guardians.
- Three guarantees added after an independent review of the first commit:
  a reference field (`guardianId`, `coGuardianOf`, a `childIds` entry) is
  either absent/null (no link) or a non-empty id — an empty string is a
  present reference that names nobody and is refused by record and field,
  never trimmed or turned into null, and the candidate writer refuses a
  malformed row before writing anything; every INTEGER-mapped field (heights,
  weights, squad numbers, timestamps, the `stats` counters,
  `programme.startedAt`) must be a safe integer (within ±2^53−1, what
  `node:sqlite` stores and reads back exactly through Numbers) — out-of-range
  values are refused, never clamped or rounded, and every complete report is
  proven to load and round-trip through the intended schema; own JSON
  properties named like `Object.prototype` members (`constructor`,
  `toString`, `__proto__`, `hasOwnProperty`) are preserved as data at every
  level (record, composite remainder, nested items) without touching any
  prototype, while `__meta` / `__rest` remain the reserved metadata keys.
- Tests: `scripts/testCoreIdentityMapping.mjs` (part of `npm test`).

### S4a repository layer: players and guardians (built, not attached)

`repositories/identity.mjs` (`createIdentityRepositories`) is the live
repository pair for players, guardians and their link, delivered before the
cutover. **Production does not use it yet**: `repositories/index.mjs` does not
create it, `TABLE_BACKED` does not list the two collections, migration 0005 is
not registered, and server boot, routes, responses, sessions and media are
unchanged. What it guarantees, tested on temporary databases prepared with the
intended schema (`scripts/identityLiveTestSchema.mjs`, test-only) and against
the real store unit of work (`scripts/testIdentityRepositories.mjs`):

- **Authority.** Attaches only behind the `0005_core_identity_live` record;
  refuses the S1 shadow tables (no `facets_json`) even with the record;
  construction loads nothing. `meta.coreIdentityInit`: `pending` →
  `initialize()` validates with the preflight (the Founder's legacy-minor rule
  included) and writes every row and link with the state change in one
  transaction, or writes nothing and stays `pending` for a retry; `done` →
  `attach()` loads and never imports (a stale array is reported and ignored;
  an intentionally empty domain stays empty).
- **Writes.** `players.insert/update/restore/remove/ageUp`,
  `guardians.insert/update`, `link/unlink` — each in a transaction of its own,
  refused inside a foreign transaction, joined inside the store's unit of work.
  A minor is created with its primary guardian and the link in the same
  transaction, never without. `guardian_id` and the `primary` link row always
  agree; a second primary, a dangling or duplicate link and a duplicate e-mail
  (case-insensitive) are refused. `ageUp` clears the primary link only
  (co-guardians keep listing the child, as today); `remove` is today's hard
  delete (links cascade, every `childIds` entry goes); `restore` is the signing
  rollback's whole-record write and cannot change the link. None of this is a
  deletion or retention policy.
- **Views.** `db.players` / `db.guardians` shapes, read-only; a record view
  refuses column-backed writes (nested `location`, `stats`, `notificationPrefs`,
  `medical.shared`, `medical.conditionStatus`, `programme.track`,
  `programme.startedAt`) and `childIds`; `medical.records`,
  `programme.completed`, `emailCode`, unknown and prototype-named keys stay
  mutable facets, flushed inside every save and counted as persisted only
  once it committed (the intermediate-then-revert case is covered).
- **Unit of work.** One participant for both domains: `flush/commit/rollback`
  and `snapshotState/restoreState` over records, views, indexes, link arrays
  and facet tracking; failures after the row and link writes, during the
  flush, at COMMIT, nested-and-swallowed and a process killed before COMMIT all
  leave the tables and memory as before, with edits that predated the unit
  still pending.

The design and the cutover order are in `docs/architecture/sqlite-schema.md`
and `docs/architecture/sqlite-migration-plan.md`.

## Reverse proxy and client addresses
Per-IP controls (the `/auth` brute-force limiter, sharing-link limits, request
logs) key on the client address. Behind a platform proxy (Fly, Render, a load
balancer) the server must be told how many hops to trust, or every client shares
the proxy's address and the 40-requests-a-minute login limit becomes global:

- `SCOUTBOX_TRUST_PROXY` — unset / `0` trusts nothing (direct deployments and
  development); `1` (or `2`, …) trusts that many hops; `loopback, 10.0.0.0/8`
  trusts listed addresses/subnets; `true` trusts every hop (only safe when the
  proxy strips the inbound `X-Forwarded-For`). `GET /capabilities` reports the
  resulting state under `proxy_trust`; an unparseable value refuses to boot in
  production (`TRUST_PROXY_INVALID`).

## Staff accounts and roles
Roles are assigned by the organisation, never by the person logging in. On an
organisation that holds credentials (password set at registration or provisioned
by Trust & Safety) a login finds an existing staff account and answers with its
stored role; a name with no account is refused (`STAFF_NOT_PROVISIONED`) and must
be invited by a lead (`POST /org/invites`). The one exception is the first login
on a credentialed organisation that has no staff yet, which bootstraps the
administrator account in the lead tier (recorded as `staff_bootstrapped`).
Unprovisioned seeded organisations keep the development shortcut, which is
refused outside development. The lead tier is `isLeadRole` in `roles.mjs`.

## Structured logs & correlation
Every request logs one JSON line `{t,id,m,p,s,ms}` — correlation id (accepts
inbound `X-Request-Id`, echoes it back), method, path, status, duration.
Tokens, auth headers, bodies and emails are never logged.

## Health & metrics
- `GET /healthz` — liveness. `GET /readyz` — snapshot store writable + data loaded.
- `GET /admin/metrics` — request counters, failed uploads, delivery/webhook
  failures and backlogs, recent ops events. Counters are per-process since
  boot; they are local development metrics, not an SLA measurement.
- `POST /admin/delivery/inject-failure` — inject provider failures to verify
  monitoring + retry behaviour (used by `scripts/m13E2E.mjs`).

## Backups
`POST /admin/backup` writes `DATA_DIR/backups/<timestamp>/`:
- `db.json` — full consistent snapshot (same shape the store imports on first boot),
- `media/` — media files,
- `manifest.json` — SHA-256 checksums, sizes, counts, restore instructions.
`POST /admin/backup/verify {dir}` re-checksums a backup.
Backups contain no environment secrets, but they contain personal data —
store them with the same care as the live data directory.

## Restore (never over a live directory)
1. Copy the backup directory to a **new, empty** location.
2. Start the server with `DATA_DIR=<that location>` — the store imports
   `db.json` on first boot and renames it `db.json.migrated`.
3. Smoke-check `/readyz`, a login, and a representative read.
`scripts/m13E2E.mjs` performs exactly this cycle (backup → verify → copy →
boot second server → login + player list) on every run.

## Load — measured result (2026-09-09)
`node scripts/m13Load.mjs` — bounded, isolated, agreed-in-code limits:
- environment: local container, single node process, throwaway seeded DB (14 players, 5 orgs)
- 600 requests, concurrency 12, mixed read-heavy workload with writes
- wall 0.4 s · ~1392 req/s · latency p50 7 ms · p90 14 ms · p99 31 ms · max 39 ms · 0 errors
This demonstrates the request path holds under modest local concurrency. It
is **not** a capacity claim, an SLA, or a statement about production hardware
or real dataset sizes.

## Jobs & durability
All background work (webhook deliveries, delivery-centre dispatches,
follow-ups, transition expiry, review reminders) is persisted state swept by
interval timers with bounded retries — `scripts/m13E2E.mjs` proves a SIGKILL
mid-queue loses nothing.
