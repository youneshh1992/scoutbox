# SQLite migration: the live plan

The server is moving its data from one JSON blob (the `collections` table, read into `db.<collection>` arrays in
memory) to relational SQLite tables, one domain at a time. This document says what "done" means, where that stands,
and how to do the next step. Keep it current: update the status table in the same commit as each step. Earlier
versions of this plan and the per-step reviews are in git history and the tag `docs-archive-2026-11`.

Related: the target schema is [`sqlite-schema.md`](sqlite-schema.md) (design rationale) and [`sql/*.sql`](sql/)
(executable DDL). The data-layer contract is in [`../../scoutbox-server/OPERATIONS.md`](../../scoutbox-server/OPERATIONS.md).
Decisions already taken are in [`../decisions.md`](../decisions.md).

Code comments cite §1, §2, §4.3 (and "§4.3 step 2", "§4.3 step 4"), §4.3.1 and §4.5: keep those numbers.

---

## 1. Ground rules

1. **There is no production data.** Every database is seed or test data. **Rollback means re-seed**
   (`npm run reseed`). No rollback scripts, no compatibility with files written by earlier development builds, no
   operator procedures.
2. **Better models are welcome.** `sql/*.sql` is a starting point. A step may redesign its tables when that gives a
   cleaner model. Update the `sql/*.sql` file to match (`scripts/testSchemaDdl.mjs` compares them column by column)
   and say what changed in the PR. Until S14, an already-registered migration's DDL may be amended in place (its id
   doesn't change): re-seed afterwards. Don't write a migration just to drop or rename columns.
3. **Valid input only.** Each field is a properly typed column. No `absent_keys_json`, `offtype_json` or
   `extra_json` side columns. Where the old code accepted junk (wrong types, unknown fields), the route validates and
   rejects it.
4. **Explicit writes.** Routes change data by calling repository operations (`signings.record(…)`,
   `followUps.schedule(…)`). They do not edit in-memory objects and leave the save to find the changes.
5. **The end-to-end suites are the specification.** A domain is migrated when its existing suites pass. You may
   rewrite assertions that only describe the old storage, and say so in the commit. Never delete a behavioural
   assertion.
6. **The feature freeze holds until S14 is done.** In scope: the migration, defects, security, tests, and design
   changes the Founder explicitly requests.

Also: one domain per step; additive numbered migrations whose ids never change; ids preserved, and token hashing
keeps clients logged in; tests use temporary directories only, never `scoutbox-server/data/`; one source of truth
per domain, no dual writes; no whole-collection re-projection on the save path; each migration is one transaction,
and the boot stops if it fails.

## 2. What "done" looks like

- every domain lives in tables, owned by one repository each, written only through explicit operations;
- the hot reads are SQL queries with pagination (the org player directory, discovery, inboxes, case lists), not
  scans of in-memory arrays;
- the in-memory mirrors are gone;
- the blob store is retired (S14);
- a synthetic load of 100k players (`npm run perf:recruitment`) gives p50 under 5 ms on hot paths, with no request
  writing the whole database.

A domain that is in tables but still loaded whole into memory is only part-way there.

## 3. Status

34 migrations are registered in `repositories/index.mjs` (`DATA_MIGRATIONS`). The next free id is `0035`. Each step
takes the next free id; the placeholder ids in `sqlite-schema.md` mean nothing.

| Step | Domain | Migration | Repository | Status |
|---|---|---|---|---|
| S0–S7 | staff, sessions, orgs (+ `facets_json`), players and guardians, player sub-records, one-time codes, notifications, dispatches, outbox/push, message threads | `0001`–`0012` | `users`, `sessions`, `orgs`, `identity`, `mediaDeletions`, `playerSubrecords`, `oneTimeCodes`, `notifications`, `dispatches`, `outboxPush`, `channels` | done |
| S6b, S4b-R | safeguarding and audit; retained record on player deletion | `0013`, `0014` | `safetyAudit`, `identity` | done |
| S8a–d | recruitment: requests, trials, cases, rooms, decisions, contacts, offers, signings, follow-ups | `0015`–`0018` | `recruitment`, `recruitmentCases`, `recruitmentContactsOffers`, `signingsFollowUps` | done |
| S9a–d | scouting: evidence, assessments, club setup, opportunities and campaigns | `0019`–`0022` | `scoutingEvidence`, `scoutingAssessments`, `clubSetup`, `opportunitiesCampaigns` | done |
| S10a–c | verification, passport, transitions and vouches | `0023`–`0025` | `verification`, `passport`, `transitionsVouches` | done |
| S11a | agent profiles, affiliations, agreements, agency settings | `0026` | `agentCore` | done |
| S11b | T&S reviewers, policy versions; compliance contexts, evaluations, reviews, consents | `0027`, `0028` | `compliancePolicies`, `complianceRecords` | done |
| S11c | transactions, representation bindings, transaction documents | `0029` | `agentTransactions` | done |
| S12a | development objectives, drill-guidance reviews, Development Hub | `0030` | `development` | done |
| S12b | Box Cam, Combine and the CV results | `0031` | `boxCam` | done |
| S12c | discovery: Recruitment Briefs, Nobody Missed, Second Look, Dynamic Watchlists | `0032` | `discovery` | done |
| S12d | insight and coverage: exposure, review-later, evidence gaps, calibration, fixtures and coverage | `0033` | `insightCoverage` | done |
| S13a | integrations: CSV imports, prospects, identity reviews, API keys, webhooks | `0034` | `integrations` | done |
| S13b–e | enterprise; groups; grassroots operations; the remaining operations collections (§4.5) | | | **next** |
| S14 | retire the blob | | | not started |

Steps before S8 were staged (written at save) rather than explicit; S4a's identity writes are explicit since §4.3.1.

## 4. The order of work

### 4.3 The pattern (proved on recruitment)

The S8 repositories are the reference; `signingsFollowUps.mjs` is the simplest. For domains with many flat tables,
use the field specs in `repositories/fieldSpecs.mjs` (as `verification.mjs` does): they generate the typing, the rows
and the DDL, so these cannot drift, and include a `date` type for football dates stored in the precision given.

- **Tables.** Typed columns with the domain's vocabulary CHECKs, no side columns, no JSON columns. Lists are ordered
  child rows; a polymorphic detail is typed columns by kind. Client and idempotency keys, reminder markers and
  similar are columns or child rows of their owner, not shared tables. Secrets, tokens and codes are stored only as
  hashes.
- **Writes.** `create` and `update(id, (draft) => …)`: the update hands the route a plain copy, types the whole
  record, writes it at once and refuses an unknown field. Updating a record from inside its own update is refused.
  Shared mutators (`applyStatus`, `audit`, `bumpRev`) work unchanged on the draft; a seam other modules call does its
  own `update` and takes the extra detail its callers used to patch on afterwards.
- **Units of work.** Every route that writes more than one row (including its notifications and ledger rows) runs in
  one unit. A refusal is thrown inside the unit, replacing hand-written undo code. Routes check every field before
  writing anything. Staff writes (`users.mjs`) cannot join a unit yet: create the staff account before the unit.
- **Reads.** No mirror. The old `db.<collection>` name throws, naming the repository: don't delete it, or the `??= []`
  lines and `Array.isArray` guards quietly see an empty collection. The repository answers indexed queries (`byId`,
  `forOrg`, `forPlayer`, counts…) with fresh deep-frozen records; a read inside a unit sees the unit's writes. Modules
  receive a per-domain reads object on their context (`recruitmentReads`, `scoutingReads`, `verificationReads`,
  `agentReads`, `complianceReads`, `transactionReads`, `developmentReads`, `boxCamReads`, `discoveryReads`, `insightReads`, `integrationReads`); pure projectors take `reads`. Sweeps are indexed predicates, admin figures are
  `GROUP BY`s. Lists decode their records' child rows in one batch (`childRowsOf` in `repositories/database.mjs`),
  never a query per record.
- **Reads that write become sweeps or upserts.** A notice a read used to create comes from a sweep, its marker
  committing with its notification. A row inserted on first read becomes an explicit upsert, or the read returns
  defaults without a row.
- **Paging.** `domains/platform/paging.mjs`: `?limit=&cursor=` → `{ items, nextCursor }`, 50 by default, junk refused
  with 400, newest first by rowid where order isn't otherwise defined. Page lists that grow without limit;
  per-case, per-player and per-client lists don't. Where a screen counted a list, add a counts route. Apps read the
  first page and leave a comment that "load more" is needed.
- **Junk.** Routes refuse with the domain's existing codes (or `400 FIELD_INVALID` / `DATE_INVALID`), naming the
  field, where the old code clamped, cut off or coerced. Over-long free text may still be shortened.
- **Keys.** `org_id` and staff ids are `RESTRICT`. Player, guardian and media ids carry no key (tolerant: records
  outlive an account deletion, as before). Keys between tables of one domain are immediate `RESTRICT`.
  `DEFERRABLE INITIALLY DEFERRED` only for a key whose other side is still written by a staged hook at COMMIT.
- **Org facets.** To retire a facet from `orgs.facets_json`: the migration drops it with `json_remove`, `orgs.mjs`
  `RETIRED_FACETS` makes reading or writing it throw, and `orgSafe` (login, admin clubs) adds what the apps read from
  `session.org` explicitly. A whole-replace save of a list with dependants diffs by id, so kept rows keep their
  dependants.
- **Seeded catalogues** (templates, policy versions) are inserted by the migration.
- **Clean-up.** The `m182` steps that created or shaped the collections become recorded no-ops; the
  `*_STORE_MISSING` codes go with the collections.

**Lessons.**

- Probe the shapes first: instrument the old save and run the batteries to list every field the writers produce and
  every in-place write. Group writes by the first stack frame outside shared helpers (`audit`, `histAppend`), not the
  innermost, or helper callers hide. The throwing getters and read-only views catch what the probe misses.
- Typing the test fixtures finds drift (values the routes never accepted) before the batteries do.
- Batteries that planted partial literals now plant the writers' whole literals. Records a typed table cannot store
  are asserted to be refused by the save, naming the id; corruption a typed row can still carry stays planted and is
  judged on read.
- Domains that reference each other both ways convert together, or one first with deferred keys.

**Shapes later domains depend on.** One case-history entry shape, `{ id, at, byKind, byId, byName, action, detail }`.
A decision's `snapshot` is the `room_snapshots` row it names (`snapshot_id`), never a copy. A Room's `sourceRef` is
`{ id, version }` from every caller (M18 Nobody Missed and Second Look, M19 watchlists: S12). A compliance review's
snapshot is the evaluation row it was taken from (`<context>#<n>`). Signing, offer and transaction documents are
evidence records, read with `evidence.byId`.

**Step 2 (paging) and step 4 (the measurement).** `npm run perf:recruitment -- <players> <clones> <busy>` builds
synthetic players (`scripts/perfPopulation.mjs`), clones the S8 fixtures' recruitment graph onto real clubs, boots the
real server and times the hot routes over HTTP; `PERF_ONLY=<path>` limits it to matching routes, for a CPU profile.
The boot runs the sweeps before it listens, one transaction and one notification per due item, so a backlog is a
separate risk; the script moves the fixtures' instants to today to measure the steady state.

**Deferred: what still misses §2** (busy club / stress case). None blocks the next step:

- `/org/recruitment-analytics` (526 ms): needs its own projections in SQL, not decoded records. After S14.
- `/org/rooms` (197 ms) and a Room (10–12 ms): mostly the per-player Passport and Trust assembly, and a scan of the
  org's staff for each comment's author (`orgUsers` in `domains/recruitment/rooms/rooms.mjs`), which should use the
  staff index.
- `/player/journeys`, `/player/signings`, `/player/offers`, `/player/trials` for a player in 191 clubs' Rooms: each
  still decodes every record of each club's case. Revisit with projections after S14.
- The Room comment write (75 ms): the organisations' per-unit cost (§4.3.1).
- The Development Hub's plan list (S12a): the access rule (`planAccess`, with the live `orgCanSee`) is applied in code
  to one club's, one player's or one guardian's candidate plans, so the page is cut after filtering. Bounded by one
  club's plans, not the player base.
- Box Cam (S12b): an organisation's assignment, challenge and Combine request lists apply the visibility rule in code, so the page is cut after filtering (bounded by one club's); the Combine projection, Passport and Trust read one player's attempts and sessions. Not the player base.
- Transactions (S11c): a projection reads each transaction's consents, context and evaluation by id (a page's bindings and
  documents are one batch); the T&S stale-snapshot figure and the agency audit decode their records. Bounded by one
  agent's, one club's or the live transactions, not the player base.
- Discovery (S12c): matching, Nobody Missed and a watchlist's membership still scan the visible players in code (at
  most `LIMITS.maxCandidateScan`, 2,000, and the response says when it was cut short), building each player's facts from
  several domains. This is the one discovery read that grows with the player base: moving it to SQL needs those facts
  projected into a table. Second Look projects one club's ended Rooms. Opening a watchlist writes its reconciliation
  clock every time (the screen shows "as of"), the membership only when it changed.
- Insight and coverage (S12d): the exposure funnel, review queue and player bands are `GROUP BY`s over the 90-day
  window, but the queue then checks each player's live visibility in code, and the discovery rotation still scans
  `db.players` (identity's view). The coverage fixture list merges in the friendlies and open days, blob records until
  S13, so it keeps its offset paging. Bounded by one club's exposure, not the player base, except the rotation.

### 4.3.1 Costs that grow with the whole player base

Lookups by id go through the repositories' indexes (`byId` on every module context, `domains/platform/lookups.mjs`),
and player and guardian writes are explicit repository operations, so a write or a unit of work never touches every
player. `scripts/testUnitOfWork.mjs` holds that line: a player write costs the same number of SQL statements with 20
and 2,000 players. Players get their defaults at creation (`PLAYER_CREATION_DEFAULTS`), not by a boot backfill.

**Left:** an empty unit of work costs about 23 ms at 30k players, mostly the organisations (captured and flushed
whole per unit, because their remaining facets are still edited in place) and the blob collections' memento. Both go
as the remaining facets and collections move into tables, or sooner by making the organisations' facet writes
explicit like identity's.

### 4.4 Code and test layout

- Each step first moves its domain's files into `domains/<domain>/` in a commit with no other change, then edits
  them. The agents code is already in `domains/agents/` (`core/`, `compliance/`, `transactions/`), the development code
  in `domains/development/` (`objectives.mjs`, `hub/`, `boxcam/` with the CV engine in `boxcam/cv/`), the discovery code
  in `domains/discovery/` (Second Look, briefs and Nobody Missed; M19 matching and watchlists in `matching/`), the insight and coverage code in `domains/insight/` (`insight.mjs`, `coverage.mjs`; the F9 deal budgets in `domains/recruitment/budgets.mjs`), the M13 F1 imports, API keys and webhooks in `domains/integrations/imports.mjs`. Still in milestone folders: `m12`, `m13` (mixed: split file by file as each domain comes round; `domains/scouting/scouting.mjs` still
  holds the M12 recruitment-case routes, F3), `m20`, `m27` (`m20` and `m27` read across domains and are
  placed when their readers are). A step may move its domain's routes out of `server.mjs`. Whatever is left goes in a
  final pass after S14.
- End-to-end batteries live in `scoutbox-server/e2e/<domain>/`, named after what they check; add new checks to the
  domain's batteries. `operations/clubOperations` still holds the F2 section (verification) and other sections that
  move with their domains.

### 4.5 S12–S13: the remaining domains

One step per `sql/*.sql` file, split when a step gets too big to review (each part with its own migration). Each step
starts by moving its domain's code (§4.4).

| Step | Schema file | Collections | Watch out for |
|---|---|---|---|
| S12 Development, Box Cam, discovery | `07_development_boxcam_discovery.sql` | Split in four, one migration each. **S12a (done)**: `devObjectives`, `drillGuidance`, `development*`. **S12b (done)**: `boxCamPrefs`, `boxChallenges`, `boxChallengeEntries`, `boxAssignments`, `boxSessions`, `boxSessionEvents` (retired, no table), `boxCamDisputes`, `combineRequests`, `combineAttempts`, `boxCamCvResults`. **S12c (done)**: `recruitmentBriefs`, `nobodyMissedReviews`, `secondLookItems`, `dynamicWatchlists`, `watchlistHistory`. **S12d (done)**: `exposureEvents`, `reviewLater`, `evidenceSuggestions`, `calibrationSessions`, `fixtures`, `coveragePlans`, `coverageAssignments` | — |
| S13 Operations and integrations | `08_operations_integrations.sql` | Split in five, one migration each. **S13a (done)**: `importBatches`, `prospects`, `identityReviews`, `apiKeys`, `webhookEndpoints`, `webhookDeliveries`. **S13b**: `orgInvites`, `sso*`, `support*`. **S13c**: `groups`, `groupGrants`. **S13d**: `openTrials`, `matchdays`, `friendlies`. **S13e**: `uploadSessions`, `savedSearches`, `invoices`, `plans`, `archetypes`, `reputationSeed`, the `delivery*` singletons | Invites and SSO states are hashed. Invoices are stored exactly, in minor units. Production's empty first boot (catalogues only, demo opt-in with `SCOUTBOX_SEED_DEMO=1`) must survive the catalogues becoming rows. The player opportunity board pages once `openTrials` is a table (it merges opportunities and open days). A coverage assignment names a friendly or an open day by `event_id` with no key: give it one when `friendlies` and `openTrials` are tables, and page `/org/coverage/fixtures` by cursor. |

**Open from earlier steps** (not blocking): a coach affiliation is matched to a staff member by display name (a
Founder question: keying it by account restricts affiliations to people with a login); `orgs.verified` is synced by
code, not derived from claims; assessment templates are shared by every club until after S14 (`known-issues.md`).

### 4.6 S14: retire the blob

Depends on S2–S13. The `collections` table ends up empty. `meta.idCounter` moves to a `counters` table, and
`db.schema` is replaced by `data_migrations`. The `m182` snapshot migrations become no-ops. `mediaBlobs` and
`NOT_A_STORE` leave `storeContract.mjs` (`boxSessionEvents` left with S12b). The `db.x ??= []` and `migrateMxx` lines are deleted,
as is the blob fallback `readTrialsCollection` in `repositories/identity.mjs`. The contract test asserts zero blob
collections. The six `recruitment/*Persistence` batteries' checks that name the old storage go. The migrations
`0001`–`00NN` may be squashed into one baseline, if that helps.

## 5. How to do a step

### The process

1. Write a short design note **to the user**, not a new file: the tables, how the model differs from `sql/*.sql` and
   from the old behaviour, what junk is now rejected, and the tests. Ask the Founder only about product
   consequences, in product terms; if a question doesn't need him, don't ask it.
2. Implement. Run `cd scoutbox-server && npm test`, `npm run e2e` and, if anything in `scoutbox-player/` changed,
   `cd scoutbox-player && npm test`.
3. One review of the implementation, under the scope in [`../decisions.md`](../decisions.md) §1. A blocking finding is
   one a real user could hit through a real route. Everything else is a note.
4. Commit to the current branch, updating §3 (and §4.5 if the plan changed) in the same commit.

### The mechanics

Use `0018_signings_follow_ups.mjs` and `repositories/signingsFollowUps.mjs` as the template (and `fieldSpecs.mjs`
users such as `verification.mjs` for many flat tables). [`s8d-design-note.md`](s8d-design-note.md) is a fair example
of a design note's content, though longer than necessary.

- **Migration.** Create `repositories/migrations/NNNN_name.mjs`, exporting `id`, `note` and
  `up(sqlite, { now, ...context })`. Set `foreignKeysOff = true` only if the step rebuilds a referenced table.
  Register it in `repositories/index.mjs` (`import * as mNNNN` and an entry in `DATA_MIGRATIONS`). `up()` is the DDL
  (plus any table rebuild and seeded catalogue rows): there is no blob import.
- **Runner.** `runDataMigrations` (`repositories/database.mjs`) runs migrations in lexical order, one transaction each,
  records `(id, applied_at)` in `data_migrations`, and aborts the boot on failure. Under `foreignKeysOff`,
  `foreign_key_check` must be empty before commit. A domain is authoritative because its migration is recorded, never
  because a table exists.
- **Boot.** `server.mjs` runs `buildSeed()`, `loadSnapshot()`, the `m182` snapshot migrations, then
  `attachDataLayer`, which deletes the in-memory `db[name]` for table-backed collections and installs a throwing
  view (`repositories/readonly.mjs`).
- **Seed data.** `seed.mjs` fills only orgs, guardians and players. Other domains start empty and get rows through
  routes. Tests write their setup through the repositories, SQL, or a snapshot-mode save (`openStore(dir).save(…)`),
  using fixtures in the writers' shapes (e.g. `scripts/signingsFollowUpsTestFixtures.mjs`). They don't plant blob rows.
- **Repository.** `create<Domain>Repository({ sqlite, unit, now, log })` prepares statements. `operation(fn)` joins
  the open unit of work or opens its own transaction. Each write types its input, writes rows, and returns the stored
  record. Callers get the repository from `server.mjs`.
- **Units of work.** `store.unitOfWork(() => …)` is synchronous: one transaction, all or nothing; nested units join.
  Side effects (mail, push, live events) go through `store.afterCommit`. Provider calls happen before the unit.
- **Snapshot path.** Each domain exports a `*_SNAPSHOT` (`read`, `write`, `assert` with `foreign_key_check`) and adds
  its collections to `TABLE_BACKED` in `index.mjs`. Snapshot mode (tools, fixtures, the persistence suites) uses it,
  refusing junk with the `*_IMPORT_BLOCKED` codes. Backups don't: a backup is a `VACUUM INTO` copy (`store.copyTo`).
- **Reporting and tests.** Add a `/capabilities.dataLayer.domains` entry (`index.mjs`). Add `scripts/test<Domain>.mjs`
  to `SUITES` in `scripts/runTests.mjs` (`npm test` refuses to run while a `test*.mjs` suite is unlisted). Update
  `sql/*.sql` to match the real DDL (`testSchemaDdl.mjs`). Add new batteries to `BATTERIES` in `scripts/runE2E.mjs`
  (`npm run e2e` refuses to run while a file in `e2e/` is unlisted).

## 6. Open questions that touch the migration

From [`../decisions.md`](../decisions.md) §5:

- **Organisation deletion (O2).** Every `org_id` key is RESTRICT, and `suspended` is the only org state.
- **Retention (S4b, Q6).** Needs legal review before real users, not before the migration finishes. Until then an
  account deletion keeps the player's records under the old id.
- **Child-status stamping (Q2).** New columns if yes.
