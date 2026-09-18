# M23 P5.6A — Defect Register

Defects found while auditing the existing agent/agency surface and the
reusable infrastructure for the Agent product. The mandate's rule (§186):
fix only an existing Critical, High, safeguarding / privacy / security
defect, or a defect that prevents accurate audit; do not implement Agent
features under the guise of fixing; document every other defect. The
closure gate (§193): Open Critical 0, Open High 0, Open reasonably-fixable
Medium affecting existing production 0; regulatory uncertainty is listed
separately (snapshot §9), never as a software defect.

Severity vocabulary (unchanged from P5): **Critical** major security /
privacy / safeguarding / data-integrity compromise; **High** significant
auth / privacy / safeguarding / integrity failure or a broken core
workflow; **Medium** real correctness / availability / privacy /
lifecycle / data-quality defect that should reasonably be fixed before the
milestone closes; **Low** hygiene, cosmetic, documentation.

Every entry: ID · severity · area · reproduction · root cause · impact ·
fix · regression · commit · status.

---

## D-P56A-1 — Medium — Trust Score: agency relationship keyed by a missing field and counted after withdrawal — **CLOSED**

**Reproduction (before the fix, HTTP):** as the seeded agency
(`org-northstar`, user "Alex Agent") `POST /org/representation/propose
{ playerId: 'pl-adeyemi' }`; as the player confirm it; `GET
/player/trust-profile` → `components.relationships.detail.distinct` rises
by one (correct). Withdraw it as the player; read again → still risen by
one (wrong). Dispute a second confirmed one → still counted (wrong).
Inspection: with two confirmed agencies the source would emit two rows
with the same key `rel:agency:undefined`, which `canonicalTrustSources`
collapses to one.

**Root cause:** `m162/trust.mjs:84-87` (at `669d060`) read `rep.orgId`,
a field that does not exist on an M13 F10 representation
(`m13/transitions.mjs:248-257` writes `agencyOrgId`), and filtered on
`!rep.confirmedAt` only, although `confirmedAt` is never cleared by
withdraw (`:298-306`), dispute (`:310-318`) or expiry (`repFresh`,
`:231-234`).

**Impact:** an adult player's Trust Score kept crediting a "verified
agency relationship" after the player ended or disputed it, and could
never credit two distinct agencies. Correctness of a trust computation
the product shows to clubs; no leak (no name, no org identity leaves the
component), no authorization effect (the score authorises nothing,
`m162E2E` §41). Medium: a data-integrity defect in existing production
that a reader of the score would take as fact.

**Why fixed under §186:** it is an existing production defect in the
integrity of a trust signal; it is not an Agent feature; the fix is
two lines with no new behaviour beyond "count what is actually active";
and §193 requires zero open reasonably-fixable Medium defects affecting
existing production. Recorded as DR-41.

**Fix:** count a representation only when `status === 'active'`,
`confirmedAt` set and `endAt` not lapsed; key by `agencyOrgId`
(`m162/trust.mjs`, comment names this defect).

**Regression:** `m162E2E` section "D-P56A-1 — an agency relationship
counts only while it is active": 12 checks (5 negative): proposed does
not count; confirmed counts exactly once; withdrawn stops counting;
disputed stops counting; source guard pins `agencyOrgId` and refuses
`rep.orgId`. Verified to fail against the unfixed source (3 negative
checks red, suite exit 1) and to pass with the fix (136 checks, 63
negative, 46 %). `testTrust` (23) and `m13E2E` (212) unchanged and green.

**Commit:** `a3ebc7a`. **Status: CLOSED.**

---

## Documented, not fixed

Each item below was judged against §186 and found either not a defect in
existing production behaviour, or Low, or owned by a later phase where
the fix is part of a feature. None is Critical, High, or a
reasonably-fixable Medium affecting existing production.

| ID | Severity | Area | Finding | Why not fixed now | Owner |
|---|---|---|---|---|---|
| D-P56A-2 | Low | `db.representations` term cap | `endMonths` clamped to 36 (`m13/transitions.mjs:252`) exceeds the two-year maximum for player agreements (R-F9, R-E3). | The lane is agency-level and not a regulated agreement (surface audit S10); changing the cap would imply regulatory compliance the lane does not have. Migrated as `not_regulated_record` in P5.6B. | P5.6B B3 |
| D-P56A-3 | Low | `db.representations.representativeName` | Free text (`:249`), bound to no user. | Same lane; replaced by `agentUserId` in the new store. | P5.6B B3 |
| D-P56A-4 | Low | `org.type` | Unvalidated on creation; only T&S provisions agencies today, so no path sets an unexpected value. | No reachable production path; validation lands with the `platform` field. | P5.6B B1 |
| D-P56A-5 | Low | Role string | `user.role` written from the login body on every login (`server.mjs:1624`); `'Agent'` grants nothing. | Cosmetic; authority never reads it; documented since M13. | P5.6B B1 (affiliations) |
| D-P56A-6 | Low | Notification addressing | Withdraw notification goes to the first non-removed agency user, not the proposer (`m13/transitions.mjs:304-305`). | The agency is the counterparty in the current model; nothing leaks; addressed by the personal model. | P5.6B B5 |
| D-P56A-7 | Low | Grassroots `AgencyWall` copy | Present in `scoutbox-grassroots` but unreachable (grassroots orgs are never agencies). | Dead copy; harmless. | P5.6B B7 (remove with nav change) |
| D-P56A-8 | Low | SSE audience | `trust_safety_only` maps to `identity.kind === 'admin'`, which `sseIdentityFor` never yields (`server.mjs:354-369, 409-413`). | Pre-existing since M18.2; fails closed (nobody receives it); no Agent event uses it. | M18.2 follow-up, unscheduled |
| D-P56A-9 | Medium (pre-existing, documented in M14.1) | T&S identity | Shared `x-admin-key` with optional declared-reviewer headers; `attribution: 'shared_admin_key'` when absent. | Not reasonably fixable inside P5.6A (a per-reviewer T&S identity is a feature); today no T&S decision unlocks a regulated action. Becomes a **prerequisite** for P5.6C (DR-29) because a review resolution there would. | P5.6C |
| D-P56A-10 | Low | `safeTrustProjection` | No `'agency'` case → `null` for agency Rooms (`m162/shared.mjs:454` vs `m17/rooms.mjs:131`). | Fails closed; the decision to show a `pro_club`-level view to a confirmed agent is DR-21, a feature. | P5.6B B4 |
| D-P56A-11 | Low | Doc drift | `M16_BOX_CAM.md`, `M22_MATRIX.md` B6 (inherited P4A-D7); `M23_P5_DEFECT_REGISTER.md` "Open at closure" still lists the four P4A Lows. | Unchanged by P5.6A. | as before |

Inherited from P5 (`M23_P5_DEFECT_REGISTER.md`), unchanged: P4A-D6
(`refusedClientFields()` not invoked by M22 routes), P4A-D7 (doc drift),
P4A-D8 (dead assessment state `'published'` tolerated), P4A-D11
(grassroots open-day `invite_trial` bypasses `issueRecruitmentRequest`).
All Low, owners unchanged; no P5.6A code touches those paths.

## Not defects, recorded for honesty

- **`m23DecisionPersistence` exited 1 once** in the P5.6A battery while
  `navLive` was running concurrently in the same container; the log
  captured no failing check (the process aborted before printing). Run
  alone three times afterwards: 48 checks, exit 0 each time. Recorded as
  a concurrency artefact of the battery runner, not a product defect;
  the P5.6A battery table reports the stand-alone result and says so.
- **Regulatory uncertainties** (snapshot §9): ten items, none a software
  defect; each carries "blocking for build?" and "needs counsel?".

## Open at closure

Critical: 0. High: 0. Medium affecting existing production and
reasonably fixable: 0 (D-P56A-9 is pre-existing, documented, not
reasonably fixable inside an architecture milestone, and scheduled as a
P5.6C prerequisite). Low: D-P56A-2 … D-P56A-8, D-P56A-10, D-P56A-11 plus
the four inherited P4A items, each with an owner.
