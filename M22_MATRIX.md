# M22 — Real Box Cam CV v1: requirement matrix

Written **before** implementation, as §4.21 and §163 require. Every row is a
requirement drawn from the mandate, the file that will satisfy it, the test
that will prove it, its status, and the honest limitation that survives.

Statuses: `planned` → `built` → `closed` (built **and** proven by a named test
that is green). A row is not `closed` on the strength of the implementation
alone. A row may also end `refused` — the requirement was assessed and
deliberately not built, with the reason recorded.

The rule the whole table serves:

> **Observe narrowly. Measure honestly. Refuse when uncertain.**
> A refused measurement is acceptable. A falsely verified measurement is not.

---

## 0. Preflight findings (§4)

These are facts about the code as it stood at `31d48b1`, established before any
M22 line was written. They decide most of the architecture below.

| # | Question (§4) | Finding |
|---|---|---|
| P1 | Branch, tip, tree | `claude/desktop-project-migration-wyk3ec`, tip `31d48b1`, tree clean, 110 commits ahead of origin, schema 2100. |
| P2 | Provider interface (§4.5) | `m16/drills.mjs` `PROVIDERS` — a **registry of capability claims**, not executable code. The documented contract is `prepare / processFrame / finish / capabilities / health`, but **no provider implements `processFrame`**: today nothing in the repository ever sees a pixel. |
| P3 | Liveness / session / nonce (§4.6) | `m16/sessions.mjs`: the server mints session id + 18-byte nonce + one liveness challenge from `LIVENESS_CHALLENGES`; `/start` requires the nonce and the exact challenge; `/events` requires the nonce, a strictly increasing `seq`, and rejects whole batches on any duplicate or regression. Liveness establishes **live-session presence, not identity**. |
| P4 | Combine capability checks (§4.7) | `measurementSupported()` in `m16/combineShared.mjs` = every one of the protocol's `requiredCapabilities` present in the provider's capability list. No other path grants Combine Verified. |
| P5 | Provider names (§4.8) | Exactly three: `production_cv`, `web_client`, `local_test`. |
| P6 | `production_cv:not_configured` (§4.9) | `{ version: 0, status: 'not_configured', capabilities: [] }`. This is the M21 D3 finding: with an empty capability list, **every** protocol reports `not_configured`. |
| P7 | Web-client capabilities (§4.10) | `web_client` = `['player_presence','active_duration']`, status `limited`. It cannot count reps and says so. |
| P8 | `local_test` (§4.11) | `testOnly: true`, all 8 capabilities, reachable only when `BOX_CAM_TEST_PROVIDER=1`. `providerFor()` returns `null` for it otherwise. |
| P9 | Raw video handling (§4.12) | **There is none.** No frame, image or video byte enters `m16/` at any point. Clients POST *aggregated observation events* (`active_interval`, `ball_interval`, `rep`, …). Retention of raw media is therefore currently, trivially, zero. |
| P10 | Storage / retention (§4.13) | Sessions persist derived intervals and counts only; `MAX_STORED_INTERVALS`, `MAX_EVENTS_PER_BATCH` and `MAX_BATCHES_PER_SESSION` bound them. |
| P11 | Demo observer (§4.14) | `local_test` drives fixtures; every view carries `simulated: !!PROVIDERS[s.provider]?.testOnly`. |
| P12 | Protocol requirements (§4.15) | Box Touch 60 and Box Juggle each require `player_presence + ball_presence + rep_count`. **Box Control 60 requires `player_presence + ball_presence + active_duration` — no rep counting at all.** |
| P13 | M21 target integration (§4.16) | `m21/targets.mjs` reads `bestValidAttempt()`, which is gated on `isProductionValidCombine()`. Nothing else to change. |
| P14 | Trust rules (§4.17) | M16.2 already admits production-valid Combine into Combine Confidence and excludes `testOnly` providers. No Trust change is needed or permitted. |
| P15 | Event registry (§4.18) | One `box_cam` domain event exists, `audience: 'player_private'`. |
| P16 | `/capabilities` (§4.19) | `buildCapabilityReport()` already computes `production_cv` truthfully from the provider registry. |
| P17 | Privacy constraints (§4.20) | No facial recognition, no biometric claim, no audio anywhere in `m16/`. Multiple-person intervals **pause observation** rather than attempt identity assignment — the existing code already chose refusal over guessing. |

### The consequence of P2 + P9

The existing integrity model is *capability intersection*, not client trust: a
client may POST `rep` events all day, but `caps(session)` is the intersection
of drill and provider capabilities, so with `web_client` the count is discarded
and `verifiedReps` is `null`. That is sound — but it means **no code path in
this repository has ever derived a measurement from an image**.

M22 therefore cannot be an adjustment. It must add:
a frame transport, a server-side observation engine, and an enablement gate —
without weakening any of P3, P4 or P9.

---

## A. Non-negotiable boundaries

| # | Requirement | Implementation | Test | Status | Limitation |
|---|---|---|---|---|---|
| A1 | §10 no face recognition, embeddings, facial identity, age-from-face, emotion | No face model is loaded; the engine has no face code path at all | m22E2E negatives 62, 63 | planned | Enforced by absence and by a source scan, not by a runtime filter. |
| A2 | §11 no audio analysis | No audio is transported, decoded or stored | m22E2E negative 64 | planned | The transport carries images only; audio cannot reach the server by construction. |
| A3 | §9/§112 no raw frames persisted | Frames exist only in a bounded in-process queue, deleted on session end | m22E2E negatives 60, 61 | planned | Transient memory residency is documented in `M22_REAL_BOX_CAM_CV.md`, not eliminated — a frame must exist to be analysed. |
| A4 | §22 client never supplies an authoritative count | Production counts derive from frames server-side; a client-supplied `reps`/`touches` field is refused by name | m22E2E negatives 8, 9 | planned | A client can still *lie with pixels*; that is the threat model's problem, not the API's. |
| A5 | §8 no silent fallback | Provider resolution is explicit; absence returns `not_configured`/`unavailable` | m22E2E negatives 1, 73, 74 | planned | — |
| A6 | §50 Trust policy unchanged | No `m162/` file is touched | m162E2E green unchanged | planned | — |
| A7 | no player score, no Match Score | No new aggregate of any kind | m22E2E vocabulary scan | planned | — |

## B. Provider architecture

| # | Requirement | Implementation | Test | Status | Limitation |
|---|---|---|---|---|---|
| B1 | §5 retain the provider abstraction; no CV in route handlers | New `m22/provider.mjs` implementing the documented `prepare/processFrame/finish/capabilities/health` contract; routes call the contract only | m22E2E provider-contract block | planned | — |
| B2 | §6 provider ids stay distinct; no renaming a test provider | `production_cv` keeps its id; `local_test` keeps `testOnly: true` | m22E2E negatives 6, 7 | planned | — |
| B3 | §7 production eligibility is conjunctive | `productionEligible` requires: marked eligible **and** capabilities present **and** integrity **and** liveness **and** server-derived measurement **and** no test flags | m22E2E eligibility block | planned | — |
| B4 | §16/§17 versioning on every observation | `providerId`, `providerVersion`, `modelVersion`, `BOX_CAM_CV_POLICY_VERSION = 1` | m22E2E negatives 77, 78 | planned | — |
| B5 | §67 provider health states | `configured / warming / ready / degraded / unavailable / not_configured` | m22E2E health block | planned | — |
| B6 | §69/§157 startup assertions | Production mode refuses a provider that claims eligibility without a usable engine; `BOX_CAM_PRODUCTION_CV_REQUIRED` decides fail-vs-report | m22E2E negatives 2, 3, 4, 73 | planned | — |

## C. The decision this milestone turns on

| # | Question | Position entering implementation | Settled by |
|---|---|---|---|
| C1 | §13 model choice | **SETTLED: a deterministic hybrid CV engine, server-side, with no third-party model weights.** Rationale and the measurements behind it are in §C7 below. | §181.6, recorded in `M22_REAL_BOX_CAM_CV.md` |
| C2 | §14/§70 licence | **SETTLED: no third-party model is integrated, so no model licence is taken on.** Library licences that were checked, and the AGPL exclusion, are in §C7. | licence section of the CV doc |
| C3 | §84 transport | Sampled frames over the existing authenticated, nonce-bound session, reusing the `seq` discipline of `/events`. **On-device inference is rejected as a production path**: a signed client observation still proves only the payload's origin, never the count's truth, which §7 forbids. | `M22_CV_THREAT_MODEL.md` |
| C4 | §39 platform | **Web-only v1.** No native device tests exist, so no native claim will be made. | §40, m22E2E negative 53 |
| C5 | §3/§168 which protocols become production-verified | **Unknown, and deliberately so.** Decided by measured evaluation, never by the milestone's expectations. It is an acceptable outcome that none is enabled. | `M22_CV_EVALUATION.md` + `protocolProductionEnabled()` |
| C6 | §57 evaluation material | Synthetic, generated in-repository. No private user media, and none exists here to use. | §130 |

**C5 and C6 together are the honest risk of this milestone, and it is written
down before any code:** fixtures that are synthesised cannot demonstrate
real-world accuracy on real football video. Whatever the engine scores against
them, that limitation does not disappear, and the enablement gate must account
for it rather than launder it.

### C7. The model decision, and what it was decided on (§13, §14, §70)

§13 says to choose for **reproducibility, latency, privacy, inspectability and
deployment feasibility** — not novelty. Each was checked, not assumed.

**Licences verified from package metadata, not memory:**

| Candidate | Licence | Verified how |
|---|---|---|
| `onnxruntime-node` | MIT | `npm view` |
| `@tensorflow/tfjs-node` | Apache-2.0 | `npm view` |
| `@techstark/opencv-js` | Apache-2.0 | `npm view` |
| `@mediapipe/tasks-vision` | Apache-2.0 | `npm view` |
| `jimp` | MIT | `npm view` |
| **Ultralytics YOLO (PyPI `ultralytics` 8.4.152)** | **AGPL-3.0** | PyPI JSON API + OSI classifier |

**Near-miss worth recording (F1 below):** the npm package *named* `ultralytics`
reports Apache-2.0 — and is **not YOLO at all**. It is an unrelated
self-hosted web-analytics library (`github.com/aibubba/ultralytics`, v1.1.1).
Reading the licence off the name would have produced a confidently wrong
statement in a compliance document and, had it been installed, a
supply-chain-confusion hazard. The real YOLO package is AGPL-3.0 and is
excluded, as §14 requires.

**Deployment feasibility, measured:** `npm install onnxruntime-node` **fails in
this environment**. The package's postinstall fetches a large native binary
from a non-registry host and the transfer is reset (`ECONNRESET`); the agent
proxy's own status endpoint confirms the npm registry is reachable directly
while that CDN transfer is not. So the learned-detector route is not
reproducibly installable here, and a build depending on an out-of-band binary
download would be fragile even where it succeeded.

**The decisive argument, though, is not the install failure.** It is C6: there
is no real football video in this environment and none may be added. A COCO
detector evaluated against synthetic rendered fixtures is being tested
out-of-distribution, so it would yield no more real-world evidence than a
deterministic engine would — while adding an opaque 30 MB artefact, a runtime
download, a checksum surface and a licence surface, in exchange for accuracy
that cannot be measured here.

§13 explicitly lists "frame-difference + object tracking" and "deterministic
hybrid CV" as acceptable approaches. That is the choice:

- **reproducibility** — identical output for identical input, byte for byte, asserted by the evaluation harness;
- **latency** — no model load, no warmup cliff;
- **privacy** — no third-party code sees a frame;
- **inspectability** — every decision is a readable rule with a documented threshold, not a weight;
- **deployment feasibility** — no artefact to ship, checksum or license.

**What this decision costs, stated plainly:** a deterministic engine is far less
robust on real, varied, real-world football video than a trained detector would
be. This decision does not make production verification *more* likely — if
anything it makes the measured bar harder to clear honestly. It is chosen
because it is the option whose claims can actually be checked here.

## D. Observation engine

| # | Requirement | Implementation | Test | Status | Limitation |
|---|---|---|---|---|---|
| D1 | §12 observation boundary | Only: ball present, person present, ball trajectory, relative location, discrete touch, juggle event, activity duration, protocol compliance | m22E2E contract block | planned | — |
| D2 | §18 structured narrow contract | `{sessionId, providerId, providerVersion, modelVersion, observedAt, capabilities, observations, integrity, confidence}` | m22E2E shape assertions | planned | — |
| D3 | §19 confidence is model certainty, never football quality | Internal only; never rendered as a player figure | m22E2E negative 65 | planned | — |
| D4 | §20 refusal states | `accepted / insufficient_confidence / insufficient_visibility / ball_not_detected / person_not_detected / protocol_violation / liveness_failed / provider_unavailable / unsupported_protocol` | m22E2E refusal block | planned | — |
| D5 | §21/§22 touch rule | Documented touch definition with refractory interval, duplicate suppression, ambiguity and edge-of-frame behaviour; derived server-side | m22CvEval T1; negatives 41, 42, 43 | planned | — |
| D6 | §23 juggle rule | Contact→flight→contact sequence, not peak counting | m22CvEval T2; negative 44 | planned | — |
| D7 | §24 person + ball presence required | Both must be established or the attempt is refused | m22E2E negatives 21, 22, 28 | planned | — |
| D8 | §30/§31/§32 dropped frames, low light, occlusion | Explicit refusal states; never extrapolation | m22E2E negatives 25, 26, 27, 35; m22CvEval | planned | — |
| D9 | §33/§34 multiple people / multiple balls | Reject; never identity assignment or ball attribution | m22E2E negatives 23, 24, 83 | planned | — |
| D10 | §56 scale | Touch and juggle counting must avoid spatial-scale dependency; no real-world distance is estimated from camera geometry | m22E2E scale-independence check | planned | — |

## E. Integrity, timing, transport

| # | Requirement | Implementation | Test | Status | Limitation |
|---|---|---|---|---|---|
| E1 | §25 liveness reused, not replaced | Existing M16 nonce + challenge; strengthened only where measured to be insufficient | m22E2E negatives 13, 14, 79 | planned | No biometrics are added. |
| E2 | §26 replay | Detect what liveness and temporal integrity can detect | m22E2E negative 30 | planned | **Full replay prevention is not achievable in a browser in v1**; residual risk is documented in the threat model rather than denied. |
| E3 | §27 no pre-recorded upload path | Production observation exists only inside a live session | m22E2E negative 30 | planned | — |
| E4 | §28/§29 server timing authoritative | Server clock owns duration, as it already does for non-simulated providers | m22E2E negatives 32, 33, 34 | planned | — |
| E5 | §85–§89 transport security | Authenticated session, nonce-bound, foreign session rejected, replayed nonce rejected, duplicates not double-counted, out-of-order bounded and documented | m22E2E negatives 11, 12, 13, 14, 15, 16 | planned | — |
| E6 | §82/§83 body limits and formats | Explicit frame size limit with a typed 413; only documented encodings decoded | m22E2E negatives 17, 18, 19, 89 | planned | — |
| E7 | §80/§81 rate limiting and abuse | New named policies in `m181/rateLimit.mjs`, separate from ordinary reads | m22E2E negative 20 | planned | — |
| E8 | §90 client disconnect | Attempt becomes incomplete unless the protocol validly ended | m22E2E negative 31 | planned | — |

## F. Resources

| # | Requirement | Implementation | Test | Status | Limitation |
|---|---|---|---|---|---|
| F1 | §73 inference must not block the event loop | Worker/process boundary if measurement shows blocking | m22Perf event-loop test; negative 85 | planned | — |
| F2 | §74/§75 session isolation | Tracker state keyed by session id, never by player | m22E2E negatives 39, 90 | planned | — |
| F3 | §76/§77 bounded queues and backpressure | Fixed-size frame queue with a documented drop/refuse policy | m22E2E negative 84 | planned | — |
| F4 | §78/§79 timeout and crash recovery | Session timeout; provider crash fails the observation, not the server | m22E2E negatives 37, 38, 86 | planned | — |
| F5 | §153 cleanup | Buffers released; repeated sessions do not grow memory linearly | m22Perf | planned | — |

## G. Product integration (no semantic change anywhere)

| # | Requirement | Implementation | Test | Status | Limitation |
|---|---|---|---|---|---|
| G1 | §47/§48 Combine integration with no bypass | M16.1's existing `measurementSupported()` path recognises a production provider automatically | m22E2E T4; m161E2E green | planned | — |
| G2 | §50/§51/§170 Trust | Unchanged policy; equal contribution regardless of measured value | m22E2E T4; testTrust + m162E2E green | planned | — |
| G3 | §52/§171 M21 targets | A production-valid result can satisfy a target; goal status stays manual | m22E2E T5; m21E2E green | planned | — |
| G4 | §53/§172 M19 criteria | Explicit Combine criteria read current production-valid results | m22E2E T6; m19E2E green | planned | — |
| G5 | §54/§173 Second Look | Flows through existing canonical Combine events; no new M22 path | m22E2E; m18E2E green | planned | — |
| G6 | §44/§45/§46 T&S | Invalidate / restore unchanged; no substitute number; reprocessing only where non-raw derived data suffices | m22E2E negative 59, T7, T8 | planned | Reprocessing without original video is impossible for most changes and will say so rather than pretend. |
| G7 | §121/§122 invalidation propagates and restoration recovers | Existing live-state computation | m22E2E T7, T8; negatives 56, 57, 58 | planned | — |

## H. Surfaces

| # | Requirement | Implementation | Test | Status | Limitation |
|---|---|---|---|---|---|
| H1 | §36/§91 Ready Check reports specific states | Camera, lighting, player area, ball detectable, frame rate, provider ready, protocol supported | m22Live C1, C2 | planned | Only what can honestly be tested is tested. |
| H2 | §93 live count decision | To be decided and documented, not defaulted | CV doc | planned | — |
| H3 | §94/§95 result copy refuses, never blames | "Could not verify this attempt" + reason | m22E2E copy scan; m22Live | planned | — |
| H4 | §98/§99 accessibility and 390px | Labels not colour alone; mobile web tested | m22Live C11, C12 | planned | — |
| H5 | §100/§101 permission and secure context | Denied / unavailable / in-use / insecure context each have copy and recovery | m22Live; negatives 51, 52 | planned | — |
| H6 | §102 EN + FR | All ready/failure/result states translated | m22E2E i18n cross-check | planned | — |
| H7 | §145/§146 demo honesty | Demo stays synthetic and says so | m22DemoSpotcheck | planned | — |

## I. Evidence that the engine works

| # | Requirement | Implementation | Test | Status | Limitation |
|---|---|---|---|---|---|
| I1 | §57/§58 golden fixtures | 12+ fixture classes, synthetic and consent-safe | m22CvEval | planned | Synthetic. See C6. |
| I2 | §59 ground truth recorded before tuning | Each fixture declares its expected outcome | m22CvEval | planned | — |
| I3 | §60 metrics beyond average accuracy | Count error, accept/reject correctness, false positives, **false verifications**, refusal rate | `M22_CV_EVALUATION.md` | planned | — |
| I4 | §61/§62 false verification is P0 | Conservative thresholds; refusal preferred | m22CvEval gate | planned | — |
| I5 | §63/§129/§130 measured enablement gate | `protocolProductionEnabled()` depends on configuration, capabilities, **measured** evaluation output, policy version and environment | m22E2E negative 7; gate block | planned | The gate reads measured data; it is never hard-coded true. |
| I6 | §113 ≥60% negative/security/integrity | `m22E2E` enforces the floor on itself and fails below it | m22E2E self-report | planned | — |
| I7 | §114 all 90 enumerated negatives | Each numbered case present | m22E2E self-report | planned | — |

## J. Delivery

| # | Requirement | Implementation | Test | Status | Limitation |
|---|---|---|---|---|---|
| J1 | §155 migration from 2100 | New schema version; clean DB, upgrade, restart idempotency | m22E2E migration block | planned | — |
| J2 | §156 clean boot without a model | Server boots with `production_cv:not_configured` unless explicitly required | m22E2E negative 72 | planned | — |
| J3 | §162/§164/§165/§166 docs | `M22_REAL_BOX_CAM_CV.md` (32 sections), `M22_CAPABILITIES.md`, `M22_CV_EVALUATION.md`, `M22_CV_THREAT_MODEL.md` | doc↔code cross-checks | planned | — |
| J4 | §169 full regression, nothing weakened | Every prior suite plus the four new ones | full battery | planned | — |
| J5 | §175/§176 artifacts and launcher tour | Republish the six existing URLs; tour tells the truth about what is enabled | manual + spotcheck | planned | — |
| J6 | §177 restoration bundle | Secret scan, model-file policy check, verify, fresh clone, `m22E2E` + `m22CvEval` from the clone | bundle report | planned | The bundle dies with the container; the standing "do not push" makes that an accepted, restated risk. |

---

## Defects found during M22

Recorded as they are found, in the M20/M21 style. Empty until the first.

| # | Defect | Where | Fix | Proven by |
|---|---|---|---|---|
| F1 | **Name-collision near-miss during the §14 licence check.** The npm package `ultralytics` reports `Apache-2.0` and is an unrelated self-hosted web-analytics library, not YOLO. Trusting the name would have put a confidently false licence statement into a compliance document, and installing it would have been a supply-chain confusion hazard. | licence audit, not product code | Licences are verified from the *actual* distribution (PyPI for YOLO: AGPL-3.0) and each is recorded with how it was checked. No third-party model is integrated. | §C7 table; matrix row C2 |
