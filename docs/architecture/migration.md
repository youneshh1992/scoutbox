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
- a synthetic load of 100k players (`scripts/dataLayerPerf.mjs`) gives p50 under 5 ms on hot paths, with
  no request writing the whole database.

Moving storage alone isn't the goal. A domain that is in tables but still loaded whole into memory (explicit writes,
but every read scanning a whole-collection mirror, as S8a–S8d were until 4 November) is only part-way there. The
recruitment domain now reads through SQL (§4.3 step 2); what is left of §4.3 is the paging decided below and step 4.

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
| — | recruitment end-state proof | — | — | — | §4.3 steps 1 and 3 done (4 Nov); step 2: S8a–S8d done (4 Nov); the requests/trials/inbox paging next, then step 4 |
| — | end-to-end test estate | — | — | — | §4.4, any time before S9 |
| S9 | scouting and assessment | | | | not started |
| S10 | verification and passport | | | | not started |
| S11 | agents, compliance, transactions | | | | not started |
| S12 | development, Box Cam, discovery | | | | not started |
| S13 | operations and integrations | | | | not started |
| S14 | retire the blob | | | | not started |

The lossless side columns (`extra_json`, `absent_keys_json`, `offtype_json`) of the old fidelity rule were dropped
from S0–S7 and S6b on 3 November, and from S8c, S8a and S8b when they moved to explicit writes (§4.3, 3–4 November).
No table carries them now.

## 4. The order of work

### 4.1 Remove the rollback and compatibility machinery (done)

Removed with no behaviour change: the 15 rollback tools and their scripts, `rollbackChain.mjs`,
`rollbackToPreS8c.mjs`, the core-identity preflight script, the `rollback:*` and `preflight:*` npm scripts,
`copyDatabaseReadOnly`, the `SCOUTBOX_PRE_*` historical-build boots, the rollback cases in the unit suites, the
recruitment-cases key-format marker, the stale-outbox refusal (`OUTBOX_PUSH_SCHEMA_STALE`), the `LATER_SCHEMA`
refusals and the "in-memory array was ignored" warnings.

Kept on purpose: `repositories/identityPreflight.mjs` (the identity validator migration `0005` and the identity
repository use; only the script around it went), and the `db.json` import in `store.mjs`, which is how a backup is
restored. It went in §4.2.

### 4.2 Backups become database copies (done)

This was planned for S14. Doing it now removes code that §4.3 and S9–S13 would otherwise rewrite.

Before this step, `POST /admin/backup` wrote the whole snapshot as `db.json`, and a restore booted a fresh `DATA_DIR`
that imported it as blobs, after which every table migration ran its blob import. On a first boot there are no blobs,
and the seed goes through the repositories. The restore path was not the only other user of the blob imports, though:
the CI persistence batteries (`m23*Persistence`, `m23BootContract`) build their fixtures with `openStore(dir).save(…)`
into an empty directory, which wrote the table-backed collections as blobs for the next boot to import.

**Done 3 November** (branch `migrate/backup-db-copy`). Snapshot mode runs the table migrations when it opens a
file, so a fixture's save goes straight into the tables through the `*_SNAPSHOT` writers, and a saved snapshot settles
the first-installation state (`orgsInit`, `coreIdentityInit`). Junk entries in a fixture are refused by the save, with
the same codes the imports used. Kept on purpose: the shared validators and their `*_IMPORT_BLOCKED` codes (the
snapshot writers use them; renaming would be churn) and snapshot mode itself (the m23 batteries and the unit suites
build fixtures with it). The unit suites no longer plant blobs: the import and upgrade cases were deleted, the rest
build their setup with a snapshot-mode save, and the backup cases read the copied `scoutbox.db`. `testBackup.mjs`
proves the copy matches the source table for table, a restore brings everything back (sessions, media, the removal
queue), and a corrupt `scoutbox.db` stops the boot. Left for §4.3: the recruitment readers' "blob before migration
00NN" fallbacks (`readTrialsCollection`, `readRequestsCollection`, `readCasesCollection`).

The step was:

1. Backup writes `scoutbox.db` with `VACUUM INTO`, next to `media/` and `manifest.json` (checksums as now). Restore
   stays "copy the backup into a new, empty directory and boot". Never restore over a live directory.
2. Delete the legacy `db.json` import (`readLegacySnapshot`, `LEGACY_IMPORT_FAILED` in `store.mjs`, its check in
   `server.mjs`) and the backup's legacy-shape export.
3. Each table migration's `up()` becomes its DDL plus whatever the boot still needs. Delete the blob imports, their
   normalise-and-report code, the `*_IMPORT_BLOCKED` refusals and the cutover counts in `meta`.
4. Tests that plant blob rows before a boot in order to test an import or an upgrade go. Tests that only used
   planting as setup write through the repositories or SQL instead. The backup and restore tests are rewritten for
   the new format; their behaviour (everything comes back, media included, a bad backup is refused) stays.
5. Check what still uses snapshot mode (`openStore(dir)` without options) and each domain's `*_SNAPSHOT`. Keep
   them only if a tool or fixture still needs them.

Update `OPERATIONS.md` (Backups and restore, the legacy `db.json` note) in the same change. The blob collections
that haven't moved yet are inside `scoutbox.db`, so the new backup carries them unchanged.

### 4.3 Prove the end state on recruitment

Before migrating ~227 more tables, make one domain look like §2, so S9–S13 copy a finished pattern and nothing needs
a second pass:

1. Convert S8a–S8c (`recruitment.mjs`, `recruitmentCases.mjs`, `recruitmentContactsOffers.mjs`) to explicit
   writes like S8d. The route code calls repository operations instead of editing objects in place. That's more
   than `m23/*` and `m28/*`: on 3 November about 25 route modules read or edit `db.recruitmentCases` and
   `db.trials` directly (`git grep -c 'db\.recruitmentCases\b'`), so plan to split this into several PRs, for
   example one per repository.
2. Move the hot recruitment reads (case lists, the Room, contacts, offers) to SQL queries with pagination, and drop
   those mirrors.
3. Drop the lossless `*_json` side columns from the S8a–S8c tables as part of step 1 (decided 3 November; the
   other domains lost theirs then).
4. Measure with `scripts/dataLayerPerf.mjs` at 100k synthetic players.

**Decided 4 November, to do after S8b (before step 4): page the club Requests and Trials lists and the inboxes.**
`GET /org/requests`, `GET /org/trials`, `GET /player/inbox` and `GET /guardian/inbox` still return whole lists (from
SQL since S8a). The Pro and Grassroots home dashboards count pending requests, trials awaiting a report and all trials
from the first two, so paging them alone would make those figures wrong for a club with more than 50. The change, as one
commit: add a counts response the two home dashboards read instead; page the four routes with
`domains/platform/paging.mjs` (`{ items, nextCursor }`); change the Pro, Grassroots and Player apps to read `.items`
(Pro and Grassroots share business logic: change both). No "load more" UI yet (decided 4 November): leave a comment in
each app where only the first page is read, as `m12api.ts` and the admin `m12tabs.tsx` do.

Doing the same for players and guardians (S4a's whole-snapshot identity replace) would also settle the A0–A3
foreign-key questions. That's a candidate for later.

**S8c done 3 November** (branch `migrate/s8c-explicit-writes`). Contacts and offers are ten typed tables with the
vocabulary and length CHECKs, no side columns, and their idempotency keys as columns plus `offer_keys` rows (no longer
in `idempotency_keys`). Migration `0017` was amended in place: re-seed a development database. The repository offers
`contacts.create` / `update` / `redactPlayer` and the same for offers; `update(id, (draft) => …)` hands the route a
plain copy, types the whole record and writes it at once, and refuses an unknown field rather than drop it. Every
contact and offer route runs in one unit of work, and so do the two request-respond routes (the answer and the
contact commit together). A lifecycle refusal is thrown inside the unit, which replaces the offer routes' hand-written
rollback. The guardian e-mail copy is sent after COMMIT. What we learned, for S8a and S8b:

- S8c went first because it is a leaf. Its `case_id` and `request_id` keys are `DEFERRABLE INITIALLY DEFERRED`
  because cases and requests are still written by their staged hooks at the unit's COMMIT. When S8a and S8b become
  explicit, those keys can go back to immediate `RESTRICT`.
- Requests and trials point at cases, and cases link back to requests and trials, so S8a and S8b depend on each other.
  Convert them in one PR, or convert one with deferred keys as S8c did.
- Four end-to-end batteries planted records the typed tables now refuse (an offer with no revision, a pointer at a
  missing revision, unknown status words, partial literals). Those assertions now check that the save refuses the
  record and names its id. Corruption a typed row can still carry (a delivered contact with no recipient, an ACCEPTED
  revision with no response, a stale but resolvable pointer) is still planted and still judged on read.

**S8a done 3 November** (on `feat/sqlite-schema`). Requests and trials are sixteen typed tables with the vocabulary
CHECKs of `m23/trial.mjs` and no side columns. Migration `0015` was amended in place (re-seed a development database)
and `0016` no longer rebuilds them: it creates the shared `idempotency_keys` for the case graph's owners only. The
invitation key is a column of the request; a trial's client keys, reminder markers and revision sessions are rows of
`trial_keys`, `trial_reminders` and `trial_revision_sessions`; actors keep their kind (`<x>_kind`, `_user_id`,
`_actor_id`, `_name`). Every trial reads back with its trial-day container, so the readers' `t.day ??= …` writes are
gone. Two never-read fields were dropped: `trials.keys.accept` and `trials.blockedBy`. The repository offers
`requests.create` / `update`, `trials.create` / `update` and `tombstoneForPlayer`, the same pattern as S8c, and every
writer uses them: the request writer (the Trial invitation's case link, recipient and key are part of the one create),
both respond routes, the report route, the urgent-report freeze (the `suspended` status, now in the vocabulary), the
deletion unit, every trial route, the trial-day routes and the reminder sweep. The routes that move a case run in one
unit of work, and the trial is written before the lifecycle move so the evidence provider sees it. What we learned, for
S8b:

- The coupling to S8b was smaller than it looked: S8b's flush only needs the final requests and trials (the views) and
  the departures, which are always empty now that nothing deletes a request or a trial outside a snapshot.
- The `case_id` keys are `DEFERRABLE INITIALLY DEFERRED` like S8c's. When S8b is explicit, they and S8c's can become
  immediate `RESTRICT`.
- The shape probe paid off: instrumenting the old save and running the batteries listed every field the writers
  actually produce. One writer it missed (the urgent-report freeze) was caught by `testSafetyAuditServer`.
- Five batteries planted partial literals (no organisation flags, no `workflowState`, no `rev`). They now plant the
  writers' whole literals. `m23TrialPersistence` §3 plants only the corruption a typed row can carry (a state that
  disagrees with its facts, a timezone that is not a zone, rev 0); the unstorable cases moved to a new §3c that
  asserts the save refuses each one with its id.

**S8b done 4 November** (on `feat/sqlite-schema`). Cases and the four room collections are twenty-five typed tables
with the vocabulary CHECKs of `m17/shared.mjs`, `m23/decision.mjs`, `m13/shared.mjs` and `m27/integration.mjs`, and no
side columns. Migration `0016` was amended in place (re-seed a development database). It no longer creates
`idempotency_keys`: the draft's, the formal decision's and the handoff's keys are columns, and `0018` creates the table
for the signing packages, its only owner. The repository offers `cases.create` / `update`, `comments`, `decisions` and
`evidenceStates` `create` / `update`, `snapshots.create` and `redactPlayer`, the S8a pattern; an update of a record
from inside its own update is refused. Every writer uses them: M12 cases, M13 budgets, every Room route, the lifecycle
writer, the decision draft and finalize, the M27 handoff, the trial, contact, offer and signing couplings, and the
deletion unit. Three model changes:

- One case history shape, `{ id, at, byKind, byId, byName, action, detail }`. M27 wrote a second one that the activity
  feed could not read, so handoff entries now show their actor there.
- A decision's `snapshot` is the `room_snapshots` row it names (`snapshot_id`), read back with the decision, never a copy.
- A Room's `sourceRef` is `{ id, version }` from every caller (M18 Nobody Missed and Second Look, M19 watchlists).

Junk the routes now refuse instead of storing: a case `deadline` or an M12 assignment or task `dueAt` that is not a day
or an instant (400 `DATE_INVALID`), and an FX assumption whose date is not a day (dropped, like a bad rate). The Room
PATCH, task PATCH and link routes check every field before writing, so a refusal part-way no longer leaves the earlier
fields changed in memory. The finalize route is one unit of work: a lifecycle refusal rolls back the formal row, its
snapshot and the supersession instead of the hand-written undo. The `case_id` keys of requests, trials, contacts and
offers are immediate `RESTRICT`, and the writers name a missing case with its ids. What we learned, for S9–S13:

- The probe listed every in-place write, but grouping writes by their innermost frame hid the callers of shared helpers
  (`audit` from M28 and M29, `histAppend`). The read-only views caught those on the first battery run. Group by the
  first frame outside the shared helpers.
- Shared mutators (`applyStatus`, `audit`, `bumpRev`) keep working unchanged on the draft `update` hands out. A seam
  other modules call (the lifecycle writer) does its own `update` and takes the extra detail its callers used to patch
  onto the last history entry (`statusDetail`).
- Test fixtures had drifted from the writers (a `proceed` outcome, budget kinds the route never accepted, a string
  passport revision stored as a number). Typing the fixtures found them before the batteries did.

**Step 2: S8c reads through SQL, done 4 November** (on `feat/sqlite-schema`). The contacts and offers have no mirror and
no `db.*` view: `db.recruitmentContacts` and `db.recruitmentOffers` throw when read or assigned, naming the repository,
so a missed reader fails loudly instead of seeing an empty list. The repository answers `byId`, `forCase`,
`forOrgPlayer`, `forPlayer`, `forRequest` / `forAgent` (contacts), `forPlayers` / `forAgentShare` (offers) and `forOrg`
from the existing indexes, in insertion order, as fresh deep-frozen records. A read inside a unit of work sees the
unit's own writes, so the participant hook that restored the mirrors is gone. Modules get the queries as
`recruitmentReads` in their context; the pure projectors (the journey, the evidence provider, the dashboard context)
take them as `reads` instead of reading `db`, and the journey reads a case's contacts and offers once instead of
scanning both collections about a dozen times. The redactions are `UPDATE … WHERE player_id = ?`. The contacts and
offers left the store contract, the `m230_004` snapshot step is a recorded no-op, and `CONTACT_STORE_MISSING` and
`OFFER_STORE_MISSING` went with the collections. No list here grows without limit (each is per case, per player or per
agent client), so nothing pages; the club audit feed, which merges every domain, pages when S8b moves. The batteries
that call the projectors directly get the same queries over their plain arrays from `scripts/recruitmentReadsFixture.mjs`.
What we learned, for the next repositories:

- Make the old name throw rather than delete it. The `??= []` lines and `Array.isArray(db.x)` guards would otherwise
  quietly create or report an empty collection; the throwing getter found every remaining reader on the first run.
- The "store missing" branches (`storeOr500`, `JOURNEY_REQUIRED_STORES`) were about the blob; their tests now check
  the same behaviour through the queries (a projector given no contact queries still reports the store missing).

**Step 2: S8d reads through SQL, done 4 November** (on `feat/sqlite-schema`). Same pattern as S8c: no mirror, no view,
`db.signingPackages` / `db.signings` / `db.followUps` / `db.outcomeReports` throw. The repository adds `forCase`,
`forOffer`, `forPlayer`, `forOrg`, `forOrgPlayer` (packages and signings), the one-row `forPackage` / `forOffer`
(signings) and `forFollowUp` (reports), `forSigning` / `forPlayers` (follow-ups), counts, and two new indexes
(`signing_packages (org_id, player_id)`, `outcome_reports (player_id)`; `0018` amended in place: re-seed a development
database). The paging convention lives in `domains/platform/paging.mjs` (the first module under `domains/`):
`?limit=&cursor=` → `{ items, nextCursor }`, junk refused with 400. The club follow-ups (by due date, then id) and the club
signings (newest first) page; the follow-ups response dropped `total` / `offset`, which no app read, and the signings
response is an object instead of a bare array (no app reads it; the batteries read `.items`). The every-minute sweep is
three indexed queries (signings missing a milestone, scheduled-and-past, due-and-unnotified) instead of a pass over every
signing and follow-up; the admin outcome figures are one `GROUP BY`; the club track record reads the club's signings once
and each involved player's signings by index. The journey and the evidence provider read the case's packages and the
club's signings of the player through `reads`.

**Step 2: S8a reads through SQL, done 4 November** (on `feat/sqlite-schema`). Same pattern: `db.requests` and `db.trials`
throw. The repository adds `forOrg`, `forPlayer(s)`, `forOrgPlayer`, `forCase`, `forOrgStatus` and counts; the three trial
sweeps (report overdue, confirmed and open, completed without the assessment reminder) are indexed predicates, and the
admin staff-check queue pages by cursor over `trial_day_staff`. Four indexes were added to `0015` in place (re-seed a
development database). The channels repository checks a request through `requestExists(id)` instead of scanning the
requests. The pure helpers that took `db` (the journey, the evidence provider, the decision evidence, the M21 evidence
links and plan) take `reads`; the batteries that call them get the queries over their plain arrays from
`scripts/recruitmentReadsFixture.mjs`. The m182 steps that created or shaped `db.requests` / `db.trials` are no-ops, and
`TRIAL_STORE_MISSING` went with the collection. The club Requests and Trials lists and the inboxes still return whole
lists (from SQL): their paging waits on the home dashboards' counts (decided above).

**Step 2: S8b reads through SQL, done 4 November** (on `feat/sqlite-schema`). The last recruitment mirror is gone:
`db.recruitmentCases` and the four Room collections throw, and the recruitment domain has no `db.*` collection left.
The repository adds `forOrg`, `forPlayer`, `forOrgPlayer`, `forHandoffAgent`, `withRoom`, counts and per-status Room
counts for cases, `forRoom` for the Room records and `forOrg` / `forOrgPlayer` for decisions (one index added to `0016`
in place: `room_decisions (org_id, player_id)`). The club Rooms list and the M12 cases list page by cursor
(`{ items, nextCursor }`, the Rooms list keeping its funnel and statuses); the Pro and Grassroots apps read the first page
and say a "load more" will be needed. Their filters are per viewer (restricted Rooms, views, the name search), so both
read the organisation's cases by index and filter and page in code (`pageSorted`): the response is bounded, the read is
one club's. A bad `limit` is now refused (400) where the Rooms list clamped it. The boot integrity report takes the
Rooms from `cases.withRoom()`. The m182 steps that created or backfilled the case collections are no-ops, and
`DECISION_STORE_MISSING` went with the collection. Still in memory, for step 4 to judge: the per-org filtering of those
two lists, the audit feed's merge, the dashboard's per-org reads and the integrity report's boot read.

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
| S9 Scouting and assessment | `04_scouting_assessment.sql` | 33 | `evidence`, `coachAffiliations`, `squadInvites`, `assessmentTemplates`, `assessments`, `videoSegments`, `playlists`, `vacancies`, `opportunities`, `applications`, `campaigns`, `campaignSubmissions`, `playerPrefs`; the org facets `tactical`, `squad`, `lookingFor`, `federationCheck` move out of `orgs.facets_json` | S5, S8 | Template ids repeat across versions, so the key is `(id, version)`. A tactical re-save must diff roles by id so vacancies keep `role_id`. Coach affiliations are keyed by user id. `playerPrefs` is inserted on read, so it needs an upsert. Squads come in four shapes. Player foreign keys: tolerant, like recruitment, unless there's a reason not to. |
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
