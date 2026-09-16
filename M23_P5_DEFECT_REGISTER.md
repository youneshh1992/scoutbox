# M23 P5 — Defect Register

Defects found while building the formal recruitment decision (P5), plus the
disposition of what P4B left open. The rule (mandate §157 and the P4B rule
before it): any Critical or High is fixed before the next phase begins; any
reasonably fixable Medium is fixed before closure; nothing is carried forward
silently.

Severity vocabulary (unchanged): **Critical** major security / privacy /
safeguarding / data-integrity compromise; **High** significant auth /
privacy / safeguarding / integrity failure or a broken core workflow;
**Medium** real correctness / availability / privacy / lifecycle /
data-quality defect that should reasonably be fixed before the milestone
closes; **Low** hygiene, cosmetic, documentation.

Every entry records: ID · severity · phase · area · reproduction · root
cause · impact · fix · regression · commit · status.

How the P5 defects were found: both were surfaced by the P5 acceptance suite
(`m23DecisionE2E`) on the first run against the committed server phase, not
by inspection. Each is a real fault in the wiring as first written and each
would have shipped without the test that caught it. Both are fixed in the
tests commit that carries the suite (`2c55952`).

Regression suites named below: `m23DecisionE2E` =
`scoutbox-server/scripts/m23DecisionE2E.mjs` (434 checks, 314 negative,
72 %); `m23DecisionPersistence` (48 checks, 17 negative); `m23DecisionLive`
= `e2e/m23DecisionLive.test.mjs` (86 checks, 25 negative); `m20E2E`
(265 checks).

---

## D-P5-1 — Medium — P5-1 — Decision route: no evidence-confidence snapshot — **CLOSED**

**Reproduction:** open a room, `startReview`, draft a hold, finalize.
`POST /org/rooms/:id/decisions` (M17 advisory) on the same room returns a
row with `snapshot: { at, trust: { score, band, … } }`; the P5
`POST …/decision/finalize` returned `snapshot: null` on every decision.

**Root cause:** the M23 context is composed in `server.mjs` from
`m19Ctx` plus M17's seams passed *explicitly* (`findRoomForRequest`,
`applyLifecycleTransition`, `roomIsRoom`) because `registerM18` returns a
fresh object and M17's seams do not arrive through `m19Ctx`. P5-1 attached
`captureRoomSnapshot` to the M17 context object (`m17/rooms.mjs`) but did not
add it to that explicit list, so `ctx.captureRoomSnapshot?.()` was
`undefined` inside the decision routes and the optional call silently
yielded `null`.

**Impact:** every formal decision was recorded without the evidence
confidence at decision time that M17 captures for an advisory
recommendation — a data-quality gap in the record (a later Second Look
cannot say what the club knew then), no privacy or safeguarding dimension.
Medium.

**Fix:** `captureRoomSnapshot: m17Ctx.captureRoomSnapshot` in the M23
context composition, beside the other two M17 seams, with a comment naming
this defect.

**Regression:** `m23DecisionE2E` J20 (the finalized row carries the snapshot
with M17's disclaimer); persistence §2 restores the snapshot field
byte-faithfully.

**Commit:** `2c55952`. **Status: CLOSED.**

---

## D-P5-2 — Medium — P5-1 — M20 `decision_outcomes` always zero — **CLOSED**

**Reproduction:** finalize several decisions in the window;
`GET /org/recruitment-analytics` → `data.pipeline.metrics.decision_outcomes`
reports `n: 0`, every outcome 0, superseded 0.

**Root cause:** two faults in one metric. `decisionOutcomes(ctx)` read
`ctx.roomDecisions`, a field the M20 reporting context never exposes (it
exposes `ctx.decisions`, the org-scoped, room-filtered projection); and the
context's `projectDecision` — deliberately narrow so analytics cannot read a
note or an author — did not carry `kind`, `state` or `outcome`, so even the
right field held no outcome to count. The registry, the doc and the m20E2E
guards all described the metric correctly; the projection did not.

**Impact:** a director's dashboard panel that read "0 formal decisions"
whatever the club had decided. Correctness of a count; no privacy dimension
(nothing leaked; nothing was shown). Medium.

**Fix:** `projectDecision` gains `kind`, `state` and the outcome *word*
(through a `formalFields` helper so the projection stays inside m20E2E's
N22 source guard, which pins that `note` and `by` never enter it);
`decisionOutcomes` reads `ctx.decisions`; the registry's `reads` names
`state`.

**Regression:** `m23DecisionE2E` N1–N3 (counts by outcome ≥ 8, superseded
≥ 3, no rate, no score, no player id, no note); `m20E2E` 265 checks
including N22 and the "documents every metric's limitation" guard.

**Commit:** `2c55952`. **Status: CLOSED.**

---

## Not defects, recorded for honesty

- **`lifecycle`, `ref` and `supersedes` were not public error fields.** The decision routes attached them; `publicErrorBody`
  stripped them, so a `DECISION_LIFECYCLE_CONFLICT` could not say which
  lifecycle rule refused it. Added to `PUBLIC_ERROR_FIELDS` in the same
  commit. Not a defect in behaviour (the refusal itself was right), a gap in
  the contract's explanation; Low, closed.
- **The first cut of that widening also let `unknown` and `prohibited`
  through.** The closure battery's `m23E2E` Y11 (the lifecycle route's
  public error shape, pinned since P2) caught it: the lifecycle route's own
  reason-code refusals started carrying the two lists. Narrowed back to the
  three P5 fields in the closure commit; `m23E2E` 382 and `m23DecisionE2E`
  434 both green after. Recorded because a battery, not a reviewer, found it.
- **`ROOM_ACTIONS` is not exported by `m182/audit.mjs`.** The suite reads the
  source text for the four action names instead. Left as is.

---

## Disposition of what P4B left open

| P4B item | P4B status | P5 disposition |
|---|---|---|
| P4A-D6 `refusedClientFields()` not invoked by the M22 routes | OPEN | **OPEN, unchanged.** P5 does not touch `m22/*`. |
| P4A-D7 documentation drift (`M16_BOX_CAM.md`, `M22_MATRIX.md` B6) | OPEN, doc-only | **OPEN, unchanged.** |
| P4A-D8 dead assessment state `'published'` tolerated by a reader | OPEN | **OPEN, unchanged.** P5 reads `state !== 'draft'` and `a.publishedFeedback`, never `'published'`. |
| P4A-D11 grassroots open-day `invite_trial` bypasses `issueRecruitmentRequest` | OPEN | **OPEN, unchanged.** No P5 code path touches the open-day writer. |

## Open at closure

Critical: 0. High: 0. Medium: 0. Low: the four inherited P4A items above,
each with its owner phase unchanged.
