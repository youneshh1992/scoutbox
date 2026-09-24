# M23 P8 — Full recruitment journey integration: test report

Every lane the mandate names (§61–§85), what ran, at which tip, with the
counts as the harness printed them. Scratchpad logs are named in brackets.
Functional code changed last in R5 `3cf34b9` (the D-P8-16 trial scope fix);
R6 `6d366c1` changed two test files (the demo credit check, the credit
bundle's directory name). The server battery and the apps lane ran at
`3cf34b9`; the browser battery, the clean boot and the fresh clone ran at
`6d366c1`. The documentation commit that contains this file changes no
code.

## 1. The P8 suites (§61–§66)

| Suite | Checks | Negative | Result | Log |
| --- | --- | --- | --- | --- |
| `scoutbox-server/scripts/m23RecruitmentJourneyE2E.mjs` (new) | 168 | 86 (51%) | green | p8-jE2E-r5b.log; battery |
| `scoutbox-server/scripts/m23RecruitmentJourneyPersistence.mjs` (new) | 85 | 10 | green | p8-jPers-r5.log; battery |
| `e2e/m23RecruitmentJourneyLive.test.mjs` (new) | 85 | 13 | green, zero page errors, six widths | p8-live14.log; browser battery |
| `e2e/entryCredit.test.mjs` (new, §60) | 31 | — | green on Club, Grassroots, Agent, Admin, Player onboarding | p8-credit1.log; browser battery |
| `scoutbox-server/scripts/m23JourneyPerf.mjs` (new, §79) | timings | — | see §9 | — |

### m23RecruitmentJourneyE2E groups

| Group | What it proves | Checks |
| --- | --- | --- |
| A | the pure model: 13 stages, the ten pipeline stages in order, `canonicalStageFor` refinements, the four current-resource selectors (tiers, newest-first, id tie-break), the 24 next-action codes and their tab / permission / block rules, the player words, the validator's classifications and integrity codes, the timeline visibility table | 38 |
| HTTP | a real server on a random port with the test clock and the synthetic agent-verification provider | 2 |
| B | the canonical adult journey in 25 steps (§61): discover → watch → Room → review → Contact sent / delivered / answered → Trial invited / accepted / scheduled / completed → assessment → decision → `offer_consideration` → Offer drafted / issued / accepted → signing started → parties → completion → `signed`; ONE `db.signings` row; `under_contract`; the projection reads complete; the player's and the agent's lines at each step | 44 |
| C | the boundaries (§62 #1–#20): discovery, watching, a draft Contact, a failed Contact, a requested Trial, a scheduled Trial, a completed Trial, an assessment, a `progress` decision, an issued Offer, an accepted Offer, a started signing, a partial signing, Trust, Matching, CV refusal, a foreign resource, a same-agency agent, a minor | 12 |
| D | legacy cases (§11, §64): planted `contacted`, `trial_completed`, `offer_made`, `signed` (with a legacy row) and a claimed-but-missing Contact — classified, nothing fabricated, no crash, no unsafe act; D10–D12: a second case after the first ended owns none of the first case's records | 12 |
| F | audiences (§16, §17, §46, §47): the player's and guardian's journeys, the agent with grants, the same-agency colleague and the agency admin | 8 |
| G | notifications resolve to the current authorized resource (§29–§31): Offer → its Offer, package → the current package over the same Offer, a superseded package, a blocked player, a revoked agent | 8 |
| H | one writer, one authority (§5, §26, §27): the legacy status route's role parity, the reopen guard, the self-service contract route (`under_contract` refused; the word locked while a canonical contract stands), the legacy recording route (clubs, leads), squad release | 13 |
| Q | partial failure (§81): a fault after the lifecycle moved restores status, stage, rev and history together | 3 |
| I | analytics (§42–§45, §90): every funnel stage from its canonical record, case-based, a retry never counts twice, history-only figures beside, canonical intervals | 11 |
| Z | the boundaries read from the source: one status writer, no client computes a stage or a next action, Matching / Trust / Box Cam / CV never touch the lifecycle, no new store, schema 2308 | 17 |

### m23RecruitmentJourneyPersistence sections (§63)

| Section | What it proves | Checks |
| --- | --- | --- |
| 1 | nine checkpoints — `contacted`, `trial_requested`, `trial_scheduled`, `trial_completed`, `offer_consideration`, `offer_made`, `offer_accepted`, signing in progress, `signed` — each across a SIGTERM restart: the projection before and after is identical (stage, completed stages, resources, next action, classification, timeline) | 58 |
| 2 | after the final reboot: the player's, guardian's and agent's projections agree with the club's; ONE signing row; nothing fabricated | 5 |
| 3 | the planted legacy and corrupt cases across five restarts: untouched, never repaired | 18 |
| 4 | the migration ledger on replay applies nothing; schema 2308 | 2 |

### m23RecruitmentJourneyLive groups (§65–§70)

| Group | What it proves | Checks |
| --- | --- | --- |
| A | the club's full path in one Room with the strip and the tabs only (no URL edits, §67): the stage rail, ONE next action, the tab it opens, the timeline; the strip re-reads after every act and on every server event (`recruitment_case_moved`, `assessment_submitted`) | 34 |
| B | a case moved from another session: the strip's act meets a 409, says "This recruitment has changed. We refreshed the latest status." and refreshes (§56); visibility and focus re-read (§55) | 9 |
| C | role loss while the tab is open (§50): the next-action control disappears or refuses; nothing stale mutates | 8 |
| D | deep links into Contact / Trial / Offer / Signing after a supersede, a revoke and an ended case resolve safely (§69); back / forward re-fetch (§68) | 9 |
| E | a notification opens the current resource (§70) | 2 |
| P | the player's line: club and stage, the latest milestone, no note / rationale / club word; tappable bell rows; an ended case shares nothing | 6 |
| G | the agent's factual line: nothing before a share, the stage after, no decision / assessment / priority; the same-agency colleague sees no client; after the client ends the representation the line is gone on the next read | 7 |
| W | widths 1440 / 1280 / 1024 / 768 / 390 / 360 for the club, 390 / 360 for the player: the strip fits, no horizontal scroll; zero page errors across every context | 9 |

## 2. Full server battery (§71)

`p8-battery2.sh` at `3cf34b9` (`p8-battery.status`): **46 suites, 46 green**
(baseline 45 + the two P8 suites; `m23RecruitmentJourneyE2E` and
`m23RecruitmentJourneyPersistence` are the new rows — the earlier baseline
counted the P7.1 hardening suite as its 45th).

| Suite | Checks | | Suite | Checks |
| --- | --- | --- | --- | --- |
| m23RecruitmentJourneyE2E | 168 | | m20E2E | 266 (harness prints 20 on its last line) |
| m23RecruitmentJourneyPersistence | 85 | | m21E2E | 21 |
| m23SigningHardeningE2E | 212 | | m22E2E | 112 |
| m23SigningE2E | 255 | | testTrust | no count emitted, rc=0 |
| m23SigningPersistence | 119 | | m23E2E | all P2 checks (last line prints 2) |
| m23OfferHardeningE2E | 259 | | m23Persistence | 67 |
| m23OfferE2E | 447 | | m23BootContract | 57 |
| m23OfferPersistence | 94 | | m23P4AClosureE2E | 337 |
| m23TemporalIntegrityE2E | 493 | | m23ContactE2E | 428 |
| connectedE2E | 43 | | m23ContactPersistence | 61 |
| m12E2E | 152 | | m23TrialE2E | 535 |
| m13E2E | 212 | | m23TrialPersistence | 36 |
| m14E2E | 194 | | m23DecisionE2E | 435 |
| m141E2E | 94 | | m23DecisionPersistence | 48 |
| m15E2E | 190 | | m23AgentE2E | 407 |
| m16E2E | 118 | | m23AgentPersistence | 68 |
| m161E2E | 1 | | m23AgentComplianceE2E | 346 |
| m162E2E | 2 | | m23AgentCompliancePersistence | 83 |
| m17E2E | 17 | | m23AgentTransactionE2E | 404 |
| m18E2E | 18 | | m23AgentTransactionPersistence | 63 |
| m181E2E | 1 | | m23AgentIntegrationE2E | 535 |
| m182E2E | 2 | | m23P56ERepairAudit | 179 |
| m19E2E | 19 | | m23AgentFinalHardeningE2E | 286 |

Every row rc=0, fails=0. (Where a harness prints a section number rather
than a total on its last line, the number above is what it printed; the
suite's own summary lines are in the lane log.)

## 3. apiE2E (§72)

Against a real server on port 4000 with `DATA_DIR` set on both sides:
**130 / 130 API checks passed** (baseline 130; Pat Doyle logs in as Head
Coach since R1 so the legacy recording route's lead rule holds).

## 4. Browser battery (§73)

`p8-seq.sh` at `6d366c1` with every app bundle deleted first, so each suite
built its bundles from the tip (`p8-seq.status`, one log per suite):

| Suite | Checks | Result |
| --- | --- | --- |
| m23RecruitmentJourneyLive (new) | 85 (13 negative) | green |
| entryCredit (new) | 31 | green |
| m23SigningHardeningLive | 68 | green |
| m23SigningLive | 134 | green |
| m23OfferHardeningLive | 53 | green |
| m23OfferLive | 98 | green |
| navConfig | 359 | green |
| m15Live | 21 | green |
| m12Live | rc=0, fails=0 | green |
| m21Live | 68 | green |
| m23AgentGrassrootsLive | 49 | green |
| m23AgentLive | 91 (was 90; N5c added) | green on the rerun at `114c0e4` — see below |
| m23AgentComplianceLive | 86 | green on the rerun at `114c0e4` — see below |
| m23AgentTransactionLive | 116 | green |
| m23AgentIntegrationLive | 98 | green |
| m23ContactLive | 82 | green |
| m23TrialLive | 122 | green |
| m23DecisionLive | 86 | green |
| m23Live | 39 | green |
| navLive | 64 | green |

**20 / 20 green** (baseline 18 + the two P8 suites). Two suites were red on
the first fresh-bundle pass and green after a test-side fix each
(T-P8-11, T-P8-12 in the defect register): `m23AgentLive` N5 swept the
client overview for the word "offer" and met the "Offers" tab label — a
read-only destination since P6 — which the lane had never seen because the
agent bundle it used to reuse predated P6; and B10b / G1b read a card
before its re-read landed. No product change followed from either; the
sweep now strips the tab label and P8's factual stage words and adds N5c
(no control on the overview names an offer, a negotiation, a commission or
a fee). The lesson is recorded: the browser battery deletes every app
bundle before it runs, so each suite proves the tip.

## 5. Five-app typecheck and build (§74, §75)

`p8-apps.sh` at `3cf34b9` (`p8-apps.status`): typecheck agent, club,
grassroots, admin, player — **5 / 5 rc=0**; `vite build` agent, club,
grassroots, admin and `expo export --platform web` player — **5 / 5 with
`index.html`**. The player typecheck was re-run after the R4 bell testID
(rc=0). The French tables are typed `typeof en`, so a missing or extra key
is a type error: the five typechecks are the parity proof.

## 6. Demo freshness (§76)

`buildDemos.mjs` rc=0 at `3cf34b9`; `demoFreshness.test.mjs` **21 / 21**
(`p8-demoFreshness.log`): each of the five demo bundles carries a source
fingerprint equal to the current source's, its build sha (`3cf34b9`), the
demo badge, and — new in R6 — the entry-screen credit (`login-signature`
and "Built by Guni & Younes", uppercase on the player's onboarding).

## 7. EN / FR (§77)

P8 client strings, English vs French, counted by key:

| App | P8 keys EN | P8 keys FR |
| --- | --- | --- |
| Club (`jn.*`, `sg.*`, `m20.jf.*`, `m20.metric.journey_evidence_funnel`, `rm.err*`, `rm.tab.signing`) | 241 | 241 |
| Grassroots (the same families) | 241 | 241 |
| Agent (`clients.journey.*` and the rest) | 34 | 34 |
| Player (`jn*`) | 5 | 5 |

No raw backend code reaches a screen: the strip renders `jn.next.<code>`,
`jn.stage.<stage>`, `jn.blocked.<code>` and `jn.class.<classification>`,
each with a fallback that is still a sentence; the refusal codes
`ROOM_EVIDENCE_REQUIRED`, `ROOM_TRANSITION_INVALID`,
`ROOM_PERMISSION_REQUIRED` render as `rm.err*` sentences (live A, B).

## 8. Accessibility (§78)

Live A28a (the strip is a labelled region; the rail is an ordered list whose
current step carries `aria-current="step"` — the strip marks exactly one
step current per render, also when the current stage is done, the `signed`
case; the Room's tabs are ARIA tabs with one `aria-selected`), B4a (the
"changed" sentence is a polite `role="status"` live region), C4a (a
disabled next-action button carries `aria-describedby` to the sentence that
says why), the P3–P7 tab and control semantics re-run in the browser
battery; state is never colour-only (glyph + word on every step,
the ⏳ / ■ markers with `aria-hidden` beside a word); the agent's line is
read-only text; the player's line is a labelled section with `testID`s and
the bell's "Open" is a labelled button. No new modal or focus trap.

## 9. Perf / load (§79)

`m23JourneyPerf` at R5 (pure, in memory; 50 players, N/50 clubs, one case
per club–player pair, every case with its Contact, Trial, assessment,
decision, accepted Offer and READY package):

| N cases | club projection | player's journeys | agent projection | timeline entries |
| --- | --- | --- | --- | --- |
| 500 | 2.17 ms | 10 cases 3.60 ms | 0.28 ms | 19 |
| 5 000 | 3.73 ms | 100 cases 97.20 ms | 1.07 ms | 19 |

One projection is a handful of linear filters over the store (no N+1, no
aggregator that walks every case, no index, no cache); a ten-times larger
store reads under two times slower for the club and the agent, and the
player's cost is linear in the number of their cases. The timeline of one
case no longer grows with the store (D-P8-16). The M20 funnel walks the
window's cases once and reads each record family once (`journeyEvidenceFunnel`).

## 10. Clean boot / replay (§84)

`p8-coldboot.sh` at `114c0e4` (`p8-coldboot.out`): boot 1 on an empty store
reports `X-ScoutBox-Schema: 2308` with the ledger applying the 18 steps
from 0, store files created (`scoutbox.db`, `-shm`, `-wal`, `media`), a 30
February open-trial refused (400) and a real day accepted (201), port 4177
released after stop; boot 2 reports 2308, the record persisted across the
restart, the migration ledger applied **0** steps on replay; 0 duplicate
registrations across both boots; no new migration, store, event or rate
policy registered twice. The one registry warning (`room_decision_finalized`
/ `room_decision_superseded` listed but never emitted) predates P7 and is
unchanged; the two P8 events are emitted and listed. Five log lines per
boot.

## 11. Fresh clone (§85)

`p8-freshclone.sh` from the tip `114c0e4` into an empty directory (nothing
carried: 0 `node_modules`, 0 `dist*`, 0 db files; node v22.22.2, npm
10.9.7), `p8-freshclone.out`:

| Step | Result |
| --- | --- |
| install (server, e2e, then each app) | rc=0 ×7 |
| schema declared | `SCHEMA_VERSION = 2308`, 18 migrations |
| boot on a cold store | `/health` ok, `X-ScoutBox-Schema: 2308`, store files created, port 4141 released |
| five typechecks | 5 / 5 |
| five builds / export | 5 / 5 with `index.html` |
| m23RecruitmentJourneyE2E (journey E2E) | 168 checks passed, 86 negative |
| m23RecruitmentJourneyPersistence (persistence) | 85 checks passed, 10 negative |
| m23OfferHardeningE2E (Offer hardening) | all checks passed |
| m23SigningHardeningE2E (Signing hardening) | all checks passed |
| m23TemporalIntegrityE2E (Temporal) | 493 checks passed |
| m23AgentIntegrationE2E (Agent integration) | 535 checks passed |
| one real Club → Player journey and one Agent authorization-loss journey | m23RecruitmentJourneyLive 85 (groups A–E, P; G6–G7 end the representation and the line is gone on the next read) |
| the entry credit | entryCredit 31 |
| cleanup | no live surviving server / suite / chromium / vite process |

## 12. Flakes

Every server-side lane passed on its first run at its tip. In the browser
battery, two P5.6 suites were red once on the first pass over bundles built
from the tip and green on the rerun after a test-side fix each (T-P8-11,
T-P8-12): one was a sweep that had never seen the P6 tab label (a stale
bundle had hidden it), the other two reads that raced a card's re-read.
Neither was a product defect; both assertions are now bounded waits. Earlier
red runs of the P8 suites were the assertion mistakes in the defect register
(T-P8-1 … T-P8-10), each fixed once, and D-P8-15, which was a real crash.
Known P8 flakes: 0.
