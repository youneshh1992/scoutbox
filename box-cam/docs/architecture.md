# Architecture

How the CV app and the ScoutBox API divide the work. This started as a survey written on 16 Nov 2026 alongside the
Gleam port. The transport question it left open is now decided: **the phone uploads to object storage**, and
recordings never pass through the API.

## The split

- **The ScoutBox API** owns everything that is data:
  - sessions, nonces (hashed) and liveness challenges
  - drills, assignments and challenges
  - Combine protocols and attempts, and disputes
  - the stored CV results and the Passport and Trust projections
  - the Combine eligibility gate and its validation records, which are release configuration

  It decides what a result **means**.
- **The CV app** owns pixels only. A recording goes in; an observation result or a typed refusal comes out. It stores
  nothing durable, knows no players, and makes no Passport or Combine decisions. It reports the engine, policy and
  freeze versions behind each result, so the API can check them against the validation record.

## Job flow

1. The player creates a Box Session in the API, as now, and passes liveness.
2. `cv/begin` on the API creates a **CV job** with:
   - a job id
   - the session id
   - the protocol's `id@version`
   - the expected engine, policy and freeze versions
   - an expiry, and a byte and duration budget
   - the recording formats the protocol accepts (see [Recording formats](#recording-formats))

   The API answers with a short-lived **signed upload URL** for one object key that names the job. The URL is
   bound to the declared size, type and SHA-256. This is the same upload flow as every other file the API takes.
3. The phone records the attempt and uploads it **straight to object storage** with that URL. The recording never
   passes through the API. The URL locates one object and authorises nothing else, and it expires.
4. Finalize goes through the API. The API checks the object (size, type, checksum) and hands the job to the CV
   app with a short-lived signed read URL and the job's parameters. The CV app returns the result (counts,
   refusal reason, quality, versions), either in its answer or by posting a signed result back to the API. The API
   records it in one unit of work together with the session's verification state.

   Finalize is single-shot and idempotent per job id: a retry returns the same result and never mints a second
   one.
5. The recording is deleted when the job is finalized, cancelled or expires. The API deletes the object after it
   records the result, through the same deletion queue as other media, which retries on failure. A lifecycle rule
   on the Box Cam prefix deletes anything left behind within 24 hours. The CV app drops all job state at the same
   points.

### Recording formats

The contract pins each format the CV app accepts, and a protocol names the ones it allows. A format might be
minimised frames, like the old grey 320×240, or a video rendered on the device by object tracking. Such a video
can carry more resolution while showing only silhouettes of the player and the ball. Each format is a privacy
decision as well as a technical one (see [`privacy.md`](privacy.md)): it shows no more of the player or their home
than counting needs.

## What moves from the API to the CV app

The API's standing gates (auth, rate limits, origin checks) still guard `begin`, the upload URL and finalize. They
no longer see the bytes. The CV app is the first thing to interpret a recording, so it must provide the checks on
the payload. [`contract.md`](contract.md) maps the 20 transport-security checks to each side.

- **Job:** accept work only from the API, one job per job id, and refuse a job id that has been finalized or
  cancelled.
- **Payload:** check the format, size, dimensions, duration and encoding before anything interprets the bytes, and
  refuse a format the contract doesn't pin. A measurement-shaped field in the recording's metadata is refused by
  name.
- **Ordering:** frame timestamps inside the recording are strictly increasing, and duplicate frames are refused.
- **Budget:** byte, duration and frame caps, and a bounded job queue.
- **Timing:** the recording's timeline is produced on the phone. The CV app declares how it checks it (see
  [`lessons.md`](lessons.md)).
- **Retention:** read the recording only through its signed URL, and never write it, or a frame of it, to disk or
  logs.

The API's `begin` still enforces session ownership, the nonce, liveness and protocol support before it issues the
upload URL. The Gleam server's stub (`cv_stub.gleam`) already runs those checks before answering 503, so `begin`
is where the URL gets issued.

## Contract to pin first

- **The recording formats:** each format's encoding, size and duration limits, frame timing and metadata. Fix the
  `atMs` mismatch here, once, and share one definition between the Player app and the CV app.
- **The job hand-over:** how the API authenticates to the CV app, the job's parameters, the lifetime of the upload
  and read URLs relative to the 60 s protocol window, and whether the result comes back in the answer or as a
  signed callback.
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
- **Input size:** 320×240 grey leaves the ball a few pixels wide at 2.5–3 m. Uploading to object storage makes
  more resolution affordable for the API, but not free for the phone's bandwidth or for privacy. A silhouette video
  rendered on the device (see [Recording formats](#recording-formats)) is one way to gain resolution without
  showing more of the player.

## Next steps, in order

1. Raise the self-attested `box_cam_observed` problem with the Founder (see [`lessons.md`](lessons.md)). It
   decides how non-CV sessions are labelled.
2. Pin the job, upload and recording-format contract above, and fix the `atMs` envelope bug in the contract, not
   in both apps.
3. Build the CV app:
   - OpenCV pre-processing
   - the three-layer split: detect, then track in ball diameters relative to the player, then the protocol
     state machine
   - the refusal-first quality gate

   It must pass the synthetic conformance suite.
4. Replace the Gleam server's `cv_stub` with job creation and the upload URL at `begin`, and the hand-over to the
   CV app and recording of the result at finalize.
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
