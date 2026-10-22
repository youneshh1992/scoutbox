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
below), organisations (`orgs`, migration `0004`, see "Organisations" below)
and players, guardians and their links (`players`, `guardians`,
`guardian_children`, migration `0005`, see "Players and guardians" below; the
media-removal queue `media_deletions` arrives with migration `0006`), and the
later steps each with their section below, up to the recruitment requests and
accepted trials (`requests`, `trials` → sixteen tables, migration `0015`,
S8a-core, see "Recruitment requests and accepted trials" below). A first
boot after a move imports the old blob into the table and retires the blob. Tools that read or write the file as one snapshot
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

The S1 *shadow* projection (the four identity tables rewritten from the
snapshot inside every save when `SCOUTBOX_SHADOW_VALIDATION=1` was set) is
retired since S4a: every core identity table is live, so there is nothing left
to project or to validate. The switch, `scripts/validateShadow.mjs`,
`dataLayer.shadow` and `capabilities.shadow_validation` no longer exist;
`capabilities.core_identity_storage` reports `state: 'live'` instead.

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
  `broadcast()`. The push and the `notify` live event of a notification are
  effects of the notification's own write (`notifications.afterDurable`): the
  repository runs them, through `afterCommit`, only once the save that carried
  the row committed — a unit's commit, a `persistNow()` or the debounced save —
  and keeps them queued through a failed save for the retry. A side effect
  never fails the operation: a synchronous throw or a rejected returned promise
  is counted in `store.unitOfWorkState()` and logged, later callbacks still
  run, and the data stays committed. Outside a unit, `afterCommit` runs the
  function at once, observed the same way.
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

### Players and guardians (live since migration `0005`, S4a)

Players, guardians and the guardian–child links are rows of the `players`,
`guardians` and `guardian_children` tables, owned by `repositories/identity.mjs`
and attached by the data layer at boot between the organisations and the
staff (guardians load before players: the foreign key). The scalar fields and
the split composites (`location`, `stats`, `medical.shared` /
`medical.conditionStatus`, `notificationPrefs`, `programme.track` /
`programme.startedAt`) are columns written the moment a route changes them;
`childIds` is derived from the link rows (`guardian_id` and the `primary` row
always agree); the nested arrays that wait for S5 (`media`, `attendance`,
`timeline`, `badges`, `seasonHistory`, `drills`, `drillResults`, `activityLog`,
`externalIds`, `trialReports`), `medical.records`, `programme.completed`, the
guardian's `coGuardians`, its outstanding `emailCode` (plain, once, not hashed:
readiness review §8.2) and any unknown field travel in the row's `facets_json`
with the record's shape, mutated in place on the records `db.players` /
`db.guardians` serve and flushed inside every save. `GET /capabilities` shows
the two domains under `dataLayer.domains.players` / `.guardians` (`mode:
'live'`, row and link counts), the initialisation state under
`dataLayer.identity.initState` and the removal queue under
`dataLayer.mediaDeletions.queued`. **Registration in source is development
work, not authorization for a real-data cutover**: the operator procedure at
the end of this section is the gate.

- **S4a cutover (first boot of this build on an older file).** Migration
  `0005_core_identity_live` runs inside the runner's one transaction with
  foreign keys off: it reads the `players` and `guardians` blobs (never the S1
  shadow rows, which are discarded unread and counted), validates every record
  and relationship with the reviewed preflight (duplicate ids, duplicate
  guardian e-mails compared case-insensitively, dangling references, the two
  sides of every link, invalid dates and values, age at the migration instant,
  **the Founder's rule: a legacy minor with no guardian link at all stops the
  cutover**), replaces the three shadow definitions with the live ones,
  imports every row and link, records `meta.coreIdentityCutover` (counts and
  findings only) and `meta.coreIdentityInit`, retires the two blobs and leaves
  sessions, staff, organisations and every other blob untouched. Migration
  `0006_media_deletions` then creates the empty removal queue. Any refusal
  stops the boot with `CORE_IDENTITY_CUTOVER_BLOCKED` listing ids and reasons
  (never a record, an e-mail, a hash or a code); the file is byte-identical,
  the previous build still runs it, and the next boot refuses the same way
  until the data is resolved by hand on the previous build. A saved snapshot
  whose `players` collection is not an array is `SNAPSHOT_INVALID` (the boot
  stops; nothing is seeded over it). A failure anywhere — mid-insert, at
  COMMIT, the process killed — leaves the pre-migration file and the next boot
  simply cuts over.
- **First installation and the initialisation state.** `meta.coreIdentityInit`
  works as `meta.orgsInit`: the migration writes `done` when it imported the
  blobs (even empty ones) or found any saved snapshot, and `pending` only for a
  database nothing was ever saved to. Only while `pending` does the next boot
  import the in-memory records (the seed on a demo boot) — once, validated by
  the same preflight, inside one transaction with the change to `done`; a boot
  that dies during initialisation leaves it `pending` and the next boot does it
  again. On every other boot the tables are authoritative **even when they are
  empty**: the seed, a superseded blob copy or a stale `players` / `guardians`
  blob somebody wrote back into `collections` is never imported (the log says
  how many records were ignored; the next save deletes the stale blob). A
  cut-over file carries no identity blob, and the boot log says `players
  table-backed` instead of a count in the blob.
- **What changed for the routes.** Column-backed fields are written through
  `players.update` / `guardians.update` (sign-up, child creation, e-mail
  verification, ID verification, the disclaimer, availability, contract
  status, medical consent, location, stats, programme, first-team seeker,
  notification preferences, Academy+, the password rehash on login, the
  football category in m12, the audited level review in m13, the signing
  completion in m29) and persist at once; a value the schema refuses (a
  `foot` outside `left`/`right`, a `position` outside the list, an unreadable
  date) is refused at the door with `400 PLAYER_INVALID` /
  `400 GUARDIAN_INVALID` naming the field — before S4a such a value was stored
  as given. Operations that write a row **and** a blob run inside one unit of
  work (see "Units of work"): player and guardian sign-up with their session,
  child creation with its link and saved-search notifications, e-mail
  verification (column + the code in the facets), the co-guardian invitation,
  aging-up (`players.ageUp`: the primary link goes on both sides with the
  timeline entry, the ledger row and the notifications), the admin ID review,
  the level review with its ledger entry, the signing completion (package,
  ledger row, signings row, player columns, case lifecycle; a refusal or a
  failure anywhere rolls the whole completion back and issues no invoice —
  the success-fee invoice is issued after COMMIT) and account deletion (the
  row and its links, every session of the person, the media-removal entries
  and the blob tombstones; today's hard delete — O1 is partially decided and
  S4b is not implemented, `docs/architecture/s4-deletion-decision.md` §10). Nothing is
  broadcast or pushed for a rolled-back unit.
- **Responses.** Every player and guardian response is built from an explicit
  allowlist (`views/playerViews.mjs`, readiness review §6): a club never
  receives `dob`, `location`, `password`, `guardianId`, `notificationPrefs`,
  `programme`, `activityLog`, `drillResults`, `externalIds`, attendance GPS
  fixes or another club's trial reports; agencies and unverified clubs stay
  walled from minors; grassroots clubs get their own surface; the guardian's
  own view and the player's own view are unchanged; `GET /admin/guardians`
  and the ID review answer carry neither the password hash nor the e-mail
  code; `GET /org/shortlist` answers 200 after a shortlisted player deleted
  their account.
- **Media removal (migration `0006`).** Deleting a player queues the removal
  of their media files in `media_deletions` **inside the deletion's
  transaction**; the files are removed after COMMIT, and again at every boot
  and once a minute until storage reports each file removed or already
  absent. A removal that fails (a permission or I/O error) keeps its entry
  with the attempt count and the error; while an entry exists `/media/:id`
  answers 404 for that id whatever the session. `dataLayer.mediaDeletions.queued`
  on `/capabilities` is the number of pending removals; `queued: 0` is the
  normal state. **Backups carry the intent, never the file:** `POST /admin/backup`
  exports the queue with the snapshot (`db.json` → `mediaDeletions`, the rows in
  their stored form) and leaves every queued file OUT of `media/` (the
  manifest's `media.queuedForRemoval` counts them). A restored server imports
  the queue (migration `0006` reads the `mediaDeletions` collection of a
  restored `db.json`; a snapshot tool writes it through the table), serves
  nothing for those ids, clears each entry once the file is confirmed absent,
  and removes at boot a file an operator copied back by hand. A backup from a
  build without the queue restores as before. A tampered entry — anything that
  is not a media id (`[a-z0-9-]+`, so never a path), an unknown field, a bad
  time, a duplicate — refuses the whole restore: the migration aborts, the
  blob stays, the next boot refuses the same way, and nothing is removed on
  the strength of the file. **The ownership invariant: a file referenced by
  ANY live player is never deleted by this queue.** A queue entry's own
  `player_id` proves nothing; the authority is the identity records (every
  `media[].id` a live player carries, read through the mapping) plus the
  records the server holds in memory. The invariant is checked wherever queue
  rows become authoritative and at every sweep: a restored `db.json` whose
  queue names a live player's clip refuses the restore
  (`MEDIA_QUEUE_OWNERSHIP_CONFLICT`, naming the media id and the owner ids —
  the store had already imported the file as blobs and renamed it
  `db.json.migrated`, as for every restore; the migration rolled back, the
  blob stays, no file was touched, the next boot refuses again); a snapshot
  tool's write whose FINAL state has such a conflict — the queue written
  against the retained players, the players written against the retained
  queue, or both — is rolled back whole, unrelated changes included; an entry
  already stored in a live directory is retained at boot and at every sweep
  with the diagnostic in `last_error`, the file and the live reference
  survive, `/capabilities` → `dataLayer.mediaDeletions.conflicts` counts it,
  `/media/:id` keeps answering 404 for the disputed id (quarantine, never
  deletion), and `POST /admin/backup` answers `409 MEDIA_QUEUE_OWNERSHIP_CONFLICT`
  instead of leaving the clip out as if it had been backed up. Resolution is by
  hand: remove the queue entry if the clip is the player's, or remove the
  player's reference if the clip really belongs to a removed owner; a
  conflicting entry becomes a legitimate removal only once no live player
  references it. Legitimate pending removals, already-absent files, failed
  attempts and the rollback refusal are unchanged.
- **Rollback to the previous build (S3).** Do not restore a pre-cutover backup
  (it would discard every later write). Run
  `node scripts/coreIdentityRollback.mjs <data-dir> <out-dir> [--json]`
  (`npm run rollback:core-identity -- …`, server stopped): it opens the source
  read-only and copies it with `VACUUM INTO` (a change still in an active WAL is
  carried; the source is never modified — the read-only open may leave an
  empty `-wal` and a `-shm` file next to it, housekeeping removed by the next
  ordinary open-and-close), rebuilds the `players` and `guardians` blobs on the
  copy from the live rows through the one mapping (post-S4 inserts, updates,
  link changes and removals included; a removed player is not resurrected;
  `childIds` in link order; the outstanding `emailCode` plain so it still
  verifies on the previous build), restores the S1 shadow definitions empty,
  removes the `0005` and `0006` records, the `media_deletions` table and the
  two S4 meta keys, advances `saveSeq`, checks foreign keys, VACUUMs and
  revalidates the copy. Sessions, staff, organisations and every other blob
  are left exactly as they are: nobody signs in again. Exit codes: 0 done;
  1 usage, no source, or an output directory that is not empty; 4 a later
  schema step this tool does not know (no partial downgrade); 5 never cut
  over; 6 the first installation's initialisation has not completed (boot
  this build once so it completes, or start the previous build on a fresh
  directory); 7 a malformed initialisation marker (refused, never guessed);
  **8 media files are still queued for removal** (boot this build once so the
  queue drains — a previous build would serve those files again). Every
  refusal leaves no output. Verified against the real previous build
  (detached worktree at `c1d868e`, synthetic data, log in the handoff): the
  copy boots there, serves the post-cutover state, accepts the sessions
  minted on this build, verifies the outstanding e-mail code and persists new
  writes; this build re-upgrades the copy with everything kept. To go back
  further than S3, run `scripts/orgsRollback.mjs` and then
  `scripts/sessionsRollback.mjs` on the result: each tool undoes its own step.
- **Snapshot tools and backups.** In snapshot mode (`openStore(dir)` without
  options) `db.players` and `db.guardians` are read from the tables once the
  cutover record exists — columns and facets merged back into the record
  shape, `childIds` from the links — and written back as rows **as one
  coupled operation**: a snapshot that carries one of the two collections must
  carry the other (the links derive from both); a malformed collection, an
  invalid record, a dangling or disagreeing relationship, or a legacy minor
  without a guardian link rejects the whole save (nothing written, sessions
  and every other collection untouched); a snapshot that carries neither
  leaves the tables alone; explicit empty arrays empty them on purpose. The
  write is a **rewrite** of the three tables from the validated snapshot, so
  it never depends on what the tables held or on the order the collections
  list their records: a replacement guardian may reuse the e-mail of the one
  it replaces, two retained guardians may swap e-mails, a co-guardian may be
  listed before its primary; only the FINAL state is judged. Before the
  record (an S3 file, or a rollback copy) the tool reads and writes the legacy
  blobs and leaves the tables alone. `POST /admin/backup` exports the same
  shape (`db.json` with the two arrays; sessions as hashes; the media-removal
  queue as `mediaDeletions`, see above); restoring it into an empty directory
  imports it as blobs and the first boot cuts them over, so every player,
  guardian, link, outstanding code, session hash and pending removal comes
  back (`scripts/testCoreIdentityServer.mjs` performs the cycle).
- **Still not in S4a.** No deletion-policy change (O1 is the Founder's
  decision; S4b), no guardian deletion route, no hashing of the e-mail code
  (S6), no `player_*` sub-record tables (S5), no change to who may see what
  beyond the privacy fixes listed above.
- **Tests.** `scripts/testIdentityRepositories.mjs` (the repositories on the
  real data layer and the real unit of work, failure injections, a process
  killed before COMMIT), `scripts/testCoreIdentityMigration.mjs` (the
  migration through the real runner: every database kind, every refusal,
  injected failures, a process killed at COMMIT, the integrated boot),
  `scripts/testCoreIdentityRollback.mjs` (the tool, the round trip, the WAL,
  every refusal, the CLI), `scripts/testMediaDeletions.mjs` (the queue, the
  storage adapter, transaction coupling, the rollback refusal),
  `scripts/testCoreSchema.mjs` (the coupled snapshot dispatcher, the rewrite's
  order independence, failures mid-rewrite and of the real COMMIT),
  `scripts/testCoreIdentityServer.mjs` (the real server on temporary
  directories: every boot case restarted, the writers it names through their
  routes and after a restart, the allowlists on the wire, deletion and the
  media queue, backup and restore, a backup taken while a removal is pending),
  `scripts/testWriterAtomicity.mjs` (the coupled writers — a column together
  with a facet, a blob, an audit entry or another domain — through the real
  server: a second connection right after the response, a SIGKILL, a named
  failure after the first row write and a failure of the REAL SQLite COMMIT,
  each answered 500 with nothing kept, and the retry) — all part of `npm test`.

#### Operator procedure for the S4a cutover (not run on real data by this work)

1. **Preflight, on a copy.** With the previous build still serving, copy the
   data directory and run `node scripts/preflightCoreIdentity.mjs <copy>`
   (`npm run preflight:core-identity -- <copy>`): it validates the two blobs
   and every relationship **without writing anything** and exits 0 only for
   `complete`. Resolve every listed id on the previous build (a duplicate
   e-mail, a dangling reference, a legacy minor without a guardian link) and
   repeat until it is `complete`. A `complete` report is not an approval; it
   says the data fits.
2. **Backup.** `POST /admin/backup` on the previous build, verify it with
   `POST /admin/backup/verify`, and keep it: the rollback tool below is the
   way back for writes made after the cutover, the backup is the way back if
   the file itself is lost.
3. **Dry run.** Stop nothing yet: boot this build with `DATA_DIR=<copy>` on a
   spare port and read the log. `players table-backed` on the second boot,
   `dataLayer.identity.initState: 'done'` and the expected row counts on
   `/capabilities`, a login of each kind and a representative read. A
   `CORE_IDENTITY_CUTOVER_BLOCKED` line means step 1 was skipped or the data
   changed since: resolve, repeat.
4. **Cutover.** Stop the previous build, start this build on the real
   directory, read the same log lines, keep the previous build's files until
   the next backup has been taken on this build.
5. **Rollback, if needed.** Stop this build; run
   `node scripts/coreIdentityRollback.mjs <data-dir> <fresh-empty-dir>`; exit
   8 means the media queue is not empty (boot this build once more so it
   drains); start the previous build on the output directory; every session
   stays valid and every write made on this build is in the blobs. Since S5
   the tool refuses a database carrying `0007_player_subrecords` (exit 4,
   `LATER_SCHEMA`): run the S5 rollback first (next section) and point this
   tool at its output.

### Player sub-records (live since migration `0007`, S5)

The eleven arrays a player record carries — `media` (with its `tags`),
`attendance`, `timeline`, `badges`, `drills`, `drillResults`, `activityLog`,
`externalIds`, `seasonHistory`, `medical.records`, `programme.completed` —
are rows of the twelve `player_*` tables (`repositories/playerSubrecords.mjs`
holds the mapping, the validator and the DDL; `repositories/identity.mjs`
owns the rows; the implementation note is
`docs/architecture/s5-player-subrecords.md`). Every table carries `position`
(the array index), so each array reads back in its order and a duplicate the
code allows (a client-set badge twice, two activities in one millisecond, a
session completed twice) survives; a row without a client-visible id is keyed
by `(player_id, position)` and **no identifier is minted**. Unknown item
fields and an item's shape (key order, explicit nulls) ride in the row's
`extra_json`, so a record reads back byte for byte. The record the server
serves keeps every array in place, read-only, items included: a write that
bypasses the repository throws. The writers are `players.addItem(id, key,
item)`, `players.setItems(id, key, items)` and `players.patchItem(id, key,
where, patch)` (`key` is the array's name, `medical.records` and
`programme.completed` included); each validates the whole array first (types,
required fields, the natural keys the code enforces: one season, one drill,
one provider+external id per player, one tag per clip, every item id), runs
its statements and only then its memory bookkeeping — outside a unit in a
transaction of its own, inside a unit through the store's participant API —
so a refusal changes nothing and a failed COMMIT leaves memory as it was.
Routes that write a child row together with a blob, an audit row or a column
run in one unit of work (the media upload, attendance, the trial check-in, the
match day, drills, the programme, Academy+, stats, the import link, the Box
Cam clip, clip tags, the signing). `players.insert` writes a record's arrays
as rows in its transaction; `players.restore` rewrites them; `players.remove`
cascades them (today's hard delete; the media FILES are queued in the same
unit before the row goes). A fixture or venue the attendance table cannot hold
(not text) is now answered `400 PLAYER_INVALID` instead of being stored.
`players.update(id, { medical: null })` (or `programme: null`) is **refused
while the player has medical records (programme completions)**: a whole-null
composite would hide those rows from every view, the backup and the rollback
copy; the error names the player, the rows, the table and the explicit clearing
operation (`players.setItems(id, 'medical.records', [])`, then null). No route
sends that patch; no deletion policy is implied.

`trialReports` is **not stored**: it is a duplicate of `trials[].report` and
the record serves it as a derived, read-only value in filing order (ascending
`filedAt`) — for every record, whatever shape it was saved with (a legacy
record without the key or with null shows a report the moment one is filed; the
empty-state shape is kept until then); the trial-report route writes the trial
only. A `trialReports` array written WITH a record (a backup restore, a
persistence suite's snapshot, `players.insert`, `players.restore`, the first
installation) is a claim about the trials and must equal them entry for entry
(ids, content, order, no duplicate), else the whole write is refused with the
player and report ids and nothing is written; an absent key or a null is no
claim (the trials stand). `GET /capabilities` reports the rows per table under
`dataLayer.domains.players.subrecords.tables`.

- **S5 cutover (first boot of this build on an S4a file).** Migration
  `0007_player_subrecords` runs inside the runner's one transaction after
  0005 and 0006 (a legacy `db.json` or an S3 file goes through all three in
  the same boot): it creates the twelve tables, decodes every `players` row
  through the established decoder (the current facets layout and the older
  `__rest` one), validates every item of every array, reconciles every
  `trialReports` copy with the `trials` collection, writes the child rows,
  re-reads each player through the new path and compares it with the decoded
  record byte for byte, and only then rewrites `facets_json` without the
  arrays, recording `meta.playerSubrecordsCutover` (counts only). **Any**
  refusal aborts the whole step with `PLAYER_SUBRECORDS_CUTOVER_BLOCKED`
  listing every player id, field, index and reason (never a record): an item a
  column cannot hold (`players pl-x: media[2].title is absent`), a natural
  key an array violates (`seasonHistory[1] repeats season "2024/25"`), a
  `trialReports` entry with no trial report of that id, an entry whose content
  differs from the trial's report, a report the copy does not carry, the same
  reports in a different order, a `trials` collection that is not a JSON
  array. The file is byte-identical, the previous build still runs it, the
  next boot refuses the same way until the record is resolved by hand on the
  previous build (the arrays sit in that row's `facets_json`; the trial
  reports in the `trials` collection). Nothing is coerced, deduplicated,
  dropped or repaired. A first installation creates the tables and imports
  nothing (the seed is initialised afterwards, child rows included); an
  intentionally empty domain stays empty.
- **Backups and restores.** `POST /admin/backup` exports every player with
  its arrays rendered from the child tables and its `trialReports` derived
  from the trials — the same record shape as before S5 — so an older backup
  and a new one restore the same way: the first boot imports `db.json`, cuts
  the identity pair over (0005), imports the media queue (0006) and moves the
  arrays into their tables (0007), reconciling the copies against the `trials`
  blob the same file carries. A restored snapshot whose items the tables
  cannot hold is refused whole (`LEGACY_IMPORT_FAILED` or
  `PLAYER_SUBRECORDS_CUTOVER_BLOCKED`, the file left in place); a whole
  snapshot written into a live S5 file (a persistence tool, `store.save` in
  snapshot mode) whose players carry `trialReports` copies that disagree with
  the trials it carries — or, when it omits `trials`, with the retained ones —
  is refused whole too (`TRIAL_REPORTS_UNRECONCILED`: nothing written, the
  revision not advanced). A backup refuses (as the boot and the rollback do)
  a file whose player row says `medical` or `programme` is null while its
  child rows exist (`INCONSISTENT_ROWS`): resolve it by hand, the rows are
  authoritative. Media
  ownership (the S4a invariant that the removal queue never deletes a file a
  live player references) is judged on `player_media` once 0007 is recorded,
  and on the facets before it, so the 0006 import of the same boot is judged
  correctly.
- **Rollback (copy-only, to the S4a build `480afdb`).** Stop this build; run
  `node scripts/playerSubrecordsRollback.mjs <data-dir> <fresh-empty-dir>`:
  it opens the file read-only, copies it (`VACUUM INTO`), writes every array
  back inside `facets_json` under its own key (the layout the S4a build
  reads) from the rows in their order — post-S5 inserts, updates and
  removals included — rebuilds the `trialReports` copies that build reads
  from the `trials` collection, drops the twelve tables, removes the 0007
  record and `meta.playerSubrecordsCutover`, advances `meta.saveSeq`, checks
  every foreign key, VACUUMs and revalidates the copy (every player's facets
  decode back to the record the rows held, the sessions untouched). Sessions,
  staff, organisations, the media queue (both builds have it) and every other
  collection are exactly as they were; nobody signs in again. Exit codes: 0
  done; 1 usage, no source or a non-empty output directory; 4 the copy carries
  a schema step after 0007 (`LATER_SCHEMA`: a later step needs its own
  rollback first); 5 the copy never applied 0007 (`NOT_CUT_OVER`); 9 the
  `trials` collection cannot be read while a player carries `trialReports`
  (`TRIALS_UNREADABLE`); 10 a recorded 0007 whose tables are missing
  (`UNEXPECTED_SCHEMA`); 11 a player row whose shape says `medical` or
  `programme` is null or absent while its child rows exist
  (`INCONSISTENT_ROWS`: a copy that hid them would not be the record; the
  boot and a backup refuse the same file). A failure at any step removes the
  output. To reach
  the S3 build, run `scripts/coreIdentityRollback.mjs` on this tool's output
  (it refuses the S5 file itself with exit 4). Restoring a pre-S5 backup
  instead of rolling back discards every write made since it.

#### Operator procedure for the S5 cutover (not run on real data by this work)

1. **Dry run on a copy.** With the S4a build still serving, copy the data
   directory and boot this build on it (`DATA_DIR=<copy>` on a spare port):
   the log shows `data migration applied: 0007_player_subrecords` and
   `/capabilities` the rows per table under
   `dataLayer.domains.players.subrecords.tables`; a representative player
   profile, film room and CV read as before. A
   `PLAYER_SUBRECORDS_CUTOVER_BLOCKED` line lists what to resolve on the S4a
   build; repeat until the copy cuts over.
2. **Backup.** `POST /admin/backup` on the S4a build, verify it, keep it.
3. **Cutover.** Stop the S4a build, start this build on the real directory,
   read the same log lines, keep the S4a build's files until the next backup
   has been taken on this build.
4. **Rollback, if needed.** `node scripts/playerSubrecordsRollback.mjs
   <data-dir> <fresh-empty-dir>`, then start the S4a build on the output.

### One-time codes (live since migration `0008`, S6a — accepted at `2d7ddeb` within the reviewed backend development scope; not production-approved)

The club e-mail-domain challenge (`POST /org/verification/email` →
`…/confirm`) and the child pairing code (`POST
/guardian/children/:id/pairing-code` → `POST /auth/player/pair`) are rows of
`email_challenges` and `pairing_codes` (`repositories/oneTimeCodes.mjs`;
`docs/architecture/s6-readiness-review.md` §10). Request and response shapes
are unchanged.

- **Storage.** A row holds only `code_hash`: sha256 hex of the code trimmed and
  upper-cased (the comparison the routes always made). The code is delivered
  in the mail (challenge) or the guardian's mint response (pairing code). What
  the tests prove (`testOneTimeCodesServer.mjs`, a substring search of every
  table and of the whole backup `db.json`): a code issued by this build is not
  in the database file or an admin backup, in either mail transport.
- **The mail outbox withholds the challenge code.** Every mail is recorded in
  `db.outbox`, which is saved and copied into every backup. Before the S6a
  review correction that record held the full text, code included (in both
  transports). The record now keeps the mail with the code replaced by
  `[code withheld — delivered to the recipient only]`; delivery is unchanged:
  with `SENDGRID_API_KEY` set the provider receives the full text; on the dev
  transport (no key — the outbox *is* the delivery) the full text is kept in
  the server process's memory only (the last 500 such mails, never saved) and
  `GET /admin/outbox` shows it there. After a restart the dev outbox shows the
  withheld text — request a fresh challenge. In production the admin outbox no
  longer shows the code. **Outbox records written before this correction keep
  the code they were written with** (the correction does not rewrite mail
  history); such a code is long expired, but a backup holding those records
  still contains it in plain text. Other mails that carry a secret (the
  guardian sign-up code, organisation invitations) are outside S6a and
  unchanged.
- **Hash strength.** A six-character code from a 31-character alphabet has ≈ 2^29.7 values, so
  the hash protects against casual disclosure of a file or a backup, **not**
  against an offline search by someone who holds it; the lifetimes below bound
  that exposure. The guardian sign-up e-mail code is **not** in this step: it
  stays plain in `guardians.facets_json` (hashing it without a resend route
  would strand guardians on a rollback).
- **Lifetimes and replacement.** A challenge lives 30 minutes, a pairing code
  15; expiry is judged on every read (`expires_at > now`), and expired rows
  are swept at boot and before every issue. One live challenge per
  organisation and one live pairing code per child: an issue replaces the
  previous row (and resets the attempt count). A drawn pairing code equal to
  another child's live code is redrawn, never shared.
- **Durable issuance.** The row is committed before the mail is sent / the
  response is written (before S6a a pairing code lived in memory until some
  later save, so a crash lost it).
- **Atomic consumption.** The confirmation consumes the challenge and writes
  the organisation's `emailDomain` / `emailDomainVerified` in ONE unit of work;
  the pairing exchange consumes the code and creates the child's session in
  ONE unit of work. A failure anywhere, the real COMMIT included, keeps the
  code live and changes nothing else; a crash can no longer leave a committed
  session beside a still-live code (before S6a the same code could buy a
  second session after a restart).
- **The repository takes part in the unit of work.** Every one-time-code
  mutation (issue, consumption, the failed-attempt count, revocation, the
  sweep) runs through one boundary: inside an open unit of work it joins the
  unit through the store's participant API, so a failure after a statement
  already ran — a reissue that deleted the old code before its insert failed,
  a tenth wrong attempt counted before its cancellation failed — poisons the
  unit even when the calling code catches the error; the unit refuses to
  commit, its one rollback undoes the statements and restores memory, and an
  explicit retry runs the whole operation again. (Until the review correction
  of `b2a237e` such a caught failure let the enclosing unit commit the
  fragment.) Outside a unit a mutation runs in a transaction of its own; inside
  a raw SQLite transaction a tool or test opened on the connection it runs as
  part of that transaction with no BEGIN of its own, and an open transaction
  is never taken for a unit. Expected negative results — no live code, no
  match, nothing to delete — are return values and never poison a unit.
- **Wrong codes.** A wrong confirmation is counted on the challenge
  (`attempts`, which survives a restart); the tenth cancels it
  (`400 CODE_INVALID` says so; the organisation requests a fresh code). A row
  at the limit is dead to every read — the check, the consumption, the
  outstanding counts — and is swept like an expired row, so it can never be
  redeemed even if one is present. Four
  rate-limit policies (`m181/rateLimit.mjs`, per process like every limiter):
  `email_challenge_request` 5 per organisation per hour (each request sends a
  mail), `email_challenge_confirm` 20 wrong codes per organisation per 15
  minutes, `pairing_code_mint` 20 per guardian per hour, `pairing_attempt` 20
  wrong codes per client address per 15 minutes on top of the `/auth` limiter.
  A correct code costs nothing; once a guessing budget is spent the next
  attempt is refused **before** the code is judged (`429 RATE_LIMITED`), so a
  correct guess after it is not rewarded.
- **Deletion.** Deleting a player revokes the child's pairing code inside the
  deletion's unit of work, before the player row goes. `pairing_codes` has no
  foreign key to `players` on purpose (the identity snapshot rewrite deletes
  and reinserts every player row, so a cascade would erase every code on a
  save that omits the collection); instead every snapshot write refuses a code
  whose player is not in the table (`PAIRING_CODE_PLAYER_MISSING`).
- **S6a cutover (first boot of this build on an S5 file).** Migration
  `0008_one_time_codes` creates the two tables and imports the
  `emailChallenges` / `pairingCodes` blobs if the file holds them, in either
  snapshot format: the **legacy** shape every earlier build wrote (`code`,
  plain — hashed on the way in) or the **stored** shape a backup taken after
  S6a holds (`codeHash`, `attempts`). An entry already expired is not imported
  and is counted (`meta.oneTimeCodesCutover`, logged at boot). Anything else
  the migration cannot represent exactly — both or neither of `code` /
  `codeHash`, an unknown field, a malformed hash or expiry, a stored-format
  challenge without `attempts` or with a count that is not an integer from 0
  to 9 (10 is the limit: an exhausted challenge is cancelled, never imported),
  a missing owner, a second entry for one organisation or child, two pairing
  entries with one code, a blob that is not a JSON array, a live entry whose
  organisation or player does not exist — aborts the step whole with
  `ONE_TIME_CODES_IMPORT_BLOCKED` (entry index and reason, never a code): the
  file is unchanged, the previous build still runs it, the next boot refuses
  the same way. Nothing is coerced or dropped silently. A file without the
  blobs (a pairing code was rarely saved before S6a) imports nothing. A legacy
  entry carries no count and starts at 0.
- **Backups and restores.** `POST /admin/backup` exports `emailChallenges` and
  `pairingCodes` in their stored form (hashes, attempts); a restore into a new
  directory imports them through the same migration and the outstanding codes
  keep working there until they expire. A backup taken before S6a (plain
  codes) restores the same way, hashed on import — but that backup's own
  files (and the `db.json.migrated` the import leaves beside the new database) still
  hold the plain codes they were taken with; handle them as before. A stored
  challenge keeps its attempt count through backup and restore. A whole snapshot written
  into a live S6a file by a tool is validated entry by entry in either format
  and refused whole on the first problem.
- **Reporting.** `GET /capabilities` shows counts, outstanding counts and the
  lifetimes under `dataLayer.domains.oneTimeCodes` — never a code or a hash.
- **Rollback (copy-only, to the S5 build `2178c5b` / `7fbce74`).** Stop this
  build; run `node scripts/oneTimeCodesRollback.mjs <data-dir>
  <fresh-empty-dir>`: it opens the file read-only, copies it (`VACUUM INTO`),
  writes the `emailChallenges` and `pairingCodes` blobs the S5 build reads
  **empty**, drops the two tables, removes the 0008 record and its meta key,
  advances `meta.saveSeq`, checks every foreign key, VACUUMs and revalidates
  the copy (organisations, players, guardians and sessions exactly those of
  the source). **Every outstanding code is invalidated** — a hash cannot be
  turned back into the code the older build compares — and the tool prints how
  many challenges and pairing codes that was; affected organisations request a
  fresh challenge and affected guardians mint a fresh pairing code. Nothing
  else is lost. Exit codes: 0 done; 1 usage, no source or a non-empty output
  directory; 4 the copy carries a later schema step (`LATER_SCHEMA`); 5 the
  copy never applied 0008 (`NOT_CUT_OVER`); 10 a recorded 0008 whose tables
  are missing (`UNEXPECTED_SCHEMA`). A failure at any step removes the output.
  To go further back, run `scripts/playerSubrecordsRollback.mjs` on this
  tool's output (it refuses the S6a file itself with exit 4).

#### Operator procedure for the S6a cutover (not run on real data by this work)

1. **Dry run on a copy.** With the S5 build still serving, copy the data
   directory and boot this build on it (`DATA_DIR=<copy>` on a spare port):
   the log shows `data migration applied: 0008_one_time_codes` and the import
   counts; an `ONE_TIME_CODES_IMPORT_BLOCKED` line lists what to resolve on the
   S5 build. Codes are short-lived: an outstanding code can also simply be
   left to expire before the cutover.
2. **Backup.** `POST /admin/backup` on the S5 build, verify it, keep it.
3. **Cutover.** Stop the S5 build, start this build on the real directory,
   read the same log lines.
4. **Rollback, if needed.** `node scripts/oneTimeCodesRollback.mjs
   <data-dir> <fresh-empty-dir>`, note the invalidated counts, then start the
   S5 build on the output.

### Notifications and category notification preferences (live since migration `0009`, S7a — independently accepted at `0641b2c` for the bounded migration milestone; not production-approved)

The in-app notification feed (`GET /{player,guardian,org}/notifications`,
`POST …/notifications/read`, `POST …/notifications/:id/ack`) and the category
preferences (`GET`/`PUT …/notification-preferences`) are rows of
`notifications`, `notification_prefs` and `notification_pref_categories`
(`repositories/notifications.mjs`; `docs/architecture/s7-readiness-review.md`
§8.3). Request and response shapes are unchanged.

- **Order.** The feed is reverse insertion order, as it always was: `seq` is
  the durable key. A repeated identical unread notification within six hours
  refreshes the row's clock and repeat count where it is — it does not move.
  Backups, restores and the rollback keep that order.
- **Writes.** In the running server a notification write is visible at once
  and becomes durable inside the next snapshot save — the one that also
  carries the message, request or case it announces (`persistNow()` on a
  message send; the 2-second debounced save otherwise) — or inside the unit
  of work that encloses it. It is never durable ahead of the action it
  announces, and a failed save keeps it queued for the retry. Its push and its
  `notify` event on the live streams and in the replay log are effects of that
  write: they go out only once the save that carried the row committed, never
  after a save that failed (they wait for the retry and go out once with it),
  never for a rolled-back unit. A push provider error after the commit is a
  delivery failure (counted in `store.unitOfWorkState()`), never a rollback.
  A crash between the commit and the effect loses the push or event, as it
  did before S7a. The acknowledgment of an action notice updates the
  notification row and the dispatch rows (their own tables since S7b, below) in
  one unit of work.
- **Preferences.** The route still refuses an unknown category and a literal
  `false` on a mandatory category (`compliance`, `security_account`), and still
  coerces other values (`0` is stored `false`); the effective view and the
  notification gate force a mandatory category on whatever is stored. A
  person's preferences are kept when their account and notifications are
  deleted.
- **Boot.** The data layer attaches to the tables as they are; an in-memory
  `notifications` / `notificationPrefs` array (the seed's empty container,
  the snapshot migrations' defaults, a stale copy) is never imported — the
  blob the migration just imported is dropped silently, anything else is
  logged as a count and dropped. `GET /capabilities` →
  `persistence.dataLayer.domains.notifications` reports row counts, the
  number of staged writes not yet in a committed save and the number of
  effects (pushes, live events) waiting for that save.
- **S7a cutover (first boot of this build on an S6a file).** Migration
  `0009_notifications` creates the three tables and imports the
  `notifications` and `notificationPrefs` blobs: every entry validated and
  nothing coerced; a row written before M18.2 is normalised exactly as the
  snapshot migration `m182_005` normalised it (`repeatCount` 1) and its other
  absent fields default (`read` false, `groupKey`/`category` null,
  `deferredPush` false) — each normalisation is counted in
  `meta.notificationsCutover`; unknown fields are kept (`extra_json`); a stored
  mandatory preference `false` is imported as it is. An entry that is not an
  object, lacks an id, duplicates an id, has a malformed timestamp, audience,
  type, text, flag, count, category or acknowledgment contract, or a
  preference with an unknown field, an unknown category, a non-boolean value
  or a duplicate audience, refuses the WHOLE step
  (`NOTIFICATIONS_IMPORT_BLOCKED`: entry indexes and reasons, never a text),
  the file is untouched, and the next boot refuses the same way until the
  blob is resolved on the previous build. A file without the blobs imports
  nothing. A backup from any build restores through the same migration with
  the feed order intact.
- **Rollback (copy-only).** `npm run rollback:notifications -- <data-dir>
  <fresh-empty-dir>` (`scripts/notificationsRollback.mjs`) opens the file
  read-only, copies it (`VACUUM INTO`), writes every notification and every
  preference record back into the two blobs in insertion order — **nothing
  written after the cutover is lost** — drops the three tables, removes the
  0009 record and its meta key, advances the save revision, checks every
  foreign key, VACUUMs and revalidates the copy. Refusals, no output: a later
  schema step (exit 4), a file that never applied 0009 (exit 5), a non-empty
  output directory (exit 1), a recorded 0009 whose tables are missing (exit
  10). Proven by booting the copy on the actual pre-S7a build (`812e13b`): the
  same feeds and preferences, and that build keeps writing. To go further
  back, run `scripts/oneTimeCodesRollback.mjs` on this tool's output (it
  refuses the S7a file itself with exit 4).

#### Operator procedure for the S7a cutover (not run on real data by this work)

1. **Dry run on a copy.** With the S6a build still serving, copy the data
   directory and boot this build on it (`DATA_DIR=<copy>` on a spare port):
   the log shows `data migration applied: 0009_notifications` and the import
   counts; a `NOTIFICATIONS_IMPORT_BLOCKED` line lists what to resolve on the
   S6a build.
2. **Backup.** `POST /admin/backup` on the S6a build, verify it, keep it.
3. **Cutover.** Stop the S6a build, start this build on the real directory,
   read the same log lines.
4. **Rollback, if needed.** `node scripts/notificationsRollback.mjs
   <data-dir> <fresh-empty-dir>`, then start the S6a build on the output —
   every notification written since the cutover is in it.

### Delivery dispatch records and their attempts (live since migration `0010`, S7b — independently accepted at `ac50b60` for the bounded migration milestone; not production-approved)

The delivery centre's dispatch records (`GET /org/delivery`, `GET /admin/delivery`,
`GET /admin/metrics` → `dispatchBacklog`, `POST /admin/delivery/sweep`,
`POST /callbacks/delivery`, the acknowledgment routes) are rows of `dispatches`
and `dispatch_attempts` (`repositories/dispatches.mjs`;
`docs/architecture/s7-readiness-review.md` §9). Request and response shapes
are unchanged: a dispatch is still the eighteen-key record every build since
M13 wrote, with its attempts nested, and the admin and org views list the same
rows in the same order.

- **Order and keys.** `seq` is the insertion order every reader depends on
  (the admin view lists the newest first; a provider callback matches the
  FIRST row in insertion order whose `providerMessageId` strictly equals the
  event's — an explicit `null` matches the first row without one, an omitted id
  matches nothing but is still remembered as seen; duplicates are legal, no
  uniqueness is declared). An attempt is keyed by its dispatch and its position
  (no id is minted, no counter consumed); a send row is `{at, ok, error}`, a
  quiet-hours re-check note is `{at, note}` and is never counted as a send — in
  SQL a send row's `ok` can never be NULL (the shape CHECK is total).
- **The notification reference.** `notification_id` is an indexed reference
  with **no foreign key and no cascade**: an ordinary account deletion removes a
  person's notification rows and leaves their dispatch rows exactly as every
  build since M13 did; the migration imports such orphans unchanged and counts
  them (`orphanReferences` in `meta.dispatchesCutover`). Nothing prunes,
  re-parents or blocks on them. Retention remains an open decision.
- **Timestamps.** Every clock the server writes itself (`createdAt`, `nextAt`,
  `actionDeadline`, `actionedAt`, `failedAt`, an attempt's `at`) is an integer
  in an INTEGER column. `deliveredAt` and `openedAt` come from the provider
  callback (`Number(ev.at) || Date.now()`, a finite number that may be
  fractional) and are REAL columns: the value is stored exactly as the route
  wrote it, integer-valued or fractional, never rounded. A non-finite callback
  clock (`"Infinity"` in the event) behaves exactly as before S7b: it is kept in
  memory for the life of the process, so no later event can replace it, while
  the column stores `null` (what the JSON save of the previous build persisted)
  and a restart reads `null`. The callback API is unchanged.
- **Writes.** In the running server a sweep pass's new rows, attempts and
  status changes are visible at once and durable inside the same snapshot save
  (`persistNow()`) as the outbox row the local fake provider accepted, the
  failure-injection counter it decremented and — on exhausted retries — the
  `delivery_failed` ops event and the webhook delivery row; a save that fails
  at its COMMIT leaves none of them durable and keeps them queued for the next
  save, which lands them once (memory is the intended state, as for every blob
  collection; a pass that changes nothing requests no save). An
  acknowledgment's status changes land in the same unit of work as the
  notification's contract — both or neither (a terminal `skipped` row keeps its
  status and gains `actionedAt`). Callback changes land with the
  `deliveryCallbacksSeen` bookkeeping. `failReason` is stored untruncated at
  storage (the callback route still truncates its own input to 120 characters).
  Every refusal of a repository write — an invalid argument, a missing row — is
  a participant failure: inside a unit of work it rolls the whole unit back even
  when the caller catches it. Unknown fields a legacy row carries are kept and
  detached: nothing a caller does to its input or to an export changes the
  records; a value JSON cannot carry refuses the write by name.
- **Boot.** The data layer attaches to the tables as they are; an in-memory
  `dispatches` array (`migrateM13`'s empty container, a stale copy) is never
  imported — the blob the migration just imported is dropped silently, anything
  else is logged as a count and dropped. `GET /capabilities` →
  `persistence.dataLayer.domains.dispatches` reports row counts by status, the
  backlog and the number of staged writes not yet in a committed save.
- **S7b cutover (first boot of this build on an S7a file).** Migration
  `0010_dispatches` creates the two tables and imports the `dispatches` blob:
  every entry validated and nothing coerced or normalised — all eighteen keys
  must be present (every build wrote them), timestamps of the right kind, both
  attempt shapes exactly, unknown top-level fields kept (`extra_json`), unknown
  attempt fields refused; a finite fractional callback clock is imported
  exactly; orphan references are imported and counted. An entry that fails any
  check refuses the WHOLE step (`DISPATCHES_IMPORT_BLOCKED`: entry indexes and
  reasons, never an address or a provider text), the blob and `saveSeq` are
  untouched, and the next boot refuses the same way until the blob is resolved
  on the previous build. A file without the blob imports nothing. A backup from
  any build restores through the same migration with the order intact; a
  snapshot that omits the collection leaves the tables alone, an explicit empty
  array clears them, a malformed collection rolls the whole write back.
- **Rollback (copy-only).** `npm run rollback:dispatches -- <data-dir>
  <fresh-empty-dir>` (`scripts/dispatchesRollback.mjs`) opens the file
  read-only, copies it (`VACUUM INTO`), writes every dispatch back into the
  `dispatches` blob in insertion order with its attempts nested in their
  positions and shapes — **nothing written after the cutover is lost** — drops
  the two tables, removes the 0010 record and its meta key, advances the save
  revision, checks every foreign key, VACUUMs and revalidates the copy (the
  S7a tables are untouched). Refusals, no output: a later schema step (exit 4),
  a file that never applied 0010 (exit 5), a non-empty output directory (exit
  1), a recorded 0010 whose tables are missing (exit 10). Proven by booting the
  copy on the actual pre-S7b build (`0641b2c`): the same rows, statuses and
  attempt arrays in the admin view, and that build keeps writing. To go further
  back, run `scripts/notificationsRollback.mjs` on this tool's output (it
  refuses the S7b file itself with exit 4).

#### Operator procedure for the S7b cutover (not run on real data by this work)

1. **Dry run on a copy.** With the S7a build still serving, copy the data
   directory and boot this build on it (`DATA_DIR=<copy>` on a spare port):
   the log shows `data migration applied: 0010_dispatches` and the import
   counts (dispatch records, attempts, unknown-field rows, orphan references);
   a `DISPATCHES_IMPORT_BLOCKED` line lists what to resolve on the S7a build.
2. **Backup.** `POST /admin/backup` on the S7a build, verify it, keep it.
3. **Cutover.** Stop the S7a build, start this build on the real directory,
   read the same log lines.
4. **Rollback, if needed.** `node scripts/dispatchesRollback.mjs
   <data-dir> <fresh-empty-dir>`, then start the S7a build (`0641b2c`) on the
   output — every dispatch and attempt written since the cutover is in it.

### The mail outbox, the push log and the device push tokens (live since migration `0011`, S7c — independently accepted at `9119187` for its bounded storage-migration scope; not production-approved)

`/admin/outbox`, `/admin/push-log`, `/admin/overview` and `POST /push/register`
answer exactly as before; the records behind them are rows of `outbox`,
`push_log` and `push_tokens` (`repositories/outboxPush.mjs`;
`docs/architecture/s7-readiness-review.md` §10 as corrected by the independent
review of `6ca66ba`). The mailer, the delivery centre's local fake provider,
the push sender and the registration route are the only writers.

- **Order and keys.** `seq` is the insertion order every reader depends on
  (the admin views list newest first). An outbox row is one of two literals,
  told apart structurally and never by a value: the mailer record
  `{id, ts, to, subject, text, transport, delivered}` or the delivery record
  `{id, at, channel, to, text, providerMessageId, provider}`; in SQL `source`
  says which, and a total CHECK ties each source to its columns, so NULL always
  means "that key is absent in this shape". `to_address` may be NULL: an
  accepted queued dispatch without a destination is swept into a delivery record
  with `to: null`, as every build since M13 did. A destination that is not a
  string is kept too (review of `40aa05c`, F2): `POST /org/invites` and the m14
  player invite validate the address with a coercing check and hand the mailer
  the ORIGINAL value, so an ARRAY reaches the mailer and the accepted build
  persisted it — a string lives in `to_address`, any other JSON value is encoded
  in `to_json` and decoded on read, so the admin view, the backup, the restore
  and the rollback hand back the same array; a non-finite number inside such
  an array (raw JSON `[1e400,"…"]` parses to `Infinity`; review of `78c14b9`)
  is kept live for this process and persisted as `null` in that position,
  exactly as the blob's JSON did. A token is ANY JSON value the
  route accepted (a number, a string, a boolean, an object, an array), stored
  losslessly as JSON text and handed back with the type it was registered with
  (the push sender sends Expo the same value); the route's rule is unchanged — a
  repeated primitive replaces its earlier row and goes last, an object or an
  array is always a new row — and there is no uniqueness constraint. A
  non-finite number JSON syntax can produce (`1e400` parses to `Infinity`;
  review of `40aa05c`, F1) is kept as the live value for this process — a
  repeated `+Infinity` collapses, `-Infinity` is another row — and persists as
  `null`, exactly as the blob's JSON did; after a restart it reads `null`, and a
  new live `Infinity` removes none of the persisted nulls (a replacement deletes
  by row, never by JSON text). Vocabularies
  (`transport`, `provider`, `channel`, the audience kind, the session kind) are
  open.
- **Writes.** A mail's row is written before the provider is called and lands in
  the save its route always used (an invite with its invite row, a sign-up with
  the debounced save); on the live transport the provider's answer updates the
  row afterwards. The club e-mail challenge still persists the withheld text; the
  admin view serves the full text from this process's memory until a restart.
  The sweep's delivery record lands in the same save as the dispatch rows of the
  pass. A push row is written by the notification's after-durable effect AFTER
  the save carrying the notification committed — it is never in that save; the
  sender's `nextId()` schedules the ordinary debounced save (about two seconds,
  best effort), so the row lands with that save or an earlier one. A crash in
  that window loses the push row (the push was already handed to the transport;
  nothing is re-sent). A failed ordinary save keeps every pending row for the
  next save, which lands it once; an aborted unit of work restores the state
  from before the unit. Nothing here changes what a route answers.
- **Boot.** The data layer attaches to the tables as they are; an in-memory
  `outbox` / `pushLog` / `pushTokens` array (the seed's empty containers, a
  stale copy) is never imported — the blob the migration just imported is
  dropped silently, anything else is logged as a count and dropped.
  `GET /capabilities` → `persistence.dataLayer.domains.outboxPush` reports the
  three row counts and the number of staged writes not yet in a committed save.
- **S7c cutover (first boot of this build on an S7b file).** Migration
  `0011_outbox_push` creates the three tables and imports the `outbox`,
  `pushLog` and `pushTokens` blobs: every entry validated and nothing coerced —
  an outbox entry must be exactly one of the two literals (all of its keys,
  none of the other's), a push entry the sender's literal with an audience of
  kind and id only, a token entry the route's literal with any JSON token;
  unknown fields kept (`extra_json`); duplicates of a token are legal. An entry
  that fails any check refuses the WHOLE step (`OUTBOX_PUSH_IMPORT_BLOCKED`:
  collection, entry positions and reasons, never an address, a text, a token or
  a code), the blobs and `saveSeq` are untouched, and the next boot refuses the
  same way until the blob is resolved on the previous build. A file without a
  blob imports nothing for it. A backup from any build restores through the same
  migration with the order intact; a snapshot that omits a collection leaves its
  table alone, an explicit empty array clears it, a malformed collection rolls
  the whole write back.
- **Rollback (copy-only).** `npm run rollback:outbox-push -- <data-dir>
  <fresh-empty-dir>` (`scripts/outboxPushRollback.mjs`) opens the file
  read-only, copies it (`VACUUM INTO`), writes every row back into the three
  blobs in insertion order — each outbox row in its own literal with exactly its
  keys, each token with its registered type — **nothing written after the
  cutover is lost** — drops the three tables, removes the 0011 record and its
  meta key, advances the save revision, checks every foreign key, VACUUMs and
  revalidates the copy (every other table untouched). Refusals, no output: a
  later schema step (exit 4), a file that never applied 0011 (exit 5), a
  non-empty output directory (exit 1), a recorded 0011 whose tables are missing
  (exit 10). Proven by booting the copy on the actual pre-S7c build (`6ca66ba`):
  the same outbox and push-log records in the admin views, and that build keeps
  writing (a token registered, a mail sent, an array destination) to its blobs;
  this build then re-upgrades the copy with every row. To go further back, run
  `scripts/dispatchesRollback.mjs` on this tool's output (it refuses the S7c
  file itself with exit 4).
- **Scratch databases created by the unaccepted `40aa05c` build.** Its `outbox`
  table has no `to_json` column (the 0011 record is present). This build refuses
  to attach to such a file by name — `OUTBOX_PUSH_SCHEMA_STALE`, before any
  statement is prepared, nothing changed — because the first shape could not
  hold an array destination. The rollback tool reads that shape (every
  destination there is a string or null): run `npm run rollback:outbox-push --
  <data-dir> <fresh-empty-dir>` and boot this build on the copy, which
  re-upgrades it into the corrected table. No real database carries the first
  shape; nothing is altered in place.

#### Operator procedure for the S7c cutover (not run on real data by this work)

1. **Dry run on a copy.** With the S7b build (`6ca66ba`) still serving, copy the
   data directory and boot this build on it (`DATA_DIR=<copy>` on a spare port):
   the log shows the 0011 import counts (outbox records by source, push records,
   tokens by kind and type, unknown-field rows); an `OUTBOX_PUSH_IMPORT_BLOCKED`
   line lists what to resolve on the previous build.
2. **Backup.** `POST /admin/backup` on the previous build, verify it, keep it.
3. **Cutover.** Stop the previous build, start this build on the real directory,
   read the same log lines.
4. **Rollback, if needed.** `node scripts/outboxPushRollback.mjs <data-dir>
   <fresh-empty-dir>`, then start the previous build (`6ca66ba`) on the output —
   every mail, push and token row written since the cutover is in it.

### Message threads (live since migration `0012`, S7d — implemented on top of `b67bce5`, corrected once after the independent review of `62e9c1a`, independently accepted at `4f954ad` on 18 October 2026 for its bounded storage-migration scope; not production-approved)

The thread routes (`GET /player/channels`, `/guardian/channels`, `/org/channels`,
the message, read and typing routes, the exports, `/admin/channels`,
`/admin/overview`) answer exactly as before; the records behind them are rows of
`channels`, `messages` and `message_attachments` (`repositories/channels.mjs`;
`docs/architecture/s7-readiness-review.md` §11.5 as corrected in §11.7/§11.8,
implemented as recorded in §11.9 after the Founder's decisions D-A and D-B). The
acceptance routes (`openChannel`), `postMessage`, the three receipt routes and
the account deletion are the only writers.

- **Order and keys.** `channels.seq` is the thread order every list depends on;
  `messages.position` is the array order within a thread (a tie on `ts` keeps
  its order). A thread is the `openChannel` literal, a message the `postMessage`
  literal, an attachment one of the two shapes `buildAttachment` produces (a
  total CHECK ties each kind to its columns). Optional keys that may be present
  and null or absent (`playerName`, `orgVerified`, `scoutName`, `scoutRole`,
  `guardianId`, the two receipts, a message's `attachment`, `sender.name`) are
  nullable columns plus `absent_keys_json`, so an absent key comes back absent
  and a null comes back null; `clientMsgId` is present only when the client sent
  one. A present legacy field (`orgUserIdForNotify`, which `postMessage` still
  reads) and every unknown own field at channel, message, attachment, `readBy`
  or `sender` level is kept in `extra_json` and spread back first.
- **References (the approved scope).** `request_id` is `NOT NULL UNIQUE`; it was
  created with NO foreign key (`recruitment_requests` did not exist yet) and the
  request was checked in code (D-A, the transitional reference) — a thread opens
  only for a request in the live `requests` collection, one thread per request,
  the import refuses a channel whose request is not in the file's blob, and
  every snapshot write validates the FINAL combined state (below). **Since
  migration `0015` (S8a-core) the table is rebuilt with the real
  `REFERENCES recruitment_requests(id) ON DELETE RESTRICT`** — the conversion
  D-A approved; the code checks stay. `player_id` carries NO lifecycle clause: a deleted player's
  threads — guardian–club threads included — are deleted explicitly inside the
  account-deletion unit, as every build did (D-B: a scope confirmation for this
  storage-only step; retention stays OPEN for S4b). `guardian_id` carries NO
  foreign key: a guardian is checked by name at open and every retained or
  incoming thread is checked against the FINAL guardians table whenever a
  snapshot writes the threads, carries the requests or rewrites the identity
  pair (a bounded code-validated choice; the deferred-foreign-key route is the
  stated alternative). `org_id` keeps its RESTRICT foreign key: an organisation
  removed under a retained thread is refused at the prune. Messages and
  attachments cascade with their thread only.
- **Writes.** A thread lands in the acceptance route's own save together with
  the request's answer; a message lands in `postMessage`'s save before the
  sender hears 201 (a SIGKILL right after the answer loses nothing); a receipt
  lands in its route's save; a deletion lands in the deletion unit's commit. A
  failed ordinary save keeps every pending row for the next save, which lands it
  once; an aborted unit of work restores the state from before the unit.
  Nothing here changes what a route answers, who may read a thread, the block
  and suspension checks, moderation, SSE scoping or the duplicate-send answer.
- **Boot.** The data layer attaches to the tables as they are; an in-memory
  `channels` array (the seed's empty container, the snapshot migration's
  `??= []`, a stale copy) is never imported — the blob the migration just
  imported is dropped silently, anything else is logged as a count and dropped.
  `GET /capabilities` → `persistence.dataLayer.domains.channels` reports the
  thread, message and attachment counts and the number of staged writes not yet
  in a committed save.
- **S7d cutover (first boot of this build on an S7c file).** Migration
  `0012_channels` creates the three tables and imports the `channels` blob:
  every thread, message and attachment validated and nothing coerced (the three
  sender kinds, the two counterparties and the two attachment kinds are the only
  vocabularies the writers ever produced); array order becomes `seq` and
  `position`; legacy and unknown fields kept; absence kept; a channel whose
  request is not in the `requests` blob, whose guardian is not in the
  `guardians` table or whose organisation is not in `orgs`, a duplicate id, a
  second channel for one request, a present null `clientMsgId` or an attachment
  of neither shape refuses the WHOLE step (`CHANNELS_IMPORT_BLOCKED`: entry
  positions, ids and reasons — never a message text, a name or an address); the
  blob and `saveSeq` are untouched and the next boot refuses the same way until
  the entry is resolved on the previous build. A file without a blob imports
  nothing. A backup from any build restores through the same migration with the
  order intact; a snapshot that omits `channels` leaves the tables alone, an
  explicit empty array clears them, a malformed collection or a reference the
  final state does not satisfy rolls the whole write back.
- **Rollback (copy-only).** `npm run rollback:channels -- <data-dir>
  <fresh-empty-dir>` (`scripts/channelsRollback.mjs`) opens the file read-only,
  copies it (`VACUUM INTO`), writes every thread back into the `channels` blob in
  insertion order with its messages in array order — each in its writer's
  literal, extras first, absence preserved — **nothing written after the cutover
  is lost** — drops the three tables, removes the 0012 record and its meta key,
  advances the save revision, checks every foreign key, VACUUMs and revalidates
  the copy (every other table untouched). Refusals, no output: a later schema
  step (exit 4), a file that never applied 0012 (exit 5), a non-empty output
  directory (exit 1), a recorded 0012 whose tables are missing (exit 10). Proven
  by booting the copy on the actual pre-S7d build (`b67bce5`): the same threads,
  messages and receipts in its routes and admin audit, a message posted there
  into its blob; this build then re-upgrades the copy with that message. To go
  further back, run `scripts/outboxPushRollback.mjs` on this tool's output (it
  refuses the S7d file itself with exit 4). Since S6b a file this build wrote
  carries `0013_safety_audit`, which this tool refuses (exit 4): run
  `scripts/safetyAuditRollback.mjs` first and this tool on its output; since S4b-R the
  file carries `0014_player_erasure` as well — `scripts/playerErasureRollback.mjs` first,
  then the S6b tool, then this one.

#### Operator procedure for the S7d cutover (not run on real data by this work)

1. **Dry run on a copy.** With the S7c build (`b67bce5`) still serving, copy the
   data directory and boot this build on it (`DATA_DIR=<copy>` on a spare port):
   the log shows the 0012 import counts (threads by counterparty, messages,
   attachments, rows with legacy or unknown fields, rows with absent optional
   keys); a `CHANNELS_IMPORT_BLOCKED` line lists what to resolve on the previous
   build (positions and ids, never a message text).
2. **Backup.** `POST /admin/backup` on the previous build, verify it, keep it.
3. **Cutover.** Stop the previous build, start this build on the real directory,
   read the same log lines.
4. **Rollback, if needed.** `node scripts/channelsRollback.mjs <data-dir>
   <fresh-empty-dir>`, then start the previous build (`b67bce5`) on the output —
   every thread, message and receipt written since the cutover is in it.

### Safeguarding and audit records (live since migration `0013`, S6b — implemented 19 October 2026 on top of `1792fc7` under the Founder's decisions Q4, Q4b and Q5; corrected and independently ACCEPTED at `f0abd34` on 21 October 2026 for its bounded storage-migration scope; not production-approved)

The block, report, note, moderation, ledger, ops-event, source-change and IDV
routes and consoles answer exactly as before; the records behind them are rows
of `blocks`, `reports`, `moderation_log`, `org_notes`, `ledger`, `ops_events`,
`source_changes` and `idv_queue` (`repositories/safetyAudit.mjs`;
`docs/architecture/sqlite-migration-plan.md` §D.4 Candidate A as accepted at
`1792fc7`, implemented as recorded in `docs/architecture/s6-readiness-review.md`
§11). The writers are `ledgerAppend`, `moderateOrRefuse`, `handleReport`, the
block, note, IDV, resolve, IDV-toggle and lift routes, the m13 ops events
(delivery, enterprise, imports) and m181's source changes — all through the
repository; every `db.<name>` is a read-only view in insertion order.

- **Order and keys.** `seq` is the array position at the import and the
  insertion order afterwards; every list, export and backup reads it. A row is
  the writer's literal: unknown own fields come back first (`extra_json`), a key
  the writer did not pass comes back absent (`absent_keys_json`), a known key
  whose value is not the column's type — the numeric or object `targetPlayerId`
  `handleReport` stores as received, an object `orgId` — comes back exactly as
  stored (`offtype_json`). A NESTED undefined (an object property, an array
  entry) is stored as JSON stores it: the property omitted, the entry null —
  the pre-S6b blob's rule (review §11.4, F2). No vocabulary is enforced by the
  database.
- **References (the approved scope).** NO foreign key on any of the eight. The
  five player references (`blocks`, `reports`, `org_notes`, `ledger`,
  `source_changes`) are **tolerant** (Q4): a row naming a player that is not in
  `players` — a deleted account, a pre-S4a import, a report naming an unknown
  player — is kept as it is and COUNTED (the boot log, every snapshot write's
  log line, `GET /capabilities` → `persistence.dataLayer.domains.safetyAudit.
  unresolvedPlayerReferences`); the count says how many rows name no present
  player, never why. No parent-existence rule was added to any writer: a report
  naming an unknown player is accepted as before. The organisation and staff ids
  are historical pointers (the block and report routes accept them unchecked
  today — a stated shape-compatibility decision). `idv_queue.guardian_id` is
  **strict** (Q4b, in code): a new entry, an imported entry and every snapshot
  write that carries `idvQueue` or rewrites the identity pair are checked
  against the FINAL `guardians` table; an entry naming a missing guardian
  refuses the whole operation atomically (`IDV_GUARDIAN_MISSING`, ids only) —
  an identity-only replacement that removes a referenced guardian included.
  Lifting a block deletes its row (Q5). Account deletion is unchanged: every
  audit row naming the person stays with its now-unresolved id.
- **Writes.** A block and its ledger row land in the route's next save
  together (one revision); a report lands in `handleReport`'s next save with
  the suspension blocks; the IDV entry commits with the guardian's columns
  before the 200 (both failure seams and the real COMMIT leave nothing; a
  SIGKILL right after the answer loses nothing); a failed ordinary save keeps
  every pending row for the next save, which lands it once; an aborted unit
  restores the mirror in place. Nothing here changes what a route answers, who
  may read a record, `isBlocked`, moderation, the resolve or toggle rules.
- **Boot.** The data layer attaches to the tables as they are; an in-memory
  array (the seed's empty containers, the snapshot migrations' `??= []`,
  `migrateM13`'s `opsEvents`) is never imported — dropped silently when empty,
  logged as a count otherwise. The log reports the eight counts, the pending
  writes and the unresolved player references.
- **S6b cutover (first boot of this build on a 4f954ad file).** Migration
  `0013_safety_audit` creates the eight tables and imports the eight blobs:
  every entry validated and nothing coerced (an object with a non-empty string
  id, unique within its collection); array order becomes `seq`; unknown fields,
  absent keys and off-type values kept; unresolved player ids counted; an IDV
  entry naming a guardian that is not in `guardians`, a non-object entry, a
  missing or duplicate id refuses the WHOLE step (`SAFETY_AUDIT_IMPORT_BLOCKED`:
  collections, positions, ids and reasons — never a report text, a note, an
  excerpt, a name or a document value); the blobs and `saveSeq` are untouched
  and the next boot refuses the same way until the entry is resolved on the
  previous build. A file without the blobs imports nothing. A backup from any
  build restores through the same migration with the order intact; a snapshot
  that omits a collection leaves its table alone, an explicit empty array clears
  it, a malformed collection or a strict refusal rolls the whole write back.
  The admin backup writes its `db.json` before appending its own
  `backup_created` event, as every build did.
- **Rollback (copy-only).** `npm run rollback:safety-audit -- <data-dir>
  <fresh-empty-dir>` (`scripts/safetyAuditRollback.mjs`) opens the file
  read-only, copies it (`VACUUM INTO`), writes every row of the eight tables
  back into its legacy blob in insertion order in the writer's literal (extras
  first, absence preserved, off-type values restored) — **nothing written,
  updated or deleted after the cutover is lost** (a lifted block is absent, a
  resolved report carries its resolution) — drops the eight tables, removes
  the 0013 record and its meta key, advances the save revision, checks every
  foreign key, VACUUMs and revalidates the copy (every other table untouched,
  the S4a–S7d tables included). Refusals, no output: a later schema step (exit
  4), a file that never applied 0013 (exit 5), a non-empty output directory
  (exit 1), a recorded 0013 whose tables are missing (exit 10). Proven by
  booting the copy on the actual pre-S6b build (`4f954ad`): the same rows in
  its routes and admin consoles, a block and a report accepted there into its
  blobs; this build then re-upgrades the copy with those writes. To go further
  back, run `scripts/channelsRollback.mjs` on this tool's output (it refuses the
  S6b file itself with exit 4); every earlier tool refuses a 0013 file.

#### Operator procedure for the S6b cutover (not run on real data by this work)

1. **Dry run on a copy.** With the S7d build (`4f954ad`) still serving, copy the
   data directory and boot this build on it (`DATA_DIR=<copy>` on a spare port):
   the log shows the 0013 import counts per collection (rows, rows with extra
   fields, absent keys, off-type values, unresolved player references, IDV
   entries); a `SAFETY_AUDIT_IMPORT_BLOCKED` line lists what to resolve on the
   previous build (collections, positions and ids, never a text).
2. **Backup.** `POST /admin/backup` on the previous build, verify it, keep it.
3. **Cutover.** Stop the previous build, start this build on the real directory,
   read the same log lines.
4. **Rollback, if needed.** `node scripts/safetyAuditRollback.mjs <data-dir>
   <fresh-empty-dir>`, then start the previous build (`4f954ad`) on the output —
   every audit row written, updated or deleted since the cutover is in it.

### Retained player records (live since migration `0014`, S4b-R — implemented 21 October 2026 on top of `d16362f` under the Founder's decisions of 12 October (the full birth date) and 21 October 2026 (the country code kept); corrected once and independently ACCEPTED at `9b109dc` on 21 October 2026 for the bounded retained-player-record milestone; not production-approved)

An account deletion (`DELETE /player/account`, `DELETE /guardian/children/:id`)
no longer deletes the player row. `deletePlayerData` calls `players.erase`
(`repositories/identity.mjs`) in place of the hard delete; everything else in
the deletion unit is unchanged — the session revoked, the pairing code revoked,
the media files queued and removed after COMMIT, the requests and trials
tombstoned, the case, assessment, contact and open-trial names nulled, the
m24–m29 hooks, the threads and the player-audience notifications deleted
(`docs/architecture/sqlite-migration-plan.md` §D.6, §D.6.1, §D.6.2;
`docs/architecture/s4-readiness-review.md` §12; the decision record
`docs/architecture/s4-deletion-decision.md` §10 and §12).

- **The retained record.** The row stays in `players` with `deleted_at` set to
  the deletion instant; `birth_date` and `country` are kept (the Founder's two
  decisions); `name` is the constant `Deleted player` and every other `NOT NULL`
  column holds its declared default — fixed storage placeholders, never the
  person's previous values and never read back as facts — every other column is
  `NULL`, `facets_json` is `NULL`; the twelve `player_*` child tables and the
  `guardian_children` rows are emptied explicitly; every guardian stops listing
  the id. Nothing of the person comes back from any rollback.
- **Served by nothing that serves accounts.** `db.players`, `players.byId`,
  `byGuardian`, `count`, `guardians.linksOf`, the login, the session lookup,
  the club views and lists, the guardian's children list, the pairing code
  (revoked; a code naming a retained id is refused by the snapshot check), the
  media-queue ownership check and the snapshot read all read live rows only. A
  retained id is never re-created as a live account: `players.insert`, the
  identity snapshot replace, the backup import and the `playersRetained`
  collection all refuse it with ids only. `/capabilities` reports
  `dataLayer.domains.players.retained` (a count) and the audit domain adds
  `retainedPlayerReferences` beside the Q4 `unresolvedPlayerReferences`.
- **What it does NOT change.** The ids of players deleted before this step,
  pre-S4a imports and ids that never existed stay as they are in the audit and
  recruitment rows — preserved and counted (Q4), never given a fabricated
  record (Q3 untouched). No foreign key to `players(id)` exists (plan §D.2a).
  No guardian deletion route. No retention period. No new age rule: no code
  computes a deleted player's age. The audit rows naming the person are
  byte-identical before and after the deletion.
- **Backups and restores.** The admin backup exports the retained records under
  `db.playersRetained` — `{ id, deletedAt, birthDate, country }` and nothing
  else — and **never inside `db.players`**; the manifest counts them as
  `retainedPlayers`. A restore into a new directory imports `players` through
  `0005` as before and `playersRetained` through `0014`; a backup whose
  `players` carries a retained id as a live player is refused at boot
  (`PLAYER_ERASURE_IMPORT_BLOCKED`, ids only, nothing of 0014 written). A
  previous build restoring such a backup keeps `playersRetained` as a blob no
  route reads — never as accounts. **A snapshot save that carries
  `playersRetained` (a persistence tool) may only ADD records:** every stored
  retained record must be listed with its four facts unchanged, or the whole
  save is refused with ids only (`RETAINED_RECORD_PROTECTED`); a stored record
  is never removed or amended by a save (corrected after the independent review
  of `6d66655`; `docs/architecture/s4-readiness-review.md` §12.4).
- **Rollback — copy-only, and the one way back.** `npm run
  rollback:player-erasure -- <data-dir> <fresh-empty-dir>`
  (`scripts/playerErasureRollback.mjs`) opens the file read-only, copies it,
  moves every retained record out of `players` into the `playersRetained`
  legacy blob (the accepted `f0abd34` build loads it under a name no route
  reads, keeps it through its saves and exports it in its backups, and serves
  nothing of it as an account), removes the `0014` record and its meta key,
  advances the save revision and revalidates the copy. The live rows and every
  other table are untouched; nothing written since the cutover is lost; **the
  erased personal data is restored by nothing** — the copy carries the retained
  records, not the deleted accounts. Exit codes: 0 done, 1 usage / output not
  empty, 4 a later schema step, 5 never applied 0014, 10 a recorded 0014 whose
  table is missing. To go further back, run `scripts/safetyAuditRollback.mjs`
  on THIS tool's output (it refuses a file carrying 0014), then the S7d tool,
  and so on down the chain. Re-upgrading the copy (booting this build on it)
  imports the blob back as the same rows. A live file of this build carries
  `0015` too: this tool refuses it (`LATER_SCHEMA`) until
  `scripts/recruitmentRollback.mjs` has produced the 0014-shaped copy.
- **DANGER — never boot the previous build directly on a `0014` file.** The
  migration runner skips a recorded step and refuses none it does not know, so
  the `f0abd34` build boots such a file without complaint, reads every
  `players` row as an account and serves a retained row as a live,
  **passwordless** player named "Deleted player" with the retained birth date
  and country (`scripts/testPlayerErasureServer.mjs` proves it on a synthetic
  copy). Going back is the rollback tool on a copy, never the old build on the
  live file and never a restore over a live directory.

**Cutover procedure** (the S6b pattern): 1. dry run on a copy of the live
directory — boot this build with `DATA_DIR` pointing at the copy, check
`/capabilities` reports `0014_player_erasure` and `players.retained: 0`;
2. back up (`POST /admin/backup`) and stop the server; 3. start this build —
the boot records `0014` in its one transaction (a file carrying a
`playersRetained` blob imports it; a refusal leaves the file untouched and the
next boot refuses the same way); 4. rollback, if needed, as above. **Since
S8a-core a live file carries `0015` as well:** the S4b-R tool refuses it
(`LATER_SCHEMA`, exit 4) until `scripts/recruitmentRollback.mjs` has produced
the 0014-shaped copy it works on (next section).

### Recruitment requests and accepted trials (live since migration `0015`, S8a-core — implemented 22 October 2026 on top of `d0f0205` under the Founder's decisions Q7a "Approve tolerant (Recommended)", Q7b "Approve strict checks (Recommended)" and Q7c "Approve strict (Recommended)" of 22 October 2026, on the design of plan §D.7 independently accepted at `d0f0205`; corrected at `7a7efc6` after the review of `6d77aa7` and INDEPENDENTLY ACCEPTED at `7a7efc6` within the storage-migration scope — plan §D.8.11; not production-approved)

`db.requests` and `db.trials` were two JSON blobs rewritten whole by every save
and mutated in place by twenty-five modules. Since migration `0015_recruitment`
they are sixteen tables (`repositories/recruitment.mjs`,
`repositories/migrations/0015_recruitment.mjs`;
`docs/architecture/sqlite-migration-plan.md` §D.7 the design, §D.8 the
implementation record; `docs/architecture/sql/02_recruitment.sql` the DDL):

- **The tables.** `recruitment_requests` and `request_trial_slots`; `trials`
  and its eleven owned child tables (`trial_schedule_sessions`,
  `trial_session_evidence`, `trial_schedule_revisions`, `trial_attendance`,
  `trial_reminders`, `trial_day_staff`, `trial_day_consents`,
  `trial_day_checkins`, `trial_day_status_events`, `trial_reports`,
  `trial_history`); `idempotency_keys` (the replayable `keys` acts of both);
  and `channels`, rebuilt by the same migration with the REAL `request_id`
  foreign key (the D-A conversion). Every record is stored in its writer's
  literal, key for key: scalars as columns of the same nullability (no
  vocabulary or length CHECK, no fabricated default), nested objects as
  columns of the same row, lists as child rows in list order, and every
  absent key, present null, off-type value and unknown field kept
  (`absent_keys_json`, `offtype_json`, `extra_json`, `raw_json`) so a record
  comes back exactly as it was written — the tombstone shapes, `blockedBy`,
  every `keys` act present and distinct (a non-empty list act and a keyed
  value act as `idempotency_keys` rows; `keys.accept {key: null, fp}`, an
  empty list act, an empty object, a null and any other act kept on the owner
  row; an act named `__proto__` is data — the review of `6d77aa7`, F1), the tombstone's
  `trialDetails.instructions: null`, the `day` container's presence, a pre-P4B
  trial without `workflowState` (counted as `preP4bShape`, read by
  `isLegacyTrial` as before) included.
- **What the routes see.** `db.requests` and `db.trials` are read-only ARRAY
  views (push/splice/assignment refused) whose elements are the plain,
  mutable records the routes edit in place; a change lands in the next save's
  flush — the same save that carried the blob before (the invitation in its
  route's `persistNow()`, the answer, the thread and the trial in the respond
  route's one save, the report in its route's debounced save, a day change in
  its route's save). New records enter through `recruitment.addRequest` /
  `addTrial` (the former three `push` sites); the deletion unit's tombstones
  through `recruitment.tombstoneForPlayer` (in place, ids kept, inside the
  unit). Every route payload is unchanged; `players[].trialReports` is still
  derived from the trials (now through the repository). The backup exports
  `requests` and `trials` in their legacy shapes; a restore into a new
  directory imports them through `0015` row for row.
- **References (the approved scope).** `player_id` on both tables: NO key,
  TOLERANT (Q7a) — a live id resolves, a retained id resolves to the retained
  record, a historically missing id is preserved and counted
  (`/capabilities` → `dataLayer.domains.recruitment.unresolvedPlayerReferences`
  and `retainedPlayerReferences`; `meta.recruitmentCutover.players` at
  import), never refused, fabricated or deleted. `case_id` on both tables:
  NO key until S8b, STRICT in code (Q7b) — every write, import and snapshot
  refuses with ids only a case id that is not in the FINAL `recruitmentCases`
  collection (`RECRUITMENT_CASE_MISSING`). `guardian_id` and
  `recipient_guardian_id`: NO key, STRICT in code (Q7c) — a guardian that does
  not exist is refused (`RECRUITMENT_GUARDIAN_MISSING`); an identity-only save
  that removes the guardian a minor's invitation names is refused whole.
  `trials.request_id` → `recruitment_requests` (NOT NULL UNIQUE, RESTRICT);
  `recruitment_requests.trial_id` → `trials` (SET NULL); `org_id` and
  `user_id` → `orgs` / `org_users` (RESTRICT; a snapshot that removes a staff
  member or an organisation while a request still names it is refused with
  ids — `RECRUITMENT_ORG_MISSING`, `RECRUITMENT_USER_MISSING`);
  `channels.request_id` → `recruitment_requests` (RESTRICT; a snapshot that
  removes a request under its thread is refused with ids —
  `CHANNEL_REQUEST_MISSING`). The drafted `recruitment_requests_one_pending`
  index is withdrawn (the open-day outcome route keeps its several pending
  invitations; the direct route keeps its `REQUEST_PENDING` rule);
  `trials_one_open_per_case` is kept (two open trials in one case are refused
  in either input order; a survivor leaving its slot is released by an UPDATE
  that parks `case_id`, never deleted, so its request link survives a partial
  save).
- **The write (plan §D.7.5), every time the tables are written** — the
  cutover import, a restore, a route's save, a whole snapshot: 1. the supplied
  requests upserted with the back-reference parked; 2. the trials' departures
  (not listed, or a changed `request_id`), releases and arrivals, children
  rewritten in list order; 3. the final `trial_id` assigned; 4. the channels;
  5. the requests no longer listed pruned; 6. the final-state assertions (the
  request/trial pair — a request without a `trialId` key beside its trial is
  the pre-P4B legacy pair, counted, never fabricated —, every case id, every
  guardian id). An omitted collection keeps its rows; a case-only change with
  `requests` omitted persists exactly what the full save persists; no link is
  ever inferred from a trial alone. A refusal throws with ids only (never a
  name, a message, an address or a note) and the whole save rolls back. The
  two failure contracts are unchanged: a failed ordinary save keeps memory as
  the intended state and the next save lands it once; an aborted unit of work
  restores every record, nested object and array in place.
- **Saves take the write lock at BEGIN.** `store.mjs` opens every save and
  every unit of work with `BEGIN IMMEDIATE` (it was a deferred `BEGIN`): the
  recruitment flush reads before it writes, and a deferred transaction whose
  reads came first fails at once with "database is locked" when another
  process commits in between (a snapshot conflict the busy handler never
  retries). The documented busy wait (`PRAGMA busy_timeout = 5000`) now
  applies at the start of every write transaction, as it should.
- **Boot and `/capabilities`.** The first boot of this build records `0015`
  in the runner's one transaction: the fifteen tables created, the file's
  `requests` and `trials` blobs imported through the same validation (every
  entry's identifiers, no duplicate id, every trial's request present and at
  most one trial per request, every pair consistent, every case id in the
  file's `recruitmentCases`, every guardian id in `guardians`, every org and
  staff id in their tables; the player ids counted), `channels` rebuilt with
  the key (every thread, message and attachment copied back row for row), the
  two blob rows retired, counts only in `meta.recruitmentCutover`. A refusal
  (`RECRUITMENT_IMPORT_BLOCKED`, positions, ids and reasons) aborts the boot
  with the file untouched; the next boot refuses the same way; the fix is by
  hand on the data (plan §D.7.3), never by the migration. **This refuses a
  file the blob store tolerated** (plan §D.8.5): an entry in `requests` or
  `trials` that is not a record (a `null`, a string, a number — the old boot
  ignored them), a whole blob that is JSON `null` rather than a list (refused
  like an object or a string; only a genuinely ABSENT blob imports nothing —
  the review of `6d77aa7`, F2), a trial naming no request, a request naming no staff member
  or organisation, two trials naming one request, two open trials in one case
  (any state other than completed/cancelled counts as open). No production
  writer produces such rows; nothing is dropped or repaired. The boot log states
  the counts; `/capabilities` reports `dataLayer.domains.recruitment`
  (`mode: 'live'`, `rows`, `pendingWrites`, the two player-reference counts,
  the reference policy).
- **Rollback — copy-only, and the one way back.** `npm run
  rollback:recruitment -- <data-dir> <fresh-empty-dir>`
  (`scripts/recruitmentRollback.mjs`) opens the file read-only, copies it,
  writes every request and every trial back into the `requests` and `trials`
  legacy blobs in insertion order in the writers' literals (children nested in
  list order, keys reassembled, every absent, null, off-type and unknown field
  as recorded), recreates `channels` in its `0012` definition without the key
  with every thread, message and attachment row for row, drops the fifteen
  tables, removes the `0015` record and its meta key, advances the save
  revision, checks every foreign key, VACUUMs and revalidates the copy.
  **Nothing written since the cutover is lost.** Exit codes: 0 done, 1 usage /
  output not empty, 4 a later schema step, 5 never applied `0015`, 10 a
  recorded `0015` whose tables are missing. To go further back, run
  `scripts/playerErasureRollback.mjs` on THIS tool's output (it refuses a file
  carrying `0015`), then the S6b tool, and so on down the chain. Re-upgrading
  the copy (booting this build on it) imports the blobs back as the same rows,
  the writes the previous build made on the copy included — proven on the
  actual accepted `9b109dc` build (`SCOUTBOX_PRE_S8A_SERVER`,
  `scripts/testRecruitmentServer.mjs`).
- **DANGER — never boot the previous build directly on a `0015` file.**
  Measured on the actual `9b109dc` build: the migration runner skips the
  record it does not know, the build finds no `requests` / `trials` blob (the
  rows are invisible to it), its boot-contract integrity check logs
  `INTEGRITY STORE_MISSING requests, trials` and the process **exits 1 before
  listening** — nothing is served and nothing is written, which is safer than
  the brief had predicted (it expected empty listings), but there is still no
  way back except the rollback tool on a copy. Never a restore over a live
  directory.
- **A legacy `db.json` older than schema 2304 (before M23 P4B).** The snapshot
  migrations backfill the P4B containers on the trials in memory before the
  data layer attaches, and `0015` imports the FILE's blob, never the array:
  such a snapshot restored directly onto this build keeps its pre-P4B trials
  as they were (counted as `preP4bShape` in the boot log; readable; the
  containers are added by the routes when they first write). Backups written
  by any build with the SQLite store are at or beyond 2304 and unaffected. To
  avoid it, restore such a snapshot on the accepted `9b109dc` build first, let
  it save once, then upgrade.

**Cutover procedure** (the S6b pattern): 1. dry run on a copy of the live
directory — boot this build with `DATA_DIR` pointing at the copy, check the
boot log's `recruitment: cutover imported …` line (the counts: requests,
trials, legacy pairs, pre-P4B shapes, the player references live / retained /
missing) and that `/capabilities` reports `0015_recruitment` and
`domains.recruitment.rows` equal to the blobs' counts; a refusal names the
positions and ids to fix by hand on the data; 2. back up (`POST /admin/backup`)
and stop the server; 3. start this build — the boot records `0015` in its one
transaction; 4. rollback, if needed, as above. **Not measured as faster:** the
two blobs leave every save and a changed record lands as its own rows, but the
change tracking still serialises every record per save, so the save time is
unchanged within noise, the boot is slower (sixteen tables decoded) and the
file is larger (plan §D.8.7); the whole-snapshot-write objective is not met.
**S8b (cases, rooms, decisions) is prepared, not implemented** — nothing of it
runs in this build; `docs/architecture/s8b-readiness-review.md` (plan §D.9) is
the design for independent review (its write order corrected after the
independent review of `57076a2`; the corrected design awaits independent
acceptance); the next free migration identifier is `0016`, reported, not
reserved; `recruitmentCases` and the four room blobs
stay blobs, and `case_id` stays the code-checked reference of Q7b.

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
- `media/` — media files, **except** those whose removal is queued (a backup
  never carries a file without the intent to remove it),
- `manifest.json` — SHA-256 checksums, sizes, counts, `media.queuedForRemoval`
  (how many files were left out and why), restore instructions.
`POST /admin/backup/verify {dir}` re-checksums a backup.
Backups contain no environment secrets, but they contain personal data —
store them with the same care as the live data directory. Since S4a the
`db.json` export carries the `players` and `guardians` collections rendered
from their tables (`childIds` from the links), sessions as hashes and the
media-removal queue as `mediaDeletions`; since S6a the one-time codes as
`emailChallenges` / `pairingCodes` in their hashed row form; since S7a the
notifications and preferences as `notifications` / `notificationPrefs` in the
legacy collection shape, in feed order; since S7b the delivery dispatch records
as `dispatches` in the eighteen-key shape with their attempts nested, in
insertion order; it is the shape
the first boot of a restore imports and cuts over again. The manifest is written last: a backup
that fails midway (a write or copy error) answers `500 BACKUP_FAILED`, its
partial directory is removed, and an `ops` event records the failure — nothing
half-made is ever listed as a usable backup. A queue entry that names a clip a
live player still references makes the backup answer
`409 MEDIA_QUEUE_OWNERSHIP_CONFLICT` (media ids and owner ids, no directory
created, an `ops` event): it can neither copy the file as the player's nor leave
it out as removed, so the conflict is resolved first ("Media removal" above).

## Restore (never over a live directory)
1. Copy the backup directory to a **new, empty** location.
2. Start the server with `DATA_DIR=<that location>` — the store imports
   `db.json` on first boot and renames it `db.json.migrated`.
3. Smoke-check `/readyz`, a login, and a representative read.
`scripts/m13E2E.mjs` performs exactly this cycle (backup → verify → copy →
boot second server → login + player list) on every run;
`scripts/testCoreIdentityServer.mjs` repeats it for the S4a tables (every
player, guardian, link, outstanding e-mail code and session hash present on
the restored server). A restore refuses a snapshot whose identity records are
invalid (the whole import is rejected, `LEGACY_IMPORT_FAILED`, the file left
in place) rather than importing part of it. Since S4b-R (migration `0014`) a backup
carries the retained player records under `playersRetained`, imported by the restore;
the restored server serves nothing of them as accounts, and a backup whose `players`
lists a retained id as a live player is refused at boot (ids only).

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
