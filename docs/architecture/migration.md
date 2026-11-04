# SQLite migration: the live plan

*Rewritten 3 November 2026. It replaces `sqlite-migration-plan.md` and the per-step readiness reviews,
which are now in the tag `docs-archive-2026-11`.*

The server is moving its data from one JSON blob (the `collections` table, read into `db.<collection>`
arrays in memory) to relational SQLite tables, one domain at a time. This document says where that stands,
what "done" means, and how to do the next step. Keep it current: update the status table in the same commit
as each step.

Related: the target schema is [`sqlite-schema.md`](sqlite-schema.md) (design rationale) and [`sql/*.sql`](sql/)
(executable DDL). The data-layer contract is in [`../../scoutbox-server/OPERATIONS.md`](../../scoutbox-server/OPERATIONS.md).
Decisions already taken are in [`../decisions.md`](../decisions.md).

---

## 1. Ground rules

These replace the old plan's principles where they conflict.

1. **There is no production data.** Every database is seed or test data. **Rollback means re-seed**
   (`npm run reseed`). No rollback scripts, no booting historical builds, no compatibility with files written
   by earlier development builds, no operator procedures.
2. **Better models are welcome.** `sql/*.sql` is a starting point. A step may redesign its tables (names,
   columns, keys, splitting or merging tables) when that gives a cleaner model. Update the `sql/*.sql` file to
   match (`scripts/testSchemaDdl.mjs` compares them column by column) and say what changed in the PR. Until
   S14, an already-registered migration's DDL may also be amended in place (its id doesn't change): re-seed
   afterwards. Don't write a migration just to drop or rename columns.
3. **Valid input only.** Each field is a properly typed column. No `absent_keys_json`, `offtype_json` or
   `extra_json` side columns. Where the old code accepted junk (wrong types, unknown fields), the route
   validates and rejects it. The import of existing blob data normalises or drops what doesn't fit and reports
   it with ids. It never fails the boot over seed junk unless the data is actually unusable.
4. **Explicit writes.** Routes change data by calling repository operations (`signings.record(…)`,
   `followUps.schedule(…)`). They do not edit in-memory objects and leave the save to find the changes. The S8d
   repository is the template.
5. **The end-to-end suites are the specification.** A domain is migrated when its existing suites pass. You may
   rewrite assertions that only describe the old storage, and say so in the commit. Never delete a behavioural
   assertion.
6. **The feature freeze holds until S14 is done.** Work in scope: the migration, defects, security, tests,
   and design changes the Founder explicitly requests.

What still holds from the old plan: one domain per step, after which `db.<collection>` is a read-only view;
additive numbered migrations whose ids never change; ids preserved, and token hashing keeps clients logged in;
tests use temporary directories only, never `scoutbox-server/data/`; one source of truth per domain, no dual
writes; no whole-collection re-projection on the save path; imports are deterministic and refuse duplicates
rather than merging them; each migration is one transaction, and the boot stops if it fails.

## 2. What "done" looks like

The migration is finished when:

- every domain lives in tables, owned by one repository each, written only through explicit operations;
- the hot reads are SQL queries with pagination (the org player directory, discovery, inboxes, case lists),
  not scans of in-memory arrays;
- the in-memory mirrors are gone for domains whose reads have moved to SQL;
- the blob store is retired (S14);
- a synthetic load of 100k players (`scripts/recruitmentPerf.mjs` for recruitment) gives p50 under 5 ms on hot paths, with
  no request writing the whole database.

Moving storage alone isn't the goal. A domain that is in tables but still loaded whole into memory (explicit writes,
but every read scanning a whole-collection mirror, as S8a–S8d were until 4 November) is only part-way there. The
recruitment domain now reads through SQL and its unbounded lists page (§4.3 step 2), and the step 4 fixes are in, but a few
routes still miss the bar: they are listed at the end of §4.3 step 4.

## 3. Status

18 migrations are registered in `repositories/index.mjs` (`DATA_MIGRATIONS`). The next free id is `0019`. Each
step takes the next free id; the placeholder ids in `sqlite-schema.md` mean nothing.

| Step | Domain | Migration | Repository | Write model | Status |
|---|---|---|---|---|---|
| S0 | staff accounts | `0001_org_users` | `users.mjs` | direct | done |
| S1 | identity shadow | `0002_core_identity_shadow` | (retired) | — | done |
| S2 | sessions | `0003_sessions_live` | `sessions.mjs` | direct | done |
| S3 | organisations | `0004_orgs_live` | `orgs.mjs` (+ `facets_json`) | facets flushed at save | done |
| S4a | players, guardians | `0005_core_identity_live`, `0006_media_deletions` | `identity.mjs`, `mediaDeletions.mjs` | explicit since §4.3.1 (snapshot mode still replaces whole) | done |
| S5 | player sub-records (12 tables) | `0007_player_subrecords` | `playerSubrecords.mjs` | via identity | done |
| S6a | one-time codes | `0008_one_time_codes` | `oneTimeCodes.mjs` | direct | done |
| S7a–d | notifications, dispatches, outbox/push, message threads | `0009`–`0012` | `notifications.mjs`, `dispatches.mjs`, `outboxPush.mjs`, `channels.mjs` | staged, written at save | done |
| S6b | safeguarding and audit (8 tables) | `0013_safety_audit` | `safetyAudit.mjs` | staged | done |
| S4b-R | retained record on player deletion | `0014_player_erasure` | `identity.mjs` | direct | done |
| S8a | recruitment requests, trials | `0015_recruitment` | `recruitment.mjs` | **explicit, typed, SQL reads** (§4.3, 3–4 Nov) | done |
| S8b | cases, rooms, decisions | `0016_recruitment_cases` | `recruitmentCases.mjs` | **explicit, typed, SQL reads** (§4.3, 4 Nov) | done |
| S8c | contacts, offers | `0017_recruitment_contacts_offers` | `recruitmentContactsOffers.mjs` | **explicit, typed, SQL reads** (§4.3, 3–4 Nov) | done |
| S8d | signing packages, signings, follow-ups, outcome reports | `0018_signings_follow_ups` | `signingsFollowUps.mjs` | **explicit, typed, SQL reads** (§4.3, 4 Nov) | done |
| — | rollback machinery removed | — | — | — | done (§4.1) |
| — | lossless side columns dropped outside recruitment | — | — | — | done (3 Nov) |
| — | backups become database copies | — | — | — | done (§4.2, 3 Nov) |
| — | recruitment end-state proof | — | — | — | §4.3 steps 1–3 done (4 Nov); step 4 items 1–4 done (4 Nov); what still misses §2 is listed in §4.3 |
| — | whole-player-base costs (lookups, identity writes) | — | `identity.mjs`, `orgs.mjs`, `users.mjs` | explicit (S4a-E) | done (§4.3.1, 4 Nov); the organisations' per-unit cost is left |
| — | end-to-end test estate | — | — | — | §4.4, any time before S9; steps 1–2 done (4 Nov) |
| — | server code by domain | — | — | — | §4.4.1: recruitment and platform before S9, then per step |
| S9 | scouting and assessment | | | | not started |
| S10 | verification and passport | | | | not started |
| S11 | agents, compliance, transactions | | | | not started |
| S12 | development, Box Cam, discovery | | | | not started |
| S13 | operations and integrations | | | | not started |
| S14 | retire the blob | | | | not started |

## 4. The order of work

### 4.1 Rollback and compatibility machinery removed (done 3 November)

The rollback tools, preflight scripts, historical-build boots, staleness refusals and their tests are gone. Kept:
`repositories/identityPreflight.mjs`, whose validator migration `0005` and the identity repository use.

### 4.2 Backups are database copies (done 3 November)

A backup is a `VACUUM INTO` copy of `scoutbox.db` next to `media/` and `manifest.json`; a restore copies it into a new,
empty directory and boots (never over a live one). The `db.json` import and every migration's blob import are gone;
tests don't plant blob rows. Snapshot mode (`openStore(dir).save(…)`) stays for fixtures and the persistence batteries:
it runs the table migrations and writes through each domain's `*_SNAPSHOT` writer, refusing junk with the
`*_IMPORT_BLOCKED` codes (the names were kept to avoid churn). One blob-era fallback remains:
`readTrialsCollection` in `repositories/identity.mjs` (goes with §4.3.1 item 2).

### 4.3 Prove the end state on recruitment

The aim was to make one domain look like §2, so S9–S13 copy a finished pattern. Steps 1–3 (explicit writes, SQL reads
with paging, no side columns) were done for S8a–S8d on 3–4 November; step 4 (the measurement) showed the §2 bar is not
met; §4.3.1 fixed part of it and the rest is listed below. Code comments cite "§4.3 step 2" and "§4.3 step 4":
keep those labels.

**The pattern, for S9–S13.** The S8 repositories are the reference; `signingsFollowUps.mjs` is the simplest.

- **Tables.** Typed columns with the domain's vocabulary CHECKs, no side columns. Client and idempotency keys,
  reminder markers and similar are columns or child rows of their owner, not shared tables.
- **Writes.** `create` and `update(id, (draft) => …)`: the update hands the route a plain copy, types the whole
  record, writes it at once and refuses an unknown field. Updating a record from inside its own update is refused.
  Shared mutators (`applyStatus`, `audit`, `bumpRev`) work unchanged on the draft; a seam other modules call (the
  lifecycle writer) does its own `update` and takes the extra detail its callers used to patch on afterwards.
- **Units of work.** Every route that writes more than one row runs in one unit. A refusal is thrown inside the
  unit, replacing hand-written undo code. Routes check every field before writing anything.
- **Reads.** No mirror. The old `db.<collection>` name throws, naming the repository: don't delete it, or the
  `??= []` lines and `Array.isArray` guards quietly see an empty collection. The repository answers indexed queries
  (`byId`, `forOrg`, `forPlayer`, `forCase`, counts…) with fresh deep-frozen records; a read inside a unit sees the
  unit's writes. Modules receive them as `recruitmentReads`; pure projectors take `reads`, and batteries that call
  projectors directly build `reads` over plain arrays with `scripts/recruitmentReadsFixture.mjs`. Sweeps are
  indexed predicates, admin figures are `GROUP BY`s.
- **Paging.** `domains/platform/paging.mjs`: `?limit=&cursor=` → `{ items, nextCursor }`, 50 by default, junk
  refused with 400, newest first by rowid where order isn't otherwise defined. Page lists that grow without limit;
  per-case, per-player and per-client lists don't. Where a screen counted a list, add a counts route
  (`GET /org/recruitment-counts`). Apps read the first page and leave a comment that "load more" is needed.
- **Clean-up.** The `m182` steps that created or shaped the collections become recorded no-ops; the
  `*_STORE_MISSING` codes go with the collections.
- **Keys.** Keys between tables of one domain are immediate `RESTRICT`. `DEFERRABLE INITIALLY DEFERRED` is only for
  a key whose other side is still written by a staged hook at COMMIT.

**Lessons for S9–S13.**

- Probe the shapes first: instrument the old save and run the batteries to list every field the writers produce and
  every in-place write. Group writes by the first stack frame outside shared helpers (`audit`, `histAppend`), not
  the innermost, or helper callers hide. The throwing getters and read-only views catch what the probe misses.
- Typing the test fixtures finds drift (values the routes never accepted) before the batteries do.
- Batteries that planted partial literals now plant the writers' whole literals. Records a typed table cannot store
  are asserted to be refused by the save, naming the id; corruption a typed row can still carry stays planted and is
  judged on read.
- Domains that reference each other both ways (requests/trials ↔ cases) convert together, or one first with
  deferred keys.

**Recruitment shapes later domains depend on.** One case-history entry shape,
`{ id, at, byKind, byId, byName, action, detail }`. A decision's `snapshot` is the `room_snapshots` row it names
(`snapshot_id`), never a copy. A Room's `sourceRef` is `{ id, version }` from every caller (M18 Nobody Missed and
Second Look, M19 watchlists: relevant to S12).

**What clubs see until "load more" exists.** The Requests, Trials, Trial days, Rooms and cases screens and the
Messages report picker show the newest 50. An older trial awaiting a report drops off the Trials screen, though the
home figure still counts it.

**Step 4: the measurement** (`npm run perf:recruitment -- <players> <clones> <busy>`). The script builds synthetic
players (`scripts/perfPopulation.mjs`), clones the S8 fixtures' recruitment graph onto real clubs and players, boots the
real server and times the hot routes over HTTP. The busy club has 500 graphs (2,000 cases, 1,500 requests, 500 trials);
a typical club has one or two and is near 5 ms everywhere. The first run (4 November) failed §2 on costs that grew with
the whole player base; §4.3.1 removed them. What is left, in the order to fix it, then re-measure:

1. **Done (4 November).** The trial-reminder sweep visited every confirmed, open trial every minute. It now asks
   `trials.remindersDue(now)`, which finds sessions starting within 48 hours through a start-time index and decodes
   only the trials with a reminder due (1,000 open trials: 252 ms → 1.6 ms).
2. **Done for Rooms, cases and funnels (4 November).** The per-viewer access rule, the views and the filters are SQL
   (`cases.pageForViewer`, `roomPageForViewer`, `roomStatusCounts(orgId, viewer)`), only the page is decoded, and a list
   of cases decodes its children in one batch rather than about sixteen queries a case. Needs-attention reads sets
   (overdue tasks, Rooms with a decision, reported trials) instead of per-Room lookups. The Rooms search needs the
   player's visibility, so it filters in code as the rows are read. Busy club: `/org/cases` 292 → 8 ms, rooms-funnel
   290 → 0.7 ms, needs-attention 422 → 4.4 ms, `/org/funnel` 35 → 0.7 ms. **Left:** `/org/rooms` is 126 ms, almost
   all of it the Passport and Trust assembly for each of the 50 players on the page (a typical club's three Rooms
   take 12 ms), which belongs to S10; and `/org/recruitment-analytics` (870 ms) decodes every record of the club in
   eight kinds. It needs its own projections read in SQL, not the decoded records.
3. **Done (4 November).** The audit feed built the club's whole history on each page. The Room, Contact and Trial
   histories are now paged in SQL per source (`newestHistory` in `repositories/database.mjs`, which keeps every row
   of a tied instant so the merged page is exact) and merged with the sources not yet in tables. The cursor is opaque
   (`[at, id]`) and must name a row of the club's own feed. Busy club 496 → 22 ms, most of it the perf script's
   cloned graphs, where hundreds of entries share one millisecond; a typical club takes 1.1 ms.
4. **Done (4 November).** The offers list and read opened a unit of work on every request, which costs the
   organisations' per-unit flush even when no receipt is new. They now open one only when a receipt is due
   (`receiptDue`), so reading seen offers commits nothing. `/player/offers` 27 → 6 ms, `/guardian/offers` 27 → 1.8 ms.

**What still misses §2 after items 1–4** (30k players, busy club, 4 November): `/org/recruitment-analytics` 890 ms
(item 2); `/org/rooms` 124 ms and a Room 10–22 ms (the per-player Passport and Trust assembly, S10); `/player/journeys`
38 ms, `/player/signings` 10 ms, `/org/trials` 11 ms (the page decodes each trial's ~14 child tables: batch-decode
them like cases); the Room comment write 66 ms (the organisations' per-unit cost, §4.3.1). Decide which of these are
hot paths before S9; the rest of recruitment is under 5 ms.

A backlog is a separate risk: the boot runs the sweeps before it listens, one transaction and one notification per due
item. The script moves the fixtures' instants to today so it measures the steady state.

### 4.3.1 Costs that grew with the whole player base (done 4 November)

Lookups by id go through the repositories' indexes (`byId` on every module context, `domains/platform/lookups.mjs`;
`usersOf` uses the staff index), and player and guardian writes are explicit repository operations (S4a-E), so a write
or a unit of work no longer touches every player. `scripts/testUnitOfWork.mjs` holds that line: a player write costs
the same number of SQL statements with 20 and 2,000 players. Players get their defaults at creation
(`PLAYER_CREATION_DEFAULTS`), not by a boot backfill.

Left over: an empty unit of work costs about 23 ms at 30k players, mostly the organisations (captured and flushed whole
per unit, about 14 ms for 1,500 clubs, because their facets are still edited in place) and the blob collections'
memento (about 4 ms). Both go as S9–S11 move those facets and collections into tables, or sooner by making the
organisations' facet writes explicit like identity's.

Baseline, `npm run perf:recruitment` (busy club, medians, before → after):

|                                | 10k players    | 30k players    |
|--------------------------------|----------------|----------------|
| `GET /org/audit`               | 3.1 s → 0.50 s | 9.0 s → 0.51 s |
| `POST /org/rooms/:id/comments` | 2.4 s → 26 ms  | 6.4 s → 51 ms  |
| `GET /player/offers`           | 1.3 s → 13 ms  | 3.5 s → 31 ms  |
| boot                           | 9 s → 3.1 s    | 18 s → 4.4 s   |

The comment write is at the 50 ms bar and still doubles from 10k to 30k players, because the synthetic population has
one club per 20 players (the organisations' per-unit cost above).

### 4.4 The end-to-end test estate

The behavioural specification is spread over 67 milestone-named scripts in `scoutbox-server/scripts/` (`m12E2E.mjs`
… `m23*`, `preM24SweepE2E.mjs`, about 3 MB). CI runs ten of them, plus `connectedE2E.mjs` and `apiE2E.mjs`. Some of
the rest fail (see [`../known-issues.md`](../known-issues.md)), and nobody knows the state of the others.

1. **Done (4 November).** Run every script once and record which pass, which fail and why (in the PR description).
   44 of 48 passed; the cheap failures are fixed, the rest are in `known-issues.md`.
2. **Done (4 November).** The performance and probe scripts are deleted; performance is re-evaluated once the
   migration is done. Kept: `recruitmentPerf` and `perfPopulation` (§2, §4.3 step 4) and `runtimeProbe` (used by
   `testRuntime`). `m22Robustness` and `m22Blocker` are correctness batteries, regrouped like the rest. The Box Cam
   evaluation tools moved to `scripts/tools/`: `boxCamCvEvaluation` (was `m22CvEval`) writes `m22/evaluation.json`,
   which the Combine production gate reads, and `boxCamCvHoldout` (was `m22Holdout`) writes `m22/holdout.json`. They
   are run by hand when the engine changes, never in CI.
3. Regroup the batteries by domain, not milestone, using the domain names of `sql/*.sql` and `domains/` (identity,
   recruitment, scouting, verification, agents, development, operations, platform). Move and rename first, with no
   content changes, in one commit; merge duplicates in separate commits, with a count of checks before and after
   each merge. Never delete a behavioural assertion.
4. Put every passing battery in CI, through a runner like `scripts/runTests.mjs`: parallel, and refusing to run while
   a battery is unlisted. Fix the cheap failures; list any that stay out, with the reason, in `known-issues.md`.
5. Name tests after what they check, not after the review that produced them ("review of 2fe05df, R1"). The unit
   suites (`scripts/test*.mjs`) get the same treatment. Do this last.

This is independent of the storage work and can run in parallel, but it should be done before S9, so new domains
add to the regrouped batteries.

### 4.4.1 Server code by domain

The server code is organised by milestone (`m12/` … `m29/`) and `server.mjs` holds routes from every domain. It moves
into `domains/<domain>/` alongside the migration, not as a separate rewrite:

- **Before S9**, after §4.4: move recruitment (`m17`, `m23`, `m28`, `m29`) and platform (`m181`, `m182`) into
  `domains/recruitment/` and `domains/platform/`. File moves and import paths only, in one commit, so S9 copies a
  finished layout. Most cross-milestone imports point at these two.
- **Each of S9–S13** first moves its domain's files, in a commit with no other change, then edits them. The mixed
  folders (`m12`, `m13`, `m14`) are split file by file as each domain's step comes round; `m20` and `m27` read across
  domains and are placed when their readers are. A step may move its domain's routes out of `server.mjs` while it
  rewrites them.
- **After S14**: a final pass over whatever is left in milestone folders and `server.mjs`.

### 4.5 S9–S13: the remaining domains

One step per `sql/*.sql` file, split only if a step gets too big to review. Each is a short branch and a PR into `main`.
Each step starts by moving its domain's code into `domains/<domain>/` (§4.4.1).

| Step | Schema file | Tables | Collections | Depends on | Watch out for |
|---|---|---|---|---|---|
| S9 Scouting and assessment | `04_scouting_assessment.sql` | 33 | `evidence`, `coachAffiliations`, `squadInvites`, `assessmentTemplates`, `assessments`, `videoSegments`, `playlists`, `vacancies`, `opportunities`, `applications`, `campaigns`, `campaignSubmissions`, `playerPrefs`; the org facets `tactical`, `squad`, `lookingFor`, `federationCheck` move out of `orgs.facets_json` | S5, S8, §4.3.1 | Template ids repeat across versions, so the key is `(id, version)`. A tactical re-save must diff roles by id so vacancies keep `role_id`. Coach affiliations are keyed by user id. `playerPrefs` is inserted on read, so it needs an upsert. Squads come in four shapes. Player foreign keys: tolerant, like recruitment, unless there's a reason not to. |
| S10 Verification and passport | `05_verification_passport.sql` | 31 | the `ver*` collections (including `verMigrated`), `passportPrefs`, `passportCareerEntries`, `passportAchievements`, `passportShares`, `passportCorrections`, `transitionCases`, `representations`, `vouches`; the `orgs.verification` facet | S4, S9 | `orgs.verified` becomes derived from claims. Raw passport dates stay raw. Tokens and vouch codes are hashed. One identity claim per user; self-verification is refused. |
| S11 Agents, compliance, transactions | `06_agent_compliance_transactions.sql` | 61 | `agentProfiles`, `agencyAffiliations`, `representationAgreements`, `tsReviewers`, `jurisdictionPolicies`, `regulatoryReviews`, `regulatoryConsents`, `complianceContexts`, `agentTransactions`, `transactionRepresentations`, `transactionDocuments`; `orgs.agencySettings` | S8, S10 | Uniqueness on an *effective* status stays in code. Policies are published under dual control. Each consent can be revoked once. Minors are refused on agreements. Reviewer secrets are hashed. |
| S12 Development, Box Cam, discovery | `07_development_boxcam_discovery.sql` | 57 | about 30: `devObjectives`, `drillGuidance`, `boxCam*`/`box*`, `combine*`, `recruitmentBriefs`, `nobodyMissedReviews`, `secondLookItems`, `dynamicWatchlists`, `watchlistHistory`, `development*`, `exposureEvents`, `reviewLater`, `evidenceSuggestions`, `calibrationSessions`, `fixtures`, `coverage*` | S5, S8, S9 | Reads that write (Second Look and watchlist reconciliation, evidence suggestions) become explicit upserts. Hash the nonce. Split `fixture_id` into kind and id. Consent gate; one entry per challenge and player. |
| S13 Operations and integrations | `08_operations_integrations.sql` | 45 | `apiKeys`, `webhook*`, `orgInvites`, `sso*`, `support*`, `importBatches`, `prospects`, `identityReviews`, `groups`, `groupGrants`, `uploadSessions`, `savedSearches`, `openTrials`, `matchdays`, `friendlies`, `invoices`, `plans`, `archetypes`, `reputationSeed`, the `delivery*` singletons | S3, S8 | Invites and SSO states are hashed. Invoices are stored exactly, in minor units. Backup becomes `VACUUM INTO`. Production's empty first boot (catalogues only, demo opt-in with `SCOUTBOX_SEED_DEMO=1`) exists since 3 Nov; keep it when the catalogues become rows. |

S12 is large; consider splitting Box Cam/Combine from discovery and watchlists.

### 4.6 S14: retire the blob

Depends on S2–S13. The `collections` table ends up empty. `meta.idCounter` moves to a `counters` table, and
`db.schema` is replaced by `data_migrations`. The `m182` snapshot migrations become no-ops. `mediaBlobs`, `boxSessionEvents` and `NOT_A_STORE` leave
`storeContract.mjs`. The `db.x ??= []` and `migrateMxx` lines are deleted. The contract test asserts zero blob
collections. With no production data, the migrations `0001`–`00NN` may be squashed into one baseline at this
point, if that helps.

## 5. How to do a step

### The process

1. Branch from `main` (`migrate/s9-scouting`).
2. Write a short design note **in the PR description**, not a new file: the tables, how the model differs from
   `sql/*.sql` and from the old behaviour, what junk is now rejected, and the tests. Ask the Founder only about
   product consequences, in product terms; if a question doesn't need him, don't ask it.
3. Implement (§5.2). Run `cd scoutbox-server && npm test`, the domain's end-to-end scripts and, if anything in
   `scoutbox-player/` changed, `cd scoutbox-player && npm test`.
4. One review of the implementation, under the scope in [`../decisions.md`](../decisions.md) §1. A blocking
   finding is one a real user could hit through a real route. Everything else is a note.
5. Merge to `main`. Update the status table in §3 in the same PR.

### The mechanics

Use `0018_signings_follow_ups.mjs` and `repositories/signingsFollowUps.mjs` as the template. [`s8d-design-note.md`](s8d-design-note.md)
is the design note for that step: a fair example of the content a PR description needs, though longer than necessary.

- **Migration.** Create `repositories/migrations/NNNN_name.mjs`, exporting `id`, `note` and
  `up(sqlite, { now, ...context })`. Set `foreignKeysOff = true` only if the step rebuilds a referenced table. Register
  it in `repositories/index.mjs` (`import * as mNNNN` and an entry in `DATA_MIGRATIONS`). `up()` is the DDL only (plus
  any table rebuild the step needs): there is no blob import. A domain's existing blob rows are not carried over;
  rollback means re-seed.
- **Runner.** `runDataMigrations` (`repositories/database.mjs`) runs migrations in lexical order, one transaction
  each, records `(id, applied_at)` in `data_migrations`, and aborts the boot on failure. Under `foreignKeysOff`,
  `foreign_key_check` must be empty before commit. A domain is authoritative because its migration is recorded,
  never because a table exists.
- **Boot.** `server.mjs` runs `buildSeed()`, `loadSnapshot()` (saved blobs replace the seed), the `m182` snapshot
  migrations, then `attachDataLayer`. That deletes the in-memory `db[name]` for table-backed collections and installs
  a read-only view (`repositories/readonly.mjs`), so existing readers keep working and a direct write throws.
- **Seed data.** `seed.mjs` fills only orgs, guardians and players. Domains from S8a on start empty on a fresh
  database and get rows through routes. Tests write their setup through the repositories, SQL, or a snapshot-mode
  save (`openStore(dir).save(…)`, which writes into the tables), using fixtures in the writers' shapes (e.g.
  `scripts/signingsFollowUpsTestFixtures.mjs`). They don't plant blob rows.
- **Repository.** `create<Domain>Repository({ sqlite, unit, now, log })` prepares statements. `operation(fn)` joins
  the open unit of work or opens its own transaction. Each write types its input, writes rows, and returns the
  stored record. While a domain keeps an in-memory mirror, the write refreshes it from SQL. `hook()` registers
  `snapshotState`/`restoreState` so a rolled-back unit restores the mirror. Callers get the repository from
  `server.mjs`.
- **Units of work.** `store.unitOfWork(() => …)` is synchronous: one transaction, all or nothing, memory restored on
  failure; nested units join. Side effects (mail, push, live events) go through `store.afterCommit`. Provider calls
  happen before the unit, never inside it.
- **Snapshot path.** Each domain exports a `*_SNAPSHOT` (`read`, `write`, `assert` with `foreign_key_check`) and adds
  its collections to `TABLE_BACKED` in `index.mjs`. Snapshot mode (tools, fixtures, the persistence suites) uses it.
  Backups don't: a backup is a `VACUUM INTO` copy of the database (`store.copyTo`).
- **Reporting and tests.** Add a `/capabilities.dataLayer.domains` entry (`index.mjs`). Add `scripts/test<Domain>.mjs`
  to `SUITES` in `scripts/runTests.mjs` (`npm test` refuses to run while a `test*.mjs` suite is unlisted).
  Update `sql/*.sql` to match the real DDL (`testSchemaDdl.mjs`). Add the domain's passing end-to-end batteries
  to `.github/workflows/ci.yml`.

## 6. Open questions that touch the migration

From [`../decisions.md`](../decisions.md) §5:

- **Organisation deletion (O2).** Every `org_id` key is RESTRICT, and `suspended` is the only org state.
- **Retention (S4b, Q6).** Needs legal review before real users, not before the migration finishes.
- **Child-status stamping (Q2).** New columns if yes.

Q3 and A0–A3 are effectively moot: re-seeding removes the old ids, and explicit identity writes remove the
whole-snapshot rewrite that A0–A3 were about.
