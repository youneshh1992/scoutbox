# M16.2 — ScoutBox Trust Score: requirements matrix

Baseline (tip `3b9fb4d`, all green before any M16.2 change): trust 23 ·
apiE2E 129 · m12E2E 143 · m13E2E 212 · m14E2E 193 · m141E2E 94 · m15E2E 185 ·
m16E2E 115 · m161E2E 79 · connectedE2E 43 · navConfig 111 · navLive 30 · live
suites · demo suites · staleSessionProbe · tsc ×4 · builds ×4.

## The sentence the Trust Score is allowed to say

> "This player's football record is supported by *[band]* — identity,
> club history, relationships, evidence, standardized measurement and
> references, weighted by how attributable each one is."

Never: talent, ability, potential, level, character, popularity, effort,
recruitment suitability, or a reason to grant access.

## Source systems consumed (never replaced, never duplicated)

| Concern | Canonical source |
|---|---|
| Identity assurance | M14.1 `assuranceForClaim` over an EFFECTIVE `PERSON_IDENTITY` claim (`effectiveStatus`), legacy boolean only as a labelled fallback |
| Claim validity / revocation | M14 `effectiveStatus` at read time — never a cached boolean |
| Football history | M15 Passport `history.rows` (already folds duplicate self entries into authoritative rows) |
| Relationships | squad rows + M14 reference provenance claims + representations |
| Evidence | M12 `db.evidence` provenance tiers |
| Observed training | M16 `db.boxSessions` (finalized, non-simulated in production) |
| Standardized measurement | M16.1 `db.combineAttempts` with LIVE effective state |
| Org gates | `visibleToOrg` + agency/minor wall + radius + blocks + suspension, verbatim on the existing routers |
| Minors | existing `isAdult(DOB, country)` — no new age flag |

No new storage: the score is derived on every read.

## Requirements

| # | Requirement (§) | Implementation | Test | Status | Limitation |
|---|---|---|---|---|---|
| 1 | 0–100 evidence-confidence score; mandatory disclaimer (1) | `calculateTrustScore` + `TRUST_DISCLAIMER` on every projection | U1 | ✅ | — |
| 2 | Consumes M14/M15/M16/M16.1, replaces none (2) | `m162/trust.mjs` source maps | U-all, HTTP | ✅ | — |
| 3 | Does not rewrite or weaken M14 (3) | reads effective claims; no claim mutation; no `verified:true` | m14E2E 193 unchanged | ✅ | — |
| 4 | Derived, never persisted (4) | no store; recomputed per read | U1 determinism, invalidation tests | ✅ | — |
| 5 | Trust Profile response shape (5) | score/band/policyVersion/components/strengths/gaps/explanations | U12 | ✅ | — |
| 6 | Centralized versioned policy (6) | `POLICY` + `TRUST_SCORE_POLICY_VERSION`; boot refuses if ≠100 | U1 | ✅ | — |
| 7 | Weights 15/20/20/20/15/10 (7) | `POLICY.weights` | U1 weights total | ✅ | configurable, not hard-coded in UI |
| 8 | Neutral bands, no pejorative labels (8) | `POLICY.bands` | U1 boundaries + label sweep | ✅ | — |
| 9 | Identity from M14.1 assurance, not a legacy boolean (9) | `identitySource` prefers structured claim assurance | U1/HTTP | ✅ | no authoritative identity provider exists → best real value is ScoutBox review |
| 10 | Football-history coverage, deduped (10) | `scoreFootballHistoryConfidence` + canonical keys | U2, U3 | ✅ | — |
| 11 | Relationship confidence, prestige-free (11) | `scoreRelationshipConfidence` | U9 prestige tests | ✅ | — |
| 12 | Evidence confidence, quantity ≠ truth (12) | sub-caps + curves | U4 | ✅ | — |
| 13 | Box Cam strengthens evidence, not engagement (13) | boxCam curve + sub-cap | U4 | ✅ | — |
| 14 | Box Cam performance/volume irrelevant (14) | duration/streaks/reps are not inputs | U6 | ✅ | — |
| 15 | Combine Verified strengthens Combine Confidence (15) | `scoreCombineConfidence` | U7 | ✅ | production capability absent (see #17) |
| 16 | **Performance value must not affect trust** (16) | measured value is not an engine input at all | U6 (mandatory) | ✅ | — |
| 17 | Demo/test Combine excluded from production (17) | `allowSimulatedEvidence` + provider `testOnly` | U8 | ✅ | **no production Combine exists here** — honestly 0 |
| 18 | Combine coverage curve (18) | `protocolCurve` | U7 | ✅ | — |
| 19 | Protocol diversity, no repetition gaming (19) | distinct `protocolId@version` | U7 | ✅ | — |
| 20 | Invalidated result removed, no penalty (20) | live effective state | U7 | ✅ | — |
| 21 | Restored result returns (21) | deterministic recompute | U7 | ✅ | — |
| 22 | Partial ≠ full contribution (22) | `partially_measured` excluded from Combine | U7 | ✅ | may still count as Box Cam evidence |
| 23 | References/assessments by attribution, not content (23) | rating never read | U10 | ✅ | — |
| 24 | Fact-specific authority, no universal rank (24) | per-fact provenance tables; Box Cam absent from history | U3 | ✅ | — |
| 25 | Player-submitted limited, not zero (25) | `player_submitted` 2500bp | U3 | ✅ | — |
| 26 | Missing evidence ≠ dishonesty (26) | gap wording sweep | U11 | ✅ | — |
| 27 | New-player fairness, not a discovery gate (27) | informational only; no ranking/sort | U11, batch note | ✅ | — |
| 28 | Minor fairness, denominator excludes adult-only (28,61) | `eligibleTrustComponents` + agency facet | U9 | ✅ | — |
| 29 | Grassroots can reach strong (29) | no prestige inputs | U9 | ✅ | — |
| 30 | No prestige weight (30) | no name/level/reputation field reaches the engine | U9 | ✅ | — |
| 31 | No popularity weight (31) | not inputs | U9 noise test | ✅ | — |
| 32 | No recruitment-outcome weight (32) | not inputs | U9 | ✅ | — |
| 33 | No payment weight (33) | not inputs | U9 | ✅ | — |
| 34 | Component caps (34) | earned ≤ weight; evidence sub-caps | U4, U5 | ✅ | — |
| 35 | Diminishing returns (35) | policy curves | U4 | ✅ | — |
| 36 | Recency only where justified (36) | historical facts never decay | U3 | ✅ | — |
| 37 | Current vs historical distinguished (37) | `current` flag on rows | U3 | ✅ | — |
| 38 | Revoked authority recalculates (38) | `effectiveStatus` at read time | U7/U12, m14E2E | ✅ | — |
| 39 | Source deduplication (39) | `canonicalTrustSources` | U2 | ✅ | — |
| 40 | Client cannot set score/band/policy (40) | GET-only, server-derived | HTTP forged-params | ✅ | — |
| 41 | **Score is not authorization** (41,88) | routes on existing routers; gates first | §41 block (6 refusals) | ✅ | — |
| 42 | Player Trust Profile UI (42) | TrustProfileSection | client + live | ✅ | — |
| 43 | "Why this score?" explainer (43) | `/trust-profile/explain` + per-component reasons | HTTP T1 | ✅ | — |
| 44 | Score-change UX, deterministic (44) | no hard-coded values | — | ✅ | change deltas surfaced via reasons |
| 45 | Change reason codes (45) | `trustChangeReasons`, no source ids | U12 | ✅ | — |
| 46 | Player home card, not gamified (46) | no streaks/animations | client | ✅ | — |
| 47 | Combine Card separation (47,94) | Trust visually separate from results | client | ✅ | — |
| 48 | Pro club view + tooltip (48) | safe projection + note | HTTP T8 | ✅ | — |
| 49 | Grassroots view, rules intact (49) | same projection; radius/minor unchanged | §41 block | ✅ | — |
| 50 | T&S inspect, cannot type a score (50) | `/admin/trust/:id`; no write route | HTTP | ✅ | — |
| 51 | Optional future evidence filter (51) | batch summaries expose band/score | HTTP batch | ✅ | filter UI not built |
| 52 | No default sort by trust (52) | batch returns request order + note | HTTP batch | ✅ | — |
| 53 | Batch summary, no N+1 (53) | light assembly reuse | HTTP batch = individual | ✅ | — |
| 54 | No private source leakage (54,76) | `safeTrustProjection` | U13, HTTP leak sweep | ✅ | — |
| 55 | Personal best adds no trust (55) | coverage by protocol, not value | U6 | ✅ | — |
| 56 | Repeated protocols capped (56) | distinct coverage | U7 | ✅ | — |
| 57 | Multiple protocols broaden (57) | curve | U7 | ✅ | — |
| 58 | Demo/test isolation both ways (58) | flag + provider provenance | U8 | ✅ | — |
| 59 | Provider bug = removal, no blame (59) | no penalty; neutral copy | U7 | ✅ | — |
| 60 | Conflicts: verified value stands (60) | engine reads only verified evidence | U6 | ✅ | no automatic penalty |
| 62 | Denominator transparency (62) | availableWeight/coverage/reasons | U12 | ✅ | — |
| 63 | Deterministic integer math (63) | basis points, single final rounding | U1 | ✅ | documented round-half-up |
| 64 | Band boundaries + clamp (64) | `trustBandForScore` | U1 (all 10 boundaries) | ✅ | — |
| 65 | Empty profile deterministic, not punitive (65) | explained gaps | U11 | ✅ | — |
| 66 | 100 possible but hard (66) | requires broad verified evidence | U5 | ✅ | not reachable by volume |
| 67 | Snapshot DTO (67) | `trustSnapshot` | U12 | ✅ | not persisted yet |
| 68 | Second Look preparation (68) | change reasons + snapshot | U12 | ✅ | engine not built |
| 69 | Nobody Missed preparation (69) | score exposed as coverage context only | — | ✅ | not built |
| 70 | Recruitment Room preparation (70) | summary + snapshot contracts | U12 | ✅ | not built |
| 71 | New server module (71) | `m162/` | boot | ✅ | — |
| 72 | Pure functions (72) | all scorers exported and unit-tested | U1–U13 | ✅ | — |
| 73 | Trust API (73) | player/guardian/org/batch/T&S | HTTP | ✅ | — |
| 74 | Viewer contexts (74) | self/guardian/pro/grassroots/public/T&S | U13 | ✅ | — |
| 75 | Public trust withheld by default (75) | `publicAllowed` false | U13 | ✅ | — |
| 77 | Audit without read-time noise (77) | no audit event per recalculation | design | ✅ | — |
| 78 | Privacy-safe metrics (78) | aggregate counters only | metrics check | ✅ | — |
| 79 | No manipulative gamification (79) | no streaks/leaderboards | client | ✅ | — |
| 80 | Approved UI language (80) | disclaimer + neutral bands | U1 label sweep | ✅ | — |
| 91 | Passport integration (91) | **Passport stays score-free**; Trust served separately and composed in the header | Passport-separation block | ✅ | deliberate: M15 forbids a numeric score in the projection |
| 98/99 | Docs + matrix (98,99) | this file + M16_2_TRUST_SCORE.md | review | ✅ | — |

## Verification results (measured, not asserted)

- `scoutbox-server/scripts/m162E2E.mjs` — **111 checks, 54 negative/abuse
  (49% ≥ the 40% floor)**, including the mandatory adversarial grinding test
  (§85), the performance-independence test (§86), the prestige-independence
  test (§87) and the authorization block (§88).
- Full regression battery after M16.2 — see the final report; every
  pre-existing suite is unchanged and green.
