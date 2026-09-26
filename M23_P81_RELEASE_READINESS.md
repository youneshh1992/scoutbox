# M23 P8.1 — Full lifecycle adversarial hardening: release readiness

The §89 gate, each line with its proof. Counts are from M23_P81_TEST_REPORT.md
(the R6 lanes at the final functional tip).

## 1. The gate

| Requirement | State | Evidence |
| --- | --- | --- |
| Open Critical | 0 | M23_P81_DEFECT_REGISTER.md — none found |
| Open High | 0 | D-P81-1 (hold / resume dead end) fixed R1 |
| Open reasonably-fixable Medium | 0 | D-P81-2 … D-P81-8 fixed R1; D-P81-14, D-P81-15, D-P81-17 fixed R4; D-P81-18 fixed R5 |
| Open security / privacy / authorization / data-integrity Low needing repair | 0 | D-P81-9 … D-P81-13 fixed R1; D-P81-16 fixed R4 |
| Known P8.1 flakes | 0 | every R6 lane first-run green at the tip (test report §10) |
| The full journey passes | yes | journey E2E B (25 steps), persistence 1 (nine checkpoints) + 5, hardening live L1–L9, journey live A |
| Stale clients pass | yes | hardening A1–A8b; live L1, L3–L5; the stale-client matrix |
| Races pass | yes | hardening B1–B14; the concurrency matrix (one authoritative result per pair) |
| Isolation passes (cross-case / cross-player / cross-org / second case) | yes | hardening C1–C11, D1–D8, E1–E6, S; persistence 5.3; live L8 |
| Authority loss passes (club role, org membership, agent, guardian) | yes | hardening J1–J10, K1–K8, L1–L5, M13; live L4, L5, L7, L9 |
| Deep links pass | yes | hardening N1–N6; live L5–L7; the deep-link matrix |
| Restart passes | yes | persistence 1–5 (nine + one checkpoints, five planted restarts, key replays, block and role loss across restarts); hardening Q1–Q4 |
| Analytics pass | yes | hardening T1–T7c; persistence 5.9; m20E2E; M23_P81_ANALYTICS_HARDENING.md |
| No frozen boundary weakened | yes | hardening Z1–Z22 (one new integrity code, still 24 next actions, 18 states, 19 semantic actions, 4 terminal states, schema 2308, 18 migrations, no journey store, no m23 module writes a contract word); the P3–P8 batteries unchanged and green |
| All platform regressions green | yes | server battery 47 / 47 (46 + the hardening suite), apiE2E 130 / 130, browser battery 21 / 21 (20 + the hardening live suite), five typechecks, five builds, demo freshness 21 / 21 — test report §1–§6 |

## 2. The mandate's conditions, each with its proof

| Condition | Proof |
| --- | --- |
| A stale client never overwrites newer truth (§5) | hardening A1–A8b (every stale rev, revision and package revision refused; the hold refuses a signature); live L1 (a race: one authoritative result), L3–L4 |
| Adjacent-stage races produce one authoritative result (§6) | hardening B1–B14; M23_P81_CROSS_STAGE_CONCURRENCY_MATRIX.md |
| No cross-case, cross-player or cross-org resource can advance a case (§7–§9) | hardening C1–C11, D1–D8, E1–E6; D-P81-6 (a room's evidence request reaches its own player only) |
| A second case inherits nothing (§11, §12) | hardening C8–C11; persistence 5.3; live L8; D-P81-15, D-P81-18 |
| Terminal states expose no live act; holds resume to the held-from state (§47–§55) | hardening W1–W12, X1–X4; D-P81-1 |
| Lifecycle ahead of evidence and evidence ahead of lifecycle are both detected and block the act (§13, §14) | hardening G1–G7, R1–R4; D-P81-2 (`EVIDENCE_AHEAD_OF_LIFECYCLE`), D-P81-17 (`RECORD_CORRUPT`), D-P81-16 |
| Lifecycle and signing rollback are atomic (§15, §16) | hardening H1–H5b (three fault seams); M23_P81_ROLLBACK_RECOVERY_AUDIT.md |
| A block stops what comes next and erases nothing (§17) | hardening I1–I8; M23_P81_BLOCK_TRANSITION_MATRIX.md (refusals are 403; the recipient may decline, not accept) |
| Removed roles, memberships and agent authority preserve no power (§18–§20) | hardening J1–J10, K1–K8; live L4, L5, L7; D-P81-14 (an agent's notification target follows authority) |
| Same-agency colleagues and the agency admin see nothing (§21) | hardening L1–L5; live L9 |
| Player privacy stays narrow (§22) | hardening Y1–Y6; M23_P81_PRIVACY_HARDENING.md |
| Minor safeguards fail closed through the whole chain; a malformed DOB is never adult (§23, §24) | hardening M1–M9, M13; D-P81-7 |
| Old deep links reauthorize (§25) | hardening N1–N6; live L5–L7; M23_P81_DEEPLINK_MATRIX.md |
| Late, duplicate, out-of-order and missed events / notifications resurrect nothing (§26–§31) | hardening O1–O9, P0–P5; live L6, L7h; the three web apps re-read on focus / pageshow / visibility (Z16) |
| Restarts duplicate nothing; idempotency converges (§33, §34) | persistence 1–5; hardening Q1–Q4 |
| Corrupt pointers and unknown states fail closed (§35, §36) | hardening R1–R4; persistence 5.2, 5.5; M23_P81_CURRENT_RESOURCE_INTEGRITY.md |
| Legacy mixes fabricate nothing (§37) | hardening S1–S5; persistence 3, 5.4; M23_P81_LEGACY_COMPATIBILITY.md |
| Analytics canonical under retries, reopening, second cases, legacy and corrupt data; no negative duration (§38–§40) | hardening T1–T7c; M23_P81_ANALYTICS_HARDENING.md §1–§4 |
| Performance (§41) | m23JourneyPerf: 5 000 cases, club projection ≈ 20 ms, no N+1 |
| Authorization before existence; rate limits never alias; idempotency is never a cross-stage capability; no client-supplied authority or resource truth (§42–§46) | hardening E, N, U1–U5, V1–V5, Z17–Z18; M23_P81_FULL_LIFECYCLE_ATTACK_SURFACE.md §5; D-P81-3, D-P81-4, D-P81-5, D-P81-10 … D-P81-12 |
| Duplication (watchlist, Contact, Trial, decision, Offer, signing) (§56–§61) | hardening B2b, U1–U4, V1–V3; the P6.1 and P7.1 hardening suites unchanged and green |
| Event, notification and logging privacy (§62–§64) | hardening P2–P4, Y3–Y6; M23_P81_PRIVACY_HARDENING.md §2 (the logging sweep) |
| The entry credit stays (§65) | entryCredit 31 / 31 in the browser battery; demo freshness |

## 3. What is delivered

- Product fixes: D-P81-1 … D-P81-18 (one High, eleven Medium, six Low),
  each with a regression in the hardening, persistence or journey suites
  and none widening any authority (M23_P81_DEFECT_REGISTER.md).
- Client hardening: the club, grassroots and agent apps re-read everything
  on focus, `pageshow` and visibility (R3); no other client change.
- Suites: `m23RecruitmentJourneyHardeningE2E` (groups A–Z),
  `m23RecruitmentJourneyPersistence` section 5,
  `m23RecruitmentJourneyHardeningLive` (L1–L9 + widths); two development
  fault seams (`lifecycle.after_status`, `offer.respond.after_persist`).
- Sixteen documents (M23_P81_*.md).

## 4. What is deliberately not delivered (stated, not hidden)

- No redesign, no new lifecycle state, no scoring or ranking, no minor
  pathway, no contract amendment, no autonomous decisioning (§1).
- The frozen login-role model (N-P81-1), the named discovery wall
  (N-P81-2), the exclusivity signal (N-P81-3), the contact-routing
  `DISCLOSURE_WITHHELD` preview (N-P81-4), the login-lockout trade-off
  (N-P81-5), the revise-key replay honesty (N-P81-6) and the raw task
  `linkedResourceId` (N-P81-7) are recorded, not changed.
- Nothing pushed, no pull request, no deployment, no migration (§93–§95).
