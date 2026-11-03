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
   match (`scripts/testSchemaDdl.mjs` compares them column by column) and say what changed in the PR.
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
- a synthetic load of 100k players (`scripts/dataLayerPerf.mjs`) gives p50 under 5 ms on hot paths, with
  no request writing the whole database.

Moving storage alone isn't the goal. A domain that is in tables but still loaded whole into memory and
diffed on save (S8a–S8c today) is only part-way there.

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
| S8a | recruitment requests, trials | `0015_recruitment` | `recruitment.mjs` | **in-place edits + fingerprint at save** | done |
| S8b | cases, rooms, decisions | `0016_recruitment_cases` | `recruitmentCases.mjs` | **fingerprint** | done |
| S8c | contacts, offers | `0017_recruitment_contacts_offers` | `recruitmentContactsOffers.mjs` | **fingerprint** | implemented; accept on green tests |
| S8d | signing packages, signings, follow-ups, outcome reports | `0018_signings_follow_ups` | `signingsFollowUps.mjs` | **explicit, typed** | implemented; accept on green tests |
| — | rollback machinery removed | — | — | — | **next** (§4.1) |
| — | recruitment end-state proof | — | — | — | §4.2 |
| S9 | scouting and assessment | | | | not started |
| S10 | verification and passport | | | | not started |
| S11 | agents, compliance, transactions | | | | not started |
| S12 | development, Box Cam, discovery | | | | not started |
| S13 | operations and integrations | | | | not started |
| S14 | retire the blob | | | | not started |

S6b, S7d and S8a–S8c carry the lossless side columns (`*_json`) of the old fidelity rule.

## 4. The order of work

### 4.1 Remove the rollback and compatibility machinery (next)

One commit, no behaviour change. Delete:

- `repositories/*Rollback.mjs` (15 files) and `repositories/rollbackChain.mjs`
- `scripts/*Rollback.mjs` (the same 15), `scripts/rollbackToPreS8c.mjs`, `scripts/testCoreIdentityRollback.mjs`
  (remove it from the `npm test` chain)
- in `scoutbox-server/package.json`: the `rollback:*` scripts, and probably `preflight:core-identity` with
  `scripts/preflightCoreIdentity.mjs`
- `copyDatabaseReadOnly` in `repositories/database.mjs` (only the rollback tools and the preflight use it)
- the `SCOUTBOX_PRE_*` historical-build boots in `scripts/test{Channels,Dispatches,Notifications,OutboxPush,PlayerErasure,RecruitmentCases,RecruitmentContactsOffers,Recruitment,SafetyAudit}Server.mjs`
- the rollback cases in the unit suites (`testChannels`, `testDispatches`, `testNotifications`, `testOneTimeCodes`,
  `testOrgs`, `testOutboxPush`, `testPlayer*`, `testRecruitment*`, `testSafetyAudit`, `testSessions`,
  `testSigningsFollowUps`, `testMediaDeletions`, `testCoreIdentityServer`, `coreIdentityTestFixtures.mjs`)
- the key-format marker: `RECRUITMENT_CASES_FORMAT_META`, `RECRUITMENT_CASES_KEY_FORMAT`, `recordedKeyFormat`
  and `assertKeyFormat` in `recruitmentCases.mjs`, their calls in `recruitmentContactsOffers.mjs`, and `keyFormat`
  in the `index.mjs` capabilities
- `OUTBOX_PUSH_SCHEMA_STALE` / `outboxHasToJson` in `outboxPush.mjs`, which guard against an unaccepted build
- the `LATER_SCHEMA` refusals that exist for the rollback tools, and the "in-memory array was ignored" warnings in `attachDataLayer`
- the legacy `db.json` import (`readLegacySnapshot`, `LEGACY_IMPORT_FAILED` in `store.mjs`), now or at S14
- `SCOUTBOX_SHADOW_VALIDATION` mentions

Then run `npm test` and the Player suite.

### 4.2 Prove the end state on recruitment

Before migrating ~227 more tables, make one domain look like §2, so S9–S13 copy a finished pattern and nothing needs
a second pass:

1. Convert S8a–S8c (`recruitment.mjs`, `recruitmentCases.mjs`, `recruitmentContactsOffers.mjs`) to explicit
   writes like S8d. The route code (`m23/*`, `m28/*`) calls repository operations instead of editing objects in
   place.
2. Move the hot recruitment reads (case lists, the Room, contacts, offers) to SQL queries with pagination, and drop
   those mirrors.
3. **Proposed, needs the Founder's OK:** drop the lossless `*_json` side columns from the S6b–S8c tables with a
   migration plus a re-seed. His decision of 30 October kept them; with no real data they protect nothing and
   account for much of the size of these repositories (`recruitmentContactsOffers.mjs` is about 80 KB).
4. Measure with `scripts/dataLayerPerf.mjs` at 100k synthetic players.

Doing the same for players and guardians (S4a's whole-snapshot identity replace) would also settle the A0–A3
foreign-key questions. That's a candidate for later.

### 4.3 S9–S13: the remaining domains

One step per `sql/*.sql` file, split only if a step gets too big to review. Each is a short branch and a PR into `main`.

| Step | Schema file | Tables | Collections | Depends on | Watch out for |
|---|---|---|---|---|---|
| S9 Scouting and assessment | `04_scouting_assessment.sql` | 33 | `evidence`, `coachAffiliations`, `squadInvites`, `assessmentTemplates`, `assessments`, `videoSegments`, `playlists`, `vacancies`, `opportunities`, `applications`, `campaigns`, `campaignSubmissions`, `playerPrefs`; the org facets `tactical`, `squad`, `lookingFor`, `federationCheck` move out of `orgs.facets_json` | S5, S8 | Template ids repeat across versions, so the key is `(id, version)`. A tactical re-save must diff roles by id so vacancies keep `role_id`. Coach affiliations are keyed by user id. `playerPrefs` is inserted on read, so it needs an upsert. Squads come in four shapes. Player foreign keys: tolerant, like recruitment, unless there's a reason not to. |
| S10 Verification and passport | `05_verification_passport.sql` | 31 | the `ver*` collections (including `verMigrated`), `passportPrefs`, `passportCareerEntries`, `passportAchievements`, `passportShares`, `passportCorrections`, `transitionCases`, `representations`, `vouches`; the `orgs.verification` facet | S4, S9 | `orgs.verified` becomes derived from claims. Raw passport dates stay raw. Tokens and vouch codes are hashed. One identity claim per user; self-verification is refused. |
| S11 Agents, compliance, transactions | `06_agent_compliance_transactions.sql` | 61 | `agentProfiles`, `agencyAffiliations`, `representationAgreements`, `tsReviewers`, `jurisdictionPolicies`, `regulatoryReviews`, `regulatoryConsents`, `complianceContexts`, `agentTransactions`, `transactionRepresentations`, `transactionDocuments`; `orgs.agencySettings` | S8, S10 | Uniqueness on an *effective* status stays in code. Policies are published under dual control. Each consent can be revoked once. Minors are refused on agreements. Reviewer secrets are hashed. |
| S12 Development, Box Cam, discovery | `07_development_boxcam_discovery.sql` | 57 | about 30: `devObjectives`, `drillGuidance`, `boxCam*`/`box*`, `combine*`, `recruitmentBriefs`, `nobodyMissedReviews`, `secondLookItems`, `dynamicWatchlists`, `watchlistHistory`, `development*`, `exposureEvents`, `reviewLater`, `evidenceSuggestions`, `calibrationSessions`, `fixtures`, `coverage*` | S5, S8, S9 | Reads that write (Second Look and watchlist reconciliation, evidence suggestions) become explicit upserts. Hash the nonce. Split `fixture_id` into kind and id. Consent gate; one entry per challenge and player. |
| S13 Operations and integrations | `08_operations_integrations.sql` | 45 | `apiKeys`, `webhook*`, `orgInvites`, `sso*`, `support*`, `importBatches`, `prospects`, `identityReviews`, `groups`, `groupGrants`, `uploadSessions`, `savedSearches`, `openTrials`, `matchdays`, `friendlies`, `invoices`, `plans`, `archetypes`, `reputationSeed`, the `delivery*` singletons | S3, S8 | Invites and SSO states are hashed. Invoices are stored exactly, in minor units. Backup becomes `VACUUM INTO`. Production's empty first boot (catalogues only, demo opt-in with `SCOUTBOX_SEED_DEMO=1`) exists since 3 Nov; keep it when the catalogues become rows. |

S12 is large; consider splitting Box Cam/Combine from discovery and watchlists.

### 4.4 S14: retire the blob

Depends on S2–S13. The `collections` table ends up empty. `meta.idCounter` moves to a `counters` table, and
`db.schema` is replaced by `data_migrations`. `store.mjs` snapshot mode becomes the backup and restore tool over
tables. The `m182` snapshot migrations become no-ops. `mediaBlobs`, `boxSessionEvents` and `NOT_A_STORE` leave
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
  it in `repositories/index.mjs` (`import * as mNNNN` and an entry in `DATA_MIGRATIONS`). `up()` runs the DDL, then
  imports the domain's blob rows from the file's `collections` table (never from memory): it types each row, reports
  what it normalised or dropped, and deletes the blob rows.
- **Runner.** `runDataMigrations` (`repositories/database.mjs`) runs migrations in lexical order, one transaction
  each, records `(id, applied_at)` in `data_migrations`, and aborts the boot on failure. Under `foreignKeysOff`,
  `foreign_key_check` must be empty before commit. A domain is authoritative because its migration is recorded,
  never because a table exists.
- **Boot.** `server.mjs` runs `buildSeed()`, `loadSnapshot()` (saved blobs replace the seed), the `m182` snapshot
  migrations, then `attachDataLayer`. That deletes the in-memory `db[name]` for table-backed collections and installs
  a read-only view (`repositories/readonly.mjs`), so existing readers keep working and a direct write throws.
- **Seed data.** `seed.mjs` fills only orgs, guardians and players. Domains from S8a on start empty on a fresh
  database and get rows through routes. Tests plant blob rows in a file before booting, using fixtures in the
  writers' shapes (e.g. `scripts/signingsFollowUpsTestFixtures.mjs`). For new domains the import path mainly matters
  for tests; keep it simple.
- **Repository.** `create<Domain>Repository({ sqlite, unit, now, log })` prepares statements. `operation(fn)` joins
  the open unit of work or opens its own transaction. Each write types its input, writes rows, and returns the
  stored record. While a domain keeps an in-memory mirror, the write refreshes it from SQL. `hook()` registers
  `snapshotState`/`restoreState` so a rolled-back unit restores the mirror. Callers get the repository from
  `server.mjs`.
- **Units of work.** `store.unitOfWork(() => …)` is synchronous: one transaction, all or nothing, memory restored on
  failure; nested units join. Side effects (mail, push, live events) go through `store.afterCommit`. Provider calls
  happen before the unit, never inside it.
- **Snapshot path.** Each domain exports a `*_SNAPSHOT` (`read`, `write`, `assert` with `foreign_key_check`) and adds
  its collections to `TABLE_BACKED` in `index.mjs`. Backups, restores and the persistence suites use it.
- **Reporting and tests.** Add a `/capabilities.dataLayer.domains` entry (`index.mjs`). Add `scripts/test<Domain>.mjs`
  to the `npm test` chain. Update `sql/*.sql` to match the real DDL (`testSchemaDdl.mjs`). Add the domain's passing
  end-to-end batteries to `.github/workflows/ci.yml`.

## 6. Open questions that touch the migration

From [`../decisions.md`](../decisions.md) §5:

- **Organisation deletion (O2).** Every `org_id` key is RESTRICT, and `suspended` is the only org state.
- **Retention (S4b, Q6).** Needs legal review before real users, not before the migration finishes.
- **Child-status stamping (Q2).** New columns if yes.

Q3 and A0–A3 are effectively moot: re-seeding removes the old ids, and explicit identity writes remove the
whole-snapshot rewrite that A0–A3 were about.
