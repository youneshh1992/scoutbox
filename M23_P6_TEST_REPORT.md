# M23 P6 — Test report

Every suite below ran against the working tree at the commit named in the
row; the final runs are at the R4 tip. Nothing was skipped, nothing was
marked flaky, no assertion is `status !== 200`: every refusal names its
status and code.

## 1. The new suites

| Suite | Checks | Negative | Groups / content |
| --- | --- | --- | --- |
| `scoutbox-server/scripts/m23OfferE2E.mjs` | **447** | 284 (64%) | A model/store (pure: vocabulary, validators, status derivation, gates, integrity, evidence, views, `isAdult`), B create, C edit, D issue, E lifecycle, F player read, G guardian, H agent, I privacy, J expiry, K/M revisioning + supersede, L withdraw, N accept, O decline, P races, Q idempotency, R blocks, S minors, T transaction, U P5 privacy, V notifications, W deep links, X legacy states, Y rate limits, Z temporal — the 52 adversarial cases of §64 marked `#n` |
| `scoutbox-server/scripts/m23OfferPersistence.mjs` | **59** | 17 | §1 no migration / module store / pre-P6 snapshot boots empty; §2 a real journey (DRAFT, ACCEPTED, DECLINED, WITHDRAWN, SUPERSEDED) survives SIGTERM byte-faithfully with no signing; §3 keys replay, immutability and revs hold after reboot, the lifecycle coupling survives; §4 corrupt and fabricated rows are refused, omitted and never repaired |
| `e2e/m23OfferLive.test.mjs` (Chromium; club, player, agent apps) | **98** | 30 | A club drafts and issues (sentinel note); B Kola accepts at 390 px behind a second step; C the club reads Accepted — signing pending; D Mateus declines at 360 px with a reason; E agent sees nothing until the client shares, same-agency 404, no accept route; F minor fail-closed + guardian screen empty; N scout read-only, foreign 404, 401, widths 1440/1280/1024/768/390/360, a11y, FR, sentinel sweeps; 0 page errors |
| `scoutbox-server/scripts/m23OfferPerf.mjs` | audit | — | views by revisions (1/10/20), store scaling (1/1 000/5 000), scan audit (≤4 reads across three surfaces), index decision: none |

### The 52 adversarial cases (§64)

| Expected | Cases | Result |
| --- | --- | --- |
| EXPECT YES | #15 issue writes offer_made; #22 adult accepts own; #24 correct guardian responds (pathway closed in this build → refused 422, the guardian mechanics proven at the pure level A68); #31 exact active revision; #32 acceptance writes offer_accepted; #35 decline writes offer_declined; #40 revised terms create a new revision; #41 old revision readable | all as expected |
| EXPECT NO | the other 44 | all refused with the named status and code |

## 2. Server battery (§69)

40 server suites (38 existing + the 2 new ones) and apiE2E, each on its own random port with `DATA_DIR` set, run sequentially after the browser battery (a reap-based lane never runs beside a live suite):

| Suite | Result |
| --- | --- |
| m23OfferE2E | green — 447 checks |
| m23OfferPersistence | green — 59 checks |
| m23TemporalIntegrityE2E | green — 493 checks |
| connectedE2E | green — 43 checks |
| m12E2E | green — 152 checks |
| m13E2E | green — 212 checks |
| m14E2E | green — 194 checks |
| m141E2E | green — 94 checks |
| m15E2E | green — 190 checks |
| m16E2E | green — 118 checks |
| m161E2E | green |
| m162E2E | green |
| m17E2E | green — 17 checks |
| m18E2E | green — 18 checks |
| m181E2E | green |
| m182E2E | green |
| m19E2E | green — 19 checks |
| m20E2E | green — 20 checks |
| m21E2E | green — 21 checks |
| m22E2E | green — 112 checks |
| testTrust | green |
| m23E2E | green |
| m23Persistence | green — 67 checks |
| m23BootContract | green — 57 checks |
| m23P4AClosureE2E | green — 337 checks |
| m23ContactE2E | green — 428 checks |
| m23ContactPersistence | green — 61 checks |
| m23TrialE2E | green — 535 checks |
| m23TrialPersistence | green — 36 checks |
| m23DecisionE2E | green — 435 checks |
| m23DecisionPersistence | green — 48 checks |
| m23AgentE2E | green — 407 checks |
| m23AgentPersistence | green — 68 checks |
| m23AgentComplianceE2E | green — 346 checks |
| m23AgentCompliancePersistence | green — 83 checks |
| m23AgentTransactionE2E | green — 404 checks |
| m23AgentTransactionPersistence | green — 63 checks |
| m23AgentIntegrationE2E | green — 535 checks |
| m23P56ERepairAudit | green — 179 checks |
| m23AgentFinalHardeningE2E | green — 286 checks |
| apiE2E | green — 130 checks |

Total: 41 rows, 41 `rc=0`, 0 failures. Suites whose final line the lane's count parser does not read (m161E2E, m162E2E, m181E2E, m182E2E — 399 checks, m23E2E — 379 checks, testTrust) all exited 0 with no `✗` line.

## 3. apiE2E (§70)

130/130 API checks against a real server with `DATA_DIR` set on both sides.

## 4. Temporal suite (§71)

`m23TemporalIntegrityE2E`: 493 checks, 335 negative, green in the battery
(and under `TZ=UTC` and `TZ=America/New_York` in the fresh clone).

## 5. Perf / load (§77)

| Suite | Result |
| --- | --- |
| m23OfferPerf | club view 1/10/20 revisions p50 0.003/0.010/0.007 ms; store 1/1 000/5 000 Offers: evidence p50 0.001/0.012/0.063 ms, recipient list 0.001/0.026/0.023 ms, journey 0.014/0.046/0.195 ms; `recruitmentOffers` read 4 times across three surfaces; no N+1; no index justified |
| m23Perf, m23ContactPerf, m23TrialPerf, m23DecisionPerf, m22Robustness (48), m22Blocker (60) | green; `m22/perf.json` untouched |

## 6. Browser battery (§72)

The P5.7 sequential battery (`KEEP_DIST=1`, ports read from `/proc/net/tcp`), plus the new suite:

| Suite | Checks |
| --- | --- |
| navConfig | green — 359 |
| m15Live | green — 21 |
| m12Live | green |
| m21Live | green — 68 |
| m23AgentGrassrootsLive | green — 49 |
| m23AgentLive | green — 90 |
| m23AgentComplianceLive | green — 86 |
| m23AgentTransactionLive | green — 116 |
| m23AgentIntegrationLive | green — 98 |
| m23ContactLive | green — 82 |
| m23TrialLive | green — 122 |
| m23DecisionLive | green — 86 |
| m23Live | green — 39 |
| navLive | green — 64 |
| m23OfferLive (run separately, before the battery) | green — 98 |

15 browser suites, 0 failures, 0 page errors; after the battery the only listening ports were the environment's own (2024, 2025, 43819, 44193) — every suite port was released.

## 7. Typechecks and builds (§73, §74)

5/5 typechecks (agent, club, grassroots, admin, player), 5/5 builds
(vite ×4, `expo export` for the player), `index.html` present each.

## 8. EN/FR (§75), accessibility (§76)

m182E2E parity: club 2312/2312, grassroots 2190/2190 (P6 added 142 keys
to each); player and agent dictionaries are typed `fr: typeof en`, so a
missing French key is a typecheck failure. No screen asks for a key that
does not exist (m182E2E). No app renders the server's English sentences
(D-P6-14). Accessibility: live N15 (tab semantics, every control
labelled, `aria-required` on the two issue-required fields,
`aria-describedby` on Issue, polite live region, keyboard input); the
player's accept and decline are two explicit steps with the consequence
sentence in an `alert` region.

## 9. Clean boot, persistence, replay (§68)

Cold boot on an empty store: `X-ScoutBox-Schema: 2307`, `scoutbox.db`
created; an impossible day refused (400) and a real one accepted (201);
port released after stop; second boot: 2307, 0 migrations applied, data
persisted across the restart, port released. m23OfferPersistence §1: a
snapshot without the Offer store boots with an empty one and every case
where it was.

## 10. Demo bundles

`e2e/buildDemos.mjs` rebuilt after the last client edit; `demoFreshness`
16/16 (every bundle's source fingerprint equals the working tree's).

## 11. Fresh clone (§79)

From the R3 tip `fbd1292`, into an empty directory, with nothing reused (0 carried `node_modules`, 0 `dist` directories, 0 `.db` files — counted):

| Step | Result |
| --- | --- |
| clone | tip fbd1292 = source tip; clean |
| install (server, e2e, five apps) | rc 0 each |
| `SCHEMA_VERSION` declared | 2307, 17 migrations |
| cold boot on an empty store | `X-ScoutBox-Schema: 2307`; `scoutbox.db` created; port 4141 released after stop |
| five typechecks | 5/5 rc 0 |
| five builds (player via `expo export`) | 5/5, `index.html` present each |
| `m23OfferE2E` | all checks passed (447), rc 0 |
| `m23OfferPersistence` | all checks passed (59), rc 0 |
| `m23TemporalIntegrityE2E` | 493 checks, 335 negative, rc 0 |
| `m23AgentTransactionE2E` | all checks passed (404), rc 0 |
| `m23DecisionE2E` | all checks passed (435), rc 0 |
| one real live Club → Player Offer journey (`m23OfferLive`, Chromium; club, player and agent apps) | 98 checks, 30 negative, rc 0 |
| survivors | none live (12 already-exited zombies awaiting reap, holding nothing) |

## 12. Flakes

None. Every re-run in this milestone followed a code or test fix (D-P6-1
… D-P6-14) or a self-inflicted process kill (the cold-boot lane's reap
terminated a live suite's backend that was running beside it; the lane was
re-sequenced and the suite re-run green). No suite failed twice for the
same reason, and none passed on retry without a change.
