# M23 P8 — Full Recruitment Journey Integration: final report

Branch `claude/desktop-project-migration-wyk3ec`, from the frozen tip
`c559fb7` (the credit commit; local = remote at Stage 0). Local commits
R1–R6 and this documentation commit only — **no push, no PR, no deploy, no
migration** — as the mandate requires (§97–§99). The history through
`c559fb7` is untouched; the credit line stays on every entry surface.

The governing principle, now carried by ONE projection rather than by the
memory of the people using the product:

    Evidence informs assessment; assessment informs discussion; discussion
    ends in an explicit human decision; a decision is not an Offer; an
    Offer is not its acceptance; acceptance is not a signing; a signing
    is not its completion.

Two findings mattered most. The P2 self-service availability route let an
adult player write `under_contract` — or write over it after a canonical
signing — so contract truth had two authoritative writers; the route now
refuses that word and locks the others while a canonical contract stands.
And the legacy recording route let an agency user or a club scout create a
signing row, a contract word and an invoice; it is clubs-and-leads only
now. The rest of the work made the frozen domains read as one journey: the
server derives the stage, the completed stages, the current resources and
the ONE next action; every client renders and never computes.

## The 85 items (§94)

| # | Item | Answer |
| --- | --- | --- |
| 1 | starting tip | `c559fb7` (local = remote, 0/0, clean, schema 2308, `origin/main` `b2eca8e`) |
| 2 | final local tip | the documentation commit that contains this file (its hash is in the delivery message; a file cannot contain its own commit's hash). Final functional tip R5 `3cf34b9`; R6 `6d366c1` (two test files) |
| 3 | remote tip | `c559fb7` — unchanged; `origin/main` `b2eca8e` unchanged |
| 4 | schema | **2308**, unchanged; `SCHEMA_VERSION = 2308`, 18 migrations (clean boot, fresh clone) |
| 5 | migration | none added; the ledger applies 0 steps on replay (persistence 4; clean boot 2) |
| 6 | source-of-truth map | M23_P8_RECRUITMENT_JOURNEY_SOURCE_OF_TRUTH.md: discovery plus the 18 frozen states, each with store, writer, evidence, lifecycle representation, who acts, who reads, forward, backward, terminal, notifications, events, analytics, primary UI, deep link |
| 7 | lifecycle writer audit | M23_P8_LIFECYCLE_WRITER_AUDIT.md: ONE writer (`applyStatus` behind `ctx.applyLifecycleTransition`, m17); every other site classified; the three findings (legacy status route role parity, reopen bridge guard, m29 rollback) fixed; journey E2E Z1–Z2, Z11, Z13 guard the classification from the source |
| 8 | contract-status writer audit | M23_P8_CONTRACT_STATUS_WRITER_AUDIT.md: `under_contract` is assigned in one file (m29); every other `contractStatus` assignment sits behind the two refusals or the release guard (Z3–Z4) |
| 9 | projection | `buildRecruitmentJourney` → the `journey` block: `caseId`, `playerId`, `clubOrgId`, lifecycle status, canonical stage, completed stages (basis + instant + record id), resources, `nextAction` (with `blockedBy`), `classification`, `integrity`, the audience summary; no new store (Z8–Z10) |
| 10 | next action | 24 codes in `NEXT_ACTIONS`, derived on the server (`nextActionFor`, `playerNextActionFor`); the mapping of §7 holds (A13–A19); never a lifecycle state (§8); no client manufactures one (Z16) |
| 11 | current-resource selection | M23_P8_CURRENT_RESOURCE_SELECTION.md: `currentContactForCase`, `currentTrialForCase`, `currentAssessmentForCase`, `currentDecisionForCase`, `currentOfferForCase` (P6), `currentSigningForOffer` (P7.1, now also the m29 summary's rule, D-P8-13); deterministic tiers, newest first, id tie-break; fed this case's rows only (D-P8-16) |
| 12 | Club journey | the Journey strip at the head of the Room: stage rail, ONE next action that performs or opens the tab where the record is made, classification note, "changed" sentence, refresh on event / focus / visibility; the timeline on the Activity tab; live A–E, W |
| 13 | Player journey | `GET /player/journeys`: per club — what was shared, a player word for the stage, the player's next action, their resource ids, a visible-only timeline; the app's journey section and tappable bell rows; never a case id, lifecycle word, priority, decision, assessment, rationale or note (B10, B41, B44, F, live P) |
| 14 | Agent journey | `GET /org/agent/clients/:id/journey`: only with a live representation, the grants and a share; factual stage, Offer, package, Trial, Contact where routed; refused (403) when the representation ended; the agency admin and the same-agency colleague read nothing (F1–F8, C12, live G) |
| 15 | Grassroots | the same strip, next action, timeline and conflict UX; the Signing tab ported (D-P8-9); minors, the 50 km rule and verification unchanged; a grassroots Room never shows a pro stage it cannot reach (the next action's `permitted` and `blockedBy` decide) |
| 16 | Admin / T&S | operational visibility only; no lifecycle-advance route; the block lift re-derives every gate on the next read (M23_P8_JOURNEY_BLOCK_MATRIX.md) |
| 17 | timeline | derived from records and history, never from clicks: watch, review, Contact sent / answered, Trial requested / scheduled / completed, assessment submitted, decision finalized, Offer issued / accepted, signing started / completed (B40, B42, live A) |
| 18 | timeline privacy | M23_P8_JOURNEY_TIMELINE_PRIVACY_MATRIX.md: Club / Player / Guardian / authorized Agent / same-agency Agent / T&S / foreign club, per event; the player and agent views strip the Contact record id and the colleague's name (B10, B43–B44, F4) |
| 19 | Contact → Trial | a draft is not `contacted` (B7), a failed or blocked Contact moves nothing (C1), the invitation must belong to the case (evidence `trial_invited`, D11), same case / player / org (C4) |
| 20 | Trial → Assessment | `trial_completed` is not an assessment (B18); the assessment names the exact Trial (`context.trialId`, B19); no automatic positive assessment |
| 21 | Assessment → Decision | an assessment is not a decision (B20); `offer_consideration` only through a finalized decision (B21); CV / Trust never decide (Z6–Z7, A22) |
| 22 | Decision → Offer | `progress` moves the case and creates no Offer (B22); next action `PREPARE_OFFER` opens the Offer tab and creates nothing (live A) |
| 23 | Offer → Signing | acceptance moves the case and creates no package or row (B28); `START_SIGNING` is an explicit act (B29) |
| 24 | Signing → Signed | completion writes exactly one `db.signings` row (B37), moves the case through the canonical seam (B36), sets `under_contract` (B38); the projection says complete; a fault after the move rolls the case back whole (Q2) |
| 25 | contractStatus resolution | the self-service route is retired for `under_contract` and non-authoritative for the other words while a canonical contract stands (D-P8-1; H6–H9) |
| 26 | under_contract authority | the canonical completed signing (m29) is the only writer (Z3); the legacy recording route stays a club-lead-only compat path (D-P8-2; H10–H12) |
| 27 | affiliation | derived by the Passport from the completed-signing row (dates, `orgId`, `playerId`, `signingPackageId`); one authoritative writer; rows never deleted; retries refused per package and Offer; the journey writes no affiliation (audit §5) |
| 28 | analytics | M23_P8_ANALYTICS_CANONICALIZATION.md: each of the §42 metrics named with its canonical source and its counting unit (case / resource / revision / event) |
| 29 | funnel | `journey_evidence_funnel`: thirteen case-based stage rows from the records, history-only counts beside; reviewed → contacted → trialled → offer → signed with no ranking (I1–I7, I9) |
| 30 | time-to-stage | canonical intervals (Contact → trial scheduled, trial completed → decision, decision → Offer issued, Offer accepted → signing started, signing started → signed) from the records' instants, medians in days (I8) |
| 31 | notifications | no contradictory row: each is decorated at read time with a `target` resolved against the current authorized resource; an Offer accepted after `signed` or a Trial for a cancelled package resolves to what is current (G1–G8; M23_P8_NOTIFICATION_DEEPLINK_AUDIT.md) |
| 32 | deep links | Contact → Inbox / Room Contact tab; Trial → Trial; Offer → the live revision; Signing → the current package; the Room's tabs are addressable (`#/recruitment/rooms/:id/:tab`) (live D, E; G3, G8) |
| 33 | stale deep links | a superseded or cancelled package's link opens the current one and says so; a revoked agent's link is refused; an ended case's tabs are read-only (G7, live D1–D7) |
| 34 | Inbox | stays infrastructure: requests and answers only; no Trial / Offer / Signing chat (source-of-truth rows; M23 P3 unchanged) |
| 35 | Second Look | never overwrites the original decision; the bridge reopens a withdrawn / archived / closed room only (D-P8-6; H5) |
| 36 | Nobody Missed | coverage tooling; a brief is discovery, never a case move (source-of-truth §0) |
| 37 | Matching | surfaces only; no lifecycle write (Z5 source scan of m19) |
| 38 | Trust | evidence-confidence only; never a stage input (A22, C-group #15) |
| 39 | Box Cam / CV | evidence only; a CV refusal is never a negative decision (Z5, #17) |
| 40 | minors | no new agent / Offer / signing pathway; the child's journeys carry no Offer and no signing; the guardian reads the child's, not another's (C7–C10, #20) |
| 41 | same-agency | the colleague and the agency admin read no journey (F6, C12, live G5); authority re-derived on every read (F7, live G7) |
| 42 | block matrix | M23_P8_JOURNEY_BLOCK_MATRIX.md; C1, A21; nothing erased, nothing advanced |
| 43 | cross-resource | a Trial, package or Offer of case B cannot attach to case A (C4–C5, #18, #52); a foreign case and a fabricated id read the same (C6, F8) |
| 44 | legacy | M23_P8_LEGACY_JOURNEY_COMPATIBILITY.md; D1–D12; persistence 3; nothing fabricated, nothing repaired, no crash |
| 45 | credit regression | entryCredit 31 (Club, Grassroots, Agent, Admin, Player onboarding; six widths), demoFreshness 21 (the credit in every demo bundle); `c559fb7` untouched |
| 46 | journey E2E | `m23RecruitmentJourneyE2E` 168 checks, 86 negative, green |
| 47 | persistence | `m23RecruitmentJourneyPersistence` 85 checks (nine checkpoints across SIGTERM restarts; legacy cases across five), green |
| 48 | live | `m23RecruitmentJourneyLive` 85 checks, 13 negative, six widths, zero page errors, green |
| 49 | Contact regression | m23ContactE2E 428, m23ContactPersistence 61, m23ContactLive (browser battery) — green |
| 50 | Trial regression | m23TrialE2E 535, m23TrialPersistence 36, m23TrialLive — green |
| 51 | Decision regression | m23DecisionE2E 435, m23DecisionPersistence 48, m23DecisionLive — green |
| 52 | Offer regression | m23OfferE2E 447, m23OfferPersistence 94, m23OfferLive 98 — green |
| 53 | Offer hardening | m23OfferHardeningE2E 259, m23OfferHardeningLive 53 — green |
| 54 | Signing regression | m23SigningE2E 255, m23SigningPersistence 119, m23SigningLive 134 — green |
| 55 | Signing hardening | m23SigningHardeningE2E 212, m23SigningHardeningLive 68 — green |
| 56 | Temporal | m23TemporalIntegrityE2E 493 — green |
| 57 | Agent | m23AgentE2E 407, persistence 68, compliance 346 / 83, transaction 404 / 63, integration 535, final hardening 286, P5.6E repair audit 179, the four agent live suites — green |
| 58 | server battery | **46 / 46** green (baseline 45 + the two P8 suites) |
| 59 | apiE2E | **130 / 130** |
| 60 | browser battery | **20 / 20** green (baseline 18 + the two P8 suites), every bundle built from the tip; two P5.6 suites were red on the first fresh-bundle pass for test-side reasons (T-P8-11, T-P8-12) and green after the fix at `114c0e4` |
| 61 | typecheck | 5 / 5 |
| 62 | build | 5 / 5 (four `vite build`, one `expo export`) with `index.html` |
| 63 | demo freshness | 21 / 21; every demo bundle at the source fingerprint, build sha `3cf34b9`, credit present |
| 64 | EN / FR | Club 241 / 241, Grassroots 241 / 241, Agent 34 / 34, Player 5 / 5 P8 keys; the French tables are typed `typeof en` |
| 65 | a11y | test report §8 (A28a, B4a, C4a; one `aria-current` step; polite live region; `aria-describedby` on a refused act; no colour-only state) |
| 66 | perf | test report §9: club projection 3.73 ms at 5 000 cases; no N+1, no aggregator over every case; the timeline no longer scales with the store |
| 67 | clean boot | empty store → schema 2308 (18 steps), store files created, a 30 February refused / a real day accepted, port released after stop; 0 duplicate registrations (test report §10) |
| 68 | replay | second boot on the same store: 2308, the record persisted, the ledger applied 0 steps; the one registry warning predates P7 |
| 69 | fresh clone | from `114c0e4` into an empty directory: install ×7, schema 2308 / 18, cold-store boot, 5 typechecks, 5 builds, journey E2E 168, persistence 85, Offer hardening, Signing hardening, Temporal 493, Agent integration 535, one Club → Player journey and one Agent authorization-loss journey (journey live 85), the credit (31), no surviving process (test report §11) |
| 70 | bundles | R1 `f9cd116`, R2 `0b4106a`, R3 `deadbbc`, R4 `88b96d4`, R5 `3cf34b9`, R6 (this documentation commit, from `c559fb7`), each a git bundle with its SHA256 in the delivery message |
| 71 | Critical found / fixed | 0 / 0 |
| 72 | High found / fixed | 2 / 2 (D-P8-1, D-P8-2) |
| 73 | Medium found / fixed | 12 / 12 |
| 74 | Low found / fixed | 2 / 2 |
| 75 | open Critical | 0 |
| 76 | open High | 0 |
| 77 | open reasonably-fixable Medium | 0 |
| 78 | open sec / priv / auth / integrity Low needing repair | 0 (N-P8-1 … N-P8-5 recorded: product decisions outside P8, no authoritative truth affected) |
| 79 | flakes | 0 (test report §12) |
| 80 | tree | clean at the final tip |
| 81 | ahead / behind | 8 ahead of `origin/claude/desktop-project-migration-wyk3ec` (`c559fb7`), 0 behind — R1–R5, the two R6 test commits and this documentation commit |
| 82 | pushed? | **NO** |
| 83 | PR? | **NO** |
| 84 | deployed? | **NO** |
| 85 | ready for P8.1? | **YES** — the §93 gate holds (M23_P8_RELEASE_READINESS.md); P8.1 is not begun (§92, §99) |

## Truth block (§95)

    Starting tip: c559fb7 / Remote starting tip: c559fb7
    P8 Full Recruitment Journey Integration complete: YES
    One canonical recruitment journey projection exists: YES
    Journey projection duplicates authoritative state in a new store: NO
    Discovery automatically advances recruitment: NO / Matching automatically advances recruitment: NO / Trust Score automatically advances recruitment: NO / Box Cam automatically advances recruitment: NO
    Draft Contact marks contacted: NO / Failed Contact marks contacted: NO
    Trial request equals scheduled: NO / Trial scheduled equals completed: NO / Trial completed equals Assessment: NO / Assessment equals Decision: NO
    Progress Decision automatically creates Offer: NO / Offer issue automatically accepts Offer: NO / Offer acceptance automatically creates Signing: NO / Signing start automatically sets signed: NO
    Only canonical Contact evidence supports contacted: YES / Only canonical Trial evidence supports trial stages: YES / Only explicit human Decision supports decision progression: YES / Only canonical Offer supports offer states: YES / Only canonical Signing supports new signed states: YES
    Independent Player self-service route can set authoritative under_contract: NO / Canonical completed contract owns authoritative contract state: YES
    Club journey connected end-to-end: YES / Player journey connected appropriately: YES / Agent journey connected with narrower authorization: YES
    Player can see Club internal watchlist state: NO / Player can see private assessment: NO / Player can see decision rationale: NO
    Same-agency unrelated Agent can see journey: NO / Agency admin automatically sees client journey: NO
    Minor Agent pathway newly opened: NO / Minor Offer pathway newly opened: NO / Minor Signing pathway newly opened: NO
    Cross-case Contact confusion possible: NO / Cross-case Trial confusion possible: NO / Cross-case Decision confusion possible: NO / Cross-case Offer confusion possible: NO / Cross-case Signing confusion possible: NO
    Current resource selection deterministic: YES / Expired signing package can mask current live package: NO / Superseded Offer can become current actionable Offer: NO
    Notifications point to canonical current resources: YES / Deep links reauthorize live: YES / Stale deep links remain actionable: NO
    Journey analytics use canonical truth: YES / Retries double-count funnel metrics: NO
    Legacy cases fabricate modern evidence: NO
    "Built by Guni & Younes" preserved: YES / Entry-screen credit regression passed: YES
    m23RecruitmentJourneyE2E passed: YES / m23RecruitmentJourneyPersistence passed: YES / m23RecruitmentJourneyLive passed: YES
    Contact regression passed: YES / Trial regression passed: YES / Decision regression passed: YES / Offer regression passed: YES / Offer hardening passed: YES / Signing regression passed: YES / Signing hardening passed: YES / Temporal suite passed: YES / Agent regressions passed: YES
    Full server battery: 46 / 46 / apiE2E: 130 / 130 / Browser battery: 20 / 20 / Five-app typecheck: 5 / 5 / Five-app build/export: 5 / 5 / Demo freshness: 21 / 21 / EN/FR parity: YES / Accessibility verified: YES / Perf/load: YES / Clean boot: YES / Replay: YES / Fresh clone: YES / Recovery bundle created: YES (R1–R6)
    Open Critical: 0 / Open High: 0 / Open reasonably-fixable Medium: 0 / Open sec/priv/auth/integrity Low needing repair: 0 / Known P8 flakes: 0
    P8 pushed: NO / PR created: NO / Deployment performed: NO

## Conclusion

    M23 P8 FULL RECRUITMENT JOURNEY INTEGRATION COMPLETE
    SCOUTBOX NOW HAS ONE COHERENT CANONICAL RECRUITMENT JOURNEY
    DISCOVERY MATCHING TRUST SCORE AND BOX CAM DO NOT AUTOMATICALLY ADVANCE PLAYERS
    CONTACT TRIAL ASSESSMENT DECISION OFFER AND SIGNING REMAIN DISTINCT AUTHORITATIVE STAGES
    THE CLUB CAN MOVE THROUGH THE FULL JOURNEY WITHOUT DEAD-END WORKFLOWS
    THE PLAYER SEES ONLY PLAYER-RELEVANT RECRUITMENT ACTIONS
    THE AGENT SEES ONLY CURRENTLY AUTHORIZED FACTUAL WORKFLOW
    SAME-AGENCY MEMBERSHIP DOES NOT LEAK JOURNEY DATA
    CURRENT RESOURCE SELECTION IS DETERMINISTIC
    STALE RESOURCES CANNOT MASK CURRENT ACTIONABLE RESOURCES
    NOTIFICATIONS AND DEEP LINKS RESOLVE TO CURRENT AUTHORIZED WORKFLOW
    THE INDEPENDENT PLAYER CONTRACT-STATUS WRITER CANNOT BYPASS CANONICAL SIGNING
    CANONICAL COMPLETED CONTRACT STATE OWNS AUTHORITATIVE UNDER_CONTRACT TRUTH
    JOURNEY ANALYTICS DERIVE FROM CANONICAL EVIDENCE
    LEGACY CASES DO NOT FABRICATE MODERN EVIDENCE
    BUILT BY GUNI & YOUNES REMAINS PRESENT ON THE INTENDED ENTRY SURFACES
    ZERO KNOWN CRITICAL DEFECTS
    ZERO KNOWN HIGH DEFECTS
    ZERO KNOWN REASONABLY-FIXABLE MEDIUM DEFECTS
    ZERO KNOWN SECURITY PRIVACY AUTHORIZATION OR DATA-INTEGRITY LOW DEFECTS REQUIRING REPAIR
    P8 IS READY FOR M23 P8.1 FULL LIFECYCLE ADVERSARIAL HARDENING

Work stopped here, as §99 requires: P8.1 and M24 are not begun, nothing
was pushed, no pull request was opened, nothing was deployed.
