# M22 CV Robustness Fix Pack — Final Report

**Engine v2 · CV policy v1 · freeze `m22-v2-freeze-3`**

> *"Before ScoutBox learns to verify more, prove that each attempt starts clean,
> ends clean, and cannot inherit certainty from missing observations or another
> session."*

Twenty-five numbered items. Nothing pushed, no PR opened, production Combine not
enabled, and the validation blocker not bypassed — the four standing
prohibitions held throughout.

---

## Exit gate (§77)

| Suite | Result |
|---|---|
| `scripts/m22CvEval.mjs` | **PASS** — 14/14 fixtures, 39/39 variants on truth, 0 invariance breaks, 20 stress + 84 consumed-holdout cases at 0 false touches, 0 false verifications, 0 nondeterministic |
| `scripts/m22Holdout.mjs` | **PASS** — generation 3: 28/28 on truth, 0 invariance breaks, 20/20 adversarial at zero, generalisation gap 0.00 |
| `scripts/m22Robustness.mjs` | **PASS** — all 48 named checks |
| `scripts/m22Perf.mjs` | **PASS** — bounded queue, released sessions, no retained pixels, no leaked objects |
| `e2e/demoHostOrdering.test.mjs` | **PASS** — all 15 checks |
| `e2e/crosstab.test.mjs` | **PASS** — from a genuinely empty :8099 |
| `e2e/demoOffline.test.mjs` | **PASS** — from a genuinely empty :8099 |

**Production eligibility: NOT ELIGIBLE — real-world validation not completed.**
That is not a failure of this pass. It is the outcome the gate was built to
produce, on a criterion declared before any of these numbers existed.

---

## The twenty-five items

### Session lifecycle (1–7)

**1. Complete session reset.** `resetRun()` in `m22/session.mjs` is a
single-entry contract over `MUTABLE_RUN_KEYS`, not scattered assignments. The
test compares a RESET instance against a FRESH one field by field, so adding a
mutable field to `ObservationRun` without adding it to the contract fails the
suite. That failure is the feature.

**2. Tracker reuse cannot leak state.** `ObservationSessions` takes a `pool`
option whose only purpose is to make the reuse hazard *testable*. Pooling is the
arrangement that silently defeats "just make a new object", and it looks like an
optimisation in review, so it is exercised rather than argued about.

**3. Concurrent-session isolation.** Runtime is keyed by **session id only** —
never by player, protocol or organisation, because one player may legitimately
have two attempts open and a coarser key merges them. All four layers are pure
with no module-level state, so isolation is structural rather than a discipline
someone has to remember.

**4. Stale session ids cannot submit frames.** A disposed runtime is not found;
there is no resurrection path. Ingest on a non-active session is rejected by
state, and past TTL the session is expired, released, and the frame refused.

**5. Cancelled, expired and disconnected cleanup.** Everything an attempt
allocates lives on one runtime object, so cleanup releases one thing rather than
remembering seven. Disposal is idempotent by construction. An abandoned attempt
mints **no result**.

**6. Dropped-frame contact boundaries.** Every motion triple carries
`gapBeforeMs`/`gapAfterMs` so the protocol layer can tell a genuine adjacency
from one spanning a gap. The engine does not extrapolate through lost contact
frames.

**7. No double-count after a gap.** The refractory interval is in
**milliseconds**, never frames, so it means the same thing on both sides of a
dropped-frame gap and at every cadence.

### Measurement discipline (8–14)

**8. Refractory boundary tests at 1 ms granularity.** These found a *fixture*
bug first: the synthetic motion stream stepped 20 ms, so contacts scheduled at
179/181 ms never landed on a sample and `refractory_minus_1ms` was "passing"
because there was no second impulse at all. Fixed as a fixture error, not by
touching the engine.

**9. The constant freeze.** `m22/freeze.mjs` hashes nine groups covering
everything that can change a count. Checksums are recorded as literals; the
holdout harness **refuses to run** against a drifted freeze.

**10. The freeze had a hole, and it was found the hard way.** It originally
covered constants only. A change to layer *code* changes what the engine counts
without moving a threshold, so the freeze would have reported itself intact while
the holdout beneath it went stale. A ninth group now hashes the comment-stripped
source of the four observation layers. Comment-stripped, because a freeze that
cries wolf on reworded comments is one people learn to re-record without reading.

**11. Holdout generations, with a consumption rule.** Disjoint seed blocks from
development, parameter values no earlier set used, inside the declared envelope,
run **once**. A generation that diagnoses a defect is **consumed** and can never
return to holdout duty — the fix was designed while looking at it. Its cases move
into the development harness as permanent regressions, where they are the most
valuable cases in the suite, being the only ones with a demonstrated record of
catching something.

**12. Reported separately (§38).** Development and holdout numbers sit in
separate columns and separate objects and are never averaged. A merged figure is
precisely how a weak holdout hides behind a strong development score.

**13. Count errors are reported, not failed.** A generalisation gap is the
measurement the holdout exists to produce. Failing a build on it creates exactly
one incentive, and that incentive is the thing the whole apparatus is built to
resist. Only P0 classes — false touches, false verifications, nondeterminism —
exit non-zero.

**14. The freeze guard fired in anger.** During this work a code change drifted
the `source` group and `m22Holdout` refused to run and named it. The mechanism is
not decorative.

### The two P0 defects the holdout found (15–18)

**15. Generation 1 — HT05.** An 18% camera zoom pulse, over a ball and player in
a completely fixed relationship, produced one false touch. Root cause in the
tracking layer: player-relative positions were differenced in pixels and *then*
divided by a single ball diameter. Under a global scale by `s`, both `rel` and
`d` scale by `s`, so the per-sample ratio is invariant — but difference-then-
divide leaves `((s−1)/s)·(rel/d)`, a velocity change out of nothing.

**16. Generation 2 — three more, plus a cost.** Pressing harder on the same
axis: step zooms in and out and repeated pulses produced three further P0 false
touches, because a step zoom also **clips the player region against the frame
edge**, moving the origin in a way no global transform describes. Worse, the
generation-1 fix had quietly cost accuracy — normalising by a per-sample diameter
amplifies that estimate's noise by `|rel|/d` ≈ 3.5, manufacturing two extra
touches at the smallest frame size and breaking resolution invariance.

**17. One structural fix, with a derived threshold.**
`EVENT_RULES.maxFrameScaleStepPerSample` = 4%, from
`(s−1)·3.5·30 < 4.5 ⟹ s−1 < 0.043`, sitting between a 1.1% detector noise floor
and a 4.3% danger point. It replaced a 1.4× test that was asking an identity
question — "is this a different person?" — where the question that matters for
counting is thirty times smaller. One test now catches camera zoom, a player
walking toward the lens, and edge clipping, without touching the
well-conditioned velocity computation.

**18. Generation 3 attacks the fix itself.** A scale ramp staying just under the
bound on every frame and compounding past 2×, a player region clipped at the
frame edge throughout, a walk toward the camera, and a single-frame doubling of
scale. All read zero. A holdout that avoids the axis a previous generation found
a defect on is a victory lap, not a holdout.

### Cost and bounds (19–21)

**19. Per-layer cost, measured.** Detection 0.31 / 0.50 / 0.92 ms per frame at
160×120 / 240×180 / 320×240; tracking ~0.17 ms per finish, flat across frame
size; protocol and quality under 0.01 ms; finalization 0.21–0.38 ms. Cost per
megapixel *falls* as frames grow, so detection is at worst linear in pixels.
Ingest ~0.57 ms per frame at every cadence — about 0.01–0.02× of realtime.

**20. Concurrency and the event loop.** 1/2/5/10 interleaved sessions cost within
±10% per session of running one alone; there is nothing to contend on. Event-loop
lag p95 0.58 ms while ingesting, against 0.08 ms idle. One frame is the unit of
blocking, which is why `FRAME_LIMITS` caps a batch at 12.

**21. Soak and bounds.** 500 sessions, a quarter cancelled rather than finished
because a leak is likeliest on the path nobody watches: heap 5.30 → 5.32 MB, zero
retained sessions, queued frames, detections or timers. The queue held 24 of 240
pushed and **reported** the 216 drops rather than dropping silently. Only
structural properties fail the run; wall-clock timings are recorded and never
asserted, because this is not the production machine.

### Honesty about limits (22–23)

**22. Over-cadence detection is PARTIAL, and says so.** `impulsive` is a velocity
*change* threshold, and friction decay immediately after a legitimate strike
produces a change of the same magnitude at video sample rates. There is no
reliable way to separate "a new strike too soon" from "the previous strike still
decaying" with this detector, so the engine does not pretend to. It under-counts
rather than refusing — which costs recall and cannot produce a false verification
— and a regression asserts that such an attempt still cannot reach production
Combine Verified. Suppression counting was **removed** rather than tuned, after
it was found condemning valid attempts.

**23. The pace envelope was narrowed, not the detector loosened.** Measured
within tolerance from 900 ms down to 340 ms; at 260 ms the engine returned 10 of
14. Recovering those four touches would have meant relaxing the refractory or
separation rules — the exact defences holding the false-touch suite at zero. 340
ms is the declared floor; 260 ms is retained as a declared limitation with its
real numbers. Also recorded: a systematic −1 on touch fixtures (the final strike
has no time to clear separation before the capture ends) and one small-frame
low-cadence case that refuses where acceptance was expected — a refusal, the
conservative direction.

### Documentation and infrastructure (24–25)

**24. Documents.** `M22_REAL_WORLD_VALIDATION_PLAN.md` — written before the data
exists, because a protocol written after seeing results is a rationalisation.
`M22_CV_EVALUATION.md` — what was measured, what it supports, and what it does
not. `M22_CV_THREAT_MODEL.md` extended with T31–T42, including the two found by
measurement and the two methodology threats (a holdout that stops being one;
stale test infrastructure). `M22_MATRIX.md` extended with defects F2–F5 and
section K.

**25. The harness was lying, and now is not.** `crosstab` and `demoOffline`
assumed a demo host on :8099; usually one was there from an earlier session, so
both passed against bundles this run never produced. Tests now own their host
**and** the host publishes a content-derived build marker, so an existing host
serving anything else is refused with the port and remedy named. Ownership alone
would have degraded into "start one unless something is already there" — the
original bug with an extra branch. Verified from a genuinely empty port.

---

## The result that matters

The gate is **closed**, and it would stay closed with a hypothetically perfect
provider and flawless synthetic scores, because `m22/gate.mjs` reads
`m22/validation.mjs` independently of the evaluation artefact. A synthetic result
cannot assert its own real-world validity.

| Protocol | Enabled |
|---|---|
| `combine-box-touch-60` | no — real-world validation not completed |
| `combine-box-juggle` | no — real-world validation not completed |
| `combine-box-control-60` | no — real-world validation not completed |

M22 finishes with no Combine protocol production-verified. The mandate's §168
anticipated this outcome and named it acceptable. It was reached by measurement,
not by judgement — and the holdout's four P0 false touches, on scenes where
nothing moved, are the clearest available argument that the caution is earned
rather than performed.

*Observe narrowly. Measure honestly. Refuse when uncertain.*
