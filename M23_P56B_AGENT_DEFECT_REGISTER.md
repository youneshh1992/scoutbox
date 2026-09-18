# M23 P5.6B — Defect Register

Defects found while building the Agent core (P5.6B), plus the disposition
of what P5.6A left open. The rule (mandate §100 and every phase before it):
any Critical or High is fixed before the phase closes; any reasonably
fixable Medium is fixed; nothing is carried forward silently; nothing is
downgraded to make a table look better.

Severity vocabulary (unchanged): **Critical** major security / privacy /
safeguarding / data-integrity compromise; **High** significant auth /
privacy / safeguarding / integrity failure or a broken core workflow;
**Medium** real correctness / availability / privacy / lifecycle /
data-quality defect that should reasonably be fixed before the milestone
closes; **Low** hygiene, cosmetic, documentation.

How the P5.6B defects were found: every one of D-P56B-1 … D-P56B-8 was
surfaced by the P5.6B acceptance suites (`m23AgentE2E`,
`m23AgentPersistence`) on their first runs against the server phase as
first written; D-P56B-9 by the M18.2 regression; D-P56B-10 and D-P56B-11
by the live browser suite. None was found by inspection; each would have
shipped without the test that caught it. All are fixed in the tree the
final report names.

Suites: **E** = `scoutbox-server/scripts/m23AgentE2E.mjs`, **P** =
`scoutbox-server/scripts/m23AgentPersistence.mjs`, **L** =
`e2e/m23AgentLive.test.mjs`.

---

## P5.6B defects

| ID | Severity | Area | Reproduction / root cause | Impact | Fix | Regression | Status |
|---|---|---|---|---|---|---|---|
| D-P56B-1 | **Medium** | Permission matrix (`m24/shared.mjs`) | `can(tiers, 'constructor')` read `Object.prototype.constructor` through a plain-object `PERMISSIONS` table and threw `TypeError: allowed.includes is not a function`. A prototype-named capability string reaching `requireCap` would have crashed the request (500) instead of refusing it. | Availability: a crafted capability name could produce a 500; no privilege was granted. | `PERMISSIONS` is null-prototype; `can()` answers only own string keys and requires an array of tiers. | E B9 (five prototype names), B8 | **CLOSED** |
| D-P56B-2 | **Medium** | Access predicate (`agreementGrantsAccess`) | `a.agentUserId === agentUserId` was true for a legacy agency-level row (`agentUserId: null`) when the caller id was `null`/`undefined`. Every HTTP route passes `req.orgUser.id` (always a string), so the fault was unreachable over the wire, but the central predicate was wrong for the pure layer. | Latent: a future caller passing a null id would have been granted access to every legacy row. | The predicate requires a non-empty string `agentUserId` before comparing. | E D18; P §2 (null, admin, undefined callers) | **CLOSED** |
| D-P56B-3 | Low | Transition tables | `AGENT_TRANSITIONS`/`CLIENT_TRANSITIONS` were plain objects: a corrupt stored status such as `'constructor'` resolved to a function and `.includes` would throw. | Availability on corrupt data only. | Null-prototype tables; `transitionAllowed` uses `Object.hasOwn` and moves nothing for an unknown status. | E D25; P §5 (`status: 'signed'` moves nowhere) | **CLOSED** |
| D-P56B-4 | **Medium** | Request validation (`POST /org/agent/clients/request`) | `normaliseScope` defaults to `['employment']` when nothing valid remains, so `scope: ['bribery']` was silently accepted as an employment request instead of `400 AGENT_SCOPE_INVALID`. | Data quality: a request could be created with a scope the agent did not choose. | Explicit validation: every provided scope entry must be in `SCOPES`, or 400. | E K4 | **CLOSED** |
| D-P56B-5 | Low | Facet submission | A national facet accepted `memberAssociation: 'INT'` (FIFA level is not a member association). | A meaningless `national_registration.INT` record could be created. | `INT` refused for national and minors facets. | E G11 | **CLOSED** |
| D-P56B-6 | Low | Shared-key oversight view (`GET /admin/agent/profiles`) | The read-only projection re-used the owner's `profileView`, exposing submitted references and the declared licence number to the shared T&S key. | Privacy hygiene (no adjudication power was involved). | A minimised oversight projection: states and provenance only; references and numbers withheld with a note saying where they would be needed (P5.6C). | E R4 | **CLOSED** |
| D-P56B-7 | Low | Rate policy `agent_representation_request` | The 20/day quota was consumed at route entry, so malformed input and the agent's own verification refusals (400/403) counted against it; an agent correcting mistakes could be locked out for a day. | Availability. | The quota is checked after input validation, idempotent replay and the own-state verification gate, so it counts only attempts that reach a subject (solicitation and enumeration); raised to 40/day. | E K-group runs > 20 attempts; Q1–Q3 | **CLOSED** |
| D-P56B-8 | Low | Migration 2305 bootstrap | `startedAt: u.createdAt ?? now` — a user row with a future `createdAt` (clock skew, or a synthetic fixture) produced an affiliation that had not "started" and was therefore inactive, which let the first-member bootstrap create a second, unrelated admin affiliation. | Correctness under skew. | `startedAt` clamped to `now`. | P §3 (migrated staff member is an assistant; no duplicate affiliation) | **CLOSED** |
| D-P56B-9 | Low | M18.2 event audit | `clientMutation` broadcast through a variable event name; `m182E2E` reads call sites textually and reported `representation_confirmed / rejected / disputed` as declared-but-never-emitted. | Test contract only (the events were emitted). | Literal `broadcast('…')` call sites per outcome. | `m182E2E` (365 checks) | **CLOSED** |
| D-P56B-10 | Low | Live suite fixture | The player-app card mounts before its data arrives; the suite read it immediately and, on a slow run, saw no rows (flake in one run out of two). | Test flake. | The suite polls for the relationship row before asserting. | L C2 (and N9) | **CLOSED** |
| D-P56B-11 | Low | Agent app Team form (`screens.tsx`) | After adding a member the add-member form kept the previous member's roles (name and title were reset, roles were not), so the next member added without re-checking would inherit `licensed_agent`. Caught when the live suite's analyst turned out to see Opportunities. | Usability with a governance consequence (the server still enforces nothing more than the tiers actually submitted; a wrong tier would be visible on the team page). | Roles reset to the default `assistant` after a successful add; the live suite asserts the reset. | L N2a–N2b | **CLOSED** |

## Pre-existing observations (not P5.6B defects)

| ID | Severity | Area | Observation | Disposition |
|---|---|---|---|---|
| D-P56B-12 | Low (pre-existing, P5) | Boot log | `event registry lists names the server never emits: room_decision_finalized, room_decision_superseded` at every boot: the P5 events are registered and broadcast from `m23/decisionRoutes.mjs` but the boot-time check reads `EMITTED_EVENTS` in `server.mjs`, which P5 did not extend. Present at `fe4b18e`. | Not touched in P5.6B (outside the mandate's tree; the M18.2 regression is green either way). Recorded for the next bookkeeping pass. |
| D-P56A-9 | **Medium — OPEN, not downgraded** | T&S identity | Shared `x-admin-key`; no per-reviewer identity. | Unchanged by P5.6B by design: P5.6B added **no** T&S mutation, so no P5.6B outcome depends on reviewer identity (E R5–R10). Remains the P5.6C entry gate **G-C0**. |

## Disposition of the P5.6A register

| P5.6A item | P5.6B disposition |
|---|---|
| D-P56A-2 (F10 term cap 36 months) | Mirrored as `not_regulated_record`; the lane untouched; the new store enforces 24 (E D5–D6, K3). |
| D-P56A-3 (`representativeName` free text) | The new store binds `agentUserId`; legacy rows carry the old name under `legacy` and name no licensed individual (P §2–§3). |
| D-P56A-4 (`org.type` unvalidated) | The Agent platform reads `org.type === 'agency'` at login and on every route; creation validation still lands with a future provisioning change. |
| D-P56A-5 (login `role` string) | Grants nothing; used only by migration 2305's lead heuristic to seed `agency_admin` (never `licensed_agent`). |
| D-P56A-6 (withdraw notification addressing) | The personal model notifies the named agent (`agentUserId`) (E M32). |
| D-P56A-7 (Grassroots `AgencyWall` dead copy) | Untouched (the club/grassroots apps are unchanged in P5.6B; R8). |
| D-P56A-10 (Trust projection `agency` case) | Deferred (R6; E N12). |

## Counts at closure

| | Count | IDs |
|---|---|---|
| Critical | 0 | — |
| High | 0 | — |
| Medium fixed in P5.6B | 3 | D-P56B-1, D-P56B-2, D-P56B-4 |
| Low fixed in P5.6B | 8 | D-P56B-3, -5, -6, -7, -8, -9, -10, -11 |
| Open Medium prerequisite before P5.6C | 1 | D-P56A-9 (G-C0) |
| Open Low | 1 new + inherited | D-P56B-12; P5.6A Lows as dispositioned above |
