# Server architecture

The server (`scoutbox-server/`) is Node with the built-in `node:sqlite`. All data lives in one SQLite file,
`DATA_DIR/scoutbox.db`, in typed tables. Each table is owned by one repository in `repositories/`, and routes change
data only by calling that repository's operations. No repository holds records in memory, and there is no save step:
a write is durable when its transaction commits. How to run and configure the server is in
[`../scoutbox-server/OPERATIONS.md`](../scoutbox-server/OPERATIONS.md).

## Ground rules

1. **There is no production data.** Every database is seed or test data, and rollback means re-seeding
   (`npm run reseed` at the repo root). Don't write rollback scripts, compatibility with old dev-build files, or operator procedures.
2. **Valid input only.** Each field is a typed column with its domain's CHECKs. There are no JSON side columns for
   junk (`extra_json`, `absent_keys_json`). The route refuses bad input with the domain's code, or with
   `400 FIELD_INVALID` / `DATE_INVALID` naming the field. It doesn't clamp, cut off or coerce. Over-long free text
   may still be shortened.
3. **Explicit writes.** Routes call repository operations (`signings.record(…)`, `followUps.schedule(…)`). They never
   edit a record in place and expect something else to notice.
4. **One source of truth per domain.** No dual writes, and no in-memory copies of a table.
5. **The end-to-end batteries are the specification** (`scoutbox-server/e2e/<domain>/`). You may rewrite an
   assertion that only describes storage. Never delete a behavioural one.
6. **Responses are allowlists**, never a spread record. Refusals name ids and codes, never names, e-mails, message
   bodies, tokens or codes.

## Tables

- Typed columns with vocabulary CHECKs. No JSON columns. Lists are ordered child rows (`seq` / `position`). A
  polymorphic detail is a set of typed columns per kind.
- Client keys, idempotency keys, reminder markers and similar are columns or child rows of their owner, not shared
  tables.
- Secrets, tokens and one-time codes are stored only as hashes. A password hash or MFA secret is never on a record
  (`passwordHashOf`, `mfaSecretOf`).
- **Keys.** `org_id` and staff ids are `RESTRICT` (organisations can't be deleted, and removed staff keep their row).
  Keys between tables of one domain are immediate `RESTRICT`. **Player, guardian and media ids have no foreign key**:
  a club's records outlive a player's account deletion and keep the id (decisions.md §2). Use
  `DEFERRABLE INITIALLY DEFERRED` only for a genuine cycle (a signing package and its signing).
- Seeded catalogues (assessment templates, policy versions, Box Cam challenges) are inserted by their migration.
  Product configuration that only a release should change (billing plans, archetypes) is a constant in
  `catalogue.mjs`, not a table.
- For domains with many flat tables, describe them with `repositories/fieldSpecs.mjs` (as `verification.mjs` does),
  which generates the typing, the rows and the DDL from one spec so they can't drift.

Shared shapes other domains rely on: a case-history entry is `{ id, at, byKind, byId, byName, action, detail }`; a
decision's `snapshot` is the `room_snapshots` row it names, never a copy; a Room's `sourceRef` is `{ id, version }`;
a compliance review's snapshot is the evaluation row it was taken from (`<context>#<n>`); signing, offer and
transaction documents are evidence records.

## Writes

- **Named acts** (recruitment cases and their Room rows, contacts and offers: `repositories/recruitmentCases.mjs`,
  `repositories/recruitmentContactsOffers.mjs`; the direction for the other domains). A record is created whole, then
  changes only through operations named after what happened (`moveRoom`, `recordDelivery`, `issueRevision`), each an
  `UPDATE` of named columns or an `INSERT` of new rows, called as `act(id, input, bookkeeping)`; the bookkeeping is the
  history entries, rev bump and change instant the act leaves, and `recordAct(id, bookkeeping)` is it alone. History is
  only inserted. Pointers inside an aggregate are composite keys `(owner_id, id)`, so a record can't point into another
  one, and a state change is guarded in SQL by the domain's transition table. The columns and keys are the only check
  on stored values; there is no JavaScript copy of them. A whole-record `create`, and an act that inserts a sub-record
  (a task, a draft), must read back exactly as written, so a field with no column, or a value a column would coerce,
  is refused rather than lost. The shared checks and the guarded update are `repositories/writes.mjs`.
- **Whole-record updates** (every other domain, for now): `create(record)` and `update(id, (draft) => …)`. The update
  hands the callback a plain copy, types the whole record, writes it at once, refuses unknown fields and returns the
  stored record. Updating a record from inside its own update is refused.
- Either way, a write returns the stored record. A route that writes and then answers must use it: the one it held is
  the old version.
- **Units of work.** A route that writes more than one row (including its notifications and ledger rows) runs inside
  `store.unitOfWork(() => …)`: one `BEGIN IMMEDIATE` transaction, all or nothing. The callback must be synchronous
  (an `async` one is refused). Nested units join the outer one, and an inner failure fails the whole unit even if
  the caller catches it. Check every field before writing anything; throwing inside the unit replaces hand-written
  undo code. Expected negative results (nothing to delete) are return values, not throws.
- **Side effects** (mail, push, live events) go through `store.afterCommit(fn)`, which runs only after `COMMIT`; a
  failure there is logged and never undoes the data. Provider calls happen before the unit.
- A repository's `operation(fn)` joins the open unit or opens its own transaction.
- **Reads never write.** A notice that a read used to create comes from a sweep, its marker committed with its
  notification. A row a read would create on first use is an explicit upsert, or the read returns defaults.
- Background work (webhook deliveries, dispatches, follow-ups, expiries, reminders, media removal) is persisted state
  swept on a timer with bounded retries, one transaction per item.

## Reads

- Repositories answer indexed queries (`byId`, `forOrg`, `forPlayer`, counts) with fresh, deep-frozen records. A read
  inside a unit sees the unit's own writes.
- Every module context carries `byId` (`domains/platform/lookups.mjs`: `byId.player`, `.guardian`, `.user`, `.org`,
  `.mediaOwner`) and a read-only reads object per domain (`recruitmentReads`, `scoutingReads`, …). Pure projectors
  take `reads` as an argument.
- A list decodes its records' child rows in one batch (`childRowsOf` in `repositories/database.mjs`), never a query
  per record. Admin figures are `GROUP BY`s, sweeps indexed predicates.
- **The visibility rule is SQL** (`players.visibleCandidates`, `visiblePage` and friends in `repositories/identity.mjs`):
  the under-18 wall, the Grassroots 50 km radius and blocks. The SQL functions registered on the connection
  (`haversine_km`, `distance_tenths`, `lower_js`) are the JavaScript rules, so the two can't disagree.
- **Derived projections** are kept by the repositories, never written by hand:
  - `players.profile_signal`, the directory's sort figure, is refreshed by every player and trial write.
  - `player_match_facts` (matching, watchlists, Nobody Missed) is marked dirty by triggers on its input tables and
    re-derived before every `COMMIT` (`onBeforeCommit`); a failure rolls the write back. Facts that change only with
    time (evidence expiry, a claim's end, adulthood) carry `refresh_due_at` and are re-derived by the minute sweep. A
    change of trust policy rebuilds every row at boot. Each match criterion has an SQL condition beside its JS test
    (`criterionSql` in `domains/discovery/matching/match.mjs`), and `scripts/testMatchFacts.mjs` checks they agree.

## Paging

`domains/platform/paging.mjs`: `?limit=&cursor=` → `{ items, nextCursor }` (plus `total` where a screen shows a
count), 50 by default, at most 100, junk refused with 400, `offset` refused. Newest first by rowid unless the list
defines an order. Page lists that grow without limit; per-case, per-player and per-person lists are unpaged by rule.
Where a screen counted a list, add a counts route. The apps read the first page only and carry a comment that "load
more" is still needed (a frontend follow-up).

## Performance target

A synthetic load of 100k players (`npm run perf:recruitment -- <players> <clones> <busy>`, optionally
`PERF_ONLY=<path>`) should give p50 under 5 ms on the hot paths, with no request touching every player.
`scripts/testUnitOfWork.mjs` holds the line that a player write costs the same number of statements at 20 and 2,000
players, and that an empty unit runs no organisation or identity statement. The routes that still miss the target
are listed in [`known-issues.md`](known-issues.md#performance).

## Adding or changing a table

1. **Migration.** `repositories/migrations/NNNN_name.mjs` exports `id`, `note` and `up(sqlite, { now, … })`; `up()`
   is the DDL plus any seeded catalogue rows. Register it in `repositories/index.mjs` (`DATA_MIGRATIONS`). Ids never
   change. **For now, change a table by amending the migration that creates it, in place** (and re-seed), rather than
   adding a migration that alters it: there is no production data, and each table's definition stays in one file.
   Add a new migration for a new table or domain. Set `foreignKeysOff = true` only when rebuilding a referenced table (`foreign_key_check` must then be
   empty before commit). The runner applies migrations in order, one transaction each, records them in
   `data_migrations`, and stops the boot on failure. The schema version is the latest migration's number.
2. **Repository.** `create<Domain>Repository({ sqlite, unit, now, log })` prepares its statements; each write types
   its input, writes rows and returns the stored record. `server.mjs` builds it and hands it, or its reads, to the
   modules. `repositories/signingsFollowUps.mjs` is the simplest complete example.
3. **Read-back for tests.** Export a `*_RECORDS` (`names`, `read`) and add the collections to `TABLE_BACKED` in
   `repositories/index.mjs`; give each new collection a writer in `scripts/dataLayerFixture.mjs`.
4. **Reporting.** Add a `/capabilities` → `dataLayer.domains` entry (`repositories/index.mjs`).
5. **Tests.** A `scripts/test<Domain>.mjs` suite listed in `SUITES` (`scripts/runTests.mjs`) and batteries listed in
   `BATTERIES` (`scripts/runE2E.mjs`); both runners refuse to run while a file is unlisted. `scripts/testSchema.mjs`
   checks every table is STRICT, has a primary key, and that keys and indexes name real tables.

**Test data.** `seed.mjs` fills only organisations, guardians and players. Suites write their setup through the
repositories (`scripts/dataLayerFixture.mjs`: `openLayer`, `writeFixture`, `readRecords`), or with SQL for a state no
operation can write, in temporary directories only, never `scoutbox-server/data/`.

## Code layout

New server code goes in `scoutbox-server/domains/<domain>/`. Some older code is still in milestone-named folders
(`m12/`, `m13/`, `m20/`, `m27/`), and the grassroots operations routes (open days, match days, friendlies) and the
squad routes are still in `server.mjs`; move them into their domain when you next work on them. End-to-end batteries
live in `scoutbox-server/e2e/<domain>/`, named after what they check.
