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
recruitment domain now reads through SQL and its unbounded lists page (§4.3 step 2), but the measurement of step 4 shows
it does not meet the bar yet; the work it found is listed at the end of §4.3.

## 3. Status

18 migrations are registered in `repositories/index.mjs` (`DATA_MIGRATIONS`). The next free id is `0019`. Each
step takes the next free id; the placeholder ids in `sqlite-schema.md` mean nothing.

| Step | Domain | Migration | Repository | Write model | Status |
|---|---|---|---|---|---|
| S0 | staff accounts | `0001_org_users` | `users.mjs` | direct | done |
| S1 | identity shadow | `0002_core_identity_shadow` | (retired) | — | done |
| S2 | sessions | `0003_sessions_live` | `sessions.mjs` | direct | done |
| S3 | organisations | `0004_orgs_live` | `orgs.mjs` (+ `facets_json`) | facets flushed at save | done |
| S4a | players, guardians | `0005_core_identity_live`, `0006_media_deletions` | `identity.mjs`, `mediaDeletions.mjs` | calls + whole-snapshot replace | done |
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
| — | recruitment end-state proof | — | — | — | §4.3 steps 1–3 done (4 Nov); step 4 measured (4 Nov): fails §2, fixes listed in §4.3 |
| — | whole-player-base costs (lookups, identity writes) | — | `identity.mjs`, `orgs.mjs`, `users.mjs` | explicit (S4a-E) | §4.3.1, next; before S9 |
| — | end-to-end test estate | — | — | — | §4.4, any time before S9 |
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
met, and the fixes are below and in §4.3.1. Code comments cite "§4.3 step 2" and "§4.3 step 4": keep those labels.

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

**Step 4: measured 4 November, the bar of §2 is not met** (`npm run perf:recruitment -- <players> <clones> <busy>`).
The script builds synthetic players (`scripts/perfPopulation.mjs`) and clones the S8 fixtures' recruitment graph onto
real clubs and players through a snapshot-mode save, then boots the real server and times the hot routes over HTTP,
one write and the sweep queries. The busy club has 500 graphs (2,000 cases, 1,500 requests, 500 trials), a typical
club one or two. Medians on a laptop, HTTP included:

| Route (busy club unless named) | 10k players | 30k players | 100k, extrapolated | Cost grows with |
|---|---|---|---|---|
| `GET /org/audit` | 3.1 s | 9.0 s | ~30 s | club × players |
| `GET /player/offers`, `/guardian/offers` | 1.3 s | 3.5 s | ~11 s | players (every read is a write) |
| `POST /org/rooms/:id/comments` (any write) | 2.4 s | 6.4 s | ~21 s | players |
| `GET /org/recruitment-analytics` | 1.2 s | 1.3 s | ~1.3 s | the club's cases |
| `GET /org/rooms`, `/org/rooms/needs-attention` | 0.45 s | 0.5–0.6 s | ~0.6 s | the club's cases |
| `GET /org/cases`, `/org/rooms-funnel` | 0.33 s | 0.34 s | ~0.35 s | the club's cases |
| `GET /org/funnel`, `/player/journeys` | 40 ms | 42 ms | ~45 ms | the club's / player's cases |
| `GET /org/trials`, a Room, a journey, `/player/signings` | 6–14 ms | 6–14 ms | same | the page |
| requests, inboxes, counts, follow-ups, signings, Room tabs | 1–5 ms | 1–5 ms | same | the page |

A typical club is at or near 5 ms everywhere (its audit about 20 ms at 30k). Boot: 9 s at 10k players, 18 s at 30k,
77 s at 100k with no recruitment; at 100k with 10,000 graphs it did not finish in 18 minutes (item 3). A comment adds
about 320 kB to the write-ahead log at any size, so no request rewrites the file, but every write costs CPU in
proportion to the whole player base. The causes, from CPU profiles, in the order to fix them. Items 1 and 2 are not
recruitment's and every later domain would inherit them, so they are §4.3.1. Fix items 3–6 after it and re-measure.

1. **Every write walks every player** (`identity.flushDomain`). §4.3.1.
2. **`findPlayer`, `usersOf` and `db.orgs.find` are linear scans**, called per item by the audit feed and the
   sweeps. §4.3.1.
3. **The trial-reminder sweep visits every confirmed, open trial every minute** and calls `findPlayer` for each
   before checking whether a reminder is due (`m12/operations.mjs:362`); with 10,000 open trials and 100k players
   this blocked the boot for over 18 minutes. Select only sessions starting within 48 hours, in SQL.
4. **The busy club's Rooms, cases, funnel and analytics decode every case** with its child tables (`decodeCase`, at
   least 16 queries a case) and filter and page in code (`pageSorted`, because the filters are per viewer). They
   need a summary query over `recruitment_cases` that filters and pages in SQL, with per-viewer rules applied to the
   page.
5. **The audit feed builds the club's whole history** on each page, then slices it; it should page per source.
6. **The offers lists write a receipt on every read**; write only when a revision is unseen.

A backlog is a separate risk: the boot runs the sweeps before it listens, one transaction and one notification per
due item (3,000 stale graphs at 10k players booted in 68 s instead of 23 s). The script moves the fixtures' instants to
today so it measures the steady state.

### 4.3.1 Remove the costs that grow with the whole player base (before S9)

Found by §4.3 step 4. Two foundations make every request slower as the platform grows, whatever the domain: a write
costs CPU in proportion to every player (2.4 s per Room comment at 10k players, 6.4 s at 30k), and a lookup by id scans
a whole collection. Each domain migrated on top of them inherits both, so this comes before S9.

1. **Lookups by id use the index.** `findPlayer` (`server.mjs:702`, 184 callers), `usersOf` and the `db.orgs.find`
   / `db.users` scans (about 120 more) go through the repositories' maps: `players.byId` and `users.byId` exist;
   `orgs.byId` exists but searches with `records.indexOf` (`repositories/orgs.mjs:401`) and needs the map to hold the
   view. One small change, no behaviour change. It removes most of the audit feed's time and the sweeps' per-item scan.
2. **Explicit identity writes (S4a-E).** Players and guardians move to the S8 pattern: routes call repository
   operations (most already do: `players.update`, `patchItem`, `setItems`), each write types and writes its rows, and
   the save no longer rebuilds and compares every player's row (`identity.flushDomain`, `repositories/identity.mjs:1026`,
   with one trial-report query per player). The read-only view stays for readers until they move to queries. This
   settles A0–A3 (§6).
3. **Then re-measure the unit of work itself.** `store.unitOfWork` copies the whole in-memory database at the start
   (`captureGraph`, `store.mjs:294`) and every repository with a mirror captures its own state (`snapshotState`; the
   organisations capture every record). Measure what is left after 1 and 2; remove what no longer has an in-memory
   state to restore.
4. **The boot's default backfill** (`server.mjs:271`) writes one transaction per player that lacks a default; it is
   cheap on a seeded database but becomes one statement once the identity writes are explicit.

Done when: `npm run perf:recruitment -- 30000 1000 500` shows a Room comment and the offers lists under 50 ms and the
audit feed's time no longer growing between 10k and 30k players, and a unit test asserts that a write's cost does
not grow with the player count (for example, the number of statements a save runs).

### 4.4 The end-to-end test estate

The behavioural specification is spread over 67 milestone-named scripts in `scoutbox-server/scripts/` (`m12E2E.mjs`
… `m23*`, `preM24SweepE2E.mjs`, about 3 MB). CI runs ten of them, plus `connectedE2E.mjs` and `apiE2E.mjs`. Some of
the rest fail (see [`../known-issues.md`](../known-issues.md)), and nobody knows the state of the others.

1. Run every script once and record which pass, which fail and why.
2. Separate the correctness batteries from performance, probe and evaluation scripts (`*Perf`, `*Load`,
   `*Bench`, `*Probe`, `m22CvEval`, `m22Holdout`, `m22Robustness`, `m22Blocker`). Those aren't CI gates.
3. Regroup the batteries by domain, not milestone. Merge duplicates. Never delete a behavioural assertion.
4. Put every passing battery in CI. List any that stay out, with the reason, in `known-issues.md`.
5. Name tests after what they check, not after the review that produced them ("review of 2fe05df, R1"). The unit
   suites (`scripts/test*.mjs`) get the same treatment once §4.2 has shrunk them.

This is independent of the storage work and can run in parallel, but it should be done before S9, so new domains
add to the regrouped batteries.

### 4.5 S9–S13: the remaining domains

One step per `sql/*.sql` file, split only if a step gets too big to review. Each is a short branch and a PR into `main`.

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
