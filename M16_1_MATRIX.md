# M16.1 — At-Home Combine: requirements matrix

Built on the completed M16 Box Cam architecture (tip `6715bd5`). At-Home
Combine is a **measurement layer over Box Cam**, not a second camera stack.

## Truth boundary

> **Combine Verified** = standardized ScoutBox protocol + live Box Cam
> capture + a detector that genuinely supports the metric + liveness +
> calibration + server-derived measurement + integrity intact + the full
> standardized window observed. Anything else is another honest state.

Never: an overall athletic/talent/potential score, an averaged rating,
projected/estimated numbers, or a fabricated result for an unsupported metric.

## Source systems reused (never duplicated)

| Concern | Canonical source |
|---|---|
| Live capture + integrity | M16 Box Cam session (`ctx.boxMintSession` / `ctx.boxCompleteSession`) — reused, not forked |
| Measurement inputs | the bound session's server-derived `verifiedReps` / `verifiedActiveMs` / `setsCompleted` |
| Observation providers | M16 registry (`production_cv` not_configured, `web_client` limited, `local_test` test-only) |
| Provenance | M15 `box_cam_observed`, presented as **Combine Verified** |
| Org gates | `visibleToOrg` + agency/minor wall + grassroots radius + blocks + verified + not-suspended, verbatim |
| Minors | existing DOB+country `isAdult()`; guardian routes; guardian-managed prefs |
| Passport | M15 projection — Combine results are projected, never re-stored |
| Disputes / T&S | M16 Box Cam dispute → invalidate/restore on the bound session |

New storage: `combineAttempts`, `combineRequests`. Protocol registry is static
versioned code (`m16/combineShared.mjs`).

## Requirements

| # | Requirement (§) | Implementation | Test | Status | Limitation |
|---|---|---|---|---|---|
| 1 | Standardized measurable tests recorded live (1) | `CombineProtocol` registry + bound Box Cam session | m161E2E U1/C1 | ✅ | — |
| 2 | Combine Verified means all 9 conditions (2) | `measureAttempt` + provider/calibration/window gates | U2, C1, C3, C7 | ✅ | — |
| 3 | Explicit result states, no `verified:true` (3) | 12-state machine | U2, C3, C7, C8 | ✅ | — |
| 4 | Metric types count/time/distance/duration/set/% (4) | protocol `metricType` + precision | U2, registry | ✅ | time/distance/% exist only on future protocols (not_configured) |
| 5 | Versioned protocol; historical pinning (5,6) | `protocolId@version` + `measurementAlgorithmVersion` on every attempt | U1 | ✅ | — |
| 6 | First library (7) | box-touch-60, juggle, control-60, footwork, strength-60 | U1, C1, C5, C9 | ✅ | see #9 — production-unsupported here |
| 7 | Future athletic protocols architected, not faked (8) | 5-10-5, 10m, broad-jump, passing-target with future caps | U1, C7, §76.13 | ✅ | `measurementCapability: not_configured` always; practice disabled |
| 8 | Camera calibration (9) | Ready Check geometry + `/calibrate` endpoint | C-flow, calibrate route | ✅ | web checks orientation/stream only |
| 9 | Physical-scale calibration / Box Marker (10,11) | `calibrationRequirements` + `box_marker_*` | registry | ✅ | no real scale detector — future protocols stay unsupported |
| 10 | Server start/finish, no client clock (12) | window from server session duration | U2, C2 | ✅ | automated timing-gate start not configured |
| 11 | Count from accepted observations only (13) | `verifiedReps` via M16 dedupe | C1, C2 | ✅ | — |
| 12 | CombineAttempt entity refs session, no dup (14) | `combineAttempts` store | C1, code | ✅ | — |
| 13 | Server-minted attempt + full flow (15) | create→calibrate→(box start/events)→complete | C1 | ✅ | — |
| 14 | Attempt limits, non-punitive (16) | `maxVerifiedPerWindow=3/24h`; practice generous | §76.17 | ✅ | — |
| 15 | Practice mode, never Combine Verified (17,68) | `mode:'practice'` → never verified | C4, §76.11 | ✅ | — |
| 16 | My Combine (18) | `/player/combine` + client hub | C1/C9, client | ✅ | — |
| 17 | Combine Card, not a talent score (19,20) | `/player/combine/card`; no rating/average | C1, client | ✅ | — |
| 18 | Passport integration, projected (21,22,60) | `full.combine` projection; opt-in for org | C1, C8 | ✅ | self/guardian always; org on recruitment opt-in |
| 19 | Provenance box_cam_observed / Combine Verified (23) | attempt provenance fields | C1 | ✅ | — |
| 20 | Explain verification to clubs (24,61) | `verificationExplained` checklist | C1 | ✅ | — |
| 21 | Club view: verified results only (25) | `/org/combine/players/:id` | C5 | ✅ | never raw footage/DOB |
| 22 | Safe club filter facts (26) | `ctx.combineFacts` (`hasCombineVerifiedResults`, `combineProtocolResults`) | code | ✅ | future M17 consumes; no hidden scoring |
| 23 | Club Combine, standardized only (27,28,29) | `/org/combine/requests` selects protocolIds | C5, §76.27 | ✅ | club cannot modify a protocol |
| 24 | Combine Day grouping (30) | multi-protocol request = a Combine Day | C5 | ✅ | — |
| 25 | Completion ≠ selection/decision (31) | request `completed` state + copy | C5 | ✅ | — |
| 26 | Personal Best per protocol@version (32,33) | `personalBest`, direction-aware | U3, C9 | ✅ | no cross-version compare |
| 27 | No public global leaderboard (34) | absent by design | review | ✅ | — |
| 28 | No maturity interpretation (35) | measurements only | review | ✅ | no normative dataset |
| 29 | History kept; old results not deleted (36) | attempts retained | C9 | ✅ | — |
| 30 | Invalidated result handling (37) | live effective-state from bound session | C8 | ✅ | — |
| 31 | Partial measurement, no projection (38) | `partially_measured` + observed window | U2, C3 | ✅ | — |
| 32 | Standardization enforced (39) | protocol defines every condition | U1 | ✅ | — |
| 33 | Anti-cheat reuse + combine bindings (40) | nonce/liveness/seq/drift + protocol/calibration/attempt binding | §76 | ✅ | — |
| 34 | No upload-to-verify (41) | live flow only; client cannot bind a session | §76.6 | ✅ | — |
| 35 | Video privacy / retention (42,43,44,45) | no raw video; optional guardian-gated clip; no scene/audio | §17 doc, C5 | ✅ | — |
| 36 | Standard precision, no false precision (46) | `precision` per protocol | U2 | ✅ | hundredths only on unsupported future protocols |
| 37 | Measurement confidence states (47) | verified / partially / unavailable / review | U2, C3, C7 | ✅ | — |
| 38 | Reproducibility + algorithm version (48,49) | pins protocol/algorithm/provider/session | code, U1 | ✅ | — |
| 39 | Result hash (50) | `combineResultHash` | C1, §76.30 | ✅ | not blockchain |
| 40 | Club comparison, no ranking (51,52) | `comparisonMatrix`; blanks not zeros | U3, C10 | ✅ | — |
| 41 | Combine requests via existing notify (53) | notify player/guardian | C5 | ✅ | — |
| 42 | Request never widens access (54) | standing gates on every org route | C6, §76.22/24/25 | ✅ | — |
| 43 | Development Plan link (55) | shares M16 development plan; combine sessions are Box Cam sessions | reuse | ✅ | no auto-causation claims |
| 44 | Box Cam training vs Combine distinct (56,57) | separate attempt entity + protocol window | design | ✅ | — |
| 45 | Player Home CTA / nav (58,59,90) | under You/Development; club drawer panel | client | ✅ | no new global nav row |
| 46 | Explainable trust (61) | verification checklist | C1 | ✅ | — |
| 47 | No pay-to-Combine (69) | absent by design | review | ✅ | — |
| 48 | Honest demo (69,85) | test provider labelled simulated | client, C-flow | ✅ | — |
| 49 | Connected demo story (70,86) | coach requests → player completes → club sees | demo | ✅ | rebuilt in P5 |
| 50 | Server authorization matrix (75,82) | player-self, guardian-child, org gates, T&S | §76 | ✅ | — |
| 51 | Security / abuse (76) | 30-case catalogue | m161E2E §76 | ✅ | — |
| 52 | Acceptance suite ≥40% negative (77) | 79 checks / 39 negative | counted | ✅ | 49% |
| 53 | Live journeys C1–C10 (78–87) | m161E2E | all pass | ✅ | API-level (camera-free deterministic) |
| 54 | Metrics, privacy-safe (89) | `metrics.boxCam` combine_* counters | metrics check | ✅ | no player labels |
| 55 | Roadmap hooks, facts only (96) | `combineFacts` / development-summary | code | ✅ | future products not built |
| 56 | Docs (93) + matrix (94) | this file + M16_1_AT_HOME_COMBINE.md | review | ✅ | — |
| 57 | Production CV honesty (95) | first-library not_configured in production; test-only simulates; athletic never | U1, C7 | ✅ | **no production CV / timing / scale detector exists** |

## Verification results (measured, not asserted)

- `scoutbox-server/scripts/m161E2E.mjs` — **79 checks, 39 negative/abuse
  (49% ≥ the 40% floor)**: pure engine (registry, measurement, PB,
  comparison), journeys C1–C10, the §76 abuse catalogue, metrics.
- Full regression battery after M16.1 — see the final report; every
  pre-existing suite stays green (m16E2E 115, m15E2E 185 unchanged: the
  sessions.mjs refactor extracted shared helpers without behaviour change,
  and the passport gained a projected Combine block).
