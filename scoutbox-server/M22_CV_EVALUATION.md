# M22 — Box Cam CV Evaluation

What the observation engine was measured against, what the numbers are, and
what they do and do not support.

**Engine v2 · CV policy v1 · freeze `m22-v2-freeze-3`**

> **Headline:** the engine is deterministic, invariant across every axis it
> claims to be invariant to, and has never counted a touch that did not happen
> across 56 adversarial scenes. It has **not** been validated against real
> football video, so **no Combine protocol is production-verified.**

---

## 1. What is being evaluated

`m22/` implements a three-layer observation pipeline:

| Layer | File | Job | Knows about protocols? |
|---|---|---|---|
| 1 Detection | `detect.mjs` | ball blob, person region, frame usability | no |
| 2 Tracking | `track.mjs` | tracks, continuity, cadence, player-relative motion | no |
| 3 Protocol | `protocol.mjs` | contact state machine, event counting | yes |
| — Quality | `quality.mjs` | sufficiency, refusal precedence | yes |

Orchestrated by a thin `engine.mjs`. Layers 1 and 2 are never given a protocol
id, which is what makes it possible to state that a detection threshold cannot
have been tuned to make one protocol's fixtures pass.

**The unit system is the load-bearing idea.** Every spatial quantity is
expressed in **ball diameters** and every velocity in **diameters per second**.
The ball is the ruler and the trusted timestamp is the clock, so the same
physical event produces the same numbers at 160×120 and 320×240, and at 12 fps
and 30 fps. Invariance is therefore a property of the design that the fixtures
*check*, not a behaviour the fixtures *train*.

---

## 2. Evaluation material

### Development set — `m22/fixtures.mjs`, `m22/families.mjs`

| Group | Count | What it establishes |
|---|---|---|
| Golden fixtures | 14 | Each declared state, including every refusal reason |
| Variation families | 13 families / 39 variants | Invariance across resolution, frame rate, ball scale, contrast, background luminance, background structure, silhouette geometry, camera motion, cadence jitter, and touch pace |
| False-touch stress | 20 | Every case expects **zero**. Any count is a P0 |
| Consumed holdout material | 84 | Former holdout cases, retained as permanent regressions |

### Holdout set — `m22/holdout.mjs`

Generated with seeds and parameter values disjoint from development, inside the
declared supported envelope, and run **once per generation** under a verified
constant freeze.

### Provenance, stated plainly

All of it is **synthetic**: rendered geometry from `m22/scenes.mjs`. A bright
disc, a dark rectangle, noise, optional texture bands, optional camera
transforms. There is no real football video in this repository and M22 was
forbidden from collecting any.

This is honest material for what it is used for — determinism, invariance,
refusal behaviour, and adversarial resistance are all properties the geometry
genuinely exercises. It is **not** evidence that a touch in a living room is a
touch to this engine. See `M22_REAL_WORLD_VALIDATION_PLAN.md`.

---

## 3. Measured results

### Development — `m22/evaluation.json`

| Metric | Value |
|---|---|
| Golden fixtures | 14 |
| Accepted / refused | 6 / 8 |
| Correct verdicts | **14 of 14** |
| False verifications | **0** |
| Nondeterministic | **0** |
| Families / variants | 13 / 39, **0** off-truth |
| Invariance breaks | **0** |
| False-touch stress cases | 20, **0** false touches |
| Consumed holdout regressions | 84, **0** false touches, 1 off its holdout-era truth |
| Mean absolute count error | 1.00 |
| Max absolute count error | 1 |
| Refusal rate | 57.1% (by construction — half the golden fixtures exist to be refused) |

### Holdout generation 3 — `m22/holdout.json`

| Metric | Development | Holdout |
|---|---|---|
| Family variants | 39 | 28 |
| Off-truth variants | 0 | **0** |
| Invariance breaks | 0 | **0** |
| Adversarial cases | 20 | **20** |
| False touches | 0 | **0** |
| False verifications | 0 | **0** |
| Nondeterministic | 0 | **0** |
| Mean absolute count error | 1.00 | **1.00** |
| Max absolute count error | 1 | **1** |

**Generalisation gap: 0.00.** Reported side by side and never averaged, per the
rule that a merged figure is how a weak holdout hides behind a strong
development score.

---

## 4. The holdout found real defects

This is the part of the evaluation worth reading. The clean generation-3 table
above is the *last* result, not the only one.

### Generation 1 — consumed

Ran under freeze 1. **HT05**, an 18% camera zoom pulse over a ball and player in
a completely fixed relationship, produced one false touch.

Root cause, in the tracking layer: player-relative positions were differenced in
pixels and *then* divided by a single ball diameter. Under a global scale change
by `s`, both `rel` and `d` scale by `s`, so the per-sample ratio is invariant —
but difference-then-divide leaves a residual `((s−1)/s)·(rel/d)`, a velocity
change out of nothing. 18% sailed under the person-region jump guard, which was
set at 1.4× because it was asking an identity question ("is this a different
person?").

It also exposed a hole in the freeze: the freeze covered **constants**, and this
fix changed **code**. The freeze was extended to hash the comment-stripped source
of all four observation layers.

### Generation 2 — consumed

Ran under freeze 2, pressing harder on the axis generation 1 had found a defect
on. It found **two** things.

1. Three more P0 false touches — **HT13** (step zoom in and hold), **HT14**
   (step zoom out), **HT15** (repeated pulses). Generation 1's fix cancelled
   global scale exactly, but a step zoom also **clips the player region against
   the frame edge**, which moves the frame-of-reference origin in a way no global
   transform describes.
2. That the same fix had quietly **cost accuracy**. Normalising by a per-sample
   ball diameter amplifies that estimate's noise by `|rel|/d` — about 3.5× in
   these scenes — which manufactured two extra touches at the smallest frame size
   and broke resolution invariance (counts 13 / 10 / 10 where truth was 11).

Both were replaced by **one** structural test:
`EVENT_RULES.maxFrameScaleStepPerSample`.

### The fix, and why its threshold is derived rather than chosen

When the image scales by `s` between two samples, a stationary ball's apparent
player-relative velocity is `(s−1)·(|rel|/d)/dt` diameters per second. That must
stay under `touchMinImpulseDiametersPerSec` (4.5) in the worst case — the highest
supported cadence, 30 fps, and `|rel|/d` at the top of its working range, about
3.5:

```
(s − 1) · 3.5 · 30 < 4.5   ⟹   s − 1 < 0.043
```

so the bound is **4%**, rounded down. Underneath it sits a noise floor of about
1.1%, since the player region is hundreds of pixels tall even in the smallest
supported frame and a one-pixel edge wobble is that much. The threshold sits
between a 1% floor and a 4.3% danger point, which is why it is stable rather
than lucky.

One test now catches camera zoom, a player walking toward the lens, and the
player region clipping against a frame edge — three situations that all break
the same assumption — without touching the well-conditioned velocity
computation.

### Generation 3 — active, clean

28/28 variants on truth, 0 invariance breaks, 20/20 adversarial cases at zero,
deterministic, no generalisation gap. Its adversarial group deliberately attacks
the fix itself: a scale ramp that stays *just under* the 4% bound on every frame
and compounds past 2×, a player region clipped at the frame edge throughout, a
player walking toward the camera, and a single-frame doubling of scale.

### The discipline that made this possible

- A generation that diagnoses a defect is **consumed** — it can never return to
  holdout duty, because the fix was designed while looking at it. Its cases move
  into the development harness as permanent regressions, where they are the most
  valuable cases in the suite, being the only ones with a demonstrated record of
  catching something.
- The freeze is verified at run time. `scripts/m22Holdout.mjs` **refuses to run**
  against a drifted freeze. This is not decorative: it fired during this work.
- Count errors are **reported, not failed**. A generalisation gap is the
  measurement the holdout exists to produce, and failing a build on it creates
  exactly one incentive.

---

## 5. Declared limitations

Measured, not assumed, and stated here so documentation cannot drift away from
behaviour.

### Over-cadence detection is PARTIAL

The engine cannot reliably detect that a player is touching the ball faster than
the supported pace. `impulsive` is a velocity **change** threshold, and friction
deceleration immediately after a legitimate strike produces a change of the same
magnitude when sampled at video rates. There is no reliable way to separate "a
new strike arriving too soon" from "the previous strike still decaying" with this
detector, so the engine does not pretend to.

Consequence: an over-cadence attempt is **under-counted rather than refused**.
An under-count costs recall and cannot produce a false verification, and the
regression suite asserts that such an attempt still cannot reach production
Combine Verified.

### Supported touch pace: 340 ms between touches

Measured: within tolerance from 900 ms down to 340 ms; at 260 ms (about four
touches a second) the engine returned 10 of 14. The response was to **narrow the
declared envelope**, not loosen the detector — relaxing the refractory or
separation rules to recover those four touches would weaken exactly the defences
that hold the false-touch suite at zero. 260 ms is retained as a declared
limitation case with its real numbers.

### Systematic −1 on touch fixtures

Mean absolute count error is 1.00 on both development and holdout, and it is the
same offset in both: the final strike in a generated sequence has no time to
clear its separation requirement before the capture ends. It is a property of
fixtures that end exactly at the last contact, it is consistent, and it is
reported rather than tuned away.

### Small frame at the bottom of the cadence range

One holdout case (192×144 at 13 fps) returned `insufficient_confidence` where
acceptance was expected. This is a **refusal**, the conservative direction, and
it is recorded as a recall limitation rather than corrected.

### What the synthetic material cannot show

Rendered geometry cannot evidence real-world counting accuracy. The engine has
never seen motion blur from a real lens, rolling-shutter skew, compression
artefacts, a ball that is not a uniform disc, a player who is not a rectangle,
or a real floor. **The holdout is held out from development, not from reality.**

---

## 6. How to run it

```
node scripts/m22CvEval.mjs          # development set -> m22/evaluation.json
node scripts/m22Holdout.mjs         # holdout, once -> m22/holdout.json
node scripts/m22Robustness.mjs      # 48 named regressions
node --expose-gc scripts/m22Perf.mjs # cost, concurrency, soak -> m22/perf.json
```

`m22CvEval` exits non-zero on any false touch, false verification, invariance
break, off-truth variant, nondeterminism, or a recurrence on consumed holdout
material. `m22Holdout` exits non-zero on P0 classes only, and refuses to run at
all against a drifted freeze.

---

## 7. What this evaluation does and does not authorise

**Supports:** that the engine is deterministic; that it is invariant to
resolution, frame rate, ball scale, photometry, background structure, silhouette
geometry, camera translation, shake and zoom, and cadence jitter; that it refuses
with the correct reason across every declared refusal state; that 56 adversarial
scenes designed to manufacture a touch produce none; that a session cannot
inherit state from another; that cost is bounded and nothing leaks.

**Does not support:** any claim about counting accuracy on real football video.

### Production status

`m22/gate.mjs` reports every protocol as **not enabled**:

| Protocol | Enabled | Why not |
|---|---|---|
| `combine-box-touch-60` | no | no provider; no capabilities; **real-world validation not completed** |
| `combine-box-juggle` | no | same |
| `combine-box-control-60` | no | same |

The gate reads `m22/validation.mjs` **independently of this evaluation**, by
design: a synthetic artefact must not be able to assert its own real-world
validity. Even with a perfect provider and flawless synthetic scores, the gate
stays closed on a criterion declared before any of these numbers existed.

**Production eligibility: NOT ELIGIBLE — real-world validation not completed.**
