# M23 P5.6F — the test report (reconstructed)

> **P5.6F was reconstructed from the frozen `b8556c1` base after an ephemeral
> container loss. The reconstructed implementation is evidenced independently;
> original lost P5.6F hashes are historical references only.**

Everything run for this reconstruction, with its real numbers. Totals are
**reported, never forced to match the lost run's figures** — where they differ,
the difference is stated.

---

## 1. The new and changed suites

| Suite | Checks | Negative | Note |
| --- | --- | --- | --- |
| `m23AgentFinalHardeningE2E` | **247** | 137 (55%) | new, reconstructed from the mandate |
| `m23AgentGrassrootsLive` | **48** | 27 (56%) | new, closes A3 |
| `m23AgentLive` | 82 → **90** | 25 | +8: the Agent portal at 1024 and 768 (F-6) |
| `m23AgentTransactionLive` | 108 → **116** | 46 | +8: same |

The historical run reported 181/127 for the hardening suite and 29/23 for
Grassroots. This reconstruction reports 247/137 and 48/27. Neither number was
aimed at: the suites were written from the mandate's group list and the counts are
whatever the assertions came to.

## 2. Server battery — 37 suites, all green

Counted from the current inventory rather than a remembered total.

| Suite | Checks | Negative |
| --- | --- | --- |
| m23TrialE2E | 535 | 331 (62%) |
| m23AgentIntegrationE2E | 535 | 281 (53%) |
| m23DecisionE2E | 435 | 315 (72%) |
| m23ContactE2E | 428 | 246 (57%) |
| m23AgentE2E | 407 | 250 (61%) |
| m23AgentTransactionE2E | 404 | 215 (53%) |
| m23AgentComplianceE2E | 346 | 194 (56%) |
| m23P4AClosureE2E | 337 | 210 (62%) |
| **m23AgentFinalHardeningE2E** | **247** | **137 (55%)** |
| m13E2E / m14E2E / m15E2E / m12E2E / m16E2E / m22E2E / m141E2E | 212 / 194 / 190 / 152 / 118 / 112 / 94 | — |
| m23P56ERepairAudit | 179 | 134 (75%) |
| persistence: Compliance 83, Agent 68, D2 67, Transaction 63, Contact 61, Decision 48, Trial 36 | 426 total | — |
| m23BootContract | 61 | 43 (70%) |
| m161E2E, m162E2E, m17E2E, m18E2E, m181E2E, m182E2E, m19E2E, m20E2E, m21E2E, m23E2E, testTrust, connectedE2E | all green | — |

**Zero failures across all 37.**

`apiE2E`: **130 checks green**. It needs an already-running server on :4000 and
reads `DATA_DIR` from its **own** environment — running it with `DATA_DIR` set
only on the server produces one spurious failure
("snapshot persisted"), which is a harness mistake and is recorded here so the
next person does not file it as a defect.

## 3. Perf / load — 16 suites, all green

`m23Perf`, `m23ContactPerf`, `m23TrialPerf`, `m23DecisionPerf`, `m17Perf`,
`m18Perf`, `m181Perf`, `m182Perf`, `m19Perf`, `m20Perf`, `m21Perf`, `m22Perf`,
`m13Load`, `m18FlakeProbe`, `m22Robustness` (48 checks), `m22Blocker` (60 checks).

The lost run reported 15; the current inventory has 16 (it includes `m22Perf`).
The current total is reported.

**One note on hygiene:** `m22Perf` rewrites the tracked file
`scoutbox-server/m22/perf.json` with this machine's timings and, when run without
`--expose-gc`, with `gcExposed: false` — a *worse* recording than the committed
one. That change was reverted rather than committed. It is a known dirty-tree
source after any perf run.

## 4. Browser battery — 11 suites, sequential, all green

| Suite | Checks | Negative | Duration |
| --- | --- | --- | --- |
| navConfig | 359 | — | <1s |
| m23TrialLive | 122 | 53 (43%) | 38s |
| m23AgentTransactionLive | **116** | 46 (40%) | 120s |
| m23AgentIntegrationLive | 98 | 39 (40%) | 65s |
| m23AgentLive | **90** | 25 (28%) | 53s |
| m23AgentComplianceLive | 86 | 25 (29%) | 103s |
| m23DecisionLive | 86 | 25 (29%) | 30s |
| m23ContactLive | 82 | 33 (40%) | 34s |
| navLive | 64 | — | 98s |
| m23AgentGrassrootsLive | **48** | 27 (56%) | 5s |
| m23Live | 39 | — | 5s |

Ports measured empty afterwards, from `/proc/net/tcp`.

## 5. The concurrent contention group (§17)

Five Agent browser suites launched in the same instant on 4 CPUs, **after**
sequential success. Run **twice**, with identical results:

```
GROUP START 18:49:54Z   GROUP END 18:51:45Z   wall 111s
m23AgentLive             rc=0   39s    90 checks
m23AgentComplianceLive   rc=0   86s    86 checks
m23AgentTransactionLive  rc=0  101s   116 checks
m23AgentIntegrationLive  rc=0   51s    98 checks
m23AgentGrassrootsLive   rc=0    7s    48 checks
```

Load peaked at 1.61 on 4 CPUs; available memory never fell below 13.5 GB of 16.

**Ports were measured, not assumed.** The observer's held-port set descends
**18 → 15 → 10 → 5 → 0** as suites finish, and is empty the instant the last one
exits. No live surviving server, suite, Chromium or Vite process.

This is only trustworthy because of F-7: `ss` is **not installed** in this
container, so every previous `ss -ltn | grep` port check reported "zero
listeners" unconditionally. A check that cannot fail is worse than no check. The
probe now reads `/proc/net/tcp`.

**On zombies.** Immediately after a suite exits, Chromium leaves several
processes in state `Z` — already exited, holding no port or memory, waiting to be
reaped. The survivor check ignores those and settles for 4s before reporting a
live process, because a check that calls teardown a leak is a check that gets
ignored.

## 6. Typechecks and builds — 5/5 and 5/5

Five `tsc --noEmit` clean; four Vite builds plus the player's `expo export`
clean (`npm run build` is not used — the player app has no build script; the
canonical path is `expo export`).

## 7. Clean boot, replay, persistence (§25)

| Property | Result |
| --- | --- |
| `SCHEMA_VERSION` | **2307**, 17 migrations — no migration added by P5.6F |
| cold boot | `scoutbox.db` created; `X-ScoutBox-Schema: 2307` |
| restart persistence | a team member written before a restart is present after it |
| port release after shutdown | measured empty |
| clean-boot store contract | `m23BootContract` 61 checks / 43 negative — the full server boots on a **bare migrated database with no seed** |

**Replay determinism, enumerated rather than asserted.** Two replays from empty
differ in **33 leaves, and all 33** are a recorded clock (`at`, `updatedAt`,
`createdAt`, `publishedAt`, `revAt`) or an audit id derived from one.
**0 structural differences.** §25 says audit timestamps and clock-derived ids need
not match, and this is what that looks like when it is measured instead of
claimed.

Replay onto an already-migrated snapshot changes nothing, on a second **and** a
third pass; the 17-entry ledger does not grow; ids stay unique; the version stays
2307.

## 8. Fresh clone (§26)

From the reconstructed tip, with nothing reused — 0 carried `node_modules`, 0
carried `dist` directories, 0 carried `.db` files, all counted:

install clean → schema 2307 declared → cold store migrated to 2307 (header) →
port released → 5/5 typechecks → 5/5 builds/exports → hardening suite 247 checks
→ a real live Agent journey 48 checks.

## 9. Flakes

**Zero open.** The contention group was run twice with identical per-suite
durations and results.

## 10. What was deliberately not tested

- **a timing channel** on the agency-org list surfaces: on a single-process
  in-memory store, the time to filter an empty list is not a measurement anyone
  could act on.
- **the IP limiter's own two weaknesses** (M7 counts successes; per-process
  counting): out of scope for an Agent milestone, stated under F-5.
- **Offer and signing**: no writer exists; the suites assert **absence**, which is
  the only correct test for something this milestone is forbidden to build.
