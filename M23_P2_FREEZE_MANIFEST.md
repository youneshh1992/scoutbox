# M23 P2 — Freeze Manifest

**The one authoritative record of what P2 is, at the tip it was frozen at.**

Where any earlier M23 document disagrees with this one about a number, this
one is current and that one is history. Earlier reports are not rewritten —
they record what was known when they were written, and several of them are
worth more for that than for their arithmetic.

**Status: P2 FROZEN, BUILDABLE, BROWSER-VERIFIED AND RECOVERABLE.
Contact has not begun.**

---

## 1. The tip

| | |
|---|---|
| Branch | `claude/desktop-project-migration-wyk3ec` |
| Content tip | `f1930cf1943f342bc01776c2a61abb4e957fbc74` |
| Commits ahead of `origin/…-wyk3ec` | **163** |
| Schema version | **2302**, 12 migration steps |
| Lifecycle states | **18** — 4 terminal, 3 reopenable, `on_hold` open |
| Semantic actions | **19** |
| Lifecycle reason codes | **16**, sharing zero codes with M17's 20 decision codes |

The closure pass, in order:

| Commit | What it closed |
|---|---|
| `2480a3b` | §26–§36 — one error table, nothing internal in the body, refusals that name themselves |
| `e75d5d6` | §3–§25, §37–§48 — bundle→build→browser, EN/FR labels, order independence |
| `f1930cf` | §66 — F1–F4 appended to the defect register |

## 2. The final bundle

| | |
|---|---|
| Path | `/home/user/scoutbox-m23-p2-final.bundle` |
| Taken at | `f1930cf1943f342bc01776c2a61abb4e957fbc74` |
| Size | **3,426,513 bytes** (3.3 MB) |
| SHA-256 | `c02b51fb8977454d39a1e76a4f36bb645fe66d5f7585e84e26bb8db4c1b57560` |
| Contents | `--all` — 5 refs, including `main` and both origin remotes |
| `git bundle verify` | **"The bundle records a complete history."** |

A complete history, not an incremental pack needing a prerequisite the
recovering machine may not have.

**A file cannot contain its own checksum.** The bundle is taken at the last
*content* commit; this manifest is the commit after it and describes the
artefact on disk exactly. Re-derive at any time:

```
sha256sum      /home/user/scoutbox-m23-p2-final.bundle
git bundle verify /home/user/scoutbox-m23-p2-final.bundle
```

Superseded and now historical: `scoutbox-m23-p2.bundle` (tip `95572fa`, 154
commits) and `scoutbox-m23-p2-freeze.bundle` (tip `e80d36e`, 159 commits).

## 3. Recovery, proven all the way to the browser

Everything in §4 ran in `/home/user/final-check`, a fresh clone **of the
bundle file**, in a directory that has never been the working tree.
Dependencies installed from each `package.json`; nothing copied across.

```
restored HEAD : f1930cf1943f342bc01776c2a61abb4e957fbc74
source tip    : f1930cf1943f342bc01776c2a61abb4e957fbc74
restored tree : 7c96bda8c26f6b8706bd0fc27fefb32aa62d8305
source tree   : 7c96bda8c26f6b8706bd0fc27fefb32aa62d8305
                TREE HASHES IDENTICAL
```

The tree-hash comparison is the stronger statement: not merely the same commit
id, but byte-identical content across every tracked file.

### The gap the previous manifest named is closed

That manifest said, correctly, that `m23Live` could not run from a bundle
clone because it needs built client bundles and those are untracked. **It can,
and it does.** The suite runs `vite build` itself, from source, so the only
thing ever missing was `npm install`. From the restored clone:

```
build OK scoutbox-club / scoutbox-grassroots / scoutbox-admin
m23Live rc=0   39 checks passed
```

Nothing was copied from any working tree, and no clone was hand-patched.

## 4. The final fresh clone, end to end

| Stage | Result |
|---|---|
| install | 6/6 packages (`scoutbox-server`, `e2e`, 4 clients) |
| typechecks | **4/4** — club, grassroots, admin, player |
| production builds | **3/3** vite builds; player is Expo (no web build target) and typechecks |
| server suites | **23 suites, 0 failures, 4,424 checks** |
| `apiE2E` | **130 checks**, against a server the script started and stopped |
| **`m23Live`** | **39 checks, rc=0** — real browser, real login, client built from source |
| live smoke | `m17Live` 25, `m18Live` 60, `navLive` 30 — all rc=0 |
| processes after | none surviving; zero listeners on any test port |

**4,708 checks from the bundle, 0 failures**, of which 154 are browser-driven.

Boot from the restored clone: `{"ok":true,"schemaVersion":2302}`, schema
0 → 2302, twelve steps, no `STORE_MISSING`, no `INTEGRITY` violation.

## 5. Browser / live inventory

Discovered mechanically, not from a remembered list. Full classification —
host ownership, client builds, ports, per-suite status — in
`M23_P2_BROWSER_INVENTORY.md`.

```
browser/live suites discovered : 35   (33 suites + 2 non-suite probes)
applicable                     : 33
run                            : 33
passed                         : 33
failed                         : 0
skipped as inapplicable        : 2    (staleSessionProbe, connCheck.tmp — probes with no pass/fail contract)
```

Every milestone M12→M23 still has a live suite that runs and passes. Every
Live suite owns its own host and its own `mkdtemp` data directory, so no suite
can seed another's database. **No harness anywhere skips checks on a failed
host** — verified by squatting `m23Live`'s static port, which produces
`EADDRINUSE`, exit 1, and zero checks reported.

## 6. Test-order independence

Six deterministic orderings, each from clean process and port state:

| Order | Shape |
|---|---|
| A | declared order |
| B | full reverse |
| C | M23 first, legacy after |
| D, E, F | three further fixed interleavings |

| Suite | A | B | C | D | E | F |
|---|---:|---:|---:|---:|---:|---:|
| `m17E2E` | 515 | 515 | 515 | 515 | 515 | 515 |
| `m18E2E` | 287 | 287 | 287 | 287 | 287 | 287 |
| `m182E2E` | 334 | 334 | 334 | 334 | 334 | 334 |
| `m20E2E` | 259 | 259 | 259 | 259 | 259 | 259 |
| `m23Persistence` | 67 | 67 | 67 | 67 | 67 | 67 |
| `m23BootContract` | 61 | 61 | 61 | 61 | 61 | 61 |
| `m23E2E` | 380 | 380 | 380 | 380 | 380 | 380 |

**Identical in all six, rc=0 in all six.** The historical `m182E2E` 330/333
nondeterminism does not recur: 334, every time. Key suites therefore ran six
times each, well past §48's "twice".

## 7. The error contract

`scoutbox-server/m23/errors.mjs` — 21 domain codes, one table, **no default**.
It replaced two ternary chains whose trailing `: 400` silently absorbed any
code nobody had mapped. Full detail in `M23_ERROR_CONTRACT.md`.

| Band | Codes |
|---:|---|
| 400 | 7 — the request is wrong and the caller can fix it |
| 403 | 1 — not yours to do, in any state |
| 404 | 3 — concealment: hidden, foreign and absent are one answer |
| 409 | 4 — the request is fine; the case is not where you thought |
| 422 | 1 — request and case fine; the evidence is not there |
| 500 | 5 — this build or its data is wrong. Never the caller's to fix |

Enforced by `m23E2E` group **Y** (16 checks), whose drift guard is mechanical:
it extracts every `error: 'CODE'` literal from the M23 source files themselves
(20 found) and requires a status for each — including `LIFECYCLE_INTERNAL`,
the code that exists to report drift.

Privacy: every 500 answers with the code and a fixed message. `Y7` proves the
projector still names the absent stores internally (so the log is worth
reading); `Y8` proves the client body names none of them. `Y12`/`Y13` prove a
hidden case and a case that never existed answer 404 with **byte-identical**
bodies.

## 8. `M23-P2-FLAKE-CLOSED`

The m18E2E `changeCount` failure was a **product** defect: `newEvidence` read
`Date.now()` three times for one record, so `reviewedAt` could land 1 ms after
`recordedAt` and a brand-new upload was reported as an upgrade of itself.
Fixed at the writer — one clock read per event. 100/100 targeted runs and
20/20 full runs clean, with regressions at two levels. No retry, sleep, raised
timeout, weakened count or quarantine. Full write-up: **B6** in the defect
register.

## 9. Defects closed by this pass

| ID | Severity | What | Commit |
|---|---|---|---|
| **F1** | low | `JOURNEY_VIEWER_UNKNOWN` answered 404 — "no such case" about a case that exists | `2480a3b` |
| **F2** | medium | the 500 body handed out raw internal store names | `2480a3b` |
| **F3** | medium | five lifecycle states had no client label, in either language | `e75d5d6` |
| **F4** | medium | `m23Persistence` printed "server did not come up" above a log saying it had | `e75d5d6` |

F3 and F4 are the two worth reading, because in both cases an existing check
looked as though it should have caught the defect and could not have. Details
in `M23_P2_FINAL_DEFECT_REGISTER.md`, Addendum 2.

**Open Critical: 0. Open High: 0. Open Medium: 0.**

## 10. What P2 is

| | |
|---|---|
| Canonical record | `db.recruitmentCases`. A Room is a facet of a case, not a second pipeline |
| Authority direction | `room.status` → `case.stage`, one way, written by `applyStatus()` alone |
| Journey | a projection. There is no `db.recruitmentJourneys` |
| New stores | none. `migrateM23` is empty |
| Evidence preconditions | keyed by **target** status, so every inbound edge carries the identical burden |
| Evidence provider | injected, **fails closed** — no provider means an unmet requirement |
| Production-read stores | **123** — 42 migration-guaranteed, 80 module-guaranteed, 1 optional, **0 missing after boot** |

`storeContract.mjs` holds the ownership map; `PRODUCTION_REQUIRED_STORES` is
derived from it, not hand-kept; `m23BootContract` (61 checks, 70% negative)
verifies every claim against a really booted server.

## 11. Deliberately not in P2

- **Contact.** Not begun. Re-validated this pass: `M23_CONTACT_CONTRACT.md`
  still defines `contact_planned` vs `contacted`, draft ≠ contacted, real
  initiated communication required, transport state and response owned by the
  Contact object, and guardian routing for minors. Group **Z** asserts the
  vocabulary is published (the gate must refuse by name), three probe URLs
  answer 404, and `contacted` is refused `LIFECYCLE_EVIDENCE_REQUIRED` /
  `contact_delivered` with reason `not_implemented`.
- **`recruitmentOffers`.** Optional by design, proved four ways: classified
  optional in the contract, claimed by no boot path, optional to the journey,
  and reported as `available: false` beside a real empty list rather than
  invented rows.
- **Lifecycle events and notifications.** Nothing to notify until a share
  boundary exists.
- **Atomicity failure injection.** One synchronous write, one SQLite
  transaction; a harness here would test `store.save`, which `m182E2E` covers.
- **Client UI.** Two org routes; no client surface in P2.

## 12. Current limitations — and only these

1. **`recruitmentOffers` is not implemented.** Intentional; P4 ships it.
2. **Contact is not implemented.** Intentional; the contract is frozen ahead
   of it.
3. **The bundle is not off-machine backup.** It sits at
   `/home/user/scoutbox-m23-p2-final.bundle` inside an ephemeral container
   filesystem, reclaimed after inactivity or when the session ends. What is
   proven is that *this file, now*, restores to a clone whose tree hash equals
   the source and whose full battery — server, API and browser — passes. Not
   that the work survives the machine. The only durable protection for **163
   unpushed commits** is a push to a remote, which this task does not
   authorise. This is a durability limitation, not a correctness one.

Resolved and therefore **removed** from this list: the m18E2E flake, the
`m23Live`-from-bundle gap, the old bundle tips, and the 124/43 store counts.
