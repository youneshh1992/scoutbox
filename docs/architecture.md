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
   may still be shortened. A route declares its input as a valibot `v.strictObject` built from the shared field
   schemas in `domains/platform/schemas.mjs`, and reads it with `inputOrRefuse` (or `parseInput` where the domain
   sends its own errors), which refuses undeclared fields. A refusal names the field by its path
   (`ratings[0].note`) and says what was wrong as a `problem` (`required`, `too_long`, `not_allowed`, … — `PROBLEMS`
   in that module) with the values it needs (`max`, `min`, `allowed`, `expected`). Its `message` is English for
   developers, not for display: the apps word refusals themselves. Routes not yet moved over still check their input
   by hand.
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

- **A record is created whole, then changes only through named acts.** `create(record)` writes a whole record. After
  that it changes only through operations named after what happened (`moveRoom`, `recordDelivery`, `issueRevision`,
  `revoke`, `withdraw`, `resolveDispute`), called as `act(id, input, bookkeeping)`: the input carries only what the
  act sets, and the bookkeeping is the history entries, the revision bump and the change instant it leaves
  (`recordAct(id, bookkeeping)` is the bookkeeping alone). An act changes only its own fields and rows: an `UPDATE` of
  named columns or an `INSERT` of new rows (or, where a repository still writes a record's row from its typed form,
  that row with only the act's fields changed), and history is only inserted. There is no generic update and no edit of
  a copy written back. An act is refused unless the record is in a state it moves from: a Room's, a claim's or a
  transaction's status moves only along its domain's transition table (`ROOM_TRANSITIONS`, `CLAIM_TRANSITIONS`, the
  agent transitions), guarded in SQL, and a one-way act is guarded by the state it leaves (a share is revoked once, an
  application answered only while outstanding, a Box Cam result worked out only while recording). A claim's move is
  also refused unless it is from the status its caller judged, so a stale decision is refused.
- **The tables judge the values.** The columns and keys are the check on stored values. Pointers inside an aggregate
  are composite keys `(owner_id, id)`, so a record can't point into another one, and a fact another row already
  records is worked out on read, not stored twice (a document's or a review's `supersededBy` is the row naming it). A
  whole-record `create`, and an act that inserts a sub-record (a task, a draft), must read back exactly as written, so
  a field with no column, or a value a column would coerce, is refused rather than lost. Where a history entry's
  detail is worked out on read, the inserted entry must read back as the writer gave it. Some repositories still type
  a record in JavaScript before writing it (from its field specs, or a typer of its own); there an act types the record
  with the fields it sets, so a value is judged the same way whichever write it came through. The shared checks, the
  guarded update, the act runner (`actsOn`) and the mapping of a field spec to columns are `repositories/writes.mjs`.
- **A domain writes another domain's tables only through that domain.** It receives the other domain's reads
  (`*Reads`) and the named write seams it offers (the identity domain's `playerRecord.recordSigning`, the recruitment
  domain's `caseHandoffs`), never its repository. Case work and the agents' handoffs follow this; the domains still
  handed another domain's repository are listed in
  [`app-layer-architecture-improvements.md`](app-layer-architecture-improvements.md#5-named-acts-everywhere-done).
- A write returns the stored record. A route that writes and then answers must use it: the one it held is the old
  version.
- **Units of work.** A route that writes more than one row runs inside `store.unitOfWork(() => …)` (the server's
  `unit(work, announce)`): one `BEGIN IMMEDIATE` transaction, all or nothing. An act's notifications, ledger rows and
  audit events are part of the act and are written in its unit, so the act and the record of it commit together
  (`announce`, when given, runs inside the unit after `work`). The callback must be synchronous (an `async` one is
  refused). Nested units join the outer one, and an inner failure fails the whole unit even if the caller catches
  it. Check every field before writing anything; throwing inside the unit replaces hand-written undo code. Expected
  negative results (nothing to delete) are return values, not throws. A route answers after its unit commits, never
  from inside it.
- **Side effects** (mail, push, live events, provider calls) leave the process only when no transaction is open:
  through `store.afterCommit(fn)`, which runs after `COMMIT`, or after the unit has returned. A failure there is
  logged and never undoes the data. Provider calls whose answer the act needs happen before the unit. `notify`
  writes its row in the caller's unit and sends the push and live event after the commit; `broadcast` inside a unit
  waits for the commit the same way.
- A repository's `operation(fn)` (`repositories/database.mjs` `operationOn`) joins the open unit or opens its own
  transaction; every transaction opens and closes through `beginOn` / `commitOn` there.
- **The rules are checked** (`writeRules.mjs`), per request, from SQLite's own change count: a request that commits a
  second transaction that changed rows, a GET that writes, and a write made with no transaction open are refused
  outside production and counted in it (`store.unitOfWorkState().writeRules`); sending mail, a push or a live event
  while a transaction is open is refused everywhere, before anything is sent. What is not the request's act is
  declared where it happens: after-commit effects and their delivery rows (`sideEffect`), sweeps run from a route
  (`asSweep`), first-use setup and a credential's bookkeeping (`apartFromTheAct`), the id counter's mint
  (`standaloneWrite`), workflow state a read reconciles (`asReconciling`, each a known issue), and a read that must
  record itself (`declareAuditedRead`: a Discovery Ledger view, a share-link view, evidence access).
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

Server code is in `scoutbox-server/domains/<domain>/`; `server.mjs` holds no route handlers, only the wiring that creates each
domain and hands it what it needs, in dependency order. End-to-end batteries live in `scoutbox-server/e2e/<domain>/`,
named after what they check.

### Domain boundaries

The domains sit in layers, bottom to top:

| Layer | Domains |
| --- | --- |
| 0 | `platform` |
| 1 | `identity`, `groups`, `integrations`, `media`, `safety` |
| 2 | `enterprise`, `messaging` |
| 3 | `development` |
| 4 | `verification` |
| 5 | `discovery` |
| 6 | `recruitment` |
| 7 | `scouting`, `insight`, `operations` |
| 8 | `agents` |
| 9 | `passport` (the Football Passport and the Trust Score) |

- **Imports go down through a public module.** A domain imports another domain only through its
  `domains/<domain>/public.mjs`, and only one in a lower layer. A public module holds the domain's vocabulary, pure
  rules and views. It only re-exports its own domain's modules, never one that registers routes, and holds no state.
  The repositories and the shared rule modules also import a domain's vocabulary through its public module.
- **The platform layer imports no domain.** What it reports about a domain (the audit feed's agency rows, the open Room
  statuses the integrity check uses, the verified Combine protocols) is handed to it by `server.mjs`.
- **What a domain does at run time comes through `server.mjs`.** The layers say what code a domain may know, not the
  order domains are created in: the Rooms are created after the Passport and use its projections, which are handed to
  them, while the Passport's code imports recruitment's trial rules.
- **No import cycles**, between domains or between the modules of one folder.

**Domain factories.** A domain's `index.mjs` exports its factories, `create<Part>(deps)`, which `server.mjs` calls in
dependency order. Each factory registers its routes and returns what other domains use (a read, a seam, a sweep).
It names its dependencies with `needs(name, deps, [...])` (`domains/platform/deps.mjs`): a missing name, or one it
didn't declare, fails the boot, so a wide context can't be handed on. The context it gives its own route modules is
`strictContext` (or `routeContext`, with the route helpers): outside production, reading a name it doesn't hold
throws. A domain has more than one factory when its parts need things created at different points (the identity
domain's sessions come before everything, its account services after the domains whose records they read). Sweeps
are returned, not started, and `server.mjs` schedules them. `server.mjs` passes each dependency by name; there is
no shared context.

`npm run check:boundaries` (`scripts/checkBoundaries.mjs`) checks these rules in CI. The layer order is listed in
that script as `DOMAIN_LAYERS`, so a new domain gets a layer when it is added. `server.mjs`, `e2e/` and `scripts/` may
import any module.
