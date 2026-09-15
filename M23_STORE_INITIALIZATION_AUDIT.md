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

## 7. Residual limitation

Four stores outside the recruitment and safeguarding paths remain seed-created
with no migration: they did not appear in the scan's "not guaranteed" set
because each already has a module-level default that runs after
`loadSnapshot()`. They are safe today by that default rather than by the
registry, which is a weaker guarantee than the one this pass establishes.

Recorded rather than changed: widening a persistence fix into every remaining
module default would be the over-broad refactor §22 forbids, and the
`STORE_MISSING` integrity check now makes any future regression visible at boot
rather than at the first request.
