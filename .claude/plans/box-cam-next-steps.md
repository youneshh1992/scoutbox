# Box Cam: state of play and next steps

Survey of `scoutbox-server/domains/development/boxcam/` (about 11k lines with `repositories/boxCam.mjs`), written
16 Nov 2026 alongside the Gleam port.

## What it is

Players prop a phone up, train a supported drill, and ScoutBox records what it observed (active minutes, reps) as
evidence on the Passport. Hard rules (`docs/product/passport-development.md`): observation, never evaluation; no
faces, identity, audio or stored video; a refused measurement is acceptable, a falsely verified one is not.

## Feature inventory

| Area | Files | State |
| --- | --- | --- |
| Box Sessions: 8 versioned drills, server-minted session + nonce + liveness challenge, sequenced observation batches, server-derived result (`verified` / `partially_verified` / `unable_to_verify` / `completed_unverified`), dashboard, streaks, notes, clip tagging, T&S invalidate/restore | `sessions.mjs`, `drills.mjs`, `shared.mjs` | Built, tested |
| Coaching and community: club drill assignments (results, never footage), guardian acceptance, time-boxed challenges (Passport-visible to recruiters), development plan view, prefs (guardian controls minor clip retention), disputes into a T&S queue | `training.mjs` | Built, tested |
| At-Home Combine: versioned protocols (Box Touch 60, Box Juggle, Box Control 60, Box Footwork, Box Strength 60), attempts bound to a Box Session, 12-state lifecycle, calibration, 3 verified/24h, Combine Card, club requests, compare up to 30 | `combine.mjs`, `combineShared.mjs` | Bookkeeping built; nothing can actually reach Combine Verified (only the test-only provider can) |
| Future athletic protocols: 5-10-5, 10 m accel, broad jump, passing target | `combineShared.mjs` | Defined, blocked: need `spatial_scale` / `timing_gate` / `target_zone`, which no provider has |
| Server-side CV: gray8 frames (≤320×240, ~12 fps) over HTTP batches, analysed and dropped; detect → track → protocol state machine; quality gate with typed refusal reasons | `cv/` (~4.5k lines) | Prototype. Only ever run on synthetic scenes |
| CV evaluation apparatus: versioned policy constants, source/constant freeze hashes, holdout sets, real-world validation records gating Combine eligibility per protocol | `cv/policy.mjs`, `freeze.mjs`, `holdout.mjs`, `validation.mjs`, `eligibility.mjs`, `gate.mjs` | Built and well designed; every protocol's validation is `not_completed` |

### The CV engine today

- Detection (`cv/detect.mjs`) is a bright-blob threshold for the ball and a dark-rectangle search for the person.
- Tracking (`cv/track.mjs`) works in ball diameters, so it is scale- and frame-rate-free.
- Counting (`cv/protocol.mjs`) is a contact state machine that emits one event per touch.
- Deterministic and dependency-free: identical frames give byte-identical output.
- Evaluated only on generated geometry (a disc and a rectangle on noise): 0 false verifications, 57% refusal rate.
  `cv/evaluation.json` itself says this does not evidence real-world counting.

## Problems to know about

1. **"Box Cam observed" is effectively self-attested.** The Player app uses the `web_client` provider. It echoes the
   server's liveness challenge back without the player doing anything (`sessions.mjs` only string-compares it) and
   posts "presence good / active good" intervals from a 3-second timer (`scoutbox-player/src/components/CombineSection.tsx`,
   `M16Sections.tsx`). That is enough for `verified`. The Passport (`domains/passport/shared.mjs`) and Trust read the
   session state, and completed challenges reach recruiters labelled `box_cam_observed`. The CV result is stored
   separately and only the trial panel reads it (`domains/recruitment/lifecycle/trialRoutes.mjs`). This contradicts
   the documented rule that client data can never produce `box_cam_observed`. **Product decision for the Founder:**
   should non-CV sessions be labelled self-reported? Under the freeze it goes to known-issues until decided.
2. **CV frames from the real app are always refused**: the app's envelope lacks `atMs` (known-issues). The CV path
   has only ever run from test batteries.
3. **The freeze hash misses code lines** that start with `*` (known-issues).
4. Web only, Chromium only, no native capture; virtual-camera replay is undetectable in the browser.
5. Legal consent for observing minors at trials is open (`docs/decisions.md`).

## Target architecture

- **Gleam API (ported with the rest of the routes and repositories)** owns everything that is data: sessions,
  nonces (hashed), liveness challenges, assignments, challenges, Combine protocols and attempts, disputes, CV result
  rows, Passport/Trust projections, and the eligibility gate (validation records are release configuration and stay
  on this side). It decides what a result *means*.
- **Native CV service** owns pixels only: frames in, an observation result or a typed refusal out. It stores nothing
  durable, knows no players and makes no Passport or Combine decisions. It reports the engine, policy and freeze
  versions that produced each result, so the API can check them against the validation record.

### Job flow

1. Player creates a session in the API, as now.
2. `cv/begin` on the API creates a **CV job**: job id, session id, protocol id@version, expected engine/policy/freeze
   versions, expiry. The API registers the job with the CV service (or the service learns it from a signed token,
   below).
3. Frames go to the CV service under that job id. Two options:
   - **Proxied through the API** (today's design). One auth surface and all the standing gates (auth, moderation,
     rate limits, origin) still apply, but the API carries the frame bandwidth.
   - **Direct to the CV service** with a short-lived job token the API signs (job id, session id, expiry, frame and
     byte budget). Keeps frame traffic off the API. The token must locate a job and never authorise anything else.
     Recommended once frame rates or resolution go up; start proxied if that is simpler.
4. Finalize: the API asks the service to close the job (single-shot, idempotent per job id), receives the result
   (counts, refusal reason, quality, versions), and records it in one unit of work with the session's
   verification state.
5. The service drops all job state on finalize, cancel or expiry. Retries are keyed by job id, so a retry returns
   the same result and never mints a second one.

### Contract to pin before porting

- The frame envelope (`cv/policy.mjs`, `cv/frames.mjs`): format, size limits, sequence numbers, server-side timing.
  Fix the `atMs` mismatch here, once.
- The result shape and the refusal-reason enumeration (`cv/quality.mjs`).
- The version triple (engine, policy, freeze) carried on every result.
- The synthetic fixtures, families, stress suite and holdout (`cv/fixtures.mjs`, `scenes.mjs`, `families.mjs`,
  `holdout.mjs`) become the native service's conformance suite: the port must reproduce `evaluation.json` exactly.

## Native engine: OpenCV and robustness

- **Use OpenCV** (Apache 2.0) for pre-processing and tracking: background subtraction (MOG2/KNN), contour and Hough
  circle checks, optical flow, Kalman filtering, adaptive thresholding/equalisation. A clear step up from blob
  thresholds, with good native bindings (C++ or `opencv-rust`).
- **It will not by itself make counting robust.** Telling a touch from a near-miss, or a ball from a white trainer,
  in cluttered homes almost certainly needs a learned detector (ball, person, likely foot or pose keypoints).
  OpenCV's DNN module can host a self-trained ONNX model later.
- **Decision to raise with the Founder:** `decisions.md` says "no third-party model". Clarify whether that means no
  third-party *weights* (a model trained in-house on a permissively licensed architecture is fine) or no learned
  models at all. Real YOLO is AGPL and stays excluded; even OpenCV's HOG people detector ships pretrained weights.
- **Determinism:** OpenCV results can vary across CPUs, SIMD paths, IPP and thread counts. Pin the build, run
  single-threaded and disable IPP/OpenCL in the measuring path, or move the conformance suite to tolerances and say
  so in the policy version.
- **Input size:** 320×240 gray8 leaves the ball only a few pixels wide at 2.5–3 m, and drops colour. A dedicated
  service could take more; that is a bandwidth and privacy decision as well as a technical one.

## Next steps, in order

1. Raise item 1 of "Problems" (self-attested `box_cam_observed`) with the Founder via known-issues; it decides how
   non-CV sessions are labelled after the port.
2. Port the data layer to Gleam as-is, including the `cv/begin|frames|finalize|cancel` routes, behind an interface
   that can point at either the in-process JS engine or the native service.
3. Freeze the CV job contract above and fix the `atMs` envelope bug in the contract rather than in both apps.
4. Build the native service with OpenCV pre-processing, the existing three-layer split and the refusal-first quality
   gate; pass the synthetic conformance suite byte-for-byte (or within declared tolerances).
5. Start the real-world data work now: consent process, adult-only capture, annotation, per
   `docs/reference/combine-real-world-validation-plan.md` (≥200 valid attempts, 0 false verifications, ≥95% within
   tolerance, ≤20% refusals). It is the long pole and doubles as training data if a learned detector is approved.
6. Only after a passing validation record: T&S review, a named decision, and a separate config change to enable
   Combine Verified for that protocol.
7. Later: native capture (mitigates virtual-camera replay), a Box Marker and timing/spatial detectors for the
   athletic protocols.
