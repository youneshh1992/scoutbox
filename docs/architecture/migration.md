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

40 migrations are registered in `repositories/index.mjs` (`DATA_MIGRATIONS`). The next free id is `0041`. Each step
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
| S13b | enterprise: staff invites, SSO, support tickets and support access | `0035` | `enterprise` | done |
| S13c | group workspaces and group grants | `0036` | `groups` | done |
| S13d | grassroots operations: open days, match days, the friendlies board | `0037` | `grassroots` | done |
| S13e | uploads, saved searches, invoices, the demo reputation seed, the delivery centre's bookkeeping (plans and archetypes became constants) | `0038` | `operations` | done |
| S14a | retire the blob itself: the `collections` table, `db.schema` and the snapshot migration registry, the store contract, the `??=` and `migrateMxx` lines; the id counter becomes a table | `0039` | `counters` | done |
| S14b | safety and audit become explicit writes and SQL reads; their tables re-typed (vocabulary CHECKs, details as typed columns by type, organisation and staff keys) | `0013` (amended in place) | `safetyAudit` | done |
| S14c | message threads become explicit writes and SQL reads; the tables re-typed (the request key from the start, the activity time, the sender by kind with staff a key, length CHECKs, the retry id unique) | `0012` (amended in place) | `channels` | done |
| S14d | delivery dispatches, the mail outbox, the push log and device tokens become explicit writes and SQL reads; the tables re-typed (vocabulary CHECKs, a staff audience's organisation as a key, integer clocks, an address on every outbox row, one row per device token) | `0010`, `0011` (amended in place) | `dispatches`, `outboxPush` | done |
| S14e | notifications and their preferences become explicit writes and SQL reads; the tables re-typed (the audience kind's vocabulary, a staff audience a key, length and category CHECKs, the delivery marker; the group key and acknowledger worked out) | `0009` (amended in place) | `notifications` | done |
| S14f | staff and sessions become explicit writes and SQL reads; the staff table re-typed (a name unique in its organisation, removed accounts included; an e-mail unique among current staff; MFA and delivery preferences as columns, recovery codes as child rows; the remover a key) and an org session's staff and organisation one key | `0001`, `0002` (amended in place; `0004` no longer rebuilds `org_users`) | `users`, `sessions` | done |
| S14g | organisations become explicit writes and SQL reads; the table re-typed (no `facets_json`, length and range CHECKs, a ground as both coordinates or neither, a federation registration as both parts or neither, `created_at` required; the password hash off the record) | `0004` (amended in place; `0021`, `0023`, `0026` no longer edit facets) | `orgs` | done |
| S14h | players and guardians become explicit writes and SQL reads; the tables re-typed (no `facets_json`, lengths, ranges and vocabularies CHECKed, keys inside the domain RESTRICT, one primary link per player; `coGuardians` worked out, the external id's copied claim a review key) | `0005`, `0007` (amended in place; `0002` no longer creates identity shadows) | `identity` | done |
| S14i | the hot player reads in SQL: the directory, the Film Room, the fixture graph and a role's candidates page by cursor; the feed, similar players, the rotation and the benchmarks read light rows or a `GROUP BY`; the whole visibility rule in SQL; profile completeness a column (`players.profile_signal`) | `0005`, `0007` (amended in place) | `identity` | done |
| S14j | matching, the watchlists and Nobody Missed in SQL: each player's facts projected into `player_match_facts`, kept by triggers on its inputs and re-derived before every COMMIT; the 2,000-player cap gone; the lists paged by cursor | `0040` | `matchFacts` | done |
| S14 last | the save path, `db` and snapshot mode go (§4.6) | | | **next** |

Steps before S8 were staged (written at save) rather than explicit; S4a's identity writes are explicit since §4.3.1 (and
its mirror gone since S14h), S6b's since S14b, S7d's since S14c, S7b's and S7c's since S14d, S7a's since S14e, S0's and
S2's since S14f, S3's since S14g. No repository keeps a mirror any more.

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
  writing anything.
- **Reads.** No mirror. The old `db.<collection>` name throws, naming the repository: don't delete it, or the `??= []`
  lines and `Array.isArray` guards quietly see an empty collection. The repository answers indexed queries (`byId`,
  `forOrg`, `forPlayer`, counts…) with fresh deep-frozen records; a read inside a unit sees the unit's writes. Modules
  receive a per-domain reads object on their context (`recruitmentReads`, `scoutingReads`, `verificationReads`,
  `agentReads`, `complianceReads`, `transactionReads`, `developmentReads`, `boxCamReads`, `discoveryReads`, `insightReads`, `integrationReads`, `enterpriseReads`, `groupReads`, `grassrootsReads`, `safetyReads`; matching and Nobody Missed the `matchFacts` repository through `domains/discovery/matching/query.mjs`; S13e's few readers take the `operations` repository itself, the threads' the `channels` repository, the delivery centre the `dispatches` and `outboxPush` repositories, the feed and preferences the `notifications` repository, staff readers the `users` repository or `byId.user`, organisation readers the `orgs` repository or `byId.org`, and player and guardian readers the `players` and `guardians` repositories or `byId.player` / `byId.guardian`); pure projectors take `reads`. Sweeps are indexed predicates, admin figures are
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
- **Org facets.** None are left (S14g dropped `orgs.facets_json`): an organisation record has only its typed fields, and
  a former facet's refusal names its repository. `orgSafe` (login, admin clubs) is an allowlist and adds what the apps
  read from `session.org` explicitly (looking-for, the federation check). A whole-replace save of a list with
  dependants diffs by id, so kept rows keep their dependants.
- **Seeded catalogues** (templates, policy versions) are inserted by the migration.
- **Clean-up.** Nothing creates a collection in memory any more (S14a); a step deletes its domain's old names
  from whatever still mentions them.

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
- `/org/rooms` (197 ms) and a Room (10–12 ms): mostly the per-player Passport and Trust assembly (a comment's author
  is a staff lookup by id since S14f).
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
- Discovery (S12c, S14j): matching, Nobody Missed, the evaluation coverage and a watchlist's membership are SQL over
  every visible player joined to the stored facts (no cap), paged by cursor, decoding only the page. Each still counts
  its whole match set for `total` (about 30 ms per count at 100k players, so matching is 40–70 ms and Nobody Missed,
  which counts three times, about 100 ms); the default and name orders walk an index of the facts. A watchlist read
  reads and compares its whole stored membership (about 0.4 s at 20,000 members): that needs the comparison in SQL.
  Second Look projects one club's ended Rooms. Opening a watchlist writes its reconciliation clock every time (the
  screen shows "as of"), the membership only when it changed.
- Match facts (S14j): every write to an input re-derives its player before COMMIT (the trust band included, about
  0.7 ms); an organisation's standing re-derives the players linked to it, bounded by that club's squad, invites,
  signings, assessments and claims. A first installation, a snapshot import or a policy change derives every player at
  boot, in one transaction (about 70 s at 100k players).
- Insight and coverage (S12d): the exposure funnel, review queue and player bands are `GROUP BY`s over the 90-day
  window, but the queue then checks each player's live visibility in code, and the discovery rotation still reads every
  visible player (`players.visibleCandidates`, S14h). Bounded by one club's exposure, not the player base, except the
  rotation. The
  coverage fixture list is one SQL union of the club's fixtures, the friendlies and the open days, paged by cursor
  (S13d); suggested visits still filter every upcoming located fixture in code.
- Grassroots operations (S13d): the friendlies board and a guardian's local open days prefilter by a latitude/longitude
  box on the host club's location, the exact 50 km test in code, so a board page is cut after filtering. The player
  opportunity board (opportunities and open days) is filtered per player in code and then paged. Bounded by the
  clubs and upcoming events, not the player base.
- Safety and audit (S14b): `/org/reputation` is a `GROUP BY` over the whole ledger (every club's actors), one pass
  per request that grows with the ledger; it needs its own projection. A player's "who's watching" insights and the
  data export read that player's ledger whole (per-player, unpaged by rule).
  The admin report triage orders by a computed rank, so each page sorts the whole reports table (no index serves it).
- Message threads (S14c): a page of a club's inbox decodes each thread's messages whole (per-thread, unpaged by
  rule), so a page grows with the length of its 50 conversations. The player's, guardian's and export lists are
  per person and unpaged. The org's unread count is one join over the club's messages.
- Operations (S13e): a new player's saved-search alerts read the searches of current staff that SQL prefilters by
  position, foot, country and availability, then apply the whole filter in code. Bounded by the clubs' saved searches,
  not the player base.
- Notifications (S14e): a person's feed is unpaged (per person, by rule) and read whole, so a busy staff member's bell
  grows with their history; it needs paging (and the apps a "load more") if feeds get long. The preference gate reads
  the person's preferences once per notice. The delivery sweep's two scans are indexed SQL (the undispatched marker,
  and a join from the unopened in-app dispatches to the read notifications).
- Players (S14i): the directory, the Film Room, the fixture graph and a role's candidates are exact SQL pages (the
  whole visibility rule, the blocks and the 50 km radius included, is the query's), and the feed reads the newest
  rows by index. Similar players, "more like this" and the discovery rotation still rank every visible player, but
  over light rows (the row's own columns, no lists), decoding only the winners; the benchmarks read the cohort's light
  rows and one `GROUP BY` of drill bests. Matching and Nobody Missed read the stored facts in SQL since S14j.
  A deep directory page walks the index from its leading key (Academy+, or First Team Seeker for Grassroots). The
  Grassroots directory orders by distance, so each page sorts the players inside the club's radius. The Film Room
  pages by view count, which other scouts' views change, so a clip can move across a cursor while someone pages. The
  apps' player pickers (assessment, case, objective) walk every directory page; a large club needs a search box there.

### 4.3.1 Costs that grow with the whole player base

Lookups by id go through the repositories' indexes (`byId` on every module context, `domains/platform/lookups.mjs`),
and player and guardian writes are explicit repository operations, so a write or a unit of work never touches every
player. `scripts/testUnitOfWork.mjs` holds that line: a player write costs the same number of SQL statements with 20
and 2,000 players. Players get their defaults at creation (`players.create`), not by a boot backfill.

**Left:** an empty unit of work cost about 23 ms at 30k players, mostly the organisations (captured and flushed
whole per unit, because their facets were edited in place) and the blob collections' memento. The memento went with
the blob (S14a), the notifications' whole-mirror copy per unit with S14e, the organisations' part with S14g
(`scripts/testUnitOfWork.mjs` asserts an empty unit runs no organisation statement), and the players' and guardians'
participant with S14h (the same test asserts an empty unit runs no identity statement). Nothing is left.

### 4.4 Code and test layout

- Each step first moves its domain's files into `domains/<domain>/` in a commit with no other change, then edits
  them. The agents code is already in `domains/agents/` (`core/`, `compliance/`, `transactions/`), the development code
  in `domains/development/` (`objectives.mjs`, `hub/`, `boxcam/` with the CV engine in `boxcam/cv/`), the discovery code
  in `domains/discovery/` (Second Look, briefs and Nobody Missed; M19 matching and watchlists in `matching/`), the insight and coverage code in `domains/insight/` (`insight.mjs`, `coverage.mjs`; the F9 deal budgets in `domains/recruitment/budgets.mjs`), the M13 F1 imports, API keys and webhooks in `domains/integrations/imports.mjs`, the F12 enterprise code (onboarding, invites, MFA, SSO, support, backups, metrics) in `domains/enterprise/enterprise.mjs`, the F8 group workspaces and grants in `domains/groups/groups.mjs`, the F12A resumable uploads in `domains/media/uploads.mjs`, the saved searches in `domains/discovery/savedSearches.mjs`. The M10 grassroots operations routes (open days, match days, friendlies) are still in `server.mjs`, beside the S9c squad routes they share helpers with. Still in milestone folders: `m12`, `m13` (mixed: split file by file as each domain comes round; `domains/scouting/scouting.mjs` still
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
| S13 Operations and integrations | `08_operations_integrations.sql` | Split in five, one migration each. **S13a (done)**: `importBatches`, `prospects`, `identityReviews`, `apiKeys`, `webhookEndpoints`, `webhookDeliveries`. **S13b (done)**: `orgInvites`, `ssoConfigs`, `ssoStates`, `supportTickets`, `supportAccessGrants`. **S13c (done)**: `groups`, `groupGrants`. **S13d (done)**: `openTrials`, `matchdays`, `friendlies`. **S13e (done)**: `uploadSessions`, `savedSearches`, `invoices`, `reputationSeed`, the `delivery*` bookkeeping; `plans` and `archetypes` became constants (`catalogue.mjs`), not tables | — |

**Open from earlier steps** (not blocking): a coach affiliation is matched to a staff member by display name (a
Founder question: keying it by account restricts affiliations to people with a login); `orgs.verified` is synced by
code, not derived from claims; assessment templates are shared by every club until after S14 (`known-issues.md`).

### 4.6 S14: retire the blob

Split in parts, like S12 and S13.

- **S14a (done, `0039`).** The `collections` table is dropped and the id counter is a row of `counters`, written at
  every mint; `meta` keeps only the initialisation states and the session lifetime. The snapshot migration registry
  (`domains/platform/migrations.mjs`, `db.schema`), `storeContract.mjs`, the `db.x ??= []` and `migrateMxx` lines,
  `db.mediaBlobs` and the blob fallbacks (`readTrialsCollection`, the media-deletion queue's) are deleted. The boot no
  longer loads a snapshot: `attachDataLayer` takes the seed as `seed` and imports it only on a first installation.
  The schema version is the latest table migration's number. A snapshot-mode save refuses a collection that has no
  table (`SNAPSHOT_COLLECTION_UNKNOWN`). `e2e/platform/storeGuarantees.mjs` asserts there is no blob table.
- **S14b (done): safety and audit** are explicit writes and SQL reads. Migration `0013` was amended in place: typed
  columns with vocabulary CHECKs, the moderation context as columns and its flags as child rows, the ledger and
  ops-event details as typed columns by type (the Combine protocols as child rows), the source change's positions as
  columns; organisations and staff are RESTRICT keys. Routes that wrote several rows are units (a block and its ledger
  row, a moderation hit and its escalation, an urgent report and its suspension, a resolution and the org's suspension).
  The admin reports, blocks and moderation lists, the club's ledger and the guardian's log page by cursor.
- **S14c (done): message threads** are explicit writes and SQL reads. Migration `0012` was amended in place: the
  request key is declared from the start (`0015` no longer rebuilds `channels`), `last_activity_at` orders the
  inboxes, a message's sender is typed columns by kind (staff a RESTRICT key to `org_users`), text is 1–4,000
  characters, the retry id at most 64 and unique per thread and sender. A message, its ledger row and its
  notifications are one unit. The club's inbox (with a `playerId` filter for the Room's panel) and the admin audit
  page by cursor, most recently active first; `/org/channels/counts` gives the unread badge. Views are allowlists.
- **S14d (done): delivery dispatches, the outbox and push** are explicit writes and SQL reads. Migrations `0010` and
  `0011` were amended in place: vocabulary CHECKs (channel, provider, status, audience kind, transports, a token's
  owner kind), a staff audience's organisation as a deferred RESTRICT key, integer callback clocks, a unique provider
  message id, an address on every outbox row and on every e-mail dispatch that is not skipped, one row per device
  token. A notification's dispatches are one unit; each send (its attempt, status, outbox row, injected-failure use
  and, when the retries run out, the ops event and webhook) is one unit; a callback event commits with its seen
  marker; junk callbacks are refused whole. Device tokens are players' and guardians' only, and a token another
  account registers moves to it. The admin outbox and push log and the club's delivery list page by cursor.
- **S14e (done): notifications and preferences** are explicit writes and SQL reads. Migration `0009` was amended in
  place: the audience kind is a vocabulary CHECK (`player`, `guardian`, `org_user`), a staff audience a RESTRICT key
  to `org_users` through a generated `staff_id`, lengths and the category vocabulary CHECKed, the preferences'
  `updated_at` required; `group_key` and `action_acked_by` are worked out on read; `dispatched_at` is the delivery
  centre's marker, set in the unit that makes the dispatches. `notify()` writes inside the announcing action's unit
  (or its own transaction) and its push and live event are `store.afterCommit` effects. Coalescing is "the newest
  identical unread row whose last occurrence was within six hours" (the old scan's early stop is gone). The
  preference route refuses non-boolean values (`400 PREFS_INVALID`) instead of coercing them; a notice's text is
  shortened to 2,000 characters; a system-raised report's resolution no longer writes a notice to nobody.
- **S14f (done): staff and sessions** are explicit writes and SQL reads, with no mirror and no `db.users` /
  `db.sessions` (the names throw). Migration `0001` was amended in place to create the final staff table (and `0004`
  no longer rebuilds it): name 1–120 and role 1–60 characters, required; a name unique in its organisation through
  the repository's `name_key` (case-insensitive, removed accounts included); an e-mail unique among current staff;
  an SSO subject unique in the organisation; `removed_by_id` a RESTRICT key (it was a copied name); the provenance
  vocabulary; MFA as `mfa_secret` and `mfa_enabled_at` with `org_user_recovery_codes` child rows (a code is spent by
  deleting its row); delivery preferences as columns. The TOTP secret is never on a record (`mfaSecretOf`). `0002`
  makes an org session's `(org_user_id, ref_id)` one key to `org_users(id, org_id)`. Writes are `create`,
  `update(id, draft => …)` and the MFA operations, and now join units: registration, the password bootstrap, an
  accepted invite, an agency team member's addition and ending, the claim approval and a staff removal are each one
  unit. Founder decisions: a re-invite restores the removed account; a name already in the organisation is refused
  (`STAFF_NAME_TAKEN`). Junk refused: a non-boolean e-mail switch on `/org/delivery/prefs`, a sign-in or invite name
  over 120 characters.
- **S14g (done): organisations** are explicit writes and SQL reads, with no mirror and no `db.orgs` (the name
  throws). No route wrote a facet any more (probed across every suite), so migration `0004` was amended in place to
  create the final table without `facets_json` (and `0021`, `0023`, `0026` no longer edit it): name 1–120, country
  1–40, a city 1–80 only with a ground, latitude and longitude in range and both or neither, a federation
  registration as both parts or neither, domains up to 253, `created_at` required and set at creation. A record has
  every field, always (null or false when unset), and never the password hash (`passwordHashOf`, `setPasswordHash`).
  Writes are `create` and `update(id, draft => …)` and join units: a grassroots registration (the club, its
  administrator and the session) and the T&S approval of a new organisation are each one unit now. Reads: `byId`,
  `list` (the sign-in pickers' filters), `page` (`/admin/clubs` and the player-facing `/orgs/directory` page by
  cursor; the apps read the first page), `locatedInBox` (the opportunity radar), `byName`, `count`. Junk refused:
  a non-boolean switch or a non-text domain on `/admin/clubs/:id/verification` and a non-boolean
  `mfaRequiredForLeads` (`400 FIELD_INVALID`) instead of coercing them. Removed: the never-set `closedAt` checks
  in verification. Founder decisions (7 Nov): the sign-in list stays unpaged, and the T&S-created grassroots
  club's placeholder ground stays, both in `known-issues.md`.
- **S14h (done): players and guardians**, the last staged repositories, are explicit the S8 way. No route wrote a facet
  any more (probed across every suite, 7 Nov), so `0005` is amended in place to create the final tables without
  `facets_json` (and `0002` no longer creates identity shadow tables): lengths, ranges and vocabularies CHECKed, a
  location as both coordinates or neither, keys inside the domain immediate `RESTRICT`. A record has every field,
  always; a player's lists come from their tables and `trialReports` from the trials; a guardian's `childIds` from the
  link rows and `coGuardians` from the guardians whose `co_guardian_of` names it; password and e-mail-code hashes are
  never on a record. `0007`'s `player_external_ids.claim_json` becomes `review_id` (the identity review keeps the
  row). Writes are `create`, `update(id, draft => …)`, the list operations (`addItem`, `setItems`, `patchItem`) and
  the link operations; `restore` and `remove` go (nothing called them). No mirror, no `db.players` / `db.guardians`
  (the names throw), no save hook or undo log, which closes §4.3.1. Reads: `byId`, `byIds`, `byEmail`, `byGuardian`,
  `byMediaId`, `linksOf`, `count`, indexed lookups for the imports and the agent search, the admin guardians list paged
  by cursor, and `visibleCandidates(org, filters)` for the directory-style reads (the under-18 wall, the grassroots
  box and the directory filters in SQL, the rest in code, output and order unchanged). The preflight and the
  shape-preserving mapping are deleted; the seed is imported with `create`. Junk refused: non-boolean switches,
  stats given as text, over-long names, non-numeric height and weight.
- **S14i (done): the hot player reads.** `0005` is amended in place: `players.profile_signal` (0–99, required) is
  the directory's sort figure, `domain.mjs` `trustScoreFromFacts` (the one definition `computeTrustScore` also uses)
  over the row and its counts of attendances, clips and the trials' filed reports. The identity repository refreshes
  it in every player write; a trial write refreshes its player's (the recruitment repository); a snapshot save
  refreshes all at its end. `players_directory (academy_plus DESC, profile_signal DESC, id)` serves the Pro order.
  The whole visibility rule is SQL now: the wall, the Grassroots radius (`haversine_km`, registered on the
  connection from `haversineKm`, on both sides of ±180°) and the blocks. The SQL functions are the JS rules
  (`haversine_km`, `distance_tenths`, `lower_js`). `0007`: a clip's `uploaded_at` is a `toISOString` instant
  (CHECKed and indexed), so the feed compares it as text. Paged by cursor (`{ items, nextCursor }`, the apps read the
  first page): `/org/players` (the declared order, the id tie-break in code-point order), `/org/filmroom`,
  `/org/fixtures` (groups newest first, then by fixture name), `/org/vacancies/:id/candidates` (`nextCursor` beside
  `candidates`; a required criterion not met excludes in the query, each criterion's SQL beside its JS check).
  Similar players and "more like this", the rotation and the benchmarks read light rows (`players.scanLight`); the
  feed reads the newest 40 of each kind. Junk refused: an unknown `ageGroup`, a `newDays` that is not a whole number
  from 1 (`400 FIELD_INVALID`); paging junk as everywhere. Founder decision (7 Nov): showing 50 at a time in the
  directory and the Film Room is fine until a frontend "load more" pass.
- **S14j (done, `0040`): matching and Nobody Missed.** Each player's facts (the Passport position and availability,
  the evidence-confidence band, the newest evidence and footage, a coach reference, a confirmed club, the live
  production Combine results) were built in code from several domains for every visible player on every read, capped
  at 2,000. They are a derived projection now (`repositories/matchFacts.mjs`): `player_match_facts` with the
  secondary positions and Combine results as child rows, and `player_match_facts_dirty`. Nobody writes it by hand:
  triggers on every input table (`MATCH_FACT_INPUTS`; an organisation's verified, suspended or revoked standing
  marks its linked players; an UPDATE marks only on a real change of a listed column) mark the player, and the
  keeper (`domains/discovery/matchFacts.mjs`) re-derives the marked players before every COMMIT
  (`onBeforeCommit` in `repositories/database.mjs`, run by `transaction()` and the store's units and saves; a failure
  rolls the write back). `refresh_due_at` is the next instant time alone changes an input (evidence expiry, a claim's
  `valid_until`, an agreement's term, adulthood); the minute sweep re-derives what is due (Founder decision, 8 Nov: a
  minute is fine). A policy key in `meta` (the trust policy version and the simulated-evidence setting) rebuilds
  every row at boot when it changes. The trust band's history source reads the Passport's club history alone
  (`passportHistoryFor`), not the whole light Passport. Reads: each criterion has an SQL condition beside its JS test
  (`criterionSql` in `matching/match.mjs`; `scripts/testMatchFacts.mjs` requires them to agree over generated facts
  and criteria), joined to identity's `visibleWhere` (the whole visibility rule first); the nine evaluation signals
  are one set of the club's own players. `POST /org/matching`, `GET /org/watchlists/:id` and `GET /org/nobody-missed`
  page by cursor (`{ items, nextCursor, total }`; Founder decision, 8 Nov: match everyone, but page the lists); an
  `offset` is refused (`400 PAGE_OFFSET_UNSUPPORTED`). The name order folds case and accents; a watchlist's
  "recent evidence" order is the newest evidence first (it was the id). The apps read the first page.
- **S14 last: the save path goes.** `persist()`, `persistNow()`, the debounced save, the save hooks,
  `repositories/memento.mjs`, `repositories/readonly.mjs` and `db` itself; then snapshot mode (`openStore(dir)`
  with whole-file `load`/`save`) and every domain's `*_SNAPSHOT`, with the suites setting up their data through the
  repositories or SQL. The migrations `0001`–`00NN` may be squashed into one baseline, if that helps.

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
- **Boot.** `server.mjs` opens the store and runs `attachDataLayer({ db, seed: buildSeed(), … })`: the table
  migrations, then every repository; a first installation imports the seed once. `db` receives a throwing name for
  every retired collection (since S14h, every collection).
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
