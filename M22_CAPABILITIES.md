# M22 — Box Cam CV Capabilities

What the runtime provider can actually do, stated so that no two of these can
be confused for one another.

**Provider `production_cv` v1 · engine v2 · CV policy v1 · freeze `m22-v2-freeze-3`**

> **Box Cam uses server-side computer vision to observe supported activity.**
>
> **Combine verification for these CV protocols remains disabled pending
> real-world validation.**

Those two sentences are the whole document. Everything below is detail.

---

## 1. The capability matrix

The column that matters is the last one, and the reason it is a separate
column is that "can observe" and "may certify" are different claims.

| Capability | State | Evidence |
|---|---|---|
| Server-side pixel observation | **available** | `m22/provider.mjs` + the v2 engine; 120 frames per attempt decoded and analysed server-side |
| Person detection | **available** | `detect.mjs`; 39/39 variation-family variants |
| Ball detection | **available** | `detect.mjs`; 39/39 variation-family variants |
| Touch observation | **available** | `protocol.mjs` contact state machine; 0 false touches across 56 adversarial scenes |
| Juggle observation | **available** | same engine, `eventKind: 'juggle'` |
| Live frame transport | **available** | bounded sampled-frame HTTP on the authenticated player router |
| Exact count, synthetically validated | **yes** | `m22/evaluation.json`, `m22/holdout.json` |
| Exact count, real-world validated | **NO** | no real football video has ever been observed by this engine |
| Box Cam observed eligible | **yes**, under its own gate | `boxCamObservedEligible()` — §30 policy, nine requirements |
| **Combine Verified eligible** | **NO** | `combineVerifiedProtocols = []` |

### Why the last row is NO

Not because the engine cannot see the activity — it demonstrably can, which is
what every row above says. It is NO because a Combine measurement is a
**standardised, comparable number**, comparability is a claim about the real
world, and no real-world validation record exists.

`m22/eligibility.mjs` enforces this structurally: the provider has two
capability lists that are never the same object. The observation list drives
Box Cam; the Combine list is derived per protocol from a versioned validation
record and is currently empty. There is no argument, configuration value or
environment variable that makes it non-empty.

---

## 2. Per-protocol state

| Protocol | Observation | Combine verification | Blocked by |
|---|---|---|---|
| `combine-box-touch-60` | supported | **not available** | real-world validation not completed |
| `combine-box-juggle` | supported | **not available** | real-world validation not completed |
| `combine-box-control-60` | supported | **not available** | real-world validation not completed |

Everything else returns `unsupported_protocol`. There is no fallback (§57).

---

## 3. What `/capabilities` reports

```
production_cv:
  state:                        configured
  serverSideObservation:        true
  syntheticEvaluation:          passed
  realWorldValidation:          not_completed
  combineVerifiedProtocols:     []
  combineVerificationAvailable: false
```

`state: configured` is deliberately *not* sufficient to conclude that
measurements are available — which is precisely why the four fields beneath it
exist. A reader who sees only the first line would reasonably draw the wrong
conclusion, so the payload does not let them see only the first line.

### Boot behaviour (§121, §122)

The engine is built in. There is no model file, no download, no weights and no
configuration, so reporting `not_configured` would be a fiction. It reports
`configured` honestly, and being configured still grants no Combine
verification.

Because it is built in, it also cannot fail boot by being absent — there is
nothing to be absent. Core ScoutBox is unaffected by anything the CV provider
does; a provider failure mid-attempt fails that attempt and nothing else.

---

## 4. Explicit non-capabilities

Absent by design, and checked by an automated sweep in `m22E2E`:

| | |
|---|---|
| Face recognition, face embeddings, facial identity | **prohibited**, not merely absent |
| Body or gait identity | **prohibited** |
| Emotion or affect inference | **prohibited** |
| Audio capture, transcription, speaker identification | **prohibited** — `getUserMedia` requests `audio: false` |
| Medical or injury inference | **prohibited** |
| Left/right foot classification | not implemented; no such model exists |
| Technique quality signals | not implemented; ScoutBox does not score how a touch looked |
| Work/rest interval detection | not implemented |
| Player scores, rankings, comparisons | **prohibited** across the product |

---

## 5. Declared operating envelope

Claims follow what has been tested, and nothing further.

| | |
|---|---|
| Frame encoding | `gray8` only. Not JPEG, not video, not multipart |
| Frame size | 160×120 to 320×240 |
| Batch | ≤ 12 frames |
| Cadence | ≥ 12 fps sustained |
| Touch pace | ≥ 340 ms between touches (260 ms under-counts — a measured limitation) |
| Concurrent sessions | 16, then `provider_busy` at the door |
| Browser support | **Chromium only.** That is the only engine the live journeys have run on. Firefox and WebKit are untested and therefore unsupported |
| Native (iOS/Android app) | **not supported.** No native implementation exists and no device testing has occurred |

Platform support is a statement about what was tested. It is not extrapolated.

---

## 6. Known limitations, measured

- **Over-cadence detection is PARTIAL.** Friction decay after a legitimate
  strike is indistinguishable from a new strike at video sample rates, so an
  over-fast attempt is under-counted rather than refused. An under-count costs
  recall and cannot produce a false verification.
- **Replay is not solved (§43).** A virtual camera replaying a file can be
  indistinguishable from genuine live capture. The M22 live suite *uses* such
  a camera deliberately. Some replay patterns still fail integrity checks;
  this is not a claim that the problem is closed.
- **A systematic −1** on generated touch fixtures: the final strike has no time
  to clear its separation requirement before the capture ends.
- **The synthetic holdout is held out from development, not from reality.**

---

## 7. What would change this document

One thing: a completed, passing, versioned real-world validation record for a
specific protocol, produced by executing `M22_REAL_WORLD_VALIDATION_PLAN.md`.

Until then the last row of §1 reads **NO**, and it reads NO for every protocol.
