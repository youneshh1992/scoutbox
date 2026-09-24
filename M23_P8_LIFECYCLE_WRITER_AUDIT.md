# M23 P8 — Lifecycle writer audit

Every place in the repository that assigns `case.room.status`, `case.stage`
or calls a transition, re-audited at P8 (tip c559fb7, then the P8 fixes).
Paths are under `scoutbox-server/` unless stated. Classes: **canonical
writer**, **compatibility seam**, **legacy direct writer**, **client-side
state writer**, **test-only / seed writer**, **unsafe bypass**.

## 1. The one writer

| # | Site | Writes | Class |
| --- | --- | --- | --- |
| S1 | `m17/rooms.mjs` `applyStatus(room, status, org, by)` | `room.status`, **`case.stage`** (derived, the only place), `updatedAt`, `archivedAt`/`closedAt`, `rev` | the ONE writer (module-private) |

Four doors reach it: room creation, `ctx.applyLifecycleTransition`,
`ctx.reopenRoom`, and the legacy status route.

## 2. Server writers

| # | Site | States | Trigger and role | `canTransitionRecruitmentCase`? | Evidence gate? | Class |
| --- | --- | --- | --- | --- | --- | --- |
| S2 | `m17/rooms.mjs` `ctx.applyLifecycleTransition` | the validated target | called only by S3–S8 | caller must | caller must | canonical seam. **P8:** atomic — a throw after `applyStatus` restores status, stage, rev, instants, history length and links (`ctx.lifecycleSnapshot` / `ctx.restoreLifecycle`) |
| S3 | `m23/index.mjs` `POST /org/rooms/:id/lifecycle` | any action's target | club user; role from `LIFECYCLE_ACTIONS` | yes | yes (real provider); rev after validation; refuses `stage`/`status` in the body | **canonical** |
| S4 | `m23/contactRoutes.mjs` `advanceCase` | `contacted` | send / external record; room_lead+ | yes | yes | canonical |
| S5 | `m23/trialRoutes.mjs` `advanceCase` | `trial_requested`, `trial_scheduled`, `trial_completed` | invite / accept / confirm / complete; room_lead+, recipient-driven moves name the recipient as actor | yes | yes | canonical |
| S6 | `m23/decisionRoutes.mjs` finalize / supersede | `offer_consideration`, `on_hold`, `archived` | room_lead+ | yes | yes | canonical |
| S7 | `m28/index.mjs` `advanceCase` | `offer_made`, `offer_consideration` (withdraw), `offer_accepted`, `offer_declined` | issue / withdraw / recipient response | yes | yes | canonical |
| S8 | `m29/index.mjs` `advanceCase` | `signed` | `POST /org/signings/:id/complete`, recruitment lead | yes | yes (the row just written) | canonical |
| S9 | `m17/rooms.mjs` `POST /org/rooms/:id/status` | any of the 18 | room_lead+ (`set_status`) | no — M17 `validateTransition` | yes, `STATUS_EVIDENCE_REQUIRED`, fails closed | **legacy direct writer**. **P8:** role parity — a target state named by a semantic action requires that action's role (a room lead can no longer reach `signed`; `ROOM_PERMISSION_REQUIRED` 403) |
| S10 | `m17/rooms.mjs` `ctx.reopenRoom` (Second Look bridge) | `under_review` | `POST /org/second-look/:id/reopen-room`, room_lead+ | no — `validateTransition` | yes, fails closed | compatibility seam. **P8:** refused unless the room is `withdrawn` / `archived` / `closed` (`ROOM_NOT_REOPENABLE` 409) — a live room can no longer be "reopened" |
| S11 | `m17/rooms.mjs` `POST /org/rooms`, `ctx.createRoomForPlayer` | `watching`, or the adopted M12 stage mapped by `adoptionStatusForStage` (never an evidence-bearing state) | any org user who can see the player; M18/M19 call the same creator | n/a | structurally excluded | creation seam |
| S12 | `m29/index.mjs` completion rollback | restores the case | a failure after the lifecycle moved | n/a | n/a | **was an unsafe bypass** (restored `room.status` only, leaving `stage` and `rev` moved). **P8: fixed** — restores through `ctx.restoreLifecycle` |
| S13 | `m12/scouting.mjs` `POST /org/cases/:id/stage` | `case.stage` | any case user; **409 if the case has a room** | n/a | n/a | legacy, room-guarded |
| S14 | `m12/scouting.mjs` decision / approval | `case.stage = 'decision'` only when `!c.room` | org user / lead | n/a | n/a | legacy, room-guarded |
| S15 | `m12/scouting.mjs`, `m17/rooms.mjs` creation | initial `stage: null` then derived | creation | n/a | n/a | creation |
| S16 | `m182/migrations.mjs` | `room.rev = 1` | boot | n/a | n/a | migration |

Clean: `seed.mjs` creates no cases; account erasure touches no status; the
T&S void, `PATCH /org/rooms/:id` and `POST /rooms/:id/decisions` move nothing.

## 3. Client-side writers

| Site | Writes | Class |
| --- | --- | --- |
| club / grassroots `roomsApi.ts` `setStatus` → S9 | the status the person picked from `allowedTransitions` | client → legacy route (server-gated). **P8:** the Room shows the server-derived next action first; the picker stays as the manual move and its 422 / 403 refusals are now explained in EN/FR |
| club / grassroots `roomsDemo.ts` | local `r.status` in demo mode | client demo writer (demo only; no server) |
| club / grassroots `m12demo.ts` | `c.stage` | client demo writer |
| player, agent, admin | none | — |

No client computes a next action; no client posts a stage.

## 4. Test-only writers

Offline store edits (`m23P4AClosureE2E`, `m23SigningHardeningE2E`,
`m23TrialPersistence`, `m23DecisionPersistence`, P8 `m23RecruitmentJourneyE2E`
and `…Persistence`), in-memory fixtures in the pure suites, and HTTP calls to
S9 in the M17/M18/M20/M23 suites. None is reachable in a running server.

## 5. Findings and fixes

| ID | Finding | Fix |
| --- | --- | --- |
| D-P8-1 | S12: the signing rollback restored `room.status` only, so a failure after the move left `stage = closed` on a case at `offer_accepted` and a stale `rev` | `ctx.lifecycleSnapshot` / `ctx.restoreLifecycle` (M17); the writer itself is atomic; m29 restores through it. Proven by `m23RecruitmentJourneyE2E` Q group (fault seam `signing.complete.after_lifecycle`) |
| D-P8-2 | S9: a room lead could reach `signed` (and any state) through the legacy route while the lifecycle action requires a recruitment lead | role parity on S9 |
| D-P8-3 | S10: Second Look could "reopen" a live room | `ROOM_NOT_REOPENABLE` unless the room is closed out |
| D-P8-4 | `confirmed_join` evidence: a legacy row recorded before the case opened, or a canonical package of ANOTHER case of the same club and player, satisfied `signed` | `signingSupports` requires `pkg.caseId === kase.id` for canonical rows and `ts >= case.createdAt` for legacy rows |
| D-P8-5 | the legacy recording route `POST /org/players/:id/signing` was open to any org user of any org, agencies included | clubs only, leads only (see M23_P8_CONTRACT_STATUS_WRITER_AUDIT.md) |

## 6. After P8

Every transition on a live server passes through S1 by way of S2 (validated
by `canTransitionRecruitmentCase` with the real evidence provider) or S9/S10
(validated by `validateTransition` with the same `STATUS_EVIDENCE_REQUIRED`
table and, from P8, the same role rule). A transition into `contacted`,
`trial_*`, `offer_*` or `signed` is therefore explainable by a canonical record
that existed at the moment it was written; the journey validator
(`validateRecruitmentJourney`) re-checks that the record still exists and
classifies the case `integrity_error` if it does not.
