# M23 — The Production Boot Contract

> A production-read store may be guaranteed either by schema/bootstrap or by an
> owning production module — but the guarantee must be **executable**,
> **deterministic**, and **proven before requests can reach that code**.

The M23 sweep found that 84 of 116 `db.x ??=` collections do not exist after
`runMigrations` alone, and recorded it as a limitation. This document settles
it — not by migrating all 84, which would be a large rewrite justified by no
evidence, but by proving whether the production composition actually guarantees
them.

Everything below is produced by `scripts/m23BootContract.mjs`, which boots the
real server on a database that has been through migrations and nothing else and
then reads back what is actually there. No `??=` line is trusted as evidence of
anything.

---

## 1. Result

```
production-read stores: 124
migration/bootstrap guaranteed: 43
module guaranteed: 80
optional by design: 1
missing after production boot: 0
```

**Three defects were found and fixed** (§5). Before them the same run reported
`missing after production boot: 4`.

## 2. Why module-owned initialisation is a real guarantee here

It is a guarantee because of one property of the composition root, and the
suite asserts that property rather than assuming it:

```
server.mjs  (one synchronous module body)
  const db = buildSeed()
  loadSnapshot()                  ← replaces db wholesale from the snapshot
  runMigrations(db)               ← 43 stores guaranteed here
  integrityReport(db)             ← STORE_MISSING reported, never repaired
  …
  registerM12(…) … registerM23(…) ← 15 registrations, lines 3680–3882
                                    each initialises its own stores
  app.listen(PORT)                ← line 4016, the LAST statement
```

Node finishes evaluating the module body before the socket opens. Every
`register*()` has returned before a single connection is accepted, so a
module-owned store cannot be missing when a request arrives.

Asserted three ways:

| Claim | How it is checked |
|---|---|
| every registration precedes `app.listen` | line numbers in the composition root |
| nothing between them yields to the event loop | no top-level `await` in that range |
| the order actually held in a real process | the **first** request after `/healthz` answers asks the **last**-registered module (M23) for its vocabulary and gets all 19 actions |

## 3. Classification rules

**MIGRATION** — created by a numbered step in `m182/migrations.mjs`. Survives
`loadSnapshot()` wiping the object, so it is the only class that survives an
arbitrary restore.

**MODULE_BOOT** — created by an owning module during synchronous registration,
and **read back from a real booted server**. The suite does not accept a `??=`
line as evidence; a store is in this class only if it was actually present
after the boot.

**OPTIONAL** — a production reader deliberately treats absence as a supported
state *and absence has product meaning*. The bar is explicitly **not** "the
code used `?.`". Exactly one store qualifies:

| Store | Why absence means something |
|---|---|
| `recruitmentOffers` | M23 P4 has not shipped. The journey reports `offer: { available: false }` rather than an empty list — "we cannot answer that yet" is a different statement from "there are none". |

**NOT A STORE** — one name is excluded, with its reason written down:
`db.json`, which is the filename `data/db.json` appearing in string literals.

(Two earlier exclusions, `db.recruitmentJourneys` and `db.squads`, are no longer
needed: they appear only in comments stating that those stores deliberately do
not exist, and the scanner now strips comments before matching. A scanner that
counts a comment as a read reports the opposite of what the comment is there to
establish.)

## 4. Ownership of the 80 module-guaranteed stores

| Owning module | Stores |
|---|---:|
| `m13/shared.mjs` | 26 |
| `m12/shared.mjs` | 15 |
| `server.mjs` | 13 |
| `m14/shared.mjs` | 13 |
| `m16/index.mjs` | 5 |
| `m15/index.mjs` | 5 |
| `m13/delivery.mjs` | 2 |
| `m12/journeys.mjs` | 1 |

Each module keeps its stores in one block that runs at registration. That is
the pattern the three defects below violated.

## 5. Defects found

### B1 — `db.idvQueue` and `db.orgNotes` were created on first write

Both were initialised by `db.x ??= []` **inside a request handler**
(`server.mjs:1162`, `server.mjs:1729`), so they came into existence on
whichever request happened to arrive first, and not before.

Every read of them is guarded, so nothing crashed. What was wrong is subtler
and worse: **a store that appears on first write is invisible to every
boot-time check.** `missingRequiredStores()` cannot report it, the
`STORE_MISSING` log cannot name it, and a restore that dropped it would look
healthy right up until someone filed the first note.

`server.mjs` has no `register()` of its own to hold an init block, so the core
registry is the right home — and it means both now survive `loadSnapshot()`
wiping the object, which is the whole point of D2.

Fixed by `m230_003_core_server_stores_present`; schema **2301 → 2302**.

### B2 — `db.verRootTransfers` was created inside the transfer route

`m14/organisations.mjs:593`. It existed only once somebody had already asked
for a root transfer. Its twelve siblings live in `m14/shared.mjs`; now so does
it.

### B3 — `db.reviewLater` existed only because a sweep happened to run

Nothing initialised it at registration. It was present after boot **by
accident**: `m13/index.mjs` calls `tick()` once synchronously, `tick()` calls
`insightSweep()`, and `insightSweep()` opened with `db.reviewLater ??= []`.

That is a real execution and it did work. But a store whose existence depends
on a sweep having been scheduled is a store that moves the day the sweep is
made lazy, or deferred, or moved behind a feature flag. Its init now sits in
`m13/shared.mjs` with the other twenty-five, and the three `??=` lines that
were scattered through the route handlers are gone.

## 6. §18 — no read-time repair

A `db.x ??=` inside a request handler is not a boot lifecycle; it is a surprise
repair on whichever request arrives first, and it hides the missing store from
every boot-time check.

The suite scans every production file for `db.x ??=` within a request handler
body and fails if it finds one. Five existed before this pass; **zero remain**.

Owning-module initialisation at registration is fine and is the documented
mechanism for 80 stores. The distinction is *when*: registration happens before
the socket opens, a handler happens after.

## 7. §10 — cross-module reads

27 module-owned stores are initialised by one module and read by another —
`db.evidenceSuggestions` is owned by `m13/shared.mjs` and read by
`m17/rooms.mjs` and `m18/secondLook.mjs`; `db.boxAssignments` is owned by
`m16/index.mjs` and read by `m15/passport.mjs` and `m18/secondLook.mjs`.

**The guarantee is not "A registers before B".** Relying on that would be
relying on import order, which the mandate rightly forbids. The guarantee is
that *neither module is reachable until both have registered*, because the
socket opens after all of them. Inter-module ordering therefore does not
matter, and no explicit ordering dependency is required or declared.

The suite asserts the consequence: every cross-module store exists after the
full composition.

## 8. Drift guard

`scripts/m23BootContract.mjs` fails if any `db.X` a production file reads is
not one of: migration-guaranteed, module-boot-guaranteed (proven by the boot),
or explicitly listed as optional with a written reason.

A future `db.newStore.some(...)` therefore cannot land quietly. It will either
be guaranteed, or the suite will name it.

There is **one** inventory: the scan in that script. `PRODUCTION_REQUIRED_STORES`
is the migration registry's own list and is checked for containment against the
M23 journey's declared requirements, not duplicated.

## 9. §13/§14 — the named stores

`db.assessments` — present after migrations alone, present after a full
production boot, and no longer dependent on M12's registration order. The
containment check `JOURNEY_REQUIRED_STORES ⊆ PRODUCTION_REQUIRED_STORES` holds.

The D2 set — `blocks`, `reports`, `moderationLog`, `channels`,
`reputationSeed`, `plans`, `archetypes`, `requests`, `trials`, `assessments` —
all ten present after a full production boot, **all by migration**, none by
module registration. Additionally:

- `plans` returns a populated catalogue, not an empty object (an empty plans
  table silently moves a Grassroots attribution window from 12 months to 18);
- `archetypes` returns its five entries;
- `reputationSeed` returns **empty**, because fabricated scout track records
  would be worse than the bug.

## 10. Boot scenarios

| Scenario | Result |
|---|---|
| **Clean** — bare migrated DB, no seed, no fixture | boots; 0 required stores missing |
| **Old snapshot** — pre-M18.2, no `db.schema` at all | boots; reaches schema 2302; 0 missing; no `STORE_MISSING` in the log |
| **Restart** — boot again on the DB the first boot produced | 0 missing; **no collection mutated**; byte-identical apart from the schema clock and sessions; all 12 steps still recorded exactly once |

The restart check matters on its own: a server that rewrites the database
merely by starting makes every restore non-deterministic.

## 11. The classification table

124 rows. `readers` counts distinct production files that read the store;
`unguarded` counts reads not protected by `??`, `?.` or `Array.isArray`.

| store | class | owner | reader files | unguarded reads |
|---|---|---|---:|---:|
| `apiKeys` | MODULE_BOOT | m13/shared.mjs | 1 | 4 |
| `applications` | MODULE_BOOT | m12/shared.mjs | 4 | 15 |
| `archetypes` | MIGRATION | m182/migrations.mjs | 1 | 1 |
| `assessments` | MIGRATION | m12/shared.mjs | 15 | 36 |
| `assessmentTemplates` | MODULE_BOOT | m12/shared.mjs | 3 | 7 |
| `blocks` | MIGRATION | m182/migrations.mjs | 1 | 8 |
| `boxAssignments` | MODULE_BOOT | m16/index.mjs | 4 | 11 |
| `boxCamCvResults` | MIGRATION | m16/index.mjs | 1 | 3 |
| `boxCamDisputes` | MODULE_BOOT | m16/index.mjs | 1 | 3 |
| `boxCamPrefs` | MODULE_BOOT | m16/index.mjs | 2 | 2 |
| `boxChallengeEntries` | MODULE_BOOT | m16/index.mjs | 3 | 7 |
| `boxChallenges` | MODULE_BOOT | m16/index.mjs | 2 | 6 |
| `boxSessionEvents` | MIGRATION | m16/index.mjs | 0 | 0 |
| `boxSessions` | MIGRATION | m16/index.mjs | 11 | 19 |
| `calibrationSessions` | MODULE_BOOT | m13/shared.mjs | 1 | 6 |
| `campaigns` | MODULE_BOOT | m12/shared.mjs | 1 | 6 |
| `campaignSubmissions` | MODULE_BOOT | m12/shared.mjs | 1 | 7 |
| `channels` | MIGRATION | m182/migrations.mjs | 1 | 18 |
| `coachAffiliations` | MODULE_BOOT | m12/shared.mjs | 2 | 5 |
| `combineAttempts` | MIGRATION | m16/combine.mjs | 8 | 10 |
| `combineRequests` | MIGRATION | m16/combine.mjs | 2 | 11 |
| `coverageAssignments` | MODULE_BOOT | m13/shared.mjs | 1 | 8 |
| `coveragePlans` | MODULE_BOOT | m13/shared.mjs | 2 | 3 |
| `deliveryCallbacksSeen` | MODULE_BOOT | m13/shared.mjs | 1 | 4 |
| `deliveryCentreSince` | MODULE_BOOT | m13/delivery.mjs | 1 | 1 |
| `deliveryFailInject` | MODULE_BOOT | m13/delivery.mjs | 1 | 3 |
| `developmentActions` | MIGRATION | m21/index.mjs | 2 | 4 |
| `developmentEvidenceLinks` | MIGRATION | m21/index.mjs | 2 | 3 |
| `developmentGoals` | MIGRATION | m21/index.mjs | 2 | 6 |
| `developmentPlans` | MIGRATION | m21/index.mjs | 3 | 4 |
| `developmentReviews` | MIGRATION | m21/index.mjs | 3 | 2 |
| `devObjectives` | MODULE_BOOT | m12/shared.mjs | 4 | 10 |
| `dispatches` | MODULE_BOOT | m13/shared.mjs | 2 | 10 |
| `drillGuidance` | MODULE_BOOT | m12/journeys.mjs | 1 | 3 |
| `dynamicWatchlists` | MIGRATION | m182/migrations.mjs | 3 | 4 |
| `emailChallenges` | MODULE_BOOT | server.mjs | 1 | 4 |
| `evidence` | MODULE_BOOT | m12/shared.mjs | 12 | 24 |
| `evidenceSuggestions` | MODULE_BOOT | m13/shared.mjs | 3 | 8 |
| `exposureEvents` | MODULE_BOOT | m13/shared.mjs | 1 | 7 |
| `fixtures` | MODULE_BOOT | m13/shared.mjs | 1 | 2 |
| `followUps` | MODULE_BOOT | m12/shared.mjs | 1 | 10 |
| `friendlies` | MODULE_BOOT | server.mjs | 2 | 3 |
| `groupGrants` | MODULE_BOOT | m13/shared.mjs | 3 | 10 |
| `groups` | MODULE_BOOT | m13/shared.mjs | 2 | 13 |
| `guardians` | MIGRATION | m182/migrations.mjs | 3 | 15 |
| `identityReviews` | MODULE_BOOT | m13/shared.mjs | 1 | 3 |
| `idvQueue` | MIGRATION | m182/migrations.mjs | 1 | 1 |
| `importBatches` | MODULE_BOOT | m13/shared.mjs | 2 | 9 |
| `invoices` | MODULE_BOOT | server.mjs | 2 | 4 |
| `ledger` | MIGRATION | m182/migrations.mjs | 7 | 17 |
| `matchdays` | MODULE_BOOT | server.mjs | 1 | 4 |
| `mediaBlobs` | MODULE_BOOT | server.mjs | 2 | 1 |
| `moderationLog` | MIGRATION | m182/migrations.mjs | 1 | 4 |
| `nobodyMissedReviews` | MIGRATION | m18/index.mjs | 2 | 1 |
| `notificationPrefs` | MIGRATION | m182/migrations.mjs | 1 | 2 |
| `notifications` | MIGRATION | m182/migrations.mjs | 4 | 13 |
| `openTrials` | MODULE_BOOT | server.mjs | 3 | 15 |
| `opportunities` | MODULE_BOOT | m12/shared.mjs | 3 | 13 |
| `opsEvents` | MODULE_BOOT | m13/shared.mjs | 3 | 7 |
| `orgInvites` | MODULE_BOOT | m13/shared.mjs | 1 | 4 |
| `orgNotes` | MIGRATION | m182/migrations.mjs | 1 | 1 |
| `orgs` | MIGRATION | m182/migrations.mjs | 23 | 78 |
| `outbox` | MODULE_BOOT | server.mjs | 3 | 4 |
| `outcomeReports` | MODULE_BOOT | m12/shared.mjs | 3 | 6 |
| `pairingCodes` | MODULE_BOOT | server.mjs | 1 | 5 |
| `passportAchievements` | MODULE_BOOT | m15/index.mjs | 1 | 4 |
| `passportCareerEntries` | MODULE_BOOT | m15/index.mjs | 1 | 3 |
| `passportCorrections` | MODULE_BOOT | m15/index.mjs | 1 | 3 |
| `passportPrefs` | MODULE_BOOT | m15/index.mjs | 2 | 2 |
| `passportShares` | MODULE_BOOT | m15/index.mjs | 2 | 9 |
| `plans` | MIGRATION | m182/migrations.mjs | 1 | 4 |
| `playerPrefs` | MODULE_BOOT | m13/shared.mjs | 1 | 2 |
| `players` | MIGRATION | m182/migrations.mjs | 12 | 33 |
| `playlists` | MODULE_BOOT | m12/shared.mjs | 1 | 3 |
| `prospects` | MODULE_BOOT | m13/shared.mjs | 2 | 7 |
| `pushLog` | MODULE_BOOT | server.mjs | 2 | 3 |
| `pushTokens` | MODULE_BOOT | server.mjs | 2 | 2 |
| `recruitmentBriefs` | MIGRATION | m18/index.mjs | 6 | 1 |
| `recruitmentCases` | MIGRATION | m12/shared.mjs | 14 | 29 |
| `recruitmentOffers` | OPTIONAL |  | 1 | 1 |
| `reports` | MIGRATION | m182/migrations.mjs | 1 | 9 |
| `representations` | MODULE_BOOT | m13/shared.mjs | 4 | 10 |
| `reputationSeed` | MIGRATION | m182/migrations.mjs | 1 | 1 |
| `requests` | MIGRATION | m182/migrations.mjs | 5 | 19 |
| `reviewLater` | MODULE_BOOT | m13/shared.mjs | 2 | 4 |
| `roomComments` | MIGRATION | m17/index.mjs | 1 | 6 |
| `roomDecisions` | MIGRATION | m17/index.mjs | 5 | 5 |
| `roomEvidenceState` | MIGRATION | m17/index.mjs | 1 | 3 |
| `roomSnapshots` | MIGRATION | m17/index.mjs | 2 | 3 |
| `savedSearches` | MODULE_BOOT | server.mjs | 1 | 6 |
| `schema` | MIGRATION | m182/migrations.mjs | 3 | 4 |
| `secondLookItems` | MIGRATION | m18/index.mjs | 3 | 1 |
| `secrets` | MODULE_BOOT | server.mjs | 1 | 2 |
| `sessions` | MIGRATION | server.mjs | 2 | 13 |
| `signings` | MIGRATION | server.mjs | 10 | 16 |
| `sourceChanges` | MIGRATION | m181/sourceChanges.mjs | 1 | 4 |
| `squadInvites` | MODULE_BOOT | m12/shared.mjs | 1 | 6 |
| `ssoConfigs` | MODULE_BOOT | m13/shared.mjs | 1 | 4 |
| `ssoStates` | MODULE_BOOT | m13/shared.mjs | 1 | 2 |
| `supportAccessGrants` | MODULE_BOOT | m13/shared.mjs | 1 | 5 |
| `supportTickets` | MODULE_BOOT | m13/shared.mjs | 1 | 6 |
| `transitionCases` | MODULE_BOOT | m13/shared.mjs | 2 | 8 |
| `trials` | MIGRATION | m182/migrations.mjs | 12 | 25 |
| `uploadSessions` | MODULE_BOOT | m12/shared.mjs | 1 | 3 |
| `users` | MIGRATION | m182/migrations.mjs | 20 | 46 |
| `vacancies` | MODULE_BOOT | m12/shared.mjs | 2 | 7 |
| `verAdmins` | MODULE_BOOT | m14/shared.mjs | 3 | 13 |
| `verClaims` | MODULE_BOOT | m14/shared.mjs | 7 | 21 |
| `verConflicts` | MODULE_BOOT | m14/shared.mjs | 2 | 4 |
| `verDisputes` | MODULE_BOOT | m14/shared.mjs | 2 | 7 |
| `verDomainRequests` | MODULE_BOOT | m14/shared.mjs | 2 | 6 |
| `verEvents` | MODULE_BOOT | m14/shared.mjs | 3 | 4 |
| `verEvidence` | MODULE_BOOT | m14/shared.mjs | 3 | 9 |
| `verMigrated` | MODULE_BOOT | m14/shared.mjs | 1 | 2 |
| `verPlayerInvites` | MODULE_BOOT | m14/shared.mjs | 2 | 4 |
| `verReferences` | MODULE_BOOT | m14/shared.mjs | 5 | 7 |
| `verRootRequests` | MODULE_BOOT | m14/shared.mjs | 2 | 7 |
| `verRootTransfers` | MODULE_BOOT | m14/shared.mjs | 1 | 2 |
| `verTokens` | MODULE_BOOT | m14/shared.mjs | 2 | 4 |
| `videoSegments` | MODULE_BOOT | m12/shared.mjs | 1 | 5 |
| `vouches` | MODULE_BOOT | server.mjs | 4 | 9 |
| `watchlistHistory` | MIGRATION | m182/migrations.mjs | 2 | 4 |
| `webhookDeliveries` | MODULE_BOOT | m13/shared.mjs | 2 | 4 |
| `webhookEndpoints` | MODULE_BOOT | m13/shared.mjs | 1 | 7 |
