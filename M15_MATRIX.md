# M15 — Football Passport: requirements matrix

Baseline (tip `c5445f4`, all green before any M15 change): unit/trust 23 ·
apiE2E 129 · m12E2E 143 · m13E2E 212 · m14E2E 193 · m141E2E 94 ·
connectedE2E 43 · navConfig 111 · navLive 30 · m12/m13/m14 live suites ·
liveIntegration · spotchecks · staleSessionProbe 14 · tsc ×4 · builds ×4.

**M15 verification results**: `m15E2E` 184 checks / 71 negative-abuse
(39 %, all 26 §79 cases covered, batch measured 3 ms for 15 ids) ·
`m15Live` 21 checks (P1–P8 + T&S journey, five browser contexts) · full
regression battery green at the M15 tip · tsc ×4 · builds ×4. Docs:
`M15_FOOTBALL_PASSPORT.md`.

## Source systems reused (never duplicated)

| Passport concern | Canonical source | Notes |
|---|---|---|
| Identity & assurance | M14 PERSON_IDENTITY claims + `toPublicVerificationProfile.identity` | wording from M14.1 assurance |
| Club affiliations (current/historical) | M14 CLUB/GRASSROOTS/AGENCY affiliation + ROLE claims via claim index + `effectiveStatus` | read-time engine |
| Squad membership | `org.squad` rows (invite-approved) | grassroots |
| Evidence records | M12 `db.evidence` + `player.media` + vouches (legacy view) | tiers preserved |
| Assessments | `db.assessments` (published feedback only to player; own-org to clubs) | |
| Trials | `db.trials` + inbox trial requests | outcomes private by default |
| Coach references | M14 `verReferences` (provenance snapshots) | snapshot never rewritten |
| Opportunities/applications | `db.opportunities` + `db.applications` | |
| Development | `db.devObjectives` (+ sharing.orgIds) | private by default |
| Transitions | `db.transitionCases` | confidential |
| Signings & outcomes | `db.signings` + `db.outcomeReports` | club-confirmed |
| Representation | `db.representations` (adults only) | |
| Availability scheduling | M13 suitability `db.playerPrefs` | not duplicated; passport adds only a coarse recruiting-availability flag |
| Org view redaction | existing `playerViewForOrg`, `orgCanSee` (= `visibleToOrg` + blocks), agency/minor wall | reused verbatim |

## New M15 storage (projection-only principle)

`passportPrefs` (bio, coarse availability, position history, public
selections) · `passportCareerEntries` (player/guardian-submitted history) ·
`passportAchievements` (+ separate confirmations) · `passportShares`
(hashed tokens) · `passportCorrections`. No passportClubs / passportTrials
/ passportAssessments — those are projections.

## Requirements

| # | Requirement (§) | Implementation | Test | Status |
|---|---|---|---|---|
| 1 | Canonical server projection, viewer-filtered (3,4) | m15/passport.mjs `buildFootballPassport` + shared `projectPassport` | m15E2E privacy matrix | ✅ |
| 2 | Viewer contexts SELF/GUARDIAN/PRO/GRASSROOTS/AGENCY/OTHER_PLAYER/PUBLIC/T&S (4) | shared VIEWERS + per-section allowlists | §83 fixtures | ✅ |
| 3 | Identity header w/ honest assurance (5A) | M14 identity projection reused | m15E2E provenance | ✅ |
| 4 | Current status card, no private prefs leak (5B) | shared currentStatus | privacy matrix | ✅ |
| 5 | Career timeline + taxonomy (6,7) | shared buildTimeline, stable ids | timeline tests §81 | ✅ |
| 6 | Provenance vocabulary + per-item indicators (8,9) | shared PROVENANCE + copy | provenance tests §82 | ✅ |
| 7 | Club history w/ overlap & trial≠employment (10) | shared clubHistory | m15E2E | ✅ |
| 8 | Position history w/ provenance (11) | passportPrefs.positionHistory | m15E2E | ✅ |
| 9 | M12 evidence integration, no file dupes, no leaked URLs (12) | evidence summary projection | abuse #14/#15 | ✅ |
| 10 | Descriptors not scores; no rating (13,36) | completeness descriptors | m15E2E | ✅ |
| 11 | Versioned gap engine, non-shaming copy (14,53,54) | shared GAP_RULES v1 | m15E2E | ✅ |
| 12 | Search-eligibility preview, no club criteria leak (15,55) | generic checks only | m15E2E | ✅ |
| 13 | Privacy levels; narrowing never widening (16,46,47) | selections ∧ policy | abuse #23 | ✅ |
| 14 | Public passport exclusions (17) | public projector | §83 + abuse #21/#22 | ✅ |
| 15 | Shares: opaque revocable tokens, expiry, guardian control for minors (18) | m15/sharing.mjs, sha256 at rest | share lifecycle + abuse #5-#8 | ✅ |
| 16 | QR/deep link (19) | share URL is QR-ready; client shows link | doc'd | ⚠️ QR image rendering not included (no QR lib in stack) — link/token only |
| 17 | Recruitment passport (20,43,44) | org projection + own-org assessments/trials only | P2 live + abuse #13 | ✅ |
| 18 | Ownership vs source ownership (21) | edit walls + corrections | abuse #10/#11 | ✅ |
| 19 | Corrections/disputes (22) | passportCorrections + T&S resolve; claim targets → existing M14 dispute flow | m15E2E | ✅ |
| 20 | Historical truth (23,85) | snapshots respected; supersession honoured | P4 live | ✅ |
| 21 | Trials privacy (24) | outcomes private; participation opt-in public | m15E2E | ✅ |
| 22 | Assessments privacy (25) | own-org only; published feedback to self | abuse #13 | ✅ |
| 23 | References w/ snapshot provenance (26) | m14 refs projected | provenance tests | ✅ |
| 24 | Achievements w/ confirmation upgrades (27,56) | passportAchievements + confirmations | m15E2E | ✅ |
| 25 | Match/performance honesty (28) | attendance/evidence only; no invented stats | m15E2E | ✅ |
| 26 | Availability coarse (29) | passportPrefs.availability | privacy matrix | ✅ |
| 27 | Representation adults only (30,40) | existing UNDER_18_WALL upstream | abuse #1 | ✅ |
| 28 | Development history private-by-default (31) | objectives sharing respected | privacy matrix | ✅ |
| 29 | Signings/transitions (32) | projections | m15E2E | ✅ |
| 30 | Source graph + canonical event ids (33,34) | event.source refs; T&S graph endpoint | m15E2E | ✅ |
| 31 | No "Verified Passport", no rating, no pay-to-complete (35–37) | descriptors + copy | m15E2E | ✅ |
| 32 | Minors/guardians exact gates (38) | existing isAdult/guardian routes | P3 live + abuse #12 | ✅ |
| 33 | Grassroots radius & agency walls (39,40) | orgCanSee reused | P7 + abuse #1/#3 | ✅ |
| 34 | Blocks/moderation reuse (41) | orgCanSee + moderateOrRefuse | abuse #4 | ✅ |
| 35 | Player/Pro/Grassroots/T&S UX (42–45) | clients | spotchecks + live | ✅ |
| 36 | Snapshot architecture (48) | share records source ids + projection version; full snapshot store deferred | doc'd | ⚠️ architected (versioned projection + source ids), snapshot persistence deferred |
| 37 | Football CV view (49,88) | recruitment/public projections; CV = print-friendly client view of same data | m15E2E | ✅ |
| 38 | Share abuse protection (50) | entropy, hash-at-rest, rate limit, noindex | abuse #5-#8,#19 | ✅ |
| 39 | Metrics no-PII (51,52) | metrics.passport counters; no scout identity to players | m15E2E | ✅ |
| 40 | Conflict engine + precedence (57) | shared conflicts | P5 live | ✅ |
| 41 | Temporal consistency (58) | TEMPORAL_CONFLICT flags | timeline tests | ✅ |
| 42 | Batch summaries, no N+1 (62,63,84) | /org/football-passports batch + m14 idx | perf measurement | ✅ |
| 43 | Access audit (64) | ledgerAppend passport events | m15E2E | ✅ |
| 44 | Notifications local-only honesty (65) | notify() | m15E2E | ✅ |
| 45 | A11y + i18n EN/FR (67,68) | clients | spotcheck FR | ✅ |
| 46 | Demo personas + tour (69,70,95) | demos + launcher | spotcheck | ✅ |
| 47 | Live journeys P1–P8 (71–78) | e2e/m15Live.test.mjs | all pass | ✅ |
| 48 | ≥⅓ negative incl. all 26 §79 cases (79) | m15E2E security section | counted | ✅ |
| 49 | Date precision honesty (86) | shared when-normalisation | timeline tests | ✅ |
| 50 | Location privacy (87) | age-not-DOB, city-level public | abuse #21 | ✅ |
| 51 | Deletion policy honesty (89) | self-content withdrawable; authoritative kept | m15E2E | ✅ |
| 52 | Boundary respected — no M16+ features (90) | scope | review | ✅ |
