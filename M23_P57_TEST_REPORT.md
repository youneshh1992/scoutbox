# M23 P5.7 — Test report

Everything run for the temporal sweep, with the real numbers. Nothing is
padded toward a target; the counts are whatever the assertions came to.

## 1. The new suite

| Suite | Checks | Negative | Under `TZ=UTC` | Under `TZ=America/New_York` |
| --- | --- | --- | --- | --- |
| `m23TemporalIntegrityE2E` | **493** | **335 (68%)** | 493 / 335, rc 0 | 493 / 335, rc 0 |

Twenty groups A–T (pure A–P, live Q–T). Group P additionally spawns the
same probe in three child processes under `TZ=UTC`, `TZ=America/New_York`
and `TZ=Asia/Tokyo` and requires byte-identical JSON; the three processes
prove they really ran in three zones (`getTimezoneOffset()` of the epoch is
0, 300 and −540).

Property-style enumeration (§35): the DATE_ONLY parser is checked against
an independent days-in-month table over 4 years × 14 months × 33 days =
1848 triples; every fail-closed predicate is checked over the same fixed
list of 14 value shapes; no unseeded randomness exists in the suite (the
port is the only random number and it is not an input to any assertion).

The 22 adversarial cases of §36 are group O: 22 assertions, every one
EXPECT NO and every one refused; #16 is additionally shown to succeed only
with the explicit `resolve` argument.

## 2. Server battery — 38 suites, all green (§37)

Run as one sequential script after R1; each suite's exit code, failure
count and reported total recorded.

| Suite | Checks | Negative |
| --- | --- | --- |
| **m23TemporalIntegrityE2E** | **493** | **335** |
| m23TrialE2E / m23AgentIntegrationE2E | 535 / 535 | 331 / 281 |
| m23DecisionE2E | 435 | 315 |
| m23ContactE2E | 428 | 246 |
| m23AgentE2E | 407 | 250 |
| m23AgentTransactionE2E | 404 | 215 |
| m182E2E | 389 | 229 |
| m23AgentComplianceE2E | 346 | 194 |
| m23P4AClosureE2E | 337 | 210 |
| m23AgentFinalHardeningE2E | 286 | 166 |
| m13E2E / m14E2E / m15E2E / m12E2E / m16E2E / m22E2E / m141E2E | 212 / 194 / 190 / 152 / 118 / 112 / 94 | — |
| m23P56ERepairAudit | 179 | 134 |
| persistence: Compliance 83, Agent 68, D2 67, Transaction 63, Contact 61, Decision 48, Trial 36 | 426 | — |
| m23BootContract | 61 | 43 |
| connectedE2E | 43 | — |
| m17E2E, m18E2E, m19E2E, m20E2E, m21E2E, m161E2E, m162E2E, m181E2E, m23E2E, testTrust | all green | — |

**Zero failures across all 38.** One note for the log: the battery's
`m182E2E` run started while the club i18n edit was half applied (EN keys
present, FR keys not yet) and reported the parity gap 2170/2164; the re-run
after both edits reports **2170/2170 and 2048/2048, 389 checks green**, and
that re-run is the figure above. Recorded so the raw log is explainable.

## 3. apiE2E (§38)

**130 API checks green**, run against a server on :4000 with `DATA_DIR`
set on both the server and the suite.

## 4. Perf / load (§43)

`m23Perf`, `m23ContactPerf`, `m23TrialPerf`, `m23DecisionPerf`,
`m22Robustness` (48 checks), `m22Blocker` (60 checks): all green, run on a
quiet CPU before the browser battery. `m22Perf` was not run because it
rewrites the tracked `m22/perf.json` with this machine's timings (a known
dirty-tree source, recorded in P5.6F); nothing in P5.7 touches the code it
measures. `git status` on `perf.json` after the perf group: clean.

## 5. Browser battery — 14 suites, sequential, all green (§39)

| Suite | Checks | Negative | Duration |
| --- | --- | --- | --- |
| navConfig | 359 | — | <1s |
| m23TrialLive | 122 | 53 | 22s |
| m23AgentTransactionLive | 116 | 46 | 98s |
| m23AgentIntegrationLive | 98 | 39 | 48s |
| m23AgentLive | 90 | 25 | 37s |
| m23AgentComplianceLive | 86 | 25 | 84s |
| m23DecisionLive | 86 | 25 | 16s |
| m23ContactLive | 82 | 33 | 19s |
| m21Live | 68 | — | 61s |
| navLive | 64 | — | 101s |
| m23AgentGrassrootsLive | 49 | 27 | 22s |
| m23Live | 39 | — | 5s |
| m15Live (Player passport, club, guardian) | 21 | — | 58s |
| m12Live | green | — | 22s |

Player, Club, Grassroots, Agent, Contact, Trial and Transaction surfaces
are all exercised in Chromium against the built apps with the R3 client
changes; every suite fails on a page error and none did. No surviving
server, suite, Chromium or Vite process afterwards (`survivors.mjs`). The
ports the suites use were all released; the four listeners left on the
machine (2024, 2025 and two ephemeral ports) belong to the container's process API (pid 1) and the session proxy,
not to anything the battery started.

## 6. Typechecks and builds — 5/5 and 5/5 (§40)

`tsc --noEmit` clean for agent, club, grassroots, admin, player; Vite builds
clean for agent, club, grassroots, admin; `expo export --platform web`
clean for the player app (its canonical build path).

## 7. EN/FR (§41), accessibility (§42)

`m182E2E` parity: club 2170/2170, grassroots 2048/2048, no gaps — the six
new `err.*` keys exist in both languages. Accessibility is asserted by the
frozen groups already in the battery (`m23AgentFinalHardeningE2E` AG,
`navLive` N1–N17, the `aria-label` contracts in every Live suite); P5.7
changes no markup.

## 8. Clean boot, persistence, replay (§44)

| Property | Result |
| --- | --- |
| `SCHEMA_VERSION` | **2307**, 17 migrations — no migration added |
| cold boot on an empty directory | `scoutbox.db` created; `X-ScoutBox-Schema: 2307` |
| an open day on 30 February on that store | 400; a real day 201 |
| restart | the open day is present after it; the second boot applied 0 migrations |
| port release | measured empty from `/proc/net/tcp` after each stop |
| store contract | `m23BootContract` 61 checks / 43 negative; seven persistence suites green |

## 9. Fresh clone (§45)

See M23_P57_FINAL_REPORT.md §45 for the run from the R3 tip: install, cold
boot to 2307, 5/5 typechecks, 5/5 builds, the temporal suite under both
zones, the core Agent suite, and one real Trial and one real Contact
browser journey.

## 10. Flakes

Zero open. Every suite that was re-run (the affected-suite lanes after R1,
the Agent lane after the affiliation fix, the full battery, the browser
battery) reported the same counts each time.
