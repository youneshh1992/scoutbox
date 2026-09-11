# M17 — Recruitment Rooms: implementation matrix

Written **before** any M17 code, from a full inspection of the existing
recruitment surfaces. Baseline tip `e8645b9`, branch
`claude/desktop-project-migration-wyk3ec`, working tree clean, nothing pushed.

## Baseline regression (measured at `e8645b9`, all green)

trust 23 · apiE2E 129 · connectedE2E 43 · m12E2E 143 · m13E2E 212 ·
m14E2E 193 · m141E2E 94 · m15E2E 185 · m16E2E 115 · m161E2E 79 · m162E2E 124 ·
navConfig 111 · navLive 30 · liveIntegration · m12Live · m13Live · m14Live ·
m15Live 21 · m16Live 10 · m162Live 11 · uiSpotcheck · m12/m13/m14
DemoSpotcheck · m162DemoSpotcheck 21 · crosstab · demoOffline ·
staleSessionProbe · tsc ×4 · builds ×4.

## The boundary

| Layer | Owner | Answers |
|---|---|---|
| Football Passport (M15) | the player | what is true and evidenced about this player |
| Trust Score (M16.2) | derived | how strongly that record is supported |
| Box Cam (M16) / Combine (M16.1) | observed | what activity and measurement ScoutBox saw |
| **Recruitment Room (M17)** | **the club** | **what we think, what we've reviewed, what we're waiting on, what we decided** |

The player never sees Room content. The Room never widens player visibility.

## Source map — what M17 reuses and must not duplicate

| Concern | Canonical source | M17 does |
|---|---|---|
| Pipeline / per-club per-player workspace | `db.recruitmentCases` (`m12/scouting.mjs:354`) — already "the workspace layer OVER requests, trials and signings" | **the Room IS the case**: a case gains a `room` facet. No second pipeline store. |
| Canonical stage | `case.stage` over `PRO_STAGES` / `GRASSROOTS_STAGES` (`m12/scouting.mjs:10`) | `room.status` is canonical; `stage` is a **pure derivation** of it written by one function, so the two can never diverge |
| Per-user access inside an org | `caseAccess` (owner ∣ assignee ∣ `isLead`) + `restricted` (`m12/scouting.mjs:360`) | reused verbatim — no parallel RBAC |
| Recruitment lead tier | `isLead(user)` / `requireLead` (`m12/shared.mjs:49`) | reused verbatim |
| Org suspension | global at `orgAuth` → 403 `ORG_SUSPENDED` (`server.mjs:1439`) | inherited by registering on `orgRouter` |
| Visibility | `visibleToOrg` (`domain.mjs:59`) + `isBlocked` (`server.mjs:408`) via `orgCanSee` | re-run on **every** Room read, not just creation |
| In-org audit | `audit(record,…)` append-only `record.history` (`m12/shared.mjs:67`) | reused for Room activity — no second activity log |
| Tasks | `case.tasks[]` (`m12/scouting.mjs:419`) | **extended in place** (description, richer states, linked resource) — no second task store |
| Assessments | `db.assessments` + `assessmentAccessList` blind rule (`m12/scouting.mjs:85`) | surfaced through the existing access list; no second assessment store |
| Evidence | `db.evidence` + `composePassport` (`m12/passport.mjs:67`) | surfaced; Room adds only its own internal review state + notes |
| Missing evidence | `db.evidenceSuggestions`, rules v1, 14-day anti-pester, guardian routing (`m13/insight.mjs:339`) | Room bridges to it; never free-texts a minor |
| Trials | `db.trials` + `POST /org/players/:id/request` + `POST /org/trials/:id/report` | Room links; no duplicate trial row |
| Transitions | `db.transitionCases` consent grants (`m13/transitions.mjs`) | Room surfaces status only, behind `activeRecipient` |
| Signings | `db.signings` (`server.mjs:1925`) | Room links `links.signingId`; no duplicate signing |
| Passport projection | `ctx.buildFootballPassport(player, viewerKind, {orgId})` (`m15/passport.mjs:240`) | called by the Room projector |
| Trust projection | `safeTrustProjection(buildTrustProfile(p,{full}), viewer)` (`m162/shared.mjs:431`) | called by the Room projector |
| Trust snapshot | `trustSnapshot(profile)` — already labelled "for future Recruitment Rooms" (`m162/shared.mjs:491`) | persisted at decision time |
| Combine | `ctx.combineFacts` / `combineProjection` + `orgMaySeeResults` dual consent (`m16/combine.mjs:511`) | called behind the same dual rule |
| Club Combine request | `POST /org/combine/requests` (`m16/combine.mjs:448`) | Room bridges; never mints a protocol |
| Development summary | `developmentActivity(…)` + `DEV_ACTIVITY_NOTE` (`m16/shared.mjs:251`) | called behind the player's `shareDevelopmentActivity === 'recruitment'` pref |
| Notifications | `notify({kind:'org_user', id}, …)` — org-scoped by `shouldDeliver` (`server.mjs:305`) | reused; Room notifications are org-internal only |
| Metrics | `metrics.<ns>` counters (`m13/enterprise.mjs:19`) | `metrics.rooms`, counters only, no player ids |

### Genuinely new stores (nothing existing covers them)

`db.roomComments` (threaded, @mentions, edit metadata, tombstones — `db.orgNotes`
has none of these and stays untouched) · `db.roomDecisions` (append-only
decision memory with structured reason codes; `case.decision` is M12's single
sign-off artefact and answers a different question) · `db.roomSnapshots`
(decision-time evidence-confidence provenance) · `db.roomEvidenceState` (the
Room's private review state and notes over evidence it does not own).

**Not created:** `roomPassport`, `roomCombine`, `roomTrustScore`,
`roomAssessments`, `roomMembers`, a second activity log, a second task store, a
second pipeline.

## Requirements

| # | Requirement (§) | Implementation | Test | Status |
|---|---|---|---|---|
| 1 | Room = club decision layer, Passport = player truth (1,2) | Room projector composes, never re-derives | R-compose | planned |
| 2 | Core flow discover → room → assess → decide (3) | `POST /org/rooms` from the player drawer | R1 | planned |
| 3 | Explicit state machine, mapped not duplicated (4,5) | `ROOM_STATUSES` + `stageForRoomStatus` single writer | U-transitions | planned |
| 4 | Exactly one canonical status; append-only history (5) | `room.status` canonical, `case.stage` derived | U-transitions | planned |
| 5 | Room record without duplicated player truth (6) | references only | U-shape | planned |
| 6 | Access via existing org permissions (7) | `caseAccess` + `isLead` | A1–A3 | planned |
| 7 | Tenant isolation, 404 concealment (8) | org-scoped lookup → 404 | A1–A3 | planned |
| 8 | Room never widens access (9,51,52) | `orgCanSee` on every read | A7–A12 | planned |
| 9 | Header; Trust not an ability score (10) | disclaimer travels | R1 | planned |
| 10 | 9 room tabs inside Recruitment (11) | page tabs, no new sidebar item | navConfig | planned |
| 11 | Overview summary (12) | `roomSummary` | R1 | planned |
| 12 | Passport tab = M15 projection (13) | `buildFootballPassport` | R-compose | planned |
| 13 | Trust tab = safe org projection (14) | `safeTrustProjection` | R-compose | planned |
| 14 | Decision-time Trust snapshot (15,55) | `db.roomSnapshots` | R5 | planned |
| 15 | Minimal source refs, not giant JSON (16) | `sourceVersionRefs` | U-snapshot | planned |
| 16 | Evidence tab with provenance (17) | existing tiers | R-compose | planned |
| 17 | Internal evidence review state (18,19) | `db.roomEvidenceState` | A23 | planned |
| 18 | Assessments reused, blind rule intact (20,21,22) | `assessmentAccessList` | R2, A25 | planned |
| 19 | Combine tab, no overall rating (23,24) | `combineFacts` | R4 | planned |
| 20 | Request Combine reuses M16.1 (25) | bridge | R4 | planned |
| 21 | Development tab + disclaimer (26,27) | `developmentActivity` | R-compose | planned |
| 22 | Private internal discussion (28,29,30) | `db.roomComments` | A31, A44 | planned |
| 23 | Room tasks, not player requirements (31,32) | `case.tasks[]` extended | A33, A34 | planned |
| 24 | Request evidence via M13 engine (33,34) | bridge, guardian routed | R3, A26, A27 | planned |
| 25 | Trials surfaced, not duplicated (35,36) | `links.trialIds` | R6, A29 | planned |
| 26 | Structured decision, no AI (37,38,91,151) | `db.roomDecisions` | U-decision | planned |
| 27 | Reason taxonomy; protected traits rejected (39,40,108) | `REASON_CODES` + `PROHIBITED_REASON_CODES` | A39 | planned |
| 28 | Decision memory, append-only (41,83,84) | supersede, never rewrite | R7, A48 | planned |
| 29 | Second Look foundation (42,156) | machine-readable archive reasons | R7 | planned |
| 30 | Nobody Missed / funnel foundation (43,99,159) | typed events | metrics | planned |
| 31 | Source context (44) | `sourceContext` | U-shape | planned |
| 32 | Activity timeline + attribution (45,46,47) | `case.history` | R10, A35 | planned |
| 33 | Room owner, reassignable (48,49) | `ownerUserId` + lead fallback | A15 | planned |
| 34 | One active room per org+player (50) | 409 + `existingRoomId` | A18 | planned |
| 35 | Block / removal / suspension (52,53,54) | live gates, no stale cache | R8, A9–A12 | planned |
| 36 | Score never drives status (56,57) | no automatic transition | A37, A38 | planned |
| 37 | Internal priority + tags, never exposed (58,59) | org-private | A44 | planned |
| 38 | Saved views + overview + table (60,61,62,63) | filters on one page | R1 | planned |
| 39 | Notifications + mentions (64,65,66) | `notify` org_user | R2 | planned |
| 40 | Room search, no cross-tenant (67,68) | org-scoped | A42 | planned |
| 41 | Navigation + deep links (69,142,143,144,145,146) | `#/recruitment/rooms/:id` | navConfig, R1 | planned |
| 42 | Mobile / a11y / i18n (70,71,72) | scrolling tab strip, EN+FR | spotcheck | planned |
| 43 | Nothing in player or guardian apps (73,74,136) | no client change | A4, A5 | planned |
| 44 | Grassroots simpler, rules intact (75,128) | same gates | A8 | planned |
| 45 | Agency excluded (76) | agency wall | A6 | planned |
| 46 | T&S not omniscient (77,139) | no default access | A-ts | planned |
| 47 | Batch list, no N+1 (102) | one light passport per player | perf | planned |
| 48 | Room projector server-side (103,104) | `buildRecruitmentRoom` | R-compose | planned |
| 49 | Cache safety (105) | read-time gates only | A46 | planned |
| 50 | ≥40% negative tests (106,107) | 48 enumerated abuse cases | m17E2E | planned |
| 51 | Pagination + rate limits (130,131,132,133) | cursor + cooldowns | A-limits | planned |
| 52 | Idempotency + concurrency + ordering (160,161,162,163) | keys, guards, stable sort | A48 | planned |
| 53 | No talent score, no pay-to-be-seen (152,153,154) | absent by construction | U-labels | planned |
| 54 | Restoration bundle (170) | verified bundle, nothing pushed | report | planned |

Status column becomes ✅/limitation as each lands; measured results replace
"planned" at the end.
