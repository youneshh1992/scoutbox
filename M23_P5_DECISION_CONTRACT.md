# M23 P5 — The Formal Decision Contract (as built)

This is the canonical behaviour of a formal recruitment decision in ScoutBox
from P5 onward. It stands beside the Trial contract (`M23_P4B_TRIAL_CONTRACT.md`)
and the Contact contract (`M23_P3_CONTACT_CONTRACT.md`) and reads the same
way: what a thing is, who may write it, what it may do to the case, what
never leaves the room. The reuse decisions that shaped it are in
`M23_P5_DECISION_REUSE_AUDIT.md` (R1–R30).

The governing rule (mandate §1):

> evidence ≠ observation ≠ assessment ≠ discussion ≠ decision ≠ offer ≠ signing

A formal decision is the **club's internal, explicit, human act** on a case.
It is informed by evidence, observation, assessment and discussion; it is
derived from none of them. It ends at the internal boundary
`offer_consideration`. It is not an offer, it creates no offer, and the player
is never told about it.

---

## 1. What a formal decision is, and what it is not

A formal decision is a row in `db.roomDecisions` — the same append-only
decision memory M17 built — with `kind: 'formal'`, one of three
**outcomes**, and a `state` that is only ever `'final'`. It is typed by a
room lead or recruitment lead, on a draft they opened, and it is recorded in
the same save as the lifecycle move it asks for.

It is **not**:

- an advisory recommendation (M17's `POST /decisions`, `kind` absent → read
  as `'recommendation'`); an advisory row at the head of the chain is shown
  as *advisory* and evidences nothing;
- a draft (`kase.decisionDraft`, one per case, never in the chain);
- a score, an average, a ranking or a verdict on the player;
- an offer, an offer draft, an offer term, or a step toward `offer_made`;
- a notification to the player or guardian.

## 2. Outcomes

| outcome | M17 `recommendation` also carried | lifecycle action | case moves to | lifecycle reason codes |
|---|---|---|---|---|
| `progress` | `offer` | `considerOffer` | `offer_consideration` | none |
| `hold` | `continue_watching` | `holdCase` | `on_hold` | none |
| `reject` | `archive` | `rejectCase` | `archived` | `rejected` |

The `recommendation` is carried so every legacy reader — Second Look, Nobody
Missed, the journey, M20, the Room's own current-decision line — keeps
reading **one chain**. The outcome word is what the decision *is*; the
recommendation is how M17 spells it.

Nothing maps to `offer_made`, `offer_accepted` or `signed` (m23DecisionE2E U5,
P11). `sendOffer` from `offer_consideration` still needs `offer_sent` evidence
that nothing in P5 produces (J30).

## 3. Draft → final → superseded

- **Draft.** `POST /org/rooms/:id/decision/draft` opens the case's one draft
  (`409 DECISION_INVALID_STATE` names the live one if a second is tried).
  Every content field is optional on a draft — an outcome may be `null`
  ("not chosen yet"). The draft has its own `rev`, edited with `PATCH` and
  discarded with `DELETE`, both under `expectedRev`. A draft is labelled
  `Draft — not a formal decision`, moves nothing, notifies nobody, and is
  not a milestone.
- **Finalize.** `POST …/decision/finalize { expectedRev, clientKey? }` reads
  the draft's content and re-validates it *as a final decision* (an outcome
  is required; a reject needs ≥ 1 reason); references are **resolved again**
  now, so a record that stopped being citable since the draft is refused
  now. The row is built, pushed, and the case is moved through the ONE
  validator and the ONE writer; the draft is cleared; one `persistNow()`.
- **Supersede.** While a formal head exists, a finalize must name it:
  `supersedes` (its id), `supersedesRev` (its current rev) and a non-empty
  `supersessionReason` (≤ 500 chars). `POST …/decision/supersede` is the same
  handler and additionally refuses when there is nothing to supersede. The
  superseded row is not edited: it gains `supersededById` and its own `rev`
  moves to 2; its outcome, reasons and note stay exactly as recorded (H8b).
- **Already there.** A decision whose lifecycle target is the case's current
  status records the decision and moves nothing:
  `lifecycle: { applied: false, reason: 'already_there' }` (H13).
- **Lifecycle refusal.** If the validator refuses the move — no edge from
  this status, wrong role — the row is rolled back and the caller gets
  `409 DECISION_LIFECYCLE_CONFLICT` with the lifecycle code, the allowed
  states and the current status. No row, no move, the draft intact (D3).

## 4. Who may do what

`roomCan` (M17): `decision_view` rank 0 (anyone in the room),
`decision_draft` and `decision_finalize` rank 2 (room lead, recruitment
lead). A contributor or scout reads the surface and is told they cannot
draft (W1–W3). Another organisation gets `404` on every route (W4). A player
or guardian token never reaches an `/org` route (W5). The actor is the
authenticated user, never a body field.

## 5. The blind rule, kept

The decision surface applies the same rule the Room applies to assessments
(M12/M13): a lead sees every submitted assessment; a scout sees their own,
and a peer's submitted one only after submitting their own. What is withheld
is **counted and said** (`withheld: n`), never hidden silently (Q1–Q3). The
summary carries, per assessor, the verdict, how many attributes were rated,
how many marked not observed, the confidence mix and the number of evidence
references — and across assessors the verdict counts and whether they agree.
**Never an average, never a score, never the assessment text** (U35, U36, J8b).

## 6. Evidence references

A decision may cite up to 50 records of four kinds — `assessment`, `trial`,
`box_cam_session`, `passport_evidence` — as `{ kind, id }`. Each is resolved
against **this case's own records** (same organisation, same player, same
case where the record carries one). A reference to another club's
assessment, another player's trial, a Box Cam session not linked on one of
this case's trials, a withdrawn link, a test-only session in production, or
a superseded Passport record is `400 DECISION_CASE_MISMATCH` — the same body
whether the record exists elsewhere or not at all. A draft assessment is
`400 DECISION_EVIDENCE_INVALID`. What is stored beside the reference is the
minimum needed to read the decision later: the assessor's name and verdict,
the trial's state, the session's verification state, the claim type. Never a
rating, a note, a trace or a Box Cam value (U24, J19b).

The evidence-confidence snapshot (M17's `captureSnapshot`) is taken at
finalize through the same code the advisory recommendation uses, with M17's
disclaimer: it is not a record of the player's ability (J20; D-P5-1).

## 7. The ONE precondition widening

`STATUS_EVIDENCE_REQUIRED.offer_consideration = { kind: 'decision_progress' }`.
The evidence provider answers *satisfied* only for a `kind: 'formal'`,
non-draft, `outcome: 'progress'` row on this case, this organisation, this
player, **with no successor**. An advisory "offer", a hold, a draft, a
superseded progress or another case's decision proves nothing (P15–P20, H9).

No precondition was added for `on_hold` or `archived`: a hold or an archive
by hand remains possible, exactly as before P5 (P12). This is a documented
choice, not an omission — those moves are lifecycle events a club may take
without a formal decision, and the case-history record of such a move is
honest about it (no `decisionId`).

## 8. Blocked families and removed subjects

While a player or guardian has blocked the organisation, a decision to
**progress** is refused (`403 DECISION_BLOCKED`); a hold or a rejection is
internal and may be recorded (B3–B5). Once the subject has removed their
account, no draft is opened or edited and nothing is finalized
(`409 DECISION_SUBJECT_REMOVED`); whatever was decided before stays on
record (T1–T3, C6).

## 9. Concurrency, idempotency, atomicity

`expectedRev` is **required and an integer** on every draft edit, discard
and finalize — never coerced (K1). A client key (≤ 64 chars) is scoped to
the case and fingerprinted on the payload: the same key replays; the same key
with different content is `409 DECISION_IDEMPOTENCY_CONFLICT`; a draft key
replayed after the draft was finalized returns the decision it became (J31).
Two finalizes race to one decision; two supersedes to one successor; a
finalize and a close, a finalize and the player's deletion, an edit and a
finalize — whichever lands first wins and the other is refused by name
(C1–C8). The injected `decision` transport failure refuses **before**
anything is recorded: no row, no history, no move, no audit, no notification
(F1–F4).

## 10. Rate policies

`decision_draft` 60 per hour per organisation; `decision_finalize` 30 per
hour per organisation (`RATE_LIMIT_POLICY`, L1–L2).

## 11. Errors

Nineteen `DECISION_*` codes in the M23 error table, no default branch,
every one producible (m23E2E Y3). 400 for what the caller can fix
(`OUTCOME_INVALID`, `REASON_INVALID`, `CONTENT_INVALID`, `EVIDENCE_INVALID`,
`CASE_MISMATCH`, `CLIENT_KEY_INVALID`, `REV_REQUIRED`); 403 for
`NOT_PERMITTED` and `BLOCKED`; 404 `NOT_FOUND`; 409 for the state codes
(`INVALID_STATE`, `ALREADY_FINAL`, `VERSION_CONFLICT`, `IDEMPOTENCY_CONFLICT`,
`LIFECYCLE_CONFLICT`, `SUBJECT_REMOVED`); 500 for ours (`STATE_UNKNOWN`,
`STORE_MISSING`, `TRANSPORT_REFUSED`). `M23_ERROR_CONTRACT.md` §7 lists them.

## 12. Events, audit, journey, analytics

- Events `room_decision_finalized` / `room_decision_superseded`
  (`org_private`, payload `orgId, roomId, decisionId` — ids only, no
  outcome, no note); a terminal outcome also broadcasts M17's
  `recruitment_room_archived`, the Second Look contract (R6).
- Audit actions `room_decision_drafted`, `room_decision_draft_discarded`,
  `room_decision_finalized`, `room_decision_superseded`; the safe detail
  carries `outcome`, `decisionId`, `supersedes`, `draftId` — never the note (I4).
- The journey projects `decisions.formal`, `decisions.draft` (org viewers
  only), `conditions.hasFormalDecision`, `conditions.decisionOutstanding`,
  and milestone entries `decision_recorded` / `decision_superseded` without
  the note (J26).
- M20 `decision_outcomes`: counts by outcome and how many were superseded, no
  rate, no ranking, no player field (N1–N3; D-P5-2).
- Notification: the room owner and lead (not the actor) receive a
  `recruitment_room` notification naming the outcome label. The player and
  guardian receive nothing, by any channel (I1–I3).

## 13. Second Look and Nobody Missed

A formal rejection with a revisitable reason is the row Second Look reads:
new full-match evidence after it produces one direct, reason-aware item, and
another club sees none of it (R8–R11). A formal decision counts as
`room_decided` for Nobody Missed (R12). Neither engine was modified.

## 14. Historical honesty

Legacy M17 rows have no `kind` and read as advisory; P5 never judges them,
never backfills an outcome, never repairs a row. A corrupt **formal** row is
named in the log, omitted from the surface and counted (`omitted: n`), and
left in the snapshot exactly as found. Two formal rows with no successor are
corruption: the surface and every finalize answer `500 DECISION_STATE_UNKNOWN`
and nothing is written on top (persistence §3).

## 15. What a formal decision must not do — confirmed by test

| never | proof |
|---|---|
| be produced from evidence, an assessment, a trial, Box Cam or a Trust Score | J10: two assessments (one says sign), a completed trial, and still no decision until a person types one |
| collapse assessments into a score | U36, J8b, live A4c |
| move the case outside the ONE validator and writer | route reads `ctx.applyLifecycleTransition` only; D3 rollback; adversarial sweep |
| reach `offer_made`, create an offer, notify a player | U5, J30, I1–I3, N9b live, §161 search |
| edit a final row | H8b; supersession only |
| leak the rationale | I1 over 29 surfaces, J21b (event), J26c (journey), I4b (audit) |
| be enumerated by another organisation | W4, I5, R11 |
