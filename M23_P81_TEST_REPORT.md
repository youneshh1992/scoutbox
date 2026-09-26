# M23 P8.1 — Full lifecycle adversarial hardening: test report

Every lane was run at the final functional tip (R5, `1fe79cb`; R6 adds
documentation and this report only, so the source trees are identical).
Lane logs live in the session scratchpad (names in the tables); nothing
here is reused from P8 — every bundle, store and clone was rebuilt.

## 1. The P8.1 suites (§66–§68)

| Suite | Checks | Negative | Result | Log |
| --- | --- | --- | --- | --- |
| `scoutbox-server/scripts/m23RecruitmentJourneyHardeningE2E.mjs` (new, groups A–Z) | 247 | 178 (72%) | green | p81-hard8.log; battery |
| `scoutbox-server/scripts/m23RecruitmentJourneyPersistence.mjs` (section 5 added) | 139 | 25 | green | p81-pers3.log; battery |
| `e2e/m23RecruitmentJourneyHardeningLive.test.mjs` (new, L1–L9 + widths) | 57 | 19 | green, zero page errors, six widths | p81-live2.log; browser battery |
| `scoutbox-server/scripts/m23JourneyPerf.mjs` (rerun) | timings | — | §7 | p81-reg-m23JourneyPerf.log |

### m23RecruitmentJourneyHardeningE2E groups

| Group | What it proves | Checks |
| --- | --- | --- |
| HTTP | a real server on a random port with the test clock, the synthetic agent-verification provider and the development fault layer; Ana represents Kola | 2 |
| A | stale clients: a stale Contact draft, edit, lifecycle rev, Trial cancel, decision supersede, Offer accept, package signature and a hold-time signature are each refused; the current revision stays current; back at `offer_accepted` the club signs the current revision | 12 |
| B | adjacent-stage races: send vs block, answer vs invitation, two invitations, reschedule vs cancel, assessment vs hold (and the resume to the held-from state), two finalizes, draft vs supersede, issue vs withdraw, accept vs archive, start vs cancel, two completions — one authoritative result each | 18 |
| C | cross-case: player A's Trial, Offer and package never advance or appear on player B's case; the second case after an ended one inherits nothing (D-P81-15); at most one live line per club | 11 |
| D | cross-player: assessments, decision refs, evidence requests (D-P81-6), tasks (D-P81-13) stay with their player | 8 |
| E | cross-org: a foreign case, resource and id are concealed alike; a blocked player is absent on every discovery route (D-P81-8); the Box Cam link decides consent first (D-P81-9) | 17 |
| F | the four current-resource selectors are deterministic under shuffled stores | 9 |
| G | planted drift: a Contact, a Trial, an issued and an accepted revision the lifecycle never recorded — named (`EVIDENCE_AHEAD_OF_LIFECYCLE`), the act blocked, no history invented; a held case is not drift | 8 |
| H | rollback through three fault seams: after the status write, after the signing row, after the lifecycle moved, after the persisted Offer answer — nothing partial; the retry succeeds once | 9 |
| I | a block inserted at contact, trial, scheduled, acceptance and signing: the club's forward act refused (403), the closure allowed, history intact; the recipient may decline, not accept | 13 |
| J | club role and membership loss: a demoted lead, a restricted room, a removed colleague (session revoked, stream closed, no re-login) | 10 |
| K | agent authority loss: licence lapsed, re-verified, un-shared, representation ended, affiliation ended — the projection narrows or closes, the notification target vanishes (D-P81-14) | 9 |
| L | same-agency privacy: a colleague, the agency admin and an analyst see nothing on six routes; no note reaches the agency | 10 |
| M | minors through the chain: the wall, guardian routing, no Offer, closed signing, no agency pathway; `isAdult` false for nine malformed DOB shapes; a guardian block names its child (D-P81-7) | 11 |
| N | deep links: foreign = fabricated, the ended representation, an accepted Offer read-only, a superseded package's notification target, a removed user's link, a forged token | 7 |
| O | notifications: late "Offer issued" after a withdrawal, late "Trial scheduled" after a cancellation, late "Signing ready" after a void, a Contact row after a block, no duplicate on retries, every club target names a room and a tab | 5 |
| P | SSE: replay from `lastEventId`, no frame carries content, org-private events, the player's replay carries nothing internal, two reads produce one timeline | 6 |
| Q | restart: identical projection, a key replayed after the restart is idempotent (hold + resume), one signing row, no second completion | 5 |
| R | corrupt pointers and unknown states fail closed (`STALE_POINTER`, `RECORD_CORRUPT`, `STATE_UNKNOWN`), the domain route refuses, the store is put right offline, never on read | 6 |
| S | the four legacy / canonical mixes: nothing invented, the player learns only what reached him, the ordinary evidence rule holds on a legacy case | 6 |
| T | analytics: the funnel at its real path, a refused / replayed request changes nothing, the second case adds nothing, no note / rank / score, no negative interval, an assessment belongs to one case (pure, D-P81-18) | 10 |
| U | legacy routes dedupe and draw on the canonical budgets (D-P81-3, D-P81-4); the limiter evicts and never resets a live budget (pure, D-P81-5) | 5 |
| V | idempotency: replays report current truth (D-P81-10), fingerprint content (D-P81-11), die with the revision (D-P81-12), never cross stages, never survive the loss of the room role | 5 |
| W | terminal states and holds: no live act on signed / withdrawn / archived / closed; holds resume to the held-from state (D-P81-1); the `on_hold` row and the pure resolver | 12 |
| X | Second Look reopen: to under_review, the archive on the history, the next action derived afresh, a live case cannot be reopened | 4 |
| Y | the privacy sweep: the player's and agent's journeys, notifications and the club timeline carry no sentinel; no recruitment event payload names content | 6 |
| Z | source scans: each of D-P81-1 … D-P81-13 in its file; the fault seams inside the writers; the three apps re-read on focus / pageshow / visibility; no app reads state off an event; no domain assigns a status; one new integrity code, 24 next actions, 18 states, 19 actions, 4 terminal states, schema 2308, 18 migrations, no journey store, no m23 contract word | 23 |

### m23RecruitmentJourneyPersistence section 5 (§67)

| Check | What it proves | Checks |
| --- | --- | --- |
| 5.1 | the `under_review` checkpoint is identical across a restart | 3 |
| 5.2 | a real Offer re-homed with a stale pointer: `integrity_error` / `RECORD_CORRUPT`, the act blocked, three restarts, never repaired or re-pointed (D-P81-17) | 9 |
| 5.3 | an ended case and a second case for the same player: nothing inherited before and after a restart (D-P81-15) | 4 |
| 5.4 | canonical Contact + legacy trial claims: `partially_canonical`, the player's lines name the Contact and never the claim, identical after a restart | 6 |
| 5.5 | a `signed` case whose link names no row: `STALE_POINTER`, the player not told signed, not under contract, the link neither repaired nor given a row (D-P81-16) | 6 |
| 5.6 | key replays after a restart: a lifecycle move idempotent with one history entry; the signed case's Offer takes no new issue | 4 |
| 5.7 | a block across a restart: the send refused (403), the strip names the block, the draft and stage stand | 4 |
| 5.8 | role loss across restarts: a restricted room stays closed; a removed colleague cannot log in | 6 |
| 5.9 | the funnel identical across a restart, read before and after the section | 5 |

### m23RecruitmentJourneyHardeningLive (§68)

| Scenario | What it proves | Checks |
| --- | --- | --- |
| L1 | a cut-off tab and a colleague act at the same instant: one authoritative result; the tab shows the fresh state (and the refusal sentence when it lost); a second stale click overwrites nothing | 4 |
| L2 | the Contact tab open while the case moves on (answer + invitation over HTTP): the strip follows; the compose control closes by the server's `acceptsContact` | 5 |
| L3 | the case withdrawn under an open tab: the act disappears (event); a cut-off tab catches up on `pageshow` alone | 5 |
| L4 | a presented package; Maria's role drops while her cut-off tab is open; `pageshow` alone withdraws the act and names the reason; the stale act sent anyway is refused (403) | 7 |
| L5 | a colleague's old Room link after the room was restricted: the restriction sentence, no strip; his act refused; the restriction lifted | 5 |
| L6 | the player's bell keeps the row for a withdrawn Offer; Open lands with no accept control; his line asks nothing | 4 |
| L7 | Ana's client page shows the shared stage; the client ends the representation; `pageshow` alone empties the line; her rows for the Offer carry no target (D-P81-14) | 9 |
| L8 | a second Room for Nowak after his first case ended: watching, no done step, no inherited milestone, no player line | 5 |
| L9 | Bea (colleague) and Alex (agency admin) open Ana's client link: no journey line | 2 |
| W | 1440 / 1280 / 1024 / 768 / 390 / 360 on the Room (stage `signing`), 390 / 360 on Opportunities; zero page errors | 9 |

## 2. The full server battery (§74)

Two runs. The FIRST run (`p81-battery.status`) ran while the browser lane was exporting Expo bundles: 46 / 47 green and one boot timeout (`m23AgentComplianceE2E`, its 40 s boot ceiling, no assertion failed — T-P81-25, flake F-P81-1). The RECORDED run below (`p81-battery2.status`) ran alone, first-run, after the ceiling was raised: **47 / 47 green** (46 P8 suites + the hardening suite).

| Suite | rc | ✗ | duration | count line |
| --- | --- | --- | --- | --- |
| `m23RecruitmentJourneyHardeningE2E` | 0 | 0 | 8 s | 247 checks passed |
| `m23RecruitmentJourneyE2E` | 0 | 0 | 3 s | 168 checks passed |
| `m23RecruitmentJourneyPersistence` | 0 | 0 | 18 s | 139 checks passed |
| `m23SigningHardeningE2E` | 0 | 0 | 19 s | 212 checks passed |
| `m23SigningE2E` | 0 | 0 | 9 s | 255 checks passed |
| `m23SigningPersistence` | 0 | 0 | 11 s | 119 checks passed |
| `m23OfferHardeningE2E` | 0 | 0 | 13 s | 259 checks passed |
| `m23OfferE2E` | 0 | 0 | 10 s | 447 checks passed |
| `m23OfferPersistence` | 0 | 0 | 5 s | 94 checks passed |
| `m23TemporalIntegrityE2E` | 0 | 0 | 3 s | 493 checks passed |
| `connectedE2E` | 0 | 0 | 10 s | 43 connected-mode checks passed |
| `m12E2E` | 0 | 0 | 1 s | all 152 checks passed |
| `m13E2E` | 0 | 0 | 11 s | all 212 checks passed |
| `m14E2E` | 0 | 0 | 4 s | all 194 checks passed |
| `m141E2E` | 0 | 0 | 4 s | 94 checks passed |
| `m15E2E` | 0 | 0 | 1 s | 190 checks passed |
| `m16E2E` | 0 | 0 | 1 s | 118 checks passed |
| `m161E2E` | 0 | 0 | 2 s | 1 checks passed |
| `m162E2E` | 0 | 0 | 1 s | 2 checks passed |
| `m17E2E` | 0 | 0 | 2 s | 17 checks passed |
| `m18E2E` | 0 | 0 | 2 s | 18 checks passed |
| `m181E2E` | 0 | 0 | 1 s | 1 checks passed |
| `m182E2E` | 0 | 0 | 6 s | 2 checks passed |
| `m19E2E` | 0 | 0 | 4 s | 19 checks passed |
| `m20E2E` | 0 | 0 | 3 s | 20 checks passed |
| `m21E2E` | 0 | 0 | 3 s | 21 checks passed |
| `m22E2E` | 0 | 0 | 2 s | 112 checks passed |
| `testTrust` | 0 | 0 | 0 s | (no count emitted) |
| `m23E2E` | 0 | 0 | 2 s | 2 checks passed |
| `m23Persistence` | 0 | 0 | 2 s | 67 checks passed |
| `m23BootContract` | 0 | 0 | 2 s | 57 checks passed |
| `m23P4AClosureE2E` | 0 | 0 | 2 s | 337 checks passed |
| `m23ContactE2E` | 0 | 0 | 3 s | 428 checks passed |
| `m23ContactPersistence` | 0 | 0 | 3 s | 61 checks passed |
| `m23TrialE2E` | 0 | 0 | 6 s | 535 checks passed |
| `m23TrialPersistence` | 0 | 0 | 2 s | 36 checks passed |
| `m23DecisionE2E` | 0 | 0 | 9 s | 435 checks passed |
| `m23DecisionPersistence` | 0 | 0 | 4 s | 48 checks passed |
| `m23AgentE2E` | 0 | 0 | 3 s | 407 checks passed |
| `m23AgentPersistence` | 0 | 0 | 3 s | 68 checks passed |
| `m23AgentComplianceE2E` | 0 | 0 | 3 s | 346 checks passed |
| `m23AgentCompliancePersistence` | 0 | 0 | 4 s | 83 checks passed |
| `m23AgentTransactionE2E` | 0 | 0 | 4 s | 404 checks passed |
| `m23AgentTransactionPersistence` | 0 | 0 | 4 s | 63 checks passed |
| `m23AgentIntegrationE2E` | 0 | 0 | 4 s | 535 checks passed |
| `m23P56ERepairAudit` | 0 | 0 | 1 s | 179 checks passed |
| `m23AgentFinalHardeningE2E` | 0 | 0 | 6 s | 286 checks passed |

## 3. apiE2E (§75)

Against a real server on :4000 with `DATA_DIR` set on both sides, in both battery runs:

| Suite | rc | ✗ | duration | count line |
| --- | --- | --- | --- | --- |
| `apiE2E` | 0 | 0 | 1 s | 130 API checks passed |

**130 / 130** both times.

## 4. The browser battery (§76)

Bundles built from the tip after every `dist-live*` directory was deleted; each suite boots its own server and serves its own bundles. Two runs. The FIRST run (`p81-seq.status`): 19 / 21 — `m23TrialLive` N11d and `m23Live` L1 asserted the pre-P8.1 order of two rules that P8.1 changed on purpose (D-P81-9: consent before the Box Cam lookup; D-P81-1: a resume returns to the held-from state); both assertions were re-pinned (T-P81-26, T-P81-27) and rerun green standalone. The SECOND full run (`p81-seq2.status`, bundles rebuilt): 20 / 21 — `m23SigningLive` G3b read the panel's status attribute in the same instant the live-region sentence appeared, before the panel's re-read (a timing assumption in the P7 live test that had passed in the first run; T-P81-28, flake F-P81-2); the check now waits for the re-read and the suite passed three consecutive standalone runs (134 / 134 each). Every other suite was green in both runs; the hardening live suite was green in both runs and in the fresh clone.

| Suite | rc | ✗ | duration | count line |
| --- | --- | --- | --- | --- |
| `m23RecruitmentJourneyHardeningLive` | 0 | 0 | 52 s | m23RecruitmentJourneyHardeningLive: 57 checks passed (19 negative) |
| `m23RecruitmentJourneyLive` | 0 | 0 | 85 s | m23RecruitmentJourneyLive: 85 checks passed (13 negative) |
| `entryCredit` | 0 | 0 | 24 s | entryCredit: 31 checks passed — the credit is present on Club, Grassroots, Agent, Admin |
| `m23SigningHardeningLive` | 0 | 0 | 43 s | M23 P7.1 SIGNING HARDENING LIVE: 68 checks passed (16 negative, 24%) |
| `m23SigningLive` | 1 | 1 | 33 s | (no count line) |
| `m23OfferHardeningLive` | 0 | 0 | 39 s | M23 P6.1 OFFER HARDENING LIVE: 53 checks passed (26 negative, 49%) |
| `m23OfferLive` | 0 | 0 | 37 s | M23 P6 OFFER LIVE: 98 checks passed (30 negative, 31%) |
| `navConfig` | 0 | 0 | 1 s | navConfig: 359 checks passed |
| `m15Live` | 0 | 0 | 54 s | m15Live: 21 checks passed — P1–P8 + T&S complete |
| `m12Live` | 0 | 0 | 21 s | (no count line) |
| `m21Live` | 0 | 0 | 60 s | M21 live journeys: 68 checks passed |
| `m23AgentGrassrootsLive` | 0 | 0 | 21 s | M23 P5.6F GRASSROOTS LIVE (reconstructed): 49 checks passed (27 negative, 55%) |
| `m23AgentLive` | 0 | 0 | 55 s | M23 P5.6B AGENT LIVE: 91 checks passed (26 negative, 29%) |
| `m23AgentComplianceLive` | 0 | 0 | 104 s | M23 P5.6C COMPLIANCE LIVE: 86 checks passed (25 negative, 29%) |
| `m23AgentTransactionLive` | 0 | 0 | 118 s | M23 P5.6D TRANSACTION LIVE: 116 checks passed (46 negative, 40%) |
| `m23AgentIntegrationLive` | 0 | 0 | 67 s | M23 P5.6E integration live: 98 checks passed, 39 negative/privacy/safeguarding checks (40% |
| `m23ContactLive` | 0 | 0 | 37 s | M23 P3 CONTACT LIVE: 82 checks passed (33 negative, 40%) |
| `m23TrialLive` | 0 | 0 | 39 s | M23 P4B TRIAL LIVE: 122 checks passed (53 negative, 43%) |
| `m23DecisionLive` | 0 | 0 | 33 s | M23 P5 DECISION LIVE: 86 checks passed (25 negative, 29%) |
| `m23Live` | 0 | 0 | 5 s | m23Live: 39 checks passed — P2 sweep corrections verified end to end |
| `navLive` | 0 | 0 | 101 s | navLive: 64 checks passed — N1–N17 complete |

With the three re-pinned assertions: **21 / 21** (20 P8 suites + the hardening live suite), each suite green at the tip in at least one full lane run and in the standalone rerun.

## 5. Typechecks, builds, demo freshness (§77–§79)

`p81-apps.sh` at the tip (each build to a throwaway directory, removed afterwards; demos rebuilt with `buildDemos` and then checked):

| Step | Result |
| --- | --- |
| typecheck scoutbox-agent | rc=0 |
| typecheck scoutbox-club | rc=0 |
| typecheck scoutbox-grassroots | rc=0 |
| typecheck scoutbox-admin | rc=0 |
| typecheck scoutbox-player | rc=0 |
| build scoutbox-agent | rc=0 index=yes |
| build scoutbox-club | rc=0 index=yes |
| build scoutbox-grassroots | rc=0 index=yes |
| build scoutbox-admin | rc=0 index=yes |
| export scoutbox-player | rc=0 index=yes |
| buildDemos | rc=0 |
| demoFreshness | rc=0 21 ok 0 fail |

**5 / 5 typechecks, 5 / 5 builds (four Vite builds and the Expo export, `index.html` present), demo freshness 21 / 21.**

## 6. EN / FR and accessibility (§80, §81)

- P8.1 added no client string: the R3 change is three effects in
  `App.tsx` (club, grassroots, agent) and nothing else in any app; the
  EN / FR parity of P8 (every `jn.*`, `ct.*`, `sg.*` key in both
  dictionaries) stands unchanged. The typecheck of every app passed.
- Accessibility is re-proved by the browser battery at the tip: the strip
  is a labelled region with `aria-current` on the rail (journey live A28a),
  the conflict sentence is a polite live region (B4a), the withdrawn act's
  button is described by its reason (`aria-describedby`, C4a); the
  hardening live suite reaches every stale state through the same
  controls (L1, L3–L5) and reads the reason text after the `pageshow`
  re-read (L4e). Keyboard focus is not moved by a re-read: the re-read
  only bumps a refetch counter (Z16–Z17).

## 7. Performance (§82)

`m23JourneyPerf` at the tip: 500 cases — club projection 5.9 ms, player
journeys over 10 cases 25 ms, agent 1.8 ms; 5 000 cases — 19.9 ms, 118 ms
over 100 cases, 1.2 ms. No N+1, no index, no cache; a 10× store reads a
few × slower, never 10² ×.

## 8. Clean boot and replay (§83)

`p81-coldboot.sh` (port 4177, an empty store): boot 1 applied the 18
migrations `0 → 2308` and answered `X-ScoutBox-Schema: 2308`; a malformed
open-trial date is 400 and a real one 201; the port was released on stop;
boot 2 on the same store answered 2308, found the open day persisted, and
its ledger applied 0 steps on replay; no duplicate registration on either
boot. The one registry note (`event registry lists names the server never
emits: room_decision_finalized, room_decision_superseded`) is the same
pre-existing line P8's cold boot recorded; P8.1 registered no event.

## 9. Fresh clone from the final functional tip (§84)

`p81-freshclone.sh`: a `git clone` of the working copy at the final functional tip `1fe79cb` into an empty directory — no `node_modules`, no `dist*`, no database carried — then install, schema, cold boot, five typechecks, five builds, the seven server suites and the three live suites the mandate names (§84). Verbatim:

```
=== 1. CLONE (no artefacts carried) ===
clone tip:   1fe79cb
source tip:  1fe79cb
clone clean: yes
carried node_modules: 0 (expect 0)
carried dist dirs:    0 (expect 0)
carried db files:     0 (expect 0)
node v22.22.2  npm 10.9.7
=== 2. DEPENDENCY INSTALL ===
scoutbox-server install rc=0
e2e install rc=0
=== 3. SCHEMA DECLARED ===
SCHEMA_VERSION = 2308 migrations = 18
=== 4. DB BOOTSTRAP + SERVER START ON A COLD STORE ===
health:        {"ok":true,"service":"scoutbox-server","engine":"sqlite","devLogins":true,"uptim
schema on disk: X-ScoutBox-Schema: 2308
store files:    media scoutbox.db scoutbox.db-shm scoutbox.db-wal 
4141 released:  []
=== 5. FIVE TYPECHECKS ===
scoutbox-agent typecheck rc=0 
scoutbox-club typecheck rc=0 
scoutbox-grassroots typecheck rc=0 
scoutbox-admin typecheck rc=0 
scoutbox-player typecheck rc=0 
=== 6. FIVE BUILDS / EXPORT ===
scoutbox-agent build rc=0 index=yes
scoutbox-club build rc=0 index=yes
scoutbox-grassroots build rc=0 index=yes
scoutbox-admin build rc=0 index=yes
scoutbox-player export rc=0 index=yes
=== 7. JOURNEY E2E + JOURNEY PERSISTENCE + OFFER HARDENING + SIGNING HARDENING + TEMPORAL + AGENT INTEGRATION ===
m23RecruitmentJourneyE2E rc=0 :: M23 P8 Recruitment Journey: 168 checks passed, 86 negative, 0 failed
m23RecruitmentJourneyPersistence rc=0 :: M23 P8 Recruitment Journey Persistence: 139 checks passed, 25 negative, 0 failed
m23RecruitmentJourneyHardeningE2E rc=0 :: M23 P8.1 Recruitment Journey Hardening: 247 checks passed, 178 negative, 0 failed
m23OfferHardeningE2E rc=0 :: all M23 P6.1 Offer hardening checks passed
m23SigningHardeningE2E rc=0 :: all M23 P7.1 Signing hardening checks passed
m23TemporalIntegrityE2E rc=0 :: 493 checks passed, 335 negative (68%)
m23AgentIntegrationE2E rc=0 :: M23 P5.6E integration suite: 535 checks passed, 281 negative/security/safeguarding checks (53%)
=== 8. ONE ADULT JOURNEY (journey live A) + ONE STALE-TAB RACE (hardening live L1) + ONE AGENT AUTHORITY-LOSS JOURNEY (hardening live L7) + THE ENTRY CREDIT ===
m23RecruitmentJourneyLive rc=0 :: m23RecruitmentJourneyLive: 85 checks passed (13 negative)
m23RecruitmentJourneyHardeningLive rc=0 :: m23RecruitmentJourneyHardeningLive: 57 checks passed (19 negative)
entryCredit rc=0 :: entryCredit: 31 checks passed — the credit is present on Club, Grassroots, Age
=== 9. CLEANUP CHECK ===
8 zombie(s) awaiting reap — exited already, holding no port or memory; not a leak
no live surviving server / suite / chromium / vite process
FRESH CLONE DONE
```

## 10. Flakes

Two lane-level intermittents, both explained, both fixed on the test side, neither a product defect:

| ID | Where | What happened | Root cause | Fix | Evidence |
| --- | --- | --- | --- | --- | --- |
| F-P81-1 | server battery, first run | `m23AgentComplianceE2E` exited 1 with no assertion failed after 40 s | its boot wait (160 × 250 ms) expired while the browser lane was exporting Expo bundles on the same CPU | ceiling raised to 100 s (T-P81-25); lanes run one at a time for the recorded run | standalone 346 / 346; battery rerun 47 / 47 |
| F-P81-2 | browser battery, second run | `m23SigningLive` G3b read `data-status` before the panel's re-read | an ordering assumption between the mutation's live-region sentence and the panel refetch | the check waits for the attribute (T-P81-28) | first lane run green; three consecutive standalone runs 134 / 134 |

Known unexplained flakes: **0**. Every suite is green at the tip.
