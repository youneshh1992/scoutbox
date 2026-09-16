# M23 P5 — Formal Recruitment Decision: Implementation

What was built, where each rule lives, and what each surface may see. The
governing separation:

> evidence ≠ observation ≠ assessment ≠ discussion ≠ decision ≠ offer ≠ signing

Commits: P5-1 server (`1e2c0c5`), P5-2 clients (`66a14ea`), P5-3 tests and
the two defect fixes (`2c55952`), then the closure commit that carries these
documents. Nothing was pushed.

---

## 1. Schema

**No migration.** The schema stays at 2304. A formal decision is an
additive row shape on `db.roomDecisions` (M17's store, migration-guaranteed
since M17); the draft is an additive field on the case
(`kase.decisionDraft`, `null` or absent when there is none). No
`recruitmentDecisions`, no `decisionDrafts`, no `recruitmentOffers`
(persistence §1, §5).

Formal row fields beyond M17's: `kind: 'formal'`, `state: 'final'`,
`outcome`, `finalizedAt`, `rev`/`revAt`, `evidenceRefs[]` (with minimal
`meta`), `assessmentSummary` (counts and ids), `lifecycle` (what it did to
the case), `supersession { of, reason }`, `keys { finalize, draft }`,
`draftId`, `policyVersion`, `trigger: 'decision:finalize'`, and the M17
`snapshot` captured at finalize. `recommendation` is set to the mapped M17
value so every legacy reader keeps working.

Draft fields: `id, outcome, reasonCodes, note, evidenceRefs, by, createdAt,
updatedAt, updatedBy, rev, revAt, keys.create`.

## 2. State ownership

| fact | owner | writer |
|---|---|---|
| the draft | `kase.decisionDraft` | the three draft routes |
| the formal row | `db.roomDecisions` | `finalizeHandler` only |
| the case status | `case.room.status` | `ctx.applyLifecycleTransition` (M17), after `canTransitionRecruitmentCase` (M23 P2) |
| the snapshot | M17 `captureSnapshot` via `ctx.captureRoomSnapshot` | M17 |

Nothing in `m23/decision*.mjs` writes `case.room.status`, `case.stage`, a
`db.requests` row, an assessment or a Passport record.

## 3. Engine — `scoutbox-server/m23/decision.mjs` (pure)

`DECISION_OUTCOMES`, `OUTCOME_MAP` (null-prototype table), `EVIDENCE_REF_KINDS`,
`DECISION_LIMITS` (note 2000, supersession reason 500, refs 50, key 64,
reasons 6, history page 100). Validation: `validateOutcome`,
`validateDecisionReasons` (M17 `validateReasonCodes` + "a reject needs one"),
`validateNote`, `validateEvidenceRefShapes`, `resolveEvidenceRefs`. Reading:
`decisionIntegrity`, `duplicateFinalHeads`, `chainHead`, `byCreatedThenId`,
`summariseAssessments`, `assessmentSnapshot`, `evidenceCandidates`,
`decisionView`, `draftView`, `decisionMilestone`, `decisionRequirements`.
Prototype keys resolve to nothing everywhere (U6, U11, X1–X3); nothing
coerces a type.

## 4. Routes — `scoutbox-server/m23/decisionRoutes.mjs`

```
GET    /org/rooms/:id/decision            current | advisory | draft | history | assessments | evidence | requirements | vocabulary | limits
POST   /org/rooms/:id/decision/draft      open (201) — one per case, key + fingerprint replay
PATCH  /org/rooms/:id/decision/draft      edit — expectedRev required, partial fields
DELETE /org/rooms/:id/decision/draft      discard — expectedRev required
POST   /org/rooms/:id/decision/finalize   formal decision (201) — row + case move, one save
POST   /org/rooms/:id/decision/supersede  same handler; must find a formal head
GET    /org/recruitment/decision-policy   vocabulary
```

Finalize order: key replay → subject removed → draft required → rev gate →
content re-validated as final → references re-resolved → supersession rules
→ blocked (progress only) → rate limit → moderation → failure injection →
snapshot → row pushed and head linked → validator with the real evidence
provider (rollback on refusal) → writer → head rev bump → draft cleared →
audit → persist → broadcast (+ `recruitment_room_archived` on terminal) →
notify owner/lead.

`ctx.captureRoomSnapshot` is M17's seam (D-P5-1); `ctx.trialEvidenceViews`
is P4B's, used for Box Cam candidates; `ctx.decisionRowsOf` is exported for
readers.

## 5. The precondition and the provider

`m17/shared.mjs`: `STATUS_EVIDENCE_REQUIRED.offer_consideration =
{ kind: 'decision_progress' }`. `m23/evidence.mjs`: `decision_progress` added
to `EVIDENCE_KINDS` and answered from `db.roomDecisions` (formal, final,
progress, this case/org/player, no successor). Because M17's legacy status
route and the M23 lifecycle route share the one provider, neither can reach
`offer_consideration` by hand.

## 6. Permissions, rate policies, errors, events, audit

- `roomCan`: `decision_view: 0`, `decision_draft: 2`, `decision_finalize: 2`.
- `m181/rateLimit.mjs`: `decision_draft` 60/h org, `decision_finalize` 30/h org.
- `m23/errors.mjs`: nineteen `DECISION_*` codes; `PUBLIC_ERROR_FIELDS` gained
  `lifecycle`, `ref`, `supersedes`.
- `m13/delivery.mjs`: failure channel `decision`.
- `m182/eventRegistry.mjs`: `room_decision_finalized`,
  `room_decision_superseded` (`org_private`).
- `m182/audit.mjs`: four room actions; safe-detail keys `outcome`,
  `decisionId`, `supersedes`, `draftId`.

## 7. Journey — `m23/journey.mjs`

Decision projection gains `kind`, `outcome`, `evidenceCount`;
`decisions.formal` (current formal head), `decisions.draft` (org viewers
only: id, outcome, by, updatedAt), `conditions.hasFormalDecision`,
`conditions.decisionOutstanding` (non-terminal case, no formal head);
timeline kinds `decision_recorded` / `decision_superseded` for formal rows,
`decision` for advisory ones. The note never appears.

## 8. Analytics — M20

`m20/metrics.mjs` registers `decision_outcomes` (pipeline family, window
entry, source `roomDecisions`, reads `kind, state, outcome, createdAt,
supersededById, roomId`, `ratio: false`). `m20/funnels.mjs
decisionOutcomes(ctx)` counts the context's projected decisions;
`m20/dashboard.mjs` projects `kind`, `state` and the outcome word (D-P5-2)
and never the note or the author. `M20_METRICS.md` carries the limitation
verbatim; `m20E2E` guards it.

## 9. Privacy

| surface | what it carries about a decision |
|---|---|
| room (org, in-room roles) | everything, blind rule applied to assessments |
| other organisation | 404 |
| audit log | action, outcome word, ids |
| events | ids |
| journey (org) | outcome, ids, reasons, milestones — no note |
| M20 | counts |
| Second Look / Nobody Missed | the same row M17 wrote; item never carries the note |
| player / guardian API, Inbox, notifications, Passport, export, opportunities, outbox, push log, SSE | nothing |

Sentinels `PRIVATE_DECISION_SENTINEL_5914`, `PRIVATE_ROOM_RATIONALE_SENTINEL_8812`,
`PRIVATE_ASSESSMENT_SENTINEL_3407` are asserted absent on 29 surfaces (I1).

## 10. Clients — Pro and Grassroots (identical panel)

`decisionPanel.tsx` renders inside the room's existing **Decision** tab
(no new tab, no nav item): the formal decision (or "none", with an advisory
note), readiness (counts + per-outcome availability with the reason), the
assessment summary (verdict pills, disagreement notice, per-assessor rows,
withheld count), the draft (outcome radios in a fieldset, reason checkboxes
by category, private rationale, evidence citations, supersession reason
when a formal decision stands), and the history. Finalize sits behind
`confirmDestructive` (`finalizeDecision`, irreversible) whose copy names the
club's internal decision and never an offer; discard behind
`discardDecisionDraft`. A polite live region reports every mutation.
`roomsApi.ts` carries the typed surface; `roomsDemo.ts` mirrors the server
(one draft per room, formal rows joined to the legacy memory, the same error
codes); EN/FR complete; the label set for outcomes and states comes from
`dc.*`. 390/360 px: no horizontal scroll, touch targets inside the viewport
(live N13).

## 11. Tests

| suite | checks | negative |
|---|---|---|
| `scripts/m23DecisionE2E.mjs` | 434 | 314 (72 %) |
| `scripts/m23DecisionPersistence.mjs` | 48 | 17 |
| `scripts/m23DecisionPerf.mjs` | measured, published | — |
| `e2e/m23DecisionLive.test.mjs` | 86 | 25 |

Frozen suites re-run green on the final tree (see the final report).

## 12. What P5 deliberately does not do

- No `decision_pending` / `decision_complete` / `recommended` /
  `committee_review` / `greenlight` state (P13).
- No second decision store, no draft store.
- No offer: no `recruitmentOffers`, no offer term, no offer notification, no
  path to `offer_made` (§161 search in the final report).
- No player or guardian notification, email or push.
- No universal score, no averaging, no ranking.
- No Box Cam result, Trust Score or attendance read to produce an outcome.
- No P5.5 artwork; no P6 Offer workflow.
