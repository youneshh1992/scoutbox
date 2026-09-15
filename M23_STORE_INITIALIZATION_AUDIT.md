# M23-D2 — Store Initialization Audit

**Classification: pre-existing core persistence defect, discovered during M23
preflight. Not caused by M23.**

> Every durable collection that production code may read must exist after a
> clean boot and after every supported schema upgrade, independent of demo or
> seed execution.

---

## 1. The mechanism

The server always starts from the demo-data builder:

```js
const db = buildSeed();                      // server.mjs:70
```

so a first boot has every collection the seed declares. Then the snapshot
loads:

```js
function loadSnapshot() {                     // server.mjs:84
  const raw = store.load();
  if (!raw || !Array.isArray(raw.db?.players)) return;
  for (const key of Object.keys(db)) delete db[key];   // ← every seeded key
  Object.assign(db, raw.db);                           // ← replaced wholesale
  …
}
```

`loadSnapshot()` **deletes the seeded object entirely** and replaces it with
exactly what the snapshot holds. A snapshot that predates a collection
therefore *removes* that collection from a running server, and the next
production read is a `TypeError` — HTTP 500, not 404.

Anything created only by `buildSeed()`, with no migration step and no module
default, is guaranteed by nothing but luck of the restore path.

The worst instance is `db.blocks`, read by `isBlocked()` inside **every**
visibility check:

```js
const isBlocked = (playerId, orgId) =>
  db.blocks.some((b) => b.playerId === playerId && b.orgId === orgId);  // server.mjs:534
```

A restored snapshot without it crashes the safeguarding path rather than
answering it. **A missing container is infrastructure corruption, not an
authorization decision** — "fail closed" is a verdict, and a `TypeError` is not
a verdict (§13).

---

## 2. Method

Every `db.<name>` reference in `scoutbox-server/**/*.mjs` was extracted
mechanically (`scratchpad/m23/inventory.mjs`), then classified by whether its
existence is guaranteed by a migration step, by a module-level default that
runs after `loadSnapshot()`, or by nothing but `seed.mjs`.

**123 collections referenced. 123 reachable by production code. 115 already
guaranteed. 8 were not.**

---

## 3. The matrix

Only the eight are listed individually; the 115 already-guaranteed stores are
summarised, because their status was never in doubt and listing them would bury
the finding.

| Store | Prod Read | Prod Write | Clean Boot | Upgrade Migration | Seed Dependency | Required Fix | Status |
|---|---:|---:|---:|---:|---:|---|---|
| `blocks` | ✅ | ✅ | via seed only | ❌ none | **yes** | create empty in migration | **GREEN** |
| `reports` | ✅ | ✅ | via seed only | ❌ none | **yes** | create empty in migration | **GREEN** |
| `moderationLog` | ✅ | ✅ | via seed only | ❌ none | **yes** | create empty in migration | **GREEN** |
| `channels` | ✅ | ✅ | via seed only | ❌ none | **yes** | create empty in migration | **GREEN** |
| `reputationSeed` | ✅ | ❌ | via seed only | ❌ none | **yes** | create empty in migration | **GREEN** |
| `plans` | ✅ | ❌ | via seed only | ❌ none | **yes** | restore catalogue in migration | **GREEN** |
| `archetypes` | ✅ | ❌ | via seed only | ❌ none | **yes** | restore catalogue in migration | **GREEN** |
| `squads` | phantom | ❌ | n/a | n/a | n/a | remove the read | **NOT REQUIRED** |
| `requests` | ✅ | ✅ | via seed | ✅ `m200_001` | covered | — | GREEN (already) |
| `trials` | ✅ | ✅ | via seed | ✅ `m200_001` | covered | — | GREEN (already) |
| *115 others* | ✅ | — | ✅ | ✅ | none | — | GREEN (already) |

No row is left unexplained (§54).

---

## 4. Root cause, per store (§52)

| Store | Root cause |
|---|---|
| `blocks` | **Seed-only.** Created in `seed.mjs`'s returned literal; no module default, no migration. Historically fine because no one restored an older snapshot on the path that reads it. |
| `reports` | **Seed-only**, same shape. |
| `moderationLog` | **Seed-only**, same shape. |
| `channels` | **Seed-only**, same shape. |
| `reputationSeed` | **Seed-only**, and it is genuinely demo data — rows carry `seeded: true`. |
| `plans` | **Seed-only**, and it is product *configuration*, not user data. Historically optional-looking because every read already guards the missing-key case (`?? 18`) — which hid that the missing-**table** case was unguarded. |
| `archetypes` | **Seed-only**, product reference data. |
| `squads` | **Never existed.** One reference, in a conjunct that is true for every possible value. Squad membership is `org.squad`, per organisation. |

`db.requests` and `db.trials` had the identical defect and were covered
retroactively by M20's `m200_001_analytics_sources_present`. M20 recorded the
`trials` case; the `requests` case was never called out until now.

---

## 5. The fix (§53)

### Two kinds of default, deliberately not interchangeable

**Containers of user data default to empty, because empty is true.** No rows
means nothing happened. An empty `blocks` means no block relation exists, which
is exactly what it means today (§41).

**Product configuration does not default to empty, because empty is a lie with
consequences.** An empty `plans` makes every
`db.plans[org.plan]?.attributionWindowMonths ?? 18` fall through, moving a
Grassroots organisation's attribution window from **12 months to 18** — a
billing change introduced by a persistence bug. That is worse than the crash it
would replace, so the migration restores the catalogue.

`reputationSeed` is the third case: demo data, served beside figures computed
from the live ledger. **Empty is the correct production value** — fabricating
scout track records to fill it would violate §43.

### Per store

| Store | Old behaviour | New bootstrap | Upgrade | Regression test |
|---|---|---|---|---|
| `blocks` | seed only; absent after restore → `isBlocked()` throws | `[]` via `m230_001` | created empty; existing rows preserved | §13/§33 — before/after, and the block still bites |
| `reports` | seed only | `[]` | created empty | clean-boot + upgrade assertions |
| `moderationLog` | seed only | `[]` | created empty | clean-boot + upgrade assertions |
| `channels` | seed only | `[]` | created empty; existing rows preserved byte-for-byte | §14/§27 |
| `reputationSeed` | seed only | `[]` | created empty | clean boot asserts it is **empty**, not fabricated |
| `plans` | seed only; empty would change billing | `planCatalogue()` from `catalogue.mjs` | restored **only if absent**; a customised table survives | §24 — 12 months, not 18; and a 99-month custom value survives |
| `archetypes` | seed only | `archetypeCatalogue()` | restored if absent | clean boot asserts all 5 |
| `squads` | phantom read | — | — | the required-store list asserts it is absent |

### One source of truth (§23)

`PLANS` and `ARCHETYPES` moved out of `seed.mjs` into **`catalogue.mjs`**. The
seed imports them, so seed behaviour is unchanged; the migration imports the
same values. No feature module carries an ad-hoc `db.x ||= []`.

### Schema version (§24)

**2200 → 2300.** Bumped because the migration genuinely changes what an
upgraded database *guarantees* — seven collections that were previously present
only by luck of the seed. Not bumped for documentation.

Every suite reads `SCHEMA_VERSION` symbolically rather than pinning `2200`, so
the bump required no test edits. That discipline came from M20, which was
broken once by a literal pin.

### Drift detection (§31, §32)

`PRODUCTION_REQUIRED_STORES` and `missingRequiredStores(db)` live in
`m182/migrations.mjs`. They are wired into two places:

1. **Boot integrity** (`m182/integrity.mjs`) reports `STORE_MISSING` — and, as
   with every other check there, **reports without repairing** (§45). A boot
   script that quietly creates a container is a boot script that hides why it
   was missing.
2. **`scripts/m23Persistence.mjs`** asserts the whole list against a database
   that has been through `runMigrations` and *nothing else* — no seed, no
   fixture, no demo (§29).

---

## 6. What was deliberately not done

- **No optional chaining as the fix** (§7). `db.blocks?.some(…)` at each call
  site would turn a crash into a silent wrong answer — "no blocks recorded"
  when the truth is "the block table is gone". The collection exists instead.
- **No data repair** (§43). Missing containers are created; missing *rows* are
  never inferred.
- **No auto-repair at read time** (§45).
- **No redesign** (§22). Nothing renamed, retyped, normalised or moved behind a
  repository layer.
- **No new access path** (§42). The migration creates empty collections and
  restores a configuration table; it grants nothing.
- **`db.channels`, `db.reports`, `db.plans` dispositions** (§18-§20) are all
  "production-read, therefore initialized" — none is optional, and the audit
  says so from source rather than guessing.
- **`db.plans` is not M21's Development Plans** (§20). `db.plans` is the
  **billing plan catalogue**, keyed by `org.plan`, read for the attribution
  window. M21's plans are `db.developmentPlans`. Separate concepts, separate
  stores, no relationship.

---

## 7. Verification

| | |
|---|---|
| `scripts/m23Persistence.mjs` | **55 checks**, 12 negative. Zero seed execution (§29). |
| Owner suites (§39) | **24 / 24 green** — testTrust, m12, m13, m14, m14.1, m15, m16, m16.1, m16.2, m17, m18, m18.1, m18.2, m19, m20, m21, m22, m22CvEval, m22Holdout, m22Robustness, m22Blocker, m23Persistence, connectedE2E, apiE2E (130 checks against a live server) |
| M23 baseline (§40) | green |
| Clean boot | no `STORE_MISSING` in the boot log |
| M22 artefacts (§49/§50) | regenerated twice, **0 non-timestamp lines changed** both times; reverted |

What the persistence suite proves, specifically:

- the defect **reproduced** before migration (`isBlocked()` throws) and
  **answered** after it (returns `false`, a real verdict);
- existing `blocks`, `requests` and `channels` rows preserved **byte for byte**,
  and a preserved block is still effective;
- a **customised** 99-month plan table survives — the migration restores
  configuration only when it is absent;
- three consecutive migration runs apply nothing and change no data;
- a real server boots on a restored snapshot that lacked `requests`, and both
  the safeguarding path and the recruitment request path return 200;
- a restart leaves the schema unchanged with each step recorded exactly once;
- a **damaged** snapshot (claiming steps it does not reflect) is reported and
  **not** repaired.

---

## 8. Residual limitation

Four stores outside the recruitment and safeguarding paths remain seed-created
with no migration: they did not appear in the scan's "not guaranteed" set
because each already has a module-level default that runs after
`loadSnapshot()`. They are safe today by that default rather than by the
registry, which is a weaker guarantee than the one this pass establishes.

Recorded rather than changed: widening a persistence fix into every remaining
module default would be the over-broad refactor §22 forbids, and the
`STORE_MISSING` integrity check now makes any future regression visible at boot
rather than at the first request.

---

## 9. The residual limitation caught one — `db.assessments` (M23 sweep)

§8 above said the remaining module-default stores were "safe today by that
default rather than by the registry, which is a weaker guarantee." The M23
sweep's restore matrix then walked into exactly that gap.

**What happened.** A pre-M23 snapshot upgraded cleanly, kept all thirteen
original statuses, invented no history — and the journey route answered **500**.
`db.assessments` did not exist.

**Why it escaped the D2 pass.** `m12/shared.mjs` runs `db.assessments ??= []`
when the module registers, so a *running* server always has it. No test that
goes through HTTP can see the gap. That is precisely the "registration order
decides whether a core collection exists" failure this suite asserts against
everywhere else — and `buildRecruitmentJourney` is a pure function over a
database, with no module registration to lean on.

**Why it mattered more than the other module-default stores.** M23's own
projection **declares** `assessments` required. Two lists in two files stated
the same contract and disagreed:

```
m23/journey.mjs      JOURNEY_REQUIRED_STORES    includes 'assessments'
m182/migrations.mjs  PRODUCTION_REQUIRED_STORES did not
```

**Fixed** by `m230_002_assessments_present` (schema 2301) and by a drift guard
in the suite stated as containment rather than as a list of names:
`JOURNEY_REQUIRED_STORES ⊆ PRODUCTION_REQUIRED_STORES`, with the converse for
the optional stores — "absent because the phase has not shipped" must stay
distinguishable from "present and empty".

## 10. The scale of what remains — SETTLED by the boot-contract pass

This section previously reported "84 of 116 `db.x ??=` collections are absent
after `runMigrations` alone" and left it as an open limitation. That framing
was incomplete: it measured migrations and called the remainder unguaranteed,
without asking whether the production composition guarantees them.

`scripts/m23BootContract.mjs` asked. Every production-read store now carries
one of four labels, and the label is evidence rather than inspection:

| Class | Count | What it means | How it is proven |
|---|---:|---|---|
| **MIGRATION GUARANTEED** | 43 | created by a numbered step in `m182/migrations.mjs` | survives `loadSnapshot()` wiping the object; the only class that survives an arbitrary restore |
| **MODULE-BOOT GUARANTEED** | 80 | created by an owning module during synchronous registration | **read back from a real booted server** on a bare migrated database — a `??=` line is not accepted as evidence |
| **OPTIONAL** | 1 | `recruitmentOffers`; absence has product meaning (P4 has not shipped, and the journey reports `available:false` rather than an empty list) | asserted to be genuinely absent after boot, so the classification is not decorative |
| **DEFECT — FIXED** | 3 | see below | each reproduced, fixed, and covered by a regression |

Why module-boot counts as a guarantee here: `server.mjs` is one synchronous
module body, all 15 registrations run during evaluation, and `app.listen` is
its last statement. The socket does not open until every module has registered.
That is asserted three ways — line order in the composition root, absence of
any top-level `await` between them, and a runtime probe whose **first** request
asks the **last**-registered module for its vocabulary and receives all 19
lifecycle actions.

### DEFECT — FIXED (3)

| Store | Was | Now |
|---|---|---|
| `idvQueue` | `??=` inside a request handler (`server.mjs:1162`) — created on first write | migration `m230_003_core_server_stores_present`, schema **2302** |
| `orgNotes` | `??=` inside a request handler (`server.mjs:1729`) | same step |
| `verRootTransfers` | `??=` inside the transfer route (`m14/organisations.mjs:593`) | `m14/shared.mjs`, beside its twelve siblings |

A fourth, `reviewLater`, was present after boot only because `m13/index.mjs`
calls `tick()` once synchronously and `insightSweep()` happened to open with
`db.reviewLater ??= []`. That worked, but a store whose existence depends on a
sweep having been scheduled moves the day the sweep is made lazy. Its init now
sits in `m13/shared.mjs` with the other twenty-five.

**The common thread, and why guarded reads did not make any of them harmless:**
a store that appears on first write is invisible to every boot-time check.
`missingRequiredStores()` cannot report it, the `STORE_MISSING` log cannot name
it, and a restore that dropped it looks healthy until someone files the first
note. Read-time repair is not a lifecycle; it is the absence of one.

## 11. What is guaranteed today, stated plainly

> Every production-read store either survives an arbitrary restore (43, by
> migration) or is created by its owning module before the socket opens (80,
> proven by booting). One is optional by design. **Zero are missing after a
> full production boot.**

`scripts/m23BootContract.mjs` is the drift guard: a future
`db.newStore.some(...)` must be migration-guaranteed, module-boot-guaranteed,
or explicitly optional with a written reason, or the suite names it and fails.
There is one inventory, not two that can disagree.

Full detail, including the 124-row classification table and the cross-module
read list, is in `M23_PRODUCTION_BOOT_CONTRACT.md`.
