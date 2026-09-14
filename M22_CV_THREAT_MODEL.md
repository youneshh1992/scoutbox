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
