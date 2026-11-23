# Architecture

How the CV app and the ScoutBox API divide the work. This started as a survey written on 16 Nov 2026 alongside the
Gleam port. The transport question it left open is now decided: **direct upload**.

## The split

- **The ScoutBox API** owns everything that is data:
  - sessions, nonces (hashed) and liveness challenges
  - drills, assignments and challenges
  - Combine protocols and attempts, and disputes
  - the stored CV results and the Passport and Trust projections
  - the Combine eligibility gate and its validation records, which are release configuration

  It decides what a result **means**.
- **The CV app** owns pixels only. Frames go in; an observation result or a typed refusal comes out. It stores
  nothing durable, knows no players, and makes no Passport or Combine decisions. It reports the engine, policy and
  freeze versions behind each result, so the API can check them against the validation record.

## Job flow

1. The player creates a Box Session in the API, as now, and passes liveness.
2. `cv/begin` on the API creates a **CV job** with:
   - a job id
   - the session id
   - the protocol's `id@version`
   - the expected engine, policy and freeze versions
   - an expiry and a frame and byte budget

   The API answers with a short-lived **job token**, signed by the API, and the CV app's address.
3. The phone sends frames **directly to the CV app** with that token. The rules for the token:
   - It locates one job and authorises nothing else.
   - It expires.
   - It carries the budget, so the CV app can enforce it without calling the API.
4. Finalize goes through the API. The API asks the CV app to close the job, which is single-shot and idempotent
   per job id. The API receives the result (counts, refusal reason, quality, versions) and records it in one unit
   of work together with the session's verification state.

   Alternatively, the CV app posts the signed result back to the API. Either way, a retry keyed by job id returns
   the same result and never mints a second one.
5. The CV app drops all job state on finalize, cancel or expiry.

## What moves from the API to the CV app

With frames off the API, the API's standing gates no longer protect frame ingest. These are auth, rate limits,
origin checks and the 20 transport-security checks in [`contract.md`](contract.md). The CV app must provide
them:

- **Token:** check the signature and expiry, bind the token to one job, and refuse once the job is finalized or
  cancelled.
- **Ordering:** sequence numbers are strictly increasing, and duplicate frames are refused.
- **Payload:** size, dimensions and encoding are checked before anything interprets the bytes. A measurement-shaped
  field is refused by name.
- **Budget:** a bounded queue, a batch cap and a per-job rate limit.
- **Timing:** server-side timestamps, or client time checked against arrival (see
  [`lessons.md`](lessons.md)).
- **Retention:** no frame is ever written to disk or logs.

The API's `begin` still enforces session ownership, the nonce, liveness and protocol support before it issues a
token. The Gleam server's stub (`cv_stub.gleam`) already runs those checks before answering 503, so `begin` is
where the token gets issued.

## Contract to pin first

- **The frame envelope:** format, size limits, sequence numbers, timing. Fix the `atMs` mismatch here, once, and
  share one definition between the Player app and the CV app.
- **The job token:** its claims, signing key ownership, rotation, and its lifetime relative to the 60 s protocol
  window.
- **The result shape and the refusal enumeration**, from [`contract.md`](contract.md).
- **The version triple** (engine, policy, freeze) on every result.
- **The conformance suite:** the synthetic fixtures, families, stress suite and holdout (see
  [`../fixtures/`](../fixtures/)). The new engine must reproduce their verdicts, byte-for-byte or within declared
  tolerances.

## The engine: OpenCV and robustness

- **Use OpenCV** (Apache 2.0) for pre-processing and tracking. It offers background subtraction (MOG2/KNN),
  contour and Hough circle checks, optical flow, Kalman filtering and adaptive thresholding or equalisation. All
  are a clear step up from blob thresholds.
- **OpenCV alone won't make counting robust.** Telling a touch from a near miss, or a ball from a white trainer,
  in cluttered homes almost certainly needs a learned detector: ball, person, and likely foot or pose keypoints.
  OpenCV's DNN module can host a self-trained ONNX model.
- **A decision to raise with the Founder.** `docs/decisions.md` says "no third-party model".
  - Does that mean no third-party **weights** (an in-house model on a permissively licensed architecture is
    fine), or no learned models at all?
  - Real YOLO is AGPL and stays excluded. Even OpenCV's HOG people detector ships pretrained weights.
- **Determinism:** pin the build, run single-threaded and disable IPP/OpenCL in the measuring path, or move to
  tolerances and say so in the policy version.
- **Input size:** 320×240 grey leaves the ball a few pixels wide at 2.5–3 m. Direct upload makes more resolution
  affordable for the API, but not free for the phone's bandwidth or for privacy.

## Next steps, in order

1. Raise the self-attested `box_cam_observed` problem with the Founder (see [`lessons.md`](lessons.md)). It
   decides how non-CV sessions are labelled.
2. Pin the job, token and frame contract above, and fix the `atMs` envelope bug in the contract, not in both
   apps.
3. Build the CV app:
   - OpenCV pre-processing
   - the three-layer split: detect, then track in ball diameters relative to the player, then the protocol
     state machine
   - the refusal-first quality gate

   It must pass the synthetic conformance suite.
4. Replace the Gleam server's `cv_stub` with job creation and token issue at `begin`, and recording of the result
   at finalize.
5. Start the real-world data work now, per [`validation.md`](validation.md):
   - a consent process, adult-only capture and annotation
   - at least 200 valid attempts, 0 false verifications, at least 95% within tolerance and at most 20% refusals

   It is the long pole, and it doubles as training data if a learned detector is approved.
6. Only after a passing validation record: Trust & Safety review, a named decision, a migration lifting the
   `combine_verified = 0` constraint, and a separate config change enabling that protocol.
7. Later:
   - native capture, which mitigates virtual-camera replay
   - a Box Marker
   - timing and spatial detectors for the athletic protocols
