# M22 — Real Box Cam CV v1: Provider Integration Report

**Provider `production_cv` v1 · engine v2 · CV policy v1 · freeze `m22-v2-freeze-3` · commit `af19d1f`**

> **Box Cam uses server-side computer vision to observe supported activity.**
>
> **Combine verification for these CV protocols remains disabled pending real-world validation.**

---

# §142 — Final audit

| Question | Answer |
|---|---|
| Real server-side pixel CV exists? | **YES** — `m22/provider.mjs` + the v2 engine decode and analyse `gray8` frames server-side on every attempt |
| Face recognition? | **NO** — prohibited, swept in code |
| Audio analysis? | **NO** — `getUserMedia` requests `audio: false`; nothing is captured or transported |
| Raw production video persisted? | **NO** — no frame store exists; a persistence scan after a real attempt finds nothing |
| Client authoritative count accepted? | **NO** — a POST of `touchCount: 176` and `combineVerified: true` changes nothing |
| Box Cam observation production-capable? | **YES, under its own gate.** Nine requirements, evaluated independently of Combine. The measured live outcome in this build was a **refusal** (`ball_not_detected`) |
| Combine Verified production-capable? | **NO** |
| Why? | **Real-world validation not completed** for any protocol |
| Can synthetic success bypass the blocker? | **NO** — a perfect attempt through the real provider mints nothing (60 checks) |
| Can an environment variable alone bypass it? | **NO** — the gate reads a versioned record, not configuration; the suite sets three env vars and re-asserts |
| Can a test provider contribute production evidence? | **NO** — `local_test` is test-only and gated; the future-validation fixture lives in a local object no request can reach |
| Trust policy changed? | **NO** |
| M21 semantics changed? | **NO** |
| M19 matching semantics changed? | **NO** |

---

# §143 — Report

## 1. Provider architecture
`ProductionCvProvider` orchestrates the frozen v2 engine and nothing else. It contains no detection, tracking, touch logic, juggle logic, quality thresholds or refusal precedence — those live in `m22/{detect,track,protocol,quality}.mjs`, which the freeze covers. The first `if (count > 0)` written in the provider would be a second, unversioned copy of the protocol layer.

## 2. Provider/runtime states
`created → ready → running → finalizing → accepted|refused`, plus `cancelled`, `expired`, `failed`. An enumerated transition table; illegal transitions fail closed and are asserted.

## 3. Frame transport
A bounded sampled-frame HTTP endpoint on the **existing authenticated player router** — not a WebSocket. Every standing gate (auth, CORS, origin, rate limiting) already runs there, and re-establishing each at a new boundary risks an unauthenticated pixel endpoint. The workload does not need a socket: ingest is ~0.57 ms per frame and an attempt costs 0.01–0.02× realtime.

## 4. Authentication / session binding
Four parts checked on every frame: authenticated actor, Box Cam session, provider session, server-minted nonce. A mismatch on any one is rejected.

## 5. Nonce / integrity
M16's server-minted nonce, reused unchanged. Clients never mint one; the value is compared, never adopted. Per-session monotonic sequence with a `seenSeqs` set, so an *old* sequence is caught, not only a repeat of the newest.

## 6. Frame validation
One documented representation: `gray8`, 160×120–320×240, exact `w*h` length. No format detection, no sniffing, no image library — therefore no parser to attack. A JPEG is `unsupported_frame_format`; a multipart body never reaches frame handling.

## 7. Queue / backpressure
Bounded queue, drops oldest, **reports** the drops, and the drop count feeds observation quality. Measured: 240 pushed, 24 held, 216 dropped and accounted. The engine is never told frames it did not see were fine.

## 8. Resource isolation
Keyed by provider session id only. All layers pure, no module-level state. 1/2/5/10 interleaved sessions cost within ±10% per session of one alone.

## 9. Provider health
`not_configured | warming | ready | degraded | unavailable`. The health object states `combineVerificationEligible: false` inline, so `ready` cannot be read as eligibility.

## 10. Runtime capabilities
Two lists that are never the same object. `observation` drives Box Cam; `combine` is derived per protocol from a versioned validation record and is `[]`. Nine capability fields reported separately, never collapsed.

## 11. Ready Check
Nine structured checks with `{id, state, reasonCode}`. Checks a client cannot honestly self-assess report `unknown` rather than passing themselves. Returns **both** `observationReady` and `combineVerificationAvailable`, always.

## 12. Detection / tracking / protocol engine
Unchanged from the fix pack, and that is a result: 14/14 golden fixtures, 39/39 variation variants, 0 false touches across 56 adversarial scenes, 0 nondeterminism, holdout generation 3 at 28/28 with a 0.00 generalisation gap. `m22CvEval` and `m22Holdout` are byte-identical in behaviour before and after provider wiring.

## 13. Box Cam observed policy
Nine requirements (`BOX_CAM_OBSERVED_REQUIREMENTS`), evaluated **independently** of Combine. Deliberately does **not** require an exact count: M16 semantics never did, and importing the Combine evidence bar here would look conservative and be a category error.

## 14. Exact measurement policy
The engine's count is carried as `experimental.exactCount` with `status: experimental_unvalidated` and a note attached, so a downstream reader cannot pick up the number without its status. In the UI it sits behind a disclosure, after the real outcome.

## 15. Production validation blocker
Structural, not a flag. `combineCapabilities()` returns `[]` unless `realWorldValidationPass()` yields exactly `true` for that protocol at this engine and policy version. Proven by 60 checks, including: the full observation list does not open it, a different engine/policy version does not, a record marked `passed` but missing fields does not, and a record validated against an older engine does not transfer.

## 16. Raw-frame policy
Validate → decode → hand to engine → drop. No frame store in the schema, no `cvFrames`, and a migration-level assertion proves no migration anywhere creates a frame/pixel/video/blob store. A full attempt runs over HTTP, then the persistence directory is walked hunting for the payload: clean.

## 17. Logging / observability
Provider and Box Cam session ids, protocol, versions, state, refusal code, frame counts, drops. No raw frame. Metrics are counters only.

## 18. Replay limitations
**Unsolved, and stated as such (§43).** A virtual camera replaying a file can be indistinguishable from live capture — the live suite *uses* exactly that, deliberately. Some replay patterns still fail integrity; this is not a claim the problem is closed.

## 19. Combine integration
`measurementSupported()` is now handed the **Combine** list, never the observation list. A `production_cv` attempt is refused 422 with `REAL_WORLD_VALIDATION_NOT_COMPLETED`, and the refusal distinguishes "cannot observe" from "observes but may not certify".

## 20. Trust integration
Unchanged. A 200-touch and a 120-touch unvalidated result carry identical status; performance value is irrelevant to Trust contribution, and an unvalidated observation contributes zero Combine confidence.

## 21. M21 integration
An unvalidated CV result cannot satisfy a production Combine target. `m21E2E` now asserts §64 directly and the target stays `no_current_valid_measurement`.

## 22. M19 integration
An unvalidated result never reaches the facts projection, so a club criterion requiring a Box Touch 60 result is not satisfied and the explanation reports absence rather than a number. No Match Score, either way.

## 23. M18 / Second Look integration
One underlying result, one canonical source-change fingerprint. No new duplicate material change: the CV result is a new record, and downstream projections read it rather than copying it.

## 24. Invalidation / restoration
Projections are computed at read time, so invalidation cannot be half-applied. An invalidated session yields no measurement even under a valid validation record; restoring reproduces the same measurement exactly, twice, byte-identical.

## 25. Events
Three registered: `box_cam_cv_session_started`, `box_cam_cv_refused`, `box_cam_observed`. All `player_private`, none analytics-eligible, none carrying a count. **No per-frame event exists**, and adding one would have to pass through both the registry and `EMITTED_EVENTS`.

## 26. T&S diagnostics
Structured projection: protocol, versions, outcome, refusal code, quality reasons, integrity. No raw frame viewer — there is nothing to view. No write route for the count exists anywhere.

## 27. Player UX
Two facts side by side at Ready Check **and** on every outcome including refusals. No live count during an attempt. Refusal ("could not verify · the ball was outside the visible area · nothing is wrong with your training") and technical failure ("problem on our side") are different phases with different copy.

## 28. Accessibility
Live regions on each async phase; a labelled check list where each row announces name + state + reason; a single summary region for the observation/Combine pair so a screen reader gets the whole claim rather than two fragments that separately mislead. Keyboard focus verified on the start control.

## 29. Mobile / browser support
390px verified with no horizontal overflow, and the Combine notice survives the narrow layout — it is not the thing that gets cut. **Chromium only.** Firefox and WebKit untested and therefore unsupported. **Native unsupported** — no implementation, no device tests.

## 30. I18N
78 keys in EN and FR covering provider, Ready Check, result, refusal and error copy. No raw error code reaches the screen.

## 31. Transport security
Twenty named routes in, all closed, over real HTTP (§85). Plus unsupported-protocol, liveness-before-begin, and single-shot finalize.

## 32. Adversarial suite
Thirteen scenes through the provider path including both camera-scale cases the holdout found: **zero false touches**. The provider weakens nothing.

## 33. CV evaluation
Part A unchanged: 14/14, 39/39, 0 false touches, 0 false verifications, 0 nondeterminism, mean/max count error 1.00/1.

## 34. Holdout
Generation 3 under freeze 3: 28/28 on truth, 0 invariance breaks, 20/20 adversarial at zero, gap 0.00. Generations 1 and 2 consumed after finding four P0 false touches between them.

## 35. Robustness regressions
48 named checks, all green, unchanged by provider wiring.

## 36. False verification count
**Zero**, everywhere: development, holdout, adversarial, provider path, live browser.

## 37. Performance
Decode + validate 0.141 ms/frame (~24% of ingest). Provider finalization 0.381 ms. Transport overhead by subtraction **not resolvable** (−0.043 ms against a ±0.063 ms band) — reported as unresolvable rather than clamped to a flattering zero.

## 38. Concurrent-session performance
1/2/5/10 sessions: 0.639 / 0.617 / 0.609 / 0.612 ms per frame. Load shedding refuses at the door with `provider_busy`.

## 39. Memory / soak
500 sessions, a quarter cancelled rather than finished: heap 5.30 → 5.32 MB, zero retained sessions, queued frames, detections or timers.

## 40. Event-loop impact
p95 0.234 ms with an active CV session against a 0.065 ms idle baseline. §24 asked for measurement before assuming a worker boundary; measured, none is needed. The injection seam remains.

## 41. Migration
Schema 2100 → 2200. One store, `boxCamCvResults`, holding derived metadata only. The §117 reuse audit is written into the migration and **enforced** by a test.

## 42. Capability matrix
`M22_CAPABILITIES.md`. Every row available except the last two; the last is NO not because the engine cannot see the activity but because comparability is a claim about the real world.

## 43. Real-world validation readiness
Plan exists and is specific. Nothing started, no footage collected, none authorised. §17a records what provider integration taught it: the capture envelope is settled, browser support is narrower than assumed, and framing distance must be recorded per session or a legitimate refusal rate will be misread as a detector weakness.

## 44. Bugs found/fixed
| # | Bug | Found by |
|---|---|---|
| F6 | `realWorldValidationPass()` returns an object; read as a boolean, **every protocol came back Combine-eligible** | the test written to prove the gate closed |
| F7 | `PROD_PROVIDER_ID` is a misnomer equal to `'web_client'`; the inverted comparison handed `production_cv` its observation list | `m21E2E` §64 |
| F8 | Twelve demo spotchecks depended on ambient test infrastructure; a first repair added an import that was never called | the full battery |
| — | The refusal branch of the player UI omitted the Combine notice | the live browser journey |
| — | `EMITTED_EVENTS` and the registry disagreed | `m182E2E` |
| — | Rate-limit policies unregistered | the limiter, which fails closed on unknown actions |

## 45. Honest limitations
Synthetic evidence only. Holdout held out from development, not reality. Over-cadence detection partial. Replay unsolved. Chromium only; no native. Systematic −1 on generated touch fixtures. The recorded live outcome is a **refusal**, reported rather than tuned away.

## 46. Full regression
23/23 server suites · 4/4 client typechecks · 14/14 demo and E2E suites · `m22Live` 41 checks · `apiE2E` 130 checks against a live server. No prior assertion weakened; three **strengthened** (m16E2E, m181E2E, m21E2E) where they encoded "no production CV exists", which is now false.

## 47. Artifacts
Launcher rebuilt with the 16-step M22 tour, build chip and footer at commit `af19d1f`. One stale M21 claim ("production_cv is not configured") corrected in place rather than left describing the current build.

## 48. Changed files
46 files, +4,831 / −122 across the provider wiring phase.

## 49. Build ID
Source `af19d1f` · branch `claude/desktop-project-migration-wyk3ec` · engine v2 · policy v1 · freeze `m22-v2-freeze-3` · schema 2200.

## 50. Restore bundle
| | |
|---|---|
| base | `b2eca8e9993d34ab67a89d16e7823a093dacf303` |
| tip | `af19d1ff53a9ec8bb67e03fb70ea0053d0849043` |
| commits | 146 |
| size | 3,155,377 bytes (3.0 MiB) |
| sha256 | `c5ae709cd9ae3a3e11e9fda70e639c89a8bd53713fb0bcbb05defe9575b3e9aa` |

`git bundle verify`: complete history. Fresh clone → **m22CvEval, m22Holdout, m22Robustness, m22Blocker and m22E2E all pass from the clone** (m22E2E: 112 checks, 73% negative).

Scans: secret scan clean (one hit, a deliberately fake SMTP fixture used to assert the capability report does not leak it); raw-frame scan clean (every `cvFrames` hit is the absence being documented or asserted); model/weights scan clean — no `.onnx`, `.pt`, `.tflite`, `.pb`, `.h5` or `.weights` file exists.

## 51. Git state
Branch `claude/desktop-project-migration-wyk3ec`, 133 commits ahead of origin once this report is committed (132 at the point the restore bundle above was cut), clean working tree.

**Nothing pushed. No PR opened.**

---

## Definition of done (§144)

| | |
|---|---|
| Real executable server-side CV connected to authenticated live Box Cam sessions | ✅ |
| Frames processed ephemerally, not persisted as raw video | ✅ |
| Session / nonce / frame integrity enforced | ✅ |
| Frame queues bounded | ✅ |
| Provider failure cannot crash ScoutBox | ✅ |
| Engine robustness gates unchanged through transport integration | ✅ |
| Box Cam observed has its own explicit evidence threshold | ✅ |
| Combine verification disabled while real-world validation is incomplete | ✅ |
| A correct synthetic live observation cannot bypass that blocker | ✅ |
| Test/demo evidence cannot become production evidence | ✅ |
| Trust policy unchanged | ✅ |
| M21 Goal semantics unchanged | ✅ |
| M19 matching semantics unchanged | ✅ |
| Invalidated evidence disappears from downstream projections | ✅ |
| Full historical regression green | ✅ |

```
realWorldValidation.status = "not_completed"
combineVerifiedProtocols   = []
```

*The transport may deliver evidence to the engine. It may never grant the engine permission to claim more than the evidence justifies.*
