# M23 P5 — Decision Reuse Audit (pre-flight)

Read before a line of production code was written. The question for every
requirement in the P5 mandate is the same one P3 and P4B asked: *what already
owns this, and is it enough?* The answer here is that ScoutBox already has a
recruitment decision memory (`db.roomDecisions`, M17), a lifecycle writer
(M23 P2), a decision reason taxonomy (M17), a blind assessment rule (M12/M13),
a Second Look engine keyed on decisions (M18) and a permission surface
(`roomCan`). P5 **extends** that memory with a formal, evidence-referenced,
lifecycle-coupled decision and adds **no store**.

Classification vocabulary (§4): `reuse unchanged` · `extend existing` ·
`new model justified` · `not required`.

---

## 1. `roomDecisions` — full inspection (§5)

**Owner:** `m17/rooms.mjs` (writer + readers), `m17/shared.mjs` (taxonomy,
validation, snapshot shape), guaranteed by `m182/migrations.mjs`
(`m182_002_collections_present`), contract row in `storeContract.mjs`
(`guarantee: 'migration', owner: 'm17'`).

**Current fields** (one row per recorded decision):

| field | meaning |
|---|---|
| `id` | `rdec-…` |
| `roomId`, `orgId`, `playerId` | the case, the club, the subject — the case id **is** the room id |
| `recommendation` | one of `RECOMMENDATIONS = no_decision, continue_watching, shortlist, priority, trial, offer, archive` — an *advisory* recommendation, not an operational outcome |
| `reasonCodes` | M17 decision taxonomy, ≤ 6, from `REASON_CODES` (football / evidence / process / outcome), protected traits refused (`PROHIBITED_REASON_CODES`) |
| `note` | club-private free text ≤ 2000, plain text (markup stripped), moderated |
| `by` | `{ userId, name, role }` from the authenticated org user |
| `createdAt` | server clock |
| `trigger` | `'decision'` (explicit) or `'status:<to>'` (auto-recorded when the legacy status route ends a room) |
| `clientKey` | idempotency key, **key only** (no payload fingerprint) |
| `supersedes`, `supersededById` | the append-only chain: a new row supersedes the previous head; nothing is rewritten |
| `snapshot` | `{ at, trust (score/band/policy/component levels/hash), sourceRefs (passportVersion, passportRevision, evidenceIds ≤40, assessmentIds ≤20, combineResults ≤20, trialIds ≤10), snapshotId }` — evidence *confidence* at decision time, never ability |

**Status / state:** none stored. "Current" is the chain head
(`supersededById == null`); M17 reads last-by-createdAt, M18 reads the exact
head. There is **no draft state** and **no own revision**; the writer guards
on the *room's* rev (M18.1).

**Writer routes:** `POST /org/rooms/:id/decisions` (`roomCan record_decision`
= room lead and above; room-rev guard; `validateDecision`; moderation;
snapshot; append) and the legacy `POST /org/rooms/:id/status` when the target
is `archived | closed | withdrawn` (auto-records `recommendation: 'archive'`
with the transition's reason codes). The M23 lifecycle route
(`POST /org/rooms/:id/lifecycle`) records **no** decision.

**Reader routes:** `GET /org/rooms/:id/decisions` (current, history,
taxonomy), the Room projector (`decision.current`, `decision.history`, room
health), the M23 journey (club projection: id, recommendation, codes, by,
supersededById, `hasNote` — the note is never projected), M18 Second Look
(`latestDecision` head + snapshot for "what changed since you decided"), M18
Nobody Missed (`room_decided`, `lastDecisionAt`), M20 (`exit_reason_mix`,
`time_to_first_decision`, `decision_outstanding`,
`terminal_with_recorded_decision`, `superseded_decision_rate`,
`evidence_limited_exits` — reason codes and timestamps only), the M18.2 audit
log (`room_decision_recorded`, detail whitelisted to ids/codes), the T&S
surface (a **count** only).

**Roles:** `record_decision` = rank 2 (room lead, recruitment admin); read =
every room reader (viewer and above). Player, guardian and T&S have no route
to a decision body.

**Reason codes:** M17 decision taxonomy (20 codes, 4 categories); explicitly
separate from the 16 lifecycle reason codes (`M23_TERMINOLOGY.md`, P2 B4).

**Immutability / revision handling:** append-only; supersession by a new
row; no edit route exists; `supersededById` is the only field ever written on
an existing row.

**Links:** `roomId` (= case id), `orgId`, `playerId`; the snapshot references
evidence, assessments, combine results and trials by id.

**Existing UI:** the Room's page-local **Decision** tab (`DecisionPanel` in
`roomsScreens.tsx`, Pro and Grassroots): current recommendation, readiness
counts, a "Record decision" form (recommendation + reason picker + note),
history. No draft, no outcome vocabulary, no evidence references, no
disagreement view.

**History:** the row chain itself plus the Room activity entry
`room_decision_recorded` (ids and codes).

**Analytics / events:** M20 metrics above; the only stream event tied to a
decision is `recruitment_room_archived` (ids only) when the room is terminal.

**Player visibility:** none. The journey's player/guardian projection carries
no decision; sentinel sweeps in `m23E2E`, `m23ContactE2E` and `m23TrialE2E`
prove the note reaches no family surface.

**Verdict:** sufficient as the *store* and the *chain*. What it lacks for P5
— a draft, an operational outcome distinct from the advisory recommendation,
its own revision, payload-fingerprinted idempotency, validated evidence
references and a coupling to the lifecycle writer — are **additive fields and
one draft container on the case**, not a second store.

## 2. Requirement-by-requirement (§4)

| # | requirement | existing owner | decision | reason | privacy risk | lifecycle risk | migration impact |
|---|---|---|---|---|---|---|---|
| R1 | Decision store | `db.roomDecisions` | **extend existing** | additive fields (`kind:'formal'`, `outcome`, `state`, `rev`, `keys`, `evidenceRefs`, `assessmentSummary`, `lifecycle`, `supersession`); legacy rows read as `kind:'recommendation'`, `state:'final'` | none new — same store, same readers, same sentinel rules | none — outcome maps onto the existing `recommendation` value so every legacy reader (Second Look, journey, M20, Nobody Missed) keeps reading the chain | **none** — `??` reads; no backfill; no rename |
| R2 | Draft decision | none (no draft exists) | **extend existing** (case field `kase.decisionDraft`, one per case) | a draft is *not* a decision: kept off the chain so no legacy reader, Second Look, metric or journey milestone can mistake it for one; cleared on finalize | draft note is club-private; never projected outside the org room read | none — a draft never touches the case status | none |
| R3 | Outcomes | M17 `RECOMMENDATIONS` | **extend existing** with three operational outcomes `progress · hold · reject`, each carrying its mapped recommendation (`offer`, `continue_watching`, `archive`) | the M17 values are advisory ("what I recommend"); P5 needs "what the club decided"; keeping both on one row keeps one chain | none | mapped through the frozen semantic actions only (`considerOffer`, `holdCase`, `rejectCase`) | none |
| R4 | `second_look` outcome | M18 Second Look engine | **not required** | eligibility is *derived* by M18 from the chain head's reason codes (`REVISITABLE_REASON_CODES`) on an archived room; a reject with evidence-shaped codes is already a Second Look candidate | none | none | none |
| R5 | Reason taxonomy | M17 `REASON_CODES`, `validateReasonCodes` | **reuse unchanged** | P2 B4: lifecycle codes describe *why the case moved*; decision codes describe *why the club concluded*; P5 writes lifecycle codes to the history and decision codes to the row, never the other way | protected traits already refused | none | none |
| R6 | Lifecycle coupling | M23 `canTransitionRecruitmentCase` + `ctx.applyLifecycleTransition` | **reuse unchanged** | progress → `considerOffer`, hold → `holdCase`, reject → `rejectCase` (lifecycle reason `rejected`), all through the one validator and the one writer, in the same save | none | the case moves only when the validator agrees; a refused edge refuses the finalize (`DECISION_LIFECYCLE_CONFLICT`); a case already at the target records the decision without moving | none |
| R7 | `offer_consideration` evidence | `STATUS_EVIDENCE_REQUIRED`, `m23/evidence.mjs` | **extend existing** (one row: `offer_consideration → decision_progress`) | §56: a finalized *progress* decision is the only door to offer consideration, on every path (lifecycle route, legacy status route, reopen) | none | the ONE widening of the precondition table P5 makes — not a state, not an edge; no existing suite drives a case to `offer_consideration` through a route (verified: only pure-validator and fixture references) | none |
| R8 | `on_hold` evidence | `holdCase` | **reuse unchanged** (no precondition added) | `on_hold` asserts no durable external fact (P2: preconditions exist for statuses that assert one); an operational hold without a formal decision stays possible; the P5 route moves the case only after a finalized hold decision | none | none | none |
| R9 | Reject / close | `rejectCase` → `archived` | **reuse unchanged** | `archived` is the frozen rejection state; `closed`/`withdrawn` are different events and are not decision outcomes | none | none | none |
| R10 | Second Look handoff | M18 `latestDecision` + `recruitment_room_archived` | **reuse unchanged** | the formal reject row becomes the chain head on the archived room; the engine derives candidacy; the same event is broadcast | none | none | none |
| R11 | Nobody Missed | M18 `evaluationSignals.room_decided` | **reuse unchanged** | a formal row counts like any decision | none | none | none |
| R12 | Decision outstanding | `derivedConditions.decisionPending` | **extend existing** (journey condition `decisionOutstanding`: evaluation complete, no formal current decision, case live) | derived, never stored | none | none | none |
| R13 | Assessment inputs | `db.assessments`, M12 blind rule, `assessmentsFor` | **reuse unchanged** (a projection: counts, per-assessor verdict, not-observed and confidence counts, evidence-ref counts) | independent assessments summarised, never averaged; blind rule applied as the Room already applies it | the summary carries no rating text and no note | none | none |
| R14 | Evidence references | snapshot `sourceRefs`, P4B `evidenceRefs` whitelist pattern | **extend existing** (`evidenceRefs[]` validated: same org + player + case; assessment submitted; trial of this case/player; Box Cam session linked on a case trial; Passport evidence row of the player) | references + minimal immutable metadata; no blobs | a foreign or test-only reference is refused, so a decision can never cite what the club may not see | none | none |
| R15 | Snapshot | `captureSnapshot` (M17) | **reuse unchanged** (exposed on the context as `ctx.captureRoomSnapshot`) | the same decision-time confidence record; `db.roomSnapshots` | as today | none | none |
| R16 | Permissions | `roomCan` | **extend existing** (`decision_view` 0, `decision_draft` 2, `decision_finalize` 2) | mirrors `record_decision`; viewer read-only; contributor (scout) may assess and discuss, not decide | none | none | none |
| R17 | Actor | authenticated org user | **reuse unchanged** | never from the body | none | none | none |
| R18 | Concurrency | `m181/concurrency.mjs` `guardRev` | **reuse unchanged** on the draft's own `rev` and the current decision's own `rev` | integer or refused, no coercion (P4B rule) | none | none | none |
| R19 | Idempotency | P3 `normaliseClientKey`, `payloadFingerprint` | **reuse unchanged** | key + fingerprint for draft create and finalize; the legacy key-only dedup on `POST /decisions` is left as is (frozen M17) | none | none | none |
| R20 | Failure injection | M13 `deliveryFailInject` | **extend existing** (channel `decision`) | the same admin route; refusal between row and lifecycle leaves nothing persisted | none | none | none |
| R21 | Rate limiting | `m181/rateLimit.mjs` | **extend existing** (`decision_draft` 60/h org, `decision_finalize` 30/h org) | central limiter | none | none | none |
| R22 | Errors | `m23/errors.mjs` table | **extend existing** (`DECISION_*` codes, one band each) | drift guard covers them | no stacks, no store names | none | none |
| R23 | Events | `m182/eventRegistry.mjs` | **extend existing** (`room_decision_finalized`, `room_decision_superseded`, org-private, ids only); drafts emit nothing | ids only | none | none |
| R24 | Audit | `m182/audit.mjs` | **extend existing** (`room_decision_drafted/finalized/superseded` actions; `outcome`, `decisionId`, `supersedes` in the detail whitelist) | ids, outcome, codes — never the note | none | none | none |
| R25 | Notifications | `notify` type `recruitment_room` | **reuse unchanged** (room owner + lead, not the actor) | no player/guardian notification exists or is added | none | none | none |
| R26 | Journey | `m23/journey.mjs` | **extend existing** (club projection: `kind`, `outcome`, `draft` summary; timeline entries carry `outcome`) | player/guardian projections untouched (no decision field exists there) | none | none | none |
| R27 | Analytics | M20 registry/funnels/dashboard | **extend existing** (`decision_outcomes`: counts of formal progress/hold/reject in window, `ratio:false`, small-n) | process only; never a player ranking | none | none | none |
| R28 | UI | Room Decision tab (`DecisionPanel`) | **extend existing** (a `decisionPanel.tsx` section rendered inside the existing tab; the M17 advisory form kept, unchanged strings) | no new nav, no header change | none | none | none |
| R29 | Offer boundary | `db.recruitmentOffers` (absent), `sendOffer` | **not required / forbidden** | no Offer object, draft, term or notification; `offer_made` unreachable (its `offer_sent` precondition is still `not_implemented`) | none | the repository search in the closure sweep proves no P5 path writes an offer | none |
| R30 | Migration / store contract | `m182/migrations.mjs`, `storeContract.mjs` | **not required** | no new store, no renamed concept, additive fields read with defaults; schema stays 2304 | none | none | none |

## 3. What P5 will NOT build

- No `recruitmentDecisionsV2`, `caseDecisions`, `trialDecisions`,
  `finalDecisionStore` (§6).
- No lifecycle state (`decision_pending`, `committee_review`, …) (§8).
- No automatic decision from any count, average, Trust Score, Box Cam
  observation or attendance (§18–§20); no consensus computation (§65).
- No universal score (§20).
- No player or guardian notification, no outbox email, no Inbox row (§15,
  §83, §84).
- No Offer object, term or notification (§16); no `offer_made` (§161).
- No new governance engine; single authorised actor as today (§66, §67).
