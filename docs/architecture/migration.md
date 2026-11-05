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
routes still miss the bar: they are listed, and deferred, at the end of §4.3 step 4.

## 3. Status

27 migrations are registered in `repositories/index.mjs` (`DATA_MIGRATIONS`). The next free id is `0028`. Each
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
| — | recruitment end-state proof | — | — | — | §4.3 steps 1–3 done (4 Nov); step 4 items 1–5 done (4 Nov); what still misses §2 is deferred (§4.3) |
| — | whole-player-base costs (lookups, identity writes) | — | `identity.mjs`, `orgs.mjs`, `users.mjs` | explicit (S4a-E) | done (§4.3.1, 4 Nov); the organisations' per-unit cost is left |
| — | end-to-end test estate | — | — | — | done (§4.4, 4 Nov) |
| — | server code by domain | — | — | — | recruitment, platform, scouting and verification done (§4.4.1, 4 Nov); the rest per step |
| S9a | evidence passport, coach affiliations, squad invitations | `0019_scouting_evidence` | `scoutingEvidence.mjs` | **explicit, typed, SQL reads** (4 Nov) | done |
| S9b | assessment templates, assessments, video segments, playlists | `0020_scouting_assessments` | `scoutingAssessments.mjs` | **explicit, typed, SQL reads** (4 Nov) | done |
| S9c | tactical setup, squad, shadow list, looking-for, federation check, vacancies | `0021_club_setup` | `clubSetup.mjs` | **explicit, typed, SQL reads** (4 Nov) | done |
| S9d | opportunities, applications, campaigns, player preferences | `0022_opportunities_campaigns` | `opportunitiesCampaigns.mjs` | **explicit, typed, SQL reads** (4 Nov) | done |
| S10a | verification claims, evidence, tokens, administrators, root applications, disputes, references, squad invitations by code, conflicts, domain requests, verified domains | `0023_verification` | `verification.mjs` | **explicit, typed, SQL reads** (4 Nov) | done |
| S10b | passport preferences, career entries, achievements, shares, corrections | `0024_passport` | `passport.mjs` | **explicit, typed, SQL reads** (4 Nov) | done |
| S10c | transition cases, coach references (vouches) | `0025_transitions_vouches` | `transitionsVouches.mjs` | **explicit, typed, SQL reads** (5 Nov) | done; the legacy representations moved to S11 |
| S11a | agent profiles, agency affiliations, representation agreements, agency settings; the legacy representation lane removed | `0026_agent_core` | `agentCore.mjs` | **explicit, typed, SQL reads** (5 Nov) | done |
| S11b-1 | Trust & Safety reviewers, jurisdiction policy versions (the seeded versions inserted by the migration) | `0027_compliance_policies` | `compliancePolicies.mjs` | **explicit, typed, SQL reads** (5 Nov) | done |
| S11b-2 | regulatory reviews, compliance contexts and evaluations, consents | | | | not started |
| S11c | transactions | | | | not started |
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

5. **Done (4 November).** Every list decodes its records' child rows in one batch: one query per child table for the
   whole list (`childRowsOf` in `repositories/database.mjs`, one prepared statement per table, the ids passed as JSON),
   for trials, contacts, offers, decisions, signing packages and signings as for cases. A player's journey list reads
   the player's records once for all their cases (`domains/recruitment/lifecycle/journeyReads.mjs`, through the bulk
   reads `forCases` and `decisions.forRooms`) instead of a dozen queries a case, and a recipient's signings read their
   offers, cases and signing rows once (`lookupsForPlayers`). Measured back to back with the code before (30k players,
   the popular player in 191 clubs' Rooms, so these are worst cases): `/player/journeys` 646 → 166 ms,
   `/player/signings` 158 → 65 ms, `/player/trials` 48 → 15 ms, `/org/trials` 12 → 4.5 ms; as a side effect
   `/org/rooms` 299 → 197 ms (typical club 201 → 85 ms) and `/org/recruitment-analytics` 869 → 526 ms. A single Room
   showed no clear change (10.2 → 10.4 ms on the same database; up to 2 ms slower in other pairs of runs).
   `PERF_ONLY=<path>` limits the script to matching routes, for a CPU profile of one route.

**Deferred: what still misses §2** (decided 4 November). None of these blocks S9:

- `/org/recruitment-analytics` (526 ms busy club, 14 ms typical): an occasional reporting page, not a hot path. It
  needs its own projections in SQL, not the decoded records. After S14, in the performance pass.
- `/org/rooms` (197 ms busy club) and a Room (10–12 ms): most of the time is the per-player Passport and Trust
  assembly, which S10 rewrites, and a scan of the organisation's staff for each comment's author (`orgUsers` in
  `domains/recruitment/rooms/rooms.mjs`), which goes when that read uses the staff index.
- `/player/journeys` (166 ms), `/player/signings` (65 ms), `/player/offers` (74 ms) and `/player/trials` (15 ms) for a
  player in 191 clubs' Rooms (the perf script's stress case): each still decodes every record of each club's case, so
  the cost grows with the number of clubs. Revisit with projections after S14.
- The Room comment write (75 ms): the organisations' per-unit cost (§4.3.1), which S9–S11 remove as the facets move
  into tables.

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

The behavioural specification was spread over 67 milestone-named scripts in `scoutbox-server/scripts/` (`m12E2E.mjs`
… `m23*`, `preM24SweepE2E.mjs`, about 3 MB), of which CI ran thirteen plus `connectedE2E.mjs` and `apiE2E.mjs`. The
correctness batteries now live in `scoutbox-server/e2e/<domain>/`, named after what they check.

1. **Done (4 November).** Run every script once and record which pass, which fail and why (in the PR description).
   44 of 48 passed; the cheap failures are fixed, the rest are in `known-issues.md`.
2. **Done (4 November).** The performance and probe scripts are deleted; performance is re-evaluated once the
   migration is done. Kept: `recruitmentPerf` and `perfPopulation` (§2, §4.3 step 4) and `runtimeProbe` (used by
   `testRuntime`). `m22Robustness` and `m22Blocker` are correctness batteries, regrouped like the rest. The Box Cam
   evaluation tools moved to `scripts/tools/`: `boxCamCvEvaluation` (was `m22CvEval`) writes `m22/evaluation.json`,
   which the Combine production gate reads, and `boxCamCvHoldout` (was `m22Holdout`) writes `m22/holdout.json`. They
   are run by hand when the engine changes, never in CI.
3. Regroup the batteries by domain, not milestone, using the domain names of `sql/*.sql` and `domains/` (identity,
   recruitment, scouting, verification, agents, development, discovery, operations, platform). Move and rename first,
   with no content changes, in one commit; merge duplicates in separate commits, with a count of checks before and
   after each merge. Never delete a behavioural assertion. **Done (4 November).** 50 batteries moved, the same checks
   before and after. `platform/bootContract` merged into `platform/storeGuarantees` (one shared check ran twice).
   `operations/clubOperations` (was `m13E2E`) split: F4–F7 are `discovery/exposureCalibrationAndCoverage`; F2, F3 and
   F10 move with S10, S9 and S11. Not merged, on inspection: the six `recruitment/*Persistence` batteries test six
   different records (33 of their 526 checks name the old storage, already rewritten to the tables; they go with S14),
   and `scouting/clubWorkflows` (was `m12E2E`) is one chained journey, mostly scouting, which S9 extends.
4. **Done (4 November).** `npm run e2e` (`scripts/runE2E.mjs`, sharing `scripts/suiteRunner.mjs` with `npm test`) runs
   all 50 batteries, four at a time (about 70 s), and refuses to run while a file in `e2e/` is unlisted. CI runs it. The
   two checks that fail for a recorded reason are `knownFailure` checks (`e2e/support/`), so their batteries stay in CI.
5. **Done (4 November).** Tests are named after what they check, not after the review that produced them: 57 unit
   tests lost their "review of <sha>, finding N" prefixes, and each battery's summary names the battery
   (`recruitment/offers: 447 checks passed`), not the milestone. New tests follow the same rule.

This is independent of the storage work and can run in parallel, but it should be done before S9, so new domains
add to the regrouped batteries.

### 4.4.1 Server code by domain

The server code is organised by milestone (`m12/` … `m29/`) and `server.mjs` holds routes from every domain. It moves
into `domains/<domain>/` alongside the migration, not as a separate rewrite:

- **Before S9**, after §4.4: move recruitment (`m17`, `m23`, `m28`, `m29`) and platform (`m181`, `m182`) into
  `domains/recruitment/` and `domains/platform/`. File moves and import paths only, in one commit, so S9 copies a
  finished layout. Most cross-milestone imports point at these two. **Done (4 November).** `m17` is
  `domains/recruitment/rooms/`, `m23` `lifecycle/`, `m28` `offers/`, `m29` `signings/` (subfolders, because each had
  its own `index.mjs` and `errors.mjs`); `m181` and `m182` share `domains/platform/`. File names are unchanged. The
  batteries that scan source by folder name the new folders, and `platform/storeGuarantees` names a file's module by
  its folder under `domains/`.
- **Each of S9–S13** first moves its domain's files, in a commit with no other change, then edits them. **S9: done (4 November):** `m12/passport.mjs`, `m12/scouting.mjs`, `m12/journeys.mjs` and `m13/suitability.mjs` are in `domains/scouting/` (`scouting.mjs` still holds the M12 recruitment-case routes, F3, which move with the final pass). **S10: done (4 November):** `m14/` is `domains/verification/claims/`, `m15/` `passport/`,
  `m162/` `trust/` (subfolders: each has its own `index.mjs` and `shared.mjs`), and `m13/transitions.mjs` is
  `domains/verification/transitions.mjs`. **S11: done (5 November):** `m24/` is `domains/agents/core/`, `m25/`
  `compliance/`, `m26/` `transactions/`. The mixed
  folders (`m12`, `m13`) are split file by file as each domain's step comes round; `m20` and `m27` read across
  domains and are placed when their readers are. A step may move its domain's routes out of `server.mjs` while it
  rewrites them.
- **After S14**: a final pass over whatever is left in milestone folders and `server.mjs`.

### 4.5 S9–S13: the remaining domains

One step per `sql/*.sql` file, split only if a step gets too big to review. S9 is split in four (S9a–S9d, the §3 table),
each with its own migration: evidence first (most readers, self-contained), then assessments, then the org facets and
vacancies (roles before the vacancies and squad rows that name them), then opportunities and campaigns. Each is a short branch and a PR into `main`.
Each step starts by moving its domain's code into `domains/<domain>/` (§4.4.1).

| Step | Schema file | Tables | Collections | Depends on | Watch out for |
|---|---|---|---|---|---|
| S9 Scouting and assessment | `04_scouting_assessment.sql` | 33 | `evidence`, `coachAffiliations`, `squadInvites`, `assessmentTemplates`, `assessments`, `videoSegments`, `playlists`, `vacancies`, `opportunities`, `applications`, `campaigns`, `campaignSubmissions`, `playerPrefs`; the org facets `tactical`, `squad`, `lookingFor`, `federationCheck` move out of `orgs.facets_json` | S5, S8, §4.3.1 | Template ids repeat across versions, so the key is `(id, version)`. A tactical re-save must diff roles by id so vacancies keep `role_id`. Coach affiliations are keyed by user id. `playerPrefs` is inserted on read, so it needs an upsert. Squads come in four shapes. Player foreign keys: tolerant, like recruitment, unless there's a reason not to. |
| S10 Verification and passport | `05_verification_passport.sql` | 31 | the `ver*` collections (including `verMigrated`), `passportPrefs`, `passportCareerEntries`, `passportAchievements`, `passportShares`, `passportCorrections`, `transitionCases`, `vouches`; the `orgs.verification` facet | S4, S9 | `orgs.verified` becomes derived from claims. Raw passport dates stay raw. Tokens and vouch codes are hashed. One identity claim per user; self-verification is refused. |
| S11 Agents, compliance, transactions | `06_agent_compliance_transactions.sql` | 61 | `representations` (the legacy M13 F10 lane: removed in S11a with its routes and screens), `agentProfiles`, `agencyAffiliations`, `representationAgreements`, `tsReviewers`, `jurisdictionPolicies`, `regulatoryReviews`, `regulatoryConsents`, `complianceContexts`, `agentTransactions`, `transactionRepresentations`, `transactionDocuments`; `orgs.agencySettings` | S8, S10 | Uniqueness on an *effective* status stays in code. Policies are published under dual control. Each consent can be revoked once. Minors are refused on agreements. Reviewer secrets are hashed. |
| S12 Development, Box Cam, discovery | `07_development_boxcam_discovery.sql` | 57 | about 30: `devObjectives`, `drillGuidance`, `boxCam*`/`box*`, `combine*`, `recruitmentBriefs`, `nobodyMissedReviews`, `secondLookItems`, `dynamicWatchlists`, `watchlistHistory`, `development*`, `exposureEvents`, `reviewLater`, `evidenceSuggestions`, `calibrationSessions`, `fixtures`, `coverage*` | S5, S8, S9 | Reads that write (Second Look and watchlist reconciliation, evidence suggestions) become explicit upserts. Hash the nonce. Split `fixture_id` into kind and id. Consent gate; one entry per challenge and player. |
| S13 Operations and integrations | `08_operations_integrations.sql` | 45 | `apiKeys`, `webhook*`, `orgInvites`, `sso*`, `support*`, `importBatches`, `prospects`, `identityReviews`, `groups`, `groupGrants`, `uploadSessions`, `savedSearches`, `openTrials`, `matchdays`, `friendlies`, `invoices`, `plans`, `archetypes`, `reputationSeed`, the `delivery*` singletons | S3, S8 | Invites and SSO states are hashed. Invoices are stored exactly, in minor units. Backup becomes `VACUUM INTO`. Production's empty first boot (catalogues only, demo opt-in with `SCOUTBOX_SEED_DEMO=1`) exists since 3 Nov; keep it when the catalogues become rows. |

S12 is large; consider splitting Box Cam/Combine from discovery and watchlists.

S11 is split like S10: S11a the agent core (`domains/agents/core/`, and the legacy M13 F10 lane removed first), S11b
the compliance engine (`compliance/`), S11c the transaction workspace (`transactions/`).

S10 is split in three, each with its own migration: S10a the verification claims (`domains/verification/claims/`, 18
tables), S10b the passport's own records (`domains/verification/passport/`), S10c transition cases and coach references
(`domains/verification/transitions.mjs`, the vouch routes in `server.mjs`). The Trust Score (`trust/`) stores
nothing.

**S9a as built (4 November).** `repositories/scoutingEvidence.mjs`, migration `0019`; modules read through
`scoutingReads` (projectors that take `reads` get `reads.evidence`). Player and media ids carry no key (tolerant, as
recruitment: evidence and invitations stay after an account deletion, as before); `org_id` and staff ids are RESTRICT; the
evidence value is a number or a short text (two columns). A correction, a corroboration, a dispute resolution and an
approved invitation each commit as one unit (since S9c the invitation's squad row is a row of org_squad_members). The admin
dispute and coach lists keep their offset paging (the admin app's shape), now in SQL. Routes refuse junk with
`400 FIELD_INVALID` / `DATE_INVALID` naming the field; over-long text is still shortened. **Open for the Founder:** a coach
affiliation is still matched to a staff member by display name. Keying it by staff account means only people with a
ScoutBox login can be affiliated coaches, and the Grassroots "Coach name" box becomes a pick-list.

**S9b as built (4 November).** `repositories/scoutingAssessments.mjs`, migration `0020`, which also inserts the four v1
templates (they were pushed into memory at registration; every database now has them from its first boot). Modules
read through `scoutingReads` (`templates`, `assessments`, `segments`, `playlists`); projectors that take `reads` get
`reads.assessments`, and the M23 journey's last `db` store is gone (`JOURNEY_REQUIRED_STORES` is empty; a missing
`reads.assessments` is reported as the missing `assessments` store). An assessment's attributes snapshot is the
template version's attributes, joined on read; the anchors are five columns; segment labels, ratings, cited evidence
and playlist segments are ordered child rows. Player, media, trial and session ids carry no key (tolerant); org and
staff ids RESTRICT; the template, first opinion, cited segments and playlist segments are RESTRICT keys inside the
domain. A submission with its ledger entry, and a publication with its notifications, each commit as one unit. Routes
refuse junk (`400 FIELD_INVALID` / `DATE_INVALID`, field named; half ratings, duplicate attributes, unknown context or
reference fields, non-object references and drawings, non-numeric segment times); over-long text is still shortened.
The calibration and group-template routes now pin a template's current version rather than v1. The club assessment
and segment lists keep their offset paging (`paginate`), over SQL-narrowed rows. **Decided (4 November):** templates
stay shared by every club until the migration is finished (a known defect, `known-issues.md`).

**S9c as built (4 November).** `repositories/clubSetup.mjs`, migration `0021`, read through `scoutingReads`. **Decided with
the Founder: the shadow list is not the squad** (its own table, `org_shadow_players`); a shadowed player counts nowhere a
squad member does, except as "considered" in Nobody Missed. For S10/S11, which retire the remaining org facets
(`verification`, `agencySettings`): the migration drops the facet from `orgs.facets_json` with `json_remove`, `orgs.mjs`
`RETIRED_FACETS` makes reading or writing it on an org record throw, and `orgSafe` (login, admin clubs) must then add
what the apps read from `session.org` explicitly. A whole-replace save of a list with dependants (tactical roles) diffs
by id, so kept rows keep their dependants and dropped ones leave them `SET NULL`.

**S9d as built (4 November).** `repositories/opportunitiesCampaigns.mjs`, migration `0022`, read through `scoutingReads`
(`opportunities`, `applications`, `campaigns`, `campaignSubmissions`, `playerPrefs`). No JSON columns: requirements, tags and
accommodations are `opportunity_texts` rows, drills and the rubric their own tables, a file check's issues are codes, the
approved suitability summary is one row per dimension. Player and media ids carry no key (tolerant); org and staff ids
RESTRICT; an application's opportunity and a submission's campaign RESTRICT inside the domain. One live application per
opportunity and player, one submission per campaign and player. Applying, an outcome, an attempt and a review each commit
as one unit with their notifications (and the ledger row); the reminder sweep is an indexed query whose marker commits
with its notification. Routes refuse junk (`400 FIELD_INVALID`, field named): unknown categories, position groups and
levels, bad ages, radius and capacity, too many requirements, drills or rubric lines and out-of-range attempts (all
cut off or clamped before), duplicate drill names, an attempt at a drill the campaign lacks, bad slot days, times and
time zones, bad currencies, fees, transports and relocations. Behaviour changes: reading preferences no longer
creates a row (a player who never saved gets the blank defaults, without an `id`); a guardian's withdrawal is recorded
as the guardian's; `GET /org/opportunities` and `GET /org/campaigns` page by cursor (the apps read the first page). The
player board still checks eligibility in code over the open opportunities (an indexed query); it pages with discovery
(S12). **Left as before, for the Founder (retention, `decisions.md` Q6):** an account deletion keeps the player's
applications, campaign submissions and private preferences (accessibility needs included) under the old id.

**S10a as built (4 November).** `repositories/verification.mjs`, migration `0023`, read through `verificationReads` (on
every module context). Its field specs generate the typing, the rows and the DDL, so they cannot drift: copy that for
domains with many flat tables. The code's uniqueness rules are partial unique indexes. The `verification` org facet is
retired (`org_verified_domains` rows, column `verification_revoked_at`). Signing, offer and transaction documents are
evidence records, read with `evidence.byId` (S11). Staff writes cannot join a unit of work yet (`users.mjs`), so root
approval creates the organisation and account before its unit. **Left for S10:** `orgs.verified` is synced by code,
not derived from claims.

**S10b as built (4 November).** `repositories/passport.mjs`, migration `0024`, read through `verificationReads`. The
field-spec helpers now live in `repositories/fieldSpecs.mjs`, shared with S10a: use them for later domains. They add a
`date` type, a football date stored in the precision given (`YYYY`, `YYYY-MM` or `YYYY-MM-DD`).

**S10c as built (5 November).** `repositories/transitionsVouches.mjs`, migration `0025`, read through `verificationReads`
(`transitionCases`, `vouches`), field specs as S10a/S10b. A transition case's pack items, grants and history are ordered child
rows; a history entry's detail is an item count or an organisation (two columns, no JSON); `follow_up_completed_at` is gone (no
route set it) and `caseOwner` is derived (always `startedBy`). A grant's and a placement's organisation are RESTRICT; player and
guardian ids carry no key (tolerant). A reference's one-time code is stored only as its SHA-256 hash, held while pending and
unique; `verificationMethod` / `identityVerified` are read-time constants. A grant with its notification, a revocation with its
acknowledgement request, a pack view with its ledger row, a published reference with its notifications and a sweep's check-in
with its notification each commit as one unit; the sweeps are indexed queries. Routes refuse junk with `400 FIELD_INVALID`
naming the field: a period outside 14–180 days and a grant outside 1–90 days (both clamped before), a pack that is not lists of
ids or names another field, non-text notes, coach names, emails, roles, reference text, seasons or conflicts; an email without an
address shape is `COACH_DETAILS_REQUIRED`. Over-long free text is still shortened. `GET /admin/vouches` pages by cursor (no app
reads it). **Moved to S11:** the legacy M13 F10 `representations`. Nothing can create one (410 since P5.6E) and the seed has
none, but step 2305 mirrors their rows into the agent agreements and the agents batteries test those mirrored rows, so they go
with the agent stores. **Known, unchanged:** a club's release reference reads as `email_code` like a coach's, though no email
was involved (a product label, for the Founder); the F2 section of `operations/clubOperations` still lives there.

**S11a as built (5 November).** `repositories/agentCore.mjs`, migration `0026`, read through `agentReads` (on every
module context), field specs as S10. A profile's declared jurisdictions, its facets (one row per facet and member
association, the FIFA licence under `INT`), an affiliation's roles and an agreement's scope, policy versions and
opportunity shares are ordered rows; a history entry's detail is typed columns by action; idempotency keys are columns
of their owner. `policyVersion` and `isRegulatoryMinor` are read-time constants. The `agencySettings` org facet is
retired (`org_agency_settings` rows). Staff and agency ids are RESTRICT; a client's id carries no key (tolerant). The
legacy M13 F10 `representations` lane went first (its routes, screens and the 2305 mirror; agreements lost their
`documents`). The blob steps 2305 (bootstrapping affiliations for existing staff) and 2306's bootstraps (an empty
domestic facet, review items for facets and disputes already waiting) are recorded no-ops: there is no staff before
a first login, a profile is written whole with every facet, and a review is requested by the route that needs one.
The two notices a read used to write (a relationship ending within 30 days, a stale facet) come from a sweep, each
marker committing with its notification. Routes refuse junk with the existing codes (`AGENT_INPUT_INVALID`, field
named; `AGENT_SCOPE_INVALID`, `AGENT_TERM_INVALID`, `AGENT_JURISDICTION_INVALID`). A request's
policy versions are checked against the policy table in code (since S11b-1).

**S11b-1 as built (5 November).** `repositories/compliancePolicies.mjs`, migration `0027`, which also inserts the three seeded
policy versions (FIFA, the FA, U.S. Soccer), attributed to it; blob step 2306 no longer creates the two collections. The
module receives the repository as `compliancePolicies`. A rule's parameters are typed against the engine's vocabulary
(`RULE_PARAMS` in `domains/agents/compliance/policyVersions.mjs`, which now also holds `PARTY_ROLES` and `CONSENT_KINDS`):
one row per parameter, scalars as columns, list, role-set and age-map elements as item rows. Publishing a parameter the
engine does not read, or of the wrong type, is refused with `POLICY_INPUT_INVALID` naming it (it used to be stored and
ignored), as are an unknown rule or policy field, a bad source or override, and a `supersedes` that does not name an
existing version of the same jurisdiction. The published set is decoded once per change. Reviewer creation refuses
non-text fields and secrets over 200 characters; a revocation (with its sessions) is one unit. The agent core checks an
agreement's policy versions against the table. The review queue and contexts are S11b-2.

### 4.6 S14: retire the blob

Depends on S2–S13. The `collections` table ends up empty. `meta.idCounter` moves to a `counters` table, and
`db.schema` is replaced by `data_migrations`. The `m182` snapshot migrations become no-ops. `mediaBlobs`, `boxSessionEvents` and `NOT_A_STORE` leave
`storeContract.mjs`. The `db.x ??= []` and `migrateMxx` lines are deleted. The contract test asserts zero blob
collections. With no production data, the migrations `0001`–`00NN` may be squashed into one baseline at this
point, if that helps.

## 5. How to do a step

### The process

1. Write a short design note **to the user**, not a new file: the tables, how the model differs from
   `sql/*.sql` and from the old behaviour, what junk is now rejected, and the tests. Ask the Founder only about
   product consequences, in product terms; if a question doesn't need him, don't ask it.
2. Implement (§5.2). Run `cd scoutbox-server && npm test`, the domain's end-to-end scripts and, if anything in
   `scoutbox-player/` changed, `cd scoutbox-player && npm test`.
3. One review of the implementation, under the scope in [`../decisions.md`](../decisions.md) §1. A blocking
   finding is one a real user could hit through a real route. Everything else is a note.
4. Commit to the current branch.

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
  Update `sql/*.sql` to match the real DDL (`testSchemaDdl.mjs`). Add the domain's end-to-end batteries
  to `BATTERIES` in `scripts/runE2E.mjs` (`npm run e2e`, which CI runs).

## 6. Open questions that touch the migration

From [`../decisions.md`](../decisions.md) §5:

- **Organisation deletion (O2).** Every `org_id` key is RESTRICT, and `suspended` is the only org state.
- **Retention (S4b, Q6).** Needs legal review before real users, not before the migration finishes.
- **Child-status stamping (Q2).** New columns if yes.

Q3 and A0–A3 are effectively moot: re-seeding removes the old ids, and explicit identity writes remove the
whole-snapshot rewrite that A0–A3 were about.
