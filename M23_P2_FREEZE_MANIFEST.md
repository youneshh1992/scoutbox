# M23 P2 — Freeze Manifest

**The one authoritative record of what P2 is, at the tip it was frozen at.**

Where any earlier M23 document disagrees with this one about a number, this
one is current and that one is history. Earlier reports are not rewritten —
they record what was known when they were written, and several of them are
worth more for that than for their arithmetic.

**Status: P2 FROZEN. Contact has not begun.**

---

## 1. The tip

| | |
|---|---|
| Branch | `claude/desktop-project-migration-wyk3ec` |
| Content tip | `e80d36ec39e2bfb8ef01e2567dfd9337eb2e95f6` |
| Commits ahead of `origin/claude/desktop-project-migration-wyk3ec` | **159** |
| Schema version | **2302**, 12 migration steps |
| Working tree at bundle time | clean; nothing untracked tracked |

The five commits of this freeze pass:

| Commit | What it closed |
|---|---|
| `8e8d0a3` | §2–§8 — the m18E2E `changeCount` flake, at the writer |
| `213b980` | §9–§15 — one machine-readable store contract, checked against a running server |
| `7605e75` | §16–§17 — dead-code and stale-comment sweep |
| `e80d36e` | §18 — documents made to agree with the repository |
| *(this file)* | §19 — the freeze manifest |

## 2. The recovery bundle

| | |
|---|---|
| Path | `/home/user/scoutbox-m23-p2-freeze.bundle` |
| Taken at | `e80d36ec39e2bfb8ef01e2567dfd9337eb2e95f6` |
| Size | **3,426,005 bytes** |
| SHA-256 | `b5399fdfcdb03f302307b761b40eac8b3c7ae3d12d8f8f4136f761909cd24fba` |
| Contents | `--all` — 5 refs, including `main` and both origin remotes |

```
$ git bundle verify /home/user/scoutbox-m23-p2-freeze.bundle
The bundle records a complete history.
```

A complete history, not an incremental pack that needs a prerequisite the
recovering machine may not have.

**A file cannot contain its own checksum.** The bundle is taken at the last
*content* commit; this manifest is the commit after it, and describes the
artefact on disk exactly. Re-derive both values with `sha256sum` and
`git bundle verify` at any time. The previous checkpoint's bundle
(`scoutbox-m23-p2.bundle`, tip `95572fa`, 154 commits) is now a record of a
previous checkpoint, not of the current tip.

## 3. Verification from the bundle — not from the working tree

Everything in §4 and §5 was run in `/home/user/freeze-check`, a fresh clone
**of the bundle file**, in a directory that has never been the working tree.
Dependencies installed from `package.json` (70 packages); nothing copied
across.

```
restored HEAD : e80d36ec39e2bfb8ef01e2567dfd9337eb2e95f6
source tip    : e80d36ec39e2bfb8ef01e2567dfd9337eb2e95f6
                HEAD MATCHES SOURCE TIP

source tree   : fe821546fd053757ae85d6e83c185440519c62f1
restored tree : fe821546fd053757ae85d6e83c185440519c62f1
                TREE HASHES IDENTICAL
```

The tree-hash comparison is the stronger statement: not merely the same
commit id, but byte-identical content across every tracked file.

## 4. The battery, run from the restored clone

**23 offline suites, 4,393 checks, 0 failures.** Every process exited 0.

| Suite | Checks |
|---|---:|
| `testTrust` | 23 |
| `m12E2E` | 147 |
| `m13E2E` | 212 |
| `m14E2E` | 193 |
| `m141E2E` | 94 |
| `m15E2E` | 185 |
| `m16E2E` | 118 |
| `m161E2E` | 79 |
| `m162E2E` | 124 |
| `m17E2E` | 515 |
| `m18E2E` | 287 |
| `m181E2E` | 196 |
| `m182E2E` | 334 |
| `m19E2E` | 373 |
| `m20E2E` | 259 |
| `m21E2E` | 514 |
| `m22E2E` | 112 |
| `m22Robustness` | 48 |
| `m22Blocker` | 60 |
| `m23E2E` | **349** (70% negative) |
| `m23Persistence` | 67 |
| `m23BootContract` | **61** (70% negative) |
| `connectedE2E` | 43 |

`m22CvEval` and `m22Holdout` ran to completion and regenerate artefacts rather
than print a check count.

Plus, against a live server booted from the restored clone:

| | Checks |
|---|---:|
| `apiE2E` | **130**, 0 failures |

**4,523 checks from the bundle, 0 failures.** With the browser suite in §5,
**4,560**.

> One standing note on `apiE2E`: its "snapshot persisted" check reads
> `<server-dir>/data/scoutbox.db` by construction, so it must be run against a
> server using the **default** data directory. Pointed at a server with
> `DATA_DIR` overridden it reports that one check as a failure — a harness
> assumption about where to look, not a product defect. Run as designed,
> 130/130.

### Restored server boot

```
{"ok":true,"uptimeS":5,"schemaVersion":2302}

schema 0 → 2302, twelve steps applied in order
no STORE_MISSING, no INTEGRITY violation in the boot log
```

Stopped cleanly afterwards; no listener left on any test port (4000, 4001,
4006, 4017, 4018, 4020, 4023, 4055, 4056, 8099, 8701, 8702, 8723).

## 5. What the bundle cannot verify, stated rather than glossed

`e2e/m23Live.test.mjs` — the real-browser suite, 37 checks including a real
login — needs built client bundles. Those builds are untracked by design, so
they are not in the git bundle and the suite cannot run from a bundle clone
without first building four client apps.

It was therefore run **in the working tree at this same tip**:

```
m23Live: 37 checks passed — P2 sweep corrections verified end to end
```

This is a real gap in what "verified from the bundle" covers, and naming it is
worth more than quietly folding the number into §4.

## 6. The production store contract

| | |
|---|---|
| Production-read stores | **123** |
| Migration-guaranteed | **42** |
| Module-boot-guaranteed | **80** |
| Optional by design | **1** (`recruitmentOffers`) |
| Missing after a full production boot | **0** |
| Not stores, recorded as such | `schema`, `json` |

The contract lives in `scoutbox-server/storeContract.mjs` as
`{ guarantee, owner, reason }` per store. `PRODUCTION_REQUIRED_STORES` in
`m182/migrations.mjs` is **derived** from it, not kept by hand. There is one
inventory, not two that can disagree.

**Every line of it is treated as a claim, not as evidence.** `m23BootContract`
boots a real server on a migrated-only database and checks:

- the declared set equals the scanned set, **in both directions** — a store
  declared but never read fails too;
- `guarantee: 'migration'` ⟹ the store exists after `runMigrations` alone;
- `guarantee: 'module'` ⟹ it does **not** exist after migrations alone, so an
  over-claim cannot hide;
- `owner: 'm14'` ⟹ a file under `m14/` actually initialises it;
- `guarantee: 'optional'` ⟹ it is genuinely absent after boot.

The drift guard was proved by breaking it: an undeclared store injected into
the scan turned four assertions red.

Full detail: `M23_PRODUCTION_BOOT_CONTRACT.md`.

## 7. `M23-P2-FLAKE-CLOSED`

The m18E2E `changeCount` intermittent failure is closed, **as a product
defect**, not as a test flake.

`newEvidence` in `m12/passport.mjs` read `Date.now()` three times while
building one record. When the millisecond ticked between the first two reads,
`reviewedAt` landed 1ms after `recordedAt`, and a brand-new upload was reported
as *an upgrade of itself*. A club was told its evidence had improved when
nothing had been reviewed.

Reproduced deliberately (`scripts/m18FlakeProbe.mjs`, run 30 of 50, fresh
database and process per run, fingerprint-level diagnostics). Fixed at the
writer: one clock read per event.

Exit gate, all of it:

| §8 requirement | Result |
|---|---|
| Root cause identified | yes — named above, with the reproduction output |
| Regression added | two, at two levels: `m12E2E` at the owner (deterministic), `m18E2E` as an invariant over fingerprints |
| 100 consecutive targeted runs | **100 / 100 clean** |
| 20 consecutive full `m18E2E` runs | **20 / 20 clean** |
| No retry, sleep, raised timeout, weakened count, quarantine | none used |

Full write-up: **B6** in `M23_P2_FINAL_DEFECT_REGISTER.md`.

## 8. Dead code and comments

Seven exports had no caller outside their own module. **Six were not dead** —
read internally and asserted by the acceptance suite, which is a caller. One,
`LIFECYCLE_INITIAL`, was genuinely unreferenced, and deleting it was the wrong
repair: the value existed in three places and was read at none, so it was
disconnected rather than stale. It now lives in `m17/shared.mjs` as
`INITIAL_ROOM_STATUS` beside the status set that owns it, both room-creation
sites read it, and M23 keeps an alias. Zero `status: 'watching'` literals
remain.

`LIFECYCLE_PRECONDITIONS` was kept but un-exported: an exported alias of the
one real table reads like a second precondition table, which is exactly defect
D3.

No `TODO`, `FIXME`, `HACK` or `XXX` marker exists in any M23-touched file. The
only textual hits are a seed identity named `HACK` in `m12E2E` and three lines
of lifecycle prose that use "placeholder" and "not implemented" to describe
deliberate behaviour.

## 9. What P2 is

| | |
|---|---|
| Lifecycle states | **18**, 4 terminal, 3 reopenable, `on_hold` open |
| Semantic actions | **19** |
| Lifecycle reason codes | **16**, sharing **zero** codes with M17's 20 decision codes |
| Canonical record | `db.recruitmentCases`. A Room is a facet of a case, not a second pipeline |
| Authority direction | `room.status` → `case.stage`, one way, written by `applyStatus()` alone |
| Journey | a projection. There is no `db.recruitmentJourneys` |
| New stores | none. `migrateM23` is empty |
| Evidence preconditions | keyed by **target** status, so every inbound edge carries the identical burden |
| Evidence provider | injected, **fails closed** — no provider means an unmet requirement |

## 10. Deliberately not in P2

- **Contact.** Not begun. `M23_CONTACT_CONTRACT.md` states what P3 must hold to.
- **Lifecycle events and notifications.** Nothing to notify until a share
  boundary exists; emitting internal stage changes with no entitled audience
  would be worse than silence.
- **Atomicity failure injection.** Status, history and rev are one synchronous
  write against one in-memory object, persisted in one SQLite transaction. A
  harness here would test `store.save`, which `m182E2E` already covers.
- **Client UI.** Two org routes; no client surface in P2.

## 11. Durability — the honest limit

This bundle is a **verified recovery artefact**. It is **not an off-machine
backup**.

It sits at `/home/user/scoutbox-m23-p2-freeze.bundle` inside an ephemeral
container filesystem. The container is reclaimed after inactivity or when the
session ends, and the bundle goes with it. What is proven is that *this file,
now*, restores to a clone whose tree hash equals the source tree and whose full
battery passes — **not** that the work survives the machine.

The only durable protection for **159 unpushed commits** is a push to a remote,
which this task does not authorise. Until then the bundle protects against a
working-tree accident, not against losing the container.
