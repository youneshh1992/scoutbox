# M22 — Box Cam CV threat model

Written **before** the provider was implemented, as §181.5 requires, because
two of its conclusions decide the architecture rather than describe it.

The asset being protected is not the video. It is **the credibility of the
sentence "Combine Verified"**. Every threat below is scored by one question:
*could this cause ScoutBox to attach that label to a measurement that is not
true?*

> A refused measurement is acceptable. A falsely verified measurement is not.

---

## 0. Trust boundaries

```
  [ player's browser ]  ── untrusted ──▶  [ ScoutBox server ]  ──▶  [ canonical records ]
    camera, JS, timers                      session, nonce,          Combine attempt,
    frame encoder                           CV engine, clock         Passport, Trust
```

Everything left of the boundary is **attacker-controlled in the worst case**:
the page's JavaScript can be rewritten, the camera can be replaced with a
virtual device, the system clock can be moved, and the frames themselves can be
synthesised. Nothing a client asserts about *what happened* is evidence.

The server is trusted. The canonical records are the thing being defended.

---

## 1. The two architectural conclusions

### 1.1 On-device inference cannot be a production path

§84 lists "local inference + signed observation proof" as a candidate
transport. It is rejected for production verification.

A signature proves that a payload was produced by something holding a key. In a
browser there is no key the user cannot reach, and even with attestation the
signature would prove only *which build emitted the number*, never *that the
number is true*. An attacker who controls the page controls the model's input,
its output, and anything wrapped around them. Accepting a signed client count
is accepting a client count, which §7 and §22 forbid outright.

**Therefore: production observation requires server-side inference over frames
the server receives.** This is the single most expensive decision in M22 and it
is forced, not chosen.

### 1.2 Full replay prevention is not achievable in a browser in v1

A virtual camera device can present a previously recorded, genuine Box Touch
video to `getUserMedia`. From the server's position the frames are
indistinguishable from live ones at the pixel level: they contain a real
person, a real ball, and real touches. They are simply not *this* person, now.

What the server **can** detect is enumerated in §4 below — and it is real
defence, not nothing. What it **cannot** do is prove liveness from pixels
without biometrics, which §10 and §25 prohibit and which this milestone will
not add.

**This residual risk is stated in the product, the capability report and the
evaluation, rather than papered over.** It is also the main reason the
enablement bar for "Combine Verified" is set where §63 says to set it.

---

## 2. Threat catalogue

Severity: **P0** = can cause false verification. **P1** = can cause data loss,
privacy harm or denial of service. **P2** = degrades quality only.

| # | Threat | Sev | Defence | Residual |
|---|---|---|---|---|
| T1 | Client posts its own count (`touches: 176`) | P0 | Production counts are derived server-side from frames; a client-supplied count field is refused by name, not ignored | none |
| T2 | Client forges `verified: true` / a provider id | P0 | Verification state is computed server-side from provider + capabilities + integrity; client fields are not read | none |
| T3 | Test/demo provider result presented as production | P0 | `testOnly` providers are unreachable unless `BOX_CAM_TEST_PROVIDER=1`, and `isProductionValidCombine()` excludes them | none |
| T4 | Silent fallback to `web_client` when CV is down | P0 | Provider resolution is explicit; unavailability is a refusal state, never a substitution | none |
| T5 | **Pre-recorded video via virtual camera** | **P0** | Nonce binding, server-owned clock, liveness challenge, frame-arrival cadence, duplicate/static detection | **Present. Documented. See §1.2.** |
| T6 | Replayed frame batch from an earlier session | P0 | Nonce is per-session and single-valued; `seq` is strictly increasing; foreign session id is rejected at the router | none |
| T7 | Duplicate frames inflating the count | P0 | Per-frame content hash within the session; identical consecutive frames do not advance the tracker | none |
| T8 | Frozen/static image presented as activity | P0 | Inter-frame difference floor; a sequence without motion cannot produce touches | none |
| T9 | Out-of-order frames reordering touch events | P0 | Bounded reorder window keyed on `seq`; anything outside it rejects the batch | none |
| T10 | Clock manipulation to extend the protocol window | P0 | Server clock owns `startedAt`/`endedAt`; client timestamps are bounded by `elapsed + DRIFT_MS` | none |
| T11 | Second ball introduced to double the count | P0 | More than one ball candidate is a protocol violation, not an attribution problem | none |
| T12 | Second person performing the touches | P0 | Multi-person intervals suspend observation (existing M16 behaviour); no identity assignment is attempted | Cannot prove *which* person is the account holder without biometrics. Refusal, not attribution. |
| T13 | Jitter / camera shake manufacturing touches | P0 | Refractory interval + trajectory coherence; shake produces no contact→flight→contact structure | none |
| T14 | Low light or occlusion silently estimated | P0 | Explicit `insufficient_visibility` refusal; the engine has no extrapolation path | none |
| T15 | Confidence threshold quietly lowered to pass a test | P0 | Thresholds live in one policy object and are asserted by the evaluation gate against measured data | none |
| T16 | Protocol enabled without measured evidence | P0 | `protocolProductionEnabled()` reads the measured evaluation artefact; hard-coding `true` fails its own test | none |
| T17 | Session theft — frames posted to another player's session | P0 | Router resolves the session by `(playerId, sessionId)`; a foreign id is a 404, not a 403 | none |
| T18 | Raw frames persisted or logged | P1 | Frames live only in a bounded in-process queue; no store, no log field, asserted by tests | none |
| T19 | Facial crop or embedding created | P1 | No face code path exists; asserted by source scan | none |
| T20 | Audio captured or analysed | P1 | The transport carries images only | none |
| T21 | Frame bomb / oversized payload | P1 | Explicit byte cap with a typed 413; bounded queue; documented drop policy | none |
| T22 | Inference starves the event loop | P1 | Engine is bounded and measured; if measurement shows blocking it moves behind a worker | measured, reported |
| T23 | Unbounded memory growth across sessions | P1 | Fixed-size queues, explicit teardown, repeated-session memory test | none |
| T24 | Cross-session tracker contamination | P1 | State keyed by session id only; never by player, never global | none |
| T25 | Provider crash takes the server down | P1 | Failures are caught at the contract boundary and become refusals | none |
| T26 | XSS through a device label or error string | P1 | Device-supplied strings are never rendered as markup | none |
| T27 | Arbitrary file upload through the frame route | P1 | Only documented encodings are decoded; magic-byte check; anything else is a 415 | none |
| T28 | Event leaks observation detail to an unrelated org | P1 | CV events stay `player_private`; nothing new is broadcast org-wide | none |
| T29 | Notification spam from failed attempts | P2 | Failed attempts notify nobody | none |
| T30 | Model poisoning | — | **Not applicable**: no training occurs in ScoutBox, and v1 ships no learned weights (see the model decision) | none |

---

## 3. What the server can genuinely tell from frames

Honest inventory, since the defence of T5 rests on it:

- **Content identity** — a frame identical to one already seen in this session.
- **Static-sequence detection** — a run of frames with inter-frame difference below a floor.
- **Arrival cadence** — frames arriving faster than real time, or in bursts inconsistent with live capture.
- **Server-owned duration** — the protocol window measured on the server clock, never the client's.
- **Structural coherence** — whether the observed ball trajectory actually has the contact/flight structure the protocol requires.

## 4. What it cannot tell, and will not pretend to

- Whether the person in frame is the account holder. That needs biometrics. **Prohibited.**
- Whether a genuine, live-looking video was captured today or last year by someone else.
- Whether a physically plausible scene was synthesised deliberately.

These are the reasons the production bar is a *measured* gate and not a badge.

---

## 5. Consequences carried into implementation

1. Server-side inference only (§1.1).
2. Frames transported inside the existing authenticated, nonce-bound, `seq`-ordered session — not a new anonymous channel.
3. Every accepted observation carries `providerId`, `providerVersion`, `modelVersion`, `policyVersion`.
4. Refusal is a first-class result with a specific reason, never a zero.
5. The virtual-camera residual risk (T5) is surfaced to the reader of the result, not buried in a document.

---

## 6. Runtime and methodology threats (T31–T40)

Added after the robustness and holdout passes. T1–T30 are about the *content*
of an attempt — what is in front of the camera. These are about the *machinery*:
the session that observes it, the resources it holds, and the evidence used to
justify trusting any of it. Several were found by measurement rather than
reasoning, and those are marked.

| # | Threat | Why it matters | Position |
|---|---|---|---|
| **T31** | **Session-id reuse.** A new attempt lands on runtime state belonging to a previous one — same object, unreset fields — and inherits its detections, duplicate hashes or staleness counters. | An attempt could be credited with observations it did not make. The worst shape is silent: counts that are plausible but assembled from two attempts. | **Mitigated.** `resetRun()` is a single-entry reset contract restoring every field in `MUTABLE_RUN_KEYS`. A regression compares a RESET instance against a FRESH one field by field, so adding a mutable field without adding it to the contract fails the suite. |
| **T32** | **Tracker-pool state leakage.** A runtime that recycles run objects for efficiency defeats "make a new object" without anyone noticing. | This is the version of T31 that survives the obvious defence, and it is invisible in code review because pooling looks like an optimisation. | **Mitigated, and deliberately exercised.** `ObservationSessions` takes a `pool` option whose only purpose is to make the hazard testable rather than assumed away. Pooled reuse runs through the same reset contract and is checked against a fresh instance. |
| **T33** | **Stale session id submits frames.** A cancelled, expired or finalized session's id continues to be accepted. | Late or replayed frames attach to a completed measurement, or resurrect a refused one. | **Mitigated.** `get()` returns null for a disposed runtime; there is no path that resurrects one. Ingest on a non-active session returns `SESSION_NOT_FOUND` or `SESSION_NOT_ACTIVE`. Past TTL, the session is expired and released and the frame is rejected. |
| **T34** | **Cross-session contamination under concurrency.** Two attempts open at once share state through a module-level variable or a coarse key. | One player's touches counted into another's attempt. Keying by player or protocol rather than session id merges two legitimate concurrent attempts. | **Mitigated structurally.** All four layers are pure functions with no module-level state, and runtime is keyed by session id **only**. Perf measurement across 1/2/5/10 interleaved sessions shows per-session cost within ±10% of running one alone — there is nothing to contend on. |
| **T35** | **Cleanup failure / resource exhaustion.** Abandoned sessions accumulate queues, detections and timers until the process degrades. | A denial of service that needs no attacker — just users closing tabs. The abandoned path is the one nobody watches. | **Mitigated and measured.** A 500-session soak in which a quarter are cancelled rather than finished leaves 0 retained sessions, queued frames, detections and timers, with heap flat at 5.30→5.32 MB. Disposal is idempotent by construction. |
| **T36** | **Unbounded frame queue.** A client submits faster than the server drains. | Memory growth proportional to a client's enthusiasm. | **Mitigated.** `FrameQueue` is capped at `FRAME_LIMITS.maxQueuedFrames`, drops oldest, and **records the drops** so backpressure is visible in the observation record rather than silent. Measured: 240 pushed, 24 held, 216 dropped and reported. |
| **T37** | **Frame-gap contact ambiguity.** Frames are lost around a contact, and the engine interpolates across the gap or counts the same contact on both sides of it. | Either fabricates a touch or double-counts a real one. Dropped frames are ordinary on real devices, so this is a common case, not an edge case. | **Mitigated.** Per-triple `gapBeforeMs`/`gapAfterMs` let the protocol layer distinguish a genuine adjacency from one spanning a gap; gaps beyond `maxBallGapFrames`/`maxBallGapMs` mark the track's occlusion as broken. The engine does not extrapolate through lost contact frames, and the refractory interval is in milliseconds so it means the same thing across a gap. |
| **T38** | **Global image transforms fabricating motion.** *(Found by measurement, twice.)* A camera zoom, a player walking toward the lens, or the player region clipping against a frame edge moves the frame of reference, and player-relative motion reads it as the ball moving. | Produced four P0 false touches across two holdout generations, on scenes where the ball and player were in a **completely fixed** relationship. The original guard was set at 1.4× because it was asking an identity question — "is this a different person?" — where the question that matters for counting is thirty times smaller. | **Mitigated.** `EVENT_RULES.maxFrameScaleStepPerSample` (4%), derived from the impulse threshold, the working range of `\|rel\|/d` and the maximum supported cadence, sitting between a 1.1% detector noise floor and a 4.3% danger point. Holdout generation 3 attacks the fix itself — a ramp compounding just under the bound, a permanently clipped region, a walk toward the camera, a single-frame doubling — and all read zero. |
| **T39** | **Synthetic overconfidence.** Strong scores on rendered geometry are read as evidence about football. | The most dangerous threat in this document, because it needs no attacker and produces a confident, wrong claim. Everything else fails loudly; this one fails by being believed. | **Mitigated procedurally, not technically.** Provenance travels with the numbers in every artefact. `gate.mjs` reads `validation.mjs` **independently of the evaluation artefact**, so a synthetic result cannot assert its own real-world validity. The gate is closed and will remain closed until `M22_REAL_WORLD_VALIDATION_PLAN.md` is executed and passes. |
| **T40** | **Platform-generalization risk.** Support is claimed for devices, browsers or capture paths absent from the validating data. | An untested combination that silently mis-counts is exactly the case nobody is looking at. "Expected to work" is not a measurement. | **Mitigated by declaration.** §5 of the validation plan: claims follow the data and nothing else. A platform absent from the passing holdout is unsupported, however unlikely that feels, and the capture client refuses to begin a production attempt outside the validated envelope. |

### A methodology threat worth naming on its own

**T41 — The holdout that stops being one.** A holdout run repeatedly, or run
after a threshold moved, is a development fixture with a better name. Nobody
decides to do this; it happens one reasonable step at a time.

Position: **mitigated by construction.**

- `m22/freeze.mjs` hashes the constants **and** the comment-stripped source of
  all four observation layers; `scripts/m22Holdout.mjs` refuses to run against
  a drifted freeze. The source group exists because the first fix changed code
  rather than constants and the freeze would otherwise have stayed silent.
- A generation that diagnoses a defect is **consumed** and moves into the
  development harness as a permanent regression. It can never return.
- Count errors are reported, never failed, so no incentive exists to tune
  against them.

### One more, from the test harness rather than the engine

**T42 — Stale test infrastructure.** A test passes against a server left running
from an earlier session, serving a build nobody in this run produced.

This one was real: `crosstab` and `demoOffline` had been green for a long time
against whatever had been left on :8099. Position: **mitigated.** The demo host
publishes a content-derived build marker, and a caller that finds an existing
host and does not recognise its marker fails hard with the port and the remedy
named. See `e2e/demoHost.mjs` and the 15-check regression beside it.

---

## 7. Transport threats (T43–T52)

Added with the provider wiring. T1–T30 are about what is in front of the
camera; T31–T42 about the machinery around a session. These are about the
**wire**: a pixel endpoint is a new front door, and it is the first one in
ScoutBox that accepts bulk binary from a client.

| # | Threat | Why it matters | Position |
|---|---|---|---|
| **T43** | **Frame injection.** An attacker submits frames to a session that is not theirs, or fabricates a session and streams into it. | The whole integrity model rests on "this observation came from this player's live attempt". | **Mitigated.** Four-part binding checked on every frame: authenticated actor, Box Cam session, provider session, server-minted nonce. `m22E2E` cases 1–6, 19, 20 cover anonymous, foreign-user, foreign-session, wrong-provider-session, old-nonce and forged-nonce submission over real HTTP. |
| **T44** | **Origin spoofing / CSRF.** A third-party page posts frames using the victim's credentials. | A pixel endpoint that accepts cross-origin writes is a camera the victim did not point. | **Mitigated by reuse, deliberately.** The endpoint lives on the existing authenticated player router, so the standing CORS and origin policy applies unchanged. §124: the CSP was NOT loosened to make the camera work — `getUserMedia` needs a secure context, not a relaxed policy, and Ready Check reports `insecure_context` rather than the product degrading its own headers. |
| **T45** | **Session hijack via a stale provider session id.** A leaked or guessed `providerSessionId` is used after the attempt ends. | A hijacked session could append frames to someone's finished measurement. | **Mitigated.** Ids are 96 bits of CSPRNG, released at finalize/cancel/expire, and a released id is simply not found — there is no resurrection path. The id alone is insufficient anyway: the nonce and the Box Cam session must match too. |
| **T46** | **Queue exhaustion.** A client floods frames to grow server memory. | Denial of service that needs no exploit, only enthusiasm. | **Mitigated at three levels.** Batch capped at 12 frames; the per-session queue is bounded and drops oldest while **reporting** the drops; a separate rate-limit policy governs the ingest endpoint because it is the expensive one. Measured: 240 pushed, 24 held, 216 dropped and accounted. |
| **T47** | **Malformed frame as a parser attack.** Hostile bytes aimed at a decoder. | Image parsers are a classic memory-safety surface. | **Mitigated by having no parser.** `gray8` is a raw luminance plane; the only validation is an exact `w*h` length check. There is no format detection, no sniffing and no image library. A JPEG is refused by name as `unsupported_frame_format`, and a multipart body never reaches frame handling at all. |
| **T48** | **Provider crash / engine exception.** Hostile or unlucky input throws inside the engine. | An unhandled throw in a route can take the process down, or leak a stack trace with file paths. | **Mitigated.** The engine call is wrapped; an exception fails that session with a typed `engine_failure`, mints no result, releases resources, and returns nothing about the server's internals. `m22E2E` asserts a thrown message containing a file path does not reach the caller. |
| **T49** | **Stale nonce / transport replay.** A captured request body is resubmitted. | Replay is the cheapest attack on any streaming protocol. | **Mitigated.** Per-session monotonic sequence with a `seenSeqs` set, so an *old* sequence is caught and not merely a repeat of the newest. Duplicates are refused before the engine is reached, so they can never double-process, create a touch or alter quality twice. The reorder window is a named constant at **zero** — there is no unlimited reorder buffer to exploit. |
| **T50** | **Clock tampering.** A client lies about capture timestamps to stretch or compress the protocol window. | Duration is a measurement; a client that owns the clock owns the measurement. | **Mitigated structurally.** The server timeline is authoritative for everything. Client timestamps are recorded for diagnosis and **counted** when implausible (`clientClockAnomalies`), never used. There is no code path in which a client timestamp contributes to duration. |
| **T51** | **Load-shedding as silent data loss.** Under pressure the server accepts a session it cannot serve, then drops the frames that mattered. | The player believes they are being observed. That is worse than a refusal. | **Mitigated.** Refusal happens at the door: over the concurrency ceiling, `beginSession` returns `provider_busy` and no session exists. §98 governs the wording — "Box Cam is temporarily busy", never "could not verify your performance". A capacity problem is not a player failure. |
| **T52** | **Transport success read as measurement authority.** Frames arrived, the engine ran, a number came back — therefore the number is a verified measurement. | This is the phase's governing risk, restated at the wire. Everything worked, so the conclusion feels earned. | **Mitigated by the capability separation.** The transport feeds `observationCapabilities`; only a validation record feeds `combineCapabilities`. Stated on the begin response, on every result, in `/capabilities`, and on every player-facing outcome including refusals. *The transport may deliver evidence to the engine. It may never grant the engine permission to claim more than the evidence justifies.* |

### One near-miss worth recording

The first implementation of `combineCapabilities()` read
`realWorldValidationPass()` — which returns an **object** — as a boolean. The
object is always truthy, so every protocol came back Combine-eligible: the
gate this entire threat model protects, wide open, from a line that reviews
well.

It was caught by the test written to prove the gate closed, not by reading the
code. The check is now `verdict?.pass !== true`, so any unexpected return shape
denies rather than permits.

A second instance of the same class followed immediately: `PROD_PROVIDER_ID` is
a historical misnomer equal to `'web_client'`, and comparing against it handed
`production_cv` its observation list. Both are recorded in `M22_MATRIX.md` as
defects F6 and F7.
