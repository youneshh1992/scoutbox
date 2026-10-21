# S4 readiness review: guardians, players and the guardian–child link

Companion to [`sqlite-migration-plan.md`](./sqlite-migration-plan.md) (§S4) and
[`sqlite-schema.md`](./sqlite-schema.md) (§5.1, §9, §10). Written 11 October 2026 on branch
`feat/sqlite-schema` at commit `d4ca3f2` (S3 done and reviewed) and corrected after review at
`0c038ef`, by reading the code as it is today. Every claim carries a file and line (`S:` is
`scoutbox-server/server.mjs`; other paths are relative to `scoutbox-server/`). Line numbers
are from this commit; `01_identity.sql` and the plan cite lines that have drifted by a few
places. "Verified" means run on synthetic data (the script is named); everything else is read
from the code or is a design proposal, and design risks are called design risks.

**Status (updated after the S4a integration commit `9656a4b` and the corrections of its
independent review): S4a is implemented; its review acceptance is pending the reviewer's
re-check** — the migration is registered, the repositories are attached at boot, the writers are
converted, the operations of §7.4 AND every route that couples a column with a facet, a blob, an
audit entry or another domain run in units of work (the review reproduced one that did not; §9
item 7), the §6 allowlists are the responses, the media-deletion queue exists and travels with
backups (the review reproduced a backup that lost it; §9 item 14), the whole-domain snapshot
replacement is order-independent (the review reproduced a valid replacement refused; §9 item 12),
the queue can never delete a file a live player still references (the review of `4ef9345`
reproduced a restored queue entry deleting a live clip; §9 item 14) and the rollback tool covers
the final schema; §9 lists every acceptance item with where it is proven. The three findings of
the `9656a4b` review are accepted; S4a is review-accepted at `480afdb`. The sections below keep
the review's evidence and proposals as written; status notes mark what the implementation
settled. Nothing here changes the UI or the deletion policy (O1 **partially resolved** on
12 October 2026 — full birth date chosen, country code and child-status stamp open,
[`s4-deletion-decision.md`](./s4-deletion-decision.md) §10; S4b not implemented). Registration
in source is development work, not authorization for a real-data cutover: the operator procedure
is in `OPERATIONS.md`.

**One dependency statement.** S4 is two bounded steps. **S4a** (storage cutover, repositories,
allowlisted views, rollback tool) does **not** depend on the deletion decision O1: it keeps
today's deletion behaviour unchanged behind a repository method and takes no deletion-policy
decision implicitly. **S4b** (tombstone, erasure, guardian lifecycle) depends on O1
([`s4-deletion-decision.md`](./s4-deletion-decision.md)) and does not start until the Founder
has answered. Earlier wording that "S4 does not start until O1 is answered" is withdrawn; §9
lists what each step may proceed with. *Status, 12 October 2026:* S4a is done and accepted;
the Founder has answered the birth-date part of O1 (full birth date) and kept the country-code
and child-status-stamp parts open; the decision record's §10 lists which S4b design items still
wait on those. S4b-R — the retained player record, narrowed as plan §D.6.1 says — is implemented since
21 October 2026 and awaits independent acceptance (§12); the guardian lifecycle is not built.

Sections: 1 what S4 is and is not · 2 player fields · 3 guardian fields · 4 what moves, what
stays nested · 5 relationships, minors, duplicates, inconsistencies, invalid records · 6 views
per audience (explicit allowlists, reconciled against the code) · 7 migration, boot, authority,
sessions, failed saves, **transaction boundaries** · 8 rollback · 9 implementation sequence and
acceptance tests · 10 implemented versus proposed · 11 open points and the decisions still needed.

---

## 1. What S4 is, and is not

- **Is:** `guardians`, `players` and `guardian_children` become live tables owned by
  `repositories/guardians.mjs` and `repositories/players.mjs` (new), created by migration
  `0005_core_identity_live`, following the S3 pattern: scalar and composite fields in columns,
  every nested structure that waits for a later step in a transitional `facets_json` column on
  the same row (byte-for-byte shape preservation through `__meta`), writers of column-backed
  fields converted to repository calls, in-place facet writers left alone, committed-only change
  tracking through the store's save hook, explicit initialisation state, `attach()` that never
  imports, a rollback tool on a copy. The S1 shadow of these three tables is retired. Reads that
  scan `db.players` keep working through the read-only view; the outward views are rebuilt from
  **explicit allowlists** reconciled field by field against today's responses (§6), with every
  access rule left in `domain.mjs` and the routes.
- **Is not:** the twelve `player_*` sub-record tables (S5), recruitment (S8), any change to who
  may see what beyond the intentional privacy fixes named in §6, any deletion-policy change
  (S4a keeps today's hard delete; S4b implements O1), a guardian deletion route (S4b, after O1),
  the hashing of the guardian e-mail code (S6, see §8.2), the UI.

## 2. Player fields: current readers and writers, proposed storage

Creation points: seed (`seed.mjs` `player()` 496–522, records 115–421 and 446–462), adult
signup (S:1144–1178), guardian-created child (S:1386–1418), boot defaults (S:217–226,
241–244; `m12/shared.mjs:33`; `m13/shared.mjs:47`). The shadow's column mapping
(`repositories/shadow.mjs:103–118`) already covers every scalar below. "Column" means a column
of the live `players` table; "facet" means the transitional `facets_json` on the same row.

### 2.1 Scalars

| Field | Shape | Written after creation by | Read by (main) | S4 storage |
|---|---|---|---|---|
| `id` | `pl-N` | never | everywhere | column, primary key |
| `name` | string | never (no profile-edit route) | search S:1900; copied into many collections (§2.4) | column |
| `dob` | `YYYY-MM-DD`, **declared** at signup or by the guardian, never verified (`identityVerified` is seed-only) | never | `domain.mjs:77`; S:1059, 3114, 3184; `m12/shared.mjs:101`; `m15/passport.mjs:191`; `m16/combine.mjs:48`; `m13/insight.mjs:96`; `m13/imports.mjs:95` | column `birth_date` (NOT NULL, 10 chars) |
| `country` | ISO‑2 | never | `domain.mjs:78` (age of majority); S:1906, 3184 | column |
| `city` | string, `''` for guardian-created children | never (blanked only inside the minor org view, S:1078) | S:1900; `m15/passport.mjs:211` | column |
| `position` | enum or null | never | `domain.mjs:177, 337`; S:1903, 3569, 3648; `m12/scouting.mjs:713` | column (CHECK) |
| `foot` | `left`/`right`/null | never | `domain.mjs:177, 339`; S:2397 | column (CHECK) |
| `heightCm`, `weightKg` | number/null | never | `domain.mjs:177, 344–345`; S:3185 | columns |
| `squadNumber`, `contractUntil`, `marketValueRange`, `agentName` | scalar/null | never | only the org-view spread (removed for grassroots orgs S:1084–1087) | columns |
| `academyPlus` | bool | S:3337 | S:1905, 1933, 2309 | column |
| `availability` | enum | S:1570 (guardian), 2820 (squad release), 3444; `m29/index.mjs:295` | S:1904, 2394; `m12/scouting.mjs:723` | column (CHECK) |
| `contractStatus` | enum | S:2821, 3445; `m29/index.mjs:294` | S:3441; `m29/signing.mjs:356` | column (CHECK) |
| `identityVerified` | bool | never (seed only) | `domain.mjs:173`; S:3185; `m15/passport.mjs:184`; `m162/trust.mjs:53` | column |
| `guardianId` | id/null | S:3140 (aging-up → null) | S:1055 (removed from org view), 3122, 3134, 2579, 2740, 4268; `m23/contact.mjs:276` | column `guardian_id` (FK → guardians, SET NULL); must equal the `role='primary'` link (§5) |
| `createdAt` | ms | never | S:1913, 2356 | column |
| `password` | scrypt string/null | S:1195 (rehash on login) | S:1192–1193; removed from every outward view | column `password_hash` |
| `level` | enum | `m29/index.mjs:278` (signing); `m13/transitions.mjs:202` (admin review) | `domain.mjs:116`; S:952, 1092, 3556, 3836; `grassrootsJourney.mjs:90,125,142`; `m12/shared.mjs:104` | column (CHECK) |
| `firstTeamSeeker` | bool (boot default S:242) | S:3676, 3837 | S:1089, 1925 | column |
| `footballCategory` | enum/null, lazily set | `m12/operations.mjs:280` | `m12/scouting.mjs:734`; `m12/shared.mjs:109` | column |
| `deletedAt`, `removedAt` | **never written** | — | read at `m23/contact.mjs:251`, `m27/index.mjs:183, 597` (dead checks today) | `deleted_at` exists in the DDL; **written by nothing until O1 is decided (S4b)** |

### 2.2 Nested objects and arrays

| Field | Shape | Written by | Read by (main) | S4 storage |
|---|---|---|---|---|
| `stats` | `{appearances, goals, assists, paceKmh, passCompletionPct, duelSuccessPct, cleanSheets?}` or null | S:3500 (replaced whole) | `domain.mjs:177, 362`; S:3188, 3617; `m12/scouting.mjs:727` | composite → `stats_*` columns (null object → all NULL, presence in `__meta`) |
| `medical` | `{shared, records[], conditionStatus}` | `shared`: S:1618, 3387; `conditionStatus`: S:3399; `records.push`: S:3401 | S:1068–1070 (org redaction), 3404 | **split**: `shared` → `medical_shared`, `conditionStatus` → `medical_condition_status`; `records[]` → facet until S5 |
| `location` | `{lat, lng}` or null | S:3414 (replaced whole) | `domain.mjs:117–118`; S:1088, 3634, 3659, 3799; `m12/shared.mjs:113`; `m13/suitability.mjs:133` | composite → `lat, lng` |
| `notificationPrefs` | `{quietStart, quietEnd, schoolHoursMute, timezone}` or null | S:3861 (`prefsHandler`, replaced whole) | S:744 | composite → `prefs_*` columns |
| `programme` | `{track, startedAt, completed[]}` or null | S:3577 (replaced), 3589 (`completed.push`) | `grassrootsJourney.mjs:71–80`; S:3585 | **split**: `track`, `startedAt` → columns; `completed[]` → facet |
| `media[]` | `{id, title, kind, uploadedAt, url, views, tags{}, verifiedClip, captions?, sizeBytes?}` | S:3377; `m12/operations.mjs:224`; in place S:219–222, 277–278, 2324, 2339–2340; `m12/shared.mjs:33`; `m12/operations.mjs:254` | `domain.mjs:176`; S:2303, 3152, 3190, 4265 | facet until S5 |
| `attendance[]` | `{id, fixture, venue, date, gps, deviceConfirmed?, verified, corroboratedBy?, trialId?}` | S:2853, 3463; `m12/journeys.mjs:698` | `domain.mjs:174`; S:2504, 3189, 3372; `m12/passport.mjs:95` | facet until S5 |
| `timeline[]` | `{year, event}` | S:3141, 3474; `m29/index.mjs:279–296` | S:3197 | facet until S5 |
| `badges[]` | string[] | S:956, 3338, 3339, 3347 | S:955, 3732 | facet until S5 |
| `trialReports[]` | full report copies incl. other clubs' `notes` | S:2571 | `domain.mjs:175`; S:3191 | facet until S5/S8 |
| `drills[]` | drill id strings | S:3535 | S:3521 | facet until S5 |
| `drillResults[]` | `{id, drillId, drillName, metric, unit, value, verified, ts}` | S:3537 | S:3522, 3601, 3723; `m12/passport.mjs:108` | facet until S5. **Defect (read, not reproduced):** neither signup path creates it (seed only, `seed.mjs:514`), so S:3522/3537 would throw for a signed-up player; the import treats an absent array as absent, and the fix belongs to the route |
| `activityLog[]` | ms timestamps | S:944–945 | S:953, 1552–1555, 3118, 3716 | facet until S5 (player-private) |
| `externalIds[]` | `{provider, externalId, source, by, at, claim}` | `m13/imports.mjs:221–223` | `m13/imports.mjs:89, 309` | facet until S5 |
| `seasonHistory[]` | `[{season, …}]` | S:3494–3498 (in place) | S:3504 | facet until S5 |
| unknown fields | — | — | — | facet (never dropped) |

### 2.3 Writers that must change in S4a (column-backed fields written in place today)

The record view refuses a column-backed assignment, nested values included (S3 correction 2),
so each becomes a repository call. Facet writers stay as they are. Operations that also change
other collections are marked **(UoW)** and run inside a unit of work (§7.4).

**Status: done.** Every row of the table below is converted as its last column says (the
signing completion uses `players.update` for level, contract status and availability inside the
unit, and the unit's rollback replaces the hand-written restore, so `players.restore` is not
called by m29); the survey was repeated on the final tree (no direct assignment of a column-backed
player or guardian field, no `childIds` mutation, outside the repositories).
`scripts/testCoreIdentityServer.mjs` exercises the converted writers through their real routes and
after a restart; `m15/passport.mjs` writes passport preference records, not the player, and was
not changed.

| Writer | Today | S4a |
|---|---|---|
| Academy+ S:3337 | assignment | `players.update(id, { academyPlus })` |
| Availability S:1570, 2820, 3444; `m29/index.mjs:295` | assignment | `players.update(id, { availability })` (`m29` inside the signing UoW) |
| Contract status S:2821, 3445; `m29/index.mjs:294` | assignment | `players.update(id, { contractStatus })` (`m29` inside the signing UoW) |
| Level `m29/index.mjs:278`; `m13/transitions.mjs:202` | assignment | `players.update(id, { level })` |
| First-team seeker S:3676, 3837 | assignment | `players.update(id, { firstTeamSeeker })` |
| Football category `m12/operations.mjs:280` | assignment | `players.update(id, { footballCategory })` |
| Password rehash S:1195 | assignment | `players.update(id, { password })` |
| Aging-up S:3135–3141 **(UoW)** | `guardian.childIds.filter`, `p.guardianId = null`, `timeline.push`, ledger, two notifications | `players.ageUp(id)` inside the unit of work with the ledger and notifications |
| Medical consent S:1618, 3387; condition S:3399 | nested assignment | `players.update(id, { medical: { shared, conditionStatus } })`; `records` stays a facet |
| Location S:3414; stats S:3500; prefs S:3861; programme start S:3577 | whole replacement | `players.update(id, { … })` |
| Child creation S:1386–1424 **(UoW)** | `db.players.push`, `childIds.push`, saved-search matches, broadcast | `players.insert` + `guardians.link` inside the unit of work |
| Signing completion and its rollback `m29/index.mjs:613–620` **(UoW)** | `Object.assign(player, JSON.parse(snapshot.player))` on failure, plus ledger/signings/invoices truncation | `players.restore(id, snapshot)` as the repository's only whole-record writer, inside the signing unit of work |
| Deletion S:3978–4023 **(UoW)** | `db.players.filter(...)` plus cross-collection work, `persistNow()` | `players.remove(id)` (today's hard delete) inside the unit of work; S4b replaces it per O1 |
| Creation S:1144–1178; `seed.mjs` | `db.players.push` | `players.insert`; the seed stays data (first-installation initialisation) |

### 2.4 Copies of player data outside the record

`name` is copied onto `requests`, `trials`, `vouches`, `signings`, `squadInvites`, open-day
registrations, `orgs[].squad[].name`, `recruitmentCases`, `assessments`, `transitionCases`;
`deletePlayerData` nulls only some (S:3989–4003). The full list of collections carrying a
player id is in `s4-deletion-decision.md` §5; none is touched by S4a.

## 3. Guardian fields: current readers and writers, proposed storage

Creation: signup S:1239–1247, co-guardian S:1580–1589 (no password, no `emailVerified`, no
`createdAt`), seed `seed.mjs:94, 104`.

| Field | Shape | Written after creation by | Read by (main) | S4 storage |
|---|---|---|---|---|
| `id` | `gd-N` | never | everywhere | column, PK |
| `name` | string | never | S:1325, 1333, 1520; `m21/permissions.mjs:185` | column |
| `email` | string **as typed** | never | S:1235 (uniqueness, lowercased), S:1285 (login, case-sensitive), `m13/delivery.mjs:55`, `m23/contactRoutes.mjs:518–522`, `m14/organisations.mjs:763` | column; unique index on `lower(email)` (§5.3) |
| `password` | scrypt/null; **absent** on co-guardians | S:1297 | S:1290–1297 | column `password_hash` |
| `emailVerified` | bool; absent on co-guardians | S:1272 | S:1268, 1366 | column (absent kept absent) |
| `emailCode` | 6 chars **plain**, no expiry, no attempt limit | S:1273 (→ null) | S:1253, 1260, 1269 | **facet in S4a, unchanged** (plain, as today — no new copy is made); hashing, expiry, attempt limits and a resend route belong to S6 together. Reason: §8.2 |
| `idVerified` | bool | S:1329; admin S:4234 | S:1369; `m23/contact.mjs:273` | column |
| `idvReference` | string | S:1330 | shadow only | column |
| `disclaimerAccepted` | bool | S:1344 | S:1372; `m23/contact.mjs:273` | column |
| `childIds` | string[] | S:1420 (push), 3137 (filter), 4018 (filter); co-guardian S:1585 copies the primary's list | 34 `includes`, 2 `filter`, 2 `map`, 2 `length`, one `[0]` guarded by `length === 1` (S:1630) | **`guardian_children` rows**; the record view serves `childIds` as a read-only array derived from the table; the three writers become `guardians.link` / `guardians.unlink` |
| `coGuardianOf` | guardian id on the co record | never | shadow only | column `co_guardian_of` (FK, SET NULL) |
| `coGuardians` | `[{id, name, email}]`, append-only | S:1589 | `guardianView` spread, admin | facet |
| `notificationPrefs` | `{quietStart, quietEnd, schoolHoursMute, timezone}` | S:3861 | S:747 | composite → `prefs_*` |
| `removedAt` | **never written** | — | `m23/contact.mjs:273` | `deleted_at` in the DDL; written by nothing until O1/S4b |
| `createdAt` | **never written** | — | — | column, NULL for every existing row |
| unknown fields | — | — | — | facet |

## 4. What moves during S4a, and how nested data awaiting S5 remains intact

- **Moves to columns:** every field marked "column" or "composite" in §2–§3, plus the link
  table. `players.guardian_id` and `guardian_children` are written together by every link
  change, so the two can no longer drift (§5.2).
- **Stays nested, intact:** every "facet" travels in `facets_json` with key order, explicit
  nulls and composite presence in `__meta` (the S3 mechanism), is served on the same record
  object the routes hold, is mutated in place by its existing writers, and is flushed by the
  repository's save hook inside every snapshot save, counted as persisted only once that save
  committed. The round-trip test is repeated for every seed and signup shape (adult,
  guardian-created child with `city: ''`, co-guardian without password, `stats: null`,
  `location: null`, `notificationPrefs: null`, absent `drillResults`, `emailCode` present).
- **Split composites** (`medical`, `programme`): column-backed sub-keys guarded; `records` /
  `completed` mutable facets; the test asserts `medical.records.push` succeeds and
  `medical.shared = true` throws.
- **The S1 shadow** of the three tables is dropped by the migration and recreated live with
  `facets_json`; `CORE_SHADOW_TABLES` becomes empty and the validation command is retired.

## 5. Relationships, minors, duplicates, inconsistencies, invalid records

### 5.1 The relationship model as implemented

"Primary guardian" means `players[].guardianId`: channels (S:853), request routing (S:2121,
2740), notifications, media (S:4268), SSE (S:486) and the guardian thread list (S:1506) go to
the primary only; every `/guardian/children/:id` gate checks `childIds` only. "Co-guardian"
(`POST /guardian/coguardian`, S:1576–1591) is created immediately with no invitation, **no
password and no route that ever sets one** (cannot log in unless dev logins are on, S:1290,
1298), a copy of the primary's `childIds` at that moment, and a `coGuardianOf` nothing reads.
`resolveContactRecipient` (`m23/contact.mjs:263–280`) is the only code reasoning about several
guardians. No end-to-end test calls `/guardian/coguardian`. S4a keeps this model:
`guardian_children.role` is `primary` where the row matches `players.guardian_id`, `co`
otherwise (`repositories/shadow.mjs:198`).

### 5.2 Inconsistent links and how the cutover treats each (report, never repair)

| Place | Writes | Not written |
|---|---|---|
| child creation S:1392 + 1420 | `p.guardianId`, creator's `childIds` | the creator's co-guardians' `childIds` |
| co-guardian creation S:1585–1589 | co `childIds` (snapshot), `coGuardianOf`, primary `coGuardians` | `players.guardianId` (correct) |
| aging-up S:3135–3140 | primary's `childIds`, `p.guardianId = null` | co-guardians' `childIds` |
| `deletePlayerData` S:4018 | every guardian's `childIds` | — |
| seed | both | — (`pl-imani`, 18, still in `gd-marek.childIds` — **verified** by running `buildSeed()` through `isAdult`) |

| Finding | Treatment |
|---|---|
| `players.guardianId` names a missing guardian; `childIds` names a missing player; `coGuardianOf` names a missing guardian | **refuses the cutover** (`CORE_IDENTITY_CUTOVER_BLOCKED`, ids listed) |
| `players.guardianId = G` but `G.childIds` lacks the player | refuses: the sides disagree and only the operator can say which is right |
| `G.childIds` lists a player whose `guardianId` is another guardian or null | imported as `role = 'co'`; counted |
| an adult still linked to a guardian (the seed has one) | imported unchanged; counted; no policy implied |
| a co-guardian without `password` / `emailVerified` | imported as is |
| a minor with no guardian link at all | **refuses the cutover** until the record is resolved by hand — the Founder's decision (§5.5); implemented in the preflight and in `initialize()` |

### 5.3 Duplicate e-mails

Signup enforces uniqueness case-insensitively (S:1235); the co-guardian path enforces nothing
(S:1576–1590); login compares case-sensitively (S:1285) and the first record wins. The migration
**refuses the cutover** on two guardians sharing `lower(email)` (ids listed): which record is
the person who signs in is an identity decision for a person on the pre-S4 build. The strict S1
validation already reports this today. After the cutover the co-guardian route uses the
signup's predicate (`guardians.emailTaken`), the unique index being a backstop.

### 5.4 Minor protections that S4a must preserve

All stay in code and are exercised by the existing suites; S4's views call them. `isAdult`
(`domain.mjs:76–79`, unknown age is not adult; `ADULT_AGE` by country), `visibleToOrg`
(`domain.mjs:110–121`), signup/child-creation gates (S:1137–1143, 1383, 1366–1374), minor inbox
and messaging (S:3206–3230, 3233, 3284, 3289, 3304, 3314; SSE S:464–465), medical (S:3386 /
1615), availability (S:3429 / 1564), Academy+ (S:3336), first-team seeker (S:3675 / 3833),
vouches (S:3741 / 3843), open days (S:3655 / 3814–3822), trial consent (`m12/journeys.mjs:674–678,
726, 731–734`), offers (`m28/index.mjs:443–445`, 792), signing (`m29/index.mjs:332, 337`;
`m29/signing.mjs:50–53, 159`), agents (`m24`, `m25`, `m26`, `m27`), school-hours mute (S:745,
752), no external e-mail for minors (`m13/delivery.mjs:43–47`), development plans
(`m21/permissions.mjs:91–128`). Gaps recorded, not fixed by S4: `/guardian/*` never re-checks
that the child is still a minor; `GET /player/export` (S:4025) has no minor check and includes
guardian–club threads; request routing can target a null `guardianId` (S:2120–2129); pairing
codes (S:3760–3778) can be minted by any guardian listing the child and `/auth/player/pair`
has no rate limit.

### 5.5 Legacy minors without a guardian link — decided: stop until resolved

**The Founder's decision (11 October 2026): "Stop until resolved."** If an existing under-18
player has NO linked parent or guardian — `guardianId` null or absent and listed by no
guardian's `childIds` — the migration **refuses the entire cutover** until that record is
explicitly resolved on the pre-S4 build. It is not imported unchanged, not silently omitted, not
given an invented guardian or link, its birth date is not changed and the account is not
deleted; the affected ids are listed (never credentials or records). Age is evaluated at an
explicit instant and the migration re-evaluates at its own run time. The decision concerns the
migration only; it creates no deletion or retention policy, and it does **not** extend to the
separately documented cases of adults still linked or minors with valid `co` links only, which
stay counted findings (§5.2). Implemented: `validateCoreIdentity` refuses such a record
(`MINOR_WITHOUT_LINK_REASON`, `legacyMinorsWithoutLink` ids, no candidate, exit 2 from the
command) and `identity.initialize()` writes nothing and leaves initialisation pending.

The first draft of this review proposed "count and import unchanged" and presented the
alternative "refuse until resolved"; the paragraphs below are kept as the record of that
discussion, and the Founder chose the alternative.

- **How such a record can exist today:** signup refuses minors (S:1137) and child creation
  always links (S:1392, 1420), so a minor without a link arises only through a mis-dated record
  that aged up and was then re-dated (no route does this), through a legacy snapshot, or
  through a guardian deletion that does not exist. The seed has none (**verified**). Real data
  may.
- **Proposed treatment:** the cutover **imports the record unchanged and lists it** (id only) as
  a finding in the dry run and in `meta.coreIdentityCutover`; it neither invents a link (there
  is no candidate guardian) nor discards the record (a person's data). The plan's acceptance
  condition is then stated precisely as a **rule for writes**: after S4a no code path can create
  a minor without a link (`players.insert` for a minor requires a `guardians.link` in the same
  unit of work, enforced by the repository), and the dry run shows the count of legacy
  exceptions.
- **How those accounts remain protected meanwhile:** `visibleToOrg` hides a minor from agencies
  and unverified clubs regardless of links; the contact path fails closed with no guardian
  (`m23/contact.mjs:263–280` → `CONTACT_RECIPIENT_UNAVAILABLE`); the minor inbox and messaging
  gates do not depend on a link (S:3206–3314); offers are refused for minors (`m28/index.mjs:443`);
  a pairing code needs a guardian listing the child (S:3760), so nobody can sign in as that
  minor; request routing would send to `{guardian, null}` (S:2126 — an existing gap, not widened).
  What the link adds is a *representative*, not a protection; its absence means no one can act
  for the child, which is the condition the finding reports.
- **Alternative the Founder may prefer:** refuse the cutover until each such record is resolved
  on the pre-S4 build (there is no route to resolve it: a guardian would have to be created and
  linked by hand). Stated so the choice is explicit.

### 5.6 Invalid records

Validation without coercion, refusing the cutover on the first problem (listing all).
Unsupported: no string `id`/`name`; a `dob` that `parseStrictDateOnly` rejects
(`temporal.mjs:91`); missing `country`; `position`/`foot`/`level`/`availability`/`contractStatus`
outside their CHECK lists; a non-boolean flag; a non-object `stats`/`medical`/`location`/
`notificationPrefs`/`programme` where present; `location` with one of `lat`/`lng`; a guardian
without `id`/`name`/`email`; `childIds` not an array of strings; a reserved `__meta` key.
**Absent is not invalid** (`drillResults`, guardian `createdAt`, co-guardian `password`). The
shadow's coercions (`repositories/shadow.mjs:106–117`) are **not** carried into the live import.

## 6. The exact fields each audience may receive — reconciled against the code

Method: each list below was built by reading the view function and the route and comparing with
the first draft; every difference is classified **kept** (as today), **intentional privacy fix**
(the plan already names it as a leak and the e2e privacy suites assert its absence where they
exist), or **withdrawn** (a change the first draft proposed by mistake). Nested payloads were
checked item by item. The S4a acceptance test records today's response keys per audience as a
fixture and fails on any key difference not listed here, so no accidental API change ships.

### 6.1 Clubs — `playerViewForOrg` (S:1052–1096), used by `/org/players`, `/org/players/:id`, morelike, shortlist, `m12/scouting.mjs:747`, `m13/insight.mjs:131, 168`, `m18/nobodyMissed.mjs:47`, rooms (`m17/rooms.mjs:83` minus `trustScore`/`trust`)

Precondition unchanged: `visibleToOrg(player, org)` and `isBlocked` (S:1053–1054).

| Field | Today | S4a | Classification |
|---|---|---|---|
| `id`, `name`, `position`, `foot`, `heightCm`, `weightKg`, `country`, `level`, `availability`, `contractStatus`, `identityVerified`, `footballCategory`, `squadNumber`*, `createdAt`, `firstTeamSeeker` | served (spread) | served | kept (`createdAt` is named a leak by the plan; **kept** here because clients may show "joined"; dropping it is a separate decision, §11) |
| `academyPlus`, `marketValueRange`, `agentName`, `contractUntil` | served to pro/academy; **deleted for grassroots** (S:1084–1087) | same | kept — the first draft wrongly served `academyPlus` to every club; withdrawn |
| `firstTeamSeeker` | in the spread for every club; grassroots coerces it to boolean (S:1089) | same | kept (the first draft said "grassroots only"; withdrawn) |
| `distanceKm` | grassroots only (S:1088) | same | kept |
| `city` | `''` for minors (S:1078), else served | same | kept |
| `age`, `profileSignal`, `trustScore`, `guardianManaged` | derived (S:1059–1066) | same | kept |
| `contactPolicy: 'guardian_only'` | minors only (S:1079) | same | kept |
| `medical` | shared → the whole `medical` object (`shared`, `records[]`, `conditionStatus`); unshared → **`{ shared: false, records: [], conditionStatus: 'not_shared', note: 'Medical data is player-controlled and has not been shared.' }`** (S:1067–1069) | same object, same `note` text | kept — the first draft's `{ shared: false }` was wrong; withdrawn |
| `vouches` | non-pro players (S:1092), via `publishedVouchesFor` | same | kept |
| `orgNotes`, `similarPlayers` | `/org/players/:id` only | same | kept |
| `stats`, `seasonHistory`, `badges`, `timeline`, `drills` | served | served | kept |
| `media[]` items | every field (`id, title, kind, uploadedAt, url, views, tags, verifiedClip, captions, sizeBytes`) | same | kept — the first draft dropped `captions`/`sizeBytes`; withdrawn (captions feed the clip player; not personal beyond the clip) |
| `attendance[]` items | every field incl. `gps`, `deviceConfirmed`, `trialId` | `id, fixture, venue, date, verified, corroboratedBy, deviceConfirmed, trialId` — **`gps` removed** | intentional privacy fix (schema §11 item 3: attendance GPS leaks to clubs; `PRIVACY_HARDENING`) |
| `trialReports[]` | **every club's** reports incl. `notes`, `strengthNote`, `focusNote`, `scoutName` | only reports whose `orgId` is the viewing org (the authoritative copy is `trials.report`) | intentional privacy fix (schema §11 item 3) |
| `notificationPrefs` | served | **removed** | intentional privacy fix (quiet hours and timezone are the player's settings) |
| `externalIds[]` | served incl. `claim` (the import record) | **removed** | intentional privacy fix (another org's import data) |
| `drillResults[]` | served | **removed** | intentional privacy fix (schema §11 item 3) |
| `dob`, `location`, `programme`, `guardianId`, `password`, `activityLog` | never (S:1055, 1072, 1094–1095) | never | kept |

\* `squadNumber` is served to grassroots too today (only the four pro-market fields are
deleted); kept.

Small allowlists that read from this view and are unchanged: film room (S:2303–2309), feed
(S:2357), fixtures (S:2507), open-day registrations (S:2685–2688), `roomSummary`
(`m17/shared.mjs:792`), combine card (`m16/combine.mjs:260`), m13 shortlist export
(`m13/imports.mjs:309`).

### 6.2 Agencies

`clientIdentity` (`m24/index.mjs:148–158`): a missing player → `{id, name: null, removed: true}`;
not visible → `{id, name: null, unavailable: true}`; relationship grants access → the full §6.1
view plus `id`, `name`, `accessBasis: 'active_confirmed_relationship'`; otherwise
`{id, name, position, age, club, country, accessBasis}` (`club` is always null: not a player
field). `/org/agent/players` (`m24/index.mjs:481–492`): adults only (`isAdult`, `visibleToOrg`,
`isBlocked`), `{id, name, position, age, club, country}`. **Kept exactly**; the minimal shape is
named `AGENT_SUMMARY`. Agencies inherit the §6.1 fixes through the full view.

### 6.3 Guardians

- `GET /guardian/children` (S:1357–1363): the whole player record minus `password`, plus `age`,
  `trustScore`, `trust`. **Kept** (includes `medical`, `location`, `activityLog`, `dob`: the
  guardian is the child's representative).
- `POST /guardian/children` (S:1423): the raw record **including `password: null`**. S4a returns
  the same allowlist as the list above (no `password` key). Classification: intentional fix of a
  key that is always null; a client reading `player.password` would get `undefined` instead of
  `null` — flagged in §11 for confirmation.
- `guardianView` (S:1348–1351): strips `password` and `emailCode`, spreads the rest —
  `id, name, email, emailVerified, idVerified, idvReference, disclaimerAccepted, childIds,
  coGuardianOf, coGuardians[] (id, name, email), notificationPrefs`. **Kept as is**, including
  `idvReference` and `coGuardians[].email` — the first draft proposed dropping `idvReference`;
  withdrawn (a change to the guardian's own view is not S4's to make without a decision; listed
  in §11).

### 6.4 Players (themselves)

`GET /player/me` (S:3109–3127): the record minus `password` plus `age`, `trustScore`, `trust`,
`tier`, `streak`, `weeklyGoal`, `nextActions`, `agingUp`, `pathway`, `programme` progress,
`vouches` (minus `coachEmail`, `code`). Signup response (S:1182–1183): record minus `password`.
`exportPlayer` (S:3879–3890): profile minus `password` plus requests, threads, notifications,
insights, ledger events. **All kept.**

### 6.5 Administrators / Trust & Safety

No admin list of players today (`m13/transitions.mjs:195`, `m15/passport.mjs:544`,
`m162/trust.mjs:264` by id). `/admin/guardians` (S:4227–4229) returns `{ guardians: db.guardians,
idvQueue }` **raw**, and `/admin/guardians/:id/idv` (S:4238) returns the raw record: both
include the password hash and the plain e-mail code (schema §11 item 4). S4a allowlist for both:
`id, name, email, emailVerified, idVerified, idvReference, disclaimerAccepted, childIds,
coGuardianOf, coGuardians, notificationPrefs, createdAt` plus `idvQueue` — never
`password`/`password_hash`, never `emailCode`. Classification: intentional privacy fix (the
plan's S4 names it).

### 6.6 Guardian ids on org-facing recruitment payloads (recorded, unchanged by S4)

Raw `/org/requests` (S:2513–2515) includes `guardianId`; raw `/org/trials` (S:2517–2519)
includes `recipient.guardianId`, `history[].by`, `schedule.confirmedBy`, `day.consents[].by`;
open-day registrations spread `guardianId` (S:2682–2688); squad invites expose
`guardianApproved.guardianId` (`m14/organisations.mjs:770`); message senders carry the
guardian's id and name (S:1520). S6–S8 surfaces; listed so §6 is not mistaken for a complete
audit of guardian-id exposure.

## 7. Migration, boot, authority, sessions, failed saves, transaction boundaries

### 7.1 Migration `0005_core_identity_live`

`foreignKeysOff = true`, inside the runner's one transaction: read the `guardians` and
`players` blobs (JSON and array checks); validate every record (§5.6) and every link (§5.2,
§5.3) — abort with `CORE_IDENTITY_CUTOVER_BLOCKED` listing ids and reasons, file byte-identical,
same abort next boot, no repair, no demo data; `DROP TABLE guardian_children, players,
guardians` (the S1 shadow) and create the live definitions (`01_identity.sql` + `facets_json
TEXT CHECK (json_valid)` on `players` and `guardians`); insert guardians (two passes for
`co_guardian_of`), then players, then one `guardian_children` row per `childIds` entry with the
role rule; `PRAGMA foreign_key_check` must be empty; write `meta.coreIdentityCutover` (counts
incl. the §5.2/§5.5 findings) and `meta.coreIdentityInit` (`done` when a blob or any saved
collection existed, `pending` only for a never-saved database); delete the two blobs.
Completion is decided only by the `data_migrations` row. `sessions`, `org_users`, `orgs` are
not touched by any statement.

**Status: implemented, tested and REGISTERED** (`repositories/migrations/0005_core_identity_live.mjs`
in `DATA_MIGRATIONS`, followed by `0006_media_deletions`; `scripts/testCoreIdentityMigration.mjs`
invokes it through the real runner on temporary S3-shaped databases and proves the integrated boot). Two refinements over
the paragraph above, settled while building it: the kind of database is decided from explicit
state only — a genuinely new database (no collection row, no `saveSeq`, no `savedAt`) cuts over
empty with `pending`; a saved snapshot must carry BOTH blobs as arrays, and an absent, unparsable
or non-array collection is a refusal (`CORE_IDENTITY_CUTOVER_BLOCKED`), never an empty import and
never a first installation; the shadow tables' rows are discarded unread and their counts recorded.
The migration refuses to run over an initialised live domain. It is registered and the
repositories are attached at boot (§7.2).

### 7.2 Boot order and the snapshot-presence change

`attachDataLayer` initialises or attaches `guardians` before `players` (the FK), both before
`users`; `db.guardians` and `db.players` become read-only views. The integrity report already
runs after the data layer (S3), so `ROOM_ORPHAN_PLAYER` / `PLAYER_ID_DUPLICATE`
(`m182/integrity.mjs:48, 64`) keep seeing players; `m182_002` (`db.players ??= []`) creates an
empty placeholder that `attach()` ignores; no other `m182` step reads players or guardians.
`loadSnapshot` treated a file without a `players` array as "no snapshot" (S:129–135) and the
server-mode `store.load()` does not read table-backed collections, so **S4a had to give the store a
snapshot-presence signal that does not depend on a `players` blob**, or every boot after the
cutover would have run from the seed. **Done:** `store.load()` decides "never saved" from the
absence of blob rows AND of a save record (`meta.savedAt` / `saveSeq`); `loadSnapshot` takes any
loaded snapshot as a saved file (the log says `players table-backed`), refuses a `players`
collection that is not an array with `SNAPSHOT_INVALID`, and never seeds over a saved file. The
regression is in `scripts/testCoreIdentityServer.mjs` (a migrated file without blobs, restarted)
and `scripts/testCoreIdentityMigration.mjs` (the integrated boot).

### 7.3 Restart, authority, sessions, failed saves

A failed cutover rolls back and the next boot retries (injected failure after the inserts). An
interrupted first-installation initialisation leaves `pending` and retries. Cut-over empty
tables are authoritative: `attach()` imports nothing; a stale blob written back is ignored and
deleted by the next save. Player and guardian sessions carry `kind`/`ref_id` without a foreign
key; the migration never writes `sessions`; every token and `sid` stays valid (asserted by hash
and count). Facet changes are pending until the store reports the commit and are flushed again
after a rollback (S3 correction 1). The runtime contract (`runtime.mjs`) covers S4 unchanged.

### 7.4 Transaction boundaries for operations spanning several collections — the implemented foundation

**Today's deletion is not entirely atomic (corrected).** `deletePlayerData` (S:3978–4023)
mutates eleven blob collections in memory and ends with `persistNow()` (S:4021), so those
eleven land together or not at all — but two steps happen **outside** that final save and
before it: the media files are deleted from the filesystem first (S:3982), and the player's
sessions are deleted from the live `sessions` table at once (S:3983, an autocommit statement
since S2). A crash between S:3982 and the save therefore leaves a player row whose media ids
point at deleted files and whose sessions are already gone, while every blob still names the
player. Child creation (S:1386–1424) and aging-up (S:3132–3146) touch blobs only (plus the
debounced save), so they are all-or-nothing today; the signing completion (`m29/index.mjs:613–620`)
restores memory on failure and the next save persists either the completed or the restored
state, but its session or organisation writes, if any, would be immediate. **Existing
limitation (since S2/S3, not new):** table-backed domains write immediately while blob
collections wait for the save, so a crash between a staff/organisation row write and the save
leaves, for example, an organisation row without its ledger entry.

**The inconsistency S4a would have introduced** (design risk, now closed by implementation):
player rows written immediately with the cross-collection cleanup waiting for the save would
have made deletion, child creation, aging-up and the signing rollback **partially durable** on a
crash or a failed save — and the first draft's recovery story ("repositories reload their rows,
blob mutations stay in memory, the next save retries") was contradictory: a later ordinary save
would have persisted the blob half of a failed operation while its row half had been rolled
back. That is exactly the partial application the foundation below prevents.

**Implemented (commit after `f899577`): `store.unitOfWork(work, { snapshot })`** in
`store.mjs`, with `repositories/memento.mjs` and the organisations repository as the first
participant (`scripts/testUnitOfWork.mjs`, 17 checks). An independent review of the first
commit reproduced five defects — a failed `BEGIN` left a phantom unit active, a swallowed nested
failure committed partial work, a facet changed back before `COMMIT` left the row update's
intermediate value in the table, an async callback ran before its promise was refused, and a
rejected after-commit promise went unobserved — each was written as a failing regression and
corrected; the rows marked below reflect the corrected behaviour. The contract, as built and
tested:

| Aspect | Explicit unit of work | Ordinary snapshot save (S3 contract, unchanged) |
|---|---|---|
| What commits together | every repository row write made inside `work`, every facet change, every in-memory blob mutation, the id counter and save revision — one `BEGIN … COMMIT` | the flush of pending facets and every blob |
| On failure (inside `work`, in a flush, in a blob write, at `COMMIT`) | `ROLLBACK`, then **memory is restored to the state at the start of the unit**: every blob collection, record, nested array and object is put back in place by identity (`captureGraph`/`restoreGraph`), so references callers hold stay valid and show pre-operation values; each participant restores its own records, view order, id index and change tracking (`snapshotState`/`restoreState`); the error carries `unitOfWork = 'rolled_back'` | `ROLLBACK`; memory is left as it is (it is the intended state); facet tracking discards what the flush wrote |
| Retry | **explicit**: the caller runs the whole operation again; a later ordinary save persists **no fragment** of a failed unit (tested: the save after a failed unit writes only the edits that were pending before it) | automatic: the next ordinary save retries every pending change |
| Edits pending before the operation | part of the restored state: still in memory, still pending, persisted by the next ordinary save (tested) | — |
| Process crash before `COMMIT` | SQLite rolls back; a restart sees the pre-operation database in every collection and table (tested with `SIGKILL` in a child process) | same |
| Asynchrony | `work` must be synchronous (a SQLite transaction never spans an `await` or a network call). An `async function` is identifiable and is **refused before it is invoked** — nothing of it runs, top-level or nested. A plain function that returns a promise cannot be recognised beforehand: its synchronous part is rolled back with the unit, the unit refuses, the promise is observed (a rejection is counted and logged, never unhandled) — and **its continuation is not cancelled**: it runs later outside any unit, counted in `unitOfWorkState().strayAsyncWork`. The store cannot make asynchronous work safe and does not claim to | — |
| Nesting | a unit started inside a unit **joins** it (one transaction); an inner failure poisons the whole unit **even when the inner caller catches the error** — the outer unit fails at its end with the inner error as `cause`, nothing commits, nothing is published; a unit cannot start inside a foreign open transaction | `save()` inside a unit is **absorbed** into the unit's commit (one save revision) |
| Side effects | `store.afterCommit(fn)` defers a broadcast or a push until `COMMIT` returned; **nothing is published for a rolled-back unit**; a side effect never fails the operation — a synchronous throw **or a rejected returned promise** is counted and reported (`store.unitOfWorkState()`), later callbacks still run, and it is **not** a rollback — the data is committed. `server.mjs` `broadcast()` and the push in `notify()` (which returns its promise) use it; outside a unit `afterCommit` runs the callback at once, observed the same way | — |
| Setup and teardown | exception-safe: a failed `BEGIN` opens no unit and runs no work; a failing cleanup step (ROLLBACK, memento, a participant's restore) is recorded (`restoreFailures`, `err.unitOfWorkCleanup`) and still closes the unit | — |
| Facet flush inside a unit | the flush compares the intended facets against what the **transaction already wrote** (a row update's intermediate value), not against the committed value alone, so a facet changed inside a unit and changed back before `COMMIT` overwrites the intermediate row; view and table agree after commit, rollback, an ordinary save and a restart | compares against the committed value (nothing else was written) |
| Participants | **organisations** (rows, facets, view, id index: full participation), **sessions** (stateless over the table: rows roll back with the SQL, nothing to restore, writes allowed), **staff (`org_users`)**: writes inside a unit are **refused** because its in-memory rows are not integrated (tested); integrating it is a later step. No atomicity is claimed for anything else | hooks' `flush/commit/rollback` |
| Repository operations (players, guardians, links — corrected after an independent review of the repository commit) | every write runs through `store.unit.join(work)`, the store's explicit participant API and the same boundary a nested unit uses (no `BEGIN`, no savepoint): an operation that fails after its first statement poisons the unit **even when its caller catches the error** — nothing of the unit commits, nothing is published, memory is restored; a validation refusal is thrown before the boundary and does not poison (a caller that catches it may complete its unit) | outside a unit the operation's statements run in a transaction of their own and its memory bookkeeping (records, held references, link arrays, indexes, views, facet tracking) is applied **only once `COMMIT` returned**: a failure anywhere, `COMMIT` included, leaves SQL and memory as before and the caller simply retries |
| Memento cost | one graph capture per unit: 1,000 players + 2,000 requests, about 12,000 objects, under 25 ms each way on the development machine (printed by the suite) | — |

**What S4a builds on this.** The four operations of §2.3 marked (UoW) run inside
`store.unitOfWork`, with the player and guardian repositories implementing
`snapshotState`/`restoreState` exactly as the organisations repository does. A route ends by
returning; the unit's commit *is* the save (`persistNow()` inside it is absorbed). Single-field
column writes (availability, Academy+, level, password rehash, consent, location, stats, prefs)
keep the S3 immediate model unless the same request also writes a blob, in which case they too
run inside a unit.

**Media files (filesystem, outside SQLite) — built (migration `0006_media_deletions`,
`repositories/mediaDeletions.mjs`).** The database transaction commits first; the removal of
each file is queued in `media_deletions` inside the deletion's transaction and processed after
COMMIT, at boot and once a minute; an entry goes only once storage reports the file removed or
already absent (a failing removal keeps the entry with the attempt count and the error);
`/media/:id` answers 404 for a queued id before any authorisation; a crash before COMMIT deletes
nothing. The rollback tool refuses a non-empty queue (exit 8) and drops the table on an empty
one. Tests: `scripts/testMediaDeletions.mjs`, the deletion case of `scripts/testCoreIdentityServer.mjs`
(a stuck file, 404 while queued, the boot retry).

**Session revocation inside a unit.** `sessions.revokeFor` is a plain statement; inside a unit
it rolls back with the unit, so S4a's deletion revokes sessions *inside* the unit and the
revocation is part of the all-or-nothing (done: `deletePlayerData`).

**Status of the per-operation units (done):** player and guardian sign-up with the session,
child creation with its link and saved-search notifications, e-mail verification, the
co-guardian invitation, aging-up, the admin ID review, the level review with its ledger row, the
signing completion (the hand-written snapshot/restore replaced by the unit; a refusal inside the
unit is a `SigningAbort` that rolls back with the route's error code; the success-fee invoice is
issued after COMMIT, never inside the transaction) and the legacy signing route, and deletion.
Added after the review of `9656a4b`, which reproduced the medical-record route committing its
column and leaving its record to the delayed save: the medical record (condition column +
record), guardian ID verification (the provider is asked before the unit; column + audit-queue
entry), programme selection (track columns + the reset of completed sessions), Academy+ (column
+ badge), stats (columns + activity log, badges, notifications) and squad release (the
organisation's squad facet + the player's columns + the reference + the ledger + the
notifications) — each one `unit()`, answered 500 when the unit fails. The single-column writers
(availability, location, first-team seeker, preferences, disclaimer, football category, the
login hash upgrade, medical sharing) are one row UPDATE each and need no unit.
Failure injections: the fault seams `signing.complete.after_row`, `after_lifecycle` and
`at_commit` (a named throw at the last statement of the unit, just before COMMIT — not a COMMIT
failure) in `scripts/m23SigningE2E.mjs`; the injected COMMIT failure, the caught inner failure
and the process killed before COMMIT in `scripts/testIdentityRepositories.mjs` and
`scripts/testUnitOfWork.mjs`; for the six routes above, `scripts/testWriterAtomicity.mjs`
through the real server — `internal:<route>.after_row` (a throw after the first row write) and
`internal:unit.sqlite_commit` (the store's `failCommitOfOpenTransaction`: a deferred
foreign-key violation that makes the REAL COMMIT statement fail), each leaving nothing in the
database (read through a second connection) or in memory, the retry landing everything, and a
SIGKILL right after the response losing nothing.

**Failure-injection tests S4a adds per operation** (the foundation's suite already covers the
mechanism with the organisations repository): failure after the row statement, failure at
`COMMIT`, process killed inside the unit; after each the database holds the pre-operation
state in every collection and table, the view equals the table, held references show the
pre-operation values, an ordinary save persists no fragment, and an explicit retry lands the
whole operation.

## 8. Rollback design

### 8.1 The tool

`node scripts/coreIdentityRollback.mjs <data-dir> <out-dir>` on a copy (server stopped; the
source is never modified; refuses a later schema with exit 4, a never-cut-over file with exit 5,
a non-empty output directory with exit 1): rebuild the `players` blob (columns and facets merged
through `fromRow`, `guardianId` from the column); rebuild the `guardians` blob (`childIds` from
`guardian_children` in `rowid` order, `coGuardians` and `emailCode` from the facets); recreate
the S1 shadow definitions empty; leave `sessions`, `org_users`, `orgs` untouched (nobody signs
in again); delete the `0005` record and the two `meta` keys; advance `meta.saveSeq`;
`foreign_key_check`; VACUUM; verify against the real pre-S4 build (worktree at the S3 commit)
with synthetic data, as S2 and S3 were.

**Status: implemented and tested, valid for the final schema** (`repositories/coreIdentityRollback.mjs`,
`scripts/coreIdentityRollback.mjs`, `scripts/testCoreIdentityRollback.mjs`; the tool knows
migration `0006`, refuses a copy whose media-removal queue is not empty — exit 8 — and drops
`media_deletions` with its record on an empty one; verified against the real previous build at
`c1d868e` with the final code, log in the handoff). As built: the output
directory must be empty (exit 1), a recorded 0005 over shadow-shaped tables is refused rather than
guessed, a first installation whose initialisation has not completed is refused (exit 6: the live
domain holds no authoritative data yet and the pre-S4 build could not tell that apart from an
intentionally empty installation — the operator boots the S4 build once so the import completes,
or starts the pre-S4 build on a fresh directory; independently reproduced on `64ef3aa` and
corrected), a malformed initialisation marker is refused rather than erased (exit 7), an absent
marker keeps the repositories' documented `done` compatibility, the copy is revalidated (integrity, foreign keys, the blobs read back to the row counts,
the shadow tables empty, the sessions exactly the source's) before it is reported, and any
failure removes the partial copy. "The source is never modified" is measured, not assumed: the
main file's bytes and the logical content are identical; SQLite's read-only open of a WAL-mode
file may leave an empty `-wal` and a `-shm` index next to the source when none existed — housekeeping,
not content, removed by the next ordinary open-and-close — and a change still in an active WAL is
carried into the copy. Verified against the real pre-S4 build (detached worktree at `cb1d22b`):
the copy boots there, serves the post-S4 state, accepts the sessions minted before and after the
cutover, verifies the outstanding e-mail codes (§8.2 holds: the code is plain) and persists new
writes; the real migration re-upgrades it to the identical live state. One observation from that
run: the pre-S4 build's own snapshot migrations backfill fields (m182's `externalIds ??= []`) on
any snapshot they boot, so a round trip through a *running* pre-S4 build carries that backfill into
the re-upgraded rows; it is that build's behaviour, not the rollback's, and the in-process round
trip (no pre-S4 boot) is row-identical.

### 8.2 The e-mail verification dead end, resolved

The first draft hashed the guardian e-mail code in S4a (as the S1 shadow does) and admitted that
a guardian with an outstanding, unverified code could not verify on the pre-S4 build after a
rollback, because that build compares the plain code (S:1269) and has no resend route. Printing
the affected ids does not make those accounts recoverable, so that design is withdrawn.

**Resolution (S4a): the e-mail code is not hashed by S4a.** `emailCode` stays exactly what it is
today — the existing plain value on the guardian record — as a transitional facet, like every
other field S4 does not transform. No new copy is created, nothing is marked verified, nothing
is read from mail logs. The rollback is then lossless for verification: the pre-S4 build reads
the same field and the outstanding code still works. Hashing moves to **S6**, together with the
things that make hashing operable — an expiry, an attempt limit and a resend route — so that a
rollback from S6 has a recovery path (a guardian requests a new code) rather than a dead end.

**If the Founder nevertheless wants the code hashed in S4a**, the tool refuses to produce a
rollback copy (exit 6, no output file) while any guardian row has `email_verified = 0` and a
non-null `email_code_hash`, listing the ids, because the output would not be usable for those
accounts; the operator's choices are then to wait until those guardians have verified on the S4
build or to accept the refusal. This is the only honest alternative; it is not the
recommendation.

### 8.3 What is preserved, what is lost

| Post-S4 state | Pre-S4 representation | Loss |
|---|---|---|
| S4a (no deletion change, code not hashed) | complete | **none** — verified at S4a by the rollback test and by the pre-S4-build verification |
| `childIds` order | `rowid` order of the link rows | may differ; no reader depends on order (§3) |
| S4b tombstones (if O1 chooses one) | none: a pre-S4 build would serve a tombstone as a live player | the tool **omits** tombstoned players from the blob and prints the count; the erased personal data cannot be restored by any rollback — the deletion is honoured either way |
| S4b guardian deletion (if added) | none | same |

Restoring a pre-S4 backup is not a rollback: it discards every write since the backup across
every collection. The tool above is the rollback.

## 9. Bounded implementation sequence and acceptance tests

**S4a — cutover, repositories, allowlists, unit of work (one commit; independent of O1).**
Files: `repositories/guardians.mjs`, `repositories/players.mjs` (new, S3 shape plus
`link/unlink/ageUp/restore/remove`, staged bookkeeping, `GUARDIANS_TABLE`/`PLAYERS_TABLE` with
FK-aware prune order links → players → guardians), `repositories/migrations/0005_core_identity_live.mjs`,
`repositories/index.mjs`, `repositories/shadow.mjs` (retired), `scripts/validateShadow.mjs`
(retired), `store.mjs` (snapshot-presence signal §7.2; `unitOfWork` §7.4; `media_deletions`
queue), `server.mjs` (writers of §2.3; `childIds` writers; `views/playerViews.mjs` allowlists per
§6; `/admin/guardians`; the co-guardian uniqueness predicate; the shortlist reader guarded
against a missing player — the verified defect of `s4-deletion-decision.md` §2 is fixed here
because the allowlist view is rewritten anyway), `m12/operations.mjs:280`, `m13/transitions.mjs:202`,
`m29/index.mjs:278, 294–295, 613–620`, `scripts/coreIdentityRollback.mjs` +
`repositories/coreIdentityRollback.mjs`, `scripts/testPlayers.mjs`, `scripts/testGuardians.mjs`,
fixtures, `01_identity.sql` (facets columns), `sqlite-schema.md` §5.0/§5.1, plan §S4,
`OPERATIONS.md`, `CLAUDE.md`. `seed.mjs` unchanged (data).

Acceptance (each a test that fails first where applicable):

1. Round trip: every seed and signup shape byte-identical through `toRow/fromRow`, incl. absent
   `drillResults`, co-guardians without `password`, present `emailCode`, nulls, unknown fields.
2. Validation: every unsupported shape of §5.6 refused with a reason; nothing coerced.
3. Cutover: an S3 file cuts over with every field, every link (roles per §5.1), three tables
   live, `foreign_key_check` empty, blobs retired, `coreIdentityInit = done`, sessions identical
   by hash, staff and organisation tables untouched, `emailCode` byte-identical.
4. Abort cases (§5.2, §5.3, §5.6): file byte-identical, same abort on restart, repaired file cuts
   over; injected failure before commit leaves no trace.
5. Counted findings (co roles, adults still linked, minors with co links only): cut over, counts
   in `meta.coreIdentityCutover`, no row changed; a dry run lists the ids. **Minors without any
   link are not a counted finding: they refuse the cutover (item 4; §5.5, the Founder's
   decision) — implemented in the preflight and in `identity.initialize()`.**
6. Boot: a cut-over file boots as a snapshot with no `players` blob; integrity sees the players;
   first installation initialises once; interrupted initialisation retries; empty authoritative
   tables ignore stale arrays and blobs.
7. Unit of work: for deletion, child creation, aging-up and the signing rollback, the three
   failure injections of §7.4 leave every collection and table in the pre-operation state, the
   view equals the table, and the retry lands the whole operation; a minor cannot be inserted
   without a link in the same unit of work.
8. Writers: every converted writer persists and survives a restart; every facet writer still
   works in place; a failed save followed by a successful one loses nothing.
9. Guards: column-backed assignment on a player or guardian view throws, nested values of
   `location`, `stats`, `notificationPrefs`, `medical.shared`, `medical.conditionStatus`,
   `programme.track` included; `medical.records.push`, `programme.completed.push`,
   `emailCode` assignment (a facet) succeed; array mutation of the views and of `childIds` throws.
10. Links: `link`/`unlink`/`ageUp` write both sides in one transaction; `guardian_id` always
    equals the `primary` row; a second `primary` is refused; the co-guardian route refuses a
    duplicate e-mail with the signup's error.
11. Views: for each audience of §6 the served keys equal the recorded fixture of today's keys
    minus exactly the intentional fixes of §6.1/§6.3/§6.5 (table-driven over seed players: adult,
    minor, pro, grassroots viewer, agency viewer, unverified club, blocked org); `dob`,
    `password`, `guardianId`, GPS, prefs, external ids, other clubs' reports never in an org
    view; the unshared `medical` object is byte-identical to today's; `/admin/guardians` carries
    neither hash nor code; `/org/shortlist` answers 200 after a shortlisted player is deleted.
12. Snapshot tools: export/import and `POST /admin/backup` → restore keep every player,
    guardian, link, code and session; a snapshot listing a child for a missing guardian is
    rejected as a whole; prune order links → players → guardians.
13. Rollback: lossless copy boots on the real S3 build with every post-S4 player, guardian and
    link and an outstanding e-mail code that still verifies there; the S4 build re-upgrades it;
    later schema exit 4, never-cut-over exit 5, no output either time.
14. Media queue: a crash injected after commit leaves the file and the queue entry; the boot
    sweep removes both; `/media/:id` answers 404 throughout.
15. Battery: unchanged suites green apart from the two baseline `m182E2E` client checks;
    `m23BootContract` green.

**Acceptance status after the integration commit and the review corrections** (every item run
on synthetic data; the suite named is part of `npm test` unless stated). The independent review
of the integration commit (`9656a4b`) reproduced three findings against the claims below as they
then stood, each corrected since with a failing-first regression: (1) a route that changed a
column and a facet in one request committed the column at once and left the facet to the
delayed save (`POST /player/medical/records`; the same shape in the guardian ID verification +
its audit entry, programme selection + the reset of completed sessions, Academy+ + its badge,
stats + the activity log, squad release + the player columns, the reference and the ledger) — every
such route is now one unit of work, proven through the real server with a SIGKILL right after
the response and with two injected failures, one after the first row write and one of the REAL
SQLite COMMIT; (2) `POST /admin/backup` copied a media file whose removal was committed but not
yet done, and lost the queue entry — the queue now travels with the snapshot and a queued file is
never copied; (3) a valid whole-domain snapshot was refused when a replacement guardian reused a
removed guardian's e-mail — the replacement is now a rewrite from the validated candidate,
independent of obsolete rows and of input order. **The acceptance below is what the tests
cover and pass; review acceptance of S4a is the reviewer's to give after re-checking these
corrections, not claimed here.**

| Item | Status | Where |
|---|---|---|
| 1 round trip | pass | `testCoreIdentityMapping.mjs`, `testIdentityRepositories.mjs` |
| 2 validation | pass | `testCoreIdentityMapping.mjs`, `testCoreIdentityMigration.mjs` (seven malformed snapshots, duplicates, references, the legacy-minor rule) |
| 3 cutover | pass | `testCoreIdentityMigration.mjs`; on the real server `testCoreIdentityServer.mjs` ("previously saved file") |
| 4 abort cases | pass | `testCoreIdentityMigration.mjs` (four injected failures, a process killed at COMMIT, repair-and-retry); the real server refuses malformed input and the legacy minor twice with the file byte-identical (`testCoreIdentityServer.mjs`) |
| 5 counted findings | pass | `testCoreIdentityMigration.mjs` (`meta.coreIdentityCutover` findings; minors without a link refuse) |
| 6 boot | pass | `testCoreIdentityServer.mjs`: new installation, saved file, intentionally empty, interrupted first installation, migrated without blobs, stale blobs — each restarted; `testCoreIdentityMigration.mjs` (integrated boot) |
| 7 unit of work | pass | deletion / child creation / aging-up / signing: `testCoreIdentityServer.mjs` (routes), `m23SigningE2E.mjs` (fault seams; its `at_commit` is a named throw before the statement), `testIdentityRepositories.mjs` (COMMIT failure, caught inner failure, SIGKILL; a minor cannot be inserted without its link). The six coupled routes of the review (medical record, guardian ID verification, programme selection, Academy+, stats, squad release): `testWriterAtomicity.mjs` — real server, a second connection right after the response, SIGKILL, a named seam after the first row write and the REAL SQLite COMMIT failing (`internal:unit.sqlite_commit`: a deferred foreign-key violation the engine refuses at COMMIT), each answered 500 with nothing in the database or in memory, and the retry landing everything |
| 8 writers | pass | `testCoreIdentityServer.mjs` covers the writers it names (sign-up, e-mail verification, ID verification, disclaimer, child creation, football category, level review, medical sharing, aging-up) through their routes and after a restart — not every writer; the coupled writers are in `testWriterAtomicity.mjs` (item 7); facet writers and the failed-then-successful save: `testIdentityRepositories.mjs`, `testUnitOfWork.mjs`. Single-column writers (availability, location, first-team seeker, preferences, disclaimer, the login hash upgrade) are one row UPDATE each and need no unit |
| 9 guards | pass | `testIdentityRepositories.mjs` |
| 10 links | pass | `testIdentityRepositories.mjs`; the co-guardian duplicate e-mail: `guardians.insert` refusal (`EMAIL_IN_USE`) |
| 11 views | pass | `testCoreIdentityServer.mjs` ("allowlists"): club/adult, club/minor, agency, unverified club, grassroots, blocked, guardian, player, Trust & Safety, shortlist after deletion — allowed and forbidden keys asserted on actual responses (a recorded key fixture was not written; the allowlists are asserted directly) |
| 12 snapshot tools | pass | `testCoreSchema.mjs` (the coupled dispatcher: refusals, partial snapshot, explicit empty arrays; since the review the write is a REWRITE from the validated candidate — a removed guardian's e-mail reused by its replacement, two retained guardians swapping e-mails, players moving to the replacement, co-guardian references, reversed input orders, a failure mid-rewrite and of the real COMMIT), `testCoreIdentityServer.mjs` (`POST /admin/backup` restored into a fresh directory with every player, guardian, link, code and session hash; a backup taken while a media removal is pending carries the queue and not the file), `testMediaDeletions.mjs` (the queue through the snapshot store, validated whole) |
| 13 rollback | pass | `testCoreIdentityRollback.mjs` (round trip, exits 4/5/1/6/7), `testMediaDeletions.mjs` (exit 8); the real previous build at `c1d868e`: the copy boots there, sessions and the outstanding code valid, a write made there re-upgraded (handoff evidence `old-build-verification.log`) |
| 14 media queue | pass | `testMediaDeletions.mjs`; `testCoreIdentityServer.mjs` (a stuck file keeps the entry across a restart, 404 while queued, the rollback refusal, the next boot clears it once the file is absent; since the review: a backup taken with a pending entry and the file still present exports the entry and leaves the file out, the restored server imports the queue, serves nothing for the id, removes a file copied back by hand at boot and stays clean across a restart, an older backup without the queue restores, a tampered entry refuses the restore). **Ownership invariant (review of `4ef9345`): a file referenced by any live player is never deleted by the queue** — a restored queue naming a live clip refuses the restore (`MEDIA_QUEUE_OWNERSHIP_CONFLICT`) before any file is touched and refuses again on the next boot; a snapshot whose final state conflicts (queue-only, identity-only against a retained queue, or both) is rolled back whole, a consistent whole replacement that removes the owner and queues the clip is accepted, a real COMMIT failure with the check in the transaction leaves everything unchanged; an entry already stored is retained at boot and every sweep with a diagnostic, the file and reference survive, `/capabilities` counts it, the backup answers 409 rather than omit the clip; the entry's own `player_id` (unrelated, absent or the owner) never changes the verdict; a record held in memory counts; a legitimate removal completes in the same sweep (`testMediaDeletions.mjs`, `testCoreIdentityServer.mjs`, the reviewer's `review-4ef9345-media-conflict.mjs` 0 of 1). A crash injected between COMMIT and the unlink is represented by the stuck-file case (same state: committed row, pending entry) |
| 15 battery | pass with the stated baseline | 48 suites: 43 green as run; `m182E2E` two baseline client-source checks; `m23RecruitmentJourneyE2E`, `m23SigningE2E`, `m23SigningHardeningE2E` (the `under_contract` drift guards recognise the repository form), `m23RecruitmentJourneyHardeningE2E` (a fixture planting an unreadable date of birth through the snapshot now asserts the refusal) and `m23TemporalIntegrityE2E` (a probe sends `foot: 'right'`; the first battery run crashed before its own checks when `store.load()` returned null after the first boot, not reproduced in two re-runs) adapted and green on re-run; `m23BootContract` green |

Two user-visible changes beyond the §6 privacy fixes, both consequences of the column
constraints: a sign-up or update with a value the schema refuses (`foot` outside `left`/`right`,
a `position` outside the list, an unreadable date) answers `400 PLAYER_INVALID` /
`400 GUARDIAN_INVALID` naming the field instead of storing the value as given; and a snapshot
write (restore, tool, fixture) that carries an invalid identity record is rejected as a whole
instead of imported.

**S4b — deletion and guardian lifecycle (one commit, only after O1 is answered).** Implements
O1 (`players.erase(id)` inside the deletion unit of work: `deleted_at`, the retained columns per
the decision, every other personal column nulled, the name replaced, owned facets cleared, name
snapshots on retained rows replaced, the media queue), the per-table lifecycle statements, and —
if the Founder wants it — a guardian deletion route limited to guardians with no undeleted
child. Until then `removedAt`/`deletedAt` remain never-written.

## 10. Implemented versus proposed

| Table | State at `0c038ef` | After S4a |
|---|---|---|
| `org_users`, `sessions`, `orgs` | live (S0, S2, S3) | unchanged |
| `guardians`, `players`, `guardian_children` | shadow (S1) | **live** (done: migration 0005 registered, repositories attached at boot), with `facets_json` on `players` and `guardians`; `email_code_hash` column present but unused until S6 (the code rides in the facets) |
| `media_deletions` | — | **live** (migration 0006, the crash-safe media-removal queue) |
| `players.deleted_at`, `guardians.deleted_at` | DDL only | still written by nothing (S4b) |
| twelve `player_*` sub-record tables | proposed DDL | **implemented in S5** (migration `0007_player_subrecords`; [`s5-player-subrecords.md`](./s5-player-subrecords.md)) |
| file 02 (recruitment) | proposed; `player_id` without FK pending O1/S8a | unchanged |
| everything else (files 03–08) | proposed | unchanged |

## 11. Open points and the decisions still needed

**Resolved by this review (no decision needed):** the dependency statement (S4a independent of
O1); the e-mail code dead end (not hashed in S4a); the transaction mechanism (unit of work,
staged bookkeeping, media queue); the allowlists reconciled against the code (`academyPlus`,
`firstTeamSeeker`, unshared `medical`, media items, `idvReference` corrected); the shortlist
defect verified and assigned to S4a; the claim that identifying information disappears
withdrawn (`s4-deletion-decision.md` §4).

**Decisions still needed, in plain language:**

1. **O1** — what birth information a deleted player's retained record may keep (and whether the
   country code may stay): `s4-deletion-decision.md` §9. Blocks S4b only. **Partially resolved
   (12 October 2026, §10 of that record):** full birth date chosen; the country code and the
   write-time child-status stamp remain open by the Founder's explicit choice — the S4b items
   that depend on them are listed there. Not to be re-asked on the birth-date axis. **19 October 2026:**
   what remains to build for S4b and its open answers (the country code; the ids of players deleted before
   S4b; the optional additional deletion behaviours) are consolidated in `sqlite-migration-plan.md` §D.1
   and §D.5; the S4b paragraph of §9 above is the dated design it builds on.
2. ~~**Legacy minors without any guardian link**~~ — **decided (11 October 2026): refuse the
   cutover until each is resolved by hand on the pre-S4 build** (§5.5); implemented in the
   preflight and the repositories' initialisation. No longer open.
3. **`createdAt` in the club view** — keep it (proposed, for client compatibility) or drop it
   as the plan's leak list says. Blocks nothing; defaults to keep.
4. **Two small response changes to confirm** — the child-creation response no longer carries a
   `password: null` key (§6.3); `idvReference` stays in the guardian's own view (§6.3). Default:
   as stated.

Recorded, not for decision now: the co-guardian design is reproduced faithfully; the
`drillResults` signup defect and the export/minor gap are route defects outside S4; the runtime
metadata alignment (plan §S3) is independent of S4.

## 12. S4b-R as implemented (21 October 2026, one local commit on `feat/sqlite-schema` on top of `d16362f` — IMPLEMENTED, AWAITING INDEPENDENT ACCEPTANCE)

**Status at the time of writing: IMPLEMENTED, AWAITING INDEPENDENT ACCEPTANCE.** Not production, security,
legal-compliance or deployment approval; not acceptance of S8, of the foreign keys (plan §D.2a, Q3) or of
anything Q2, Q6 or Q7 name; no real data, no real provider. The specification is `sqlite-migration-plan.md` §D.6 as
narrowed by §D.6.1 (the exact column mapping, today's name cleanup and nothing more, the corrected claim about the
audit rows); the decisions it rests on are the Founder's, recorded verbatim: the **full birth date**
(`s4-deletion-decision.md` §10, 12 October 2026) and **"Keep the country code (Recommended)"** (§12, 21 October 2026).

### 12.1 What was built

- **`players.erase(id, { at })`** (`repositories/identity.mjs`), called by `deletePlayerData` (`server.mjs`) in place
  of `players.remove`; one transaction, or the caller's unit: the twelve `player_*` child tables and the
  `guardian_children` rows are deleted explicitly, the row is UPDATED to the retained record — `id`, `deleted_at = at`,
  `birth_date` and `country` kept, `name = 'Deleted player'` and the declared defaults in every other `NOT NULL` column
  as fixed storage placeholders, `NULL` elsewhere, `facets_json` `NULL` — every guardian's held `childIds` is spliced in
  place, the record leaves the view and joins the retained map. A retained id refuses a second erase, `remove`,
  `update`, `link` and `insert` before any statement. Everything else in the deletion unit is unchanged (`seam
  'player.delete.after_erase'` added for the failure proof). `players.remove` (today's hard delete) stays in the
  repository for the unit suite; the server no longer calls it.
- **Excluded from every account reader:** the identity load reads live rows only; the snapshot read
  (`playerSubrecords.mjs readPlayersWithChildren`), the media-queue ownership check (`mediaDeletions.mjs`) and the
  pairing-code import and final-state check (`oneTimeCodes.mjs`) read `deleted_at IS NULL`. The narrow accessors
  `players.retained(id)`, `isRetained(id)`, `retainedRecords()` (by deletion instant, then id) and `retainedCount()`
  serve the deletion unit, the backup, the report and the rollback tool; no route serves a retained record.
- **Snapshots:** `IDENTITY_SNAPSHOT.replace` captures the retained rows before its DELETE, refuses a candidate that
  lists a retained id as a live player (`PLAYER_ID_RETAINED`, ids only) and reinserts the rows byte-identical after the
  candidate; `PLAYERS_RETAINED` (`playersRetained`, table-backed) is read for backups and tools and, when a snapshot
  supplies it, may only ADD records (validated: exactly `{ id, deletedAt, birthDate, country }`, no duplicate, no live id;
  every stored record listed unchanged or the save is refused — the protected contract of §12.4, corrected after the
  review of `6d66655`; the first implementation let a supplied collection replace the stored set).
- **Migration `0014_player_erasure`** (REGISTERED, after 0013): refuses a file in which a `players` row already carries
  `deleted_at` (`UNEXPECTED_SCHEMA`), imports a `playersRetained` blob (a restored backup, a re-upgraded rollback copy)
  or nothing, records `meta.playerErasureCutover` `{ at, imported }`. No table, no column, no foreign key.
- **Backup:** `POST /admin/backup` exports `playersRetained` beside `players` (never inside it) and counts
  `retainedPlayers` in the manifest; a restore imports it through 0014; a tampered backup listing a retained id as a
  live player refuses the boot (`PLAYER_ERASURE_IMPORT_BLOCKED`, the id and no birth date, nothing of 0014 written).
- **Rollback:** `scripts/playerErasureRollback.mjs` / `repositories/playerErasureRollback.mjs` (copy-only; the records
  moved into the `playersRetained` legacy blob; the record and meta key removed; revalidated; refusals leave no
  output); the S6b tool refuses a file carrying 0014 and accepts this tool's output; the re-upgrade imports the blob
  back as the same rows. The erased personal data is restored by nothing.
- **`/capabilities`:** `dataLayer.domains.players.retained` and `deletion`; `safetyAudit.retainedPlayerReferences`
  beside the unchanged Q4 `unresolvedPlayerReferences`.

### 12.2 Where it departs from §D.6, and why

Exactly as §D.6.1 narrowed it: the recruitment name-snapshot replacement of §D.6 item 4 is **not** built (an erasure
extension needing its own authorisation); the step gives a retained record to deletions performed **under the new
behaviour** only (nothing fabricated for earlier ids); no `wasMinorOn` or any age rule; the retained records are
listed by deletion instant then id (rowids are the accounts' creation order, not a fact of the record). The
`guardians.deleted_at` column stays unwritten (no guardian deletion route).

### 12.3 Verification

Node v22.22.0 (SQLite 3.50.4, npm 10.9.4) and Node v24.19.0 (SQLite 3.53.3) in the implementation environment; the
counts, commands, exits and skips of the final tree are in the handoff's `logs/gates-run.txt` and the PR description.

- **Failing-first on the unchanged `d16362f` tree** (the two suites added, no source change): all eight tests fail on a
  concrete assertion — no `players.erase`, no `0014` record, no rollback module, a hard-deleted row, a deletion
  answered 200 under the (then absent) seam (`logs/failing-first-*@d16362f.txt`).
- **`scripts/testPlayerErasure.mjs`** (5 checks): the exact retained row, column by column, from a verified semi-pro
  academy player (placeholders are not previous values); child rows and links gone; every reader and the accessors;
  refusals before any statement; a reopen; an ordinary save, then snapshot-mode saves supplied, supplied twice,
  omitted and through the identity replace — rows byte-identical, revision advanced; a resurrection and every
  malformed `playersRetained` refused atomically with ids only; the under-18 refusal unchanged for live records; the
  stale pairing code refusing the identity-rewriting save until cleared; a unit failing after the writes and at the
  real COMMIT restoring the row, child rows, links, session, queue, code, the same held view object, the held
  `childIds` array, the indexes and an unrelated pending edit, the retry landing once, the ledger row untouched;
  migration 0014 on a 0013 file, on a restored backup, every refusal with nothing written; the rollback copy, its
  refusals, the S6b tool's refusal and acceptance, the chain, the re-upgrade.
- **`scripts/testPlayerErasureServer.mjs`** (3 tests, real server): the two deletion routes, the retained row,
  every reader and authentication path afterwards, the audit rows byte-identical and the Q4 count unchanged, the
  pairing code refused, repeated deletions refused, SIGKILL and restart; the two failure seams (after the erase; the
  real COMMIT) for an adult and a child — 500, everything unchanged, the live session, the retry once; the backup's
  `playersRetained`, the tampered backup refused at boot, the restore, **the danger proven** (the actual `f0abd34`
  build booted directly on a copy of the live file logs the retained row in as a passwordless account), the rollback
  copy booted by the actual `f0abd34` build (`SCOUTBOX_PRE_S4BR_SERVER`: nothing served, a signup and a hard delete
  accepted, the blob kept through its saves and backups) and the re-upgrade with its writes and the retained rows.
- **The existing suites** were adapted where they asserted the pre-S4b-R state (the migration list, the table-backed
  list, the rollback chain starting with the new tool, two assertions that the deleted row is gone); no application
  source was changed to make a suite pass.
- **Both gates** on the final tree with the six historical builds booted for real, and the fresh extraction of the
  handoff, as the milestone rule requires; **not run:** browser suites, the demo rebuild, the route-level E2E battery,
  real older-Node runtimes, real data, real providers.

### 12.4 Correction after the independent review of `6d66655` (21 October 2026; S4b-R still IMPLEMENTED, AWAITING INDEPENDENT ACCEPTANCE)

**The finding (one P2, reproduced two ways by the reviewer's unchanged script — exit 1 on `6d66655`).** `PLAYERS_RETAINED.replace`
treated a supplied `playersRetained` collection like every other snapshot collection: it deleted the stored retained set and
inserted what was supplied. So an ordinary snapshot save with an empty or partial collection erased a deletion record and a
later save could re-create that id as a live account (F1a: the single-save collision check had nothing left to check), and a
same-id record rewrote the stored birth date, country and deletion instant (F1b). The unit suite's snapshot test explicitly
expected the pruning; passing it did not establish the retention invariant.

**The correction** (`repositories/identity.mjs`, `PLAYERS_RETAINED.replace`; the comment in `repositories/index.mjs`): the
contract is PROTECTED. A supplied collection may only add records. Every record the file already holds must be listed with the
same four facts; a stored record that is not listed, or listed with a changed birth date, country or deletion instant, refuses
the whole save (`RETAINED_RECORD_PROTECTED`, ids only — never a date) inside the caller's transaction, so an accompanying
change to any other collection rolls back with it and no transaction stays open. New records are validated as before (shape,
no duplicate, no live id) and inserted; no stored row is deleted or updated by a save; an omitted collection keeps the rows. A
fresh restore and a re-upgraded rollback copy are unaffected: they import through migration 0014, where no stored record
exists yet. The live-id collision check and the identity replace's resurrection refusal are unchanged.

**Tests, written first and failing on the unchanged `6d66655` tree** (`logs/failing-first-unit@6d66655.txt`): the snapshot
test's pruning expectation was corrected to a refusal — its earlier expectation conflicted with preserving retained deletion
facts and was not weakened but reversed — and a dedicated regression covers an empty collection, a subset, a changed birth
date, a changed country and a changed deletion instant (each separately), the two-save prune-then-recreate sequence (refused
at both steps, the id still retained), a direct live-id collision, the rollback of an accompanying `requests` change on
refusal, no open transaction and the tool's loaded view untouched after every refusal, and the positive controls: unchanged,
repeated and omitted saves, and a superset that adds a record with every stored row byte-identical. The copy-only rollback and
re-upgrade controls of §12.3 are unchanged. The reviewer's script, unchanged, reports F1a and F1b CORRECT on the corrected
tree. Scope: no decision reopened or added — the four retained facts and the Founder's two choices stand; no retention period,
correction or purge policy, age rule, foreign key, guardian lifecycle change, personal-data field or migration identifier.
