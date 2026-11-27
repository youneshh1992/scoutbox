# Server architecture

The server (`scoutbox-server/`) is Gleam on the BEAM, with SQLite through `sqlight`. All data lives in one SQLite
file, `DATA_DIR/scoutbox.db`, in typed tables. There is no in-memory copy of a table and no save step: a write is
durable when its unit commits. How to run and configure the server: [`../scoutbox-server/README.md`](../scoutbox-server/README.md).
The rules for writing its code (units, effects, typed ids, input shapes, the generator) are in
[`../scoutbox-server/CLAUDE.md`](../scoutbox-server/CLAUDE.md); this page holds the product's.

## Ground rules

1. **There is no production data.** Every database is seed or test data, and rollback means re-seeding
   (`npm run reseed` at the repo root). Don't write rollback scripts, compatibility with old dev-build files, or
   operator procedures.
2. **Valid input only.** Each field is a typed column with its domain's CHECKs. There are no JSON side columns for
   junk. A route declares its input as a `platform/input` shape, which refuses undeclared fields and never coerces.
   A refusal names the field by its path (`ratings[0].note`) and says what was wrong as a `problem` (`required`,
   `too_long`, `not_allowed`, …) with the values it needs (`max`, `min`, `allowed`, `expected`). Its `message` is
   English for developers, not for display: the apps word refusals themselves.
3. **Explicit writes.** A route changes data through named acts inside a unit. Nothing edits a record in place and
   expects something else to notice.
4. **One source of truth per domain.** No dual writes, and no copies of a table.
5. **The end-to-end batteries are the specification** (`scoutbox-server/e2e/<domain>/`). You may rewrite an
   assertion that only describes storage. Never delete a behavioural one.
6. **Responses are allowlists** (`json.object` in the key order the apps expect), never a spread record. Refusals
   name ids and codes, never names, e-mails, message bodies, tokens or codes.

## Tables

- Tables come from numbered SQL migrations in `scoutbox-server/priv/migrations/`, edited directly. Their Gleam rows
  and vocabularies (`src/scoutbox/rows/`, `src/scoutbox/vocab/`) are generated from them (`npm run codegen`).
- Typed columns with vocabulary CHECKs. No JSON columns. Lists are ordered child rows (`seq` / `position`). A
  polymorphic detail is a set of typed columns per kind.
- Client keys, idempotency keys, reminder markers and similar are columns or child rows of their owner, not shared
  tables.
- Secrets, tokens and one-time codes are stored only as hashes.
- **Keys.** `org_id` and staff ids are `RESTRICT` (organisations can't be deleted, and removed staff keep their row).
  Keys between tables of one domain are immediate `RESTRICT`. **Player, guardian and media ids have no foreign key**:
  a club's records outlive a player's account deletion and keep the id (decisions.md §2). Use
  `DEFERRABLE INITIALLY DEFERRED` only for a genuine cycle (a signing package and its signing).
- Seeded catalogues (assessment templates, policy versions) are inserted by their migration. Product configuration
  that only a release should change (billing plans, archetypes) is a constant in the code, not a table.
- Files are not in the database. A client uploads one straight to object storage (Cloudflare R2, or the local store
  in development) with a signed URL the server issues, and names its `uploadId` to the route that records it.
  `upload_intents` holds each upload; the record keeps its blob key.

Shared shapes other domains rely on: a case-history entry is `{ id, at, byKind, byId, byName, action, detail }`; a
decision's `snapshot` is the `room_snapshots` row it names, never a copy; a Room's `sourceRef` is `{ id, version }`;
a compliance review's snapshot is the evaluation row it was taken from (`<context>#<n>`); signing, offer and
transaction documents are evidence records.

## Writes

- **A unit of work is one transaction**, and only `store.unit` opens one. All writes go through the one writer
  connection, in a process of their own; a unit commits whole or not at all, and a crash inside it rolls back.
- **A record is created whole, then changes only through named acts** (`cases.move`, `contacts.record_delivery`,
  `offers.issue_revision`, `offers.withdraw_revision`). An act changes only its own columns and rows, and history is only
  inserted. An act is refused unless the record is in a state it moves from: a Room's, a claim's or a transaction's
  status moves only along its domain's transition table, guarded in SQL.
- **A lost race is rerun, not a crash.** An act whose checks ran before its unit checks again inside it and answers
  `store.stale` when another request moved the state first; its route reruns from the top
  (`http.rerun_on_stale`), so it answers from the new state.
- **The tables judge the values.** Pointers inside an aggregate are composite keys `(owner_id, id)`, so a record can't
  point into another one, and a fact another row already records is worked out on read, not stored twice.
- **A domain writes another domain's tables only through that domain's functions**, never by writing its rows itself.
- **Expected failures are values** (`store.refuse`), which roll the unit back. A crash is never control flow.
- **Side effects** (mail, push, live events, provider calls) are values asked for with `store.emit` inside the unit
  and dispatched in order after COMMIT; a refused unit sends none. A failure there is logged and never undoes the
  data. A provider call whose answer the act needs (object storage, say) happens before the unit, never inside it.
- **Reads never write.** A notice that a read used to create comes from a sweep, its marker committed with its
  notification.
- Background work (webhook deliveries, dispatches, follow-ups, expiries, reminders, upload and media removal) is
  persisted state swept on a timer with bounded retries, one unit per item.

## Reads

- A read outside a unit takes a pooled read-only connection, which sees the last commit. A read inside a unit uses
  the unit's connection and sees its own writes.
- A list reads its records' child rows in one query per table, never a query per record. Admin figures are
  `GROUP BY`s, sweeps indexed predicates.
- **The visibility rule is SQL**: the under-18 wall, the Grassroots 50 km radius (`platform/distance`, the one
  definition of a distance) and blocks.
- **Derived projections** are kept by the server, never written by hand:
  - `players.profile_signal`, the directory's sort figure, is written with every player and trial write.
  - `player_match_facts` (matching, watchlists, Nobody Missed) is marked dirty by triggers on its input tables and
    re-derived inside every unit just before COMMIT (`discovery/match_facts`). Facts that change only with time
    (evidence expiry, a claim's end, adulthood) carry `refresh_due_at` and are re-derived by the minute sweep. A
    change of trust policy re-derives every row at boot.

## Paging

`platform/paging`: `?limit=&cursor=` → `{ items, nextCursor }` (plus `total` where a screen shows a count), 50 by
default, at most 100, junk refused with 400. The cursor is the last row's sort key. Page lists that grow without
limit; per-case, per-player and per-person lists are unpaged by rule. Where a screen counted a list, add a counts
route. The apps read the first page only and carry a comment that "load more" is still needed (a frontend
follow-up).

## Performance target

Against a synthetic population (`node dev/perf.mjs`, after `gleam export erlang-shipment`), the hot paths should
answer at p50 under 5 ms, with no request touching every player. The routes that still miss the target are listed in
[`known-issues.md`](known-issues.md#performance).

## Adding or changing a table

1. **Migration.** A new numbered SQL file in `priv/migrations/`. **For now, change a table by amending the migration
   that creates it, in place** (and re-seed): there is no production data, and each table's definition stays in one
   file. Add a migration for a new table or domain. Keep comments outside a `CREATE TABLE`'s column list.
2. **Generate.** `npm run codegen` writes its row module and vocabularies, and the batteries' fixture schema. Every
   column named `id` or `*_id` must be typed by a foreign key or declared in `dev/scoutbox_dev.gleam`.
3. **Tests.** A battery in `e2e/<domain>/`, listed in `e2e/batteries.mjs`; a rule over many inputs gets a blessed
   fixture in `test/fixtures/`. `npm run e2e:check` checks the batteries are listed, the generated code matches the
   migrations, and every query the source spells out prepares against the schema.

**Test data.** The demo world is `priv/seed.sql`. Batteries write their setup through the routes, or with SQL
through `e2e/support/sqlFixture.mjs` for a state no route can write, in temporary directories only, never
`scoutbox-server/data/`.

## Code layout

Server code is in `scoutbox-server/src/scoutbox/<domain>/`: `platform` (the store, input, HTTP, clock, storage,
paging), then `identity`, `groups`, `integrations`, `media`, `safety`, `enterprise`, `messaging`, `development`,
`verification`, `discovery`, `recruitment`, `scouting`, `insight`, `operations`, `agents` and `passport`. A
domain's routes are its `*_routes` modules; `router.gleam` maps every path to one, after its access check
(`identity/access`). `rows/` and `vocab/` are generated. Rules shared with the apps that Gleam can't import from
`shared/` are kept in one module that says so (`identity/roles`).
