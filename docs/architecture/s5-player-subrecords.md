# S5 implementation note: player sub-records into their SQLite tables

Companion to [`sqlite-migration-plan.md`](./sqlite-migration-plan.md) §S5, the S4 readiness
review §2.2 and the DDL in `sql/01_identity.sql` ("player sub-records (step S5)"). Written 12
October 2026 on `feat/sqlite-schema` from `480afdb` (S4a review-accepted), before the code was
changed, from a survey of every reader and writer of the twelve arrays. The sections record the
decisions the survey settled; the status line at the end says what is implemented.

S5 depends on the storage work S4a completed (the `players` rows and their `facets_json`,
the one mapping in `repositories/identityMapping.mjs`, the unit of work, the media-removal
queue). It **preserves today's deletion behaviour** (hard delete, child rows cascade); it is not
S4b, and O1 stays the Founder's open decision.

## 1. Where the arrays live today, and who touches them

Every array sits in the player's `facets_json` (S4a), is served through the record view
`db.players` as a plain mutable value, is mutated **in place** by its writers and flushed inside
the next save. Readers never query per element; every one reads the whole array off the record.

| Record field | Shape today | Writers (file:line at `480afdb`) | Readers (main) |
|---|---|---|---|
| `media[]` | `{id, title, kind, uploadedAt (ISO text), url, views, tags{tag:count}, verifiedClip, captions?, sizeBytes?, capturedBy?, boxSessionId?}` | `server.mjs` 3453 (upload), 255–259 and `m12/shared.mjs:33` (boot defaults `views/tags/verifiedClip/url/captions`), 317–321 (seed sample clips), 2384 (views), 2399–2400 (tags), `m12/operations.mjs` 224 (chunked upload), 254 (captions), `m16/sessions.mjs` 458–459 (`capturedBy`, `boxSessionId`) | `domain.mjs` trust score and next actions; film room, feed, deck, CV, insights, passport, media entitlement (`server.mjs` 4379, `m12/operations.mjs` 261), `m13/insight.mjs`, `m13/transitions.mjs`, `repositories/mediaDeletions.mjs` (ownership) |
| `attendance[]` | `{id, fixture, venue, date, gps{lat,lng}|null, deviceConfirmed?, verified, corroboratedBy?, trialId?}` | `server.mjs` 3549 (player), 2923 (grassroots match day), `m12/journeys.mjs` 698 (trial check-in) | trust score, fixtures graph, CV, passport, org view (`views/playerViews.mjs`, GPS stripped) |
| `timeline[]` | `{year, event}` | `server.mjs` 3560, 3212 (aging-up, in a unit), `m29/index.mjs` 295–311 (signing, in a unit) | org view, CV, `/me` |
| `badges[]` | `string[]`, up to 6 when client-set | `server.mjs` 3423 (client list, duplicates legal), 3413–3414 (Academy+ `Fresh Start`, in a unit), 1008–1009 (journey badges) | org view, season wrap |
| `drills[]` | drill id strings, unique by code | `server.mjs` 3627 | `/drills` |
| `drillResults[]` | `{id, drillId, drillName, metric, unit, value, verified, ts}` | `server.mjs` 3629 | `/drills`, benchmarks, season wrap, passport, journey badges |
| `activityLog[]` | ms timestamps (same-ms duplicates legal) | `server.mjs` 997–998 (`recordActivity`, called by eleven routes) | streaks, weekly goal, season wrap, guardian dashboard |
| `externalIds[]` | `{provider, externalId, source, by, at, claim}` | `m13/imports.mjs` 221–223 (dedupe by provider+externalId); `m13/shared.mjs:47` boot default `[]` | `m13/imports.mjs` 89, 309 |
| `seasonHistory[]` | `{season, appearances, goals, assists, …}` unique by season, sorted descending by season after every change | `server.mjs` 3584–3588 (in a unit); 261 boot default `[]` | `/stats`, org view |
| `medical.records[]` | `{id, type, title, date, layoffWeeks, cleared}` | `server.mjs` 3483 (in a unit) | `/medical`, org view only when `medical.shared` |
| `programme.completed[]` | `{sessionId, ts}` (a session may be completed twice) | `server.mjs` 3675 (reset, in a unit), 3687 | `grassrootsJourney.mjs` |
| `trialReports[]` | byte-for-byte copies of `trials[].report` | `server.mjs` 2631 (pushed when `trial.report` is written) | trust score, CV, attachments, org view (own org only) |

Seed shapes (`seed.mjs`): `att()` has no `corroboratedBy`; `med()` has only `id, title, kind,
uploadedAt` (the boot loop adds `views/tags/verifiedClip/url`); the adult signup has no
`drillResults`, `activityLog` or `seasonHistory` (added by their first writer or the boot loop);
`drills: []` everywhere. No snapshot migration in `m182/migrations.mjs` writes a player array.

## 2. Decisions

1. **One storage, one write path.** Each array becomes rows of its `player_*` table; the
   in-memory record keeps the array (derived from the rows at load, maintained by the repository
   methods) so every reader keeps `player.media`, `player.attendance` … exactly as today, and the
   view serves the arrays **read-only** (deep: items too). A write that bypasses the repository
   throws instead of diverging silently. The arrays are no longer facets: the mapping excludes
   them from `facets_json` (their presence and null/absent shape stay in `__meta`), so no flush
   can recreate a stale copy. `facets_json` keeps unknown fields and shape metadata only.
2. **Keys: no minted identifiers.** The DDL's prose said to mint ids for badges, activity entries
   and timeline rows; the tables keyed some of them by natural composite keys that the code does
   not enforce (a client-set badge list may repeat a badge; two activities in one millisecond are
   two entries; a programme session may be completed twice). Settled: a row that has no
   client-visible id is keyed by **`(player_id, position)`**, where `position` is the array
   index; every child table carries `position` and reads back in that order, so array order and
   legal duplicates are preserved exactly and nothing is minted, so nothing has to stay stable
   across restarts or repeat migrations. Natural keys the code really enforces stay as UNIQUE
   constraints (`season` per player, `drill_id` per player, `(provider, external_id)` per player,
   `(media_id, tag)`): a legacy array that violates one is refused with the player id, field and
   index, never deduplicated.
3. **Item shape preservation.** Every item is mapped like a record: known keys to columns,
   explicit nulls and key order to the item's `__meta`, unknown keys to the item's `extra_json`;
   `gps` is a composite (`lat`, `lng`, pairing CHECK). Nothing is coerced: a value the column
   cannot hold is refused with `players <id>: <field>[<index>].<key> …`.
4. **Constraints reconciled with the data the routes accept** (changes to the proposed DDL, each
   because a supported value would otherwise be refused): `player_media.uploaded_at` is TEXT (the
   ISO string every writer stores; the proposed ms INTEGER would have coerced it);
   `player_media.kind` is nullable (`optText` accepts null); `player_media.verified_clip_attendance_id`
   loses its foreign key (a snapshot rewrite of the attendance rows would have nulled it through
   `ON DELETE SET NULL`; the route validates the reference when the clip is created);
   `player_medical_records.layoff_weeks` is REAL (the route accepts any finite number in 0–520);
   `player_attendance.match_date` has no length CHECK (a trial check-in writes `t.proposedDate`
   as it is); `player_programme_completions` is keyed by position (see 2); `player_badges`,
   `player_timeline`, `player_activity_log`, `player_drills` are keyed by position (see 2). The
   remaining CHECKs (`captured_by IN ('box_cam')`, `cleared` tri-state, `count > 0`, `verified`,
   `device_confirmed` flags, `(lat IS NULL) = (lng IS NULL)`) match what the writers produce and
   are enforced by the validator before any statement.
5. **`trialReports` is derived, not stored.** The copy on the player is a duplicate of
   `trials[].report` (the same object, pushed at filing). Since S5 the record serves
   `trialReports` as a read-only derived value from the `trials` collection (ascending `filedAt`,
   then report id: the filing order), and the writer at `server.mjs:2631` goes. Migration 0007
   **reconciles** every player's copy with that source before dropping it: an entry with no
   matching trial report, an entry whose content differs from the trial's report, or a copy whose
   order differs from the derived order **blocks the whole migration** with
   `PLAYER_SUBRECORDS_CUTOVER_BLOCKED` and a report naming the player, the report id and the
   reason; nothing is dropped silently. A record that had the key keeps it (an empty array when
   there is no report, `null` when it was null); a record that never had the key gains it only
   when a report exists for it. S8 moves the reports into `trial_reports`; nothing of S8 is built.
   **Corrected after the review of `132eda2`:**
   - *Every shape follows the trials, live.* The in-memory accessor is installed on every
     record, whatever its empty-state shape: a record whose key was absent shows the list the
     moment a report names the player (hidden until then: not `in`, not enumerable), a null reads
     null until a report exists, an array is always an array. Held views, spreads, JSON
     serialisation (a backup's), the club view and the persisted decoder agree without a restart;
     the row written for the record carries the shape (absent / null / `[]`), never content, so a
     reopen, a backup and the rollback copy restore it.
   - *A copy written WITH a record is a claim, judged everywhere a record is written.* An array
     given to `IDENTITY_SNAPSHOT.replace` (a backup restore, a persistence suite), `initialize`
     (the first installation), `players.insert` or `players.restore` must equal the derived list
     entry for entry — ids, content, order, no duplicate — else the WHOLE write is refused with
     the player and report ids (`players pl-x: trialReports[0] (rep-1) has no trial report with
     that id …`); nothing is dropped and the save revision does not advance. The snapshot writer
     judges against the FINAL trials: those supplied with the snapshot (written as a blob in the
     same transaction) when it carries `trials`, the retained blob when it omits them; a trials
     value no list can be read from is refused while a copy exists. **Omitted or null is no
     claim**: the trials stand and the record reads back with whatever reports name it. A
     trials-only snapshot (no players) legitimately changes the derived view and needs no player.
6. **Snapshot replacement under child foreign keys.** `IDENTITY_SNAPSHOT.replace` keeps its
   rewrite strategy (links, players, guardians deleted, the validated candidate inserted in
   snapshot order) and now writes every child row of every player from the record's arrays in the
   same transaction, so the FINAL state is complete: the cascade that empties the child tables
   when the player rows go is followed, in the same statement sequence, by the children of the
   new rows. Omitted versus explicitly empty is a property of the **record**, not of the
   snapshot: a record without `media` reads back without it (no rows, `__meta.order` lacks the
   key), a record with `media: []` reads back with `[]`, `media: null` with `null`. A partial
   snapshot that omits `players` and `guardians` leaves every identity table and every child table
   alone (as before).
7. **Media ownership.** `liveMediaReferences` reads `player_media (player_id, id)` once
   `0007_player_subrecords` is recorded, the `players` facets before it (a database between 0005
   and 0007, which the same boot upgrades), and the records the server holds in memory in both
   cases. Everything that used it is unchanged: the migration 0006 import, the snapshot final-state
   check, the sweep's quarantine, the backup's 409, the pending-queue rollback refusal. Account
   deletion reads the media ids off the record before `players.remove`, queues them in the same
   unit, and the row delete cascades the child rows (as the queue entry, not the row, is the
   authority for the file).
8. **Privacy.** The audience allowlists (`views/playerViews.mjs`) are unchanged: medical records
   reach an organisation only when `medical.shared`, attendance loses its GPS fix, activity,
   external ids, drill results and other clubs' reports are never served. S5 gives these rows
   their own tables so a future org-facing query can leave them unjoined; today's org view is
   built from the in-memory record exactly as before, and the real-server test asserts the
   responses field by field.
9. **Writers.** Every in-place writer above becomes a repository call: `players.addItem(id, key,
   item)`, `players.setItems(id, key, items)`, `players.patchItem(id, key, where, patch)`, where
   `key` is one of `media, attendance, timeline, badges, drills, drillResults, activityLog,
   externalIds, seasonHistory, medical.records, programme.completed`. Each validates first (a
   refusal throws before any statement), runs its statements and only then its memory
   bookkeeping, outside a unit in a transaction of its own and inside a unit through
   `store.unit.join` (the S4a boundary). Routes that change a child row together with a blob, an
   audit row or another record run in one unit of work. `players.insert` writes the record's
   arrays as rows in the same transaction; `players.restore` rewrites them to the given record's.
   **Corrected after the review of `132eda2`:** `players.update(id, { medical: null })` (and
   `programme: null`) is refused while the player has `medical.records` (`programme.completed`)
   rows — a whole-null composite would hide authoritative rows from every view, the export and the
   rollback; the error names the player, the rows, the table and the explicit clearing operation
   (`players.setItems(id, 'medical.records', [])`, then null). A null composite without rows, the
   scalar sub-key updates (`medical.shared`, `conditionStatus`, `programme.track`, `startedAt`) and
   the key appearing again through `update` stay supported; no deletion policy is implied.
10. **Rollback.** `scripts/playerSubrecordsRollback.mjs` (copy-only, `VACUUM INTO`) rebuilds the
    `480afdb` representation: every array back into `facets_json` under its own key (the layout
    that build reads), `trialReports` rebuilt from the `trials` blob in the derived order, the
    twelve tables dropped, the `0007` record and `meta.playerSubrecordsCutover` removed,
    `meta.saveSeq` advanced; the media queue and migration 0006 are untouched (both builds have
    them). Refusals (no output): `LATER_SCHEMA` (a step after 0007), `NOT_CUT_OVER` (no 0007),
    `OUTPUT_NOT_EMPTY`, `UNEXPECTED_SCHEMA`, `TRIALS_UNREADABLE`, and — corrected after the
    review of `132eda2` — `INCONSISTENT_ROWS` (exit 11): a player row whose shape metadata says
    `medical` or `programme` is null or absent while its child rows exist. That refusal is the
    one decoder's (`playerFromRow` with children), so the boot, a backup (`IDENTITY_SNAPSHOT.read`)
    and the snapshot store refuse the same file the same way rather than certify a view or an
    output that hides the rows; the source is untouched and no partial output remains. Rows of a
    sub-key a present composite's shape never listed are appended, never hidden. The S4a→S3 tool
    (`coreIdentityRollback.mjs`) refuses a database carrying 0007 with `LATER_SCHEMA` (it already
    refuses every id it does not know); a test pins it. Post-S5 writes survive the rollback (they
    are rows, rebuilt into facets).

## 3. The tables (as created by migration `0007_player_subrecords`)

Every table: `player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE`,
`position INTEGER NOT NULL` (array index), STRICT; the item tables carry `extra_json TEXT CHECK
(json_valid)` for unknown keys and the item's shape metadata. Column mappings are in
`repositories/playerSubrecords.mjs` (`SUBRECORD_SPECS`) and the DDL in `sql/01_identity.sql`;
`scripts/testSchemaDdl.mjs` asserts the migration equals the document column for column.

| Record field | Table | Key | Columns (record key → column) |
|---|---|---|---|
| `seasonHistory` | `player_season_history` | `(player_id, season)`, UNIQUE `(player_id, position)` | `season`, `appearances`, `goals`, `assists`, `paceKmh→pace_kmh`, `passCompletionPct→pass_completion_pct`, `duelSuccessPct→duel_success_pct`, `cleanSheets→clean_sheets` |
| `badges` | `player_badges` | `(player_id, position)` | `badge` (the string) |
| `drills` | `player_drills` | `(player_id, position)`, UNIQUE `(player_id, drill_id)` | `drill_id` (the string) |
| `attendance` | `player_attendance` | `id` | `fixture`, `venue`, `date→match_date`, `gps.lat→lat`, `gps.lng→lng`, `deviceConfirmed→device_confirmed`, `verified`, `corroboratedBy→corroborated_by`, `trialId→trial_id` |
| `timeline` | `player_timeline` | `(player_id, position)` | `year`, `event` |
| `media` | `player_media` | `id` | `title`, `kind`, `uploadedAt→uploaded_at`, `url`, `views`, `verifiedClip→verified_clip_attendance_id`, `captions`, `sizeBytes→size_bytes`, `capturedBy→captured_by`, `boxSessionId→box_session_id`; `tags{}` → `player_media_tags (media_id, tag, count, position)` |
| `medical.records` | `player_medical_records` | `id` | `type`, `title`, `date→record_date`, `layoffWeeks→layoff_weeks`, `cleared` |
| `drillResults` | `player_drill_results` | `id` | `drillId→drill_id`, `drillName→drill_name`, `metric`, `unit`, `value`, `verified`, `ts→recorded_at` |
| `activityLog` | `player_activity_log` | `(player_id, position)` | `occurred_at` (the number) |
| `externalIds` | `player_external_ids` | `(player_id, provider, external_id)`, UNIQUE `(player_id, position)` | `provider`, `externalId→external_id`, `source`, `by→linked_by_name`, `at→linked_at`, `claim→claim_json` |
| `programme.completed` | `player_programme_completions` | `(player_id, position)` | `sessionId→session_id`, `ts→completed_at` |

## 4. Migration `0007_player_subrecords`

Inside the runner's one transaction: create the twelve tables; decode every `players` row through
the established decoder (`playerFromRow`: the current layout and the legacy `__rest` layout);
validate every item of every array (the same validator the repository uses) and reconcile every
`trialReports` copy with the `trials` blob (decision 5); **any refusal aborts the whole step**
with `PLAYER_SUBRECORDS_CUTOVER_BLOCKED` listing player ids, fields, indexes and reasons (the
file is byte-identical, the next boot refuses the same way); otherwise write every child row,
re-read each player through the new path and compare it with the decoded record byte for byte
(**the candidate is verified before its source fields are retired**), then rewrite `facets_json`
without the arrays and record `meta.playerSubrecordsCutover` (counts only). An empty `players`
table (a first installation, whose seed is initialised afterwards by the data layer) creates the
tables and imports nothing. The step never runs twice (recorded) and refuses to run before 0005.

## 5. Tests

`scripts/testPlayerSubrecords.mjs` (unit, temporary databases): the item mapping round trip
for every table with populated, empty, null and absent arrays, order, legal duplicates, old
`__rest` layouts, unknown item fields, prototype-named keys; refusals by player, field and index
(wrong types, unsafe integers, unique violations, dangling `verifiedClip` accepted as text);
migration 0007 on an S4a file (imports, verifies, retires; blocks on a bad item and on each
`trialReports` discrepancy; repeat boot; intentional-empty; first installation); the repository
methods with a real store (standalone COMMIT failure, inside a unit with a caught failure, a
real COMMIT failure, retry); snapshot replacement under the child FKs (normal, partial,
explicitly empty, omitted key); media ownership through `player_media`; the rollback tool and
the S4a tool's refusal. `scripts/testCoreIdentityServer.mjs` and `scripts/testWriterAtomicity.mjs`
(real server): the converted routes with a second connection, SIGKILL, injected failures after
the row, a real COMMIT failure and retry — medical record with condition and sharing, media with
tags and ownership, activity with stats and badges, trial check-in, import link, Box Cam clip;
private-view non-exposure; hard-delete cascade with the queued files; backup and restore; the
rollback copy opened by the real `480afdb` build on synthetic data.

## 6. Status

**Review-accepted at `2178c5b` (12 October 2026).** The independent reviewer verified the
handoff archive's SHA-256; re-ran the original `review-132eda2-reproductions.mjs` unchanged
(0 of 3); ran the full `npm test` on a real Node v24.19.0 (17 suites, 244 checks, exit 0); ran
the five historical review scripts (pass) and both S5-adapted scripts (pass). Not independently
repeated by the reviewer: the battery, the Node 22 runs, the browser suites and the old-build
proof — those stand as this work's own evidence (below and in the handoff). Recorded as stated by
the reviewer: this acceptance is not a production-deployment authorization. S4a stays accepted
at `480afdb`; S4b is not implemented (O1 partially resolved, `s4-deletion-decision.md` §10); S6 is
not started (`s6-readiness-review.md`). The paragraphs below are the status as written at the
end of the correction round and are kept as the record of what was delivered.

**Correction round (review of `132eda2`; implemented, pending review).** The reviewer's
independent reproduction (`review-132eda2-reproductions.mjs`, run unchanged) reproduced three
findings on `132eda2` and reports 0 of 3 on the corrected tree, controls passing. Finding 1 (P1): a
whole-snapshot save accepted a `trialReports` copy with no trial and silently dropped it while the
unrelated edit committed — corrected by judging every copy written with a record as a claim
(decision 5 above: at `IDENTITY_SNAPSHOT.replace`, `initialize`, `insert`, `restore`), refusing the
whole write with ids and rolling back the revision. Finding 2 (P2): the derived accessor was
installed only where the record had an array, so a legacy record saved without the key or with
null showed a new report only after a restart — corrected by installing it on every record with the
empty-state shape preserved (decision 5). Finding 3 (P2): `players.update` accepted `medical: null`
/ `programme: null` while child rows existed, hiding them from the export and losing them in the
rollback copy — corrected by refusing the update while rows exist (decision 9) and by making the one
decoder refuse an already inconsistent file (`INCONSISTENT_ROWS`, decision 10), so boot, backup and
rollback refuse rather than certify. Failing-first regressions: three tests in
`scripts/testPlayerSubrecords.mjs` (each confirmed failing on `132eda2`) and one real-route test in
`scripts/testCoreIdentityServer.mjs` (a report filed for a legacy-shaped account appears at once;
the sign-up control). Test fixtures that planted `rich()` with its report copies and no trials now
supply the trials (`trialList: trials()`): the planted state is exactly the one the claim rule
refuses. No table, facets layout, privacy rule or S4a correction changed. Verification of this
round is listed in the handoff README.

**Implemented, pending review** — one local commit on `feat/sqlite-schema` on top of the
review-accepted S4a commit `480afdb` (its hash, branch and tree status are in the handoff
README). Nothing was pushed, merged, deployed or run against real data; S4a stays accepted at
`480afdb`, S4b stays blocked by O1, S6 is not started.

**What the commit holds.** The twelve `player_*` tables and migration `0007_player_subrecords`
(§4); the item mapping and validation in `repositories/playerSubrecords.mjs` and
`identityMapping.mjs` (`playerToRow(rec, { subrecords })`, `playerFromRow(row, { children,
trialReports })`); the repository writers `players.addItem` / `setItems` / `patchItem`, child rows
in `insert`, `restore` and `IDENTITY_SNAPSHOT.replace`, the derived `trialReports` (§2.5); media
ownership read from `player_media` (§2.7); every writer of §1 converted (server, `m12`, `m13`,
`m16`, `m29`, the boot defaults); the copy-only rollback tool and the S4a tool's refusal of an
S5 file; the DDL, schema, plan, operations guide and `CLAUDE.md`; the tests of §5 plus the
real-route regressions in `testCoreIdentityServer.mjs` (one S5 journey: clips, tags, views,
timeline, badges with a duplicate, season history, medical record, drill and result, programme
completion, Box Cam clip, import link, trial check-in, derived report, club-view privacy, SIGKILL
and restart, admin backup and restore into a new directory, hard delete) and in
`testWriterAtomicity.mjs` (media upload + activity, then tags + ledger; attendance + activity +
badge + ledger; drill + result + activity — each with a second connection, SIGKILL, the seam
after the first row and the real COMMIT failure, then the retry).

**One behaviour change beyond the storage move.** `GET /player/drills` answered 500 for a player
who had never completed a drill: a sign-up creates no `drillResults` (the first completion
appends the array) and the route read it unguarded — on `480afdb` as well. It now reads a missing
list as empty. Found by the drill regression on a fresh sign-up; nothing else in the route changed.

**Behaviours observed and deliberately preserved (not changed by S5).** The boot defaults
(`captions: null` on clips, `externalIds: []`) reach a record created *after* a boot only at the
next boot, on both builds; a trial report is written on the `trials` blob by the ordinary debounced
save, as before S5, so a SIGKILL inside that window loses it on both builds (the derived
`trialReports` simply reflects the trials); a media upload whose unit is refused leaves the
already-written file unreferenced on disk, as before S5 — nothing serves it.

**Verification (synthetic data, temporary directories only).** `npm test` (17 suites) on Node
22.22.2 and on the real 22.16.0 binary; the real-server and writer-atomicity suites on their own;
the seven independent review scripts on this tree — five pass verbatim; two are stale on S5 *by
construction* and are kept verbatim with their stale result: `review-9656a4b-reproductions` counts
medical records inside `facets_json` (its words "the split persists" describe its own stale read:
the records are rows of `player_medical_records` and the facets hold none by design), and
`review-64ef3aa-pending-rollback` hands an S5 file straight to the S4a rollback tool, which refuses
the later schema step (exit 4) before anything else. Each has a behaviour-level equivalent with one
marked change (the record count read from the table; the S5 tool run first, as the documented
chain), both passing. The real `480afdb` build was booted on a rollback copy (detached worktree,
scratch script and log in the handoff): it attaches, serves the same record — ids, order, the
duplicate badge, the null url, the GPS fix, the reconstructed `trialReports` copy — accepts the
S5-minted session and a write of its own, and this build re-upgrades the copy with that write kept
and no `trialReports` copy left. The battery (48 suites) ran once after the last production
change: 46 green as run; `m182E2E` keeps its two baseline client-side failures (identical since
`66c095c`); `m23TrialPersistence` failed as run because its planted snapshot gave a legacy trial a
filed report while the player's stored `trialReports` copy was empty — a state no pre-S5 build
produced (the report route wrote both together) and exactly the refusal of §2.5 (`players pl-x:
trial report rep-1 names the player but the player's trialReports does not carry it; the player
would gain a report`); the fixture now carries the copy and the suite passes 36/36. No production
code changed for it. Classification in the handoff (`battery-notes.txt`).
