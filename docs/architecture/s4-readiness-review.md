# S4 readiness review: guardians, players and the guardian–child link

Companion to [`sqlite-migration-plan.md`](./sqlite-migration-plan.md) (§S4) and
[`sqlite-schema.md`](./sqlite-schema.md) (§5.1, §9, §10). Written 11 October 2026 on branch
`feat/sqlite-schema` at commit `d4ca3f2` (S3 done and reviewed), by reading the code as it is
today. Every claim below carries a file and line (`S:` is `scoutbox-server/server.mjs`; other
paths are relative to `scoutbox-server/`). Line numbers are from this commit; `01_identity.sql`
and the plan cite lines that have drifted by a few places.

**Status: preparation only.** Nothing in this document is implemented. S4 does not start
until the Founder has answered the deletion question in
[`s4-deletion-decision.md`](./s4-deletion-decision.md) (O1), and that answer is taken by S4b
below, not by S4a. Nothing here changes the UI, permissions or the deletion policy.

Sections: 1 what S4 is and is not · 2 player fields · 3 guardian fields · 4 what moves, what
stays nested · 5 relationships, minors, duplicates, inconsistencies, invalid records · 6 views
per audience (explicit allowlists) · 7 migration, restart, authority, sessions, failed saves ·
8 rollback · 9 implementation sequence and acceptance tests · 10 implemented versus proposed ·
11 open points.

---

## 1. What S4 is, and is not

- **Is:** `guardians`, `players` and `guardian_children` become live tables owned by
  `repositories/guardians.mjs` and `repositories/players.mjs` (new), created by migration
  `0005_core_identity_live`, following the S3 pattern exactly: scalar and composite fields in
  columns, every nested structure that waits for a later step in a transitional `facets_json`
  column on the same row (byte-for-byte shape preservation through `__meta`), writers of
  column-backed fields converted to repository calls, in-place facet writers left alone,
  committed-only change tracking through the store's save hook, explicit initialisation state,
  `attach()` that never imports, a rollback tool on a copy. The S1 shadow of these three tables
  is retired (every core identity table is then live). Reads that today scan `db.players` keep
  working through the read-only view; the org-facing, agency-facing, guardian-facing and admin
  views are rebuilt from **explicit allowlists** that keep every access rule in `domain.mjs`
  and the routes as it is.
- **Is not:** the twelve `player_*` sub-record tables (S5: the arrays stay in `facets_json`),
  recruitment (S8), any change to who may see what (the allowlists reproduce today's rules; the
  fields that today leak past a blocklist are listed in §6 so the decision to stop leaking them
  is explicit), any deletion-policy change (S4a keeps today's hard delete behind a repository
  method; S4b implements whatever O1 decides), a guardian deletion route (S4b, after O1), the UI.

## 2. Player fields: current readers and writers, proposed storage

Creation points: seed (`seed.mjs` `player()` 496–522, records 115–421 and 446–462), adult
signup (S:1144–1178), guardian-created child (S:1386–1418), boot defaults (S:217–226,
241–244; `m12/shared.mjs:33`; `m13/shared.mjs:47`). The shadow's column mapping
(`repositories/shadow.mjs:103–118`) already covers every scalar below and is the basis of the
import. "Column" means a column of the live `players` table; "facet" means the transitional
`facets_json` on the same row until S5.

### 2.1 Scalars

| Field | Shape | Written after creation by | Read by (main) | S4 storage |
|---|---|---|---|---|
| `id` | `pl-N` | never | everywhere | column, primary key |
| `name` | string | never (no profile-edit route) | search S:1900; copied into many collections (§2.4) | column |
| `dob` | `YYYY-MM-DD` | never | `domain.mjs:77`; S:1059, 3114, 3184; `m12/shared.mjs:101`; `m15/passport.mjs:191`; `m16/combine.mjs:48`; `m13/insight.mjs:96`; `m13/imports.mjs:95` | column `birth_date` (NOT NULL, 10 chars) |
| `country` | ISO‑2 | never | `domain.mjs:78` (age of majority); S:1906, 3184 | column |
| `city` | string, `''` for guardian-created children | never (blanked only inside the minor org view, S:1078) | S:1900; `m15/passport.mjs:211` | column |
| `position` | enum or null | never | `domain.mjs:177, 337`; S:1903, 3569, 3648; `m12/scouting.mjs:713` | column (CHECK) |
| `foot` | `left`/`right`/null | never | `domain.mjs:177, 339`; S:2397 | column (CHECK) |
| `heightCm`, `weightKg` | number/null | never | `domain.mjs:177, 344–345`; S:3185 | columns |
| `squadNumber`, `contractUntil`, `marketValueRange`, `agentName` | scalar/null | never | only the org-view spread (removed for grassroots orgs S:1084–1087) | columns |
| `academyPlus` | bool | S:3337 | S:1905, 1933, 2309 | column |
| `availability` | enum | S:1570 (guardian), 2820 (squad release), 3444; `m29/index.mjs:295` | S:1904, 2394; `m12/scouting.mjs:723` | column (CHECK) |
| `contractStatus` | enum | S:2821, 3445; `m29/index.mjs:294` | S:3441; `m29/signing.mjs:356` | column (CHECK) |
| `identityVerified` | bool | never | `domain.mjs:173`; S:3185; `m15/passport.mjs:184`; `m162/trust.mjs:53` | column |
| `guardianId` | id/null | S:3140 (aging-up → null) | S:1055 (removed from org view), 3122, 3134, 2579, 2740, 4268; `m23/contact.mjs:276` | column `guardian_id` (FK → guardians, SET NULL); must equal the `role='primary'` link (§5) |
| `createdAt` | ms | never | S:1913, 2356 | column |
| `password` | scrypt string/null | S:1195 (rehash on login) | S:1192–1193; removed from every outward view | column `password_hash` |
| `level` | enum | `m29/index.mjs:278` (signing); `m13/transitions.mjs:202` (admin review) | `domain.mjs:116`; S:952, 1092, 3556, 3836; `grassrootsJourney.mjs:90,125,142`; `m12/shared.mjs:104` | column (CHECK) |
| `firstTeamSeeker` | bool (boot default S:242) | S:3676, 3837 | S:1089, 1925 | column |
| `footballCategory` | enum/null, lazily set | `m12/operations.mjs:280` | `m12/scouting.mjs:734`; `m12/shared.mjs:109` | column |
| `deletedAt`, `removedAt` | **never written** | — | read at `m23/contact.mjs:251`, `m27/index.mjs:183, 597` (dead checks today) | `deleted_at` column exists in the DDL; **set by nothing until O1 is decided (S4b)** |

### 2.2 Nested objects and arrays

| Field | Shape | Written by | Read by (main) | S4 storage |
|---|---|---|---|---|
| `stats` | `{appearances, goals, assists, paceKmh, passCompletionPct, duelSuccessPct, cleanSheets?}` or null | S:3500 (replaced whole) | `domain.mjs:177, 362`; S:3188, 3617; `m12/scouting.mjs:727` | composite → `stats_*` columns (null object → all NULL, presence kept in `__meta`) |
| `medical` | `{shared, records[], conditionStatus}` | `shared`: S:1618, 3387; `conditionStatus`: S:3399; `records.push`: S:3401 | S:1068–1070 (org redaction), 3404 | **split**: `shared` → `medical_shared`, `conditionStatus` → `medical_condition_status` (columns); `records[]` → facet until S5 (`player_medical_records`) |
| `location` | `{lat, lng}` or null | S:3414 (replaced whole) | `domain.mjs:117–118`; S:1088, 3634, 3659, 3799; `m12/shared.mjs:113`; `m13/suitability.mjs:133` | composite → `lat, lng` (presence in `__meta`) |
| `notificationPrefs` | `{quietStart, quietEnd, schoolHoursMute, timezone}` or null | S:3861 (`prefsHandler`, replaced whole) | S:744 (`pushDeferred`) | composite → `prefs_*` columns |
| `programme` | `{track, startedAt, completed[]}` or null | S:3577 (replaced), 3589 (`completed.push`) | `grassrootsJourney.mjs:71–80`; S:3585 | **split**: `track`, `startedAt` → columns; `completed[]` → facet until S5 |
| `media[]` | `{id, title, kind, uploadedAt, url, views, tags{}, verifiedClip, captions?, sizeBytes?}` | S:3377; `m12/operations.mjs:224`; in place: S:219–222, 277–278, 2324, 2339–2340; `m12/shared.mjs:33`; `m12/operations.mjs:254` | `domain.mjs:176`; S:2303, 3152, 3190, 4265; `m13/transitions.mjs:29` | facet until S5 (`player_media`, `player_media_tags`); media bytes stay on disk |
| `attendance[]` | `{id, fixture, venue, date, gps, deviceConfirmed?, verified, corroboratedBy?, trialId?}` | S:2853, 3463; `m12/journeys.mjs:698` | `domain.mjs:174`; S:2504, 3189, 3372; `m12/passport.mjs:95` | facet until S5 |
| `timeline[]` | `{year, event}` | S:3141, 3474; `m29/index.mjs:279–296` | S:3197 | facet until S5 |
| `badges[]` | string[] | S:956, 3338, 3339, 3347 | S:955, 3732 | facet until S5 |
| `trialReports[]` | full report copies incl. other clubs' `notes` | S:2571 | `domain.mjs:175`; S:3191 | facet until S5/S8 (a copy of `trials.report`) |
| `drills[]` | drill id strings | S:3535 | S:3521 | facet until S5 |
| `drillResults[]` | `{id, drillId, drillName, metric, unit, value, verified, ts}` | S:3537 | S:3522, 3601, 3723; `m12/passport.mjs:108` | facet until S5. **Defect found:** neither signup path creates it (seed only, `seed.mjs:514`), so S:3522/3537 would throw for a signed-up player; S4 imports an absent array as absent (not invalid) and the fix belongs to the route, not the migration |
| `activityLog[]` | ms timestamps | S:944–945 (`recordActivity`) | S:953, 1552–1555, 3118, 3716 | facet until S5 (player-private) |
| `externalIds[]` | `{provider, externalId, source, by, at, claim}` | `m13/imports.mjs:221–223` | `m13/imports.mjs:89, 309` | facet until S5 |
| `seasonHistory[]` | `[{season, …}]` | S:3494–3498 (`Object.assign` in place, sort in place) | S:3504 | facet until S5 |
| unknown fields | anything a later module added | — | — | facet (never dropped) |

### 2.3 Writers that must change in S4 (column-backed fields written in place today)

The record view refuses a column-backed assignment, nested values included (S3 correction 2),
so each of these becomes a repository call. Facet writers (media, attendance, timeline, badges,
trialReports, drills, drillResults, activityLog, externalIds, seasonHistory,
`programme.completed`, `medical.records`) stay as they are.

| Writer | Today | S4 |
|---|---|---|
| Academy+ toggle S:3337 | `req.player.academyPlus = …` | `players.update(id, { academyPlus })` |
| Availability S:1570, 2820, 3444; `m29/index.mjs:295` | `p.availability = …` | `players.update(id, { availability })` |
| Contract status S:2821, 3445; `m29/index.mjs:294` | `p.contractStatus = …` | `players.update(id, { contractStatus })` |
| Level `m29/index.mjs:278`; `m13/transitions.mjs:202` | `p.level = …` | `players.update(id, { level })` |
| First-team seeker S:3676, 3837 | assignment | `players.update(id, { firstTeamSeeker })` |
| Football category `m12/operations.mjs:280` | assignment | `players.update(id, { footballCategory })` |
| Password rehash on login S:1195 | assignment | `players.update(id, { password })` (as orgs do, S:1721 area) |
| Aging-up S:3140 | `p.guardianId = null` | `players.update(id, { guardianId: null })` **and** `guardians.unlink(gid, pid)` in one call (`players.ageUp`) |
| Medical consent S:1618, 3387; condition S:3399 | `medical.shared = …`, `medical.conditionStatus = …` (nested) | `players.update(id, { medical: { shared, conditionStatus } })`; `records` stays a facet, mutated in place |
| Location S:3414 | whole replacement | `players.update(id, { location })` |
| Stats S:3500 | whole replacement | `players.update(id, { stats })` |
| Notification prefs S:3861 (`prefsHandler`, shared with guardians) | whole replacement | `players.update(id, { notificationPrefs })` / `guardians.update(id, { notificationPrefs })` |
| Programme start S:3577 | whole replacement | `players.update(id, { programme: { track, startedAt } })`; `completed[]` facet |
| Signing rollback `m29/index.mjs:620` | `Object.assign(player, JSON.parse(snapshot))` restores the whole record | `players.restore(id, snapshot)`: columns through `update`, facets replaced; one call, documented as the only whole-record writer |
| Creation S:1144–1178, 1386–1418; `seed.mjs` | `db.players.push(...)` | `players.insert(fields)` (`seed.mjs` stays data; the first-installation initialisation imports it) |
| Deletion S:3978–4023 | `db.players = db.players.filter(...)` plus the cross-collection work | S4a: `players.remove(id)` performs exactly today's row removal (hard delete) and the route keeps the cross-collection work unchanged; S4b replaces it per O1 |

### 2.4 Copies of player data outside the record (survive S4 untouched)

`name` is copied onto `requests`, `trials`, `vouches`, `signings`, `squadInvites`, open-day
registrations, `orgs[].squad[].name`, `recruitmentCases`, `assessments`, `transitionCases`;
`deletePlayerData` nulls only some (S:3989–4003). Every collection carrying a `playerId` is
listed in `s4-deletion-decision.md` §4; none of them is touched by S4a.

## 3. Guardian fields: current readers and writers, proposed storage

Creation: signup S:1239–1247, co-guardian S:1580–1589 (no password, no `emailVerified`, no
`createdAt`), seed `seed.mjs:94, 104`.

| Field | Shape | Written after creation by | Read by (main) | S4 storage |
|---|---|---|---|---|
| `id` | `gd-N` | never | everywhere | column, PK |
| `name` | string | never | IDV S:1325, 1333; message sender S:1520; actors in m12/m23; `m21/permissions.mjs:185` | column |
| `email` | string **as typed** (no trim/lowercase) | never (no change route) | uniqueness S:1235; login S:1285 (case-sensitive); `m13/delivery.mjs:55`; `m23/contactRoutes.mjs:518–522`; `m14/organisations.mjs:763` | column; unique index on `lower(email)` (§5.3 before it can be created) |
| `password` | scrypt/null; **absent** on co-guardians | S:1297 (legacy upgrade) | S:1290–1297 | column `password_hash` |
| `emailVerified` | bool; absent on co-guardians (`undefined` passes the `=== false` checks S:1268, 1366) | S:1272 | S:1268, 1366 | column (absent → kept absent via `__meta`, read as today) |
| `emailCode` | 6 chars **plain**, no expiry, no attempt limit | S:1273 (→ null) | S:1253, 1260, 1269; also inside `outbox` text | **column `email_code_hash` (sha256), as the shadow stores it**; the compare at S:1269 becomes a hash compare; the plain code never reaches the table (S6 adds attempt limits) |
| `idVerified` | bool | S:1329; admin S:4234 | S:1369; `m23/contact.mjs:273` | column |
| `idvReference` | string | S:1330 | shadow only | column |
| `disclaimerAccepted` | bool (no timestamp) | S:1344 | S:1372; `m23/contact.mjs:273` | column (`disclaimer_accepted_at` stays NULL: no source) |
| `childIds` | string[] | S:1420 (push), 3137 (filter), 4018 (filter); co-guardian S:1585 copies the primary's list | every `/guardian/children/:id` gate, `guardianOwnsChild` (`m12/shared.mjs:77`, m15, m16, `m162/trust.mjs:30`), m13/m14/m21/m23/m28/m29 | **`guardian_children` rows**; the record view serves `childIds` as a read-only array derived from the table so every reader keeps working; the three writers become `guardians.link(gid, pid, role)` / `guardians.unlink(gid, pid)` |
| `coGuardianOf` | guardian id on the co record | never after creation | no runtime reader (shadow only) | column `co_guardian_of` (FK, SET NULL) |
| `coGuardians` | `[{id, name, email}]` on the primary, append-only | S:1589 | only through the `guardianView` spread and admin | facet (a duplicate of `co_guardian_of`; retired when the co-guardian path is redesigned, not in S4) |
| `notificationPrefs` | `{quietStart, quietEnd, schoolHoursMute, timezone}` | S:3861 | `pushDeferred` S:747 | composite → `prefs_*` columns |
| `removedAt` | **never written** | — | `m23/contact.mjs:273` | `deleted_at` exists in the DDL; set by nothing until O1/S4b |
| `createdAt` | **never written for guardians** | — | — | column, NULL for every existing row (import writes what exists; nothing is invented) |
| unknown fields | — | — | — | facet |

Separate collection, unchanged by S4: `db.notificationPrefs` rows keyed
`{audienceKind: 'guardian', audienceId}` (`m182/notificationPrefs.mjs:262`).

## 4. What moves during S4, and how nested data awaiting S5 remains intact

- **Moves to columns:** every field marked "column" or "composite" in §2–§3, plus the link
  table. `players.guardian_id` and `guardian_children` are both written, in one transaction,
  by every link change (`link`, `unlink`, `ageUp`, child creation), so the two can no longer
  drift (today three places write one side only, §5.2).
- **Stays nested, intact:** every array and sub-object marked "facet" travels in
  `facets_json` with the record's key order, explicit nulls and composite presence in `__meta`
  (the S3 mechanism, `repositories/orgs.mjs toRow/fromRow`), is served on the same record
  object the routes already hold, is mutated in place by its existing writers, and is flushed
  by the repository's save hook inside every snapshot save, counted as persisted only once
  that save committed (S3 correction 1). A record read back is byte-for-byte the record
  written: the S3 round-trip test is repeated for every player and guardian shape the seed and
  the signup paths produce (adult, guardian-created child with `city: ''`, co-guardian
  without password, `stats: null`, `location: null`, `notificationPrefs: null`, absent
  `drillResults`).
- **Split composites** (`medical`, `programme`) are the one new mechanism: the column-backed
  sub-keys (`shared`, `conditionStatus`; `track`, `startedAt`) are guarded like `location`,
  while `records` / `completed` remain mutable facets. The guard therefore works per sub-key
  for these two composites; the readiness test asserts that `medical.records.push(...)`
  succeeds and `medical.shared = true` throws.
- **Mirror columns:** none proposed for players/guardians (nothing derived needs one).
- **The S1 shadow** of the three tables is dropped by the migration (its rows are derived and
  replaceable) and recreated as the live definition with `facets_json` added; `CORE_SHADOW_TABLES`
  becomes empty and the shadow module is retired with its validation command (the readiness
  gate for S4 is the migration dry run, as for S2/S3).

## 5. Relationships, minors, duplicates, inconsistencies, invalid records

### 5.1 The relationship model as implemented

- "Primary guardian" means `players[].guardianId`. Channels (S:853), request routing
  (S:2121, 2740), notifications (about forty sites), media (S:4268), SSE (S:486) and the
  guardian thread list (S:1506) go to the primary only. Every `/guardian/children/:id` gate
  checks `childIds` only.
- "Co-guardian" means a guardian record created by `POST /guardian/coguardian`
  (S:1576–1591): created immediately, no invitation or acceptance, **no password and no route
  that ever sets one** (so it cannot log in unless dev logins are on, S:1290, 1298), a copy of
  the primary's `childIds` at that moment (children added later are never synced), and a
  `coGuardianOf` back-reference nothing reads. `resolveContactRecipient`
  (`m23/contact.mjs:263–280`) is the only place that reasons about several guardians: it
  counts guardians listing the child that are id-verified, disclaimer-accepted and not removed;
  with more than one it picks `player.guardianId`, otherwise fails closed.
- No end-to-end test calls `/guardian/coguardian`.

S4 keeps this model: `guardian_children.role` is `primary` where the row matches
`players.guardian_id`, `co` otherwise (the shadow's rule, `repositories/shadow.mjs:198`). It
does not redesign co-guardianship.

### 5.2 Inconsistent links (one side written without the other)

| Place | Writes | Not written |
|---|---|---|
| child creation S:1392 + 1420 | `p.guardianId`, creator's `childIds` | the creator's co-guardians' `childIds` |
| co-guardian creation S:1585–1589 | co `childIds` (snapshot), `coGuardianOf`, primary `coGuardians` | `players.guardianId` (correct: the co is not primary) |
| aging-up S:3135–3140 | primary's `childIds`, `p.guardianId = null` | co-guardians' `childIds` (the adult stays listed) |
| `deletePlayerData` S:4018 | every guardian's `childIds` | — |
| seed `seed.mjs:371–409` | both sides | — (but `pl-imani`, 18, is still in `gd-marek.childIds`) |

What the migration must therefore expect and **report, never repair**:

| Finding | Detection | S4 treatment |
|---|---|---|
| `players.guardianId` names a guardian that does not exist | id lookup | **refuses the cutover** (`CORE_IDENTITY_CUTOVER_BLOCKED`) with the player id: the column has a foreign key and nothing may be written as NULL silently |
| guardian `childIds` names a player that does not exist | id lookup | refuses the cutover with `guardian/child` |
| `coGuardianOf` names a missing guardian | id lookup | refuses the cutover |
| `players.guardianId = G` but `G.childIds` lacks the player ("primary without link") | set comparison | refuses the cutover: the two sides disagree and only the operator can say which is right |
| `G.childIds` lists a player whose `guardianId` is another guardian or null | set comparison | imported as `role = 'co'` (the shadow's existing rule); counted in the migration log |
| an adult (by `isAdult`) still linked to a guardian | age at migration time | imported unchanged (today's behaviour: aging-up is player-initiated, S:3132) and counted in the log; no policy is implied |
| a minor (by `isAdult`) with no guardian link at all | age + links | imported unchanged and counted (today nothing prevents it after aging-up of a mis-dated record); the plan's acceptance test "a minor cannot exist without a `guardian_children` row" is therefore **a rule for new writes**, not an import precondition |
| a co-guardian with no `password` and no `emailVerified` | field presence | imported as is (absent fields stay absent); the shape is legitimate today |

The dry run on a copy prints every finding with ids (never names or e-mails), exactly as the
S2/S3 cutovers do; the real directory is untouched.

### 5.3 Duplicate e-mails

- Signup enforces uniqueness case-insensitively (S:1235). The co-guardian path enforces nothing
  (S:1576–1590) and can duplicate any address, including the primary's own or a case variant.
  Login compares case-sensitively (S:1285) and, with duplicates, the first record in array order
  wins. `m14/organisations.mjs:757, 763` assumes guardian e-mails are verified and unique; false
  for co-guardians.
- The target has `UNIQUE INDEX guardians_email ON guardians (lower(email))`. The migration
  **refuses the cutover** when two guardians share `lower(email)`, listing the guardian ids,
  because choosing which record keeps the address is an identity decision (which one is the
  person who signs in?) that must be taken by a person on the pre-S4 build. The S1 strict
  validation (`node scripts/validateShadow.mjs <dir> --strict`) already reports this today, so
  the operator can see it before planning the upgrade.
- After the cutover the co-guardian route must check uniqueness the same way as signup (one
  shared predicate, `guardians.emailTaken(email)`), or be refused by the index with a clear
  error; S4a converts the route to the shared check so the index is a backstop, not the
  user-facing error.

### 5.4 Minor protections that S4 must preserve (and may not weaken)

All stay in code and are exercised by the existing suites; S4's views call them, never inline
them. `isAdult` (`domain.mjs:76–79`: unknown age is **not** adult; threshold `ADULT_AGE` by
country, default 18, KR 19, TH 20, EG 21, SG 21). `visibleToOrg` (`domain.mjs:110–121`):
agencies never see a minor, unverified clubs never see a minor, grassroots clubs see only
non-pro players within 50 km and fail closed without a location. Signup refuses a minor
(S:1137–1143); child creation requires a minor (S:1383) and an e-mail-verified, id-verified,
disclaimer-accepted guardian (S:1366–1374). Minor inbox and messaging (S:3206–3230, 3233,
3284, 3289, 3304, 3314; SSE S:464–465). Medical (S:3386 / 1615), availability (S:3429 / 1564),
Academy+ (S:3336), first-team seeker (S:3675 / 3833), vouches (S:3741 / 3843), open days
(S:3655 / 3814–3822). Trial check-in consent (`m12/journeys.mjs:674–678, 726, 731–734`).
Offers (`m28/index.mjs:443–445`, 792). Signing (`m29/index.mjs:332, 337`; `m29/signing.mjs:50–53,
159`). Agents (`m24/index.mjs:717, 725, 798`; `m25/index.mjs:799, 803`; `m25/policy.mjs:340–380`;
`m26/index.mjs:444, 1247`; `m27/*`). School-hours mute (S:745, 752); no external e-mail for
minors (`m13/delivery.mjs:43–47`). Development plans (`m21/permissions.mjs:91–128`).

Gaps found (recorded, not fixed by S4): the core `/guardian/*` routes never re-check that the
child is still a minor; `GET /player/export` (S:4025) has no minor check and `exportPlayer`
(S:3879) includes guardian–club threads a minor cannot otherwise see; request routing (S:2120–2129,
2740) sends to a null `guardianId` without a verification check; pairing codes (S:3760–3778) can
be minted by any guardian listing the child and `/auth/player/pair` has no rate limit.

### 5.5 Invalid records

The migration validates every record **without coercion** and refuses the cutover on the
first problem (listing all), as S2/S3 do. Unsupported: a player without a string `id`/`name`,
a `dob` that `parseStrictDateOnly` rejects (`temporal.mjs:91`), a missing `country`,
`position`/`foot`/`level`/`availability`/`contractStatus` outside their CHECK lists, a
non-boolean flag, a non-object `stats`/`medical`/`location`/`notificationPrefs`/`programme`
where present, `location` with one of `lat`/`lng`, a guardian without `id`/`name`/`email`, a
`childIds` that is not an array of strings, a reserved `__meta` key. **Absent is not invalid**
(`drillResults`, `createdAt` on guardians, `password` on co-guardians). The shadow's current
coercions (`text(p.position) || null`, `?? 'not_seeking'`, `?? 'unknown'`, `?? 'amateur'`,
`repositories/shadow.mjs:106–117`) are **not** carried into the live import: a value the CHECK
would refuse is a finding for the operator, because an invented default would change what a
club sees about a person.

## 6. The exact fields each audience may receive

Today `playerViewForOrg` (S:1052–1096) **spreads the stored record** and removes a short list,
so clubs and agencies also receive fields nobody decided to give them: other clubs' trial
reports with notes, attendance GPS, notification preferences and timezone, external ids with
import claims, caption text, `createdAt`, `drills`, `drillResults`, `seasonHistory`, `badges`,
`timeline`, `level`, `identityVerified`, `squadNumber` (schema §11 item 3). S4 builds every
outward view from the allowlists below. Rows: field names as served today (the shape is
unchanged for every field that stays). "Rule" cites the existing check the view calls.

### 6.1 Clubs (verified pro/academy; grassroots) — `playerViewForOrg` replacement

| Field | Served | Rule / note |
|---|---|---|
| `id`, `name`, `position`, `foot`, `heightCm`, `weightKg`, `country`, `level`, `availability`, `contractStatus`, `identityVerified`, `academyPlus`, `footballCategory` | yes | as today |
| `city` | yes for adults, `''` for minors | S:1078 |
| `age` | derived from `birth_date` at read | S:1059; `dob` itself never (S:1072) |
| `squadNumber`, `contractUntil`, `marketValueRange`, `agentName` | pro/academy yes; grassroots no | S:1084–1087 |
| `firstTeamSeeker`, `distanceKm` | grassroots only | S:1088–1089 |
| `stats`, `seasonHistory`, `badges`, `timeline`, `media[]` (`id, title, kind, uploadedAt, url, views, tags, verifiedClip`; **not** `captions`, `sizeBytes`), `attendance[]` (`id, fixture, venue, date, verified, corroboratedBy`; **not** `gps`, `deviceConfirmed`, `trialId`), `drills` | yes | football data the club directory exists to show; GPS and device data are the leak the plan closes |
| `trialReports[]` | **only the viewing org's own reports** | today every club sees every other club's notes (S:1052 spread); `trials.report` is the authoritative copy |
| `medical` | `{ shared: false }` unless `shared`, then `{ shared, conditionStatus, records }` | S:1068–1070 |
| `profileSignal`, `trustScore`, `guardianManaged`, `contactPolicy` (`guardian_only` for minors), `vouches` (non-pro), `orgNotes` (own org, `/org/players/:id` only), `similarPlayers` | yes | derived, as today |
| `guardianId`, `dob`, `password`, `location`, `programme`, `activityLog`, `notificationPrefs`, `externalIds`, `drillResults`, `createdAt` | **never** | the first six as today; the last four are the closed leaks |

Visibility: the view is built only after `visibleToOrg(player, org)` and the existing
block/report checks pass, exactly where they run today; the list above is what passes through
afterwards.

### 6.2 Agencies

Agencies reach players through `visibleToOrg` (never a minor) and the m24 relationship model.
`clientIdentity` (`m24/index.mjs:150`) serves the full club view (§6.1) when the relationship
grants access, otherwise `{id, name, position, age, club, country}`; `/org/agent/players`
(`m24/index.mjs:481`) serves adults only as `{id, name, position, age, club, country}`.
S4 keeps both lists exactly and makes the minimal one a named allowlist (`AGENT_SUMMARY`).

### 6.3 Guardians (of their own children)

`GET /guardian/children` (S:1360) serves the whole record minus `password` plus `age`,
`trustScore`, `trust`; `POST /guardian/children` (S:1423) returns the raw record including
`password: null`. S4 allowlist: every field of §2 except `password` (and `password_hash`), plus
the three derived values; the creation response uses the same list. Guardians' own view of
themselves (`guardianView`, S:1348–1351) strips `password` and `emailCode` and spreads the
rest, including `coGuardians[].email` and `idvReference`; S4 names the list: `id, name, email,
emailVerified, idVerified, disclaimerAccepted, childIds, coGuardianOf, coGuardians,
notificationPrefs` — and never `password`, `emailCode` (which no longer exists in plain form)
or `idvReference` (a provider reference, not the guardian's data to display; flagged for the
Founder as a change if any client shows it).

### 6.4 Players (themselves)

`GET /player/me` (S:3109): the whole record minus `password` plus `age`, `trustScore`,
`trust`, `tier`, `streak`, `weeklyGoal`, `nextActions`, `agingUp`, `pathway`, `programme`
progress, `vouches`. S4 allowlist: every field of §2 except `password`, plus those derived
values (unchanged). `exportPlayer` (S:3879) likewise minus `password`; the included guardian
threads are a recorded gap (§5.4), unchanged by S4.

### 6.5 Administrators / Trust & Safety

There is no admin list of players (T&S touches players by id: `m13/transitions.mjs:195`,
`m15/passport.mjs:544`, `m162/trust.mjs:264`). `/admin/guardians` (S:4227–4229) and
`/admin/guardians/:id/idv` (S:4238) return **raw rows including the password hash and the
plain e-mail code** (schema §11 item 4). S4 allowlist for both: `id, name, email,
emailVerified, idVerified, idvReference, disclaimerAccepted, childIds, coGuardianOf,
createdAt` plus the `idvQueue` rows as today — never `password_hash`, never `email_code_hash`.

### 6.6 Other surfaces that carry a guardian id to orgs today (recorded, unchanged by S4)

Raw `/org/requests` (S:2513–2515) includes `guardianId`; raw `/org/trials` (S:2517–2519)
includes `recipient.guardianId`, `history[].by`, `schedule.confirmedBy`, `day.consents[].by`;
open-day registrations spread `guardianId` (S:2682–2688); squad invites expose
`guardianApproved.guardianId` (`m14/organisations.mjs:770`); message senders carry the
guardian's id and name (S:1520). These are recruitment/messaging payloads (S6–S8), listed so
the S4 allowlists are not mistaken for a complete audit of guardian-id exposure.

## 7. Migration, restart, authority, sessions, failed saves

- **Migration `0005_core_identity_live`** (`foreignKeysOff = true`), inside the runner's one
  transaction: read the `guardians` and `players` blobs from `collections` (JSON and array
  checks); validate every record (§5.5) and every link (§5.2, §5.3) — abort with
  `CORE_IDENTITY_CUTOVER_BLOCKED` listing ids and reasons, file byte-identical, same abort on
  the next boot, no repair, no demo data; `DROP TABLE guardian_children, players, guardians`
  (the S1 shadow: derived rows) and create the live definitions (`01_identity.sql` + a
  `facets_json TEXT CHECK (json_valid)` column on `players` and `guardians`); insert guardians
  (two passes for `co_guardian_of`, as the shadow does), then players, then one
  `guardian_children` row per `childIds` entry with the role rule; `PRAGMA foreign_key_check`
  must be empty; write `meta.coreIdentityCutover` (`at, guardians, players, links, findings`
  counts) and `meta.coreIdentityInit` (`done` when a blob or any saved snapshot existed,
  `pending` only for a database nothing was ever saved to); delete the two blobs. Completion is
  decided **only** by the `data_migrations` row. The staff and organisation tables and the
  `sessions` table are not touched by any statement.
- **Boot order.** `attachDataLayer` initialises or attaches `guardians` before `players`
  (the FK), both before `users`; `db.guardians` and `db.players` become read-only views
  (array methods that mutate throw and name the repository). The integrity report already runs
  after the data layer attaches (S3), so `ROOM_ORPHAN_PLAYER` / `PLAYER_ID_DUPLICATE`
  (`m182/integrity.mjs:48, 64`) keep seeing the players. `m182_002_collections_present`
  (`db.players ??= []`) runs before and creates an empty placeholder that `attach()` ignores
  (S3 correction 3); no other `m182` step reads players or guardians
  (`m182/migrations.mjs` grep). `loadSnapshot` still needs a `players` array to treat the file
  as a snapshot (S:129–135): in server mode `store.load()` does not read table-backed
  collections, so **S4 must make `store.load()` report that a players table-backed snapshot
  exists** (a `tables` marker in the loaded envelope, or the server checking the cutover
  record) or every boot after the cutover would run from the seed. This is the one boot-path
  change S4 carries beyond the S3 pattern and the first regression test to write.
- **Restart / retry.** A failed cutover rolls back and the next boot cuts over cleanly (tested
  with an injected failure after the inserts). An interrupted first-installation initialisation
  leaves `pending` and is retried. A cut-over database with empty tables is authoritative:
  `attach()` imports nothing; a stale `players`/`guardians` blob written back into
  `collections` is ignored and deleted by the next save (the S3 tests, repeated).
- **Sessions.** Player and guardian sessions carry `kind` and `ref_id` without a foreign key;
  the migration never writes `sessions`; every existing bearer token and `sid` stays valid
  (asserted by hash and count, as in S3). Aging-up and child deletion keep revoking exactly as
  today (`sessions.revokeFor('player', id)`, S:3983).
- **Failed saves.** Facet changes are tracked as pending until the store reports the commit,
  flushed again after a rollback (S3 correction 1); the same save hook object serves the three
  repositories. Column writes commit on their own; `insert`/`update` refuse to run inside an
  open transaction. The debounce window (2 s) for facets is unchanged and documented.
- **Runtime.** The S3 runtime contract (`runtime.mjs`, Node 22.16+/24.0+) covers S4 with no
  change.

## 8. Rollback design

`node scripts/coreIdentityRollback.mjs <data-dir> <out-dir>` on a copy (server stopped; the
source is never modified; refuses a later schema with exit 4, a never-cut-over file with exit 5,
a non-empty output directory with exit 1), mirroring `orgsRollback.mjs`:

1. Rebuild the `players` blob from the table: columns and facets merged through `fromRow`
   (`__meta` applied), `guardianId` from the column.
2. Rebuild the `guardians` blob: columns and facets merged; `childIds` from
   `guardian_children` for that guardian (primary and co rows, in `rowid` order); `coGuardians`
   from the facet.
3. Recreate the S1 shadow definitions of the three tables, empty (the pre-S4 build fills them
   only when validation is on).
4. Leave `sessions`, `org_users`, `orgs` untouched (nobody signs in again; no revoked session
   returns); delete the `0005_core_identity_live` record, `meta.coreIdentityCutover` and
   `meta.coreIdentityInit`; advance `meta.saveSeq`; `foreign_key_check`; VACUUM.
5. Verify against the real pre-S4 build (worktree at the S3 commit) with synthetic data, as
   S2 and S3 were.

**What is preserved:** every player and guardian created or changed after the cutover, every
facet change, every link change — because every column and facet has a pre-S4 representation.

**Unavoidable loss or transformation, stated plainly:**

| Post-S4 state | Pre-S4 representation | Loss |
|---|---|---|
| S4a only (no deletion change) | complete | **none** |
| S4b tombstones (if O1 chooses a tombstone) | the pre-S4 build has no tombstone: a row with `deleted_at` would be served as a live player with the placeholder name | the tool **omits** tombstoned players from the blob (the pre-S4 build hard-deletes; audit rows keep dangling ids as they do today). The erased personal data cannot be restored by any rollback — the deletion is honoured either way. The count of omitted tombstones is printed. |
| S4b guardian deletion (if added) | none | same treatment as above |
| a `childIds` order the pre-S4 build produced by `push` | `rowid` order of the link rows | order may differ; no reader depends on it (verified by grep: 34 `includes`, 2 `filter`, 2 `map`, 2 `length`; the one index access, S:1630 `childIds[0]`, runs only when the list has exactly one entry) |
| `email_code_hash` | the pre-S4 build compares the plain code (S:1269) | a guardian who had an outstanding, unverified code at rollback time cannot verify with it on the pre-S4 build and must request a new one — **there is no resend route today** (§5.3), so this is a real, bounded loss the rollback report must print (ids only). It is avoidable only by keeping the plain code, which S4 refuses to do. |

**Restoring a pre-S4 backup is not a rollback:** it discards every write since the backup across
every collection (the S2/S3 argument). The tool above is the rollback.

## 9. Bounded implementation sequence and acceptance tests

**S4a — cutover, repositories, allowlists (one commit).** No deletion-policy change: the
delete routes call `players.remove(id)` (today's hard delete of the row) and keep the
cross-collection work unchanged. Files: `repositories/guardians.mjs`, `repositories/players.mjs`
(new, S3 shape: validation without coercion, `toRow/fromRow` with `__meta`, guarded
composites incl. the two split composites, `insert/update/link/unlink/ageUp/restore/remove`,
`flush/commit/rollback/saveHook`, `initState/initialize/attach`, `GUARDIANS_TABLE`/`PLAYERS_TABLE`
for snapshot tools with `replace`+`prune` and the FK-aware prune order: links, players,
guardians), `repositories/migrations/0005_core_identity_live.mjs`, `repositories/index.mjs`
(`TABLES` order and prune order, boot order, report `domains.players/guardians`),
`repositories/shadow.mjs` (retired) + `scripts/validateShadow.mjs` (retired or reduced to a
dry-run wrapper), `store.mjs` (snapshot-presence marker, §7), `server.mjs` (the writers of
§2.3; `childIds` writers; `playerViewForOrg` → `views/playerViews.mjs` allowlists; `/admin/guardians`;
`guardianView`; the co-guardian uniqueness check), `m12/operations.mjs:280`, `m13/transitions.mjs:202`,
`m29/index.mjs:278, 294–295, 620`, `seed.mjs` unchanged (data), `scripts/coreIdentityRollback.mjs`
+ `repositories/coreIdentityRollback.mjs`, `scripts/testPlayers.mjs`, `scripts/testGuardians.mjs`,
suite fixture updates, `01_identity.sql` (facets columns, lifecycle headers unchanged),
`sqlite-schema.md` §5.0/§5.1, plan §S4, `OPERATIONS.md`, `CLAUDE.md`.

Acceptance (each a test that fails first on the S3 code where applicable):

1. Round trip: every seed and signup shape of player and guardian is byte-identical through
   `toRow/fromRow`, including absent `drillResults`, co-guardians without `password`,
   `stats: null`, `location: null`, unknown fields.
2. Validation: every unsupported shape of §5.5 refused with a reason; nothing coerced; the
   shadow's defaults are not applied.
3. Cutover: an S3 file cuts over with every field, every link (roles per §5.1), the three
   tables live, `foreign_key_check` empty, both blobs retired, `coreIdentityInit = done`,
   sessions byte-identical by hash; the staff and organisation tables untouched.
4. Abort cases: missing guardian reference, missing child, dangling `coGuardianOf`, duplicate
   `lower(email)`, primary-without-link disagreement, a `dob` the parser rejects → the file is
   byte-identical, the same abort on restart, the repaired file cuts over; an injected failure
   before commit leaves no trace.
5. Counted-not-refused findings: `co` roles, adults still linked, minors without a link → cut
   over, counts in `meta.coreIdentityCutover`, no row changed.
6. Boot: a cut-over file boots as a snapshot (never from the seed) with no `players` blob; the
   integrity report sees the players; a first installation initialises once from the seed;
   interrupted initialisation retries; empty authoritative tables ignore stale arrays and blobs.
7. Writers: every converted writer of §2.3 persists immediately and survives a restart; every
   facet writer still works in place and persists on the next save; a failed save followed by a
   successful one loses nothing (three records, failure after flush / inside flush / at COMMIT).
8. Guards: assigning any column-backed field on a player or guardian view throws, nested values
   of `location`, `stats`, `notificationPrefs`, `medical.shared`, `medical.conditionStatus`,
   `programme.track` included; `medical.records.push` and `programme.completed.push` succeed;
   `db.players.push`, `db.guardians[0] = …` throw; `childIds.push` throws (derived).
9. Links: `link`/`unlink`/`ageUp` write both sides in one transaction; `guardian_id` always
   equals the `primary` row; a second `primary` for one player is refused; the co-guardian route
   refuses a duplicate e-mail with the signup's error before the index does.
10. Views: for each audience of §6 the served keys equal the allowlist exactly (a table-driven
    test over seed players: adult, minor, pro, grassroots viewer, agency viewer, unverified
    club, blocked org); `visibleToOrg` and the block/report checks are called, not reimplemented;
    `dob`, `password`, `guardianId`, GPS, prefs, external ids, other clubs' notes never appear in
    an org view; `/admin/guardians` carries neither hash; the medical join follows `shared`.
11. Snapshot tools: export/import and `POST /admin/backup` → restore keep every player,
    guardian, link and session; a snapshot that lists a child for a guardian it no longer
    contains is rejected as a whole; prune order links → players → guardians.
12. Rollback: the tool's copy boots on the real S3 build with every post-S4 player, guardian and
    link; the S4 build re-upgrades it; later schema refused with exit 4, never-cut-over with 5,
    no output either time.
13. Battery: unchanged suites (apiE2E, connectedE2E, m12*, m13*, m15*, m18*, m21*, m23*, m29*)
    green apart from the two baseline `m182E2E` client checks; `m23BootContract` green.

**S4b — deletion and guardian lifecycle (one commit, only after O1 is answered).** Implements
whatever O1 decides for the player tombstone (`players.erase(id)`: `deleted_at`, the retained
columns per the decision, every other personal column nulled, the name replaced, owned facets
cleared, name snapshots on retained rows replaced in the same transaction, media files deleted
as today), the per-table lifecycle statements, and — if the Founder wants it — a guardian
deletion route limited to guardians with no non-deleted child. Acceptance: the tombstone row
remains, every retained row still references it, every owned facet and file is gone, a deleted
player cannot sign in or be paired, the integrity report shows no orphan, the rollback tool omits
tombstones and prints their count. Until then `removedAt`/`deletedAt` remain never-written and
the three checks that read them (§2.1) remain dead.

## 10. Implemented versus proposed

| Table | State at `d4ca3f2` | After S4a |
|---|---|---|
| `org_users`, `sessions`, `orgs` | live (S0, S2, S3) | unchanged |
| `guardians`, `players`, `guardian_children` | shadow (S1; filled only with `SCOUTBOX_SHADOW_VALIDATION=1`; nothing reads them) | **live**, with `facets_json` on `players` and `guardians` |
| `players.deleted_at`, `guardians.deleted_at` | columns in the DDL, written by nothing | columns exist, **still written by nothing** (S4b) |
| twelve `player_*` sub-record tables | proposed DDL, no migration | unchanged (S5); their data rides in `facets_json` |
| file 02 (recruitment, 55 tables) | proposed; `player_id` without FK pending O1/S8a | unchanged |
| everything else (files 03–08) | proposed | unchanged |

## 11. Open points this review does not decide

- **O1** (what the tombstone keeps) — `s4-deletion-decision.md`; S4b waits for it.
- Whether `idvReference` should keep appearing in the guardian's own view (§6.3); whether the
  closed org-view leaks (§6.1) need a client change (the clients do not render GPS, prefs or
  external ids per the M24 privacy suites, but the Founder should confirm before the fields
  disappear from the payload).
- The co-guardian design (no login path, no invitation, no sync of later children, no
  removal) is reproduced faithfully; redesigning it is a product decision outside S4.
- The `drillResults` signup defect (§2.2) and the export/minor gap (§5.4) are route defects to
  fix in their own change, not in the migration.
- The runtime metadata alignment recorded in the plan (§S3 "Runtime contract": `engines.node
  >=22.16.0` admits Node 23, which the documented contract neither supports nor refuses by
  version) is independent of S4.
