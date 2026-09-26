# M23 P8.1 — Full Lifecycle Adversarial Hardening: final report

Branch `claude/desktop-project-migration-wyk3ec`, from the frozen P8 tip
`b61ef14` (local = remote at Stage 0, 0/0, clean, schema 2308,
`origin/main` `b2eca8e`). Local commits R1–R6 only — **no push, no PR, no
deploy, no migration, no history rewrite** — as the mandate requires
(§93–§95). The history through `b61ef14` is untouched; the credit line
stays on every entry surface.

P8 made the recruitment journey one coherent thing. P8.1 attacked it as one
system — stale tabs, races, authority loss, blocks landing mid-stage, old
links, restarts and partial failures, corrupt stores, legacy rows, second
cases, same-agency colleagues, late and duplicate notifications, analytics
under retries — and fixed what broke without adding a state, a store, a
scoring rule or a pathway.

Four findings mattered most. A paused case with a live Offer or a
presented package could never be signed on that case: the resume always
landed on `under_review` and every route back was closed (D-P81-1, High).
A second case for the same player inherited the ended case's assessment,
and the player's own line for it showed a Trial they never reached with
that case (D-P81-15, with its analytics twin D-P81-18). A corrupt record
that named a case was silently dropped and the case then read as sound
legacy data with a live-looking act (D-P81-17). And an agent whose
representation had ended kept a live-looking destination on every
notification for the Offer they had been shown (D-P81-14). The other
fourteen were narrower: the memory rate limiter could be emptied by
unauthenticated guesses, the legacy doors bypassed the canonical budgets and
dedupes, a room's evidence request could reach another player, a guardian
block could land on the wrong child, a block did not stop the discovery
reads, four replays lied about the current truth.

## The 97 items (§90)

| # | Item | Answer |
| --- | --- | --- |
| 1 | starting tip | `b61ef14` (local = remote, 0/0, clean, schema 2308, `origin/main` `b2eca8e`) |
| 2 | final local tip | the R6 documentation commit that contains this file (its hash is in the delivery message; a file cannot contain its own hash). Final FUNCTIONAL tip: R5 `1fe79cb` — R6 changes tests and documents only; the source trees of `1fe79cb` and the final tip are identical under `scoutbox-server/m*`, `scoutbox-*/src` |
| 3 | remote tip | `b61ef14` — unchanged; `origin/main` `b2eca8e` unchanged |
| 4 | schema | **2308**, unchanged; `SCHEMA_VERSION = 2308`, 18 migrations (clean boot, fresh clone, hardening Z19) |
| 5 | migration | none added; the ledger applies 0 steps on replay (persistence 4; clean boot 2) |
| 6 | attack surface | M23_P81_FULL_LIFECYCLE_ATTACK_SURFACE.md: 22 stage rows (18 states + discovery + assessment + decision + signing), 9 resource sub-state rows, 8 cross-cutting rows, and the five R5 audits (§5) |
| 7 | adjacent-stage matrix | M23_P81_ADJACENT_STAGE_MATRIX.md: every forward edge with its happy path, stale rev, replay, race, role loss, block, cross-case, cross-player, restart and malformed-input cell |
| 8 | stale-client matrix | M23_P81_STALE_CLIENT_MATRIX.md: 15 stale-tab shapes, each with the server's refusal and the client's re-read (hardening A; live L1, L3–L5) |
| 9 | race matrix | M23_P81_CROSS_STAGE_CONCURRENCY_MATRIX.md: 11 adjacent-stage pairs, one authoritative result each (hardening B1–B14) |
| 10 | cross-case | player A's Trial, Offer, package, decision refs and assessment never advance or appear on case B (hardening C1–C7, D1–D8) |
| 11 | cross-player | assessments, decision refs, evidence requests (D-P81-6), tasks (D-P81-13) stay with their player |
| 12 | cross-org | a foreign case, resource or id is concealed exactly like a fabricated one; no player identity in any refusal (hardening E1–E2, N1) |
| 13 | second-case | nothing inherited: no resource, no stage, no milestone, no player line, no analytics count (D-P81-15, D-P81-18; hardening C8–C11; persistence 5.3; live L8) |
| 14 | terminal re-entry | signed / withdrawn / archived / closed expose no live act; a reopen is the ONE way back and derives the next action afresh (hardening W, X) |
| 15 | lifecycle-ahead | `STALE_POINTER` + `LIFECYCLE_AHEAD_OF_EVIDENCE` when a claim is missing; legacy when nothing was claimed (hardening R, S; persistence 3) |
| 16 | evidence-ahead | `EVIDENCE_AHEAD_OF_LIFECYCLE` on a live case (D-P81-2; hardening G1–G4b); held and ended cases exempt (G7) |
| 17 | lifecycle rollback | a throw after the status write restores status, stage, rev, instants and history together; the retry succeeds once (hardening H1–H1c; the `lifecycle.after_status` seam) |
| 18 | signing rollback | a throw after the row or after the lifecycle move leaves no row, no `signed`, no contract word, no completed package; the retry writes exactly one row (hardening H2–H4; the P7.1 seams) |
| 19 | block matrix | M23_P81_BLOCK_TRANSITION_MATRIX.md: a block at every stage stops the club's forward act (403), allows the closure, erases nothing; the recipient may decline, not accept (hardening I1–I8) |
| 20 | club role loss | a demoted lead's act is withdrawn on the next read; a restricted room closes to the colleague; the stale act sent anyway is 403 (hardening J1–J7; live L4–L5) |
| 21 | org membership loss | the session is revoked at removal (401), the stream closed, no re-login (hardening J8–J10) |
| 22 | agent loss | licence lapsed / un-shared / representation ended / affiliation ended: the projection narrows or closes, the notification target vanishes (D-P81-14; hardening K1–K8; live L7) |
| 23 | same-agency | a colleague, the agency admin and an analyst see nothing on six routes, no document, no notification (hardening L1–L5; live L9) |
| 24 | player privacy | no case id, lifecycle word, priority, assessment, rationale, note, digest or club member's name on any player surface (hardening Y1–Y5; M23_P81_PRIVACY_HARDENING.md) |
| 25 | minor chain | the wall, guardian routing, no Offer, closed signing, no agency pathway — fail-closed end to end (hardening M1–M6) |
| 26 | malformed DOB | nine malformed shapes are NOT adult; the wall and the guardian rules hold (hardening M7–M9) |
| 27 | deep-link | M23_P81_DEEPLINK_MATRIX.md: every old link reauthorizes against current state; foreign = fabricated; a removed user's link is 401; a forged token is 401 (hardening N1–N6; live L5–L7) |
| 28 | notification ordering | late "Offer issued" / "Trial scheduled" / "Signing ready" / Contact rows resurrect nothing; retries duplicate nothing; every club target names a room and a tab (hardening O1–O9) |
| 29 | event ordering | clients only bump a refetch counter; two events in any order = two reads of canonical state (hardening P5, Z17) |
| 30 | duplicate events | a duplicated event is one more read; the timeline is derived from records, nothing added twice (hardening P5; O5–O6) |
| 31 | missed events | a dropped stream replays from `lastEventId` or resyncs; a tab that missed everything re-reads on focus / pageshow / visibility (R3; hardening P1, Z16; live L3–L4, L7) |
| 32 | restart checkpoints | nine P8 checkpoints + `under_review` identical across SIGTERM restarts (persistence 1, 5.1) |
| 33 | restart mid-mutation | key replays after a restart are idempotent; one signing row; no second completion; the resume still lands on the held-from state (hardening Q1–Q4; persistence 5.6) |
| 34 | corrupt pointers | a stale Offer pointer, a stale signing link, an unknown package status: `integrity_error`, the act blocked, never repaired (D-P81-16, D-P81-17; hardening R1–R4; persistence 5.2, 5.5) |
| 35 | unknown status | `LIFECYCLE_STATE_UNKNOWN` → `STATE_UNKNOWN`, no move; an unknown package status is never live (hardening R2–R3b) |
| 36 | legacy mix | the four shapes: nothing invented, the player learns only what reached them, the ordinary evidence rule holds (hardening S1–S5; persistence 5.4; M23_P81_LEGACY_COMPATIBILITY.md) |
| 37 | analytics | a refused or replayed request changes nothing; a second case adds nothing; no note / rank / score (hardening T1–T5; M23_P81_ANALYTICS_HARDENING.md) |
| 38 | reopen analytics | the definition (§2 of the analytics doc): the same case, the original cohort, first reach per state, `reopenedInCohort` reported, records after the reopen count once |
| 39 | time-to-stage | malformed instants prove nothing; negative visits and intervals are omitted, never negated (hardening T6; `firstAt`, `stageVisits`, `between`) |
| 40 | perf | 5 000 cases: club projection 19.9 ms, player journeys 118 ms over 100 cases, agent 1.2 ms; no N+1 (`m23JourneyPerf`) |
| 41 | auth-before-existence | org-scoped lookups first; the same body for foreign and fabricated; consent before the Box Cam lookup (D-P81-9); attack-surface §5.1 |
| 42 | rate-limit aliasing | the legacy doors draw on the canonical budgets and dedupe (D-P81-3, D-P81-4); the store evicts the fewest-hit buckets first and never resets a live budget (D-P81-5); attack-surface §5.2 |
| 43 | idempotency | a key is one resource, one action; it never crosses a stage and dies with authority; four replay honesty fixes (D-P81-10 … D-P81-12; hardening V1–V5); attack-surface §5.3 |
| 44 | client-trust | no request-body authority or resource truth is read anywhere in m17 / m181 / m23 / m24 / m27 / m28 / m29 (the sweep in attack-surface §5.4–§5.5; hardening Z17–Z18) |
| 45 | terminal | no live act on a terminal case; `CASE_ENDED` / `RECRUITMENT_COMPLETE` only (hardening W1–W9) |
| 46 | signed actions | a signed case offers nothing but its record; nothing is un-signed by a block (block matrix; hardening W) |
| 47 | withdrawn | read-only; reopen is the way back; history intact (hardening W, X; live L3) |
| 48 | archived | the same (hardening C8 setup; X1) |
| 49 | closed | the same (hardening W) |
| 50 | on_hold | a hold is a pause: the resume returns to the held-from state when its evidence stands, else `under_review`; nothing else leaves a hold (D-P81-1; hardening W10–W12, B5b; Signing E2E L7–L9; Offer hardening P10) |
| 51 | Second Look | reopen to `under_review`, the archive on the history, the old Offer by the ONE rule, a live case not reopenable (hardening X1–X4) |
| 52 | Matching / Watchlist | discovery, matching, Trust Score and Box Cam never advance a case (hardening E; P8 Z6–Z7 unchanged) |
| 53 | contact dup | one pending request per type through the legacy door; the canonical send keeps its cooldown and one-pending rule (D-P81-4; U3–U4; V1) |
| 54 | trial dup | two invitations while one is pending: both refused (hardening B2b) |
| 55 | decision dup | two finalizes: one head, one 409; a replay with different content conflicts (hardening B6, V2; D-P81-11) |
| 56 | offer dup | issue vs withdraw, two revisions: the P6.1 rules unchanged and green (hardening B8–B10b; Offer hardening) |
| 57 | signing dup | one row per package and per Offer; a second completion writes nothing; a legacy recording dedupes (D-P81-3; hardening B13–B14, Q3–Q4, U1–U2) |
| 58 | event privacy | registry-minimized payloads; no recruitment event names a note, a reason, terms or a digest (hardening P2, Y6) |
| 59 | notif privacy | notification text carries orgs and acts only; targets carry ids; an agent's target follows authority (hardening Y3–Y4, K7) |
| 60 | logging privacy | the R5 line-by-line sweep of every `console.error` in m23 / m28 / m29: ids and codes only (privacy doc §2) |
| 61 | entry credit | entryCredit 31 / 31 in the browser battery; demo freshness 21 / 21 |
| 62 | hardening E2E | `m23RecruitmentJourneyHardeningE2E`: 247 checks, 178 negative, green |
| 63 | journey E2E | `m23RecruitmentJourneyE2E`: 168 checks, 86 negative, green (unchanged) |
| 64 | persistence | `m23RecruitmentJourneyPersistence`: 139 checks (section 5 added), 25 negative, green |
| 65 | hardening live | `m23RecruitmentJourneyHardeningLive`: 57 checks, 19 negative, six widths, zero page errors, green |
| 66 | Offer hardening | `m23OfferHardeningE2E` and the P6.1 live suite green (P10/P10b re-pinned to the held-from resume) |
| 67 | Signing hardening | `m23SigningHardeningE2E` / `m23SigningE2E` and the P7.1 live suites green (L7–L9 re-pinned) |
| 68 | Temporal | `m23TemporalIntegrityE2E` green (battery; fresh clone) |
| 69 | Agent regressions | `m23AgentIntegrationE2E` 535 checks, compliance, transaction, agent and grassroots suites green (battery; browser battery) |
| 70 | server battery | 47 / 47 (46 P8 suites + the hardening suite) on the recorded run, alone at the tip; the first run, concurrent with the browser lane's bundle exports, had one boot timeout (F-P81-1, explained and fixed test-side) |
| 71 | apiE2E | 130 / 130 (both runs) |
| 72 | browser battery | 21 / 21 (20 P8 suites + the hardening live suite) with three assertions re-pinned to P8.1's own rules (T-P81-26, T-P81-27) and one timing check made to wait (T-P81-28); every suite green at the tip in a full lane run or the standalone rerun (test report §4) |
| 73 | typechecks | 5 / 5 (agent, club, grassroots, admin, player) |
| 74 | builds | 5 / 5 (four Vite builds, one Expo export; `index.html` present in each) |
| 75 | demo freshness | 21 / 21 after `buildDemos` at the tip |
| 76 | EN/FR | no client string added by P8.1; parity unchanged (test report §6) |
| 77 | a11y | the labelled strip, `aria-current`, the polite live region and `aria-describedby` re-proved in the browser battery (test report §6) |
| 78 | perf | item 40; m23JourneyPerf rerun in the battery |
| 79 | clean boot | schema 2308 on an empty store, 18 migrations applied once, port released (test report §8) |
| 80 | replay | boot 2 applied 0 steps; the open day persisted (test report §8) |
| 81 | fresh clone | from `1fe79cb` into an empty directory: install, schema 2308 / 18 migrations, cold boot on :4141 (released), five typechecks, five builds, seven server suites and three live suites all green (test report §9) |
| 82 | bundles | R1 `46373ff` `1f2679ff…`, R2 `5607cf6` `0df33be1…`, R3 `520d802` `fec20df5…`, R4 `b161025` `a10f5466…`, R5 `1fe79cb` `93120fc2…`, R6 in the delivery message (full SHA-256 lines in `p81-bundles.txt`) |
| 83 | Critical found / fixed | 0 / 0 |
| 84 | High found / fixed | 1 / 1 (D-P81-1) |
| 85 | Medium found / fixed | 11 / 11 (D-P81-2 … D-P81-8, D-P81-14, D-P81-15, D-P81-17, D-P81-18) |
| 86 | Low found / fixed | 6 / 6 (D-P81-9 … D-P81-13, D-P81-16) |
| 87 | open Critical | 0 |
| 88 | open High | 0 |
| 89 | open reasonably-fixable Medium | 0 |
| 90 | open sec / priv / auth / integrity Low needing repair | 0 (seven findings recorded as N-P81-1 … N-P81-7: frozen model or deliberate rule, none touching authoritative truth) |
| 91 | flakes | 0 unexplained; two lane intermittents explained and fixed on the test side (F-P81-1 boot ceiling under CPU contention, F-P81-2 a timing assumption) — test report §10 |
| 92 | tree | clean at the final tip |
| 93 | ahead / behind | 6 ahead of `origin/claude/desktop-project-migration-wyk3ec` (R1–R6), 0 behind; `origin/main` `b2eca8e` unchanged |
| 94 | pushed? | **NO** |
| 95 | PR? | **NO** |
| 96 | deployed? | **NO** |
| 97 | ready for M24? | **YES** — P8.1 is ready for M24 design system & full app redesign; M24 is not begun |

## Truth block (§91)

    Starting tip: b61ef14 / Remote starting tip: b61ef14
    P8.1 Full Lifecycle Adversarial Hardening complete: YES
    Stale client can overwrite newer truth: NO
    Cross-case resource confusion possible: NO / Cross-player resource confusion possible: NO / Cross-org journey leak possible: NO
    Second case inherits stale resources: NO
    Terminal case masks live action: NO
    Lifecycle ahead of evidence undetected: NO / Evidence ahead of lifecycle undetected: NO
    Lifecycle rollback can leave partial state: NO / Signing rollback can leave partial state: NO
    Block preserves club action power: NO
    Removed role preserves authority: NO / Removed membership preserves access: NO / Expired or ended agent authority preserves access: NO
    Same-agency colleague sees journey: NO / Agency admin sees journey: NO
    Player sees club internals: NO
    Minor agent pathway opened: NO / Minor Offer pathway opened: NO / Minor signing pathway opened: NO
    Malformed DOB treated as adult: NO
    Old deep link bypasses current authorization: NO
    Late notification resurrects stale action: NO / Out-of-order event mutates client state: NO / Duplicate event duplicates anything: NO / Missed event leaves a stale action usable: NO
    Restart duplicates lifecycle or signing state: NO
    Corrupt current-resource pointer widens authority: NO / Unknown resource status reads as open: NO
    Legacy case fabricates modern evidence: NO
    Retries double-count analytics: NO / Reopen double-counts analytics: NO / Malformed timestamps produce durations: NO
    Idempotency key acts as a cross-stage capability: NO / Rate limit can be aliased through a legacy route: NO
    Signed case exposes recruitment actions: NO / Terminal case exposes recruitment actions: NO
    Discovery, Matching, Trust Score or Box Cam advance a case: NO / Offer acceptance creates a signing: NO / Signing start sets signed: NO
    "Built by Guni & Younes" preserved: YES
    m23RecruitmentJourneyHardeningE2E passed: YES / m23RecruitmentJourneyE2E passed: YES / m23RecruitmentJourneyPersistence passed: YES / m23RecruitmentJourneyHardeningLive passed: YES
    Offer hardening passed: YES / Signing hardening passed: YES / Temporal integrity passed: YES / Agent regressions passed: YES
    Full server battery: 47 / 47 / apiE2E: 130 / 130 / Browser battery: 21 / 21 / Five-app typecheck: 5 / 5 / Five-app build/export: 5 / 5 / Demo freshness: 21 / 21
    EN/FR parity: YES / Accessibility: YES / Performance: YES / Clean boot: YES / Replay: YES / Fresh clone: YES / Bundles: YES
    Open Critical: 0 / Open High: 0 / Open reasonably-fixable Medium: 0 / Open sec/priv/auth/integrity Low needing repair: 0
    Known P8.1 flakes: 0
    P8.1 pushed: NO / PR created: NO / Deployment performed: NO

## Conclusion

    M23 P8.1 FULL LIFECYCLE ADVERSARIAL HARDENING COMPLETE
    THE FULL RECRUITMENT JOURNEY REMAINS COHERENT UNDER STALE CLIENTS RACES RESTARTS AND CORRUPTION
    CROSS-CASE CROSS-PLAYER AND CROSS-ORG RESOURCES CANNOT BE CONFUSED
    SECOND CASES FOR THE SAME PLAYER DO NOT INHERIT STALE RESOURCES
    LIFECYCLE AND CANONICAL EVIDENCE CANNOT SILENTLY DIVERGE
    LIFECYCLE AND SIGNING ROLLBACK REMAIN ATOMIC
    STALE CLUB AGENT AND GUARDIAN AUTHORITY DOES NOT PRESERVE ACTION POWER
    SAME-AGENCY MEMBERSHIP DOES NOT LEAK JOURNEY DATA
    PLAYER PRIVACY REMAINS NARROW
    MINOR SAFEGUARDS REMAIN FAIL-CLOSED THROUGH THE ENTIRE JOURNEY
    DEEP LINKS REAUTHORIZE CURRENT ACCESS
    LATE OR DUPLICATE EVENTS AND NOTIFICATIONS DO NOT RESURRECT STALE ACTIONS
    RESTARTS DO NOT DUPLICATE LIFECYCLE OR SIGNING STATE
    CORRUPT CURRENT-RESOURCE POINTERS AND UNKNOWN STATES FAIL CLOSED
    LEGACY CASES DO NOT FABRICATE MODERN EVIDENCE
    JOURNEY ANALYTICS REMAIN CANONICAL UNDER RETRIES REOPENING AND LEGACY DATA
    IDEMPOTENCY CANNOT BECOME A CROSS-STAGE CAPABILITY TOKEN
    TERMINAL CASES DO NOT EXPOSE INVALID RECRUITMENT ACTIONS
    DISCOVERY MATCHING TRUST SCORE AND BOX CAM STILL DO NOT AUTOMATICALLY ADVANCE PLAYERS
    OFFER ACCEPTANCE STILL DOES NOT CREATE SIGNING
    SIGNING START STILL DOES NOT CREATE SIGNED STATE
    BUILT BY GUNI & YOUNES REMAINS PRESENT
    ZERO KNOWN CRITICAL DEFECTS
    ZERO KNOWN HIGH DEFECTS
    ZERO KNOWN REASONABLY-FIXABLE MEDIUM DEFECTS
    ZERO KNOWN SECURITY PRIVACY AUTHORIZATION OR DATA-INTEGRITY LOW DEFECTS REQUIRING REPAIR
    P8.1 IS READY FOR M24 DESIGN SYSTEM & FULL APP REDESIGN

Work stopped here, as the mandate requires: M24 is not begun, nothing was
pushed, no pull request was opened, nothing was deployed.
